/**
 * The deferred aggregate-consistency trigger.
 *
 * Every failure case asserts three things: the SQLSTATE, the constraint name, and the exact field in
 * the message. The field matters most — "inconsistent" is not actionable, while "the pointer disagrees"
 * is — and it also proves the checks run in the documented order.
 *
 * Each case also verifies the rows are unchanged afterwards: a deferred failure must roll the whole
 * transaction back, not leave the payment corrected and the operation not.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { LOGIN_RUNTIME_ROLES } from '@flowledger/database';
import {
  createTestMerchant,
  disposeTestDatabase,
  fixtureCapturedPayment,
  fixtureInsertOperation,
  fixtureInsertPayment,
  fixtureUpdateOperation,
  fixtureUpdatePayment,
  setTestConnection,
  useTestDatabase,
  withRole,
  type TestDatabase,
  type TestMerchant,
} from '@flowledger/testkit';
import pg from 'pg';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;

beforeAll(async () => {
  database = await useTestDatabase()();
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

/** Runs `fn` in one transaction and returns either its value or the error that aborted the commit. */
async function inTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; constraint?: string; message?: string } }
> {
  const client = await database.ownerPool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return { ok: true, value };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { ok: false, error: error as { code?: string; constraint?: string; message?: string } };
  } finally {
    client.release();
  }
}

function expectConsistencyFailure(
  result: Awaited<ReturnType<typeof inTransaction>>,
  field: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('23514');
  expect(result.error.constraint).toBe('payment_aggregate_consistency');
  expect(result.error.message).toBe(`payment_aggregate_consistency: ${field}`);
}

async function merchant(): Promise<TestMerchant> {
  return createTestMerchant(database.ownerPool);
}

/** A payment with a succeeded authorization and matching outcome — the base for pointer and refund tests. */
async function consistentAuthorized(
  client: pg.ClientBase,
  m: TestMerchant,
  amount = 10_000n,
): Promise<{ paymentId: string; authorizeId: string }> {
  const paymentId = await fixtureInsertPayment(client, m, { requestedAmountMinor: amount });
  const authorizeId = await fixtureInsertOperation(client, m, paymentId, {
    type: 'AUTHORIZE',
    amountMinor: amount,
    status: 'SUCCEEDED',
  });
  await fixtureUpdatePayment(client, paymentId, {
    authorized_amount_minor: amount,
    authorization_outcome: 'AUTHORIZED',
  });
  return { paymentId, authorizeId };
}

describe('exclusive pointer', () => {
  it('fails when an unresolved exclusive operation exists but the pointer is null', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId } = await consistentAuthorized(client, m);
      await fixtureInsertOperation(client, m, paymentId, { type: 'CAPTURE', amountMinor: 1_000n });
    });
    expectConsistencyFailure(result, 'active_exclusive_operation_id');
  });

  it('commits when the pointer names that operation', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId } = await consistentAuthorized(client, m);
      const captureId = await fixtureInsertOperation(client, m, paymentId, {
        type: 'CAPTURE',
        amountMinor: 1_000n,
      });
      await fixtureUpdatePayment(client, paymentId, { active_exclusive_operation_id: captureId });
      return captureId;
    });
    expect(result.ok).toBe(true);
  });

  it('fails when the pointer names a terminal operation', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId, authorizeId } = await consistentAuthorized(client, m);
      await fixtureUpdatePayment(client, paymentId, { active_exclusive_operation_id: authorizeId });
    });
    expectConsistencyFailure(result, 'active_exclusive_operation_id');
  });

  it('fails when the pointer is cleared while a capture is still PROCESSING', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId } = await consistentAuthorized(client, m);
      const captureId = await fixtureInsertOperation(client, m, paymentId, {
        type: 'CAPTURE',
        amountMinor: 1_000n,
        status: 'PROCESSING',
      });
      await fixtureUpdatePayment(client, paymentId, {
        active_exclusive_operation_id: captureId,
      });
      await fixtureUpdatePayment(client, paymentId, { active_exclusive_operation_id: null });
    });
    expectConsistencyFailure(result, 'active_exclusive_operation_id');
  });
});

