/**
 * Payment and operation read repository.
 *
 * Every query carries an explicit `merchant_id` predicate. RLS is defence in depth, not the mechanism:
 * a query that relied on it would silently return another tenant's row the moment its policy changed,
 * and would return *nothing* for an owner connection. The predicate is therefore part of the query, and
 * a caller that passes the wrong merchant gets null rather than a stranger's payment.
 *
 * Columns are listed explicitly. `SELECT *` would start returning the ciphertext columns the moment
 * someone adds one, and those must never leave the database on a read path that is not the provider
 * adapter.
 */
import type pg from 'pg';

export interface PaymentRow {
  readonly id: string;
  readonly merchantId: string;
  readonly currency: 'USD';
  readonly providerAccountId: string;
  readonly providerAccountVersion: number;
  readonly feePolicyId: string;
  readonly feePolicyVersion: number;
  readonly requestedAmountMinor: bigint;
  readonly authorizedAmountMinor: bigint;
  readonly capturedAmountMinor: bigint;
  readonly refundedAmountMinor: bigint;
  readonly voidedAmountMinor: bigint;
  readonly reservedRefundAmountMinor: bigint;
  readonly unresolvedRefundCount: number;
  readonly authorizationOutcome: string;
  readonly activeExclusiveOperationId: string | null;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OperationRow {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly type: string;
  readonly amountMinor: bigint;
  readonly currency: 'USD';
  readonly status: string;
  readonly providerOperationId: string | null;
  readonly feePolicyVersion: number | null;
  readonly feeEffectAmountMinor: bigint | null;
  readonly resultCode: string | null;
  readonly notBefore: Date | null;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

const PAYMENT_COLUMNS = `id, merchant_id, currency, provider_account_id, provider_account_version,
  fee_policy_id, fee_policy_version, requested_amount_minor, authorized_amount_minor,
  captured_amount_minor, refunded_amount_minor, voided_amount_minor, reserved_refund_amount_minor,
  unresolved_refund_count, authorization_outcome, active_exclusive_operation_id, version, created_at,
  updated_at`;

const OPERATION_COLUMNS = `id, merchant_id, payment_id, type, amount_minor, currency, status,
  provider_operation_id, fee_policy_version, fee_effect_amount_minor, result_code, not_before, version,
  created_at, resolved_at`;

interface PaymentRowShape {
  id: string;
  merchant_id: string;
  currency: 'USD';
  provider_account_id: string;
  provider_account_version: number;
  fee_policy_id: string;
  fee_policy_version: number;
  requested_amount_minor: string;
  authorized_amount_minor: string;
  captured_amount_minor: string;
  refunded_amount_minor: string;
  voided_amount_minor: string;
  reserved_refund_amount_minor: string;
  unresolved_refund_count: number;
  authorization_outcome: string;
  active_exclusive_operation_id: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
}

interface OperationRowShape {
  id: string;
  merchant_id: string;
  payment_id: string;
  type: string;
  amount_minor: string;
  currency: 'USD';
  status: string;
  provider_operation_id: string | null;
  fee_policy_version: number | null;
  fee_effect_amount_minor: string | null;
  result_code: string | null;
  not_before: Date | null;
  version: string;
  created_at: Date;
  resolved_at: Date | null;
}

/**
 * Money leaves the database as text and is converted to `bigint` here (docs/02: a JavaScript number is
 * forbidden for money), so no caller ever handles an amount as a float.
 */
function toPayment(row: PaymentRowShape): PaymentRow {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    currency: row.currency,
    providerAccountId: row.provider_account_id,
    providerAccountVersion: row.provider_account_version,
    feePolicyId: row.fee_policy_id,
    feePolicyVersion: row.fee_policy_version,
    requestedAmountMinor: BigInt(row.requested_amount_minor),
    authorizedAmountMinor: BigInt(row.authorized_amount_minor),
    capturedAmountMinor: BigInt(row.captured_amount_minor),
    refundedAmountMinor: BigInt(row.refunded_amount_minor),
    voidedAmountMinor: BigInt(row.voided_amount_minor),
    reservedRefundAmountMinor: BigInt(row.reserved_refund_amount_minor),
    unresolvedRefundCount: row.unresolved_refund_count,
    authorizationOutcome: row.authorization_outcome,
    activeExclusiveOperationId: row.active_exclusive_operation_id,
    version: BigInt(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOperation(row: OperationRowShape): OperationRow {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentId: row.payment_id,
    type: row.type,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    status: row.status,
    providerOperationId: row.provider_operation_id,
    feePolicyVersion: row.fee_policy_version,
    feeEffectAmountMinor:
      row.fee_effect_amount_minor === null ? null : BigInt(row.fee_effect_amount_minor),
    resultCode: row.result_code,
    notBefore: row.not_before,
    version: BigInt(row.version),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function findPayment(
  client: pg.ClientBase,
  merchantId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  const { rows } = await client.query<PaymentRowShape>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments.payments WHERE merchant_id = $1 AND id = $2`,
    [merchantId, paymentId],
  );
  const row = rows[0];
  return row === undefined ? null : toPayment(row);
}

export async function findOperation(
  client: pg.ClientBase,
  merchantId: string,
  operationId: string,
): Promise<OperationRow | null> {
  const { rows } = await client.query<OperationRowShape>(
    `SELECT ${OPERATION_COLUMNS} FROM payments.payment_operations WHERE merchant_id = $1 AND id = $2`,
    [merchantId, operationId],
  );
  const row = rows[0];
  return row === undefined ? null : toOperation(row);
}
