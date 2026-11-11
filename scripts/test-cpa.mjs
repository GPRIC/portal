// P35, the CPA login: with two-step it reads everything financial (tables, totals, bank months, History, files) and is
// refused on every write. The write checks loop over every public table and every function the portal's signed-in
// role can run, so a table or function added later is covered without editing this file. Without two-step it reads nothing.
// Runs on its own: node scripts/test-cpa.mjs   (exits 1 when a check fails). Sample people only.
import { openDb } from './pg-stub.mjs';

const db = await openDb();

const TREAS = '00000000-0000-0000-0000-0000000000d1';
const CPA = '00000000-0000-0000-0000-0000000000d2';
const COACH = '00000000-0000-0000-0000-0000000000d3';

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
/** Runs sql as claims; returns the error (or null when it worked). Always rolled back when it fails. */
async function err(claims, sql, params = []) {
  try { await as(claims, sql, params); return null; } catch (e) { return e; }
}
const rows = async (claims, sql, params = []) => (await as(claims, sql, params)).rows;
const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const REFUSED = /not allowed for your role|two-step is required|read only|permission denied|row-level security|Team sign-in/i;

// ---------------------------------------------------------------- people and a little of everything (sample)

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Sample Coach', 'Coach');
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${CPA}', 'cpa@example.org', now()), ('${COACH}', 'coach@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';
  update public.portal_access set role = 'cpa', name = 'Sample CPA' where user_id = '${CPA}';
  update public.settings set general_fund_id = 'F-GEN';
`);
const T = { sub: TREAS, email: 'treasurer@example.org', aal: 'aal2', role: 'authenticated' };
const C = { sub: CPA, email: 'cpa@example.org', aal: 'aal2', role: 'authenticated' };
const C1 = { ...C, aal: 'aal1' };
const COACH_C = { sub: COACH, email: 'coach@example.org', aal: 'aal2', role: 'authenticated' };

// Records the CPA must not see, and a bank month and a money override it must.
await as(T, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'board', title: 'Board meeting', date: '2026-11-20' })]);
await as(T, `insert into public.problem_reports (notes) values ('Sample problem')`);
const stmt = await one(T, `select public.bank_statement_add('2026-10-01')`);
await as(T, `select public.bank_lines_add($1, $2)`, [stmt, JSON.stringify([{ date: '2026-10-03', description: 'Sample deposit', amount: 25 }])]);
await as(T, `select public.ledger_add($1)`, [JSON.stringify({ dir: 'out', amount: 999999, fund_id: 'F-GEN', category: 'Administration', party: 'Sample vendor', override: 'Sample override' })]);
await db.exec(`insert into storage.objects (bucket_id, name) values
  ('board-files', 'ledger/1-receipt.pdf'), ('board-files', 'statements/2026-10.pdf'), ('board-files', 'documents/1-bylaws.pdf'),
  ('board-files', 'team/T-9255/1-receipt.jpg'), ('board-files', 'problems/${TREAS}/1-shot.png')`);

// ---------------------------------------------------------------- role and two-step

ok(await one(C, `select public.my_role()`) === 'cpa', 'my_role is cpa with two-step');
ok(await one(C, `select public.is_board()`) === false, 'the CPA is not board (every require_board refuses it)');
ok(await one(C, `select public.can_read_books()`) === true, 'can_read_books with two-step');
ok(await one(C1, `select public.my_role()`) === null, 'no role without two-step');
ok(await one(C1, `select public.can_read_books()`) === false, 'cannot read the books without two-step');

// ---------------------------------------------------------------- reads (two-step)

const BOOKS = ['settings', 'teams', 'funds', 'board_members', 'grants', 'donors', 'donations', 'meetings', 'meeting_votes', 'team_requests',
  'ledger', 'receipts', 'accounts', 'documents', 'request_approvals', 'bank_statements', 'bank_lines', 'zeffy_skip', 'zeffy_sync_log',
  'request_refunds', 'receipt_reminders', 'money_overrides'];
// Tables with contact columns: the CPA reads them only through <table>_cpa, contact columns null.
const MASKED = ['board_members', 'donors', 'team_requests', 'accounts'];
for (const t of BOOKS) {
  const src = MASKED.includes(t) ? t + '_cpa' : t;
  const all = Number((await q(`select count(*) n from public.${t}`))[0].n);
  const seen = Number(await one(C, `select count(*) from public.${src}`));
  ok(seen === all, `CPA reads every row of ${t} through ${src} (${seen} of ${all})`);
  ok(Number(await one(C1, `select count(*) from public.${src}`)) === 0 || all === 0, `CPA without two-step reads nothing in ${src}`);
}

// ---------------------------------------------------------------- contact details: never the CPA's

const MAIL = 'member@example.test';
await db.exec(`
  insert into public.board_members (name, title, email) values ('Sample Member', 'Director', '${MAIL}');
  update public.team_requests set requestor_email = '${MAIL}', zelle_contact = '${MAIL}' where id = (select min(id) from public.team_requests);
  update public.donors set email = '${MAIL}' where id = (select min(id) from public.donors);
  update public.accounts set owner_email = '${MAIL}' where id = (select min(id) from public.accounts);
