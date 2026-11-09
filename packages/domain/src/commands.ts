/**
 * Command acceptance: the pure decision P05's protected SQL function must mirror
 * (docs/03 §Command acceptance steps 3–7, §Operation exclusion model, §Lifecycle transitions guards).
 *
 * The guards run in a fixed order and the order is part of the contract, because the same request
 * can violate several rules at once and the merchant is told only the first. An active exclusive
 * operation outranks an unresolved refund which outranks lifecycle which outranks money: the
 * coarser the conflict, the further up it sits, so the error names the thing the caller must wait
 * for rather than a downstream consequence **[ASSUMPTION A-06]**.
 *
 * Nothing here mutates. Every returned object is new and frozen, and on failure the inputs are
 * unchanged, so a caller can retry or log without defensive copying.
 *
 * Confirmed totals and `authorizationOutcome` never change at acceptance: an operation is only
 * *requested* here, and the authoritative totals move when it is confirmed (P01-T09).
 */
import { DomainError, type Result, err, ok } from './errors.js';
import {
  type FeePolicyInputs,
  type FeeSnapshot,
  checkCaptureMinimum,
  computeCaptureFee,
} from './fees.js';
import type { OperationId } from './ids.js';
import { type MinorUnits, minorUnits } from './money.js';
import { type OperationState, type PaymentState, exclusionClass, isUnresolved } from './payment.js';

export type CommandRequest =
  | { readonly type: 'AUTHORIZE' }
  | {
      readonly type: 'CAPTURE';
      readonly amount: MinorUnits;
      readonly feePolicy: FeePolicyInputs;
    }
  | { readonly type: 'CANCEL' }
  | {
      readonly type: 'REFUND';
      readonly amount: MinorUnits;
      readonly captureFeeSnapshot: FeeSnapshot;
    };

export interface Acceptance {
  readonly payment: PaymentState;
  readonly operation: OperationState;
}

function fail(
  code:
    | 'ACTIVE_OPERATION_EXISTS'
    | 'INVALID_PAYMENT_STATE'
    | 'MONETARY_GUARD_FAILED'
    | 'CAPTURE_BELOW_MINIMUM',
  reason:
    | 'EXCLUSIVE_OPERATION_UNRESOLVED'
    | 'REFUND_UNRESOLVED'
    | 'GUARD_FAILED'
    | 'AUTHORIZATION_ATTEMPTS_EXHAUSTED'
    | 'CAPTURE_EXCEEDS_AUTHORIZED'
    | 'REFUND_EXCEEDS_REFUNDABLE'
    | 'BELOW_MINIMUM_CAPTURE',
  detail?: Readonly<Record<string, string>>,
): Result<Acceptance> {
  return err<Acceptance>(new DomainError(code, reason, detail));
}

/** docs/03 §MVP policy decisions: at most three AUTHORIZE operations per payment. */
const MAX_AUTHORIZATIONS = 3;

