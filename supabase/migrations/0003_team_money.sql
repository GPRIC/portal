-- GPRIC Portal Phase 3, team money: request types and approvals, team logins and the Team Portal,
-- bank statements and month locks, the Zeffy connection, and first-visit tips.
-- Board access is unchanged (is_board). Team users never read tables directly: every team screen
-- goes through the security definer functions below, which only ever return the caller's own team.

-- ---------------------------------------------------------------- settings

alter table public.settings
  add column approval_threshold numeric(12,2) not null default 500 check (approval_threshold >= 0),
  add column approvals_under int not null default 1 check (approvals_under between 1 and 3),
  add column approvals_over int not null default 2 check (approvals_over between 1 and 3),
  add column general_fund_id text references public.funds (id) on delete set null;

-- How many board approvals a request needs: up to the threshold, or over it.
create or replace function public.approvals_needed(p_amount numeric)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(p_amount, 0) <= s.approval_threshold then s.approvals_under else s.approvals_over end
    from public.settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------- teams and donors

alter table public.teams add column zeffy_name text;
alter table public.donors add column email text;
create index donors_email_idx on public.donors (lower(email));

-- ---------------------------------------------------------------- requests v2

alter table public.team_requests
  add column type text not null default 'Pre-Approval' check (type in ('Pre-Approval','Reimbursement')),
  add column vendor text,
  add column purchase_date date,
  add column zelle_contact text,
  add column team_ledger_ref text,
  add column receipt_path text,
  add column receipt_name text,
  add column certified boolean not null default false,
  add column submitted_by_user uuid references auth.users (id) on delete set null,
  add column requestor_name text,
  add column requestor_email text,
  add column requestor_member_id text references public.board_members (id) on delete set null,
  add column pay_method text check (pay_method in ('Zelle','Check','Debit Card','ACH')),
  add column pay_ref text,
  add column declined_by text,
  add column declined_at timestamptz;
create index requests_requestor_member_idx on public.team_requests (requestor_member_id);
create index requests_submitted_by_idx on public.team_requests (submitted_by_user);

alter table public.ledger
  add column pay_method text,
  add column pay_ref text;

create table public.request_approvals (
  id bigint generated always as identity primary key,
  request_id text not null references public.team_requests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  member_id text references public.board_members (id) on delete set null,
  approver_name text not null,
  approved_at timestamptz not null default now(),
  sample boolean not null default false,
  unique (request_id, user_id)
);
create index approvals_request_idx on public.request_approvals (request_id);
create index approvals_member_idx on public.request_approvals (member_id);

-- The board member row for the signed-in person (matched by email), if any.
create or replace function public.my_member_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from public.board_members m
   where m.email is not null and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
   order by m.active desc, m.sort limit 1;
$$;

-- ---------------------------------------------------------------- team logins

-- A coach or treasurer who signs in to see one team. Never board.
create table public.team_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  team_id text not null references public.teams (id) on delete cascade,
  role text not null default 'Coach' check (role in ('Coach','Treasurer')),
  name text,
  email text,
  zelle_contact text,
  added_at timestamptz not null default now()
);
create index team_users_team_idx on public.team_users (team_id);

