import { Router } from 'express';
import { z } from 'zod';

import { createExportSchema } from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

export function exportRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  /**
   * CSV export.
   *
   * Always a download, never JSON: the browser is handed the file with the
   * `Content-Disposition` header so the save dialog uses the generated name.
   * `toCsv` in the shared module prefixes formula-leading characters, so a
   * subscription named `=HYPERLINK(...)` cannot execute in a spreadsheet
   * (Part E / E7).
   */
  router.post(
    '/subscriptions',
    requirePermission('report.export'),
    validate({ body: createExportSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        dataset: 'subscriptions' | 'price_history';
        filters: {
          status?: string;
          categoryId?: string;
          currency?: string;
        };
      };
      const result = await services.exports.run({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        organizationName: req.organization!.name,
        dataset: body.dataset,
        filters: body.filters,
        requestId: req.requestId,
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.setHeader('X-Row-Count', String(result.rowCount));
      res.status(200).send(result.body);
    }),
  );

  /** Row count the settings screen shows before an export is run. */
  router.get(
    '/subscriptions/preview',
    asyncHandler(async (req, res) => {
      res.json({
        exportableSubscriptions: await services.exports.rowCount(req.organization!.id),
        canExport: req.permissions?.includes('report.export') ?? false,
      });
    }),
  );

  /** Background job visibility, so a failed job is never a mystery. */
  router.get(
    '/jobs',
    requirePermission('audit.view'),
    validate({
      query: z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
    }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as { page: number; pageSize: number };
      const failed = await services.jobs.listFailed(query.pageSize);
      res.json({
        stats: await services.jobs.stats(req.organization!.id),
        failed: failed
          .filter((job) => job.organizationId === req.organization!.id || job.organizationId === null)
          .slice(0, query.pageSize)
          .map((job) => ({
            id: job.id,
            jobType: job.jobType,
            organizationId: job.organizationId,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            lastErrorCode: job.lastErrorCode,
            lastErrorMessage: job.lastErrorMessage,
            createdAt: job.createdAt.toISOString(),
            completedAt: job.completedAt?.toISOString() ?? null,
          })),
        page: query.page,
        pageSize: query.pageSize,
      });
    }),
  );

  return router;
}
