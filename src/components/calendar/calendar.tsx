'use client';
// The Calendar (mockup 98): board meetings, community events and team schedules, as a month grid or a day-by-day list.
// The board sees every event; a team login sees community events and its own team's schedule (row security in
// 0008_calendar.sql decides, not this page). Officers add and change any event; a coach only their own team's.
// Every write goes through calendar_save and calendar_archive.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase/client';
import { todayIso } from '@/lib/format';
import { Area, Err, Txt } from '@/components/forms';
import { Badge, Kv, Modal, useUI, type Tone } from '@/components/ui';
import './calendar.css';

export type CalKind = 'board' | 'community' | 'team';
export type CalType = 'Practice' | 'Scrimmage' | 'Competition';
export type CalEvent = {
  id: string; kind: CalKind; team_id: string | null; type: CalType | null; title: string; date: string;
  start_time: string | null; end_time: string | null; location: string | null; notes: string | null;
  series_id: string | null; added_by: string | null; created_at: string | null;
};
export type CalTeam = { id: string; name: string; short: string };

const KINDS: Record<CalKind, { label: string; one: string; tone: Tone; color: string; tip: string }> = {
  board: { label: 'Board Meetings', one: 'Board Meeting', tone: 'vio', color: 'var(--vio)', tip: 'Board, committee and officer meetings. Officers only.' },
  community: { label: 'Community Events', one: 'Community Event', tone: 'amb', color: 'var(--amb)', tip: 'Open houses, demos and outreach. Everyone sees these.' },
  team: { label: 'Team Schedules', one: 'Team Schedule', tone: 'blu', color: 'var(--blue)', tip: 'Practices, scrimmages and competitions for each team' },
};
const KIND_KEYS: CalKind[] = ['board', 'community', 'team'];
const TYPES: CalType[] = ['Practice', 'Scrimmage', 'Competition'];
const TTONE: Record<CalType, Tone> = { Practice: 'gry', Scrimmage: 'amb', Competition: 'red' };
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ymd = (y: number, m: number, d: number) => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
const dObj = (s: string) => { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const longDate = (s: string) => { const d = dObj(s); return DOWL[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
const hm = (t: string | null) => (t ? t.slice(0, 5) : '');
function tm(t: string | null, short?: boolean) {
  if (!t) return '';
  const p = t.split(':'); let h = +p[0]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return short ? h + (p[1] !== '00' ? ':' + p[1] : '') + (ap === 'AM' ? 'a' : 'p') : h + ':' + p[1] + ' ' + ap;
}
const span = (e: CalEvent) => (e.start_time ? tm(e.start_time) + (e.end_time ? ' – ' + tm(e.end_time) : '') : 'All day');
const addedOn = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return MON[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + d.getFullYear(); };
const sortKey = (e: CalEvent) => e.date + (e.start_time || '00:00');

type Ctx = { side: 'board' | 'team'; teams: CalTeam[]; myTeam: CalTeam | null; reload: () => Promise<void> };

function teamShort(c: Ctx, id: string | null) { const t = c.teams.find((x) => x.id === id); return t ? t.short || t.name : 'Team'; }
function evFull(c: Ctx, e: CalEvent) {
  if (e.kind !== 'team') return e.title;
  return e.title === 'Practice' ? teamShort(c, e.team_id) + ' Practice' : teamShort(c, e.team_id) + ': ' + e.title;
}
function canEdit(c: Ctx, e: CalEvent) { return c.side === 'board' || (e.kind === 'team' && !!c.myTeam && e.team_id === c.myTeam.id); }

export function Calendar({ side, teams, myTeam, frame }: {
  side: 'board' | 'team'; teams: CalTeam[]; myTeam?: CalTeam | null;
  /** Lays out the page: its header with the permission note and the Add Event button, then the calendar itself. */
  frame: (perm: ReactNode, add: ReactNode, body: ReactNode) => ReactNode;
}) {
  const ui = useUI();
  const today = todayIso();
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ym, setYm] = useState(() => ({ y: +today.slice(0, 4), m: +today.slice(5, 7) - 1 }));
  const [view, setView] = useState<'month' | 'list'>('month');
  const [kinds, setKinds] = useState<Record<CalKind, boolean>>({ board: true, community: true, team: true });
  const [teamF, setTeamF] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase().from('calendar_events').select('*').is('archived_at', null).order('date').order('start_time');
    if (error) { setErr(error.message); return; }
    setErr(null);
    setEvents((data || []) as CalEvent[]);
  }, []);
  useEffect(() => {
    let live = true;
    supabase().from('calendar_events').select('*').is('archived_at', null).order('date').order('start_time').then(({ data, error }) => {
      if (!live) return;
      if (error) setErr(error.message); else setEvents((data || []) as CalEvent[]);
    });
    return () => { live = false; };
  }, []);

  const c: Ctx = useMemo(() => ({ side, teams, myTeam: myTeam || null, reload: load }), [side, teams, myTeam, load]);
  const mk = ymd(ym.y, ym.m, 1).slice(0, 7);
  const all = useMemo(() => events || [], [events]);
  const visible = useMemo(() => all.filter((e) => kinds[e.kind] && !(e.kind === 'team' && side === 'board' && teamF.length && !teamF.includes(e.team_id || '')))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)), [all, kinds, teamF, side]);

  const openDetail = (e: CalEvent, depth = 1) => ui.open(<Detail c={c} e={e} depth={depth} />);
  const openEditor = () => ui.open(<Editor c={c} viewed={ym} today={today} depth={1} onSaved={(d) => {
    const dd = dObj(d); setYm({ y: dd.getFullYear(), m: dd.getMonth() });
  }} />);
  const shift = (n: number) => setYm(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });

  const perm = side === 'board'
    ? <span className="muted" title="Officers add and change any event. Coaches add and change only their own team's schedule.">Officers can add any event</span>
    : <span className="muted" title="You see community events and your own team's schedule. Board meetings are visible to officers only.">Showing {myTeam?.name || 'your team'} and community events</span>;
  const add = (
    <button className="btn pri" onClick={openEditor}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>Add Event
    </button>
  );
  const keys: CalKind[] = side === 'board' ? KIND_KEYS : ['community', 'team'];
  const teamLabel = !teamF.length ? 'All Teams' : teamF.length === 1 ? teamShort(c, teamF[0]) : teamF.length + ' Teams';

  const empty = (
    <div className="cal-empty">
      <b>{all.length ? 'No events in ' + MON[ym.m] : 'No events on the calendar yet'}</b>
      {side === 'board' ? 'Add a board meeting, community event or team practice.' : "Add your team's practices and competitions."}
      <div style={{ marginTop: 12 }}><button className="btn pri sm" onClick={openEditor}>Add Event</button></div>
    </div>
  );

  return frame(perm, add, (
      <div className="panel">
        <div className="cal-frow">
          <div className="cal-mnav">
            <button className="btn sm" onClick={() => shift(-1)} title="Previous month" aria-label="Previous month">‹</button>
            <span className="mt">{MON[ym.m]} {ym.y}</span>
            <button className="btn sm" onClick={() => shift(1)} title="Next month" aria-label="Next month">›</button>
            <button className="btn sm" onClick={() => setYm({ y: +today.slice(0, 4), m: +today.slice(5, 7) - 1 })}>Today</button>
          </div>
          <span style={{ width: 10, flex: 'none' }} />
          {keys.map((k) => {
            const K = KINDS[k], n = all.filter((e) => e.kind === k && e.date.slice(0, 7) === mk).length;
            return (
              <button key={k} type="button" className={'cal-fp' + (kinds[k] ? ' on ' + K.tone : '')} title={K.tip} onClick={() => setKinds((s) => ({ ...s, [k]: !s[k] }))}>
                <span className="dot" style={{ background: K.color }} />{K.label}<span className="n">{n}</span>
              </button>
            );
          })}
          {side === 'board' ? (
            <span className="cal-fwrap">
              <button type="button" className={'cal-fp' + (teamF.length ? ' on grn' : '')} title="Narrow team schedules to one or more teams"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu((m) => (m ? null : { left: Math.min(r.left, window.innerWidth - 260), top: r.bottom + 6 })); }}>
                <span className="fk">Team</span>{teamLabel}
              </button>
              {menu ? <TeamMenu teams={teams} picked={teamF} pos={menu} onPick={setTeamF} close={() => setMenu(null)} /> : null}
            </span>
          ) : (
            <span className="cal-fp static" title="Coaches see only their own team's schedule"><span className="fk">Team</span>{myTeam?.name}</span>
          )}
          <span className="sp" style={{ minWidth: 10 }} />
          <div className="seg">
            <button type="button" className={'opt' + (view === 'month' ? ' on' : '')} onClick={() => setView('month')}>Month</button>
            <button type="button" className={'opt' + (view === 'list' ? ' on' : '')} onClick={() => setView('list')}>List</button>
          </div>
        </div>
        {err && !events ? <div className="cal-empty">Could not load the calendar. {err}<div style={{ marginTop: 10 }}><button className="btn" onClick={load}>Try Again</button></div></div>
          : !events ? <div className="cal-empty">Loading…</div>
          : view === 'month' ? <Month c={c} ym={ym} today={today} evs={visible} empty={empty} onEvent={openDetail} onDay={(d) => ui.open(<DayList c={c} day={d} evs={visible.filter((e) => e.date === d)} />)} />
          : <List c={c} mk={mk} today={today} evs={visible} empty={empty} onEvent={openDetail} />}
      </div>
  ));
}

