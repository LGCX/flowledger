/**
 * The money contract, exhaustively: every row of the P01-T01 table plus the two properties that
 * make the parser trustworthy.
 *
 * The malformed inputs are listed individually rather than as one regex assertion, because the
 * failure modes are different: `01` is a canonicalisation defect, `1.0` and `1e3` are the shapes a
 * JavaScript client produces by accident, `' 1'` and `'1 '` are the shapes a form produces, `١` is
 * a non-ASCII digit, and `1,000` is a display format. They must all be rejected for the same
 * declared reason.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  INT64_MAX,
  MAX_AMOUNT_MINOR,
  type MinorUnits,
  checkedAdd,
  checkedSub,
  minorUnits,
  parseAmountMinor,
  parseCurrency,
  parseMoney,
  parsePositiveAmountMinor,
  parsePositiveMoney,
  toAmountString,
} from './money.js';

function expectError(
  result: { ok: boolean } & Record<string, unknown>,
  code: string,
  reason: string,
): void {
  expect(result.ok, `expected a failure, got success`).toBe(false);
  const error = (result as { error?: DomainError }).error;
  expect(error).toBeInstanceOf(DomainError);
  expect(`${String(error?.code)}/${String(error?.reason)}`).toBe(`${code}/${reason}`);
}

describe('parseAmountMinor', () => {
  it.each([
    ['0', 0n],
    ['1', 1n],
    ['1000000000000', 1000000000000n],
  ])('accepts %s', (input, expected) => {
    const result = parseAmountMinor(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });

  it.each([
    ['1000000000001', 'AMOUNT_OUT_OF_RANGE'],
    // 14 characters: rejected on length before BigInt is asked to parse it.
    ['99999999999999', 'AMOUNT_OUT_OF_RANGE'],
    // 14 characters with leading zeros: the length bound wins over the canonical-form rule.
    ['00000000000000', 'AMOUNT_OUT_OF_RANGE'],
  ])('rejects %s as %s', (input, reason) => {
    expectError(parseAmountMinor(input), 'INVALID_AMOUNT', reason);
  });

  it.each([
    ['01', 'AMOUNT_MALFORMED'],
    ['+1', 'AMOUNT_MALFORMED'],
    ['-1', 'AMOUNT_MALFORMED'],
    ['1.0', 'AMOUNT_MALFORMED'],
    ['1e3', 'AMOUNT_MALFORMED'],
    [' 1', 'AMOUNT_MALFORMED'],
    ['1 ', 'AMOUNT_MALFORMED'],
    ['1,000', 'AMOUNT_MALFORMED'],
    ['', 'AMOUNT_MALFORMED'],
    ['١', 'AMOUNT_MALFORMED'],
  ])('rejects %j as malformed', (input, reason) => {
    expectError(parseAmountMinor(input), 'INVALID_AMOUNT', reason);
  });

  it.each([10000, null, {}, [], undefined, true])(
    'rejects non-string %j as AMOUNT_NOT_STRING',
    (input) => {
      expectError(parseAmountMinor(input), 'INVALID_AMOUNT', 'AMOUNT_NOT_STRING');
    },
  );

  it('rejects a JSON number so precision cannot be lost before parsing', () => {
    // 10000 as a number is representable, but 1000000000001 is not distinguishable from its
    // neighbours in a JSON parser, so the contract requires a string.
    expectError(parseAmountMinor(10000), 'INVALID_AMOUNT', 'AMOUNT_NOT_STRING');
  });
});

describe('parsePositiveAmountMinor', () => {
  it('accepts 1 and the maximum', () => {
    for (const input of ['1', '1000000000000']) {
      expect(parsePositiveAmountMinor(input).ok, input).toBe(true);
    }
  });

  it('rejects zero as AMOUNT_NOT_POSITIVE', () => {
    expectError(parsePositiveAmountMinor('0'), 'INVALID_AMOUNT', 'AMOUNT_NOT_POSITIVE');
  });

  it.each(['1000000000001', '99999999999999'])('rejects %s as out of range', (input) => {
    expectError(parsePositiveAmountMinor(input), 'INVALID_AMOUNT', 'AMOUNT_OUT_OF_RANGE');
  });

  it.each(['01', '1.0', ' 1', ''])('rejects %j as malformed', (input) => {
    expectError(parsePositiveAmountMinor(input), 'INVALID_AMOUNT', 'AMOUNT_MALFORMED');
  });

  it('rejects non-strings', () => {
    expectError(parsePositiveAmountMinor(1), 'INVALID_AMOUNT', 'AMOUNT_NOT_STRING');
  });
});

describe('parseCurrency', () => {
  it('accepts USD', () => {
    expect(parseCurrency('USD')).toEqual({ ok: true, value: 'USD' });
  });

  it.each(['EUR', 'usd', 'Usd', '', ' USD', null, 840])(
    'rejects %j as CURRENCY_UNSUPPORTED',
    (input) => {
      expectError(parseCurrency(input), 'INVALID_AMOUNT', 'CURRENCY_UNSUPPORTED');
    },
  );
});

describe('parseMoney', () => {
  it('parses amount and currency', () => {
    const result = parseMoney({ amountMinor: '1050', currency: 'USD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(1050n);
    expect(result.value.currency).toBe('USD');
  });

  it('rejects an extra key', () => {
    expectError(
      parseMoney({ amountMinor: '1050', currency: 'USD', note: 'x' }),
      'INVALID_REQUEST',
      'VALUE_MALFORMED',
    );
  });

  it('rejects a missing currency', () => {
    expectError(parseMoney({ amountMinor: '1050' }), 'INVALID_REQUEST', 'VALUE_MALFORMED');
  });

  it('rejects a missing amount', () => {
    expectError(parseMoney({ currency: 'USD' }), 'INVALID_REQUEST', 'VALUE_MALFORMED');
  });

  it.each([null, 'USD 10.50', [], 42])('rejects non-object %j', (input) => {
    expectError(parseMoney(input), 'INVALID_REQUEST', 'VALUE_MALFORMED');
  });

  it('propagates the amount failure rather than masking it', () => {
    expectError(
      parseMoney({ amountMinor: '1.0', currency: 'USD' }),
      'INVALID_AMOUNT',
      'AMOUNT_MALFORMED',
    );
  });

  it('propagates the currency failure', () => {
    expectError(
      parseMoney({ amountMinor: '1050', currency: 'EUR' }),
      'INVALID_AMOUNT',
      'CURRENCY_UNSUPPORTED',
    );
  });

  it('parsePositiveMoney rejects a zero amount', () => {
    expectError(
      parsePositiveMoney({ amountMinor: '0', currency: 'USD' }),
      'INVALID_AMOUNT',
      'AMOUNT_NOT_POSITIVE',
    );
  });
});

describe('minorUnits branding', () => {
  it('accepts zero and the int64 maximum', () => {
    expect(minorUnits(0n)).toBe(0n);
    expect(minorUnits(INT64_MAX)).toBe(INT64_MAX);
  });

  it('rejects a negative value as an internal defect', () => {
    expect(() => minorUnits(-1n)).toThrow(DomainError);
    expect(() => minorUnits(-1n)).toThrow(/INTERNAL_ERROR:AMOUNT_NEGATIVE/);
  });

  it('rejects above int64 as overflow', () => {
    expect(() => minorUnits(INT64_MAX + 1n)).toThrow(/INTERNAL_ERROR:AMOUNT_OVERFLOW/);
  });

  it('exposes the documented maximum', () => {
    expect(MAX_AMOUNT_MINOR).toBe(1000000000000n);
  });
});

describe('checked arithmetic', () => {
  it('adds within the default limit', () => {
    expect(checkedAdd(minorUnits(1n), minorUnits(2n))).toBe(3n);
  });

  it('rejects exceeding the default limit', () => {
    expect(() => checkedAdd(MAX_AMOUNT_MINOR, minorUnits(1n))).toThrow(
      /INTERNAL_ERROR:AMOUNT_OVERFLOW/,
    );
  });

  it('allows exceeding the single-amount ceiling when an explicit limit is given', () => {
    // Confirmed totals accumulate past one command's ceiling but must still fit the BIGINT column.
    expect(checkedAdd(MAX_AMOUNT_MINOR, minorUnits(1n), INT64_MAX)).toBe(1000000000001n);
  });

  it('rejects a sum beyond int64 even with the int64 limit', () => {
    expect(() => checkedAdd(minorUnits(INT64_MAX), minorUnits(1n), INT64_MAX)).toThrow(
      /INTERNAL_ERROR:AMOUNT_OVERFLOW/,
    );
  });

  it('subtracts to zero', () => {
    expect(checkedSub(minorUnits(5n), minorUnits(5n))).toBe(0n);
  });

  it('rejects a negative difference', () => {
    expect(() => checkedSub(minorUnits(1n), minorUnits(2n))).toThrow(
      /INTERNAL_ERROR:AMOUNT_NEGATIVE/,
    );
  });
});

describe('properties', () => {
  it('round-trips every amount in [0, MAX]', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1000000000000n }), (value) => {
        const amount = minorUnits(value) as MinorUnits;
        const wire = toAmountString(amount);
        const parsed = parseAmountMinor(wire);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.value).toBe(value);
      }),
    );
  });

  it('never parses an arbitrary string unless it is the canonical form of its value', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const parsed = parseAmountMinor(input);
        if (!parsed.ok) return;

        // Anything accepted must round-trip exactly: no leading zeros, no sign, no separators.
        expect(toAmountString(parsed.value)).toBe(input);
        expect(parsed.value).toBeLessThanOrEqual(MAX_AMOUNT_MINOR);
        expect(parsed.value).toBeGreaterThanOrEqual(0n);
      }),
    );
  });

  it('never accepts a string with a leading zero or a non-digit', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const parsed = parseAmountMinor(input);
        if (parsed.ok) {
          expect(/^(0|[1-9][0-9]*)$/.test(input)).toBe(true);
        }
      }),
    );
  });
});
