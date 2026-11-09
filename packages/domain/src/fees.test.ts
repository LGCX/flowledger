/**
 * Fee arithmetic, asserted from the golden files rather than from literals duplicated in this file.
 *
 * The golden files are the artefact: `refund-fee.v1.json` is reused by P07's PostgreSQL refund
 * confirmation, so a divergence between the TypeScript and the SQL implementation surfaces as a
 * failing golden row rather than as a fee discrepancy discovered in production.
 *
 * The properties carry the guarantees no table can enumerate: HALF_UP rounding, `F <= G` for every
 * accepted policy, non-negative increments, no over-reversal at any prefix, exact full reversal, and
 * an order-independent total whose per-refund allocation varies by at most one minor unit.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  type FeePolicyInputs,
  checkCaptureMinimum,
  checkFeePolicy,
  computeCaptureFee,
  computePercentageFee,
  incrementalFeeReversal,
  targetFeeReversed,
} from './fees.js';
import { MAX_AMOUNT_MINOR, type MinorUnits, minorUnits } from './money.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, '..', 'golden');

interface CaptureVector {
  id: string;
  gross: string;
  basisPoints: string;
  fixedAmount: string;
  percentageFee?: string;
  fee?: string;
  error?: string;
}

interface MinimumVector {
  id: string;
  gross: string;
  minimum: string;
  ok?: boolean;
  error?: string;
  detailMinimumAmountMinor?: string;
}

interface RefundVector {
  id: string;
  captureFee: string;
  captureGross: string;
  refunds: string[];
  increments: string[];
  thenRefund?: string;
  error?: string;
}

const captureGolden = JSON.parse(readFileSync(join(GOLDEN, 'capture-fee.v1.json'), 'utf8')) as {
  vectors: CaptureVector[];
  minimumCaptureVectors: MinimumVector[];
};

const refundGolden = JSON.parse(readFileSync(join(GOLDEN, 'refund-fee.v1.json'), 'utf8')) as {
  vectors: RefundVector[];
};

function amount(value: string): MinorUnits {
  return minorUnits(BigInt(value));
}

function caught(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return `${error.code}/${error.reason}`;
    return `OTHER/${(error as Error).message}`;
  }
  return 'NO_ERROR';
}

describe('capture fee golden vectors', () => {
  it.each(captureGolden.vectors.map((vector) => [vector.id, vector] as const))(
    'capture-fee golden %s',
    (_id, vector) => {
      const run = () =>
        computeCaptureFee(
          amount(vector.gross),
          BigInt(vector.basisPoints),
          amount(vector.fixedAmount),
        );

      if (vector.error !== undefined) {
        expect(caught(run)).toBe(`INTERNAL_ERROR/${vector.error}`);
        return;
      }

      const fee = run();
      expect(fee.toString()).toBe(vector.fee);
      expect(
        computePercentageFee(amount(vector.gross), BigInt(vector.basisPoints)).toString(),
      ).toBe(vector.percentageFee);
    },
  );

  it('covers every vector the file declares', () => {
    expect(captureGolden.vectors.length).toBe(14);
  });
});

describe('minimum capture golden vectors', () => {
  it.each(captureGolden.minimumCaptureVectors.map((vector) => [vector.id, vector] as const))(
    'minimum-capture golden %s',
    (_id, vector) => {
      const result = checkCaptureMinimum(amount(vector.gross), amount(vector.minimum));

      if (vector.ok === true) {
        expect(result.ok).toBe(true);
        return;
      }

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(`${result.error.code}/${result.error.reason}`).toBe(
        `CAPTURE_BELOW_MINIMUM/${String(vector.error)}`,
      );
      expect(result.error.detail?.minimumAmountMinor).toBe(vector.detailMinimumAmountMinor);
    },
  );
});

describe('refund fee golden vectors', () => {
  it.each(refundGolden.vectors.map((vector) => [vector.id, vector] as const))(
    'refund-fee golden %s',
    (_id, vector) => {
      let refunded = amount('0');
      const fee = amount(vector.captureFee);
      const gross = amount(vector.captureGross);

      vector.refunds.forEach((refund, index) => {
        const increment = incrementalFeeReversal({
          captureFee: fee,
          captureGross: gross,
          confirmedRefundedBefore: refunded,
          refundAmount: amount(refund),
        });
        expect(increment.toString(), `refund ${String(index)}`).toBe(vector.increments[index]);
        refunded = minorUnits(refunded + amount(refund));
      });

      if (vector.thenRefund !== undefined) {
        expect(
          caught(() =>
            incrementalFeeReversal({
              captureFee: fee,
              captureGross: gross,
              confirmedRefundedBefore: refunded,
              refundAmount: amount(vector.thenRefund ?? '0'),
            }),
          ),
        ).toBe(`INTERNAL_ERROR/${String(vector.error)}`);
      }
    },
  );

  it('covers every vector the file declares', () => {
    expect(refundGolden.vectors.length).toBe(10);
  });
});

describe('checkFeePolicy', () => {
  function policy(basisPoints: string, fixed: string, minimum: string): FeePolicyInputs {
    return {
      basisPoints: BigInt(basisPoints),
      fixedAmount: amount(fixed),
      minimumCaptureAmount: amount(minimum),
    };
  }

  it.each([
    // F(30) = 45 > 30 — rejected because the minimum is not high enough to cover the fixed fee.
    ['bp 5000 / fixed 30 / minimum 30 rejected', '5000', '30', '30'],
    // F(30) = 31 > 30 — the case the pre-D-07 rule wrongly accepted.
    ['bp 290 / fixed 30 / minimum 30 rejected', '290', '30', '30'],
    ['bp 10000 / fixed 1 / minimum 1000 rejected', '10000', '1', '1000'],
    ['minimum below fixed rejected', '290', '30', '29'],
    ['minimum zero rejected', '0', '0', '0'],
    ['basis points above 10000 rejected', '10001', '0', '1000'],
  ])('%s', (_label, basisPoints, fixed, minimum) => {
    const result = checkFeePolicy(policy(basisPoints, fixed, minimum));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(`${result.error.code}/${result.error.reason}`).toBe('INTERNAL_ERROR/FEE_POLICY_INVALID');
  });

  it.each([
    ['bp 290 / fixed 30 / minimum 31 accepted', '290', '30', '31'],
    ['bp 10000 / fixed 0 / minimum 1 accepted', '10000', '0', '1'],
    ['bp 0 / fixed 0 / minimum 1 accepted', '0', '0', '1'],
  ])('%s', (_label, basisPoints, fixed, minimum) => {
    expect(checkFeePolicy(policy(basisPoints, fixed, minimum)).ok).toBe(true);
  });

  it('the minimum-31 policy produces fee == gross exactly at the boundary', () => {
    // bp 290, fixed 30, minimum 31: F(31) = 1 + 30 = 31.
    expect(computeCaptureFee(amount('31'), 290n, amount('30')).toString()).toBe('31');
  });
});

describe('properties', () => {
  const grossArb = fc.bigInt({ min: 1n, max: MAX_AMOUNT_MINOR });
  const basisPointsArb = fc.bigInt({ min: 0n, max: 10000n });

  it('percentage component is HALF_UP', () => {
    fc.assert(
      fc.property(grossArb, basisPointsArb, (grossRaw, basisPoints) => {
        const gross = minorUnits(grossRaw);
        const percentage = computePercentageFee(gross, basisPoints);

        // The unique integer p with |G*B - p*10000| <= 5000, ties rounding up.
        const scaled = gross * basisPoints;
        const difference = scaled - percentage * 10000n;
        expect(difference <= 5000n).toBe(true);
        expect(difference >= -5000n).toBe(true);
        // On an exact tie the chosen p must be the larger one.
        if (difference === 5000n) {
          expect(percentage).toBe((scaled + 5000n) / 10000n);
        }
      }),
    );
  });

  it('an accepted policy never produces F > G for any gross at or above the minimum', () => {
    fc.assert(
      fc.property(
        basisPointsArb,
        fc.bigInt({ min: 1n, max: 1000000n }),
        fc.bigInt({ min: 0n, max: 1n }),
        (basisPoints, minimumRaw, pick) => {
          const minimum = minorUnits(minimumRaw);
          const result = checkFeePolicy({
            basisPoints,
            fixedAmount: minorUnits(0n),
            minimumCaptureAmount: minimum,
          });
          fc.pre(result.ok);

          const gross = pick === 0n ? minimum : minorUnits(minimumRaw + 1n);
          expect(caught(() => computeCaptureFee(gross, basisPoints, minorUnits(0n)))).not.toBe(
            'INTERNAL_ERROR/FEE_EXCEEDS_GROSS',
          );
        },
      ),
    );
  });

  it('FEE_EXCEEDS_GROSS is thrown exactly when F > G', () => {
    fc.assert(
      fc.property(
        grossArb,
        basisPointsArb,
        fc.bigInt({ min: 0n, max: 1000000n }),
        (grossRaw, basisPoints, fixedRaw) => {
          const gross = minorUnits(grossRaw);
          const fixedAmount = minorUnits(fixedRaw);
          if (fixedAmount > MAX_AMOUNT_MINOR) return;

          const expected =
            (gross * basisPoints + 5000n) / 10000n + fixedAmount > gross ? 'over' : 'ok';
          const outcome = caught(() => computeCaptureFee(gross, basisPoints, fixedAmount));

          if (expected === 'ok') {
            expect(['NO_ERROR', 'INTERNAL_ERROR/AMOUNT_OVERFLOW']).toContain(outcome);
          } else {
            expect([
              'INTERNAL_ERROR/FEE_EXCEEDS_GROSS',
              'INTERNAL_ERROR/AMOUNT_OVERFLOW',
            ]).toContain(outcome);
            if (outcome === 'INTERNAL_ERROR/FEE_EXCEEDS_GROSS') expect(expected).toBe('over');
          }
        },
      ),
    );
  });

  /** A partition of `gross` into `cuts.length + 1` positive parts. */
  function partition(gross: bigint, cuts: readonly bigint[]): bigint[] {
    const sorted = [...new Set(cuts.filter((cut) => cut > 0n && cut < gross))].sort((a, b) =>
      a < b ? -1 : 1,
    );
    const parts: bigint[] = [];
    let previous = 0n;
    for (const cut of sorted) {
      parts.push(cut - previous);
      previous = cut;
    }
    parts.push(gross - previous);
    return parts;
  }

  function reversals(fee: bigint, gross: bigint, parts: readonly bigint[]): bigint[] {
    let refunded = 0n;
    return parts.map((part) => {
      const increment = incrementalFeeReversal({
        captureFee: minorUnits(fee),
        captureGross: minorUnits(gross),
        confirmedRefundedBefore: minorUnits(refunded),
        refundAmount: minorUnits(part),
      });
      refunded += part;
      return increment;
    });
  }

  it('increments are never negative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100000n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.array(fc.bigInt({ min: 1n, max: 100000n }), { minLength: 0, maxLength: 20 }),
        (grossRaw, percentRaw, cuts) => {
          const gross = grossRaw;
          const fee = (gross * percentRaw) / 100n;
          for (const increment of reversals(fee, gross, partition(gross, cuts))) {
            expect(increment >= 0n).toBe(true);
          }
        },
      ),
    );
  });

  it('no over-reversal at any prefix, and the total is exact at full refund', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100000n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.array(fc.bigInt({ min: 1n, max: 100000n }), { minLength: 0, maxLength: 20 }),
        (grossRaw, percentRaw, cuts) => {
          const gross = grossRaw;
          const fee = (gross * percentRaw) / 100n;
          const parts = partition(gross, cuts);
          const increments = reversals(fee, gross, parts);

          let cumulative = 0n;
          increments.forEach((increment, index) => {
            cumulative += increment;
            const prefix = parts.slice(0, index + 1).reduce((sum, part) => sum + part, 0n);
            expect(cumulative <= fee || fee === 0n).toBe(true);
            expect(cumulative).toBe(
              targetFeeReversed(minorUnits(fee), minorUnits(prefix), minorUnits(gross)),
            );
          });

          // A full partition refunds everything, so the sum is exactly F.
          expect(cumulative).toBe(
            targetFeeReversed(minorUnits(fee), minorUnits(gross), minorUnits(gross)),
          );
        },
      ),
    );
  });

  it('order independence: totals agree and per-refund allocations differ by at most one', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100000n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.array(fc.bigInt({ min: 1n, max: 100000n }), { minLength: 1, maxLength: 8 }),
        (grossRaw, percentRaw, cuts) => {
          const gross = grossRaw;
          const fee = (gross * percentRaw) / 100n;
          const parts = partition(gross, cuts);
          const forward = reversals(fee, gross, parts);
          // Reverse the *order of the same refunds*, not the amounts.
          const backwardParts = [...parts].reverse();
          const backward = reversals(fee, gross, backwardParts);

          const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);
          expect(sum(forward)).toBe(sum(backward));

          // The same multiset of refunds, allocated in a different order.
          const forwardByAmount = new Map<bigint, bigint[]>();
          parts.forEach((part, index) => {
            const bucket = forwardByAmount.get(part) ?? [];
            bucket.push(forward[index] ?? 0n);
            forwardByAmount.set(part, bucket);
          });
          backwardParts.forEach((part, index) => {
            const bucket = forwardByAmount.get(part);
            if (bucket === undefined || bucket.length === 0) return;
            const other = bucket.shift() ?? 0n;
            const difference = backward[index] === undefined ? 0n : backward[index] - other;
            expect(difference <= 1n && difference >= -1n).toBe(true);
          });
        },
      ),
    );
  });

  it('rejected refunds contribute nothing', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100000n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.array(fc.bigInt({ min: 1n, max: 100000n }), { minLength: 2, maxLength: 10 }),
        fc.nat(),
        (grossRaw, percentRaw, cuts, dropIndex) => {
          const gross = grossRaw;
          const fee = (gross * percentRaw) / 100n;
          const parts = partition(gross, cuts);

          // Drop one refund (never passed to the function, as a rejected refund would not be).
          const dropped = dropIndex % parts.length;
          const confirmed = parts.filter((_, index) => index !== dropped);
          if (confirmed.length === 0) return;

          const confirmedSum = confirmed.reduce((sum, part) => sum + part, 0n);
          const increments = reversals(fee, gross, confirmed);
          const total = increments.reduce((sum, increment) => sum + increment, 0n);

          expect(total).toBe(
            targetFeeReversed(minorUnits(fee), minorUnits(confirmedSum), minorUnits(gross)),
          );
        },
      ),
    );
  });
});
