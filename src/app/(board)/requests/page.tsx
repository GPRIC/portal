'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Page } from '@/components/shell';
import { rpc, uploadFile, useData } from '@/components/data';
import { Amount, Area, DateIn, Err, FileLink, Foot, FundSelect, num, orNull, Select, str, Txt } from '@/components/forms';
import { Badge, Check, Kv, Lines, Modal, Seg, Table, useUI, Warnings, type Col, type Tone } from '@/components/ui';
import { Tip } from '@/components/tips';
import { date, initials, money, round2, sd, sum } from '@/lib/format';
import { DIRECT_PAY, PAY_METHODS, PAY_TO, REQUEST_CATEGORIES, REQUEST_TYPES, type PayMethod, type RequestType, type Team, type TeamRequest } from '@/lib/types';
import type { Calc } from '@/lib/calc';
import './requests.css';

/** How a team's money reaches it (the team record, not a request). */
const TEAM_PAY = ['Team EIN Account', 'School / District'] as const;
const GEAR = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;

const isR = (r: TeamRequest) => r.type === 'Reimbursement';
const isD = (r: TeamRequest) => r.type === 'Direct Expense';
const forText = (r: TeamRequest) => (isR(r) ? [r.vendor, r.category].filter(Boolean).join(' · ') || r.purpose : r.purpose);
const requestor = (r: TeamRequest) => r.requestor_name || r.created_by || '';
const TEAM_TYPES = REQUEST_TYPES.filter((x) => x !== 'Direct Expense');
const TYPE_DOT: Record<RequestType, string> = { 'Direct Expense': 'var(--vio)', Reimbursement: 'var(--t3)', 'Pre-Approval': 'var(--blue)' };
const TYPE_TIP: Record<RequestType, string> = {
  'Direct Expense': 'The board already paid this by debit card or check',
  Reimbursement: 'The team is paid back by Zelle',
  'Pre-Approval': 'Approved before the team spends; receipts follow',
};
const UNPAID = ['Draft', 'Submitted', 'Board Vote', 'Approved'];
const PAIDS = ['Paid', 'Reviewed', 'Closed', 'Receipts Due'];

function TypeDot({ r, label = true }: { r: TeamRequest; label?: boolean }) {
  return <span className="rq-ty" title={TYPE_TIP[r.type]}><i style={{ background: TYPE_DOT[r.type] }} />{label ? r.type : null}</span>;
}
function TypeBadge({ r }: { r: TeamRequest }) {
  return isD(r) ? <Badge tone="vio">Direct Expense</Badge> : isR(r) ? <Badge tone="blu">Reimbursement</Badge> : <Badge tone="gry">Pre-Approval</Badge>;
}

function tone(calc: Calc, r: TeamRequest): Tone {
  if (r.status === 'Receipts Due') return calc.isOverdue(r) ? 'red' : 'amb';
  return ({ Submitted: 'amb', 'Board Vote': 'amb', Approved: 'vio', Paid: 'grn', Closed: 'grn', Reviewed: 'blu', Cancelled: 'gry', Declined: 'red', Draft: 'gry' } as Record<string, Tone>)[r.status] || 'gry';
}
function statusTip(calc: Calc, r: TeamRequest): string {
  const base: Record<string, string> = {
    Draft: 'Not sent yet',
    Submitted: isD(r) ? 'Waiting for the bookkeeper to review' : 'Waiting on the board',
    'Board Vote': 'Waiting on a board vote',
    Approved: isR(r) ? 'Approved, waiting for the Zelle payment' : 'Approved, waiting for payment',
    Paid: 'Paid back by the Treasurer',
    'Receipts Due': calc.isOverdue(r) ? 'Paid; receipts ' + calc.daysLate(r) + ' days overdue' : 'Paid; receipts due ' + sd(calc.receiptsDue(r)),
    Closed: 'Paid and receipts are in',
    Reviewed: 'Checked by the bookkeeper and posted to the fund ledger as already paid',
    Cancelled: 'Withdrawn before payment. Nothing posted to the books.' + (r.cancel_reason ? ' ' + r.cancel_reason : ''),
    Declined: 'Turned down by the board' + (r.decline_reason ? ': ' + r.decline_reason : ''),
  };
  const rf = calc.refundFor(r.id);
  return [base[r.status] || r.status,
    rf ? 'Refund ' + money(rf.amount, true) + ' on ' + sd(rf.date) : '',
    r.replaced_by_id ? 'Replaced by #' + r.replaced_by_id : '',
    r.replaces_id ? 'Replaces #' + r.replaces_id : ''].filter(Boolean).join('. ');
}
function StBadge({ r }: { r: TeamRequest }) {
  const { calc } = useData();
  return <span title={statusTip(calc, r)}><Badge tone={tone(calc, r)}>{r.status === 'Receipts Due' && calc.isOverdue(r) ? 'Receipts Overdue' : r.status}</Badge></span>;
}
function Filer({ r }: { r: TeamRequest }) {
  const n = requestor(r) || '—';
  return <span className="who-line"><span className={'av ' + (r.team_id && r.submitted_by_user ? 'blu' : 'grn')}>{initials(n)}</span>{n}</span>;
}
const netCost = (calc: Calc, r: TeamRequest) => round2(r.amount - (calc.refundFor(r.id)?.amount || 0));

type Main = 'Needs Action' | 'Paid' | 'Cancelled' | 'Declined' | 'All';
const MAIN: [Main, Tone, string][] = [
  ['Needs Action', 'amb', 'Submitted requests waiting on approval or the bookkeeper\'s review, approved requests waiting on payment, and paid pre-approvals still collecting receipts'],
  ['Paid', 'grn', 'Paid back, closed, or reviewed and posted as already paid'],
  ['Cancelled', 'gry', 'Withdrawn before payment'],
  ['Declined', 'red', 'Turned down by the board'],
  ['All', 'gry', 'Every request'],
];
const inMain = (m: Main, r: TeamRequest) => (m === 'All' ? true
  : m === 'Needs Action' ? ['Submitted', 'Board Vote', 'Approved', 'Receipts Due'].includes(r.status)
  : m === 'Paid' ? ['Paid', 'Reviewed', 'Closed'].includes(r.status)
  : r.status === m);
type TypeF = 'All' | RequestType;
type SortK = 'date' | 'purpose' | 'charge' | 'amount' | 'status' | 'filer';
const SORTS: [SortK, string][] = [['date', 'Date'], ['purpose', 'Purpose'], ['charge', 'Charge To'], ['amount', 'Amount'], ['status', 'Status'], ['filer', 'Filed By']];

