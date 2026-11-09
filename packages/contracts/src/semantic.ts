/**
 * Post-schema semantic correlation (schemas/README §Required post-schema semantic
 * correlation validator).
 *
 * JSON Schema checks one message in isolation. These rules compare fields *within* a message
 * — the aggregate a message claims to belong to, the ordering key it will be partitioned by,
 * the totals it reports — and a violation means the message is internally inconsistent. The
 * consumer must not apply it or infer an outcome from it; it follows the DLQ/discrepancy
 * policy.
 *
 * Amounts are compared as `BigInt` of the wire strings. They are already pattern-validated,
 * and JavaScript numbers are forbidden for money (docs/02), so no numeric conversion appears
 * here.
 *
 * Deliberately NOT implemented here, because each needs authoritative database rows and
 * belongs to the phase that owns that state. The phase ID is recorded so a consumer finds the
 * obligation instead of assuming this module covered it:
 *
 * - "An operation ID resolves to the stated payment and merchant" — P05 (execute command,
 *   inbox core), P08 (reconcile command), P09 (projector/dispatcher). Each consumer reloads
 *   the operation scoped by `(merchant_id, payment_id, id)`.
 * - "Provider, provider account, provider payment/operation references, and the provider
 *   idempotency key match the immutable original operation" — P07 (terminal producers), P08
 *   (reconciliation), P09 (provider webhook worker).
 * - "A terminal success amount, currency, and operation type match the original accepted
 *   operation" — P07.
 * - "A capture/refund success references the journal transaction posted with the original
 *   operation's stable posting key" — P07.
 */
import type { RegisteredEnvelope } from './validate.js';

export type SemanticRule =
  | 'SCHEMA_VERSION_MATCHES_TYPE_SUFFIX'
  | 'PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID'
  | 'PAYMENT_ORDERING_KEY_EQUALS_PAYMENT_ID'
  | 'EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION'
  | 'WEBHOOK_DELIVERY_AGGREGATE_ID_EQUALS_DELIVERY_ID'
  | 'WEBHOOK_DELIVERY_ORDERING_KEY_EQUALS_ENDPOINT_ID'
  | 'LEDGER_AGGREGATE_ID_EQUALS_TRANSACTION_ID'
  | 'LEDGER_REFERENCES_MATCH_OPERATION_TYPE'
  | 'LEDGER_DEBITS_EQUAL_CREDITS'
  | 'SETTLEMENT_AGGREGATE_ID_EQUALS_BATCH_ID'
  | 'SETTLEMENT_ORDERING_KEY_EQUALS_MERCHANT_ID'
  | 'SETTLEMENT_AGGREGATE_VERSION_IS_ONE'
  | 'SETTLEMENT_POSTING_KEY_DERIVED'
  | 'RESOLUTION_SOURCE_EQUALS_EVIDENCE_SOURCE'
  | 'RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE'
  | 'TOTALS_SATISFY_PAYMENT_INVARIANTS';

