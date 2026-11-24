'use client';
// P33, on People: Pending Requests (self sign-ups waiting for a board member) and sign-up invites. The Treasurer and
// board members use it; the database checks the role on every call (0020_request_access.sql). A board member approves
// team members and board seats; Treasurer, bookkeeper and CPA seats are the Treasurer's, so those choices are hidden.
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { useData } from '@/components/data';
import { Err, Select, Txt } from '@/components/forms';
import { Badge, Kv, Modal, Pills, Seg, Table, useUI, type Col, type Tone } from '@/components/ui';
import { date } from '@/lib/format';
import { supabase } from '@/lib/supabase/client';

type Status = 'Pending' | 'Approved' | 'Declined';
type Grant = 'team' | 'board' | 'treasurer' | 'bookkeeper' | 'cpa';
type Req = {
  id: string; status: Status; name: string; email: string; phone: string | null; zelle: string | null; kind: 'team' | 'board';
  team_asked: string | null; team_asked_name: string | null; team_other: string | null; invited_by: string | null; created_at: string;
  role_granted: Grant | null; team_granted: string | null; decided_by: string | null; decided_at: string | null; decline_reason: string | null;
};
type Inv = { email: string; name: string | null; kind: 'team' | 'board'; team_id: string | null; invited_by: string | null; invited_at: string; token: string; used: boolean };

const GRANT: [Grant, string][] = [['team', 'Team Member'], ['board', 'Board'], ['bookkeeper', 'Bookkeeper'], ['cpa', 'CPA'], ['treasurer', 'Treasurer']];
const GRANT_NAME = Object.fromEntries(GRANT) as Record<Grant, string>;
const TONE: Record<Status, Tone> = { Pending: 'amb', Approved: 'grn', Declined: 'red' };
const inviteLink = (token: string) => window.location.origin + '/request-access?invite=' + token;

export function AccessPanel() {
  const ui = useUI();
  const [rows, setRows] = useState<Req[] | null>(null);
  const [invites, setInvites] = useState<Inv[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'Pending' | 'Decided'>('Pending');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    const sb = supabase();
    Promise.all([sb.rpc('access_requests_list'), sb.rpc('access_invites_list')]).then(([r, i]) => {
      if (!live) return;
      if (r.error) setErr(r.error.message);
      else { setErr(null); setRows(((r.data || []) as Req[]).map((x) => ({ ...x, id: String(x.id) }))); }
      setInvites((i.data || []) as Inv[]);
    });
    return () => { live = false; };
  }, [tick]);

  const all = rows || [];
  const pending = all.filter((r) => r.status === 'Pending');
  const shown = view === 'Pending' ? pending : all.filter((r) => r.status !== 'Pending');
  const cols: Col<Req>[] = [
    { k: 'name', label: 'Name', html: (r) => <><div>{r.name}</div><div className="muted" style={{ fontSize: 12 }}>{r.email}</div></> },
    { k: 'asked', label: 'Asked For', sv: (r) => r.kind + (r.team_asked_name || ''), html: (r) => (r.kind === 'team' ? 'Team Member' + (r.team_asked_name ? ' · ' + r.team_asked_name : '') : 'Board Or Staff') },
    { k: 'zelle', label: 'Zelle', html: (r) => r.zelle || <span className="muted">None</span> },
    { k: 'created_at', label: 'Requested', desc: true, html: (r) => date(r.created_at) },
    { k: 'invited_by', label: 'Invited By', html: (r) => r.invited_by || <span className="muted">Self sign-up</span> },
    { k: 'status', label: 'Status', html: (r) => <span title={r.status === 'Declined' ? r.decline_reason || '' : r.decided_by ? 'By ' + r.decided_by : ''}>
      <Badge tone={TONE[r.status]}>{r.status === 'Approved' && r.role_granted ? 'Approved · ' + GRANT_NAME[r.role_granted] : r.status}</Badge></span> },
  ];

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <strong>Access Requests</strong>
        <span className="sp" style={{ flex: 1 }} />
        <button className="btn" onClick={() => ui.open(<InvitesList invites={invites} />)}>Invites Sent · {invites.length}</button>
        <button className="btn pri" onClick={() => ui.open(<SendInvite onDone={reload} />)}>Send Invite</button>
      </div>
      <Pills items={[{ key: 'Pending', label: 'Pending', tone: 'amb', count: pending.length }, { key: 'Decided', label: 'Decided', tone: 'gry', count: all.length - pending.length }]}
        active={view} onPick={(k) => setView(k as 'Pending' | 'Decided')} />
      <Table cols={cols} rows={shown} sort="created_at" dir={-1} onRow={(r) => ui.open(<Review r={r} onDone={reload} />)}
        empty={err ? 'Could not load requests: ' + err : rows === null ? 'Loading…' : view === 'Pending' ? 'No one is waiting.' : 'None decided yet.'} />
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>People ask on the sign-in page (New Here? Request Access). They have no access until approved here.</div>
    </div>
  );
}

