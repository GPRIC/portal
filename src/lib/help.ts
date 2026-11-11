// "About This Page" text for each board page (from the demo's shared/help.js, updated for the live portal).
export type About = { purpose: string; steps: string[]; who: string };

const WHO = 'Board members only. Signing in needs your password and your authenticator code.';

export const HELP: Record<string, About> = {
  people: {
    purpose: 'Everyone who can sign in to the board side of the portal: board members, the bookkeeper and the CPA. Add people, change what they can do, and turn their access off when they leave. Only you see this page.',
    steps: [
      'Add Person sends an invite email. They set a password and an authenticator code, then see what their role allows.',
      'Treasurer: everything. Board: sees the books, approves and votes. Bookkeeper: pays, reviews and reconciles. CPA: reads and exports only, and never sees contact details.',
      'Tick Direct Expenses for a board member who may record money already spent by debit card or check. The Treasurer and the bookkeeper can always do this.',
      'Click a person to change their role, turn access off (with a reason) or back on, or resend an invite they never used. Nothing is deleted; their name stays on everything they did.',
      'The portal sends only a few emails an hour. If an invite does not go out, the person shows as Invite Not Sent; use Resend Invite later.',
      'You cannot turn off or change your own seat, so the portal always has a Treasurer. Coaches and team treasurers are invited from Requests, under Teams.',
      'Every change here is recorded in History, under People.',
    ],
    who: 'The Treasurer only. Signing in needs your password and your authenticator code.',
  },
  dashboard: {
    purpose: 'Your first screen: what needs a decision or a filing now, then the headline money figures.',
    steps: [
      'Needs Attention lists the most urgent items first: deadlines, overdue receipts, votes, payments, renewals and thank-you notes.',
      'Click any item to go to the page where you deal with it.',
      'The cards below show cash, money in and out, grants and requests. Hover a card to see the detail behind the number.',
      'Every figure is calculated from the same ledger, so every page agrees.',
    ],
    who: WHO,
  },
  history: {
    purpose: 'Every action in the portal, recorded by the database itself: adds, changes, archives, approvals, payments, imports, month locks, invites, sign-ins and sign-outs. Nothing is left out and nothing can be edited or removed.',
    steps: [
      'History opens on the last 7 days. Pick Last 30 Days or All Time, or open Filters to narrow by who, what or action. Search finds a record, a person or a change.',
      'Click a row to see the record before and after the change, field by field, the device it came from, and a link to every change ever made to that record.',
      'Imports and automatic jobs (the Zeffy sync, a statement import) show as System, with who started them.',
      'The Treasurer can roll back a change, with a reason. Money is never edited in place: a ledger entry is reversed, a payment is reversed before its request steps back, and a reconciled month is unlocked. The roll back is itself a new row in History.',
    ],
    who: WHO + ' Team logins see their own team’s history, read only.',
  },
  ledger: {
    purpose: 'Every dollar in and out, by fund, with cash on hand split into restricted and unrestricted money. The accounting software stays the official books; this is the working ledger.',
    steps: [
      'The Funds table shows each fund\'s starting balance, money in, money out and balance. Click a fund to list only its transactions.',
      'Use the pills to see money in, money out, or expenses missing a receipt.',
      'Add Expense records a payment; Record Money In records money that is not a donor gift (interest, fees, an opening balance).',
      'Spending more than a fund holds, or spending restricted money on something else, shows a warning. It never stops you saving.',
      'Click any row to edit it, attach a receipt file, or delete it.',
    ],
    who: WHO,
  },
  donors: {
    purpose: 'Everyone who gives, with names, what they gave, where it went and whether we thanked them.',
    steps: [
      'Filter with the pills: monthly givers, family foundations, sponsors, grantmakers, anonymous, or thank-you due.',
      'Click a donor to see each gift, mark gifts thanked, change their privacy choices, edit or delete them.',
      'Log Donation records a new gift and its ledger entry together.',
      'Anonymous donors are never named outside the board.',
    ],
    who: WHO,
  },
  grants: {
    purpose: 'Every grant from first idea to money in the bank: deadlines, who applied as whom, whether the board saw it, and what is still to arrive.',
    steps: [
      'Use the coloured pills to filter by stage. Click any column heading to sort.',
      'Click a grant to change any detail, attach files, record a payment received, or delete it.',
      'Recording a payment adds a gift from the funder and a ledger entry at once.',
      'New Grant adds a prospect.',
    ],
    who: WHO,
  },
  requests: {
    purpose: 'Every money request in one queue: pre-approvals before a team spends, reimbursements after someone paid out of pocket, and direct expenses the board already paid by debit card or check. Board members approve, the treasurer pays, the bookkeeper reviews direct expenses, and receipts close the loop.',
    steps: [
      'Teams send requests from their Team Portal. New Request enters one on a team\'s behalf.',
      'New Direct Expense logs a purchase already paid by debit card or check, charged to GPRIC General or a team fund, with any number of invoices. Only the Treasurer, the bookkeeper and officers the Treasurer names can file one. The bookkeeper\'s Mark Reviewed posts it to that fund\'s ledger as already paid.',
      'Needs Action lists what is waiting. Open a request to approve or decline it. Up to the threshold one approval is enough; over it, two. The gear sets the rules. Filters narrows by type.',
      'Nobody approves their own request, and each board member approves once. A board member who is also the requestor is marked.',
      'Record Payment records how it was paid (Zelle, check, debit card or ACH), the date and the confirmation or check number, and writes one ledger entry for the whole request.',
      'Cancel Request withdraws a request before it is paid (a reason is required; nothing posts to the books) and can reorder it as a new request linked both ways. Record Refund puts money back into the same fund on a paid request.',
      'A paid pre-approval has 60 days for receipts; the team adds them in its portal. A team with receipts past due cannot send new requests until they are in.',
      'Receipts Complete returns any unspent money to the team\'s fund and closes the request. A reimbursement already has its receipt and is done when paid.',
    ],
    who: WHO,
  },
  balances: {
    purpose: 'What each team has, built the same way as the treasurer\'s workbook: carry-over, Zeffy gifts, deposits, reimbursements and direct expenses. Also the Zeffy connection and the monthly bank match.',
    steps: [
      'Each row is one team\'s fund, with the general fund at the bottom. Click a column heading to sort, or a row to see every transaction behind it.',
      'Awarded, Not Received lists grants that are promised but are not cash; they never count in the bank balance.',
      'Zeffy gifts arrive by themselves once the Zeffy key is set. Until then, Import Zeffy File takes the All Payments export. Gifts with no Fund in Zeffy wait under Unassigned Gifts.',
      'Monthly Reconciliation: upload the Citizens statement, enter its ending balance, and match bank lines to portal entries. When the difference is $0.00 the month can be marked reconciled, and it locks.',
      'Quarterly Export saves every record to a spreadsheet file for the accountant.',
    ],
    who: WHO,
  },
  team: {
    purpose: 'Your team\'s money at GPRIC: what you have, what is waiting on the board, and the gifts given to your team.',
    steps: [
      'Available Balance is your carry-over plus Zeffy gifts and deposits, less reimbursements and direct expenses.',
      'New Request: choose Pre-Approval before you spend, or Reimbursement after you paid yourself (attach the receipt).',
      'The board approves requests; up to the threshold one approval is enough, over it two. Declined requests show the board\'s reason, and you can resubmit.',
      'After a pre-approval is paid, add the receipts within the receipt window. While any are past due, new requests are paused.',
      'Profile keeps your name and the Zelle contact used to pay you.',
    ],
    who: 'Coaches and team treasurers of this team only. Signing in needs your password and your authenticator code.',
  },
  meetings: {
    purpose: 'Board meetings and email votes, with agendas, minutes, every vote\'s tally and who stepped out for a declared interest.',
    steps: [
      'Add Meeting schedules a meeting. Click one to edit it, upload the agenda or minutes, record a vote, or delete it.',
      'Votes recorded on Requests appear here automatically.',
      'Board Members lists who votes, their seat, and any declared interest in a team.',
    ],
    who: WHO,
  },
  documents: {
    purpose: 'All of GPRIC\'s paperwork in one place: formation records, IRS and state filings, policies, contracts, grant files and minutes.',
    steps: [
      'Filter by type with the pills. Click a document name to open it.',
      'Click elsewhere on a row to edit its type, date, link or public setting, replace the file, or delete it.',
      'Upload Document adds a file, or a link to one kept elsewhere.',
      'Public marks a document as fine to show on the public site.',
    ],
    who: WHO,
  },
  accounts: {
    purpose: 'Everything GPRIC is signed up for in one list: what it is for, which shared email owns it, who can manage it, what it costs and when it renews.',
    steps: [
      'Click a service to see or change its details, or delete it.',
      'Renewing Soon flags anything due in the next 30 days. One Admin flags services only one person can get into.',
      'Passwords are never kept here. They live in Bitwarden.',
      'Add Account records a new service.',
    ],
    who: WHO,
  },
};
