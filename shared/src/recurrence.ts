/**
 * Recurrence engine (Part E / E7).
 *
 * ## The billing anchor
 *
 * A subscription stores `startDate` (the day the billing relationship started)
 * and `nextRenewalDate` (the next expected charge). The **anchor day** is the
 * day-of-month taken from `startDate`, and it is what every month-based
 * calculation returns to.
 *
 * ## The month-end rule
 *
 * When the anchor day does not exist in the target month, the renewal lands on
 * the **last day of that month** and the anchor day is preserved for the
 * following period:
 *
 *   anchor day 31:  31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> 31 May
 *   anchor day 31 in a leap year: 31 Jan -> 29 Feb -> 31 Mar
 *   anchor day 30:  30 Nov -> 31 Dec (clamped) -> 30 Jan
 *
 * ## Leap-day yearly renewals
 *
 * A yearly subscription anchored on 29 February behaves the same way:
 *
 *   anchor day 29, start 2024-02-29 -> 2025-02-28 -> 2026-02-28 -> 2027-02-28 ...
 *
 * 28 February is a real date every year, so once the anchor is clamped the
 * series stays on 28 February. The original anchor day (29) is retained in
 * `startDate`, so if the user ever re-anchors, 29 February is used again in a
 * leap year. This is documented rather than silent: `isAnchorDayClamped()`
 * tells the UI when the next date is not on the original anchor day.
 *
 * ## Custom cadence
 *
 * `custom` means "every N days" and is pure day arithmetic from the current
 * renewal date. No month clamping applies.
 *
 * ## Normalising to a monthly equivalent
 *
 * The overview shows a monthly recurring cost. That figure is a *normalised
 * estimate*, not a bill forecast:
 *
 *   weekly    -> amount * 52 / 12      (52 weeks per year)
 *   monthly   -> amount * intervalCount
 *   quarterly -> amount * intervalCount / 3
 *   yearly    -> amount * intervalCount / 12
 *   custom    -> amount * intervalCount * 30 / 365
 *
 * Everything is integer minor-unit maths (see `prorateMinor`). The annualised
 * figure is simply the monthly figure x 12 and is labelled as an estimate in
 * the UI; it ignores price changes, trials, proration, taxes and currency
 * conversion (Part E / E3.1).
 */

import type { IntervalUnit } from './constants.js';
import { addDaysIso, daysBetweenIso, isValidIsoDate } from './dates.js';
import { prorateMinor } from './money.js';

/** Days in a month, leap-year aware. */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export interface DateParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
}

