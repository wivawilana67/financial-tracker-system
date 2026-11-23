// Generate Monthly Data: choose what carries from last month, preview what would be written, then apply.
// Apply is only enabled for the exact inputs that were previewed, so nothing is written unseen.

import { useEffect, useMemo, useState } from 'react';

import { api, type Candidate, type RolloverBody, type RolloverPlan } from './api';
import { formatRupiah } from './money';

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 1-based, so this is the month after
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function Rollover({ sessionMonth }: { sessionMonth: string }) {
  const [target, setTarget] = useState(nextMonth(sessionMonth));
  const [source, setSource] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [rates] = useState({ pool: 10, wiva: 50, jane: 50 });
  const [channels, setChannels] = useState({ wiva: 'Cash', jane: 'Cash' });
  const [preview, setPreview] = useState<{ key: string; plan: RolloverPlan } | null>(null);
  const [applied, setApplied] = useState<RolloverPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError('');
    setApplied(null);
    api
      .candidates(target)
      .then((res) => {
        setSource(res.source);
        setCandidates(res.candidates);
        setSelected(new Set(res.candidates.map((c) => c.uid)));
        setOverrides({});
      })
      .catch((err: Error) => setError(err.message));
  }, [target]);

  const body: RolloverBody = useMemo(() => ({
    month: target,
    selected: [...selected],
    overrides: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v.trim() !== '')),
    income: [],
    jajan_base: {} as RolloverBody['jajan_base'],
    jajan_rates: rates,
    wiva_channel: channels.wiva,
    jane_channel: channels.jane,
  }), [target, selected, overrides, rates, channels]);

  const key = JSON.stringify(body);
  const previewIsCurrent = preview !== null && preview.key === key;

  function toggle(uid: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  async function run(kind: 'preview' | 'apply') {
    setBusy(true);
    setError('');
    try {
      if (kind === 'preview') {
        setPreview({ key, plan: await api.rolloverPreview(body) });
      } else {
        setApplied(await api.rolloverApply(body));
        setPreview(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rollover" aria-labelledby="roll-title">
      <div className="dash-head">
        <h2 id="roll-title">Generate Monthly Data</h2>
        <label className="month-pick">
          Target month
          <input type="month" value={target} onChange={(e) => e.target.value && setTarget(e.target.value)} />
        </label>
      </div>
      <p className="muted small">Rows carry over from {source || '…'}. Untick a row to leave it out.</p>

      {error && <p className="error" role="alert">{error}</p>}

      <table className="grid">
        <thead>
          <tr><th>Use</th><th>Ledger</th><th>List</th><th>Type</th><th>Channel</th><th className="num">Last month</th><th className="num">Override</th></tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.uid} className={selected.has(c.uid) ? '' : 'gone'}>
              <td><input type="checkbox" aria-label={`use ${c.list}`} checked={selected.has(c.uid)} onChange={() => toggle(c.uid)} /></td>
              <td>{c.ledger}</td>
              <td>{c.list}{c.cicilan && c.remaining_after !== null ? ` (${c.remaining_after} left next)` : ''}</td>
              <td>{c.type}</td>
              <td>{c.channel}</td>
              <td className="num">{formatRupiah(c.amount)}</td>
              <td className="num">
                <input aria-label={`override ${c.list}`} placeholder="same" inputMode="decimal" value={overrides[c.uid] ?? ''}
                  onChange={(e) => setOverrides((o) => ({ ...o, [c.uid]: e.target.value }))} />
              </td>
            </tr>
          ))}
          {candidates.length === 0 && <tr><td colSpan={7} className="muted">Nothing to carry over.</td></tr>}
        </tbody>
      </table>

      <fieldset className="jajan-inputs">
        <legend>Jajan channels</legend>
        <p className="muted small">Jajan is worked out from the target month's Salary income, as on the Sheet.</p>
        <label>Wiva's jajan channel<input value={channels.wiva}
          onChange={(e) => setChannels((c) => ({ ...c, wiva: e.target.value }))} /></label>
        <label>Jane's jajan channel<input value={channels.jane}
          onChange={(e) => setChannels((c) => ({ ...c, jane: e.target.value }))} /></label>
      </fieldset>

      <div className="savebar">
        <button type="button" className="secondary" disabled={busy || selected.size === 0} onClick={() => run('preview')}>
          Preview
        </button>
        <button type="button" disabled={busy || !previewIsCurrent} onClick={() => run('apply')}
          title={previewIsCurrent ? '' : 'Preview these inputs first'}>
          Apply to {target}
        </button>
      </div>

      {preview && (
        <div className="report" role="status">
          <h3>Preview{previewIsCurrent ? '' : ' (inputs changed, preview again)'}</h3>
          <ul>
            {Object.entries(preview.plan.summary).map(([ledger, s]) => (
              <li key={ledger}>{ledger}: {s.inserted} new, {s.updated} updated</li>
            ))}
          </ul>
          <p className="muted small">
            Jajan this month: Wiva {formatRupiah(preview.plan.jajan_net.Wiva ?? '0')}, Jane {formatRupiah(preview.plan.jajan_net.Jane ?? '0')}.
          </p>
        </div>
      )}

      {applied?.written && (
        <div className="report" role="status">
          <p>Written: {applied.written.inserted} new, {applied.written.updated} updated.</p>
        </div>
      )}
    </section>
  );
}
