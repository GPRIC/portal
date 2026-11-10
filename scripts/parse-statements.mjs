// P23: turn the Citizens checking statements into bank lines.
// Reads private/statements/txt/*.txt (pdftotext -layout of each statement PDF; private/ is git-ignored, real data never
// committed), writes private/statements/bank-lines.json and private/statements/load-bank-lines.sql.
// Every month is checked before anything is written: its lines must add up from its opening balance to the next
// month's opening balance (the last month to its own closing balance). Any month that does not is reported and
// nothing is written.
// Usage: node scripts/parse-statements.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('private/statements');
const TXT = path.join(DIR, 'txt');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AMT = /(?<![\d/])(\d{1,3}(?:,\d{3})*|\d*)\.\d\d(?!\d)/g;
const money = (s) => Math.round(Number(s.replace(/,/g, '')) * 100);
const DATE = /^\s*(\d\d)\/(\d\d)\b/;
const FIX = fs.existsSync(path.join(DIR, 'corrections.json')) ? JSON.parse(fs.readFileSync(path.join(DIR, 'corrections.json'), 'utf8')) : {};
const NOISE =/Please See Additional|Page \d+ of|Continued|May include checks|Total (Checks|Debits|Deposits)|Previous Balance|Daily Balance|^\s*[-+=]\s*$|^\s*Date\s+Amount|^\s*Check #|^\s*Debits \*\*|^\s*Deposits & Credits/;

