/** Budgets, with usage always scoped to the budget's own currency. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BUDGET_PERIODS,
  SUPPORTED_CURRENCIES,
  type BudgetView,
  type CategoryView,
} from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
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
} from '../components/ui';

export function BudgetsPage() {
  const { activeOrganizationId } = useSession();
  const queryClient = useQueryClient();
  const canManage = usePermission('budget.manage');

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [period, setPeriod] = useState<string>('monthly');
  const [error, setError] = useState<string | null>(null);

  const budgets = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'budgets'],
    queryFn: () => api.get<BudgetView[]>(`/${activeOrganizationId}/budgets`),
    enabled: Boolean(activeOrganizationId),
  });

  const categories = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'categories'],
    queryFn: () => api.get<CategoryView[]>(`/${activeOrganizationId}/categories`),
    enabled: Boolean(activeOrganizationId),
  });

  const create = useMutation({
    mutationFn: () => {
      const cleaned = amount.trim().replace(/,/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
        setError('Enter an amount such as 250.00.');
        throw new ApiError(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid amount', requestId: '' } }, 'Invalid amount');
      }
      return api.post(`/${activeOrganizationId}/budgets`, {
        name: name.trim(),
        categoryId: categoryId || null,
        amountMinor: Math.round(Number(cleaned) * 100),
        currency,
        period,
      });
    },
    onSuccess: () => {
      setError(null);
      setName('');
      setAmount('');
      void queryClient.invalidateQueries({ queryKey: ['renewradar', activeOrganizationId] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the budget.');
    },
  });

  return (
    <>
      <PageHeader
        title="Budgets"
        description="A cap you set for recurring spend. RenewRadar measures it against your recorded commitments."
      />

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}

      {budgets.isError ? (
        <Card>
          <ErrorState message="Could not load budgets." onRetry={() => void budgets.refetch()} />
        </Card>
      ) : null}

      {budgets.data && budgets.data.length === 0 ? (
        <Card>
          <EmptyState title="No budgets" description="Set a cap to see how close you are to it." />
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(budgets.data ?? []).map((budget) => (
          <Card
            key={budget.id}
            title={budget.name}
            description={`${budget.period === 'monthly' ? 'Per month' : 'Per year'} · ${budget.categoryName ?? 'All categories'}`}
            actions={<Badge tone={budget.atRisk ? 'warning' : 'success'}>{budget.atRisk ? 'Near limit' : 'On track'}</Badge>}
          >
            <p className="tabular text-2xl font-semibold text-ink">
              {formatMoney(budget.spendMinor, budget.currency)}
            </p>
            <p className="tabular text-[13px] text-ink-muted">
              of {formatMoney(budget.amountMinor, budget.currency)}
            </p>
            {budget.usagePercent !== null ? (
              <>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                  <div
                    className={
                      budget.atRisk
                        ? 'h-full rounded-full bg-[color:var(--color-warning)]'
                        : 'h-full rounded-full bg-brand-500'
                    }
                    style={{ width: `${Math.min(100, budget.usagePercent)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {Math.round(budget.usagePercent)}% used · warning at {budget.thresholdPercent}%
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs text-ink-subtle">
                No spend recorded in this period, so no usage figure is shown.
              </p>
            )}
          </Card>
        ))}
      </div>

      {canManage ? (
        <Card className="mt-4" title="Add a budget">
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Name" required>
                {({ id }) => (
                  <Input id={id} value={name} onChange={(event) => setName(event.target.value)} required />
                )}
              </Field>
              <Field label="Category" hint="Leave blank to cover everything.">
                {({ id }) => (
                  <Select id={id} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                    <option value="">All categories</option>
                    {(categories.data ?? []).map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Amount" required>
                {({ id }) => (
                  <Input id={id} inputMode="decimal" placeholder="250.00" value={amount}
                    onChange={(event) => setAmount(event.target.value)} required />
                )}
              </Field>
              <Field label="Currency" required>
                {({ id }) => (
                  <Select id={id} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                    {SUPPORTED_CURRENCIES.map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Period" required>
                {({ id }) => (
                  <Select id={id} value={period} onChange={(event) => setPeriod(event.target.value)}>
                    {BUDGET_PERIODS.map((value) => (
                      <option key={value} value={value}>{value === 'monthly' ? 'Per month' : 'Per year'}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={create.isPending}>Add budget</Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}