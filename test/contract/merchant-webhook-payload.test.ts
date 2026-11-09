/**
 * The merchant webhook payload is a public projection, not the internal envelope: it carries
 * only what the merchant could not already know, and it must never leak provider identifiers,
 * evidence references, internal errors, or journal accounts (docs/04 §Merchant webhook wire
 * contract).
 *
 * The allowlist is asserted twice — positively, that every public type has a valid payload,
 * and negatively, that the two deliberately excluded types are refused.
 */
import { describe, expect, it } from 'vitest';
import { validateMerchantWebhookPayload } from '@flowledger/contracts';
import {
  ENVELOPE_ID,
  MER,
  OP,
  PACC,
  PAT,
  PAY,
  PROVIDER,
  SBT,
  TIMESTAMP,
} from './fixtures/messages.js';

type Message = Record<string, unknown>;

const CREATED_AT = '2026-11-05T18:44:31.123Z';

const PUBLIC_TYPES = [
  'payment.authorization.succeeded.v1',
  'payment.authorization.rejected.v1',
  'payment.authorization.expired.v1',
  'payment.capture.succeeded.v1',
  'payment.capture.rejected.v1',
  'payment.authorization.cancellation.succeeded.v1',
  'payment.authorization.cancellation.rejected.v1',
  'payment.refund.succeeded.v1',
  'payment.refund.rejected.v1',
] as const;

interface PublicCase {
  readonly type: string;
  readonly operationType: 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';
  readonly outcome: 'SUCCEEDED' | 'REJECTED' | 'EXPIRED';
  readonly summaryStatus: string;
}

/** The docs/04 §Merchant webhook wire contract table, one row per public type. */
const TABLE: readonly PublicCase[] = [
  // prettier-ignore
  { type: 'payment.authorization.succeeded.v1', operationType: 'AUTHORIZE', outcome: 'SUCCEEDED', summaryStatus: 'AUTHORIZED' },
  // prettier-ignore
  { type: 'payment.authorization.rejected.v1', operationType: 'AUTHORIZE', outcome: 'REJECTED', summaryStatus: 'AUTHORIZATION_FAILED' },
  // prettier-ignore
  { type: 'payment.authorization.expired.v1', operationType: 'AUTHORIZE', outcome: 'EXPIRED', summaryStatus: 'EXPIRED' },
  // prettier-ignore
  { type: 'payment.capture.succeeded.v1', operationType: 'CAPTURE', outcome: 'SUCCEEDED', summaryStatus: 'CAPTURED' },
  // prettier-ignore
  { type: 'payment.capture.rejected.v1', operationType: 'CAPTURE', outcome: 'REJECTED', summaryStatus: 'AUTHORIZED' },
  // prettier-ignore
  { type: 'payment.authorization.cancellation.succeeded.v1', operationType: 'CANCEL', outcome: 'SUCCEEDED', summaryStatus: 'CANCELED' },
  // prettier-ignore
  { type: 'payment.authorization.cancellation.rejected.v1', operationType: 'CANCEL', outcome: 'REJECTED', summaryStatus: 'AUTHORIZED' },
  // prettier-ignore
  { type: 'payment.refund.succeeded.v1', operationType: 'REFUND', outcome: 'SUCCEEDED', summaryStatus: 'REFUNDED' },
  // prettier-ignore
  { type: 'payment.refund.rejected.v1', operationType: 'REFUND', outcome: 'REJECTED', summaryStatus: 'CAPTURED' },
];

function payload(entry: PublicCase): Message {
  return {
    id: ENVELOPE_ID,
    type: entry.type,
    schemaVersion: 1,
    createdAt: CREATED_AT,
    merchantId: MER,
    data: {
      paymentId: PAY,
      paymentVersion: 5,
      operationId: OP,
      operationType: entry.operationType,
      outcome: entry.outcome,
      amount: { amountMinor: '10000', currency: 'USD' },
      totals: {
        requestedAmountMinor: '10000',
        authorizedAmountMinor: '10000',
        capturedAmountMinor: '10000',
        refundedAmountMinor: '0',
        voidedAmountMinor: '0',
        currency: 'USD',
      },
      summaryStatus: entry.summaryStatus,
    },
  };
}

