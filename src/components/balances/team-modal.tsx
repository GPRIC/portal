'use client';
// One team's transactions: every ledger row behind its balance, by kind, as the mockup's team modal.
import { useData } from '@/components/data';
import { Badge, Modal, Table, useUI, type Col, type Tone } from '@/components/ui';
import type { MoneyKind } from '@/lib/calc';
import type { Ledger } from '@/lib/types';
import { sd } from '@/lib/format';
import { Cash, cash, download } from './hint';

export const KTONE: Record<MoneyKind, Tone> = { Zeffy: 'grn', Deposit: 'blu', Reimbursement: 'vio', 'Direct Expense': 'gry', 'Carry-Over': 'gry' };

/** Ledger rows that repeat another row exactly (same date, party, amount and memo): likely entered twice. */
export function duplicateIds(rows: Ledger[]): Set<string> {
  const seen = new Map<string, string>();
  const dup = new Set<string>();
  rows.slice().sort((a, b) => a.id.localeCompare(b.id)).forEach((l) => {
    if (l.source === 'Opening Balance') return;
    const k = [l.fund_id, l.date, l.dir, l.amount, (l.party || '').toLowerCase(), (l.memo || '').toLowerCase()].join('|');
    if (seen.has(k)) dup.add(l.id); else seen.set(k, l.id);
  });
  return dup;
}

export function TeamModal({ fundId }: { fundId: string }) {
  const { db, calc } = useData();
  const ui = useUI();
  const f = calc.fund(fundId);
  if (!f) return <Modal title="Team"><div className="full muted">This fund no longer exists.</div></Modal>;
  const m = calc.fundMoney(f);
  const name = m.team?.name || f.name;
  const rows = db.ledger.filter((l) => l.fund_id === fundId);
  const dup = duplicateIds(rows);
  const party = (l: Ledger) => (l.donor_id ? calc.donor(l.donor_id)?.name || l.party || '' : l.party || '') || (l.source === 'Opening Balance' ? 'Starting balance' : '');
  const detail = (l: Ledger) => [l.memo || l.category || l.source, l.pay_method && (l.pay_method + (l.pay_ref ? ' #' + l.pay_ref.replace(/^#/, '') : ''))].filter(Boolean).join(' · ');
  const signed = (l: Ledger) => (l.dir === 'in' ? l.amount : -l.amount);

  const cols: Col<Ledger>[] = [
    { k: 'date', label: 'Date', html: (l) => sd(l.date) },
    { k: 'kind', label: 'Kind', sv: (l) => calc.kindOf(l), html: (l) => <Badge tone={KTONE[calc.kindOf(l)]}>{calc.kindOf(l)}</Badge> },
    { k: 'party', label: 'From Or To', sv: party, html: party },
    { k: 'memo', label: 'Detail', sv: detail, html: (l) => {
      const d = calc.donation(l.donation_id);
      return <>{detail(l)}
        {dup.has(l.id) ? <> <span title="Same date, party, amount and detail as another row in this team"><Badge tone="amb">Possible Duplicate</Badge></span></> : null}
        {d?.unassigned ? <> <span title="Zeffy Fund was blank, so it landed in the general fund; see Unassigned Gifts"><Badge tone="amb">Fund Blank</Badge></span></> : null}
      </>;
    } },
    { k: 'amount', label: 'Amount', num: true, sv: signed, html: (l) => <span style={{ color: l.dir === 'in' ? 'var(--g)' : 'var(--t)' }}>{l.dir === 'in' ? '+' : ''}{cash(signed(l))}</span> },
  ];

  const csv = () => {
    const q = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [['Date', 'Kind', 'From Or To', 'Detail', 'Amount'].join(',')]
      .concat(rows.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((l) => [l.date, calc.kindOf(l), party(l), detail(l), signed(l).toFixed(2)].map(q).join(',')));
    download(name.replace(/[^\w\- ]+/g, '').trim() + ' transactions.csv', lines.join('\r\n'), 'text/csv');
  };

  const inn = m.carry + m.zeffy + m.deposits, out = m.reimbursements + m.direct;
  return (
    <Modal view title={name} wide foot={<><button className="btn" onClick={ui.close}>Close</button><button className="btn" onClick={csv} disabled={!rows.length}>Export CSV</button></>}>
      <div className="full bal-sum">
        <span className="muted">Balance <b>{m.balance < 0 ? <span className="neg">{cash(m.balance)}</span> : <Cash n={m.balance} />}</b></span>
        <span className="muted">In {cash(inn)}</span>
        <span className="muted">Out {cash(-out)}</span>
        <span className="muted">{rows.length} Transactions</span>
      </div>
      {rows.length ? (
        <div className="full bal-tx">
          <Table cols={cols} rows={rows} sort="date" dir={-1} />
        </div>
      ) : <div className="full empty">No transactions yet. Gifts with this team in the Zeffy Fund field will appear here.</div>}
    </Modal>
  );
}
