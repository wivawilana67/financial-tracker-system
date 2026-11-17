// CC Tracker: unpaid / paid / cancelled list, inline edit, bulk status, sync and settled-row cleanup.

import { call } from './api.js';
import { $, el, text, num, formatRupiah, toast, runAction, confirmTwice } from './ui.js';

const MAX_SYNC_DAYS = 62;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const state = { rows: [], filter: 'unpaid', selected: new Set(), openRow: null, settled: [] };

const setStatus = (message) => { $('cc-status').textContent = message; };

// Today's date in Jakarta (the sheet's time zone) as yyyy-MM-dd.
function jakartaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftDay(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Days covered by a yyyy-MM-dd range, both ends included.
const daysInRange = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;

function statusOf(row) {
  if (row.cancelled) return { kind: 'cancelled', label: 'Cancelled' };
  if (row.paid) return { kind: 'paid', label: 'Paid' };
  return { kind: 'unpaid', label: 'Unpaid' };
}

function matchesFilter(row) {
  if (state.filter === 'unpaid') return !row.paid && !row.cancelled;
  if (state.filter === 'paid') return Boolean(row.paid);
  if (state.filter === 'cancelled') return Boolean(row.cancelled);
  return true;
}

export function init() {
  $('sync-start').value = jakartaToday();
  $('sync-end').value = jakartaToday();

  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      render();
    });
  });

  $('cc-refresh').addEventListener('click', (e) => runAction(e.currentTarget, loadRows));
  $('cc-mark-paid').addEventListener('click', (e) => runAction(e.currentTarget, () => bulkUpdate('paid')));
  $('cc-mark-cancelled').addEventListener('click', (e) => runAction(e.currentTarget, () => bulkUpdate('cancelled')));
  $('cc-clear').addEventListener('click', () => {
    state.selected.clear();
    render();
  });

  $('sync-yesterday').addEventListener('click', (e) => {
    const day = shiftDay(jakartaToday(), -1);
    return syncRange(day, day, e.currentTarget);
  });
  $('sync-today').addEventListener('click', (e) => {
    const day = jakartaToday();
    return syncRange(day, day, e.currentTarget);
  });
  $('sync-range').addEventListener('click', (e) => syncRange($('sync-start').value, $('sync-end').value, e.currentTarget));

  $('settled-load').addEventListener('click', (e) => runAction(e.currentTarget, loadSettled));
  $('settled-delete').addEventListener('click', (e) => {
    const button = e.currentTarget;
    if (state.settled.length === 0) {
      toast('Load the settled rows first', 'error');
      return;
    }
    confirmTwice(button, deleteLabel(), () => runAction(button, deleteSettled));
  });
}

// Called each time the CC tab opens.
export function enter() {
  return runAction(null, loadRows);
}

// Clears everything on screen; used on sign-out and when the session expires.
export function reset() {
  state.rows = [];
  state.settled = [];
  state.selected.clear();
  state.openRow = null;
  setStatus('');
  $('sync-result').hidden = true;
  $('settled-status').textContent = '';
  render();
  renderSettled();
}

export async function loadRows() {
  setStatus('Loading…');
  let res;
  try {
    res = await call('ccList');
  } catch (err) {
    setStatus('Could not load the list.');
    throw err;
  }
  state.rows = Array.isArray(res.rows) ? res.rows : [];
  state.selected.clear();
  render();
  setStatus(res.missing ? 'CC Tracker tab not found' : '');
}

