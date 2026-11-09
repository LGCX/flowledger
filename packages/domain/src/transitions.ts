/**
 * Post-acceptance transitions (docs/03 §Lifecycle transitions, §Authorization-expiry workflow,
 * §Ambiguous outcomes, §Proven-no-effect same-operation retry, §Racing resolution signals,
 * §Aggregate and operation version rules).
 *
 * This is the executable reference model for the P06–P08 SQL functions, so the version arithmetic
 * is as much a part of the contract as the effects. Only transitions that change *confirmed state*
 * bump the payment version: claiming work, scheduling a retry, releasing a due operation, and a
 * corroborating resolution are bookkeeping on the operation alone. A consumer that bumped the
 * payment version for those would make every `If-Match` conflict on unrelated writes.
 *
 * Resolution is idempotent by design. A repeated success corroborates; a contradicting terminal
 * outcome does not overwrite the first and does not raise — it reports `CONTRADICTORY` so the caller
 * records a discrepancy. Two race winners must both be able to complete without either corrupting
 * the aggregate.
 */
import { DomainError, type Result, err, ok } from './errors.js';
import { incrementalFeeReversal } from './fees.js';
import { type MinorUnits, minorUnits } from './money.js';
import type { OperationState, PaymentState } from './payment.js';
import type { Timestamp } from './values.js';

function illegal(detail?: Readonly<Record<string, string>>): DomainError {
  return new DomainError('INVALID_PAYMENT_STATE', 'ILLEGAL_OPERATION_TRANSITION', detail);
}

function freezeOperation(operation: OperationState): OperationState {
  return Object.freeze({ ...operation });
}

function freezePayment(payment: PaymentState): PaymentState {
  return Object.freeze({ ...payment });
}

/** REQUESTED (no deadline) → PROCESSING. Bookkeeping only: the payment version does not move. */
export function claimOperation(operation: OperationState): Result<OperationState> {
  if (operation.status !== 'REQUESTED') return err<OperationState>(illegal());
  if (operation.notBefore !== null) {
    // A retry that is not yet due must not be claimed; otherwise the backoff is meaningless.
    return err<OperationState>(illegal({ notBefore: operation.notBefore }));
  }
  return ok(
    freezeOperation({ ...operation, status: 'PROCESSING', version: operation.version + 1 }),
  );
}

/** PROCESSING → REQUESTED with a new deadline (proven no effect). */
export function scheduleNoEffectRetry(
  operation: OperationState,
  notBefore: Timestamp,
): Result<OperationState> {
  if (operation.status !== 'PROCESSING') return err<OperationState>(illegal());
  return ok(
    freezeOperation({
      ...operation,
      status: 'REQUESTED',
      notBefore,
      version: operation.version + 1,
    }),
  );
}

/** REQUESTED (with a deadline) → REQUESTED (due now). */
export function releaseDueOperation(operation: OperationState): Result<OperationState> {
  if (operation.status !== 'REQUESTED' || operation.notBefore === null) {
    return err<OperationState>(illegal());
  }
  return ok(freezeOperation({ ...operation, notBefore: null, version: operation.version + 1 }));
}

export interface Transition {
  readonly payment: PaymentState;
  readonly operation: OperationState;
}

/** PROCESSING → UNKNOWN: the provider call may have had an effect. */
export function markUnknown(payment: PaymentState, operation: OperationState): Result<Transition> {
  if (operation.status !== 'PROCESSING') return err<Transition>(illegal());
  return ok({
    payment: freezePayment({ ...payment, version: payment.version + 1 }),
    operation: freezeOperation({ ...operation, status: 'UNKNOWN', version: operation.version + 1 }),
  });
}

/** UNKNOWN → REQUIRES_REVIEW. An operator, not an automatic retry, decides next. */
export function requireReview(
  payment: PaymentState,
  operation: OperationState,
): Result<Transition> {
  if (operation.status !== 'UNKNOWN') return err<Transition>(illegal());
  return ok({
    payment: freezePayment({ ...payment, version: payment.version + 1 }),
    operation: freezeOperation({
      ...operation,
      status: 'REQUIRES_REVIEW',
      version: operation.version + 1,
    }),
  });
}

export type ResolutionEvidence =
  | { readonly outcome: 'SUCCEEDED'; readonly amount: MinorUnits }
  | { readonly outcome: 'REJECTED' }
  | { readonly outcome: 'FAILED' };

export type ResolutionResult =
  | { readonly kind: 'APPLIED'; readonly payment: PaymentState; readonly operation: OperationState }
  /** No change at all: a duplicate of an outcome already applied. */
  | { readonly kind: 'CORROBORATING' }
  /** Contradicts what is already recorded; the caller records a discrepancy. */
  | { readonly kind: 'CONTRADICTORY' };

function isResolvable(status: OperationState['status']): boolean {
  return status === 'PROCESSING' || status === 'UNKNOWN' || status === 'REQUIRES_REVIEW';
}

