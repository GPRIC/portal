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
  return <BoardApp user={data.user}>{children}</BoardApp>;
}
