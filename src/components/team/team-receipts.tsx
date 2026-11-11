'use client';
// The Team Portal's Receipts page: this team's receipts only (team_portal() returns nothing of any other team), plus the
// direct expenses the board paid from the team's own fund. A coach uploads a missing receipt here; the board's reminders
// show on the item. Reminders are flagged in the portal only; nothing is emailed.
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { uploadFile } from '@/components/data';
import { useUI } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { money, sd } from '@/lib/format';
import { receiptRows, type RcReq, type RcRow } from '@/lib/receipts';
import { ReceiptsList, ReceiptView, receiptSummary, type ReceiptActions } from '@/components/receipts/receipts';
import { friendly, useTeam, type Portal } from './team-data';
import { RequestView } from './team-home';

export function teamReceiptRows(p: Portal): RcRow[] {
  const team = p.team.short || p.team.name;
  const reqs: RcReq[] = [
    ...p.requests.map((r) => ({
      id: r.id, type: r.type, purpose: r.purpose, status: r.status, amount: r.amount, vendor: r.vendor, paid_date: r.paid_date,
      submitted: r.submitted, purchase_date: r.purchase_date, requestor_name: r.requestor_name, receipt_path: r.receipt_path,
      receipt_name: r.receipt_name, pay_method: r.pay_method, where: team, whereKey: 'team',
    })),
    ...p.direct.map((r) => ({
      id: r.id, type: r.type, purpose: r.purpose, status: r.status, amount: r.amount, vendor: r.vendor, paid_date: r.paid_date,
      submitted: r.submitted, purchase_date: null, requestor_name: r.requestor_name, receipt_path: null, receipt_name: null,
      pay_method: r.pay_method, where: team + ' Fund', whereKey: 'fund',
    })),
  ];
  return receiptRows(reqs, [...p.requests, ...p.direct].flatMap((r) => r.receipt_list));
}

export function TeamReceipts() {
  const { p, today } = useTeam();
  const ui = useUI();
  const [q, setQ] = useState('');
  const rows = useMemo(() => teamReceiptRows(p), [p]);
  useEffect(() => { document.title = 'Receipts · GPRIC Team Portal'; }, []);
  return (
    <div className="wrap">
      <div className="hdr">
        <h1 title={receiptSummary(rows)}>Receipts</h1>
        <span className="sp" />
        <input className="in rq-srch" placeholder="Search vendor, request, person" value={q} onChange={(e) => setQ(e.target.value)} />
        <Link className="btn sm" href="/team">Back To Team Portal</Link>
      </div>
      <ReceiptsList rows={rows} q={q} coach today={today} onOpen={(r) => ui.open(<TeamReceiptView id={r.id} />)} />
    </div>
  );
}

function TeamReceiptView({ id }: { id: string }) {
  const { p, today, reload } = useTeam();
  const ui = useUI();
  const rows = useMemo(() => teamReceiptRows(p), [p]);
  const start = rows.find((r) => r.id === id);
  if (!start) return null;
  const mine = (path: string | null) => !!path && path.startsWith('team/' + p.team.id + '/');
  const actions = (row: RcRow): ReceiptActions => {
    const req = p.requests.find((r) => r.id === row.req.id);
    const de = p.direct.find((r) => r.id === row.req.id);
    const x = req || de;
    const open = !!req && req.type === 'Reimbursement' && req.status === 'Submitted' && req.approvals === 0;
    const block = de ? 'The board uploads this invoice.'
      : row.rc ? null
      : req && (req.status === 'Receipts Due' || open) ? null
      : 'Ask the board to add this receipt.';
    return {
      uploadBlock: block,
      newReceipt: !row.rc,
      canOpen: mine(row.file_path),
      save: async (file, vendor, amount) => {
        const up = await uploadFile('team/' + p.team.id, file);
        if ('error' in up) return 'Upload failed: ' + up.error;
        const { error } = row.rc
          ? await supabase().rpc('team_receipt_attach', { p_id: row.rc.id, p_file_name: up.name, p_file_path: up.path })
          : await supabase().rpc('add_team_receipt', { p_request_id: row.req.id, p_vendor: vendor || null, p_amount: amount, p_date: today, p_file_name: up.name, p_file_path: up.path });
        if (error) return friendly(error.message);
        ui.toast('Receipt sent to the board');
        await reload();
        return null;
      },
      reminded: x?.reminder || null,
      openRequest: req ? () => { ui.close(); ui.open(<RequestView id={req.id} />); } : undefined,
      extra: x ? <>
        {x.refund ? <><div className="k">Refund</div><div>{money(x.refund.amount, true)} · {x.refund.reason} · {sd(x.refund.date)}</div></> : null}
        {x.status === 'Cancelled' ? <><div className="k">Cancelled</div><div>{x.cancel_reason || ''}{x.cancelled_at ? ' · ' + sd(x.cancelled_at.slice(0, 10)) : ''}</div></> : null}
      </> : null,
    };
  };
  return <ReceiptView start={start} rows={rows} actions={actions} />;
}