`);
const CONTACT = await q(`select table_name t, column_name c from information_schema.columns
                          where table_schema = 'public' and table_name = any($1) and public.cpa_contact_col(column_name)`, [MASKED]);
ok(CONTACT.length >= 5, 'contact columns found: ' + CONTACT.map((x) => x.t + '.' + x.c).join(', '));
for (const t of MASKED) {
  ok(Number(await one(C, `select count(*) from public.${t}`)) === 0, `a direct select of ${t} returns nothing for the CPA`);
  ok(Number(await one(T, `select count(*) from public.${t}_cpa`)) === 0, `${t}_cpa is the CPA's only (the Treasurer reads the table)`);
  ok(Number(await one(COACH_C, `select count(*) from public.${t}_cpa`)) === 0, `a team login reads nothing in ${t}_cpa`);
  const w = await err(C, `delete from public.${t}_cpa`);
  ok(!!w && REFUSED.test(w.message), `the CPA cannot write through ${t}_cpa: ${w?.message}`);
}
for (const { t, c } of CONTACT) {
  ok(Number(await one(C, `select count(*) from public.${t}_cpa where ${c} is not null`)) === 0, `${t}.${c} is null for the CPA`);
  ok(Number(await one(C, `select count(*) from public.${t}_cpa where ${c} = '${MAIL}'`)) === 0, `filtering ${t}_cpa on ${c} finds nothing for the CPA`);
}
ok(await one(C, `select name from public.board_members_cpa where name = 'Sample Member'`) === 'Sample Member', 'the CPA still reads board member names');
ok(await one(T, `select email from public.board_members where name = 'Sample Member'`) === MAIL, 'the Treasurer still reads board member emails');
ok(await one(T, `select requestor_email from public.team_requests where requestor_email = '${MAIL}'`) === MAIL, 'the Treasurer still reads requestor emails');
// Anywhere: every table and view in public, and every read function with no arguments, as the CPA.
const rels = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where n.nspname = 'public' and c.relkind in ('r','p','v','m') order by 1`);
let readable = 0;
for (const { relname } of rels) {
  const e = await err(C, `select 1 from public.${relname} limit 1`);
  if (e) continue;
  readable++;
  ok(Number(await one(C, `select count(*) from public.${relname} x where x::text ilike '%${MAIL}%'`)) === 0, `no board member email in ${relname} for the CPA`);
}
ok(readable >= 25, `the CPA reads ${readable} tables and views, none with a contact email`);
ok(Number(await one(C, `select count(*) from public.ledger`)) > 50, 'the ledger has rows to read');
ok(Number(await one(C, `select count(*) from public.money_overrides`)) >= 1, 'the CPA sees Treasurer overrides');
ok(Number(await one(C, `select count(*) from public.ledger_signed`)) === Number((await q(`select count(*) n from public.ledger`))[0].n), 'ledger_signed reads through');

const totals = await one(C, `select public.portal_totals()`);
ok(totals && Array.isArray(totals.funds) && totals.funds.length > 0, 'portal_totals for the CPA');
ok(JSON.stringify(totals) === JSON.stringify(await one(T, `select public.portal_totals()`)), 'the CPA sees the same totals as the Treasurer');
ok((await one(C, `select public.bank_month_figures('2026-10-01')`)).book != null, 'bank_month_figures for the CPA');
ok(typeof (await one(C, `select public.bank_month_difference($1, 0)`, [stmt])) !== 'undefined', 'bank_month_difference for the CPA');

// History: the books' log rows, nothing about team logins, the calendar, problem reports, sign-ins, board access or board members' details.
await db.exec(`insert into auth.sessions (id, user_id, aal) values ('00000000-0000-0000-0000-00000000aaaa', '${TREAS}', 'aal2')`);
await db.exec(`update public.portal_access set name = 'Sample CPA Two' where user_id = '${CPA}'`);
const logAll = Number((await q(`select count(*) n from public.change_log where tbl not in ('team_users','team_invites','calendar_events','problem_reports','sessions','seen_tips','portal_access','board_members')`))[0].n);
ok(Number(await one(C, `select count(*) from public.change_log_cpa`)) === logAll && logAll > 0, `History: the CPA reads the books' log (${logAll} rows)`);
ok(Number(await one(C, `select count(*) from public.change_log`)) === 0, 'the CPA reads History only through change_log_cpa');
ok(Number(await one(T, `select count(*) from public.change_log_cpa`)) === 0, 'change_log_cpa is the CPA only');
for (const t of ['calendar_events', 'problem_reports', 'team_invites', 'team_users', 'sessions', 'portal_access', 'board_members']) {
  ok(Number((await q(`select count(*) n from public.change_log where tbl = $1`, [t]))[0].n) > 0, `there is ${t} history to hide`);
  ok(Number(await one(C, `select count(*) from public.change_log_cpa where tbl = $1`, [t])) === 0, `History hides ${t} from the CPA`);
}
ok(Number((await q(`select count(*) n from public.change_log x where x::text ilike '%${MAIL}%'`))[0].n) > 0, 'the log holds contact emails to hide');
ok(Number(await one(C, `select count(*) from public.change_log_cpa x where x::text ilike '%${MAIL}%'`)) === 0, 'no board member email anywhere in the CPA History');
ok(Number(await one(C, `select count(*) from public.change_log_cpa x where x::text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'`)) === 0, 'no email address of anyone in the CPA History');
ok(Number(await one(C1, `select count(*) from public.change_log_cpa`)) === 0, 'no History without two-step');

