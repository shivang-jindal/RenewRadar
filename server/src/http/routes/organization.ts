import { Router } from 'express';
import { z } from 'zod';

import {
  changeMemberRoleSchema,
  createInvitationSchema,
  idParamSchema,
  transferOwnershipSchema,
  updateOrganizationSchema,
  updateReminderSettingsSchema,
} from '@renewradar/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const memberParams = z.object({
  organizationId: idParamSchema.shape.id,
  memberId: idParamSchema.shape.id,
});

const invitationParams = z.object({
  organizationId: idParamSchema.shape.id,
  invitationId: idParamSchema.shape.id,
});

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  entityType: z.string().trim().max(50).optional(),
  entityId: z.string().trim().max(80).optional(),
  action: z.string().trim().max(80).optional(),
});

export function organizationRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const [organization, settings] = await Promise.all([
        services.organizations.get(req.organization!.id),
        services.organizations.getSettings(req.organization!.id),
      ]);
      res.json({ organization, role: req.organizationRole, permissions: req.permissions, settings });
    }),
  );

  router.patch(
    '/',
    requirePermission('settings.manage'),
    validate({ body: updateOrganizationSchema }),
    asyncHandler(async (req, res) => {
      const organization = await services.organizations.update(
        req.organization!.id,
        req.principal!.user.id,
        req.body as Record<string, never>,
      );
      res.json({ organization });
    }),
  );

  /**
   * Reminder settings.
   *
   * Timezone, reminder time and quiet hours are organization-level defaults.
   * Reminder *delivery* happens in the worker process, not in this request.
   */
  router.patch(
    '/settings/reminders',
    requirePermission('reminder.manage'),
    validate({ body: updateReminderSettingsSchema }),
    asyncHandler(async (req, res) => {
      const settings = await services.organizations.updateSettings(
        req.organization!.id,
        req.principal!.user.id,
        req.body as Record<string, never>,
      );
      // Unpausing re-plans immediately so the user sees the effect now rather
      // than at the next worker tick.
      const scheduled = await services.reminders.scheduleDueReminders(req.organization!.id);
      res.json({ settings, remindersPlanned: scheduled.created });
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Members and invitations                                                */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/members',
    asyncHandler(async (req, res) => {
      res.json({
        members: await services.organizations.listMembers(req.organization!.id),
        myRole: req.organizationRole,
      });
    }),
  );

  router.post(
    '/members/invitations',
    requirePermission('member.manage'),
    validate({ body: createInvitationSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { email: string; role: 'admin' | 'member' | 'viewer' };
      const invitation = await services.organizations.invite({
        organizationId: req.organization!.id,
        email: body.email,
        role: body.role,
        invitedBy: req.principal!.user.id,
        actorRole: req.organizationRole!,
      });

      const acceptUrl = `${services.config.appUrl}/accept-invitation?token=${invitation.token}`;
      const verification = await services.emailAdapter.verifyConfiguration();
      let emailed = false;
      if (verification.ok) {
        const queued = await services.email.queue({
          organizationId: req.organization!.id,
          templateType: 'invitation',
          to: body.email,
          subject: `You have been invited to ${req.organization!.name} on RenewRadar`,
          bodyText: [
            `${req.principal!.user.displayName} invited you to join ${req.organization!.name} as ${body.role}.`,
            '',
            `Accept the invitation: ${acceptUrl}`,
            '',
            'The link expires in 7 days and can only be used once.',
          ].join('\n'),
        });
        const delivery = await services.email.deliver(queued.messageId);
        emailed = delivery.status === 'sent';
      }

      res.status(201).json({
        invitation: {
          id: invitation.invitationId,
          expiresAt: invitation.expiresAt.toISOString(),
          acceptUrl,
          emailed,
          emailConfigured: verification.ok,
        },
      });
    }),
  );

  router.get(
    '/members/invitations',
    requirePermission('member.manage'),
    asyncHandler(async (req, res) => {
      res.json({ invitations: await services.organizations.listInvitations(req.organization!.id) });
    }),
  );

  router.delete(
    '/members/invitations/:invitationId',
    requirePermission('member.manage'),
    validate({ params: invitationParams }),
    asyncHandler(async (req, res) => {
      await services.organizations.revokeInvitation(
        req.organization!.id,
        req.params.invitationId as string,
        req.principal!.user.id,
      );
      res.status(204).end();
    }),
  );

  router.patch(
    '/members/:memberId',
    requirePermission('member.manage'),
    validate({ params: memberParams, body: changeMemberRoleSchema }),
    asyncHandler(async (req, res) => {
      const member = await services.organizations.changeMemberRole({
        organizationId: req.organization!.id,
        membershipId: req.params.memberId as string,
        actorUserId: req.principal!.user.id,
        actorRole: req.organizationRole!,
        role: (req.body as { role: 'admin' | 'member' | 'viewer' }).role,
      });
      res.json({ member });
    }),
  );

  router.delete(
    '/members/:memberId',
    requirePermission('member.manage'),
    validate({ params: memberParams }),
    asyncHandler(async (req, res) => {
      await services.organizations.removeMember({
        organizationId: req.organization!.id,
        membershipId: req.params.memberId as string,
        actorUserId: req.principal!.user.id,
        actorRole: req.organizationRole!,
      });
      res.status(204).end();
    }),
  );

  /** Audited ownership transfer; requires the typed confirmation phrase. */
  router.post(
    '/transfer-ownership',
    requirePermission('ownership.transfer'),
    validate({ body: transferOwnershipSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { membershipId: string; confirmation: string };
      const member = await services.organizations.transferOwnership({
        organizationId: req.organization!.id,
        membershipId: body.membershipId,
        actorUserId: req.principal!.user.id,
        confirmation: body.confirmation,
      });
      res.json({ member });
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Audit and email outbox                                                 */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/audit',
    requirePermission('audit.view'),
    validate({ query: auditQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        entityType?: string;
        entityId?: string;
        action?: string;
      };
      res.json(await services.audit.list(req.organization!.id, query));
    }),
  );

  /** What the mail provider actually accepted, and what it refused. */
  router.get(
    '/email/outbox',
    requirePermission('settings.manage'),
    asyncHandler(async (req, res) => {
      const rows = await services.email.outbox(req.organization!.id);
      res.json({
        items: rows.map((row) => ({
          ...row,
          sentAt: row.sentAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        stats: await services.email.stats(req.organization!.id),
        provider: services.emailAdapter.name,
        deliversMessages: services.emailAdapter.deliversMessages,
        note: 'A message marked "sent" means the provider accepted it for delivery. Plain SMTP does not report delivery, so RenewRadar never claims a message was delivered.',
      });
    }),
  );

  return router;
}
