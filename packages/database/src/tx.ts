/**
 * `withTransaction` (CONVENTIONS §7).
 *
 * Tenant context is set with `set_config(..., true)` — transaction-local — so it cannot outlive the
 * transaction on a pooled connection. That matters more than it looks: a leaked `app.merchant_id` would
 * make the next request on the same connection read another tenant's rows, and row-level security would
 * happily allow it because the setting says so.
 *
 * Retries exist for serialization failures (40001) and deadlocks (40P01) only. Those are the two codes
 * where PostgreSQL has guaranteed the transaction had no effect. Everything else — including a
 * deferred-constraint failure raised at COMMIT — propagates immediately, because retrying a genuine
 * domain rejection would hide it and multiply its cost.
 *
 * The callback must be re-entrant: it can run up to six times, and it must reuse the same idempotency,
 * provider, and posting keys across attempts (docs/07 lock order).
 */
import pg from 'pg';

import { mapPgError } from './errors.js';

export interface TxContext {
  readonly merchantId?: string;
  readonly correlationId?: string;
}

/** One initial attempt plus five retries. */
const MAX_ATTEMPTS = 6;
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const MIN_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 200;

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withTransaction<T>(
  pool: pg.Pool,
  ctx: TxContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    // Set when the rollback itself failed: the connection is in an unknown state and must not go back
    // to the pool, so it is released with an error, which destroys it.
    let destroyConnection = false;

    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (ctx.merchantId !== undefined) {
        await client.query("SELECT set_config('app.merchant_id', $1, true)", [ctx.merchantId]);
      }
      if (ctx.correlationId !== undefined) {
        await client.query("SELECT set_config('app.correlation_id', $1, true)", [
          ctx.correlationId,
        ]);
      }

      const result = await fn(client);
      // A deferred-constraint failure surfaces here, not in `fn`; it follows the same error path.
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyConnection = true;
      }

      const state = sqlStateOf(error);
      const retryable = state !== undefined && RETRYABLE_SQLSTATES.has(state);
      if (destroyConnection || !retryable || attempt >= MAX_ATTEMPTS) throw mapPgError(error);

      const backoff = MIN_BACKOFF_MS + Math.random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS);
      await sleep(backoff);
    } finally {
      if (destroyConnection) {
        client.release(new Error('connection destroyed after a failed rollback'));
      } else {
        client.release();
      }
    }
  }
}
