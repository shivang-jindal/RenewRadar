/**
 * Renewal-date arithmetic (Part E / E3.3, E7).
 *
 * These are the rules a user trusts most: "renews on the 31st" must not drift
 * to the 28th forever, 29 February must behave the same way every year, and no
 * step may ever produce the same date twice or go backwards.
 */

import { describe, expect, it } from 'vitest';

import {
  addDaysIso,
  anchorDayOf,
  daysBetweenIso,
  daysInMonth,
  isAnchorDayClamped,
  isValidIsoDate,
  nextRenewalDate,
  parseDateParts,
  producesRenewalReminder,
  renewalSeries,
  renewalStatus,
  toIsoDate,
  upcomingRenewalDates,
  zonedWallClockToUtc,
} from '@renewradar/shared';

describe('the billing anchor', () => {
  it('is the day-of-month of the start date', () => {
    expect(anchorDayOf('2025-01-31')).toBe(31);
    expect(anchorDayOf('2024-02-29')).toBe(29);
    expect(anchorDayOf('2025-12-05')).toBe(5);
  });

  it('round-trips through the date parts', () => {
    expect(parseDateParts('2025-07-09')).toEqual({ year: 2025, month: 7, day: 9 });
    expect(toIsoDate({ year: 2025, month: 7, day: 9 })).toBe('2025-07-09');
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2025, 1)).toBe(28);
    expect(daysInMonth(2025, 0)).toBe(31);
  });

  it('flags a clamped renewal so the UI can explain it', () => {
    expect(isAnchorDayClamped('2025-02-28', 31)).toBe(true);
    expect(isAnchorDayClamped('2025-03-31', 31)).toBe(false);
    expect(isAnchorDayClamped('2024-02-29', 31)).toBe(true);
    expect(isAnchorDayClamped('2025-02-28', 28)).toBe(false);
  });
});

