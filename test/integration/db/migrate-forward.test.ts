/**
 * The committed fixture must migrate forward cleanly.
 *
 * This is the test that decides whether `test/fixtures/db/P02.sql` is worth committing. It restores the
 * dump into an empty database and runs the real migration runner against it. The dump was taken at 0290;
 * the runner must apply exactly the files added since (the P02 review fixes, 0291–0294) and nothing
 * else, which is also the proof that those forward migrations hold against populated M2 data.
 *
 * Two details are load-bearing. The restore runs as `fl_migration_owner`, not as the superuser: with
 * `--no-owner` in the dump, restored objects belong to whoever runs `psql`, and a superuser-owned schema
 * leaves the migration runner without privileges on its own history table. And it runs through `psql`
 * rather than a Node client, because a plain `pg_dump` uses `COPY ... FROM stdin`, which needs the copy
 * protocol a simple `query()` cannot speak.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { migrate } from '@flowledger/database';
import {
  createEmptyDatabase,
  setTestConnection,
  TEST_MIGRATION_OWNER_PASSWORD,
  type TestDatabase,
} from '@flowledger/testkit';

/** Files added after the dump was generated (the P02 review fixes). */
const MIGRATIONS_AFTER_DUMP = [
  '0291_idempotency_replay_window.sql',
  '0292_outbox_derivation.sql',
  '0293_fee_snapshot_binding.sql',
  '0294_authorization_attempt_limit.sql',
];

const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'db', 'P02.sql');

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

// The global fixture still starts the container this test connects to.
let database: TestDatabase;
beforeAll(async () => {
  const { useTestDatabase } = await import('@flowledger/testkit');
  database = await useTestDatabase()();
});

afterAll(async () => {
  if (database !== undefined) {
    const { disposeTestDatabase } = await import('@flowledger/testkit');
    await disposeTestDatabase(database);
  }
});

/** The container publishing this database's port. */
function containerIdFor(ownerUrl: string): string {
  const port = new URL(ownerUrl).port;
  return execFileSync('docker', ['ps', '-q', '--filter', `publish=${port}`], {
    encoding: 'utf8',
  }).trim();
}

/** Restores the dump as the migration owner, so the runner owns what it finds. */
function restoreAsMigrationOwner(ownerUrl: string, databaseName: string): void {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${TEST_MIGRATION_OWNER_PASSWORD}`,
      containerIdFor(ownerUrl),
      'psql',
      '-U',
      'fl_migration_owner',
      '-d',
      databaseName,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ],
    { input: readFileSync(FIXTURE, 'utf8'), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  );
}

/** A client on the restored database — the fixture's content, not the test-run database's. */
async function withRestoredClient<T>(
  ownerUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('the committed P02 fixture', () => {
  it('restores and migrates forward through exactly the post-dump files', async () => {
    const empty = await createEmptyDatabase();
    try {
      restoreAsMigrationOwner(empty.ownerUrl, empty.name);

      const result = await migrate({ connectionString: empty.ownerUrl, ledgerBucketCount: 32 });

      // The dump was taken at 0290. Exactly the review fixes apply on top of it, in order, and they
      // validate against populated rows rather than an empty schema; nothing earlier re-applies.
      expect(result.applied).toEqual(MIGRATIONS_AFTER_DUMP);

      const again = await migrate({ connectionString: empty.ownerUrl, ledgerBucketCount: 32 });
      expect(again.applied).toEqual([]);
    } finally {
      await empty.drop();
    }
  }, 120_000);

  it('carries payments that satisfy the aggregate rules', async () => {
    const empty = await createEmptyDatabase();
    try {
      restoreAsMigrationOwner(empty.ownerUrl, empty.name);

      const count = await withRestoredClient(empty.ownerUrl, async (client) => {
        const { rows } = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM payments.payments',
        );
        return Number(rows[0]?.count);
      });
      expect(count).toBeGreaterThanOrEqual(4);

      // Touch every payment with the deferred constraints set immediate: the aggregate trigger then runs
      // inside this transaction instead of at commit, so an internally inconsistent fixture row fails
      // here rather than silently reaching a later phase.
      await withRestoredClient(empty.ownerUrl, async (client) => {
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        const touched = await client.query('UPDATE payments.payments SET version = version + 1');
        expect(touched.rowCount).toBe(count);
        await client.query('ROLLBACK');
      });
    } finally {
      await empty.drop();
    }
  }, 120_000);

  it('restores outbox rows that still carry their hot envelope', async () => {
    const empty = await createEmptyDatabase();
    try {
      restoreAsMigrationOwner(empty.ownerUrl, empty.name);

      const counts = await withRestoredClient(empty.ownerUrl, async (client) => {
        const { rows } = await client.query<{ total: string; with_envelope: string }>(
          `SELECT count(*)::text AS total, count(envelope)::text AS with_envelope
             FROM messaging.outbox_messages`,
        );
        return rows[0] as { total: string; with_envelope: string };
      });

      expect(Number(counts.total)).toBeGreaterThanOrEqual(4);
      // Nothing was lost in the round trip: every restored row still has its body.
      expect(counts.with_envelope).toBe(counts.total);
    } finally {
      await empty.drop();
    }
  }, 120_000);
});
