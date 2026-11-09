# Money and ledger contract

Status: **Draft**  
Last updated: 2026-11-05

## Purpose

FlowLedger treats a journal transaction as the smallest atomic financial fact. A transaction contains two or more entries and becomes visible atomically. Once posted, neither the transaction nor its entries may be changed or deleted.

## Ledger boundary

The MVP uses one ledger per deployment environment and platform legal entity. Merchant-owned accounts are subaccounts within that ledger, allowing one transaction to affect both merchant and platform accounts while preserving double entry.

Every query and command MUST enforce merchant ownership. A merchant may not read another merchant's accounts or platform-only accounts merely because they share a ledger.

## Money representation

```ts
type Money = {
  currency: 'USD';
  amountMinor: string;
};
```

`{"currency":"USD","amountMinor":"1050"}` represents USD 10.50.

Rules:

- Monetary amounts MUST be integers in the currency's minor unit.
- JSON APIs and events MUST encode `amountMinor` as an unsigned decimal string.
- TypeScript MUST use `bigint` or a checked money type, never `number`, for arithmetic.
- PostgreSQL stores amounts as `BIGINT` with positive-value and range checks.
- Floating-point arithmetic and implicit rounding are forbidden.
- The MVP supports USD exponent 2 and rejects other currencies.
- Each payment and journal transaction uses exactly one currency.
- Each account belongs to exactly one currency.
- The maximum accepted single amount is `1000000000000` minor units (USD 10 billion) unless a stricter merchant limit applies.
- Fee calculations MUST specify a deterministic rounding rule before ledger posting. Any residual is posted to an explicit rounding account; it is never discarded.
- Every fee policy declares a `minimum_capture_amount_minor` that is at least its fixed fee component. A capture below that minimum is rejected at command acceptance as a configuration boundary, not as a state conflict. This makes `fee > gross` structurally unreachable rather than a runtime guard.

## Data model contract

### Ledger account

An account contains:

