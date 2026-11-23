// Monthly Data: the rows of one month, one ledger at a time. Edits are sent with the version each row
// was loaded at, so the server refuses an edit if the row changed in the meantime.

import { useCallback, useEffect, useState } from 'react';

import { api, type ChangeResult, type IncomeRow, type LedgerRow } from './api';

const TABS = [
  { key: 'saving', label: 'Saving' },
  { key: 'expense', label: 'Expense' },
  { key: 'ibadah', label: 'Ibadah' },
  { key: 'autodeduct', label: 'Autodeduct Jajan' },
  { key: 'income', label: 'Income' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface Draft {
  amount: string;
  channel: string;
  cicilan: boolean;
  remaining: string;
  paid: boolean;
}

interface NewRow {
  key: number;
  ledger: string;
  list: string;
  type: string;
  amount: string;
  channel: string;
  cicilan: boolean;
  remaining: string;
  paid: boolean;
}

function draftOf(row: LedgerRow): Draft {
  return {
    amount: row.amount,
    channel: row.channel,
    cicilan: row.cicilan,
    remaining: row.remaining === null ? '' : String(row.remaining),
    paid: row.paid,
  };
}

function blankRow(ledger: string, key: number): NewRow {
  return { key, ledger, list: '', type: '', amount: '', channel: '', cicilan: false, remaining: '', paid: false };
}

export default function MonthlyData({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [tab, setTab] = useState<TabKey>('saving');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [income, setIncome] = useState<IncomeRow[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [incomeDrafts, setIncomeDrafts] = useState<Record<number, string>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [adds, setAdds] = useState<NewRow[]>([]);
  const [report, setReport] = useState<ChangeResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.ledger(month, tab === 'income' ? undefined : tab);
      setRows(res.rows);
      setIncome(res.income);
      setDrafts({});
      setIncomeDrafts({});
      setDeleted(new Set());
      setAdds([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, tab]);

  useEffect(() => {
    load();
  }, [load]);

  function edit(id: number, patch: Partial<Draft>, row: LedgerRow) {
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? draftOf(row)), ...patch } }));
  }

  function nextKey() {
    return Date.now() + Math.random();
  }

  async function save() {
    setBusy(true);
    setError('');
    setReport(null);
    try {
      const updates = rows
        .filter((r) => drafts[r.id] && !deleted.has(r.id))
        .map((r) => {
          const d = drafts[r.id];
          return {
            id: r.id,
            version: r.version,
            amount: d.amount,
            channel: d.channel,
            cicilan: d.cicilan,
            remaining: d.cicilan && d.remaining !== '' ? Number(d.remaining) : null,
            paid: d.paid,
          };
        });
      const deletions = rows.filter((r) => deleted.has(r.id)).map((r) => ({ id: r.id, version: r.version }));
      const additions = adds
        .filter((a) => a.amount !== '')
        .map((a) => ({
          ledger: a.ledger, list: a.list, type: a.type, amount: a.amount, channel: a.channel,
          cicilan: a.cicilan, remaining: a.cicilan && a.remaining !== '' ? Number(a.remaining) : null, paid: a.paid,
        }));
      const incomeUpdates = income
        .filter((i) => incomeDrafts[i.id] !== undefined && incomeDrafts[i.id] !== i.amount)
        .map((i) => ({ id: i.id, version: i.version, amount: incomeDrafts[i.id] }));
      const res = await api.saveChanges({ month, updates, deletions, additions, income: incomeUpdates });
      setReport(res);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isIncome = tab === 'income';
  const changed = Object.keys(drafts).length + deleted.size + adds.filter((a) => a.amount !== '').length
    + Object.keys(incomeDrafts).length;

  return (
    <section className="monthly" aria-labelledby="monthly-title">
      <div className="dash-head">
        <h2 id="monthly-title">Monthly Data</h2>
        <label className="month-pick">
          Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {isIncome ? (
        <table className="grid">
          <thead><tr><th>Person</th><th>Category</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {income.map((i) => (
              <tr key={i.id}>
                <td>{i.person}</td>
                <td>{i.category}</td>
                <td className="num">
                  <input
                    aria-label={`${i.person} ${i.category} amount`}
                    value={incomeDrafts[i.id] ?? i.amount}
                    onChange={(e) => setIncomeDrafts((d) => ({ ...d, [i.id]: e.target.value }))}
                    inputMode="decimal"
                  />
                </td>
              </tr>
            ))}
            {income.length === 0 && <tr><td colSpan={3} className="muted">No income rows this month.</td></tr>}
          </tbody>
        </table>
      ) : (
        <>
          <table className="grid">
            <thead>
              <tr>
                <th>List</th><th>{tab === 'autodeduct' ? 'Who' : 'Type'}</th><th className="num">Amount</th>
                <th>Channel</th><th>Cicilan</th><th className="num">Left</th><th>Paid</th><th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = drafts[r.id] ?? draftOf(r);
                const gone = deleted.has(r.id);
                return (
                  <tr key={r.id} className={gone ? 'gone' : ''}>
                    <td>{r.list}</td>
                    <td>{r.type}</td>
                    <td className="num">
                      <input aria-label={`${r.list} amount`} value={d.amount} inputMode="decimal" disabled={gone}
                        onChange={(e) => edit(r.id, { amount: e.target.value }, r)} />
                    </td>
                    <td>
                      <input aria-label={`${r.list} channel`} value={d.channel} disabled={gone}
                        onChange={(e) => edit(r.id, { channel: e.target.value }, r)} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`${r.list} cicilan`} checked={d.cicilan} disabled={gone}
                        onChange={(e) => edit(r.id, { cicilan: e.target.checked }, r)} />
                    </td>
                    <td className="num">
                      <input aria-label={`${r.list} payments left`} value={d.remaining} inputMode="numeric"
                        disabled={gone || !d.cicilan} onChange={(e) => edit(r.id, { remaining: e.target.value }, r)} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`${r.list} paid`} checked={d.paid} disabled={gone}
                        onChange={(e) => edit(r.id, { paid: e.target.checked }, r)} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`delete ${r.list}`} checked={gone}
                        onChange={(e) => setDeleted((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(r.id); else next.delete(r.id);
                          return next;
                        })} />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={8} className="muted">No rows this month.</td></tr>}
            </tbody>
          </table>

          <h3>Add to {TABS.find((t) => t.key === tab)?.label}</h3>
          {adds.map((a) => (
            <div className="add-row" key={a.key}>
              <input aria-label="new list" placeholder="List" value={a.list}
                onChange={(e) => setAdds((xs) => xs.map((x) => x.key === a.key ? { ...x, list: e.target.value } : x))} />
              <input aria-label="new type" placeholder={tab === 'autodeduct' ? 'Who (Wiva or Jane)' : 'Type'} value={a.type}
                onChange={(e) => setAdds((xs) => xs.map((x) => x.key === a.key ? { ...x, type: e.target.value } : x))} />
              <input aria-label="new amount" placeholder="Amount" inputMode="decimal" value={a.amount}
                onChange={(e) => setAdds((xs) => xs.map((x) => x.key === a.key ? { ...x, amount: e.target.value } : x))} />
              <input aria-label="new channel" placeholder="Channel" value={a.channel}
                onChange={(e) => setAdds((xs) => xs.map((x) => x.key === a.key ? { ...x, channel: e.target.value } : x))} />
              <button type="button" className="secondary"
                onClick={() => setAdds((xs) => xs.filter((x) => x.key !== a.key))}>Remove</button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={() => setAdds((xs) => [...xs, blankRow(tab, nextKey())])}>
            + Add row
          </button>
        </>
      )}

      <div className="savebar">
        <span className="muted">{changed} change{changed === 1 ? '' : 's'} waiting</span>
        <button type="button" disabled={busy || changed === 0} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {report && (
        <div className="report" role="status">
          <p>
            Updated {report.updated}, deleted {report.deleted}, added {report.added}.
            {report.jajan_adjusted.length > 0 && ` Jajan moved: ${report.jajan_adjusted.join('; ')}.`}
          </p>
          {report.skipped.length > 0 && (
            <ul className="warn">{report.skipped.map((s) => <li key={s}>{s}</li>)}</ul>
          )}
        </div>
      )}
    </section>
  );
}
