-- GPRIC release 3: money fixes (0015). A direct expense on GPRIC General is checked for overspend at review like any
-- ledger entry (Treasurer override, logged); closing a refunded request no longer returns the refund a second time.
-- Paste into the Supabase SQL editor and run once. All or nothing: any error and nothing changes.
do $g$ begin if exists (select 1 from supabase_migrations.schema_migrations where name = '0015_money_fixes' or version = '20261111170000') then raise exception 'Release 3 (0015_money_fixes) is already applied'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where name = '0012_cpa') then raise exception 'Release 2 (0012_cpa) must be live first'; end if; end $g$;
begin;

-- ================================================================ 0015_money_fixes

-- GPRIC Portal 0015: two money fixes (P40). Applies after 0012.
--   1. A direct expense charged to GPRIC General posted at review with no spending check at all, so an overspend took
--      the fund below zero with no override. direct_expense_review (0006) ran spend_check only for team funds. Now
--      every direct expense passes spend_check at review: a team fund as before (the team, category Robotics Teams),
--      any other fund with exactly the checks a ledger entry out gets in ledger_add (overspend, and restricted money).
--      A broken rule blocks the bookkeeper; the Treasurer reviews it only to override, with a reason that is logged in
--      money_overrides. A Treasurer review that overrides nothing is still refused.
--   2. Closing a refunded request credited the refund a second time. request_refund (0006) books the refund as a
--      ledger 'in' row but leaves team_requests.returned alone, and complete_request_receipts (0004) worked out the
--      unspent money as amount - receipts - returned, so the refunded money was returned again as Unspent Returned.
--      Close now also takes off the request's refund rows still standing in the ledger (not reversed). The refund row
--      stays the record of its money: request_refund, team_requests.returned and the roll back rules are unchanged.

-- ---------------------------------------------------------------- 1. direct expense review: spending rules on every fund

