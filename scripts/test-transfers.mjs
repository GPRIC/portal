// P23 transfers between teams (0017): who may make one, the money rules, no undo, and what each side and the figures show.
// Called from test-db.mjs after the money tests, with August 2026 reconciled and locked.
export async function run({ db, as, fails, ok, B1, B2, B3, C }) {
  const one = async (claims, sql, params = []) => Object.values((await as(claims, sql, params)).rows[0])[0];
  const bal = async (f) => Number(await one(B1, `select public.fund_balance($1)`, [f]));
  const T = 'select public.fund_transfer($1, $2, $3, $4, $5, $6)';
  const teamFund = (await db.query(`select fund_id from public.teams where id = 'T-9255'`)).rows[0].fund_id;
  const GEN = 'F-GEN';
  const totals = async () => (await as(B1, `select public.portal_totals() t`)).rows[0].t;
  const fundRow = (t, id) => t.funds.find((f) => f.id === id);

  // Who may move money.
  await fails(B2, T, [GEN, teamFund, 10, 'x', '2026-10-05', null], /not allowed for your role/, 'transfer: a board member cannot');
  await fails(C, T, [GEN, teamFund, 10, 'x', '2026-10-05', null], /not allowed|sign-in/, 'transfer: a team login cannot');
  await fails(B3, T, [GEN, teamFund, 10, ' ', '2026-10-05', null], /reason/, 'transfer: a reason is required');
  await fails(B3, T, [GEN, GEN, 10, 'x', '2026-10-05', null], /two different/, 'transfer: two different teams');
  await fails(B3, T, [GEN, teamFund, 0, 'x', '2026-10-05', null], /more than zero/, 'transfer: amount over zero');
  const st = (await db.query(`select id, to_char(month + 14, 'YYYY-MM-DD') d, locked_at from public.bank_statements order by month limit 1`)).rows[0];
  ok(!!st, 'a bank statement month to lock ' + st?.d);
  if (st) {
    const setLock = (on) => db.exec(`select set_config('gpric.via', '${on ? 'lock' : 'unlock'}', false);
      update public.bank_statements set locked_at = ${on ? 'now()' : 'null'} where id = '${st.id}'; select set_config('gpric.via', '', false);`);
    if (!st.locked_at) await setLock(true);
    await fails(B3, T, [GEN, teamFund, 10, 'x', st.d, null], /locked/, 'transfer: a locked month refuses it');
    if (!st.locked_at) await setLock(false);
  }

  // The bookkeeper moves $10 from General to the team.
  const t0 = await totals();
  const bank0 = (await as(B1, `select public.bank_month_figures('2026-10-01') f`)).rows[0].f;
  const g0 = await bal(GEN); const f0 = await bal(teamFund);
  const tr = await one(B3, T, [GEN, teamFund, 10, 'Robot parts shared at the scrimmage', '2026-10-05', null]);
  ok(/^TR-/.test(tr), 'transfer made ' + tr);
  ok((await bal(GEN)) === g0 - 10 && (await bal(teamFund)) === f0 + 10, 'the money leaves one fund and reaches the other');
  const legs = (await db.query(`select dir, fund_id, source, category, memo from public.ledger where transfer_id = $1 order by dir`, [tr])).rows;
  ok(legs.length === 2 && legs[0].dir === 'in' && legs[0].fund_id === teamFund && legs[0].source === 'Transfer'
     && legs[1].dir === 'out' && legs[1].fund_id === GEN && legs[1].category === 'Transfer', 'two ledger rows, out of General and into the team');
  ok(legs.every((l) => /Robot parts shared/.test(l.memo)), 'both rows carry the reason');
  const logged = (await db.query(`select count(*)::int n from public.change_log where action = 'Transferred' and reason = 'Robot parts shared at the scrimmage'`)).rows[0].n;
  ok(logged === 2, 'History shows both sides as Transferred, with the reason (' + logged + ')');

  // Figures: transfers are their own line, not money raised, spent, deposited or paid out; the bank leaves them out.
  const t1 = await totals();
  ok(Number(t1.raised) === Number(t0.raised) && Number(t1.spent) === Number(t0.spent), 'Money Raised and Money Spent leave transfers out');
  ok(Number(fundRow(t1, teamFund).transfers) === Number(fundRow(t0, teamFund).transfers) + 10
     && Number(fundRow(t1, GEN).transfers) === Number(fundRow(t0, GEN).transfers) - 10, 'each fund shows its transfers');
  ok(Number(fundRow(t1, teamFund).deposits) === Number(fundRow(t0, teamFund).deposits)
     && Number(fundRow(t1, GEN).direct) === Number(fundRow(t0, GEN).direct), 'not counted as deposits or direct expenses');
  const r = fundRow(t1, teamFund);
  ok(Math.abs(Number(r.opening) + Number(r.inn) - Number(r.out) - Number(r.balance)) < 0.005, 'the fund row still adds up to its balance');
  const bank1 = (await as(B1, `select public.bank_month_figures('2026-10-01') f`)).rows[0].f;
  ok(Number(bank1.outstanding) === Number(bank0.outstanding) && Number(bank1.expected) === Number(bank0.expected), 'bank figures leave transfers out');

  // Never undone, changed or faked.
  const outLeg = (await db.query(`select id from public.ledger where transfer_id = $1 and dir = 'out'`, [tr])).rows[0].id;
  await fails(B1, `select public.ledger_reverse($1, 'Wrong team')`, [outLeg], /never undone/, 'a transfer cannot be reversed');
  await fails(B1, `select public.ledger_correct($1, '{"amount": 5}', 'Wrong amount')`, [outLeg], /never undone/, 'a transfer cannot be corrected');
  await fails(B3, `select public.ledger_add($1)`, [JSON.stringify({ date: '2026-10-06', dir: 'in', amount: 5, fund_id: GEN, source: 'Transfer' })], /Transfer Money/, 'no ordinary entry may claim to be a transfer');
  for (const [label, sql] of [
    ['transfer record not changed', `update public.fund_transfers set amount = 1`],
    ['transfer record not deleted', `delete from public.fund_transfers`],
    ['transfer ledger row not changed', `update public.ledger set memo = 'x' where transfer_id is not null`],
  ]) {
    try { await db.exec(sql); ok(false, label + ' (no error)'); } catch (e) { ok(/never changed|never deleted|archived/.test(e.message), label + ' -> ' + e.message); }
  }
  try { await db.exec(`insert into public.ledger (date, dir, amount, fund_id, transfer_id) values ('2026-10-07', 'in', 1, '${GEN}', '${tr}')`); ok(false, 'transfer rows only through Transfer Money (no error)'); }
  catch (e) { ok(/Transfer Money/.test(e.message), 'transfer rows only through Transfer Money -> ' + e.message); }

  // The money rules: overspending the giving fund is blocked; only the Treasurer overrides, and it is logged.
  const over = (await bal(teamFund)) + 1;
  await fails(B3, T, [teamFund, GEN, over, 'Season end', '2026-10-08', null], /Blocked/, 'transfer: overspend blocked');
  await fails(B3, T, [teamFund, GEN, over, 'Season end', '2026-10-08', 'Board agreed'], /Only the Treasurer/, 'transfer: the bookkeeper cannot override');
  const tr2 = await one(B1, T, [teamFund, GEN, over, 'Season end', '2026-10-08', 'Board agreed']);
  const ov = (await db.query(`select count(*)::int n from public.money_overrides where record_id = $1 and action = 'fund_transfer'`, [tr2])).rows[0].n;
  ok(ov >= 1, 'the Treasurer overrides with a reason, logged against the transfer');
  // Undoing is a transfer back the other way.
  await one(B1, T, [GEN, teamFund, over, 'Undo the season-end move', '2026-10-09', null]);
  ok((await bal(teamFund)) === f0 + 10, 'a transfer back the other way undoes it');

  // A restricted team fund cannot give its money to another team without the Treasurer.
  const rf = (await db.query(`select id from public.funds where restricted and team_id is not null and archived_at is null and id <> $1 limit 1`, [teamFund])).rows[0]?.id;
  if (rf) await fails(B3, T, [rf, teamFund, 0.01, 'x', '2026-10-10', 'x'], /restricted|Only the Treasurer/, 'transfer: restricted money stays with its team');

  // Each team sees its side, with the other team and the reason, and no board names.
  const tp = (await as(C, `select public.team_portal() p`)).rows[0].p;
  const mine = tp.transfers.find((x) => x.id === tr);
  ok(mine && mine.dir === 'in' && mine.reason === 'Robot parts shared at the scrimmage' && !!mine.team && !('by_name' in mine), 'the team sees the transfer in, from whom and why');
  ok(tp.transfers.length === 3 && Math.abs(Number(tp.money.transfers) - 10) < 0.005, 'the team money shows its net transfers ' + tp.money.transfers);
  ok(Math.abs(Number(tp.money.balance) - (f0 + 10)) < 0.005, 'the team balance includes transfers');
  ok((await as(C, `select count(*)::int n from public.fund_transfers`)).rows[0].n === 0, 'a team login reads no transfer table directly');
}
