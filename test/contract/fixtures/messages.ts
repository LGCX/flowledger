/**
 * One schema-valid positive fixture per registered message type.
 *
 * These are the inputs every later phase builds on — the semantic validator (P00-T11), the
 * PostgreSQL JSONB round-trip tests, and the publish/subscribe contract tests all start
 * here — so each fixture also satisfies the correlational rules the schema cannot express:
 * a payment message's `aggregateId`/`orderingKey` equals `data.paymentId`, an execute
 * command's `aggregateVersion` equals its `expectedPaymentVersion`, `resolutionSource`
 * equals `evidence.source`, and a terminal rejection or failure's `resultCode` equals
 * `normalizedError.code`. A fixture that only satisfied the schema would move the failure
 * into P00-T11 and make this suite's "valid" claim misleading.
 *
 * All identifiers are valid Crockford base32 ULIDs with a first character in `0-7`, so the
 * same values exercise the `[0-7]` overflow boundary rather than sitting inside it.
 */
import type { MessageType } from '@flowledger/contracts';

type Message = Record<string, unknown>;

export const MER = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ';
export const PAY = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const OP = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX';
export const PACC = 'pacc_01ARZ3NDEKTSV4RRFFQ69G5FAY';
export const PAT = 'pat_01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const LTX = 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FA0';
export const CASE = 'case_01ARZ3NDEKTSV4RRFFQ69G5FA2';
export const WHD = 'whd_01ARZ3NDEKTSV4RRFFQ69G5FAS';
export const WHE = 'whe_01ARZ3NDEKTSV4RRFFQ69G5FA3';
export const SRN = 'srn_01ARZ3NDEKTSV4RRFFQ69G5FA4';
export const SBT = 'sbt_01ARZ3NDEKTSV4RRFFQ69G5FB5';

export const ENVELOPE_ID = '0192f4e7-8b30-7c83-b462-c0d5fe8f132a';
export const CORRELATION = 'cor_01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const TIMESTAMP = '2026-11-05T18:44:31.123Z';
export const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
export const PROVIDER = 'fake-provider';
export const IDEMPOTENCY_KEY = `flowledger:test:${PROVIDER}:${OP}`;
export const EVIDENCE_REF = 'pev_01ARZ3NDEKTSV4RRFFQ69G5FA1';

function money(amountMinor: string): Message {
  return { amountMinor, currency: 'USD' };
}

function totals(over: Partial<Record<string, string>> = {}): Message {
  return {
    requestedAmountMinor: '10000',
    authorizedAmountMinor: '0',
    capturedAmountMinor: '0',
    refundedAmountMinor: '0',
    voidedAmountMinor: '0',
    currency: 'USD',
    ...over,
  };
}

function evidence(source: string): Message {
  return {
    source,
    providerObservedAt: TIMESTAMP,
    receivedAt: TIMESTAMP,
    providerEventId: null,
    redactedEvidenceRef: EVIDENCE_REF,
  };
}

function normalizedError(code: string): Message {
  return {
    category: 'BUSINESS_DECLINE',
    code,
    retryDirective: 'DO_NOT_RETRY',
    retryAfterMs: null,
    safeMessage: 'The provider declined the operation.',
  };
}

interface EnvelopeOptions {
  kind: 'COMMAND' | 'EVENT';
  type: MessageType;
  source: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  orderingKey?: string;
  causationId?: string;
  data: Message;
}

function envelope(options: EnvelopeOptions): Message {
  return {
    id: ENVELOPE_ID,
    kind: options.kind,
    type: options.type,
    schemaVersion: 1,
    source: options.source,
    occurredAt: TIMESTAMP,
    recordedAt: TIMESTAMP,
    merchantId: MER,
    aggregateType: options.aggregateType,
    aggregateId: options.aggregateId,
    aggregateVersion: options.aggregateVersion ?? 5,
    orderingKey: options.orderingKey ?? options.aggregateId,
    correlationId: CORRELATION,
    causationId: options.causationId ?? OP,
    traceparent: TRACEPARENT,
    data: options.data,
  };
}

