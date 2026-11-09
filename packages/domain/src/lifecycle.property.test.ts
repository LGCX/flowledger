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
import { type FeePolicyInputs, type FeeSnapshot, computeCaptureFee } from './fees.js';
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

type Action =
  | { readonly kind: 'ACCEPT_AUTHORIZE' }
  | { readonly kind: 'ACCEPT_CAPTURE'; readonly amount: bigint }
  | { readonly kind: 'ACCEPT_CANCEL' }
  | { readonly kind: 'ACCEPT_REFUND'; readonly amount: bigint }
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
              ? ({ type: 'CAPTURE', amount: U(action.amount), feePolicy: policy } as const)
              : ({
                  type: 'REFUND',
                  amount: U(action.amount),
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

function actionArb(maxAmount: bigint): fc.Arbitrary<Action> {
  const amount = fc.bigInt({ min: 1n, max: maxAmount });
  const index = fc.nat({ max: 8 });

  return fc.oneof(
    fc.constant<Action>({ kind: 'ACCEPT_AUTHORIZE' }),
    amount.map<Action>((value) => ({ kind: 'ACCEPT_CAPTURE', amount: value })),
    fc.constant<Action>({ kind: 'ACCEPT_CANCEL' }),
    amount.map<Action>((value) => ({ kind: 'ACCEPT_REFUND', amount: value })),
    index.map<Action>((value) => ({ kind: 'CLAIM', index: value })),
    index.map<Action>((value) => ({ kind: 'RETRY', index: value })),
    index.map<Action>((value) => ({ kind: 'RELEASE', index: value })),
    index.map<Action>((value) => ({ kind: 'MARK_UNKNOWN', index: value })),
    index.map<Action>((value) => ({ kind: 'REQUIRE_REVIEW', index: value })),
    fc
      .record({
        index,
        outcome: fc.constantFrom('SUCCEEDED' as const, 'REJECTED' as const, 'FAILED' as const),
        delta: fc.bigInt({ min: 0n, max: 1n }),
      })
      .map<Action>((value) => ({ kind: 'RESOLVE', ...value })),
    fc.constant<Action>({ kind: 'EXPIRE' }),
    index.map<Action>((value) => ({ kind: 'DUPLICATE', index: value })),
  );
}

function policyArb(): fc.Arbitrary<FeePolicyInputs> {
  return fc
    .record({
      basisPoints: fc.bigInt({ min: 0n, max: 10000n }),
      fixed: fc.bigInt({ min: 0n, max: 1000n }),
    })
    .map(({ basisPoints, fixed }) => ({
      basisPoints,
      fixedAmount: U(fixed),
      // The documented policy floor: the minimum must cover the fixed component.
      minimumCaptureAmount: U(fixed > 0n ? fixed : 1n),
    }));
}

describe('model-based lifecycle properties', () => {
  it('random sequences preserve invariants and version rules', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1000000n }),
        policyArb(),
        fc.array(actionArb(1000000n), { minLength: 1, maxLength: 60 }),
        (requested, policy, actions) => {
          let model: Model = { payment: createdPayment(U(requested)), ops: [] };

          for (const action of actions) {
            const before = model;
            const result = step(before, action, policy);

            if (!result.ok) {
              // A rejected action is a complete no-op: no operation, no version change.
              expect(result.model.payment).toEqual(before.payment);
              expect(result.model.ops).toEqual(before.ops);
            }

            const paymentDelta = result.model.payment.version - before.payment.version;
            expect(paymentDelta).toBe(
              expectedPaymentDelta(action, result.ok, result.resolutionKind),
            );

            // Every intermediate state must be consistent, not just the final one.
            expect(checkPaymentInvariants(result.model.payment, result.model.ops)).toEqual([]);
            expect(
              result.model.ops.filter(
                (operation) => operation.type !== 'REFUND' && isUnresolved(operation.status),
              ).length,
            ).toBeLessThanOrEqual(1);

            model = result.model;
          }
        },
      ),
    );
  });

  it('invalid actions are no-ops', () => {
    fc.assert(
      fc.property(
        policyArb(),
        fc.array(actionArb(1000n), { minLength: 1, maxLength: 30 }),
        (policy, actions) => {
          let model: Model = { payment: createdPayment(U('10000')), ops: [] };
          for (const action of actions) {
            const result = step(model, action, policy);
            if (!result.ok) {
              expect(result.model).toBe(model);
              expect(result.model.payment.version).toBe(model.payment.version);
            }
            model = result.model;
          }
        },
      ),
    );
  });

  it('fee reversal is bounded and exact on a full refund', () => {
    fc.assert(
      fc.property(
        policyArb(),
        fc.array(actionArb(100000n), { minLength: 1, maxLength: 60 }),
        (policy, actions) => {
          let model: Model = { payment: createdPayment(U('100000')), ops: [] };
          for (const action of actions) model = step(model, action, policy).model;

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
          if (!accepted.ok) return;

          const raced = acceptCommand(
            accepted.value.payment,
            [...model.ops, accepted.value.operation],
            { type: 'REFUND', amount: U(second), captureFeeSnapshot: snapshot },
            freshId(),
          );
          if (raced.ok) return; // `second` may still fit when `first` was small
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
