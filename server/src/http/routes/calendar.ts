import { Router } from 'express';
import { z } from 'zod';

import { addDaysIso, calendarQuerySchema, idParamSchema } from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

export function calendarRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/events',
    validate({ query: calendarQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        from: string;
        to: string;
        categoryId?: string;
        ownerUserId?: string;
        status: string;
        eventType: string;
      };
      if (query.to < query.from) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'The end date must not be before the start date.',
            fields: { to: ['Must be on or after "from"'] },
            requestId: req.requestId,
          },
        });
        return;
      }
      res.json(await services.calendar.range(req.organization!.id, query));
    }),
  );

  /**
   * iCalendar download.
   *
   * The export is generated from the same projection as the screen, so the file
   * and the list can never disagree. It is a download the user imports into
   * their own calendar - there is no calendar provider integration and none is
   * claimed.
   */
  router.get(
    '/events.ics',
    requirePermission('report.export'),
    validate({
      query: calendarQuerySchema.pick({ from: true, to: true, categoryId: true, ownerUserId: true, status: true, eventType: true }),
    }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        from: string;
        to: string;
        categoryId?: string;
        ownerUserId?: string;
        status: string;
        eventType: string;
      };
      if (query.to < query.from) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'The end date must not be before the start date.',
            requestId: req.requestId,
          },
        });
        return;
      }
      const settings = await services.reminders.settings(req.organization!.id);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: settings.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      // The range is bounded by the organization timezone, so the file matches
      // exactly what the calendar screen shows for the same filters.
      const range = await services.calendar.range(req.organization!.id, query);
      const body = services.calendar.toIcs(range.events, new Date(`${today}T00:00:00.000Z`), `${req.organization!.name} renewals`);

      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="renewradar-${query.from}-to-${addDaysIso(query.to, 0)}.ics"`);
      res.status(200).send(body);
    }),
  );

  router.get(
    '/subscriptions/:subscriptionId/events',
    validate({
      params: z.object({
        organizationId: idParamSchema.shape.id,
        subscriptionId: idParamSchema.shape.id,
      }),
    }),
    asyncHandler(async (req, res) => {
      const settings = await services.reminders.settings(req.organization!.id);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: settings.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const range = await services.calendar.range(req.organization!.id, {
        from: today,
        to: addDaysIso(today, 400),
        status: 'all',
        eventType: 'all',
      });
      res.json({ events: range.events.filter((event) => event.subscriptionId === req.params.subscriptionId) });
    }),
  );

  return router;
}