function TeamMenu({ teams, picked, pos, onPick, close }: { teams: CalTeam[]; picked: string[]; pos: { left: number; top: number }; onPick: (v: string[]) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.cal-fwrap')) close(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', f); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k); };
  }, [close]);
  const sorted = teams.slice().sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="cal-menu" ref={ref} style={{ left: pos.left, top: pos.top }}>
      <div className="mhd">Team<span className="sp" /><button type="button" className="lnk" style={{ fontSize: 12 }} onClick={() => { onPick([]); close(); }}>Show All</button></div>
      {sorted.map((t) => (
        <label className="check" key={t.id}>
          <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => onPick(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} />{t.name}
        </label>
      ))}
    </div>
  );
}

function Chip({ c, e, onClick }: { c: Ctx; e: CalEvent; onClick: () => void }) {
  const K = KINDS[e.kind];
  return (
    <button type="button" className={'cal-ev ' + K.tone} onClick={onClick} title={evFull(c, e) + ' · ' + span(e) + (e.location ? ' · ' + e.location : '')}>
      {e.start_time ? <span className="tm">{tm(e.start_time, true)}</span> : null}<span className="tt">{evFull(c, e)}</span>
    </button>
  );
}

function Month({ c, ym, today, evs, empty, onEvent, onDay }: {
  c: Ctx; ym: { y: number; m: number }; today: string; evs: CalEvent[]; empty: ReactNode; onEvent: (e: CalEvent) => void; onDay: (d: string) => void;
}) {
  const start = new Date(ym.y, ym.m, 1).getDay(), dim = new Date(ym.y, ym.m + 1, 0).getDate();
  const cells = Math.ceil((start + dim) / 7) * 7;
  const days = Array.from({ length: cells }, (_, i) => new Date(ym.y, ym.m, 1 - start + i));
  const inMonth = evs.some((e) => dObj(e.date).getMonth() === ym.m && dObj(e.date).getFullYear() === ym.y);
  return (
    <>
      <div className="cal-dow">{DOW.map((d) => <div key={d}>{d}</div>)}</div>
      <div className="cal-grid">
        {days.map((dt) => {
          const key = ymd(dt.getFullYear(), dt.getMonth(), dt.getDate());
          const day = evs.filter((e) => e.date === key);
          return (
            <div key={key} className={'cal-cell' + (dt.getMonth() !== ym.m ? ' out' : '') + (key === today ? ' today' : '')}>
              <span className="dn">{dt.getDate()}</span>
              {day.slice(0, 3).map((e) => <Chip key={e.id} c={c} e={e} onClick={() => onEvent(e)} />)}
              {day.length > 3 ? <button type="button" className="cal-more" onClick={() => onDay(key)}>+{day.length - 3} More</button> : null}
            </div>
          );
        })}
      </div>
      {inMonth ? null : empty}
    </>
  );
}

