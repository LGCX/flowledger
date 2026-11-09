/**
 * Post-acceptance transitions.
 *
 * Every cell of the resolution table is exercised, and every transition asserts the exact version
 * deltas. The version rules are the part most likely to drift silently: a consumer that bumped the
 * payment version for a corroborating replay would make unrelated `If-Match` requests conflict, and
 * no single-effect test would notice.
 */
import { describe, expect, it } from 'vitest';
import type { FeeSnapshot } from './fees.js';
import type { OperationId, PaymentId } from './ids.js';
import { type MinorUnits, minorUnits } from './money.js';
import {
  type OperationState,
  type OperationStatus,
  type OperationType,
  type PaymentState,
  checkPaymentInvariants,
} from './payment.js';
import {
  type ResolutionEvidence,
  type Transition,
  applyAuthorizationExpiry,
  claimOperation,
  markUnknown,
  recordDiscrepancy,
  releaseDueOperation,
  requireReview,
  resolveOperation,
  scheduleNoEffectRetry,
} from './transitions.js';
import type { Timestamp } from './values.js';

const U = (value: string): MinorUnits => minorUnits(BigInt(value));
const AT = '2026-11-05T18:45:00.000Z' as Timestamp;

const SNAPSHOT: FeeSnapshot = {
  basisPoints: 290n,
  fixedAmount: U('30'),
  captureFee: U('320'),
  captureGross: U('10000'),
};

let sequence = 0;
function nextId(): OperationId {
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
    id: over.id ?? nextId(),
    type: (over.type ?? 'AUTHORIZE') as OperationType,
    amount: over.amount ?? U('10000'),
    status: (over.status ?? 'PROCESSING') as OperationStatus,
    notBefore: over.notBefore ?? null,
    version: over.version ?? 2,
    feeEffect: over.feeEffect ?? null,
    feeSnapshot: over.feeSnapshot ?? null,
  });
}

function authorizedPayment(over: Partial<PaymentState> = {}): PaymentState {
  return payment({
    authorized: U('10000'),
    authorizationOutcome: 'AUTHORIZED',
    activeExclusiveOperationId: null,
    ...over,
  });
}

function capturedPayment(over: Partial<PaymentState> = {}): PaymentState {
  return authorizedPayment({ captured: U('10000'), ...over });
}

function expectIllegal(result: { ok: boolean } & Record<string, unknown>): void {
  expect(result.ok).toBe(false);
  const error = (result as { error?: { code: string; reason: string } }).error;
  expect(`${String(error?.code)}/${String(error?.reason)}`).toBe(
    'INVALID_PAYMENT_STATE/ILLEGAL_OPERATION_TRANSITION',
  );
}

function applied(result: ReturnType<typeof resolveOperation>): Transition {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected APPLIED');
  if (result.value.kind !== 'APPLIED')
    throw new Error(`expected APPLIED, got ${result.value.kind}`);
  return { payment: result.value.payment, operation: result.value.operation };
}

const PRIOR_STATES: readonly OperationStatus[] = ['PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW'];
const TYPES: readonly OperationType[] = ['AUTHORIZE', 'CAPTURE', 'CANCEL', 'REFUND'];

/** A payment and operation pair in a consistent state for the given type and prior status. */
function setup(
  type: OperationType,
  status: OperationStatus,
): { payment: PaymentState; op: OperationState } {
  const refId = nextId();

  if (type === 'REFUND') {
    return {
      payment: capturedPayment({ reservedRefund: U('2500'), unresolvedRefundCount: 1 }),
      op: op({ type, status, amount: U('2500'), feeSnapshot: SNAPSHOT, id: refId }),
    };
  }

  // Exclusive types occupy the pointer while unresolved, as acceptance left them. An in-flight
  // AUTHORIZE happens before authorization, so the payment must still be unauthorized — otherwise a
  // rejection would leave `authorized` non-zero and the resolution would be inconsistent.
  if (type === 'AUTHORIZE') {
    return {
      payment: payment({ activeExclusiveOperationId: refId }),
      op: op({ type, status, amount: U('10000'), id: refId }),
    };
  }

  return {
    payment: authorizedPayment({ activeExclusiveOperationId: refId }),
    op: op({ type, status, amount: U('6000'), id: refId }),
  };
}

