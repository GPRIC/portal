'use client';
// Excel exports (P35): any list as it is filtered on screen, and one workbook for a whole year.
// For the Treasurer, the bookkeeper and the CPA (canExport). Built in the browser with exceljs from the data already loaded,
// so an export holds exactly what the person can read; nothing is written anywhere.
import { useState } from 'react';
import { useData } from './data';
import { Kv, Modal, Seg, useUI, type Col } from './ui';
import { download } from './balances/hint';
import { todayIso } from '@/lib/format';
import type { Db } from '@/lib/types';

type Cell = string | number | boolean | null;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fileName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');

function cell(v: unknown): Cell {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return JSON.stringify(v);
}

async function workbook() {
  const m = await import('exceljs');
  const Workbook = m.Workbook ?? (m as unknown as { default: typeof m }).default.Workbook;
  const wb = new Workbook();
  wb.creator = 'GPRIC Board Portal';
  wb.created = new Date();
  return wb;
}
type WB = Awaited<ReturnType<typeof workbook>>;

/** One sheet: a bold, frozen header row, then the rows. Sheet names are cut to Excel's 31 characters. */
function sheet(wb: WB, name: string, head: string[], rows: Cell[][]) {
  const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  if (!head.length) { ws.addRow(['No rows']); return; }
  ws.addRow(head).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  head.forEach((h, i) => {
    const longest = Math.max(h.length, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length));
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 2));
  });
}

/** Every column of a table's rows (all keys), for the whole-year sheets. */
function rawSheet(wb: WB, name: string, all: Record<string, unknown>[], keep: Record<string, unknown>[]) {
  const head = [...new Set(all.flatMap((r) => Object.keys(r)))];
  sheet(wb, name, head, keep.map((r) => head.map((c) => cell(r[c]))));
}

/* ---------------------------------------------------------------- a list, as filtered */

/** The Excel button for a list page: exports the rows given (the page passes what its filters show) with the table's columns.
 *  A column's export value is used when it has one, then its sort value (names rather than ids), else the row's own field. Blank-label columns
 *  (buttons) are left out. Shown only to those who may export. */
export function ListExport<T extends { id: string }>({ name, cols, rows }: { name: string; cols: Col<T>[]; rows: T[] }) {
  const { canExport } = useData();
  const ui = useUI();
  const [busy, setBusy] = useState(false);
  if (!canExport) return null;
  const go = async () => {
    setBusy(true);
    try {
      const use = cols.filter((c) => c.label.trim());
      const wb = await workbook();
      sheet(wb, name, use.map((c) => c.label), rows.map((r) => use.map((c) => cell(c.xv ? c.xv(r) : c.sv ? c.sv(r) : (r as Record<string, unknown>)[c.k]))));
      download(`GPRIC-${fileName(name)}-${todayIso()}.xlsx`, (await wb.xlsx.writeBuffer()) as ArrayBuffer, XLSX);
      ui.toast(`${rows.length} ${rows.length === 1 ? 'row' : 'rows'} exported`);
    } catch (e) { ui.toast('Export failed: ' + (e as Error).message, true); }
    setBusy(false);
  };
  return (
    <button type="button" className="btn" onClick={go} disabled={busy} title={`Save the ${rows.length} rows shown, as filtered, to an Excel file`}>
      {busy ? 'Exporting…' : 'Export Excel'}
    </button>
  );
}

/** One sheet saved straight to an Excel file, for lists that are paged on the server (History). */
export async function saveSheet(name: string, head: string[], rows: unknown[][]) {
  const wb = await workbook();
  sheet(wb, name, head, rows.map((r) => r.map(cell)));
  download(`GPRIC-${fileName(name)}-${todayIso()}.xlsx`, (await wb.xlsx.writeBuffer()) as ArrayBuffer, XLSX);
}

/* ---------------------------------------------------------------- the whole year */

export type YearSpan = { label: string; start: string; end: string };

