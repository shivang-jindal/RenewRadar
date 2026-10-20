/**
 * Renewal calendar (Part E / E3.5).
 *
 * Produces renewal, trial-end and cancellation-deadline events for a date
 * range, plus a standards-compliant iCalendar document.
 *
 * `.ics` notes:
 *  - Dates are all-day `VALUE=DATE` events, which is what a billing date is.
 *    There is no time zone to get wrong for an all-day event.
 *  - Lines are folded at 75 octets and CR/LF terminated per RFC 5545.
 *  - Text values are escaped (`\\`, `\;`, `\,`, `\n`) and a DTSTAMP/UID is
 *    always present, so the output is deterministic and re-importable.
 *  - There is no OAuth or provider integration behind it: the file is
 *    downloaded by the user. RenewRadar never claims a calendar "sync".
 */

import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';

import type { CalendarEvent, CalendarRange } from '@renewradar/shared';
import {
  addDaysIso,
  producesRenewalReminder,
  upcomingRenewalDates,
  type IntervalUnit,
  type ReminderEventType,
  type SubscriptionStatus,
} from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { categories, organizations, subscriptions } from '../db/schema.js';
import { notFound } from '../errors.js';

/** Statuses that are archived or cancelled contribute no future events. */
const LIVE_STATUSES = ['active', 'trial', 'paused', 'cancel_planned'] as const;

export interface CalendarQuery {
  from: string;
  to: string;
  categoryId?: string;
  ownerUserId?: string;
  status: string;
  eventType: string;
}

export interface CalendarSource {
  id: string;
  name: string;
  vendorName: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorToken: string | null;
  ownerUserId: string | null;
  status: string;
  intervalUnit: string;
  intervalCount: number;
  startDate: string;
  nextRenewalDate: string | null;
  trialEndDate: string | null;
  cancellationDeadline: string | null;
  amountMinor: number;
  currency: string;
  notes: string | null;
}

export class CalendarService {
  constructor(private readonly db: AppDatabase) {}

  async range(organizationId: string, query: CalendarQuery): Promise<CalendarRange> {
    // The query builder rather than `db.execute({ text, values })`: the latter
    // is a node-postgres-only shape and throws on the embedded PGlite driver.
    const organization = (
      await this.db
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
    )[0];

    const rows = await this.sources(organizationId, query);
    const events = this.expand(rows, query);

    return {
      from: query.from,
      to: query.to,
      events,
      icsAvailable: events.length > 0,
      icsNotice:
        events.length === 0
          ? 'There is nothing to export for this range yet.'
          : 'Downloads an iCalendar file you can import into your own calendar. RenewRadar does not connect to any calendar provider.',
      timezone: organization?.timezone ?? 'UTC',
    };
  }

