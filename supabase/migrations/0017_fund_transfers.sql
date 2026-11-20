-- GPRIC Portal 0017: moving money from one team to another (P23 workshop, Josh 2026-11-20: "Can we create the ability
-- to transfer things from one team to another? It's definitely going to need to be logged and tracked.")
-- Applies after 0016.
--   * Money only, between any two funds (a team's fund, or GPRIC General). Nothing moves at the bank: it is a move inside
--     the books, so bank matching and the month-end figures leave transfer rows out.
--   * The Treasurer or the bookkeeper makes one, always with a reason ("treasurer and bookkeeper").
--   * One transfer is one fund_transfers row and two ledger rows that point at it: money out of the giving fund
--     (category Transfer) and money in to the receiving fund (source Transfer). Both carry the other side's name and the
--     reason, are logged in History as Transferred, and each team sees its side, with the reason, on its own page.
--   * The money rules apply to the giving fund as to any money out: a transfer that would take it below zero, or move
--     restricted money, is blocked unless the Treasurer overrides with a reason (logged in money_overrides).
--   * A transfer is never undone, changed, reversed or rolled back. Josh: "I think transfers would need to be
--     retransferred the opposite direction to be undone. It's easier to track." Its ledger rows refuse every change.
--   * Reconciled (locked) months refuse a transfer dated in them, as they refuse any new entry.
--   * Team Balances shows a Transfers column; transfers are not money raised or spent, so they stay out of Money In,
--     Money Out, Deposits and Direct Expenses everywhere.

-- ---------------------------------------------------------------- the record

create sequence public.transfer_id_seq;

create table public.fund_transfers (
  id text primary key default public.pad_id('TR-', nextval('public.transfer_id_seq'), 4),
  created_at timestamptz not null default now(),
  date date not null,
  amount numeric(12,2) not null check (amount > 0),
  from_fund_id text not null references public.funds (id) on delete restrict,
  to_fund_id text not null references public.funds (id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0),
  user_id uuid,
  by_name text,
  check (from_fund_id <> to_fund_id)
);

alter table public.fund_transfers enable row level security;
revoke all on public.fund_transfers from public, anon, authenticated;
grant select on public.fund_transfers to authenticated;
create policy board_read on public.fund_transfers for select to authenticated
  using ((select public.is_board()) or (select coalesce(public.my_role() = 'cpa', false)));

-- Never changed or removed.
create or replace function public.fund_transfer_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'A transfer is never changed. To undo it, transfer the money back the other way.' using errcode = '42501';
end;
$$;
create trigger fund_transfers_guard before update or delete on public.fund_transfers
  for each row execute function public.fund_transfer_guard();
create trigger fund_transfers_no_truncate before truncate on public.fund_transfers
  for each statement execute function public.fund_transfer_guard();
create trigger fund_transfers_cpa_read_only before insert or update or delete on public.fund_transfers
  for each statement execute function public.cpa_read_only();

alter table public.ledger add column transfer_id text references public.fund_transfers (id) on delete restrict;
create index ledger_transfer_idx on public.ledger (transfer_id) where transfer_id is not null;

-- The books' signed view gains transfer_id (added at the end so the view keeps its other columns in place).
create or replace view public.ledger_signed
with (security_invoker = true)
as
select l.id, l.date, l.dir, l.amount, l.fund_id, l.source, l.category, l.party, l.donor_id, l.memo, l.donation_id,
       l.request_id, l.grant_id, l.receipt, l.receipt_path, l.receipt_name, l.sample, l.created_at, l.pay_method, l.pay_ref,
       l.archived_at, l.archived_by, l.archive_reason, l.reverses_id, l.reversed_by_id, l.reason,
       case when l.reverses_id is null then l.dir else (case l.dir when 'in' then 'out' else 'in' end) end as kind_dir,
       case when l.reverses_id is null then 1 else -1 end as sign,
       case when l.dir = 'in' then l.amount else -l.amount end as net,
       l.transfer_id
  from public.ledger l;

-- Transfer rows are written only by fund_transfer and never change; nothing else may use the Transfer source or category.
create or replace function public.ledger_transfer_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_on boolean := coalesce(current_setting('gpric.transfer', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.reverses_id is not null and exists (select 1 from public.ledger o where o.id = new.reverses_id and o.transfer_id is not null) then
      raise exception 'A transfer is never undone or reversed. Transfer the money back the other way instead.' using errcode = '42501';
    end if;
    if new.transfer_id is not null and not v_on then
      raise exception 'Transfers are made only with Transfer Money on Team Balances' using errcode = '42501';
    end if;
  else
    if old.transfer_id is not null and to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'A transfer is never changed. To undo it, transfer the money back the other way.' using errcode = '42501';
    end if;
    if new.transfer_id is distinct from old.transfer_id then
      raise exception 'A ledger entry cannot be made into a transfer' using errcode = '42501';
    end if;
  end if;
  if new.transfer_id is null and (coalesce(new.source, '') = 'Transfer' or coalesce(new.category, '') = 'Transfer') then
    raise exception 'Transfer is kept for money moved between teams. Use Transfer Money on Team Balances.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger ledger_transfer_guard before insert or update on public.ledger
  for each row execute function public.ledger_transfer_guard();

-- ---------------------------------------------------------------- making one

-- What a fund is called on Team Balances: its team's name, or the fund's own.
create or replace function public.fund_label(p_fund_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select t.name from public.teams t where t.fund_id = f.id order by t.id limit 1),
                  (select t.name from public.teams t where t.id = f.team_id), f.name)
    from public.funds f where f.id = p_fund_id;
$$;
revoke all on function public.fund_label(text) from public, anon;

-- Moves p_amount from one fund to another, dated p_date (today by default). Returns the transfer's id.
create or replace function public.fund_transfer(p_from text, p_to text, p_amount numeric, p_reason text,
                                                p_date date default null, p_override text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount numeric := round(p_amount, 2);
  v_date date := coalesce(p_date, current_date);
  v_reason text := trim(coalesce(p_reason, ''));
  f_from public.funds%rowtype;
  f_to public.funds%rowtype;
  v_from_name text;
  v_to_name text;
  v_to_team text;
  v_id text;
begin
  perform public.require_role(array['treasurer','bookkeeper'], 'Transferring money between teams');
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if v_reason = '' then raise exception 'Give a reason for the transfer'; end if;
  select * into f_from from public.funds where id = p_from;
  select * into f_to from public.funds where id = p_to;
  if f_from.id is null then raise exception 'Pick the team the money comes from'; end if;
  if f_to.id is null then raise exception 'Pick the team the money goes to'; end if;
  if f_from.id = f_to.id then raise exception 'Pick two different teams'; end if;
  if f_to.archived_at is not null then raise exception '% is archived; money cannot go into it', f_to.name; end if;
  if public.month_locked(v_date) then
    raise exception '% is reconciled and locked. Date the transfer in an open month.', trim(to_char(v_date, 'FMMonth YYYY'));
  end if;
  v_from_name := public.fund_label(f_from.id);
  v_to_name := public.fund_label(f_to.id);
  v_to_team := coalesce((select t.id from public.teams t where t.fund_id = f_to.id order by t.id limit 1), f_to.team_id);
  v_id := public.pad_id('TR-', nextval('public.transfer_id_seq'), 4);
  -- the giving fund follows the money rules for money out (overspend, restricted money); the Treasurer may override
  perform public.spend_check(f_from.id, v_amount, v_to_team, 'Transfer', p_override, 'fund_transfer', v_id);

  insert into public.fund_transfers (id, date, amount, from_fund_id, to_fund_id, reason, user_id, by_name)
  values (v_id, v_date, v_amount, f_from.id, f_to.id, v_reason, auth.uid(), public.my_name());

  perform public.via('transfer');
  perform set_config('gpric.transfer', 'on', true);
  perform set_config('gpric.reason', v_reason, true);
  insert into public.ledger (date, dir, amount, fund_id, category, party, memo, receipt, transfer_id)
  values (v_date, 'out', v_amount, f_from.id, 'Transfer', v_to_name, 'Transfer to ' || v_to_name || ': ' || v_reason, true, v_id);
  insert into public.ledger (date, dir, amount, fund_id, source, party, memo, receipt, transfer_id)
  values (v_date, 'in', v_amount, f_to.id, 'Transfer', v_from_name, 'Transfer from ' || v_from_name || ': ' || v_reason, false, v_id);
  perform set_config('gpric.reason', '', true);
  perform set_config('gpric.transfer', '', true);
  perform public.via('');
  return v_id;
end;
$$;
revoke all on function public.fund_transfer(text, text, numeric, text, date, text) from public, anon;
grant execute on function public.fund_transfer(text, text, numeric, text, date, text) to authenticated;

-- History shows each side as Transferred.
create or replace function public.log_action(p_op text, p_tbl text, o jsonb, n jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_op = 'DELETE' then 'Deleted'
    when p_tbl in ('portal_access','people_invites') and p_op = 'UPDATE'
         and coalesce(current_setting('gpric.via', true), '') in ('people_off','people_on','people_role','people_direct','people_sent','people_send_failed') then
      case current_setting('gpric.via', true)
        when 'people_off' then case when p_tbl = 'people_invites' then 'Invite Cancelled' else 'Turned Off' end
        when 'people_on' then case when p_tbl = 'people_invites' then 'Invite Reopened' else 'Turned On' end
        when 'people_role' then 'Role Changed'
        when 'people_direct' then 'Direct Expenses Changed'
        when 'people_sent' then 'Invite Sent'
        else 'Invite Failed' end
    when p_tbl = 'people_invites' and p_op = 'INSERT' then 'Invited'
    when p_tbl = 'team_invites' and p_op = 'INSERT' then 'Invited'
    when p_tbl = 'receipt_reminders' and p_op = 'INSERT' then 'Reminded'
    when p_tbl = 'zeffy_sync_log' then 'Synced'
    when p_tbl = 'money_overrides' then 'Overrode'
    when p_tbl = 'ledger' and p_op = 'INSERT' and n ->> 'reverses_id' is not null then 'Reversed'
    when p_tbl = 'ledger' and p_op = 'INSERT' and n ->> 'transfer_id' is not null then 'Transferred'
    when p_tbl = 'donations' and p_op = 'INSERT' and n ->> 'zeffy_key' is not null then 'Imported'
    when p_op = 'UPDATE' and o ->> 'archived_at' is null and n ->> 'archived_at' is not null then 'Archived'
    when p_op = 'UPDATE' and o ->> 'archived_at' is not null and n ->> 'archived_at' is null then 'Restored'
    else case coalesce(current_setting('gpric.via', true), '')
      when 'approve' then 'Approved' when 'vote' then 'Voted' when 'decline' then 'Declined' when 'pay' then 'Paid'
      when 'close' then 'Closed' when 'cancel' then 'Cancelled' when 'refund' then 'Refunded' when 'review' then 'Reviewed'
      when 'lock' then 'Locked' when 'unlock' then 'Unlocked' when 'clear_sample' then 'Cleared Sample'
      when 'rollback' then 'Rolled Back'
      else case p_op when 'INSERT' then 'Added' else 'Changed' end end
  end;
$$;

-- ---------------------------------------------------------------- the figures leave transfers out of raised and spent

-- The month-end figures: a transfer never reaches the bank, so it is never money out waiting to clear.
create or replace function public.bank_month_figures(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_book numeric; v_out numeric; v_transit numeric;
begin
  if not (public.is_board() or coalesce(public.my_role() = 'cpa', false)) then
    raise exception 'Board sign-in with two-step is required' using errcode = '42501';
  end if;
  select coalesce(sum(case when l.dir = 'in' then l.amount else -l.amount end), 0) into v_book from public.ledger l where l.date <= v_end;
  -- money out not yet through the bank; an entry reversed by month end never reached the bank, so it and its reversal are left out
  select coalesce(sum(l.amount), 0) into v_out from public.ledger l
   where l.date <= v_end and l.dir = 'out' and coalesce(l.source, '') <> 'Opening Balance' and l.reverses_id is null
     and l.transfer_id is null
     and not exists (select 1 from public.ledger z where z.id = l.reversed_by_id and z.date <= v_end)
     and not exists (select 1 from public.bank_lines b where b.matched_ledger_id = l.id and b.archived_at is null)
     and not exists (select 1 from public.donations d join public.bank_lines b on b.matched_payout_date = d.payout_date and b.archived_at is null
                      where d.id = l.donation_id);
  select coalesce(sum(d.amount), 0) into v_transit from public.donations d
   where d.channel = 'Zeffy' and d.date <= v_end and (d.payout_date is null or d.payout_date > v_end) and d.archived_at is null;
  return jsonb_build_object('book', round(v_book, 2), 'outstanding', round(v_out, 2), 'transit', round(v_transit, 2),
                            'expected', round(v_book + v_out - v_transit, 2));
end;
$$;

-- A team's money by kind (the team portal): transfers are their own line, never deposits or direct expenses.
create or replace function public.team_money(p_team_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select fund_id from public.teams where id = p_team_id),
  l as (
    select l.kind_dir, l.sign * l.amount amount, l.net, l.source, l.request_id, d.channel,
           coalesce(rq.type = 'Direct Expense', false) direct_req, l.transfer_id is not null xfer
      from public.ledger_signed l join t on l.fund_id = t.fund_id
      left join public.donations d on d.id = l.donation_id
      left join public.team_requests rq on rq.id = l.request_id
  )
  select jsonb_build_object(
    'carry',   coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Opening Balance'), 0),
    'zeffy',   coalesce(sum(amount) filter (where kind_dir = 'in' and coalesce(source, '') not in ('Opening Balance', 'Refund') and channel = 'Zeffy'), 0),
    'deposits',coalesce(sum(amount) filter (where kind_dir = 'in' and not xfer and coalesce(source, '') not in ('Opening Balance', 'Refund') and channel is distinct from 'Zeffy'), 0),
    'reimbursements', coalesce(sum(amount) filter (where kind_dir = 'out' and request_id is not null and not direct_req), 0)
                    - coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Refund' and request_id is not null and not direct_req), 0),
    'direct',  coalesce(sum(amount) filter (where kind_dir = 'out' and not xfer and (request_id is null or direct_req)), 0)
             - coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Refund' and (request_id is null or direct_req)), 0),
    'transfers', coalesce(sum(net) filter (where xfer), 0),
    'balance', coalesce(sum(net), 0))
  from l;
$$;

-- The board's figures: each fund gains a Transfers figure (net in less out); Deposits, Direct Expenses, Money Raised and
-- Money Spent leave transfers out. A fund's Money In and Money Out still include them, so its row adds up to its balance.
create or replace function public.portal_totals()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.settings%rowtype;
  v_funds jsonb; v_in jsonb; v_out jsonb;
begin
  if not (public.is_board() or coalesce(public.my_role() = 'cpa', false)) then
    raise exception 'Board sign-in with two-step is required' using errcode = '42501';
  end if;
  select * into s from public.settings where id = 1;
  select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) into v_funds from (
    select jsonb_build_object(
      'id', f.id, 'name', f.name, 'restricted', f.restricted, 'team_id', coalesce(f.team_id, (select t.id from public.teams t where t.fund_id = f.id limit 1)),
      'opening', round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Opening Balance'), 0), 2),
      'inn',     round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and coalesce(l.source, '') not in ('Opening Balance', 'Refund')), 0), 2),
      'out',     round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out'), 0)
                     - coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Refund'), 0), 2),
      'carry',   round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Opening Balance'), 0), 2),
      'zeffy',   round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and coalesce(l.source, '') not in ('Opening Balance', 'Refund') and d.channel = 'Zeffy'), 0), 2),
      'deposits',round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.transfer_id is null and coalesce(l.source, '') not in ('Opening Balance', 'Refund') and d.channel is distinct from 'Zeffy'), 0), 2),
      'reimbursements', round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out' and l.request_id is not null and rq.type is distinct from 'Direct Expense'), 0)
                            - coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Refund' and l.request_id is not null and rq.type is distinct from 'Direct Expense'), 0), 2),
      'direct',  round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out' and l.transfer_id is null and (l.request_id is null or rq.type = 'Direct Expense')), 0)
                     - coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Refund' and (l.request_id is null or rq.type = 'Direct Expense')), 0), 2),
      'transfers', round(coalesce(sum(l.net) filter (where l.transfer_id is not null), 0), 2),
      'balance', round(coalesce(sum(l.net), 0), 2),
      'committed', public.fund_committed(f.id),
      'available', round(coalesce(sum(l.net), 0) - public.fund_committed(f.id), 2)) x
      from public.funds f
      left join public.ledger_signed l on l.fund_id = f.id
      left join public.donations d on d.id = l.donation_id
      left join public.team_requests rq on rq.id = l.request_id
     where f.archived_at is null or exists (select 1 from public.ledger z where z.fund_id = f.id)
     group by f.id) q;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_in from (
    select coalesce(l.source, 'Other') k, round(sum(l.sign * l.amount), 2) v from public.ledger_signed l
     where l.date >= s.fy_start and l.kind_dir = 'in' and l.transfer_id is null
       and coalesce(l.source, '') not in ('Opening Balance', 'Unspent Returned', 'Refund')
     group by 1 having round(sum(l.sign * l.amount), 2) <> 0) q;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out from (
    select k, round(sum(v), 2) v from (
      select coalesce(l.category, 'Other') k, l.sign * l.amount v from public.ledger_signed l
       where l.date >= s.fy_start and l.kind_dir = 'out' and l.transfer_id is null
      union all
      -- returned team money and refunds net against the category they were spent from
      select coalesce(l.category, 'Robotics Teams') k, -(l.sign * l.amount) v from public.ledger_signed l
       where l.date >= s.fy_start and l.kind_dir = 'in' and l.source in ('Unspent Returned', 'Refund')) z
     group by k having round(sum(v), 2) <> 0) q;
  return jsonb_build_object(
    'funds', v_funds,
    'cash', jsonb_build_object(
      'total', round(coalesce((select sum((x ->> 'balance')::numeric) from jsonb_array_elements(v_funds) x), 0), 2),
      'restricted', round(coalesce((select sum((x ->> 'balance')::numeric) from jsonb_array_elements(v_funds) x where (x ->> 'restricted')::boolean), 0), 2),
      'unrestricted', round(coalesce((select sum((x ->> 'balance')::numeric) from jsonb_array_elements(v_funds) x where not (x ->> 'restricted')::boolean), 0), 2)),
    'in_by_source', v_in,
    'out_by_category', v_out,
    'raised', round(coalesce((select sum(value::numeric) from jsonb_each_text(v_in)), 0), 2),
    'spent', round(coalesce((select sum(value::numeric) from jsonb_each_text(v_out)), 0), 2));
