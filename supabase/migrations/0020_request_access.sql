-- 0020, P33 self sign-up with board approval (mockup "Portal Request Access", confirmed; decision 9655).
--   People ask for their own portal account on /request-access: team or board/staff, name, email, phone, Zelle and a
--   password, then set up two-step. The login exists from that moment but has NO access: no portal_access seat and no
--   team login, so every read and write is refused (my_role and my_team are null) until a board member approves.
--   * access_requests: one row per ask. Written only through the functions below. A pending ask shows on People.
--   * The Treasurer or a board member approves with a role and a team, or declines with a reason. Approving makes the
--     seat: a team login (team_users, role Coach) or a portal seat (portal_access). A board member may approve team
--     members and board seats; a Treasurer, bookkeeper or CPA seat needs the Treasurer, as on People (0014).
--   * The Zelle on an approved team login is the payee record (team_users.zelle_contact). From then on it is locked:
--     update_my_profile refuses to change it, a request filed by that login always carries it (trigger below), and only
--     the Treasurer or a board member changes it (team_user_set_zelle, with a reason, in History).
--   * access_invites: Send Invite on People. A generic invite (link with a token, team picked or not); the sign-up that
--     uses it shows who invited them and comes with that team picked.
--   * Emails are queued in email_outbox (0013): the board on each new ask, the person on the answer, the invite itself.
--     They go out once the server has an email key; until then they wait as 'queued'.
--   * Column names: team_asked / team_granted, never team_id, so an ask (phone, Zelle, email) never reaches a team's
--     History (log_team reads team_id). The CPA's History leaves both tables out.
-- Nothing here redefines a function 0017 (team transfers) changed. log_area, log_label and change_log_cpa are their
-- live bodies (0014) with the two tables added (and 0021's email_changes, named ahead); update_my_profile is its live body (0003) with the Zelle lock.

-- ---------------------------------------------------------------- tables

create table public.access_invites (
  id bigint generated always as identity primary key,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  email text not null,
  name text,
  kind text not null default 'team' check (kind in ('team','board')),
  team_asked text references public.teams (id) on delete set null,
  invited_by text,
  invited_by_user uuid references auth.users (id) on delete set null,
  invited_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  archive_reason text
);
create index access_invites_email_idx on public.access_invites (lower(email));

create table public.access_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  name text not null,
  phone text,
  zelle_contact text,
  kind text not null check (kind in ('team','board')),
  team_asked text references public.teams (id) on delete set null,
  team_other text,
  invite_id bigint references public.access_invites (id) on delete set null,
  status text not null default 'Pending' check (status in ('Pending','Approved','Declined')),
  role_granted text check (role_granted in ('team','treasurer','board','bookkeeper','cpa')),
  team_granted text references public.teams (id) on delete set null,
  decided_by text,
  decided_at timestamptz,
  decline_reason text,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  archive_reason text
);
create unique index access_requests_one_open on public.access_requests (user_id) where status = 'Pending' and archived_at is null;
create index access_requests_user_idx on public.access_requests (user_id);

do $$
declare t text;
begin
  foreach t in array array['access_invites', 'access_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.no_delete_guard()', t || '_no_delete', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.log_change()', t || '_log', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each statement execute function public.cpa_read_only()', t || '_cpa_read_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cpa_read_only()', t || '_cpa_no_truncate', t);
  end loop;
end $$;

alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('team_request','direct_expense','access_request','access_answer','access_invite'));

-- ---------------------------------------------------------------- helpers (internal)

-- Queues one email; never stops the action that asked for it.
create or replace function public.access_email(p_kind text, p_to text[], p_subject text, p_body text, p_link text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_to text[];
begin
  select array_agg(distinct lower(trim(x)) order by lower(trim(x))) into v_to from unnest(p_to) x where nullif(trim(x), '') is not null;
  if v_to is null then return; end if;
  begin
    insert into public.email_outbox (kind, subject, body_text, link, to_emails) values (p_kind, p_subject, p_body, p_link, v_to);
  exception when others then
    raise warning 'Access email not queued: %', sqlerrm;
  end;
end;
$$;
revoke all on function public.access_email(text, text[], text, text, text) from public, anon, authenticated;

-- The board's addresses: every Treasurer and board seat that is on.
create or replace function public.access_board_emails()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(a.email), '{}') from public.portal_access a
   where a.role in ('treasurer','board') and a.archived_at is null and nullif(trim(a.email), '') is not null;
$$;
revoke all on function public.access_board_emails() from public, anon, authenticated;

-- ---------------------------------------------------------------- the sign-up side

