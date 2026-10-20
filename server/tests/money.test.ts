/**
 * Money rules (Part E / E7).
 *
 * Two invariants the whole product rests on:
 *   1. every amount is an integer number of minor units - no float ever touches
 *      a stored or displayed value;
 *   2. amounts in different currencies are NEVER added together. RenewRadar has
 *      no exchange-rate source, so `groupByCurrency` is the only door a total
 *      may pass through.
 */

import { describe, expect, it } from 'vitest';

import {
  annualizedMinor,
  assertMinorUnits,
  currencyExponent,
  describePriceDelta,
  formatMinorAsDecimal,
  groupByCurrency,
  isSupportedCurrency,
  monthlyEquivalentMinor,
  parseToMinor,
  priceDelta,
  prorateMinor,
  sumMinor,
} from '@renewradar/shared';

describe('money: integer minor units', () => {
  it('knows the ISO 4217 exponent for common currencies', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('ZZZ')).toBe(2);
  });

  it('parses decimal strings into integer minor units', () => {
    expect(parseToMinor('1234.56', 'USD')).toBe(123456);
    expect(parseToMinor('9.99', 'USD')).toBe(999);
    expect(parseToMinor('10', 'JPY')).toBe(10);
    expect(parseToMinor('1.2345', 'KWD')).toBe(1235);
    expect(parseToMinor('-5.25', 'USD')).toBe(-525);
  });

  it('rounds half away from zero using string maths, not binary floats', () => {
    // 10.005 is not representable in IEEE-754; string maths still gives 1001.
    expect(parseToMinor('10.005', 'USD')).toBe(1001);
    expect(parseToMinor('0.005', 'USD')).toBe(1);
    expect(parseToMinor('0.004', 'USD')).toBe(0);
    expect(parseToMinor('-0.005', 'USD')).toBe(-1);
  });

  it('rejects malformed amounts instead of guessing', () => {
    expect(parseToMinor('1,234.56', 'USD')).toBeNull();
    expect(parseToMinor('abc', 'USD')).toBeNull();
    expect(parseToMinor('', 'USD')).toBeNull();
    expect(parseToMinor('$12.00', 'USD')).toBeNull();
    expect(parseToMinor('12.00 ', 'USD')).toBe(1200); // surrounding space is trimmed
  });

  it('formats minor units back to a decimal string', () => {
    expect(formatMinorAsDecimal(123456, 'USD')).toBe('1234.56');
    expect(formatMinorAsDecimal(1000, 'JPY')).toBe('1000');
    expect(formatMinorAsDecimal(0, 'USD')).toBe('0.00');
    expect(formatMinorAsDecimal(-500, 'USD')).toBe('-5.00');
    expect(formatMinorAsDecimal(1235, 'KWD')).toBe('1.235');
  });

  it('round-trips parse and format for every common exponent', () => {
    for (const [text, currency] of [
      ['1234.56', 'USD'],
      ['10', 'JPY'],
      ['1.235', 'KWD'],
    ] as const) {
      const minor = parseToMinor(text, currency);
      expect(minor).not.toBeNull();
      expect(formatMinorAsDecimal(minor!, currency)).toBe(text);
    }
  });

  it('rejects an amount that cannot survive a JS number', () => {
    expect(() => assertMinorUnits(1.5)).toThrow(RangeError);
    expect(() => assertMinorUnits(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => assertMinorUnits(123456)).not.toThrow();
  });
});

describe('money: exact rational proration', () => {
  it('divides without floating-point drift', () => {
    // 100/3 must be exactly 33, not 33.33333333333333.
    expect(prorateMinor(100, 1, 3)).toBe(33);
    expect(prorateMinor(101, 1, 3)).toBe(34);
    expect(prorateMinor(3, 1, 3)).toBe(1);
    expect(prorateMinor(3000, 1, 4)).toBe(750);
  });

  it('multiplies with half-away-from-zero rounding', () => {
    expect(prorateMinor(1000, 3, 1)).toBe(3000);
    expect(prorateMinor(-101, 1, 2)).toBe(-51);
    expect(prorateMinor(0, 1, 7)).toBe(0);
  });

  it('refuses an unusable factor', () => {
    expect(() => prorateMinor(100, 1, 0)).toThrow(RangeError);
    expect(() => prorateMinor(100, 1.5, 3)).toThrow(RangeError);
  });

  it('sums minor units with an overflow guard', () => {
    expect(sumMinor([100, 250, 25])).toBe(375);
    expect(sumMinor([])).toBe(0);
    expect(Number.isInteger(sumMinor([1, 2, 3]))).toBe(true);
  });
});

