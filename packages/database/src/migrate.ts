/**
 * The forward-only SQL migration runner (docs/07 §Migration order, CONVENTIONS §8).
 *
 * There is no migration library. The runner is small enough to audit in one sitting, and the guarantee
 * that matters — every applied file's bytes are checksummed and a changed file stops the run — is
 * something a library would have to be trusted for rather than read.
 *
 * Order of operations is deliberate: *all* history checks happen before *any* file is applied. A run
 * that discovers a checksum mismatch halfway through has already written part of a divergent history,
 * so the checksums, missing files, and out-of-order files are validated first and the database is
 * untouched if any of them fails.
 *
 * Each file runs in its own transaction with one simple-protocol query, so a file containing several
 * statements is atomic as a whole. Earlier files stay committed if a later one fails — that is the
 * forward-only contract: a broken migration is fixed by a new one, not by pretending the last one
 * never happened.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { LOGIN_RUNTIME_ROLES, MIGRATION_OWNER } from './roles.js';

/**
 * Same depth from `src/` and `dist/`, so the built CLI finds the repo's `migrations/` too.
 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations/', import.meta.url),
);

const FILENAME_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

/** One constant key: every runner in every process contends on the same lock. */
const ADVISORY_LOCK_KEY = "hashtext('flowledger.migrate')::bigint";

export interface MigrateOptions {
  readonly connectionString: string;
  readonly dir?: string;
  /** Inclusive four-digit prefix, e.g. `'0230'`. */
  readonly upTo?: string;
  readonly ledgerBucketCount: number;
  readonly ledgerEnvironment?: 'LOCAL' | 'SANDBOX';
  /** Defaults to `fl_migration_owner`; P06 passes `fl_simulator` for `migrate --simulator`. */
  readonly expectedOwner?: string;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export class MigrationError extends Error {
  constructor(
    readonly reason:
      | 'NOT_MIGRATION_OWNER'
      | 'CHECKSUM_MISMATCH'
      | 'APPLIED_FILE_MISSING'
      | 'OUT_OF_ORDER'
      | 'INVALID_FILENAME'
      | 'FILE_FAILED',
    readonly filename?: string,
    options?: { cause?: unknown },
  ) {
    super(
      `${reason}${filename === undefined ? '' : `: ${filename}`}`,
      options === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'MigrationError';
  }
}

function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name);

  for (const name of sqlFiles) {
    if (!FILENAME_PATTERN.test(name)) throw new MigrationError('INVALID_FILENAME', name);
  }

  // Plain code-unit order, not locale order: `localeCompare` would sort `0010` and `0100`
  // differently under some locales and silently reorder the history.
  return sqlFiles.sort();
}

interface AppliedRow {
  readonly filename: string;
  readonly sha256: Buffer;
}

