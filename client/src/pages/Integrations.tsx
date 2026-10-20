/**
 * Integrations. Each provider reports its real state; nothing is implied.
 * `sent` on an email only ever means the provider accepted the message.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { IntegrationStatusView } from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
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
  type BadgeTone,
} from '../components/ui';

const STATUS_TONE: Record<IntegrationStatusView['status'], BadgeTone> = {
  not_configured: 'neutral',
  configured: 'success',
  error: 'danger',
  disabled: 'warning',
};

const STATUS_LABEL: Record<IntegrationStatusView['status'], string> = {
  not_configured: 'Not configured',
  configured: 'Configured',
  error: 'Last attempt failed',
  disabled: 'Disabled',
};

export function IntegrationsPage() {
  const { activeOrganizationId } = useSession();
  const queryClient = useQueryClient();
  const canManage = usePermission('integration.manage');

  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  const integrations = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'integrations'],
    queryFn: () => api.get<IntegrationStatusView[]>(`/${activeOrganizationId}/integrations`),
    enabled: Boolean(activeOrganizationId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['renewradar', activeOrganizationId] });
  };

  const save = useMutation({
    mutationFn: ({ provider, credentials }: { provider: string; credentials: Record<string, string> }) =>
      api.put(`/${activeOrganizationId}/integrations/${provider}`, { credentials, enabled: true }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the integration.');
    },
  });

  const test = useMutation({
    mutationFn: (provider: string) =>
      api.post<{ ok: boolean; message: string; detail: string }>(
        `/${activeOrganizationId}/integrations/${provider}/test`,
      ),
    onSuccess: (data, provider) => {
      setTestResult((previous) => ({
        ...previous,
        [provider]: { ok: data.ok, message: data.message || data.detail },
      }));
      invalidate();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'The connection test failed to run.');
    },
  });

  const disconnect = useMutation({
    mutationFn: (provider: string) =>
      api.del(`/${activeOrganizationId}/integrations/${provider}`),
    onSuccess: invalidate,
  });

  if (integrations.isError) {
    return (
      <>
        <PageHeader title="Integrations" />
        <Card>
          <ErrorState message="Could not load integrations." onRetry={() => void integrations.refetch()} />
        </Card>
      </>
    );
  }

  const rows = integrations.data ?? [];

  return (
    <>
      <PageHeader
        title="Integrations"
        description="What RenewRadar can connect to, and what is actually connected right now."
      />

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="No providers" description="No integration providers are available." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((integration) => {
            const draft = drafts[integration.provider] ?? {};
            const result = testResult[integration.provider];
            return (
              <Card
                key={integration.provider}
                title={integration.label}
                description={integration.provider}
                actions={
                  <Badge tone={STATUS_TONE[integration.status]}>
                    {STATUS_LABEL[integration.status]}
                  </Badge>
                }
              >
                <p className="mb-3 text-[13px] text-ink-muted">
                  {integration.connected
                    ? 'Configured for this workspace.'
                    : 'Not connected. RenewRadar works fully without it: you can record subscriptions by hand or import a CSV.'}
                </p>

                <dl className="space-y-1.5 text-[13px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Last checked</dt>
                    <dd className="tabular">{formatDateTime(integration.lastCheckedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Confirms delivery</dt>
                    <dd className="text-ink">{integration.deliversMessages ? 'Yes' : 'No'}</dd>
                  </div>
                </dl>

                {integration.lastErrorCode ? (
                  <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px]">
                    <strong>{integration.lastErrorCode}</strong>
                    {integration.lastErrorMessage ? ` — ${integration.lastErrorMessage}` : ''}
                  </p>
                ) : null}

                {integration.maskedKeys.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-ink-muted">Stored credentials</p>
                    <ul className="mt-1 space-y-0.5 text-[13px]">
                      {integration.maskedKeys.map((entry) => (
                        <li key={entry.key} className="tabular text-ink-muted">
                          {entry.key}: <span className="text-ink">{entry.masked}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {canManage ? (
                  <form
                    className="mt-4 space-y-3 border-t border-line pt-4"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      save.mutate({ provider: integration.provider, credentials: draft });
                    }}
                  >
                    {integration.setupGuide.length > 0 ? (
                      <ul className="list-disc pl-5 text-[13px] text-ink-muted">
                        {integration.setupGuide.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                    <Field label="Credentials" hint="Stored encrypted. Never shown again in full.">
                      {({ id, describedBy }) => (
                        <Input
                          id={id}
                          type="password"
                          autoComplete="off"
                          placeholder="host, username, token…"
                          aria-describedby={describedBy}
                          value={Object.values(draft).join(',')}
                          onChange={(event) =>
                            setDrafts({ ...drafts, [integration.provider]: { value: event.target.value } })
                          }
                        />
                      )}
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" variant="secondary" loading={save.isPending}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        loading={test.isPending}
                        onClick={() => test.mutate(integration.provider)}
                      >
                        Test connection
                      </Button>
                      {integration.connected ? (
                        <Button
                          type="button"
                          variant="danger"
                          loading={disconnect.isPending}
                          onClick={() => disconnect.mutate(integration.provider)}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </div>
                    {result ? (
                      <p className="text-[13px] text-ink-muted">
                        {result.ok ? 'Connected.' : 'Not connected.'} {result.message}
                      </p>
                    ) : null}
                  </form>
                ) : null}

                {integration.limitations.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[13px] font-medium text-ink">Limitations</summary>
                    <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-muted">
                      {integration.limitations.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}