- `id`
- `ledger_id`
- `owner_type`: `PLATFORM` or `MERCHANT`
- `owner_id`
- `code`
- `account_class`: `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, or `EXPENSE`
- `normal_side`: `DEBIT` or `CREDIT`
- `currency`
- `status`: `OPEN` or `CLOSED`
- `allow_negative`
- `created_at`

`ledger_id`, owner, currency, class, and normal side MUST NOT change after the account's first posting. An account is closed rather than deleted.

Initial account types:

| Account | Owner | Class | Normal side | Negative policy | Striped |
| --- | --- | --- | --- | --- | --- |
| Processor receivable | Platform | Asset | Debit | Allowed | Yes |
| Platform fee revenue | Platform | Revenue | Credit | Allowed through explicit adjustments | Yes |
| Merchant clearing | Merchant | Liability | Credit | Allowed | No |
| Merchant payable | Merchant | Liability | Credit | Disallowed for ordinary commands | No |
| Rounding adjustment | Platform | Expense or revenue pair | Debit or credit | Allowed | No |

Merchant clearing holds value a provider has confirmed but that no settlement batch has closed over. Merchant payable holds value a closed settlement batch has recognized as owed. Clearing permits a negative balance because a refund may confirm after the capture it refunds has already settled; payable does not, because the platform must never recognize more as owed than it has settled.

### Striped platform accounts

The platform accounts on the capture/refund write path are striped into `N` deterministic clearing buckets per logical account and currency, as decided in [ADR-0010](adr/0010-striped-clearing-accounts.md). Without striping, two balance rows are locked by every capture and every refund in the deployment and become the ledger's throughput ceiling regardless of merchant or payment distribution.

Rules:

- Each bucket is an ordinary ledger account with its own `code`, balance row, class, normal side, and negative-balance policy. Nothing about double entry changes.
- The bucket index for a posting is derived inside the protected posting function from the subject payment ID:

```text
bucketIndex = ulid_entropy_bigint(paymentId) mod N
```

- Derivation is deterministic, so a retry under the same posting key reaches the same bucket and the posting remains idempotent.
- One posting touches at most one bucket per logical account, so canonical ascending-account-ID lock ordering is unchanged.
- The logical platform balance is the sum over its buckets, exposed as a view. No single row holds it.
- `N` is fixed per environment, recorded in the ledger seed, and immutable at runtime. Changing it requires a migration with an audited rebalancing posting, because a changed modulus would route a retry of an existing posting key to a different bucket.
- Balance rebuild and audit aggregate across buckets and assert that the bucket sum equals the rebuild from immutable entries, per logical account.
- Merchant-owned accounts are not striped. A merchant clearing or payable row is touched only by that merchant's activity; whether that is sufficient is measured by the hot-merchant workload.

### Journal transaction

A journal transaction contains:

- Internal transaction ID.
- `ledger_id`.
- Caller-supplied `posting_key`.
- Canonical financial payload hash.
- Operation type.
- Currency.
- Database-assigned `recorded_at`.
- Merchant and payment/operation references where applicable.
- Correlation and causation IDs.
- Optional `reversal_of_transaction_id`.
- Immutable, non-sensitive metadata.

`(ledger_id, posting_key)` MUST be unique.

The journal has no pending transaction status. Rows represent committed facts only. Provider and workflow state belongs in payment-domain tables.

### Ledger entry

An entry contains:

- Entry ID.
- Journal transaction ID.
- Entry ordinal.
- Account ID.
- `side`: `DEBIT` or `CREDIT`.
- Positive `amount_minor`.

`(transaction_id, ordinal)` MUST be unique. Direction is represented only by `side`; negative entry amounts are forbidden.

### Balance projection

The account balance table contains the current debit total, credit total, normal balance, and a monotonic projection version. It is updated within the journal-posting transaction and can be rebuilt entirely from entries.

## Posting invariants

A posting MUST satisfy all of these rules:

1. It contains at least two entries and at least two distinct accounts.
2. Every entry belongs to the transaction's ledger.
3. Every entry account has the transaction's currency.
4. Every amount is a positive whole number within the accepted range.
5. Total debits equal total credits.
6. Every account is open and eligible for the operation, except an audited reversal may use the privileged closed-account correction path.
7. A merchant-scoped posting touches accounts owned by exactly one merchant plus explicitly allowlisted platform accounts. It MUST NOT transfer value directly between two merchants.
8. Every protected account satisfies its post-transaction balance policy, evaluated using its normal-side balance.
9. The journal transaction, entries, balance updates, and exactly one `ledger.transaction.posted.v1` outbox record commit together. The enclosing payment transaction may add its own domain events.

Define raw signed value as:

```text
debit  = +amount_minor
credit = -amount_minor
```

For each journal transaction:

```text
sum(raw signed values) = 0
```

The posting is all-or-nothing. Its linearization point is the successful PostgreSQL commit—not command receipt, provider response receipt, message acknowledgement, or event publication.

No network request may execute inside a ledger transaction.

## Database enforcement

Application validation is not the final correctness boundary. The application role MUST NOT be able to insert arbitrary journal rows directly.

The implementation SHOULD expose a protected database posting function or equivalent restricted repository transaction that:

- Validates account ownership, currency, entry count, and debit/credit totals.
- Acquires affected balance locks in canonical order.
- Inserts the transaction and all entries.
- Applies protected balance rules.
- Updates balance projections.
- Inserts the outbox event.

Database permissions or triggers MUST reject update and deletion of committed journal transactions and entries.

## Idempotent posting

Each financial operation supplies a stable posting key:

```text
payment:{paymentId}:capture:{operationId}
payment:{paymentId}:refund:{operationId}
settlement:{settlementBatchId}
ledger:{transactionId}:reversal:{reversalRequestId}
```

The ledger computes a versioned SHA-256 hash over UTF-8 JSON Canonicalization Scheme bytes for fields that determine financial meaning:

- Operation type and currency.
- Canonical entries: combine duplicate account/side lines, sort by binary account ID then debit before credit, and assign contiguous ordinals; hash account ID, side, decimal-string amount, and ordinal.
- Business references that alter financial interpretation.

Trace IDs, timestamps, message-delivery attempts, and descriptive metadata do not affect the hash. Any metadata that can change accounting meaning is promoted to a named hashed field. Golden hash vectors are shared by TypeScript and PostgreSQL tests.

Behavior is fixed:

| Condition | Result |
| --- | --- |
| New posting key | Create the transaction |
| Existing key with identical financial hash | Return the original transaction |
| Existing key with different financial hash | Reject with an idempotency conflict |
| Concurrent identical postings | Exactly one transaction commits; callers observe the same result |
| Concurrent different postings with one key | At most one commits; the others receive conflicts |

The unique database constraint is authoritative. Inbox deduplication is defense in depth, not a substitute.

## Concurrency

When posting affects balance policy, the implementation MUST:

1. Determine every affected account.
2. Lock account balance rows in ascending account-ID order.
3. Re-read balances while locks are held.
4. Validate post-transaction balances.
5. Insert the posting and update balances.
6. Commit.

Two concurrent debits that individually fit but collectively make a protected account's normal-side balance negative MUST NOT both commit.

There is no global ledger lock or mandatory gapless global sequence. Unrelated accounts SHOULD post concurrently.

Shared platform accounts are striped into deterministic clearing buckets from the start rather than after a hotspot appears. Striping is not a contingency: with a single row per platform account, both platform entries of every capture and refund serialize on two rows across the whole deployment, which caps ledger throughput independently of merchant or payment distribution. The bucket count `N` is part of the ledger seed and the benchmark publishes results at `N = 1` and at the configured `N`.

Deadlock or serialization retries are safe because they reuse the same posting key.

## Balance semantics

The immutable entries are authoritative.

```text
raw balance = total debits - total credits

