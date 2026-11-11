-- GPRIC release 3: email alerts (0013, switched off until an email service is set), the People page (0014) and
-- two money fixes (0015: a direct expense on GPRIC General is checked for overspend; closing a refunded request no
-- longer returns the refund twice). Paste the whole file into the GPRIC Supabase SQL editor and run once.
-- All or nothing: any error and nothing changes.
do $g$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where name in ('0013_email_alerts', '0014_people', '0015_money_fixes') or version in ('20261111165800', '20261111165900', '20261111170000')) then
    raise exception 'Release 3 is already applied (or part of it is): nothing was changed'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where name = '0012_cpa') then
    raise exception 'Release 2 (0012_cpa) must be live first'; end if;
end $g$;
begin;

-- ================================================================ 0013_email_alerts

-- GPRIC Portal 0013: email alerts (P32). Applies after 0012.
--   The bookkeeper (and anyone else marked) gets an email when a team request or a direct expense is filed.
--   * portal_access.email_alerts is the recipient list. Off for everyone by default; set on the live database from the
--     git-ignored private/ folder, like the seats (ruling 7480).
--   * email_outbox holds one row per alert. An AFTER INSERT trigger on team_requests queues it when a request is filed;
--     the server route /api/alerts/flush sends queued rows with the service key and marks each one sent or failed.
--     Nothing is sent until the server has an email key (src/lib/email.ts); until then rows wait as 'queued'.
--   * Queueing can never stop a request from filing: any error inside the trigger is caught and only logged as a warning.
--     No row is queued when no one has alerts on, and none for sample rows.
--   * The email names the team or fund, the person, the amount and what it is for, with a link to /requests. Never a
--     Zelle contact, an email address, a check number or any bank or account detail.
--   * Rows are never deleted (no_delete_guard). Only the Treasurer reads the outbox; clients write nothing, the server
--     writes through email_outbox_claim and email_outbox_done, which only the service role can run. Only the cron's
--     flush counts failed sends against a row (five at most); the open POST flush can never use up a row's attempts.
--   * The filer shows by name, or as 'A team login' / 'A board member' when the name is missing or is a login email.
--   * Not in History: the outbox has no log trigger, so it never reaches change_log, change_log_team or change_log_cpa.
--     The CPA has no read policy on it and carries the 0012 read-only trigger like every other table.

-- ---------------------------------------------------------------- recipients

alter table public.portal_access add column email_alerts boolean not null default false;

-- ---------------------------------------------------------------- outbox

create table public.email_outbox (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('team_request','direct_expense')),
  request_id text references public.team_requests (id) on delete restrict,
  subject text not null,
  body_text text not null,
  link text not null default '/requests',
  to_emails text[] not null check (cardinality(to_emails) > 0),
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  sent_at timestamptz,
  error text,
  attempts int not null default 0,
  claimed_at timestamptz,
  sample boolean not null default false
);
create unique index email_outbox_request_idx on public.email_outbox (request_id);
create index email_outbox_queued_idx on public.email_outbox (id) where status = 'queued';

alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from public, anon, authenticated;
grant select on public.email_outbox to authenticated;
create policy treasurer_read on public.email_outbox for select to authenticated
  using ((select public.is_treasurer()));

create trigger email_outbox_no_delete before delete on public.email_outbox
  for each row execute function public.no_delete_guard();

-- The 0012 rule: a CPA login writes nothing, on every table.
create trigger email_outbox_cpa_read_only before insert or update or delete on public.email_outbox
  for each statement execute function public.cpa_read_only();
create trigger email_outbox_cpa_no_truncate before truncate on public.email_outbox
  for each statement execute function public.cpa_read_only();

-- ---------------------------------------------------------------- queue on filing

create or replace function public.email_alert_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text[];
  v_amt text;
  v_who text;
  v_for text;
  v_kind text;
  v_subject text;
  v_body text;
  v_place text;
