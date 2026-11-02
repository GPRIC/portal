// Zeffy payments in the shape public.zeffy_upsert takes, from an export file or the API.
// The export has no payment id, so a gift is keyed by date|HH:MM|amount|last name (lower case);
// zeffy_skip rows (loaded from the private load file) use the same key, so keep this format in step with zeffy_upsert in 0003_team_money.sql.

export type ZeffyRow = {
  id?: string; key: string; date: string; amount: number; method: string | null; status: string | null;
  payout_date: string | null; refund: number; recurring: string | null; fund: string | null;
  first: string | null; last: string | null; email: string | null; company: string | null;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "11/2/2026", "2026-11-02", a Date or an Excel date → "2026-11-02"; anything else → null. */
export function zeffyDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(+v) ? null : `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  return null;
}

/** "7:47 AM", "19:47" or a Date → "07:47" / "19:47". */
export function zeffyTime(v: unknown): string {
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return '00:00';
  let h = +m[1];
  const ap = m[3]?.toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${pad(h)}:${m[2]}`;
}

export function zeffyKey(date: string, time: string, amount: number, last: string | null): string {
  return `${date}|${time}|${amount.toFixed(2)}|${(last ?? '').trim().toLowerCase()}`;
}

const str = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const money = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Rows of a Zeffy "All payments" export (first row = headers) → upsert rows. Columns are found by name. */
export function zeffyRowsFromSheet(table: unknown[][]): ZeffyRow[] {
  const [head, ...body] = table;
  const col = (name: string) => (head ?? []).findIndex((h) => String(h ?? '').trim().toLowerCase().startsWith(name));
  const c = {
    date: col('payment date'), time: col('payment time'), amount: col('total amount'), method: col('payment method'),
    status: col('payment status'), payout: col('payout date'), refund: col('refund amount'), recurring: col('recurring status'),
    fund: col('fund'), first: col('first name'), last: col('last name'), email: col('email'), company: col('company name'),
  };
  if (c.date < 0 || c.amount < 0) throw new Error('This does not look like a Zeffy payments export (no Payment Date or Total Amount column).');
  const at = (r: unknown[], i: number) => (i < 0 ? null : r[i]);
  const out: ZeffyRow[] = [];
  for (const r of body) {
    const date = zeffyDate(at(r, c.date));
    const amount = money(at(r, c.amount));
    if (!date || amount <= 0) continue;
    const last = str(at(r, c.last));
    out.push({
      key: zeffyKey(date, zeffyTime(at(r, c.time)), amount, last), date, amount,
      method: str(at(r, c.method)), status: str(at(r, c.status)), payout_date: zeffyDate(at(r, c.payout)),
      refund: money(at(r, c.refund)), recurring: str(at(r, c.recurring)), fund: str(at(r, c.fund)),
      first: str(at(r, c.first)), last, email: str(at(r, c.email)), company: str(at(r, c.company)),
    });
  }
  return out;
}
