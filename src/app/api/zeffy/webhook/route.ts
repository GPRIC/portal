// Zeffy webhook: one completed payment, pushed by Zeffy as it happens.
// Authorised by a shared secret (ZEFFY_WEBHOOK_SECRET) in the 'x-zeffy-secret' header or the ?secret= query.
// The event and payload shape are unverified (no Zeffy key or docs yet): the event name is read from type / event,
// and the payment from data.object, data, payment or the body itself. See ../zeffy-api.ts.
import type { NextRequest } from 'next/server';
import { logFailure, mapPayment, sameSecret, upsertRows } from '../zeffy-api';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export async function POST(request: NextRequest) {
  const secret = process.env.ZEFFY_WEBHOOK_SECRET;
  const given = request.headers.get('x-zeffy-secret') || request.nextUrl.searchParams.get('secret');
  if (!secret || !sameSecret(given, secret)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'Body is not JSON' }, { status: 400 }); }
  if (!isObj(body)) return Response.json({ error: 'Body is not an object' }, { status: 400 });

  const event = String(body.type ?? body.event ?? body.event_type ?? 'payment.completed');
  if (event !== 'payment.completed') return Response.json({ ignored: event });

  const data = body.data;
  const payment = isObj(data) && isObj(data.object) ? data.object : isObj(data) ? data : isObj(body.payment) ? body.payment : body;
  const row = mapPayment(payment);
  if (!row) {
    await logFailure('webhook', 'Webhook payment had no id, date or amount: ' + JSON.stringify(payment).slice(0, 400)).catch(() => {});
    return Response.json({ error: 'Payment not understood' }, { status: 422 });
  }
  try {
    return Response.json(await upsertRows([row], 'webhook'));
  } catch (e) {
    const msg = (e as Error).message || 'Webhook upsert failed';
    await logFailure('webhook', msg).catch(() => {});
    return Response.json({ error: msg }, { status: 500 });
  }
}
