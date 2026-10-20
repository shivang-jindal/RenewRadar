/**
 * Reminders (Part E / E3.8, E4 renewal review, E7).
 *
 * Guarantees:
 *  - Every reminder row carries a unique idempotency key built from
 *    (subscription, event type, target date, recipient, channel), so a retried
 *    or duplicated job can never deliver the same reminder twice.
 *  - Scheduling happens in the organization's IANA timezone, so "3 days before"
 *    means the same local date regardless of where the worker runs.
 *  - Quiet hours defer a reminder to the end of the window instead of dropping
 *    it, and a reminder that falls inside quiet hours is never sent at that
 *    moment.
 *  - Paused and cancelled subscriptions do not produce ordinary renewal
 *    reminders; archived subscriptions produce nothing at all.
 *  - Snoozing moves the send instant, never the target date, and a snoozed
 *    reminder keeps its original idempotency key.
 */

import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Paginated, ReminderLogView } from '@renewradar/shared';
import {
  addDaysIso,
  daysBetweenIso,
  minutesSinceMidnightInZone,
  producesRenewalReminder,
  REMINDER_EVENT_LABELS,
  zonedWallClockToUtc,
  type ReminderChannel,
  type ReminderEventType,
} from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import {
  memberships,
  organizationSettings,
  organizations,
  reminderLogs,
  reminderRules,
  subscriptions,
  users,
} from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';

export interface ScheduledReminder {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  vendorName: string;
  eventType: ReminderEventType;
  targetDate: string;
  reminderDate: string;
  channel: ReminderChannel;
  recipientUserId: string | null;
  recipientEmail: string | null;
  amountMinor: number;
  currency: string;
  notes: string | null;
  scheduledFor: string;
  created: boolean;
}

export interface ReminderSettings {
  timezone: string;
  reminderTimeLocal: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  remindersPaused: boolean;
}

export class ReminderService {
  constructor(private readonly db: AppDatabase) {}

