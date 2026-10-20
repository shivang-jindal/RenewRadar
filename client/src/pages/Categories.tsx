/** Categories, with monthly spend always reported per currency. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { type CategoryView } from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
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
} from '../components/ui';

const COLOR_TOKENS = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;

export function CategoriesPage() {
  const { activeOrganizationId } = useSession();
  const queryClient = useQueryClient();
  const canManage = usePermission('category.manage');

  const [name, setName] = useState('');
  const [colorToken, setColorToken] = useState<string>('slate');
  const [error, setError] = useState<string | null>(null);

  const categories = useQuery({
    queryKey: ['renewradar', activeOrganizationId, 'categories'],
    queryFn: () => api.get<CategoryView[]>(`/${activeOrganizationId}/categories`),
    enabled: Boolean(activeOrganizationId),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post(`/${activeOrganizationId}/categories`, { name: name.trim(), colorToken }),
    onSuccess: () => {
      setError(null);
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['renewradar', activeOrganizationId] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the category.');
    },
  });

  return (
    <>
      <PageHeader
        title="Categories"
        description="Group subscriptions so you can see where recurring spend goes."
      />

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}

      {categories.isError ? (
        <Card>
          <ErrorState message="Could not load categories." onRetry={() => void categories.refetch()} />
        </Card>
      ) : null}

      {categories.data && categories.data.length === 0 ? (
        <Card>
          <EmptyState title="No categories" description="Create one to group your subscriptions." />
        </Card>
      ) : null}

      {categories.data && categories.data.length > 0 ? (
        <Card>
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Categories and their monthly spend</caption>
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted uppercase">
                <th scope="col" className="py-2 font-semibold">Category</th>
                <th scope="col" className="py-2 text-right font-semibold">Subscriptions</th>
                <th scope="col" className="py-2 font-semibold">Monthly spend</th>
              </tr>
            </thead>
            <tbody>
              {categories.data.map((category) => (
                <tr key={category.id} className="border-b border-line last:border-0">
                  <td className="py-2 text-ink">{category.name}</td>
                  <td className="tabular py-2 text-right">{category.subscriptionCount}</td>
                  <td className="py-2">
                    {category.monthlyMinorByCurrency.length === 0 ? (
                      <span className="text-ink-subtle">—</span>
                    ) : (
                      // Never summed across currencies: each is listed separately.
                      <span className="tabular">
                        {category.monthlyMinorByCurrency
                          .map((entry) => formatMoney(entry.amountMinor, entry.currency))
                          .join(' · ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {canManage ? (
        <Card className="mt-4" title="Add a category">
          <form
            className="flex flex-wrap items-end gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className="min-w-56 flex-1">
              <Field label="Name" required>
                {({ id }) => (
                  <Input id={id} value={name} onChange={(event) => setName(event.target.value)} required />
                )}
              </Field>
            </div>
            <div>
              <Field label="Colour">
                {({ id }) => (
                  <Select id={id} value={colorToken} onChange={(event) => setColorToken(event.target.value)}>
                    {COLOR_TOKENS.map((token) => (
                      <option key={token} value={token}>{token}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={create.isPending}>Add category</Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}