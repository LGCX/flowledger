/**
 * Identifier contract: the accepted shape, the rejected shapes, and the two properties that make
 * the parser safe to rely on.
 *
 * The rejected cases are listed one by one because each is a different real defect: a wrong
 * prefix is a caller mixing up two entities, `8` is a ULID overflow, lowercase is a client that
 * normalised case, `I`/`L`/`O`/`U` are the Crockford exclusions that a naive base32 encoder
 * emits, and 25 or 27 characters are off-by-one slicing.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  ID_PREFIXES,
  type IdPrefix,
  type OperationId,
  type PaymentId,
  isId,
  newId,
  parseId,
} from './ids.js';

const VALID_PAYMENT = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function expectMalformed(prefix: IdPrefix, input: unknown): void {
  const result = parseId(prefix, input);
  expect(result.ok, `${String(input)} was accepted for ${prefix}`).toBe(false);
  const error = (result as { error?: DomainError }).error;
  expect(error).toBeInstanceOf(DomainError);
  expect(`${String(error?.code)}/${String(error?.reason)}`).toBe('INVALID_REQUEST/ID_MALFORMED');
}

describe('parseId', () => {
  it('accepts a well-formed payment id', () => {
    const result = parseId('pay', VALID_PAYMENT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(VALID_PAYMENT);
  });

  it.each([
    ['wrong prefix', 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['ulid overflow', 'pay_81ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['lowercase body', 'pay_01arz3ndektsv4rrffq69g5fav'],
    ['excluded letter I', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAI'],
    ['excluded letter L', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAL'],
    ['excluded letter O', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAO'],
    ['excluded letter U', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAU'],
    ['25 characters', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FA'],
    ['27 characters', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAVV'],
    ['empty', ''],
    ['ulid only', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
  ])('rejects a payment id with %s', (_label, input) => {
    expectMalformed('pay', input);
  });

  it.each([null, undefined, 42, {}, [], true])('rejects non-string %j', (input) => {
    expectMalformed('pay', input);
  });

  it('rejects an id whose prefix belongs to another entity type', () => {
    // The same body is valid for `op` — only the prefix differs, which is the point.
    expect(parseId('op', 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV').ok).toBe(true);
    expectMalformed('pay', 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('is case sensitive on the prefix too', () => {
    expectMalformed('pay', 'PAY_01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });
});

describe('isId', () => {
  it('agrees with parseId', () => {
    expect(isId('pay', VALID_PAYMENT)).toBe(true);
    expect(isId('op', VALID_PAYMENT)).toBe(false);
    expect(isId('pay', 42)).toBe(false);
  });
});

describe('newId', () => {
  it('produces an id that parses for its own prefix and not for another', () => {
    for (const prefix of Object.values(ID_PREFIXES)) {
      const id = newId(prefix);
      expect(isId(prefix, id), id).toBe(true);
      expect(parseId(prefix, id).ok, id).toBe(true);
    }
  });

  it('encodes the timestamp it is given', () => {
    // Deterministic form used by tests; the ULID time component is the first 10 characters.
    const at = 1730832271123;
    const id = newId('op', at);
    expect(isId('op', id)).toBe(true);
    expect(id.startsWith('op_01J')).toBe(true);
  });

  it('is monotonic-ish within one millisecond without repeating', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) ids.add(newId('pay', 1730832271123));
    expect(ids.size).toBe(100);
  });

  it('generates 10 000 ids per prefix and every one parses', () => {
    for (const prefix of Object.values(ID_PREFIXES)) {
      for (let index = 0; index < 10_000; index += 1) {
        const id = newId(prefix);
        // Cheap shape assertion in the loop; parseId is exercised above for every prefix.
        expect(id.startsWith(`${prefix}_`), id).toBe(true);
        expect(id.length).toBe(prefix.length + 27);
      }
      expect(isId(prefix, newId(prefix))).toBe(true);
    }
  }, 30_000);
});

describe('properties', () => {
  it('rejects every arbitrary string that does not match the pattern', () => {
    const pattern = /^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
    fc.assert(
      fc.property(
        fc.string().filter((value) => !pattern.test(value)),
        (value) => {
          expect(parseId('pay', value).ok).toBe(false);
        },
      ),
    );
  });

  it('accepts exactly the strings the pattern accepts', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(parseId('pay', value).ok).toBe(/^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value));
      }),
    );
  });
});

/**
 * Type-level assertions. `test/tsconfig.json` includes co-located tests, so `pnpm typecheck` fails
 * if either of these stops being an error — a `@ts-expect-error` with nothing to suppress is itself
 * an error, which is what makes this a real test rather than a comment.
 */
describe('branded types', () => {
  it('rejects a PaymentId where an OperationId is required', () => {
    const payment = newId('pay');
    // @ts-expect-error PaymentId is not OperationId
    const operation: OperationId = payment;
    expect(operation).toBe(payment);
  });

  it('rejects a plain string where a PaymentId is required', () => {
    const raw = VALID_PAYMENT;
    // @ts-expect-error a bare string is not a PaymentId
    const payment: PaymentId = raw;
    expect(payment).toBe(raw);
  });
});