debit-normal balance  = total debits - total credits
credit-normal balance = total credits - total debits
```

Assets and expenses are normally debit-normal. Liabilities, equity, and revenue are normally credit-normal. Crediting a merchant liability increases the amount owed to that merchant.

The synchronous balance projection:

- MUST update in the same transaction as posting.
- MUST be rebuildable from entries.
- MUST never be the only record of a movement.
- MUST be periodically compared with reconstructed balances.
- MAY be supplemented by eventually consistent analytics projections.

Only committed postings affect balances. Pending provider operations do not.

Authorization holds remain in the payment domain for the MVP and create no journal entries. If financial reserve accounting is later required, held and available funds will use distinct accounts and balanced transfers.

## Capture-fee calculation

For a capture gross amount `G`, fee-policy basis points `B`, and fixed fee `K`, all expressed as nonnegative integers with `G` and `K` in minor units, the MVP calculates:

```text
percentageFee = floor((G * B + 5000) / 10000)
captureFee F  = percentageFee + K
```

Adding 5000 before integer division implements `HALF_UP` rounding of the percentage component at exactly one-half minor unit. The fixed component is already an integral minor-unit amount and is added after rounding. Calculations MUST use checked wide-integer arithmetic; floating point is forbidden.

### Minimum capture amount

A fee policy with a fixed component `K` cannot produce a valid fee for a capture smaller than `K`. Treating that as a runtime monetary conflict would make small captures permanently impossible while reporting a state error, so the boundary is declared in the policy instead.

- Every fee policy declares `minimum_capture_amount_minor`, validated at policy insertion to be at least `K` and at least 1.
- A capture command whose amount is below the policy minimum is rejected at acceptance with `422 CAPTURE_BELOW_MINIMUM`, naming the minimum. No operation, idempotency result, outbox row, or provider attempt is created.
- With that boundary enforced, `F <= G` holds for every accepted capture by construction. The posting function still asserts `0 <= F <= G` as a protected invariant; a violation there is an internal invariant breach, not a client error, and it never silently caps the fee.

The capture operation snapshots `B`, `K`, the capture rounding mode, the refund fee mode, the exact `F`, and the capture gross `G`. Reconciliation uses that immutable snapshot and never the current fee policy.

## Capture accounting

After a provider confirms capture, the platform records the gross receivable, net merchant obligation, and platform fee in one transaction.

For a USD 100.00 capture with a USD 3.00 platform fee, where `b` is the bucket index derived from the payment ID:

```text
Debit   Processor receivable [b]   10000
Credit  Merchant clearing           9700
Credit  Platform fee revenue [b]     300
```

The transaction is posted using the capture operation ID. No ledger transaction exists while the capture outcome is `PROCESSING` or `UNKNOWN`.

Capture credits merchant **clearing**, not payable. The merchant's obligation exists as soon as the capture is confirmed, but it is not recognized as settled until a settlement batch closes over it.

## Refund accounting

Refunds reverse the original capture fee proportionally.

The refund operation copies the capture's immutable fee snapshot at acceptance. It does **not** store an incremental fee amount at acceptance. Because refunds may be unresolved concurrently ([ADR-0003](adr/0003-exclusive-operations-and-reserved-refunds.md)), two refunds snapshotted against the same confirmed base would collectively over-reverse the fee, and a snapshot taken before an earlier refund failed would be stale.

The incremental reversal is therefore computed inside the transaction that **confirms** the refund, while the payment row is locked, from confirmed cumulative refunds only. For a capture with gross amount `G` and original fee `F`:

```text
R0 = confirmed refunded amount before this refund
R1 = R0 + this refund amount

