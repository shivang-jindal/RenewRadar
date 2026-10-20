/**
 * Development / demo seed (`npm run db:seed`).
 *
 * Seed data is only ever created by this explicit command (Part A / A4.5). A
 * production account always starts empty, and the script refuses to run against
 * a production configuration.
 *
 * Everything below goes through the real services, so the demo workspace is
 * created with the same validation, transactions, price-history rows and audit
 * entries as a real user journey.
 */

import { eq } from 'drizzle-orm';

import { addDaysIso, todayIso } from '@renewradar/shared';

import { loadConfig } from '../config.js';
import { createServices } from '../container.js';
import { createLogger } from '../logger.js';
import { createDatabase, runMigrations } from './client.js';
import { users } from './schema.js';

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@renewradar.test';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'renewradar-demo-1234';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) {
    throw new Error(
      'Refusing to seed a production database. Run the seed command against a development database.',
    );
  }

  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
  });
  await runMigrations(database);

  const existing = await database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1);
  if (existing[0]) {
    console.log(`[db:seed] ${DEMO_EMAIL} already exists; nothing to do.`);
    await database.close();
    return;
  }

  const logger = createLogger({ level: 'warn', isProduction: false, name: 'seed' });
  const services = createServices({ db: database.db, config, logger });

  try {
    const { user } = await services.auth.register({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: 'Demo Owner',
    });

    const organization = await services.organizations.create({
      name: 'Demo Studio',
      countryCode: 'US',
      timezone: 'America/New_York',
      baseCurrency: 'USD',
      ownerId: user.id,
    });
    await services.email.seedTemplates(organization.id);
    await services.organizations.ensureDefaultReminderRules(organization.id);
    // Reminders start paused so the demo never emails anyone by surprise.
    await services.organizations.updateSettings(organization.id, user.id, {
      remindersPaused: true,
      reminderTimeLocal: '09:00',
      defaultRenewalReminderDays: 7,
      defaultTrialReminderDays: 3,
      defaultCancellationReminderDays: 14,
    });

    const design = await services.categories.create(organization.id, user.id, {
      name: 'Design',
      colorToken: 'violet',
    });
    const infrastructure = await services.categories.create(organization.id, user.id, {
      name: 'Infrastructure',
      colorToken: 'sky',
    });
    const productivity = await services.categories.create(organization.id, user.id, {
      name: 'Productivity',
      colorToken: 'teal',
    });

    const today = todayIso('America/New_York');

    const rows = [
      {
        // Created at the old price and raised below, so the price-history
        // screen has a real increase to show.
        name: 'Figma Professional',
        vendorName: 'Figma',
        planName: 'Professional',
        categoryId: design.id,
        // $12.00 -> 1200 minor units. Money is never a float.
        amountMinor: 1200,
        currency: 'USD',
        intervalUnit: 'monthly' as const,
        intervalCount: 1,
        startDate: addDaysIso(today, -400),
        nextRenewalDate: addDaysIso(today, 3),
        renewalType: 'auto' as const,
        status: 'active' as const,
        paymentMethodLabel: 'Company card',
        vendorUrl: 'https://www.figma.com',
        cancellationUrl: 'https://www.figma.com/account',
        personalOrBusiness: 'business' as const,
      },
      {
        // Created high and reduced below, so there is a decrease as well.
        name: 'GitHub Team',
        vendorName: 'GitHub',
        planName: 'Team',
        categoryId: infrastructure.id,
        amountMinor: 4400,
        currency: 'USD',
        intervalUnit: 'monthly' as const,
        intervalCount: 1,
        startDate: addDaysIso(today, -300),
        nextRenewalDate: addDaysIso(today, 18),
        renewalType: 'auto' as const,
        status: 'active' as const,
        paymentMethodLabel: 'Company card',
        vendorUrl: 'https://github.com',
        personalOrBusiness: 'business' as const,
      },
      {
        // Deliberately a different currency: the dashboard must group rather
        // than sum these together.
        name: 'Hetzner Cloud Server',
        vendorName: 'Hetzner',
        planName: 'CX22',
        categoryId: infrastructure.id,
        amountMinor: 499,
        currency: 'EUR',
        intervalUnit: 'monthly' as const,
        intervalCount: 1,
        startDate: addDaysIso(today, -220),
        nextRenewalDate: addDaysIso(today, 42),
        renewalType: 'auto' as const,
        status: 'active' as const,
        notes: 'EUR. RenewRadar never converts currencies, so this total stays separate from USD.',
        personalOrBusiness: 'business' as const,
      },
      {
        name: 'Notion Business',
        vendorName: 'Notion',
        planName: 'Business',
        categoryId: productivity.id,
        amountMinor: 9600,
        currency: 'USD',
        intervalUnit: 'yearly' as const,
        intervalCount: 1,
        startDate: addDaysIso(today, -340),
        nextRenewalDate: addDaysIso(today, 75),
        renewalType: 'auto' as const,
        status: 'active' as const,
        personalOrBusiness: 'business' as const,
      },
      {
        // Month-end anchor: renews on the 31st, so the demo exercises the
        // clamping rule rather than the easy path.
        name: 'Linear Business',
        vendorName: 'Linear',
        planName: 'Business',
        categoryId: productivity.id,
        amountMinor: 800,
        currency: 'USD',
        intervalUnit: 'monthly' as const,
        intervalCount: 1,
        startDate: '2025-01-31',
        nextRenewalDate: lastDayOfNextMonth(today),
        renewalType: 'auto' as const,
        status: 'active' as const,
        personalOrBusiness: 'business' as const,
      },
      {
        name: 'Sentry Team',
        vendorName: 'Sentry',
        planName: 'Team',
        categoryId: infrastructure.id,
        amountMinor: 2600,
        currency: 'USD',
        intervalUnit: 'custom' as const,
        intervalCount: 45,
        startDate: addDaysIso(today, -120),
        nextRenewalDate: addDaysIso(today, 25),
        renewalType: 'auto' as const,
        status: 'trial' as const,
        trialEndDate: addDaysIso(today, 25),
        personalOrBusiness: 'business' as const,
      },
      {
        name: 'Loom Business',
        vendorName: 'Loom',
        planName: 'Business',
        categoryId: productivity.id,
        amountMinor: 1500,
        currency: 'USD',
        intervalUnit: 'monthly' as const,
        intervalCount: 1,
        startDate: addDaysIso(today, -200),
        nextRenewalDate: addDaysIso(today, 9),
        // Cancellation is *planned*, not done. The demo shows the distinction.
        renewalType: 'manual' as const,
        status: 'cancel_planned' as const,
        cancellationDeadline: addDaysIso(today, 7),
        cancellationUrl: 'https://www.loom.com/myaccount',
        notes: 'Cancel with Loom before the deadline, then record the confirmation here.',
        personalOrBusiness: 'business' as const,
      },
    ] as const;

    const created: string[] = [];
    for (const row of rows) {
      const subscription = await services.subscriptions.create(organization.id, user.id, { ...row });
      created.push(subscription.id);
    }

    // Two genuine price changes, so price history and the "price increases"
    // card have real rows instead of a fabricated chart.
    const figmaId = created[0];
    if (figmaId) {
      await services.subscriptions.update(
        organization.id,
        user.id,
        figmaId,
        { amountMinor: 1500 },
        { requestId: 'seed' },
      );
    }
    const githubId = created[1];
    if (githubId) {
      await services.subscriptions.update(
        organization.id,
        user.id,
        githubId,
        { amountMinor: 4000 },
        { requestId: 'seed' },
      );
    }

    const loomId = created[6];
    if (loomId) {
      await services.subscriptions.recordDecision({
        organizationId: organization.id,
        subscriptionId: loomId,
        actorUserId: user.id,
        decision: 'cancel_planned',
        reason: 'Switched to a cheaper recorder for the demo workspace.',
        requestId: 'seed',
      });
    }

    await services.budgets.create(organization.id, user.id, {
      // `categoryId: null` means "uncategorised subscriptions only" in the
      // current budget service, so the demo budget is named for exactly that
      // rather than claiming to cover everything.
      name: 'Uncategorized spend (monthly)',
      categoryId: null,
      amountMinor: 5_000,
      currency: 'USD',
      period: 'monthly',
      thresholdPercent: 80,
      enabled: true,
    });
    await services.budgets.create(organization.id, user.id, {
      name: 'Infrastructure spend',
      categoryId: infrastructure.id,
      amountMinor: 20_000,
      currency: 'USD',
      period: 'monthly',
      thresholdPercent: 75,
      enabled: true,
    });

    console.log('[db:seed] demo workspace created.');
    console.log(`           email:        ${DEMO_EMAIL}`);
    console.log(`           password:     ${DEMO_PASSWORD}`);
    console.log(`           organization: ${organization.name} (${organization.slug})`);
    console.log(`           subscriptions: ${created.length}`);
    console.log('           note: email is not configured, so reminders stay in-app only.');
  } finally {
    await database.close();
  }
}

/** Last calendar day of the month after `today` (the month-end anchor demo). */
function lastDayOfNextMonth(today: string): string {
  const [year = '1970', month = '1'] = today.split('-');
  const target = new Date(Date.UTC(Number(year), Number(month), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  return lastDay.toISOString().slice(0, 10);
}

main().catch((error: unknown) => {
  console.error('[db:seed] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
