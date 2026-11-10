// P24 action log and P25 roll back: every change is logged with the right person, the log is append only,
// a team login sees only its own team's history (through change_log_team, anonymous donors masked), and only the Treasurer rolls back, through the money rules.
// Called from test-db.mjs after the money checks.
export async function run({ db, as, fails, ok, B1, B2, B3, C }) {
  const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
  const last = async (where, params = []) => (await db.query(`select * from public.change_log where ${where} order by id desc limit 1`, params)).rows[0];

  // Who did what: every kind of change logs the signed-in person.
  const led = await one(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-07', dir: 'in', amount: 12, fund_id: 'F-GEN', source: 'Test Deposit' })]);
  let e = await last(`tbl = 'ledger' and record_id = $1`, [led]);
  ok(e && e.user_id === B3.sub && e.action === 'Added' && e.what === 'Ledger' && e.after.amount == 12 && e.before === null, 'an add is logged with the person and the record after');
  await as(B3, `select public.ledger_edit($1, '{"memo": "Bake sale"}')`, [led]);
  e = await last(`tbl = 'ledger' and record_id = $1`, [led]);
  ok(e.action === 'Changed' && e.before.memo === null && e.after.memo === 'Bake sale' && /Memo/.test(e.summary), 'a change is logged with before and after: ' + e.summary);
  const led2 = await one(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-08', dir: 'in', amount: 7, fund_id: 'F-GEN', source: 'Test Deposit' })]);
  await as(B3, `select public.ledger_edit($1, '{"memo": "First memo"}')`, [led2]);
  const memo1 = await last(`tbl = 'ledger' and record_id = $1`, [led2]);
  await as(B2, `insert into public.documents (title, type) values ('Log Test', 'Board')`);
  const doc = (await db.query(`select id from public.documents where title = 'Log Test'`)).rows[0].id;
  await as(B2, `update public.documents set title = 'Log Test 2' where id = $1`, [doc]);
  const docChange = await last(`tbl = 'documents' and record_id = $1`, [doc]);
  ok(docChange.user_id === B2.sub && docChange.action === 'Changed', 'a direct edit on a non-money table is logged');
  await as(B2, `select public.archive_record('documents', $1, 'Old copy')`, [doc]);
  e = await last(`tbl = 'documents' and record_id = $1`, [doc]);
  ok(e.action === 'Archived' && e.reason === 'Old copy', 'an archive is logged with its reason');
  const appr = (await db.query(`select * from public.change_log where action = 'Approved' and tbl = 'team_requests' limit 1`)).rows[0];
  ok(!!appr && !!appr.user_id, 'an approval is logged as Approved');
  ok((await db.query(`select count(*)::int n from public.change_log where action = 'Paid' and tbl = 'team_requests'`)).rows[0].n > 0, 'a payment is logged as Paid');
  ok((await db.query(`select count(*)::int n from public.change_log where action = 'Reversed' and tbl = 'ledger'`)).rows[0].n > 0, 'a reversal is logged as Reversed');
  ok((await db.query(`select count(*)::int n from public.change_log where action = 'Invited' and tbl = 'team_invites'`)).rows[0].n > 0, 'invites are logged');
  ok((await db.query(`select count(*)::int n from public.change_log where action = 'Locked' and tbl = 'bank_statements'`)).rows[0].n > 0, 'a month lock is logged');
  ok((await db.query(`select count(*)::int n from public.change_log where action = 'Unlocked' and reason is not null`)).rows[0].n > 0, 'an unlock is logged with its reason');
  const teamRow = (await db.query(`select * from public.change_log where role = 'team' and tbl = 'team_requests' limit 1`)).rows[0];
  ok(!!teamRow && teamRow.team_id === 'T-9255', 'a team login\'s request is logged as the team');

  // Imports and automatic jobs are recorded as System.
  const sync = (await db.query(`select * from public.change_log where action = 'Synced' order by id`)).rows;
  ok(sync.length >= 2 && sync.some((s) => s.who === 'System — Zeffy sync' && s.role === 'system'), 'the Zeffy sync is logged as System');
  ok(sync.some((s) => s.who === 'System — Zeffy file import' && /started by/.test(s.device || '')), 'a Zeffy file import is System, with who started it');
  ok((await db.query(`select count(*)::int n from public.change_log where tbl = 'donations' and action = 'Imported' and role = 'system'`)).rows[0].n > 0, 'imported gifts are logged as System');
  const st = (await db.query(`select id from public.bank_statements order by month desc limit 1`)).rows[0].id;
  if (!(await db.query(`select locked_at from public.bank_statements where id = $1`, [st])).rows[0].locked_at) {
    await as(B1, `select public.bank_lines_add($1, '[{"date":"2026-10-02","amount":5},{"date":"2026-10-03","amount":6}]')`, [st]);
    e = await last(`tbl = 'bank_lines'`);
    ok(e.who === 'System — Bank statement import' && /started by/.test(e.device), 'a statement import is System, with who started it');
  }

  // The device comes from the browser.
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`,
      [JSON.stringify(B2), JSON.stringify({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' })]);
    await tx.exec(`set local role authenticated`);
    await tx.query(`update public.accounts set notes = 'device test' where id = (select id from public.accounts limit 1)`);
  });
  e = await last(`tbl = 'accounts'`);
  ok(/Chrome/.test(e.device || ''), 'the device is logged');

  // Sign-ins and sign-outs.
  const sid = '00000000-0000-0000-0000-00000000aa01';
  await db.query(`insert into auth.sessions (id, user_id, aal, user_agent) values ($1, $2, 'aal1', 'Safari on iPhone')`, [sid, B2.sub]);
  await db.query(`update auth.sessions set aal = 'aal2' where id = $1`, [sid]);
  await db.query(`delete from auth.sessions where id = $1`, [sid]);
  const si = (await db.query(`select action, summary, device from public.change_log where tbl = 'sessions' and user_id = $1 order by id`, [B2.sub])).rows;
  ok(si.length === 3 && si[0].action === 'Signed In' && si[1].summary === 'Two-step code accepted' && si[2].action === 'Signed Out' && si[0].device === 'Safari on iPhone',
    'sign-in, two-step and sign-out are logged: ' + si.map((x) => x.action).join(', '));

  // Append only.
  await fails(B1, `update public.change_log set who = 'x'`, [], /permission denied/, 'nobody edits the log');
  await fails(B1, `delete from public.change_log`, [], /permission denied/, 'nobody deletes from the log');
  try { await db.exec(`delete from public.change_log`); ok(false, 'even the owner cannot delete log rows (no error)'); }
  catch (x) { ok(/append only/.test(x.message), 'even the owner cannot delete log rows'); }
  try { await db.exec(`update public.change_log set who = 'x'`); ok(false, 'even the owner cannot edit log rows (no error)'); }
  catch (x) { ok(/append only/.test(x.message), 'even the owner cannot edit log rows'); }

  // Read access: the board sees all; a team login only its own team.
  const total = (await db.query(`select count(*)::int n from public.change_log`)).rows[0].n;
  ok((await one(B2, `select count(*)::int from public.change_log`)) === total, 'the board sees every change');
  ok((await one(C, `select count(*)::int from public.change_log`)) === 0, 'a team login reads nothing from the log table itself');
  ok((await one(B2, `select count(*)::int from public.change_log_team`)) === 0, 'the board has no team view rows');
  const mine = await one(C, `select count(*)::int from public.change_log_team`);
  const leak = await one(C, `select count(*)::int from public.change_log_team where team_id is distinct from 'T-9255'`);
  ok(mine > 0 && leak === 0, `a team login sees only its own team (${mine} rows)`);
  // A donor who asked to stay anonymous is never named to a team, and donor, gift and grant links are left out.
  const anon = (await db.query(`select o.id, o.name from public.donors o join public.donations d on d.donor_id = o.id where d.fund_id = 'F-9255' and d.zeffy_key like '%|bell'`)).rows[0];
  await db.query(`update public.donors set anonymous = true where id = $1`, [anon.id]);
  const tv = (await as(C, `select * from public.change_log_team where tbl in ('donations','ledger')`)).rows;
  const named = tv.filter((r) => JSON.stringify([r.label, r.summary, r.before, r.after]).includes(anon.name));
  ok(tv.length > 0 && named.length === 0, `team rows never name an anonymous donor (${tv.length} gift rows)`);
  ok(tv.some((r) => /Anonymous/.test(r.label || '')), 'the anonymous gift shows as Anonymous');
  ok(!tv.some((r) => ['donor_id', 'grant_id', 'donation_id', 'zeffy_key'].some((k) => (r.before && k in r.before) || (r.after && k in r.after))), 'team rows carry no donor, gift, grant or Zeffy key links');
  const surname = anon.name.split(/\s+/).pop().toLowerCase();
  ok(!tv.some((r) => JSON.stringify([r.label, r.summary, r.before, r.after]).toLowerCase().includes(surname)), `the donor's surname appears in no team row, any case ("${surname}")`);
  // a very short name masks nothing and breaks nothing
  ok((await db.query(`select public.log_team_mask_text('Gift from ANON Nym and anon', 'Anon') m`)).rows[0].m === 'Gift from Anonymous Nym and Anonymous', 'masking a name found inside "Anonymous" ends');
  await db.query(`update public.donors set name = 'e' where id = $1`, [anon.id]);
  ok((await as(C, `select count(*)::int n from public.change_log_team`)).rows[0].n === mine, 'a one-letter anonymous name does not break team History');
  await db.query(`update public.donors set name = $2 where id = $1`, [anon.id, anon.name]);
  const bv = (await as(B2, `select label from public.change_log where tbl = 'donations' and record_id = (select id from public.donations where donor_id = $1 limit 1)`, [anon.id])).rows;
  ok(bv.some((r) => (r.label || '').includes(anon.name)), 'the board still sees the donor');
  await db.query(`update public.donors set anonymous = false where id = $1`, [anon.id]);

  // Roll back: Treasurer only, reason required, logged, and through the money rules.
  await fails(B2, `select public.rollback_change($1, 'oops')`, [docChange.id], /not allowed for your role/, 'only the Treasurer rolls back');
  await fails(B3, `select public.rollback_change($1, 'oops')`, [docChange.id], /not allowed for your role/, 'the bookkeeper cannot roll back');
  await fails(B1, `select public.rollback_change($1, ' ')`, [docChange.id], /reason/, 'a roll back needs a reason');
  await as(B1, `select public.rollback_change($1, 'Wrong title')`, [docChange.id]);
  ok((await db.query(`select title from public.documents where id = $1`, [doc])).rows[0].title === 'Log Test', 'roll back puts the fields back');
  const rb = await last(`rolls_back_id = $1`, [docChange.id]);
  ok(rb && rb.action === 'Rolled Back' && rb.reason === 'Wrong title' && rb.user_id === B1.sub, 'the roll back is itself logged with its reason');
  ok((await db.query(`select rolled_back_at is not null r from public.change_log where id = $1`, [docChange.id])).rows[0].r, 'the change is marked rolled back');
  await fails(B1, `select public.rollback_change($1, 'again')`, [docChange.id], /already rolled back/, 'cannot roll back twice');
  await fails(B1, `select public.rollback_change($1, 'x')`, [rb.id], /itself a roll back/, 'a roll back is not rolled back');
  const sess = (await db.query(`select id from public.change_log where tbl = 'sessions' limit 1`)).rows[0].id;
  await fails(B1, `select public.rollback_change($1, 'x')`, [sess], /cannot be rolled back/, 'a sign-in cannot be rolled back');
  // A change the record has moved on from is refused.
  await as(B2, `update public.documents set title = 'Step A' where id = $1`, [doc]);
  const stepA = await last(`tbl = 'documents' and record_id = $1`, [doc]);
  await as(B2, `update public.documents set title = 'Step B' where id = $1`, [doc]);
  await fails(B1, `select public.rollback_change($1, 'x')`, [stepA.id], /changed since/, 'roll back refuses an older change once the record moved on');
  // A deleted sample record is cleared for good, never put back.
  const smp = (await db.query(`select id from public.documents where sample limit 1`)).rows[0];
  if (smp) {
    await db.query(`delete from public.documents where id = $1`, [smp.id]);
    const del = await last(`tbl = 'documents' and record_id = $1 and action = 'Deleted'`, [smp.id]);
    await fails(B1, `select public.rollback_change($1, 'x')`, [del.id], /cleared for good/, 'a deleted sample record is not put back');
  } else ok(false, 'no sample document to test the sample re-insert refusal');
  // Ledger: an added entry is reversed, never deleted.
  const addLog = (await db.query(`select id from public.change_log where tbl = 'ledger' and record_id = $1 and action = 'Added'`, [led])).rows[0].id;
  await as(B1, `select public.rollback_change($1, 'Not our deposit')`, [addLog]);
  const l = (await db.query(`select reversed_by_id from public.ledger where id = $1`, [led])).rows[0];
  ok(!!l.reversed_by_id, 'rolling back a ledger add reverses it');
  // A payment: its ledger entry is reversed, then the request steps back.
  const paid = (await db.query(`select * from public.change_log where action = 'Paid' and tbl = 'team_requests' and rolled_back_at is null order by id desc limit 1`)).rows[0];
  await as(B1, `select public.rollback_change($1, 'Paid the wrong team')`, [paid.id]);
  const rq = (await db.query(`select status from public.team_requests where id = $1`, [paid.record_id])).rows[0];
  ok(rq.status === paid.before.status, `rolling back a payment steps the request back to ${rq.status}`);
  ok((await db.query(`select count(*)::int n from public.ledger where request_id = $1 and dir = 'out' and reverses_id is null and reversed_by_id is null`, [paid.record_id])).rows[0].n === 0,
    'and its payment is reversed in the ledger');
  // Closing a request returns unspent money to the team fund: rolling the close back would credit it twice, so it is refused.
  const open_ = (await db.query(`select id from public.team_requests where status in ('Paid','Receipts Due') and archived_at is null order by id limit 1`)).rows[0];
  if (open_) {
    await as(B1, `select public.complete_request_receipts($1)`, [open_.id]);
    const closed = await last(`tbl = 'team_requests' and record_id = $1 and (after ->> 'status') = 'Closed'`, [open_.id]);
    const booked = (await db.query(`select count(*)::int n from public.ledger where request_id = $1 and source = 'Unspent Returned'`, [open_.id])).rows[0].n;
    if (booked) await fails(B1, `select public.rollback_change($1, 'x')`, [closed.id], /booked money/, 'rolling back a close that returned money is refused');
    else ok(true, 'close returned no money (nothing to double count)');
  } else ok(false, 'no paid request left to test closing');
  // A ledger description change that was edited again since is not overwritten.
  await as(B3, `select public.ledger_edit($1, '{"memo": "Second memo"}')`, [led2]);
  await fails(B1, `select public.rollback_change($1, 'x')`, [memo1.id], /changed since/, 'a ledger description roll back refuses once edited again');
}
