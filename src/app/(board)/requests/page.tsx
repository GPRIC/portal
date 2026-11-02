'use client';
import { useState, type ReactNode } from 'react';
import { Page } from '@/components/shell';
import { removeFiles, uploadFile, useData } from '@/components/data';
import { Amount, Area, DateIn, Err, FileLink, Foot, FundSelect, num, orNull, Select, str, Txt } from '@/components/forms';
import { Badge, Card, Check, Kv, Lines, Modal, Pills, Seg, St, Steps, Table, useUI, Warnings, type Col, type Tone } from '@/components/ui';
import { Tip } from '@/components/tips';
import { supabase } from '@/lib/supabase/client';
import { date, money, round2, sd, sum } from '@/lib/format';
import { PAY_METHODS, PAY_TO, REQUEST_CATEGORIES, REQUEST_STATUSES, REQUEST_TYPES, type PayMethod, type RequestType, type Team, type TeamRequest } from '@/lib/types';
import type { Calc } from '@/lib/calc';

/** How a team's money reaches it (the team record, not a request). */
const TEAM_PAY = ['Team EIN Account', 'School / District'] as const;

const ICON: Record<string, ReactNode> = {
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>,
  pay: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  rcpt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 7h6M9 11h6M9 15h4" /></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};

const isR = (r: TeamRequest) => r.type === 'Reimbursement';
const forText = (r: TeamRequest) => (isR(r) ? [r.vendor, r.category].filter(Boolean).join(' · ') || r.purpose : r.purpose);
const requestor = (r: TeamRequest) => r.requestor_name || r.created_by || '';
function TypeBadge({ r }: { r: TeamRequest }) {
  return isR(r) ? <Badge tone="blu">Reimbursement</Badge> : <Badge tone="vio">Pre-Approval</Badge>;
}

function Approvals({ r }: { r: TeamRequest }) {
  const { calc } = useData();
  if (r.status === 'Declined') return null;
  const got = calc.approvalsFor(r.id), n = calc.needed(r);
  const who = got.map((a) => a.approver_name + ' ' + sd(a.approved_at.slice(0, 10))).join(', ');
  const tip = (who ? 'Approved by ' + who + '. ' : 'No approvals yet. ') + (got.length < n && calc.needsVote(r) ? 'Needs ' + (n - got.length) + ' more; not ' + (requestor(r) || 'the requestor') + (got.length ? ' or ' + got.map((a) => a.approver_name).join(' or ') : '') + '.' : '');
  const tone: Tone = got.length >= n ? 'grn' : got.length ? 'amb' : 'gry';
  return <span title={tip}><Badge tone={tone}>{got.length + ' of ' + n}</Badge></span>;
}

export default function RequestsPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const [filt, setFilt] = useState('Needs Approval');
  const P: [string, Tone, (r: TeamRequest) => boolean][] = [
    ['Needs Approval', 'vio', (r) => calc.needsVote(r)],
    ['To Pay', 'grn', (r) => r.status === 'Approved'],
    ['Receipts Open', 'amb', (r) => calc.isOpenReceipts(r)],
    ['Overdue', 'red', (r) => calc.isOverdue(r)],
    ['Paid', 'grn', (r) => r.status === 'Closed' || (r.status === 'Paid' && isR(r))],
    ['Declined', 'red', (r) => r.status === 'Declined'],
    ['All', 'gry', () => true],
  ];
  const all = db.team_requests.filter((r) => r.status !== 'Draft');
  const team = (r: TeamRequest) => calc.team(r.team_id);
  const na = all.filter(P[0][2]), pay = all.filter(P[1][2]), open = all.filter(P[2][2]), late = all.filter(P[3][2]);
  const second = na.filter((r) => calc.approvalsFor(r.id).length).length;
  const fn = (P.find((p) => p[0] === filt) || P[0])[2];
  const act = (r: TeamRequest): [string, string, () => void] => {
    if (calc.needsVote(r)) return ['check', 'Approve or decline', () => ui.open(<ApproveForm id={r.id} />)];
    if (r.status === 'Approved') return ['pay', 'Mark paid', () => ui.open(<PayForm id={r.id} />)];
    if (calc.isOpenReceipts(r)) return ['rcpt', 'Receipts', () => ui.open(<RequestView id={r.id} />)];
    return ['eye', 'Open', () => ui.open(<RequestView id={r.id} />)];
  };
  const cols: Col<TeamRequest>[] = [
    { k: 'id', label: 'Request' },
    { k: 'type', label: 'Type', html: (r) => <TypeBadge r={r} /> },
    { k: 'team', label: 'Team', sv: (r) => team(r)?.short, html: (r) => team(r)?.short },
    { k: 'requestor', label: 'Requestor', sv: requestor, html: requestor },
    { k: 'for', label: 'For', sv: forText, html: forText },
    { k: 'amount', label: 'Amount', num: true, html: (r) => money(r.amount) },
    { k: 'submitted', label: 'Submitted', html: (r) => sd(r.submitted) },
    { k: 'status', label: 'Status', html: (r) => (r.status === 'Declined' && r.decline_reason ? <span title={r.decline_reason}><St s={r.status} /></span> : <St s={r.status} />) },
    { k: 'approvals', label: 'Approvals', sv: (r) => calc.approvalsFor(r.id).length / calc.needed(r), html: (r) => <Approvals r={r} /> },
    { k: 'due', label: 'Receipts Due', sv: (r) => calc.receiptsDue(r) || 'z', html: (r) => {
      if (calc.isOverdue(r)) return <span title={'Receipts were due ' + sd(calc.receiptsDue(r)) + '. ' + team(r)?.short + ' cannot submit new requests until they are in.'}><Badge tone="red">{calc.daysLate(r) + ' Days Overdue'}</Badge></span>;
      if (calc.isOpenReceipts(r)) return date(calc.receiptsDue(r));
      if (r.status === 'Closed') return <Badge tone="grn">Received</Badge>;
      if (isR(r) && r.status !== 'Declined') return <span className="muted" title="Reimbursements arrive with their receipt">Attached</span>;
      return '';
    } },
    { k: 'act', label: '', nosort: true, html: (r) => { const [i, l, f] = act(r); return <div className="rowacts"><button className="ib" title={l} aria-label={l} onClick={f}>{ICON[i]}</button></div>; } },
  ];
  const blocked = db.teams.filter((t) => calc.teamBlocked(t.id).length);
  return (
    <Page title="Team Requests" help="requests" actions={<>
      <Tip id="requests.rules" side="r" text="Approval Rules: set the dollar threshold and how many board approvals each side of it needs.">
        <button className="ib" title="Approval Rules" aria-label="Approval Rules" onClick={() => ui.open(<RulesForm />)}>{ICON.gear}</button>
      </Tip>
      <Tip id="requests.teams" side="r" text="Teams now lists each team's logins. Invite a coach or team treasurer from here; they submit requests from their own Team Portal.">
        <button className="btn" onClick={() => ui.open(<TeamsList />)}>Teams</button>
      </Tip>
      <button className="btn pri" onClick={() => ui.open(<RequestForm />)}>New Request</button>
    </>}>
      <div className="cards">
        <Card n="Needs Approval" v={String(na.length)} color={na.length ? 'vio' : undefined}
          tip={<Lines lines={[money(sum(na, (r) => r.amount)) + ' requested.', second + ' waiting on a further approval.', na.filter(isR).length + ' reimbursements, ' + na.filter((r) => !isR(r)).length + ' pre-approvals.']} />} />
        <Card n="Approved, Not Paid" v={money(sum(pay, (r) => r.amount))} tip={<Lines lines={pay.map((r) => team(r)?.short + ': ' + forText(r) + ' ' + money(r.amount))} />} />
        <Card n="Receipts Outstanding" v={money(sum(open, (r) => calc.outstanding(r)))}
          tip={<Lines lines={[open.length + ' paid pre-approvals still collecting receipts.', ...open.map((r) => team(r)?.short + ': ' + money(calc.outstanding(r)) + ' due ' + sd(calc.receiptsDue(r)))]} />} />
        <Card n="Teams Blocked" v={String(blocked.length)} color={blocked.length ? 'red' : 'g'}
          tip={<Lines lines={late.map((r) => team(r)?.short + ': ' + r.purpose + ', ' + calc.daysLate(r) + ' days overdue')} none="No team is blocked." />} />
      </div>
      <div className="panel">
        <Pills items={P.map(([k, tone, f]) => ({ key: k, label: k, tone, count: all.filter(f).length }))} active={filt} onPick={setFilt} />
        <Table cols={cols} rows={all.filter(fn)} sort="submitted" dir={-1} onRow={(r) => ui.open(<RequestView id={r.id} />)} empty="No requests here." />
      </div>
    </Page>
  );
}

