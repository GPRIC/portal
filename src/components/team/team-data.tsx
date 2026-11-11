'use client';
// The Team Portal's data: one call to team_portal() for the caller's own team. Team users cannot read tables directly.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase/client';
import { todayIso } from '@/lib/format';

export type TeamReq = {
  id: string; type: 'Pre-Approval' | 'Reimbursement'; purpose: string; category: string | null; amount: number;
  vendor: string | null; pay_to: string | null; needed_by: string | null; purchase_date: string | null; submitted: string | null;
  status: string; paid_date: string | null; pay_method: string | null; decline_reason: string | null;
  requestor_name: string | null; receipt_name: string | null;
  approvals: number; needed: number; receipts: number; receipts_total: number;
} & Extra;
/** One receipt on a request (0011). A file outside team/<team>/ was uploaded by the board and opens only for the board. */
export type TeamReceipt = { id: string; request_id: string; vendor: string | null; amount: number; date: string | null; file_name: string | null; file_path: string | null; uploaded_by: string | null; created_at: string | null };
/** What a team sees of a request beyond its status (0011): its receipts, cancel, refund and the last reminder, read only. */
type Extra = {
  receipt_list: TeamReceipt[]; receipt_path: string | null;
  cancel_reason: string | null; cancelled_at: string | null; replaced_by_id: string | null; replaces_id: string | null;
  refund: { amount: number; date: string; reason: string } | null;
  reminder: { at: string; by: string | null; note: string | null } | null;
  missing: boolean;
};
/** A purchase the board paid directly from the team's own fund (its invoices are the team's receipts too). */
export type TeamDirect = {
  id: string; type: 'Direct Expense'; purpose: string; category: string | null; amount: number; vendor: string | null; submitted: string | null;
  status: string; paid_date: string | null; pay_method: string | null; requestor_name: string | null;
} & Extra;
export type Gift = { id: string; date: string; amount: number; donor: string; in_transit: boolean };
export type Portal = {
  team: { id: string; name: string; short: string; program: string | null; pay_mode: string | null; school: string | null };
  me: { name: string | null; email: string | null; role: string | null; zelle_contact: string | null };
  rules: { receipt_days: number; threshold: number; under: number; over: number };
  money: { carry: number; zeffy: number; deposits: number; reimbursements: number; direct: number; balance: number };
  overdue: number;
  season_start: string | null;
  raised: number;
  requests: TeamReq[];
  direct: TeamDirect[];
  gifts: Gift[];
};

type Raw = Record<string, unknown>;
const n = (v: unknown) => Number(v) || 0;
const s = (v: unknown) => (v == null || v === '' ? null : String(v));

function extra(x: Raw, rid: string): Extra {
  const rf = x.refund as Raw | null, rm = x.reminder as Raw | null;
  return {
    receipt_list: ((x.receipt_list || []) as Raw[]).map((c) => ({
      id: String(c.id), request_id: rid, vendor: s(c.vendor), amount: n(c.amount), date: s(c.date), file_name: s(c.file_name),
      file_path: s(c.file_path), uploaded_by: s(c.uploaded_by), created_at: s(c.created_at),
    })),
    receipt_path: s(x.receipt_path),
    cancel_reason: s(x.cancel_reason), cancelled_at: s(x.cancelled_at), replaced_by_id: s(x.replaced_by_id), replaces_id: s(x.replaces_id),
    refund: rf ? { amount: n(rf.amount), date: String(rf.date ?? ''), reason: String(rf.reason ?? '') } : null,
    reminder: rm ? { at: String(rm.at ?? ''), by: s(rm.by), note: s(rm.note) } : null,
    missing: x.missing === true,
  };
}

