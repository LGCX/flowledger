# ADR-0005: Synchronous balance projection inside the posting transaction

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

Immutable journal entries are authoritative for every balance. A current balance can be obtained three ways: derive it by aggregating entries on read, maintain a projection updated asynchronously, or maintain a projection updated inside the posting transaction.

The ledger also enforces post-transaction balance policies. An account with `allow_negative = false` must never end a transaction with a negative normal-side balance, and two concurrent debits that individually fit must not collectively overdraw it.

## Decision

`ledger.account_balances` is updated in the same PostgreSQL transaction that inserts the journal transaction and its entries. The projection is strongly consistent with the journal at every commit boundary, is fully rebuildable from entries, and is never the only record of a movement.

Protected balance checks lock the affected balance rows in ascending account-ID order, re-read while holding the locks, validate the post-transaction balance, then insert and update.

## Consequences

- A sufficient-funds decision reads one row under lock instead of aggregating an unbounded entry history, and the check cannot race.
- Posting throughput is bounded by balance-row contention. For accounts on the shared platform path this is the dominant limit, addressed by [ADR-0010](0010-striped-clearing-accounts.md).
- Rebuild-versus-projection equality becomes both a required property test and a live operational metric (`ledger_projection_mismatches`). A divergence is an incident with a defined runbook, not a stale cache.
- The projection carries a monotonic version so a reader can detect staleness in its own snapshot.
- Analytics and reporting may still use eventually consistent projections built from `ledger.transaction.posted.v1`. Authoritative checks stay on the primary.

## Rejected alternatives

- **Derive balances on read:** aggregation cost grows without bound as entries accumulate, and the protected-balance check becomes racy unless it locks every entry row it summed.
- **Asynchronous projection:** cannot gate a negative-balance decision, because the decision would read a balance that does not yet include committed movements.
- **Materialized view refreshed on a schedule:** same staleness problem with less control over locking.
- **No balance policy at all:** removes the only reason to lock balance rows and with it the most interesting concurrency property in the ledger.
