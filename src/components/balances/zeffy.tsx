'use client';
// The Zeffy panel: connection state, last sync, gifts imported, unassigned gifts, money in transit,
// Sync Now (server route) and Import Zeffy File (the All Payments export, read in the browser).
import { useRef, useState } from 'react';
import { useData } from '@/components/data';
import { Badge, Modal, useUI } from '@/components/ui';
import { Tip } from '@/components/tips';
import { supabase } from '@/lib/supabase/client';
import { zeffyRowsFromSheet } from '@/lib/zeffy';
import { sd, sum } from '@/lib/format';
import type { Donation } from '@/lib/types';
import { cash, Hint } from './hint';

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** An exceljs cell value as plain data: dates stay dates, formulas give their result, rich text and links give their text. */
function plain(v: unknown): unknown {
  if (v == null || v instanceof Date || typeof v !== 'object') return v;
  const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; error?: unknown };
  if (o.richText) return o.richText.map((x) => x.text).join('');
  if ('result' in o) return plain(o.result);
  if (o.text != null) return plain(o.text);
  return null;
}

export function ZeffyPanel() {
  const { db, calc, run, reload } = useData();
  const ui = useUI();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'' | 'sync' | 'file'>('');
  const last = calc.lastZeffySync();
  const live = [...db.zeffy_sync_log].filter((s) => s.source !== 'file').sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1))[0] || null;
  const gifts = db.donations.filter((d) => d.channel === 'Zeffy');
  const un = calc.unassignedGifts();
  const transit = calc.inTransit();
  const transitTotal = sum(transit, (d) => d.amount);
  const dates = gifts.map((d) => d.date).sort();
  const fundsUsed = new Set(gifts.map((d) => d.fund_id)).size;
  const biggest = transit.slice().sort((a, b) => b.amount - a.amount)[0];

  const syncNow = async () => {
    setBusy('sync');
    try {
      const r = await fetch('/api/zeffy/sync', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { inserted?: number; updated?: number; skipped?: number; error?: string };
      if (!r.ok || j.error) ui.toast(j.error || 'Zeffy sync failed (' + r.status + ')', true);
      else ui.toast(`Zeffy synced: ${j.inserted || 0} new, ${j.updated || 0} updated`);
    } catch (e) { ui.toast('Zeffy sync failed: ' + (e as Error).message, true); }
    await reload();
    setBusy('');
  };

  const importFile = async (f: File) => {
    setBusy('file');
    try {
      const m = await import('exceljs');
      const Workbook = m.Workbook ?? (m as unknown as { default: typeof m }).default.Workbook;
      const wb = new Workbook();
      await wb.xlsx.load(await f.arrayBuffer());
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('The file has no sheets.');
      const table: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = (row.values as unknown[]).slice(1).map(plain);
        table.push(vals);
      });
      const rows = zeffyRowsFromSheet(table);
      if (!rows.length) throw new Error('No gifts found in this file.');
      const res = await run(() => supabase().rpc('zeffy_upsert', { p_rows: rows, p_source: 'file' }));
      if (res) {
        const r = res as { inserted: number; updated: number; skipped: number };
        ui.toast(`Zeffy file imported: ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped`);
      }
    } catch (e) { ui.toast((e as Error).message, true); }
    if (file.current) file.current.value = '';
    setBusy('');
  };

  const badge = !live
    ? <Hint r tip="No Zeffy key yet, so nothing syncs by itself. Import the All Payments export with Import Zeffy File."><Badge>Not Connected</Badge></Hint>
    : live.error
      ? <Hint r tip={'Last sync failed: ' + live.error}><Badge tone="red">Sync Failed</Badge></Hint>
      : <Hint r tip="Connected to GPRIC's Zeffy account. Replaces the bi-weekly export and Gemini import."><Badge tone="grn">Connected</Badge></Hint>;

  return (
    <div className="panel">
      <div className="ph"><h2>Zeffy</h2><span className="sp" />{badge}</div>
      <div className="kvs">
        <div className="k">Last Sync</div>
        <div className="v">{last
          ? <Hint r tip={'Updated each time the Zeffy payments file is imported. Each gift lands in the team named in its Fund field.' + (last.error ? ' Last run failed: ' + last.error : ` Last run (${last.source}): ${last.inserted} new, ${last.updated} updated, ${last.skipped} skipped.`)}>{fmtTime(last.ran_at)}</Hint>
          : <span className="muted">Never</span>}</div>
        <div className="k">Gifts Imported</div>
        <div className="v"><Hint r tip={gifts.length ? `${sd(dates[0])} to ${sd(dates[dates.length - 1])}: ${cash(sum(gifts, (d) => d.amount))} across ${fundsUsed} funds. Grant cheques sent through Zeffy are held under Awarded, Not Received.` : 'No Zeffy gifts yet.'}>{gifts.length}</Hint></div>
        <div className="k">Unassigned Gifts</div>
        <div className="v">
          <Tip id="balances.unassigned" side="r" text="Gifts with a blank Fund wait here. Assign each to a team, or confirm GPRIC General.">
            <Hint r tip="Gifts with a blank Fund. They sit in GPRIC General until someone confirms or moves them.">
              <button className={'cnt' + (un.length ? '' : ' none')} onClick={() => ui.open(<UnassignedModal />)} disabled={!un.length}>{un.length}</button>
            </Hint>
          </Tip>
        </div>
        <div className="k">In Transit</div>
        <div className="v"><Hint r tip={transit.length ? `Gifts counted in balances but not yet paid out by Zeffy to the bank${biggest ? ', led by the ' + cash(biggest.amount) + ' ' + (calc.donor(biggest.donor_id)?.name || '') + ' gift' : ''}.` : 'Every Zeffy gift has been paid out to the bank.'}>{cash(transitTotal)}</Hint></div>
      </div>
      <div className="bal-acts">
        <input ref={file} className="bal-file" type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }} />
        <Hint r tip="Zeffy > Payments > Export, All payments (.xlsx). Gifts already in the portal are only refreshed, never doubled.">
          <button className="btn sm" onClick={() => file.current?.click()} disabled={!!busy}>{busy === 'file' ? 'Importing…' : 'Import Zeffy File'}</button>
        </Hint>
        {/* Sync Now returns when the Zeffy API connection is built (ZEFFY_API_KEY); until then the file import is the way in. */}
        {process.env.NEXT_PUBLIC_ZEFFY_API === 'on' ? <button className="btn sm" onClick={syncNow} disabled={!!busy}>{busy === 'sync' ? 'Syncing…' : 'Sync Now'}</button> : null}
      </div>
    </div>
  );
}

