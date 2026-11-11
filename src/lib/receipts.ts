// Receipts (P33, mockup #100): one row per receipt on file, plus one row per paid item still missing its receipt.
// Shared by the board's Documents > Receipts tab and the Team Portal's Receipts page, so both count "missing" the same way.
// The database's receipt_missing() (0011_receipts.sql) is the same rule; reminders are refused when it is false.

export type RcType = 'Pre-Approval' | 'Reimbursement' | 'Direct Expense';
/** The request a receipt belongs to, in the shape both sides can give. */
export type RcReq = {
  id: string; type: RcType; purpose: string; status: string; amount: number; vendor: string | null;
  paid_date: string | null; submitted: string | null; purchase_date: string | null; requestor_name: string | null;
  receipt_path: string | null; receipt_name: string | null; pay_method: string | null; pay_ref?: string | null;
  /** Team short name or fund name, and the key the Team Or Fund filter uses. */
  where: string; whereKey: string;
};
export type RcFile = {
  id: string; request_id: string; vendor: string | null; amount: number; date: string | null;
  file_name: string | null; file_path: string | null; uploaded_by: string | null; created_at?: string | null;
};
export type RcRow = {
  /** Unique per row: the receipt id, or "req:<request id>" for a request with no receipt row. */
  id: string; req: RcReq;
  /** The receipt on file; null when the request has no receipt at all (missing) or only the request's own file. */
  rc: RcFile | null;
  missing: boolean;
  /** Receipt date, or the date paid when missing. */
  date: string; vendor: string; amount: number;
  /** Uploaded by, or requested by when missing. */
  who: string;
  file_path: string | null; file_name: string | null;
};

const PAID = ['Paid', 'Receipts Due', 'Closed', 'Reviewed'];
/** Paid (or a direct expense, which the board already paid when it was filed). */
export const isPaid = (r: Pick<RcReq, 'status' | 'type'>) => PAID.includes(r.status) || (r.type === 'Direct Expense' && r.status === 'Submitted');
const paidOn = (r: RcReq) => r.paid_date || r.purchase_date || r.submitted || '';

export function receiptRows(reqs: RcReq[], files: RcFile[]): RcRow[] {
  const by = new Map<string, RcFile[]>();
  files.forEach((f) => { const a = by.get(f.request_id) || []; a.push(f); by.set(f.request_id, a); });
  const out: RcRow[] = [];
  for (const r of reqs) {
    if (r.status === 'Draft') continue;
    const fs = by.get(r.id) || [];
    for (const f of fs) {
      const missing = !f.file_path && isPaid(r);
      out.push({
        id: f.id, req: r, rc: f, missing, date: (missing ? paidOn(r) : f.date) || paidOn(r), vendor: f.vendor || r.vendor || r.purpose,
        amount: f.amount, who: (missing ? r.requestor_name : f.uploaded_by) || '', file_path: f.file_path, file_name: f.file_name,
      });
    }
    if (fs.length) continue;
    if (r.receipt_path) {
      // A reimbursement filed with one file on the request itself (before receipts were listed one by one).
      out.push({ id: 'req:' + r.id, req: r, rc: null, missing: false, date: r.purchase_date || r.submitted || '', vendor: r.vendor || r.purpose,
        amount: r.amount, who: r.requestor_name || '', file_path: r.receipt_path, file_name: r.receipt_name });
    } else if (isPaid(r) && r.status !== 'Closed') {
      out.push({ id: 'req:' + r.id, req: r, rc: null, missing: true, date: paidOn(r), vendor: r.vendor || r.purpose,
        amount: r.amount, who: r.requestor_name || '', file_path: null, file_name: null });
    }
  }
  return out;
}

/** The other receipts on the same request (the modal's "Invoices On This Request"). */
export const siblings = (rows: RcRow[], row: RcRow) => rows.filter((x) => x.req.id === row.req.id);

export const fileKind = (name: string | null | undefined) => {
  const n = (name || '').toLowerCase();
  return /\.pdf$/.test(n) ? 'PDF' : /\.(png)$/.test(n) ? 'PNG' : /\.(jpe?g|heic|webp|gif)$/.test(n) ? 'JPG' : 'FILE';
};
export const firstName = (s: string | null | undefined) => (s || '').trim().split(/\s+/)[0] || '';
