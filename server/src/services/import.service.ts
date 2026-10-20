/**
 * CSV import (Part E / E3.9, E4 CSV import, E7).
 *
 * Flow: parse -> map columns -> preview (normalised + row-level errors +
 * duplicate suggestions) -> **explicit per-row user choice** -> commit in
 * batches.
 *
 * Rules enforced here:
 *  - file size and row limits are checked before anything is parsed;
 *  - an invalid row is never silently dropped: every one lands in
 *    `import_row_errors` and is returned to the user;
 *  - a likely duplicate (same vendor + name, or same vendor + amount + cadence)
 *    is *suggested*, never merged automatically - the user must choose create,
 *    skip or update for each duplicate row (Part E / E7);
 *  - importing creates the opening price-history row in the same transaction,
 *    with `source = 'csv_import'` so the chain stays honest.
 */

import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';

import type { ImportDuplicateChoice, ImportPreview, ImportResult, ImportRowPreview } from '@renewradar/shared';
import {
  INTERVAL_UNITS,
  MAX_IMPORT_ROWS,
  SUBSCRIPTION_STATUSES,
  parseCsv,
  parseToMinor,
  toCsv,
  type ImportColumn,
  type IntervalUnit,
  type SubscriptionStatus,
} from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { categories, importRowErrors, imports, subscriptionPriceHistory, subscriptions } from '../db/schema.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';

/** Accepted spellings for each logical column, matched case-insensitively. */
const HEADER_ALIASES: Record<ImportColumn, string[]> = {
  name: ['name', 'subscription', 'subscription name', 'title'],
  vendor_name: ['vendor', 'vendor name', 'provider', 'company'],
  plan_name: ['plan', 'plan name', 'tier'],
  category: ['category', 'category name'],
  amount: ['amount', 'price', 'cost', 'value'],
  currency: ['currency', 'ccy'],
  interval_unit: ['interval', 'interval unit', 'cadence', 'billing cycle', 'frequency'],
  interval_count: ['interval count', 'every', 'count'],
  start_date: ['start date', 'started', 'start', 'since'],
  next_renewal_date: ['next renewal', 'next renewal date', 'renews', 'renewal date', 'next billing date'],
  trial_end_date: ['trial end', 'trial end date', 'trial ends'],
  status: ['status', 'state'],
  payment_method_label: ['payment method', 'payment method label', 'card label', 'paying with'],
  notes: ['notes', 'note', 'comment', 'comments'],
};

const DATE_FORMATS = ['%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%d-%m-%Y', '%Y/%m/%d', '%d.%m.%Y', '%e %B %Y', '%B %e, %Y'];

export interface PreviewRequest {
  organizationId: string;
  actorUserId: string;
  filename: string;
  csv: string;
  mapping: Record<string, string>;
  requestId?: string | null;
}

export interface CommitRequest {
  organizationId: string;
  actorUserId: string;
  importId: string;
  rows: Array<{
    rowNumber: number;
    duplicateChoice: ImportDuplicateChoice | null;
    duplicateSubscriptionId?: string | null;
  }>;
  requestId?: string | null;
}

/** In-memory preview state. The persisted `imports` row is the source of truth
 * for the committed run; the preview itself is returned in the response. */
interface CachedPreview {
  organizationId: string;
  importId: string;
  filenameSafe: string;
  columns: string[];
  mapping: Record<string, string>;
  rows: ImportRowPreview[];
}

