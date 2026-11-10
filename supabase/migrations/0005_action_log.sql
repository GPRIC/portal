-- GPRIC Portal P24 and P25, the action log and roll back.
-- The database writes one row to public.change_log for every add, change, archive and delete on every portal table,
-- with the signed-in person (or "System" for imports and automatic jobs), the device, and the record before and after.
-- Sign-ins, sign-outs, invites and the Zeffy sync are logged as actions too. The log is append only: nobody can change
-- or remove a row, the one exception being the "rolled back" mark that rollback_change sets.
-- Read access: the board (and the CPA) see everything; a team login sees its own team's history only.
-- Roll back (P25): Treasurer only, with a reason. It goes through the money rules (a ledger entry is reversed, a payment
-- is reversed before its request steps back, a locked month is unlocked), and the roll back is itself logged.

-- ---------------------------------------------------------------- the log

create table public.change_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  who text not null,
  role text,                         -- treasurer, board, bookkeeper, cpa, team, or system
  action text not null,              -- Added, Changed, Archived, Restored, Deleted, Approved, Paid, Locked, Signed In, ...
  what text not null,                -- the area: Ledger, Requests, Donations, Grants, Teams, Bank, Sign-ins, Settings, ...
  tbl text not null,                 -- the table (or 'sessions' for sign-ins)
  record_id text,
  label text,                        -- "Ledger · $47.20 Home Depot"
  summary text,                      -- "Amount $42.70 → $47.20"
  before jsonb,
  after jsonb,
  team_id text,                      -- the team the record belongs to, for a team login's own history
  device text,                       -- the browser's user agent, or the job that made the change
  via text,                          -- which portal action made it
  reason text,                       -- the reason given (roll back, override, unlock, reversal)
  rolls_back_id bigint references public.change_log (id),
  rolled_back_at timestamptz,
  rolled_back_by text,
  rollback_reason text
);
create index change_log_at_idx on public.change_log (at desc);
create index change_log_record_idx on public.change_log (tbl, record_id);
create index change_log_team_idx on public.change_log (team_id, at desc);

alter table public.change_log enable row level security;
create policy board_read on public.change_log for select to authenticated
  using ((select public.is_board()) or (select coalesce(public.my_role() = 'cpa', false)));
-- A team login reads its own team's history through public.change_log_team (end of file), never this table.
revoke insert, update, delete, truncate on public.change_log from public, anon, authenticated;
grant select on public.change_log to authenticated;

-- Append only. The one update allowed is roll back marking a row as rolled back.
create or replace function public.change_log_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('gpric.via', true), '') = 'rollback_mark'
     and (to_jsonb(new) - array['rolled_back_at','rolled_back_by','rollback_reason'])
       = (to_jsonb(old) - array['rolled_back_at','rolled_back_by','rollback_reason']) then
    return new;
  end if;
  raise exception 'The action log is append only' using errcode = '42501';
end;
$$;
create trigger change_log_guard before update or delete on public.change_log
  for each row execute function public.change_log_guard();
create trigger change_log_no_truncate before truncate on public.change_log
  for each statement execute function public.change_log_guard();

-- ---------------------------------------------------------------- helpers

