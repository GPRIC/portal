// Every total in the portal is calculated here, so every page agrees (ported from the demo's shared/store.js Calc).
import type { Db, Donation, Fund, Grant, Ledger, Member, Team, TeamRequest } from './types';
import { addDays, daysBetween, round2, sum } from './format';

export type FundRow = { fund: Fund; opening: number; inn: number; out: number; balance: number };
/** A fund's money by kind, as on Team Balances. The same rules as public.team_money() in 0003_team_money.sql. */
export type MoneyRow = { fund: Fund; team: Team | null; carry: number; zeffy: number; deposits: number; reimbursements: number; direct: number; balance: number };
export type MoneyKind = 'Carry-Over' | 'Zeffy' | 'Deposit' | 'Reimbursement' | 'Direct Expense';

export class Calc {
  constructor(public db: Db, public today: string) {}

  get fyStart() { return this.db.settings.fy_start; }
  get receiptDays() { return this.db.settings.receipt_days || 60; }

  fund(id: string | null | undefined) { return this.db.funds.find((f) => f.id === id) || null; }
  team(id: string | null | undefined) { return this.db.teams.find((t) => t.id === id) || null; }
  member(id: string | null | undefined) { return this.db.board_members.find((m) => m.id === id) || null; }
  donor(id: string | null | undefined) { return this.db.donors.find((d) => d.id === id) || null; }
  grant(id: string | null | undefined) { return this.db.grants.find((g) => g.id === id) || null; }
  request(id: string | null | undefined) { return this.db.team_requests.find((r) => r.id === id) || null; }
  meeting(id: string | null | undefined) { return this.db.meetings.find((m) => m.id === id) || null; }
  vote(id: string | null | undefined) { return this.db.meeting_votes.find((v) => v.id === id) || null; }

