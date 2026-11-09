/**
 * Payment operations: exclusion indexes, fee-effect rules, terminal freezing, and the active link.
 *
 * The exclusion tests are the ones that matter. Three unresolved refunds must coexist while a second
 * unresolved capture must not — that asymmetry is the concurrency model, and an index that included
 * REFUND would quietly forbid concurrent refunds while an index that excluded CAPTURE would allow two
 * captures.
 *
 * Every case that mutates runs inside a transaction that is rolled back, so the deferred aggregate
 * trigger arriving in P02-T10 cannot change these outcomes.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import pg from 'pg';

import { DomainError, LOGIN_RUNTIME_ROLES, withTransaction } from '@flowledger/database';
import { newId } from '@flowledger/domain';
import {
  assertConstraintCoverage,
  createTestMerchant,
  disposeTestDatabase,
  fixtureCapturedPayment,
  fixtureInsertOperation,
  fixtureInsertPayment,
  fixtureSyncPayment,
  setTestConnection,
  useTestDatabase,
  type TestDatabase,
  type TestMerchant,
} from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
let merchant: TestMerchant;

beforeAll(async () => {
  database = await useTestDatabase()();
  merchant = await createTestMerchant(database.ownerPool);
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

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

/**
 * Recomputes the payment's aggregate fields from its operation rows.
 *
 * Since 0260 the deferred trigger requires the two to agree at commit, so a fixture that inserts an
 * operation must also update the payment in the same transaction. Deriving the fields from the rows
 * rather than hand-computing them keeps every fixture consistent by construction.
 */
/** Runs `fn` in one transaction, so deferred consistency sees a settled end state. */
async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database.ownerPool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A fresh AUTHORIZED payment with a succeeded authorization, for operation tests to build on. */
async function authorizedPayment(amountMinor = 10_000n): Promise<{ paymentId: string }> {
  return inTransaction(async (client) => {
    const paymentId = await fixtureInsertPayment(client, merchant, {
      requestedAmountMinor: amountMinor,
    });
    await fixtureInsertOperation(client, merchant, paymentId, {
      type: 'AUTHORIZE',
      amountMinor,
      status: 'SUCCEEDED',
    });
    await fixtureSyncPayment(client, paymentId);
    return { paymentId };
  });
}

async function insertOperation(
  paymentId: string,
  operation: Parameters<typeof fixtureInsertOperation>[3],
): Promise<string> {
  return inTransaction(async (client) => {
    const id = await fixtureInsertOperation(client, merchant, paymentId, operation);
    await fixtureSyncPayment(client, paymentId);
    return id;
  });
}

describe('constraint coverage', () => {
  it('declares every constraint and unique index', async () => {
    await assertConstraintCoverage(database.ownerPool, 'payments.payment_operations', [
      'payment_operations_pkey',
      'payment_operations_id_format',
      'payment_operations_merchant_id_id_key',
      'payment_operations_payment_scope_key',
      'payment_operations_attempt_binding_key',
      'payment_operations_provider_key',
      'payment_operations_payment_binding_fkey',
      'payment_operations_fee_policy_fkey',
      'payment_operations_capture_fkey',
      'payment_operations_type',
      'payment_operations_amount',
      'payment_operations_currency',
      'payment_operations_status',
      'payment_operations_provider_key_nonempty',
      'payment_operations_version_positive',
      'payment_operations_resolved_at',
      'payment_operations_resolution',
      'payment_operations_resolution_source',
      'payment_operations_resolution_evidence_format',
      'payment_operations_success_reference',
      'payment_operations_result_code',
      'payment_operations_refund_capture_link',
      'payment_operations_fee_snapshot',
      'payment_operations_fee_snapshot_values',
      'payment_operations_fee_effect',
      'payment_operations_not_before',
      'payment_operations_one_active_exclusive',
      'payment_operations_one_successful_authorization',
      'payment_operations_one_successful_capture',
      'payment_operations_one_successful_cancel',
      // Added by 0293: the snapshot is the named policy row, that row is the payment's binding, and
      // the fee arithmetic is exact.
      'payment_operations_fee_snapshot_fkey',
      'payment_operations_payment_fee_binding_fkey',
      'payment_operations_capture_fee_formula',
      'payment_operations_refund_fee_bound',
    ]);
  });
});