function normalize(raw: Raw): Portal {
  const t = (raw.team || {}) as Raw, me = (raw.me || {}) as Raw, r = (raw.rules || {}) as Raw, m = (raw.money || {}) as Raw;
  return {
    team: { id: String(t.id ?? ''), name: String(t.name ?? ''), short: String(t.short ?? t.name ?? ''), program: s(t.program), pay_mode: s(t.pay_mode), school: s(t.school) },
    me: { name: s(me.name), email: s(me.email), role: s(me.role), zelle_contact: s(me.zelle_contact) },
    rules: { receipt_days: n(r.receipt_days) || 60, threshold: n(r.threshold), under: n(r.under) || 1, over: n(r.over) || 2 },
    money: { carry: n(m.carry), zeffy: n(m.zeffy), deposits: n(m.deposits), reimbursements: n(m.reimbursements), direct: n(m.direct), balance: n(m.balance) },
    overdue: n(raw.overdue),
    season_start: s(raw.season_start),
    raised: n(raw.raised),
    requests: ((raw.requests || []) as Raw[]).map((x) => ({
      id: String(x.id), type: x.type === 'Reimbursement' ? 'Reimbursement' : 'Pre-Approval', purpose: String(x.purpose ?? ''), category: s(x.category),
      amount: n(x.amount), vendor: s(x.vendor), pay_to: s(x.pay_to), needed_by: s(x.needed_by), purchase_date: s(x.purchase_date),
      submitted: s(x.submitted), status: String(x.status ?? ''), paid_date: s(x.paid_date), pay_method: s(x.pay_method),
      decline_reason: s(x.decline_reason), requestor_name: s(x.requestor_name), receipt_name: s(x.receipt_name),
      approvals: n(x.approvals), needed: n(x.needed) || 1, receipts: n(x.receipts), receipts_total: n(x.receipts_total),
      ...extra(x, String(x.id)),
    })),
    direct: ((raw.direct || []) as Raw[]).map((x) => ({
      id: String(x.id), type: 'Direct Expense' as const, purpose: String(x.purpose ?? ''), category: s(x.category), amount: n(x.amount),
      vendor: s(x.vendor), submitted: s(x.submitted), status: String(x.status ?? ''), paid_date: s(x.paid_date), pay_method: s(x.pay_method),
      requestor_name: s(x.requestor_name), ...extra(x, String(x.id)),
    })),
    gifts: ((raw.gifts || []) as Raw[]).map((x) => ({ id: String(x.id), date: String(x.date ?? ''), amount: n(x.amount), donor: String(x.donor ?? ''), in_transit: x.in_transit === true })),
  };
}

type Ctx = { p: Portal; today: string; reload: () => Promise<void> };
const TeamCtx = createContext<Ctx | null>(null);
export function useTeam() {
  const c = useContext(TeamCtx);
  if (!c) throw new Error('useTeam outside TeamDataProvider');
  return c;
}

/** Turns an RPC error into the sentence a coach should see. */
export function friendly(m: string) {
  if (/row-level security|permission denied|42501/i.test(m)) return 'Not allowed. Sign in again with your authenticator code.';
  return m;
}

export function TeamDataProvider({ children }: { children: ReactNode }) {
  const [p, setP] = useState<Portal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const { data, error } = await supabase().rpc('team_portal');
    if (error || !data) { setErr(friendly(error?.message || 'No data came back.')); return; }
    setErr(null);
    setP(normalize(data as Raw));
  }, []);
  useEffect(() => {
    let live = true;
    supabase().rpc('team_portal').then(({ data, error }) => {
      if (!live) return;
      if (error || !data) setErr(friendly(error?.message || 'No data came back.'));
      else setP(normalize(data as Raw));
    });
    return () => { live = false; };
  }, []);
  const value = useMemo(() => (p ? { p, today: todayIso(), reload } : null), [p, reload]);
  if (err && !p) return <div className="wrap"><div className="panel empty">Could not load your team. {err}<div style={{ marginTop: 10 }}><button className="btn" onClick={reload}>Try Again</button></div></div></div>;
  if (!value) return <div className="loading">Loading…</div>;
  return <TeamCtx.Provider value={value}>{children}</TeamCtx.Provider>;
}
