/**
 * Model-based lifecycle properties (docs/03 §Required model tests, docs/09 §Property and model-based
 * tests).
 *
 * A generated command/result sequence is applied step by step and *every* monetary invariant, version
 * rule, and fee property is asserted after each step. That is different from asserting them once at
 * the end: an intermediate state that breaks an invariant and is then "repaired" by a later action is
 * still a state a consumer or a database row would have observed.
 *
 * Three things the oracles encode that are easy to lose:
 *
 *   - A rejected action must be a complete no-op. An invalid command that still created an operation
 *     or bumped a version would let a client conflict-spam a payment.
 *   - `refunded + reservedRefund` never increases on a resolution. That bound is the whole refund
 *     safety argument: a reservation released on a rejection must not free more than it held.
 *   - The fee reversed across all successful refunds never exceeds the capture fee, and equals it
 *     exactly once everything is refunded. Partial over-reversal is the failure mode a per-refund
 *     formula would produce.
 *
 * Failing cases are persisted to `reports/property-failures.jsonl` with their seed and minimized
 * counterexample by the harness from P01-T01, and the seed is fixed by `FC_SEED`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { acceptCommand } from './commands.js';
import {
  type FeePolicyInputs,
  type FeeSnapshot,
  checkFeePolicy,
  computeCaptureFee,
} from './fees.js';
import type { OperationId, PaymentId } from './ids.js';
import { type MinorUnits, minorUnits } from './money.js';
import {
  type OperationState,
  type OperationStatus,
  type PaymentState,
  checkPaymentInvariants,
  isUnresolved,
} from './payment.js';
import {
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

const U = (value: bigint | string): MinorUnits =>
  minorUnits(typeof value === 'bigint' ? value : BigInt(value));

const RETRY_AT = '2026-11-05T18:45:00.000Z' as Timestamp;

interface Model {
  readonly payment: PaymentState;
  readonly ops: readonly OperationState[];
}

function createdPayment(requested: MinorUnits): PaymentState {
  return Object.freeze({
    id: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV' as PaymentId,
    requested,
    authorized: U(0n),
    captured: U(0n),
    refunded: U(0n),
    voided: U(0n),
    reservedRefund: U(0n),
    unresolvedRefundCount: 0,
    authorizationOutcome: 'NOT_REQUESTED',
    activeExclusiveOperationId: null,
    version: 1,
  });
}

let idCounter = 0;
function freshId(): OperationId {
  idCounter += 1;
  const a = String.fromCharCode(65 + (idCounter % 26));
  const b = String.fromCharCode(65 + (Math.floor(idCounter / 26) % 26));
  return `op_01ARZ3NDEKTSV4RRFFQ69G5F${a}${b}` as OperationId;
}

/**
 * Capture and refund amounts are generated relative to the state they act on (`permille` of the
 * authorized or refundable amount, up to 110 % so over-limit requests stay common). Absolute random
 * amounts almost never fit a payment, which is part of why the original walk never captured.
 */
