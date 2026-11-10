'use client';
import { useState } from 'react';
import { Page } from '@/components/shell';
import { rpc, useData } from '@/components/data';
import { Amount, Area, DateIn, Err, Foot, FundSelect, num, orNull, Select, Txt } from '@/components/forms';
import { Badge, Card, Check, Kv, Lines, Modal, Pills, Seg, Table, useUI, type Col, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { date, money, sd, sum } from '@/lib/format';
import { DONOR_TYPES, type Donor } from '@/lib/types';

const TONE: Record<string, Tone> = { Individual: 'gry', 'Family Foundation': 'vio', 'Corporate Sponsor': 'blu', Grantmaker: 'grn' };
const GIVING = ['One-Time', 'Monthly', 'Annual', 'Grant', 'In-Kind'];
const CHANNELS = ['Zeffy', 'Check', 'Grant'] as const;

type Row = Donor & { total: number; gifts: number; last: string | null; unthanked: number; funds: string };

export default function DonorsPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const [filt, setFilt] = useState('All');
  const all: Row[] = db.donors.map((d) => {
    const t = calc.donorTotals(d.id);
    const funds = Array.from(new Set(t.rows.map((x) => calc.fundName(x.fund_id))));
    return { ...d, total: t.total, gifts: t.count, last: t.last, unthanked: t.unthanked, funds: funds.join(', ') };
  });
  const monthly = all.filter((d) => d.giving === 'Monthly');
  const monthlyRate = sum(monthly, (d) => calc.donorTotals(d.id).rows[0]?.amount || 0);
  const P: [string, Tone, (d: Row) => boolean][] = [
    ['All', 'gry', () => true], ['Monthly', 'grn', (d) => d.giving === 'Monthly'], ['Family Foundation', 'vio', (d) => d.type === 'Family Foundation'],
    ['Corporate Sponsor', 'blu', (d) => d.type === 'Corporate Sponsor'], ['Grantmaker', 'grn', (d) => d.type === 'Grantmaker'],
    ['Anonymous', 'gry', (d) => d.anonymous], ['Thank-You Due', 'amb', (d) => d.unthanked > 0],
  ];
  const fn = (P.find((p) => p[0] === filt) || P[0])[2];
  const cols: Col<Row>[] = [
    { k: 'name', label: 'Donor', html: (d) => <>{d.name}{d.anonymous ? <> <Badge>Anonymous</Badge></> : null}</> },
    { k: 'type', label: 'Type', html: (d) => <Badge tone={TONE[d.type]}>{d.type}</Badge> },
    { k: 'giving', label: 'Giving' },
    { k: 'gifts', label: 'Gifts', num: true, html: (d) => String(d.gifts) },
    { k: 'total', label: 'This Year', num: true, html: (d) => money(d.total) },
    { k: 'last', label: 'Last Gift', html: (d) => sd(d.last) },
    { k: 'funds', label: 'Restricted To' },
    { k: 'public', label: 'Public Listing', sv: (d) => (d.public && !d.anonymous ? 1 : 0), html: (d) => (d.public && !d.anonymous ? <Badge tone="grn">Yes</Badge> : <Badge>No</Badge>) },
    { k: 'unthanked', label: 'Thanked', html: (d) => (d.unthanked ? <Badge tone="amb">{d.unthanked + ' Due'}</Badge> : <Badge tone="grn">Yes</Badge>) },
  ];
  return (
    <Page title="Donors" help="donors" actions={<button className="btn pri" onClick={() => ui.open(<LogDonation />)}>Log Donation</button>}>
      <div className="cards">
        <Card n="Donors" v={String(all.length)} tip={all.filter((d) => d.anonymous).length + ' asked to stay anonymous · ' + all.filter((d) => d.public && !d.anonymous).length + ' listed publicly'} />
        <Card n="Monthly Giving" v={money(monthlyRate) + '/mo'} tip={monthly.length + ' monthly donors'} />
        <Card n="Gifts This Year" v={money(sum(all, (d) => d.total))} tip={sum(all, (d) => d.gifts) + ' gifts since ' + date(calc.fyStart)} />
        <Card n="Thank-You Due" v={String(sum(all, (d) => d.unthanked))} color="amb" tip={<Lines lines={all.filter((d) => d.unthanked).map((d) => d.name)} none="All thanked." />} />
      </div>
      <div className="panel">
        <Pills items={P.map(([k, tone, f]) => ({ key: k, label: k, tone, count: all.filter(f).length }))} active={filt} onPick={setFilt} />
        <Table cols={cols} rows={all.filter(fn)} sort="total" dir={-1} onRow={(d) => ui.open(<DonorForm id={d.id} />)} />
      </div>
    </Page>
  );
}

