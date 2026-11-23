-- 0022, P36 nightly backups (decision 9655). The backup itself runs outside the portal (scripts/backup.mjs: a
-- database dump kept 30 days, plus a copy of every stored file), wherever the copies are kept. Each run reports here
-- with the service key, and the portal's daily cron checks the reports: once backups have started, a failed run or no
-- good run in 36 hours queues an email to the Treasurer (at most one a day).

create table public.backup_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  ok boolean not null,
  host text,
  kept_at text,
  db_bytes bigint,
  files_count int,
  files_new int,
  files_bytes bigint,
  error text,
  alerted_at timestamptz
);
alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from public, anon, authenticated;
create trigger backup_runs_no_delete before delete on public.backup_runs for each row execute function public.no_delete_guard();
create trigger backup_runs_cpa_read_only before insert or update or delete on public.backup_runs for each statement execute function public.cpa_read_only();
create trigger backup_runs_cpa_no_truncate before truncate on public.backup_runs for each statement execute function public.cpa_read_only();

alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('team_request','direct_expense','access_request','access_answer','access_invite','email_change','backup_alert'));

-- The backup script's report (service key only).
create or replace function public.backup_report(p jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into public.backup_runs (started_at, ok, host, kept_at, db_bytes, files_count, files_new, files_bytes, error)
  values (coalesce((p ->> 'started_at')::timestamptz, now()), coalesce((p ->> 'ok')::boolean, false), left(p ->> 'host', 100), left(p ->> 'kept_at', 200),
          (p ->> 'db_bytes')::bigint, (p ->> 'files_count')::int, (p ->> 'files_new')::int, (p ->> 'files_bytes')::bigint, left(p ->> 'error', 2000))
  returning id;
$$;
revoke all on function public.backup_report(jsonb) from public, anon, authenticated;
grant execute on function public.backup_report(jsonb) to service_role;

-- The daily cron's check (service key only). Quiet until the first backup has reported.
create or replace function public.backup_overdue_check()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_ok timestamptz;
  v_last public.backup_runs%rowtype;
  v_to text[];
  v_why text;
begin
  select * into v_last from public.backup_runs order by finished_at desc, id desc limit 1;
  if v_last.id is null then return 'not started'; end if;
  select max(finished_at) into v_last_ok from public.backup_runs where ok;
  if v_last.ok and v_last_ok > now() - interval '36 hours' then return 'ok'; end if;
  if exists (select 1 from public.backup_runs where alerted_at > now() - interval '20 hours') then return 'already alerted'; end if;
  v_why := case when not v_last.ok then 'The last backup, on ' || to_char(v_last.finished_at at time zone 'America/New_York', 'FMMon FMDD at FMHH12:MI AM')
                                         || ', failed: ' || coalesce(v_last.error, 'no reason given') || '.'
                else 'No backup has finished since ' || coalesce(to_char(v_last_ok at time zone 'America/New_York', 'FMMon FMDD at FMHH12:MI AM'), 'the start') || '.' end;
  select coalesce(array_agg(a.email), '{}') into v_to from public.portal_access a
   where a.role = 'treasurer' and a.archived_at is null and nullif(trim(a.email), '') is not null;
  perform public.access_email('backup_alert', v_to, 'GPRIC Portal backup needs a look',
    v_why || chr(10) || chr(10) || 'The nightly copy of the portal''s books and files did not complete. Check the computer or service that runs it.', '/dashboard');
  update public.backup_runs set alerted_at = now() where id = v_last.id;
  return 'alerted';
end;
$$;
revoke all on function public.backup_overdue_check() from public, anon, authenticated;
grant execute on function public.backup_overdue_check() to service_role;
