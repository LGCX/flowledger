/**
 * `flowledger credentials issue|revoke` — operator credential lifecycle.
 *
 * Connects as `fl_operator_command`, which holds column-level grants on the credentials table: it can
 * issue and revoke but cannot rewrite a digest. Rotation is `issue` followed by `revoke` of the old ID;
 * the overlap window in docs/05 is operational guidance, not something enforced here.
 *
 * The raw credential is printed once and never written anywhere else — the database keeps only a
 * peppered digest, so a lost credential is reissued, not recovered.
 */
import { generateCredential, newId, parsePeppers } from '@flowledger/domain';
import type { Peppers } from '@flowledger/domain';
import { issueCredential, revokeCredential } from '@flowledger/database';
import pg from 'pg';

import { CliConfigError, loadCliConfig } from '@flowledger/config';

import { isLocalEnvironment } from './local-only.js';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;

export async function credentialsCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
): Promise<number> {
  const [action] = argv;

  if (action !== 'issue' && action !== 'revoke') {
    out('usage: flowledger credentials <issue|revoke> [options]');
    return EXIT_USAGE;
  }

  try {
    return action === 'issue'
      ? await issue(argv.slice(1), env, out)
      : await revoke(argv.slice(1), env, out);
  } catch (error) {
    // A configuration error is an operator mistake, not a crash: report it and exit non-zero.
    if (error instanceof CliConfigError) {
      out(`credentials ${action} failed: ${error.message}`);
      return EXIT_FAILED;
    }
    throw error;
  }
}

function option(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function operatorUrl(env: NodeJS.ProcessEnv): string {
  const url = env.OPERATOR_DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new CliConfigError('OPERATOR_DATABASE_URL', 'is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the value: it contains a password.
    throw new CliConfigError('OPERATOR_DATABASE_URL', 'must be a valid postgres URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new CliConfigError('OPERATOR_DATABASE_URL', 'must be a postgres URL');
  }
  // The operator role is the whole point of this variable; connecting as anyone else would silently
  // grant more than the command is meant to have.
  if (parsed.username !== 'fl_operator_command') {
    throw new CliConfigError('OPERATOR_DATABASE_URL', 'must connect as fl_operator_command');
  }
  return url;
}

async function withClient<T>(
  env: NodeJS.ProcessEnv,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  // `loadCliConfig` validates MIGRATION_DATABASE_URL; the operator URL is validated separately so a
  // credential command does not need the migration credentials at all.
  void loadCliConfig({
    ...env,
    MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL ?? operatorUrl(env),
  });

  const client = new pg.Client({ connectionString: operatorUrl(env) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function peppers(env: NodeJS.ProcessEnv): { peppers: Peppers; currentVersion: number } {
  const spec = env.API_CREDENTIAL_PEPPERS;
  if (spec === undefined || spec.trim().length === 0) {
    throw new CliConfigError('API_CREDENTIAL_PEPPERS', 'is required');
  }
  return parsePeppers(spec);
}

async function issue(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
): Promise<number> {
  const merchantId = option(argv, '--merchant');
  const scopeList = option(argv, '--scopes');
  const expiresAt = option(argv, '--expires-at');

  // Issuing prints a raw `fl_test_` credential; revoking prints nothing secret and stays available.
  if (!isLocalEnvironment(env)) {
    out('credentials issue refused: NODE_ENV must be development or test');
    return EXIT_FAILED;
  }

  if (merchantId === null || scopeList === null) {
    out(
      'usage: flowledger credentials issue --merchant <mer_id> --scopes <scopes> [--expires-at <ISO-8601>]',
    );
    return EXIT_USAGE;
  }

  const generated = generateCredential(peppers(env));
  const credentialId = `mcr_${newCredentialBody()}`;

  try {
    await withClient(env, (client) =>
      issueCredential(client, {
        id: credentialId,
        merchantId,
        keyPrefix: generated.keyPrefix,
        digest: generated.digest,
        digestVersion: generated.digestVersion,
        scopes: scopeList.split(',').filter((scope) => scope.length > 0),
        expiresAt: expiresAt === null ? null : new Date(expiresAt),
      }),
    );
  } catch (error) {
    // A rejected scope allowlist or an unknown merchant is a user error, not a crash.
    out(`credentials issue failed: ${(error as Error).message}`);
    return EXIT_FAILED;
  }

  out(`${merchantId}  ${credentialId}`);
  out(generated.raw);
  out('credential is synthetic and shown once');
  return EXIT_OK;
}

async function revoke(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
): Promise<number> {
  const credentialId = option(argv, '--id');
  if (credentialId === null) {
    out('usage: flowledger credentials revoke --id <mcr_id>');
    return EXIT_USAGE;
  }

  const revoked = await withClient(env, (client) => revokeCredential(client, credentialId));
  if (!revoked) {
    out('not found or already revoked');
    return EXIT_FAILED;
  }

  out(`revoked ${credentialId}`);
  return EXIT_OK;
}

/** A ULID-shaped body, so the ID matches the entity-ID contract the database enforces. */
function newCredentialBody(): string {
  return newId('mcr').slice('mcr_'.length);
}