  fundName(id: string | null | undefined) { return this.fund(id)?.name || id || ''; }
  memberTitle(id: string | null | undefined) { const m = this.member(id); return m ? m.title + ' (' + m.name + ')' : '—'; }
  /** Members who vote: active, ordered by seat. */
  board(): Member[] { return this.db.board_members.filter((m) => m.active).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id)); }

  /** This fiscal year's ledger rows. */
  fyLedger(): Ledger[] { return this.db.ledger.filter((l) => l.date >= this.fyStart); }

  fundBalance(fid: string | null | undefined): number {
    return round2(sum(this.db.ledger.filter((l) => l.fund_id === fid), (l) => (l.dir === 'in' ? l.amount : -l.amount)));
  }
  funds(): FundRow[] {
    return this.db.funds.map((f) => {
      const rows = this.db.ledger.filter((l) => l.fund_id === f.id);
      const opening = sum(rows.filter((l) => l.source === 'Opening Balance'), (l) => l.amount);
      const inn = sum(rows.filter((l) => l.dir === 'in' && l.source !== 'Opening Balance'), (l) => l.amount);
      const out = sum(rows.filter((l) => l.dir === 'out'), (l) => l.amount);
      return { fund: f, opening: round2(opening), inn: round2(inn), out: round2(out), balance: round2(opening + inn - out) };
    });
  }
  cash() {
    const fs = this.funds();
    const restricted = sum(fs.filter((x) => x.fund.restricted), (x) => x.balance);
    const unrestricted = sum(fs.filter((x) => !x.fund.restricted), (x) => x.balance);
    return { total: round2(restricted + unrestricted), restricted: round2(restricted), unrestricted: round2(unrestricted), funds: fs };
  }
  /** Money in by source this fiscal year (excludes opening balances and returned team money). */
  inBySource(): Record<string, number> {
    const o: Record<string, number> = {};
    this.fyLedger().filter((l) => l.dir === 'in' && l.source !== 'Opening Balance' && l.source !== 'Unspent Returned')
      .forEach((l) => { const k = l.source || 'Other'; o[k] = round2((o[k] || 0) + l.amount); });
    return o;
  }
  /** Money out by category this fiscal year; returned team money nets against Robotics Teams. */
  outByCategory(): Record<string, number> {
    const o: Record<string, number> = {};
    const fy = this.fyLedger();
    fy.filter((l) => l.dir === 'out').forEach((l) => { const k = l.category || 'Other'; o[k] = round2((o[k] || 0) + l.amount); });
    const ret = sum(fy.filter((l) => l.source === 'Unspent Returned'), (l) => l.amount);
    if (ret) o['Robotics Teams'] = round2((o['Robotics Teams'] || 0) - ret);
    return o;
  }
  raised() { const o = this.inBySource(); return round2(sum(Object.keys(o), (k) => o[k])); }
  spent() { const o = this.outByCategory(); return round2(sum(Object.keys(o), (k) => o[k])); }

  static OPEN_GRANT = ['Prospect', 'Drafting', 'Applied'];
  grants() {
    const g = this.db.grants;
    const open = g.filter((x) => Calc.OPEN_GRANT.includes(x.status));
    const awarded = g.filter((x) => x.status === 'Awarded');
    return {
      open, openAsk: sum(open, (x) => x.ask), weighted: Math.round(sum(open, (x) => x.ask * (x.likelihood || 0))),
      awarded, awardedTotal: sum(awarded, (x) => x.awarded), receivedTotal: sum(awarded, (x) => x.received),
      pending: sum(awarded, (x) => Math.max(0, x.awarded - x.received)),
    };
  }
  grantFiles(g: Grant) { return this.db.documents.filter((d) => d.linked_to === g.id); }

  donorTotals(donorId: string) {
    const d = this.db.donations.filter((x) => x.donor_id === donorId).sort((a, b) => (a.date < b.date ? 1 : -1));
    const fy = d.filter((x) => x.date >= this.fyStart);
    return {
      count: fy.length, total: round2(sum(fy, (x) => x.amount)), last: d.length ? d[0].date : null,
      unthanked: d.filter((x) => !x.thanked).length, rows: d,
    };
  }

  /* team requests and receipts */
  receiptsFor(rid: string) { return this.db.receipts.filter((r) => r.request_id === rid); }
  receipted(r: TeamRequest) { return round2(sum(this.receiptsFor(r.id), (x) => x.amount)); }
  outstanding(r: TeamRequest) { return round2(r.amount - this.receipted(r) - (r.returned || 0)); }
  receiptsDue(r: TeamRequest) { return r.paid_date ? addDays(r.paid_date, this.receiptDays) : null; }
  /** A paid pre-approval still collecting receipts. A paid reimbursement came with its receipt. */
  isOpenReceipts(r: TeamRequest) { return r.status === 'Receipts Due' || (r.status === 'Paid' && r.type !== 'Reimbursement'); }
  daysLate(r: TeamRequest) {
    if (!this.isOpenReceipts(r)) return 0;
    const due = this.receiptsDue(r);
    if (!due) return 0;
    const d = daysBetween(due, this.today);
    return d > 0 ? d : 0;
  }
  isOverdue(r: TeamRequest) { return this.daysLate(r) > 0; }
  teamRequests(tid: string) { return this.db.team_requests.filter((r) => r.team_id === tid); }
  teamBlocked(tid: string) { return this.teamRequests(tid).filter((r) => this.isOverdue(r)); }
  teamMoney(t: Team) {
    const reqs = this.teamRequests(t.id);
    const balance = this.fundBalance(t.fund_id);
    const approved = reqs.filter((r) => r.status === 'Approved');
    return { balance, approvedUnpaid: sum(approved, (r) => r.amount), available: round2(balance - sum(approved, (r) => r.amount)) };
  }
  interestedMember(tid: string): Member | null {
    return this.board().find((m) => m.interest_team_id === tid) || null;
  }
  needsVote(r: TeamRequest) { return r.status === 'Submitted' || r.status === 'Board Vote'; }

  /* approvals (Requests v2) */
  approvalsFor(rid: string) { return this.db.request_approvals.filter((a) => a.request_id === rid).sort((a, b) => (a.approved_at < b.approved_at ? -1 : 1)); }
  /** Approvals a request needs: up to the threshold, or over it (Approval Rules). */
  needed(r: Pick<TeamRequest, 'amount'>) {
    const s = this.db.settings;
    return r.amount <= s.approval_threshold ? s.approvals_under : s.approvals_over;
  }
  /** The board member a request came from, if the requestor sits on the board. */
  requestorMember(r: TeamRequest): Member | null {
    if (r.requestor_member_id) return this.member(r.requestor_member_id);
    const e = (r.requestor_email || '').toLowerCase();
    return e ? this.db.board_members.find((m) => m.email && m.email.toLowerCase() === e) || null : null;
  }
  /** Why this signed-in person cannot approve, or null when they can. Mirrors approve_request(). */
  cannotApprove(r: TeamRequest, userId: string, email: string | null | undefined): string | null {
    if (!this.needsVote(r)) return 'This request is not waiting for approval.';
    const e = (email || '').toLowerCase();
    const mine = this.db.board_members.find((m) => m.email && m.email.toLowerCase() === e) || null;
    if (r.submitted_by_user === userId || (mine && this.requestorMember(r)?.id === mine.id) || (e && (r.requestor_email || '').toLowerCase() === e)) {
      return 'You made this request, so another board member has to approve it.';
    }
    if (this.approvalsFor(r.id).some((a) => a.user_id === userId || (mine && a.member_id === mine.id))) return 'You have already approved this request.';
    return null;
  }

  /* team balances */
  kindOf(l: Ledger): MoneyKind {
    if (l.dir === 'in') {
      if (l.source === 'Opening Balance') return 'Carry-Over';
      return this.donation(l.donation_id)?.channel === 'Zeffy' ? 'Zeffy' : 'Deposit';
    }
    return l.request_id ? 'Reimbursement' : 'Direct Expense';
  }
  donation(id: string | null | undefined): Donation | null { return id ? this.db.donations.find((d) => d.id === id) || null : null; }
  fundMoney(f: Fund): MoneyRow {
    const k = { carry: 0, zeffy: 0, deposits: 0, reimbursements: 0, direct: 0 };
    const key: Record<MoneyKind, keyof typeof k> = { 'Carry-Over': 'carry', Zeffy: 'zeffy', Deposit: 'deposits', Reimbursement: 'reimbursements', 'Direct Expense': 'direct' };
    this.db.ledger.filter((l) => l.fund_id === f.id).forEach((l) => { k[key[this.kindOf(l)]] += l.amount; });
    const r = Object.fromEntries(Object.entries(k).map(([a, b]) => [a, round2(b)])) as typeof k;
    return { fund: f, team: this.db.teams.find((t) => t.fund_id === f.id) || this.team(f.team_id), ...r,
      balance: round2(r.carry + r.zeffy + r.deposits - r.reimbursements - r.direct) };
  }
  /** One row per team fund, then the unrestricted funds. */
  teamBalances(): MoneyRow[] {
    const rows = this.db.funds.map((f) => this.fundMoney(f));
    return [...rows.filter((r) => r.team), ...rows.filter((r) => !r.team)];
  }
  /** Zeffy gifts with no Fund in Zeffy (sitting in the general fund until the board assigns them). */
  unassignedGifts() { return this.db.donations.filter((d) => d.unassigned); }
  /** Zeffy gifts not yet paid out to the bank as of a date. */
  inTransit(asOf = this.today) {
    return this.db.donations.filter((d) => d.channel === 'Zeffy' && d.date <= asOf && (!d.payout_date || d.payout_date > asOf));
  }
  lastZeffySync() { return [...this.db.zeffy_sync_log].sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1))[0] || null; }

  /* monthly bank reconciliation */
  /** Ledger rows matched to a bank line (directly, or a Zeffy gift inside a matched payout). */
  clearedIds(): Set<string> {
    const ids = new Set<string>();
    const payouts = new Set<string>();
    this.db.bank_lines.forEach((b) => { if (b.matched_ledger_id) ids.add(b.matched_ledger_id); if (b.matched_payout_date) payouts.add(b.matched_payout_date); });
    this.db.ledger.forEach((l) => { const d = this.donation(l.donation_id); if (d?.payout_date && payouts.has(d.payout_date)) ids.add(l.id); });
    return ids;
  }
  /** What the bank should show at month end: book balance, plus money out not yet cleared, less Zeffy gifts still in transit. */
  reconcile(monthEnd: string, bankEnding: number | null) {
    const rows = this.db.ledger.filter((l) => l.date <= monthEnd);
    const book = round2(sum(rows, (l) => (l.dir === 'in' ? l.amount : -l.amount)));
    const cleared = this.clearedIds();
    const outstanding = this.db.ledger.filter((l) => l.date <= monthEnd && l.dir === 'out' && !cleared.has(l.id) && l.source !== 'Opening Balance');
    const transit = this.inTransit(monthEnd);
    const expected = round2(book + sum(outstanding, (l) => l.amount) - sum(transit, (d) => d.amount));
    return { book, outstanding, outstandingTotal: round2(sum(outstanding, (l) => l.amount)), transit, transitTotal: round2(sum(transit, (d) => d.amount)),
      expected, difference: bankEnding == null ? null : round2(bankEnding - expected) };
  }
  /** The month a date falls in is reconciled and locked. */
  lockedMonth(iso: string) { return this.db.bank_statements.some((s) => s.locked_at && s.month === iso.slice(0, 7) + '-01'); }

  /** Warnings for money going out of a fund. They never block saving. */
  spendWarnings(fundId: string, amount: number, category: string | null, exceptLedgerId?: string): string[] {
    const w: string[] = [];
    const f = this.fund(fundId);
    if (!f || !(amount > 0)) return w;
    let bal = this.fundBalance(fundId);
    if (exceptLedgerId) {
      const old = this.db.ledger.find((l) => l.id === exceptLedgerId);
      if (old && old.fund_id === fundId) bal = round2(bal + (old.dir === 'in' ? -old.amount : old.amount));
    }
    if (amount > bal) w.push(`${f.name} has ${fmt(bal)}. This takes it to ${fmt(round2(bal - amount))}.`);
    if (f.restricted) {
      if (f.team_id && category && category !== 'Robotics Teams') w.push(`${f.name} is restricted to its team. "${category}" is not a team cost.`);
      else if (!f.team_id) w.push(`${f.name} is restricted money: ${f.purpose || 'check the gift terms'}. Make sure this spend fits.`);
    }
    return w;
  }
}

function fmt(n: number) {
  const neg = n < 0;
  return (neg ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
