'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Page } from '@/components/shell';
import { removeFiles, uploadFile, useData } from '@/components/data';
import { Amount, Area, DateIn, Err, FilePick, Foot, FundSelect, num, orNull, Select, str, Txt } from '@/components/forms';
import { Badge, Card, Check, Kv, Lines, Modal, Pills, Seg, Table, useUI, Warnings, type Col, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { date, money, sum } from '@/lib/format';
import type { Ledger } from '@/lib/types';

const CATEGORIES = ['Space', 'Equipment', 'Administration', 'Robotics Teams'] as const;
const IN_SOURCES = ['Fundraising', 'Interest', 'Refund', 'Other', 'Opening Balance'] as const;

export default function LedgerPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const [filt, setFilt] = useState('All');
  const c = calc.cash(), src = calc.inBySource(), out = calc.outByCategory();
  const fundName = (id: string) => calc.fundName(id);
  const party = (l: Ledger) => (l.donor_id ? calc.donor(l.donor_id)?.name || l.party || '' : l.party || '');

  const fundRows = c.funds.map((x) => ({ id: x.fund.id, name: x.fund.name, restricted: x.fund.restricted, opening: x.opening, inn: x.inn, out: x.out, balance: x.balance, purpose: x.fund.purpose }));
  type FR = (typeof fundRows)[number];
  const fundCols: Col<FR>[] = [
    { k: 'name', label: 'Fund' },
    { k: 'restricted', label: 'Type', html: (r) => (r.restricted ? <Badge tone="amb">Restricted</Badge> : <Badge>Unrestricted</Badge>) },
    { k: 'opening', label: 'Opening Balance', num: true, html: (r) => money(r.opening) },
    { k: 'inn', label: 'In', num: true, html: (r) => money(r.inn) },
    { k: 'out', label: 'Out', num: true, html: (r) => money(r.out) },
    { k: 'balance', label: 'Balance', num: true, html: (r) => money(r.balance) },
    { k: 'purpose', label: 'Purpose' },
    { k: 'edit', label: '', nosort: true, html: (r) => <button className="btn sm" onClick={() => ui.open(<FundForm id={r.id} />)}>Edit</button> },
  ];

  const L = db.ledger;
  const restricted = (l: Ledger) => !!calc.fund(l.fund_id)?.restricted;
  const P: [string, Tone, (l: Ledger) => boolean][] = [
    ['All', 'gry', () => true], ['Money In', 'grn', (l) => l.dir === 'in' && l.source !== 'Opening Balance'], ['Money Out', 'red', (l) => l.dir === 'out'],
    ['Restricted', 'amb', restricted], ['Unrestricted', 'gry', (l) => !restricted(l)], ['Missing Receipt', 'amb', (l) => l.dir === 'out' && !l.receipt],
  ];
  const pills = P.map(([k, tone, f]) => ({ key: k, label: k, tone, count: L.filter(f).length }));
  if (filt.startsWith('F:')) pills.push({ key: filt, label: fundName(filt.slice(2)), tone: 'blu', count: L.filter((l) => l.fund_id === filt.slice(2)).length });
  const fn = filt.startsWith('F:') ? (l: Ledger) => l.fund_id === filt.slice(2) : (P.find((p) => p[0] === filt) || P[0])[2];

  const cols: Col<Ledger>[] = [
    { k: 'date', label: 'Date', html: (l) => date(l.date) },
    { k: 'memo', label: 'Description' },
    { k: 'party', label: 'From / To', sv: party, html: party },
    { k: 'fund_id', label: 'Fund', sv: (l) => fundName(l.fund_id), html: (l) => fundName(l.fund_id) },
    { k: 'kind', label: 'Source / Category', sv: (l) => l.source || l.category, html: (l) => l.source || l.category },
    { k: 'in', label: 'In', num: true, sv: (l) => (l.dir === 'in' ? l.amount : 0), html: (l) => (l.dir === 'in' ? <span style={{ color: 'var(--g)' }}>{money(l.amount, true)}</span> : '') },
    { k: 'out', label: 'Out', num: true, sv: (l) => (l.dir === 'out' ? l.amount : 0), html: (l) => (l.dir === 'out' ? money(l.amount, true) : '') },
    { k: 'receipt', label: 'Receipt', html: (l) => (l.dir === 'out' ? (l.receipt ? <Badge tone="grn">On File</Badge> : <Badge tone="amb">Missing</Badge>) : '') },
  ];

  return (
    <Page title="Ledger" help="ledger" actions={<>
      <button className="btn" onClick={() => ui.open(<EntryForm dir="in" />)}>Record Money In</button>
      <button className="btn pri" onClick={() => ui.open(<EntryForm dir="out" />)}>Add Expense</button>
    </>}>
      <div className="cards">
        <Card n="Cash On Hand" v={money(c.total)} tip="Sum of every fund below." />
        <Card n="Restricted" v={money(c.restricted)} tip={<Lines lines={c.funds.filter((f) => f.fund.restricted).map((f) => f.fund.name)} />} />
        <Card n="Unrestricted" v={money(c.unrestricted)} tip={<Lines lines={c.funds.filter((f) => !f.fund.restricted).map((f) => f.fund.name)} />} />
        <Card n="Money In" v={money(calc.raised())} color="g" tip={<Lines lines={Object.keys(src).map((k) => k + ': ' + money(src[k]))} />} />
        <Card n="Money Out" v={money(calc.spent())} color="red" tip={<><Lines lines={Object.keys(out).map((k) => k + ': ' + money(out[k]))} /><div>Team money returned is netted from Robotics Teams.</div></>} />
      </div>
      <div className="panel">
        <div className="ph"><h2>Funds</h2><span className="sp" /><button className="btn sm" onClick={() => ui.open(<FundForm />)}>Add Fund</button></div>
        <Table cols={fundCols} rows={fundRows} sort="balance" dir={-1}
          onRow={(r) => { setFilt('F:' + r.id); document.getElementById('tx')?.scrollIntoView({ block: 'start' }); }}
          foot={<tr><td>Total</td><td /><td className="num">{money(sum(fundRows, (r) => r.opening))}</td><td className="num">{money(sum(fundRows, (r) => r.inn))}</td><td className="num">{money(sum(fundRows, (r) => r.out))}</td><td className="num">{money(c.total)}</td><td /><td /></tr>} />
      </div>
      <div className="panel" id="tx">
        <div className="ph"><h2>Transactions</h2></div>
        <Pills items={pills} active={filt} onPick={setFilt} />
        <Table cols={cols} rows={L.filter(fn)} sort="date" dir={-1} onRow={(l) => ui.open(<EntryForm id={l.id} dir={l.dir} />)} />
      </div>
    </Page>
  );
}

