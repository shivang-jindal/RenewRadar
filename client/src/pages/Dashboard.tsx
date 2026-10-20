/**
 * Renewal dashboard.
 *
 * Amounts are always grouped by currency: RenewRadar stores no exchange rates,
 * so nothing in different currencies is ever added together.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { DashboardSummary } from '@renewradar/shared';

import { api } from '../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import { Card, EmptyState, ErrorState, PageHeader } from '../components/ui';
import { CurrencyAmounts, DecisionBadge, MetricCard } from '../components/patterns';

export function DashboardPage() {
  const { activeOrganizationId } = useSession();

  const dashboard = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'dashboard'],
    queryFn: () => api.get<DashboardSummary>(`/${activeOrganizationId}/dashboard/summary`),
    enabled: Boolean(activeOrganizationId),
  });

  if (dashboard.isError) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <ErrorState
            message={dashboard.error instanceof Error ? dashboard.error.message : 'Could not load the dashboard.'}
            onRetry={() => void dashboard.refetch()}
          />
        </Card>
      </>
    );
  }

  const data = dashboard.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `Your recurring commitments, as of ${formatDateTime(data.generatedAt)} (${data.timezone}).`
            : 'Loading your commitments…'
        }
      />

      <div className="space-y-4">
        <Card title="Monthly recurring spend" description={data?.currencyGroupingNotice}>
          <CurrencyAmounts
            amounts={data?.monthlyRecurringByCurrency ?? []}
            format={formatMoney}
            emptyLabel="No recurring spend recorded yet."
          />
          <p className="mt-2 text-xs text-ink-subtle">
            RenewRadar stores no exchange rates, so different currencies are shown side by
            side and never combined into one figure.
          </p>
        </Card>

        <Card title="Annualised" description={data?.annualizedCaveat}>
          <CurrencyAmounts
            amounts={data?.annualizedByCurrency ?? []}
            format={formatMoney}
            emptyLabel="Nothing to annualise yet."
          />
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="Active" value={data?.activeCount ?? 0} hint="Renewing as normal." />
          <MetricCard label="In trial" value={data?.trialCount ?? 0} hint="Not yet paid for." />
          <MetricCard label="Paused" value={data?.pausedCount ?? 0} />
          <MetricCard label="Cancellation planned" value={data?.cancelPlannedCount ?? 0} />
          <MetricCard label="Cancelled" value={data?.cancelledCount ?? 0} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Renewing in the next 7 days">
            {(data?.renewals.next7Days ?? []).length === 0 ? (
              <EmptyState title="Nothing due this week" description="No renewal falls in the next seven days." />
            ) : (
              <ul className="divide-y divide-line">
                {data!.renewals.next7Days.map((row) => (
                  <li key={row.subscriptionId} className="flex items-center justify-between gap-3 py-2">
                    <Link
                      to={`/${activeOrganizationId}/subscriptions/${row.subscriptionId}`}
                      className="text-[13px] font-medium text-ink underline"
                    >
                      {row.name}
                    </Link>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="tabular text-[13px]">{formatDate(row.date)}</span>
                      <span className="tabular text-[13px] font-medium">
                        {formatMoney(row.amountMinor, row.currency)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Trials ending">
            {(data?.trialExpirations ?? []).length === 0 ? (
              <EmptyState title="No trials running" description="Nothing is on trial right now." />
            ) : (
              <ul className="divide-y divide-line">
                {data!.trialExpirations.map((row) => (
                  <li key={row.subscriptionId} className="flex items-center justify-between gap-3 py-2">
                    <Link
                      to={`/${activeOrganizationId}/subscriptions/${row.subscriptionId}`}
                      className="text-[13px] font-medium text-ink underline"
                    >
                      {row.name}
                    </Link>
                    <span className="tabular text-[13px]">{formatDate(row.date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {data && data.markedForReview.length > 0 ? (
          <Card title="Marked for review" description="Decisions you deferred rather than made.">
            <ul className="divide-y divide-line">
              {data.markedForReview.map((row) => (
                <li key={row.subscriptionId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link
                      to={`/${activeOrganizationId}/subscriptions/${row.subscriptionId}`}
                      className="block truncate text-[13px] font-medium text-ink underline"
                    >
                      {row.name}
                    </Link>
                    {row.reason ? <p className="text-xs text-ink-muted">{row.reason}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <DecisionBadge decision={row.decision} />
                    {row.reviewOn ? (
                      <span className="tabular text-xs text-ink-muted">review {formatDate(row.reviewOn)}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {data && data.priceIncreases.length > 0 ? (
          <Card
            title="Recent price increases"
            description="Recorded price changes, with the source that reported them."
          >
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">Recent recorded price increases</caption>
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted uppercase">
                  <th scope="col" className="py-2 font-semibold">Subscription</th>
                  <th scope="col" className="py-2 font-semibold">Effective</th>
                  <th scope="col" className="py-2 font-semibold">Source</th>
                  <th scope="col" className="py-2 text-right font-semibold">Change</th>
                </tr>
              </thead>
              <tbody>
                {data.priceIncreases.map((row) => (
                  <tr key={row.subscriptionId} className="border-b border-line last:border-0">
                    <td className="py-2">
                      <Link
                        to={`/${activeOrganizationId}/subscriptions/${row.subscriptionId}`}
                        className="text-ink underline"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="tabular py-2">{formatDate(row.effectiveDate)}</td>
                    <td className="py-2 text-ink-muted">{row.source.replace(/_/g, ' ')}</td>
                    <td className="tabular py-2 text-right">
                      {formatMoney(row.previousAmountMinor, row.currency)} →{' '}
                      <strong>{formatMoney(row.amountMinor, row.currency)}</strong>
                      {row.changePercent !== null ? (
                        <span className="ml-2 text-xs text-ink-muted">+{row.changePercent}%</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null}

        <Card title="Spend by category" description="Grouped per currency; never summed across currencies.">
          {(data?.spendByCategory ?? []).length === 0 ? (
            <EmptyState title="No categories yet" description="Assign a category to a subscription to see the split." />
          ) : (
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">Monthly spend per category, by currency</caption>
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted uppercase">
                  <th scope="col" className="py-2 font-semibold">Category</th>
                  <th scope="col" className="py-2 text-right font-semibold">Monthly spend</th>
                </tr>
              </thead>
              <tbody>
                {data!.spendByCategory.map((category) => (
                  <tr key={category.categoryId ?? 'uncategorized'} className="border-b border-line last:border-0">
                    <td className="py-2 text-ink">{category.categoryName}</td>
                    <td className="tabular py-2 text-right">
                      {category.monthlyByCurrency.length === 0 ? (
                        <span className="text-ink-subtle">—</span>
                      ) : (
                        // Each currency is listed on its own. Adding them would
                        // require an exchange rate, which RenewRadar does not store.
                        category.monthlyByCurrency
                          .map((entry) => formatMoney(entry.amountMinor, entry.currency))
                          .join(' · ')
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {data && data.unassignedCount > 0 ? (
          <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
            {data.unassignedCount} subscription{data.unassignedCount === 1 ? ' has' : 's have'} no
            category, so {data.unassignedCount === 1 ? 'it does' : 'they do'} not appear in the split above.
          </p>
        ) : null}
      </div>
    </>
  );
}