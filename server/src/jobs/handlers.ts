/**
 * Job handlers (Part A / A2, Part E / E4 renewal review, E3.8 reminders).
 *
 * Every handler is idempotent and reports whether its failure is retryable, so
 * the queue can distinguish a transient problem from a permanent
 * misconfiguration. Nothing here claims an external action succeeded: an email
 * is only `sent` when the provider accepted it, and no integration is reported
 * as connected without an adapter that actually verified itself.
 */

import { and, eq, isNotNull, lt, or } from 'drizzle-orm';

import { daysBetweenIso, REMINDER_EVENT_LABELS } from '@renewradar/shared';

import type { Services } from '../container.js';
import { organizations, passwordResetTokens, reminderLogs, sessions } from '../db/schema.js';
import { formatMoney, type TemplateContext } from '../integrations/email/templates.js';
import type { ScheduledReminder } from '../services/reminder.service.js';
import { todayIn } from '../services/reminder.service.js';

export interface JobOutcome {
  retryable: boolean;
  code: string;
  message: string;
}

export type JobHandler = (
  services: Services,
  payload: Record<string, unknown>,
) => Promise<JobOutcome>;

const ok = (message: string): JobOutcome => ({ retryable: false, code: 'ok', message });

/** Email template type per reminder event (matches `DEFAULT_TEMPLATES`). */
const TEMPLATE_BY_EVENT: Record<string, string> = {
  renewal: 'reminder_renewal',
  trial_end: 'reminder_trial_end',
  cancellation_deadline: 'reminder_cancellation_deadline',
};