begin
  if new.sample then return null; end if;
  begin
    select array_agg(distinct lower(trim(a.email)) order by lower(trim(a.email))) into v_to
      from public.portal_access a
     where a.email_alerts and nullif(trim(a.email), '') is not null;
    if v_to is null then return null; end if;

    v_amt := '$' || to_char(new.amount, 'FM999,999,990.00');
    -- A filer without a name shows as their login email (submit_team_request, my_name()): never put that in an email.
    v_who := nullif(trim(new.requestor_name), '');
    if v_who is null or position('@' in v_who) > 0 then
      v_who := case when new.type = 'Direct Expense' then 'A board member' else 'A team login' end;
    end if;
    v_for := coalesce(nullif(trim(new.purpose), ''), nullif(trim(new.vendor), ''), 'No description');
    -- Mask anything address-like before the subject cuts it to 80 characters, so no fragment survives the cut.
    v_for := regexp_replace(v_for, '\S*@\S*', '[email hidden]', 'g');

    if new.type = 'Direct Expense' then
      v_kind := 'direct_expense';
      select f.name into v_place from public.funds f where f.id = new.charge_fund_id;
      v_place := coalesce(v_place, new.charge_fund_id);
      v_subject := 'New direct expense: ' || v_place || ' · ' || v_amt || ' · ' || left(v_for, 80);
      v_body := v_who || ' filed a direct expense charged to ' || v_place || '.' || chr(10) || chr(10)
             || 'Amount: ' || v_amt || chr(10)
             || 'For: ' || v_for || chr(10)
             || coalesce('Vendor: ' || nullif(trim(new.vendor), '') || chr(10), '')
             || coalesce('Paid by: ' || new.pay_method || chr(10), '')
             || coalesce('Paid on: ' || to_char(new.purchase_date, 'FMMon FMDD, YYYY') || chr(10), '')
             || 'Request: #' || new.id || chr(10) || chr(10)
             || 'It is waiting for the bookkeeper''s review on the Requests page.';
    else
      v_kind := 'team_request';
      select t.name into v_place from public.teams t where t.id = new.team_id;
      v_place := coalesce(v_place, new.team_id);
      v_subject := 'New team request: ' || v_place || ' · ' || v_amt || ' · ' || left(v_for, 80);
      v_body := v_who || ' filed a ' || lower(new.type) || ' request for ' || v_place || '.' || chr(10) || chr(10)
             || 'Amount: ' || v_amt || chr(10)
             || 'For: ' || v_for || chr(10)
             || coalesce('Category: ' || nullif(trim(new.category), '') || chr(10), '')
             || coalesce('Vendor: ' || nullif(trim(new.vendor), '') || chr(10), '')
             || coalesce('Needed by: ' || to_char(new.needed_by, 'FMMon FMDD, YYYY') || chr(10), '')
             || 'Request: #' || new.id || chr(10) || chr(10)
             || 'It is waiting on the Requests page.';
    end if;

    -- Belt and braces: any email address typed into a purpose or vendor is masked too.
    v_subject := regexp_replace(v_subject, '\S*@\S*', '[email hidden]', 'g');
    v_body := regexp_replace(v_body, '\S*@\S*', '[email hidden]', 'g');
    insert into public.email_outbox (kind, request_id, subject, body_text, link, to_emails)
    values (v_kind, new.id, v_subject, v_body, '/requests', v_to);
  exception when others then
    raise warning 'Email alert not queued for request %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.email_alert_queue() from public, anon, authenticated;

create trigger team_requests_email_alert after insert on public.team_requests
  for each row execute function public.email_alert_queue();

-- ---------------------------------------------------------------- send (server only)