/** The confirmed-total and outcome effects of applying `evidence` to `operation`. */
function applyEffects(
  payment: PaymentState,
  operation: OperationState,
  evidence: ResolutionEvidence,
): Result<Transition> {
  const succeeded = evidence.outcome === 'SUCCEEDED';
  const amount = succeeded ? evidence.amount : operation.amount;

  // Every resolved operation releases the exclusive slot; a refund never held it.
  const releasesPointer = operation.type !== 'REFUND';
  const base: PaymentState = {
    ...payment,
    version: payment.version + 1,
    activeExclusiveOperationId: releasesPointer ? null : payment.activeExclusiveOperationId,
  };

  let nextPayment: PaymentState;
  let feeEffect: MinorUnits | null = operation.feeEffect;

  switch (operation.type) {
    case 'AUTHORIZE':
      nextPayment = {
        ...base,
        authorized: succeeded ? amount : payment.authorized,
        authorizationOutcome: succeeded ? 'AUTHORIZED' : 'DECLINED',
      };
      break;

    case 'CAPTURE':
      nextPayment = succeeded
        ? { ...base, captured: amount, voided: minorUnits(payment.authorized - amount) }
        : base;
      break;

    case 'CANCEL':
      nextPayment = succeeded
        ? { ...base, authorizationOutcome: 'CANCELED', voided: payment.authorized }
        : base;
      break;

    case 'REFUND': {
      if (operation.feeSnapshot === null) {
        // A refund accepted without a capture snapshot cannot compute its reversal.
        return err<Transition>(illegal({ constraint: 'refund requires a fee snapshot' }));
      }
      const released = minorUnits(payment.reservedRefund - operation.amount);
      const count = payment.unresolvedRefundCount - 1;
      if (succeeded) {
        feeEffect = incrementalFeeReversal({
          captureFee: operation.feeSnapshot.captureFee,
          captureGross: operation.feeSnapshot.captureGross,
          // The refunds confirmed *before* this one, which is what makes the allocation cumulative.
          confirmedRefundedBefore: payment.refunded,
          refundAmount: operation.amount,
        });
        nextPayment = {
          ...base,
          reservedRefund: released,
          unresolvedRefundCount: count,
          refunded: minorUnits(payment.refunded + operation.amount),
        };
      } else {
        nextPayment = { ...base, reservedRefund: released, unresolvedRefundCount: count };
      }
      break;
    }

    default:
      return err<Transition>(illegal());
  }

  return ok({
    payment: freezePayment(nextPayment),
    operation: freezeOperation({
      ...operation,
      status: evidence.outcome,
      version: operation.version + 1,
      feeEffect,
    }),
  });
}

export function resolveOperation(
  payment: PaymentState,
  operation: OperationState,
  evidence: ResolutionEvidence,
): Result<ResolutionResult> {
  // A terminal operation is settled. Replaying the same outcome is harmless; anything else must be
  // surfaced as a discrepancy rather than overwriting history.
  if (
    operation.status === 'SUCCEEDED' ||
    operation.status === 'REJECTED' ||
    operation.status === 'FAILED'
  ) {
    if (operation.status !== evidence.outcome) return ok({ kind: 'CONTRADICTORY' });
    if (evidence.outcome === 'SUCCEEDED') {
      // A success for a different amount than the operation states is a provider mismatch.
      return ok({ kind: evidence.amount === operation.amount ? 'CORROBORATING' : 'CONTRADICTORY' });
    }
    return ok({ kind: 'CORROBORATING' });
  }

  // No provider call can have happened before the operation was claimed.
  if (operation.status === 'REQUESTED') return err<ResolutionResult>(illegal());

  if (!isResolvable(operation.status)) return err<ResolutionResult>(illegal());

  // docs/06: a success whose amount disagrees with the operation is not a confirmed effect.
  if (evidence.outcome === 'SUCCEEDED' && evidence.amount !== operation.amount) {
    return ok({ kind: 'CONTRADICTORY' });
  }

  const applied = applyEffects(payment, operation, evidence);
  if (!applied.ok) return err<ResolutionResult>(applied.error);

  return ok({
    kind: 'APPLIED',
    payment: applied.value.payment,
    operation: applied.value.operation,
  });
}

/**
 * Authorized → EXPIRED, voiding the whole authorization (docs/03 §Authorization-expiry workflow).
 *
 * The authorization operation is not passed in and never changes: expiry is a payment-level fact
 * derived from the provider's clock, not a new operation outcome.
 */
export function applyAuthorizationExpiry(payment: PaymentState): Result<PaymentState> {
  const notApplicable = (detail: string): Result<PaymentState> =>
    err<PaymentState>(
      new DomainError('INVALID_PAYMENT_STATE', 'EXPIRY_NOT_APPLICABLE', { constraint: detail }),
    );

  if (payment.authorizationOutcome !== 'AUTHORIZED') {
    return notApplicable('outcome must be AUTHORIZED');
  }
  if (payment.captured !== 0n || payment.refunded !== 0n || payment.voided !== 0n) {
    return notApplicable('no captured, refunded, or voided amounts');
  }
  if (payment.activeExclusiveOperationId !== null) return notApplicable('no active operation');
  if (payment.unresolvedRefundCount !== 0) return notApplicable('no unresolved refunds');

  return ok(
    freezePayment({
      ...payment,
      version: payment.version + 1,
      authorizationOutcome: 'EXPIRED',
      voided: payment.authorized,
    }),
  );
}

/** Records that a discrepancy was raised. Nothing else about the payment changes. */
export function recordDiscrepancy(payment: PaymentState): PaymentState {
  return freezePayment({ ...payment, version: payment.version + 1 });
}
