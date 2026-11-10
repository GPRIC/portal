// Every figure a page shows comes through here, so every page agrees. Money totals (fund balances, cash, the year's
// money in and out) are worked out once in the database by portal_totals() (0004_money_rules.sql); this class reads them.
import type { Db, Donation, Fund, FundTotal, Grant, Ledger, Member, Team, TeamRequest } from './types';
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

  /** A fund's figures from portal_totals (zeros for a fund with no entries yet). */
  fundTotal(fid: string | null | undefined): FundTotal | null { return this.db.totals.funds.find((x) => x.id === fid) || null; }
  fundBalance(fid: string | null | undefined): number { return this.fundTotal(fid)?.balance ?? 0; }
  /** Money left after requests already approved but not yet paid. */
  fundAvailable(fid: string | null | undefined): number { return this.fundTotal(fid)?.available ?? 0; }
  funds(): FundRow[] {
    return this.db.funds.map((f) => {
      const t = this.fundTotal(f.id);
      return { fund: f, opening: t?.opening ?? 0, inn: t?.inn ?? 0, out: t?.out ?? 0, balance: t?.balance ?? 0 };
    });
  }
  cash() { return { ...this.db.totals.cash, funds: this.funds() }; }
  /** Money in by source this fiscal year (excludes opening balances, returned team money and refunds). */
  inBySource(): Record<string, number> { return this.db.totals.in_by_source; }
  /** Money out by category this fiscal year; returned team money and refunds net against what they were spent on. */
  outByCategory(): Record<string, number> { return this.db.totals.out_by_category; }
  raised() { return this.db.totals.raised; }
  spent() { return this.db.totals.spent; }
  /** An entry that was undone, or the entry that undoes another. */
  isReversed(l: Ledger) { return !!l.reversed_by_id; }
  isReversal(l: Ledger) { return !!l.reverses_id; }

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
    const ft = this.fundTotal(t.fund_id);
    return { balance: ft?.balance ?? 0, approvedUnpaid: ft?.committed ?? 0, available: ft?.available ?? 0 };
  }
  interestedMember(tid: string): Member | null {
    return this.board().find((m) => m.interest_team_id === tid) || null;
  }
  needsVote(r: TeamRequest) { return r.type !== 'Direct Expense' && (r.status === 'Submitted' || r.status === 'Board Vote'); }

  /* requests v2 (0006): direct expenses, refunds, replacement orders */
  isDirect(r: Pick<TeamRequest, 'type'>) { return r.type === 'Direct Expense'; }
  /** A direct expense waiting for the bookkeeper's review. */
  needsReview(r: TeamRequest) { return this.isDirect(r) && r.status === 'Submitted'; }
  /** The fund a request is charged to: the chosen fund of a direct expense, or the team's fund. Mirrors request_fund(). */
  requestFundId(r: TeamRequest) { return r.charge_fund_id || this.team(r.team_id)?.fund_id || null; }
  /** "Charge To" as the Requests page shows it. */
  chargeTo(r: TeamRequest) {
    if (r.charge_fund_id) return r.charge_fund_id === this.db.settings.general_fund_id ? 'GPRIC General' : this.fundName(r.charge_fund_id);
    return this.team(r.team_id)?.name || this.fundName(this.requestFundId(r)) || '—';
  }
  /** Funds a direct expense can be charged to: GPRIC General first, then the team funds. Mirrors direct_charge_ok(). */
  directFunds(): Fund[] {
    const gen = this.db.settings.general_fund_id;
    const ok = this.db.funds.filter((f) => f.id === gen || f.team_id || this.db.teams.some((t) => t.fund_id === f.id));
    return ok.sort((a, b) => (a.id === gen ? -1 : b.id === gen ? 1 : a.name.localeCompare(b.name)));
  }
  refundFor(rid: string) { return this.db.request_refunds.find((x) => x.request_id === rid) || null; }
  /** The request's payment row in the ledger (one per request). */
  paymentFor(rid: string) { return this.db.ledger.find((l) => l.request_id === rid && l.dir === 'out' && !l.reverses_id && !l.reversed_by_id) || null; }

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
  /** The kind of money an entry is; a reversal counts as the kind of the entry it undoes. */
  kindOf(l: Ledger): MoneyKind {
    const dir = l.reverses_id ? (l.dir === 'in' ? 'out' : 'in') : l.dir;
    const req = l.request_id ? this.request(l.request_id) : null;
    const spentKind: MoneyKind = !l.request_id || (req && this.isDirect(req)) ? 'Direct Expense' : 'Reimbursement';
    if (dir === 'in') {
      if (l.source === 'Opening Balance') return 'Carry-Over';
      // a refund nets against the spending it returns (as portal_totals does)
      if (l.source === 'Refund') return spentKind;
      return this.donation(l.donation_id)?.channel === 'Zeffy' ? 'Zeffy' : 'Deposit';
    }
    return spentKind;
  }
  donation(id: string | null | undefined): Donation | null { return id ? this.db.donations.find((d) => d.id === id) || null : null; }
  fundMoney(f: Fund): MoneyRow {
    const t = this.fundTotal(f.id);
    return { fund: f, team: this.db.teams.find((x) => x.fund_id === f.id) || this.team(f.team_id),
      carry: t?.carry ?? 0, zeffy: t?.zeffy ?? 0, deposits: t?.deposits ?? 0, reimbursements: t?.reimbursements ?? 0, direct: t?.direct ?? 0,
      balance: t?.balance ?? 0 };
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
  /** The items behind a month's figures, for the reconciliation tips: money out not yet cleared and Zeffy gifts in
   *  transit. The figures themselves (book balance, totals, expected bank balance) come from bank_month_figures. */
  reconcile(monthEnd: string) {
    const cleared = this.clearedIds();
    // An entry reversed by month end never reached the bank, so it and its reversal are left out (as bank_month_figures does).
    const reversedBy = (l: Ledger) => { const z = l.reversed_by_id ? this.db.ledger.find((x) => x.id === l.reversed_by_id) : null; return !!z && z.date <= monthEnd; };
    const outstanding = this.db.ledger.filter((l) => l.date <= monthEnd && l.dir === 'out' && !l.reverses_id && !reversedBy(l) && !cleared.has(l.id) && l.source !== 'Opening Balance');
    return { outstanding, transit: this.inTransit(monthEnd) };
  }
  /** The month a date falls in is reconciled and locked. */
  lockedMonth(iso: string) { return this.db.bank_statements.some((s) => s.locked_at && s.month === iso.slice(0, 7) + '-01'); }

  /** The money rules for money going out of a fund (spend_check in the database). Breaking one blocks the save unless the Treasurer overrides. */
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