async function assertHistoryMatchesDisk(
  client: pg.Client,
  dir: string,
  onDisk: readonly string[],
): Promise<AppliedRow[]> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT filename, sha256 FROM public.schema_migrations ORDER BY filename',
  );

  const diskSet = new Set(onDisk);
  for (const row of rows) {
    if (!diskSet.has(row.filename)) throw new MigrationError('APPLIED_FILE_MISSING', row.filename);
  }

  for (const row of rows) {
    const bytes = await readFile(join(dir, row.filename));
    if (!sha256(bytes).equals(Buffer.from(row.sha256))) {
      throw new MigrationError('CHECKSUM_MISMATCH', row.filename);
    }
  }

  return rows;
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  const expectedOwner = options.expectedOwner ?? MIGRATION_OWNER;
  const client = new pg.Client({ connectionString: options.connectionString });

  await client.connect();
  let locked = false;

  try {
    const who = await client.query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== expectedOwner) {
      throw new MigrationError('NOT_MIGRATION_OWNER');
    }

    // Names in the file list are validated before the lock so a bad filename fails fast, but the
    // ordering must be re-derived under the lock: another runner may have applied files in between.
    const allFiles = await listMigrationFiles(dir);

    await client.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename text COLLATE "C" PRIMARY KEY,
        sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const appliedRows = await assertHistoryMatchesDisk(client, dir, allFiles);
    const appliedSet = new Set(appliedRows.map((row) => row.filename));

    const candidates =
      options.upTo === undefined
        ? allFiles
        : allFiles.filter((name) => name.slice(0, 4) <= (options.upTo as string));

    const pending = candidates.filter((name) => !appliedSet.has(name));

    // A new file that sorts before the newest applied file means this database's history and a fresh
    // one would diverge. Rejecting it forces a rebase instead of an untraceable ordering difference.
    const newestApplied = appliedRows.at(-1)?.filename;
    if (newestApplied !== undefined) {
      const outOfOrder = pending.find((name) => name < newestApplied);
      if (outOfOrder !== undefined) throw new MigrationError('OUT_OF_ORDER', outOfOrder);
    }

    const skipped = candidates.filter((name) => appliedSet.has(name));
    const applied: string[] = [];
    const bucketCount = String(options.ledgerBucketCount);
    const environment = options.ledgerEnvironment ?? 'LOCAL';

    for (const filename of pending) {
      const bytes = await readFile(join(dir, filename));

      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT set_config('flowledger.ledger_bucket_count', $1, true),
                  set_config('flowledger.ledger_environment', $2, true)`,
          [bucketCount, environment],
        );
        // One simple-protocol query so a multi-statement file is atomic as a unit.
        await client.query(bytes.toString('utf8'));
        await client.query(
          'INSERT INTO public.schema_migrations (filename, sha256) VALUES ($1, $2)',
          [filename, sha256(bytes)],
        );
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK');
        throw new MigrationError('FILE_FAILED', filename, { cause });
      }
      applied.push(filename);
    }

    return { applied, skipped };
  } finally {
    if (locked) {
      // Use the same key expression; a failed unlock is not worth masking the original error with.
      await client.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => undefined);
    }
    await client.end();
  }
}

/**
 * Creates `fl_migration_owner` and the target database if they are absent. Idempotent, and intended to
 * run against a superuser connection so the migration user does not need to be a superuser itself.
 */
export async function bootstrapDatabase(adminUrl: string, migrationUrl: string): Promise<void> {
  const target = new URL(migrationUrl);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const migrationUser = decodeURIComponent(target.username);
  const migrationPassword = decodeURIComponent(target.password);

  if (migrationUser !== MIGRATION_OWNER) {
    throw new MigrationError('NOT_MIGRATION_OWNER', undefined);
  }
  if (databaseName.length === 0) {
    throw new Error('MIGRATION_DATABASE_URL has no database name');
  }

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const password = client.escapeLiteral(migrationPassword);
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [MIGRATION_OWNER]);
    if (role.rowCount === 0) {
      await client.query(`CREATE ROLE ${MIGRATION_OWNER} LOGIN CREATEROLE PASSWORD ${password}`);
    } else {
      await client.query(`ALTER ROLE ${MIGRATION_OWNER} LOGIN CREATEROLE PASSWORD ${password}`);
    }

    const database = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (database.rowCount === 0) {
      // Identifiers cannot be parameterised in utility statements.
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(databaseName)} OWNER ${MIGRATION_OWNER}`,
      );
    } else {
      // The database may already exist owned by someone else — the PostgreSQL image creates
      // `POSTGRES_DB` as the superuser, which leaves the migration owner unable to create anything in
      // `public`. Bootstrap's promise is that the owner can use the database, so make that true.
      await client.query(
        `ALTER DATABASE ${client.escapeIdentifier(databaseName)} OWNER TO ${MIGRATION_OWNER}`,
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Sets the synthetic local password on every runtime login role that exists. Run by the migration
 * owner, which holds ADMIN OPTION on the roles it created in migration `0200`.
 */
export async function setLocalRolePasswords(
  client: pg.ClientBase,
  password: string,
): Promise<string[]> {
  const { rows } = await client.query<{ rolname: string }>(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
    [[...LOGIN_RUNTIME_ROLES]],
  );

  const altered: string[] = [];
  const literal = client.escapeLiteral(password);
  for (const row of rows) {
    await client.query(`ALTER ROLE ${client.escapeIdentifier(row.rolname)} PASSWORD ${literal}`);
    altered.push(row.rolname);
  }
  return altered;
}
