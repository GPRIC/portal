'use client';
// Team Balances (confirmed mockup 41): each team's money by kind, grants awarded but not cash, cash in the bank,
// the Zeffy connection, the monthly bank reconciliation and the quarterly export.
import { useState } from 'react';
import { Page } from '@/components/shell';
import { useData } from '@/components/data';
import { Badge, Table, useUI, type Col } from '@/components/ui';
import { Tip } from '@/components/tips';
import { Cash, cash, Hint } from '@/components/balances/hint';
import { duplicateIds, TeamModal } from '@/components/balances/team-modal';
import { ZeffyPanel } from '@/components/balances/zeffy';
import { defaultMonth, ReconcilePanel } from '@/components/balances/reconcile';
import { ExportModal } from '@/components/balances/export';
import { ListExport, YearExportModal } from '@/components/export';
import type { MoneyRow } from '@/lib/calc';
import { round2, sum } from '@/lib/format';
import './balances.css';

type Row = MoneyRow & { id: string; name: string; dup: boolean };

export default function BalancesPage() {
  const { db, calc, canExport } = useData();
  const ui = useUI();
  const [month, setMonth] = useState<string | null>(null);
  const g = calc.grants();
  const general = db.settings.general_fund_id;
  const pendingGrants = g.awarded.filter((x) => x.received < x.awarded);

  const rows: Row[] = calc.teamBalances().map((r) => ({
    ...r, id: r.fund.id, name: r.team?.name || r.fund.name,
    dup: duplicateIds(db.ledger.filter((l) => l.fund_id === r.fund.id)).size > 0,
  }));
  const tot = (k: 'carry' | 'zeffy' | 'deposits' | 'reimbursements' | 'direct' | 'balance') => round2(sum(rows, (r) => r[k]));
  const total = tot('balance');

  const cols: Col<Row>[] = [
    { k: 'name', label: 'Team', html: (r) => <>{r.name}{r.dup ? <> <span title="Possible duplicate expense: the same date, party and amount entered twice"><Badge tone="amb">Check</Badge></span></> : null}</> },
    { k: 'carry', label: 'Carry-Over', num: true, html: (r) => <Cash n={r.carry} /> },
    { k: 'zeffy', label: 'Zeffy', num: true, html: (r) => (r.fund.id === general && g.pending > 0
      ? <span title={'Excludes ' + cash(g.pending) + ' in grants awarded, not received.'}><Cash n={r.zeffy} /></span>
      : <Cash n={r.zeffy} />) },
    { k: 'deposits', label: 'Deposits', num: true, html: (r) => <Cash n={r.deposits} /> },
    { k: 'reimbursements', label: 'Reimbursements', num: true, html: (r) => <Cash n={r.reimbursements} out /> },
    { k: 'direct', label: 'Direct Expenses', num: true, html: (r) => <Cash n={r.direct} out /> },
    { k: 'balance', label: 'Balance', num: true, html: (r) => (r.balance < 0
      ? <span className="neg" title="Spent more than it has; GPRIC General is covering the gap">{cash(r.balance)}</span>
      : <Cash n={r.balance} />) },
  ];

  return (
    <Page title="Team Balances" help="balances" tools={canExport ? <>
      <ListExport name="Team Balances" cols={cols} rows={rows} />
      <button className="btn" onClick={() => ui.open(<YearExportModal />)} title="One workbook for a whole year: ledger, donations, requests, bank months and fund balances">Year Export</button>
      <Tip id="balances.export" side="r" text="Each quarter, save every record to one spreadsheet for the accountant and the board archive.">
        <Hint r tip="A permanent copy of the books for tax preparation and the board archive">
          <button className="btn" onClick={() => ui.open(<ExportModal />)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            Quarterly Export
          </button>
        </Hint>
      </Tip>
    </> : null}>
      <div className="panel bal-table">
        <Table cols={cols} rows={rows} sort="balance" dir={-1} onRow={(r) => ui.open(<TeamModal fundId={r.fund.id} />)} empty="No funds yet."
          foot={<tr>
            <td>Total</td>
            <td className="num">{cash(tot('carry'))}</td><td className="num">{cash(tot('zeffy'))}</td><td className="num">{cash(tot('deposits'))}</td>
            <td className="num">{cash(-tot('reimbursements'))}</td><td className="num">{cash(-tot('direct'))}</td><td className="num">{cash(total)}</td>
          </tr>} />
        <div className="bal-lines">
          {pendingGrants.map((x) => (
            <div className="bal-line" key={x.id}>
              <span>Awarded, Not Received</span>
              <span className="muted">{x.funder}{x.program ? ' · ' + x.program : ''}</span>
              <Hint tip="A grant award, not cash. It stays out of every team balance until the money arrives."><Badge tone="vio">Grant, Not Cash</Badge></Hint>
              <span className="amt" style={{ color: 'var(--vio)' }}>{cash(x.awarded - x.received)}</span>
            </div>
          ))}
          <div className="bal-line">
            <span>Cash In The Bank</span>
            <Hint tip="Book cash: the total of all team balances. Proven against the bank statement each month under Monthly Reconciliation."><span className="muted">Book balance, all teams</span></Hint>
            <span className="amt">{total < 0 ? <span className="neg">{cash(total)}</span> : cash(total)}</span>
          </div>
        </div>
      </div>

      <div className="bal-grid">
        <ZeffyPanel />
        <ReconcilePanel month={month || defaultMonth(db.bank_statements, calc.today)} setMonth={setMonth} />
      </div>
    </Page>
  );
}
