/**
 * The domain's error and result vocabulary (CONVENTIONS §7, docs/05 §Canonical error format).
 *
 * Two fields, two audiences. `code` is the merchant-facing problem code and must exist in
 * `docs/05`; `reason` is a stable internal detail that explains *why* without changing the
 * public contract. Only `code` crosses the HTTP boundary, so a new reason can be added without
 * a contract change, while a new code cannot **[ASSUMPTION A-01]**.
 *
 * `detail` is for structured context and is typed as string values on purpose: raw input is
 * never carried here, because these values reach logs. A caller that wants to report a rejected
 * value reports its shape, not its content.
 */

/**
 * The subset of docs/05 problem codes the domain can raise. P01-GATE asserts this is a subset of
 * the OpenAPI `ProblemCode` enum, so a typo or a code that does not exist fails there rather than
 * at an HTTP boundary months later.
 */
export const DOMAIN_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_AMOUNT',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_CORRELATION_ID',
  'ACTIVE_OPERATION_EXISTS',
  'INVALID_PAYMENT_STATE',
  'MONETARY_GUARD_FAILED',
  'CAPTURE_BELOW_MINIMUM',
  'INTERNAL_ERROR',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/**
 * Internal reasons. Later tasks append to this union only; it has a single owner per commit to
 * keep the vocabulary from drifting into near-duplicates.
 */
export type DomainErrorReason =
  // Money
  | 'AMOUNT_NOT_STRING'
  | 'AMOUNT_MALFORMED'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'AMOUNT_NOT_POSITIVE'
  | 'CURRENCY_UNSUPPORTED'
  | 'AMOUNT_OVERFLOW'
  | 'AMOUNT_NEGATIVE'
  // Identifiers and values
  | 'ID_MALFORMED'
  | 'VALUE_MALFORMED'
  // Fees
  | 'FEE_POLICY_INVALID'
  | 'GROSS_INVALID'
  | 'FEE_EXCEEDS_GROSS'
  | 'FEE_SNAPSHOT_INVALID'
  | 'REFUND_EXCEEDS_CAPTURE'
  // Payment guards
  | 'EXCLUSIVE_OPERATION_UNRESOLVED'
  | 'REFUND_UNRESOLVED'
  | 'GUARD_FAILED'
  | 'AUTHORIZATION_ATTEMPTS_EXHAUSTED'
  | 'CAPTURE_EXCEEDS_AUTHORIZED'
  | 'REFUND_EXCEEDS_REFUNDABLE'
  | 'BELOW_MINIMUM_CAPTURE'
  // Transitions
  | 'ILLEGAL_OPERATION_TRANSITION'
  | 'EXPIRY_NOT_APPLICABLE'
  // Ledger
  | 'ENTRIES_INVALID'
  | 'UNBALANCED_POSTING'
  | 'REFERENCES_INVALID'
  // Canonicalisation
  | 'NON_CANONICAL_JSON'
  | 'PROVIDER_KEY_LIMIT_TOO_SMALL';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly reason: DomainErrorReason;
  readonly detail: Readonly<Record<string, string>> | undefined;

  constructor(
    code: DomainErrorCode,
    reason: DomainErrorReason,
    detail?: Readonly<Record<string, string>>,
  ) {
    super(`${code}:${reason}`);
    this.name = 'DomainError';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

/** A value or a domain error. Used where a throw would cross a boundary that must stay total. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = <T = never>(error: DomainError): Result<T> => ({ ok: false, error });

/** Convenience for tests and callers that need the value or a throw. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}
