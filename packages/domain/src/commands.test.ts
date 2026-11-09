/**
 * Command acceptance.
 *
 * Every expected-behaviour case asserts both `code` and `reason`. That matters most for the refund
 * race loser: it must fail on `REFUND_EXCEEDS_REFUNDABLE` (the monetary guard), not on
 * `ACTIVE_OPERATION_EXISTS` or a lifecycle guard, because the docs are explicit that a refund that
 * loses the race is rejected by the reservation guard.
 *
 * After every successful acceptance the resulting state is run through `checkPaymentInvariants`;
 * a guard set that is individually correct but leaves the aggregate inconsistent would otherwise
 * pass.
 */
import { describe, expect, it } from 'vitest';
import { type Acceptance, type CommandRequest, acceptCommand } from './commands.js';
import { type FeePolicyInputs, type FeeSnapshot } from './fees.js';
import type { OperationId, PaymentId } from './ids.js';
import { type MinorUnits, minorUnits } from './money.js';
import {
  type OperationState,
  type OperationStatus,
  type OperationType,
  type PaymentState,
  checkPaymentInvariants,
} from './payment.js';

const U = (value: string): MinorUnits => minorUnits(BigInt(value));

const SNAPSHOT: FeeSnapshot = {
  basisPoints: 290n,
  fixedAmount: U('30'),
  captureFee: U('320'),
  captureGross: U('10000'),
};

const POLICY: FeePolicyInputs = {
  basisPoints: 290n,
  fixedAmount: U('30'),
  minimumCaptureAmount: U('31'),
};

let sequence = 0;
function nextOpId(): OperationId {
  sequence += 1;
  return `op_01ARZ3NDEKTSV4RRFFQ69G5F${String.fromCharCode(65 + (sequence % 26))}${String.fromCharCode(65 + Math.floor(sequence / 26))}` as OperationId;
}

function payment(over: Partial<PaymentState> = {}): PaymentState {
  return Object.freeze({
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
  });
}

function op(over: Partial<OperationState> = {}): OperationState {
  return Object.freeze({
    id: over.id ?? nextOpId(),
    type: (over.type ?? 'AUTHORIZE') as OperationType,
    amount: over.amount ?? U('10000'),
    status: (over.status ?? 'SUCCEEDED') as OperationStatus,
    notBefore: over.notBefore ?? null,
    version: over.version ?? 1,
    feeEffect: over.feeEffect ?? null,
    feeSnapshot: over.feeSnapshot ?? null,
  });
}

/** A payment with a confirmed full capture — the starting point for refund cases. */
function capturedPayment(over: Partial<PaymentState> = {}): PaymentState {
  return payment({
    authorized: U('10000'),
    captured: U('10000'),
    authorizationOutcome: 'AUTHORIZED',
    ...over,
  });
}

const CAPTURE_OP = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });

function expectFailure(result: Result, code: string, reason: string): void {
  expect(result.ok, 'expected a failure').toBe(false);
  if (result.ok) return;
  expect(`${result.error.code}/${result.error.reason}`).toBe(`${code}/${reason}`);
}

type Result = ReturnType<typeof acceptCommand>;

function accepted(result: Result): Acceptance {
  if (!result.ok)
    throw new Error(`expected acceptance, got ${result.error.code}/${result.error.reason}`);
  return result.value;
}