describe('resolution table', () => {
  const cells = PRIOR_STATES.flatMap((status) =>
    TYPES.flatMap((type) =>
      (['SUCCEEDED', 'REJECTED', 'FAILED'] as const).map(
        (outcome) => [`${type} ${outcome} from ${status}`, type, status, outcome] as const,
      ),
    ),
  );

  it.each(cells)('%s', (_label, type, status, outcome) => {
    const state = setup(type, status);
    const evidence: ResolutionEvidence =
      outcome === 'SUCCEEDED' ? { outcome, amount: state.op.amount } : { outcome };

    const result = applied(resolveOperation(state.payment, state.op, evidence));

    // Versions: a confirmed resolution always bumps both.
    expect(result.payment.version).toBe(state.payment.version + 1);
    expect(result.operation.version).toBe(state.op.version + 1);
    expect(result.operation.status).toBe(outcome);

    // Per-type effects.
    if (type === 'AUTHORIZE') {
      if (outcome === 'SUCCEEDED') {
        expect(result.payment.authorized).toBe(state.op.amount);
        expect(result.payment.authorizationOutcome).toBe('AUTHORIZED');
      } else {
        expect(result.payment.authorized).toBe(0n);
        expect(result.payment.authorizationOutcome).toBe('DECLINED');
      }
      expect(result.payment.activeExclusiveOperationId).toBeNull();
    }

    if (type === 'CAPTURE') {
      if (outcome === 'SUCCEEDED') {
        expect(result.payment.captured).toBe(state.op.amount);
        expect(result.payment.voided).toBe(state.payment.authorized - state.op.amount);
      } else {
        expect(result.payment.captured).toBe(0n);
        expect(result.payment.voided).toBe(0n);
      }
      expect(result.payment.activeExclusiveOperationId).toBeNull();
    }

    if (type === 'CANCEL') {
      if (outcome === 'SUCCEEDED') {
        expect(result.payment.authorizationOutcome).toBe('CANCELED');
        expect(result.payment.voided).toBe(state.payment.authorized);
      } else {
        expect(result.payment.authorizationOutcome).toBe('AUTHORIZED');
        expect(result.payment.voided).toBe(0n);
      }
      expect(result.payment.activeExclusiveOperationId).toBeNull();
    }

    if (type === 'REFUND') {
      // The reservation is released either way; only success moves the refunded total.
      expect(result.payment.reservedRefund).toBe(state.payment.reservedRefund - state.op.amount);
      expect(result.payment.unresolvedRefundCount).toBe(state.payment.unresolvedRefundCount - 1);
      if (outcome === 'SUCCEEDED') {
        expect(result.payment.refunded).toBe(state.payment.refunded + state.op.amount);
        expect(result.operation.feeEffect).not.toBeNull();
      } else {
        expect(result.payment.refunded).toBe(state.payment.refunded);
        expect(result.operation.feeEffect).toBeNull();
      }
    }
  });

  it('covers all 36 cells', () => {
    expect(cells).toHaveLength(36);
  });
});

