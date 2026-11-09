/**
 * Fee-policy versions.
 *
 * The centre of this file is `fee_policies_fee_within_minimum`. Its whole purpose is to make an
 * unpriceable policy impossible to store, so the important cases are the ones it must *accept*: minimum
 * 50 (the operator default) and minimum 31 (the exact floor, where fee == gross). A rule that rejected
 * everything would pass every negative test.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { DomainError, LOGIN_RUNTIME_ROLES, withTransaction } from '@flowledger/database';
import {
  assertConstraintCoverage,
  createTestMerchant,
  disposeTestDatabase,
  setTestConnection,
  useTestDatabase,
  type TestDatabase,
} from '@flowledger/testkit';
import { newId } from '@flowledger/domain';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
const merchants: string[] = [];

beforeAll(async () => {
  database = await useTestDatabase()();
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

/** A merchant with no fee policy yet, so a test can insert exactly the policy it wants. */
async function bareMerchant(): Promise<string> {
  const merchantId = newId('mer');
  await database.ownerPool.query(
    `INSERT INTO identity.merchants (id, display_name, status, default_currency)
     VALUES ($1, 'Fee policy merchant', 'ACTIVE', 'USD')`,
    [merchantId],
  );
  merchants.push(merchantId);
  return merchantId;
}

interface PolicyInput {
  merchantId: string;
  version?: number;
  basisPoints?: number;
  fixedAmountMinor?: bigint;
  minimumCaptureAmountMinor?: bigint;
  currency?: string;
  captureRoundingMode?: string;
  refundFeeMode?: string;
  supersededAt?: Date | null;
  id?: string;
}