-- What an invite link shows before anyone signs in: who sent it and the team picked. Nothing else.
create or replace function public.access_invite_lookup(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('invited_by', i.invited_by, 'kind', i.kind, 'team_id', i.team_asked, 'name', i.name)
    from public.access_invites i
   where i.token = nullif(trim(p_token), '') and i.archived_at is null;
$$;
revoke all on function public.access_invite_lookup(text) from public;
grant execute on function public.access_invite_lookup(text) to anon, authenticated;

-- Teams a person can pick on the sign-up page (names only).
create or replace function public.access_team_choices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name), '[]')
    from public.teams t where t.archived_at is null;
$$;
revoke all on function public.access_team_choices() from public;
grant execute on function public.access_team_choices() to anon, authenticated;

-- p: {kind, name, phone, zelle, team_id, team_other, invite}. The signed-in person asks for access for themselves.
-- Two-step is not needed yet (it is set up right after); a login that already has a seat or a team cannot ask.
create or replace function public.access_request_submit(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(nullif(trim(coalesce(auth.jwt() ->> 'email', '')), ''));
  v_kind text := p ->> 'kind';
  v_name text := nullif(trim(p ->> 'name'), '');
  v_team text := nullif(trim(p ->> 'team_id'), '');
  v_other text := nullif(trim(p ->> 'team_other'), '');
  v_zelle text := nullif(trim(p ->> 'zelle'), '');
  inv public.access_invites%rowtype;
  v_id bigint;
  v_team_name text;
begin
  if v_uid is null or v_email is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if exists (select 1 from public.portal_access a where a.user_id = v_uid) or exists (select 1 from public.team_users u where u.user_id = v_uid) then
    raise exception 'This login already has portal access. Sign in instead.';
  end if;
  if exists (select 1 from public.access_requests r where r.user_id = v_uid and r.status = 'Pending' and r.archived_at is null) then
    raise exception 'Your request is already waiting for a board member';
  end if;
  if v_kind is null or v_kind not in ('team','board') then raise exception 'Pick Team Member or Board Or Staff'; end if;
  if v_name is null then raise exception 'Enter your full name'; end if;
  if v_kind = 'team' then
    if v_team is null and v_other is null then raise exception 'Choose your team'; end if;
    if v_team is not null and not exists (select 1 from public.teams t where t.id = v_team and t.archived_at is null) then raise exception 'Choose your team'; end if;
    if v_zelle is null then raise exception 'Enter the Zelle email or phone that reimbursements are paid to'; end if;
  else
    v_team := null; v_other := null;
  end if;
  if nullif(trim(p ->> 'invite'), '') is not null then
    select * into inv from public.access_invites i where i.token = trim(p ->> 'invite') and i.archived_at is null;
  end if;
  insert into public.access_requests (user_id, email, name, phone, zelle_contact, kind, team_asked, team_other, invite_id)
  values (v_uid, v_email, v_name, nullif(trim(p ->> 'phone'), ''), v_zelle, v_kind, v_team, v_other, inv.id)
  returning id into v_id;
  select t.name into v_team_name from public.teams t where t.id = v_team;
  perform public.access_email('access_request', public.access_board_emails(),
    'Portal access request: ' || v_name,
    v_name || ' asked for a portal account as ' || case when v_kind = 'team' then 'a team member of ' || coalesce(v_team_name, v_other, 'a team') else 'board or staff' end || '.'
      || coalesce(chr(10) || 'Invited by ' || inv.invited_by || '.', '') || chr(10) || chr(10)
      || 'A board member approves or declines it on the People page. They have no access until then.',
    '/people');
  return v_id;
end;
$$;
revoke all on function public.access_request_submit(jsonb) from public, anon;
grant execute on function public.access_request_submit(jsonb) to authenticated;

-- The signed-in person's own latest ask, for the Waiting For Approval screen. Null when they never asked.
create or replace function public.access_request_mine()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'name', r.name, 'kind', r.kind,
                            'team', coalesce((select t.name from public.teams t where t.id = coalesce(r.team_granted, r.team_asked)), r.team_other),
                            'decline_reason', r.decline_reason, 'created_at', r.created_at, 'decided_at', r.decided_at)
    from public.access_requests r
   where r.user_id = auth.uid() and r.archived_at is null
   order by r.created_at desc, r.id desc limit 1;
$$;
revoke all on function public.access_request_mine() from public, anon;
grant execute on function public.access_request_mine() to authenticated;

-- ---------------------------------------------------------------- the board side (Treasurer and board)