-- The bookkeeper's review: posts the direct expense to its fund's ledger as already paid (one row for the whole
-- request, dated the day it was paid). Returns the ledger id.
-- Every direct expense passes the spending rules here (spend_check). Charged to a team fund, the same rules as paying
-- a team request (that team, category 'Robotics Teams'); charged to GPRIC General, the rules every ledger entry out
-- gets in ledger_add (the team only when booked as Robotics Teams). A broken rule blocks it unless the Treasurer
-- reviews it with an override reason, which is logged.
create or replace function public.direct_expense_review(p_request_id text, p_override text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_date date;
  v_cat text;
  v_led text;
  v_files int;
  v_team text;
  v_teamfund boolean;
  v_ovr bigint := 0;
begin
  if nullif(trim(coalesce(p_override, '')), '') is null then
    perform public.require_role(array['bookkeeper'], 'Reviewing a direct expense');
  else
    perform public.require_role(array['bookkeeper','treasurer'], 'Reviewing a direct expense');
  end if;
  perform public.via('review');
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.type <> 'Direct Expense' then raise exception 'Only a direct expense is reviewed'; end if;
  if r.status <> 'Submitted' then raise exception 'This direct expense is not waiting for review'; end if;
  v_date := coalesce(r.purchase_date, r.submitted, current_date);
  select coalesce(f.team_id, (select t.id from public.teams t where t.fund_id = f.id order by t.id limit 1)) into v_team
    from public.funds f where f.id = r.charge_fund_id;
  v_teamfund := v_team is not null
                and r.charge_fund_id is distinct from (select s.general_fund_id from public.settings s where s.id = 1);
  v_cat := coalesce(r.category, case when v_teamfund then 'Robotics Teams' else 'Administration' end);
  select count(*) into v_ovr from public.money_overrides o where o.record_id = r.id and o.action = 'review';
  if v_teamfund then
    perform public.spend_check(r.charge_fund_id, r.amount, v_team, 'Robotics Teams', p_override, 'review', r.id);
  else
    perform public.spend_check(r.charge_fund_id, r.amount,
      case when v_cat = 'Robotics Teams' then (select f.team_id from public.funds f where f.id = r.charge_fund_id) end,
      v_cat, p_override, 'review', r.id);
  end if;
  -- The Treasurer reviews only to override a spending rule that actually broke (and was just recorded).
  if public.my_role() <> 'bookkeeper'
     and (select count(*) from public.money_overrides o where o.record_id = r.id and o.action = 'review') <= v_ovr then
    raise exception 'The bookkeeper reviews direct expenses; the Treasurer reviews one only to override a spending rule it breaks'
      using errcode = '42501';
  end if;
  select count(*) into v_files from public.receipts c where c.request_id = r.id and c.archived_at is null and c.file_path is not null;
  insert into public.ledger (date, dir, amount, fund_id, category, party, memo, request_id, receipt, receipt_path, receipt_name,
                             pay_method, pay_ref, sample)
  select v_date, 'out', r.amount, r.charge_fund_id, v_cat, r.vendor, r.id || ' · ' || r.purpose, r.id, v_files > 0,
         c.file_path, c.file_name, r.pay_method, r.pay_ref, r.sample
    from (select 1) one
    left join lateral (select x.file_path, x.file_name from public.receipts x
                        where x.request_id = r.id and x.archived_at is null and x.file_path is not null
                        order by x.created_at, x.id limit 1) c on true
  returning id into v_led;
  update public.team_requests
     set status = 'Reviewed', paid_date = v_date, reviewed_at = now(), reviewed_by = public.my_name()
   where id = r.id;
  return v_led;
end;
$$;

-- ---------------------------------------------------------------- 2. close: refunds already returned count

-- Receipts are all in: unspent money goes back into the fund it came from and the request closes.
-- Unspent = amount - receipts - money already returned: unspent returned at an earlier close (returned) and refunds
-- still standing in the ledger (Refund rows not reversed). A refund's money went back to the fund when it was recorded,
-- so it is never returned a second time here.
create or replace function public.complete_request_receipts(p_request_id text, p_date date default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  t public.teams%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_left numeric;
  v_refunded numeric;
  v_fund text;
begin
  perform public.require_role(array['treasurer','bookkeeper'], 'Closing a request');
  perform public.via('close');
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status not in ('Paid','Receipts Due') then raise exception 'Only a paid request can be closed'; end if;
  select * into t from public.teams where id = r.team_id;
  v_fund := coalesce((select l.fund_id from public.ledger l where l.request_id = r.id and l.dir = 'out' and l.reverses_id is null order by l.created_at limit 1),
                     public.request_fund(r.id));
  select coalesce(sum(l.amount), 0) into v_refunded
    from public.ledger l
   where l.request_id = r.id and l.dir = 'in' and l.source = 'Refund' and l.reverses_id is null and l.reversed_by_id is null;
  v_left := round(r.amount - coalesce((select sum(amount) from public.receipts where request_id = r.id and archived_at is null), 0)
                  - coalesce(r.returned, 0) - v_refunded, 2);
  if v_left > 0 then
    if v_fund is null then raise exception 'This team has no fund; set one on the team first'; end if;
    insert into public.ledger (date, dir, amount, fund_id, source, category, party, memo, request_id, receipt, sample)
    values (v_date, 'in', v_left, v_fund, 'Unspent Returned', 'Robotics Teams', t.short, r.id || ' · unspent returned', r.id, true, r.sample);
  end if;
  update public.team_requests
     set status = 'Closed', receipts_done = v_date, returned = round(coalesce(returned, 0) + greatest(0, v_left), 2)
   where id = r.id;
  return v_left;
end;
$$;

-- ---------------------------------------------------------------- grants (as before)

do $$
declare f text;
begin
  foreach f in array array['public.direct_expense_review(text, text)', 'public.complete_request_receipts(text,date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


insert into supabase_migrations.schema_migrations (version, name) values ('20261111170000', '0015_money_fixes');
commit;

select (select string_agg(name, ', ' order by version) from supabase_migrations.schema_migrations) migrations,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'complete_request_receipts' and p.prosrc like '%v_refunded%') close_fixed,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'direct_expense_review' and p.prosrc like '%breaks''%') review_fixed;
