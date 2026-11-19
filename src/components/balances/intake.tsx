'use client';
// Statement Intake (mockup "Portal Statement Intake" v3): drop Citizens statement PDFs and Zeffy exports, the portal
// reads them in the browser, shows what each file is and whether it proves itself, then imports them and opens the
// month's bank lines with their matches ready to confirm. A statement is taken only when its lines add up from the
// Previous Balance to the Current Balance and every day agrees with its Daily Balance table (statement-pdf.ts).
// Lives in the right page margin on wide screens; a Drop Files button in the header otherwise.
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { rpc, uploadFile, useData } from '@/components/data';
import { Badge, Modal, useUI, type Tone } from '@/components/ui';
import { supabase } from '@/lib/supabase/client';
import { monthName } from '@/lib/format';
import { parseCitizensStatement, type ParsedStatement, type StatementLine } from '@/lib/statement-pdf';
import type { ZeffyRow } from '@/lib/zeffy';
import { cash, Hint } from './hint';
import { ensureStatement, StatementModal } from './reconcile';
import { readZeffyFile } from './zeffy';

type Item =
  | { file: File; kind: 'bank'; st: ParsedStatement; fresh: StatementLine[]; state: 'ok' | 'bad' | 'loaded' | 'locked' }
  | { file: File; kind: 'zeffy'; rows: ZeffyRow[]; fresh: number; state: 'ok' }
  | { file: File; kind: 'other'; why: string; state: 'bad' };

const UPLOAD = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
);

function useDropFiles() {
  const ui = useUI();
  const input = useRef<HTMLInputElement>(null);
  const take = (list: FileList | null | undefined) => {
    const files = list ? [...list] : [];
    if (files.length) ui.open(<IntakeModal files={files} />);
    if (input.current) input.current.value = '';
  };
  const picker = <input ref={input} className="bal-file" type="file" multiple accept=".pdf,.xlsx,application/pdf" onChange={(e) => take(e.target.files)} />;
  return { take, picker, choose: () => input.current?.click() };
}

/** The drop panel in the right page margin (wide screens only; see balances.css). */
export function IntakePanel() {
  const { readOnly } = useData();
  const { take, picker, choose } = useDropFiles();
  const [over, setOver] = useState(false);
  if (readOnly) return null;
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); };
  return (
    <div className="intake-anchor">
      <div className="panel intake">
        <div className="ph"><h2>Statement Intake</h2><Hint r tip="Drop the monthly Citizens statement PDF and the Zeffy All Payments export. The portal reads them, checks each statement adds up, loads the bank lines and gifts, and matches them to the books."><span className="info">?</span></Hint></div>
        <div className={'intake-drop' + (over ? ' over' : '')} onClick={choose}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
          <b>Drop Bank Statements<br />Or Zeffy Exports</b>
          <span>Citizens PDF, Zeffy .xlsx</span>
          <button className="btn sm" onClick={(e) => { e.stopPropagation(); choose(); }}>Choose Files</button>
        </div>
        {picker}
      </div>
    </div>
  );
}

/** The same intake as a header button, for windows too narrow for the margin panel. */
export function IntakeButton() {
  const { readOnly } = useData();
  const { picker, choose } = useDropFiles();
  if (readOnly) return null;
  return <><button className="btn intake-btn" onClick={choose}>{UPLOAD}Drop Files</button>{picker}</>;
}

const dayAmount = (l: { date: string; amount: number }) => `${l.date}|${l.amount.toFixed(2)}`;

