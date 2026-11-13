import { describe, expect, it } from 'vitest';
import { formatMoney, fromMinorUnits, intervalLabel, toMinorUnits } from './money';

describe('amounts in the smallest unit', () => {
  it('converts by the currency’s own number of decimals', () => {
    expect(toMinorUnits(499, 'INR')).toBe(49900);
    expect(toMinorUnits(4.99, 'usd')).toBe(499);
    expect(toMinorUnits(500, 'JPY')).toBe(500); // no decimals
    expect(fromMinorUnits(49900, 'INR')).toBe(499);
    expect(fromMinorUnits(500, 'JPY')).toBe(500);
  });

  it('rounds what floating point leaves over', () => {
    expect(toMinorUnits(19.99, 'USD')).toBe(1999);
    expect(toMinorUnits(0.07, 'EUR')).toBe(7);
  });

  it('falls back to two decimals for a code that is not a currency', () => {
    expect(toMinorUnits(5, 'not-a-currency')).toBe(500);
    expect(fromMinorUnits(500, 'not-a-currency')).toBe(5);
    expect(formatMoney(1234, 'not-a-currency')).toBe('12.34 NOT-A-CURRENCY');
  });
});

describe('formatMoney', () => {
  it('shows whole amounts without decimals and others with them', () => {
    expect(formatMoney(49900, 'INR')).toMatch(/499$/);
    expect(formatMoney(49950, 'INR')).toMatch(/499\.50$/);
    expect(formatMoney(500, 'JPY')).toMatch(/500$/);
  });
});

describe('intervalLabel', () => {
  it('names the billing interval', () => {
    expect(intervalLabel('YEAR')).toBe('year');
    expect(intervalLabel('MONTH')).toBe('month');
  });
});
