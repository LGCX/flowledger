/**
 * Canonical JSON — the RFC 8785 serialization restricted to what this system hashes
 * (docs/05 §Canonical request hash, ADR-0006).
 *
 * The restriction is the point. RFC 8785 allows the full IEEE-754 double range, which cannot be
 * reproduced byte-for-byte by PostgreSQL's `jsonb` ordering or by a different language's float
 * formatter. Accepting only safe integers keeps the TypeScript and the database canonicalisations
 * byte-identical, and contract money is always a string anyway **[ASSUMPTION A-02]**.
 *
 * Anything that would serialize differently in two runtimes throws rather than being coerced:
 * `bigint`, `undefined`, functions, symbols, non-plain objects, unsafe numbers, and strings
 * containing a lone surrogate. A hash computed over a coerced value is worse than a crash, because
 * two semantically different commands would then share an idempotency key.
 */
import { createHash } from 'node:crypto';
import { DomainError } from './errors.js';

export type JsonValue =
  null | boolean | string | number | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function nonCanonical(detail: string): DomainError {
  return new DomainError('INTERNAL_ERROR', 'NON_CANONICAL_JSON', { value: detail });
}

/** A lone surrogate cannot be encoded as UTF-8, so it can never hash identically twice. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw nonCanonical('lone surrogate');
  }
  // `JSON.stringify` matches RFC 8785 for well-formed strings.
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw nonCanonical('number is not a safe integer');
  }
  // `-0` and `0` must produce the same bytes; `String(-0)` already yields `'0'`.
  return String(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return serializeString(value);
    case 'number':
      return serializeNumber(value);
    case 'bigint':
      throw nonCanonical('bigint');
    case 'undefined':
      throw nonCanonical('undefined');
    case 'function':
      throw nonCanonical('function');
    case 'symbol':
      throw nonCanonical('symbol');
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw nonCanonical('non-plain object');
  }

  const record = value as Record<string, unknown>;
  // Default sort comparator orders by UTF-16 code units, which is what RFC 8785 requires.
  const keys = Object.keys(record).sort();
  const pairs = keys.map((key) => `${serializeString(key)}:${serialize(record[key])}`);
  return `{${pairs.join(',')}}`;
}

export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

/** SHA-256 of the UTF-8 encoding of `text`. */
export function sha256(text: string): Uint8Array {
  return createHash('sha256').update(text, 'utf8').digest();
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
