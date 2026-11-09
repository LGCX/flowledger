/**
 * Retry classification, provider observation normalization, and jittered backoff
 * (docs/04 §Retry and dead-letter policy, docs/08 §Retry classification, §No-blind-retry rule,
 * docs/06 §Error taxonomy, §Timeout and ambiguous-result policy).
 *
 * Everything here is pure and takes its randomness as an argument. A `Math.random()` call inside
 * `backoff` would make the schedule untestable and non-reproducible for no benefit: the caller owns
 * the entropy.
 *
 * The single most important rule in this file is the post-send invariant. Once a request may have
 * reached the provider, *no* observation may classify as `FAILED` or `RETRYABLE_NO_EFFECT`, because
 * both of those authorize a retry — and a retry of an operation that already happened is a double
 * capture or a double refund. Anything that could have landed is `UNKNOWN`, which routes to
 * reconciliation instead.
 *
 * **[ASSUMPTION A-07]** docs/08 says delays include jitter without stating a magnitude; ±20 % uniform
 * is used here. It is applied as `floor((2r-1)·base/5)`, so the range is `[0.8·base, 1.2·base)`.
 */
import type { ProviderOutcome } from './provider.js';

/**
 * Message delivery retries: seven attempts, then the dead-letter queue (docs/04).
 */
export const MESSAGE_RETRY_SCHEDULE_MS = [
  1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000,
] as const;

/** Reconciliation checks: five attempts, then the operation moves to REQUIRES_REVIEW. */
export const RECONCILIATION_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;

/** A provider `Retry-After` is honoured only up to one hour. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

export type BackoffDecision =
  { readonly kind: 'RETRY'; readonly delayMs: number } | { readonly kind: 'EXHAUSTED' };

/**
 * `failuresSoFar` is 1-based: the delay that follows the first failure is `schedule[0]`.
 *
 * A value below 1 is a caller defect rather than an exhausted schedule, so it throws instead of
 * returning a decision — silently retrying immediately would hide the bug and hammer the provider.
 */
export function backoff(
  schedule: readonly number[],
  failuresSoFar: number,
  random: () => number,
): BackoffDecision {
  if (!Number.isInteger(failuresSoFar) || failuresSoFar < 1) {
    throw new RangeError('failuresSoFar must be an integer >= 1');
  }
  if (failuresSoFar > schedule.length) return { kind: 'EXHAUSTED' };

  const base = schedule[failuresSoFar - 1] ?? 0;
  const r = random();
  // floor((2r - 1) * base / 5): at r = 0 that is -0.2·base, at r -> 1 it approaches +0.2·base.
  const jitter = Math.floor(((2 * r - 1) * base) / 5);
  return { kind: 'RETRY', delayMs: base + jitter };
}

/** A provider hint is honoured but never beyond `maxMs`; a missing or negative hint falls back. */
export function boundRetryHint(hintMs: number | null, fallbackMs: number, maxMs: number): number {
  if (hintMs === null || hintMs < 0) return fallbackMs;
  return Math.min(hintMs, maxMs);
}

export type MessageFailureClass =
  | 'TRANSIENT_INFRASTRUCTURE'
  | 'HANDLER_RATE_LIMITED'
  | 'SCHEMA_INVALID'
  | 'UNSUPPORTED_VERSION'
  | 'INVARIANT_VIOLATION'
  | 'DUPLICATE_DELIVERY';

export type MessageFailureAction =
  | 'RETRY_WITH_BACKOFF'
  | 'RETRY_AFTER_HINT'
  | 'DLQ_AND_ALERT'
  | 'DLQ_DISCREPANCY_AND_REVIEW'
  | 'ACK_AFTER_DEDUPE';

const MESSAGE_FAILURE_ACTIONS: Readonly<Record<MessageFailureClass, MessageFailureAction>> =
  Object.freeze({
    TRANSIENT_INFRASTRUCTURE: 'RETRY_WITH_BACKOFF',
    HANDLER_RATE_LIMITED: 'RETRY_AFTER_HINT',
    SCHEMA_INVALID: 'DLQ_AND_ALERT',
    UNSUPPORTED_VERSION: 'DLQ_AND_ALERT',
    INVARIANT_VIOLATION: 'DLQ_DISCREPANCY_AND_REVIEW',
    DUPLICATE_DELIVERY: 'ACK_AFTER_DEDUPE',
  });

export function classifyMessageFailure(failureClass: MessageFailureClass): MessageFailureAction {
  return MESSAGE_FAILURE_ACTIONS[failureClass];
}

/**
 * The closed reconciliation-reason vocabulary. It is an event schema enum, so a value here that is
 * not there is a contract break rather than a typo — hence the parity test at P01-GATE.
 */
