// P36 (0022): backup runs report with the service key; the daily check stays quiet until backups start, then emails
// the Treasurer once when a run fails or none succeeded in 36 hours. Runs on its own: node scripts/test-backups.mjs
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
const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const TREAS = '00000000-0000-0000-0000-0000000000f1';
await db.exec(`insert into auth.users (id, email, invited_at) values ('${TREAS}', 'treasurer@example.org', now());
  update public.portal_access set role = 'treasurer', name = 'Sample Treasurer' where user_id = '${TREAS}';`);
const svc = { role: 'service_role' };
const T = { sub: TREAS, email: 'treasurer@example.org', aal: 'aal2', role: 'authenticated' };
const mails = async () => (await q(`select count(*)::int n from public.email_outbox where kind = 'backup_alert'`))[0].n;

ok((await one(svc, `select public.backup_overdue_check()`)) === 'not started', 'quiet before the first backup');
try { await as(T, `select public.backup_report('{"ok":true}')`); ok(false, 'a signed-in user cannot file a report'); }
catch (e) { ok(/permission denied/.test(e.message), 'a signed-in user cannot file a report'); }
await as(svc, `select public.backup_report($1)`, [JSON.stringify({ ok: true, started_at: new Date().toISOString(), db_bytes: 10, files_count: 2 })]);
ok((await one(svc, `select public.backup_overdue_check()`)) === 'ok' && (await mails()) === 0, 'a good run last night: no email');
await as(svc, `select public.backup_report($1)`, [JSON.stringify({ ok: false, error: 'pg_dump exited 1' })]);
ok((await one(svc, `select public.backup_overdue_check()`)) === 'alerted' && (await mails()) === 1, 'a failed run emails the Treasurer');
const m = (await q(`select to_emails, body_text from public.email_outbox where kind = 'backup_alert'`))[0];
ok(m.to_emails[0] === 'treasurer@example.org' && /pg_dump exited 1/.test(m.body_text), 'the email says why');
ok((await one(svc, `select public.backup_overdue_check()`)) === 'already alerted' && (await mails()) === 1, 'at most one email a day');
await db.exec(`update public.backup_runs set finished_at = now() - interval '3 days', alerted_at = now() - interval '2 days'`);
ok((await one(svc, `select public.backup_overdue_check()`)) === 'alerted' && (await mails()) === 2, 'no run for 36 hours emails again');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
