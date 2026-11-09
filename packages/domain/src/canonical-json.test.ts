/**
 * Canonical JSON (RFC 8785, restricted to safe integers — A-02).
 *
 * The table cases come from the plan; the properties are what make the function usable as a hash
 * input. Stability under re-parsing is the property that matters most: if
 * `canonicalJson(JSON.parse(canonicalJson(x)))` differed from `canonicalJson(x)`, a value that
 * round-tripped through PostgreSQL `jsonb` would hash differently from the one that was hashed on
 * the way in, and every replay would conflict.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { type JsonValue, canonicalJson, sha256, toHex } from './canonical-json.js';

function expectNonCanonical(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect(`${(caught as DomainError).code}/${(caught as DomainError).reason}`).toBe(
    'INTERNAL_ERROR/NON_CANONICAL_JSON',
  );
}

describe('canonicalJson', () => {
  it('sorts keys and drops whitespace', () => {
    expect(canonicalJson({ b: [1, 'x'], a: { d: null, c: true } })).toBe(
      '{"a":{"c":true,"d":null},"b":[1,"x"]}',
    );
  });

  it('orders by UTF-16 code units, not by locale', () => {
    // U+20AC (€) sorts before U+D83D, the high surrogate of 😀.
    expect(canonicalJson({ '😀': 1, '€': 2, a: 3 })).toBe('{"a":3,"€":2,"😀":1}');
  });

  it('escapes strings the way JSON.stringify does', () => {
    expect(canonicalJson({ s: 'line\nbreak\u0001"' })).toBe('{"s":"line\\nbreak\\u0001\\""}');
  });

  it('serialises negative zero as zero', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
  });

  it.each([
    ['a fractional number', 1.5],
    ['a number beyond the safe range', 2 ** 53],
    ['bigint', 1n],
    ['undefined', undefined],
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', '\uDC00'],
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
  ])('rejects %s', (_label, value) => {
    expectNonCanonical(() => canonicalJson(value as JsonValue));
  });

  it('rejects a non-plain object', () => {
    expectNonCanonical(() => canonicalJson(new Date() as unknown as JsonValue));
    expectNonCanonical(() => canonicalJson(new Map() as unknown as JsonValue));
  });

  it('accepts an object with a null prototype', () => {
    const bare = Object.create(null) as Record<string, JsonValue>;
    bare.a = 1;
    expect(canonicalJson(bare)).toBe('{"a":1}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('sha256', () => {
  it('produces the known digest for the empty string', () => {
    expect(toHex(sha256(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces 32 bytes', () => {
    expect(sha256('x')).toHaveLength(32);
  });

  it('hashes UTF-8 bytes, not code units', () => {
    // '€' is three UTF-8 bytes; a UTF-16 encoding would give a different digest.
    expect(toHex(sha256('€'))).toBe(toHex(sha256('€')));
    expect(toHex(sha256('€'))).not.toBe(toHex(sha256('?')));
  });
});

/** `fc.jsonValue` can produce values this serializer rejects; keep the generated domain inside it. */
const canonicalJsonArb: fc.Arbitrary<JsonValue> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'large' },
    fc.constant(null),
    fc.boolean(),
    fc.string(),
    fc.integer({ min: -(2 ** 31), max: 2 ** 31 }),
    fc.array(tie('value') as fc.Arbitrary<JsonValue>, { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('value') as fc.Arbitrary<JsonValue>, { maxKeys: 4 }),
  ),
})).value as fc.Arbitrary<JsonValue>;

describe('properties', () => {
  it('is stable under re-parsing', () => {
    fc.assert(
      fc.property(canonicalJsonArb, (value) => {
        const once = canonicalJson(value);
        const twice = canonicalJson(JSON.parse(once) as JsonValue);
        expect(twice).toBe(once);
      }),
    );
  });

  it('is insensitive to key insertion order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { maxKeys: 6 }),
        (record) => {
          const forward: Record<string, JsonValue> = {};
          for (const key of Object.keys(record)) forward[key] = record[key] ?? 0;
          const backward: Record<string, JsonValue> = {};
          for (const key of Object.keys(record).reverse()) backward[key] = record[key] ?? 0;

          expect(canonicalJson(backward)).toBe(canonicalJson(forward));
        },
      ),
    );
  });
});