function parse(file) {
  const text = fs.readFileSync(path.join(TXT, file), 'utf8');
  const m = /^STATEMENTS,([A-Za-z]+)(\d{4})-/.exec(file);
  const month = MONTHS.indexOf(m[1]) + 1, year = Number(m[2]);
  const iso = (mm, dd) => `${year}-${mm}-${dd}`;
  const calc = text.slice(text.indexOf('Balance Calculation'));
  const opening = money(calc.match(AMT)[0]);
  const cur = /=\s*([\d,]+\.\d\d)/.exec(calc.slice(0, 900));
  const closing = cur ? money(cur[1]) : null;

  const body = text.slice(text.indexOf('TRANSACTIONDETAILS'), text.indexOf('Daily Balance'));
  const lines = [];
  let sign = 0, cur_ = null, pendingDesc = null, open = [], undated = [];
  const push = (r) => { lines.push(r); cur_ = r; if (r.cents == null) open.push(r); };
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*Checks\s/.test(raw) || /^\s*Check #/.test(raw)) { sign = -1; cur_ = null; }
    if (/^\s*Debits \*\*/.test(raw) || /^\s*(ATM\/Purchases|Other Debits)/.test(raw)) { sign = -1; cur_ = null; }
    if (/^\s*Deposits & Credits/.test(raw)) { sign = 1; cur_ = null; pendingDesc = null; }
    if (!sign || NOISE.test(raw.slice(0, 70)) || !raw.trim()) continue;
    // totals sit far to the right; a sub-heading can share a line with the first entry
    const left = raw.slice(0, 110).replace(/^\s*(ATM\/Purchases|Other Debits)/, (h) => ' '.repeat(h.length));
    if (!left.trim()) continue;
    // checks: "107   663.74   09/08", two to a line
    const ck = [...left.matchAll(/(?:^|\s)(\d{3,6})\s+([\d,]*\.\d\d)\s+(\d\d)\/(\d\d)/g)];
    if (ck.length) { for (const c of ck) push({ date: iso(c[3], c[4]), cents: -money(c[2]), description: `CHECK ${c[1]}`, check: c[1] }); cur_ = null; continue; }
    const d = DATE.exec(left);
    let rest = d ? left.slice(d[0].length) : left;
    const a = /^\s*((?:\d{1,3}(?:,\d{3})*|\d*)\.\d\d)(?!\d)/.exec(rest);
    const amount = a ? money(a[1]) : null;
    if (a) rest = rest.slice(a[0].length);
    // the description ends at the first wide gap (totals and their labels sit further right)
    const desc = rest.trim().split(/\s{4,}/)[0].replace(/^[-+=]\s*/, '').replace(/\s+/g, ' ')
      .replace(/^[\d,.\s]*$/, '');                       // a stray total or sign is not a description
    if (d && !rest.trim() && undated.length) { undated.shift().date = iso(d[1], d[2]); continue; }  // a date printed apart from its entry
    if (d) {
      push({ date: iso(d[1], d[2]), cents: amount == null ? null : sign * amount, description: desc || pendingDesc || '' });
      if (!desc && pendingDesc) pendingDesc = null;
      continue;
    }
    if (amount != null) {                                  // an amount on its own line belongs to the oldest line still without one
      const r = open.shift();
      if (r) { r.cents = sign * amount; if (desc) r.description = (r.description + ' ' + desc).trim(); }
      else if (desc) { const u = { date: null, cents: sign * amount, description: desc }; lines.push(u); cur_ = u; undated.push(u); }
      continue;
    }
    if (desc) {
      if (cur_ && cur_.cents != null && /^[A-Z0-9 .*#-]{1,24}$/.test(desc) && !/DEPOSIT|TRANSFER|PURCHASE|DEBIT|Zeffy/i.test(desc)) cur_.description += ' ' + desc;
      else if (cur_ && cur_.cents == null) cur_.description = (cur_.description + ' ' + desc).trim();
      else pendingDesc = desc;
    }
  }
  open = open.filter((r) => r.cents == null);
  // Known layout slips, kept privately (private/statements/corrections.json) and proved by the daily balances below.
  const key = `${year}-${String(month).padStart(2, '0')}`;
  for (const c of FIX[key] || []) {
    const hit = lines.filter((l) => l.description.includes(c.match));
    if (hit.length !== 1) throw new Error(`${key}: correction "${c.match}" matches ${hit.length} lines`);
    if (c.amount != null) { hit[0].cents = Math.sign(hit[0].cents || 1) * Math.round(c.amount * 100); open = open.filter((r) => r !== hit[0]); }
    if (c.date) hit[0].date = c.date;
  }
  // The statement's Daily Balance table: every end-of-day balance it prints. Its columns do not line up in the
  // text, so it is read as a set of figures, and each day's running balance from the parsed lines must be one of
  // them. This catches an amount given to the wrong line within a month (the month total alone cannot).
  const di = text.indexOf('Daily Balance');
  const daily = new Set(di < 0 ? [] : [...text.slice(di, di + 3000).split(/Checking Account Balance Worksheet|\f/)[0].matchAll(AMT)].map((x) => money(x[0])));
  return { file, year, month, opening, closing, lines, daily, missing: open.length + lines.filter((l) => !l.date).length };
}

const files = fs.readdirSync(TXT).filter((f) => f.endsWith('.txt'));
const st = files.map(parse).sort((a, b) => a.year - b.year || a.month - b.month);
let bad = 0;
st.forEach((s, i) => {
  const sum = s.lines.reduce((t, l) => t + (l.cents ?? 0), 0);
  const next = st[i + 1];
  const want = next ? next.opening : s.closing;
  s.ending = s.opening + sum;
  // end-of-day balances; a day the table does not print is a miss
  const days = [...new Set(s.lines.map((l) => l.date))].sort();
  const offDays = s.daily.size ? days.filter((d) => !s.daily.has(s.opening + s.lines.filter((l) => l.date <= d).reduce((t, l) => t + (l.cents ?? 0), 0))) : [];
  const okay = !s.missing && want != null && s.ending === want && !offDays.length;
  if (!okay) bad++;
  console.log(`${okay ? 'OK  ' : 'BAD '}${s.year}-${String(s.month).padStart(2, '0')}  open ${(s.opening / 100).toFixed(2)}  lines ${s.lines.length}  net ${(sum / 100).toFixed(2)}  end ${(s.ending / 100).toFixed(2)}  expected ${want == null ? '?' : (want / 100).toFixed(2)}${s.missing ? `  ${s.missing} line(s) without an amount` : ''}${offDays.length ? `  daily balance off on ${offDays.join(', ')}` : ''}`);
});
if (bad) { console.log(`\n${bad} month(s) do not add up; nothing written.`); process.exit(1); }

const out = st.map((s) => ({
  month: `${s.year}-${String(s.month).padStart(2, '0')}-01`, file: s.file.replace(/\.txt$/, '.pdf'),
  opening: s.opening / 100, ending: s.ending / 100,
  lines: s.lines.map((l) => ({ date: l.date, amount: l.cents / 100, description: l.description })),
}));
fs.writeFileSync(path.join(DIR, 'bank-lines.json'), JSON.stringify(out, null, 1));

// The load: one statement per month with its ending balance, then its lines, recorded in History as the
// statement import. Run once, as the database owner, after 0004 and 0005 are live and before any month is locked.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = ['-- GPRIC real books: Citizens checking statements as bank lines (generated by scripts/parse-statements.mjs).',
  '-- Private: real bank data. Run once in the SQL editor after 0004 and 0005 are live.',
  'begin;', `select set_config('gpric.job', 'Bank statement import', true), set_config('gpric.via', 'bank', true);`,
  `do $$ begin
  if exists (select 1 from public.bank_statements where sample) or exists (select 1 from public.bank_lines where sample) then raise exception 'Clear the sample data first'; end if;
  if exists (select 1 from public.bank_lines) then raise exception 'Real bank lines are already loaded'; end if;
end $$;`];
for (const s of out) {
  sql.push(`insert into public.bank_statements (month, ending_balance, file_name) values (${q(s.month)}, ${s.ending.toFixed(2)}, ${q(s.file)})`
    + ';');
  if (s.lines.length) sql.push(`insert into public.bank_lines (statement_id, date, description, amount) select b.id, x.d, x.t, x.a from public.bank_statements b,\n  (values ${s.lines.map((l) => `(${q(l.date)}::date, ${q(l.description)}, ${l.amount.toFixed(2)})`).join(',\n          ')}) x(d, t, a)\n  where b.month = ${q(s.month)};`);
}
sql.push('commit;');
fs.writeFileSync(path.join(DIR, 'load-bank-lines.sql'), sql.join('\n') + '\n');
console.log(`\nAll ${out.length} months add up. ${out.reduce((n, s) => n + s.lines.length, 0)} lines written to private/statements/bank-lines.json and load-bank-lines.sql.`);
