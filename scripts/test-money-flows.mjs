// P38, every money flow end to end: one scenario run acting as the real roles (Treasurer, board members, the bookkeeper
// Anna, an officer who files direct expenses, the CPA with two-step, and team logins). After each flow the totals the
// database reports (fund_balance, portal_totals, team_portal, bank_month_figures) are checked against sums worked out
// here from the raw ledger and request rows. A flow that is genuinely broken is recorded as a DEFECT (steps, expected,
// actual); it is never fixed here.
// Runs on its own: node scripts/test-money-flows.mjs   (prints PASS/FAIL per check, exits 1 when any check fails)
// Sample people and amounts only.
import { openDb } from './pg-stub.mjs';

const db = await openDb();

const TREAS = '00000000-0000-0000-0000-0000000000e1';
const BOARD = '00000000-0000-0000-0000-0000000000e2';
const BOARD2 = '00000000-0000-0000-0000-0000000000e3';
const ANNA = '00000000-0000-0000-0000-0000000000e4';
const OFFICER = '00000000-0000-0000-0000-0000000000e5';
const CPA = '00000000-0000-0000-0000-0000000000e6';
const COACH = '00000000-0000-0000-0000-0000000000e7';
const OTHER = '00000000-0000-0000-0000-0000000000e8';

let passed = 0;
let failed = 0;
const defects = [];
const ok = (cond, label, reason = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${reason ? ' — ' + String(reason).replace(/\s+/g, ' ').slice(0, 220) : ''}`);
  if (cond) passed++; else failed++;
  return cond;
};
/** A check that, when it fails, is a broken money flow: recorded with its steps, expected and actual result. */
const defect = (cond, label, d) => {
  if (!ok(cond, label, cond ? d.passReason || '' : 'DEFECT: ' + d.actual)) defects.push({ label, ...d });
};
const section = (t) => console.log(`\n---- ${t}`);

async function as(claims, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role ${claims.role ?? 'authenticated'}`);
    return tx.query(sql, params);
  });
}
async function fails(claims, sql, params, match, label) {
  try { await as(claims, sql, params); return ok(false, label, 'no error: the action went through'); }
  catch (e) { return ok(match.test(e.message), label, 'refused: ' + e.message); }
}
async function ownerFails(sql, match, label) {
  try { await db.exec(sql); return ok(false, label, 'no error: the owner write went through'); }
  catch (e) { return ok(match.test(e.message), label, 'refused: ' + e.message); }
}
const signed = (sub, email, aal = 'aal2') => ({ sub, email, aal, role: 'authenticated' });
const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const c = (x) => Math.round(Number(x || 0) * 100);           // cents, so sums are exact
const $ = (cents) => (cents / 100).toFixed(2);

// ---------------------------------------------------------------- people (sample)

await db.exec(`
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'director@example.org', now()),
    ('${BOARD2}', 'director2@example.org', now()), ('${ANNA}', 'anna@example.org', now()),
    ('${OFFICER}', 'officer@example.org', now()), ('${CPA}', 'cpa@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  update public.portal_access set role = 'board', name = 'Sample Director Two' where user_id = '${BOARD2}';
  update public.portal_access set role = 'bookkeeper', name = 'Anna (sample bookkeeper)' where user_id = '${ANNA}';
  update public.portal_access set role = 'board', name = 'Sample Officer', files_direct = true where user_id = '${OFFICER}';
  update public.portal_access set role = 'cpa', name = 'Sample CPA' where user_id = '${CPA}';
  update public.settings set general_fund_id = 'F-GEN', receipt_days = 100000, approval_threshold = 500, approvals_under = 1, approvals_over = 2;
`);
const T = signed(TREAS, 'treasurer@example.org');
const B = signed(BOARD, 'director@example.org');
const B2 = signed(BOARD2, 'director2@example.org');
const K = signed(ANNA, 'anna@example.org');
const O = signed(OFFICER, 'officer@example.org');
const CP = signed(CPA, 'cpa@example.org');
const CP1 = signed(CPA, 'cpa@example.org', 'aal1');

// A team of our own (its own restricted fund), so its balance moves only with this script.
const TEAM = await one(T, `select public.team_save($1)`, [JSON.stringify({ name: 'Flow Test Team', short: 'FT' })]);
const TFUND = (await q(`select fund_id from public.teams where id = $1`, [TEAM]))[0].fund_id;
await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('${TEAM}', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'other@example.org', 'Sample Other Coach', 'Treasurer');
  insert into auth.users (id, email, invited_at) values ('${COACH}', 'coach@example.org', now()), ('${OTHER}', 'other@example.org', now());