-- The board sends a team login invite: this row says which team the invited email belongs to.
create table public.team_invites (
  id bigint generated always as identity primary key,
  team_id text not null references public.teams (id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'Coach' check (role in ('Coach','Treasurer')),
  invited_by text,
  invited_at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  sample boolean not null default false
);
create index team_invites_email_idx on public.team_invites (lower(email));
create index team_invites_team_idx on public.team_invites (team_id);

-- Replaces the v1 trigger: an invite for an email with a pending team invite makes a team login,
-- anything else a board login. A person already in one group never moves to the other here.
create or replace function public.grant_portal_access_on_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare inv public.team_invites%rowtype;
begin
  if new.invited_at is null then return new; end if;
  if exists (select 1 from public.portal_access a where a.user_id = new.id) then
    update public.portal_access set email = new.email where user_id = new.id;
    return new;
  end if;
  if exists (select 1 from public.team_users u where u.user_id = new.id) then
    update public.team_users set email = new.email where user_id = new.id;
    return new;
  end if;
  select * into inv from public.team_invites i
   where lower(i.email) = lower(new.email) and (i.user_id is null or i.user_id = new.id)
   order by i.invited_at desc limit 1;
  if inv.id is not null then
    insert into public.team_users (user_id, team_id, role, name, email)
    values (new.id, inv.team_id, inv.role, inv.name, new.email)
    on conflict (user_id) do nothing;
    update public.team_invites set user_id = new.id where id = inv.id;
    return new;
  end if;
  insert into public.portal_access (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;
revoke all on function public.grant_portal_access_on_invite() from public, anon, authenticated;

-- The team of the signed-in team user, only with two-step done; null for everyone else.
create or replace function public.my_team()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.team_id from public.team_users u
   where u.user_id = auth.uid() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- Which side of the portal the signed-in person belongs to: 'board', 'team' or null.
create or replace function public.whoami()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_board() then 'board' when public.my_team() is not null then 'team' end;
$$;

-- ---------------------------------------------------------------- first-visit tips

create table public.seen_tips (
  user_id uuid not null references auth.users (id) on delete cascade,
  tip_key text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, tip_key)
);

-- ---------------------------------------------------------------- bank statements

create sequence public.statement_id_seq;
create sequence public.bank_line_id_seq;

create table public.bank_statements (
  id text primary key default public.pad_id('BS-', nextval('public.statement_id_seq'), 2),
  month date not null unique check (extract(day from month) = 1),
  file_path text,
  file_name text,
  ending_balance numeric(12,2),
  difference numeric(12,2),
  locked_at timestamptz,
  locked_by text,
  notes text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.bank_lines (
  id text primary key default public.pad_id('BL-', nextval('public.bank_line_id_seq'), 4),
  statement_id text not null references public.bank_statements (id) on delete cascade,
  date date not null,
  description text,
  amount numeric(12,2) not null,
  matched_ledger_id text references public.ledger (id) on delete set null,
  -- A Zeffy payout deposit matches the gifts paid out that day, not one ledger row.
  matched_payout_date date,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);
create index bank_lines_statement_idx on public.bank_lines (statement_id);
create index bank_lines_ledger_idx on public.bank_lines (matched_ledger_id);

-- A reconciled month is locked: its ledger rows cannot be added, changed or removed.
-- A fix goes in as a visible correction dated in an open month.
create or replace function public.ledger_month_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare m date;
begin
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
create trigger ledger_month_lock
  before insert or update or delete on public.ledger
  for each row execute function public.ledger_month_lock();

-- Lock a month once the difference is zero. There is no unlock.
-- Bank ending balance less what the books say the bank should show at month end:
-- book balance, plus money out no bank line has cleared, less Zeffy gifts still in transit. Mirrors calc.reconcile().
create or replace function public.bank_month_difference(p_statement_id text, p_ending numeric)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_end date;
  v_book numeric; v_out numeric; v_transit numeric;
begin
  perform public.require_board();
  select (s.month + interval '1 month' - interval '1 day')::date into v_end from public.bank_statements s where s.id = p_statement_id;
  if v_end is null then raise exception 'Statement not found'; end if;
  select coalesce(sum(case when l.dir = 'in' then l.amount else -l.amount end), 0) into v_book from public.ledger l where l.date <= v_end;
  select coalesce(sum(l.amount), 0) into v_out from public.ledger l
   where l.date <= v_end and l.dir = 'out' and coalesce(l.source, '') <> 'Opening Balance'
     and not exists (select 1 from public.bank_lines b where b.matched_ledger_id = l.id)
     and not exists (select 1 from public.donations d join public.bank_lines b on b.matched_payout_date = d.payout_date
                      where d.id = l.donation_id);
  select coalesce(sum(d.amount), 0) into v_transit from public.donations d
   where d.channel = 'Zeffy' and d.date <= v_end and (d.payout_date is null or d.payout_date > v_end);
  return round(p_ending - (v_book + v_out - v_transit), 2);
end;
$$;

-- Locks a month only when the difference, worked out here rather than taken from the page, is $0.00.
-- p_difference is the page's own figure, kept for the call shape; it is not trusted.
create or replace function public.lock_bank_month(p_statement_id text, p_ending numeric, p_difference numeric default null)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare v timestamptz := now(); v_diff numeric;
begin
  perform public.require_board();
  if p_ending is null then raise exception 'Enter the statement ending balance'; end if;
  v_diff := public.bank_month_difference(p_statement_id, p_ending);
  if abs(v_diff) >= 0.005 then
    raise exception 'The month can be reconciled only when the difference is $0.00 (it is %)', v_diff;
  end if;
  update public.bank_statements
     set ending_balance = round(p_ending, 2), difference = 0, locked_at = v,
         locked_by = coalesce(auth.jwt() ->> 'email', 'board')
   where id = p_statement_id and locked_at is null;
  if not found then raise exception 'Statement not found or already reconciled'; end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------- zeffy

alter table public.donations
  add column zeffy_id text unique,
  add column zeffy_key text unique,
  add column payout_date date,
  add column zeffy_status text,
  add column zeffy_method text,
  add column fund_raw text,
  add column unassigned boolean not null default false,
  add column refunded numeric(12,2) not null default 0 check (refunded >= 0);

-- Zeffy rows never imported as gifts (such as a grant cheque held by another body, which is never cash).
-- The rows themselves are real payment data, so they are loaded from the private load file, never from this repository.
create table public.zeffy_skip (
  zeffy_key text primary key,
  reason text not null,
  added_at timestamptz not null default now()
);

create table public.zeffy_sync_log (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  source text not null check (source in ('api','file','webhook')),
  inserted int not null default 0,
  updated int not null default 0,
  skipped int not null default 0,
  error text
);

-- The one way Zeffy payments enter the portal, from the file import, the scheduled sync or the webhook.
-- Each row: {id (API only), key, date, amount, method, status, payout_date, refund, recurring, fund, first, last, email, company}.
-- key is date|HH:MM|amount|last name (lower case), built by src/lib/zeffy.ts; the export file has no payment id,
-- so a gift first seen in a file is matched by key and gains its Zeffy id on the first API pull. A known gift only refreshes
-- payout, status and refund, so the board's fund choices are kept. A blank or unknown Fund goes to the
-- general fund marked unassigned. Runs for a board user or the server's service role.
create or replace function public.zeffy_upsert(p_rows jsonb, p_source text default 'file')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_key text; v_amount numeric; v_date date; v_fund text; v_unassigned boolean; v_name text;
  v_donor text; v_don text; v_status text; v_payout date; v_refund numeric; v_raw text; v_zid text;
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
    if v_fund is null then
      v_fund := s.general_fund_id;
      if v_raw is not null and lower(v_raw) not in ('general fund', 'general', 'gpric general') then v_unassigned := true; end if;
    end if;
    if v_fund is null then raise exception 'Set the general fund in settings before importing Zeffy gifts'; end if;
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
      values (v_name, 'Individual', case when coalesce(r ->> 'recurring', '') <> '' then 'Monthly' else 'One-Time' end,
              'Zeffy', v_date, nullif(trim(r ->> 'email'), ''), nullif(trim(r ->> 'company'), ''))
      returning id into v_donor;
    end if;
    insert into public.donations (donor_id, date, amount, fund_id, channel, recurring, thanked,
                                  zeffy_id, zeffy_key, payout_date, zeffy_status, zeffy_method, fund_raw, unassigned, refunded)
    values (v_donor, v_date, v_amount, v_fund, 'Zeffy', coalesce(r ->> 'recurring', '') <> '', false,
            v_zid, v_key, v_payout, v_status, nullif(trim(r ->> 'method'), ''), v_raw, v_unassigned, v_refund)
    returning id into v_don;
    insert into public.ledger (date, dir, amount, fund_id, source, donor_id, memo, donation_id, receipt)
    values (v_date, 'in', v_amount, v_fund, 'Individual Donors', v_donor,
            case when coalesce(r ->> 'recurring', '') <> '' then 'Zeffy monthly gift' else 'Zeffy gift' end, v_don, true);
    n_ins := n_ins + 1;
  end loop;
  insert into public.zeffy_sync_log (source, inserted, updated, skipped)
  values (coalesce(p_source, 'file'), n_ins, n_upd, n_skip);
  return jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'skipped', n_skip);
end;
$$;

-- ---------------------------------------------------------------- request actions (board)

-- One board approval. The requestor never approves their own request, and each member approves once.
-- Security definer because approvals are written only here (the table refuses direct inserts).
create or replace function public.approve_request(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_member text := public.my_member_id();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_name text;
  v_have int; v_need int;
begin
  perform public.require_board();
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status not in ('Submitted', 'Board Vote') then raise exception 'This request is not waiting for approval'; end if;
  if r.submitted_by_user = auth.uid() or (v_member is not null and r.requestor_member_id = v_member)
     or (v_email <> '' and lower(coalesce(r.requestor_email, '')) = v_email) then
    raise exception 'You made this request, so another board member has to approve it';
  end if;
  if exists (select 1 from public.request_approvals a where a.request_id = r.id
             and (a.user_id = auth.uid() or (v_member is not null and a.member_id = v_member))) then
    raise exception 'You have already approved this request';
  end if;
  select coalesce(m.name, v_email) into v_name from (select 1) x left join public.board_members m on m.id = v_member;
  insert into public.request_approvals (request_id, user_id, member_id, approver_name, sample)
  values (r.id, auth.uid(), v_member, coalesce(nullif(v_name, ''), 'Board member'), r.sample);
  select count(*) into v_have from public.request_approvals where request_id = r.id;
  v_need := public.approvals_needed(r.amount);
  if v_have >= v_need then
    update public.team_requests set status = 'Approved', decline_reason = null where id = r.id;
  end if;
  return jsonb_build_object('approvals', v_have, 'needed', v_need, 'status', case when v_have >= v_need then 'Approved' else r.status end);
end;
$$;

create or replace function public.decline_request(p_request_id text, p_reason text)
returns text
language plpgsql
set search_path = ''
as $$
declare v_member text := public.my_member_id();
begin
  perform public.require_board();
  if nullif(trim(p_reason), '') is null then raise exception 'Give the team a reason for declining'; end if;
  update public.team_requests
     set status = 'Declined', decline_reason = trim(p_reason), declined_at = now(),
         declined_by = coalesce((select name from public.board_members where id = v_member), auth.jwt() ->> 'email')
   where id = p_request_id and status in ('Submitted', 'Board Vote', 'Approved');
  if not found then raise exception 'Only a request that is not yet paid can be declined'; end if;
  return 'Declined';
end;
$$;

-- v2 payment: method and confirmation recorded on the request and its ledger row.
-- A pre-approval starts the receipt clock (Receipts Due); a reimbursement already has its receipt (Paid).
drop function public.mark_request_paid(text, date);
create or replace function public.mark_request_paid(p_request_id text, p_date date, p_method text, p_ref text default null)
returns text
language plpgsql
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  t public.teams%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_led text;
begin
  perform public.require_board();
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'Approved' then raise exception 'Only an approved request can be paid'; end if;
  if p_method is null or p_method not in ('Zelle','Check','Debit Card','ACH') then raise exception 'Pick how it was paid'; end if;
  select * into t from public.teams where id = r.team_id;
  if t.fund_id is null then raise exception 'This team has no fund; set one on the team first'; end if;
  insert into public.ledger (date, dir, amount, fund_id, category, party, memo, request_id, receipt,
                             receipt_path, receipt_name, pay_method, pay_ref, sample)
  values (v_date, 'out', r.amount, t.fund_id, 'Robotics Teams',
          case when r.type = 'Reimbursement' then coalesce(r.requestor_name, t.short)
               when r.pay_to ilike 'School%' then coalesce(t.school, t.short) || ' (district)'
               when r.pay_to ilike 'Vendor%' then coalesce(r.vendor, 'Vendor')
               when r.pay_to ilike 'Me%' then coalesce(r.requestor_name, t.short)
               else t.short || ' team account' end,
          r.id || ' · ' || coalesce(r.category || ' · ', '') || r.purpose, r.id, r.receipt_path is not null,
          r.receipt_path, r.receipt_name, p_method, nullif(trim(p_ref), ''), r.sample)
  returning id into v_led;
  update public.team_requests
     set status = case when r.type = 'Reimbursement' then 'Paid' else 'Receipts Due' end,
         paid_date = v_date, pay_method = p_method, pay_ref = nullif(trim(p_ref), '')
   where id = r.id;
  return v_led;
end;
$$;

-- ---------------------------------------------------------------- team money figures

-- One team's money by kind. The same rules as Calc.teamBalances in src/lib/calc.ts:
-- carry-over = 'Opening Balance' money in; Zeffy = money in from a Zeffy gift; deposits = other money in;
-- reimbursements = money out for a request; direct expenses = other money out.
create or replace function public.team_money(p_team_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select fund_id from public.teams where id = p_team_id),
  l as (
    select l.dir, l.amount, l.source, l.request_id, d.channel
      from public.ledger l join t on l.fund_id = t.fund_id
      left join public.donations d on d.id = l.donation_id
  )
  select jsonb_build_object(
    'carry',   coalesce(sum(amount) filter (where dir = 'in' and source = 'Opening Balance'), 0),
    'zeffy',   coalesce(sum(amount) filter (where dir = 'in' and coalesce(source, '') <> 'Opening Balance' and channel = 'Zeffy'), 0),
    'deposits',coalesce(sum(amount) filter (where dir = 'in' and coalesce(source, '') <> 'Opening Balance' and channel is distinct from 'Zeffy'), 0),
    'reimbursements', coalesce(sum(amount) filter (where dir = 'out' and request_id is not null), 0),
    'direct',  coalesce(sum(amount) filter (where dir = 'out' and request_id is null), 0),
    'balance', coalesce(sum(case when dir = 'in' then amount else -amount end), 0))
  from l;
$$;
revoke all on function public.team_money(text) from public, anon, authenticated;

-- A team's open pre-approvals past the receipt window block new requests.
create or replace function public.team_overdue(p_team_id text)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.team_requests r, public.settings s
   where s.id = 1 and r.team_id = p_team_id and r.status = 'Receipts Due'
     and r.paid_date is not null and r.paid_date + s.receipt_days < current_date;
$$;
revoke all on function public.team_overdue(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- team portal (team users)

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
        'receipts', (select count(*) from public.receipts c where c.request_id = r.id),
        'receipts_total', (select coalesce(sum(c.amount), 0) from public.receipts c where c.request_id = r.id)
      ) order by coalesce(r.submitted, r.created_at::date) desc, r.id desc)
      from public.team_requests r where r.team_id = v_team and r.status <> 'Draft'), '[]'::jsonb),
    'gifts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'date', d.date, 'amount', d.amount,
        'donor', case when o.anonymous then 'Anonymous' else o.name end,
        'in_transit', d.channel = 'Zeffy' and (d.payout_date is null or d.payout_date > current_date)
      ) order by d.date desc, d.id desc)
      from public.donations d join public.donors o on o.id = d.donor_id
      where d.fund_id = t.fund_id and t.fund_id is not null), '[]'::jsonb));
