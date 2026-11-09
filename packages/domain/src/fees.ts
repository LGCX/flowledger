/**
 * Capture fee and cumulative proportional refund-fee reversal (docs/02 §Capture-fee calculation,
 * §Minimum capture amount, §Refund accounting; ADR-0008).
 *
 * ```text
 * percentageFee          = floor((G * B + 5000) / 10000)
 * F                      = percentageFee + K
 * targetFeeReversed(R)   = floor(F * R / G)
 * incrementalFeeReversal = targetFeeReversed(R0 + a) - targetFeeReversed(R0)
 * ```
 *
 * Every amount is `MinorUnits` and every intermediate is an exact `bigint`: `F * R` reaches 10^24
 * for legitimate inputs, which is why no `number` can appear in this file and why the SQL mirror
 * must use `numeric` rather than `bigint` (R-05).
 *
 * Reversal is a *cumulative* function, not a per-refund rate. Each refund is attributed the
 * difference between the fee that should have been reversed after it and the fee already reversed
 * before it. That makes the allocation order-dependent by at most one minor unit per refund while
 * the total is exactly `F` at full refund — the property `order-a` and `order-b` in the golden file
 * pin from both sides.
 */
import { DomainError, type Result, err, ok } from './errors.js';
import { MAX_AMOUNT_MINOR, type MinorUnits, minorUnits, toAmountString } from './money.js';

export interface FeePolicyInputs {
  readonly basisPoints: bigint;
  readonly fixedAmount: MinorUnits;
  readonly minimumCaptureAmount: MinorUnits;
}

export interface FeeSnapshot {
  readonly basisPoints: bigint;
  readonly fixedAmount: MinorUnits;
  readonly captureFee: MinorUnits;
  readonly captureGross: MinorUnits;
}

const BASIS_POINTS_MAX = 10000n;
/** HALF_UP on a 1/10000 scale: the numerator is offset by half a basis point before flooring. */
const ROUNDING_OFFSET = 5000n;
const BASIS_POINTS_SCALE = 10000n;

function invalid(
  reason:
    | 'FEE_POLICY_INVALID'
    | 'GROSS_INVALID'
    | 'FEE_EXCEEDS_GROSS'
    | 'FEE_SNAPSHOT_INVALID'
    | 'REFUND_EXCEEDS_CAPTURE'
    | 'AMOUNT_OVERFLOW',
) {
  return new DomainError('INTERNAL_ERROR', reason);
}

/**
 * The percentage component, HALF_UP. The fee is never capped: exceeding `MAX_AMOUNT_MINOR` or the
 * gross is an invariant breach that throws, because a silently reduced fee would under-charge and a
 * silently grown one would over-charge — both are accounting errors, not inputs to accept.
 */
export function computeCaptureFee(
  gross: MinorUnits,
  basisPoints: bigint,
  fixedAmount: MinorUnits,
): MinorUnits {
  if (basisPoints < 0n || basisPoints > BASIS_POINTS_MAX || fixedAmount > MAX_AMOUNT_MINOR) {
    throw invalid('FEE_POLICY_INVALID');
  }
  if (gross < 1n || gross > MAX_AMOUNT_MINOR) {
    throw invalid('GROSS_INVALID');
  }

  // bigint division truncates toward zero, which is floor for non-negative operands.
  const percentageFee = (gross * basisPoints + ROUNDING_OFFSET) / BASIS_POINTS_SCALE;
  const fee = percentageFee + fixedAmount;

  // Checked before the gross comparison: a fee beyond the column's range is the more fundamental
  // defect, and reporting `FEE_EXCEEDS_GROSS` for it would misdirect whoever reads the log.
  if (fee > MAX_AMOUNT_MINOR) {
    throw invalid('AMOUNT_OVERFLOW');
  }
  if (fee > gross) {
    throw invalid('FEE_EXCEEDS_GROSS');
  }

  return minorUnits(fee);
}

/** The percentage component alone, for tests and for the golden-file `percentageFee` column. */
export function computePercentageFee(gross: MinorUnits, basisPoints: bigint): MinorUnits {
  return minorUnits((gross * basisPoints + ROUNDING_OFFSET) / BASIS_POINTS_SCALE);
}

