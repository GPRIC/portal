import { NextResponse } from 'next/server';
import { serverSupabase } from '@/lib/supabase/server';
import { adminSupabase } from '@/lib/supabase/admin';

// A board member invites a coach or team treasurer. The team_invites row (written as the board member,
// under row security) tells the sign-up trigger which team the new login belongs to; the invite email
// itself needs the service key, so it is sent here on the server.
export async function POST(req: Request) {
  const sb = await serverSupabase();
  const { data: who } = await sb.rpc('whoami');
  if (who !== 'board') return NextResponse.json({ error: 'Board members only. Sign in again with your two-step code.' }, { status: 403 });

  const b = (await req.json().catch(() => null)) as { team_id?: string; email?: string; name?: string; role?: string } | null;
  const email = (b?.email || '').trim().toLowerCase();
  const role = b?.role === 'Treasurer' ? 'Treasurer' : 'Coach';
  if (!b?.team_id) return NextResponse.json({ error: 'Pick a team.' }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'Enter their email address.' }, { status: 400 });

  const admin = adminSupabase();
  if (!admin) return NextResponse.json({ error: 'Team invites need the Supabase service key set on the server (SUPABASE_SERVICE_ROLE_KEY).' }, { status: 503 });

  const { data: claims } = await sb.auth.getClaims();
  const ins = await sb.from('team_invites')
    .insert({ team_id: b.team_id, email, name: (b.name || '').trim() || null, role, invited_by: (claims?.claims?.email as string | undefined) || null })
    .select('id').single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });

  const origin = new URL(req.url).origin;
  const inv = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: origin + '/auth/callback?next=/login/password',
    data: { full_name: (b.name || '').trim() || undefined },
  });
  if (inv.error) {
    await sb.from('team_invites').delete().eq('id', ins.data.id);
    const taken = /already|registered|exists/i.test(inv.error.message);
    return NextResponse.json({ error: taken ? 'That email already has a portal login. It cannot be a team login as well.' : inv.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