describe('refund acceptance and the reservation', () => {
  it('accumulates the reservation across concurrent refunds', () => {
    const first = accepted(
      acceptCommand(
        capturedPayment(),
        [CAPTURE_OP],
        { type: 'REFUND', amount: U('6000'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );
    expect(first.payment.reservedRefund).toBe(6000n);
    expect(first.payment.unresolvedRefundCount).toBe(1);
    expect(first.payment.version).toBe(2);

    const second = accepted(
      acceptCommand(
        first.payment,
        [CAPTURE_OP, first.operation],
        { type: 'REFUND', amount: U('4000'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );
    expect(second.payment.reservedRefund).toBe(10000n);
    expect(second.payment.unresolvedRefundCount).toBe(2);
  });

  it('the race loser fails on the monetary guard, not on state', () => {
    const full = accepted(
      acceptCommand(
        capturedPayment(),
        [CAPTURE_OP],
        { type: 'REFUND', amount: U('10000'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );
    expectFailure(
      acceptCommand(
        full.payment,
        [CAPTURE_OP, full.operation],
        { type: 'REFUND', amount: U('1'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
      'MONETARY_GUARD_FAILED',
      'REFUND_EXCEEDS_REFUNDABLE',
    );
  });

  it('a refund equal to the remaining refundable amount is accepted', () => {
    const partial = accepted(
      acceptCommand(
        capturedPayment(),
        [CAPTURE_OP],
        { type: 'REFUND', amount: U('4000'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );
    const rest = accepted(
      acceptCommand(
        partial.payment,
        [CAPTURE_OP, partial.operation],
        { type: 'REFUND', amount: U('6000'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );
    expect(rest.payment.reservedRefund).toBe(10000n);
  });

  it('refund copies the capture snapshot and carries no fee effect at acceptance', () => {
    const result = accepted(
      acceptCommand(
        capturedPayment(),
        [CAPTURE_OP],
        { type: 'REFUND', amount: U('2500'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );
    expect(result.operation.feeEffect).toBeNull();
    expect(result.operation.feeSnapshot).toEqual(SNAPSHOT);
    // Copied, not aliased: mutating the source must not affect the operation.
    expect(result.operation.feeSnapshot).not.toBe(SNAPSHOT);
  });

  it('refund requires something captured', () => {
    expectFailure(
      acceptCommand(
        payment({ authorizationOutcome: 'AUTHORIZED', authorized: U('10000') }),
        [],
        { type: 'REFUND', amount: U('1'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });
});

describe('exclusion guards', () => {
  it('an unresolved refund blocks AUTHORIZE, CAPTURE and CANCEL', () => {
    const withRefund = payment({
      authorized: U('10000'),
      captured: U('10000'),
      authorizationOutcome: 'AUTHORIZED',
      reservedRefund: U('1000'),
      unresolvedRefundCount: 1,
    });

    for (const request of [
      { type: 'AUTHORIZE' },
      { type: 'CAPTURE', amount: U('1'), feePolicy: POLICY },
      { type: 'CANCEL' },
    ] as CommandRequest[]) {
      expectFailure(
        acceptCommand(withRefund, [], request, nextOpId()),
        'ACTIVE_OPERATION_EXISTS',
        'REFUND_UNRESOLVED',
      );
    }
  });

  it('an unresolved exclusive operation blocks even a refund', () => {
    const busy = payment({
      authorized: U('10000'),
      captured: U('10000'),
      authorizationOutcome: 'AUTHORIZED',
      activeExclusiveOperationId: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAY' as OperationId,
    });
    expectFailure(
      acceptCommand(
        busy,
        [],
        { type: 'REFUND', amount: U('1'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
      'ACTIVE_OPERATION_EXISTS',
      'EXCLUSIVE_OPERATION_UNRESOLVED',
    );
  });
});

describe('authorize guards', () => {
  it.each(['AUTHORIZED', 'CANCELED', 'EXPIRED'] as const)(
    'rejects AUTHORIZE when the outcome is %s',
    (outcome) => {
      expectFailure(
        acceptCommand(
          payment({ authorizationOutcome: outcome }),
          [],
          { type: 'AUTHORIZE' },
          nextOpId(),
        ),
        'INVALID_PAYMENT_STATE',
        'GUARD_FAILED',
      );
    },
  );

  it('rejects AUTHORIZE when any confirmed total is non-zero', () => {
    expectFailure(
      acceptCommand(
        payment({ authorized: U('1'), authorizationOutcome: 'DECLINED' }),
        [],
        { type: 'AUTHORIZE' },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });

  it('accepts a retry after a REJECTED attempt', () => {
    const previous = op({ type: 'AUTHORIZE', status: 'REJECTED' });
    const result = acceptCommand(
      payment({ authorizationOutcome: 'DECLINED' }),
      [previous],
      { type: 'AUTHORIZE' },
      nextOpId(),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a retry after a FAILED attempt while the outcome is still NOT_REQUESTED', () => {
    const previous = op({ type: 'AUTHORIZE', status: 'FAILED' });
    expect(acceptCommand(payment(), [previous], { type: 'AUTHORIZE' }, nextOpId()).ok).toBe(true);
  });

  it('rejects a fourth attempt', () => {
    const attempts = [
      op({ type: 'AUTHORIZE', status: 'REJECTED' }),
      op({ type: 'AUTHORIZE', status: 'REJECTED' }),
      op({ type: 'AUTHORIZE', status: 'REJECTED' }),
    ];
    expectFailure(
      acceptCommand(
        payment({ authorizationOutcome: 'DECLINED' }),
        attempts,
        { type: 'AUTHORIZE' },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'AUTHORIZATION_ATTEMPTS_EXHAUSTED',
    );
  });

  it('the authorized amount is the requested amount', () => {
    const result = accepted(acceptCommand(payment(), [], { type: 'AUTHORIZE' }, nextOpId()));
    expect(result.operation.amount).toBe(10000n);
    expect(result.operation.feeEffect).toBeNull();
    expect(result.operation.feeSnapshot).toBeNull();
  });
});

describe('capture guards', () => {
  const authorized = (over: Partial<PaymentState> = {}): PaymentState =>
    payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED', ...over });

  it('rejects a capture that exceeds the authorization', () => {
    expectFailure(
      acceptCommand(
        authorized(),
        [],
        { type: 'CAPTURE', amount: U('10001'), feePolicy: POLICY },
        nextOpId(),
      ),
      'MONETARY_GUARD_FAILED',
      'CAPTURE_EXCEEDS_AUTHORIZED',
    );
  });

  it('rejects a capture below the policy minimum', () => {
    // bp 0, fixed 30, minimum 30: 29 is below the minimum.
    const belowPolicy: FeePolicyInputs = {
      basisPoints: 0n,
      fixedAmount: U('30'),
      minimumCaptureAmount: U('30'),
    };
    expectFailure(
      acceptCommand(
        authorized(),
        [],
        { type: 'CAPTURE', amount: U('29'), feePolicy: belowPolicy },
        nextOpId(),
      ),
      'CAPTURE_BELOW_MINIMUM',
      'BELOW_MINIMUM_CAPTURE',
    );
  });

  it('accepts exactly the minimum and snapshots the fee', () => {
    const belowPolicy: FeePolicyInputs = {
      basisPoints: 0n,
      fixedAmount: U('30'),
      minimumCaptureAmount: U('30'),
    };
    const result = accepted(
      acceptCommand(
        authorized(),
        [],
        { type: 'CAPTURE', amount: U('30'), feePolicy: belowPolicy },
        nextOpId(),
      ),
    );
    expect(result.operation.feeEffect).toBe(30n);
    expect(result.operation.feeSnapshot).toEqual({
      basisPoints: 0n,
      fixedAmount: U('30'),
      captureFee: U('30'),
      captureGross: U('30'),
    });
  });

  it('rejects a capture when the payment is not authorized', () => {
    expectFailure(
      acceptCommand(
        payment(),
        [],
        { type: 'CAPTURE', amount: U('1'), feePolicy: POLICY },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });

  it('rejects a second capture attempt after one succeeded', () => {
    expectFailure(
      acceptCommand(
        authorized({ captured: U('10000') }),
        [CAPTURE_OP],
        { type: 'CAPTURE', amount: U('1'), feePolicy: POLICY },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });

  it('rejects a capture once refunds exist', () => {
    expectFailure(
      acceptCommand(
        authorized({ captured: U('10000'), refunded: U('1000') }),
        [CAPTURE_OP],
        { type: 'CAPTURE', amount: U('1'), feePolicy: POLICY },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });
});

describe('cancel guards', () => {
  it('accepts a cancel while authorized and cancels the full authorization', () => {
    const result = accepted(
      acceptCommand(
        payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
        [],
        { type: 'CANCEL' },
        nextOpId(),
      ),
    );
    expect(result.operation.amount).toBe(10000n);
  });

  it('rejects a cancel when not authorized', () => {
    expectFailure(
      acceptCommand(payment(), [], { type: 'CANCEL' }, nextOpId()),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });

  it('rejects a cancel once captured', () => {
    expectFailure(
      acceptCommand(
        payment({
          authorized: U('10000'),
          captured: U('10000'),
          authorizationOutcome: 'AUTHORIZED',
        }),
        [CAPTURE_OP],
        { type: 'CANCEL' },
        nextOpId(),
      ),
      'INVALID_PAYMENT_STATE',
      'GUARD_FAILED',
    );
  });
});

describe('effects and immutability', () => {
  it('increments the payment version by exactly one', () => {
    const before = payment();
    const after = accepted(acceptCommand(before, [], { type: 'AUTHORIZE' }, nextOpId()));
    expect(after.payment.version).toBe(before.version + 1);
  });

  it('sets the exclusive pointer for exclusive types and leaves it for refunds', () => {
    const id = nextOpId();
    const authorized = accepted(acceptCommand(payment(), [], { type: 'AUTHORIZE' }, id));
    expect(authorized.payment.activeExclusiveOperationId).toBe(id);

    const refundId = nextOpId();
    const refunded = accepted(
      acceptCommand(
        capturedPayment(),
        [CAPTURE_OP],
        { type: 'REFUND', amount: U('1000'), captureFeeSnapshot: SNAPSHOT },
        refundId,
      ),
    );
    expect(refunded.payment.activeExclusiveOperationId).toBeNull();
  });

  it('returns frozen objects and never mutates its arguments', () => {
    const before = capturedPayment();
    const opsBefore = [CAPTURE_OP];
    const snapshot = structuredClone(before);
    const opsSnapshot = structuredClone(opsBefore);

    const result = accepted(
      acceptCommand(
        before,
        opsBefore,
        { type: 'REFUND', amount: U('1000'), captureFeeSnapshot: SNAPSHOT },
        nextOpId(),
      ),
    );

    expect(before).toEqual(snapshot);
    expect(opsBefore).toEqual(opsSnapshot);
    expect(Object.isFrozen(result.payment)).toBe(true);
    expect(Object.isFrozen(result.operation)).toBe(true);
  });

  it('leaves confirmed totals and the outcome untouched at acceptance', () => {
    const before = payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' });
    const after = accepted(
      acceptCommand(
        before,
        [],
        { type: 'CAPTURE', amount: U('5000'), feePolicy: POLICY },
        nextOpId(),
      ),
    );
    expect(after.payment.captured).toBe(before.captured);
    expect(after.payment.authorizationOutcome).toBe('AUTHORIZED');
  });
});

const VALID_PRIORS: readonly [string, PaymentState, OperationState[]][] = [
  ['fresh', payment(), []],
  [
    'declined',
    payment({ authorizationOutcome: 'DECLINED' }),
    [op({ type: 'AUTHORIZE', status: 'REJECTED' })],
  ],
  [
    'authorized',
    payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
    [op({ type: 'AUTHORIZE', status: 'SUCCEEDED' })],
  ],
  ['captured', capturedPayment(), [CAPTURE_OP]],
  [
    'refunded-with-reservation',
    capturedPayment({ refunded: U('3000'), reservedRefund: U('2000'), unresolvedRefundCount: 1 }),
    [
      CAPTURE_OP,
      op({ type: 'REFUND', status: 'UNKNOWN', amount: U('2000') }),
      op({
        type: 'REFUND',
        status: 'SUCCEEDED',
        amount: U('3000'),
        feeEffect: U('96'),
        feeSnapshot: SNAPSHOT,
      }),
    ],
  ],
];

const REQUESTS: readonly CommandRequest[] = [
  { type: 'AUTHORIZE' },
  { type: 'CAPTURE', amount: U('5000'), feePolicy: POLICY },
  { type: 'CANCEL' },
  { type: 'REFUND', amount: U('1000'), captureFeeSnapshot: SNAPSHOT },
  { type: 'REFUND', amount: U('100000'), captureFeeSnapshot: SNAPSHOT },
];

describe('acceptance preserves the invariants', () => {
  const cases = VALID_PRIORS.flatMap(([label, state, ops]) =>
    REQUESTS.map(
      (request, index) =>
        [`${label} + ${request.type} #${String(index)}`, state, ops, request] as const,
    ),
  );

  it.each(cases)('%s', (_label, state, ops, request) => {
    const result = acceptCommand(state, ops, request, nextOpId());
    if (!result.ok) return;

    expect(checkPaymentInvariants(result.value.payment, [...ops, result.value.operation])).toEqual(
      [],
    );
  });

  it('every prior state is itself valid, so the property is meaningful', () => {
    for (const [label, state, ops] of VALID_PRIORS) {
      expect(checkPaymentInvariants(state, ops), label).toEqual([]);
    }
  });
});

describe('audit regressions (P02 review)', () => {
  it('refuses a zero refund before any state guard', () => {
    const result = acceptCommand(
      capturedPayment(),
      [],
      { type: 'REFUND', amount: U('0'), captureFeeSnapshot: SNAPSHOT },
      nextOpId(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(`${result.error.code}/${result.error.reason}`).toBe(
      'INVALID_AMOUNT/AMOUNT_NOT_POSITIVE',
    );
  });

  it('refuses a zero capture as INVALID_AMOUNT, not CAPTURE_BELOW_MINIMUM', () => {
    const result = acceptCommand(
      payment({ authorized: U('10000'), authorizationOutcome: 'AUTHORIZED' }),
      [op({ type: 'AUTHORIZE', status: 'SUCCEEDED' })],
      { type: 'CAPTURE', amount: U('0'), feePolicy: POLICY },
      nextOpId(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(`${result.error.code}/${result.error.reason}`).toBe(
      'INVALID_AMOUNT/AMOUNT_NOT_POSITIVE',
    );
  });
});
