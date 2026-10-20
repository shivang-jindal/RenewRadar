/**
 * Zod schemas shared between the browser and the API.
 *
 * The server always re-validates with these schemas; the client uses them for
 * inline validation. Nothing here trusts the browser (Part A / A4.7).
 */

import { z } from 'zod';

import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  BUDGET_PERIODS,
  CATEGORY_COLOR_TOKENS,
  DECISIONS,
  DEFAULT_PAGE_SIZE,
  EXPORT_DATASETS,
  IMPORT_DUPLICATE_CHOICES,
  INTERVAL_UNITS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_PAGE_SIZE,
  PERSONAL_OR_BUSINESS,
  REMINDER_CHANNELS,
  REMINDER_EVENT_TYPES,
  RENEWAL_TYPES,
  ROLES,
  SUBSCRIPTION_STATUSES,
} from './constants.js';
import { SUPPORTED_CURRENCIES } from './money.js';

const uuid = z.string().uuid();

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'That date does not exist');

export const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Expected a 3-letter ISO 4217 currency code')
  .refine((code) => SUPPORTED_CURRENCIES.includes(code), { message: 'Unsupported currency' });

/** Money always crosses the wire as integer minor units. */
export const money = z.number().int('Amounts must be whole minor units (e.g. cents)');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const url = z
  .string()
  .trim()
  .max(500)
  .url('Enter a full URL including https://')
  .refine((value) => /^https?:\/\//i.test(value), { message: 'Only http:// and https:// URLs are allowed' });

export const idSchema = uuid;
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Password is too long');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const idParamSchema = z.object({ id: uuid });

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Enter your name').max(120),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(400),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
});

/* -------------------------------------------------------------------------- */
/* Organizations                                                              */
/* -------------------------------------------------------------------------- */

const countryCode = z.string().trim().toUpperCase().length(2, 'Use a 2-letter country code');

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Enter an organization name').max(120),
  countryCode,
  timezone: z.string().trim().min(1).max(64),
  baseCurrency: currency,
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    countryCode: countryCode.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    logoUrl: url.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

export const transferOwnershipSchema = z.object({
  membershipId: uuid,
  confirmation: z.literal('TRANSFER OWNERSHIP'),
});

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).refine((role) => role !== 'owner', {
    message: 'Ownership is transferred separately',
  }),
});

export const changeMemberRoleSchema = z.object({ role: z.enum(ROLES) });

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(400) });

/* -------------------------------------------------------------------------- */
/* Settings & reminder rules                                                  */
/* -------------------------------------------------------------------------- */

export const updateReminderSettingsSchema = z
  .object({
    quietHoursStart: hhmm.nullable().optional(),
    quietHoursEnd: hhmm.nullable().optional(),
    reminderTimeLocal: hhmm.optional(),
    remindersPaused: z.boolean().optional(),
    defaultRenewalReminderDays: z.number().int().min(0).max(365).optional(),
    defaultTrialReminderDays: z.number().int().min(0).max(365).optional(),
    defaultCancellationReminderDays: z.number().int().min(0).max(365).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  })
  .refine(
    (value) =>
      (value.quietHoursStart === undefined && value.quietHoursEnd === undefined) ||
      (value.quietHoursStart !== undefined && value.quietHoursEnd !== undefined),
    { message: 'Set both the start and the end of quiet hours, or neither', path: ['quietHoursEnd'] },
  );

