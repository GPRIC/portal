'use client';
// P34: changing a sign-in email.
//   ChangeOwnEmail: anyone, for themselves (My Account on the board, Profile in the Team Portal). Supabase sends the
//   new address a confirmation link; nothing changes until it is opened. The seat follows by itself (0021).
//   ChangePersonEmail: the Treasurer, for the CPA's seat on People (a seat that approves or pays changes its own). The
//   new address gets the portal's own confirmation link and the old address is told.
import { useState } from 'react';
import { Err, Txt } from '@/components/forms';
import { Kv, Modal, useUI } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';

const VALID = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function ChangeOwnEmail({ current }: { current: string | null | undefined }) {
  const ui = useUI();
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const save = async () => {
    const v = email.trim().toLowerCase();
    if (!VALID.test(v)) { setErr('Enter the new email address.'); return; }
    if (v === (current || '').toLowerCase()) { setErr('That is already your email.'); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase().auth.updateUser({ email: v }, { emailRedirectTo: window.location.origin + '/auth/callback?next=/login/two-step' });
    setBusy(false);
    if (error) {
      setErr(/rate limit|too many/i.test(error.message) ? 'The portal\'s email sender has reached its limit of a few emails an hour. Try again in an hour.' : error.message);
      return;
    }
    setSent(true);
  };
  return (
    // view: the CPA may change their own sign-in too (it is not a change to the books).
    <Modal title="Change My Email" view foot={<>
      <span />
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>{sent ? 'Close' : 'Cancel'}</button>
        {sent ? null : <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Sending…' : 'Send Confirmation'}</button>}
      </span>
    </>}>
      <Kv k="Now">{current}</Kv>
      {sent ? (
        <div className="full">A confirmation link is on its way to {email.trim()}. Your sign-in changes once you open it; until then, keep using {current}. Your role and history stay as they are.</div>
      ) : (
        <>
          <Kv k="New Email"><Txt type="email" value={email} onChange={setEmail} autoFocus /></Kv>
          <div className="full muted">The new address gets a confirmation link. Nothing changes until it is opened.</div>
        </>
      )}
      <Err msg={err} />
    </Modal>
  );
}

export function ChangePersonEmail({ who, current, onDone }: { who: string; current: string; onDone?: () => void }) {
  const ui = useUI();
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const v = email.trim().toLowerCase();
    if (!VALID.test(v)) { setErr('Enter the new email address.'); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc('people_email_change_request', { p_email: current, p_new: v });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone?.();
    ui.close();
    ui.toast('Confirmation queued for ' + v);
  };
  return (
    <Modal title={'Change Email · ' + who} foot={<>
      <span />
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Cancel</button>
        <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Send Confirmation'}</button>
      </span>
    </>}>
      <Kv k="Now">{current}</Kv>
      <Kv k="New Email"><Txt type="email" value={email} onChange={setEmail} autoFocus /></Kv>
      <div className="full muted">The new address gets a link to confirm; their sign-in switches only when it is opened, and their role and history stay. The email goes out once the portal&apos;s email sending is set up. They can also change it themselves from My Account.</div>
      <Err msg={err} />
    </Modal>
  );
}
