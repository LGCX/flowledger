/**
 * `withTransaction` against real PostgreSQL.
 *
 * The retry tests drive the retry with a JavaScript attempt counter rather than a real lock conflict:
 * a real 40001 depends on timing and would make the suite flaky while testing the same code path.
 * What is asserted is the part that can be wrong — how many times the callback runs, and what
 * propagates when the budget is exhausted.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { DomainError, withTransaction } from '@flowledger/database';
import { setTestConnection, useTestDatabase, type TestDatabase } from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
let table: string;

beforeAll(async () => {
  const factory = useTestDatabase();
  database = await factory();

  table = 'tx_probe';
  await database.ownerPool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, note text)`);
});

afterAll(async () => {
  if (database === undefined) return;
  const { disposeTestDatabase } = await import('@flowledger/testkit');
  await disposeTestDatabase(database);
});

describe('context', () => {
  it('exposes merchant and correlation ids inside the callback and not afterwards', async () => {
    // max: 1 forces the same physical connection to be handed back, which is the case that matters.
    const pool = new pg.Pool({ connectionString: database.urlAs('fl_migration_owner'), max: 1 });

    try {
      const seen = await withTransaction(
        pool,
        { merchantId: 'mer_test_context', correlationId: 'corr-test-0001' },
        async (client) => {
          const inside = await client.query<{
            merchant: string | null;
            correlation: string | null;
          }>(
            "SELECT current_setting('app.merchant_id', true) AS merchant, current_setting('app.correlation_id', true) AS correlation",
          );
          return inside.rows[0];
        },
      );

      expect(seen).toEqual({ merchant: 'mer_test_context', correlation: 'corr-test-0001' });

      // Same pooled connection, outside the transaction: the settings must be gone.
      const client = await pool.connect();
      try {
        const after = await client.query<{ merchant: string | null; correlation: string | null }>(
          "SELECT current_setting('app.merchant_id', true) AS merchant, current_setting('app.correlation_id', true) AS correlation",
        );
        // PostgreSQL reports an unset GUC as either null or an empty string depending on how it was
        // last reset, so both mean "not set" here.
        expect((after.rows[0]?.merchant ?? '').length).toBe(0);
        expect((after.rows[0]?.correlation ?? '').length).toBe(0);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

describe('retries', () => {
  it.each(['40001', '40P01'])(
    'retries a %s failure and succeeds on the third attempt',
    async (code) => {
      let attempts = 0;

      const result = await withTransaction(database.ownerPool, {}, async (client) => {
        attempts += 1;
        if (attempts < 3) {
          await client.query(
            `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '${code}', MESSAGE = 'transient'; END $$`,
          );
        }
        return 'done';
      });

      expect(result).toBe('done');
      expect(attempts).toBe(3);
    },
  );

  it('gives up after six attempts and propagates the original error', async () => {
    let attempts = 0;

    const error = await withTransaction(database.ownerPool, {}, async (client) => {
      attempts += 1;
      await client.query(
        "DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'persistent'; END $$",
      );
      return 'unreachable';
    }).catch((caught: unknown) => caught);

    expect(attempts).toBe(6);
    expect((error as { code?: string }).code).toBe('40001');
    // Not a DomainError: a serialization failure that never resolved is not a domain rejection.
    expect(error).not.toBeInstanceOf(DomainError);
  });

  it('does not retry a non-retryable error', async () => {
    let attempts = 0;

    await expect(
      withTransaction(database.ownerPool, {}, async () => {
        attempts += 1;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(attempts).toBe(1);
  });
});

describe('rollback', () => {
  it('leaves no rows when the callback fails after inserting', async () => {
    await expect(
      withTransaction(database.ownerPool, {}, async (client) => {
        await client.query(`INSERT INTO ${table} (id, note) VALUES (1, 'rolled back')`);
        throw new Error('after insert');
      }),
    ).rejects.toThrow('after insert');

    const rows = await database.ownerPool.query(`SELECT count(*)::int AS count FROM ${table}`);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('leaves no rows when a deferred constraint fails at COMMIT', async () => {
    await database.ownerPool.query(`
      CREATE OR REPLACE FUNCTION tx_probe_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'deferred constraint fired';
      END
      $$;
    `);
    await database.ownerPool.query(`
      CREATE CONSTRAINT TRIGGER tx_probe_deferred
      AFTER INSERT ON ${table}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION tx_probe_boom();
    `);

    try {
      await expect(
        withTransaction(database.ownerPool, {}, async (client) => {
          await client.query(`INSERT INTO ${table} (id, note) VALUES (2, 'deferred')`);
        }),
      ).rejects.toThrow(/deferred constraint fired/);

      const rows = await database.ownerPool.query(`SELECT count(*)::int AS count FROM ${table}`);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await database.ownerPool.query(`DROP TRIGGER tx_probe_deferred ON ${table}`);
    }
  });
});

describe('domain errors', () => {
  it('maps a P0001 domain code with its detail', async () => {
    const error = await withTransaction(database.ownerPool, {}, async (client) => {
      await client.query(
        `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MONETARY_GUARD_FAILED', DETAIL = '{"available":"5"}'; END $$`,
      );
      return 'unreachable';
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('MONETARY_GUARD_FAILED');
    expect((error as DomainError).detail).toEqual({ available: '5' });
  });

  it('does not retry a domain rejection', async () => {
    let attempts = 0;

    await expect(
      withTransaction(database.ownerPool, {}, async (client) => {
        attempts += 1;
        await client.query(
          `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_PAYMENT_STATE'; END $$`,
        );
      }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(attempts).toBe(1);
  });
});
