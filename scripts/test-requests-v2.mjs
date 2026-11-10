// P30 and P31, requests v2: direct expenses, many invoices per request, one payment per request, cancel, refunds and
// replacement orders. Runs on its own: node scripts/test-requests-v2.mjs   (exits 1 when a check fails)
// Sample people and amounts only.
import { openDb } from './pg-stub.mjs';

const db = await openDb();

const TREAS = '00000000-0000-0000-0000-0000000000b1';
const BOARD = '00000000-0000-0000-0000-0000000000b2';
const BOOKS = '00000000-0000-0000-0000-0000000000b3';
const OFFICER = '00000000-0000-0000-0000-0000000000b4';
const COACH = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000c2';

let failed = 0;
let passed = 0;
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
const num = (x) => Number(x);

// ---------------------------------------------------------------- people (sample)

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into public.team_invites (team_id, email, name, role) select id, 'other@example.org', 'Sample Other', 'Coach' from public.teams where id <> 'T-9255' order by id limit 1;
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'board@example.org', now()),
    ('${BOOKS}', 'books@example.org', now()), ('${OFFICER}', 'officer@example.org', now()),
    ('${COACH}', 'coach@example.org', now()), ('${OTHER}', 'other@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  update public.portal_access set role = 'bookkeeper', name = 'Sample Bookkeeper' where user_id = '${BOOKS}';
  update public.portal_access set role = 'board', name = 'Sample Officer', files_direct = true where user_id = '${OFFICER}';
  update public.settings set general_fund_id = 'F-GEN';
`);
const T = signed(TREAS, 'treasurer@example.org');
const B = signed(BOARD, 'board@example.org');
const K = signed(BOOKS, 'books@example.org');
const O = signed(OFFICER, 'officer@example.org');
const C = signed(COACH, 'coach@example.org');
const C2 = signed(OTHER, 'other@example.org');
const otherTeam = (await q(`select team_id from public.team_users where user_id = $1`, [OTHER]))[0].team_id;
const otherFund = (await q(`select fund_id from public.teams where id = $1`, [otherTeam]))[0].fund_id;

const bal = async (f) => num(await one(T, `select public.fund_balance($1)`, [f]));
const outRows = async (rid) => (await q(`select * from public.ledger where request_id = $1 and dir = 'out' and reverses_id is null`, [rid]));
const req = async (rid) => (await q(`select * from public.team_requests where id = $1`, [rid]))[0];

await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-01', dir: 'in', amount: 5000, fund_id: 'F-9255', source: 'Test Deposit' })]);
await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-01', dir: 'in', amount: 5000, fund_id: 'F-GEN', source: 'Test Deposit' })]);

const invoices = [
  { vendor: 'Sample Hardware', amount: 10.25, date: '2026-10-20', file_name: 'a.pdf', file_path: 'receipts/a.pdf' },
  { vendor: 'Sample Robotics Supply', amount: 20.5, date: '2026-10-21', file_name: 'b.pdf', file_path: 'receipts/b.pdf' },
  { vendor: 'Sample Hardware', amount: 5, date: '2026-10-22' },
];
const de = (extra = {}) => JSON.stringify({ purpose: 'Field build parts', charge_fund_id: 'F-9255', pay_method: 'Check', pay_ref: '2051',
  paid_date: '2026-10-22', invoices, ...extra });

// ---------------------------------------------------------------- who can file a direct expense

ok((await one(T, `select public.can_file_direct()`)) === true, 'treasurer can file direct expenses');
ok((await one(K, `select public.can_file_direct()`)) === true, 'bookkeeper can file direct expenses');
ok((await one(O, `select public.can_file_direct()`)) === true, 'an officer the Treasurer marked can file');
ok((await one(B, `select public.can_file_direct()`)) === false, 'an ordinary board member cannot file');
await fails(B, `select public.direct_expense_file($1)`, [de()], /Only the Treasurer, the bookkeeper/, 'board member is refused');
await fails(C, `select public.direct_expense_file($1)`, [de()], /Filing a direct expense is not allowed for your role/, 'team user is refused by require_role');
await fails({ role: 'anon' }, `select public.direct_expense_file($1)`, [de()], /not allowed for your role|permission denied/, 'signed-out caller is refused');
await fails(T, `insert into public.team_requests (type, charge_fund_id, purpose, amount) values ('Direct Expense', 'F-GEN', 'x', 1)`, [], /permission denied/, 'no direct insert');

// Validation.
await fails(T, `select public.direct_expense_file($1)`, [de({ purpose: ' ' })], /Say what was bought/, 'needs what was bought');
await fails(T, `select public.direct_expense_file($1)`, [de({ charge_fund_id: null })], /Choose the fund/, 'needs a fund');
await fails(T, `select public.direct_expense_file($1)`, [de({ charge_fund_id: 'F-EQP' })], /GPRIC General or a team fund/, 'only GPRIC General or a team fund');
await fails(T, `select public.direct_expense_file($1)`, [de({ pay_ref: '' })], /check number/, 'a check needs its number');
await fails(T, `select public.direct_expense_file($1)`, [de({ pay_method: 'Zelle' })], /debit card or check/, 'paid by debit card or check only');
await fails(T, `select public.direct_expense_file($1)`, [de({ invoices: [] })], /at least one invoice/, 'needs an invoice');
await fails(T, `select public.direct_expense_file($1)`, [de({ invoices: [{ vendor: '', amount: 3 }] })], /vendor and an amount/, 'each invoice needs a vendor');
await fails(T, `select public.direct_expense_file($1)`, [de({ invoices: [{ vendor: 'X', amount: 0 }] })], /vendor and an amount/, 'each invoice needs an amount');

// ---------------------------------------------------------------- invoices sum

const com0 = num(await one(T, `select public.fund_committed('F-9255')`));
const filed = await one(O, `select public.direct_expense_file($1)`, [de()]);
const d1 = filed.id;
const r1 = await req(d1);
ok(/^R-/.test(d1) && r1.type === 'Direct Expense' && r1.status === 'Submitted', 'officer files a direct expense, waiting for review');
ok(num(r1.amount) === 35.75 && num(filed.amount) === 35.75, 'request total is the sum of its invoices (35.75)');
ok(r1.team_id === null && r1.charge_fund_id === 'F-9255', 'charged to the chosen fund, no team');
ok(r1.vendor.includes('Sample Hardware') && r1.vendor.includes('Sample Robotics Supply'), 'vendors listed once each');
const inv = await q(`select vendor, amount, date::text d from public.receipts where request_id = $1 order by id`, [d1]);
ok(inv.length === 3 && inv.reduce((s, r) => s + num(r.amount), 0) === 35.75, 'all three invoices kept');
ok(inv[2].d === '2026-10-22', 'an invoice without a date takes the paid date');
ok((await outRows(d1)).length === 0, 'nothing posts before review');
ok(num(await one(T, `select public.fund_committed('F-9255')`)) === com0 + 35.75, 'filed direct expense counts as committed on its fund');
await fails(T, `select public.add_request_receipt($1, 'Late', 4, null, null, null, null)`, [d1], /invoices are fixed/, 'invoices are fixed after filing');

// ---------------------------------------------------------------- review posts as paid to the chosen fund

await fails(T, `select public.direct_expense_review($1)`, [d1], /not allowed for your role/, 'treasurer does not review');
await fails(B, `select public.direct_expense_review($1)`, [d1], /not allowed for your role/, 'board member does not review');
await fails(B, `select public.approve_request($1)`, [d1], /reviewed by the bookkeeper|reviewed, not approved/, 'a direct expense is not approved');
await fails(K, `select public.mark_request_paid($1, current_date, 'Check', '1')`, [d1], /Only an approved request/, 'a direct expense is not paid through payment');
const before9255 = await bal('F-9255');
const led1 = await one(K, `select public.direct_expense_review($1)`, [d1]);
const r1b = await req(d1);
ok(r1b.status === 'Reviewed' && r1b.reviewed_by === 'Sample Bookkeeper' && r1b.paid_date !== null, 'bookkeeper marks it reviewed');
const o1 = await outRows(d1);
ok(o1.length === 1 && o1[0].id === led1, 'review posts one ledger row');
ok(o1[0].fund_id === 'F-9255' && num(o1[0].amount) === 35.75 && o1[0].category === 'Robotics Teams', 'posted to the chosen team fund as Robotics Teams');
ok(o1[0].pay_method === 'Check' && o1[0].pay_ref === '2051' && o1[0].receipt === true, 'ledger row carries check number and receipt');
ok(new Date(o1[0].date).toISOString().slice(0, 10) === '2026-10-22', 'dated the day it was paid');
ok((await bal('F-9255')) === before9255 - 35.75, 'fund balance drops by the total');
ok(num(await one(T, `select public.fund_committed('F-9255')`)) === com0, 'no longer committed once posted');
await fails(K, `select public.direct_expense_review($1)`, [d1], /not waiting for review/, 'cannot review twice');

const g = await one(T, `select public.direct_expense_file($1)`, [de({ purpose: 'Insurance renewal', charge_fund_id: 'F-GEN', pay_method: 'Debit Card', pay_ref: null,
  invoices: [{ vendor: 'Sample Insurer', amount: 400 }] })]);
await as(K, `select public.direct_expense_review($1)`, [g.id]);
const og = await outRows(g.id);
ok(og.length === 1 && og[0].fund_id === 'F-GEN' && og[0].category === 'Administration' && og[0].pay_method === 'Debit Card', 'GPRIC General expense posts as Administration, debit card');
const totals = await one(T, `select public.portal_totals()`);
const f9255 = totals.funds.find((f) => f.id === 'F-9255');
ok(num(f9255.direct) >= 35.75, 'portal totals count it as a direct expense, not a reimbursement');

// ---------------------------------------------------------------- one payment per request

const many = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Many invoices', amount: 60 })]);
await as(T, `select public.approve_request($1)`, [many]);
await as(K, `select public.mark_request_paid($1, '2026-10-25', 'Check', '2060')`, [many]);
for (const [v, a] of [['A', 20], ['B', 25], ['C', 15]]) await as(K, `select public.add_request_receipt($1, $2, $3, null, null, null, null)`, [many, v, a]);
ok((await outRows(many)).length === 1, 'a request with three invoices has one payment row');
await fails(K, `select public.mark_request_paid($1, '2026-10-25', 'Check', '2061')`, [many], /Only an approved request/, 'cannot pay twice');
try {
  await db.exec(`insert into public.ledger (date, dir, amount, fund_id, request_id) values ('2026-10-26', 'out', 1, 'F-9255', '${many}')`);
  ok(false, 'a second payment row is refused (no error)');
} catch (e) { ok(/one payment covers the whole request/.test(e.message), 'a second payment row is refused, even for the owner -> ' + e.message); }

// ---------------------------------------------------------------- cancel before payment

const c1 = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Trip deposit', amount: 75 })]);
await as(T, `select public.approve_request($1)`, [c1]);
const ledCount = num(await one(T, `select count(*) from public.ledger`));
const balC = await bal('F-9255');
await fails(B, `select public.request_cancel($1, ' ')`, [c1], /reason/, 'cancel needs a reason');
await fails(B, `select public.request_cancel($1, null)`, [c1], /reason/, 'cancel needs a reason (null)');
await fails(C, `select public.request_cancel($1, 'x')`, [c1], /not allowed for your role/, 'team user cannot cancel');
const cr = await one(B, `select public.request_cancel($1, 'Trip called off')`, [c1]);
const rc1 = await req(c1);
ok(cr.status === 'Cancelled' && rc1.status === 'Cancelled' && rc1.cancel_reason === 'Trip called off' && rc1.cancelled_by === 'Sample Director', 'cancelled with its reason and who');
ok(num(await one(T, `select count(*) from public.ledger`)) === ledCount && (await bal('F-9255')) === balC, 'cancel posts nothing to the ledger');
ok(num(await one(T, `select public.fund_committed('F-9255')`)) === com0, 'a cancelled request is no longer committed');
await fails(K, `select public.mark_request_paid($1, current_date, 'Check', '1')`, [c1], /Only an approved request/, 'a cancelled request cannot be paid');
await fails(B, `select public.request_cancel($1, 'x')`, [many], /not yet paid/, 'a paid request cannot be cancelled');
await fails(B, `select public.request_cancel($1, 'x')`, [d1], /not yet paid/, 'a reviewed direct expense cannot be cancelled');
const dc = await one(T, `select public.direct_expense_file($1)`, [de({ purpose: 'Wrong order' })]);
await as(K, `select public.request_cancel($1, 'Entered by mistake')`, [dc.id]);
ok((await outRows(dc.id)).length === 0 && (await req(dc.id)).status === 'Cancelled', 'a direct expense cancelled before review posts nothing');
await fails(K, `select public.direct_expense_review($1)`, [dc.id], /not waiting for review/, 'a cancelled direct expense cannot be reviewed');

// ---------------------------------------------------------------- refunds return money to the same fund

await fails(B, `select public.request_refund($1, 5, '2026-10-28', 'Returned')`, [c1], /Only a paid request/, 'an unpaid request cannot be refunded');
await fails(B, `select public.request_refund($1, 40, '2026-10-28', 'Returned')`, [d1], /more than the \$35\.75/, 'refund cannot exceed what was paid');
await fails(B, `select public.request_refund($1, 5, '2026-10-28', 'Lost')`, [d1], /returned or cancelled/, 'refund reason is Returned or Cancelled');
await fails(C, `select public.request_refund($1, 5, '2026-10-28', 'Returned')`, [d1], /not allowed for your role/, 'team user cannot record a refund');
const balR = await bal('F-9255');
const rf = await one(B, `select public.request_refund($1, 10.25, '2026-10-28', 'Returned', 'Wrong size')`, [d1]);
const rfr = (await q(`select * from public.request_refunds where id = $1`, [rf]))[0];
const rl = (await q(`select * from public.ledger where id = $1`, [rfr.ledger_id]))[0];
ok(/^RF-/.test(rf) && num(rfr.amount) === 10.25 && rfr.reason === 'Returned' && rfr.note === 'Wrong size', 'refund recorded with amount, reason and note');
ok(rl.dir === 'in' && rl.source === 'Refund' && rl.fund_id === 'F-9255' && rl.request_id === d1 && num(rl.amount) === 10.25, 'refund is a ledger in row, source Refund, same fund, linked to the request');
ok((await bal('F-9255')) === balR + 10.25, 'the money goes back into the same fund');
ok((await outRows(d1)).length === 1, 'the original payment row stays');
await fails(B, `select public.request_refund($1, 1, '2026-10-28', 'Returned')`, [d1], /already recorded/, 'one refund per request');
const t2 = await one(T, `select public.portal_totals()`);
ok(num(t2.funds.find((f) => f.id === 'F-9255').direct) === num(f9255.direct) - 10.25, 'refund nets against the direct expense total');
ok(!('Refund' in t2.in_by_source), 'a refund is not counted as money raised');
const rfMany = await one(K, `select public.request_refund($1, 60, '2026-10-28', 'Cancelled')`, [many]);
ok((await q(`select fund_id from public.ledger where id = (select ledger_id from public.request_refunds where id = $1)`, [rfMany]))[0].fund_id === 'F-9255', 'a team request refund goes back to its team fund');
const logRows = await q(`select action from public.change_log where record_id in ($1, $2) order by id`, [d1, rf]);
ok(logRows.some((r) => r.action === 'Reviewed') && logRows.some((r) => r.action === 'Refunded'), 'History shows Reviewed and Refunded');
const refundLog = (await q(`select id from public.change_log where tbl = 'request_refunds' and record_id = $1`, [rf]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [refundLog], /fixed once recorded/, 'a refund is not rolled back by archiving it');
const reviewLog = (await q(`select id from public.change_log where tbl = 'team_requests' and record_id = $1 and action = 'Reviewed'`, [d1]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [reviewLog], /booked money/, 'a review that posted money is not rolled back silently');

// ---------------------------------------------------------------- replacement orders link both ways

const p1 = await one(T, `select public.direct_expense_file($1)`, [de({ purpose: 'Bumper fabric', invoices: [{ vendor: 'Sample Fabrics', amount: 18, file_name: 'f.pdf', file_path: 'receipts/f.pdf' }, { vendor: 'Sample Fabrics', amount: 7 }] })]);
await fails(B, `select public.request_cancel($1, 'Wrong colour', true)`, [p1.id], /Only the Treasurer, the bookkeeper/, 'only a filer can reorder a direct expense');
const rp = await one(K, `select public.request_cancel($1, 'Wrong colour', true)`, [p1.id]);
const oldR = await req(p1.id);
const newR = await req(rp.replacement);
ok(rp.replacement && oldR.status === 'Cancelled' && oldR.replaced_by_id === rp.replacement, 'cancelled request points at its replacement');
ok(newR.replaces_id === p1.id && newR.status === 'Submitted' && newR.purpose === 'Bumper fabric, replacement order', 'replacement points back, waiting for review');
ok(newR.type === 'Direct Expense' && newR.charge_fund_id === 'F-9255' && num(newR.amount) === 25, 'replacement keeps the type, fund and total');
ok(num(await one(T, `select count(*) from public.receipts where request_id = $1`, [rp.replacement])) === 2, 'replacement copies the invoices');
ok((await outRows(p1.id)).length === 0, 'the cancelled original posted nothing');
await as(K, `select public.direct_expense_review($1)`, [rp.replacement]);
ok((await outRows(rp.replacement)).length === 1, 'the replacement posts once on review');
// A replacement entered separately is linked afterwards.
const x1 = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Motors', amount: 90 })]);
await as(B, `select public.request_cancel($1, 'Out of stock')`, [x1]);
const x2 = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Motors, other vendor', amount: 95 })]);
await fails(B, `select public.request_link_replacement($1, $2)`, [x2, x1], /Only a cancelled request/, 'only a cancelled request is replaced');
await as(B, `select public.request_link_replacement($1, $2)`, [x1, x2]);
ok((await req(x1)).replaced_by_id === x2 && (await req(x2)).replaces_id === x1, 'linking a separate replacement sets both ways');
await fails(B, `select public.request_link_replacement($1, $2)`, [x1, many], /already replaced/, 'a request is replaced once');

// ---------------------------------------------------------------- History roll back cannot undo a refunded payment

const ha = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Roll back probe A', amount: 100 })]);
await as(T, `select public.approve_request($1)`, [ha]);
await as(K, `select public.mark_request_paid($1, '2026-10-25', 'Check', '9001')`, [ha]);
const rfA = await one(K, `select public.request_refund($1, 30, '2026-10-28', 'Returned')`, [ha]);
const balA = await bal('F-9255');
const paidLogA = (await q(`select id from public.change_log where tbl = 'team_requests' and record_id = $1 and action = 'Paid'`, [ha]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [paidLogA], /refund recorded/, 'rolling back the payment of a refunded request is refused');
const payA = (await outRows(ha)).filter((l) => !l.reversed_by_id);
ok((await req(ha)).status === 'Receipts Due' && payA.length === 1 && (await bal('F-9255')) === balA, 'payment and refund both still stand, fund unchanged');
await fails(T, `select public.ledger_reverse($1, 'test')`, [payA[0].id], /refund recorded|Undo it from the request/, 'the payment cannot be reversed by hand either');
await fails(B, `select public.request_cancel($1, 'test')`, [ha], /not yet paid|payment in the ledger/, 'a refunded request cannot be cancelled');
const rfLogA = (await q(`select id from public.change_log where tbl = 'request_refunds' and record_id = $1`, [rfA]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [rfLogA], /fixed once recorded/, 'the refund row is not rolled back on its own');
const rfLedA = (await q(`select id from public.change_log where tbl = 'ledger' and (after ->> 'request_id') = $1 and (after ->> 'source') = 'Refund'`, [ha]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [rfLedA], /payment on the request/, 'the refund ledger row is not rolled back on its own');
await fails({ role: 'postgres' }, `update public.team_requests set status = 'Approved' where id = '${ha}'`, [], /refund recorded|status changes only/, 'even the owner cannot step a refunded request back');

// ---------------------------------------------------------------- History roll back cannot un-cancel a reordered request

const hb = await one(T, `select public.direct_expense_file($1)`, [de({ purpose: 'Roll back probe B', charge_fund_id: 'F-GEN', pay_method: 'Debit Card', pay_ref: null, invoices: [{ vendor: 'Sample Vendor', amount: 50 }] })]);
const cb = await one(T, `select public.request_cancel($1, 'mistake', true)`, [hb.id]);
const cLogB = (await q(`select id from public.change_log where tbl = 'team_requests' and record_id = $1 and action = 'Cancelled' order by id desc`, [hb.id]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [cLogB], /stays cancelled/, 'rolling back a cancel that was reordered is refused');
const hbR = await req(hb.id);
ok(hbR.status === 'Cancelled' && hbR.replaced_by_id === cb.replacement, 'the original stays cancelled and linked');
await fails(K, `select public.direct_expense_review($1)`, [hb.id], /not waiting for review/, 'the original cannot be reviewed alongside its replacement');
const linkLog = (await q(`select id from public.change_log where tbl = 'team_requests' and record_id = $1 order by id desc limit 1`, [x1]))[0].id;
await fails(T, `select public.rollback_change($1, 'test')`, [linkLog], /never removed|stays cancelled/, 'a separately linked replacement cannot be unlinked by roll back');
ok((await req(x1)).replaced_by_id === x2, 'the separate link stands');
// A plain cancel (no replacement) can still be rolled back.
const hd = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Roll back probe D', amount: 20 })]);
await as(T, `select public.approve_request($1)`, [hd]);
await as(B, `select public.request_cancel($1, 'off')`, [hd]);
const dLog = (await q(`select id from public.change_log where tbl = 'team_requests' and record_id = $1 and action = 'Cancelled'`, [hd]))[0].id;
await as(T, `select public.rollback_change($1, 'test')`, [dLog]);
ok((await req(hd)).status === 'Approved', 'a plain cancel rolls back to where it was');

// ---------------------------------------------------------------- direct expense review passes the team spending rules

const big = Math.round(((await bal('F-9255')) + 1000) * 100) / 100;
const hc = await one(O, `select public.direct_expense_file($1)`, [de({ purpose: 'Roll back probe C', invoices: [{ vendor: 'Sample Big Vendor', amount: big }] })]);
ok(Array.isArray(hc.warnings) && hc.warnings.length > 0, 'filing an overspend warns');
await fails(K, `select public.direct_expense_review($1)`, [hc.id], /Blocked: .*overspend/, 'review of an overspend on a team fund is blocked');
await fails(K, `select public.direct_expense_review($1, 'because')`, [hc.id], /Only the Treasurer can override/, 'the bookkeeper cannot override');
await fails(B, `select public.direct_expense_review($1, 'because')`, [hc.id], /not allowed for your role/, 'a board member cannot review with an override');
await fails(T, `select public.direct_expense_review($1)`, [hc.id], /not allowed for your role/, 'the Treasurer reviews only with an override reason');
await as(T, `select public.direct_expense_review($1, 'Grant money arriving next week')`, [hc.id]);
const ovC = await q(`select action, fund_id, reason from public.money_overrides where record_id = $1`, [hc.id]);
ok((await req(hc.id)).status === 'Reviewed' && ovC.length >= 1 && ovC[0].action === 'review' && ovC[0].fund_id === 'F-9255', 'the Treasurer override posts it and is recorded');
const hg = await one(T, `select public.direct_expense_file($1)`, [de({ purpose: 'Roll back probe G', charge_fund_id: 'F-GEN', pay_method: 'Debit Card', pay_ref: null, invoices: [{ vendor: 'Sample Office', amount: 12 }] })]);
await fails(T, `select public.direct_expense_review($1, 'any reason')`, [hg.id], /The bookkeeper reviews direct expenses/, 'the Treasurer cannot review a GPRIC General expense, even with a reason');
ok((await bal(otherFund)) > 5, 'the other team fund has more than $5');
const hw = await one(O, `select public.direct_expense_file($1)`, [de({ purpose: 'Roll back probe W', charge_fund_id: otherFund, invoices: [{ vendor: 'Sample Small Vendor', amount: 5 }] })]);
await fails(T, `select public.direct_expense_review($1, 'any reason')`, [hw.id], /The bookkeeper reviews direct expenses/, 'the Treasurer cannot review a team-fund expense that breaks no rule');
ok((await req(hg.id)).status === 'Submitted' && (await req(hw.id)).status === 'Submitted', 'both stay waiting for the bookkeeper');
ok(num(await one(T, `select count(*) from public.money_overrides where record_id = any($1)`, [[hg.id, hw.id]])) === 0, 'a refused Treasurer review logs no override');
await as(K, `select public.direct_expense_review($1)`, [hg.id]);
await as(K, `select public.direct_expense_review($1, 'not needed')`, [hw.id]);
ok((await req(hw.id)).status === 'Reviewed', 'the bookkeeper reviews a team-fund expense that breaks no rule');
ok(num(await one(T, `select count(*) from public.money_overrides where record_id = any($1)`, [[hg.id, hw.id]])) === 0, 'GPRIC General and in-balance team expenses log no override');

// ---------------------------------------------------------------- team users see only their own team

for (const t of ['team_requests', 'request_refunds', 'receipts', 'ledger']) {
  ok(num(await one(C, `select count(*) from public.${t}`)) === 0, `team user reads no rows in ${t}`);
}
await fails(C, `insert into public.request_refunds (request_id, amount, date, reason) values ($1, 1, current_date, 'Returned')`, [d1], /permission denied/, 'team user cannot write refunds');
const portal = await one(C, `select public.team_portal()`);
const otherIds = (await q(`select id from public.team_requests where team_id is distinct from 'T-9255'`)).map((r) => r.id);
ok(portal.team.id === 'T-9255' && !portal.requests.some((r) => otherIds.includes(r.id)), 'team portal shows no other team’s requests or direct expenses');
const portal2 = await one(C2, `select public.team_portal()`);
ok(portal2.team.id === otherTeam && !portal2.requests.some((r) => [c1, many, x1, x2].includes(r.id)), 'the other team does not see this team’s requests');
const theirLog = await q(`select distinct team_id from public.change_log where id in (select id from public.change_log)`);
ok(theirLog.length > 0, 'log has rows');
const seen = await as(C2, `select distinct team_id from public.change_log_team`);
ok(seen.rows.every((r) => r.team_id === otherTeam), 'the other team’s history holds only its own team');
ok(num(await one(T, `select count(*) from public.ledger where fund_id = $1 and request_id = any($2)`, [otherFund, [d1, many, rp.replacement]])) === 0, 'nothing posted to another team’s fund');

// ---------------------------------------------------------------- sample clear still works

const cl = await one(T, `select public.clear_sample_data()`);
ok(cl.funds !== undefined && cl.refunds === 0, 'clear sample data runs and keeps real refunds ' + JSON.stringify(cl));
ok((await q(`select 1 from public.funds where id = 'F-9255'`)).length === 1, 'a fund real requests are charged to is kept');

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exit(failed ? 1 : 0);
