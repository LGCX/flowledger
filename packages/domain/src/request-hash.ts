/**
 * The versioned canonical API request hash (docs/05 §Canonical request hash, ADR-0006).
 *
 * A request hashes its *semantic* content: the command type, the route template, the path
 * parameters that identify the payment, the schema-validated body, and the `If-Match` header. It
 * deliberately does not hash the merchant, the idempotency key, credentials, request or correlation
 * IDs, or `traceparent` — replaying the same command under a new idempotency key must hash
 * identically, and a retry with a new trace must too.
 *
 * The canonical object and the `hashVersion` are part of the hashed bytes, so a future change to
 * the encoding can be introduced alongside the old one instead of silently invalidating every
 * stored record.
 *
 * **[ASSUMPTION A-03]** docs/05 names the six inputs but not their byte encoding; this object is
 * that encoding.
 */
import { canonicalJson, sha256, type JsonValue } from './canonical-json.js';
import { DomainError, type Result, err, ok } from './errors.js';
import { parseId } from './ids.js';

export type CommandType = 'CREATE_PAYMENT' | 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';

export const COMMAND_ROUTES: {
  readonly [C in CommandType]: {
    readonly method: 'POST';
    readonly route: string;
    readonly pathParams: readonly string[];
  };
} = {
  CREATE_PAYMENT: { method: 'POST', route: '/v1/payments', pathParams: [] },
  AUTHORIZE: {
    method: 'POST',
    route: '/v1/payments/{paymentId}/authorizations',
    pathParams: ['paymentId'],
  },
  CAPTURE: {
    method: 'POST',
    route: '/v1/payments/{paymentId}/captures',
    pathParams: ['paymentId'],
  },
  CANCEL: {
    method: 'POST',
    route: '/v1/payments/{paymentId}/cancellations',
    pathParams: ['paymentId'],
  },
  REFUND: { method: 'POST', route: '/v1/payments/{paymentId}/refunds', pathParams: ['paymentId'] },
};

export interface CanonicalRequestInput {
  readonly commandType: CommandType;
  /** Exactly the keys in `COMMAND_ROUTES[commandType].pathParams`. */
  readonly pathParams: Readonly<Record<string, string>>;
  /** The schema-validated body; unknown fields were already rejected upstream. */
  readonly body: JsonValue;
  /** Exact header text including quotes, or null when the header was omitted. */
  readonly ifMatch: string | null;
}

const HASH_VERSION = 1;
const API_VERSION = 'v1';

/** Strong single Payment ETag only: weak tags and lists cannot pin one version. */
const PAYMENT_ETAG = /^"payment-pay_[0-7][0-9A-HJKMNP-TV-Z]{25}-v[1-9][0-9]*"$/;

function malformed(detail: string): DomainError {
  return new DomainError('INVALID_REQUEST', 'VALUE_MALFORMED', { value: detail });
}

export function canonicalRequestJson(input: CanonicalRequestInput): Result<string> {
  const route = COMMAND_ROUTES[input.commandType];
  if (route === undefined) return err<string>(malformed('unknown command type'));

  const expected = [...route.pathParams].sort();
  const supplied = Object.keys(input.pathParams).sort();
  if (
    expected.length !== supplied.length ||
    expected.some((key, index) => key !== supplied[index])
  ) {
    return err<string>(malformed('pathParams do not match the route template'));
  }

  for (const name of route.pathParams) {
    if (name === 'paymentId') {
      if (!parseId('pay', input.pathParams[name]).ok) return err<string>(malformed('paymentId'));
    }
  }

  if (input.ifMatch !== null && !PAYMENT_ETAG.test(input.ifMatch)) {
    return err<string>(malformed('ifMatch'));
  }

  // Built in a fixed key order; `canonicalJson` sorts anyway, but the shape is stated explicitly so
  // a reader sees exactly what is hashed.
  const canonicalDocument: JsonValue = {
    apiVersion: API_VERSION,
    body: input.body,
    commandType: input.commandType,
    hashVersion: HASH_VERSION,
    ifMatch: input.ifMatch,
    method: route.method,
    pathParams: { ...input.pathParams },
    route: route.route,
  };

  try {
    return ok(canonicalJson(canonicalDocument));
  } catch (error) {
    // A body that cannot be canonicalised is a caller defect, not a hash mismatch.
    if (error instanceof DomainError) return err<string>(error);
    throw error;
  }
}

export function computeRequestHash(input: CanonicalRequestInput): Result<Uint8Array> {
  const canonical = canonicalRequestJson(input);
  if (!canonical.ok) return err<Uint8Array>(canonical.error);
  return ok(sha256(canonical.value));
}
