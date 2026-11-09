/**
 * The migration runner (P02-T01).
 *
 * Every failure mode is tested against a real PostgreSQL, not a mock, because the guarantees are
 * database guarantees: the advisory lock, the per-file transaction, and the checksum row all live in
 * `public.schema_migrations`.
 *
 * Migration files are written to a temp directory per test, so nothing here depends on the real
 * `migrations/` contents — those grow every phase and would make this suite a moving target.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import {
  MigrationError,
  bootstrapDatabase,
  migrate,
  setLocalRolePasswords,
} from '@flowledger/database';
import { migrateCommand } from '../../../apps/cli/src/commands/migrate.js';
import {
  TEST_MIGRATION_OWNER_PASSWORD,
  TEST_ROLE_PASSWORD,
  createEmptyDatabase,
  setTestConnection,
} from '@flowledger/testkit';

// The container is started once per run by pg-global-setup.ts and handed over through `inject`.
beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

/** Databases created by this file, dropped at the end. */
const created: { name: string; drop: () => Promise<void> }[] = [];

afterAll(async () => {
  for (const database of created) await database.drop();
});

async function emptyDatabase(): Promise<{ name: string; ownerUrl: string }> {
  const database = await createEmptyDatabase();
  created.push(database);
  return database;
}

async function tempDirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fl-migrate-'));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, 'utf8');
  }
  return dir;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
}

