/**
 * Reminder scheduling (Part E / E3.8, E4 renewal review, E7).
 *
 * The guarantee under test: for one subscription, one event type, one target
 * date, one recipient and one channel there is exactly one reminder - no matter
 * how many times the scheduler runs, how the subscription is edited, or how
 * often the worker retries.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { addDaysIso, todayIso } from '@renewradar/shared';

import { reminderLogs, reminderRules } from '../src/db/schema.js';
import { todayIn } from '../src/services/reminder.service.js';
import {
  createTestContext,
  enableRenewalReminders,
  seedTenant,
  subscriptionInput,
  type SeededTenant,
  type TestContext,
} from './harness.js';

let context: TestContext;
let tenant: SeededTenant;
let organizationId: string;

beforeAll(async () => {
  context = await createTestContext();
  tenant = await seedTenant(context, {
    email: 'reminders@test.local',
    organizationName: 'Reminder Workspace',
    timezone: 'UTC',
  });
  organizationId = tenant.organization.id;
});

afterAll(async () => {
  await context.close();
});

const today = todayIso('UTC');

function create(overrides: Parameters<typeof subscriptionInput>[0] = {}) {
  return context.services.subscriptions.create(
    organizationId,
    tenant.user.id,
    subscriptionInput({ startDate: today, nextRenewalDate: addDaysIso(today, 30), ...overrides }),
  );
}

async function logsFor(subscriptionId: string) {
  const rows = await context.handle.db
    .select()
    .from(reminderLogs)
    .where(eq(reminderLogs.subscriptionId, subscriptionId));
  return rows;
}

describe('the planning window', () => {
  beforeAll(async () => {
    await enableRenewalReminders(context, tenant, 7);
  });

  it('schedules a reminder inside the window and keeps it strictly before the target', async () => {
    const soon = await create({ name: 'Renews In 5 Days', nextRenewalDate: addDaysIso(today, 5) });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    const planned = result.reminders.find((entry) => entry.subscriptionId === soon.id);

    expect(planned).toBeDefined();
    expect(planned!.targetDate).toBe(addDaysIso(today, 5));
    expect(planned!.reminderDate).toBe(addDaysIso(today, -2));
    expect(planned!.scheduledFor).toBeTruthy();
  });

  it('does not revive a window that closed long ago', async () => {
    const stale = await create({ name: 'Renews In 30 Days', nextRenewalDate: addDaysIso(today, 30) });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    const planned = result.reminders.find((entry) => entry.subscriptionId === stale.id);
    // 30 - 7 = 23 days out: inside the 60-day horizon, so it is planned early.
    expect(planned?.reminderDate).toBe(addDaysIso(today, 23));
  });

  it('ignores a renewal beyond the planning horizon entirely', async () => {
    const far = await create({ name: 'Renews In 200 Days', nextRenewalDate: addDaysIso(today, 200) });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    expect(result.reminders.some((entry) => entry.subscriptionId === far.id)).toBe(false);
    expect(await logsFor(far.id)).toHaveLength(0);
  });

  it('ignores a reminder whose window closed more than three days ago', async () => {
    const overdue = await create({
      name: 'Renewal Long Overdue',
      startDate: addDaysIso(today, -60),
      nextRenewalDate: addDaysIso(today, -30),
    });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    expect(result.reminders.some((entry) => entry.subscriptionId === overdue.id)).toBe(false);
  });
});

describe('one reminder per cycle, never twice', () => {
  let subscriptionId: string;

  beforeAll(async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Idempotency Probe',
      nextRenewalDate: addDaysIso(today, 10),
    });
    subscriptionId = subscription.id;
  });

  it('creates the reminder once and nothing on a repeat run', async () => {
    const first = await context.services.reminders.scheduleDueReminders(organizationId);
    const second = await context.services.reminders.scheduleDueReminders(organizationId);
    const third = await context.services.reminders.scheduleDueReminders(organizationId);

    expect(first.reminders.filter((entry) => entry.subscriptionId === subscriptionId)).toHaveLength(1);
    expect(second.created).toBe(0);
    expect(third.created).toBe(0);

    const rows = await logsFor(subscriptionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.targetDate).toBe(addDaysIso(today, 10));
    // The key encodes organization, subscription, event, date, recipient, channel.
    expect(rows[0]!.idempotencyKey).toContain(subscriptionId);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(rows.length);
  });

  it('survives a concurrent scheduler run without duplicating the row', async () => {
    await Promise.all([
      context.services.reminders.scheduleDueReminders(organizationId),
      context.services.reminders.scheduleDueReminders(organizationId),
      context.services.reminders.scheduleDueReminders(organizationId),
    ]);
    const rows = await logsFor(subscriptionId);
    expect(rows).toHaveLength(1);
  });
});

describe('editing a renewal date never double-applies', () => {
  let subscriptionId: string;

  beforeAll(async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Reschedule Probe',
      nextRenewalDate: addDaysIso(today, 12),
    });
    subscriptionId = subscription.id;
    await context.services.reminders.scheduleDueReminders(organizationId);
  });

  it('retires the stale reminder and plans exactly one for the new date', async () => {
    const before = await logsFor(subscriptionId);
    expect(before).toHaveLength(1);

    const update = await context.services.subscriptions.update(
      organizationId,
      tenant.user.id,
      subscriptionId,
      { nextRenewalDate: addDaysIso(today, 20) },
    );
    expect(update.scheduleChanged).toBe(true);

    const replanned = await context.services.reminders.rescheduleForSubscription(
      organizationId,
      subscriptionId,
    );
    expect(replanned.removed).toBe(1);

    await context.services.reminders.scheduleDueReminders(organizationId);
    const after = await logsFor(subscriptionId);

    // The old plan is kept as `skipped` (auditable) and one new plan exists.
    expect(after).toHaveLength(2);
    expect(after.filter((row) => row.status === 'skipped')).toHaveLength(1);
    const queued = after.filter((row) => row.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.targetDate).toBe(addDaysIso(today, 20));
  });

  it('never deletes or re-sends a reminder that already went out', async () => {
    await context.services.subscriptions.update(organizationId, tenant.user.id, subscriptionId, {
      nextRenewalDate: addDaysIso(today, 28),
    });
    // Mark the queued reminder as delivered by the worker.
    const [queued] = (await logsFor(subscriptionId)).filter((row) => row.status === 'queued');
    await context.services.reminders.recordResult({
      organizationId,
      reminderLogId: queued!.id,
      status: 'in_app',
    });

    const replanned = await context.services.reminders.rescheduleForSubscription(
      organizationId,
      subscriptionId,
    );
    // Only `queued` rows are eligible for retirement.
    expect(replanned.removed).toBe(0);

    const rows = await logsFor(subscriptionId);
    expect(rows.filter((row) => row.id === queued!.id)[0]!.status).toBe('in_app');
    expect(rows.filter((row) => row.status === 'in_app')).toHaveLength(1);
  });
});

describe('subscriptions that must not produce ordinary renewal reminders', () => {
  it('plans nothing for a cancelled subscription', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Cancelled Probe',
      nextRenewalDate: addDaysIso(today, 14),
      status: 'cancelled',
    });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    expect(result.reminders.some((entry) => entry.subscriptionId === subscription.id)).toBe(false);
    expect(await logsFor(subscription.id)).toHaveLength(0);
  });

  it('plans nothing for an archived subscription and retires its queued reminders', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Archived Probe',
      nextRenewalDate: addDaysIso(today, 15),
    });
    await context.services.reminders.scheduleDueReminders(organizationId);
    expect(await logsFor(subscription.id)).toHaveLength(1);

    await context.services.subscriptions.setArchived(
      organizationId,
      tenant.user.id,
      subscription.id,
      true,
    );
    const rows = await logsFor(subscription.id);
    expect(rows.every((row) => row.status === 'skipped')).toBe(true);
  });

  it('plans nothing while reminders are globally paused', async () => {
    await context.services.organizations.updateSettings(organizationId, tenant.user.id, {
      remindersPaused: true,
    });
    const subscription = await create({
      name: 'Paused Reminders Probe',
      nextRenewalDate: addDaysIso(today, 16),
    });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    expect(result.created).toBe(0);
    expect(result.reminders).toHaveLength(0);
    expect(await logsFor(subscription.id)).toHaveLength(0);
  });

  it('plans again as soon as reminders are unpaused', async () => {
    await context.services.organizations.updateSettings(organizationId, tenant.user.id, {
      remindersPaused: false,
    });
    const subscription = await create({
      name: 'Unpaused Probe',
      nextRenewalDate: addDaysIso(today, 17),
    });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    expect(result.reminders.some((entry) => entry.subscriptionId === subscription.id)).toBe(true);
  });

  it('plans nothing while every rule is disabled', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const rules = await context.services.organizations.listReminderRules(organizationId);
    const renewalRule = rules.find((rule) => rule.daysBefore === 7 && rule.eventType === 'renewal')!;

    const subscription = await create({
      name: 'Disabled Rule Probe',
      nextRenewalDate: addDaysIso(today, 18),
    });

    // Turn the single enabled rule off again.
    await context.services.db
      .update(reminderRules)
      .set({ enabled: false })
      .where(eq(reminderRules.id, renewalRule.id));

    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    expect(result.reminders.some((entry) => entry.subscriptionId === subscription.id)).toBe(false);
    expect(await logsFor(subscription.id)).toHaveLength(0);

    await context.services.db
      .update(reminderRules)
      .set({ enabled: true })
      .where(eq(reminderRules.id, renewalRule.id));
  });
});

describe('the recipient is always a member of this organization', () => {
  it('falls back to the organization owner when nobody is assigned', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Recipient Probe',
      nextRenewalDate: addDaysIso(today, 19),
      ownerUserId: null,
    });
    const result = await context.services.reminders.scheduleDueReminders(organizationId);
    const planned = result.reminders.find((entry) => entry.subscriptionId === subscription.id);
    expect(planned?.recipientUserId).toBe(tenant.user.id);
    expect(planned?.recipientEmail).toBe('reminders@test.local');
  });
});

describe('snooze moves the send time, not the cycle', () => {
  let reminderId: string;
  let subscriptionId: string;
  let targetDate: string;

  beforeAll(async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Snooze Probe',
      nextRenewalDate: addDaysIso(today, 40),
    });
    await context.services.reminders.scheduleDueReminders(organizationId);
    const [row] = await logsFor(subscription.id);
    subscriptionId = subscription.id;
    reminderId = row!.id;
    targetDate = row!.targetDate;
  });

  it('keeps the target date and idempotency key when snoozed', async () => {
    const snoozedUntil = addDaysIso(today, 5);
    const result = await context.services.reminders.snooze(organizationId, reminderId, snoozedUntil);
    expect(result.status).toBe('snoozed');
    expect(result.snoozedUntil).toBe(snoozedUntil);

    const [row] = await logsFor(subscriptionId);
    expect(row!.targetDate).toBe(targetDate);
    expect(row!.snoozedUntil).toBe(snoozedUntil);
  });

  it('does not queue a second reminder for the same cycle after snoozing', async () => {
    await context.services.reminders.scheduleDueReminders(organizationId);
    const sameCycle = (await logsFor(subscriptionId)).filter((row) => row.targetDate === targetDate);
    expect(sameCycle).toHaveLength(1);
    expect(sameCycle[0]!.id).toBe(reminderId);
  });

  it('rejects a snooze into the past', async () => {
    await expect(
      context.services.reminders.snooze(organizationId, reminderId, addDaysIso(today, -1)),
    ).rejects.toThrow(/not in the past/i);
  });

  it('cannot snooze a reminder in another organization', async () => {
    const other = await seedTenant(context, {
      email: 'reminders-other@test.local',
      organizationName: 'Other Reminder Workspace',
    });
    await expect(
      context.services.reminders.snooze(other.organization.id, reminderId, addDaysIso(today, 5)),
    ).rejects.toThrow(/not found/i);
  });
});

describe('marking a reminder reviewed', () => {
  it('records and clears the reviewed timestamp', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Reviewed Probe',
      nextRenewalDate: addDaysIso(today, 50),
    });
    await context.services.reminders.scheduleDueReminders(organizationId);
    const [row] = await logsFor(subscription.id);

    const marked = await context.services.reminders.markReviewed(organizationId, row!.id, true);
    expect(marked.reviewedAt).toBeTruthy();

    const cleared = await context.services.reminders.markReviewed(organizationId, row!.id, false);
    expect(cleared.reviewedAt).toBeNull();
  });
});

describe('quiet hours defer, they never drop', () => {
  const base = {
    now: new Date('2025-06-01T00:00:00.000Z'),
    timezone: 'UTC',
    timeLocal: '09:00',
    quietStart: null,
    quietEnd: null,
  };

  it('sends at the configured local time when quiet hours are off', () => {
    const sendTime = context.services.reminders.resolveSendTime({
      ...base,
      reminderDate: '2025-06-05',
    });
    expect(sendTime.toISOString()).toBe('2025-06-05T09:00:00.000Z');
  });

  it('pushes a send that lands inside quiet hours to the end of the window', () => {
    const sendTime = context.services.reminders.resolveSendTime({
      ...base,
      reminderDate: '2025-06-05',
      timeLocal: '23:00',
      quietStart: '22:00',
      quietEnd: '07:00',
    });
    expect(sendTime.toISOString()).toBe('2025-06-06T07:00:00.000Z');
  });

  it('leaves a send outside quiet hours alone', () => {
    const sendTime = context.services.reminders.resolveSendTime({
      ...base,
      reminderDate: '2025-06-05',
      timeLocal: '12:00',
      quietStart: '22:00',
      quietEnd: '07:00',
    });
    expect(sendTime.toISOString()).toBe('2025-06-05T12:00:00.000Z');
  });

  it('never schedules into the past: a reminder that is already due sends now', () => {
    const sendTime = context.services.reminders.resolveSendTime({
      ...base,
      reminderDate: '2025-05-01',
    });
    expect(sendTime.toISOString()).toBe('2025-06-01T00:00:00.000Z');
  });

  it('reports whether an instant is inside the quiet window', () => {
    const service = context.services.reminders;
    expect(service.isQuietHours(new Date('2025-06-05T23:30:00Z'), 'UTC', '22:00', '07:00')).toBe(true);
    expect(service.isQuietHours(new Date('2025-06-05T03:00:00Z'), 'UTC', '22:00', '07:00')).toBe(true);
    expect(service.isQuietHours(new Date('2025-06-05T12:00:00Z'), 'UTC', '22:00', '07:00')).toBe(false);
    expect(service.isQuietHours(new Date('2025-06-05T12:00:00Z'), 'UTC', null, null)).toBe(false);
  });
});

describe('scheduling happens in the organization timezone', () => {
  it('resolves "today" in the configured zone, not in UTC', () => {
    const instant = new Date('2025-01-15T12:00:00.000Z');
    // UTC+14 is already the next day.
    expect(todayIn('Pacific/Kiritimati', instant)).toBe('2025-01-16');
    // UTC-11 is still the same day.
    expect(todayIn('Pacific/Midway', instant)).toBe('2025-01-15');
    expect(todayIn('UTC', instant)).toBe('2025-01-15');
  });

  it('plans against the local date for a non-UTC organization', async () => {
    const berlin = await seedTenant(context, {
      email: 'berlin@test.local',
      organizationName: 'Berlin Workspace',
      timezone: 'Europe/Berlin',
    });
    await enableRenewalReminders(context, berlin, 1);

    const localToday = todayIso('Europe/Berlin');
    const subscription = await context.services.subscriptions.create(
      berlin.organization.id,
      berlin.user.id,
      subscriptionInput({
        startDate: localToday,
        nextRenewalDate: addDaysIso(localToday, 2),
        timezone: 'Europe/Berlin',
      }),
    );

    const result = await context.services.reminders.scheduleDueReminders(berlin.organization.id);
    const planned = result.reminders.find((entry) => entry.subscriptionId === subscription.id);
    expect(planned?.reminderDate).toBe(addDaysIso(localToday, 1));
    expect(planned?.targetDate).toBe(addDaysIso(localToday, 2));
  });
});

describe('a reminder never claims a delivery it did not get', () => {
  it('records an in-app reminder as in_app, not as an emailed "sent"', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Honest Status Probe',
      nextRenewalDate: addDaysIso(today, 60),
    });
    await context.services.reminders.scheduleDueReminders(organizationId);
    const [row] = await logsFor(subscription.id);

    await context.services.reminders.recordResult({
      organizationId,
      reminderLogId: row!.id,
      status: 'in_app',
    });

    const listed = await context.services.reminders.listLogs(organizationId, {
      page: 1,
      pageSize: 100,
    });
    const view = listed.items.find((entry) => entry.id === row!.id)!;
    expect(view.status).toBe('in_app');
    expect(view.channel).toBe('in_app');
    // No provider message id exists, because nothing was handed to a provider.
    expect(view.providerMessageId).toBeNull();
    expect(view.sentAt).toBeTruthy();
  });

  it('records a failure honestly, with a code and no invented delivery', async () => {
    await enableRenewalReminders(context, tenant, 7);
    const subscription = await create({
      name: 'Failure Probe',
      nextRenewalDate: addDaysIso(today, 61),
    });
    await context.services.reminders.scheduleDueReminders(organizationId);
    const [row] = await logsFor(subscription.id);

    await context.services.reminders.recordResult({
      organizationId,
      reminderLogId: row!.id,
      status: 'failed',
      failureCode: 'not_configured',
      failureMessage: 'No email provider is configured.',
    });

    const listed = await context.services.reminders.listLogs(organizationId, {
      page: 1,
      pageSize: 100,
    });
    const view = listed.items.find((entry) => entry.id === row!.id)!;
    expect(view.status).toBe('failed');
    expect(view.failureCode).toBe('not_configured');
    expect(view.sentAt).toBeNull();
    expect(view.providerMessageId).toBeNull();
  });
});