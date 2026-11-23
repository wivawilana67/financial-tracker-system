// Card sync and the nightly drafts: connect your Gmail, sync a range, see what happened, review drafts.
// Nothing here writes to the ledgers. A draft is a summary to read; the Generate screen does the writing.

import { useEffect, useState } from 'react';

import { api, type Draft, type SyncStatus } from './api';

function todayJakarta(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export default function CardSync() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [start, setStart] = useState(todayJakarta(-1));
  const [end, setEnd] = useState(todayJakarta(-1));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [s, d] = await Promise.all([api.syncStatus(), api.drafts()]);
      setStatus(s);
      setDrafts(d.drafts);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get('gmail');
    if (gmail === 'connected') setMessage('Gmail connected.');
    if (gmail === 'denied') setError('Gmail access was not granted.');
    if (gmail === 'error') setError('Gmail could not be connected. Try again.');
    load();
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const res = await api.gmailConnect();
      window.location.href = res.url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function sync(from: string, to: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api.ccSync(from, to);
      setMessage(`Synced ${from}${from === to ? '' : ` to ${to}`}: ${res.saved} new transaction(s).`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(draft: Draft) {
    setBusy(true);
    try {
      await api.confirmDraft(draft.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sync" aria-labelledby="sync-title">
      <h2 id="sync-title">Card sync</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="report" role="status">{message}</p>}

      {status && (
        <>
          <p className="muted">
            Gmail for {status.inbox}: {status.connected ? 'connected' : 'not connected'}.
          </p>
          {!status.connected && (
            <button type="button" disabled={busy} onClick={connect}>Connect my Gmail</button>
          )}

          <div className="savebar">
            <button type="button" className="secondary" disabled={busy} onClick={() => sync(todayJakarta(), todayJakarta())}>
              Sync today
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => sync(todayJakarta(-1), todayJakarta(-1))}>
              Sync yesterday
            </button>
          </div>
          <div className="add-row">
            <label>From <input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label>To <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            <button type="button" className="secondary" disabled={busy || !start || !end} onClick={() => sync(start, end)}>
              Sync range
            </button>
          </div>

          <h3>Recent runs</h3>
          <ul className="cc-list">
            {status.runs.map((r, i) => (
              <li key={i} className="cc-card">
                {new Date(r.when).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })} · {r.bank} · {r.status}
                {` · found ${r.found}, saved ${r.saved}, failed ${r.failed}`}{r.note ? ` · ${r.note}` : ''}
              </li>
            ))}
            {status.runs.length === 0 && <li className="muted">No runs yet.</li>}
          </ul>

          <h3>Emails to check ({status.failures.length})</h3>
          <ul className="cc-list">
            {status.failures.map((f, i) => (
              <li key={i} className="cc-card warn-card">
                {new Date(f.when).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })} · {f.reason}
              </li>
            ))}
            {status.failures.length === 0 && <li className="muted">Nothing to check.</li>}
          </ul>
        </>
      )}

      <h3>Nightly drafts</h3>
      <ul className="cc-list">
        {drafts.map((d) => (
          <li key={d.id} className="cc-card">
            <div className="cc-top">
              <div>
                <strong>Draft for {d.month}</strong>
                <div className="muted small">{Object.entries(d.summary).map(([k, v]) => `${k}: ${v.inserted} new, ${v.updated} updated`).join(' · ')}</div>
              </div>
              {d.confirmed
                ? <span className="muted">Reviewed</span>
                : <button type="button" className="secondary" disabled={busy} onClick={() => confirm(d)}>Mark reviewed</button>}
            </div>
          </li>
        ))}
        {drafts.length === 0 && <li className="muted">No drafts yet. One is prepared on the 1st of each month.</li>}
      </ul>
    </section>
  );
}
