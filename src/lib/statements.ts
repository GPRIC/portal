// Year-end statements and tax-return lines for the Quarterly and Year exports (P23).
// The ledger's own categories and sources stay as they are; each is mapped here to the line of the return it is
// reported on. The mapping is a proposal for the CPA to confirm: GPRIC filed Form 990-PF through TY2025 and is moving
// to public-charity status (990-EZ), so both lines are shown.
import type { Db, Ledger } from './types';

export type TaxLine = { ez: string; pf: string; confirm?: boolean };

/** Money out, by ledger category. */
export const EXPENSE_LINES: Record<string, TaxLine> = {
  'Robotics Teams': { ez: '990-EZ line 16, other expenses (program: robotics teams)', pf: '990-PF line 25, contributions, gifts, grants paid', confirm: true },
  Space: { ez: '990-EZ line 14, occupancy, rent, utilities and maintenance', pf: '990-PF line 20, occupancy' },
  Administration: { ez: '990-EZ line 16, other expenses (administration)', pf: '990-PF line 23, other expenses' },
  Equipment: { ez: '990-EZ line 16, other expenses (equipment under the asset threshold)', pf: '990-PF line 23, other expenses' },
  Other: { ez: '990-EZ line 16, other expenses', pf: '990-PF line 23, other expenses', confirm: true },
};

/** Money in, by ledger source. */
export const REVENUE_LINES: Record<string, TaxLine> = {
  'Individual Donors': { ez: '990-EZ line 1, contributions, gifts, grants', pf: '990-PF line 1, contributions, gifts, grants' },
  Sponsors: { ez: '990-EZ line 1, contributions, gifts, grants', pf: '990-PF line 1, contributions, gifts, grants' },
  Grants: { ez: '990-EZ line 1, contributions, gifts, grants', pf: '990-PF line 1, contributions, gifts, grants' },
  Fundraising: { ez: '990-EZ line 6, gaming and fundraising events', pf: '990-PF line 11, other income', confirm: true },
  Fundraisers: { ez: '990-EZ line 6, gaming and fundraising events', pf: '990-PF line 11, other income', confirm: true },
  Interest: { ez: '990-EZ line 4, investment income', pf: '990-PF line 3, interest on savings' },
  Other: { ez: '990-EZ line 8, other revenue', pf: '990-PF line 11, other income', confirm: true },
};

const UNKNOWN: TaxLine = { ez: 'Not mapped', pf: 'Not mapped', confirm: true };
export const expenseLine = (category: string | null) => EXPENSE_LINES[category || 'Other'] || UNKNOWN;
export const revenueLine = (source: string | null) => REVENUE_LINES[source || 'Other'] || REVENUE_LINES.Other;

/** Ledger sources that are not revenue: opening balances, and money coming back that nets against what it was spent on. */
const NOT_REVENUE = new Set(['Opening Balance', 'Unspent Returned', 'Refund']);

const r2 = (n: number) => Math.round(n * 100) / 100;
const isTransfer = (l: Ledger) => !!(l as Ledger & { transfer_id?: string | null }).transfer_id;

/** A row as the books count it: the direction of the original entry and +1, or -1 for a reversal. */
function counted(l: Ledger) {
  const kind = l.reverses_id ? (l.dir === 'in' ? 'out' : 'in') : l.dir;
  return { kind, sign: l.reverses_id ? -1 : 1 };
}

export type Activity = { revenue: { source: string; line: TaxLine; amount: number }[]; expenses: { category: string; line: TaxLine; amount: number }[];
  totalRevenue: number; totalExpenses: number; change: number };

/** Statement of Activities for the dates start to end (inclusive). Transfers between funds and opening balances are left out. */
export function activities(db: Db, start: string, end: string): Activity {
  const rev = new Map<string, number>();
  const exp = new Map<string, number>();
  for (const l of db.ledger) {
    if (l.date < start || l.date > end || isTransfer(l)) continue;
    const { kind, sign } = counted(l);
    if (l.source === 'Opening Balance') continue;
    if (l.source === 'Unspent Returned' || l.source === 'Refund') {
      // money coming back nets against what it was spent on (as portal_totals does)
      const k = l.category || 'Robotics Teams';
      exp.set(k, (exp.get(k) || 0) - sign * l.amount);
    } else if (kind === 'out') exp.set(l.category || 'Other', (exp.get(l.category || 'Other') || 0) + sign * l.amount);
    else if (!NOT_REVENUE.has(l.source || '')) rev.set(l.source || 'Other', (rev.get(l.source || 'Other') || 0) + sign * l.amount);
  }
  const revenue = [...rev].map(([source, a]) => ({ source, line: revenueLine(source), amount: r2(a) })).filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);
  const expenses = [...exp].map(([category, a]) => ({ category, line: expenseLine(category), amount: r2(a) })).filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);
  const totalRevenue = r2(revenue.reduce((a, x) => a + x.amount, 0));
  const totalExpenses = r2(expenses.reduce((a, x) => a + x.amount, 0));
  return { revenue, expenses, totalRevenue, totalExpenses, change: r2(totalRevenue - totalExpenses) };
}

