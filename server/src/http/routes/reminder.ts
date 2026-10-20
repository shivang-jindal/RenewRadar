import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  idParamSchema,
  markReminderReviewedSchema,
  REMINDER_EVENT_LABELS,
  snoozeReminderSchema,
  updateReminderRulesSchema,
} from '@renewradar/shared';

import type { Services } from '../../container.js';
import { isUniqueViolation } from '../../db/pg-error.js';
import { reminderRules } from '../../db/schema.js';
import { conflict, notFound } from '../../errors.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const reminderParams = z.object({
  organizationId: idParamSchema.shape.id,
  reminderId: idParamSchema.shape.id,
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  subscriptionId: z.string().uuid().optional(),
  eventType: z.string().trim().max(40).optional(),
  status: z.string().trim().max(40).optional(),
  reviewed: z.enum(['all', 'pending', 'reviewed']).default('all'),
});

export function reminderRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  /* ---------------------------------------------------------------------- */
  /* Rules                                                                  */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const rules = await services.organizations.listReminderRules(req.organization!.id);
      const settings = await services.organizations.getSettings(req.organization!.id);
      res.json({
        rules: rules.map((rule) => ({
          id: rule.id,
          eventType: rule.eventType,
          eventTypeLabel:
            REMINDER_EVENT_LABELS[rule.eventType as keyof typeof REMINDER_EVENT_LABELS] ?? rule.eventType,
          daysBefore: rule.daysBefore,
          channel: rule.channel,
          enabled: rule.enabled,
          quietHours: rule.quietHours ?? null,
        })),
        settings,
        emailConfigured: services.emailAdapter.deliversMessages,
      });
    }),
  );

  /**
   * Rules are updated by id and only within the caller's own organization; a
   * rule belonging to another tenant is never found, let alone changed.
   */
  router.patch(
    '/',
    requirePermission('reminder.manage'),
    validate({ body: updateReminderRulesSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        rules: Array<{
          id: string;
          eventType: string;
          daysBefore: number;
          channel: string;
          enabled: boolean;
        }>;
      };

      // `(organization, event type, days before, channel)` is unique, so the
      // whole batch is applied in one transaction: either every rule lands or
      // none does, and a slot collision surfaces as a 409 rather than a 500
      // half-applied halfway.
      try {
        await services.db.transaction(async (tx) => {
          for (const rule of body.rules) {
            // Scoped by organization *and* id: a rule id from another tenant is
            // never found, so it can never be rewritten.
            const updated = await tx
              .update(reminderRules)
              .set({
                eventType: rule.eventType,
                daysBefore: rule.daysBefore,
                channel: rule.channel,
                enabled: rule.enabled,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(reminderRules.id, rule.id),
                  eq(reminderRules.organizationId, req.organization!.id),
                ),
              )
              .returning({ id: reminderRules.id });
            if (!updated[0]) throw notFound('Reminder rule');
          }
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(
            'Another reminder rule already uses that event type, lead time and channel. Change or remove the duplicate first.',
            { fields: ['rules'] },
          );
        }
        throw error;
      }

      // Changing the plan re-plans pending reminders; delivered ones stay.
      const scheduled = await services.reminders.scheduleDueReminders(req.organization!.id);

      await services.audit.record({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        action: 'settings.reminder_rules_updated',
        entityType: 'organization',
        entityId: req.organization!.id,
        metadata: { count: body.rules.length, planned: scheduled.created },
        requestId: req.requestId,
      });

      const rules = await services.organizations.listReminderRules(req.organization!.id);
      res.json({
        rules,
        remindersPlanned: scheduled.created,
        emailConfigured: services.emailAdapter.deliversMessages,
      });
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Logs                                                                   */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/logs',
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        subscriptionId?: string;
        eventType?: string;
        status?: string;
        reviewed: 'all' | 'pending' | 'reviewed';
      };
      res.json(
        await services.reminders.listLogs(req.organization!.id, {
          page: query.page,
          pageSize: query.pageSize,
          ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
          ...(query.eventType ? { eventType: query.eventType } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.reviewed === 'all' ? {} : { reviewed: query.reviewed }),
        }),
      );
    }),
  );

  router.post(
    '/logs/:reminderId/snooze',
    validate({ params: reminderParams, body: snoozeReminderSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { snoozeUntil: string };
      const result = await services.reminders.snooze(
        req.organization!.id,
        req.params.reminderId as string,
        body.snoozeUntil,
      );
      await services.audit.record({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        action: 'reminder.snoozed',
        entityType: 'reminder',
        entityId: result.id,
        metadata: { snoozedUntil: result.snoozedUntil },
        requestId: req.requestId,
      });
      res.json({ reminder: result });
    }),
  );

  router.post(
    '/logs/:reminderId/reviewed',
    validate({ params: reminderParams, body: markReminderReviewedSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { reviewed: boolean };
      const result = await services.reminders.markReviewed(
        req.organization!.id,
        req.params.reminderId as string,
        body.reviewed,
      );
      res.json({ reminder: result });
    }),
  );

  return router;
}