describe('fee-effect rules', () => {
  it('rejects an AUTHORIZE carrying a fee snapshot', async () => {
    const { paymentId } = await authorizedPayment();
    const client = await database.ownerPool.connect();
    try {
      const error = await client
        .query(
          `INSERT INTO payments.payment_operations
             (id, merchant_id, payment_id, type, amount_minor, provider_account_id,
              provider_account_version, provider_idempotency_key, fee_policy_id, fee_policy_version,
              fee_basis_points, fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode)
           VALUES ($1, $2, $3, 'AUTHORIZE', 100, $4, 1, $5, $6, 1, 290, 30, 'HALF_UP', 'PROPORTIONAL')`,
          [
            newId('op'),
            merchant.merchantId,
            paymentId,
            merchant.providerAccountId,
            newId('op'),
            merchant.feePolicyId,
          ],
        )
        .catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe('payment_operations_fee_snapshot');
    } finally {
      client.release();
    }
  });

  it('rejects a CAPTURE without a snapshot', async () => {
    const { paymentId } = await authorizedPayment();
    const client = await database.ownerPool.connect();
    try {
      const error = await client
        .query(
          `INSERT INTO payments.payment_operations
             (id, merchant_id, payment_id, type, amount_minor, status, provider_account_id,
              provider_account_version, provider_idempotency_key, fee_effect_type, fee_effect_amount_minor)
           VALUES ($1, $2, $3, 'CAPTURE', 1000, 'REQUESTED', $4, 1, $5, 'CHARGE', 30)`,
          [newId('op'), merchant.merchantId, paymentId, merchant.providerAccountId, newId('op')],
        )
        .catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe('payment_operations_fee_snapshot');
    } finally {
      client.release();
    }
  });

  it('rejects a CAPTURE whose exact fee exceeds its amount', async () => {
    // Below the policy minimum the formula prices 1 at floor((290+5000)/10000)+30 = 30 > 1: the
    // formula check is satisfied, so only the 0..amount bound can refuse it.
    const { paymentId } = await authorizedPayment();
    const error = await insertOperation(paymentId, {
      type: 'CAPTURE',
      amountMinor: 1n,
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('payment_operations_fee_effect');
  });

  it('accepts a CAPTURE fee exactly equal to the amount', async () => {
    // A 10000 bp, zero-fixed policy prices every capture at its full amount: the bound's edge.
    const fullFee = await createTestMerchant(database.ownerPool, {
      basisPoints: 10_000,
      fixedAmountMinor: 0n,
      minimumCaptureAmountMinor: 1n,
    });
    await expect(
      inTransaction(async (client) => {
        const paymentId = await fixtureInsertPayment(client, fullFee, {
          requestedAmountMinor: 1_000n,
        });
        await fixtureInsertOperation(client, fullFee, paymentId, {
          type: 'AUTHORIZE',
          amountMinor: 1_000n,
          status: 'SUCCEEDED',
        });
        await fixtureSyncPayment(client, paymentId);
        const id = await fixtureInsertOperation(client, fullFee, paymentId, {
          type: 'CAPTURE',
          amountMinor: 1_000n,
          feeEffectAmountMinor: 1_000n,
        });
        await fixtureSyncPayment(client, paymentId);
        return id;
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a CAPTURE fee that is not the policy formula', async () => {
    // 1000 at 290 bp + 30 is floor((290000+5000)/10000)+30 = 59; 60 is within 0..amount but wrong.
    const { paymentId } = await authorizedPayment();
    const error = await insertOperation(paymentId, {
      type: 'CAPTURE',
      amountMinor: 1_000n,
      feeEffectAmountMinor: 60n,
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'payment_operations_capture_fee_formula',
    );
  });

  it('accepts the formula fee', async () => {
    const { paymentId } = await authorizedPayment();
    await expect(
      insertOperation(paymentId, {
        type: 'CAPTURE',
        amountMinor: 1_000n,
        feeEffectAmountMinor: 59n,
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a fee snapshot that disagrees with the policy row it names', async () => {
    const { paymentId } = await authorizedPayment();
    // 100 bp against a policy row that says 290: the snapshot names the row but disagrees with it.
    const direct = await runMapped(
      `INSERT INTO payments.payment_operations
         (id, merchant_id, payment_id, type, amount_minor, provider_account_id,
          provider_account_version, provider_idempotency_key, fee_policy_id, fee_policy_version,
          fee_basis_points, fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode,
          fee_effect_type, fee_effect_amount_minor)
       VALUES ($1, $2, $3, 'CAPTURE', 1000, $4, 1, $5, $6, 1, 100, 30, 'HALF_UP', 'PROPORTIONAL',
               'CHARGE', 40)`,
      [
        newId('op'),
        merchant.merchantId,
        paymentId,
        merchant.providerAccountId,
        `flowledger:test:${newId('op')}`,
        merchant.feePolicyId,
      ],
    );
    expect('error' in direct && (direct.error as { constraint?: string }).constraint).toBe(
      'payment_operations_fee_snapshot_fkey',
    );
  });

  it('rejects an operation priced with a policy other than its payment’s binding', async () => {
    // Own merchant: superseding the policy must not leak into the other cases in this file.
    const repriced = await createTestMerchant(database.ownerPool);
    const paymentId = await inTransaction(async (client) => {
      const id = await fixtureInsertPayment(client, repriced, { requestedAmountMinor: 10_000n });
      await fixtureInsertOperation(client, repriced, id, {
        type: 'AUTHORIZE',
        amountMinor: 10_000n,
        status: 'SUCCEEDED',
      });
      await fixtureSyncPayment(client, id);
      return id;
    });
    const other = newId('fee');
    const direct = await runMapped(
      `WITH p AS (
         UPDATE payments.fee_policies SET superseded_at = clock_timestamp()
          WHERE merchant_id = $2 AND superseded_at IS NULL RETURNING 1
       )
       INSERT INTO payments.fee_policies
         (id, merchant_id, version, basis_points, fixed_amount_minor, minimum_capture_amount_minor)
       SELECT $1, $2, 2, 290, 30, 50 FROM p`,
      [other, repriced.merchantId],
    );
    expect(direct).toEqual({ ok: true });
    const error = await runMapped(
      `INSERT INTO payments.payment_operations
         (id, merchant_id, payment_id, type, amount_minor, provider_account_id,
          provider_account_version, provider_idempotency_key, fee_policy_id, fee_policy_version,
          fee_basis_points, fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode,
          fee_effect_type, fee_effect_amount_minor)
       VALUES ($1, $2, $3, 'CAPTURE', 1000, $4, 1, $5, $6, 2, 290, 30, 'HALF_UP', 'PROPORTIONAL',
               'CHARGE', 59)`,
      [
        newId('op'),
        repriced.merchantId,
        paymentId,
        repriced.providerAccountId,
        `flowledger:test:${newId('op')}`,
        other,
      ],
    );
    expect('error' in error && (error.error as { constraint?: string }).constraint).toBe(
      'payment_operations_payment_fee_binding_fkey',
    );
  });

  it('rejects a REFUND reversal larger than the refund amount', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const { paymentId, captureId } = await fixtureCapturedPayment(client, merchant, 10_000n);
      await client.query('COMMIT');
      await client.query('BEGIN');
      const error = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'REFUND',
        amountMinor: 100n,
        status: 'SUCCEEDED',
        captureOperationId: captureId,
        feeEffectAmountMinor: 101n,
      }).catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect((error as { constraint?: string }).constraint).toBe(
        'payment_operations_refund_fee_bound',
      );
    } finally {
      client.release();
    }
  });

  it('rejects a REFUND with a fee while REQUESTED, and a SUCCEEDED REFUND without one', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const { paymentId, captureId } = await fixtureCapturedPayment(client, merchant, 10_000n);
      await client.query('COMMIT');

      await client.query('BEGIN');
      const inFlight = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'REFUND',
        amountMinor: 1_000n,
        captureOperationId: captureId,
        feeEffectAmountMinor: 0n,
      }).catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect((inFlight as { constraint?: string }).constraint).toBe(
        'payment_operations_fee_effect',
      );

      await client.query('BEGIN');
      const missingFee = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'REFUND',
        amountMinor: 1_000n,
        status: 'SUCCEEDED',
        captureOperationId: captureId,
        feeEffectAmountMinor: null,
      }).catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect((missingFee as { constraint?: string }).constraint).toBe(
        'payment_operations_fee_effect',
      );
    } finally {
      client.release();
    }
  });
});

