'use client';
// P34: the new address confirms an email change the Treasurer asked for. A button, not the page load, makes the switch,
// so an email scanner that opens the link cannot use it up.
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { AuthCard } from '../login/auth-card';

export default function ConfirmEmailPage() {
  return <Suspense fallback={<AuthCard title="Confirm Your Email"><p>Loading…</p></AuthCard>}><Confirm /></Suspense>;
}

function Confirm() {
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState<'ready' | 'busy' | 'done'>('ready');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setState('busy'); setErr(null);
    const r = await fetch('/api/email-change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; email?: string; error?: string };
    if (!r.ok || !j.ok) { setState('ready'); setErr(j.error || 'That did not work. Try again.'); return; }
    await supabase().auth.signOut();
    setEmail(j.email || '');
    setState('done');
  };
  return (
    <AuthCard title="Confirm Your Email">
      {state === 'done' ? (
        <>
          <p>Your GPRIC Portal sign-in is now {email}. Sign in with it and your same password and two-step code.</p>
          <Link className="btn pri" href="/login">Sign In</Link>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); go(); }}>
          <p>Confirm that this address is yours and should become your GPRIC Portal sign-in. Your role and history stay as they are.</p>
          {err ? <div className="err">{err}</div> : null}
          <button className="btn pri" type="submit" disabled={state === 'busy' || !token}>{state === 'busy' ? 'Confirming…' : 'Confirm'}</button>
        </form>
      )}
    </AuthCard>
  );
}
