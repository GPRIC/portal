// Email alerts: sends what is already queued in email_outbox (0013_email_alerts.sql) and marks each row sent or failed.
// POST: fired and forgotten by the portal right after a team request or a direct expense is filed. Safe for anyone:
//       it takes no input, so a caller can never choose recipients or content, only hurry along what is queued.
// GET:  the daily Vercel cron (vercel.json) as a safety net, authorised by `Authorization: Bearer <CRON_SECRET>`.
// With no email key on the server (src/lib/email.ts) it is a no-op: rows stay queued and no attempt is counted.
// The sign-in proxy (src/proxy.ts) lets /api/alerts through for the cron, which carries no session cookie.
import type { NextRequest } from 'next/server';
import { adminSupabase } from '@/lib/supabase/admin';
import { emailConfigured, send } from '@/lib/email';
import { sameSecret } from '../../zeffy/zeffy-api';

export const maxDuration = 60;

type Row = { id: number; subject: string; body_text: string; link: string; to_emails: string[] };

function siteOrigin(request: NextRequest): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? 'https://' + prod : new URL(request.url).origin;
}

async function flush(request: NextRequest) {
  if (!emailConfigured()) return { configured: false, sent: 0, failed: 0 };
  const admin = adminSupabase();
  if (!admin) return { configured: false, sent: 0, failed: 0 };

  const { data, error } = await admin.rpc('email_outbox_claim', { p_limit: 20 });
  if (error) return { configured: true, sent: 0, failed: 0, error: error.message };
  const origin = siteOrigin(request);
  let sent = 0, failed = 0;
  for (const r of (data ?? []) as Row[]) {
    const res = await send({
      to: r.to_emails,
      subject: r.subject,
      text: r.body_text + '\n\nOpen Requests: ' + origin + (r.link || '/requests'),
    });
    if (res.ok) sent++; else failed++;
    await admin.rpc('email_outbox_done', { p_id: r.id, p_error: res.ok ? null : res.error });
  }
  return { configured: true, sent, failed };
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !sameSecret(request.headers.get('authorization'), `Bearer ${secret}`)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json(await flush(request));
}

export async function POST(request: NextRequest) {
  return Response.json(await flush(request));
}
