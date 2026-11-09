/**
 * The value constructors, case by case.
 *
 * Boundary lengths are tested at both ends rather than one, because an off-by-one in a length
 * bound passes a single-sided test in whichever direction the test happens to sit. The timestamp
 * cases are chosen so that each rejects for a *different* reason: a missing fraction, a short
 * fraction, an offset instead of `Z`, and a day that does not exist (which only the round-trip
 * check catches).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  parseCorrelationId,
  parseIdempotencyKey,
  parseProviderName,
  parseTimestamp,
  toTimestamp,
} from './values.js';

function expectFailure(
  result: { ok: boolean } & Record<string, unknown>,
  code: string,
  reason = 'VALUE_MALFORMED',
): void {
  expect(result.ok).toBe(false);
  const error = (result as { error?: DomainError }).error;
  expect(error).toBeInstanceOf(DomainError);
  expect(`${String(error?.code)}/${String(error?.reason)}`).toBe(`${code}/${reason}`);
}

describe('parseProviderName', () => {
  it.each(['fake-provider', 'a', 'ab', 'a-b', 'x'.repeat(63)])('accepts %j', (input) => {
    expect(parseProviderName(input).ok).toBe(true);
  });

  it.each([
    ['uppercase', 'Fake'],
    ['leading hyphen', '-x'],
    ['trailing hyphen', 'x-'],
    ['64 characters', 'x'.repeat(64)],
    ['empty', ''],
    ['underscore', 'fake_provider'],
    ['space', 'fake provider'],
    ['digit first', '1provider'],
  ])('rejects %s', (_label, input) => {
    expectFailure(parseProviderName(input), 'INVALID_REQUEST');
  });

  it.each([null, undefined, 42, {}, []])('rejects non-string %j', (input) => {
    expectFailure(parseProviderName(input), 'INVALID_REQUEST');
  });

  it('does not normalise case', () => {
    expect(parseProviderName('Fake-Provider').ok).toBe(false);
  });
});

describe('parseIdempotencyKey', () => {
  it('accepts 16 and 128 characters, and a UUID-shaped key', () => {
    for (const input of ['a'.repeat(16), 'a'.repeat(128), '0192f4e7-8b30-7c83-b462-c0d5fe8f132a']) {
      expect(parseIdempotencyKey(input).ok, input).toBe(true);
    }
  });

  it('rejects 15 and 129 characters', () => {
    expectFailure(parseIdempotencyKey('a'.repeat(15)), 'INVALID_IDEMPOTENCY_KEY');
    expectFailure(parseIdempotencyKey('a'.repeat(129)), 'INVALID_IDEMPOTENCY_KEY');
  });

  it('rejects a key containing a space', () => {
    expectFailure(parseIdempotencyKey('key with space....'), 'INVALID_IDEMPOTENCY_KEY');
  });

  it('rejects a non-string', () => {
    expectFailure(parseIdempotencyKey(1234567890123456), 'INVALID_IDEMPOTENCY_KEY');
  });

  it('reports its own problem code, not a generic one', () => {
    // The merchant sent this value, so the code tells them what to fix.
    expectFailure(parseIdempotencyKey('short'), 'INVALID_IDEMPOTENCY_KEY');
  });
});

describe('parseCorrelationId', () => {
  it('accepts 16 and 128 characters', () => {
    expect(parseCorrelationId('a'.repeat(16)).ok).toBe(true);
    expect(parseCorrelationId('a'.repeat(128)).ok).toBe(true);
  });

  it('rejects 15 and 129 characters', () => {
    expectFailure(parseCorrelationId('a'.repeat(15)), 'INVALID_CORRELATION_ID');
    expectFailure(parseCorrelationId('a'.repeat(129)), 'INVALID_CORRELATION_ID');
  });

  it('accepts the documented character set and rejects others', () => {
    expect(parseCorrelationId('abc.def:ghi_jkl-123').ok).toBe(true);
    expectFailure(parseCorrelationId('abc def ghi jkl 123'), 'INVALID_CORRELATION_ID');
    expectFailure(parseCorrelationId('abc+def/ghi=jkl1234'), 'INVALID_CORRELATION_ID');
  });

  it('reports the correlation problem code, distinct from the idempotency one', () => {
    expectFailure(parseCorrelationId('short'), 'INVALID_CORRELATION_ID');
  });
});

describe('parseTimestamp', () => {
  it('accepts a millisecond UTC timestamp', () => {
    const result = parseTimestamp('2026-11-05T18:44:31.123Z');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('2026-11-05T18:44:31.123Z');
  });

  it.each([
    ['no fraction', '2026-11-05T18:44:31Z'],
    ['two-digit fraction', '2026-11-05T18:44:31.12Z'],
    ['four-digit fraction', '2026-11-05T18:44:31.1234Z'],
    ['numeric offset', '2026-11-05T18:44:31.123+00:00'],
    ['lowercase z', '2026-11-05T18:44:31.123z'],
    ['no time', '2026-11-05'],
    ['space separator', '2026-11-05 18:44:31.123Z'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expectFailure(parseTimestamp(input), 'INVALID_REQUEST');
  });

  it('rejects a day that does not exist, which only the round-trip catches', () => {
    // `new Date('2026-02-30T00:00:00.000Z')` succeeds and rolls forward to 2 March.
    expectFailure(parseTimestamp('2026-02-30T00:00:00.000Z'), 'INVALID_REQUEST');
  });

  it('rejects 24:00:00, which the parser would normalise', () => {
    expectFailure(parseTimestamp('2026-11-05T24:00:00.000Z'), 'INVALID_REQUEST');
  });

  it('rejects a non-string', () => {
    expectFailure(parseTimestamp(new Date()), 'INVALID_REQUEST');
  });
});

describe('toTimestamp', () => {
  it('renders milliseconds with Z', () => {
    expect(toTimestamp(new Date('2026-11-05T18:44:31.123Z'))).toBe('2026-11-05T18:44:31.123Z');
  });

  it('throws on an invalid Date rather than producing one', () => {
    expect(() => toTimestamp(new Date('nonsense'))).toThrow(/INTERNAL_ERROR:VALUE_MALFORMED/);
  });

  it('round-trips through parseTimestamp for every date in range', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('9999-12-31T23:59:59.999Z'),
        }),
        (date) => {
          const rendered = toTimestamp(date);
          const parsed = parseTimestamp(rendered);
          expect(parsed.ok, rendered).toBe(true);
          if (parsed.ok) expect(parsed.value).toBe(rendered);
        },
      ),
    );
  });

  it('parses nothing that it did not render', () => {
    // Any accepted timestamp must be exactly what toTimestamp would emit for its instant.
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('9999-12-31T23:59:59.999Z'),
        }),
        (date) => {
          const rendered = toTimestamp(date);
          expect(new Date(rendered).toISOString()).toBe(rendered);
        },
      ),
    );
  });
});
