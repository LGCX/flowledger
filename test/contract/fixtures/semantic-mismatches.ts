/**
 * One schema-valid, semantically-mismatched message per semantic rule.
 *
 * Most mismatches pass Ajv and are rejected only by `checkSemantics`. Four cannot exist as
 * schema-valid documents — `schemaVersion`, settlement `aggregateVersion`, the ledger
 * reference shape, and the settlement posting key are pinned by the schema itself — so for
 * those the case is flagged `viaSchema: false` and the test asserts the rule by calling
 * `checkSemantics` directly. Marking them explicitly keeps the suite honest: without the
 * flag, "rejected" would silently mean "rejected by Ajv" and the semantic rule would be
 * untested.
 *
 * Each mutation is chosen to trip exactly one rule. A mutation that trips two would let the
 * intended rule regress while the test still passed.
 */
import type { SemanticRule } from '@flowledger/contracts';
import { validMessages } from './messages.js';

type Message = Record<string, unknown>;

export interface SemanticMismatch {
  readonly rule: SemanticRule;
  /** False when JSON Schema already rejects the mutation, so only `checkSemantics` can see it. */
  readonly viaSchema: boolean;
  /** The base fixture this mismatch starts from. */
  readonly type: string;
  readonly build: () => Message;
}

function base(type: string): Message {
  return structuredClone(validMessages[type as keyof typeof validMessages]);
}

function data(message: Message): Message {
  return message.data as Message;
}

/** Another valid ULID of the same entity with a different final character. */
function variant(id: string): string {
  const last = id.slice(-1);
  return `${id.slice(0, -1)}${last === 'Z' ? 'Y' : 'Z'}`;
}

const SUCCEEDED = 'payment.authorization.succeeded.v1';
const EXECUTE = 'payment.operation.execute.v1';
const DELIVER = 'merchant.webhook.deliver.v1';
const LEDGER = 'ledger.transaction.posted.v1';
const SETTLEMENT = 'settlement.batch.posted.v1';
const REFUND_REJECTED = 'payment.refund.rejected.v1';
const CANCEL_SUCCEEDED = 'payment.authorization.cancellation.succeeded.v1';
const REFUND_SUCCEEDED = 'payment.refund.succeeded.v1';