export default function RequestsPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const [main, setMain] = useState<Main>('Needs Action');
  const [type, setType] = useState<TypeF>('All');
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const [page, setPage] = useState(0);
  const [per, setPer] = useState(25);
  const [sort, setSort] = useState<{ k: SortK; asc: boolean }>({ k: 'date', asc: false });

  // /requests?id=R-1001 opens that request (the Receipts tab links here).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) return;
    history.replaceState(null, '', window.location.pathname);
    ui.open(<RequestView id={id} />);
  }, [ui]);
  const all = db.team_requests.filter((r) => r.status !== 'Draft');
  const ql = q.trim().toLowerCase();
  const hay = (r: TeamRequest) => [r.id, r.purpose, r.vendor, r.category, calc.chargeTo(r), requestor(r), r.status, r.type, ...calc.receiptsFor(r.id).map((x) => x.vendor)].filter(Boolean).join(' ').toLowerCase();
  const rows = all.filter((r) => inMain(main, r) && (type === 'All' || r.type === type) && (!ql || hay(r).includes(ql)));
  const key = (r: TeamRequest): string | number => {
    switch (sort.k) {
      case 'date': return r.submitted || '';
      case 'purpose': return r.purpose.toLowerCase();
      case 'charge': return calc.chargeTo(r).toLowerCase();
      case 'amount': return r.amount;
      case 'status': return r.status;
      default: return requestor(r).toLowerCase();
    }
  };
  rows.sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : a.id.localeCompare(b.id)) * (sort.asc ? 1 : -1); });
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const pg = Math.min(page, pages - 1);
  const shown = rows.slice(pg * per, pg * per + per);
  const any = main !== 'Needs Action' || type !== 'All' || !!ql;
  const clear = () => { setMain('Needs Action'); setType('All'); setQ(''); setPage(0); setMenu(false); };
  const open = (r: TeamRequest) => ui.open(<RequestView id={r.id} />);
  const cell = (r: TeamRequest, k: SortK): ReactNode => {
    const rc = calc.receiptsFor(r.id);
    const vend = [...new Set(rc.map((x) => x.vendor).filter(Boolean))];
    switch (k) {
      case 'date': return <span title={'Request #' + r.id + ', ' + date(r.submitted)}>{sd(r.submitted)}</span>;
      case 'purpose': return <span className="rq-pr" title={[r.purpose, rc.length ? rc.length + (rc.length === 1 ? ' invoice' : ' invoices') : '', vend.join(', ') || r.vendor || ''].filter(Boolean).join(' · ')}><TypeDot r={r} label={false} /><span className="t">{forText(r)}</span></span>;
      case 'charge': return calc.chargeTo(r);
      case 'amount': { const rf = calc.refundFor(r.id); return <span title={rf ? 'Net after refund: ' + money(netCost(calc, r), true) : undefined}>{money(r.amount, true)}</span>; }
      case 'status': return <StBadge r={r} />;
      default: return <Filer r={r} />;
    }
  };

  return (
    <Page title="Requests" help="requests" actions={<>
      <Tip id="requests.rules" side="r" text="Approval Rules: set the dollar threshold and how many board approvals each side of it needs.">
        <button className="ib" title="Approval Rules" aria-label="Approval Rules" onClick={() => ui.open(<RulesForm />)}>{GEAR}</button>
      </Tip>
      <Tip id="requests.teams" side="r" text="Teams now lists each team's logins. Invite a coach or team treasurer from here; they submit requests from their own Team Portal.">
        <button className="btn" onClick={() => ui.open(<TeamsList />)}>Teams</button>
      </Tip>
      <button className="btn" onClick={() => ui.open(<RequestForm />)} title="Enter a team request on a team's behalf">New Request</button>
      {db.canFileDirect
        ? <button className="btn pri" onClick={() => ui.open(<DirectForm />)} title="Log a purchase the board already paid by debit card or check.">New Direct Expense</button>
        : <span className="dis" title="Only the Treasurer, the bookkeeper and officers the Treasurer names can file these."><button className="btn pri" disabled>New Direct Expense</button></span>}
    </>}>
      <div className="panel rq-panel">
        <div className="rq-frow">
          {MAIN.map(([m, t, tip]) => <button key={m} type="button" className={'rq-fp' + (main === m ? ' on ' + t : '')} title={tip} onClick={() => { setMain(m); setPage(0); }}>{m}</button>)}
          <span className="sp" />
          <FilterMenu open={menu} setOpen={setMenu} type={type} setType={(v) => { setType(v); setPage(0); }} />
          <input className="in rq-srch" placeholder="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        </div>
        <div className="scroll">
          <table>
            <thead><tr>{SORTS.map(([k, l]) => (
              <th key={k} className={(k === 'amount' ? 'num ' : '') + (sort.k === k ? 'sort' : '')} onClick={() => { setSort((s) => (s.k === k ? { k, asc: !s.asc } : { k, asc: !(k === 'date' || k === 'amount') })); setPage(0); }}>
                {l}{sort.k === k ? <span className="ar">{sort.asc ? '▲' : '▼'}</span> : null}
              </th>
            ))}</tr></thead>
            <tbody>
              {shown.length ? shown.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => open(r)}>
                  {SORTS.map(([k]) => <td key={k} className={k === 'amount' ? 'num' : undefined}>{cell(r, k)}</td>)}
                </tr>
              )) : (
                <tr><td colSpan={SORTS.length} className="rq-empty"><b>Nothing here</b>No requests match. Try All, or clear the search.
                  {any ? <div style={{ marginTop: 12 }}><button className="btn sm" onClick={clear}>Clear Filters</button></div> : null}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="rq-pager">
          <span className="muted">{rows.length ? `${pg * per + 1}–${Math.min(rows.length, pg * per + per)} of ${rows.length} requests · ${money(sum(rows, (r) => r.amount))}` : '0 requests'}</span>
          <span className="sp" />
          <span className="muted">Rows</span>
          <div className="seg">{[25, 50, 100].map((n) => <button key={n} type="button" className={'opt' + (per === n ? ' on' : '')} onClick={() => { setPer(n); setPage(0); }}>{n}</button>)}</div>
          <button className="btn sm" disabled={!pg} onClick={() => setPage(pg - 1)}>Previous</button>
          <span className="muted">Page {pg + 1} of {pages}</span>
          <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
        </div>
      </div>
    </Page>
  );
}

function FilterMenu({ open, setOpen, type, setType }: { open: boolean; setOpen: (v: boolean) => void; type: TypeF; setType: (v: TypeF) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', k);
    return () => document.removeEventListener('mousedown', k);
  }, [open, setOpen]);
  return (
    <span className="rq-fwrap" ref={ref}>
      <button type="button" className={'rq-fp' + (open ? ' on gry' : '')} onClick={() => setOpen(!open)}>Filters{type !== 'All' ? <i className="rq-fdot" title="A filter is active" /> : null}</button>
      {open ? (
        <div className="rq-pop">
          <span className="rq-lab">Type</span>
          <Seg value={type} options={['All', ...REQUEST_TYPES]} onChange={setType} />
          {type !== 'All' ? <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={() => setType('All')}>Reset Filters</button> : null}
        </div>
      ) : null}
    </span>
  );
}

/* ---------- one request ---------- */
type InvRow = { id: string; vendor: string | null; date: string | null; file_path: string | null; file_name: string | null; amount: number };

function Timeline({ r }: { r: TeamRequest }) {
  const { calc } = useData();
  const got = calc.approvalsFor(r.id);
  const rf = calc.refundFor(r.id);
  const ev: [string, string | null | undefined][] = [['Filed', r.submitted]];
  if (got.length) ev.push(['Approved', got[got.length - 1].approved_at.slice(0, 10)]);
  else if (!isD(r) && ['Approved', 'Paid', 'Receipts Due', 'Closed'].includes(r.status)) ev.push(['Approved', null]);
  if (r.status === 'Declined') ev.push(['Declined', r.declined_at?.slice(0, 10)]);
  if (r.paid_date) ev.push(['Paid', r.paid_date]);
  if (r.reviewed_at) ev.push(['Reviewed', r.reviewed_at.slice(0, 10)]);
  if (r.status === 'Cancelled') ev.push(['Cancelled', r.cancelled_at?.slice(0, 10)]);
  if (rf) ev.push(['Refund', rf.date]);
  return <span className="rq-tl">{ev.map(([l, d], i) => <span key={l} className="rq-fl">{i ? <span className="ar2">›</span> : null}{l}{d ? <span className="st">{sd(d)}</span> : null}</span>)}</span>;
}

