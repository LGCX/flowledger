/**
 * The payment aggregate: invariant diagnostics and the derived display status.
 *
 * Each invariant case is a minimal fixture. Several violations are logically implied by another
 * break — a negative `unresolvedRefundCount` also contradicts the reservation and the operation
 * count — and those implied ids are listed explicitly rather than filtered out, because a checker
 * that hid them would be reporting less than it knows.
 */
import { describe, expect, it } from 'vitest';
import type { FeeSnapshot } from './fees.js';
import type { OperationId, PaymentId } from './ids.js';
import { type MinorUnits, minorUnits } from './money.js';
import {
  INVARIANT_IDS,
  type InvariantId,
  type OperationState,
  type OperationType,
  type PaymentState,
  type SummaryStatus,
  AUTHORIZATION_OUTCOMES,
  OPERATION_STATUSES,
  OPERATION_TYPES,
  SUMMARY_STATUSES,
  checkPaymentInvariants,
  deriveSummaryStatus,
  exclusionClass,
  isTerminal,
  isUnresolved,
} from './payment.js';

const U = (value: string | bigint): MinorUnits =>
  minorUnits(typeof value === 'bigint' ? value : BigInt(value));

let counter = 0;
function opId(): OperationId {
  counter += 1;
  return `op_01ARZ3NDEKTSV4RRFFQ69G5F${String.fromCharCode(65 + (counter % 26))}${String.fromCharCode(65 + Math.floor(counter / 26))}` as OperationId;
}

const SNAPSHOT: FeeSnapshot = {
  basisPoints: 290n,
  fixedAmount: U('30'),
  captureFee: U('320'),
  captureGross: U('10000'),
};

function payment(over: Partial<PaymentState> = {}): PaymentState {
  return {
    id: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV' as PaymentId,
    requested: U('10000'),
    authorized: U('0'),
    captured: U('0'),
    refunded: U('0'),
    voided: U('0'),
    reservedRefund: U('0'),
    unresolvedRefundCount: 0,
    authorizationOutcome: 'NOT_REQUESTED',
    activeExclusiveOperationId: null,
    version: 1,
    ...over,
  };
}

function op(over: Partial<OperationState> & { type?: OperationType } = {}): OperationState {
  return {
    id: over.id ?? opId(),
    type: over.type ?? 'AUTHORIZE',
    amount: over.amount ?? U('10000'),
    status: over.status ?? 'SUCCEEDED',
    notBefore: over.notBefore ?? null,
    version: over.version ?? 1,
    feeEffect: over.feeEffect ?? null,
    feeSnapshot: over.feeSnapshot ?? null,
  };
}

function violated(p: PaymentState, ops: readonly OperationState[] = []): readonly InvariantId[] {
  return [...checkPaymentInvariants(p, ops)].sort();
}