end;
$$;

-- A team user's new request. Blocked while the team has receipts past due.
-- p: {type, purpose, category, amount, needed_by, pay_to, purchase_date, vendor, zelle_contact,
--     team_ledger_ref, receipt_path, receipt_name, certified}
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
  v_id text;
  n int;
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  n := public.team_overdue(v_team);
  if n > 0 then
    raise exception 'New requests are paused: % paid request% past the receipt deadline. Add those receipts first.',
      n, case when n = 1 then ' is' else 's are' end;
  end if;
  if v_type not in ('Pre-Approval', 'Reimbursement') then raise exception 'Choose Pre-Approval or Reimbursement'; end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if coalesce((p ->> 'certified')::boolean, false) is not true then raise exception 'Tick the certification to submit'; end if;
  if v_type = 'Reimbursement' then
    if v_path is null then raise exception 'Attach the receipt'; end if;
    if nullif(trim(p ->> 'zelle_contact'), '') is null then raise exception 'Add the Zelle contact to pay you'; end if;
  end if;
  if v_path is not null and v_path not like 'team/' || v_team || '/%' then raise exception 'Receipt file is not in this team''s folder'; end if;
  select * into u from public.team_users where user_id = auth.uid();
  insert into public.team_requests (team_id, type, purpose, category, amount, pay_to, needed_by, purchase_date, vendor,
    zelle_contact, team_ledger_ref, receipt_path, receipt_name, certified, submitted, status,
    submitted_by_user, requestor_name, requestor_email, requestor_member_id, created_by)
  values (v_team, v_type,
    coalesce(nullif(trim(p ->> 'purpose'), ''), case when v_type = 'Reimbursement' then coalesce(nullif(trim(p ->> 'vendor'), ''), 'Reimbursement') end),
    nullif(trim(p ->> 'category'), ''), v_amount,
    case when v_type = 'Reimbursement' then 'Me by Zelle' else nullif(trim(p ->> 'pay_to'), '') end,
    nullif(p ->> 'needed_by', '')::date, nullif(p ->> 'purchase_date', '')::date, nullif(trim(p ->> 'vendor'), ''),
    nullif(trim(p ->> 'zelle_contact'), ''), nullif(trim(p ->> 'team_ledger_ref'), ''), v_path, nullif(trim(p ->> 'receipt_name'), ''),
    true, current_date, 'Submitted', auth.uid(), coalesce(u.name, u.email), u.email,
    (select m.id from public.board_members m where m.email is not null and lower(m.email) = lower(u.email) order by m.sort limit 1),
    coalesce(u.name, u.email))
  returning id into v_id;
  if v_type = 'Reimbursement' then
    insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by)
    values (v_id, nullif(trim(p ->> 'vendor'), ''), v_amount, coalesce(nullif(p ->> 'purchase_date', '')::date, current_date),
            nullif(trim(p ->> 'receipt_name'), ''), v_path, coalesce(u.name, u.email));
  end if;
  return v_id;
