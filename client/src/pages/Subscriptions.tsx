/** Subscription list with the view/filter set RenewRadar actually supports. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  INTERVAL_UNIT_LABELS,
  SUPPORTED_CURRENCIES,
  type CategoryView,
  type Paginated,
  type SubscriptionListItem,
} from '@renewradar/shared';

import { api, apiDownload, ApiError } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  buttonClass,
} from '../components/ui';
import {
  Column,
  DataTable,
  DecisionBadge,
  Pagination,
  RenewalBadge,
  SubscriptionStatusBadge,
} from '../components/patterns';

const VIEWS = [
  'active',
  'trials',
  'paused',
  'cancellation_planned',
  'cancelled',
  'archived',
  'all',
] as const;

const VIEW_LABELS: Record<(typeof VIEWS)[number], string> = {
  active: 'Active',
  trials: 'Trials',
  paused: 'Paused',
  cancellation_planned: 'Cancellation planned',
  cancelled: 'Cancelled',
  archived: 'Archived',
  all: 'Everything',
};

export function SubscriptionsPage() {
  const { activeOrganizationId } = useSession();
  const canCreate = usePermission('subscription.create');
  const canExport = usePermission('report.export');

  const [page, setPage] = useState(1);
  const [view, setView] = useState<(typeof VIEWS)[number]>('active');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [currency, setCurrency] = useState('');
  const [markedForReview, setMarkedForReview] = useState('');
  const [sort, setSort] = useState('next_renewal_date');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [exportError, setExportError] = useState<string | null>(null);

  /** Clicking a column picks it; clicking it again flips the direction. */
  function onSortChange(key: string) {
    if (key === sort) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      setOrder('asc');
    }
    setPage(1);
  }

  const categories = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'categories'],
    queryFn: () => api.get<CategoryView[]>(`/${activeOrganizationId}/categories`),
    enabled: Boolean(activeOrganizationId),
  });

  const subscriptions = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'subscriptions', page, view, search, categoryId, currency, markedForReview, sort, order],
    queryFn: () =>
      api.get<Paginated<SubscriptionListItem>>(
        `/${activeOrganizationId}/subscriptions?${new URLSearchParams({
          page: String(page),
          pageSize: '25',
          view,
          sort,
          order: 'asc',
          ...(search ? { q: search } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(currency ? { currency } : {}),
          ...(markedForReview ? { markedForReview } : {}),
        })}`,
      ),
    enabled: Boolean(activeOrganizationId),
  });

  const columns: Column<SubscriptionListItem>[] = [
    {
      key: 'name',
      header: 'Subscription',
      render: (row) => (
        <div>
          <Link
            to={`/${activeOrganizationId}/subscriptions/${row.id}`}
            className="block font-medium text-ink underline"
          >
            {row.name}
          </Link>
          <span className="block text-xs text-ink-muted">
            {row.vendorName}
            {row.planName ? ` · ${row.planName}` : ''}
            {row.categoryName ? ` · ${row.categoryName}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'amountMinor',
      header: 'Amount',
      align: 'right',
      render: (row) => (
        <div>
          <span className="tabular block font-medium">{formatMoney(row.amountMinor, row.currency)}</span>
          <span className="block text-xs text-ink-muted">
            {INTERVAL_UNIT_LABELS[row.intervalUnit]}
            {row.intervalCount > 1 ? ` × ${row.intervalCount}` : ''}
          </span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <SubscriptionStatusBadge status={row.status} /> },
    {
      key: 'nextRenewalDate',
      header: 'Renews',
      render: (row) => (
        <div>
          <span className="tabular block">{formatDate(row.nextRenewalDate)}</span>
          <span className="block text-xs">
            <RenewalBadge state={row.renewalState} days={row.daysUntilRenewal} />
          </span>
        </div>
      ),
    },
    { key: 'latestDecision', header: 'Decision', render: (row) => <DecisionBadge decision={row.latestDecision} /> },
  ];

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Every recurring commitment you have recorded."
        actions={
          <>
            {canCreate ? (
              <Link to={`/${activeOrganizationId}/subscriptions/new`} className={buttonClass('primary')}>
                Add subscription
              </Link>
            ) : null}
            {canExport ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  setExportError(null);
                  try {
                    await apiDownload(
                      `/${activeOrganizationId}/exports/subscriptions`,
                      'renewradar-subscriptions.csv',
                      'POST',
                      { dataset: 'subscriptions' },
                    );
                  } catch (error) {
                    setExportError(error instanceof ApiError ? error.message : 'Export failed.');
                  }
                }}
              >
                Export CSV
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <form
            className="min-w-52 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
            }}
          >
            <label htmlFor="subscription-search" className="mb-1 block text-xs font-medium text-ink-muted">
              Search
            </label>
            <Input
              id="subscription-search"
              value={search}
              placeholder="Name, vendor or plan"
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>
          <div>
            <label htmlFor="subscription-view" className="mb-1 block text-xs font-medium text-ink-muted">
              View
            </label>
            <Select
              id="subscription-view"
              value={view}
              onChange={(event) => {
                setView(event.target.value as (typeof VIEWS)[number]);
                setPage(1);
              }}
            >
              {VIEWS.map((value) => (
                <option key={value} value={value}>
                  {VIEW_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="subscription-category" className="mb-1 block text-xs font-medium text-ink-muted">
              Category
            </label>
            <Select
              id="subscription-category"
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All categories</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="subscription-currency" className="mb-1 block text-xs font-medium text-ink-muted">
              Currency
            </label>
            <Select
              id="subscription-currency"
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any currency</option>
              {SUPPORTED_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="subscription-review" className="mb-1 block text-xs font-medium text-ink-muted">
              Review flag
            </label>
            <Select
              id="subscription-review"
              value={markedForReview}
              onChange={(event) => {
                setMarkedForReview(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any</option>
              <option value="true">Marked for review</option>
              <option value="false">Not marked</option>
            </Select>
          </div>
        </div>

        {exportError ? (
          <p role="alert" className="border-b border-line px-4 py-2 text-[13px] text-[color:var(--color-danger)]">
            {exportError}
          </p>
        ) : null}

        <DataTable
          caption="Subscriptions recorded for this workspace"
          columns={columns}
          rows={subscriptions.data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={subscriptions.isLoading}
          error={subscriptions.isError ? 'Could not load subscriptions.' : null}
          onRetry={() => void subscriptions.refetch()}
          sort={{ key: sort, order }}
          onSortChange={onSortChange}
          empty={
            <EmptyState
              title="No subscriptions here"
              description="Nothing matches this view. Add one, or import a CSV from your bank or provider."
            />
          }
        />

        {subscriptions.data && subscriptions.data.total > 0 ? (
          <Pagination
            page={subscriptions.data.page}
            pageSize={subscriptions.data.pageSize}
            total={subscriptions.data.total}
            onPageChange={setPage}
          />
        ) : null}
      </Card>

      <p className="mt-3 text-xs text-ink-subtle">
        Sorted by {sort.replace(/_/g, ' ')}, {order === 'asc' ? 'ascending' : 'descending'}.
      </p>
    </>
  );
}