function stepsFor(calc: Calc, r: TeamRequest): Parameters<typeof Steps>[0]['list'] {
  const got = calc.approvalsFor(r.id), n = calc.needed(r), due = calc.receiptsDue(r);
  const who = requestor(r);
  const S: Parameters<typeof Steps>[0]['list'] = [['done', 'Submitted' + (who ? ' by ' + who : '') + (r.certified ? ' with the team certification' : ''), sd(r.submitted)]];
  if (r.status === 'Declined') {
    S.push(['no', 'Declined' + (r.declined_by ? ' by ' + r.declined_by : '') + ': ' + (r.decline_reason || ''), r.declined_at ? sd(r.declined_at.slice(0, 10)) : '']);
    return S;
  }
  got.forEach((a, i) => S.push(['done', 'Approval ' + (i + 1) + ' of ' + n + ': ' + a.approver_name, sd(a.approved_at.slice(0, 10))]));
  const legacy = !got.length && !calc.needsVote(r);
  if (legacy) S.push(['done', 'Approved by the board', '']);
  else for (let i = got.length; i < n; i++) {
    S.push([i === got.length && calc.needsVote(r) ? 'now' : 'todo', 'Approval ' + (i + 1) + ' of ' + n + ': any board member except ' + (who || 'the requestor') + (got.length ? ' and ' + got.map((a) => a.approver_name).join(', ') : ''), '']);
  }
  const paid = !!r.paid_date;
  S.push([paid ? 'done' : r.status === 'Approved' ? 'now' : 'todo',
    paid ? 'Paid' + (r.pay_method ? ' by ' + r.pay_method : '') + (r.pay_ref ? ' · ' + r.pay_ref : '') : 'Paid ' + (isR(r) ? 'by Zelle' + (r.zelle_contact ? ' to ' + r.zelle_contact : '') : 'to ' + (r.pay_to || 'the team')),
    paid ? sd(r.paid_date) : '']);
  if (!isR(r)) {
    const closed = r.status === 'Closed';
    S.push([closed ? 'done' : paid ? (calc.isOverdue(r) ? 'late' : 'now') : 'todo', closed ? 'Receipts in' : calc.isOverdue(r) ? 'Receipts ' + calc.daysLate(r) + ' days overdue' : 'Receipts due within ' + calc.receiptDays + ' days', due ? sd(due) : '']);
    S.push([closed ? 'done' : 'todo', 'Closed', r.receipts_done ? sd(r.receipts_done) : '']);
  }
  return S;
}

