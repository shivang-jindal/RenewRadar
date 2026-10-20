/**
 * Test harness.
 *
 * Every integration test runs against a real PostgreSQL engine (PGlite) with
 * the production migrations applied, so schema, constraints, transactions and
 * tenant scoping behave exactly as they will in production.
 *
 * Nothing here is a mock or a fake: tenants are created through the real
 * `auth.register` / `organizations.create` services, so a test can never pass
 * against a path a real user cannot take.
 */

import { and, eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createServices, type Services } from '../src/container.js';
import { createDatabase, runMigrations, type DatabaseHandle } from '../src/db/client.js';
import { reminderRules } from '../src/db/schema.js';
import { createLogger } from '../src/logger.js';
import type { SubscriptionInput } from '../src/services/subscription.service.js';

/** Long enough to satisfy the shared password schema; never a real credential. */
export const TEST_PASSWORD = 'a-very-long-test-password';

export interface TestContext {
  handle: DatabaseHandle;
  services: Services;
  config: AppConfig;
  app: Express;
  close: () => Promise<void>;
}

export async function createTestContext(
  overrides: Record<string, string> = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    EMAIL_PROVIDER: 'disabled',
    WORKER_ENABLED: 'false',
    SESSION_COOKIE_NAME: 'renewradar_test',
    // The suite makes far more than the production default of 300 calls, and a
    // rate-limit 429 would hide real failures behind an unrelated one.
    RATE_LIMIT_MAX: '10000',
    AUTH_RATE_LIMIT_MAX: '10000',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const handle = await createDatabase({ memory: true });
  await runMigrations(handle);

  const services = createServices({
    db: handle.db,
    config,
    // `createLogger` forces the `debug` level whenever `isProduction` is false,
    // so the only way to get a silent test logger is to ask for it as if it
    // were production. `config.isProduction` is untouched and stays false.
    logger: createLogger({ level: 'silent', isProduction: true, name: 'test' }),
  });

  return {
    handle,
    services,
    config,
    app: createApp(services),
    close: async () => {
      await handle.close();
    },
  };
}

export interface SeededTenant {
  user: { id: string; email: string; displayName: string | null };
  organization: { id: string; name: string; slug: string; baseCurrency: string; timezone: string };
}

export async function seedTenant(
  context: TestContext,
  input: {
    email: string;
    organizationName: string;
    baseCurrency?: string;
    timezone?: string;
  },
): Promise<SeededTenant> {
  const { user } = await context.services.auth.register({
    email: input.email,
    password: TEST_PASSWORD,
    displayName: 'Test Owner',
  });
  const organization = await context.services.organizations.create({
    name: input.organizationName,
    countryCode: 'US',
    timezone: input.timezone ?? 'UTC',
    baseCurrency: input.baseCurrency ?? 'USD',
    ownerId: user.id,
  });
  await context.services.email.seedTemplates(organization.id);
  await context.services.organizations.ensureDefaultReminderRules(organization.id);
  return { user, organization };
}

/** Signed-in cookie jar for one user. */
export async function loginAs(
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<request.Agent> {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  return agent;
}

let subscriptionCounter = 0;

/**
 * A valid subscription payload with everything optional left out, so a test
 * only has to state the field it actually cares about.
 */
export function subscriptionInput(
  overrides: Partial<SubscriptionInput> = {},
): SubscriptionInput {
  subscriptionCounter += 1;
  return {
    name: `Subscription ${subscriptionCounter}`,
    vendorName: `Vendor ${subscriptionCounter}`,
    amountMinor: 1000,
    currency: 'USD',
    intervalUnit: 'monthly',
    intervalCount: 1,
    startDate: '2025-01-01',
    nextRenewalDate: '2025-02-01',
    renewalType: 'auto',
    status: 'active',
    personalOrBusiness: 'business',
    ...overrides,
  };
}

/**
 * Turn the organization back into a state where the reminder scheduler is
 * expected to do work: rules present, one renewal rule enabled, not paused.
 *
 * The default rules ship disabled and the organization starts with reminders
 * paused, which is the honest new-account state; tests opt in explicitly rather
 * than relying on a global default.
 */
export async function enableRenewalReminders(
  context: TestContext,
  tenant: SeededTenant,
  daysBefore = 7,
): Promise<void> {
  const organizationId = tenant.organization.id;
  await context.services.organizations.ensureDefaultReminderRules(organizationId);
  await context.services.organizations.updateSettings(organizationId, tenant.user.id, {
    remindersPaused: false,
  });
  const updated = await context.services.db
    .update(reminderRules)
    .set({ enabled: true, updatedAt: new Date() })
    .where(
      and(
        eq(reminderRules.organizationId, organizationId),
        eq(reminderRules.eventType, 'renewal'),
        eq(reminderRules.daysBefore, daysBefore),
      ),
    )
    .returning({ id: reminderRules.id });
  if (updated.length === 0) {
    throw new Error(`No default renewal rule with daysBefore=${daysBefore} to enable`);
  }
}