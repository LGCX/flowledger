/**
 * Stable provider idempotency keys (docs/06 §Stable provider idempotency).
 *
 * The key is a pure function of (environment, provider, operationId). It must never contain an attempt
 * number, a timestamp, or a retry counter: the whole point is that a retry of the same operation reuses
 * the key so the provider collapses the duplicate. A key that changed per attempt would convert every
 * retry into a second real capture.
 *
 * Some providers cap key length, so a versioned hashed form exists. `fl:v1:` is the version tag: a
 * future change to the hash input encoding must produce a new tag rather than silently reusing keys
 * from an incompatible derivation.
 *
 * **[ASSUMPTION A-08]** docs/06 shows `fl:v1:{base32(sha256(...))}` without byte-level detail. The
 * input is UTF-8 of `${environment}|${provider}|${operationId}` joined with a literal `|`, hashed with
 * SHA-256, encoded as RFC 4648 base32 in the lowercase alphabet with no padding — 52 characters, so
 * the key is 58.
 *
 * **[ASSUMPTION A-09]** `environment` here is the lowercase form (`local|test|sandbox`) used in the key,
 * while docs/07 stores ledger environment in upper case. Callers lower-case explicitly; this function
 * does not normalise, because a silent normalisation would hide a caller passing the wrong value.
 */
import { createHash } from 'node:crypto';
import { DomainError } from './errors.js';
import type { OperationId } from './ids.js';
import type { ProviderName } from './values.js';

export type ProviderEnvironment = 'local' | 'test' | 'sandbox';

export const PROVIDER_ENVIRONMENTS = ['local', 'test', 'sandbox'] as const;

export type ProviderKeyForm = 'PLAIN' | 'HASHED_V1';

export interface ProviderKeyInputs {
  readonly environment: ProviderEnvironment;
  readonly provider: ProviderName;
  readonly operationId: OperationId;
}

export interface ProviderKeyDerivation {
  readonly key: string;
  readonly form: ProviderKeyForm;
  readonly inputs: ProviderKeyInputs;
}

/** RFC 4648 base32, lowercase alphabet, no padding. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32LowerUnpadded(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

/** The hashed form's fixed length: `fl:v1:` + 52 base32 characters. */
const HASHED_KEY_LENGTH = 'fl:v1:'.length + 52;

export function deriveProviderIdempotencyKey(input: {
  environment: ProviderEnvironment;
  provider: ProviderName;
  operationId: OperationId;
  maxKeyLength: number;
}): ProviderKeyDerivation {
  const inputs: ProviderKeyInputs = Object.freeze({
    environment: input.environment,
    provider: input.provider,
    operationId: input.operationId,
  });

  const plain = `flowledger:${input.environment}:${input.provider}:${input.operationId}`;
  if (plain.length <= input.maxKeyLength)
    return Object.freeze({ key: plain, form: 'PLAIN', inputs });

  if (input.maxKeyLength < HASHED_KEY_LENGTH) {
    // The provider cannot hold even the hashed form: the route is ineligible, not "close enough".
    throw new DomainError('INTERNAL_ERROR', 'PROVIDER_KEY_LIMIT_TOO_SMALL', {
      maxKeyLength: String(input.maxKeyLength),
      requiredKeyLength: String(HASHED_KEY_LENGTH),
    });
  }

  const digest = createHash('sha256')
    .update(`${input.environment}|${input.provider}|${input.operationId}`, 'utf8')
    .digest();

  return Object.freeze({
    key: `fl:v1:${base32LowerUnpadded(new Uint8Array(digest))}`,
    form: 'HASHED_V1',
    inputs,
  });
}

/** Exposed for the golden test: the exact bytes that are hashed for the hashed form. */
export function providerKeyHashInput(inputs: ProviderKeyInputs): string {
  return `${inputs.environment}|${inputs.provider}|${inputs.operationId}`;
}
