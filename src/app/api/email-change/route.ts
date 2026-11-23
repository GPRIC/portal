import { NextResponse } from 'next/server';
import { adminSupabase } from '@/lib/supabase/admin';

// P34: the confirmation link the Treasurer's email change sends to the new address (0021_email_change.sql). Opening
// /confirm-email and pressing Confirm posts the token here; the server takes it once and switches the login's email.
// The seat, team login and board member record follow by themselves (follow_login_email).
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { token?: string } | null;
  const token = (b?.token || '').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: 'That link is not valid.' }, { status: 400 });
  const admin = adminSupabase();
  if (!admin) return NextResponse.json({ error: 'This needs the Supabase service key set on the server.' }, { status: 503 });
  const { data, error } = await admin.rpc('email_change_take', { p_token: token });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const c = data as { user_id: string; new_email: string };
  const up = await admin.auth.admin.updateUserById(c.user_id, { email: c.new_email, email_confirm: true });
  if (up.error) return NextResponse.json({ error: 'Your email could not be changed (' + up.error.message.slice(0, 200) + '). Ask the Treasurer for a new link.' }, { status: 502 });
  return NextResponse.json({ ok: true, email: c.new_email });
}
