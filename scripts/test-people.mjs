// P39, the People page: the Treasurer invites, changes and turns off board, bookkeeper and CPA logins (0014_people.sql).
// Only the Treasurer runs the People functions; an invite gives the chosen role and direct-expense mark at sign-up;
// a turned-off person loses every read and write (tables, functions, files, History, the CPA path) until turned back on;
// the Treasurer cannot turn off or change their own seat and one treasurer always stays on; every action is in History.
// Runs on its own: node scripts/test-people.mjs   (exits 1 when a check fails). Sample people only.
import { openDb } from './pg-stub.mjs';

const db = await openDb();
// Supabase's auth.users has these; the stub does not.
await db.exec(`alter table auth.users add column last_sign_in_at timestamptz`);

let failed = 0;
let passed = 0;
const ok = (cond, label) => { if (!cond) console.log('FAIL ' + label); else if (process.env.VERBOSE) console.log('PASS ' + label); if (cond) passed++; else failed++; };

async function as(claims, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role authenticated`);
    return tx.query(sql, params);
  });
}
async function err(claims, sql, params = []) {
  try { await as(claims, sql, params); return null; } catch (e) { return e; }
}
const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const REFUSED = /not allowed for your role|two-step is required|read only|permission denied|row-level security/i;

const id = (n) => `00000000-0000-0000-0000-0000000000${n}`;
const TREAS = id('e1'), BOARD = id('e2'), BOOKS = id('e3'), CPA = id('e4'), COACH = id('e5'), OFFICER = id('e6'), T2 = id('e7');
const who = (sub, email, aal = 'aal2') => ({ sub, email, aal, role: 'authenticated' });
const T = who(TREAS, 'treasurer@example.org');
const B = who(BOARD, 'director@example.org');
const K = who(BOOKS, 'books@example.org');
const C = who(CPA, 'cpa@example.org');
const CO = who(COACH, 'coach@example.org');
const O = who(OFFICER, 'officer@example.org');
const T1 = { ...T, aal: 'aal1' };

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into auth.users (id, email, invited_at, last_sign_in_at) values
    ('${TREAS}', 'treasurer@example.org', now(), now()), ('${BOARD}', 'director@example.org', now(), now()),
    ('${BOOKS}', 'books@example.org', now(), now()), ('${CPA}', 'cpa@example.org', now(), now()),
    ('${COACH}', 'coach@example.org', now(), now()), ('${OFFICER}', 'officer@example.org', now(), null);
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'board', name = 'Sample Director' where user_id = '${BOARD}';
  update public.portal_access set role = 'bookkeeper', name = 'Sample Bookkeeper' where user_id = '${BOOKS}';
  update public.portal_access set role = 'cpa', name = 'Sample CPA' where user_id = '${CPA}';
  update public.portal_access set role = 'board', name = 'Sample Officer', files_direct = true where user_id = '${OFFICER}';
  update public.settings set general_fund_id = 'F-GEN';
`);
await db.exec(`insert into storage.objects (bucket_id, name) values ('board-files', 'ledger/1-receipt.pdf'), ('board-files', 'documents/1-bylaws.pdf')`);

// ---------------------------------------------------------------- only the Treasurer

const CALLS = [
  [`select * from public.people_list()`, []],
  [`select public.people_invite_save('x@example.org', 'X', 'board', false)`, []],
  [`select public.people_invite_sent('director@example.org', null)`, []],
  [`select public.people_set_role('director@example.org', 'bookkeeper')`, []],
  [`select public.people_set_files_direct('director@example.org', true)`, []],
  [`select public.people_turn_off('director@example.org', 'x')`, []],
  [`select public.people_turn_on('director@example.org')`, []],
];
for (const [claims, tag] of [[B, 'board'], [K, 'bookkeeper'], [C, 'CPA'], [CO, 'team login'], [O, 'officer'], [T1, 'Treasurer without two-step']]) {
  for (const [sql, params] of CALLS) {
    const e = await err(claims, sql, params);
    ok(!!e && REFUSED.test(e.message), `${tag} refused: ${sql.slice(14, 50)} -> ${e ? e.message : 'no error'}`);
  }
}
for (const f of ['people_target(text)', 'people_keep_a_treasurer(uuid)']) {
  const e = await err(T, `select public.${f.replace('(text)', "('director@example.org')").replace('(uuid)', `('${TREAS}')`)}`);
  ok(!!e && /permission denied/.test(e.message), `${f} is internal, not callable even by the Treasurer -> ${e?.message}`);
}
ok(/permission denied/.test((await err(T, `select count(*) from public.people_invites`))?.message || ''), 'people_invites is not read directly, even by the Treasurer');