/** Calendar years and fiscal years (settings.fy_start) from the first ledger date to today, newest first. */
export function yearSpans(db: Db, today: string, kind: 'fiscal' | 'calendar'): YearSpan[] {
  const first = db.ledger.reduce((m, l) => (l.date < m ? l.date : m), today);
  const fy = (db.settings.fy_start || '2026-07-01').slice(5);   // MM-DD the fiscal year starts
  const out: YearSpan[] = [];
  for (let y = Number(today.slice(0, 4)) + 1; y >= Number(first.slice(0, 4)) - 1; y--) {
    const start = kind === 'calendar' ? `${y}-01-01` : `${y}-${fy}`;
    const endD = new Date(start + 'T00:00:00Z'); endD.setUTCFullYear(endD.getUTCFullYear() + 1); endD.setUTCDate(endD.getUTCDate() - 1);
    const end = endD.toISOString().slice(0, 10);
    if (start > today || end < first) continue;
    out.push({ label: kind === 'calendar' ? String(y) : `FY ${y}–${String(y + 1).slice(2)}`, start, end });
  }
  return out;
}

const inSpan = (d: string | null | undefined, y: YearSpan) => !!d && d.slice(0, 10) >= y.start && d.slice(0, 10) <= y.end;

async function buildYear(db: Db, y: YearSpan): Promise<ArrayBuffer> {
  const wb = await workbook();
  const fund = (id: string | null) => db.funds.find((f) => f.id === id)?.name || id || '';
  const team = (id: string | null) => db.teams.find((t) => t.id === id)?.name || '';
  const donor = (id: string | null) => db.donors.find((d) => d.id === id);

  // Ledger: every entry dated in the year, reversals included (they are how money is undone).
  const L = db.ledger.filter((l) => inSpan(l.date, y)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  sheet(wb, 'Ledger', ['Id', 'Date', 'Description', 'From / To', 'Fund', 'Source', 'Category', 'In', 'Out', 'Receipt', 'Paid By', 'Reference',
    'Request', 'Reverses', 'Reversed By', 'Reason'],
  L.map((l) => [l.id, l.date, l.memo, l.donor_id ? donor(l.donor_id)?.name || l.party : l.party, fund(l.fund_id),
    l.source, l.category, l.dir === 'in' ? l.amount : null, l.dir === 'out' ? l.amount : null, l.receipt ? 'On file' : (l.dir === 'out' ? 'Missing' : null),
    l.pay_method, l.pay_ref, l.request_id, l.reverses_id, l.reversed_by_id, l.reason].map(cell)));

  // Donations: gifts dated in the year (archived gifts are already off the books and left out).
  const D = db.donations.filter((d) => inSpan(d.date, y)).sort((a, b) => (a.date < b.date ? -1 : 1));
  sheet(wb, 'Donations', ['Id', 'Date', 'Donor', 'Anonymous', 'Type', 'Amount', 'Refunded', 'Fund', 'Channel', 'Recurring', 'Grant', 'Thanked', 'Zeffy Payout'],
    D.map((d) => { const o = donor(d.donor_id); return [d.id, d.date, o?.name, o?.anonymous, o?.type, d.amount, d.refunded || null, fund(d.fund_id), d.channel,
      d.recurring, d.grant_id, d.thanked, d.payout_date].map(cell); }));

  // Requests: submitted (or paid) in the year.
  const R = db.team_requests.filter((r) => inSpan(r.submitted || r.created_at, y) || inSpan(r.paid_date, y)).sort((a, b) => ((a.submitted || '') < (b.submitted || '') ? -1 : 1));
  sheet(wb, 'Requests', ['Id', 'Submitted', 'Type', 'Team', 'Charged To', 'Purpose', 'Category', 'Amount', 'Status', 'Requested By', 'Vendor', 'Paid', 'Paid By',
    'Reference', 'Receipts', 'Returned', 'Approvals'],
  R.map((r) => [r.id, r.submitted, r.type, team(r.team_id), fund(r.charge_fund_id || db.teams.find((t) => t.id === r.team_id)?.fund_id || null), r.purpose, r.category,
    r.amount, r.status, r.requestor_name, r.vendor, r.paid_date, r.pay_method, r.pay_ref,
    Math.round(db.receipts.filter((x) => x.request_id === r.id).reduce((a, x) => a + x.amount, 0) * 100) / 100, r.returned || null,
    db.request_approvals.filter((a) => a.request_id === r.id).map((a) => a.approver_name).join(', ')].map(cell)));

  // Bank months: each statement month in the year, its lines matched or not.
  const S = db.bank_statements.filter((s) => inSpan(s.month, y)).sort((a, b) => (a.month < b.month ? -1 : 1));
  sheet(wb, 'Bank Months', ['Month', 'Ending Balance', 'Lines', 'Lines Matched', 'Money In', 'Money Out', 'Reconciled', 'Reconciled By', 'Statement File', 'Notes'],
    S.map((s) => {
      const lines = db.bank_lines.filter((b) => b.statement_id === s.id);
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return [s.month.slice(0, 7), s.ending_balance, lines.length, lines.filter((b) => b.matched_ledger_id || b.matched_payout_date).length,
        r2(lines.filter((b) => b.amount > 0).reduce((a, b) => a + b.amount, 0)), r2(-lines.filter((b) => b.amount < 0).reduce((a, b) => a + b.amount, 0)),
        s.locked_at ? s.locked_at.slice(0, 10) : null, s.locked_by, s.file_name, s.notes].map(cell);
    }));
  rawSheet(wb, 'Bank Lines', db.bank_lines as unknown as Record<string, unknown>[],
    db.bank_lines.filter((b) => inSpan(b.date, y)) as unknown as Record<string, unknown>[]);

  // Fund balances: opening at the start of the year, money in and out during it, balance at its end.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const net = (l: { dir: string; amount: number }) => (l.dir === 'in' ? l.amount : -l.amount);
  sheet(wb, 'Fund Balances', ['Fund', 'Restricted', 'Team', 'Opening', 'Money In', 'Money Out', 'Closing'],
    db.funds.slice().sort((a, b) => a.name.localeCompare(b.name)).map((f) => {
      const mine = db.ledger.filter((l) => l.fund_id === f.id);
      const opening = r2(mine.filter((l) => l.date < y.start).reduce((a, l) => a + net(l), 0));
      const during = mine.filter((l) => inSpan(l.date, y));
      const inn = r2(during.filter((l) => l.dir === 'in').reduce((a, l) => a + l.amount, 0));
      const out = r2(during.filter((l) => l.dir === 'out').reduce((a, l) => a + l.amount, 0));
      return [f.name, f.restricted, team(f.team_id || db.teams.find((t) => t.fund_id === f.id)?.id || null), opening, inn, out, r2(opening + inn - out)].map(cell);
    }));
  // No assets register exists in the portal yet; the sheet is added when one does.
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export function YearExportModal() {
  const { db, calc } = useData();
  const ui = useUI();
  const [kind, setKind] = useState<'fiscal' | 'calendar'>('fiscal');
  const spans = yearSpans(db, calc.today, kind);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const y = spans.find((s) => s.label === pick) || spans[0];

  const go = async () => {
    if (!y) return;
    setBusy(true);
    try {
      download(`GPRIC-${fileName(y.label)}.xlsx`, await buildYear(db, y), XLSX);
      ui.toast(`${y.label} export ready`);
      ui.close();
    } catch (e) { ui.toast('Export failed: ' + (e as Error).message, true); }
    setBusy(false);
  };
  return (
    <Modal view title="Year Export" wide foot={<><button className="btn" onClick={ui.close}>Cancel</button><button className="btn pri" onClick={go} disabled={busy || !y}>{busy ? 'Building…' : 'Export'}</button></>}>
      <Kv k="Year Type"><Seg value={kind} onChange={(v) => { setKind(v); setPick(''); }} options={[['fiscal', 'Fiscal Year'], ['calendar', 'Calendar Year']]} /></Kv>
      <Kv k="Year">{spans.length ? <Seg value={y?.label || ''} onChange={setPick} options={spans.map((s) => s.label)} /> : 'No entries yet.'}</Kv>
      <Kv k="Format">Excel (.xlsx)</Kv>
      <Kv k="Includes">Sheets for the Ledger, Donations, Requests, Bank Months, Bank Lines and Fund Balances (opening, in, out and closing).</Kv>
      <div className="full muted">{y ? `Records dated ${y.start} to ${y.end}. Donors who asked to stay anonymous are named, with the Anonymous column marked: this is the books' copy.` : ''}</div>
    </Modal>
  );
}
