// P33 self sign-up (0020): a person asks for access, has none until a board member approves, and the Zelle on an
// approved team login is the locked payee record. Sample people only. Runs on its own: node scripts/test-access.mjs
import { openDb } from './pg-stub.mjs';

const db = await openDb();
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
const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const id = (n) => `00000000-0000-0000-0000-0000000000${n}`;
const TREAS = id('a1'), BOARD = id('a2'), BOOKS = id('a3'), NEWT = id('a4'), NEWB = id('a5'), NEWX = id('a6'), NEWD = id('a7');
const who = (sub, email, aal = 'aal2') => ({ sub, email, aal, role: 'authenticated' });

await db.exec(`
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'board@example.org', now()), ('${BOOKS}', 'books@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  update public.portal_access set role = 'bookkeeper', name = 'Sample Bookkeeper' where user_id = '${BOOKS}';
  update public.settings set receipt_days = 100000;
  -- self sign-ups: created by the server with no invite, so no seat
  insert into auth.users (id, email) values ('${NEWT}', 'parent@example.org'), ('${NEWB}', 'staff@example.org'),
    ('${NEWX}', 'other@example.org'), ('${NEWD}', 'decline@example.org');
`);
const T = who(TREAS, 'treasurer@example.org'), B = who(BOARD, 'board@example.org'), K = who(BOOKS, 'books@example.org');
const NT = who(NEWT, 'parent@example.org', 'aal1'), NB = who(NEWB, 'staff@example.org', 'aal1');
const NX = who(NEWX, 'other@example.org', 'aal1'), ND = who(NEWD, 'decline@example.org', 'aal1');
const anon = { role: 'anon' };

ok((await q(`select count(*)::int n from public.portal_access where user_id in ($1,$2)`, [NEWT, NEWB]))[0].n === 0, 'a self sign-up gets no seat');

// ---------------------------------------------------------------- invite
const tok = await one(B, `select public.access_invite_send('parent@example.org', 'Sample Parent', 'T-9255', 'team')`);
ok(typeof tok === 'string' && tok.length === 32, 'a board member sends an invite and gets its link token');
const look = await one(anon, `select public.access_invite_lookup($1)`, [tok]);
ok(look.invited_by === 'Sample Director' && look.team_id === 'T-9255', 'the invite link shows who sent it and the team, before sign-in');
ok((await one(anon, `select public.access_invite_lookup('nope')`)) === null, 'a wrong token shows nothing');
ok((await one(anon, `select jsonb_array_length(public.access_team_choices())`)) > 0, 'the sign-up page lists teams');
await fails(K, `select public.access_invite_send('x@example.org')`, [], /not allowed for your role/, 'the bookkeeper cannot send an invite');
await fails(anon, `select public.access_request_submit('{}')`, [], /permission denied/, 'signed-out callers cannot ask');
let ob = await q(`select kind, to_emails, link from public.email_outbox where kind = 'access_invite'`);
ok(ob.length === 1 && ob[0].to_emails[0] === 'parent@example.org' && ob[0].link === '/request-access?invite=' + tok, 'the invite email is queued with its link');

// ---------------------------------------------------------------- ask
await fails(NT, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'team', name: 'Sample Parent', team_id: 'T-9255' })], /Zelle/, 'a team member must give a Zelle');
const r1 = await one(NT, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'team', name: 'Sample Parent', phone: '555-0100', zelle: 'parent@example.org', team_id: 'T-9255', invite: tok })]);
await fails(NT, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'team', name: 'Again', zelle: 'z', team_id: 'T-9255' })], /already waiting/, 'one open request at a time');
ok((await one(NT, `select public.access_request_mine()`)).status === 'Pending', 'the person sees their request as pending');
ob = await q(`select to_emails from public.email_outbox where kind = 'access_request'`);
ok(ob.length === 1 && ob[0].to_emails.includes('treasurer@example.org') && ob[0].to_emails.includes('board@example.org') && !ob[0].to_emails.includes('books@example.org'),
  'the Treasurer and board are emailed, not the bookkeeper');
ok((await as(NT, `select count(*)::int n from public.team_requests`)).rows[0].n === 0 && (await as(NT, `select count(*)::int n from public.ledger`)).rows[0].n === 0, 'a pending person reads nothing');
const r2 = await one(NB, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'board', name: 'Sample Staff' })]);
const r3 = await one(NX, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'board', name: 'Sample Other' })]);
const r4 = await one(ND, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'team', name: 'Sample Decline', zelle: '555-0199', team_other: 'New School Team' })]);
await fails(T, `select public.access_request_submit($1)`, [JSON.stringify({ kind: 'board', name: 'Me' })], /already has portal access/, 'a login with a seat cannot ask');

