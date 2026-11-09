/**
 * The only money type in the system (docs/02 §Money representation, docs/07 §Common types).
 *
 * Amounts are `bigint` minor units behind a brand, so a raw `bigint` cannot be passed where money
 * is expected and a `number` cannot appear at all: floating point and implicit rounding are
 * forbidden, and the ESLint money rule (P00-T02) fails this file if `number`, `Number`,
 * `parseInt`, `parseFloat`, `Math`, or a decimal literal appears in it.
 *
 * Parsing is strict and ordered for a reason:
 *
 *   1. A non-string is `AMOUNT_NOT_STRING`. A JSON number has already lost precision by the time
 *      it is parsed, so it is refused rather than coerced.
 *   2. More than 13 characters is `AMOUNT_OUT_OF_RANGE` *before* `BigInt` runs, so an
 *      arbitrarily long input cannot make the parser do unbounded work.
 *   3. Anything not matching `0` or a non-zero-leading decimal is `AMOUNT_MALFORMED`, which is
 *      what rejects `01`, `+1`, `1.0`, `1e3`, whitespace, and non-ASCII digits.
 *   4. Above the documented maximum is `AMOUNT_OUT_OF_RANGE`.
 *
 * The maximum is the documented single-amount ceiling (USD 10 billion in minor units), not
 * `Number.MAX_SAFE_INTEGER` and not `INT64_MAX`: `INT64_MAX` is exposed separately because the
 * database column is `BIGINT` and overflow checks against the column matter independently.
 */
import { DomainError, type Result, err, ok } from './errors.js';

export type MinorUnits = bigint & { readonly __brand: 'MinorUnits' };

export type Currency = 'USD';

/** USD 10 billion in minor units — docs/02 §Money representation. */
export const MAX_AMOUNT_MINOR: MinorUnits = 1000000000000n as MinorUnits;

/** The `BIGINT` column ceiling; a sum may exceed `MAX_AMOUNT_MINOR` but never this. */
export const INT64_MAX: bigint = 9223372036854775807n;

/** `MAX_AMOUNT_MINOR` has 13 digits, so anything longer is out of range whatever its digits. */
const MAX_AMOUNT_DIGITS = 13;

/**
 * `0` or a non-zero-leading decimal — docs/02 "unsigned decimal string". Rejects leading zeros,
 * signs, decimal points, exponents, separators, whitespace, and non-ASCII digits.
 */
const CANONICAL_AMOUNT = /^(0|[1-9][0-9]*)$/;

/**
 * Brands a `bigint` as money, rejecting values the database or the contract cannot hold.
 *
 * Throws rather than returning a `Result`: a caller holding a `bigint` that may be negative or
 * beyond `INT64_MAX` has an internal defect, not a merchant input to reject.
 */
export function minorUnits(value: bigint): MinorUnits {
  if (value < 0n) {
    throw new DomainError('INTERNAL_ERROR', 'AMOUNT_NEGATIVE', {
      constraint: 'minorUnits >= 0',
    });
  }
  if (value > INT64_MAX) {
    throw new DomainError('INTERNAL_ERROR', 'AMOUNT_OVERFLOW', {
      constraint: 'minorUnits <= INT64_MAX',
    });
  }
  return value as MinorUnits;
}

function malformed(reason: 'AMOUNT_NOT_STRING' | 'AMOUNT_MALFORMED' | 'AMOUNT_OUT_OF_RANGE') {
  return err<MinorUnits>(new DomainError('INVALID_AMOUNT', reason));
}

/** Parses a wire amount in `0..MAX_AMOUNT_MINOR`. */
export function parseAmountMinor(input: unknown): Result<MinorUnits> {
  if (typeof input !== 'string') return malformed('AMOUNT_NOT_STRING');
  if (input.length > MAX_AMOUNT_DIGITS) return malformed('AMOUNT_OUT_OF_RANGE');
  if (!CANONICAL_AMOUNT.test(input)) return malformed('AMOUNT_MALFORMED');

  const value = BigInt(input);
  if (value > MAX_AMOUNT_MINOR) return malformed('AMOUNT_OUT_OF_RANGE');

  return ok(minorUnits(value));
}

/** Parses a wire amount in `1..MAX_AMOUNT_MINOR` — every command amount is positive. */
export function parsePositiveAmountMinor(input: unknown): Result<MinorUnits> {
  const parsed = parseAmountMinor(input);
  if (!parsed.ok) {
    return err<MinorUnits>(
      new DomainError(parsed.error.code, parsed.error.reason, parsed.error.detail),
    );
  }
  if (parsed.value === 0n) {
    return err<MinorUnits>(new DomainError('INVALID_AMOUNT', 'AMOUNT_NOT_POSITIVE'));
  }
  return parsed;
}

/**
 * Currency is `USD` only (docs/02, docs/07 `CHECK (currency = 'USD')`). A currency error is
 * reported as `INVALID_AMOUNT` because docs/05 maps currency problems to that problem code.
 */
export function parseCurrency(input: unknown): Result<Currency> {
  if (input === 'USD') return ok('USD');
  return err<Currency>(new DomainError('INVALID_AMOUNT', 'CURRENCY_UNSUPPORTED'));
}

export interface Money {
  readonly amount: MinorUnits;
  readonly currency: Currency;
}

/**
 * Parses `{ amountMinor, currency }` with no other keys. Any shape deviation — missing key,
 * extra key, non-object — is `VALUE_MALFORMED`, so a caller learns the object is wrong rather
 * than receiving an amount error about a field it never meant to send.
 */
function parseMoneyShape(
  input: unknown,
  parseAmount: (value: unknown) => Result<MinorUnits>,
): Result<Money> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err<Money>(new DomainError('INVALID_REQUEST', 'VALUE_MALFORMED'));
  }

  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('amountMinor') || !keys.includes('currency')) {
    return err<Money>(new DomainError('INVALID_REQUEST', 'VALUE_MALFORMED'));
  }

  const record = input as Record<string, unknown>;
  const amount = parseAmount(record.amountMinor);
  if (!amount.ok) return err<Money>(amount.error);

  const currency = parseCurrency(record.currency);
  if (!currency.ok) return err<Money>(currency.error);

  return ok({ amount: amount.value, currency: currency.value });
}

export function parseMoney(input: unknown): Result<Money> {
  return parseMoneyShape(input, parseAmountMinor);
}

export function parsePositiveMoney(input: unknown): Result<Money> {
  return parseMoneyShape(input, parsePositiveAmountMinor);
}

/** The wire form: an unsigned decimal string with no separators. */
export function toAmountString(amount: MinorUnits): string {
  return amount.toString();
}

/**
 * Overflow-checked addition. The default limit is the documented single-amount maximum; callers
 * accumulating confirmed totals pass `INT64_MAX` because a sum legitimately exceeds one command's
 * ceiling while still having to fit the `BIGINT` column.
 */
export function checkedAdd(
  a: MinorUnits,
  b: MinorUnits,
  limit: bigint = MAX_AMOUNT_MINOR,
): MinorUnits {
  const sum = a + b;
  if (sum > limit) {
    throw new DomainError('INTERNAL_ERROR', 'AMOUNT_OVERFLOW', { limit: limit.toString() });
  }
  return minorUnits(sum);
}

/** Subtraction that cannot produce a negative amount; a negative result is an internal defect. */
export function checkedSub(a: MinorUnits, b: MinorUnits): MinorUnits {
  const difference = a - b;
  if (difference < 0n) {
    throw new DomainError('INTERNAL_ERROR', 'AMOUNT_NEGATIVE', {
      constraint: 'a >= b',
    });
  }
  return minorUnits(difference);
}
