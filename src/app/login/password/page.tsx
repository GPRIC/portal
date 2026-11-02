'use client';
// Choose a password: reached from an invite link or a password-reset link.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { AuthCard } from '../auth-card';

export default function PasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: u } = await sb.auth.getUser();
      if (!u.user) { router.replace('/login?error=' + encodeURIComponent('That link has expired. Ask for a new one.')); return; }
      // Someone who already has two-step must pass it before changing the password.
      const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') { router.replace('/login/two-step?next=/login/password'); return; }
      setEmail(u.user.email || '');
      setReady(true);
    })();
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (p1.length < 12) { setErr('Use at least 12 characters.'); return; }
    if (p1 !== p2) { setErr('The two passwords do not match.'); return; }
    setBusy(true);
    const { error } = await supabase().auth.updateUser({ password: p1 });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    router.replace('/login/two-step');
  };

  if (!ready) return <AuthCard title="Choose A Password"><p>Checking your link…</p></AuthCard>;
  return (
    <AuthCard title="Choose A Password">
      <p>Signing in as {email}. Save the password in Bitwarden. Next you will set up two-step sign-in.</p>
      <form onSubmit={submit}>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label>New Password<input className="in" type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} required /></label>
        <label>Type It Again<input className="in" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} required /></label>
        {err ? <div className="err">{err}</div> : null}
        <button className="btn pri" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save Password'}</button>
      </form>
    </AuthCard>
  );
}
