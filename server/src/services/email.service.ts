/**
 * Email outbox (Part E / E3.8).
 *
 * Every message is persisted before an attempt to send it, so an operator can
 * see exactly what was queued, what the provider accepted and what failed.
 *
 * Status vocabulary:
 *   queued -> sent   (the provider accepted the message)
 *          -> failed (provider rejected; permanent or temporary)
 *
 * "sent" means "accepted for delivery". RenewRadar never claims delivery,
 * because plain SMTP does not report it. When no provider is configured the
 * message is still recorded as `failed` with `not_configured`, and the UI
 * reports email as not configured rather than pretending it was delivered.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { emailMessages, emailTemplates } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { EmailAdapter } from '../integrations/email/types.js';
import {
  DEFAULT_TEMPLATES,
  renderPlainText,
  renderTemplate,
  type TemplateContext,
} from '../integrations/email/templates.js';

export interface QueueResult {
  messageId: string;
  deduplicated: boolean;
}

export class EmailService {
  constructor(
    private readonly db: AppDatabase,
    private readonly adapter: EmailAdapter,
    private readonly fromAddress: string,
  ) {}

  get provider(): EmailAdapter {
    return this.adapter;
  }

  get from(): string {
    return this.fromAddress;
  }

  /** Seed the default templates the first time an organization is created. */
  async seedTemplates(organizationId: string): Promise<void> {
    const existing = await this.db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(eq(emailTemplates.organizationId, organizationId))
      .limit(1);
    if (existing[0]) return;
    await this.db.insert(emailTemplates).values(
      DEFAULT_TEMPLATES.map((template) => ({
        organizationId,
        type: template.type,
        subject: template.subject,
        bodyHtml: template.bodyHtml,
      })),
    );
  }

  /** Persist a message without sending it. Returns `deduplicated` on replay. */
  async queue(input: {
    organizationId: string | null;
    templateType: string;
    to: string;
    subject: string;
    bodyText: string;
    relatedSubscriptionId?: string | null;
    reminderLogId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<QueueResult> {
    if (input.idempotencyKey) {
      const existing = await this.db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(eq(emailMessages.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) return { messageId: existing[0].id, deduplicated: true };
    }

    // The idempotency key is checked above; the unique index is partial
    // (`WHERE idempotency_key IS NOT NULL`) so it cannot be an ON CONFLICT target.
    const inserted = await this.db
      .insert(emailMessages)
      .values({
        organizationId: input.organizationId,
        templateType: input.templateType,
        toAddress: input.to,
        fromAddress: this.fromAddress,
        subject: input.subject,
        bodyText: input.bodyText,
        status: 'queued',
        relatedSubscriptionId: input.relatedSubscriptionId ?? null,
        reminderLogId: input.reminderLogId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: emailMessages.id });

    const row = inserted[0];
    if (!row) return { messageId: '', deduplicated: true };
    return { messageId: row.id, deduplicated: false };
  }

  /** Hand a queued message to the configured provider. */
  async deliver(messageId: string): Promise<{
    status: 'sent' | 'failed';
    retryable: boolean;
    message: string;
    providerMessageId: string | null;
  }> {
    const rows = await this.db.select().from(emailMessages).where(eq(emailMessages.id, messageId)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('Email message');

    const result = await this.adapter.send({
      to: row.toAddress,
      from: row.fromAddress,
      subject: row.subject,
      text: row.bodyText ?? '',
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    });

    if (result.accepted) {
      await this.db
        .update(emailMessages)
        .set({
          status: 'sent',
          providerMessageId: result.providerMessageId ?? null,
          sentAt: new Date(),
          failureCode: null,
          safeFailureMessage: null,
        })
        .where(eq(emailMessages.id, messageId));
      return {
        status: 'sent',
        retryable: false,
        message: result.message,
        providerMessageId: result.providerMessageId ?? null,
      };
    }

    const retryable = result.failureCode === 'temporary' || result.failureCode === 'provider_error';
    await this.db
      .update(emailMessages)
      .set({
        status: 'failed',
        failureCode: result.failureCode ?? 'provider_error',
        safeFailureMessage: result.message.slice(0, 300),
      })
      .where(eq(emailMessages.id, messageId));

    return { status: 'failed', retryable, message: result.message, providerMessageId: null };
  }

  /** Render an organization template and queue it. */
  async queueReminderEmail(input: {
    organizationId: string;
    to: string;
    templateType: string;
    context: TemplateContext;
    relatedSubscriptionId?: string | null;
    reminderLogId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<QueueResult> {
    const rows = await this.db
      .select()
      .from(emailTemplates)
      .where(
        and(eq(emailTemplates.organizationId, input.organizationId), eq(emailTemplates.type, input.templateType)),
      )
      .limit(1);
    const template = rows[0];
    const subjectTemplate =
      template?.subject ??
      '{{subscriptionName}} - {{eventTypeLabel}} on {{targetDate}}';
    const bodyTemplate =
      template?.bodyHtml ??
      '<p>{{subscriptionName}} ({{vendorName}}) - {{eventTypeLabel}} on {{targetDate}} for {{amount}}.</p>';

    return this.queue({
      organizationId: input.organizationId,
      templateType: input.templateType,
      to: input.to,
      subject: renderTemplate(subjectTemplate, input.context, false),
      bodyText: renderPlainText(bodyTemplate, input.context),
      relatedSubscriptionId: input.relatedSubscriptionId ?? null,
      reminderLogId: input.reminderLogId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  }

  async outbox(organizationId: string, limit = 50) {
    return this.db
      .select({
        id: emailMessages.id,
        templateType: emailMessages.templateType,
        toAddress: emailMessages.toAddress,
        subject: emailMessages.subject,
        status: emailMessages.status,
        providerMessageId: emailMessages.providerMessageId,
        failureCode: emailMessages.failureCode,
        safeFailureMessage: emailMessages.safeFailureMessage,
        sentAt: emailMessages.sentAt,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, organizationId))
      .orderBy(desc(emailMessages.createdAt))
      .limit(Math.min(limit, 200));
  }

  async stats(organizationId: string) {
    const rows = await this.db
      .select({ status: emailMessages.status, count: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, organizationId))
      .groupBy(emailMessages.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.count])) as Record<string, number>;
  }
}