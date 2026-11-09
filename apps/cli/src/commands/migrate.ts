/**
 * `flowledger migrate` (P02-T01).
 *
 * Exit codes follow CONVENTIONS §4: `0` on success, `1` on a migration failure. The command prints one
 * line per applied file so an operator can see which migration failed without opening a log, and it
 * prints the failure reason and filename rather than a stack trace — the reason vocabulary is the
 * actionable part.
 */
import { parseArgs } from 'node:util';

import pg from 'pg';

import { loadCliConfig } from '@flowledger/config';
import {
  MigrationError,
  bootstrapDatabase,
  migrate,
  setLocalRolePasswords,
} from '@flowledger/database';

export const MIGRATE_REQUIRED_ENV = ['MIGRATION_DATABASE_URL'] as const;

export async function migrateCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
): Promise<number> {
  let values: { bootstrap?: boolean; dir?: string; 'up-to'?: string };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        bootstrap: { type: 'boolean' },
        dir: { type: 'string' },
        'up-to': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (error) {
    out(`migrate: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let config;
  try {
    config = loadCliConfig(env);
  } catch (error) {
    out(`migrate: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    if (values.bootstrap === true) {
      if (config.databaseAdminUrl === null) {
        out('migrate: --bootstrap requires DATABASE_ADMIN_URL');
        return 1;
      }
      await bootstrapDatabase(config.databaseAdminUrl, config.migrationDatabaseUrl);
      out('bootstrapped: fl_migration_owner and database exist');
    }

    const result = await migrate({
      connectionString: config.migrationDatabaseUrl,
      ...(values.dir === undefined ? {} : { dir: values.dir }),
      ...(values['up-to'] === undefined ? {} : { upTo: values['up-to'] }),
      ledgerBucketCount: config.ledgerBucketCount,
      ledgerEnvironment: config.ledgerEnvironment,
    });

    for (const filename of result.applied) out(`applied ${filename}`);
    for (const filename of result.skipped) out(`skipped ${filename}`);
    out(
      `migrate: ${String(result.applied.length)} applied, ${String(result.skipped.length)} skipped`,
    );

    if (config.localRolePassword !== null) {
      const altered = await withMigrationClient(
        config.migrationDatabaseUrl,
        config.localRolePassword,
      );
      out(`roles: ${String(altered.length)} password(s) set`);
    }

    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      out(`migrate: ${error.reason}${error.filename === undefined ? '' : ` ${error.filename}`}`);
      return 1;
    }
    out(`migrate: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function withMigrationClient(
  connectionString: string,
  password: string,
): Promise<readonly string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await setLocalRolePasswords(client, password);
  } finally {
    await client.end();
  }
}
