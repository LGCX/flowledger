/**
 * The payment aggregate, its operation records, the invariant checker, and the derived summary
 * status (docs/03 §Canonical aggregate, §Monetary invariants, §Derived summary status;
 * docs/05 §Payment).
 *
 * Amounts are `MinorUnits` throughout; `number` appears only for counts and versions, which are
 * not money. That is why the ESLint money rule is scoped to `money.ts` and `fees.ts` rather than
 * every file under `src/` — this file legitimately holds a `number` for `version` and for
 * `unresolvedRefundCount`.
 *
 * `checkPaymentInvariants` reports *every* violated id rather than stopping at the first. A state
 * that breaks one rule usually breaks a dependent one too, and a single-id report would send
 * whoever debugs it to the symptom instead of the cause. The checker never mutates and never
 * throws: it is a diagnostic, and callers decide what a violation means.
 *
 * `deriveSummaryStatus` is display-only and follows the contract's precedence order exactly. It is
 * deliberately not part of any decision: the authoritative state is the totals plus the operation
 * rows.
 */
import type { FeeSnapshot } from './fees.js';
import type { OperationId, PaymentId } from './ids.js';
import type { MinorUnits } from './money.js';
import type { Timestamp } from './values.js';

export const OPERATION_TYPES = ['AUTHORIZE', 'CAPTURE', 'CANCEL', 'REFUND'] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'UNKNOWN',
  'REQUIRES_REVIEW',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const AUTHORIZATION_OUTCOMES = [
  'NOT_REQUESTED',
  'AUTHORIZED',
  'DECLINED',
  'CANCELED',
  'EXPIRED',
] as const;
export type AuthorizationOutcome = (typeof AUTHORIZATION_OUTCOMES)[number];

export const SUMMARY_STATUSES = [
  'REQUIRES_REVIEW',
  'OUTCOME_UNKNOWN',
  'PROCESSING',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'CAPTURED',
  'PARTIALLY_CAPTURED',
  'CANCELED',
  'EXPIRED',
  'AUTHORIZED',
  'AUTHORIZATION_FAILED',
  'REQUIRES_AUTHORIZATION',
] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

export interface PaymentState {
  readonly id: PaymentId;
  readonly requested: MinorUnits;
  readonly authorized: MinorUnits;
  readonly captured: MinorUnits;
  readonly refunded: MinorUnits;
  readonly voided: MinorUnits;
  readonly reservedRefund: MinorUnits;
  readonly unresolvedRefundCount: number;
  readonly authorizationOutcome: AuthorizationOutcome;
  readonly activeExclusiveOperationId: OperationId | null;
  readonly version: number;
}

export interface OperationState {
  readonly id: OperationId;
  readonly type: OperationType;
  readonly amount: MinorUnits;
  readonly status: OperationStatus;
  readonly notBefore: Timestamp | null;
  readonly version: number;
  /** CAPTURE: the snapshotted fee. REFUND: set once SUCCEEDED. AUTHORIZE/CANCEL: always null. */
  readonly feeEffect: MinorUnits | null;
  /** CAPTURE and REFUND (a refund copies the capture's snapshot); null otherwise. */
  readonly feeSnapshot: FeeSnapshot | null;
}

const UNRESOLVED: readonly OperationStatus[] = [
  'REQUESTED',
  'PROCESSING',
  'UNKNOWN',
  'REQUIRES_REVIEW',
];

const TERMINAL: readonly OperationStatus[] = ['SUCCEEDED', 'REJECTED', 'FAILED'];

export function isUnresolved(status: OperationStatus): boolean {
  return UNRESOLVED.includes(status);
}