export class ImportService {
  private readonly cache = new Map<string, CachedPreview>();

  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async preview(input: PreviewRequest): Promise<ImportPreview> {
    const { header, rows } = parseCsv(input.csv);
    if (header.length === 0) throw badRequest('The CSV file has no header row.');
    if (rows.length > MAX_IMPORT_ROWS) {
      throw unprocessable(
        `This file has ${rows.length} rows. The limit is ${MAX_IMPORT_ROWS}; split the file and import it in parts.`,
      );
    }

    const mapping = this.resolveMapping(header, input.mapping);
    const categoryNames = await this.categoryIndex(input.organizationId);

    const previews: ImportRowPreview[] = [];
    for (const [index, raw] of rows.entries()) {
      // Row 1 is the header, so the first data row is line 2.
      const rowNumber = index + 2;
      const flat = header.reduce<Record<string, string>>((acc, column, columnIndex) => {
        acc[column] = (raw[columnIndex] ?? '').trim();
        return acc;
      }, {});
      previews.push(await this.previewRow(input.organizationId, rowNumber, flat, mapping, categoryNames));
    }

    const validRows = previews.filter((row) => row.errors.length === 0).length;
    const duplicateRows = previews.filter((row) => row.errors.length === 0 && row.duplicateOf !== null).length;
    const errorRows = previews.filter((row) => row.errors.length > 0).length;

    const created = await this.db
      .insert(imports)
      .values({
        organizationId: input.organizationId,
        uploadedBy: input.actorUserId,
        filenameSafe: safeFilename(input.filename),
        status: 'preview',
        columns: header,
        mapping,
        rowCounts: { total: previews.length, valid: validRows, duplicates: duplicateRows, invalid: errorRows },
      })
      .returning({ id: imports.id });

    const importId = created[0]!.id;

    // Persist every row error up front so the downloadable report is complete
    // even if the user never confirms the import.
    const errorRowsToStore = previews.flatMap((row) =>
      row.errors.map((error) => ({
        organizationId: input.organizationId,
        importId,
        rowNumber: row.rowNumber,
        errorCode: error.code,
        safeMessage: error.message,
        redactedRow: row.raw,
      })),
    );
    if (errorRowsToStore.length > 0) {
      await this.db.insert(importRowErrors).values(errorRowsToStore);
    }

    this.cache.set(importId, {
      organizationId: input.organizationId,
      importId,
      filenameSafe: safeFilename(input.filename),
      columns: header,
      mapping,
      rows: previews,
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'import.previewed',
      entityType: 'import',
      entityId: importId,
      metadata: { total: previews.length, valid: validRows, duplicates: duplicateRows, invalid: errorRows },
      requestId: input.requestId ?? null,
    });

    return {
      importId,
      filenameSafe: safeFilename(input.filename),
      status: 'preview',
      columns: header,
      mapping,
      rows: previews,
      totalRows: previews.length,
      validRows,
      duplicateRows,
      errorRows,
      committed: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  async get(organizationId: string, importId: string): Promise<ImportPreview> {
    const record = await this.requireImport(organizationId, importId);
    const errors = await this.db
      .select({
        rowNumber: importRowErrors.rowNumber,
        errorCode: importRowErrors.errorCode,
        safeMessage: importRowErrors.safeMessage,
      })
      .from(importRowErrors)
      .where(eq(importRowErrors.importId, importId));

    const cached = this.cache.get(importId);
    const byRow = new Map<number, Array<{ code: string; message: string }>>();
    for (const error of errors) {
      const list = byRow.get(error.rowNumber) ?? [];
      list.push({ code: error.errorCode, message: error.safeMessage });
      byRow.set(error.rowNumber, list);
    }

    const rows: ImportRowPreview[] = cached
      ? cached.rows.map((row) => ({ ...row, errors: byRow.get(row.rowNumber) ?? row.errors }))
      : [];

    return {
      importId,
      filenameSafe: record.filenameSafe,
      status: record.status as ImportPreview['status'],
      columns: record.columns ?? [],
      mapping: record.mapping ?? {},
      rows,
      totalRows: record.rowCounts?.total ?? 0,
      validRows: record.rowCounts?.valid ?? 0,
      duplicateRows: record.rowCounts?.duplicates ?? 0,
      errorRows: record.rowCounts?.invalid ?? 0,
      committed: record.status === 'completed' || record.status === 'confirmed',
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
    };
  }

  async list(organizationId: string, page: number, pageSize: number) {
    const rows = await this.db
      .select({
        id: imports.id,
        filenameSafe: imports.filenameSafe,
        status: imports.status,
        rowCounts: imports.rowCounts,
        createdAt: imports.createdAt,
        completedAt: imports.completedAt,
      })
      .from(imports)
      .where(eq(imports.organizationId, organizationId))
      .orderBy(sql`${imports.createdAt} desc`)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const countRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(imports)
      .where(eq(imports.organizationId, organizationId));

    const total = countRows[0]?.total ?? 0;
    return {
      items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** Row-level error report as CSV, so the user can fix the source file. */
  async errorReport(organizationId: string, importId: string): Promise<string> {
    await this.requireImport(organizationId, importId);
    const errors = await this.db
      .select({
        rowNumber: importRowErrors.rowNumber,
        errorCode: importRowErrors.errorCode,
        safeMessage: importRowErrors.safeMessage,
        redactedRow: importRowErrors.redactedRow,
      })
      .from(importRowErrors)
      .where(eq(importRowErrors.importId, importId))
      .orderBy(importRowErrors.rowNumber);

    // `toCsv` escapes formula-leading characters, so a malicious cell in the
    // uploaded file cannot become a formula in the downloaded report.
    return toCsv(
      errors.map((row) => [
        row.rowNumber,
        row.errorCode,
        row.safeMessage,
        JSON.stringify(row.redactedRow ?? {}),
      ]),
      ['row_number', 'error_code', 'safe_message', 'row_data'],
    );
  }

  async commit(input: CommitRequest): Promise<ImportResult> {
    const record = await this.requireImport(input.organizationId, input.importId);
    if (record.status === 'completed') {
      throw unprocessable('This import has already been confirmed. Preview it again to import more rows.');
    }
    const cached = this.cache.get(input.importId);
    if (!cached || cached.organizationId !== input.organizationId) {
      throw unprocessable('This import preview is no longer available. Upload the file again.');
    }

    const choices = new Map(input.rows.map((row) => [row.rowNumber, row]));
    const errors: ImportResult['errors'] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    const storedErrors = await this.db
      .select({ rowNumber: importRowErrors.rowNumber })
      .from(importRowErrors)
      .where(eq(importRowErrors.importId, input.importId));
    const invalidRows = new Set(storedErrors.map((row) => row.rowNumber));

    for (const row of cached.rows) {
      // An invalid row can never be imported; the error was already persisted.
      if (row.errors.length > 0 || invalidRows.has(row.rowNumber)) {
        failed += 1;
        for (const error of row.errors) {
          errors.push({ rowNumber: row.rowNumber, code: error.code, message: error.message });
        }
        continue;
      }

      const choice = choices.get(row.rowNumber);
      const resolvedChoice = choice?.duplicateChoice ?? null;

      if (row.duplicateOf && !resolvedChoice) {
        // The user must decide. Nothing is merged automatically.
        failed += 1;
        errors.push({
          rowNumber: row.rowNumber,
          code: 'duplicate_choice_required',
          message: `Row looks like the existing subscription "${row.duplicateOf.name}". Choose create, skip or update.`,
        });
        continue;
      }
      if (row.duplicateOf && resolvedChoice === 'skip') {
        skipped += 1;
        continue;
      }
      if (!row.normalized?.nextRenewalDate) {
        failed += 1;
        errors.push({ rowNumber: row.rowNumber, code: 'unparsable', message: 'The row could not be read.' });
        continue;
      }

      // The mapping captured at preview time is the one the user confirmed, so
      // the write phase reads exactly the columns they were shown.
      const columnValue = (column: ImportColumn): string => {
        const header = cached.mapping[column];
        if (!header || header === 'ignore') return '';
        return (row.raw[header] ?? '').trim();
      };

      const categoryId = await this.categoryIdFor(input.organizationId, columnValue('category'));
      const values = {
        name: row.normalized.name,
        vendorName: row.normalized.vendorName,
        planName: columnValue('plan_name') || null,
        categoryId,
        amountMinor: row.normalized.amountMinor,
        currency: row.normalized.currency,
        intervalUnit: row.normalized.unit,
        intervalCount: row.normalized.intervalCount,
        startDate: row.normalized.nextRenewalDate,
        nextRenewalDate: row.normalized.nextRenewalDate,
        trialEndDate: normalizeDate(columnValue('trial_end_date')),
        status: columnValue('status').toLowerCase() as SubscriptionStatus,
        paymentMethodLabel: columnValue('payment_method_label') || null,
        notes: columnValue('notes') || null,
      };

      try {
        if (row.duplicateOf && resolvedChoice === 'update') {
          const target = choice?.duplicateSubscriptionId ?? row.duplicateOf.subscriptionId;
          const existing = await this.db
            .select({ id: subscriptions.id, amountMinor: subscriptions.amountMinor, currency: subscriptions.currency, name: subscriptions.name })
            .from(subscriptions)
            .where(and(eq(subscriptions.id, target), eq(subscriptions.organizationId, input.organizationId)))
            .limit(1);
          if (!existing[0]) {
            failed += 1;
            errors.push({
              rowNumber: row.rowNumber,
              code: 'not_found',
              message: 'The subscription chosen for this update no longer exists.',
            });
            continue;
          }
          await this.db.transaction(async (tx) => {
            await tx
              .update(subscriptions)
              .set({
                amountMinor: values.amountMinor,
                currency: values.currency,
                intervalUnit: values.intervalUnit,
                intervalCount: values.intervalCount,
                nextRenewalDate: values.nextRenewalDate,
                categoryId: values.categoryId,
                notes: values.notes,
                updatedAt: new Date(),
              })
              .where(eq(subscriptions.id, existing[0]!.id));
            await tx.insert(subscriptionPriceHistory).values({
              organizationId: input.organizationId,
              subscriptionId: existing[0]!.id,
              oldAmountMinor: existing[0]!.amountMinor,
              oldCurrency: existing[0]!.currency,
              newAmountMinor: values.amountMinor,
              currency: values.currency,
              effectiveDate: values.nextRenewalDate,
              source: 'csv_import',
              changedBy: input.actorUserId,
              note: `Updated from ${cached.filenameSafe} (row ${row.rowNumber})`,
            });
          });
          updated += 1;
        } else {
          await this.db.transaction(async (tx) => {
            const inserted = await tx
              .insert(subscriptions)
              .values({
                organizationId: input.organizationId,
                name: values.name,
                vendorName: values.vendorName,
                planName: values.planName,
                categoryId: values.categoryId,
                amountMinor: values.amountMinor,
                currency: values.currency,
                intervalUnit: values.intervalUnit,
                intervalCount: values.intervalCount,
                startDate: values.startDate,
                nextRenewalDate: values.nextRenewalDate,
                trialEndDate: values.trialEndDate,
                renewalType: 'auto',
                status: SUBSCRIPTION_STATUSES.includes(values.status) ? values.status : 'active',
                paymentMethodLabel: values.paymentMethodLabel,
                notes: values.notes,
                personalOrBusiness: 'business',
                createdBy: input.actorUserId,
              })
              .returning({ id: subscriptions.id });
            await tx.insert(subscriptionPriceHistory).values({
              organizationId: input.organizationId,
              subscriptionId: inserted[0]!.id,
              oldAmountMinor: null,
              oldCurrency: null,
              newAmountMinor: values.amountMinor,
              currency: values.currency,
              effectiveDate: values.startDate,
              source: 'csv_import',
              changedBy: input.actorUserId,
              note: `Imported from ${cached.filenameSafe} (row ${row.rowNumber})`,
            });
          });
          created += 1;
        }
      } catch (error) {
        failed += 1;
        errors.push({
          rowNumber: row.rowNumber,
          code: 'write_failed',
          message: error instanceof Error ? error.message.slice(0, 200) : 'The row could not be saved.',
        });
      }
    }

    await this.db
      .update(imports)
      .set({ status: failed > 0 && created + updated + skipped === 0 ? 'failed' : 'completed', completedAt: new Date() })
      .where(eq(imports.id, input.importId));

    // Any row error discovered during the write phase is persisted too.
    const extra = errors
      .filter((error) => !storedErrors.some((stored) => stored.rowNumber === error.rowNumber))
      .map((error) => ({
        organizationId: input.organizationId,
        importId: input.importId,
        rowNumber: error.rowNumber,
        errorCode: error.code,
        safeMessage: error.message,
        redactedRow: cached.rows.find((row) => row.rowNumber === error.rowNumber)?.raw ?? {},
      }));
    if (extra.length > 0) await this.db.insert(importRowErrors).values(extra);

    this.cache.delete(input.importId);

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'import.committed',
      entityType: 'import',
      entityId: input.importId,
      metadata: { created, updated, skipped, failed },
      requestId: input.requestId ?? null,
    });

    return {
      importId: input.importId,
      status: failed > 0 && created + updated + skipped === 0 ? 'failed' : 'completed',
      created,
      updated,
      skipped,
      failed,
      errors,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async previewRow(
    organizationId: string,
    rowNumber: number,
    raw: Record<string, string>,
    mapping: Record<string, string>,
    categoryIndex: Map<string, string>,
  ): Promise<ImportRowPreview> {
    const errors: ImportRowPreview['errors'] = [];
    const warnings: ImportRowPreview['warnings'] = [];

    const value = (column: ImportColumn): string => {
      const header = mapping[column];
      if (!header || header === 'ignore') return '';
      return (raw[header] ?? '').trim();
    };

    const name = value('name') || value('vendor_name');
    const vendorName = value('vendor_name') || name;
    const amountText = value('amount');
    const currencyText = (value('currency') || 'USD').toUpperCase();
    const unit = normalizeUnit(value('interval_unit'));
    const intervalCountText = value('interval_count');
    const intervalCount = intervalCountText === '' ? 1 : Number(intervalCountText);
    const nextRenewal = normalizeDate(value('next_renewal_date')) ?? normalizeDate(value('start_date'));
    const statusText = value('status').toLowerCase();

    if (!name) errors.push({ code: 'missing_name', message: 'A subscription name or vendor is required.' });

    const amountMinor = amountText === '' ? null : parseToMinor(amountText, currencyText || 'USD');
    if (amountText !== '' && amountMinor === null) {
      errors.push({ code: 'invalid_amount', message: `"${amountText}" is not a valid amount.` });
    } else if (amountMinor !== null && amountMinor <= 0) {
      errors.push({ code: 'invalid_amount', message: 'The amount must be greater than zero.' });
    }
    if (!/^[A-Z]{3}$/.test(currencyText)) {
      errors.push({ code: 'invalid_currency', message: `"${currencyText}" is not a 3-letter currency code.` });
    }
    if (value('interval_unit') !== '' && unit === null) {
      errors.push({
        code: 'invalid_interval',
        message: `"${value('interval_unit')}" is not a supported cadence (weekly, monthly, quarterly, yearly or custom).`,
      });
    }
    if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 1000) {
      errors.push({ code: 'invalid_interval_count', message: 'The interval count must be a whole number from 1 to 1000.' });
    }
    if (value('next_renewal_date') !== '' && !nextRenewal) {
      errors.push({
        code: 'invalid_date',
        message: `"${value('next_renewal_date')}" is not a date RenewRadar can read. Use YYYY-MM-DD.`,
      });
    } else if (!nextRenewal && value('start_date') !== '') {
      errors.push({
        code: 'invalid_date',
        message: `"${value('start_date')}" is not a date RenewRadar can read. Use YYYY-MM-DD.`,
      });
    }
    if (!nextRenewal) {
      errors.push({ code: 'missing_renewal_date', message: 'A next renewal date (or a start date) is required.' });
    }
    if (statusText !== '' && !SUBSCRIPTION_STATUSES.includes(statusText as SubscriptionStatus)) {
      warnings.push({ code: 'unknown_status', message: `Unknown status "${statusText}"; imported as active.` });
    }
    const categoryText = value('category');
    if (categoryText && !categoryIndex.has(categoryText.toLowerCase())) {
      warnings.push({
        code: 'unknown_category',
        message: `No category named "${categoryText}" exists yet; the subscription will be uncategorised.`,
      });
    }

    const normalized =
      errors.length === 0 && amountMinor !== null && nextRenewal && unit
        ? {
            name,
            vendorName,
            amountMinor,
            currency: currencyText,
            unit,
            intervalCount,
            nextRenewalDate: nextRenewal,
          }
        : null;

    const duplicateOf = normalized ? await this.findDuplicate(organizationId, normalized) : null;
    if (duplicateOf) {
      warnings.push({
        code: 'possible_duplicate',
        message: `Looks like the existing subscription "${duplicateOf.name}". Choose what to do with this row.`,
      });
    }

    return {
      rowNumber,
      raw,
      normalized,
      errors,
      warnings,
      duplicateOf,
      duplicateChoice: null,
    };
  }

  /**
   * Duplicate detection is a *suggestion*, never an automatic merge.
   * A match on vendor + name is a strong hint; vendor + amount + cadence is a
   * weaker one that is still surfaced so the user decides.
   */
  private async findDuplicate(
    organizationId: string,
    normalized: {
      name: string;
      vendorName: string;
      amountMinor: number;
      unit: IntervalUnit;
      intervalCount: number;
    },
  ): Promise<{ subscriptionId: string; name: string; reason: string } | null> {
    const exact = await this.db
      .select({ id: subscriptions.id, name: subscriptions.name, amountMinor: subscriptions.amountMinor })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          isNull(subscriptions.archivedAt),
          ilike(subscriptions.name, normalized.name),
          or(
            ilike(subscriptions.vendorName, normalized.vendorName),
            sql`${subscriptions.name} ilike ${normalized.vendorName}`,
          ),
        ),
      )
      .limit(1);
    if (exact[0]) {
      const sameAmount = exact[0].amountMinor === normalized.amountMinor;
      return {
        subscriptionId: exact[0].id,
        name: exact[0].name,
        reason: sameAmount
          ? 'Same name, vendor and amount already exist'
          : 'Same name and vendor already exist with a different amount',
      };
    }

    const similar = await this.db
      .select({ id: subscriptions.id, name: subscriptions.name })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          isNull(subscriptions.archivedAt),
          eq(subscriptions.amountMinor, normalized.amountMinor),
          eq(subscriptions.intervalUnit, normalized.unit),
          eq(subscriptions.intervalCount, normalized.intervalCount),
          ilike(subscriptions.vendorName, normalized.vendorName),
        ),
      )
      .limit(1);
    if (similar[0]) {
      return {
        subscriptionId: similar[0].id,
        name: similar[0].name,
        reason: 'Same vendor, amount and cadence already exist under a different name',
      };
    }
    return null;
  }

  private async categoryIndex(organizationId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.organizationId, organizationId));
    return new Map(rows.map((row) => [row.name.trim().toLowerCase(), row.id]));
  }

  private async categoryIdFor(organizationId: string, name: string): Promise<string | null> {
    if (!name.trim()) return null;
    const rows = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.organizationId, organizationId), eq(categories.name, name.trim())))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private resolveMapping(header: string[], supplied: Record<string, string>): Record<string, string> {
    const normalisedHeader = new Map(header.map((column) => [column.trim().toLowerCase(), column]));
    const mapping: Record<string, string> = {};

    for (const column of Object.keys(HEADER_ALIASES) as ImportColumn[]) {
      const explicit = supplied[column];
      if (explicit && explicit !== 'ignore' && header.includes(explicit)) {
        mapping[column] = explicit;
        continue;
      }
      const alias = HEADER_ALIASES[column].find((candidate) => normalisedHeader.has(candidate));
      mapping[column] = alias ? (normalisedHeader.get(alias) as string) : 'ignore';
    }
    // Unknown headers are preserved so the raw row stays readable.
    for (const column of header) {
      if (!Object.values(mapping).includes(column) && !supplied[column]) mapping[column] = 'ignore';
    }
    return mapping;
  }

  private async requireImport(organizationId: string, importId: string) {
    const rows = await this.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, importId), eq(imports.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Import');
    return row;
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Strips any directory component and unsafe characters from a file name. */
export function safeFilename(value: string): string {
  return (
    value
      .split(/[\\/]/)
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'import.csv'
  );
}

export function normalizeUnit(value: string): IntervalUnit | null {
  const text = value.trim().toLowerCase();
  if (text === '') return 'monthly';
  if ((INTERVAL_UNITS as readonly string[]).includes(text)) return text as IntervalUnit;
  const aliases: Record<string, IntervalUnit> = {
    week: 'weekly',
    'per week': 'weekly',
    monthly: 'monthly',
    month: 'monthly',
    'per month': 'monthly',
    quarter: 'quarterly',
    quarterly: 'quarterly',
    'per quarter': 'quarterly',
    year: 'yearly',
    yearly: 'yearly',
    annually: 'yearly',
    annual: 'yearly',
    'per year': 'yearly',
    custom: 'custom',
    days: 'custom',
    daily: 'custom',
  };
  return aliases[text] ?? null;
}

/** Accepts ISO and a handful of unambiguous regional formats. */
export function normalizeDate(value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
  }
  for (const format of DATE_FORMATS) {
    // A numeric-only format is ambiguous across locales, so it is only used when
    // the day is > 12 (unambiguous) or the format is unambiguous.
    const candidate = tryParse(text, format);
    if (candidate) return candidate;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function tryParse(value: string, format: string): string | null {
  // `Date` has no strptime; a small table covers the formats listed above.
  const numeric = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec(value);
  if (!numeric) return null;
  const [, a = '', b = '', c = ''] = numeric;
  const parts = format.includes('%Y') ? [a, b, c] : format.startsWith('%d') ? [c, b, a] : [c, a, b];
  const year = Number(parts[0]?.length === 2 ? `20${parts[0]}` : parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checked = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(checked.getTime()) || checked.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}