// Not for the CPA.
for (const t of ['calendar_events', 'problem_reports', 'team_users', 'team_invites']) {
  ok(Number((await q(`select count(*) n from public.${t}`))[0].n) > 0, `there are ${t} rows to hide`);
  ok(Number(await one(C, `select count(*) from public.${t}`)) === 0, `the CPA does not see ${t}`);
}
ok(REFUSED.test((await err(C, `select public.team_portal()`))?.message || ''), 'no Team Portal for the CPA');

// Files: receipts, statements, documents and team receipts open; problem report files do not; nothing without two-step.
const files = (await rows(C, `select name from storage.objects order by name`)).map((r) => r.name);
ok(files.includes('ledger/1-receipt.pdf') && files.includes('statements/2026-10.pdf') && files.includes('documents/1-bylaws.pdf')
   && files.includes('team/T-9255/1-receipt.jpg'), 'the CPA opens receipt, statement, document and team receipt files: ' + files.join(', '));
ok(!files.some((f) => f.startsWith('problems/')), 'the CPA does not open problem report files');
ok((await rows(C1, `select name from storage.objects`)).length === 0, 'no files without two-step');

// ---------------------------------------------------------------- writes: every table

const tables = (await q(`select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relkind in ('r','p') order by 1`)).map((r) => r.t);
ok(tables.length >= 28, `found ${tables.length} public tables`);
const guarded = new Set((await q(`select c.relname t from pg_trigger g join pg_class c on c.oid = g.tgrelid
                                   where g.tgname like '%\\_cpa\\_read\\_only' and g.tgfoid = 'public.cpa_read_only()'::regprocedure`)).map((r) => r.t));
