'use client';
// The board's Receipts tab (Documents > Receipts): every receipt on file and every paid item still missing one.
// Upload attaches the missing file (or adds the receipt); Remind flags the requester in the portal. No email is sent.
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { rpc, uploadFile, useData } from '@/components/data';
import { useUI } from '@/components/ui';
import { money, sd } from '@/lib/format';
import { receiptRows, type RcReq, type RcRow } from '@/lib/receipts';
import type { Calc } from '@/lib/calc';
import { ReceiptsList, ReceiptView, type ReceiptActions } from './receipts';

export function boardReceiptRows(calc: Calc): RcRow[] {
  const db = calc.db;
  const reqs: RcReq[] = db.team_requests.map((r) => ({
    id: r.id, type: r.type, purpose: r.purpose, status: r.status, amount: r.amount, vendor: r.vendor, paid_date: r.paid_date,
    submitted: r.submitted, purchase_date: r.purchase_date, requestor_name: r.requestor_name || r.created_by, receipt_path: r.receipt_path,
    receipt_name: r.receipt_name, pay_method: calc.paymentFor(r.id)?.pay_method || r.pay_method, pay_ref: calc.paymentFor(r.id)?.pay_ref || r.pay_ref,
    where: r.team_id ? calc.team(r.team_id)?.short || r.team_id : calc.fundName(r.charge_fund_id), whereKey: r.team_id || r.charge_fund_id || '',
  }));
  return receiptRows(reqs, db.receipts);
}

export function BoardReceipts({ q }: { q: string }) {
  const { calc } = useData();
  const ui = useUI();
  const rows = useMemo(() => boardReceiptRows(calc), [calc]);
  return <ReceiptsList rows={rows} q={q} today={calc.today} onOpen={(r) => ui.open(<BoardReceiptView id={r.id} />)} />;
}

/** The receipt modal on live board data (it re-reads after each save). */
function BoardReceiptView({ id }: { id: string }) {
  const { calc } = useData();
  const rows = useMemo(() => boardReceiptRows(calc), [calc]);
  const act = useBoardActions();
  const start = rows.find((r) => r.id === id);
  if (!start) return null;
  return <ReceiptView start={start} rows={rows} actions={act} />;
}

function useBoardActions() {
  const { calc, run, role, me } = useData();
  const ui = useUI();
  const router = useRouter();
  const canWrite = role === 'treasurer' || role === 'board' || role === 'bookkeeper';
  return (row: RcRow): ReceiptActions => {
    const r = calc.request(row.req.id);
    const rem = calc.db.receipt_reminders.filter((x) => x.request_id === row.req.id).sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? 1 : -1))[0];
    const rf = calc.refundFor(row.req.id);
    return {
      uploadBlock: canWrite ? null : 'Read only for your role.',
      newReceipt: !row.rc,
      save: async (file, vendor, amount) => {
        const up = await uploadFile(r?.team_id ? 'team/' + r.team_id + '/receipts' : 'requests/direct', file);
        if ('error' in up) return 'Upload failed: ' + up.error;
        const res = row.rc
          ? await run(() => rpc('receipt_attach', { p_id: row.rc!.id, p_file_name: up.name, p_file_path: up.path }), 'Receipt saved')
          : await run(() => rpc('add_request_receipt', { p_request_id: row.req.id, p_vendor: vendor || null, p_amount: amount, p_date: calc.today, p_file_name: up.name, p_file_path: up.path, p_by: me }), 'Receipt saved');
        return res === false ? 'Not saved.' : null;
      },
      remind: canWrite ? async () => { await run(() => rpc('receipt_remind', { p_request_id: row.req.id, p_note: null }), 'Reminder flagged in the portal · no email sent'); } : undefined,
      reminded: rem ? { at: rem.created_at || '', by: rem.by_name, note: rem.note } : null,
      openRequest: () => { ui.close(); router.push('/requests?id=' + encodeURIComponent(row.req.id)); },
      extra: <>
        {rf ? <><div className="k">Refund</div><div>{money(rf.amount, true)} · {rf.reason} · {sd(rf.date)}</div></> : null}
        {r?.status === 'Cancelled' ? <><div className="k">Cancelled</div><div>{r.cancel_reason || ''}{r.cancelled_at ? ' · ' + sd(r.cancelled_at.slice(0, 10)) : ''}</div></> : null}
      </>,
    };
  };
}
