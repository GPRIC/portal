'use client';
// Quarterly Export: one Excel workbook with a Team Balances sheet and one sheet per table, for the accountant and the board archive.
// Dated tables keep only rows dated in the quarter; reference tables (teams, funds, donors, grants) keep every row.
import { useState } from 'react';
import { useData } from '@/components/data';
import { Kv, Modal, Seg, useUI } from '@/components/ui';
import { Calc } from '@/lib/calc';
import { date } from '@/lib/format';
import { recentQuarters, type Quarter } from '@/lib/bank';
import type { Db } from '@/lib/types';
import { download } from './hint';

type Sheet = 'ledger' | 'donations' | 'donors' | 'grants' | 'team_requests' | 'receipts' | 'request_approvals' | 'bank_statements' | 'bank_lines' | 'teams' | 'funds';
const SHEETS: Sheet[] = ['ledger', 'donations', 'donors', 'grants', 'team_requests', 'receipts', 'request_approvals', 'bank_statements', 'bank_lines', 'teams', 'funds'];
/** The date each dated table is filtered by; tables not listed are reference tables and export whole. */
const DATED: Partial<Record<Sheet, (r: Record<string, unknown>) => string | null>> = {
  ledger: (r) => r.date as string,
  donations: (r) => r.date as string,
  team_requests: (r) => (r.submitted as string) || (r.created_at as string) || null,
  receipts: (r) => r.date as string,
  request_approvals: (r) => r.approved_at as string,
  bank_statements: (r) => r.month as string,
  bank_lines: (r) => r.date as string,
};

function cell(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

async function buildWorkbook(db: Db, q: Quarter, today: string): Promise<ArrayBuffer> {
  const m = await import('exceljs');
  const Workbook = m.Workbook ?? (m as unknown as { default: typeof m }).default.Workbook;
  const wb = new Workbook();
  wb.creator = 'GPRIC Board Portal';
  wb.created = new Date();
  const asOf = q.end < today ? q.end : today;

  // Team Balances at the quarter end (or today, for the quarter in progress).
  const calc = new Calc({ ...db, ledger: db.ledger.filter((l) => l.date <= asOf) }, asOf);
  const tb = wb.addWorksheet('Team Balances');
  tb.addRow([`Team Balances as of ${date(asOf)}`]).font = { bold: true };
  tb.addRow([]);
  const head = tb.addRow(['Team', 'Carry-Over', 'Zeffy', 'Deposits', 'Reimbursements', 'Direct Expenses', 'Balance']);
  head.font = { bold: true };
  const rows = calc.teamBalances();
  rows.forEach((r) => tb.addRow([r.team?.name || r.fund.name, r.carry, r.zeffy, r.deposits, r.reimbursements, r.direct, r.balance]));
  const s = (k: 'carry' | 'zeffy' | 'deposits' | 'reimbursements' | 'direct' | 'balance') => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
  tb.addRow(['Total', s('carry'), s('zeffy'), s('deposits'), s('reimbursements'), s('direct'), s('balance')]).font = { bold: true };
  const g = calc.grants();
  g.awarded.filter((x) => x.received < x.awarded).forEach((x) => tb.addRow([`Awarded, not received (not cash): ${x.funder}`, null, null, null, null, null, x.awarded - x.received]));
  tb.columns = [{ width: 44 }, ...Array.from({ length: 6 }, () => ({ width: 16, style: { numFmt: '#,##0.00' } }))];

  for (const name of SHEETS) {
    const all = db[name] as unknown as Record<string, unknown>[];
    const f = DATED[name];
    const keep = f ? all.filter((r) => { const d = f(r); return !!d && d.slice(0, 10) >= q.start && d.slice(0, 10) <= q.end; }) : all;
    const ws = wb.addWorksheet(name);
    const cols = [...new Set(all.flatMap((r) => Object.keys(r)))];
    if (!cols.length) { ws.addRow(['No rows']); continue; }
    ws.addRow(cols).font = { bold: true };
    keep.forEach((r) => ws.addRow(cols.map((c) => cell(r[c]))));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns.forEach((c) => { c.width = 16; });
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export function ExportModal() {
  const { db, calc } = useData();
  const ui = useUI();
  const qs = recentQuarters(calc.today, 4);
  // Default to the last finished quarter, as the accountant asks for.
  const [pick, setPick] = useState(qs[1] ? `${qs[1].year}-${qs[1].q}` : `${qs[0].year}-${qs[0].q}`);
  const [busy, setBusy] = useState(false);
  const q = qs.find((x) => `${x.year}-${x.q}` === pick) || qs[0];

  const go = async () => {
    setBusy(true);
    try {
      const buf = await buildWorkbook(db, q, calc.today);
      download(`GPRIC-${q.year}-Q${q.q}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      ui.toast(`Q${q.q} ${q.year} export ready`);
      ui.close();
    } catch (e) { ui.toast('Export failed: ' + (e as Error).message, true); }
    setBusy(false);
  };

  return (
    <Modal view title="Quarterly Export" wide foot={<><button className="btn" onClick={ui.close}>Cancel</button><button className="btn pri" onClick={go} disabled={busy}>{busy ? 'Building…' : 'Export'}</button></>}>
      <Kv k="Quarter"><Seg value={pick} onChange={setPick} options={qs.map((x, i) => [`${x.year}-${x.q}`, i === 0 && x.end >= calc.today ? `Q${x.q} ${x.year} · To Date` : x.label] as [string, string])} /></Kv>
      <Kv k="Format">Excel (.xlsx)</Kv>
      <Kv k="Includes">Team Balances at the quarter end, then one sheet per table: ledger, donations, donors, grants, team requests, receipts, approvals, bank statements, bank lines, teams and funds.</Kv>
      <div className="full muted">Dated records are limited to the quarter; donors, grants, teams and funds are included in full.</div>
    </Modal>
  );
}
