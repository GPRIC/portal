// Runs every migration in supabase/migrations against an in-memory Postgres (PGlite) with stand-ins for
// Supabase's auth and storage schemas, then checks the access rules and money actions.
// Usage: node scripts/test-db.mjs        (exits 1 on the first failed check)
import { openDb } from './pg-stub.mjs';

const db = await openDb();

const BOARD1 = '00000000-0000-0000-0000-0000000000b1';
const BOARD2 = '00000000-0000-0000-0000-0000000000b2';
const COACH = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000c2';
const BOARD3 = '00000000-0000-0000-0000-0000000000b3';

let failed = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed++; };

// Run sql as a signed-in user (role authenticated) with the given claims, inside a transaction.
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
const board = (sub, email) => ({ sub, email, aal: 'aal2', role: 'authenticated' });

// Invites: two board members, one coach of T-9255, one coach of another team.
await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Casey Coach', 'Coach');
  insert into public.team_invites (team_id, email, name, role) select id, 'other@example.org', 'Olive', 'Treasurer' from public.teams where id <> 'T-9255' limit 1;
  insert into auth.users (id, email, invited_at) values
    ('${BOARD1}', 'president@gpric.net', now()), ('${BOARD2}', 'director1@gpric.net', now()),
    ('${COACH}', 'coach@example.org', now()), ('${OTHER}', 'other@example.org', now());
