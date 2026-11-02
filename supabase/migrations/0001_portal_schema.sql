-- GPRIC Portal v1: tables, row security, actions and the board-only file bucket.
-- Only invited board members who have finished authenticator two-step (aal2) can read or change anything.
-- Every table carries a `sample` flag so the demo rows can be cleared in one step.

-- ---------------------------------------------------------------- access

-- Who may use the portal. A row is added automatically when someone is invited
-- through Supabase Auth (Invite User). Removing a person = delete their auth user.
create table public.portal_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  added_at timestamptz not null default now()
);
alter table public.portal_access enable row level security;
revoke all on public.portal_access from anon, authenticated;

create or replace function public.grant_portal_access_on_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.invited_at is not null then
    insert into public.portal_access (user_id, email)
    values (new.id, new.email)
    on conflict (user_id) do update set email = excluded.email;
  end if;
  return new;
end;
$$;
revoke all on function public.grant_portal_access_on_invite() from public, anon, authenticated;

create trigger on_auth_user_invited
  after insert or update of invited_at, email on auth.users
  for each row execute function public.grant_portal_access_on_invite();

-- Anyone already invited before this migration.
insert into public.portal_access (user_id, email)
select id, email from auth.users where invited_at is not null
on conflict (user_id) do nothing;

-- True only for an invited person signed in with two-step done.
create or replace function public.is_board()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.portal_access a where a.user_id = auth.uid());
$$;
revoke all on function public.is_board() from public, anon;
grant execute on function public.is_board() to authenticated;

-- ---------------------------------------------------------------- ids

-- Readable ids like the demo (L-0001, R-1038). Never truncates past the width.
create or replace function public.pad_id(prefix text, n bigint, width int)
returns text
language sql
immutable
set search_path = ''
as $$
  select prefix || case when length(n::text) >= width then n::text else lpad(n::text, width, '0') end;
$$;
revoke all on function public.pad_id(text, bigint, int) from public, anon;
grant execute on function public.pad_id(text, bigint, int) to authenticated;

create sequence public.team_id_seq;
create sequence public.fund_id_seq;
create sequence public.member_id_seq;
create sequence public.grant_id_seq;
create sequence public.donor_id_seq;
create sequence public.donation_id_seq;
create sequence public.ledger_id_seq;
create sequence public.request_id_seq start 1001;
create sequence public.receipt_id_seq;
create sequence public.meeting_id_seq;
create sequence public.vote_id_seq;
create sequence public.account_id_seq;
create sequence public.document_id_seq;

-- ---------------------------------------------------------------- tables

create table public.settings (
  id int primary key default 1 check (id = 1),
  org text not null default 'Grosse Pointe Robotics And Innovation Center',
  short text not null default 'GPRIC',
  ein text,
  fy_start date not null default '2026-07-01',
  fy_label text not null default 'FY 2026–27',
  receipt_days int not null default 60 check (receipt_days > 0)
);

