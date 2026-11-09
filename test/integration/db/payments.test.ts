/**
 * The payment aggregate row.
 *
 * Each negative case runs inside a transaction that is rolled back, and asserts the CHECK raised by the
 * statement itself. That matters because a deferred trigger arrives in P02-T10: asserting the immediate
 * error keeps these tests about the constraint under test rather than about what the deferred pass
 * happens to catch later.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { DomainError, LOGIN_RUNTIME_ROLES, withTransaction } from '@flowledger/database';
import {
  assertConstraintCoverage,
  createTestMerchant,
  disposeTestDatabase,
  fixtureInsertOperation,
  fixtureInsertPayment,
  fixtureUpdatePayment,
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
let other: TestMerchant;

beforeAll(async () => {
  database = await useTestDatabase()();
  merchant = await createTestMerchant(database.ownerPool);
  other = await createTestMerchant(database.ownerPool);
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

async function newPayment(
  over: Record<string, unknown> = {},
  forMerchant: TestMerchant = merchant,
): Promise<string> {
  const client = await database.ownerPool.connect();
  try {
    const id = await fixtureInsertPayment(client, forMerchant, {
      requestedAmountMinor: (over.requestedAmountMinor as bigint | undefined) ?? 10_000n,
    });
    const rest = { ...over };
    delete rest.requestedAmountMinor;
    if (Object.keys(rest).length > 0) {
      await client.query('BEGIN');
      try {
        // The insert is already committed; apply the rest with a version bump in one statement.
        await fixtureUpdatePayment(client, id, rest);
        await client.query('COMMIT');
      } catch (error) {
        // Without this the connection returns to the pool inside an aborted transaction, and the
        // *next* test fails with "current transaction is aborted" for an unrelated reason.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    return id;
  } finally {
    client.release();
  }
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
    await assertConstraintCoverage(database.ownerPool, 'payments.payments', [
      'payments_pkey',
      'payments_id_format',
      'payments_merchant_id_id_key',
      'payments_binding_key',
      'payments_provider_account_fkey',
      'payments_provider_account_version_fkey',
      'payments_fee_policy_fkey',
      'payments_created_by_credential_fkey',
      'payments_currency',
      'payments_merchant_reference_length',
      'payments_payment_method_ciphertext',
      'payments_payment_method_key_version',
      'payments_payment_method_hash',
      'payments_provider_refs_nonempty',
      'payments_requested_amount',
      'payments_totals_nonnegative',
      'payments_authorized_le_requested',
      'payments_captured_le_authorized',
      'payments_refunded_le_captured',
      'payments_voided_le_uncaptured',
      'payments_refund_reservation_bound',
      'payments_reservation_count',
      'payments_exclusive_excludes_refunds',
      'payments_active_operation_format',
      'payments_authorization_outcome',
      'payments_unauthorized_zero',
      'payments_released_authorization',
      'payments_capture_releases_remainder',
      'payments_version_positive',
      'payments_merchant_reference_key',
      // Added by 0250, once operations exist to point at.
      'payments_active_exclusive_operation_fkey',
    ]);
  });
});

describe('monetary checks', () => {
  it.each([
    ['payments_requested_amount', { requestedAmountMinor: 0n }],
    ['payments_requested_amount', { requestedAmountMinor: 1_000_000_000_001n }],
  ])('rejects %s for requested %o', async (constraint, over) => {
    const error = await newPayment(over).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('accepts requested 1 and the maximum', async () => {
    await expect(newPayment({ requestedAmountMinor: 1n })).resolves.toBeTruthy();
    await expect(newPayment({ requestedAmountMinor: 1_000_000_000_000n })).resolves.toBeTruthy();
  });

  /**
   * The reservation CHECK is asserted inside a rolled-back transaction: since migration 0260 a payment
   * cannot commit a reservation that no refund operations back, so the consistent *positive* case now
   * lives in `payment-consistency.test.ts`, where the operations exist.
   */
  it('rejects refunded + reserved exceeding captured', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const id = await fixtureInsertPayment(client, merchant, { requestedAmountMinor: 10_000n });
      await fixtureInsertOperation(client, merchant, id, {
        type: 'AUTHORIZE',
        amountMinor: 10_000n,
        status: 'SUCCEEDED',
      });
      await fixtureInsertOperation(client, merchant, id, {
        type: 'CAPTURE',
        amountMinor: 10_000n,
        status: 'SUCCEEDED',
      });
      await fixtureUpdatePayment(client, id, {
        authorized_amount_minor: 10_000n,
        captured_amount_minor: 10_000n,
        authorization_outcome: 'AUTHORIZED',
      });

      const error = await fixtureUpdatePayment(client, id, {
        reserved_refund_amount_minor: 10_001n,
        unresolved_refund_count: 1,
      }).catch((caught: unknown) => caught);
      await client.query('ROLLBACK');

      expect(['payments_refund_reservation_bound', 'payments_reserved_le_captured']).toContain(
        (error as { constraint?: string }).constraint,
      );
    } finally {
      client.release();
    }
  });

  it('rejects a reservation amount with a zero count', async () => {
    // The payment must be captured first, or the reservation bound fires instead — which would be a
    // correct refusal for the wrong reason.
    const error = await newPayment({
      authorized_amount_minor: 10_000n,
      captured_amount_minor: 10_000n,
      reserved_refund_amount_minor: 100n,
      authorization_outcome: 'AUTHORIZED',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('payments_reservation_count');
  });

  it('rejects an exclusive pointer while a refund is unresolved', async () => {
    const error = await newPayment({
      authorized_amount_minor: 10_000n,
      captured_amount_minor: 10_000n,
      reserved_refund_amount_minor: 100n,
      unresolved_refund_count: 1,
      authorization_outcome: 'AUTHORIZED',
      active_exclusive_operation_id: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'payments_exclusive_excludes_refunds',
    );
  });

  it('rejects CANCELED with a void that is not the whole authorization', async () => {
    const error = await newPayment({
      authorized_amount_minor: 10_000n,
      voided_amount_minor: 5_000n,
      authorization_outcome: 'CANCELED',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('payments_released_authorization');
  });

  it('rejects a capture that does not release the remainder', async () => {
    const error = await newPayment({
      authorized_amount_minor: 10_000n,
      captured_amount_minor: 6_000n,
      voided_amount_minor: 0n,
      authorization_outcome: 'AUTHORIZED',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'payments_capture_releases_remainder',
    );
  });

  it('rejects totals on an unauthorized payment', async () => {
    const error = await newPayment({ authorized_amount_minor: 100n }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { constraint?: string }).constraint).toBe('payments_unauthorized_zero');
  });

  it('rejects voided beyond the uncaptured authorization', async () => {
    const error = await newPayment({
      authorized_amount_minor: 1_000n,
      voided_amount_minor: 1_001n,
      authorization_outcome: 'AUTHORIZED',
    }).catch((caught: unknown) => caught);
    // `voided <= authorized - captured` and `captured + voided = authorized` disagree here; either
    // check may fire and both express the same prohibition.
    expect((error as { code?: string }).code).toBe('23514');
  });
});

describe('bindings', () => {
  /**
   * Exercised on INSERT. On UPDATE the immutability guard rejects a changed binding first, so the
   * foreign keys are only reachable when a row is created pointing at the wrong tenant.
   */
  it.each<[string, string, (merchant: TestMerchant) => string]>([
    ['payments_provider_account_fkey', 'provider_account_id', (m) => m.providerAccountId],
    ['payments_fee_policy_fkey', 'fee_policy_id', (m) => m.feePolicyId],
    ['payments_created_by_credential_fkey', 'created_by_credential_id', (m) => m.credentialId],
  ])('rejects a payment referencing another merchant’s %s', async (constraint, column, pick) => {
    const client = await database.ownerPool.connect();
    try {
      const values: Record<string, unknown> = {
        provider_account_id: merchant.providerAccountId,
        fee_policy_id: merchant.feePolicyId,
        created_by_credential_id: merchant.credentialId,
      };
      values[column] = pick(other);

      const error = await client
        .query(
          `INSERT INTO payments.payments
             (id, merchant_id, payment_method_reference_ciphertext, payment_method_key_version,
              payment_method_reference_hash, provider_account_id, provider_account_version,
              fee_policy_id, fee_policy_version, requested_amount_minor, created_by_credential_id)
           VALUES ($1, $2, '\x01'::bytea, 'test-k1', $3, $4, $5, $6, $7, 10000, $8)`,
          [
            'pay_01ARZ3NDEKTSV4RRFFQ69G5FA' + column.slice(0, 1).toUpperCase(),
            merchant.merchantId,
            Buffer.alloc(32, 1),
            values.provider_account_id,
            merchant.providerAccountVersion,
            values.fee_policy_id,
            merchant.feePolicyVersion,
            values.created_by_credential_id,
          ],
        )
        .catch((caught: unknown) => caught);

      expect((error as { constraint?: string }).constraint).toBe(constraint);
    } finally {
      client.release();
    }
  });
});

describe('immutability', () => {
  it.each<[string, unknown]>([
    ['merchant_reference', 'ref-changed'],
    // Changing the currency would also violate `payments_currency`; the guard runs first, which is
    // why the assertion can name the immutability error rather than the check.
    ['currency', 'EUR'],
    ['provider_account_version', 999],
    ['fee_policy_version', 999],
    ['requested_amount_minor', 9_999n],
  ])('refuses to change %s, even as the owner', async (column, value) => {
    const id = await newPayment();
    const result = await runMapped(
      `UPDATE payments.payments SET ${column} = $1, version = version + 1 WHERE id = $2`,
      [value, id],
    );

    const domain = (result as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column });
  });

  it('refuses to re-point the provider account version at a valid other version', async () => {
    const id = await newPayment();
    const result = await runMapped(
      `UPDATE payments.payments SET provider_account_version = 999, version = version + 1 WHERE id = $1`,
      [id],
    );
    const domain = (result as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column: 'provider_account_version' });
  });

  it('allows a provider reference to be filled once and never rewritten', async () => {
    const id = await newPayment();
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      await fixtureUpdatePayment(client, id, { provider_payment_id: 'pp_1' });
      await client.query('COMMIT');

      await client.query('BEGIN');
      const error = await fixtureUpdatePayment(client, id, { provider_payment_id: 'pp_2' }).catch(
        (caught: unknown) => caught,
      );
      await client.query('ROLLBACK');

      // Raw client, so the error is still the pg one; its message is the domain code.
      expect(String(error)).toContain('IMMUTABLE_FIELD');
      expect(JSON.parse((error as { detail?: string }).detail ?? '{}')).toMatchObject({
        column: 'provider_payment_id',
      });
    } finally {
      client.release();
    }
  });

  it('requires the version to increase by exactly one', async () => {
    const id = await newPayment();
    const result = await runMapped(
      `UPDATE payments.payments SET captured_amount_minor = 0 WHERE id = $1`,
      [id],
    );
    const error = (result as { error?: DomainError }).error as DomainError;
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.detail).toMatchObject({ reason: 'VERSION_NOT_INCREMENTED' });
  });

  it('refuses to delete or truncate', async () => {
    const id = await newPayment();
    const deleted = await runMapped('DELETE FROM payments.payments WHERE id = $1', [id]);
    expect(((deleted as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');

    // `payments.payment_operations` references this table, so PostgreSQL refuses the truncate itself
    // (0A000) before the guard trigger is reached — the stronger, earlier refusal.
    const truncated = await runMapped('TRUNCATE payments.payments');
    expect((truncated as { error?: { code?: string } }).error?.code).toBe('0A000');
  });
});

describe('privileges', () => {
  it('denies every runtime role write access', async () => {
    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        for (const statement of [
          {
            sql: `INSERT INTO payments.payments (id, merchant_id, payment_method_reference_ciphertext,
                    payment_method_key_version, payment_method_reference_hash, provider_account_id,
                    provider_account_version, fee_policy_id, fee_policy_version, requested_amount_minor)
                  VALUES ($1, $2, '\x01'::bytea, 'k', $3, $4, 1, $5, 1, 1)`,
            values: [
              'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA',
              merchant.merchantId,
              Buffer.alloc(32, 1),
              merchant.providerAccountId,
              merchant.feePolicyId,
            ],
          },
          { sql: 'UPDATE payments.payments SET captured_amount_minor = 1', values: [] },
          { sql: 'DELETE FROM payments.payments', values: [] },
          { sql: 'TRUNCATE payments.payments', values: [] },
        ]) {
          const error = await client
            .query(statement.sql, statement.values)
            .catch((caught: unknown) => caught);
          expect((error as { code?: string }).code, `${role}: ${statement.sql.slice(0, 30)}`).toBe(
            '42501',
          );
        }
      } finally {
        client.release();
      }
    }
  });

  it('denies fl_api the payment-method ciphertext', async () => {
    const id = await newPayment();
    const client = await database.poolAs('fl_api').connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchant.merchantId]);
      const error = await client
        .query('SELECT payment_method_reference_ciphertext FROM payments.payments WHERE id = $1', [
          id,
        ])
        .catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe('42501');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('shows fl_api nothing without tenant context and only its own rows with it', async () => {
    const mine = await newPayment();
    // Belongs to the second merchant, so a tenant-scoped read must not see it from the first.
    const otherPayment = await newPayment({}, other);

    const client = await database.poolAs('fl_api').connect();
    try {
      const unset = await client.query('SELECT id FROM payments.payments');
      expect(unset.rowCount).toBe(0);

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [other.merchantId]);
      const scoped = await client.query<{ id: string }>(
        'SELECT id FROM payments.payments WHERE id = ANY($1::text[])',
        [[mine, otherPayment]],
      );
      expect(scoped.rows.map((row) => row.id)).toEqual([otherPayment]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
