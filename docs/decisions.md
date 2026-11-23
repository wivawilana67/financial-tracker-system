# Migration decisions

Decisions for moving the Financial Tracker off Google Sheets and Apps Script. Agreed with the
owner on 2026-11-22. Each entry gives the decision and the reason for it. Facts marked
**Verified** were checked on a vendor page on 2026-11-22; **Unverified** means check before
relying on it.

This repository is public until the end of the migration. Never write project IDs, project
numbers, account emails, URLs of deployed services or financial figures here.

## Goal

- **D1. Leave Sheets and Apps Script completely.**
  Reason: the 6-minute execution limit, the Sheet as a database, clasp deploys, and room to grow.
  After cutover the Sheet is kept as a frozen, view-only copy of the data before the migration.

## Stack

- **D2. Same stack as the Foodies repo.**
  React + TypeScript + Vite PWA on Firebase Hosting; Django + Django REST Framework in one Docker
  image on Cloud Run; Neon Postgres; Google Sign-In; GitHub Actions with Workload Identity
  Federation.
  Reason: it's already set up and working there (verified 2026-11-21/22), so this migration
  reuses a known pattern instead of a new one. The VM option was dropped for the same reason.
- **D3. Cloud Run in `asia-southeast1` (Singapore), min 0 / max 2 instances, 512 MiB.**
  Reason: near Indonesia and the database, and it scales to zero so it costs about nothing.
  Singapore is a Tier 2 region. Its free allowance is **Unverified**; for two users the usage
  is negligible either way.
- **D4. Firebase Hosting serves the app and rewrites `/api/**` to Cloud Run.**
  Reason: one address for the app and the API, so no CORS.
- **D5. One responsive PWA: a phone layout plus a wider desktop layout.**
  Reason: the monthly work (Generate Monthly Data, Monthly Data form, Simulation) moves off the
  Sheet and is easier on a big screen. No native app.

## Environments

- **D6. Two environments, `dev` and `prod`.**
  One Google Cloud/Firebase project each (`financial-tracker-system-dev`,
  `financial-tracker-system-prod`) on the same billing account
  as Foodies. `develop` deploys to dev; `master` deploys to prod, through a PR as today.
  Reason: same split as today's TEST/PROD, with names that match the Foodies pattern.
- **D7. Fully separate from Foodies: own Google Cloud projects, own Neon project.**
  Reason: one app's mistake can't touch the other's data. The Neon Free plan allows 100
  projects (**Verified**), so a second project is free.
- **D8. Dev uses fake, generated data only, and never reads real Gmail.**
  Reason: today's TEST Sheet holds a full copy of real finances. Dev sync runs against stored
  sample emails instead.

## Data

- **D9. Neon project `financial-tracker-system` in AWS `ap-southeast-1`, branches `prod` and `dev`,
  database `financial_tracker`, one login role each (`app_prod`, `app_dev`), pooled connection string.**
  Reason: next to Cloud Run; the pooler suits Cloud Run's short-lived instances.
- **D10. Import all history: every ledger row, Income, CC Transaction and Blu Balance.**
- **D11. Money is stored as `Decimal`, never as a float.**
  Reason: rupiah totals have to match the Sheet to the last digit during reconciliation.
- **D12. The Master sheet becomes tables (people, channels, categories per ledger, income
  categories, budget targets).**
  Today the budget targets are 40 % Saving, 50 % Expense and 10 % Ibadah, from
  `buildDashboardCards_` in `TemplateGenerator.js`.
- **D13. "CC Tracker" becomes a view of unsettled card transactions, not a separate table.**
  Reason: today the tracker is a weekly sheet whose rows get deleted to clean up. In a database,
  paid and cancelled are flags, so nothing has to be deleted.
- **D14. Blu Balance migrates as a Wallet screen (accounts, entries, installment payments).**

## Business rules

- **D15. Exact parity first.**
  Rollover, installments, jajan allocation and adjustment, paid status, simulation and ledger
  ordering behave exactly as the README describes. They are ported with tests built from the
  README's worked examples and checked against the Sheet. Redesign comes after launch.
- **D16. Paid status becomes a direct save in the app.**
  The daily `updatePaidStatus` trigger and the Dashboard tick boxes go away.

