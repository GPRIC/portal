'use client';
// The Team Portal page: balance cards, requests and reimbursements, gifts, and each request's steps and receipts.
import { useState, type ReactNode } from 'react';
import { Page } from '@/components/shell';
import { uploadFile } from '@/components/data';
import { Amount, DateIn, Err, FilePick, num, orNull, Txt } from '@/components/forms';
import { Badge, Card, Kv, Modal, St, Steps, Table, useUI, type Col } from '@/components/ui';
import { Tip } from '@/components/tips';
import { supabase } from '@/lib/supabase/client';
import { addDays, daysBetween, money, sd, sum } from '@/lib/format';
import { friendly, useTeam, type Gift, type Portal, type TeamReq } from './team-data';
import { approvalRule, NewRequest, RECEIPT_RULE, RequestForm, TypeBadge } from './team-forms';

const ICON: Record<'eye' | 'rcpt' | 'redo', ReactNode> = {
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  rcpt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 7h6M9 11h6M9 15h4" /></svg>,
  redo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>,
};

/* ---------- request rules ---------- */
const receiptsDue = (p: Portal, r: TeamReq) => (r.paid_date ? addDays(r.paid_date, p.rules.receipt_days) : null);
const daysLate = (p: Portal, r: TeamReq, today: string) => {
  const due = receiptsDue(p, r);
  return r.status === 'Receipts Due' && due ? daysBetween(due, today) : 0;
};
const what = (r: TeamReq) => (r.type === 'Reimbursement' ? r.vendor || r.purpose : r.purpose);
const when = (r: TeamReq) => (r.type === 'Reimbursement' ? r.purchase_date || r.submitted : r.submitted);

function StatusCell({ r }: { r: TeamReq }) {
  const { p, today } = useTeam();
  if (r.status === 'Submitted') {
    return (
      <span title={approvalRule(p) + ' ' + r.approvals + ' of ' + r.needed + ' so far.'}>
        <Badge tone="blu">Waiting On Board</Badge> <span className="muted">{r.approvals} of {r.needed} Approvals</span>
      </span>
    );
  }
  if (r.status === 'Approved') return <span title="Approved by the board; payment is on its way."><Badge tone="grn">Approved</Badge> <span className="muted">Not Yet Paid</span></span>;
  if (r.status === 'Paid') return <span title={'Paid' + (r.pay_method ? ' by ' + r.pay_method : '') + (r.paid_date ? ' on ' + sd(r.paid_date) : '')}><Badge tone="grn">Paid</Badge></span>;
  if (r.status === 'Receipts Due') {
    const due = receiptsDue(p, r), late = daysLate(p, r, today), left = Math.max(0, r.amount - r.receipts_total);
    return late > 0
      ? <span title={'Receipts were due ' + sd(due) + '. ' + money(left, true) + ' not yet receipted.'}><Badge tone="red">{late + ' Days Overdue'}</Badge></span>
      : <span title={money(r.receipts_total, true) + ' of ' + money(r.amount, true) + ' receipted so far.'}><Badge tone="amb">{'Receipts Due ' + sd(due)}</Badge></span>;
  }
  if (r.status === 'Declined') return <><Badge tone="red">Declined</Badge>{r.decline_reason ? <> <span className="muted">{r.decline_reason}</span></> : null}</>;
  return <St s={r.status} />;
}