export const RECONCILIATION_REASONS = [
  'TIMEOUT_AFTER_SEND',
  'CONNECTION_LOST_AFTER_SEND',
  'PROVIDER_5XX_AMBIGUOUS',
  'SDK_EXCEPTION_AFTER_SEND',
  'MALFORMED_PROVIDER_RESPONSE',
  'MISSING_PROVIDER_CORRELATION',
  'WORKER_CRASH_AFTER_SEND',
  'STALE_PROCESSING',
  'ADAPTER_DEFECT',
] as const;

export type ReconciliationReason = (typeof RECONCILIATION_REASONS)[number];

export type TransportObservation =
  | 'CONFIRMED_MATCHING_SUCCESS'
  | 'BUSINESS_DECLINE'
  | 'LOCAL_VALIDATION_FAILED'
  | 'AUTHENTICATED_NO_EFFECT_REJECTION'
  | 'PRE_SEND_FAILURE_RETRYABLE'
  | 'PRE_SEND_FAILURE_FINAL'
  | 'RATE_LIMITED_NOT_EXECUTED'
  | 'TIMEOUT_AFTER_SEND'
  | 'CONNECTION_LOST_AFTER_SEND'
  | 'PROVIDER_5XX'
  | 'SDK_EXCEPTION_AFTER_SEND'
  | 'MALFORMED_SUCCESS'
  | 'MISSING_CORRELATION'
  | 'WORKER_CRASH_AFTER_SEND'
  | 'STALE_PROCESSING'
  | 'ADAPTER_DEFECT';

interface ObservationClassification {
  readonly outcome: ProviderOutcome['outcome'];
  readonly reconciliationReason: ReconciliationReason | null;
}

const OBSERVATIONS: Readonly<Record<TransportObservation, ObservationClassification>> =
  Object.freeze({
    CONFIRMED_MATCHING_SUCCESS: { outcome: 'SUCCEEDED', reconciliationReason: null },
    BUSINESS_DECLINE: { outcome: 'REJECTED', reconciliationReason: null },
    LOCAL_VALIDATION_FAILED: { outcome: 'FAILED', reconciliationReason: null },
    AUTHENTICATED_NO_EFFECT_REJECTION: { outcome: 'FAILED', reconciliationReason: null },
    PRE_SEND_FAILURE_RETRYABLE: { outcome: 'RETRYABLE_NO_EFFECT', reconciliationReason: null },
    PRE_SEND_FAILURE_FINAL: { outcome: 'FAILED', reconciliationReason: null },
    RATE_LIMITED_NOT_EXECUTED: { outcome: 'RETRYABLE_NO_EFFECT', reconciliationReason: null },
    TIMEOUT_AFTER_SEND: { outcome: 'UNKNOWN', reconciliationReason: 'TIMEOUT_AFTER_SEND' },
    CONNECTION_LOST_AFTER_SEND: {
      outcome: 'UNKNOWN',
      reconciliationReason: 'CONNECTION_LOST_AFTER_SEND',
    },
    PROVIDER_5XX: { outcome: 'UNKNOWN', reconciliationReason: 'PROVIDER_5XX_AMBIGUOUS' },
    SDK_EXCEPTION_AFTER_SEND: {
      outcome: 'UNKNOWN',
      reconciliationReason: 'SDK_EXCEPTION_AFTER_SEND',
    },
    MALFORMED_SUCCESS: { outcome: 'UNKNOWN', reconciliationReason: 'MALFORMED_PROVIDER_RESPONSE' },
    MISSING_CORRELATION: {
      outcome: 'UNKNOWN',
      reconciliationReason: 'MISSING_PROVIDER_CORRELATION',
    },
    WORKER_CRASH_AFTER_SEND: {
      outcome: 'UNKNOWN',
      reconciliationReason: 'WORKER_CRASH_AFTER_SEND',
    },
    STALE_PROCESSING: { outcome: 'UNKNOWN', reconciliationReason: 'STALE_PROCESSING' },
    ADAPTER_DEFECT: { outcome: 'UNKNOWN', reconciliationReason: 'ADAPTER_DEFECT' },
  });

export function classifyObservation(observation: TransportObservation): ObservationClassification {
  return OBSERVATIONS[observation];
}

/** Observations that can only be taken after the request may have reached the provider. */
export const POST_SEND_OBSERVATIONS: readonly TransportObservation[] = [
  'TIMEOUT_AFTER_SEND',
  'CONNECTION_LOST_AFTER_SEND',
  'PROVIDER_5XX',
  'SDK_EXCEPTION_AFTER_SEND',
  'MALFORMED_SUCCESS',
  'MISSING_CORRELATION',
  'WORKER_CRASH_AFTER_SEND',
  'STALE_PROCESSING',
  'ADAPTER_DEFECT',
];