export function parseDateParts(date: string): DateParts {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

export function toIsoDate(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day,
  ).padStart(2, '0')}`;
}

/** Day-of-month of the billing anchor. Stored on `subscriptions.start_date`. */
export function anchorDayOf(startDate: string): number {
  return parseDateParts(startDate).day;
}

/**
 * True when `date` sits on the last day of its month while the anchor day is
 * later than that. Used to explain a month-end renewal in the UI.
 */
export function isAnchorDayClamped(date: string, anchorDay: number): boolean {
  const { year, month, day } = parseDateParts(date);
  return day === daysInMonth(year, month - 1) && day < anchorDay;
}

function addMonthsClamped(date: string, months: number, anchorDay: number): string {
  const { year, month } = parseDateParts(date);
  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  const limit = daysInMonth(targetYear, targetMonth);
  return toIsoDate({ year: targetYear, month: targetMonth + 1, day: Math.min(anchorDay, limit) });
}

function assertCadence(unit: IntervalUnit, intervalCount: number): number {
  if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 1_000) {
    throw new RangeError(`intervalCount must be an integer between 1 and 1000, received ${intervalCount}`);
  }
  return intervalCount;
}

const MONTHS_PER_UNIT: Record<IntervalUnit, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
  custom: 0,
};

/**
 * The single renewal date that follows `current`.
 *
 * Always returns a date strictly greater than `current`, even when the previous
 * step was clamped to the end of a short month.
 */
export function nextRenewalDate(input: {
  current: string;
  anchorDay: number;
  unit: IntervalUnit;
  intervalCount: number;
}): string {
  const { current, anchorDay } = input;
  const count = assertCadence(input.unit, input.intervalCount);
  if (!isValidIsoDate(current)) {
    throw new RangeError(`Invalid ISO date: ${current}`);
  }

  let candidate =
    input.unit === 'custom'
      ? addDaysIso(current, count)
      : input.unit === 'weekly'
        ? addDaysIso(current, count * 7)
        : addMonthsClamped(current, MONTHS_PER_UNIT[input.unit] * count, anchorDay);

  // Defensive: a clamped step must still move forward. One extra period is
  // enough for every supported cadence.
  let guard = 0;
  while (candidate <= current && guard < 3) {
    candidate =
      input.unit === 'custom'
        ? addDaysIso(candidate, count)
        : input.unit === 'weekly'
          ? addDaysIso(candidate, count * 7)
          : addMonthsClamped(candidate, MONTHS_PER_UNIT[input.unit] * count, anchorDay);
    guard += 1;
  }
  return candidate;
}

/**
 * The next `count` renewal dates after `current`, oldest first.
 * The first entry is `nextRenewalDate(...)`; later entries keep returning to
 * the original anchor day.
 */
export function upcomingRenewalDates(input: {
  current: string;
  anchorDay: number;
  unit: IntervalUnit;
  intervalCount: number;
  count: number;
}): string[] {
  const total = Math.max(0, Math.trunc(input.count));
  const dates: string[] = [];
  let cursor = input.current;
  for (let index = 0; index < total; index += 1) {
    cursor = nextRenewalDate({ ...input, current: cursor });
    dates.push(cursor);
  }
  return dates;
}

/**
 * Back-fill the renewal series from `startDate` until it reaches `current`,
 * then continue forward. Used when a user corrects `nextRenewalDate` and the
 * history should still line up.
 */
export function renewalSeries(input: {
  startDate: string;
  current: string;
  unit: IntervalUnit;
  intervalCount: number;
  lookAhead: number;
}): { history: string[]; future: string[] } {
  const anchorDay = anchorDayOf(input.startDate);
  const history: string[] = [];
  let cursor = input.startDate;
  let guard = 0;
  while (cursor < input.current && guard < 2_000) {
    cursor = nextRenewalDate({ current: cursor, anchorDay, unit: input.unit, intervalCount: input.intervalCount });
    if (cursor >= input.current) break;
    history.push(cursor);
    guard += 1;
  }
  return {
    history,
    future: upcomingRenewalDates({
      current: input.current,
      anchorDay,
      unit: input.unit,
      intervalCount: input.intervalCount,
      count: input.lookAhead,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Cost normalisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Monthly-equivalent cost of one charge on a given cadence.
 *
 * Documented approximation - see the module header. Returns integer minor
 * units in the *same* currency; never converts.
 */
export function monthlyEquivalentMinor(input: {
  amountMinor: number;
  unit: IntervalUnit;
  intervalCount: number;
}): number {
  const count = assertCadence(input.unit, input.intervalCount);
  switch (input.unit) {
    case 'weekly':
      return prorateMinor(input.amountMinor, 52 * count, 12);
    case 'monthly':
      return input.amountMinor * count;
    case 'quarterly':
      return prorateMinor(input.amountMinor, count, 3);
    case 'yearly':
      return prorateMinor(input.amountMinor, count, 12);
    case 'custom':
      return prorateMinor(input.amountMinor, count * 30, 365);
  }
}

/** The annualized estimate is the monthly figure x 12. */
export function annualizedMinor(input: {
  amountMinor: number;
  unit: IntervalUnit;
  intervalCount: number;
}): number {
  return monthlyEquivalentMinor(input) * 12;
}

/* -------------------------------------------------------------------------- */
/* Status derivations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Paused and cancelled subscriptions do not produce ordinary renewal reminders
 * (Part E / E7). A cancellation that is only *planned* still does: the user
 * still has to act before the renewal date.
 */
export function producesRenewalReminder(status: string): boolean {
  return status === 'active' || status === 'trial' || status === 'cancel_planned';
}

export function isTrialActive(trialEndDate: string | null, today: string): boolean {
  if (!trialEndDate) return false;
  return daysBetweenIso(today, trialEndDate) >= 0;
}

/** A subscription is "overdue" for renewal when its next renewal is in the past. */
export function renewalStatus(input: {
  nextRenewalDate: string | null;
  status: string;
  today: string;
}): 'scheduled' | 'due' | 'overdue' | 'none' {
  if (!input.nextRenewalDate) return 'none';
  if (input.status === 'cancelled') return 'none';
  const days = daysBetweenIso(input.today, input.nextRenewalDate);
  if (days < 0) return 'overdue';
  if (days === 0) return 'due';
  return 'scheduled';
}

/* -------------------------------------------------------------------------- */
/* Price-history deltas                                                        */
/* -------------------------------------------------------------------------- */

export interface PriceDelta {
  oldAmountMinor: number | null;
  newAmountMinor: number;
  currency: string;
  /** Signed absolute change in minor units. */
  changeMinor: number;
  /** Signed percentage change, or `null` when the previous amount was 0. */
  changePercent: number | null;
  direction: 'increase' | 'decrease' | 'unchanged' | 'initial';
  /** True when only the currency changed, so no price change is claimed. */
  currencyChanged: boolean;
}

/**
 * Absolute and percentage difference between two recorded prices.
 *
 * A currency change alone is never reported as a price increase
 * (Part E / E3.7): `changePercent` is `null` and `direction` is `unchanged`.
 */
export function priceDelta(input: {
  oldAmountMinor: number | null;
  newAmountMinor: number;
  oldCurrency?: string | null;
  newCurrency: string;
}): PriceDelta {
  const oldCurrency = input.oldCurrency ?? null;
  const currencyChanged = oldCurrency !== null && oldCurrency.toUpperCase() !== input.newCurrency.toUpperCase();

  if (input.oldAmountMinor === null) {
    return {
      oldAmountMinor: null,
      newAmountMinor: input.newAmountMinor,
      currency: input.newCurrency,
      changeMinor: input.newAmountMinor,
      changePercent: null,
      direction: 'initial',
      currencyChanged,
    };
  }

  const changeMinor = input.newAmountMinor - input.oldAmountMinor;
  if (currencyChanged) {
    return {
      oldAmountMinor: input.oldAmountMinor,
      newAmountMinor: input.newAmountMinor,
      currency: input.newCurrency,
      changeMinor,
      changePercent: null,
      direction: 'unchanged',
      currencyChanged: true,
    };
  }

  const changePercent =
    input.oldAmountMinor === 0
      ? null
      : Math.round((changeMinor / Math.abs(input.oldAmountMinor)) * 10_000) / 100;

  return {
    oldAmountMinor: input.oldAmountMinor,
    newAmountMinor: input.newAmountMinor,
    currency: input.newCurrency,
    changeMinor,
    changePercent,
    direction: changeMinor > 0 ? 'increase' : changeMinor < 0 ? 'decrease' : 'unchanged',
    currencyChanged,
  };
}

/** Human summary used by the UI and the CSV export. */
export function describePriceDelta(delta: PriceDelta): string {
  switch (delta.direction) {
    case 'initial':
      return `Initial price ${delta.newAmountMinor} ${delta.currency}`;
    case 'unchanged':
      return delta.currencyChanged
        ? `Currency changed to ${delta.currency}; no price change is inferred`
        : `No price change`;
    case 'increase':
    case 'decrease': {
      const sign = delta.changeMinor > 0 ? '+' : '-';
      const percent = delta.changePercent === null ? '' : ` (${sign}${Math.abs(delta.changePercent)}%)`;
      return `${delta.direction === 'increase' ? 'Increase' : 'Decrease'} ${sign}${Math.abs(
        delta.changeMinor,
      )} ${delta.currency}${percent}`;
    }
  }
}