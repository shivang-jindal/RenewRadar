/**
 * Audit trail (Part A / A5).
 *
 * Role changes, integration changes, destructive operations, decision
 * overrides and data exports are recorded. Metadata is redacted before it is
 * stored (Part A / A11: never log secrets or personal data).
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { Paginated } from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { redactObject } from '../logger.js';

export interface AuditInput {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ipAddress?: string | null;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  entityType?: string;
  entityId?: string;
  action?: string;
}

export class AuditService {
  constructor(private readonly db: AppDatabase) {}

  async record(input: AuditInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata ? redactObject(input.metadata) : null,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
    });
  }

  async list(
    organizationId: string,
    query: AuditQuery,
  ): Promise<Paginated<{ id: string; action: string; entityType: string; entityId: string | null; metadata: Record<string, unknown> | null; actorName: string | null; createdAt: string }>> {
    const filters = [eq(auditEvents.organizationId, organizationId)];
    if (query.entityType) filters.push(eq(auditEvents.entityType, query.entityType));
    if (query.entityId) filters.push(eq(auditEvents.entityId, query.entityId));
    if (query.action) filters.push(eq(auditEvents.action, query.action));

    const where = and(...filters);
    const rows = await this.db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        metadata: auditEvents.metadata,
        actorName: sql<string | null>`(
          SELECT display_name FROM users WHERE users.id = ${auditEvents.actorUserId}
        )`,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(where);
    const total = countRows[0]?.count ?? 0;

    return {
      items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /** Timeline for a single entity, used by the subscription detail page. */
  async forEntity(entityType: string, entityId: string, limit = 50) {
    const rows = await this.db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      title: humanizeAction(row.action),
      detail: describeMetadata(row.metadata),
    }));
  }
}

export function humanizeAction(action: string): string {
  return action
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function describeMetadata(metadata: Record<string, unknown> | null): string | undefined {
  if (!metadata) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      parts.push(`${key}: ${value.join(', ') || '(none)'}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}: ${Object.keys(value as Record<string, unknown>).join(', ') || '(none)'}`);
    } else {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}