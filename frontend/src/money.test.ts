import { describe, expect, it } from 'vitest';

import { barWidth, formatPercent, formatRupiah } from './money';

describe('formatRupiah', () => {
  it('groups thousands with dots and drops the cents', () => {
    expect(formatRupiah('4000000.00')).toBe('Rp 4.000.000');
    expect(formatRupiah('950.00')).toBe('Rp 950');
    expect(formatRupiah('1250000')).toBe('Rp 1.250.000');
  });
  it('keeps the sign', () => {
    expect(formatRupiah('-15000.00')).toBe('-Rp 15.000');
  });
});

describe('formatPercent', () => {
  it('shows one decimal and a dash for nonsense', () => {
    expect(formatPercent('40')).toBe('40.0%');
    expect(formatPercent('abc')).toBe('–');
  });
});

describe('barWidth', () => {
  it('is the share of the scale, clamped', () => {
    expect(barWidth('50', '100')).toBe(50);
    expect(barWidth('250', '100')).toBe(100);
    expect(barWidth('-5', '100')).toBe(0);
    expect(barWidth('5', '0')).toBe(0);
  });
});
