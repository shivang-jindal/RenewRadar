/** Renewal calendar (month view) with iCalendar export. */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  REMINDER_EVENT_TYPES,
  REMINDER_EVENT_LABELS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABELS,
  type CalendarRange,
  type CategoryView,
} from '@renewradar/shared';

import { api, apiDownload, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
} from '../components/ui';

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(isoDate: string, months: number): string {
  const value = new Date(`${isoDate}T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

export function CalendarPage() {
  const { activeOrganizationId } = useSession();
  const canExport = usePermission('report.export');

  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(firstOfMonth(today));
  const [to, setTo] = useState(addMonths(firstOfMonth(today), 2));
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('all');
  const [eventType, setEventType] = useState('all');
  const [exportError, setExportError] = useState<string | null>(null);

  const categories = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'categories'],
    queryFn: () => api.get<CategoryView[]>(`/${activeOrganizationId}/categories`),
    enabled: Boolean(activeOrganizationId),
  });

  const calendar = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'calendar', from, to, categoryId, status, eventType],
    queryFn: () =>
      api.get<CalendarRange>(
        `/${activeOrganizationId}/calendar/events?${new URLSearchParams({
          from,
          to,
          status,
          eventType,
          ...(categoryId ? { categoryId } : {}),
        })}`,
      ),
    enabled: Boolean(activeOrganizationId && from && to),
  });

  const byDate = useMemo(() => {
    const grouped = new Map<string, CalendarRange['events']>();
    for (const event of calendar.data?.events ?? []) {
      const list = grouped.get(event.date) ?? [];
      list.push(event);
      grouped.set(event.date, list);
    }
    return grouped;
  }, [calendar.data]);

  const days = useMemo(() => {
    const result: string[] = [];
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (cursor <= end) {
      result.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
  }, [from, to]);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Every renewal, trial end and cancellation deadline in one view."
        actions={
          canExport && calendar.data?.icsAvailable ? (
            <Button
              variant="secondary"
              onClick={async () => {
                setExportError(null);
                try {
                  await apiDownload(
                    `/${activeOrganizationId}/calendar/events.ics?${new URLSearchParams({ from, to })}`,
                    'renewradar-renewals.ics',
                  );
                } catch (error) {
                  setExportError(error instanceof ApiError ? error.message : 'Export failed.');
                }
              }}
            >
              Download .ics
            </Button>
          ) : null
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="calendar-from" className="mb-1 block text-xs font-medium text-ink-muted">From</label>
            <input
              id="calendar-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-10 rounded-lg border border-line-strong px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="calendar-to" className="mb-1 block text-xs font-medium text-ink-muted">To</label>
            <input
              id="calendar-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-10 rounded-lg border border-line-strong px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="calendar-category" className="mb-1 block text-xs font-medium text-ink-muted">Category</label>
            <Select id="calendar-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">All categories</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="calendar-status" className="mb-1 block text-xs font-medium text-ink-muted">Status</label>
            <Select id="calendar-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">Any status</option>
              {SUBSCRIPTION_STATUSES.map((value) => (
                <option key={value} value={value}>{SUBSCRIPTION_STATUS_LABELS[value]}</option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="calendar-event" className="mb-1 block text-xs font-medium text-ink-muted">Event</label>
            <Select id="calendar-event" value={eventType} onChange={(event) => setEventType(event.target.value)}>
              <option value="all">All events</option>
              {REMINDER_EVENT_TYPES.map((value) => (
                <option key={value} value={value}>{REMINDER_EVENT_LABELS[value]}</option>
              ))}
            </Select>
          </div>
        </div>
        {exportError ? (
          <p role="alert" className="mt-2 text-[13px] text-[color:var(--color-danger)]">{exportError}</p>
        ) : null}
        {calendar.data && !calendar.data.icsAvailable ? (
          <p className="mt-2 text-[13px] text-ink-muted">{calendar.data.icsNotice}</p>
        ) : null}
      </Card>

      {calendar.isError ? (
        <Card>
          <ErrorState message="Could not load the calendar." onRetry={() => void calendar.refetch()} />
        </Card>
      ) : null}

      {calendar.data && calendar.data.events.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing in this range"
            description="No renewal, trial end or deadline falls between these dates."
          />
        </Card>
      ) : null}

      {days.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {days.map((day) => {
            const events = byDate.get(day) ?? [];
            return (
              <Card key={day}>
                <h2 className="mb-2 text-[13px] font-semibold text-ink">{day}</h2>
                {events.length === 0 ? (
                  <p className="text-xs text-ink-subtle">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {events.map((event) => (
                      <li key={event.id} className="rounded-lg border border-line p-2">
                        <Link
                          to={`/${activeOrganizationId}/subscriptions/${event.subscriptionId}`}
                          className="block text-[13px] font-medium text-ink underline"
                        >
                          {event.subscriptionName}
                        </Link>
                        <p className="text-xs text-ink-muted">
                          {REMINDER_EVENT_LABELS[event.eventType]}
                          {event.categoryName ? ` · ${event.categoryName}` : ''}
                        </p>
                        <p className="tabular text-xs text-ink">
                          {formatMoney(event.amountMinor, event.currency)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      ) : null}

      {calendar.data ? (
        <p className="mt-3 text-xs text-ink-subtle">
          Dates are shown in {calendar.data.timezone}. An amount is the value of that one
          renewal; RenewRadar never converts between currencies.
        </p>
      ) : null}
    </>
  );
}