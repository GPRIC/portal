// Monthly bank reconciliation helpers: reading a bank CSV, suggesting matches between bank lines and portal records,
// month and quarter dates, and the bank items the Dashboard flags. Totals stay in calc.ts; this only pairs and parses.
import type { Calc } from './calc';
import type { BankLine, Db, Ledger } from './types';
import { addDays, daysBetween, round2 } from './format';

const pad = (n: number) => String(n).padStart(2, '0');

/* ---------- months and quarters ---------- */

/** "2026-10-14" → "2026-10-01". */
export const monthStart = (iso: string) => iso.slice(0, 7) + '-01';
/** Last day of the month an ISO date falls in. */
export function monthEnd(iso: string): string {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
/** First of the month before the one an ISO date falls in. */
export function prevMonth(iso: string): string {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
}
/** The reconciliation for a month is due by the 5th business day (Monday to Friday) of the next month. */
export function reconcileDue(month: string): string {
  let d = addDays(monthEnd(month), 1);
  let n = 0;
  for (;;) {
    const wd = new Date(d + 'T12:00:00').getDay();
    if (wd !== 0 && wd !== 6) { n += 1; if (n === 5) return d; }
    d = addDays(d, 1);
  }
}

export type Quarter = { year: number; q: number; start: string; end: string; label: string };
export function quarterOf(iso: string): Quarter {
  const y = +iso.slice(0, 4), q = Math.floor((+iso.slice(5, 7) - 1) / 3) + 1;
  const start = `${y}-${pad((q - 1) * 3 + 1)}-01`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { year: y, q, start, end: monthEnd(`${y}-${pad(q * 3)}-01`), label: `Q${q} ${y} · ${MON[(q - 1) * 3]} to ${MON[q * 3 - 1]}` };
}
/** The quarter a date falls in and the n-1 before it, newest first. */
export function recentQuarters(today: string, n = 4): Quarter[] {
  const out: Quarter[] = [];
  let d = today;
  for (let i = 0; i < n; i++) { const q = quarterOf(d); out.push(q); d = addDays(q.start, -1); }
  return out;
}

/* ---------- bank CSV ---------- */

/** Splits CSV text into rows of cells (quoted cells, doubled quotes and line breaks inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** "10/3/2026", "10/3/26", "2026-10-03" → "2026-10-03"; anything else → null. */
export function bankDate(v: string): string | null {
  const s = (v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  return null;
}
/** "$1,234.50", "-12.00", "(12.00)" → number; blank → null. */
export function bankAmount(v: string | undefined): number | null {
  const s = (v || '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, ''));
  const n = parseFloat(s.replace(/[()$,\s-]/g, ''));
  if (!isFinite(n)) return null;
  return round2(neg ? -n : n);
}

export type NewBankLine = { date: string; description: string | null; amount: number };

/** Bank lines from a statement CSV: a Date column, a Description (or Memo / Payee / Details) column, and either
 *  one signed Amount column or separate Debit / Credit (Withdrawal / Deposit) columns. Columns are found by name. */
export function bankLinesFromCsv(text: string): NewBankLine[] {
  const rows = parseCsv(text);
  const hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /amount|debit|credit|withdrawal|deposit/i.test(c)));
  if (hi < 0) throw new Error('This file has no header row with a Date column and an Amount (or Debit and Credit) column.');
  const head = rows[hi].map((h) => h.trim().toLowerCase());
  const find = (...names: RegExp[]) => { for (const n of names) { const i = head.findIndex((h) => n.test(h)); if (i >= 0) return i; } return -1; };
  const c = {
    date: find(/^posted date$/, /^post(ing)? date$/, /^transaction date$/, /^date$/, /date/),
    desc: find(/^description$/, /description/, /^memo$/, /payee/, /details/, /^name$/),
    amount: find(/^amount$/, /amount/),
    debit: find(/debit/, /withdrawal/),
    credit: find(/credit/, /deposit/),
  };
  if (c.date < 0 || (c.amount < 0 && c.debit < 0 && c.credit < 0)) throw new Error('Could not find the Date and Amount columns in this file.');
  const out: NewBankLine[] = [];
  for (const r of rows.slice(hi + 1)) {
    const date = bankDate(r[c.date]);
    if (!date) continue;
    let amount: number | null = null;
    if (c.amount >= 0) amount = bankAmount(r[c.amount]);
    if (amount == null) {
      const dr = c.debit >= 0 ? bankAmount(r[c.debit]) : null, cr = c.credit >= 0 ? bankAmount(r[c.credit]) : null;
      if (dr) amount = -Math.abs(dr); else if (cr) amount = Math.abs(cr);
    }
    if (!amount) continue;
    out.push({ date, description: c.desc >= 0 ? (r[c.desc] || '').trim() || null : null, amount });
  }
  return out;
}

/* ---------- matching ---------- */

export const MATCH_DAYS = 5;

/** A Zeffy payout: every gift Zeffy paid out to the bank on one day. */
export type Payout = { date: string; total: number; count: number };
export function payouts(db: Db): Payout[] {
  const m = new Map<string, Payout>();
  db.donations.filter((d) => d.channel === 'Zeffy' && d.payout_date).forEach((d) => {
    const p = m.get(d.payout_date!) || { date: d.payout_date!, total: 0, count: 0 };
    p.total = round2(p.total + d.amount - (d.refunded || 0));
    p.count += 1;
    m.set(p.date, p);
  });
  return [...m.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export type Match = { ledger: Ledger } | { payout: Payout };
export const isMatched = (b: BankLine) => !!(b.matched_ledger_id || b.matched_payout_date);

/** Ledger rows and payouts already used by a bank line (other than the one given). */
export function used(db: Db, except?: string) {
  const ledger = new Set<string>(), pays = new Set<string>();
  db.bank_lines.forEach((b) => {
    if (b.id === except) return;
    if (b.matched_ledger_id) ledger.add(b.matched_ledger_id);
    if (b.matched_payout_date) pays.add(b.matched_payout_date);
  });
  // A gift inside a matched payout is cleared, so it cannot be matched again on its own.
  db.ledger.forEach((l) => { const d = l.donation_id ? db.donations.find((x) => x.id === l.donation_id) : null; if (d?.payout_date && pays.has(d.payout_date)) ledger.add(l.id); });
  return { ledger, pays };
}

/** Portal records a bank line could match, best first: same sign, not already matched, nearest amount then nearest date. */
export function candidates(db: Db, line: BankLine, limit = 60): Match[] {
  const u = used(db, line.id);
  const amt = Math.abs(line.amount);
  const dist = (a: number, d: string) => Math.abs(a - amt) * 1000 + Math.abs(daysBetween(line.date, d));
  const out: [number, Match][] = [];
  db.ledger.forEach((l) => {
    if (u.ledger.has(l.id) || l.source === 'Opening Balance') return;
    if ((line.amount < 0) !== (l.dir === 'out')) return;
    out.push([dist(l.amount, l.date), { ledger: l }]);
  });
  if (line.amount > 0) payouts(db).forEach((p) => { if (!u.pays.has(p.date)) out.push([dist(p.total, p.date) - 0.5, { payout: p }]); });
  return out.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

/** The automatic suggestion for an unmatched line: a portal record of exactly this amount within ±5 days
 *  (money out for a withdrawal), or for a deposit a Zeffy payout whose gifts add up to it. Nearest date wins. */
export function suggest(db: Db, line: BankLine, taken?: { ledger: Set<string>; pays: Set<string> }): Match | null {
  if (isMatched(line)) return null;
  const u = taken || used(db, line.id);
  const amt = round2(Math.abs(line.amount));
  const near = (d: string) => Math.abs(daysBetween(line.date, d)) <= MATCH_DAYS;
  let best: Match | null = null, bestD = Infinity;
  if (line.amount > 0) {
    payouts(db).forEach((p) => {
      const d = Math.abs(daysBetween(line.date, p.date));
      if (!u.pays.has(p.date) && p.total === amt && near(p.date) && d < bestD) { best = { payout: p }; bestD = d; }
    });
    if (best) return best;
  }
  db.ledger.forEach((l) => {
    if (u.ledger.has(l.id) || l.source === 'Opening Balance') return;
    if ((line.amount < 0) !== (l.dir === 'out') || round2(l.amount) !== amt || !near(l.date)) return;
    // A Zeffy gift reaches the bank inside a payout, not on its own, unless it has no payout date yet.
    const don = l.donation_id ? db.donations.find((x) => x.id === l.donation_id) : null;
    if (don?.channel === 'Zeffy' && don.payout_date) return;
    const d = Math.abs(daysBetween(line.date, l.date));
    if (d < bestD) { best = { ledger: l }; bestD = d; }
  });
  return best;
}

/** Suggestions for every unmatched line of a statement, never using one record twice. */
export function suggestAll(db: Db, statementId: string): Map<string, Match> {
  const u = used(db);
  const out = new Map<string, Match>();
  db.bank_lines.filter((b) => b.statement_id === statementId && !isMatched(b)).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((b) => {
    const s = suggest(db, b, u);
    if (!s) return;
    out.set(b.id, s);
    if ('ledger' in s) u.ledger.add(s.ledger.id); else u.pays.add(s.payout.date);
  });
  return out;
}

/** The columns a bank line update writes for a match (or for clearing one). */
export function matchPatch(m: Match | null) {
  if (!m) return { matched_ledger_id: null, matched_payout_date: null };
  return 'ledger' in m ? { matched_ledger_id: m.ledger.id, matched_payout_date: null } : { matched_ledger_id: null, matched_payout_date: m.payout.date };
}

/* ---------- dashboard flags ---------- */

/** Bank lines not matched to a portal record, in months not yet locked. */
export function unmatchedLines(db: Db): BankLine[] {
  const open = new Set(db.bank_statements.filter((s) => !s.locked_at).map((s) => s.id));
  return db.bank_lines.filter((b) => open.has(b.statement_id) && !isMatched(b));
}
/** Portal records more than 30 days old that no bank line has cleared. Counted only from the first month a
 *  statement was loaded, since before that nothing has been matched and every record would show. */
export function unclearedOld(db: Db, calc: Calc, today: string): Ledger[] {
  const first = db.bank_statements.map((s) => s.month).sort()[0];
  if (!first) return [];
  const cleared = calc.clearedIds();
  const cut = addDays(today, -30);
  return db.ledger.filter((l) => l.date >= first && l.date < cut && l.source !== 'Opening Balance' && !cleared.has(l.id));
}
