// P37 Report A Problem: anyone signed in sends a report with the page, time and person filled by the database;
// only the Treasurer reads reports and changes their status; reports are never deleted; report files are the Treasurer's.
// Usage: node scripts/test-problems.mjs        (exits 1 if any check fails)
import { openDb } from './pg-stub.mjs';

const db = await openDb();
let failed = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed++; };

async function as(claims, sql, params = [], headers) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`,
      [JSON.stringify(claims), headers ? JSON.stringify(headers) : '']);
    await tx.exec(`set local role authenticated`);
    return tx.query(sql, params);
  });
}
async function fails(claims, sql, params, match, label) {
  try { await as(claims, sql, params); ok(false, label + ' (no error)'); }
  catch (e) { ok(match.test(e.message), label + ' -> ' + e.message); }
}

const TRE = '00000000-0000-0000-0000-0000000000a1';
const BRD = '00000000-0000-0000-0000-0000000000a2';
const COACH = '00000000-0000-0000-0000-0000000000a3';
const MATE = '00000000-0000-0000-0000-0000000000a4';
const person = (sub, email) => ({ sub, email, aal: 'aal2', role: 'authenticated' });
const T = person(TRE, 'treasurer@example.org');
const B = person(BRD, 'director@example.org');
const C = person(COACH, 'coach@example.org');
const M = person(MATE, 'mate@example.org');

await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Casey Coach', 'Coach'),
    ('T-9255', 'mate@example.org', 'Morgan Mate', 'Treasurer');
  insert into auth.users (id, email, invited_at) values
    ('${TRE}', 'treasurer@example.org', now()), ('${BRD}', 'director@example.org', now()), ('${COACH}', 'coach@example.org', now()), ('${MATE}', 'mate@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Terry Treasurer' where user_id = '${TRE}';
  update public.portal_access set role = 'board', name = 'Dana Director' where user_id = '${BRD}';
`);