/* ---------- the page ---------- */
export function TeamHome() {
  const { p, today } = useTeam();
  const ui = useUI();
  const open = (r: TeamReq) => ui.open(<RequestView id={r.id} />);
  const resubmit = (r: TeamReq) => ui.open(<RequestForm type={r.type} pre={prefillFrom(r)} />);
  const waiting = p.requests.filter((r) => r.status === 'Submitted');
  const late = p.requests.filter((r) => daysLate(p, r, today) > 0).sort((a, b) => daysLate(p, b, today) - daysLate(p, a, today));
  const blocked = p.overdue > 0 || late.length > 0;
  const m = p.money;

  const cols: Col<TeamReq>[] = [
    { k: 'id', label: 'Request' },
    { k: 'type', label: 'Type', html: (r) => <TypeBadge type={r.type} /> },
    { k: 'for', label: 'For', sv: (r) => what(r), html: (r) => <span className="req-for" title={what(r)} style={{ display: 'inline-block' }}>{what(r)}</span> },
    { k: 'category', label: 'Category' },
    { k: 'amount', label: 'Amount', num: true, html: (r) => money(r.amount, true) },
    { k: 'date', label: 'Date', sv: (r) => when(r), html: (r) => <span title={r.type === 'Reimbursement' ? 'Purchase date' : 'Submitted'}>{sd(when(r))}</span> },
    { k: 'status', label: 'Status', html: (r) => <StatusCell r={r} /> },
    { k: 'act', label: '', nosort: true, html: (r) => {
      const [icon, tip, go] = r.status === 'Declined' ? ['redo', 'Resubmit', () => resubmit(r)] as const
        : r.status === 'Receipts Due' ? ['rcpt', 'Add receipts', () => open(r)] as const
        : ['eye', 'Open', () => open(r)] as const;
      return <button type="button" className="ib" title={tip} aria-label={tip} onClick={go}>{ICON[icon]}</button>;
    } },
  ];
  const giftCols: Col<Gift>[] = [
    { k: 'date', label: 'Date', html: (g) => sd(g.date) },
    { k: 'donor', label: 'Donor' },
    { k: 'amount', label: 'Amount', num: true, html: (g) => money(g.amount, true) },
    { k: 'status', label: 'Status', sv: (g) => g.in_transit, html: (g) => (g.in_transit
      ? <span title="Zeffy payout upcoming; counted in your balance now"><Badge tone="amb">In Transit</Badge></span>
      : <Badge tone="grn">Received</Badge>) },
  ];

  const newBtn = blocked
    ? <span className="dis" title={'New requests are paused until receipts for ' + (late[0] ? late[0].id : 'your overdue pre-approvals') + ' are in.'}><button className="btn pri" disabled>New Request</button></span>
    : <button className="btn pri" onClick={() => ui.open(<NewRequest />)}>New Request</button>;

  const ln = (k: string, v: number) => <div className="ln"><span>{k}</span><b>{money(v, true)}</b></div>;
  const giftsSince = p.season_start ? p.gifts.filter((g) => g.date >= p.season_start!) : p.gifts;

  return (
    <Page title={p.team.name} help="team" actions={
      <Tip id="team.new" side="r" text="Start here to ask for money: a Pre-Approval before you buy, or a Reimbursement after.">{newBtn}</Tip>
    }>
      {blocked ? (
        <div className="banner red">
          <b>New requests paused</b>
          <span>
            {late[0]
              ? <>Receipts for {late[0].id} {late[0].purpose} were due {sd(receiptsDue(p, late[0]))}; {money(Math.max(0, late[0].amount - late[0].receipts_total), true)} is not yet receipted.{late.length > 1 ? ' ' + (late.length - 1) + ' more past due.' : ''}</>
              : <>A paid pre-approval is past its receipt deadline. Add those receipts first.</>}
          </span>
          <span className="sp" />
          {late[0] ? <button className="btn sm dan" onClick={() => open(late[0])}>Add Receipts</button> : null}
        </div>
      ) : null}

      <div className="cards">
        <Tip id="team.balance" text="What your team can spend right now. Hover any tile for the detail.">
          <Card n="Available Balance" v={money(m.balance, true)} tip={<>
            {ln('Carry-Over', m.carry)}{ln('Zeffy Gifts', m.zeffy)}{ln('Deposits', m.deposits)}{ln('Reimbursements', -m.reimbursements)}{ln('Direct Expenses', -m.direct)}
          </>} />
        </Tip>
        <Card n="Waiting On Board" v={money(sum(waiting, (r) => r.amount), true)} color={waiting.length ? 'blue' : undefined} tip={<>
          {waiting.length ? waiting.map((r) => <div key={r.id}>{what(r)} {money(r.amount, true)} · {r.approvals} of {r.needed} approvals</div>) : <div>Nothing is waiting on the board.</div>}
          <div style={{ marginTop: 6 }}>{approvalRule(p)}</div>
        </>} />
        <Card n="Raised This Season" v={money(p.raised, true)} tip={
          giftsSince.length + ' gift' + (giftsSince.length === 1 ? '' : 's') + ' to this team' + (p.season_start ? ' since ' + sd(p.season_start) : '') + '. Checks and other deposits count under Deposits in Available Balance.'
        } />
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="ph">
            <Tip id="team.requests" text="Every request and reimbursement, with where it stands. Click a row for its steps."><h2>Requests And Reimbursements</h2></Tip>
          </div>
          <Table cols={cols} rows={p.requests} sort="date" dir={-1} onRow={open} empty="No requests yet. New Request starts one." />
        </div>
        <div className="panel">
          <div className="ph">
            <h2>Gifts To The Team</h2><span className="sp" />
            <span className="muted" title="Zeffy gifts arrive automatically, assigned by the gift's Fund field. A blank Fund goes to GPRIC General.">From Zeffy</span>
          </div>
          <Table cols={giftCols} rows={p.gifts} sort="date" dir={-1} empty="No gifts yet." />
        </div>
      </div>
    </Page>
  );
}

