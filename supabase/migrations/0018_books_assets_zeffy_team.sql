-- 0018, P23 real books: equipment marked as assets, and a standing team for a donor's monthly Zeffy gifts.
--
-- 1. ledger.asset: an equipment purchase the books keep as an asset (listed on the Assets sheet of the Quarterly and Year
--    exports). Set or cleared only through ledger_set_asset (Treasurer, board, bookkeeper); money is unchanged, so a
--    reconciled month does not refuse it. Every change is in History through the ledger's log_change trigger.
-- 2. donors.zeffy_fund_id: the team fund a donor's monthly Zeffy gifts go to when Zeffy's Fund field is blank. Kept until
--    someone changes it (Josh 2026-11-19, decision 9671). Set through donor_zeffy_fund, which also moves that donor's
--    monthly gifts still waiting in Unassigned Gifts. zeffy_upsert_core uses it for new monthly gifts with a blank Fund.
-- Nothing here redefines a function 0017 (team transfers) changed.

-- ---------------------------------------------------------------- 1. assets

alter table public.ledger add column if not exists asset boolean not null default false;

create or replace function public.ledger_set_asset(p_id text, p_asset boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare l public.ledger%rowtype;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Marking an asset');
  select * into l from public.ledger where id = p_id;
  if not found or l.archived_at is not null then raise exception 'Entry not found'; end if;
  if coalesce(p_asset, false) and (l.dir <> 'out' or l.reverses_id is not null or l.reversed_by_id is not null) then
    raise exception 'Only a purchase that has not been reversed can be an asset';
  end if;
  perform public.via('asset');
  update public.ledger set asset = coalesce(p_asset, false) where id = p_id and asset is distinct from coalesce(p_asset, false);
end;
$$;
revoke all on function public.ledger_set_asset(text, boolean) from public, anon;
grant execute on function public.ledger_set_asset(text, boolean) to authenticated;

-- The live month lock with one more pass-through: inside ledger_set_asset, a change to nothing but the asset flag.
create or replace function public.ledger_month_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare m date;
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('gpric.via', true), '') in ('ledger','rollback')
     and (to_jsonb(new) - array['reversed_by_id','reason']) = (to_jsonb(old) - array['reversed_by_id','reason']) then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(current_setting('gpric.via', true), '') = 'asset'
     and (to_jsonb(new) - 'asset') = (to_jsonb(old) - 'asset') then
    return new;
  end if;
  if coalesce(current_setting('gpric.via', true), '') = 'clear_sample' and tg_op = 'DELETE' and old.sample then return old; end if;
  foreach m in array array[
    case when tg_op <> 'INSERT' then date_trunc('month', old.date)::date end,
    case when tg_op <> 'DELETE' then date_trunc('month', new.date)::date end] loop
    if m is not null and exists (select 1 from public.bank_statements s where s.month = m and s.locked_at is not null) then
      raise exception '% is reconciled and locked. Record a correction dated in an open month instead.',
        trim(to_char(m, 'FMMonth YYYY')) using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------- 2. a standing team for monthly Zeffy gifts

alter table public.donors add column if not exists zeffy_fund_id text references public.funds (id) on delete restrict;

