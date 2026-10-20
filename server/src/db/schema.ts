/**
 * RenewRadar database schema (Part E / E5).
 *
 * - UUID primary keys, `timestamptz` UTC timestamps.
 * - Every tenant-owned table carries `organization_id` and is indexed on it.
 * - Money is `bigint` minor units (integer cents/paise). It is never a float.
 * - Calendar dates (`start_date`, `next_renewal_date`, ...) are stored as
 *   PostgreSQL `date` columns in the server's `YYYY-MM-DD` text mode so the
 *   round trip never depends on the machine timezone of the driver.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const now = sql`now()`;

/** Every calendar-date column is an ISO `YYYY-MM-DD` value. */
const isoDate = (name: string) => date(name, { mode: 'string' });

/* -------------------------------------------------------------------------- */
/* Shared foundation (Part A / A5)                                             */
/* -------------------------------------------------------------------------- */

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    countryCode: text('country_code').notNull().default('US'),
    timezone: text('timezone').notNull().default('UTC'),
    baseCurrency: text('base_currency').notNull().default('USD'),
    logoUrl: text('logo_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('organizations_slug_idx').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** Argon2id hash produced by `@node-rs/argon2`; never a hand-rolled KDF. */
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('memberships_org_user_idx').on(table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque session token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    activeOrganizationId: uuid('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    /** SHA-256 of the single-use invite token. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_idx').on(table.tokenHash),
    index('invitations_org_idx').on(table.organizationId),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('password_reset_token_hash_idx').on(table.tokenHash)],
);

/**
 * Per-organization defaults for scheduling and reminders.
 *
 * `quiet_hours_*` and `reminder_time_local` are local wall-clock values in
 * `organizations.timezone`; daylight-saving rules come from the platform's
 * `Intl` implementation, never from a hand-rolled offset.
 */
export const organizationSettings = pgTable('organization_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  quietHoursStart: text('quiet_hours_start'),
  quietHoursEnd: text('quiet_hours_end'),
  reminderTimeLocal: text('reminder_time_local').notNull().default('09:00'),
  remindersPaused: boolean('reminders_paused').notNull().default(true),
  defaultRenewalReminderDays: integer('default_renewal_reminder_days').notNull().default(7),
  defaultTrialReminderDays: integer('default_trial_reminder_days').notNull().default(3),
  defaultCancellationReminderDays: integer('default_cancellation_reminder_days').notNull().default(14),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

/* -------------------------------------------------------------------------- */
/* Categories (Part E / E5)                                                    */
/* -------------------------------------------------------------------------- */

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    colorToken: text('color_token').notNull().default('slate'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('categories_org_name_idx').on(table.organizationId, table.name)],
);

/* -------------------------------------------------------------------------- */
/* Subscriptions (Part E / E5)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Money rule: integer minor units only.
 * Status rule: `cancel_planned` is an intention, `cancelled` is a confirmation.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    vendorName: text('vendor_name').notNull(),
    planName: text('plan_name'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    intervalUnit: text('interval_unit').notNull().default('monthly'),
    intervalCount: integer('interval_count').notNull().default(1),
    /** Billing anchor. Its day-of-month drives the month-end rule. */
    startDate: isoDate('start_date').notNull(),
    nextRenewalDate: isoDate('next_renewal_date').notNull(),
    trialEndDate: isoDate('trial_end_date'),
    cancellationDeadline: isoDate('cancellation_deadline'),
    renewalType: text('renewal_type').notNull().default('auto'),
    status: text('status').notNull().default('active'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Label only, e.g. "Company card". Never a card number or credential. */
    paymentMethodLabel: text('payment_method_label'),
    vendorUrl: text('vendor_url'),
    cancellationUrl: text('cancellation_url'),
    notes: text('notes'),
    personalOrBusiness: text('personal_or_business').notNull().default('business'),
    timezone: text('timezone').notNull().default('UTC'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    index('subscriptions_org_status_idx').on(table.organizationId, table.status),
    index('subscriptions_org_renewal_idx').on(table.organizationId, table.nextRenewalDate),
    index('subscriptions_org_category_idx').on(table.organizationId, table.categoryId),
    index('subscriptions_org_owner_idx').on(table.organizationId, table.ownerUserId),
    index('subscriptions_org_vendor_idx').on(table.organizationId, table.vendorName),
    check('subscriptions_amount_positive', sql`${table.amountMinor} > 0`),
    check('subscriptions_interval_count_positive', sql`${table.intervalCount} > 0`),
  ],
);