-- Pending asks first, then the last 50 decided. Contact details are for the board only (never the CPA or a team).
create or replace function public.access_requests_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board'], 'Reviewing access requests');
  return coalesce((select jsonb_agg(x.j order by x.pending desc, x.created_at desc) from (
    select r.status = 'Pending' pending, r.created_at,
           jsonb_build_object('id', r.id, 'status', r.status, 'name', r.name, 'email', r.email, 'phone', r.phone,
                              'zelle', r.zelle_contact, 'kind', r.kind, 'team_asked', r.team_asked,
                              'team_asked_name', coalesce((select t.name from public.teams t where t.id = r.team_asked), r.team_other),
                              'team_other', r.team_other, 'invited_by', i.invited_by, 'created_at', r.created_at,
                              'role_granted', r.role_granted, 'team_granted', r.team_granted, 'decided_by', r.decided_by,
                              'decided_at', r.decided_at, 'decline_reason', r.decline_reason) j
      from public.access_requests r left join public.access_invites i on i.id = r.invite_id
     where r.archived_at is null
       and (r.status = 'Pending' or r.id in (select d.id from public.access_requests d where d.status <> 'Pending' and d.archived_at is null
                                              order by d.decided_at desc nulls last limit 50))) x), '[]');
end;
$$;
revoke all on function public.access_requests_list() from public, anon;
grant execute on function public.access_requests_list() to authenticated;

