// Zeffy sync. GET: the Vercel cron (vercel.json), authorised by `Authorization: Bearer <CRON_SECRET>`.
// POST: the Sync Now button, for a signed-in board member with two-step done.
// Both pull every payment from the Zeffy API and upsert it with the service role (see ../zeffy-api.ts; the API shape is unverified).
// The sign-in proxy (src/proxy.ts) must let /api/zeffy through for the cron, which carries no session cookie.
import type { NextRequest } from 'next/server';
import { boardClaims, serverSupabase } from '@/lib/supabase/server';
import { sameSecret, syncZeffy } from '../zeffy-api';

export const maxDuration = 60;

function reply(r: Awaited<ReturnType<typeof syncZeffy>>) {
  return Response.json(r, { status: 'error' in r ? 502 : 200 });
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || !sameSecret(auth, `Bearer ${secret}`)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return reply(await syncZeffy());
}

export async function POST() {
  if (!(await boardClaims())) return Response.json({ error: 'Sign in with two-step first.' }, { status: 401 });
  const sb = await serverSupabase();
  const { data } = await sb.rpc('whoami');
  if (data !== 'board') return Response.json({ error: 'Board members only.' }, { status: 403 });
  return reply(await syncZeffy());
}