export function isTerminal(status: OperationStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Refunds are concurrent: several may be unresolved at once, bounded by the reservation instead of
 * by an exclusive slot. Everything else takes the single exclusive slot on the payment.
 */
export function exclusionClass(type: OperationType): 'EXCLUSIVE' | 'CONCURRENT' {
  return type === 'REFUND' ? 'CONCURRENT' : 'EXCLUSIVE';
}

export const INVARIANT_IDS = [
  'REQUESTED_POSITIVE',
  'COUNT_NON_NEGATIVE',
  'AUTHORIZED_LE_REQUESTED',
  'CAPTURED_LE_AUTHORIZED',
  'REFUNDED_LE_CAPTURED',
  'VOIDED_LE_AUTHORIZED_MINUS_CAPTURED',
  'REFUNDED_PLUS_RESERVED_LE_CAPTURED',
  'RESERVATION_ZERO_IFF_COUNT_ZERO',
  'RESERVATION_EQUALS_UNRESOLVED_REFUNDS',
  'COUNT_EQUALS_UNRESOLVED_REFUNDS',
  'AT_MOST_ONE_UNRESOLVED_EXCLUSIVE',
  'EXCLUSIVE_POINTER_MATCHES',
  'UNAUTHORIZED_TOTALS_ZERO',
  'CANCELED_OR_EXPIRED_VOIDS_ALL',
  'CAPTURE_RELEASES_REMAINDER',
  'CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE',
  'REFUND_FEE_ONLY_ON_SUCCESS',
  'AT_MOST_THREE_AUTHORIZATIONS',
] as const;

export type InvariantId = (typeof INVARIANT_IDS)[number];

/** Every violated invariant id, in declaration order. An empty array means the state is valid. */
export function checkPaymentInvariants(
  payment: PaymentState,
  operations: readonly OperationState[],
): readonly InvariantId[] {
  const violated: InvariantId[] = [];
  const add = (id: InvariantId, broken: boolean): void => {
    if (broken) violated.push(id);
  };

  const unresolvedRefunds = operations.filter(
    (op) => op.type === 'REFUND' && isUnresolved(op.status),
  );
  const unresolvedExclusive = operations.filter(
    (op) => exclusionClass(op.type) === 'EXCLUSIVE' && isUnresolved(op.status),
  );
  const succeededCaptures = operations.filter(
    (op) => op.type === 'CAPTURE' && op.status === 'SUCCEEDED',
  );
  const reservedSum = unresolvedRefunds.reduce((sum, op) => sum + op.amount, 0n);

  add('REQUESTED_POSITIVE', payment.requested <= 0n);
  add('COUNT_NON_NEGATIVE', payment.unresolvedRefundCount < 0);
  add('AUTHORIZED_LE_REQUESTED', payment.authorized > payment.requested);
  add('CAPTURED_LE_AUTHORIZED', payment.captured > payment.authorized);
  add('REFUNDED_LE_CAPTURED', payment.refunded > payment.captured);
  add(
    'VOIDED_LE_AUTHORIZED_MINUS_CAPTURED',
    payment.voided > payment.authorized - payment.captured,
  );
  add(
    'REFUNDED_PLUS_RESERVED_LE_CAPTURED',
    payment.refunded + payment.reservedRefund > payment.captured,
  );
  add(
    'RESERVATION_ZERO_IFF_COUNT_ZERO',
    (payment.reservedRefund === 0n) !== (payment.unresolvedRefundCount === 0),
  );
  add('RESERVATION_EQUALS_UNRESOLVED_REFUNDS', payment.reservedRefund !== reservedSum);
  add(
    'COUNT_EQUALS_UNRESOLVED_REFUNDS',
    payment.unresolvedRefundCount !== unresolvedRefunds.length,
  );
  add('AT_MOST_ONE_UNRESOLVED_EXCLUSIVE', unresolvedExclusive.length > 1);

  // The pointer must name the one exclusive operation in flight, and nothing else.
  const pointerMatches =
    unresolvedExclusive.length === 1
      ? payment.activeExclusiveOperationId === unresolvedExclusive[0]?.id
      : unresolvedExclusive.length === 0
        ? payment.activeExclusiveOperationId === null
        : false;
  add('EXCLUSIVE_POINTER_MATCHES', !pointerMatches);

  add(
    'UNAUTHORIZED_TOTALS_ZERO',
    (payment.authorizationOutcome === 'NOT_REQUESTED' ||
      payment.authorizationOutcome === 'DECLINED') &&
      (payment.authorized !== 0n ||
        payment.captured !== 0n ||
        payment.refunded !== 0n ||
        payment.voided !== 0n),
  );

  add(
    'CANCELED_OR_EXPIRED_VOIDS_ALL',
    (payment.authorizationOutcome === 'CANCELED' || payment.authorizationOutcome === 'EXPIRED') &&
      (payment.captured !== 0n || payment.refunded !== 0n || payment.voided !== payment.authorized),
  );

  if (succeededCaptures.length > 0) {
    add('CAPTURE_RELEASES_REMAINDER', payment.captured + payment.voided !== payment.authorized);
  }

  add(
    'CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE',
    payment.captured > 0n !== (succeededCaptures.length === 1) || succeededCaptures.length > 1,
  );

  add(
    'REFUND_FEE_ONLY_ON_SUCCESS',
    operations.some(
      (op) => op.type === 'REFUND' && (op.feeEffect !== null) !== (op.status === 'SUCCEEDED'),
    ),
  );

  add(
    'AT_MOST_THREE_AUTHORIZATIONS',
    operations.filter((op) => op.type === 'AUTHORIZE').length > 3,
  );

  return violated;
}

/**
 * The display status, in the contract's precedence order (docs/03 §Derived summary status).
 *
 * Each rule outranks every later one, so the order of these `if`s is the contract. Rules 4–7 use the
 * confirmed totals, not the operations, because the totals are what the ledger reflects.
 */
export function deriveSummaryStatus(
  payment: PaymentState,
  operations: readonly OperationState[],
): SummaryStatus {
  // 1–3: an operation in flight determines the summary regardless of the totals.
  if (operations.some((op) => op.status === 'REQUIRES_REVIEW')) return 'REQUIRES_REVIEW';
  if (operations.some((op) => op.status === 'UNKNOWN')) return 'OUTCOME_UNKNOWN';
  if (operations.some((op) => op.status === 'REQUESTED' || op.status === 'PROCESSING')) {
    return 'PROCESSING';
  }

  // 4–5: refunds, tested before capture states because a fully refunded payment is not "captured".
  if (payment.captured > 0n && payment.refunded === payment.captured) return 'REFUNDED';
  if (payment.refunded > 0n) return 'PARTIALLY_REFUNDED';

  // 6–7: capture progress. A partial capture that released the remainder is fully resolved, so
  // rule 6 covers it; rule 7 is the only state the MVP cannot reach (docs/03).
  if (payment.captured > 0n && payment.captured + payment.voided === payment.authorized) {
    return 'CAPTURED';
  }
  if (payment.captured > 0n && payment.captured + payment.voided < payment.authorized) {
    return 'PARTIALLY_CAPTURED';
  }

  // 8–9: authorization outcomes.
  if (payment.authorizationOutcome === 'CANCELED') return 'CANCELED';
  if (payment.authorizationOutcome === 'EXPIRED') return 'EXPIRED';
  if (payment.authorizationOutcome === 'AUTHORIZED') return 'AUTHORIZED';

  // 10: declined, or the most recent AUTHORIZE attempt failed. The last attempt in creation order is
  // the one that stands **[ASSUMPTION A-05]**.
  if (payment.authorizationOutcome === 'DECLINED') return 'AUTHORIZATION_FAILED';
  const authorizations = operations.filter((op) => op.type === 'AUTHORIZE');
  if (authorizations[authorizations.length - 1]?.status === 'FAILED') return 'AUTHORIZATION_FAILED';

  // 11: nothing has happened yet.
  return 'REQUIRES_AUTHORIZATION';
}
