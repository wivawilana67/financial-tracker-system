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

Export a tab from Google Sheets (**File → Download → Comma-separated values (.csv)**) and run:

```bash
docker compose exec api python manage.py import_sheet_csv ledger /path/in/container.csv --ledger expense
docker compose exec api python manage.py import_sheet_csv income /path/in/container.csv
docker compose exec api python manage.py import_sheet_csv cc /path/in/container.csv --inbox INBOX_LABEL
```

* Without `--commit` the command only checks the file and prints what it found.
* Columns are matched by header name, so the order doesn't matter. The headers must be the Sheet's
  own (for example `Note/Channel`, `Sudah Bayar?`).
* A bad row stops the import, and the message gives its line number. Nothing is written.
* A ledger or income import refuses months that already hold rows. Add `--replace` to clear and
  reload just those months (it's all or nothing).
* CC rows are deduplicated with the same fingerprint as the Sheet's CC Sync, so importing the
  same file twice is safe.

The Wallet (Blu Balance) tab is not imported yet; it needs its own model.

### Admin

Django's admin is at `/api/admin/` in local and dev only (`ENABLE_ADMIN`). It has its own
username and password, so it is off on Cloud Run, where only Google sign-in opens the app.
Create a local admin with `docker compose exec api python manage.py createsuperuser`.