export const semanticMismatches: readonly SemanticMismatch[] = [
  {
    rule: 'SCHEMA_VERSION_MATCHES_TYPE_SUFFIX',
    viaSchema: false,
    type: SUCCEEDED,
    build: () => ({ ...base(SUCCEEDED), schemaVersion: 2 }),
  },
  {
    rule: 'PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID',
    viaSchema: true,
    type: SUCCEEDED,
    build: () => {
      const message = base(SUCCEEDED);
      // Another valid payment ID: the shape is legal, the correlation is not.
      message.aggregateId = variant(String(data(message).paymentId));
      return message;
    },
  },
  {
    rule: 'PAYMENT_ORDERING_KEY_EQUALS_PAYMENT_ID',
    viaSchema: true,
    type: SUCCEEDED,
    build: () => {
      const message = base(SUCCEEDED);
      message.orderingKey = variant(String(data(message).paymentId));
      return message;
    },
  },
  {
    rule: 'EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION',
    viaSchema: true,
    type: EXECUTE,
    build: () => ({ ...base(EXECUTE), aggregateVersion: 6 }),
  },
  {
    rule: 'WEBHOOK_DELIVERY_AGGREGATE_ID_EQUALS_DELIVERY_ID',
    viaSchema: true,
    type: DELIVER,
    build: () => {
      const message = base(DELIVER);
      message.aggregateId = variant(String(data(message).deliveryId));
      return message;
    },
  },
  {
    rule: 'WEBHOOK_DELIVERY_ORDERING_KEY_EQUALS_ENDPOINT_ID',
    viaSchema: true,
    type: DELIVER,
    build: () => {
      const message = base(DELIVER);
      message.orderingKey = variant(String(data(message).endpointId));
      return message;
    },
  },
  {
    rule: 'LEDGER_AGGREGATE_ID_EQUALS_TRANSACTION_ID',
    viaSchema: true,
    type: LEDGER,
    build: () => {
      const message = base(LEDGER);
      message.aggregateId = variant(String(data(message).ledgerTransactionId));
      return message;
    },
  },
  {
    rule: 'LEDGER_REFERENCES_MATCH_OPERATION_TYPE',
    viaSchema: false,
    type: LEDGER,
    build: () => {
      const message = base(LEDGER);
      // A CAPTURE posting that also names a batch; the schema forbids the combination.
      message.data = { ...data(message), settlementBatchId: 'sbt_01ARZ3NDEKTSV4RRFFQ69G5FB5' };
      return message;
    },
  },
  {
    rule: 'LEDGER_DEBITS_EQUAL_CREDITS',
    viaSchema: true,
    type: LEDGER,
    build: () => {
      const message = base(LEDGER);
      message.data = { ...data(message), totalCreditsMinor: '9000' };
      return message;
    },
  },
  {
    rule: 'SETTLEMENT_AGGREGATE_ID_EQUALS_BATCH_ID',
    viaSchema: true,
    type: SETTLEMENT,
    build: () => {
      const message = base(SETTLEMENT);
      message.aggregateId = variant(String(data(message).settlementBatchId));
      return message;
    },
  },
  {
    rule: 'SETTLEMENT_ORDERING_KEY_EQUALS_MERCHANT_ID',
    viaSchema: true,
    type: SETTLEMENT,
    build: () => {
      const message = base(SETTLEMENT);
      message.orderingKey = variant(String(message.merchantId));
      return message;
    },
  },
  {
    rule: 'SETTLEMENT_AGGREGATE_VERSION_IS_ONE',
    viaSchema: false,
    type: SETTLEMENT,
    build: () => ({ ...base(SETTLEMENT), aggregateVersion: 2 }),
  },
  {
    rule: 'SETTLEMENT_POSTING_KEY_DERIVED',
    viaSchema: true,
    type: SETTLEMENT,
    build: () => {
      const message = base(SETTLEMENT);
      // A well-formed key for a *different* batch than the data names.
      const batch = variant(String(data(message).settlementBatchId));
      message.data = { ...data(message), postingKey: `settlement:${batch}` };
      return message;
    },
  },
  {
    rule: 'RESOLUTION_SOURCE_EQUALS_EVIDENCE_SOURCE',
    viaSchema: true,
    type: SUCCEEDED,
    build: () => {
      const message = base(SUCCEEDED);
      return { ...message, data: { ...data(message), resolutionSource: 'PROVIDER_WEBHOOK' } };
    },
  },
  {
    rule: 'RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE',
    viaSchema: true,
    type: REFUND_REJECTED,
    build: () => {
      const message = base(REFUND_REJECTED);
      const normalizedError = data(message).normalizedError as Message;
      return {
        ...message,
        data: {
          ...data(message),
          normalizedError: { ...normalizedError, code: 'insufficient_funds' },
        },
      };
    },
  },
  {
    rule: 'TOTALS_SATISFY_PAYMENT_INVARIANTS',
    viaSchema: true,
    type: SUCCEEDED,
    build: () => {
      const message = base(SUCCEEDED);
      const totalsAfter = data(message).totalsAfter as Message;
      return {
        ...message,
        data: { ...data(message), totalsAfter: { ...totalsAfter, capturedAmountMinor: '10001' } },
      };
    },
  },
];

/** Bases reused by the boundary cases in the test file. */
export const boundaryBases = { CANCEL_SUCCEEDED, REFUND_SUCCEEDED, SUCCEEDED } as const;

export function withTotals(type: string, totals: Record<string, string>): Message {
  const message = base(type);
  const current = data(message).totalsAfter as Message;
  return { ...message, data: { ...data(message), totalsAfter: { ...current, ...totals } } };
}
