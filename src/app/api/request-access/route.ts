import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { adminSupabase } from '@/lib/supabase/admin';
import { SUPABASE_KEY, SUPABASE_URL } from '@/lib/supabase/env';

// Request Access (P33, 0020_request_access.sql). Anyone can ask for a portal account. The login is made here with the
// service key (no confirmation email: the portal's built-in mailer sends only a few an hour), then the request is filed
// as that new login, so the database checks it and writes History. A login made here has no seat and no team: every
// read and write is refused until a board member approves on the People page. If the request cannot be filed, the
// login is removed again so the person can correct the form and try once more.
type Body = { email?: string; password?: string; name?: string; phone?: string; zelle?: string; kind?: string; team_id?: string; team_other?: string; invite?: string };

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Body | null;
  const email = (b?.email || '').trim().toLowerCase();
  const password = b?.password || '';
  const name = (b?.name || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'Enter your email address.' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'Enter your full name.' }, { status: 400 });
  if (password.length < 10) return NextResponse.json({ error: 'Choose a password of at least 10 characters.' }, { status: 400 });
  if (b?.kind !== 'team' && b?.kind !== 'board') return NextResponse.json({ error: 'Pick Team Member or Board Or Staff.' }, { status: 400 });
  if (b.kind === 'team' && !(b.zelle || '').trim()) return NextResponse.json({ error: 'Enter the Zelle email or phone that reimbursements are paid to.' }, { status: 400 });
  if (b.kind === 'team' && !(b.team_id || '').trim() && !(b.team_other || '').trim()) return NextResponse.json({ error: 'Choose your team.' }, { status: 400 });

  const admin = adminSupabase();
  if (!admin) return NextResponse.json({ error: 'Sign-up needs the Supabase service key set on the server (SUPABASE_SERVICE_ROLE_KEY).' }, { status: 503 });

  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (made.error || !made.data.user) {
    const msg = made.error?.message || 'unknown error';
    if (/already|registered|exists/i.test(msg)) {
      return NextResponse.json({ error: 'That email already has a portal login. Sign in instead; Forgot Password on the sign-in page resets a lost password.' }, { status: 400 });
    }
    if (/password/i.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
    return NextResponse.json({ error: 'Your account could not be made (' + msg.slice(0, 200) + ').' }, { status: 502 });
  }
  const uid = made.data.user.id;

  // File the request as the new login, so the database's own checks and History apply.
  const as = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await as.auth.signInWithPassword({ email, password });
  let error = signed.error?.message || null;
  if (!error) {
    const filed = await as.rpc('access_request_submit', {
      p: { kind: b.kind, name, phone: b.phone || null, zelle: b.zelle || null, team_id: b.team_id || null, team_other: b.team_other || null, invite: b.invite || null },
    });
    error = filed.error?.message || null;
    await as.auth.signOut();
  }
  if (error) {
    await admin.auth.admin.deleteUser(uid);
    return NextResponse.json({ error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
