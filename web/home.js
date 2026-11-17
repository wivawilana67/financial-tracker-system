// Financial tab ("Home"): month totals, unpaid by channel, jajan per person, Sheet Dashboard panel and tools.

import { call } from './api.js';
import { $, el, text, num, formatRupiah, toast, runAction } from './ui.js';

const SHEETS = ['Income', 'Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan'];
const PERSON_ALIASES = { wiva: 'Wiva', rio: 'Wiva', jane: 'Jane' };
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const state = { month: '', persons: [], payload: null };
let requestSeq = 0;
let dashboardLoaded = false;

const setStatus = (message) => { $('fin-status').textContent = message; };

export function init() {
  $('month-prev').addEventListener('click', () => state.month && changeMonth(shiftMonth(state.month, -1)));
  $('month-next').addEventListener('click', () => state.month && changeMonth(shiftMonth(state.month, 1)));
  $('month-input').addEventListener('change', (e) => changeMonth(e.currentTarget.value));
  $('dash').addEventListener('toggle', () => {
    if ($('dash').open) runAction(null, loadDashboard);
  });
  $('sort-btn').addEventListener('click', (e) => runAction(e.currentTarget, sortLedgers));
}

// Called each time the Financial tab opens. The month chosen earlier in this session is kept.
export function enter(session) {
  state.persons = Array.isArray(session?.persons) ? session.persons : [];
  if (!state.month) state.month = text(session?.month);
  $('month-input').value = state.month;
  return runAction(null, loadMonth);
}

export function reset() {
  state.payload = null;
  dashboardLoaded = false;
  setStatus('');
  $('fin-stats').replaceChildren();
  $('unpaid').replaceChildren();
  $('jajan').replaceChildren();
  $('dash-body').replaceChildren();
  $('dash').open = false;
}

function changeMonth(month) {
  if (!MONTH_PATTERN.test(month)) {
    $('month-input').value = state.month;
    return;
  }
  if (month === state.month) return;
  state.month = month;
  $('month-input').value = month;
  runAction(null, loadMonth);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// A newer month choice wins over a slower earlier response.
async function loadMonth() {
  const seq = ++requestSeq;
  setStatus('Loading…');
  let res;
  try {
    res = await call('month', { month: state.month });
  } catch (err) {
    if (seq === requestSeq) setStatus('Could not load this month.');
    throw err;
  }
  if (seq !== requestSeq) return;
  state.payload = res.payload || {};
  render();
  setStatus('');
}

function render() {
  const entries = Array.isArray(state.payload?.entries) ? state.payload.entries : [];
  renderStats(entries);
  renderUnpaid(entries);
  renderJajan(entries);
}

const isIncome = (entry) => entry.isIncome === true || entry.sheet === 'Income';

function renderStats(entries) {
  const totals = new Map(SHEETS.map((sheet) => [sheet, 0]));
  for (const entry of entries) {
    if (totals.has(entry.sheet)) totals.set(entry.sheet, totals.get(entry.sheet) + num(entry.amount));
  }
  const total = (sheet) => totals.get(sheet);
  const remaining = total('Income') - total('Saving') - total('Expense') - total('Ibadah') - total('Autodeduct Jajan');

  const cards = SHEETS.map((sheet) => stat(sheet, total(sheet)));
  cards.push(el('div', { className: `stat stat-remaining ${remaining >= 0 ? 'good' : 'bad'}` },
    el('span', { className: 'stat-label', text: 'Remaining' }),
    el('span', { className: 'stat-value amt', text: formatRupiah(remaining) })));
  $('fin-stats').replaceChildren(...cards);
}

function stat(label, value) {
  return el('div', { className: 'stat' },
    el('span', { className: 'stat-label', text: label }),
    el('span', { className: 'stat-value amt', text: formatRupiah(value) }));
}

function renderUnpaid(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (isIncome(entry) || entry.isPaid) continue;
    const channel = text(entry.channel) || 'No channel';
    if (!groups.has(channel)) groups.set(channel, { channel, total: 0, count: 0, rows: [] });
    const group = groups.get(channel);
    group.total += num(entry.amount);
    group.count += 1;
    group.rows.push(entry);
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total);
  if (sorted.length === 0) {
    $('unpaid').replaceChildren(el('p', { className: 'muted', text: 'Nothing unpaid this month.' }));
    return;
  }
  $('unpaid').replaceChildren(...sorted.map(groupCard));
}