function IntakeModal({ files }: { files: File[] }) {
  const { db, run } = useData();
  const ui = useUI();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const out: Item[] = [];
      for (const file of files) {
        try {
          if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
            const { pdfItems } = await import('@/lib/pdf-items');
            const st = parseCitizensStatement(await pdfItems(file));
            if (!st.month) { out.push({ file, kind: 'other', why: st.problems[0] || 'Not a Citizens statement.', state: 'bad' }); continue; }
            const have = db.bank_statements.find((s) => s.month === st.month);
            // lines already on the statement, counted by date and amount (descriptions are not compared)
            const left = new Map<string, number>();
            for (const b of db.bank_lines.filter((x) => have && x.statement_id === have.id)) left.set(dayAmount(b), (left.get(dayAmount(b)) || 0) + 1);
            const fresh = st.lines.filter((l) => { const n = left.get(dayAmount(l)) || 0; if (n) { left.set(dayAmount(l), n - 1); return false; } return true; });
            const state = st.problems.length ? 'bad' : have?.locked_at ? 'locked' : !fresh.length && have?.file_path ? 'loaded' : 'ok';
            out.push({ file, kind: 'bank', st, fresh, state });
          } else if (/\.xlsx$/i.test(file.name)) {
            const rows = await readZeffyFile(file);
            const known = new Set(db.donations.map((d) => d.zeffy_key).filter(Boolean));
            out.push({ file, kind: 'zeffy', rows, fresh: rows.filter((r) => !known.has(r.key)).length, state: 'ok' });
          } else {
            out.push({ file, kind: 'other', why: 'Only Citizens statement PDFs and Zeffy .xlsx exports can be read here.', state: 'bad' });
          }
        } catch (e) {
          out.push({ file, kind: 'other', why: (e as Error).message || 'The file could not be read.', state: 'bad' });
        }
      }
      if (live) setItems(out);
    })();
    return () => { live = false; };
    // read once, against the books as they were when the files were dropped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const ready = (items || []).filter((i) => i.state === 'ok');

  const go = async () => {
    setBusy(true);
    const zeffy = ready.filter((i) => i.kind === 'zeffy');
    const banks = ready.flatMap((i) => (i.kind === 'bank' ? [i] : [])).sort((a, b) => (a.st.month < b.st.month ? -1 : 1));
    let lines = 0, gifts = 0;
    // Zeffy first, so the payouts are there for the bank deposits to match
    const res = await run(async () => {
      for (const z of zeffy) {
        if (z.kind !== 'zeffy') continue;
        const r = await supabase().rpc('zeffy_upsert', { p_rows: z.rows, p_source: 'file' });
        if (r.error) return r;
        gifts += z.fresh;
      }
      for (const b of banks) {
        const have = db.bank_statements.find((s) => s.month === b.st.month);
        const s = await ensureStatement(b.st.month, have);
        if ('error' in s) return { error: { message: s.error } };
        const p: Record<string, unknown> = { ending_balance: b.st.closing };
        if (!have?.file_path) {
          const up = await uploadFile('bank-statements', b.file);
          if ('error' in up) return { error: { message: up.error } };
          p.file_path = up.path; p.file_name = up.name;
        }
        const a = await rpc('bank_statement_set', { p_id: s.id, p });
        if (a.error) return a;
        if (b.fresh.length) {
          const r = await rpc('bank_lines_add', { p_statement_id: s.id, p_rows: b.fresh });
          if (r.error) return r;
          lines += b.fresh.length;
        }
      }
      return { error: null };
    });
    setBusy(false);
    if (res === false) return;
    ui.toast([lines ? `${lines} bank lines` : '', gifts ? `${gifts} new gifts` : ''].filter(Boolean).join(' and ') + (lines || gifts ? ' imported' : 'Files imported'));
    ui.close();
    // the oldest month brought in opens with its matches ready to confirm
    if (banks.length) ui.open(<StatementModal month={banks[0].st.month} />);
  };

  const badge = (i: Item): { tone: Tone; text: string; tip: string } => {
    if (i.kind === 'other') return { tone: 'red', text: 'Cannot Read', tip: i.why };
    if (i.kind === 'zeffy') return { tone: 'grn', text: 'Ready', tip: `${i.rows.length} gifts in the file. Gifts already in the portal are refreshed, never doubled.` };
    if (i.state === 'bad') return { tone: 'red', text: 'Does Not Add Up', tip: i.st.problems.join(' ') + ' Nothing from this file is imported.' };
    if (i.state === 'locked') return { tone: 'gry', text: 'Already Reconciled', tip: monthName(i.st.month) + ' is reconciled and locked.' };
    if (i.state === 'loaded') return { tone: 'gry', text: 'Already Loaded', tip: 'Every line of this statement is already in the portal.' };
    return { tone: 'grn', text: 'Adds Up', tip: `Opens at ${cash(i.st.opening)}, ends at ${cash(i.st.closing)}; every day agrees with the bank's daily balance.` };
  };
  const what = (i: Item) => (i.kind === 'bank' ? 'Bank Statement · ' + monthName(i.st.month) : i.kind === 'zeffy' ? 'Zeffy Export' : 'Unknown File');
  const detail = (i: Item) => (i.kind === 'bank'
    ? `${i.st.lines.length} lines, ends ${cash(i.st.closing)}${i.state === 'ok' && i.fresh.length < i.st.lines.length ? ` · ${i.fresh.length} new` : ''}`
    : i.kind === 'zeffy' ? `${i.rows.length} gifts · ${i.fresh} new` : '');

  return (
    <Modal title="Review Files" wide foot={<>
      <button className="btn" onClick={ui.close}>Cancel</button>
      <button className="btn pri" onClick={go} disabled={busy || !ready.length}>{busy ? 'Importing…' : `Import ${ready.length} File${ready.length === 1 ? '' : 's'}`}</button>
    </>}>
      {items ? (
        <div className="full scroll">
          <table>
            <thead><tr><th className="nosort">File</th><th className="nosort">What It Is</th><th className="nosort">Contents</th><th className="nosort">Check</th></tr></thead>
            <tbody>
              {items.map((i, k) => {
                const b = badge(i);
                return (
                  <tr key={k}>
                    <td className="wraptext">{i.file.name}</td>
                    <td>{what(i)}</td>
                    <td className="muted">{detail(i)}</td>
                    <td><Hint r tip={b.tip}><Badge tone={b.tone}>{b.text}</Badge></Hint></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="full empty">Reading {files.length} file{files.length === 1 ? '' : 's'}…</div>}
    </Modal>
  );
}