end;
$$;

-- The team portal gains its transfers, each with the other team's name and the reason (no board names).
create or replace function public.team_portal()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team text := public.my_team();
  t public.teams%rowtype;
  s public.settings%rowtype;
  u public.team_users%rowtype;
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  select * into t from public.teams where id = v_team;
  select * into s from public.settings where id = 1;
  select * into u from public.team_users where user_id = auth.uid();
  return jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'name', t.name, 'short', t.short, 'program', t.program, 'pay_mode', t.pay_mode, 'school', t.school),
    'me', jsonb_build_object('name', u.name, 'email', u.email, 'role', u.role, 'zelle_contact', u.zelle_contact),
    'rules', jsonb_build_object('receipt_days', s.receipt_days, 'threshold', s.approval_threshold,
                                'under', s.approvals_under, 'over', s.approvals_over),
    'money', public.team_money(v_team),
    'overdue', public.team_overdue(v_team),
    'season_start', s.fy_start,
    'raised', coalesce((select sum(d.amount) from public.donations d where d.fund_id = t.fund_id and d.date >= s.fy_start), 0),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'type', r.type, 'purpose', r.purpose, 'category', r.category, 'amount', r.amount, 'vendor', r.vendor,
        'pay_to', r.pay_to, 'needed_by', r.needed_by, 'purchase_date', r.purchase_date, 'submitted', r.submitted,
        'status', r.status, 'paid_date', r.paid_date, 'pay_method', r.pay_method, 'decline_reason', r.decline_reason,
        'requestor_name', r.requestor_name, 'receipt_name', r.receipt_name,
        'approvals', (select count(*) from public.request_approvals a where a.request_id = r.id),
        'needed', public.approvals_needed(r.amount),
        'receipts', (select count(*) from public.receipts c where c.request_id = r.id and c.archived_at is null),
        'receipts_total', (select coalesce(sum(c.amount), 0) from public.receipts c where c.request_id = r.id and c.archived_at is null)
      ) || public.team_request_extra(r.id) order by coalesce(r.submitted, r.created_at::date) desc, r.id desc)
      from public.team_requests r where r.team_id = v_team and r.status <> 'Draft' and r.archived_at is null), '[]'::jsonb),
    -- Purchases the board paid directly from this team's own fund (their invoices are the team's receipts too).
    'direct', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'type', r.type, 'purpose', r.purpose, 'category', r.category, 'amount', r.amount, 'vendor', r.vendor,
        'submitted', r.submitted, 'status', r.status, 'paid_date', coalesce(r.paid_date, r.purchase_date), 'pay_method', r.pay_method,
        'requestor_name', r.requestor_name
      ) || public.team_request_extra(r.id) order by r.submitted desc, r.id desc)
      from public.team_requests r
      where t.fund_id is not null and r.type = 'Direct Expense' and r.charge_fund_id = t.fund_id
        and r.status in ('Submitted','Reviewed') and r.archived_at is null), '[]'::jsonb),
    'gifts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'date', d.date, 'amount', d.amount,
        'donor', case when o.anonymous then 'Anonymous' else o.name end,
        'in_transit', d.channel = 'Zeffy' and (d.payout_date is null or d.payout_date > current_date)
      ) order by d.date desc, d.id desc)
      from public.donations d join public.donors o on o.id = d.donor_id
      where d.fund_id = t.fund_id and t.fund_id is not null), '[]'::jsonb),
    -- Money moved between this team and another: 'in' came to the team, 'out' went from it.
    'transfers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'date', x.date, 'amount', x.amount,
        'dir', case when x.to_fund_id = t.fund_id then 'in' else 'out' end,
        'team', public.fund_label(case when x.to_fund_id = t.fund_id then x.from_fund_id else x.to_fund_id end),
        'reason', x.reason
      ) order by x.date desc, x.id desc)
      from public.fund_transfers x
      where t.fund_id is not null and t.fund_id in (x.from_fund_id, x.to_fund_id)), '[]'::jsonb));
end;
$$;
