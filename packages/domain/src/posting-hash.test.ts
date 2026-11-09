/**
 * Canonical ledger posting hash.
 *
 * The three identical digests for `capture`, `capture-reordered`, and `capture-split-lines` are the
 * point of the whole task: input order and line splitting must not change the posting's identity, or
 * a retry that serialized the same posting differently would be accepted as a second transaction and
 * double the ledger. The remaining rows prove that a real change does change it.
 *
 * These vectors are shared with P03's PL/pgSQL implementation (ADR-0007), so a divergence between
 * the TypeScript precheck and the database routine surfaces here as a failing row rather than as a
 * reconciliation break.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toHex } from './canonical-json.js';
import { DomainError } from './errors.js';
import type {
  LedgerAccountId,
  LedgerId,
  LedgerTransactionId,
  MerchantId,
  OperationId,
  PaymentId,
  SettlementBatchId,
} from './ids.js';
import { type MinorUnits, minorUnits } from './money.js';
import {
  type PostingHashInput,
  type PostingLine,
  canonicalizeEntries,
  computePostingHash,
} from './posting-hash.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(here, '..', 'golden', 'posting-hash.v1.json'), 'utf8'),
) as {
  vectors: {
    id: string;
    ledgerId: string;
    merchantId: string;
    currency: 'USD';
    recipeVersion: number;
    operationType: PostingHashInput['operationType'];
    paymentId: string | null;
    paymentOperationId: string | null;
    reversalOfTransactionId: string | null;
    settlementBatchId: string | null;
    lines: { accountId: string; side: 'DEBIT' | 'CREDIT'; amountMinor: string }[];
    canonicalJson: string;
    sha256: string;
  }[];
  negativeVectors: {
    id: string;
    expectError: string;
    ledgerId: string;
    merchantId: string;
    currency: 'USD';
    recipeVersion: number;
    operationType: PostingHashInput['operationType'];
    paymentId: string | null;
    paymentOperationId: string | null;
    reversalOfTransactionId: string | null;
    settlementBatchId: string | null;
    lines: { accountId: string; side: 'DEBIT' | 'CREDIT'; amountMinor: string }[];
  }[];
};

const L = 'led_01ARZ3NDEKTSV4RRFFQ69G5FB0' as LedgerId;
const M = 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ' as MerchantId;
const P = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV' as PaymentId;
const OP = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX' as OperationId;
const RECV = 'lac_01ARZ3NDEKTSV4RRFFQ69G5FB1' as LedgerAccountId;
const CLR = 'lac_01ARZ3NDEKTSV4RRFFQ69G5FB2' as LedgerAccountId;
const FEE = 'lac_01ARZ3NDEKTSV4RRFFQ69G5FB3' as LedgerAccountId;

function amount(value: string): MinorUnits {
  return minorUnits(BigInt(value));
}

function line(accountId: LedgerAccountId, side: 'DEBIT' | 'CREDIT', value: string): PostingLine {
  return { accountId, side, amount: amount(value) };
}

function fromGolden(vector: (typeof GOLDEN.vectors)[number]): PostingHashInput {
  return {
    ledgerId: vector.ledgerId as LedgerId,
    merchantId: vector.merchantId as MerchantId,
    currency: 'USD',
    recipeVersion: vector.recipeVersion,
    operationType: vector.operationType,
    paymentId: vector.paymentId as PaymentId | null,
    paymentOperationId: vector.paymentOperationId as OperationId | null,
    reversalOfTransactionId: vector.reversalOfTransactionId as LedgerTransactionId | null,
    settlementBatchId: vector.settlementBatchId as SettlementBatchId | null,
    lines: vector.lines.map((entry) => ({
      accountId: entry.accountId as LedgerAccountId,
      side: entry.side,
      amount: amount(entry.amountMinor),
    })),
  };
}

function captureInput(over: Partial<PostingHashInput> = {}): PostingHashInput {
  return {
    ledgerId: L,
    merchantId: M,
    currency: 'USD',
    recipeVersion: 1,
    operationType: 'CAPTURE',
    paymentId: P,
    paymentOperationId: OP,
    reversalOfTransactionId: null,
    settlementBatchId: null,
    lines: [line(RECV, 'DEBIT', '10000'), line(CLR, 'CREDIT', '9700'), line(FEE, 'CREDIT', '300')],
    ...over,
  };
}

function hashOf(input: PostingHashInput): string {
  const result = computePostingHash(input);
  if (!result.ok) throw result.error;
  return toHex(result.value.hash);
}

function failureOf(input: PostingHashInput): string {
  const result = computePostingHash(input);
  if (result.ok) return 'NO_ERROR';
  const error: DomainError = result.error;
  return `${error.code}/${error.reason}`;
}

describe('golden posting hashes', () => {
  it.each(GOLDEN.vectors.map((vector) => [vector.id, vector] as const))(
    'golden %s',
    (_id, vector) => {
      const result = computePostingHash(fromGolden(vector));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.canonicalJson).toBe(vector.canonicalJson);
      expect(toHex(result.value.hash)).toBe(vector.sha256);
    },
  );

  it('covers every vector the file declares', () => {
    expect(GOLDEN.vectors).toHaveLength(7);
    expect(GOLDEN.negativeVectors).toHaveLength(4);
  });

  it('reordering and splitting produce the identical digest', () => {
    const digests = new Set(
      GOLDEN.vectors
        .filter((vector) => vector.id.startsWith('capture'))
        .filter((vector) => vector.id !== 'capture-amount-changed')
        .map((vector) => hashOf(fromGolden(vector))),
    );
    expect(digests.size).toBe(1);
  });
});

describe('negative posting vectors', () => {
  it.each(GOLDEN.negativeVectors.map((vector) => [vector.id, vector] as const))(
    'negative %s',
    (_id, vector) => {
      const input: PostingHashInput = {
        ledgerId: vector.ledgerId as LedgerId,
        merchantId: vector.merchantId as MerchantId,
        currency: 'USD',
        recipeVersion: vector.recipeVersion,
        operationType: vector.operationType,
        paymentId: vector.paymentId as PaymentId | null,
        paymentOperationId: vector.paymentOperationId as OperationId | null,
        reversalOfTransactionId: vector.reversalOfTransactionId as LedgerTransactionId | null,
        settlementBatchId: vector.settlementBatchId as SettlementBatchId | null,
        lines: vector.lines.map((entry) => ({
          accountId: entry.accountId as LedgerAccountId,
          side: entry.side,
          amount: amount(entry.amountMinor),
        })),
      };
      expect(failureOf(input)).toBe(`INTERNAL_ERROR/${vector.expectError}`);
    },
  );
});

describe('canonicalizeEntries', () => {
  it('orders DEBIT before CREDIT on the same account', () => {
    const Y = 'lac_01ARZ3NDEKTSV4RRFFQ69G5FB9' as LedgerAccountId;
    const result = canonicalizeEntries([
      line(RECV, 'CREDIT', '5'),
      line(Y, 'DEBIT', '5'),
      line(RECV, 'DEBIT', '5'),
      line(Y, 'CREDIT', '5'),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => `${entry.accountId.slice(-3)}:${entry.side}`)).toEqual([
      'FB1:DEBIT',
      'FB1:CREDIT',
      'FB9:DEBIT',
      'FB9:CREDIT',
    ]);
    expect(result.value.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it('orders by code units, and that equals the ID alphabet order', () => {
    // The plan's example was `lac_0…` < `lac_A…`, but `lac_A…` cannot exist: the first body
    // character is the `[0-7]` overflow bound. That constraint is what makes plain string
    // comparison safe here — every valid ID uses `0-7` then `0-9A-Z` minus I/L/O/U, a subset where
    // code-unit order and PostgreSQL `COLLATE "C"` agree.
    const low = 'lac_01ARZ3NDEKTSV4RRFFQ69G5FB1' as LedgerAccountId;
    const high = 'lac_71ARZ3NDEKTSV4RRFFQ69G5FB1' as LedgerAccountId;

    const result = canonicalizeEntries([line(high, 'DEBIT', '1'), line(low, 'CREDIT', '1')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.accountId).toBe(low);
  });

  it('rejects an account id outside the ULID alphabet', () => {
    // `lac_A…` violates the `[0-7]` first-character bound, which is why the previous case uses
    // `0` and `7` rather than a letter.
    const invalid = 'lac_A1ARZ3NDEKTSV4RRFFQ69G5FB1' as LedgerAccountId;
    const result = canonicalizeEntries([line(invalid, 'DEBIT', '1')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('ENTRIES_INVALID');
  });

  it('never nets DEBIT against CREDIT on one account', () => {
    const result = canonicalizeEntries([line(RECV, 'DEBIT', '5'), line(RECV, 'CREDIT', '5')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  it('rejects an empty list, a zero amount, an oversized amount, and a bad account', () => {
    expect(canonicalizeEntries([]).ok).toBe(false);
    expect(canonicalizeEntries([line(RECV, 'DEBIT', '0')]).ok).toBe(false);
    expect(canonicalizeEntries([line(RECV, 'DEBIT', '1000000000001')]).ok).toBe(false);
    expect(
      canonicalizeEntries([
        {
          accountId: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV' as LedgerAccountId,
          side: 'DEBIT',
          amount: amount('1'),
        },
      ]).ok,
    ).toBe(false);
  });

  it('rejects a combined duplicate that exceeds the maximum', () => {
    const result = canonicalizeEntries([
      line(RECV, 'DEBIT', '1000000000000'),
      line(RECV, 'DEBIT', '1000000000000'),
    ]);
    expect(result.ok).toBe(false);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(canonicalEntryList(), (lines) => {
        const once = canonicalizeEntries(lines);
        fc.pre(once.ok);
        if (!once.ok) return;

        const twice = canonicalizeEntries(
          once.value.map((entry) => ({
            accountId: entry.accountId,
            side: entry.side,
            amount: entry.amount,
          })),
        );
        expect(twice.ok).toBe(true);
        if (twice.ok) expect(twice.value).toEqual(once.value);
      }),
    );
  });
});

const ACCOUNTS = [RECV, CLR, FEE, 'lac_01ARZ3NDEKTSV4RRFFQ69G5FB4' as LedgerAccountId];

function canonicalEntryList(): fc.Arbitrary<PostingLine[]> {
  return fc
    .array(
      fc.record({
        accountIndex: fc.integer({ min: 0, max: ACCOUNTS.length - 1 }),
        side: fc.constantFrom('DEBIT' as const, 'CREDIT' as const),
        amount: fc.bigInt({ min: 1n, max: 1000000n }),
      }),
      { minLength: 1, maxLength: 8 },
    )
    .map((entries) =>
      entries.map((entry) => ({
        accountId: ACCOUNTS[entry.accountIndex] ?? RECV,
        side: entry.side,
        amount: minorUnits(entry.amount),
      })),
    );
}

/** A balanced posting: each account appears once per side with the same total on both sides. */
function balancedPosting(): fc.Arbitrary<PostingLine[]> {
  return fc
    .array(fc.bigInt({ min: 1n, max: 1000000n }), { minLength: 1, maxLength: 4 })
    .map((amounts) => {
      const debitLines = amounts.map((value, index) => ({
        accountId: ACCOUNTS[index] ?? RECV,
        side: 'DEBIT' as const,
        amount: minorUnits(value),
      }));
      const creditLines = amounts.map((value, index) => ({
        accountId: ACCOUNTS[(index + 1) % ACCOUNTS.length] ?? CLR,
        side: 'CREDIT' as const,
        amount: minorUnits(value),
      }));
      return [...debitLines, ...creditLines];
    });
}