type Action =
  | { readonly kind: 'ACCEPT_AUTHORIZE' }
  | { readonly kind: 'ACCEPT_CAPTURE'; readonly permille: bigint }
  | { readonly kind: 'ACCEPT_CANCEL' }
  | { readonly kind: 'ACCEPT_REFUND'; readonly permille: bigint }
  /**
   * Drives the oldest open operation one step: release a scheduled retry, claim a requested one, or
   * resolve a claimed one with the operation's exact amount. Rewritten to the concrete action before
   * it runs, so every oracle below sees an ordinary action.
   */
  | { readonly kind: 'ADVANCE'; readonly outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED' }
  | { readonly kind: 'CLAIM'; readonly index: number }
  | { readonly kind: 'RETRY'; readonly index: number }
  | { readonly kind: 'RELEASE'; readonly index: number }
  | { readonly kind: 'MARK_UNKNOWN'; readonly index: number }
  | { readonly kind: 'REQUIRE_REVIEW'; readonly index: number }
  | {
      readonly kind: 'RESOLVE';
      readonly index: number;
      readonly outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED';
      readonly delta: bigint;
    }
  | { readonly kind: 'EXPIRE' }
  | { readonly kind: 'DUPLICATE'; readonly index: number };

/** Which payment-version delta a successful step must produce. */
function expectedPaymentDelta(action: Action, applied: boolean, kind?: string): number {
  switch (action.kind) {
    case 'ACCEPT_AUTHORIZE':
    case 'ACCEPT_CAPTURE':
    case 'ACCEPT_CANCEL':
    case 'ACCEPT_REFUND':
    case 'MARK_UNKNOWN':
    case 'REQUIRE_REVIEW':
    case 'EXPIRE':
      return applied ? 1 : 0;
    case 'RESOLVE':
      if (!applied) return 0; // rejected or contradictory-never-applied
      return kind === 'CORROBORATING' ? 0 : 1;
    default:
      // Claim, retry, release, and duplicate resolution are operation bookkeeping.
      return 0;
  }
}

interface StepResult {
  readonly model: Model;
  readonly ok: boolean;
  readonly resolutionKind?: string;
}

function replaceOp(ops: readonly OperationState[], next: OperationState): OperationState[] {
  return ops.map((operation) => (operation.id === next.id ? next : operation));
}

function step(model: Model, action: Action, policy: FeePolicyInputs): StepResult {
  const { payment, ops } = model;

  switch (action.kind) {
    case 'ACCEPT_AUTHORIZE':
    case 'ACCEPT_CAPTURE':
    case 'ACCEPT_CANCEL':
    case 'ACCEPT_REFUND': {
      const id = freshId();
      const request =
        action.kind === 'ACCEPT_AUTHORIZE'
          ? ({ type: 'AUTHORIZE' } as const)
          : action.kind === 'ACCEPT_CANCEL'
            ? ({ type: 'CANCEL' } as const)
            : action.kind === 'ACCEPT_CAPTURE'
              ? ({
                  type: 'CAPTURE',
                  amount: relativeAmount(captureBase(payment), action.permille),
                  feePolicy: policy,
                } as const)
              : ({
                  type: 'REFUND',
                  amount: relativeAmount(refundBase(payment), action.permille),
                  captureFeeSnapshot: snapshotOf(ops),
                } as const);

      if (request.type === 'REFUND' && request.captureFeeSnapshot === null) {
        return { model, ok: false };
      }

      const result = acceptCommand(
        payment,
        ops,
        request.type === 'REFUND'
          ? {
              type: 'REFUND',
              amount: request.amount,
              captureFeeSnapshot: request.captureFeeSnapshot as FeeSnapshot,
            }
          : request,
        id,
      );
      if (!result.ok) return { model, ok: false };

      const acceptedModel: Model = {
        payment: result.value.payment,
        ops: [...ops, result.value.operation],
      };

      // An accepted exclusive command implies no unresolved refund was outstanding.
      if (result.value.operation.type !== 'REFUND') {
        expect(
          ops.filter((operation) => operation.type === 'REFUND' && isUnresolved(operation.status)),
        ).toHaveLength(0);
      }
      return { model: acceptedModel, ok: true };
    }

    case 'CLAIM':
    case 'RETRY':
    case 'RELEASE': {
      const target = ops[action.index % Math.max(ops.length, 1)];
      if (target === undefined) return { model, ok: false };

      const result =
        action.kind === 'CLAIM'
          ? claimOperation(target)
          : action.kind === 'RETRY'
            ? scheduleNoEffectRetry(target, RETRY_AT)
            : releaseDueOperation(target);
      if (!result.ok) return { model, ok: false };
      return { model: { payment, ops: replaceOp(ops, result.value) }, ok: true };
    }

    case 'MARK_UNKNOWN':
    case 'REQUIRE_REVIEW': {
      const target = ops[action.index % Math.max(ops.length, 1)];
      if (target === undefined) return { model, ok: false };
      const result =
        action.kind === 'MARK_UNKNOWN'
          ? markUnknown(payment, target)
          : requireReview(payment, target);
      if (!result.ok) return { model, ok: false };
      return {
        model: { payment: result.value.payment, ops: replaceOp(ops, result.value.operation) },
        ok: true,
      };
    }

    case 'RESOLVE':
    case 'DUPLICATE': {
      const target = ops[action.index % Math.max(ops.length, 1)];
      if (target === undefined) return { model, ok: false };

      const outcome = action.kind === 'DUPLICATE' ? terminalOutcomeOf(target) : action.outcome;
      if (outcome === undefined) return { model, ok: false };

      const evidence =
        outcome === 'SUCCEEDED'
          ? ({
              outcome: 'SUCCEEDED',
              amount: U(target.amount + (action.kind === 'RESOLVE' ? action.delta : 0n)),
            } as const)
          : ({ outcome } as const);

      const result = resolveOperation(payment, target, evidence);
      if (!result.ok) return { model, ok: false };

      if (result.value.kind === 'CORROBORATING') {
        return { model, ok: true, resolutionKind: 'CORROBORATING' };
      }
      if (result.value.kind === 'CONTRADICTORY') {
        // The caller records a discrepancy; nothing else changes.
        return {
          model: { payment: recordDiscrepancy(payment), ops },
          ok: true,
          resolutionKind: 'CONTRADICTORY',
        };
      }

      const nextPayment = result.value.payment;
      // The refund-safety bound: a resolution never grows refunded + reserved.
      expect(nextPayment.refunded + nextPayment.reservedRefund).toBeLessThanOrEqual(
        payment.refunded + payment.reservedRefund,
      );
      return {
        model: { payment: nextPayment, ops: replaceOp(ops, result.value.operation) },
        ok: true,
        resolutionKind: 'APPLIED',
      };
    }

    case 'EXPIRE': {
      const result = applyAuthorizationExpiry(payment);
      if (!result.ok) return { model, ok: false };
      return { model: { payment: result.value, ops }, ok: true };
    }

    default:
      return { model, ok: false };
  }
}

function relativeAmount(base: bigint, permille: bigint): MinorUnits {
  const amount = (base * permille) / 1000n;
  return U(amount < 1n ? 1n : amount);
}

/** Capture against the authorization once there is one; before that, the request. */
function captureBase(payment: PaymentState): bigint {
  return payment.authorized > 0n ? payment.authorized : payment.requested;
}

/** Refund against what is still refundable; with nothing left, the capture (so it overshoots). */
function refundBase(payment: PaymentState): bigint {
  const refundable = payment.captured - payment.refunded - payment.reservedRefund;
  if (refundable > 0n) return refundable;
  return payment.captured > 0n ? payment.captured : payment.requested;
}

/** Rewrites ADVANCE into the concrete action it stands for; every other action is unchanged. */
function concretize(model: Model, action: Action): Action {
  if (action.kind !== 'ADVANCE') return action;
  const index = model.ops.findIndex((operation) => terminalOutcomeOf(operation) === undefined);
  // Nothing open: an index past the end, so CLAIM is a rejected no-op.
  if (index === -1) return { kind: 'CLAIM', index: model.ops.length };
  const target = model.ops[index] as OperationState;
  if (target.status === 'REQUESTED') {
    return target.notBefore === null ? { kind: 'CLAIM', index } : { kind: 'RELEASE', index };
  }
  return { kind: 'RESOLVE', index, outcome: action.outcome, delta: 0n };
}

/**
 * An oracle independent of `checkPaymentInvariants`: the aggregate recomputed from the operation
 * rows, the way the 0260 database trigger does. Asserting only through the checker under test would
 * let a weakened checker pass its own property.
 */
function expectAggregateMatchesOperations(model: Model, policy: FeePolicyInputs): void {
  const { payment, ops } = model;
  const of = (type: OperationState['type']) => ops.filter((operation) => operation.type === type);
  const succeeded = (list: readonly OperationState[]) =>
    list.filter((operation) => operation.status === 'SUCCEEDED');
  const open = (list: readonly OperationState[]) =>
    list.filter((operation) => isUnresolved(operation.status));
  const sum = (list: readonly OperationState[]) =>
    list.reduce((total, operation) => total + operation.amount, 0n);

  const authorizations = of('AUTHORIZE');
  const authorized = succeeded(authorizations)[0];
  const capture = succeeded(of('CAPTURE'))[0];
  const cancelled = succeeded(of('CANCEL')).length > 0;
  const openRefunds = open(of('REFUND'));
  const openExclusive = ops.filter(
    (operation) => operation.type !== 'REFUND' && isUnresolved(operation.status),
  );

  expect(payment.reservedRefund).toBe(sum(openRefunds));
  expect(payment.unresolvedRefundCount).toBe(openRefunds.length);
  expect(payment.refunded).toBe(sum(succeeded(of('REFUND'))));
  expect(payment.captured).toBe(capture?.amount ?? 0n);
  expect(payment.authorized).toBe(authorized?.amount ?? 0n);
  expect(payment.activeExclusiveOperationId).toBe(openExclusive[0]?.id ?? null);
  expect(openExclusive.length).toBeLessThanOrEqual(1);

  // docs/03 §MVP policy decisions: at most three attempts, none open beside a success.
  expect(authorizations.length).toBeLessThanOrEqual(3);
  if (authorized !== undefined) expect(open(authorizations)).toHaveLength(0);

  // docs/03 §Authorization outcomes: REJECTED declines, FAILED changes nothing.
  if (cancelled) {
    expect(payment.authorizationOutcome).toBe('CANCELED');
  } else if (authorized !== undefined) {
    expect(['AUTHORIZED', 'EXPIRED']).toContain(payment.authorizationOutcome);
  } else {
    const declined = authorizations.some((operation) => operation.status === 'REJECTED');
    expect(payment.authorizationOutcome).toBe(declined ? 'DECLINED' : 'NOT_REQUESTED');
  }

  const released =
    payment.authorizationOutcome === 'CANCELED' || payment.authorizationOutcome === 'EXPIRED';
  expect(payment.voided).toBe(
    capture !== undefined
      ? payment.authorized - capture.amount
      : released
        ? payment.authorized
        : 0n,
  );
  expect(payment.refunded + payment.reservedRefund).toBeLessThanOrEqual(payment.captured);

  // A capture's fee is the formula over its snapshot, and no capture below the policy minimum is
  // ever accepted (docs/02 §Minimum capture amount); refunds never reverse more than the fee.
  for (const operation of of('CAPTURE')) {
    expect(operation.amount).toBeGreaterThanOrEqual(policy.minimumCaptureAmount);
    const snapshot = operation.feeSnapshot;
    expect(snapshot).not.toBeNull();
    if (snapshot === null) continue;
    expect(operation.feeEffect).toBe(
      computeCaptureFee(operation.amount, snapshot.basisPoints, snapshot.fixedAmount),
    );
  }
  const reversed = succeeded(of('REFUND')).reduce(
    (total, operation) => total + (operation.feeEffect ?? 0n),
    0n,
  );
  expect(reversed).toBeLessThanOrEqual(capture?.feeEffect ?? 0n);
}

function terminalOutcomeOf(
  operation: OperationState,
): 'SUCCEEDED' | 'REJECTED' | 'FAILED' | undefined {
  const status: OperationStatus = operation.status;
  return status === 'SUCCEEDED' || status === 'REJECTED' || status === 'FAILED'
    ? status
    : undefined;
}

/** The capture fee snapshot a refund copies, taken from the payment's successful capture. */
function snapshotOf(ops: readonly OperationState[]): FeeSnapshot | null {
  const capture = ops.find(
    (operation) => operation.type === 'CAPTURE' && operation.status === 'SUCCEEDED',
  );
  return capture?.feeSnapshot ?? null;
}

const OUTCOME = fc.constantFrom('SUCCEEDED' as const, 'REJECTED' as const, 'FAILED' as const);

/**
 * Weighted so a walk reaches every phase. ADVANCE is the most likely action and resolves SUCCEEDED
 * most of the time; the other actions keep their chance of being invalid at any point.
 */
function actionArb(): fc.Arbitrary<Action> {
  // Exactly 1000 (the whole authorized or refundable amount) is common, so full captures and
  // full refunds happen; the rest spans partial and over-limit requests.
  const permille = fc.oneof(
    { weight: 2, arbitrary: fc.constant(1000n) },
    { weight: 3, arbitrary: fc.bigInt({ min: 1n, max: 1100n }) },
  );
  const index = fc.nat({ max: 8 });

  return fc.oneof(
    {
      weight: 10,
      arbitrary: fc
        .oneof(
          { weight: 4, arbitrary: fc.constant('SUCCEEDED' as const) },
          { weight: 1, arbitrary: OUTCOME },
        )
        .map<Action>((outcome) => ({ kind: 'ADVANCE', outcome })),
    },
    { weight: 3, arbitrary: fc.constant<Action>({ kind: 'ACCEPT_AUTHORIZE' }) },
    {
      weight: 3,
      arbitrary: permille.map<Action>((value) => ({ kind: 'ACCEPT_CAPTURE', permille: value })),
    },
    { weight: 1, arbitrary: fc.constant<Action>({ kind: 'ACCEPT_CANCEL' }) },
    {
      weight: 4,
      arbitrary: permille.map<Action>((value) => ({ kind: 'ACCEPT_REFUND', permille: value })),
    },
    { weight: 1, arbitrary: index.map<Action>((value) => ({ kind: 'CLAIM', index: value })) },
    { weight: 1, arbitrary: index.map<Action>((value) => ({ kind: 'RETRY', index: value })) },
    { weight: 1, arbitrary: index.map<Action>((value) => ({ kind: 'RELEASE', index: value })) },
    {
      weight: 1,
      arbitrary: index.map<Action>((value) => ({ kind: 'MARK_UNKNOWN', index: value })),
    },
    {
      weight: 1,
      arbitrary: index.map<Action>((value) => ({ kind: 'REQUIRE_REVIEW', index: value })),
    },
    {
      weight: 1,
      arbitrary: fc
        .record({ index, outcome: OUTCOME, delta: fc.bigInt({ min: 0n, max: 1n }) })
        .map<Action>((value) => ({ kind: 'RESOLVE', ...value })),
    },
    { weight: 1, arbitrary: fc.constant<Action>({ kind: 'EXPIRE' }) },
    { weight: 1, arbitrary: index.map<Action>((value) => ({ kind: 'DUPLICATE', index: value })) },
  );
}

/**
 * A policy the database would accept (`checkFeePolicy` mirrors `fee_policies_fee_within_minimum`):
 * the minimum is raised until the fee charged at it fits inside it. The original generator used
 * `minimum = fixed`, which admits unpriceable policies whose captures fail as an internal error.
 */
function policyArb(): fc.Arbitrary<FeePolicyInputs> {
  return fc
    .record({
      basisPoints: fc.bigInt({ min: 0n, max: 9000n }),
      fixed: fc.bigInt({ min: 0n, max: 1000n }),
    })
    .map(({ basisPoints, fixed }) => {
      // m - floor((m*bp + 5000)/10000) >= fixed  ⇐  m >= (fixed + 1) * 10000 / (10000 - bp)
      let minimum = ((fixed + 1n) * 10000n) / (10000n - basisPoints) + 1n;
      while (
        !checkFeePolicy({
          basisPoints,
          fixedAmount: U(fixed),
          minimumCaptureAmount: U(minimum),
        }).ok
      ) {
        minimum += 1n;
      }
      return { basisPoints, fixedAmount: U(fixed), minimumCaptureAmount: U(minimum) };
    });
}

/** Runs one walk, asserting every per-step oracle, and returns the final model. */
function walk(requested: MinorUnits, policy: FeePolicyInputs, actions: readonly Action[]): Model {
  let model: Model = { payment: createdPayment(requested), ops: [] };

  for (const generated of actions) {
    const before = model;
    const action = concretize(before, generated);
    const result = step(before, action, policy);

    if (!result.ok) {
      // A rejected action is a complete no-op: no operation, no version change.
      expect(result.model).toBe(before);
    }

    const paymentDelta = result.model.payment.version - before.payment.version;
    expect(paymentDelta).toBe(expectedPaymentDelta(action, result.ok, result.resolutionKind));

    // Every intermediate state must be consistent, not just the final one — by the checker under
    // test and by the independent recomputation.
    expect(checkPaymentInvariants(result.model.payment, result.model.ops)).toEqual([]);
    expectAggregateMatchesOperations(result.model, policy);

    model = result.model;
  }
  return model;
}

describe('model-based lifecycle properties', () => {
  it('random sequences preserve invariants and version rules', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1000000n }),
        policyArb(),
        fc.array(actionArb(), { minLength: 1, maxLength: 60, size: 'max' }),
        (requested, policy, actions) => {
          walk(U(requested), policy, actions);
        },
      ),
    );
  });

  it('fee reversal is bounded and exact on a full refund', () => {
    fc.assert(
      fc.property(
        policyArb(),
        fc.array(actionArb(), { minLength: 1, maxLength: 80, size: 'max' }),
        (policy, actions) => {
          const model = walk(U('100000'), policy, actions);

          const capture = model.ops.find(
            (operation) => operation.type === 'CAPTURE' && operation.status === 'SUCCEEDED',
          );
          const captureFee = capture?.feeEffect ?? U(0n);
          const reversed = model.ops
            .filter((operation) => operation.type === 'REFUND' && operation.status === 'SUCCEEDED')
            .reduce((sum, operation) => sum + (operation.feeEffect ?? 0n), 0n);

          expect(reversed).toBeLessThanOrEqual(captureFee);
          if (model.payment.refunded > 0n && model.payment.refunded === model.payment.captured) {
            expect(reversed).toBe(captureFee);
          }
        },
      ),
    );
  });

  /**
   * The walk is only evidence if it reaches the states the guards protect. The P02 review measured
   * the previous generator: 0 of 100 walks reached a successful authorization and 0 of 2000 a
   * capture, so every capture and refund guard could be deleted without a failure. This pins the
   * reach on a fixed seed so a generator change cannot silently make the properties vacuous again.
   */
  it('reaches every lifecycle phase in a meaningful share of walks', () => {
    const samples = fc.sample(
      fc.tuple(
        fc.bigInt({ min: 1n, max: 1000000n }),
        policyArb(),
        fc.array(actionArb(), { minLength: 1, maxLength: 60, size: 'max' }),
      ),
      { numRuns: 300, seed: 20261109 },
    );
    const reached = {
      authorized: 0,
      captured: 0,
      refundAccepted: 0,
      refunded: 0,
      fullyRefunded: 0,
    };
    for (const [requested, policy, actions] of samples) {
      const model = walk(U(requested), policy, actions);
      const has = (type: string, status?: string) =>
        model.ops.some(
          (operation) =>
            operation.type === type && (status === undefined || operation.status === status),
        );
      if (has('AUTHORIZE', 'SUCCEEDED')) reached.authorized += 1;
      if (has('CAPTURE', 'SUCCEEDED')) reached.captured += 1;
      if (has('REFUND')) reached.refundAccepted += 1;
      if (has('REFUND', 'SUCCEEDED')) reached.refunded += 1;
      if (model.payment.captured > 0n && model.payment.refunded === model.payment.captured) {
        reached.fullyRefunded += 1;
      }
    }
    // Measured on this seed at 209 / 64 / 48 / 32 / 21 of 300; the floors sit at about 60 % of that.
    expect(reached.authorized).toBeGreaterThan(120);
    expect(reached.captured).toBeGreaterThan(35);
    expect(reached.refundAccepted).toBeGreaterThan(25);
    expect(reached.refunded).toBeGreaterThan(15);
    expect(reached.fullyRefunded).toBeGreaterThan(8);
  });
});