function render() {
  const rows = state.rows.filter(matchesFilter);
  const total = rows.reduce((sum, row) => sum + num(row.amount), 0);
  $('cc-summary').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} · ${formatRupiah(total)}`;
  const items = rows.map(rowCard);
  if (items.length === 0) items.push(el('li', { className: 'empty', text: 'Nothing here.' }));
  $('cc-list').replaceChildren(...items);
  renderBar();
}

function renderBar() {
  const count = state.selected.size;
  $('cc-bar').hidden = count === 0;
  $('cc-selected').textContent = `${count} selected`;
}

function rowCard(row) {
  const key = row.row;
  const status = statusOf(row);
  const note = text(row.note);

  const box = el('input', { type: 'checkbox', checked: state.selected.has(key), attrs: { 'aria-label': 'Select this row' } });
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(key);
    else state.selected.delete(key);
    renderBar();
  });

  const body = el('button', { type: 'button', className: 'tx-body', attrs: { 'aria-expanded': String(state.openRow === key) } },
    el('span', { className: 'tx-top' },
      el('span', { className: 'tx-desc', text: text(row.description) || '(no description)' }),
      el('span', { className: 'amt', text: formatRupiah(row.amount) })),
    el('span', { className: 'tx-meta', text: [row.datetime, row.card, row.bank].map(text).filter(Boolean).join(' · ') }),
    el('span', { className: 'tx-foot' },
      el('span', { className: `badge ${status.kind}`, text: status.label }),
      note ? el('span', { className: 'tx-note', text: note }) : null));
  body.addEventListener('click', () => {
    state.openRow = state.openRow === key ? null : key;
    render();
  });

  const children = [el('div', { className: 'tx-row' }, el('label', { className: 'tx-check' }, box), body)];
  if (state.openRow === key) children.push(editor(row));
  return el('li', { className: 'tx' }, ...children);
}

function editor(row) {
  const paid = el('input', { type: 'checkbox', checked: Boolean(row.paid) });
  const cancelled = el('input', { type: 'checkbox', checked: Boolean(row.cancelled) });
  const note = el('input', {
    type: 'text',
    value: text(row.note),
    maxLength: 500,
    placeholder: 'Add a note',
    attrs: { 'aria-label': 'Note', autocomplete: 'off' },
  });
  const save = el('button', { type: 'button', className: 'btn primary', text: 'Save' });
  save.addEventListener('click', () => saveEdit(row, {
    paid: paid.checked,
    cancelled: cancelled.checked,
    note: note.value.trim(),
  }, save));

  return el('div', { className: 'editor' },
    el('label', { className: 'switch' }, paid, el('span', { text: 'Paid' })),
    el('label', { className: 'switch' }, cancelled, el('span', { text: 'Cancelled' })),
    el('label', { className: 'field' }, el('span', { text: 'Note' }), note),
    save);
}

// Sends only the fields that changed for this one row.
async function saveEdit(row, next, button) {
  const change = { row: row.row, fingerprint: row.fingerprint };
  if (next.paid !== Boolean(row.paid)) change.paid = next.paid;
  if (next.cancelled !== Boolean(row.cancelled)) change.cancelled = next.cancelled;
  if (next.note !== text(row.note)) change.note = next.note;
  if (Object.keys(change).length === 2) {
    toast('Nothing to change');
    return;
  }
  await runAction(button, async () => {
    afterUpdate(await call('ccUpdate', { changes: [change] }));
    await loadRows();
  });
}

async function bulkUpdate(field, button) {
  const changes = state.rows
    .filter((row) => state.selected.has(row.row))
    .map((row) => ({ row: row.row, fingerprint: row.fingerprint, [field]: true }));
  if (changes.length === 0) return;
  await runAction(button, async () => {
    afterUpdate(await call('ccUpdate', { changes }));
    await loadRows();
  });
}

function afterUpdate(res) {
  const stale = num(res.stale);
  state.openRow = null;
  toast(stale > 0 ? `${stale} row(s) changed in the sheet — refreshed` : `Updated ${num(res.updated)} row(s)`);
}

async function syncRange(start, end, button) {
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) {
    toast('Pick both dates first', 'error');
    return;
  }
  if (start > end) {
    toast('The start date is after the end date', 'error');
    return;
  }
  if (daysInRange(start, end) > MAX_SYNC_DAYS) {
    toast(`Sync at most ${MAX_SYNC_DAYS} days at a time`, 'error');
    return;
  }
  const out = $('sync-result');
  await runAction(button, async () => {
    const res = await call('ccSync', { start, end });
    out.textContent = String(res.message ?? '') || 'Sync finished.';
    out.hidden = false;
    await loadRows();
  });
}

async function loadSettled() {
  const res = await call('ccSettled');
  state.settled = Array.isArray(res.items) ? res.items : [];
  renderSettled();
  $('settled-status').textContent = state.settled.length ? '' : 'No settled rows.';
}

function renderSettled() {
  const items = state.settled.map((item) => el('li', { className: 'tx tx-plain' },
    el('span', { className: 'tx-top' },
      el('span', { className: 'tx-desc', text: text(item.description) || '(no description)' }),
      el('span', { className: 'amt', text: formatRupiah(item.amount) })),
    el('span', {
      className: 'tx-meta',
      text: [item.sheetName, item.cardNumber, Array.isArray(item.reasons) ? item.reasons.join(', ') : text(item.reasons)]
        .map(text).filter(Boolean).join(' · '),
    })));
  $('settled-list').replaceChildren(...items);
  $('settled-delete').textContent = deleteLabel();
}

function deleteLabel() {
  const count = state.settled.length;
  return `Delete ${count} row${count === 1 ? '' : 's'}`;
}

async function deleteSettled() {
  const items = state.settled.map(({ sheetName, rowIndex, fingerprint }) => ({ sheetName, rowIndex, fingerprint }));
  const res = await call('ccDeleteSettled', { items });
  const result = res.result || {};
  state.settled = [];
  renderSettled();
  $('settled-status').textContent = `Deleted ${result.deleted ?? 0}, ${result.stale ?? 0} changed in the sheet and left alone.`;
  await loadRows();
  if (result.success === false) throw new Error(result.error || 'Delete did not finish');
}
