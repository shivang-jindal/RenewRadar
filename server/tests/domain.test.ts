/**
 * Subscription domain rules (Part E / E3.3, E3.4, E3.7, E7).
 *
 * Status transitions, their guards, append-only price history and tenant
 * scoping - all exercised against the real services and the real schema.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { addDaysIso, todayIso } from '@renewradar/shared';

import { subscriptionPriceHistory } from '../src/db/schema.js';
import { createTestContext, seedTenant, subscriptionInput, type SeededTenant, type TestContext } from './harness.js';

let context: TestContext;
let tenantA: SeededTenant;
let tenantB: SeededTenant;

beforeAll(async () => {
  context = await createTestContext();
  tenantA = await seedTenant(context, { email: 'owner-a@test.local', organizationName: 'Tenant A' });
  tenantB = await seedTenant(context, { email: 'owner-b@test.local', organizationName: 'Tenant B' });
});

afterAll(async () => {
  await context.close();
});

const today = todayIso('UTC');

function create(
  tenant: SeededTenant,
  overrides: Parameters<typeof subscriptionInput>[0] = {},
) {
  return context.services.subscriptions.create(
    tenant.organization.id,
    tenant.user.id,
    subscriptionInput(overrides),
  );
}

describe('creating a subscription', () => {
  it('records the opening price as a price-history row in the same write', async () => {
    const subscription = await create(tenantA, { amountMinor: 1200, currency: 'USD' });
    const history = await context.services.subscriptions.priceHistory(
      tenantA.organization.id,
      subscription.id,
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.oldAmountMinor).toBeNull();
    expect(history[0]!.newAmountMinor).toBe(1200);
    expect(history[0]!.direction).toBe('initial');
    expect(history[0]!.source).toBe('manual');
  });

  it('rejects a renewal that is before the start date', async () => {
    await expect(
      create(tenantA, { startDate: '2025-06-01', nextRenewalDate: '2025-05-01' }),
    ).rejects.toThrow(/cannot be before the start date/i);
  });

  it('rejects a non-positive amount', async () => {
    await expect(create(tenantA, { amountMinor: 0 })).rejects.toThrow(/greater than zero/i);
    await expect(create(tenantA, { amountMinor: -100 })).rejects.toThrow(/greater than zero/i);
  });

  it('requires a trial end date for a trial subscription', async () => {
    await expect(create(tenantA, { status: 'trial', trialEndDate: null })).rejects.toThrow(
      /needs a trial end date/i,
    );
  });

  it('rejects a cancellation deadline after the renewal it is meant to protect', async () => {
    await expect(
      create(tenantA, {
        nextRenewalDate: addDaysIso(today, 10),
        cancellationDeadline: addDaysIso(today, 20),
      }),
    ).rejects.toThrow(/cannot be acted on in time/i);
  });

  it('promotes a trial whose end date has already passed to active', async () => {
    const past = await create(tenantA, {
      status: 'trial',
      startDate: addDaysIso(today, -60),
      nextRenewalDate: addDaysIso(today, -1),
      trialEndDate: addDaysIso(today, -1),
    });
    expect(past.status).toBe('active');

    const future = await create(tenantA, {
      status: 'trial',
      startDate: today,
      nextRenewalDate: addDaysIso(today, 30),
      trialEndDate: addDaysIso(today, 30),
    });
    expect(future.status).toBe('trial');
  });
});

describe('status transitions and their guards', () => {
  it('records "cancellation planned" without ever claiming a cancellation', async () => {
    const subscription = await create(tenantA, { status: 'active' });
    const result = await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'cancel_planned',
      reason: 'Switching to the cheaper plan.',
    });

    // Planned is not done.
    expect(result.status).toBe('cancel_planned');
    expect(result.decision.cancellationConfirmedAt).toBeNull();

    const stored = await context.services.subscriptions.get(tenantA.organization.id, subscription.id);
    expect(stored.status).toBe('cancel_planned');
    // Nothing external happened, so no cancellation timestamp was invented.
    expect(stored.cancelledAt).toBeNull();
  });

  it('only marks a subscription cancelled once the user confirms it with the vendor', async () => {
    const subscription = await create(tenantA, { status: 'active' });
    await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'cancel_planned',
      reason: 'Too expensive.',
    });

    const cancelled = await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'cancelled',
      cancellationConfirmedAt: addDaysIso(today, -1),
      cancellationReference: 'Confirmation #RR-4711',
    });

    expect(cancelled.status).toBe('cancelled');
    const stored = await context.services.subscriptions.get(tenantA.organization.id, subscription.id);
    expect(stored.cancelledAt).not.toBeNull();

    // Cancelling twice appends a second decision row; the log is append-only
    // and the state is still exactly "cancelled" - never applied twice anywhere.
    await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'cancelled',
      cancellationConfirmedAt: today,
    });
    const decisions = await context.services.subscriptions.decisions(
      tenantA.organization.id,
      subscription.id,
    );
    expect(decisions.filter((entry) => entry.decision === 'cancelled')).toHaveLength(2);
    const afterSecond = await context.services.subscriptions.get(tenantA.organization.id, subscription.id);
    expect(afterSecond.status).toBe('cancelled');
  });

  it('brings a planned cancellation back to life when the user decides to keep it', async () => {
    const subscription = await create(tenantA, { status: 'cancel_planned' });
    const result = await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'keep',
      reason: 'Decided to stay.',
    });
    expect(result.status).toBe('active');
  });

  it('leaves the status untouched for a review or downgrade decision', async () => {
    const subscription = await create(tenantA, { status: 'active' });
    for (const decision of ['review', 'downgrade'] as const) {
      const result = await context.services.subscriptions.recordDecision({
        organizationId: tenantA.organization.id,
        subscriptionId: subscription.id,
        actorUserId: tenantA.user.id,
        decision,
      });
      // The subscription still renews: reviewing is not cancelling.
      expect(result.status).toBe('active');
    }
  });

  it('marks a subscription as needing review and then clears the flag', async () => {
    const subscription = await create(tenantA, { status: 'active' });
    await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'review',
    });
    let listed = await context.services.subscriptions.list(
      tenantA.organization.id,
      { page: 1, pageSize: 100, view: 'all', sort: 'next_renewal_date', order: 'asc' },
      today,
    );
    expect(listed.items.find((item) => item.id === subscription.id)?.markedForReview).toBe(true);

    await context.services.subscriptions.recordDecision({
      organizationId: tenantA.organization.id,
      subscriptionId: subscription.id,
      actorUserId: tenantA.user.id,
      decision: 'keep',
    });
    listed = await context.services.subscriptions.list(
      tenantA.organization.id,
      { page: 1, pageSize: 100, view: 'all', sort: 'next_renewal_date', order: 'asc' },
      today,
    );
    expect(listed.items.find((item) => item.id === subscription.id)?.markedForReview).toBe(false);
  });

  it('cannot record a decision against a subscription in another tenant', async () => {
    const subscription = await create(tenantA, { status: 'active' });
    await expect(
      context.services.subscriptions.recordDecision({
        organizationId: tenantB.organization.id,
        subscriptionId: subscription.id,
        actorUserId: tenantB.user.id,
        decision: 'cancel_planned',
        reason: 'Cross-tenant attempt.',
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('editing a subscription', () => {
  it('keeps every earlier price when the amount changes', async () => {
    const subscription = await create(tenantA, { amountMinor: 1200 });
    await context.services.subscriptions.update(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      { amountMinor: 1500 },
    );
    await context.services.subscriptions.update(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      { amountMinor: 1500 },
    );

    const history = await context.services.subscriptions.priceHistory(
      tenantA.organization.id,
      subscription.id,
    );
    // Opening price + one genuine change. The no-op update adds nothing.
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.newAmountMinor).sort((a, b) => a - b)).toEqual([1200, 1500]);
    const change = history.find((entry) => entry.oldAmountMinor !== null)!;
    expect(change.changeMinor).toBe(300);
    expect(change.changePercent).toBe(25);
    expect(change.direction).toBe('increase');
  });

  it('reports whether the price and the schedule actually changed', async () => {
    const subscription = await create(tenantA, {
      amountMinor: 1000,
      nextRenewalDate: addDaysIso(today, 20),
    });

    const renamed = await context.services.subscriptions.update(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      { name: 'Renamed' },
    );
    expect(renamed.priceChanged).toBe(false);
    expect(renamed.scheduleChanged).toBe(false);

    const repriced = await context.services.subscriptions.update(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      { amountMinor: 2000 },
    );
    expect(repriced.priceChanged).toBe(true);
    expect(repriced.scheduleChanged).toBe(false);

    const rescheduled = await context.services.subscriptions.update(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      { nextRenewalDate: addDaysIso(today, 25) },
    );
    expect(rescheduled.scheduleChanged).toBe(true);
  });

  it('applies the same date guards on update as on create', async () => {
    const subscription = await create(tenantA, {
      startDate: '2025-01-01',
      nextRenewalDate: '2025-06-01',
    });
    await expect(
      context.services.subscriptions.update(
        tenantA.organization.id,
        tenantA.user.id,
        subscription.id,
        { nextRenewalDate: '2024-12-01' },
      ),
    ).rejects.toThrow(/cannot be before the start date/i);

    await expect(
      context.services.subscriptions.update(
        tenantA.organization.id,
        tenantA.user.id,
        subscription.id,
        { amountMinor: 0 },
      ),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('refuses a category from another tenant and an owner who is not a member', async () => {
    const foreignCategory = await context.services.categories.create(
      tenantB.organization.id,
      tenantB.user.id,
      { name: 'Foreign Category', colorToken: 'teal' },
    );
    const ownCategory = await context.services.categories.create(
      tenantA.organization.id,
      tenantA.user.id,
      { name: 'Own Category', colorToken: 'teal' },
    );

    await expect(
      create(tenantA, { categoryId: foreignCategory.id }),
    ).rejects.toThrow(/not found/i);
    await expect(
      create(tenantA, { categoryId: ownCategory.id, ownerUserId: tenantB.user.id }),
    ).rejects.toThrow(/not a member of this organization/i);
  });

  it('does not silently orphan subscriptions when a category is deleted', async () => {
    const keep = await context.services.categories.create(tenantA.organization.id, tenantA.user.id, {
      name: 'Keep Me',
      colorToken: 'sky',
    });
    const drop = await context.services.categories.create(tenantA.organization.id, tenantA.user.id, {
      name: 'Drop Me',
      colorToken: 'sky',
    });
    const first = await create(tenantA, { categoryId: drop.id, name: 'Moves' });
    const second = await create(tenantA, { categoryId: drop.id, name: 'Becomes Uncategorised' });

    const result = await context.services.categories.remove({
      organizationId: tenantA.organization.id,
      actorUserId: tenantA.user.id,
      categoryId: drop.id,
      reassignToCategoryId: keep.id,
    });
    expect(result.reassigned).toBe(2);

    expect((await context.services.subscriptions.get(tenantA.organization.id, first.id)).categoryId).toBe(
      keep.id,
    );
    expect((await context.services.subscriptions.get(tenantA.organization.id, second.id)).categoryId).toBe(
      keep.id,
    );

    const dropTwo = await context.services.categories.create(tenantA.organization.id, tenantA.user.id, {
      name: 'Drop Me Two',
      colorToken: 'sky',
    });
    const third = await create(tenantA, { categoryId: dropTwo.id, name: 'Uncategorised' });
    await context.services.categories.remove({
      organizationId: tenantA.organization.id,
      actorUserId: tenantA.user.id,
      categoryId: dropTwo.id,
      reassignToCategoryId: null,
    });
    expect((await context.services.subscriptions.get(tenantA.organization.id, third.id)).categoryId).toBeNull();
  });
});

describe('archiving', () => {
  it('hides an archived subscription from the active views but keeps the row', async () => {
    const subscription = await create(tenantA, { name: 'Archived Probe' });
    await context.services.subscriptions.setArchived(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      true,
    );

    const active = await context.services.subscriptions.list(
      tenantA.organization.id,
      { page: 1, pageSize: 100, view: 'active', sort: 'next_renewal_date', order: 'asc' },
      today,
    );
    expect(active.items.some((item) => item.id === subscription.id)).toBe(false);

    const archived = await context.services.subscriptions.list(
      tenantA.organization.id,
      { page: 1, pageSize: 100, view: 'archived', sort: 'next_renewal_date', order: 'asc' },
      today,
    );
    expect(archived.items.some((item) => item.id === subscription.id)).toBe(true);

    // The row is still there, so un-archiving restores it.
    await context.services.subscriptions.setArchived(
      tenantA.organization.id,
      tenantA.user.id,
      subscription.id,
      false,
    );
    expect(
      (await context.services.subscriptions.get(tenantA.organization.id, subscription.id)).archivedAt,
    ).toBeNull();
  });
});

describe('bulk edits never cross a tenant boundary', () => {
  it('skips ids that do not belong to the organization', async () => {
    const mine = await create(tenantA, { name: 'Mine' });
    const theirs = await create(tenantB, { name: 'Theirs' });

    const result = await context.services.subscriptions.bulkUpdate({
      organizationId: tenantA.organization.id,
      actorUserId: tenantA.user.id,
      subscriptionIds: [mine.id, theirs.id],
      patch: { personalOrBusiness: 'personal' },
    });

    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual([theirs.id]);
    expect(
      (await context.services.subscriptions.get(tenantA.organization.id, mine.id)).personalOrBusiness,
    ).toBe('personal');
    expect(
      (await context.services.subscriptions.get(tenantB.organization.id, theirs.id)).personalOrBusiness,
    ).toBe('business');
  });

  it('reports nothing found when every id is foreign', async () => {
    const theirs = await create(tenantB, { name: 'Only Theirs' });
    await expect(
      context.services.subscriptions.bulkUpdate({
        organizationId: tenantA.organization.id,
        actorUserId: tenantA.user.id,
        subscriptionIds: [theirs.id],
        patch: { personalOrBusiness: 'personal' },
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('tenant isolation at the service layer', () => {
  it('reports a foreign subscription as missing, never as forbidden', async () => {
    const subscription = await create(tenantA, { name: 'Tenant A Secret' });

    await expect(
      context.services.subscriptions.get(tenantB.organization.id, subscription.id),
    ).rejects.toThrow(/not found/i);
    await expect(
      context.services.subscriptions.listItem(tenantB.organization.id, subscription.id, today),
    ).rejects.toThrow(/not found/i);
    await expect(
      context.services.subscriptions.detail(tenantB.organization.id, subscription.id, today),
    ).rejects.toThrow(/not found/i);
    await expect(
      context.services.subscriptions.update(
        tenantB.organization.id,
        tenantB.user.id,
        subscription.id,
        { amountMinor: 1 },
      ),
    ).rejects.toThrow(/not found/i);
    await expect(
      context.services.subscriptions.setArchived(
        tenantB.organization.id,
        tenantB.user.id,
        subscription.id,
        true,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('never leaks another organization into a list', async () => {
    const mine = await create(tenantA, { name: 'Tenant A Row' });
    const theirs = await create(tenantB, { name: 'Tenant B Row' });

    const listA = await context.services.subscriptions.list(
      tenantA.organization.id,
      { page: 1, pageSize: 100, view: 'all', sort: 'next_renewal_date', order: 'asc' },
      today,
    );
    const idsA = new Set(listA.items.map((item) => item.id));
    expect(idsA.has(mine.id)).toBe(true);
    expect(idsA.has(theirs.id)).toBe(false);

    const listB = await context.services.subscriptions.list(
      tenantB.organization.id,
      { page: 1, pageSize: 100, view: 'all', sort: 'next_renewal_date', order: 'asc' },
      today,
    );
    expect(listB.items.map((item) => item.id)).toContain(theirs.id);
    expect(listB.items.map((item) => item.id)).not.toContain(mine.id);
  });

  it('never leaks another organization price history', async () => {
    const subscription = await create(tenantA, { amountMinor: 1234 });
    const foreign = await context.services.subscriptions.priceHistory(
      tenantB.organization.id,
      subscription.id,
    );
    expect(foreign).toEqual([]);

    const rows = await context.handle.db
      .select({ id: subscriptionPriceHistory.id })
      .from(subscriptionPriceHistory)
      .where(eq(subscriptionPriceHistory.subscriptionId, subscription.id));
    expect(rows).toHaveLength(1);
  });
});

describe('dashboard currency grouping (the cross-currency rule, end to end)', () => {
  it('never combines EUR and USD into one number', async () => {
    const org = 'mixed-currency-org';
    const tenant = await seedTenant(context, {
      email: 'mixed@test.local',
      organizationName: org,
      timezone: 'UTC',
    });
    const usd = await create(tenant, { name: 'USD Tool', amountMinor: 1000, currency: 'USD' });
    const eur = await create(tenant, { name: 'EUR Tool', amountMinor: 5000, currency: 'EUR' });
    // A third row that is not billed any more must not appear in the total.
    await create(tenant, {
      name: 'Paused Tool',
      amountMinor: 999_999,
      currency: 'USD',
      status: 'paused',
    });
    expect([usd.currency, eur.currency]).toEqual(['USD', 'EUR']);

    const summary = await context.services.reports.dashboard(tenant.organization.id, today);

    expect(summary.monthlyRecurringByCurrency).toEqual([
      { currency: 'EUR', amountMinor: 5000 },
      { currency: 'USD', amountMinor: 1000 },
    ]);
    expect(summary.annualizedByCurrency).toEqual([
      { currency: 'EUR', amountMinor: 60000 },
      { currency: 'USD', amountMinor: 12000 },
    ]);
    // No combined figure exists anywhere: the naive sum 1000 + 5000 is absent.
    expect(summary.monthlyRecurringByCurrency.map((entry) => entry.amountMinor)).not.toContain(6000);
    expect(summary.currencyGroupingNotice).toMatch(/never added together/i);

    // The reports screen recomputes the same grouping from the raw rows.
    expect(await context.services.reports.monthlyTotalsByCurrency(tenant.organization.id)).toEqual(
      summary.monthlyRecurringByCurrency,
    );
  });

  it('withholds a budget usage percentage rather than mixing currencies', async () => {
    const tenant = await seedTenant(context, {
      email: 'budget-fx@test.local',
      organizationName: 'Budget FX',
      timezone: 'UTC',
    });
    await create(tenant, { name: 'EUR Only', amountMinor: 5000, currency: 'EUR' });
    const budget = await context.services.budgets.create(tenant.organization.id, tenant.user.id, {
      name: 'USD budget',
      categoryId: null,
      amountMinor: 10000,
      currency: 'USD',
      period: 'monthly',
      thresholdPercent: 80,
      enabled: true,
    });

    const budgets = await context.services.budgets.list(tenant.organization.id);
    const view = budgets.find((entry) => entry.id === budget.id)!;
    // The covered spend is all EUR, so a USD budget has nothing to compare
    // against - it must say "unknown", not invent a number.
    expect(view.usagePercent).toBeNull();
    expect(view.atRisk).toBe(false);
  });

  it('groups category spend by currency as well', async () => {
    const tenant = await seedTenant(context, {
      email: 'category-fx@test.local',
      organizationName: 'Category FX',
      timezone: 'UTC',
    });
    const category = await context.services.categories.create(tenant.organization.id, tenant.user.id, {
      name: 'Mixed Tools',
      colorToken: 'violet',
    });
    await create(tenant, { name: 'A', amountMinor: 1000, currency: 'USD', categoryId: category.id });
    await create(tenant, { name: 'B', amountMinor: 2000, currency: 'EUR', categoryId: category.id });

    const listed = await context.services.categories.list(tenant.organization.id);
    const view = listed.find((entry) => entry.id === category.id)!;
    expect(view.subscriptionCount).toBe(2);
    expect(view.monthlyMinorByCurrency).toEqual([
      { currency: 'EUR', amountMinor: 2000 },
      { currency: 'USD', amountMinor: 1000 },
    ]);
  });

  it('returns honest zeros for an empty organization', async () => {
    const tenant = await seedTenant(context, {
      email: 'empty@test.local',
      organizationName: 'Empty Workspace',
      timezone: 'UTC',
    });
    const summary = await context.services.reports.dashboard(tenant.organization.id, today);
    expect(summary.monthlyRecurringByCurrency).toEqual([]);
    expect(summary.annualizedByCurrency).toEqual([]);
    expect(summary.renewals.next7Days).toEqual([]);
    expect(summary.priceIncreases).toEqual([]);
    expect(summary.spendByCategory).toEqual([]);
    expect(summary.activeCount).toBe(0);
  });
});

describe('subscription detail', () => {
  it('exposes the anchor day and the forward renewal series', async () => {
    const subscription = await create(tenantA, {
      name: 'Month End Anchor',
      startDate: '2025-01-31',
      nextRenewalDate: '2025-02-28',
    });
    const detail = await context.services.subscriptions.detail(
      tenantA.organization.id,
      subscription.id,
      today,
    );
    expect(detail.anchorDay).toBe(31);
    expect(detail.anchorDayClamped).toBe(true);
    expect(detail.upcomingRenewals).toEqual([
      '2025-03-31',
      '2025-04-30',
      '2025-05-31',
      '2025-06-30',
      '2025-07-31',
      '2025-08-31',
    ]);
  });
});