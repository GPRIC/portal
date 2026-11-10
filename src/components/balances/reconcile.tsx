'use client';
// Monthly Reconciliation: the bank statement for a month, its lines matched to portal records, the workbook SOP
// (bank ending balance = book balance + outstanding checks and Zelle − Zeffy payouts in transit), and the lock.
import { useEffect, useRef, useState } from 'react';
import { openFile, rpc, uploadFile, useData } from '@/components/data';
import { Badge, Modal, Table, useUI, type Col } from '@/components/ui';
import { Tip } from '@/components/tips';
import { date, monthName, sd } from '@/lib/format';
import {
  bankAmount, bankLinesFromCsv, candidates, isMatched, matchPatch, monthEnd, monthStart, prevMonth, reconcileDue, suggestAll,
  type Match, type NewBankLine,
} from '@/lib/bank';
import type { BankLine, BankStatement, Ledger } from '@/lib/types';
import { cash, Hint, Info } from './hint';

const mon = (month: string) => monthName(month).split(' ')[0];

/** The month to show first: the oldest month with a statement still open, else last month. */
export function defaultMonth(statements: BankStatement[], today: string): string {
  const last = prevMonth(today);
  const open = statements.filter((s) => !s.locked_at && s.month <= last).map((s) => s.month).sort();
  return open[0] || last;
}

async function ensureStatement(month: string, existing: BankStatement | undefined): Promise<{ id: string } | { error: string }> {
  if (existing) return { id: existing.id };
  const { data, error } = await rpc('bank_statement_add', { p_month: month });
  if (error || !data) return { error: error?.message || 'Could not create the statement' };
  return { id: String(data) };
}

/** A bank line's match, through bank_line_match. */
function saveMatch(id: string, m: Match | null) {
  const p = matchPatch(m);
  return rpc('bank_line_match', { p_id: id, p_ledger_id: p.matched_ledger_id, p_payout_date: p.matched_payout_date });
}

