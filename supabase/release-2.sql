-- GPRIC release 2: Requests v2 and Direct Expenses (0006), Calendar (0008), Problem Reports (0009), History names (0010), Receipts (0011), CPA read-only login (0012).
-- Paste into the Supabase SQL editor and run once. All or nothing: any error and nothing changes.
do $g$ begin if exists (select 1 from supabase_migrations.schema_migrations where name in ('0006_requests_v2', '0008_calendar', '0009_problem_reports', '0010_history_areas', '0011_receipts', '0012_cpa')) then raise exception 'Release 2 is already applied'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where name = '0005_action_log') then raise exception '0005 must be live first'; end if; end $g$;
begin;

-- ================================================================ 0006_requests_v2

-- GPRIC Portal P30 and P31, requests v2.
--   Direct expenses (P30): a second request type beside Reimbursement, for money the board already spent (debit card
--          or check). Charge To is GPRIC General or a team fund. Filed by the Treasurer, the bookkeeper, or a board
--          member the Treasurer marks (portal_access.files_direct). The bookkeeper's Mark Reviewed posts it to that
--          fund's ledger as already paid: no approval or reimbursement step.
--   Many invoices per request: a direct expense holds any number of invoices (receipts rows); its total is their sum.
--   One payment per request: a request has at most one open payment row in the ledger, whatever its invoices.
--   Cancel (P31): before payment, with a reason; nothing posts to the ledger. Optionally reorder as a new request,
--          linked both ways (replaces_id / replaced_by_id).
--   Refund (P31): after payment, amount, date and reason; the money goes back into the fund that paid it as a ledger
--          'in' row with source 'Refund', linked to the request. One refund per request.

-- ---------------------------------------------------------------- columns

alter table public.team_requests alter column team_id drop not null;

alter table public.team_requests drop constraint if exists team_requests_type_check;
alter table public.team_requests add constraint team_requests_type_check
  check (type in ('Pre-Approval','Reimbursement','Direct Expense'));

alter table public.team_requests drop constraint if exists team_requests_status_check;
alter table public.team_requests add constraint team_requests_status_check
  check (status in ('Draft','Submitted','Board Vote','Approved','Declined','Paid','Receipts Due','Closed','Reviewed','Cancelled'));

alter table public.team_requests
  add column charge_fund_id text references public.funds (id) on delete restrict,
  add column reviewed_at timestamptz,
  add column reviewed_by text,
  add column cancel_reason text,
  add column cancelled_at timestamptz,
  add column cancelled_by text,
  add column replaces_id text references public.team_requests (id) on delete set null,
  add column replaced_by_id text references public.team_requests (id) on delete set null;
create index requests_charge_fund_idx on public.team_requests (charge_fund_id);
create index requests_replaces_idx on public.team_requests (replaces_id);
create index requests_replaced_by_idx on public.team_requests (replaced_by_id);

-- A team request belongs to a team; a direct expense belongs to the fund it is charged to (and no team).
alter table public.team_requests add constraint team_requests_owner_check
  check (case when type = 'Direct Expense' then charge_fund_id is not null and team_id is null
              else team_id is not null and charge_fund_id is null end);

-- Who may file a direct expense besides the Treasurer and the bookkeeper (set from private/seats.sql, never here).
alter table public.portal_access add column files_direct boolean not null default false;

create or replace function public.can_file_direct()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() in ('treasurer','bookkeeper')
                  or (public.my_role() = 'board'
                      and exists (select 1 from public.portal_access a where a.user_id = auth.uid() and a.files_direct)), false);
$$;

-- ---------------------------------------------------------------- guards

-- A direct expense never goes through approval or payment, and a request never changes type to or from one.
create or replace function public.request_type_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.type = 'Direct Expense') is distinct from (old.type = 'Direct Expense') then
    raise exception 'A request cannot change to or from a direct expense' using errcode = '42501';
  end if;
  if new.type = 'Direct Expense' then
    if new.status not in ('Draft','Submitted','Reviewed','Cancelled') then
      raise exception 'A direct expense is reviewed, not approved or paid' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.amount is distinct from old.amount and coalesce(current_setting('gpric.via', true), '') <> 'admin' then
      raise exception 'A direct expense''s total is the sum of its invoices' using errcode = '42501';
    end if;
  elsif new.status = 'Reviewed' then
    raise exception 'Only a direct expense is reviewed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger team_requests_type_guard
  before insert or update on public.team_requests
  for each row execute function public.request_type_guard();

-- No approvals on a direct expense.
create or replace function public.approval_type_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.team_requests r where r.id = new.request_id and r.type = 'Direct Expense') then
    raise exception 'A direct expense is reviewed by the bookkeeper, not approved' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger request_approvals_type_guard
  before insert on public.request_approvals
  for each row execute function public.approval_type_guard();

-- A direct expense's invoices are fixed when it is filed (its total is their sum).
create or replace function public.receipt_type_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('gpric.via', true), '') not in ('request','clear_sample','admin')
     and exists (select 1 from public.team_requests r where r.id = new.request_id and r.type = 'Direct Expense') then
    raise exception 'A direct expense''s invoices are fixed when it is filed; cancel it and reorder instead' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger receipts_type_guard
  before insert or update on public.receipts
  for each row execute function public.receipt_type_guard();

-- One payment per request: at most one open 'out' row in the ledger for a request, however many invoices it holds.
-- (A trigger, not a unique index, so rows already on the live database are not re-checked.)
create or replace function public.ledger_one_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.request_id is not null and new.dir = 'out' and new.reverses_id is null
     and exists (select 1 from public.ledger l where l.request_id = new.request_id and l.dir = 'out'
                    and l.reverses_id is null and l.reversed_by_id is null and l.id <> new.id) then
    raise exception 'Request % is already paid; one payment covers the whole request', new.request_id using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger ledger_one_payment
  before insert on public.ledger
  for each row execute function public.ledger_one_payment();

-- History roll back (and any other path) cannot leave the books inconsistent:
--   a refunded request stays paid (its refund money is in the ledger against that payment);
--   a cancelled request that was reordered stays cancelled (otherwise both it and its replacement could be paid);
--   a replacement link, once made, is never removed.
-- Only an admin fix or the sample clear bypasses this.
create or replace function public.request_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('gpric.via', true), '') in ('admin','clear_sample') then return new; end if;
  if old.status in ('Paid','Receipts Due','Closed','Reviewed') and new.status not in ('Paid','Receipts Due','Closed','Reviewed')
     and exists (select 1 from public.request_refunds f where f.request_id = old.id and f.archived_at is null) then
    raise exception 'Request % has a refund recorded; a refunded request stays paid', old.id using errcode = '42501';
  end if;
  if old.status = 'Cancelled' and new.status <> 'Cancelled' and old.replaced_by_id is not null then
    raise exception 'Request % was reordered as %; it stays cancelled', old.id, old.replaced_by_id using errcode = '42501';
  end if;
  if (old.replaced_by_id is not null and new.replaced_by_id is distinct from old.replaced_by_id)
     or (old.replaces_id is not null and new.replaces_id is distinct from old.replaces_id) then
    raise exception 'A replacement link is never removed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger team_requests_link_guard
  before update on public.team_requests
  for each row execute function public.request_link_guard();

-- The payment of a refunded request is never reversed (a roll back of the payment, or a reversal by any other path).
create or replace function public.ledger_refund_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('gpric.via', true), '') not in ('admin','clear_sample')
     and old.reversed_by_id is null and new.reversed_by_id is not null
     and old.request_id is not null and old.dir = 'out' and old.reverses_id is null
     and exists (select 1 from public.request_refunds f where f.request_id = old.request_id and f.archived_at is null) then
    raise exception 'Request % has a refund recorded; a refunded request stays paid', old.request_id using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger ledger_refund_guard
  before update on public.ledger
  for each row execute function public.ledger_refund_guard();

revoke all on function public.request_link_guard() from public, anon, authenticated;
revoke all on function public.ledger_refund_guard() from public, anon, authenticated;
revoke all on function public.request_type_guard() from public, anon, authenticated;
revoke all on function public.approval_type_guard() from public, anon, authenticated;
revoke all on function public.receipt_type_guard() from public, anon, authenticated;
revoke all on function public.ledger_one_payment() from public, anon, authenticated;

-- ---------------------------------------------------------------- which fund a request is charged to

create or replace function public.request_fund(p_request_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(r.charge_fund_id, t.fund_id)
    from public.team_requests r left join public.teams t on t.id = r.team_id
   where r.id = p_request_id;
$$;

-- Money promised but not yet in the ledger: approved requests, and direct expenses filed but not yet reviewed
-- (that money is already spent).
create or replace function public.fund_committed(p_fund_id text, p_except_request text default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(r.amount), 0), 2)
    from public.team_requests r left join public.teams t on t.id = r.team_id
   where r.archived_at is null and coalesce(r.charge_fund_id, t.fund_id) = p_fund_id
     and (r.status = 'Approved' or (r.type = 'Direct Expense' and r.status = 'Submitted'))
     and r.id is distinct from p_except_request;
$$;

-- A fund a direct expense can be charged to: GPRIC General, or a team fund.
create or replace function public.direct_charge_ok(p_fund_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.funds f where f.id = p_fund_id and f.archived_at is null
                   and (f.id = (select s.general_fund_id from public.settings s where s.id = 1)
                        or f.team_id is not null
                        or exists (select 1 from public.teams t where t.fund_id = f.id)));