function Review({ r, onDone }: { r: Req; onDone: () => void }) {
  const ui = useUI();
  const { db, isTreasurer } = useData();
  const [role, setRole] = useState<Grant>(r.kind === 'team' ? 'team' : 'board');
  const [team, setTeam] = useState(r.team_asked || '');
  const [zelle, setZelle] = useState(r.zelle || '');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = r.status === 'Pending';
  const grants = GRANT.filter(([g]) => isTreasurer || g === 'team' || g === 'board');

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true); setErr(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone(); ui.close(); ui.toast(ok);
  };
  const approve = () => {
    if (role === 'team' && !team) { setErr('Pick the team.'); return; }
    if (role === 'team' && !zelle.trim()) { setErr('Enter the Zelle reimbursements are paid to.'); return; }
    return act(() => supabase().rpc('access_request_approve', { p_id: Number(r.id), p_role: role, p_team_id: role === 'team' ? team : null, p_zelle: role === 'team' ? zelle.trim() : null }),
      r.name + ' approved');
  };
  const decline = () => {
    if (!why.trim()) { setErr('Give the decline reason; they are told it.'); return; }
    return act(() => supabase().rpc('access_request_decline', { p_id: Number(r.id), p_reason: why.trim() }), r.name + ' declined');
  };

  return (
    <Modal title={open ? 'Review Request' : 'Request · ' + r.status} view={!open} foot={<>
      <span />
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>{open ? 'Cancel' : 'Close'}</button>
        {open ? <button className="btn dan" onClick={decline} disabled={busy}>Decline</button> : null}
        {open ? <button className="btn pri" onClick={approve} disabled={busy}>{busy ? 'Saving…' : 'Approve'}</button> : null}
      </span>
    </>}>
      <Kv k="Name">{r.name}</Kv>
      <Kv k="Email">{r.email}</Kv>
      <Kv k="Phone">{r.phone || <span className="muted">None given</span>}</Kv>
      <Kv k="Asked For">{r.kind === 'team' ? 'Team Member · ' + (r.team_asked_name || 'no team picked') + (r.team_other ? ' (not on the list)' : '') : 'Board Or Staff'}</Kv>
      <Kv k="Requested On">{date(r.created_at)}</Kv>
      <Kv k="Invited By">{r.invited_by || <span className="muted">Self sign-up, no invite</span>}</Kv>
      {open ? (
        <>
          <Kv k="Role"><Select value={role} onChange={(v) => v && setRole(v)} options={grants} /></Kv>
          {role === 'team' ? <Kv k="Team"><Select value={team} onChange={setTeam} options={db.teams.map((t) => [t.id, t.name])} blank="Pick the team" /></Kv> : null}
          {role === 'team' ? (
            <Kv k="Zelle"><Txt value={zelle} onChange={setZelle} placeholder="Phone or email" />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Saved as their payee record. Reimbursements they file are paid here; only a board member changes it.</div></Kv>
          ) : null}
          <Kv k="Decline Reason"><Txt value={why} onChange={setWhy} placeholder="Only if declining; they are told it" /></Kv>
          <div className="full muted" style={{ fontSize: 12 }}>Check you know this person before approving: the email address is not confirmed by the portal.</div>
        </>
      ) : (
        <>
          <Kv k="Decided">{(r.decided_at ? date(r.decided_at) : '') + (r.decided_by ? ' by ' + r.decided_by : '')}</Kv>
          {r.role_granted ? <Kv k="Given">{GRANT_NAME[r.role_granted] + (r.team_granted ? ' · ' + (db.teams.find((t) => t.id === r.team_granted)?.name || r.team_granted) : '')}</Kv> : null}
          {r.decline_reason ? <Kv k="Reason">{r.decline_reason}</Kv> : null}
        </>
      )}
      <Err msg={err} />
    </Modal>
  );
}

