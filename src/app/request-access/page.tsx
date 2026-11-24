'use client';
// Request Access (P33): a person asks for their own portal account. Mockup "Portal Request Access", confirmed.
// The login is made on the server; they then sign in, set up two-step and wait on /pending until a board member
// approves. An invite link (?invite=…) shows who sent it and comes with the team picked.
import Link from 'next/link';
import QRCode from 'qrcode';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { AuthCard } from '../login/auth-card';

type Invite = { invited_by: string | null; kind: 'team' | 'board'; team_id: string | null; name: string | null };
type Team = { id: string; name: string };
const OTHER = '__other';

export default function RequestAccessPage() {
  return <Suspense fallback={<AuthCard title="Request Access"><p>Loading…</p></AuthCard>}><RequestAccess /></Suspense>;
}

function RequestAccess() {
  const router = useRouter();
  const q = useSearchParams();
  const token = q.get('invite') || '';
  const [invite, setInvite] = useState<Invite | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [kind, setKind] = useState<'team' | 'board'>('team');
  const [team, setTeam] = useState('');
  const [other, setOther] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [zelle, setZelle] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [share, setShare] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.rpc('access_team_choices').then(({ data }) => setTeams((data as Team[]) || []));
    if (token) {
      sb.rpc('access_invite_lookup', { p_token: token }).then(({ data }) => {
        const i = data as Invite | null;
        if (!i) return;
        setInvite(i);
        setKind(i.kind);
        if (i.team_id) setTeam(i.team_id);
        if (i.name) setName((n) => n || i.name || '');
      });
    }
  }, [token]);

  useEffect(() => {
    if (!share || qr) return;
    QRCode.toDataURL(window.location.origin + '/request-access' + (token ? '?invite=' + encodeURIComponent(token) : ''), { margin: 1, width: 360 })
      .then(setQr).catch(() => setQr(null));
  }, [share, qr, token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pw !== pw2) { setErr('The two passwords do not match.'); return; }
    if (kind === 'team' && !team) { setErr('Choose your team, or Other Team.'); return; }
    setBusy(true);
    const r = await fetch('/api/request-access', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email, password: pw, name, phone, kind,
        zelle: kind === 'team' ? zelle : null,
        team_id: kind === 'team' && team !== OTHER ? team : null,
        team_other: kind === 'team' && team === OTHER ? other : null,
        invite: token || null,
      }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) { setBusy(false); setErr(j.error || 'Your request did not go through. Try again.'); return; }
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password: pw });
    setBusy(false);
    if (error) { router.replace('/login?error=' + encodeURIComponent('Your request is in. Sign in to set up two-step.')); return; }
    router.replace('/login/two-step?next=/pending');
  };

  return (
    <AuthCard title="Request Access">
      {invite?.invited_by ? <div className="note">Invited by {invite.invited_by}</div> : null}
      <p>Ask for a GPRIC Portal account. A board member reviews each request; you get an email once it is decided.</p>
      <form onSubmit={submit}>
        <label>I Am
          <div className="seg">
            <button type="button" className={'opt' + (kind === 'team' ? ' on' : '')} onClick={() => setKind('team')}>Team Member</button>
            <button type="button" className={'opt' + (kind === 'board' ? ' on' : '')} onClick={() => setKind('board')}>Board Or Staff</button>
          </div>
        </label>
        {kind === 'team' ? (
          <label>Team
            <select className="in" value={team} onChange={(e) => setTeam(e.target.value)} required>
              <option value="">Choose…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value={OTHER}>Other Team</option>
            </select>
          </label>
        ) : null}
        {kind === 'team' && team === OTHER ? <label>Team Name<input className="in" value={other} onChange={(e) => setOther(e.target.value)} required /></label> : null}
        <label>Full Name<input className="in" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Email<input className="in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Phone<input className="in" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        {kind === 'team' ? (
          <label>Zelle (Email Or Phone)
            <input className="in" value={zelle} onChange={(e) => setZelle(e.target.value)} required />
            <span className="muted" style={{ fontSize: 11 }}>Reimbursements are paid here. Once approved, only a board member can change it.</span>
          </label>
        ) : null}
        <label>Password<input className="in" type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
        <label>Confirm Password<input className="in" type="password" autoComplete="new-password" minLength={10} value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
        {err ? <div className="err">{err}</div> : null}
        <button className="btn pri" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request Access'}</button>
        <Link className="doclink" href="/login">Have An Account? Sign In</Link>
        <button className="doclink" type="button" onClick={() => setShare((s) => !s)}>{share ? 'Hide Share Code' : 'Share This Page'}</button>
        {share && qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="qr" src={qr} alt="Code that opens this page" />
        ) : null}
      </form>
    </AuthCard>
  );
}
