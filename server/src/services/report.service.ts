/**
 * Overview and reports (Part E / E3.1, E3.7).
 *
 * Every figure is derived from persisted subscription rows. Nothing is
 * fabricated: an empty organization returns zeros and empty arrays, and the UI
 * renders an honest empty state.
 *
 * Currency rule (Part E / E7): amounts are **grouped by currency**. No exchange
 * rate source is implemented, so no total ever mixes two currencies.
 */

import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { DashboardSummary } from '@renewradar/shared';
import {
  daysBetweenIso,
  groupByCurrency,
  monthlyEquivalentMinor,
  priceDelta,
  type Decision,
  type IntervalUnit,
  type PriceSource,
} from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import {
  categories,
  organizations,
  subscriptionDecisions,
  subscriptionPriceHistory,
  subscriptions,
} from '../db/schema.js';

/** Statuses that still generate recurring cost. */
const BILLED = ['active', 'trial', 'cancel_planned'] as const;

export const ANNUALIZED_CAVEAT =
  'The annualized estimate assumes today\'s price and billing cadence continue unchanged for twelve months. It is not a bill forecast: it ignores price changes, trials converting, proration, taxes, one-off charges and currency conversion.';

export const CURRENCY_GROUPING_NOTICE =
  'Amounts are grouped by currency and never added together. RenewRadar has no exchange-rate source, so no cross-currency total is shown.';

export class ReportService {
  constructor(private readonly db: AppDatabase) {}

