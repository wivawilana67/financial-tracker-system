// DOM, formatting and feedback helpers. Sheet text always goes into the page with textContent.

export const $ = (id) => document.getElementById(id);

// el('div', { className, text, attrs, ...properties }, ...children)
// Children may be nested arrays; null, undefined, false and '' are skipped.
export function el(tag, { className, text: label, attrs, ...props } = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false && child !== '') node.append(child);
  }
  return node;
}

export const text = (value) => String(value ?? '').trim();

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 1500000 -> "Rp 1.500.000", -250000 -> "-Rp 250.000". Non-numeric input is shown as typed.
export function formatRupiah(value) {
  if (value === null || value === undefined || value === '') return '–';
  const n = Number(value);
  if (!Number.isFinite(n)) return text(value);
  const whole = Math.round(n);
  const digits = String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${whole < 0 ? '-' : ''}Rp ${digits}`;
}

let toastTimer;
// kind: 'info' or 'error'. Announced through the aria-live region #toast.
export function toast(message, kind = 'info') {
  const box = $('toast');
  box.textContent = message;
  box.className = `toast ${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === 'error' ? 4000 : 2600);
}

const VIEWS = ['setup', 'signin', 'cc', 'fin', 'settings'];

export function showView(name) {
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  window.scrollTo(0, 0);
}

export function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.classList.toggle('busy', busy);
}

// Runs one network action: busy state on the button, failures shown as a toast.
export async function runAction(button, task) {
  setBusy(button, true);
  try {
    return await task();
  } catch (err) {
    console.error('[ui] action failed', err);
    toast(err.message, 'error');
    return undefined;
  } finally {
    setBusy(button, false);
  }
}

// No window.confirm: the first tap arms the button, a second tap within 4 seconds runs action().
const armed = new WeakMap();
export function confirmTwice(button, label, action) {
  const pending = armed.get(button);
  if (pending) {
    clearTimeout(pending);
    armed.delete(button);
    button.textContent = label;
    action();
    return;
  }
  button.textContent = 'Tap again to confirm';
  const timer = setTimeout(() => {
    armed.delete(button);
    button.textContent = label;
  }, 4000);
  armed.set(button, timer);
}
