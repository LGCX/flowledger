/**
 * The committed fixture must migrate forward cleanly.
 *
 * This is the test that decides whether `test/fixtures/db/P02.sql` is worth committing. It restores the
 * dump into an empty database, runs the real migration runner against it, and expects *zero* files to
 * apply — the dump came from a database already at the latest M2 migration, so anything the runner wants
 * to apply means the fixture and the migrations have diverged.
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
  it('restores and needs no further migration', async () => {
    const empty = await createEmptyDatabase();
    try {
      restoreAsMigrationOwner(empty.ownerUrl, empty.name);

      const result = await migrate({ connectionString: empty.ownerUrl, ledgerBucketCount: 32 });

      // Zero, not "only some": every file in the dump's history is already recorded as applied.
      expect(result.applied).toEqual([]);
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