// ---------------------------------------------------------------- review
await fails(K, `select public.access_requests_list()`, [], /not allowed for your role/, 'the bookkeeper cannot see requests');
const list = await one(B, `select public.access_requests_list()`);
ok(list.length === 4 && list.find((x) => x.id == r1).invited_by === 'Sample Director' && list.find((x) => x.id == r4).team_asked_name === 'New School Team',
  'the board sees each request with who invited them and the team asked');
await fails(B, `select public.access_request_approve($1, 'cpa')`, [r3], /Only the Treasurer/, 'a board member cannot give a CPA seat');
await fails(B, `select public.access_request_approve($1, 'team')`, [r1], /Pick the team/, 'a team login needs its team');
await as(B, `select public.access_request_approve($1, 'team', 'T-9255', null)`, [r1]);
const tu = (await q(`select * from public.team_users where user_id = $1`, [NEWT]))[0];
ok(tu && tu.team_id === 'T-9255' && tu.role === 'Coach' && tu.zelle_contact === 'parent@example.org' && tu.name === 'Sample Parent', 'approving makes the team login with its Zelle');
await fails(B, `select public.access_request_approve($1, 'team', 'T-9255', null)`, [r1], /already been decided/, 'a decided request cannot be approved again');
await as(B, `select public.access_request_approve($1, 'board')`, [r2]);
ok((await q(`select role from public.portal_access where user_id = $1`, [NEWB]))[0]?.role === 'board', 'a board member approves a board seat');
await as(T, `select public.access_request_approve($1, 'cpa')`, [r3]);
ok((await q(`select role from public.portal_access where user_id = $1`, [NEWX]))[0]?.role === 'cpa', 'the Treasurer approves a CPA seat');
await fails(B, `select public.access_request_decline($1, ' ')`, [r4], /reason/, 'declining needs a reason');
await as(B, `select public.access_request_decline($1, 'Not a GPRIC team')`, [r4]);
const mine = await one(ND, `select public.access_request_mine()`);
ok(mine.status === 'Declined' && mine.decline_reason === 'Not a GPRIC team', 'the declined person sees why');
ok((await q(`select count(*)::int n from public.portal_access p where p.user_id = $1 union all select count(*)::int from public.team_users where user_id = $1`, [NEWD])).every((x) => x.n === 0), 'declined gets no access');
ob = await q(`select to_emails from public.email_outbox where kind = 'access_answer' order by id`);
ok(ob.length === 4 && ob[3].to_emails[0] === 'decline@example.org', 'each answer is emailed to the person');
const hist = await q(`select count(*)::int n from public.change_log where tbl in ('access_requests','access_invites')`);
ok(hist[0].n >= 9, 'every step is in History');
ok((await q(`select count(*)::int n from public.change_log where tbl = 'access_requests' and team_id is not null`))[0].n === 0, 'requests never reach a team History');

// ---------------------------------------------------------------- the payee Zelle is locked
const NTa = who(NEWT, 'parent@example.org');
await fails(NTa, `select public.update_my_profile('Sample Parent', 'changed@example.org')`, [], /locked/, 'the team member cannot change their Zelle');
await as(NTa, `select public.update_my_profile('Sample P. Parent', 'parent@example.org')`);
ok((await q(`select name from public.team_users where user_id = $1`, [NEWT]))[0].name === 'Sample P. Parent', 'they can still change their name');
const rq = await one(NTa, `select public.submit_team_request($1)`, [JSON.stringify({ type: 'Reimbursement', category: 'Robot Parts & Construction', purchase_date: '2026-10-20',
  zelle_contact: 'someone.else@example.org', certified: true, receipts: [{ vendor: 'Shop', amount: 20, date: '2026-10-20', file_name: 's.pdf', file_path: 'team/T-9255/s.pdf' }] })]);
ok((await q(`select zelle_contact from public.team_requests where id = $1`, [rq]))[0].zelle_contact === 'parent@example.org', 'a request they file is paid to the Zelle on record');
await fails(NTa, `select public.team_user_set_zelle($1, 'x@example.org', 'r')`, [NEWT], /not allowed for your role|two-step/, 'a team login cannot use the board Zelle change');
await fails(B, `select public.team_user_set_zelle($1, 'new@example.org', '')`, [NEWT], /reason/, 'the board Zelle change needs a reason');
await as(B, `select public.team_user_set_zelle($1, 'new@example.org', 'New bank')`, [NEWT]);
ok((await q(`select zelle_contact from public.team_users where user_id = $1`, [NEWT]))[0].zelle_contact === 'new@example.org', 'a board member changes it');
ok((await q(`select reason from public.change_log where tbl = 'team_users' and action <> 'Added' order by id desc limit 1`))[0]?.reason === 'New bank', 'with the reason in History');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
