/**
 * CLI configuration (P02-T01).
 *
 * The CLI acts as several roles, so it takes one URL per role it performs rather than a single
 * `DATABASE_URL`: `flowledger migrate` connects as `fl_migration_owner`, and later operator commands
 * connect as `fl_operator_readonly`. A service process still has exactly one `DATABASE_URL`.
 *
 * Every error names the variable and never its value. These variables include database URLs with
 * passwords, and a config error is exactly the moment a value is most likely to be pasted into a log.
 */
export interface CliConfig {
  readonly migrationDatabaseUrl: string;
  readonly databaseAdminUrl: string | null;
  readonly ledgerBucketCount: number;
  readonly ledgerEnvironment: 'LOCAL' | 'SANDBOX';
  readonly localRolePassword: string | null;
  readonly databasePoolMax: number;
}

export class CliConfigError extends Error {
  constructor(
    readonly variable: string,
    readonly reason: string,
  ) {
    super(`${variable}: ${reason}`);
    this.name = 'CliConfigError';
  }
}

function requireValue(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (value === undefined || value.trim().length === 0) {
    throw new CliConfigError(variable, 'is required');
  }
  return value;
}

function optionalValue(env: NodeJS.ProcessEnv, variable: string): string | null {
  const value = env[variable];
  return value === undefined || value.trim().length === 0 ? null : value;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  variable: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = optionalValue(env, variable);
  if (raw === null) return defaultValue;

  if (!/^[0-9]+$/.test(raw)) throw new CliConfigError(variable, 'must be a base-10 integer');
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    throw new CliConfigError(variable, `must be between ${String(min)} and ${String(max)}`);
  }
  return parsed;
}

export function loadCliConfig(env: NodeJS.ProcessEnv): Readonly<CliConfig> {
  const migrationDatabaseUrl = requireValue(env, 'MIGRATION_DATABASE_URL');

  let parsed: URL;
  try {
    parsed = new URL(migrationDatabaseUrl);
  } catch {
    // Deliberately does not echo the value: it contains a password.
    throw new CliConfigError('MIGRATION_DATABASE_URL', 'must be a valid postgres URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new CliConfigError('MIGRATION_DATABASE_URL', 'must be a postgres URL');
  }

  const environment = optionalValue(env, 'LEDGER_ENVIRONMENT') ?? 'LOCAL';
  if (environment !== 'LOCAL' && environment !== 'SANDBOX') {
    throw new CliConfigError('LEDGER_ENVIRONMENT', 'must be LOCAL or SANDBOX');
  }

  const localRolePassword = optionalValue(env, 'FLOWLEDGER_LOCAL_ROLE_PASSWORD');
  if (localRolePassword !== null && env.NODE_ENV === 'production') {
    throw new CliConfigError(
      'FLOWLEDGER_LOCAL_ROLE_PASSWORD',
      'is refused when NODE_ENV=production',
    );
  }

  return Object.freeze({
    migrationDatabaseUrl,
    databaseAdminUrl: optionalValue(env, 'DATABASE_ADMIN_URL'),
    ledgerBucketCount: readInteger(env, 'LEDGER_BUCKET_COUNT', 32, 1, 1024),
    ledgerEnvironment: environment,
    localRolePassword,
    databasePoolMax: readInteger(env, 'DATABASE_POOL_MAX', 4, 1, 100),
  });
}