  async dashboard(organizationId: string, today: string): Promise<DashboardSummary> {
    const organization = (
      await this.db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId)).limit(1)
    )[0];

    const all = await this.db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        vendorName: subscriptions.vendorName,
        categoryId: subscriptions.categoryId,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
        nextRenewalDate: subscriptions.nextRenewalDate,
        trialEndDate: subscriptions.trialEndDate,
        status: subscriptions.status,
        archivedAt: subscriptions.archivedAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))
      .orderBy(asc(subscriptions.nextRenewalDate));

    const live = all.filter((row) => row.archivedAt === null);
    const billed = live.filter((row) => (BILLED as readonly string[]).includes(row.status));

    const monthlyEntries = billed.map((row) => ({
      currency: row.currency,
      amountMinor: monthlyEquivalentMinor({
        amountMinor: row.amountMinor,
        unit: row.intervalUnit as IntervalUnit,
        intervalCount: row.intervalCount,
      }),
    }));
    const monthlyRecurringByCurrency = groupByCurrency(monthlyEntries);
    const annualizedByCurrency = monthlyRecurringByCurrency.map((entry) => ({
      currency: entry.currency,
      amountMinor: entry.amountMinor * 12,
    }));

    /* ---------------- renewals in 7 / 30 / 90 days ---------------- */
    const renewalsIn = (days: number) =>
      billed
        .filter((row) => {
          if (!row.nextRenewalDate) return false;
          const delta = daysBetweenIso(today, row.nextRenewalDate);
          return delta >= 0 && delta <= days;
        })
        .map((row) => ({
          subscriptionId: row.id,
          name: row.name,
          date: row.nextRenewalDate!,
          amountMinor: row.amountMinor,
          currency: row.currency,
        }));

    /* ---------------- price increases ---------------- */
    // The most recent history row per subscription, keeping the ones that are a
    // genuine increase in the same currency. `selectDistinctOn` is used through
    // the query builder rather than `db.execute({ text, values })`, which is a
    // node-postgres-only shape and throws on the embedded PGlite driver.
    const latestPriceRows = await this.db
      .selectDistinctOn([subscriptionPriceHistory.subscriptionId], {
        subscriptionId: subscriptionPriceHistory.subscriptionId,
        subscriptionName: subscriptions.name,
        oldAmountMinor: subscriptionPriceHistory.oldAmountMinor,
        oldCurrency: subscriptionPriceHistory.oldCurrency,
        newAmountMinor: subscriptionPriceHistory.newAmountMinor,
        currency: subscriptionPriceHistory.currency,
        effectiveDate: subscriptionPriceHistory.effectiveDate,
        source: subscriptionPriceHistory.source,
      })
      .from(subscriptionPriceHistory)
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.id, subscriptionPriceHistory.subscriptionId),
          eq(subscriptions.organizationId, subscriptionPriceHistory.organizationId),
        ),
      )
      .where(
        and(
          eq(subscriptionPriceHistory.organizationId, organizationId),
          isNull(subscriptions.archivedAt),
        ),
      )
      .orderBy(
        subscriptionPriceHistory.subscriptionId,
        desc(subscriptionPriceHistory.effectiveDate),
        desc(subscriptionPriceHistory.createdAt),
        desc(subscriptionPriceHistory.id),
      );

    const priceIncreases = latestPriceRows
      .map((row) => {
        const delta = priceDelta({
          oldAmountMinor: row.oldAmountMinor,
          newAmountMinor: row.newAmountMinor,
          oldCurrency: row.oldCurrency,
          newCurrency: row.currency,
        });
        return {
          subscriptionId: row.subscriptionId,
          name: row.subscriptionName,
          previousAmountMinor: row.oldAmountMinor,
          amountMinor: row.newAmountMinor,
          currency: row.currency,
          effectiveDate: row.effectiveDate,
          changePercent: delta.changePercent,
          source: row.source as PriceSource,
        };
      })
      // A currency change alone is never reported as an increase, and an
      // opening price has no previous amount to compare against. `flatMap`
      // keeps the surviving rows narrowed to a real previous amount, so the
      // response type stays honest instead of `number | null`.
      .flatMap((row) =>
        row.previousAmountMinor !== null && row.changePercent !== null && row.changePercent > 0
          ? [{ ...row, previousAmountMinor: row.previousAmountMinor, changePercent: row.changePercent }]
          : [],
      )
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, 10);

    /* ---------------- trial expirations ---------------- */
    const trialExpirations = live
      .filter((row) => row.trialEndDate !== null && row.trialEndDate >= today)
      .sort((a, b) => (a.trialEndDate ?? '').localeCompare(b.trialEndDate ?? ''))
      .slice(0, 10)
      .map((row) => ({ subscriptionId: row.id, name: row.name, date: row.trialEndDate! }));

    /* ---------------- marked for review ---------------- */
    // The newest decision per subscription, via `DISTINCT ON`. The previous
    // `MAX(d2.id)` formulation is invalid SQL: PostgreSQL has no `max(uuid)`
    // aggregate. Ordering by uuid is supported, so `id DESC` is a safe tie
    // breaker.
    const reviewRows = (
      await this.db
        .selectDistinctOn([subscriptionDecisions.subscriptionId], {
          subscriptionId: subscriptionDecisions.subscriptionId,
          decision: subscriptionDecisions.decision,
          reason: subscriptionDecisions.reason,
          reviewOn: subscriptionDecisions.reviewOn,
          name: subscriptions.name,
          nextRenewalDate: subscriptions.nextRenewalDate,
        })
        .from(subscriptionDecisions)
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.id, subscriptionDecisions.subscriptionId),
            eq(subscriptions.organizationId, subscriptionDecisions.organizationId),
          ),
        )
        .where(
          and(
            eq(subscriptionDecisions.organizationId, organizationId),
            isNull(subscriptions.archivedAt),
            sql`${subscriptionDecisions.decision} in ('review', 'downgrade', 'cancel_planned')`,
          ),
        )
        .orderBy(
          subscriptionDecisions.subscriptionId,
          desc(subscriptionDecisions.recordedAt),
          desc(subscriptionDecisions.id),
        )
        .limit(25)
    ).sort((a, b) => a.nextRenewalDate.localeCompare(b.nextRenewalDate));

    /* ---------------- spend by category ---------------- */
    const categoryNames = await this.db
      .select({ id: categories.id, name: categories.name, colorToken: categories.colorToken })
      .from(categories)
      .where(eq(categories.organizationId, organizationId));

    const byCategory = new Map<string, Array<{ currency: string; amountMinor: number }>>();
    const uncategorized: Array<{ currency: string; amountMinor: number }> = [];
    for (const row of billed) {
      const entry = {
        currency: row.currency,
        amountMinor: monthlyEquivalentMinor({
          amountMinor: row.amountMinor,
          unit: row.intervalUnit as IntervalUnit,
          intervalCount: row.intervalCount,
        }),
      };
      const key = row.categoryId ?? '__none__';
      const list = byCategory.get(key) ?? [];
      list.push(entry);
      byCategory.set(key, list);
    }

    const spendByCategory = [
      ...categoryNames.map((category) => ({
        categoryId: category.id,
        categoryName: category.name,
        colorToken: category.colorToken as string | null,
        monthlyByCurrency: groupByCurrency(byCategory.get(category.id) ?? []),
      })),
      {
        categoryId: null,
        categoryName: 'Uncategorized',
        colorToken: null,
        monthlyByCurrency: groupByCurrency(uncategorized),
      },
    ]
      .filter((entry) => entry.monthlyByCurrency.length > 0)
      .sort((a, b) => {
        const aMax = a.monthlyByCurrency[0]?.amountMinor ?? 0;
        const bMax = b.monthlyByCurrency[0]?.amountMinor ?? 0;
        return bMax - aMax;
      });

    return {
      monthlyRecurringByCurrency,
      annualizedByCurrency,
      annualizedCaveat: ANNUALIZED_CAVEAT,
      activeCount: live.filter((row) => row.status === 'active').length,
      trialCount: live.filter((row) => row.status === 'trial').length,
      pausedCount: live.filter((row) => row.status === 'paused').length,
      cancelPlannedCount: live.filter((row) => row.status === 'cancel_planned').length,
      cancelledCount: live.filter((row) => row.status === 'cancelled').length,
      unassignedCount: live.filter((row) => row.categoryId === null).length,
      renewals: {
        next7Days: renewalsIn(7),
        next30Days: renewalsIn(30),
        next90Days: renewalsIn(90),
      },
      priceIncreases,
      trialExpirations,
      markedForReview: reviewRows.map((row) => ({
        subscriptionId: row.subscriptionId,
        name: row.name,
        nextRenewalDate: row.nextRenewalDate,
        decision: row.decision as Decision,
        reviewOn: row.reviewOn,
        reason: row.reason,
      })),
      spendByCategory,
      generatedAt: new Date().toISOString(),
      timezone: organization?.timezone ?? 'UTC',
      currencyGroupingNotice: CURRENCY_GROUPING_NOTICE,
    };
  }

  /**
   * Upcoming renewals for the reminder engine. Used by the scheduler so it only
   * sees records the user can also see.
   */
  async renewalsBetween(
    organizationId: string,
    from: string,
    to: string,
  ): Promise<Array<{ id: string; name: string; date: string; amountMinor: number; currency: string }>> {
    const rows = await this.db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        nextRenewalDate: subscriptions.nextRenewalDate,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          isNull(subscriptions.archivedAt),
          sql`${subscriptions.status} in ('active', 'trial', 'cancel_planned')`,
          sql`${subscriptions.nextRenewalDate} between ${from} and ${to}`,
        ),
      )
      .orderBy(asc(subscriptions.nextRenewalDate));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      date: row.nextRenewalDate,
      amountMinor: row.amountMinor,
      currency: row.currency,
    }));
  }

  /** Total monthly cost per currency for a filtered set (reports screen). */
  async monthlyTotalsByCurrency(organizationId: string): Promise<Array<{ currency: string; amountMinor: number }>> {
    const rows = await this.db
      .select({
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
          sql`${subscriptions.status} in ('active', 'trial', 'cancel_planned')`,
        ),
      );
    return groupByCurrency(
      rows.map((row) => ({
        currency: row.currency,
        amountMinor: monthlyEquivalentMinor({
          amountMinor: row.amountMinor,
          unit: row.intervalUnit as IntervalUnit,
          intervalCount: row.intervalCount,
        }),
      })),
    );
  }

  /** Full price-change log across the organization (price-history report). */
  async priceChangeLog(organizationId: string, limit = 100) {
    const rows = await this.db
      .select({
        subscriptionId: subscriptionPriceHistory.subscriptionId,
        subscriptionName: subscriptions.name,
        oldAmountMinor: subscriptionPriceHistory.oldAmountMinor,
        newAmountMinor: subscriptionPriceHistory.newAmountMinor,
        oldCurrency: subscriptionPriceHistory.oldCurrency,
        currency: subscriptionPriceHistory.currency,
        effectiveDate: subscriptionPriceHistory.effectiveDate,
        source: subscriptionPriceHistory.source,
        note: subscriptionPriceHistory.note,
      })
      .from(subscriptionPriceHistory)
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.id, subscriptionPriceHistory.subscriptionId),
          eq(subscriptions.organizationId, subscriptionPriceHistory.organizationId),
        ),
      )
      .where(
        and(
          eq(subscriptionPriceHistory.organizationId, organizationId),
          isNotNull(subscriptionPriceHistory.oldAmountMinor),
        ),
      )
      .orderBy(desc(subscriptionPriceHistory.effectiveDate), desc(subscriptionPriceHistory.createdAt))
      .limit(limit);

    return rows.map((row) => {
      const delta = priceDelta({
        oldAmountMinor: row.oldAmountMinor === null ? null : Number(row.oldAmountMinor),
        newAmountMinor: Number(row.newAmountMinor),
        oldCurrency: row.oldCurrency,
        newCurrency: row.currency,
      });
      return {
        subscriptionId: row.subscriptionId,
        subscriptionName: row.subscriptionName,
        effectiveDate: row.effectiveDate,
        source: row.source as PriceSource,
        note: row.note,
        changeMinor: delta.changeMinor,
        changePercent: delta.changePercent,
        direction: delta.direction,
        currencyChanged: delta.currencyChanged,
      };
    });
  }
}