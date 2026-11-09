/**
 * Payment fixtures (owner role).
 *
 * Named `fixture*` on purpose: these write as the table owner, which is what makes them a *fixture*
 * rather than application code reaching around a guard (docs/10 §Financial safety). Real mutations go
 * through the protected functions; a test that needs a row in an arbitrary state gets it here.
 */
import { createHash } from 'node:crypto';

import type pg from 'pg';

import { newId } from '@flowledger/domain';

import type { TestMerchant } from './merchant.js';

export interface FixturePaymentOptions {
  readonly id?: string;
  readonly requestedAmountMinor?: bigint;
  readonly merchantReference?: string | null;
}

export async function fixtureInsertPayment(
  client: pg.ClientBase,
  merchant: TestMerchant,
  options: FixturePaymentOptions = {},
): Promise<string> {
  const id = options.id ?? newId('pay');

  await client.query(
    `INSERT INTO payments.payments
       (id, merchant_id, merchant_reference, payment_method_reference_ciphertext,
        payment_method_key_version, payment_method_reference_hash, provider_account_id,
        provider_account_version, fee_policy_id, fee_policy_version, requested_amount_minor,
        created_by_credential_id)
     VALUES ($1, $2, $3, $4, 'test-k1', $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      merchant.merchantId,
      options.merchantReference ?? null,
      Buffer.from([0x01]),
      createHash('sha256').update(id, 'utf8').digest(),
      merchant.providerAccountId,
      merchant.providerAccountVersion,
      merchant.feePolicyId,
      merchant.feePolicyVersion,
      (options.requestedAmountMinor ?? 10_000n).toString(),
      merchant.credentialId,
    ],
  );

  return id;
}

/**
 * Updates a payment as the owner, incrementing `version` for the caller.
 *
 * The guard requires `version = old + 1`, so every fixture update has to do this; centralising it here
 * keeps the tests about the column under test rather than about version bookkeeping.
 */
export async function fixtureUpdatePayment(
  client: pg.ClientBase,
  paymentId: string,
  set: Readonly<Record<string, unknown>>,
): Promise<void> {
  const columns = Object.keys(set);
  const assignments = columns.map((column, index) => `${column} = $${String(index + 1)}`);
  assignments.push('version = version + 1');

  await client.query(
    `UPDATE payments.payments SET ${assignments.join(', ')} WHERE id = $${String(columns.length + 1)}`,
    [...columns.map((column) => set[column]), paymentId],
  );
}

export type FixtureOperationType = 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';

const TERMINAL = new Set(['SUCCEEDED', 'REJECTED', 'FAILED']);

export interface FixtureOperationOptions {
  readonly id?: string;
  readonly status?: string;
  readonly captureOperationId?: string;
  readonly feeEffectAmountMinor?: bigint | null;
  readonly feeEffectType?: string;
  readonly providerOperationId?: string | null;
  readonly resultCode?: string | null;
  readonly notBefore?: Date | null;
  readonly providerAccountVersion?: number;
}

/**
 * Inserts an operation row in whatever state a test needs.
 *
 * Terminal statuses fill the columns the CHECKs require (`resolved_at`, evidence, source, and a
 * provider reference or result code) so a test that is about, say, the capture-fee bound does not fail
 * for a missing resolution first.
 */
export async function fixtureInsertOperation(
  client: pg.ClientBase,
  merchant: TestMerchant,
  paymentId: string,
  operation: { type: FixtureOperationType; amountMinor: bigint } & FixtureOperationOptions,
): Promise<string> {
  const id = operation.id ?? newId('op');
  const status = operation.status ?? 'REQUESTED';
  const terminal = TERMINAL.has(status);
  const usesFeeSnapshot = operation.type === 'CAPTURE' || operation.type === 'REFUND';

  const feeEffectType =
    operation.feeEffectType ??
    (operation.type === 'CAPTURE' ? 'CHARGE' : operation.type === 'REFUND' ? 'REFUND' : 'NONE');

  const defaultFee =
    operation.type === 'CAPTURE'
      ? 30n
      : operation.type === 'REFUND' && status === 'SUCCEEDED'
        ? 30n
        : null;
  const feeEffectAmount =
    operation.feeEffectAmountMinor === undefined ? defaultFee : operation.feeEffectAmountMinor;

  const providerOperationId =
    operation.providerOperationId === undefined
      ? status === 'SUCCEEDED'
        ? `provider-op-${id}`
        : null
      : operation.providerOperationId;

  const resultCode =
    operation.resultCode === undefined
      ? status === 'REJECTED' || status === 'FAILED'
        ? 'CARD_DECLINED'
        : null
      : operation.resultCode;

  await client.query(
    `INSERT INTO payments.payment_operations
       (id, merchant_id, payment_id, type, amount_minor, status, provider_account_id,
        provider_account_version, provider_idempotency_key, provider_operation_id, capture_operation_id,
        fee_policy_id, fee_policy_version, fee_basis_points, fee_fixed_amount_minor,
        fee_capture_rounding_mode, fee_refund_mode, fee_effect_type, fee_effect_amount_minor,
        result_code, resolution_source, resolution_evidence_id, not_before, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19,
             $20, $21, $22, $23, $24)`,
    [
      id,
      merchant.merchantId,
      paymentId,
      operation.type,
      operation.amountMinor.toString(),
      status,
      merchant.providerAccountId,
      operation.providerAccountVersion ?? merchant.providerAccountVersion,
      `flowledger:test:fake-provider:${id}`,
      providerOperationId,
      operation.captureOperationId ?? null,
      usesFeeSnapshot ? merchant.feePolicyId : null,
      usesFeeSnapshot ? merchant.feePolicyVersion : null,
      usesFeeSnapshot ? 290 : null,
      usesFeeSnapshot ? 30n.toString() : null,
      usesFeeSnapshot ? 'HALF_UP' : null,
      usesFeeSnapshot ? 'PROPORTIONAL' : null,
      feeEffectType,
      feeEffectAmount === null ? null : feeEffectAmount.toString(),
      resultCode,
      terminal ? 'API_RESPONSE' : null,
      terminal ? newId('pev') : null,
      operation.notBefore ?? null,
      terminal ? new Date() : null,
    ],
  );

  return id;
}

/** Updates an operation as the owner, incrementing `version` as the guard requires. */
export async function fixtureUpdateOperation(
  client: pg.ClientBase,
  operationId: string,
  set: Readonly<Record<string, unknown>>,
): Promise<void> {
  const columns = Object.keys(set);
  const assignments = columns.map((column, index) => `${column} = $${String(index + 1)}`);
  assignments.push('version = version + 1');

  await client.query(
    `UPDATE payments.payment_operations SET ${assignments.join(', ')} WHERE id = $${String(columns.length + 1)}`,
    [...columns.map((column) => set[column]), operationId],
  );
}

/**
 * Recomputes a payment's aggregate fields from its operation rows.
 *
 * Since migration 0260 the deferred trigger requires the two to agree at commit, so any fixture that
 * inserts an operation must update the payment in the same transaction. Deriving the fields from the
 * rows keeps every fixture consistent by construction rather than by hand-arithmetic.
 */
export async function fixtureSyncPayment(client: pg.ClientBase, paymentId: string): Promise<void> {
  await client.query(
    `UPDATE payments.payments p SET
       active_exclusive_operation_id = (
         SELECT o.id FROM payments.payment_operations o
          WHERE o.payment_id = p.id AND o.type IN ('AUTHORIZE', 'CAPTURE', 'CANCEL')
            AND o.status IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW')
       ),
       reserved_refund_amount_minor = (
         SELECT coalesce(sum(o.amount_minor), 0) FROM payments.payment_operations o
          WHERE o.payment_id = p.id AND o.type = 'REFUND'
            AND o.status IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW')
       ),
       unresolved_refund_count = (
         SELECT count(*) FROM payments.payment_operations o
          WHERE o.payment_id = p.id AND o.type = 'REFUND'
            AND o.status IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW')
       ),
       captured_amount_minor = (
         SELECT coalesce(max(o.amount_minor), 0) FROM payments.payment_operations o
          WHERE o.payment_id = p.id AND o.type = 'CAPTURE' AND o.status = 'SUCCEEDED'
       ),
       refunded_amount_minor = (
         SELECT coalesce(sum(o.amount_minor), 0) FROM payments.payment_operations o
          WHERE o.payment_id = p.id AND o.type = 'REFUND' AND o.status = 'SUCCEEDED'
       ),
       authorized_amount_minor = coalesce((
         SELECT max(o.amount_minor) FROM payments.payment_operations o
          WHERE o.payment_id = p.id AND o.type = 'AUTHORIZE' AND o.status = 'SUCCEEDED'
       ), 0),
       voided_amount_minor = CASE
         WHEN EXISTS (
           SELECT 1 FROM payments.payment_operations o
            WHERE o.payment_id = p.id AND o.type = 'CANCEL' AND o.status = 'SUCCEEDED'
         ) THEN coalesce((
           SELECT max(o.amount_minor) FROM payments.payment_operations o
            WHERE o.payment_id = p.id AND o.type = 'AUTHORIZE' AND o.status = 'SUCCEEDED'
         ), 0)
         ELSE p.voided_amount_minor
       END,
       authorization_outcome = CASE
         WHEN EXISTS (
           SELECT 1 FROM payments.payment_operations o
            WHERE o.payment_id = p.id AND o.type = 'CANCEL' AND o.status = 'SUCCEEDED'
         ) THEN 'CANCELED'
         WHEN EXISTS (
           SELECT 1 FROM payments.payment_operations o
            WHERE o.payment_id = p.id AND o.type = 'AUTHORIZE' AND o.status = 'SUCCEEDED'
         ) THEN 'AUTHORIZED'
         ELSE 'NOT_REQUESTED'
       END,
       version = p.version + 1
     WHERE p.id = $1`,
    [paymentId],
  );
}

/**
 * A payment with a succeeded AUTHORIZE and a succeeded CAPTURE, in an internally consistent state:
 * `authorized = captured = amountMinor`, capture released no remainder, and the pointer cleared.
 */
export async function fixtureCapturedPayment(
  client: pg.ClientBase,
  merchant: TestMerchant,
  amountMinor: bigint,
): Promise<{ paymentId: string; authorizeId: string; captureId: string }> {
  const paymentId = await fixtureInsertPayment(client, merchant, {
    requestedAmountMinor: amountMinor,
  });
  const authorizeId = await fixtureInsertOperation(client, merchant, paymentId, {
    type: 'AUTHORIZE',
    amountMinor,
    status: 'SUCCEEDED',
  });
  const captureId = await fixtureInsertOperation(client, merchant, paymentId, {
    type: 'CAPTURE',
    amountMinor,
    status: 'SUCCEEDED',
  });

  // A capture releases the remainder, so the payment must also record it before the aggregates sync.
  await fixtureUpdatePayment(client, paymentId, {
    authorized_amount_minor: amountMinor,
    captured_amount_minor: amountMinor,
    authorization_outcome: 'AUTHORIZED',
  });
  await fixtureSyncPayment(client, paymentId);

  return { paymentId, authorizeId, captureId };
}