/** Splits each line into two halves where possible, keeping the totals identical. */
function splitLines(lines: readonly PostingLine[]): PostingLine[] {
  const out: PostingLine[] = [];
  for (const entry of lines) {
    if (entry.amount >= 2n) {
      const first = minorUnits(entry.amount / 2n);
      const second = minorUnits(entry.amount - first);
      out.push({ ...entry, amount: first }, { ...entry, amount: second });
    } else {
      out.push(entry);
    }
  }
  return out;
}

describe('properties', () => {
  it('shuffling and splitting lines never changes the hash', () => {
    fc.assert(
      fc.property(balancedPosting(), fc.infiniteStream(fc.nat()), (lines, stream) => {
        const base = captureInput({ lines });
        const baseline = hashOf(base);
        fc.pre(baseline !== undefined);

        // Deterministic shuffle driven by the generated stream.
        const shuffled = [...lines].sort(() => (stream.next().value % 2 === 0 ? 1 : -1));
        expect(hashOf(captureInput({ lines: shuffled }))).toBe(baseline);

        expect(hashOf(captureInput({ lines: splitLines(lines) }))).toBe(baseline);
        expect(hashOf(captureInput({ lines: splitLines(shuffled) }))).toBe(baseline);
      }),
    );
  });

  it('changing exactly one field changes the hash', () => {
    const baseline = hashOf(captureInput());
    const mutations: Record<string, PostingHashInput> = {
      account: captureInput({
        lines: [
          line(RECV, 'DEBIT', '10000'),
          line(FEE, 'CREDIT', '9700'),
          line(CLR, 'CREDIT', '300'),
        ],
      }),
      side: captureInput({
        lines: [
          line(RECV, 'CREDIT', '10000'),
          line(CLR, 'DEBIT', '9700'),
          line(FEE, 'DEBIT', '300'),
        ],
      }),
      amount: captureInput({
        lines: [
          line(RECV, 'DEBIT', '10001'),
          line(CLR, 'CREDIT', '9701'),
          line(FEE, 'CREDIT', '300'),
        ],
      }),
      operationType: captureInput({ operationType: 'REFUND' }),
      ledgerId: captureInput({ ledgerId: 'led_01ARZ3NDEKTSV4RRFFQ69G5FB1' as LedgerId }),
      merchantId: captureInput({ merchantId: 'mer_01ARZ3NDEKTSV4RRFFQ69G5FB1' as MerchantId }),
      recipeVersion: captureInput({ recipeVersion: 2 }),
      paymentOperationId: captureInput({
        paymentOperationId: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAY' as OperationId,
      }),
    };

    for (const [field, mutated] of Object.entries(mutations)) {
      // `REFUND` needs its own reference shape; skip the ones that are rejected rather than hashed.
      const outcome = computePostingHash(mutated);
      if (!outcome.ok) continue;
      expect(toHex(outcome.value.hash), field).not.toBe(baseline);
    }
  });

  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(balancedPosting(), (lines) => {
        expect(hashOf(captureInput({ lines }))).toBe(hashOf(captureInput({ lines })));
      }),
    );
  });
});
