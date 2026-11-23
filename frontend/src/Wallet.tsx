// Wallet (Blu Balance): balances per account, and the entries. Installments show their 24 tick boxes.
// Each change is sent with the version it was loaded at; a changed entry is refused and reloaded.

import { useCallback, useEffect, useState } from 'react';

import { api, type WalletResponse, type WalletRowView } from './api';
import { formatRupiah } from './money';

const EMPTY = { list: '', price: '', account: '', income: false, paid: false, cicil: false, months: '' };

export default function Wallet() {
  const [data, setData] = useState<WalletResponse | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await api.wallet());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    setBusy(true);
    setError('');
    try {
      await api.walletAdd({
        list: form.list, price: form.price, account: form.account, income: form.income, paid: form.paid,
        cicil: form.cicil, months: form.cicil && form.months ? Number(form.months) : null,
        ticks: [],
      });
      setForm(EMPTY);
      setMessage('Added.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function change(row: WalletRowView, patch: Partial<WalletRowView>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = { ...row, ...patch };
      const res = await api.walletUpdate({
        id: row.id, version: row.version, list: next.list, price: next.price, account: next.account,
        income: next.income, paid: next.paid, cicil: next.cicil, months: next.months, ticks: next.ticks,
        date: next.date,
      });
      if (!res.updated) setError(`${row.list}: ${res.error ?? 'could not save'}. The list was reloaded.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: WalletRowView) {
    setBusy(true);
    try {
      const res = await api.walletDelete(row.id, row.version);
      if (!res.deleted) setError(`${row.list} changed since it was loaded. The list was reloaded.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wallet" aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallet</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="report" role="status">{message}</p>}

      {data && (
        <>
          <div className="stats">
            <div className="stat"><span className="stat-label">Total wallet</span>
              <strong className="stat-value">{formatRupiah(data.total)}</strong></div>
            {data.accounts.map((a) => (
              <div key={a.name} className={`stat ${Number(a.balance) < 0 ? 'bad' : 'good'}`}>
                <span className="stat-label">{a.name}</span>
                <strong className="stat-value">{formatRupiah(a.balance)}</strong>
              </div>
            ))}
          </div>

          <ul className="cc-list">
            {data.rows.map((r) => (
              <li key={r.id} className={`cc-card ${r.paid ? 'paid' : ''}`}>
                <div className="cc-top">
                  <div>
                    <strong>{r.list}</strong>
                    <div className="muted small">{r.account} · {r.income ? 'Income' : 'Expense'}{r.cicil ? ` · cicilan ${r.months ?? '?'} months, ${formatRupiah(r.instalment)} a month` : ''}</div>
                  </div>
                  <strong className="num">{formatRupiah(r.price)}</strong>
                </div>
                <div className="cc-checks">
                  <label><input type="checkbox" checked={r.paid} disabled={busy}
                    onChange={(e) => change(r, { paid: e.target.checked })} /> Paid</label>
                  {r.cicil && <span className="muted small">{formatRupiah(r.instalments_paid)} paid so far</span>}
                </div>
                {r.cicil && (
                  <div className="ticks" role="group" aria-label={`installments for ${r.list}`}>
                    {r.ticks.map((t, i) => (
                      <label key={i} className="tick">
                        <input type="checkbox" checked={t} disabled={busy || i >= (r.months ?? 0)}
                          aria-label={`installment ${i + 1}`}
                          onChange={(e) => {
                            const ticks = [...r.ticks];
                            ticks[i] = e.target.checked;
                            change(r, { ticks });
                          }} />
                        <span>{i + 1}</span>
                      </label>
                    ))}
                  </div>
                )}
                <button type="button" className="secondary" disabled={busy} onClick={() => remove(r)}>Delete</button>
              </li>
            ))}
            {data.rows.length === 0 && <li className="muted">No wallet entries yet.</li>}
          </ul>
        </>
      )}

      <h3>Add an entry</h3>
      <div className="add-row">
        <input aria-label="entry name" placeholder="What" value={form.list} onChange={(e) => setForm({ ...form, list: e.target.value })} />
        <input aria-label="entry price" placeholder="Price" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        <input aria-label="entry account" placeholder="Account" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} />
        <label className="inline"><input type="checkbox" checked={form.income} onChange={(e) => setForm({ ...form, income: e.target.checked })} /> Income</label>
        <label className="inline"><input type="checkbox" checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.checked })} /> Paid</label>
        <label className="inline"><input type="checkbox" checked={form.cicil} onChange={(e) => setForm({ ...form, cicil: e.target.checked })} /> Cicilan</label>
        {form.cicil && <input aria-label="months" placeholder="Months" inputMode="numeric" value={form.months} onChange={(e) => setForm({ ...form, months: e.target.value })} />}
        <button type="button" disabled={busy || !form.list || !form.price || !form.account} onClick={add}>Add</button>
      </div>
    </section>
  );
}
