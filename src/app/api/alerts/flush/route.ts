// Email alerts: sends what is already queued in email_outbox (0013_email_alerts.sql) and marks each row sent or failed.
// POST: fired and forgotten by the portal right after a team request or a direct expense is filed. Safe for anyone:
//       it takes no input, so a caller can never choose recipients or content, only hurry along what is queued.
// GET:  the daily Vercel cron (vercel.json) as a safety net, authorised by `Authorization: Bearer <CRON_SECRET>`.
// Only the cron counts a failed send against a row (five at most). The open POST takes only rows never tried and its
// failures count nothing, so calling it during an outage cannot use up a row's attempts. Neither passes back database
// or provider error text: the detail goes to the server log and stays on the row for the Treasurer.
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

async function flush(request: NextRequest, counted: boolean) {
  if (!emailConfigured()) return { configured: false, sent: 0, failed: 0 };
  const admin = adminSupabase();
  if (!admin) return { configured: false, sent: 0, failed: 0 };

  const { data, error } = await admin.rpc('email_outbox_claim', { p_limit: 20, p_counted: counted });
  if (error) {
    console.error('alerts flush: claim failed', error.message);
    return { configured: true, sent: 0, failed: 0, error: 'Alerts could not be sent right now.' };
  }
  const origin = siteOrigin(request);
  let sent = 0, failed = 0;
  for (const r of (data ?? []) as Row[]) {
    const res = await send({
      to: r.to_emails,
      subject: r.subject,
      text: r.body_text + '\n\nOpen Requests: ' + origin + (r.link || '/requests'),
    });
    if (res.ok) sent++; else failed++;
    const done = await admin.rpc('email_outbox_done', { p_id: r.id, p_error: res.ok ? null : res.error, p_counted: counted });
    if (done.error) console.error('alerts flush: marking row', r.id, 'failed', done.error.message);
  }
  return { configured: true, sent, failed };
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !sameSecret(request.headers.get('authorization'), `Bearer ${secret}`)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json(await flush(request, true));
}

export async function POST(request: NextRequest) {
  return Response.json(await flush(request, false));
}
