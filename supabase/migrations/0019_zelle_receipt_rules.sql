-- 0019, P26 money rules (Josh 2026-11-19, decision 9674):
-- 1. Two eyes on a new Zelle: a request whose Zelle contact has never been paid by Zelle before needs at least two board
--    approvals (or a board vote) before it is paid. approve_request counts it; a request approved under the old rule
--    with one approval takes a second approval while Approved; mark_request_paid refuses a Zelle payment without it.
-- 2. Receipt before reimbursement: a Reimbursement is paid only once a receipt is attached, unless a board member
--    (Treasurer or board, not the person who filed it) records an override with a reason. The override is a
--    money_overrides row, so it shows in History as "Overrode".
-- Redefines approve_request and mark_request_paid from their live bodies (2026-11-23); nothing 0017 changed.

-- ---------------------------------------------------------------- helpers

create or replace function public.zelle_norm(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(lower(regexp_replace(coalesce(p, ''), '[\s().+-]', '', 'g')), ''); $$;
revoke all on function public.zelle_norm(text) from public, anon, authenticated;

-- True when the request names a Zelle contact that no other request has ever been paid to by Zelle.
create or replace function public.zelle_is_new(p_request_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.zelle_norm(r.zelle_contact) is not null
       and not exists (select 1 from public.team_requests o
                        where o.id <> r.id and o.archived_at is null and o.paid_date is not null and o.pay_method = 'Zelle'
                          and public.zelle_norm(o.zelle_contact) = public.zelle_norm(r.zelle_contact))
      from public.team_requests r where r.id = p_request_id), false);
$$;
revoke all on function public.zelle_is_new(text) from public, anon, authenticated;

-- Approvals a request needs: the amount rule, and at least two for a new Zelle. Null for a turned-off seat (as approvals_needed).
create or replace function public.request_approvals_needed(p_request_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when n is null then null when public.zelle_is_new(r.id) then greatest(n, 2) else n end
    from public.team_requests r cross join lateral (select public.approvals_needed(r.amount) n) x
   where r.id = p_request_id;
$$;
revoke all on function public.request_approvals_needed(text) from public, anon, authenticated;

-- A request approved before 0019 with one approval, to a new Zelle, still waiting on its second approval.
create or replace function public.zelle_second_due(p_request_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select r.status = 'Approved' and r.vote_id is null and r.type <> 'Direct Expense' and public.zelle_is_new(r.id)
                          and (select count(*) from public.request_approvals a where a.request_id = r.id) < 2
                     from public.team_requests r where r.id = p_request_id), false);
$$;
revoke all on function public.zelle_second_due(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- approve

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
  v_second boolean;
begin
  perform public.require_board();
  if public.my_role() = 'bookkeeper' and not (select bookkeeper_can_approve from public.settings where id = 1) then
    raise exception 'Approving is for board members' using errcode = '42501';
  end if;
  perform public.via('approve');
  select * into r from public.team_requests where id = p_request_id for update;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  v_second := public.zelle_second_due(r.id);
  if r.status not in ('Submitted', 'Board Vote') and not v_second then raise exception 'This request is not waiting for approval'; end if;
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
  v_need := public.request_approvals_needed(r.id);
  if v_have >= v_need and r.status <> 'Approved' then
    update public.team_requests set status = 'Approved', decline_reason = null where id = r.id;
  end if;
  select * into t from public.teams where id = r.team_id;
  v_warn := coalesce(public.spend_warnings(public.request_fund(r.id), r.amount, r.team_id, 'Robotics Teams', r.id), '{}');
  return jsonb_build_object('approvals', v_have, 'needed', v_need, 'status', case when v_have >= v_need then 'Approved' else r.status end,
                            'warnings', to_jsonb(v_warn));
end;
$$;

-- ---------------------------------------------------------------- the receipt override

create or replace function public.request_receipt_override(p_request_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.team_requests%rowtype;
  v_member text := public.my_member_id();
begin
  perform public.require_role(array['treasurer','board'], 'Paying a reimbursement before its receipt');
  if nullif(trim(p_reason), '') is null then raise exception 'Give the reason the receipt can wait'; end if;
  select * into r from public.team_requests where id = p_request_id;
  if r.id is null or r.archived_at is not null then raise exception 'Request not found'; end if;
  if r.type <> 'Reimbursement' then raise exception 'Only a reimbursement waits for its receipt'; end if;
  if r.status not in ('Submitted', 'Board Vote', 'Approved') then raise exception 'This request is not waiting to be paid'; end if;
  -- the same three ways approve_request knows the person who filed it
  if r.submitted_by_user = auth.uid() or (v_member is not null and r.requestor_member_id = v_member)
     or lower(coalesce(r.requestor_email, '')) = lower(coalesce(auth.jwt() ->> 'email', '-')) then
    raise exception 'You made this request, so another board member has to override the receipt rule';
  end if;
  perform public.via('override');
  insert into public.money_overrides (user_id, by_name, action, record_id, fund_id, amount, rule, reason)
  values (auth.uid(), public.my_name(), 'pay', r.id, public.request_fund(r.id), r.amount, 'Receipt before payment', trim(p_reason));
end;
$$;
revoke all on function public.request_receipt_override(text, text) from public, anon;
grant execute on function public.request_receipt_override(text, text) to authenticated;

-- ---------------------------------------------------------------- pay

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
  if p_method = 'Zelle' and public.zelle_second_due(r.id) then
    raise exception 'This is the first payment to this Zelle, so a second board member has to approve it before it is paid' using errcode = '42501';
  end if;
  if r.type = 'Reimbursement' and r.receipt_path is null
     and not exists (select 1 from public.receipts x where x.request_id = r.id and x.archived_at is null)
     and not exists (select 1 from public.money_overrides o where o.record_id = r.id and o.rule = 'Receipt before payment') then
    raise exception 'A reimbursement is paid once its receipt is attached. A board member can let it be paid first, with a reason.' using errcode = '42501';
  end if;
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
