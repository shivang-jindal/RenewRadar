import { Router } from 'express';
import { z } from 'zod';

import {
  commitImportSchema,
  idParamSchema,
  importListQuerySchema,
  previewImportSchema,
} from '@renewradar/shared';

import type { Services } from '../../container.js';
import { EXPORT_CONTENT_TYPE } from '../../services/export.service.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const importParams = z.object({
  organizationId: idParamSchema.shape.id,
  importId: idParamSchema.shape.id,
});

export function importRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    requirePermission('report.export'),
    validate({ query: importListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as { page: number; pageSize: number };
      res.json(await services.imports.list(req.organization!.id, query.page, query.pageSize));
    }),
  );

  /**
   * Parse, map and preview.
   *
   * Nothing is written except the import record and its row errors: a preview
   * never creates a subscription, and an invalid row is always reported rather
   * than silently dropped (Part E / E4).
   */
  router.post(
    '/subscriptions',
    requirePermission('report.export'),
    validate({ body: previewImportSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        filename: string;
        csv: string;
        mapping: Record<string, string>;
      };
      const preview = await services.imports.preview({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        filename: body.filename,
        csv: body.csv,
        mapping: body.mapping,
        requestId: req.requestId,
      });
      res.status(201).json({ import: preview });
    }),
  );

  router.get(
    '/:importId',
    requirePermission('report.export'),
    validate({ params: importParams }),
    asyncHandler(async (req, res) => {
      res.json({
        import: await services.imports.get(req.organization!.id, req.params.importId as string),
      });
    }),
  );

  /** Downloadable row-level error report (other tenants' rows are never included). */
  router.get(
    '/:importId/errors.csv',
    requirePermission('report.export'),
    validate({ params: importParams }),
    asyncHandler(async (req, res) => {
      const importId = req.params.importId as string;
      const body = await services.imports.errorReport(req.organization!.id, importId);
      res.setHeader('Content-Type', EXPORT_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="renewradar-import-errors-${importId}.csv"`);
      res.status(200).send(body);
    }),
  );

  /**
   * Commit the confirmed rows.
   *
   * Duplicate rows require an explicit create / skip / update choice; nothing
   * is merged automatically (Part E / E7).
   */
  router.post(
    '/subscriptions/commit',
    requirePermission('report.export'),
    validate({ body: commitImportSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        importId: string;
        rows: Array<{
          rowNumber: number;
          duplicateChoice: 'create' | 'skip' | 'update' | null;
          duplicateSubscriptionId?: string | null;
        }>;
      };
      const result = await services.imports.commit({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        importId: body.importId,
        rows: body.rows.map((row) => ({
          rowNumber: row.rowNumber,
          duplicateChoice: row.duplicateChoice,
          duplicateSubscriptionId: row.duplicateSubscriptionId ?? null,
        })),
        requestId: req.requestId,
      });
      res.json(result);
    }),
  );

  return router;
}
