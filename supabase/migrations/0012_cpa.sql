-- GPRIC Portal 0012: the CPA login (P35). Applies after 0011.
--   The CPA signs in with two-step, like the board (my_role() is null without aal2), and reads the books: Dashboard,
--   Ledger, Requests, Donors and gifts, Grants, Team Balances, Accounts, bank months, Documents and receipts, Meetings
--   (read only) and History. Every receipt, statement, document and minutes file in the board bucket opens.
--   The CPA writes nothing, anywhere:
--     * is_board() never included cpa (0004), so every require_board() and every require_role() list already refused it,
--       and every board_only policy refuses its inserts, updates and deletes.
--     * On top of that, a statement trigger on every public table refuses any insert, update, delete or truncate made by a
--       CPA login, with or without two-step, whatever function or policy the write comes through. A function added later
--       that forgets its role check still cannot write for the CPA. scripts/test-cpa.mjs loops over every table and every
--       function, so a new table without the trigger fails the tests.
--     * Storage: the CPA opens files in the board bucket (problem report files excepted) and can upload, change or remove nothing.
--   Not for the CPA: Problem Reports (the Treasurer's), team logins and invites, the Calendar, and sign-in history.
--   Contact details are never the CPA's: tables with email, phone or Zelle columns (board members, donors, requests,
--   accounts) have no CPA policy; the CPA reads them through <table>_cpa views with those columns null, and History
--   through change_log_cpa with contact keys removed and email addresses masked.
--   The one table left writable is seen_tips: the CPA's own "tip already shown" marks, so first-visit tips stop reappearing.

-- ---------------------------------------------------------------- who is the CPA

-- The CPA, signed in with two-step: reads the books.
create or replace function public.is_cpa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() = 'cpa', false);
$$;

-- A CPA login at any sign-in level: refused every write.
create or replace function public.is_cpa_login()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.portal_access a where a.user_id = auth.uid() and a.role = 'cpa');
$$;

-- Board side or CPA, with two-step: may read the books.
create or replace function public.can_read_books()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_board() or public.is_cpa();
$$;

-- ---------------------------------------------------------------- read

-- Contact details (emails, phone numbers, Zelle contacts) are never the CPA's: a column whose name matches this is
-- blanked in everything the CPA reads, and any email address in History text is masked.
create or replace function public.cpa_contact_col(p_col text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_col ~* '(email|phone|mobile|address|contact|zelle)';
$$;

create or replace function public.cpa_mask_text(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email hidden]', 'g');
$$;

-- A History before/after record for the CPA: contact keys removed, any other email address masked.
create or replace function public.cpa_mask_json(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p is null or jsonb_typeof(p) <> 'object' then p
    else public.cpa_mask_text(coalesce((select jsonb_object_agg(k, v) from jsonb_each(p) e(k, v) where not public.cpa_contact_col(k)), '{}'::jsonb)::text)::jsonb end;
$$;
grant execute on function public.cpa_contact_col(text), public.cpa_mask_text(text), public.cpa_mask_json(jsonb) to authenticated;
revoke execute on function public.cpa_contact_col(text), public.cpa_mask_text(text), public.cpa_mask_json(jsonb) from public, anon;

-- The books tables. One without contact columns gets a plain CPA read policy. One with them (board members, donors,
-- requests, accounts) gets no CPA policy at all, so a direct API select of the table returns nothing for the CPA,
-- and the CPA reads it through <table>_cpa instead: the same columns, contact columns always null.
-- security_barrier keeps the CPA filter ahead of anything the caller adds; the view is select only.
do $$
declare t text; cols text;
begin
  foreach t in array array['settings','teams','funds','board_members','grants','donors','donations','meetings','meeting_votes',
                           'team_requests','ledger','receipts','accounts','documents','request_approvals','bank_statements',
                           'bank_lines','zeffy_skip','zeffy_sync_log','request_refunds','receipt_reminders','money_overrides'] loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = t and public.cpa_contact_col(c.column_name)) then
      execute format('create policy cpa_read on public.%I for select to authenticated using ((select public.is_cpa()))', t);
    else
      select string_agg(case when public.cpa_contact_col(c.column_name) then format('null::%s as %I', c.data_type, c.column_name)
                             else format('x.%I', c.column_name) end, ', ' order by c.ordinal_position)
        into cols
        from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = t;
      execute format('create view public.%I with (security_barrier = true) as select %s from public.%I x where (select public.is_cpa())',
                     t || '_cpa', cols, t);
      execute format('revoke all on public.%I from public, anon, authenticated', t || '_cpa');
      execute format('grant select on public.%I to authenticated', t || '_cpa');
    end if;
  end loop;
end $$;

-- History: the CPA reads it only through change_log_cpa: the log of what it can read, contact details removed.
-- Team logins and invites, the calendar, problem reports, sign-ins, board access and board member records stay out.
create policy cpa_log_none on public.change_log as restrictive for select to authenticated
  using (not (select public.is_cpa()));

create view public.change_log_cpa with (security_barrier = true) as
select c.id, c.at, c.user_id, public.cpa_mask_text(c.who) as who, c.role, c.action, c.what, c.tbl, c.record_id,
       public.cpa_mask_text(c.label) as label, public.cpa_mask_text(c.summary) as summary,
       public.cpa_mask_json(c.before) as before, public.cpa_mask_json(c.after) as after,
       c.team_id, c.device, c.via, public.cpa_mask_text(c.reason) as reason, c.rolls_back_id, c.rolled_back_at,
       public.cpa_mask_text(c.rolled_back_by) as rolled_back_by, public.cpa_mask_text(c.rollback_reason) as rollback_reason
  from public.change_log c
 where (select public.is_cpa())
   and c.tbl not in ('team_users','team_invites','calendar_events','problem_reports','sessions','seen_tips','portal_access','board_members');
revoke all on public.change_log_cpa from public, anon, authenticated;
grant select on public.change_log_cpa to authenticated;

-- ---------------------------------------------------------------- never write

create or replace function public.cpa_read_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.is_cpa_login() then
    raise exception 'The CPA login is read only' using errcode = '42501';
  end if;
  return null;
end;
$$;
revoke all on function public.cpa_read_only() from public, anon, authenticated;

do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','p') and c.relname <> 'seen_tips' order by 1 loop
    execute format('create trigger %I before insert or update or delete on public.%I for each statement execute function public.cpa_read_only()',
                   t || '_cpa_read_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cpa_read_only()',
                   t || '_cpa_no_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- files

-- The CPA opens receipts, statements, documents and minutes; problem report files stay the Treasurer's.
create policy cpa_files_select on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and (select public.is_cpa())
         and (storage.foldername(name))[1] is distinct from 'problems');

-- Restrictive, so they narrow every other storage policy: a CPA login never uploads, changes or removes a file.
create policy cpa_files_no_insert on storage.objects as restrictive for insert to authenticated
  with check (not (select public.is_cpa_login()));
create policy cpa_files_no_update on storage.objects as restrictive for update to authenticated
  using (not (select public.is_cpa_login())) with check (not (select public.is_cpa_login()));
create policy cpa_files_no_delete on storage.objects as restrictive for delete to authenticated
  using (not (select public.is_cpa_login()));

-- ---------------------------------------------------------------- grants

do $$
declare f text;
begin
  foreach f in array array['public.is_cpa()', 'public.is_cpa_login()', 'public.can_read_books()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