function SendInvite({ onDone }: { onDone: () => void }) {
  const ui = useUI();
  const { db } = useData();
  const [f, setF] = useState({ email: '', name: '', kind: 'team' as 'team' | 'board', team: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) { setErr('Enter their email address.'); return; }
    setBusy(true); setErr(null);
    const { data, error } = await supabase().rpc('access_invite_send', { p_email: f.email.trim(), p_name: f.name.trim() || null, p_team_id: f.kind === 'team' && f.team ? f.team : null, p_kind: f.kind });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone();
    setToken(data as string);
  };
  if (token) return <InviteLink token={token} email={f.email.trim()} />;
  return (
    <Modal title="Send Invite" foot={<>
      <span />
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Cancel</button>
        <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Sending…' : 'Send Invite'}</button>
      </span>
    </>}>
      <div className="full muted">They get a link to the Request Access page with your name on it. They fill in their details and set their password; the request then waits here for approval.</div>
      <Kv k="Email"><Txt type="email" value={f.email} onChange={(v) => set({ email: v })} autoFocus /></Kv>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} placeholder="Optional" /></Kv>
      <Kv k="They Are"><Seg value={f.kind} options={[['team', 'Team Member'], ['board', 'Board Or Staff']]} onChange={(v) => set({ kind: v })} /></Kv>
      {f.kind === 'team' ? <Kv k="Team"><Select value={f.team} onChange={(v) => set({ team: v })} options={db.teams.map((t) => [t.id, t.name])} blank="Optional: they pick" /></Kv> : null}
      <Err msg={err} />
    </Modal>
  );
}

function InviteLink({ token, email }: { token: string; email?: string }) {
  const ui = useUI();
  const [qr, setQr] = useState<string | null>(null);
  const link = inviteLink(token);
  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 360 }).then(setQr).catch(() => setQr(null)); }, [link]);
  const copy = async () => { await navigator.clipboard.writeText(link); ui.toast('Link copied'); };
  return (
    <Modal title="Invite Link" view foot={<><span /><span className="btnrow"><button className="btn" onClick={copy}>Copy Link</button><button className="btn pri" onClick={ui.close}>Done</button></span></>}>
      {email ? <div className="full muted">The invite email to {email} is queued. It goes out once the portal&apos;s email sending is set up; until then, send them this link or show them the code.</div> : null}
      <Kv k="Link"><span style={{ wordBreak: 'break-all' }}>{link}</span></Kv>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <div className="full" style={{ textAlign: 'center' }}><img src={qr} alt="Code that opens the invite" style={{ width: 200, height: 200, background: '#fff', padding: 10, borderRadius: 8 }} /></div>
      ) : null}
    </Modal>
  );
}

function InvitesList({ invites }: { invites: Inv[] }) {
  const ui = useUI();
  const { db } = useData();
  const rows = invites.map((i) => ({ ...i, id: i.token }));
  const cols: Col<(typeof rows)[number]>[] = [
    { k: 'email', label: 'Email', html: (i) => <><div>{i.email}</div>{i.name ? <div className="muted" style={{ fontSize: 12 }}>{i.name}</div> : null}</> },
    { k: 'kind', label: 'For', html: (i) => (i.kind === 'team' ? 'Team Member' + (i.team_id ? ' · ' + (db.teams.find((t) => t.id === i.team_id)?.name || '') : '') : 'Board Or Staff') },
    { k: 'invited_by', label: 'Sent By' },
    { k: 'invited_at', label: 'Sent', desc: true, html: (i) => date(i.invited_at) },
    { k: 'used', label: 'Used', html: (i) => (i.used ? <Badge tone="grn">Signed Up</Badge> : <span className="muted">Not yet</span>) },
  ];
  return (
    <Modal wide view title="Invites Sent" foot={<><span /><span className="btnrow"><button className="btn" onClick={ui.close}>Close</button></span></>}>
      <div className="full"><Table cols={cols} rows={rows} sort="invited_at" dir={-1} onRow={(i) => ui.open(<InviteLink token={i.token} />)} empty="No invites sent yet." /></div>
    </Modal>
  );
}