export function acceptCommand(
  payment: PaymentState,
  operations: readonly OperationState[],
  request: CommandRequest,
  newOperationId: OperationId,
): Result<Acceptance> {
  // 1. An unresolved exclusive operation blocks every new command, refunds included: a refund
  //    against a payment whose capture is still in flight would be sized from totals that may yet
  //    change. The reverse direction — an unresolved refund blocking exclusive work — is guard 2.
  if (payment.activeExclusiveOperationId !== null) {
    return fail('ACTIVE_OPERATION_EXISTS', 'EXCLUSIVE_OPERATION_UNRESOLVED', {
      activeOperationId: payment.activeExclusiveOperationId,
    });
  }

  // 2. An unresolved refund blocks the exclusive operation types, but not another refund.
  if (request.type !== 'REFUND' && payment.unresolvedRefundCount > 0) {
    return fail('ACTIVE_OPERATION_EXISTS', 'REFUND_UNRESOLVED', {
      unresolvedRefundCount: String(payment.unresolvedRefundCount),
    });
  }

  const authorizations = operations.filter((operation) => operation.type === 'AUTHORIZE');
  const hasSucceededCapture = operations.some(
    (operation) => operation.type === 'CAPTURE' && operation.status === 'SUCCEEDED',
  );

  // 3. Lifecycle guards.
  if (request.type === 'AUTHORIZE') {
    if (
      payment.authorizationOutcome !== 'NOT_REQUESTED' &&
      payment.authorizationOutcome !== 'DECLINED'
    ) {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        authorizationOutcome: payment.authorizationOutcome,
      });
    }
    if (
      payment.authorized !== 0n ||
      payment.captured !== 0n ||
      payment.refunded !== 0n ||
      payment.voided !== 0n
    ) {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', { constraint: 'no confirmed totals' });
    }
    if (authorizations.length >= MAX_AUTHORIZATIONS) {
      return fail('INVALID_PAYMENT_STATE', 'AUTHORIZATION_ATTEMPTS_EXHAUSTED', {
        attempts: String(authorizations.length),
      });
    }
    // A retry is only allowed after the previous attempt settled as rejected or failed.
    const previous = authorizations[authorizations.length - 1];
    if (previous !== undefined && previous.status !== 'REJECTED' && previous.status !== 'FAILED') {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        previousStatus: previous.status,
      });
    }
  }

  if (request.type === 'CAPTURE') {
    if (payment.authorizationOutcome !== 'AUTHORIZED') {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        authorizationOutcome: payment.authorizationOutcome,
      });
    }
    if (payment.captured !== 0n || payment.refunded !== 0n) {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        constraint: 'no captured or refunded',
      });
    }
    if (hasSucceededCapture) {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        constraint: 'capture already succeeded',
      });
    }
  }

  if (request.type === 'CANCEL') {
    if (payment.authorizationOutcome !== 'AUTHORIZED') {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        authorizationOutcome: payment.authorizationOutcome,
      });
    }
    if (payment.captured !== 0n || payment.refunded !== 0n) {
      return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', {
        constraint: 'no captured or refunded',
      });
    }
  }

  if (request.type === 'REFUND' && payment.captured <= 0n) {
    return fail('INVALID_PAYMENT_STATE', 'GUARD_FAILED', { constraint: 'nothing captured' });
  }

  // 4. Monetary guards.
  let captureFee: MinorUnits | null = null;
  if (request.type === 'CAPTURE') {
    if (request.amount > payment.authorized) {
      return fail('MONETARY_GUARD_FAILED', 'CAPTURE_EXCEEDS_AUTHORIZED', {
        authorizedAmountMinor: payment.authorized.toString(),
      });
    }
    const minimum = checkCaptureMinimum(request.amount, request.feePolicy.minimumCaptureAmount);
    if (!minimum.ok) return err<Acceptance>(minimum.error);

    try {
      captureFee = computeCaptureFee(
        request.amount,
        request.feePolicy.basisPoints,
        request.feePolicy.fixedAmount,
      );
    } catch (error) {
      // A fee that cannot be computed for an accepted policy is an invariant breach, not a client
      // error; surface it unchanged rather than converting it into a 4xx.
      if (error instanceof DomainError) return err<Acceptance>(error);
      throw error;
    }
  }

  if (request.type === 'REFUND') {
    if (payment.refunded + payment.reservedRefund + request.amount > payment.captured) {
      return fail('MONETARY_GUARD_FAILED', 'REFUND_EXCEEDS_REFUNDABLE', {
        refundableAmountMinor: (
          payment.captured -
          payment.refunded -
          payment.reservedRefund
        ).toString(),
      });
    }
  }

  // 5. Effects. Confirmed totals and the authorization outcome are untouched at acceptance.
  const operationAmount: MinorUnits =
    request.type === 'AUTHORIZE'
      ? payment.requested
      : request.type === 'CANCEL'
        ? minorUnits(payment.authorized - payment.captured)
        : request.amount;

  const operation: OperationState = Object.freeze({
    id: newOperationId,
    type: request.type,
    amount: operationAmount,
    status: 'REQUESTED' as const,
    notBefore: null,
    version: 1,
    feeEffect: request.type === 'CAPTURE' ? captureFee : null,
    feeSnapshot:
      request.type === 'CAPTURE'
        ? ({
            basisPoints: request.feePolicy.basisPoints,
            fixedAmount: request.feePolicy.fixedAmount,
            captureFee: captureFee as MinorUnits,
            captureGross: request.amount,
          } satisfies FeeSnapshot)
        : request.type === 'REFUND'
          ? // A copy, not the caller's object: the refund must keep the capture's snapshot even if
            // the caller later mutates or reuses its own.
            Object.freeze({ ...request.captureFeeSnapshot })
          : null,
  });

  const isRefund = request.type === 'REFUND';
  const nextPayment: PaymentState = Object.freeze({
    ...payment,
    version: payment.version + 1,
    // Exclusive types take the single slot; a refund instead grows the reservation.
    activeExclusiveOperationId: isRefund ? payment.activeExclusiveOperationId : newOperationId,
    reservedRefund: isRefund
      ? minorUnits(payment.reservedRefund + request.amount)
      : payment.reservedRefund,
    unresolvedRefundCount: isRefund
      ? payment.unresolvedRefundCount + 1
      : payment.unresolvedRefundCount,
  });

  return ok({ payment: nextPayment, operation });
}

/** True when the operation holds an unresolved exclusive slot, for callers that need to wait. */
export function blocksExclusiveCommands(operations: readonly OperationState[]): boolean {
  return operations.some(
    (operation) => exclusionClass(operation.type) === 'EXCLUSIVE' && isUnresolved(operation.status),
  );
}
