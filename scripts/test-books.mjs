// P23 books (0018): equipment marked as assets through ledger_set_asset only, even in a reconciled month; a donor's
// standing team for monthly Zeffy gifts with a blank Fund. Sample people and amounts only.
// Runs on its own: node scripts/test-books.mjs   (exits 1 when a check fails)
import { openDb } from './pg-stub.mjs';

const db = await openDb();
const TREAS = '00000000-0000-0000-0000-0000000000b1';
const BOOKS = '00000000-0000-0000-0000-0000000000b3';
const CPA = '00000000-0000-0000-0000-0000000000d2';
const COACH = '00000000-0000-0000-0000-0000000000c1';

let failed = 0, passed = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (cond) passed++; else failed++; };
async function as(claims, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role ${claims.role ?? 'authenticated'}`);
    return tx.query(sql, params);
  });
}
async function fails(claims, sql, params, match, label) {
  try { await as(claims, sql, params); ok(false, label + ' (no error)'); }
  catch (e) { ok(match.test(e.message), label + ' -> ' + e.message); }
}
const signed = (sub, email) => ({ sub, email, aal: 'aal2', role: 'authenticated' });
const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOOKS}', 'books@example.org', now()),
    ('${CPA}', 'cpa@example.org', now()), ('${COACH}', 'coach@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'bookkeeper', name = 'Sample Bookkeeper' where user_id = '${BOOKS}';
  update public.portal_access set role = 'cpa', name = 'Sample CPA' where user_id = '${CPA}';
  update public.settings set general_fund_id = 'F-GEN';
`);
const T = signed(TREAS, 'treasurer@example.org');
const K = signed(BOOKS, 'books@example.org');
const X = signed(CPA, 'cpa@example.org');
const C = signed(COACH, 'coach@example.org');

// ---------------------------------------------------------------- assets
const buy = await one(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-09-10', dir: 'out', amount: 60, fund_id: 'F-GEN', category: 'Equipment', party: 'Sample Tools', memo: 'Drill press', receipt: true })]);
const gift = await one(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-09-11', dir: 'in', amount: 100, fund_id: 'F-GEN', source: 'Fundraising' })]);
ok(typeof buy === 'string', 'a purchase is added');
await as(K, `select public.ledger_set_asset($1, true)`, [buy]);
ok((await q(`select asset from public.ledger where id = $1`, [buy]))[0].asset === true, 'the bookkeeper marks a purchase as an asset');
ok((await q(`select count(*)::int n from public.change_log where record_id = $1 and action = 'Changed'`, [buy]))[0]?.n >= 1, 'the change is in History');
await fails(K, `select public.ledger_set_asset($1, true)`, [gift], /Only a purchase/, 'money in cannot be an asset');
await fails(X, `select public.ledger_set_asset($1, false)`, [buy], /not allowed/, 'the CPA cannot mark assets');
await fails(C, `select public.ledger_set_asset($1, false)`, [buy], /not allowed/, 'a team login cannot mark assets');
await fails(K, `update public.ledger set asset = false where id = $1`, [buy], /permission|denied|locked/i, 'no direct write to the asset flag');
// lock September, then the flag still changes but money does not
await db.exec(`insert into public.bank_statements (id, month, ending_balance) values ('S-TEST', '2026-09-01', 0) on conflict do nothing;
  select set_config('gpric.via', 'lock', false); update public.bank_statements set locked_at = now() where month = '2026-09-01'; select set_config('gpric.via', '', false);`);
await as(T, `select public.ledger_set_asset($1, false)`, [buy]);
ok((await q(`select asset from public.ledger where id = $1`, [buy]))[0].asset === false, 'the asset flag changes in a reconciled month');
await fails(T, `select public.ledger_edit($1, $2)`, [buy, JSON.stringify({ memo: 'Changed' })], /locked/, 'other changes in a reconciled month are still refused');

// ---------------------------------------------------------------- a donor's standing team for monthly Zeffy gifts
const row = (key, date, fund = null, recurring = 'Active') => ({ key, date, amount: 10, fund, recurring, first: 'Sample', last: 'Monthly', email: 'monthly@example.org', status: 'Succeeded' });
await as(T, `select public.zeffy_upsert($1, 'file')`, [JSON.stringify([row('k1', '2026-10-01'), { ...row('k2', '2026-10-01'), recurring: null, email: 'once@example.org', last: 'Once' }])]);
const d1 = await q(`select d.id, d.donor_id, d.unassigned, d.fund_id from public.donations d where zeffy_key = 'k1'`);
ok(d1[0].unassigned === true, 'with no standing team a blank-Fund monthly gift waits in Unassigned Gifts');
const fund = (await q(`select fund_id from public.teams where id = 'T-9255'`))[0].fund_id;
const moved = await one(K, `select public.donor_zeffy_fund($1, $2)`, [d1[0].donor_id, fund]);
ok(Number(moved) === 1, 'setting the standing team moves the waiting monthly gift');
const d1b = (await q(`select d.unassigned, d.fund_id, l.fund_id lf from public.donations d join public.ledger l on l.donation_id = d.id where zeffy_key = 'k1'`))[0];
ok(d1b.unassigned === false && d1b.fund_id === fund && d1b.lf === fund, 'the gift and its ledger entry are in the team fund');
await as(T, `select public.zeffy_upsert($1, 'file')`, [JSON.stringify([row('k3', '2026-11-01'), row('k4', '2026-11-01', 'General Fund'),
  { ...row('k5', '2026-11-01'), recurring: null }])]);
const g = Object.fromEntries((await q(`select zeffy_key k, fund_id, unassigned from public.donations where zeffy_key in ('k3','k4','k5')`)).map((r) => [r.k, r]));
ok(g.k3.fund_id === fund && g.k3.unassigned === false, 'the next monthly gift with a blank Fund goes straight to the standing team');
ok(g.k4.fund_id === 'F-GEN', 'a gift whose Fund says General stays in General');
ok(g.k5.unassigned === true, 'a one-time gift from the same donor still waits to be assigned');
await as(K, `select public.donor_zeffy_fund($1, null)`, [d1[0].donor_id]);
await as(T, `select public.zeffy_upsert($1, 'file')`, [JSON.stringify([row('k6', '2026-12-01')])]);
ok((await q(`select unassigned from public.donations where zeffy_key = 'k6'`))[0].unassigned === true, 'once cleared, monthly gifts wait in Unassigned Gifts again');
await fails(X, `select public.donor_zeffy_fund($1, $2)`, [d1[0].donor_id, fund], /not allowed/, 'the CPA cannot set a standing team');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
