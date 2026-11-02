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
};
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
  gifts: Gift[];
};

type Raw = Record<string, unknown>;
const n = (v: unknown) => Number(v) || 0;
const s = (v: unknown) => (v == null || v === '' ? null : String(v));

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