`);
const pa = await db.query(`select user_id::text from public.portal_access order by 1`);
ok(pa.rows.length === 2 && !pa.rows.some((r) => r.user_id === COACH), 'team invite does not grant board access');
const tu = await db.query(`select team_id from public.team_users where user_id = $1`, [COACH]);
ok(tu.rows[0]?.team_id === 'T-9255', 'team invite creates the team login');
await db.exec(`update auth.users set email = 'coach2@example.org' where id = '${COACH}'`);
ok((await db.query(`select 1 from public.portal_access where user_id = $1`, [COACH])).rows.length === 0, 'email change keeps a team user off the board');

const B1 = board(BOARD1, 'president@gpric.net');
const B2 = board(BOARD2, 'director1@gpric.net');
const B3 = board(BOARD3, 'books@example.org');
const C = board(COACH, 'coach2@example.org');
const C1 = { ...C, aal: 'aal1' };

ok((await as(B1, `select public.whoami() w`)).rows[0].w === 'board', 'whoami: board');
ok((await as(C, `select public.whoami() w`)).rows[0].w === 'team', 'whoami: team');
ok((await as(C1, `select public.whoami() w`)).rows[0].w === null, 'whoami: team without two-step is nobody');

// Team users read no tables directly.
for (const t of ['teams', 'funds', 'team_requests', 'ledger', 'donations', 'donors', 'receipts', 'request_approvals', 'settings']) {
  const n = (await as(C, `select count(*)::int n from public.${t}`)).rows[0].n;
  ok(n === 0, `team user sees no rows in ${t}`);
}
await fails(C, `select public.approve_request('R-1001')`, [], /Board sign-in/, 'team user cannot approve');
await fails(C1, `select public.team_portal()`, [], /two-step/, 'team portal needs two-step');

const portal = (await as(C, `select public.team_portal() p`)).rows[0].p;
ok(portal.team.id === 'T-9255', 'team portal returns own team');
ok(portal.requests.every((r) => r.id) && portal.gifts.every((g) => 'donor' in g), 'team portal lists requests and gifts');
const otherIds = (await db.query(`select id from public.team_requests where team_id <> 'T-9255'`)).rows.map((r) => r.id);
ok(!portal.requests.some((r) => otherIds.includes(r.id)), 'team portal hides other teams\' requests');

// Roles: BOARD1 is the Treasurer, BOARD2 a board member, BOARD3 the bookkeeper.
await db.exec(`insert into auth.users (id, email, invited_at) values ('${BOARD3}', 'books@example.org', now());
  update public.portal_access set role = 'treasurer' where user_id = '${BOARD1}';
  update public.portal_access set role = 'bookkeeper' where user_id = '${BOARD3}';`);
ok((await as(B1, `select public.my_role() r`)).rows[0].r === 'treasurer', 'role: treasurer');
ok((await as(B3, `select public.whoami() w`)).rows[0].w === 'board', 'bookkeeper is on the board side');
await fails(B2, `select public.settings_save_rules(600, 1, 2)`, [], /not allowed for your role/, 'approval rules are Treasurer only');
await as(B1, `select public.settings_save_rules(500, 1, 2)`);
await fails(B1, `update public.settings set general_fund_id = 'F-GEN'`, [], /permission denied/, 'settings take no direct writes');
await db.exec(`update public.settings set general_fund_id = 'F-GEN'`);

// Submit: clear any overdue on T-9255 first so the block test is deliberate.
await db.exec(`select set_config('gpric.via', 'admin', false); update public.team_requests set status = 'Closed' where team_id = 'T-9255' and status = 'Receipts Due'; select set_config('gpric.via', '', false);`);
// Give the team fund enough money for the tests below.
await as(B1, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-07-02', dir: 'in', amount: 5000, fund_id: 'F-9255', source: 'Test Deposit' })]);
const reqP = (await as(C, `select public.submit_team_request($1) id`, [JSON.stringify({
  type: 'Pre-Approval', purpose: 'Field elements', category: 'Robot Parts & Construction', amount: 800,
  pay_to: 'Vendor directly', needed_by: '2026-11-20', certified: true })])).rows[0].id;
ok(/^R-/.test(reqP), 'team submits a pre-approval');
await fails(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Reimbursement', amount: 20, certified: true, zelle_contact: 'x' })],
  /Attach the receipt/, 'reimbursement needs a receipt');
await fails(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Reimbursement', amount: 20, certified: true, zelle_contact: 'x', receipt_path: 'team/T-OTHER/a.pdf' })],
  /not in this team/, 'receipt must be in the team folder');
await fails(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Pre-Approval', amount: 20, purpose: 'x' })],
  /certification/, 'certification required');
const reqR = (await as(C, `select public.submit_team_request($1) id`, [JSON.stringify({
  type: 'Reimbursement', vendor: 'AndyMark', category: 'Robot Parts & Construction', amount: 42.5, purchase_date: '2026-10-30',
  zelle_contact: 'coach@example.org', receipt_path: 'team/T-9255/r.pdf', receipt_name: 'r.pdf', certified: true })])).rows[0].id;
ok((await db.query(`select count(*)::int n from public.receipts where request_id = $1`, [reqR])).rows[0].n === 1, 'reimbursement files its receipt');

// Approvals: $800 needs 2, $42.50 needs 1. Requestor email blocks self-approval.
await db.exec(`update public.team_requests set requestor_email = 'director1@gpric.net' where id = '${reqR}'`);
await fails(B2, `select public.approve_request($1)`, [reqR], /You made this request/, 'requestor cannot approve own request');
let a = (await as(B1, `select public.approve_request($1) a`, [reqP])).rows[0].a;
ok(a.approvals === 1 && a.needed === 2 && a.status === 'Submitted', 'first of two approvals keeps it waiting');
await fails(B1, `select public.approve_request($1)`, [reqP], /already approved/, 'one approval per member');
a = (await as(B2, `select public.approve_request($1) a`, [reqP])).rows[0].a;
ok(a.status === 'Approved', 'second approval approves');
a = (await as(B1, `select public.approve_request($1) a`, [reqR])).rows[0].a;
ok(a.status === 'Approved' && a.needed === 1, 'under threshold needs one approval');
await fails(B1, `insert into public.request_approvals (request_id, user_id, approver_name) values ($1, $2, 'x')`, [reqP, BOARD1],
  /permission denied/, 'approvals only through approve_request');

// Pay.
await fails(B1, `select public.mark_request_paid($1, '2026-08-01', 'Cash')`, [reqP], /Pick how/, 'pay method must be a known one');
await fails(B1, `select public.mark_request_paid($1, '2026-08-01', null)`, [reqP], /Pick how/, 'pay method required');
await fails(B2, `select public.mark_request_paid($1, '2026-08-01', 'Check', '1042')`, [reqP], /not allowed for your role/, 'board members do not pay');
await as(B3, `select public.mark_request_paid($1, '2026-08-01', 'Check', '1042')`, [reqP]);
await as(B1, `select public.mark_request_paid($1, '2026-11-01', 'Zelle', 'ZC77')`, [reqR]);
const st = (await db.query(`select id, status, pay_method, pay_ref from public.team_requests where id in ($1, $2) order by id`, [reqP, reqR])).rows;
ok(st.find((r) => r.id === reqP).status === 'Receipts Due' && st.find((r) => r.id === reqR).status === 'Paid', 'P goes to Receipts Due, R to Paid');
const led = (await db.query(`select pay_method, pay_ref, category from public.ledger where request_id = $1`, [reqP])).rows[0];
ok(led.pay_method === 'Check' && led.pay_ref === '1042' && led.category === 'Robotics Teams', 'ledger row carries method and number');

// Overdue blocks new requests; a receipt can be added.
await fails(C, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Pre-Approval', purpose: 'x', amount: 5, certified: true })],
  /New requests are paused/, 'overdue receipts pause new requests');
const rc = (await as(C, `select public.add_team_receipt($1, 'AndyMark', 790, '2026-08-05', 'a.pdf', 'team/T-9255/a.pdf') id`, [reqP])).rows[0].id;
ok(/^RC-/.test(rc), 'team adds a receipt');
await fails(C, `select public.add_team_receipt($1, 'x', 1, null, 'a.pdf', 'team/T-9255/a.pdf')`, [otherIds[0]], /only to your team/, 'no receipts on other teams');

// Decline needs a reason.
const reqD = (await as(B2, `select public.request_save($1) id`, [JSON.stringify({ team_id: 'T-9255', type: 'Pre-Approval', purpose: 'Trip', amount: 50 })])).rows[0].id;
await fails(B1, `select public.decline_request($1, ' ')`, [reqD], /reason/, 'decline needs a reason');
await as(B1, `select public.decline_request($1, 'Not a team cost')`, [reqD]);
ok((await db.query(`select status, decline_reason from public.team_requests where id = $1`, [reqD])).rows[0].decline_reason === 'Not a team cost', 'decline records reason');

// Storage: team folder only.
await as(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'team/T-9255/x.pdf')`);
await fails(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'receipts/x.pdf')`, [], /row-level security/, 'team cannot upload outside its folder');
await fails(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'team/T-OTHER/x.pdf')`, [], /row-level security/, 'team cannot upload to another team');
ok((await as(C, `select count(*)::int n from storage.objects`)).rows[0].n === 1, 'team reads only its own files');

