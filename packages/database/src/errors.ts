/**
 * Domain error mapping.
 *
 * Protected functions raise `P0001` with a domain code as the message and a JSON DETAIL payload
 * (CONVENTIONS §7). This is the only place that translation happens, so no later task parses a
 * SQLSTATE by hand.
 *
 * `23505` and `23514` are deliberately *not* mapped: a unique or check violation reaching application
 * code means a protected function let something through that it should have converted itself. Mapping
 * them here would give that bug a friendly name.
 */
import pg from 'pg';

/**
 * Codes a SQL function may raise. Later phases append; nothing is ever renamed, because these strings
 * are wire values that appear in merchant-facing problem responses.
 */
export const DOMAIN_ERROR_CODES = [
  // docs/05 problem codes raised from SQL
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  'PROVIDER_ROUTE_UNAVAILABLE',
  'ACTIVE_OPERATION_EXISTS',
  'INVALID_PAYMENT_STATE',
  'MONETARY_GUARD_FAILED',
  'CAPTURE_BELOW_MINIMUM',
  'PAYMENT_VERSION_MISMATCH',
  'RESOURCE_NOT_FOUND',
  // internal invariant codes: no docs/05 code exists, so the API maps these to 500 INTERNAL_ERROR
  'INVALID_ENVELOPE',
  'IMMUTABLE_ROW',
  'IMMUTABLE_FIELD',
  'INVALID_TRANSITION',
  'TENANT_CONTEXT_MISMATCH',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

const KNOWN_CODES = new Set<string>(DOMAIN_ERROR_CODES);

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = 'DomainError';
  }
}

function parseDetail(detail: string | undefined): Record<string, unknown> {
  if (detail === undefined || detail.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(detail);
    // A DETAIL that is valid JSON but not an object is as unusable as malformed JSON.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function mapPgError(error: unknown): unknown {
  if (error instanceof pg.DatabaseError && error.code === 'P0001') {
    const message = error.message;
    if (KNOWN_CODES.has(message)) {
      return new DomainError(message as DomainErrorCode, parseDetail(error.detail));
    }
  }
  return error;
}
