'use client';
// Waiting For Approval (P33): a person who asked for access and has no seat yet. Sent here by the board layout.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { AuthCard } from '../login/auth-card';

type Mine = { status: 'Pending' | 'Approved' | 'Declined'; name: string; team: string | null; kind: 'team' | 'board'; decline_reason: string | null };

export default function PendingPage() {
  const router = useRouter();
  const [mine, setMine] = useState<Mine | null | undefined>(undefined);

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: side } = await sb.rpc('whoami');
      if (side === 'board' || side === 'team') { router.replace(side === 'team' ? '/team' : '/dashboard'); return; }
      const { data } = await sb.rpc('access_request_mine');
      setMine((data as Mine | null) ?? null);
    })();
  }, [router]);

  const signOut = async () => { await supabase().auth.signOut(); router.replace('/login'); };
  const declined = mine?.status === 'Declined';

  return (
    <AuthCard title={declined ? 'Request Declined' : 'Waiting For Approval'}>
      {mine === undefined ? <p>Checking…</p> : null}
      {mine === null ? <p>This login has no portal access and no request on file. Ask the Treasurer or a board member for an invite.</p> : null}
      {mine ? (
        <>
          <div className="kvs">
            <div><span className="muted">Name</span> {mine.name}</div>
            <div><span className="muted">Asked For</span> {mine.kind === 'team' ? 'Team Member' + (mine.team ? ' · ' + mine.team : '') : 'Board Or Staff'}</div>
            <div><span className="muted">Status</span> {mine.status}</div>
            {declined && mine.decline_reason ? <div><span className="muted">Reason</span> {mine.decline_reason}</div> : null}
          </div>
          <p>{declined
            ? 'If you think this is a mistake, contact a board member.'
            : 'A board member reviews new requests. You will get an email when it is decided.'}</p>
        </>
      ) : null}
      <form onSubmit={(e) => e.preventDefault()}>
        {mine?.status === 'Pending' ? <button className="btn" type="button" onClick={() => window.location.reload()}>Check Again</button> : null}
        <button className="btn ghost" type="button" onClick={signOut}>Sign Out</button>
      </form>
    </AuthCard>
  );
}
