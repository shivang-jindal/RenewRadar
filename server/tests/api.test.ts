/**
 * HTTP-level tests: authentication, session handling, the error envelope,
 * tenant isolation and role permissions over real requests, truthful
 * integration status, CSV export safety and dashboard/list agreement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { addDaysIso, parseCsv, todayIso } from '@renewradar/shared';

import {
  createTestContext,
  seedTenant,
  subscriptionInput,
  TEST_PASSWORD,
  type SeededTenant,
  type TestContext,
} from './harness.js';

let context: TestContext;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let agentA: request.Agent;
let agentB: request.Agent;
let viewerAgent: request.Agent;
let secretSubscriptionId: string;

const today = todayIso('UTC');
const orgA = () => tenantA.organization.id;
const orgB = () => tenantB.organization.id;

beforeAll(async () => {
  context = await createTestContext();
  tenantA = await seedTenant(context, { email: 'http-a@test.local', organizationName: 'HTTP Tenant A' });
  tenantB = await seedTenant(context, { email: 'http-b@test.local', organizationName: 'HTTP Tenant B' });

  const { user: viewer } = await context.services.auth.register({
    email: 'http-viewer@test.local',
    password: TEST_PASSWORD,
    displayName: 'Read Only',
  });
  const invitation = await context.services.organizations.invite({
    organizationId: tenantA.organization.id,
    email: 'http-viewer@test.local',
    role: 'viewer',
    invitedBy: tenantA.user.id,
    actorRole: 'owner',
  });
  await context.services.organizations.acceptInvitation(invitation.token, viewer.id);

  const created = await context.services.subscriptions.create(
    tenantA.organization.id,
    tenantA.user.id,
    subscriptionInput({ name: 'Tenant A Secret', amountMinor: 4200 }),
  );
  secretSubscriptionId = created.id;

  agentA = request.agent(context.app);
  agentB = request.agent(context.app);
  viewerAgent = request.agent(context.app);
  await agentA
    .post('/api/v1/auth/login')
    .send({ email: 'http-a@test.local', password: TEST_PASSWORD })
    .expect(200);
  await agentB
    .post('/api/v1/auth/login')
    .send({ email: 'http-b@test.local', password: TEST_PASSWORD })
    .expect(200);
  await viewerAgent
    .post('/api/v1/auth/login')
    .send({ email: 'http-viewer@test.local', password: TEST_PASSWORD })
    .expect(200);
});

afterAll(async () => {
  await context.close();
});

describe('health and the error envelope', () => {
  it('exposes liveness and readiness without leaking configuration', async () => {
    const live = await request(context.app).get('/api/v1/health/live').expect(200);
    expect(live.body.status).toBe('ok');

    const ready = await request(context.app).get('/api/v1/health/ready').expect(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.checks.some((check: { name: string }) => check.name === 'database')).toBe(true);
    expect(JSON.stringify(ready.body)).not.toMatch(/password|secret/i);
  });

  it('returns one consistent error shape with a request id and no stack', async () => {
    const response = await agentA.get(`/api/v1/${orgA()}/not-a-real-route`).expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('echoes a supplied request id so a failure can be traced', async () => {
    const response = await agentA
      .get(`/api/v1/${orgA()}/not-a-real-route`)
      .set('x-request-id', 'req_test_trace_123')
      .expect(404);
    expect(response.body.error.requestId).toBe('req_test_trace_123');
  });

  it('requires a session before it will route anything else', async () => {
    const response = await request(context.app).get(`/api/v1/${orgA()}/not-a-real-route`).expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('validates request bodies on the server', async () => {
    const response = await agentA.post(`/api/v1/${orgA()}/subscriptions`).send({ name: '' }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('rejects a negative money amount rather than storing it', async () => {
    const response = await agentA
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(subscriptionInput({ amountMinor: -5 }))
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('authentication', () => {
  it('refuses anonymous access to tenant routes', async () => {
    const response = await request(context.app).get(`/api/v1/${orgA()}/subscriptions`).expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('does not reveal whether an account exists when the password is wrong', async () => {
    const missing = await request(context.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'whatever-123456' })
      .expect(401);
    const wrong = await request(context.app)
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: 'wrong-password-123' })
      .expect(401);

    expect(missing.body.error.code).toBe(wrong.body.error.code);
    expect(missing.body.error.message).toBe(wrong.body.error.message);
    expect(missing.body.error.message).not.toMatch(/not found|no account|unknown user|register/i);
  });

  it('sets an HTTP-only session cookie and clears it on sign out', async () => {
    const agent = request.agent(context.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: TEST_PASSWORD })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((cookie) => cookie.includes('SameSite=Lax'))).toBe(true);

    await agent.post('/api/v1/auth/logout').expect(204);
    await agent.get(`/api/v1/${orgA()}/subscriptions`).expect(401);
  });

  it('answers /auth/session with a valid cookie and 401s without one', async () => {
    const session = await agentA.get('/api/v1/auth/session').expect(200);
    expect(session.body.user.id).toBe(tenantA.user.id);
    expect(Array.isArray(session.body.memberships)).toBe(true);
    expect(session.body.activeOrganizationId).toBe(orgA());

    const anonymous = await request(context.app).get('/api/v1/auth/session').expect(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('serves the session context the client actually calls', async () => {
    const response = await agentA.get('/api/v1/session/context').expect(200);
    expect(response.body.user.email).toBe('http-a@test.local');
    expect(response.body.memberships[0].role).toBe('owner');
  });

  it('revokes every session when the password changes', async () => {
    // A dedicated throwaway account, so the shared agents keep their sessions.
    await context.services.auth.register({
      email: 'http-rotate@test.local',
      password: TEST_PASSWORD,
      displayName: 'Rotating User',
    });
    const agent = request.agent(context.app);
    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'http-rotate@test.local', password: TEST_PASSWORD })
      .expect(200);

    await agent
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-test-password' })
      .expect(204);

    // The cookie was cleared and the stored session was revoked server-side.
    await agent.get('/api/v1/auth/session').expect(401);

    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'http-rotate@test.local', password: TEST_PASSWORD })
      .expect(401);
    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'http-rotate@test.local', password: 'a-brand-new-test-password' })
      .expect(200);
  });
});

describe('cross-tenant access is 404, never 403', () => {
  it('hides a subscription owned by another organization behind a 404', async () => {
    // Same URL, different session, same organization id in the path.
    const response = await agentB.get(`/api/v1/${orgA()}/subscriptions/${secretSubscriptionId}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('hides the whole organization behind a 404 when the caller is not a member', async () => {
    const response = await agentB.get(`/api/v1/${orgA()}/subscriptions`);
    expect(response.status).toBe(404);
  });

  it('refuses a write to another organization with the same 404', async () => {
    const patch = await agentB
      .patch(`/api/v1/${orgA()}/subscriptions/${secretSubscriptionId}`)
      .send({ amountMinor: 1 });
    expect(patch.status).toBe(404);

    const decision = await agentB
      .post(`/api/v1/${orgA()}/subscriptions/${secretSubscriptionId}/decisions`)
      .send({ decision: 'cancel_planned', reason: 'cross-tenant' });
    expect(decision.status).toBe(404);

    // The record is untouched.
    const stored = await context.services.subscriptions.get(orgA(), secretSubscriptionId);
    expect(Number(stored.amountMinor)).toBe(4200);
    expect(stored.status).toBe('active');
  });

  it('never lists another organization record through an authorized list route', async () => {
    const listB = await agentB.get(`/api/v1/${orgB()}/subscriptions?pageSize=100`).expect(200);
    expect((listB.body.items as Array<{ id: string }>).some((item) => item.id === secretSubscriptionId)).toBe(
      false,
    );
  });

  it('cannot reach another organization through a guessed id', async () => {
    const response = await agentB.get(`/api/v1/${orgB()}/categories/00000000-0000-4000-8000-000000000000`);
    expect(response.status).toBe(404);
  });

  it('does not leak another organization price history', async () => {
    const response = await agentB.get(
      `/api/v1/${orgB()}/subscriptions/${secretSubscriptionId}/price-history`,
    );
    // Either the record is invisible (404) or the list is empty - never data.
    expect([200, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain('4200');
    expect(JSON.stringify(response.body)).not.toContain(secretSubscriptionId);
  });
});

describe('role permissions', () => {
  it('lets a viewer read but never write', async () => {
    const read = await viewerAgent.get(`/api/v1/${orgA()}/subscriptions`).expect(200);
    expect(Array.isArray(read.body.items)).toBe(true);

    const create = await viewerAgent
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(subscriptionInput({ name: 'Viewer Attempt' }));
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('FORBIDDEN');

    const edit = await viewerAgent
      .patch(`/api/v1/${orgA()}/subscriptions/${secretSubscriptionId}`)
      .send({ amountMinor: 1 });
    expect(edit.status).toBe(403);

    const decide = await viewerAgent
      .post(`/api/v1/${orgA()}/subscriptions/${secretSubscriptionId}/decisions`)
      .send({ decision: 'keep' });
    expect(decide.status).toBe(403);
  });

  it('withholds export, integration and member management from a viewer', async () => {
    const exported = await viewerAgent
      .post(`/api/v1/${orgA()}/exports/subscriptions`)
      .send({ dataset: 'subscriptions', filters: {} });
    expect(exported.status).toBe(403);

    const integration = await viewerAgent
      .put(`/api/v1/${orgA()}/integrations/email_smtp`)
      .send({ credentials: {}, enabled: true });
    expect(integration.status).toBe(403);

    const invitation = await viewerAgent
      .post(`/api/v1/${orgA()}/members/invitations`)
      .send({ email: 'someone@test.local', role: 'member' });
    expect(invitation.status).toBe(403);
  });

  it('still tells the viewer what it may do', async () => {
    const response = await viewerAgent.get(`/api/v1/${orgA()}`).expect(200);
    expect(response.body.role).toBe('viewer');
    expect(response.body.permissions).toEqual([]);
  });

  it('reports the real permission set for the owner', async () => {
    const response = await agentA.get(`/api/v1/${orgA()}`).expect(200);
    expect(response.body.role).toBe('owner');
    expect(response.body.permissions).toContain('subscription.create');
    expect(response.body.permissions).toContain('report.export');
  });

  it('only the owner can transfer ownership, and only with the typed phrase', async () => {
    const members = await agentA.get(`/api/v1/${orgA()}/members`).expect(200);
    const viewer = members.body.members.find(
      (member: { email: string }) => member.email === 'http-viewer@test.local',
    );

    const wrongPhrase = await agentA
      .post(`/api/v1/${orgA()}/transfer-ownership`)
      .send({ membershipId: viewer.id, confirmation: 'yes' })
      .expect(400);
    expect(wrongPhrase.body.error.code).toBe('VALIDATION_ERROR');

    const notOwner = await viewerAgent
      .post(`/api/v1/${orgA()}/transfer-ownership`)
      .send({ membershipId: viewer.id, confirmation: 'TRANSFER OWNERSHIP' });
    expect(notOwner.status).toBe(403);
  });
});

describe('the renewal review journey over HTTP', () => {
  it('creates a subscription, records a decision and keeps the history', async () => {
    const created = await agentA
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(
        subscriptionInput({
          name: 'Journey Subscription',
          vendorName: 'Journey Vendor',
          amountMinor: 2500,
          startDate: today,
          nextRenewalDate: addDaysIso(today, 21),
        }),
      )
      .expect(201);
    const id = created.body.subscription.id as string;
    expect(created.body.subscription.amountMinor).toBe(2500);

    // Planning a cancellation is an intention, not a cancellation.
    const planned = await agentA
      .post(`/api/v1/${orgA()}/subscriptions/${id}/decisions`)
      .send({ decision: 'cancel_planned', reason: 'Trying the free tier first.' })
      .expect(201);
    expect(planned.body.status).toBe('cancel_planned');
    expect(planned.body.externalCancellation.performed).toBe(false);
    expect(planned.body.externalCancellation.message).toMatch(/does not contact vendors/i);

    // Marking it cancelled demands a confirmation with the vendor.
    const premature = await agentA
      .post(`/api/v1/${orgA()}/subscriptions/${id}/decisions`)
      .send({ decision: 'cancelled' });
    expect(premature.status).toBe(400);
    expect(premature.body.error.fields.cancellationConfirmedAt).toBeTruthy();

    const confirmed = await agentA
      .post(`/api/v1/${orgA()}/subscriptions/${id}/decisions`)
      .send({ decision: 'cancelled', cancellationConfirmedAt: today })
      .expect(201);
    expect(confirmed.body.status).toBe('cancelled');

    const detail = await agentA.get(`/api/v1/${orgA()}/subscriptions/${id}`).expect(200);
    expect(detail.body.subscription.status).toBe('cancelled');
    expect(detail.body.decisions.map((entry: { decision: string }) => entry.decision)).toEqual([
      'cancelled',
      'cancel_planned',
    ]);
    expect(detail.body.priceHistory).toHaveLength(1);
  });

  it('re-plans pending reminders when the renewal date moves, without duplicating them', async () => {
    const created = await agentA
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(
        subscriptionInput({
          name: 'Reminder Journey',
          vendorName: 'Reminder Vendor',
          startDate: today,
          nextRenewalDate: addDaysIso(today, 40),
        }),
      )
      .expect(201);
    const id = created.body.subscription.id as string;

    // Reminders start paused on a new organization, so nothing was planned yet.
    const before = await agentA.get(`/api/v1/${orgA()}/reminder-rules/logs?pageSize=100`).expect(200);
    expect(before.body.items.filter((item: { subscriptionId: string }) => item.subscriptionId === id)).toHaveLength(0);

    await agentA
      .patch(`/api/v1/${orgA()}`)
      .send({ remindersPaused: false })
      .expect(400);

    await agentA
      .patch(`/api/v1/${orgA()}/settings/reminders`)
      .send({ remindersPaused: false, reminderTimeLocal: '09:00' })
      .expect(200);

    const rules = await agentA.get(`/api/v1/${orgA()}/reminder-rules`).expect(200);
    expect(rules.body.emailConfigured).toBe(false);
    const sevenDayRule = (rules.body.rules as Array<{ id: string; eventType: string; daysBefore: number }>).find(
      (rule) => rule.eventType === 'renewal' && rule.daysBefore === 7,
    )!;
    await agentA
      .patch(`/api/v1/${orgA()}/reminder-rules`)
      .send({
        rules: [
          { id: sevenDayRule.id, eventType: 'renewal', daysBefore: 7, channel: 'in_app', enabled: true },
        ],
      })
      .expect(200);

    const planned = await agentA
      .get(`/api/v1/${orgA()}/reminder-rules/logs?pageSize=100`)
      .expect(200);
    const firstBatch = planned.body.items.filter(
      (item: { subscriptionId: string; eventType: string }) =>
        item.subscriptionId === id && item.eventType === 'renewal',
    );
    expect(firstBatch.length).toBeGreaterThanOrEqual(1);

    const targetDate = firstBatch[0].targetDate as string;
    await agentA
      .patch(`/api/v1/${orgA()}/subscriptions/${id}`)
      .send({ nextRenewalDate: addDaysIso(today, 50) })
      .expect(200);

    const after = await agentA.get(`/api/v1/${orgA()}/reminder-rules/logs?pageSize=100`).expect(200);
    const stillForOldDate = after.body.items.filter(
      (item: { subscriptionId: string; targetDate: string }) =>
        item.subscriptionId === id && item.targetDate === targetDate && item.status === 'queued',
    );
    expect(stillForOldDate).toHaveLength(0);

    const live = after.body.items.filter(
      (item: { subscriptionId: string; targetDate: string; status: string }) =>
        item.subscriptionId === id && item.status === 'queued',
    );
    expect(live).toHaveLength(1);
    expect(live[0].targetDate).toBe(addDaysIso(today, 50));

    // Re-planning repeatedly must not multiply rows for the same cycle.
    await agentA
      .patch(`/api/v1/${orgA()}/subscriptions/${id}`)
      .send({ notes: 'No schedule change here.' })
      .expect(200);
    const final = await agentA.get(`/api/v1/${orgA()}/reminder-rules/logs?pageSize=100`).expect(200);
    expect(
      final.body.items.filter(
        (item: { subscriptionId: string; targetDate: string; status: string }) =>
          item.subscriptionId === id && item.targetDate === addDaysIso(today, 50) && item.status === 'queued',
      ),
    ).toHaveLength(1);
  });
});

describe('dashboard figures agree with the list they come from', () => {
  it('recomputes the same monthly totals, grouped by currency', async () => {
    await agentA
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(
        subscriptionInput({
          name: 'FX USD Monthly',
          vendorName: 'FX Vendor',
          amountMinor: 1000,
          currency: 'USD',
          startDate: today,
          nextRenewalDate: addDaysIso(today, 3),
        }),
      )
      .expect(201);
    await agentA
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(
        subscriptionInput({
          name: 'FX EUR Monthly',
          vendorName: 'FX Vendor EU',
          amountMinor: 5000,
          currency: 'EUR',
          startDate: today,
          nextRenewalDate: addDaysIso(today, 4),
        }),
      )
      .expect(201);

    const summary = await agentA.get(`/api/v1/${orgA()}/dashboard/summary`).expect(200);
    const list = await agentA.get(`/api/v1/${orgA()}/subscriptions?view=all&pageSize=100`).expect(200);

    const items = list.body.items as Array<{
      id: string;
      status: string;
      archivedAt: string | null;
      currency: string;
      monthlyEquivalentMinor: number;
    }>;
    const isBilled = (item: (typeof items)[number]) =>
      item.archivedAt === null && ['active', 'trial', 'cancel_planned'].includes(item.status);

    const expected = new Map<string, number>();
    for (const item of items.filter(isBilled)) {
      expected.set(item.currency, (expected.get(item.currency) ?? 0) + item.monthlyEquivalentMinor);
    }

    expect(summary.body.monthlyRecurringByCurrency).toEqual(
      [...expected.entries()]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => b.amountMinor - a.amountMinor || a.currency.localeCompare(b.currency)),
    );
    expect(summary.body.annualizedByCurrency).toEqual(
      summary.body.monthlyRecurringByCurrency.map(
        (entry: { currency: string; amountMinor: number }) => ({
          currency: entry.currency,
          amountMinor: entry.amountMinor * 12,
        }),
      ),
    );
    expect(summary.body.activeCount + summary.body.trialCount + summary.body.cancelPlannedCount).toBe(
      items.filter(isBilled).length,
    );

    const ids = new Set(items.map((item) => item.id));
    for (const window of ['next7Days', 'next30Days', 'next90Days'] as const) {
      for (const entry of summary.body.renewals[window] as Array<{ subscriptionId: string }>) {
        expect(ids.has(entry.subscriptionId)).toBe(true);
      }
    }
    expect(summary.body.renewals.next7Days.length).toBeLessThanOrEqual(
      summary.body.renewals.next30Days.length,
    );
    expect(summary.body.currencyGroupingNotice).toMatch(/never added together/i);
  });

  it('reports no money at all for an empty workspace', async () => {
    const empty = await seedTenant(context, {
      email: 'http-empty@test.local',
      organizationName: 'HTTP Empty Workspace',
    });
    const agent = request.agent(context.app);
    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'http-empty@test.local', password: TEST_PASSWORD })
      .expect(200);

    const summary = await agent.get(`/api/v1/${empty.organization.id}/dashboard/summary`).expect(200);
    expect(summary.body.monthlyRecurringByCurrency).toEqual([]);
    expect(summary.body.annualizedByCurrency).toEqual([]);
    expect(summary.body.renewals.next7Days).toEqual([]);
    expect(summary.body.priceIncreases).toEqual([]);
    expect(summary.body.activeCount).toBe(0);
  });
});

describe('integrations tell the truth', () => {
  it('reports email as not configured while no provider exists', async () => {
    const response = await agentA.get(`/api/v1/${orgA()}/integrations`).expect(200);
    const email = response.body.integrations.find(
      (entry: { provider: string }) => entry.provider === 'email_smtp',
    );
    expect(email.status).toBe('not_configured');
    expect(email.connected).toBe(false);
    expect(email.deliversMessages).toBe(false);
    expect(email.setupGuide.length).toBeGreaterThan(0);
    expect(response.body.email.deliversMessages).toBe(false);
  });

  it('reports the bank feed as configuration required, never as connected', async () => {
    const response = await agentA.get(`/api/v1/${orgA()}/integrations`).expect(200);
    const bank = response.body.integrations.find(
      (entry: { provider: string }) => entry.provider === 'bank_transaction_feed',
    );
    expect(bank.status).toBe('not_configured');
    expect(bank.connected).toBe(false);
    expect(bank.capabilities).toEqual(expect.arrayContaining([expect.stringContaining('CSV')]));
  });

  it('fails the verification honestly instead of simulating success', async () => {
    const email = await agentA.post(`/api/v1/${orgA()}/integrations/email_smtp/test`).send({}).expect(200);
    expect(email.body.ok).toBe(false);
    expect(email.body.status).toBe('error');
    expect(email.body.detail).toMatch(/no email provider is configured/i);

    const bank = await agentA
      .post(`/api/v1/${orgA()}/integrations/bank_transaction_feed/test`)
      .send({})
      .expect(200);
    expect(bank.body.ok).toBe(false);
    expect(bank.body.status).toBe('not_configured');
    expect(bank.body.detail).toMatch(/CSV import/i);
  });

  it('never claims a delivery it cannot observe', async () => {
    const response = await agentA
      .post(`/api/v1/${orgA()}/integrations/email_smtp/test-message`)
      .send({ to: 'someone@example.test' })
      .expect(200);
    expect(response.body.accepted).toBe(false);
    // The point of the test: acceptance and delivery are different claims.
    expect(response.body.deliveryConfirmed).toBe(false);
    expect(response.body.note).toMatch(/does not report delivery|rejected/i);
  });

  it('refuses to store credentials without an encryption key', async () => {
    const response = await agentA
      .put(`/api/v1/${orgA()}/integrations/email_smtp`)
      .send({ credentials: { host: 'smtp.example.test' }, enabled: true })
      .expect(422);
    expect(response.body.error.message).toMatch(/ENCRYPTION_KEY/);
  });

  it('refuses to pretend a bank feed can be connected at all', async () => {
    const response = await agentA
      .put(`/api/v1/${orgA()}/integrations/bank_transaction_feed`)
      .send({ credentials: { token: 'abc' }, enabled: true })
      .expect(422);
    expect(response.body.error.message).toMatch(/no bank or card feed provider is implemented/i);
  });

  it('rejects an unknown provider rather than creating a row for it', async () => {
    const response = await agentA.post(`/api/v1/${orgA()}/integrations/plaid/test`).send({});
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/insert|relation/i);
  });
});

describe('CSV export safety', () => {
  it('escapes formula-leading cells so a spreadsheet cannot execute them', async () => {
    const formula = '=HYPERLINK("http://attacker.test","click me")';
    await agentA
      .post(`/api/v1/${orgA()}/subscriptions`)
      .send(
        subscriptionInput({
          name: formula,
          vendorName: '@SUM(A1:A9)',
          startDate: today,
          nextRenewalDate: addDaysIso(today, 9),
        }),
      )
      .expect(201);

    const response = await agentA
      .post(`/api/v1/${orgA()}/exports/subscriptions`)
      .send({ dataset: 'subscriptions', filters: {} })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');

    const csv = response.text as unknown as string;
    const { header, rows } = parseCsv(csv);
    expect(header).toContain('name');
    expect(header).toContain('amount');
    expect(header).toContain('currency');

    const nameIndex = header.indexOf('name');
    const vendorIndex = header.indexOf('vendor');
    for (const row of rows) {
      expect(String(row[nameIndex]).startsWith('=')).toBe(false);
      expect(String(row[vendorIndex]).startsWith('@')).toBe(false);
    }
    // The formula survives as inert, quoted text with a leading apostrophe.
    expect(rows.some((row) => row[nameIndex] === `'${formula}`)).toBe(true);
    expect(rows.some((row) => row[vendorIndex] === "'@SUM(A1:A9)")).toBe(true);
  });

  it('always writes an amount in its own currency and never a combined total', async () => {
    const response = await agentA
      .post(`/api/v1/${orgA()}/exports/subscriptions`)
      .send({ dataset: 'subscriptions', filters: {} })
      .expect(200);
    const { header, rows } = parseCsv(response.text as unknown as string);
    const amountIndex = header.indexOf('amount');
    const currencyIndex = header.indexOf('currency');
    for (const row of rows) {
      expect(row[currencyIndex]).toMatch(/^[A-Z]{3}$/);
      expect(String(row[amountIndex])).toMatch(/^-?\d+(\.\d+)?$/);
    }
    expect(Number(response.headers['x-row-count'])).toBe(rows.length);
  });

  it('exports only this organization', async () => {
    const [mine, theirs] = await Promise.all([
      agentA
        .post(`/api/v1/${orgA()}/exports/subscriptions`)
        .send({ dataset: 'subscriptions', filters: {} })
        .expect(200),
      agentB
        .post(`/api/v1/${orgB()}/exports/subscriptions`)
        .send({ dataset: 'subscriptions', filters: {} })
        .expect(200),
    ]);
    expect(theirs.text).not.toContain('Tenant A Secret');
    expect(theirs.text).not.toBe(mine.text);
  });

  it('records the export in the audit trail', async () => {
    await agentA
      .post(`/api/v1/${orgA()}/exports/subscriptions`)
      .send({ dataset: 'subscriptions', filters: {} })
      .expect(200);
    const audit = await agentA.get(`/api/v1/${orgA()}/audit?action=data.exported`).expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    expect(audit.body.items[0].entityId).toBe('subscriptions');
  });
});

describe('malformed input is rejected, never crashed on', () => {
  it('rejects a non-UUID record id with 400', async () => {
    const response = await agentA.get(`/api/v1/${orgA()}/subscriptions/not-a-uuid`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(/pgdata|syntax for type|at Object/i);
  });

  it('rejects a malformed query date with 400', async () => {
    const response = await agentA.get(`/api/v1/${orgA()}/dashboard/summary?from=not-a-date`).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never leaks a driver error to the client for a bad organization id', async () => {
    const response = await agentA.get('/api/v1/not-a-uuid/subscriptions');
    // Whatever status the API chooses, the response must stay opaque.
    expect(JSON.stringify(response.body)).not.toMatch(/pgdata|syntax for type|DrizzleQueryError|at Object/i);
    expect([400, 404, 500]).toContain(response.status);
    if (response.status === 500) {
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).not.toMatch(/uuid|pgsql/i);
    }
  });
});