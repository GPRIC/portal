// P26 money rules (0019): a first payment to a new Zelle needs two approvals; a reimbursement waits for its receipt
// unless a board member who did not file it overrides, with a reason. Plus the 0018 asset flag on a reversed entry.
// Sample people and amounts only. Runs on its own: node scripts/test-rules.mjs   (exits 1 when a check fails)
import { openDb } from './pg-stub.mjs';

const db = await openDb();
const TREAS = '00000000-0000-0000-0000-0000000000b1';
const BOARD = '00000000-0000-0000-0000-0000000000b2';
const BOOKS = '00000000-0000-0000-0000-0000000000b3';
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
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'board@example.org', now()),
    ('${BOOKS}', 'books@example.org', now()), ('${COACH}', 'coach@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  update public.portal_access set role = 'bookkeeper', name = 'Sample Bookkeeper' where user_id = '${BOOKS}';
  insert into public.board_members (name, title, email) values ('Sample Director', 'Director', 'board@example.org');
  update public.settings set general_fund_id = 'F-GEN', receipt_days = 100000, approval_threshold = 500, approvals_under = 1, approvals_over = 1;
`);
const T = signed(TREAS, 'treasurer@example.org');
const B = signed(BOARD, 'board@example.org');
const K = signed(BOOKS, 'books@example.org');
const C = signed(COACH, 'coach@example.org');
const req = async (id) => (await q(`select * from public.team_requests where id = $1`, [id]))[0];
const fund = (await q(`select fund_id from public.teams where id = 'T-9255'`))[0].fund_id;
await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-01', dir: 'in', amount: 1000, fund_id: fund, source: 'Fundraising' })]);
const reimb = (zelle) => JSON.stringify({ type: 'Reimbursement', category: 'Robot Parts & Construction', purchase_date: '2026-10-20', zelle_contact: zelle, certified: true,
  receipts: [{ vendor: 'Shop', amount: 20, date: '2026-10-20', file_name: 's.pdf', file_path: 'team/T-9255/s.pdf' }] });

// ---------------------------------------------------------------- a request approved under the old rule, to a new Zelle
const old = await one(C, `select public.submit_team_request($1)`, [reimb('New.Payee@example.org')]);
// as it stood before 0019: one approval made it Approved
await db.exec(`select set_config('gpric.via', 'approve', false);
  insert into public.request_approvals (request_id, user_id, approver_name) values ('${old}', '${TREAS}', 'Sample Treasurer');
  update public.team_requests set status = 'Approved' where id = '${old}';
  select set_config('gpric.via', '', false);`);
ok((await q(`select public.request_approvals_needed($1) n`, [old]))[0].n === 2, 'a new Zelle needs two approvals');
await fails(K, `select public.mark_request_paid($1, '2026-10-25', 'Zelle', 'Z1')`, [old], /first payment to this Zelle/, 'paying a new Zelle on one approval is refused');
await fails(T, `select public.approve_request($1)`, [old], /already approved/, 'the same person cannot give the second approval');
const a = await one(B, `select public.approve_request($1)`, [old]);
ok(a.approvals === 2 && (await req(old)).status === 'Approved', 'a second board member approves the already-approved request');
await fails(B, `select public.approve_request($1)`, [old], /not waiting for approval/, 'no third approval once two are in');
await as(K, `select public.mark_request_paid($1, '2026-10-25', 'Zelle', 'Z1')`, [old]);
ok((await req(old)).status === 'Paid', 'then it is paid by Zelle');
// the same contact, written differently, is no longer new
const again = await one(C, `select public.submit_team_request($1)`, [reimb(' new.payee@EXAMPLE.org ')]);
ok((await q(`select public.request_approvals_needed($1) n`, [again]))[0].n === 1, 'a Zelle paid before needs only the amount rule');

// ---------------------------------------------------------------- the receipt override and who may give it
const typed = await one(B, `select public.request_save($1)`, [JSON.stringify({ team_id: 'T-9255', type: 'Reimbursement', purpose: 'Typed in', amount: 9, vendor: 'Shop',
  zelle_contact: 'New.Payee@example.org', requestor_name: 'Sample Director', requestor_email: 'someone@example.org' })]);
await db.exec(`update public.team_requests set requestor_member_id = (select id from public.board_members where email = 'board@example.org') where id = '${typed}'`);
await fails(B, `select public.request_receipt_override($1, 'Travelling')`, [typed], /another board member has to override/, 'the board member a request is filed for cannot override its receipt rule');
await fails(C, `select public.request_receipt_override($1, 'Travelling')`, [typed], /not allowed for your role/, 'a team login cannot override');
await as(T, `select public.approve_request($1)`, [typed]);
await fails(K, `select public.mark_request_paid($1, '2026-10-26', 'Zelle', 'Z2')`, [typed], /paid once its receipt is attached/, 'no receipt, no payment');
await as(T, `select public.request_receipt_override($1, 'Travelling')`, [typed]);
await as(K, `select public.mark_request_paid($1, '2026-10-26', 'Zelle', 'Z2')`, [typed]);
ok((await req(typed)).status === 'Paid', 'paid after the Treasurer overrides');

// ---------------------------------------------------------------- the asset flag on a reversed entry
const buy = await one(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-10', dir: 'out', amount: 60, fund_id: 'F-GEN', category: 'Equipment', party: 'Sample Tools', receipt: true })]);
await as(T, `select public.ledger_reverse($1, 'Entered twice')`, [buy]);
await fails(K, `select public.ledger_set_asset($1, true)`, [buy], /reversed|Only a purchase/i, 'a reversed purchase cannot be marked as an asset');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
