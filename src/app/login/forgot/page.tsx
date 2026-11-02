'use client';
import Link from 'next/link';
import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { AuthCard } from '../auth-card';

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + '/auth/callback?next=/login/password',
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSent(true);
  };

  return (
    <AuthCard title="Reset Your Password">
      {sent ? (
        <p>If that email has access to the portal, a reset link is on its way. Open it on this device.</p>
      ) : (
        <form onSubmit={submit}>
          <label>Email<input className="in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          {err ? <div className="err">{err}</div> : null}
          <button className="btn pri" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send Reset Link'}</button>
        </form>
      )}
      <p><Link className="doclink" href="/login">Back to sign in</Link></p>
    </AuthCard>
  );
}
