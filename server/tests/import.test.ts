/**
 * CSV import (Part E / E3.9, E4 CSV import, E7).
 *
 * Nothing is silently dropped: every invalid row is reported, every likely
 * duplicate demands an explicit user choice, and a preview never writes a
 * subscription.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCsv } from '@renewradar/shared';

import { normalizeDate, normalizeUnit, safeFilename } from '../src/services/import.service.js';
import { createTestContext, seedTenant, type SeededTenant, type TestContext } from './harness.js';

let context: TestContext;
let tenant: SeededTenant;
let organizationId: string;
let categoryId: string;

beforeAll(async () => {
  context = await createTestContext();
  tenant = await seedTenant(context, {
    email: 'imports@test.local',
    organizationName: 'Import Workspace',
    timezone: 'UTC',
  });
  organizationId = tenant.organization.id;
  const category = await context.services.categories.create(
    tenant.organization.id,
    tenant.user.id,
    { name: 'Imported Tools', colorToken: 'teal' },
  );
  categoryId = category.id;
});

afterAll(async () => {
  await context.close();
});

function previewCsv(csv: string, filename = 'subscriptions.csv') {
  return context.services.imports.preview({
    organizationId,
    actorUserId: tenant.user.id,
    filename,
    csv,
    mapping: {},
  });
}

async function listNames(): Promise<string[]> {
  const list = await context.services.subscriptions.list(
    organizationId,
    { page: 1, pageSize: 100, view: 'all', sort: 'name', order: 'asc' },
    new Date().toISOString().slice(0, 10),
  );
  return list.items.map((item) => item.name);
}

const HEADER = 'name,vendor,amount,currency,billing cycle,next renewal';

describe('column mapping', () => {
  it('recognises common header spellings', async () => {
    const preview = await previewCsv(
      `${HEADER}\nFigma,Figma Inc,12.00,USD,monthly,2026-01-15\n`,
    );
    expect(preview.mapping.name).toBe('name');
    expect(preview.mapping.amount).toBe('amount');
    expect(preview.mapping.currency).toBe('currency');
    expect(preview.mapping.interval_unit).toBe('billing cycle');
    expect(preview.mapping.next_renewal_date).toBe('next renewal');
  });

  it('normalises a row into integer minor units and an explicit currency', async () => {
    const preview = await previewCsv(
      `${HEADER}\nFigma,Figma Inc,12.00,USD,monthly,2026-01-15\n` +
        'Hetzner,Hetzner,4.99,EUR,per month,2026-02-01\n',
    );
    expect(preview.totalRows).toBe(2);
    expect(preview.errorRows).toBe(0);
    expect(preview.rows[0]!.normalized).toMatchObject({
      name: 'Figma',
      vendorName: 'Figma Inc',
      amountMinor: 1200,
      currency: 'USD',
      unit: 'monthly',
      intervalCount: 1,
      nextRenewalDate: '2026-01-15',
    });
    expect(preview.rows[1]!.normalized).toMatchObject({
      amountMinor: 499,
      currency: 'EUR',
      nextRenewalDate: '2026-02-01',
    });
  });

  it('normalises cadence aliases and rejects unknown ones', () => {
    expect(normalizeUnit('per month')).toBe('monthly');
    expect(normalizeUnit('annually')).toBe('yearly');
    expect(normalizeUnit('')).toBe('monthly');
    expect(normalizeUnit('fortnightly')).toBeNull();
  });

  it('normalises dates, and refuses a date that does not exist', () => {
    expect(normalizeDate('2026-01-15')).toBe('2026-01-15');
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate('')).toBeNull();
  });

  it('refuses an ambiguous regional date rather than guessing a day or month', () => {
    // Both `15/01/2026` and `01/15/2026` are read as year/month/day, so the
    // first one does not exist and the second is only correct by coincidence.
    // Either way the row is reported instead of silently shifted.
    expect(normalizeDate('15/01/2026')).toBeNull();
    expect(normalizeDate('25/12/2026')).toBeNull();
  });

  it('strips any directory component from an uploaded file name', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\my file.csv')).toBe('my_file.csv');
    expect(safeFilename('')).toBe('import.csv');
  });
});

describe('a preview never writes anything', () => {
  it('creates the import record but no subscription', async () => {
    const before = await listNames();
    const preview = await previewCsv(`${HEADER}\nPreview Only,Vendor,9.99,USD,monthly,2026-03-01\n`);

    expect(preview.committed).toBe(false);
    expect(preview.status).toBe('preview');
    expect(await listNames()).toEqual(before);

    const listed = await context.services.imports.list(organizationId, 1, 50);
    expect(listed.items.some((item) => item.id === preview.importId)).toBe(true);
  });

  it('refuses an empty file with no header', async () => {
    await expect(previewCsv('')).rejects.toThrow(/no header row/i);
  });

  it('refuses a file with more rows than the documented limit', async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => `Row ${index},Vendor,1.00,USD,monthly,2026-01-01`);
    await expect(previewCsv(`${HEADER}\n${rows.join('\n')}`)).rejects.toThrow(/limit is 2000/i);
  });
});

describe('every invalid row is reported, never silently dropped', () => {
  it('reports each problem with a row number and a reason', async () => {
    const preview = await previewCsv(
      `${HEADER}\n` +
        'Good Row,Vendor,10.00,USD,monthly,2026-04-01\n' +
        ',,10.00,USD,monthly,2026-04-01\n' +
        'Bad Amount,Vendor,ten dollars,USD,monthly,2026-04-01\n' +
        'Zero Amount,Vendor,0.00,USD,monthly,2026-04-01\n' +
        'Bad Currency,Vendor,10.00,DOLLARS,monthly,2026-04-01\n' +
        'Bad Cadence,Vendor,10.00,USD,fortnightly,2026-04-01\n' +
        'Bad Date,Vendor,10.00,USD,monthly,2026-02-30\n' +
        'No Date,Vendor,10.00,USD,monthly,\n',
    );

    expect(preview.totalRows).toBe(8);
    expect(preview.validRows).toBe(1);
    expect(preview.errorRows).toBe(7);

    const byRow = new Map(preview.rows.map((row) => [row.rowNumber, row]));
    // Row 1 is the header, so the first data row is line 2.
    expect(byRow.get(2)!.errors).toHaveLength(0);
    expect(byRow.get(3)!.errors.map((error) => error.code)).toContain('missing_name');
    expect(byRow.get(4)!.errors.map((error) => error.code)).toContain('invalid_amount');
    expect(byRow.get(5)!.errors.map((error) => error.code)).toContain('invalid_amount');
    expect(byRow.get(6)!.errors.map((error) => error.code)).toContain('invalid_currency');
    expect(byRow.get(7)!.errors.map((error) => error.code)).toContain('invalid_interval');
    expect(byRow.get(8)!.errors.map((error) => error.code)).toContain('invalid_date');
    expect(byRow.get(9)!.errors.map((error) => error.code)).toContain('missing_renewal_date');

    // Every invalid row carries no normalized payload, so it cannot be written.
    for (const row of preview.rows) {
      if (row.errors.length > 0) expect(row.normalized).toBeNull();
    }
  });

  it('persists the errors so the downloadable report is complete', async () => {
    const preview = await previewCsv(`${HEADER}\nBad Row,Vendor,ten dollars,USD,monthly,2026-05-01\n`);
    const report = await context.services.imports.errorReport(organizationId, preview.importId);
    const { header, rows } = parseCsv(report);
    expect(header).toEqual(['row_number', 'error_code', 'safe_message', 'row_data']);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe('2');
    expect(rows[0]![1]).toBe('invalid_amount');
    expect(rows[0]![2]).toMatch(/not a valid amount/i);
  });

  it('never imports a row that failed validation, and says so in the result', async () => {
    const preview = await previewCsv(
      `${HEADER}\nImported Fine,Vendor,10.00,USD,monthly,2026-06-01\n` +
        'Rejected Row,Vendor,-5.00,USD,monthly,2026-06-01\n',
    );
    const result = await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [],
    });

    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors.map((error) => error.rowNumber)).toEqual([3]);
    expect(await listNames()).toContain('Imported Fine');
    expect(await listNames()).not.toContain('Rejected Row');
  });
});

describe('duplicates are suggested, never merged', () => {
  let existingId: string;

  beforeAll(async () => {
    const created = await context.services.subscriptions.create(
      organizationId,
      tenant.user.id,
      {
        name: 'Existing Tool',
        vendorName: 'Existing Vendor',
        amountMinor: 4500,
        currency: 'USD',
        intervalUnit: 'monthly',
        intervalCount: 1,
        startDate: '2026-01-01',
        nextRenewalDate: '2026-08-01',
        renewalType: 'auto',
        status: 'active',
        personalOrBusiness: 'business',
      },
    );
    existingId = created.id;
  });

  it('flags a likely duplicate with the existing record it resembles', async () => {
    const preview = await previewCsv(
      `${HEADER}\nExisting Tool,Existing Vendor,45.00,USD,monthly,2026-08-01\n`,
    );
    expect(preview.duplicateRows).toBe(1);
    const row = preview.rows[0]!;
    expect(row.duplicateOf?.subscriptionId).toBe(existingId);
    expect(row.warnings.map((warning) => warning.code)).toContain('possible_duplicate');
    expect(row.errors).toHaveLength(0);
  });

  it('refuses to import a duplicate row until the user chooses', async () => {
    const preview = await previewCsv(
      `${HEADER}\nExisting Tool,Existing Vendor,45.00,USD,monthly,2026-08-01\n`,
    );
    const result = await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [{ rowNumber: 2, duplicateChoice: null }],
    });

    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.code).toBe('duplicate_choice_required');
    // Nothing was created behind the user's back.
    const names = await listNames();
    expect(names.filter((name) => name === 'Existing Tool')).toHaveLength(1);
  });

  it('honours an explicit "skip" choice', async () => {
    const preview = await previewCsv(
      `${HEADER}\nExisting Tool,Existing Vendor,45.00,USD,monthly,2026-08-01\n`,
    );
    const result = await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [{ rowNumber: 2, duplicateChoice: 'skip' }],
    });
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
  });

  it('honours an explicit "update" choice and records where the price came from', async () => {
    const preview = await previewCsv(
      `${HEADER}\nExisting Tool,Existing Vendor,55.00,USD,monthly,2026-08-01\n`,
    );
    const result = await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [{ rowNumber: 2, duplicateChoice: 'update' }],
    });
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const stored = await context.services.subscriptions.get(organizationId, existingId);
    expect(Number(stored.amountMinor)).toBe(5500);

    const history = await context.services.subscriptions.priceHistory(organizationId, existingId);
    const imported = history.find((entry) => entry.source === 'csv_import');
    expect(imported).toBeDefined();
    expect(imported!.oldAmountMinor).toBe(4500);
    expect(imported!.newAmountMinor).toBe(5500);
  });

  it('marks an imported subscription as csv_import in its opening price history', async () => {
    const preview = await previewCsv(
      `${HEADER}\nFresh Import,Fresh Vendor,19.99,USD,quarterly,2026-09-01\n`,
    );
    const result = await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [],
    });
    expect(result.created).toBe(1);

    const list = await context.services.subscriptions.list(
      organizationId,
      { page: 1, pageSize: 100, view: 'all', q: 'Fresh Import', sort: 'name', order: 'asc' },
      new Date().toISOString().slice(0, 10),
    );
    const history = await context.services.subscriptions.priceHistory(
      organizationId,
      list.items[0]!.id,
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.source).toBe('csv_import');
    expect(history[0]!.newAmountMinor).toBe(1999);
  });

  it('refuses to confirm the same import twice', async () => {
    const preview = await previewCsv(
      `${HEADER}\nSecond Pass,Vendor,7.00,USD,monthly,2026-10-01\n`,
    );
    await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [],
    });
    await expect(
      context.services.imports.commit({
        organizationId,
        actorUserId: tenant.user.id,
        importId: preview.importId,
        rows: [],
      }),
    ).rejects.toThrow(/already been confirmed/i);
    expect((await listNames()).filter((name) => name === 'Second Pass')).toHaveLength(1);
  });

  it('refuses to read another organization import', async () => {
    const preview = await previewCsv(`${HEADER}\nForeign Check,Vendor,5.00,USD,monthly,2026-11-01\n`);
    const other = await seedTenant(context, {
      email: 'imports-other@test.local',
      organizationName: 'Other Import Workspace',
    });
    await expect(context.services.imports.get(other.organization.id, preview.importId)).rejects.toThrow(
      /not found/i,
    );
    await expect(
      context.services.imports.errorReport(other.organization.id, preview.importId),
    ).rejects.toThrow(/not found/i);
  });
});

describe('warnings never block an import', () => {
  it('warns about an unknown category but still imports the row uncategorised', async () => {
    const preview = await previewCsv(
      `name,vendor,amount,currency,billing cycle,next renewal,category\n` +
        'Category Probe,UniqVendor Probe,42.00,USD,monthly,2026-12-01,Nonexistent Category\n',
    );
    const row = preview.rows[0]!;
    expect(row.errors).toHaveLength(0);
    expect(row.warnings.map((warning) => warning.code)).toContain('unknown_category');

    const result = await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [],
    });
    expect(result.created).toBe(1);

    const list = await context.services.subscriptions.list(
      organizationId,
      { page: 1, pageSize: 100, view: 'all', q: 'Category Probe', sort: 'name', order: 'asc' },
      new Date().toISOString().slice(0, 10),
    );
    expect(list.items[0]!.categoryId).toBeNull();
  });

  it('assigns a known category when the name matches exactly', async () => {
    const preview = await previewCsv(
      `name,vendor,amount,currency,billing cycle,next renewal,category\n` +
        'Category Match,UniqVendor Match,55.00,USD,monthly,2027-01-01,Imported Tools\n',
    );
    expect(preview.rows[0]!.warnings.map((warning) => warning.code)).not.toContain('unknown_category');

    await context.services.imports.commit({
      organizationId,
      actorUserId: tenant.user.id,
      importId: preview.importId,
      rows: [],
    });
    const list = await context.services.subscriptions.list(
      organizationId,
      { page: 1, pageSize: 100, view: 'all', q: 'Category Match', sort: 'name', order: 'asc' },
      new Date().toISOString().slice(0, 10),
    );
    expect(list.items[0]!.categoryId).toBe(categoryId);
  });
});