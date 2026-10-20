/**
 * API contract types (Part A / A7, Part E / E6).
 *
 * Every list endpoint returns `Paginated<T>`; every error returns `ApiError`.
 */

import type {
  Decision,
  ImportDuplicateChoice,
  ImportStatus,
  IntegrationStatus,
  IntervalUnit,
  PersonalOrBusiness,
  PriceSource,
  ReminderChannel,
  ReminderEventType,
  ReminderLogStatus,
  Role,
  RenewalType,
  SubscriptionStatus,
} from './constants.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTEGRATION_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiFieldIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string[]>;
    issues?: ApiFieldIssue[];
    requestId: string;
  };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  baseCurrency: string;
  timezone: string;
  role: Role;
  permissions: string[];
}

export interface AuthSessionResponse {
  user: SessionUser;
  memberships: MembershipSummary[];
  activeOrganizationId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export interface CategoryView {
  id: string;
  name: string;
  colorToken: string;
  subscriptionCount: number;
  monthlyMinorByCurrency: Array<{ currency: string; amountMinor: number }>;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                               */
/* -------------------------------------------------------------------------- */

export interface SubscriptionListItem {
  id: string;
  name: string;
  vendorName: string;
  planName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorToken: string | null;
  amountMinor: number;
  currency: string;
  monthlyEquivalentMinor: number;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  startDate: string;
  nextRenewalDate: string | null;
  trialEndDate: string | null;
  cancellationDeadline: string | null;
  renewalType: RenewalType;
  status: SubscriptionStatus;
  renewalState: 'scheduled' | 'due' | 'overdue' | 'none';
  daysUntilRenewal: number | null;
  ownerUserId: string | null;
  ownerName: string | null;
  paymentMethodLabel: string | null;
  personalOrBusiness: PersonalOrBusiness;
  latestDecision: Decision | null;
  markedForReview: boolean;
  archivedAt: string | null;
  updatedAt: string;
}

export interface PriceHistoryEntry {
  id: string;
  subscriptionId: string;
  oldAmountMinor: number | null;
  newAmountMinor: number;
  oldCurrency: string | null;
  currency: string;
  effectiveDate: string;
  source: PriceSource;
  sourceLabel: string;
  note: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changeMinor: number;
  changePercent: number | null;
  direction: 'increase' | 'decrease' | 'unchanged' | 'initial';
  currencyChanged: boolean;
  summary: string;
  createdAt: string;
}

export interface DecisionEntry {
  id: string;
  subscriptionId: string;
  decision: Decision;
  decisionLabel: string;
  reason: string | null;
  reviewOn: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
  recordedAt: string;
}

export interface AttachmentView {
  id: string;
  subscriptionId: string;
  originalFilenameSafe: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
  /**
   * `null` when no private object store is configured. RenewRadar never
   * returns a public URL for a document (Part E / E7).
   */
  downloadUrl: string | null;
  storageConfigured: boolean;
}

export interface SubscriptionDetail {
  subscription: SubscriptionListItem;
  upcomingRenewals: string[];
  anchorDay: number;
  anchorDayClamped: boolean;
  priceHistory: PriceHistoryEntry[];
  decisions: DecisionEntry[];
  attachments: AttachmentView[];
  nextReminders: Array<{
    id: string;
    eventType: ReminderEventType;
    targetDate: string;
    status: ReminderLogStatus;
    channel: ReminderChannel;
    sentAt: string | null;
  }>;
  timeline: Array<{ id: string; at: string; title: string; detail?: string }>;
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary {
  /** Always grouped by currency. Amounts are never added across currencies. */
  monthlyRecurringByCurrency: Array<{ currency: string; amountMinor: number }>;
  annualizedByCurrency: Array<{ currency: string; amountMinor: number }>;
  annualizedCaveat: string;
  activeCount: number;
  trialCount: number;
  pausedCount: number;
  cancelPlannedCount: number;
  cancelledCount: number;
  unassignedCount: number;
  renewals: {
    next7Days: Array<{ subscriptionId: string; name: string; date: string; amountMinor: number; currency: string }>;
    next30Days: Array<{ subscriptionId: string; name: string; date: string; amountMinor: number; currency: string }>;
    next90Days: Array<{ subscriptionId: string; name: string; date: string; amountMinor: number; currency: string }>;
  };
  priceIncreases: Array<{
    subscriptionId: string;
    name: string;
    previousAmountMinor: number;
    amountMinor: number;
    currency: string;
    effectiveDate: string;
    changePercent: number | null;
    source: PriceSource;
  }>;
  trialExpirations: Array<{ subscriptionId: string; name: string; date: string }>;
  markedForReview: Array<{
    subscriptionId: string;
    name: string;
    nextRenewalDate: string | null;
    decision: Decision;
    reviewOn: string | null;
    reason: string | null;
  }>;
  spendByCategory: Array<{
    categoryId: string | null;
    categoryName: string;
    colorToken: string | null;
    monthlyByCurrency: Array<{ currency: string; amountMinor: number }>;
  }>;
  generatedAt: string;
  timezone: string;
  currencyGroupingNotice: string;
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

export interface CalendarEvent {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  vendorName: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorToken: string | null;
  eventType: ReminderEventType;
  date: string;
  amountMinor: number;
  currency: string;
  status: SubscriptionStatus;
}

export interface CalendarRange {
  from: string;
  to: string;
  events: CalendarEvent[];
  icsAvailable: boolean;
  icsNotice: string;
  timezone: string;
}

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

export interface BudgetView {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  amountMinor: number;
  currency: string;
  period: 'monthly' | 'yearly';
  thresholdPercent: number;
  enabled: boolean;
  spendMinor: number;
  periodSpendMinor: number;
  usagePercent: number | null;
  warningPercent: number | null;
  atRisk: boolean;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReminderRuleView {
  id: string;
  eventType: ReminderEventType;
  eventTypeLabel: string;
  daysBefore: number;
  channel: ReminderChannel;
  enabled: boolean;
  quietHours: { start: string; end: string } | null;
}

export interface ReminderLogView {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  eventType: ReminderEventType;
  eventTypeLabel: string;
  targetDate: string;
  recipientUserId: string | null;
  recipientName: string | null;
  channel: ReminderChannel;
  status: ReminderLogStatus;
  providerMessageId: string | null;
  failureCode: string | null;
  safeFailureMessage: string | null;
  sentAt: string | null;
  snoozedUntil: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Imports                                                                     */
/* -------------------------------------------------------------------------- */

export interface ImportRowPreview {
  rowNumber: number;
  raw: Record<string, string>;
  normalized: {
    name: string;
    vendorName: string;
    amountMinor: number;
    currency: string;
    unit: IntervalUnit;
    intervalCount: number;
    nextRenewalDate: string | null;
  } | null;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  duplicateOf: { subscriptionId: string; name: string; reason: string } | null;
  duplicateChoice: ImportDuplicateChoice | null;
}

export interface ImportPreview {
  importId: string;
  filenameSafe: string;
  status: ImportStatus;
  columns: string[];
  mapping: Record<string, string>;
  rows: ImportRowPreview[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  errorRows: number;
  committed: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportResult {
  importId: string;
  status: ImportStatus;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ rowNumber: number; code: string; message: string }>;
}

/* -------------------------------------------------------------------------- */
/* Integrations                                                                */
/* -------------------------------------------------------------------------- */

export interface IntegrationStatusView {
  provider: string;
  label: string;
  status: IntegrationStatus;
  connected: boolean;
  deliversMessages: boolean;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  maskedKeys: Array<{ key: string; masked: string }>;
  setupGuide: string[];
  capabilities: string[];
  limitations: string[];
}

export interface OrganizationSettingsView {
  organizationId: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  reminderTimeLocal: string;
  remindersPaused: boolean;
  defaultRenewalReminderDays: number;
  defaultTrialReminderDays: number;
  defaultCancellationReminderDays: number;
  fiscalYearStartMonth: number;
  updatedAt: string;
}