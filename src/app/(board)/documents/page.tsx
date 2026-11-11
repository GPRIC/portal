'use client';
import { Suspense, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Page } from '@/components/shell';
import { ListExport } from '@/components/export';
import { BoardReceipts, boardReceiptRows } from '@/components/receipts/board-receipts';
import { receiptSummary } from '@/components/receipts/receipts';
import { rpc, uploadFile, useData } from '@/components/data';
import { Area, DateIn, DocOpen, Err, FilePick, Foot, orNull, Select, Txt } from '@/components/forms';
import { Badge, Check, Kv, Modal, Pills, Seg, Table, useUI, type Col, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { date } from '@/lib/format';
import { DOC_TYPES, type Doc } from '@/lib/types';
import type { Calc } from '@/lib/calc';

const TONE: Record<string, Tone> = { Formation: 'gry', IRS: 'amb', State: 'amb', Policy: 'grn', Contract: 'gry', Grant: 'blu', Board: 'vio', Finance: 'gry' };

function linked(calc: Calc, id: string | null) {
  if (!id) return '';
  return calc.grant(id)?.program || calc.meeting(id)?.title || calc.fund(id)?.name || calc.team(id)?.name || id;
}

export default function DocumentsPage() {
  return <Suspense fallback={<div className="loading">Loading…</div>}><Documents /></Suspense>;
}

/** Two tabs: Documents, and Receipts (every receipt on file and every paid item missing one). ?tab=receipts opens Receipts. */
function Documents() {
  const { calc } = useData();
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const tab = sp.get('tab') === 'receipts' ? 'Receipts' : 'Documents';
  const go = (t: string) => router.replace(t === 'Receipts' ? path + '?tab=receipts' : path, { scroll: false });
  const [q, setQ] = useState('');
  const rcRows = useMemo(() => boardReceiptRows(calc), [calc]);
  const tabs = (
    <div className="rc-tabs" role="tablist">
      {['Documents', 'Receipts'].map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={'rc-tab' + (tab === t ? ' on' : '')} onClick={() => go(t)}
          title={t === 'Receipts' ? receiptSummary(rcRows) : "GPRIC's paperwork"}>{t}{t === 'Receipts' && rcRows.some((r) => r.missing) ? <span className="muted"> · {rcRows.filter((r) => r.missing).length} missing</span> : null}</button>
      ))}
    </div>
  );
  if (tab === 'Receipts') {
    return (
      <Page title="Documents" help="documents" tools={<input className="in rq-srch" placeholder="Search vendor, request, person" value={q} onChange={(e) => setQ(e.target.value)} />}>
        {tabs}
        <BoardReceipts q={q} />
      </Page>
    );
  }
  return <DocumentsTab tabs={tabs} />;
}

function DocumentsTab({ tabs }: { tabs: ReactNode }) {
  const { db, calc } = useData();
  const ui = useUI();
  const [filt, setFilt] = useState('All');
  const all = db.documents;
  const items = [{ key: 'All', label: 'All', count: all.length }, { key: 'Public', label: 'Public', tone: 'grn' as Tone, count: all.filter((d) => d.public).length },
    ...DOC_TYPES.map((t) => ({ key: t, label: t, tone: TONE[t], count: all.filter((d) => d.type === t).length }))];
  const cols: Col<Doc>[] = [
    { k: 'title', label: 'Document', xv: (d) => d.title, html: (d) => <DocOpen doc={d} /> },
    { k: 'type', label: 'Type', html: (d) => <Badge tone={TONE[d.type]}>{d.type}</Badge> },
    { k: 'linked_to', label: 'Linked To', sv: (d) => linked(calc, d.linked_to), html: (d) => linked(calc, d.linked_to) },
    { k: 'date', label: 'Date', html: (d) => date(d.date) },
    { k: 'public', label: 'Public', sv: (d) => (d.public ? 1 : 0), xv: (d) => (d.public ? 'Public' : 'Board'), html: (d) => (d.public ? <Badge tone="grn">Public</Badge> : <Badge tone="vio">Board</Badge>) },
    { k: 'added_by', label: 'Added By' },
  ];
  const shown = all.filter((d) => filt === 'All' || (filt === 'Public' ? d.public : d.type === filt));
  return (
    <Page title="Documents" help="documents" tools={<ListExport name="Documents" cols={cols} rows={shown} />} actions={<button className="btn pri" onClick={() => ui.open(<DocForm />)}>Add Document</button>}>
      {tabs}
      <div className="panel">
        <Pills items={items} active={filt} onPick={setFilt} />
        <Table cols={cols} rows={shown} sort="date" dir={-1} onRow={(d) => ui.open(<DocForm id={d.id} />)} />
      </div>
    </Page>
  );
}