function Row({ c, e, flat, full, onClick }: { c: Ctx; e: CalEvent; flat?: boolean; full?: boolean; onClick: () => void }) {
  const K = KINDS[e.kind];
  return (
    <div className={'cal-lrow' + (flat ? ' flat' : '')} role="button" tabIndex={0} onClick={onClick} onKeyDown={(k) => { if (k.key === 'Enter') onClick(); }}>
      <span className="cal-kbar" style={{ background: K.color }} />
      <span className="lt">{span(e)}</span>
      <span className="ln">{evFull(c, e)}</span>
      {full && e.type ? <Badge tone={TTONE[e.type]}>{e.type}</Badge> : null}
      <Badge tone={K.tone}>{K.one}</Badge>
      {full ? <span className="ll" title={e.location || ''}>{e.location || ''}</span> : null}
    </div>
  );
}

function List({ c, mk, today, evs, empty, onEvent }: { c: Ctx; mk: string; today: string; evs: CalEvent[]; empty: ReactNode; onEvent: (e: CalEvent) => void }) {
  const list = evs.filter((e) => e.date.slice(0, 7) === mk);
  if (!list.length) return <>{empty}</>;
  const days: Record<string, CalEvent[]> = {};
  list.forEach((e) => { (days[e.date] = days[e.date] || []).push(e); });
  return (
    <div className="cal-lst">
      {Object.keys(days).map((d) => {
        const dt = dObj(d);
        return (
          <div className="cal-lday" key={d}>
            <div className={'cal-ldate' + (d === today ? ' today' : '')}><b>{MON[dt.getMonth()].slice(0, 3)} {dt.getDate()}</b>{DOWL[dt.getDay()]}{d === today ? ' · Today' : ''}</div>
            <div>{days[d].map((e) => <Row key={e.id} c={c} e={e} full onClick={() => onEvent(e)} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

function DayList({ c, day, evs }: { c: Ctx; day: string; evs: CalEvent[] }) {
  const ui = useUI();
  return (
    <Modal wide title={longDate(day)} foot={<><button className="btn" onClick={ui.close}>Cancel</button><span /></>}>
      <div className="full">{evs.map((e) => <Row key={e.id} c={c} e={e} flat onClick={() => ui.open(<Detail c={c} e={e} depth={2} />)} />)}</div>
    </Modal>
  );
}

function Detail({ c, e, depth }: { c: Ctx; e: CalEvent; depth: number }) {
  const ui = useUI();
  const K = KINDS[e.kind];
  const ok = canEdit(c, e);
  const why = e.kind === 'community' ? 'Only officers can change community events' : "Coaches can change only their own team's schedule";
  const team = c.teams.find((t) => t.id === e.team_id);
  return (
    <Modal title={evFull(c, e)} foot={<>
      <button className="btn" onClick={ui.close}>Cancel</button>
      {ok ? <button className="btn pri" onClick={() => ui.open(<Editor c={c} ev={e} depth={depth + 1} />)}>Edit Event</button>
        : <span className="dis" title={why}><button className="btn pri" disabled>Edit Event</button></span>}
    </>}>
      <Kv k="Kind"><span className="btnrow"><Badge tone={K.tone}>{K.one}</Badge>{e.type ? <Badge tone={TTONE[e.type]}>{e.type}</Badge> : null}</span></Kv>
      {e.team_id ? <Kv k="Team">{team?.name || e.team_id}</Kv> : null}
      <Kv k="When">{longDate(e.date)} <span className="muted">· {span(e)}</span></Kv>
      <Kv k="Location">{e.location || ''}</Kv>
      <div className="k" style={{ alignSelf: 'start' }}>Notes</div>
      <div className="cal-note">{e.notes ? e.notes : <span className="muted">None</span>}</div>
      <Kv k="Added By"><span className="muted">{[e.added_by, addedOn(e.created_at)].filter(Boolean).join(' · ')}</span></Kv>
    </Modal>
  );
}

type Form = { kind: CalKind; type: CalType; team_id: string; title: string; date: string; start: string; end: string; location: string; notes: string; weekly: boolean };

function Editor({ c, ev, viewed, today, depth, onSaved }: {
  c: Ctx; ev?: CalEvent; viewed?: { y: number; m: number }; today?: string; depth: number; onSaved?: (date: string) => void;
}) {
  const ui = useUI();
  const coach = c.side === 'team';
  const firstTeam = c.myTeam?.id || c.teams.slice().sort((a, b) => a.name.localeCompare(b.name))[0]?.id || '';
  const defDate = () => {
    if (!viewed || !today) return todayIso();
    return today.slice(0, 7) === ymd(viewed.y, viewed.m, 1).slice(0, 7) ? today : ymd(viewed.y, viewed.m, 1);
  };
  const [f, setF] = useState<Form>(() => ev
    ? { kind: ev.kind, type: ev.type || 'Practice', team_id: ev.team_id || firstTeam, title: ev.title, date: ev.date, start: hm(ev.start_time), end: hm(ev.end_time), location: ev.location || '', notes: ev.notes || '', weekly: false }
    : { kind: coach ? 'team' : 'board', type: 'Practice', team_id: firstTeam, title: '', date: defDate(), start: '16:00', end: '18:00', location: '', notes: '', weekly: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (p: Partial<Form>) => setF((s) => ({ ...s, ...p }));
  const repeatable = !ev && f.kind === 'team' && f.type === 'Practice';

  const save = async () => {
    if (!f.date) { setMsg('Pick the date.'); return; }
    if (f.start && f.end && f.end <= f.start) { setMsg('The end time must be after the start time.'); return; }
    setBusy(true); setMsg(null);
    const p = {
      id: ev?.id, kind: f.kind, team_id: f.kind === 'team' ? (coach ? c.myTeam?.id : f.team_id) : null, type: f.kind === 'team' ? f.type : null,
      title: f.title.trim(), date: f.date, start_time: f.start || null, end_time: f.end || null, location: f.location, notes: f.notes,
      repeat: repeatable && f.weekly ? 'weekly' : null,
    };
    const { data, error } = await supabase().rpc('calendar_save', { p });
    setBusy(false);
    if (error) { setMsg(/row-level security|permission denied/i.test(error.message) ? 'Not allowed. Sign in again with your two-step code.' : error.message); return; }
    await c.reload();
    for (let i = 0; i < depth; i++) ui.close();
    onSaved?.(f.date);
    const n = Array.isArray(data) ? data.length : 1;
    ui.toast(ev ? 'Event updated' : n > 1 ? n + ' weekly events added to the calendar' : 'Event added to the calendar');
  };

  return (
    <Modal wide title={ev ? 'Edit Event' : 'Add Event'} foot={<>
      <button className="btn" onClick={ui.close}>Cancel</button>
      <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      <div className="k">Kind</div>
      <div className="seg cal-seg">
        {KIND_KEYS.map((k) => (coach && k !== 'team'
          ? <span key={k} className="dis" title={'Only officers can add ' + KINDS[k].label.toLowerCase()}><button type="button" className="opt" disabled>{KINDS[k].one}</button></span>
          : <button type="button" key={k} className={'opt' + (f.kind === k ? ' on' : '')} onClick={() => set({ kind: k })}>{KINDS[k].one}</button>))}
      </div>
      {f.kind === 'team' ? (
        <>
          <div className="k">Team</div>
          <div>{coach
            ? <span title="Coaches add events for their own team only"><input className="in" value={c.myTeam?.name || ''} disabled /></span>
            : (
              <select className="in" value={f.team_id} onChange={(e) => set({ team_id: e.target.value })}>
                {c.teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </div>
          <div className="k">Type</div>
          <div className="seg cal-seg">{TYPES.map((t) => <button type="button" key={t} className={'opt' + (f.type === t ? ' on' : '')} onClick={() => set({ type: t })}>{t}</button>)}</div>
        </>
      ) : null}
      <div className="k">Title</div>
      <div><Txt value={f.title} onChange={(v) => set({ title: v })} placeholder={f.kind === 'team' ? f.type : f.kind === 'board' ? 'Monthly Board Meeting' : 'GPRIC Open House'} /></div>
      <div className="k">Date</div>
      <div className="cal-when">
        <input className="in" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
        <input className="in" type="time" value={f.start} onChange={(e) => set({ start: e.target.value })} />
        <span className="muted">to</span>
        <input className="in" type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} />
      </div>
      <div className="k">Location</div>
      <div><Txt value={f.location} onChange={(v) => set({ location: v })} /></div>
      <div className="k" style={{ alignSelf: 'start', paddingTop: 6 }}>Notes</div>
      <div><Area value={f.notes} onChange={(v) => set({ notes: v })} placeholder="What to bring, who to contact" /></div>
      {repeatable ? (
        <>
          <div className="k">Repeats</div>
          <div className="seg cal-seg">
            <button type="button" className={'opt' + (!f.weekly ? ' on' : '')} onClick={() => set({ weekly: false })}>Does Not Repeat</button>
            <button type="button" className={'opt' + (f.weekly ? ' on' : '')} onClick={() => set({ weekly: true })}
              title="Adds this practice every week, same day and time, through the end of the season (the fiscal year end). Each week can be changed on its own.">Weekly Until Season End</button>
          </div>
        </>
      ) : null}
      <Err msg={msg} />
    </Modal>
  );
}
