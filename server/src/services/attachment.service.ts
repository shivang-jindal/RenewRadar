/**
 * Attachments (Part E / E5, E7).
 *
 * ## Storage boundary
 *
 * RenewRadar stores **metadata and a private storage reference only**. It never
 * accepts or serves file bytes itself, and it never exposes an object under a
 * guessable URL. Concretely:
 *
 *  1. The client uploads the file to the operator's own private object storage
 *     (for example an S3 bucket with public access blocked). The resulting
 *     object key is registered here with `POST /attachments`.
 *  2. `GET /attachments/:id/download` re-checks organization membership and
 *     subscription ownership, and **only then** mints a short-lived signed URL
 *     from the configured attachment signer.
 *  3. If no signer is configured the endpoint reports
 *     `INTEGRATION_UNAVAILABLE` with "Configuration required" - it never
 *     returns a link, and it never falls back to a public URL.
 *
 * ## What is enforced here
 *
 *  - every read and write is scoped by `organization_id`, so another tenant's
 *    attachment id is a 404;
 *  - content type and size are validated against an allow-list;
 *  - the stored file name is sanitised, and the original is never used as a
 *    path;
 *  - the audit trail records every download.
 */

import { and, desc, eq } from 'drizzle-orm';

import type { AttachmentView } from '@renewradar/shared';
import { ALLOWED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_BYTES } from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { attachments, subscriptions, users } from '../db/schema.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';

/**
 * Mints a short-lived URL for a private object. The default implementation is
 * unconfigured: it refuses rather than returning a guessable link.
 */
export interface AttachmentSigner {
  readonly configured: boolean;
  readonly setupHint: string;
  sign(input: {
    storageKey: string;
    organizationId: string;
    expiresInSeconds: number;
    downloadFilename: string;
    mimeType: string;
  }): Promise<string>;
}

export class UnconfiguredAttachmentSigner implements AttachmentSigner {
  readonly configured = false;
  readonly setupHint =
    'Attachment downloads need a private object store. Set up an S3-compatible bucket that blocks public access and configure the signer (see docs/INTEGRATIONS.md). Until then attachments are listed as metadata only and no download link is produced.';

  async sign(): Promise<string> {
    throw unprocessable(
      'Configuration required: no private object store is configured, so RenewRadar cannot issue a download link. The attachment metadata is stored; the bytes stay in your own storage.',
    );
  }
}

