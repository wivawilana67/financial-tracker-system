// Paid status: mark whole payment channels, or single rows, as paid for a month.
// Only unpaid rows change. Rows already paid are left as they are.

import { useEffect, useState } from 'react';

import { api, type LedgerRow } from './api';

export default function PaidStatus({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [channels, setChannels] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError('');
    setChannels(new Set());
    setPicked(new Set());
    Promise.all(['saving', 'expense', 'ibadah', 'autodeduct'].map((l) => api.ledger(month, l)))
      .then((all) => setRows(all.flatMap((r) => r.rows)))
      .catch((err: Error) => setError(err.message));
  }, [month]);

  const channelNames = [...new Set(rows.map((r) => r.channel).filter((c) => c))].sort();
  const unpaid = rows.filter((r) => !r.paid);

  function toggle<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  }

  async function apply() {
    setBusy(true);
    setError('');
    try {
      const chosen = rows.filter((r) => picked.has(r.id));
      const res = await api.markPaid({
        month,
        channels: [...channels],
        rows: chosen.map((r) => [r.list, r.type, r.channel]),
      });
      setMessage(`Marked ${res.marked} row(s) as paid.`);
      const refreshed = await Promise.all(['saving', 'expense', 'ibadah', 'autodeduct'].map((l) => api.ledger(month, l)));
      setRows(refreshed.flatMap((r) => r.rows));
      setChannels(new Set());
      setPicked(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="paid" aria-labelledby="paid-title">
      <div className="dash-head">
        <h2 id="paid-title">Paid status</h2>
        <label className="month-pick">
          Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>
      <p className="muted small">Tick a channel to mark everything unpaid on it, or tick single rows below.</p>

      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="report" role="status">{message}</p>}

      <h3>By channel</h3>
      <div className="chips">
        {channelNames.length === 0 && <span className="muted">No channels this month.</span>}
        {channelNames.map((c) => (
          <label key={c} className={`chip ${channels.has(c) ? 'on' : ''}`}>
            <input type="checkbox" checked={channels.has(c)} onChange={() => setChannels((s) => toggle(s, c))} />
            {c}
          </label>
        ))}
      </div>

      <h3>By row</h3>
      <ul className="cc-list">
        {unpaid.map((r) => (
          <li key={r.id} className="cc-card">
            <label className="row-pick">
              <input type="checkbox" checked={picked.has(r.id)} onChange={() => setPicked((s) => toggle(s, r.id))} />
              <span>{r.ledger} · {r.list} · {r.type} · {r.channel}</span>
            </label>
          </li>
        ))}
        {unpaid.length === 0 && rows.length > 0 && <li className="muted">Everything is paid this month.</li>}
      </ul>

      <div className="savebar">
        <span className="muted">{channels.size + picked.size} selected</span>
        <button type="button" disabled={busy || channels.size + picked.size === 0} onClick={apply}>
          {busy ? 'Marking…' : 'Mark as paid'}
        </button>
      </div>
    </section>
  );
}