// ---------------------------------------------------------------- the list

let list = (await as(T, `select * from public.people_list() order by email`)).rows;
const by = (e) => list.find((r) => r.email === e);
ok(list.length === 5, 'the list holds the five portal seats and no team login: ' + list.map((r) => r.email).join(', '));
ok(by('treasurer@example.org')?.is_me === true && by('director@example.org')?.is_me === false, 'is_me marks the Treasurer');
ok(by('director@example.org')?.status === 'active' && by('officer@example.org')?.status === 'invited', 'status: active once signed in, invited before');
ok(by('officer@example.org')?.files_direct === true && by('cpa@example.org')?.role === 'cpa', 'role and files_direct are listed');
ok(by('director@example.org')?.last_sign_in_at != null, 'last sign-in comes from auth.users');

// ---------------------------------------------------------------- invites

for (const [sql, re, label] of [
  [`select public.people_invite_save('not-an-email', 'X', 'board', false)`, /Enter their email/, 'a bad email'],
  [`select public.people_invite_save('x@example.org', 'X', 'admin', false)`, /Pick a role/, 'a role outside the four'],
  [`select public.people_invite_save('Director@Example.org', 'X', 'board', false)`, /already has a portal login/, 'an email that already has a seat (any case)'],
  [`select public.people_invite_save('coach@example.org', 'X', 'board', false)`, /team login/, 'a team login email'],
]) {
  const e = await err(T, sql);
  ok(!!e && re.test(e.message), `invite refused for ${label} -> ${e?.message}`);
}

await as(T, `select public.people_invite_save(' New.Books@Example.org ', 'New Bookkeeper', 'bookkeeper', true)`);
await as(T, `select public.people_invite_sent('new.books@example.org', null)`);
await as(T, `select public.people_invite_save('new.cpa@example.org', 'New CPA', 'cpa', false)`);
await as(T, `select public.people_invite_sent('new.cpa@example.org', 'Email rate limit exceeded')`);
list = (await as(T, `select * from public.people_list() order by email`)).rows;
ok(by('new.books@example.org')?.status === 'invited' && by('new.books@example.org')?.has_login === false, 'a sent invite with no login yet shows as invited');
ok(by('new.cpa@example.org')?.status === 'not_sent' && /rate limit/.test(by('new.cpa@example.org')?.send_error || ''), 'a failed invite shows as not sent, with the error');
// The Treasurer changes an invite before they sign up.
await as(T, `select public.people_set_role('new.cpa@example.org', 'board')`);
await as(T, `select public.people_set_files_direct('new.cpa@example.org', true)`);
await as(T, `select public.people_set_role('new.cpa@example.org', 'cpa')`);
await as(T, `select public.people_set_files_direct('new.cpa@example.org', false)`);
// A second invite for the same email replaces the open one.
await as(T, `select public.people_invite_save('new.cpa@example.org', 'New CPA', 'cpa', false)`);
ok(Number((await q(`select count(*) n from public.people_invites where email = 'new.cpa@example.org' and archived_at is null`))[0].n) === 1, 'one open invite per email');

const NB = id('f1'), NC = id('f2'), DASH = id('f3');
await db.exec(`insert into auth.users (id, email, invited_at) values ('${NB}', 'new.books@example.org', now()), ('${NC}', 'New.CPA@example.org', now()),
                 ('${DASH}', 'dashboard@example.org', now())`);