export interface SemanticViolation {
  readonly rule: SemanticRule;
  readonly path: string;
  readonly message: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Minor units as an exact integer; `undefined` when the value is not a wire amount. */
function minorUnits(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d{1,13}$/.test(value)) return undefined;
  return BigInt(value);
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * A settlement batch is created already posted and emits exactly one event, and a ledger
 * transaction is itself the aggregate. Applying payment-style version contiguity to either is
 * a configuration error, so registration must ask before enabling it.
 */
const NON_CONTIGUOUS_EVENTS = new Set<string>([
  'settlement.batch.posted.v1',
  'ledger.transaction.posted.v1',
]);

export function contiguityApplies(kind: 'COMMAND' | 'EVENT', type: string): boolean {
  if (kind === 'COMMAND') return false;
  return !NON_CONTIGUOUS_EVENTS.has(type);
}

export function assertContiguityApplicable(kind: 'COMMAND' | 'EVENT', type: string): void {
  if (!contiguityApplies(kind, type)) {
    throw new Error(`CONTIGUITY_NOT_APPLICABLE: ${type}`);
  }
}

function isTerminalFailureType(type: string): boolean {
  return /\.(rejected|failed)\.v[1-9][0-9]*$/.test(type);
}

/**
 * `totalsAfter` must satisfy docs/03 §Monetary invariants:
 * `authorized <= requested`, `captured <= authorized`, `refunded <= captured`, and
 * `voided <= authorized - captured`.
 */
function totalsViolations(totals: JsonObject, basePath: string): SemanticViolation[] {
  const requested = minorUnits(totals.requestedAmountMinor);
  const authorized = minorUnits(totals.authorizedAmountMinor);
  const captured = minorUnits(totals.capturedAmountMinor);
  const refunded = minorUnits(totals.refundedAmountMinor);
  const voided = minorUnits(totals.voidedAmountMinor);

  // The schema requires all five, so an absent value is a schema failure, not a semantic one.
  if (
    requested === undefined ||
    authorized === undefined ||
    captured === undefined ||
    refunded === undefined ||
    voided === undefined
  ) {
    return [];
  }

  const violations: SemanticViolation[] = [];
  const push = (path: string, message: string): void => {
    violations.push({ rule: 'TOTALS_SATISFY_PAYMENT_INVARIANTS', path, message });
  };

  if (authorized > requested) {
    push(
      `${basePath}/authorizedAmountMinor`,
      `authorized ${authorized} exceeds requested ${requested}`,
    );
  }
  if (captured > authorized) {
    push(
      `${basePath}/capturedAmountMinor`,
      `captured ${captured} exceeds authorized ${authorized}`,
    );
  }
  if (refunded > captured) {
    push(`${basePath}/refundedAmountMinor`, `refunded ${refunded} exceeds captured ${captured}`);
  }
  const voidable = authorized - captured;
  if (voided > voidable) {
    push(
      `${basePath}/voidedAmountMinor`,
      `voided ${voided} exceeds authorized minus captured (${voidable})`,
    );
  }

  return violations;
}

/** A SETTLEMENT posting references only the batch; a CAPTURE/REFUND references the operation. */
function ledgerReferenceViolations(data: JsonObject): SemanticViolation[] {
  const operationType = asString(data.operationType);
  const violations: SemanticViolation[] = [];
  const push = (path: string, message: string): void => {
    violations.push({ rule: 'LEDGER_REFERENCES_MATCH_OPERATION_TYPE', path, message });
  };

  if (operationType === 'SETTLEMENT') {
    if (!hasValue(data.settlementBatchId)) {
      push('/data/settlementBatchId', 'a SETTLEMENT posting must name its batch');
    }
    if (hasValue(data.paymentId)) {
      push('/data/paymentId', 'a SETTLEMENT posting must not reference a payment');
    }
    if (hasValue(data.paymentOperationId)) {
      push('/data/paymentOperationId', 'a SETTLEMENT posting must not reference an operation');
    }
  } else if (operationType === 'CAPTURE' || operationType === 'REFUND') {
    if (hasValue(data.settlementBatchId)) {
      push('/data/settlementBatchId', `a ${operationType} posting must not reference a batch`);
    }
    if (!hasValue(data.paymentId)) {
      push('/data/paymentId', `a ${operationType} posting must name its payment`);
    }
    if (!hasValue(data.paymentOperationId)) {
      push('/data/paymentOperationId', `a ${operationType} posting must name its operation`);
    }
  }

  return violations;
}

export function checkSemantics(envelope: RegisteredEnvelope): SemanticViolation[] {
  const violations: SemanticViolation[] = [];
  const push = (rule: SemanticRule, path: string, message: string): void => {
    violations.push({ rule, path, message });
  };

  const type = envelope.type;
  const data = isObject(envelope.data) ? envelope.data : {};

  const suffix = /\.v([1-9][0-9]*)$/.exec(type)?.[1];
  if (suffix === undefined) {
    push(
      'SCHEMA_VERSION_MATCHES_TYPE_SUFFIX',
      '/type',
      `type "${type}" does not carry a .v<N> suffix`,
    );
  } else if (envelope.schemaVersion !== Number(suffix)) {
    push(
      'SCHEMA_VERSION_MATCHES_TYPE_SUFFIX',
      '/schemaVersion',
      `schemaVersion ${String(envelope.schemaVersion)} does not match the .v${suffix} suffix of "${type}"`,
    );
  }

  if (envelope.aggregateType === 'payment') {
    const paymentId = asString(data.paymentId);
    if (envelope.aggregateId !== paymentId) {
      push(
        'PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID',
        '/aggregateId',
        `aggregateId "${String(envelope.aggregateId)}" is not the message's paymentId "${String(paymentId)}"`,
      );
    }
    if (envelope.orderingKey !== paymentId) {
      push(
        'PAYMENT_ORDERING_KEY_EQUALS_PAYMENT_ID',
        '/orderingKey',
        `orderingKey "${envelope.orderingKey}" is not the message's paymentId "${String(paymentId)}"`,
      );
    }
  }

  if (type === 'payment.operation.execute.v1') {
    if (envelope.aggregateVersion !== data.expectedPaymentVersion) {
      push(
        'EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION',
        '/aggregateVersion',
        `aggregateVersion ${String(envelope.aggregateVersion)} is not the expectedPaymentVersion ${String(data.expectedPaymentVersion)} the command operates on`,
      );
    }
  }

  if (type === 'merchant.webhook.deliver.v1') {
    if (envelope.aggregateId !== asString(data.deliveryId)) {
      push(
        'WEBHOOK_DELIVERY_AGGREGATE_ID_EQUALS_DELIVERY_ID',
        '/aggregateId',
        `aggregateId "${String(envelope.aggregateId)}" is not the deliveryId "${String(data.deliveryId)}"`,
      );
    }
    if (envelope.orderingKey !== asString(data.endpointId)) {
      push(
        'WEBHOOK_DELIVERY_ORDERING_KEY_EQUALS_ENDPOINT_ID',
        '/orderingKey',
        `orderingKey "${envelope.orderingKey}" is not the endpointId "${String(data.endpointId)}"; deliveries are ordered per endpoint (D-06)`,
      );
    }
  }

  if (type === 'ledger.transaction.posted.v1') {
    if (envelope.aggregateId !== asString(data.ledgerTransactionId)) {
      push(
        'LEDGER_AGGREGATE_ID_EQUALS_TRANSACTION_ID',
        '/aggregateId',
        `aggregateId "${String(envelope.aggregateId)}" is not the ledgerTransactionId "${String(data.ledgerTransactionId)}"`,
      );
    }
    violations.push(...ledgerReferenceViolations(data));

    const debits = minorUnits(data.totalDebitsMinor);
    const credits = minorUnits(data.totalCreditsMinor);
    if (debits !== undefined && credits !== undefined && debits !== credits) {
      push(
        'LEDGER_DEBITS_EQUAL_CREDITS',
        '/data/totalCreditsMinor',
        `debits ${debits} do not equal credits ${credits}`,
      );
    }
  }

  if (type === 'settlement.batch.posted.v1') {
    const batchId = asString(data.settlementBatchId);
    if (envelope.aggregateId !== batchId) {
      push(
        'SETTLEMENT_AGGREGATE_ID_EQUALS_BATCH_ID',
        '/aggregateId',
        `aggregateId "${String(envelope.aggregateId)}" is not the settlementBatchId "${String(batchId)}"`,
      );
    }
    if (envelope.orderingKey !== envelope.merchantId) {
      push(
        'SETTLEMENT_ORDERING_KEY_EQUALS_MERCHANT_ID',
        '/orderingKey',
        `orderingKey "${envelope.orderingKey}" is not the merchantId "${String(envelope.merchantId)}"`,
      );
    }
    if (envelope.aggregateVersion !== 1) {
      push(
        'SETTLEMENT_AGGREGATE_VERSION_IS_ONE',
        '/aggregateVersion',
        `a settlement batch is created posted, so aggregateVersion must be 1, not ${String(envelope.aggregateVersion)}`,
      );
    }
    if (data.postingKey !== `settlement:${String(batchId)}`) {
      push(
        'SETTLEMENT_POSTING_KEY_DERIVED',
        '/data/postingKey',
        `postingKey "${String(data.postingKey)}" is not "settlement:${String(batchId)}"`,
      );
    }
  }

  const evidence = isObject(data.evidence) ? data.evidence : undefined;
  const resolutionSource = asString(data.resolutionSource);
  const evidenceSource = evidence === undefined ? undefined : asString(evidence.source);
  if (resolutionSource !== undefined && evidenceSource !== undefined) {
    if (resolutionSource !== evidenceSource) {
      push(
        'RESOLUTION_SOURCE_EQUALS_EVIDENCE_SOURCE',
        '/data/resolutionSource',
        `resolutionSource "${resolutionSource}" is not the evidence source "${evidenceSource}"`,
      );
    }
  }

  if (isTerminalFailureType(type)) {
    const normalizedError = isObject(data.normalizedError) ? data.normalizedError : undefined;
    const resultCode = asString(data.resultCode);
    const errorCode = normalizedError === undefined ? undefined : asString(normalizedError.code);
    if (resultCode !== undefined && errorCode !== undefined && resultCode !== errorCode) {
      push(
        'RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE',
        '/data/resultCode',
        `resultCode "${resultCode}" is not the normalized error code "${errorCode}"`,
      );
    }
  }

  const totalsAfter = isObject(data.totalsAfter) ? data.totalsAfter : undefined;
  if (totalsAfter !== undefined) {
    violations.push(...totalsViolations(totalsAfter, '/data/totalsAfter'));
  }

  return violations;
}

/**
 * The merchant payload carries `data.totals` rather than `totalsAfter`. It reports the same
 * confirmed totals, so the same invariants apply — a payload whose numbers cannot coexist is
 * as wrong as an inconsistent event.
 */
export function checkMerchantWebhookSemantics(
  payload: Record<string, unknown>,
): SemanticViolation[] {
  const data = isObject(payload.data) ? payload.data : {};
  const totals = isObject(data.totals) ? data.totals : undefined;
  return totals === undefined ? [] : totalsViolations(totals, '/data/totals');
}
