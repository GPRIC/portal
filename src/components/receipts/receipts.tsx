'use client';
// Receipts (P33, mockup #100): the list (Missing / This Month / All, filters, sort, pager) and the receipt modal (the file
// beside its request). Used by the board's Documents > Receipts tab and the Team Portal's Receipts page; each side passes
// its own rows and actions, so nothing here reads either side's data directly.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openFile } from '@/components/data';
import { Amount, Err, Txt, num } from '@/components/forms';
import { Badge, Modal, St, useUI, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { BUCKET } from '@/lib/supabase/env';
import { date, initials, money, round2, sd, sum } from '@/lib/format';
import { fileKind, firstName, type RcRow, type RcType } from '@/lib/receipts';
import '@/app/(board)/requests/requests.css';
import './receipts.css';

type Main = 'Missing' | 'This Month' | 'All';
const MAIN: [Main, Tone, string][] = [
  ['Missing', 'amb', 'Paid requests and expenses with no receipt file yet'],
  ['This Month', 'grn', 'Receipts dated this month'],
  ['All', 'grn', 'Every receipt, and everything still missing one'],
];
const TYPES: RcType[] = ['Pre-Approval', 'Reimbursement', 'Direct Expense'];
const TYPE_TONE: Record<RcType, Tone> = { 'Pre-Approval': 'gry', Reimbursement: 'blu', 'Direct Expense': 'vio' };
type SortK = 'date' | 'vendor' | 'amount' | 'where' | 'who';

export function TypeTag({ t }: { t: RcType }) {
  return <Badge tone={TYPE_TONE[t]}>{t}</Badge>;
}

/** "N receipts on file, $X; M paid items missing a receipt" (the title tip). */
export function receiptSummary(rows: RcRow[]) {
  const on = rows.filter((r) => !r.missing && r.file_path);
  const miss = rows.filter((r) => r.missing);
  return on.length + (on.length === 1 ? ' receipt' : ' receipts') + ' on file, ' + money(sum(on, (r) => r.amount), true) + '. '
    + (miss.length ? miss.length + (miss.length === 1 ? ' paid item is' : ' paid items are') + ' missing a receipt.' : 'Nothing is missing a receipt.');
}

/** The receipts list. `coach` hides the Team Or Fund filter (a coach sees only their own team). */
export function ReceiptsList({ rows, q, coach, today, onOpen }: {
  rows: RcRow[]; q: string; coach?: boolean; today: string; onOpen: (r: RcRow) => void;
}) {
  const [main, setMain] = useState<Main>('Missing');
  const [where, setWhere] = useState<string[]>([]);
  const [types, setTypes] = useState<RcType[]>([]);
  const [month, setMonth] = useState('');
  const [menu, setMenu] = useState(false);
  const [page, setPage] = useState(0);
  const [per, setPer] = useState(25);
  const [sort, setSort] = useState<{ k: SortK; asc: boolean }>({ k: 'date', asc: false });

  const thisMonth = today.slice(0, 7);
  const ql = q.trim().toLowerCase();
  const hay = (r: RcRow) => [r.vendor, r.req.id, '#' + r.req.id, r.req.purpose, r.who, r.req.requestor_name, r.rc?.uploaded_by, r.req.where]
    .filter(Boolean).join(' ').toLowerCase();
  const inMain = (r: RcRow) => (main === 'Missing' ? r.missing : main === 'This Month' ? r.date.slice(0, 7) === thisMonth : true);
  const shownRows = rows.filter((r) => inMain(r)
    && (!where.length || where.includes(r.req.whereKey))
    && (!types.length || types.includes(r.req.type))
    && (main === 'This Month' || !month || r.date.slice(0, 7) === month)
    && (!ql || hay(r).includes(ql)));
  const key = (r: RcRow): string | number => (sort.k === 'amount' ? r.amount : sort.k === 'date' ? r.date
    : (sort.k === 'vendor' ? r.vendor : sort.k === 'where' ? r.req.where : r.who).toLowerCase());
  shownRows.sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : a.id.localeCompare(b.id)) * (sort.asc ? 1 : -1); });
  const pages = Math.max(1, Math.ceil(shownRows.length / per));
  const pg = Math.min(page, pages - 1);
  const shown = shownRows.slice(pg * per, pg * per + per);
  const filtered = !!where.length || !!types.length || !!month;
  const clear = () => { setWhere([]); setTypes([]); setMonth(''); setMain('All'); setPage(0); setMenu(false); };
  const miss = main === 'Missing';
  const noun = miss ? 'missing receipts' : 'receipts';

  const places = [...new Map(rows.map((r) => [r.req.whereKey, r.req.where])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)).filter(Boolean))].sort().reverse();
  const counts: Record<Main, number> = { Missing: rows.filter((r) => r.missing).length, 'This Month': rows.filter((r) => r.date.slice(0, 7) === thisMonth).length, All: rows.length };

  const cols: [SortK, string, boolean?][] = [['date', miss ? 'Date Paid' : 'Date'], ['vendor', 'Vendor'], ['amount', 'Amount', true], ['where', 'Team Or Fund'], ['who', miss ? 'Requested By' : 'Uploaded By']];
  const cell = (r: RcRow, k: SortK): ReactNode => {
    switch (k) {
      case 'date': return <span title={'Request #' + r.req.id + ', ' + date(r.date)}>{sd(r.date)}</span>;
      case 'vendor': return <span className="rq-pr" title={r.req.purpose}><span className="t">{r.vendor}</span></span>;
      case 'amount': return money(r.amount, true);
      case 'where': return r.req.where;
      default: return r.who
        ? <span className="who-line"><span className={'av ' + (r.missing ? 'amb' : 'grn')}>{initials(r.who)}</span>{r.who}{!miss && r.missing ? <Badge tone="amb">Missing</Badge> : null}</span>
        : (r.missing ? <Badge tone="amb">Missing</Badge> : null);
    }
  };

  return (
    <div className="panel rq-panel">
      <div className="rq-frow">
        {MAIN.map(([m, t, tip]) => (
          <button key={m} type="button" className={'rq-fp' + (main === m ? ' on ' + t : '')} title={tip} onClick={() => { setMain(m); setPage(0); }}>
            {m} <span className="muted">{counts[m]}</span>
          </button>
        ))}
        <span className="sp" />
        <FilterMenu open={menu} setOpen={setMenu} active={filtered}>
          {!coach && places.length > 1 ? <>
            <span className="rq-lab">Team Or Fund</span>
            <div className="rc-pop-list">{places.map(([k, l]) => (
              <label key={k}><input type="checkbox" checked={where.includes(k)} onChange={(e) => { setWhere((w) => (e.target.checked ? [...w, k] : w.filter((x) => x !== k))); setPage(0); }} />{l}</label>
            ))}</div>
          </> : null}
          <span className="rq-lab">Type</span>
          <div className="rc-pop-list">{TYPES.map((t) => (
            <label key={t}><input type="checkbox" checked={types.includes(t)} onChange={(e) => { setTypes((w) => (e.target.checked ? [...w, t] : w.filter((x) => x !== t))); setPage(0); }} />{t}</label>
          ))}</div>
          <span className="rq-lab">Month{main === 'This Month' ? ' (This Month is on)' : ''}</span>
          <div className={'rc-pop-list' + (main === 'This Month' ? ' dim' : '')}>
            <label><input type="radio" name="rcmonth" checked={!month} onChange={() => { setMonth(''); setPage(0); }} />Any Month</label>
            {months.map((m) => (
              <label key={m}><input type="radio" name="rcmonth" checked={month === m} onChange={() => { setMonth(m); setPage(0); }} />{monthLabel(m)}</label>
            ))}
          </div>
          {filtered ? <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={() => { setWhere([]); setTypes([]); setMonth(''); setPage(0); }}>Clear</button> : null}
        </FilterMenu>
      </div>
      <div className="scroll">
        <table>
          <thead><tr>{cols.map(([k, l, n]) => (
            <th key={k} className={(n ? 'num ' : '') + (sort.k === k ? 'sort' : '')} onClick={() => { setSort((s) => (s.k === k ? { k, asc: !s.asc } : { k, asc: !(k === 'date' || k === 'amount') })); setPage(0); }}>
              {l}{sort.k === k ? <span className="ar">{sort.asc ? '▲' : '▼'}</span> : null}
            </th>
          ))}</tr></thead>
          <tbody>
            {shown.length ? shown.map((r) => (
              <tr key={r.id} className="rowlink" onClick={() => onOpen(r)}>
                {cols.map(([k, , n]) => <td key={k} className={n ? 'num' : undefined}>{cell(r, k)}</td>)}
              </tr>
            )) : (
              <tr><td colSpan={cols.length} className="rq-empty">
                {miss && !filtered && !ql
                  ? <><b>Every paid item has its receipt</b>Nothing is waiting on a receipt.</>
                  : <><b>No receipts match</b>Try All, or clear the filters.<div style={{ marginTop: 12 }}><button className="btn sm" onClick={clear}>Clear Filters</button></div></>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="rq-pager">
        <span className="muted">{shownRows.length ? `${pg * per + 1}–${Math.min(shownRows.length, pg * per + per)} of ${shownRows.length} ${noun}` : '0 ' + noun}</span>
        <span className="sp" />
        <span className="muted">Rows</span>
        <div className="seg">{[25, 50, 100].map((n) => <button key={n} type="button" className={'opt' + (per === n ? ' on' : '')} onClick={() => { setPer(n); setPage(0); }}>{n}</button>)}</div>
        <button className="btn sm" disabled={!pg} onClick={() => setPage(pg - 1)}>Previous</button>
        <span className="muted">Page {pg + 1} of {pages}</span>
        <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
      </div>
    </div>
  );
}

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ym: string) => MON[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);

function FilterMenu({ open, setOpen, active, children }: { open: boolean; setOpen: (v: boolean) => void; active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', k);
    return () => document.removeEventListener('mousedown', k);
  }, [open, setOpen]);
  return (
    <span className="rq-fwrap" ref={ref}>
      <button type="button" className={'rq-fp' + (open ? ' on gry' : '')} onClick={() => setOpen(!open)}>Filters{active ? <i className="rq-fdot" title="A filter is active" /> : null}</button>
      {open ? <div className="rq-pop">{children}</div> : null}
    </span>
  );
}