/** A payment-scoped event whose aggregate and ordering key are the payment ID. */
function paymentEvent(type: MessageType, data: Message, aggregateVersion = 5): Message {
  return envelope({
    kind: 'EVENT',
    type,
    source: 'flowledger.payment',
    aggregateType: 'payment',
    aggregateId: PAY,
    aggregateVersion,
    data: { paymentId: PAY, ...data },
  });
}

interface TerminalOptions {
  type: MessageType;
  outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED';
  operationType: 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';
  amountMinor: string;
  totalsAfter: Message;
  resolutionSource?: string;
  resultCode?: string | null;
  normalizedError?: Message | null;
  noEffectProof?: Message | null;
  ledgerTransactionId?: string | null;
  feeAmountMinor?: string;
  feeReversalAmountMinor?: string;
}

/** A terminal operation event; the caller supplies the outcome-specific fields. */
function terminal(options: TerminalOptions): Message {
  const data: Message = {
    operationId: OP,
    paymentId: PAY,
    operationType: options.operationType,
    outcome: options.outcome,
    provider: PROVIDER,
    providerAccountId: PACC,
    providerIdempotencyKey: IDEMPOTENCY_KEY,
    providerPaymentId: 'provider_payment_123',
    providerOperationId: 'provider_operation_123',
    providerAuthorizationId: 'provider_authorization_123',
    amount: money(options.amountMinor),
    totalsAfter: options.totalsAfter,
    resolutionSource: options.resolutionSource ?? 'API_RESPONSE',
    resultCode: options.resultCode ?? null,
    ledgerTransactionId: options.ledgerTransactionId ?? null,
    evidence: evidence(options.resolutionSource ?? 'API_RESPONSE'),
    normalizedError: options.normalizedError ?? null,
    noEffectProof: options.noEffectProof ?? null,
  };
  if (options.feeAmountMinor !== undefined) data.feeAmountMinor = options.feeAmountMinor;
  if (options.feeReversalAmountMinor !== undefined) {
    data.feeReversalAmountMinor = options.feeReversalAmountMinor;
  }
  return paymentEvent(options.type, data);
}

const AUTHORIZED = totals({ authorizedAmountMinor: '10000' });
const CAPTURED = totals({ authorizedAmountMinor: '10000', capturedAmountMinor: '10000' });
const VOIDED = totals({ authorizedAmountMinor: '10000', voidedAmountMinor: '10000' });
const REFUNDED = totals({
  authorizedAmountMinor: '10000',
  capturedAmountMinor: '10000',
  refundedAmountMinor: '3000',
});

const DECLINED = 'card_declined';
const TIMEOUT = 'provider_timeout';

/** The docs/04 §Capture event example, reproduced exactly. */
const CAPTURE_SUCCEEDED: Message = {
  id: ENVELOPE_ID,
  kind: 'EVENT',
  type: 'payment.capture.succeeded.v1',
  schemaVersion: 1,
  source: 'flowledger.payment',
  occurredAt: TIMESTAMP,
  recordedAt: '2026-11-05T18:44:31.130Z',
  merchantId: MER,
  aggregateType: 'payment',
  aggregateId: PAY,
  aggregateVersion: 5,
  orderingKey: PAY,
  correlationId: CORRELATION,
  causationId: OP,
  traceparent: TRACEPARENT,
  data: {
    operationId: OP,
    paymentId: PAY,
    operationType: 'CAPTURE',
    outcome: 'SUCCEEDED',
    provider: PROVIDER,
    providerAccountId: PACC,
    providerIdempotencyKey: IDEMPOTENCY_KEY,
    providerPaymentId: 'provider_payment_123',
    providerOperationId: 'provider_capture_123',
    amount: money('10000'),
    totalsAfter: CAPTURED,
    resolutionSource: 'API_RESPONSE',
    resultCode: null,
    ledgerTransactionId: LTX,
    evidence: evidence('API_RESPONSE'),
    normalizedError: null,
    noEffectProof: null,
    feeAmountMinor: '300',
  },
};

