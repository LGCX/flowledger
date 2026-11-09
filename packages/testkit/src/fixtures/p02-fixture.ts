/**
 * Generates the committed P02 fixture dump.
 *
 * This lives in `testkit` rather than in the generator script because the container dependencies are
 * declared here: module resolution follows the importing file's location, so a root-level script cannot
 * see them however it is invoked.
 *
 * It mirrors `pg-global-setup.ts` deliberately — one container, a bootstrapped and migrated template, a
 * clone of it — so the dump is produced from exactly the database state the integration tests run
 * against, rather than from a second, subtly different setup.
 */
import { execFileSync } from 'node:child_process';

import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { bootstrapDatabase, migrate, setLocalRolePasswords } from '@flowledger/database';

import {
  createTestDatabase,
  disposeTestDatabase,
  setTestConnection,
  TEMPLATE_DATABASE,
  TEST_MIGRATION_OWNER_PASSWORD,
  TEST_ROLE_PASSWORD,
  type TestDatabase,
} from '../pg.js';
import { populateP02 } from './populate-p02.js';

const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'flowledger_local_only';
const BOOTSTRAP_DATABASE = 'postgres';

export interface P02Fixture {
  readonly sql: string;
  readonly database: TestDatabase;
}

function ownerUrl(host: string, port: number, database: string): string {
  return `postgres://fl_migration_owner:${TEST_MIGRATION_OWNER_PASSWORD}@${host}:${String(port)}/${database}`;
}

/** The id of the container publishing `port`, so `pg_dump` can run inside it. */
function containerIdForPort(port: number): string {
  return execFileSync('docker', ['ps', '-q', '--filter', `publish=${String(port)}`], {
    encoding: 'utf8',
  }).trim();
}

export async function generateP02Fixture(): Promise<P02Fixture> {
  const container = await new PostgreSqlContainer('postgres:17')
    .withDatabase(BOOTSTRAP_DATABASE)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .start();

  try {
    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const adminUrl = `postgres://${SUPERUSER}:${SUPERUSER_PASSWORD}@${host}:${String(port)}/${BOOTSTRAP_DATABASE}`;

    await bootstrapDatabase(adminUrl, ownerUrl(host, port, TEMPLATE_DATABASE));
    await migrate({
      connectionString: ownerUrl(host, port, TEMPLATE_DATABASE),
      ledgerBucketCount: 32,
    });

    const templateClient = new pg.Client({
      connectionString: ownerUrl(host, port, TEMPLATE_DATABASE),
    });
    await templateClient.connect();
    try {
      await setLocalRolePasswords(templateClient, TEST_ROLE_PASSWORD);
    } finally {
      await templateClient.end();
    }

    setTestConnection({ adminUrl, host, port });
    const database = await createTestDatabase();
    await populateP02(database.ownerPool);

    // `--no-owner`/`--no-acl` so the restore works as whatever role the restoring environment provides;
    // `--no-comments` keeps the file diffable.
    const sql = execFileSync(
      'docker',
      [
        'exec',
        containerIdForPort(port),
        'pg_dump',
        '-U',
        SUPERUSER,
        '--no-owner',
        '--no-acl',
        '--no-comments',
        database.name,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
    );

    // Dispose before the container stops: an idle pooled client whose server disappears emits an
    // unhandled 'error' event, which surfaces as a crash rather than a clean exit.
    await disposeTestDatabase(database);

    return { sql, database };
  } finally {
    await container.stop();
  }
}
