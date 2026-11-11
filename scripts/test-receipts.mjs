// P33, receipts: many receipts on a team reimbursement (its total is their sum), missing-receipt reminders (portal only,
// nothing is emailed), attaching a missing file, the team's own receipts and its read-only cancel and refund, team
// isolation, role gates and the History roll back paths.
// Runs on its own: node scripts/test-receipts.mjs   (exits 1 when a check fails). Sample people and amounts only.
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
  update public.settings set general_fund_id = 'F-GEN', receipt_days = 100000, approval_threshold = 500, approvals_under = 1, approvals_over = 1;
`);
const T = signed(TREAS, 'treasurer@example.org');
const B = signed(BOARD, 'board@example.org');
const K = signed(BOOKS, 'books@example.org');
const O = signed(OFFICER, 'officer@example.org');
const C = signed(COACH, 'coach@example.org');
const C2 = signed(OTHER, 'other@example.org');
const otherTeam = (await q(`select team_id from public.team_users where user_id = $1`, [OTHER]))[0].team_id;
const req = async (rid) => (await q(`select * from public.team_requests where id = $1`, [rid]))[0];
const live = async (rid) => (await q(`select * from public.receipts where request_id = $1 and archived_at is null order by id`, [rid]));
const logId = async (tbl, rec, action) => (await q(`select id from public.change_log where tbl = $1 and record_id = $2 and action = $3 order by id desc limit 1`, [tbl, rec, action]))[0]?.id;
const portalReq = async (claims, rid) => { const p = await one(claims, `select public.team_portal()`); return [...p.requests, ...p.direct].find((x) => x.id === rid); };

const rc = (vendor, amount, file = 'team/T-9255/' + vendor.toLowerCase() + '.pdf') => ({ vendor, amount, date: '2026-10-20', file_name: vendor + '.pdf', file_path: file });
const reimb = (receipts, extra = {}) => JSON.stringify({ type: 'Reimbursement', category: 'Robot Parts & Construction', purchase_date: '2026-10-20',
  zelle_contact: 'coach@example.org', certified: true, receipts, ...extra });

// ---------------------------------------------------------------- many receipts on a team reimbursement

await fails(C, `select public.submit_team_request($1)`, [reimb([rc('AndyMark', 0)])], /Each receipt needs an amount/, 'each receipt needs an amount');
await fails(C, `select public.submit_team_request($1)`, [reimb([rc('AndyMark', 10, null)])], /Attach the receipt/, 'each receipt needs its file');
await fails(C, `select public.submit_team_request($1)`, [reimb([rc('AndyMark', 10, 'team/' + otherTeam + '/x.pdf')])], /not in this team/, 'receipts only from the team’s own folder');
await fails(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Pre-Approval', purpose: 'x', amount: 10, certified: true, receipts: [rc('A', 1)] })],
  /after it is paid/, 'a pre-approval takes no receipts at submit');
const r1 = await one(C, `select public.submit_team_request($1)`, [reimb([rc('AndyMark', 42.7), rc('REV', 18.15), rc('Home Depot', 9.4)], { amount: 999 })]);
let x = await req(r1);
ok(num(x.amount) === 70.25, 'reimbursement total is the sum of its receipts (typed amount ignored) ' + x.amount);
ok((await live(r1)).length === 3, 'three receipts filed');
ok(x.vendor === 'AndyMark, Home Depot, REV', 'vendors listed on the request ' + x.vendor);
ok(x.receipt_path === null, 'no single receipt path when receipts are listed');

const single = await one(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Reimbursement', vendor: 'AndyMark', amount: 12, certified: true,
  zelle_contact: 'z', receipt_path: 'team/T-9255/one.pdf', receipt_name: 'one.pdf' })]);
ok(num((await req(single)).amount) === 12 && (await live(single)).length === 1, 'the 0003 single-receipt form still works');

// the team adds and removes receipts while the reimbursement waits with no approval
const a1 = await one(C, `select public.add_team_receipt($1, 'Pololu', 5.5, '2026-10-21', 'p.pdf', 'team/T-9255/p.pdf')`, [r1]);
ok(num((await req(r1)).amount) === 75.75, 'adding a receipt raises the total ' + (await req(r1)).amount);
await fails(C, `select public.add_team_receipt($1, 'x', 0, null, 'p.pdf', 'team/T-9255/p.pdf')`, [r1], /Enter the receipt amount/, 'a reimbursement receipt needs an amount');
await fails(C, `select public.add_team_receipt($1, 'x', 1, null, 'p.pdf', 'team/${otherTeam}/p.pdf')`, [r1], /Attach the receipt file/, 'team adds only from its own folder');
await fails(C, `select public.team_receipt_remove($1, ' ')`, [a1], /reason/, 'removing needs a reason');
await as(C, `select public.team_receipt_remove($1, 'Wrong receipt')`, [a1]);
ok(num((await req(r1)).amount) === 70.25, 'removing a receipt lowers the total');
await fails(C, `select public.team_receipt_remove($1, 'x')`, [(await live(single))[0].id], /at least one receipt/, 'the last receipt cannot be removed');

// the board adds and removes on an open reimbursement too
const b1 = await one(B, `select public.add_request_receipt($1, 'Board added', 4.75, '2026-10-22', null, 'team/T-9255/b.pdf', null)`, [r1]);
ok(num((await req(r1)).amount) === 75, 'board receipt raises the total');
await as(K, `select public.receipt_archive($1, 'Duplicate')`, [b1]);
ok(num((await req(r1)).amount) === 70.25, 'board removal lowers the total');

// the total is never typed once receipts are listed
await fails(B, `select public.request_save($1)`, [JSON.stringify({ id: r1, team_id: 'T-9255', type: 'Reimbursement', purpose: 'x', amount: 80 })],
  /sum of its receipts/, 'board cannot type a different total over the receipts');
await as(B, `select public.request_save($1)`, [JSON.stringify({ id: r1, team_id: 'T-9255', type: 'Reimbursement', purpose: 'Parts', amount: 70.25, vendor: 'AndyMark', zelle_contact: 'z' })]);
ok((await req(r1)).purpose === 'Parts', 'board can still edit the description at the same total');
await fails(C, `update public.team_requests set amount = 1 where id = '${r1}'`, [], /permission denied/, 'team user cannot write requests');
await fails(B, `update public.receipts set amount = 1 where id = '${(await live(r1))[0].id}'`, [], /permission denied/, 'board cannot edit a receipt in place');

// approved: the total is fixed
await as(T, `select public.approve_request($1)`, [r1]);
ok((await req(r1)).status === 'Approved', 'approved');
await fails(C, `select public.add_team_receipt($1, 'x', 1, null, 'p.pdf', 'team/T-9255/p.pdf')`, [r1], /not approved yet|only to your team/, 'team cannot add after approval');
await fails(B, `select public.add_request_receipt($1, 'x', 1, null, null, null, null)`, [r1], /receipts and total are fixed/, 'board cannot add after approval');
await fails(K, `select public.receipt_archive($1, 'x')`, [(await live(r1))[0].id], /receipts and total are fixed/, 'board cannot remove after approval');
await fails(C, `select public.team_receipt_remove($1, 'x')`, [(await live(r1))[0].id], /no longer be removed/, 'team cannot remove after approval');

// one payment for the whole request
await as(K, `select public.mark_request_paid($1, '2026-10-25', 'Zelle', 'Z1')`, [r1]);
const outs = await q(`select * from public.ledger where request_id = $1 and dir = 'out' and reverses_id is null`, [r1]);
ok(outs.length === 1 && num(outs[0].amount) === 70.25, 'one ledger payment for the receipts’ sum');
await fails(K, `select public.mark_request_paid($1, '2026-10-25', 'Zelle', 'Z2')`, [r1], /Only an approved request/, 'cannot pay twice');
await fails(T, `insert into public.ledger (date, dir, amount, fund_id, request_id) values (current_date, 'out', 1, 'F-9255', '${r1}')`, [],
  /permission denied|already paid/, 'no second payment row by hand');

// ---------------------------------------------------------------- History roll back paths

const r2 = await one(C, `select public.submit_team_request($1)`, [reimb([rc('Andy', 20), rc('Rev', 10)])]);
const added = await one(C, `select public.add_team_receipt($1, 'Extra', 7, null, 'e.pdf', 'team/T-9255/e.pdf')`, [r2]);
ok(num((await req(r2)).amount) === 37, 'added to 37');
const amtLog = await logId('team_requests', r2, 'Changed');
ok(!!amtLog, 'the total change is logged');
await fails(T, `select public.rollback_change($1, 'test')`, [amtLog], /sum of its receipts/, 'rolling back the total by itself is refused');
await fails(B, `select public.rollback_change($1, 'test')`, [await logId('receipts', added, 'Added')], /not allowed for your role/, 'only the Treasurer rolls back');
await as(T, `select public.rollback_change($1, 'Entered twice')`, [await logId('receipts', added, 'Added')]);
ok(num((await req(r2)).amount) === 30 && (await live(r2)).length === 2, 'rolling back an added receipt archives it and the total follows');
const arch = await logId('receipts', added, 'Archived');
await fails(T, `select public.rollback_change($1, 'test')`, [arch], /Change a receipt from its request/, 'an archived receipt is not put back by roll back');
await as(T, `select public.approve_request($1)`, [r2]);
await as(K, `select public.mark_request_paid($1, '2026-10-26', 'Zelle', 'Z3')`, [r2]);
await as(B, `select public.request_refund($1, 10, '2026-10-27', 'Returned', 'Wrong part')`, [r2]);
await fails(T, `select public.rollback_change($1, 'test')`, [await logId('team_requests', r2, 'Paid')], /refund recorded/, 'a refunded payment is not rolled back');
await fails(T, `select public.rollback_change($1, 'test')`, [await logId('receipts', (await live(r2))[0].id, 'Added')],
  /receipts and total are fixed/, 'a paid reimbursement’s receipts are not rolled back');
await fails(B, `select public.add_request_receipt($1, 'x', 1, null, null, null, null)`, [r2], /receipts and total are fixed/, 'no receipt added to a paid reimbursement');

// ---------------------------------------------------------------- the team sees its cancel and refund, read only

const p0 = await portalReq(C, r2);
ok(p0.refund && num(p0.refund.amount) === 10 && p0.refund.reason === 'Returned', 'team sees the refund on its request');
ok(p0.receipt_list.length === 2 && p0.receipts === 2 && num(p0.receipts_total) === 30, 'team sees only live receipts (archived ones drop out)');
const r3 = await one(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Pre-Approval', purpose: 'Trip', category: 'Registration Fees', amount: 40, certified: true, pay_to: 'Vendor directly' })]);
await as(B, `select public.request_cancel($1, 'Event moved')`, [r3]);
const p3 = await portalReq(C, r3);
ok(p3.status === 'Cancelled' && p3.cancel_reason === 'Event moved' && !!p3.cancelled_at, 'team sees the cancel and its reason');
await fails(C, `select public.request_cancel($1, 'x')`, [r2], /not allowed for your role/, 'team cannot cancel');
await fails(C, `select public.request_refund($1, 1, current_date, 'Returned')`, [r2], /not allowed for your role/, 'team cannot refund');

// ---------------------------------------------------------------- missing receipts and reminders

const pa = await one(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Pre-Approval', purpose: 'Field tiles', category: 'Tools & Shop Supplies', amount: 60, certified: true, pay_to: 'Vendor directly' })]);
await fails(B, `select public.receipt_remind($1)`, [pa], /Nothing is missing/, 'no reminder before it is paid');
await as(T, `select public.approve_request($1)`, [pa]);
await as(K, `select public.mark_request_paid($1, '2026-10-26', 'Check', '3001')`, [pa]);
ok((await portalReq(C, pa)).missing === true, 'a paid pre-approval with no receipt is missing');
await fails(C, `select public.receipt_remind($1)`, [pa], /not allowed for your role/, 'team cannot send a reminder');
await fails(signed('00000000-0000-0000-0000-0000000000ff', 'x@example.org'), `select public.receipt_remind($1)`, [pa], /not allowed|sign-in|two-step/i, 'an outsider cannot send a reminder');
await fails(B, `insert into public.receipt_reminders (request_id) values ('${pa}')`, [], /permission denied/, 'reminders are written only by receipt_remind');
const rm = await one(B, `select public.receipt_remind($1, 'Please upload the field tiles invoice')`, [pa]);
ok(/^RM-/.test(rm), 'board sends a portal reminder ' + rm);
await one(K, `select public.receipt_remind($1)`, [pa]);
const pr = await portalReq(C, pa);
ok(pr.reminder && pr.reminder.by === 'Sample Bookkeeper', 'team sees the latest reminder on its request');
ok(await logId('receipt_reminders', rm, 'Reminded'), 'reminder logged as Reminded');
ok((await as(C, `select * from public.receipt_reminders`)).rows.length === 0, 'team cannot read the reminders table');
ok((await as(B, `select * from public.receipt_reminders`)).rows.length === 2, 'board reads reminders');
await fails(T, `delete from public.receipt_reminders where id = '${rm}'`, [], /permission denied|never deleted/, 'reminders are never deleted');
await as(T, `select public.rollback_change($1, 'Sent by mistake')`, [await logId('receipt_reminders', rm, 'Reminded')]);
ok((await q(`select archived_at from public.receipt_reminders where id = $1`, [rm]))[0].archived_at !== null, 'rolling back a reminder archives it');
await fails(B, `select public.receipt_remind($1)`, [r1], /Nothing is missing/, 'no reminder when every receipt has its file');
await as(C, `select public.add_team_receipt($1, 'Tiles', 55, '2026-10-28', 't.pdf', 'team/T-9255/t.pdf')`, [pa]);
ok((await portalReq(C, pa)).missing === false, 'missing clears once the receipt is in');

// a direct expense invoice filed without its file: the board attaches it later
const de = await one(O, `select public.direct_expense_file($1)`, [JSON.stringify({ purpose: 'Field build', charge_fund_id: 'F-9255', pay_method: 'Check', pay_ref: '2051', paid_date: '2026-10-21',
  invoices: [{ vendor: 'Lowes', amount: 25, file_name: 'l.pdf', file_path: 'requests/direct/l.pdf' }, { vendor: 'Menards', amount: 15 }] })]);
const deInv = (await live(de.id)).find((y) => y.file_path === null);
ok((await portalReq(C, de.id))?.missing === true, 'team sees the direct expense charged to its fund, missing a file');
ok(!(await one(C2, `select public.team_portal()`)).direct.some((y) => y.id === de.id), 'another team does not see it');
await fails(C, `select public.receipt_attach($1, 'm.pdf', 'team/T-9255/m.pdf')`, [deInv.id], /not allowed for your role/, 'team cannot use the board attach');
await fails(C, `select public.team_receipt_attach($1, 'm.pdf', 'team/T-9255/m.pdf')`, [deInv.id], /not found/, 'team cannot attach to a direct expense invoice');
await fails(K, `select public.receipt_attach($1, 'm.pdf', ' ')`, [deInv.id], /Choose the file/, 'attach needs a file');
await as(K, `select public.receipt_attach($1, 'm.pdf', 'requests/direct/m.pdf')`, [deInv.id]);
x = (await q(`select * from public.receipts where id = $1`, [deInv.id]))[0];
ok(x.file_path === 'requests/direct/m.pdf' && num(x.amount) === 15 && num(de.amount) === 40, 'file attached; invoice amount and total unchanged');
await fails(K, `select public.receipt_attach($1, 'm.pdf', 'requests/direct/m2.pdf')`, [deInv.id], /already has its file/, 'a file is never replaced');
await fails(T, `select public.rollback_change($1, 'test')`, [await logId('receipts', deInv.id, 'Changed')], /Change a receipt from its request/, 'attaching a file is not rolled back');

// a team receipt without a file (entered by the board): the team attaches it from its own folder
const nf = await one(B, `select public.add_request_receipt($1, 'Cash store', 3, null, null, null, null)`, [pa]);
await fails(C2, `select public.team_receipt_attach($1, 'n.pdf', 'team/${otherTeam}/n.pdf')`, [nf], /not found/, 'another team cannot attach to this team’s receipt');
await fails(C, `select public.team_receipt_attach($1, 'n.pdf', 'team/${otherTeam}/n.pdf')`, [nf], /not in this team/, 'team attaches only from its own folder');
await as(C, `select public.team_receipt_attach($1, 'n.pdf', 'team/T-9255/n.pdf')`, [nf]);
ok((await q(`select file_path from public.receipts where id = $1`, [nf]))[0].file_path === 'team/T-9255/n.pdf', 'team attached its file');

// a reimbursement the board entered (request_save keeps one file on the request, no receipt rows) and paid without its file
const legacy = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Reimbursement', purpose: 'Legacy', amount: 11, vendor: 'Shop', zelle_contact: 'z', requestor_name: 'Sample Coach', requestor_email: 'coach@example.org' })]);
await as(T, `select public.approve_request($1)`, [legacy]);
await as(K, `select public.mark_request_paid($1, '2026-10-26', 'Zelle', 'Z9')`, [legacy]);
ok((await portalReq(C, legacy)).missing === true, 'a paid reimbursement with no receipt at all is missing');
await as(B, `select public.add_request_receipt($1, 'Shop', 11, null, 's.pdf', 'team/T-9255/s.pdf', null)`, [legacy]);
ok(num((await req(legacy)).amount) === 11 && (await portalReq(C, legacy)).missing === false, 'its first receipt can still be added; the paid total stays');
await fails(B, `select public.add_request_receipt($1, 'Shop', 1, null, null, null, null)`, [legacy], /receipts and total are fixed/, 'but no more after that');

// ---------------------------------------------------------------- team isolation

await fails(C2, `select public.add_team_receipt($1, 'x', 1, null, 'p.pdf', 'team/${otherTeam}/p.pdf')`, [pa], /only to your team/, 'another team cannot add a receipt here');
await fails(C2, `select public.team_receipt_remove($1, 'x')`, [(await live(pa))[0].id], /not found/, 'another team cannot remove a receipt here');
const p2 = await one(C2, `select public.team_portal()`);
ok(![...p2.requests, ...p2.direct].some((y) => [r1, r2, r3, pa, single, de.id].includes(y.id)), 'another team’s portal holds none of these');
const seen = await as(C2, `select distinct team_id from public.change_log_team`);
ok(seen.rows.every((y) => y.team_id === otherTeam), 'another team’s History holds only its own team');
const mine = await as(C, `select tbl, record_id from public.change_log_team where tbl in ('receipts','receipt_reminders')`);
ok(mine.rows.some((y) => y.tbl === 'receipt_reminders') && mine.rows.every((y) => y.tbl !== 'receipts' || y.record_id !== deInv.id), 'team History has its reminders, not direct expense invoices');
await fails(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'team/${otherTeam}/x.pdf')`, [], /row-level security/, 'team cannot upload into another team’s folder');
await as(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'team/T-9255/ok.pdf')`);
ok(true, 'team uploads into its own folder');
await fails(B, `select public.add_team_receipt($1, 'x', 1, null, 'p.pdf', 'team/T-9255/p.pdf')`, [pa], /Team sign-in/, 'board members do not use the team functions');

// ---------------------------------------------------------------- sample clear

const sampleReq = (await q(`select r.id from public.team_requests r where r.sample and r.status in ('Paid','Receipts Due') and public.receipt_missing(r.id) limit 1`))[0]?.id;
ok(!!sampleReq, 'a sample paid request is missing its receipt ' + sampleReq);
if (sampleReq) { await one(B, `select public.receipt_remind($1)`, [sampleReq]); }
const cl = await one(T, `select public.clear_sample_data()`);
ok(cl.funds !== undefined, 'clear sample data still runs ' + JSON.stringify(cl));
ok((await q(`select count(*)::int n from public.receipt_reminders where sample`))[0].n === 0, 'sample reminders cleared with their requests');
ok((await q(`select count(*)::int n from public.receipt_reminders where not sample`))[0].n === 2, 'real reminders kept');

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exit(failed ? 1 : 0);
