/** Domain constants shared by the RenewRadar server and client (Part E). */

export const PRODUCT_NAME = 'RenewRadar';

/** Roles (Part A / A5). */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/**
 * Permission flags (Part E / E2).
 *
 * `owner` and `admin` implicitly hold every flag except `ownership.transfer`
 * and `organization.delete`, which are owner-only. `viewer` is read-only: it
 * holds no write permission at all, which is enforced server-side by
 * `requirePermission`.
 */
export const PERMISSIONS = [
  'subscription.create',
  'subscription.edit',
  'subscription.archive',
  'decision.record',
  'category.manage',
  'budget.manage',
  'reminder.manage',
  'report.export',
  'settings.manage',
  'integration.manage',
  'member.manage',
  'audit.view',
  'ownership.transfer',
  'organization.delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: Permission[] = [];
const MEMBER_PERMISSIONS: Permission[] = ['subscription.create', 'subscription.edit', 'decision.record'];
const ADMIN_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'subscription.archive',
  'category.manage',
  'budget.manage',
  'reminder.manage',
  'report.export',
  'settings.manage',
  'integration.manage',
  'member.manage',
  'audit.view',
];

export function permissionsForRole(role: Role): Permission[] {
  switch (role) {
    case 'owner':
      return [...PERMISSIONS];
    case 'admin':
      return [...ADMIN_PERMISSIONS];
    case 'member':
      return [...MEMBER_PERMISSIONS];
    case 'viewer':
      return [...VIEWER_PERMISSIONS];
  }
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Stored subscription lifecycle status.
 *
 * `cancel_planned` records a *decision to cancel*, nothing more. The vendor is
 * never contacted by RenewRadar, so the status must stay distinct from
 * `cancelled`, which the user sets only after they have confirmed the
 * cancellation externally (Part E / E3.4, E7).
 */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'trial',
  'paused',
  'cancel_planned',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trial: 'Trial',
  paused: 'Paused',
  cancel_planned: 'Cancellation planned',
  cancelled: 'Cancelled',
};

/** The five list views offered in the subscriptions table (Part E / E3.2). */
export const SUBSCRIPTION_VIEWS = [
  'active',
  'trials',
  'paused',
  'cancellation_planned',
  'cancelled',
  'archived',
  'all',
] as const;
export type SubscriptionView = (typeof SUBSCRIPTION_VIEWS)[number];

/** Billing cadences (Part E / E3.3). */
export const INTERVAL_UNITS = ['weekly', 'monthly', 'quarterly', 'yearly', 'custom'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export const INTERVAL_UNIT_LABELS: Record<IntervalUnit, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom (every N days)',
};

/** How the next renewal date is produced. */
export const RENEWAL_TYPES = ['auto', 'manual'] as const;
export type RenewalType = (typeof RENEWAL_TYPES)[number];

export const RENEWAL_TYPE_LABELS: Record<RenewalType, string> = {
  auto: 'Renews automatically',
  manual: 'I renew it manually',
};

export const PERSONAL_OR_BUSINESS = ['business', 'personal'] as const;
export type PersonalOrBusiness = (typeof PERSONAL_OR_BUSINESS)[number];

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decision vocabulary (Part E / E3.4). `cancel_planned` is an intention;
 * `cancelled` is only recorded once the user has confirmed it with the vendor.
 */
export const DECISIONS = ['keep', 'review', 'downgrade', 'cancel_planned', 'cancelled'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Record<Decision, string> = {
  keep: 'Keep',
  review: 'Review',
  downgrade: 'Downgrade planned',
  cancel_planned: 'Cancellation planned',
  cancelled: 'Cancelled (confirmed with vendor)',
};

/** Decisions that mean "a human still has to do something". */
export const OPEN_DECISIONS: readonly Decision[] = ['review', 'downgrade', 'cancel_planned'];

/** Decisions that close an open review. */
export const CLOSING_DECISIONS: readonly Decision[] = ['keep', 'cancelled'];

/** Source recorded against a price-history row (Part E / E3.7). */
export const PRICE_SOURCES = ['manual', 'csv_import', 'integration'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export const REMINDER_EVENT_TYPES = ['renewal', 'trial_end', 'cancellation_deadline'] as const;
export type ReminderEventType = (typeof REMINDER_EVENT_TYPES)[number];

export const REMINDER_EVENT_LABELS: Record<ReminderEventType, string> = {
  renewal: 'Renewal date',
  trial_end: 'Trial end',
  cancellation_deadline: 'Cancellation deadline',
};

export const REMINDER_CHANNELS = ['in_app', 'email'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const REMINDER_LOG_STATUSES = [
  'queued',
  'in_app',
  'sent',
  'failed',
  'skipped',
  'snoozed',
] as const;
export type ReminderLogStatus = (typeof REMINDER_LOG_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

export const BUDGET_PERIODS = ['monthly', 'yearly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/* -------------------------------------------------------------------------- */
/* Imports / exports / jobs                                                    */
/* -------------------------------------------------------------------------- */

export const IMPORT_STATUSES = ['preview', 'confirmed', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const EXPORT_DATASETS = ['subscriptions', 'price_history'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export const IMPORT_DUPLICATE_CHOICES = ['create', 'skip', 'update'] as const;
export type ImportDuplicateChoice = (typeof IMPORT_DUPLICATE_CHOICES)[number];

export const INTEGRATION_PROVIDERS = ['email_smtp', 'bank_transaction_feed'] as const;
export type IntegrationProviderKind = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['not_configured', 'configured', 'error', 'disabled'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const BACKGROUND_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number];

export const BACKGROUND_JOB_TYPES = [
  'reminders.schedule',
  'reminders.deliver',
  'maintenance.cleanup',
] as const;
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];

/** Look-ahead windows used by the overview and the calendar (Part E / E3.1). */
export const RENEWAL_HORIZONS = [7, 30, 90] as const;
export type RenewalHorizon = (typeof RENEWAL_HORIZONS)[number];

/** Design tokens offered for a category chip. */
export const CATEGORY_COLOR_TOKENS = [
  'slate',
  'indigo',
  'sky',
  'teal',
  'green',
  'amber',
  'orange',
  'rose',
  'violet',
] as const;
export type CategoryColorToken = (typeof CATEGORY_COLOR_TOKENS)[number];

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Import guard rails (Part E / E4 CSV import). */
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Attachment guard rails (Part E / E7 "attachments must be private"). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
] as const;