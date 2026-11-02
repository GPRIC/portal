# GPRIC Board Portal

The private board portal for the Grosse Pointe Robotics And Innovation Center: dashboard, ledger, donors, grants,
team requests, meetings and votes, documents, and the accounts register. It lives at **portal.gpric.net**.

- **App:** Next.js on Vercel (Hobby). Light and dark themes; the toggle sits in the top bar.
- **Data:** Supabase project `gpric-portal`. Every table has row security. Only an **invited** user who has
  passed **two-step sign-in** can read or change anything. Files (receipts, grant papers, agendas, minutes,
  documents) go in the private `board-files` bucket under the same rule.
- **Sign-in:** invite only. Email and password, then a 6-digit code from an authenticator app.
- **Sample data:** the portal starts with the demo's made-up rows, all tagged as sample. A "Sample data · Clear"
  button sits bottom right while any are left. Clearing keeps anything the board entered.

Passwords and keys never go in this repository. Logins live in Bitwarden.

## Going live

These steps are done by the Treasurer in each service's own dashboard.

### 1. Database (once)

In Supabase, project `gpric-portal`, SQL Editor, run in order:

1. `supabase/migrations/0001_portal_schema.sql` (tables, row security, actions, file bucket)
2. `supabase/migrations/0002_sample_data.sql` (the sample rows)

### 2. Supabase sign-in settings

Authentication, in the Supabase dashboard:

- **Sign In / Providers:** turn **off** "Allow new users to sign up". Email stays on.
- **Multi-Factor:** TOTP (authenticator app) on. It is on by default.
- **URL Configuration:**
  - Site URL: `https://portal.gpric.net/login` (set to `http://localhost:3217` while testing before go-live)
  - Redirect URLs: `https://portal.gpric.net/**` and `http://localhost:3217/**` (the dev server port; Atlas uses 3000)
- **Emails** (recommended, so links work even when opened on another device):
  - Invite user: set the link's href to `https://portal.gpric.net/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
  - Reset password: `https://portal.gpric.net/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`

  The default email links also work; these are steadier.
- **SMTP Settings** (before inviting the board): Supabase's built-in email sends only a couple of emails an hour,
  enough to block a second invite or a password reset. Turn on custom SMTP with GPRIC's own mail sender
  (for example the gpric.net mailbox provider, or Resend). Until then, a person can be added without email:
  Users, Add user, Create new user (auto-confirm), then in the SQL Editor
  `insert into public.portal_access (user_id, email) select id, email from auth.users where lower(email) = lower('their@email');`
  Some company mail filters open links to scan them, which uses up a one-time invite link; resend, or use another address.

### 3. Vercel

1. Add New Project, import `GPRIC/portal`. Framework: Next.js. No build settings to change.
2. Environment Variables (Production and Preview), from Supabase, Project Settings, API:
   - `NEXT_PUBLIC_SUPABASE_URL` — the Project URL
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — the publishable key (`sb_publishable_...`)
3. Deploy.
4. Settings, Domains: add `portal.gpric.net`. Vercel shows the record to add.

### 4. Namecheap

Domain List, `gpric.net`, Advanced DNS, Add New Record:

- Type `CNAME`, Host `portal`, Value: the target Vercel shows (usually `cname.vercel-dns.com`), TTL Automatic.

Vercel issues the certificate once the record is seen.

### 5. Invite the board

Supabase, Authentication, Users, **Invite user**, one email at a time. Each person:

1. Opens the invite email and chooses a password (saved in Bitwarden).
2. Scans the code with an authenticator app (Microsoft Authenticator, Google Authenticator, Authy or Bitwarden).
3. Lands on the dashboard.

An invited user gets portal access automatically. To remove someone, delete them under Authentication, Users.
To reset a lost phone: open the user, remove their MFA factor; they set two-step up again at next sign-in.

Then add each person under Meetings, Board Members (name, title, seat order, any team interest) so votes list them.

## Developing

```bash
npm install
cp .env.example .env.local   # then fill in the two values
npm run dev
```

Checks before a commit: `npx tsc --noEmit`, `npx eslint src`, `npm run build`.

`scripts/build-sample-sql.mjs <demo>/data/db.js` regenerates `0002_sample_data.sql` from the demo data.
The sample documents in `sample-docs/` are served at `/sample-docs/<name>` to signed-in board members only.
