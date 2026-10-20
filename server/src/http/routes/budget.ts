import { Router } from 'express';
import { z } from 'zod';

import {
  budgetListQuerySchema,
  createBudgetSchema,
  idParamSchema,
  updateBudgetSchema,
} from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const budgetParams = z.object({
  organizationId: idParamSchema.shape.id,
  budgetId: idParamSchema.shape.id,
});

export function budgetRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: budgetListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as { currency?: string; enabled?: boolean };
      res.json({ items: await services.budgets.list(req.organization!.id, query) });
    }),
  );

  router.post(
    '/',
    requirePermission('budget.manage'),
    validate({ body: createBudgetSchema }),
    asyncHandler(async (req, res) => {
      const budget = await services.budgets.create(req.organization!.id, req.principal!.user.id, req.body as never);
      res.status(201).json({ budget });
    }),
  );

  router.patch(
    '/:budgetId',
    requirePermission('budget.manage'),
    validate({ params: budgetParams, body: updateBudgetSchema }),
    asyncHandler(async (req, res) => {
      const budget = await services.budgets.update(
        req.organization!.id,
        req.principal!.user.id,
        req.params.budgetId as string,
        req.body as never,
      );
      res.json({ budget });
    }),
  );

  router.delete(
    '/:budgetId',
    requirePermission('budget.manage'),
    validate({ params: budgetParams }),
    asyncHandler(async (req, res) => {
      await services.budgets.remove(req.organization!.id, req.principal!.user.id, req.params.budgetId as string);
      res.status(204).end();
    }),
  );

  return router;
}