// Row shapes for the portal tables (supabase/migrations/0001_portal_schema.sql).
// numeric columns arrive from PostgREST as numbers or strings; db.ts converts them to numbers on load.

export type Settings = { id: number; org: string; short: string; ein: string | null; fy_start: string; fy_label: string; receipt_days: number;
  approval_threshold: number; approvals_under: number; approvals_over: number; general_fund_id: string | null;
  bookkeeper_can_approve?: boolean;
};

/** Board-side roles (0004_money_rules.sql). Approval rules, month unlock and overrides are the Treasurer's. */
export type Role = 'treasurer' | 'board' | 'bookkeeper' | 'cpa';
export const ROLE_LABEL: Record<Role, string> = { treasurer: 'Treasurer', board: 'Board', bookkeeper: 'Bookkeeper', cpa: 'CPA (read only)' };

/** Records are archived, never deleted. */
type Archive = { archived_at?: string | null; archived_by?: string | null; archive_reason?: string | null };
type Base = { id: string; sample: boolean; created_at?: string } & Archive;

export type Team = Base & {
  name: string; short: string; program: string | null; level: string | null; season: string | null; fund_id: string | null;
  pay_mode: string | null; ein: string | null; school: string | null; students: number | null; affiliated: string | null; blurb: string | null; zeffy_name: string | null;
};
export type Fund = Base & { name: string; restricted: boolean; team_id: string | null; purpose: string | null };
export type Member = Base & {
  name: string; title: string; email: string | null; interest_team_id: string | null; interest_note: string | null; active: boolean; sort: number;
};
export const GRANT_STATUSES = ['Prospect', 'Drafting', 'Applied', 'Awarded', 'Declined'] as const;
export type Grant = Base & {
  funder: string; program: string; ask: number; awarded: number; received: number; status: (typeof GRANT_STATUSES)[number];
  deadline: string | null; applied_as: string | null; owner: string | null; board_saw: string | null; fund_id: string | null;
  purpose: string | null; public: boolean; likelihood: number; notes: string | null;
};
export const DONOR_TYPES = ['Individual', 'Family Foundation', 'Corporate Sponsor', 'Grantmaker'] as const;
export type Donor = Base & {
  name: string; type: (typeof DONOR_TYPES)[number]; giving: string | null; channel: string | null; anonymous: boolean; public: boolean;
  since: string | null; grant_id: string | null; notes: string | null; email: string | null;
};
export type Donation = Base & {
  donor_id: string; date: string; amount: number; fund_id: string; channel: string | null; recurring: boolean; grant_id: string | null; thanked: boolean;
  zeffy_id: string | null; zeffy_key: string | null; payout_date: string | null; zeffy_status: string | null; zeffy_method: string | null;
  fund_raw: string | null; unassigned: boolean; refunded: number;
};
export type Meeting = Base & {
  date: string; kind: 'Regular' | 'Special' | 'Annual' | 'Email Vote'; title: string; status: 'Scheduled' | 'Minutes Draft' | 'Minutes Approved';
  present: string[]; summary: string | null;
  agenda_link: string | null; agenda_path: string | null; agenda_name: string | null;
  minutes_link: string | null; minutes_path: string | null; minutes_name: string | null;
};
export type Ballot = 'Yes' | 'No' | 'Abstain' | 'Out';
export type Vote = Base & {
  meeting_id: string; item: string; request_id: string | null; result: 'Approved' | 'Declined'; yes: number; no: number; abstain: number;
  stepped_out: string[]; ballots: Record<string, Ballot> | null; note: string | null; sort: number;
};
export const REQUEST_STATUSES = ['Draft', 'Submitted', 'Board Vote', 'Approved', 'Declined', 'Paid', 'Receipts Due', 'Closed', 'Reviewed', 'Cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_TYPES = ['Pre-Approval', 'Reimbursement', 'Direct Expense'] as const;
/** How a direct expense was paid (0006_requests_v2.sql). */
export const DIRECT_PAY = ['Debit Card', 'Check'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const PAY_METHODS = ['Zelle', 'Check', 'Debit Card', 'ACH'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
/** What a team request can be spent on (the treasurer's workbook categories). */
export const REQUEST_CATEGORIES = ['Registration Fees', 'Robot Parts & Construction', 'Tools & Shop Supplies', 'Marketing & Outreach', 'General Operations'] as const;
/** How a pre-approval is paid out. */
export const PAY_TO = ['Vendor directly', 'Me by Zelle', 'Team EIN account', 'School or district'] as const;
export type TeamRequest = Base & {
  /** Null for a direct expense, which belongs to the fund it is charged to (charge_fund_id). */
  team_id: string | null; purpose: string; category: string | null; amount: number; pay_to: string | null; needed_by: string | null; submitted: string | null;
  status: RequestStatus; interested_member_id: string | null; vote_id: string | null; paid_date: string | null; receipts_done: string | null;
  returned: number; decline_reason: string | null; created_by: string | null; notes: string | null;
  type: RequestType; vendor: string | null; purchase_date: string | null; zelle_contact: string | null; team_ledger_ref: string | null;
  receipt_path: string | null; receipt_name: string | null; certified: boolean; submitted_by_user: string | null;
  requestor_name: string | null; requestor_email: string | null; requestor_member_id: string | null;
  pay_method: PayMethod | null; pay_ref: string | null; declined_by: string | null; declined_at: string | null;
  /** Direct expenses (0006): the fund charged, and the bookkeeper's review. */
  charge_fund_id?: string | null; reviewed_at?: string | null; reviewed_by?: string | null;
  /** Cancelled before payment (0006), and the replacement order links, both ways. */
  cancel_reason?: string | null; cancelled_at?: string | null; cancelled_by?: string | null;
  replaces_id?: string | null; replaced_by_id?: string | null;
};
/** Money back on a paid request (0006): a ledger 'in' row (source Refund) into the fund that paid it. */
export type Refund = Base & {
  request_id: string; amount: number; date: string; reason: 'Returned' | 'Cancelled'; note: string | null; ledger_id: string | null; by_name: string | null;
};
/** A missing-receipt reminder (0011): flagged in the portal only; nothing is emailed. */
export type Reminder = Base & { request_id: string; note: string | null; by_name: string | null };
/** One board member's approval of a request (written only by approve_request). */
export type Approval = { id: string; request_id: string; user_id: string; member_id: string | null; approver_name: string; approved_at: string; sample: boolean };
export type Ledger = Base & {
  date: string; dir: 'in' | 'out'; amount: number; fund_id: string; source: string | null; category: string | null; party: string | null;
  donor_id: string | null; memo: string | null; donation_id: string | null; request_id: string | null; grant_id: string | null;
  receipt: boolean; receipt_path: string | null; receipt_name: string | null; pay_method: string | null; pay_ref: string | null;
  /** A reversal points at the entry it undoes; the undone entry points back at its reversal. */
  reverses_id: string | null; reversed_by_id: string | null; reason: string | null;
};
export type Receipt = Base & {
  request_id: string; vendor: string | null; amount: number; date: string; file_name: string | null; file_path: string | null; uploaded_by: string | null;
};
export type Account = Base & {
  service: string; purpose: string | null; owner_email: string | null; admins: string[]; plan: string | null; cost: number;
  period: 'Month' | 'Year' | 'None'; renewal: string | null; payment_method: string | null; discount: string | null; status: string; notes: string | null;
};
export const DOC_TYPES = ['Formation', 'IRS', 'State', 'Policy', 'Contract', 'Grant', 'Board', 'Finance'] as const;
export type Doc = Base & {
  title: string; type: (typeof DOC_TYPES)[number]; date: string | null; linked_to: string | null; public: boolean; link: string | null;
  file_path: string | null; file_name: string | null; added_by: string | null; notes: string | null;
};

export type TeamUser = { id: string; user_id: string; team_id: string; role: 'Coach' | 'Treasurer'; name: string | null; email: string | null; zelle_contact: string | null; added_at: string };
export type TeamInvite = { id: string; team_id: string; email: string; name: string | null; role: 'Coach' | 'Treasurer'; invited_by: string | null; invited_at: string; user_id: string | null; sample: boolean } & Archive;
export type BankStatement = Base & {
  month: string; file_path: string | null; file_name: string | null; ending_balance: number | null; difference: number | null;
  locked_at: string | null; locked_by: string | null; notes: string | null;
  unlocked_at?: string | null; unlocked_by?: string | null; unlock_reason?: string | null;
};
export type BankLine = Base & { statement_id: string; date: string; description: string | null; amount: number; matched_ledger_id: string | null; matched_payout_date: string | null };
export type ZeffySync = { id: string; ran_at: string; source: 'api' | 'file' | 'webhook'; inserted: number; updated: number; skipped: number; error: string | null };

/** One fund's figures from portal_totals(). */
export type FundTotal = { id: string; name: string; restricted: boolean; team_id: string | null; opening: number; inn: number; out: number; carry: number;
  zeffy: number; deposits: number; reimbursements: number; direct: number; balance: number; committed: number; available: number };
/** Every money figure the board pages show, worked out once in the database (portal_totals). */
export type Totals = { funds: FundTotal[]; cash: { total: number; restricted: number; unrestricted: number };
  in_by_source: Record<string, number>; out_by_category: Record<string, number>; raised: number; spent: number };

export type Db = {
  settings: Settings;
  totals: Totals;
  /** The signed-in person's role (null only if access was removed mid-session). */
  role: Role | null;
  /** May file a direct expense: the Treasurer, the bookkeeper, or an officer the Treasurer names (can_file_direct). */
  canFileDirect: boolean;
  teams: Team[]; funds: Fund[]; board_members: Member[]; grants: Grant[]; donors: Donor[]; donations: Donation[];
  meetings: Meeting[]; meeting_votes: Vote[]; team_requests: TeamRequest[]; ledger: Ledger[]; receipts: Receipt[];
  accounts: Account[]; documents: Doc[];
  request_approvals: Approval[]; team_users: TeamUser[]; team_invites: TeamInvite[]; bank_statements: BankStatement[]; bank_lines: BankLine[];
  zeffy_sync_log: ZeffySync[]; request_refunds: Refund[]; receipt_reminders: Reminder[];
};
export type TableName = Exclude<keyof Db, 'settings' | 'canFileDirect'>;
export const TABLES: TableName[] = ['teams', 'funds', 'board_members', 'grants', 'donors', 'donations', 'meetings', 'meeting_votes',
  'team_requests', 'ledger', 'receipts', 'accounts', 'documents', 'request_approvals', 'team_users', 'team_invites', 'bank_statements',
  'bank_lines', 'zeffy_sync_log', 'request_refunds', 'receipt_reminders'];
