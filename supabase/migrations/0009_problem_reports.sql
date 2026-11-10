-- GPRIC Portal P37, Report A Problem and Problem Reports.
-- Anyone signed in (board or team login) sends a report from any page: notes, an optional screen snip and an optional
-- voice note. The database fills in the person, their role and team, the time and the device itself; the page comes
-- from the browser (or, failing that, the request's Referer). No email is sent.
-- Only the Treasurer reads reports and changes their status (New, Looking, Won't Fix, Fixed) and reply note.
-- Reports are never deleted. Their files live in the private board-files bucket under problems/<user id>/ and,
-- like every file there, cannot be overwritten or removed; only the Treasurer can open them.

create sequence public.problem_report_id_seq;

create table public.problem_reports (
  id text primary key default public.pad_id('PR-', nextval('public.problem_report_id_seq'), 3),
  created_at timestamptz not null default now(),
  user_id uuid not null,
  who text not null,
  role text,                          -- treasurer, board, bookkeeper, cpa, team
  team_id text references public.teams (id),
  page text not null,                 -- the path and query the report was sent from, e.g. /ledger?fund=F-GEN
  page_title text,                    -- the page's name as the reporter saw it
  device text,                        -- browser and screen size, or the raw user agent
  notes text,
  transcript text,                    -- the words of the voice note, when the browser could write them out
  screenshot_path text,
  audio_path text,
  audio_secs int check (audio_secs is null or audio_secs between 0 and 3600),
  status text not null default 'New' check (status in ('New', 'Looking', 'Won''t Fix', 'Fixed')),
  reply text,                         -- the Treasurer's note on what was done (not sent anywhere)
  updated_at timestamptz,
  updated_by text,
  sample boolean not null default false,
  constraint problem_reports_something check (nullif(trim(coalesce(notes, '')), '') is not null or screenshot_path is not null or audio_path is not null)
);
create index problem_reports_created_idx on public.problem_reports (created_at desc);
create index problem_reports_status_idx on public.problem_reports (status, created_at desc);

-- The person, time and device are the database's, never the browser's.
create or replace function public.problem_report_fill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
  v_hdr jsonb;
  v_ref text;
  v_dir text;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then raise exception 'Sign in to report a problem' using errcode = '42501'; end if;
    select * into w from public.log_who();
    begin v_hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_hdr := null; end;
    new.created_at := now();
    new.user_id := auth.uid();
    new.who := coalesce(nullif(w.o_who, ''), public.my_name());
    new.role := w.o_role;
    new.team_id := (select u.team_id from public.team_users u where u.user_id = auth.uid());
    new.status := 'New';
    new.reply := null;
    new.updated_at := null;
    new.updated_by := null;
    new.sample := false;
    v_ref := substring(coalesce(v_hdr ->> 'referer', '') from '^https?://[^/]+(/.*)$');
    new.page := left(coalesce(nullif(trim(new.page), ''), v_ref, '/'), 500);
    new.page_title := left(nullif(trim(new.page_title), ''), 120);
    new.device := left(coalesce(nullif(trim(new.device), ''), w.o_device), 300);
    new.notes := left(nullif(trim(new.notes), ''), 5000);
    new.transcript := left(nullif(trim(new.transcript), ''), 5000);
    v_dir := 'problems/' || auth.uid()::text || '/';
    if (new.screenshot_path is not null and left(new.screenshot_path, length(v_dir)) <> v_dir)
       or (new.audio_path is not null and left(new.audio_path, length(v_dir)) <> v_dir) then
      raise exception 'Report files must be your own uploads' using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE: only the status and reply move (column grants and row security see to that); stamp who changed them.
  new.updated_at := now();
  new.updated_by := public.my_name();
  return new;
end;
$$;
revoke all on function public.problem_report_fill() from public, anon, authenticated;
create trigger problem_reports_fill before insert or update on public.problem_reports
  for each row execute function public.problem_report_fill();

-- Never deleted, like the money records (0004); every add and change goes to the action log (0005).
create trigger problem_reports_no_delete before delete on public.problem_reports
  for each row execute function public.no_delete_guard();
create trigger problem_reports_log after insert or update or delete on public.problem_reports
  for each row execute function public.log_change();

-- ---------------------------------------------------------------- row security

alter table public.problem_reports enable row level security;
create policy problems_insert_own on public.problem_reports for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy problems_treasurer_read on public.problem_reports for select to authenticated
  using ((select public.is_treasurer()));
create policy problems_treasurer_update on public.problem_reports for update to authenticated
  using ((select public.is_treasurer())) with check ((select public.is_treasurer()));

revoke all on public.problem_reports from public, anon, authenticated;
grant insert (page, page_title, device, notes, transcript, screenshot_path, audio_path, audio_secs) on public.problem_reports to authenticated;
grant select on public.problem_reports to authenticated;
grant update (status, reply) on public.problem_reports to authenticated;
grant usage on sequence public.problem_report_id_seq to authenticated;

-- The action log is read by the whole board; a problem report's notes are the Treasurer's only.
create policy problems_log_treasurer_only on public.change_log as restrictive for select to authenticated
  using (tbl <> 'problem_reports' or (select public.is_treasurer()));

-- A team login reads its team's history through change_log_team, which filters on team_id only. A problem report's
-- log rows never carry a team, so teammates never see each other's reports. Done with a trigger on the log rather
-- than by redefining the shared log_team(), so later migrations that redefine log_team() cannot undo it.
create or replace function public.change_log_no_problem_team()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tbl = 'problem_reports' then new.team_id := null; end if;
  return new;
end;
$$;
revoke all on function public.change_log_no_problem_team() from public, anon, authenticated;
create trigger change_log_no_problem_team before insert on public.change_log
  for each row execute function public.change_log_no_problem_team();

-- ---------------------------------------------------------------- files

-- Anyone signed in uploads into their own problems/<user id>/ folder (no update or delete policy exists, so a file
-- once stored stays as it is).
create policy problem_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'board-files' and (storage.foldername(name))[1] = 'problems'
              and (storage.foldername(name))[2] = (select auth.uid())::text);

-- Whatever else a role may upload (the board anywhere, 0001; a team under team/<its team>/, 0003), the problems/
-- folder takes files only under the uploader's own user id. Restrictive, so it narrows every insert policy.
create policy problem_files_own_folder on storage.objects as restrictive for insert to authenticated
  with check (bucket_id is distinct from 'board-files' or (storage.foldername(name))[1] is distinct from 'problems'
              or (storage.foldername(name))[2] = (select auth.uid())::text);

-- The board reads the whole bucket except problem report files, which only the Treasurer opens.
drop policy if exists board_files_select on storage.objects;
create policy board_files_select on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and (select public.is_board())
         and ((storage.foldername(name))[1] is distinct from 'problems' or (select public.is_treasurer())));