// Any signed-in person sends a report; the database fills the person, time, device and (from the Referer) the page.
const before = Date.now();
await as(B, `insert into public.problem_reports (notes) values ('Ledger total looks wrong')`, [],
  { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131', referer: 'https://portal.example.org/ledger?fund=F-GEN' });
let r = (await db.query(`select * from public.problem_reports where user_id = $1`, [BRD])).rows[0];
ok(!!r && r.who === 'Dana Director' && r.role === 'board', 'a board member sends a report; person filled by the database: ' + r?.who);
ok(r && r.page === '/ledger?fund=F-GEN', 'the page comes from the Referer when the browser sends none: ' + r?.page);
ok(r && Math.abs(new Date(r.created_at).getTime() - before) < 60000 && r.status === 'New' && /Chrome/.test(r.device), 'time, status New and device filled');
ok(r && /^PR-\d+/.test(r.id), 'report id: ' + r?.id);

// A team login sends one too, and cannot pose as someone else or pick a time or status.
await as(C, `insert into public.problem_reports (page, page_title, device, notes, screenshot_path)
             values ('/team', 'Team Portal', 'Chrome on Chromebook · 1366×768', 'Upload spins', 'problems/${COACH}/1-snip.png')`);
r = (await db.query(`select * from public.problem_reports where user_id = $1`, [COACH])).rows[0];
ok(!!r && r.role === 'team' && r.team_id === 'T-9255' && r.page === '/team' && r.device === 'Chrome on Chromebook · 1366×768', 'a team login sends a report with its team');
await fails(C, `insert into public.problem_reports (notes, user_id) values ('x', '${BRD}')`, [], /permission denied/, 'nobody sets the person');
await fails(C, `insert into public.problem_reports (notes, created_at) values ('x', now() - interval '1 day')`, [], /permission denied/, 'nobody sets the time');
await fails(C, `insert into public.problem_reports (notes, status) values ('x', 'Fixed')`, [], /permission denied/, 'nobody sets the status');
await fails(C, `insert into public.problem_reports (notes, screenshot_path) values ('x', 'problems/${BRD}/a.png')`, [], /own uploads/, 'a report cannot point at someone else\'s file');
await fails(C, `insert into public.problem_reports (notes) values ('   ')`, [], /problem_reports_something/, 'an empty report is refused');
await fails({ role: 'authenticated' }, `insert into public.problem_reports (notes) values ('x')`, [], /Sign in/, 'signed out cannot report');

// Only the Treasurer reads reports.
const n = async (claims) => (await as(claims, `select count(*)::int n from public.problem_reports`)).rows[0].n;
ok((await n(B)) === 0, 'a board member cannot read reports, not even their own');
ok((await n(C)) === 0, 'a team login cannot read reports');
ok((await n(T)) === 2, 'the Treasurer reads every report');
ok((await as(B, `select count(*)::int n from public.change_log where tbl = 'problem_reports'`)).rows[0].n === 0, 'the board cannot read reports through the action log');
ok((await as(T, `select count(*)::int n from public.change_log where tbl = 'problem_reports'`)).rows[0].n === 2, 'the Treasurer sees reports in the action log');
ok((await as(B, `select count(*)::int n from public.change_log`)).rows[0].n > 0, 'the board still reads the rest of the action log');

// A teammate on the same team never sees another login's report through the team's history view.
ok((await db.query(`select team_id from public.team_users where user_id = $1`, [MATE])).rows[0]?.team_id === 'T-9255', 'a second login on the same team');
ok((await db.query(`select count(*)::int n from public.change_log where tbl = 'problem_reports' and team_id is not null`)).rows[0].n === 0, 'problem report log rows carry no team');
ok((await as(M, `select count(*)::int n from public.change_log_team where tbl = 'problem_reports'`)).rows[0].n === 0, 'a teammate gets 0 problem report rows from change_log_team');
ok((await as(C, `select count(*)::int n from public.change_log_team where tbl = 'problem_reports'`)).rows[0].n === 0, 'the reporter gets none from change_log_team either');
ok((await as(M, `select count(*)::int n from public.change_log_team`)).rows[0].n > 0, 'the team history still shows the team its other changes');

// Only the Treasurer changes the status and reply; nothing else moves.
const id = (await db.query(`select id from public.problem_reports where user_id = $1`, [COACH])).rows[0].id;
await as(B, `update public.problem_reports set status = 'Fixed' where id = $1`, [id]);
ok((await db.query(`select status from public.problem_reports where id = $1`, [id])).rows[0].status === 'New', 'a board member cannot change a status');
await as(T, `update public.problem_reports set status = 'Looking', reply = 'Reproduced on a Chromebook' where id = $1`, [id]);
r = (await db.query(`select * from public.problem_reports where id = $1`, [id])).rows[0];
ok(r.status === 'Looking' && r.reply === 'Reproduced on a Chromebook' && r.updated_by === 'Terry Treasurer', 'the Treasurer changes the status and reply');
await as(T, `update public.problem_reports set status = 'Won''t Fix' where id = $1`, [id]);
ok((await db.query(`select status from public.problem_reports where id = $1`, [id])).rows[0].status === "Won't Fix", 'Won\'t Fix is a status');
await fails(T, `update public.problem_reports set status = 'Closed' where id = $1`, [id], /check constraint/, 'only the four statuses');
await fails(T, `update public.problem_reports set notes = 'edited' where id = $1`, [id], /permission denied/, 'the reporter\'s notes cannot be edited');
const log = (await db.query(`select action, user_id from public.change_log where tbl = 'problem_reports' and record_id = $1 order by id`, [id])).rows;
ok(log.length === 3 && log[0].action === 'Added' && log[1].action === 'Changed' && log[1].user_id === TRE, 'adds and status changes are logged');

// Never deleted.
await fails(T, `delete from public.problem_reports where id = $1`, [id], /permission denied/, 'the Treasurer cannot delete a report');
try { await db.exec(`delete from public.problem_reports`); ok(false, 'even the owner cannot delete reports (no error)'); }
catch (e) { ok(/never deleted/.test(e.message), 'even the owner cannot delete reports'); }

// Files: anyone uploads into their own folder; only the Treasurer opens report files; nobody overwrites or removes them.
await as(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${COACH}/1-snip.png')`);
await fails(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${BRD}/x.png')`, [], /row-level security/, 'nobody uploads into someone else\'s folder');
await as(B, `insert into storage.objects (bucket_id, name) values ('board-files', 'documents/board/minutes.pdf')`);
await fails(B, `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${COACH}/fake.png')`, [], /row-level security/, 'a board member cannot upload into another person\'s problems folder');
await fails(T, `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${BRD}/fake.png')`, [], /row-level security/, 'nor can the Treasurer');
await fails(B, `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/loose.png')`, [], /row-level security/, 'nobody uploads loose into problems/');
await fails(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'documents/x.pdf')`, [], /row-level security/, 'a team login still cannot upload outside its own folders');
await as(B, `insert into storage.objects (bucket_id, name) values ('board-files', 'problems/${BRD}/own.png')`);
await as(C, `insert into storage.objects (bucket_id, name) values ('board-files', 'team/T-9255/receipt.png')`);
await as(B, `insert into storage.objects (bucket_id, name) values ('board-files', 'receipts/R-1/receipt.png')`);
ok((await db.query(`select count(*)::int n from storage.objects where name in ('problems/${BRD}/own.png', 'team/T-9255/receipt.png', 'receipts/R-1/receipt.png')`)).rows[0].n === 3,
  'own problems folder, team folder and other board paths still take uploads');
const files = async (claims, like) => (await as(claims, `select count(*)::int n from storage.objects where name like $1`, [like])).rows[0].n;
ok((await files(T, 'problems/%')) === 2, 'the Treasurer opens report files');
ok((await files(B, 'problems/%')) === 0, 'a board member cannot open report files');
ok((await files(C, 'problems/%')) === 0, 'a team login cannot open report files, even its own');
ok((await files(B, 'documents/%')) === 1, 'the board still opens its other files');
await as(T, `update storage.objects set name = 'problems/x.png' where name like 'problems/%'`);
await as(T, `delete from storage.objects where name like 'problems/%'`);
ok((await db.query(`select count(*)::int n from storage.objects where name like 'problems/%'`)).rows[0].n === 2, 'report files cannot be changed or removed');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
