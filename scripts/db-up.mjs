/**
 * `pnpm db:up` — start the Compose stack, then prove the published port reaches *this* container.
 *
 * A local PostgreSQL usually owns 127.0.0.1:5432 on a developer machine. Docker's published port binds
 * the same address, and macOS resolves `localhost` to 127.0.0.1 — so the client silently reaches the
 * local server instead of the container. The failure then looks like a migration problem: an older
 * server rejects PG16+ syntax such as `GRANT ... WITH INHERIT FALSE, SET TRUE`, and the reported error
 * is a syntax error in a migration that is perfectly valid.
 *
 * Compose itself cannot detect this, and neither can the migration runner. This preflight can: it
 * compares the `version()` reported through the published port with the one the container reports.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const log = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => process.stderr.write(`${line}\n`);

import pg from 'pg';

const HOST_PORT = process.env.POSTGRES_HOST_PORT ?? '5432';
const SUPERUSER = process.env.POSTGRES_SUPERUSER ?? 'postgres';
const SUPERUSER_PASSWORD = process.env.POSTGRES_SUPERUSER_PASSWORD ?? 'flowledger_local_only';

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function containerVersion() {
  return run('docker', [
    'exec',
    'flowledger-postgres-1',
    'psql',
    '-U',
    SUPERUSER,
    '-tAc',
    'select version()',
  ]);
}

async function publishedVersion() {
  const client = new pg.Client({
    connectionString: `postgres://${SUPERUSER}:${SUPERUSER_PASSWORD}@localhost:${HOST_PORT}/postgres`,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const { rows } = await client.query('select version()');
    return rows[0].version;
  } finally {
    await client.end();
  }
}

log(run('docker', ['compose', '-f', 'infra/docker/compose.yaml', 'up', '-d', '--wait']));

const inContainer = containerVersion();
const published = await publishedVersion();

if (inContainer !== published) {
  fail(
    [
      '',
      `db:up: port ${HOST_PORT} does not reach the Compose container.`,
      '',
      `  container: ${inContainer}`,
      `  port ${HOST_PORT}:  ${published}`,
      '',
      'Another PostgreSQL is listening on that address, so the CLI would migrate the wrong server.',
      'Either stop it, or run the stack on a free port and point the URLs at it:',
      '',
      `  POSTGRES_HOST_PORT=5433 pnpm db:up`,
      `  MIGRATION_DATABASE_URL=postgres://fl_migration_owner:fl_local_owner_password@localhost:5433/flowledger \\`,
      `  DATABASE_ADMIN_URL=postgres://postgres:flowledger_local_only@localhost:5433/postgres \\`,
      '  pnpm db:migrate --bootstrap',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

log(`db:up: port ${HOST_PORT} reaches the container (${inContainer.split(',')[0]})`);
