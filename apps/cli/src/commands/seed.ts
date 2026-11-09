/**
 * `flowledger seed --profile dev` — a working local database in one command.
 *
 * The rows are fixed rather than random so a developer can name a payment, a route or a fee policy in a
 * request without first querying the database. Only the credentials are random, and they are printed
 * once because that is the only time the raw value exists: the database stores a peppered digest.
 *
 * This is a command, not a migration (CONVENTIONS §8): dev data in a migration would ship to every
 * environment that migrates, including production.
 */
import { generateCredential, newId, parsePeppers } from '@flowledger/domain';
import type { Peppers } from '@flowledger/domain';
import { issueCredential } from '@flowledger/database';
import pg from 'pg';

import { CliConfigError, loadCliConfig } from '@flowledger/config';

import { isLocalEnvironment } from './local-only.js';

const MERCHANT_A = 'mer_0000000000000000000000DEVA';
const MERCHANT_B = 'mer_0000000000000000000000DEVB';

interface AccountFixture {
  readonly id: string;
  readonly merchantId: string;
  readonly providerCode: string;
  readonly externalReference: string;
  readonly credentialId: string;
}

const ACCOUNTS: readonly AccountFixture[] = [
  {
    id: 'pacc_000000000000000000000FAKEA',
    merchantId: MERCHANT_A,
    providerCode: 'fake-provider',
    externalReference: 'sim-fake-a',
    credentialId: 'pac_000000000000000000000FAKEA',
  },
  {
    id: 'pacc_000000000000000000000FAKEB',
    merchantId: MERCHANT_B,
    providerCode: 'fake-provider',
    externalReference: 'sim-fake-b',
    credentialId: 'pac_000000000000000000000FAKEB',
  },
  {
    id: 'pacc_0000000000000000000000RNDA',
    merchantId: MERCHANT_A,
    providerCode: 'unreliable-provider',
    externalReference: 'sim-rnd-a',
    credentialId: 'pac_0000000000000000000000RNDA',
  },
  {
    id: 'pacc_0000000000000000000000RNDB',
    merchantId: MERCHANT_B,
    providerCode: 'unreliable-provider',
    externalReference: 'sim-rnd-b',
    credentialId: 'pac_0000000000000000000000RNDB',
  },
];

const ENDPOINTS = [
  {
    id: 'pwe_0000000000000000000000FAKE',
    providerCode: 'fake-provider',
    key: '0000000000000000000EPKFAKE',
  },
  {
    id: 'pwe_00000000000000000000000RND',
    providerCode: 'unreliable-provider',
    key: '00000000000000000000EPKRND',
  },
] as const;

export interface SeedResult {
  readonly exitCode: number;
  readonly credentials: readonly SeedCredential[];
}

export interface SeedCredential {
  readonly merchantId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
  readonly raw: string;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;

export async function seedCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
): Promise<SeedResult> {
  if (!argv.includes('--profile') || argv[argv.indexOf('--profile') + 1] !== 'dev') {
    out('seed: only --profile dev is supported');
    return { exitCode: EXIT_FAILED, credentials: [] };
  }

  // A seed writes credentials in clear text to stdout; that must never happen in production, nor
  // anywhere NODE_ENV fails to say the database is local.
  if (env.NODE_ENV === 'production') {
    out('seed refused in production');
    return { exitCode: EXIT_FAILED, credentials: [] };
  }
  if (!isLocalEnvironment(env)) {
    out('seed refused: NODE_ENV must be development or test');
    return { exitCode: EXIT_FAILED, credentials: [] };
  }

  const config = loadCliConfig(env);
  const peppers = readPeppers(env);

  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT 1 FROM identity.merchants WHERE id = $1', [
      MERCHANT_A,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      out('already seeded');
      return { exitCode: EXIT_OK, credentials: [] };
    }

    await insertIdentity(client);
    await insertProviders(client);
    await insertFeePolicies(client);

    const credentials: SeedCredential[] = [];
    for (const [merchantId, scopes] of [
      [MERCHANT_A, ['payments:read', 'payments:write']],
      [MERCHANT_A, ['payments:read']],
      [MERCHANT_B, ['payments:read', 'payments:write']],
    ] as const) {
      const generated = generateCredential(peppers);
      const credentialId = newId('mcr');
      await issueCredential(client, {
        id: credentialId,
        merchantId,
        keyPrefix: generated.keyPrefix,
        digest: generated.digest,
        digestVersion: generated.digestVersion,
        scopes: [...scopes],
        expiresAt: null,
      });
      credentials.push({ merchantId, credentialId, scopes: [...scopes], raw: generated.raw });
    }

    await client.query('COMMIT');

    for (const credential of credentials) {
      out(
        `${credential.merchantId}  ${credential.credentialId}  ${credential.scopes.join(',')}  ${credential.raw}`,
      );
    }
    out('credentials are synthetic and shown once');
    return { exitCode: EXIT_OK, credentials };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** `API_CREDENTIAL_PEPPERS` is required here and nowhere else in the CLI. */