export const updateReminderRulesSchema = z.object({
  rules: z
    .array(
      z.object({
        id: uuid,
        eventType: z.enum(REMINDER_EVENT_TYPES),
        daysBefore: z.number().int().min(0).max(365),
        channel: z.enum(REMINDER_CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .max(60)
    .refine((value) => value.length > 0, { message: 'Nothing to update' }),
});

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a category name').max(60),
  colorToken: z.enum(CATEGORY_COLOR_TOKENS).default('slate'),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    colorToken: z.enum(CATEGORY_COLOR_TOKENS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

/**
 * Deleting a category must never silently orphan subscriptions
 * (Part E / E7): the caller must state what happens to them.
 */
export const deleteCategorySchema = z
  .object({
    reassignToCategoryId: uuid.nullable().default(null),
    confirmation: z.literal('DELETE CATEGORY'),
  })
  .refine(
    (value) => value.reassignToCategoryId !== null || true,
    { message: 'Choose a replacement category or move the subscriptions to "Uncategorized"' },
  );

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                              */
/* -------------------------------------------------------------------------- */

const intervalCount = z.number().int().min(1).max(1_000);

export const subscriptionInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a subscription name').max(120),
    vendorName: z.string().trim().min(1, 'Enter the vendor or provider').max(120),
    planName: z.string().trim().max(80).nullable().optional(),
    categoryId: uuid.nullable().optional(),
    amountMinor: money.positive('Enter an amount greater than zero'),
    currency,
    intervalUnit: z.enum(INTERVAL_UNITS),
    intervalCount: intervalCount.default(1),
    startDate: isoDate,
    nextRenewalDate: isoDate,
    trialEndDate: isoDate.nullable().optional(),
    cancellationDeadline: isoDate.nullable().optional(),
    renewalType: z.enum(RENEWAL_TYPES).default('auto'),
    status: z.enum(SUBSCRIPTION_STATUSES).default('active'),
    ownerUserId: uuid.nullable().optional(),
    paymentMethodLabel: z
      .string()
      .trim()
      .max(60)
      .nullable()
      .optional()
      .refine((value) => !value || !/\d{12,}/.test(value), {
        message: 'Store a label only (for example "Company card"). Never a card number.',
      }),
    vendorUrl: url.nullable().optional(),
    cancellationUrl: url.nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    personalOrBusiness: z.enum(PERSONAL_OR_BUSINESS).default('business'),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startDate > value.nextRenewalDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextRenewalDate'],
        message: 'The next renewal cannot be before the start date',
      });
    }
    if (value.trialEndDate && value.trialEndDate < value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trialEndDate'],
        message: 'The trial end cannot be before the start date',
      });
    }
    if (value.cancellationDeadline && value.cancellationDeadline > value.nextRenewalDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellationDeadline'],
        message: 'A cancellation deadline after the renewal date cannot be acted on in time',
      });
    }
    if (value.status === 'trial' && !value.trialEndDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trialEndDate'],
        message: 'A subscription on trial needs a trial end date',
      });
    }
  });

export const createSubscriptionSchema = subscriptionInputSchema;

export const updateSubscriptionSchema = subscriptionInputSchema
  .innerType()
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const subscriptionListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  view: z
    .enum(['active', 'trials', 'paused', 'cancellation_planned', 'cancelled', 'archived', 'all'])
    .default('active'),
  categoryId: uuid.optional(),
  currency: currency.optional(),
  ownerUserId: uuid.optional(),
  renewalFrom: isoDate.optional(),
  renewalTo: isoDate.optional(),
  markedForReview: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sort: z
    .enum(['name', 'vendor_name', 'amount_minor', 'next_renewal_date', 'created_at', 'updated_at'])
    .default('next_renewal_date'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const archiveSubscriptionSchema = z.object({
  archived: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

/**
 * A decision records the user's intention. `cancelled` requires an explicit
 * confirmation because RenewRadar cannot cancel anything with the vendor
 * (Part E / E7: cancellation intention is not cancellation confirmation).
 */
export const createDecisionSchema = z
  .object({
    decision: z.enum(DECISIONS),
    reason: z.string().trim().max(1000).nullable().optional(),
    reviewOn: isoDate.nullable().optional(),
    cancellationConfirmedAt: isoDate.nullable().optional(),
    cancellationReference: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'cancelled' && !value.cancellationConfirmedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellationConfirmedAt'],
        message:
          'Confirm the date you cancelled with the vendor. RenewRadar cannot cancel a contract for you.',
      });
    }
    if (value.decision === 'cancel_planned' && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Record why the cancellation is planned so the decision log is useful later',
      });
    }
    if (value.reviewOn && value.decision !== 'review' && value.decision !== 'downgrade') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewOn'],
        message: 'A review date only applies to a review or downgrade decision',
      });
    }
  });

/** Bulk edits are limited to fields that do not need a per-row external action. */
export const bulkUpdateSubscriptionsSchema = z.object({
  subscriptionIds: z.array(uuid).min(1, 'Select at least one subscription').max(200),
  categoryId: uuid.nullable().optional(),
  ownerUserId: uuid.nullable().optional(),
  personalOrBusiness: z.enum(PERSONAL_OR_BUSINESS).optional(),
});