/** Add or edit one ledger row. Money out warns when it overspends a fund or misuses restricted money; it never blocks. */
function EntryForm({ id, dir }: { id?: string; dir: 'in' | 'out' }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const old = id ? db.ledger.find((l) => l.id === id) : undefined;
  const [f, setF] = useState(() => ({
    date: old?.date || calc.today, amount: str(old?.amount), fund_id: old?.fund_id || (dir === 'in' ? db.funds.find((x) => !x.restricted)?.id : '') || '',
    party: old?.party || '', memo: old?.memo || '', category: old?.category || 'Administration', source: old?.source || 'Fundraising',
    receipt: old ? old.receipt : true,
  }));
  const [file, setFile] = useState<File | null>(null);
  const [dropFile, setDropFile] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  if (id && !old) return <Modal title="Transaction"><div className="full empty">This entry was deleted.</div></Modal>;

  const fundId = f.fund_id || db.funds[0]?.id || '';
  const amt = num(f.amount);
  const donor = old?.donor_id ? calc.donor(old.donor_id) : null;
  const req = old?.request_id ? calc.request(old.request_id) : null;
  const linkedGift = !!old?.donation_id;
  const warnings = dir === 'out' ? calc.spendWarnings(fundId, amt, f.category, id) : [];

  const save = async () => {
    if (!(amt > 0)) { setErr('Enter an amount more than zero.'); return; }
    if (!fundId) { setErr('Pick a fund.'); return; }
    if (dir === 'out' && !f.party.trim()) { setErr('Say who was paid.'); return; }
    setBusy(true); setErr(null);
    let receipt_path = dropFile ? null : old?.receipt_path || null, receipt_name = dropFile ? null : old?.receipt_name || null;
    if (file) {
      const up = await uploadFile('ledger', file);
      if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
      receipt_path = up.path; receipt_name = up.name;
    }
    const row: Partial<Ledger> = {
      date: f.date || calc.today, amount: amt, fund_id: fundId, memo: orNull(f.memo) || orNull(f.party) || (dir === 'in' ? f.source : f.category),
      ...(linkedGift ? {} : { party: orNull(f.party) }),
      ...(dir === 'out' ? { category: f.category, receipt: f.receipt || !!receipt_path, receipt_path, receipt_name } : linkedGift || req ? {} : { source: f.source }),
    };
    const ok = await run(() => (old ? supabase().from('ledger').update(row).eq('id', old.id) : supabase().from('ledger').insert({ ...row, dir })),
      old ? 'Saved · totals updated' : dir === 'in' ? 'Money in recorded · totals updated' : 'Expense saved · totals updated');
    setBusy(false);
    if (ok === false) return;
    if (old?.receipt_path && old.receipt_path !== receipt_path) await removeFiles([old.receipt_path]);
    ui.close();
  };
  const del = async () => {
    if (!old) return;
    const yes = await ui.confirm({
      title: 'Delete This Entry',
      body: <>Delete {money(old.amount, true)} {old.dir === 'in' ? 'into' : 'out of'} {calc.fundName(old.fund_id)} on {date(old.date)}?{linkedGift ? ' The gift it records is deleted from the donor too.' : ''}{req ? ' The team request it paid keeps its status; change that on Team Requests if needed.' : ''}</>,
      ok: 'Delete', danger: true,
    });
    if (!yes) return;
    const ok = await run(() => supabase().from('ledger').delete().eq('id', old.id), 'Entry deleted · totals updated');
    if (ok !== false) { await removeFiles([old.receipt_path]); ui.close(); }
  };

  const title = old ? (old.memo || 'Transaction') : dir === 'in' ? 'Record Money In' : 'Add Expense';
  return (
    <Modal title={title} foot={<Foot onDelete={old ? del : undefined} onSave={save} busy={busy} />}>
      {old ? <Kv k="Direction">{old.dir === 'in' ? <Badge tone="grn">Money In</Badge> : <Badge tone="red">Money Out</Badge>}</Kv> : null}
      {dir === 'in' && !old ? <div className="full muted">For a gift from a donor, use Donors, Log Donation, so the donor is credited and thanked.</div> : null}
      {linkedGift ? <Kv k="Donor">{donor?.name || old?.party} · <Link className="doclink" href="/donors">Donors</Link><div className="muted" style={{ fontSize: 12 }}>This entry is a gift. Changing the amount, date or fund here changes the gift too.</div></Kv> : null}
      {req ? <Kv k="Team Request">{req.id} · {req.purpose} · <Link className="doclink" href="/requests">Team Requests</Link></Kv> : null}
      {!linkedGift ? <Kv k={dir === 'in' ? 'From' : 'Paid To'}><Txt value={f.party} onChange={(v) => set({ party: v })} placeholder={dir === 'in' ? 'Who it came from' : 'Vendor'} /></Kv> : null}
      <Kv k="Description"><Txt value={f.memo} onChange={(v) => set({ memo: v })} /></Kv>
      <Kv k="Amount"><Amount value={f.amount} onChange={(v) => set({ amount: v })} /></Kv>
      <Kv k="Date"><DateIn value={f.date} onChange={(v) => set({ date: v })} /></Kv>
      <Kv k="Fund"><FundSelect value={fundId} onChange={(v) => set({ fund_id: v })} balances /></Kv>
      {dir === 'out' ? <Kv k="Category"><Seg value={f.category as (typeof CATEGORIES)[number]} options={[...CATEGORIES]} onChange={(v) => set({ category: v })} /></Kv> : null}
      {dir === 'in' && !linkedGift && !req ? (
        <Kv k="Source">
          {old && !(IN_SOURCES as readonly string[]).includes(f.source)
            ? <Select value={f.source} onChange={(v) => set({ source: v })} options={[[f.source, f.source], ...IN_SOURCES.map((s) => [s, s] as [string, string])]} />
            : <Seg value={f.source as (typeof IN_SOURCES)[number]} options={[...IN_SOURCES]} onChange={(v) => set({ source: v })} />}
        </Kv>
      ) : null}
      {dir === 'in' && (linkedGift || req) ? <Kv k="Source">{old?.source}</Kv> : null}
      {dir === 'out' ? (
        <>
          <Kv k="Receipt"><Check checked={f.receipt} onChange={(v) => set({ receipt: v })}>Receipt on file</Check></Kv>
          <Kv k="Receipt File">
            <FilePick file={file} onFile={setFile} path={dropFile ? null : old?.receipt_path} name={old?.receipt_name}
              onRemove={() => setDropFile(true)} accept="image/*,application/pdf" />
          </Kv>
        </>
      ) : null}
      <Warnings list={warnings} />
      <Err msg={err} />
    </Modal>
  );
}

