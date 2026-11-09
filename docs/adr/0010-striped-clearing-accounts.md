# ADR-0010: Shared platform accounts are striped into clearing buckets

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

Every confirmed capture posts:

```text
Debit   Processor receivable      gross
Credit  Merchant clearing         gross - fee
Credit  Platform fee revenue      fee
```

Processor receivable and platform fee revenue are platform-owned. Posting locks each affected balance row, re-reads it, validates the post-transaction balance, and updates it. Two rows are therefore on the write path of every capture and every refund in the deployment, independent of merchant or payment.

That makes those two rows the throughput ceiling for the entire ledger. A per-payment or per-merchant workload does not spread the contention, because the contention is not on the merchant side of the entry. The earlier contract noted this as something that "will be measured and, if necessary, split." It is not conditional: it is the guaranteed first bottleneck and the most load-bearing design decision in the ledger.

## Decision

Platform accounts on the capture/refund hot path are striped into `N` deterministic clearing buckets per logical account and currency. Each bucket is an ordinary ledger account with its own balance row, class, normal side, and negative-balance policy.

The bucket for a posting is chosen by a stable function of the payment ID:

```text
bucketIndex = crockford_ulid_entropy(paymentId) mod N
```

Selection is deterministic and derived inside the protected posting function, so a retry with the same posting key reaches the same bucket. The logical platform balance is the sum over buckets, exposed as a view. `N` is fixed per environment, recorded in the ledger seed, and immutable at runtime.

## Consequences

- Capture and refund posting throughput scales with `N` rather than being pinned to two rows. This is the project's primary measured result: the same workload is run at `N = 1` and at the configured `N`, and both numbers are published.
- Double entry is untouched. Each posting still balances within one transaction and one currency, and still touches at most one bucket per logical account, so canonical ascending-account-ID lock ordering is unchanged and deadlock-free.
- Balance rebuild and audit aggregate across buckets. The audit asserts that the sum of bucket balances equals the rebuild from immutable entries, per logical account.
- A single reported platform balance is a view over `N` rows, not a row. Operator queries and dashboards read the view.
- Changing `N` is a migration: it requires a documented, audited rebalancing posting that moves each bucket's balance into the new bucket set. It is not a configuration flip, because a changed modulus would send a retry of an existing posting key to a different bucket.
- Merchant-owned accounts are not striped. A merchant's clearing and payable rows are touched only by that merchant's own activity, and the hot-merchant workload measures whether that is sufficient.

## Rejected alternatives

- **One row per platform account:** the measured bottleneck, and leaving it in place would make the headline throughput target unreachable for reasons unrelated to the design being demonstrated.
- **Aggregate or deferred platform postings:** batching the platform side breaks the single-transaction linearization point and means a committed capture is briefly not balanced.
- **Per-merchant platform subaccounts:** merchant count is unbounded and traffic is skewed, so the hot-merchant workload serializes on one subaccount anyway. It also inflates the account table with rows that exist only for locking.
- **Advisory locks or a serialized posting queue:** produces the same serialization with less visibility and no accounting meaning.
- **`SERIALIZABLE` isolation without striping:** converts lock waits into serialization failures and retries. The contention is unchanged.