create table public.teams (
  id text primary key default public.pad_id('T-', nextval('public.team_id_seq'), 1),
  name text not null,
  short text not null,
  program text,
  level text,
  season text,
  fund_id text,
  pay_mode text,
  ein text,
  school text,
  students int,
  affiliated date,
  blurb text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.funds (
  id text primary key default public.pad_id('F-', nextval('public.fund_id_seq'), 3),
  name text not null,
  restricted boolean not null default false,
  team_id text,
  purpose text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.teams add constraint teams_fund_fk
  foreign key (fund_id) references public.funds (id) on delete set null deferrable initially deferred;
alter table public.funds add constraint funds_team_fk
  foreign key (team_id) references public.teams (id) on delete set null deferrable initially deferred;

create table public.board_members (
  id text primary key default public.pad_id('U-B', nextval('public.member_id_seq'), 1),
  name text not null,
  title text not null,
  email text,
  interest_team_id text references public.teams (id) on delete set null,
  interest_note text,
  active boolean not null default true,
  sort int not null default 100,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.grants (
  id text primary key default public.pad_id('G-', nextval('public.grant_id_seq'), 2),
  funder text not null,
  program text not null default 'General',
  ask numeric(12,2) not null default 0 check (ask >= 0),
  awarded numeric(12,2) not null default 0 check (awarded >= 0),
  received numeric(12,2) not null default 0 check (received >= 0),
  status text not null default 'Prospect' check (status in ('Prospect','Drafting','Applied','Awarded','Declined')),
  deadline date,
  applied_as text,
  owner text,
  board_saw date,
  fund_id text references public.funds (id) on delete set null,
  purpose text,
  public boolean not null default false,
  likelihood numeric(4,3) not null default 0.3 check (likelihood between 0 and 1),
  notes text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.donors (
  id text primary key default public.pad_id('DN-', nextval('public.donor_id_seq'), 2),
  name text not null,
  type text not null default 'Individual' check (type in ('Individual','Family Foundation','Corporate Sponsor','Grantmaker')),
  giving text,
  channel text,
  anonymous boolean not null default false,
  public boolean not null default false,
  since date,
  grant_id text references public.grants (id) on delete set null,
  notes text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.donations (
  id text primary key default public.pad_id('DO-', nextval('public.donation_id_seq'), 3),
  donor_id text not null references public.donors (id) on delete cascade,
  date date not null,
  amount numeric(12,2) not null check (amount > 0),
  fund_id text not null references public.funds (id) on delete restrict,
  channel text,
  recurring boolean not null default false,
  grant_id text references public.grants (id) on delete set null,
  thanked boolean not null default false,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.meetings (
  id text primary key default public.pad_id('M-', nextval('public.meeting_id_seq'), 2),
  date date not null,
  kind text not null default 'Regular' check (kind in ('Regular','Special','Annual','Email Vote')),
  title text not null,
  status text not null default 'Scheduled' check (status in ('Scheduled','Minutes Draft','Minutes Approved')),
  present text[] not null default '{}',
  summary text,
  agenda_link text,
  agenda_path text,
  agenda_name text,
  minutes_link text,
  minutes_path text,
  minutes_name text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.team_requests (
  id text primary key default public.pad_id('R-', nextval('public.request_id_seq'), 4),
  team_id text not null references public.teams (id) on delete restrict,
  purpose text not null,
  category text,
  amount numeric(12,2) not null check (amount > 0),
  pay_to text,
  needed_by date,
  submitted date,
  status text not null default 'Submitted' check (status in ('Draft','Submitted','Board Vote','Approved','Declined','Paid','Receipts Due','Closed')),
  interested_member_id text references public.board_members (id) on delete set null,
  vote_id text,
  paid_date date,
  receipts_done date,
  returned numeric(12,2) not null default 0 check (returned >= 0),
  decline_reason text,
  created_by text,
  notes text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.meeting_votes (
  id text primary key default public.pad_id('V-', nextval('public.vote_id_seq'), 3),
  meeting_id text not null references public.meetings (id) on delete cascade,
  item text not null,
  request_id text references public.team_requests (id) on delete set null deferrable initially deferred,
  result text not null check (result in ('Approved','Declined')),
  yes int not null default 0 check (yes >= 0),
  no int not null default 0 check (no >= 0),
  abstain int not null default 0 check (abstain >= 0),
  stepped_out text[] not null default '{}',
  ballots jsonb,
  note text,
  sort int not null default 100,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.team_requests add constraint team_requests_vote_fk
  foreign key (vote_id) references public.meeting_votes (id) on delete set null deferrable initially deferred;

create table public.ledger (
  id text primary key default public.pad_id('L-', nextval('public.ledger_id_seq'), 4),
  date date not null,
  dir text not null check (dir in ('in','out')),
  amount numeric(12,2) not null check (amount > 0),
  fund_id text not null references public.funds (id) on delete restrict,
  source text,
  category text,
  party text,
  donor_id text references public.donors (id) on delete set null,
  memo text,
  donation_id text references public.donations (id) on delete cascade,
  request_id text references public.team_requests (id) on delete set null,
  grant_id text references public.grants (id) on delete set null,
  receipt boolean not null default false,
  receipt_path text,
  receipt_name text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.receipts (
  id text primary key default public.pad_id('RC-', nextval('public.receipt_id_seq'), 3),
  request_id text not null references public.team_requests (id) on delete cascade,
  vendor text,
  amount numeric(12,2) not null check (amount >= 0),
  date date not null,
  file_name text,
  file_path text,
  uploaded_by text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.accounts (
  id text primary key default public.pad_id('A-', nextval('public.account_id_seq'), 2),
  service text not null,
  purpose text,
  owner_email text,
  admins text[] not null default '{}',
  plan text,
  cost numeric(10,2) not null default 0 check (cost >= 0),
  period text not null default 'Month' check (period in ('Month','Year','None')),
  renewal date,
  payment_method text,
  discount text,
  status text not null default 'Active',
  notes text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.documents (
  id text primary key default public.pad_id('DC-', nextval('public.document_id_seq'), 2),
  title text not null,
  type text not null check (type in ('Formation','IRS','State','Policy','Contract','Grant','Board','Finance')),
  date date,
  linked_to text,
  public boolean not null default false,
  link text,
  file_path text,
  file_name text,
  added_by text,
  notes text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create index ledger_fund_idx on public.ledger (fund_id);
create index ledger_donation_idx on public.ledger (donation_id);
create index ledger_request_idx on public.ledger (request_id);
create index ledger_grant_idx on public.ledger (grant_id);
create index ledger_donor_idx on public.ledger (donor_id);
create index donations_donor_idx on public.donations (donor_id);
create index donations_fund_idx on public.donations (fund_id);
create index donations_grant_idx on public.donations (grant_id);
create index requests_team_idx on public.team_requests (team_id);
create index requests_vote_idx on public.team_requests (vote_id);
create index requests_member_idx on public.team_requests (interested_member_id);
create index receipts_request_idx on public.receipts (request_id);
create index votes_meeting_idx on public.meeting_votes (meeting_id);
create index votes_request_idx on public.meeting_votes (request_id);
create index grants_fund_idx on public.grants (fund_id);
create index donors_grant_idx on public.donors (grant_id);
create index members_team_idx on public.board_members (interest_team_id);
create index teams_fund_idx on public.teams (fund_id);
create index funds_team_idx on public.funds (team_id);

-- ---------------------------------------------------------------- row security

do $$
declare t text;
begin
  foreach t in array array['settings','teams','funds','board_members','grants','donors','donations','meetings',
                           'team_requests','meeting_votes','ledger','receipts','accounts','documents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy board_only on public.%I for all to authenticated using ((select public.is_board())) with check ((select public.is_board()))', t);
  end loop;
end $$;

grant usage on sequence public.team_id_seq, public.fund_id_seq, public.member_id_seq, public.grant_id_seq,
  public.donor_id_seq, public.donation_id_seq, public.ledger_id_seq, public.request_id_seq, public.receipt_id_seq,
  public.meeting_id_seq, public.vote_id_seq, public.account_id_seq, public.document_id_seq to authenticated;
revoke all on sequence public.team_id_seq, public.fund_id_seq, public.member_id_seq, public.grant_id_seq,
  public.donor_id_seq, public.donation_id_seq, public.ledger_id_seq, public.request_id_seq, public.receipt_id_seq,
  public.meeting_id_seq, public.vote_id_seq, public.account_id_seq, public.document_id_seq from anon;

-- ---------------------------------------------------------------- keep linked rows in step

-- A gift and its money-in ledger row are one fact: editing either updates the other,
-- deleting the ledger row deletes the gift (deleting the gift cascades to the ledger row).
create or replace function public.sync_donation_to_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.ledger
     set amount = new.amount, date = new.date, fund_id = new.fund_id, donor_id = new.donor_id, grant_id = new.grant_id
   where donation_id = new.id;
  return new;
end;
$$;
create trigger donations_sync_ledger
  after update of amount, date, fund_id, donor_id, grant_id on public.donations
  for each row execute function public.sync_donation_to_ledger();

create or replace function public.sync_ledger_to_donation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.donation_id is not null then
    update public.donations
       set amount = new.amount, date = new.date, fund_id = new.fund_id
     where id = new.donation_id;
  end if;
  return new;
end;
$$;
create trigger ledger_sync_donation
  after update of amount, date, fund_id on public.ledger
  for each row execute function public.sync_ledger_to_donation();

create or replace function public.ledger_after_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.donation_id is not null then
    delete from public.donations where id = old.donation_id;
  end if;
  return old;
end;
$$;
create trigger ledger_delete_donation
  after delete on public.ledger
  for each row execute function public.ledger_after_delete();

-- Grant "received" follows the grant's money-in rows when they are edited or deleted.
create or replace function public.ledger_grant_received()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE','DELETE') and old.grant_id is not null and old.dir = 'in' then
    update public.grants set received = greatest(0, received - old.amount) where id = old.grant_id;
  end if;
  if tg_op in ('UPDATE','INSERT') and new.grant_id is not null and new.dir = 'in' then
    update public.grants set received = received + new.amount where id = new.grant_id;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger ledger_grant_received_ins
  after insert on public.ledger
  for each row when (new.grant_id is not null and new.dir = 'in')
  execute function public.ledger_grant_received();
create trigger ledger_grant_received_upd
  after update of amount, grant_id, dir on public.ledger
  for each row execute function public.ledger_grant_received();
create trigger ledger_grant_received_del
  after delete on public.ledger
  for each row when (old.grant_id is not null and old.dir = 'in')
  execute function public.ledger_grant_received();

-- ---------------------------------------------------------------- actions
-- Run as the caller, so row security applies; each also checks is_board() up front.

create or replace function public.require_board()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_board() then
    raise exception 'Board sign-in with two-step is required' using errcode = '42501';
  end if;
end;
$$;

-- Log a gift: finds or creates the donor, writes the donation and its money-in ledger row together.
create or replace function public.log_donation(
  p_donor_id text, p_name text, p_type text, p_amount numeric, p_date date, p_fund_id text,
  p_channel text, p_recurring boolean, p_anonymous boolean, p_public boolean,
  p_grant_id text default null, p_memo text default null)
returns text
language plpgsql
set search_path = ''
as $$
declare
  d public.donors%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_don text;
  v_src text;
begin
  perform public.require_board();
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if p_donor_id is not null then
    select * into d from public.donors where id = p_donor_id;
  end if;
  if d.id is null then
    insert into public.donors (name, type, giving, channel, anonymous, public, since, grant_id)
    values (coalesce(nullif(trim(p_name), ''), 'Anonymous Donor'), coalesce(p_type, 'Individual'),
            case when p_recurring then 'Monthly' when p_type = 'Grantmaker' then 'Grant' else 'One-Time' end,
            coalesce(p_channel, 'Zeffy'), coalesce(p_anonymous, false), coalesce(p_public, false), v_date, p_grant_id)
    returning * into d;
  end if;
  v_src := case d.type when 'Family Foundation' then 'Family Foundations' when 'Corporate Sponsor' then 'Sponsors'
                       when 'Grantmaker' then 'Grants' else 'Individual Donors' end;
  insert into public.donations (donor_id, date, amount, fund_id, channel, recurring, grant_id, thanked)
  values (d.id, v_date, round(p_amount, 2), p_fund_id, coalesce(p_channel, d.channel), coalesce(p_recurring, false), p_grant_id, false)
  returning id into v_don;
  insert into public.ledger (date, dir, amount, fund_id, source, donor_id, memo, donation_id, grant_id, receipt)
  values (v_date, 'in', round(p_amount, 2), p_fund_id, v_src, d.id,
          coalesce(nullif(trim(p_memo), ''), case when p_recurring then 'Zeffy monthly gift' else 'Gift' end),
          v_don, p_grant_id, true);
  return v_don;
end;
$$;

-- A grant payment arrives: it becomes a gift from the funder and a ledger row; received goes up via the ledger trigger.
create or replace function public.grant_received(p_grant_id text, p_amount numeric, p_date date default null)
returns text
language plpgsql
set search_path = ''
as $$
declare
  g public.grants%rowtype;
  v_donor text;
begin
  perform public.require_board();
  select * into g from public.grants where id = p_grant_id;
  if g.id is null then raise exception 'Grant not found'; end if;
  if g.fund_id is null then raise exception 'Pick a fund for this grant first'; end if;
  select id into v_donor from public.donors where grant_id = p_grant_id order by created_at limit 1;
  return public.log_donation(v_donor, g.funder, 'Grantmaker', p_amount, p_date, g.fund_id, 'Grant', false, false,
                             g.public, p_grant_id, 'Grant payment');
end;
$$;

-- Record the board's vote on a team request. Passes when Yes outnumbers No.
-- The vote joins the chosen meeting, or that day's Email Vote (created if there is none).
create or replace function public.record_request_vote(
  p_request_id text, p_ballots jsonb, p_reason text default null, p_date date default null, p_meeting_id text default null)
returns text
language plpgsql
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_meeting text := p_meeting_id;
  v_yes int := 0; v_no int := 0; v_abs int := 0;
  v_out text[] := '{}';
  v_result text;
  v_vote text;
  k text; b text;
begin
  perform public.require_board();
  select * into r from public.team_requests where id = p_request_id;
  if r.id is null then raise exception 'Request not found'; end if;
  for k, b in select key, value #>> '{}' from jsonb_each(coalesce(p_ballots, '{}'::jsonb)) loop
    if b = 'Yes' then v_yes := v_yes + 1;
    elsif b = 'No' then v_no := v_no + 1;
    elsif b = 'Abstain' then v_abs := v_abs + 1;
    else v_out := v_out || k; end if;
  end loop;
  v_result := case when v_yes > v_no then 'Approved' else 'Declined' end;
  if v_meeting is null then
    select id into v_meeting from public.meetings where date = v_date and kind = 'Email Vote' order by created_at limit 1;
  end if;
  if v_meeting is null then
    insert into public.meetings (date, kind, title, status, present, summary, sample)
    values (v_date, 'Email Vote', 'Email Vote, ' || trim(to_char(v_date, 'FMMonth FMDD')), 'Minutes Draft',
            coalesce((select array_agg(id order by sort, id) from public.board_members where active), '{}'),
            'Email vote under bylaws section 4.6.', r.sample)
    returning id into v_meeting;
  end if;
  insert into public.meeting_votes (meeting_id, item, request_id, result, yes, no, abstain, stepped_out, ballots, note, sample)
  values (v_meeting, r.purpose, r.id, v_result, v_yes, v_no, v_abs, v_out, p_ballots, coalesce(p_reason, ''), r.sample)
  returning id into v_vote;
  update public.team_requests
     set status = v_result, vote_id = v_vote,
         decline_reason = case when v_result = 'Declined' then coalesce(nullif(trim(p_reason), ''), 'Declined by board vote.') else null end
   where id = r.id;
  return v_result;
end;
$$;

-- Pay an approved request: money out of the team's fund; the 60-day receipt clock starts.
create or replace function public.mark_request_paid(p_request_id text, p_date date default null)
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
  select * into r from public.team_requests where id = p_request_id;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'Approved' then raise exception 'Only an approved request can be paid'; end if;
  select * into t from public.teams where id = r.team_id;
  if t.fund_id is null then raise exception 'This team has no fund; set one on the team first'; end if;
  insert into public.ledger (date, dir, amount, fund_id, category, party, memo, request_id, receipt, sample)
  values (v_date, 'out', r.amount, t.fund_id, 'Robotics Teams',
          case when r.pay_to = 'School / District' then coalesce(t.school, t.short) || ' (district)' else t.short || ' team account' end,
          r.id || ' · ' || r.purpose, r.id, true, r.sample)
  returning id into v_led;
  update public.team_requests set status = 'Paid', paid_date = v_date where id = r.id;
  return v_led;
end;
$$;

create or replace function public.add_request_receipt(
  p_request_id text, p_vendor text, p_amount numeric, p_date date, p_file_name text, p_file_path text, p_by text)
returns text
language plpgsql
set search_path = ''
as $$
declare v_id text;
begin
  perform public.require_board();
  insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by, sample)
  select r.id, p_vendor, round(coalesce(p_amount, 0), 2), coalesce(p_date, current_date), p_file_name, p_file_path, p_by, r.sample
    from public.team_requests r where r.id = p_request_id
  returning id into v_id;
  if v_id is null then raise exception 'Request not found'; end if;
  update public.team_requests set status = 'Receipts Due' where id = p_request_id and status = 'Paid';
  return v_id;
end;
$$;

-- Receipts are all in: any unspent money goes back into the team's fund and the request closes.
create or replace function public.complete_request_receipts(p_request_id text, p_date date default null)
returns numeric
language plpgsql
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  t public.teams%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_left numeric;
begin
  perform public.require_board();
  select * into r from public.team_requests where id = p_request_id;
  if r.id is null then raise exception 'Request not found'; end if;
  select * into t from public.teams where id = r.team_id;
  v_left := round(r.amount - coalesce((select sum(amount) from public.receipts where request_id = r.id), 0) - coalesce(r.returned, 0), 2);
  if v_left > 0 then
    if t.fund_id is null then raise exception 'This team has no fund; set one on the team first'; end if;
    insert into public.ledger (date, dir, amount, fund_id, source, party, memo, request_id, receipt, sample)
    values (v_date, 'in', v_left, t.fund_id, 'Unspent Returned', t.short, r.id || ' · unspent returned', r.id, true, r.sample);
  end if;
  update public.team_requests
     set status = 'Closed', receipts_done = v_date, returned = round(coalesce(returned, 0) + greatest(0, v_left), 2)
   where id = r.id;
  return v_left;
end;
$$;

-- Remove every sample row. Sample funds, teams, donors, grants and members that real rows
-- now use are kept and become real rows.
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
  delete from public.receipts where sample; get diagnostics n = row_count; v := v || jsonb_build_object('receipts', n);
  delete from public.ledger where sample; get diagnostics n = row_count; v := v || jsonb_build_object('ledger', n);
  delete from public.donations where sample; get diagnostics n = row_count; v := v || jsonb_build_object('donations', n);
  delete from public.meeting_votes where sample; get diagnostics n = row_count; v := v || jsonb_build_object('votes', n);
  delete from public.team_requests where sample; get diagnostics n = row_count; v := v || jsonb_build_object('requests', n);
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
    and not exists (select 1 from public.team_requests x where x.interested_member_id = b.id)
    and not exists (select 1 from public.meetings x where b.id = any(x.present))
    and not exists (select 1 from public.meeting_votes x where x.ballots ? b.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('members', n);
  update public.board_members set sample = false where sample;
  delete from public.teams t where t.sample
    and not exists (select 1 from public.team_requests x where x.team_id = t.id)
    and not exists (select 1 from public.funds x where x.team_id = t.id and not x.sample)
    and not exists (select 1 from public.board_members x where x.interest_team_id = t.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('teams', n);
  update public.teams set sample = false where sample;
  delete from public.funds f where f.sample
    and not exists (select 1 from public.ledger x where x.fund_id = f.id)
    and not exists (select 1 from public.donations x where x.fund_id = f.id)
    and not exists (select 1 from public.grants x where x.fund_id = f.id)
    and not exists (select 1 from public.teams x where x.fund_id = f.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('funds', n);
  update public.funds set sample = false where sample;
  return v;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.require_board()',
    'public.log_donation(text,text,text,numeric,date,text,text,boolean,boolean,boolean,text,text)',
    'public.grant_received(text,numeric,date)',
    'public.record_request_vote(text,jsonb,text,date,text)',
    'public.mark_request_paid(text,date)',
    'public.add_request_receipt(text,text,numeric,date,text,text,text)',
    'public.complete_request_receipts(text,date)',
    'public.clear_sample_data()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.sync_donation_to_ledger()', 'public.sync_ledger_to_donation()',
    'public.ledger_after_delete()', 'public.ledger_grant_received()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- files

insert into storage.buckets (id, name, public, file_size_limit)
values ('board-files', 'board-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create policy board_files_select on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and (select public.is_board()));
create policy board_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'board-files' and (select public.is_board()));
create policy board_files_update on storage.objects for update to authenticated
  using (bucket_id = 'board-files' and (select public.is_board()))
  with check (bucket_id = 'board-files' and (select public.is_board()));
create policy board_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'board-files' and (select public.is_board()));

insert into public.settings (id) values (1) on conflict (id) do nothing;
