/**
 * PostgreSQL error helpers.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError`, and the underlying code
 * differs slightly between node-postgres and the embedded PGlite driver. These
 * helpers recognise a condition by SQLSTATE first and by message as a fallback,
 * so a rule collision becomes a documented 409 instead of an opaque 500.
 */

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

interface DriverErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

function asDriverError(error: unknown): DriverErrorLike | null {
  return error && typeof error === 'object' ? (error as DriverErrorLike) : null;
}

/** True when the failure is a unique/primary-key constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  // Drizzle wraps the driver error; unwrap a few levels rather than one.
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = asDriverError(current);
    if (!candidate) return false;
    if (candidate.code === UNIQUE_VIOLATION) return true;
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (
      message.includes('duplicate key value violates unique constraint') ||
      message.includes('UNIQUE constraint failed')
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
