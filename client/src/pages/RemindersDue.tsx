/** "What is due" — the actionable list, straight from the server. */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import { Card, EmptyState, ErrorState, PageHeader } from '../components/ui';

interface DueResponse {
  asOf: string;
  overdue: Array<{
    subscriptionId: string;
    name: string;
    vendorName: string;
    eventType: string;
    dueDate: string;
    daysOverdue: number;
    amountMinor: number;
    currency: string;
  }>;
  upcoming: Array<{
    subscriptionId: string;
    name: string;
    vendorName: string;
    eventType: string;
    dueDate: string;
    daysUntil: number;
    amountMinor: number;
    currency: string;
  }>;
  note: string;
}

export function RemindersDuePage() {
  const { activeOrganizationId } = useSession();

  const due = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'reminders-due'],
    queryFn: () => api.get<DueResponse>(`/${activeOrganizationId}/dashboard/reminders/due`),
    enabled: Boolean(activeOrganizationId),
  });

  if (due.isError) {
    return (
      <>
        <PageHeader title="What is due" />
        <Card>
          <ErrorState message="Could not load what is due." onRetry={() => void due.refetch()} />
        </Card>
      </>
    );
  }

  const data = due.data;

  return (
    <>
      <PageHeader
        title="What is due"
        description={data ? `As of ${formatDate(data.asOf)}.` : 'Loading…'}
      />

      <div className="space-y-4">
        <Card
          title="Overdue"
          description="These dates have already passed. RenewRadar cannot tell you whether the vendor charged you."
        >
          {!data || data.overdue.length === 0 ? (
            <EmptyState title="Nothing overdue" description="No renewal date has passed without a decision." />
          ) : (
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">Overdue renewals</caption>
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted uppercase">
                  <th scope="col" className="py-2 font-semibold">Subscription</th>
                  <th scope="col" className="py-2 font-semibold">Date</th>
                  <th scope="col" className="py-2 font-semibold">Event</th>
                  <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                  <th scope="col" className="py-2 text-right font-semibold">Overdue by</th>
                </tr>
              </thead>
              <tbody>
                {data.overdue.map((row) => (
                  <tr key={`${row.subscriptionId}-${row.dueDate}`} className="border-b border-line last:border-0">
                    <td className="py-2">
                      <Link to={`/${activeOrganizationId}/subscriptions/${row.subscriptionId}`} className="text-ink underline">
                        {row.name}
                      </Link>
                      <span className="block text-xs text-ink-muted">{row.vendorName}</span>
                    </td>
                    <td className="tabular py-2">{formatDate(row.dueDate)}</td>
                    <td className="py-2 text-ink-muted">{row.eventType.replace(/_/g, ' ')}</td>
                    <td className="tabular py-2 text-right">{formatMoney(row.amountMinor, row.currency)}</td>
                    <td className="tabular py-2 text-right">{row.daysOverdue}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Coming up" description="The next 30 days.">
          {!data || data.upcoming.length === 0 ? (
            <EmptyState title="Nothing in the next 30 days" description="No renewal falls in the coming month." />
          ) : (
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">Upcoming renewals</caption>
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted uppercase">
                  <th scope="col" className="py-2 font-semibold">Subscription</th>
                  <th scope="col" className="py-2 font-semibold">Date</th>
                  <th scope="col" className="py-2 font-semibold">Event</th>
                  <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                  <th scope="col" className="py-2 text-right font-semibold">In</th>
                </tr>
              </thead>
              <tbody>
                {data.upcoming.map((row) => (
                  <tr key={`${row.subscriptionId}-${row.dueDate}`} className="border-b border-line last:border-0">
                    <td className="py-2">
                      <Link to={`/${activeOrganizationId}/subscriptions/${row.subscriptionId}`} className="text-ink underline">
                        {row.name}
                      </Link>
                      <span className="block text-xs text-ink-muted">{row.vendorName}</span>
                    </td>
                    <td className="tabular py-2">{formatDate(row.dueDate)}</td>
                    <td className="py-2 text-ink-muted">{row.eventType.replace(/_/g, ' ')}</td>
                    <td className="tabular py-2 text-right">{formatMoney(row.amountMinor, row.currency)}</td>
                    <td className="tabular py-2 text-right">{row.daysUntil}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {data?.note ? (
          <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
            {data.note}
          </p>
        ) : null}
      </div>
    </>
  );
}