  private async sources(organizationId: string, query: CalendarQuery): Promise<CalendarSource[]> {
    const filters = [
      eq(subscriptions.organizationId, organizationId),
      isNull(subscriptions.archivedAt),
      lte(subscriptions.nextRenewalDate, query.to),
      inArray(subscriptions.status, [...LIVE_STATUSES]),
    ];
    if (query.categoryId) filters.push(eq(subscriptions.categoryId, query.categoryId));
    if (query.ownerUserId) filters.push(eq(subscriptions.ownerUserId, query.ownerUserId));

    const rows = await this.db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        vendorName: subscriptions.vendorName,
        categoryId: subscriptions.categoryId,
        categoryName: categories.name,
        categoryColorToken: categories.colorToken,
        ownerUserId: subscriptions.ownerUserId,
        status: subscriptions.status,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
        startDate: subscriptions.startDate,
        nextRenewalDate: subscriptions.nextRenewalDate,
        trialEndDate: subscriptions.trialEndDate,
        cancellationDeadline: subscriptions.cancellationDeadline,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        notes: subscriptions.notes,
      })
      .from(subscriptions)
      .leftJoin(categories, eq(categories.id, subscriptions.categoryId))
      .where(and(...filters))
      .orderBy(asc(subscriptions.nextRenewalDate));

    return rows as CalendarSource[];
  }

  /**
   * Turn subscriptions into dated events.
   *
   * Renewals are projected forward with the shared recurrence engine, so a
   * monthly subscription contributes one event per month inside the range
   * instead of only its stored `next_renewal_date`.
   */
  expand(rows: CalendarSource[], query: CalendarQuery): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const wantRenewal = query.eventType === 'all' || query.eventType === 'renewal';
    const wantTrial = query.eventType === 'all' || query.eventType === 'trial_end';
    const wantDeadline = query.eventType === 'all' || query.eventType === 'cancellation_deadline';

    for (const row of rows) {
      if (query.status !== 'all' && row.status !== query.status) continue;

      if (wantTrial && row.trialEndDate) {
        if (row.trialEndDate >= query.from && row.trialEndDate <= query.to) {
          events.push(toEvent(row, 'trial_end', row.trialEndDate));
        }
      }

      if (wantDeadline && row.cancellationDeadline) {
        if (row.cancellationDeadline >= query.from && row.cancellationDeadline <= query.to) {
          events.push(toEvent(row, 'cancellation_deadline', row.cancellationDeadline));
        }
      }

      if (!wantRenewal || !row.nextRenewalDate) continue;
      // Paused subscriptions do not bill, so they project no renewals.
      if (!producesRenewalReminder(row.status)) continue;

      // `startDate` is the anchor source of truth for the month-end rule.
      const anchorDay = Number(row.startDate.slice(8, 10));
      let cursor: string | null = row.nextRenewalDate;

      // Guard against an absurd range request by capping the projection.
      for (let guard = 0; cursor && cursor <= query.to && guard < 400; guard += 1) {
        if (cursor >= query.from) events.push(toEvent(row, 'renewal', cursor));
        cursor = nextDateFor(row, anchorDay);
      }
    }

    return events.sort((a, b) => a.date.localeCompare(b.date) || a.subscriptionName.localeCompare(b.subscriptionName));
  }

  /** RFC 5545 iCalendar document for the given events. */
  toIcs(events: CalendarEvent[], stamp: Date, calendarName: string): string {
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//RenewRadar//Renewal Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    ];

    for (const event of events) {
      lines.push(
        'BEGIN:VEVENT',
        // A stable UID means re-importing the same file updates rather than
        // duplicates the event.
        `UID:${event.subscriptionId}-${event.eventType}-${event.date}@renewradar`,
        // All-day event: DTSTART/DTEND are dates and no TZID is used.
        `DTSTART;VALUE=DATE:${compactDate(event.date)}`,
        `DTEND;VALUE=DATE:${compactDate(addDaysIso(event.date, 1))}`,
        `DTSTAMP:${compactStamp(stamp)}`,
        `SUMMARY:${escapeIcsText(`${EVENT_LABELS[event.eventType]}: ${event.subscriptionName}`)}`,
        `DESCRIPTION:${escapeIcsText(descriptionFor(event))}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }

    lines.push('END:VCALENDAR');
    // RFC 5545 requires CRLF line endings.
    return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
  }

  async eventCountInRange(organizationId: string, from: string, to: string): Promise<number> {
    const rows = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          isNull(subscriptions.archivedAt),
          gte(subscriptions.nextRenewalDate, from),
          lte(subscriptions.nextRenewalDate, to),
        ),
      );
    return rows.length;
  }

  async requireSubscription(organizationId: string, subscriptionId: string): Promise<void> {
    const rows = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
      .limit(1);
    if (!rows[0]) throw notFound('Subscription');
  }
}

const EVENT_LABELS: Record<ReminderEventType, string> = {
  renewal: 'Renewal',
  trial_end: 'Trial ends',
  cancellation_deadline: 'Cancellation deadline',
};

function toEvent(row: CalendarSource, eventType: ReminderEventType, date: string): CalendarEvent {
  return {
    id: `${row.id}:${eventType}:${date}`,
    subscriptionId: row.id,
    subscriptionName: row.name,
    vendorName: row.vendorName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryColorToken: row.categoryColorToken,
    eventType,
    date,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status as SubscriptionStatus,
  };
}

function nextDateFor(row: CalendarSource, anchorDay: number): string | null {
  if (!row.nextRenewalDate) return null;
  const [next] = upcomingRenewalDates({
    current: row.nextRenewalDate,
    anchorDay,
    unit: row.intervalUnit as IntervalUnit,
    intervalCount: row.intervalCount,
    count: 1,
  });
  return next ?? null;
}

function descriptionFor(event: CalendarEvent): string {
  const parts = [
    `Subscription: ${event.subscriptionName}`,
    `Vendor: ${event.vendorName}`,
    `Amount: ${event.amountMinor} minor units ${event.currency}`,
    `Status: ${event.status}`,
  ];
  if (event.categoryName) parts.push(`Category: ${event.categoryName}`);
  parts.push('Recorded in RenewRadar.');
  return parts.join('\n');
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 content-line folding: 75 octets, continuation lines start with a space. */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const output: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    // 75 for the first line, 74 afterwards because each continuation carries
    // a leading space that counts towards the 75 octet limit.
    const limit = output.length === 0 ? 75 : 74;
    if (currentBytes + size > limit) {
      output.push(current);
      current = character;
      currentBytes = size;
    } else {
      current += character;
      currentBytes += size;
    }
  }
  if (current) output.push(current);
  return output.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n');
}

function compactDate(value: string): string {
  return value.replace(/-/g, '');
}

function compactStamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}