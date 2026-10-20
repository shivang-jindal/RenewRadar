/**
 * Integrations (Part A / A4.12, Part E / E3.10).
 *
 * Each integration reports a truthful status, a setup guide, a verification
 * action and a graceful disconnected state. Credentials are encrypted at rest
 * with AES-256-GCM and never returned to the browser.
 *
 * RenewRadar ships **no connected vendor integration**. Manual entry and CSV
 * import are the supported paths (Part E / E1). `bank_transaction_feed` is
 * listed as a documented boundary that is explicitly *not configured*, so the
 * UI can say "Configuration required" instead of implying a connection exists.
 */

import { and, eq } from 'drizzle-orm';

import type { IntegrationStatus, IntegrationStatusView } from '@renewradar/shared';
import { INTEGRATION_STATUSES } from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { emailMessages, integrations } from '../db/schema.js';
import { notFound, unprocessable } from '../errors.js';
import { maskSecret, openCredentials, sealCredentials } from '../lib/crypto.js';
import type { AuditService } from './audit.service.js';

export type IntegrationProvider = 'email_smtp' | 'bank_transaction_feed';

const BANK_FEED_LIMITATIONS = [
  'RenewRadar does not access a bank account and never asks for bank credentials.',
  'No bank, card or transaction-feed provider is implemented. Import a CSV export from your bank instead - that path is fully supported.',
  'Until a provider with an authorised, scoped API connection exists, this integration is reported as "Configuration required" rather than connected.',
];

const BANK_FEED_CAPABILITIES = [
  'Nothing is imported automatically',
  'CSV import covers the same data with a full preview and duplicate review',
];

/**
 * The `status` column is plain text, so an unknown value (a row written by an
 * older build, or a manual edit) must never leak into the API as a status the
 * UI does not understand. Unknown values degrade to `not_configured`.
 */
export function asIntegrationStatus(value: string | null | undefined): IntegrationStatus {
  return (INTEGRATION_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as IntegrationStatus)
    : 'not_configured';
}