describe('THE rule: money in different currencies is never summed', () => {
  it('groups amounts by currency instead of adding them', () => {
    expect(
      groupByCurrency([
        { currency: 'USD', amountMinor: 100 },
        { currency: 'EUR', amountMinor: 250 },
        { currency: 'USD', amountMinor: 50 },
      ]),
    ).toEqual([
      { currency: 'EUR', amountMinor: 250 },
      { currency: 'USD', amountMinor: 150 },
    ]);
  });

  it('never reports a combined figure for two currencies', () => {
    const grouped = groupByCurrency([
      { currency: 'USD', amountMinor: 999_99 },
      { currency: 'EUR', amountMinor: 888_88 },
      { currency: 'GBP', amountMinor: 777_77 },
    ]);
    // Three currencies in, three currency buckets out - no fourth "total" row.
    expect(grouped).toHaveLength(3);
    expect(grouped.map((entry) => entry.amountMinor)).toEqual([99999, 88888, 77777]);
    expect(grouped.reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(99999 + 88888 + 77777);
  });

  it('treats currency codes case-insensitively so USD and usd cannot split', () => {
    expect(
      groupByCurrency([
        { currency: 'usd', amountMinor: 100 },
        { currency: 'USD', amountMinor: 20 },
      ]),
    ).toEqual([{ currency: 'USD', amountMinor: 120 }]);
  });

  it('returns nothing for an empty set rather than a zero bucket', () => {
    expect(groupByCurrency([])).toEqual([]);
  });

  it('keeps a zero-amount currency visible instead of silently dropping it', () => {
    expect(groupByCurrency([{ currency: 'JPY', amountMinor: 0 }])).toEqual([
      { currency: 'JPY', amountMinor: 0 },
    ]);
  });
});

describe('monthly normalisation stays in the original currency', () => {
  it('normalises every supported cadence with integer maths', () => {
    expect(monthlyEquivalentMinor({ amountMinor: 1500, unit: 'monthly', intervalCount: 1 })).toBe(1500);
    expect(monthlyEquivalentMinor({ amountMinor: 1000, unit: 'monthly', intervalCount: 3 })).toBe(3000);
    expect(monthlyEquivalentMinor({ amountMinor: 30000, unit: 'quarterly', intervalCount: 1 })).toBe(10000);
    expect(monthlyEquivalentMinor({ amountMinor: 12000, unit: 'yearly', intervalCount: 1 })).toBe(1000);
    expect(monthlyEquivalentMinor({ amountMinor: 700, unit: 'weekly', intervalCount: 1 })).toBe(3033);
    expect(monthlyEquivalentMinor({ amountMinor: 2600, unit: 'custom', intervalCount: 45 })).toBe(9616);
  });

  it('annualises by multiplying the monthly figure by twelve', () => {
    expect(annualizedMinor({ amountMinor: 1000, unit: 'monthly', intervalCount: 1 })).toBe(12000);
    expect(annualizedMinor({ amountMinor: 12000, unit: 'yearly', intervalCount: 1 })).toBe(12000);
  });

  it('rejects a nonsense cadence count', () => {
    expect(() => monthlyEquivalentMinor({ amountMinor: 100, unit: 'monthly', intervalCount: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('price history deltas never lie', () => {
  it('reports an opening price as "initial", not as an increase', () => {
    const delta = priceDelta({ oldAmountMinor: null, newAmountMinor: 1200, newCurrency: 'USD' });
    expect(delta.direction).toBe('initial');
    expect(delta.changePercent).toBeNull();
    expect(describePriceDelta(delta)).toBe('Initial price 1200 USD');
  });

  it('computes an absolute and percentage increase', () => {
    const delta = priceDelta({ oldAmountMinor: 1200, newAmountMinor: 1500, newCurrency: 'USD' });
    expect(delta.direction).toBe('increase');
    expect(delta.changeMinor).toBe(300);
    expect(delta.changePercent).toBe(25);
    expect(describePriceDelta(delta)).toBe('Increase +300 USD (+25%)');
  });

  it('computes a decrease', () => {
    const delta = priceDelta({ oldAmountMinor: 4400, newAmountMinor: 4000, newCurrency: 'USD' });
    expect(delta.direction).toBe('decrease');
    expect(delta.changeMinor).toBe(-400);
    expect(delta.changePercent).toBe(-9.09);
  });

  it('never infers a price change from a currency change alone', () => {
    const delta = priceDelta({
      oldAmountMinor: 1500,
      newAmountMinor: 1500,
      oldCurrency: 'USD',
      newCurrency: 'EUR',
    });
    expect(delta.currencyChanged).toBe(true);
    expect(delta.direction).toBe('unchanged');
    expect(delta.changePercent).toBeNull();
    expect(describePriceDelta(delta)).toBe('Currency changed to EUR; no price change is inferred');
  });

  it('withholds a percentage when the previous amount was zero', () => {
    const delta = priceDelta({ oldAmountMinor: 0, newAmountMinor: 500, newCurrency: 'USD' });
    expect(delta.direction).toBe('increase');
    expect(delta.changeMinor).toBe(500);
    expect(delta.changePercent).toBeNull();
  });

  it('reports an unchanged price as unchanged', () => {
    const delta = priceDelta({ oldAmountMinor: 1000, newAmountMinor: 1000, newCurrency: 'USD' });
    expect(delta.direction).toBe('unchanged');
    expect(delta.changePercent).toBe(0);
    expect(describePriceDelta(delta)).toBe('No price change');
  });
});

describe('currency allowlist', () => {
  it('accepts real ISO codes the UI offers', () => {
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('eur')).toBe(true);
    expect(isSupportedCurrency('JPY')).toBe(true);
  });

  it('rejects something that is not a currency', () => {
    expect(isSupportedCurrency('XYZ')).toBe(false);
    expect(isSupportedCurrency('US')).toBe(false);
  });
});