describe('refund reservation', () => {
  it('fails when a refund is accepted without growing the reservation', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId, captureId } = await fixtureCapturedPayment(client, m, 10_000n);
      await fixtureInsertOperation(client, m, paymentId, {
        type: 'REFUND',
        amountMinor: 1_000n,
        captureOperationId: captureId,
      });
    });
    expectConsistencyFailure(result, 'reserved_refund_amount_minor');
  });

  it('fails when the payment grows a reservation with no refund row behind it', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId } = await fixtureCapturedPayment(client, m, 10_000n);
      await fixtureUpdatePayment(client, paymentId, {
        reserved_refund_amount_minor: 1_000n,
        unresolved_refund_count: 1,
      });
    });
    expectConsistencyFailure(result, 'reserved_refund_amount_minor');
  });

  it('fails when the count disagrees with the refund rows', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId, captureId } = await fixtureCapturedPayment(client, m, 10_000n);
      await fixtureInsertOperation(client, m, paymentId, {
        type: 'REFUND',
        amountMinor: 1_000n,
        captureOperationId: captureId,
      });
      await fixtureUpdatePayment(client, paymentId, {
        reserved_refund_amount_minor: 1_000n,
        unresolved_refund_count: 2,
      });
    });
    expectConsistencyFailure(result, 'unresolved_refund_count');
  });

  it('fails when an operation-only update releases the refund without releasing the payment', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId, captureId } = await fixtureCapturedPayment(client, m, 10_000n);
      const refundId = await fixtureInsertOperation(client, m, paymentId, {
        type: 'REFUND',
        amountMinor: 1_000n,
        captureOperationId: captureId,
      });
      await fixtureUpdatePayment(client, paymentId, {
        reserved_refund_amount_minor: 1_000n,
        unresolved_refund_count: 1,
      });

      // Reject the refund, but forget to release the reservation.
      await fixtureUpdateOperation(client, refundId, {
        status: 'REJECTED',
        result_code: 'CARD_DECLINED',
        resolution_source: 'API_RESPONSE',
        resolution_evidence_id: 'pev_01ARZ3NDEKTSV4RRFFQ69G5FAA',
        resolved_at: new Date(),
      });
    });
    expectConsistencyFailure(result, 'reserved_refund_amount_minor');
  });

  it('commits a consistent accept-then-resolve sequence', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId, captureId } = await fixtureCapturedPayment(client, m, 1_000n);

      const first = await fixtureInsertOperation(client, m, paymentId, {
        type: 'REFUND',
        amountMinor: 300n,
        captureOperationId: captureId,
      });
      const second = await fixtureInsertOperation(client, m, paymentId, {
        type: 'REFUND',
        amountMinor: 200n,
        captureOperationId: captureId,
      });
      await fixtureUpdatePayment(client, paymentId, {
        reserved_refund_amount_minor: 500n,
        unresolved_refund_count: 2,
      });

      // Resolve the 300 refund: reserved drops to 200 and refunded becomes 300.
      await fixtureUpdateOperation(client, first, {
        status: 'SUCCEEDED',
        // A success must name what the provider did: `payment_operations_success_reference`.
        provider_operation_id: `provider-op-${first}`,
        fee_effect_amount_minor: 90n,
        resolution_source: 'API_RESPONSE',
        resolution_evidence_id: 'pev_01ARZ3NDEKTSV4RRFFQ69G5FAB',
        resolved_at: new Date(),
      });
      await fixtureUpdatePayment(client, paymentId, {
        reserved_refund_amount_minor: 200n,
        unresolved_refund_count: 1,
        refunded_amount_minor: 300n,
      });

      // Reject the 200 refund and release its reservation.
      await fixtureUpdateOperation(client, second, {
        status: 'REJECTED',
        result_code: 'CARD_DECLINED',
        resolution_source: 'API_RESPONSE',
        resolution_evidence_id: 'pev_01ARZ3NDEKTSV4RRFFQ69G5FAC',
        resolved_at: new Date(),
      });
      await fixtureUpdatePayment(client, paymentId, {
        reserved_refund_amount_minor: 0n,
        unresolved_refund_count: 0,
      });

      return paymentId;
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await database.ownerPool.query<{
      reserved: string;
      count: number;
      refunded: string;
    }>(
      `SELECT reserved_refund_amount_minor::text AS reserved, unresolved_refund_count AS count,
              refunded_amount_minor::text AS refunded
         FROM payments.payments WHERE id = $1`,
      [result.value],
    );
    expect(rows[0]).toEqual({ reserved: '0', count: 0, refunded: '300' });
  });
});