function FundForm({ id }: { id?: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const old = id ? calc.fund(id) : null;
  const [f, setF] = useState({ name: old?.name || '', restricted: old ? old.restricted : true, team_id: old?.team_id || '', purpose: old?.purpose || '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const used = old ? db.ledger.filter((l) => l.fund_id === old.id).length : 0;

  const save = async () => {
    if (!f.name.trim()) { setErr('Name the fund.'); return; }
    const row = { name: f.name.trim(), restricted: f.restricted, team_id: f.team_id || null, purpose: orNull(f.purpose) };
    const ok = await run(() => (old ? supabase().from('funds').update(row).eq('id', old.id) : supabase().from('funds').insert(row)), old ? 'Fund saved' : 'Fund added');
    if (ok !== false) ui.close();
  };
  const del = async () => {
    if (!old) return;
    if (used) { setErr(`${used} ledger entries use this fund. Move or delete them first.`); return; }
    if (!(await ui.confirm({ title: 'Delete Fund', body: <>Delete {old.name}?</>, ok: 'Delete', danger: true }))) return;
    const ok = await run(() => supabase().from('funds').delete().eq('id', old.id), 'Fund deleted');
    if (ok !== false) ui.close();
  };
  return (
    <Modal title={old ? old.name : 'Add Fund'} foot={<Foot onDelete={old ? del : undefined} onSave={save} />}>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} autoFocus /></Kv>
      <Kv k="Restricted"><Check checked={f.restricted} onChange={(v) => set({ restricted: v })}>Money given for a set purpose</Check></Kv>
      <Kv k="Team"><Select value={f.team_id} onChange={(v) => set({ team_id: v })} blank="Not a team fund" options={db.teams.map((t) => [t.id, t.name])} /></Kv>
      <Kv k="Purpose"><Area value={f.purpose} onChange={(v) => set({ purpose: v })} placeholder="What this money may be spent on" /></Kv>
      {old ? <Kv k="Balance">{money(calc.fundBalance(old.id))} · {used} entries</Kv> : null}
      <Err msg={err} />
    </Modal>
  );
}

