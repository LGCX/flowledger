/**
 * The PostgreSQL fixture.
 *
 * One container per Vitest run holds a fully migrated `fl_template` database; each test file clones it
 * with `CREATE DATABASE ... TEMPLATE`. Cloning is a file copy inside the server, so it keeps the two
 * properties that matter — migrations are applied once per run, and each file starts from an identical
 * schema — without paying for a container (and a full migration run) per worker.
 *
 * Two access doors on purpose. `ownerPool` connects as `fl_migration_owner`, which owns the tables and
 * is therefore exempt from row-level security: it is how a test sets up state and asserts on raw rows.
 * `poolAs(role)` connects as a real runtime role, so RLS and grants apply exactly as in production —
 * a test that used the owner for everything would pass while the actual policy denied every request.
 */
import pg from 'pg';

import { LOGIN_RUNTIME_ROLES, mapPgError, type LoginRuntimeRole } from '@flowledger/database';

/** Synthetic, local-only. Never a real credential. */
export const TEST_ROLE_PASSWORD = 'fl_local_test_password';
export const TEST_MIGRATION_OWNER_PASSWORD = 'fl_local_owner_password';

/** The migrated template every test database is cloned from. */
export const TEMPLATE_DATABASE = 'fl_template';

/**
 * The shape the global setup hands to every test file. Declared as a `vitest` augmentation so
 * `inject('flowledgerPg')` is typed at the call site without each test file restating it.
 */
declare module 'vitest' {
  interface ProvidedContext {
    flowledgerPg: { adminUrl: string; host: string; port: number };
  }
}

export interface TestDatabase {
  readonly name: string;
  /** `fl_migration_owner`: table owner, RLS-exempt, triggers still fire. */
  readonly ownerPool: pg.Pool;
  poolAs(role: LoginRuntimeRole): pg.Pool;
  urlAs(role: LoginRuntimeRole | 'fl_migration_owner'): string;
}

/** Set by the global setup through `inject()`. */
let connection: { adminUrl: string; host: string; port: number } | null = null;

export function setTestConnection(value: { adminUrl: string; host: string; port: number }): void {
  connection = value;
}

function requireConnection(): { adminUrl: string; host: string; port: number } {
  if (connection === null) {
    throw new Error(
      'the PostgreSQL fixture needs pg-global-setup.ts; is it registered for this Vitest project?',
    );
  }
  return connection;
}

function urlFor(
  database: string,
  user: string,
  password: string,
  host: string,
  port: number,
): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}`;
}

function ownerUrlFor(database: string): string {
  const { host, port } = requireConnection();
  return urlFor(database, 'fl_migration_owner', TEST_MIGRATION_OWNER_PASSWORD, host, port);
}

async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: requireConnection().adminUrl });
  await client.connect();
  return client;
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}

const issuedPools = new WeakMap<
  pg.Pool,
  { database: string; rolePools: Map<LoginRuntimeRole, pg.Pool> }
>();

/**
 * A database cloned from the migrated template. Callers drop it when finished; `useTestDatabase`
 * wires that into `afterAll`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const { host, port } = requireConnection();
  const name = `fl_t_${randomSuffix()}`;

  const admin = await adminClient();
  try {
    await admin.query(
      `CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${TEMPLATE_DATABASE} OWNER fl_migration_owner`,
    );
  } finally {
    await admin.end();
  }

  const ownerPool = new pg.Pool({ connectionString: ownerUrlFor(name), max: 4 });
  const rolePools = new Map<LoginRuntimeRole, pg.Pool>();
  // Pools are recorded as they are handed out so disposal ends exactly those, without creating pools
  // for roles nobody used.
  issuedPools.set(ownerPool, { database: name, rolePools });

  return {
    name,
    ownerPool,
    urlAs: (role) =>
      role === 'fl_migration_owner'
        ? ownerUrlFor(name)
        : urlFor(name, role, TEST_ROLE_PASSWORD, host, port),
    poolAs: (role) => {
      const existing = rolePools.get(role);
      if (existing !== undefined) return existing;

      if (!(LOGIN_RUNTIME_ROLES as readonly string[]).includes(role)) {
        throw new Error(`unknown runtime role: ${role}`);
      }
      const pool = new pg.Pool({
        connectionString: urlFor(name, role, TEST_ROLE_PASSWORD, host, port),
        max: 4,
      });
      rolePools.set(role, pool);
      return pool;
    },
  };
}

async function dropDatabase(name: string): Promise<void> {
  const admin = await adminClient();
  try {
    // FORCE terminates any leftover session; a leaked pool would otherwise block the drop.
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Returns the fixture factory for `beforeAll`. The database is created once per test *file*, and each
 * test isolates itself further by creating its own rows (and merchants, from P02-T07 onward).
 */
export function useTestDatabase(): () => Promise<TestDatabase> {
  let database: TestDatabase | null = null;

  return async () => {
    database = await createTestDatabase();
    return database;
  };
}

/** A database with no schema at all, for testing the runner itself. */
export async function createEmptyDatabase(): Promise<{
  name: string;
  ownerUrl: string;
  drop: () => Promise<void>;
}> {
  const name = `fl_empty_${randomSuffix()}`;
  const admin = await adminClient();
  try {
    await admin.query(
      `CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE template0 OWNER fl_migration_owner`,
    );
  } finally {
    await admin.end();
  }

  return {
    name,
    ownerUrl: ownerUrlFor(name),
    drop: () => dropDatabase(name),
  };
}

/** Runs `fn` as a `SECURITY DEFINER` function-owner role inside a transaction. */
export async function withRole<T>(
  pool: pg.Pool,
  role: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  options: { merchantId?: string } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(role)}`);
    if (options.merchantId !== undefined) {
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [options.merchantId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Map like `withTransaction`, so a test asserting a domain code sees a DomainError whichever
    // helper it ran the statement through.
    throw mapPgError(error);
  } finally {
    client.release();
  }
}

/** Ends the pools this database handed out and drops it. */
export async function disposeTestDatabase(database: TestDatabase): Promise<void> {
  const issued = issuedPools.get(database.ownerPool);
  await database.ownerPool.end().catch(() => undefined);
  for (const pool of issued?.rolePools.values() ?? []) {
    await pool.end().catch(() => undefined);
  }
  await dropDatabase(database.name);
}
