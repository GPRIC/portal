// P26 money rules: blocked writes are refused and the allowed actions still work.
// Called from test-db.mjs after its own checks, with the month of August 2026 reconciled and locked (statement bs).
export async function run({ db, as, fails, ok, B1, B2, B3, C, bs }) {
  const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
  const bal = async (f) => Number(await one(B1, `select public.fund_balance($1)`, [f]));

  // Direct writes to the money tables are refused for every signed-in role.
  for (const [who, cl] of [['treasurer', B1], ['bookkeeper', B3]]) {
    await fails(cl, `insert into public.ledger (date, dir, amount, fund_id) values ('2026-10-01', 'in', 1, 'F-GEN')`, [], /permission denied/, `${who}: no direct ledger insert`);
    await fails(cl, `insert into public.donations (donor_id, date, amount, fund_id) select id, current_date, 1, 'F-GEN' from public.donors limit 1`, [], /permission denied/, `${who}: no direct gift insert`);
    await fails(cl, `update public.team_requests set status = 'Approved'`, [], /permission denied/, `${who}: no direct request change`);
    await fails(cl, `update public.funds set restricted = false`, [], /permission denied/, `${who}: no direct fund change`);
    await fails(cl, `insert into public.bank_lines (statement_id, date, amount) values ('${bs}', '2026-08-02', 1)`, [], /permission denied/, `${who}: no direct bank line`);
    await fails(cl, `delete from public.documents`, [], /permission denied/, `${who}: no deletes (archive instead)`);
  }
  // Even the database owner cannot move a request's status outside the request actions, or delete money.
  await fails({ role: 'postgres' }, `update public.team_requests set status = 'Paid' where status = 'Submitted'`, [], /status changes only/, 'status moves only through the actions');
  try { await db.exec(`delete from public.ledger where not sample`); ok(false, 'ledger rows cannot be deleted (no error)'); }
  catch (e) { ok(/archived, never deleted/.test(e.message), 'ledger rows cannot be deleted -> ' + e.message); }

  // Reverse and correct.
  const add = await one(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-03', dir: 'in', amount: 40, fund_id: 'F-GEN', source: 'Test Deposit' })]);
  const before = await bal('F-GEN');
  await fails(B3, `select public.ledger_reverse($1, ' ')`, [add], /reason/, 'a reversal needs a reason');
  const rev = await one(B3, `select public.ledger_reverse($1, 'Entered twice')`, [add]);
  ok((await bal('F-GEN')) === before - 40, 'reversal takes the money back out');
  const pair = (await db.query(`select id, reverses_id, reversed_by_id, dir from public.ledger where id in ($1, $2)`, [add, rev])).rows;
  ok(pair.find((r) => r.id === rev).reverses_id === add && pair.find((r) => r.id === add).reversed_by_id === rev, 'reversal and original point at each other');
  await fails(B3, `select public.ledger_reverse($1, 'again')`, [add], /already reversed/, 'cannot reverse twice');
  const add2 = await one(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-04', dir: 'in', amount: 25, fund_id: 'F-GEN', source: 'Test Deposit' })]);
  const b2 = await bal('F-GEN');
  await one(B3, `select public.ledger_correct($1, '{"amount": 30}', 'Typo')`, [add2]);
  ok((await bal('F-GEN')) === b2 + 5, 'correction posts the difference (reverse 25, add 30)');
  const reqPay = (await db.query(`select id from public.ledger where request_id is not null and dir = 'out' and reverses_id is null limit 1`)).rows[0].id;
  await fails(B1, `select public.ledger_reverse($1, 'x')`, [reqPay], /from the request/, 'request payments are undone from the request');
  // A locked month's entry is reversed with an open-month date; the locked row itself only gains the link.
  const aug = (await db.query(`select id from public.ledger where date between '2026-08-01' and '2026-08-31' and request_id is null and donation_id is null and reverses_id is null and dir = 'in' limit 1`)).rows[0]?.id;
  if (aug) {
    await fails(B1, `select public.ledger_reverse($1, 'x', '2026-08-20')`, [aug], /locked/, 'reversal cannot be dated in a locked month');
    const r2 = await one(B1, `select public.ledger_reverse($1, 'Wrong fund')`, [aug]);
    ok(/^L-/.test(r2), 'a locked month entry can still be reversed into an open month');
  }

  // Overspending: approval warns, payment is blocked, the Treasurer overrides with a logged reason.
  await as(B1, `select public.fund_save($1)`, [JSON.stringify({ name: 'Tiny Fund', restricted: false })]);
  const tiny = (await db.query(`select id from public.funds where name = 'Tiny Fund'`)).rows[0].id;
  const team = await one(B1, `select public.team_save($1)`, [JSON.stringify({ name: 'Test Team', short: 'TT' })]);
  const tfund = (await db.query(`select fund_id from public.teams where id = $1`, [team])).rows[0].fund_id;
  await as(B1, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-05', dir: 'in', amount: 100, fund_id: tfund, source: 'Test Deposit' })]);
  const big = await one(B2, `select public.request_save($1)`, [JSON.stringify({ team_id: team, purpose: 'Big', amount: 300 })]);
  const ap = await one(B1, `select public.approve_request($1)`, [big]);
  ok(ap.warnings?.length > 0, 'approval warns when the fund cannot cover it: ' + ap.warnings?.[0]);
  await fails(B3, `select public.mark_request_paid($1, current_date, 'Check', '9')`, [big], /Blocked: .*overspend/, 'payment blocked when it overspends');
  await fails(B3, `select public.mark_request_paid($1, current_date, 'Check', '9', 'Board said ok')`, [big], /Only the Treasurer/, 'only the Treasurer overrides');
  await as(B1, `select public.mark_request_paid($1, current_date, 'Check', '9', 'Sponsor cheque arriving Monday')`, [big]);
  const ov = (await db.query(`select rule, reason from public.money_overrides where record_id = $1`, [big])).rows;
  ok(ov.length === 1 && /overspend/.test(ov[0].rule) && ov[0].reason === 'Sponsor cheque arriving Monday', 'override logged with its reason');

  // Restricted money: a team fund pays only for its own team; another restricted fund needs the Treasurer.
  await fails(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'out', amount: 1, fund_id: 'F-9255', category: 'Space' })], /restricted to its own team/, 'team money cannot pay for something else');
  await as(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'out', amount: 1, fund_id: 'F-9255', category: 'Robotics Teams' })]);
  ok(true, 'team money pays a team cost');
  await as(B1, `select public.fund_save($1)`, [JSON.stringify({ name: 'Lease Money', restricted: true, purpose: 'Lease only' })]);
  const lease = (await db.query(`select id from public.funds where name = 'Lease Money'`)).rows[0].id;
  await as(B1, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'in', amount: 50, fund_id: lease, source: 'Test Deposit' })]);
  await fails(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'out', amount: 10, fund_id: lease, category: 'Space' })], /restricted money/, 'other restricted money needs the Treasurer');
  await as(B1, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'out', amount: 10, fund_id: lease, category: 'Space', override: 'Lease payment' })]);
  ok(true, 'Treasurer spends restricted money with a reason');
  await fails(B3, `select public.fund_save($1)`, [JSON.stringify({ id: lease, name: 'Lease Money', restricted: false })], /Only the Treasurer/, 'only the Treasurer changes a restriction');
  await fails(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'out', amount: 999, fund_id: tiny, category: 'Space' })], /overspend/, 'ledger out blocked when it overspends');

  // Reconciled months are fully locked; only the Treasurer unlocks, with a reason.
  await fails(B1, `select public.bank_lines_add($1, '[{"date":"2026-08-03","amount":1}]')`, [bs], /locked/, 'locked month refuses bank lines');
  await fails(B1, `select public.bank_statement_set($1, '{"ending_balance": 1}')`, [bs], /locked/, 'locked statement cannot change');
  await fails(B3, `select public.unlock_bank_month($1, 'fix')`, [bs], /not allowed for your role/, 'only the Treasurer unlocks');
  await fails(B1, `select public.unlock_bank_month($1, ' ')`, [bs], /reason/, 'unlocking needs a reason');
  await as(B1, `select public.unlock_bank_month($1, 'Missed a fee')`, [bs]);
  ok((await db.query(`select unlock_reason from public.bank_statements where id = $1`, [bs])).rows[0].unlock_reason === 'Missed a fee', 'unlock reason kept');
  await as(B1, `select public.bank_lines_add($1, '[{"date":"2026-08-03","description":"fee","amount":-1}]')`, [bs]);
  ok(true, 'unlocked month takes bank lines again');

  // Archive replaces delete.
  await as(B1, `insert into public.documents (title, type) values ('Old', 'Board')`);
  const doc = (await db.query(`select id from public.documents where title = 'Old'`)).rows[0].id;
  await as(B2, `select public.archive_record('documents', $1, 'Superseded')`, [doc]);
  ok((await db.query(`select archived_at is not null a from public.documents where id = $1`, [doc])).rows[0].a, 'documents are archived');
  await fails(B2, `select public.archive_record('ledger', 'L-0001')`, [], /money actions/, 'ledger cannot be archived, only reversed');
  await fails(B2, `select public.archive_record('teams', $1)`, [team], /money or open requests/, 'a team with money stays');
  // Gifts: removing a gift reverses its money.
  const gift = (await db.query(`select d.id, d.fund_id, d.amount from public.donations d where d.archived_at is null and not exists (select 1 from public.bank_statements s where s.locked_at is not null and s.month = date_trunc('month', d.date)) limit 1`)).rows[0];
  const gb = await bal(gift.fund_id);
  await as(B3, `select public.gift_archive($1, 'Test gift')`, [gift.id]);
  ok((await bal(gift.fund_id)) === Math.round((gb - Number(gift.amount)) * 100) / 100, 'removing a gift reverses its money');

  // Files stay: no one signed in can remove a file.
  await db.exec(`insert into storage.objects (bucket_id, name) values ('board-files', 'receipts/keep.pdf')`);
  await as(B1, `delete from storage.objects where name = 'receipts/keep.pdf'`);
  ok((await db.query(`select count(*)::int n from storage.objects where name = 'receipts/keep.pdf'`)).rows[0].n === 1, 'files are never removed');

  // One set of totals.
  const tot = await one(B2, `select public.portal_totals()`);
  const gen = tot.funds.find((f) => f.id === 'F-GEN');
  ok(Number(gen.balance) === (await bal('F-GEN')), 'portal_totals matches the fund balance');
  ok(Math.abs(Number(tot.cash.total) - tot.funds.reduce((a, f) => a + Number(f.balance), 0)) < 0.005, 'cash total is the sum of funds');
  await fails(C, `select public.portal_totals()`, [], /Board sign-in/, 'team users get no board totals');

  await fails(B3, `select public.clear_sample_data()`, [], /not allowed for your role/, 'only the Treasurer clears sample data');
}