// Tips: own rows only.
await as(C, `insert into public.seen_tips (user_id, tip_key) values ($1, 'team.new')`, [COACH]);
await fails(C, `insert into public.seen_tips (user_id, tip_key) values ($1, 'x')`, [BOARD1], /row-level security/, 'tips are per user');

// Zeffy.
// Made-up payments only: real Zeffy rows never go in this repository.
await db.exec(`insert into public.zeffy_skip (zeffy_key, reason) values ('2026-09-01|09:00|9000.00|grantor', 'Test: grant cheque held elsewhere')`);
const rows = [
  { key: '2026-09-01|09:00|9000.00|grantor', date: '2026-09-01', amount: 9000, method: 'Cheque', status: 'Succeeded', last: 'Grantor' },
  { key: '2026-10-11|21:00|5.00|ames', date: '2026-10-11', amount: 5, status: 'Succeeded', payout_date: '2026-10-18', recurring: 'Monthly', first: 'Test', last: 'Ames', email: 's@example.org' },
  { key: '2026-10-29|20:00|120.00|bell', date: '2026-10-29', amount: 120, status: 'Succeeded', fund: 'FRC 9255 Botmasters', first: 'Test', last: 'Bell' },
  { key: '2026-11-02|08:00|500.00|cole', date: '2026-11-02', amount: 500, status: 'Processing', fund: 'General Fund', first: 'Test', last: 'Cole' },
  { key: '2026-10-01|10:32|100.00|na', date: '2026-10-01', amount: 100, status: 'Succeeded', fund: 'No Such Team', first: 'Sim', last: 'Na' },
];
await fails(C, `select public.zeffy_upsert($1)`, [JSON.stringify(rows)], /Board sign-in/, 'team cannot import Zeffy');
let z = (await as(B1, `select public.zeffy_upsert($1) z`, [JSON.stringify(rows)])).rows[0].z;
ok(z.inserted === 4 && z.skipped === 1, 'Zeffy import skips a listed cheque ' + JSON.stringify(z));
const zd = Object.fromEntries((await db.query(`select zeffy_key, fund_id, unassigned from public.donations where zeffy_key is not null`)).rows.map((r) => [r.zeffy_key.split('|')[3], r]));
ok(zd.ames.unassigned && zd.ames.fund_id === 'F-GEN', 'blank fund goes to general, unassigned');
ok(zd.bell.fund_id === 'F-9255' && !zd.bell.unassigned, 'team fund matched by name');
ok(!zd.cole.unassigned && zd.na.unassigned, 'General Fund assigned; unknown fund unassigned');
rows[2].payout_date = '2026-11-05';
z = (await as({ role: 'service_role' }, `select public.zeffy_upsert($1, 'api') z`, [JSON.stringify(rows)])).rows[0].z;
ok(z.inserted === 0 && z.updated === 1, 'service role re-sync only refreshes ' + JSON.stringify(z));
ok((await db.query(`select count(*)::int n from public.ledger l join public.donations d on d.id = l.donation_id where d.zeffy_key is not null`)).rows[0].n === 4, 'each Zeffy gift has one ledger row');
const p2 = (await as(C, `select public.team_portal() p`)).rows[0].p;
ok(p2.gifts.some((g) => g.amount == 120 && g.in_transit), 'team sees its gift in transit');