-- p_fund_id null clears it. Returns how many waiting monthly gifts were moved to the fund.
create or replace function public.donor_zeffy_fund(p_donor_id text, p_fund_id text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare g record; n int := 0;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Setting a donor''s team for monthly gifts');
  if not exists (select 1 from public.donors where id = p_donor_id and archived_at is null) then raise exception 'Donor not found'; end if;
  if p_fund_id is not null and not exists (select 1 from public.funds where id = p_fund_id and archived_at is null) then
    raise exception 'Pick a fund';
  end if;
  update public.donors set zeffy_fund_id = p_fund_id where id = p_donor_id and zeffy_fund_id is distinct from p_fund_id;
  if p_fund_id is not null then
    for g in select id from public.donations
              where donor_id = p_donor_id and channel = 'Zeffy' and recurring and coalesce(unassigned, false)
                and fund_raw is null and archived_at is null loop
      perform public.gift_assign_fund(g.id, p_fund_id);
      n := n + 1;
    end loop;
  end if;
  return n;
end;
$$;
revoke all on function public.donor_zeffy_fund(text, text) from public, anon;
grant execute on function public.donor_zeffy_fund(text, text) to authenticated;

-- The live body (zeffy_upsert_core, as of 2026-11-23) with one change: the donor is found before the fund, and a new
-- monthly gift whose Fund is blank goes to the donor's standing team fund (zeffy_fund_id) instead of Unassigned Gifts.
create or replace function public.zeffy_upsert_core(p_rows jsonb, p_source text default 'file')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_key text; v_amount numeric; v_date date; v_fund text; v_unassigned boolean; v_name text;
  v_donor text; v_don text; v_status text; v_payout date; v_refund numeric; v_raw text; v_zid text;
  v_recurring boolean; v_standing text;
  n_ins int := 0; n_upd int := 0; n_skip int := 0;
  s public.settings%rowtype;
begin
  if not (public.is_board() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Board sign-in with two-step is required' using errcode = '42501';
  end if;
  select * into s from public.settings where id = 1;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_key := nullif(trim(r ->> 'key'), '');
    v_amount := round(nullif(r ->> 'amount', '')::numeric, 2);
    v_date := nullif(r ->> 'date', '')::date;
    v_status := nullif(trim(r ->> 'status'), '');
    v_payout := nullif(r ->> 'payout_date', '')::date;
    v_refund := round(coalesce(nullif(r ->> 'refund', '')::numeric, 0), 2);
    if v_key is null or v_amount is null or v_amount <= 0 or v_date is null
       or exists (select 1 from public.zeffy_skip k where k.zeffy_key = v_key)
       or coalesce(v_status, '') in ('Failed', 'Canceled', 'Cancelled') then
      n_skip := n_skip + 1; continue;
    end if;
    v_zid := nullif(trim(r ->> 'id'), '');
    v_don := null;
    if v_zid is not null then select id into v_don from public.donations where zeffy_id = v_zid; end if;
    if v_don is null then select id into v_don from public.donations where zeffy_key = v_key; end if;
    if v_don is not null then
      update public.donations set payout_date = v_payout, zeffy_status = v_status, refunded = v_refund,
                                  zeffy_id = coalesce(zeffy_id, v_zid)
       where id = v_don and (payout_date is distinct from v_payout or zeffy_status is distinct from v_status
                             or refunded is distinct from v_refund or (zeffy_id is null and v_zid is not null));
      if found then n_upd := n_upd + 1; end if;
      continue;
    end if;
    v_recurring := coalesce(r ->> 'recurring', '') <> '';
    -- the donor first, so a monthly donor's standing team is known before the fund is picked
    v_name := coalesce(nullif(trim(concat_ws(' ', r ->> 'first', r ->> 'last')), ''), nullif(trim(r ->> 'company'), ''), 'Zeffy Donor');
    v_donor := null;
    if nullif(trim(r ->> 'email'), '') is not null then
      select id into v_donor from public.donors where lower(email) = lower(trim(r ->> 'email')) order by created_at limit 1;
    end if;
    if v_donor is null then
      select id into v_donor from public.donors where lower(name) = lower(v_name) and email is null order by created_at limit 1;
    end if;
    if v_donor is null then
      insert into public.donors (name, type, giving, channel, since, email, notes)
      values (v_name, 'Individual', case when v_recurring then 'Monthly' else 'One-Time' end,
              'Zeffy', v_date, nullif(trim(r ->> 'email'), ''), nullif(trim(r ->> 'company'), ''))
      returning id into v_donor;
    end if;
    v_raw := nullif(trim(r ->> 'fund'), '');
    v_fund := null;
    if v_raw is not null and lower(v_raw) not in ('general fund', 'general', 'gpric general') then
      select t.fund_id into v_fund from public.teams t
       where t.fund_id is not null and (lower(t.name) = lower(v_raw) or lower(t.zeffy_name) = lower(v_raw) or lower(t.short) = lower(v_raw))
       order by t.sample, t.created_at limit 1;
      if v_fund is null then
        select f.id into v_fund from public.funds f where lower(f.name) = lower(v_raw) order by f.sample, f.created_at limit 1;
      end if;
    end if;
    v_unassigned := v_fund is null and v_raw is null;
    if v_unassigned and v_recurring then
      select d.zeffy_fund_id into v_standing from public.donors d join public.funds f on f.id = d.zeffy_fund_id
       where d.id = v_donor and f.archived_at is null;
      if v_standing is not null then v_fund := v_standing; v_unassigned := false; end if;
    end if;
    if v_fund is null then
      v_fund := s.general_fund_id;
      if v_raw is not null and lower(v_raw) not in ('general fund', 'general', 'gpric general') then v_unassigned := true; end if;
    end if;
    if v_fund is null then raise exception 'Set the general fund in settings before importing Zeffy gifts'; end if;
    insert into public.donations (donor_id, date, amount, fund_id, channel, recurring, thanked,
                                  zeffy_id, zeffy_key, payout_date, zeffy_status, zeffy_method, fund_raw, unassigned, refunded)
    values (v_donor, v_date, v_amount, v_fund, 'Zeffy', v_recurring, false,
            v_zid, v_key, v_payout, v_status, nullif(trim(r ->> 'method'), ''), v_raw, v_unassigned, v_refund)
    returning id into v_don;
    insert into public.ledger (date, dir, amount, fund_id, source, donor_id, memo, donation_id, receipt)
    values (v_date, 'in', v_amount, v_fund, 'Individual Donors', v_donor,
            case when v_recurring then 'Zeffy monthly gift' else 'Zeffy gift' end, v_don, true);
    n_ins := n_ins + 1;
  end loop;
  insert into public.zeffy_sync_log (source, inserted, updated, skipped)
  values (coalesce(p_source, 'file'), n_ins, n_upd, n_skip);
  return jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'skipped', n_skip);
end;
$$;
