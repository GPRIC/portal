'use client';
// Phone Alerts button (Requests page header): turns on notifications on this phone for new reimbursement requests
// (0016_phone_alerts.sql, src/lib/push.ts). Shown to the Treasurer and the bookkeeper; the database only lets people on
// the alert list sign a phone up. On an iPhone the portal must first be added to the Home Screen and opened from there.
import { useEffect, useState } from 'react';
import { rpc, useData } from '@/components/data';
import { Modal, useUI } from '@/components/ui';

const KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function device(): string {
  const u = navigator.userAgent;
  return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Browser';
}

function HowTo() {
  const ui = useUI();
  return (
    <Modal view title="Phone Alerts" foot={<><span /><button className="btn" onClick={ui.close}>Close</button></>}>
      <div className="full helpsec">
        <h4>Get A Notification For Each Reimbursement Request</h4>
        <ol>
          <li>On your phone, open the portal and sign in.</li>
          <li>iPhone: tap Share, then Add to Home Screen. Android: tap the menu, then Install App or Add to Home Screen.</li>
          <li>Open GPRIC from your Home Screen and sign in once more.</li>
          <li>On the Requests page, tap Phone Alerts and allow notifications.</li>
        </ol>
        <p>A test notification arrives straight away. After that you get one each time a team files a reimbursement request; tap it to open Requests.</p>
      </div>
    </Modal>
  );
}

export function PhoneAlerts() {
  const { role } = useData();
  const ui = useUI();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const can = role === 'treasurer' || role === 'bookkeeper';

  useEffect(() => {
    if (!can || !supported()) return;
    navigator.serviceWorker.register('/sw.js')
      .then((r) => r.pushManager.getSubscription())
      .then((s) => setOn(Boolean(s) && Notification.permission === 'granted'))
      .catch(() => setOn(false));
  }, [can]);

  if (!can) return null;

  const turnOn = async () => {
    if (!supported()) { ui.open(<HowTo />); return; }
    if (!KEY) { ui.toast('Phone alerts are not set up on the server yet.', true); return; }
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') { ui.toast('Notifications are blocked for the portal in this phone\'s settings.', true); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY) }));
      const j = sub.toJSON();
      const r = await rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_device: device() });
      if (r.error) { await sub.unsubscribe().catch(() => {}); ui.toast(r.error.message.replace(/^Blocked:\s*/, ''), true); return; }
      setOn(true);
      await fetch('/api/alerts/push-test', { method: 'POST' }).catch(() => {});
      ui.toast('Phone alerts on. A test notification is on its way.');
    } catch (e) {
      ui.toast('Phone alerts could not be turned on: ' + ((e as Error).message || 'unknown error'), true);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await rpc('push_unsubscribe', { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setOn(false);
      ui.toast('Phone alerts off on this device.');
    } finally {
      setBusy(false);
    }
  };

  return on
    ? <button className="btn" disabled={busy} onClick={turnOff} title="This device gets a notification for each new reimbursement request. Click to turn it off.">Phone Alerts On</button>
    : <button className="btn" disabled={busy} onClick={turnOn} title="Get a notification on this phone for each new reimbursement request">Phone Alerts</button>;
}