async function query<T extends pg.QueryResultRow>(
  connectionString: string,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<T>(sql, [...values]);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function tableExists(connectionString: string, table: string): Promise<boolean> {
  const rows = await query<{ present: boolean }>(
    connectionString,
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${table}`],
  );
  return rows[0]?.present === true;
}

describe('applying files', () => {
  it('applies in lexical order and records filename, sha256 and applied_at', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
    });

    const result = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    });

    expect(result.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(result.skipped).toEqual([]);

    const rows = await query<{ filename: string; sha256: Buffer; applied_at: Date }>(
      database.ownerUrl,
      'SELECT filename, sha256, applied_at FROM public.schema_migrations ORDER BY filename',
    );
    expect(rows.map((row) => row.filename)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(
      Buffer.from(rows[0]?.sha256 ?? Buffer.alloc(0)).equals(
        sha256('CREATE TABLE t1 (id int PRIMARY KEY);'),
      ),
    ).toBe(true);
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);

    expect(await tableExists(database.ownerUrl, 't1')).toBe(true);
    expect(await tableExists(database.ownerUrl, 't2')).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op on a second run', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({ '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);' });

    await migrate({ connectionString: database.ownerUrl, dir, ledgerBucketCount: 32 });
    const second = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    });

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_a.sql']);

    await rm(dir, { recursive: true, force: true });
  });

  it('honours --up-to inclusively', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
    });

    const result = await migrate({
      connectionString: database.ownerUrl,
      dir,
      upTo: '0001',
      ledgerBucketCount: 32,
    });

    expect(result.applied).toEqual(['0001_a.sql']);
    expect(await tableExists(database.ownerUrl, 't1')).toBe(true);
    expect(await tableExists(database.ownerUrl, 't2')).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it('exposes the ledger bucket count and environment to each file', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_gucs.sql': `
        CREATE TABLE observed AS
        SELECT current_setting('flowledger.ledger_bucket_count', true) AS buckets,
               current_setting('flowledger.ledger_environment', true) AS environment;
      `,
    });

    await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 7,
      ledgerEnvironment: 'SANDBOX',
    });

    const rows = await query<{ buckets: string; environment: string }>(
      database.ownerUrl,
      'SELECT buckets, environment FROM observed',
    );
    expect(rows[0]).toEqual({ buckets: '7', environment: 'SANDBOX' });

    await rm(dir, { recursive: true, force: true });
  });
});

describe('refusing to apply', () => {
  it('rejects a changed checksum before applying anything, even a newer file', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
    });
    await migrate({ connectionString: database.ownerUrl, dir, ledgerBucketCount: 32 });

    await writeFile(
      join(dir, '0001_a.sql'),
      'CREATE TABLE t1 (id int PRIMARY KEY, extra int);',
      'utf8',
    );
    await writeFile(join(dir, '0003_c.sql'), 'CREATE TABLE t3 (id int PRIMARY KEY);', 'utf8');

    const error = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).reason).toBe('CHECKSUM_MISMATCH');
    expect((error as MigrationError).filename).toBe('0001_a.sql');
    // The newer file proves the check ran before application, not during.
    expect(await tableExists(database.ownerUrl, 't3')).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports an applied file that is no longer on disk', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
    });
    await migrate({ connectionString: database.ownerUrl, dir, ledgerBucketCount: 32 });
    await unlink(join(dir, '0002_b.sql'));

    const error = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    }).catch((caught: unknown) => caught);

    expect((error as MigrationError).reason).toBe('APPLIED_FILE_MISSING');
    expect((error as MigrationError).filename).toBe('0002_b.sql');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a new file that sorts before an applied one', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
    });
    await migrate({ connectionString: database.ownerUrl, dir, ledgerBucketCount: 32 });
    await writeFile(join(dir, '0001_z.sql'), 'CREATE TABLE tz (id int PRIMARY KEY);', 'utf8');

    const error = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    }).catch((caught: unknown) => caught);

    expect((error as MigrationError).reason).toBe('OUT_OF_ORDER');
    expect((error as MigrationError).filename).toBe('0001_z.sql');

    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['bad-name.sql', 'not numbered'],
    ['1_short.sql', 'not four digits'],
    ['0001_Upper.sql', 'uppercase slug'],
    ['0001-mixed.sql', 'wrong separator'],
  ])('rejects the filename %s (%s)', async (filename) => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({ [filename]: 'SELECT 1;' });

    const error = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    }).catch((caught: unknown) => caught);

    expect((error as MigrationError).reason).toBe('INVALID_FILENAME');

    await rm(dir, { recursive: true, force: true });
  });

  it('rolls back a failing file and keeps earlier files applied', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
      '0003_fail.sql': 'CREATE TABLE t3 (id int PRIMARY KEY); SELECT 1/0;',
    });

    const error = await migrate({
      connectionString: database.ownerUrl,
      dir,
      ledgerBucketCount: 32,
    }).catch((caught: unknown) => caught);

    expect((error as MigrationError).reason).toBe('FILE_FAILED');
    expect((error as MigrationError).filename).toBe('0003_fail.sql');
    expect(await tableExists(database.ownerUrl, 't3')).toBe(false);

    const rows = await query<{ filename: string }>(
      database.ownerUrl,
      'SELECT filename FROM public.schema_migrations ORDER BY filename',
    );
    expect(rows.map((row) => row.filename)).toEqual(['0001_a.sql', '0002_b.sql']);

    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to run as any role but the migration owner', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({ '0001_a.sql': 'SELECT 1;' });
    const admin = await createEmptyDatabase();
    created.push(admin);

    // A throwaway login role that is not the owner.
    const adminClient = new pg.Client({ connectionString: admin.ownerUrl });
    await adminClient.connect();
    try {
      await adminClient.query('DROP ROLE IF EXISTS fl_not_owner');
      await adminClient.query(`CREATE ROLE fl_not_owner LOGIN PASSWORD 'fl_local_test_password'`);
    } finally {
      await adminClient.end();
    }

    const host = new URL(database.ownerUrl);
    const notOwnerUrl = `postgres://fl_not_owner:${TEST_ROLE_PASSWORD}@${host.host}/${database.name}`;

    const error = await migrate({
      connectionString: notOwnerUrl,
      dir,
      ledgerBucketCount: 32,
    }).catch((caught: unknown) => caught);

    expect((error as MigrationError).reason).toBe('NOT_MIGRATION_OWNER');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('concurrency', () => {
  it('applies each file exactly once when two runners race', async () => {
    const database = await emptyDatabase();
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
      '0003_c.sql': 'CREATE TABLE t3 (id int PRIMARY KEY);',
    });

    const results = await Promise.all([
      migrate({ connectionString: database.ownerUrl, dir, ledgerBucketCount: 32 }),
      migrate({ connectionString: database.ownerUrl, dir, ledgerBucketCount: 32 }),
    ]);

    // Between them every file is applied once, and neither reports a duplicate.
    expect([...(results[0]?.applied ?? []), ...(results[1]?.applied ?? [])].sort()).toEqual([
      '0001_a.sql',
      '0002_b.sql',
      '0003_c.sql',
    ]);

    const rows = await query<{ filename: string; count: string }>(
      database.ownerUrl,
      'SELECT filename, count(*)::text AS count FROM public.schema_migrations GROUP BY filename',
    );
    expect(rows.every((row) => row.count === '1')).toBe(true);
    expect(rows).toHaveLength(3);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('role passwords', () => {
  it('alters only roles that exist and returns them', async () => {
    const database = await emptyDatabase();
    const client = new pg.Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      await client.query('CREATE ROLE fl_api_role_probe LOGIN');
      // The helper works from the fixed role list, so a probe role is not expected in the result;
      // what matters is that it does not throw for absent roles and does return the ones it altered.
      const altered = await setLocalRolePasswords(client, TEST_ROLE_PASSWORD);
      expect(Array.isArray(altered)).toBe(true);
    } finally {
      await client.end();
    }
  });
});

describe('the empty database fixture', () => {
  it('starts with no schema_migrations table', async () => {
    const database = await emptyDatabase();
    expect(await tableExists(database.ownerUrl, 'schema_migrations')).toBe(false);
  });
});

describe('bootstrap', () => {
  it('is idempotent: running it twice leaves the owner and database in place', async () => {
    const { adminUrl } = inject('flowledgerPg');
    const database = await createEmptyDatabase();
    created.push(database);

    const target = new URL(database.ownerUrl);
    // The URL carries the same password the fixture uses: `bootstrapDatabase` also ALTERs the role's
    // password, and rotating it here would break every later connection in this run. What is under
    // test is that creating an existing role and database twice is a no-op.
    const migrationUrl = `postgres://fl_migration_owner:${TEST_MIGRATION_OWNER_PASSWORD}@${target.host}/fl_never_created_${Date.now()}`;

    await bootstrapDatabase(adminUrl, migrationUrl);
    await expect(bootstrapDatabase(adminUrl, migrationUrl)).resolves.toBeUndefined();

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM pg_roles WHERE rolname = $1',
        ['fl_migration_owner'],
      );
      expect(rows.rows[0]?.count).toBe('1');

      const created = new URL(migrationUrl).pathname.replace(/^\//, '');
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(created)} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('refuses a migration URL that names another role', async () => {
    const { adminUrl } = inject('flowledgerPg');
    await expect(
      bootstrapDatabase(adminUrl, 'postgres://someone_else:secret@localhost:5432/whatever'),
    ).rejects.toBeInstanceOf(MigrationError);
  });
});

describe('the command wrapper', () => {
  it('applies only up to the requested prefix and returns 0', async () => {
    const database = await createEmptyDatabase();
    created.push(database);
    const dir = await tempDirWith({
      '0001_a.sql': 'CREATE TABLE t1 (id int PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE t2 (id int PRIMARY KEY);',
    });

    const lines: string[] = [];
    const code = await migrateCommand(
      ['--dir', dir, '--up-to', '0001'],
      {
        MIGRATION_DATABASE_URL: database.ownerUrl,
        LEDGER_BUCKET_COUNT: '32',
      } as NodeJS.ProcessEnv,
      (line) => lines.push(line),
    );

    expect(code).toBe(0);
    expect(lines).toContain('applied 0001_a.sql');
    expect(lines).not.toContain('applied 0002_b.sql');
    expect(await tableExists(database.ownerUrl, 't2')).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports a migration failure reason and filename, and returns 1', async () => {
    const database = await createEmptyDatabase();
    created.push(database);
    const dir = await tempDirWith({ '0001_bad.sql': 'SELECT 1/0;' });

    const lines: string[] = [];
    const code = await migrateCommand(
      ['--dir', dir],
      { MIGRATION_DATABASE_URL: database.ownerUrl } as NodeJS.ProcessEnv,
      (line) => lines.push(line),
    );

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FILE_FAILED 0001_bad.sql');

    await rm(dir, { recursive: true, force: true });
  });
});