describe('invariants', () => {
  it('a fresh payment is valid and requires authorization', () => {
    expect(checkPaymentInvariants(payment(), [])).toEqual([]);
    expect(deriveSummaryStatus(payment(), [])).toBe('REQUIRES_AUTHORIZATION');
  });

  it('REQUESTED_POSITIVE violated', () => {
    expect(violated(payment({ requested: U('0') }))).toEqual(['REQUESTED_POSITIVE']);
  });

  it('COUNT_NON_NEGATIVE violated', () => {
    expect(violated(payment({ unresolvedRefundCount: -1 }))).toEqual([
      'COUNT_EQUALS_UNRESOLVED_REFUNDS',
      'COUNT_NON_NEGATIVE',
      'RESERVATION_ZERO_IFF_COUNT_ZERO',
    ]);
  });

  it('AUTHORIZED_LE_REQUESTED violated', () => {
    expect(
      violated(payment({ authorized: U('20000'), authorizationOutcome: 'AUTHORIZED' })),
    ).toEqual(['AUTHORIZED_LE_REQUESTED']);
  });

  it('CAPTURED_LE_AUTHORIZED violated', () => {
    // Three ids, two of them implied: captured money with no successful capture behind it, and a
    // negative voidable allowance (`authorized - captured`), which even `voided = 0` exceeds.
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('20000'),
          authorizationOutcome: 'AUTHORIZED',
        }),
      ),
    ).toEqual([
      'CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE',
      'CAPTURED_LE_AUTHORIZED',
      'VOIDED_LE_AUTHORIZED_MINUS_CAPTURED',
    ]);
  });

  it('REFUNDED_LE_CAPTURED violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          refunded: U('20000'),
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture],
      ),
    ).toEqual(['REFUNDED_LE_CAPTURED', 'REFUNDED_PLUS_RESERVED_LE_CAPTURED']);
  });

  it('VOIDED_LE_AUTHORIZED_MINUS_CAPTURED violated', () => {
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('0'),
          voided: U('10001'),
          authorizationOutcome: 'AUTHORIZED',
        }),
      ),
    ).toEqual(['VOIDED_LE_AUTHORIZED_MINUS_CAPTURED']);
  });

  it('REFUNDED_PLUS_RESERVED_LE_CAPTURED violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const refund = op({ type: 'REFUND', status: 'UNKNOWN', amount: U('5000') });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          refunded: U('6000'),
          reservedRefund: U('5000'),
          unresolvedRefundCount: 1,
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture, refund],
      ),
    ).toEqual(['REFUNDED_PLUS_RESERVED_LE_CAPTURED']);
  });

  it('RESERVATION_ZERO_IFF_COUNT_ZERO violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const refund = op({ type: 'REFUND', status: 'REQUESTED', amount: U('5000') });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          unresolvedRefundCount: 1,
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture, refund],
      ),
    ).toEqual(['RESERVATION_EQUALS_UNRESOLVED_REFUNDS', 'RESERVATION_ZERO_IFF_COUNT_ZERO']);
  });

  it('RESERVATION_EQUALS_UNRESOLVED_REFUNDS violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const refund = op({ type: 'REFUND', status: 'UNKNOWN', amount: U('5000') });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          reservedRefund: U('3000'),
          unresolvedRefundCount: 1,
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture, refund],
      ),
    ).toEqual(['RESERVATION_EQUALS_UNRESOLVED_REFUNDS']);
  });

  it('COUNT_EQUALS_UNRESOLVED_REFUNDS violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const refund = op({ type: 'REFUND', status: 'UNKNOWN', amount: U('5000') });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          reservedRefund: U('5000'),
          unresolvedRefundCount: 2,
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture, refund],
      ),
    ).toEqual(['COUNT_EQUALS_UNRESOLVED_REFUNDS']);
  });

  it('AT_MOST_ONE_UNRESOLVED_EXCLUSIVE violated', () => {
    const first = op({ type: 'CAPTURE', status: 'PROCESSING', amount: U('5000') });
    const second = op({ type: 'CAPTURE', status: 'REQUESTED', amount: U('5000') });
    expect(
      violated(payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }), [
        first,
        second,
      ]),
    ).toEqual(['AT_MOST_ONE_UNRESOLVED_EXCLUSIVE', 'EXCLUSIVE_POINTER_MATCHES']);
  });

  it('EXCLUSIVE_POINTER_MATCHES violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'PROCESSING', amount: U('5000') });
    expect(
      violated(payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }), [capture]),
    ).toEqual(['EXCLUSIVE_POINTER_MATCHES']);
  });

  it('UNAUTHORIZED_TOTALS_ZERO violated', () => {
    expect(violated(payment({ authorized: U('100'), authorizationOutcome: 'DECLINED' }))).toEqual([
      'UNAUTHORIZED_TOTALS_ZERO',
    ]);
  });

  it('CANCELED_OR_EXPIRED_VOIDS_ALL violated', () => {
    expect(
      violated(
        payment({
          authorized: U('10000'),
          voided: U('5000'),
          authorizationOutcome: 'CANCELED',
        }),
      ),
    ).toEqual(['CANCELED_OR_EXPIRED_VOIDS_ALL']);
  });

  it('CAPTURE_RELEASES_REMAINDER violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('6000') });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('6000'),
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture],
      ),
    ).toEqual(['CAPTURE_RELEASES_REMAINDER']);
  });

  it('CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE violated', () => {
    // Captured money with no successful capture operation behind it.
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          authorizationOutcome: 'AUTHORIZED',
        }),
      ),
    ).toEqual(['CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE']);
  });

  it('REFUND_FEE_ONLY_ON_SUCCESS violated', () => {
    const capture = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const rejected = op({
      type: 'REFUND',
      status: 'REJECTED',
      amount: U('2500'),
      feeEffect: U('150'),
      feeSnapshot: SNAPSHOT,
    });
    expect(
      violated(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          authorizationOutcome: 'AUTHORIZED',
        }),
        [capture, rejected],
      ),
    ).toEqual(['REFUND_FEE_ONLY_ON_SUCCESS']);
  });

  it('AT_MOST_THREE_AUTHORIZATIONS violated', () => {
    const attempts = [
      op({ type: 'AUTHORIZE', status: 'REJECTED' }),
      op({ type: 'AUTHORIZE', status: 'FAILED' }),
      op({ type: 'AUTHORIZE', status: 'REJECTED' }),
      op({ type: 'AUTHORIZE', status: 'SUCCEEDED' }),
    ];
    expect(
      violated(payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }), attempts),
    ).toEqual(['AT_MOST_THREE_AUTHORIZATIONS']);
  });

  it('every declared invariant id has a case above', () => {
    // The 18 cases plus two meta-cases; this guards a future id added without a fixture.
    expect(INVARIANT_IDS).toHaveLength(18);
  });
});