function prefillFrom(r: TeamReq) {
  return { purpose: r.purpose, category: r.category, amount: r.amount, vendor: r.vendor, pay_to: r.pay_to, needed_by: r.needed_by, purchase_date: r.purchase_date };
}

/* ---------- one request ---------- */
function stepsFor(p: Portal, r: TeamReq, today: string): Parameters<typeof Steps>[0]['list'] {
  const list: Parameters<typeof Steps>[0]['list'] = [['done', 'Submitted with your certification', sd(r.submitted)]];
  if (r.status === 'Declined') { list.push(['no', 'Declined' + (r.decline_reason ? ': ' + r.decline_reason : ''), '']); return list; }
  if (r.status === 'Cancelled') { list.push(['no', 'Cancelled before payment; nothing was paid', '']); return list; }
  const past = r.status !== 'Submitted';
  for (let i = 0; i < r.needed; i++) {
    list.push([past || i < r.approvals ? 'done' : i === r.approvals ? 'now' : 'todo', 'Board approval ' + (i + 1) + ' of ' + r.needed, '']);
  }
  const paidLabel = r.type === 'Reimbursement'
    ? 'Paid back' + (r.pay_method ? ' by ' + r.pay_method : ' by Zelle')
    : 'Paid out' + (r.pay_to ? ' to ' + r.pay_to : '') + (r.pay_method ? ' by ' + r.pay_method : '');
  list.push([r.paid_date ? 'done' : r.status === 'Approved' ? 'now' : 'todo', paidLabel, r.paid_date ? sd(r.paid_date) : '']);
  if (r.type === 'Pre-Approval') {
    const due = receiptsDue(p, r);
    const inn = money(r.receipts_total, true) + ' of ' + money(r.amount, true) + ' in';
    if (r.status === 'Closed') list.push(['done', 'Receipts in · ' + inn, '']);
    else if (r.status === 'Receipts Due') list.push([daysLate(p, r, today) > 0 ? 'late' : 'now', 'Receipts due within ' + p.rules.receipt_days + ' days · ' + inn, due ? sd(due) : '']);
    else list.push(['todo', 'Receipts due within ' + p.rules.receipt_days + ' days of payment', '']);
  }
  return list;
}

