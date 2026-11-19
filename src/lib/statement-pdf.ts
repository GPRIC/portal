// Citizens Bank business checking statements (PDF) read into bank lines, in the browser.
// Input is the positioned text of every page (pdf.js getTextContent: each piece of text with its x and y), so the
// columns of the statement are read by position: Date at the left, Amount right-aligned before x 160, Description
// from x 160. No imports, so the same code runs in the portal and in the Node checks against the real statements.
// Nothing is accepted unless it proves itself: every line has a date and an amount, the lines add up from the
// Previous Balance to the Current Balance, and each day's running balance is one the Daily Balance table prints.

export type PdfItem = { page: number; x: number; y: number; s: string };
export type StatementLine = { date: string; amount: number; description: string };
export type ParsedStatement = {
  month: string;          // YYYY-MM-01
  opening: number;
  closing: number;
  lines: StatementLine[];
  /** Empty when the statement proves itself; otherwise why it cannot be imported. */
  problems: string[];
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONEY = /^-?(\d{1,3}(,\d{3})*|\d*)\.\d\d$/;
const MD = /^(\d\d)\/(\d\d)$/;
const cents = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
const DESC_X = 160;        // the Description column starts here
const TOTALS_X = 440;      // section totals and their labels sit right of this

type Row = { page: number; y: number; items: PdfItem[]; text: string };

/** Pieces of text on the same baseline (within 3 points) of one page make a row; rows run top to bottom, page by page. */
export function rowsOf(items: PdfItem[]): Row[] {
  const rows: Row[] = [];
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  for (const p of pages) {
    // control characters (the statement prints one inside "TRANSACTION DETAILS") read as spaces
    const mine = items.filter((i) => i.page === p).map((i) => ({ ...i, s: i.s.replace(/[\u0000-\u001f ]/g, ' ') }))
      .filter((i) => i.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    const pr: Row[] = [];
    for (const it of mine) {
      const r = pr.find((x) => Math.abs(x.y - it.y) <= 3);
      if (r) r.items.push(it); else pr.push({ page: p, y: it.y, items: [it], text: '' });
    }
    for (const r of pr) { r.items.sort((a, b) => a.x - b.x); r.text = r.items.map((i) => i.s.trim()).join(' ').replace(/\s+/g, ' '); }
    rows.push(...pr.sort((a, b) => b.y - a.y));
  }
  return rows;
}

/** Splits a row into single words with their x (pdf.js sometimes hands over several words as one piece). */
function words(r: Row): { x: number; s: string }[] {
  const out: { x: number; s: string }[] = [];
  for (const it of r.items) {
    const parts = it.s.trim().split(/\s+/).filter(Boolean);
    // spread the words of one piece across its width only for ordering; they keep the piece's x as a floor
    parts.forEach((s, k) => out.push({ x: it.x + k * 0.01, s }));
  }
  return out;
}

export function parseCitizensStatement(items: PdfItem[]): ParsedStatement {
  const rows = rowsOf(items);
  const problems: string[] = [];
  const all = rows.map((r) => r.text).join('\n');

  const per = /Beginning\s+([A-Za-z]+)\s+(\d\d?),\s+(\d{4})/.exec(all);
  const mi = per ? MONTHS.indexOf(per[1]) : -1;
  if (!per || mi < 0) return { month: '', opening: 0, closing: 0, lines: [], problems: ['This does not look like a Citizens checking statement (no statement period found).'] };
  const year = Number(per[3]);
  const month = `${year}-${String(mi + 1).padStart(2, '0')}-01`;
  const iso = (mm: string, dd: string) => {
    // a December statement can carry early-January dates only if the period crosses the year; the period is one calendar month
    return `${year}-${mm}-${dd}`;
  };

  const lastMoney = (r: Row | undefined) => { const w = r ? words(r).filter((x) => MONEY.test(x.s)) : []; return w.length ? cents(w[w.length - 1].s) : null; };
  const opening = lastMoney(rows.find((r) => /^Previous Balance\b/.test(r.text)));
  const closing = lastMoney(rows.find((r) => /^Current Balance\b/.test(r.text)));
  if (opening == null || closing == null) problems.push('The Balance Calculation (Previous and Current Balance) was not found.');

  type L = { date: string | null; cents: number | null; description: string };
  const lines: L[] = [];
  const daily = new Map<string, number>();
  let section: '' | 'checks' | 'debits' | 'deposits' | 'daily' | 'done' = '';
  let started = false;
  let last: L | null = null;

  for (const r of rows) {
    const t = r.text;
    if (!started) { if (/TRANSACTION\s*DETAILS/i.test(t)) started = true; continue; }
    if (section === 'done') break;
    const first = r.items[0];
    const atLeft = first.x < 60;
    if (atLeft && /^Checks\b/.test(t) && !/Checks\s*-/.test(t)) { section = 'checks'; last = null; continue; }
    if (atLeft && /^Debits\b/.test(t)) { section = 'debits'; last = null; continue; }
    if (atLeft && /^Deposits\s*&\s*Credits\b/.test(t)) { section = 'deposits'; last = null; continue; }
    if (atLeft && /^Daily Balance\b/.test(t)) { section = 'daily'; last = null; continue; }
    if (/Checking Account Balance Worksheet/.test(t)) { section = 'done'; continue; }
    if (!section) continue;
    if (/^Page \d+ of \d+$/.test(t) || /Continued$/.test(t) || /^Please See Additional/.test(t) || /^\*\*May include/.test(t)) continue;
    if (atLeft && /^(ATM\/Purchases|Other Debits)$/.test(t)) { last = null; continue; }
    const w = words(r).filter((x) => x.x < TOTALS_X);
    if (!w.length) continue;
    if (w[0].s === 'Date' || w[0].s === 'Check') continue;        // column headings

    if (section === 'checks') {
      // "107  663.74  09/08", up to two to a row
      for (let k = 0; k + 2 < w.length; k++) {
        if (/^\d{3,6}\*?$/.test(w[k].s) && MONEY.test(w[k + 1].s)) {
          const dm = MD.exec(w[k + 2].s);
          if (dm) { const no = w[k].s.replace('*', ''); lines.push({ date: iso(dm[1], dm[2]), cents: -cents(w[k + 1].s), description: `CHECK ${no}` }); k += 2; }
        }
      }
      continue;
    }
    if (section === 'daily') {
      const ws = words(r);
      for (let k = 0; k + 1 < ws.length; k++) {
        const dm = MD.exec(ws[k].s);
        if (dm && MONEY.test(ws[k + 1].s)) { daily.set(iso(dm[1], dm[2]), cents(ws[k + 1].s)); k++; }
      }
      continue;
    }
    // debits and deposits: Date | Amount | Description
    const sign = section === 'debits' ? -1 : 1;
    const dm = w[0].x < 60 ? MD.exec(w[0].s) : null;
    const amt = w.find((x) => x.x >= 60 && x.x < DESC_X && MONEY.test(x.s));
    const desc = w.filter((x) => x.x >= DESC_X).map((x) => x.s).join(' ');
    if (dm) {
      last = { date: iso(dm[1], dm[2]), cents: amt ? sign * cents(amt.s) : null, description: desc };
      lines.push(last);
    } else if (amt) {
      // an amount printed apart from its line belongs to the oldest line still without one
      const open = lines.find((l) => l.cents == null);
      if (open) { open.cents = sign * cents(amt.s); if (desc) open.description = (open.description + ' ' + desc).trim(); }
      else problems.push(`An amount (${amt.s}) on the statement has no line to belong to.`);
    } else if (desc && last) {
      last.description = (last.description + ' ' + desc).trim();   // the description runs onto the next row
    }
  }

  const out: StatementLine[] = [];
  for (const l of lines) {
    if (!l.date || l.cents == null) { problems.push(`A line has no ${l.date ? 'amount' : 'date'}: ${l.description || '(no description)'}`); continue; }
    if (l.date.slice(0, 7) !== month.slice(0, 7)) problems.push(`${l.date} is outside the statement month: ${l.description}`);
    out.push({ date: l.date, amount: l.cents / 100, description: l.description });
  }
  if (opening != null && closing != null) {
    const net = lines.reduce((t, l) => t + (l.cents ?? 0), 0);
    if (opening + net !== closing) problems.push(`The lines come to ${((opening + net) / 100).toFixed(2)} but the statement ends at ${(closing / 100).toFixed(2)}.`);
    // every day's running balance must be one the Daily Balance table prints
    const days = [...new Set(out.map((l) => l.date))].sort();
    if (days.length && !daily.size) problems.push('The Daily Balance table was not found.');
    let run = opening;
    for (const d of days) {
      run += lines.filter((l) => l.date === d).reduce((t, l) => t + (l.cents ?? 0), 0);
      if (daily.size && daily.get(d) !== run) problems.push(`The balance on ${d.slice(5)} comes to ${(run / 100).toFixed(2)} but the statement shows ${daily.has(d) ? (daily.get(d)! / 100).toFixed(2) : 'no balance that day'}.`);
    }
  }
  return { month, opening: (opening ?? 0) / 100, closing: (closing ?? 0) / 100, lines: out, problems };
}
