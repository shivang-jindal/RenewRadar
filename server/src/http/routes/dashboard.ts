import { Router } from 'express';

import { dashboardQuerySchema } from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler } from '../middleware.js';
import { validate } from '../validate.js';

export function dashboardRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  /**
   * Overview metrics.
   *
   * Every figure is derived from the saved subscription rows inside the
   * organization's own timezone; an empty organization returns zeros and empty
   * arrays rather than a fabricated trend (Part A / A4.6, Part E / E3.1).
   *
   * `from`/`to` are validated so a malformed date is a 400 rather than a
   * silently ignored parameter. They do not filter the totals: a recurring-cost
   * figure sliced by an arbitrary date range would misrepresent what the
   * organization actually spends, so the summary is a point-in-time view of all
   * live subscriptions and the date-aware figures live on the calendar.
   */
  router.get(
    '/summary',
    validate({ query: dashboardQuerySchema }),
    asyncHandler(async (req, res) => {
      const settings = await services.reminders.settings(req.organization!.id);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: settings.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      res.json(await services.reports.dashboard(req.organization!.id, today));
    }),
  );

  /** Reminders that are due to surface in the app right now. */
  router.get(
    '/reminders/due',
    asyncHandler(async (req, res) => {
      const settings = await services.reminders.settings(req.organization!.id);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: settings.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      res.json({
        items: await services.reminders.dueNow(req.organization!.id, today),
        timezone: settings.timezone,
        emailConfigured: services.emailAdapter.deliversMessages,
      });
    }),
  );

  return router;
}