function DocForm({ id }: { id?: string }) {
  const { db, calc, run, me } = useData();
  const ui = useUI();
  const old = id ? db.documents.find((d) => d.id === id) : null;
  const [f, setF] = useState(() => ({ title: old?.title || '', type: old?.type || 'Board', date: old?.date || calc.today, linked_to: old?.linked_to || '', public: !!old?.public, link: old?.link || '', notes: old?.notes || '' }));
  const [file, setFile] = useState<File | null>(null);
  const [drop, setDrop] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  if (id && !old) return <Modal title="Document"><div className="full empty">This document was deleted.</div></Modal>;
  const links: [string, string][] = [
    ...db.grants.map((g) => [g.id, 'Grant · ' + g.funder + ', ' + g.program] as [string, string]),
    ...db.meetings.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((m) => [m.id, 'Meeting · ' + m.title] as [string, string]),
    ...db.funds.map((x) => [x.id, 'Fund · ' + x.name] as [string, string]),
    ...db.teams.map((t) => [t.id, 'Team · ' + t.name] as [string, string]),
  ];

  const save = async () => {
    const hasFile = !!file || (!!old?.file_path && !drop);
    if (!f.title.trim() && !file) { setErr('Give the document a title.'); return; }
    if (!hasFile && !f.link.trim()) { setErr('Upload a file or paste a link.'); return; }
    setBusy(true); setErr(null);
    let file_path = drop ? null : old?.file_path || null, file_name = drop ? null : old?.file_name || null;
    if (file) {
      const up = await uploadFile('documents/' + f.type.toLowerCase(), file);
      if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
      file_path = up.path; file_name = up.name;
    }
    const row = { title: f.title.trim() || (file_name || 'Document'), type: f.type, date: f.date || null, linked_to: f.linked_to || null, public: f.public, link: orNull(f.link), file_path, file_name, notes: orNull(f.notes) };
    const ok = await run(() => (old ? supabase().from('documents').update(row).eq('id', old.id) : supabase().from('documents').insert({ ...row, added_by: me })), old ? 'Saved' : 'Document added');
    setBusy(false);
    if (ok === false) return;
    ui.close();
  };
  const del = async () => {
    if (!old) return;
    const why = await ui.ask({ title: 'Archive Document', body: <>Take {old.title} off the register? The file is kept.</>, ok: 'Archive', danger: true });
    if (!why) return;
    const ok = await run(() => rpc('archive_record', { p_table: 'documents', p_id: old.id, p_reason: why }), 'Document archived');
    if (ok !== false) ui.close();
  };
  return (
    <Modal wide title={old ? old.title : 'Add Document'} foot={<Foot onDelete={old ? del : undefined} onSave={save} busy={busy} extra={old && (old.file_path || old.link) ? <DocOpen doc={old} label="Open Document" /> : null} />}>
      <Kv k="Title"><Txt value={f.title} onChange={(v) => set({ title: v })} placeholder="Leave empty to use the file name" /></Kv>
      <Kv k="Type"><Seg value={f.type} options={[...DOC_TYPES]} onChange={(v) => set({ type: v })} /></Kv>
      <Kv k="Date"><DateIn value={f.date} onChange={(v) => set({ date: v })} /></Kv>
      <Kv k="Linked To"><Select value={f.linked_to} onChange={(v) => set({ linked_to: v })} blank="Nothing" options={links} /></Kv>
      <Kv k="File"><FilePick file={file} onFile={setFile} path={drop ? null : old?.file_path} name={old?.file_name} onRemove={() => setDrop(true)} /></Kv>
      <Kv k="Link"><Txt value={f.link} onChange={(v) => set({ link: v })} placeholder="Or paste a link (Google Drive, IRS site, etc.)" /></Kv>
      <Kv k="On Public Site"><Check checked={f.public} onChange={(v) => set({ public: v })}>Show on the transparency page</Check></Kv>
      <Kv k="Notes"><Area value={f.notes} onChange={(v) => set({ notes: v })} /></Kv>
      {old?.added_by ? <Kv k="Added By">{old.added_by}</Kv> : null}
      <Err msg={err} />
    </Modal>
  );
}