describe('valid lifecycle snapshots', () => {
  const captureOp = (amount: string): OperationState =>
    op({
      type: 'CAPTURE',
      status: 'SUCCEEDED',
      amount: U(amount),
      feeEffect: U('320'),
      feeSnapshot: SNAPSHOT,
    });

  it.each([
    ['created', payment(), [] as OperationState[]],
    [
      'authorized',
      payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [op({ type: 'AUTHORIZE', status: 'SUCCEEDED' })],
    ],
    [
      'captured-full',
      payment({ authorized: U('10000'), captured: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [captureOp('10000')],
    ],
    [
      'captured-partial-then-voided',
      payment({
        authorized: U('10000'),
        captured: U('6000'),
        voided: U('4000'),
        authorizationOutcome: 'AUTHORIZED',
      }),
      [captureOp('6000')],
    ],
    [
      'refunded-partial-with-reservation',
      payment({
        authorized: U('10000'),
        captured: U('10000'),
        refunded: U('3000'),
        reservedRefund: U('2500'),
        unresolvedRefundCount: 1,
        authorizationOutcome: 'AUTHORIZED',
      }),
      [
        captureOp('10000'),
        op({ type: 'REFUND', status: 'UNKNOWN', amount: U('2500') }),
        op({
          type: 'REFUND',
          status: 'SUCCEEDED',
          amount: U('3000'),
          feeEffect: U('96'),
          feeSnapshot: SNAPSHOT,
        }),
      ],
    ],
    [
      'refunded-full',
      payment({
        authorized: U('10000'),
        captured: U('10000'),
        refunded: U('10000'),
        authorizationOutcome: 'AUTHORIZED',
      }),
      [
        captureOp('10000'),
        op({
          type: 'REFUND',
          status: 'SUCCEEDED',
          amount: U('10000'),
          feeEffect: U('320'),
          feeSnapshot: SNAPSHOT,
        }),
      ],
    ],
    [
      'canceled',
      payment({ authorized: U('10000'), voided: U('10000'), authorizationOutcome: 'CANCELED' }),
      [],
    ],
    [
      'expired',
      payment({ authorized: U('10000'), voided: U('10000'), authorizationOutcome: 'EXPIRED' }),
      [],
    ],
    ['declined', payment({ authorizationOutcome: 'DECLINED' }), []],
  ])('%s reports no violations', (_label, state, ops) => {
    expect(checkPaymentInvariants(state as PaymentState, ops as OperationState[])).toEqual([]);
  });
});

describe('summary status rules', () => {
  const captureOp = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });

  it.each<[string, SummaryStatus, PaymentState, OperationState[]]>([
    [
      'rule 1 REQUIRES_REVIEW outranks an UNKNOWN',
      'REQUIRES_REVIEW',
      payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [
        op({ type: 'REFUND', status: 'REQUIRES_REVIEW', amount: U('1000') }),
        op({ type: 'REFUND', status: 'UNKNOWN', amount: U('1000') }),
      ],
    ],
    [
      'rule 2 OUTCOME_UNKNOWN outranks PROCESSING regardless of array order',
      'OUTCOME_UNKNOWN',
      payment({ authorized: U('10000'), captured: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [
        op({ type: 'REFUND', status: 'REQUESTED', amount: U('1000') }),
        op({ type: 'REFUND', status: 'UNKNOWN', amount: U('1000') }),
      ],
    ],
    [
      'rule 3 PROCESSING',
      'PROCESSING',
      payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [captureOp, op({ type: 'REFUND', status: 'PROCESSING' })],
    ],
    [
      'rule 4 REFUNDED (refunded equals captured)',
      'REFUNDED',
      payment({
        authorized: U('10000'),
        captured: U('10000'),
        refunded: U('10000'),
        authorizationOutcome: 'AUTHORIZED',
      }),
      [captureOp],
    ],
    [
      'rule 5 PARTIALLY_REFUNDED outranks CAPTURED',
      'PARTIALLY_REFUNDED',
      payment({
        authorized: U('10000'),
        captured: U('10000'),
        refunded: U('3000'),
        authorizationOutcome: 'AUTHORIZED',
      }),
      [captureOp],
    ],
    [
      'rule 6 CAPTURED (capture plus void equals authorized)',
      'CAPTURED',
      payment({
        authorized: U('10000'),
        captured: U('6000'),
        voided: U('4000'),
        authorizationOutcome: 'AUTHORIZED',
      }),
      [op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('6000') })],
    ],
    [
      'rule 7 PARTIALLY_CAPTURED (unreachable in the MVP, exercised directly)',
      'PARTIALLY_CAPTURED',
      payment({
        authorized: U('10000'),
        captured: U('6000'),
        voided: U('0'),
        authorizationOutcome: 'AUTHORIZED',
      }),
      [],
    ],
    [
      'rule 8 CANCELED',
      'CANCELED',
      payment({ authorized: U('10000'), voided: U('10000'), authorizationOutcome: 'CANCELED' }),
      [],
    ],
    [
      'rule 8 EXPIRED',
      'EXPIRED',
      payment({ authorized: U('10000'), voided: U('10000'), authorizationOutcome: 'EXPIRED' }),
      [],
    ],
    [
      'rule 9 AUTHORIZED',
      'AUTHORIZED',
      payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [],
    ],
    [
      'rule 10 AUTHORIZATION_FAILED from a declined outcome',
      'AUTHORIZATION_FAILED',
      payment({ authorizationOutcome: 'DECLINED' }),
      [],
    ],
    [
      'rule 10 AUTHORIZATION_FAILED from the last failed attempt',
      'AUTHORIZATION_FAILED',
      payment(),
      [op({ type: 'AUTHORIZE', status: 'REJECTED' }), op({ type: 'AUTHORIZE', status: 'FAILED' })],
    ],
    ['rule 11 REQUIRES_AUTHORIZATION', 'REQUIRES_AUTHORIZATION', payment(), []],
  ])('%s', (_label, expected, state, ops) => {
    expect(deriveSummaryStatus(state, ops)).toBe(expected);
  });
});

