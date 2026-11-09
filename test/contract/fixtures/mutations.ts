/**
 * High-risk defects, one mutation each, asserting *which* rule rejects them.
 *
 * Asserting only `ok === false` would pass for the wrong reason — a typo in the mutation
 * would be rejected by some unrelated constraint and the intended guarantee would go
 * untested. Every case therefore names the Ajv keyword and, where the keyword alone is
 * ambiguous, the instance path.
 *
 * `appliesTo` is explicit rather than derived: a case that silently applies to no type
 * would pass vacuously, and one that applies to a type whose fixture lacks the field would
 * assert a path that cannot fail.
 */
import type { MessageType } from '@flowledger/contracts';
import { LTX, MER, PAY, SBT, WHE } from './messages.js';

type Message = Record<string, unknown>;

export interface NegativeCase {
  readonly name: string;
  readonly appliesTo: readonly MessageType[] | 'all';
  readonly mutate: (message: Message) => Message;
  readonly expect: { readonly keyword: string; readonly instancePathPrefix?: string };
}

const AUTHORIZED_SUCCEEDED: readonly MessageType[] = [
  'payment.authorization.succeeded.v1',
  'payment.capture.succeeded.v1',
  'payment.authorization.cancellation.succeeded.v1',
  'payment.refund.succeeded.v1',
];

const REJECTED: readonly MessageType[] = [
  'payment.authorization.rejected.v1',
  'payment.capture.rejected.v1',
  'payment.authorization.cancellation.rejected.v1',
  'payment.refund.rejected.v1',
];

const FAILED: readonly MessageType[] = [
  'payment.authorization.failed.v1',
  'payment.capture.failed.v1',
  'payment.authorization.cancellation.failed.v1',
  'payment.refund.failed.v1',
];

/** Every type whose `data.amount` is a positive money object. */
const AMOUNT_BEARING: readonly MessageType[] = [
  'payment.authorization.requested.v1',
  'payment.capture.requested.v1',
  'payment.authorization.cancellation.requested.v1',
  'payment.refund.requested.v1',
  ...AUTHORIZED_SUCCEEDED,
  ...REJECTED,
  ...FAILED,
];

/** Every type that carries `data.evidence`. */
const EVIDENCE_BEARING: readonly MessageType[] = [
  ...AUTHORIZED_SUCCEEDED,
  ...REJECTED,
  ...FAILED,
  'payment.authorization.expired.v1',
];

/**
 * Every type with a `data.paymentId`: all payment-scoped messages plus the CAPTURE ledger
 * posting, which names the payment it settles.
 */
const PAYMENT_ID_BEARING: readonly MessageType[] = [
  'payment.operation.execute.v1',
  'payment.operation.reconcile.v1',
  'payment.created.v1',
  ...AMOUNT_BEARING,
  'payment.authorization.expired.v1',
  'payment.operation.reconciliation.required.v1',
  'payment.operation.review.required.v1',
  'payment.discrepancy.detected.v1',
  'ledger.transaction.posted.v1',
];

function data(message: Message): Message {
  return message.data as Message;
}

/** Replaces the first character after an entity prefix, e.g. `pay_0…` -> `pay_8…`. */
function overflowId(id: string): string {
  const prefix = id.indexOf('_');
  return `${id.slice(0, prefix + 1)}8${id.slice(prefix + 2)}`;
}