function UnassignedModal() {
  const { db, calc, run } = useData();
  const ui = useUI();
  const gifts = calc.unassignedGifts().slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const [pick, setPick] = useState<Record<string, string>>(() => Object.fromEntries(gifts.map((g) => [g.id, g.fund_id])));
  const [busy, setBusy] = useState(false);
  const general = db.settings.general_fund_id;
  const funds = db.funds.slice().sort((a, b) => (a.id === general ? -1 : b.id === general ? 1 : a.name.localeCompare(b.name)));
  const dup = (g: Donation) => db.donations.some((d) => d.id !== g.id && !d.unassigned && d.channel === 'Zeffy' && d.donor_id === g.donor_id && d.date === g.date && d.amount === g.amount);

  const save = async () => {
    setBusy(true);
    const ok = await run(async () => {
      for (const g of gifts) {
        const { error } = await supabase().from('donations').update({ fund_id: pick[g.id] || g.fund_id, unassigned: false }).eq('id', g.id);
        if (error) return { error };
      }
      return { error: null };
    }, 'Funds assigned');
    setBusy(false);
    if (ok !== false) ui.close();
  };

  return (
    <Modal title="Unassigned Gifts" wide foot={<><button className="btn" onClick={ui.close}>Cancel</button><button className="btn pri" onClick={save} disabled={busy || !gifts.length}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {gifts.length ? (
        <div className="full scroll">
          <table>
            <thead><tr><th className="nosort">Date</th><th className="nosort">Donor</th><th className="nosort">Email</th><th className="num nosort">Amount</th><th className="nosort">Check</th><th className="nosort">Fund</th></tr></thead>
            <tbody>
              {gifts.map((g) => {
                const donor = calc.donor(g.donor_id);
                return (
                  <tr key={g.id}>
                    <td>{sd(g.date)}</td>
                    <td>{donor?.name || '—'}</td>
                    <td className="muted">{donor?.email || '—'}</td>
                    <td className="num">{cash(g.amount)} <span className="muted">{g.recurring ? 'Monthly' : 'One-Time'}</span></td>
                    <td>{dup(g) ? <span title="Same donor, date and amount as a gift already assigned"><Badge tone="amb">Possible Duplicate</Badge></span> : g.fund_raw ? <span title={'Zeffy Fund said "' + g.fund_raw + '", which matches no team'}><Badge tone="amb">Unknown Fund</Badge></span> : <span className="muted">—</span>}</td>
                    <td>
                      <select className="in" style={{ width: 230 }} value={pick[g.id] || ''} onChange={(e) => setPick((p) => ({ ...p, [g.id]: e.target.value }))}>
                        {funds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="full empty">Every Zeffy gift is assigned to a fund.</div>}
      <div className="full muted">Saving confirms each gift in the fund shown.</div>
    </Modal>
  );
}
