// The month dashboard: income, the three budgets against their targets, and what is left.
// Every figure comes from the API; this file only lays them out.

import { useEffect, useState } from 'react';

import { api, type DashboardResponse, type LedgerTotal } from './api';
import { barWidth, formatPercent, formatRupiah } from './money';

const LABELS: Record<string, string> = {
  saving: 'Saving',
  expense: 'Expense',
  ibadah: 'Ibadah',
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
    </div>
  );
}

function LedgerBar({ row, income }: { row: LedgerTotal; income: string }) {
  const scale = Math.max(Number(income), Number(row.target), Number(row.total), 1).toString();
  const over = Number(row.total) > Number(row.target);
  return (
    <div className="ledger">
      <div className="ledger-head">
        <span>{LABELS[row.ledger] ?? row.ledger}</span>
        <span className="muted">{formatPercent(row.percent_of_income)} of income</span>
      </div>
      <div className="bar" role="img" aria-label={`${LABELS[row.ledger]}: ${formatRupiah(row.total)} of ${formatRupiah(row.target)} target`}>
        <div className={`bar-fill ${over ? 'over' : ''}`} style={{ width: `${barWidth(row.total, scale)}%` }} />
        <div className="bar-target" style={{ left: `${barWidth(row.target, scale)}%` }} />
      </div>
      <div className="ledger-foot">
        <span>{formatRupiah(row.total)}</span>
        <span className="muted">target {formatRupiah(row.target)}</span>
      </div>
    </div>
  );
}

export default function Dashboard({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    api
      .dashboard(month)
      .then((res) => !cancelled && setData(res))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [month]);

  return (
    <section className="dashboard" aria-labelledby="dash-title">
      <div className="dash-head">
        <h2 id="dash-title">Dashboard</h2>
        <label className="month-pick">
          Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="stats">
            <Stat label="Income" value={formatRupiah(data.income)} />
            <Stat
              label="Expected left"
              value={formatRupiah(data.expected_remaining)}
              tone={Number(data.expected_remaining) < 0 ? 'bad' : 'good'}
            />
            <Stat
              label="Left now"
              value={formatRupiah(data.current_remaining)}
              tone={Number(data.current_remaining) < 0 ? 'bad' : 'good'}
            />
          </div>

          <div className="ledgers">
            {data.ledgers.map((row) => (
              <LedgerBar key={row.ledger} row={row} income={data.income} />
            ))}
          </div>

          <p className="note-foot muted">
            Targets are shares of income: Saving 40%, Expense 50%, Ibadah 10%. The line on each bar marks the
            target. Remaining amounts are computed by the server.
          </p>
        </>
      )}
    </section>
  );
}
