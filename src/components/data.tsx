'use client';
// Loads every portal table for the signed-in board member and recalculates on each change.
// The data is small (one nonprofit's books), so pages read it all from memory like the demo did.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { BUCKET } from '@/lib/supabase/env';
import { Calc } from '@/lib/calc';
import { todayIso } from '@/lib/format';
import { TABLES, type Db, type Settings, type TableName } from '@/lib/types';
import { useUI } from './ui';

const NUMERIC: Partial<Record<TableName, string[]>> = {
  grants: ['ask', 'awarded', 'received', 'likelihood'], donations: ['amount', 'refunded'], ledger: ['amount'], team_requests: ['amount', 'returned'],
  receipts: ['amount'], accounts: ['cost'], bank_statements: ['ending_balance', 'difference'], bank_lines: ['amount'],
};
/** Tables keyed by something other than a text id; rows get a string id so tables and lookups stay uniform. */
const KEY: Partial<Record<TableName, string>> = { team_users: 'user_id' };

async function fetchAll(table: TableName): Promise<Record<string, unknown>[]> {
  const sb = supabase();
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').order(KEY[table] || 'id').range(from, from + 999);
    if (error) throw new Error(table + ': ' + error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const nums = NUMERIC[table] || [];
  if (nums.length) out.forEach((r) => nums.forEach((k) => { if (r[k] != null) r[k] = Number(r[k]); }));
  out.forEach((r) => { r.id = String(r[KEY[table] || 'id']); });
  return out;
}

async function loadDb(): Promise<Db> {
  const sb = supabase();
  const [settings, ...rows] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).maybeSingle(),
    ...TABLES.map(fetchAll),
  ]);
  if (settings.error) throw new Error('settings: ' + settings.error.message);
  const db = { settings: (settings.data || { id: 1, org: 'GPRIC', short: 'GPRIC', ein: null, fy_start: '2026-07-01', fy_label: '', receipt_days: 60, approval_threshold: 500, approvals_under: 1, approvals_over: 2, general_fund_id: null }) as Settings } as Db;
  db.settings.approval_threshold = Number(db.settings.approval_threshold ?? 500);
  TABLES.forEach((t, i) => { (db as Record<string, unknown>)[t] = rows[i]; });
  return db;
}

type DataCtx = {
  db: Db; calc: Calc; user: User; reload: () => Promise<void>;
  /** Runs a write, shows the error if it fails, reloads the data, and returns whether it worked. */
  run: <T>(fn: () => PromiseLike<{ data?: T; error: { message: string } | null }>, ok?: string) => Promise<T | undefined | false>;
  anySample: boolean;
  /** Who is signed in, as a short name for "added by" fields. */
  me: string;
};
const Ctx = createContext<DataCtx | null>(null);
export function useData() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useData outside DataProvider');
  return c;
}

export function DataProvider({ user, children }: { user: User; children: ReactNode }) {
  const ui = useUI();
  const [db, setDb] = useState<Db | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [today, setToday] = useState(todayIso());

  const reload = useCallback(async () => {
    try { setDb(await loadDb()); setErr(null); setToday(todayIso()); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => {
    let live = true;
    loadDb().then((d) => { if (live) setDb(d); }).catch((e) => { if (live) setErr((e as Error).message); });
    const f = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', f);
    return () => { live = false; document.removeEventListener('visibilitychange', f); };
  }, [reload]);

  const run = useCallback(async <T,>(fn: () => PromiseLike<{ data?: T; error: { message: string } | null }>, ok?: string) => {
    const res = await fn();
    if (res.error) { ui.toast(friendly(res.error.message), true); return false as const; }
    await reload();
    if (ok) ui.toast(ok);
    return res.data;
  }, [reload, ui]);

  const value = useMemo(() => {
    if (!db) return null;
    const calc = new Calc(db, today);
    const anySample = TABLES.some((t) => (db[t] as { sample: boolean }[]).some((r) => r.sample));
    const meta = (user.user_metadata || {}) as { full_name?: string; name?: string };
    const me = meta.full_name || meta.name || db.board_members.find((m) => m.email && m.email.toLowerCase() === (user.email || '').toLowerCase())?.name || user.email || 'Board';
    return { db, calc, user, reload, run, anySample, me };
  }, [db, today, user, reload, run]);

  if (err && !db) return <div className="wrap"><div className="panel empty">Could not load the portal data. {err}<div style={{ marginTop: 10 }}><button className="btn" onClick={reload}>Try Again</button></div></div></div>;
  if (!value) return <div className="loading">Loading…</div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function friendly(m: string) {
  if (/foreign key/i.test(m) && /ledger/i.test(m)) return 'This is still used by ledger rows. Move or delete those first.';
  if (/foreign key/i.test(m)) return 'Other records still use this one. Change or delete them first.';
  if (/row-level security|permission denied|42501/i.test(m)) return 'Not allowed. Sign in again with your two-step code.';
  return m;
}

/* ---------- files in the board-only bucket ---------- */
export async function uploadFile(folder: string, file: File): Promise<{ path: string; name: string } | { error: string }> {
  const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(-120);
  const path = `${folder}/${Date.now()}-${safe}`;
  const { error } = await supabase().storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) return { error: error.message };
  return { path, name: file.name };
}
export async function openFile(path: string) {
  const w = window.open('', '_blank');
  const { data, error } = await supabase().storage.from(BUCKET).createSignedUrl(path, 120);
  if (error || !data) { w?.close(); alert('Could not open the file: ' + (error?.message || 'unknown error')); return; }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}
export async function removeFiles(paths: (string | null | undefined)[]) {
  const p = paths.filter(Boolean) as string[];
  if (p.length) await supabase().storage.from(BUCKET).remove(p);
}