function RequestView({ id }: { id: string }) {
  const { calc, run, me } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const [rc, setRc] = useState({ vendor: '', amount: '', date: calc.today });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!r) return <Modal title="Team Request"><div className="full empty">This request was deleted.</div></Modal>;
  const t = calc.team(r.team_id);
  const receipts = calc.receiptsFor(r.id);
  const openReceipts = calc.isOpenReceipts(r);
  const member = calc.requestorMember(r);

  const addReceipt = async () => {
    const a = num(rc.amount);
    if (!(a > 0)) { setErr('Enter the receipt amount.'); return; }
    setBusy(true); setErr(null);
    let path: string | null = null, name: string | null = null;
    if (file) {
      const up = await uploadFile('receipts/' + r.id, file);
      if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
      path = up.path; name = up.name;
    }
    const ok = await run(() => supabase().rpc('add_request_receipt', { p_request_id: r.id, p_vendor: orNull(rc.vendor), p_amount: a, p_date: rc.date || calc.today, p_file_name: name, p_file_path: path, p_by: me }), 'Receipt added');
    setBusy(false);
    if (ok === false) { await removeFiles([path]); return; }
    setRc({ vendor: '', amount: '', date: calc.today }); setFile(null);
  };
  const delReceipt = async (rid: string) => {
    const x = receipts.find((y) => y.id === rid);
    if (!x || !(await ui.confirm({ title: 'Delete Receipt', body: <>Delete the {money(x.amount)} receipt{x.vendor ? ' from ' + x.vendor : ''}?</>, ok: 'Delete', danger: true }))) return;
    const ok = await run(() => supabase().from('receipts').delete().eq('id', rid), 'Receipt deleted');
    if (ok !== false) await removeFiles([x.file_path]);
  };
  const complete = async () => {
    const left = calc.outstanding(r);
    const yes = await ui.confirm({
      title: 'Receipts Complete',
      body: <>{money(calc.receipted(r))} receipted of {money(r.amount)}.{left > 0 ? <> The unspent {money(left)} goes back into {calc.fundName(t?.fund_id)} and the request closes.</> : ' The request closes.'}</>,
      ok: 'Close Request',
    });
    if (!yes) return;
    await run(() => supabase().rpc('complete_request_receipts', { p_request_id: r.id, p_date: calc.today }), 'Request closed');
  };
  const del = async () => {
    const paid = calc.db.ledger.filter((l) => l.request_id === r.id).length;
    if (!(await ui.confirm({ title: 'Delete Request', body: <>Delete {r.id}, {forText(r)}? Its {receipts.length} receipts are deleted.{paid ? ` Its ${paid} ledger entries stay; delete them on the Ledger if the payment did not happen.` : ''}</>, ok: 'Delete', danger: true }))) return;
    const ok = await run(() => supabase().from('team_requests').delete().eq('id', r.id), 'Request deleted');
    if (ok !== false) { await removeFiles([...receipts.map((x) => x.file_path), r.receipt_path]); ui.close(); }
  };

  let act = null;
  if (calc.needsVote(r)) act = <button className="btn pri" onClick={() => ui.open(<ApproveForm id={r.id} />)}>Review Approval</button>;
  else if (r.status === 'Approved') act = <button className="btn pri" onClick={() => ui.open(<PayForm id={r.id} />)}>Mark Paid</button>;
  else if (openReceipts) act = <button className="btn pri" onClick={complete}>Receipts Complete</button>;

  return (
    <Modal wide title={r.id + ' · ' + forText(r)} foot={<>
      <span className="btnrow"><button className="btn dan" onClick={del}>Delete</button><button className="btn" onClick={() => ui.open(<RequestForm id={r.id} />)}>Edit</button></span>
      <span className="btnrow"><button className="btn" onClick={ui.close}>Close</button>{act}</span>
    </>}>
      <Kv k="Type"><TypeBadge r={r} /></Kv>
      <Kv k="Team">{t?.name}</Kv>
      <Kv k="Requestor">{requestor(r)}{member ? <> <span title="Cannot approve this request"><Badge>Board Member</Badge></span></> : null}{r.requestor_email ? <span className="muted"> · {r.requestor_email}</span> : null}</Kv>
      <Kv k="Amount">{money(r.amount)}</Kv>
      <Kv k="Category">{r.category}</Kv>
      {isR(r) ? <>
        <Kv k="Vendor">{r.vendor}</Kv>
        <Kv k="Purchase Date">{r.purchase_date ? date(r.purchase_date) : ''}</Kv>
        <Kv k="Receipt">{r.receipt_path ? <FileLink path={r.receipt_path} name={r.receipt_name} /> : ''}</Kv>
        <Kv k="Zelle">{r.zelle_contact}</Kv>
        {r.team_ledger_ref ? <Kv k="Team Ledger">{r.team_ledger_ref}</Kv> : null}
      </> : <>
        <Kv k="Purpose">{r.purpose}</Kv>
        <Kv k="Needed By">{r.needed_by ? date(r.needed_by) : ''}</Kv>
        <Kv k="Pay To">{(r.pay_to || '') + (r.vendor ? ' · ' + r.vendor : '')}</Kv>
      </>}
      <Kv k="Team Fund">{money(calc.fundBalance(t?.fund_id)) + ' balance'}</Kv>
      <Kv k="Approvals"><Approvals r={r} /></Kv>
      {r.paid_date ? <Kv k="Paid">{date(r.paid_date) + (r.pay_method ? ' · ' + r.pay_method : '') + (r.pay_ref ? ' · ' + r.pay_ref : '')}</Kv> : null}
      {r.created_by ? <Kv k="Entered By">{r.created_by}</Kv> : null}
      {r.notes ? <Kv k="Notes"><span className="wraptext">{r.notes}</span></Kv> : null}
      {!isR(r) && (openReceipts || r.status === 'Closed') ? <Kv k="Receipts">{money(calc.receipted(r)) + ' receipted · ' + money(r.returned || 0) + ' returned · ' + money(Math.max(0, calc.outstanding(r))) + ' outstanding'}</Kv> : null}
      {r.status === 'Declined' ? <div className="full sev red">Declined: {r.decline_reason}</div> : null}
      <Steps list={stepsFor(calc, r)} />
      {receipts.length || openReceipts ? (
        <div className="full scroll">
          <table className="subtable">
            <thead><tr><th className="nosort">Date</th><th className="nosort">Vendor</th><th className="nosort num">Amount</th><th className="nosort">File</th><th className="nosort">Added By</th><th className="nosort" /></tr></thead>
            <tbody>
              {receipts.map((x) => (
                <tr key={x.id}>
                  <td>{date(x.date)}</td><td>{x.vendor || '—'}</td><td className="num">{money(x.amount, true)}</td>
                  <td>{x.file_path ? <FileLink path={x.file_path} name={x.file_name} /> : <span className="muted">{x.file_name || 'No file'}</span>}</td>
                  <td>{x.uploaded_by || '—'}</td>
                  <td><button className="btn sm" onClick={() => delReceipt(x.id)}>Delete</button></td>
                </tr>
              ))}
              {openReceipts ? (
                <tr>
                  <td><DateIn value={rc.date} onChange={(v) => setRc({ ...rc, date: v })} /></td>
                  <td><Txt value={rc.vendor} onChange={(v) => setRc({ ...rc, vendor: v })} placeholder="Vendor and items" /></td>
                  <td><Amount value={rc.amount} onChange={(v) => setRc({ ...rc, amount: v })} /></td>
                  <td colSpan={2}><input className="in" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></td>
                  <td><button className="btn sm pri" onClick={addReceipt} disabled={busy}>{busy ? 'Adding…' : 'Add Receipt'}</button></td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      <Err msg={err} />
    </Modal>
  );
}

/** One board approval, or a decline with the reason the team sees. Mirrors approve_request() and decline_request(). */
function ApproveForm({ id }: { id: string }) {
  const { calc, run, user } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!r) return <Modal title="Approve Request"><div className="full empty">This request was deleted.</div></Modal>;
  const t = calc.team(r.team_id);
  const s = calc.db.settings;
  const got = calc.approvalsFor(r.id), n = calc.needed(r);
  const why = calc.cannotApprove(r, user.id, user.email);
  const bal = calc.fundBalance(t?.fund_id), after = round2(bal - r.amount);
  const late = calc.teamBlocked(r.team_id);
  const approve = async () => {
    const res = await run(() => supabase().rpc('approve_request', { p_request_id: r.id }));
    if (res === false) return;
    const o = res as { approvals: number; needed: number; status: string };
    ui.toast(o.status === 'Approved' ? 'Approved · ready to pay' : 'Approval ' + o.approvals + ' of ' + o.needed + ' recorded');
    ui.close();
  };
  const decline = async () => {
    if (!reason.trim()) { setErr('Give the team a reason for declining.'); return; }
    const ok = await run(() => supabase().rpc('decline_request', { p_request_id: r.id, p_reason: reason.trim() }), 'Declined · the team sees the reason');
    if (ok !== false) ui.close();
  };
  return (
    <Modal title="Approve Request" foot={<>
      <button className="btn" onClick={ui.close}>Cancel</button>
      <span className="btnrow">
        <button className="btn dan" onClick={decline}>Decline</button>
        {why ? <span className="dis" title={why}><button className="btn pri" disabled>Approve</button></span> : <button className="btn pri" onClick={approve}>Approve</button>}
      </span>
    </>}>
      <div className="full reqhead"><TypeBadge r={r} /><b>{t?.short}</b><span className="muted">·</span>{forText(r)}<span className="muted">·</span><b>{money(r.amount)}</b></div>
      <Kv k="Requestor">{requestor(r)}{calc.requestorMember(r) ? <> <Badge>Board Member</Badge></> : null}</Kv>
      {isR(r) ? <>
        <Kv k="Purchase Date">{r.purchase_date ? date(r.purchase_date) : ''}</Kv>
        <Kv k="Receipt">{r.receipt_path ? <FileLink path={r.receipt_path} name={r.receipt_name} /> : ''}</Kv>
        <Kv k="Pays To">{r.zelle_contact ? 'Zelle ' + r.zelle_contact : ''}</Kv>
      </> : <>
        <Kv k="Needed By">{r.needed_by ? date(r.needed_by) : ''}</Kv>
        <Kv k="Pays To">{r.pay_to}</Kv>
      </>}
      <Kv k="Team Balance">{money(bal) + ' now · ' + money(after) + ' after'}{after < 0 ? <> <span title="Approving takes this team below zero. A warning only."><Badge tone="red">Below Zero</Badge></span></> : null}</Kv>
      {late.length ? <div className="full sev red">{t?.short} has overdue receipts on {late.map((x) => x.id).join(', ')}.</div> : null}
      <Kv k="Approvals">
        <span className="appr">
          {got.map((a) => <div key={a.id}><span className="dot" style={{ background: 'var(--g)' }} />{a.approver_name}<span className="muted">{sd(a.approved_at.slice(0, 10))}</span></div>)}
          {got.length < n ? <div><span className="dot" style={{ background: 'var(--amb)' }} />{n - got.length} more needed <span className="muted">({got.length} of {n})</span>
            <span className="info" title={'Rule: up to ' + money(s.approval_threshold) + ' needs ' + s.approvals_under + ', over needs ' + s.approvals_over + '. The requestor never approves their own, and one board member cannot give two approvals.'}>?</span></div> : null}
        </span>
      </Kv>
      <Kv k="Reason If Declined"><Txt value={reason} onChange={setReason} placeholder="One line the team will see" /></Kv>
      {why ? <div className="full muted">{why}</div> : null}
      <Err msg={err} />
    </Modal>
  );
}

/** Records how a request was paid and writes its ledger row (mark_request_paid). */
function PayForm({ id }: { id: string }) {
  const { calc, run } = useData();
  const ui = useUI();
  const r = calc.request(id);
  const [method, setMethod] = useState<PayMethod>(r && isR(r) ? 'Zelle' : 'Check');
  const [when, setWhen] = useState(calc.today);
  const [ref, setRef] = useState('');
  if (!r) return <Modal title="Mark Paid"><div className="full empty">This request was deleted.</div></Modal>;
  const t = calc.team(r.team_id);
  const w = t?.fund_id ? calc.spendWarnings(t.fund_id, r.amount, 'Robotics Teams') : ['This team has no fund. Set one under Teams first.'];
  const save = async () => {
    const ok = await run(() => supabase().rpc('mark_request_paid', { p_request_id: r.id, p_date: when || calc.today, p_method: method, p_ref: orNull(ref) }),
      isR(r) ? 'Paid · ledger row written' : 'Paid · receipts due in ' + calc.receiptDays + ' days · ledger row written');
    if (ok !== false) ui.close();
  };
  const check = method === 'Check';
  return (
    <Modal title="Mark Paid" foot={<Foot onSave={save} saveLabel="Mark Paid" />}>
      <div className="full reqhead"><TypeBadge r={r} /><b>{t?.short}</b><span className="muted">·</span>{forText(r)}</div>
      <Kv k="Amount"><b>{money(r.amount)}</b></Kv>
      <Kv k="Pay To">{isR(r) ? requestor(r) + (r.zelle_contact ? ' · Zelle ' + r.zelle_contact : '') : (r.pay_to || '') + (r.vendor ? ' · ' + r.vendor : '')}</Kv>
      <Kv k="Method"><Seg value={method} options={[...PAY_METHODS]} onChange={setMethod} /></Kv>
      <Kv k="Date Paid"><DateIn value={when} onChange={setWhen} /></Kv>
      <Kv k={check ? 'Check Number' : 'Confirmation Number'}><Txt value={ref} onChange={setRef} placeholder={check ? 'e.g. 110' : method === 'Zelle' ? 'Zelle confirmation code' : 'Reference from the bank'} /></Kv>
      <div className="full muted">Saving writes an Out row to the Ledger: {money(-r.amount)} from {calc.fundName(t?.fund_id) || 'the team fund'}.{isR(r) ? '' : ' It also starts the ' + calc.receiptDays + '-day receipt clock.'}</div>
      <Warnings list={w} />
    </Modal>
  );
}

/** The dollar threshold and how many approvals each side of it needs (settings). */
function RulesForm() {
  const { db, run } = useData();
  const ui = useUI();
  const s = db.settings;
  const [t, setT] = useState(str(s.approval_threshold));
  const [under, setUnder] = useState(String(s.approvals_under) as '1' | '2');
  const [over, setOver] = useState(String(s.approvals_over) as '1' | '2' | '3');
  const [err, setErr] = useState<string | null>(null);
  const amt = num(t);
  const save = async () => {
    if (!(amt >= 0)) { setErr('Enter the threshold in dollars.'); return; }
    const ok = await run(() => supabase().from('settings').update({ approval_threshold: amt, approvals_under: +under, approvals_over: +over }).eq('id', 1), 'Approval rules saved');
    if (ok !== false) ui.close();
  };
  const ap = (n: string) => n + (n === '1' ? ' approval' : ' approvals');
  return (
    <Modal title="Approval Rules" foot={<Foot onSave={save} />}>
      <Kv k="Threshold"><Amount value={t} onChange={setT} placeholder="500.00" /></Kv>
      <Kv k="Up To Threshold"><Seg value={under} options={[['1', '1 Approval'], ['2', '2 Approvals']]} onChange={setUnder} /></Kv>
      <Kv k="Over Threshold"><Seg value={over} options={[['1', '1 Approval'], ['2', '2 Approvals'], ['3', '3 Approvals']]} onChange={setOver} /></Kv>
      <Kv k="Applies To">Pre-Approvals and Reimbursements<span className="info" title="One rule for both request types. Changing it applies to requests still waiting; finished approvals stand.">?</span></Kv>
      <Kv k="Always">Requestor excluded · one approval per member</Kv>
      <Kv k="Preview">{amt >= 0 ? 'Up to ' + money(amt) + ': ' + ap(under) + ' · over ' + money(amt) + ': ' + ap(over) : ''}</Kv>
      <Err msg={err} />
    </Modal>
  );
}

/** The board enters a request on a team's behalf. Overdue receipts and short funds warn; they never block. */
function RequestForm({ id }: { id?: string }) {
  const { db, calc, run, me } = useData();
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
      submitted: f.submitted || calc.today, status: f.status, notes: orNull(f.notes),
    };
    const ok = await run(() => (old ? supabase().from('team_requests').update(row).eq('id', old.id) : supabase().from('team_requests').insert({ ...row, created_by: me })), old ? 'Request saved' : 'Request entered · waiting for approval');
    if (ok === false) { if (file && path !== old?.receipt_path) await removeFiles([path]); return; }
    if (file && old?.receipt_path && old.receipt_path !== path) await removeFiles([old.receipt_path]);
    ui.close();
  };
  return (
    <Modal title={old ? 'Edit ' + old.id : 'New Request'} foot={<Foot onSave={save} saveLabel={old ? 'Save' : 'Submit To The Board'} />}>
      {!old ? <div className="full muted">Teams send requests from their Team Portal. Use this to enter one on a team&apos;s behalf.</div> : null}
      <Kv k="Type"><Seg value={f.type} options={[...REQUEST_TYPES]} onChange={(v) => set({ type: v })} /></Kv>
      <Kv k="Team"><Select value={f.team_id} onChange={(v) => set({ team_id: v })} options={db.teams.map((x) => [x.id, x.name])} /></Kv>
      <Kv k="Requestor"><Txt value={f.requestor_name} onChange={(v) => set({ requestor_name: v })} placeholder="Coach or treasurer's name" /></Kv>
      <Kv k="Requestor Email"><Txt value={f.requestor_email} onChange={(v) => set({ requestor_email: v })} placeholder="Used to stop them approving their own request" /></Kv>
      <Kv k="Amount"><Amount value={f.amount} onChange={(v) => set({ amount: v })} /></Kv>
      <Kv k="Category"><Select value={f.category} onChange={(v) => set({ category: v || REQUEST_CATEGORIES[0] })} options={REQUEST_CATEGORIES.map((c) => [c, c])} /></Kv>
      {R ? <>
        <Kv k="Vendor"><Txt value={f.vendor} onChange={(v) => set({ vendor: v })} /></Kv>
        <Kv k="Purchase Date"><DateIn value={f.purchase_date} onChange={(v) => set({ purchase_date: v })} /></Kv>
        <Kv k="Zelle Contact"><Txt value={f.zelle_contact} onChange={(v) => set({ zelle_contact: v })} placeholder="Phone or email for Zelle" /></Kv>
        <Kv k="Receipt">{old?.receipt_path && !file ? <><FileLink path={old.receipt_path} name={old.receipt_name} /> </> : null}<input className="in" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Kv>
        <Kv k="Notes"><Txt value={f.purpose} onChange={(v) => set({ purpose: v })} placeholder="What was bought (optional)" /></Kv>
      </> : <>
        <Kv k="Purpose"><Txt value={f.purpose} onChange={(v) => set({ purpose: v })} placeholder="What the money is for" /></Kv>
        <Kv k="Pay To"><Seg value={f.pay_to as (typeof PAY_TO)[number]} options={[...PAY_TO]} onChange={(v) => set({ pay_to: v })} /></Kv>
        {f.pay_to === PAY_TO[0] ? <Kv k="Vendor"><Txt value={f.vendor} onChange={(v) => set({ vendor: v })} /></Kv> : null}
        <Kv k="Needed By"><DateIn value={f.needed_by} onChange={(v) => set({ needed_by: v })} /></Kv>
      </>}
      <Kv k="Submitted"><DateIn value={f.submitted} onChange={(v) => set({ submitted: v })} /></Kv>
      {old ? <Kv k="Status"><Select value={f.status} onChange={(v) => set({ status: (v || 'Submitted') as TeamRequest['status'] })} options={REQUEST_STATUSES.map((s) => [s, s])} /><div className="muted" style={{ fontSize: 12 }}>Only for corrections. Approvals, payments and receipts set this themselves.</div></Kv> : null}
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
  const { db, calc, run } = useData();
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
      zeffy_name: orNull(f.zeffy_name), fund_id: f.newFund ? null : f.fund_id || null,
    };
    const sb = supabase();
    const res = await run(async () => {
      const t = old ? await sb.from('teams').update(row).eq('id', old.id).select('id').single() : await sb.from('teams').insert(row).select('id').single();
      if (t.error || !f.newFund) return t;
      const fund = await sb.from('funds').insert({ name: row.short + ' Team Fund', restricted: true, team_id: t.data.id, purpose: 'Restricted to ' + row.name }).select('id').single();
      if (fund.error) return fund;
      return sb.from('teams').update({ fund_id: fund.data.id }).eq('id', t.data.id);
    }, old ? 'Team saved' : 'Team added');
    if (res !== false) ui.close();
  };
  const del = async () => {
    if (!old) return;
    const n = calc.teamRequests(old.id).length;
    if (n) { setErr(`${old.short} has ${n} requests. Delete those first, or keep the team.`); return; }
    if (!(await ui.confirm({ title: 'Delete Team', body: <>Delete {old.name}? Its fund stays on the Ledger.</>, ok: 'Delete', danger: true }))) return;
    const ok = await run(() => supabase().from('teams').delete().eq('id', old.id), 'Team deleted');
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
        {!f.newFund ? <FundSelect value={f.fund_id} onChange={(v) => set({ fund_id: v })} blank="No fund" /> : null}
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
