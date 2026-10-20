/**
 * Subscriptions (Part E / E3.2, E3.3, E3.4, E3.7).
 *
 * Rules enforced here, not only in the browser:
 *  - money is integer minor units and never summed across currencies;
 *  - `cancel_planned` records an intention, `cancelled` records a confirmation
 *    the user made with the vendor - RenewRadar never contacts the vendor;
 *  - price history is append-only and is never lost when a subscription is
 *    edited;
 *  - every query is scoped by `organization_id`, so a foreign id is a 404.
 */

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type {
  DecisionEntry,
  Paginated,
  PriceHistoryEntry,
  SubscriptionDetail,
  SubscriptionListItem,
} from '@renewradar/shared';
import {
  CLOSING_DECISIONS,
  DECISION_LABELS,
  anchorDayOf,
  daysBetweenIso,
  describePriceDelta,
  isAnchorDayClamped,
  monthlyEquivalentMinor,
  OPEN_DECISIONS,
  priceDelta,
  renewalStatus,
  upcomingRenewalDates,
  type Decision,
  type IntervalUnit,
  type PriceSource,
  type SubscriptionStatus,
} from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import {
  attachments,
  categories,
  memberships,
  organizations,
  reminderLogs,
  subscriptionDecisions,
  subscriptionPriceHistory,
  subscriptions,
  users,
} from '../db/schema.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';

export interface SubscriptionInput {
  name: string;
  vendorName: string;
  planName?: string | null;
  categoryId?: string | null;
  amountMinor: number;
  currency: string;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  startDate: string;
  nextRenewalDate: string;
  trialEndDate?: string | null;
  cancellationDeadline?: string | null;
  renewalType: 'auto' | 'manual';
  status: SubscriptionStatus;
  ownerUserId?: string | null;
  paymentMethodLabel?: string | null;
  vendorUrl?: string | null;
  cancellationUrl?: string | null;
  notes?: string | null;
  personalOrBusiness: 'business' | 'personal';
  timezone?: string;
}

export interface SubscriptionListQuery {
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
}

interface Context {
  requestId?: string | null;
  ipAddress?: string | null;
}

/** Latest decision per subscription, used for "marked for review". */
const latestDecisionSql = sql<string | null>`(
  SELECT d.decision
    FROM subscription_decisions d
   WHERE d.subscription_id = ${subscriptions.id}
     AND d.organization_id = ${subscriptions.organizationId}
   ORDER BY d.recorded_at DESC, d.id DESC
   LIMIT 1
)`;

export class SubscriptionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async list(organizationId: string, query: SubscriptionListQuery, today: string): Promise<Paginated<SubscriptionListItem>> {
    const filters: Array<ReturnType<typeof eq>> = [eq(subscriptions.organizationId, organizationId)];

    switch (query.view) {
      case 'archived':
        filters.push(isNotNull(subscriptions.archivedAt));
        break;
      case 'all':
        // Includes archived rows so the "all" view is honest.
        break;
      case 'trials':
        filters.push(isNull(subscriptions.archivedAt), eq(subscriptions.status, 'trial'));
        break;
      case 'cancellation_planned':
        filters.push(isNull(subscriptions.archivedAt), eq(subscriptions.status, 'cancel_planned'));
        break;
      case 'cancelled':
        filters.push(isNull(subscriptions.archivedAt), eq(subscriptions.status, 'cancelled'));
        break;
      case 'paused':
        filters.push(isNull(subscriptions.archivedAt), eq(subscriptions.status, 'paused'));
        break;
      case 'active':
      default:
        // "Active" means a live subscription, including one whose cancellation
        // is only planned - those still renew until the user confirms.
        filters.push(
          isNull(subscriptions.archivedAt),
          inArray(subscriptions.status, ['active', 'trial', 'cancel_planned']),
        );
        break;
    }

