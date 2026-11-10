-- GPRIC Portal P26, money rules in the database.
-- Every change to money goes through a function here; the portal's pages can no longer write the money tables.
--   Roles: treasurer, board, bookkeeper (and cpa, read only, added in 0009). Approval rules, month unlock and
--          overrides are Treasurer only. The bookkeeper approves while settings.bookkeeper_can_approve is on (testing).
--   Archive replaces delete on every record. Money is never deleted: a ledger entry is reversed or corrected,
--          which posts a visible opposite entry. Receipt and statement files are never removed from storage.
--   Request status changes only inside approve, decline, vote, pay, close and cancel.
--   Overspending: approval warns, payment is blocked; the Treasurer may override with a logged reason.
--   Restricted money: a team fund pays only for its own team; any other restricted fund needs the Treasurer.
--   Reconciled months are fully locked: ledger rows, the statement and its bank lines. Only the Treasurer unlocks, with a reason.
--   One set of totals: portal_totals() is the only place fund balances and the year's figures are worked out.

-- ---------------------------------------------------------------- roles

alter table public.portal_access
  add column role text not null default 'board' check (role in ('treasurer','board','bookkeeper','cpa')),
  add column name text;

-- Seats (who is Treasurer, who is the bookkeeper) are set on the live database from the git-ignored private/ folder,
-- since real people's details never go in this public repo (ruling 7480): private/seats.sql.

alter table public.settings
  add column bookkeeper_can_approve boolean not null default true;

-- The signed-in person's role, only with two-step done; null for team users and everyone else.
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.role from public.portal_access a
   where a.user_id = auth.uid() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- Board side of the portal: treasurer, board or bookkeeper with two-step. (The CPA reads through can_read_books.)
create or replace function public.is_board()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() in ('treasurer','board','bookkeeper'), false);
$$;

create or replace function public.is_treasurer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() = 'treasurer', false);
$$;

create or replace function public.require_role(p_roles text[], p_what text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.my_role() is null or not (public.my_role() = any(p_roles)) then
    raise exception '% is not allowed for your role', p_what using errcode = '42501';
  end if;
end;
$$;

-- Display name of the signed-in person for "by" fields.
create or replace function public.my_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(a.name, '') from public.portal_access a where a.user_id = auth.uid()),
    (select m.name from public.board_members m where m.id = public.my_member_id()),
    (select nullif(u.name, '') from public.team_users u where u.user_id = auth.uid()),
    auth.jwt() ->> 'email', 'system');
$$;

-- ---------------------------------------------------------------- archive columns on every record

do $$
declare t text;
begin
  foreach t in array array['teams','funds','board_members','grants','donors','donations','meetings','meeting_votes',
                           'team_requests','ledger','receipts','accounts','documents','team_invites','bank_statements','bank_lines'] loop
    execute format('alter table public.%I add column archived_at timestamptz, add column archived_by text, add column archive_reason text', t);
  end loop;
end $$;

-- Reversals and corrections: the opposite entry points at the one it undoes.
alter table public.ledger
  add column reverses_id text references public.ledger (id) on delete restrict,
  add column reversed_by_id text references public.ledger (id) on delete restrict,
  add column reason text;
create index ledger_reverses_idx on public.ledger (reverses_id);

-- Month unlocks (Treasurer only) keep their reason on the statement.
alter table public.bank_statements
  add column unlocked_at timestamptz,
  add column unlocked_by text,
  add column unlock_reason text;

-- Every Treasurer override of a money rule, with its reason.
create table public.money_overrides (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  by_name text,
  action text not null,
  record_id text,
  fund_id text,
  amount numeric(12,2),
  rule text not null,
  reason text not null
);

-- ---------------------------------------------------------------- the "inside a money function" flag

-- Functions here set gpric.via for their own transaction; guards below refuse money changes without it.
create or replace function public.via(p_what text)
returns void
language sql
volatile
set search_path = ''
as $$ select set_config('gpric.via', p_what, true); $$;
revoke all on function public.via(text) from public, anon, authenticated;

create or replace function public.inside_money_fn()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(current_setting('gpric.via', true), '') <> ''; $$;

-- A request's status moves only inside approve, decline, vote, pay, close and cancel.
create or replace function public.request_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('gpric.via', true), '') not in
         ('approve','decline','vote','pay','close','cancel','review','refund','rollback','admin') then
    raise exception 'A request''s status changes only by approving, declining, paying, closing or cancelling it' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger team_requests_status_guard
  before update of status on public.team_requests
  for each row execute function public.request_status_guard();

-- Money rows are never deleted, whoever asks (archive or reverse instead). Sample rows are the one exception:
-- clear_sample_data sets gpric.via = 'clear_sample'.
create or replace function public.no_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('gpric.via', true), '') = 'clear_sample' and old.sample then return old; end if;
  raise exception 'Records are archived, never deleted' using errcode = '42501';
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['ledger','donations','team_requests','receipts','funds','teams','bank_statements','bank_lines','request_approvals'] loop
    execute format('create trigger %I before delete on public.%I for each row execute function public.no_delete_guard()', t || '_no_delete', t);
  end loop;
end $$;

-- The v1 "delete a ledger row deletes its gift" trigger is retired with deletes.
drop trigger if exists ledger_delete_donation on public.ledger;

-- ---------------------------------------------------------------- reconciled months: fully locked

create or replace function public.month_locked(p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.bank_statements s
                  where s.month = date_trunc('month', p_date)::date and s.locked_at is not null);
$$;

create or replace function public.statement_lock_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('gpric.via', true), '') in ('lock','unlock') then return coalesce(new, old); end if;
  if tg_op <> 'INSERT' and old.locked_at is not null then
    raise exception '% is reconciled and locked. Only the Treasurer can unlock it.', trim(to_char(old.month, 'FMMonth YYYY')) using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger bank_statements_lock_guard
  before update or delete on public.bank_statements
  for each row execute function public.statement_lock_guard();

create or replace function public.bank_line_lock_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v text;
begin
  foreach v in array array[case when tg_op <> 'INSERT' then old.statement_id end, case when tg_op <> 'DELETE' then new.statement_id end] loop
    if v is not null and exists (select 1 from public.bank_statements s where s.id = v and s.locked_at is not null) then
      raise exception 'This statement''s month is reconciled and locked. Only the Treasurer can unlock it.' using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;
create trigger bank_lines_lock_guard
  before insert or update or delete on public.bank_lines
  for each row execute function public.bank_line_lock_guard();

-- ---------------------------------------------------------------- one set of totals

-- A row's money as the books see it: a reversal counts against the kind of entry it undoes.
-- kind_dir is the direction of the original entry; sign is +1 for an original, -1 for a reversal.
create or replace view public.ledger_signed
with (security_invoker = true)
as
select l.*,
       case when l.reverses_id is null then l.dir else (case l.dir when 'in' then 'out' else 'in' end) end as kind_dir,
       case when l.reverses_id is null then 1 else -1 end as sign,
       case when l.dir = 'in' then l.amount else -l.amount end as net
  from public.ledger l;

-- A fund's balance: everything in less everything out, reversals included.
create or replace function public.fund_balance(p_fund_id text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(case when dir = 'in' then amount else -amount end), 0), 2)
    from public.ledger where fund_id = p_fund_id;
$$;