const seat = async (u) => (await q(`select role, name, files_direct, archived_at from public.portal_access where user_id = $1`, [u]))[0];
let s = await seat(NB);
ok(s?.role === 'bookkeeper' && s?.files_direct === true && s?.name === 'New Bookkeeper', 'sign-up gives the invited role, name and direct-expense mark: ' + JSON.stringify(s));
s = await seat(NC);
ok(s?.role === 'cpa' && s?.files_direct === false, 'a CPA invite signs up as the CPA (email case ignored): ' + JSON.stringify(s));
ok((await seat(DASH))?.role === 'board', 'an invite from the Supabase dashboard (no People invite) is still a board seat');
ok((await q(`select user_id from public.people_invites where email = 'new.books@example.org' and archived_at is null`))[0]?.user_id === NB, 'the invite is linked to the new login');
ok((await q(`select 1 from public.team_users where user_id = $1`, [NB])).length === 0, 'a People invite never makes a team login');
ok(await one(who(NC, 'new.cpa@example.org'), `select public.my_role()`) === 'cpa' && await one(who(NB, 'new.books@example.org'), `select public.can_file_direct()`) === true,
  'the new logins work in their roles');
// A team invite newer than a People invite for the same email wins, and the other way round.
await as(T, `select public.people_invite_save('both@example.org', 'Both', 'board', false)`);
await db.exec(`insert into public.team_invites (team_id, email, name, role, invited_at) values ('T-9255', 'both@example.org', 'Both', 'Coach', now() + interval '1 minute');
               insert into auth.users (id, email, invited_at) values ('${id('f4')}', 'both@example.org', now())`);
ok((await q(`select 1 from public.team_users where user_id = $1`, [id('f4')])).length === 1 && !(await seat(id('f4'))), 'the newer invite (team) decides');

// Resend for a login invited before People existed: records an invite row so History shows it.
await as(T, `select public.people_invite_sent('officer@example.org', null)`);
ok((await q(`select user_id, role from public.people_invites where email = 'officer@example.org'`))[0]?.user_id === OFFICER, 'a resend for an older login is recorded');

// ---------------------------------------------------------------- turning off

const NOTE = B;
let e;
async function reach(claims) {
  return {
    role: await one(claims, `select public.my_role()`),
    board: await one(claims, `select public.is_board()`),
    whoami: await one(claims, `select public.whoami()`),
    books: await one(claims, `select public.can_read_books()`),
    ledger: Number(await one(claims, `select count(*) from public.ledger`)),
    log: Number(await one(claims, `select count(*) from public.change_log`)) + Number(await one(claims, `select count(*) from public.change_log_cpa`)),
    cpaLedger: Number(await one(claims, `select count(*) from public.board_members_cpa`)),
    files: Number(await one(claims, `select count(*) from storage.objects`)),
    off: Number(await one(claims, `select count(*) from public.my_access_off`)),
  };
}
const blocked = (r) => r.role === null && r.board === false && r.whoami === null && r.books === false && r.ledger === 0 && r.log === 0 && r.cpaLedger === 0 && r.files === 0;