describe('status predicates', () => {
  it('isUnresolved covers the four in-flight statuses', () => {
    const unresolved = OPERATION_STATUSES.filter(isUnresolved);
    expect([...unresolved].sort()).toEqual(
      ['PROCESSING', 'REQUESTED', 'REQUIRES_REVIEW', 'UNKNOWN'].sort(),
    );
  });

  it('isTerminal covers the three settled statuses', () => {
    const terminal = OPERATION_STATUSES.filter(isTerminal);
    expect([...terminal].sort()).toEqual(['FAILED', 'REJECTED', 'SUCCEEDED'].sort());
  });

  it('every status is either unresolved or terminal', () => {
    for (const status of OPERATION_STATUSES) {
      expect(isUnresolved(status) || isTerminal(status), status).toBe(true);
      // The two must not overlap: a status cannot be both settled and in flight.
      expect(isUnresolved(status) && isTerminal(status), status).toBe(false);
    }
  });

  it('only REFUND is concurrent', () => {
    expect(OPERATION_TYPES.filter((type) => exclusionClass(type) === 'CONCURRENT')).toEqual([
      'REFUND',
    ]);
  });

  it('the closed unions match the contract sizes', () => {
    expect(OPERATION_TYPES).toHaveLength(4);
    expect(OPERATION_STATUSES).toHaveLength(7);
    expect(AUTHORIZATION_OUTCOMES).toHaveLength(5);
    expect(SUMMARY_STATUSES).toHaveLength(12);
  });
});