$$;
revoke all on function public.direct_charge_ok(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- direct expenses

-- File a direct expense. p: {purpose, charge_fund_id, pay_method ('Debit Card' or 'Check'), pay_ref (the check number),
--   paid_date, notes, category, invoices: [{vendor, amount, date, file_name, file_path}]}
-- Returns the new request id and any warnings (an overspent fund warns; the money is already spent).
create or replace function public.direct_expense_file(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fund text := nullif(p ->> 'charge_fund_id', '');
  v_method text := nullif(p ->> 'pay_method', '');
  v_ref text := nullif(trim(p ->> 'pay_ref'), '');
  v_date date := coalesce(nullif(p ->> 'paid_date', '')::date, current_date);
  v_inv jsonb := coalesce(p -> 'invoices', '[]'::jsonb);
  v_total numeric;
  v_vendors text;
  v_id text;
  v_team text;
  i jsonb;
begin
  perform public.require_role(array['treasurer','bookkeeper','board'], 'Filing a direct expense');
  if public.my_role() = 'board'
     and not exists (select 1 from public.portal_access a where a.user_id = auth.uid() and a.files_direct) then
    raise exception 'Only the Treasurer, the bookkeeper and officers the Treasurer names can file a direct expense' using errcode = '42501';
  end if;
  perform public.via('request');
  if nullif(trim(p ->> 'purpose'), '') is null then raise exception 'Say what was bought'; end if;
  if v_fund is null then raise exception 'Choose the fund to charge'; end if;
  if not public.direct_charge_ok(v_fund) then raise exception 'A direct expense is charged to GPRIC General or a team fund'; end if;
  if v_method is null or v_method not in ('Debit Card','Check') then raise exception 'Pick how it was paid: debit card or check'; end if;
  if v_method = 'Check' and v_ref is null then raise exception 'Enter the check number'; end if;
  if jsonb_typeof(v_inv) <> 'array' or jsonb_array_length(v_inv) = 0 then raise exception 'Add at least one invoice'; end if;
  for i in select value from jsonb_array_elements(v_inv) loop
    if nullif(trim(i ->> 'vendor'), '') is null or coalesce(nullif(i ->> 'amount', '')::numeric, 0) <= 0 then
      raise exception 'Each invoice needs a vendor and an amount';
    end if;
  end loop;
  select round(sum(round((value ->> 'amount')::numeric, 2)), 2),
         string_agg(distinct trim(value ->> 'vendor'), ', ')
    into v_total, v_vendors
    from jsonb_array_elements(v_inv);
  select coalesce(f.team_id, (select t.id from public.teams t where t.fund_id = f.id limit 1)) into v_team
    from public.funds f where f.id = v_fund;
  insert into public.team_requests (team_id, charge_fund_id, type, purpose, category, amount, vendor, purchase_date, notes,
                                    submitted, status, submitted_by_user, requestor_name, requestor_email, requestor_member_id,
                                    created_by, pay_method, pay_ref, certified)
  values (null, v_fund, 'Direct Expense', trim(p ->> 'purpose'), nullif(trim(p ->> 'category'), ''), v_total, v_vendors, v_date,
          nullif(trim(p ->> 'notes'), ''), current_date, 'Submitted', auth.uid(), public.my_name(), auth.jwt() ->> 'email',
          public.my_member_id(), public.my_name(), v_method, v_ref, true)
  returning id into v_id;
  insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by)
  select v_id, trim(value ->> 'vendor'), round((value ->> 'amount')::numeric, 2),
         coalesce(nullif(value ->> 'date', '')::date, v_date),
         nullif(value ->> 'file_name', ''), nullif(value ->> 'file_path', ''), public.my_name()
    from jsonb_array_elements(v_inv) with ordinality x(value, n) order by n;
  return jsonb_build_object('id', v_id, 'amount', v_total,
                            'warnings', to_jsonb(coalesce(public.spend_warnings(v_fund, v_total, v_team, 'Robotics Teams', v_id), '{}')));
end;
$$;

-- The bookkeeper's review: posts the direct expense to its fund's ledger as already paid (one row for the whole
-- request, dated the day it was paid). Returns the ledger id.
-- Charged to a team fund, it passes the same spending rules as paying a team request (spend_check, category
-- 'Robotics Teams'): a broken rule blocks it unless the Treasurer reviews it with an override reason, which is logged.
-- GPRIC General gets only the checks every ledger entry gets.
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
  if v_teamfund then
    select count(*) into v_ovr from public.money_overrides o where o.record_id = r.id and o.action = 'review';
    perform public.spend_check(r.charge_fund_id, r.amount, v_team, 'Robotics Teams', p_override, 'review', r.id);
  end if;
  -- The Treasurer reviews only to override a spending rule that actually broke on a team fund (and was just recorded).
  if public.my_role() <> 'bookkeeper'
     and (not v_teamfund
          or (select count(*) from public.money_overrides o where o.record_id = r.id and o.action = 'review') <= v_ovr) then
    raise exception 'The bookkeeper reviews direct expenses; the Treasurer reviews one only to override a spending rule it breaks on a team fund'
      using errcode = '42501';
  end if;
  v_cat := coalesce(r.category, case when v_teamfund then 'Robotics Teams' else 'Administration' end);
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

-- ---------------------------------------------------------------- cancel and replacement orders

-- Cancel before payment, with a reason. Nothing posts to the ledger. With p_replace, the request is reordered as a
-- new one (same details and invoices, ", replacement order" on its purpose, status Submitted), linked both ways.
create or replace function public.request_cancel(p_request_id text, p_reason text, p_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_new text;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Cancelling a request');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason for cancelling'; end if;
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status not in ('Draft','Submitted','Board Vote','Approved') then
    raise exception 'Only a request that is not yet paid can be cancelled; record a refund instead';
  end if;
  if exists (select 1 from public.ledger l where l.request_id = r.id and l.dir = 'out' and l.reverses_id is null and l.reversed_by_id is null) then
    raise exception 'This request has a payment in the ledger; record a refund instead';
  end if;
  if coalesce(p_replace, false) then
    if r.type = 'Direct Expense' and not public.can_file_direct() then
      raise exception 'Only the Treasurer, the bookkeeper and officers the Treasurer names can file a direct expense' using errcode = '42501';
    end if;
    perform public.via('request');
    insert into public.team_requests (team_id, charge_fund_id, type, purpose, category, amount, pay_to, needed_by, vendor, purchase_date,
                                      notes, interested_member_id, submitted, status, submitted_by_user, requestor_name, requestor_email,
                                      requestor_member_id, created_by, zelle_contact, receipt_path, receipt_name, certified,
                                      pay_method, pay_ref, replaces_id, sample)
    values (r.team_id, r.charge_fund_id, r.type, r.purpose || ', replacement order', r.category, r.amount, r.pay_to, r.needed_by, r.vendor,
            r.purchase_date, r.notes, r.interested_member_id, current_date, 'Submitted', r.submitted_by_user, r.requestor_name,
            r.requestor_email, r.requestor_member_id, public.my_name(), r.zelle_contact, r.receipt_path, r.receipt_name, r.certified,
            case when r.type = 'Direct Expense' then r.pay_method end, case when r.type = 'Direct Expense' then r.pay_ref end,
            r.id, r.sample)
    returning id into v_new;
    insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by, sample)
    select v_new, c.vendor, c.amount, c.date, c.file_name, c.file_path, c.uploaded_by, c.sample
      from public.receipts c where c.request_id = r.id and c.archived_at is null order by c.created_at, c.id;
  end if;
  perform public.via('cancel');
  update public.team_requests
     set status = 'Cancelled', cancel_reason = trim(p_reason), cancelled_at = now(), cancelled_by = public.my_name(),
         replaced_by_id = coalesce(v_new, replaced_by_id)
   where id = r.id;
  return jsonb_build_object('status', 'Cancelled', 'replacement', v_new);
end;
$$;

-- Link a cancelled request to a replacement entered separately, both ways.
create or replace function public.request_link_replacement(p_cancelled text, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.team_requests%rowtype;
  n public.team_requests%rowtype;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Linking a replacement order');
  select * into o from public.team_requests where id = p_cancelled for update;
  select * into n from public.team_requests where id = p_new for update;
  if o.id is null or n.id is null then raise exception 'Request not found'; end if;
  if o.id = n.id then raise exception 'A request cannot replace itself'; end if;
  if o.status <> 'Cancelled' then raise exception 'Only a cancelled request is replaced'; end if;
  if o.replaced_by_id is not null then raise exception 'Request % is already replaced by %', o.id, o.replaced_by_id; end if;
  if n.replaces_id is not null then raise exception 'Request % already replaces %', n.id, n.replaces_id; end if;
  if n.status = 'Cancelled' then raise exception 'The replacement is itself cancelled'; end if;
  if (o.type = 'Direct Expense') <> (n.type = 'Direct Expense') then raise exception 'A replacement is the same kind of request'; end if;
  perform public.via('cancel');
  update public.team_requests set replaced_by_id = n.id where id = o.id;
  update public.team_requests set replaces_id = o.id where id = n.id;
end;
$$;

-- ---------------------------------------------------------------- refunds

create sequence public.refund_id_seq;
create table public.request_refunds (
  id text primary key default public.pad_id('RF-', nextval('public.refund_id_seq'), 3),
  request_id text not null references public.team_requests (id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  date date not null,
  reason text not null check (reason in ('Returned','Cancelled')),
  note text,
  ledger_id text references public.ledger (id) on delete set null,
  by_name text,
  sample boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  archive_reason text
);
create index request_refunds_request_idx on public.request_refunds (request_id);
create index request_refunds_ledger_idx on public.request_refunds (ledger_id);

alter table public.request_refunds enable row level security;
revoke all on public.request_refunds from anon, authenticated;
grant select on public.request_refunds to authenticated;
create policy board_only on public.request_refunds for all to authenticated
  using ((select public.is_board())) with check ((select public.is_board()));

create trigger request_refunds_no_delete before delete on public.request_refunds
  for each row execute function public.no_delete_guard();
create trigger request_refunds_log after insert or update or delete on public.request_refunds
  for each row execute function public.log_change();

-- A refund's money is in the ledger, so the refund row itself never changes (roll back included).
create or replace function public.refund_change_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('gpric.via', true), '') not in ('refund','admin') then
    raise exception 'A refund is fixed once recorded; its money is in the ledger' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger request_refunds_change_guard before update on public.request_refunds
  for each row execute function public.refund_change_guard();
revoke all on function public.refund_change_guard() from public, anon, authenticated;

-- Record a refund on a paid request: the money goes back into the fund that paid it.
create or replace function public.request_refund(p_request_id text, p_amount numeric, p_date date, p_reason text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  l public.ledger%rowtype;
  v_amount numeric := round(p_amount, 2);
  v_date date := coalesce(p_date, current_date);
  v_max numeric;
  v_led text;
  v_id text;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Recording a refund');
  perform public.via('refund');
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status not in ('Paid','Receipts Due','Closed','Reviewed') then raise exception 'Only a paid request can be refunded'; end if;
  if p_reason is null or p_reason not in ('Returned','Cancelled') then raise exception 'Pick why: returned or cancelled'; end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if exists (select 1 from public.request_refunds f where f.request_id = r.id and f.archived_at is null) then
    raise exception 'A refund is already recorded on this request';
  end if;
  select * into l from public.ledger x
   where x.request_id = r.id and x.dir = 'out' and x.reverses_id is null and x.reversed_by_id is null
   order by x.created_at limit 1;
  if l.id is null then raise exception 'This request has no payment in the ledger to refund'; end if;
  v_max := round(l.amount - coalesce(r.returned, 0), 2);
  if v_amount > v_max then
    raise exception 'A refund cannot be more than the $% paid', to_char(v_max, 'FM999,999,990.00');
  end if;
  insert into public.ledger (date, dir, amount, fund_id, source, category, party, memo, request_id, receipt, sample)
  values (v_date, 'in', v_amount, l.fund_id, 'Refund', l.category, l.party,
          r.id || ' · refund · ' || p_reason || coalesce(' · ' || nullif(trim(p_note), ''), ''), r.id, false, r.sample)
  returning id into v_led;
  insert into public.request_refunds (request_id, amount, date, reason, note, ledger_id, by_name, sample)
  values (r.id, v_amount, v_date, p_reason, nullif(trim(p_note), ''), v_led, public.my_name(), r.sample)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- totals: direct expenses and refunds

-- portal_totals: a direct expense request counts under 'direct', not 'reimbursements'; a refund nets against the
-- money out it returns (not counted as money in).
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
      'deposits',round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and coalesce(l.source, '') not in ('Opening Balance', 'Refund') and d.channel is distinct from 'Zeffy'), 0), 2),
      'reimbursements', round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out' and l.request_id is not null and rq.type is distinct from 'Direct Expense'), 0)
                            - coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Refund' and l.request_id is not null and rq.type is distinct from 'Direct Expense'), 0), 2),
      'direct',  round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out' and (l.request_id is null or rq.type = 'Direct Expense')), 0)
                     - coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Refund' and (l.request_id is null or rq.type = 'Direct Expense')), 0), 2),
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
     where l.date >= s.fy_start and l.kind_dir = 'in' and coalesce(l.source, '') not in ('Opening Balance', 'Unspent Returned', 'Refund')
     group by 1 having round(sum(l.sign * l.amount), 2) <> 0) q;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out from (
    select k, round(sum(v), 2) v from (
      select coalesce(l.category, 'Other') k, l.sign * l.amount v from public.ledger_signed l
       where l.date >= s.fy_start and l.kind_dir = 'out'
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
           coalesce(rq.type = 'Direct Expense', false) direct_req
      from public.ledger_signed l join t on l.fund_id = t.fund_id
      left join public.donations d on d.id = l.donation_id
      left join public.team_requests rq on rq.id = l.request_id
  )
  select jsonb_build_object(
    'carry',   coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Opening Balance'), 0),
    'zeffy',   coalesce(sum(amount) filter (where kind_dir = 'in' and coalesce(source, '') not in ('Opening Balance', 'Refund') and channel = 'Zeffy'), 0),
    'deposits',coalesce(sum(amount) filter (where kind_dir = 'in' and coalesce(source, '') not in ('Opening Balance', 'Refund') and channel is distinct from 'Zeffy'), 0),
    'reimbursements', coalesce(sum(amount) filter (where kind_dir = 'out' and request_id is not null and not direct_req), 0)
                    - coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Refund' and request_id is not null and not direct_req), 0),
    'direct',  coalesce(sum(amount) filter (where kind_dir = 'out' and (request_id is null or direct_req)), 0)
             - coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Refund' and (request_id is null or direct_req)), 0),
    'balance', coalesce(sum(net), 0))
  from l;
$$;
revoke all on function public.team_money(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- action log: refunds, reviews, direct expenses

create or replace function public.log_area(p_tbl text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tbl
    when 'ledger' then 'Ledger' when 'money_overrides' then 'Ledger'
    when 'team_requests' then 'Requests' when 'receipts' then 'Requests' when 'request_approvals' then 'Requests'
    when 'request_refunds' then 'Requests'
    when 'donations' then 'Donations' when 'donors' then 'Donations' when 'zeffy_sync_log' then 'Donations' when 'zeffy_skip' then 'Donations'
    when 'grants' then 'Grants'
    when 'teams' then 'Teams' when 'funds' then 'Teams' when 'team_users' then 'Teams' when 'team_invites' then 'Teams'
    when 'bank_statements' then 'Bank' when 'bank_lines' then 'Bank'
    when 'sessions' then 'Sign-ins'
    when 'accounts' then 'Accounts' when 'documents' then 'Documents'
    when 'meetings' then 'Meetings' when 'meeting_votes' then 'Meetings'
    else 'Settings' end;
$$;

create or replace function public.log_label(p_tbl text, r jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team text := coalesce(
    (select t.short from public.teams t where t.id = coalesce(r ->> 'team_id',
       (select q.team_id from public.team_requests q where q.id = r ->> 'request_id'))),
    (select f.name from public.funds f where f.id = coalesce(r ->> 'charge_fund_id',
       (select q.charge_fund_id from public.team_requests q where q.id = r ->> 'request_id'))));
  m text := public.log_money(r);
begin
  return case p_tbl
    when 'ledger' then concat_ws(' ', 'Ledger ·', m, coalesce(r ->> 'party', r ->> 'source', r ->> 'category', r ->> 'memo'))
                       || coalesce(' · ' || (select f.name from public.funds f where f.id = r ->> 'fund_id'), '')
    when 'team_requests' then concat_ws(' ', case when r ->> 'type' = 'Direct Expense' then 'Direct expense ·' else 'Request ·' end,
                                        m, coalesce(r ->> 'vendor', r ->> 'purpose')) || coalesce(' · ' || v_team, '')
    when 'receipts' then concat_ws(' ', 'Receipt ·', m, r ->> 'vendor') || coalesce(' · ' || v_team, '')
    when 'request_refunds' then concat_ws(' ', 'Refund ·', m, 'request ' || coalesce(r ->> 'request_id', '')) || coalesce(' · ' || v_team, '')
    when 'request_approvals' then 'Approval · request ' || coalesce(r ->> 'request_id', '') || coalesce(' · ' || (r ->> 'approver_name'), '')
    when 'donations' then concat_ws(' ', 'Donation ·', m, (select d.name from public.donors d where d.id = r ->> 'donor_id'))
    when 'donors' then 'Donor · ' || coalesce(r ->> 'name', '')
    when 'grants' then concat_ws(' ', 'Grant ·', r ->> 'funder', case when r ->> 'awarded' is not null then '$' || to_char((r ->> 'awarded')::numeric, 'FM999,999,990') end)
    when 'teams' then 'Team · ' || coalesce(r ->> 'name', '')
    when 'funds' then 'Fund · ' || coalesce(r ->> 'name', '')
    when 'team_users' then 'Team login · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_team, '')
    when 'team_invites' then 'Invite · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_team, '')
    when 'bank_statements' then 'Month · ' || coalesce(trim(to_char((r ->> 'month')::date, 'FMMonth YYYY')), '')
    when 'bank_lines' then concat_ws(' ', 'Bank line ·', m, r ->> 'description')
    when 'accounts' then 'Account · ' || coalesce(r ->> 'service', '')
    when 'documents' then 'Document · ' || coalesce(r ->> 'title', '')
    when 'meetings' then 'Meeting · ' || coalesce(nullif(r ->> 'title', ''), r ->> 'date', '')
    when 'meeting_votes' then 'Vote · ' || coalesce(r ->> 'item', '')
    when 'board_members' then 'Board member · ' || coalesce(r ->> 'name', '')
    when 'portal_access' then 'Board access · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '')
    when 'settings' then 'Settings'
    when 'zeffy_sync_log' then 'Zeffy sync · ' || coalesce(r ->> 'source', '')
    when 'zeffy_skip' then 'Zeffy gift skipped · ' || coalesce(r ->> 'zeffy_key', '')
    when 'money_overrides' then 'Override · ' || coalesce(r ->> 'rule', '')
    else p_tbl end;
end;
$$;
revoke all on function public.log_label(text, jsonb) from public, anon, authenticated;

create or replace function public.log_action(p_op text, p_tbl text, o jsonb, n jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_op = 'DELETE' then 'Deleted'
    when p_tbl = 'team_invites' and p_op = 'INSERT' then 'Invited'
    when p_tbl = 'zeffy_sync_log' then 'Synced'
    when p_tbl = 'money_overrides' then 'Overrode'
    when p_tbl = 'ledger' and p_op = 'INSERT' and n ->> 'reverses_id' is not null then 'Reversed'
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

-- ---------------------------------------------------------------- clear sample data: refunds, charged funds

create or replace function public.clear_sample_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  n int;
begin
  perform public.require_role(array['treasurer'], 'Clearing sample data');
  perform public.via('clear_sample');
  update public.ledger set reverses_id = null, reversed_by_id = null where sample;
  delete from public.bank_lines where sample; get diagnostics n = row_count; v := v || jsonb_build_object('bank_lines', n);
  delete from public.bank_statements s where s.sample and not exists (select 1 from public.bank_lines x where x.statement_id = s.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('statements', n);
  delete from public.request_approvals where sample; get diagnostics n = row_count; v := v || jsonb_build_object('approvals', n);
  delete from public.team_invites where sample; get diagnostics n = row_count; v := v || jsonb_build_object('invites', n);
  delete from public.receipts where sample; get diagnostics n = row_count; v := v || jsonb_build_object('receipts', n);
  delete from public.request_refunds where sample; get diagnostics n = row_count; v := v || jsonb_build_object('refunds', n);
  delete from public.ledger where sample; get diagnostics n = row_count; v := v || jsonb_build_object('ledger', n);
  delete from public.donations where sample; get diagnostics n = row_count; v := v || jsonb_build_object('donations', n);
  delete from public.meeting_votes where sample; get diagnostics n = row_count; v := v || jsonb_build_object('votes', n);
  delete from public.team_requests r where r.sample and not exists (select 1 from public.request_approvals x where x.request_id = r.id)
    and not exists (select 1 from public.request_refunds x where x.request_id = r.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('requests', n);
  delete from public.meetings m where m.sample and not exists (select 1 from public.meeting_votes x where x.meeting_id = m.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('meetings', n);
  update public.meetings set sample = false where sample;
  delete from public.documents where sample; get diagnostics n = row_count; v := v || jsonb_build_object('documents', n);
  delete from public.accounts where sample; get diagnostics n = row_count; v := v || jsonb_build_object('accounts', n);
  delete from public.donors d where d.sample
    and not exists (select 1 from public.donations x where x.donor_id = d.id)
    and not exists (select 1 from public.ledger x where x.donor_id = d.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('donors', n);
  update public.donors set sample = false where sample;
  delete from public.grants g where g.sample
    and not exists (select 1 from public.donations x where x.grant_id = g.id)
    and not exists (select 1 from public.ledger x where x.grant_id = g.id)
    and not exists (select 1 from public.donors x where x.grant_id = g.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('grants', n);
  update public.grants set sample = false where sample;
  delete from public.board_members b where b.sample
    and not exists (select 1 from public.team_requests x where x.interested_member_id = b.id or x.requestor_member_id = b.id)
    and not exists (select 1 from public.meetings x where b.id = any(x.present))
    and not exists (select 1 from public.meeting_votes x where x.ballots ? b.id)
    and not exists (select 1 from public.request_approvals x where x.member_id = b.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('members', n);
  update public.board_members set sample = false where sample;
  delete from public.teams t where t.sample
    and not exists (select 1 from public.team_requests x where x.team_id = t.id)
    and not exists (select 1 from public.funds x where x.team_id = t.id and not x.sample)
    and not exists (select 1 from public.board_members x where x.interest_team_id = t.id)
    and not exists (select 1 from public.team_users x where x.team_id = t.id)
    and not exists (select 1 from public.team_invites x where x.team_id = t.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('teams', n);
  update public.teams set sample = false where sample;
  delete from public.funds f where f.sample
    and not exists (select 1 from public.ledger x where x.fund_id = f.id)
    and not exists (select 1 from public.donations x where x.fund_id = f.id)
    and not exists (select 1 from public.grants x where x.fund_id = f.id)
    and not exists (select 1 from public.teams x where x.fund_id = f.id)
    and not exists (select 1 from public.team_requests x where x.charge_fund_id = f.id)
    and not exists (select 1 from public.settings x where x.general_fund_id = f.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('funds', n);
  update public.funds set sample = false where sample;
  return v;
end;
$$;

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array[
    'public.can_file_direct()', 'public.direct_expense_file(jsonb)', 'public.direct_expense_review(text, text)',
    'public.request_cancel(text,text,boolean)', 'public.request_link_replacement(text,text)',
    'public.request_refund(text,numeric,date,text,text)', 'public.portal_totals()', 'public.clear_sample_data()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ================================================================ 0008_calendar

-- GPRIC Portal P36, the calendar: board meetings, community events and team schedules in one place (mockup 98).
--   Kinds: 'board' (Board Meetings, officers only), 'community' (Community Events, everyone),
--          'team' (Team Schedules: Practice, Scrimmage or Competition for one team).
--   Who sees what, enforced by row security: the board sees every event; a team login sees community events and
--          its own team's schedule only. A team login never sees a board meeting or another team's schedule.
--   Who changes what: officers (treasurer, board, bookkeeper) add and change any event; a team login adds and changes
--          only its own team's schedule. Every write goes through calendar_save and calendar_archive.
--   Weekly repeat: a new event can repeat weekly until the season ends (the end of the fiscal year it falls in,
--          unless an end date is given). Each week is its own event, linked by series_id, so one week can be moved.
--   Archive replaces delete. Every change is written to the change log.

create sequence public.calendar_event_id_seq;

create table public.calendar_events (
  id text primary key default public.pad_id('E-', nextval('public.calendar_event_id_seq'), 4),
  kind text not null check (kind in ('board','community','team')),
  team_id text references public.teams (id) on delete restrict,
  type text check (type in ('Practice','Scrimmage','Competition')),
  title text not null,
  date date not null,
  start_time time,
  end_time time,
  location text,
  notes text,
  series_id text,
  added_by text,
  added_by_user uuid,
  sample boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  archive_reason text,
  constraint calendar_events_team_kind check ((kind = 'team') = (team_id is not null and type is not null)),
  constraint calendar_events_times check (end_time is null or start_time is null or end_time > start_time)
);
create index calendar_events_date_idx on public.calendar_events (date);
create index calendar_events_team_idx on public.calendar_events (team_id, date);
create index calendar_events_series_idx on public.calendar_events (series_id);

-- ---------------------------------------------------------------- row security

alter table public.calendar_events enable row level security;
revoke all on public.calendar_events from anon, authenticated;
grant select on public.calendar_events to authenticated;
revoke all on sequence public.calendar_event_id_seq from anon, authenticated;

-- The board sees every event, archived ones included (the page hides those; History keeps them).
create policy board_read on public.calendar_events for select to authenticated
  using ((select public.is_board()));
-- A team login: community events and its own team's schedule. Never a board meeting, never another team.
create policy team_read on public.calendar_events for select to authenticated
  using (archived_at is null and (select public.my_team()) is not null
         and (kind = 'community' or (kind = 'team' and team_id = (select public.my_team()))));

-- Never deleted (archive instead); every change logged.
create trigger calendar_events_no_delete before delete on public.calendar_events
  for each row execute function public.no_delete_guard();
create trigger calendar_events_log after insert or update or delete on public.calendar_events
  for each row execute function public.log_change();

-- An event's kind and team never change, whoever asks (owner included). The change log files each row under the
-- record's team, with the full record before and after; a board meeting turned team event, or an event moved from
-- one team to another, would show its earlier details to that team's login. Archive it and add a new one instead.
create or replace function public.calendar_owner_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind or new.team_id is distinct from old.team_id then
    raise exception 'An event''s kind and team cannot change. Archive it and add a new one instead' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.calendar_owner_fixed() from public, anon, authenticated;
create trigger calendar_events_owner_fixed before update of kind, team_id on public.calendar_events
  for each row execute function public.calendar_owner_fixed();

-- ---------------------------------------------------------------- who may change an event

-- Raises unless the caller may change this event: officers any event, a team login only its own team's schedule.
create or replace function public.calendar_can_change(p_kind text, p_team_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_team text := public.my_team();
begin
  if public.is_board() then return; end if;
  if v_team is null then
    raise exception 'Changing the calendar is not allowed for your role' using errcode = '42501';
  end if;
  if p_kind is distinct from 'team' or p_team_id is distinct from v_team then
    raise exception 'Coaches add and change only their own team''s schedule' using errcode = '42501';
  end if;
end;
$$;

-- The last day of the season a date falls in: the end of its fiscal year (settings.fy_start).
create or replace function public.calendar_season_end(p_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date := coalesce((select s.fy_start from public.settings s where s.id = 1), make_date(extract(year from p_date)::int, 7, 1));
  v_end date;
begin
  v_start := make_date(extract(year from p_date)::int, extract(month from v_start)::int, extract(day from v_start)::int);
  if v_start > p_date then v_start := (v_start - interval '1 year')::date; end if;
  v_end := (v_start + interval '1 year' - interval '1 day')::date;
  return v_end;
end;
$$;

-- ---------------------------------------------------------------- actions

-- Add or change an event. Returns the ids written (more than one for a weekly repeat).
-- p: {id?, kind, team_id, type, title, date, start_time, end_time, location, notes, repeat ('weekly' or none), until?}
-- A team login's events are always for its own team. On a change, kind and team must stay as they are.
create or replace function public.calendar_save(p jsonb)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.calendar_events%rowtype;
  v_kind text := nullif(trim(coalesce(p ->> 'kind', '')), '');
  v_team text := nullif(trim(coalesce(p ->> 'team_id', '')), '');
  v_type text := nullif(trim(coalesce(p ->> 'type', '')), '');
  v_title text := nullif(trim(coalesce(p ->> 'title', '')), '');
  v_date date := nullif(p ->> 'date', '')::date;
  v_start time := nullif(p ->> 'start_time', '')::time;
  v_end time := nullif(p ->> 'end_time', '')::time;
  v_until date;
  v_series text;
  v_ids text[] := '{}';
  v_id text;
  d date;
begin
  if not public.is_board() and public.my_team() is null then
    raise exception 'Changing the calendar is not allowed for your role' using errcode = '42501';
  end if;
  -- A team login's events are its own team's schedule.
  if not public.is_board() then
    v_kind := coalesce(v_kind, 'team');
    v_team := coalesce(v_team, public.my_team());
  end if;
  if v_kind is null or v_kind not in ('board','community','team') then raise exception 'Pick the kind of event'; end if;
  if v_kind = 'team' then
    if v_team is null then raise exception 'Pick the team'; end if;
    v_type := coalesce(v_type, 'Practice');
  else
    v_team := null; v_type := null;
  end if;
  if v_date is null then raise exception 'Pick the date'; end if;
  if v_start is not null and v_end is not null and v_end <= v_start then raise exception 'The end time must be after the start time'; end if;
  v_title := coalesce(v_title, case v_kind when 'team' then v_type when 'board' then 'Board Meeting' else 'Community Event' end);
  perform public.calendar_can_change(v_kind, v_team);
  if v_team is not null and not exists (select 1 from public.teams t where t.id = v_team and t.archived_at is null) then
    raise exception 'Team not found';
  end if;

  if nullif(p ->> 'id', '') is not null then
    select * into old from public.calendar_events e where e.id = p ->> 'id' and e.archived_at is null for update;
    if not found then raise exception 'Event not found or archived'; end if;
    perform public.calendar_can_change(old.kind, old.team_id);   -- may change the event as it stands
    -- An event keeps its kind and team for life, so its history never crosses from the board or one team to another.
    if v_kind is distinct from old.kind or v_team is distinct from old.team_id then
      raise exception 'An event''s kind and team cannot change. Archive it and add a new one instead';
    end if;
    update public.calendar_events set
      kind = v_kind, team_id = v_team, type = v_type, title = v_title, date = v_date, start_time = v_start, end_time = v_end,
      location = nullif(trim(coalesce(p ->> 'location', '')), ''), notes = nullif(trim(coalesce(p ->> 'notes', '')), '')
     where id = old.id;
    return array[old.id];
  end if;

  if coalesce(p ->> 'repeat', '') = 'weekly' then
    v_until := coalesce(nullif(p ->> 'until', '')::date, public.calendar_season_end(v_date));
    if v_until < v_date then raise exception 'The repeat must end on or after the first date'; end if;
    if (v_until - v_date) / 7 + 1 > 60 then raise exception 'A weekly repeat can add at most 60 weeks'; end if;
    v_series := 'S-' || nextval('public.calendar_event_id_seq');
  else
    v_until := v_date;
  end if;
  d := v_date;
  while d <= v_until loop
    insert into public.calendar_events (kind, team_id, type, title, date, start_time, end_time, location, notes, series_id, added_by, added_by_user)
    values (v_kind, v_team, v_type, v_title, d, v_start, v_end,
            nullif(trim(coalesce(p ->> 'location', '')), ''), nullif(trim(coalesce(p ->> 'notes', '')), ''),
            v_series, public.my_name(), auth.uid())
    returning id into v_id;
    v_ids := v_ids || v_id;
    d := d + 7;
  end loop;
  return v_ids;
end;
$$;

-- Take an event off the calendar (archived, never deleted). Same rule as changing it.
create or replace function public.calendar_archive(p_id text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare old public.calendar_events%rowtype;
begin
  select * into old from public.calendar_events e where e.id = p_id and e.archived_at is null for update;
  if not found then raise exception 'Event not found or already archived'; end if;
  perform public.calendar_can_change(old.kind, old.team_id);
  perform public.via('archive');
  update public.calendar_events set archived_at = now(), archived_by = public.my_name(),
         archive_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- function grants

do $$
declare f text;
begin
  foreach f in array array['public.calendar_save(jsonb)', 'public.calendar_archive(text,text)', 'public.calendar_season_end(date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  execute 'revoke all on function public.calendar_can_change(text,text) from public, anon, authenticated';
end $$;


-- ================================================================ 0009_problem_reports

-- GPRIC Portal P37, Report A Problem and Problem Reports.
-- Anyone signed in (board or team login) sends a report from any page: notes, an optional screen snip and an optional
-- voice note. The database fills in the person, their role and team, the time and the device itself; the page comes
-- from the browser (or, failing that, the request's Referer). No email is sent.
-- Only the Treasurer reads reports and changes their status (New, Looking, Won't Fix, Fixed) and reply note.
-- Reports are never deleted. Their files live in the private board-files bucket under problems/<user id>/ and,
-- like every file there, cannot be overwritten or removed; only the Treasurer can open them.

create sequence public.problem_report_id_seq;

create table public.problem_reports (
  id text primary key default public.pad_id('PR-', nextval('public.problem_report_id_seq'), 3),
  created_at timestamptz not null default now(),
  user_id uuid not null,
  who text not null,
  role text,                          -- treasurer, board, bookkeeper, cpa, team
  team_id text references public.teams (id),
  page text not null,                 -- the path and query the report was sent from, e.g. /ledger?fund=F-GEN
  page_title text,                    -- the page's name as the reporter saw it
  device text,                        -- browser and screen size, or the raw user agent
  notes text,
  transcript text,                    -- the words of the voice note, when the browser could write them out
  screenshot_path text,
  audio_path text,
  audio_secs int check (audio_secs is null or audio_secs between 0 and 3600),
  status text not null default 'New' check (status in ('New', 'Looking', 'Won''t Fix', 'Fixed')),
  reply text,                         -- the Treasurer's note on what was done (not sent anywhere)
  updated_at timestamptz,
  updated_by text,
  sample boolean not null default false,
  constraint problem_reports_something check (nullif(trim(coalesce(notes, '')), '') is not null or screenshot_path is not null or audio_path is not null)
);
create index problem_reports_created_idx on public.problem_reports (created_at desc);
create index problem_reports_status_idx on public.problem_reports (status, created_at desc);

-- The person, time and device are the database's, never the browser's.
create or replace function public.problem_report_fill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
  v_hdr jsonb;
  v_ref text;
  v_dir text;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then raise exception 'Sign in to report a problem' using errcode = '42501'; end if;
    select * into w from public.log_who();
    begin v_hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_hdr := null; end;
    new.created_at := now();
    new.user_id := auth.uid();
    new.who := coalesce(nullif(w.o_who, ''), public.my_name());
    new.role := w.o_role;
    new.team_id := (select u.team_id from public.team_users u where u.user_id = auth.uid());
    new.status := 'New';
    new.reply := null;
    new.updated_at := null;
    new.updated_by := null;
    new.sample := false;
    v_ref := substring(coalesce(v_hdr ->> 'referer', '') from '^https?://[^/]+(/.*)$');
    new.page := left(coalesce(nullif(trim(new.page), ''), v_ref, '/'), 500);
    new.page_title := left(nullif(trim(new.page_title), ''), 120);
    new.device := left(coalesce(nullif(trim(new.device), ''), w.o_device), 300);
    new.notes := left(nullif(trim(new.notes), ''), 5000);
    new.transcript := left(nullif(trim(new.transcript), ''), 5000);
    v_dir := 'problems/' || auth.uid()::text || '/';
    if (new.screenshot_path is not null and left(new.screenshot_path, length(v_dir)) <> v_dir)
       or (new.audio_path is not null and left(new.audio_path, length(v_dir)) <> v_dir) then
      raise exception 'Report files must be your own uploads' using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE: only the status and reply move (column grants and row security see to that); stamp who changed them.
  new.updated_at := now();
  new.updated_by := public.my_name();
  return new;
end;
$$;
revoke all on function public.problem_report_fill() from public, anon, authenticated;
create trigger problem_reports_fill before insert or update on public.problem_reports
  for each row execute function public.problem_report_fill();

-- Never deleted, like the money records (0004); every add and change goes to the action log (0005).
create trigger problem_reports_no_delete before delete on public.problem_reports
  for each row execute function public.no_delete_guard();
create trigger problem_reports_log after insert or update or delete on public.problem_reports
  for each row execute function public.log_change();

-- ---------------------------------------------------------------- row security

alter table public.problem_reports enable row level security;
create policy problems_insert_own on public.problem_reports for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy problems_treasurer_read on public.problem_reports for select to authenticated
  using ((select public.is_treasurer()));
create policy problems_treasurer_update on public.problem_reports for update to authenticated
  using ((select public.is_treasurer())) with check ((select public.is_treasurer()));

revoke all on public.problem_reports from public, anon, authenticated;
grant insert (page, page_title, device, notes, transcript, screenshot_path, audio_path, audio_secs) on public.problem_reports to authenticated;
grant select on public.problem_reports to authenticated;
grant update (status, reply) on public.problem_reports to authenticated;
grant usage on sequence public.problem_report_id_seq to authenticated;

-- The action log is read by the whole board; a problem report's notes are the Treasurer's only.
create policy problems_log_treasurer_only on public.change_log as restrictive for select to authenticated
  using (tbl <> 'problem_reports' or (select public.is_treasurer()));

-- A team login reads its team's history through change_log_team, which filters on team_id only. A problem report's
-- log rows never carry a team, so teammates never see each other's reports. Done with a trigger on the log rather
-- than by redefining the shared log_team(), so later migrations that redefine log_team() cannot undo it.
create or replace function public.change_log_no_problem_team()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tbl = 'problem_reports' then new.team_id := null; end if;
  return new;
end;
$$;
revoke all on function public.change_log_no_problem_team() from public, anon, authenticated;
create trigger change_log_no_problem_team before insert on public.change_log
  for each row execute function public.change_log_no_problem_team();

-- ---------------------------------------------------------------- files

-- Anyone signed in uploads into their own problems/<user id>/ folder (no update or delete policy exists, so a file
-- once stored stays as it is).
create policy problem_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'board-files' and (storage.foldername(name))[1] = 'problems'
              and (storage.foldername(name))[2] = (select auth.uid())::text);

-- Whatever else a role may upload (the board anywhere, 0001; a team under team/<its team>/, 0003), the problems/
-- folder takes files only under the uploader's own user id. Restrictive, so it narrows every insert policy.
create policy problem_files_own_folder on storage.objects as restrictive for insert to authenticated
  with check (bucket_id is distinct from 'board-files' or (storage.foldername(name))[1] is distinct from 'problems'
              or (storage.foldername(name))[2] = (select auth.uid())::text);

-- The board reads the whole bucket except problem report files, which only the Treasurer opens.
drop policy if exists board_files_select on storage.objects;
create policy board_files_select on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and (select public.is_board())
         and ((storage.foldername(name))[1] is distinct from 'problems' or (select public.is_treasurer())));


-- ================================================================ 0010_history_areas

-- GPRIC Portal: History areas and record names for the Calendar (0008) and Problem Reports (0009).
-- Applies after 0006 (requests v2), whose log_area and log_label it extends; nothing else changes.
-- A problem report's label names the page only (never the reporter's notes), and 0009 keeps it out of team History.

create or replace function public.log_area(p_tbl text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tbl
    when 'ledger' then 'Ledger' when 'money_overrides' then 'Ledger'
    when 'team_requests' then 'Requests' when 'receipts' then 'Requests' when 'request_approvals' then 'Requests'
    when 'request_refunds' then 'Requests'
    when 'donations' then 'Donations' when 'donors' then 'Donations' when 'zeffy_sync_log' then 'Donations' when 'zeffy_skip' then 'Donations'
    when 'grants' then 'Grants'
    when 'teams' then 'Teams' when 'funds' then 'Teams' when 'team_users' then 'Teams' when 'team_invites' then 'Teams'
    when 'bank_statements' then 'Bank' when 'bank_lines' then 'Bank'
    when 'sessions' then 'Sign-ins'
    when 'accounts' then 'Accounts' when 'documents' then 'Documents'
    when 'meetings' then 'Meetings' when 'meeting_votes' then 'Meetings'
    when 'calendar_events' then 'Calendar' when 'problem_reports' then 'Problems'
    else 'Settings' end;
$$;

create or replace function public.log_label(p_tbl text, r jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team text := coalesce(
    (select t.short from public.teams t where t.id = coalesce(r ->> 'team_id',
       (select q.team_id from public.team_requests q where q.id = r ->> 'request_id'))),
    (select f.name from public.funds f where f.id = coalesce(r ->> 'charge_fund_id',
       (select q.charge_fund_id from public.team_requests q where q.id = r ->> 'request_id'))));
  m text := public.log_money(r);
begin
  return case p_tbl
    when 'ledger' then concat_ws(' ', 'Ledger ·', m, coalesce(r ->> 'party', r ->> 'source', r ->> 'category', r ->> 'memo'))
                       || coalesce(' · ' || (select f.name from public.funds f where f.id = r ->> 'fund_id'), '')
    when 'team_requests' then concat_ws(' ', case when r ->> 'type' = 'Direct Expense' then 'Direct expense ·' else 'Request ·' end,
                                        m, coalesce(r ->> 'vendor', r ->> 'purpose')) || coalesce(' · ' || v_team, '')
    when 'receipts' then concat_ws(' ', 'Receipt ·', m, r ->> 'vendor') || coalesce(' · ' || v_team, '')
    when 'request_refunds' then concat_ws(' ', 'Refund ·', m, 'request ' || coalesce(r ->> 'request_id', '')) || coalesce(' · ' || v_team, '')
    when 'request_approvals' then 'Approval · request ' || coalesce(r ->> 'request_id', '') || coalesce(' · ' || (r ->> 'approver_name'), '')
    when 'donations' then concat_ws(' ', 'Donation ·', m, (select d.name from public.donors d where d.id = r ->> 'donor_id'))
    when 'donors' then 'Donor · ' || coalesce(r ->> 'name', '')
    when 'grants' then concat_ws(' ', 'Grant ·', r ->> 'funder', case when r ->> 'awarded' is not null then '$' || to_char((r ->> 'awarded')::numeric, 'FM999,999,990') end)
    when 'teams' then 'Team · ' || coalesce(r ->> 'name', '')
    when 'funds' then 'Fund · ' || coalesce(r ->> 'name', '')
    when 'team_users' then 'Team login · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_team, '')
    when 'team_invites' then 'Invite · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_team, '')
    when 'bank_statements' then 'Month · ' || coalesce(trim(to_char((r ->> 'month')::date, 'FMMonth YYYY')), '')
    when 'bank_lines' then concat_ws(' ', 'Bank line ·', m, r ->> 'description')
    when 'accounts' then 'Account · ' || coalesce(r ->> 'service', '')
    when 'documents' then 'Document · ' || coalesce(r ->> 'title', '')
    when 'meetings' then 'Meeting · ' || coalesce(nullif(r ->> 'title', ''), r ->> 'date', '')
    when 'meeting_votes' then 'Vote · ' || coalesce(r ->> 'item', '')
    when 'calendar_events' then 'Event · ' || coalesce(r ->> 'title', '') || coalesce(' · ' || to_char((r ->> 'date')::date, 'FMMon FMDD, YYYY'), '') || coalesce(' · ' || v_team, '')
    when 'problem_reports' then 'Problem report · ' || coalesce(nullif(r ->> 'page_title', ''), r ->> 'page', '')
    when 'board_members' then 'Board member · ' || coalesce(r ->> 'name', '')
    when 'portal_access' then 'Board access · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '')
    when 'settings' then 'Settings'
    when 'zeffy_sync_log' then 'Zeffy sync · ' || coalesce(r ->> 'source', '')
    when 'zeffy_skip' then 'Zeffy gift skipped · ' || coalesce(r ->> 'zeffy_key', '')
    when 'money_overrides' then 'Override · ' || coalesce(r ->> 'rule', '')
    else p_tbl end;
end;
$$;
revoke all on function public.log_label(text, jsonb) from public, anon, authenticated;


-- ================================================================ 0011_receipts

-- GPRIC Portal 0011: Receipts (P33). Applies after 0010.
--   * receipt_reminders: the board flags a missing receipt in the portal (no email is sent; there is no email service yet).
--   * Team reimbursements take any number of receipts and their total is the receipts' sum, the same model 0006 uses for a
--     direct expense's invoices. The total follows the receipts only while the request is still waiting with no approval;
--     once a board member has approved it, the total is fixed. Payment is unchanged: one payment for the whole request.
--   * A missing receipt file can be attached to a receipt already on file (board: any request; team: its own folder only).
--   * team_portal() also returns each request's receipts, its cancel and refund (read only), the last reminder, and the
--     direct expenses charged to the team's own fund. Archived receipts no longer count.
-- Money still moves only through the 0004/0006 functions: one payment per request, refund and roll-back guards unchanged.

-- ---------------------------------------------------------------- reminders

create sequence public.reminder_id_seq;
create table public.receipt_reminders (
  id text primary key default public.pad_id('RM-', nextval('public.reminder_id_seq'), 3),
  request_id text not null references public.team_requests (id) on delete cascade,
  note text,
  by_name text,
  sample boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  archive_reason text
);
create index receipt_reminders_request_idx on public.receipt_reminders (request_id);

alter table public.receipt_reminders enable row level security;
revoke all on public.receipt_reminders from anon, authenticated;
grant select on public.receipt_reminders to authenticated;
revoke all on sequence public.reminder_id_seq from anon, authenticated;
-- The board reads them; teams see their own through team_portal(). Writes go through receipt_remind() only.
create policy board_only on public.receipt_reminders for all to authenticated
  using ((select public.is_board())) with check ((select public.is_board()));

create trigger receipt_reminders_no_delete before delete on public.receipt_reminders
  for each row execute function public.no_delete_guard();
create trigger receipt_reminders_log after insert or update or delete on public.receipt_reminders
  for each row execute function public.log_change();

-- A paid request (or an already-paid direct expense) still missing a receipt file.
create or replace function public.receipt_missing(p_request_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_requests r
     where r.id = p_request_id and r.archived_at is null
       and (r.status in ('Paid','Receipts Due','Closed','Reviewed') or (r.type = 'Direct Expense' and r.status = 'Submitted'))
       and ((not exists (select 1 from public.receipts c where c.request_id = r.id and c.archived_at is null)
             and r.receipt_path is null and r.status <> 'Closed')
            or exists (select 1 from public.receipts c where c.request_id = r.id and c.archived_at is null and c.file_path is null)));
$$;
revoke all on function public.receipt_missing(text) from public, anon, authenticated;

-- Flag a missing receipt in the portal. Nothing is emailed; the team sees the reminder on its request.
create or replace function public.receipt_remind(p_request_id text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_id text;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Sending a receipt reminder');
  perform public.via('remind');
  select * into r from public.team_requests where id = p_request_id;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if not public.receipt_missing(r.id) then raise exception 'Nothing is missing a receipt on request %', r.id; end if;
  insert into public.receipt_reminders (request_id, note, by_name, sample)
  values (r.id, nullif(trim(coalesce(p_note, '')), ''), public.my_name(), r.sample)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- a reimbursement's total is its receipts' sum

-- Still waiting, no approval yet: its receipts (and so its total) can change.
create or replace function public.reimbursement_open(p_request_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.team_requests r
                  where r.id = p_request_id and r.type = 'Reimbursement' and r.archived_at is null
                    and r.status in ('Draft','Submitted')
                    and not exists (select 1 from public.request_approvals a where a.request_id = r.id));
$$;
revoke all on function public.reimbursement_open(text) from public, anon, authenticated;

-- Sets a still-open reimbursement's total to the sum of its receipts.
create or replace function public.reimbursement_resync(p_request_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was text := coalesce(current_setting('gpric.via', true), '');
  v_sum numeric;
begin
  if not public.reimbursement_open(p_request_id) then return; end if;
  select round(sum(amount), 2) into v_sum from public.receipts where request_id = p_request_id and archived_at is null;
  if v_sum is null or v_sum <= 0 then raise exception 'A reimbursement needs at least one receipt with an amount; cancel it instead'; end if;
  perform public.via('receipts');
  update public.team_requests set amount = v_sum where id = p_request_id and amount is distinct from v_sum;
  perform public.via(v_was);
end;
$$;
revoke all on function public.reimbursement_resync(text) from public, anon, authenticated;

-- A reimbursement that holds receipts never has its total typed in: it follows the receipts (History roll back included;
-- roll back the receipt instead). Reimbursements filed before 0011 with no receipt rows keep their typed total.
create or replace function public.reimbursement_total_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.type = 'Reimbursement' and new.amount is distinct from old.amount
     and coalesce(current_setting('gpric.via', true), '') not in ('receipts','admin','clear_sample')
     and exists (select 1 from public.receipts c where c.request_id = new.id and c.archived_at is null) then
    raise exception 'A reimbursement''s total is the sum of its receipts; add or remove a receipt instead' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger team_requests_reimbursement_total
  before update of amount on public.team_requests
  for each row execute function public.reimbursement_total_guard();
revoke all on function public.reimbursement_total_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- team: submit with many receipts

-- A team user's new request. Blocked while the team has receipts past due.
-- p: {type, purpose, category, amount, needed_by, pay_to, purchase_date, vendor, zelle_contact, team_ledger_ref, certified,
--     receipts: [{vendor, amount, date, file_name, file_path}]}       (a reimbursement; the total is their sum)
--  or the 0003 single receipt: {receipt_path, receipt_name} with amount.
create or replace function public.submit_team_request(p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team text := public.my_team();
  u public.team_users%rowtype;
  v_type text := p ->> 'type';
  v_amount numeric := round(nullif(p ->> 'amount', '')::numeric, 2);
  v_path text := nullif(trim(p ->> 'receipt_path'), '');
  v_rc jsonb := p -> 'receipts';
  v_many boolean;
  v_vendor text := nullif(trim(p ->> 'vendor'), '');
  v_id text;
  i jsonb;
  n int;
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  n := public.team_overdue(v_team);
  if n > 0 then
    raise exception 'New requests are paused: % paid request% past the receipt deadline. Add those receipts first.',
      n, case when n = 1 then ' is' else 's are' end;
  end if;
  if v_type not in ('Pre-Approval', 'Reimbursement') then raise exception 'Choose Pre-Approval or Reimbursement'; end if;
  v_many := v_type = 'Reimbursement' and v_rc is not null and jsonb_typeof(v_rc) = 'array' and jsonb_array_length(v_rc) > 0;
  if v_type = 'Pre-Approval' and v_rc is not null and jsonb_typeof(v_rc) = 'array' and jsonb_array_length(v_rc) > 0 then
    raise exception 'A pre-approval''s receipts come after it is paid';
  end if;
  if v_many then
    for i in select value from jsonb_array_elements(v_rc) loop
      if coalesce(nullif(i ->> 'amount', '')::numeric, 0) <= 0 then raise exception 'Each receipt needs an amount'; end if;
      if nullif(trim(i ->> 'file_path'), '') is null then raise exception 'Attach the receipt'; end if;
      if trim(i ->> 'file_path') not like 'team/' || v_team || '/%' then raise exception 'Receipt file is not in this team''s folder'; end if;
    end loop;
    select round(sum(round((value ->> 'amount')::numeric, 2)), 2),
           coalesce(v_vendor, string_agg(distinct nullif(trim(value ->> 'vendor'), ''), ', '))
      into v_amount, v_vendor
      from jsonb_array_elements(v_rc);
  end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if coalesce((p ->> 'certified')::boolean, false) is not true then raise exception 'Tick the certification to submit'; end if;
  if v_type = 'Reimbursement' then
    if not v_many and v_path is null then raise exception 'Attach the receipt'; end if;
    if nullif(trim(p ->> 'zelle_contact'), '') is null then raise exception 'Add the Zelle contact to pay you'; end if;
  end if;
  if v_path is not null and v_path not like 'team/' || v_team || '/%' then raise exception 'Receipt file is not in this team''s folder'; end if;
  select * into u from public.team_users where user_id = auth.uid();
  insert into public.team_requests (team_id, type, purpose, category, amount, pay_to, needed_by, purchase_date, vendor,
    zelle_contact, team_ledger_ref, receipt_path, receipt_name, certified, submitted, status,
    submitted_by_user, requestor_name, requestor_email, requestor_member_id, created_by)
  values (v_team, v_type,
    coalesce(nullif(trim(p ->> 'purpose'), ''), case when v_type = 'Reimbursement' then coalesce(v_vendor, 'Reimbursement') end),
    nullif(trim(p ->> 'category'), ''), v_amount,
    case when v_type = 'Reimbursement' then 'Me by Zelle' else nullif(trim(p ->> 'pay_to'), '') end,
    nullif(p ->> 'needed_by', '')::date, nullif(p ->> 'purchase_date', '')::date, v_vendor,
    nullif(trim(p ->> 'zelle_contact'), ''), nullif(trim(p ->> 'team_ledger_ref'), ''),
    case when v_many then null else v_path end, case when v_many then null else nullif(trim(p ->> 'receipt_name'), '') end,
    true, current_date, 'Submitted', auth.uid(), coalesce(u.name, u.email), u.email,
    (select m.id from public.board_members m where m.email is not null and lower(m.email) = lower(u.email) order by m.sort limit 1),
    coalesce(u.name, u.email))
  returning id into v_id;
  if v_many then
    insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by)
    select v_id, coalesce(nullif(trim(value ->> 'vendor'), ''), v_vendor), round((value ->> 'amount')::numeric, 2),
           coalesce(nullif(value ->> 'date', '')::date, nullif(p ->> 'purchase_date', '')::date, current_date),
           nullif(trim(value ->> 'file_name'), ''), trim(value ->> 'file_path'), coalesce(u.name, u.email)
      from jsonb_array_elements(v_rc) with ordinality x(value, k) order by k;
  elsif v_type = 'Reimbursement' then
    insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by)
    values (v_id, v_vendor, v_amount, coalesce(nullif(p ->> 'purchase_date', '')::date, current_date),
            nullif(trim(p ->> 'receipt_name'), ''), v_path, coalesce(u.name, u.email));
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- team: add, remove, attach

-- A team user adds a receipt: to a paid pre-approval collecting receipts (0003), or to its own reimbursement while it is
-- still waiting with no approval (the total follows).
create or replace function public.add_team_receipt(
  p_request_id text, p_vendor text, p_amount numeric, p_date date, p_file_name text, p_file_path text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team text := public.my_team();
  u public.team_users%rowtype;
  r public.team_requests%rowtype;
  v_id text;
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  select * into r from public.team_requests where id = p_request_id and team_id = v_team and archived_at is null for update;
  if r.id is null or not (r.status = 'Receipts Due' or public.reimbursement_open(r.id)) then
    raise exception 'Receipts can be added only to your team''s paid pre-approvals, or to a reimbursement the board has not approved yet';
  end if;
  if p_file_path is null or p_file_path not like 'team/' || v_team || '/%' then raise exception 'Attach the receipt file'; end if;
  if p_amount is null or p_amount < 0 or (r.type = 'Reimbursement' and p_amount = 0) then raise exception 'Enter the receipt amount'; end if;
  select * into u from public.team_users where user_id = auth.uid();
  insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by, sample)
  values (r.id, nullif(trim(p_vendor), ''), round(p_amount, 2), coalesce(p_date, current_date), p_file_name, p_file_path,
          coalesce(u.name, u.email), r.sample)
  returning id into v_id;
  perform public.reimbursement_resync(r.id);
  return v_id;
end;
$$;

-- A team user takes a receipt off its own request (pre-approval collecting receipts, or an open reimbursement). The file stays.
create or replace function public.team_receipt_remove(p_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team text := public.my_team();
  c public.receipts%rowtype;
  r public.team_requests%rowtype;
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason'; end if;
  select * into c from public.receipts where id = p_id and archived_at is null;
  select * into r from public.team_requests where id = c.request_id and team_id = v_team and archived_at is null for update;
  if c.id is null or r.id is null then raise exception 'Receipt not found'; end if;
  if not (r.status = 'Receipts Due' or public.reimbursement_open(r.id)) then
    raise exception 'This receipt can no longer be removed; ask the board';
  end if;
  if r.type = 'Reimbursement'
     and not exists (select 1 from public.receipts x where x.request_id = r.id and x.archived_at is null and x.id <> c.id) then
    raise exception 'A reimbursement needs at least one receipt; cancel it instead';
  end if;
  perform public.via('receipt');
  update public.receipts set archived_at = now(), archived_by = coalesce((select coalesce(u.name, u.email) from public.team_users u where u.user_id = auth.uid()), 'Team'),
         archive_reason = trim(p_reason)
   where id = c.id;
  perform public.reimbursement_resync(r.id);
end;
$$;

-- A team user attaches the file to one of its own receipts that has none.
create or replace function public.team_receipt_attach(p_id text, p_file_name text, p_file_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_team text := public.my_team();
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  if p_file_path is null or p_file_path not like 'team/' || v_team || '/%' then raise exception 'Receipt file is not in this team''s folder'; end if;
  perform public.via('receipt');
  update public.receipts c set file_name = nullif(trim(p_file_name), ''), file_path = p_file_path
   where c.id = p_id and c.archived_at is null and c.file_path is null
     and exists (select 1 from public.team_requests r where r.id = c.request_id and r.team_id = v_team
                    and r.type <> 'Direct Expense' and r.archived_at is null);
  if not found then raise exception 'Receipt not found, or it already has its file'; end if;
end;
$$;

-- ---------------------------------------------------------------- board: add, remove, attach

-- 0004's add_request_receipt, plus: a reimbursement's receipts change only while it is open (still waiting, no approval),
-- and its total follows them. After that they are fixed; a missing file is attached with receipt_attach.
create or replace function public.add_request_receipt(
  p_request_id text, p_vendor text, p_amount numeric, p_date date, p_file_name text, p_file_path text, p_by text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_id text;
begin
  perform public.require_board();
  perform public.via('close');
  select * into r from public.team_requests where id = p_request_id and archived_at is null for update;
  if r.id is null then raise exception 'Request not found'; end if;
  -- (a reimbursement entered before 0011 with no receipt rows at all may still get its first one)
  if r.type = 'Reimbursement' and not public.reimbursement_open(r.id)
     and exists (select 1 from public.receipts c where c.request_id = r.id and c.archived_at is null) then
    raise exception 'This reimbursement already has approvals; its receipts and total are fixed. Attach a missing file instead';
  end if;
  if r.type = 'Reimbursement' and coalesce(p_amount, 0) <= 0 then
    raise exception 'Enter the receipt amount';
  end if;
  insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by, sample)
  values (r.id, p_vendor, round(coalesce(p_amount, 0), 2), coalesce(p_date, current_date), p_file_name, p_file_path,
          coalesce(nullif(p_by, ''), public.my_name()), r.sample)
  returning id into v_id;
  update public.team_requests set status = 'Receipts Due' where id = p_request_id and status = 'Paid' and type <> 'Reimbursement';
  perform public.reimbursement_resync(r.id);
  return v_id;
end;
$$;

-- 0004's receipt_archive, plus the reimbursement rules above (History's roll back of an added receipt comes here too).
create or replace function public.receipt_archive(p_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.receipts%rowtype;
  r public.team_requests%rowtype;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Removing a receipt');
  perform public.via('receipt');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason'; end if;
  select * into c from public.receipts where id = p_id and archived_at is null;
  select * into r from public.team_requests where id = c.request_id for update;
  if c.id is null or r.status = 'Closed' then raise exception 'Receipt not found, or its request is already closed'; end if;
  if r.type = 'Reimbursement' and not public.reimbursement_open(r.id) then
    raise exception 'This reimbursement already has approvals; its receipts and total are fixed';
  end if;
  if public.reimbursement_open(r.id)
     and not exists (select 1 from public.receipts x where x.request_id = r.id and x.archived_at is null and x.id <> c.id) then
    raise exception 'A reimbursement needs at least one receipt; cancel it instead';
  end if;
  update public.receipts set archived_at = now(), archived_by = public.my_name(), archive_reason = trim(p_reason) where id = c.id;
  perform public.reimbursement_resync(r.id);
end;
$$;

-- The board attaches the missing file to a receipt already on file (a direct expense's invoice included; its amount and
-- vendor stay fixed, only the file is added).
create or replace function public.receipt_attach(p_id text, p_file_name text, p_file_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Attaching a receipt');
  if nullif(trim(coalesce(p_file_path, '')), '') is null then raise exception 'Choose the file'; end if;
  perform public.via('request');
  update public.receipts set file_name = nullif(trim(p_file_name), ''), file_path = trim(p_file_path)
   where id = p_id and archived_at is null and file_path is null;
  if not found then raise exception 'Receipt not found, or it already has its file'; end if;
end;
$$;

-- ---------------------------------------------------------------- the Team Portal

create or replace function public.team_receipt_json(p_request_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'vendor', c.vendor, 'amount', c.amount, 'date', c.date,
           'file_name', c.file_name, 'file_path', c.file_path, 'uploaded_by', c.uploaded_by, 'created_at', c.created_at)
           order by c.date, c.id), '[]'::jsonb)
    from public.receipts c where c.request_id = p_request_id and c.archived_at is null;
$$;
revoke all on function public.team_receipt_json(text) from public, anon, authenticated;

-- What a team sees of one request beyond 0003: its receipts, its cancel and refund (read only) and the last reminder.
create or replace function public.team_request_extra(p_request_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'receipt_list', public.team_receipt_json(r.id),
    'receipt_path', r.receipt_path,
    'cancel_reason', r.cancel_reason, 'cancelled_at', r.cancelled_at, 'replaced_by_id', r.replaced_by_id, 'replaces_id', r.replaces_id,
    'refund', (select jsonb_build_object('amount', f.amount, 'date', f.date, 'reason', f.reason)
                 from public.request_refunds f where f.request_id = r.id and f.archived_at is null order by f.created_at desc limit 1),
    'reminder', (select jsonb_build_object('at', m.created_at, 'by', m.by_name, 'note', m.note)
                   from public.receipt_reminders m where m.request_id = r.id and m.archived_at is null order by m.created_at desc, m.id desc limit 1),
    'missing', public.receipt_missing(r.id))
  from public.team_requests r where r.id = p_request_id;
$$;
revoke all on function public.team_request_extra(text) from public, anon, authenticated;

-- Everything the Team Portal shows, for the caller's own team only.
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
      where d.fund_id = t.fund_id and t.fund_id is not null), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- History

create or replace function public.log_area(p_tbl text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tbl
    when 'ledger' then 'Ledger' when 'money_overrides' then 'Ledger'
    when 'team_requests' then 'Requests' when 'receipts' then 'Requests' when 'request_approvals' then 'Requests'
    when 'request_refunds' then 'Requests' when 'receipt_reminders' then 'Requests'
    when 'donations' then 'Donations' when 'donors' then 'Donations' when 'zeffy_sync_log' then 'Donations' when 'zeffy_skip' then 'Donations'
    when 'grants' then 'Grants'
    when 'teams' then 'Teams' when 'funds' then 'Teams' when 'team_users' then 'Teams' when 'team_invites' then 'Teams'
    when 'bank_statements' then 'Bank' when 'bank_lines' then 'Bank'
    when 'sessions' then 'Sign-ins'
    when 'accounts' then 'Accounts' when 'documents' then 'Documents'
    when 'meetings' then 'Meetings' when 'meeting_votes' then 'Meetings'
    when 'calendar_events' then 'Calendar' when 'problem_reports' then 'Problems'
    else 'Settings' end;
$$;

create or replace function public.log_label(p_tbl text, r jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team text := coalesce(
    (select t.short from public.teams t where t.id = coalesce(r ->> 'team_id',
       (select q.team_id from public.team_requests q where q.id = r ->> 'request_id'))),
    (select f.name from public.funds f where f.id = coalesce(r ->> 'charge_fund_id',
       (select q.charge_fund_id from public.team_requests q where q.id = r ->> 'request_id'))));
  m text := public.log_money(r);
begin
  return case p_tbl
    when 'ledger' then concat_ws(' ', 'Ledger ·', m, coalesce(r ->> 'party', r ->> 'source', r ->> 'category', r ->> 'memo'))
                       || coalesce(' · ' || (select f.name from public.funds f where f.id = r ->> 'fund_id'), '')
    when 'team_requests' then concat_ws(' ', case when r ->> 'type' = 'Direct Expense' then 'Direct expense ·' else 'Request ·' end,
                                        m, coalesce(r ->> 'vendor', r ->> 'purpose')) || coalesce(' · ' || v_team, '')
    when 'receipts' then concat_ws(' ', 'Receipt ·', m, r ->> 'vendor') || coalesce(' · ' || v_team, '')
    when 'request_refunds' then concat_ws(' ', 'Refund ·', m, 'request ' || coalesce(r ->> 'request_id', '')) || coalesce(' · ' || v_team, '')
    when 'receipt_reminders' then 'Receipt reminder · request ' || coalesce(r ->> 'request_id', '') || coalesce(' · ' || v_team, '')
    when 'request_approvals' then 'Approval · request ' || coalesce(r ->> 'request_id', '') || coalesce(' · ' || (r ->> 'approver_name'), '')
    when 'donations' then concat_ws(' ', 'Donation ·', m, (select d.name from public.donors d where d.id = r ->> 'donor_id'))
    when 'donors' then 'Donor · ' || coalesce(r ->> 'name', '')
    when 'grants' then concat_ws(' ', 'Grant ·', r ->> 'funder', case when r ->> 'awarded' is not null then '$' || to_char((r ->> 'awarded')::numeric, 'FM999,999,990') end)
    when 'teams' then 'Team · ' || coalesce(r ->> 'name', '')
    when 'funds' then 'Fund · ' || coalesce(r ->> 'name', '')
    when 'team_users' then 'Team login · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_team, '')
    when 'team_invites' then 'Invite · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_team, '')
    when 'bank_statements' then 'Month · ' || coalesce(trim(to_char((r ->> 'month')::date, 'FMMonth YYYY')), '')
    when 'bank_lines' then concat_ws(' ', 'Bank line ·', m, r ->> 'description')
    when 'accounts' then 'Account · ' || coalesce(r ->> 'service', '')
    when 'documents' then 'Document · ' || coalesce(r ->> 'title', '')
    when 'meetings' then 'Meeting · ' || coalesce(nullif(r ->> 'title', ''), r ->> 'date', '')
    when 'meeting_votes' then 'Vote · ' || coalesce(r ->> 'item', '')
    when 'calendar_events' then 'Event · ' || coalesce(r ->> 'title', '') || coalesce(' · ' || to_char((r ->> 'date')::date, 'FMMon FMDD, YYYY'), '') || coalesce(' · ' || v_team, '')
    when 'problem_reports' then 'Problem report · ' || coalesce(nullif(r ->> 'page_title', ''), r ->> 'page', '')
    when 'board_members' then 'Board member · ' || coalesce(r ->> 'name', '')
    when 'portal_access' then 'Board access · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '')
    when 'settings' then 'Settings'
    when 'zeffy_sync_log' then 'Zeffy sync · ' || coalesce(r ->> 'source', '')
    when 'zeffy_skip' then 'Zeffy gift skipped · ' || coalesce(r ->> 'zeffy_key', '')
    when 'money_overrides' then 'Override · ' || coalesce(r ->> 'rule', '')
    else p_tbl end;
end;
$$;
revoke all on function public.log_label(text, jsonb) from public, anon, authenticated;

-- "Reminded" in History for a receipt reminder; everything else as 0006.
create or replace function public.log_action(p_op text, p_tbl text, o jsonb, n jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_op = 'DELETE' then 'Deleted'
    when p_tbl = 'team_invites' and p_op = 'INSERT' then 'Invited'
    when p_tbl = 'receipt_reminders' and p_op = 'INSERT' then 'Reminded'
    when p_tbl = 'zeffy_sync_log' then 'Synced'
    when p_tbl = 'money_overrides' then 'Overrode'
    when p_tbl = 'ledger' and p_op = 'INSERT' and n ->> 'reverses_id' is not null then 'Reversed'
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

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array[
    'public.receipt_remind(text,text)', 'public.receipt_attach(text,text,text)',
    'public.add_request_receipt(text,text,numeric,date,text,text,text)', 'public.receipt_archive(text,text)',
    'public.team_portal()', 'public.submit_team_request(jsonb)', 'public.add_team_receipt(text,text,numeric,date,text,text)',
    'public.team_receipt_remove(text,text)', 'public.team_receipt_attach(text,text,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ================================================================ 0012_cpa

-- GPRIC Portal 0012: the CPA login (P35). Applies after 0011.
--   The CPA signs in with two-step, like the board (my_role() is null without aal2), and reads the books: Dashboard,
--   Ledger, Requests, Donors and gifts, Grants, Team Balances, Accounts, bank months, Documents and receipts, Meetings
--   (read only) and History. Every receipt, statement, document and minutes file in the board bucket opens.
--   The CPA writes nothing, anywhere:
--     * is_board() never included cpa (0004), so every require_board() and every require_role() list already refused it,
--       and every board_only policy refuses its inserts, updates and deletes.
--     * On top of that, a statement trigger on every public table refuses any insert, update, delete or truncate made by a
--       CPA login, with or without two-step, whatever function or policy the write comes through. A function added later
--       that forgets its role check still cannot write for the CPA. scripts/test-cpa.mjs loops over every table and every
--       function, so a new table without the trigger fails the tests.
--     * Storage: the CPA opens files in the board bucket (problem report files excepted) and can upload, change or remove nothing.
--   Not for the CPA: Problem Reports (the Treasurer's), team logins and invites, the Calendar, and sign-in history.
--   The one table left writable is seen_tips: the CPA's own "tip already shown" marks, so first-visit tips stop reappearing.

-- ---------------------------------------------------------------- who is the CPA

-- The CPA, signed in with two-step: reads the books.
create or replace function public.is_cpa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() = 'cpa', false);
$$;

-- A CPA login at any sign-in level: refused every write.
create or replace function public.is_cpa_login()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.portal_access a where a.user_id = auth.uid() and a.role = 'cpa');
$$;

-- Board side or CPA, with two-step: may read the books.
create or replace function public.can_read_books()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_board() or public.is_cpa();
$$;

-- ---------------------------------------------------------------- read

do $$
declare t text;
begin
  foreach t in array array['settings','teams','funds','board_members','grants','donors','donations','meetings','meeting_votes',
                           'team_requests','ledger','receipts','accounts','documents','request_approvals','bank_statements',
                           'bank_lines','zeffy_skip','zeffy_sync_log','request_refunds','receipt_reminders','money_overrides'] loop
    execute format('create policy cpa_read on public.%I for select to authenticated using ((select public.is_cpa()))', t);
  end loop;
end $$;

-- History: the CPA sees the log of what it can read. Team logins, invites, the calendar, problem reports and sign-ins stay out.
create policy cpa_log_books_only on public.change_log as restrictive for select to authenticated
  using (not (select public.is_cpa())
         or tbl not in ('team_users','team_invites','calendar_events','problem_reports','sessions','seen_tips',
                        -- board access and board member records carry names, emails and roles
                        'portal_access','board_members'));

-- ---------------------------------------------------------------- never write

create or replace function public.cpa_read_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.is_cpa_login() then
    raise exception 'The CPA login is read only' using errcode = '42501';
  end if;
  return null;
end;
$$;
revoke all on function public.cpa_read_only() from public, anon, authenticated;

do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','p') and c.relname <> 'seen_tips' order by 1 loop
    execute format('create trigger %I before insert or update or delete on public.%I for each statement execute function public.cpa_read_only()',
                   t || '_cpa_read_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cpa_read_only()',
                   t || '_cpa_no_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- files

-- The CPA opens receipts, statements, documents and minutes; problem report files stay the Treasurer's.
create policy cpa_files_select on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and (select public.is_cpa())
         and (storage.foldername(name))[1] is distinct from 'problems');

-- Restrictive, so they narrow every other storage policy: a CPA login never uploads, changes or removes a file.
create policy cpa_files_no_insert on storage.objects as restrictive for insert to authenticated
  with check (not (select public.is_cpa_login()));
create policy cpa_files_no_update on storage.objects as restrictive for update to authenticated
  using (not (select public.is_cpa_login())) with check (not (select public.is_cpa_login()));
create policy cpa_files_no_delete on storage.objects as restrictive for delete to authenticated
  using (not (select public.is_cpa_login()));

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array['public.is_cpa()', 'public.is_cpa_login()', 'public.can_read_books()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


insert into supabase_migrations.schema_migrations (version, name) values ('20261111090000', '0006_requests_v2'), ('20261111090100', '0008_calendar'), ('20261111090200', '0009_problem_reports'), ('20261111090300', '0010_history_areas'), ('20261111090400', '0011_receipts'), ('20261111090500', '0012_cpa');
commit;

select (select string_agg(name, ', ' order by version) from supabase_migrations.schema_migrations) migrations,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('calendar_events','problem_reports','request_refunds','receipt_reminders')) new_tables;
