/**
 * Email templates and rendering for RenewRadar.
 *
 * Templates are plain text + simple HTML with an allow-listed placeholder set.
 * Everything interpolated is escaped: no user content can inject markup.
 */

import { escapeHtml } from '../../lib/util.js';
import { formatMinorAsDecimal } from '@renewradar/shared';

export interface TemplateContext {
  organizationName: string;
  subscriptionName: string;
  vendorName: string;
  eventTypeLabel: string;
  targetDate: string;
  amountFormatted: string;
  daysUntil: number | null;
  subscriptionUrl: string | null;
  notes: string | null;
}

export const PLACEHOLDERS = [
  '{{organizationName}}',
  '{{subscriptionName}}',
  '{{vendorName}}',
  '{{eventTypeLabel}}',
  '{{targetDate}}',
  '{{amount}}',
  '{{daysUntil}}',
  '{{subscriptionUrl}}',
  '{{notes}}',
] as const;

export interface EmailTemplateDefinition {
  type: string;
  subject: string;
  bodyHtml: string;
}

const LAYOUT = (body: string) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    ${body}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:12px;color:#64748b;margin:0;">
      Sent by RenewRadar on behalf of {{organizationName}}. RenewRadar tracks subscriptions; it does not manage,
      pay for, or cancel them with the vendor. If you did not expect this message, contact {{organizationName}} directly.
    </p>
  </div>
</body></html>`;

export const DEFAULT_TEMPLATES: EmailTemplateDefinition[] = [
  {
    type: 'reminder_renewal',
    subject: '{{subscriptionName}} renews on {{targetDate}}',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Upcoming renewal</h1>
      <p style="margin:0 0 16px;"><strong>{{subscriptionName}}</strong> ({{vendorName}}) renews on
      <strong>{{targetDate}}</strong> for <strong>{{amount}}</strong>.</p>
      {{subscriptionUrlBlock}}
      <p style="font-size:13px;color:#475569;margin:16px 0 0;">Open the subscription in RenewRadar to record a
      keep, downgrade or cancel decision.</p>
    `),
  },
  {
    type: 'reminder_trial_end',
    subject: 'The {{subscriptionName}} trial ends on {{targetDate}}',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Trial ending</h1>
      <p style="margin:0 0 16px;">The trial for <strong>{{subscriptionName}}</strong> ({{vendorName}}) ends on
      <strong>{{targetDate}}</strong>. Decide whether to keep it before it converts.</p>
      {{subscriptionUrlBlock}}
    `),
  },
  {
    type: 'reminder_cancellation_deadline',
    subject: 'Cancel {{subscriptionName}} by {{targetDate}}',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Cancellation deadline</h1>
      <p style="margin:0 0 16px;">You must cancel <strong>{{subscriptionName}}</strong> ({{vendorName}}) by
      <strong>{{targetDate}}</strong> to avoid being charged <strong>{{amount}}</strong> on
      {{targetDate}}.</p>
      {{subscriptionUrlBlock}}
      <p style="font-size:13px;color:#475569;margin:16px 0 0;">RenewRadar cannot cancel anything with the vendor.
      Use the vendor's own cancellation page, then record the decision here.</p>
    `),
  },
];

const LINK_BLOCK = `<p style="margin:0 0 16px;">
  <a href="{{subscriptionUrl}}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;">Open in RenewRadar</a>
</p>`;

const LINK_BLOCK_MISSING = `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">
  Open RenewRadar and find the subscription to review it.
</p>`;

/** Replace allow-listed placeholders. Unknown tokens are removed, not executed. */
export function renderTemplate(template: string, context: TemplateContext, isHtml: boolean): string {
  let output = template;
  output = output.replace(
    /\{\{subscriptionUrlBlock\}\}/g,
    context.subscriptionUrl ? LINK_BLOCK : LINK_BLOCK_MISSING,
  );

  const values: Record<string, string> = {
    organizationName: context.organizationName,
    subscriptionName: context.subscriptionName,
    vendorName: context.vendorName,
    eventTypeLabel: context.eventTypeLabel,
    targetDate: context.targetDate,
    amount: context.amountFormatted,
    daysUntil: context.daysUntil === null ? '' : String(context.daysUntil),
    subscriptionUrl: context.subscriptionUrl ?? '',
    notes: context.notes ?? '',
  };

  for (const key of Object.keys(values)) {
    const raw = values[key] ?? '';
    const safe = isHtml ? escapeHtml(raw) : raw.replace(/[\r\n]+/g, ' ');
    output = output.split(`{{${key}}}`).join(safe);
  }
  // Drop anything left that looks like a placeholder we do not support.
  return output.replace(/\{\{[a-zA-Z]+\}\}/g, '');
}

/** Plain-text alternative for the same context. */
export function renderPlainText(template: string, context: TemplateContext): string {
  const withBlock = template
    .replace(
      /\{\{subscriptionUrlBlock\}\}/g,
      context.subscriptionUrl
        ? `Open it in RenewRadar: ${context.subscriptionUrl}`
        : 'Open RenewRadar to review this subscription.',
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return renderTemplate(withBlock, context, false)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => !(line === '' && lines[index - 1] === ''))
    .join('\n')
    .trim();
}

export function formatMoney(minor: number, currency: string): string {
  return `${formatMinorAsDecimal(minor, currency)} ${currency}`;
}