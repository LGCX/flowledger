/**
 * Provider configuration: accounts, versions, credentials, webhook endpoints, routes.
 *
 * `select_route` is tested as `payments_function_owner` through `withRole`, not as the table owner:
 * the function is SECURITY INVOKER and reads RLS-protected tables, so testing it as the owner would
 * pass even if the policy or the grant were missing.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { DomainError, withTransaction } from '@flowledger/database';
import { LOGIN_RUNTIME_ROLES } from '@flowledger/database';
import {
  assertConstraintCoverage,
  disposeTestDatabase,
  setTestConnection,
  useTestDatabase,
  withRole,
  type TestDatabase,
} from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_BYTES = '01ARZ3NDEKTSV4RRFFQ69G5FA';

let database: TestDatabase;
let sequence = 0;

function nextId(prefix: 'mer' | 'pacc' | 'pac' | 'pwe'): string {
  sequence += 1;
  const suffix = `${CROCKFORD[sequence % 32] ?? '0'}${CROCKFORD[Math.floor(sequence / 32) % 32] ?? '0'}`;
  return `${prefix}_${ULID_BYTES.slice(0, 24)}${suffix}`;
}

function nextEndpointKey(): string {
  sequence += 1;
  let remaining = sequence;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out = `${CROCKFORD[remaining % 32] ?? '0'}${out}`;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

const MERCHANT = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAA';
const OTHER_MERCHANT = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAB';

async function runMapped(
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ ok: true } | { error: unknown }> {
  try {
    await withTransaction(database.ownerPool, {}, async (client) => {
      await client.query(sql, [...values]);
    });
    return { ok: true };
  } catch (error) {
    return { error };
  }
}

async function insertAccount(over: Record<string, unknown> = {}): Promise<string> {
  const id = (over.id as string | undefined) ?? nextId('pacc');
  // `provider_accounts_external_identity_key` is UNIQUE NULLS NOT DISTINCT, so two accounts for the
  // same merchant, provider, and environment must differ in their external reference — including when
  // that reference is NULL. A distinct synthetic value keeps fixtures independent; tests that care
  // about the NULL case pass it explicitly.
  const row = {
    id,
    merchant_id: MERCHANT,
    provider_code: 'fake-provider',
    external_account_reference: `acct_synthetic_${String(id).slice(-6)}`,
    environment: 'SIMULATOR',
    status: 'ACTIVE',
    ...over,
  };
  await database.ownerPool.query(
    `INSERT INTO providers.provider_accounts
       (id, merchant_id, provider_code, external_account_reference, environment, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.id,
      row.merchant_id,
      row.provider_code,
      row.external_account_reference,
      row.environment,
      row.status,
    ],
  );
  return id;
}

async function insertVersion(
  accountId: string,
  version: number,
  over: Record<string, unknown> = {},
): Promise<void> {
  await database.ownerPool.query(
    `INSERT INTO providers.provider_account_versions
       (provider_account_id, version, configuration, capabilities_hash, superseded_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [
      accountId,
      version,
      (over.configuration as string | undefined) ?? '{"mode":"fake"}',
      (over.capabilities_hash as Buffer | undefined) ?? Buffer.alloc(32, 1),
      (over.superseded_at as Date | null | undefined) ?? null,
    ],
  );
}

async function insertRoute(over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    merchant_id: MERCHANT,
    provider_code: 'fake-provider',
    environment: 'SIMULATOR',
    provider_account_id: over.provider_account_id,
    is_default: over.is_default ?? true,
    status: 'ACTIVE',
    ...over,
  };
  await database.ownerPool.query(
    `INSERT INTO providers.merchant_routes
       (merchant_id, provider_code, environment, provider_account_id, is_default, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.merchant_id,
      row.provider_code,
      row.environment,
      row.provider_account_id,
      row.is_default,
      row.status,
    ],
  );
}

beforeAll(async () => {
  database = await useTestDatabase()();
  for (const [id, name] of [
    [MERCHANT, 'Provider merchant'],
    [OTHER_MERCHANT, 'Other merchant'],
  ] as const) {
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency)
       VALUES ($1, $2, 'ACTIVE', 'USD')`,
      [id, name],
    );
  }
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

async function routesFor(
  merchantId: string,
  environment: string,
  providerCode: string | null,
): Promise<
  { provider_account_id: string; provider_code: string; provider_account_version: number }[]
> {
  return withRole(database.ownerPool, 'payments_function_owner', async (client) => {
    const result = await client.query<{
      provider_account_id: string;
      provider_code: string;
      provider_account_version: number;
    }>('SELECT * FROM providers.select_route($1, $2, $3)', [merchantId, environment, providerCode]);
    return result.rows;
  });
}

async function routeError(
  merchantId: string,
  environment: string,
  providerCode: string | null,
): Promise<unknown> {
  return withRole(database.ownerPool, 'payments_function_owner', async (client) => {
    const result = await client.query('SELECT * FROM providers.select_route($1, $2, $3)', [
      merchantId,
      environment,
      providerCode,
    ]);
    return result.rows;
  }).catch((caught: unknown) => caught);
}

describe('constraint coverage', () => {
  it('declares every constraint and index on all seven provider tables', async () => {
    await assertConstraintCoverage(database.ownerPool, 'providers.provider_accounts', [
      'provider_accounts_pkey',
      'provider_accounts_id_format',
      'provider_accounts_provider_code_format',
      'provider_accounts_environment',
      'provider_accounts_status',
      'provider_accounts_merchant_id_id_key',
      'provider_accounts_route_target_key',
      'provider_accounts_external_identity_key',
      'provider_accounts_merchant_fkey',
    ]);

    await assertConstraintCoverage(database.ownerPool, 'providers.merchant_routes', [
      'merchant_routes_pkey',
      'merchant_routes_status',
      'merchant_routes_account_key',
      'merchant_routes_account_fkey',
      'merchant_routes_one_default',
    ]);

    await assertConstraintCoverage(database.ownerPool, 'providers.provider_account_versions', [
      'provider_account_versions_pkey',
      'provider_account_versions_version_positive',
      'provider_account_versions_configuration_object',
      'provider_account_versions_capabilities_hash',
      'provider_account_versions_account_fkey',
      'provider_account_versions_one_current',
    ]);

    await assertConstraintCoverage(database.ownerPool, 'providers.provider_account_credentials', [
      'provider_account_credentials_pkey',
      'provider_account_credentials_id_format',
      'provider_account_credentials_version_positive',
      'provider_account_credentials_secret_reference_nonempty',
      'provider_account_credentials_status',
      'provider_account_credentials_retired_at',
      'provider_account_credentials_account_version_key',
      'provider_account_credentials_account_fkey',
      'provider_account_credentials_one_active',
    ]);

    await assertConstraintCoverage(database.ownerPool, 'providers.webhook_endpoints', [
      'webhook_endpoints_pkey',
      'webhook_endpoints_id_format',
      'webhook_endpoints_endpoint_key_format',
      'webhook_endpoints_provider_code_format',
      'webhook_endpoints_status',
      'webhook_endpoints_retired_at',
      'webhook_endpoints_endpoint_key',
    ]);

    await assertConstraintCoverage(
      database.ownerPool,
      'providers.webhook_endpoint_secret_versions',
      [
        'webhook_endpoint_secret_versions_pkey',
        'webhook_endpoint_secret_versions_version_positive',
        'webhook_endpoint_secret_versions_status',
        'webhook_endpoint_secret_versions_window',
        'webhook_endpoint_secret_versions_bounded',
        'webhook_endpoint_secret_versions_endpoint_fkey',
        'webhook_endpoint_secret_versions_one_active',
      ],
    );

    await assertConstraintCoverage(database.ownerPool, 'providers.webhook_endpoint_accounts', [
      'webhook_endpoint_accounts_pkey',
      'webhook_endpoint_accounts_endpoint_fkey',
      'webhook_endpoint_accounts_account_fkey',
    ]);
  });
});

describe('provider account constraints', () => {
  it.each([
    ['provider_accounts_id_format', { id: 'xxx_01ARZ3NDEKTSV4RRFFQ69G5FAA' }],
    ['provider_accounts_provider_code_format', { provider_code: 'Fake_Provider' }],
    ['provider_accounts_environment', { environment: 'PRODUCTION' }],
    ['provider_accounts_status', { status: 'DELETED' }],
  ])('rejects %s via %o', async (constraint, over) => {
    const error = await insertAccount(over).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('rejects a duplicate external identity for the same merchant and provider', async () => {
    await insertAccount({ external_account_reference: 'acct_shared' });
    const error = await insertAccount({ external_account_reference: 'acct_shared' }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { constraint?: string }).constraint).toBe(
      'provider_accounts_external_identity_key',
    );
  });
});

describe('route constraints', () => {
  it('rejects a route that names another merchant’s account', async () => {
    const otherAccount = await insertAccount({ merchant_id: OTHER_MERCHANT });
    const error = await insertRoute({ provider_account_id: otherAccount }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { constraint?: string }).constraint).toBe('merchant_routes_account_fkey');
  });

  it('rejects a route whose provider code disagrees with the account', async () => {
    const account = await insertAccount();
    const error = await insertRoute({
      provider_account_id: account,
      provider_code: 'other-provider',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('merchant_routes_account_fkey');
  });

  it('rejects a route whose environment disagrees with the account', async () => {
    const account = await insertAccount({ environment: 'SANDBOX' });
    const error = await insertRoute({
      provider_account_id: account,
      environment: 'SIMULATOR',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('merchant_routes_account_fkey');
  });

  it('rejects a second active default route', async () => {
    const first = await insertAccount();
    const second = await insertAccount();
    await insertRoute({ provider_account_id: first, provider_code: 'fake-provider' });

    const error = await insertRoute({
      provider_account_id: second,
      provider_code: 'unreliable-provider',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('merchant_routes_one_default');
  });

  it('allows a disabled default alongside an active one', async () => {
    const first = await insertAccount({
      merchant_id: OTHER_MERCHANT,
      provider_code: 'fake-provider',
    });
    const second = await insertAccount({
      merchant_id: OTHER_MERCHANT,
      provider_code: 'unreliable-provider',
    });
    await insertRoute({
      merchant_id: OTHER_MERCHANT,
      provider_account_id: first,
      provider_code: 'fake-provider',
      status: 'DISABLED',
    });
    await expect(
      insertRoute({
        merchant_id: OTHER_MERCHANT,
        provider_account_id: second,
        provider_code: 'unreliable-provider',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('version and credential constraints', () => {
  it('rejects a second current configuration version', async () => {
    const account = await insertAccount();
    await insertVersion(account, 1);
    // Version 2 satisfies the monotonic check (max + 1) and is then refused by the partial unique
    // index, which is the constraint that actually says "at most one current version".
    const error = await insertVersion(account, 2).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'provider_account_versions_one_current',
    );
  });

  it('accepts the next version once the previous one is superseded', async () => {
    const account = await insertAccount();
    await insertVersion(account, 1);
    await database.ownerPool.query(
      `UPDATE providers.provider_account_versions SET superseded_at = clock_timestamp()
        WHERE provider_account_id = $1 AND version = 1`,
      [account],
    );
    await expect(insertVersion(account, 2)).resolves.toBeUndefined();
  });

  it('rejects a second active credential', async () => {
    const account = await insertAccount();
    await database.ownerPool.query(
      `INSERT INTO providers.provider_account_credentials
         (id, merchant_id, provider_account_id, version, secret_reference, status)
       VALUES ($1, $2, $3, 1, 'projects/p/secrets/s/versions/1', 'ACTIVE')`,
      [nextId('pac'), MERCHANT, account],
    );
    const error = await database.ownerPool
      .query(
        `INSERT INTO providers.provider_account_credentials
           (id, merchant_id, provider_account_id, version, secret_reference, status)
         VALUES ($1, $2, $3, 2, 'projects/p/secrets/s/versions/2', 'ACTIVE')`,
        [nextId('pac'), MERCHANT, account],
      )
      .catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'provider_account_credentials_one_active',
    );
  });

  it('rejects a credential whose merchant does not own the account', async () => {
    const account = await insertAccount();
    const error = await database.ownerPool
      .query(
        `INSERT INTO providers.provider_account_credentials
           (id, merchant_id, provider_account_id, version, secret_reference, status)
         VALUES ($1, $2, $3, 1, 'projects/p/secrets/s/versions/1', 'ACTIVE')`,
        [nextId('pac'), OTHER_MERCHANT, account],
      )
      .catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'provider_account_credentials_account_fkey',
    );
  });

  it('rejects a version insert that skips a number', async () => {
    const account = await insertAccount();
    await insertVersion(account, 1);
    const result = await runMapped(
      `INSERT INTO providers.provider_account_versions
         (provider_account_id, version, configuration, capabilities_hash)
       VALUES ($1, 3, '{}'::jsonb, $2)`,
      [account, Buffer.alloc(32, 1)],
    );
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.detail).toMatchObject({ reason: 'VERSION_NOT_MONOTONIC', expected: 2 });
  });
});

describe('webhook endpoint constraints', () => {
  async function insertEndpoint(over: Record<string, unknown> = {}): Promise<string> {
    const id = (over.id as string | undefined) ?? nextId('pwe');
    await database.ownerPool.query(
      `INSERT INTO providers.webhook_endpoints
         (id, provider_code, endpoint_key, external_account_reference, status, retired_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        (over.provider_code as string | undefined) ?? 'fake-provider',
        (over.endpoint_key as string | undefined) ?? nextEndpointKey(),
        (over.external_account_reference as string | null | undefined) ?? null,
        (over.status as string | undefined) ?? 'ACTIVE',
        (over.retired_at as Date | null | undefined) ?? null,
      ],
    );
    return id;
  }

  it.each([
    ['webhook_endpoints_endpoint_key_format', { endpoint_key: 'short' }],
    ['webhook_endpoints_endpoint_key_format', { endpoint_key: '01arz3ndektsv4rrffq69g5fav' }],
    ['webhook_endpoints_provider_code_format', { provider_code: 'Fake' }],
    ['webhook_endpoints_status', { status: 'DISABLED' }],
    ['webhook_endpoints_retired_at', { status: 'REVOKED', retired_at: null }],
    ['webhook_endpoints_retired_at', { status: 'ACTIVE', retired_at: new Date() }],
  ])('rejects %s via %o', async (constraint, over) => {
    const error = await insertEndpoint(over).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('rejects a duplicate endpoint key for the same provider', async () => {
    const key = nextEndpointKey();
    await insertEndpoint({ endpoint_key: key });
    const error = await insertEndpoint({ endpoint_key: key }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('webhook_endpoints_endpoint_key');
  });

  it('rejects a second active secret version', async () => {
    const endpointId = await insertEndpoint();
    const insert = (version: number, status: string): Promise<unknown> =>
      database.ownerPool
        .query(
          `INSERT INTO providers.webhook_endpoint_secret_versions
             (webhook_endpoint_id, version, signing_secret_reference, verifier_version, status, accepted_until)
           VALUES ($1, $2, $3, 'v1', $4, $5)`,
          [
            endpointId,
            version,
            `projects/p/secrets/s/versions/${String(version)}`,
            status,
            status === 'ACTIVE' ? null : new Date(Date.now() + 60_000),
          ],
        )
        .catch((caught: unknown) => caught);

    await insert(1, 'ACTIVE');
    const error = await insert(2, 'ACTIVE');
    expect((error as { constraint?: string }).constraint).toBe(
      'webhook_endpoint_secret_versions_one_active',
    );
  });

  it('rejects a secret version that is not ACTIVE without accepted_until', async () => {
    const endpointId = await insertEndpoint();
    const error = await database.ownerPool
      .query(
        `INSERT INTO providers.webhook_endpoint_secret_versions
           (webhook_endpoint_id, version, signing_secret_reference, verifier_version, status)
         VALUES ($1, 1, 'projects/p/secrets/s/versions/1', 'v1', 'OVERLAP')`,
        [endpointId],
      )
      .catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'webhook_endpoint_secret_versions_bounded',
    );
  });
});

describe('guards', () => {
  it('rejects changing an account provider code, environment, or external reference', async () => {
    const account = await insertAccount({ external_account_reference: 'acct_1' });
    for (const [column, value] of [
      ['provider_code', 'other-provider'],
      ['environment', 'SANDBOX'],
      ['external_account_reference', 'acct_2'],
    ] as const) {
      const result = await runMapped(
        `UPDATE providers.provider_accounts SET ${column} = $1 WHERE id = $2`,
        [value, account],
      );
      const error = (result as { error?: DomainError }).error as DomainError;
      expect(error.code, column).toBe('IMMUTABLE_FIELD');
      expect(error.detail).toMatchObject({ column });
    }
  });

  it('rejects editing a configuration version', async () => {
    const account = await insertAccount();
    await insertVersion(account, 1);
    const result = await runMapped(
      `UPDATE providers.provider_account_versions SET configuration = '{"changed":true}'::jsonb
        WHERE provider_account_id = $1 AND version = 1`,
      [account],
    );
    expect(((result as { error?: DomainError }).error as DomainError).detail).toMatchObject({
      column: 'configuration',
    });
  });

  it('supersedes a version exactly once', async () => {
    const account = await insertAccount();
    await insertVersion(account, 1);

    const superseded = await runMapped(
      `UPDATE providers.provider_account_versions SET superseded_at = clock_timestamp()
        WHERE provider_account_id = $1 AND version = 1`,
      [account],
    );
    expect(superseded).toEqual({ ok: true });

    const again = await runMapped(
      `UPDATE providers.provider_account_versions SET superseded_at = clock_timestamp()
        WHERE provider_account_id = $1 AND version = 1`,
      [account],
    );
    expect(((again as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_FIELD');
  });

  it('refuses to clear superseded_at', async () => {
    const account = await insertAccount();
    await insertVersion(account, 1, { superseded_at: new Date() });
    const result = await runMapped(
      `UPDATE providers.provider_account_versions SET superseded_at = NULL
        WHERE provider_account_id = $1 AND version = 1`,
      [account],
    );
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(['IMMUTABLE_FIELD', 'INVALID_TRANSITION']).toContain(error.code);
  });

  it('allows a credential to retire and then revoke, but never to reactivate', async () => {
    const account = await insertAccount();
    const credentialId = nextId('pac');
    await database.ownerPool.query(
      `INSERT INTO providers.provider_account_credentials
         (id, merchant_id, provider_account_id, version, secret_reference, status)
       VALUES ($1, $2, $3, 1, 'projects/p/secrets/s/versions/1', 'ACTIVE')`,
      [credentialId, MERCHANT, account],
    );

    const retired = await runMapped(
      `UPDATE providers.provider_account_credentials SET status = 'RETIRED', retired_at = clock_timestamp()
        WHERE id = $1`,
      [credentialId],
    );
    expect(retired).toEqual({ ok: true });

    const revoked = await runMapped(
      `UPDATE providers.provider_account_credentials SET status = 'REVOKED'
        WHERE id = $1`,
      [credentialId],
    );
    expect(revoked).toEqual({ ok: true });

    const reactivate = await runMapped(
      `UPDATE providers.provider_account_credentials SET status = 'ACTIVE', retired_at = NULL
        WHERE id = $1`,
      [credentialId],
    );
    expect(((reactivate as { error?: DomainError }).error as DomainError).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('requires retired_at when a credential leaves ACTIVE', async () => {
    const account = await insertAccount();
    const credentialId = nextId('pac');
    await database.ownerPool.query(
      `INSERT INTO providers.provider_account_credentials
         (id, merchant_id, provider_account_id, version, secret_reference, status)
       VALUES ($1, $2, $3, 1, 'projects/p/secrets/s/versions/1', 'ACTIVE')`,
      [credentialId, MERCHANT, account],
    );

    const result = await runMapped(
      `UPDATE providers.provider_account_credentials SET status = 'RETIRED' WHERE id = $1`,
      [credentialId],
    );
    // The lifecycle guard runs before the CHECK constraint, so it is the one that refuses this — with
    // a reason that names the missing column rather than a generic constraint violation.
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.detail).toEqual({ reason: 'CREDENTIAL_RETIRED_AT_REQUIRED' });
  });

  it('refuses to move a secret version back to ACTIVE', async () => {
    const endpointId = nextId('pwe');
    await database.ownerPool.query(
      `INSERT INTO providers.webhook_endpoints (id, provider_code, endpoint_key)
       VALUES ($1, 'fake-provider', $2)`,
      [endpointId, nextEndpointKey()],
    );
    await database.ownerPool.query(
      `INSERT INTO providers.webhook_endpoint_secret_versions
         (webhook_endpoint_id, version, signing_secret_reference, verifier_version, status)
       VALUES ($1, 1, 'projects/p/secrets/s/versions/1', 'v1', 'ACTIVE')`,
      [endpointId],
    );
    await database.ownerPool.query(
      `UPDATE providers.webhook_endpoint_secret_versions
          SET status = 'OVERLAP', accepted_until = clock_timestamp() + interval '1 hour'
        WHERE webhook_endpoint_id = $1 AND version = 1`,
      [endpointId],
    );

    const result = await runMapped(
      `UPDATE providers.webhook_endpoint_secret_versions SET status = 'ACTIVE', accepted_until = NULL
        WHERE webhook_endpoint_id = $1 AND version = 1`,
      [endpointId],
    );
    expect(((result as { error?: DomainError }).error as DomainError).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('refuses to delete or truncate any provider table', async () => {
    const account = await insertAccount();
    const deleted = await runMapped('DELETE FROM providers.provider_accounts WHERE id = $1', [
      account,
    ]);
    expect(((deleted as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');

    const truncated = await runMapped('TRUNCATE providers.merchant_routes');
    expect(((truncated as { error?: DomainError }).error as DomainError).code).toBe(
      'IMMUTABLE_ROW',
    );
  });
});

describe('select_route', () => {
  async function fixture(
    options: {
      merchantId?: string;
      providerCode?: string;
      routeStatus?: string;
      accountStatus?: string;
      versions?: number[];
    } = {},
  ): Promise<{ accountId: string }> {
    const merchantId = options.merchantId ?? MERCHANT;
    const accountId = await insertAccount({
      merchant_id: merchantId,
      provider_code: options.providerCode ?? 'fake-provider',
      status: options.accountStatus ?? 'ACTIVE',
    });
    const versions = options.versions ?? [1];
    for (const version of versions) await insertVersion(accountId, version);
    await insertRoute({
      merchant_id: merchantId,
      provider_code: options.providerCode ?? 'fake-provider',
      provider_account_id: accountId,
      status: options.routeStatus ?? 'ACTIVE',
    });
    return { accountId };
  }

  it('resolves the default route and its current version', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAC';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    const { accountId } = await fixture({ merchantId });

    expect(await routesFor(merchantId, 'SIMULATOR', null)).toEqual([
      {
        provider_account_id: accountId,
        provider_code: 'fake-provider',
        provider_account_version: 1,
      },
    ]);
  });

  it('resolves an explicit provider code', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAD';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    const { accountId } = await fixture({ merchantId });

    const rows = await routesFor(merchantId, 'SIMULATOR', 'fake-provider');
    expect(rows[0]?.provider_account_id).toBe(accountId);
  });

  // Each case owns its merchant: reusing one id makes the second fixture collide with the first.
  it('raises when the merchant has no route at all', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAE';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );

    const error = await routeError(merchantId, 'SIMULATOR', null);
    expect((error as DomainError).code).toBe('PROVIDER_ROUTE_UNAVAILABLE');
  });

  it('raises ROUTE_DISABLED for an explicit code naming a disabled route', async () => {
    // A disabled default is simply not selectable by default, so it surfaces as NO_ROUTE. The disabled
    // route is only distinguishable through an explicit provider code, which is why this case exists.
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAF';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    await fixture({ merchantId, routeStatus: 'DISABLED' });

    const error = (await routeError(merchantId, 'SIMULATOR', 'fake-provider')) as DomainError;
    expect(error.code).toBe('PROVIDER_ROUTE_UNAVAILABLE');
    expect(error.detail).toMatchObject({ reason: 'ROUTE_DISABLED' });
  });

  it('raises ACCOUNT_NOT_ACTIVE for a disabled account', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAP';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    await fixture({ merchantId, accountStatus: 'DISABLED' });

    const error = (await routeError(merchantId, 'SIMULATOR', null)) as DomainError;
    expect(error.code).toBe('PROVIDER_ROUTE_UNAVAILABLE');
    expect(error.detail).toMatchObject({ reason: 'ACCOUNT_NOT_ACTIVE' });
  });

  it('raises NO_ROUTE when the only route is a disabled default', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAQ';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    await fixture({ merchantId, routeStatus: 'DISABLED' });

    const error = (await routeError(merchantId, 'SIMULATOR', null)) as DomainError;
    expect(error.detail).toMatchObject({ reason: 'NO_ROUTE' });
  });

  it('raises when an explicit code has no route', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAG';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    await fixture({ merchantId });

    const error = await routeError(merchantId, 'SIMULATOR', 'unreliable-provider');
    expect((error as DomainError).code).toBe('PROVIDER_ROUTE_UNAVAILABLE');
  });

  it('raises when the account has no current version', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAH';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    const accountId = await insertAccount({ merchant_id: merchantId });
    await insertVersion(accountId, 1, { superseded_at: new Date() });
    await insertRoute({ merchant_id: merchantId, provider_account_id: accountId });

    const error = await routeError(merchantId, 'SIMULATOR', null);
    expect((error as DomainError).code).toBe('PROVIDER_ROUTE_UNAVAILABLE');
  });

  it('keeps two merchants with the same provider code apart', async () => {
    const first = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAJ';
    const second = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAK';
    for (const id of [first, second]) {
      await database.ownerPool.query(
        `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
        [id],
      );
    }
    const a = await fixture({ merchantId: first });
    const b = await fixture({ merchantId: second });

    expect((await routesFor(first, 'SIMULATOR', null))[0]?.provider_account_id).toBe(a.accountId);
    expect((await routesFor(second, 'SIMULATOR', null))[0]?.provider_account_id).toBe(b.accountId);
  });
});

describe('rollover race', () => {
  it('blocks a supersede while a route is being read, and the reader keeps the version it saw', async () => {
    const merchantId = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAM';
    await database.ownerPool.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency) VALUES ($1, 'R', 'ACTIVE', 'USD')`,
      [merchantId],
    );
    const accountId = await insertAccount({ merchant_id: merchantId });
    await insertVersion(accountId, 1);
    await insertRoute({ merchant_id: merchantId, provider_account_id: accountId });

    const reader = await database.ownerPool.connect();
    const writer = await database.ownerPool.connect();

    try {
      await reader.query('BEGIN');
      await reader.query('SET LOCAL ROLE payments_function_owner');
      const seen = await reader.query<{ provider_account_version: number }>(
        'SELECT * FROM providers.select_route($1, $2, NULL)',
        [merchantId, 'SIMULATOR'],
      );
      expect(seen.rows[0]?.provider_account_version).toBe(1);

      // The writer supersedes version 1. It must wait for the reader's FOR SHARE lock.
      await writer.query('BEGIN');
      const supersede = writer.query(
        `UPDATE providers.provider_account_versions SET superseded_at = clock_timestamp()
          WHERE provider_account_id = $1 AND version = 1`,
        [accountId],
      );

      // Poll the catalogue until the writer is actually waiting on a lock.
      let waited = false;
      for (let attempt = 0; attempt < 100 && !waited; attempt += 1) {
        const state = await database.ownerPool.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type FROM pg_stat_activity WHERE pid = pg_backend_pid() OR wait_event_type = 'Lock'`,
        );
        waited = state.rows.some((row) => row.wait_event_type === 'Lock');
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waited, 'the supersede should block on the FOR SHARE lock').toBe(true);

      await reader.query('COMMIT');
      await supersede;
      await writer.query('COMMIT');
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await writer.query('ROLLBACK').catch(() => undefined);
      reader.release();
      writer.release();
    }
  });
});

describe('privileges', () => {
  it('denies every runtime role SELECT on every provider table', async () => {
    const tables = [
      'provider_accounts',
      'merchant_routes',
      'provider_account_versions',
      'provider_account_credentials',
      'webhook_endpoints',
      'webhook_endpoint_secret_versions',
      'webhook_endpoint_accounts',
    ];

    for (const role of LOGIN_RUNTIME_ROLES) {
      const pool = database.poolAs(role);
      const client = await pool.connect();
      try {
        for (const table of tables) {
          const error = await client
            .query(`SELECT 1 FROM providers.${table} LIMIT 1`)
            .catch((caught: unknown) => caught);
          expect((error as { code?: string }).code, `${role} on ${table}`).toBe('42501');
        }
      } finally {
        client.release();
      }
    }
  });

  it('denies fl_api EXECUTE on select_route', async () => {
    const client = await database.poolAs('fl_api').connect();
    try {
      const error = await client
        .query("SELECT * FROM providers.select_route($1, 'SIMULATOR', NULL)", [MERCHANT])
        .catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe('42501');
    } finally {
      client.release();
    }
  });
});