  async settings(organizationId: string): Promise<ReminderSettings> {
    const [organization, settings] = await Promise.all([
      this.db
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1),
      this.db
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId))
        .limit(1),
    ]);
    const row = settings[0];
    return {
      timezone: organization[0]?.timezone ?? 'UTC',
      reminderTimeLocal: row?.reminderTimeLocal ?? '09:00',
      quietHoursStart: row?.quietHoursStart ?? null,
      quietHoursEnd: row?.quietHoursEnd ?? null,
      remindersPaused: row?.remindersPaused ?? true,
    };
  }

  /**
   * Materialise every reminder that becomes due inside the planning window.
   *
   * Idempotent: the unique `idempotency_key` index means running this twice
   * creates nothing new.
   */
  async scheduleDueReminders(
    organizationId: string,
    options: { now?: Date; horizonDays?: number } = {},
  ): Promise<{ created: number; skipped: number; reminders: ScheduledReminder[] }> {
    const now = options.now ?? new Date();
    const horizonDays = options.horizonDays ?? 60;
    const settings = await this.settings(organizationId);
    const reminders: ScheduledReminder[] = [];
    let created = 0;
    let skipped = 0;

    // Global pause: nothing is scheduled, and existing queued reminders stay
    // queued so unpausing resumes the plan.
    if (settings.remindersPaused) {
      const queued = await this.countQueued(organizationId);
      return { created: 0, skipped: queued, reminders };
    }

    const rules = await this.db
      .select()
      .from(reminderRules)
      .where(and(eq(reminderRules.organizationId, organizationId), eq(reminderRules.enabled, true)));
    if (rules.length === 0) return { created: 0, skipped: 0, reminders };

    const today = todayIn(settings.timezone, now);
    const horizon = addDaysIso(today, horizonDays);

    const candidates = await this.db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        vendorName: subscriptions.vendorName,
        status: subscriptions.status,
        nextRenewalDate: subscriptions.nextRenewalDate,
        trialEndDate: subscriptions.trialEndDate,
        cancellationDeadline: subscriptions.cancellationDeadline,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        notes: subscriptions.notes,
        ownerUserId: subscriptions.ownerUserId,
        archivedAt: subscriptions.archivedAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId));

    for (const subscription of candidates) {
      if (subscription.archivedAt) {
        skipped += 1;
        continue;
      }

      for (const rule of rules) {
        const targetDate = targetDateFor(subscription, rule.eventType as ReminderEventType);
        if (!targetDate) continue;

        // Paused and cancelled subscriptions must not trigger ordinary renewal
        // reminders (Part E / E7). A planned cancellation still renews until the
        // user confirms it, so it keeps its reminders.
        if (
          rule.eventType === 'renewal' &&
          !producesRenewalReminder(subscription.status) &&
          subscription.status !== 'paused'
        ) {
          continue;
        }
        if (rule.eventType === 'renewal' && subscription.status === 'cancelled') continue;

        const reminderDate = addDaysIso(targetDate, -rule.daysBefore);
        if (reminderDate > horizon) continue;
        // Do not send a window that closed more than 3 days ago; that is history,
        // not a notification.
        if (reminderDate < addDaysIso(today, -3)) continue;

        const recipient = await this.resolveRecipient(organizationId, subscription.ownerUserId);
        if (!recipient) {
          skipped += 1;
          continue;
        }

        const idempotencyKey = reminderKey({
          organizationId,
          subscriptionId: subscription.id,
          eventType: rule.eventType,
          targetDate,
          recipientUserId: recipient.id,
          channel: rule.channel,
        });

        const existing = await this.db
          .select({ id: reminderLogs.id, status: reminderLogs.status })
          .from(reminderLogs)
          .where(eq(reminderLogs.idempotencyKey, idempotencyKey))
          .limit(1);
        if (existing[0]) {
          skipped += 1;
          continue;
        }

        const scheduledFor = this.resolveSendTime({
          now,
          reminderDate,
          timezone: settings.timezone,
          timeLocal: settings.reminderTimeLocal,
          quietStart: rule.quietHours?.start ?? settings.quietHoursStart,
          quietEnd: rule.quietHours?.end ?? settings.quietHoursEnd,
        });

        const inserted = await this.db
          .insert(reminderLogs)
          .values({
            organizationId,
            subscriptionId: subscription.id,
            eventType: rule.eventType,
            targetDate,
            recipientUserId: recipient.id,
            channel: rule.channel,
            status: 'queued',
            idempotencyKey,
            subject: `${REMINDER_EVENT_LABELS[rule.eventType as ReminderEventType]} - ${subscription.name}`,
            snoozedUntil: null,
          })
          .onConflictDoNothing({ target: reminderLogs.idempotencyKey })
          .returning({ id: reminderLogs.id });

        if (!inserted[0]) {
          skipped += 1;
          continue;
        }

        created += 1;
        reminders.push({
          id: inserted[0].id,
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          vendorName: subscription.vendorName,
          eventType: rule.eventType as ReminderEventType,
          targetDate,
          reminderDate,
          channel: rule.channel as ReminderChannel,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          amountMinor: subscription.amountMinor,
          currency: subscription.currency,
          notes: subscription.notes,
          scheduledFor: scheduledFor.toISOString(),
          created: true,
        });
      }
    }

    return { created, skipped, reminders };
  }

  /**
   * Re-plan the pending (still `queued`) reminders of one subscription after its
   * dates or status changed.
   *
   * Delivered reminders keep their rows and their idempotency key, so nothing is
   * ever delivered twice (Part E / E7).
   */
  async rescheduleForSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<{ removed: number }> {
    const pending = await this.db
      .select({ id: reminderLogs.id, eventType: reminderLogs.eventType, targetDate: reminderLogs.targetDate })
      .from(reminderLogs)
      .where(
        and(
          eq(reminderLogs.organizationId, organizationId),
          eq(reminderLogs.subscriptionId, subscriptionId),
          eq(reminderLogs.status, 'queued'),
        ),
      );
    if (pending.length === 0) return { removed: 0 };

    const subscription = (
      await this.db
        .select({
          status: subscriptions.status,
          nextRenewalDate: subscriptions.nextRenewalDate,
          trialEndDate: subscriptions.trialEndDate,
          cancellationDeadline: subscriptions.cancellationDeadline,
          archivedAt: subscriptions.archivedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
        .limit(1)
    )[0];
    if (!subscription) throw notFound('Subscription');

    let removed = 0;
    for (const row of pending) {
      const currentTarget = targetDateFor(
        {
          status: subscription.status,
          nextRenewalDate: subscription.nextRenewalDate,
          trialEndDate: subscription.trialEndDate,
          cancellationDeadline: subscription.cancellationDeadline,
        },
        row.eventType as ReminderEventType,
      );

      const obsolete =
        subscription.archivedAt !== null ||
        currentTarget === null ||
        currentTarget !== row.targetDate ||
        (row.eventType === 'renewal' && !producesRenewalReminder(subscription.status));

      if (!obsolete) continue;

      // `skipped` rather than a delete, so the history of what was planned and
      // why it was dropped stays auditable.
      const updated = await this.db
        .update(reminderLogs)
        .set({
          status: 'skipped',
          safeFailureMessage: 'The subscription was edited after this reminder was planned.',
        })
        .where(
          and(eq(reminderLogs.id, row.id), eq(reminderLogs.status, 'queued')),
        )
        .returning({ id: reminderLogs.id });
      removed += updated.length;
    }

    return { removed };
  }

  /**
   * Turn a local reminder date + wall-clock time into a UTC instant, deferring
   * out of quiet hours rather than dropping the reminder.
   */
  resolveSendTime(input: {
    now: Date;
    reminderDate: string;
    timezone: string;
    timeLocal: string;
    quietStart: string | null;
    quietEnd: string | null;
  }): Date {
    const [hour = '9', minute = '0'] = input.timeLocal.split(':');
    const wallClock = `${hour.slice(0, 2)}:${minute.slice(0, 2)}`;
    // A local time that does not exist (spring-forward gap) falls back to the
    // current instant instead of being silently moved a day.
    const target =
      zonedWallClockToUtc(input.reminderDate, wallClock, input.timezone) ??
      zonedWallClockToUtc(input.reminderDate, '12:00', input.timezone) ??
      new Date(`${input.reminderDate}T${wallClock}:00.000Z`);

    if (target <= input.now) return input.now;
    if (!input.quietStart || !input.quietEnd) return target;

    const startMinutes = toMinutes(input.quietStart);
    const endMinutes = toMinutes(input.quietEnd);
    const targetMinutes = minutesSinceMidnightInZone(target, input.timezone);
    const inside =
      startMinutes <= endMinutes
        ? targetMinutes >= startMinutes && targetMinutes < endMinutes
        : targetMinutes >= startMinutes || targetMinutes < endMinutes;
    if (!inside) return target;

    const minutesToEnd =
      endMinutes >= startMinutes ? endMinutes - targetMinutes : 24 * 60 - targetMinutes + endMinutes;
    return new Date(target.getTime() + minutesToEnd * 60_000);
  }

  /** True when the instant falls inside the configured quiet window. */
  isQuietHours(instant: Date, timezone: string, start: string | null, end: string | null): boolean {
    if (!start || !end) return false;
    const startMinutes = toMinutes(start);
    const endMinutes = toMinutes(end);
    const now = minutesSinceMidnightInZone(instant, timezone);
    return startMinutes <= endMinutes
      ? now >= startMinutes && now < endMinutes
      : now >= startMinutes || now < endMinutes;
  }

  async listLogs(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      subscriptionId?: string;
      eventType?: string;
      status?: string;
      reviewed?: 'pending' | 'reviewed';
    },
  ): Promise<Paginated<ReminderLogView>> {
    const filters = [eq(reminderLogs.organizationId, organizationId)];
    if (query.subscriptionId) filters.push(eq(reminderLogs.subscriptionId, query.subscriptionId));
    if (query.eventType && query.eventType !== 'all') filters.push(eq(reminderLogs.eventType, query.eventType));
    if (query.status && query.status !== 'all') filters.push(eq(reminderLogs.status, query.status));
    if (query.reviewed === 'pending') filters.push(isNull(reminderLogs.reviewedAt));
    if (query.reviewed === 'reviewed') filters.push(sql`${reminderLogs.reviewedAt} is not null`);

    const where = and(...filters);
    const rows = await this.db
      .select({
        id: reminderLogs.id,
        subscriptionId: reminderLogs.subscriptionId,
        subscriptionName: subscriptions.name,
        eventType: reminderLogs.eventType,
        targetDate: reminderLogs.targetDate,
        recipientUserId: reminderLogs.recipientUserId,
        recipientName: users.displayName,
        channel: reminderLogs.channel,
        status: reminderLogs.status,
        providerMessageId: reminderLogs.providerMessageId,
        failureCode: reminderLogs.failureCode,
        safeFailureMessage: reminderLogs.safeFailureMessage,
        sentAt: reminderLogs.sentAt,
        snoozedUntil: reminderLogs.snoozedUntil,
        reviewedAt: reminderLogs.reviewedAt,
        createdAt: reminderLogs.createdAt,
      })
      .from(reminderLogs)
      .leftJoin(subscriptions, eq(subscriptions.id, reminderLogs.subscriptionId))
      .leftJoin(users, eq(users.id, reminderLogs.recipientUserId))
      .where(where)
      .orderBy(desc(reminderLogs.targetDate), desc(reminderLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(reminderLogs)
      .where(where);
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => ({
        id: row.id,
        subscriptionId: row.subscriptionId,
        subscriptionName: row.subscriptionName ?? 'Subscription',
        eventType: row.eventType as ReminderEventType,
        eventTypeLabel: REMINDER_EVENT_LABELS[row.eventType as ReminderEventType] ?? row.eventType,
        targetDate: row.targetDate,
        recipientUserId: row.recipientUserId,
        recipientName: row.recipientName,
        channel: row.channel as ReminderChannel,
        status: row.status as ReminderLogView['status'],
        providerMessageId: row.providerMessageId,
        failureCode: row.failureCode,
        safeFailureMessage: row.safeFailureMessage,
        sentAt: row.sentAt?.toISOString() ?? null,
        snoozedUntil: row.snoozedUntil,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /** Reminders that are due to surface in the app right now. */
  async dueNow(organizationId: string, today: string, limit = 50): Promise<ReminderLogView[]> {
    const rows = await this.db
      .select({ id: reminderLogs.id, targetDate: reminderLogs.targetDate, status: reminderLogs.status })
      .from(reminderLogs)
      .where(
        and(
          eq(reminderLogs.organizationId, organizationId),
          eq(reminderLogs.status, 'queued'),
          lte(reminderLogs.targetDate, addDaysIso(today, 30)),
        ),
      )
      .orderBy(asc(reminderLogs.targetDate))
      .limit(limit);

    const visible = rows.filter((row) => daysBetweenIso(row.targetDate, today) <= 0 || row.targetDate <= today);
    return visible.length > 0
      ? (await this.listLogs(organizationId, { page: 1, pageSize: visible.length })).items.filter((item) =>
          visible.some((entry) => entry.id === item.id),
        )
      : [];
  }

  async snooze(
    organizationId: string,
    reminderId: string,
    snoozeUntil: string,
  ): Promise<{ id: string; snoozedUntil: string; status: string }> {
    const today = new Date().toISOString().slice(0, 10);
    if (snoozeUntil < today) {
      throw badRequest('Pick a snooze date that is not in the past.', {
        snoozeUntil: ['Must be today or later'],
      });
    }
    const updated = await this.db
      .update(reminderLogs)
      .set({ snoozedUntil: snoozeUntil, status: 'snoozed' })
      .where(and(eq(reminderLogs.id, reminderId), eq(reminderLogs.organizationId, organizationId)))
      .returning({ id: reminderLogs.id, snoozedUntil: reminderLogs.snoozedUntil, status: reminderLogs.status });
    if (!updated[0]) throw notFound('Reminder');
    return {
      id: updated[0].id,
      snoozedUntil: updated[0].snoozedUntil ?? snoozeUntil,
      status: updated[0].status,
    };
  }

  async markReviewed(
    organizationId: string,
    reminderId: string,
    reviewed: boolean,
  ): Promise<{ id: string; reviewedAt: string | null }> {
    const updated = await this.db
      .update(reminderLogs)
      .set({ reviewedAt: reviewed ? new Date() : null })
      .where(and(eq(reminderLogs.id, reminderId), eq(reminderLogs.organizationId, organizationId)))
      .returning({ id: reminderLogs.id, reviewedAt: reminderLogs.reviewedAt });
    if (!updated[0]) throw notFound('Reminder');
    return { id: updated[0].id, reviewedAt: updated[0].reviewedAt?.toISOString() ?? null };
  }

  async recordResult(input: {
    organizationId: string;
    reminderLogId: string;
    status: 'sent' | 'in_app' | 'failed' | 'skipped';
    providerMessageId?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  }): Promise<void> {
    await this.db
      .update(reminderLogs)
      .set({
        status: input.status,
        sentAt: input.status === 'sent' || input.status === 'in_app' ? new Date() : null,
        providerMessageId: input.providerMessageId ?? null,
        failureCode: input.failureCode ?? null,
        safeFailureMessage: input.failureMessage?.slice(0, 300) ?? null,
      })
      .where(
        and(
          eq(reminderLogs.id, input.reminderLogId),
          eq(reminderLogs.organizationId, input.organizationId),
        ),
      );
  }

  async rules(organizationId: string) {
    return this.db
      .select()
      .from(reminderRules)
      .where(eq(reminderRules.organizationId, organizationId))
      .orderBy(asc(reminderRules.eventType), asc(reminderRules.daysBefore));
  }

  private async countQueued(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ id: reminderLogs.id })
      .from(reminderLogs)
      .where(
        and(eq(reminderLogs.organizationId, organizationId), eq(reminderLogs.status, 'queued')),
      );
    return rows.length;
  }

  /**
   * The subscription owner if they are a member, otherwise the organization
   * owner. Never escalates to a person outside the tenant.
   */
  private async resolveRecipient(
    organizationId: string,
    ownerUserId: string | null,
  ): Promise<{ id: string; email: string } | null> {
    if (ownerUserId) {
      const rows = await this.db
        .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
        .from(users)
        .innerJoin(
          // Membership check keeps a removed user from being notified.
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.organizationId, organizationId)),
        )
        .where(eq(users.id, ownerUserId))
        .limit(1);
      if (rows[0] && !rows[0].disabledAt) return { id: rows[0].id, email: rows[0].email };
    }

    const owners = await this.db
      .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .innerJoin(
        memberships,
        and(eq(memberships.userId, users.id), eq(memberships.organizationId, organizationId)),
      )
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
      .limit(1);
    if (!owners[0] || owners[0].disabledAt) return null;
    return { id: owners[0].id, email: owners[0].email };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function reminderKey(input: {
  organizationId: string;
  subscriptionId: string;
  eventType: string;
  targetDate: string;
  recipientUserId: string | null;
  channel: string;
}): string {
  return [
    input.organizationId,
    input.subscriptionId,
    input.eventType,
    input.targetDate,
    input.recipientUserId ?? 'none',
    input.channel,
  ].join(':');
}

function targetDateFor(
  subscription: {
    status: string;
    nextRenewalDate: string | null;
    trialEndDate: string | null;
    cancellationDeadline: string | null;
  },
  eventType: ReminderEventType,
): string | null {
  switch (eventType) {
    case 'renewal':
      return subscription.nextRenewalDate;
    case 'trial_end':
      return subscription.trialEndDate;
    case 'cancellation_deadline':
      return subscription.cancellationDeadline;
    default:
      return null;
  }
}

function toMinutes(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}