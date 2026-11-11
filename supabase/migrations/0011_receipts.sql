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
