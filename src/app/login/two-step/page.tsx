'use client';
// Second sign-in step. First visit: set up an authenticator app (scan the code, enter one code).
// Later visits: enter the 6-digit code from the app.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { AuthCard, safeNext } from '../auth-card';

type Enroll = { id: string; qr: string; secret: string };

export default function TwoStepPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'loading' | 'verify' | 'enroll'>('loading');
  const [factorId, setFactorId] = useState('');
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: u } = await sb.auth.getUser();
      if (!u.user) { router.replace('/login'); return; }
      const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === 'aal2') { done(); return; }
      const { data: f, error } = await sb.auth.mfa.listFactors();
      if (error) { setErr(error.message); return; }
      const verified = f.totp.find((x) => x.status === 'verified');
      if (verified) { setFactorId(verified.id); setMode('verify'); return; }
      // Clear any half-finished setup, then start a fresh one.
      for (const x of f.all.filter((x) => x.factor_type === 'totp' && x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: x.id });
      const { data: e, error: ee } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator ' + new Date().toISOString().slice(0, 10) });
      if (ee || !e) { setErr(ee?.message || 'Could not start two-step setup.'); return; }
      setFactorId(e.id);
      setEnroll({ id: e.id, qr: e.totp.qr_code, secret: e.totp.secret });
      setMode('enroll');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function done() {
    const next = new URLSearchParams(window.location.search).get('next');
    router.replace(safeNext(next));
    router.refresh();
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase().auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') });
    setBusy(false);
    if (error) { setErr(error.message.includes('Invalid') ? 'That code did not match. Use the newest code in your app.' : error.message); return; }
    done();
  };
  const signOut = async () => { await supabase().auth.signOut(); router.replace('/login'); };

  return (
    <AuthCard title={mode === 'enroll' ? 'Set Up Two-Step Sign-In' : 'Two-Step Sign-In'}>
      {mode === 'loading' ? <p>{err || 'Checking…'}</p> : null}
      {mode === 'enroll' && enroll ? (
        <>
          <p>Open an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, Authy or Bitwarden), add an account, and scan this code.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr" src={enroll.qr} alt="Authenticator setup code" />
          <p className="muted" style={{ fontSize: 12 }}>Cannot scan? Type this key into the app instead:</p>
          <div className="secret">{enroll.secret}</div>
        </>
      ) : null}
      {mode === 'verify' ? <p>Enter the 6-digit code from your authenticator app.</p> : null}
      {mode !== 'loading' ? (
        <form onSubmit={submit}>
          <label>6-Digit Code<input className="in" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></label>
          {err ? <div className="err">{err}</div> : null}
          <button className="btn pri" type="submit" disabled={busy}>{busy ? 'Checking…' : mode === 'enroll' ? 'Turn On Two-Step' : 'Continue'}</button>
          <button className="btn ghost" type="button" onClick={signOut}>Sign Out</button>
          {mode === 'verify' ? <p className="muted" style={{ fontSize: 12 }}>Lost your phone? Ask the Treasurer to reset your two-step in Supabase, then sign in again to set it up.</p> : null}
        </form>
      ) : null}
    </AuthCard>
  );
}
