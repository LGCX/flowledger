/**
 * The request hash, asserted from the golden file.
 *
 * The golden vectors are the contract: they were computed independently of this implementation
 * during planning, so reproducing all eight is evidence that the canonical encoding (A-03) is what
 * the plan intended rather than merely self-consistent. The semantic-sensitivity cases then prove
 * the hash is actually a function of every field docs/05 names — a hash that ignored `ifMatch`, for
 * instance, would still reproduce every vector that leaves it null.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type JsonValue, toHex } from './canonical-json.js';
import { DomainError } from './errors.js';
import {
  type CanonicalRequestInput,
  type CommandType,
  canonicalRequestJson,
  computeRequestHash,
} from './request-hash.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(here, '..', 'golden', 'request-hash.v1.json'), 'utf8'),
) as {
  vectors: {
    id: string;
    commandType: CommandType;
    pathParams: Record<string, string>;
    body: JsonValue;
    ifMatch: string | null;
    canonicalJson: string;
    sha256: string;
  }[];
};

const P = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ETAG = (version: number): string => `"payment-${P}-v${String(version)}"`;

function input(over: Partial<CanonicalRequestInput> = {}): CanonicalRequestInput {
  return {
    commandType: 'CAPTURE',
    pathParams: { paymentId: P },
    body: { amount: { amountMinor: '10000', currency: 'USD' } },
    ifMatch: ETAG(3),
    ...over,
  };
}

function hashOf(request: CanonicalRequestInput): string {
  const result = computeRequestHash(request);
  if (!result.ok) throw result.error;
  return toHex(result.value);
}

function expectRejected(request: CanonicalRequestInput): void {
  const result = computeRequestHash(request);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(DomainError);
  expect(`${result.error.code}/${result.error.reason}`).toBe('INVALID_REQUEST/VALUE_MALFORMED');
}

describe('golden request hashes', () => {
  it.each(GOLDEN.vectors.map((vector) => [vector.id, vector] as const))(
    'golden %s',
    (_id, vector) => {
      const request: CanonicalRequestInput = {
        commandType: vector.commandType,
        pathParams: vector.pathParams,
        body: vector.body,
        ifMatch: vector.ifMatch,
      };

      const canonical = canonicalRequestJson(request);
      expect(canonical.ok).toBe(true);
      if (!canonical.ok) return;
      expect(canonical.value).toBe(vector.canonicalJson);
      expect(hashOf(request)).toBe(vector.sha256);
    },
  );

  it('covers every vector the file declares', () => {
    expect(GOLDEN.vectors).toHaveLength(8);
  });
});

describe('semantic sensitivity', () => {
  it('changing the payment id alters the hash', () => {
    const other = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    expect(hashOf(input({ pathParams: { paymentId: other } }))).not.toBe(hashOf(input()));
  });

  it('changing the amount alters the hash', () => {
    expect(hashOf(input({ body: { amount: { amountMinor: '10001', currency: 'USD' } } }))).not.toBe(
      hashOf(input()),
    );
  });

  it('changing the currency alters the hash', () => {
    // Rejected by body validation upstream, but the hash must still distinguish it.
    expect(hashOf(input({ body: { amount: { amountMinor: '10000', currency: 'EUR' } } }))).not.toBe(
      hashOf(input()),
    );
  });

  it('changing the provider alters the hash', () => {
    const withProvider = (provider: string): CanonicalRequestInput =>
      input({
        commandType: 'CREATE_PAYMENT',
        pathParams: {},
        body: {
          amount: { amountMinor: '10000', currency: 'USD' },
          paymentMethodRef: 'pm_sandbox_123',
          provider,
        },
      });
    expect(hashOf(withProvider('other-provider'))).not.toBe(hashOf(withProvider('fake-provider')));
  });

  it('changing the payment-method reference alters the hash', () => {
    const withRef = (ref: string): CanonicalRequestInput =>
      input({
        commandType: 'CREATE_PAYMENT',
        pathParams: {},
        body: { amount: { amountMinor: '10000', currency: 'USD' }, paymentMethodRef: ref },
      });
    expect(hashOf(withRef('pm_sandbox_124'))).not.toBe(hashOf(withRef('pm_sandbox_123')));
  });

  it('adding, removing, or changing ifMatch alters the hash', () => {
    const absent = hashOf(input({ ifMatch: null }));
    const v1 = hashOf(input({ ifMatch: ETAG(1) }));
    const v2 = hashOf(input({ ifMatch: ETAG(2) }));

    expect(new Set([absent, v1, v2]).size).toBe(3);
  });

  it('changing the command type alters the hash', () => {
    expect(hashOf(input({ commandType: 'AUTHORIZE' }))).not.toBe(hashOf(input()));
  });

  it('insertion order of body keys does not alter the hash', () => {
    const forward: CanonicalRequestInput = input({
      commandType: 'CREATE_PAYMENT',
      pathParams: {},
      body: { amount: { amountMinor: '10000', currency: 'USD' }, provider: 'fake-provider' },
      ifMatch: null,
    });
    const backward: CanonicalRequestInput = input({
      commandType: 'CREATE_PAYMENT',
      pathParams: {},
      body: { provider: 'fake-provider', amount: { currency: 'USD', amountMinor: '10000' } },
      ifMatch: null,
    });

    expect(hashOf(backward)).toBe(hashOf(forward));
  });
});

describe('validation before hashing', () => {
  it('rejects path params that do not match the route template', () => {
    expectRejected(input({ commandType: 'CREATE_PAYMENT' })); // create takes no path params
    expectRejected(input({ pathParams: {} })); // capture requires paymentId
  });

  it('rejects an extra path param', () => {
    expectRejected(
      input({ pathParams: { paymentId: P, operationId: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX' } }),
    );
  });

  it('rejects a malformed payment id', () => {
    expectRejected(input({ pathParams: { paymentId: 'pay_81ARZ3NDEKTSV4RRFFQ69G5FAV' } }));
    expectRejected(input({ pathParams: { paymentId: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX' } }));
  });

  it.each([
    ['weak tag', `W/"payment-${P}-v1"`],
    ['tag list', `"payment-${P}-v1", "payment-${P}-v2"`],
    ['version zero', `"payment-${P}-v0"`],
    ['unquoted', `payment-${P}-v1`],
    ['wrong prefix', '"payment-op_01ARZ3NDEKTSV4RRFFQ69G5FAX-v1"'],
    ['empty', ''],
  ])('rejects an invalid ifMatch: %s', (_label, ifMatch) => {
    expectRejected(input({ ifMatch }));
  });

  it('reports a non-canonicalisable body as NON_CANONICAL_JSON', () => {
    // Not masked as VALUE_MALFORMED: the body shape was fine, the value cannot be hashed, and
    // whoever reads the log needs that distinction.
    for (const body of [{ n: 1.5 }, { n: 2 ** 53 }] as unknown as JsonValue[]) {
      const result = computeRequestHash(input({ body }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(`${result.error.code}/${result.error.reason}`).toBe(
        'INTERNAL_ERROR/NON_CANONICAL_JSON',
      );
    }
  });
});

describe('properties', () => {
  it('hash is a pure function of the input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000000000000 }), (amountMinor) => {
        const request = input({
          body: { amount: { amountMinor: String(amountMinor), currency: 'USD' } },
        });
        expect(hashOf(request)).toBe(hashOf(request));
      }),
    );
  });

  it('distinct amounts produce distinct hashes', () => {
    const seen = new Map<string, number>();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000000000000 }), (amountMinor) => {
        const digest = hashOf(
          input({ body: { amount: { amountMinor: String(amountMinor), currency: 'USD' } } }),
        );
        const previous = seen.get(digest);
        if (previous !== undefined) expect(previous).toBe(amountMinor);
        seen.set(digest, amountMinor);
      }),
      { numRuns: 1000 },
    );
  });
});
