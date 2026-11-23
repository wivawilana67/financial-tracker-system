// CC Tracker: the card transactions as a checklist. Select, paid, cicilan or bulanan, cancelled and a note.
// Cleanup hides paid and cancelled rows; nothing is deleted. Hidden rows have their own filter.

import { useCallback, useEffect, useState } from 'react';

import { api, type CcRow } from './api';
import { formatRupiah } from './money';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'paid', label: 'Paid' },
  { key: 'hidden', label: 'Hidden' },
] as const;

type Edit = Partial<Pick<CcRow, 'selected' | 'paid' | 'kind' | 'cancelled' | 'note'>>;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });
}

export default function CcTracker() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [rows, setRows] = useState<CcRow[]>([]);
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.cc(filter);
      setRows(res.rows);
      setEdits({});
    } catch (err) {
      setError((err as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  function edit(row: CcRow, patch: Edit) {
    setEdits((e) => ({ ...e, [row.id]: { ...(e[row.id] ?? {}), ...patch } }));
  }

  function valueOf<K extends keyof Edit>(row: CcRow, key: K): NonNullable<Edit[K]> {
    const patched = edits[row.id]?.[key];
    return (patched !== undefined ? patched : row[key as keyof CcRow]) as NonNullable<Edit[K]>;
  }

  async function save() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const payload = rows
        .filter((r) => edits[r.id])
        .map((r) => ({ id: r.id, version: r.version, ...edits[r.id] }));
      const res = await api.ccUpdate(payload);
      setMessage(`Saved ${res.updated}.${res.skipped.length ? ` Skipped: ${res.skipped.join('; ')}` : ''}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    setBusy(true);
    setError('');
    try {
      const res = await api.ccCleanup();
      setMessage(`Hidden: ${res.hidden} paid or cancelled row(s). They stay in the Hidden filter.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(row: CcRow) {
    setBusy(true);
    try {
      await api.ccRestore(row.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const changed = Object.keys(edits).length;
  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);

  return (
    <section className="cc" aria-labelledby="cc-title">
      <div className="dash-head">
        <h2 id="cc-title">CC Tracker</h2>
        <span className="muted">{rows.length} shown · {formatRupiah(String(total))}</span>
      </div>

      <div className="tabs" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key}
            className={`tab ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="report" role="status">{message}</p>}

      <ul className="cc-list">
        {rows.map((r) => (
          <li key={r.id} className={`cc-card ${r.cancelled ? 'cancelled' : ''} ${r.paid ? 'paid' : ''}`}>
            <div className="cc-top">
              <div>
                <strong>{r.description}</strong>
                <div className="muted small">{when(r.datetime)} · {r.bank} {r.card} · {r.inbox}</div>
              </div>
              <strong className="num">{formatRupiah(r.amount)}</strong>
            </div>
            <div className="cc-checks">
              <label><input type="checkbox" checked={valueOf(r, 'selected')}
                onChange={(e) => edit(r, { selected: e.target.checked })} /> Select</label>
              <label><input type="checkbox" checked={valueOf(r, 'paid')}
                onChange={(e) => edit(r, { paid: e.target.checked })} /> Paid</label>
              <label><input type="checkbox" checked={valueOf(r, 'cancelled')}
                onChange={(e) => edit(r, { cancelled: e.target.checked })} /> Cancelled</label>
              <label>Tag
                <select value={valueOf(r, 'kind')} onChange={(e) => edit(r, { kind: e.target.value as CcRow['kind'] })}>
                  <option value="">None</option>
                  <option value="cicilan">Cicilan</option>
                  <option value="bulanan">Bulanan</option>
                </select>
              </label>
            </div>
            <input className="cc-note" aria-label={`note for ${r.description}`} placeholder="Note"
              value={valueOf(r, 'note')} onChange={(e) => edit(r, { note: e.target.value })} />
            {filter === 'hidden' && (
              <button type="button" className="secondary" disabled={busy} onClick={() => restore(r)}>Show again</button>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="muted">Nothing here.</li>}
      </ul>

      <div className="savebar">
        <button type="button" className="secondary" disabled={busy} onClick={cleanup}>
          Hide paid and cancelled
        </button>
        <button type="button" disabled={busy || changed === 0} onClick={save}>
          {busy ? 'Saving…' : `Save ${changed} change${changed === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  );
}