export class AttachmentService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
    private readonly signer: AttachmentSigner,
  ) {}

  get storageConfigured(): boolean {
    return this.signer.configured;
  }

  get storageSetupHint(): string {
    return this.signer.setupHint;
  }

  async list(organizationId: string, subscriptionId: string): Promise<AttachmentView[]> {
    const rows = await this.db
      .select({
        id: attachments.id,
        subscriptionId: attachments.subscriptionId,
        originalFilenameSafe: attachments.originalFilenameSafe,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        uploadedBy: attachments.uploadedBy,
        uploadedByName: users.displayName,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .leftJoin(users, eq(users.id, attachments.uploadedBy))
      .where(and(eq(attachments.organizationId, organizationId), eq(attachments.subscriptionId, subscriptionId)))
      .orderBy(desc(attachments.createdAt));

    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      originalFilenameSafe: row.originalFilenameSafe,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      uploadedBy: row.uploadedBy,
      uploadedByName: row.uploadedByName,
      createdAt: row.createdAt.toISOString(),
      downloadUrl: null,
      storageConfigured: this.signer.configured,
    }));
  }

  async register(input: {
    organizationId: string;
    subscriptionId: string;
    actorUserId: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    requestId?: string | null;
  }): Promise<AttachmentView> {
    // Ownership check inside the same tenant before anything is written.
    const subscription = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, input.subscriptionId),
          eq(subscriptions.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!subscription[0]) throw notFound('Subscription');

    if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
      throw unprocessable(
        `Attachments are limited to: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}.`,
        { mimeType: ['Unsupported file type'] },
      );
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw unprocessable(
        `Attachments are limited to ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
        { sizeBytes: ['File is empty or too large'] },
      );
    }
    if (!input.storageKey.trim()) {
      throw badRequest('A private storage key is required.', { storageKey: ['Required'] });
    }
    // The key is an opaque reference; reject anything that looks like a path
    // traversal or an absolute URL.
    if (/^[a-z]+:\/\//i.test(input.storageKey) || input.storageKey.includes('..')) {
      throw badRequest('The storage key must be a relative object key inside your private bucket.', {
        storageKey: ['Use a relative object key'],
      });
    }

    const inserted = await this.db
      .insert(attachments)
      .values({
        organizationId: input.organizationId,
        subscriptionId: input.subscriptionId,
        storageKey: input.storageKey.trim(),
        originalFilenameSafe: sanitizeFilename(input.originalFilename),
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedBy: input.actorUserId,
      })
      .returning();

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'attachment.registered',
      entityType: 'attachment',
      entityId: inserted[0]!.id,
      metadata: { mimeType: input.mimeType, sizeBytes: input.sizeBytes, subscriptionId: input.subscriptionId },
      requestId: input.requestId ?? null,
    });

    return {
      id: inserted[0]!.id,
      subscriptionId: input.subscriptionId,
      originalFilenameSafe: inserted[0]!.originalFilenameSafe,
      mimeType: inserted[0]!.mimeType,
      sizeBytes: Number(inserted[0]!.sizeBytes),
      uploadedBy: input.actorUserId,
      uploadedByName: null,
      createdAt: inserted[0]!.createdAt.toISOString(),
      downloadUrl: null,
      storageConfigured: this.signer.configured,
    };
  }

  /**
   * Issue a short-lived signed URL after re-checking access.
   *
   * Access is checked here, not in the UI and not by the storage provider: the
   * object is private precisely because the application is the only component
   * that may hand out a link.
   */
  async downloadUrl(input: {
    organizationId: string;
    attachmentId: string;
    actorUserId: string;
  }): Promise<{ url: string; expiresInSeconds: number }> {
    const rows = await this.db
      .select({
        id: attachments.id,
        storageKey: attachments.storageKey,
        originalFilenameSafe: attachments.originalFilenameSafe,
        mimeType: attachments.mimeType,
      })
      .from(attachments)
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.id, attachments.subscriptionId),
          eq(subscriptions.organizationId, attachments.organizationId),
        ),
      )
      .where(and(eq(attachments.id, input.attachmentId), eq(attachments.organizationId, input.organizationId)))
      .limit(1);

    const row = rows[0];
    // Cross-tenant ids are indistinguishable from a missing attachment.
    if (!row) throw notFound('Attachment');

    const url = await this.signer.sign({
      storageKey: row.storageKey,
      organizationId: input.organizationId,
      expiresInSeconds: 300,
      downloadFilename: row.originalFilenameSafe,
      mimeType: row.mimeType,
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'attachment.download_issued',
      entityType: 'attachment',
      entityId: input.attachmentId,
      metadata: { mimeType: row.mimeType },
    });

    return { url, expiresInSeconds: 300 };
  }

  async remove(input: {
    organizationId: string;
    attachmentId: string;
    actorUserId: string;
  }): Promise<void> {
    const deleted = await this.db
      .delete(attachments)
      .where(
        and(eq(attachments.id, input.attachmentId), eq(attachments.organizationId, input.organizationId)),
      )
      .returning({ id: attachments.id });
    if (!deleted[0]) throw notFound('Attachment');
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'attachment.removed',
      entityType: 'attachment',
      entityId: input.attachmentId,
    });
  }
}

export function sanitizeFilename(value: string): string {
  return (
    value
      .split(/[\\/]/)
      .pop()!
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/\.{2,}/g, '.')
      .slice(0, 120) || 'document'
  );
}