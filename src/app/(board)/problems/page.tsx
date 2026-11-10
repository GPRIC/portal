'use client';
// Problem Reports (P37, mockup #99 v2): every Report A Problem sent from the portal, Treasurer only (row security in
// 0009_problem_reports.sql). Opens on Open (New and Looking); Page and Who sit behind Filters. A row opens the report
// with its screenshot and voice note; the Treasurer sets the status and keeps a reply note. Nothing is emailed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Page } from '@/components/shell';
import { useData } from '@/components/data';
import { supabase } from '@/lib/supabase/client';
import { BUCKET } from '@/lib/supabase/env';
import { initials } from '@/lib/format';
import { Badge, useUI, type Tone } from '@/components/ui';
import { Icon, pageName, secs } from '@/components/problems/report-problem';

type Report = {
  id: string; created_at: string; user_id: string; who: string; role: string | null; team_id: string | null;
  page: string; page_title: string | null; device: string | null; notes: string | null; transcript: string | null;
  screenshot_path: string | null; audio_path: string | null; audio_secs: number | null;
  status: Status; reply: string | null; updated_at: string | null; updated_by: string | null;
};
type Status = 'New' | 'Looking' | "Won't Fix" | 'Fixed';
const STATUSES: Status[] = ['New', 'Looking', "Won't Fix", 'Fixed'];
const STONE: Record<Status, Tone> = { New: 'blu', Looking: 'amb', Fixed: 'grn', "Won't Fix": 'gry' };
const STIP: Record<Status, string> = {
  New: 'Not looked at yet', Looking: 'The Treasurer is working on it', Fixed: 'Fixed', "Won't Fix": 'Closed without a change; the reply says why',
};
const VIEWS: [string, string][] = [['open', 'Open'], ['Fixed', 'Fixed'], ["Won't Fix", "Won't Fix"], ['all', 'All']];
const ROLE: Record<string, string> = { treasurer: 'Treasurer', board: 'Board', bookkeeper: 'Bookkeeper', cpa: 'CPA', team: 'Team login', system: 'Automatic' };
const TONES: Tone[] = ['grn', 'blu', 'vio', 'amb', 'red'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(ts: string, year?: boolean) {
  const d = new Date(ts);
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${MON[d.getMonth()]} ${d.getDate()}${year ? ', ' + d.getFullYear() : ''}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}
const isOpen = (r: Report) => r.status === 'New' || r.status === 'Looking';
const summary = (r: Report) => (r.notes || '').split('\n')[0].trim() || (r.screenshot_path ? 'Screenshot only' : 'Voice note only');
const shortName = (n: string) => n.replace(/ —.*/, '').replace(/ \(.*/, '');
type F = { view: string; page: string[]; who: string[]; q: string };
const fresh = (): F => ({ view: 'open', page: [], who: [], q: '' });
const COLS: [string, string, (r: Report & { pg: string; name: string }) => string | number][] = [
  ['at', 'Reported', (r) => r.created_at], ['who', 'Who', (r) => r.name.toLowerCase()], ['page', 'Page', (r) => r.pg.toLowerCase()],
  ['sum', 'Summary', (r) => summary(r).toLowerCase()], ['status', 'Status', (r) => STATUSES.indexOf(r.status)],
];

export default function ProblemsPage() {
  const { isTreasurer, db } = useData();
  const ui = useUI();
  const [rows, setRows] = useState<Report[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<F>(fresh);
  const [sort, setSort] = useState<{ i: number; dir: number }>({ i: 0, dir: -1 });
  const [page, setPage] = useState(0);
  const [per, setPer] = useState(25);
  const [menu, setMenu] = useState(false);
  const [tick, setTick] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!isTreasurer) return;
    let live = true;
    supabase().from('problem_reports').select('*').order('created_at', { ascending: false }).limit(5000).then(({ data, error }) => {
      if (!live) return;
      if (error) setErr(error.message); else { setErr(null); setRows((data || []) as Report[]); setLoadedAt(Date.now()); }
    });
    return () => { live = false; };
  }, [isTreasurer, tick]);

  const teamShort = useMemo(() => new Map(db.teams.map((t) => [t.id, t.short || t.name])), [db.teams]);
  const all = useMemo(() => (rows || []).map((r) => ({
    ...r, pg: pageName(r.page, r.page_title), name: r.who + (r.team_id && teamShort.get(r.team_id) ? ` (${teamShort.get(r.team_id)})` : ''),
  })), [rows, teamShort]);
  const people = useMemo(() => [...new Set(all.map((r) => r.name))].sort(), [all]);
  const tone = useMemo(() => new Map(people.map((p, i) => [p, TONES[i % TONES.length]])), [people]);
  const pagesSeen = useMemo(() => [...new Set(all.map((r) => r.pg))].sort(), [all]);

  if (!isTreasurer) {
    return <Page title="Problem Reports"><div className="panel empty">Only the Treasurer can see problem reports.</div></Page>;
  }

  const q = f.q.trim().toLowerCase();
  const list = all.filter((r) => (f.view === 'all' || (f.view === 'open' ? isOpen(r) : r.status === f.view))
    && (!f.page.length || f.page.includes(r.pg)) && (!f.who.length || f.who.includes(r.name))
    && (!q || [r.notes, r.transcript, r.name, r.pg, r.reply].join(' ').toLowerCase().includes(q)));
  const sv = COLS[sort.i][2];
  list.sort((a, b) => { const x = sv(a), y = sv(b); return (x > y ? 1 : x < y ? -1 : a.created_at < b.created_at ? 1 : -1) * sort.dir; });
  const pages = Math.max(1, Math.ceil(list.length / per));
  const pg = Math.min(page, pages - 1);
  const slice = list.slice(pg * per, pg * per + per);
  const upd = (p: Partial<F>) => { setF((x) => ({ ...x, ...p })); setPage(0); };
  const hidden = f.page.length + f.who.length > 0;

  const open = all.filter(isOpen);
  const weekAgo = loadedAt - 7 * 864e5, monthAgo = loadedAt - 30 * 864e5;
  const week = all.filter((r) => new Date(r.created_at).getTime() >= weekAgo).length;
  const cnt = new Map<string, number>();
  all.forEach((r) => { if (new Date(r.created_at).getTime() >= monthAgo) cnt.set(r.pg, (cnt.get(r.pg) || 0) + 1); });
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
  const plain = f.view === 'open' && !hidden && !q;

  return (
    <Page title="Problem Reports" actions={null}>
      <div className="probs-hdr" style={{ marginTop: -10, marginBottom: 12 }}>
        <span className="muted lockd" title="Only the Treasurer can see this page. Each report carries the page, time, person and device it was sent from, plus any screenshot or voice note."><Icon.lock />Treasurer Only</span>
      </div>
      <div className="tiles">
        <button type="button" className="tile" title={all.length ? 'New and Looking.' + (top ? ` Most reported page, last 30 days: ${top[0]} (${top[1]})` : '') : 'Nothing waiting'} onClick={() => upd({ view: 'open' })}>
          <span className="tk">Open</span><span className="tv">{open.length}</span></button>
        <div className="tile" title="Reports sent in the last 7 days"><span className="tk">This Week</span><span className="tv">{week}</span></div>
      </div>
      <div className="panel hist probs">
        <div className="frow">
          {VIEWS.map(([k, l]) => <button key={k} type="button" className={'fp' + (f.view === k ? ' on' : '')} onClick={() => upd({ view: k })}>{l}</button>)}
          <span className="fwrap">
            <button type="button" className="fp more" onClick={() => setMenu((m) => !m)} title="Page and Who" style={{ border: '1px solid var(--b)' }}>Filters{hidden ? <span className="dot" title="Page or Who filter is on" /> : null}</button>
            {menu ? <FilterPop f={f} pages={pagesSeen} people={people} set={upd} close={() => setMenu(false)} /> : null}
          </span>
          {hidden || f.q ? <button type="button" className="lnk" style={{ flex: 'none', marginLeft: 4 }} onClick={() => { upd({ page: [], who: [], q: '' }); }}>Clear</button> : null}
          <input className="in srch" placeholder="Search" value={f.q} onChange={(e) => upd({ q: e.target.value })} />
        </div>
        <div className="scroll">
          <table>
            <thead><tr>{COLS.map(([k, l], i) => (
              <th key={k} className={sort.i === i ? 'sort' : ''} onClick={() => { setSort((s) => (s.i === i ? { i, dir: -s.dir } : { i, dir: i === 0 ? -1 : 1 })); setPage(0); }}>
                {l}{sort.i === i ? <span className="ar">{sort.dir > 0 ? '▲' : '▼'}</span> : null}</th>
            ))}</tr></thead>
            <tbody>
              {slice.length ? slice.map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => ui.open(<Detail r={r} name={r.name} pg={r.pg} tone={tone.get(r.name) || 'grn'} onSaved={reload} />)}>
                  <td>{when(r.created_at)}</td>
                  <td><span className="who-line"><span className={'av ' + (tone.get(r.name) || 'grn')}>{initials(r.who)}</span>{r.name}</span></td>
                  <td>{r.pg}</td>
                  <td className="sum" title={summary(r)}>{summary(r)}
                    {r.screenshot_path || r.audio_path ? <span className="mi">
                      {r.screenshot_path ? <span title="Has a screenshot"><Icon.img /></span> : null}
                      {r.audio_path ? <span title={'Has a voice note (' + secs(r.audio_secs || 0) + ')'}><Icon.mic /></span> : null}
                    </span> : null}</td>
                  <td><span className={'pst ' + STONE[r.status]} title={STIP[r.status]}><i />{r.status}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="hempty">
                  {err ? <>Could not load the reports: {err}</> : rows === null ? 'Loading…'
                    : !all.length ? <><b>No problem reports yet</b>When someone uses Report A Problem, it shows here.</>
                      : plain ? <><b>Nothing open</b>Every report has been dealt with.</> : <><b>No reports match</b>Try All, or clear the filters.</>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted">{list.length ? `${pg * per + 1}–${Math.min(list.length, pg * per + per)} of ${list.length}` : '0–0 of 0'}</span>
          <span className="sp" />
          <span className="muted">Rows</span>
          <div className="seg">{[25, 50, 100].map((n) => <button key={n} type="button" className={'opt' + (per === n ? ' on' : '')} onClick={() => { setPer(n); setPage(0); }}>{n}</button>)}</div>
          <button className="btn sm" disabled={!pg} onClick={() => setPage(pg - 1)}>Previous</button>
          <span className="muted">Page {pg + 1} of {pages}</span>
          <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
        </div>
      </div>
    </Page>
  );
}

function FilterPop({ f, pages, people, set, close }: { f: F; pages: string[]; people: string[]; set: (p: Partial<F>) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.fp.more')) close(); };
    document.addEventListener('mousedown', k);
    return () => document.removeEventListener('mousedown', k);
  }, [close]);
  const flip = (k: 'page' | 'who', v: string) => set({ [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const sec = (title: string, k: 'page' | 'who', opts: string[]) => (
    <div><div className="gh" style={{ padding: '4px 8px 6px', borderBottom: '1px solid var(--bs)', marginBottom: 4 }}>{title}</div>
      {opts.length ? opts.map((o) => (
        <label key={o} className="check"><input type="checkbox" checked={f[k].includes(o)} onChange={() => flip(k, o)} />{k === 'who' ? shortName(o) : o}</label>
      )) : <div className="muted" style={{ padding: '5px 8px' }}>None yet</div>}
    </div>
  );
  return (
    <div className="hmenu pmenu" ref={ref}>
      <div className="cols">{sec('Page', 'page', pages)}{sec('Who', 'who', people)}</div>
      <div style={{ display: 'flex', padding: '8px 8px 0' }}><button type="button" className="lnk" onClick={() => { set({ page: [], who: [] }); close(); }}>Show All</button></div>
    </div>
  );
}

function useSigned(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    supabase().storage.from(BUCKET).createSignedUrl(path, 3600).then(({ data }) => { if (live) setUrl(data?.signedUrl || null); });
    return () => { live = false; };
  }, [path]);
  return path ? url : null;
}

function Player({ src, total }: { src: string | null; total: number }) {
  const a = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(total);
  const toggle = () => { const el = a.current; if (!el) return; if (el.paused) el.play().catch(() => {}); else el.pause(); };
  return (
    <div className="play">
      {src ? <audio ref={a} src={src} preload="metadata" onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => { setOn(false); setPos(0); }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setLen(d); }} /> : null}
      <button className="pbtn" onClick={toggle} disabled={!src} title={on ? 'Pause' : 'Play the recording'} aria-label={on ? 'Pause' : 'Play'}>{on ? <Icon.pause /> : <Icon.play />}</button>
      <div className="ptrack" onClick={(e) => {
        const el = a.current; if (!el || !len) return;
        const r = e.currentTarget.getBoundingClientRect(); el.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * len;
      }}><i style={{ width: (len ? Math.min(100, (pos / len) * 100) : 0) + '%' }} /></div>
      <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{secs(pos)} / {secs(len)}</span>
    </div>
  );
}