-- Area shown in History's What filter.
create or replace function public.log_area(p_tbl text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_tbl
    when 'ledger' then 'Ledger' when 'money_overrides' then 'Ledger'
    when 'team_requests' then 'Requests' when 'receipts' then 'Requests' when 'request_approvals' then 'Requests'
    when 'donations' then 'Donations' when 'donors' then 'Donations' when 'zeffy_sync_log' then 'Donations' when 'zeffy_skip' then 'Donations'
    when 'grants' then 'Grants'
    when 'teams' then 'Teams' when 'funds' then 'Teams' when 'team_users' then 'Teams' when 'team_invites' then 'Teams'
    when 'bank_statements' then 'Bank' when 'bank_lines' then 'Bank'
    when 'sessions' then 'Sign-ins'
    when 'accounts' then 'Accounts' when 'documents' then 'Documents'
    when 'meetings' then 'Meetings' when 'meeting_votes' then 'Meetings'
    else 'Settings' end;
$$;

create or replace function public.log_money(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$ select case when p ? 'amount' and nullif(p ->> 'amount', '') is not null
                  then '$' || to_char((p ->> 'amount')::numeric, 'FM999,999,990.00') end; $$;

-- A short name for a record, as History shows it.
create or replace function public.log_label(p_tbl text, r jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team text := (select t.short from public.teams t where t.id = coalesce(r ->> 'team_id',
                    (select q.team_id from public.team_requests q where q.id = r ->> 'request_id')));
  m text := public.log_money(r);
begin
  return case p_tbl
    when 'ledger' then concat_ws(' ', 'Ledger ·', m, coalesce(r ->> 'party', r ->> 'source', r ->> 'category', r ->> 'memo'))
                       || coalesce(' · ' || (select f.name from public.funds f where f.id = r ->> 'fund_id'), '')
    when 'team_requests' then concat_ws(' ', 'Request ·', m, coalesce(r ->> 'vendor', r ->> 'purpose')) || coalesce(' · ' || v_team, '')
    when 'receipts' then concat_ws(' ', 'Receipt ·', m, r ->> 'vendor') || coalesce(' · ' || v_team, '')
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
    when 'board_members' then 'Board member · ' || coalesce(r ->> 'name', '')
    when 'portal_access' then 'Board access · ' || coalesce(nullif(r ->> 'name', ''), r ->> 'email', '')
    when 'settings' then 'Settings'
    when 'zeffy_sync_log' then 'Zeffy sync · ' || coalesce(r ->> 'source', '')
    when 'zeffy_skip' then 'Zeffy gift skipped · ' || coalesce(r ->> 'zeffy_key', '')
    when 'money_overrides' then 'Override · ' || coalesce(r ->> 'rule', '')
    else p_tbl end;
end;
$$;

-- The team a record belongs to (for a team login's own history).
create or replace function public.log_team(p_tbl text, r jsonb)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_tbl = 'teams' then r ->> 'id'
    when r ? 'team_id' then r ->> 'team_id'
    when r ? 'request_id' and r ->> 'request_id' is not null then (select q.team_id from public.team_requests q where q.id = r ->> 'request_id')
    when r ? 'fund_id' then (select f.team_id from public.funds f where f.id = r ->> 'fund_id')
  end;
$$;

-- "Amount $42.70 → $47.20; Status Approved → Paid" for the fields that changed (three at most).
create or replace function public.log_summary(o jsonb, n jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select string_agg(initcap(replace(k, '_', ' ')) || ' ' || coalesce(nullif(left(o ->> k, 40), ''), '(blank)') || ' → '
                    || coalesce(nullif(left(n ->> k, 40), ''), '(blank)'), '; ')
    from (select k from jsonb_object_keys(n) k
           where k not in ('created_at','archived_by','sample') and (o -> k) is distinct from (n -> k)
           order by k limit 3) x;
$$;

-- Who is acting: the signed-in person, or System (with the job) for imports and automatic jobs.
create or replace function public.log_who(out o_user uuid, out o_who text, out o_role text, out o_device text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job text := nullif(current_setting('gpric.job', true), '');
  v_hdr jsonb;
begin
  begin v_hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_hdr := null; end;
  o_user := auth.uid();
  if o_user is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    o_who := 'System — ' || coalesce(v_job, case when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then 'automatic job' else 'database' end);
    o_role := 'system';
    o_device := coalesce(v_job, 'Automatic job');
    o_user := null;
    return;
  end if;
  o_who := public.my_name();
  o_role := coalesce(public.my_role(), case when public.my_team() is not null then 'team' end,
                     (select a.role from public.portal_access a where a.user_id = o_user),
                     case when exists (select 1 from public.team_users u where u.user_id = o_user) then 'team' end);
  o_device := left(v_hdr ->> 'user-agent', 300);
  -- an import run by a person is still recorded as System, with who started it
  if v_job is not null then
    o_who := 'System — ' || v_job;
    o_device := v_job || ' · started by ' || public.my_name();
    o_role := 'system';
  end if;
end;
$$;

-- The action a change shows as, from the portal action that made it.
create or replace function public.log_action(p_op text, p_tbl text, o jsonb, n jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_op = 'DELETE' then 'Deleted'
    when p_tbl = 'team_invites' and p_op = 'INSERT' then 'Invited'
    when p_tbl = 'zeffy_sync_log' then 'Synced'
    when p_tbl = 'money_overrides' then 'Overrode'
    when p_tbl = 'ledger' and p_op = 'INSERT' and n ->> 'reverses_id' is not null then 'Reversed'
    when p_tbl = 'donations' and p_op = 'INSERT' and n ->> 'zeffy_key' is not null then 'Imported'
    when p_op = 'UPDATE' and o ->> 'archived_at' is null and n ->> 'archived_at' is not null then 'Archived'
    when p_op = 'UPDATE' and o ->> 'archived_at' is not null and n ->> 'archived_at' is null then 'Restored'
    else case coalesce(current_setting('gpric.via', true), '')
      when 'approve' then 'Approved' when 'vote' then 'Voted' when 'decline' then 'Declined' when 'pay' then 'Paid'
      when 'close' then 'Closed' when 'cancel' then 'Cancelled' when 'refund' then 'Refunded'
      when 'lock' then 'Locked' when 'unlock' then 'Unlocked' when 'clear_sample' then 'Cleared Sample'
      when 'rollback' then 'Rolled Back'
      else case p_op when 'INSERT' then 'Added' else 'Changed' end end
  end;
$$;

-- ---------------------------------------------------------------- the trigger on every portal table

create or replace function public.log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  w record;
  v_action text;
begin
  if tg_op = 'UPDATE' and (o - array['created_at']) = (n - array['created_at']) then return new; end if;
  select * into w from public.log_who();
  v_action := public.log_action(tg_op, tg_table_name, o, n);
  insert into public.change_log (user_id, who, role, action, what, tbl, record_id, label, summary, before, after, team_id,
                                 device, via, reason, rolls_back_id)
  values (w.o_user, w.o_who, w.o_role, v_action, public.log_area(tg_table_name), tg_table_name,
          coalesce(r ->> 'id', r ->> 'user_id', r ->> 'zeffy_key'),
          public.log_label(tg_table_name, r),
          case when tg_op = 'INSERT' then case v_action when 'Reversed' then 'Reverses ' || (n ->> 'reverses_id') || coalesce(' · ' || (n ->> 'reason'), '')
                                                        when 'Invited' then 'Invited ' || coalesce(n ->> 'email', '')
                                                        when 'Synced' then format('%s new, %s updated, %s skipped', n ->> 'inserted', n ->> 'updated', n ->> 'skipped')
                                                                           || coalesce(' · ' || (n ->> 'error'), '')
                                                        when 'Overrode' then coalesce(n ->> 'rule', '') || ' · ' || coalesce(n ->> 'reason', '')
                                                        else 'New ' || lower(public.log_area(tg_table_name)) || ' record' end
               when tg_op = 'DELETE' then 'Removed'
               else public.log_summary(o, n) end,
          o, n, public.log_team(tg_table_name, r),
          w.o_device, nullif(current_setting('gpric.via', true), ''),
          coalesce(nullif(current_setting('gpric.reason', true), ''),
                   case when tg_table_name = 'bank_statements' and v_action = 'Unlocked' then n ->> 'unlock_reason' end,
                   case when v_action = 'Archived' then n ->> 'archive_reason' end),
          nullif(current_setting('gpric.rollback_of', true), '')::bigint);
  return coalesce(new, old);
end;
$$;
revoke all on function public.log_change() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['portal_access','settings','teams','funds','board_members','grants','donors','donations','meetings',
                           'team_requests','meeting_votes','ledger','receipts','accounts','documents','request_approvals',
                           'team_users','team_invites','bank_statements','bank_lines','zeffy_skip','zeffy_sync_log','money_overrides'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.log_change()',
                   t || '_log', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- sign-ins and sign-outs

create or replace function public.log_name_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select nullif(a.name, '') from public.portal_access a where a.user_id = p_user),
                  (select nullif(u.name, '') from public.team_users u where u.user_id = p_user),
                  (select a.email from public.portal_access a where a.user_id = p_user),
                  (select u.email from public.team_users u where u.user_id = p_user),
                  (select x.email from auth.users x where x.id = p_user), 'Unknown');
$$;

-- A session row is made at sign-in, moves to aal2 when the two-step code is accepted, and goes at sign-out.
create or replace function public.log_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s jsonb := to_jsonb(coalesce(new, old));
  v_user uuid := (s ->> 'user_id')::uuid;
  v_action text;
  v_sum text;
begin
  if tg_op = 'INSERT' then v_action := 'Signed In'; v_sum := case when s ->> 'aal' = 'aal2' then 'Two-step code accepted' else 'Password or email link accepted' end;
  elsif tg_op = 'DELETE' then v_action := 'Signed Out'; v_sum := 'Session ended';
  elsif (to_jsonb(old) ->> 'aal') is distinct from (s ->> 'aal') and s ->> 'aal' = 'aal2' then v_action := 'Signed In'; v_sum := 'Two-step code accepted';
  else return new;
  end if;
  insert into public.change_log (user_id, who, role, action, what, tbl, record_id, label, summary, after, team_id, device)
  values (v_user, public.log_name_of(v_user),
          coalesce((select a.role from public.portal_access a where a.user_id = v_user),
                   case when exists (select 1 from public.team_users u where u.user_id = v_user) then 'team' end),
          v_action, 'Sign-ins', 'sessions', v_user::text, 'Sign-in · ' || public.log_name_of(v_user), v_sum,
          jsonb_build_object('Method', case when s ->> 'aal' = 'aal2' then 'Two-step code' else 'Password or email link' end,
                             'IP', s ->> 'ip'),
          (select u.team_id from public.team_users u where u.user_id = v_user),
          left(s ->> 'user_agent', 300));
  return coalesce(new, old);
exception when others then
  return coalesce(new, old);   -- a log failure never blocks a sign-in
end;
$$;
revoke all on function public.log_session() from public, anon, authenticated;

-- auth.sessions belongs to Supabase Auth; if the trigger cannot be created there the rest of the log still stands.
do $$
begin
  execute 'drop trigger if exists gpric_log_session on auth.sessions';
  execute 'create trigger gpric_log_session after insert or update of aal or delete on auth.sessions for each row execute function public.log_session()';
exception when others then
  raise notice 'Sign-in logging not installed: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- roll back (P25)

-- Only a change that is still the latest can be undone: if the record moved on since, refuse.
create or replace function public.log_still_latest(p_tbl text, p_before jsonb, p_after jsonb, p_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_ok boolean;
begin
  execute format('select exists (select 1 from public.%I t where t.id::text = $2 and coalesce((select bool_and((to_jsonb(t) -> k) is not distinct from ($1 -> k)) from jsonb_object_keys($1) k where k not in (''id'',''created_at'',''received'',''sample'') and ($1 -> k) is distinct from ($3 -> k)), true))', p_tbl)
    into v_ok using p_after, p_id, p_before;
  if not v_ok then raise exception 'This record has changed since; roll back the later change first'; end if;
end;
$$;

-- Put back every field of a record that a logged change changed (a grant's received money follows the ledger, so it stays).
create or replace function public.log_restore(p_tbl text, p_before jsonb, p_after jsonb, p_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_cols text;
begin
  select string_agg(format('%I = r.%I', k, k), ', ') into v_cols
    from jsonb_object_keys(p_before) k
   where k not in ('id','created_at','received','sample') and (p_before -> k) is distinct from (p_after -> k);
  if v_cols is null then raise exception 'Nothing to put back'; end if;
  perform public.log_still_latest(p_tbl, p_before, p_after, p_id);
  if p_tbl = 'bank_statements' then raise exception 'Lock the month again from Team Balances so its difference is checked'; end if;
  execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id::text = $2', p_tbl, v_cols, p_tbl)
    using p_before, p_id;
end;
$$;

-- Undo one logged change, Treasurer only, with a reason. Money goes through the money rules:
--   ledger: an added entry is reversed; a description change is put back; money is never edited in place
--   requests: a payment is reversed before the request steps back; other status changes step back
--   gifts, receipts, bank lines: an added one is taken out of the books (reversed or archived)
--   a reconciled month: unlocked
--   everything else: archived if it was added, put back if it was changed, restored if it was deleted
-- Returns the number of new log rows the roll back wrote.
create or replace function public.rollback_change(p_id bigint, p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.change_log%rowtype;
  v_led text;
  v_start bigint := (select coalesce(max(id), 0) from public.change_log);
  n int;
begin
  perform public.require_role(array['treasurer'], 'Rolling back a change');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason for the roll back'; end if;
  select * into e from public.change_log where id = p_id for update;
  if e.id is null then raise exception 'Change not found'; end if;
  if e.rolled_back_at is not null then raise exception 'This change is already rolled back'; end if;
  if e.tbl in ('sessions','zeffy_sync_log','money_overrides','zeffy_skip','change_log') then
    raise exception '% cannot be rolled back', case e.tbl when 'sessions' then 'A sign-in or sign-out' when 'zeffy_sync_log' then 'A Zeffy sync run'
                                                       when 'money_overrides' then 'An override record' else 'This record' end;
  end if;
  if e.action = 'Rolled Back' and e.rolls_back_id is not null then
    raise exception 'This is itself a roll back; make the change again instead';
  end if;
  perform set_config('gpric.reason', trim(p_reason), true);
  perform set_config('gpric.rollback_of', e.id::text, true);
  perform public.via('rollback');

  if e.tbl = 'bank_statements' and e.action = 'Locked' then
    perform public.unlock_bank_month(e.record_id, 'Roll back: ' || trim(p_reason));

  elsif e.tbl = 'ledger' then
    if e.before is null then                      -- any entry added (by hand, a payment, a close, a reversal)
      if e.after ->> 'request_id' is not null and e.after ->> 'reverses_id' is null
         and coalesce(e.after ->> 'source', '') <> 'Unspent Returned' then   -- unspent money returned at a close is reversed here
        raise exception 'This entry is a request''s payment; roll back the payment on the request';
      end if;
      perform public.ledger_reverse(e.record_id, trim(p_reason));
    elsif e.action = 'Changed' then
      if (e.before -> 'amount') is distinct from (e.after -> 'amount') or (e.before -> 'date') is distinct from (e.after -> 'date')
         or (e.before -> 'fund_id') is distinct from (e.after -> 'fund_id') or (e.before -> 'dir') is distinct from (e.after -> 'dir')
         or (e.before -> 'reversed_by_id') is distinct from (e.after -> 'reversed_by_id') then
        raise exception 'Money in the ledger is changed with a correction or reversal; roll back the entry that made it';
      end if;
      perform public.log_still_latest('ledger', e.before, e.after, e.record_id);
      perform public.ledger_edit(e.record_id, e.before);
    else
      raise exception 'Ledger entries are never deleted; nothing to roll back';
    end if;

  elsif e.tbl = 'team_requests' and e.action = 'Paid' then
    select l.id into v_led from public.ledger l
     where l.request_id = e.record_id and l.dir = 'out' and l.reverses_id is null and l.reversed_by_id is null
     order by l.created_at desc limit 1;
    if v_led is not null then perform public.ledger_reverse(v_led, 'Roll back of payment: ' || trim(p_reason)); end if;
    perform public.via('rollback');
    perform public.log_restore(e.tbl, e.before, e.after, e.record_id);

  elsif e.tbl = 'donations' then
    if e.before is not null then raise exception 'Change a gift from the Donors page'; end if;
    perform public.gift_archive(e.record_id, trim(p_reason));
  elsif e.tbl = 'receipts' then
    if e.before is not null then raise exception 'Change a receipt from its request'; end if;
    perform public.receipt_archive(e.record_id, trim(p_reason));
  elsif e.tbl = 'bank_lines' then
    if e.before is not null then raise exception 'Change a bank line from Team Balances'; end if;
    perform public.bank_line_archive(e.record_id, trim(p_reason));
  elsif e.tbl = 'team_requests' and (e.before ->> 'status') is distinct from (e.after ->> 'status')
        and exists (select 1 from public.ledger l where l.request_id = e.record_id and l.created_at >= e.at
                       and l.reverses_id is null and l.reversed_by_id is null) then
    raise exception 'This step booked money in the ledger (such as unspent money returned); reverse that ledger entry first';
  elsif e.tbl in ('request_approvals','portal_access','team_users') then
    raise exception 'This change is undone from its own page';

  else
    if e.before is null then
      -- added: archive it
      execute format('update public.%I set archived_at = now(), archived_by = $1, archive_reason = $2 where id::text = $3 and archived_at is null', e.tbl)
        using public.my_name(), 'Roll back: ' || trim(p_reason), e.record_id;
    elsif e.after is null then
      -- deleted: put it back as it was (sample rows are cleared for good)
      if coalesce((e.before ->> 'sample')::boolean, false) then raise exception 'Sample records are cleared for good; they are not put back'; end if;
      execute format('insert into public.%I overriding system value select * from jsonb_populate_record(null::public.%I, $1)', e.tbl, e.tbl)
        using e.before;
    else
      perform public.log_restore(e.tbl, e.before, e.after, e.record_id);
    end if;
  end if;

  select count(*) into n from public.change_log where id > v_start;
  perform public.via('rollback_mark');
  update public.change_log set rolled_back_at = now(), rolled_back_by = public.my_name(), rollback_reason = trim(p_reason) where id = e.id;
  perform public.via('');
  perform set_config('gpric.reason', '', true);
  perform set_config('gpric.rollback_of', '', true);
  return n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.rollback_change(bigint,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.change_log_guard()', 'public.log_who()', 'public.log_restore(text,jsonb,jsonb,text)', 'public.log_still_latest(text,jsonb,jsonb,text)', 'public.log_label(text,jsonb)', 'public.log_team(text,jsonb)',
                           'public.log_name_of(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Zeffy imports are recorded as System: the sync job (service role) and a file a board member uploads alike.
alter function public.zeffy_upsert(jsonb, text) rename to zeffy_upsert_core;
revoke all on function public.zeffy_upsert_core(jsonb, text) from public, anon, authenticated, service_role;
create or replace function public.zeffy_upsert(p_rows jsonb, p_source text default 'file')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v jsonb;
begin
  perform set_config('gpric.job', case when p_source = 'file' then 'Zeffy file import' else 'Zeffy sync' end, true);
  v := public.zeffy_upsert_core(p_rows, p_source);
  perform set_config('gpric.job', '', true);
  return v;
end;
$$;
revoke all on function public.zeffy_upsert(jsonb, text) from public, anon;
grant execute on function public.zeffy_upsert(jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------- a team login's own history

-- Teams read History through this view, not public.change_log: only their own team's rows, a donor who asked to stay
-- anonymous shows as "Anonymous" (label, summary, before and after), and donor, gift and grant links are left out.
create or replace function public.log_team_mask_text(t text, p_anon text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
-- the full name, then each word of it three letters or longer, in any case; plain text matching (no patterns)
declare w text; i int; v text := t;
begin
  if v is null or p_anon is null then return v; end if;
  for w in select x from (select trim(p_anon) x, 0 o union all select y, 1 from regexp_split_to_table(trim(p_anon), '\s+') y) z
            where length(x) >= 3 order by o, length(x) desc loop
    -- a one-character marker stands in until the end, so a name found inside "Anonymous" can never match again
    loop
      i := position(lower(w) in lower(v));
      exit when i = 0;
      v := overlay(v placing chr(1) from i for length(w));
    end loop;
  end loop;
  return replace(v, chr(1), 'Anonymous');
end;
$$;

create or replace function public.log_team_mask(j jsonb, p_anon text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when j is null then null
              else (select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' and p_anon is not null
                                                            then to_jsonb(public.log_team_mask_text(v #>> '{}', p_anon)) else v end), '{}'::jsonb)
                      from jsonb_each(j - array['donor_id','grant_id','donation_id','zeffy_key','zeffy_id']) e(k, v)) end;
$$;

create view public.change_log_team with (security_barrier = true) as
select c.id, c.at, c.user_id, c.who, c.role, c.action, c.what, c.tbl, c.record_id,
       public.log_team_mask_text(c.label, a.name) as label,
       public.log_team_mask_text(c.summary, a.name) as summary,
       public.log_team_mask(c.before, a.name) as before,
       public.log_team_mask(c.after, a.name) as after,
       c.team_id, c.device, c.via, public.log_team_mask_text(c.reason, a.name) as reason, c.rolls_back_id, c.rolled_back_at, c.rolled_back_by,
       public.log_team_mask_text(c.rollback_reason, a.name) as rollback_reason
  from public.change_log c
  left join lateral (
    select d.name from public.donors d
     where d.anonymous and nullif(trim(d.name), '') is not null
       and d.id in (c.before ->> 'donor_id', c.after ->> 'donor_id',
                    (select x.donor_id from public.donations x where x.id = coalesce(c.after ->> 'donation_id', c.before ->> 'donation_id')))
     limit 1) a on true
 where c.team_id is not null and c.team_id = (select public.my_team());
revoke all on public.change_log_team from public, anon;
grant select on public.change_log_team to authenticated;
