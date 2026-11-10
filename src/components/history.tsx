'use client';
// History: every action in the portal, written by the database itself (public.change_log, 0005_action_log.sql).
// Opens on the last 7 days; Who, What and Action sit behind Filters. A row opens the record before and after, the
// device, and every change to that record. Roll back is Treasurer only, with a reason, and is itself logged.
// The board sees everything; a team login sees its own team's history, read only, through public.change_log_team (anonymous donors masked).
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { initials } from '@/lib/format';
import { Badge, Modal, useUI, type Tone } from '@/components/ui';

export type LogRow = {
  id: number; at: string; user_id: string | null; who: string; role: string | null; action: string; what: string; tbl: string;
  record_id: string | null; label: string | null; summary: string | null; before: Record<string, unknown> | null;
  after: Record<string, unknown> | null; team_id: string | null; device: string | null; via: string | null; reason: string | null;
  rolls_back_id: number | null; rolled_back_at: string | null; rolled_back_by: string | null; rollback_reason: string | null;
};

const TONE: Record<string, Tone> = {
  Added: 'grn', Changed: 'blu', Deleted: 'red', Archived: 'red', Restored: 'grn', Approved: 'vio', Voted: 'vio', Declined: 'red',
  Paid: 'grn', Closed: 'gry', Cancelled: 'red', Refunded: 'amb', Reviewed: 'blu', Locked: 'gry', Unlocked: 'amb', Imported: 'amb', Synced: 'amb',
  Invited: 'blu', 'Signed In': 'gry', 'Signed Out': 'gry', Reversed: 'amb', 'Rolled Back': 'amb', Overrode: 'amb', 'Cleared Sample': 'gry',
};
const COLOR: Record<Tone, string> = { grn: 'var(--g)', blu: 'var(--blue)', red: 'var(--red)', vio: 'var(--vio)', amb: 'var(--amb)', gry: 'var(--t3)' };
const WHATS = ['Ledger', 'Requests', 'Donations', 'Grants', 'Teams', 'Bank', 'Sign-ins', 'Settings', 'Accounts', 'Documents', 'Meetings', 'Calendar', 'Problems'];
const ACTIONS = ['Added', 'Changed', 'Archived', 'Restored', 'Deleted', 'Approved', 'Declined', 'Paid', 'Reviewed', 'Cancelled', 'Refunded', 'Closed', 'Reversed', 'Locked', 'Unlocked',
  'Imported', 'Synced', 'Invited', 'Signed In', 'Signed Out', 'Rolled Back'];
const RANGES: [string, string][] = [['7', 'Last 7 Days'], ['30', 'Last 30 Days'], ['all', 'All Time']];
const SORTS: [keyof LogRow, string][] = [['at', 'When'], ['who', 'Who'], ['action', 'Action'], ['label', 'Record'], ['summary', 'What Changed']];
const OPEN: Record<string, [string, string]> = {
  Ledger: ['/ledger', 'Open In Ledger'], Requests: ['/requests', 'Open In Requests'], Donations: ['/donors', 'Open In Donors'],
  Grants: ['/grants', 'Open In Grants'], Teams: ['/balances', 'Open In Team Balances'], Bank: ['/balances', 'Open In Team Balances'],
  Accounts: ['/accounts', 'Open In Accounts'], Documents: ['/documents', 'Open In Documents'], Meetings: ['/meetings', 'Open In Meetings'],
  Calendar: ['/calendar', 'Open In Calendar'], Problems: ['/problems', 'Open In Problem Reports'],
};
const ROLE: Record<string, string> = { treasurer: 'Treasurer', board: 'Board', bookkeeper: 'Bookkeeper', cpa: 'CPA', team: 'Team login', system: 'Automatic' };
const HIDE = new Set(['sample', 'created_at']);