let tableChecks = 0;
for (const t of tables) {
  if (t === 'seen_tips') continue;   // the CPA's own first-visit tip marks (0012)
  ok(guarded.has(t), `${t} carries the CPA read-only trigger`);
  const col = (await q(`select a.attname from pg_attribute a where a.attrelid = ('public.' || $1)::regclass and a.attnum > 0 and not a.attisdropped
                        and a.attidentity = '' and a.attgenerated = '' order by a.attnum limit 1`, [t]))[0].attname;
  for (const claims of [C, C1]) {
    const tag = claims === C ? 'two-step' : 'no two-step';
    for (const [what, sql] of [
      ['insert', `insert into public.${t} default values`],
      ['update', `update public.${t} set "${col}" = "${col}"`],
      ['delete', `delete from public.${t}`],
      ['truncate', `truncate public.${t} cascade`],
    ]) {
      const e = await err(claims, sql);
      ok(!!e && REFUSED.test(e.message), `CPA (${tag}) ${what} on ${t} refused -> ${e ? e.message : 'no error'}`);
      tableChecks++;
    }
  }
}
// The trigger, not just the policies: a CPA write that row security would let through is still refused.
const viaTrigger = await err(C, `insert into public.problem_reports (notes) values ('From the CPA')`);
ok(/CPA login is read only/.test(viaTrigger?.message || ''), 'the CPA cannot file a problem report (read only everywhere): ' + viaTrigger?.message);
const tip = await err(C, `insert into public.seen_tips (user_id, tip_key) values ('${CPA}', 'ledger')`);
ok(tip === null, 'the CPA may mark its own first-visit tips seen');

// ---------------------------------------------------------------- writes: every function

// Functions the CPA may call: reads and checks that change nothing. Everything else signed-in users can run must refuse it.
const READS = new Set(['my_role', 'is_board', 'is_treasurer', 'is_cpa', 'is_cpa_login', 'can_read_books', 'my_name', 'my_member_id', 'my_team',
  'whoami', 'can_file_direct', 'approvals_needed', 'month_locked', 'fund_balance', 'fund_committed', 'portal_totals', 'bank_month_figures',
  'bank_month_difference', 'spend_warnings', 'request_fund', 'calendar_season_end', 'pad_id', 'require_role',
  // History's pure text helpers (immutable or stable, security invoker): they format, they never read or write a table
  'log_action', 'log_area', 'log_money', 'log_summary', 'log_team_mask', 'log_team_mask_text',
  // the CPA's contact masks (immutable, no table)
  'cpa_contact_col', 'cpa_mask_text', 'cpa_mask_json']);
const fns = await q(`select p.oid::regprocedure::text sig, p.proname, p.pronargs, p.provolatile,
                            array(select format_type(t, null) from unnest(p.proargtypes) t) args
                       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
                        and has_function_privilege('authenticated', p.oid, 'execute') order by 1`);