function Detail({ r, name, pg, tone, onSaved }: { r: Report; name: string; pg: string; tone: Tone; onSaved: () => void }) {
  const ui = useUI();
  const [pick, setPick] = useState<Status>(r.status);
  const [reply, setReply] = useState(r.reply || '');
  const [busy, setBusy] = useState(false);
  const shot = useSigned(r.screenshot_path);
  const audio = useSigned(r.audio_path);
  const title = summary(r);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase().from('problem_reports').update({ status: pick, reply: reply.trim() || null }).eq('id', r.id);
    setBusy(false);
    if (error) { ui.toast(error.message, true); return; }
    ui.close(); ui.toast('Report saved'); onSaved();
  };
  const tz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(r.created_at)).find((p) => p.type === 'timeZoneName')?.value;
  return (
    <div className="ov" onMouseDown={(e) => { if (e.target === e.currentTarget) ui.close(); }}>
      <div className="modal pd" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh"><h3><Badge tone={STONE[r.status]}>{r.status}</Badge><span>{title.length > 60 ? title.slice(0, 58) + '…' : title}</span></h3>
          <button className="x" onClick={ui.close} aria-label="Close">✕</button></div>
        <div className="mb">
          <div className="k">From</div>
          <div><span className="who-line"><span className={'av ' + tone}>{initials(r.who)}</span>{name}</span>{r.role ? <span className="muted"> · {ROLE[r.role] || r.role}</span> : null}</div>
          <div className="k">Page</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', whiteSpace: 'nowrap' }}>{pg}
            <a className="lnk" href={r.page} target="_blank" rel="noreferrer" title={'Opens ' + r.page + ' with the same address the reporter had'}>Open This Page</a></div>
          <div className="k">Sent</div><div>{when(r.created_at, true)}{tz ? <span className="muted"> · {tz}</span> : null}</div>
          <div className="k">Device</div><div className="muted">{r.device || 'Not recorded'}</div>
          <div className="k" style={{ alignSelf: 'start' }}>Notes</div><div className="fulltext">{r.notes || <span className="muted">(no notes)</span>}</div>
          {r.screenshot_path ? <>
            <div className="k" style={{ alignSelf: 'start' }}>Screenshot</div>
            <div>{shot ? (
              <a href={shot} target="_blank" rel="noreferrer" title="Click to open full size in a new window" style={{ width: 'fit-content', display: 'block' }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link to a private file */}
                <img className="pd-shot" src={shot} alt="Screenshot sent with the report" />
              </a>) : <span className="muted">Loading…</span>}</div>
          </> : null}
          {r.audio_path ? <>
            <div className="k" style={{ alignSelf: 'start' }}>Voice Note</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Player src={audio} total={r.audio_secs || 0} />
              {r.transcript ? <div className="transcript" title="Written out by the browser from the recording">{r.transcript}</div> : null}
            </div>
          </> : null}
          <div className="full reply" />
          <div className="k">Status</div>
          <div className="seg" style={{ width: 'fit-content' }}>
            {STATUSES.map((s) => <button key={s} type="button" className={'opt' + (s === pick ? ' on ' + STONE[s] : '')} title={STIP[s]} onClick={() => setPick(s)}>{s}</button>)}
          </div>
          <div className="k" style={{ alignSelf: 'start', paddingTop: 6 }}>Reply</div>
          <div><textarea className="in" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="What was done, or why not. Kept with the report; nothing is emailed." />
            {r.updated_by ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Last changed by {r.updated_by}{r.updated_at ? ' · ' + when(r.updated_at, true) : ''}</div> : null}</div>
        </div>
        <div className="mf">
          <button className="btn" onClick={ui.close}>Cancel</button>
          <button className="btn pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