/* ---------- the receipt modal ---------- */

/** A short-lived link to a stored file, for the preview (null while loading or when it cannot be read). */
function useSigned(path: string | null) {
  const [got, setGot] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    supabase().storage.from(BUCKET).createSignedUrl(path, 300).then(({ data }) => { if (live) setGot({ path, url: data?.signedUrl || null }); });
    return () => { live = false; };
  }, [path]);
  return !path ? { url: null, done: true } : got && got.path === path ? { url: got.url, done: true } : { url: null, done: false };
}

export type ReceiptActions = {
  /** Why the viewer cannot upload this one (null when they can). */
  uploadBlock: string | null;
  /** True when saving creates a new receipt (vendor and amount asked for); false when it attaches a file to one on file. */
  newReceipt: boolean;
  save: (file: File, vendor: string, amount: number) => Promise<string | null>;
  /** The board flags the requester in the portal; absent for a team. */
  remind?: () => Promise<void>;
  reminded?: { at: string; by: string | null; note?: string | null } | null;
  openRequest?: () => void;
  /** False when the viewer cannot read this file (a team, for a file the board uploaded outside the team's folder). */
  canOpen?: boolean;
  /** Extra read-only lines under the request (cancel, refund). */
  extra?: ReactNode;
};

export function ReceiptView({ start, rows, actions }: { start: RcRow; rows: RcRow[]; actions: (r: RcRow) => ReceiptActions }) {
  const ui = useUI();
  const [id, setId] = useState(start.id);
  const row = rows.find((x) => x.id === id) || rows.find((x) => x.req.id === start.req.id) || start;
  const a = actions(row);
  const r = row.req;
  const sib = rows.filter((x) => x.req.id === r.id);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [vendor, setVendor] = useState(r.vendor || '');
  const [amount, setAmount] = useState(row.missing && !row.rc ? String(row.amount) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sig = useSigned(row.missing || a.canOpen === false ? null : row.file_path);
  const kind = fileKind(row.file_name || row.file_path);
  const pick = (x: RcRow) => { setId(x.id); setFile(null); setErr(null); setVendor(x.req.vendor || ''); setAmount(x.missing && !x.rc ? String(x.amount) : ''); };
  const who = firstName(r.requestor_name) || 'Requester';

  const save = async () => {
    if (!file) return;
    const amt = num(amount);
    if (a.newReceipt && !(amt > 0)) { setErr('Enter the receipt amount.'); return; }
    setBusy(true); setErr(null);
    const e = await a.save(file, vendor.trim(), a.newReceipt ? amt : row.amount);
    setBusy(false);
    if (e) { setErr(e); return; }
    setFile(null);
  };
  const remind = async () => { if (!a.remind) return; setBusy(true); await a.remind(); setBusy(false); };

  const left = row.missing ? (
    <div className="rc-pv">
      <div className="rc-pv-h"><Badge tone="amb">Missing</Badge><span className="muted">Paid {sd(r.paid_date || row.date)}</span>
        {a.reminded ? <span className="rc-rem" title={a.reminded.note || undefined}>· Reminded {sd(a.reminded.at.slice(0, 10))}{a.reminded.by ? ' by ' + a.reminded.by : ''}</span> : null}
      </div>
      {a.uploadBlock ? (
        <div className="rc-drop"><b>No receipt uploaded</b><span>{a.uploadBlock}</span></div>
      ) : (
        <label className={'rc-drop' + (over ? ' over' : '')}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}>
          <b>{file ? file.name : 'No receipt uploaded'}</b>
          <span>{file ? fileKind(file.name) + ' · ' + Math.max(1, Math.round(file.size / 1024)) + ' KB' : 'Drop a photo or PDF here'}</span>
          <span className="btn sm" style={{ marginTop: 6 }}>{file ? 'Choose Another' : 'Choose File'}</span>
          <input type="file" hidden accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
      )}
      {!a.uploadBlock && a.newReceipt ? (
        <div className="rc-fields">
          <span className="k">Vendor</span><Txt value={vendor} onChange={setVendor} placeholder="Vendor" />
          <span className="k">Amount</span><Amount value={amount} onChange={setAmount} />
        </div>
      ) : null}
    </div>
  ) : (
    <div className="rc-pv">
      <div className="rc-pv-h"><Badge tone="gry">{kind}</Badge><span className="muted">{row.rc?.uploaded_by || row.who ? 'Uploaded by ' + (row.rc?.uploaded_by || row.who) : 'On the request'}</span></div>
      <div className="rc-pv-body">
        {!row.file_path ? <span className="muted">No file</span>
          : a.canOpen === false ? <span className="muted" style={{ padding: 16, textAlign: 'center' }}>{row.file_name || 'Receipt'}<br />Filed by the board. Ask the board for a copy.</span>
          : !sig.done ? <span className="muted">Loading…</span>
          : !sig.url ? <span className="muted" style={{ padding: 16, textAlign: 'center' }}>{row.file_name || 'Receipt'}<br />Preview not available here.</span>
          : kind === 'PDF' ? <iframe src={sig.url} title={row.file_name || 'Receipt'} />
          : kind === 'FILE' ? <span className="muted">{row.file_name || 'Receipt'}</span>
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={sig.url} alt={row.file_name || 'Receipt'} />}
      </div>
    </div>
  );

  const foot = row.missing ? <>
    <button className="btn" onClick={ui.close}>Cancel</button>
    <span className="btnrow">
      {a.remind ? <button className="btn" onClick={remind} disabled={busy} title="Flags it in the portal. No email is sent.">{a.reminded ? 'Remind ' + who + ' Again' : 'Remind ' + who}</button> : null}
      {a.uploadBlock ? null : file ? <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        : <span className="dis" title="Choose the file first"><button className="btn pri" disabled>Save</button></span>}
    </span>
  </> : <>
    <button className="btn" onClick={ui.close}>Cancel</button>
    <span className="btnrow">
      {row.file_path && a.canOpen !== false ? <button className="btn" onClick={() => openFile(row.file_path!)}>Download</button> : null}
      {a.openRequest ? <button className="btn pri" onClick={a.openRequest}>Open Request #{r.id}</button> : null}
    </span>
  </>;

  return (
    <Modal wide view title={row.missing ? 'Missing Receipt · ' + row.vendor : 'Receipt · ' + row.vendor} foot={foot}>
      <div className="full rc-split">
        {left}
        <div className="rc-kv">
          <div className="k">Request</div><div className="rq-fl"><b>#{r.id}</b><TypeTag t={r.type} /></div>
          <div className="k">Purpose</div><div>{r.purpose || '—'}</div>
          <div className="k">Team Or Fund</div><div>{r.where || '—'}</div>
          <div className="k">Requested By</div><div>{r.requestor_name || '—'}<span className="muted"> · {sd(r.submitted)}</span></div>
          <div className="k">Status</div><div><St s={r.status} /></div>
          <div className="k">Payment</div><div>{r.paid_date || r.type === 'Direct Expense' ? [r.pay_method, r.pay_ref].filter(Boolean).join(' ') + ' · ' + sd(r.paid_date || r.purchase_date || r.submitted) : <span className="muted">Not paid yet</span>}</div>
          <div className="k">Request Total</div><div className="rq-tot">{money(r.amount, true)}</div>
          {a.extra}
          <div className="full rq-lab" style={{ marginTop: 6 }}>Invoices On This Request ({sib.length})</div>
          <div className="full scroll">
            <table className="rq-inv rc-inv">
              <thead><tr><th>Vendor</th><th>Date</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>{sib.map((x) => (
                <tr key={x.id} className={x.id === row.id ? 'cur' : 'pick'} onClick={x.id === row.id ? undefined : () => pick(x)}>
                  <td>{x.vendor}</td><td>{sd(x.date)}</td><td className="num">{money(x.amount, true)}</td>
                  <td>{x.id === row.id ? <Badge tone="grn">Showing</Badge> : x.missing ? <Badge tone="amb">Missing</Badge> : null}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={2}>Total</td><td className="num">{money(round2(sum(sib, (x) => x.amount)), true)}</td><td /></tr></tfoot>
            </table>
          </div>
          <Err msg={err} />
        </div>
      </div>
    </Modal>
  );
}
