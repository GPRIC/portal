import { redirect } from 'next/navigation';
import { TeamApp } from '@/components/team/team-shell';
import { boardClaims, serverSupabase } from '@/lib/supabase/server';
import './team.css';

export const dynamic = 'force-dynamic';

// The Team Portal: coaches and team treasurers, signed in with password and authenticator, see only their own team.
export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  const claims = await boardClaims();
  if (!claims) redirect('/login');
  const sb = await serverSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect('/login');
  const { data: side } = await sb.rpc('whoami');
  if (side === 'board') redirect('/dashboard');
  if (side !== 'team') redirect('/login');
  return <TeamApp user={data.user}>{children}</TeamApp>;
}
