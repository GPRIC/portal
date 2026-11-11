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
    v_subject := regexp_replace(v_subject, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email hidden]', 'g');
    v_body := regexp_replace(v_body, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email hidden]', 'g');
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