describe('link and resolution rules', () => {
  it('rejects a REFUND without a capture link and a CANCEL with one', async () => {
    const { paymentId } = await authorizedPayment();
    const noLink = await insertOperation(paymentId, { type: 'REFUND', amountMinor: 100n }).catch(
      (caught: unknown) => caught,
    );
    expect((noLink as { constraint?: string }).constraint).toBe(
      'payment_operations_refund_capture_link',
    );

    const withLink = await insertOperation(paymentId, {
      type: 'CANCEL',
      amountMinor: 100n,
      captureOperationId: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    }).catch((caught: unknown) => caught);
    expect((withLink as { constraint?: string }).constraint).toBe(
      'payment_operations_refund_capture_link',
    );
  });

  it('rejects SUCCEEDED without a provider reference and REJECTED without a result code', async () => {
    const { paymentId } = await authorizedPayment();
    const noReference = await insertOperation(paymentId, {
      type: 'CANCEL',
      amountMinor: 100n,
      status: 'SUCCEEDED',
      providerOperationId: null,
    }).catch((caught: unknown) => caught);
    expect((noReference as { constraint?: string }).constraint).toBe(
      'payment_operations_success_reference',
    );

    const noCode = await insertOperation(paymentId, {
      type: 'CANCEL',
      amountMinor: 100n,
      status: 'REJECTED',
      resultCode: null,
    }).catch((caught: unknown) => caught);
    expect((noCode as { constraint?: string }).constraint).toBe('payment_operations_result_code');
  });

  it('rejects a lowercase result code', async () => {
    const { paymentId } = await authorizedPayment();
    const error = await insertOperation(paymentId, {
      type: 'CANCEL',
      amountMinor: 100n,
      status: 'REJECTED',
      resultCode: 'card_declined',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('payment_operations_result_code');
  });

  it('rejects not_before on a PROCESSING row', async () => {
    const { paymentId } = await authorizedPayment();
    const error = await insertOperation(paymentId, {
      type: 'CAPTURE',
      amountMinor: 100n,
      status: 'PROCESSING',
      notBefore: new Date(),
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('payment_operations_not_before');
  });

  it('rejects an operation bound to a provider version its payment is not bound to', async () => {
    const { paymentId } = await authorizedPayment();
    const error = await insertOperation(paymentId, {
      type: 'CAPTURE',
      amountMinor: 100n,
      providerAccountVersion: 2,
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'payment_operations_payment_binding_fkey',
    );
  });

  it('rejects a capture link to another payment’s operation', async () => {
    const first = await authorizedPayment(10_000n);
    const second = await authorizedPayment(10_000n);

    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const foreignCapture = await fixtureInsertOperation(client, merchant, first.paymentId, {
        type: 'CAPTURE',
        amountMinor: 10_000n,
        status: 'SUCCEEDED',
      });
      const error = await fixtureInsertOperation(client, merchant, second.paymentId, {
        type: 'REFUND',
        amountMinor: 100n,
        captureOperationId: foreignCapture,
      }).catch((caught: unknown) => caught);
      await client.query('ROLLBACK');

      expect((error as { constraint?: string }).constraint).toBe('payment_operations_capture_fkey');
    } finally {
      client.release();
    }
  });

  it('rejects a duplicate provider idempotency key for one account', async () => {
    const { paymentId } = await authorizedPayment();
    const client = await database.ownerPool.connect();
    try {
      const id = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'CAPTURE',
        amountMinor: 100n,
        status: 'REJECTED',
      });
      const key = await client.query<{ provider_idempotency_key: string }>(
        'SELECT provider_idempotency_key FROM payments.payment_operations WHERE id = $1',
        [id],
      );
      const error = await client
        .query(
          `INSERT INTO payments.payment_operations
             (id, merchant_id, payment_id, type, amount_minor, status, provider_account_id,
              provider_account_version, provider_idempotency_key, result_code, resolution_source,
              resolution_evidence_id, resolved_at, fee_policy_id, fee_policy_version, fee_basis_points,
              fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode, fee_effect_type,
              fee_effect_amount_minor)
           VALUES ($1, $2, $3, 'CAPTURE', 100, 'REJECTED', $4, 1, $5, 'CARD_DECLINED',
                   'API_RESPONSE', $6, clock_timestamp(), $7, 1, 290, 30, 'HALF_UP', 'PROPORTIONAL',
                   'CHARGE', 33)`,
          [
            newId('op'),
            merchant.merchantId,
            paymentId,
            merchant.providerAccountId,
            key.rows[0]?.provider_idempotency_key,
            newId('pev'),
            merchant.feePolicyId,
          ],
        )
        .catch((caught: unknown) => caught);
      expect([
        'payment_operations_provider_key',
        'payment_operations_one_active_exclusive',
      ]).toContain((error as { constraint?: string }).constraint);
    } finally {
      client.release();
    }
  });
});

describe('exclusion indexes', () => {
  it('allows three unresolved refunds on one payment', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const { paymentId, captureId } = await fixtureCapturedPayment(client, merchant, 10_000n);
      await client.query('COMMIT');

      for (const amount of [1_000n, 2_000n, 3_000n]) {
        await expect(
          insertOperation(paymentId, {
            type: 'REFUND',
            amountMinor: amount,
            captureOperationId: captureId,
          }),
        ).resolves.toBeTruthy();
      }

      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payments.payment_operations
          WHERE payment_id = $1 AND type = 'REFUND' AND status = 'REQUESTED'`,
        [paymentId],
      );
      expect(rows[0]?.count).toBe('3');
    } finally {
      client.release();
    }
  });

  it('allows two succeeded refunds on one payment', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const { paymentId, captureId } = await fixtureCapturedPayment(client, merchant, 10_000n);
      await client.query('COMMIT');
      for (const amount of [1_000n, 2_000n]) {
        await expect(
          insertOperation(paymentId, {
            type: 'REFUND',
            amountMinor: amount,
            status: 'SUCCEEDED',
            captureOperationId: captureId,
          }),
        ).resolves.toBeTruthy();
      }
    } finally {
      client.release();
    }
  });

  it.each<[string, 'AUTHORIZE' | 'CAPTURE' | 'CANCEL', 'CAPTURE' | 'CANCEL' | 'AUTHORIZE', string]>(
    [
      ['AUTHORIZE then CAPTURE', 'AUTHORIZE', 'CAPTURE', 'REQUESTED'],
      ['CAPTURE then CANCEL', 'CAPTURE', 'CANCEL', 'PROCESSING'],
      ['AUTHORIZE UNKNOWN then CANCEL', 'AUTHORIZE', 'CANCEL', 'UNKNOWN'],
      ['CAPTURE REQUIRES_REVIEW then AUTHORIZE', 'CAPTURE', 'AUTHORIZE', 'REQUIRES_REVIEW'],
    ],
  )(
    'refuses a second unresolved exclusive: %s',
    async (_label, firstType, secondType, firstStatus) => {
      // An AUTHORIZE needs a payment with no successful authorization yet: since 0294 a new attempt
      // beside a success is itself refused (docs/03 §MVP policy decisions), which is not this case.
      const paymentId =
        firstType === 'AUTHORIZE'
          ? await inTransaction((client) =>
              fixtureInsertPayment(client, merchant, { requestedAmountMinor: 10_000n }),
            )
          : (await authorizedPayment()).paymentId;
      await expect(
        insertOperation(paymentId, {
          type: firstType,
          amountMinor: 100n,
          status: firstStatus,
        }),
      ).resolves.toBeTruthy();

      const error = await insertOperation(paymentId, { type: secondType, amountMinor: 100n }).catch(
        (caught: unknown) => caught,
      );
      expect((error as { constraint?: string }).constraint).toBe(
        'payment_operations_one_active_exclusive',
      );
    },
  );

  it.each<['AUTHORIZE' | 'CAPTURE' | 'CANCEL']>([['AUTHORIZE'], ['CAPTURE'], ['CANCEL']])(
    'refuses a second succeeded %s',
    async (type) => {
      // Rolled back at the end, so the aggregate trigger never runs: this case is about the partial
      // unique index, which fires at statement time.
      const client = await database.ownerPool.connect();
      try {
        await client.query('BEGIN');
        const paymentId = await fixtureInsertPayment(client, merchant, {
          requestedAmountMinor: 10_000n,
        });
        await fixtureInsertOperation(client, merchant, paymentId, {
          type,
          amountMinor: 10_000n,
          status: 'SUCCEEDED',
        });
        const error = await fixtureInsertOperation(client, merchant, paymentId, {
          type,
          amountMinor: 10_000n,
          status: 'SUCCEEDED',
        }).catch((caught: unknown) => caught);

        expect([
          'payment_operations_one_successful_authorization',
          'payment_operations_one_successful_capture',
          'payment_operations_one_successful_cancel',
        ]).toContain((error as { constraint?: string }).constraint);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
  );
});

describe('guards', () => {
  it('freezes a terminal row against every update', async () => {
    const { paymentId } = await authorizedPayment();
    const client = await database.ownerPool.connect();
    try {
      const id = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'CANCEL',
        amountMinor: 100n,
        status: 'REJECTED',
      });
      const result = await runMapped(
        `UPDATE payments.payment_operations SET result_code = 'OTHER', version = version + 1 WHERE id = $1`,
        [id],
      );
      const domain = (result as { error?: DomainError }).error as DomainError;
      expect(domain.code).toBe('INVALID_TRANSITION');
      expect(domain.detail).toMatchObject({ reason: 'TERMINAL_OPERATION' });
    } finally {
      client.release();
    }
  });

  it.each<[string, unknown]>([
    ['amount_minor', 200n],
    ['provider_idempotency_key', 'changed'],
    ['fee_basis_points', 500],
  ])('refuses to change %s on a REQUESTED row', async (column, value) => {
    const { paymentId } = await authorizedPayment();
    const id = await insertOperation(paymentId, { type: 'CAPTURE', amountMinor: 100n });
    const result = await runMapped(
      `UPDATE payments.payment_operations SET ${column} = $1, version = version + 1 WHERE id = $2`,
      [value, id],
    );
    const domain = (result as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column });
  });

  it('treats provider_operation_id as append-once', async () => {
    const { paymentId } = await authorizedPayment();
    const id = await insertOperation(paymentId, { type: 'CAPTURE', amountMinor: 100n });

    await expect(
      runMapped(
        `UPDATE payments.payment_operations SET provider_operation_id = 'a', version = version + 1 WHERE id = $1`,
        [id],
      ),
    ).resolves.toEqual({ ok: true });

    const result = await runMapped(
      `UPDATE payments.payment_operations SET provider_operation_id = 'b', version = version + 1 WHERE id = $1`,
      [id],
    );
    const domain = (result as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column: 'provider_operation_id' });
  });

  it('requires the version to increase by one', async () => {
    const { paymentId } = await authorizedPayment();
    const id = await insertOperation(paymentId, { type: 'CAPTURE', amountMinor: 100n });
    const result = await runMapped(
      `UPDATE payments.payment_operations SET status = 'PROCESSING' WHERE id = $1`,
      [id],
    );
    const domain = (result as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('INVALID_TRANSITION');
    expect(domain.detail).toMatchObject({ reason: 'VERSION_NOT_INCREMENTED' });
  });

  it('refuses to delete', async () => {
    const { paymentId } = await authorizedPayment();
    const id = await insertOperation(paymentId, { type: 'CAPTURE', amountMinor: 100n });
    const result = await runMapped('DELETE FROM payments.payment_operations WHERE id = $1', [id]);
    expect(((result as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');
  });
});

describe('active-exclusive link', () => {
  it('refuses a pointer to another payment’s operation', async () => {
    const first = await authorizedPayment();
    const second = await authorizedPayment();
    const foreign = await insertOperation(second.paymentId, {
      type: 'CAPTURE',
      amountMinor: 100n,
    });

    const result = await runMapped(
      `UPDATE payments.payments SET active_exclusive_operation_id = $1, version = version + 1 WHERE id = $2`,
      [foreign, first.paymentId],
    );
    expect((result as { error?: { constraint?: string } }).error?.constraint).toBe(
      'payments_active_exclusive_operation_fkey',
    );
  });

  it('accepts a pointer to its own unresolved operation', async () => {
    const { paymentId } = await authorizedPayment();
    const own = await insertOperation(paymentId, { type: 'CAPTURE', amountMinor: 100n });

    await expect(
      runMapped(
        `UPDATE payments.payments SET active_exclusive_operation_id = $1, version = version + 1 WHERE id = $2`,
        [own, paymentId],
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe('privileges', () => {
  it('denies every runtime role write access', async () => {
    const { paymentId } = await authorizedPayment();
    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        for (const statement of [
          {
            sql: `INSERT INTO payments.payment_operations
                    (id, merchant_id, payment_id, type, amount_minor, provider_account_id,
                     provider_account_version, provider_idempotency_key)
                  VALUES ($1, $2, $3, 'CANCEL', 100, $4, 1, $5)`,
            values: [
              newId('op'),
              merchant.merchantId,
              paymentId,
              merchant.providerAccountId,
              newId('op'),
            ],
          },
          { sql: "UPDATE payments.payment_operations SET status = 'PROCESSING'", values: [] },
          { sql: 'DELETE FROM payments.payment_operations', values: [] },
          { sql: 'TRUNCATE payments.payment_operations', values: [] },
        ]) {
          const error = await client
            .query(statement.sql, statement.values)
            .catch((caught: unknown) => caught);
          expect((error as { code?: string }).code, `${role}: ${statement.sql.slice(0, 28)}`).toBe(
            '42501',
          );
        }
      } finally {
        client.release();
      }
    }
  });
});