export const subscriptionPriceHistory = pgTable(
  'subscription_price_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    oldAmountMinor: bigint('old_amount_minor', { mode: 'number' }),
    /** Currency of the previous price; a currency change alone is never a rise. */
    oldCurrency: text('old_currency'),
    newAmountMinor: bigint('new_amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    effectiveDate: isoDate('effective_date').notNull(),
    source: text('source').notNull().default('manual'),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('subscription_price_history_sub_idx').on(table.subscriptionId, table.effectiveDate),
    index('subscription_price_history_org_idx').on(table.organizationId, table.createdAt),
  ],
);

export const subscriptionDecisions = pgTable(
  'subscription_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    reason: text('reason'),
    reviewOn: isoDate('review_on'),
    /** Only set once a human confirmed the cancellation with the vendor. */
    cancellationConfirmedAt: isoDate('cancellation_confirmed_at'),
    cancellationReference: text('cancellation_reference'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('subscription_decisions_sub_idx').on(table.subscriptionId, table.recordedAt),
    index('subscription_decisions_org_idx').on(table.organizationId, table.recordedAt),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    period: text('period').notNull().default('monthly'),
    thresholdPercent: integer('threshold_percent').notNull().default(80),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('budgets_org_idx').on(table.organizationId, table.enabled),
    check('budgets_amount_positive', sql`${table.amountMinor} > 0`),
    check(
      'budgets_threshold_range',
      sql`${table.thresholdPercent} between 1 and 200`,
    ),
  ],
);

export const reminderRules = pgTable(
  'reminder_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    daysBefore: integer('days_before').notNull(),
    channel: text('channel').notNull().default('in_app'),
    enabled: boolean('enabled').notNull().default(false),
    quietHours: jsonb('quiet_hours_json').$type<{ start: string; end: string } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('reminder_rules_org_slot_idx').on(
      table.organizationId,
      table.eventType,
      table.daysBefore,
      table.channel,
    ),
    index('reminder_rules_org_idx').on(table.organizationId, table.enabled),
    check('reminder_rules_days_non_negative', sql`${table.daysBefore} >= 0`),
  ],
);

/**
 * One row per (subscription, event type, target date, recipient, channel).
 *
 * The unique idempotency key is what stops a duplicate reminder from being
 * delivered twice when a job is retried or rescheduled (Part E / E3.8).
 */
export const reminderLogs = pgTable(
  'reminder_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    targetDate: isoDate('target_date').notNull(),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
    channel: text('channel').notNull().default('in_app'),
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    idempotencyKey: text('idempotency_key').notNull(),
    subject: text('subject'),
    snoozedUntil: isoDate('snoozed_until'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('reminder_logs_idempotency_idx').on(table.idempotencyKey),
    index('reminder_logs_org_status_idx').on(table.organizationId, table.status),
    index('reminder_logs_sub_idx').on(table.subscriptionId, table.targetDate),
    index('reminder_logs_target_date_idx').on(table.organizationId, table.targetDate),
  ],
);

export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Only the basename, sanitised; the browser's path never reaches storage. */
    filenameSafe: text('filename_safe').notNull(),
    status: text('status').notNull().default('preview'),
    columns: jsonb('columns_json').$type<string[]>().notNull().default([]),
    mapping: jsonb('mapping_json').$type<Record<string, string>>().notNull().default({}),
    rowCounts: jsonb('row_counts_json')
      .$type<{ total: number; valid: number; duplicates: number; invalid: number }>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('imports_org_idx').on(table.organizationId, table.createdAt)],
);

export const importRowErrors = pgTable(
  'import_row_errors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    importId: uuid('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    errorCode: text('error_code').notNull(),
    safeMessage: text('safe_message').notNull(),
    /** The raw row, kept for the downloadable error report. Never other tenants. */
    redactedRow: jsonb('redacted_row_json').$type<Record<string, string>>(),
  },
  (table) => [index('import_row_errors_import_idx').on(table.importId, table.rowNumber)],
);

