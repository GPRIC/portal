import { NextResponse } from 'next/server';
import { serverSupabase } from '@/lib/supabase/server';
import { adminSupabase } from '@/lib/supabase/admin';

// The Treasurer adds a board member, bookkeeper or CPA (People page), or resends an invite to someone who never
// signed in. What the Treasurer picked is saved first (people_invite_save, as the Treasurer, so the database checks
// the role and logs it); the sign-up trigger reads it when the invite creates the login (0014_people.sql).
// The invite email itself needs the service key, so it is sent here on the server, like api/team-invite.
const ROLES = ['treasurer', 'board', 'bookkeeper', 'cpa'] as const;
type Body = { action?: 'invite' | 'resend'; email?: string; name?: string; role?: string; files_direct?: boolean };
type Person = { email: string; status: string; has_login: boolean };

/** The project's built-in mailer sends only a few emails an hour, so a failed send is said plainly. */
function sendFailed(msg: string, saved: boolean) {
  const kept = saved ? ' The person is saved on the list; use Resend Invite to try again.' : '';
  if (/rate limit|too many|429/i.test(msg)) {
    return 'The invite email did not go out: the portal\'s email sender has reached its limit of a few emails an hour.' + kept + ' Wait an hour first.';
  }
  return 'The invite email did not go out (' + msg.slice(0, 200) + ').' + kept;
}

export async function POST(req: Request) {
  const sb = await serverSupabase();
  // Checked by the database for the signed-in session (two-step, an access that is on, role treasurer).
  const { data: treasurer } = await sb.rpc('is_treasurer');
  if (treasurer !== true) return NextResponse.json({ error: 'Only the Treasurer can add people. Sign in again with your two-step code.' }, { status: 403 });

  const b = (await req.json().catch(() => null)) as Body | null;
  const email = (b?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'Enter their email address.' }, { status: 400 });
  const resend = b?.action === 'resend';

  const admin = adminSupabase();
  if (!admin) return NextResponse.json({ error: 'Invites need the Supabase service key set on the server (SUPABASE_SERVICE_ROLE_KEY).' }, { status: 503 });

  let name = (b?.name || '').trim();
  if (resend) {
    const { data, error } = await sb.rpc('people_list');
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    const p = ((data || []) as (Person & { name: string | null })[]).find((x) => x.email.toLowerCase() === email);
    if (!p) return NextResponse.json({ error: 'No one with that email is on the People list.' }, { status: 404 });
    if (p.status === 'off') return NextResponse.json({ error: 'Their access is off. Turn it on first.' }, { status: 400 });
    if (p.status === 'active') return NextResponse.json({ error: 'They have already signed in, so there is no invite to resend. If they lost their password, Forgot Password on the sign-in page resets it.' }, { status: 400 });
    name = p.name || name;
  } else {
    const role = ROLES.find((r) => r === b?.role);
    if (!role) return NextResponse.json({ error: 'Pick a role.' }, { status: 400 });
    const saved = await sb.rpc('people_invite_save', { p_email: email, p_name: name || null, p_role: role, p_files_direct: b?.files_direct === true });
    if (saved.error) return NextResponse.json({ error: saved.error.message }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  const inv = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: origin + '/auth/callback?next=/login/password',
    data: { full_name: name || undefined },
  });
  if (inv.error) {
    await sb.rpc('people_invite_sent', { p_email: email, p_error: inv.error.message });
    const taken = /already|registered|exists/i.test(inv.error.message);
    if (taken) {
      return NextResponse.json({
        error: resend
          ? 'They have already set up their login. Ask them to sign in; Forgot Password on the sign-in page resets a lost password.'
          : 'That email already has a login. Find them on the list, or if they are a coach, on the Requests page under Teams.',
      }, { status: 400 });
    }
    return NextResponse.json({ error: sendFailed(inv.error.message, true) }, { status: 502 });
  }
  await sb.rpc('people_invite_sent', { p_email: email, p_error: null });
  return NextResponse.json({ ok: true });
}
