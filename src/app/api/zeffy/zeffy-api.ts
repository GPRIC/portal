// Server-only Zeffy API client for the scheduled sync and the webhook.
//
// NOT VERIFIED: written before GPRIC had a Zeffy API key, and the Zeffy API documentation could not be reached
// from the build machine. The endpoint (https://api.zeffy.com/api/v1/payments), bearer-key auth, paging and the
// payment field names are best guesses, so every read below is defensive: the list may arrive as an array or under
// data / payments / items / results; paging may be by next link, cursor or page number; each field is tried under
// several likely names. Check one real response against mapPayment() once the key is in place and trim the guesses.
import { adminSupabase } from '@/lib/supabase/admin';
import { zeffyKey, type ZeffyRow } from '@/lib/zeffy';

export const ZEFFY_URL = 'https://api.zeffy.com/api/v1/payments';
const PAGE = 100;
const MAX_PAGES = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** The first non-empty value among several dotted paths ("donor.first_name"). */
function pick(p: Obj, ...paths: string[]): unknown {
  for (const path of paths) {
    let v: unknown = p;
    for (const k of path.split('.')) v = isObj(v) ? v[k] : undefined;
    if (v != null && v !== '') return v;
  }
  return null;
}
const text = (v: unknown): string | null => (v == null || v === '' ? null : isObj(v) ? text(v.name ?? v.label ?? v.type ?? v.value) : String(v).trim() || null);
function num(v: unknown): number | null {
  if (isObj(v)) return num(v.value ?? v.amount);
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return isFinite(n) ? n : null;
}

/** An instant in America/New_York, as the export file shows it: date "YYYY-MM-DD" and time "HH:MM". */
function eastern(v: unknown): { date: string; time: string } | null {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  if (isNaN(+d)) {
    const m = String(v).match(/^(\d{4}-\d{2}-\d{2})$/);
    return m ? { date: m[1], time: '00:00' } : null;
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** One Zeffy API payment → the row zeffy_upsert takes, or null when it has no id, date or amount. */
export function mapPayment(p: Obj): ZeffyRow | null {
  const id = text(pick(p, 'id', 'payment_id', 'paymentId'));
  const when = eastern(pick(p, 'created_at', 'createdAt', 'payment_date', 'paymentDate', 'date', 'paid_at', 'paidAt'));
  const cents = num(pick(p, 'amount_cents', 'amountInCents', 'total_amount_cents'));
  let amount = cents != null ? cents / 100 : num(pick(p, 'total_amount', 'totalAmount', 'amount', 'total'));
  if (!id || !when || amount == null || amount <= 0) return null;
  amount = Math.round(amount * 100) / 100;
  const first = text(pick(p, 'first_name', 'firstName', 'donor.first_name', 'donor.firstName', 'buyer.first_name', 'buyer.firstName', 'payer.first_name', 'payer.firstName'));
  const last = text(pick(p, 'last_name', 'lastName', 'donor.last_name', 'donor.lastName', 'buyer.last_name', 'buyer.lastName', 'payer.last_name', 'payer.lastName'));
  const refund = num(pick(p, 'refund_amount', 'refundAmount', 'refunded_amount', 'refundedAmount', 'amount_refunded'));
  const refundCents = num(pick(p, 'refund_amount_cents', 'refundedAmountInCents'));
  const payout = eastern(pick(p, 'payout_date', 'payoutDate', 'payout.date', 'payout.paid_at', 'payout.arrival_date', 'transfer_date'));
  const rec = pick(p, 'recurring_status', 'recurringStatus', 'recurrence', 'frequency', 'subscription.status');
  const isRec = pick(p, 'is_recurring', 'isRecurring', 'recurring');
  return {
    id, key: zeffyKey(when.date, when.time, amount, last), date: when.date, amount,
    method: text(pick(p, 'payment_method', 'paymentMethod', 'method', 'payment_method_type')),
    status: text(pick(p, 'status', 'payment_status', 'paymentStatus')),
    payout_date: payout?.date ?? null,
    refund: refundCents != null ? refundCents / 100 : refund ?? 0,
    recurring: text(rec) ?? (isRec === true || isRec === 'true' ? 'Monthly' : null),
    fund: text(pick(p, 'fund', 'fund_name', 'fundName', 'designation', 'campaign_fund', 'answers.fund')),
    first, last,
    email: text(pick(p, 'email', 'donor.email', 'buyer.email', 'payer.email')),
    company: text(pick(p, 'company_name', 'companyName', 'company', 'donor.company_name', 'buyer.company_name')),
  };
}

/** Every payment the key can see, following whichever paging the response offers. */
export async function fetchPayments(apiKey: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let url: string | null = `${ZEFFY_URL}?limit=${PAGE}&page=1`;
  let page = 1;
  const seen = new Set<string>();
  for (let n = 0; url && n < MAX_PAGES; n++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`Zeffy API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body) ? body : isObj(body) ? (pick(body, 'data', 'payments', 'items', 'results', 'data.payments', 'data.items') as unknown) : null;
    const items = (Array.isArray(list) ? list : []).filter(isObj);
    let fresh = 0;
    for (const it of items) {
      const k = String(it.id ?? JSON.stringify(it));
      if (!seen.has(k)) { seen.add(k); out.push(it); fresh += 1; }
    }
    if (!items.length || !fresh) break;
    const meta = isObj(body) ? body : {};
    const next = text(pick(meta, 'next', 'next_url', 'links.next', 'pagination.next', 'meta.next'));
    const cursor = text(pick(meta, 'next_cursor', 'nextCursor', 'cursor.next', 'pagination.next_cursor', 'meta.next_cursor'));
    const more = pick(meta, 'has_more', 'hasMore', 'pagination.has_more');
    if (next) url = next.startsWith('http') ? next : new URL(next, ZEFFY_URL).toString();
    else if (cursor) url = `${ZEFFY_URL}?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`;
    else if (more === false || items.length < PAGE) url = null;
    else { page += 1; url = `${ZEFFY_URL}?limit=${PAGE}&page=${page}`; }
  }
  return out;
}

export type UpsertResult = { inserted: number; updated: number; skipped: number };

/** Logs a failed run so the Zeffy panel shows it (zeffy_upsert logs successful runs itself). */
export async function logFailure(source: 'api' | 'webhook', error: string) {
  const sb = adminSupabase();
  if (sb) await sb.from('zeffy_sync_log').insert({ source, error: error.slice(0, 1000) });
}

/** Upserts mapped rows with the service role. Throws on failure. */
export async function upsertRows(rows: ZeffyRow[], source: 'api' | 'webhook'): Promise<UpsertResult> {
  const sb = adminSupabase();
  if (!sb) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on the server');
  const { data, error } = await sb.rpc('zeffy_upsert', { p_rows: rows, p_source: source });
  if (error) throw new Error(error.message);
  return data as UpsertResult;
}

/** The full sync: every payment from the API into the portal. Failures are logged and returned, never thrown. */
export async function syncZeffy(): Promise<UpsertResult | { error: string }> {
  try {
    const key = process.env.ZEFFY_API_KEY;
    if (!key) throw new Error('ZEFFY_API_KEY is not set on the server');
    const raw = await fetchPayments(key);
    const rows = raw.map(mapPayment).filter((r): r is ZeffyRow => !!r);
    return await upsertRows(rows, 'api');
  } catch (e) {
    const msg = (e as Error).message || 'Zeffy sync failed';
    await logFailure('api', msg).catch(() => {});
    return { error: msg };
  }
}

/** Constant-time string compare for shared secrets. */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