ok(fns.length >= 60, `found ${fns.length} functions the signed-in role can run`);
const nullCall = (f) => `select public.${f.proname}(${f.args.map((a) => `null::${a}`).join(', ')})`;
// A function that looks its record up before checking the role is called with a real record.
const event = (await q(`select id from public.calendar_events limit 1`))[0].id;
const CALLS = { calendar_archive: `select public.calendar_archive('${event}', 'x')` };
const missing = [...READS].filter((r) => !fns.some((f) => f.proname === r));
ok(!missing.length, 'every allowed read exists: ' + missing.join(', '));
let fnChecks = 0;
for (const f of fns.filter((x) => READS.has(x.proname) && x.pronargs === 0 && x.proname !== 'require_role')) {
  const v = await rows(C, `select public.${f.proname}()::text v`);
  ok(!String(v[0].v || '').toLowerCase().includes(MAIL), `${f.proname}() shows the CPA no board member email`);
}
for (const f of fns) {
  if (READS.has(f.proname)) {
    ok(f.provolatile !== 'v' || f.proname === 'require_role', `${f.proname} is an allowed read, so it is not volatile`);
    continue;
  }
  for (const claims of [C, C1]) {
    const e = await err(claims, CALLS[f.proname] || nullCall(f));
    ok(!!e && REFUSED.test(e.message), `CPA (${claims === C ? 'two-step' : 'no two-step'}) refused by ${f.sig} -> ${e ? e.message : 'no error'}`);
    fnChecks++;
  }
}
// The same calls with real arguments, for the main money actions (a null argument must not be what refuses them).
const req = (await q(`select id from public.team_requests where status = 'Approved' and archived_at is null limit 1`))[0]?.id;
const led = (await q(`select id from public.ledger where reverses_id is null and reversed_by_id is null and request_id is null and donation_id is null limit 1`))[0].id;
const real = [
  [`select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 10, fund_id: 'F-GEN', source: 'Other' })]],
  [`select public.ledger_reverse($1, 'x')`, [led]],
  [`select public.ledger_edit($1, '{"memo":"x"}')`, [led]],
  [`select public.log_donation(null, 'Sample Donor', 'Individual', 10, null, 'F-GEN', 'Zeffy', false, false, false)`, []],
  [`select public.approve_request($1)`, [req]],
  [`select public.mark_request_paid($1, null, 'Zelle')`, [req]],
  [`select public.request_refund($1, 1, null, 'Returned')`, [req]],
  [`select public.request_cancel($1, 'x')`, [req]],
  [`select public.lock_bank_month($1, 0)`, [stmt]],
  [`select public.bank_statement_set($1, '{"notes":"x"}')`, [stmt]],
  [`select public.archive_record('accounts', (select id from public.accounts limit 1), 'x')`, []],
  [`select public.rollback_change((select max(id) from public.change_log), 'x')`, []],
  [`select public.clear_sample_data()`, []],
  [`select public.settings_save_rules(500, 1, 2)`, []],
];
for (const [sql, params] of real) {
  const e = await err(C, sql, params);
  ok(!!e && REFUSED.test(e.message), `CPA refused with real arguments: ${sql.slice(14, 60)} -> ${e ? e.message : 'no error'}`);
}

// Files: the CPA uploads, changes and removes nothing, even in its own problems folder.
for (const [what, sql] of [
  ['upload a receipt', `insert into storage.objects (bucket_id, name) values ('board-files', 'ledger/2-cpa.pdf')`],
  ['upload into its own problems folder', `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${CPA}/1.png')`],
]) {
  for (const claims of [C, C1]) {
    const e = await err(claims, sql);
    ok(!!e && REFUSED.test(e.message), `CPA cannot ${what} -> ${e ? e.message : 'no error'}`);
  }
}
for (const sql of [`update storage.objects set name = name || '.x' where name like 'ledger/%'`, `delete from storage.objects`]) {
  await err(C, sql);
}
ok(Number((await q(`select count(*) n from storage.objects`))[0].n) === 5 && (await q(`select 1 from storage.objects where name = 'ledger/1-receipt.pdf'`)).length === 1,
  'no file changed or removed by the CPA');

// ---------------------------------------------------------------- the board still works

const before = Number((await q(`select count(*) n from public.ledger`))[0].n);
await as(T, `select public.ledger_add($1)`, [JSON.stringify({ dir: 'in', amount: 12.5, fund_id: 'F-GEN', source: 'Other' })]);
ok(Number((await q(`select count(*) n from public.ledger`))[0].n) === before + 1, 'the Treasurer still writes (the read-only trigger is the CPA\'s alone)');
ok((await err(T, `insert into storage.objects (bucket_id, name) values ('board-files', 'ledger/3-treasurer.pdf')`)) === null, 'the Treasurer still uploads');
ok((await err(COACH_C, `insert into storage.objects (bucket_id, name) values ('board-files', 'team/T-9255/2-coach.jpg')`)) === null, 'a coach still uploads to the team folder');

console.log(`\n${passed} passed, ${failed} failed (${tableChecks} table writes, ${fnChecks} function calls refused)`);
process.exit(failed ? 1 : 0);