-- Requests approved but not yet paid, charged to a fund (a request is charged to its team's fund,
-- or to charge_fund_id once direct expenses exist).
create or replace function public.fund_committed(p_fund_id text, p_except_request text default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(r.amount), 0), 2)
    from public.team_requests r join public.teams t on t.id = r.team_id
   where r.status = 'Approved' and r.archived_at is null and t.fund_id = p_fund_id
     and r.id is distinct from p_except_request;
$$;

-- Every figure the board pages show. Pages display these; they do not add up money themselves.
create or replace function public.portal_totals()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.settings%rowtype;
  v_funds jsonb; v_in jsonb; v_out jsonb;
begin
  if not (public.is_board() or coalesce(public.my_role() = 'cpa', false)) then
    raise exception 'Board sign-in with two-step is required' using errcode = '42501';
  end if;
  select * into s from public.settings where id = 1;
  select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) into v_funds from (
    select jsonb_build_object(
      'id', f.id, 'name', f.name, 'restricted', f.restricted, 'team_id', coalesce(f.team_id, (select t.id from public.teams t where t.fund_id = f.id limit 1)),
      'opening', round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Opening Balance'), 0), 2),
      'inn',     round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and coalesce(l.source, '') <> 'Opening Balance'), 0), 2),
      'out',     round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out'), 0), 2),
      'carry',   round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and l.source = 'Opening Balance'), 0), 2),
      'zeffy',   round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and coalesce(l.source, '') <> 'Opening Balance' and d.channel = 'Zeffy'), 0), 2),
      'deposits',round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'in' and coalesce(l.source, '') <> 'Opening Balance' and d.channel is distinct from 'Zeffy'), 0), 2),
      'reimbursements', round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out' and l.request_id is not null), 0), 2),
      'direct',  round(coalesce(sum(l.sign * l.amount) filter (where l.kind_dir = 'out' and l.request_id is null), 0), 2),
      'balance', round(coalesce(sum(l.net), 0), 2),
      'committed', public.fund_committed(f.id),
      'available', round(coalesce(sum(l.net), 0) - public.fund_committed(f.id), 2)) x
      from public.funds f
      left join public.ledger_signed l on l.fund_id = f.id
      left join public.donations d on d.id = l.donation_id
     where f.archived_at is null or exists (select 1 from public.ledger z where z.fund_id = f.id)
     group by f.id) q;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_in from (
    select coalesce(l.source, 'Other') k, round(sum(l.sign * l.amount), 2) v from public.ledger_signed l
     where l.date >= s.fy_start and l.kind_dir = 'in' and coalesce(l.source, '') not in ('Opening Balance', 'Unspent Returned', 'Refund')
     group by 1 having round(sum(l.sign * l.amount), 2) <> 0) q;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out from (
    select k, round(sum(v), 2) v from (
      select coalesce(l.category, 'Other') k, l.sign * l.amount v from public.ledger_signed l
       where l.date >= s.fy_start and l.kind_dir = 'out'
      union all
      -- returned team money and refunds net against the category they were spent from
      select coalesce(l.category, 'Robotics Teams') k, -(l.sign * l.amount) v from public.ledger_signed l
       where l.date >= s.fy_start and l.kind_dir = 'in' and l.source in ('Unspent Returned', 'Refund')) z
     group by k having round(sum(v), 2) <> 0) q;
  return jsonb_build_object(
    'funds', v_funds,
    'cash', jsonb_build_object(
      'total', round(coalesce((select sum((x ->> 'balance')::numeric) from jsonb_array_elements(v_funds) x), 0), 2),
      'restricted', round(coalesce((select sum((x ->> 'balance')::numeric) from jsonb_array_elements(v_funds) x where (x ->> 'restricted')::boolean), 0), 2),
      'unrestricted', round(coalesce((select sum((x ->> 'balance')::numeric) from jsonb_array_elements(v_funds) x where not (x ->> 'restricted')::boolean), 0), 2)),
    'in_by_source', v_in,
    'out_by_category', v_out,
    'raised', round(coalesce((select sum(value::numeric) from jsonb_each_text(v_in)), 0), 2),
    'spent', round(coalesce((select sum(value::numeric) from jsonb_each_text(v_out)), 0), 2));
end;
$$;

-- team_money now counts reversals the same way.
create or replace function public.team_money(p_team_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select fund_id from public.teams where id = p_team_id),
  l as (
    select l.kind_dir, l.sign * l.amount amount, l.net, l.source, l.request_id, d.channel
      from public.ledger_signed l join t on l.fund_id = t.fund_id
      left join public.donations d on d.id = l.donation_id
  )
  select jsonb_build_object(
    'carry',   coalesce(sum(amount) filter (where kind_dir = 'in' and source = 'Opening Balance'), 0),
    'zeffy',   coalesce(sum(amount) filter (where kind_dir = 'in' and coalesce(source, '') <> 'Opening Balance' and channel = 'Zeffy'), 0),
    'deposits',coalesce(sum(amount) filter (where kind_dir = 'in' and coalesce(source, '') <> 'Opening Balance' and channel is distinct from 'Zeffy'), 0),
    'reimbursements', coalesce(sum(amount) filter (where kind_dir = 'out' and request_id is not null), 0),
    'direct',  coalesce(sum(amount) filter (where kind_dir = 'out' and request_id is null), 0),
    'balance', coalesce(sum(net), 0))
  from l;