    if (query.categoryId) filters.push(eq(subscriptions.categoryId, query.categoryId));
    if (query.currency) filters.push(eq(subscriptions.currency, query.currency));
    if (query.ownerUserId) filters.push(eq(subscriptions.ownerUserId, query.ownerUserId));
    if (query.renewalFrom) filters.push(sql`${subscriptions.nextRenewalDate} >= ${query.renewalFrom}`);
    if (query.renewalTo) filters.push(sql`${subscriptions.nextRenewalDate} <= ${query.renewalTo}`);
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      filters.push(
        or(
          ilike(subscriptions.name, needle),
          ilike(subscriptions.vendorName, needle),
          ilike(subscriptions.planName, needle),
          ilike(subscriptions.paymentMethodLabel, needle),
        )!,
      );
    }
    if (query.markedForReview !== undefined) {
      filters.push(
        query.markedForReview
          ? sql`${latestDecisionSql} in ('review', 'downgrade', 'cancel_planned')`
          : sql`(${latestDecisionSql} is null or ${latestDecisionSql} not in ('review', 'downgrade', 'cancel_planned'))`,
      );
    }

    const where = and(...filters);
    const orderBy = orderExpression(query.sort, query.order);

    const rows = await this.db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        vendorName: subscriptions.vendorName,
        planName: subscriptions.planName,
        categoryId: subscriptions.categoryId,
        categoryName: categories.name,
        categoryColorToken: categories.colorToken,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
        startDate: subscriptions.startDate,
        nextRenewalDate: subscriptions.nextRenewalDate,
        trialEndDate: subscriptions.trialEndDate,
        cancellationDeadline: subscriptions.cancellationDeadline,
        renewalType: subscriptions.renewalType,
        status: subscriptions.status,
        ownerUserId: subscriptions.ownerUserId,
        ownerName: ownerNameSql,
        paymentMethodLabel: subscriptions.paymentMethodLabel,
        personalOrBusiness: subscriptions.personalOrBusiness,
        updatedAt: subscriptions.updatedAt,
        archivedAt: subscriptions.archivedAt,
        latestDecision: latestDecisionSql,
      })
      .from(subscriptions)
      .leftJoin(categories, eq(categories.id, subscriptions.categoryId))
      .where(where)
      .orderBy(orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(where);
    const totalCount = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => toListItem(row, today)),
      page: query.page,
      pageSize: query.pageSize,
      total: totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
    };
  }

  async get(organizationId: string, subscriptionId: string): Promise<typeof subscriptions.$inferSelect> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    // Cross-tenant reads are indistinguishable from a missing row (Part A / A5).
    if (!row) throw notFound('Subscription');
    return row;
  }

  async listItem(organizationId: string, subscriptionId: string, today: string): Promise<SubscriptionListItem> {
    const rows = await this.db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        vendorName: subscriptions.vendorName,
        planName: subscriptions.planName,
        categoryId: subscriptions.categoryId,
        categoryName: categories.name,
        categoryColorToken: categories.colorToken,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
        startDate: subscriptions.startDate,
        nextRenewalDate: subscriptions.nextRenewalDate,
        trialEndDate: subscriptions.trialEndDate,
        cancellationDeadline: subscriptions.cancellationDeadline,
        renewalType: subscriptions.renewalType,
        status: subscriptions.status,
        ownerUserId: subscriptions.ownerUserId,
        ownerName: ownerNameSql,
        paymentMethodLabel: subscriptions.paymentMethodLabel,
        personalOrBusiness: subscriptions.personalOrBusiness,
        updatedAt: subscriptions.updatedAt,
        archivedAt: subscriptions.archivedAt,
        latestDecision: latestDecisionSql,
      })
      .from(subscriptions)
      .leftJoin(categories, eq(categories.id, subscriptions.categoryId))
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('Subscription');
    return toListItem(row, today);
  }

  /** Full detail used by the subscription screen (E3.4). */
  async detail(organizationId: string, subscriptionId: string, today: string): Promise<SubscriptionDetail> {
    const record = await this.get(organizationId, subscriptionId);
    const item = await this.listItem(organizationId, subscriptionId, today);
    const anchorDay = anchorDayOf(record.startDate);

    const [priceHistory, decisions, attachmentRows, nextReminders, timeline] = await Promise.all([
      this.priceHistory(organizationId, subscriptionId),
      this.decisions(organizationId, subscriptionId),
      this.db
        .select({
          id: attachments.id,
          originalFilenameSafe: attachments.originalFilenameSafe,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
          uploadedBy: attachments.uploadedBy,
          uploadedByName: sql<string | null>`(SELECT display_name FROM users WHERE users.id = ${attachments.uploadedBy})`,
          createdAt: attachments.createdAt,
        })
        .from(attachments)
        .where(and(eq(attachments.organizationId, organizationId), eq(attachments.subscriptionId, subscriptionId)))
        .orderBy(desc(attachments.createdAt)),
      this.db
        .select({
          id: reminderLogs.id,
          eventType: reminderLogs.eventType,
          targetDate: reminderLogs.targetDate,
          status: reminderLogs.status,
          channel: reminderLogs.channel,
          sentAt: reminderLogs.sentAt,
        })
        .from(reminderLogs)
        .where(
          and(
            eq(reminderLogs.organizationId, organizationId),
            eq(reminderLogs.subscriptionId, subscriptionId),
          ),
        )
        .orderBy(asc(reminderLogs.targetDate))
        .limit(12),
      this.audit.forEntity('subscription', subscriptionId, 25),
    ]);

    return {
      subscription: item,
      upcomingRenewals: upcomingRenewalDates({
        current: record.nextRenewalDate,
        anchorDay,
        unit: record.intervalUnit as IntervalUnit,
        intervalCount: record.intervalCount,
        count: 6,
      }),
      anchorDay,
      anchorDayClamped: isAnchorDayClamped(record.nextRenewalDate, anchorDay),
      priceHistory,
      decisions,
      attachments: attachmentRows.map((row) => ({
        id: row.id,
        subscriptionId,
        originalFilenameSafe: row.originalFilenameSafe,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        uploadedBy: row.uploadedBy,
        uploadedByName: row.uploadedByName,
        createdAt: row.createdAt.toISOString(),
        downloadUrl: null,
        storageConfigured: false,
      })),
      nextReminders: nextReminders.map((row) => ({
        id: row.id,
        eventType: row.eventType as SubscriptionDetail['nextReminders'][number]['eventType'],
        targetDate: row.targetDate,
        status: row.status as SubscriptionDetail['nextReminders'][number]['status'],
        channel: row.channel as SubscriptionDetail['nextReminders'][number]['channel'],
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
      timeline,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  async create(
    organizationId: string,
    actorUserId: string,
    input: SubscriptionInput,
    context: Context = {},
    source: PriceSource = 'manual',
  ): Promise<typeof subscriptions.$inferSelect> {
    const organization = await this.requireOrganization(organizationId);
    const timezone = input.timezone ?? organization.timezone;

    if (input.categoryId) await this.assertCategory(organizationId, input.categoryId);
    if (input.ownerUserId) await this.assertMember(organizationId, input.ownerUserId);

    this.assertDomainRules(input);

    const status = this.resolveInitialStatus(input, todayIn(timezone));

    const created = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(subscriptions)
        .values({
          organizationId,
          name: input.name.trim(),
          vendorName: input.vendorName.trim(),
          planName: input.planName ?? null,
          categoryId: input.categoryId ?? null,
          amountMinor: input.amountMinor,
          currency: input.currency,
          intervalUnit: input.intervalUnit,
          intervalCount: input.intervalCount,
          startDate: input.startDate,
          nextRenewalDate: input.nextRenewalDate,
          trialEndDate: input.trialEndDate ?? null,
          cancellationDeadline: input.cancellationDeadline ?? null,
          renewalType: input.renewalType,
          status,
          ownerUserId: input.ownerUserId ?? null,
          paymentMethodLabel: input.paymentMethodLabel ?? null,
          vendorUrl: input.vendorUrl ?? null,
          cancellationUrl: input.cancellationUrl ?? null,
          notes: input.notes ?? null,
          personalOrBusiness: input.personalOrBusiness,
          timezone,
          createdBy: actorUserId,
          cancelledAt: status === 'cancelled' ? new Date() : null,
        })
        .returning();

      const row = inserted[0]!;
      // The opening price is a price-history row like any other, so the
      // increase/decrease chain is complete from day one (Part E / E4).
      await tx.insert(subscriptionPriceHistory).values({
        organizationId,
        subscriptionId: row.id,
        oldAmountMinor: null,
        oldCurrency: null,
        newAmountMinor: row.amountMinor,
        currency: row.currency,
        effectiveDate: row.startDate,
        source,
        changedBy: actorUserId,
        note: 'Initial price recorded when the subscription was added',
      });
      return row;
    });

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'subscription.created',
      entityType: 'subscription',
      entityId: created.id,
      metadata: {
        name: created.name,
        vendor: created.vendorName,
        currency: created.currency,
        amountMinor: created.amountMinor,
        intervalUnit: created.intervalUnit,
        source,
      },
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
    });
    return created;
  }

  async update(
    organizationId: string,
    actorUserId: string,
    subscriptionId: string,
    patch: Partial<SubscriptionInput>,
    context: Context = {},
    source: PriceSource = 'manual',
  ): Promise<{ subscription: typeof subscriptions.$inferSelect; priceChanged: boolean; scheduleChanged: boolean }> {
    const existing = await this.get(organizationId, subscriptionId);
    if (patch.categoryId) await this.assertCategory(organizationId, patch.categoryId);
    if (patch.ownerUserId) await this.assertMember(organizationId, patch.ownerUserId);

    const organization = await this.requireOrganization(organizationId);
    const timezone = patch.timezone ?? existing.timezone ?? organization.timezone;

    const next: SubscriptionInput = {
      name: patch.name ?? existing.name,
      vendorName: patch.vendorName ?? existing.vendorName,
      planName: patch.planName === undefined ? existing.planName : patch.planName,
      categoryId: patch.categoryId === undefined ? existing.categoryId : patch.categoryId,
      amountMinor: patch.amountMinor ?? existing.amountMinor,
      currency: patch.currency ?? existing.currency,
      intervalUnit: patch.intervalUnit ?? (existing.intervalUnit as IntervalUnit),
      intervalCount: patch.intervalCount ?? existing.intervalCount,
      startDate: patch.startDate ?? existing.startDate,
      nextRenewalDate: patch.nextRenewalDate ?? existing.nextRenewalDate,
      trialEndDate: patch.trialEndDate === undefined ? existing.trialEndDate : patch.trialEndDate,
      cancellationDeadline:
        patch.cancellationDeadline === undefined ? existing.cancellationDeadline : patch.cancellationDeadline,
      renewalType: patch.renewalType ?? (existing.renewalType as 'auto' | 'manual'),
      status: patch.status ?? (existing.status as SubscriptionStatus),
      ownerUserId: patch.ownerUserId === undefined ? existing.ownerUserId : patch.ownerUserId,
      paymentMethodLabel:
        patch.paymentMethodLabel === undefined ? existing.paymentMethodLabel : patch.paymentMethodLabel,
      vendorUrl: patch.vendorUrl === undefined ? existing.vendorUrl : patch.vendorUrl,
      cancellationUrl: patch.cancellationUrl === undefined ? existing.cancellationUrl : patch.cancellationUrl,
      notes: patch.notes === undefined ? existing.notes : patch.notes,
      personalOrBusiness: patch.personalOrBusiness ?? (existing.personalOrBusiness as 'business' | 'personal'),
      timezone,
    };

    this.assertDomainRules(next);

    const priceChanged = next.amountMinor !== existing.amountMinor || next.currency !== existing.currency;
    const scheduleChanged =
      next.nextRenewalDate !== existing.nextRenewalDate ||
      next.trialEndDate !== existing.trialEndDate ||
      next.cancellationDeadline !== existing.cancellationDeadline ||
      next.intervalUnit !== existing.intervalUnit ||
      next.intervalCount !== existing.intervalCount ||
      next.status !== existing.status;

    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(subscriptions)
        .set({
          name: next.name.trim(),
          vendorName: next.vendorName.trim(),
          planName: next.planName ?? null,
          categoryId: next.categoryId ?? null,
          amountMinor: next.amountMinor,
          currency: next.currency,
          intervalUnit: next.intervalUnit,
          intervalCount: next.intervalCount,
          startDate: next.startDate,
          nextRenewalDate: next.nextRenewalDate,
          trialEndDate: next.trialEndDate ?? null,
          cancellationDeadline: next.cancellationDeadline ?? null,
          renewalType: next.renewalType,
          status: next.status,
          ownerUserId: next.ownerUserId ?? null,
          paymentMethodLabel: next.paymentMethodLabel ?? null,
          vendorUrl: next.vendorUrl ?? null,
          cancellationUrl: next.cancellationUrl ?? null,
          notes: next.notes ?? null,
          personalOrBusiness: next.personalOrBusiness,
          timezone,
          updatedAt: new Date(),
          cancelledAt: next.status === 'cancelled' ? (existing.cancelledAt ?? new Date()) : null,
        })
        .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
        .returning();

      const row = rows[0];
      if (!row) throw notFound('Subscription');

      if (priceChanged) {
        // Append-only history: the previous chain is preserved, never rewritten.
        await tx.insert(subscriptionPriceHistory).values({
          organizationId,
          subscriptionId,
          oldAmountMinor: existing.amountMinor,
          oldCurrency: existing.currency,
          newAmountMinor: next.amountMinor,
          currency: next.currency,
          effectiveDate: todayIn(timezone),
          source,
          changedBy: actorUserId,
          note: 'Price updated',
        });
      }

      return row;
    });

    if (priceChanged) {
      await this.audit.record({
        organizationId,
        actorUserId,
        action: 'subscription.price_changed',
        entityType: 'subscription',
        entityId: subscriptionId,
        metadata: {
          fromMinor: existing.amountMinor,
          toMinor: updated.amountMinor,
          fromCurrency: existing.currency,
          toCurrency: updated.currency,
          source,
        },
        requestId: context.requestId ?? null,
      });
    }

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'subscription.updated',
      entityType: 'subscription',
      entityId: subscriptionId,
      metadata: { fields: Object.keys(patch) },
      requestId: context.requestId ?? null,
    });

    // `scheduleChanged` tells the caller to re-plan pending reminders. Already
    // delivered reminders are never removed, so editing a renewal date cannot
    // cause a second notification for the old date (Part E / E7).
    return { subscription: updated, priceChanged, scheduleChanged };
  }

  async setArchived(
    organizationId: string,
    actorUserId: string,
    subscriptionId: string,
    archived: boolean,
    context: Context = {},
  ): Promise<typeof subscriptions.$inferSelect> {
    await this.get(organizationId, subscriptionId);
    const updated = await this.db
      .update(subscriptions)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Subscription');

    if (archived) {
      // Archived subscriptions stop producing reminders entirely.
      await this.db
        .update(reminderLogs)
        .set({ status: 'skipped', safeFailureMessage: 'Subscription archived.' })
        .where(
          and(
            eq(reminderLogs.organizationId, organizationId),
            eq(reminderLogs.subscriptionId, subscriptionId),
            eq(reminderLogs.status, 'queued'),
          ),
        );
    }

    await this.audit.record({
      organizationId,
      actorUserId,
      action: archived ? 'subscription.archived' : 'subscription.restored',
      entityType: 'subscription',
      entityId: subscriptionId,
      metadata: context.requestId ? { requestId: context.requestId } : undefined,
    });
    return updated[0];
  }

  /**
   * Record a keep / review / downgrade / cancel-planned / cancelled decision.
   *
   * `cancel_planned` moves the subscription to the distinct
   * `cancel_planned` status; it never marks anything cancelled. Only the
   * explicit `cancelled` decision - which the schema requires to carry the
   * date the user confirmed with the vendor - sets `cancelled`.
   */
  async recordDecision(input: {
    organizationId: string;
    subscriptionId: string;
    actorUserId: string;
    decision: Decision;
    reason?: string | null;
    reviewOn?: string | null;
    cancellationConfirmedAt?: string | null;
    cancellationReference?: string | null;
    requestId?: string | null;
  }): Promise<{ decision: typeof subscriptionDecisions.$inferSelect; status: SubscriptionStatus }> {
    const existing = await this.get(input.organizationId, input.subscriptionId);

    let status: SubscriptionStatus = existing.status as SubscriptionStatus;
    if (input.decision === 'cancel_planned') status = 'cancel_planned';
    else if (input.decision === 'cancelled') status = 'cancelled';
    else if (CLOSING_DECISIONS.includes(input.decision)) {
      // Keep after a cancellation was planned returns the subscription to life.
      status = existing.status === 'trial' ? 'trial' : 'active';
    }
    // `review` and `downgrade` deliberately leave the status untouched: the
    // subscription still renews unless the user cancels it.

    const result = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(subscriptionDecisions)
        .values({
          organizationId: input.organizationId,
          subscriptionId: input.subscriptionId,
          decision: input.decision,
          reason: input.reason ?? null,
          reviewOn: input.reviewOn ?? null,
          cancellationConfirmedAt: input.decision === 'cancelled' ? (input.cancellationConfirmedAt ?? null) : null,
          cancellationReference: input.cancellationReference ?? null,
          recordedBy: input.actorUserId,
        })
        .returning();
      const decisionRow = rows[0]!;

      await tx
        .update(subscriptions)
        .set({
          status,
          cancelledAt: input.decision === 'cancelled' ? new Date() : existing.cancelledAt,
          updatedAt: new Date(),
        })
        .where(
          and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.organizationId, input.organizationId)),
        );

      return decisionRow;
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: `decision.${input.decision}`,
      entityType: 'subscription',
      entityId: input.subscriptionId,
      metadata: { reason: input.reason ?? null, reviewOn: input.reviewOn ?? null },
      requestId: input.requestId ?? null,
    });

    return { decision: result, status };
  }

  async decisions(organizationId: string, subscriptionId: string): Promise<DecisionEntry[]> {
    const rows = await this.db
      .select({
        id: subscriptionDecisions.id,
        decision: subscriptionDecisions.decision,
        reason: subscriptionDecisions.reason,
        reviewOn: subscriptionDecisions.reviewOn,
        recordedAt: subscriptionDecisions.recordedAt,
        recordedBy: users.displayName,
      })
      .from(subscriptionDecisions)
      .leftJoin(users, eq(users.id, subscriptionDecisions.recordedBy))
      .where(
        and(
          eq(subscriptionDecisions.organizationId, organizationId),
          eq(subscriptionDecisions.subscriptionId, subscriptionId),
        ),
      )
      .orderBy(desc(subscriptionDecisions.recordedAt), desc(subscriptionDecisions.id));

    return rows.map((row) => ({
      id: row.id,
      subscriptionId,
      decision: row.decision as Decision,
      decisionLabel: DECISION_LABELS[row.decision as Decision] ?? row.decision,
      reason: row.reason,
      reviewOn: row.reviewOn,
      recordedBy: null,
      recordedByName: row.recordedBy,
      recordedAt: row.recordedAt.toISOString(),
    }));
  }

  async priceHistory(organizationId: string, subscriptionId: string): Promise<PriceHistoryEntry[]> {
    const rows = await this.db
      .select({
        id: subscriptionPriceHistory.id,
        subscriptionId: subscriptionPriceHistory.subscriptionId,
        oldAmountMinor: subscriptionPriceHistory.oldAmountMinor,
        newAmountMinor: subscriptionPriceHistory.newAmountMinor,
        oldCurrency: subscriptionPriceHistory.oldCurrency,
        currency: subscriptionPriceHistory.currency,
        effectiveDate: subscriptionPriceHistory.effectiveDate,
        source: subscriptionPriceHistory.source,
        note: subscriptionPriceHistory.note,
        createdAt: subscriptionPriceHistory.createdAt,
        changedByName: users.displayName,
      })
      .from(subscriptionPriceHistory)
      .leftJoin(users, eq(users.id, subscriptionPriceHistory.changedBy))
      .where(
        and(
          eq(subscriptionPriceHistory.organizationId, organizationId),
          eq(subscriptionPriceHistory.subscriptionId, subscriptionId),
        ),
      )
      .orderBy(desc(subscriptionPriceHistory.effectiveDate), desc(subscriptionPriceHistory.createdAt));

    return rows.map((row) => {
      const delta = priceDelta({
        oldAmountMinor: row.oldAmountMinor === null ? null : Number(row.oldAmountMinor),
        newAmountMinor: Number(row.newAmountMinor),
        oldCurrency: row.oldCurrency,
        newCurrency: row.currency,
      });
      return {
        id: row.id,
        subscriptionId: row.subscriptionId,
        oldAmountMinor: row.oldAmountMinor === null ? null : Number(row.oldAmountMinor),
        newAmountMinor: Number(row.newAmountMinor),
        oldCurrency: row.oldCurrency,
        currency: row.currency,
        effectiveDate: row.effectiveDate,
        source: row.source as PriceSource,
        sourceLabel: PRICE_SOURCE_LABELS[row.source as PriceSource] ?? row.source,
        note: row.note,
        changedBy: null,
        changedByName: row.changedByName,
        changeMinor: delta.changeMinor,
        changePercent: delta.changePercent,
        direction: delta.direction,
        currencyChanged: delta.currencyChanged,
        summary: describePriceDelta(delta),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Bulk edits                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Bulk category / owner / tag changes only.
   *
   * Bulk *cancellation* is deliberately not offered: RenewRadar cannot cancel
   * anything with a vendor, so a "cancel all" button would be decorative
   * (Part E / E3.2).
   */
  async bulkUpdate(input: {
    organizationId: string;
    actorUserId: string;
    subscriptionIds: string[];
    patch: {
      categoryId?: string | null;
      ownerUserId?: string | null;
      personalOrBusiness?: 'business' | 'personal';
    };
    requestId?: string | null;
  }): Promise<{ updated: number; skipped: string[] }> {
    if (input.patch.categoryId) await this.assertCategory(input.organizationId, input.patch.categoryId);
    if (input.patch.ownerUserId) await this.assertMember(input.organizationId, input.patch.ownerUserId);

    const existing = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, input.organizationId),
          inArray(subscriptions.id, input.subscriptionIds),
        ),
      );
    const found = new Set(existing.map((row) => row.id));
    const skipped = input.subscriptionIds.filter((id) => !found.has(id));
    if (existing.length === 0) throw notFound('Subscription');

    const updated = await this.db
      .update(subscriptions)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.organizationId, input.organizationId),
          inArray(subscriptions.id, existing.map((row) => row.id)),
        ),
      )
      .returning({ id: subscriptions.id });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'subscription.bulk_updated',
      entityType: 'subscription',
      entityId: null,
      metadata: { count: updated.length, fields: Object.keys(input.patch) },
      requestId: input.requestId ?? null,
    });
    return { updated: updated.length, skipped };
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  private assertDomainRules(input: SubscriptionInput): void {
    if (input.startDate > input.nextRenewalDate) {
      throw badRequest('The next renewal cannot be before the start date.', {
        nextRenewalDate: ['Must be on or after the start date'],
      });
    }
    if (input.trialEndDate && input.trialEndDate < input.startDate) {
      throw badRequest('The trial end cannot be before the start date.', {
        trialEndDate: ['Must be on or after the start date'],
      });
    }
    if (input.cancellationDeadline && input.cancellationDeadline > input.nextRenewalDate) {
      throw unprocessable(
        'A cancellation deadline after the renewal date cannot be acted on in time.',
        { cancellationDeadline: ['Must be on or before the next renewal date'] },
      );
    }
    if (input.status === 'trial' && !input.trialEndDate) {
      throw badRequest('A subscription on trial needs a trial end date.', {
        trialEndDate: ['Required for a trial subscription'],
      });
    }
    if (input.amountMinor <= 0) {
      throw badRequest('The amount must be greater than zero.', { amountMinor: ['Must be positive'] });
    }
  }

  private resolveInitialStatus(input: SubscriptionInput, today: string): SubscriptionStatus {
    if (input.status === 'trial') {
      const trialEnd = input.trialEndDate ?? input.nextRenewalDate;
      // A trial whose end date has already passed becomes an active
      // subscription rather than staying "trial" forever.
      return trialEnd < today ? 'active' : 'trial';
    }
    return input.status;
  }

  private async requireOrganization(organizationId: string) {
    const rows = await this.db
      .select({ id: organizations.id, timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!rows[0]) throw notFound('Organization');
    return rows[0];
  }

  private async assertCategory(organizationId: string, categoryId: string): Promise<void> {
    const rows = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
      .limit(1);
    if (!rows[0]) throw notFound('Category');
  }

  private async assertMember(organizationId: string, userId: string): Promise<void> {
    const rows = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)))
      .limit(1);
    if (!rows[0]) throw badRequest('That person is not a member of this organization.', {
      ownerUserId: ['Not a member of this organization'],
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping and ordering                                                        */
/* -------------------------------------------------------------------------- */

export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  manual: 'Recorded by a person',
  csv_import: 'Imported from CSV',
  integration: 'Confirmed by a connected integration',
};

const ownerNameSql = sql<string | null>`(
  SELECT display_name FROM users WHERE users.id = ${subscriptions.ownerUserId}
)`;

interface ListRow {
  id: string;
  name: string;
  vendorName: string;
  planName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorToken: string | null;
  amountMinor: number;
  currency: string;
  intervalUnit: string;
  intervalCount: number;
  startDate: string;
  nextRenewalDate: string | null;
  trialEndDate: string | null;
  cancellationDeadline: string | null;
  renewalType: string;
  status: string;
  ownerUserId: string | null;
  ownerName: string | null;
  paymentMethodLabel: string | null;
  personalOrBusiness: string;
  updatedAt: Date;
  archivedAt: Date | null;
  latestDecision: string | null;
}

export function toListItem(row: ListRow, today: string): SubscriptionListItem {
  const unit = row.intervalUnit as IntervalUnit;
  const status = row.status as SubscriptionStatus;
  const latestDecision = row.latestDecision as Decision | null;
  return {
    id: row.id,
    name: row.name,
    vendorName: row.vendorName,
    planName: row.planName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryColorToken: row.categoryColorToken,
    amountMinor: row.amountMinor,
    currency: row.currency,
    monthlyEquivalentMinor: monthlyEquivalentMinor({
      amountMinor: row.amountMinor,
      unit,
      intervalCount: row.intervalCount,
    }),
    intervalUnit: unit,
    intervalCount: row.intervalCount,
    startDate: row.startDate,
    nextRenewalDate: row.nextRenewalDate,
    trialEndDate: row.trialEndDate,
    cancellationDeadline: row.cancellationDeadline,
    renewalType: row.renewalType as SubscriptionListItem['renewalType'],
    status,
    renewalState: renewalStatus({ nextRenewalDate: row.nextRenewalDate, status, today }),
    daysUntilRenewal: row.nextRenewalDate ? daysBetweenIso(today, row.nextRenewalDate) : null,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    paymentMethodLabel: row.paymentMethodLabel,
    personalOrBusiness: row.personalOrBusiness as SubscriptionListItem['personalOrBusiness'],
    latestDecision,
    markedForReview: latestDecision !== null && OPEN_DECISIONS.includes(latestDecision),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function orderExpression(sort: SubscriptionListQuery['sort'], order: 'asc' | 'desc') {
  const direction = order === 'asc' ? asc : desc;
  switch (sort) {
    case 'name':
      return direction(subscriptions.name);
    case 'vendor_name':
      return direction(subscriptions.vendorName);
    case 'amount_minor':
      return direction(subscriptions.amountMinor);
    case 'created_at':
      return direction(subscriptions.createdAt);
    case 'updated_at':
      return direction(subscriptions.updatedAt);
    case 'next_renewal_date':
    default:
      return direction(subscriptions.nextRenewalDate);
  }
}

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}