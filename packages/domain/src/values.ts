/**
 * Strict constructors for the remaining scalar values (docs/10 §M1 "strict constructors",
 * docs/05 §General conventions, §API idempotency contract, §Request and correlation identifiers).
 *
 * Every pattern here is copied from `openapi/openapi.yaml`, not invented: these are wire values,
 * so a divergence between the API's accepted set and the domain's would show up as a request that
 * passes validation and then fails deep in the domain, or the reverse.
 *
 * Values are case-sensitive and are never normalised. That is a security property as much as a
 * contract one: the canonical request hash (T05) is computed over the exact bytes supplied, so a
 * constructor that lowercased a provider name would make two different requests hash identically.
 */
import { DomainError, type Result, err, ok } from './errors.js';

export type ProviderName = string & { readonly __brand: 'ProviderName' };
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };
/** UTC, exactly three fractional digits, literal `Z`. */
export type Timestamp = string & { readonly __brand: 'Timestamp' };

/** `openapi.yaml#/components/schemas/ProviderName`. */
const PROVIDER_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `openapi.yaml#/components/schemas/IdempotencyKey` and `CorrelationId`. */
const OPAQUE_REFERENCE = /^[A-Za-z0-9._:-]{16,128}$/;

/**
 * Exactly milliseconds and `Z`. A pattern alone cannot reject `2026-02-30T00:00:00.000Z`, because
 * `Date` silently rolls an impossible day forward, so the parse below round-trips the value and
 * compares it.
 */
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function malformed<T>(
  code: 'INVALID_REQUEST' | 'INVALID_IDEMPOTENCY_KEY' | 'INVALID_CORRELATION_ID',
) {
  return err<T>(new DomainError(code, 'VALUE_MALFORMED'));
}

export function parseProviderName(input: unknown): Result<ProviderName> {
  if (typeof input !== 'string' || !PROVIDER_NAME.test(input)) {
    return malformed<ProviderName>('INVALID_REQUEST');
  }
  return ok(input as ProviderName);
}

/**
 * The merchant's idempotency key. A malformed key is its own problem code because the merchant
 * sent it and can fix it, unlike a correlation ID which is ours.
 */
export function parseIdempotencyKey(input: unknown): Result<IdempotencyKey> {
  if (typeof input !== 'string' || !OPAQUE_REFERENCE.test(input)) {
    return malformed<IdempotencyKey>('INVALID_IDEMPOTENCY_KEY');
  }
  return ok(input as IdempotencyKey);
}

export function parseCorrelationId(input: unknown): Result<CorrelationId> {
  if (typeof input !== 'string' || !OPAQUE_REFERENCE.test(input)) {
    return malformed<CorrelationId>('INVALID_CORRELATION_ID');
  }
  return ok(input as CorrelationId);
}

/**
 * Parses a UTC timestamp with millisecond precision.
 *
 * The round-trip check is the load-bearing part: `new Date('2026-02-30T00:00:00.000Z')` succeeds
 * and yields 2 March, so a shape-only validator would accept a date that does not exist. Comparing
 * `toISOString()` against the input also rejects `24:00:00` and any other value the parser would
 * normalise.
 */
export function parseTimestamp(input: unknown): Result<Timestamp> {
  if (typeof input !== 'string' || !TIMESTAMP_SHAPE.test(input)) {
    return malformed<Timestamp>('INVALID_REQUEST');
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) {
    return malformed<Timestamp>('INVALID_REQUEST');
  }

  return ok(input as Timestamp);
}

/**
 * Renders a `Date` as a timestamp. An invalid `Date` has no wire representation, so this throws
 * rather than returning a `Result`: a caller holding one has a defect, not a merchant input.
 */
export function toTimestamp(date: Date): Timestamp {
  const milliseconds = date.getTime();
  if (Number.isNaN(milliseconds)) {
    throw new DomainError('INTERNAL_ERROR', 'VALUE_MALFORMED', { value: 'Invalid Date' });
  }
  return date.toISOString() as Timestamp;
}