ok(!blocked(await reach(NOTE)), 'before: the board member reads the books');
e = await err(T, `select public.people_turn_off('director@example.org', '  ')`);
ok(/Give a reason/.test(e?.message || ''), 'turning off needs a reason');
await as(T, `select public.people_turn_off('director@example.org', 'Left the board')`);
s = await seat(BOARD);
ok(s?.archived_at != null, 'turned off: the seat stays, marked off');
ok((await q(`select archived_by, archive_reason from public.portal_access where user_id = $1`, [BOARD]))[0]?.archive_reason === 'Left the board', 'the reason is kept');
let r = await reach(NOTE);
ok(blocked(r) && r.off === 1, 'turned off: no role, no board, no books, no History, no files: ' + JSON.stringify(r));
for (const [sql, params, label] of [
  [`select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 5, fund_id: 'F-GEN', source: 'Other' })], 'a ledger entry'],
  [`insert into public.ledger (date, dir, amount, fund_id) values (current_date, 'in', 5, 'F-GEN')`, [], 'a direct ledger insert'],
  [`select public.portal_totals()`, [], 'the totals'],
  [`select public.calendar_save($1)`, [JSON.stringify({ kind: 'board', title: 'x', date: '2026-12-01' })], 'a calendar event'],
  [`insert into storage.objects (bucket_id, name) values ('board-files', 'ledger/2-off.pdf')`, [], 'a file upload'],
  [`insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${BOARD}/1.png')`, [], 'a problem report file'],
  [`insert into public.problem_reports (notes) values ('x')`, [], 'a problem report'],
  [`insert into public.seen_tips (user_id, tip_key) values ('${BOARD}', 'ledger')`, [], 'a first-visit tip mark'],
]) {
  const x = await err(NOTE, sql, params);
  ok(!!x && REFUSED.test(x.message), `turned off: ${label} refused -> ${x ? x.message : 'no error'}`);
}
// Row security hides every row, so a direct change or removal touches nothing.
await err(NOTE, `update public.teams set blurb = 'x'`);
ok(Number((await q(`select count(*) n from public.teams where blurb = 'x'`))[0].n) === 0, 'turned off: a direct table change touches no row');
await err(NOTE, `delete from storage.objects`);
ok(Number((await q(`select count(*) n from storage.objects`))[0].n) === 2, 'turned off: no file removed');
e = await err(T, `select public.people_turn_off('director@example.org', 'again')`);
ok(/already off/.test(e?.message || ''), 'turning off twice is refused plainly');
list = (await as(T, `select * from public.people_list() order by email`)).rows;
ok(by('director@example.org')?.status === 'off' && by('director@example.org')?.off_reason === 'Left the board', 'the list shows them off, with the reason');

await as(T, `select public.people_turn_on('director@example.org')`);
s = (await q(`select archived_at, archived_by, archive_reason from public.portal_access where user_id = $1`, [BOARD]))[0];
ok(s.archived_at === null && s.archived_by === null && s.archive_reason === null, 'turning on clears the three columns');
r = await reach(NOTE);
ok(!blocked(r) && r.role === 'board' && r.whoami === 'board' && r.ledger > 0 && r.files === 2 && r.off === 0, 'turned back on: everything returns: ' + JSON.stringify(r));
ok((await err(NOTE, `insert into storage.objects (bucket_id, name) values ('board-files', 'ledger/3-back.pdf')`)) === null, 'turned back on: uploads again');
ok((await err(NOTE, `insert into public.seen_tips (user_id, tip_key) values ('${BOARD}', 'ledger')`)) === null, 'turned back on: tip marks again');

// The CPA path.
ok(Number(await one(C, `select count(*) from public.ledger`)) > 0 && Number(await one(C, `select count(*) from public.change_log_cpa`)) > 0, 'before: the CPA reads the books and History');
await as(T, `select public.people_turn_off('cpa@example.org', 'Engagement ended')`);
r = await reach(C);
ok(blocked(r) && await one(C, `select public.is_cpa()`) === false, 'a turned-off CPA reads nothing: tables, _cpa views, History, files: ' + JSON.stringify(r));
e = await err(C, `select public.bank_month_figures(current_date)`);
ok(REFUSED.test(e?.message || ''), 'a turned-off CPA gets no bank figures -> ' + e?.message);
ok(REFUSED.test((await err(C, `insert into public.seen_tips (user_id, tip_key) values ('${CPA}', 'x')`))?.message || ''), 'a turned-off CPA marks no tips');
await as(T, `select public.people_turn_on('cpa@example.org')`);
ok(Number(await one(C, `select count(*) from public.ledger`)) > 0 && Number(await one(C, `select count(*) from storage.objects`)) > 0 && await one(C, `select public.is_cpa()`) === true,
  'turned back on: the CPA reads again');
ok(REFUSED.test((await err(C, `select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 5, fund_id: 'F-GEN', source: 'Other' })]))?.message || ''),
  'turned back on, the CPA is still read only');

// The bookkeeper and an officer's direct expenses.
await as(T, `select public.people_turn_off('books@example.org', 'Contract paused')`);
ok(await one(K, `select public.can_file_direct()`) === false && REFUSED.test((await err(K, `select public.direct_expense_review(null)`))?.message || 'not allowed for your role'),
  'a turned-off bookkeeper cannot file or review');
await as(T, `select public.people_turn_on('books@example.org')`);
ok(await one(K, `select public.can_file_direct()`) === true, 'turned back on: the bookkeeper files again');
await as(T, `select public.people_set_files_direct('officer@example.org', false)`);
ok(await one(O, `select public.can_file_direct()`) === false, 'taking the direct-expense mark away stops an officer filing');
await as(T, `select public.people_set_files_direct('officer@example.org', true)`);
ok(await one(O, `select public.can_file_direct()`) === true, 'giving it back lets them file');
await as(T, `select public.people_turn_off('officer@example.org', 'Term over')`);
ok(await one(O, `select public.can_file_direct()`) === false, 'a turned-off officer cannot file even with the mark');
await as(T, `select public.people_turn_on('officer@example.org')`);

// Cancelling an invite with no login, and reopening it.
await as(T, `select public.people_invite_save('later@example.org', 'Later', 'board', false)`);
await as(T, `select public.people_turn_off('later@example.org', 'Typed the wrong email')`);
list = (await as(T, `select * from public.people_list() order by email`)).rows;
ok(by('later@example.org')?.status === 'off', 'a cancelled invite shows as off');
await as(T, `select public.people_turn_on('later@example.org')`);
list = (await as(T, `select * from public.people_list() order by email`)).rows;
ok(by('later@example.org')?.status === 'not_sent', 'a reopened invite waits for Resend Invite');
await as(T, `select public.people_set_role('later@example.org', 'cpa')`);
await as(T, `select public.people_turn_off('later@example.org', 'Not needed after all')`);
await db.exec(`insert into auth.users (id, email, invited_at) values ('${id('f5')}', 'later@example.org', now())`);
ok((await seat(id('f5')))?.role === 'board', 'a cancelled People invite gives nothing special (dashboard default)');

// ---------------------------------------------------------------- every function, as a turned-off seat

// Every function a signed-in role can run, called as a turned-off board member, bookkeeper and CPA, with real
// arguments (a real fund, request, locked month) and with nulls. Each must refuse or give nothing (null or empty).
// PURE: text helpers that read no table and only rework their own arguments. SELF: the caller's own sign-in facts.
const PURE = new Set(['log_action', 'log_area', 'log_money', 'log_summary', 'log_team_mask', 'log_team_mask_text', 'cpa_contact_col', 'cpa_mask_text', 'cpa_mask_json', 'pad_id']);
const SELF = { my_name: (v, c) => v === c.email, is_cpa_login: (v, c) => v === (c === C) };
await db.exec(`insert into public.bank_statements (month, locked_at) values ('2026-09-01', now()) on conflict (month) do update set locked_at = now()`);
const realReq = (await q(`select id from public.team_requests where archived_at is null order by id limit 1`))[0].id;
const realEvt = (await q(`insert into public.calendar_events (kind, title, date) values ('board', 'Sweep event', '2026-11-20') returning id`))[0].id;
const fnList = (await q(`select p.proname, p.oid::regprocedure::text sig, array(select format_type(t, null) from unnest(p.proargtypes) t) args
                           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
                            and has_function_privilege('authenticated', p.oid, 'execute') order by 1`));
const REAL = { text: (f, i) => (i === 0 && /request/.test(f.proname) ? `'${realReq}'` : i === 0 && /calendar/.test(f.proname) ? `'${realEvt}'` : `'F-GEN'`), numeric: () => '1000000', date: () => `'2026-09-15'`,
  jsonb: () => `'{}'`, boolean: () => 'false', bigint: () => '1', integer: () => '1', 'text[]': () => `'{}'` };
// Before: the money helpers answer a board member with access on (so the after checks mean something).
ok(Number(await one(B, `select public.fund_balance('F-GEN')`)) !== 0 && await one(B, `select public.month_locked('2026-09-15')`) === true
   && await one(B, `select public.approvals_needed(10)`) != null && (await one(B, `select public.spend_warnings('F-GEN', 1000000, null, null)`)).length > 0,
   'before: the money helpers answer a board member whose access is on');
for (const em of ['director@example.org', 'books@example.org', 'cpa@example.org']) await as(T, `select public.people_turn_off($1, 'Sweep')`, [em]);
let swept = 0;
for (const [claims, tag] of [[B, 'board'], [K, 'bookkeeper'], [C, 'CPA']]) {
  for (const f of fnList) {
    if (PURE.has(f.proname)) continue;
    for (const mode of ['real', 'null']) {
      const args = f.args.map((t, i) => (mode === 'null' ? `null::${t}` : `${(REAL[t] || (() => 'null'))(f, i)}::${t}`)).join(', ');
      const x = await err(claims, `select public.${f.proname}(${args})::text v`);
      let fine;
      if (x) fine = REFUSED.test(x.message) || /two-step|not allowed|Only the Treasurer|Board sign-in|Team sign-in/i.test(x.message)
        || (mode === 'null' && /not found/i.test(x.message)); // a null id finds nothing before any role check; the real id above is refused
      else {
        const v = (await as(claims, `select public.${f.proname}(${args})::text v`)).rows[0].v;
        fine = SELF[f.proname] ? SELF[f.proname](f.proname === 'is_cpa_login' ? v === 'true' : v, claims)
          : v === null || v === '' || v === '{}' || v === '[]' || v === 'false';
        if (!fine) x === null && console.log(`  ${tag} ${f.sig} (${mode}) answered: ${String(v).slice(0, 80)}`);
      }
      if (process.env.SWEEP_LOG) console.log(`SWEEP ${tag} ${f.sig} ${mode}: ${x ? x.message : "value"}`);
      ok(fine, `turned-off ${tag} gets nothing from ${f.sig} (${mode} arguments)${x ? ' -> ' + x.message : ''}`);
      swept++;
    }
  }
}
ok(swept > 400, `swept ${swept} function calls as turned-off seats`);
for (const em of ['director@example.org', 'books@example.org', 'cpa@example.org']) await as(T, `select public.people_turn_on($1)`, [em]);
ok(Number(await one(K, `select public.fund_balance('F-GEN')`)) !== 0 && await one(C, `select public.approvals_needed(10)`) != null,
   'turned back on: the money helpers answer again');
// Team logins have no portal seat: the helpers still answer inside the Team Portal.
const tp = await one(CO, `select public.team_portal()::text`);
ok(!!tp && tp.length > 20, 'a team login still gets its Team Portal (which uses approvals_needed and the fund helpers)');
ok(await one(T, `select public.fund_balance('F-GEN')`) != null && await one(T, `select public.my_name()`) === 'Sample Treasurer', 'the Treasurer still gets the helpers');
ok(!(await q(`select 1 from pg_proc where proname = 'access_off' and has_function_privilege('authenticated', oid, 'execute')`)).length, 'access_off() is internal');

// Two Treasurers at once: both functions lock every active treasurer seat before counting.
for (const fn of ['people_set_role', 'people_turn_off']) {
  const src = (await q(`select prosrc from pg_proc where proname = $1`, [fn]))[0].prosrc;
  const lockAt = src.search(/where a\.role = 'treasurer' and a\.archived_at is null order by a\.user_id for update/);
  ok(lockAt > 0 && lockAt < src.indexOf('people_target') && src.indexOf('require_role', lockAt) > lockAt,
    `${fn} locks the treasurer seats before counting, and re-checks the caller after the wait`);
}

// ---------------------------------------------------------------- roles and guards

await as(T, `select public.people_set_role('director@example.org', 'bookkeeper')`);
ok(await one(NOTE, `select public.my_role()`) === 'bookkeeper', 'a role change takes effect at once');
await as(T, `select public.people_set_role('director@example.org', 'board')`);
e = await err(T, `select public.people_set_role('director@example.org', 'owner')`);
ok(/Pick a role/.test(e?.message || ''), 'roles are limited to the four -> ' + e?.message);
e = await err(T, `select public.people_set_role('nobody@example.org', 'board')`);
ok(/No one with that email/.test(e?.message || ''), 'an unknown email is refused plainly');

e = await err(T, `select public.people_turn_off('treasurer@example.org', 'x')`);
ok(/cannot turn off your own/.test(e?.message || ''), 'the Treasurer cannot turn themselves off -> ' + e?.message);
e = await err(T, `select public.people_set_role('treasurer@example.org', 'board')`);
ok(/cannot change your own role/.test(e?.message || ''), 'the Treasurer cannot demote themselves -> ' + e?.message);

// A second treasurer can be made, changed and turned off; the last one never goes.
await db.exec(`insert into auth.users (id, email, invited_at, last_sign_in_at) values ('${T2}', 'treasurer2@example.org', now(), now())`);
await as(T, `select public.people_set_role('treasurer2@example.org', 'treasurer')`);
const TT = who(T2, 'treasurer2@example.org');
ok(await one(TT, `select public.is_treasurer()`) === true, 'a second Treasurer');
await as(TT, `select public.people_turn_off('treasurer@example.org', 'Handing over')`);
ok(await one(T, `select public.is_treasurer()`) === false, 'one Treasurer turns the other off');
ok(REFUSED.test((await err(T, `select * from public.people_list()`))?.message || ''), 'a turned-off Treasurer cannot use People');
e = await err(TT, `select public.people_turn_off('treasurer2@example.org', 'x')`);
ok(/cannot turn off your own/.test(e?.message || ''), 'the last Treasurer cannot turn themselves off');
e = await err(TT, `select public.people_set_role('treasurer2@example.org', 'board')`);
ok(/cannot change your own role/.test(e?.message || ''), 'the last Treasurer cannot demote themselves');
await as(TT, `select public.people_turn_on('treasurer@example.org')`);
await as(T, `select public.people_set_role('treasurer2@example.org', 'board')`);
ok(await one(TT, `select public.is_treasurer()`) === false, 'one Treasurer demotes the other');
// The last-treasurer check itself: with one treasurer on, taking that one away is refused whoever asks.
e = await db.query(`select public.people_keep_a_treasurer('${TREAS}')`).then(() => null, (x) => x);
ok(/always have a Treasurer/.test(e?.message || ''), 'taking away the only Treasurer is refused -> ' + e?.message);
await db.exec(`update public.portal_access set role = 'treasurer' where user_id = '${T2}'; update public.portal_access set archived_at = now() where user_id = '${T2}'`);
e = await db.query(`select public.people_keep_a_treasurer('${TREAS}')`).then(() => null, (x) => x);
ok(/always have a Treasurer/.test(e?.message || ''), 'a turned-off Treasurer does not count as the one who stays');
await db.exec(`update public.portal_access set role = 'board', archived_at = null where user_id = '${T2}'`);
ok(Number((await q(`select count(*) n from public.portal_access where role = 'treasurer' and archived_at is null`))[0].n) >= 1, 'a Treasurer is on at the end');

// ---------------------------------------------------------------- History

const log = await q(`select action, what, tbl, label, reason, who, role from public.change_log where what = 'People' order by id`);
const acts = new Set(log.map((x) => x.action));
for (const a of ['Invited', 'Invite Sent', 'Invite Failed', 'Turned Off', 'Turned On', 'Role Changed', 'Direct Expenses Changed', 'Invite Cancelled', 'Invite Reopened']) {
  ok(acts.has(a), `History records ${a}`);
}
const off = log.find((x) => x.action === 'Turned Off' && /Sample Director/.test(x.label));
ok(off && off.reason === 'Left the board' && off.who === 'Sample Treasurer' && off.role === 'treasurer', 'Turned Off carries the reason and who did it: ' + JSON.stringify(off));
ok(log.some((x) => x.action === 'Role Changed' && /Person · Sample Director · Bookkeeper/.test(x.label)), 'a role change is labelled with the person and new role');
ok(log.every((x) => x.tbl === 'portal_access' || x.tbl === 'people_invites'), 'People history comes from the seats and invites only');
ok(Number(await one(C, `select count(*) from public.change_log_cpa where tbl in ('portal_access','people_invites')`)) === 0, 'the CPA never sees People history');
ok(Number(await one(B, `select count(*) from public.change_log where what = 'People'`)) === log.length, 'the board reads People history in History');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
