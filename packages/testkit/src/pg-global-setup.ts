/**
 * Vitest global setup for the database projects (P02-T01).
 *
 * One container per run, one fully migrated `fl_template` database inside it. Test files clone the
 * template instead of each running every migration, so the schema is identical everywhere while the
 * migration run happens exactly once — the property README §8.3 asks for, minus one container per
 * worker.
 *
 * `fsync=off` is safe here because the container is thrown away; it is what keeps a suite that creates
 * and drops dozens of databases from being I/O bound.
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { bootstrapDatabase, migrate, setLocalRolePasswords } from '@flowledger/database';

import { TEMPLATE_DATABASE, TEST_MIGRATION_OWNER_PASSWORD, TEST_ROLE_PASSWORD } from './pg.js';
import { POSTGRES_IMAGE } from './postgres.js';

const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'flowledger_local_only';
const BOOTSTRAP_DATABASE = 'postgres';

function ownerUrl(host: string, port: number, database: string): string {
  return `postgres://fl_migration_owner:${TEST_MIGRATION_OWNER_PASSWORD}@${host}:${String(port)}/${database}`;
}

export default async function setup(project: {
  provide: (key: 'flowledgerPg', value: { adminUrl: string; host: string; port: number }) => void;
}): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .withDatabase(BOOTSTRAP_DATABASE)
    .withCommand(['postgres', '-c', 'max_connections=400', '-c', 'fsync=off'])
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = `postgres://${SUPERUSER}:${SUPERUSER_PASSWORD}@${host}:${String(port)}/${BOOTSTRAP_DATABASE}`;

  await bootstrapDatabase(adminUrl, ownerUrl(host, port, TEMPLATE_DATABASE));

  const templateUrl = ownerUrl(host, port, TEMPLATE_DATABASE);
  await migrate({ connectionString: templateUrl, ledgerBucketCount: 32 });

  const templateClient = new pg.Client({ connectionString: templateUrl });
  await templateClient.connect();
  try {
    await setLocalRolePasswords(templateClient, TEST_ROLE_PASSWORD);
  } finally {
    await templateClient.end();
  }

  // A clone fails if any session is still attached to the template.
  const adminClient = new pg.Client({ connectionString: adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEMPLATE_DATABASE],
    );
  } finally {
    await adminClient.end();
  }

  project.provide('flowledgerPg', { adminUrl, host, port });

  return async () => {
    await container.stop().then(() => undefined);
  };
}