describe('monthly cadence and the month-end rule', () => {
  const monthly = (anchorDay: number) => (current: string) =>
    nextRenewalDate({ current, anchorDay, unit: 'monthly', intervalCount: 1 });

  it('clamps to the last day of a short month, then returns to the anchor', () => {
    const step = monthly(31);
    expect(step('2025-01-31')).toBe('2025-02-28');
    // The anchor is preserved: March is long enough for the 31st again.
    expect(step('2025-02-28')).toBe('2025-03-31');
    expect(step('2025-03-31')).toBe('2025-04-30');
    expect(step('2025-04-30')).toBe('2025-05-31');
  });

  it('uses 29 February in a leap year and 28 outside one', () => {
    expect(monthly(31)('2024-01-31')).toBe('2024-02-29');
    expect(monthly(31)('2025-01-31')).toBe('2025-02-28');
    // 1900 is not a leap year; 2000 is.
    expect(monthly(31)('1900-01-31')).toBe('1900-02-28');
    expect(monthly(31)('2000-01-31')).toBe('2000-02-29');
  });

  it('never re-emits the same date after clamping a short month', () => {
    // A subscription stored as "renews 28 Feb" with anchor 31: from 28 Feb the
    // next step must move to 31 March, not stay on 28 Feb.
    expect(monthly(31)('2025-02-28')).toBe('2025-03-31');
  });

  it('handles every month transition in one leap year without drift', () => {
    const series = upcomingRenewalDates({
      current: '2024-01-31',
      anchorDay: 31,
      unit: 'monthly',
      intervalCount: 1,
      count: 12,
    });
    expect(series).toEqual([
      '2024-02-29',
      '2024-03-31',
      '2024-04-30',
      '2024-05-31',
      '2024-06-30',
      '2024-07-31',
      '2024-08-31',
      '2024-09-30',
      '2024-10-31',
      '2024-11-30',
      '2024-12-31',
      '2025-01-31',
    ]);
  });

  it('keeps a plain mid-month subscription exactly on its day', () => {
    expect(monthly(15)('2025-01-15')).toBe('2025-02-15');
    expect(monthly(15)('2025-12-15')).toBe('2026-01-15');
    expect(monthly(30)('2025-11-30')).toBe('2025-12-30');
  });

  it('respects an interval count of more than one month', () => {
    expect(
      nextRenewalDate({ current: '2025-01-31', anchorDay: 31, unit: 'monthly', intervalCount: 3 }),
    ).toBe('2025-04-30');
    expect(
      nextRenewalDate({ current: '2025-01-15', anchorDay: 15, unit: 'monthly', intervalCount: 2 }),
    ).toBe('2025-03-15');
  });

  it('rejects an interval count that is not a whole positive number', () => {
    expect(() =>
      nextRenewalDate({ current: '2025-01-31', anchorDay: 31, unit: 'monthly', intervalCount: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      nextRenewalDate({ current: '2025-01-31', anchorDay: 31, unit: 'monthly', intervalCount: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      nextRenewalDate({ current: '2025-01-31', anchorDay: 31, unit: 'monthly', intervalCount: 1001 }),
    ).toThrow(RangeError);
  });

  it('rejects an invalid current date rather than guessing', () => {
    expect(() =>
      nextRenewalDate({ current: '2025-02-30', anchorDay: 30, unit: 'monthly', intervalCount: 1 }),
    ).toThrow(RangeError);
  });
});

describe('yearly cadence and leap days', () => {
  it('clamps a 29 February anchor and documents why it stays on the 28th', () => {
    const series = upcomingRenewalDates({
      current: '2024-02-29',
      anchorDay: 29,
      unit: 'yearly',
      intervalCount: 1,
      count: 3,
    });
    expect(series).toEqual(['2025-02-28', '2026-02-28', '2027-02-28']);
  });

  it('keeps a 29 February anchor inside the leap year', () => {
    expect(
      nextRenewalDate({ current: '2024-02-29', anchorDay: 29, unit: 'yearly', intervalCount: 1 }),
    ).toBe('2025-02-28');
    expect(
      nextRenewalDate({ current: '2024-02-29', anchorDay: 29, unit: 'yearly', intervalCount: 4 }),
    ).toBe('2028-02-29');
  });

  it('crosses a year boundary from a month-end anchor', () => {
    expect(
      nextRenewalDate({ current: '2025-08-31', anchorDay: 31, unit: 'yearly', intervalCount: 1 }),
    ).toBe('2026-08-31');
  });
});

describe('quarterly, weekly and custom cadences', () => {
  it('adds three months and clamps', () => {
    expect(
      nextRenewalDate({ current: '2025-01-31', anchorDay: 31, unit: 'quarterly', intervalCount: 1 }),
    ).toBe('2025-04-30');
  });

  it('adds whole weeks', () => {
    expect(
      nextRenewalDate({ current: '2025-02-27', anchorDay: 27, unit: 'weekly', intervalCount: 2 }),
    ).toBe('2025-03-13');
    expect(
      nextRenewalDate({ current: '2025-12-29', anchorDay: 29, unit: 'weekly', intervalCount: 1 }),
    ).toBe('2026-01-05');
  });

  it('adds whole days for a custom cadence, with no month clamping at all', () => {
    expect(
      nextRenewalDate({ current: '2025-01-31', anchorDay: 31, unit: 'custom', intervalCount: 45 }),
    ).toBe('2025-03-17');
    expect(
      nextRenewalDate({ current: '2025-02-28', anchorDay: 28, unit: 'custom', intervalCount: 1 }),
    ).toBe('2025-03-01');
  });
});

describe('the renewal series is always strictly increasing', () => {
  const cases = [
    { current: '2025-01-31', anchorDay: 31, unit: 'monthly' as const, intervalCount: 1 },
    { current: '2024-02-29', anchorDay: 29, unit: 'yearly' as const, intervalCount: 1 },
    { current: '2025-02-28', anchorDay: 30, unit: 'monthly' as const, intervalCount: 1 },
    { current: '2025-11-30', anchorDay: 31, unit: 'monthly' as const, intervalCount: 1 },
    { current: '2025-12-31', anchorDay: 31, unit: 'monthly' as const, intervalCount: 12 },
  ];

  for (const base of cases) {
    it(`stays ordered and unique for ${base.unit} from ${base.current}`, () => {
      const series = upcomingRenewalDates({ ...base, count: 24 });
      expect(series).toHaveLength(24);
      for (let index = 1; index < series.length; index += 1) {
        expect(new Date(series[index]!).getTime()).toBeGreaterThan(new Date(series[index - 1]!).getTime());
      }
      expect(new Set(series).size).toBe(series.length);
    });
  }

  it('back-fills history from the start date without touching the future', () => {
    const { history, future } = renewalSeries({
      startDate: '2025-01-31',
      current: '2025-04-30',
      unit: 'monthly',
      intervalCount: 1,
      lookAhead: 2,
    });
    expect(history).toEqual(['2025-02-28', '2025-03-31']);
    expect(future).toEqual(['2025-05-31', '2025-06-30']);
  });
});

describe('renewal state is derived, never invented', () => {
  it('classifies a renewal against today', () => {
    expect(renewalStatus({ nextRenewalDate: '2025-01-10', status: 'active', today: '2025-01-10' })).toBe('due');
    expect(renewalStatus({ nextRenewalDate: '2025-01-09', status: 'active', today: '2025-01-10' })).toBe('overdue');
    expect(renewalStatus({ nextRenewalDate: '2025-01-11', status: 'active', today: '2025-01-10' })).toBe('scheduled');
  });

  it('has no renewal state for a cancelled or undated subscription', () => {
    expect(renewalStatus({ nextRenewalDate: '2025-01-11', status: 'cancelled', today: '2025-01-10' })).toBe('none');
    expect(renewalStatus({ nextRenewalDate: null, status: 'active', today: '2025-01-10' })).toBe('none');
  });

  it('sends ordinary renewal reminders only for live subscriptions', () => {
    expect(producesRenewalReminder('active')).toBe(true);
    expect(producesRenewalReminder('trial')).toBe(true);
    // A *planned* cancellation still renews, so the user still needs the nudge.
    expect(producesRenewalReminder('cancel_planned')).toBe(true);
    expect(producesRenewalReminder('paused')).toBe(false);
    expect(producesRenewalReminder('cancelled')).toBe(false);
  });
});

describe('timezone-aware date helpers', () => {
  it('resolves a wall-clock time to the right instant across a DST boundary', () => {
    // 2025-03-09 02:30 America/New_York does not exist: the clocks jump 02:00
    // -> 03:00. Returning null is what stops the scheduler inventing a time.
    expect(zonedWallClockToUtc('2025-03-09', '02:30', 'America/New_York')).toBeNull();

    const before = zonedWallClockToUtc('2025-03-08', '09:00', 'America/New_York');
    expect(before?.toISOString()).toBe('2025-03-08T14:00:00.000Z'); // EST, UTC-5

    const after = zonedWallClockToUtc('2025-03-10', '09:00', 'America/New_York');
    expect(after?.toISOString()).toBe('2025-03-10T13:00:00.000Z'); // EDT, UTC-4
  });

  it('counts whole days between calendar dates without DST drift', () => {
    // US DST starts on 2025-03-09: there are only 23 hours in that local day.
    expect(daysBetweenIso('2025-03-08', '2025-03-10')).toBe(2);
    expect(daysBetweenIso('2025-03-10', '2025-03-08')).toBe(-2);
    expect(addDaysIso('2025-03-08', 2)).toBe('2025-03-10');
  });

  it('rejects impossible calendar dates', () => {
    expect(isValidIsoDate('2025-02-29')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2025-13-01')).toBe(false);
    expect(isValidIsoDate('01/01/2025')).toBe(false);
  });
});