'use client';
import { useState } from 'react';
import { Page } from '@/components/shell';
import { ListExport } from '@/components/export';
import { rpc, useData } from '@/components/data';
import { Amount, Area, DateIn, Err, Foot, num, orNull, str, Txt } from '@/components/forms';
import { Badge, Card, Kv, Lines, Modal, Pills, Seg, Table, useUI, type Col, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { date, daysBetween, money, round2, sd, sum } from '@/lib/format';
import type { Account } from '@/lib/types';

const ROLES = ['President', 'Treasurer', 'Secretary'];
const monthly = (a: Account) => (a.period === 'Month' ? a.cost : a.period === 'Year' ? a.cost / 12 : 0);

export default function AccountsPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const [filt, setFilt] = useState('All');
  const T = calc.today;
  const soon = (a: Account) => !!a.renewal && a.renewal >= T && daysBetween(T, a.renewal) <= 30;
  const all = db.accounts;
  const m = sum(all, monthly);
  const P: [string, Tone, (a: Account) => boolean][] = [
    ['All', 'gry', () => true], ['Paid', 'blu', (a) => a.cost > 0], ['Free', 'grn', (a) => !a.cost], ['Renewing Soon', 'amb', soon],
    ['One Admin', 'amb', (a) => a.admins.length < 2], ['Nonprofit Discount', 'vio', (a) => !!a.discount && a.discount !== 'None'],
  ];
  const cols: Col<Account>[] = [
    { k: 'service', label: 'Service' },
    { k: 'purpose', label: 'Used For' },
    { k: 'owner_email', label: 'Owner Email' },
    { k: 'admins', label: 'Admins', sv: (a) => a.admins.length, xv: (a) => a.admins, html: (a) => (a.admins.length < 2 ? <Badge tone="amb">{(a.admins[0] || 'No') + ' Only'}</Badge> : a.admins.join(', ')) },
    { k: 'plan', label: 'Plan' },
    { k: 'cost', label: 'Cost', num: true, sv: monthly, xv: (a) => (a.cost ? a.cost + '/' + (a.period === 'Month' ? 'mo' : 'yr') : 'Free'), html: (a) => (a.cost ? money(a.cost) + '/' + (a.period === 'Month' ? 'mo' : 'yr') : 'Free') },
    { k: 'renewal', label: 'Renews', sv: (a) => a.renewal || '9999', xv: (a) => a.renewal, html: (a) => (a.renewal ? (soon(a) ? <Badge tone="amb">{sd(a.renewal)}</Badge> : date(a.renewal)) : '') },
    { k: 'payment_method', label: 'Paid With' },
    { k: 'discount', label: 'Nonprofit Discount' },
  ];
  const shown = all.filter((P.find((p) => p[0] === filt) || P[0])[2]);
  return (
    <Page title="Accounts And Subscriptions" help="accounts" tools={<ListExport name="Accounts" cols={cols} rows={shown} />} actions={<button className="btn pri" onClick={() => ui.open(<AccountForm />)}>Add Account</button>}>
      <div className="cards">
        <Card n="Accounts" v={String(all.length)} tip={all.filter((a) => a.cost).length + ' paid · ' + all.filter((a) => !a.cost).length + ' free'} />
        <Card n="Monthly Cost" v={money(round2(m), true)} tip={'Yearly ' + money(round2(m * 12), true) + '. Yearly plans spread over 12 months.'} />
        <Card n="Renewing In 30 Days" v={String(all.filter(soon).length)} color={all.filter(soon).length ? 'amb' : undefined} tip={<Lines lines={all.filter(soon).map((a) => a.service + ': ' + sd(a.renewal))} />} />
        <Card n="One Admin Only" v={String(all.filter((a) => a.admins.length < 2).length)} color="amb" tip={<Lines lines={all.filter((a) => a.admins.length < 2).map((a) => a.service + ': ' + (a.admins.join('') || 'no admin'))} />} />
      </div>
      <div className="panel">
        <Pills items={P.map(([k, tone, f]) => ({ key: k, label: k, tone, count: all.filter(f).length }))} active={filt} onPick={setFilt} />
        <Table cols={cols} rows={shown} sort="renewal" onRow={(a) => ui.open(<AccountForm id={a.id} />)} />
      </div>
    </Page>
  );
}

