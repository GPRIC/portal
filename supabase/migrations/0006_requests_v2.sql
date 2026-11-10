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
    perform public.spend_check(r.charge_fund_id, r.amount, v_team, 'Robotics Teams', p_override, 'review', r.id);
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
