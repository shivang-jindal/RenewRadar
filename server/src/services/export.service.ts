/**
 * CSV export (Part E / E3.9).
 *
 * Two safety properties are enforced by `toCsv` in the shared module:
 *  - any cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with a
 *    single quote, so a subscription named `=HYPERLINK(...)` cannot execute as
 *    a formula when the file is opened in a spreadsheet
 *    (Part A / A4.6, Part E / E7);
 *  - amounts are written as major-unit decimal strings in their own currency
 *    and a `currency` column is always present, so a reader never has to guess
 *    or sum across currencies.
 *
 * Exports are permission-checked by the route and recorded in the audit trail.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { ExportDataset } from '@renewradar/shared';
import {
  INTERVAL_UNIT_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  formatMinorAsDecimal,
  priceDelta,
  toCsv,
  type IntervalUnit,
  type PriceSource,
  type SubscriptionStatus,
} from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { categories, subscriptionPriceHistory, subscriptions, users } from '../db/schema.js';
import type { AuditService } from './audit.service.js';

export interface ExportFilters {
  status?: string;
  categoryId?: string;
  currency?: string;
}

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string;
  rowCount: number;
}

export const EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';

export class ExportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async run(input: {
    organizationId: string;
    actorUserId: string;
    organizationName: string;
    dataset: ExportDataset;
    filters: ExportFilters;
    requestId?: string | null;
  }): Promise<ExportResult> {
    const result =
      input.dataset === 'subscriptions'
        ? await this.subscriptionsCsv(input.organizationId, input.filters)
        : await this.priceHistoryCsv(input.organizationId, input.filters);

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'data.exported',
      entityType: 'export',
      entityId: input.dataset,
      metadata: { dataset: input.dataset, rowCount: result.rowCount, filters: input.filters },
      requestId: input.requestId ?? null,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const slug = input.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      ...result,
      filename: `renewradar-${input.dataset}-${slug}-${stamp}.csv`,
      contentType: EXPORT_CONTENT_TYPE,
    };
  }

  private async subscriptionsCsv(organizationId: string, filters: ExportFilters): Promise<Omit<ExportResult, 'filename' | 'contentType'>> {
    const conditions = [eq(subscriptions.organizationId, organizationId)];
    // Archived rows are excluded by default so an export matches what the user
    // sees in the active list.
    conditions.push(isNull(subscriptions.archivedAt));
    if (filters.status && filters.status !== 'all') conditions.push(eq(subscriptions.status, filters.status));
    if (filters.categoryId) conditions.push(eq(subscriptions.categoryId, filters.categoryId));
    if (filters.currency) conditions.push(eq(subscriptions.currency, filters.currency));

    const rows = await this.db
      .select({
        name: subscriptions.name,
        vendorName: subscriptions.vendorName,
        planName: subscriptions.planName,
        categoryName: categories.name,
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
        paymentMethodLabel: subscriptions.paymentMethodLabel,
        personalOrBusiness: subscriptions.personalOrBusiness,
        ownerName: users.displayName,
        vendorUrl: subscriptions.vendorUrl,
        notes: subscriptions.notes,
        createdAt: subscriptions.createdAt,
      })
      .from(subscriptions)
      .leftJoin(categories, eq(categories.id, subscriptions.categoryId))
      .leftJoin(users, eq(users.id, subscriptions.ownerUserId))
      .where(and(...conditions))
      .orderBy(asc(subscriptions.nextRenewalDate), asc(subscriptions.name));

    const body = toCsv(
      rows.map((row) => [
        row.name,
        row.vendorName,
        row.planName ?? '',
        row.categoryName ?? '',
        // Major-unit decimal, never a float and never mixed with another row's
        // currency.
        formatMinorAsDecimal(row.amountMinor, row.currency),
        row.currency,
        INTERVAL_UNIT_LABELS[row.intervalUnit as IntervalUnit] ?? row.intervalUnit,
        row.intervalCount,
        row.startDate,
        row.nextRenewalDate,
        row.trialEndDate ?? '',
        row.cancellationDeadline ?? '',
        row.renewalType,
        SUBSCRIPTION_STATUS_LABELS[row.status as SubscriptionStatus] ?? row.status,
        row.paymentMethodLabel ?? '',
        row.personalOrBusiness,
        row.ownerName ?? '',
        row.vendorUrl ?? '',
        row.notes ?? '',
        row.createdAt.toISOString(),
      ]),
      [
        'name',
        'vendor',
        'plan',
        'category',
        'amount',
        'currency',
        'billing_cadence',
        'interval_count',
        'start_date',
        'next_renewal_date',
        'trial_end_date',
        'cancellation_deadline',
        'renewal_type',
        'status',
        'payment_method_label',
        'business_or_personal',
        'owner',
        'vendor_url',
        'notes',
        'created_at',
      ],
    );

    return { body, rowCount: rows.length };
  }

  private async priceHistoryCsv(organizationId: string, filters: ExportFilters): Promise<Omit<ExportResult, 'filename' | 'contentType'>> {
    const conditions = [eq(subscriptionPriceHistory.organizationId, organizationId)];
    if (filters.categoryId) {
      conditions.push(eq(subscriptions.categoryId, filters.categoryId));
    }
    if (filters.currency) conditions.push(eq(subscriptionPriceHistory.currency, filters.currency));
    if (filters.status && filters.status !== 'all') conditions.push(eq(subscriptions.status, filters.status));

    const rows = await this.db
      .select({
        subscriptionName: subscriptions.name,
        vendorName: subscriptions.vendorName,
        oldAmountMinor: subscriptionPriceHistory.oldAmountMinor,
        oldCurrency: subscriptionPriceHistory.oldCurrency,
        newAmountMinor: subscriptionPriceHistory.newAmountMinor,
        currency: subscriptionPriceHistory.currency,
        effectiveDate: subscriptionPriceHistory.effectiveDate,
        source: subscriptionPriceHistory.source,
        note: subscriptionPriceHistory.note,
        changedByName: users.displayName,
      })
      .from(subscriptionPriceHistory)
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.id, subscriptionPriceHistory.subscriptionId),
          eq(subscriptions.organizationId, subscriptionPriceHistory.organizationId),
        ),
      )
      .leftJoin(users, eq(users.id, subscriptionPriceHistory.changedBy))
      .where(and(...conditions))
      .orderBy(desc(subscriptionPriceHistory.effectiveDate), desc(subscriptionPriceHistory.createdAt));

    const body = toCsv(
      rows.map((row) => {
        const delta = priceDelta({
          oldAmountMinor: row.oldAmountMinor === null ? null : Number(row.oldAmountMinor),
          newAmountMinor: Number(row.newAmountMinor),
          oldCurrency: row.oldCurrency,
          newCurrency: row.currency,
        });
        return [
          row.subscriptionName,
          row.vendorName,
          row.oldAmountMinor === null ? '' : formatMinorAsDecimal(Number(row.oldAmountMinor), row.oldCurrency ?? row.currency),
          row.oldCurrency ?? '',
          formatMinorAsDecimal(Number(row.newAmountMinor), row.currency),
          row.currency,
          delta.changeMinor === 0 ? '0' : (delta.changeMinor > 0 ? '+' : '') + formatMinorAsDecimal(delta.changeMinor, row.currency),
          delta.changePercent === null ? '' : String(delta.changePercent),
          // A currency-only change is explicitly labelled, never as a rise.
          delta.currencyChanged ? 'currency_changed' : delta.direction,
          row.effectiveDate,
          row.source as PriceSource,
          row.note ?? '',
          row.changedByName ?? '',
        ];
      }),
      [
        'subscription',
        'vendor',
        'previous_amount',
        'previous_currency',
        'new_amount',
        'currency',
        'change',
        'change_percent',
        'direction',
        'effective_date',
        'source',
        'note',
        'changed_by',
      ],
    );

    return { body, rowCount: rows.length };
  }

  async rowCount(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(and(eq(subscriptions.organizationId, organizationId), isNull(subscriptions.archivedAt)));
    return rows[0]?.total ?? 0;
  }
}