-- 0021, P34 change a login email, keeping the role and History (Josh 2026-11-19, decision 9655).
--   * Anyone changes their own sign-in email from My Account (the board's name chip, the Team Portal's Profile). That
--     uses Supabase's own email change: the new address gets a confirmation link and nothing changes until it is used.
--   * The Treasurer changes a person's email from People. The change waits in email_changes, and the new address gets
--     a confirmation link (email_outbox); only opening that link makes the switch (api/email-change, with the
--     service key). The link is never shown to the Treasurer, so the new address really is confirmed.
--   * Either way, once auth.users.email changes, the seat follows: portal_access, team_users and the board member
--     record that carried the old address take the new one (History shows each as a change). Requests filed earlier
--     keep the address they were filed with.

create table public.email_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  old_email text not null,
  new_email text not null,
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  requested_by text,
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  archived_at timestamptz,
  archived_by text,
  archive_reason text
);
create index email_changes_user_idx on public.email_changes (user_id);
alter table public.email_changes enable row level security;
revoke all on public.email_changes from public, anon, authenticated;
create trigger email_changes_no_delete before delete on public.email_changes for each row execute function public.no_delete_guard();
create trigger email_changes_log after insert or update or delete on public.email_changes for each row execute function public.log_change();
create trigger email_changes_cpa_read_only before insert or update or delete on public.email_changes for each statement execute function public.cpa_read_only();
-- the CPA cannot empty it either (written as 0020 writes its triggers)
do $$ begin execute format('create trigger %I before truncate on public.%I for each statement execute function public.cpa_read_only()', 'email_changes_cpa_no_truncate', 'email_changes'); end $$;

alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('team_request','direct_expense','access_request','access_answer','access_invite','email_change'));

-- The Treasurer asks to move a person (found by their current email on People) to a new address.
create or replace function public.people_email_change_request(p_email text, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text := lower(nullif(trim(p_new), ''));
  v_uid uuid;
  v_old text;
  v_name text;
  v_role text;
begin
  perform public.require_role(array['treasurer'], 'Changing a person''s sign-in email');
  if v_new is null or v_new !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter the new email address'; end if;
  select a.user_id, u.email, a.name, a.role into v_uid, v_old, v_name, v_role
    from public.portal_access a join auth.users u on u.id = a.user_id
   where lower(a.email) = lower(trim(p_email)) limit 1;
  if v_uid is null then raise exception 'That person has not signed up yet. Add them again with the new address instead.'; end if;
  -- A seat that approves or pays moves only by its own hand (My Account), so no one can take over a second approver.
  if v_role in ('treasurer','board','bookkeeper') then
    raise exception 'A Treasurer, board or bookkeeper seat changes its own email from My Account' using errcode = '42501';
  end if;
  if lower(v_old) = v_new then raise exception 'That is already their email'; end if;
  if exists (select 1 from auth.users u where lower(u.email) = v_new) then raise exception 'Another login already uses that email'; end if;
  perform public.via('email');
  update public.email_changes set archived_at = now(), archived_by = public.my_name(), archive_reason = 'Replaced by a newer change'
   where user_id = v_uid and confirmed_at is null and archived_at is null;
  insert into public.email_changes (user_id, old_email, new_email, requested_by) values (v_uid, v_old, v_new, public.my_name());
  perform public.access_email('email_change', array[v_new], 'Confirm your GPRIC Portal email',
    'Hi ' || coalesce(v_name, 'there') || ',' || chr(10) || chr(10)
      || coalesce(public.my_name(), 'The Treasurer') || ' is moving your GPRIC Portal sign-in from ' || v_old || ' to this address.' || chr(10)
      || 'Open the link below to confirm. Nothing changes until you do; your role and history stay as they are.',
    '/confirm-email?token=' || (select c.token from public.email_changes c where c.user_id = v_uid and c.confirmed_at is null and c.archived_at is null order by c.id desc limit 1));
  -- The old address is told too, so a change nobody asked for is seen.
  perform public.access_email('email_change', array[v_old], 'Your GPRIC Portal sign-in email is being changed',
    'Hi ' || coalesce(v_name, 'there') || ',' || chr(10) || chr(10)
      || coalesce(public.my_name(), 'The Treasurer') || ' asked to move your GPRIC Portal sign-in from this address to ' || v_new || '.' || chr(10)
      || 'If you did not expect this, tell a board member right away.', '/login');
end;
$$;
revoke all on function public.people_email_change_request(text, text) from public, anon;
grant execute on function public.people_email_change_request(text, text) to authenticated;

-- Pending changes for People (no tokens).
create or replace function public.people_email_changes()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer'], 'Seeing email changes');
  return coalesce((select jsonb_agg(jsonb_build_object('old_email', c.old_email, 'new_email', c.new_email, 'requested_at', c.requested_at, 'requested_by', c.requested_by) order by c.id desc)
                     from public.email_changes c where c.confirmed_at is null and c.archived_at is null and c.requested_at > now() - interval '14 days'), '[]');
end;
$$;
revoke all on function public.people_email_changes() from public, anon;
grant execute on function public.people_email_changes() to authenticated;

-- The confirmation link: the server (service key only) takes the token once; it is good for 14 days.
create or replace function public.email_change_take(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare c public.email_changes%rowtype;
begin
  select * into c from public.email_changes where token = nullif(trim(p_token), '') for update;
  if c.id is null or c.archived_at is not null then raise exception 'That link is not valid. Ask the Treasurer for a new one.'; end if;
  if c.confirmed_at is not null then raise exception 'That link was already used.'; end if;
  if c.requested_at < now() - interval '14 days' then raise exception 'That link has expired. Ask the Treasurer for a new one.'; end if;
  if exists (select 1 from auth.users u where lower(u.email) = lower(c.new_email) and u.id <> c.user_id) then raise exception 'Another login already uses that email'; end if;
  perform public.via('email');
  update public.email_changes set confirmed_at = now() where id = c.id;
  return jsonb_build_object('user_id', c.user_id, 'new_email', c.new_email);
end;
$$;
revoke all on function public.email_change_take(text) from public, anon, authenticated;
grant execute on function public.email_change_take(text) to service_role;

-- Whatever changed the sign-in email, the seat and the board member record follow it.
create or replace function public.follow_login_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or lower(new.email) = lower(coalesce(old.email, '')) then return new; end if;
  perform set_config('gpric.via', 'email', true);
  perform set_config('gpric.reason', 'Sign-in email changed from ' || coalesce(old.email, 'none'), true);
  update public.portal_access set email = new.email where user_id = new.id and email is distinct from new.email;
  update public.team_users set email = new.email where user_id = new.id and email is distinct from new.email;
  if old.email is not null then
    update public.board_members set email = new.email where email is not null and lower(email) = lower(old.email);
  end if;
  return new;
end;
$$;
revoke all on function public.follow_login_email() from public, anon, authenticated;
create trigger follow_login_email after update of email on auth.users
  for each row execute function public.follow_login_email();
