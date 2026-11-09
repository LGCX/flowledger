/**
 * Identity tables, guards, RLS, and the credential repository.
 *
 * Two kinds of test here. Constraint and trigger negatives are run as `fl_migration_owner` — the table
 * owner, which is RLS-exempt — so a failure is attributable to the constraint or guard rather than to a
 * missing policy. RLS and privilege tests are run as the real runtime roles, because a policy that is
 * only ever exercised by the owner proves nothing.
 *
 * Each negative asserts `constraint` by name. Asserting only that *something* failed would pass while
 * the wrong rule fired, which is how a missing constraint goes unnoticed for months.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import {
  DomainError,
  issueCredential,
  lookupCredential,
  revokeCredential,
  withTransaction,
  type StoredCredentialDigest,
} from '@flowledger/database';
import {
  assertConstraintCoverage,
  disposeTestDatabase,
  setTestConnection,
  useTestDatabase,
  type TestDatabase,
} from '@flowledger/testkit';

/** Accepts any stored digest: these cases are about lookup filtering, not the HMAC. */
const ACCEPT = (stored: StoredCredentialDigest | null): boolean => stored !== null;

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
let sequence = 0;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const MERCHANT_A = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAA';
const MERCHANT_B = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAB';

/** A ULID is exactly 26 Crockford characters; the leading [0-7] bound is the timestamp high nibble. */
const ULID_BYTES = '01ARZ3NDEKTSV4RRFFQ69G5FA';

function nextId(prefix: 'mer' | 'mcr'): string {
  sequence += 1;
  const suffix = `${CROCKFORD[sequence % 32] ?? '0'}${CROCKFORD[Math.floor(sequence / 32) % 32] ?? '0'}`;
  return `${prefix}_${ULID_BYTES.slice(0, 24)}${suffix}`;
}