`);
const C = signed(COACH, 'coach@example.org');
const C2 = signed(OTHER, 'other@example.org');
const LOG_START = Number((await q(`select coalesce(max(id), 0) m from public.change_log`))[0].m);

// ---------------------------------------------------------------- helpers

const bal = async (f) => c(await one(T, `select public.fund_balance($1)`, [f]));
const committed = async (f) => c(await one(T, `select public.fund_committed($1)`, [f]));
const req = async (id) => (await q(`select * from public.team_requests where id = $1`, [id]))[0];
const outRows = async (id) => q(`select * from public.ledger where request_id = $1 and dir = 'out' and reverses_id is null and reversed_by_id is null`, [id]);
const logRow = async (tbl, rec, action) =>
  (await q(`select * from public.change_log where tbl = $1 and record_id = $2 and action = $3 order by id desc limit 1`, [tbl, rec, action]))[0];

// History's area for each table, as the portal shows it (0011's log_area), written out here so the check is independent.
const AREA = {
  ledger: 'Ledger', money_overrides: 'Ledger', team_requests: 'Requests', receipts: 'Requests', request_approvals: 'Requests',
  request_refunds: 'Requests', receipt_reminders: 'Requests', donations: 'Donations', donors: 'Donations', grants: 'Grants',
  teams: 'Teams', funds: 'Teams', team_users: 'Teams', team_invites: 'Teams', bank_statements: 'Bank', bank_lines: 'Bank',
  sessions: 'Sign-ins', accounts: 'Accounts', documents: 'Documents', meetings: 'Meetings', meeting_votes: 'Meetings',
  calendar_events: 'Calendar', problem_reports: 'Problems', portal_access: 'Settings', settings: 'Settings',
};
const LABEL = {
  ledger: /^Ledger · /, money_overrides: /^Override · /, team_requests: /^(Request|Direct expense) · /, receipts: /^Receipt · /,
  request_approvals: /^Approval · request R-/, request_refunds: /^Refund · .*request R-/, receipt_reminders: /^Receipt reminder · request R-/,
  teams: /^Team · /, funds: /^Fund · /, team_users: /^Team login · /, team_invites: /^Invite · /, bank_statements: /^Month · /,
  bank_lines: /^Bank line · /, documents: /^Document · /, portal_access: /^Board access · /, settings: /^Settings$/,
};
async function logged(tbl, rec, action, labelRe, label) {
  const e = await logRow(tbl, rec, action);
  ok(!!e && e.what === AREA[tbl] && labelRe.test(e.label || ''), label,
    e ? `${e.action} · area ${e.what} · "${e.label}" · by ${e.who}` : `no ${action} row for ${tbl} ${rec}`);
  return e;
}

/** Every fund's balance, committed and available, the cash totals, the team's own figure and the month's book balance,
 *  each checked against sums worked out here from the raw rows. */
async function books(tag) {
  const led = await q(`select fund_id, dir, amount, date::text d from public.ledger`);
  const raw = {};
  let cash = 0;
  for (const r of led) { const v = (r.dir === 'in' ? 1 : -1) * c(r.amount); raw[r.fund_id] = (raw[r.fund_id] || 0) + v; cash += v; }
  const reqs = await q(`select r.type, r.status, r.amount, r.archived_at, coalesce(r.charge_fund_id, t.fund_id) fund
                          from public.team_requests r left join public.teams t on t.id = r.team_id`);
  const com = {};
  for (const r of reqs) {
    if (r.archived_at || !r.fund) continue;
    if (r.status === 'Approved' || (r.type === 'Direct Expense' && r.status === 'Submitted')) com[r.fund] = (com[r.fund] || 0) + c(r.amount);
  }
  const restricted = new Set((await q(`select id from public.funds where restricted`)).map((f) => f.id));
  const tot = await one(T, `select public.portal_totals()`);
  const bad = [];
  for (const f of tot.funds) {
    const b = raw[f.id] || 0, k = com[f.id] || 0;
    if (c(f.balance) !== b) bad.push(`${f.id} balance ${f.balance} vs ${$(b)}`);
    if (c(f.committed) !== k) bad.push(`${f.id} committed ${f.committed} vs ${$(k)}`);
    if (c(f.available) !== b - k) bad.push(`${f.id} available ${f.available} vs ${$(b - k)}`);
  }
  for (const f of Object.keys(raw)) {
    if (!tot.funds.some((x) => x.id === f)) bad.push(`${f} holds money but is missing from portal_totals`);
    const fb = await bal(f);
    if (fb !== raw[f]) bad.push(`fund_balance(${f}) ${$(fb)} vs ${$(raw[f])}`);
  }
  const rs = Object.entries(raw).filter(([f]) => restricted.has(f)).reduce((s, [, v]) => s + v, 0);
  if (c(tot.cash.total) !== cash) bad.push(`cash total ${tot.cash.total} vs ${$(cash)}`);
  if (c(tot.cash.restricted) !== rs) bad.push(`restricted cash ${tot.cash.restricted} vs ${$(rs)}`);
  if (c(tot.cash.unrestricted) !== cash - rs) bad.push(`unrestricted cash ${tot.cash.unrestricted} vs ${$(cash - rs)}`);
  const portal = await one(C, `select public.team_portal()`);
  if (c(portal.money.balance) !== (raw[TFUND] || 0)) bad.push(`team portal balance ${portal.money.balance} vs ${$(raw[TFUND] || 0)}`);
  const end = '2026-11-30';
  const book = led.filter((r) => r.d <= end).reduce((s, r) => s + (r.dir === 'in' ? 1 : -1) * c(r.amount), 0);
  const fig = await one(T, `select public.bank_month_figures('2026-11-01')`);
  if (c(fig.book) !== book) bad.push(`November book balance ${fig.book} vs ${$(book)}`);
  if (c(fig.expected) !== c(fig.book) + c(fig.outstanding) - c(fig.transit)) bad.push('month figures do not add up');
  ok(bad.length === 0, `books agree after ${tag}`, bad.length ? bad.join('; ') : `${tot.funds.length} funds, cash $${$(cash)}, ${$(raw[TFUND] || 0)} in ${TFUND}`);
}

const pre = (extra = {}) => JSON.stringify({ type: 'Pre-Approval', purpose: 'Field elements', category: 'Robot Parts & Construction',
  pay_to: 'Vendor directly', vendor: 'Sample Vendor', certified: true, ...extra });
const rc = (vendor, amount, file = `team/${TEAM}/${vendor.toLowerCase().replace(/\W/g, '')}.pdf`) =>
  ({ vendor, amount, date: '2026-10-20', file_name: vendor + '.pdf', file_path: file });

// Opening money for the team fund.
const dep = await one(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-01', dir: 'in', amount: 1000, fund_id: TFUND, source: 'Test Deposit' })]);
ok(/^L-/.test(dep) && (await bal(TFUND)) === 100000, 'the Treasurer deposits $1,000 into the new team fund', `${dep}, ${TFUND}`);
await logged('teams', TEAM, 'Added', /^Team · Flow Test Team$/, 'new team is logged under Teams');
await logged('funds', TFUND, 'Added', /^Fund · FT Team Fund$/, 'its fund is logged under Teams');
await books('setup');

// ================================================================ 1. team request: approve, pay, close; decline; overspend
section('1. Team request: approve, pay, close');
{
  const b0 = await bal(TFUND), k0 = await committed(TFUND);
  const r = await one(C, `select public.submit_team_request($1)`, [pre({ amount: 300 })]);
  ok(/^R-/.test(r) && (await req(r)).status === 'Submitted', 'coach submits a $300 pre-approval', r);
  const sub = await logged('team_requests', r, 'Added', /^Request · \$300\.00 .*· FT$/, 'submission logged as Added under Requests');
  ok(sub?.role === 'team' && sub?.team_id === TEAM, 'submission logged as the team', `${sub?.role} ${sub?.team_id}`);
  ok((await committed(TFUND)) === k0, 'a submitted request is not committed yet', $(await committed(TFUND)));
  await fails(C, `select public.approve_request($1)`, [r], /Board sign-in/, 'the coach cannot approve');
  await fails(K, `select public.mark_request_paid($1, '2026-10-10', 'Check', '5001')`, [r], /Only an approved request/, 'an unapproved request cannot be paid');
  const ap = await one(B, `select public.approve_request($1)`, [r]);
  ok(ap.status === 'Approved' && ap.needed === 1 && ap.warnings.length === 0, 'one board approval approves $300 (threshold $500), no warnings', JSON.stringify(ap));
  await logged('team_requests', r, 'Approved', /^Request · /, 'approval logged as Approved');
  await logged('request_approvals', (await q(`select id::text from public.request_approvals where request_id = $1`, [r]))[0].id, 'Approved', /^Approval · request R-/, 'approval row logged under Requests');
  ok((await committed(TFUND)) === k0 + 30000 && (await bal(TFUND)) === b0, 'approved: $300 committed, balance unchanged', `committed ${$(await committed(TFUND))}`);
  await fails(B, `select public.mark_request_paid($1, '2026-10-10', 'Check', '5001')`, [r], /not allowed for your role/, 'a board member does not pay');
  await fails(K, `select public.mark_request_paid($1, '2026-10-10', 'Cash', '1')`, [r], /Pick how/, 'payment method must be a known one');
  const led = await one(K, `select public.mark_request_paid($1, '2026-10-10', 'Check', '5001')`, [r]);
  const lr = (await q(`select * from public.ledger where id = $1`, [led]))[0];
  ok((await req(r)).status === 'Receipts Due' && lr.fund_id === TFUND && c(lr.amount) === 30000 && lr.category === 'Robotics Teams' && lr.pay_ref === '5001',
    'Anna pays it: Receipts Due, one $300 Robotics Teams row from the team fund', led);
  ok((await bal(TFUND)) === b0 - 30000 && (await committed(TFUND)) === k0, 'paid: balance down $300, no longer committed', $(await bal(TFUND)));
  await logged('team_requests', r, 'Paid', /^Request · /, 'payment logged as Paid under Requests');
  await logged('ledger', led, 'Paid', /^Ledger · \$300\.00 .*FT Team Fund$/, 'payment ledger row logged as Paid under Ledger');
  await fails(K, `select public.mark_request_paid($1, '2026-10-10', 'Check', '5002')`, [r], /Only an approved request/, 'cannot pay twice');
  await fails(K, `select public.ledger_reverse($1, 'oops')`, [led], /Undo it from the request/, 'the payment row is not reversed by hand');
  const rcpt = await one(C, `select public.add_team_receipt($1, 'Sample Vendor', 250, '2026-10-12', 'v.pdf', $2)`, [r, `team/${TEAM}/v.pdf`]);
  await logged('receipts', rcpt, 'Added', /^Receipt · \$250\.00 Sample Vendor · FT$/, 'coach receipt logged under Requests');
  await fails(C, `select public.complete_request_receipts($1)`, [r], /not allowed for your role/, 'the coach cannot close');
  const left = Number(await one(K, `select public.complete_request_receipts($1, '2026-10-15')`, [r]));
  const back = (await q(`select * from public.ledger where request_id = $1 and source = 'Unspent Returned'`, [r]));
  ok(left === 50 && back.length === 1 && c(back[0].amount) === 5000 && back[0].fund_id === TFUND && (await req(r)).status === 'Closed',
    'Anna closes it: $50 unspent goes back to the team fund', `returned ${left}`);
  ok((await bal(TFUND)) === b0 - 25000, 'net cost to the fund is the $250 spent', $(await bal(TFUND)));
  await logged('team_requests', r, 'Closed', /^Request · /, 'close logged as Closed');
  await fails(K, `select public.complete_request_receipts($1)`, [r], /Only a paid request/, 'cannot close twice');
  const p = await one(C, `select public.team_portal()`);
  ok(p.requests.find((x) => x.id === r)?.status === 'Closed', 'the team sees it Closed', p.requests.find((x) => x.id === r)?.status);
}
await books('approve, pay, close');

section('1b. Decline');
{
  const b0 = await bal(TFUND), k0 = await committed(TFUND), n0 = (await q(`select count(*)::int n from public.ledger`))[0].n;
  const r = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Trip', amount: 120 })]);
  await fails(B, `select public.decline_request($1, ' ')`, [r], /reason/, 'a decline needs a reason');
  await fails(C, `select public.decline_request($1, 'x')`, [r], /Board sign-in/, 'the coach cannot decline');
  await as(B, `select public.decline_request($1, 'Not a team cost')`, [r]);
  const x = await req(r);
  ok(x.status === 'Declined' && x.decline_reason === 'Not a team cost' && x.declined_by === 'Sample Director', 'declined with reason and who', `${x.status} · ${x.decline_reason}`);
  ok((await q(`select count(*)::int n from public.ledger`))[0].n === n0 && (await bal(TFUND)) === b0 && (await committed(TFUND)) === k0, 'a decline posts nothing and commits nothing');
  await logged('team_requests', r, 'Declined', /^Request · /, 'decline logged as Declined');
  await fails(K, `select public.mark_request_paid($1, current_date, 'Check', '1')`, [r], /Only an approved request/, 'a declined request cannot be paid');
  await fails(T, `select public.approve_request($1)`, [r], /not waiting for approval/, 'a declined request cannot be approved');
  const pr = (await one(C, `select public.team_portal()`)).requests.find((y) => y.id === r);
  ok(pr?.status === 'Declined' && pr?.decline_reason === 'Not a team cost', 'the team sees the decline and its reason', pr?.decline_reason);
  // roll back the decline (Treasurer), then decline again and archive it
  const dl = await logRow('team_requests', r, 'Declined');
  await fails(B, `select public.rollback_change($1, 'x')`, [dl.id], /not allowed for your role/, 'only the Treasurer rolls back a decline');
  await as(T, `select public.rollback_change($1, 'Declined the wrong one')`, [dl.id]);
  ok((await req(r)).status === 'Submitted' && (await req(r)).decline_reason === null, 'rolling back the decline puts it back to Submitted', (await req(r)).status);
  await logged('team_requests', r, 'Rolled Back', /^Request · /, 'the roll back is logged as Rolled Back');
  await as(B, `select public.decline_request($1, 'Not a team cost')`, [r]);
  await fails(B, `delete from public.team_requests where id = $1`, [r], /permission denied/, 'a request cannot be deleted by a board member');
  await ownerFails(`delete from public.team_requests where id = '${r}'`, /archived, never deleted/, 'a request cannot be deleted even by the owner');
  await as(B, `select public.archive_record('team_requests', $1, 'Declined, filed away')`, [r]);
  ok((await req(r)).archived_at !== null, 'a declined request is archived', r);
  await logged('team_requests', r, 'Archived', /^Request · /, 'archive logged as Archived');
}
await books('decline');

section('1c. Overspend: warn at approval, block payment, Treasurer override logged');
{
  const b0 = await bal(TFUND);
  const amt = b0 / 100 + 200;                                      // $200 more than the fund holds
  const r = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Big field kit', amount: amt })]);
  const a1 = await one(B, `select public.approve_request($1)`, [r]);
  ok(a1.status === 'Submitted' && a1.needed === 2 && a1.warnings.some((w) => /overspend/.test(w)), 'first of two approvals already warns of the overspend', a1.warnings[0]);
  const a2 = await one(B2, `select public.approve_request($1)`, [r]);
  ok(a2.status === 'Approved' && a2.warnings.some((w) => /Payment will be blocked/.test(w)), 'second approval approves, with the warning', a2.warnings[0]);
  await fails(K, `select public.mark_request_paid($1, '2026-10-16', 'Check', '5010')`, [r], /Blocked: .*overspend/, 'payment is blocked');
  await fails(K, `select public.mark_request_paid($1, '2026-10-16', 'Check', '5010', 'Board said ok')`, [r], /Only the Treasurer can override/, 'Anna cannot override');
  await fails(T, `select public.mark_request_paid($1, '2026-10-16', 'Check', '5010', '  ')`, [r], /Blocked/, 'a blank override reason is not an override');
  ok((await bal(TFUND)) === b0 && (await outRows(r)).length === 0, 'nothing posted by the blocked attempts', $(await bal(TFUND)));
  const n0 = (await q(`select count(*)::int n from public.money_overrides`))[0].n;
  await as(T, `select public.mark_request_paid($1, '2026-10-16', 'Check', '5010', 'Sponsor cheque arriving Monday')`, [r]);
  const ov = await q(`select * from public.money_overrides where record_id = $1`, [r]);
  ok(ov.length === 1 && /overspend/.test(ov[0].rule) && ov[0].reason === 'Sponsor cheque arriving Monday' && ov[0].action === 'pay' && ov[0].by_name === 'Sample Treasurer' && c(ov[0].amount) === c(amt),
    'the Treasurer overrides: one override logged with rule, reason, who and amount', ov[0]?.rule);
  ok((await q(`select count(*)::int n from public.money_overrides`))[0].n === n0 + 1, 'exactly one new override');
  await logged('money_overrides', String(ov[0].id), 'Overrode', /^Override · .*overspend/, 'the override is in History as Overrode under Ledger');
  ok((await bal(TFUND)) === b0 - c(amt) && (await bal(TFUND)) < 0, 'paid: the fund is $200 overdrawn, exactly', $(await bal(TFUND)));
  await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-17', dir: 'in', amount: 2000, fund_id: TFUND, source: 'Test Deposit' })]);
}
await books('overspend override');

// ================================================================ 2. reimbursement with several receipts
section('2. Reimbursement with several receipts, locked at first approval');
{
  const reimb = (receipts, extra = {}) => JSON.stringify({ type: 'Reimbursement', category: 'Robot Parts & Construction', purchase_date: '2026-10-20',
    zelle_contact: 'coach@example.org', certified: true, receipts, ...extra });
  await fails(C, `select public.submit_team_request($1)`, [reimb([rc('AndyMark', 10, 'team/T-9255/x.pdf')])], /not in this team/, 'receipts only from the team’s own folder');
  const r = await one(C, `select public.submit_team_request($1)`, [reimb([rc('AndyMark', 300), rc('REV Robotics', 150.5), rc('Home Depot', 99.25)], { amount: 9999 })]);
  ok(c((await req(r)).amount) === 54975, 'total is the receipts’ sum ($549.75), typed amount ignored', (await req(r)).amount);
  const extra = await one(C, `select public.add_team_receipt($1, 'Pololu', 10, '2026-10-21', 'p.pdf', $2)`, [r, `team/${TEAM}/p.pdf`]);
  ok(c((await req(r)).amount) === 55975, 'adding a fourth receipt raises the total', (await req(r)).amount);
  await as(C, `select public.team_receipt_remove($1, 'Wrong receipt')`, [extra]);
  ok(c((await req(r)).amount) === 54975, 'removing it lowers the total again', (await req(r)).amount);
  await logged('receipts', extra, 'Archived', /^Receipt · \$10\.00 Pololu/, 'the removed receipt is logged as Archived');
  await logged('team_requests', r, 'Changed', /^Request · /, 'the total change is logged');
  const a1 = await one(B, `select public.approve_request($1)`, [r]);
  ok(a1.status === 'Submitted' && a1.approvals === 1 && a1.needed === 2, 'first of two approvals ($549.75 is over $500)', JSON.stringify(a1));
  await fails(C, `select public.add_team_receipt($1, 'x', 1, null, 'p.pdf', $2)`, [r, `team/${TEAM}/q.pdf`], /board has not approved yet/, 'locked at first approval: the team cannot add a receipt');
  await fails(C, `select public.team_receipt_remove($1, 'x')`, [(await q(`select id from public.receipts where request_id = $1 and archived_at is null order by id limit 1`, [r]))[0].id], /no longer be removed/, 'locked: the team cannot remove one');
  await fails(B2, `select public.add_request_receipt($1, 'x', 1, null, null, null, null)`, [r], /receipts and total are fixed/, 'locked: the board cannot add one');
  await fails(K, `select public.receipt_archive($1, 'x')`, [(await q(`select id from public.receipts where request_id = $1 and archived_at is null order by id limit 1`, [r]))[0].id], /receipts and total are fixed/, 'locked: the board cannot remove one');
  await fails(B2, `select public.request_save($1)`, [JSON.stringify({ id: r, team_id: TEAM, type: 'Reimbursement', purpose: 'x', amount: 600 })], /approvals; its amount cannot change|sum of its receipts/, 'locked: the total cannot be typed over');
  await fails(B, `select public.approve_request($1)`, [r], /already approved/, 'one approval per member');
  await as(B2, `select public.approve_request($1)`, [r]);
  const b0 = await bal(TFUND);
  await as(K, `select public.mark_request_paid($1, '2026-10-22', 'Zelle', 'Z-100')`, [r]);
  const o = await outRows(r);
  ok((await req(r)).status === 'Paid' && o.length === 1 && c(o[0].amount) === 54975 && (await bal(TFUND)) === b0 - 54975, 'paid once for the whole $549.75', o.map((x) => x.id).join(','));
  await fails(B, `select public.receipt_remind($1)`, [r], /Nothing is missing/, 'no reminder when every receipt has its file');

  // receipt reminder: a paid pre-approval with no receipt
  const pa = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Field tiles', amount: 40 })]);
  await fails(B, `select public.receipt_remind($1)`, [pa], /Nothing is missing/, 'no reminder before it is paid');
  await as(T, `select public.approve_request($1)`, [pa]);
  await as(K, `select public.mark_request_paid($1, '2026-10-23', 'Debit Card')`, [pa]);
  ok((await one(C, `select public.team_portal()`)).requests.find((y) => y.id === pa)?.missing === true, 'the team sees it missing a receipt');
  await fails(C, `select public.receipt_remind($1)`, [pa], /not allowed for your role/, 'the team cannot send a reminder');
  await fails(B, `insert into public.receipt_reminders (request_id) values ($1)`, [pa], /permission denied/, 'reminders only through receipt_remind');
  const rm = await one(B, `select public.receipt_remind($1, 'Please upload the tiles invoice')`, [pa]);
  ok(/^RM-/.test(rm), 'a board member sends a portal reminder', rm);
  await logged('receipt_reminders', rm, 'Reminded', /^Receipt reminder · request R-\d+ · FT$/, 'reminder logged as Reminded under Requests');
  const pr = (await one(C, `select public.team_portal()`)).requests.find((y) => y.id === pa);
  ok(pr.reminder?.by === 'Sample Director' && pr.reminder?.note === 'Please upload the tiles invoice', 'the team sees the reminder on its request', JSON.stringify(pr.reminder));
  await as(C, `select public.add_team_receipt($1, 'Tiles Co', 40, '2026-10-24', 't.pdf', $2)`, [pa, `team/${TEAM}/t.pdf`]);
  ok((await one(C, `select public.team_portal()`)).requests.find((y) => y.id === pa)?.missing === false, 'missing clears once the receipt is in');
  ok(Number(await one(K, `select public.complete_request_receipts($1, '2026-10-25')`, [pa])) === 0, 'closed with nothing unspent');
}
await books('reimbursement and reminder');

// ================================================================ 3. direct expenses
section('3. Direct expense filed by a board member');
{
  const de = (extra = {}) => JSON.stringify({ purpose: 'Field build parts', charge_fund_id: TFUND, pay_method: 'Check', pay_ref: '7001', paid_date: '2026-10-26',
    invoices: [{ vendor: 'Sample Hardware', amount: 60, file_name: 'h.pdf', file_path: 'requests/direct/h.pdf' }, { vendor: 'Sample Lumber', amount: 15.5 }], ...extra });
  ok((await one(B, `select public.can_file_direct()`)) === false && (await one(O, `select public.can_file_direct()`)) === true, 'files_direct marks the officer, not the ordinary board member');
  await fails(B, `select public.direct_expense_file($1)`, [de()], /Only the Treasurer, the bookkeeper and officers/, 'an ordinary board member cannot file');
  await fails(C, `select public.direct_expense_file($1)`, [de()], /not allowed for your role/, 'a team login cannot file');
  await fails(CP, `select public.direct_expense_file($1)`, [de()], /not allowed for your role|read only/, 'the CPA cannot file');
  const b0 = await bal(TFUND), k0 = await committed(TFUND);
  const f = await one(O, `select public.direct_expense_file($1)`, [de()]);
  const r = await req(f.id);
  ok(r.type === 'Direct Expense' && r.status === 'Submitted' && c(r.amount) === 7550 && r.charge_fund_id === TFUND && r.team_id === null, 'the officer files $75.50 against the team fund', f.id);
  ok((await outRows(f.id)).length === 0 && (await committed(TFUND)) === k0 + 7550 && (await bal(TFUND)) === b0, 'filed: committed, nothing posted yet');
  await logged('team_requests', f.id, 'Added', /^Direct expense · \$75\.50 .*· FT Team Fund$/, 'filing logged as Added under Requests');
  ok((await one(C, `select public.team_portal()`)).direct.some((y) => y.id === f.id && y.missing === true), 'the team sees it on its fund, missing one file');
  await fails(T, `select public.direct_expense_review($1)`, [f.id], /not allowed for your role/, 'the Treasurer does not review without an override');
  await fails(T, `select public.direct_expense_review($1, 'looks fine')`, [f.id], /The bookkeeper reviews direct expenses/, 'the Treasurer review is override-only (nothing to override here)');
  await fails(O, `select public.direct_expense_review($1)`, [f.id], /not allowed for your role/, 'the filer does not review');
  await fails(B, `select public.approve_request($1)`, [f.id], /reviewed by the bookkeeper/, 'a direct expense is not approved');
  await fails(K, `select public.mark_request_paid($1, current_date, 'Check', '1')`, [f.id], /Only an approved request/, 'a direct expense is not paid through payment');
  ok((await q(`select count(*)::int n from public.money_overrides where record_id = $1`, [f.id]))[0].n === 0, 'a refused Treasurer review logs no override');
  const led = await one(K, `select public.direct_expense_review($1)`, [f.id]);
  const l = (await q(`select * from public.ledger where id = $1`, [led]))[0];
  ok((await req(f.id)).status === 'Reviewed' && (await req(f.id)).reviewed_by === 'Anna (sample bookkeeper)' && l.fund_id === TFUND && c(l.amount) === 7550 && l.category === 'Robotics Teams' && l.pay_ref === '7001',
    'Anna reviews: one $75.50 row posted to the team fund as paid', led);
  ok((await bal(TFUND)) === b0 - 7550 && (await committed(TFUND)) === k0, 'reviewed: balance down, no longer committed');
  await logged('team_requests', f.id, 'Reviewed', /^Direct expense · /, 'review logged as Reviewed');
  await logged('ledger', led, 'Reviewed', /^Ledger · \$75\.50 .*FT Team Fund$/, 'its ledger row logged as Reviewed under Ledger');
  await fails(K, `select public.direct_expense_review($1)`, [f.id], /not waiting for review/, 'cannot review twice');
  const inv = (await q(`select id from public.receipts where request_id = $1 and file_path is null`, [f.id]))[0].id;
  await as(K, `select public.receipt_attach($1, 'l.pdf', 'requests/direct/l.pdf')`, [inv]);
  ok((await q(`select file_path from public.receipts where id = $1`, [inv]))[0].file_path === 'requests/direct/l.pdf', 'the missing invoice file is attached later');

  // the Treasurer reviews only to override a rule a team-fund expense breaks
  const big = await one(O, `select public.direct_expense_file($1)`, [de({ purpose: 'Big order', invoices: [{ vendor: 'Sample Big', amount: (await bal(TFUND)) / 100 + 50 }] })]);
  ok(big.warnings.some((w) => /overspend/.test(w)), 'filing an overspend warns', big.warnings[0]);
  await fails(K, `select public.direct_expense_review($1)`, [big.id], /Blocked: .*overspend/, 'Anna’s review of the overspend is blocked');
  await fails(K, `select public.direct_expense_review($1, 'ok')`, [big.id], /Only the Treasurer can override/, 'Anna cannot override');
  const b1 = await bal(TFUND);
  await as(T, `select public.direct_expense_review($1, 'Grant money arriving')`, [big.id]);
  const ov = await q(`select * from public.money_overrides where record_id = $1`, [big.id]);
  ok((await req(big.id)).status === 'Reviewed' && ov.length === 1 && ov[0].action === 'review' && ov[0].reason === 'Grant money arriving', 'the Treasurer’s override review posts it and is logged', ov[0]?.rule);
  ok((await bal(TFUND)) === b1 - c(big.amount), 'it posts exactly its total', $(await bal(TFUND)));
  const gen = await one(O, `select public.direct_expense_file($1)`, [de({ purpose: 'Office paper', charge_fund_id: 'F-GEN', pay_method: 'Debit Card', pay_ref: null, invoices: [{ vendor: 'Sample Office', amount: 12 }] })]);
  await fails(T, `select public.direct_expense_review($1, 'any reason')`, [gen.id], /The bookkeeper reviews direct expenses/, 'the Treasurer cannot review a GPRIC General expense, even with a reason');
  await as(K, `select public.direct_expense_review($1)`, [gen.id]);
  ok((await outRows(gen.id))[0]?.category === 'Administration', 'GPRIC General expense posts as Administration');
  await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-27', dir: 'in', amount: 2000, fund_id: TFUND, source: 'Test Deposit' })]);

  // probe: GPRIC General overspend at review. 0006 says General "gets only the checks every ledger entry gets", and
  // every ledger entry out (ledger_add) is blocked when it overspends the fund.
  const g0 = await bal('F-GEN');
  const gbig = await one(O, `select public.direct_expense_file($1)`, [de({ purpose: 'Probe: General overspend', charge_fund_id: 'F-GEN', pay_method: 'Debit Card', pay_ref: null,
    invoices: [{ vendor: 'Sample Vendor', amount: g0 / 100 + 500 }] })]);
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-27', dir: 'out', amount: g0 / 100 + 500, fund_id: 'F-GEN', category: 'Administration' })], /overspend/,
    'control: the same amount entered as a ledger entry is blocked as an overspend');
  let gerr = null;
  try { await as(K, `select public.direct_expense_review($1)`, [gbig.id]); } catch (e) { gerr = e.message; }
  defect(!!gerr && /overspend/.test(gerr), 'a direct expense that overspends GPRIC General is blocked at review like any ledger entry', {
    flow: 'Direct expense on GPRIC General',
    steps: `Officer files a direct expense on F-GEN for $500 more than its balance ($${$(g0)}); Anna runs direct_expense_review on it.`,
    expected: 'Review blocked with "Blocked: ... overspend" unless the Treasurer overrides (0006 comment: General "gets only the checks every ledger entry gets"; ledger_add blocks this amount).',
    actual: gerr ? `refused: ${gerr}` : `posted with no check and no override; F-GEN went to $${$(await bal('F-GEN'))}`,
    passReason: gerr,
  });
  if (!gerr) await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-27', dir: 'in', amount: g0 / 100 + 1000, fund_id: 'F-GEN', source: 'Test Deposit' })]);
}
await books('direct expenses');

// ================================================================ 4. refund, cancel, replacement, and rolling each back
section('4a. Refund, and its roll back');
{
  const r = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Motors', amount: 200 })]);
  await as(T, `select public.approve_request($1)`, [r]);
  const b0 = await bal(TFUND);
  await as(K, `select public.mark_request_paid($1, '2026-10-28', 'Check', '5020')`, [r]);
  await fails(B, `select public.request_refund($1, 250, '2026-10-29', 'Returned')`, [r], /more than the \$200\.00/, 'a refund cannot exceed what was paid');
  await fails(B, `select public.request_refund($1, 5, '2026-10-29', 'Lost')`, [r], /returned or cancelled/, 'refund reason is Returned or Cancelled');
  await fails(C, `select public.request_refund($1, 5, '2026-10-29', 'Returned')`, [r], /not allowed for your role/, 'a team login cannot refund');
  const rf = await one(B, `select public.request_refund($1, 50, '2026-10-29', 'Returned', 'One motor sent back')`, [r]);
  const rl = (await q(`select l.* from public.ledger l join public.request_refunds f on f.ledger_id = l.id where f.id = $1`, [rf]))[0];
  ok(rl.dir === 'in' && rl.source === 'Refund' && rl.fund_id === TFUND && rl.request_id === r && c(rl.amount) === 5000, 'refund is a $50 Refund row back into the same fund', rf);
  ok((await bal(TFUND)) === b0 - 15000, 'balance: paid $200, refunded $50 (no double counting)', $(await bal(TFUND)));
  await logged('request_refunds', rf, 'Refunded', /^Refund · \$50\.00 request R-\d+ · FT$/, 'refund logged as Refunded under Requests');
  await logged('ledger', rl.id, 'Refunded', /^Ledger · \$50\.00 /, 'refund ledger row logged as Refunded under Ledger');
  await fails(B, `select public.request_refund($1, 1, '2026-10-29', 'Returned')`, [r], /already recorded/, 'one refund per request');
  const tf = (await one(T, `select public.portal_totals()`)).funds.find((x) => x.id === TFUND);
  ok(!('Refund' in (await one(T, `select public.portal_totals()`)).in_by_source), 'a refund is not counted as money raised');
  ok(c(tf.out) === (await q(`select coalesce(sum(case when (dir = 'out') = (reverses_id is null) then amount else -amount end) filter (where (dir='out' and reverses_id is null) or (dir='in' and reverses_id is not null)), 0) - coalesce(sum(amount) filter (where dir='in' and source='Refund' and reverses_id is null), 0) v from public.ledger where fund_id = $1`, [TFUND])).map((x) => c(x.v))[0],
    'the fund’s money out nets the refund', tf.out);
  const bR = await bal(TFUND);
  await fails(T, `select public.rollback_change($1, 'test')`, [(await logRow('request_refunds', rf, 'Refunded')).id], /fixed once recorded/, 'roll back of the refund itself is refused (its money is in the ledger)');
  await fails(T, `select public.rollback_change($1, 'test')`, [(await logRow('ledger', rl.id, 'Refunded')).id], /payment on the request/, 'roll back of the refund ledger row is refused');
  await fails(T, `select public.rollback_change($1, 'test')`, [(await logRow('team_requests', r, 'Paid')).id], /refund recorded/, 'roll back of the refunded payment is refused');
  await fails(T, `select public.ledger_reverse($1, 'test')`, [rl.id], /Undo it from the request/, 'the refund row is not reversed by hand');
  await fails(B, `select public.request_cancel($1, 'x')`, [r], /not yet paid/, 'a refunded request cannot be cancelled');
  ok((await bal(TFUND)) === bR && (await req(r)).status === 'Receipts Due', 'every refused roll back left the books and the request as they were', $(await bal(TFUND)));

  // probe: a full refund, then the bookkeeper closes the request (it still sits in Receipts Due, so it would count
  // against the team's receipt deadline until closed).
  const z = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Probe: order cancelled by vendor', amount: 100 })]);
  await as(T, `select public.approve_request($1)`, [z]);
  const z0 = await bal(TFUND);
  await as(K, `select public.mark_request_paid($1, '2026-10-28', 'Check', '5021')`, [z]);
  await as(B, `select public.request_refund($1, 100, '2026-10-29', 'Cancelled', 'Vendor cancelled the order')`, [z]);
  ok((await bal(TFUND)) === z0 && (await req(z)).status === 'Receipts Due', 'full refund: the fund is back where it started, request still Receipts Due', $(await bal(TFUND)));
  const zl = Number(await one(K, `select public.complete_request_receipts($1, '2026-10-30')`, [z]));
  const zb = await bal(TFUND);
  defect(zb === z0, 'closing a fully refunded request returns nothing more to the fund', {
    flow: 'Refund then close',
    steps: 'Coach submits a $100 pre-approval; Treasurer approves; Anna pays it ($100 out); board member records a $100 refund, reason Cancelled ($100 back in); request stays Receipts Due; Anna runs complete_request_receipts on it with no receipts.',
    expected: 'Request closes with $0 unspent returned; the fund ends where it started (refunds count as returned money).',
    actual: `close returned $${zl.toFixed(2)} as "Unspent Returned"; the fund ends $${$(zb - z0)} richer than before the request (paid $100, credited $${$(zb - z0 + 10000)})`,
    passReason: `returned ${zl}`,
  });
}
await books('refund');

section('4b. Cancel, and its roll back');
{
  const r = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Trip deposit', amount: 80 })]);
  await as(T, `select public.approve_request($1)`, [r]);
  const b0 = await bal(TFUND), k0 = await committed(TFUND), n0 = (await q(`select count(*)::int n from public.ledger`))[0].n;
  await fails(B, `select public.request_cancel($1, ' ')`, [r], /reason/, 'a cancel needs a reason');
  await fails(C, `select public.request_cancel($1, 'x')`, [r], /not allowed for your role/, 'a team login cannot cancel');
  await as(B, `select public.request_cancel($1, 'Trip called off')`, [r]);
  ok((await req(r)).status === 'Cancelled' && (await committed(TFUND)) === k0 - 8000 && (await bal(TFUND)) === b0 && (await q(`select count(*)::int n from public.ledger`))[0].n === n0,
    'cancelled: no longer committed, nothing posted', $(await committed(TFUND)));
  await logged('team_requests', r, 'Cancelled', /^Request · /, 'cancel logged as Cancelled');
  await fails(K, `select public.mark_request_paid($1, '2026-10-30', 'Check', '1')`, [r], /Only an approved request/, 'a cancelled request cannot be paid');
  ok((await one(C, `select public.team_portal()`)).requests.find((y) => y.id === r)?.cancel_reason === 'Trip called off', 'the team sees the cancel and its reason');
  await as(T, `select public.rollback_change($1, 'Cancelled by mistake')`, [(await logRow('team_requests', r, 'Cancelled')).id]);
  ok((await req(r)).status === 'Approved' && (await committed(TFUND)) === k0 && (await bal(TFUND)) === b0, 'rolling back the cancel: Approved and committed again, balance unchanged', (await req(r)).status);
  await as(K, `select public.mark_request_paid($1, '2026-10-30', 'Check', '5030')`, [r]);
  ok((await outRows(r)).length === 1 && (await bal(TFUND)) === b0 - 8000 && (await committed(TFUND)) === k0 - 8000, 'it is then paid exactly once', $(await bal(TFUND)));
  await fails(K, `select public.mark_request_paid($1, '2026-10-30', 'Check', '5031')`, [r], /Only an approved request/, 'no second payment');
  await fails(B, `select public.request_cancel($1, 'x')`, [r], /not yet paid/, 'a paid request cannot be cancelled');
  // roll back the payment: the ledger row is reversed and the request steps back; pay again once
  const b1 = await bal(TFUND);
  await as(T, `select public.rollback_change($1, 'Paid the wrong check number')`, [(await logRow('team_requests', r, 'Paid')).id]);
  ok((await req(r)).status === 'Approved' && (await outRows(r)).length === 0 && (await bal(TFUND)) === b1 + 8000 && (await committed(TFUND)) === k0,
    'rolling back the payment reverses it and the request is Approved again', $(await bal(TFUND)));
  await logged('ledger', (await q(`select id from public.ledger where request_id = $1 and reverses_id is not null`, [r]))[0].id, 'Reversed', /^Ledger · \$80\.00/, 'the reversal is logged as Reversed under Ledger');
  await as(K, `select public.mark_request_paid($1, '2026-10-30', 'Check', '5032')`, [r]);
  ok((await outRows(r)).length === 1 && (await bal(TFUND)) === b1, 'paid again: one open payment, balance as after the first payment', $(await bal(TFUND)));
}
await books('cancel');

section('4c. Replacement for a cancelled item, and rolling it back');
{
  const r = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Bumper fabric', amount: 90 })]);
  await as(T, `select public.approve_request($1)`, [r]);
  const b0 = await bal(TFUND), k0 = await committed(TFUND);
  const cr = await one(B, `select public.request_cancel($1, 'Wrong colour', true)`, [r]);
  const n = cr.replacement;
  ok(!!n && (await req(r)).replaced_by_id === n && (await req(n)).replaces_id === r && (await req(n)).status === 'Submitted' && c((await req(n)).amount) === 9000 && (await req(n)).team_id === TEAM,
    'cancel with reorder: a $90 replacement waiting for approval, linked both ways', n);
  ok((await committed(TFUND)) === k0 - 9000 && (await bal(TFUND)) === b0, 'neither the cancelled original nor the unapproved replacement is committed');
  await logged('team_requests', n, 'Added', /^Request · /, 'the replacement is logged as Added');
  await fails(T, `select public.rollback_change($1, 'x')`, [(await logRow('team_requests', r, 'Cancelled')).id], /stays cancelled/, 'roll back of a reordered cancel is refused');
  await fails(K, `select public.mark_request_paid($1, '2026-10-30', 'Check', '1')`, [r], /Only an approved request/, 'the original cannot be paid');
  await as(T, `select public.approve_request($1)`, [n]);
  await as(K, `select public.mark_request_paid($1, '2026-10-31', 'Check', '5040')`, [n]);
  ok((await bal(TFUND)) === b0 - 9000 && (await outRows(r)).length === 0 && (await outRows(n)).length === 1, 'only the replacement is paid: one $90 payment in all', $(await bal(TFUND)));
  await fails(T, `select public.rollback_change($1, 'x')`, [(await logRow('team_requests', n, 'Added')).id], /booked money/, 'the paid replacement cannot be rolled away');
  await as(T, `select public.rollback_change($1, 'Paid too early')`, [(await logRow('team_requests', n, 'Paid')).id]);
  ok((await bal(TFUND)) === b0 && (await req(n)).status === 'Approved' && (await committed(TFUND)) === k0, 'rolling back the replacement’s payment restores the fund and commits it again', $(await bal(TFUND)));
  await as(T, `select public.rollback_change($1, 'Not needed after all')`, [(await logRow('team_requests', n, 'Added')).id]);
  const nn = await req(n);
  ok(nn.archived_at !== null && (await committed(TFUND)) === k0 - 9000 && (await bal(TFUND)) === b0, 'rolling back the replacement itself archives it: not committed, nothing paid', nn.archive_reason);
  await fails(K, `select public.mark_request_paid($1, '2026-10-31', 'Check', '5041')`, [n], /Request not found/, 'the rolled-back replacement cannot be paid');
  ok((await req(r)).status === 'Cancelled' && (await req(r)).replaced_by_id === n, 'the original stays cancelled and linked');
  // a replacement entered separately, linked afterwards
  const x1 = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Motors (out of stock)', amount: 30 })]);
  await as(B, `select public.request_cancel($1, 'Out of stock')`, [x1]);
  const x2 = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Motors, other vendor', amount: 35 })]);
  await as(B, `select public.request_link_replacement($1, $2)`, [x1, x2]);
  ok((await req(x1)).replaced_by_id === x2 && (await req(x2)).replaces_id === x1, 'a separate replacement is linked both ways');
  await fails(T, `select public.rollback_change($1, 'x')`, [(await logRow('team_requests', x1, 'Cancelled')).id], /never removed|stays cancelled/, 'the linked cancel is not rolled back');
}
await books('replacement');

// ================================================================ 5. restricted money
section('5. Restricted funds');
{
  const portal = await one(C, `select public.team_portal()`);
  ok((await q(`select restricted, team_id from public.funds where id = $1`, [TFUND]))[0].restricted === true, 'a new team’s fund is restricted to it', TFUND);
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 5, fund_id: TFUND, category: 'Space' })], /restricted to its own team/, 'the team’s fund does not pay for something else');
  await fails(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 5, fund_id: TFUND, category: 'Space' })], /Blocked: .*restricted/, 'not even the Treasurer without a reason');
  const b0 = await bal(TFUND);
  await as(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 5, fund_id: TFUND, category: 'Robotics Teams', party: 'Team cost' })]);
  ok((await bal(TFUND)) === b0 - 500, 'it pays a cost of its own team', $(await bal(TFUND)));
  const o0 = (await q(`select count(*)::int n from public.money_overrides`))[0].n;
  await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 7, fund_id: TFUND, category: 'Space', override: 'Shared field rental, team agreed' })]);
  const ov = await q(`select * from public.money_overrides order by id desc limit 1`);
  ok((await q(`select count(*)::int n from public.money_overrides`))[0].n === o0 + 1 && /restricted to its own team/.test(ov[0].rule) && ov[0].action === 'ledger_add', 'the Treasurer may, with a logged reason', ov[0].rule);
  const w = await one(B, `select public.spend_warnings($1, 1, 'T-9255', 'Robotics Teams')`, [TFUND]);
  ok(w.some((x) => /own team/.test(x)), 'another team’s request against this fund warns at approval', w[0]);
  const other = await one(C2, `select public.team_portal()`);
  ok(other.team.id === 'T-9255' && portal.team.id === TEAM, 'each team login sees its own fund only', `${portal.team.id} / ${other.team.id}`);
  await as(T, `select public.fund_save($1)`, [JSON.stringify({ name: 'Flow Lease Money', restricted: true, purpose: 'Lease only' })]);
  const lease = (await q(`select id from public.funds where name = 'Flow Lease Money'`))[0].id;
  await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'in', amount: 100, fund_id: lease, source: 'Test Deposit' })]);
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 10, fund_id: lease, category: 'Space' })], /restricted money/, 'other restricted money needs the Treasurer');
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 10, fund_id: lease, category: 'Space', override: 'please' })], /Only the Treasurer can override/, 'Anna cannot override it');
  await as(T, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-31', dir: 'out', amount: 10, fund_id: lease, category: 'Space', override: 'Lease payment' })]);
  ok((await bal(lease)) === 9000, 'the Treasurer spends it with a reason', $(await bal(lease)));
  await fails(K, `select public.fund_save($1)`, [JSON.stringify({ id: lease, name: 'Flow Lease Money', restricted: false })], /Only the Treasurer/, 'only the Treasurer lifts a restriction');
  await fails(K, `select public.fund_save($1)`, [JSON.stringify({ name: 'Sneaky', restricted: true })], /Only the Treasurer/, 'only the Treasurer makes a restricted fund');
  await fails(K, `select public.team_save($1)`, [JSON.stringify({ id: TEAM, name: 'Flow Test Team', short: 'FT', fund_id: 'F-9255' })], /Only the Treasurer/, 'only the Treasurer points a team at another fund');
}
await books('restricted funds');

// ================================================================ 6. ledger: add, edit, correct, reverse; archive, never delete
section('6. Ledger');
{
  const g0 = await bal('F-GEN');
  const a = await one(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-11-02', dir: 'in', amount: 40, fund_id: 'F-GEN', source: 'Test Deposit', party: 'Bake sale' })]);
  ok((await bal('F-GEN')) === g0 + 4000, 'Anna adds $40 in', a);
  const e1 = await logged('ledger', a, 'Added', /^Ledger · \$40\.00 Bake sale · /, 'the add is logged under Ledger');
  ok(e1?.user_id === ANNA && e1?.role === 'bookkeeper', 'logged as Anna, bookkeeper', `${e1?.who} ${e1?.role}`);
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 0, fund_id: 'F-GEN' })], /more than zero/, 'an amount must be more than zero');
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 5 })], /Pick a fund/, 'a fund is required');
  await as(K, `select public.ledger_edit($1, '{"memo": "Spring bake sale", "amount": 999, "fund_id": "F-9255"}')`, [a]);
  const ar = (await q(`select * from public.ledger where id = $1`, [a]))[0];
  ok(ar.memo === 'Spring bake sale' && c(ar.amount) === 4000 && ar.fund_id === 'F-GEN', 'an edit changes the description only, never the money', `${ar.memo} ${ar.amount} ${ar.fund_id}`);
  const ed = await logged('ledger', a, 'Changed', /^Ledger · /, 'the edit is logged as Changed');
  ok(/Memo/.test(ed?.summary || ''), 'with what changed', ed?.summary);
  await fails(K, `update public.ledger set amount = 1 where id = $1`, [a], /permission denied/, 'no direct ledger writes');
  const g1 = await bal('F-GEN');
  await fails(K, `select public.ledger_correct($1, '{"amount": 45}', ' ')`, [a], /reason/, 'a correction needs a reason');
  const nw = await one(K, `select public.ledger_correct($1, '{"amount": 45}', 'Counted wrong')`, [a]);
  const pair = await q(`select id, reverses_id, reversed_by_id, amount, dir from public.ledger where id = $1 or reverses_id = $1 or id = $2`, [a, nw]);
  ok((await bal('F-GEN')) === g1 + 500 && pair.length === 3, 'a correction reverses $40 and posts $45: net +$5', pair.map((x) => `${x.id}:${x.dir}${x.amount}`).join(' '));
  await logged('ledger', pair.find((x) => x.reverses_id === a).id, 'Reversed', /^Ledger · \$40\.00/, 'the correction’s reversal is logged as Reversed');
  await logged('ledger', nw, 'Added', /^Ledger · \$45\.00/, 'the corrected entry is logged as Added');
  await fails(K, `select public.ledger_reverse($1, 'again')`, [a], /already reversed/, 'the corrected original cannot be reversed again');
  const rv = await one(K, `select public.ledger_reverse($1, 'Entered twice')`, [nw]);
  ok((await bal('F-GEN')) === g1 - 4000, 'reversing the corrected entry takes the $45 out', $(await bal('F-GEN')));
  await fails(K, `select public.ledger_reverse($1, 'x')`, [rv], /itself a reversal/, 'a reversal is not reversed');
  await fails(K, `select public.ledger_reverse($1, ' ')`, [a], /reason|already reversed/, 'a reversal needs a reason');
  // roll back: an added entry is reversed; a description change is put back
  const b2 = await one(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-11-03', dir: 'out', amount: 12, fund_id: 'F-GEN', category: 'Administration', party: 'Stamps' })]);
  await as(K, `select public.ledger_edit($1, '{"memo": "Wrong memo"}')`, [b2]);
  await as(T, `select public.rollback_change($1, 'Memo belongs elsewhere')`, [(await logRow('ledger', b2, 'Changed')).id]);
  ok((await q(`select memo from public.ledger where id = $1`, [b2]))[0].memo === null, 'rolling back an edit puts the description back');
  const g2 = await bal('F-GEN');
  await as(T, `select public.rollback_change($1, 'Not our stamps')`, [(await logRow('ledger', b2, 'Added')).id]);
  ok((await bal('F-GEN')) === g2 + 1200 && (await q(`select reversed_by_id from public.ledger where id = $1`, [b2]))[0].reversed_by_id, 'rolling back an add reverses it', $(await bal('F-GEN')));
  // archive works, delete is refused
  await fails(B, `select public.archive_record('ledger', $1, 'x')`, [a], /money actions/, 'ledger rows are not archived (reversed instead)');
  await fails(K, `delete from public.ledger where id = $1`, [a], /permission denied/, 'ledger delete refused for the bookkeeper');
  await fails(T, `delete from public.ledger where id = $1`, [a], /permission denied/, 'ledger delete refused for the Treasurer');
  await ownerFails(`delete from public.ledger where id = '${a}'`, /archived, never deleted/, 'ledger delete refused even for the owner');
  await ownerFails(`delete from public.receipts where id = (select min(id) from public.receipts where not sample)`, /archived, never deleted/, 'receipt delete refused');
  await ownerFails(`delete from public.request_refunds`, /archived, never deleted/, 'refund delete refused');
  await as(B, `insert into public.documents (title, type) values ('Flow minutes', 'Board')`);
  const doc = (await q(`select id from public.documents where title = 'Flow minutes'`))[0].id;
  await fails(B, `delete from public.documents where id = $1`, [doc], /permission denied/, 'document delete refused');
  await as(B, `select public.archive_record('documents', $1, 'Superseded')`, [doc]);
  ok((await q(`select archived_at from public.documents where id = $1`, [doc]))[0].archived_at !== null, 'a document is archived');
  await logged('documents', doc, 'Archived', /^Document · Flow minutes$/, 'the archive is logged with its reason');
  await fails(B, `select public.archive_record('funds', $1, 'x')`, [TFUND], /still holds money/, 'a fund holding money cannot be archived');
}
await books('ledger');

// ================================================================ 7. month lock
section('7. Month lock');
{
  const stmt = await one(K, `select public.bank_statement_add('2026-09-01')`);
  const sep = await one(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-09-15', dir: 'in', amount: 25, fund_id: 'F-GEN', source: 'Test Deposit', party: 'September deposit' })]);
  await as(K, `select public.bank_lines_add($1, $2)`, [stmt, JSON.stringify([{ date: '2026-09-15', description: 'Deposit', amount: 25 }, { date: '2026-09-30', description: 'Fee', amount: -2 }])]);
  const line = (await q(`select id from public.bank_lines where statement_id = $1 order by id limit 1`, [stmt]))[0].id;
  await as(K, `select public.bank_line_match($1, $2, null)`, [line, sep]);
  await logged('bank_statements', stmt, 'Added', /^Month · September 2026$/, 'the statement is logged under Bank');
  await logged('bank_lines', line, 'Changed', /^Bank line · \$25\.00 Deposit$/, 'the match is logged under Bank');
  const off = Number(await one(K, `select public.bank_month_difference($1, 0)`, [stmt]));
  const fig = await one(K, `select public.bank_month_figures('2026-09-01')`);
  const book = (await q(`select coalesce(sum(case when dir = 'in' then amount else -amount end), 0) v from public.ledger where date <= '2026-09-30'`))[0].v;
  ok(c(fig.book) === c(book) && c(-off) === c(fig.expected), 'September figures: book balance equals the ledger to 30 September', `book ${fig.book}, expected ${fig.expected}`);
  await fails(K, `select public.lock_bank_month($1, $2)`, [stmt, -off + 1], /\$0\.00/, 'cannot lock with a difference');
  await fails(C, `select public.lock_bank_month($1, $2)`, [stmt, -off], /not allowed for your role/, 'a team login cannot lock');
  await as(K, `select public.lock_bank_month($1, $2)`, [stmt, -off]);
  ok((await q(`select locked_at from public.bank_statements where id = $1`, [stmt]))[0].locked_at !== null, 'Anna reconciles and locks September');
  await logged('bank_statements', stmt, 'Locked', /^Month · September 2026$/, 'the lock is logged as Locked under Bank');
  // frozen: ledger rows, the statement, its bank lines
  await fails(K, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-09-20', dir: 'in', amount: 5, fund_id: 'F-GEN' })], /locked/, 'no new ledger row in a locked month');
  await fails(T, `select public.ledger_edit($1, '{"memo":"x"}')`, [sep], /locked/, 'a locked month’s ledger row cannot be edited, even by the Treasurer');
  await fails(K, `select public.ledger_correct($1, '{"amount": 26}', 'typo')`, [sep], /locked/, 'nor corrected into the locked month');
  await fails(K, `select public.ledger_reverse($1, 'x', '2026-09-28')`, [sep], /locked/, 'nor reversed with a locked-month date');
  await ownerFails(`update public.ledger set memo = 'x' where id = '${sep}'`, /locked/, 'the lock holds even for the database owner');
  const rq = await one(C, `select public.submit_team_request($1)`, [pre({ purpose: 'Late September purchase', amount: 15 })]);
  await as(T, `select public.approve_request($1)`, [rq]);
  await fails(K, `select public.mark_request_paid($1, '2026-09-29', 'Check', '5050')`, [rq], /locked/, 'a payment cannot be dated in a locked month');
  ok((await req(rq)).status === 'Approved' && (await outRows(rq)).length === 0, 'the refused payment left the request Approved and unpaid');
  await fails(K, `select public.bank_lines_add($1, '[{"date":"2026-09-30","amount":1}]')`, [stmt], /locked/, 'no new bank line');
  await fails(K, `select public.bank_line_match($1, null, null)`, [line], /locked/, 'no bank line change');
  await fails(K, `select public.bank_line_archive($1, 'x')`, [line], /locked/, 'no bank line archive');
  await fails(K, `select public.bank_statement_set($1, '{"ending_balance": 1}')`, [stmt], /locked/, 'no statement change');
  await ownerFails(`update public.bank_lines set description = 'x' where id = '${line}'`, /locked/, 'bank lines hold even for the owner');
  await ownerFails(`update public.bank_statements set notes = 'x' where id = '${stmt}'`, /locked/, 'the statement holds even for the owner');
  const g0 = await bal('F-GEN');
  const rv = await one(K, `select public.ledger_reverse($1, 'Wrong fund')`, [sep]);
  ok((await bal('F-GEN')) === g0 - 2500 && (await q(`select date::text d from public.ledger where id = $1`, [rv]))[0].d >= '2026-10-01', 'a locked row is reversed into an open month (the locked row only gains the link)', rv);
  // only the Treasurer unlocks, with a reason
  await fails(K, `select public.unlock_bank_month($1, 'fix')`, [stmt], /not allowed for your role/, 'Anna cannot unlock');
  await fails(B, `select public.unlock_bank_month($1, 'fix')`, [stmt], /not allowed for your role/, 'a board member cannot unlock');
  await fails(CP, `select public.unlock_bank_month($1, 'fix')`, [stmt], /not allowed for your role|read only/, 'the CPA cannot unlock');
  await fails(T, `select public.unlock_bank_month($1, ' ')`, [stmt], /reason/, 'unlocking needs a reason');
  await as(T, `select public.unlock_bank_month($1, 'Missed a fee')`, [stmt]);
  const u = (await q(`select * from public.bank_statements where id = $1`, [stmt]))[0];
  ok(u.locked_at === null && u.unlock_reason === 'Missed a fee' && u.unlocked_by === 'Sample Treasurer', 'the Treasurer unlocks, reason kept', u.unlock_reason);
  const ul = await logged('bank_statements', stmt, 'Unlocked', /^Month · September 2026$/, 'the unlock is logged as Unlocked');
  ok(ul?.reason === 'Missed a fee', 'with its reason in History', ul?.reason);
  await as(K, `select public.bank_lines_add($1, '[{"date":"2026-09-30","description":"Late fee","amount":-1}]')`, [stmt]);
  ok(true, 'an unlocked month takes bank lines again');
  const off2 = Number(await one(K, `select public.bank_month_difference($1, 0)`, [stmt]));
  await as(K, `select public.lock_bank_month($1, $2)`, [stmt, -off2]);
  await fails(B, `select public.rollback_change($1, 'x')`, [(await logRow('bank_statements', stmt, 'Locked')).id], /not allowed for your role/, 'only the Treasurer rolls back a lock');
  await as(T, `select public.rollback_change($1, 'Locked before the fee posted')`, [(await logRow('bank_statements', stmt, 'Locked')).id]);
  ok((await q(`select locked_at from public.bank_statements where id = $1`, [stmt]))[0].locked_at === null, 'rolling back a lock unlocks the month');
  await as(K, `select public.lock_bank_month($1, $2)`, [stmt, -Number(await one(K, `select public.bank_month_difference($1, 0)`, [stmt]))]);
}
await books('month lock');

// ================================================================ 8. CPA and team logins
section('8. CPA reads, writes nothing, sees no contact fields');
{
  await db.exec(`update public.team_requests set requestor_email = 'coach@example.org', zelle_contact = 'coach@example.org' where team_id = '${TEAM}'`);
  const all = (await q(`select count(*)::int n from public.ledger`))[0].n;
  ok(Number(await one(CP, `select count(*) from public.ledger`)) === all, 'the CPA reads the whole ledger', `${all} rows`);
  ok(JSON.stringify(await one(CP, `select public.portal_totals()`)) === JSON.stringify(await one(T, `select public.portal_totals()`)), 'the CPA sees the Treasurer’s totals');
  ok(c(await one(CP, `select public.fund_balance($1)`, [TFUND])) === (await bal(TFUND)), 'and the same fund balance');
  ok(Number(await one(CP, `select count(*) from public.money_overrides`)) === (await q(`select count(*)::int n from public.money_overrides`))[0].n, 'the CPA sees every override');
  ok(Number(await one(CP, `select count(*) from public.request_refunds`)) === (await q(`select count(*)::int n from public.request_refunds`))[0].n, 'and every refund');
  ok(Number(await one(CP, `select count(*) from public.team_requests`)) === 0, 'a direct read of team_requests gives the CPA nothing (contact columns)');
  const masked = await as(CP, `select requestor_email, zelle_contact from public.team_requests_cpa where team_id = $1`, [TEAM]);
  ok(masked.rows.length > 0 && masked.rows.every((x) => x.requestor_email === null && x.zelle_contact === null), 'through team_requests_cpa every contact field is empty', `${masked.rows.length} requests`);
  ok(Number(await one(CP, `select count(*) from public.change_log_cpa x where x::text ilike '%coach@example.org%'`)) === 0, 'no contact email anywhere in the CPA’s History');
  ok(Number(await one(CP, `select count(*) from public.change_log_cpa where tbl = 'ledger'`)) > 0, 'the CPA reads the ledger’s History');
  const n0 = all;
  for (const [sql, params, what] of [
    [`select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 1, fund_id: 'F-GEN', source: 'Other' })], 'add a ledger entry'],
    [`select public.ledger_reverse($1, 'x')`, [(await q(`select id from public.ledger where reverses_id is null and reversed_by_id is null and request_id is null and donation_id is null limit 1`))[0].id], 'reverse an entry'],
    [`select public.approve_request($1)`, [(await q(`select id from public.team_requests where status = 'Submitted' and type <> 'Direct Expense' and archived_at is null limit 1`))[0].id], 'approve a request'],
    [`select public.mark_request_paid($1, '2026-11-05', 'Check', '1', 'x')`, [(await q(`select id from public.team_requests where status = 'Approved' and archived_at is null limit 1`))[0].id], 'pay a request'],
    [`select public.request_refund($1, 1, '2026-11-05', 'Returned')`, [(await q(`select id from public.team_requests where status = 'Paid' and archived_at is null limit 1`))[0].id], 'refund a request'],
    [`select public.request_cancel($1, 'x')`, [(await q(`select id from public.team_requests where status = 'Approved' and archived_at is null limit 1`))[0].id], 'cancel a request'],
    [`select public.receipt_remind($1)`, [(await q(`select id from public.team_requests where status in ('Paid','Receipts Due') and archived_at is null limit 1`))[0].id], 'send a reminder'],
    [`select public.rollback_change((select max(id) from public.change_log), 'x')`, [], 'roll back a change'],
    [`insert into public.ledger (date, dir, amount, fund_id) values (current_date, 'in', 1, 'F-GEN')`, [], 'insert a ledger row directly'],
    [`insert into public.problem_reports (notes) values ('x')`, [], 'file anything at all'],
  ]) {
    await fails(CP, sql, params, /not allowed for your role|read only|permission denied|row-level security|two-step/i, `the CPA cannot ${what}`);
  }
  ok((await q(`select count(*)::int n from public.ledger`))[0].n === n0, 'the CPA changed nothing in the ledger');
  ok(Number(await one(CP1, `select count(*) from public.ledger`)) === 0 && (await one(CP1, `select public.can_read_books()`)) === false, 'without two-step the CPA reads nothing');
}

