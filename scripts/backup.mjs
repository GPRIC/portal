// P36 nightly backup of the GPRIC portal (0022_backups.sql). Run it once a night wherever the copies are kept:
//   node --env-file=.env.local scripts/backup.mjs
// It needs, in the environment (never in this repository):
//   SUPABASE_DB_URL            the database connection string (Supabase > Connect > Session pooler), with its password
//   NEXT_PUBLIC_SUPABASE_URL   the project URL
//   SUPABASE_SERVICE_ROLE_KEY  the service key (reads every stored file, files the run's report)
//   BACKUP_DIR                 where the copies go (a synced or mounted folder of the chosen backup home)
//   PG_DUMP                    optional: the full path of pg_dump (PostgreSQL 15 or newer) when it is not on the PATH
// What it keeps:
//   BACKUP_DIR/db/gpric-YYYY-MM-DD.dump   the whole database (public, auth and storage schemas; pg_restore format),
//                                          one a night, the last 30 days kept
//   BACKUP_DIR/files/<bucket>/<path>       every stored file (receipts, statements, documents). Files are never changed
//                                          once stored, so only new ones are copied; nothing here is ever removed.
//   BACKUP_DIR/last-run.json               this run's report, also sent to the portal (backup_runs)
// A failed run is reported too; the portal's daily cron emails the Treasurer when a run fails or none ran for 36 hours.
// Restore: pg_restore --clean --if-exists --no-owner -d <scratch database URL> BACKUP_DIR/db/gpric-<date>.dump
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const KEEP_DAYS = 30;
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(k + ' is not set'); return v; };
const started = new Date();
const report = { started_at: started.toISOString(), ok: false, host: hostname(), kept_at: process.env.BACKUP_DIR || null };
let sb = null;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code + ': ' + err.trim().slice(-500)))));
  });
}

async function dumpDatabase(dir) {
  await mkdir(path.join(dir, 'db'), { recursive: true });
  const day = started.toISOString().slice(0, 10);
  const file = path.join(dir, 'db', `gpric-${day}.dump`);
  const part = file + '.part';
  await run(process.env.PG_DUMP || 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--schema=public', '--schema=auth', '--schema=storage',
    '--file=' + part, env('SUPABASE_DB_URL')]);
  await rm(file, { force: true });
  await rename(part, file);
  report.db_bytes = (await stat(file)).size;
  // keep the last 30 nights
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const f of await readdir(path.join(dir, 'db'))) {
    const m = /^gpric-(\d{4}-\d{2}-\d{2})\.dump$/.exec(f);
    if (m && Date.parse(m[1] + 'T00:00:00Z') < cutoff) await rm(path.join(dir, 'db', f));
  }
}

async function listAll(bucket, prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error('listing ' + bucket + '/' + prefix + ': ' + error.message);
    for (const x of data) {
      const p = prefix ? prefix + '/' + x.name : x.name;
      if (x.id == null) out.push(...(await listAll(bucket, p))); // a folder
      else out.push({ path: p, size: x.metadata?.size ?? null });
    }
    if (data.length < 1000) return out;
  }
}

async function copyFiles(dir) {
  const { data: buckets, error } = await sb.storage.listBuckets();
  if (error) throw new Error('listing buckets: ' + error.message);
  let count = 0, fresh = 0, bytes = 0;
  for (const b of buckets) {
    for (const f of await listAll(b.name)) {
      count++;
      const to = path.join(dir, 'files', b.name, ...f.path.split('/'));
      const have = await stat(to).catch(() => null);
      if (have && (f.size == null || have.size === f.size)) { bytes += have.size; continue; }
      const { data: blob, error: e } = await sb.storage.from(b.name).download(f.path);
      if (e) throw new Error('copying ' + b.name + '/' + f.path + ': ' + e.message);
      const buf = Buffer.from(await blob.arrayBuffer());
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, buf);
      fresh++; bytes += buf.length;
    }
  }
  Object.assign(report, { files_count: count, files_new: fresh, files_bytes: bytes });
}

try {
  const dir = env('BACKUP_DIR');
  sb = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), process.env.SUPABASE_SERVICE_ROLE_KEY || env('SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  await dumpDatabase(dir);
  await copyFiles(dir);
  report.ok = true;
} catch (e) {
  report.error = String(e?.message || e);
}
if (report.kept_at) await writeFile(path.join(report.kept_at, 'last-run.json'), JSON.stringify(report, null, 2)).catch(() => {});
if (sb) {
  const { error } = await sb.rpc('backup_report', { p: report });
  if (error) console.error('Could not report the run to the portal: ' + error.message);
}
console.log(report.ok ? `Backup done: database ${report.db_bytes} bytes, ${report.files_count} files (${report.files_new} new).` : 'Backup FAILED: ' + report.error);
process.exit(report.ok ? 0 : 1);
