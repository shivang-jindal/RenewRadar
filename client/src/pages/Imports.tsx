/**
 * CSV import: preview, resolve duplicates per row, then commit.
 * Nothing is written until the preview has been reviewed.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import {
  IMPORT_COLUMNS,
  IMPORT_DUPLICATE_CHOICES,
  type ImportDuplicateChoice,
  type ImportPreview,
  type ImportResult,
} from '@renewradar/shared';

import { api, ApiError } from '../lib/api';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';
import { MetricCard } from '../components/patterns';

const TEMPLATE =
  'name,vendor_name,plan_name,category,amount,currency,interval_unit,interval_count,start_date,next_renewal_date,status,notes';

export function ImportsPage() {
  const { activeOrganizationId } = useSession();
  const navigate = useNavigate();
  const canImport = usePermission('subscription.create');

  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, ImportDuplicateChoice>>({});

  const runPreview = useMutation({
    mutationFn: () =>
      api.post<ImportPreview>(`/${activeOrganizationId}/imports/subscriptions`, {
        filename: filename.trim() || 'subscriptions.csv',
        csv,
        mapping: {},
      }),
    onSuccess: (data) => {
      setPreview(data);
      // Default every duplicate to "skip" so a commit never overwrites by accident.
      setChoices(
        Object.fromEntries(
          data.rows
            .filter((row) => row.duplicateOf)
            .map((row) => [row.rowNumber, 'skip' as ImportDuplicateChoice]),
        ),
      );
    },
  });

  const commit = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error('No preview');
      return api.post<ImportResult>(`/${activeOrganizationId}/imports/subscriptions/commit`, {
        importId: preview.importId,
        rows: Object.entries(choices).map(([rowNumber, duplicateChoice]) => ({
          rowNumber: Number(rowNumber),
          duplicateChoice,
        })),
      });
    },
  });

  function readFile(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      window.alert('That file is larger than the 2 MB limit.');
      return;
    }
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  if (!canImport) {
    return (
      <>
        <PageHeader title="CSV import" />
        <Card>
          <p className="text-[13px] text-ink-muted">
            Your role does not allow importing subscriptions.
          </p>
        </Card>
      </>
    );
  }

  const result = commit.data;

  return (
    <>
      <PageHeader
        title="CSV import"
        description="Bring in subscriptions from a bank statement or a spreadsheet. You review everything before anything is saved."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="1. Choose a file">
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              runPreview.mutate();
            }}
          >
            <Field label="CSV file" hint="Up to 2 MB.">
              {({ id }) => (
                <input
                  id={id}
                  type="file"
                  accept=".csv,text/csv"
                  className="block w-full text-[13px]"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) readFile(file);
                  }}
                />
              )}
            </Field>
            <Field label="Or paste the CSV" hint={`Recognised columns: ${IMPORT_COLUMNS.join(', ')}.`}>
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={8}
                  spellCheck={false}
                  placeholder={TEMPLATE}
                  value={csv}
                  onChange={(event) => setCsv(event.target.value)}
                />
              )}
            </Field>
            {runPreview.error instanceof ApiError ? (
              <p role="alert" className="text-[13px] text-[color:var(--color-danger)]">
                {runPreview.error.message}
              </p>
            ) : null}
            <Button type="submit" variant="primary" loading={runPreview.isPending} disabled={!csv.trim()}>
              Preview import
            </Button>
          </form>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {result ? (
            <Card title="3. Import finished">
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricCard label="Created" value={result.created} />
                <MetricCard label="Updated" value={result.updated} />
                <MetricCard label="Skipped" value={result.skipped} />
                <MetricCard label="Failed" value={result.failed} />
              </div>
              {result.errors.length > 0 ? (
                <div className="mt-3">
                  <p className="mb-1 text-[13px] font-medium text-ink">Rows that failed</p>
                  <ul className="list-disc pl-5 text-[13px] text-ink-muted">
                    {result.errors.slice(0, 20).map((error) => (
                      <li key={`${error.rowNumber}-${error.code}`}>
                        Row {error.rowNumber}: {error.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Button
                className="mt-3"
                variant="secondary"
                onClick={() => navigate(`/${activeOrganizationId}/subscriptions`)}
              >
                View subscriptions
              </Button>
            </Card>
          ) : null}

          {!preview && !result ? (
            <Card>
              <EmptyState
                title="Nothing to preview yet"
                description="Choose a CSV file or paste rows, then preview. RenewRadar shows you exactly what it will do before writing anything."
              />
            </Card>
          ) : null}

          {preview && !result ? (
            <>
              <Card title="2. Review the preview" description="Nothing has been saved yet.">
                <div className="grid gap-3 sm:grid-cols-4">
                  <MetricCard label="Rows read" value={preview.totalRows} />
                  <MetricCard label="Valid" value={preview.validRows} />
                  <MetricCard label="Duplicates" value={preview.duplicateRows} />
                  <MetricCard label="Errors" value={preview.errorRows} />
                </div>

                {preview.duplicateRows > 0 ? (
                  <p className="mt-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
                    {preview.duplicateRows} row(s) look like subscriptions you already have.
                    Each defaults to <strong>skip</strong>, so re-running this import will not
                    overwrite anything unless you choose to.
                  </p>
                ) : null}

                <div className="mt-4">
                  <Button
                    variant="primary"
                    loading={commit.isPending}
                    disabled={preview.validRows === 0}
                    onClick={() => commit.mutate()}
                  >
                    Import {preview.validRows} row{preview.validRows === 1 ? '' : 's'}
                  </Button>
                  {commit.error instanceof ApiError ? (
                    <p role="alert" className="mt-2 text-[13px] text-[color:var(--color-danger)]">
                      {commit.error.message}
                    </p>
                  ) : null}
                </div>
              </Card>

              <Card title="Rows">
                {preview.rows.length === 0 ? (
                  <EmptyState title="No rows" description="Nothing in this file can be imported." />
                ) : (
                  <table className="w-full text-left text-[13px]">
                    <caption className="sr-only">Preview of rows to import</caption>
                    <thead>
                      <tr className="border-b border-line text-xs text-ink-muted uppercase">
                        <th scope="col" className="py-2 font-semibold">Row</th>
                        <th scope="col" className="py-2 font-semibold">Subscription</th>
                        <th scope="col" className="py-2 font-semibold">Problems</th>
                        <th scope="col" className="py-2 font-semibold">Duplicate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.rowNumber} className="border-b border-line last:border-0 align-top">
                          <td className="tabular py-2">{row.rowNumber}</td>
                          <td className="py-2">
                            {row.normalized ? (
                              <>
                                <span className="block text-ink">{row.normalized.name}</span>
                                <span className="block text-xs text-ink-muted">
                                  {row.normalized.vendorName} · {(row.normalized.amountMinor / 100).toFixed(2)}{' '}
                                  {row.normalized.currency} · renews {row.normalized.nextRenewalDate ?? '—'}
                                </span>
                              </>
                            ) : (
                              <span className="text-ink-subtle">Not imported</span>
                            )}
                          </td>
                          <td className="py-2">
                            {row.errors.length === 0 && row.warnings.length === 0 ? (
                              <span className="text-ink-subtle">—</span>
                            ) : (
                              <ul className="space-y-0.5">
                                {row.errors.map((problem) => (
                                  <li key={problem.code} className="text-[color:var(--color-danger)]">
                                    {problem.message}
                                  </li>
                                ))}
                                {row.warnings.map((problem) => (
                                  <li key={problem.code} className="text-ink-muted">{problem.message}</li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className="py-2">
                            {row.duplicateOf ? (
                              <>
                                <p className="mb-1 text-xs text-ink-muted">
                                  Matches “{row.duplicateOf.name}” ({row.duplicateOf.reason})
                                </p>
                                <Select
                                  aria-label={`Duplicate choice for row ${row.rowNumber}`}
                                  value={choices[row.rowNumber] ?? 'skip'}
                                  onChange={(event) =>
                                    setChoices({
                                      ...choices,
                                      [row.rowNumber]: event.target.value as ImportDuplicateChoice,
                                    })
                                  }
                                >
                                  {IMPORT_DUPLICATE_CHOICES.map((choice) => (
                                    <option key={choice} value={choice}>{choice}</option>
                                  ))}
                                </Select>
                              </>
                            ) : (
                              <span className="text-ink-subtle">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}