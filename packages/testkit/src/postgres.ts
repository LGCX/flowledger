import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The one place the PostgreSQL image version lives for tests. `compose.yaml` carries the
 * same tag for local development, and an integration test asserts the two agree so they
 * cannot drift (CONVENTIONS §2: exact pins, recorded in docs/VERSIONS.md).
 */
export const POSTGRES_IMAGE = 'postgres:17.11';

const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'flowledger_local_only';
const POSTGRES_DATABASE = 'test';
const SIMULATOR_PASSWORD = 'fl_simulator_local_only';
const TRUTH_PASSWORD = 'fl_simulator_truth_local_only';

/** Same bootstrap the Compose stack mounts, so both paths run identical SQL. */
const INIT_SCRIPT_DIR = fileURLToPath(
  new URL('../../../infra/docker/postgres-init', import.meta.url),
);

export interface StartedPostgres {
  /** Superuser connection to the default database. */
  readonly uri: string;
  /** Connection string for any database/role created by the bootstrap script. */
  uriFor(database: string, user?: string, password?: string): string;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(POSTGRES_USER)
    .withPassword(POSTGRES_PASSWORD)
    .withDatabase(POSTGRES_DATABASE)
    .withEnvironment({
      FL_SIMULATOR_PASSWORD: SIMULATOR_PASSWORD,
      FL_SIMULATOR_TRUTH_PASSWORD: TRUTH_PASSWORD,
    })
    .withCopyDirectoriesToContainer([
      { source: INIT_SCRIPT_DIR, target: '/docker-entrypoint-initdb.d' },
    ])
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  return {
    uri: container.getConnectionUri(),
    uriFor: (database, user = POSTGRES_USER, password = POSTGRES_PASSWORD) =>
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`,
    stop: () => container.stop().then(() => undefined),
  };
}