async function insertPolicy(input: PolicyInput): Promise<{ id: string }> {
  const id = input.id ?? newId('fee');
  await database.ownerPool.query(
    `INSERT INTO payments.fee_policies
       (id, merchant_id, version, currency, basis_points, fixed_amount_minor,
        minimum_capture_amount_minor, capture_rounding_mode, refund_fee_mode, superseded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.merchantId,
      input.version ?? 1,
      input.currency ?? 'USD',
      input.basisPoints ?? 290,
      input.fixedAmountMinor ?? 30n,
      input.minimumCaptureAmountMinor ?? 50n,
      input.captureRoundingMode ?? 'HALF_UP',
      input.refundFeeMode ?? 'PROPORTIONAL',
      input.supersededAt ?? null,
    ],
  );
  return { id };
}

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

describe('constraint coverage', () => {
  it('declares every constraint and index', async () => {
    await assertConstraintCoverage(database.ownerPool, 'payments.fee_policies', [
      'fee_policies_pkey',
      'fee_policies_id_format',
      'fee_policies_version_positive',
      'fee_policies_currency',
      'fee_policies_basis_points',
      'fee_policies_fixed_amount',
      'fee_policies_minimum_capture',
      'fee_policies_minimum_capture_max',
      'fee_policies_fee_within_minimum',
      'fee_policies_capture_rounding_mode',
      'fee_policies_refund_fee_mode',
      'fee_policies_merchant_version_key',
      'fee_policies_merchant_id_version_key',
      'fee_policies_merchant_fkey',
      'fee_policies_one_current',
      // Added by 0293: the composite target an operation's fee snapshot must match.
      'fee_policies_snapshot_key',
    ]);
  });
});

describe('the fee-within-minimum guarantee', () => {
  it('accepts the operator default (290 bp, 30 fixed, minimum 50)', async () => {
    const merchantId = await bareMerchant();
    await expect(insertPolicy({ merchantId })).resolves.toBeTruthy();
  });

  it('accepts the exact floor (290 bp, 30 fixed, minimum 31) where the fee equals the gross', async () => {
    const merchantId = await bareMerchant();
    // floor((31 * 290 + 5000) / 10000) + 30 = floor(13990/10000) + 30 = 1 + 30 = 31 == gross.
    await expect(
      insertPolicy({ merchantId, minimumCaptureAmountMinor: 31n }),
    ).resolves.toBeTruthy();

    const { rows } = await database.ownerPool.query<{ fee: string }>(
      `SELECT ((minimum_capture_amount_minor * basis_points + 5000) / 10000 + fixed_amount_minor)::text AS fee
         FROM payments.fee_policies WHERE merchant_id = $1`,
      [merchantId],
    );
    expect(rows[0]?.fee).toBe('31');
  });

  it('rejects a minimum one below the floor, where the fee would exceed the gross', async () => {
    const merchantId = await bareMerchant();
    // At minimum 30 the policy would charge floor((30*290+5000)/10000)+30 = 1+30 = 31 > 30.
    const error = await insertPolicy({ merchantId, minimumCaptureAmountMinor: 30n }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { code?: string }).code).toBe('23514');
    expect((error as { constraint?: string }).constraint).toBe('fee_policies_fee_within_minimum');
  });

  /**
   * The *fixed* half of `fee_policies_minimum_capture` (minimum >= fixed) is implied by
   * `fee_policies_fee_within_minimum`: the fee at the minimum includes the fixed component. The `>= 1`
   * half is not. With `fixed = 0` and `minimum = 0` the fee-within-minimum check evaluates
   * `(0 * bp + 5000) / 10000 + 0 <= 0`, which is true, so only `fee_policies_minimum_capture` refuses
   * that row (docs/02 §Minimum capture amount: "at least 1"). The P02-T07 break that relaxed the check
   * to `>= 1` kept exactly that half, which is why it could not fail; the case below pins it.
   */
  it('rejects a minimum below the fixed component, via the fee-within-minimum check', async () => {
    const merchantId = await bareMerchant();
    const error = await insertPolicy({ merchantId, minimumCaptureAmountMinor: 29n }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { code?: string }).code).toBe('23514');
    expect((error as { constraint?: string }).constraint).toBe('fee_policies_fee_within_minimum');
  });

  it('rejects minimum 0 with a zero fixed component, via the minimum-capture check alone', async () => {
    const merchantId = await bareMerchant();
    const error = await insertPolicy({
      merchantId,
      basisPoints: 290,
      fixedAmountMinor: 0n,
      minimumCaptureAmountMinor: 0n,
    }).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('23514');
    expect((error as { constraint?: string }).constraint).toBe('fee_policies_minimum_capture');
  });

  it('rejects minimum 0', async () => {
    const merchantId = await bareMerchant();
    const error = await insertPolicy({ merchantId, minimumCaptureAmountMinor: 0n }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { code?: string }).code).toBe('23514');
  });

  it('rejects a policy whose fee at a larger minimum still exceeds it', async () => {
    const merchantId = await bareMerchant();
    // 5000 bp and 30 fixed with minimum 30: a capture of 40 would cost 50.
    const error = await insertPolicy({
      merchantId,
      basisPoints: 5000,
      fixedAmountMinor: 30n,
      minimumCaptureAmountMinor: 30n,
    }).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('23514');
  });
});

describe('scalar constraints', () => {
  it.each([
    ['fee_policies_basis_points', { basisPoints: -1 }],
    ['fee_policies_basis_points', { basisPoints: 10001 }],
    ['fee_policies_capture_rounding_mode', { captureRoundingMode: 'HALF_EVEN' }],
    ['fee_policies_refund_fee_mode', { refundFeeMode: 'FLAT' }],
    ['fee_policies_id_format', { id: 'xxx_01ARZ3NDEKTSV4RRFFQ69G5FAA' }],
  ])('rejects %s via %o', async (constraint, over) => {
    const merchantId = await bareMerchant();
    const error = await insertPolicy({ merchantId, ...over }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it.each([
    ['a negative fixed amount', { fixedAmountMinor: -1n }],
    // An over-large fixed amount cannot satisfy fee_within_minimum at any permitted minimum, so that
    // check fires first here; the case is about the 23514 rejection, not about which check won.
    ['an over-large fixed amount', { fixedAmountMinor: 1000000000001n }],
    ['an over-large minimum', { minimumCaptureAmountMinor: 1000000000001n }],
  ])('rejects %s with SQLSTATE 23514', async (_label, over) => {
    const merchantId = await bareMerchant();
    const error = await insertPolicy({ merchantId, ...over }).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('23514');
  });

  it('rejects a non-USD currency', async () => {
    const merchantId = await bareMerchant();
    const error = await insertPolicy({ merchantId, currency: 'EUR' }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { constraint?: string }).constraint).toBe('fee_policies_currency');
  });

  it('rejects a reused version number before the unique key is ever consulted', async () => {
    // The monotonic trigger owns version numbering, so reusing version 1 is refused as an illegal
    // transition rather than as a duplicate key. The unique keys remain as a second line of defence —
    // asserted by the coverage check — but they are not what a caller can reach.
    const merchantId = await bareMerchant();
    await insertPolicy({ merchantId, supersededAt: new Date() });
    const result = await runMapped(
      `INSERT INTO payments.fee_policies
         (id, merchant_id, version, basis_points, fixed_amount_minor, minimum_capture_amount_minor)
       VALUES ($1, $2, 1, 290, 30, 50)`,
      [newId('fee'), merchantId],
    );
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.detail).toMatchObject({ reason: 'VERSION_NOT_MONOTONIC' });
  });

  it('rejects a second current policy for the same merchant and currency', async () => {
    const merchantId = await bareMerchant();
    await insertPolicy({ merchantId });
    const error = await insertPolicy({ merchantId, version: 2 }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('fee_policies_one_current');
  });

  it('rejects a version gap', async () => {
    const merchantId = await bareMerchant();
    await insertPolicy({ merchantId, supersededAt: new Date() });
    const result = await runMapped(
      `INSERT INTO payments.fee_policies
         (id, merchant_id, version, basis_points, fixed_amount_minor, minimum_capture_amount_minor)
       VALUES ($1, $2, 5, 290, 30, 50)`,
      [newId('fee'), merchantId],
    );
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.detail).toMatchObject({ reason: 'VERSION_NOT_MONOTONIC', expected: 2 });
  });
});

describe('immutability', () => {
  it('refuses to change any pricing column', async () => {
    const merchantId = await bareMerchant();
    const { id } = await insertPolicy({ merchantId });

    for (const [column, value] of [
      ['basis_points', 300],
      ['fixed_amount_minor', 31n],
      ['minimum_capture_amount_minor', 51n],
      ['currency', 'USD'],
    ] as const) {
      if (column === 'currency') continue; // unchanged value would be a no-op, not a break
      const result = await runMapped(
        `UPDATE payments.fee_policies SET ${column} = $1 WHERE id = $2`,
        [value, id],
      );
      const error = (result as { error?: DomainError }).error as DomainError;
      expect(error.code, column).toBe('IMMUTABLE_FIELD');
      expect(error.detail).toMatchObject({ column });
    }
  });

  it('supersedes once and refuses to clear the stamp', async () => {
    const merchantId = await bareMerchant();
    const { id } = await insertPolicy({ merchantId });

    const stamped = await runMapped(
      `UPDATE payments.fee_policies SET superseded_at = clock_timestamp() WHERE id = $1`,
      [id],
    );
    expect(stamped).toEqual({ ok: true });

    const again = await runMapped(
      `UPDATE payments.fee_policies SET superseded_at = clock_timestamp() WHERE id = $1`,
      [id],
    );
    expect(((again as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_FIELD');

    const cleared = await runMapped(
      `UPDATE payments.fee_policies SET superseded_at = NULL WHERE id = $1`,
      [id],
    );
    expect(((cleared as { error?: DomainError }).error as DomainError).code).toBe(
      'IMMUTABLE_FIELD',
    );
  });

  it('appends a second version after superseding the first', async () => {
    const merchantId = await bareMerchant();
    const { id } = await insertPolicy({ merchantId });

    await database.ownerPool.query('BEGIN');
    try {
      await database.ownerPool.query(
        `UPDATE payments.fee_policies SET superseded_at = clock_timestamp() WHERE id = $1`,
        [id],
      );
      await expect(
        insertPolicy({ merchantId, version: 2, basisPoints: 300 }),
      ).resolves.toBeTruthy();
      await database.ownerPool.query('COMMIT');
    } catch (error) {
      await database.ownerPool.query('ROLLBACK');
      throw error;
    }

    const { rows } = await database.ownerPool.query<{ version: number; current: boolean }>(
      `SELECT version, superseded_at IS NULL AS current FROM payments.fee_policies
        WHERE merchant_id = $1 ORDER BY version`,
      [merchantId],
    );
    expect(rows).toEqual([
      { version: 1, current: false },
      { version: 2, current: true },
    ]);
  });

  it('refuses to delete or truncate', async () => {
    const merchantId = await bareMerchant();
    const { id } = await insertPolicy({ merchantId });

    const deleted = await runMapped('DELETE FROM payments.fee_policies WHERE id = $1', [id]);
    expect(((deleted as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');

    // `payments.payments` references this table, so PostgreSQL refuses the truncate outright (0A000)
    // before the guard trigger is reached. A stronger refusal than the trigger's own.
    const truncated = await runMapped('TRUNCATE payments.fee_policies');
    expect((truncated as { error?: { code?: string } }).error?.code).toBe('0A000');
  });
});

describe('privileges', () => {
  it('denies every runtime role SELECT and INSERT', async () => {
    const merchantId = await bareMerchant();
    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        const selected = await client
          .query('SELECT 1 FROM payments.fee_policies LIMIT 1')
          .catch((caught: unknown) => caught);
        expect((selected as { code?: string }).code, `${role} SELECT`).toBe('42501');

        const inserted = await client
          .query(
            `INSERT INTO payments.fee_policies
               (id, merchant_id, version, basis_points, fixed_amount_minor, minimum_capture_amount_minor)
             VALUES ($1, $2, 1, 290, 30, 50)`,
            [newId('fee'), merchantId],
          )
          .catch((caught: unknown) => caught);
        expect((inserted as { code?: string }).code, `${role} INSERT`).toBe('42501');
      } finally {
        client.release();
      }
    }
  });
});

describe('createTestMerchant', () => {
  it('produces a usable, isolated merchant each time', async () => {
    const first = await createTestMerchant(database.ownerPool);
    const second = await createTestMerchant(database.ownerPool);

    // Disjoint: no identifier from one tenant appears in the other. Constants such as the provider
    // code and the version number are shared by design, so only the identifiers are compared.
    const identifiers = (merchant: typeof first): string[] => [
      merchant.merchantId,
      merchant.credentialId,
      merchant.keyPrefix,
      merchant.rawCredential,
      merchant.providerAccountId,
      merchant.feePolicyId,
    ];
    const firstIds = new Set(identifiers(first));
    for (const value of identifiers(second)) expect(firstIds.has(value)).toBe(false);

    // Both committed and complete.
    const { rows } = await database.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payments.fee_policies WHERE merchant_id = ANY($1::text[])`,
      [[first.merchantId, second.merchantId]],
    );
    expect(rows[0]?.count).toBe('2');

    const route = await database.ownerPool.query<{ is_default: boolean }>(
      `SELECT is_default FROM providers.merchant_routes WHERE merchant_id = $1`,
      [first.merchantId],
    );
    expect(route.rows[0]?.is_default).toBe(true);
  });

  it('defaults to the 290/30/50 policy the dev seed uses', async () => {
    const merchant = await createTestMerchant(database.ownerPool);
    const { rows } = await database.ownerPool.query<{
      basis_points: number;
      fixed_amount_minor: string;
      minimum_capture_amount_minor: string;
    }>(
      `SELECT basis_points, fixed_amount_minor::text, minimum_capture_amount_minor::text
         FROM payments.fee_policies WHERE id = $1`,
      [merchant.feePolicyId],
    );
    expect(rows[0]).toEqual({
      basis_points: 290,
      fixed_amount_minor: '30',
      minimum_capture_amount_minor: '50',
    });
  });

  it('honours overrides', async () => {
    const merchant = await createTestMerchant(database.ownerPool, {
      basisPoints: 0,
      fixedAmountMinor: 0n,
      minimumCaptureAmountMinor: 1n,
    });
    const { rows } = await database.ownerPool.query<{ basis_points: number }>(
      `SELECT basis_points FROM payments.fee_policies WHERE id = $1`,
      [merchant.feePolicyId],
    );
    expect(rows[0]?.basis_points).toBe(0);
  });
});
