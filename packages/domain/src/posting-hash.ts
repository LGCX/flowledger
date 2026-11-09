/**
 * Canonical ledger posting hash (docs/02 §Idempotent posting, docs/07 §`ledger.journal_entries`
 * normalization, ADR-0007).
 *
 * The normalization here is not a convenience: it is the contract the protected SQL routine must
 * reproduce byte-for-byte, because P03 recomputes this hash inside PL/pgSQL to reject a duplicate
 * posting. Three consequences drive the implementation:
 *
 *   - Duplicate `(account, side)` lines are combined, so a caller that splits `10000` into `4000`
 *     and `6000` produces the same hash. Without combination, two clients posting the same economic
 *     event in different shapes would both be accepted as new transactions.
 *   - Lines are sorted by account ID with plain string comparison, which equals PostgreSQL's
 *     `COLLATE "C"` byte order because every ID is ASCII. A locale-aware comparison would produce a
 *     different order in Node and in the database, and therefore a different hash for the same
 *     posting.
 *   - Ordinals come from the sorted position, never from the caller's order.
 *
 * DEBIT and CREDIT lines on the same account stay separate and are never netted — netting would
 * erase the two-sided structure the ledger invariant checks rely on.
 *
 * **[ASSUMPTION A-04]** docs/02 and docs/07 name the hashed fields but not their JSON keys; the
 * object built below is that encoding.
 */
import { canonicalJson, sha256 } from './canonical-json.js';
import { DomainError, type Result, err, ok } from './errors.js';
import {
  type LedgerAccountId,
  type LedgerId,
  type LedgerTransactionId,
  type MerchantId,
  type OperationId,
  type PaymentId,
  type SettlementBatchId,
  isId,
} from './ids.js';
import { MAX_AMOUNT_MINOR, type MinorUnits, minorUnits, toAmountString } from './money.js';

export const POSTING_HASH_VERSION = 1;

export const POSTING_OPERATION_TYPES = [
  'CAPTURE',
  'REFUND',
  'SETTLEMENT',
  'REVERSAL',
  'ADJUSTMENT',
] as const;

export type PostingOperationType = (typeof POSTING_OPERATION_TYPES)[number];

export type Side = 'DEBIT' | 'CREDIT';

export interface PostingLine {
  readonly accountId: LedgerAccountId;
  readonly side: Side;
  readonly amount: MinorUnits;
}

export interface CanonicalEntry extends PostingLine {
  readonly ordinal: number;
}

export interface PostingHashInput {
  readonly ledgerId: LedgerId;
  readonly merchantId: MerchantId;
  readonly operationType: PostingOperationType;
  readonly currency: 'USD';
  /** Positive integer chosen by the P03 recipe. */
  readonly recipeVersion: number;
  readonly paymentId: PaymentId | null;
  readonly paymentOperationId: OperationId | null;
  readonly reversalOfTransactionId: LedgerTransactionId | null;
  readonly settlementBatchId: SettlementBatchId | null;
  readonly lines: readonly PostingLine[];
}

function invalid(reason: 'ENTRIES_INVALID' | 'UNBALANCED_POSTING' | 'REFERENCES_INVALID') {
  return new DomainError('INTERNAL_ERROR', reason);
}

/**
 * Normalizes lines into the canonical entry list: combined per `(account, side)`, sorted by account
 * then DEBIT before CREDIT, with contiguous ordinals from 1.
 */
