'use client';
import { useState } from 'react';
import { Page } from '@/components/shell';
import { ListExport } from '@/components/export';
import { rpc, uploadFile, useData } from '@/components/data';
import { Amount, Area, DateIn, DocOpen, Err, Foot, FundSelect, num, orNull, str, Txt } from '@/components/forms';
import { Badge, Card, Check, Kv, Lines, Modal, Pills, Seg, St, ST, Table, useUI, type Col } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { Calc } from '@/lib/calc';
import { date, daysBetween, money, sd } from '@/lib/format';
import { GRANT_STATUSES, type Grant } from '@/lib/types';

const APPLIED_AS = ['GPRIC', 'AAUW (Fiscal Sponsor)', 'Partner School'] as const;
const OWNERS = ['President', 'Treasurer', 'Secretary', 'Coach'] as const;

export default function GrantsPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const [filt, setFilt] = useState('All');
  const g = calc.grants(), all = db.grants, T = calc.today;
  const open = (x: Grant) => Calc.OPEN_GRANT.includes(x.status);
  const next = all.filter((x) => x.deadline && x.deadline >= T && open(x)).sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1))[0];
  const cols: Col<Grant>[] = [
    { k: 'funder', label: 'Funder' },
    { k: 'program', label: 'Program' },
    { k: 'ask', label: 'Ask', num: true, html: (r) => money(r.ask) },
    { k: 'awarded', label: 'Awarded', num: true, html: (r) => (r.awarded ? money(r.awarded) : '') },
    { k: 'status', label: 'Status', html: (r) => <><St s={r.status} />{r.status === 'Awarded' && r.received < r.awarded ? <> <Badge tone="amb">Not Received</Badge></> : null}</> },
    { k: 'deadline', label: 'Deadline', sv: (r) => r.deadline || '9999', xv: (r) => r.deadline || 'Rolling', html: (r) => {
      const late = r.deadline && r.deadline >= T && daysBetween(T, r.deadline) <= 10 && open(r);
      return r.deadline ? (late ? <Badge tone="red">{date(r.deadline)}</Badge> : date(r.deadline)) : 'Rolling';
    } },
    { k: 'applied_as', label: 'Applied As' },
    { k: 'owner', label: 'Owner' },
    { k: 'board_saw', label: 'Board Saw', html: (r) => (r.board_saw ? <Badge tone="grn">{sd(r.board_saw)}</Badge> : <Badge tone="amb">Not Yet</Badge>) },
  ];
  const shown = all.filter((x) => filt === 'All' || x.status === filt);
  return (
    <Page title="Grants Pipeline" help="grants" tools={<ListExport name="Grants" cols={cols} rows={shown} />} actions={<button className="btn pri" onClick={() => ui.open(<GrantForm />)}>New Grant</button>}>
      <div className="cards">
        <Card n="In The Pipeline" v={money(g.openAsk)} tip={g.open.length + ' open asks · weighted ' + money(g.weighted)} />
        <Card n="Awarded" v={money(g.awardedTotal)} tip={'Received ' + money(g.receivedTotal) + ' · still to arrive ' + money(g.pending)} />
        <Card n="Still To Arrive" v={money(g.pending)} color={g.pending ? 'amb' : undefined} tip={<Lines lines={g.awarded.filter((x) => x.received < x.awarded).map((x) => x.funder + ' via ' + (x.applied_as || 'GPRIC'))} none="Nothing pending." />} />
        <Card n="Next Deadline" v={next ? sd(next.deadline) : '—'} color={next && daysBetween(T, next.deadline!) <= 10 ? 'red' : undefined} tip={next ? next.program + ' · ' + money(next.ask) : undefined} />
      </div>
      <div className="panel">
        <Pills items={[{ key: 'All', label: 'All', count: all.length }, ...GRANT_STATUSES.map((s) => ({ key: s, label: s, tone: ST[s] || ('red' as const), count: all.filter((x) => x.status === s).length }))]} active={filt} onPick={setFilt} />
        <Table cols={cols} rows={shown} sort="deadline" onRow={(r) => ui.open(<GrantForm id={r.id} />)} />
      </div>
    </Page>
  );
}

