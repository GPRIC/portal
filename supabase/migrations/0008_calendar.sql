-- GPRIC Portal P36, the calendar: board meetings, community events and team schedules in one place (mockup 98).
--   Kinds: 'board' (Board Meetings, officers only), 'community' (Community Events, everyone),
--          'team' (Team Schedules: Practice, Scrimmage or Competition for one team).
--   Who sees what, enforced by row security: the board sees every event; a team login sees community events and
--          its own team's schedule only. A team login never sees a board meeting or another team's schedule.
--   Who changes what: officers (treasurer, board, bookkeeper) add and change any event; a team login adds and changes
--          only its own team's schedule. Every write goes through calendar_save and calendar_archive.
--   Weekly repeat: a new event can repeat weekly until the season ends (the end of the fiscal year it falls in,
--          unless an end date is given). Each week is its own event, linked by series_id, so one week can be moved.
--   Archive replaces delete. Every change is written to the change log.

create sequence public.calendar_event_id_seq;

create table public.calendar_events (
  id text primary key default public.pad_id('E-', nextval('public.calendar_event_id_seq'), 4),
  kind text not null check (kind in ('board','community','team')),
  team_id text references public.teams (id) on delete restrict,
  type text check (type in ('Practice','Scrimmage','Competition')),
  title text not null,
  date date not null,
  start_time time,
  end_time time,
  location text,
  notes text,
  series_id text,
  added_by text,
  added_by_user uuid,
  sample boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  archive_reason text,
  constraint calendar_events_team_kind check ((kind = 'team') = (team_id is not null and type is not null)),
  constraint calendar_events_times check (end_time is null or start_time is null or end_time > start_time)
);
create index calendar_events_date_idx on public.calendar_events (date);
create index calendar_events_team_idx on public.calendar_events (team_id, date);
create index calendar_events_series_idx on public.calendar_events (series_id);

-- ---------------------------------------------------------------- row security

alter table public.calendar_events enable row level security;
revoke all on public.calendar_events from anon, authenticated;
grant select on public.calendar_events to authenticated;
revoke all on sequence public.calendar_event_id_seq from anon, authenticated;

-- The board sees every event, archived ones included (the page hides those; History keeps them).
create policy board_read on public.calendar_events for select to authenticated
  using ((select public.is_board()));
-- A team login: community events and its own team's schedule. Never a board meeting, never another team.
create policy team_read on public.calendar_events for select to authenticated
  using (archived_at is null and (select public.my_team()) is not null
         and (kind = 'community' or (kind = 'team' and team_id = (select public.my_team()))));

-- Never deleted (archive instead); every change logged.
create trigger calendar_events_no_delete before delete on public.calendar_events
  for each row execute function public.no_delete_guard();
create trigger calendar_events_log after insert or update or delete on public.calendar_events
  for each row execute function public.log_change();

-- An event's kind and team never change, whoever asks (owner included). The change log files each row under the
-- record's team, with the full record before and after; a board meeting turned team event, or an event moved from
-- one team to another, would show its earlier details to that team's login. Archive it and add a new one instead.
create or replace function public.calendar_owner_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind or new.team_id is distinct from old.team_id then
    raise exception 'An event''s kind and team cannot change. Archive it and add a new one instead' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.calendar_owner_fixed() from public, anon, authenticated;
create trigger calendar_events_owner_fixed before update of kind, team_id on public.calendar_events
  for each row execute function public.calendar_owner_fixed();

-- ---------------------------------------------------------------- who may change an event

