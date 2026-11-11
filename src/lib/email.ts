// Sends one email. Server only: the key never reaches the browser.
// Uses Resend's HTTP API (no SDK) when RESEND_API_KEY and EMAIL_FROM are set on the server. With either missing it
// reports 'not configured' and sends nothing, so email alerts stay switched off until those settings exist.

export type Email = { to: string[]; subject: string; text: string };
export type SendResult = { ok: true; id?: string } | { ok: false; error: string; notConfigured?: boolean };

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function send(m: Email): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return { ok: false, error: 'not configured', notConfigured: true };
  if (!m.to.length) return { ok: false, error: 'No recipients' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body?.message || body?.name || res.statusText}` };
    return { ok: true, id: body?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