function GrantForm({ id }: { id?: string }) {
  const { db, calc, run, me } = useData();
  const ui = useUI();
  const old = id ? calc.grant(id) : null;
  const [f, setF] = useState(() => ({
    funder: old?.funder || '', program: old?.program || '', purpose: old?.purpose || '', ask: str(old?.ask), awarded: str(old?.awarded || null),
    status: old?.status || 'Prospect', deadline: old?.deadline || '', applied_as: old?.applied_as || 'GPRIC', owner: old?.owner || 'President',
    board_saw: old?.board_saw || '', fund_id: old?.fund_id || '', likelihood: String(Math.round((old?.likelihood ?? 0.3) * 100)), public: !!old?.public, notes: old?.notes || '',
  }));
  const left = old ? Math.max(0, old.awarded - old.received) : 0;
  const [pay, setPay] = useState(left ? String(left) : '');
  const [payDate, setPayDate] = useState(calc.today);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  if (id && !old) return <Modal title="Grant"><div className="full empty">This grant was deleted.</div></Modal>;
  const files = old ? calc.grantFiles(old) : [];

  const save = async () => {
    const ask = num(f.ask);
    if (!f.funder.trim() || !(ask > 0)) { setErr('Funder and ask are needed.'); return; }
    const aw = f.awarded ? num(f.awarded) : 0;
    if (Number.isNaN(aw)) { setErr('Awarded must be a number.'); return; }
    const lk = Math.min(100, Math.max(0, parseInt(f.likelihood, 10) || 0)) / 100;
    const row = {
      funder: f.funder.trim(), program: f.program.trim() || 'General', purpose: orNull(f.purpose) || f.program.trim() || 'General', ask, awarded: aw,
      status: f.status, deadline: f.deadline || null, applied_as: f.applied_as, owner: f.owner, board_saw: f.board_saw || null, fund_id: f.fund_id || null,
      likelihood: lk, public: f.public, notes: orNull(f.notes),
    };
    setBusy(true);
    const ok = await run(() => (old ? supabase().from('grants').update(row).eq('id', old.id) : supabase().from('grants').insert(row)), old ? 'Grant saved' : 'Grant added');
    setBusy(false);
    if (ok !== false) ui.close();
  };
  const recordPayment = async () => {
    if (!old) return;
    const a = num(pay);
    if (!(a > 0)) { setErr('Enter the amount received.'); return; }
    if (!old.fund_id) { setErr('Pick a fund for this grant and save first.'); return; }
    const ok = await run(() => supabase().rpc('grant_received', { p_grant_id: old.id, p_amount: a, p_date: payDate || calc.today }), 'Payment recorded in the ledger');
    if (ok !== false) ui.close();
  };
  const addFile = async () => {
    if (!old || !file) return;
    setBusy(true);
    const up = await uploadFile('grants/' + old.id, file);
    if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
    const ok = await run(() => supabase().from('documents').insert({ title: up.name, type: 'Grant', date: calc.today, linked_to: old.id, public: false, file_path: up.path, file_name: up.name, added_by: me }), 'File added');
    setBusy(false);
    if (ok !== false) setFile(null);
  };
  const del = async () => {
    if (!old) return;
    const money_in = db.ledger.filter((l) => l.grant_id === old.id && !l.reverses_id && !l.reversed_by_id).length;
    if (money_in) { setErr(`${money_in} ledger entries record money from this grant. Reverse them on the Ledger first.`); return; }
    const why = await ui.ask({ title: 'Archive Grant', body: <>Archive {old.funder}, {old.program}?{files.length ? ` Its ${files.length} files stay on Documents.` : ''}</>, ok: 'Archive', danger: true });
    if (!why) return;
    const ok = await run(() => rpc('archive_record', { p_table: 'grants', p_id: old.id, p_reason: why }), 'Grant archived');
    if (ok !== false) ui.close();
  };

  return (
    <Modal wide title={old ? old.program : 'New Grant'} foot={<Foot onDelete={old ? del : undefined} onSave={save} busy={busy} />}>
      <Kv k="Funder"><Txt value={f.funder} onChange={(v) => set({ funder: v })} placeholder="Foundation or agency" /></Kv>
      <Kv k="Program"><Txt value={f.program} onChange={(v) => set({ program: v })} /></Kv>
      <Kv k="Purpose"><Txt value={f.purpose} onChange={(v) => set({ purpose: v })} /></Kv>
      <Kv k="Ask"><Amount value={f.ask} onChange={(v) => set({ ask: v })} placeholder="0" /></Kv>
      <Kv k="Status"><Seg value={f.status} options={[...GRANT_STATUSES]} onChange={(v) => set({ status: v })} /></Kv>
      {f.status === 'Awarded' || old?.awarded ? <Kv k="Awarded"><Amount value={f.awarded} onChange={(v) => set({ awarded: v })} placeholder="0" />{old ? <div className="muted" style={{ fontSize: 12 }}>Received so far {money(old.received)}</div> : null}</Kv> : null}
      <Kv k="Deadline"><DateIn value={f.deadline} onChange={(v) => set({ deadline: v })} /><div className="muted" style={{ fontSize: 12 }}>Leave empty for rolling.</div></Kv>
      <Kv k="Applied As"><Seg value={f.applied_as as (typeof APPLIED_AS)[number]} options={[...APPLIED_AS]} onChange={(v) => set({ applied_as: v })} /></Kv>
      <Kv k="Owner"><Seg value={f.owner as (typeof OWNERS)[number]} options={[...OWNERS]} onChange={(v) => set({ owner: v })} /></Kv>
      <Kv k="Fund"><FundSelect value={f.fund_id} onChange={(v) => set({ fund_id: v })} blank="Pick a fund" /></Kv>
      <Kv k="Board Saw"><DateIn value={f.board_saw} onChange={(v) => set({ board_saw: v })} /></Kv>
      <Kv k="Likelihood"><input className="in" type="number" min="0" max="100" step="5" value={f.likelihood} onChange={(e) => set({ likelihood: e.target.value })} style={{ maxWidth: 100 }} /> %</Kv>
      <Kv k="Public"><Check checked={f.public} onChange={(v) => set({ public: v })}>Funder may be named on the public site</Check></Kv>
      <Kv k="Notes"><Area value={f.notes} onChange={(v) => set({ notes: v })} /></Kv>
      {old ? (
        <Kv k="Files">
          {files.map((d) => <div key={d.id}><DocOpen doc={d} /></div>)}
          <span className="btnrow"><input className="in" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />{file ? <button className="btn sm" onClick={addFile} disabled={busy}>Upload</button> : null}</span>
        </Kv>
      ) : null}
      {old && old.status === 'Awarded' && left > 0 ? (
        <Kv k="Payment Received">
          <span className="btnrow"><Amount value={pay} onChange={setPay} /><DateIn value={payDate} onChange={setPayDate} /><button className="btn" onClick={recordPayment}>Record Payment</button></span>
          <div className="muted" style={{ fontSize: 12 }}>Goes into {calc.fundName(old.fund_id) || 'the grant fund'} as money in from {old.funder}.</div>
        </Kv>
      ) : null}
      <Err msg={err} />
    </Modal>
  );
}
