// Rupiah formatting for values the API sends as strings ("4000000.00"). Never parsed as a float for
// arithmetic; the server does the maths. Indonesian grouping: dots for thousands.

export function formatRupiah(value: string): string {
  const negative = value.trim().startsWith('-');
  const digits = value.replace('-', '').split('.');
  const whole = digits[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}Rp ${whole}`;
}

export function formatPercent(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '–';
}

/** Width of a bar as a percentage of the scale, clamped to 0–100. */
export function barWidth(amount: string, scale: string): number {
  const a = Number(amount);
  const s = Number(scale);
  if (!Number.isFinite(a) || !Number.isFinite(s) || s <= 0) return 0;
  return Math.min(100, Math.max(0, (a / s) * 100));
}