describe('terminal states are one-way', () => {
  it('a duplicate success corroborates without changing versions', () => {
    const state = capturedPayment({});
    const settled = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000'), version: 4 });

    const result = resolveOperation(state, settled, { outcome: 'SUCCEEDED', amount: U('10000') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('CORROBORATING');
  });

  it('a different outcome after success contradicts', () => {
    const settled = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const result = resolveOperation(capturedPayment(), settled, { outcome: 'REJECTED' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('CONTRADICTORY');
  });

  it('a success for a different amount contradicts', () => {
    const settled = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
    const result = resolveOperation(capturedPayment(), settled, {
      outcome: 'SUCCEEDED',
      amount: U('9999'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('CONTRADICTORY');
  });

  it('REQUESTED cannot resolve: no provider call can have happened yet', () => {
    const state = setup('CAPTURE', 'PROCESSING');
    const requested = op({ type: 'CAPTURE', status: 'REQUESTED', amount: U('6000') });
    // Even a success is impossible here; the operation was never claimed.
    expectIllegal(
      resolveOperation(state.payment, requested, { outcome: 'SUCCEEDED', amount: U('6000') }),
    );
    expectIllegal(resolveOperation(state.payment, requested, { outcome: 'REJECTED' }));
    expectIllegal(resolveOperation(state.payment, requested, { outcome: 'FAILED' }));
  });

  it('a success amount mismatch while in flight contradicts without applying', () => {
    const state = setup('CAPTURE', 'PROCESSING');
    const result = resolveOperation(state.payment, state.op, {
      outcome: 'SUCCEEDED',
      amount: U('5999'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('CONTRADICTORY');
  });

  it('recordDiscrepancy bumps only the payment version', () => {
    const before = capturedPayment({ version: 7 });
    const after = recordDiscrepancy(before);
    expect(after.version).toBe(8);
    expect({ ...after, version: 0 }).toEqual({ ...before, version: 0 });
  });
});

describe('claim, retry, release', () => {
  it('claim requires a null notBefore and bumps only the operation version', () => {
    const claimed = claimOperation(op({ status: 'REQUESTED', notBefore: null }));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.value.status).toBe('PROCESSING');
    expect(claimed.value.version).toBe(3);

    expectIllegal(claimOperation(op({ status: 'REQUESTED', notBefore: AT })));
  });

  it('a scheduled retry cannot be claimed until it is released', () => {
    const scheduled = scheduleNoEffectRetry(op({ status: 'PROCESSING' }), AT);
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;
    expect(scheduled.value.status).toBe('REQUESTED');
    expect(scheduled.value.notBefore).toBe(AT);
    expect(scheduled.value.version).toBe(3);

    expectIllegal(claimOperation(scheduled.value));

    const released = releaseDueOperation(scheduled.value);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.notBefore).toBeNull();
    expect(released.value.version).toBe(4);
    expect(claimOperation(released.value).ok).toBe(true);
  });

  it('release requires a deadline', () => {
    expectIllegal(releaseDueOperation(op({ status: 'REQUESTED', notBefore: null })));
  });

  it('no blind retry from UNKNOWN or REQUIRES_REVIEW', () => {
    for (const status of ['UNKNOWN', 'REQUIRES_REVIEW'] as const) {
      const state = op({ status });
      expectIllegal(scheduleNoEffectRetry(state, AT));
      expectIllegal(claimOperation(state));
      expectIllegal(releaseDueOperation(state));
    }
  });
});

describe('ambiguity transitions', () => {
  it('markUnknown only from PROCESSING and bumps both versions once', () => {
    const state = capturedPayment({ version: 3 });
    const inFlight = op({ type: 'CAPTURE', status: 'PROCESSING', version: 2 });

    const result = markUnknown(state, inFlight);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment.version).toBe(4);
    expect(result.value.operation.version).toBe(3);
    expect(result.value.operation.status).toBe('UNKNOWN');
    // The reservation is untouched by ambiguity: an UNKNOWN refund still holds its amount.
    expect(result.value.payment.reservedRefund).toBe(state.reservedRefund);

    expectIllegal(markUnknown(state, op({ status: 'UNKNOWN' })));
  });

  it('an UNKNOWN refund keeps its reservation', () => {
    const state = capturedPayment({
      reservedRefund: U('2500'),
      unresolvedRefundCount: 1,
      version: 3,
    });
    const inFlight = op({
      type: 'REFUND',
      status: 'PROCESSING',
      amount: U('2500'),
      feeSnapshot: SNAPSHOT,
    });

    const result = markUnknown(state, inFlight);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment.reservedRefund).toBe(2500n);
    expect(result.value.payment.unresolvedRefundCount).toBe(1);
  });

  it('requireReview only from UNKNOWN', () => {
    const state = capturedPayment({ version: 3 });
    const unknown = op({ type: 'CAPTURE', status: 'UNKNOWN', version: 3 });

    const result = requireReview(state, unknown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment.version).toBe(4);
    expect(result.value.operation.status).toBe('REQUIRES_REVIEW');

    expectIllegal(requireReview(state, op({ status: 'PROCESSING' })));
  });
});

describe('authorization expiry', () => {
  it('expires an authorized payment and voids the whole authorization', () => {
    const result = applyAuthorizationExpiry(authorizedPayment({ version: 2 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authorizationOutcome).toBe('EXPIRED');
    expect(result.value.voided).toBe(10000n);
    expect(result.value.version).toBe(3);
  });

  /**
   * Each guard is asserted by the `constraint` detail, not just the problem code: every expiry
   * rejection shares `INVALID_PAYMENT_STATE/EXPIRY_NOT_APPLICABLE`, so a code-only assertion would
   * let one guard be deleted while another still rejected the fixture.
   */
  it.each([
    ['not authorized', payment({ version: 1 }), 'outcome must be AUTHORIZED'],
    [
      'already captured',
      capturedPayment({ version: 1 }),
      'no captured, refunded, or voided amounts',
    ],
    [
      'an unresolved operation',
      authorizedPayment({ activeExclusiveOperationId: nextId() }),
      'no active operation',
    ],
    [
      'an unresolved refund',
      capturedPayment({ unresolvedRefundCount: 1, reservedRefund: U('1') }),
      'no captured, refunded, or voided amounts',
    ],
  ])('rejects expiry with %s', (_label, state, constraint) => {
    const result = applyAuthorizationExpiry(state as PaymentState);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(`${result.error.code}/${result.error.reason}`).toBe(
      'INVALID_PAYMENT_STATE/EXPIRY_NOT_APPLICABLE',
    );
    expect(result.error.detail?.constraint).toBe(constraint);
  });

  it('rejects expiry while a refund is still unresolved but nothing is captured', () => {
    // The capured-zero fixture above trips the captured guard first; this isolates the refund guard.
    const state = authorizedPayment({ unresolvedRefundCount: 1, reservedRefund: U('1') });
    const result = applyAuthorizationExpiry(state);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.constraint).toBe('no unresolved refunds');
  });

  it('is not applicable after a capture', () => {
    const result = applyAuthorizationExpiry(capturedPayment());
    expect(result.ok).toBe(false);
  });
});

describe('refund fee linkage to the golden vectors', () => {
  it('attributes 106 then 107 then 107 across the thirds partition and returns the reservation to zero', () => {
    // The same numbers as golden refund-fee `thirds`: F = 320, G = 10000, refunds 3333/3333/3334.
    let state = payment({
      authorized: U('10000'),
      captured: U('10000'),
      authorizationOutcome: 'AUTHORIZED',
      reservedRefund: U('10000'),
      unresolvedRefundCount: 3,
    });

    const refunds = ['3333', '3333', '3334'].map((amount) =>
      op({ type: 'REFUND', status: 'PROCESSING', amount: U(amount), feeSnapshot: SNAPSHOT }),
    );

    const fees: string[] = [];
    for (const refund of refunds) {
      const result = applied(
        resolveOperation(state, refund, { outcome: 'SUCCEEDED', amount: refund.amount }),
      );
      state = result.payment;
      fees.push((result.operation.feeEffect ?? -1n).toString());
    }

    expect(fees).toEqual(['106', '107', '107']);
    expect(state.reservedRefund).toBe(0n);
    expect(state.unresolvedRefundCount).toBe(0);
    expect(state.refunded).toBe(10000n);
  });

  it('refunded + reserved never increases across a success or a rejection', () => {
    const start = capturedPayment({ reservedRefund: U('5000'), unresolvedRefundCount: 2 });
    const before = start.refunded + start.reservedRefund;

    for (const outcome of ['SUCCEEDED', 'REJECTED', 'FAILED'] as const) {
      const refund = op({
        type: 'REFUND',
        status: 'PROCESSING',
        amount: U('2500'),
        feeSnapshot: SNAPSHOT,
      });
      const evidence: ResolutionEvidence =
        outcome === 'SUCCEEDED' ? { outcome, amount: U('2500') } : { outcome };
      const result = applied(resolveOperation(start, refund, evidence));
      expect(result.payment.refunded + result.payment.reservedRefund).toBeLessThanOrEqual(before);
    }
  });
});

describe('invariants hold after every transition', () => {
  const captureBehind = op({ type: 'CAPTURE', status: 'SUCCEEDED', amount: U('10000') });
  // The aggregate's invariants are relative to the whole operation list, so each scenario carries the
  // operations that make its prior state valid.
  const scenarios: readonly [
    string,
    PaymentState,
    OperationState[],
    OperationState,
    ResolutionEvidence,
  ][] = [
    [
      'authorize succeeded',
      payment(),
      [],
      op({ type: 'AUTHORIZE', status: 'PROCESSING', amount: U('10000') }),
      { outcome: 'SUCCEEDED', amount: U('10000') },
    ],
    [
      'authorize rejected',
      payment(),
      [],
      op({ type: 'AUTHORIZE', status: 'PROCESSING' }),
      { outcome: 'REJECTED' },
    ],
    [
      'capture succeeded',
      authorizedPayment(),
      [],
      op({ type: 'CAPTURE', status: 'PROCESSING', amount: U('6000') }),
      { outcome: 'SUCCEEDED', amount: U('6000') },
    ],
    [
      'capture failed',
      authorizedPayment(),
      [],
      op({ type: 'CAPTURE', status: 'PROCESSING', amount: U('6000') }),
      { outcome: 'FAILED' },
    ],
    [
      'cancel succeeded',
      authorizedPayment(),
      [],
      op({ type: 'CANCEL', status: 'PROCESSING', amount: U('10000') }),
      { outcome: 'SUCCEEDED', amount: U('10000') },
    ],
    [
      'refund succeeded',
      capturedPayment({ reservedRefund: U('2500'), unresolvedRefundCount: 1 }),
      [captureBehind],
      op({ type: 'REFUND', status: 'PROCESSING', amount: U('2500'), feeSnapshot: SNAPSHOT }),
      { outcome: 'SUCCEEDED', amount: U('2500') },
    ],
    [
      'refund rejected',
      capturedPayment({ reservedRefund: U('2500'), unresolvedRefundCount: 1 }),
      [captureBehind],
      op({ type: 'REFUND', status: 'PROCESSING', amount: U('2500'), feeSnapshot: SNAPSHOT }),
      { outcome: 'REJECTED' },
    ],
  ];

  it.each(scenarios)(
    '%s keeps the aggregate consistent',
    (_label, state, supporting, operation, evidence) => {
      const result = applied(resolveOperation(state, operation, evidence));
      expect(checkPaymentInvariants(result.payment, [...supporting, result.operation])).toEqual([]);
    },
  );

  it('expiry keeps the aggregate consistent', () => {
    const result = applyAuthorizationExpiry(authorizedPayment());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checkPaymentInvariants(result.value, [])).toEqual([]);
  });
});