section('8b. A team login sees only its own team');
{
  for (const t of ['ledger', 'team_requests', 'receipts', 'request_refunds', 'receipt_reminders', 'money_overrides', 'change_log', 'funds', 'bank_statements']) {
    ok(Number(await one(C, `select count(*) from public.${t}`)) === 0, `the coach reads no rows of ${t} directly`);
  }
  const p = await one(C, `select public.team_portal()`);
  const mine = (await q(`select id from public.team_requests where team_id = $1 and status <> 'Draft' and archived_at is null`, [TEAM])).map((x) => x.id).sort();
  ok(p.team.id === TEAM && JSON.stringify(p.requests.map((x) => x.id).sort()) === JSON.stringify(mine), 'the coach’s portal lists exactly its team’s requests', `${mine.length} requests`);
  const minDirect = (await q(`select id from public.team_requests where charge_fund_id = $1 and status in ('Submitted','Reviewed') and archived_at is null`, [TFUND])).map((x) => x.id).sort();
  ok(JSON.stringify(p.direct.map((x) => x.id).sort()) === JSON.stringify(minDirect), 'and exactly the direct expenses on its own fund', `${minDirect.length} direct expenses`);
  const p2 = await one(C2, `select public.team_portal()`);
  ok(!p2.requests.some((x) => mine.includes(x.id)) && !p2.direct.some((x) => minDirect.includes(x.id)), 'another team’s portal holds none of them');
  const hist = await as(C, `select distinct team_id from public.change_log_team`);
  ok(hist.rows.length > 0 && hist.rows.every((x) => x.team_id === TEAM), 'the coach’s History holds only its own team', hist.rows.map((x) => x.team_id).join(','));
  const hist2 = await as(C2, `select count(*)::int n from public.change_log_team where team_id = $1`, [TEAM]);
  ok(hist2.rows[0].n === 0, 'another team’s History holds none of this team’s rows');
  await fails(C, `select public.portal_totals()`, [], /Board sign-in/, 'no board totals for a team login');
  await fails(C, `select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 1, fund_id: TFUND })], /not allowed for your role/, 'a team login cannot touch the ledger');
  await fails(C, `select public.add_team_receipt($1, 'x', 1, null, 'p.pdf', $2)`, [(await q(`select id from public.team_requests where team_id = 'T-9255' and status = 'Receipts Due' limit 1`))[0]?.id ?? 'R-0000', `team/${TEAM}/x.pdf`], /only to your team|Receipts can be added only/, 'a team login cannot add a receipt to another team’s request');
  await fails(signed(COACH, 'coach@example.org', 'aal1'), `select public.team_portal()`, [], /two-step/, 'no Team Portal without two-step');
}
await books('access checks');

// ================================================================ 9. History: every action, right area and label
section('9. History sweep');
{
  const rows = await q(`select id, tbl, action, what, label, who, user_id, role from public.change_log where id > $1 order by id`, [LOG_START]);
  const wrongArea = rows.filter((r) => AREA[r.tbl] && r.what !== AREA[r.tbl]);
  ok(wrongArea.length === 0, `every one of ${rows.length} new History rows has the right area`, wrongArea.slice(0, 3).map((r) => `${r.tbl}:${r.what}`).join(', '));
  const wrongLabel = rows.filter((r) => LABEL[r.tbl] && !LABEL[r.tbl].test(r.label || ''));
  ok(wrongLabel.length === 0, 'every new History row has the right label', wrongLabel.slice(0, 3).map((r) => `${r.tbl}:"${r.label}"`).join(', '));
  const noWho = rows.filter((r) => !r.who || (!r.user_id && r.role !== 'system'));
  ok(noWho.length === 0, 'every new History row says who did it', noWho.slice(0, 3).map((r) => `${r.id}:${r.tbl}`).join(', '));
  const need = [['team_requests', 'Added'], ['team_requests', 'Approved'], ['team_requests', 'Declined'], ['team_requests', 'Paid'], ['team_requests', 'Closed'],
    ['team_requests', 'Cancelled'], ['team_requests', 'Reviewed'], ['team_requests', 'Archived'], ['team_requests', 'Rolled Back'], ['request_approvals', 'Approved'],
    ['receipts', 'Added'], ['receipts', 'Archived'], ['request_refunds', 'Refunded'], ['receipt_reminders', 'Reminded'], ['ledger', 'Added'], ['ledger', 'Changed'],
    ['ledger', 'Reversed'], ['ledger', 'Paid'], ['ledger', 'Refunded'], ['ledger', 'Reviewed'], ['ledger', 'Closed'], ['money_overrides', 'Overrode'],
    ['bank_statements', 'Locked'], ['bank_statements', 'Unlocked'], ['bank_lines', 'Added'], ['funds', 'Added'], ['documents', 'Archived']];
  const missing = need.filter(([t, a]) => !rows.some((r) => r.tbl === t && r.action === a));
  ok(missing.length === 0, `History has every kind of money action (${need.length} kinds)`, missing.map((x) => x.join(' ')).join(', '));
  const rolled = await q(`select count(*)::int n from public.change_log where id > $1 and rolled_back_at is not null`, [LOG_START]);
  ok(rolled[0].n >= 8, 'each roll back marked its original change', `${rolled[0].n} marked`);
  await fails(T, `update public.change_log set label = 'x' where id = $1`, [rows[0].id], /permission denied/, 'History is append only');
}

// ---------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (defects.length) {
  console.log(`\n${defects.length} DEFECT(S):`);
  for (const d of defects) console.log(`\nDEFECT · ${d.flow} · ${d.label}\n  Steps:    ${d.steps}\n  Expected: ${d.expected}\n  Actual:   ${d.actual}`);
}
process.exit(failed ? 1 : 0);
