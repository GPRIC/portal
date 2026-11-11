'use client';
// Team Portal forms: the New Request chooser, the request form (Pre-Approval or Reimbursement), and Profile.
import { useState, type ReactNode } from 'react';
import { uploadFile } from '@/components/data';
import { Amount, DateIn, Err, FilePick, num, Select, Txt } from '@/components/forms';
import { Badge, Check, Kv, Modal, Seg, useUI } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { flushAlerts } from '@/lib/alerts';
import { money } from '@/lib/format';
import { PAY_TO, REQUEST_CATEGORIES } from '@/lib/types';
import { friendly, useTeam, type Portal, type TeamReq } from './team-data';

export type ReqType = TeamReq['type'];
export const RECEIPT_RULE = 'One itemized receipt showing every item and proof of payment. Bank or card statements are not accepted.';

export function TypeBadge({ type }: { type: ReqType }) {
  return type === 'Pre-Approval'
    ? <span title="Amount approved first, paid out, receipts due after payment"><Badge tone="vio">Pre-Approval</Badge></span>
    : <span title="Already bought; paid back by Zelle"><Badge tone="blu">Reimbursement</Badge></span>;
}

/** A small "?" that explains a field on hover. */
export function Info({ tip }: { tip: string }) {
  return <span className="info" title={tip} aria-label={tip}>?</span>;
}

/** A label with a hover explanation, then its field. */
function KvI({ k, tip, children }: { k: string; tip: string; children: ReactNode }) {
  return <><div className="k">{k}<Info tip={tip} /></div><div>{children}</div></>;
}

export function approvalRule(p: Portal) {
  const r = p.rules;
  return 'Up to ' + money(r.threshold) + ' needs ' + r.under + ' board approval' + (r.under === 1 ? '' : 's') + '; over ' + money(r.threshold) + ' needs ' + r.over + '.';
}

/** First step of New Request: pick the kind. */
export function NewRequest() {
  const ui = useUI();
  const { p } = useTeam();
  const pick = (t: ReqType) => { ui.close(); ui.open(<RequestForm type={t} />); };
  return (
    <Modal title="New Request" foot={<><button className="btn" onClick={ui.close}>Cancel</button><span /></>}>
      <div className="full choices">
        <button type="button" className="choice" onClick={() => pick('Pre-Approval')}
          title={'Get an amount approved now; GPRIC pays later and itemized receipts are due within ' + p.rules.receipt_days + ' days of payment.'}>
          <span><Badge tone="vio">Pre-Approval</Badge></span><span className="cv">Get an amount approved, paid later</span>
        </button>
        <button type="button" className="choice" onClick={() => pick('Reimbursement')}
          title="Already bought it: attach the itemized receipt and get paid back by Zelle.">
          <span><Badge tone="blu">Reimbursement</Badge></span><span className="cv">Already bought, paid back by Zelle</span>
        </button>
      </div>
    </Modal>
  );
}

export type Prefill = Partial<Pick<TeamReq, 'purpose' | 'category' | 'vendor' | 'pay_to' | 'needed_by' | 'purchase_date'>> & { amount?: number };

type RcIn = { vendor: string; amount: string; date: string; file: File | null };

