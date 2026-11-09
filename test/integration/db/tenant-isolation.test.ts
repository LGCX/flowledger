/**
 * Tenant isolation: RLS *and* the explicit predicate.
 *
 * These are two independent guarantees and both are tested, because they fail differently. If RLS is
 * the only defence, an owner connection or a policy change silently exposes other tenants. If the
 * predicate is the only defence, a future query that forgets it exposes them instead. The repository
 * functions carry the predicate; the policies catch everything else.
 */
import type pg from 'pg';

import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import {
  LOGIN_RUNTIME_ROLES,
  findOperation,
  findPayment,
  withTransaction,
} from '@flowledger/database';
import { newId } from '@flowledger/domain';
import {
  createTestMerchant,
  disposeTestDatabase,
  fixtureInsertOperation,
  fixtureInsertPayment,
  fixtureSyncPayment,
  paymentCreatedEnvelope,
  setTestConnection,
  useTestDatabase,
  withRole,
  type TestDatabase,
  type TestMerchant,
} from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
let alpha: TestMerchant;
let beta: TestMerchant;
let alphaPayment: string;
let betaPayment: string;
let alphaOperation: string;
let betaOperation: string;

beforeAll(async () => {
  database = await useTestDatabase()();
  alpha = await createTestMerchant(database.ownerPool);
  beta = await createTestMerchant(database.ownerPool);

  const client = await database.ownerPool.connect();
  try {
    await client.query('BEGIN');
    alphaPayment = await fixtureInsertPayment(client, alpha, { requestedAmountMinor: 1_000n });
    alphaOperation = await fixtureInsertOperation(client, alpha, alphaPayment, {
      type: 'AUTHORIZE',
      amountMinor: 1_000n,
    });
    await fixtureSyncPayment(client, alphaPayment);
    await client.query('COMMIT');

    await client.query('BEGIN');
    betaPayment = await fixtureInsertPayment(client, beta, { requestedAmountMinor: 1_000n });
    betaOperation = await fixtureInsertOperation(client, beta, betaPayment, {
      type: 'AUTHORIZE',
      amountMinor: 1_000n,
    });
    await fixtureSyncPayment(client, betaPayment);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

/**
 * Runs `sql` as `fl_api` with the given tenant context.
 *
 * A role-scoped pool rather than `withRole`: the migration owner is a member of the function owners but
 * not of `fl_api`, so `SET LOCAL ROLE fl_api` is refused. Connecting as the role is also closer to what
 * the application does.
 */
async function asApi<T>(
  merchantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.poolAs('fl_api').connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchantId ?? '']);
    const value = await fn(client);
    await client.query('ROLLBACK');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const SCOPED_TABLES = [
  'identity.merchants',
  'identity.merchant_api_credentials',
  'payments.payments',
  'payments.payment_operations',
] as const;

describe('RLS scopes reads to the current tenant', () => {
  it.each(SCOPED_TABLES)('exposes only tenant A rows in %s', async (table) => {
    const counted = await asApi(alpha.merchantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      return rows[0]?.count;
    });
    expect(counted).toBe('1');

    // `identity.merchants` identifies the tenant by `id`; every other table carries `merchant_id`.
    const tenantColumn = table === 'identity.merchants' ? 'id' : 'merchant_id';
    const other = await asApi(beta.merchantId, async (client) => {
      const { rows } = await client.query<Record<string, string>>(
        `SELECT ${tenantColumn} AS tenant FROM ${table}`,
      );
      return rows.map((row) => row.tenant);
    });
    expect(other).toEqual([beta.merchantId]);
  });

  it('sees nothing with no context or an empty context', async () => {
    for (const context of [null, '']) {
      await asApi(context, async (client) => {
        for (const table of SCOPED_TABLES) {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM ${table}`,
          );
          expect(rows[0]?.count, `${table} with context ${String(context)}`).toBe('0');
        }
      });
    }
  });

  it('refuses a write even with a valid context', async () => {
    await asApi(alpha.merchantId, async (client) => {
      const error = await client
        .query('UPDATE payments.payments SET version = version + 1 WHERE id = $1', [alphaPayment])
        .catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe('42501');
    });
  });
});

describe('the explicit predicate holds independently of RLS', () => {
  it('returns null for another tenant’s payment and operation', async () => {
    for (const context of [alpha.merchantId, beta.merchantId]) {
      await withTransaction(database.ownerPool, { merchantId: context }, async (client) => {
        // Context A with B's payment id, and context B with B's own id but asking as A: the predicate
        // means the answer does not depend on which of the two the policy happens to allow.
        expect(await findPayment(client, alpha.merchantId, betaPayment)).toBeNull();
        expect(await findOperation(client, alpha.merchantId, betaOperation)).toBeNull();
        expect(await findPayment(client, beta.merchantId, alphaPayment)).toBeNull();
      });
    }
  });

  it('returns the row for its own tenant, with money as bigint', async () => {
    const payment = await withTransaction(
      database.ownerPool,
      { merchantId: alpha.merchantId },
      (client) => findPayment(client, alpha.merchantId, alphaPayment),
    );

    expect(payment?.id).toBe(alphaPayment);
    expect(payment?.requestedAmountMinor).toBe(1_000n);
    expect(typeof payment?.requestedAmountMinor).toBe('bigint');
    expect(payment?.version).toBeTypeOf('bigint');

    const operation = await withTransaction(
      database.ownerPool,
      { merchantId: alpha.merchantId },
      (client) => findOperation(client, alpha.merchantId, alphaOperation),
    );
    expect(operation?.id).toBe(alphaOperation);
    expect(operation?.amountMinor).toBe(1_000n);
  });
});

describe('cross-tenant references are refused', () => {
  it('refuses an operation bound to another merchant’s provider account', async () => {
    const client = await database.ownerPool.connect();
    try {
      // A payment of its own, with no unresolved operation: otherwise the exclusive-operation index
      // fires first and this would prove the wrong constraint.
      const fresh = await fixtureInsertPayment(client, alpha, { requestedAmountMinor: 1_000n });
      const error = await client
        .query(
          `INSERT INTO payments.payment_operations
             (id, merchant_id, payment_id, type, amount_minor, provider_account_id,
              provider_account_version, provider_idempotency_key)
           VALUES ($1, $2, $3, 'CANCEL', 100, $4, 1, $5)`,
          [newId('op'), alpha.merchantId, fresh, beta.providerAccountId, newId('op')],
        )
        .catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe(
        'payment_operations_payment_binding_fkey',
      );
    } finally {
      client.release();
    }
  });

  it('refuses an outbox envelope naming another merchant’s payment', async () => {
    const envelope = paymentCreatedEnvelope({
      merchantId: alpha.merchantId,
      paymentId: betaPayment,
      providerAccountId: alpha.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });

    const error = await withRole(database.ownerPool, 'payments_function_owner', async (client) =>
      client
        .query('SELECT messaging.insert_outbox($1::jsonb)', [JSON.stringify(envelope)])
        .catch((caught: unknown) => caught),
    );
    const detail = JSON.parse(String((error as { detail?: string }).detail)) as { reason: string };
    expect(detail.reason).toBe('SUBJECT_NOT_FOUND');
  });
});

describe('other runtime roles', () => {
  it('get 42501 reading merchant data', async () => {
    const failures: string[] = [];
    for (const role of LOGIN_RUNTIME_ROLES) {
      if (role === 'fl_api' || role === 'fl_operator_command') continue;
      const client = await database.poolAs(role).connect();
      try {
        for (const table of SCOPED_TABLES) {
          const error = await client
            .query(`SELECT 1 FROM ${table} LIMIT 1`)
            .catch((caught: unknown) => caught);
          const code = (error as { code?: string } | undefined)?.code;
          if (code !== '42501') failures.push(`${role} ${table}: got ${String(code)}`);
        }
      } finally {
        client.release();
      }
    }
    expect(failures).toEqual([]);
  });
});
