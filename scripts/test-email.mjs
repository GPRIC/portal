// P34 change a login email (0021): the Treasurer asks, the new address confirms, the seat follows; a self change
// (Supabase's own) makes the seat follow too. Sample people only. Runs on its own: node scripts/test-email.mjs
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
const TREAS = id('d1'), BOARD = id('d2'), COACH = id('d3');
const who = (sub, email) => ({ sub, email, aal: 'aal2', role: 'authenticated' });

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into auth.users (id, email, invited_at) values ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'board@example.org', now()),
    ('${COACH}', 'coach@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  insert into public.board_members (name, title, email) values ('Sample Director', 'Director', 'board@example.org');
`);
const T = who(TREAS, 'treasurer@example.org'), B = who(BOARD, 'board@example.org');
const svc = { role: 'service_role' };

await fails(B, `select public.people_email_change_request('board@example.org', 'new@example.org')`, [], /not allowed for your role/, 'a board member cannot change someone else\'s email');
await fails(T, `select public.people_email_change_request('board@example.org', 'first@example.org')`, [], /changes its own email/, 'a board seat is never moved by the Treasurer');
// the rest runs on a seat that cannot approve or pay (the CPA)
await db.exec(`update public.portal_access set role = 'cpa' where user_id = '${BOARD}'`);
await fails(T, `select public.people_email_change_request('board@example.org', 'coach@example.org')`, [], /Another login/, 'an address another login uses is refused');
await fails(T, `select public.people_email_change_request('nobody@example.org', 'x@example.org')`, [], /not signed up/, 'someone with no login is refused');
await as(T, `select public.people_email_change_request('board@example.org', 'first@example.org')`);
await as(T, `select public.people_email_change_request('board@example.org', 'Director.New@example.org')`);
ok((await q(`select email from auth.users where id = $1`, [BOARD]))[0].email === 'board@example.org', 'nothing changes before the new address confirms');
const obAll = await q(`select to_emails, link from public.email_outbox where kind = 'email_change' order by id`);
const ob = obAll.filter((r) => r.link !== '/login');
ok(obAll.filter((r) => r.link === '/login' && r.to_emails[0] === 'board@example.org').length === 2, 'the old address is told each time');
ok(ob.length === 2 && ob[1].to_emails[0] === 'director.new@example.org' && /^\/confirm-email\?token=[0-9a-f]{64}$/.test(ob[1].link), 'the confirmation link is emailed to the new address');
const list = await one(T, `select public.people_email_changes()`);
ok(list.length === 1 && list[0].new_email === 'director.new@example.org' && !JSON.stringify(list).includes(ob[1].link.split('=')[1]), 'People lists the waiting change, without its link');
await fails(T, `select public.email_change_take($1)`, [ob[1].link.split('=')[1]], /permission denied/, 'only the server can take the link');
await fails(svc, `select public.email_change_take($1)`, [ob[0].link.split('=')[1]], /not valid/, 'the replaced link no longer works');
const took = await one(svc, `select public.email_change_take($1)`, [ob[1].link.split('=')[1]]);
ok(took.user_id === BOARD && took.new_email === 'director.new@example.org', 'the server takes the link once');
await fails(svc, `select public.email_change_take($1)`, [ob[1].link.split('=')[1]], /already used/, 'a used link cannot be used again');

// the server then changes the login (as the auth admin would); the seat and member record follow
await db.exec(`update auth.users set email = 'director.new@example.org' where id = '${BOARD}'`);
ok((await q(`select email, role from public.portal_access where user_id = $1`, [BOARD]))[0].email === 'director.new@example.org', 'the seat takes the new email, role kept');
ok((await q(`select email from public.board_members where name = 'Sample Director'`))[0].email === 'director.new@example.org', 'the board member record follows');
const B2 = who(BOARD, 'director.new@example.org');
ok((await one(B2, `select public.my_role()`)) === 'cpa' && (await one(B2, `select public.my_member_id()`)) != null, 'they sign in with the new email, same seat and member record');
ok((await q(`select count(*)::int n from public.change_log where tbl = 'portal_access' and action <> 'Added' and record_id is not null and before::text like '%board@example.org%'`))[0].n >= 1, 'History shows the change');
// a self change (Supabase's own flow) of a team login
await db.exec(`update auth.users set email = 'coach2@example.org' where id = '${COACH}'`);
ok((await q(`select email from public.team_users where user_id = $1`, [COACH]))[0].email === 'coach2@example.org', 'a team login\'s email follows a self change');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