end;
$$;

-- A team user adds a receipt to one of their own paid pre-approvals.
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
  v_id text;
begin
  if v_team is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_requests r where r.id = p_request_id and r.team_id = v_team and r.status = 'Receipts Due') then
    raise exception 'Receipts can be added only to your team''s paid pre-approvals';
  end if;
  if p_file_path is null or p_file_path not like 'team/' || v_team || '/%' then raise exception 'Attach the receipt file'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the receipt amount'; end if;
  select * into u from public.team_users where user_id = auth.uid();
  insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by)
  values (p_request_id, nullif(trim(p_vendor), ''), round(p_amount, 2), coalesce(p_date, current_date), p_file_name, p_file_path,
          coalesce(u.name, u.email))
  returning id into v_id;
  return v_id;
end;
$$;

-- A team user's own name and Zelle contact.
create or replace function public.update_my_profile(p_name text, p_zelle text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.my_team() is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  update public.team_users set name = nullif(trim(p_name), ''), zelle_contact = nullif(trim(p_zelle), '') where user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------- clear sample data (adds the new tables)

create or replace function public.clear_sample_data()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  n int;
begin
  perform public.require_board();
  delete from public.bank_lines where sample; get diagnostics n = row_count; v := v || jsonb_build_object('bank_lines', n);
  delete from public.bank_statements s where s.sample and not exists (select 1 from public.bank_lines x where x.statement_id = s.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('statements', n);
  delete from public.request_approvals where sample; get diagnostics n = row_count; v := v || jsonb_build_object('approvals', n);
  delete from public.team_invites where sample; get diagnostics n = row_count; v := v || jsonb_build_object('invites', n);
  delete from public.receipts where sample; get diagnostics n = row_count; v := v || jsonb_build_object('receipts', n);
  delete from public.ledger where sample; get diagnostics n = row_count; v := v || jsonb_build_object('ledger', n);
  delete from public.donations where sample; get diagnostics n = row_count; v := v || jsonb_build_object('donations', n);
  delete from public.meeting_votes where sample; get diagnostics n = row_count; v := v || jsonb_build_object('votes', n);
  delete from public.team_requests r where r.sample and not exists (select 1 from public.request_approvals x where x.request_id = r.id);
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
    and not exists (select 1 from public.settings x where x.general_fund_id = f.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('funds', n);
  update public.funds set sample = false where sample;
  return v;
end;
$$;

-- ---------------------------------------------------------------- row security and grants

do $$
declare t text;
begin
  foreach t in array array['request_approvals','team_users','team_invites','bank_statements','bank_lines','zeffy_skip','zeffy_sync_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy board_only on public.%I for all to authenticated using ((select public.is_board())) with check ((select public.is_board()))', t);
  end loop;
end $$;
-- Approvals are written only by approve_request; the board reads them.
revoke insert, update on public.request_approvals from authenticated;
revoke insert, update, delete on public.zeffy_sync_log from authenticated;

-- A team user sees only their own login row (the Team Portal reads everything else through team_portal()).
create policy own_row on public.team_users for select to authenticated using (user_id = (select auth.uid()));

alter table public.seen_tips enable row level security;
revoke all on public.seen_tips from anon, authenticated;
grant select, insert, delete on public.seen_tips to authenticated;
create policy own_tips on public.seen_tips for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant usage on sequence public.statement_id_seq, public.bank_line_id_seq to authenticated;
revoke all on sequence public.statement_id_seq, public.bank_line_id_seq from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'public.approvals_needed(numeric)', 'public.my_member_id()', 'public.my_team()', 'public.whoami()',
    'public.bank_month_difference(text,numeric)', 'public.lock_bank_month(text,numeric,numeric)', 'public.zeffy_upsert(jsonb,text)',
    'public.approve_request(text)', 'public.decline_request(text,text)', 'public.mark_request_paid(text,date,text,text)',
    'public.team_portal()', 'public.submit_team_request(jsonb)',
    'public.add_team_receipt(text,text,numeric,date,text,text)', 'public.update_my_profile(text,text)',
    'public.clear_sample_data()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  revoke all on function public.ledger_month_lock() from public, anon, authenticated;
end $$;
grant execute on function public.zeffy_upsert(jsonb, text) to service_role;

-- ---------------------------------------------------------------- team files

-- Team users upload receipts under team/<their team id>/ in the board's bucket and can read them back.
-- The board's own policies already cover the whole bucket.
create policy team_files_select on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and (storage.foldername(name))[1] = 'team'
         and (storage.foldername(name))[2] = (select public.my_team()));
create policy team_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'board-files' and (storage.foldername(name))[1] = 'team'
              and (storage.foldername(name))[2] = (select public.my_team()));
