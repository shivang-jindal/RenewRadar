/**
 * Reminder rules and the reminder log.
 *
 * A message marked "sent" means the provider accepted it. RenewRadar never
 * claims an email was delivered.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  REMINDER_CHANNELS,
  REMINDER_EVENT_LABELS,
  REMINDER_EVENT_TYPES,
  addDaysIso,
  todayIso,
  type ReminderLogView,
  type ReminderRuleView,
} from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  buttonClass,
} from '../components/ui';
import {
  Column,
  DataTable,
  Pagination,
  ReminderStatusBadge,
} from '../components/patterns';

interface RulesResponse {
  rules: ReminderRuleView[];
  settings: { quietHoursStart: string | null; quietHoursEnd: string | null; remindersPaused: boolean };
  email: { provider: string; deliversMessages: boolean; detail: string; setupHint: string };
  outbox: Array<{
    id: string;
    recipient: string;
    subject: string;
    status: string;
    errorMessage: string | null;
    createdAt: string;
    sentAt: string | null;
  }>;
  note: string;
}

export function RemindersPage() {
  const { activeOrganizationId } = useSession();
  const queryClient = useQueryClient();
  const canManage = usePermission('reminder.manage');

  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState(REMINDER_EVENT_TYPES[0] as string);
  const [daysBefore, setDaysBefore] = useState('7');
  const [channel, setChannel] = useState<string>('in_app');
  const [snoozeUntil, setSnoozeUntil] = useState(addDaysIso(todayIso(), 7));
  const [error, setError] = useState<string | null>(null);

  const reminders = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'reminders'],
    queryFn: () => api.get<RulesResponse>(`/${activeOrganizationId}/reminder-rules`),
    enabled: Boolean(activeOrganizationId),
  });

  const logs = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'reminder-logs', page],
    queryFn: () =>
      api.get<{ items: ReminderLogView[]; page: number; pageSize: number; total: number }>(
        `/${activeOrganizationId}/reminder-rules/logs?page=${page}&pageSize=25`,
      ),
    enabled: Boolean(activeOrganizationId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['renewradar', activeOrganizationId] });
  };

  const createRule = useMutation({
    mutationFn: () =>
      api.post(`/${activeOrganizationId}/reminder-rules`, {
        eventType,
        daysBefore: Number(daysBefore),
        channel,
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the rule.');
    },
  });

  const snooze = useMutation({
    mutationFn: (reminderId: string) =>
      api.post(`/${activeOrganizationId}/reminder-rules/logs/${reminderId}/snooze`, {
        snoozeUntil,
      }),
    onSuccess: invalidate,
  });

  const markReviewed = useMutation({
    mutationFn: ({ reminderId, reviewed }: { reminderId: string; reviewed: boolean }) =>
      api.post(`/${activeOrganizationId}/reminder-rules/logs/${reminderId}/reviewed`, { reviewed }),
    onSuccess: invalidate,
  });

  const columns: Column<ReminderLogView>[] = [
    {
      key: 'subscriptionName',
      header: 'Subscription',
      render: (row) => <span className="text-ink">{row.subscriptionName}</span>,
    },
    { key: 'eventType', header: 'Event', render: (row) => row.eventTypeLabel },
    { key: 'targetDate', header: 'Target date', render: (row) => <span className="tabular">{formatDate(row.targetDate)}</span> },
    { key: 'channel', header: 'Channel', render: (row) => row.channel.replace('_', ' ') },
    { key: 'status', header: 'Status', render: (row) => <ReminderStatusBadge status={row.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" loading={snooze.isPending} onClick={() => snooze.mutate(row.id)}>
            Snooze
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={markReviewed.isPending}
            onClick={() => markReviewed.mutate({ reminderId: row.id, reviewed: !row.reviewedAt })}
          >
            {row.reviewedAt ? 'Unmark reviewed' : 'Mark reviewed'}
          </Button>
        </div>
      ),
    },
  ];

  const data = reminders.data;

  return (
    <>
      <PageHeader
        title="Reminders"
        description="When RenewRadar nudges you about a renewal, and what it has actually sent."
        actions={
          <Link to={`/${activeOrganizationId}/reminders/due`} className={buttonClass('secondary')}>
            What is due
          </Link>
        }
      />

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rules" description="One rule per event, lead time and channel.">
          {!data ? (
            <p className="text-[13px] text-ink-muted">Loading…</p>
          ) : data.rules.length === 0 ? (
            <EmptyState title="No rules yet" description="No reminder rules are configured." />
          ) : (
            <ul className="divide-y divide-line">
              {data.rules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="text-[13px] font-medium text-ink">
                      {rule.eventTypeLabel} · {rule.daysBefore} day{rule.daysBefore === 1 ? '' : 's'} before
                    </p>
                    <p className="text-xs text-ink-muted">
                      via {rule.channel.replace('_', ' ')}
                      {rule.quietHours
                        ? ` · quiet hours ${rule.quietHours.start}–${rule.quietHours.end}`
                        : ''}
                    </p>
                  </div>
                  <Badge tone={rule.enabled ? 'success' : 'neutral'}>
                    {rule.enabled ? 'On' : 'Off'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {canManage ? (
            <form
              className="mt-4 space-y-3 border-t border-line pt-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                createRule.mutate();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Event" required>
                  {({ id }) => (
                    <Select id={id} value={eventType} onChange={(event) => setEventType(event.target.value)}>
                      {REMINDER_EVENT_TYPES.map((value) => (
                        <option key={value} value={value}>{REMINDER_EVENT_LABELS[value]}</option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Days before" required>
                  {({ id }) => (
                    <Input id={id} type="number" min={0} max={365} value={daysBefore}
                      onChange={(event) => setDaysBefore(event.target.value)} />
                  )}
                </Field>
                <Field label="Channel" required>
                  {({ id }) => (
                    <Select id={id} value={channel} onChange={(event) => setChannel(event.target.value)}>
                      {REMINDER_CHANNELS.map((value) => (
                        <option key={value} value={value}>{value.replace('_', ' ')}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <Button type="submit" variant="secondary" loading={createRule.isPending}>
                Add rule
              </Button>
            </form>
          ) : null}
        </Card>

        <Card title="Email provider" description="What happens when a reminder fires.">
          {data ? (
            <>
              <p className="text-[13px] text-ink"><strong>{data.email.provider}</strong></p>
              <p className="mt-1 text-[13px] text-ink-muted">{data.email.detail}</p>
              {!data.email.deliversMessages ? (
                <p className="mt-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
                  This provider cannot confirm delivery. RenewRadar records a message as
                  <em> sent</em> when the provider accepts it, and never claims more than that.
                </p>
              ) : null}
              <p className="mt-2 text-xs text-ink-subtle">{data.email.setupHint}</p>
            </>
          ) : (
            <p className="text-[13px] text-ink-muted">Loading…</p>
          )}
        </Card>
      </div>

      {canManage ? (
        <Card className="mt-4" title="Snooze to" description="Applies to the reminders you snooze below.">
          <Field label="Snooze until">
            {({ id }) => (
              <Input id={id} type="date" value={snoozeUntil} onChange={(event) => setSnoozeUntil(event.target.value)} />
            )}
          </Field>
        </Card>
      ) : null}

      <Card className="mt-4" title="Reminder log" description="Newest first.">
        {logs.isError ? (
          <ErrorState message="Could not load reminders." onRetry={() => void logs.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Reminder log"
              columns={columns}
              rows={logs.data?.items ?? []}
              getRowKey={(row) => row.id}
              loading={logs.isLoading}
              empty={<EmptyState title="No reminders yet" description="Nothing has been scheduled for you." />}
            />
            {logs.data && logs.data.total > 0 ? (
              <Pagination
                page={logs.data.page}
                pageSize={logs.data.pageSize}
                total={logs.data.total}
                onPageChange={setPage}
              />
            ) : null}
          </>
        )}
      </Card>

      {data && data.outbox.length > 0 ? (
        <Card className="mt-4" title="Email outbox" description={data.note}>
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Reminder emails sent</caption>
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted uppercase">
                <th scope="col" className="py-2 font-semibold">Recipient</th>
                <th scope="col" className="py-2 font-semibold">Subject</th>
                <th scope="col" className="py-2 font-semibold">Status</th>
                <th scope="col" className="py-2 font-semibold">Sent</th>
              </tr>
            </thead>
            <tbody>
              {data.outbox.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="py-1.5">{row.recipient}</td>
                  <td className="py-1.5 text-ink-muted">
                    {row.subject}{row.errorMessage ? ` — ${row.errorMessage}` : ''}
                  </td>
                  <td className="py-1.5">
                    <Badge
                      tone={row.status === 'sent' ? 'success' : row.status === 'failed' ? 'danger' : 'neutral'}
                    >
                      {row.status}
                    </Badge>
                  </td>
                  <td className="tabular py-1.5">{formatDateTime(row.sentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}