type F = { range: string; who: string[]; what: string[]; act: string[]; q: string; rec: { tbl: string; id: string; label: string } | null };
const fresh = (): F => ({ range: '7', who: [], what: [], act: [], q: '', rec: null });

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(ts: string, year?: boolean) {
  const d = new Date(ts);
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${MON[d.getMonth()]} ${d.getDate()}${year ? ', ' + d.getFullYear() : ''}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}
const shortWho = (w: string) => w.replace(/ —.*/, '').replace(/ \(.*/, '');

/** "Chrome on Windows" from a browser's user agent; a job's own description is shown as it is. */
export function deviceLabel(ua: string | null) {
  if (!ua) return 'Not recorded';
  if (!/Mozilla|AppleWebKit|Gecko/.test(ua)) return ua;
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'Chromebook'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'an unknown device';
  return `${b} on ${o}`;
}

const fieldName = (k: string) => k.replace(/_id$/, '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
function show(v: unknown) {
  if (v === undefined || v === null) return <span className="none">—</span>;
  if (v === '') return <span className="none">(blank)</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function since(range: string) {
  if (range === 'all') return null;
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (Number(range) - 1));
  return d.toISOString();
}

export function History({ canRollBack, team }: { canRollBack: boolean; team?: boolean }) {
  const ui = useUI();
  const [f, setF] = useState<F>(fresh);
  const [sort, setSort] = useState<{ k: keyof LogRow; asc: boolean }>({ k: 'at', asc: false });
  const [page, setPage] = useState(0);
  const [per, setPer] = useState(25);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [count, setCount] = useState(0);
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    let q = supabase().from(team ? 'change_log_team' : 'change_log').select('*', { count: 'exact' });
    const s = since(f.range);
    if (s && !f.rec) q = q.gte('at', s);
    if (f.who.length) q = q.in('who', f.who);
    if (f.what.length) q = q.in('what', f.what);
    if (f.act.length) q = q.in('action', f.act);
    if (f.rec) q = q.eq('tbl', f.rec.tbl).eq('record_id', f.rec.id);
    const term = f.q.trim().replace(/[%,()*]/g, ' ').trim();
    if (term) q = q.or(`label.ilike.%${term}%,summary.ilike.%${term}%,who.ilike.%${term}%`);
    q = q.order(sort.k, { ascending: sort.asc }).order('id', { ascending: sort.asc }).range(page * per, page * per + per - 1);
    q.then(({ data, error, count: n }) => {
      if (!live) return;
      setBusy(false);
      if (error) { setErr(error.message); return; }
      setErr(null); setRows((data || []) as LogRow[]); setCount(n || 0);
    });
    return () => { live = false; };
  }, [f, sort, page, per, tick, team]);

  // Who to offer in Filters: everyone in the log for the range shown.
  useEffect(() => {
    let live = true;
    let q = supabase().from(team ? 'change_log_team' : 'change_log').select('who').order('at', { ascending: false }).limit(2000);
    const s = since(f.range);
    if (s) q = q.gte('at', s);
    q.then(({ data }) => { if (live && data) setPeople([...new Set((data as { who: string }[]).map((r) => r.who))].sort()); });
    return () => { live = false; };
  }, [f.range, tick, team]);

  const upd = (p: Partial<F>) => { setF((x) => ({ ...x, ...p })); setPage(0); };
  const hidden = f.who.length + f.what.length + f.act.length > 0;
  const any = hidden || f.range !== '7' || !!f.rec || !!f.q;
  const pages = Math.max(1, Math.ceil(count / per));
  const open = (r: LogRow) => ui.open(<Detail r={r} canRollBack={canRollBack} team={team} onRecord={(rec) => { ui.close(); upd({ rec }); }} onDone={reload} />);

  return (
    <div className="panel hist">
      <div className="frow">
        {RANGES.map(([k, l]) => <button key={k} type="button" className={'fp' + (f.range === k && !f.rec ? ' on' : '')} onClick={() => upd({ range: k, rec: null })}>{l}</button>)}
        <span className="fwrap">
          <button type="button" className="fp more" onClick={() => setMenu((m) => !m)} title="Who, What and Action">Filters{hidden ? <span className="dot" /> : null}</button>
          {menu ? <FilterPop f={f} people={people} team={team} set={upd} close={() => setMenu(false)} /> : null}
        </span>
        {f.rec ? <button type="button" className="fp on" onClick={() => upd({ rec: null })} title="Showing every change to this one record. Click to show all records again."><span className="fk">Record</span>{f.rec.label}<span className="clr">×</span></button> : null}
        {any ? <button type="button" className="lnk" style={{ flex: 'none', marginLeft: 8 }} onClick={() => { setF(fresh()); setPage(0); setMenu(false); }}>Clear Filters</button> : null}
        <input className="in srch" placeholder="Search records, people, changes" value={f.q} onChange={(e) => upd({ q: e.target.value })} />
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>{SORTS.map(([k, l]) => (
              <th key={k} className={sort.k === k ? 'sort' : ''} onClick={() => { setSort((s) => (s.k === k ? { k, asc: !s.asc } : { k, asc: k !== 'at' })); setPage(0); }}>
                {l}{sort.k === k ? <span className="ar">{sort.asc ? '▲' : '▼'}</span> : null}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((r) => {
              const t = TONE[r.action] || 'gry';
              return (
                <tr key={r.id} className={'rowlink' + (r.rolled_back_at ? ' rb' : '')} onClick={() => open(r)}>
                  <td>{when(r.at)}</td>
                  <td title={[r.who, ROLE[r.role || ''] || '', deviceLabel(r.device)].filter(Boolean).join(' · ')}>{shortWho(r.who)}</td>
                  <td><span className="act" style={{ color: COLOR[t] }}><i />{r.action}</span>
                    {r.rolled_back_at ? <span className="rbt" title={'Undone ' + when(r.rolled_back_at, true) + ' by ' + (r.rolled_back_by || '') + ': ' + (r.rollback_reason || '')}>Rolled Back</span> : null}</td>
                  <td className="rec" title={r.label || ''}>{r.label || r.tbl}</td>
                  <td className="chg" title={r.summary || ''}>{r.summary || ''}</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={5} className="hempty">
                {busy ? 'Loading…' : err ? <>Could not load the history: {err}</> : <><b>No changes match these filters</b>Every action is still being recorded. Try All Time or clear a filter.
                  {any ? <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => { setF(fresh()); setPage(0); }}>Clear Filters</button></div> : null}</>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span className="muted">{count ? `${page * per + 1}–${Math.min(count, page * per + per)} of ${count} changes` : '0 changes'}</span>
        <span className="sp" />
        <span className="muted">Rows</span>
        <div className="seg">{[25, 50, 100].map((n) => <button key={n} type="button" className={'opt' + (per === n ? ' on' : '')} onClick={() => { setPer(n); setPage(0); }}>{n}</button>)}</div>
        <button className="btn sm" disabled={!page} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span className="muted">Page {page + 1} of {pages}</span>
        <button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}

function FilterPop({ f, people, team, set, close }: { f: F; people: string[]; team?: boolean; set: (p: Partial<F>) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.fp.more')) close(); };
    document.addEventListener('mousedown', k);
    return () => document.removeEventListener('mousedown', k);
  }, [close]);
  const flip = (k: 'who' | 'what' | 'act', v: string) => set({ [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const grp = (title: string, k: 'who' | 'what' | 'act', opts: string[], label = (s: string) => s) => (
    <div className="grp"><div className="gh">{title}</div><div className="chips">
      {opts.map((o) => <button key={o} type="button" className={'fp' + (f[k].includes(o) ? ' on' : '')} onClick={() => flip(k, o)}>{label(o)}</button>)}
    </div></div>
  );
  return (
    <div className="hmenu" ref={ref}>
      {grp('Who', 'who', people, shortWho)}
      {grp('What', 'what', team ? ['Requests', 'Donations', 'Teams', 'Ledger', 'Calendar', 'Sign-ins'] : WHATS)}
      {grp('Action', 'act', ACTIONS)}
      <div className="ft"><span className="muted">Nothing selected shows everything</span><span className="sp" />
        <button type="button" className="lnk" onClick={() => set({ who: [], what: [], act: [] })}>Reset</button></div>
    </div>
  );
}

function Detail({ r, canRollBack, team, onRecord, onDone }: {
  r: LogRow; canRollBack: boolean; team?: boolean; onRecord: (rec: F['rec']) => void; onDone: () => void;
}) {
  const ui = useUI();
  const [same, setSame] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    if (r.record_id) {
      supabase().from(team ? 'change_log_team' : 'change_log').select('id', { count: 'exact', head: true }).eq('tbl', r.tbl).eq('record_id', r.record_id)
        .then(({ count }) => { if (live) setSame(count ?? null); });
    }
    return () => { live = false; };
  }, [r.tbl, r.record_id, team]);
  const keys = [...new Set([...Object.keys(r.before || {}), ...Object.keys(r.after || {})])].filter((k) => !HIDE.has(k));
  const changed = (k: string) => JSON.stringify(r.before?.[k] ?? null) !== JSON.stringify(r.after?.[k] ?? null);
  // changed fields first, then the rest of the record for context
  keys.sort((a, b) => Number(changed(b)) - Number(changed(a)));
  const t = TONE[r.action] || 'gry';
  const link = !team ? OPEN[r.what] : undefined;
  const why = r.tbl === 'sessions' ? 'A sign-in cannot be rolled back' : r.rolled_back_at ? 'Already rolled back'
    : r.rolls_back_id ? 'This is itself a roll back' : ['zeffy_sync_log', 'money_overrides', 'zeffy_skip'].includes(r.tbl) ? 'This record cannot be rolled back' : '';
  const rbLabel = r.action === 'Locked' ? 'Unlock The Month' : 'Roll Back This Change';
  const rbTip = r.action === 'Locked' ? 'Unlocks the month, with your reason' : !r.before ? (r.tbl === 'ledger' ? 'Reverses this entry in the ledger' : 'Takes this record out (archived, never deleted)')
    : !r.after ? 'Restores the deleted record exactly as it was' : r.action === 'Paid' ? 'Reverses the payment in the ledger, then steps the request back' : 'Puts every changed field back to its Before value';

  const rollBack = async () => {
    const reason = await ui.ask({
      title: 'Roll Back This Change?',
      body: <>This puts <b>{r.label || r.tbl}</b> back the way it was before {shortWho(r.who)}’s change on {when(r.at)}. The roll back is itself logged in History as a new change by you, with this reason. Nothing is erased.</>,
      ok: 'Roll Back', label: 'Reason', placeholder: 'Required: why this change should not be there', danger: true,
    });
    if (!reason) return;
    const { error } = await supabase().rpc('rollback_change', { p_id: r.id, p_reason: reason });
    if (error) { ui.toast(error.message, true); return; }
    ui.close(); ui.toast('Change rolled back and logged'); onDone();
  };

  return (
    <Modal wide title={r.action + ' · ' + (r.label || r.tbl)} foot={<>
      <button className="btn" onClick={ui.close}>Cancel</button>
      {canRollBack ? (why
        ? <span title={why}><button className="btn amb-btn" disabled>{rbLabel}</button></span>
        : <button className="btn amb-btn" title={rbTip} onClick={rollBack}>{rbLabel}</button>) : null}
    </>}>
      <div className="k">Who</div>
      <div><span className="who-line"><span className={'av ' + (r.role === 'system' ? 'gry' : r.role === 'team' ? 'blu' : 'grn')}>{r.role === 'system' ? 'S' : initials(r.who)}</span>{r.who}</span>
        {r.role ? <span className="muted"> · {ROLE[r.role] || r.role}</span> : null}</div>
      <div className="k">When</div><div>{when(r.at, true)} <span className="muted">· your time</span></div>
      <div className="k">Device</div><div className="muted">{deviceLabel(r.device)}</div>
      <div className="k">Action</div><div><Badge tone={t}>{r.action}</Badge>{r.reason ? <span className="muted"> · {r.reason}</span> : null}</div>
      <div className="k">Record</div>
      <div className="rec-line">{r.label || r.tbl}{link ? <a className="lnk" href={link[0]}>{link[1]}</a> : null}</div>
      {r.record_id ? <><div className="k" /><div><button type="button" className="lnk" onClick={() => onRecord({ tbl: r.tbl, id: r.record_id!, label: r.label || r.record_id! })}>
        All changes to this record{same != null ? ` (${same})` : ''}</button></div></> : null}
      {keys.length ? (
        <div className="full scroll">
          <table className="diff">
            <thead><tr><th className="nosort">Field</th><th className="nosort">Before</th><th className="nosort">After</th></tr></thead>
            <tbody>{keys.map((k) => {
              const ch = changed(k);
              const b = r.before?.[k], a = r.after?.[k];
              return (
                <tr key={k} className={ch ? 'ch' : ''}>
                  <td className="f">{fieldName(k)}</td>
                  <td className={ch && b != null && b !== '' ? 'old' : ''}>{r.before ? show(b) : <span className="none">—</span>}</td>
                  <td className={ch && a != null && a !== '' ? 'new' : ''}>{r.after ? show(a) : <span className="none">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : null}
      {r.rolled_back_at ? <div className="full"><Badge tone="amb">Rolled Back</Badge> <span className="muted">{when(r.rolled_back_at, true)} by {r.rolled_back_by}: {r.rollback_reason}</span></div> : null}
    </Modal>
  );
}
