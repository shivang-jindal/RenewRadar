/**
 * Categories (Part E / E3.6).
 *
 * Deleting a category is never silent: the caller must choose whether the
 * assigned subscriptions move to another category or become uncategorised
 * (Part E / E7).
 */

import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';

import type { CategoryView } from '@renewradar/shared';
import { groupByCurrency, monthlyEquivalentMinor, type IntervalUnit } from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { budgets, categories, subscriptions } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { AuditService } from './audit.service.js';

export class CategoryService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string): Promise<CategoryView[]> {
    const rows = await this.db
      .select({
        id: categories.id,
        name: categories.name,
        colorToken: categories.colorToken,
        createdAt: categories.createdAt,
      })
      .from(categories)
      .where(eq(categories.organizationId, organizationId))
      .orderBy(asc(categories.name));

    const spendRows = await this.db
      .select({
        categoryId: subscriptions.categoryId,
        currency: subscriptions.currency,
        amountMinor: subscriptions.amountMinor,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
        archivedAt: subscriptions.archivedAt,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          sql`${subscriptions.status} in ('active', 'trial', 'cancel_planned')`,
        ),
      );

    const spendByCategory = new Map<string, Array<{ currency: string; amountMinor: number }>>();
    const countByCategory = new Map<string, number>();
    for (const row of spendRows) {
      if (!row.categoryId || row.archivedAt) continue;
      const list = spendByCategory.get(row.categoryId) ?? [];
      list.push({
        currency: row.currency,
        amountMinor: monthlyEquivalentMinor({
          amountMinor: row.amountMinor,
          unit: row.intervalUnit as IntervalUnit,
          intervalCount: row.intervalCount,
        }),
      });
      spendByCategory.set(row.categoryId, list);
      countByCategory.set(row.categoryId, (countByCategory.get(row.categoryId) ?? 0) + 1);
    }

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      colorToken: row.colorToken,
      subscriptionCount: countByCategory.get(row.id) ?? 0,
      // Grouped, never summed across currencies.
      monthlyMinorByCurrency: groupByCurrency(spendByCategory.get(row.id) ?? []),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async get(organizationId: string, categoryId: string) {
    const rows = await this.db
      .select()
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Category');
    return row;
  }

  async create(
    organizationId: string,
    actorUserId: string,
    input: { name: string; colorToken: string },
  ): Promise<typeof categories.$inferSelect> {
    const name = input.name.trim();
    const duplicate = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.organizationId, organizationId), eq(categories.name, name)))
      .limit(1);
    if (duplicate[0]) {
      throw conflict('You already have a category with that name.', { name: ['Name already in use'] });
    }

    const inserted = await this.db
      .insert(categories)
      .values({ organizationId, name, colorToken: input.colorToken, createdBy: actorUserId })
      .returning()
      .catch((error: unknown) => {
        // The pre-check above closes the normal path; the unique index closes
        // the race between two simultaneous creates.
        if (isUniqueViolation(error)) {
          throw conflict('You already have a category with that name.', { name: ['Name already in use'] });
        }
        throw error;
      });
    const row = inserted[0]!;

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'category.created',
      entityType: 'category',
      entityId: row.id,
      metadata: { name: row.name },
    });
    return row;
  }

  async update(
    organizationId: string,
    actorUserId: string,
    categoryId: string,
    patch: { name?: string; colorToken?: string },
  ): Promise<typeof categories.$inferSelect> {
    await this.get(organizationId, categoryId);
    if (patch.name) {
      const duplicate = await this.db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.organizationId, organizationId),
            eq(categories.name, patch.name.trim()),
            ne(categories.id, categoryId),
          ),
        )
        .limit(1);
      if (duplicate[0]) {
        throw conflict('You already have a category with that name.', { name: ['Name already in use'] });
      }
    }

    const updated = await this.db
      .update(categories)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.colorToken !== undefined ? { colorToken: patch.colorToken } : {}),
      })
      .where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Category');

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'category.updated',
      entityType: 'category',
      entityId: categoryId,
      metadata: { fields: Object.keys(patch) },
    });
    return updated[0];
  }

  /**
   * Delete a category after an explicit decision about its subscriptions.
   *
   * `reassignToCategoryId: null` moves them to "Uncategorized"; anything else
   * must be another category in the same organization. Nothing is deleted
   * silently, and budgets attached to the category are removed with it.
   */
  async remove(input: {
    organizationId: string;
    actorUserId: string;
    categoryId: string;
    reassignToCategoryId: string | null;
  }): Promise<{ reassigned: number; uncategorized: number }> {
    await this.get(input.organizationId, input.categoryId);

    if (input.reassignToCategoryId) {
      if (input.reassignToCategoryId === input.categoryId) {
        throw badRequest('Choose a different category to move the subscriptions into.');
      }
      await this.get(input.organizationId, input.reassignToCategoryId);
    }

    const affected = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.organizationId, input.organizationId), eq(subscriptions.categoryId, input.categoryId)),
      );

    const result = await this.db.transaction(async (tx) => {
      await tx
        .update(subscriptions)
        .set({ categoryId: input.reassignToCategoryId, updatedAt: new Date() })
        .where(
          and(
            eq(subscriptions.organizationId, input.organizationId),
            eq(subscriptions.categoryId, input.categoryId),
          ),
        );
      // A budget without a category means "everything"; deleting a category must
      // not silently retarget such a budget.
      await tx
        .update(budgets)
        .set({ categoryId: null })
        .where(
          and(eq(budgets.organizationId, input.organizationId), eq(budgets.categoryId, input.categoryId)),
        );
      await tx.delete(categories).where(eq(categories.id, input.categoryId));
      return affected.length;
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'category.deleted',
      entityType: 'category',
      entityId: input.categoryId,
      metadata: {
        reassignToCategoryId: input.reassignToCategoryId,
        subscriptionsAffected: result,
      },
    });

    return {
      reassigned: input.reassignToCategoryId ? result : 0,
      uncategorized: input.reassignToCategoryId ? 0 : result,
    };
  }

  /** Count of subscriptions that would be affected, for the confirm dialog. */
  async usage(organizationId: string, categoryId: string): Promise<{ subscriptionCount: number; budgetCount: number }> {
    const [subs] = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          eq(subscriptions.categoryId, categoryId),
          isNull(subscriptions.archivedAt),
        ),
      );
    const [bud] = await this.db
      .select({ total: count() })
      .from(budgets)
      .where(and(eq(budgets.organizationId, organizationId), eq(budgets.categoryId, categoryId)));
    return { subscriptionCount: subs?.total ?? 0, budgetCount: bud?.total ?? 0 };
  }
}