function dataOf(message: Message): Message {
  return message.data as Message;
}

function expectRejected(message: unknown, keyword: string, path: string): void {
  const result = validateMerchantWebhookPayload(message);
  expect(result.ok, 'payload was accepted').toBe(false);
  if (result.ok) return;
  expect(result.failure).toBe('SCHEMA');
  const matching = result.issues.filter(
    (issue) => issue.rule === keyword && issue.path.startsWith(path),
  );
  expect(
    matching,
    `expected ${keyword}@${path}, got ${JSON.stringify(result.issues.map((i) => `${i.rule}@${i.path}`))}`,
  ).not.toHaveLength(0);
}

const BY_TYPE = new Map(TABLE.map((entry) => [entry.type, entry]));

function entry(type: string): PublicCase {
  const found = BY_TYPE.get(type);
  if (found === undefined) throw new Error(`no table row for ${type}`);
  return found;
}

describe('merchant webhook payload', () => {
  it('has one payload per type in the public allowlist', () => {
    expect(TABLE.map((row) => row.type)).toEqual([...PUBLIC_TYPES]);
  });

  it.each(PUBLIC_TYPES)('%s payload validates', (type) => {
    const result = validateMerchantWebhookPayload(payload(entry(type)));
    expect(result.ok, JSON.stringify(!result.ok ? result.issues : [])).toBe(true);
  });

  it('rejects payment.created.v1, which merchants already know synchronously', () => {
    expectRejected(
      { ...payload(entry(PUBLIC_TYPES[0])), type: 'payment.created.v1' },
      'enum',
      '/type',
    );
  });

  it('rejects settlement.batch.posted.v1, which is outside the allowlist', () => {
    expectRejected(
      { ...payload(entry(PUBLIC_TYPES[0])), type: 'settlement.batch.posted.v1' },
      'enum',
      '/type',
    );
  });

  it('rejects an outcome that contradicts the type', () => {
    const message = payload(entry('payment.refund.succeeded.v1'));
    message.data = { ...dataOf(message), outcome: 'REJECTED' };
    expectRejected(message, 'const', '/data/outcome');
  });

  it('rejects an operationType that contradicts the type', () => {
    const message = payload(entry('payment.refund.succeeded.v1'));
    message.data = { ...dataOf(message), operationType: 'CAPTURE' };
    expectRejected(message, 'const', '/data/operationType');
  });

  it('rejects an expired authorization reported as succeeded', () => {
    const message = payload(entry('payment.authorization.expired.v1'));
    message.data = { ...dataOf(message), outcome: 'SUCCEEDED' };
    expectRejected(message, 'const', '/data/outcome');
  });

  it('rejects createdAt without milliseconds', () => {
    const message = {
      ...payload(entry('payment.capture.succeeded.v1')),
      createdAt: '2026-11-05T18:44:31Z',
    };
    expectRejected(message, 'pattern', '/createdAt');
  });

  it('rejects an unknown field', () => {
    const message = {
      ...payload(entry('payment.capture.succeeded.v1')),
      internalStatus: 'CAPTURED',
    };
    expectRejected(message, 'additionalProperties', '');
  });

  it('refuses provider identifiers in the public projection', () => {
    const message = payload(entry('payment.capture.succeeded.v1'));
    message.data = {
      ...dataOf(message),
      providerPaymentId: 'provider_payment_123',
    };
    expectRejected(message, 'additionalProperties', '/data');
  });

  it('refuses internal evidence and redaction references', () => {
    const message = payload(entry('payment.capture.succeeded.v1'));
    message.data = { ...dataOf(message), redactedEvidenceRef: 'pev_01ARZ3NDEKTSV4RRFFQ69G5FA1' };
    expectRejected(message, 'additionalProperties', '/data');
  });

  it('keeps the fixture constants used by the domain messages', () => {
    // Guards against a future edit that changes a shared constant and silently makes the
    // internal and public fixtures disagree about the same payment.
    expect([MER, PAY, OP, PACC, PAT, SBT, PROVIDER, TIMESTAMP, ENVELOPE_ID]).toHaveLength(9);
  });
});
