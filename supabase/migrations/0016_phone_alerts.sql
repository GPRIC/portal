-- GPRIC Portal 0016: phone alerts (P23 workshop, Josh 2026-11-19: "Let's just make a very simple one that notifies her
-- when there is a request for reimbursement."). Applies after 0013.
--   The portal installs on a phone from the browser (Add to Home Screen) and sends a notification to that phone when a
--   team files a reimbursement request. No email service is needed; email alerts (0013) stay as they are.
--   * Who gets them: the same list as email alerts, portal_access.email_alerts. Only someone on that list can register a
--     phone (push_subscribe), and a phone stops getting alerts as soon as its person comes off the list.
--   * What triggers one: an email_outbox row (queued by 0013's trigger when a request is filed) for a Reimbursement.
--     push_claim stamps push_sent_at, so each request notifies once, whether or not its email has gone.
--     Pre-approval requests and direct expenses send no phone alert. Rows older than two days are never pushed late.
--   * The notification says the team, the amount and what it is for (the email subject, already masked by 0013). Never a
--     Zelle contact, an email address, a check number or any bank detail.
--   * push_subscriptions holds each phone's push address and keys. A person reads only their own rows; nobody else's
--     client sees them. Rows are never deleted: turning alerts off, or a phone the push service reports gone, retires it.
--   * The server sends through push_claim, push_targets and push_result, which only the service role can run.

-- ---------------------------------------------------------------- phones

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete restrict,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  device text,
  last_sent_at timestamptz,
  last_error text,
  retired_at timestamptz
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select on public.push_subscriptions to authenticated;
create policy own_read on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

create trigger push_subscriptions_no_delete before delete on public.push_subscriptions
  for each row execute function public.no_delete_guard();
create trigger push_subscriptions_cpa_read_only before insert or update or delete on public.push_subscriptions
  for each statement execute function public.cpa_read_only();
create trigger push_subscriptions_cpa_no_truncate before truncate on public.push_subscriptions
  for each statement execute function public.cpa_read_only();

alter table public.email_outbox add column push_sent_at timestamptz;

-- ---------------------------------------------------------------- the phone signs up or off (signed-in person)

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_device text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.portal_access a
                  where a.user_id = auth.uid() and a.email_alerts
                    and coalesce(auth.jwt() ->> 'aal', '') = 'aal2') then
    raise exception 'Blocked: phone alerts are only for the people on the alert list.';
  end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'This phone did not give a push address the portal can use.';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_device, 120))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device,
         retired_at = null, last_error = null;
end;
$$;

create or replace function public.push_unsubscribe(p_endpoint text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.push_subscriptions set retired_at = now()
   where endpoint = p_endpoint and user_id = auth.uid() and retired_at is null;
$$;

-- ---------------------------------------------------------------- send (server only)

-- Takes the reimbursement alerts not yet pushed and stamps them, so two sends running at once never push one twice.
create or replace function public.push_claim()
returns table (id bigint, request_id text, body text, link text)
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox o
     set push_sent_at = now()
   where o.push_sent_at is null
     and o.kind = 'team_request'
     and not o.sample
     and o.created_at > now() - interval '2 days'
     and exists (select 1 from public.team_requests r where r.id = o.request_id and r.type = 'Reimbursement')
  returning o.id, o.request_id, regexp_replace(o.subject, '^New team request: ', ''), o.link;
$$;

-- The phones to notify: live sign-ups whose person is still on the alert list.
create or replace function public.push_targets(p_user uuid default null)
returns table (id bigint, endpoint text, p256dh text, auth text)
language sql
security definer
set search_path = ''
as $$
  select s.id, s.endpoint, s.p256dh, s.auth
    from public.push_subscriptions s
    join public.portal_access a on a.user_id = s.user_id
   where s.retired_at is null and a.email_alerts
     and (p_user is null or s.user_id = p_user)
   order by s.id;
$$;

-- Records a send: null error = delivered. p_gone (the push service says the phone is no longer there) retires it.
create or replace function public.push_result(p_id bigint, p_error text default null, p_gone boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.push_subscriptions
     set last_sent_at = case when p_error is null then now() else last_sent_at end,
         last_error = left(p_error, 500),
         retired_at = case when coalesce(p_gone, false) then now() else retired_at end
   where id = p_id;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.push_subscribe(text,text,text,text)', 'public.push_unsubscribe(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.push_claim()', 'public.push_targets(uuid)', 'public.push_result(bigint,text,boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
