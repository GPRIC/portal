'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { AuthCard } from './auth-card';

export default function LoginPage() {
  return <Suspense fallback={<AuthCard title="Sign In"><p>Loading…</p></AuthCard>}><Login /></Suspense>;
}

function Login() {
  const router = useRouter();
  const q = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // An invite or reset link that arrives with the session in the address (#access_token=...).
    const h = new URLSearchParams(window.location.hash.slice(1));
    if (h.get('error_description')) { router.replace('/login?error=' + encodeURIComponent(h.get('error_description')!)); return; }
    const at = h.get('access_token'), rt = h.get('refresh_token');
    if (at && rt) {
      const type = h.get('type');
      history.replaceState(null, '', window.location.pathname);
      supabase().auth.setSession({ access_token: at, refresh_token: rt }).then(({ error }) => {
        if (error) { setErr(error.message); return; }
        router.replace(type === 'invite' || type === 'recovery' || type === 'signup' ? '/login/password' : '/login/two-step');
      });
    }
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setErr(error.message === 'Invalid login credentials' ? 'That email and password do not match.' : error.message); return; }
    const next = q.get('next');
    router.replace('/login/two-step' + (next ? '?next=' + encodeURIComponent(next) : ''));
  };

  const shown = err || q.get('error');
  return (
    <AuthCard title="Sign In">
      <p>For GPRIC board members. Access is by invitation only.</p>
      <form onSubmit={submit}>
        <label>Email<input className="in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input className="in" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {shown ? <div className="err">{shown}</div> : null}
        <button className="btn pri" type="submit" disabled={busy}>{busy ? 'Signing In…' : 'Sign In'}</button>
        <Link className="doclink" href="/login/forgot">Forgot your password?</Link>
      </form>
    </AuthCard>
  );
}