export function canonicalizeEntries(
  lines: readonly PostingLine[],
): Result<readonly CanonicalEntry[]> {
  if (lines.length === 0) return err<readonly CanonicalEntry[]>(invalid('ENTRIES_INVALID'));

  const combined = new Map<string, CanonicalEntry>();
  const order: string[] = [];

  for (const line of lines) {
    if (!isId('lac', line.accountId)) {
      return err<readonly CanonicalEntry[]>(invalid('ENTRIES_INVALID'));
    }
    if (line.side !== 'DEBIT' && line.side !== 'CREDIT') {
      return err<readonly CanonicalEntry[]>(invalid('ENTRIES_INVALID'));
    }
    if (line.amount < 1n || line.amount > MAX_AMOUNT_MINOR) {
      return err<readonly CanonicalEntry[]>(invalid('ENTRIES_INVALID'));
    }

    // DEBIT and CREDIT on one account are distinct keys: they are never netted.
    const key = `${line.accountId}/${line.side}`;
    const previous = combined.get(key);
    if (previous === undefined) {
      combined.set(key, { ...line, ordinal: 0 });
      order.push(key);
    } else {
      const sum = previous.amount + line.amount;
      if (sum > MAX_AMOUNT_MINOR) return err<readonly CanonicalEntry[]>(invalid('ENTRIES_INVALID'));
      combined.set(key, { ...previous, amount: minorUnits(sum) });
    }
  }

  const sorted = [...combined.values()].sort((left, right) => {
    // Plain comparison: every account ID is ASCII, so this is PostgreSQL `COLLATE "C"` order.
    if (left.accountId < right.accountId) return -1;
    if (left.accountId > right.accountId) return 1;
    // Same account: DEBIT before CREDIT.
    if (left.side === right.side) return 0;
    return left.side === 'DEBIT' ? -1 : 1;
  });

  return ok(sorted.map((entry, index) => ({ ...entry, ordinal: index + 1 })));
}

function referenceShapeIsValid(input: PostingHashInput): boolean {
  const { paymentId, paymentOperationId, reversalOfTransactionId, settlementBatchId } = input;

  switch (input.operationType) {
    case 'CAPTURE':
    case 'REFUND':
      return (
        paymentId !== null &&
        paymentOperationId !== null &&
        reversalOfTransactionId === null &&
        settlementBatchId === null
      );
    case 'SETTLEMENT':
      return (
        settlementBatchId !== null &&
        paymentId === null &&
        paymentOperationId === null &&
        reversalOfTransactionId === null
      );
    case 'REVERSAL':
      return (
        reversalOfTransactionId !== null &&
        paymentOperationId === null &&
        settlementBatchId === null
      );
    case 'ADJUSTMENT':
      return (
        paymentOperationId === null &&
        reversalOfTransactionId === null &&
        settlementBatchId === null
      );
    default:
      return false;
  }
}

export function computePostingHash(
  input: PostingHashInput,
): Result<{ hash: Uint8Array; canonicalJson: string; entries: readonly CanonicalEntry[] }> {
  const canonical = canonicalizeEntries(input.lines);
  if (!canonical.ok) return err(canonical.error);
  const entries = canonical.value;

  // At least two entries across at least two accounts: a one-account posting is not a transfer.
  if (entries.length < 2) return err(invalid('ENTRIES_INVALID'));
  if (new Set(entries.map((entry) => entry.accountId)).size < 2) {
    return err(invalid('ENTRIES_INVALID'));
  }

  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (entry.side === 'DEBIT') debits += entry.amount;
    else credits += entry.amount;
  }
  if (debits !== credits) return err(invalid('UNBALANCED_POSTING'));

  if (!Number.isSafeInteger(input.recipeVersion) || input.recipeVersion < 1) {
    return err(invalid('REFERENCES_INVALID'));
  }
  if (!referenceShapeIsValid(input)) return err(invalid('REFERENCES_INVALID'));

  const document = {
    currency: input.currency,
    entries: entries.map((entry) => ({
      accountId: entry.accountId,
      amountMinor: toAmountString(entry.amount),
      // A JSON integer, not a string: the ordinal is a position, not money.
      ordinal: entry.ordinal,
      side: entry.side,
    })),
    hashVersion: POSTING_HASH_VERSION,
    ledgerId: input.ledgerId,
    merchantId: input.merchantId,
    operationType: input.operationType,
    paymentId: input.paymentId,
    paymentOperationId: input.paymentOperationId,
    recipeVersion: input.recipeVersion,
    reversalOfTransactionId: input.reversalOfTransactionId,
    settlementBatchId: input.settlementBatchId,
  };

  const text = canonicalJson(document);
  return ok({ hash: sha256(text), canonicalJson: text, entries });
}