-- Raises unless the caller may change this event: officers any event, a team login only its own team's schedule.
create or replace function public.calendar_can_change(p_kind text, p_team_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_team text := public.my_team();
begin
  if public.is_board() then return; end if;
  if v_team is null then
    raise exception 'Changing the calendar is not allowed for your role' using errcode = '42501';
  end if;
  if p_kind is distinct from 'team' or p_team_id is distinct from v_team then
    raise exception 'Coaches add and change only their own team''s schedule' using errcode = '42501';
  end if;
end;
$$;

-- The last day of the season a date falls in: the end of its fiscal year (settings.fy_start).
create or replace function public.calendar_season_end(p_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date := coalesce((select s.fy_start from public.settings s where s.id = 1), make_date(extract(year from p_date)::int, 7, 1));
  v_end date;
begin
  v_start := make_date(extract(year from p_date)::int, extract(month from v_start)::int, extract(day from v_start)::int);
  if v_start > p_date then v_start := (v_start - interval '1 year')::date; end if;
  v_end := (v_start + interval '1 year' - interval '1 day')::date;
  return v_end;
end;
$$;

-- ---------------------------------------------------------------- actions

-- Add or change an event. Returns the ids written (more than one for a weekly repeat).
-- p: {id?, kind, team_id, type, title, date, start_time, end_time, location, notes, repeat ('weekly' or none), until?}
-- A team login's events are always for its own team. On a change, kind and team must stay as they are.
create or replace function public.calendar_save(p jsonb)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.calendar_events%rowtype;
  v_kind text := nullif(trim(coalesce(p ->> 'kind', '')), '');
  v_team text := nullif(trim(coalesce(p ->> 'team_id', '')), '');
  v_type text := nullif(trim(coalesce(p ->> 'type', '')), '');
  v_title text := nullif(trim(coalesce(p ->> 'title', '')), '');
  v_date date := nullif(p ->> 'date', '')::date;
  v_start time := nullif(p ->> 'start_time', '')::time;
  v_end time := nullif(p ->> 'end_time', '')::time;
  v_until date;
  v_series text;
  v_ids text[] := '{}';
  v_id text;
  d date;
begin
  if not public.is_board() and public.my_team() is null then
    raise exception 'Changing the calendar is not allowed for your role' using errcode = '42501';
  end if;
  -- A team login's events are its own team's schedule.
  if not public.is_board() then
    v_kind := coalesce(v_kind, 'team');
    v_team := coalesce(v_team, public.my_team());
  end if;
  if v_kind is null or v_kind not in ('board','community','team') then raise exception 'Pick the kind of event'; end if;
  if v_kind = 'team' then
    if v_team is null then raise exception 'Pick the team'; end if;
    v_type := coalesce(v_type, 'Practice');
  else
    v_team := null; v_type := null;
  end if;
  if v_date is null then raise exception 'Pick the date'; end if;
  if v_start is not null and v_end is not null and v_end <= v_start then raise exception 'The end time must be after the start time'; end if;
  v_title := coalesce(v_title, case v_kind when 'team' then v_type when 'board' then 'Board Meeting' else 'Community Event' end);
  perform public.calendar_can_change(v_kind, v_team);
  if v_team is not null and not exists (select 1 from public.teams t where t.id = v_team and t.archived_at is null) then
    raise exception 'Team not found';
  end if;

  if nullif(p ->> 'id', '') is not null then
    select * into old from public.calendar_events e where e.id = p ->> 'id' and e.archived_at is null for update;
    if not found then raise exception 'Event not found or archived'; end if;
    perform public.calendar_can_change(old.kind, old.team_id);   -- may change the event as it stands
    -- An event keeps its kind and team for life, so its history never crosses from the board or one team to another.
    if v_kind is distinct from old.kind or v_team is distinct from old.team_id then
      raise exception 'An event''s kind and team cannot change. Archive it and add a new one instead';
    end if;
    update public.calendar_events set
      kind = v_kind, team_id = v_team, type = v_type, title = v_title, date = v_date, start_time = v_start, end_time = v_end,
      location = nullif(trim(coalesce(p ->> 'location', '')), ''), notes = nullif(trim(coalesce(p ->> 'notes', '')), '')
     where id = old.id;
    return array[old.id];
  end if;

  if coalesce(p ->> 'repeat', '') = 'weekly' then
    v_until := coalesce(nullif(p ->> 'until', '')::date, public.calendar_season_end(v_date));
    if v_until < v_date then raise exception 'The repeat must end on or after the first date'; end if;
    if (v_until - v_date) / 7 + 1 > 60 then raise exception 'A weekly repeat can add at most 60 weeks'; end if;
    v_series := 'S-' || nextval('public.calendar_event_id_seq');
  else
    v_until := v_date;
  end if;
  d := v_date;
  while d <= v_until loop
    insert into public.calendar_events (kind, team_id, type, title, date, start_time, end_time, location, notes, series_id, added_by, added_by_user)
    values (v_kind, v_team, v_type, v_title, d, v_start, v_end,
            nullif(trim(coalesce(p ->> 'location', '')), ''), nullif(trim(coalesce(p ->> 'notes', '')), ''),
            v_series, public.my_name(), auth.uid())
    returning id into v_id;
    v_ids := v_ids || v_id;
    d := d + 7;
  end loop;
  return v_ids;
end;
$$;

-- Take an event off the calendar (archived, never deleted). Same rule as changing it.
create or replace function public.calendar_archive(p_id text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare old public.calendar_events%rowtype;
begin
  select * into old from public.calendar_events e where e.id = p_id and e.archived_at is null for update;
  if not found then raise exception 'Event not found or already archived'; end if;
  perform public.calendar_can_change(old.kind, old.team_id);
  perform public.via('archive');
  update public.calendar_events set archived_at = now(), archived_by = public.my_name(),
         archive_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- function grants

do $$
declare f text;
begin
  foreach f in array array['public.calendar_save(jsonb)', 'public.calendar_archive(text,text)', 'public.calendar_season_end(date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  execute 'revoke all on function public.calendar_can_change(text,text) from public, anon, authenticated';
end $$;
