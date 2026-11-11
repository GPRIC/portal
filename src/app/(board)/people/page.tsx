'use client';
// People (P39): the Treasurer adds board members, the bookkeeper and the CPA, changes their role and whether they may
// file direct expenses, turns access off and on, and resends invites. Treasurer only: every action is a database
// function that checks the role (0014_people.sql); invites go out through api/people-invite. Nothing is deleted.
// Coaches and team treasurers are invited from Requests > Teams, not here.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Page } from '@/components/shell';
import { useData } from '@/components/data';
import { Err, Foot, Txt } from '@/components/forms';
import { Badge, Check, Kv, Modal, Pills, Seg, Table, useUI, type Col, type Tone } from '@/components/ui';
import { date } from '@/lib/format';
import { supabase } from '@/lib/supabase/client';
import { Icon } from '@/components/problems/report-problem';

type Role = 'treasurer' | 'board' | 'bookkeeper' | 'cpa';
type Status = 'active' | 'invited' | 'not_sent' | 'off';
type Person = {
  id: string; email: string; name: string | null; role: Role; files_direct: boolean; status: Status;
  last_sign_in_at: string | null; invited_at: string | null; has_login: boolean; is_me: boolean;
  off_at: string | null; off_by: string | null; off_reason: string | null; send_error: string | null;
};

const ROLES: [Role, string][] = [['treasurer', 'Treasurer'], ['board', 'Board'], ['bookkeeper', 'Bookkeeper'], ['cpa', 'CPA']];
const ROLE_NAME: Record<Role, string> = { treasurer: 'Treasurer', board: 'Board', bookkeeper: 'Bookkeeper', cpa: 'CPA' };
const ROLE_TIP: Record<Role, string> = {
  treasurer: 'Everything, including approval rules, unlocking a month, overrides and this page.',
  board: 'Sees the books, approves requests and votes. Files direct expenses only if you tick the box.',
  bookkeeper: 'Keeps the books: pays and closes requests, reviews direct expenses, reconciles the bank.',
  cpa: 'Reads the books and exports them. Changes nothing and never sees contact details.',
};
const STATUS: Record<Status, [string, Tone, string]> = {
  active: ['Active', 'grn', 'Has signed in'],
  invited: ['Invited', 'blu', 'The invite email went out; they have not signed in yet'],
  not_sent: ['Invite Not Sent', 'amb', 'The invite email did not go out. Use Resend Invite.'],
  off: ['Access Off', 'red', 'Cannot sign in to see or change anything. Nothing about them is deleted.'],
};
const VIEWS: [string, Tone, (p: Person) => boolean][] = [
  ['Everyone On', 'grn', (p) => p.status !== 'off'], ['Waiting To Sign In', 'blu', (p) => p.status === 'invited' || p.status === 'not_sent'],
  ['Access Off', 'red', (p) => p.status === 'off'], ['All', 'gry', () => true],
];
const directTip = (role: Role) => (role === 'board' ? 'May file direct expenses (money already spent by debit card or check)'
  : role === 'cpa' ? 'The CPA never files anything' : 'The Treasurer and the bookkeeper can always file direct expenses');