describe('confirmed totals', () => {
  it('fails when captured is set with no succeeded capture', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId } = await consistentAuthorized(client, m);
      await fixtureUpdatePayment(client, paymentId, {
        captured_amount_minor: 1_000n,
        voided_amount_minor: 9_000n,
      });
    });
    expectConsistencyFailure(result, 'captured_amount_minor');
  });

  it('fails when refunded does not equal the succeeded refunds', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId, captureId } = await fixtureCapturedPayment(client, m, 10_000n);
      for (const amount of [100n, 200n]) {
        await fixtureInsertOperation(client, m, paymentId, {
          type: 'REFUND',
          amountMinor: amount,
          status: 'SUCCEEDED',
          captureOperationId: captureId,
        });
      }
      await fixtureUpdatePayment(client, paymentId, { refunded_amount_minor: 250n });
    });
    expectConsistencyFailure(result, 'refunded_amount_minor');
  });

  it('fails when the outcome claims AUTHORIZED with no succeeded authorization', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const paymentId = await fixtureInsertPayment(client, m, { requestedAmountMinor: 1_000n });
      await fixtureUpdatePayment(client, paymentId, {
        authorized_amount_minor: 1_000n,
        authorization_outcome: 'AUTHORIZED',
      });
    });
    expectConsistencyFailure(result, 'authorization_outcome');
  });

  it('fails when a succeeded CANCEL exists but the outcome is not CANCELED', async () => {
    const m = await merchant();
    const result = await inTransaction(async (client) => {
      const { paymentId } = await consistentAuthorized(client, m, 1_000n);
      await fixtureInsertOperation(client, m, paymentId, {
        type: 'CANCEL',
        amountMinor: 1_000n,
        status: 'SUCCEEDED',
      });
      await fixtureUpdatePayment(client, paymentId, {
        voided_amount_minor: 1_000n,
      });
    });
    expectConsistencyFailure(result, 'canceled');
  });
});

describe('deferral', () => {
  it('fails at the statement when constraints are set immediate', async () => {
    const m = await merchant();
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const { paymentId } = await consistentAuthorized(client, m);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');

      const error = await client
        .query(
          `INSERT INTO payments.payment_operations
             (id, merchant_id, payment_id, type, amount_minor, provider_account_id,
              provider_account_version, provider_idempotency_key, fee_policy_id, fee_policy_version,
              fee_basis_points, fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode,
              fee_effect_type, fee_effect_amount_minor)
           VALUES ($1, $2, $3, 'CAPTURE', 100, $4, 1, $5, $6, 1, 290, 30, 'HALF_UP', 'PROPORTIONAL',
                   'CHARGE', 30)`,
          [
            'op_01ARZ3NDEKTSV4RRFFQ69G5FAA',
            m.merchantId,
            paymentId,
            m.providerAccountId,
            'flowledger:test:fake-provider:deferral',
            m.feePolicyId,
          ],
        )
        .catch((caught: unknown) => caught);

      expect((error as { code?: string }).code).toBe('23514');
      expect((error as { constraint?: string }).constraint).toBe('payment_aggregate_consistency');
      expect((error as { message?: string }).message).toBe(
        'payment_aggregate_consistency: active_exclusive_operation_id',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('privileges', () => {
  it('denies disabling the trigger to the function owner and to every runtime role', async () => {
    const ownerAttempt = await withRole(
      database.ownerPool,
      'payments_function_owner',
      async (client) => {
        return client.query(
          'ALTER TABLE payments.payments DISABLE TRIGGER payments_aggregate_consistency',
        );
      },
    ).catch((caught: unknown) => caught);
    expect((ownerAttempt as { code?: string }).code).toBe('42501');

    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        const error = await client
          .query(
            'ALTER TABLE payments.payment_operations DISABLE TRIGGER payment_operations_aggregate_consistency',
          )
          .catch((caught: unknown) => caught);
        expect((error as { code?: string }).code, role).toBe('42501');
      } finally {
        client.release();
      }
    }
  });
});