function DonorForm({ id }: { id: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const d = calc.donor(id);
  const [f, setF] = useState(() => ({ name: d?.name || '', type: d?.type || 'Individual', giving: d?.giving || 'One-Time', channel: d?.channel || 'Zeffy', since: d?.since || '', anonymous: !!d?.anonymous, public: !!d?.public, grant_id: d?.grant_id || '', notes: d?.notes || '' }));
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  if (!d) return <Modal title="Donor"><div className="full empty">This donor was archived.</div></Modal>;
  const t = calc.donorTotals(id);

  const save = async () => {
    if (!f.name.trim()) { setErr('Name the donor.'); return; }
    const ok = await run(() => supabase().from('donors').update({
      name: f.name.trim(), type: f.type, giving: f.giving, channel: f.channel, since: f.since || null, anonymous: f.anonymous, public: f.public, grant_id: f.grant_id || null, notes: orNull(f.notes),
    }).eq('id', id), 'Donor saved');
    if (ok !== false) ui.close();
  };
  const thankAll = () => run(() => rpc('gift_set_thanked', { p_ids: t.rows.filter((x) => !x.thanked).map((x) => x.id), p_thanked: true }), 'Marked thanked');
  const toggleThanked = (gid: string, v: boolean) => run(() => rpc('gift_set_thanked', { p_ids: [gid], p_thanked: v }));
  // A gift is never deleted: its money is reversed in the ledger and the gift is archived.
  const delGift = async (gid: string) => {
    const g = db.donations.find((x) => x.id === gid);
    if (!g) return;
    const why = await ui.ask({ title: 'Remove Gift', body: <>Take the {money(g.amount)} gift on {date(g.date)} off this donor? Its money is reversed in the ledger; both entries stay in the books.</>, ok: 'Remove Gift', danger: true });
    if (!why) return;
    await run(() => rpc('gift_archive', { p_id: gid, p_reason: why }), 'Gift removed · totals updated');
  };
  const del = async () => {
    const n = t.rows.length;
    if (n) { setErr(`${d.name} has ${n} gifts (${money(sum(t.rows, (x) => x.amount))}). Remove those first; the donor is then archived.`); return; }
    const why = await ui.ask({ title: 'Archive Donor', body: <>Archive {d.name}?</>, ok: 'Archive', danger: true });
    if (!why) return;
    const ok = await run(() => rpc('archive_record', { p_table: 'donors', p_id: id, p_reason: why }), 'Donor archived');
    if (ok !== false) ui.close();
  };

  return (
    <Modal wide title={d.name} foot={<Foot onDelete={del} onSave={save} extra={t.unthanked ? <button className="btn" onClick={thankAll}>Mark All Thanked</button> : null} />}>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} /></Kv>
      <Kv k="Type"><Seg value={f.type} options={[...DONOR_TYPES]} onChange={(v) => set({ type: v })} /></Kv>
      <Kv k="Giving"><Select value={f.giving} onChange={(v) => set({ giving: v })} options={Array.from(new Set([...GIVING, f.giving])).map((g) => [g, g])} /></Kv>
      <Kv k="Method"><Select value={f.channel} onChange={(v) => set({ channel: v })} options={Array.from(new Set([...CHANNELS, f.channel])).map((g) => [g, g])} /></Kv>
      <Kv k="Donor Since"><DateIn value={f.since} onChange={(v) => set({ since: v })} /></Kv>
      <Kv k="This Year">{money(t.total) + ' in ' + t.count + ' gifts'}</Kv>
      <Kv k="Anonymous"><Check checked={f.anonymous} onChange={(v) => set({ anonymous: v })}>Hide name everywhere outside the board</Check></Kv>
      <Kv k="Public Listing"><Check checked={f.public} onChange={(v) => set({ public: v })}>Donor agreed to be named on the public site</Check></Kv>
      {f.type === 'Grantmaker' ? <Kv k="Grant"><Select value={f.grant_id} onChange={(v) => set({ grant_id: v })} blank="None" options={db.grants.map((g) => [g.id, g.funder + ' · ' + g.program])} /></Kv> : null}
      <Kv k="Notes"><Area value={f.notes} onChange={(v) => set({ notes: v })} /></Kv>
      <div className="full scroll">
        <table className="subtable">
          <thead><tr><th className="nosort">Date</th><th className="nosort">Fund</th><th className="nosort num">Amount</th><th className="nosort">Method</th><th className="nosort">Thanked</th><th className="nosort" /></tr></thead>
          <tbody>
            {t.rows.length ? t.rows.map((x) => (
              <tr key={x.id}>
                <td>{date(x.date)}</td><td>{calc.fundName(x.fund_id)}</td><td className="num">{money(x.amount)}</td><td>{x.channel}{x.recurring ? ' · monthly' : ''}</td>
                <td><Check checked={x.thanked} onChange={(v) => toggleThanked(x.id, v)}>{x.thanked ? 'Yes' : 'Due'}</Check></td>
                <td><button className="btn sm" onClick={() => delGift(x.id)}>Delete</button></td>
              </tr>
            )) : <tr><td colSpan={6} className="empty">No gifts yet.</td></tr>}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>To change a gift&apos;s amount, date or fund, open its entry on the Ledger.</div>
      </div>
      <Err msg={err} />
    </Modal>
  );
}

