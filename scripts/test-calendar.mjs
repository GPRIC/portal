// P36 calendar: officers add any kind of event, a coach adds only their own team's schedule, a weekly repeat
// expands week by week to the season end, a coach never reads a board meeting (row security), and another team's
// coach cannot change or archive a team's events.
// Usage: node scripts/test-calendar.mjs        (exits 1 if any check fails)
import { openDb } from './pg-stub.mjs';

const db = await openDb();

const TREAS = '00000000-0000-0000-0000-0000000000b1';
const BOARD = '00000000-0000-0000-0000-0000000000b2';
const COACH = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000c2';
const NOBODY = '00000000-0000-0000-0000-0000000000d1';

let failed = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed++; };
async function as(claims, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role authenticated`);
    return tx.query(sql, params);
  });
}
async function fails(claims, sql, params, match, label) {
  try { await as(claims, sql, params); ok(false, label + ' (no error)'); }
  catch (e) { ok(match.test(e.message), label + ' -> ' + e.message); }
}
const user = (sub, email, aal = 'aal2') => ({ sub, email, aal, role: 'authenticated' });
const save = async (who, p) => (await as(who, `select public.calendar_save($1) ids`, [JSON.stringify(p)])).rows[0].ids;

const otherTeam = (await db.query(`select id from public.teams where id <> 'T-9255' order by id limit 1`)).rows[0].id;
await db.exec(`
  insert into public.team_invites (team_id, email, name, role) values ('T-9255', 'coach@example.org', 'Casey Coach', 'Coach');
  insert into public.team_invites (team_id, email, name, role) values ('${otherTeam}', 'other@example.org', 'Olive Other', 'Coach');
  insert into auth.users (id, email, invited_at) values
    ('${TREAS}', 'treasurer@example.org', now()), ('${BOARD}', 'director@example.org', now()),
    ('${COACH}', 'coach@example.org', now()), ('${OTHER}', 'other@example.org', now());
  update public.portal_access set role = 'treasurer' where user_id = '${TREAS}';
`);
const T = user(TREAS, 'treasurer@example.org');
const B = user(BOARD, 'director@example.org');
const C = user(COACH, 'coach@example.org');
const O = user(OTHER, 'other@example.org');
const C1 = user(COACH, 'coach@example.org', 'aal1');
const N = user(NOBODY, 'nobody@example.org');

// Officers add any kind.
const [meet] = await save(B, { kind: 'board', title: 'Monthly Board Meeting', date: '2026-11-12', start_time: '19:00', end_time: '20:30', location: 'Board Room' });
const [comm] = await save(T, { kind: 'community', title: 'Open House', date: '2026-11-14', start_time: '10:00', end_time: '14:00' });
const [prac] = await save(B, { kind: 'team', team_id: 'T-9255', type: 'Practice', date: '2026-11-10', start_time: '16:00', end_time: '18:00' });
const [othr] = await save(B, { kind: 'team', team_id: otherTeam, type: 'Scrimmage', title: 'League Scrimmage', date: '2026-11-22' });
ok(meet && comm && prac && othr, 'an officer adds a board meeting, a community event and team events for any team');
const pr = (await db.query(`select * from public.calendar_events where id = $1`, [prac])).rows[0];
ok(pr.title === 'Practice' && pr.added_by && pr.added_by_user === BOARD, 'a blank title becomes the type, and who added it is kept');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'team', type: 'Practice', date: '2026-11-10' })], /Pick the team/, 'a team event needs a team');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'board', date: '2026-11-10', start_time: '18:00', end_time: '17:00' })], /end time/, 'the end time must follow the start');

// A coach adds only their own team's schedule.
const [mine] = await save(C, { kind: 'team', type: 'Competition', title: 'League Meet', date: '2026-12-13', start_time: '08:00', end_time: '17:00' });
ok((await db.query(`select team_id from public.calendar_events where id = $1`, [mine])).rows[0].team_id === 'T-9255', 'a coach adds an event for their own team');
await fails(C, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'board', title: 'Sneaky', date: '2026-11-20' })], /own team/, 'a coach cannot add a board meeting');
await fails(C, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'community', title: 'Bake Sale', date: '2026-11-20' })], /own team/, 'a coach cannot add a community event');
await fails(C, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'team', team_id: otherTeam, type: 'Practice', date: '2026-11-20' })], /own team/, 'a coach cannot add another team\'s schedule');
await fails(C1, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'team', type: 'Practice', date: '2026-11-20' })], /not allowed/, 'a coach without two-step adds nothing');
await fails(N, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'community', date: '2026-11-20' })], /not allowed/, 'someone with no portal access adds nothing');
await fails(C, `insert into public.calendar_events (kind, title, date) values ('board', 'x', '2026-11-20')`, [], /permission denied/, 'no direct inserts');
await fails(B, `update public.calendar_events set title = 'x' where id = '${meet}'`, [], /permission denied/, 'no direct updates, even for officers');

// Weekly repeat.
const weekly = await save(C, { kind: 'team', type: 'Practice', date: '2026-11-17', start_time: '16:00', end_time: '18:00', location: 'Bay 2', repeat: 'weekly', until: '2026-12-15' });
const wk = (await db.query(`select date::text d, series_id, start_time::text s from public.calendar_events where id = any($1) order by date`, [weekly])).rows;
ok(wk.length === 5 && wk.map((r) => r.d).join() === '2026-11-17,2026-11-24,2026-12-01,2026-12-08,2026-12-15', 'weekly until a date adds one event each week, both ends included: ' + wk.map((r) => r.d).join(' '));
ok(new Set(wk.map((r) => r.series_id)).size === 1 && wk[0].series_id && wk.every((r) => r.s === '16:00:00'), 'the weeks share one series and the same times');
const season = await save(B, { kind: 'team', team_id: 'T-9255', type: 'Practice', date: '2026-11-19', repeat: 'weekly' });
const last = (await db.query(`select max(date)::text d, min(date)::text f from public.calendar_events where id = any($1)`, [season])).rows[0];
ok(season.length === 32 && last.f === '2026-11-19' && last.d === '2027-06-24', `weekly until season end stops at the fiscal year end (${season.length} weeks, last ${last.d})`);
ok((await db.query(`select public.calendar_season_end('2026-03-01') d`)).rows[0].d.toISOString().slice(0, 10) === '2026-06-30', 'season end before July is the June 30 of that year');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ kind: 'community', date: '2026-01-01', repeat: 'weekly', until: '2028-01-01' })], /at most 60/, 'a repeat is capped at 60 weeks');
// Moving one week leaves the rest.
await save(C, { id: weekly[1], kind: 'team', type: 'Practice', date: '2026-11-25', start_time: '16:00', end_time: '18:00' });
ok((await db.query(`select count(*)::int n from public.calendar_events where id = any($1) and date in ('2026-11-17','2026-12-01')`, [weekly])).rows[0].n === 2, 'moving one week leaves the others in place');

// Read access: a coach never sees a board meeting or another team.
const seen = (await as(C, `select id, kind, team_id from public.calendar_events`)).rows;
ok(seen.length > 0 && !seen.some((r) => r.kind === 'board'), `a coach reads no board meetings (${seen.length} events visible)`);
ok(!seen.some((r) => r.id === meet), 'the board meeting by id is invisible to the coach');
ok((await as(C, `select count(*)::int n from public.calendar_events where id = $1`, [meet])).rows[0].n === 0, 'even asking for it directly returns nothing');
ok(seen.some((r) => r.id === comm), 'a coach sees community events');
ok(!seen.some((r) => r.kind === 'team' && r.team_id !== 'T-9255'), 'a coach sees no other team\'s schedule');
ok(seen.some((r) => r.id === prac), 'a coach sees their own team\'s schedule, including what an officer added');
ok((await as(C1, `select count(*)::int n from public.calendar_events`)).rows[0].n === 0, 'a coach without two-step reads nothing');
ok((await as(N, `select count(*)::int n from public.calendar_events`)).rows[0].n === 0, 'someone with no portal access reads nothing');
const all = (await db.query(`select count(*)::int n from public.calendar_events`)).rows[0].n;
ok((await as(B, `select count(*)::int n from public.calendar_events`)).rows[0].n === all, 'officers read every event');
// Board meetings stay out of a team's own History.
ok((await as(C, `select count(*)::int n from public.change_log_team where tbl = 'calendar_events' and record_id = $1`, [meet])).rows[0].n === 0,
  'a board meeting never appears in a team\'s History');
ok((await as(C, `select count(*)::int n from public.change_log_team where tbl = 'calendar_events' and record_id = $1`, [mine])).rows[0].n > 0,
  'the team\'s own events do');

// Another team's coach cannot edit or archive.
await fails(O, `select public.calendar_save($1)`, [JSON.stringify({ id: mine, kind: 'team', type: 'Practice', date: '2026-12-14' })], /own team/, 'another team\'s coach cannot change a team\'s event');
await fails(O, `select public.calendar_save($1)`, [JSON.stringify({ id: mine, kind: 'team', team_id: otherTeam, type: 'Practice', date: '2026-12-14' })], /own team/, 'nor take it over for their own team');
await fails(O, `select public.calendar_archive($1)`, [mine], /own team/, 'another team\'s coach cannot archive it');
await fails(C, `select public.calendar_save($1)`, [JSON.stringify({ id: comm, kind: 'team', type: 'Practice', date: '2026-11-14' })], /own team/, 'a coach cannot turn a community event into their own');
await fails(C, `select public.calendar_archive($1)`, [comm], /own team/, 'a coach cannot archive a community event');
await fails(C, `select public.calendar_save($1)`, [JSON.stringify({ id: mine, kind: 'board', date: '2026-12-13' })], /own team/, 'a coach cannot turn their event into a board meeting');
ok((await db.query(`select date::text d from public.calendar_events where id = $1`, [mine])).rows[0].d === '2026-12-13', 'the event is unchanged');

// An event never changes kind or team, so its history never reaches another team.
const [secret] = await save(B, { kind: 'board', title: 'Secret Exec Session', notes: 'Personnel matter', date: '2026-11-26' });
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ id: secret, kind: 'team', team_id: 'T-9255', type: 'Practice', date: '2026-11-26' })],
  /cannot change.*Archive it and add a new one/, 'an officer cannot turn a board meeting into a team event');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ id: secret, kind: 'community', title: 'Secret Exec Session', date: '2026-11-26' })],
  /cannot change/, 'nor into a community event');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ id: prac, kind: 'team', team_id: otherTeam, type: 'Practice', date: '2026-11-10' })],
  /cannot change.*Archive it and add a new one/, 'an officer cannot move an event from one team to another');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ id: prac, kind: 'board', date: '2026-11-10' })], /cannot change/, 'nor turn a team event into a board meeting');
try { await db.exec(`update public.calendar_events set kind = 'team', team_id = 'T-9255', type = 'Practice' where id = '${secret}'`); ok(false, "even the owner cannot change an event's kind or team (no error)"); }
catch (x) { ok(/cannot change/.test(x.message), "even the owner cannot change an event's kind or team"); }
try { await db.exec(`update public.calendar_events set team_id = '${otherTeam}' where id = '${prac}'`); ok(false, 'even the owner cannot move an event between teams (no error)'); }
catch (x) { ok(/cannot change/.test(x.message), 'even the owner cannot move an event between teams'); }
ok((await db.query(`select kind, team_id from public.calendar_events where id = $1`, [secret])).rows[0].kind === 'board' &&
   (await db.query(`select team_id from public.calendar_events where id = $1`, [prac])).rows[0].team_id === 'T-9255', 'both events are unchanged');
const leakC = (await as(C, `select count(*)::int n from public.change_log_team where tbl = 'calendar_events'
  and (record_id = $1 or coalesce(before ->> 'title', '') = 'Secret Exec Session' or coalesce(after ->> 'title', '') = 'Secret Exec Session')`, [secret])).rows[0].n;
ok(leakC === 0, "the board meeting's details never reach the coach's History");
const leakO = (await as(O, `select count(*)::int n from public.change_log_team where tbl = 'calendar_events' and (record_id = $1
  or coalesce(before ->> 'team_id', '') = 'T-9255' or coalesce(after ->> 'team_id', '') = 'T-9255')`, [prac])).rows[0].n;
ok(leakO === 0, "one team's event details never reach another team's History");
ok((await db.query(`select count(*)::int n from public.change_log where tbl = 'calendar_events' and team_id is not null
  and (coalesce(before ->> 'team_id', after ->> 'team_id') is distinct from team_id or coalesce(after ->> 'team_id', before ->> 'team_id') is distinct from team_id)`)).rows[0].n === 0,
  'every calendar log row is filed under the same team before and after');
// Ordinary edits still work and keep the team.
await save(B, { id: prac, kind: 'team', team_id: 'T-9255', type: 'Scrimmage', title: 'Scrimmage', date: '2026-11-10' });
ok((await db.query(`select type from public.calendar_events where id = $1`, [prac])).rows[0].type === 'Scrimmage', 'changing the type, title or date still works');

// Archive, never delete; logged.
await as(C, `select public.calendar_archive($1, 'Cancelled')`, [mine]);
const arc = (await db.query(`select archived_at, archived_by, archive_reason from public.calendar_events where id = $1`, [mine])).rows[0];
ok(arc.archived_at && arc.archive_reason === 'Cancelled', 'a coach archives their own event with a reason');
ok((await as(C, `select count(*)::int n from public.calendar_events where id = $1`, [mine])).rows[0].n === 0, 'an archived event leaves the coach\'s calendar');
await as(B, `select public.calendar_archive($1)`, [othr]);
ok(true, 'an officer archives any team\'s event');
await fails(B, `select public.calendar_save($1)`, [JSON.stringify({ id: othr, kind: 'community', date: '2026-11-22' })], /archived/, 'an archived event cannot be changed');
try { await db.exec(`delete from public.calendar_events where id = '${meet}'`); ok(false, 'even the owner cannot delete an event (no error)'); }
catch (x) { ok(/archived, never deleted/.test(x.message), 'even the owner cannot delete an event'); }
const log = (await db.query(`select action, who from public.change_log where tbl = 'calendar_events' and record_id = $1 order by id`, [mine])).rows;
ok(log.map((r) => r.action).join() === 'Added,Archived', 'adds and archives are in the change log: ' + log.map((r) => r.action).join(', '));
// 0010: History files events under Calendar, named by title and date, and problem reports under Problems by page
const area = (await db.query(`select what, label from public.change_log where tbl = 'calendar_events' and record_id = $1 order by id limit 1`, [mine])).rows[0];
ok(area.what === 'Calendar' && /^Event · .+ · [A-Z][a-z]{2} \d{1,2}, \d{4}/.test(area.label), 'History names a calendar event: ' + area.what + ' / ' + area.label);
const prl = (await db.query(`select public.log_area('problem_reports') a, public.log_label('problem_reports', '{"page":"/ledger","page_title":"Ledger","notes":"secret"}'::jsonb) l`)).rows[0];
ok(prl.a === 'Problems' && prl.l === 'Problem report · Ledger', 'History names a problem report by its page only: ' + prl.a + ' / ' + prl.l);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
