import { redirect } from 'next/navigation';
import { BoardApp } from '@/components/shell';
import { boardClaims, serverSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function BoardLayout({ children }: { children: React.ReactNode }) {
  const claims = await boardClaims();
  if (!claims) redirect('/login');
  const sb = await serverSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect('/login');
  // Team logins have their own portal; anyone else signed in sees no board data (row security) and is sent to sign in.
  const { data: side } = await sb.rpc('whoami');
  if (side === 'team') redirect('/team');
  // A self sign-up waiting for a board member (or declined) has no seat: show them where their request stands.
  // A turned-off seat is not sent there; it keeps the Access Off screen.
  if (side == null) {
    const { data: mine } = await sb.rpc('access_request_mine');
    const st = (mine as { status?: string } | null)?.status;
    if (st === 'Pending' || st === 'Declined') redirect('/pending');
  }
  return <BoardApp user={data.user}>{children}</BoardApp>;
}