function LogDonation() {
  const { db, calc, run } = useData();
  const ui = useUI();
  const [f, setF] = useState({ donor_id: '', name: '', type: 'Individual' as Donor['type'], amount: '', date: calc.today, fund_id: db.funds.find((x) => !x.restricted)?.id || db.funds[0]?.id || '', channel: 'Zeffy' as (typeof CHANNELS)[number], recurring: false, anonymous: false, public: false, memo: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    const a = num(f.amount);
    if (!(a > 0)) { setErr('Enter an amount.'); return; }
    if (!f.donor_id && !f.name.trim()) { setErr('Pick a donor or type a new name.'); return; }
    if (!f.fund_id) { setErr('Pick a fund.'); return; }
    setBusy(true);
    const ok = await run(() => supabase().rpc('log_donation', {
      p_donor_id: f.donor_id || null, p_name: f.name.trim(), p_type: f.type, p_amount: a, p_date: f.date || calc.today, p_fund_id: f.fund_id,
      p_channel: f.channel, p_recurring: f.recurring, p_anonymous: f.anonymous, p_public: f.public, p_memo: orNull(f.memo),
    }), 'Donation logged · totals updated');
    setBusy(false);
    if (ok !== false) ui.close();
  };
  return (
    <Modal title="Log Donation" foot={<Foot onSave={save} busy={busy} saveLabel="Save And Queue Thank-You" />}>
      <Kv k="Donor"><Select value={f.donor_id} onChange={(v) => set({ donor_id: v })} blank="New donor…" options={db.donors.slice().sort((a, b) => a.name.localeCompare(b.name)).map((d) => [d.id, d.name])} /></Kv>
      {!f.donor_id ? <>
        <Kv k="New Donor Name"><Txt value={f.name} onChange={(v) => set({ name: v })} placeholder="Name or organisation" /></Kv>
        <Kv k="Type"><Seg value={f.type} options={[...DONOR_TYPES]} onChange={(v) => set({ type: v })} /></Kv>
      </> : null}
      <Kv k="Amount"><Amount value={f.amount} onChange={(v) => set({ amount: v })} /></Kv>
      <Kv k="Date"><DateIn value={f.date} onChange={(v) => set({ date: v })} /></Kv>
      <Kv k="Restricted To"><FundSelect value={f.fund_id} onChange={(v) => set({ fund_id: v })} /></Kv>
      <Kv k="Method"><Seg value={f.channel} options={[...CHANNELS]} onChange={(v) => set({ channel: v })} /></Kv>
      <Kv k="Monthly"><Check checked={f.recurring} onChange={(v) => set({ recurring: v })}>Zeffy monthly gift</Check></Kv>
      {!f.donor_id ? <Kv k="Privacy"><Check checked={f.anonymous} onChange={(v) => set({ anonymous: v })}>Anonymous</Check><Check checked={f.public} onChange={(v) => set({ public: v })}>Name may appear publicly</Check></Kv> : null}
      <Kv k="Description"><Txt value={f.memo} onChange={(v) => set({ memo: v })} placeholder="Optional, shows in the ledger" /></Kv>
      <Err msg={err} />
    </Modal>
  );
}