function AccountForm({ id }: { id?: string }) {
  const { db, run } = useData();
  const ui = useUI();
  const old = id ? db.accounts.find((a) => a.id === id) : null;
  const [f, setF] = useState(() => ({
    service: old?.service || '', purpose: old?.purpose || '', owner_email: old?.owner_email || 'admin@gpric.net', admins: old?.admins || ['Treasurer'],
    plan: old?.plan || '', cost: str(old?.cost ?? 0), period: old?.period || 'Month', renewal: old?.renewal || '', payment_method: old?.payment_method || 'GPRIC debit card',
    discount: old?.discount || 'None', status: old?.status || 'Active', notes: old?.notes || '',
  }));
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  if (id && !old) return <Modal title="Account"><div className="full empty">This account was archived.</div></Modal>;
  const save = async () => {
    if (!f.service.trim()) { setErr('Name the service.'); return; }
    const cost = f.cost ? num(f.cost) : 0;
    if (Number.isNaN(cost)) { setErr('Cost must be a number.'); return; }
    const row = {
      service: f.service.trim(), purpose: orNull(f.purpose), owner_email: orNull(f.owner_email), admins: f.admins.length ? f.admins : ['Treasurer'], plan: orNull(f.plan),
      cost, period: f.period, renewal: f.renewal || null, payment_method: orNull(f.payment_method), discount: orNull(f.discount), status: f.status, notes: orNull(f.notes),
    };
    const ok = await run(() => (old ? supabase().from('accounts').update(row).eq('id', old.id) : supabase().from('accounts').insert(row)), old ? 'Saved' : 'Account added');
    if (ok !== false) ui.close();
  };
  const del = async () => {
    if (!old) return;
    const why = await ui.ask({ title: 'Archive Account', body: <>Take {old.service} off the register? This does not close the account itself.</>, ok: 'Archive', danger: true });
    if (!why) return;
    const ok = await run(() => rpc('archive_record', { p_table: 'accounts', p_id: old.id, p_reason: why }), 'Account archived');
    if (ok !== false) ui.close();
  };
  const toggle = (r: string, v: boolean) => set({ admins: v ? ROLES.filter((x) => x === r || f.admins.includes(x)).concat(f.admins.filter((x) => !ROLES.includes(x))) : f.admins.filter((x) => x !== r) });
  return (
    <Modal title={old ? old.service : 'Add Account'} foot={<Foot onDelete={old ? del : undefined} onSave={save} />}>
      <Kv k="Service"><Txt value={f.service} onChange={(v) => set({ service: v })} /></Kv>
      <Kv k="Used For"><Txt value={f.purpose} onChange={(v) => set({ purpose: v })} /></Kv>
      <Kv k="Owner Email"><Txt value={f.owner_email} onChange={(v) => set({ owner_email: v })} /></Kv>
      <Kv k="Admins">{ROLES.map((r) => <label key={r} className="check adminchk"><input type="checkbox" checked={f.admins.includes(r)} onChange={(e) => toggle(r, e.target.checked)} /> {r}</label>)}</Kv>
      <Kv k="Plan"><Txt value={f.plan} onChange={(v) => set({ plan: v })} /></Kv>
      <Kv k="Cost"><Amount value={f.cost} onChange={(v) => set({ cost: v })} /></Kv>
      <Kv k="Billed"><Seg value={f.period} options={['Month', 'Year', 'None']} onChange={(v) => set({ period: v })} /></Kv>
      <Kv k="Renews"><DateIn value={f.renewal} onChange={(v) => set({ renewal: v })} /></Kv>
      <Kv k="Paid With"><Txt value={f.payment_method} onChange={(v) => set({ payment_method: v })} /></Kv>
      <Kv k="Nonprofit Discount"><Txt value={f.discount} onChange={(v) => set({ discount: v })} /></Kv>
      <Kv k="Notes"><Area value={f.notes} onChange={(v) => set({ notes: v })} /></Kv>
      <div className="full muted">Passwords stay in Bitwarden. Never type one here.</div>
      <Err msg={err} />
    </Modal>
  );
}