-- p_role: team | board | bookkeeper | cpa | treasurer. A team login needs p_team_id; p_zelle is its payee record.
create or replace function public.access_request_approve(p_id bigint, p_role text, p_team_id text default null, p_zelle text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.access_requests%rowtype;
  v_zelle text;
  v_team_name text;
  v_role_name text;
begin
  perform public.require_role(array['treasurer','board'], 'Approving access');
  if p_role is null or p_role not in ('team','treasurer','board','bookkeeper','cpa') then raise exception 'Pick a role'; end if;
  if p_role in ('treasurer','bookkeeper','cpa') and not public.is_treasurer() then
    raise exception 'Only the Treasurer can give a Treasurer, bookkeeper or CPA seat' using errcode = '42501';
  end if;
  select * into r from public.access_requests where id = p_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status <> 'Pending' then raise exception 'This request has already been decided'; end if;
  if exists (select 1 from public.portal_access a where a.user_id = r.user_id) or exists (select 1 from public.team_users u where u.user_id = r.user_id) then
    raise exception 'This login already has portal access';
  end if;
  perform public.via('access');
  if p_role = 'team' then
    if p_team_id is null or not exists (select 1 from public.teams t where t.id = p_team_id and t.archived_at is null) then raise exception 'Pick the team'; end if;
    v_zelle := coalesce(nullif(trim(p_zelle), ''), r.zelle_contact);
    insert into public.team_users (user_id, team_id, role, name, email, zelle_contact)
    values (r.user_id, p_team_id, 'Coach', r.name, r.email, v_zelle);
  else
    insert into public.portal_access (user_id, email, role, name) values (r.user_id, r.email, p_role, r.name);
  end if;
  update public.access_requests
     set status = 'Approved', role_granted = p_role, team_granted = case when p_role = 'team' then p_team_id end,
         zelle_contact = case when p_role = 'team' then v_zelle else zelle_contact end,
         decided_by = coalesce(nullif(public.my_name(), ''), 'Board member'), decided_at = now()
   where id = r.id;
  select t.name into v_team_name from public.teams t where t.id = p_team_id;
  v_role_name := case p_role when 'team' then 'a team member of ' || coalesce(v_team_name, 'your team') when 'treasurer' then 'Treasurer'
                             when 'board' then 'a board member' when 'bookkeeper' then 'the bookkeeper' else 'the CPA' end;
  perform public.access_email('access_answer', array[r.email], 'Your GPRIC Portal access',
    'Hi ' || r.name || ',' || chr(10) || chr(10) || 'Your GPRIC Portal account is approved. You are set up as ' || v_role_name || '.'
      || chr(10) || 'Sign in with your email, password and two-step code.', '/login');
end;
$$;
revoke all on function public.access_request_approve(bigint, text, text, text) from public, anon;
grant execute on function public.access_request_approve(bigint, text, text, text) to authenticated;

create or replace function public.access_request_decline(p_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare r public.access_requests%rowtype;
begin
  perform public.require_role(array['treasurer','board'], 'Declining access');
  if nullif(trim(p_reason), '') is null then raise exception 'Give the reason; the person is told it'; end if;
  select * into r from public.access_requests where id = p_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status <> 'Pending' then raise exception 'This request has already been decided'; end if;
  perform public.via('access');
  update public.access_requests set status = 'Declined', decline_reason = trim(p_reason),
         decided_by = coalesce(nullif(public.my_name(), ''), 'Board member'), decided_at = now()
   where id = r.id;
  perform public.access_email('access_answer', array[r.email], 'Your GPRIC Portal access',
    'Hi ' || r.name || ',' || chr(10) || chr(10) || 'Your request for a GPRIC Portal account was declined: ' || trim(p_reason) || '.'
      || chr(10) || 'If you think this is a mistake, reply to a board member.', '/login');
end;
$$;
revoke all on function public.access_request_decline(bigint, text) from public, anon;
grant execute on function public.access_request_decline(bigint, text) to authenticated;

-- Send Invite: a generic invite with the sign-up link (and the team, when picked). Returns the token for the link.
create or replace function public.access_invite_send(p_email text, p_name text default null, p_team_id text default null, p_kind text default 'team')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(nullif(trim(p_email), ''));
  v_kind text := coalesce(p_kind, 'team');
  v_tok text;
  v_by text := coalesce(nullif(public.my_name(), ''), 'A board member');
  v_team_name text;
begin
  perform public.require_role(array['treasurer','board'], 'Sending an invite');
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter an email address'; end if;
  if v_kind not in ('team','board') then raise exception 'Pick Team Member or Board Or Staff'; end if;
  if p_team_id is not null and not exists (select 1 from public.teams t where t.id = p_team_id and t.archived_at is null) then raise exception 'Pick the team'; end if;
  perform public.via('access');
  insert into public.access_invites (email, name, kind, team_asked, invited_by, invited_by_user)
  values (v_email, nullif(trim(p_name), ''), v_kind, case when v_kind = 'team' then p_team_id end, v_by, auth.uid())
  returning token into v_tok;
  select t.name into v_team_name from public.teams t where t.id = p_team_id and v_kind = 'team';
  perform public.access_email('access_invite', array[v_email], 'Set up your GPRIC Portal account',
    'Hi ' || coalesce(nullif(trim(p_name), ''), 'there') || ',' || chr(10) || chr(10)
      || v_by || ' invited you to set up your GPRIC Portal account' || coalesce(' for ' || v_team_name, '') || '.' || chr(10)
      || 'Open the link below. Fill in your name, email, phone and Zelle, set your password and two-step sign-in.' || chr(10)
      || 'A board member reviews each request; you get an email once you are approved.',
    '/request-access?invite=' || v_tok);
  return v_tok;
end;
$$;
revoke all on function public.access_invite_send(text, text, text, text) from public, anon;
grant execute on function public.access_invite_send(text, text, text, text) to authenticated;

create or replace function public.access_invites_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board'], 'Seeing invites');
  return coalesce((select jsonb_agg(jsonb_build_object('email', i.email, 'name', i.name, 'kind', i.kind, 'team_id', i.team_asked,
                                                       'invited_by', i.invited_by, 'invited_at', i.invited_at, 'token', i.token,
                                                       'used', exists (select 1 from public.access_requests r where r.invite_id = i.id))
                                    order by i.invited_at desc)
                     from (select * from public.access_invites where archived_at is null order by invited_at desc limit 100) i), '[]');
end;
$$;
revoke all on function public.access_invites_list() from public, anon;
grant execute on function public.access_invites_list() to authenticated;

-- ---------------------------------------------------------------- the Zelle payee record, locked

-- Only the Treasurer or a board member changes a team login's Zelle, with a reason, in History.
create or replace function public.team_user_set_zelle(p_user uuid, p_zelle text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board'], 'Changing a team login''s Zelle');
  if nullif(trim(p_reason), '') is null then raise exception 'Give the reason the Zelle changes'; end if;
  if nullif(trim(p_zelle), '') is null then raise exception 'Enter the Zelle email or phone'; end if;
  perform public.via('zelle');
  perform set_config('gpric.reason', trim(p_reason), true);
  update public.team_users set zelle_contact = trim(p_zelle) where user_id = p_user and zelle_contact is distinct from trim(p_zelle);
  if not found and not exists (select 1 from public.team_users where user_id = p_user) then raise exception 'Team login not found'; end if;
end;
$$;
revoke all on function public.team_user_set_zelle(uuid, text, text) from public, anon;
grant execute on function public.team_user_set_zelle(uuid, text, text) to authenticated;

-- The live body (0003) with the lock: a Zelle already on record is changed only by the board.
create or replace function public.update_my_profile(p_name text, p_zelle text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_now text;
begin
  if public.my_team() is null then raise exception 'Team sign-in with two-step is required' using errcode = '42501'; end if;
  select zelle_contact into v_now from public.team_users where user_id = auth.uid();
  if v_now is not null and nullif(trim(p_zelle), '') is distinct from v_now then
    raise exception 'Your Zelle is locked once it is on record. Ask the Treasurer or a board member to change it.';
  end if;
  update public.team_users set name = nullif(trim(p_name), ''), zelle_contact = coalesce(v_now, nullif(trim(p_zelle), '')) where user_id = auth.uid();
end;
$$;

-- A request filed by a team login with a Zelle on record is paid to that Zelle, whatever was typed.
create or replace function public.team_request_payee_zelle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_z text;
begin
  if new.submitted_by_user is not null and new.zelle_contact is not null then
    select u.zelle_contact into v_z from public.team_users u where u.user_id = new.submitted_by_user;
    if v_z is not null then new.zelle_contact := v_z; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.team_request_payee_zelle() from public, anon, authenticated;
create trigger team_requests_payee_zelle before insert on public.team_requests
  for each row execute function public.team_request_payee_zelle();

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
    when 'portal_access' then 'People' when 'people_invites' then 'People'
    when 'access_requests' then 'People' when 'access_invites' then 'People' when 'email_changes' then 'People'
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
  v_role text := case r ->> 'role' when 'treasurer' then 'Treasurer' when 'board' then 'Board' when 'bookkeeper' then 'Bookkeeper'
                                   when 'cpa' then 'CPA' end;
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
    when 'portal_access' then 'Person · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_role, '')
    when 'people_invites' then 'Invite · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || v_role, '')
    when 'access_requests' then 'Access request · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '') || coalesce(' · ' || (r ->> 'status'), '')
    when 'access_invites' then 'Sign-up invite · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '')
    when 'email_changes' then 'Email change · ' || coalesce(r ->> 'old_email', '') || ' to ' || coalesce(r ->> 'new_email', '')
    when 'settings' then 'Settings'
    when 'zeffy_sync_log' then 'Zeffy sync · ' || coalesce(r ->> 'source', '')
    when 'zeffy_skip' then 'Zeffy gift skipped · ' || coalesce(r ->> 'zeffy_key', '')
    when 'money_overrides' then 'Override · ' || coalesce(r ->> 'rule', '')
    else p_tbl end;
end;
$$;
revoke all on function public.log_label(text, jsonb) from public, anon, authenticated;

create or replace view public.change_log_cpa with (security_barrier = true) as
select c.id, c.at, c.user_id, public.cpa_mask_text(c.who) as who, c.role, c.action, c.what, c.tbl, c.record_id,
       public.cpa_mask_text(c.label) as label, public.cpa_mask_text(c.summary) as summary,
       public.cpa_mask_json(c.before) as before, public.cpa_mask_json(c.after) as after,
       c.team_id, c.device, c.via, public.cpa_mask_text(c.reason) as reason, c.rolls_back_id, c.rolled_back_at,
       public.cpa_mask_text(c.rolled_back_by) as rolled_back_by, public.cpa_mask_text(c.rollback_reason) as rollback_reason
  from public.change_log c
 where (select public.is_cpa())
   and c.tbl not in ('team_users','team_invites','calendar_events','problem_reports','sessions','seen_tips','portal_access','board_members',
                     'people_invites','access_requests','access_invites','email_changes');
revoke all on public.change_log_cpa from public, anon, authenticated;
grant select on public.change_log_cpa to authenticated;

-- ---------------------------------------------------------------- a login with no seat reaches nothing

-- True when the caller has a portal seat that is on, or a team login. A self sign-up waiting for approval (or
-- declined) has neither. Used by the restrictive policies below.
create or replace function public.has_seat()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.portal_access a where a.user_id = auth.uid() and a.archived_at is null)
      or exists (select 1 from public.team_users u where u.user_id = auth.uid());
$$;
revoke all on function public.has_seat() from public, anon;
grant execute on function public.has_seat() to authenticated;

-- Report a problem and its files never asked for a role (0009, 0014): narrow them to logins with a seat, so an open
-- sign-up cannot file reports or store files before a board member approves it.
create policy seatless_no_reports on public.problem_reports as restrictive for insert to authenticated
  with check ((select public.has_seat()));
create policy seatless_no_files on storage.objects as restrictive for all to authenticated
  using ((select public.has_seat())) with check ((select public.has_seat()));