// Month lock.
const bs = (await as(B1, `select public.bank_statement_add('2026-08-01') id`)).rows[0].id;
// The difference is worked out in the database: the page's own figure is not trusted.
const off = Number((await as(B1, `select public.bank_month_difference($1, 0) d`, [bs])).rows[0].d);
await fails(B1, `select public.lock_bank_month($1, $2, 0)`, [bs, 3.5 - off], /\$0\.00/, 'cannot lock with a difference, whatever the page sends');
await as(B1, `select public.lock_bank_month($1, $2, 0)`, [bs, -off]);
await fails(B1, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-08-15', dir: 'in', amount: 5, fund_id: 'F-GEN' })], /locked/, 'locked month refuses new rows');
await fails(B1, `update public.ledger set amount = amount + 1 where request_id = $1`, [reqP], /permission denied/, 'ledger takes no direct writes');
await fails(B1, `select public.ledger_edit((select id from public.ledger where request_id = $1 limit 1), '{"memo":"x"}')`, [reqP], /locked/, 'locked month refuses edits');
await as(B1, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-09-01', dir: 'in', amount: 5, fund_id: 'F-GEN', memo: 'correction' })]);
ok(true, 'open month accepts a correction');

// Outsider (signed in, not invited) sees nothing.
const X = board('00000000-0000-0000-0000-0000000000ff', 'x@example.org');
ok((await as(X, `select count(*)::int n from public.team_requests`)).rows[0].n === 0, 'outsider sees no requests');
await fails(X, `select public.team_portal()`, [], /Team sign-in/, 'outsider has no team portal');

// Clear sample data still runs (the locked month's sample rows stay, the lock holds).
await import('./test-money.mjs').then((m) => m.run({ db, as, fails, ok, B1, B2, B3, C, bs, reqP }));
await db.exec(`select set_config('gpric.via', 'unlock', false); update public.bank_statements set locked_at = null; select set_config('gpric.via', '', false);`);
const cl = (await as(B1, `select public.clear_sample_data() c`)).rows[0].c;
ok(cl.ledger > 0, 'clear sample data runs ' + JSON.stringify(cl));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