export function RequestForm({ type: type0, pre }: { type: ReqType; pre?: Prefill }) {
  const ui = useUI();
  const { p, today, reload } = useTeam();
  const [type, setType] = useState<ReqType>(type0);
  const [f, setF] = useState(() => ({
    purpose: pre?.purpose || '', category: pre?.category || REQUEST_CATEGORIES[0], amount: pre?.amount ? String(pre.amount) : '',
    needed_by: pre?.needed_by || '', pay_to: pre?.pay_to || PAY_TO[0], purchase_date: pre?.purchase_date || today,
    vendor: pre?.vendor || '', zelle: p.me.zelle_contact || '', ledger: '',
  }));
  // A reimbursement lists each receipt; its total is their sum (the board sees the same receipts and cannot retype it).
  const [rows, setRows] = useState<RcIn[]>(() => [{ vendor: pre?.vendor || '', amount: pre?.amount ? String(pre.amount) : '', date: pre?.purchase_date || today, file: null }]);
  const setRow = (i: number, x: Partial<RcIn>) => setRows((o) => o.map((r, k) => (k === i ? { ...r, ...x } : r)));
  const total = Math.round(rows.reduce((t, r) => t + (num(r.amount) > 0 ? num(r.amount) : 0), 0) * 100) / 100;
  const [cert, setCert] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (x: Partial<typeof f>) => setF((o) => ({ ...o, ...x }));
  const pre1 = type === 'Pre-Approval';
  const certTip = 'Submitting with this box ticked is the coach confirmation; there is no separate sign-off step.';

  const submit = async () => {
    setErr(null);
    const a = pre1 ? num(f.amount) : total;
    if (pre1) {
      if (!(a > 0)) { setErr('Enter the amount.'); return; }
      if (!f.purpose.trim()) { setErr('Say what the money is for.'); return; }
    } else {
      for (let i = 0; i < rows.length; i++) {
        const n = rows.length > 1 ? ' on receipt ' + (i + 1) : '';
        if (!rows[i].vendor.trim()) { setErr('Enter the vendor' + n + '.'); return; }
        if (!(num(rows[i].amount) > 0)) { setErr('Enter the amount' + n + '.'); return; }
        if (!rows[i].file) { setErr('Attach the itemized receipt' + n + '.'); return; }
      }
      if (!f.zelle.trim()) { setErr('Add the Zelle contact to pay you.'); return; }
    }
    if (!cert) { setErr('Tick the certification to submit.'); return; }
    setBusy(true);
    const receipts: { vendor: string; amount: number; date: string; file_name: string; file_path: string }[] = [];
    if (!pre1) {
      for (const r of rows) {
        const up = await uploadFile('team/' + p.team.id, r.file as File);
        if ('error' in up) { setBusy(false); setErr('Upload failed: ' + up.error); return; }
        receipts.push({ vendor: r.vendor.trim(), amount: num(r.amount), date: r.date || today, file_name: up.name, file_path: up.path });
      }
    }
    const vendors = [...new Set(receipts.map((r) => r.vendor))].join(', ');
    const first = receipts.map((r) => r.date).sort()[0] || today;
    const body = pre1
      ? { type, purpose: f.purpose.trim(), category: f.category, amount: a, needed_by: f.needed_by || null, pay_to: f.pay_to,
          zelle_contact: f.pay_to === 'Me by Zelle' ? f.zelle.trim() || null : null, certified: true }
      : { type, purpose: vendors, category: f.category, amount: a, purchase_date: first,
          zelle_contact: f.zelle.trim(), team_ledger_ref: f.ledger.trim() || null, receipts, certified: true };
    const { data, error } = await supabase().rpc('submit_team_request', { p: body });
    setBusy(false);
    if (error) { setErr(friendly(error.message)); return; }
    flushAlerts();
    ui.close();
    ui.toast('Submitted' + (data ? ' ' + data : '') + ' · it is with the board');
    await reload();
  };

  const amountField = (
    <KvI k="Amount" tip={approvalRule(p)}>
      <span style={{ display: 'inline-block', width: 160 }}><Amount value={f.amount} onChange={(v) => set({ amount: v })} /></span>
    </KvI>
  );
  const category = <Kv k="Category"><Select value={f.category} onChange={(v) => set({ category: v || REQUEST_CATEGORIES[0] })} options={REQUEST_CATEGORIES.map((c) => [c, c])} /></Kv>;

  return (
    <Modal title="New Request" foot={<>
      <button className="btn" onClick={ui.close}>Cancel</button>
      <span className={cert ? '' : 'dis'} title={cert ? undefined : 'Tick the certification to submit'}>
        <button className="btn pri" onClick={submit} disabled={!cert || busy}>{busy ? 'Submitting…' : 'Submit'}</button>
      </span>
    </>}>
      <Kv k="Type"><Seg value={type} options={['Pre-Approval', 'Reimbursement']} onChange={setType} /></Kv>
      {pre1 ? (
        <>
          <KvI k="Purpose" tip="What the money is for, in a line the board can read at a glance.">
            <Txt value={f.purpose} onChange={(v) => set({ purpose: v })} placeholder="e.g. Field tiles for the practice field" />
          </KvI>
          {category}
          {amountField}
          <Kv k="Needed By"><span style={{ display: 'inline-block', width: 170 }}><DateIn value={f.needed_by} onChange={(v) => set({ needed_by: v })} /></span></Kv>
          <KvI k="Pay To" tip={'Who GPRIC pays once approved. Receipts for the full amount are due within ' + p.rules.receipt_days + ' days of payment.'}>
            <Select value={f.pay_to} onChange={(v) => set({ pay_to: v || PAY_TO[0] })}
              options={PAY_TO.map((x) => [x, x === 'Me by Zelle' && p.me.zelle_contact ? 'Me by Zelle (' + p.me.zelle_contact + ')' : x])} />
          </KvI>
          {f.pay_to === 'Me by Zelle' && !p.me.zelle_contact ? (
            <KvI k="Zelle Contact" tip="The phone number or email your Zelle account uses. Save it under Profile to fill it in next time.">
              <Txt value={f.zelle} onChange={(v) => set({ zelle: v })} placeholder="Phone or email" />
            </KvI>
          ) : null}
        </>
      ) : (
        <>
          {category}
          {rows.map((r, i) => (
            <div key={i} className="full" style={{ border: '1px solid var(--bs)', borderRadius: 'var(--r)', padding: '8px 10px', display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="muted">Receipt {rows.length > 1 ? i + 1 : ''} <span className="info" title={RECEIPT_RULE}>?</span></span>
                <span style={{ flex: 1 }} />
                {rows.length > 1 ? <button className="btn sm" onClick={() => setRows((o) => o.filter((_, k) => k !== i))}>Remove</button> : null}
              </div>
              <Txt value={r.vendor} onChange={(v) => setRow(i, { vendor: v })} placeholder="Vendor, e.g. AndyMark, REV Robotics, Home Depot" />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ width: 150 }}><Amount value={r.amount} onChange={(v) => setRow(i, { amount: v })} /></span>
                <span style={{ width: 170 }} title="Purchase date on the receipt"><DateIn value={r.date} onChange={(v) => setRow(i, { date: v })} /></span>
              </div>
              <FilePick file={r.file} onFile={(x) => setRow(i, { file: x })} accept="image/*,application/pdf" />
            </div>
          ))}
          <div className="full"><button className="btn sm" onClick={() => setRows((o) => [...o, { vendor: '', amount: '', date: today, file: null }])}>+ Add Receipt</button></div>
          <KvI k="Total" tip={approvalRule(p) + ' The total is the sum of your receipts.'}>
            <b>{money(total, true)}</b>{rows.length > 1 ? <span className="muted"> · {rows.length} receipts</span> : null}
          </KvI>
          <KvI k="Zelle Contact" tip="From your profile. Change it under Profile to keep it for next time.">
            <Txt value={f.zelle} onChange={(v) => set({ zelle: v })} placeholder="Phone or email" />
          </KvI>
          <KvI k="Team Ledger" tip="Optional: the line in your team's own ledger, e.g. Line 8.">
            <Txt value={f.ledger} onChange={(v) => set({ ledger: v })} placeholder="Optional" />
          </KvI>
        </>
      )}
      <div className="full" title={certTip}>
        <Check checked={cert} onChange={setCert}>{pre1 ? 'I certify this spending is for team activities' : 'I certify this purchase was made for team activities'}</Check>
      </div>
      <Err msg={err} />
    </Modal>
  );
}

export function ProfileForm() {
  const ui = useUI();
  const { p, reload } = useTeam();
  const [name, setName] = useState(p.me.name || '');
  const [zelle, setZelle] = useState(p.me.zelle_contact || '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { setErr('Enter your name.'); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc('update_my_profile', { p_name: name.trim(), p_zelle: zelle.trim() || null });
    setBusy(false);
    if (error) { setErr(friendly(error.message)); return; }
    ui.close();
    ui.toast('Profile saved');
    await reload();
  };
  return (
    <Modal title="Profile" foot={<>
      <span />
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Cancel</button>
        <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </span>
    </>}>
      <Kv k="Team">{p.team.name}</Kv>
      <Kv k="Email">{p.me.email}</Kv>
      <Kv k="Role">{p.me.role}</Kv>
      <Kv k="Name"><Txt value={name} onChange={setName} /></Kv>
      <KvI k="Zelle Contact" tip="The phone number or email your Zelle account uses. Reimbursements are paid here.">
        <Txt value={zelle} onChange={setZelle} placeholder="Phone or email" />
      </KvI>
      <Err msg={err} />
    </Modal>
  );
}