export const negativeCases: readonly NegativeCase[] = [
  {
    name: 'unknown-envelope-field',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, extra: 1 }),
    expect: { keyword: 'additionalProperties', instancePathPrefix: '' },
  },
  {
    name: 'unknown-data-field',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, data: { ...data(message), extra: 1 } }),
    expect: { keyword: 'additionalProperties', instancePathPrefix: '/data' },
  },
  {
    name: 'invalid-uuid-id',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, id: '0192f4e7-8b30-7c83-b462' }),
    expect: { keyword: 'format', instancePathPrefix: '/id' },
  },
  {
    name: 'invalid-date-time',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, occurredAt: '2026-11-05 18:44:31' }),
    expect: { keyword: 'format', instancePathPrefix: '/occurredAt' },
  },
  {
    name: 'overflow-ulid',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, aggregateId: overflowId(String(message.aggregateId)) }),
    expect: { keyword: 'pattern', instancePathPrefix: '/aggregateId' },
  },
  {
    name: 'wrong-entity-prefix',
    appliesTo: [...PAYMENT_ID_BEARING, 'merchant.webhook.deliver.v1'],
    mutate: (message) => {
      const next = { ...message, data: { ...data(message) } };
      if (message.type === 'merchant.webhook.deliver.v1')
        next.data = { ...data(message), deliveryId: WHE };
      else next.data = { ...data(message), paymentId: MER };
      return next;
    },
    expect: { keyword: 'pattern', instancePathPrefix: '/data' },
  },
  {
    name: 'zero-operation-amount',
    appliesTo: AMOUNT_BEARING,
    mutate: (message) => ({
      ...message,
      data: { ...data(message), amount: { amountMinor: '0', currency: 'USD' } },
    }),
    expect: { keyword: 'pattern', instancePathPrefix: '/data/amount/amountMinor' },
  },
  {
    name: 'amount-above-max',
    appliesTo: AMOUNT_BEARING,
    mutate: (message) => ({
      ...message,
      data: { ...data(message), amount: { amountMinor: '1000000000001', currency: 'USD' } },
    }),
    expect: { keyword: 'pattern', instancePathPrefix: '/data/amount/amountMinor' },
  },
  {
    name: 'json-number-amount',
    appliesTo: AMOUNT_BEARING,
    mutate: (message) => ({
      ...message,
      data: { ...data(message), amount: { amountMinor: 10000, currency: 'USD' } },
    }),
    expect: { keyword: 'type', instancePathPrefix: '/data/amount/amountMinor' },
  },
  {
    name: 'non-usd',
    appliesTo: AMOUNT_BEARING,
    mutate: (message) => ({
      ...message,
      data: { ...data(message), amount: { amountMinor: '10000', currency: 'EUR' } },
    }),
    expect: { keyword: 'const', instancePathPrefix: '/data/amount/currency' },
  },
  {
    name: 'schema-version-mismatch',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, schemaVersion: 2 }),
    expect: { keyword: 'const', instancePathPrefix: '/schemaVersion' },
  },
  {
    name: 'mismatched-outcome',
    appliesTo: AUTHORIZED_SUCCEEDED,
    mutate: (message) => ({ ...message, data: { ...data(message), outcome: 'REJECTED' } }),
    expect: { keyword: 'const', instancePathPrefix: '/data/outcome' },
  },
  {
    name: 'success-with-error',
    appliesTo: AUTHORIZED_SUCCEEDED,
    mutate: (message) => ({
      ...message,
      data: {
        ...data(message),
        normalizedError: {
          category: 'BUSINESS_DECLINE',
          code: 'card_declined',
          retryDirective: 'DO_NOT_RETRY',
          retryAfterMs: null,
          safeMessage: 'declined',
        },
      },
    }),
    expect: { keyword: 'type', instancePathPrefix: '/data/normalizedError' },
  },
  {
    name: 'missing-evidence',
    appliesTo: EVIDENCE_BEARING,
    mutate: (message) => {
      const next = { ...data(message) };
      delete next.evidence;
      return { ...message, data: next };
    },
    expect: { keyword: 'required', instancePathPrefix: '/data' },
  },
  {
    name: 'failed-without-proof',
    appliesTo: FAILED,
    mutate: (message) => ({ ...message, data: { ...data(message), noEffectProof: null } }),
    expect: { keyword: 'type', instancePathPrefix: '/data/noEffectProof' },
  },
  {
    name: 'rejected-without-error',
    appliesTo: REJECTED,
    mutate: (message) => ({ ...message, data: { ...data(message), normalizedError: null } }),
    expect: { keyword: 'type', instancePathPrefix: '/data/normalizedError' },
  },
  {
    name: 'fee-on-refund-success',
    appliesTo: ['payment.refund.succeeded.v1'],
    mutate: (message) => ({ ...message, data: { ...data(message), feeAmountMinor: '300' } }),
    expect: { keyword: 'false schema', instancePathPrefix: '/data/feeAmountMinor' },
  },
  {
    name: 'fee-reversal-on-capture',
    appliesTo: ['payment.capture.succeeded.v1'],
    mutate: (message) => ({
      ...message,
      data: { ...data(message), feeReversalAmountMinor: '300' },
    }),
    expect: { keyword: 'false schema', instancePathPrefix: '/data/feeReversalAmountMinor' },
  },
  {
    name: 'fee-on-unrelated-type',
    appliesTo: ['payment.authorization.succeeded.v1'],
    mutate: (message) => ({ ...message, data: { ...data(message), feeAmountMinor: '300' } }),
    expect: { keyword: 'false schema', instancePathPrefix: '/data/feeAmountMinor' },
  },
  {
    name: 'ledger-txn-on-non-posting-type',
    appliesTo: ['payment.authorization.succeeded.v1'],
    mutate: (message) => ({ ...message, data: { ...data(message), ledgerTransactionId: LTX } }),
    expect: { keyword: 'type', instancePathPrefix: '/data/ledgerTransactionId' },
  },
  {
    name: 'capture-requested-missing-fee',
    appliesTo: ['payment.capture.requested.v1'],
    mutate: (message) => {
      const next = { ...data(message) };
      delete next.feeAmountMinor;
      return { ...message, data: next };
    },
    expect: { keyword: 'required', instancePathPrefix: '/data' },
  },
  {
    name: 'settlement-version-not-one',
    appliesTo: ['settlement.batch.posted.v1'],
    mutate: (message) => ({ ...message, aggregateVersion: 2 }),
    expect: { keyword: 'const', instancePathPrefix: '/aggregateVersion' },
  },
  {
    name: 'settlement-posting-key-pattern',
    appliesTo: ['settlement.batch.posted.v1'],
    mutate: (message) => ({ ...message, data: { ...data(message), postingKey: 'settlement:x' } }),
    expect: { keyword: 'pattern', instancePathPrefix: '/data/postingKey' },
  },
  {
    name: 'ledger-settlement-with-payment',
    appliesTo: ['ledger.transaction.posted.v1'],
    mutate: (message) => ({
      ...message,
      data: {
        ...data(message),
        operationType: 'SETTLEMENT',
        settlementBatchId: SBT,
        paymentId: PAY,
        paymentOperationId: null,
      },
    }),
    expect: { keyword: 'type', instancePathPrefix: '/data/paymentId' },
  },
  {
    name: 'invalid-traceparent',
    appliesTo: 'all',
    mutate: (message) => ({ ...message, traceparent: '00-xyz' }),
    expect: { keyword: 'pattern', instancePathPrefix: '/traceparent' },
  },
];
