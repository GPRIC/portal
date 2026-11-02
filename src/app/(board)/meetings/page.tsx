'use client';
import { useState } from 'react';
import { Page } from '@/components/shell';
import { removeFiles, uploadFile, useData } from '@/components/data';
import { Area, DateIn, Err, FileLink, Foot, num, orNull, Select, Txt } from '@/components/forms';
import { Badge, Card, Check, Kv, Lines, Modal, Seg, Table, useUI, type Col, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { date, sd, sum } from '@/lib/format';
import type { Ballot, Meeting, Member } from '@/lib/types';

const STT: Record<string, Tone> = { 'Minutes Approved': 'grn', 'Minutes Draft': 'amb', Scheduled: 'blu' };
const KINDS = ['Regular', 'Special', 'Annual', 'Email Vote'] as const;
const STATUSES = ['Scheduled', 'Minutes Draft', 'Minutes Approved'] as const;

export default function MeetingsPage() {
  const { db, calc } = useData();
  const ui = useUI();
  const T = calc.today;
  const votesOf = (m: Meeting) => db.meeting_votes.filter((v) => v.meeting_id === m.id);
  const outOf = (m: Meeting) => Array.from(new Set(votesOf(m).flatMap((v) => v.stepped_out)));
  const next = db.meetings.filter((m) => m.date >= T && m.status === 'Scheduled').sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const fyVotes = db.meeting_votes.filter((v) => (calc.meeting(v.meeting_id)?.date || '') >= calc.fyStart);
  const drafts = db.meetings.filter((m) => m.status === 'Minutes Draft');
  const cols: Col<Meeting>[] = [
    { k: 'date', label: 'Date', html: (m) => date(m.date) },
    { k: 'title', label: 'Meeting' },
    { k: 'kind', label: 'Kind' },
    { k: 'status', label: 'Status', html: (m) => <Badge tone={STT[m.status]}>{m.status}</Badge> },
    { k: 'votes', label: 'Votes', num: true, sv: (m) => votesOf(m).length, html: (m) => String(votesOf(m).length) },
    { k: 'out', label: 'Stepped Out', sv: (m) => outOf(m).length, html: (m) => outOf(m).map((u) => calc.memberTitle(u)).join(', ') },
    { k: 'doc', label: 'Minutes', nosort: true, html: (m) => <MeetingDoc m={m} /> },
  ];
  return (
    <Page title="Meetings And Votes" help="meetings" actions={<>
      <button className="btn" onClick={() => ui.open(<MembersList />)}>Board Members</button>
      <button className="btn pri" onClick={() => ui.open(<MeetingForm />)}>Add Meeting</button>
    </>}>
      <div className="cards">
        <Card n="Next Meeting" v={next ? sd(next.date) : '—'} tip={next ? next.title : undefined} />
        <Card n="Votes This Year" v={String(fyVotes.length)} tip={fyVotes.filter((v) => v.stepped_out.length).length + ' with a member stepped out.'} />
        <Card n="Minutes In Draft" v={String(drafts.length)} color="amb" tip={<Lines lines={drafts.map((m) => m.title)} />} />
      </div>
      <div className="panel">
        <Table cols={cols} rows={db.meetings} sort="date" dir={-1} onRow={(m) => ui.open(<MeetingView id={m.id} />)} />
      </div>
    </Page>
  );
}

function MeetingDoc({ m }: { m: Meeting }) {
  const scheduled = m.status === 'Scheduled';
  const path = scheduled ? m.agenda_path || m.minutes_path : m.minutes_path || m.agenda_path;
  const link = scheduled ? m.agenda_link || m.minutes_link : m.minutes_link || m.agenda_link;
  const label = (scheduled && (m.agenda_path || m.agenda_link)) || (!m.minutes_path && !m.minutes_link) ? 'Agenda' : 'Minutes';
  if (path) return <FileLink path={path} name={label} />;
  if (link) return <a className="doclink" href={link} target="_blank" rel="noopener noreferrer">{label}</a>;
  return <Badge>Not Filed</Badge>;
}

function DocLine({ path, name, link }: { path: string | null; name: string | null; link: string | null }) {
  if (path) return <FileLink path={path} name={name || 'Open'} />;
  if (link) return <a className="doclink" href={link} target="_blank" rel="noopener noreferrer">Open</a>;
  return <>Not filed yet</>;
}

function MeetingView({ id }: { id: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const m = calc.meeting(id);
  if (!m) return <Modal title="Meeting"><div className="full empty">This meeting was deleted.</div></Modal>;
  const votes = db.meeting_votes.filter((v) => v.meeting_id === id).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  const delVote = async (vid: string) => {
    const v = votes.find((x) => x.id === vid);
    if (!v) return;
    const req = v.request_id ? calc.request(v.request_id) : null;
    if (!(await ui.confirm({ title: 'Delete Vote', body: <>Delete the vote on {v.item}?{req ? ` Request ${req.id} keeps its status (${req.status}); change it on Team Requests if the vote is being redone.` : ''}</>, ok: 'Delete', danger: true }))) return;
    await run(() => supabase().from('meeting_votes').delete().eq('id', vid), 'Vote deleted');
  };
  return (
    <Modal wide title={m.title} foot={<>
      <button className="btn" onClick={() => ui.open(<MeetingForm id={m.id} />)}>Edit Meeting</button>
      <span className="btnrow"><button className="btn" onClick={ui.close}>Close</button><button className="btn pri" onClick={() => ui.open(<VoteForm meetingId={m.id} />)}>Record A Vote</button></span>
    </>}>
      <Kv k="Date">{date(m.date)}</Kv>
      <Kv k="Kind">{m.kind}</Kv>
      <Kv k="Status"><Badge tone={STT[m.status]}>{m.status}</Badge></Kv>
      <Kv k="Present">{m.present.map((u) => calc.memberTitle(u)).join(', ')}</Kv>
      <Kv k="Summary">{m.summary ? <span className="wraptext">{m.summary}</span> : ''}</Kv>
      <Kv k="Agenda"><DocLine path={m.agenda_path} name={m.agenda_name} link={m.agenda_link} /></Kv>
      <Kv k="Minutes"><DocLine path={m.minutes_path} name={m.minutes_name} link={m.minutes_link} /></Kv>
      {votes.length ? (
        <div className="full scroll">
          <table className="subtable">
            <thead><tr><th className="nosort">Item</th><th className="nosort">Result</th><th className="nosort num">Yes</th><th className="nosort num">No</th><th className="nosort num">Abstain</th><th className="nosort">Stepped Out</th><th className="nosort" /></tr></thead>
            <tbody>
              {votes.map((x) => (
                <tr key={x.id}>
                  <td>{x.item}{x.note ? <div className="muted">{x.note}</div> : null}{x.request_id ? <div className="muted">Team request {x.request_id}</div> : null}</td>
                  <td><Badge tone={x.result === 'Approved' ? 'grn' : 'red'}>{x.result}</Badge></td>
                  <td className="num">{x.yes}</td><td className="num">{x.no}</td><td className="num">{x.abstain}</td>
                  <td>{x.stepped_out.length ? x.stepped_out.map((u) => calc.memberTitle(u)).join(', ') : <span className="muted">None</span>}</td>
                  <td className="btnrow"><button className="btn sm" onClick={() => ui.open(<VoteForm meetingId={m.id} id={x.id} />)}>Edit</button><button className="btn sm" onClick={() => delVote(x.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="full muted">No votes recorded at this meeting.</div>}
    </Modal>
  );
}

type DocState = { link: string; file: File | null; drop: boolean };

function MeetingForm({ id }: { id?: string }) {
  const { calc, run } = useData();
  const ui = useUI();
  const old = id ? calc.meeting(id) : null;
  const board = calc.board();
  const [f, setF] = useState(() => ({
    date: old?.date || calc.today, kind: old?.kind || 'Regular', title: old?.title || '', status: old?.status || 'Scheduled',
    present: old ? old.present : board.map((m) => m.id), summary: old?.summary || '',
  }));
  const [agenda, setAgenda] = useState<DocState>({ link: old?.agenda_link || '', file: null, drop: false });
  const [minutes, setMinutes] = useState<DocState>({ link: old?.minutes_link || '', file: null, drop: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const votes = old ? calc.db.meeting_votes.filter((v) => v.meeting_id === old.id).length : 0;

  const save = async () => {
    if (!f.date) { setErr('Pick a date.'); return; }
    setBusy(true); setErr(null);
    const up = async (d: DocState, oldPath: string | null | undefined, oldName: string | null | undefined, kind: string) => {
      if (d.file) {
        const r = await uploadFile('meetings/' + f.date, d.file);
        if ('error' in r) throw new Error(kind + ' upload failed: ' + r.error);
        return { path: r.path, name: r.name };
      }
      return d.drop ? { path: null, name: null } : { path: oldPath || null, name: oldName || null };
    };
    let a, mi;
    try { a = await up(agenda, old?.agenda_path, old?.agenda_name, 'Agenda'); mi = await up(minutes, old?.minutes_path, old?.minutes_name, 'Minutes'); }
    catch (e) { setBusy(false); setErr((e as Error).message); return; }
    const row = {
      date: f.date, kind: f.kind, title: f.title.trim() || (f.kind === 'Email Vote' ? 'Email Vote' : f.kind + ' Meeting') + ', ' + date(f.date),
      status: f.status, present: f.present, summary: orNull(f.summary),
      agenda_link: orNull(agenda.link), agenda_path: a.path, agenda_name: a.name, minutes_link: orNull(minutes.link), minutes_path: mi.path, minutes_name: mi.name,
    };
    const ok = await run(() => (old ? supabase().from('meetings').update(row).eq('id', old.id) : supabase().from('meetings').insert(row)), old ? 'Meeting saved' : 'Meeting added');
    setBusy(false);
    if (ok === false) { await removeFiles([agenda.file ? a.path : null, minutes.file ? mi.path : null]); return; }
    const gone = [old?.agenda_path !== a.path ? old?.agenda_path : null, old?.minutes_path !== mi.path ? old?.minutes_path : null];
    await removeFiles(gone);
    ui.close();
  };
  const del = async () => {
    if (!old) return;
    if (!(await ui.confirm({ title: 'Delete Meeting', body: <>Delete {old.title}{votes ? ` and its ${votes} votes` : ''}? Uploaded agenda and minutes files are removed.{votes ? ' Team requests voted on here keep their status.' : ''}</>, ok: 'Delete', danger: true }))) return;
    const ok = await run(() => supabase().from('meetings').delete().eq('id', old.id), 'Meeting deleted');
    if (ok !== false) { await removeFiles([old.agenda_path, old.minutes_path]); ui.close(); ui.close(); }
  };
  const togglePresent = (mid: string, v: boolean) => set({ present: v ? Array.from(new Set([...f.present, mid])) : f.present.filter((x) => x !== mid) });
  const docField = (d: DocState, setD: (x: DocState) => void, path: string | null | undefined, name: string | null | undefined) => (
    <>
      {path && !d.drop && !d.file ? <span className="btnrow"><FileLink path={path} name={name} /><button type="button" className="btn sm" onClick={() => setD({ ...d, drop: true })}>Remove File</button></span>
        : <input className="in" type="file" onChange={(e) => setD({ ...d, file: e.target.files?.[0] || null })} />}
      <input className="in" style={{ marginTop: 6 }} placeholder="Or paste a link (Google Drive, etc.)" value={d.link} onChange={(e) => setD({ ...d, link: e.target.value })} />
    </>
  );
  return (
    <Modal wide title={old ? 'Edit ' + old.title : 'Add Meeting'} foot={<Foot onDelete={old ? del : undefined} onSave={save} busy={busy} />}>
      <Kv k="Date"><DateIn value={f.date} onChange={(v) => set({ date: v })} /></Kv>
      <Kv k="Kind"><Seg value={f.kind} options={[...KINDS]} onChange={(v) => set({ kind: v })} /></Kv>
      <Kv k="Title"><Txt value={f.title} onChange={(v) => set({ title: v })} placeholder="Regular Meeting, November" /></Kv>
      <Kv k="Status"><Seg value={f.status} options={[...STATUSES]} onChange={(v) => set({ status: v })} /></Kv>
      <Kv k="Present">{board.map((m) => <Check key={m.id} checked={f.present.includes(m.id)} onChange={(v) => togglePresent(m.id, v)}>{m.title} ({m.name})</Check>)}</Kv>
      <Kv k="Summary"><Area value={f.summary} onChange={(v) => set({ summary: v })} /></Kv>
      <Kv k="Agenda">{docField(agenda, setAgenda, old?.agenda_path, old?.agenda_name)}</Kv>
      <Kv k="Minutes">{docField(minutes, setMinutes, old?.minutes_path, old?.minutes_name)}</Kv>
      <Err msg={err} />
    </Modal>
  );
}

/** A motion voted at a meeting. Team request votes are recorded from Team Requests, which also moves the request on. */
function VoteForm({ meetingId, id }: { meetingId: string; id?: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const old = id ? db.meeting_votes.find((v) => v.id === id) : null;
  const m = calc.meeting(meetingId);
  const board = calc.board();
  const [item, setItem] = useState(old?.item || '');
  const [note, setNote] = useState(old?.note || '');
  const [ballots, setBallots] = useState<Record<string, Ballot>>(() => {
    if (old?.ballots) return { ...Object.fromEntries(board.map((u) => [u.id, 'Yes' as Ballot])), ...old.ballots };
    return Object.fromEntries(board.map((u) => [u.id, (m && !m.present.includes(u.id) ? 'Out' : 'Yes') as Ballot]));
  });
  const [manual, setManual] = useState(() => !!old && !old.ballots);
  const [counts, setCounts] = useState({ yes: String(old?.yes ?? 0), no: String(old?.no ?? 0), abstain: String(old?.abstain ?? 0) });
  const [err, setErr] = useState<string | null>(null);
  const vals = Object.values(ballots);
  const yes = manual ? num(counts.yes) || 0 : vals.filter((b) => b === 'Yes').length;
  const no = manual ? num(counts.no) || 0 : vals.filter((b) => b === 'No').length;
  const abstain = manual ? num(counts.abstain) || 0 : vals.filter((b) => b === 'Abstain').length;
  const result = yes > no ? 'Approved' : 'Declined';
  const save = async () => {
    if (!item.trim()) { setErr('Say what was voted on.'); return; }
    const row = {
      meeting_id: meetingId, item: item.trim(), note: orNull(note), result, yes, no, abstain,
      ballots: manual ? null : ballots, stepped_out: manual ? old?.stepped_out || [] : Object.keys(ballots).filter((k) => ballots[k] === 'Out'),
    };
    const ok = await run(() => (old ? supabase().from('meeting_votes').update(row).eq('id', old.id) : supabase().from('meeting_votes').insert({ ...row, sort: sum(db.meeting_votes.filter((v) => v.meeting_id === meetingId), () => 1) + 1 })), 'Vote recorded');
    if (ok !== false) ui.close();
  };
  return (
    <Modal title={old ? 'Edit Vote' : 'Record A Vote'} foot={<Foot onSave={save} />}>
      <Kv k="Motion"><Txt value={item} onChange={setItem} placeholder="Approve the 2027 budget" autoFocus /></Kv>
      {old?.request_id ? <div className="full muted">This vote decided team request {old.request_id}. Changing the tally here does not change the request.</div> : null}
      {!manual ? board.map((u: Member) => (
        <Kv key={u.id} k={u.title}><span className="btnrow"><Seg value={ballots[u.id] || 'Yes'} options={['Yes', 'No', 'Abstain', ['Out', 'Stepped Out']]} onChange={(v) => setBallots({ ...ballots, [u.id]: v })} /><span className="muted">{u.name}</span></span></Kv>
      )) : (
        <Kv k="Counts"><span className="btnrow">Yes <input className="in" style={{ width: 70 }} type="number" value={counts.yes} onChange={(e) => setCounts({ ...counts, yes: e.target.value })} /> No <input className="in" style={{ width: 70 }} type="number" value={counts.no} onChange={(e) => setCounts({ ...counts, no: e.target.value })} /> Abstain <input className="in" style={{ width: 70 }} type="number" value={counts.abstain} onChange={(e) => setCounts({ ...counts, abstain: e.target.value })} /></span></Kv>
      )}
      <Kv k="Tally"><Check checked={manual} onChange={setManual}>Enter counts instead of each member</Check></Kv>
      <Kv k="Note"><Txt value={note} onChange={setNote} /></Kv>
      <div className="full"><Badge tone={result === 'Approved' ? 'grn' : 'red'}>{(result === 'Approved' ? 'Passes ' : 'Fails ') + yes + '–' + no}</Badge></div>
      <Err msg={err} />
    </Modal>
  );
}

function MembersList() {
  const { db, calc } = useData();
  const ui = useUI();
  const cols: Col<Member>[] = [
    { k: 'sort', label: 'Seat', num: true, html: (m) => String(m.sort) },
    { k: 'title', label: 'Title' },
    { k: 'name', label: 'Name' },
    { k: 'email', label: 'Email' },
    { k: 'interest', label: 'Team Interest', sv: (m) => calc.team(m.interest_team_id)?.short || '', html: (m) => calc.team(m.interest_team_id)?.short || '' },
    { k: 'active', label: 'Votes', html: (m) => (m.active ? <Badge tone="grn">Active</Badge> : <Badge>Former</Badge>) },
  ];
  return (
    <Modal wide title="Board Members" foot={<><span className="muted">Portal sign-in is separate: the Treasurer invites people in Supabase.</span><span className="btnrow"><button className="btn" onClick={ui.close}>Close</button><button className="btn pri" onClick={() => ui.open(<MemberForm />)}>Add Member</button></span></>}>
      <div className="full"><Table cols={cols} rows={db.board_members} sort="sort" onRow={(m) => ui.open(<MemberForm id={m.id} />)} empty="No board members yet." /></div>
    </Modal>
  );
}

function MemberForm({ id }: { id?: string }) {
  const { db, calc, run } = useData();
  const ui = useUI();
  const old = id ? calc.member(id) : null;
  const [f, setF] = useState(() => ({ name: old?.name || '', title: old?.title || '', email: old?.email || '', interest_team_id: old?.interest_team_id || '', interest_note: old?.interest_note || '', active: old ? old.active : true, sort: String(old?.sort ?? (db.board_members.length + 1) * 10) }));
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!f.name.trim() || !f.title.trim()) { setErr('Name and title are needed.'); return; }
    const row = { name: f.name.trim(), title: f.title.trim(), email: orNull(f.email), interest_team_id: f.interest_team_id || null, interest_note: orNull(f.interest_note), active: f.active, sort: parseInt(f.sort, 10) || 0 };
    const ok = await run(() => (old ? supabase().from('board_members').update(row).eq('id', old.id) : supabase().from('board_members').insert(row)), old ? 'Member saved' : 'Member added');
    if (ok !== false) ui.close();
  };
  const del = async () => {
    if (!old) return;
    if (!(await ui.confirm({ title: 'Delete Member', body: <>Delete {old.name}? Past votes keep their tallies. To keep their history readable, untick Votes instead.</>, ok: 'Delete', danger: true }))) return;
    const ok = await run(() => supabase().from('board_members').delete().eq('id', old.id), 'Member deleted');
    if (ok !== false) ui.close();
  };
  return (
    <Modal title={old ? old.name : 'Add Member'} foot={<Foot onDelete={old ? del : undefined} onSave={save} />}>
      <Kv k="Name"><Txt value={f.name} onChange={(v) => set({ name: v })} /></Kv>
      <Kv k="Title"><Txt value={f.title} onChange={(v) => set({ title: v })} placeholder="President" /></Kv>
      <Kv k="Email"><Txt type="email" value={f.email} onChange={(v) => set({ email: v })} /></Kv>
      <Kv k="Team Interest"><Select value={f.interest_team_id} onChange={(v) => set({ interest_team_id: v })} blank="None" options={db.teams.map((t) => [t.id, t.name])} /><div className="muted" style={{ fontSize: 12 }}>A member tied to a team steps out of that team&apos;s votes.</div></Kv>
      {f.interest_team_id ? <Kv k="Interest Note"><Txt value={f.interest_note} onChange={(v) => set({ interest_note: v })} placeholder="Parent of a team member" /></Kv> : null}
      <Kv k="Votes"><Check checked={f.active} onChange={(v) => set({ active: v })}>Active board member</Check></Kv>
      <Kv k="Seat Order"><Txt type="number" value={f.sort} onChange={(v) => set({ sort: v })} /></Kv>
      <Err msg={err} />
    </Modal>
  );
}