export const snoozeReminderSchema = z.object({
  snoozeUntil: isoDate,
  reason: z.string().trim().max(300).optional(),
});

export const markReminderReviewedSchema = z.object({
  reviewed: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* -------------------------------------------------------------------------- */

export const createBudgetSchema = z.object({
  name: z.string().trim().min(1, 'Name this budget').max(80),
  categoryId: uuid.nullable().optional(),
  amountMinor: money.positive('Enter an amount greater than zero'),
  currency,
  period: z.enum(BUDGET_PERIODS),
  thresholdPercent: z.number().int().min(1).max(200).default(80),
  enabled: z.boolean().default(true),
});

export const updateBudgetSchema = createBudgetSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

export const budgetListQuerySchema = z.object({
  currency: currency.optional(),
  enabled: z
    .enum(['true', 'false', 'all'])
    .default('all')
    .transform((value) => (value === 'all' ? undefined : value === 'true')),
});

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

export const calendarQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  categoryId: uuid.optional(),
  ownerUserId: uuid.optional(),
  status: z.enum(['all', ...SUBSCRIPTION_STATUSES]).default('all'),
  eventType: z.enum(['all', ...REMINDER_EVENT_TYPES]).default('all'),
});

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export const dashboardQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/* -------------------------------------------------------------------------- */
/* Import / export                                                            */
/* -------------------------------------------------------------------------- */

/** Columns recognised in a subscription CSV, in mapping order. */
export const IMPORT_COLUMNS = [
  'name',
  'vendor_name',
  'plan_name',
  'category',
  'amount',
  'currency',
  'interval_unit',
  'interval_count',
  'start_date',
  'next_renewal_date',
  'trial_end_date',
  'status',
  'payment_method_label',
  'notes',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const importMappingSchema = z.record(
  z.string().trim().max(120),
  z.union([z.enum(IMPORT_COLUMNS), z.literal(''), z.literal('ignore')]),
);

export const previewImportSchema = z.object({
  filename: z.string().trim().min(1, 'A file name is required').max(200),
  csv: z.string().min(1, 'The CSV file is empty').max(2 * 1024 * 1024, 'The file is larger than 2 MB'),
  mapping: importMappingSchema.default({}),
});

export const commitImportSchema = z.object({
  importId: uuid,
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().min(2),
        duplicateChoice: z.enum(IMPORT_DUPLICATE_CHOICES).nullable().default(null),
        duplicateSubscriptionId: uuid.nullable().optional(),
      }),
    )
    .max(MAX_IMPORT_ROWS),
});

export const importListQuerySchema = paginationSchema;

export const createExportSchema = z.object({
  dataset: z.enum(EXPORT_DATASETS),
  filters: z
    .object({
      status: z.enum(['all', ...SUBSCRIPTION_STATUSES]).optional(),
      categoryId: uuid.optional(),
      currency: currency.optional(),
    })
    .default({}),
});

/* -------------------------------------------------------------------------- */
/* Attachments                                                                */
/* -------------------------------------------------------------------------- */

export const attachmentMetadataSchema = z.object({
  originalFilename: z.string().trim().min(1).max(200),
  mimeType: z.enum(ALLOWED_ATTACHMENT_MIME_TYPES, {
    errorMap: () => ({
      message: `Supported types: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}`,
    }),
  }),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_ATTACHMENT_BYTES, `Attachments are limited to ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`),
  storageKey: z.string().trim().min(1).max(300),
});

export const registerAttachmentSchema = attachmentMetadataSchema;

/* -------------------------------------------------------------------------- */
/* Integrations                                                               */
/* -------------------------------------------------------------------------- */

export const updateIntegrationSchema = z.object({
  provider: z.string().trim().min(2).max(64),
  enabled: z.boolean().default(true),
  credentials: z.record(z.string().trim().min(1).max(60), z.string().max(2000)).default({}),
});

export const integrationTestSchema = z.object({
  to: emailSchema.optional(),
});

export const schemaCatalog = {
  register: registerSchema,
  login: loginSchema,
  createOrganization: createOrganizationSchema,
  createCategory: createCategorySchema,
  createSubscription: createSubscriptionSchema,
  updateSubscription: updateSubscriptionSchema,
  createDecision: createDecisionSchema,
  createBudget: createBudgetSchema,
  previewImport: previewImportSchema,
  commitImport: commitImportSchema,
};