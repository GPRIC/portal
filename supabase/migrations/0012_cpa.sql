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

do $$
declare t text;
begin
  foreach t in array array['settings','teams','funds','board_members','grants','donors','donations','meetings','meeting_votes',
                           'team_requests','ledger','receipts','accounts','documents','request_approvals','bank_statements',
                           'bank_lines','zeffy_skip','zeffy_sync_log','request_refunds','receipt_reminders','money_overrides'] loop
    execute format('create policy cpa_read on public.%I for select to authenticated using ((select public.is_cpa()))', t);
  end loop;
end $$;

-- History: the CPA sees the log of what it can read. Team logins, invites, the calendar, problem reports and sign-ins stay out.
create policy cpa_log_books_only on public.change_log as restrictive for select to authenticated
  using (not (select public.is_cpa())
         or tbl not in ('team_users','team_invites','calendar_events','problem_reports','sessions','seen_tips',
                        -- board access and board member records carry names, emails and roles
                        'portal_access','board_members'));

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
