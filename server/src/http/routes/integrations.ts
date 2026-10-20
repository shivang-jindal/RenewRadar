import { Router } from 'express';
import { z } from 'zod';

import { integrationTestSchema, updateIntegrationSchema } from '@renewradar/shared';

import type { Services } from '../../container.js';
import type { IntegrationProvider } from '../../services/integration.service.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

/**
 * Only the providers that exist in `IntegrationService` are routable. An
 * unknown provider is a 404-shaped validation error, never a silently created
 * integration row.
 */
const providerSchema = z.enum(['email_smtp', 'bank_transaction_feed'], {
  errorMap: () => ({ message: 'Supported providers: email_smtp, bank_transaction_feed' }),
});

const providerParams = z.object({
  organizationId: z.string().uuid(),
  provider: providerSchema,
});

export function integrationRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({
        integrations: await services.integrations.list(req.organization!.id),
        email: {
          provider: services.emailAdapter.name,
          deliversMessages: services.emailAdapter.deliversMessages,
          setupHint: services.emailAdapter.setupHint,
        },
      });
    }),
  );

  router.put(
    '/:provider',
    requirePermission('integration.manage'),
    validate({
      params: providerParams,
      body: updateIntegrationSchema.omit({ provider: true }),
    }),
    asyncHandler(async (req, res) => {
      const body = req.body as { credentials: Record<string, string>; enabled: boolean };
      const provider = req.params.provider as IntegrationProvider;
      const integration = await services.integrations.save({
        organizationId: req.organization!.id,
        provider,
        actorUserId: req.principal!.user.id,
        credentials: body.credentials,
        enabled: body.enabled,
      });
      res.json({ integration });
    }),
  );

  /**
   * Real verification against the configured provider.
   *
   * A provider with no adapter (`bank_transaction_feed`) answers
   * `not_configured` with an explanation. Nothing is ever reported as connected
   * on the strength of a stored credential alone.
   */
  router.post(
    '/:provider/test',
    requirePermission('integration.manage'),
    validate({ params: providerParams }),
    asyncHandler(async (req, res) => {
      const result = await services.integrations.test(
        req.organization!.id,
        req.params.provider as IntegrationProvider,
        req.principal!.user.id,
      );
      res.json(result);
    }),
  );

  /** Send a real test message through the configured adapter. */
  router.post(
    '/email_smtp/test-message',
    requirePermission('integration.manage'),
    validate({ body: integrationTestSchema }),
    asyncHandler(async (req, res) => {
      const to = (req.body as { to?: string }).to;
      if (!to) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Enter an address to send the test message to.',
            fields: { to: ['Required'] },
            requestId: req.requestId,
          },
        });
        return;
      }
      const result = await services.integrations.sendTestEmail({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        to,
        from: services.config.email.from ?? 'RenewRadar <no-reply@renewradar.local>',
        send: (message) => services.emailAdapter.send(message),
      });
      res.json({
        ...result,
        // Plain SMTP reports acceptance, never delivery. The UI must not claim
        // the message arrived.
        deliveryConfirmed: false,
        note: result.accepted
          ? 'The provider accepted the message. Plain SMTP does not report delivery, so this is not a delivery receipt.'
          : 'The provider rejected the message.',
      });
    }),
  );

  router.delete(
    '/:provider',
    requirePermission('integration.manage'),
    validate({ params: providerParams }),
    asyncHandler(async (req, res) => {
      await services.integrations.clear(
        req.organization!.id,
        req.params.provider as IntegrationProvider,
        req.principal!.user.id,
      );
      res.status(204).end();
    }),
  );

  return router;
}
