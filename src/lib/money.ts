/**
 * Amounts from the API are in the currency's smallest unit (paise, cents),
 * as the payment providers keep them. This shows them in the currency.
 */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    const value = amount / 10 ** digits;
    // Whole amounts without ".00"
    return Number.isInteger(value)
      ? new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(value)
      : fmt.format(value);
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

/** The smallest unit for an amount typed in the currency (499 → 49900 paise) */
export function toMinorUnits(value: number, currency: string): number {
  try {
    const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
    return Math.round(value * 10 ** digits);
  } catch {
    return Math.round(value * 100);
  }
}

export const intervalLabel = (interval: string) => (interval === 'YEAR' ? 'year' : 'month');
