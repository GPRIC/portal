-- GPRIC Portal 0014: People (P39). Applies after 0012 (0013 is another build's; nothing here depends on it).
--   The Treasurer adds, changes and turns off every board, bookkeeper and CPA login from the portal's People page,
--   instead of by hand in the Supabase dashboard. Team coaches and team treasurers stay on the Requests page (0003).
--   Invites: the Treasurer's pick (name, role, may file direct expenses) is saved in people_invites before the invite
--     email goes out (api/people-invite). The sign-up trigger gives the new login that role, not the old default 'board'.
--     An invite made in the Supabase dashboard with no People invite still gets 'board', as before.
--   Turn off, never delete: portal_access.archived_at / archived_by / archive_reason. my_role() treats a turned-off
--     seat as no seat, and every access check goes through my_role(): is_board, is_treasurer, require_role, whoami,
--     is_cpa, can_read_books, can_file_direct, every board_only and cpa_read policy, the board and CPA storage policies,
--     History's read policy and portal_totals. The few rules that never asked my_role() (report a problem, its files,
--     first-visit tips) get restrictive policies below. Turning access back on clears the three columns.
--   Every People action is a Treasurer-only function, logged to History (area People) by the log trigger every portal
--     table carries. Guards: the Treasurer cannot turn off or change their own seat, and one treasurer always stays on.

-- ---------------------------------------------------------------- turned off

alter table public.portal_access
  add column archived_at timestamptz,
  add column archived_by text,
  add column archive_reason text;

-- The signed-in person's role, only with two-step done and only while their access is on.
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.role from public.portal_access a
   where a.user_id = auth.uid() and a.archived_at is null and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- One row when the signed-in person's portal access is turned off; empty for everyone else. A view rather than a
