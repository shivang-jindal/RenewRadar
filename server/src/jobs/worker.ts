/**
 * Background worker (Part A / A2, Part E / Phase 4).
 *
 * Runs as its own process (`npm run dev:worker`). Jobs are claimed from the
 * database with a lease so several workers can share one queue without running
 * the same job twice, retryable failures use bounded exponential backoff, and
 * permanently failed jobs stay visible as `failed` for manual inspection.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { isNull } from 'drizzle-orm';

import type { Services } from '../container.js';
import { organizations } from '../db/schema.js';
import { resolveHandler, type JobOutcome } from './handlers.js';

/** How often the recurring per-organization jobs are enqueued. */
const RECURRING_INTERVAL_MS = 15 * 60_000;

export interface WorkerHandle {
  stop: () => Promise<void>;
  readonly workerId: string;
}

export async function startWorker(
  services: Services,
  options: { once?: boolean } = {},
): Promise<WorkerHandle> {
  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  let stopping = false;
  services.logger.info({ workerId }, 'worker started');

  const reapTimer = setInterval(() => {
    void services.jobs.reapStale().catch((error: unknown) => {
      services.logger.warn({ err: error }, 'could not reap stale job leases');
    });
  }, 60_000);
  reapTimer.unref();

  const recurringTimer = setInterval(() => {
    void enqueueRecurring(services).catch((error: unknown) => {
      services.logger.warn({ err: error }, 'could not enqueue recurring jobs');
    });
  }, RECURRING_INTERVAL_MS);
  recurringTimer.unref();

  await enqueueRecurring(services);

  let processed = 0;
  do {
    const handled = await drainOnce(services, workerId);
    processed += handled;
    if (!handled && !options.once) {
      await sleep(services.config.worker.pollIntervalMs);
    }
  } while (!stopping && !options.once);

  clearInterval(reapTimer);
  clearInterval(recurringTimer);

  if (options.once) {
    services.logger.info({ workerId, processed }, 'worker run finished');
  }

  return {
    workerId,
    stop: async () => {
      stopping = true;
      clearInterval(reapTimer);
      clearInterval(recurringTimer);
      services.logger.info({ workerId, processed }, 'worker stopped');
    },
  };
}

/** Claim and run jobs until the queue is empty for this pass. */
export async function drainOnce(services: Services, workerId: string): Promise<number> {
  let processed = 0;
  const parallel: Array<Promise<boolean>> = [];

  for (let index = 0; index < services.config.worker.concurrency; index += 1) {
    parallel.push(
      (async () => {
        const job = await services.jobs.claimNext(workerId);
        if (!job) return false;

        const handler = resolveHandler(job.jobType);
        if (!handler) {
          await services.jobs.markFailed(
            job.id,
            { code: 'unknown_job_type', message: `No handler for ${job.jobType}` },
            { retryable: false },
          );
          services.logger.error({ jobId: job.id, jobType: job.jobType }, 'unknown job type');
          return true;
        }

        try {
          const outcome: JobOutcome = await handler(services, job.payload ?? {});
          await services.jobs.markSucceeded(job.id);
          services.logger.debug(
            { jobId: job.id, jobType: job.jobType, code: outcome.code },
            'job completed',
          );
        } catch (error) {
          const code = error instanceof Error ? error.name || 'error' : 'error';
          const message = error instanceof Error ? error.message : String(error);
          services.logger.warn({ jobId: job.id, jobType: job.jobType, code }, 'job failed');
          await services.jobs.markFailed(job.id, { code, message }, { retryable: true });
        }
        return true;
      })(),
    );
  }

  const results = await Promise.all(parallel);
  for (const result of results) if (result) processed += 1;
  return processed;
}

/**
 * Recurring jobs carry an idempotency key that includes the current 15 minute
 * bucket, so a restart or a second worker never enqueues the same batch twice.
 */
async function enqueueRecurring(services: Services): Promise<void> {
  const bucket = Math.floor(Date.now() / RECURRING_INTERVAL_MS);

  await services.jobs.enqueue({
    jobType: 'maintenance.cleanup',
    payload: {},
    idempotencyKey: `maintenance.cleanup:${bucket}`,
  });

  const orgs = await services.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNull(organizations.deletedAt));

  for (const organization of orgs) {
    await services.jobs.enqueue({
      jobType: 'reminders.schedule',
      organizationId: organization.id,
      payload: { organizationId: organization.id },
      idempotencyKey: `reminders.schedule:${organization.id}:${bucket}`,
    });
    await services.jobs.enqueue({
      jobType: 'reminders.reconcile',
      organizationId: organization.id,
      payload: { organizationId: organization.id },
      idempotencyKey: `reminders.reconcile:${organization.id}:${bucket}`,
    });
  }
}