describe('targeted properties', () => {
  /**
   * A payment with a confirmed capture. The fee is *computed* from a policy with no fixed component,
   * because a hard-coded fee is inconsistent for small captures — a fee of 30 on a gross of 3
   * produces a snapshot the fee functions rightly reject, and the first version of these properties
   * failed on exactly that.
   */
  function captured(requested: string, captured: string): Model {
    const gross = U(captured);
    const captureFee = computeCaptureFee(gross, 290n, U(0n));
    const captureOp: OperationState = Object.freeze({
      id: freshId(),
      type: 'CAPTURE',
      amount: gross,
      status: 'SUCCEEDED',
      notBefore: null,
      version: 2,
      feeEffect: captureFee,
      feeSnapshot: {
        basisPoints: 290n,
        fixedAmount: U(0n),
        captureFee,
        captureGross: gross,
      },
    });
    return {
      payment: Object.freeze({
        ...createdPayment(U(requested)),
        authorized: U(requested),
        captured: U(captured),
        // A confirmed capture releases the remainder: `captured + voided === authorized` is an
        // invariant, so a fixture with a partial capture must void the difference.
        voided: U(BigInt(requested) - BigInt(captured)),
        authorizationOutcome: 'AUTHORIZED' as const,
      }),
      ops: [captureOp],
    };
  }

  it('a refund race for the last refundable amount fails on the monetary guard', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 2n, max: 100000n }),
        fc.bigInt({ min: 1n, max: 100000n }),
        (capturedAmount, firstRaw) => {
          const model = captured('1000000', capturedAmount.toString());
          const first = (firstRaw % capturedAmount) + 1n;
          const second = capturedAmount - first + 1n; // each fits, together they do not

          const snapshot = model.ops[0]?.feeSnapshot;
          if (snapshot === null || snapshot === undefined) return;

          const accepted = acceptCommand(
            model.payment,
            model.ops,
            { type: 'REFUND', amount: U(first), captureFeeSnapshot: snapshot },
            freshId(),
          );
          // `first` is at most the captured amount, so it always fits.
          expect(accepted.ok).toBe(true);
          if (!accepted.ok) return;

          const raced = acceptCommand(
            accepted.value.payment,
            [...model.ops, accepted.value.operation],
            { type: 'REFUND', amount: U(second), captureFeeSnapshot: snapshot },
            freshId(),
          );
          // first + second = captured + 1, so the second can never fit. The previous `if (raced.ok)
          // return` made the property pass vacuously with the refund guard removed.
          expect(raced.ok).toBe(false);
          if (raced.ok) return;
          expect(`${raced.error.code}/${raced.error.reason}`).toBe(
            'MONETARY_GUARD_FAILED/REFUND_EXCEEDS_REFUNDABLE',
          );
        },
      ),
    );
  });

  it('several fitting refunds are all accepted and the reservation equals their sum', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 3n, max: 1000n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n }), { minLength: 1, maxLength: 10 }),
        (capturedAmount, rawParts) => {
          const model = captured('1000000', capturedAmount.toString());
          const snapshot = model.ops[0]?.feeSnapshot;
          if (snapshot === null || snapshot === undefined) return;

          let payment = model.payment;
          let ops = [...model.ops];
          let reserved = 0n;

          for (const raw of rawParts) {
            const remaining = capturedAmount - reserved;
            if (remaining <= 0n) break;
            const amount = raw > remaining ? remaining : raw;

            const result = acceptCommand(
              payment,
              ops,
              { type: 'REFUND', amount: U(amount), captureFeeSnapshot: snapshot },
              freshId(),
            );
            if (!result.ok) break;
            payment = result.value.payment;
            ops = [...ops, result.value.operation];
            reserved += amount;
          }

          if (reserved === 0n) return;
          expect(payment.reservedRefund).toBe(reserved);
          expect(payment.unresolvedRefundCount).toBe(
            ops.filter((operation) => operation.type === 'REFUND').length,
          );
        },
      ),
    );
  });

  it('a successful refund releases exactly its reservation and keeps the aggregate consistent', () => {
    const model = captured('10000', '10000');
    const snapshot = model.ops[0]?.feeSnapshot;
    if (snapshot === null || snapshot === undefined) return;

    const accepted = acceptCommand(
      model.payment,
      model.ops,
      { type: 'REFUND', amount: U('2500'), captureFeeSnapshot: snapshot },
      freshId(),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.payment.reservedRefund).toBe(2500n);

    // A refund must be claimed before it can resolve: no provider call happens while REQUESTED.
    const claimed = claimOperation(accepted.value.operation);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const resolved = resolveOperation(accepted.value.payment, claimed.value, {
      outcome: 'SUCCEEDED',
      amount: U('2500'),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.kind !== 'APPLIED') return;

    expect(resolved.value.payment.reservedRefund).toBe(0n);
    expect(resolved.value.payment.unresolvedRefundCount).toBe(0);
    expect(resolved.value.payment.refunded).toBe(2500n);
    expect(
      checkPaymentInvariants(resolved.value.payment, [...model.ops, resolved.value.operation]),
    ).toEqual([]);
  });

  it('an UNKNOWN refund keeps its reservation while a later refund against the remainder succeeds', () => {
    const model = captured('10000', '10000');
    const snapshot = model.ops[0]?.feeSnapshot;
    if (snapshot === null || snapshot === undefined) return;

    const first = acceptCommand(
      model.payment,
      model.ops,
      { type: 'REFUND', amount: U('6000'), captureFeeSnapshot: snapshot },
      freshId(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const claimed = claimOperation(first.value.operation);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const unknown = markUnknown(first.value.payment, claimed.value);
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;

    expect(unknown.value.payment.reservedRefund).toBe(6000n);

    const later = acceptCommand(
      unknown.value.payment,
      [...model.ops, unknown.value.operation],
      { type: 'REFUND', amount: U('4000'), captureFeeSnapshot: snapshot },
      freshId(),
    );
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.value.payment.reservedRefund).toBe(10000n);
  });

  it('the same refund set in two orders gives equal totals and per-refund fees within one unit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 3n, max: 500n }),
        fc.array(fc.bigInt({ min: 1n, max: 20n }), { minLength: 2, maxLength: 6 }),
        (capturedAmount, rawParts) => {
          const parts = rawParts.map((raw) => ((raw - 1n) % capturedAmount) + 1n);
          const total = parts.reduce((sum, part) => sum + part, 0n);
          if (total > capturedAmount) return;

          const run = (order: readonly bigint[]): bigint[] => {
            const model = captured('1000000', capturedAmount.toString());
            const snapshot = model.ops[0]?.feeSnapshot;
            if (snapshot === null || snapshot === undefined) return [];

            let payment = model.payment;
            let ops = [...model.ops];
            const fees: bigint[] = [];

            for (const part of order) {
              const accepted = acceptCommand(
                payment,
                ops,
                { type: 'REFUND', amount: U(part), captureFeeSnapshot: snapshot },
                freshId(),
              );
              if (!accepted.ok) return fees;

              // Claim first: an operation that was never claimed cannot have reached the provider,
              // so resolving it directly is (correctly) rejected. Skipping this made the whole
              // property vacuous — it returned a short list that the length guard below now catches.
              const claimed = claimOperation(accepted.value.operation);
              if (!claimed.ok) return fees;

              const resolved = resolveOperation(accepted.value.payment, claimed.value, {
                outcome: 'SUCCEEDED',
                amount: claimed.value.amount,
              });
              if (!resolved.ok || resolved.value.kind !== 'APPLIED') return fees;

              payment = resolved.value.payment;
              ops = [...ops, resolved.value.operation];
              fees.push(resolved.value.operation.feeEffect ?? 0n);

              // Random action sequences rarely reach a *successful* refund resolution (it needs
              // accept -> claim -> resolve to line up), so the invariant is asserted here, where the
              // path is reached deterministically. An injected bug that left the reservation
              // unreleased was invisible to the random walk alone.
              expect(checkPaymentInvariants(payment, ops)).toEqual([]);
            }
            return fees;
          };

          const forward = run(parts);
          const backward = run([...parts].reverse());
          // Every refund must have completed; a short list means the property silently did nothing.
          expect(forward).toHaveLength(parts.length);
          expect(backward).toHaveLength(parts.length);

          const totalOf = (values: readonly bigint[]): bigint =>
            values.reduce((sum, value) => sum + value, 0n);
          expect(totalOf(forward)).toBe(totalOf(backward));
          // Per-refund allocation may differ by at most one minor unit under a different order.
          const sortedForward = [...forward].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const sortedBackward = [...backward].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          sortedForward.forEach((fee, index) => {
            const other = sortedBackward[index] ?? 0n;
            expect(fee - other <= 1n && other - fee <= 1n).toBe(true);
          });
        },
      ),
    );
  });
});
