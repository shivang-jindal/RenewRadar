import { Router } from 'express';
import { z } from 'zod';

import {
  createCategorySchema,
  deleteCategorySchema,
  idParamSchema,
  updateCategorySchema,
} from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const categoryParams = z.object({
  organizationId: idParamSchema.shape.id,
  categoryId: idParamSchema.shape.id,
});

export function categoryRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ items: await services.categories.list(req.organization!.id) });
    }),
  );

  router.post(
    '/',
    requirePermission('category.manage'),
    validate({ body: createCategorySchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { name: string; colorToken: string };
      const category = await services.categories.create(req.organization!.id, req.principal!.user.id, body);
      res.status(201).json({ category });
    }),
  );

  router.get(
    '/:categoryId',
    validate({ params: categoryParams }),
    asyncHandler(async (req, res) => {
      const category = await services.categories.get(req.organization!.id, req.params.categoryId as string);
      res.json({ category, usage: await services.categories.usage(req.organization!.id, category.id) });
    }),
  );

  router.patch(
    '/:categoryId',
    requirePermission('category.manage'),
    validate({ params: categoryParams, body: updateCategorySchema }),
    asyncHandler(async (req, res) => {
      const category = await services.categories.update(
        req.organization!.id,
        req.principal!.user.id,
        req.params.categoryId as string,
        req.body as { name?: string; colorToken?: string },
      );
      res.json({ category });
    }),
  );

  /**
   * Deleting always requires the typed confirmation and an explicit decision
   * about the subscriptions in the category (Part E / E7).
   */
  router.delete(
    '/:categoryId',
    requirePermission('category.manage'),
    validate({ params: categoryParams, body: deleteCategorySchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { reassignToCategoryId: string | null; confirmation: string };
      const result = await services.categories.remove({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        categoryId: req.params.categoryId as string,
        reassignToCategoryId: body.reassignToCategoryId,
      });
      res.json(result);
    }),
  );

  return router;
}