targetFeeReversed(R) = floor(F * R / G)
incrementalFeeReversal = targetFeeReversed(R1) - targetFeeReversed(R0)
```

Properties this guarantees:

- A full cumulative refund reverses exactly `F`, because `targetFeeReversed(G) = F`.
- The total reversed is independent of the order in which refunds confirm.
- An individual refund's allocation may differ by at most one minor unit depending on confirmation order, when rounding residuals fall unevenly. The total does not vary.
- A refund that is rejected or definitively fails consumes no fee allocation, because none was ever assigned to it.

Calculations MUST use checked wide-integer arithmetic and the capture's immutable `F` and `G`; current fee configuration is irrelevant. See [ADR-0008](adr/0008-fee-recognized-at-capture.md).

For a USD 50.00 refund against the USD 100.00 capture above, with no prior confirmed refunds, the fee reversal is USD 1.50:

```text
Debit   Merchant clearing          4850
Debit   Platform fee revenue [b]    150
Credit  Processor receivable [b]   5000
```

The merchant debit is `refund amount - incremental fee reversal`. The platform fee-revenue debit is the incremental reversal, and processor receivable is credited for the gross provider refund. The three amounts MUST balance. The refund posts only after verified provider success, uses the immutable refund operation ID as its posting key, and uses the same bucket index `b` as its capture because both derive it from the same payment ID.

A refund debits merchant clearing even when the capture it refunds has already settled. Clearing may therefore hold a negative balance until the next settlement run nets it out.

## Settlement accounting

Settlement moves confirmed value from a merchant's clearing position to its payable position in one balanced batch transaction. It is entirely internal to the ledger: no value leaves the system, there is no bank integration or file format, and nothing here is a claim of payout or money-transmission capability. See [ADR-0012](adr/0012-ledger-only-settlement.md).

### Eligible movements

A **movement** is one confirmed capture or refund journal transaction belonging to one merchant and currency. A movement is eligible for settlement when it is not already a member of a posted settlement batch and its `recorded_at` is strictly before the run's cutoff time, which is database time read at the start of the run.

The cutoff exists so a long-running selection cannot race captures committed while it executes.

### Settlement run

A settlement run targets one `(merchant_id, currency)` pair. In one PostgreSQL transaction it MUST:

1. Acquire the run claim for that merchant and currency, so only one run may be in flight.
2. Read the cutoff time from the database clock.
3. Select every eligible movement as of the cutoff.
4. Compute the net:

```text
net = sum(merchant clearing credits) - sum(merchant clearing debits)
```

5. If `net > 0`, allocate the batch identity, insert the batch and its immutable membership rows, post the batch transaction, mark every selected movement settled, and insert `settlement.batch.posted.v1`.
6. If `net <= 0`, post nothing, fix no membership, mark nothing settled, and record a deferred run outcome. The movements remain eligible for a later run.

Selection, membership, posting, and the settled markers share one transaction. A crash before commit leaves no batch and no partial membership; the next run re-selects from scratch under a new batch identity. There is no partially constructed batch state to recover.

For a merchant whose eligible movements net to USD 97.00:

```text
Debit   Merchant clearing          9700
Credit  Merchant payable           9700
```

The posting key is `settlement:{settlementBatchId}`.

### Batch invariants

A posted settlement batch MUST satisfy all of these:

1. It has at least one member movement.
2. Every member belongs to the batch's merchant and currency and was eligible as of the batch cutoff.
3. The batch transaction amount equals the net of its members' merchant-clearing entries, computed from the immutable journal entries of those members — not from a cached total.
4. Membership is immutable after commit. A movement belongs to at most one batch, enforced by a unique constraint on the member movement.
5. The batch transaction debits merchant clearing and credits merchant payable for the same amount, in the batch currency, and balances like any other posting.
6. `net > 0`. A zero or negative net never posts.

### Negative and late movements

A refund confirmed after its capture has settled debits merchant clearing, which may drive clearing negative. This is correct: the platform over-recognized nothing, and the merchant owes value back.

That negative carries. The next run for that merchant nets it against new captures. While the net remains at or below zero, every run defers and posts nothing, so merchant payable never decreases and a closed batch is never mutated. Operators can observe a persistently negative clearing position as a distinct signal, and the MVP escalates it rather than attempting automatic recovery of value.

### What settlement does not do

- It does not create or reverse platform fee revenue. Fees are recognized at capture ([ADR-0008](adr/0008-fee-recognized-at-capture.md)); settlement moves already-recognized merchant obligation.
- It does not touch processor receivable.
- It does not call a provider, a bank, or any external system.
- It does not pay out. Merchant payable accumulates and is never drained in the MVP.

## Immutability

After commit:

- Journal transactions and entries MUST NOT be updated or deleted.
- Amount, side, account, currency, recorded time, business references, and metadata are immutable.
- Corrections are new balanced transactions.
- Investigation notes live in a separate append-only annotation table.
- Metadata MUST NOT contain payment credentials, secrets, raw provider payloads, or unnecessary personal data.

## Reversals and adjustments

A full reversal is a new transaction that:

- References the original transaction.
- Uses the same ledger, accounts, amounts, and currency.
- Swaps every debit and credit.
- Requires a reason, actor, and separate posting key.
- Uses current recorded time.

Only one full reversal may reference an original transaction. The original remains unchanged.

```text
original entries + reversal entries = zero net movement per account
```

A refund, fee correction, chargeback, or settlement difference is normally a compensating business transaction, not a journal reversal. Reversing an internal transaction does not reverse the provider action; the workflow layer coordinates external compensation first.

## Required property tests

### Accounting

- Every committed transaction contains at least two entries and two accounts.
- Every amount is positive and integral.
- Debits equal credits for every transaction.
- All entries share the transaction ledger and currency.
- Invalid direct database writes are rejected.

### Atomicity and idempotency

- Failure at each pre-commit injection point leaves no transaction, entry, balance update, or outbox event.
- A committed posting contains all entries and one ledger-posted outbox event; the enclosing workflow may atomically add other domain events.
- A lost response after commit may be retried without another financial effect.
- One hundred concurrent identical requests create one transaction.
- Reusing a posting key with a changed account, amount, side, or currency produces a conflict.

### Concurrency and balances

- Competing protected-balance debits cannot overspend the account.
- Unrelated accounts can post without a global lock.
- Rebuilding balances from entries exactly matches the synchronous projection.
- Normal-side calculations hold for all five account classes.
- The bucket index derived for a payment ID is stable across processes, retries, and reconciliation paths.
- Summing a logical platform account's buckets equals rebuilding that account from immutable entries, for every bucket count under test.
- Postings for payment IDs landing in different buckets commit concurrently; postings landing in the same bucket serialize without deadlocking, under every interleaving of capture and refund.

### Fee allocation under concurrent refunds

- For any capture and any legal set of refunds confirmed in any order, the sum of incremental reversals after a full cumulative refund equals the original fee exactly.
- Any single refund's allocation differs by at most one minor unit between two confirmation orderings of the same refund set.
- A rejected or definitively failed refund contributes no fee reversal and leaves the remaining allocation unchanged.
- No sequence of confirmed refunds reverses more than the captured fee at any intermediate point.

### Settlement

- A posted batch's transaction amount equals the net of its members' merchant-clearing entries, recomputed from immutable journal entries.
- A movement is a member of at most one posted batch.
- Concurrent settlement runs for one merchant produce at most one batch over a given movement set; the loser finds no eligible movements.
- A run whose net is zero or negative posts nothing, fixes no membership, and leaves every movement eligible.
- A refund confirmed after its capture settled drives clearing negative without mutating the closed batch or reducing merchant payable.
- Batch membership and amounts are immutable after commit.
- Rebuilding merchant clearing and payable from entries matches the projection after randomized capture/refund/settlement traffic.

### Immutability and reversal

- Direct updates and deletes fail.
- Original plus reversal nets to zero per account.
- Concurrent full-reversal requests create at most one reversal.
- Confirmed plus reserved refunds cannot exceed confirmed captured value.

Property-based tests SHOULD generate balanced postings, duplicates, retries, reversals, orderings, concurrent commands, and injected failures instead of relying solely on examples.

## MVP implementation decisions

- **Closed-account corrections:** Ordinary commands cannot post to closed accounts. A reversal involving one requires a privileged, audited domain command, an incident/reason reference, and approval by a second platform operator. It still uses the normal posting function and all balance checks.
- **Historical balances:** MVP history is recorded-time history. Backdated effective postings are not supported; a correction is recorded when committed and links to the fact it corrects.
- **Database boundary:** Journal posting is exposed through a protected PostgreSQL function executed by a restricted application role. That role has no direct `INSERT`, `UPDATE`, or `DELETE` privileges on journal transactions, entries, or balance rows. The function validates and posts the journal, updates balances, and inserts the ledger outbox event in the caller's transaction. See [ADR-0007](adr/0007-protected-database-functions-as-write-boundary.md).
- **Bucket count:** The initial platform striping factor is `N = 32` per logical account and currency, seeded per environment. The reference benchmark reports the same workload at `N = 1` and `N = 32` so the contention effect is measured rather than asserted. Tuning `N` is a migration with an audited rebalancing posting, never a runtime setting. See [ADR-0010](adr/0010-striped-clearing-accounts.md).
- **Settlement schedule:** Settlement runs on a fixed interval per `(merchant, currency)` and may also be triggered by an audited operator command. The MVP does not drain merchant payable; there is no payout step. See [ADR-0012](adr/0012-ledger-only-settlement.md).
- **Fee timing:** Platform fee revenue is recognized at capture confirmation. Refund fee reversal is computed inside the confirming transaction from confirmed cumulative refunds, not snapshotted at refund acceptance. See [ADR-0008](adr/0008-fee-recognized-at-capture.md).

## Ledger decisions

- [ADR-0005: Synchronous balance projection inside the posting transaction](adr/0005-synchronous-balance-projection.md)
- [ADR-0007: Protected database functions are the only write boundary](adr/0007-protected-database-functions-as-write-boundary.md)
- [ADR-0008: Fee recognized at capture; refund reversal computed at confirmation](adr/0008-fee-recognized-at-capture.md)
- [ADR-0010: Shared platform accounts are striped into clearing buckets](adr/0010-striped-clearing-accounts.md)
- [ADR-0012: Ledger-only settlement with immutable payout batches](adr/0012-ledger-only-settlement.md)