export function ReconcilePanel({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const { db, calc, run, isTreasurer } = useData();
  const ui = useUI();
  const st = db.bank_statements.find((s) => s.month === month);
  const locked = !!st?.locked_at;
  const end = monthEnd(month);
  const [typed, setTyped] = useState<{ month: string; v: string } | null>(null);
  const shown = typed && typed.month === month ? typed.v : st?.ending_balance != null ? st.ending_balance.toFixed(2) : '';
  const bank = bankAmount(shown);
  // The figures come from the database (bank_month_figures); calc only lists the items behind them for the tips.
  const items = calc.reconcile(end);
  const [fig, setFig] = useState<{ month: string; book: number; outstanding: number; transit: number; expected: number } | null>(null);
  useEffect(() => {
    let live = true;
    rpc('bank_month_figures', { p_month: month }).then(({ data }) => {
      if (live && data) setFig({ month, book: Number(data.book), outstanding: Number(data.outstanding), transit: Number(data.transit), expected: Number(data.expected) });
    });
    return () => { live = false; };
  }, [month, db]);
  const f = fig && fig.month === month ? fig : null;
  const rec = {
    outstanding: items.outstanding, transit: items.transit,
    book: f?.book ?? 0, outstandingTotal: f?.outstanding ?? 0, transitTotal: f?.transit ?? 0, expected: f?.expected ?? 0,
    difference: bank == null || !f ? null : Math.round((bank - f.expected) * 100) / 100,
  };
  const lines = db.bank_lines.filter((b) => st && b.statement_id === st.id);
  const matched = lines.filter(isMatched).length;
  const due = reconcileDue(month);
  const ok = !locked && rec.difference === 0;

  const saveEnding = async () => {
    if (locked || bank == null || (st && st.ending_balance === bank)) return;
    const s = await ensureStatement(month, st);
    if ('error' in s) { ui.toast(s.error, true); return; }
    await run(() => rpc('bank_statement_set', { p_id: s.id, p: { ending_balance: bank } }));
  };
  const lock = async () => {
    if (!ok || bank == null) return;
    const yes = await ui.confirm({
      title: 'Mark ' + mon(month) + ' Reconciled',
      body: <>The books match the bank at {cash(bank)}. Marking {monthName(month)} reconciled locks it: no ledger entry, bank line or statement for {mon(month)} can be added, changed or removed after this. A later fix goes in as a correction dated in an open month. Only the Treasurer can unlock a month, with a reason.</>,
      ok: 'Mark Reconciled',
    });
    if (!yes) return;
    const s = await ensureStatement(month, st);
    if ('error' in s) { ui.toast(s.error, true); return; }
    await run(() => rpc('lock_bank_month', { p_statement_id: s.id, p_ending: bank }), monthName(month) + ' reconciled');
  };
  const unlock = async () => {
    if (!st || !locked) return;
    const why = await ui.ask({ title: 'Unlock ' + monthName(month), body: <>Unlocking lets entries, bank lines and the statement for {mon(month)} change again. The reason is kept on the statement.</>, ok: 'Unlock Month', danger: true });
    if (!why) return;
    await run(() => rpc('unlock_bank_month', { p_statement_id: st.id, p_reason: why }), monthName(month) + ' unlocked');
  };

  const outLines = rec.outstanding.slice(0, 8).map((l) => `${l.pay_method === 'Check' && l.pay_ref ? 'Check #' + l.pay_ref.replace(/^#/, '') : l.pay_method || 'Payment'} to ${l.party || 'payee'}, ${sd(l.date)}, ${cash(l.amount)}`);
  const transitBy = rec.transit.slice().sort((a, b) => b.amount - a.amount).slice(0, 6).map((d) => `${calc.donor(d.donor_id)?.name || 'Gift'} ${sd(d.date)}, ${cash(d.amount)}`);
  const status = locked ? <Badge tone="grn">Reconciled</Badge>
    : calc.today > due ? <Hint r tip="Due by the 5th business day of the month"><Badge tone="red">Overdue Since {sd(due)}</Badge></Hint>
      : <Hint r tip="Due by the 5th business day of the month"><Badge tone="amb">Due {sd(due)}</Badge></Hint>;

  // Months table: every statement, plus last month when it has none yet.
  const months = new Set(db.bank_statements.map((s) => s.month));
  months.add(prevMonth(calc.today));
  months.add(month);
  type MR = { id: string; month: string; s?: BankStatement };
  const mrows: MR[] = [...months].map((m) => ({ id: m, month: m, s: db.bank_statements.find((x) => x.month === m) }));
  const mcols: Col<MR>[] = [
    { k: 'month', label: 'Month', html: (r) => <span style={r.month === month ? { color: 'var(--g)' } : undefined}>{monthName(r.month).replace(/^(\w{3})\w*/, '$1')}</span> },
    { k: 'status', label: 'Status', sv: (r) => (r.s?.locked_at ? 1 : 0), html: (r) => (r.s?.locked_at ? <Badge tone="grn">Reconciled</Badge> : <Badge tone="amb">Not Reconciled</Badge>) },
    { k: 'by', label: 'Reconciled By', sv: (r) => r.s?.locked_by || '', html: (r) => (r.s?.locked_at ? (r.s.locked_by || 'Board').split('@')[0] + ' · ' + sd(r.s.locked_at) : '') },
    { k: 'bal', label: 'Bank Balance', num: true, sv: (r) => (r.s?.locked_at ? r.s.ending_balance ?? 0 : 0), html: (r) => (r.s?.locked_at && r.s.ending_balance != null ? cash(r.s.ending_balance) : '') },
  ];

  return (
    <div className="panel">
      <div className="ph"><h2>Monthly Reconciliation</h2><span className="muted">{monthName(month)}</span><span className="sp" />{status}</div>
      <div className="kvs">
        <div className="k">Bank Statement</div>
        <div className="v">
          <span className="btnrow" style={{ justifyContent: 'flex-end' }}>
            {st?.file_path ? <button type="button" className="doclink" onClick={() => openFile(st.file_path!)}>{st.file_name || 'Statement'}</button> : <span className="muted">None yet</span>}
            <Tip id="balances.statement" side="r" text="Upload the Citizens statement each month. A CSV fills in the bank lines; a PDF is kept on file and its lines are entered by hand.">
              <button className="btn sm" onClick={() => ui.open(<StatementModal month={month} />)}>{lines.length ? `Bank Lines · ${matched} of ${lines.length} Matched` : locked ? 'Bank Lines' : 'Upload Statement'}</button>
            </Tip>
          </span>
        </div>
        <div className="k">Bank Ending Balance, {sd(end)}</div>
        <div className="v">{locked ? cash(st?.ending_balance || 0)
          : <input className="in bal-in" inputMode="decimal" placeholder="$0.00" value={shown} onChange={(e) => setTyped({ month, v: e.target.value })} onBlur={saveEnding} />}</div>
        <div className="k">Sum Of Team Balances<Info tip={'Book balance on ' + date(end) + ': every fund, carry-over plus money in less money out, up to that day.'} /></div>
        <div className="v">{cash(rec.book)}</div>
        <div className="k">Outstanding Checks And Zelle<Info tip={outLines.length ? <>{outLines.map((t, i) => <div key={i}>{t}</div>)}{rec.outstanding.length > outLines.length ? <div>and {rec.outstanding.length - outLines.length} more. Match bank lines to clear them.</div> : null}<div>Written, not yet cleared by the bank.</div></> : 'Nothing written and not yet cleared.'} /></div>
        <div className="v">+{cash(rec.outstandingTotal)}</div>
        <div className="k">Zeffy Payouts In Transit<Info tip={<>{transitBy.map((t, i) => <div key={i}>{t}</div>)}<div>Counted in balances, not yet in the bank. Not in the workbook formula.</div></>} /></div>
        <div className="v">{rec.transitTotal ? '−' + cash(rec.transitTotal) : cash(0)}</div>
        <div className="k">Expected Bank Balance</div>
        <div className="v">{cash(rec.expected)}</div>
        <div className="k">Difference</div>
        <div className="v">{locked ? <Badge tone="grn">$0.00 · Balanced</Badge>
          : rec.difference == null ? <span className="muted">Enter the bank balance</span>
            : rec.difference === 0 ? <Badge tone="grn">$0.00 · Balanced</Badge>
              : <Hint r tip="Look for uncleared items, unassigned Zeffy gifts, or a deposit not yet logged"><Badge tone="red">{cash(rec.difference)} · Off</Badge></Hint>}</div>
      </div>
      {st?.unlock_reason && !locked ? <div className="muted" style={{ margin: '6px 0' }}>Unlocked {st.unlocked_at ? sd(st.unlocked_at.slice(0, 10)) : ''}{st.unlocked_by ? ' by ' + st.unlocked_by : ''}: {st.unlock_reason}</div> : null}
      {locked ? (isTreasurer ? <div className="bal-acts"><button className="btn" onClick={unlock}>Unlock {mon(month)}</button></div> : null) : (
        <div className="bal-acts">
          <Hint r tip={ok ? '' : 'Enter the bank balance; the difference must be $0.00'}>
            <button className="btn pri" onClick={lock} disabled={!ok}>Mark {mon(month)} Reconciled</button>
          </Hint>
        </div>
      )}
      <Table cols={mcols} rows={mrows} sort="month" dir={-1} onRow={(r) => setMonth(r.month)} />
    </div>
  );
}

/* ---------- statement upload and line matching ---------- */

function ledgerLabel(l: Ledger, party: string) {
  return `${sd(l.date)} · ${party || l.source || l.category || 'Entry'}${l.memo ? ' · ' + l.memo : ''} · ${cash(l.dir === 'in' ? l.amount : -l.amount)}`;
}

function StatementModal({ month }: { month: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState({ date: '', description: '', amount: '' });
  const [picking, setPicking] = useState<string | null>(null);
  const st = db.bank_statements.find((s) => s.month === month);
  const locked = !!st?.locked_at;
  const lines = db.bank_lines.filter((b) => st && b.statement_id === st.id);
  const sugg = st ? suggestAll(db, st.id) : new Map<string, Match>();
  const party = (l: Ledger) => (l.donor_id ? calc.donor(l.donor_id)?.name || l.party || '' : l.party || '');
  const describe = (m: Match) => ('ledger' in m ? ledgerLabel(m.ledger, party(m.ledger)) : `Zeffy payout ${sd(m.payout.date)} · ${m.payout.count} gifts · ${cash(m.payout.total)}`);
  const current = (b: BankLine): Match | null => {
    if (b.matched_payout_date) {
      const gifts = db.donations.filter((d) => d.channel === 'Zeffy' && d.payout_date === b.matched_payout_date);
      return { payout: { date: b.matched_payout_date, count: gifts.length, total: gifts.reduce((s, d) => s + d.amount - (d.refunded || 0), 0) } };
    }
    const l = b.matched_ledger_id ? db.ledger.find((x) => x.id === b.matched_ledger_id) : null;
    return l ? { ledger: l } : null;
  };

  const setMatch = (b: BankLine, m: Match | null, ok?: string) =>
    run(() => saveMatch(b.id, m), ok);

  const confirmAll = async () => {
    setBusy(true);
    await run(async () => {
      for (const [id, m] of sugg) {
        const { error } = await saveMatch(id, m);
        if (error) return { error };
      }
      return { error: null };
    }, sugg.size + ' matches confirmed');
    setBusy(false);
  };

  const upload = async (f: File) => {
    setBusy(true);
    try {
      const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv';
      let parsed: NewBankLine[] = [];
      if (isCsv) parsed = bankLinesFromCsv(await f.text());
      const s = await ensureStatement(month, st);
      if ('error' in s) throw new Error(s.error);
      const up = await uploadFile('bank-statements', f);
      if ('error' in up) throw new Error(up.error);
      const inMonth = parsed.filter((l) => monthStart(l.date) === month);
      const key = (l: { date: string; amount: number; description: string | null }) => `${l.date}|${l.amount.toFixed(2)}|${(l.description || '').toLowerCase()}`;
      const have = new Set(db.bank_lines.filter((b) => b.statement_id === s.id).map(key));
      const fresh = inMonth.filter((l) => !have.has(key(l)));
      const res = await run(async () => {
        const a = await rpc('bank_statement_set', { p_id: s.id, p: { file_path: up.path, file_name: up.name } });
        if (a.error) return a;
        if (fresh.length) return rpc('bank_lines_add', { p_statement_id: s.id, p_rows: fresh });
        return { error: null };
      });
      if (res !== false) {
        const skipped = parsed.length - inMonth.length;
        ui.toast(isCsv ? `${fresh.length} bank lines added${skipped ? `, ${skipped} outside ${mon(month)} skipped` : ''}${inMonth.length - fresh.length ? `, ${inMonth.length - fresh.length} already loaded` : ''}` : 'Statement saved. Add its lines below, or upload the CSV too.');
      }
    } catch (e) { ui.toast((e as Error).message, true); }
    if (file.current) file.current.value = '';
    setBusy(false);
  };

  const addLine = async () => {
    const amount = bankAmount(add.amount);
    if (!add.date || !amount) { ui.toast('Enter a date and an amount (negative for money out).', true); return; }
    if (monthStart(add.date) !== month) { ui.toast('That date is not in ' + monthName(month) + '.', true); return; }
    const s = await ensureStatement(month, st);
    if ('error' in s) { ui.toast(s.error, true); return; }
    const r = await run(() => rpc('bank_lines_add', { p_statement_id: s.id, p_rows: [{ date: add.date, description: add.description.trim() || null, amount }] }), 'Bank line added');
    if (r !== false) setAdd({ date: '', description: '', amount: '' });
  };

  const removeLine = async (b: BankLine) => {
    const why = await ui.ask({ title: 'Remove Bank Line', body: <>Take the {cash(b.amount)} line of {date(b.date)} off this statement? It stays on record as removed.</>, ok: 'Remove', danger: true });
    if (why) await run(() => rpc('bank_line_archive', { p_id: b.id, p_reason: why }), 'Bank line removed');
  };

  const cols: Col<BankLine>[] = [
    { k: 'date', label: 'Date', html: (b) => sd(b.date) },
    { k: 'description', label: 'Description', html: (b) => <span className="wraptext" style={{ display: 'inline-block' }}>{b.description || ''}</span> },
    { k: 'amount', label: 'Amount', num: true, html: (b) => <span style={{ color: b.amount > 0 ? 'var(--g)' : undefined }}>{b.amount > 0 ? '+' : ''}{cash(b.amount)}</span> },
    { k: 'match', label: 'Portal Record', sv: (b) => (isMatched(b) ? 2 : sugg.has(b.id) ? 1 : 0), html: (b) => {
      const cur = current(b), s = sugg.get(b.id);
      if (picking === b.id) {
        const opts = candidates(db, b);
        return (
          <select className="in" autoFocus defaultValue="" style={{ minWidth: 280 }}
            onChange={async (e) => { const m = opts[+e.target.value]; setPicking(null); if (m) await setMatch(b, m, 'Matched'); }}
            onBlur={() => setPicking(null)}>
            <option value="" disabled>Pick the portal record…</option>
            {opts.map((m, i) => <option key={i} value={i}>{describe(m)}</option>)}
          </select>
        );
      }
      if (cur) return <span className="wraptext" style={{ display: 'inline-block' }}><Badge tone="grn">Matched</Badge> {describe(cur)}</span>;
      if (s) return <span className="wraptext" style={{ display: 'inline-block' }}><Badge tone="blu">Suggested</Badge> {describe(s)}</span>;
      return <Badge tone="amb">Not Matched</Badge>;
    } },
    { k: 'act', label: '', nosort: true, html: (b) => {
      if (locked) return '';
      const s = sugg.get(b.id);
      return (
        <span className="btnrow" style={{ flexWrap: 'nowrap' }}>
          {isMatched(b) ? <button className="btn sm" onClick={() => setMatch(b, null, 'Unmatched')}>Unmatch</button> : <>
            {s ? <button className="btn sm pri" onClick={() => setMatch(b, s, 'Matched')}>Confirm</button> : null}
            <button className="btn sm" onClick={() => setPicking(b.id)}>Pick</button>
          </>}
          <button className="btn sm ghost" onClick={() => removeLine(b)} aria-label="Remove line">✕</button>
        </span>
      );
    } },
  ];

  return (
    <Modal title={'Bank Statement · ' + monthName(month)} wide foot={<>
      <span>{locked ? <Badge tone="grn">Reconciled and locked</Badge> : null}</span>
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Close</button>
        {!locked && sugg.size ? <button className="btn pri" onClick={confirmAll} disabled={busy}>Confirm {sugg.size} Suggested</button> : null}
      </span>
    </>}>
      <div className="k">Statement File</div>
      <div className="btnrow">
        {st?.file_path ? <button type="button" className="doclink" onClick={() => openFile(st.file_path!)}>{st.file_name || 'Statement'}</button> : <span className="muted">None yet</span>}
        {locked ? null : <>
          <input ref={file} className="bal-file" type="file" accept=".csv,.pdf,text/csv,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <button className="btn sm" onClick={() => file.current?.click()} disabled={busy}>{busy ? 'Working…' : st?.file_path ? 'Upload Another (CSV Or PDF)' : 'Upload Statement (CSV Or PDF)'}</button>
        </>}
      </div>
      <div className="full muted">A CSV with Date, Description and Amount (or Debit and Credit) columns fills in the lines. A PDF is kept on file; enter its lines below. Lines match a portal record of the same amount within 5 days, or a Zeffy payout that adds up to the deposit.</div>
      <div className="full" style={{ margin: '0 -14px' }}>
        <Table cols={cols} rows={lines} sort="date" dir={1} empty="No bank lines yet." />
      </div>
      {locked ? null : <>
        <div className="k">Add A Line</div>
        <div className="btnrow" style={{ flexWrap: 'nowrap' }}>
          <input className="in" type="date" style={{ width: 150 }} value={add.date} min={month} max={monthEnd(month)} onChange={(e) => setAdd({ ...add, date: e.target.value })} />
          <input className="in" placeholder="Description" value={add.description} onChange={(e) => setAdd({ ...add, description: e.target.value })} />
          <input className="in" style={{ width: 120 }} inputMode="decimal" placeholder="-26.13" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} />
          <button className="btn sm" onClick={addLine}>Add</button>
        </div>
      </>}
    </Modal>
  );
}
