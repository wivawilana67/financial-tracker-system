# Web app (React + TypeScript + Vite PWA)

The new phone and desktop app that replaces `web/`. It's hosted on Firebase Hosting, which also
sends `/api/**` to the Django API on Cloud Run, so the app and the API share one address.

* **Dependencies**: npm in this folder only (`package.json` + `package-lock.json`);
  `frontend/node_modules` is gitignored.
* **Build settings** (`src/config.ts`), set by the deploy workflow or `frontend/.env.local`:
  `VITE_APP_ENV` (`local`, `dev`, `prod`) and `VITE_GOOGLE_CLIENT_ID`.

## Run

With docker compose from the repo root (`docker compose up --build`), open
http://localhost:5173. Without Docker, start the API on port 8000 first, then:

```bash
cd frontend
npm ci
npm run dev        # Vite forwards /api to http://localhost:8000
npm test           # vitest
npm run build      # type check + production build into dist/
```

## How it works

* **Sign-in** (`src/auth.ts`): Google Identity Services one-tap and button. The ID token stays in
  memory only and is sent as `Authorization: Bearer …` (`src/api.ts`). A 401 clears it and asks
  for sign-in again.
* **Environment guard**: the app refuses a server whose `env` differs from its own build, the
  same check as today's `envMismatch`. Non-prod builds show an orange banner.
* **Offline shell** (`public/sw.js`): network-first for the app's own files. `/api/` is never
  cached, so no financial data is stored on the phone.