/**
 * Rejects a capture below the policy minimum. The problem detail names the minimum because the
 * merchant has to know what to send (docs/05 §Canonical error format).
 */
export function checkCaptureMinimum(
  gross: MinorUnits,
  minimumCaptureAmount: MinorUnits,
): Result<void> {
  if (gross < minimumCaptureAmount) {
    return err<void>(
      new DomainError('CAPTURE_BELOW_MINIMUM', 'BELOW_MINIMUM_CAPTURE', {
        minimumAmountMinor: toAmountString(minimumCaptureAmount),
      }),
    );
  }
  return ok(undefined);
}

/**
 * The policy-insertion rule P02 mirrors as a SQL `CHECK` (R-12).
 *
 * The floor rule alone is not sufficient. `F(G) - G` is non-increasing in `G` for `basisPoints <=
 * 10000`, so requiring `F(minimum) <= minimum` guarantees `F <= G` for every `G >= minimum`. Without
 * that requirement a policy such as basis points 5000, fixed 30, minimum 30 is accepted and then
 * produces `F(40) = 50 > 40`.
 */
export function checkFeePolicy(policy: FeePolicyInputs): Result<void> {
  const { basisPoints, fixedAmount, minimumCaptureAmount } = policy;

  if (basisPoints < 0n || basisPoints > BASIS_POINTS_MAX) {
    return err<void>(invalid('FEE_POLICY_INVALID'));
  }
  if (fixedAmount < 0n || fixedAmount > MAX_AMOUNT_MINOR) {
    return err<void>(invalid('FEE_POLICY_INVALID'));
  }
  // docs/07: minimum >= max(fixed, 1).
  if (minimumCaptureAmount < 1n || minimumCaptureAmount < fixedAmount) {
    return err<void>(invalid('FEE_POLICY_INVALID'));
  }

  const feeAtMinimum =
    (minimumCaptureAmount * basisPoints + ROUNDING_OFFSET) / BASIS_POINTS_SCALE + fixedAmount;
  if (feeAtMinimum > minimumCaptureAmount) {
    return err<void>(invalid('FEE_POLICY_INVALID'));
  }

  return ok(undefined);
}

/**
 * The fee that should have been reversed once `cumulativeRefunded` of `captureGross` is refunded.
 * `F * R` reaches 10^24 here, which is exact in `bigint`.
 */
export function targetFeeReversed(
  captureFee: MinorUnits,
  cumulativeRefunded: MinorUnits,
  captureGross: MinorUnits,
): MinorUnits {
  if (
    captureGross < 1n ||
    captureGross > MAX_AMOUNT_MINOR ||
    captureFee < 0n ||
    captureFee > captureGross
  ) {
    throw invalid('FEE_SNAPSHOT_INVALID');
  }
  if (cumulativeRefunded < 0n || cumulativeRefunded > captureGross) {
    throw invalid('REFUND_EXCEEDS_CAPTURE');
  }

  return minorUnits((captureFee * cumulativeRefunded) / captureGross);
}

export interface IncrementalReversalInput {
  readonly captureFee: MinorUnits;
  readonly captureGross: MinorUnits;
  /** Refunds already confirmed for this capture, before the one being attributed. */
  readonly confirmedRefundedBefore: MinorUnits;
  readonly refundAmount: MinorUnits;
}

/**
 * The reversal attributable to one refund confirmation: the difference between the cumulative
 * target after it and the cumulative target before it. Never a per-refund rate, so a later refund
 * can receive fewer units than an earlier one and the total still lands exactly on `F`.
 */
export function incrementalFeeReversal(input: IncrementalReversalInput): MinorUnits {
  const { captureFee, captureGross, confirmedRefundedBefore, refundAmount } = input;

  if (refundAmount < 1n) {
    throw invalid('FEE_SNAPSHOT_INVALID');
  }

  // Unbounded sum first, so an over-refund is reported as such rather than as a branding failure.
  const afterRaw = confirmedRefundedBefore + refundAmount;
  if (afterRaw > captureGross) {
    throw invalid('REFUND_EXCEEDS_CAPTURE');
  }
  const after = minorUnits(afterRaw);

  const before = targetFeeReversed(captureFee, confirmedRefundedBefore, captureGross);
  const total = targetFeeReversed(captureFee, after, captureGross);

  return minorUnits(total - before);
}