/** Sends or resends an invite through the server (the email needs the service key). Returns an error message or null. */
async function invite(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch('/api/people-invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? null : out.error || 'The invite did not go out.';
}

export default function PeoplePage() {
  const { isTreasurer } = useData();
  const ui = useUI();
  const [rows, setRows] = useState<Person[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState(VIEWS[0][0]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!isTreasurer) return;
    let live = true;
    supabase().rpc('people_list').then(({ data, error }) => {
      if (!live) return;
      if (error) setErr(error.message);
      else { setErr(null); setRows(((data || []) as Omit<Person, 'id'>[]).map((p) => ({ ...p, id: p.email }))); }
    });
    return () => { live = false; };
  }, [isTreasurer, tick]);

  if (!isTreasurer) return <Page title="People"><div className="panel empty">Only the Treasurer can see this page.</div></Page>;

  const all = rows || [];
  const shown = all.filter((VIEWS.find((v) => v[0] === view) || VIEWS[0])[2]);
  const open = (p: Person) => ui.open(<PersonForm p={p} onDone={reload} />);
  const cols: Col<Person>[] = [
    { k: 'name', label: 'Name', sv: (p) => p.name || p.email, html: (p) => <>
      <div>{p.name || <span className="muted">No name</span>}{p.is_me ? <span className="muted"> (you)</span> : null}</div>
      <div className="muted" style={{ fontSize: 12 }}>{p.email}</div></> },
    { k: 'role', label: 'Role', sv: (p) => ROLES.findIndex(([r]) => r === p.role), html: (p) => <span title={ROLE_TIP[p.role]}>{ROLE_NAME[p.role]}</span> },
    { k: 'files_direct', label: 'Files Direct Expenses', sv: (p) => p.role === 'treasurer' || p.role === 'bookkeeper' || p.files_direct,
      html: (p) => (p.role === 'cpa' ? <span className="muted" title={directTip(p.role)}>No</span>
        : p.role !== 'board' ? <span title={directTip(p.role)}>Always</span> : p.files_direct ? 'Yes' : <span className="muted">No</span>) },
    { k: 'status', label: 'Status', sv: (p) => Object.keys(STATUS).indexOf(p.status), html: (p) => {
      const [l, tone, tip] = STATUS[p.status];
      return <span title={p.status === 'off' && p.off_reason ? 'Turned off ' + date(p.off_at) + (p.off_by ? ' by ' + p.off_by : '') + ': ' + p.off_reason : p.send_error ? tip + ' (' + p.send_error + ')' : tip}><Badge tone={tone}>{l}</Badge></span>;
    } },
    { k: 'last', label: 'Last Sign-In', desc: true, sv: (p) => p.last_sign_in_at || '', html: (p) => (p.last_sign_in_at ? date(p.last_sign_in_at) : <span className="muted">Never</span>) },
  ];

  return (
    <Page title="People" help="people" actions={<button className="btn pri" onClick={() => ui.open(<AddForm onDone={reload} />)}>Add Person</button>}>
      <div className="muted" style={{ marginTop: -10, marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="lockd" title="Only the Treasurer sees this page" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}><Icon.lock />Treasurer Only</span>
        <span>Coaches and team treasurers are invited from <Link className="lnk" href="/requests">Requests</Link>, under Teams.</span>
      </div>
      <div className="panel">
        <Pills items={VIEWS.map(([k, tone, f]) => ({ key: k, label: k, tone, count: all.filter(f).length }))} active={view} onPick={setView} />
        <Table cols={cols} rows={shown} sort="name" onRow={open}
          empty={err ? 'Could not load the list: ' + err : rows === null ? 'Loading…' : 'No one here.'} />
      </div>
    </Page>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const ui = useUI();
  const [f, setF] = useState({ name: '', email: '', role: 'board' as Role, files_direct: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!f.name.trim()) { setErr('Enter their name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) { setErr('Enter their email address.'); return; }
    setBusy(true); setErr(null);
    const e = await invite({ action: 'invite', ...f, email: f.email.trim(), name: f.name.trim(), files_direct: f.role === 'board' && f.files_direct });
    setBusy(false);
    onDone();
    if (e) { setErr(e); return; }
    ui.close();
    ui.toast('Invite sent to ' + f.email.trim());
  };
  return (
    <Modal title="Add Person" foot={<Foot onSave={save} saveLabel={busy ? 'Sending…' : 'Send Invite'} busy={busy} />}>
      <div className="full muted">They get an email to set a password and an authenticator code. Once signed in, they see what their role allows.</div>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} autoFocus /></Kv>
      <Kv k="Email"><Txt type="email" value={f.email} onChange={(v) => set({ email: v })} /></Kv>
      <Kv k="Role"><Seg value={f.role} options={ROLES} onChange={(v) => set({ role: v })} />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{ROLE_TIP[f.role]}</div></Kv>
      {f.role === 'board' ? <Kv k="Direct Expenses"><Check checked={f.files_direct} onChange={(v) => set({ files_direct: v })}>{directTip('board')}</Check></Kv> : null}
      <Err msg={err} />
    </Modal>
  );
}

function PersonForm({ p, onDone }: { p: Person; onDone: () => void }) {
  const ui = useUI();
  const [role, setRole] = useState<Role>(p.role);
  const [direct, setDirect] = useState(p.files_direct);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = p.name || p.email;
  const off = p.status === 'off';
  const canInvite = p.status === 'invited' || p.status === 'not_sent';

  /** Runs one change; on success closes the form, reloads the list and says what happened. */
  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }> | Promise<string | null>, done: string) => {
    setBusy(true); setErr(null);
    const r = await fn();
    const e = typeof r === 'string' || r === null ? r : r.error?.message || null;
    setBusy(false);
    onDone();
    if (e) { setErr(e); return false; }
    ui.close();
    ui.toast(done);
    return true;
  };
  const save = () => act(async () => {
    const sb = supabase();
    if (role !== p.role) {
      const r = await sb.rpc('people_set_role', { p_email: p.email, p_role: role });
      if (r.error) return r.error.message;
    }
    const want = role === 'board' && direct;
    if (want !== p.files_direct) {
      const r = await sb.rpc('people_set_files_direct', { p_email: p.email, p_on: want });
      if (r.error) return r.error.message;
    }
    return null;
  }, 'Saved');
  const turnOff = async () => {
    const reason = await ui.ask({
      title: p.has_login ? 'Turn Off Access' : 'Cancel Invite', ok: p.has_login ? 'Turn Off Access' : 'Cancel Invite', danger: true,
      body: p.has_login
        ? <>{who} will no longer see or change anything in the portal, from their next click. Nothing about them is deleted: their name stays on everything they did, and you can turn access back on at any time.</>
        : <>The invite for {who} is cancelled. You can reopen it later.</>,
      placeholder: 'For example: left the board in October',
    });
    if (reason == null) return;
    await act(() => supabase().rpc('people_turn_off', { p_email: p.email, p_reason: reason }), p.has_login ? 'Access turned off for ' + who : 'Invite cancelled');
  };
  const turnOn = async () => {
    const ok = await ui.confirm({
      title: p.has_login ? 'Turn On Access' : 'Reopen Invite', ok: p.has_login ? 'Turn On Access' : 'Reopen Invite',
      body: p.has_login ? <>{who} can sign in again as {ROLE_NAME[p.role]} and see everything that role allows.</>
        : <>The invite for {who} is open again. Use Resend Invite to send the email.</>,
    });
    if (!ok) return;
    await act(() => supabase().rpc('people_turn_on', { p_email: p.email }), p.has_login ? 'Access turned on for ' + who : 'Invite reopened');
  };
  const resend = () => act(() => invite({ action: 'resend', email: p.email }), 'Invite sent again to ' + p.email);

  const [label, tone] = STATUS[p.status];
  return (
    <Modal title={who} foot={<>
      <span className="btnrow">
        {p.is_me ? null : off ? <button className="btn" onClick={turnOn} disabled={busy}>{p.has_login ? 'Turn On Access' : 'Reopen Invite'}</button>
          : <button className="btn dan" onClick={turnOff} disabled={busy}>{p.has_login ? 'Turn Off Access' : 'Cancel Invite'}</button>}
        {canInvite ? <button className="btn" onClick={resend} disabled={busy}>Resend Invite</button> : null}
      </span>
      <span className="btnrow">
        <button className="btn" onClick={ui.close}>Cancel</button>
        {p.is_me || off ? null : <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
      </span>
    </>}>
      <Kv k="Email">{p.email}</Kv>
      <Kv k="Status"><Badge tone={tone}>{label}</Badge>
        {p.status === 'off' && p.off_reason ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Turned off {date(p.off_at)}{p.off_by ? ' by ' + p.off_by : ''}: {p.off_reason}</div> : null}
        {p.send_error && p.status !== 'off' ? <div className="warn" style={{ marginTop: 6 }}>The last invite email did not go out: {p.send_error}. The portal&apos;s email sender is limited to a few emails an hour; try Resend Invite later.</div> : null}
      </Kv>
      <Kv k="Last Sign-In">{p.last_sign_in_at ? date(p.last_sign_in_at) : 'Never'}</Kv>
      {p.is_me ? <div className="full muted">This is you. Your own role and access can only be changed by another Treasurer, so the portal always has one.</div> : off ? (
        <div className="full muted">Turn access on to change their role.</div>
      ) : <>
        <Kv k="Role"><Seg value={role} options={ROLES} onChange={setRole} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{ROLE_TIP[role]}</div></Kv>
        <Kv k="Direct Expenses">{role === 'board'
          ? <Check checked={direct} onChange={setDirect}>{directTip('board')}</Check>
          : <span className="muted">{directTip(role)}</span>}</Kv>
      </>}
      <Err msg={err} />
    </Modal>
  );
}