export type Position = { cashRestricted: number; cashUnrestricted: number; cash: number; assets: { l: Ledger; fund: string }[]; assetsTotal: number; total: number };

/** Statement of Financial Position on a date: cash by restriction (every ledger row up to the date) and equipment kept as assets at cost. */
export function position(db: Db, asOf: string): Position {
  const restricted = new Set(db.funds.filter((f) => f.restricted).map((f) => f.id));
  let cr = 0, cu = 0;
  for (const l of db.ledger) {
    if (l.date > asOf) continue;
    const net = l.dir === 'in' ? l.amount : -l.amount;
    if (restricted.has(l.fund_id)) cr += net; else cu += net;
  }
  const assets = assetRows(db, asOf);
  const assetsTotal = r2(assets.reduce((a, x) => a + x.l.amount, 0));
  return { cashRestricted: r2(cr), cashUnrestricted: r2(cu), cash: r2(cr + cu), assets, assetsTotal, total: r2(cr + cu + assetsTotal) };
}

/** Purchases kept as assets, bought on or before the date (reversed purchases drop out). */
export function assetRows(db: Db, asOf: string) {
  const fund = (id: string) => db.funds.find((f) => f.id === id)?.name || id;
  return db.ledger.filter((l) => l.asset && l.dir === 'out' && !l.reverses_id && !l.reversed_by_id && l.date <= asOf)
    .sort((a, b) => (a.date < b.date ? -1 : 1)).map((l) => ({ l, fund: fund(l.fund_id) }));
}

/** The fiscal year (settings.fy_start month and day) a date falls in. */
export function fiscalYear(db: Db, d: string): { start: string; end: string; label: string } {
  const md = (db.settings.fy_start || '2026-07-01').slice(5);
  let y = Number(d.slice(0, 4));
  if (d.slice(5) < md) y -= 1;
  const start = `${y}-${md}`;
  const e = new Date(start + 'T00:00:00Z'); e.setUTCFullYear(e.getUTCFullYear() + 1); e.setUTCDate(e.getUTCDate() - 1);
  return { start, end: e.toISOString().slice(0, 10), label: md === '01-01' ? String(y) : `FY ${y}–${String(y + 1).slice(2)}` };
}

type Row = (string | number | null)[];

/** The statements as sheet rows: a title row, a blank row, then label / amount / tax line rows. */
export function statementRows(db: Db, start: string, end: string, title: string): { activity: Row[]; position: Row[]; assets: Row[]; tax: Row[] } {
  const a = activities(db, start, end);
  const p = position(db, end);
  const activity: Row[] = [
    [`Statement of Activities, ${title}`], [`${start} to ${end}. Opening balances and transfers between funds are left out.`], [],
    ['Revenue', 'Amount', 'Form 990-EZ', 'Form 990-PF'],
    ...a.revenue.map((x) => [x.source, x.amount, x.line.ez, x.line.pf]),
    ['Total revenue', a.totalRevenue, null, null], [],
    ['Expenses', 'Amount', 'Form 990-EZ', 'Form 990-PF'],
    ...a.expenses.map((x) => [x.category, x.amount, x.line.ez, x.line.pf]),
    ['Total expenses', a.totalExpenses, null, null], [],
    ['Change in net assets', a.change, null, null],
  ];
  const position_: Row[] = [
    [`Statement of Financial Position, ${end}`], [],
    ['Assets', 'Amount'],
    ['Cash, without donor restrictions', p.cashUnrestricted],
    ['Cash, with donor restrictions (team and restricted funds)', p.cashRestricted],
    ['Equipment kept as assets, at cost', p.assetsTotal],
    ['Total assets', p.total], [],
    ['Liabilities', 0], [],
    ['Net assets without donor restrictions', Math.round((p.cashUnrestricted + p.assetsTotal) * 100) / 100],
    ['Net assets with donor restrictions', p.cashRestricted],
    ['Total net assets', p.total],
  ];
  const assets: Row[] = [
    ['Date', 'Entry', 'Paid To', 'Description', 'Fund', 'Category', 'Cost'],
    ...p.assets.map(({ l, fund }) => [l.date, l.id, l.party, l.memo, fund, l.category, l.amount]),
    ...(p.assets.length ? [['Total', null, null, null, null, null, p.assetsTotal]] : [['No purchases are marked as assets yet. Mark one from its ledger entry.']]),
  ];
  const tax: Row[] = [
    ['Ledger', 'Name', 'Form 990-EZ', 'Form 990-PF', 'CPA To Confirm'],
    ...Object.entries(REVENUE_LINES).map(([k, v]) => ['Source (money in)', k, v.ez, v.pf, v.confirm ? 'Yes' : null]),
    ...Object.entries(EXPENSE_LINES).map(([k, v]) => ['Category (money out)', k, v.ez, v.pf, v.confirm ? 'Yes' : null]),
  ];
  return { activity, position: position_, assets, tax };
}
