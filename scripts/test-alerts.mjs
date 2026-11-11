// P32, email alerts: filing a team request or a direct expense queues one email_outbox row for the email_alerts
// recipients; filing never depends on it; only the Treasurer reads the outbox and only the server writes it.
// Runs on its own: node scripts/test-alerts.mjs   (exits 1 when a check fails). Sample people and amounts only.
import { openDb } from './pg-stub.mjs';

const db = await openDb();

const TREAS = '00000000-0000-0000-0000-0000000000b1';
const BOARD = '00000000-0000-0000-0000-0000000000b2';
const BOOKS = '00000000-0000-0000-0000-0000000000b3';
const CPA = '00000000-0000-0000-0000-0000000000d2';
const COACH = '00000000-0000-0000-0000-0000000000c1';

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
const count = async (sql, params = []) => Number((await q(sql, params))[0].n);

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'board@example.org', now()),
    ('${BOOKS}', 'books@example.org', now()), ('${CPA}', 'cpa@example.org', now()), ('${COACH}', 'coach@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  update public.portal_access set role = 'bookkeeper', name = 'Sample Bookkeeper' where user_id = '${BOOKS}';
  update public.portal_access set role = 'cpa', name = 'Sample CPA' where user_id = '${CPA}';
  update public.settings set general_fund_id = 'F-GEN';
  select set_config('gpric.via', 'admin', false);
  update public.team_requests set status = 'Closed' where team_id = 'T-9255' and status = 'Receipts Due';
  select set_config('gpric.via', '', false);
`);
const T = signed(TREAS, 'treasurer@example.org');
const B = signed(BOARD, 'board@example.org');
const K = signed(BOOKS, 'books@example.org');
const X = signed(CPA, 'cpa@example.org');
const C = signed(COACH, 'coach@example.org');
const SVC = { role: 'service_role' };
await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-01', dir: 'in', amount: 5000, fund_id: 'F-9255', source: 'Test Deposit' })]);

const preApproval = () => JSON.stringify({ type: 'Pre-Approval', purpose: 'Field elements', category: 'Robot Parts & Construction',
  amount: 812.4, pay_to: 'Vendor directly', needed_by: '2026-11-20', certified: true });
const reimbursement = () => JSON.stringify({ type: 'Reimbursement', vendor: 'Sample Robotics Supply', category: 'Robot Parts & Construction',
  amount: 42.5, purchase_date: '2026-10-30', zelle_contact: 'zelle-coach@example.org', receipt_path: 'team/T-9255/r.pdf', receipt_name: 'r.pdf', certified: true });
const direct = () => JSON.stringify({ purpose: 'Field build parts', charge_fund_id: 'F-GEN', pay_method: 'Check', pay_ref: '880451',
  paid_date: '2026-10-22', invoices: [{ vendor: 'Sample Hardware', amount: 10.25 }, { vendor: 'Sample Hardware', amount: 5 }] });
const outbox = async (rid) => (await q(`select * from public.email_outbox where request_id = $1`, [rid]));
const total = () => count(`select count(*) n from public.email_outbox`);

// ---------------------------------------------------------------- shape

ok((await q(`select column_default d, is_nullable n from information_schema.columns where table_name = 'portal_access' and column_name = 'email_alerts'`))
  .some((r) => r.d === 'false' && r.n === 'NO'), 'portal_access.email_alerts is not null, default false');
ok(await count(`select count(*) n from public.portal_access where email_alerts`) === 0, 'alerts are off for everyone by default');

// ---------------------------------------------------------------- nobody has alerts on: filing still works, nothing queued

const r0 = await one(C, `select public.submit_team_request($1)`, [preApproval()]);
ok(/^R-/.test(r0), 'a team files a request with alerts off for everyone');
const d0 = (await one(K, `select public.direct_expense_file($1)`, [direct()])).id;
ok(/^R-/.test(d0), 'the bookkeeper files a direct expense with alerts off for everyone');
ok(await total() === 0, 'nothing is queued when no one has alerts on');

// ---------------------------------------------------------------- Anna's alerts on

await db.exec(`update public.portal_access set email_alerts = true where user_id in ('${BOOKS}', '${TREAS}')`);
await db.exec(`update public.portal_access set email = 'Books@Example.org' where user_id = '${BOOKS}'`);
const TO = ['books@example.org', 'treasurer@example.org'];

const r1 = await one(C, `select public.submit_team_request($1)`, [preApproval()]);
let o = await outbox(r1);
ok(o.length === 1, 'a team request queues exactly one outbox row');
ok(JSON.stringify(o[0]?.to_emails) === JSON.stringify(TO), 'addressed to the email_alerts recipients, lowercased: ' + o[0]?.to_emails);
ok(o[0]?.kind === 'team_request' && o[0]?.status === 'queued' && o[0]?.attempts === 0 && o[0]?.link === '/requests', 'queued as a team request linking to /requests');
ok(/FRC 9255 Botmasters/.test(o[0]?.subject) && /\$812\.40/.test(o[0]?.subject), 'subject names the team and the amount: ' + o[0]?.subject);
ok(/Sample Coach/.test(o[0]?.body_text) && /Field elements/.test(o[0]?.body_text) && /\$812\.40/.test(o[0]?.body_text)
   && /FRC 9255 Botmasters/.test(o[0]?.body_text) && o[0]?.body_text.includes('#' + r1), 'body names the person, the team, the amount, what it is for and the request');

const r2 = await one(C, `select public.submit_team_request($1)`, [reimbursement()]);
o = await outbox(r2);
ok(o.length === 1 && /reimbursement request/.test(o[0].body_text), 'a reimbursement queues one row');
ok(!/zelle|@/i.test(o[0].subject + o[0].body_text), 'no Zelle contact or email address in the email');

const d1 = (await one(K, `select public.direct_expense_file($1)`, [direct()])).id;
o = await outbox(d1);
ok(o.length === 1 && o[0].kind === 'direct_expense', 'a direct expense queues exactly one row');
ok(/General Operating/.test(o[0].subject) && /\$15\.25/.test(o[0].subject), 'subject names the fund and the amount: ' + o[0].subject);
ok(/Sample Bookkeeper/.test(o[0].body_text) && /Field build parts/.test(o[0].body_text) && /Check/.test(o[0].body_text), 'body names the person, what it is for and how it was paid');
ok(!o[0].body_text.includes('880451') && !o[0].subject.includes('880451'), 'no check number in the email');

const rb = await one(T, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', purpose: 'Entered by the board', amount: 20, requestor_name: 'Sample Coach' })]);
ok((await outbox(rb)).length === 1, 'a request the board enters on a team\'s behalf queues one row');
ok(await total() === 4, 'four filings, four rows');

// Sample rows never alert.
await db.exec(`select set_config('gpric.via', 'admin', false);
  insert into public.team_requests (team_id, purpose, amount, status, sample) values ('T-9255', 'Sample row', 5, 'Submitted', true);
  select set_config('gpric.via', '', false);`);
ok(await total() === 4, 'a sample row queues nothing');

// ---------------------------------------------------------------- a failing trigger never stops filing

await db.exec(`alter table public.email_outbox add constraint test_break check (false) not valid`);
const r3 = await one(C, `select public.submit_team_request($1)`, [preApproval()]);
ok(/^R-/.test(r3) && (await q(`select 1 from public.team_requests where id = $1`, [r3])).length === 1, 'the request files when queueing the alert fails');
ok((await outbox(r3)).length === 0, 'and nothing half-queued');
const d3 = (await one(K, `select public.direct_expense_file($1)`, [direct()])).id;
ok(/^R-/.test(d3), 'a direct expense files when queueing the alert fails');
await db.exec(`alter table public.email_outbox drop constraint test_break`);

// ---------------------------------------------------------------- who reads, who writes

ok(Number(await one(T, `select count(*) from public.email_outbox`)) === 4, 'the Treasurer reads the outbox');
for (const [who, claims] of [['the bookkeeper', K], ['a board member', B], ['the CPA', X], ['a team login', C], ['the Treasurer without two-step', { ...T, aal: 'aal1' }]]) {
  ok(Number(await one(claims, `select count(*) from public.email_outbox`)) === 0, `${who} reads nothing in the outbox`);
}
await fails({ role: 'anon' }, `select count(*) from public.email_outbox`, [], /permission denied/, 'signed out: no access');
const id1 = (await outbox(r1))[0].id;
for (const [who, claims] of [['Treasurer', T], ['bookkeeper', K], ['team login', C], ['CPA', X], ['signed out', { role: 'anon' }]]) {
  await fails(claims, `insert into public.email_outbox (kind, subject, body_text, to_emails) values ('team_request', 's', 'b', '{x@example.org}')`, [],
    /permission denied|read only/, `${who} cannot insert into the outbox`);
  await fails(claims, `update public.email_outbox set status = 'sent' where id = $1`, [id1], /permission denied|read only/, `${who} cannot update the outbox`);
  await fails(claims, `delete from public.email_outbox where id = $1`, [id1], /permission denied|read only/, `${who} cannot delete from the outbox`);
  await fails(claims, `select * from public.email_outbox_claim(5)`, [], /permission denied/, `${who} cannot claim rows to send`);
  await fails(claims, `select public.email_outbox_done($1, null)`, [id1], /permission denied/, `${who} cannot mark a row sent`);
}
try { await db.query(`delete from public.email_outbox where id = $1`, [id1]); ok(false, 'delete refused even for the owner (no error)'); }
catch (e) { ok(/archived, never deleted/.test(e.message), 'delete refused even for the owner -> ' + e.message); }

// History: the outbox is never logged, so no History view shows it.
ok(await count(`select count(*) n from public.change_log where tbl = 'email_outbox'`) === 0, 'the outbox writes nothing to History');
ok(Number(await one(X, `select count(*) from public.change_log_cpa where tbl = 'email_outbox' or summary ilike '%outbox%'`)) === 0, 'nothing about the outbox in the CPA History');
ok(Number(await one(C, `select count(*) from public.change_log_team where tbl = 'email_outbox'`)) === 0, 'nothing about the outbox in team History');
ok(Number(await one(C, `select count(*) from public.change_log_team where tbl = 'portal_access'`)) === 0, 'alert settings are not in team History');

// ---------------------------------------------------------------- the server's send loop (service role)

// The open POST flush (p_counted false): its failures never use up a row's attempts.
const ids = (await q(`select id from public.email_outbox where status = 'queued' order by id`)).map((r) => r.id);
for (let i = 0; i < 8; i++) {
  const got = (await as(SVC, `select * from public.email_outbox_claim(50, false)`)).rows;
  for (const r of got) await as(SVC, `select public.email_outbox_done($1, 'Outage', false)`, [r.id]);
}
const rows = await q(`select * from public.email_outbox where id = any($1) order by id`, [ids]);
ok(rows.length === 4 && rows.every((r) => r.status === 'queued' && r.attempts === 0 && r.claimed_at === null && r.error === 'Outage'),
  'eight failed POST flushes during an outage leave every row queued with no attempt counted');

const claimed = (await as(SVC, `select * from public.email_outbox_claim(2)`)).rows;
ok(claimed.length === 2 && claimed.every((r) => r.claimed_at), 'the cron flush claims queued rows');
ok((await as(SVC, `select * from public.email_outbox_claim(10)`)).rows.length === 2, 'a second flush never takes rows already claimed');
await as(SVC, `select public.email_outbox_done($1, null)`, [claimed[0].id]);
let row = (await q(`select * from public.email_outbox where id = $1`, [claimed[0].id]))[0];
ok(row.status === 'sent' && row.sent_at && row.error === null && row.attempts === 1, 'a sent row is marked sent');
await as(SVC, `select public.email_outbox_done($1, $2)`, [claimed[1].id, 'Provider said no']);
row = (await q(`select * from public.email_outbox where id = $1`, [claimed[1].id]))[0];
ok(row.status === 'queued' && row.error === 'Provider said no' && row.claimed_at === null && row.attempts === 1,
  'a failed cron send stays queued for a retry, counted, with its error');
// release the other two rows the second cron flush took, as failures the POST would make
for (const r of (await q(`select id from public.email_outbox where claimed_at is not null`))) await as(SVC, `select public.email_outbox_done($1, 'Outage', false)`, [r.id]);
const postTakes = (await as(SVC, `select * from public.email_outbox_claim(50, false)`)).rows.map((r) => r.id);
ok(postTakes.length === 2 && !postTakes.includes(claimed[1].id), 'the POST flush never takes a row the cron has already tried');
for (const id of postTakes) await as(SVC, `select public.email_outbox_done($1, 'Outage', false)`, [id]);
for (let i = 0; i < 6; i++) {
  const c = (await as(SVC, `select * from public.email_outbox_claim(50)`)).rows;
  for (const r of c) if (r.id !== claimed[1].id) await as(SVC, `select public.email_outbox_done($1, null)`, [r.id]);
  if (!c.some((r) => r.id === claimed[1].id)) break;
  await as(SVC, `select public.email_outbox_done($1, 'Still no')`, [claimed[1].id]);
}
row = (await q(`select * from public.email_outbox where id = $1`, [claimed[1].id]))[0];
ok(row.status === 'failed' && row.attempts === 5, `cron retries stop at five attempts, then failed (${row.status}, ${row.attempts})`);
await as(SVC, `select public.email_outbox_done($1, null)`, [claimed[1].id]);
ok((await q(`select status from public.email_outbox where id = $1`, [claimed[1].id]))[0].status === 'failed', 'a failed row is not marked sent later');
await as(SVC, `select public.email_outbox_done($1, null)`, [claimed[0].id]);
ok((await q(`select attempts from public.email_outbox where id = $1`, [claimed[0].id]))[0].attempts === 1, 'marking a sent row again changes nothing');

// ---------------------------------------------------------------- a filer with no name: never their login email

const req = async (rid) => (await q(`select * from public.team_requests where id = $1`, [rid]))[0];
await db.exec(`update public.team_users set name = null where user_id = '${COACH}';
  update public.portal_access set name = null where user_id = '${BOOKS}';`);
const r4 = await one(C, `select public.submit_team_request($1)`, [preApproval()]);
ok((await req(r4)).requestor_name === 'coach@example.org', 'an unnamed team login files under its login email (the case to hide)');
o = await outbox(r4);
ok(o.length === 1 && o[0].body_text.startsWith('A team login filed') && !/@/.test(o[0].subject + o[0].body_text),
  'an unnamed team login shows as "A team login", no address: ' + o[0]?.body_text.split('\n')[0]);
const d4 = (await one(K, `select public.direct_expense_file($1)`, [direct()])).id;
ok(/@/.test((await req(d4)).requestor_name || ''), 'an unnamed board login files a direct expense under its login email (the case to hide)');
o = await outbox(d4);
ok(o.length === 1 && o[0].body_text.startsWith('A board member filed') && !/@/.test(o[0].subject + o[0].body_text),
  'an unnamed board login shows as "A board member", no address: ' + o[0]?.body_text.split('\n')[0]);
const r5 = await one(C, `select public.submit_team_request($1)`, [JSON.stringify({ ...JSON.parse(preApproval()), purpose: 'Order via parts@example.org' })]);
o = await outbox(r5);
ok(o.length === 1 && !/@/.test(o[0].subject + o[0].body_text) && /\[email hidden\]/.test(o[0].body_text), 'an address typed into what it is for is masked');
const r6 = await one(C, `select public.submit_team_request($1)`, [JSON.stringify({ ...JSON.parse(preApproval()), purpose: 'x'.repeat(70) + ' joe@example.org and pat@gmail' })]);
o = await outbox(r6);
ok(o.length === 1 && !/@|examp/.test(o[0].subject + o[0].body_text), 'an address straddling the 80-character subject cut, and one with no dot, leave no fragment: ' + o[0]?.subject);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