function readPeppers(env: NodeJS.ProcessEnv): { peppers: Peppers; currentVersion: number } {
  const spec = env.API_CREDENTIAL_PEPPERS;
  if (spec === undefined || spec.trim().length === 0) {
    throw new CliConfigError('API_CREDENTIAL_PEPPERS', 'is required');
  }
  return parsePeppers(spec);
}

async function insertIdentity(client: pg.ClientBase): Promise<void> {
  await client.query(
    `INSERT INTO identity.merchants (id, display_name, status, default_currency)
     VALUES ($1, 'Dev Merchant A', 'ACTIVE', 'USD'), ($2, 'Dev Merchant B', 'ACTIVE', 'USD')`,
    [MERCHANT_A, MERCHANT_B],
  );
}

async function insertProviders(client: pg.ClientBase): Promise<void> {
  for (const account of ACCOUNTS) {
    await client.query(
      `INSERT INTO providers.provider_accounts
         (id, merchant_id, provider_code, external_account_reference, environment, status)
       VALUES ($1, $2, $3, $4, 'SIMULATOR', 'ACTIVE')`,
      [account.id, account.merchantId, account.providerCode, account.externalReference],
    );

    await client.query(
      `INSERT INTO providers.provider_account_versions
         (provider_account_id, version, configuration, capabilities_hash)
       VALUES ($1, 1, '{}'::jsonb, sha256(convert_to($2, 'UTF8')))`,
      [account.id, account.providerCode],
    );

    await client.query(
      `INSERT INTO providers.provider_account_credentials
         (id, merchant_id, provider_account_id, version, secret_reference, status)
       VALUES ($1, $2, $3, 1, $4, 'ACTIVE')`,
      [
        account.credentialId,
        account.merchantId,
        account.id,
        `local-secret://${account.providerCode}/${account.merchantId}/v1`,
      ],
    );

    await client.query(
      `INSERT INTO providers.merchant_routes
         (merchant_id, provider_code, environment, provider_account_id, is_default, status)
       VALUES ($1, $2, 'SIMULATOR', $3, $4, 'ACTIVE')`,
      [
        account.merchantId,
        account.providerCode,
        account.id,
        account.providerCode === 'fake-provider',
      ],
    );
  }

  for (const endpoint of ENDPOINTS) {
    await client.query(
      `INSERT INTO providers.webhook_endpoints
         (id, provider_code, endpoint_key, external_account_reference, status)
       VALUES ($1, $2, $3, $2, 'ACTIVE')`,
      [endpoint.id, endpoint.providerCode, endpoint.key],
    );

    await client.query(
      `INSERT INTO providers.webhook_endpoint_secret_versions
         (webhook_endpoint_id, version, signing_secret_reference, verifier_version, status, accepted_from)
       VALUES ($1, 1, $2, 'v1', 'ACTIVE', clock_timestamp())`,
      [endpoint.id, `local-secret://webhook/${endpoint.providerCode}/v1`],
    );

    // Both merchants' accounts of this provider may reach the shared endpoint.
    for (const account of ACCOUNTS.filter(
      (candidate) => candidate.providerCode === endpoint.providerCode,
    )) {
      await client.query(
        `INSERT INTO providers.webhook_endpoint_accounts (webhook_endpoint_id, provider_account_id)
         VALUES ($1, $2)`,
        [endpoint.id, account.id],
      );
    }
  }
}

async function insertFeePolicies(client: pg.ClientBase): Promise<void> {
  await client.query(
    `INSERT INTO payments.fee_policies
       (id, merchant_id, version, basis_points, fixed_amount_minor, minimum_capture_amount_minor)
     VALUES
       ('fee_0000000000000000000000DEVA', $1, 1, 290, 30, 50),
       ('fee_0000000000000000000000DEVB', $2, 1, 150, 0, 1)`,
    [MERCHANT_A, MERCHANT_B],
  );
}
