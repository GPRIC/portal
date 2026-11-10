'use client';
// Shared building blocks, matching the demo's shared/ui.js: cards, attention items, pills, sortable tables, modals, toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export type Tone = 'gry' | 'grn' | 'red' | 'amb' | 'blu' | 'vio';

export const ST: Record<string, Tone> = {
  Draft: 'gry', Submitted: 'blu', 'Board Vote': 'vio', Approved: 'grn', Paid: 'grn', 'Receipts Due': 'amb', Closed: 'gry', Declined: 'red',
  Prospect: 'blu', Drafting: 'vio', Applied: 'amb', Awarded: 'grn',
};

export function Badge({ tone = 'gry', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={'badge ' + tone}>{children}</span>;
}
export function St({ s }: { s: string }) {
  return <Badge tone={ST[s] || 'gry'}>{s}</Badge>;
}
export const Dash = () => <span className="muted">—</span>;

/** Lines for a hover tip; an empty list shows the fallback. */
export function Lines({ lines, none = 'None.' }: { lines: ReactNode[]; none?: string }) {
  if (!lines.length) return <>{none}</>;
  return <>{lines.map((l, i) => <div key={i}>{l}</div>)}</>;
}

export function Card({ n, v, tip, color, href, id }: { n: string; v: ReactNode; tip?: ReactNode; color?: string; href?: string; id?: string }) {
  const router = useRouter();
  return (
    <div className={'card' + (href ? ' link' : '')} id={id} tabIndex={tip || href ? 0 : undefined}
      onClick={href ? () => router.push(href) : undefined}
      onKeyDown={href ? (e) => { if (e.key === 'Enter') router.push(href); } : undefined}>
      <div className="n">{n}</div>
      <div className="v" style={color ? { color: `var(--${color})` } : undefined}>{v}</div>
      {tip ? <div className="tip">{tip}</div> : null}
    </div>
  );
}

export type AttnItem = { r: number; d: string; tone: Tone; t1: string; t2?: string; href?: string };
export function Attn({ items }: { items: AttnItem[] }) {
  const router = useRouter();
  if (!items.length) return <div className="empty">Nothing needs attention.</div>;
  return (
    <div className="att">
      {items.map((i, k) => (
        <button type="button" className="ai" key={k} onClick={i.href ? () => router.push(i.href!) : undefined}>
          <div className={'d ' + i.tone}>{i.d}</div>
          <div style={{ minWidth: 0 }}>
            <div className="t1">{i.t1}</div>
            <div className="muted t1">{i.t2 || ''}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

export type Pill = { key: string; label: string; tone?: Tone; count?: number };
export function Pills({ items, active, onPick }: { items: Pill[]; active: string; onPick: (k: string) => void }) {
  return (
    <div className="pills">
      {items.map((p) => (
        <button type="button" key={p.key} className={'pill ' + (p.tone || 'gry') + (p.key === active ? ' on' : '')} onClick={() => onPick(p.key)}>
          {p.label}{p.count != null ? ' ' + p.count : ''}
        </button>
      ))}
    </div>
  );
}

export type Col<T> = {
  k: string; label: string; num?: boolean; nosort?: boolean; desc?: boolean;
  sv?: (r: T) => string | number | boolean | null | undefined; html?: (r: T) => ReactNode;
};
export function Table<T extends { id: string }>({ cols, rows, sort, dir = 1, onRow, empty, foot }: {
  cols: Col<T>[]; rows: T[]; sort?: string; dir?: 1 | -1; onRow?: (r: T) => void; empty?: string; foot?: ReactNode;
}) {
  const [st, setSt] = useState<{ k: string; dir: number }>({ k: sort || cols[0].k, dir });
  const col = cols.find((c) => c.k === st.k) || cols[0];
  const sv = (r: T) => {
    const v = col.sv ? col.sv(r) : (r as Record<string, unknown>)[col.k];
    if (v == null) return '';
    if (typeof v === 'string') return v.toLowerCase();
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as number;
  };
  const data = rows.slice().sort((a, b) => { const x = sv(a), y = sv(b); return (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            {cols.map((c) => {
              const on = c.k === st.k && !c.nosort;
              return (
                <th key={c.k} className={(c.num ? 'num ' : '') + (on ? 'sort ' : '') + (c.nosort ? 'nosort' : '')}
                  onClick={c.nosort ? undefined : () => setSt(st.k === c.k ? { k: c.k, dir: -st.dir } : { k: c.k, dir: c.num || c.desc ? -1 : 1 })}>
                  {c.label}{on ? <span className="ar">{st.dir > 0 ? '▲' : '▼'}</span> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.length ? data.map((r) => (
            <tr key={r.id} className={onRow ? 'rowlink' : ''} onClick={onRow ? (e) => { if ((e.target as HTMLElement).closest('a,button')) return; onRow(r); } : undefined}>
              {cols.map((c) => {
                const v = c.html ? c.html(r) : ((r as Record<string, unknown>)[c.k] as ReactNode);
                return <td key={c.k} className={c.num ? 'num' : undefined}>{v === '' || v == null || v === false ? <Dash /> : v}</td>;
              })}
            </tr>
          )) : (
            <tr><td colSpan={cols.length} className="empty">{empty || 'Nothing here yet.'}</td></tr>
          )}
        </tbody>
        {foot ? <tfoot>{foot}</tfoot> : null}
      </table>
    </div>
  );
}

export function Kv({ k, children, className }: { k: string; children?: ReactNode; className?: string }) {
  return (
    <>
      <div className={'k ' + (className || '')}>{k}</div>
      <div className={className}>{children === '' || children == null ? <Dash /> : children}</div>
    </>
  );
}

export function Seg<V extends string>({ value, options, onChange }: { value: V; options: (V | [V, string])[]; onChange: (v: V) => void }) {
  return (
    <div className="seg">
      {options.map((o) => {
        const v = (Array.isArray(o) ? o[0] : o) as V;
        const l = Array.isArray(o) ? o[1] : o;
        return <button type="button" key={v} className={'opt' + (v === value ? ' on' : '')} onClick={() => onChange(v)}>{l}</button>;
      })}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}</label>;
}

type StepState = 'done' | 'now' | 'late' | 'todo' | 'no';
const STEP_C: Record<StepState, string> = { done: 'var(--g)', now: 'var(--amb)', late: 'var(--red)', todo: 'var(--hint)', no: 'var(--red)' };
export function Steps({ list }: { list: [StepState, string, string?][] }) {
  return (
    <div className="steps full">
      {list.map((s, i) => <div className="step" key={i}><span className="dot" style={{ background: STEP_C[s[0]] }} />{s[1]}<span className="when">{s[2] || ''}</span></div>)}
    </div>
  );
}

export function Warnings({ list, blocks }: { list: string[]; blocks?: boolean }) {
  if (!list.length) return null;
  return <div className="full warn">{list.map((w, i) => <div key={i}>{w}</div>)}<div className="muted" style={{ marginTop: 4 }}>{blocks ? 'This will be blocked. Only the Treasurer can override it, with a reason.' : 'This is a warning only. You can still save.'}</div></div>;
}

/** A modal that asks for a reason (archive, reverse, unlock, override). Resolves to the trimmed text, or null on cancel. */
function AskModal({ o, done }: { o: AskOpts; done: (v: string | null) => void }) {
  const [v, setV] = useState(o.initial || '');
  const ok = v.trim().length > 0 || o.optional;
  return (
    <Modal title={o.title} onClose={() => done(null)}
      foot={<><button className="btn" onClick={() => done(null)}>Cancel</button><button className={'btn ' + (o.danger ? 'dan' : 'pri')} disabled={!ok} onClick={() => done(v.trim())}>{o.ok}</button></>}>
      {o.body ? <div className="full" style={{ lineHeight: 1.55 }}>{o.body}</div> : null}
      <div className="full"><label className="muted" style={{ fontSize: 12 }}>{o.label || 'Reason'}</label>
        <textarea className="in" rows={3} autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={o.placeholder} /></div>
    </Modal>
  );
}
export type AskOpts = { title: string; body?: ReactNode; ok: string; label?: string; placeholder?: string; danger?: boolean; optional?: boolean; initial?: string };

/* ---------- modal + toast host ---------- */
type UICtx = {
  open: (node: ReactNode) => void;
  close: () => void;
  toast: (msg: string, bad?: boolean) => void;
  confirm: (o: { title: string; body: ReactNode; ok: string; danger?: boolean }) => Promise<boolean>;
  /** Asks for a reason; null when cancelled. */
  ask: (o: AskOpts) => Promise<string | null>;
};
const Ctx = createContext<UICtx | null>(null);
export function useUI() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUI outside UIProvider');
  return c;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ReactNode[]>([]);
  const [toastMsg, setToast] = useState<{ m: string; bad?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = useCallback((node: ReactNode) => setStack((s) => [...s, node]), []);
  const close = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const toast = useCallback((m: string, bad?: boolean) => {
    setToast({ m, bad });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), bad ? 5000 : 2400);
  }, []);
  const confirm = useCallback((o: { title: string; body: ReactNode; ok: string; danger?: boolean }) => new Promise<boolean>((resolve) => {
    const done = (v: boolean) => { setStack((s) => s.slice(0, -1)); resolve(v); };
    setStack((s) => [...s, (
      <Modal key={'c' + Date.now()} title={o.title} onClose={() => done(false)}
        foot={<><button className="btn" onClick={() => done(false)}>Cancel</button><button className={'btn ' + (o.danger ? 'dan' : 'pri')} onClick={() => done(true)}>{o.ok}</button></>}>
        <div className="full" style={{ lineHeight: 1.55 }}>{o.body}</div>
      </Modal>
    )]);
  }), []);
  const ask = useCallback((o: AskOpts) => new Promise<string | null>((resolve) => {
    const done = (v: string | null) => { setStack((s) => s.slice(0, -1)); resolve(v); };
    setStack((s) => [...s, <AskModal key={'a' + Date.now()} o={o} done={done} />]);
  }), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setStack((s) => s.slice(0, -1)); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  const value = useMemo(() => ({ open, close, toast, confirm, ask }), [open, close, toast, confirm, ask]);
  return (
    <Ctx.Provider value={value}>
      <HostCtx.Provider value={{ stack, toastMsg }}>{children}</HostCtx.Provider>
    </Ctx.Provider>
  );
}

const HostCtx = createContext<{ stack: ReactNode[]; toastMsg: { m: string; bad?: boolean } | null }>({ stack: [], toastMsg: null });
/** Where open modals and the toast render. Placed inside the data provider so modals can read the live data. */
export function UIHost() {
  const { stack, toastMsg } = useContext(HostCtx);
  return (
    <>
      {stack.map((n, i) => <div key={i} style={{ display: i === stack.length - 1 ? undefined : 'none' }}>{n}</div>)}
      {toastMsg ? <div className={'toast' + (toastMsg.bad ? ' bad' : '')} role="status">{toastMsg.m}</div> : null}
    </>
  );
}

export function Modal({ title, children, foot, wide, onClose }: { title: string; children: ReactNode; foot?: ReactNode; wide?: boolean; onClose?: () => void }) {
  const ui = useContext(Ctx);
  const close = onClose || ui?.close || (() => {});
  return (
    <div className="ov" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh"><h3>{title}</h3><button className="x" onClick={close} aria-label="Close">✕</button></div>
        <div className="mb">{children}</div>
        {foot ? <div className="mf">{foot}</div> : null}
      </div>
    </div>
  );
}
