/**
 * API router assembly (Part A / A7, Part E / E6): everything lives under
 * `/api/v1`.
 */

import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';

import type { Services } from '../../container.js';
import { AppError } from '../../errors.js';
import { asyncHandler, requireAuth, requireAuthenticated, requireOrganization } from '../middleware.js';
import { authRouter } from './auth.js';
import { budgetRouter } from './budget.js';
import { calendarRouter } from './calendar.js';
import { categoryRouter } from './category.js';
import { dashboardRouter } from './dashboard.js';
import { exportRouter } from './export.js';
import { healthRouter } from './health.js';
import { importRouter } from './import.js';
import { integrationRouter } from './integrations.js';
import { organizationRouter } from './organization.js';
import { reminderRouter } from './reminder.js';
import { subscriptionRouter } from './subscriptions.js';

export function createApiRouter(services: Services): Router {
  const router = Router();

  router.use('/health', healthRouter(services));

  // Populate `req.principal` for *every* route, including `/auth`.
  // `requireAuth` never rejects - it just leaves `req.principal` undefined when
  // there is no valid session - so the public auth routes below stay public.
  // This has to be mounted before the `/auth` sub-router: a sub-router runs its
  // own middleware first, and `next()` only continues along the *parent* stack.
  router.use(requireAuth(services));

  router.use('/auth', authRouter(services));

  // Everything from here on requires a session.
  router.use(requireAuthenticated());

  router.get(
    '/session/context',
    asyncHandler(async (req, res) => {
      const memberships = await services.auth.membershipsFor(req.principal!.user.id);
      res.json({
        user: req.principal!.user,
        memberships,
        activeOrganizationId: req.principal!.activeOrganizationId,
      });
    }),
  );

  // `mergeParams` is required so `:organizationId` from the mount path is
  // visible to `requireOrganization` inside the sub-router.
  const organizationScoped = Router({ mergeParams: true });
  organizationScoped.use(requireOrganization(services));

  organizationScoped.use('/subscriptions', subscriptionRouter(services));
  organizationScoped.use('/categories', categoryRouter(services));
  organizationScoped.use('/budgets', budgetRouter(services));
  organizationScoped.use('/calendar', calendarRouter(services));
  organizationScoped.use('/reminder-rules', reminderRouter(services));
  organizationScoped.use('/imports', importRouter(services));
  organizationScoped.use('/exports', exportRouter(services));
  organizationScoped.use('/integrations', integrationRouter(services));
  organizationScoped.use('/dashboard', dashboardRouter(services));
  organizationScoped.use('/', organizationRouter(services));

  router.use('/:organizationId', organizationScoped);

  return router;
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${req.method} ${req.path}.`,
        requestId: req.requestId,
      },
    });
  };
}

/** One error shape for the whole API; stack traces stay in the log only. */
export function errorHandler(services: Services): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (res.headersSent) return;

    if (error instanceof AppError) {
      if (error.status >= 500) {
        services.logger.error({ err: error, requestId: req.requestId }, 'request failed');
      } else {
        services.logger.debug(
          { code: error.code, requestId: req.requestId, path: req.path },
          'request rejected',
        );
      }
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Something went wrong. Please try again.',
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.issues ? { issues: error.issues } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    // Zod errors that escaped an explicit validate() call.
    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some of the values you entered are not valid.',
          issues: issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.', requestId: req.requestId },
      });
      return;
    }

    services.logger.error({ err: error, requestId: req.requestId }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId: req.requestId,
      },
    });
  };
}