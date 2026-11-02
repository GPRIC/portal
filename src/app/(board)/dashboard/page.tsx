'use client';
import { Page } from '@/components/shell';
import { useData } from '@/components/data';
import { Attn, Card, Lines, type AttnItem } from '@/components/ui';
import { Calc } from '@/lib/calc';
import { daysBetween, money, monthName, sd } from '@/lib/format';
import { unclearedOld, unmatchedLines } from '@/lib/bank';

export default function Dashboard() {
  const { db, calc } = useData();
  const T = calc.today, c = calc.cash(), g = calc.grants(), src = calc.inBySource(), out = calc.outByCategory();
  const reqs = db.team_requests;
  const team = (id: string) => calc.team(id)?.short || id;
  const soon = (d: string | null) => !!d && d >= T && daysBetween(T, d) <= 30;

  const items: AttnItem[] = [];
  db.grants.filter((x) => Calc.OPEN_GRANT.includes(x.status) && soon(x.deadline)).forEach((x) => {
    const d = daysBetween(T, x.deadline!);
    items.push({ r: d, d: sd(x.deadline), tone: d <= 10 ? 'red' : 'amb', t1: x.program, t2: 'Application due in ' + d + ' days · ' + money(x.ask), href: '/grants' });
  });
  reqs.filter((r) => calc.isOverdue(r)).forEach((r) => items.push({ r: -1, d: sd(calc.receiptsDue(r)), tone: 'red', t1: team(r.team_id) + ': ' + r.purpose, t2: 'Receipts ' + calc.daysLate(r) + ' days overdue · team blocked', href: '/requests' }));
  reqs.filter((r) => calc.needsVote(r)).forEach((r) => items.push({ r: 5, d: 'Vote', tone: 'vio', t1: team(r.team_id) + ': ' + r.purpose, t2: 'Needs a board vote · ' + money(r.amount), href: '/requests' }));
  reqs.filter((r) => r.status === 'Approved').forEach((r) => items.push({ r: 6, d: 'Pay', tone: 'grn', t1: team(r.team_id) + ': ' + r.purpose, t2: 'Approved, not yet paid · ' + money(r.amount), href: '/requests' }));
  g.awarded.filter((x) => x.received < x.awarded).forEach((x) => items.push({ r: 7, d: 'Pending', tone: 'amb', t1: x.funder, t2: money(x.awarded - x.received) + ' awarded, not yet received', href: '/grants' }));
  const renew = db.accounts.filter((a) => soon(a.renewal));
  renew.forEach((a) => items.push({ r: 8 + daysBetween(T, a.renewal!) / 100, d: sd(a.renewal), tone: 'blu', t1: a.service, t2: 'Renews · ' + (a.cost ? money(a.cost) + '/' + a.period.toLowerCase() : 'free'), href: '/accounts' }));
  const unthanked = db.donations.filter((d) => !d.thanked).length;
  if (unthanked) items.push({ r: 9, d: String(unthanked), tone: 'amb', t1: 'Thank-you notes due', t2: unthanked + ' gifts not yet thanked', href: '/donors' });
  // Bank reconciliation: statement lines not matched to a portal record, and portal records the bank has not cleared after 30 days.
  const unmatched = unmatchedLines(db);
  db.bank_statements.filter((s) => !s.locked_at).forEach((s) => {
    const n = unmatched.filter((b) => b.statement_id === s.id);
    if (n.length) items.push({ r: 4, d: String(n.length), tone: 'amb', t1: monthName(s.month) + ': bank lines not matched', t2: n.length + ' statement lines with no portal record · ' + money(n.reduce((a, b) => a + Math.abs(b.amount), 0)), href: '/balances' });
  });
  const uncleared = unclearedOld(db, calc, T);
  if (uncleared.length) items.push({ r: 4.5, d: String(uncleared.length), tone: 'amb', t1: 'Not cleared by the bank', t2: uncleared.length + ' portal entries over 30 days old with no bank line · ' + money(uncleared.reduce((a, l) => a + l.amount, 0)), href: '/balances' });
  items.sort((a, b) => a.r - b.r);

  const waiting = reqs.filter((r) => calc.needsVote(r));
  const overdue = reqs.filter((r) => calc.isOverdue(r));
  return (
    <Page title="Board Dashboard" help="dashboard">
      <div className="panel">
        <div className="ph"><h2>Needs Attention</h2></div>
        <Attn items={items} />
      </div>
      <div className="cards">
        <Card n="Cash On Hand" v={money(c.total)} tip={'Unrestricted ' + money(c.unrestricted) + ' · Restricted ' + money(c.restricted) + '.'} href="/ledger" />
        <Card n="Restricted" v={money(c.restricted)} tip={<Lines lines={c.funds.filter((f) => f.fund.restricted && f.balance).map((f) => f.fund.name + ': ' + money(f.balance))} />} href="/ledger" />
        <Card n="Unrestricted" v={money(c.unrestricted)} tip="Unrestricted fund balances." href="/ledger" />
        <Card n="Raised This Year" v={money(calc.raised())} tip={<Lines lines={Object.keys(src).map((k) => k + ': ' + money(src[k]))} />} href="/ledger" />
        <Card n="Spent This Year" v={money(calc.spent())} tip={<Lines lines={Object.keys(out).map((k) => k + ': ' + money(out[k]))} />} href="/ledger" />
        <Card n="In The Pipeline" v={money(g.openAsk)} tip={g.open.length + ' open asks. Weighted by likelihood: ' + money(g.weighted) + '.'} href="/grants" />
        <Card n="Grants Awarded" v={money(g.awardedTotal)} tip={<Lines lines={g.awarded.map((x) => x.funder + ': ' + money(x.awarded) + (x.received < x.awarded ? ' (not yet received)' : ''))} />} href="/grants" />
        <Card n="Requests Waiting" v={String(waiting.length)} color={waiting.length ? 'vio' : undefined} tip={<Lines lines={waiting.map((r) => team(r.team_id) + ': ' + r.purpose + ' ' + money(r.amount))} />} href="/requests" />
        <Card n="Receipts Overdue" v={String(overdue.length)} color={overdue.length ? 'red' : 'g'} tip={<Lines lines={overdue.map((r) => team(r.team_id) + ': ' + r.purpose + ', ' + calc.daysLate(r) + ' days')} />} href="/requests" />
        <Card n="Renewals In 30 Days" v={String(renew.length)} tip={<Lines lines={renew.map((a) => a.service + ': ' + sd(a.renewal))} />} href="/accounts" />
      </div>
    </Page>
  );
}