export class IntegrationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
    private readonly encryptionKey: Buffer | null,
    private readonly emailProbe: () => Promise<{ ok: boolean; detail: string }>,
    private readonly emailSetupHint: string,
    private readonly emailDeliversMessages: boolean,
  ) {}

  async list(organizationId: string): Promise<IntegrationStatusView[]> {
    const rows = await this.db
      .select()
      .from(integrations)
      .where(eq(integrations.organizationId, organizationId));

    const email = rows.find((row) => row.provider === 'email_smtp');
    const bank = rows.find((row) => row.provider === 'bank_transaction_feed');
    const verification = await this.emailProbe();

    return [
      {
        provider: 'email_smtp',
        label: 'Email (SMTP)',
        status: email ? asIntegrationStatus(email.status) : verification.ok ? 'configured' : 'not_configured',
        // `connected` is only true when the provider is really usable now.
        connected: verification.ok && email?.status !== 'error',
        deliversMessages: this.emailDeliversMessages,
        lastCheckedAt: email?.lastCheckedAt?.toISOString() ?? null,
        lastErrorCode: email?.lastErrorCode ?? null,
        lastErrorMessage: email?.lastErrorMessage ?? null,
        maskedKeys: email ? await this.describeKeys(organizationId, 'email_smtp') : [],
        setupGuide: [
          this.emailSetupHint,
          'Create or use an SMTP account with your mail provider. Start with sandbox credentials.',
          'Save the host, port, username and password below. Credentials are encrypted with AES-256-GCM before they are stored.',
          'Use "Verify connection" to confirm the provider accepts a connection, then "Send test email".',
          'Only after the provider accepts a message does RenewRadar show it as sent. SMTP does not report delivery, so RenewRadar never claims an email was delivered.',
        ],
        capabilities: [
          'Email renewal, trial-end and cancellation-deadline reminders',
          'Send a test message to any address you enter',
        ],
        limitations: [
          'Delivery, bounce and open status are not available with plain SMTP.',
          'While email is not configured, reminders still appear in-app and the UI reports email as not configured.',
        ],
      },
      {
        provider: 'bank_transaction_feed',
        label: 'Bank / card transaction feed',
        status: asIntegrationStatus(bank?.status),
        connected: false,
        deliversMessages: false,
        lastCheckedAt: bank?.lastCheckedAt?.toISOString() ?? null,
        lastErrorCode: bank?.lastErrorCode ?? null,
        lastErrorMessage: bank?.lastErrorMessage ?? null,
        maskedKeys: [],
        setupGuide: [
          'No bank or card feed provider is implemented in this release.',
          'RenewRadar never asks for a bank password, a card number, a CVV or a provider password.',
          'Use Import/Export to bring subscriptions in from a bank statement CSV instead.',
        ],
        capabilities: BANK_FEED_CAPABILITIES,
        limitations: BANK_FEED_LIMITATIONS,
      },
    ];
  }

  async save(input: {
    organizationId: string;
    provider: IntegrationProvider;
    actorUserId: string;
    credentials: Record<string, string>;
    enabled: boolean;
  }): Promise<IntegrationStatusView> {
    if (input.provider === 'bank_transaction_feed') {
      throw unprocessable(
        'No bank or card feed provider is implemented, so there is nothing to connect. Use CSV import instead.',
      );
    }
    if (Object.keys(input.credentials).length > 0 && !this.encryptionKey) {
      throw unprocessable(
        'ENCRYPTION_KEY is not configured on the server, so credentials cannot be stored safely. Set ENCRYPTION_KEY and restart the API. Email from the SMTP host is already used for outbound mail.',
      );
    }

    const existing = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.organizationId, input.organizationId),
          eq(integrations.provider, input.provider),
        ),
      )
      .limit(1);

    const sealed =
      Object.keys(input.credentials).length > 0 && this.encryptionKey
        ? sealCredentials(this.encryptionKey, input.credentials)
        : (existing[0]?.encryptedCredentials ?? null);

    const values = {
      encryptedCredentials: sealed,
      status: sealed ? ('configured' as const) : ('not_configured' as const),
      enabled: input.enabled,
      updatedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    if (existing[0]) {
      await this.db.update(integrations).set(values).where(eq(integrations.id, existing[0].id));
    } else {
      await this.db.insert(integrations).values({
        organizationId: input.organizationId,
        provider: input.provider,
        ...values,
      });
    }

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'integration.updated',
      entityType: 'integration',
      entityId: input.provider,
      metadata: { keys: Object.keys(input.credentials), enabled: input.enabled },
    });

    const views = await this.list(input.organizationId);
    return views.find((view) => view.provider === input.provider)!;
  }

  /**
   * Real verification against the configured provider.
   * Reports `false` with an explanation when nothing is configured; it never
   * reports a simulated success.
   */
  async test(
    organizationId: string,
    provider: IntegrationProvider,
    actorUserId: string,
  ): Promise<{ ok: boolean; detail: string; status: IntegrationStatusView['status'] }> {
    if (provider === 'bank_transaction_feed') {
      const detail =
        'No bank or card feed provider is implemented. RenewRadar cannot verify a provider it has no adapter for. Use CSV import instead.';
      await this.persistProbe(organizationId, provider, actorUserId, false, detail, 'not_configured');
      return { ok: false, detail, status: 'not_configured' };
    }

    const result = await this.emailProbe();
    await this.persistProbe(organizationId, provider, actorUserId, result.ok, result.detail);
    return {
      ok: result.ok,
      detail: result.detail,
      status: result.ok ? 'configured' : 'error',
    };
  }

  async sendTestEmail(input: {
    organizationId: string;
    actorUserId: string;
    to: string;
    send: (message: { to: string; from: string; subject: string; text: string }) => Promise<{
      accepted: boolean;
      status: 'accepted' | 'rejected';
      providerMessageId?: string;
      message: string;
    }>;
    from: string;
  }) {
    const result = await input.send({
      to: input.to,
      from: input.from,
      subject: 'RenewRadar test email',
      text: [
        'This is a test message from RenewRadar.',
        '',
        'If you received it, the email provider accepted the message. RenewRadar cannot confirm delivery because plain SMTP does not report it.',
      ].join('\n'),
    });

    await this.db.insert(emailMessages).values({
      organizationId: input.organizationId,
      templateType: 'test',
      toAddress: input.to,
      fromAddress: input.from,
      subject: 'RenewRadar test email',
      bodyText: 'RenewRadar test message.',
      status: result.accepted ? 'sent' : 'failed',
      providerMessageId: result.providerMessageId ?? null,
      safeFailureMessage: result.accepted ? null : result.message.slice(0, 300),
      sentAt: result.accepted ? new Date() : null,
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'integration.test_email_sent',
      entityType: 'integration',
      entityId: 'email_smtp',
      metadata: { accepted: result.accepted },
    });

    return result;
  }

  async clear(organizationId: string, provider: IntegrationProvider, actorUserId: string): Promise<void> {
    const updated = await this.db
      .update(integrations)
      .set({
        encryptedCredentials: null,
        status: 'not_configured',
        enabled: false,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
      )
      .returning({ id: integrations.id });
    if (!updated[0]) throw notFound('Integration');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'integration.disconnected',
      entityType: 'integration',
      entityId: provider,
    });
  }

  async credentials(organizationId: string, provider: IntegrationProvider): Promise<Record<string, string>> {
    if (!this.encryptionKey) return {};
    const rows = await this.db
      .select()
      .from(integrations)
      .where(
        and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
      )
      .limit(1);
    const sealed = rows[0]?.encryptedCredentials;
    if (!sealed) return {};
    try {
      return openCredentials(this.encryptionKey, sealed);
    } catch {
      // A key rotation makes old ciphertext unreadable; report it as empty
      // rather than crashing the settings screen.
      return {};
    }
  }

  private async describeKeys(organizationId: string, provider: IntegrationProvider) {
    const values = await this.credentials(organizationId, provider);
    return Object.entries(values).map(([key, value]) => ({ key, masked: maskSecret(value) ?? '' }));
  }

  private async persistProbe(
    organizationId: string,
    provider: IntegrationProvider,
    actorUserId: string,
    ok: boolean,
    detail: string,
    status?: IntegrationStatusView['status'],
  ): Promise<void> {
    const existing = await this.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)),
      )
      .limit(1);
    const values = {
      lastCheckedAt: new Date(),
      lastErrorCode: ok ? null : 'verification_failed',
      lastErrorMessage: ok ? null : detail.slice(0, 300),
      status: status ?? (ok ? ('configured' as const) : ('error' as const)),
      updatedAt: new Date(),
    };
    if (existing[0]) {
      await this.db.update(integrations).set(values).where(eq(integrations.id, existing[0].id));
    } else {
      await this.db.insert(integrations).values({ organizationId, provider, ...values });
    }
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'integration.tested',
      entityType: 'integration',
      entityId: provider,
      metadata: { ok },
    });
  }
}