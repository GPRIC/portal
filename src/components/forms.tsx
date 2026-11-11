'use client';
// Form pieces shared by the board pages: inputs, fund pickers, file pickers and links, and the delete step.
import type { ReactNode } from 'react';
import { money } from '@/lib/format';
import { useData, openFile } from './data';
import { useUI } from './ui';

export function Txt({ value, onChange, ...p }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; type?: string; autoFocus?: boolean }) {
  return <input className="in" {...p} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}
export function Area({ value, onChange, placeholder }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string }) {
  return <textarea className="in" rows={3} placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}
export function DateIn({ value, onChange }: { value: string | null | undefined; onChange: (v: string) => void }) {
  return <input className="in" type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}
/** Amounts are typed as text so a half-typed number is never thrown away. */
export function Amount({ value, onChange, placeholder = '0.00' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="in" type="number" step="0.01" min="0" inputMode="decimal" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />;
}
export const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
export const str = (n: number | null | undefined) => (n == null ? '' : String(n));
export const orNull = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

export function Select<V extends string>({ value, onChange, options, blank }: { value: V | '' | null | undefined; onChange: (v: V | '') => void; options: [V, string][]; blank?: string }) {
  return (
    <select className="in" value={value ?? ''} onChange={(e) => onChange(e.target.value as V | '')}>
      {blank != null ? <option value="">{blank}</option> : null}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function FundSelect({ value, onChange, balances, blank }: { value: string | null | undefined; onChange: (v: string) => void; balances?: boolean; blank?: string }) {
  const { db, calc } = useData();
  return (
    <Select value={value} onChange={onChange} blank={blank}
      options={db.funds.filter((f) => !f.archived_at || f.id === value).slice().sort((a, b) => a.name.localeCompare(b.name)).map((f) => [f.id, f.name + (balances ? ' · ' + money(calc.fundBalance(f.id)) : '')])} />
  );
}

export function FileLink({ path, name, label }: { path: string | null | undefined; name?: string | null; label?: string }) {
  if (!path) return null;
  // A link, not a button, so it still opens inside a read-only (disabled) form.
  return <a href="#" role="button" className="doclink" onClick={(e) => { e.preventDefault(); openFile(path); }}>{label || name || 'Open file'}</a>;
}

/** A file already saved (with open and remove), or a picker for a new one. */
export function FilePick({ file, onFile, path, name, onRemove, accept }: {
  file: File | null; onFile: (f: File | null) => void; path?: string | null; name?: string | null; onRemove?: () => void; accept?: string;
}) {
  if (path && !file) {
    return (
      <span className="btnrow">
        <FileLink path={path} name={name} />
        {onRemove ? <button type="button" className="btn sm" onClick={onRemove}>Remove</button> : null}
      </span>
    );
  }
  return <input className="in" type="file" accept={accept} onChange={(e) => onFile(e.target.files?.[0] || null)} />;
}

/** Footer: Archive (or Reverse) on the left, Cancel and the main button on the right. Nothing is deleted. */
export function Foot({ onDelete, deleteLabel = 'Archive', onSave, saveLabel = 'Save', busy, extra }: { onDelete?: () => void; deleteLabel?: string; onSave?: () => void; saveLabel?: string; busy?: boolean; extra?: ReactNode }) {
  const ui = useUI();
  return (
    <>
      <span>{onDelete ? <button type="button" className="btn dan" onClick={onDelete} disabled={busy}>{deleteLabel}</button> : null}</span>
      <span className="btnrow">
        <button type="button" className="btn" onClick={ui.close}>Cancel</button>
        {extra}
        {onSave ? <button type="button" className="btn pri" onClick={onSave} disabled={busy}>{busy ? 'Saving…' : saveLabel}</button> : null}
      </span>
    </>
  );
}

export function Err({ msg }: { msg: string | null }) {
  return <div className="full err">{msg || ''}</div>;
}

/** Opens a document from the register: its uploaded file, or its link. */
export function DocOpen({ doc, label }: { doc: { file_path: string | null; file_name?: string | null; link: string | null; title: string }; label?: string }) {
  if (doc.file_path) return <FileLink path={doc.file_path} name={label || doc.title} />;
  if (doc.link) return <a className="doclink" href={doc.link} target="_blank" rel="noopener noreferrer">{label || doc.title}</a>;
  return <span>{label || doc.title}</span>;
}
