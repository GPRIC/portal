'use client';
// Transfer Money (0017, Josh 2026-11-20): moves money from one team's fund to another inside the books. The Treasurer
// and the bookkeeper make one, always with a reason. The money rules apply to the giving fund (overspend, restricted
// money), and only the Treasurer overrides them. A transfer is never undone: it is transferred back the other way.
import { useState } from 'react';
import { rpc, useData } from '@/components/data';
import { Amount, Area, DateIn, Err, Foot, FundSelect, num } from '@/components/forms';
import { Badge, Kv, Modal, useUI, Warnings } from '@/components/ui';
import { date, round2 } from '@/lib/format';
import type { Ledger } from '@/lib/types';
import { cash } from './hint';

/** What the database's spend_check will say about money leaving fromId for toId's team. */
function transferWarnings(calc: ReturnType<typeof useData>['calc'], db: ReturnType<typeof useData>['db'], fromId: string, toId: string, amount: number): string[] {
  const w: string[] = [];
  const f = calc.fund(fromId);
  if (!f || !toId || !(amount > 0)) return w;
  const bal = calc.fundBalance(fromId);
  if (amount > bal) w.push(`${f.name} has ${cash(bal)}. This takes it to ${cash(round2(bal - amount))}.`);
  if (f.restricted) {
    const toTeam = db.teams.find((t) => t.fund_id === toId)?.id || calc.fund(toId)?.team_id || null;
    if (f.team_id && toTeam !== f.team_id) w.push(`${f.name} is restricted to its own team.`);
    else if (!f.team_id) w.push(`${f.name} is restricted money: ${f.purpose || 'check the gift terms'}.`);
  }
  return w;
}

export function TransferButton() {
  const { canPay, readOnly } = useData();
  const ui = useUI();
  if (!canPay || readOnly) return null;
  return <button className="btn" onClick={() => ui.open(<TransferModal />)} title="Move money from one team to another inside the books. Logged, with a reason, and shown to both teams.">Transfer Money</button>;
}

export function TransferModal({ from, to }: { from?: string; to?: string }) {
  const { db, calc, run, isTreasurer } = useData();
  const ui = useUI();
  const [f, setF] = useState({ from: from || '', to: to || '', amount: '', date: calc.today, reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const amt = num(f.amount);
  const warnings = transferWarnings(calc, db, f.from, f.to, amt);

  const save = async () => {
    if (!f.from || !f.to) { setErr('Pick the team the money comes from and the team it goes to.'); return; }
    if (f.from === f.to) { setErr('Pick two different teams.'); return; }
    if (!(amt > 0)) { setErr('Enter an amount more than zero.'); return; }
    if (!f.reason.trim()) { setErr('Give a reason. Both teams see it.'); return; }
    let override: string | null = null;
    if (warnings.length) {
      if (!isTreasurer) { setErr('Blocked: ' + warnings.join(' ') + ' Only the Treasurer can override.'); return; }
      const why = await ui.ask({ title: 'Override A Money Rule', body: <>{warnings.map((w, i) => <div key={i}>{w}</div>)}</>, ok: 'Override And Transfer', label: 'Why this is allowed' });
      if (!why) return;
      override = why;
    }
    setBusy(true); setErr(null);
    const ok = await run(() => rpc('fund_transfer', { p_from: f.from, p_to: f.to, p_amount: amt, p_reason: f.reason.trim(), p_date: f.date || calc.today, p_override: override }),
      cash(amt) + ' transferred from ' + calc.fundName(f.from) + ' to ' + calc.fundName(f.to));
    setBusy(false);
    if (ok !== false) ui.close();
  };

  return (
    <Modal title="Transfer Money" foot={<Foot onSave={save} saveLabel="Transfer" busy={busy} />}>
      <Kv k="From"><FundSelect value={f.from} onChange={(v) => set({ from: v })} balances blank="Pick a team" /></Kv>
      <Kv k="To"><FundSelect value={f.to} onChange={(v) => set({ to: v })} balances blank="Pick a team" /></Kv>
      <Kv k="Amount"><Amount value={f.amount} onChange={(v) => set({ amount: v })} /></Kv>
      <Kv k="Date"><DateIn value={f.date} onChange={(v) => set({ date: v })} /></Kv>
      <Kv k="Reason"><Area value={f.reason} onChange={(v) => set({ reason: v })} placeholder="For example: parts shared at the scrimmage" /></Kv>
      <div className="full muted">Both teams see the transfer and the reason. It moves money inside the books only, so bank matching leaves it out. A transfer is never undone: to reverse it, transfer the money back the other way.</div>
      <Warnings list={warnings} blocks />
      <Err msg={err} />
    </Modal>
  );
}

/** One side of a transfer, read only, with the other side and a way to send the money back. */
export function TransferEntry({ l }: { l: Ledger }) {
  const { db, calc, canPay, readOnly } = useData();
  const ui = useUI();
  const other = db.ledger.find((x) => x.transfer_id === l.transfer_id && x.id !== l.id);
  const fromId = l.dir === 'out' ? l.fund_id : other?.fund_id;
  const toId = l.dir === 'in' ? l.fund_id : other?.fund_id;
  const reason = (l.memo || '').replace(/^Transfer (to|from) .*?: /, '');
  return (
    <Modal view title={l.memo || 'Transfer'}>
      <Kv k="Kind"><Badge tone="blu">Transfer</Badge> <span className="muted">{l.transfer_id}</span></Kv>
      <Kv k="Amount">{cash(l.amount)}</Kv>
      <Kv k="From">{fromId ? calc.fundName(fromId) : l.party}</Kv>
      <Kv k="To">{toId ? calc.fundName(toId) : l.party}</Kv>
      <Kv k="Date">{date(l.date)}</Kv>
      <Kv k="Reason">{reason || '—'}</Kv>
      <div className="full muted">A transfer is never changed or undone. To reverse it, transfer the money back the other way.</div>
      {canPay && !readOnly && fromId && toId ? (
        <div className="full"><button className="btn" onClick={() => { ui.close(); ui.open(<TransferModal from={toId} to={fromId} />); }}>Transfer Back</button></div>
      ) : null}
    </Modal>
  );
}