function groupCard(group) {
  const list = el('ul', { className: 'rows', hidden: true },
    ...group.rows.map((entry) => el('li', { className: 'row-line' },
      el('span', { text: [text(entry.list), text(entry.type)].filter(Boolean).join(' · ') }),
      el('span', { className: 'amt', text: formatRupiah(entry.amount) }))));
  const head = el('button', { type: 'button', className: 'group-head', attrs: { 'aria-expanded': 'false' } },
    el('span', { text: group.channel }),
    el('span', { className: 'amt', text: `${formatRupiah(group.total)} · ${group.count}` }));
  head.addEventListener('click', () => {
    const open = list.hidden;
    list.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
  });
  return el('div', { className: 'group' }, head, list);
}

const personOf = (value) => PERSON_ALIASES[text(value).toLowerCase()] || '';

function renderJajan(entries) {
  if (state.persons.length === 0) {
    $('jajan').replaceChildren(el('p', { className: 'muted', text: 'No people configured.' }));
    return;
  }
  const blocks = state.persons.map((person) => {
    let net = 0;
    let autodeduct = 0;
    for (const entry of entries) {
      if (entry.sheet === 'Expense' && text(entry.type).toLowerCase() === 'jajan' && personOf(entry.list) === person) {
        net += num(entry.amount);
      }
      if (entry.sheet === 'Autodeduct Jajan' && personOf(entry.type) === person) {
        autodeduct += num(entry.amount);
      }
    }
    return el('div', { className: 'person' },
      el('h3', { className: 'person-name', text: person }),
      line('Gross', net + autodeduct),
      line('Autodeduct', autodeduct),
      line('Net', net));
  });
  $('jajan').replaceChildren(...blocks);
}

function line(label, value) {
  return el('div', { className: 'row-line' },
    el('span', { text: label }),
    el('span', { className: 'amt', text: formatRupiah(value) }));
}

async function loadDashboard() {
  if (dashboardLoaded) return;
  $('dash-body').replaceChildren(el('p', { className: 'muted', text: 'Loading…' }));
  try {
    const res = await call('dashboard');
    renderDashboard(res.dashboard || {});
    dashboardLoaded = true;
  } catch (err) {
    $('dash-body').replaceChildren(el('p', { className: 'status', text: 'Could not load the dashboard. Open it again to retry.' }));
    throw err;
  }
}

function renderDashboard(d) {
  if (d.missing) {
    $('dash-body').replaceChildren(el('p', { className: 'muted', text: 'Dashboard tab not found' }));
    return;
  }
  const nodes = [el('p', { className: 'muted small', text: `Dashboard tab — month ${text(d.month)}` })];
  nodes.push(heading('Income'), table(['Item', 'Amount'], d.income));
  for (const card of Array.isArray(d.cards) ? d.cards : []) {
    nodes.push(heading(text(card.title)));
    nodes.push(table(['Summary', 'Amount', '%'], card.summary));
    nodes.push(table(['Category', 'Amount', '%'], card.categories));
  }
  nodes.push(heading('Channels'), table(['Channel', 'Expected', 'Paid', 'Remaining'], d.channels));
  nodes.push(heading('Jajan'), table(['Person', 'Jajan', 'Deduction', 'Final'], d.jajan));
  nodes.push(heading('Cicilan'), table(['List', 'Type', 'Amount', 'Payments left', 'Remaining amount', 'Month end'], d.cicilan));
  $('dash-body').replaceChildren(...nodes);
}

const heading = (label) => el('h3', { className: 'sub', text: label });

// Scrolls inside its own wrapper, never the page.
function table(headers, rows) {
  const body = (Array.isArray(rows) ? rows : []).map((row) =>
    el('tr', {}, ...(Array.isArray(row) ? row : []).map((cell) => el('td', { text: String(cell ?? '') }))));
  return el('div', { className: 'table-wrap' },
    el('table', {},
      el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
      el('tbody', {}, ...body)));
}

async function sortLedgers() {
  const res = await call('sortLedgers');
  const result = res.result || {};
  if (result.success === false) throw new Error(result.error || 'Sorting did not finish');
  toast('Ledger sheets sorted');
}