/**
 * Attachments hold metadata and a **private** storage reference only.
 *
 * RenewRadar never stores or serves file bytes itself: `storage_key` points at
 * an object the operator placed in private storage. The API performs the
 * authorization check and only then mints a short-lived signed URL from
 * `ATTACHMENT_SIGNING_*` settings, so a document is never reachable by an
 * unguessable public path. See docs/INTEGRATIONS.md.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    originalFilenameSafe: text('original_filename_safe').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('attachments_sub_idx').on(table.subscriptionId),
    index('attachments_org_idx').on(table.organizationId),
    check('attachments_size_positive', sql`${table.sizeBytes} > 0`),
  ],
);

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('not_configured'),
    /** AES-256-GCM envelope; the plaintext key never leaves the server. */
    encryptedCredentials: text('encrypted_credentials_json'),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('integrations_org_provider_idx').on(table.organizationId, table.provider)],
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('email_templates_org_type_idx').on(table.organizationId, table.type)],
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nullable: password-reset mail is sent before any organization exists. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    templateType: text('template_type').notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    /** Plain-text alternative; never store raw secrets. */
    bodyText: text('body_text'),
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    relatedSubscriptionId: uuid('related_subscription_id'),
    reminderLogId: uuid('reminder_log_id'),
    idempotencyKey: text('idempotency_key'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('email_messages_org_status_idx').on(table.organizationId, table.status),
    uniqueIndex('email_messages_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Redacted metadata only - never credentials or personal data. */
    metadata: jsonb('metadata_json').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('audit_events_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_events_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().default(now),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('background_jobs_claim_idx').on(table.status, table.runAfter),
    index('background_jobs_org_idx').on(table.organizationId, table.createdAt),
    uniqueIndex('background_jobs_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                   */
/* -------------------------------------------------------------------------- */

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  memberships: many(memberships),
  categories: many(categories),
  subscriptions: many(subscriptions),
  budgets: many(budgets),
  reminderRules: many(reminderRules),
  settings: one(organizationSettings, {
    fields: [organizations.id],
    references: [organizationSettings.organizationId],
  }),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const categoriesRelations = relations(categories, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [categories.organizationId],
    references: [organizations.id],
  }),
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [subscriptions.organizationId],
    references: [organizations.id],
  }),
  category: one(categories, {
    fields: [subscriptions.categoryId],
    references: [categories.id],
  }),
  owner: one(users, { fields: [subscriptions.ownerUserId], references: [users.id] }),
  priceHistory: many(subscriptionPriceHistory),
  decisions: many(subscriptionDecisions),
  reminders: many(reminderLogs),
  attachments: many(attachments),
}));

export const subscriptionPriceHistoryRelations = relations(
  subscriptionPriceHistory,
  ({ one }) => ({
    subscription: one(subscriptions, {
      fields: [subscriptionPriceHistory.subscriptionId],
      references: [subscriptions.id],
    }),
  }),
);

export const subscriptionDecisionsRelations = relations(subscriptionDecisions, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionDecisions.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const budgetsRelations = relations(budgets, ({ one }) => ({
  organization: one(organizations, {
    fields: [budgets.organizationId],
    references: [organizations.id],
  }),
  category: one(categories, { fields: [budgets.categoryId], references: [categories.id] }),
}));

export const reminderLogsRelations = relations(reminderLogs, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [reminderLogs.subscriptionId],
    references: [subscriptions.id],
  }),
  recipient: one(users, { fields: [reminderLogs.recipientUserId], references: [users.id] }),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [attachments.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const importsRelations = relations(imports, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [imports.organizationId],
    references: [organizations.id],
  }),
  rowErrors: many(importRowErrors),
}));

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionPriceHistory = typeof subscriptionPriceHistory.$inferSelect;
export type SubscriptionDecision = typeof subscriptionDecisions.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type ReminderRule = typeof reminderRules.$inferSelect;
export type ReminderLog = typeof reminderLogs.$inferSelect;
export type ImportRecord = typeof imports.$inferSelect;
export type ImportRowError = typeof importRowErrors.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type BackgroundJob = typeof backgroundJobs.$inferSelect;