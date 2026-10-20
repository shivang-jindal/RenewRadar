/**
 * Service container. One instance per process; the services are stateless
 * apart from their database handle.
 */

import type { Permission, Role } from '@renewradar/shared';
import { permissionsForRole } from '@renewradar/shared';

import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { JobQueue } from './jobs/queue.js';
import { DisabledEmailAdapter } from './integrations/email/disabled.js';
import { LogEmailAdapter } from './integrations/email/log.js';
import { SmtpEmailAdapter } from './integrations/email/smtp.js';
import type { EmailAdapter } from './integrations/email/types.js';
import type { Logger } from 'pino';
import {
  AttachmentService,
  UnconfiguredAttachmentSigner,
  type AttachmentSigner,
} from './services/attachment.service.js';
import { AuditService } from './services/audit.service.js';
import { AuthService } from './services/auth.service.js';
import { BudgetService } from './services/budget.service.js';
import { CalendarService } from './services/calendar.service.js';
import { CategoryService } from './services/category.service.js';
import { EmailService } from './services/email.service.js';
import { ExportService } from './services/export.service.js';
import { ImportService } from './services/import.service.js';
import { IntegrationService } from './services/integration.service.js';
import { OrganizationService } from './services/organization.service.js';
import { ReminderService } from './services/reminder.service.js';
import { ReportService } from './services/report.service.js';
import { SubscriptionService } from './services/subscription.service.js';

export interface Services {
  config: AppConfig;
  logger: Logger;
  db: AppDatabase;
  audit: AuditService;
  auth: AuthService;
  organizations: OrganizationService;
  categories: CategoryService;
  subscriptions: SubscriptionService;
  budgets: BudgetService;
  calendar: CalendarService;
  reminders: ReminderService;
  reports: ReportService;
  imports: ImportService;
  exports: ExportService;
  attachments: AttachmentService;
  email: EmailService;
  emailAdapter: EmailAdapter;
  integrations: IntegrationService;
  jobs: JobQueue;
  permissionsFor: (role: Role) => Permission[];
}

export function createServices(options: {
  db: AppDatabase;
  config: AppConfig;
  logger: Logger;
  attachmentSigner?: AttachmentSigner;
}): Services {
  const { db, config, logger } = options;

  const adapter = createEmailAdapter(config);
  const audit = new AuditService(db);
  const jobs = new JobQueue(db);
  const auth = new AuthService(db, config.session.ttlHours);
  const organizations = new OrganizationService(db, audit);
  const categories = new CategoryService(db, audit);
  const subscriptions = new SubscriptionService(db, audit);
  const budgets = new BudgetService(db, audit);
  const calendar = new CalendarService(db);
  const reminders = new ReminderService(db);
  const reports = new ReportService(db);
  const imports = new ImportService(db, audit);
  const exports = new ExportService(db, audit);
  const attachments = new AttachmentService(db, audit, options.attachmentSigner ?? new UnconfiguredAttachmentSigner());
  const email = new EmailService(
    db,
    adapter,
    config.email.from ?? 'RenewRadar <no-reply@renewradar.local>',
  );
  const integrations = new IntegrationService(
    db,
    audit,
    config.encryptionKey,
    () => adapter.verifyConfiguration(),
    adapter.setupHint,
    adapter.deliversMessages,
  );

  return {
    config,
    logger,
    db,
    audit,
    auth,
    organizations,
    categories,
    subscriptions,
    budgets,
    calendar,
    reminders,
    reports,
    imports,
    exports,
    attachments,
    email,
    emailAdapter: adapter,
    integrations,
    jobs,
    permissionsFor: permissionsForRole,
  };
}

export function createEmailAdapter(config: AppConfig): EmailAdapter {
  switch (config.email.provider) {
    case 'smtp':
      return new SmtpEmailAdapter({
        host: config.email.host!,
        port: config.email.port ?? 587,
        secure: config.email.secure,
        user: config.email.user,
        password: config.email.password,
      });
    case 'log':
      // Same `.data` convention as the embedded PGlite directory, so the
      // outbox lands beside it whether the process starts from the repository
      // root or from `server/`.
      return new LogEmailAdapter(`${process.cwd()}/.data/outbox`);
    case 'disabled':
    default:
      return new DisabledEmailAdapter();
  }
}