## Gmail extraction

- **D17. A Python job reads two personal @gmail.com inboxes through the Gmail API.**
  Each inbox owner connects once through a "Connect Gmail" page (offline access, read-only
  Gmail scope). Each inbox's refresh token lives in its own Secret Manager secret, never in the
  database or the repo. The `CC_SOURCES` pattern and `parseBcaCcEmail_` from `CcSync.js` are
  ported to a parser registry. The seven-column fingerprint stays as a unique constraint, so a
  re-sync adds nothing.
- **D18. Daily sync of yesterday, plus manual Sync Today and custom-range buttons.**
  No real-time push.
- **D19. Parse failures appear in a "needs review" list in the CC screen.** No push or email.
- **D20. Gmail access is the biggest risk, so it gets tested in phase 1.**
  Facts found on 2026-11-22:
  - **Verified:** an External app in "Testing" status gets refresh tokens that expire 7 days
    after consent. Switching to "In production" avoids that; tokens issued during Testing must
    be issued again.
  - **Verified:** an unverified app is limited to 100 new users and shows a warning screen.
    Google's help says apps for fewer than 100 users can keep running without verification.
  - **Unverified:** whether Google's policy that production apps with restricted scopes must be
    verified blocks a two-person app in practice. Also unverified: that the read-only Gmail
    scope is classed as restricted.
  - **Verified:** "Personal" mode skips verification but only works for the developer alone, so
    it fits only if both inboxes belong to the owner.

  Fallback if Google blocks it: keep a tiny Apps Script that only reads Gmail and posts the
  parsed transactions to the API. That's the one piece of Apps Script that would stay.

## Scheduled work

- **D21. One Cloud Scheduler job in prod starts one `nightly` Cloud Run Job.**
  The job runs three steps independently: database backup, card sync, and on the 1st only, a
  draft of next month. Dev has no scheduler; jobs are run by hand.
  Reason: Cloud Scheduler gives 3 free jobs per billing account, not per project, then $0.10 per
  job per month (**Verified**). That allowance is shared with Foodies.
- **D22. Next month's rollover is prepared as a draft on the 1st, and you confirm it in the app.**
  The job never writes to the ledgers on its own.

## Security and backups

- **D23. Google Sign-In only: a verified Google ID token plus an allowlist of the two emails.**
  The shared `API_TOKEN` is retired.
- **D24. No field-level encryption; Neon's own encryption is enough.**
  Card numbers already arrive masked by the bank: the parser reads `Nomor Kartu` as `[0-9X]+`.
- **D25. Nightly `pg_dump` to a private `us-central1` bucket, kept 30 days, with a practised
  restore.**
  The Neon Free plan only keeps a 6-hour history window (**Verified**), so the nightly dump
  covers anything older.
- **D26. Audit log of every change, and an edit is refused if the record changed since it was
  opened.**
  This replaces today's row signature guard.

## Naming

- **D30. Cloud resources are named after the repo.** Google Cloud/Firebase projects
  `financial-tracker-system-dev` / `-prod` (if an ID is taken, Google adds a suffix; the deploy
  workflow reads the ID from a GitHub variable, so any ID works). Artifact Registry repository
  `financial-tracker-system`, Cloud Run service `financial-tracker-system-api`, migrate job
  `financial-tracker-system-migrate`, Neon project `financial-tracker-system`, database
  `financial_tracker` (underscore: Postgres names can't hold a hyphen without quoting).

## Cutover and repository

- **D27. One-day freeze for the switch.**
  Stop editing the Sheet, run the final import, reconcile counts and totals, switch both phones,
  then make the Sheet view-only.
- **D28. New code goes in `api/` and `frontend/`, next to the Apps Script files, until cutover.**
  `.claspignore` needs no change: its `!*.js` rule only matches files at the root. Checked on
  2026-11-22 by running clasp 3.3.0's own matcher over the repo; it keeps only the root Apps
  Script files. At retirement, remove the Apps Script files, `web/`, `scripts/` and the clasp
  configs, and rewrite `README.md` and `CLAUDE.md`.
- **D29. The repo goes private at the end.**
  GitHub Free has no environments for private repos, so the deploy variables move to repository
  level, and the branch lock stays in the Workload Identity provider condition.
