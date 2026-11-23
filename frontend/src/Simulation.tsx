// Simulation: change the month's totals and see what is left. Nothing is saved.
// The first load shows the month as it is; each change asks the server to recalculate.

import { useEffect, useState } from 'react';

import { api } from './api';
import { formatRupiah } from './money';

interface Sim {
  income: string;
  saving: string;
  expense: string;
  ibadah: string;
  autodeduct: string;
  remaining: string;
  jajan_net: Record<string, string>;
}

const KEYS = ['income', 'saving', 'expense', 'ibadah', 'autodeduct'] as const;
type Key = (typeof KEYS)[number];

const LABELS: Record<Key, string> = {
  income: 'Income',
  saving: 'Saving',
  expense: 'Expense (without jajan)',
  ibadah: 'Ibadah',
  autodeduct: 'Autodeduct',
};

export default function Simulation({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [baseline, setBaseline] = useState<Sim | null>(null);
  const [inputs, setInputs] = useState<Partial<Record<Key, string>>>({});
  const [result, setResult] = useState<Sim | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setInputs({});
    setError('');
    api.simulation(month)
      .then((s) => { setBaseline(s as unknown as Sim); setResult(s as unknown as Sim); })
      .catch((err: Error) => setError(err.message));
  }, [month]);

  async function recalc(next: Partial<Record<Key, string>>) {
    setInputs(next);
    setError('');
    const params = Object.entries(next).filter(([, v]) => v !== undefined && v.trim() !== '');
    try {
      setResult(await api.simulation(month, Object.fromEntries(params)) as unknown as Sim);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="sim" aria-labelledby="sim-title">
      <div className="dash-head">
        <h2 id="sim-title">Simulation</h2>
        <label className="month-pick">
          Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>
      <p className="muted small">Change a total to see the effect. Nothing is saved.</p>
      {error && <p className="error" role="alert">{error}</p>}

      {baseline && result && (
        <>
          <div className="stats">
            <div className={`stat ${Number(result.remaining) < 0 ? 'bad' : 'good'}`}>
              <span className="stat-label">Left after this plan</span>
              <strong className="stat-value">{formatRupiah(result.remaining)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Jajan Wiva / Jane</span>
              <strong className="stat-value">
                {formatRupiah(result.jajan_net.Wiva ?? '0')} / {formatRupiah(result.jajan_net.Jane ?? '0')}
              </strong>
            </div>
          </div>

          <table className="grid">
            <thead><tr><th>Item</th><th className="num">This month</th><th className="num">Simulated</th></tr></thead>
            <tbody>
              {KEYS.map((k) => (
                <tr key={k}>
                  <td>{LABELS[k]}</td>
                  <td className="num">{formatRupiah(baseline[k])}</td>
                  <td className="num">
                    <input
                      aria-label={`simulated ${LABELS[k]}`}
                      inputMode="decimal"
                      placeholder={baseline[k]}
                      value={inputs[k] ?? ''}
                      onChange={(e) => recalc({ ...inputs, [k]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Net jajan stays as it is in the month. Change a jajan row on Monthly Data to move it.
          </p>
        </>
      )}
    </section>
  );
}