$$;
revoke all on function public.team_money(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- spending rules

-- Raises when money going out of a fund breaks a rule, unless the Treasurer gives a reason (logged).
-- p_team_id: the team the spend is for (a request's team), or null for a board entry.
create or replace function public.spend_check(
  p_fund_id text, p_amount numeric, p_team_id text, p_category text, p_override text, p_action text, p_record text,
  p_balance_rule boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.funds%rowtype;
  v_bal numeric;
  v_rules text[] := '{}';
  r text;
begin
  select * into f from public.funds where id = p_fund_id;
  if f.id is null then raise exception 'Fund not found'; end if;
  if f.archived_at is not null then raise exception '% is archived; it cannot be spent from', f.name; end if;
  if p_balance_rule then
    v_bal := public.fund_balance(f.id);
    if p_amount > v_bal then
      v_rules := v_rules || format('%s has $%s; this would overspend it by $%s', f.name, to_char(v_bal, 'FM999,999,990.00'), to_char(p_amount - v_bal, 'FM999,999,990.00'));
    end if;
  end if;
  if f.restricted then
    if f.team_id is not null then
      if p_team_id is distinct from f.team_id and coalesce(p_category, '') <> 'Robotics Teams' then
        v_rules := v_rules || format('%s is restricted to its own team', f.name);
      end if;
    else
      v_rules := v_rules || format('%s is restricted money (%s)', f.name, coalesce(f.purpose, 'see the gift terms'));
    end if;
  end if;
  if array_length(v_rules, 1) is null then return; end if;
  if nullif(trim(coalesce(p_override, '')), '') is null then
    raise exception 'Blocked: %. Only the Treasurer can override, with a reason.', array_to_string(v_rules, '; ') using errcode = 'P0001';
  end if;
  if not public.is_treasurer() then
    raise exception 'Blocked: %. Only the Treasurer can override.', array_to_string(v_rules, '; ') using errcode = '42501';
  end if;
  foreach r in array v_rules loop
    insert into public.money_overrides (user_id, by_name, action, record_id, fund_id, amount, rule, reason)
    values (auth.uid(), public.my_name(), p_action, p_record, p_fund_id, p_amount, r, trim(p_override));
  end loop;
end;
$$;

-- Warnings only (approval time): the same rules, never raising.
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
  select * into f from public.funds where id = p_fund_id;
  if f.id is null then return w; end if;
  v_avail := public.fund_balance(f.id) - public.fund_committed(f.id, p_except_request);
  if p_amount > v_avail then
    w := w || format('%s has $%s left after other approved requests; paying this would overspend it. Payment will be blocked unless the Treasurer overrides.',
                     f.name, to_char(v_avail, 'FM999,999,990.00'));
  end if;
  if f.restricted and f.team_id is not null and p_team_id is distinct from f.team_id and coalesce(p_category, '') <> 'Robotics Teams' then
    w := w || format('%s is restricted to its own team.', f.name);
  elsif f.restricted and f.team_id is null then
    w := w || format('%s is restricted money: %s.', f.name, coalesce(f.purpose, 'check the gift terms'));
  end if;
  return w;
end;
$$;

-- ---------------------------------------------------------------- ledger: add, edit, correct, reverse

-- p: {date, dir, amount, fund_id, source, category, party, memo, grant_id, donor_id, receipt, receipt_path, receipt_name,
--     pay_method, pay_ref, override}
create or replace function public.ledger_add(p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dir text := p ->> 'dir';
  v_amount numeric := round(nullif(p ->> 'amount', '')::numeric, 2);
  v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
  v_fund text := nullif(p ->> 'fund_id', '');
  v_id text;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Adding a ledger entry');
  perform public.via('ledger');
  if v_dir not in ('in','out') then raise exception 'Pick money in or money out'; end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if v_fund is null then raise exception 'Pick a fund'; end if;
  if v_dir = 'out' then
    perform public.spend_check(v_fund, v_amount, null, nullif(p ->> 'category', ''), p ->> 'override', 'ledger_add', null);
  end if;
  insert into public.ledger (date, dir, amount, fund_id, source, category, party, memo, grant_id, donor_id,
                             receipt, receipt_path, receipt_name, pay_method, pay_ref)
  values (v_date, v_dir, v_amount, v_fund,
          case when v_dir = 'in' then nullif(trim(p ->> 'source'), '') end,
          case when v_dir = 'out' then nullif(trim(p ->> 'category'), '') end,
          nullif(trim(p ->> 'party'), ''), nullif(trim(p ->> 'memo'), ''),
          nullif(p ->> 'grant_id', ''), nullif(p ->> 'donor_id', ''),
          coalesce((p ->> 'receipt')::boolean, false) or nullif(p ->> 'receipt_path', '') is not null,
          nullif(p ->> 'receipt_path', ''), nullif(p ->> 'receipt_name', ''),
          nullif(p ->> 'pay_method', ''), nullif(trim(p ->> 'pay_ref'), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- Edit the description of an entry: who, what for, category or source, receipt file, payment details.
-- The money itself (date, amount, fund, direction) is changed only by ledger_correct.
create or replace function public.ledger_edit(p_id text, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare l public.ledger%rowtype;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Editing a ledger entry');
  perform public.via('ledger');
  select * into l from public.ledger where id = p_id for update;
  if l.id is null then raise exception 'Entry not found'; end if;
  update public.ledger set
    source = case when p ? 'source' then nullif(trim(p ->> 'source'), '') else source end,
    category = case when p ? 'category' then nullif(trim(p ->> 'category'), '') else category end,
    party = case when p ? 'party' then nullif(trim(p ->> 'party'), '') else party end,
    memo = case when p ? 'memo' then nullif(trim(p ->> 'memo'), '') else memo end,
    grant_id = case when p ? 'grant_id' and l.donation_id is null then nullif(p ->> 'grant_id', '') else grant_id end,
    receipt_path = case when p ? 'receipt_path' then coalesce(nullif(p ->> 'receipt_path', ''), receipt_path) else receipt_path end,
    receipt_name = case when p ? 'receipt_path' and nullif(p ->> 'receipt_path', '') is not null then nullif(p ->> 'receipt_name', '') else receipt_name end,
    receipt = case when p ? 'receipt' then (p ->> 'receipt')::boolean or receipt_path is not null or nullif(p ->> 'receipt_path', '') is not null else receipt end,
    pay_method = case when p ? 'pay_method' then nullif(p ->> 'pay_method', '') else pay_method end,
    pay_ref = case when p ? 'pay_ref' then nullif(trim(p ->> 'pay_ref'), '') else pay_ref end
  where id = p_id;
end;
$$;

-- Undo an entry: posts the opposite entry (dated p_date, today by default) and links the two.
-- A gift's entry reverses the gift as well (the gift is archived; its money is out of the books).
create or replace function public.ledger_reverse(p_id text, p_reason text, p_date date default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.ledger%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_id text;
  v_caller text := coalesce(current_setting('gpric.via', true), '');
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Reversing a ledger entry');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason for the reversal'; end if;
  select * into l from public.ledger where id = p_id for update;
  if l.id is null then raise exception 'Entry not found'; end if;
  if l.reverses_id is not null then raise exception 'This entry is itself a reversal; reverse the original instead'; end if;
  if l.reversed_by_id is not null then raise exception 'This entry is already reversed'; end if;
  -- a request's own money is undone from the request (refund, cancel or roll back), so its status follows
  if l.request_id is not null and v_caller not in ('refund','cancel','rollback') then
    raise exception 'This entry belongs to request %. Undo it from the request (refund or cancel) instead', l.request_id;
  end if;
  if public.month_locked(v_date) then
    raise exception '% is reconciled and locked. Date the reversal in an open month.', trim(to_char(v_date, 'FMMonth YYYY'));
  end if;
  perform public.via('ledger');
  insert into public.ledger (date, dir, amount, fund_id, source, category, party, memo, donor_id, donation_id, request_id, grant_id,
                             receipt, pay_method, pay_ref, reverses_id, reason, sample)
  values (v_date, case l.dir when 'in' then 'out' else 'in' end, l.amount, l.fund_id, l.source, l.category, l.party,
          'Reversal of ' || l.id || coalesce(' · ' || l.memo, ''), l.donor_id, null, l.request_id, null,
          true, l.pay_method, l.pay_ref, l.id, trim(p_reason), l.sample)
  returning id into v_id;
  update public.ledger set reversed_by_id = v_id, reason = coalesce(reason, trim(p_reason)) where id = l.id;
  -- a grant's received figure follows its money
  if l.grant_id is not null and l.dir = 'in' then
    update public.grants set received = greatest(0, received - l.amount) where id = l.grant_id;
  end if;
  if l.donation_id is not null then
    update public.donations set archived_at = now(), archived_by = public.my_name(), archive_reason = 'Reversed: ' || trim(p_reason)
     where id = l.donation_id;
  end if;
  perform public.via(v_caller);
  return v_id;
end;
$$;

-- Locked months: rows dated in a reconciled month cannot be added, changed or removed. The one change allowed
-- is marking such a row as reversed (the reversal itself is dated in an open month).
create or replace function public.ledger_month_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare m date;
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('gpric.via', true), '') in ('ledger','rollback')
     and (to_jsonb(new) - array['reversed_by_id','reason']) = (to_jsonb(old) - array['reversed_by_id','reason']) then
    return new;
  end if;
  if coalesce(current_setting('gpric.via', true), '') = 'clear_sample' and tg_op = 'DELETE' and old.sample then return old; end if;
  foreach m in array array[
    case when tg_op <> 'INSERT' then date_trunc('month', old.date)::date end,
    case when tg_op <> 'DELETE' then date_trunc('month', new.date)::date end] loop
    if m is not null and exists (select 1 from public.bank_statements s where s.month = m and s.locked_at is not null) then
      raise exception '% is reconciled and locked. Record a correction dated in an open month instead.',
        trim(to_char(m, 'FMMonth YYYY')) using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;

-- Change the money of an entry: reverses it and posts the corrected entry in its place.
-- p: the corrected {date, dir, amount, fund_id, source, category, party, memo, override}; anything left out is copied.
create or replace function public.ledger_correct(p_id text, p jsonb, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.ledger%rowtype;
  v_new jsonb;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Correcting a ledger entry');
  select * into l from public.ledger where id = p_id;
  if l.id is null then raise exception 'Entry not found'; end if;
  if l.donation_id is not null then raise exception 'Correct a gift from the donor''s page'; end if;
  if l.request_id is not null and l.dir = 'out' then raise exception 'Correct a request payment from the request (refund or cancel)'; end if;
  perform public.ledger_reverse(p_id, p_reason, case when public.month_locked(l.date) then current_date else l.date end);
  v_new := jsonb_build_object('date', l.date, 'dir', l.dir, 'amount', l.amount, 'fund_id', l.fund_id, 'source', l.source,
                              'category', l.category, 'party', l.party, 'memo', l.memo, 'grant_id', l.grant_id, 'donor_id', l.donor_id,
                              'receipt', l.receipt, 'receipt_path', l.receipt_path, 'receipt_name', l.receipt_name,
                              'pay_method', l.pay_method, 'pay_ref', l.pay_ref) || coalesce(p, '{}'::jsonb);
  if public.month_locked((v_new ->> 'date')::date) then
    raise exception '% is reconciled and locked. Date the corrected entry in an open month.', trim(to_char((v_new ->> 'date')::date, 'FMMonth YYYY'));
  end if;
  return public.ledger_add(v_new);
end;
$$;

-- ---------------------------------------------------------------- gifts

-- The v1 functions become security definer: the money tables no longer take direct writes.
alter function public.log_donation(text,text,text,numeric,date,text,text,boolean,boolean,boolean,text,text) security definer;
alter function public.grant_received(text,numeric,date) security definer;

create or replace function public.gift_set_thanked(p_ids text[], p_thanked boolean)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Marking gifts thanked');
  perform public.via('gift');
  update public.donations set thanked = coalesce(p_thanked, true) where id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Assign an unassigned Zeffy gift (or move a gift) to a fund. Its ledger entry moves with it (month locks apply).
create or replace function public.gift_assign_fund(p_id text, p_fund_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Assigning a gift to a fund');
  perform public.via('gift');
  if not exists (select 1 from public.funds where id = p_fund_id and archived_at is null) then raise exception 'Pick a fund'; end if;
  update public.donations set fund_id = p_fund_id, unassigned = false where id = p_id and archived_at is null;
  if not found then raise exception 'Gift not found'; end if;
end;
$$;

-- Take a gift out of the books: reverses its ledger entry and archives the gift.
create or replace function public.gift_archive(p_id text, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_led text;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Removing a gift');
  select id into v_led from public.ledger where donation_id = p_id and reverses_id is null and reversed_by_id is null order by created_at limit 1;
  if v_led is null then raise exception 'Gift not found or already reversed'; end if;
  return public.ledger_reverse(v_led, p_reason, case when public.month_locked((select date from public.donations where id = p_id)) then current_date end);
end;
$$;

-- ---------------------------------------------------------------- funds and teams

-- p: {id?, name, restricted, purpose, team_id}. Changing whether a fund is restricted is Treasurer only.
create or replace function public.fund_save(p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.funds%rowtype;
  v_id text := nullif(p ->> 'id', '');
  v_restricted boolean := coalesce((p ->> 'restricted')::boolean, false);
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Saving a fund');
  perform public.via('fund');
  if nullif(trim(p ->> 'name'), '') is null then raise exception 'Name the fund'; end if;
  if v_id is null then
    insert into public.funds (name, restricted, purpose, team_id)
    values (trim(p ->> 'name'), v_restricted, nullif(trim(p ->> 'purpose'), ''), nullif(p ->> 'team_id', ''))
    returning id into v_id;
    return v_id;
  end if;
  select * into f from public.funds where id = v_id for update;
  if f.id is null then raise exception 'Fund not found'; end if;
  if f.restricted is distinct from v_restricted and not public.is_treasurer() then
    raise exception 'Only the Treasurer can change whether a fund is restricted' using errcode = '42501';
  end if;
  update public.funds set name = trim(p ->> 'name'), restricted = v_restricted, purpose = nullif(trim(p ->> 'purpose'), ''),
         team_id = case when p ? 'team_id' then nullif(p ->> 'team_id', '') else team_id end
   where id = v_id;
  return v_id;
end;
$$;

-- p: team fields, plus fund_id (an existing fund) or new_fund (default true for a new team: its own restricted fund).
create or replace function public.team_save(p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := nullif(p ->> 'id', '');
  v_fund text;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Saving a team');
  perform public.via('team');
  if nullif(trim(p ->> 'name'), '') is null or nullif(trim(p ->> 'short'), '') is null then raise exception 'Give the team a name and a short name'; end if;
  if v_id is null then
    insert into public.teams (name, short, program, level, season, pay_mode, ein, school, students, affiliated, blurb, zeffy_name)
    values (trim(p ->> 'name'), trim(p ->> 'short'), nullif(p ->> 'program', ''), nullif(p ->> 'level', ''), nullif(p ->> 'season', ''),
            nullif(p ->> 'pay_mode', ''), nullif(p ->> 'ein', ''), nullif(p ->> 'school', ''), nullif(p ->> 'students', '')::int,
            nullif(p ->> 'affiliated', '')::date, nullif(p ->> 'blurb', ''), nullif(p ->> 'zeffy_name', ''))
    returning id into v_id;
    if coalesce((p ->> 'new_fund')::boolean, true) then
      insert into public.funds (name, restricted, team_id, purpose)
      values (trim(p ->> 'short') || ' Team Fund', true, v_id, 'Restricted to ' || trim(p ->> 'name'))
      returning id into v_fund;
    else
      v_fund := nullif(p ->> 'fund_id', '');
    end if;
    update public.teams set fund_id = v_fund where id = v_id;
    return v_id;
  end if;
  if p ? 'fund_id' and nullif(p ->> 'fund_id', '') is not null
     and not exists (select 1 from public.funds where id = p ->> 'fund_id' and archived_at is null) then
    raise exception 'Pick a fund';
  end if;
  update public.teams set name = trim(p ->> 'name'), short = trim(p ->> 'short'), program = nullif(p ->> 'program', ''),
         level = nullif(p ->> 'level', ''), season = nullif(p ->> 'season', ''), pay_mode = nullif(p ->> 'pay_mode', ''),
         ein = nullif(p ->> 'ein', ''), school = nullif(p ->> 'school', ''), students = nullif(p ->> 'students', '')::int,
         affiliated = nullif(p ->> 'affiliated', '')::date, blurb = nullif(p ->> 'blurb', ''), zeffy_name = nullif(p ->> 'zeffy_name', ''),
         fund_id = case when p ? 'fund_id' then nullif(p ->> 'fund_id', '') else fund_id end
   where id = v_id and archived_at is null;
  if not found then raise exception 'Team not found'; end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- requests (board side)

-- A board-entered request, or an edit to one not yet approved or paid. Status is never set here.
-- p: {id?, team_id, type, purpose, category, amount, pay_to, needed_by, vendor, purchase_date, notes, interested_member_id,
--     zelle_contact, receipt_path, receipt_name, requestor_name, requestor_email, submitted}
-- Entered on a team's behalf (a requestor email that is not the signed-in person's), the board member who typed it in
-- may still approve it; the requestor named may not.
create or replace function public.request_save(p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_id text := nullif(p ->> 'id', '');
  v_amount numeric := round(nullif(p ->> 'amount', '')::numeric, 2);
  v_email text := lower(nullif(trim(p ->> 'requestor_email'), ''));
  v_mine boolean := v_email is null or v_email = lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Saving a request');
  perform public.via('request');
  if v_amount is null or v_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if nullif(p ->> 'team_id', '') is null then raise exception 'Pick a team'; end if;
  if nullif(trim(p ->> 'purpose'), '') is null then raise exception 'Say what it is for'; end if;
  if v_id is null then
    insert into public.team_requests (team_id, type, purpose, category, amount, pay_to, needed_by, vendor, purchase_date, notes,
                                      interested_member_id, submitted, status, submitted_by_user, requestor_name, requestor_email,
                                      requestor_member_id, created_by, zelle_contact, receipt_path, receipt_name)
    values (p ->> 'team_id', coalesce(nullif(p ->> 'type', ''), 'Pre-Approval'), trim(p ->> 'purpose'), nullif(p ->> 'category', ''),
            v_amount, nullif(p ->> 'pay_to', ''), nullif(p ->> 'needed_by', '')::date, nullif(trim(p ->> 'vendor'), ''),
            nullif(p ->> 'purchase_date', '')::date, nullif(trim(p ->> 'notes'), ''), nullif(p ->> 'interested_member_id', ''),
            coalesce(nullif(p ->> 'submitted', '')::date, current_date), 'Submitted',
            case when v_mine then auth.uid() end,
            case when v_mine then coalesce(nullif(trim(p ->> 'requestor_name'), ''), public.my_name()) else nullif(trim(p ->> 'requestor_name'), '') end,
            coalesce(v_email, auth.jwt() ->> 'email'),
            case when v_mine then public.my_member_id() end, public.my_name(),
            nullif(trim(p ->> 'zelle_contact'), ''), nullif(p ->> 'receipt_path', ''), nullif(p ->> 'receipt_name', ''))
    returning id into v_id;
    return v_id;
  end if;
  select * into r from public.team_requests where id = v_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status not in ('Draft','Submitted','Board Vote') then
    -- after approval only the notes and description can change
    update public.team_requests set notes = nullif(trim(p ->> 'notes'), ''), purpose = trim(p ->> 'purpose'),
           category = nullif(p ->> 'category', ''),
           receipt_path = coalesce(nullif(p ->> 'receipt_path', ''), receipt_path),
           receipt_name = case when nullif(p ->> 'receipt_path', '') is not null then nullif(p ->> 'receipt_name', '') else receipt_name end
     where id = v_id;
    return v_id;
  end if;
  if v_amount <> r.amount and exists (select 1 from public.request_approvals a where a.request_id = r.id) then
    raise exception 'This request already has approvals; its amount cannot change. Decline it and enter a new one';
  end if;
  update public.team_requests set team_id = p ->> 'team_id', type = coalesce(nullif(p ->> 'type', ''), type), purpose = trim(p ->> 'purpose'),
         category = nullif(p ->> 'category', ''), amount = v_amount, pay_to = nullif(p ->> 'pay_to', ''),
         needed_by = nullif(p ->> 'needed_by', '')::date, vendor = nullif(trim(p ->> 'vendor'), ''),
         purchase_date = nullif(p ->> 'purchase_date', '')::date, notes = nullif(trim(p ->> 'notes'), ''),
         interested_member_id = case when p ? 'interested_member_id' then nullif(p ->> 'interested_member_id', '') else interested_member_id end,
         zelle_contact = case when p ? 'zelle_contact' then nullif(trim(p ->> 'zelle_contact'), '') else zelle_contact end,
         receipt_path = coalesce(nullif(p ->> 'receipt_path', ''), receipt_path),
         receipt_name = case when nullif(p ->> 'receipt_path', '') is not null then nullif(p ->> 'receipt_name', '') else receipt_name end,
         requestor_name = case when p ? 'requestor_name' then nullif(trim(p ->> 'requestor_name'), '') else requestor_name end,
         requestor_email = case when p ? 'requestor_email' then v_email else requestor_email end,
         submitted = coalesce(nullif(p ->> 'submitted', '')::date, submitted)
   where id = v_id;
  return v_id;
end;
$$;

-- Approve: who may approve depends on role; the bookkeeper approves while bookkeeper_can_approve is on.
-- Returns warnings when the fund would be overspent or the money is restricted (payment will be blocked).
create or replace function public.approve_request(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  t public.teams%rowtype;
  v_member text := public.my_member_id();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_have int; v_need int;
  v_warn text[];
begin
  perform public.require_board();
  if public.my_role() = 'bookkeeper' and not (select bookkeeper_can_approve from public.settings where id = 1) then
    raise exception 'Approving is for board members' using errcode = '42501';
  end if;
  perform public.via('approve');
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status not in ('Submitted', 'Board Vote') then raise exception 'This request is not waiting for approval'; end if;
  if r.submitted_by_user = auth.uid() or (v_member is not null and r.requestor_member_id = v_member)
     or (v_email <> '' and lower(coalesce(r.requestor_email, '')) = v_email) then
    raise exception 'You made this request, so another board member has to approve it';
  end if;
  if exists (select 1 from public.request_approvals a where a.request_id = r.id
             and (a.user_id = auth.uid() or (v_member is not null and a.member_id = v_member))) then
    raise exception 'You have already approved this request';
  end if;
  insert into public.request_approvals (request_id, user_id, member_id, approver_name, sample)
  values (r.id, auth.uid(), v_member, coalesce(nullif(public.my_name(), ''), 'Board member'), r.sample);
  select count(*) into v_have from public.request_approvals where request_id = r.id;
  v_need := public.approvals_needed(r.amount);
  if v_have >= v_need then
    update public.team_requests set status = 'Approved', decline_reason = null where id = r.id;
  end if;
  select * into t from public.teams where id = r.team_id;
  v_warn := coalesce(public.spend_warnings(public.request_fund(r.id), r.amount, r.team_id, 'Robotics Teams', r.id), '{}');
  return jsonb_build_object('approvals', v_have, 'needed', v_need, 'status', case when v_have >= v_need then 'Approved' else r.status end,
                            'warnings', to_jsonb(v_warn));
end;
$$;

-- The fund a request is paid from (its team's fund; direct expenses add a chosen fund in 0006).
create or replace function public.request_fund(p_request_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select t.fund_id from public.team_requests r join public.teams t on t.id = r.team_id where r.id = p_request_id;
$$;

create or replace function public.decline_request(p_request_id text, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_board();
  perform public.via('decline');
  if nullif(trim(p_reason), '') is null then raise exception 'Give the team a reason for declining'; end if;
  update public.team_requests
     set status = 'Declined', decline_reason = trim(p_reason), declined_at = now(), declined_by = public.my_name()
   where id = p_request_id and status in ('Submitted', 'Board Vote', 'Approved') and archived_at is null;
  if not found then raise exception 'Only a request that is not yet paid can be declined'; end if;
  return 'Declined';
end;
$$;

-- Pay an approved request. Blocked when it would overspend the fund or break a restriction, unless the Treasurer
-- gives p_override (logged). Paying is for the Treasurer and the bookkeeper.
drop function public.mark_request_paid(text, date, text, text);
create or replace function public.mark_request_paid(p_request_id text, p_date date, p_method text, p_ref text default null, p_override text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  t public.teams%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_fund text;
  v_led text;
begin
  perform public.require_role(array['treasurer','bookkeeper'], 'Paying a request');
  perform public.via('pay');
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.status <> 'Approved' then raise exception 'Only an approved request can be paid'; end if;
  if p_method is null or p_method not in ('Zelle','Check','Debit Card','ACH') then raise exception 'Pick how it was paid'; end if;
  select * into t from public.teams where id = r.team_id;
  v_fund := public.request_fund(r.id);
  if v_fund is null then raise exception 'This team has no fund; set one on the team first'; end if;
  perform public.spend_check(v_fund, r.amount, r.team_id, 'Robotics Teams', p_override, 'pay', r.id);
  insert into public.ledger (date, dir, amount, fund_id, category, party, memo, request_id, receipt,
                             receipt_path, receipt_name, pay_method, pay_ref, sample)
  values (v_date, 'out', r.amount, v_fund, 'Robotics Teams',
          case when r.type = 'Reimbursement' then coalesce(r.requestor_name, t.short)
               when r.pay_to ilike 'School%' then coalesce(t.school, t.short) || ' (district)'
               when r.pay_to ilike 'Vendor%' then coalesce(r.vendor, 'Vendor')
               when r.pay_to ilike 'Me%' then coalesce(r.requestor_name, t.short)
               else t.short || ' team account' end,
          r.id || ' · ' || coalesce(r.category || ' · ', '') || r.purpose, r.id, r.receipt_path is not null,
          r.receipt_path, r.receipt_name, p_method, nullif(trim(p_ref), ''), r.sample)
  returning id into v_led;
  update public.team_requests
     set status = case when r.type = 'Reimbursement' then 'Paid' else 'Receipts Due' end,
         paid_date = v_date, pay_method = p_method, pay_ref = nullif(trim(p_ref), '')
   where id = r.id;
  return v_led;
end;
$$;

alter function public.record_request_vote(text,jsonb,text,date,text) security definer;
create or replace function public.record_request_vote(
  p_request_id text, p_ballots jsonb, p_reason text default null, p_date date default null, p_meeting_id text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_date date := coalesce(p_date, current_date);
  v_meeting text := p_meeting_id;
  v_yes int := 0; v_no int := 0; v_abs int := 0;
  v_out text[] := '{}';
  v_result text;
  v_vote text;
  k text; b text;
begin
  perform public.require_board();
  perform public.via('vote');
  select * into r from public.team_requests where id = p_request_id;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status not in ('Submitted','Board Vote') then raise exception 'This request is not waiting for a vote'; end if;
  for k, b in select key, value #>> '{}' from jsonb_each(coalesce(p_ballots, '{}'::jsonb)) loop
    if b = 'Yes' then v_yes := v_yes + 1;
    elsif b = 'No' then v_no := v_no + 1;
    elsif b = 'Abstain' then v_abs := v_abs + 1;
    else v_out := v_out || k; end if;
  end loop;
  v_result := case when v_yes > v_no then 'Approved' else 'Declined' end;
  if v_meeting is null then
    select id into v_meeting from public.meetings where date = v_date and kind = 'Email Vote' order by created_at limit 1;
  end if;
  if v_meeting is null then
    insert into public.meetings (date, kind, title, status, present, summary, sample)
    values (v_date, 'Email Vote', 'Email Vote, ' || trim(to_char(v_date, 'FMMonth FMDD')), 'Minutes Draft',
            coalesce((select array_agg(id order by sort, id) from public.board_members where active), '{}'),
            'Email vote under bylaws section 4.6.', r.sample)
    returning id into v_meeting;
  end if;
  insert into public.meeting_votes (meeting_id, item, request_id, result, yes, no, abstain, stepped_out, ballots, note, sample)
  values (v_meeting, r.purpose, r.id, v_result, v_yes, v_no, v_abs, v_out, p_ballots, coalesce(p_reason, ''), r.sample)
  returning id into v_vote;
  update public.team_requests
     set status = v_result, vote_id = v_vote,
         decline_reason = case when v_result = 'Declined' then coalesce(nullif(trim(p_reason), ''), 'Declined by board vote.') else null end
   where id = r.id;
  return v_result;
end;
$$;

create or replace function public.add_request_receipt(
  p_request_id text, p_vendor text, p_amount numeric, p_date date, p_file_name text, p_file_path text, p_by text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_id text;
begin
  perform public.require_board();
  perform public.via('close');
  insert into public.receipts (request_id, vendor, amount, date, file_name, file_path, uploaded_by, sample)
  select r.id, p_vendor, round(coalesce(p_amount, 0), 2), coalesce(p_date, current_date), p_file_name, p_file_path,
         coalesce(nullif(p_by, ''), public.my_name()), r.sample
    from public.team_requests r where r.id = p_request_id and r.archived_at is null
  returning id into v_id;
  if v_id is null then raise exception 'Request not found'; end if;
  update public.team_requests set status = 'Receipts Due' where id = p_request_id and status = 'Paid' and type <> 'Reimbursement';
  return v_id;
end;
$$;

-- A receipt entered by mistake is archived; its file stays in storage.
create or replace function public.receipt_archive(p_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Removing a receipt');
  perform public.via('receipt');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason'; end if;
  update public.receipts set archived_at = now(), archived_by = public.my_name(), archive_reason = trim(p_reason)
   where id = p_id and archived_at is null
     and not exists (select 1 from public.team_requests r where r.id = request_id and r.status = 'Closed');
  if not found then raise exception 'Receipt not found, or its request is already closed'; end if;
end;
$$;

-- Receipts are all in: unspent money goes back into the fund it came from and the request closes.
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
  v_left := round(r.amount - coalesce((select sum(amount) from public.receipts where request_id = r.id and archived_at is null), 0) - coalesce(r.returned, 0), 2);
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

-- ---------------------------------------------------------------- settings: Treasurer only

create or replace function public.settings_save_rules(p_threshold numeric, p_under int, p_over int, p_receipt_days int default null,
                                                     p_bookkeeper_can_approve boolean default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer'], 'Changing the approval rules');
  perform public.via('settings');
  update public.settings set approval_threshold = round(p_threshold, 2), approvals_under = p_under, approvals_over = p_over,
         receipt_days = coalesce(p_receipt_days, receipt_days),
         bookkeeper_can_approve = coalesce(p_bookkeeper_can_approve, bookkeeper_can_approve)
   where id = 1;
end;
$$;

-- ---------------------------------------------------------------- bank statements and lines

create or replace function public.bank_statement_add(p_month date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_id text; v_month date := date_trunc('month', p_month)::date;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Adding a bank statement');
  perform public.via('bank');
  select id into v_id from public.bank_statements where month = v_month;
  if v_id is not null then return v_id; end if;
  insert into public.bank_statements (month) values (v_month) returning id into v_id;
  return v_id;
end;
$$;

-- p: {ending_balance?, file_path?, file_name?, notes?}. A new file replaces the link; the old file stays in storage.
create or replace function public.bank_statement_set(p_id text, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Changing a bank statement');
  perform public.via('bank');
  update public.bank_statements set
    ending_balance = case when p ? 'ending_balance' then round(nullif(p ->> 'ending_balance', '')::numeric, 2) else ending_balance end,
    file_path = coalesce(nullif(p ->> 'file_path', ''), file_path),
    file_name = case when nullif(p ->> 'file_path', '') is not null then nullif(p ->> 'file_name', '') else file_name end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end
  where id = p_id;
  if not found then raise exception 'Statement not found'; end if;
end;
$$;

-- p_rows: [{date, description, amount}]
create or replace function public.bank_lines_add(p_statement_id text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Adding bank lines');
  perform public.via('bank');
  insert into public.bank_lines (statement_id, date, description, amount)
  select p_statement_id, (x ->> 'date')::date, nullif(trim(x ->> 'description'), ''), round((x ->> 'amount')::numeric, 2)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Match a bank line to a ledger entry or a Zeffy payout day (both null clears the match).
create or replace function public.bank_line_match(p_id text, p_ledger_id text, p_payout_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Matching a bank line');
  perform public.via('bank');
  update public.bank_lines set matched_ledger_id = nullif(p_ledger_id, ''), matched_payout_date = p_payout_date
   where id = p_id and archived_at is null;
  if not found then raise exception 'Bank line not found'; end if;
end;
$$;

create or replace function public.bank_line_archive(p_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Removing a bank line');
  perform public.via('bank');
  update public.bank_lines set archived_at = now(), archived_by = public.my_name(), archive_reason = coalesce(nullif(trim(p_reason), ''), 'Removed'),
         matched_ledger_id = null, matched_payout_date = null
   where id = p_id and archived_at is null;
  if not found then raise exception 'Bank line not found'; end if;
end;
$$;

alter function public.bank_month_difference(text, numeric) security definer;
create or replace function public.bank_month_difference(p_statement_id text, p_ending numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end date;
  v_book numeric; v_out numeric; v_transit numeric;
begin
  if not (public.is_board() or coalesce(public.my_role() = 'cpa', false)) then
    raise exception 'Board sign-in with two-step is required' using errcode = '42501';
  end if;
  select (s.month + interval '1 month' - interval '1 day')::date into v_end from public.bank_statements s where s.id = p_statement_id;
  if v_end is null then raise exception 'Statement not found'; end if;
  select coalesce(sum(case when l.dir = 'in' then l.amount else -l.amount end), 0) into v_book from public.ledger l where l.date <= v_end;
  -- money out not yet through the bank; an entry reversed by month end never reached the bank, so it and its reversal are left out
  select coalesce(sum(l.amount), 0) into v_out from public.ledger l
   where l.date <= v_end and l.dir = 'out' and coalesce(l.source, '') <> 'Opening Balance' and l.reverses_id is null
     and not exists (select 1 from public.ledger z where z.id = l.reversed_by_id and z.date <= v_end)
     and not exists (select 1 from public.bank_lines b where b.matched_ledger_id = l.id and b.archived_at is null)
     and not exists (select 1 from public.donations d join public.bank_lines b on b.matched_payout_date = d.payout_date and b.archived_at is null
                      where d.id = l.donation_id);
  select coalesce(sum(d.amount), 0) into v_transit from public.donations d
   where d.channel = 'Zeffy' and d.date <= v_end and (d.payout_date is null or d.payout_date > v_end) and d.archived_at is null;
  return round(p_ending - (v_book + v_out - v_transit), 2);
end;
$$;

create or replace function public.lock_bank_month(p_statement_id text, p_ending numeric, p_difference numeric default null)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare v timestamptz := now(); v_diff numeric;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Reconciling a month');
  if p_ending is null then raise exception 'Enter the statement ending balance'; end if;
  v_diff := public.bank_month_difference(p_statement_id, p_ending);
  if abs(v_diff) >= 0.005 then
    raise exception 'The month can be reconciled only when the difference is $0.00 (it is %)', v_diff;
  end if;
  perform public.via('lock');
  update public.bank_statements
     set ending_balance = round(p_ending, 2), difference = 0, locked_at = v, locked_by = public.my_name()
   where id = p_statement_id and locked_at is null;
  if not found then raise exception 'Statement not found or already reconciled'; end if;
  return v;
end;
$$;

-- Treasurer only, with a reason kept on the statement (and in the action log).
create or replace function public.unlock_bank_month(p_statement_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer'], 'Unlocking a reconciled month');
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason for unlocking the month'; end if;
  perform public.via('unlock');
  update public.bank_statements
     set locked_at = null, difference = null, unlocked_at = now(), unlocked_by = public.my_name(), unlock_reason = trim(p_reason)
   where id = p_statement_id and locked_at is not null;
  if not found then raise exception 'Statement not found or not locked'; end if;
end;
$$;

-- ---------------------------------------------------------------- archive for everything else

-- Archive a record of a non-money kind (accounts, documents, meetings, votes, members, donors, grants, invites,
-- teams, funds). Teams and funds only when nothing is left in them.
create or replace function public.archive_record(p_table text, p_id text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Archiving a record');
  perform public.via('archive');
  if p_table not in ('accounts','documents','meetings','meeting_votes','board_members','donors','grants','team_invites','teams','funds','team_requests') then
    raise exception 'Use the money actions to change %', p_table;
  end if;
  if p_table = 'funds' and public.fund_balance(p_id) <> 0 then raise exception 'This fund still holds money; move it first'; end if;
  if p_table = 'teams' and (public.fund_balance((select fund_id from public.teams where id = p_id)) <> 0
      or exists (select 1 from public.team_requests r where r.team_id = p_id and r.status in ('Submitted','Board Vote','Approved','Paid','Receipts Due') and r.archived_at is null)) then
    raise exception 'This team still has money or open requests';
  end if;
  if p_table = 'team_requests' and exists (select 1 from public.team_requests r where r.id = p_id and r.status not in ('Draft','Declined')) then
    raise exception 'Cancel the request instead; only a draft or declined request is archived';
  end if;
  if p_table = 'grants' and exists (select 1 from public.ledger l where l.grant_id = p_id and l.reversed_by_id is null and l.reverses_id is null) then
    raise exception 'This grant has money in the ledger; reverse those entries first';
  end if;
  execute format('update public.%I set archived_at = now(), archived_by = $1, archive_reason = $2 where id = $3 and archived_at is null', p_table)
    using public.my_name(), nullif(trim(coalesce(p_reason, '')), ''), p_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Record not found or already archived'; end if;
end;
$$;

create or replace function public.unarchive_record(p_table text, p_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['treasurer','board','bookkeeper'], 'Restoring a record');
  perform public.via('archive');
  if p_table not in ('accounts','documents','meetings','meeting_votes','board_members','donors','grants','team_invites','teams','funds') then
    raise exception 'That kind of record cannot be restored here';
  end if;
  execute format('update public.%I set archived_at = null, archived_by = null, archive_reason = null where id = $1', p_table) using p_id;
end;
$$;

-- ---------------------------------------------------------------- clear sample data (sample rows only)

create or replace function public.clear_sample_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  n int;
begin
  perform public.require_role(array['treasurer'], 'Clearing sample data');
  perform public.via('clear_sample');
  update public.ledger set reverses_id = null, reversed_by_id = null where sample;
  delete from public.bank_lines where sample; get diagnostics n = row_count; v := v || jsonb_build_object('bank_lines', n);
  delete from public.bank_statements s where s.sample and not exists (select 1 from public.bank_lines x where x.statement_id = s.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('statements', n);
  delete from public.request_approvals where sample; get diagnostics n = row_count; v := v || jsonb_build_object('approvals', n);
  delete from public.team_invites where sample; get diagnostics n = row_count; v := v || jsonb_build_object('invites', n);
  delete from public.receipts where sample; get diagnostics n = row_count; v := v || jsonb_build_object('receipts', n);
  delete from public.ledger where sample; get diagnostics n = row_count; v := v || jsonb_build_object('ledger', n);
  delete from public.donations where sample; get diagnostics n = row_count; v := v || jsonb_build_object('donations', n);
  delete from public.meeting_votes where sample; get diagnostics n = row_count; v := v || jsonb_build_object('votes', n);
  delete from public.team_requests r where r.sample and not exists (select 1 from public.request_approvals x where x.request_id = r.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('requests', n);
  delete from public.meetings m where m.sample and not exists (select 1 from public.meeting_votes x where x.meeting_id = m.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('meetings', n);
  update public.meetings set sample = false where sample;
  delete from public.documents where sample; get diagnostics n = row_count; v := v || jsonb_build_object('documents', n);
  delete from public.accounts where sample; get diagnostics n = row_count; v := v || jsonb_build_object('accounts', n);
  delete from public.donors d where d.sample
    and not exists (select 1 from public.donations x where x.donor_id = d.id)
    and not exists (select 1 from public.ledger x where x.donor_id = d.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('donors', n);
  update public.donors set sample = false where sample;
  delete from public.grants g where g.sample
    and not exists (select 1 from public.donations x where x.grant_id = g.id)
    and not exists (select 1 from public.ledger x where x.grant_id = g.id)
    and not exists (select 1 from public.donors x where x.grant_id = g.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('grants', n);
  update public.grants set sample = false where sample;
  delete from public.board_members b where b.sample
    and not exists (select 1 from public.team_requests x where x.interested_member_id = b.id or x.requestor_member_id = b.id)
    and not exists (select 1 from public.meetings x where b.id = any(x.present))
    and not exists (select 1 from public.meeting_votes x where x.ballots ? b.id)
    and not exists (select 1 from public.request_approvals x where x.member_id = b.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('members', n);
  update public.board_members set sample = false where sample;
  delete from public.teams t where t.sample
    and not exists (select 1 from public.team_requests x where x.team_id = t.id)
    and not exists (select 1 from public.funds x where x.team_id = t.id and not x.sample)
    and not exists (select 1 from public.board_members x where x.interest_team_id = t.id)
    and not exists (select 1 from public.team_users x where x.team_id = t.id)
    and not exists (select 1 from public.team_invites x where x.team_id = t.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('teams', n);
  update public.teams set sample = false where sample;
  delete from public.funds f where f.sample
    and not exists (select 1 from public.ledger x where x.fund_id = f.id)
    and not exists (select 1 from public.donations x where x.fund_id = f.id)
    and not exists (select 1 from public.grants x where x.fund_id = f.id)
    and not exists (select 1 from public.teams x where x.fund_id = f.id)
    and not exists (select 1 from public.settings x where x.general_fund_id = f.id);
  get diagnostics n = row_count; v := v || jsonb_build_object('funds', n);
  update public.funds set sample = false where sample;
  return v;
end;
$$;

-- ---------------------------------------------------------------- shut off direct writes

-- Money tables: read only for the board; every change goes through the functions above.
do $$
declare t text;
begin
  foreach t in array array['ledger','donations','team_requests','receipts','funds','teams','request_approvals',
                           'bank_statements','bank_lines','settings','zeffy_skip','money_overrides'] loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- Everything else: no deletes (archive instead). Grants keep their money figure for grant_received alone.
  foreach t in array array['board_members','grants','donors','meetings','meeting_votes','accounts','documents','team_invites'] loop
    execute format('revoke delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke update on public.grants from authenticated;
grant update (funder, program, ask, awarded, status, deadline, applied_as, owner, board_saw, fund_id, purpose, public, likelihood, notes)
  on public.grants to authenticated;
revoke insert on public.grants from authenticated;
grant insert (funder, program, ask, awarded, status, deadline, applied_as, owner, board_saw, fund_id, purpose, public, likelihood, notes)
  on public.grants to authenticated;

alter table public.money_overrides enable row level security;
create policy board_read on public.money_overrides for select to authenticated using ((select public.is_board()));

-- Files are kept: nobody signed in can remove a file from the bucket.
drop policy if exists board_files_delete on storage.objects;

-- ---------------------------------------------------------------- function grants

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_role()', 'public.is_treasurer()', 'public.require_role(text[],text)', 'public.my_name()', 'public.month_locked(date)',
    'public.fund_balance(text)', 'public.fund_committed(text,text)', 'public.portal_totals()',
    'public.spend_warnings(text,numeric,text,text,text)',
    'public.ledger_add(jsonb)', 'public.ledger_edit(text,jsonb)', 'public.ledger_reverse(text,text,date)', 'public.ledger_correct(text,jsonb,text)',
    'public.gift_set_thanked(text[],boolean)', 'public.gift_assign_fund(text,text)', 'public.gift_archive(text,text)',
    'public.fund_save(jsonb)', 'public.team_save(jsonb)', 'public.request_save(jsonb)', 'public.request_fund(text)',
    'public.mark_request_paid(text,date,text,text,text)', 'public.receipt_archive(text,text)', 'public.settings_save_rules(numeric,int,int,int,boolean)',
    'public.bank_statement_add(date)', 'public.bank_statement_set(text,jsonb)', 'public.bank_lines_add(text,jsonb)',
    'public.bank_line_match(text,text,date)', 'public.bank_line_archive(text,text)', 'public.unlock_bank_month(text,text)',
    'public.archive_record(text,text,text)', 'public.unarchive_record(text,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.spend_check(text,numeric,text,text,text,text,text,boolean)', 'public.request_status_guard()',
                           'public.no_delete_guard()', 'public.statement_lock_guard()', 'public.bank_line_lock_guard()', 'public.inside_money_fn()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant select on public.ledger_signed to authenticated;