const handlers: Record<string, JobHandler> = {
  /**
   * Materialise every reminder that comes due inside the planning window and
   * enqueue the email channel. The `idempotency_key` unique index on
   * `reminder_logs` is what makes running this twice a no-op, so a retried job
   * can never produce a duplicate reminder.
   */
  'reminders.schedule': async (services, payload) => {
    const organizationId = payload.organizationId ? String(payload.organizationId) : null;
    if (!organizationId) return ok('No organization supplied; nothing to schedule.');

    const result = await services.reminders.scheduleDueReminders(organizationId);
    if (result.created === 0) {
      return ok(`No new reminders due (${result.skipped} already planned or skipped).`);
    }

    const settings = await services.reminders.settings(organizationId);
    const today = todayIn(settings.timezone);
    const organization = (
      await services.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
    )[0];

    let queued = 0;
    let deferred = 0;

    for (const reminder of result.reminders) {
      if (reminder.channel !== 'email') {
        // In-app reminders need no provider: they surface on the next screen
        // load, so the row is simply marked as surfaced.
        await services.reminders.recordResult({
          organizationId,
          reminderLogId: reminder.id,
          status: 'in_app',
        });
        continue;
      }
      if (!reminder.recipientEmail) {
        deferred += 1;
        continue;
      }

      const context = templateContextFor(reminder, organization?.name, today, services.config.appUrl);
      const message = await services.email.queueReminderEmail({
        organizationId,
        to: reminder.recipientEmail,
        templateType: TEMPLATE_BY_EVENT[reminder.eventType] ?? 'reminder_renewal',
        context,
        relatedSubscriptionId: reminder.subscriptionId,
        reminderLogId: reminder.id,
        idempotencyKey: reminderIdempotencyKey(reminder),
      });

      await services.jobs.enqueue({
        jobType: 'reminders.deliver',
        organizationId,
        // `organizationId` travels in the payload too: the handler writes the
        // result back to `reminder_logs`, and that update is tenant-scoped.
        payload: { messageId: message.messageId, reminderLogId: reminder.id, organizationId },
        idempotencyKey: `reminders.deliver:${message.messageId}`,
      });
      queued += 1;
    }

    return ok(
      `Planned ${result.created} reminder(s), queued ${queued} email(s), ${deferred} deferred for lack of a recipient address.`,
    );
  },

  /**
   * Hand one queued reminder email to the configured provider.
   *
   * "sent" here means the provider *accepted* the message. Plain SMTP does not
   * report delivery, so nothing downstream may claim the mail arrived.
   */
  'reminders.deliver': async (services, payload) => {
    const messageId = String(payload.messageId ?? '');
    if (!messageId) return { retryable: false, code: 'bad_payload', message: 'messageId is required' };
    const reminderLogId = payload.reminderLogId ? String(payload.reminderLogId) : null;
    const organizationId = payload.organizationId ? String(payload.organizationId) : null;

    const result = await services.email.deliver(messageId);
    if (result.status === 'sent') {
      if (reminderLogId && organizationId) {
        await services.reminders.recordResult({
          organizationId,
          reminderLogId,
          status: 'sent',
          providerMessageId: result.providerMessageId,
        });
      }
      return ok(result.message);
    }

    // An unconfigured provider stays unconfigured until an operator fixes it:
    // retrying on a timer would just fill the failed-jobs table.
    const permanent = !services.emailAdapter.deliversMessages;
    if (reminderLogId && organizationId) {
      await services.reminders.recordResult({
        organizationId,
        reminderLogId,
        status: 'failed',
        failureCode: permanent ? 'email_not_configured' : 'email_send_failed',
        failureMessage: result.message,
      });
    }
    return {
      retryable: !permanent && result.retryable,
      code: permanent ? 'email_not_configured' : 'email_send_failed',
      message: result.message,
    };
  },

  /**
   * Drop reminders whose target has passed or whose subscription changed, so a
   * stale job can never notify a user about something that already happened.
   */
  'reminders.reconcile': async (services, payload) => {
    const organizationId = String(payload.organizationId ?? '');
    if (!organizationId) return ok('No organization supplied.');

    const settings = await services.reminders.settings(organizationId);
    const today = todayIn(settings.timezone);

    const stale = await services.db
      .select({ id: reminderLogs.id, targetDate: reminderLogs.targetDate })
      .from(reminderLogs)
      .where(
        and(
          eq(reminderLogs.organizationId, organizationId),
          eq(reminderLogs.status, 'queued'),
        ),
      );

    let expired = 0;
    for (const row of stale) {
      // Three days of grace matches the scheduler: past that, the window is
      // history rather than a notification.
      if (daysBetweenIso(row.targetDate, today) > 3) continue;
      const updated = await services.db
        .update(reminderLogs)
        .set({
          status: 'skipped',
          safeFailureMessage: 'The target date passed before the reminder could be delivered.',
        })
        .where(and(eq(reminderLogs.id, row.id), eq(reminderLogs.status, 'queued')))
        .returning({ id: reminderLogs.id });
      expired += updated.length;
    }
    return ok(`Marked ${expired} stale reminder(s) as skipped.`);
  },

  /** Housekeeping: revoke dead sessions and spent password-reset tokens. */
  'maintenance.cleanup': async (services) => {
    const now = new Date();
    const revokedCutoff = new Date(now.getTime() - 30 * 24 * 3_600_000);

    // The query builder, not `db.execute({ text, values })`: the latter is a
    // node-postgres-only shape and throws on the embedded PGlite driver.
    await services.db.delete(sessions).where(
      or(
        lt(sessions.expiresAt, now),
        and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, revokedCutoff)),
      ),
    );
    await services.db.delete(passwordResetTokens).where(
      or(
        lt(passwordResetTokens.expiresAt, now),
        isNotNull(passwordResetTokens.usedAt),
      ),
    );
    return ok('Cleanup complete.');
  },
};

export function resolveHandler(jobType: string): JobHandler | null {
  return handlers[jobType] ?? null;
}

export function knownJobTypes(): string[] {
  return Object.keys(handlers);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function reminderIdempotencyKey(reminder: ScheduledReminder): string {
  return [
    'reminder-email',
    reminder.subscriptionId,
    reminder.eventType,
    reminder.targetDate,
    reminder.recipientUserId ?? 'none',
  ].join(':');
}

function templateContextFor(
  reminder: ScheduledReminder,
  organizationName: string | undefined,
  today: string,
  appUrl: string,
): TemplateContext {
  return {
    organizationName: organizationName ?? 'Your organization',
    subscriptionName: reminder.subscriptionName,
    vendorName: reminder.vendorName,
    eventTypeLabel: REMINDER_EVENT_LABELS[reminder.eventType] ?? reminder.eventType,
    targetDate: reminder.targetDate,
    amountFormatted: formatMoney(reminder.amountMinor, reminder.currency),
    daysUntil: daysBetweenIso(today, reminder.targetDate),
    subscriptionUrl: `${appUrl}/subscriptions/${reminder.subscriptionId}`,
    notes: reminder.notes,
  };
}
