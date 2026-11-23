# API (Django + Django REST Framework)

The new backend that replaces the Apps Script web app. See `docs/decisions.md` for why, and the
root `README.md` for how it fits with the rest of the repo.

* **Runtime**: Python 3.14, Django 6.1, DRF 3.18, gunicorn. Dependencies are managed by
  [uv](https://docs.astral.sh/uv/) in this folder only (`pyproject.toml` + `uv.lock`); the
  virtual environment is `api/.venv` (gitignored).
* **Docker**: one image (`Dockerfile`) serves the API, the migrate job and later the nightly job.
  `docker build --target test api` runs the tests inside the image; the final stage is the
  runtime image.

## Run

From the repo root, the easiest way is docker compose (Postgres + API + web app):

```bash
cp .env.example .env      # fill in GOOGLE_CLIENT_ID and ALLOWED_EMAILS
docker compose up --build
```

Without Docker (SQLite, for quick checks):

```bash
cd api
uv sync
uv run pytest
uv run python manage.py runserver
```

## Routes

Everything lives under `/api/`, so Firebase Hosting's `/api/**` rewrite reaches all of it.

| Route | Sign-in | Returns |
| --- | --- | --- |
| `GET /api/health` | No | `{status, env, version}`. Never touches the database. |
| `GET /api/health/db` | Yes | `{status, database}` after a `SELECT 1` (wakes Neon). |
| `GET /api/session` | Yes | `{email, env, month}`; `month` is the current `YYYY-MM` in Asia/Jakarta. |
| `/api/admin/` | Django login | Django admin (static files at `/api/static/`). |

## Sign-in (`core/auth.py`)

Every signed-in route needs `Authorization: Bearer <Google ID token>`. The token is verified
locally against Google's certificates: audience = `GOOGLE_CLIENT_ID`, Google issuer, verified
email, not expired, and the email must be in `ALLOWED_EMAILS`. Kept from `Auth.js`:

* Callers only ever see `{"error": "Unauthorized"}`. The reason is logged; the token never is.
* A verified token is cached until 30 s before it expires (keyed by its SHA-256).
* 20 failures within 10 minutes lock out *new* tokens for the rest of the window. Tokens already
  verified keep working, so an attacker can't sign the owners out.

The old shared `API_TOKEN` is gone (D23).

## Settings (environment variables)

| Variable | local | dev / prod (Cloud Run) |
| --- | --- | --- |
| `APP_ENV` | `local` (default) | `dev` or `prod` |
| `DJANGO_SECRET_KEY` | insecure default | Secret Manager, required |
| `DATABASE_URL` | SQLite fallback, or compose's Postgres | Secret Manager (Neon pooled URL), required |
| `ALLOWED_EMAILS` | `.env` | Secret Manager, required |
| `GOOGLE_CLIENT_ID` | `.env` | env var from the deploy workflow, required |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | not needed | set by the deploy workflow (the `web.app` addresses) |
| `APP_VERSION` | `local` | the Git commit, set at build |
| `DJANGO_DEBUG` | on | must be off (start-up fails otherwise) |

On Cloud Run, a missing required value stops Django from starting, so a misconfigured revision
never serves traffic.

## Logging

One line per request on stdout (`core/middleware.py`): method, path, status, duration and the
signed-in email. Query strings, bodies and headers are never logged. Unexpected exceptions are
logged with their traceback and answered with `{"error": "Server error"}` (`core/errors.py`).

## Data (phase 2)

Models in `core/models.py` mirror the Sheet's columns: ledgers (`LedgerEntry`), income
(`IncomeEntry`) and the card log (`CcTransaction`). Money is `Decimal`. Every month is stored as
its first day, as the Sheet does.

### Sample data (dev and local only)

```bash
docker compose exec api python manage.py seed_fake_data --months 3 --end 2026-11
```

Every name carries "(sample)" or starts with "SAMPLE". The command refuses to run when
`APP_ENV=prod`. Running it twice adds nothing.

### Importing a Sheet tab

Export a tab from Google Sheets (**File → Download → Comma-separated values (.csv)**), copy the file
into the API container, and run:

```bash
docker compose exec api python manage.py import_sheet_csv ledger /path/in/container.csv --ledger expense
docker compose exec api python manage.py import_sheet_csv income /path/in/container.csv
docker compose exec api python manage.py import_sheet_csv cc /path/in/container.csv --inbox INBOX_LABEL
docker compose exec api python manage.py import_sheet_csv wallet /path/in/container.csv
```

The headers are the Sheet's own, as of 2026-11-23:

| Tab | Columns the importer reads |
| --- | --- |
| Saving, Expense, Ibadah | `Month`, `List`, `Type`, `Amount`, `Payment Channel`, `Cicilan?`, `Payment Remaining`, `Sudah Bayar?` |
| Autodeduct Jajan | same, but the owner is in `Who?` |
| Income | `Month`, `List` (the person), `Type` (the category), `Amount` |
| CC Transaction | `Datetime`, `Bank`, `Card Number`, `Description`, `Type`, `Amount`, `Currency Code` |
| Blu Balance | `Date`, `List Usage`, `Price`, `Account`, `Income?`, `Sudah Bayar?`, `Cicil / Not`, `Bulan`, and tick columns `1`–`24`. The export starts at the top of the tab; the importer skips the summary rows above the header (row 15). |

Derived columns (for example `Sisa Bulan`, `Sudah Bayar Cicilan`, the Dashboard formulas) are not
stored; the app computes them.

* Without `--commit` the command only checks the file and prints what it found.
* A bad row stops the import, and the message gives its line number. Nothing is written.
* Ledger and income imports refuse months that already hold rows. Add `--replace` to clear and
  reload just those months (all or nothing). The wallet table is refused if it already has rows.
* CC rows are deduplicated with the same fingerprint as the Sheet's CC Sync, so importing the
  same file twice is safe.
* Income people must be `Wiva` or `Jane`.

### Admin

Django's admin is at `/api/admin/` in local and dev only (`ENABLE_ADMIN`). It has its own
username and password, so it is off on Cloud Run, where only Google sign-in opens the app.
Create a local admin with `docker compose exec api python manage.py createsuperuser`.

## Monthly rules (phase 3, in progress)

Ported from `MonthlyGeneration.js` so far. Pure functions with no database access, so they can be
tested on their own:

* `core/rules/installments.py`: installment carry-forward. Reads only earlier months, uses the latest
  state per item, drops finished installments, takes one payment off per month.
* `core/rules/jajan.py`: jajan allocation. Gross share minus autodeductions, clamped at zero,
  rounded half up to whole rupiah (the Sheet's `Math.round`). Exact decimals, so the rounding is
  the only one.

* `core/rules/rollover.py`: candidates from last month (installments from any earlier month, plain
  rows from the source month only), the upsert into the target month (identity = List + Type +
  Channel; Income = person + category), the autodeduct totals (an existing row with the same
  identity is not counted twice), and the two recalculated jajan rows.
* `core/rollover_service.py`: loads the stored rows, runs those rules, and writes only when
  `apply_plan()` is called, in one transaction. Updated rows get `version + 1`; untouched rows are not
  written. A dry run is `build_plan()` alone.

* `core/rules/monthly.py` and `core/monthly_service.py`:
  * Monthly Data edits: each change carries the row's version. A stale version is skipped and reported,
    never overwritten. Autodeduction changes move the owner's Expense Jajan row by the same amount, never
    below zero. No Jajan row means a note, never a new row.
  * Target-month edits go through `apply_changes()` before a generation run, so the rollover sees them.
  * Paid marks: unpaid rows of the ticked channels, or of the ticked List + Type + Channel rows.
  * Simulation: the remaining formula and the net-jajan rule, as pure functions. The database
    payload for the simulation screen is not built yet.
  * Dashboard totals. Some formulas were read from the Sheet's cell formulas and are marked INFERRED
    in the code. They are checked against the real Sheet during the trial import (phase 7).

Not ported yet: the simulation's database payload (the screen's baseline), and the phone endpoints for
these services (phase 3 and 5 wiring).

## Card sync, nightly job and backup

* **Card sync** (`core/cc_sync.py`, `core/cc_email.py`): reads the bank notification emails of each
  connected inbox (read-only Gmail scope), parses them (BCA ported from `CcSync.js`) and stores each
  transaction once, by fingerprint. Unreadable emails go to a list with the date and reason only.
* **Gmail connection** (`core/gmail_auth.py`, `core/views_gmail.py`): each owner connects their own
  inbox once. The refresh token is stored in its own Secret Manager secret (`gmail-refresh-<hash>`),
  never in the database or the repo.
* **Nightly job** (`manage.py nightly`): backup, yesterday's card sync, and on the 1st a draft of the
  month's rollover. A draft is a summary; nothing is written to the ledgers. The job exits with status 1
  if a step fails.
* **Backup** (`core/backup.py`): every table as a gzipped Django fixture. Restore with
  `python manage.py loaddata <file>`. On Cloud Run it goes to `BACKUP_BUCKET`; locally to `BACKUP_DIR`.

### Owner setup for these (console steps, once per project)

1. **Gmail OAuth client** (Google Auth Platform → Clients → Create client → Web application). Authorized
   redirect URI: `https://<project>.web.app/api/gmail/callback`. Put the client ID in the GitHub
   environment variable `GMAIL_CLIENT_ID`, and the client secret in Secret Manager as `GMAIL_CLIENT_SECRET`.
2. **Consent screen**: add the scope `gmail.readonly`, and add both owners as test users. Decide the
   publishing status (see decision D20) before relying on it for long.
3. **Backup bucket** `<project>-backups` in `us-central1`, private, with a 30-day lifecycle rule.
4. **Runtime permissions** for `api-runtime`: `roles/secretmanager.secretCreator`,
   `roles/secretmanager.secretVersionAdder` and `roles/secretmanager.secretAccessor` (project), and
   `roles/storage.objectCreator` on the backup bucket.
5. **One Cloud Scheduler job** in prod, daily at 01:30 Asia/Jakarta, that starts the nightly job
   (`financial-tracker-system-nightly`). The scheduler's service account needs `roles/run.invoker` on it.
   Dev has no scheduler; run the job by hand with `gcloud run jobs execute`.
