import { Router } from 'express';
import { z } from 'zod';

import {
  archiveSubscriptionSchema,
  bulkUpdateSubscriptionsSchema,
  createDecisionSchema,
  createSubscriptionSchema,
  idParamSchema,
  registerAttachmentSchema,
  subscriptionListQuerySchema,
  updateSubscriptionSchema,
} from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const subscriptionParams = z.object({
  organizationId: idParamSchema.shape.id,
  subscriptionId: idParamSchema.shape.id,
});

export function subscriptionRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: subscriptionListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        q?: string;
        view: 'active' | 'trials' | 'paused' | 'cancellation_planned' | 'cancelled' | 'archived' | 'all';
        categoryId?: string;
        currency?: string;
        ownerUserId?: string;
        renewalFrom?: string;
        renewalTo?: string;
        markedForReview?: boolean;
        sort: 'name' | 'vendor_name' | 'amount_minor' | 'next_renewal_date' | 'created_at' | 'updated_at';
        order: 'asc' | 'desc';
      };
      const today = await todayFor(services, req.organization!.id);
      res.json(await services.subscriptions.list(req.organization!.id, query, today));
    }),
  );

  router.post(
    '/',
    requirePermission('subscription.create'),
    validate({ body: createSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const subscription = await services.subscriptions.create(
        req.organization!.id,
        req.principal!.user.id,
        req.body as never,
        { requestId: req.requestId, ipAddress: req.clientIp },
      );
      // Step 4 of the add-a-subscription workflow (Part E / E4): schedule the
      // reminders straight away rather than waiting for the nightly job.
      const schedule = await services.reminders.scheduleDueReminders(req.organization!.id);
      const item = await services.subscriptions.listItem(
        req.organization!.id,
        subscription.id,
        await todayFor(services, req.organization!.id),
      );
      res.status(201).json({ subscription: item, remindersPlanned: schedule.created });
    }),
  );

  router.post(
    '/bulk',
    requirePermission('subscription.edit'),
    validate({ body: bulkUpdateSubscriptionsSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        subscriptionIds: string[];
        categoryId?: string | null;
        ownerUserId?: string | null;
        personalOrBusiness?: 'business' | 'personal';
      };
      const result = await services.subscriptions.bulkUpdate({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        subscriptionIds: body.subscriptionIds,
        patch: {
          ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
          ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
          ...(body.personalOrBusiness !== undefined
            ? { personalOrBusiness: body.personalOrBusiness }
            : {}),
        },
        requestId: req.requestId,
      });
      res.json(result);
    }),
  );

  router.get(
    '/:subscriptionId',
    validate({ params: subscriptionParams }),
    asyncHandler(async (req, res) => {
      const today = await todayFor(services, req.organization!.id);
      res.json(
        await services.subscriptions.detail(
          req.organization!.id,
          req.params.subscriptionId as string,
          today,
        ),
      );
    }),
  );

  router.patch(
    '/:subscriptionId',
    requirePermission('subscription.edit'),
    validate({ params: subscriptionParams, body: updateSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const result = await services.subscriptions.update(
        req.organization!.id,
        req.principal!.user.id,
        req.params.subscriptionId as string,
        req.body as never,
        { requestId: req.requestId, ipAddress: req.clientIp },
      );
      // Changing the cadence, the renewal date or the status re-plans pending
      // reminders; reminders that already went out are never touched.
      let remindersReplanned = 0;
      if (result.scheduleChanged) {
        const replanned = await services.reminders.rescheduleForSubscription(
          req.organization!.id,
          req.params.subscriptionId as string,
        );
        remindersReplanned = replanned.removed;
        await services.reminders.scheduleDueReminders(req.organization!.id);
      }
      const item = await services.subscriptions.listItem(
        req.organization!.id,
        result.subscription.id,
        await todayFor(services, req.organization!.id),
      );
      res.json({
        subscription: item,
        priceChanged: result.priceChanged,
        remindersReplanned,
      });
    }),
  );

  router.post(
    '/:subscriptionId/archive',
    requirePermission('subscription.archive'),
    validate({ params: subscriptionParams, body: archiveSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { archived: boolean };
      await services.subscriptions.setArchived(
        req.organization!.id,
        req.principal!.user.id,
        req.params.subscriptionId as string,
        body.archived,
        { requestId: req.requestId },
      );
      if (body.archived) {
        await services.reminders.rescheduleForSubscription(
          req.organization!.id,
          req.params.subscriptionId as string,
        );
      } else {
        await services.reminders.scheduleDueReminders(req.organization!.id);
      }
      const item = await services.subscriptions.listItem(
        req.organization!.id,
        req.params.subscriptionId as string,
        await todayFor(services, req.organization!.id),
      );
      res.json({ subscription: item });
    }),
  );

  router.post(
    '/:subscriptionId/decisions',
    requirePermission('decision.record'),
    validate({ params: subscriptionParams, body: createDecisionSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        decision: 'keep' | 'review' | 'downgrade' | 'cancel_planned' | 'cancelled';
        reason?: string | null;
        reviewOn?: string | null;
        cancellationConfirmedAt?: string | null;
        cancellationReference?: string | null;
      };
      const result = await services.subscriptions.recordDecision({
        organizationId: req.organization!.id,
        subscriptionId: req.params.subscriptionId as string,
        actorUserId: req.principal!.user.id,
        decision: body.decision,
        reason: body.reason ?? null,
        reviewOn: body.reviewOn ?? null,
        cancellationConfirmedAt: body.cancellationConfirmedAt ?? null,
        cancellationReference: body.cancellationReference ?? null,
        requestId: req.requestId,
      });
      const item = await services.subscriptions.listItem(
        req.organization!.id,
        req.params.subscriptionId as string,
        await todayFor(services, req.organization!.id),
      );
      res.status(201).json({
        decision: {
          id: result.decision.id,
          decision: result.decision.decision,
          recordedAt: result.decision.recordedAt.toISOString(),
        },
        status: result.status,
        subscription: item,
        externalCancellation:
          body.decision === 'cancelled'
            ? null
            : {
                performed: false,
                message:
                  'RenewRadar does not contact vendors. Cancel with the vendor yourself, then record "Cancelled (confirmed with vendor)".',
              },
      });
    }),
  );

  router.get(
    '/:subscriptionId/price-history',
    validate({ params: subscriptionParams }),
    asyncHandler(async (req, res) => {
      res.json({
        items: await services.subscriptions.priceHistory(
          req.organization!.id,
          req.params.subscriptionId as string,
        ),
      });
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Attachments                                                            */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/:subscriptionId/attachments',
    validate({ params: subscriptionParams }),
    asyncHandler(async (req, res) => {
      res.json({
        items: await services.attachments.list(
          req.organization!.id,
          req.params.subscriptionId as string,
        ),
        storageConfigured: services.attachments.storageConfigured,
        storageSetupHint: services.attachments.storageSetupHint,
      });
    }),
  );

  router.post(
    '/:subscriptionId/attachments',
    requirePermission('subscription.edit'),
    validate({ params: subscriptionParams, body: registerAttachmentSchema }),
    asyncHandler(async (req, res) => {
      const attachment = await services.attachments.register({
        organizationId: req.organization!.id,
        subscriptionId: req.params.subscriptionId as string,
        actorUserId: req.principal!.user.id,
        originalFilename: (req.body as { originalFilename: string }).originalFilename,
        mimeType: (req.body as { mimeType: string }).mimeType,
        sizeBytes: (req.body as { sizeBytes: number }).sizeBytes,
        storageKey: (req.body as { storageKey: string }).storageKey,
        requestId: req.requestId,
      });
      res.status(201).json({ attachment, storageConfigured: services.attachments.storageConfigured });
    }),
  );

  return router;
}

export const attachmentParams = z.object({
  organizationId: idParamSchema.shape.id,
  attachmentId: idParamSchema.shape.id,
});

async function todayFor(services: Services, organizationId: string): Promise<string> {
  const settings = await services.reminders.settings(organizationId);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}