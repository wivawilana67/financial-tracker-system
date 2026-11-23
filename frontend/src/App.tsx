import { useCallback, useEffect, useRef, useState } from 'react';

import { api, envMismatch, onUnauthorized, type Session } from './api';
import { initAuth, promptSignIn, renderSignInButton, signOut } from './auth';
import { APP_ENV, GOOGLE_CLIENT_ID, IS_PROD } from './config';

type View =
  | { kind: 'starting' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'signed-in'; session: Session }
  | { kind: 'error'; message: string };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'starting' });
  const [dbStatus, setDbStatus] = useState('');
  const buttonRef = useRef<HTMLDivElement>(null);

  const loadSession = useCallback(async () => {
    try {
      const session = await api.session();
      const mismatch = envMismatch(APP_ENV, session.env);
      setView(mismatch ? { kind: 'error', message: mismatch } : { kind: 'signed-in', session });
    } catch (err) {
      if ((err as { status?: number }).status !== 401) {
        setView({ kind: 'error', message: (err as Error).message });
      }
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      setView({ kind: 'signed-out', message: 'Your sign-in ended. Sign in again.' });
      promptSignIn();
    });
    if (!GOOGLE_CLIENT_ID) {
      setView({ kind: 'error', message: 'Sign-in is not configured (VITE_GOOGLE_CLIENT_ID is missing).' });
      return;
    }
    initAuth(GOOGLE_CLIENT_ID, loadSession).then((loaded) => {
      setView((v) =>
        v.kind !== 'starting'
          ? v
          : loaded
            ? { kind: 'signed-out' }
            : { kind: 'error', message: 'Google sign-in could not load. Check your connection.' },
      );
    });
  }, [loadSession]);

  useEffect(() => {
    if (view.kind === 'signed-out' && buttonRef.current) renderSignInButton(buttonRef.current);
  }, [view.kind]);

  async function checkDatabase() {
    setDbStatus('Checking…');
    try {
      const res = await api.healthDb();
      setDbStatus(`Database reachable (${res.database})`);
    } catch (err) {
      setDbStatus((err as Error).message);
    }
  }

  return (
    <div className="app">
      {!IS_PROD && <div className="env-banner">{APP_ENV.toUpperCase()}</div>}
      <main className="card">
        <h1>Financial Tracker</h1>

        {view.kind === 'starting' && <p className="muted">Loading…</p>}

        {view.kind === 'signed-out' && (
          <>
            <p>{view.message || 'Sign in with your Google account.'}</p>
            <div ref={buttonRef} />
          </>
        )}

        {view.kind === 'error' && <p className="error" role="alert">{view.message}</p>}

        {view.kind === 'signed-in' && (
          <>
            <dl className="facts">
              <dt>Signed in as</dt>
              <dd>{view.session.email}</dd>
              <dt>Month</dt>
              <dd>{view.session.month}</dd>
              <dt>Server</dt>
              <dd>{view.session.env}</dd>
            </dl>
            <div className="actions">
              <button type="button" onClick={checkDatabase}>Check database</button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  signOut();
                  setView({ kind: 'signed-out' });
                }}
              >
                Sign out
              </button>
            </div>
            {dbStatus && <p className="muted" aria-live="polite">{dbStatus}</p>}
          </>
        )}
      </main>
    </div>
  );
}