function RequestView({ id }: { id: string }) {
  const { calc, run, me, role, canPay, user, isTreasurer } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const [rc, setRc] = useState({ vendor: '', amount: '', date: calc.today });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!r) return <Modal title="Request"><div className="full empty">This request was archived.</div></Modal>;
  const t = calc.team(r.team_id);
  const receipts = calc.receiptsFor(r.id);
  const openReceipts = calc.isOpenReceipts(r);
  const member = calc.requestorMember(r);
  const pay = calc.paymentFor(r.id);
  const rf = calc.refundFor(r.id);
  const fundId = calc.requestFundId(r);
  const late = r.team_id ? calc.teamBlocked(r.team_id).filter((x) => x.id !== r.id) : [];
  const inv: InvRow[] = receipts.length ? receipts
    : isR(r) && (r.receipt_path || r.vendor) ? [{ id: 'r', vendor: r.vendor, date: r.purchase_date, file_path: r.receipt_path, file_name: r.receipt_name, amount: r.amount }] : [];
  const vendors = [...new Set(inv.map((x) => x.vendor).filter(Boolean))].join(', ') || r.vendor || '';
  const paid = !!r.paid_date && r.status !== 'Cancelled';
  const before = UNPAID.includes(r.status) && !pay;
  // A reimbursement still waiting with no approval takes more receipts; its total is their sum (0011).
  const reimbOpen = isR(r) && ['Draft', 'Submitted'].includes(r.status) && !calc.approvalsFor(r.id).length && receipts.length > 0;
  const adding = openReceipts || reimbOpen;
  const removable = (r.type === 'Pre-Approval' && r.status !== 'Closed' && receipts.length > 0) || (reimbOpen && receipts.length > 1);

  const addReceipt = async () => {
    const a = num(rc.amount);
    if (!(a > 0)) { setErr('Enter the receipt amount.'); return; }
    setBusy(true); setErr(null);
    let path: string | null = null, name: string | null = null;
    if (file) {
      const up = await uploadFile(r.team_id ? 'team/' + r.team_id + '/receipts' : 'receipts/' + r.id, file);
      if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
      path = up.path; name = up.name;
    }
    const ok = await run(() => rpc('add_request_receipt', { p_request_id: r.id, p_vendor: orNull(rc.vendor), p_amount: a, p_date: rc.date || calc.today, p_file_name: name, p_file_path: path, p_by: me }), 'Receipt added');
    setBusy(false);
    if (ok === false) return;
    setRc({ vendor: '', amount: '', date: calc.today }); setFile(null);
  };
  const delReceipt = async (rid: string) => {
    const x = receipts.find((y) => y.id === rid);
    if (!x) return;
    const why = await ui.ask({ title: 'Remove Receipt', body: <>Take the {money(x.amount)} receipt{x.vendor ? ' from ' + x.vendor : ''} off this request? The file is kept.</>, ok: 'Remove', danger: true });
    if (!why) return;
    await run(() => rpc('receipt_archive', { p_id: rid, p_reason: why }), 'Receipt removed');
  };
  const complete = async () => {
    const left = calc.outstanding(r);
    const yes = await ui.confirm({
      title: 'Receipts Complete',
      body: <>{money(calc.receipted(r))} receipted of {money(r.amount)}.{left > 0 ? <> The unspent {money(left)} goes back into {calc.fundName(t?.fund_id)} and the request closes.</> : ' The request closes.'}</>,
      ok: 'Close Request',
    });
    if (!yes) return;
    await run(() => rpc('complete_request_receipts', { p_request_id: r.id, p_date: calc.today }), 'Request closed');
  };
  const approve = async () => {
    const res = await run(() => rpc('approve_request', { p_request_id: r.id }));
    if (res === false) return;
    const o = res as { approvals: number; needed: number; status: string; warnings?: string[] };
    if (o.warnings?.length) await ui.confirm({ title: o.status === 'Approved' ? 'Approved, With A Warning' : 'Approval Recorded, With A Warning', body: <>{o.warnings.map((w, i) => <div key={i}>{w}</div>)}</>, ok: 'OK' });
    else ui.toast(o.status === 'Approved' ? 'Approved · ready to pay' : 'Approval ' + o.approvals + ' of ' + o.needed + ' recorded');
  };
  const decline = async () => {
    const why = await ui.ask({ title: 'Decline Request #' + r.id, body: <>The team sees this reason.</>, ok: 'Decline', danger: true, label: 'Reason', placeholder: 'One line the team will see' });
    if (!why) return;
    await run(() => rpc('decline_request', { p_request_id: r.id, p_reason: why }), 'Declined · the team sees the reason');
  };
  // A direct expense on a team fund passes the same spending rules as paying a team request; the Treasurer can override.
  const teamFund = !!fundId && fundId !== calc.db.settings.general_fund_id && calc.db.funds.some((f) => f.id === fundId && (f.team_id || calc.db.teams.some((x) => x.fund_id === f.id)));
  const reviewWarn = teamFund && calc.needsReview(r) ? calc.spendWarnings(fundId!, r.amount, 'Robotics Teams') : [];
  const review = async () => {
    let override: string | null = null;
    if (reviewWarn.length) {
      if (!isTreasurer) { ui.toast('Blocked: ' + reviewWarn.join(' ') + ' Only the Treasurer can override.', true); return; }
      override = await ui.ask({ title: 'Override A Money Rule', body: <>{reviewWarn.map((x, i) => <div key={i}>{x}</div>)}</>, ok: 'Override And Post', label: 'Why this is allowed' });
      if (!override) return;
    } else {
      const yes = await ui.confirm({ title: 'Mark Reviewed', body: <>Posts {money(r.amount, true)} to the {calc.fundName(fundId)} ledger as already paid ({[r.pay_method, r.pay_ref].filter(Boolean).join(' ')}). There is no reimbursement step.</>, ok: 'Mark Reviewed' });
      if (!yes) return;
    }
    await run(() => rpc('direct_expense_review', { p_request_id: r.id, p_override: override }), 'Reviewed · posted to the fund ledger');
  };
  const linkReplacement = async () => {
    const nid = await ui.ask({ title: 'Link Replacement', body: <>The request that replaces #{r.id}. Both requests show the link.</>, ok: 'Link', label: 'Request number', placeholder: 'e.g. ' + r.id });
    if (!nid) return;
    await run(() => rpc('request_link_replacement', { p_cancelled: r.id, p_new: nid.replace(/^#/, '').trim() }), 'Linked');
  };
  const canArchive = r.status === 'Draft' || r.status === 'Declined';
  const del = async () => {
    const why = await ui.ask({ title: 'Archive Request', body: <>Archive #{r.id}, {forText(r)}? It stays on record.</>, ok: 'Archive', danger: true });
    if (!why) return;
    const ok = await run(() => rpc('archive_record', { p_table: 'team_requests', p_id: r.id, p_reason: why }), 'Request archived');
    if (ok !== false) ui.close();
  };

  const acts: ReactNode[] = [];
  if (before) acts.push(<button key="c" className="btn dan" onClick={() => ui.open(<CancelForm id={r.id} />)}>Cancel Request</button>);
  if (paid && PAIDS.includes(r.status)) {
    acts.push(rf
      ? <span key="rf" className="dis" title="A refund is already recorded on this request"><button className="btn amb-btn" disabled>Record Refund</button></span>
      : <button key="rf" className="btn amb-btn" onClick={() => ui.open(<RefundForm id={r.id} />)}>Record Refund</button>);
  }
  if (calc.needsVote(r)) {
    const why = calc.cannotApprove(r, user.id, user.email);
    acts.push(<button key="d" className="btn" onClick={decline}>Decline</button>);
    acts.push(why ? <span key="a" className="dis" title={why}><button className="btn pri" disabled>Approve</button></span> : <button key="a" className="btn pri" onClick={approve}>Approve</button>);
  } else if (r.status === 'Approved') {
    acts.push(canPay ? <button key="p" className="btn pri" onClick={() => ui.open(<PayForm id={r.id} />)}>Record Payment</button>
      : <span key="p" className="dis" title="The Treasurer or the bookkeeper records the payment"><button className="btn pri" disabled>Record Payment</button></span>);
  } else if (calc.needsReview(r)) {
    acts.push(role === 'bookkeeper' || (isTreasurer && reviewWarn.length) ? <button key="v" className="btn pri" onClick={review}>{reviewWarn.length && isTreasurer ? 'Review With Override' : 'Mark Reviewed'}</button>
      : <span key="v" className="dis" title="The bookkeeper reviews direct expenses"><button className="btn pri" disabled>Mark Reviewed</button></span>);
  } else if (openReceipts && canPay) acts.push(<button key="rc" className="btn pri" onClick={complete}>Receipts Complete</button>);
  if (r.status === 'Cancelled' && !r.replaced_by_id) acts.push(<button key="l" className="btn" onClick={linkReplacement}>Link Replacement</button>);

  const chips = <>
    {r.replaces_id ? <button type="button" className="rq-lchip" onClick={() => ui.open(<RequestView id={r.replaces_id!} />)}>Linked: Replaces Request #{r.replaces_id}</button> : null}
    {r.replaced_by_id ? <button type="button" className="rq-lchip" onClick={() => ui.open(<RequestView id={r.replaced_by_id!} />)}>Linked: Replaced By #{r.replaced_by_id}</button> : null}
  </>;

  return (
    <Modal wide title={'Request #' + r.id} foot={<>
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Close</button>{chips}
        {canArchive ? <button className="btn dan" onClick={del}>Archive</button> : null}
        {!isD(r) && before ? <button className="btn" onClick={() => ui.open(<RequestForm id={r.id} />)}>Edit</button> : null}
      </span>
      <span className="btnrow">{acts}</span>
    </>}>
      <div className="full reqhead"><StBadge r={r} /><span className="muted">{money(r.amount, true)}</span></div>
      <Kv k="Type"><TypeDot r={r} /></Kv>
      <Kv k="Charge To">{calc.chargeTo(r)}<span className="muted"> · {money(calc.fundBalance(fundId))} balance</span></Kv>
      <Kv k="Purpose">{r.purpose}</Kv>
      <Kv k="Filed By"><span className="rq-fl"><Filer r={r} /><span className="muted">· {isD(r) ? 'Board' : t?.short || 'Team'} · {sd(r.submitted)}</span>
        {member ? <span title="Cannot approve this request"><Badge>Board Member</Badge></span> : null}</span></Kv>
      <Kv k="Status"><span className="rq-fl"><StBadge r={r} /><Timeline r={r} /></span></Kv>
      {calc.needsVote(r) ? <Kv k="Approvals">{calc.approvalsFor(r.id).length} of {calc.needed(r)}{calc.approvalsFor(r.id).length ? <span className="muted"> · {calc.approvalsFor(r.id).map((a) => a.approver_name).join(', ')}</span> : null}</Kv> : null}
      {r.category ? <Kv k="Category">{r.category}</Kv> : null}
      {vendors ? <Kv k="Vendors">{vendors}</Kv> : null}
      {isR(r) && r.zelle_contact ? <Kv k="Zelle">{r.zelle_contact}</Kv> : null}
      {r.type === 'Pre-Approval' ? <Kv k="Pay To">{(r.pay_to || '') + (r.needed_by ? ' · needed by ' + sd(r.needed_by) : '')}</Kv> : null}
      {inv.length || adding ? (
        <div className="full scroll">
          <table className="rq-inv">
            <thead><tr><th>Vendor</th><th>Invoice Date</th><th>File</th><th className="num">Amount</th>{adding || removable ? <th /> : null}</tr></thead>
            <tbody>
              {inv.map((x) => (
                <tr key={x.id}>
                  <td>{x.vendor || '—'}</td><td>{x.date ? sd(x.date) : '—'}</td>
                  <td>{x.file_path ? <FileLink path={x.file_path} name={x.file_name} /> : <span className="muted">{x.file_name || 'No file'}</span>}</td>
                  <td className="num">{money(x.amount, true)}</td>
                  {removable ? <td><button className="btn sm" onClick={() => delReceipt(x.id)}>Remove</button></td> : adding ? <td /> : null}
                </tr>
              ))}
              {adding ? (
                <tr>
                  <td><Txt value={rc.vendor} onChange={(v) => setRc({ ...rc, vendor: v })} placeholder="Vendor and items" /></td>
                  <td><DateIn value={rc.date} onChange={(v) => setRc({ ...rc, date: v })} /></td>
                  <td><input className="in" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></td>
                  <td><Amount value={rc.amount} onChange={(v) => setRc({ ...rc, amount: v })} /></td>
                  <td><button className="btn sm pri" onClick={addReceipt} disabled={busy}>{busy ? 'Adding…' : 'Add'}</button></td>
                </tr>
              ) : null}
            </tbody>
            <tfoot><tr><td colSpan={3}>Total · {inv.length} {inv.length === 1 ? 'invoice' : 'invoices'}</td><td className="num">{money(sum(inv, (x) => x.amount), true)}</td>{adding || removable ? <td /> : null}</tr></tfoot>
          </table>
        </div>
      ) : null}
      {r.type === 'Pre-Approval' && (openReceipts || r.status === 'Closed') ? <Kv k="Receipts">{money(calc.receipted(r)) + ' receipted · ' + money(r.returned || 0) + ' returned · ' + money(Math.max(0, calc.outstanding(r))) + ' outstanding'}{openReceipts ? <span className="muted">{' · due ' + sd(calc.receiptsDue(r))}</span> : null}</Kv> : null}
      {paid || (isD(r) && r.status === 'Submitted') ? (
        <Kv k="Payment"><div className="rq-box">
          <span><span className="rq-k2">Method</span>{pay?.pay_method || r.pay_method || '—'}</span>
          <span><span className="rq-k2">Reference</span>{pay?.pay_ref || r.pay_ref || '—'}</span>
          <span><span className="rq-k2">Date</span>{sd(pay?.date || r.paid_date || r.purchase_date)}</span>
          <span><span className="rq-k2">Amount</span><span className="rq-tot">{money(pay?.amount ?? r.amount, true)}</span></span>
          {isD(r) && r.status === 'Submitted' ? <span className="muted">Posts to the ledger when the bookkeeper reviews it</span> : null}
        </div></Kv>
      ) : null}
      {rf ? (
        <Kv k="Refund"><div className="rq-box amb">
          <Badge tone="amb">{rf.reason}</Badge>
          <span><span className="rq-k2">Amount</span><span className="rq-tot">{money(rf.amount, true)}</span></span>
          <span><span className="rq-k2">Date</span>{sd(rf.date)}</span>
          <span><span className="rq-k2">Net Cost</span><span className="rq-tot">{money(netCost(calc, r), true)}</span></span>
          {rf.note ? <div className="muted" style={{ flexBasis: '100%', whiteSpace: 'normal' }}>{rf.note}</div> : null}
        </div></Kv>
      ) : null}
      {r.status === 'Cancelled' ? <Kv k="Cancelled">{(r.cancel_reason || '') + ' · ' + (r.cancelled_by || '') + (r.cancelled_at ? ', ' + sd(r.cancelled_at.slice(0, 10)) : '')}</Kv> : null}
      {r.status === 'Declined' ? <Kv k="Declined">{(r.decline_reason || '') + (r.declined_by ? ' · ' + r.declined_by : '') + (r.declined_at ? ', ' + sd(r.declined_at.slice(0, 10)) : '')}</Kv> : null}
      {r.notes ? <Kv k="Notes"><span className="wraptext">{r.notes}</span></Kv> : null}
      {late.length && t ? <div className="full sev red">{t.short} has overdue receipts on {late.map((x) => x.id).join(', ')}.</div> : null}
      <Err msg={err} />
    </Modal>
  );
}

/** Cancel before payment (request_cancel): a reason, and optionally a replacement order linked both ways. */
function CancelForm({ id }: { id: string }) {
  const { calc, run } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const [reason, setReason] = useState('');
  const [rep, setRep] = useState<'No Replacement' | 'Reorder As New Request'>('No Replacement');
  const [busy, setBusy] = useState(false);
  if (!r) return <Modal title="Cancel Request"><div className="full empty">This request was archived.</div></Modal>;
  const save = async () => {
    setBusy(true);
    const res = await run(() => rpc('request_cancel', { p_request_id: r.id, p_reason: reason.trim(), p_replace: rep !== 'No Replacement' }));
    setBusy(false);
    if (res === false) return;
    const o = res as { status: string; replacement: string | null };
    ui.close(); ui.close();
    ui.toast(o.replacement ? 'Cancelled · replacement #' + o.replacement + ' filed' : 'Cancelled · nothing posted to the books');
    if (o.replacement) ui.open(<RequestView id={o.replacement} />);
  };
  const ok = !!reason.trim();
  return (
    <Modal title={'Cancel Request #' + r.id + '?'} foot={<>
      <span />
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Back</button>
        {ok ? <button className="btn dan" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          : <span className="dis" title="Say why it is cancelled"><button className="btn dan" disabled>Save</button></span>}
      </span>
    </>}>
      <div className="full muted">{forText(r)} · {money(r.amount, true)}. Nothing has been paid, so nothing posts to the books.</div>
      <Kv k="Reason"><Area value={reason} onChange={setReason} placeholder="Why it is cancelled (required)" /></Kv>
      <Kv k="Replacement"><Seg value={rep} options={['No Replacement', 'Reorder As New Request']} onChange={setRep} /></Kv>
      {rep !== 'No Replacement' ? <div className="full muted">A copy is filed as a new request{isD(r) ? '' : ' for the board to approve'}, and the two link to each other.</div> : null}
    </Modal>
  );
}

/** Money back on a paid request (request_refund): an In row to the same fund, linked to the request. */
function RefundForm({ id }: { id: string }) {
  const { calc, run } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const pay = r ? calc.paymentFor(r.id) : null;
  const max = r ? round2((pay?.amount ?? r.amount) - (r.returned || 0)) : 0;
  const [amt, setAmt] = useState(str(max));
  const [when, setWhen] = useState(calc.today);
  const [reason, setReason] = useState<'Returned' | 'Cancelled'>('Returned');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!r) return <Modal title="Record Refund"><div className="full empty">This request was archived.</div></Modal>;
  const a = num(amt);
  const save = async () => {
    if (!(a > 0)) { setErr('Enter the refund amount.'); return; }
    if (a > max) { setErr('The refund cannot be more than ' + money(max, true) + '.'); return; }
    const ok = await run(() => rpc('request_refund', { p_request_id: r.id, p_amount: a, p_date: when || calc.today, p_reason: reason, p_note: orNull(note) }), 'Refund recorded · back in the fund');
    if (ok !== false) ui.close();
  };
  return (
    <Modal title={'Record Refund · Request #' + r.id} foot={<Foot onSave={save} saveLabel="Save" />}>
      <Kv k="Amount"><span className="rq-fl"><Amount value={amt} onChange={setAmt} /><span className="muted">of {money(max, true)}</span></span></Kv>
      <Kv k="Date"><DateIn value={when} onChange={setWhen} /></Kv>
      <Kv k="Reason"><Seg value={reason} options={['Returned', 'Cancelled']} onChange={setReason} /></Kv>
      <Kv k="Note"><Txt value={note} onChange={setNote} placeholder="Optional" /></Kv>
      <Kv k="Goes Back To">{calc.fundName(calc.requestFundId(r))}</Kv>
      <Err msg={err} />
    </Modal>
  );
}

/** Pick the fund a direct expense is charged to: GPRIC General or a team fund. */
function FundPicker({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const { calc } = useData();
  const ui = useUI();
  const [v, setV] = useState(value);
  const gen = calc.db.settings.general_fund_id;
  return (
    <Modal title="Charge To" foot={<><span /><span className="btnrow"><button className="btn" onClick={ui.close}>Cancel</button><button className="btn pri" disabled={!v} onClick={() => { onPick(v); ui.close(); }}>Save</button></span></>}>
      <div className="full rq-picker" role="radiogroup">
        {calc.directFunds().map((f) => (
          <label key={f.id}>
            <input type="radio" name="rqfund" checked={v === f.id} onChange={() => setV(f.id)} />
            <span>{f.id === gen ? 'GPRIC General' : f.name}{f.id === gen ? <span className="muted"> · {f.name}</span> : null}</span>
            <span className="bal">{money(calc.fundBalance(f.id))}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

type Inv = { k: number; vendor: string; amount: string; date: string; file: File | null };
/** A purchase the board already paid (direct_expense_file): one payment, any number of invoices. */
function DirectForm() {
  const { calc, run } = useData();
  const ui = useUI();
  const gen = calc.db.settings.general_fund_id;
  const [purpose, setPurpose] = useState('');
  const [fund, setFund] = useState('');
  const [method, setMethod] = useState<(typeof DIRECT_PAY)[number]>('Debit Card');
  const [ref, setRef] = useState('');
  const [when, setWhen] = useState(calc.today);
  const [inv, setInv] = useState<Inv[]>([{ k: 1, vendor: '', amount: '', date: calc.today, file: null }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: number, p: Partial<Inv>) => setInv((xs) => xs.map((x) => (x.k === k ? { ...x, ...p } : x)));
  const total = round2(sum(inv, (x) => num(x.amount) || 0));
  const why = !purpose.trim() ? 'Say what was bought'
    : !fund ? 'Choose the fund to charge'
    : !inv.length || inv.some((x) => !x.vendor.trim() || !(num(x.amount) > 0)) ? 'Each invoice needs a vendor and an amount'
    : method === 'Check' && !ref.trim() ? 'Enter the check number' : null;
  const save = async () => {
    if (why) return;
    setBusy(true); setErr(null);
    const rows: Record<string, unknown>[] = [];
    for (const x of inv) {
      let path: string | null = null, name: string | null = null;
      if (x.file) {
        const up = await uploadFile('requests/direct', x.file);
        if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
        path = up.path; name = up.name;
      }
      rows.push({ vendor: x.vendor.trim(), amount: num(x.amount), date: x.date || when, file_name: name, file_path: path });
    }
    const res = await run(() => rpc('direct_expense_file', { p: { purpose: purpose.trim(), charge_fund_id: fund, pay_method: method, pay_ref: orNull(ref), paid_date: when || calc.today, invoices: rows } }));
    setBusy(false);
    if (res === false) return;
    const o = res as { id: string; amount: number; warnings?: string[] };
    ui.close();
    if (o.warnings?.length) await ui.confirm({ title: 'Filed, With A Warning', body: <>{o.warnings.map((w, i) => <div key={i}>{w}</div>)}</>, ok: 'OK' });
    else ui.toast('Filed · #' + o.id + ' goes to the bookkeeper to review');
  };
  return (
    <Modal wide title="New Direct Expense" foot={<>
      <span className="muted">{why ? '' : 'Goes to the bookkeeper to review.'}</span>
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Cancel</button>
        {why ? <span className="dis" title={why}><button className="btn pri" disabled>Save</button></span>
          : <button className="btn pri" onClick={save} disabled={busy} title="Goes to the bookkeeper to review. Reviewing posts it to the fund ledger as already paid.">{busy ? 'Saving…' : 'Save'}</button>}
      </span>
    </>}>
      <Kv k="What Was Bought"><Txt value={purpose} onChange={setPurpose} placeholder="e.g. Field elements and tools" autoFocus /></Kv>
      <Kv k="Charge To"><span className="rq-fl">
        <button type="button" className="btn" onClick={() => ui.open(<FundPicker value={fund} onPick={setFund} />)}>{fund ? (fund === gen ? 'GPRIC General' : calc.fundName(fund)) : 'Choose Fund…'}</button>
        {fund ? <span className="muted">{money(calc.fundBalance(fund))} balance</span> : null}
      </span></Kv>
      <Kv k="Paid By"><span className="rq-fl">
        <Seg value={method} options={[...DIRECT_PAY]} onChange={setMethod} />
        {method === 'Check' ? <Txt value={ref} onChange={setRef} placeholder="Check number" /> : null}
      </span></Kv>
      <Kv k="Date Paid"><DateIn value={when} onChange={setWhen} /></Kv>
      <Kv k="Invoices"><span className="muted">One payment, any number of invoices</span></Kv>
      <div className="full scroll">
        <table className="rq-inv">
          <thead><tr><th>Vendor</th><th className="num">Amount</th><th>Invoice Date</th><th>File</th><th /></tr></thead>
          <tbody>
            {inv.map((x) => (
              <tr key={x.k}>
                <td><Txt value={x.vendor} onChange={(v) => set(x.k, { vendor: v })} placeholder="Vendor" /></td>
                <td><Amount value={x.amount} onChange={(v) => set(x.k, { amount: v })} /></td>
                <td><DateIn value={x.date} onChange={(v) => set(x.k, { date: v })} /></td>
                <td><label className="btn sm" style={{ cursor: 'pointer' }}>{x.file ? x.file.name.slice(0, 24) : 'Attach File'}
                  <input type="file" hidden accept="image/*,application/pdf" onChange={(e) => set(x.k, { file: e.target.files?.[0] || null })} /></label></td>
                <td>{inv.length > 1 ? <button type="button" className="lnk" aria-label="Remove invoice" title="Remove invoice" onClick={() => setInv((xs) => xs.filter((y) => y.k !== x.k))}>×</button> : null}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            <td><button type="button" className="lnk" onClick={() => setInv((xs) => [...xs, { k: Math.max(0, ...xs.map((y) => y.k)) + 1, vendor: '', amount: '', date: when || calc.today, file: null }])}>+ Add Invoice</button></td>
            <td className="num" colSpan={4}>Total · {inv.length} {inv.length === 1 ? 'invoice' : 'invoices'} <span className="rq-tot">{money(total, true)}</span></td>
          </tr></tfoot>
        </table>
      </div>
      <div className="full muted">Only the Treasurer, the bookkeeper and officers the Treasurer names can file these. Reviewing posts it to the fund ledger as already paid.</div>
      <Err msg={err} />
    </Modal>
  );
}

/** Records how a request was paid and writes its ledger row (mark_request_paid). */
function PayForm({ id }: { id: string }) {
  const { calc, run, isTreasurer } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const [method, setMethod] = useState<PayMethod>(r && isR(r) ? 'Zelle' : 'Check');
  const [when, setWhen] = useState(calc.today);
  const [ref, setRef] = useState('');
  if (!r) return <Modal title="Record Payment"><div className="full empty">This request was archived.</div></Modal>;
  const t = calc.team(r.team_id);
  const w = t?.fund_id ? calc.spendWarnings(t.fund_id, r.amount, 'Robotics Teams') : ['This team has no fund. Set one under Teams first.'];
  const save = async () => {
    let override: string | null = null;
    if (w.length && t?.fund_id) {
      if (!isTreasurer) { ui.toast('Blocked: ' + w.join(' ') + ' Only the Treasurer can override.', true); return; }
      override = await ui.ask({ title: 'Override A Money Rule', body: <>{w.map((x, i) => <div key={i}>{x}</div>)}</>, ok: 'Override And Pay', label: 'Why this is allowed' });
      if (!override) return;
    }
    const ok = await run(() => rpc('mark_request_paid', { p_request_id: r.id, p_date: when || calc.today, p_method: method, p_ref: orNull(ref), p_override: override }),
      isR(r) ? 'Paid · ledger row written' : 'Paid · receipts due in ' + calc.receiptDays + ' days · ledger row written');
    if (ok !== false) ui.close();
  };
  const check = method === 'Check';
  return (
    <Modal title="Record Payment" foot={<Foot onSave={save} saveLabel="Record Payment" />}>
      <div className="full reqhead"><TypeBadge r={r} /><b>{t?.short}</b><span className="muted">·</span>{forText(r)}</div>
      <Kv k="Amount"><b>{money(r.amount)}</b></Kv>
      <Kv k="Pay To">{isR(r) ? requestor(r) + (r.zelle_contact ? ' · Zelle ' + r.zelle_contact : '') : (r.pay_to || '') + (r.vendor ? ' · ' + r.vendor : '')}</Kv>
      <Kv k="Method"><Seg value={method} options={[...PAY_METHODS]} onChange={setMethod} /></Kv>
      <Kv k="Date Paid"><DateIn value={when} onChange={setWhen} /></Kv>
      <Kv k={check ? 'Check Number' : 'Confirmation Number'}><Txt value={ref} onChange={setRef} placeholder={check ? 'e.g. 110' : method === 'Zelle' ? 'Zelle confirmation code' : 'Reference from the bank'} /></Kv>
      <div className="full muted">Saving writes one Out row to the Ledger for the whole request: {money(-r.amount)} from {calc.fundName(t?.fund_id) || 'the team fund'}.{isR(r) ? '' : ' It also starts the ' + calc.receiptDays + '-day receipt clock.'}</div>
      <Warnings list={w} blocks />
    </Modal>
  );
}

/** The dollar threshold and how many approvals each side of it needs (settings). */
function RulesForm() {
  const { db, run, isTreasurer } = useData();
  const ui = useUI();
  const s = db.settings;
  const [bk, setBk] = useState(s.bookkeeper_can_approve !== false);
  const [t, setT] = useState(str(s.approval_threshold));
  const [under, setUnder] = useState(String(s.approvals_under) as '1' | '2');
  const [over, setOver] = useState(String(s.approvals_over) as '1' | '2' | '3');
  const [err, setErr] = useState<string | null>(null);
  const amt = num(t);
  const save = async () => {
    if (!(amt >= 0)) { setErr('Enter the threshold in dollars.'); return; }
    const ok = await run(() => rpc('settings_save_rules', { p_threshold: amt, p_under: +under, p_over: +over, p_receipt_days: null, p_bookkeeper_can_approve: bk }), 'Approval rules saved');
    if (ok !== false) ui.close();
  };
  const ap = (n: string) => n + (n === '1' ? ' approval' : ' approvals');
  return (
    <Modal title="Approval Rules" foot={<Foot onSave={isTreasurer ? save : undefined} />}>
      {!isTreasurer ? <div className="full muted">Only the Treasurer changes the approval rules.</div> : null}
      <Kv k="Threshold"><Amount value={t} onChange={setT} placeholder="500.00" /></Kv>
      <Kv k="Up To Threshold"><Seg value={under} options={[['1', '1 Approval'], ['2', '2 Approvals']]} onChange={setUnder} /></Kv>
      <Kv k="Over Threshold"><Seg value={over} options={[['1', '1 Approval'], ['2', '2 Approvals'], ['3', '3 Approvals']]} onChange={setOver} /></Kv>
      <Kv k="Applies To">Pre-Approvals and Reimbursements<span className="info" title="One rule for both team request types. Direct expenses are already paid and go to the bookkeeper's review instead. Changing it applies to requests still waiting; finished approvals stand.">?</span></Kv>
      <Kv k="Always">Requestor excluded · one approval per member</Kv>
      <Kv k="Bookkeeper"><Check checked={bk} onChange={setBk}>The bookkeeper may approve (for testing)</Check></Kv>
      <Kv k="Preview">{amt >= 0 ? 'Up to ' + money(amt) + ': ' + ap(under) + ' · over ' + money(amt) + ': ' + ap(over) : ''}</Kv>
      <Err msg={err} />
    </Modal>
  );
}

/** The board enters a request on a team's behalf. Overdue receipts and short funds warn here; paying is where the money rules block. */
function RequestForm({ id }: { id?: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const old = id ? calc.request(id) : null;
  const firstTeam = db.teams[0];
  const [f, setF] = useState(() => ({
    type: (old?.type || 'Pre-Approval') as RequestType,
    team_id: old?.team_id || firstTeam?.id || '', purpose: old?.purpose || '', category: old?.category || REQUEST_CATEGORIES[0], amount: str(old?.amount),
    pay_to: old?.pay_to || PAY_TO[0], vendor: old?.vendor || '', needed_by: old?.needed_by || '', purchase_date: old?.purchase_date || '',
    zelle_contact: old?.zelle_contact || '', requestor_name: old?.requestor_name || '', requestor_email: old?.requestor_email || '',
    submitted: old?.submitted || calc.today, status: old?.status || 'Submitted', notes: old?.notes || '',
  }));
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const t = calc.team(f.team_id);
  const amt = num(f.amount);
  const R = f.type === 'Reimbursement';
  // A reimbursement with receipts listed: its total is their sum (0011), changed by adding or removing a receipt.
  const rcs = old ? calc.receiptsFor(old.id) : [];
  const fixedTotal = R && rcs.length > 0;
  const warnings: string[] = [];
  if (t) {
    const blocked = calc.teamBlocked(t.id).filter((x) => x.id !== id);
    blocked.forEach((x) => warnings.push(`${t.short} has receipts ${calc.daysLate(x)} days overdue on ${x.id} (${x.purpose}).`));
    const m = calc.teamMoney(t);
    const avail = round2(m.available + (old && old.status === 'Approved' ? old.amount : 0));
    if (amt > 0 && amt > avail) warnings.push(`${t.short} has ${money(avail)} available after approved requests. This asks for ${money(amt)}.`);
    if (!t.fund_id) warnings.push(`${t.short} has no fund yet. Set one under Teams before paying.`);
  }

  const save = async () => {
    if (!f.team_id) { setErr('Pick a team.'); return; }
    if (!(amt > 0)) { setErr('Enter the amount.'); return; }
    if (R ? !f.vendor.trim() : !f.purpose.trim()) { setErr(R ? 'Enter the vendor.' : 'Enter what the money is for.'); return; }
    if (R && !f.zelle_contact.trim()) { setErr('A reimbursement is paid by Zelle; enter the Zelle contact.'); return; }
    let path = old?.receipt_path || null, name = old?.receipt_name || null;
    if (R && file) {
      const up = await uploadFile('requests/' + (old?.id || 'new'), file);
      if ('error' in up) { setErr('Upload failed: ' + up.error); return; }
      path = up.path; name = up.name;
    }
    const row = {
      type: f.type, team_id: f.team_id, category: f.category, amount: amt,
      purpose: R ? (f.purpose.trim() || [f.vendor.trim(), f.category].join(' · ')) : f.purpose.trim(),
      pay_to: R ? 'Me by Zelle' : f.pay_to, vendor: orNull(f.vendor), needed_by: R ? null : f.needed_by || null, purchase_date: R ? f.purchase_date || null : null,
      zelle_contact: R ? orNull(f.zelle_contact) : null, receipt_path: R ? path : null, receipt_name: R ? name : null,
      requestor_name: orNull(f.requestor_name), requestor_email: orNull(f.requestor_email)?.toLowerCase() || null,
      submitted: f.submitted || calc.today, notes: orNull(f.notes),
    };
    const ok = await run(() => rpc('request_save', { p: { ...row, id: old?.id } }), old ? 'Request saved' : 'Request entered · waiting for approval');
    if (ok === false) return;
    ui.close();
  };
  return (
    <Modal title={old ? 'Edit #' + old.id : 'New Request'} foot={<Foot onSave={save} saveLabel={old ? 'Save' : 'Submit To The Board'} />}>
      {!old ? <div className="full muted">Teams send requests from their Team Portal. Use this to enter one on a team&apos;s behalf. A purchase the board already paid is a New Direct Expense instead.</div> : null}
      <Kv k="Type"><Seg value={f.type} options={TEAM_TYPES} onChange={(v) => set({ type: v })} /></Kv>
      <Kv k="Team"><Select value={f.team_id} onChange={(v) => set({ team_id: v })} options={db.teams.map((x) => [x.id, x.name])} /></Kv>
      <Kv k="Requestor"><Txt value={f.requestor_name} onChange={(v) => set({ requestor_name: v })} placeholder="Coach or treasurer's name" /></Kv>
      <Kv k="Requestor Email"><Txt value={f.requestor_email} onChange={(v) => set({ requestor_email: v })} placeholder="Used to stop them approving their own request" /></Kv>
      <Kv k="Amount">{fixedTotal ? <><b>{money(old!.amount, true)}</b><span className="muted"> · the sum of its {rcs.length} {rcs.length === 1 ? 'receipt' : 'receipts'}; add or remove one on the request</span></>
        : <Amount value={f.amount} onChange={(v) => set({ amount: v })} />}</Kv>
      <Kv k="Category"><Select value={f.category} onChange={(v) => set({ category: v || REQUEST_CATEGORIES[0] })} options={REQUEST_CATEGORIES.map((c) => [c, c])} /></Kv>
      {R ? <>
        <Kv k="Vendor"><Txt value={f.vendor} onChange={(v) => set({ vendor: v })} /></Kv>
        <Kv k="Purchase Date"><DateIn value={f.purchase_date} onChange={(v) => set({ purchase_date: v })} /></Kv>
        <Kv k="Zelle Contact"><Txt value={f.zelle_contact} onChange={(v) => set({ zelle_contact: v })} placeholder="Phone or email for Zelle" /></Kv>
        {fixedTotal ? <Kv k="Receipts"><span className="muted">{rcs.length} listed on the request</span></Kv>
          : <Kv k="Receipt">{old?.receipt_path && !file ? <><FileLink path={old.receipt_path} name={old.receipt_name} /> </> : null}<input className="in" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Kv>}
        <Kv k="Notes"><Txt value={f.purpose} onChange={(v) => set({ purpose: v })} placeholder="What was bought (optional)" /></Kv>
      </> : <>
        <Kv k="Purpose"><Txt value={f.purpose} onChange={(v) => set({ purpose: v })} placeholder="What the money is for" /></Kv>
        <Kv k="Pay To"><Seg value={f.pay_to as (typeof PAY_TO)[number]} options={[...PAY_TO]} onChange={(v) => set({ pay_to: v })} /></Kv>
        {f.pay_to === PAY_TO[0] ? <Kv k="Vendor"><Txt value={f.vendor} onChange={(v) => set({ vendor: v })} /></Kv> : null}
        <Kv k="Needed By"><DateIn value={f.needed_by} onChange={(v) => set({ needed_by: v })} /></Kv>
      </>}
      <Kv k="Submitted"><DateIn value={f.submitted} onChange={(v) => set({ submitted: v })} /></Kv>
      {old ? <Kv k="Status"><StBadge r={old} /><div className="muted" style={{ fontSize: 12 }}>Approving, declining, paying and closing set this. It is not edited by hand.</div></Kv> : null}
      <Kv k="Board Notes"><Area value={f.notes} onChange={(v) => set({ notes: v })} /></Kv>
      {t ? <Kv k="Team Fund">{money(calc.fundBalance(t.fund_id))} balance · {money(calc.teamMoney(t).approvedUnpaid)} approved, not paid</Kv> : null}
      <Warnings list={warnings} />
      <Err msg={err} />
    </Modal>
  );
}

function teamLogins(calc: Calc, tid: string) {
  const users = calc.db.team_users.filter((u) => u.team_id === tid);
  const pending = calc.db.team_invites.filter((i) => i.team_id === tid && !i.user_id);
  return { users, pending };
}

function TeamsList() {
  const { db, calc } = useData();
  const ui = useUI();
  const cols: Col<Team>[] = [
    { k: 'name', label: 'Team' },
    { k: 'program', label: 'Program' },
    { k: 'fund', label: 'Fund Balance', num: true, sv: (t) => calc.fundBalance(t.fund_id), html: (t) => (t.fund_id ? money(calc.fundBalance(t.fund_id)) : <Badge tone="amb">No Fund</Badge>) },
    { k: 'logins', label: 'Team Logins', sv: (t) => teamLogins(calc, t.id).users.length, html: (t) => {
      const { users, pending } = teamLogins(calc, t.id);
      if (!users.length && !pending.length) return <span className="muted">None yet</span>;
      return <>{users.map((u) => (u.name || u.email) + ' (' + u.role.toLowerCase() + ')').join(', ')}{pending.length ? <> <span title={pending.map((i) => i.email).join(', ')}><Badge tone="amb">{pending.length + ' Invited'}</Badge></span></> : null}</>;
    } },
    { k: 'blocked', label: 'Receipts', sv: (t) => calc.teamBlocked(t.id).length, html: (t) => (calc.teamBlocked(t.id).length ? <Badge tone="red">Overdue</Badge> : <Badge tone="grn">OK</Badge>) },
  ];
  return (
    <Modal wide title="Teams" foot={<><span /><span className="btnrow"><button className="btn" onClick={ui.close}>Close</button><button className="btn" onClick={() => ui.open(<InviteForm />)}>Invite Team Login</button><button className="btn pri" onClick={() => ui.open(<TeamForm />)}>Add Team</button></span></>}>
      <div className="full"><Table cols={cols} rows={db.teams} sort="name" onRow={(t) => ui.open(<TeamForm id={t.id} />)} empty="No teams yet." /></div>
    </Modal>
  );
}

/** Sends a coach or team treasurer a sign-in invite tied to one team (api/team-invite). */
function InviteForm({ teamId }: { teamId?: string }) {
  const { db, reload } = useData();
  const ui = useUI();
  const [f, setF] = useState({ team_id: teamId || db.teams[0]?.id || '', email: '', name: '', role: 'Coach' as 'Coach' | 'Treasurer' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!f.team_id) { setErr('Pick a team.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) { setErr('Enter their email address.'); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/team-invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, email: f.email.trim() }) });
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) { setErr(out.error || 'The invite did not go out.'); return; }
    await reload();
    ui.toast('Invite sent to ' + f.email.trim());
    ui.close();
  };
  return (
    <Modal title="Invite Team Login" foot={<Foot onSave={save} saveLabel={busy ? 'Sending…' : 'Send Invite'} busy={busy} />}>
      <div className="full muted">They get an email to set a password and an authenticator code, then see only this team&apos;s Team Portal.</div>
      <Kv k="Team"><Select value={f.team_id} onChange={(v) => set({ team_id: v })} options={db.teams.map((x) => [x.id, x.name])} /></Kv>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} /></Kv>
      <Kv k="Email"><Txt type="email" value={f.email} onChange={(v) => set({ email: v })} /></Kv>
      <Kv k="Role"><Seg value={f.role} options={['Coach', 'Treasurer']} onChange={(v) => set({ role: v })} /></Kv>
      <Err msg={err} />
    </Modal>
  );
}

function TeamForm({ id }: { id?: string }) {
  const { db, calc, run, isTreasurer } = useData();
  const ui = useUI();
  const old = id ? calc.team(id) : null;
  const [f, setF] = useState(() => ({
    name: old?.name || '', short: old?.short || '', program: old?.program || '', level: old?.level || '', season: old?.season || '',
    fund_id: old?.fund_id || '', newFund: !old, pay_mode: old?.pay_mode || 'Team EIN Account', ein: old?.ein || '', school: old?.school || '',
    students: str(old?.students), affiliated: old?.affiliated || '', blurb: old?.blurb || '', zeffy_name: old?.zeffy_name || '',
  }));
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!f.name.trim() || !f.short.trim()) { setErr('Name and short name are needed.'); return; }
    const row = {
      name: f.name.trim(), short: f.short.trim(), program: orNull(f.program), level: orNull(f.level), season: orNull(f.season), pay_mode: f.pay_mode,
      ein: orNull(f.ein), school: orNull(f.school), students: f.students ? parseInt(f.students, 10) || null : null, affiliated: f.affiliated || null, blurb: orNull(f.blurb),
      zeffy_name: orNull(f.zeffy_name),
      // which fund pays for a team is the Treasurer's to change; others leave it as it is
      ...(isTreasurer || !old ? { fund_id: f.newFund ? null : f.fund_id || null } : {}),
    };
    const res = await run(() => rpc('team_save', { p: { ...row, id: old?.id, new_fund: !old && f.newFund } }), old ? 'Team saved' : 'Team added');
    if (res !== false) ui.close();
  };
  const del = async () => {
    if (!old) return;
    const why = await ui.ask({ title: 'Archive Team', body: <>Archive {old.name}? A team with money in its fund or open requests stays until those are settled. Its history stays on record.</>, ok: 'Archive', danger: true });
    if (!why) return;
    const ok = await run(() => rpc('archive_record', { p_table: 'teams', p_id: old.id, p_reason: why }), 'Team archived');
    if (ok !== false) ui.close();
  };
  const logins = old ? teamLogins(calc, old.id) : null;
  return (
    <Modal title={old ? old.name : 'Add Team'} foot={<Foot onDelete={old ? del : undefined} onSave={save} extra={old ? <button className="btn" onClick={() => ui.open(<InviteForm teamId={old.id} />)}>Invite Team Login</button> : undefined} />}>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} placeholder="FRC 1234 Team Name" /></Kv>
      <Kv k="Short Name"><Txt value={f.short} onChange={(v) => set({ short: v })} /></Kv>
      <Kv k="Program"><Txt value={f.program} onChange={(v) => set({ program: v })} placeholder="FIRST Tech Challenge" /></Kv>
      <Kv k="Level"><Txt value={f.level} onChange={(v) => set({ level: v })} /></Kv>
      <Kv k="Season"><Txt value={f.season} onChange={(v) => set({ season: v })} /></Kv>
      <Kv k="Fund">
        {!old ? <Check checked={f.newFund} onChange={(v) => set({ newFund: v })}>Create a restricted fund for this team</Check> : null}
        {f.newFund ? null : old && !isTreasurer
          ? <>{calc.fundName(f.fund_id) || 'No fund'} <span className="muted">· only the Treasurer changes this</span></>
          : <FundSelect value={f.fund_id} onChange={(v) => set({ fund_id: v })} blank="No fund" />}
      </Kv>
      <Kv k="Name In Zeffy"><Txt value={f.zeffy_name} onChange={(v) => set({ zeffy_name: v })} placeholder="The Fund name donors pick in Zeffy" /></Kv>
      <Kv k="Paid Through"><Seg value={f.pay_mode as (typeof TEAM_PAY)[number]} options={[...TEAM_PAY]} onChange={(v) => set({ pay_mode: v })} /></Kv>
      {f.pay_mode === 'Team EIN Account' ? <Kv k="Team EIN"><Txt value={f.ein} onChange={(v) => set({ ein: v })} /></Kv> : null}
      <Kv k="School"><Txt value={f.school} onChange={(v) => set({ school: v })} /></Kv>
      <Kv k="Students"><Txt type="number" value={f.students} onChange={(v) => set({ students: v })} /></Kv>
      <Kv k="Joined GPRIC"><DateIn value={f.affiliated} onChange={(v) => set({ affiliated: v })} /></Kv>
      <Kv k="About"><Area value={f.blurb} onChange={(v) => set({ blurb: v })} /></Kv>
      {logins ? <Kv k="Team Logins">{logins.users.length || logins.pending.length
        ? <Lines lines={[...logins.users.map((u) => (u.name || u.email) + ' · ' + u.role + (u.email ? ' · ' + u.email : '')), ...logins.pending.map((i) => i.email + ' · ' + i.role + ' · invited ' + sd(i.invited_at.slice(0, 10)))]} />
        : <span className="muted">None yet</span>}</Kv> : null}
      {old && db.board_members.some((m) => m.interest_team_id === old.id) ? <Kv k="Interested Member">{calc.interestedMember(old.id)?.title || ''}</Kv> : null}
      <Err msg={err} />
    </Modal>
  );
}
