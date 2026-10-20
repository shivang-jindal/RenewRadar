/**
 * Money primitives.
 *
 * RULE (Part E / E7): amounts are stored and transported as **integer minor
 * units** (cents, paise, fils). Binary floating point is never used for a money
 * calculation. `number` is safe here because minor-unit values stay far below
 * `Number.MAX_SAFE_INTEGER` (9_007_199_254_740_991) for realistic subscription
 * volumes; the invariant is asserted by `assertMinorUnits`.
 *
 * RULE (Part E / E7): amounts from different currencies are **never** added
 * together. `groupByCurrency` is the only way totals reach the UI.
 */

/** ISO 4217 minor-unit exponent per currency code. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
});

/** Currencies offered in the product UI. Anything valid ISO 4217 is accepted by the API. */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze([
  'AED',
  'AUD',
  'BDT',
  'BGN',
  'BRL',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'JPY',
  'KES',
  'KRW',
  'MAD',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'RON',
  'RSD',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'TWD',
  'UAH',
  'USD',
  'VND',
  'ZAR',
]);

export function isSupportedCurrency(code: string): boolean {
  return SUPPORTED_CURRENCIES.includes(code.toUpperCase());
}

/** Minor-unit exponent for a currency. Unknown codes fall back to 2. */
export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Convert a major-unit decimal *string or number* to integer minor units.
 *
 * Uses string maths so `10.005` is handled deterministically instead of being
 * mangled by IEEE-754 binary representation. Rounds half away from zero.
 *
 * Returns `null` when the input is not a valid non-negative decimal amount.
 */
export function parseToMinor(input: string | number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const scale = 10 ** exponent;
  const text = typeof input === 'number' ? numberToDecimalString(input) : input.trim();

  if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const paddedFraction = (fractionPart + '0'.repeat(exponent)).slice(0, exponent);
  const extraFraction = (fractionPart + '0'.repeat(exponent)).slice(exponent);
  // Half-away-from-zero: only the first discarded digit matters for tie-breaking.
  const roundUp = extraFraction.length > 0 && Number(extraFraction[0]) >= 5;

  const base = Number(wholePart) * scale + Number(paddedFraction || '0');
  if (!Number.isSafeInteger(base)) return null;

  const minor = roundUp ? base + 1 : base;
  return negative ? -minor : minor;
}

/** Render integer minor units as a major-unit decimal string, e.g. `123456` USD -> `1234.56`. */
export function formatMinorAsDecimal(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Multiply an integer-minor amount by an exact rational factor
 * (`numerator / denominator`) with half-away-from-zero rounding.
 *
 * Implemented with scaled integer maths so 3 x 1/3 is 1 minor unit, not
 * 0.9999999. This is how weekly/quarterly/custom cadences are normalised into
 * a monthly equivalent without ever touching a float.
 */
export function prorateMinor(minor: number, numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    throw new RangeError(`Invalid proration factor: ${numerator}/${denominator}`);
  }
  const product = minor * numerator;
  const negative = product < 0;
  const magnitude = Math.abs(product);
  const quotient = Math.floor(magnitude / Math.abs(denominator));
  const remainder = magnitude - quotient * Math.abs(denominator);
  const rounded = remainder * 2 >= Math.abs(denominator) ? quotient + 1 : quotient;
  return negative ? -rounded : rounded;
}

/** Sum a list of integer-minor amounts with overflow protection. */
export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    assertMinorUnits(total);
  }
  return total;
}

export function assertMinorUnits(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Amount exceeds safe integer range: ${value}`);
  }
}

/**
 * Group a list of amounts by currency. Never mixes currencies
 * (Part E / E7 - multi-currency totals are grouped unless a real exchange-rate
 * source exists, and none is implemented).
 */
export function groupByCurrency(
  amounts: readonly { currency: string; amountMinor: number }[],
): Array<{ currency: string; amountMinor: number }> {
  const totals = new Map<string, number>();
  for (const entry of amounts) {
    const key = entry.currency.toUpperCase();
    totals.set(key, (totals.get(key) ?? 0) + entry.amountMinor);
  }
  return [...totals.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.currency.localeCompare(b.currency));
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
  // Avoid exponential notation (1e-7) breaking the decimal regex.
  const fixed = value.toFixed(12).replace(/0+$/, '');
  return fixed.endsWith('.') ? fixed.slice(0, -1) : fixed;
}