-- Takes up to p_limit queued rows for sending and stamps claimed_at, so two flushes running at once never take the same
-- row. A claim older than ten minutes (a send that died midway) is taken again.
-- p_counted: the cron's flush (true) takes any queued row and a failed send counts as an attempt (five at most). The open
-- POST flush (false) takes only rows never tried, and its failures count nothing, so calling it during an outage can never
-- use up a row's attempts.
create or replace function public.email_outbox_claim(p_limit int default 20, p_counted boolean default true)
returns setof public.email_outbox
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox o
     set claimed_at = now()
   where o.id in (select x.id from public.email_outbox x
                   where x.status = 'queued' and x.attempts < 5
                     and (coalesce(p_counted, false) or x.attempts = 0)
                     and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
                   order by x.id
                   limit least(greatest(coalesce(p_limit, 20), 1), 50)
                   for update skip locked)
  returning o.*;
$$;

-- Marks a claimed row: sent when p_error is null. Otherwise it waits for the next flush; with p_counted the failure counts
-- as an attempt, and the fifth counted failure marks it failed.
create or replace function public.email_outbox_done(p_id bigint, p_error text default null, p_counted boolean default true)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox o
     set attempts = o.attempts + case when p_error is null or coalesce(p_counted, false) then 1 else 0 end,
         status = case when p_error is null then 'sent'
                       when coalesce(p_counted, false) and o.attempts + 1 >= 5 then 'failed' else 'queued' end,
         sent_at = case when p_error is null then now() else o.sent_at end,
         error = left(p_error, 500),
         claimed_at = null
   where o.id = p_id and o.status = 'queued';
$$;

do $$
declare f text;
begin
  foreach f in array array['public.email_outbox_claim(int,boolean)', 'public.email_outbox_done(bigint,text,boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ================================================================ 0014_people

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
--     The helpers that never asked my_role() (fund_balance, fund_committed, approvals_needed, month_locked,
--     request_fund, spend_warnings, calendar_season_end, my_member_id, my_name) give a turned-off seat null (my_name:
--     only its own sign-in email); team logins and the internal callers are unchanged.
--   Every People action is a Treasurer-only function, logged to History (area People) by the log trigger every portal
--     table carries. Guards: the Treasurer cannot turn off or change their own seat, and one treasurer always stays on
--     (every treasurer seat that is on is locked before the count, so two Treasurers at once cannot remove the last).

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

-- One treasurer always stays on: refuses taking the last one away. Its callers lock the treasurer seats first.
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
  -- Two Treasurers acting at once: every treasurer seat that is on is locked first (in one order), then the caller is
  -- checked again after any wait, so the second one sees the first one's change before counting.
  perform 1 from public.portal_access a where a.role = 'treasurer' and a.archived_at is null order by a.user_id for update;
  perform public.require_role(array['treasurer'], 'Changing a role');
  if p_role is null or p_role not in ('treasurer','board','bookkeeper','cpa') then
    raise exception 'Pick a role: Treasurer, Board, Bookkeeper or CPA';
  end if;
  select * into t from public.people_target(p_email);
  s := t.o_seat; i := t.o_invite;
  if s.user_id is not null and s.role = p_role then return; end if;
  perform public.via('people_role');
  if s.user_id is not null then
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
  -- Two Treasurers acting at once: every treasurer seat that is on is locked first (in one order), then the caller is
  -- checked again after any wait, so the second one sees the first one's change before counting.
  perform 1 from public.portal_access a where a.role = 'treasurer' and a.archived_at is null order by a.user_id for update;
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

-- ---------------------------------------------------------------- helpers with no role check

-- True when the signed-in person's portal seat is turned off. Internal: the helpers below call it as their owner.
create or replace function public.access_off()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.portal_access a where a.user_id = auth.uid() and a.archived_at is not null);
$$;
revoke all on function public.access_off() from public, anon, authenticated;

-- These answered any signed-in caller without asking my_role(): the money helpers that spend_check, approve, pay,
-- the totals and the Team Portal call, the calendar's season end, and the "who am I" helpers. A turned-off seat now
-- gets null from each. Team logins and system jobs have no portal seat, so access_off() is false for them and nothing
-- changes there; the internal callers run only after their own role check, which already refuses a turned-off seat.
-- Bodies as before (0003, 0004, 0006, 0008), wrapped in the access_off() check.
create or replace function public.approvals_needed(p_amount numeric)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then null else
    (select case when coalesce(p_amount, 0) <= s.approval_threshold then s.approvals_under else s.approvals_over end
       from public.settings s where s.id = 1) end;
