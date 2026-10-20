/** Create or edit a subscription. Totals are recalculated by the server. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import {
  INTERVAL_UNITS,
  INTERVAL_UNIT_LABELS,
  RENEWAL_TYPES,
  RENEWAL_TYPE_LABELS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABELS,
  PERSONAL_OR_BUSINESS,
  SUPPORTED_CURRENCIES,
  createSubscriptionSchema,
  updateSubscriptionSchema,
  type CategoryView,
  type SubscriptionDetail,
} from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { addDaysIso, todayIso } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';

function emptyForm() {
  return {
    name: '',
    vendorName: '',
    planName: '',
    categoryId: '',
    amount: '',
    currency: 'USD',
    intervalUnit: 'monthly',
    intervalCount: '1',
    startDate: todayIso(),
    nextRenewalDate: addDaysIso(todayIso(), 30),
    trialEndDate: '',
    cancellationDeadline: '',
    renewalType: 'auto',
    status: 'active',
    paymentMethodLabel: '',
    vendorUrl: '',
    cancellationUrl: '',
    notes: '',
    personalOrBusiness: 'business',
  };
}

function parseAmountToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function SubscriptionEditorPage() {
  const { subscriptionId } = useParams();
  const isEdit = Boolean(subscriptionId);
  const { activeOrganizationId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canWrite = usePermission(isEdit ? 'subscription.edit' : 'subscription.create');

  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const categories = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'categories'],
    queryFn: () => api.get<CategoryView[]>(`/${activeOrganizationId}/categories`),
    enabled: Boolean(activeOrganizationId),
  });

  const existing = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'subscription', subscriptionId],
    queryFn: () => api.get<SubscriptionDetail>(`/${activeOrganizationId}/subscriptions/${subscriptionId}`),
    enabled: Boolean(activeOrganizationId && subscriptionId),
  });

  const [hydrated, setHydrated] = useState(false);
  if (isEdit && existing.data && !hydrated) {
    const row = existing.data.subscription;
    setForm({
      name: row.name,
      vendorName: row.vendorName,
      planName: row.planName ?? '',
      categoryId: row.categoryId ?? '',
      amount: (row.amountMinor / 100).toFixed(2),
      currency: row.currency,
      intervalUnit: row.intervalUnit,
      intervalCount: String(row.intervalCount),
      startDate: row.startDate,
      nextRenewalDate: row.nextRenewalDate ?? todayIso(),
      trialEndDate: row.trialEndDate ?? '',
      cancellationDeadline: row.cancellationDeadline ?? '',
      renewalType: row.renewalType,
      status: row.status,
      paymentMethodLabel: row.paymentMethodLabel ?? '',
      vendorUrl: '',
      cancellationUrl: '',
      notes: '',
      personalOrBusiness: row.personalOrBusiness,
    });
    setHydrated(true);
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const amountMinor = parseAmountToMinor(form.amount);
      const payload = {
        name: form.name.trim(),
        vendorName: form.vendorName.trim(),
        planName: form.planName.trim() || null,
        categoryId: form.categoryId || null,
        amountMinor: amountMinor ?? 0,
        currency: form.currency,
        intervalUnit: form.intervalUnit,
        intervalCount: Number(form.intervalCount),
        startDate: form.startDate,
        nextRenewalDate: form.nextRenewalDate,
        trialEndDate: form.trialEndDate || null,
        cancellationDeadline: form.cancellationDeadline || null,
        renewalType: form.renewalType,
        status: form.status,
        paymentMethodLabel: form.paymentMethodLabel.trim() || null,
        vendorUrl: form.vendorUrl.trim() || null,
        cancellationUrl: form.cancellationUrl.trim() || null,
        notes: form.notes.trim() || null,
        personalOrBusiness: form.personalOrBusiness,
      };

      const schema = isEdit ? updateSubscriptionSchema : createSubscriptionSchema;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        setErrors(
          Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), [issue.message]])),
        );
        throw new ApiError(
          400,
          { error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.', requestId: '' } },
          'Check the highlighted fields.',
        );
      }
      return isEdit
        ? api.patch<{ subscription: { id: string } }>(
            `/${activeOrganizationId}/subscriptions/${subscriptionId}`,
            parsed.data,
          )
        : api.post<{ subscription: { id: string } }>(
            `/${activeOrganizationId}/subscriptions`,
            parsed.data,
          );
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['renewradar', activeOrganizationId] });
      navigate(`/${activeOrganizationId}/subscriptions/${saved.subscription.id}`);
    },
  });

  if (!canWrite) {
    return (
      <>
        <PageHeader title={isEdit ? 'Edit subscription' : 'Add subscription'} />
        <Card>
          <p className="text-[13px] text-ink-muted">
            Your role does not allow changing subscriptions.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit subscription' : 'Add subscription'}
        description="RenewRadar records what you tell it. It never contacts a vendor."
      />

      <Card className="max-w-3xl">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setErrors({});
            mutation.mutate();
          }}
        >
          {mutation.error instanceof ApiError ? (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
              {mutation.error.message}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })} required />
              )}
            </Field>
            <Field label="Vendor" required error={errors.vendorName?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.vendorName}
                  onChange={(event) => setForm({ ...form, vendorName: event.target.value })} required />
              )}
            </Field>
            <Field label="Plan" error={errors.planName?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.planName}
                  onChange={(event) => setForm({ ...form, planName: event.target.value })} />
              )}
            </Field>
            <Field label="Category" error={errors.categoryId?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select id={id} aria-describedby={describedBy} invalid={invalid} value={form.categoryId}
                  onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
                  <option value="">Uncategorised</option>
                  {(categories.data ?? []).map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Amount" required error={errors.amountMinor?.[0]} hint="In major units, for example 12.99. Stored as minor units.">
              {({ id, describedBy, invalid }) => (
                <Input id={id} inputMode="decimal" aria-describedby={describedBy} invalid={invalid} value={form.amount}
                  onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="12.99" required />
              )}
            </Field>
            <Field label="Currency" required error={errors.currency?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select id={id} aria-describedby={describedBy} invalid={invalid} value={form.currency}
                  onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                  {SUPPORTED_CURRENCIES.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Billing interval" required error={errors.intervalUnit?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select id={id} aria-describedby={describedBy} invalid={invalid} value={form.intervalUnit}
                  onChange={(event) => setForm({ ...form, intervalUnit: event.target.value })}>
                  {INTERVAL_UNITS.map((unit) => (
                    <option key={unit} value={unit}>{INTERVAL_UNIT_LABELS[unit]}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Every" error={errors.intervalCount?.[0]} hint="How many intervals between renewals.">
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" min={1} max={52} aria-describedby={describedBy} invalid={invalid}
                  value={form.intervalCount}
                  onChange={(event) => setForm({ ...form, intervalCount: event.target.value })} />
              )}
            </Field>

            <Field label="Start date" required error={errors.startDate?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" aria-describedby={describedBy} invalid={invalid} value={form.startDate}
                  onChange={(event) => setForm({ ...form, startDate: event.target.value })} required />
              )}
            </Field>
            <Field label="Next renewal" required error={errors.nextRenewalDate?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" aria-describedby={describedBy} invalid={invalid} value={form.nextRenewalDate}
                  onChange={(event) => setForm({ ...form, nextRenewalDate: event.target.value })} required />
              )}
            </Field>
            <Field label="Trial ends" error={errors.trialEndDate?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" aria-describedby={describedBy} invalid={invalid} value={form.trialEndDate}
                  onChange={(event) => setForm({ ...form, trialEndDate: event.target.value })} />
              )}
            </Field>
            <Field label="Cancellation deadline" error={errors.cancellationDeadline?.[0]} hint="Last day you can cancel without penalty.">
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" aria-describedby={describedBy} invalid={invalid} value={form.cancellationDeadline}
                  onChange={(event) => setForm({ ...form, cancellationDeadline: event.target.value })} />
              )}
            </Field>

            <Field label="Renewal type" required error={errors.renewalType?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select id={id} aria-describedby={describedBy} invalid={invalid} value={form.renewalType}
                  onChange={(event) => setForm({ ...form, renewalType: event.target.value })}>
                  {RENEWAL_TYPES.map((type) => (
                    <option key={type} value={type}>{RENEWAL_TYPE_LABELS[type]}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status" required error={errors.status?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select id={id} aria-describedby={describedBy} invalid={invalid} value={form.status}
                  onChange={(event) => setForm({ ...form, status: event.target.value })}>
                  {SUBSCRIPTION_STATUSES.map((status) => (
                    <option key={status} value={status}>{SUBSCRIPTION_STATUS_LABELS[status]}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Used for" required error={errors.personalOrBusiness?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select id={id} aria-describedby={describedBy} invalid={invalid} value={form.personalOrBusiness}
                  onChange={(event) => setForm({ ...form, personalOrBusiness: event.target.value })}>
                  {PERSONAL_OR_BUSINESS.map((value) => (
                    <option key={value} value={value}>{value === 'business' ? 'Business' : 'Personal'}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Payment method"
              error={errors.paymentMethodLabel?.[0]}
              hint="A label only, such as “Company card”. Never a card number."
            >
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} invalid={invalid} value={form.paymentMethodLabel}
                  onChange={(event) => setForm({ ...form, paymentMethodLabel: event.target.value })} />
              )}
            </Field>
          </div>

          <Field label="Notes" error={errors.notes?.[0]}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} rows={3} aria-describedby={describedBy} invalid={invalid} value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })} />
            )}
          </Field>

          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Add subscription'}
            </Button>
            <Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
          </div>
        </form>
      </Card>
    </>
  );
}