-- function so row security can ask it without adding a function every signed-in role can run (0012's CPA sweep).
create view public.my_access_off with (security_barrier = true) as
select a.user_id from public.portal_access a where a.user_id = auth.uid() and a.archived_at is not null;
revoke all on public.my_access_off from public, anon, authenticated;
grant select on public.my_access_off to authenticated;

-- Report a problem, its files and first-visit tips never asked for a role (anyone signed in may use them).
-- A turned-off person loses them too. Restrictive, so they narrow every other policy.
create policy turned_off_no_reports on public.problem_reports as restrictive for insert to authenticated
  with check (not exists (select 1 from public.my_access_off));
create policy turned_off_no_tips on public.seen_tips as restrictive for all to authenticated
  using (not exists (select 1 from public.my_access_off)) with check (not exists (select 1 from public.my_access_off));
create policy turned_off_no_files on storage.objects as restrictive for all to authenticated
  using (not exists (select 1 from public.my_access_off)) with check (not exists (select 1 from public.my_access_off));

-- ---------------------------------------------------------------- invites

-- What the Treasurer picked for a person invited from the People page. The sign-up trigger reads it.
-- Written only through the functions below. sent_at / send_error: how the invite email went (api/people-invite).
create table public.people_invites (
  id bigint generated always as identity primary key,
  email text not null,
  name text,
  role text not null default 'board' check (role in ('treasurer','board','bookkeeper','cpa')),
  files_direct boolean not null default false,
  invited_by text,
  invited_at timestamptz not null default now(),
  sent_at timestamptz,
  send_error text,
  user_id uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  archived_by text,
  archive_reason text
);
create index people_invites_email_idx on public.people_invites (lower(email));
create index people_invites_user_idx on public.people_invites (user_id);

alter table public.people_invites enable row level security;
revoke all on public.people_invites from public, anon, authenticated;

create trigger people_invites_no_delete before delete on public.people_invites
  for each row execute function public.no_delete_guard();
create trigger people_invites_log after insert or update or delete on public.people_invites
  for each row execute function public.log_change();
create trigger people_invites_cpa_read_only before insert or update or delete on public.people_invites
  for each statement execute function public.cpa_read_only();
create trigger people_invites_cpa_no_truncate before truncate on public.people_invites
  for each statement execute function public.cpa_read_only();

-- Replaces 0003's trigger. A login already on either side keeps its place. Otherwise the newest open invite for the
-- email decides: a People invite makes a portal seat with the role, name and direct-expense mark the Treasurer picked;
-- a team invite makes a team login. No invite at all (an invite sent from the Supabase dashboard): a board seat.
create or replace function public.grant_portal_access_on_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.team_invites%rowtype;
  pin public.people_invites%rowtype;
begin
  if new.invited_at is null then return new; end if;
  if exists (select 1 from public.portal_access a where a.user_id = new.id) then
    update public.portal_access set email = new.email where user_id = new.id and email is distinct from new.email;
    return new;
  end if;
  if exists (select 1 from public.team_users u where u.user_id = new.id) then
    update public.team_users set email = new.email where user_id = new.id;
    return new;
  end if;
  select * into pin from public.people_invites p
   where lower(p.email) = lower(new.email) and p.archived_at is null and (p.user_id is null or p.user_id = new.id)
   order by p.invited_at desc, p.id desc limit 1;
  select * into inv from public.team_invites i
   where lower(i.email) = lower(new.email) and (i.user_id is null or i.user_id = new.id)
   order by i.invited_at desc limit 1;
  if pin.id is not null and (inv.id is null or pin.invited_at >= inv.invited_at) then
    insert into public.portal_access (user_id, email, role, name, files_direct)
    values (new.id, new.email, pin.role, nullif(trim(pin.name), ''), pin.files_direct)
    on conflict (user_id) do nothing;
    update public.people_invites set user_id = new.id where id = pin.id;
    return new;
  end if;
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

-- ---------------------------------------------------------------- the People functions (Treasurer only)

-- Everyone with a board, bookkeeper or CPA login, and every People invite that has no login yet.
--   status: active (has signed in), invited (has a login, never signed in), not_sent (the invite email did not go out),
--   off (access turned off, or an invite cancelled).
create or replace function public.people_list()
returns table (email text, name text, role text, files_direct boolean, status text, last_sign_in_at timestamptz,
               invited_at timestamptz, has_login boolean, is_me boolean, off_at timestamptz, off_by text, off_reason text,
               send_error text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer'], 'The People page');
  return query
  select a.email, a.name, a.role, a.files_direct,
         case when a.archived_at is not null then 'off' when u.last_sign_in_at is not null then 'active' else 'invited' end,
         u.last_sign_in_at, coalesce(u.invited_at, a.added_at), true, a.user_id = auth.uid(),
         a.archived_at, a.archived_by, a.archive_reason,
         case when u.last_sign_in_at is null then li.send_error end
    from public.portal_access a
    left join auth.users u on u.id = a.user_id
    left join lateral (select p.send_error from public.people_invites p where lower(p.email) = lower(a.email)
                        order by p.invited_at desc, p.id desc limit 1) li on true
  union all
  select p.email, p.name, p.role, p.files_direct,
         case when p.archived_at is not null then 'off' when p.send_error is not null or p.sent_at is null then 'not_sent' else 'invited' end,
         null::timestamptz, p.invited_at, false, false, p.archived_at, p.archived_by, p.archive_reason, p.send_error
    from public.people_invites p
   where p.user_id is null
     and p.id = (select max(x.id) from public.people_invites x where lower(x.email) = lower(p.email))
     and not exists (select 1 from public.portal_access a where lower(a.email) = lower(p.email));
end;
$$;

-- A new person: saves what the Treasurer picked, before the invite email goes out. Returns the invite id.
-- An email that already has a login of any kind is refused; an open invite for the same email is replaced.
create or replace function public.people_invite_save(p_email text, p_name text, p_role text, p_files_direct boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id bigint;
begin
  perform public.require_role(array['treasurer'], 'Adding a person');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter their email address'; end if;
  if p_role is null or p_role not in ('treasurer','board','bookkeeper','cpa') then
    raise exception 'Pick a role: Treasurer, Board, Bookkeeper or CPA';
  end if;
  if exists (select 1 from public.portal_access a where lower(a.email) = v_email) then
    raise exception 'That email already has a portal login. Find them in the list below.';
  end if;
  if exists (select 1 from public.team_users t where lower(t.email) = v_email)
     or exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'That email already has a login (a team login). One email cannot be both.';
  end if;
  perform public.via('people_invite');
  update public.people_invites set archived_at = now(), archived_by = public.my_name(), archive_reason = 'Replaced by a new invite'
   where lower(email) = v_email and user_id is null and archived_at is null;
  insert into public.people_invites (email, name, role, files_direct, invited_by)
  values (v_email, nullif(trim(coalesce(p_name, '')), ''), p_role, coalesce(p_files_direct, false), public.my_name())
  returning id into v_id;
  perform public.via('');
  return v_id;
end;
$$;

-- How the invite email went, from api/people-invite: p_error null when it was sent. Marks the newest invite for the
-- email; a login invited before People existed gets an invite record here, so the resend shows in History.
create or replace function public.people_invite_sent(p_email text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id bigint;
  a public.portal_access%rowtype;
begin
  perform public.require_role(array['treasurer'], 'Sending an invite');
  select p.id into v_id from public.people_invites p where lower(p.email) = v_email order by p.invited_at desc, p.id desc limit 1;
  if v_id is null then
    select * into a from public.portal_access x where lower(x.email) = v_email limit 1;
    if a.user_id is null then raise exception 'No one with that email is on the People list'; end if;
    perform public.via('people_invite');
    insert into public.people_invites (email, name, role, files_direct, invited_by, user_id)
    values (v_email, a.name, a.role, a.files_direct, public.my_name(), a.user_id) returning id into v_id;
  end if;
  perform public.via(case when p_error is null then 'people_sent' else 'people_send_failed' end);
  update public.people_invites
     set sent_at = case when p_error is null then now() else sent_at end,
         send_error = nullif(left(trim(coalesce(p_error, '')), 300), '')
   where id = v_id;
  perform public.via('');
end;
$$;

-- The seat for an email, locked for the change; or, with no login yet, the open invite. Raises when neither exists.
create or replace function public.people_target(p_email text, out o_seat public.portal_access, out o_invite public.people_invites)
language plpgsql
security definer
set search_path = ''
as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  select * into o_seat from public.portal_access a where lower(a.email) = v_email order by a.added_at desc limit 1 for update;
  if o_seat.user_id is null then
    select * into o_invite from public.people_invites p
     where lower(p.email) = v_email and p.user_id is null order by p.invited_at desc, p.id desc limit 1 for update;
    if o_invite.id is null then raise exception 'No one with that email is on the People list'; end if;
  end if;
end;
$$;

-- One treasurer always stays on: refuses taking the last one away.
create or replace function public.people_keep_a_treasurer(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.portal_access a
                  where a.role = 'treasurer' and a.archived_at is null and a.user_id <> p_user) then
    raise exception 'The portal must always have a Treasurer whose access is on. Make someone else Treasurer first.';
  end if;
end;
$$;

create or replace function public.people_set_role(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare t record; s public.portal_access; i public.people_invites;
begin
  perform public.require_role(array['treasurer'], 'Changing a role');
  if p_role is null or p_role not in ('treasurer','board','bookkeeper','cpa') then
    raise exception 'Pick a role: Treasurer, Board, Bookkeeper or CPA';
  end if;
  select * into t from public.people_target(p_email);
  s := t.o_seat; i := t.o_invite;
  perform public.via('people_role');
  if s.user_id is not null then
    if s.role = p_role then return; end if;
    if s.user_id = auth.uid() then
      raise exception 'You cannot change your own role. Another Treasurer can do it for you.';
    end if;
    if s.role = 'treasurer' and s.archived_at is null then perform public.people_keep_a_treasurer(s.user_id); end if;
    update public.portal_access set role = p_role where user_id = s.user_id;
  else
    update public.people_invites set role = p_role where id = i.id and role is distinct from p_role;
  end if;
  perform public.via('');
end;
$$;

create or replace function public.people_set_files_direct(p_email text, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare t record; s public.portal_access; i public.people_invites;
begin
  perform public.require_role(array['treasurer'], 'Changing who files direct expenses');
  if p_on is null then raise exception 'Say whether they may file direct expenses'; end if;
  select * into t from public.people_target(p_email);
  s := t.o_seat; i := t.o_invite;
  perform public.via('people_direct');
  if s.user_id is not null then
    update public.portal_access set files_direct = p_on where user_id = s.user_id and files_direct is distinct from p_on;
  else
    update public.people_invites set files_direct = p_on where id = i.id and files_direct is distinct from p_on;
  end if;
  perform public.via('');
end;
$$;

-- Turns a person's access off, with a reason. Nothing is deleted; they can be turned back on.
-- With no login yet, it cancels the invite instead.
create or replace function public.people_turn_off(p_email text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare t record; s public.portal_access; i public.people_invites;
begin
  perform public.require_role(array['treasurer'], 'Turning off access');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason for turning off their access'; end if;
  select * into t from public.people_target(p_email);
  s := t.o_seat; i := t.o_invite;
  perform public.via('people_off');
  perform set_config('gpric.reason', trim(p_reason), true);
  if s.user_id is not null then
    if s.user_id = auth.uid() then
      raise exception 'You cannot turn off your own access. Another Treasurer can do it for you.';
    end if;
    if s.archived_at is not null then raise exception 'Their access is already off'; end if;
    if s.role = 'treasurer' then perform public.people_keep_a_treasurer(s.user_id); end if;
    update public.portal_access set archived_at = now(), archived_by = public.my_name(), archive_reason = trim(p_reason)
     where user_id = s.user_id;
  else
    if i.archived_at is not null then raise exception 'That invite is already cancelled'; end if;
    update public.people_invites set archived_at = now(), archived_by = public.my_name(), archive_reason = trim(p_reason)
     where id = i.id;
  end if;
  perform set_config('gpric.reason', '', true);
  perform public.via('');
end;
$$;

-- Turns access back on (or reopens a cancelled invite, which then needs Resend Invite).
create or replace function public.people_turn_on(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare t record; s public.portal_access; i public.people_invites;
begin
  perform public.require_role(array['treasurer'], 'Turning on access');
  select * into t from public.people_target(p_email);
  s := t.o_seat; i := t.o_invite;
  perform public.via('people_on');
  if s.user_id is not null then
    if s.archived_at is null then raise exception 'Their access is already on'; end if;
    update public.portal_access set archived_at = null, archived_by = null, archive_reason = null where user_id = s.user_id;
  else
    if i.archived_at is null then raise exception 'That invite is already open'; end if;
    update public.people_invites set archived_at = null, archived_by = null, archive_reason = null where id = i.id;
  end if;
  perform public.via('');
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
    when 'portal_access' then 'People' when 'people_invites' then 'People'
    else 'Settings' end;
$$;

-- As 0011, with People: a seat reads "Person · name · role", an invite "Invite · name · role".
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
    when 'settings' then 'Settings'
    when 'zeffy_sync_log' then 'Zeffy sync · ' || coalesce(r ->> 'source', '')
    when 'zeffy_skip' then 'Zeffy gift skipped · ' || coalesce(r ->> 'zeffy_key', '')
    when 'money_overrides' then 'Override · ' || coalesce(r ->> 'rule', '')
    else p_tbl end;
end;
$$;
revoke all on function public.log_label(text, jsonb) from public, anon, authenticated;

-- As 0011, with the People actions named. They come first, so turning off reads "Turned Off", not "Archived".
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

-- The CPA's History (0012) also leaves out People invites, like board access.
create or replace view public.change_log_cpa with (security_barrier = true) as
select c.id, c.at, c.user_id, public.cpa_mask_text(c.who) as who, c.role, c.action, c.what, c.tbl, c.record_id,
       public.cpa_mask_text(c.label) as label, public.cpa_mask_text(c.summary) as summary,
       public.cpa_mask_json(c.before) as before, public.cpa_mask_json(c.after) as after,
       c.team_id, c.device, c.via, public.cpa_mask_text(c.reason) as reason, c.rolls_back_id, c.rolled_back_at,
       public.cpa_mask_text(c.rolled_back_by) as rolled_back_by, public.cpa_mask_text(c.rollback_reason) as rollback_reason
  from public.change_log c
 where (select public.is_cpa())
   and c.tbl not in ('team_users','team_invites','calendar_events','problem_reports','sessions','seen_tips','portal_access','board_members',
                     'people_invites');
revoke all on public.change_log_cpa from public, anon, authenticated;
grant select on public.change_log_cpa to authenticated;

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array['public.people_list()', 'public.people_invite_save(text,text,text,boolean)', 'public.people_invite_sent(text,text)',
                           'public.people_set_role(text,text)', 'public.people_set_files_direct(text,boolean)',
                           'public.people_turn_off(text,text)', 'public.people_turn_on(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.people_target(text)', 'public.people_keep_a_treasurer(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
