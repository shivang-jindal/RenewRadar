/**
 * Budgets (Part E / E3.6).
 *
 * Spend is the monthly-equivalent recurring cost of the subscriptions a budget
 * covers, **grouped by currency**. A budget only ever compares against spend in
 * its own currency, so a multi-currency account can never produce a misleading
 * "92% of budget" figure (Part E / E7).
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';


import type { BudgetView } from '@renewradar/shared';
import { groupByCurrency, monthlyEquivalentMinor, type IntervalUnit } from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { budgets, categories, subscriptions } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import type { AuditService } from './audit.service.js';

/** Statuses that still cost money on a recurring basis. */
const BILLED_STATUSES = ['active', 'trial', 'cancel_planned'] as const;

export interface BudgetInput {
  name: string;
  categoryId?: string | null;
  amountMinor: number;
  currency: string;
  period: 'monthly' | 'yearly';
  thresholdPercent: number;
  enabled: boolean;
}

export class BudgetService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async list(
    organizationId: string,
    filters: { currency?: string; enabled?: boolean } = {},
  ): Promise<BudgetView[]> {
    const conditions = [eq(budgets.organizationId, organizationId)];
    if (filters.currency) conditions.push(eq(budgets.currency, filters.currency));
    if (filters.enabled !== undefined) conditions.push(eq(budgets.enabled, filters.enabled));

    const rows = await this.db
      .select({
        id: budgets.id,
        name: budgets.name,
        categoryId: budgets.categoryId,
        categoryName: categories.name,
        amountMinor: budgets.amountMinor,
        currency: budgets.currency,
        period: budgets.period,
        thresholdPercent: budgets.thresholdPercent,
        enabled: budgets.enabled,
        createdAt: budgets.createdAt,
        updatedAt: budgets.updatedAt,
      })
      .from(budgets)
      .leftJoin(categories, eq(categories.id, budgets.categoryId))
      .where(and(...conditions))
      .orderBy(asc(budgets.name));

    const spendRows = await this.db
      .select({
        categoryId: subscriptions.categoryId,
        currency: subscriptions.currency,
        amountMinor: subscriptions.amountMinor,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          isNull(subscriptions.archivedAt),
          inArray(subscriptions.status, [...BILLED_STATUSES]),
        ),
      );

    return rows.map((row) => {
      const monthly = groupByCurrency(
        spendRows
          .filter((entry) => (row.categoryId ? entry.categoryId === row.categoryId : entry.categoryId === null))
          .map((entry) => ({
            currency: entry.currency,
            amountMinor: monthlyEquivalentMinor({
              amountMinor: entry.amountMinor,
              unit: entry.intervalUnit as IntervalUnit,
              intervalCount: entry.intervalCount,
            }),
          })),
      );

      const spendMinor =
        monthly.find((entry) => entry.currency === row.currency)?.amountMinor ??
        (monthly.length === 0 && spendRows.length === 0 ? 0 : null);

      // Only a single-currency scope can be compared directly. When the covered
      // subscriptions span several currencies the usage figure is withheld
      // rather than guessed.
      const comparable = spendMinor !== null;
      const monthlyEquivalent = comparable ? spendMinor : 0;
      const periodSpendMinor = row.period === 'yearly' ? monthlyEquivalent * 12 : monthlyEquivalent;
      const usagePercent =
        comparable && row.amountMinor > 0 ? Math.round((periodSpendMinor / row.amountMinor) * 10_000) / 100 : null;
      const warningPercent =
        comparable && row.amountMinor > 0 ? Math.round((row.amountMinor * row.thresholdPercent) / 100) : null;

      return {
        id: row.id,
        name: row.name,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        amountMinor: row.amountMinor,
        currency: row.currency,
        period: row.period as BudgetView['period'],
        thresholdPercent: row.thresholdPercent,
        enabled: row.enabled,
        spendMinor: monthlyEquivalent,
        periodSpendMinor,
        usagePercent,
        warningPercent,
        atRisk: usagePercent !== null && usagePercent >= row.thresholdPercent,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async get(organizationId: string, budgetId: string) {
    const rows = await this.db
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, budgetId), eq(budgets.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Budget');
    return row;
  }

  async create(
    organizationId: string,
    actorUserId: string,
    input: BudgetInput,
  ): Promise<typeof budgets.$inferSelect> {
    if (input.categoryId) {
      const category = await this.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, input.categoryId), eq(categories.organizationId, organizationId)))
        .limit(1);
      if (!category[0]) throw notFound('Category');
    }

    const inserted = await this.db
      .insert(budgets)
      .values({
        organizationId,
        name: input.name.trim(),
        categoryId: input.categoryId ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency,
        period: input.period,
        thresholdPercent: input.thresholdPercent,
        enabled: input.enabled,
      })
      .returning();
    const row = inserted[0]!;

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'budget.created',
      entityType: 'budget',
      entityId: row.id,
      metadata: { name: row.name, currency: row.currency, amountMinor: row.amountMinor },
    });
    return row;
  }

  async update(
    organizationId: string,
    actorUserId: string,
    budgetId: string,
    patch: Partial<BudgetInput>,
  ): Promise<typeof budgets.$inferSelect> {
    await this.get(organizationId, budgetId);
    if (patch.categoryId) {
      const category = await this.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, patch.categoryId), eq(categories.organizationId, organizationId)))
        .limit(1);
      if (!category[0]) throw notFound('Category');
    }
    if (patch.amountMinor !== undefined && patch.amountMinor <= 0) {
      throw badRequest('The budget amount must be greater than zero.', {
        amountMinor: ['Must be positive'],
      });
    }

    const updated = await this.db
      .update(budgets)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.amountMinor !== undefined ? { amountMinor: patch.amountMinor } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.period !== undefined ? { period: patch.period } : {}),
        ...(patch.thresholdPercent !== undefined ? { thresholdPercent: patch.thresholdPercent } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(budgets.id, budgetId), eq(budgets.organizationId, organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Budget');

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'budget.updated',
      entityType: 'budget',
      entityId: budgetId,
      metadata: { fields: Object.keys(patch) },
    });
    return updated[0];
  }

  async remove(
    organizationId: string,
    actorUserId: string,
    budgetId: string,
  ): Promise<void> {
    const deleted = await this.db
      .delete(budgets)
      .where(and(eq(budgets.id, budgetId), eq(budgets.organizationId, organizationId)))
      .returning({ id: budgets.id });
    if (!deleted[0]) throw notFound('Budget');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'budget.deleted',
      entityType: 'budget',
      entityId: budgetId,
    });
  }
}