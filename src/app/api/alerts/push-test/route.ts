// Phone alerts: sends one test notification to the signed-in person's own phones, right after they turn alerts on.
// Needs a finished two-step sign-in; it can only ever reach the caller's own registered phones (push_targets by user).
import type { NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/supabase/admin';
import { boardClaims } from '@/lib/supabase/server';
import { pushConfigured, pushTest } from '@/lib/push';

export async function POST(request: NextRequest) {
  const claims = await boardClaims();
  if (!claims?.sub) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  if (!pushConfigured()) return Response.json({ configured: false, sent: 0 });
  const admin = adminSupabase();
  if (!admin) return Response.json({ configured: false, sent: 0 });
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const sent = await pushTest(admin, prod ? 'https://' + prod : new URL(request.url).origin, claims.sub);
  return Response.json({ configured: true, sent });
}