function RequestView({ id }: { id: string }) {
  const ui = useUI();
  const { p, today, reload } = useTeam();
  const r = p.requests.find((x) => x.id === id);
  const [rc, setRc] = useState({ vendor: '', amount: '', date: today });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!r) return <Modal title="Request"><div className="full empty">This request is no longer here.</div></Modal>;
  const pre = r.type === 'Pre-Approval';
  const collecting = r.status === 'Receipts Due';

  const saveReceipt = async () => {
    const a = num(rc.amount);
    if (!(a >= 0) || rc.amount.trim() === '') { setErr('Enter the receipt amount.'); return; }
    if (!file) { setErr('Attach the itemized receipt.'); return; }
    setBusy(true); setErr(null);
    const up = await uploadFile('team/' + p.team.id, file);
    if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
    const { error } = await supabase().rpc('add_team_receipt', {
      p_request_id: r.id, p_vendor: orNull(rc.vendor), p_amount: a, p_date: rc.date || today, p_file_name: up.name, p_file_path: up.path,
    });
    setBusy(false);
    if (error) { setErr(friendly(error.message)); return; }
    setRc({ vendor: '', amount: '', date: today }); setFile(null);
    ui.toast('Receipt sent to the board');
    await reload();
  };
  const resubmit = () => { ui.close(); ui.open(<RequestForm type={r.type} pre={prefillFrom(r)} />); };

  let act: ReactNode = <span />;
  if (r.status === 'Declined') act = <button className="btn pri" onClick={resubmit}>Resubmit</button>;
  else if (collecting) act = <button className="btn pri" onClick={saveReceipt} disabled={busy}>{busy ? 'Saving…' : 'Save Receipt'}</button>;

  return (
    <Modal wide title={r.id + ' · ' + what(r)} foot={<><button className="btn" onClick={ui.close}>Close</button>{act}</>}>
      <Kv k="Type"><TypeBadge type={r.type} /></Kv>
      <Kv k={pre ? 'Purpose' : 'Vendor'}>{what(r)}</Kv>
      <Kv k="Category">{r.category}</Kv>
      <Kv k="Amount">{money(r.amount, true)}</Kv>
      <Kv k={pre ? 'Submitted' : 'Purchase Date'}>{sd(when(r))}</Kv>
      {pre && r.needed_by ? <Kv k="Needed By">{sd(r.needed_by)}</Kv> : null}
      {pre ? <Kv k="Pay To">{r.pay_to}</Kv> : null}
      {r.receipt_name ? <Kv k="Receipt">{r.receipt_name}</Kv> : null}
      {r.requestor_name ? <Kv k="Requested By">{r.requestor_name}</Kv> : null}
      {pre && (collecting || r.status === 'Closed') ? <Kv k="Receipts">{r.receipts + ' added · ' + money(r.receipts_total, true) + ' of ' + money(r.amount, true)}</Kv> : null}
      <Kv k="Status"><StatusCell r={r} /></Kv>
      <Steps list={stepsFor(p, r, today)} />
      {collecting ? (
        <>
          <div className="full muted" style={{ marginTop: 6 }}>Add Receipt <span className="info" title={RECEIPT_RULE}>?</span></div>
          <Kv k="Vendor"><Txt value={rc.vendor} onChange={(v) => setRc({ ...rc, vendor: v })} placeholder="e.g. AndyMark" /></Kv>
          <Kv k="Amount"><span style={{ display: 'inline-block', width: 160 }}><Amount value={rc.amount} onChange={(v) => setRc({ ...rc, amount: v })} /></span></Kv>
          <Kv k="Receipt Date"><span style={{ display: 'inline-block', width: 170 }}><DateIn value={rc.date} onChange={(v) => setRc({ ...rc, date: v })} /></span></Kv>
          <Kv k="File"><span title={RECEIPT_RULE} style={{ display: 'block' }}><FilePick file={file} onFile={setFile} accept="image/*,application/pdf" /></span></Kv>
        </>
      ) : null}
      <Err msg={err} />
    </Modal>
  );
}
