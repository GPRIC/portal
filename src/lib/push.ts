// Phone alerts (0016_phone_alerts.sql): sends a notification to each registered phone. Server only.
// Uses the Web Push standard (web-push library), so no email service or app store is needed. Needs two settings on the
// server: NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (one pair, made once). With either missing it sends nothing.
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PushNote = { title: string; body: string; url: string; tag?: string };
type Target = { id: number; endpoint: string; p256dh: string; auth: string };

export function pushConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function setup(origin: string) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || origin, process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
}

async function sendTo(admin: SupabaseClient, targets: Target[], note: PushNote) {
  let sent = 0;
  for (const t of targets) {
    try {
      await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, JSON.stringify(note), { TTL: 60 * 60 * 24 });
      sent++;
      await admin.rpc('push_result', { p_id: t.id });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404 / 410: the phone uninstalled the app or turned notifications off; stop sending to it
      await admin.rpc('push_result', { p_id: t.id, p_error: 'Push ' + (code || '') + ' ' + (e instanceof Error ? e.message : ''), p_gone: code === 404 || code === 410 });
    }
  }
  return sent;
}

/** Pushes every reimbursement request not yet pushed. Each request is claimed once, so it never notifies twice. */
export async function pushPending(admin: SupabaseClient, origin: string): Promise<{ configured: boolean; sent: number }> {
  if (!pushConfigured()) return { configured: false, sent: 0 };
  setup(origin);
  const { data: rows, error } = await admin.rpc('push_claim');
  if (error) { console.error('push: claim failed', error.message); return { configured: true, sent: 0 }; }
  if (!rows?.length) return { configured: true, sent: 0 };
  const { data: targets } = await admin.rpc('push_targets', {});
  let sent = 0;
  for (const r of rows as { request_id: string; body: string; link: string }[]) {
    sent += await sendTo(admin, (targets ?? []) as Target[], { title: 'New Reimbursement Request', body: r.body, url: r.link || '/requests', tag: 'req-' + r.request_id });
  }
  return { configured: true, sent };
}

/** One test notification to one person's phones, right after they turn alerts on. */
export async function pushTest(admin: SupabaseClient, origin: string, userId: string): Promise<number> {
  if (!pushConfigured()) return 0;
  setup(origin);
  const { data: targets } = await admin.rpc('push_targets', { p_user: userId });
  return sendTo(admin, (targets ?? []) as Target[], { title: 'GPRIC Portal', body: 'Phone alerts are on. You will get one here for each new reimbursement request.', url: '/requests', tag: 'test' });
}
