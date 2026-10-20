/**
 * Subscription detail: price history, decision log, renewal schedule.
 *
 * RenewRadar cannot cancel a contract with a vendor, so the "Cancelled"
 * decision requires a confirmed cancellation date.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  DECISIONS,
  DECISION_LABELS,
  INTERVAL_UNIT_LABELS,
  type Decision,
  type SubscriptionDetail,
} from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, todayIso } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';
import {
  ActivityTimeline,
  DecisionBadge,
  RenewalBadge,
  SubscriptionStatusBadge,
} from '../components/patterns';

export function SubscriptionDetailPage() {
  const { subscriptionId = '' } = useParams();
  const { activeOrganizationId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canEdit = usePermission('subscription.edit');
  const canArchive = usePermission('subscription.archive');
  const canDecide = usePermission('decision.record');

  const [decision, setDecision] = useState<Decision>('review');
  const [reason, setReason] = useState('');
  const [reviewOn, setReviewOn] = useState('');
  const [cancellationConfirmedAt, setCancellationConfirmedAt] = useState(todayIso());
  const [cancellationReference, setCancellationReference] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'subscription', subscriptionId],
    queryFn: () => api.get<SubscriptionDetail>(`/${activeOrganizationId}/subscriptions/${subscriptionId}`),
    enabled: Boolean(activeOrganizationId && subscriptionId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['renewradar', activeOrganizationId] });
  };

  const recordDecision = useMutation({
    mutationFn: () =>
      api.post(`/${activeOrganizationId}/subscriptions/${subscriptionId}/decisions`, {
        decision,
        reason: reason.trim() || null,
        reviewOn: reviewOn || null,
        ...(decision === 'cancelled'
          ? {
              cancellationConfirmedAt: cancellationConfirmedAt || null,
              cancellationReference: cancellationReference.trim() || null,
            }
          : {}),
      }),
    onSuccess: () => {
      setReason('');
      setReviewOn('');
      setFormError(null);
      invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: () =>
      api.post(`/${activeOrganizationId}/subscriptions/${subscriptionId}/archive`, {
        archived: true,
        reason: 'Archived from the subscription page',
      }),
    onSuccess: invalidate,
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title="Subscription" />
        <Card>Loading…</Card>
      </>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <>
        <PageHeader title="Subscription" />
        <Card>
          <ErrorState
            message="This subscription could not be loaded. It may belong to another workspace."
            onRetry={() => void detail.refetch()}
          />
        </Card>
      </>
    );
  }

  const { subscription, priceHistory, decisions, upcomingRenewals, timeline, anchorDay, anchorDayClamped, nextReminders } =
    detail.data;

  return (
    <>
      <PageHeader
        title={subscription.name}
        description={`${subscription.vendorName}${subscription.planName ? ` · ${subscription.planName}` : ''}`}
        actions={
          <>
            {canEdit ? (
              <Link to={`/${activeOrganizationId}/subscriptions/${subscription.id}/edit`} className="text-[13px] underline">
                Edit
              </Link>
            ) : null}
            {canArchive && !subscription.archivedAt ? (
              <Button variant="secondary" loading={archive.isPending} onClick={() => archive.mutate()}>
                Archive
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => navigate(`/${activeOrganizationId}/subscriptions`)}>
              Back
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {subscription.archivedAt ? (
            <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
              Archived {formatDate(subscription.archivedAt)}. History is kept and still readable.
            </p>
          ) : null}

          <Card title="Price history" description="Every recorded change, with who reported it.">
            {priceHistory.length === 0 ? (
              <EmptyState title="No price history" description="The price has not changed since this was recorded." />
            ) : (
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Recorded price changes</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-ink-muted uppercase">
                    <th scope="col" className="py-2 font-semibold">Effective</th>
                    <th scope="col" className="py-2 text-right font-semibold">Change</th>
                    <th scope="col" className="py-2 font-semibold">Source</th>
                    <th scope="col" className="py-2 font-semibold">Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {priceHistory.map((entry) => (
                    <tr key={entry.id} className="border-b border-line last:border-0">
                      <td className="tabular py-2">{formatDate(entry.effectiveDate)}</td>
                      <td className="tabular py-2 text-right">
                        {entry.oldAmountMinor !== null ? (
                          <>
                            <span className="text-ink-muted line-through">
                              {formatMoney(entry.oldAmountMinor, entry.oldCurrency ?? entry.currency)}
                            </span>{' '}
                          </>
                        ) : null}
                        <strong>{formatMoney(entry.newAmountMinor, entry.currency)}</strong>
                        {entry.changePercent !== null && entry.direction !== 'initial' ? (
                          <span className="ml-2 text-xs text-ink-muted">
                            {entry.changePercent > 0 ? '+' : ''}
                            {entry.changePercent}%
                          </span>
                        ) : null}
                        {entry.currencyChanged ? (
                          <span className="ml-2 text-xs text-[color:var(--color-warning)]">currency changed</span>
                        ) : null}
                      </td>
                      <td className="py-2 text-ink-muted">{entry.sourceLabel}</td>
                      <td className="py-2 text-ink-muted">{entry.changedByName ?? 'system'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {canDecide ? (
            <Card
              title="Record a decision"
              description="RenewRadar records your intent. It never cancels anything with a vendor."
            >
              <form
                className="space-y-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  setFormError(null);
                  if (decision === 'cancel_planned' && reason.trim().length < 3) {
                    setFormError('Record why the cancellation is planned.');
                    return;
                  }
                  if (decision === 'cancelled' && !cancellationConfirmedAt) {
                    setFormError('Enter the date you cancelled with the vendor.');
                    return;
                  }
                  recordDecision.mutate();
                }}
              >
                <Field label="Decision" required>
                  {({ id }) => (
                    <Select id={id} value={decision} onChange={(event) => setDecision(event.target.value as Decision)}>
                      {DECISIONS.map((value) => (
                        <option key={value} value={value}>
                          {DECISION_LABELS[value]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Reason" hint="Required when planning a cancellation.">
                  {({ id, describedBy }) => (
                    <Textarea id={id} rows={3} aria-describedby={describedBy} value={reason}
                      onChange={(event) => setReason(event.target.value)} />
                  )}
                </Field>
                {decision === 'review' || decision === 'downgrade' ? (
                  <Field label="Review on" hint="When you intend to come back to this.">
                    {({ id, describedBy }) => (
                      <Input id={id} type="date" aria-describedby={describedBy} value={reviewOn}
                        onChange={(event) => setReviewOn(event.target.value)} />
                    )}
                  </Field>
                ) : null}
                {decision === 'cancelled' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Cancelled with vendor on" required
                      hint="You must cancel with the vendor yourself.">
                      {({ id, describedBy }) => (
                        <Input id={id} type="date" aria-describedby={describedBy} value={cancellationConfirmedAt}
                          onChange={(event) => setCancellationConfirmedAt(event.target.value)} required />
                      )}
                    </Field>
                    <Field label="Vendor reference" hint="Confirmation number, if you have one.">
                      {({ id, describedBy }) => (
                        <Input id={id} aria-describedby={describedBy} value={cancellationReference}
                          onChange={(event) => setCancellationReference(event.target.value)} />
                      )}
                    </Field>
                  </div>
                ) : null}

                {formError ? (
                  <p role="alert" className="text-[13px] text-[color:var(--color-danger)]">{formError}</p>
                ) : null}
                {recordDecision.error instanceof ApiError ? (
                  <p role="alert" className="text-[13px] text-[color:var(--color-danger)]">
                    {recordDecision.error.message}
                  </p>
                ) : null}

                <Button type="submit" variant="primary" loading={recordDecision.isPending}>
                  Record decision
                </Button>
              </form>
            </Card>
          ) : null}

          <Card title="Decision log" description="Newest first. Never rewritten.">
            {decisions.length === 0 ? (
              <EmptyState title="No decisions yet" description="Nothing has been decided for this subscription." />
            ) : (
              <ul className="divide-y divide-line">
                {decisions.map((entry) => (
                  <li key={entry.id} className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <DecisionBadge decision={entry.decision} />
                      <span className="tabular text-xs text-ink-muted">{formatDateTime(entry.recordedAt)}</span>
                    </div>
                    {entry.reason ? <p className="mt-1 text-[13px] text-ink">{entry.reason}</p> : null}
                    <p className="text-xs text-ink-subtle">
                      {entry.recordedByName ?? 'system'}
                      {entry.reviewOn ? ` · review on ${formatDate(entry.reviewOn)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <ActivityTimeline
            title="Activity"
            events={timeline.map((entry) => ({ id: entry.id, at: entry.at, title: entry.title, ...(entry.detail ? { detail: entry.detail } : {}) }))}
          />
        </div>

        <div className="space-y-4">
          <Card title="Summary">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Status</dt>
                <dd><SubscriptionStatusBadge status={subscription.status} /></dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Amount</dt>
                <dd className="tabular">{formatMoney(subscription.amountMinor, subscription.currency)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Interval</dt>
                <dd className="text-ink">
                  {INTERVAL_UNIT_LABELS[subscription.intervalUnit]}
                  {subscription.intervalCount > 1 ? ` × ${subscription.intervalCount}` : ''}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Next renewal</dt>
                <dd className="tabular">{formatDate(subscription.nextRenewalDate)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Renewal</dt>
                <dd><RenewalBadge state={subscription.renewalState} days={subscription.daysUntilRenewal} /></dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Decision</dt>
                <dd><DecisionBadge decision={subscription.latestDecision} /></dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Category</dt>
                <dd className="text-ink">{subscription.categoryName ?? 'Uncategorised'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Owner</dt>
                <dd className="text-ink">{subscription.ownerName ?? 'Unassigned'}</dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Renewal schedule"
            description={
              anchorDayClamped
                ? `Anchored to day ${anchorDay} of the month, clamped for shorter months.`
                : `Anchored to day ${anchorDay} of the month.`
            }
          >
            <ol className="space-y-1.5 text-[13px]">
              {upcomingRenewals.map((date) => (
                <li key={date} className="tabular text-ink">{formatDate(date)}</li>
              ))}
            </ol>
            {anchorDayClamped ? (
              <p className="mt-2 text-xs text-ink-subtle">
                A 31st renewal in February is clamped rather than rolling into March.
              </p>
            ) : null}
          </Card>

          <Card title="Reminders" description="What is scheduled for this subscription.">
            {nextReminders.length === 0 ? (
              <p className="text-[13px] text-ink-muted">No reminders are scheduled.</p>
            ) : (
              <ul className="divide-y divide-line">
                {nextReminders.map((reminder) => (
                  <li key={reminder.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-[13px] text-ink">
                      {reminder.eventType.replace(/_/g, ' ')} · {reminder.channel.replace('_', ' ')}
                    </span>
                    <span className="tabular text-xs text-ink-muted">
                      {formatDate(reminder.targetDate)} · {reminder.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}