$$;

create or replace function public.fund_balance(p_fund_id text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then null else
    (select round(coalesce(sum(case when dir = 'in' then amount else -amount end), 0), 2)
       from public.ledger where fund_id = p_fund_id) end;
$$;

create or replace function public.fund_committed(p_fund_id text, p_except_request text default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then null else
    (select round(coalesce(sum(r.amount), 0), 2)
       from public.team_requests r left join public.teams t on t.id = r.team_id
      where r.archived_at is null and coalesce(r.charge_fund_id, t.fund_id) = p_fund_id
        and (r.status = 'Approved' or (r.type = 'Direct Expense' and r.status = 'Submitted'))
        and r.id is distinct from p_except_request) end;
$$;

create or replace function public.month_locked(p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then null else
    exists (select 1 from public.bank_statements s
             where s.month = date_trunc('month', p_date)::date and s.locked_at is not null) end;
$$;

create or replace function public.request_fund(p_request_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then null else
    (select coalesce(r.charge_fund_id, t.fund_id)
       from public.team_requests r left join public.teams t on t.id = r.team_id
      where r.id = p_request_id) end;
$$;

create or replace function public.my_member_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then null else
    (select m.id from public.board_members m
      where m.email is not null and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      order by m.active desc, m.sort limit 1) end;
$$;

-- A turned-off seat gets only its own sign-in email back (never null: History's "who" needs a value).
create or replace function public.my_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.access_off() then coalesce(auth.jwt() ->> 'email', 'system') else coalesce(
    (select nullif(a.name, '') from public.portal_access a where a.user_id = auth.uid()),
    (select m.name from public.board_members m where m.id = public.my_member_id()),
    (select nullif(u.name, '') from public.team_users u where u.user_id = auth.uid()),
    auth.jwt() ->> 'email', 'system') end;
$$;

create or replace function public.spend_warnings(p_fund_id text, p_amount numeric, p_team_id text, p_category text, p_except_request text default null)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.funds%rowtype;
  v_avail numeric;
  w text[] := '{}';
begin
  if public.access_off() then return null; end if;
  select * into f from public.funds where id = p_fund_id;
  if f.id is null then return w; end if;
  v_avail := public.fund_balance(f.id) - public.fund_committed(f.id, p_except_request);
  if p_amount > v_avail then
    w := w || format('%s has $%s left after other approved requests; paying this would overspend it. Payment will be blocked unless the Treasurer overrides.',
                     f.name, to_char(v_avail, 'FM999,999,990.00'));
  end if;
  if f.restricted and f.team_id is not null and p_team_id is distinct from f.team_id then
    w := w || format('%s is restricted to its own team.', f.name);
  elsif f.restricted and f.team_id is null then
    w := w || format('%s is restricted money: %s.', f.name, coalesce(f.purpose, 'check the gift terms'));
  end if;
  return w;
end;
$$;

create or replace function public.calendar_season_end(p_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
begin
  if public.access_off() then return null; end if;
  v_start := coalesce((select s.fy_start from public.settings s where s.id = 1), make_date(extract(year from p_date)::int, 7, 1));
  v_start := make_date(extract(year from p_date)::int, extract(month from v_start)::int, extract(day from v_start)::int);
  if v_start > p_date then v_start := (v_start - interval '1 year')::date; end if;
  v_end := (v_start + interval '1 year' - interval '1 day')::date;
  return v_end;
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

insert into supabase_migrations.schema_migrations (version, name) values
  ('20261111165800', '0013_email_alerts'),
  ('20261111165900', '0014_people'),
  ('20261111170000', '0015_money_fixes');
commit;

select (select string_agg(name, ', ' order by version) from supabase_migrations.schema_migrations where version >= '20261111165800') release_3,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('email_outbox', 'people_invites')) new_tables;