/** 12 Crockford characters encoding the counter: a bijection for any realistic sequence value. */
function nextPrefix(): string {
  sequence += 1;
  let remaining = sequence;
  let out = '';
  for (let index = 0; index < 12; index += 1) {
    out = `${CROCKFORD[remaining % 32] ?? '0'}${out}`;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

async function insertMerchant(over: Record<string, unknown> = {}): Promise<string> {
  const id = (over.id as string | undefined) ?? nextId('mer');
  const row = {
    id,
    display_name: 'Test Merchant',
    status: 'ACTIVE',
    default_currency: 'USD',
    closed_at: null,
    ...over,
  };
  await database.ownerPool.query(
    `INSERT INTO identity.merchants (id, display_name, status, default_currency, closed_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.id, row.display_name, row.status, row.default_currency, row.closed_at],
  );
  return id;
}

async function insertCredential(over: Record<string, unknown> = {}): Promise<{
  id: string;
  keyPrefix: string;
}> {
  const id = (over.id as string | undefined) ?? nextId('mcr');
  const keyPrefix = (over.key_prefix as string | undefined) ?? nextPrefix();
  const row = {
    id,
    merchant_id: MERCHANT_A,
    key_prefix: keyPrefix,
    credential_digest: Buffer.alloc(32, 1),
    digest_version: 1,
    scopes: ['payments:read'],
    status: 'ACTIVE',
    expires_at: null,
    revoked_at: null,
    ...over,
  };
  await database.ownerPool.query(
    `INSERT INTO identity.merchant_api_credentials
       (id, merchant_id, key_prefix, credential_digest, digest_version, scopes, status, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)`,
    [
      row.id,
      row.merchant_id,
      row.key_prefix,
      row.credential_digest,
      row.digest_version,
      row.scopes,
      row.status,
      row.expires_at,
      row.revoked_at,
    ],
  );
  return { id, keyPrefix };
}

/** Runs a statement through `withTransaction` so a raised P0001 maps to DomainError. */
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

beforeAll(async () => {
  database = await useTestDatabase()();
  await insertMerchant({ id: MERCHANT_A, display_name: 'Merchant A' });
  await insertMerchant({ id: MERCHANT_B, display_name: 'Merchant B' });
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

describe('constraint coverage', () => {
  it('declares every constraint and index on the identity tables', async () => {
    await assertConstraintCoverage(database.ownerPool, 'identity.merchants', [
      'merchants_pkey',
      'merchants_id_format',
      'merchants_display_name_length',
      'merchants_status',
      'merchants_default_currency',
      'merchants_closed_at',
    ]);

    await assertConstraintCoverage(database.ownerPool, 'identity.merchant_api_credentials', [
      'merchant_api_credentials_pkey',
      'merchant_api_credentials_id_format',
      'merchant_api_credentials_key_prefix_format',
      'merchant_api_credentials_digest_length',
      'merchant_api_credentials_digest_version',
      'merchant_api_credentials_scopes_nonempty',
      'merchant_api_credentials_scopes_allowlisted',
      'merchant_api_credentials_status',
      'merchant_api_credentials_revoked_at',
      'merchant_api_credentials_key_prefix_key',
      'merchant_api_credentials_merchant_id_id_key',
      'merchant_api_credentials_merchant_fkey',
    ]);
  });
});

describe('merchant constraints', () => {
  it.each([
    ['merchants_id_format', { id: 'xxx_01ARZ3NDEKTSV4RRFFQ69G5FAA' }],
    ['merchants_id_format', { id: 'mer_81ARZ3NDEKTSV4RRFFQ69G5FAV' }],
    ['merchants_display_name_length', { display_name: '' }],
    ['merchants_display_name_length', { display_name: 'x'.repeat(201) }],
    ['merchants_status', { status: 'DELETED' }],
    ['merchants_default_currency', { default_currency: 'EUR' }],
    ['merchants_closed_at', { status: 'CLOSED', closed_at: null }],
    ['merchants_closed_at', { status: 'ACTIVE', closed_at: new Date() }],
  ])('rejects %s via %o', async (constraint, over) => {
    const error = await insertMerchant(over).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('accepts a 200-character display name and a closed merchant with closed_at', async () => {
    await expect(insertMerchant({ display_name: 'x'.repeat(200) })).resolves.toBeTruthy();
    await expect(insertMerchant({ status: 'CLOSED', closed_at: new Date() })).resolves.toBeTruthy();
  });
});

describe('credential constraints', () => {
  it.each([
    ['merchant_api_credentials_id_format', { id: 'xxx_01ARZ3NDEKTSV4RRFFQ69G5FAA' }],
    ['merchant_api_credentials_key_prefix_format', { key_prefix: '0123456789A' }],
    ['merchant_api_credentials_key_prefix_format', { key_prefix: '0123456789ab' }],
    ['merchant_api_credentials_digest_length', { credential_digest: Buffer.alloc(31, 1) }],
    ['merchant_api_credentials_digest_length', { credential_digest: Buffer.alloc(33, 1) }],
    ['merchant_api_credentials_digest_version', { digest_version: 0 }],
    ['merchant_api_credentials_scopes_nonempty', { scopes: [] }],
    ['merchant_api_credentials_scopes_allowlisted', { scopes: ['payments:admin'] }],
  ])('rejects %s via %o', async (constraint, over) => {
    const error = await insertCredential(over).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('rejects an invalid status on update', async () => {
    const { id } = await insertCredential();
    const result = await runMapped(
      'UPDATE identity.merchant_api_credentials SET status = $1 WHERE id = $2',
      ['EXPIRED', id],
    );
    expect((result as { error?: { constraint?: string } }).error?.constraint).toBe(
      'merchant_api_credentials_status',
    );
  });

  it.each([
    ['REVOKED without revoked_at', { status: 'REVOKED' }],
    ['revoked_at while ACTIVE', { revoked_at: new Date() }],
  ])('rejects %s on update', async (_label, patch) => {
    const { id } = await insertCredential();
    const columns = Object.keys(patch);
    const result = await runMapped(
      `UPDATE identity.merchant_api_credentials SET ${columns.map((column, index) => `${column} = $${String(index + 1)}`).join(', ')} WHERE id = $${String(columns.length + 1)}`,
      [...Object.values(patch), id],
    );
    expect((result as { error?: { constraint?: string } }).error?.constraint).toBe(
      'merchant_api_credentials_revoked_at',
    );
  });

  it('rejects a duplicate key prefix', async () => {
    const first = await insertCredential();
    const error = await insertCredential({ key_prefix: first.keyPrefix }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { constraint?: string }).constraint).toBe(
      'merchant_api_credentials_key_prefix_key',
    );
  });

  it('rejects a credential for a merchant that does not exist', async () => {
    const error = await insertCredential({
      merchant_id: 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'merchant_api_credentials_merchant_fkey',
    );
  });

  it('accepts both allowlisted scopes together', async () => {
    await expect(
      insertCredential({ scopes: ['payments:read', 'payments:write'] }),
    ).resolves.toBeTruthy();
  });
});

describe('guards', () => {
  it('refuses to insert a credential that is already revoked', async () => {
    const result = await runMapped(
      `INSERT INTO identity.merchant_api_credentials
         (id, merchant_id, key_prefix, credential_digest, digest_version, scopes, status, revoked_at)
       VALUES ($1, $2, $3, $4, 1, ARRAY['payments:read'], 'REVOKED', clock_timestamp())`,
      [nextId('mcr'), MERCHANT_A, nextPrefix(), Buffer.alloc(32, 1)],
    );
    const error = (result as { error?: unknown }).error;
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('INVALID_TRANSITION');
    expect((error as DomainError).detail).toEqual({ reason: 'CREDENTIAL_NOT_ISSUED_ACTIVE' });
  });

  it.each([
    ['credential_digest', 'credential_digest = $1, ', [Buffer.alloc(32, 9)]],
    ['digest_version', 'digest_version = 2, ', []],
    ['key_prefix', 'key_prefix = $1, ', ['ZZZZZZZZZZZZ']],
    ['scopes', 'scopes = $1::text[], ', [['payments:write']]],
    ['expires_at', 'expires_at = $1, ', [new Date()]],
  ] as const)('refuses to change %s', async (column, fragment, values) => {
    const { id } = await insertCredential();
    const result = await runMapped(
      `UPDATE identity.merchant_api_credentials SET ${fragment}status = 'ACTIVE' WHERE id = $${String(values.length + 1)}`,
      [...values, id],
    );

    const error = (result as { error?: unknown }).error;
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('IMMUTABLE_FIELD');
    expect((error as DomainError).detail).toMatchObject({ column });
  });

  it('refuses to change merchant_id', async () => {
    const { id } = await insertCredential();
    const result = await runMapped(
      'UPDATE identity.merchant_api_credentials SET merchant_id = $1 WHERE id = $2',
      [MERCHANT_B, id],
    );
    expect(((result as { error?: DomainError }).error as DomainError).detail).toMatchObject({
      column: 'merchant_id',
    });
  });

  it('refuses to un-revoke a credential', async () => {
    const { id } = await insertCredential();
    await database.ownerPool.query(
      "UPDATE identity.merchant_api_credentials SET status = 'REVOKED', revoked_at = clock_timestamp() WHERE id = $1",
      [id],
    );

    const result = await runMapped(
      "UPDATE identity.merchant_api_credentials SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1",
      [id],
    );
    const error = (result as { error?: DomainError }).error as DomainError;

    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.detail).toEqual({ reason: 'CREDENTIAL_REVOCATION_ONE_WAY' });
  });

  it('refuses to move revoked_at once revoked', async () => {
    const { id } = await insertCredential();
    await database.ownerPool.query(
      "UPDATE identity.merchant_api_credentials SET status = 'REVOKED', revoked_at = clock_timestamp() WHERE id = $1",
      [id],
    );

    const result = await runMapped(
      "UPDATE identity.merchant_api_credentials SET revoked_at = revoked_at - interval '1 hour' WHERE id = $1",
      [id],
    );
    expect(((result as { error?: DomainError }).error as DomainError).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('allows last_used_at to change', async () => {
    const { id } = await insertCredential();
    await expect(
      database.ownerPool.query(
        'UPDATE identity.merchant_api_credentials SET last_used_at = clock_timestamp() WHERE id = $1',
        [id],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses to delete or truncate either table', async () => {
    const { id } = await insertCredential();

    const deleted = (await runMapped(
      'DELETE FROM identity.merchant_api_credentials WHERE id = $1',
      [id],
    )) as { error?: DomainError };
    expect(deleted.error?.code).toBe('IMMUTABLE_ROW');
    expect(deleted.error?.detail).toMatchObject({ operation: 'DELETE' });

    // Both identity tables are now referenced by `payments.payments`, so PostgreSQL refuses the
    // truncate itself (0A000) before the guard trigger fires. The DELETE cases above still prove the
    // trigger; this proves the stronger, earlier refusal.
    const truncated = (await runMapped('TRUNCATE identity.merchant_api_credentials')) as {
      error?: { code?: string };
    };
    expect(truncated.error?.code).toBe('0A000');

    const merchantDeleted = (await runMapped('DELETE FROM identity.merchants WHERE id = $1', [
      MERCHANT_B,
    ])) as { error?: DomainError };
    expect(merchantDeleted.error?.code).toBe('IMMUTABLE_ROW');

    // Truncating `merchants` is refused even earlier now that `payments.payments` references it:
    // PostgreSQL will not truncate a table referenced by a foreign key (0A000). Both refusals are
    // correct, and this asserts the one that actually applies.
    const merchantTruncated = (await runMapped('TRUNCATE identity.merchants')) as {
      error?: { code?: string };
    };
    expect(merchantTruncated.error?.code).toBe('0A000');
  });

  it('refuses to change a merchant display name, currency, or creation time', async () => {
    const result = await runMapped(
      "UPDATE identity.merchants SET display_name = 'renamed' WHERE id = $1",
      [MERCHANT_A],
    );
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(error.code).toBe('IMMUTABLE_FIELD');
    expect(error.detail).toMatchObject({
      table: 'identity.merchants',
      column: 'display_name',
    });
  });

  it('allows a merchant to be suspended, and stamps updated_at', async () => {
    const id = await insertMerchant();
    const before = await database.ownerPool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM identity.merchants WHERE id = $1',
      [id],
    );

    await database.ownerPool.query(
      "UPDATE identity.merchants SET status = 'SUSPENDED' WHERE id = $1",
      [id],
    );

    const after = await database.ownerPool.query<{ updated_at: Date; status: string }>(
      'SELECT updated_at, status FROM identity.merchants WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.status).toBe('SUSPENDED');
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]?.updated_at.getTime() ?? 0,
    );
  });
});

describe('repository', () => {
  it('issues as the operator role and looks up as the API role', async () => {
    const credential = await withTransaction(
      database.poolAs('fl_operator_command'),
      {},
      async (client) => {
        const id = nextId('mcr');
        const keyPrefix = nextPrefix();
        await issueCredential(client, {
          id,
          merchantId: MERCHANT_A,
          keyPrefix,
          digest: Buffer.alloc(32, 3),
          digestVersion: 1,
          scopes: ['payments:read'],
          expiresAt: null,
        });
        return { id, keyPrefix };
      },
    );

    const found = await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, credential.keyPrefix, ACCEPT),
    );

    expect(found).not.toBeNull();
    expect(found?.id).toBe(credential.id);
    expect(found?.merchantId).toBe(MERCHANT_A);
    expect(found?.merchantStatus).toBe('ACTIVE');
    expect(found?.scopes).toEqual(['payments:read']);
  });

  it('enters no tenant scope and returns null when verification fails', async () => {
    const { keyPrefix } = await insertCredential();
    const seen: (StoredCredentialDigest | null)[] = [];
    const scope = await withTransaction(database.poolAs('fl_api'), {}, async (client) => {
      const found = await lookupCredential(client, keyPrefix, (stored) => {
        seen.push(stored);
        return false;
      });
      const settings = await client.query<{ merchant: string | null; prefix: string | null }>(
        `SELECT nullif(current_setting('app.merchant_id', true), '') AS merchant,
                nullif(current_setting('app.credential_key_prefix', true), '') AS prefix`,
      );
      // With neither setting, RLS shows fl_api no credential row at all.
      const visible = await client.query('SELECT 1 FROM identity.merchant_api_credentials');
      return { found, ...settings.rows[0], visible: visible.rowCount };
    });
    expect(scope).toEqual({ found: null, merchant: null, prefix: null, visible: 0 });
    // The verifier saw the stored digest, so the miss and mismatch paths both compute an HMAC.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.digest).toHaveLength(32);
  });

  it('still calls the verifier once on a lookup miss, with null', async () => {
    const seen: (StoredCredentialDigest | null)[] = [];
    await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, 'ZZZZZZZZZZZY', (stored) => {
        seen.push(stored);
        return true;
      }),
    );
    expect(seen).toEqual([null]);
  });

  it('returns null for an unknown prefix', async () => {
    const found = await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, 'ZZZZZZZZZZZZ', ACCEPT),
    );
    expect(found).toBeNull();
  });

  it('returns null for an expired credential', async () => {
    const { keyPrefix } = await insertCredential({ expires_at: new Date(Date.now() - 1_000) });
    const found = await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, keyPrefix, ACCEPT),
    );
    expect(found).toBeNull();
  });

  it('returns null for a revoked credential', async () => {
    const { keyPrefix } = await insertCredential();
    const { id } = await database.ownerPool
      .query<{ id: string }>(
        'SELECT id FROM identity.merchant_api_credentials WHERE key_prefix = $1',
        [keyPrefix],
      )
      .then((result) => result.rows[0] as { id: string });

    const revoked = await withTransaction(
      database.poolAs('fl_operator_command'),
      {},
      async (client) => revokeCredential(client, id),
    );
    expect(revoked).toBe(true);

    const found = await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, keyPrefix, ACCEPT),
    );
    expect(found).toBeNull();
  });

  it('revoking twice returns false the second time', async () => {
    const { id } = await insertCredential();
    const first = await withTransaction(
      database.poolAs('fl_operator_command'),
      {},
      async (client) => revokeCredential(client, id),
    );
    const second = await withTransaction(
      database.poolAs('fl_operator_command'),
      {},
      async (client) => revokeCredential(client, id),
    );
    expect([first, second]).toEqual([true, false]);
  });

  it('supports rotation: both credentials resolve, revoking the old leaves the new', async () => {
    const old = await insertCredential({ merchant_id: MERCHANT_B });
    const fresh = await insertCredential({ merchant_id: MERCHANT_B });

    const foundOld = await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, old.keyPrefix, ACCEPT),
    );
    const foundFresh = await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
      lookupCredential(client, fresh.keyPrefix, ACCEPT),
    );
    expect([foundOld?.id, foundFresh?.id]).toEqual([old.id, fresh.id]);

    await withTransaction(database.poolAs('fl_operator_command'), {}, async (client) =>
      revokeCredential(client, old.id),
    );

    expect(
      await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
        lookupCredential(client, old.keyPrefix, ACCEPT),
      ),
    ).toBeNull();
    expect(
      await withTransaction(database.poolAs('fl_api'), {}, async (client) =>
        lookupCredential(client, fresh.keyPrefix, ACCEPT),
      ),
    ).not.toBeNull();
  });
});

describe('RLS and privileges', () => {
  it('shows fl_api nothing without tenant context or a prefix', async () => {
    const api = await database.poolAs('fl_api').connect();
    try {
      const merchants = await api.query('SELECT 1 FROM identity.merchants LIMIT 1');
      expect(merchants.rowCount).toBe(0);
      const credentials = await api.query(
        'SELECT 1 FROM identity.merchant_api_credentials LIMIT 1',
      );
      expect(credentials.rowCount).toBe(0);
    } finally {
      api.release();
    }
  });

  it('reveals only the prefixed credential, not the rest of the table', async () => {
    const target = await insertCredential({ merchant_id: MERCHANT_A });

    const api = await database.poolAs('fl_api').connect();
    try {
      await api.query('BEGIN');
      await api.query("SELECT set_config('app.credential_key_prefix', $1, true)", [
        target.keyPrefix,
      ]);

      const rows = await api.query<{ id: string }>(
        'SELECT id FROM identity.merchant_api_credentials',
      );
      expect(rows.rows.map((row) => row.id)).toEqual([target.id]);
      await api.query('ROLLBACK');
    } finally {
      api.release();
    }
  });

  it('never shows merchant A the rows of merchant B', async () => {
    const bCredential = await insertCredential({ merchant_id: MERCHANT_B });

    const api = await database.poolAs('fl_api').connect();
    try {
      await api.query('BEGIN');
      await api.query("SELECT set_config('app.merchant_id', $1, true)", [MERCHANT_A]);

      const rows = await api.query<{ id: string }>(
        'SELECT id FROM identity.merchant_api_credentials WHERE id = $1',
        [bCredential.id],
      );
      expect(rows.rowCount).toBe(0);

      const merchants = await api.query<{ id: string }>(
        'SELECT id FROM identity.merchants WHERE id = ANY($1::text[])',
        [[MERCHANT_A, MERCHANT_B]],
      );
      expect(merchants.rows.map((row) => row.id)).toEqual([MERCHANT_A]);
      await api.query('ROLLBACK');
    } finally {
      api.release();
    }
  });

  it('denies fl_api INSERT, UPDATE and DELETE with SQLSTATE 42501', async () => {
    const target = await insertCredential({ merchant_id: MERCHANT_A });
    const api = await database.poolAs('fl_api').connect();
    try {
      for (const statement of [
        {
          sql: `INSERT INTO identity.merchant_api_credentials (id, merchant_id, key_prefix, credential_digest, digest_version, scopes)
                VALUES ($1, $2, $3, $4, 1, ARRAY['payments:read'])`,
          values: [nextId('mcr'), MERCHANT_A, nextPrefix(), Buffer.alloc(32, 1)],
        },
        {
          sql: 'UPDATE identity.merchant_api_credentials SET last_used_at = clock_timestamp() WHERE id = $1',
          values: [target.id],
        },
        {
          sql: 'DELETE FROM identity.merchant_api_credentials WHERE id = $1',
          values: [target.id],
        },
        {
          sql: "UPDATE identity.merchants SET status = 'SUSPENDED' WHERE id = $1",
          values: [MERCHANT_A],
        },
      ]) {
        const error = await api
          .query(statement.sql, statement.values)
          .catch((caught: unknown) => caught);
        expect((error as { code?: string }).code, statement.sql).toBe('42501');
      }
    } finally {
      api.release();
    }
  });

  it('denies fl_operator_command the ability to change a digest', async () => {
    const target = await insertCredential({ merchant_id: MERCHANT_A });
    const operator = await database.poolAs('fl_operator_command').connect();
    try {
      const error = await operator
        .query(
          'UPDATE identity.merchant_api_credentials SET credential_digest = $1 WHERE id = $2',
          [Buffer.alloc(32, 7), target.id],
        )
        .catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe('42501');
    } finally {
      operator.release();
    }
  });
});