export const validMessages: Readonly<Record<MessageType, Message>> = {
  'payment.operation.execute.v1': envelope({
    kind: 'COMMAND',
    type: 'payment.operation.execute.v1',
    source: 'flowledger.payment',
    aggregateType: 'payment',
    aggregateId: PAY,
    // The execute command's aggregateVersion must equal the version it expects to operate on.
    aggregateVersion: 5,
    causationId: ENVELOPE_ID,
    data: {
      operationId: OP,
      paymentId: PAY,
      provider: PROVIDER,
      expectedPaymentVersion: 5,
    },
  }),

  'payment.operation.reconcile.v1': envelope({
    kind: 'COMMAND',
    type: 'payment.operation.reconcile.v1',
    source: 'flowledger.payment',
    aggregateType: 'payment',
    aggregateId: PAY,
    causationId: ENVELOPE_ID,
    data: {
      operationId: OP,
      paymentId: PAY,
      reason: 'AMBIGUOUS_RESPONSE',
      notBefore: TIMESTAMP,
      reconciliationAttempt: 1,
    },
  }),

  'merchant.webhook.deliver.v1': envelope({
    kind: 'COMMAND',
    type: 'merchant.webhook.deliver.v1',
    source: 'flowledger.webhook',
    aggregateType: 'webhook_delivery',
    aggregateId: WHD,
    aggregateVersion: 1,
    // The ordering key is the endpoint, not the delivery: deliveries to one endpoint are
    // ordered, while a delivery and the event that caused it are not.
    orderingKey: WHE,
    causationId: ENVELOPE_ID,
    data: { deliveryId: WHD, endpointId: WHE, domainEventId: ENVELOPE_ID },
  }),

  'payment.created.v1': envelope({
    kind: 'EVENT',
    type: 'payment.created.v1',
    source: 'flowledger.payment',
    aggregateType: 'payment',
    aggregateId: PAY,
    aggregateVersion: 1,
    data: {
      paymentId: PAY,
      requestedAmount: money('10000'),
      provider: PROVIDER,
      providerAccountId: PACC,
      feePolicyVersion: 1,
    },
  }),

  'payment.authorization.requested.v1': paymentEvent('payment.authorization.requested.v1', {
    operationId: OP,
    operationType: 'AUTHORIZE',
    amount: money('10000'),
    provider: PROVIDER,
    providerAccountId: PACC,
    providerIdempotencyKey: IDEMPOTENCY_KEY,
  }),

  'payment.capture.requested.v1': paymentEvent('payment.capture.requested.v1', {
    operationId: OP,
    operationType: 'CAPTURE',
    amount: money('10000'),
    provider: PROVIDER,
    providerAccountId: PACC,
    providerIdempotencyKey: IDEMPOTENCY_KEY,
    // Capture is the only requested type that carries the fee it will charge.
    feePolicyVersion: 1,
    feeAmountMinor: '300',
  }),

  'payment.authorization.cancellation.requested.v1': paymentEvent(
    'payment.authorization.cancellation.requested.v1',
    {
      operationId: OP,
      operationType: 'CANCEL',
      amount: money('10000'),
      provider: PROVIDER,
      providerAccountId: PACC,
      providerIdempotencyKey: IDEMPOTENCY_KEY,
    },
  ),

  'payment.refund.requested.v1': paymentEvent('payment.refund.requested.v1', {
    operationId: OP,
    operationType: 'REFUND',
    amount: money('3000'),
    provider: PROVIDER,
    providerAccountId: PACC,
    providerIdempotencyKey: IDEMPOTENCY_KEY,
  }),

  'payment.authorization.succeeded.v1': terminal({
    type: 'payment.authorization.succeeded.v1',
    outcome: 'SUCCEEDED',
    operationType: 'AUTHORIZE',
    amountMinor: '10000',
    totalsAfter: AUTHORIZED,
    ledgerTransactionId: null,
  }),

  'payment.authorization.rejected.v1': terminal({
    type: 'payment.authorization.rejected.v1',
    outcome: 'REJECTED',
    operationType: 'AUTHORIZE',
    amountMinor: '10000',
    totalsAfter: totals(),
    resultCode: DECLINED,
    normalizedError: normalizedError(DECLINED),
  }),

  'payment.authorization.failed.v1': terminal({
    type: 'payment.authorization.failed.v1',
    outcome: 'FAILED',
    operationType: 'AUTHORIZE',
    amountMinor: '10000',
    totalsAfter: totals(),
    resultCode: TIMEOUT,
    normalizedError: normalizedError(TIMEOUT),
    noEffectProof: { kind: 'AUTHENTICATED_PROVIDER_REJECTION', providerCode: 'card_not_charged' },
  }),

  'payment.authorization.expired.v1': paymentEvent('payment.authorization.expired.v1', {
    operationId: OP,
    provider: PROVIDER,
    providerAccountId: PACC,
    providerPaymentId: 'provider_payment_123',
    providerAuthorizationId: 'provider_authorization_123',
    totalsAfter: totals(),
    resolutionSource: 'PROVIDER_WEBHOOK',
    evidence: evidence('PROVIDER_WEBHOOK'),
  }),

  'payment.capture.succeeded.v1': CAPTURE_SUCCEEDED,

  'payment.capture.rejected.v1': terminal({
    type: 'payment.capture.rejected.v1',
    outcome: 'REJECTED',
    operationType: 'CAPTURE',
    amountMinor: '10000',
    totalsAfter: AUTHORIZED,
    resultCode: DECLINED,
    normalizedError: normalizedError(DECLINED),
  }),

  'payment.capture.failed.v1': terminal({
    type: 'payment.capture.failed.v1',
    outcome: 'FAILED',
    operationType: 'CAPTURE',
    amountMinor: '10000',
    totalsAfter: AUTHORIZED,
    resultCode: TIMEOUT,
    normalizedError: normalizedError(TIMEOUT),
    noEffectProof: { kind: 'AUTHENTICATED_PROVIDER_REJECTION', providerCode: 'card_not_charged' },
  }),

  'payment.authorization.cancellation.succeeded.v1': terminal({
    type: 'payment.authorization.cancellation.succeeded.v1',
    outcome: 'SUCCEEDED',
    operationType: 'CANCEL',
    amountMinor: '10000',
    totalsAfter: VOIDED,
    ledgerTransactionId: null,
  }),

  'payment.authorization.cancellation.rejected.v1': terminal({
    type: 'payment.authorization.cancellation.rejected.v1',
    outcome: 'REJECTED',
    operationType: 'CANCEL',
    amountMinor: '10000',
    totalsAfter: AUTHORIZED,
    resultCode: DECLINED,
    normalizedError: normalizedError(DECLINED),
  }),

  'payment.authorization.cancellation.failed.v1': terminal({
    type: 'payment.authorization.cancellation.failed.v1',
    outcome: 'FAILED',
    operationType: 'CANCEL',
    amountMinor: '10000',
    totalsAfter: AUTHORIZED,
    resultCode: TIMEOUT,
    normalizedError: normalizedError(TIMEOUT),
    noEffectProof: { kind: 'AUTHENTICATED_PROVIDER_REJECTION', providerCode: 'card_not_charged' },
  }),

  'payment.refund.succeeded.v1': terminal({
    type: 'payment.refund.succeeded.v1',
    outcome: 'SUCCEEDED',
    operationType: 'REFUND',
    amountMinor: '3000',
    totalsAfter: REFUNDED,
    ledgerTransactionId: LTX,
    // A refund returns the fee it reverses; charging a fee on a refund is forbidden.
    feeReversalAmountMinor: '300',
  }),

  'payment.refund.rejected.v1': terminal({
    type: 'payment.refund.rejected.v1',
    outcome: 'REJECTED',
    operationType: 'REFUND',
    amountMinor: '3000',
    totalsAfter: CAPTURED,
    resultCode: DECLINED,
    normalizedError: normalizedError(DECLINED),
  }),

  'payment.refund.failed.v1': terminal({
    type: 'payment.refund.failed.v1',
    outcome: 'FAILED',
    operationType: 'REFUND',
    amountMinor: '3000',
    totalsAfter: CAPTURED,
    resultCode: TIMEOUT,
    normalizedError: normalizedError(TIMEOUT),
    noEffectProof: { kind: 'AUTHENTICATED_PROVIDER_REJECTION', providerCode: 'card_not_charged' },
  }),

  'payment.operation.reconciliation.required.v1': paymentEvent(
    'payment.operation.reconciliation.required.v1',
    {
      operationId: OP,
      operationType: 'CAPTURE',
      provider: PROVIDER,
      providerAccountId: PACC,
      providerAttemptId: PAT,
      providerIdempotencyKey: IDEMPOTENCY_KEY,
      redactedEvidenceRef: EVIDENCE_REF,
      reason: 'TIMEOUT_AFTER_SEND',
      unknownSince: TIMESTAMP,
      nextAttemptAt: '2026-11-05T18:45:31.123Z',
    },
  ),

  'payment.operation.review.required.v1': paymentEvent('payment.operation.review.required.v1', {
    operationId: OP,
    operationType: 'REFUND',
    provider: PROVIDER,
    providerAccountId: PACC,
    providerAttemptId: PAT,
    providerIdempotencyKey: IDEMPOTENCY_KEY,
    caseId: CASE,
    reason: 'AUTOMATED_RECONCILIATION_EXHAUSTED',
    evidenceRefs: [EVIDENCE_REF],
    automatedAttempts: 3,
    reviewRequiredAt: TIMESTAMP,
  }),

  'payment.discrepancy.detected.v1': paymentEvent('payment.discrepancy.detected.v1', {
    operationId: OP,
    providerAccountId: PACC,
    providerOperationId: 'provider_capture_123',
    caseId: CASE,
    classification: 'PROVIDER_EFFECT_MISSING_INTERNALLY',
    internalStatus: 'AUTHORIZED',
    providerStatus: 'CAPTURED',
    internalEvidenceRef: EVIDENCE_REF,
    providerEvidenceRef: 'pev_01ARZ3NDEKTSV4RRFFQ69G5FA5',
    detectedAt: TIMESTAMP,
  }),

  'ledger.transaction.posted.v1': envelope({
    kind: 'EVENT',
    type: 'ledger.transaction.posted.v1',
    source: 'flowledger.ledger',
    aggregateType: 'ledger_transaction',
    aggregateId: LTX,
    aggregateVersion: 1,
    causationId: OP,
    data: {
      ledgerTransactionId: LTX,
      // A CAPTURE posting always names the payment and operation it settles.
      paymentId: PAY,
      paymentOperationId: OP,
      settlementBatchId: null,
      postingKey: `capture:${OP}`,
      operationType: 'CAPTURE',
      currency: 'USD',
      entryCount: 2,
      // Debits equal credits: a posting is a double entry, not a single-sided movement.
      totalDebitsMinor: '10000',
      totalCreditsMinor: '10000',
      recordedAt: TIMESTAMP,
    },
  }),

  'settlement.batch.posted.v1': envelope({
    kind: 'EVENT',
    type: 'settlement.batch.posted.v1',
    source: 'flowledger.settlement',
    aggregateType: 'settlement_batch',
    aggregateId: SBT,
    // A settlement batch is created posted: its aggregate version is fixed at 1.
    aggregateVersion: 1,
    // Settlement events order on the merchant, so every batch of one merchant is serial.
    orderingKey: MER,
    causationId: LTX,
    data: {
      settlementBatchId: SBT,
      settlementRunId: SRN,
      currency: 'USD',
      cutoffAt: '2026-11-05T00:00:00.000Z',
      memberCount: 1,
      netAmountMinor: '10000',
      ledgerTransactionId: LTX,
      postingKey: `settlement:${SBT}`,
      postedAt: TIMESTAMP,
    },
  }),
};
