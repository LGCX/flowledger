# ADR-0008: Fee recognized at capture; refund reversal computed at confirmation

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

The platform fee is charged when a capture is confirmed and reversed proportionally as refunds confirm. The cumulative rule is:

```text
targetFeeReversed(R) = floor(F * R / G)
incrementalFeeReversal = targetFeeReversed(R1) - targetFeeReversed(R0)
```

The original contract snapshotted the exact `incrementalFeeReversal` onto the refund operation at command acceptance, before any provider call, and the ledger posting used that stored value.

[ADR-0003](0003-exclusive-operations-and-reserved-refunds.md) makes refunds concurrent. Two refunds accepted while neither has confirmed would both compute `R0` from the same confirmed total and would collectively over-reverse the fee. Snapshotting at acceptance is also stale if an earlier-accepted refund later fails: the later refund's stored allocation assumed a cumulative base that never materialized.

## Decision

Split what is snapshotted from what is computed.

The capture operation snapshots immutable fee inputs — policy identity and version, basis points, fixed amount, rounding mode, refund mode — plus the exact charged fee `F` and the capture gross `G`. These are frozen at capture acceptance and are never recomputed from current configuration.

A refund operation copies that snapshot. It does **not** store an incremental amount at acceptance. The incremental reversal is computed inside the transaction that confirms the refund, while the payment row is locked, using confirmed cumulative refunds only:

```text
R0 = confirmed refunded_amount_minor before this refund
R1 = R0 + this refund amount
incrementalFeeReversal = floor(F * R1 / G) - floor(F * R0 / G)
```

## Consequences

- A refund that is rejected or definitively fails consumes no fee allocation, because no allocation was ever assigned to it.
- The total reversed after a full cumulative refund is exactly `F`, independent of refund order, because `targetFeeReversed(G) = F`.
- An individual refund's allocation may differ by at most one minor unit depending on *confirmation* order when rounding residuals fall unevenly. The total does not vary. The fee property test asserts exactly this: order-independent total, order-dependent split bounded by one minor unit.
- `feeAmountMinor` on a refund operation is `null` until the operation resolves, and non-null thereafter. Capture operations still expose their snapshotted fee from acceptance onward.
- Reconciliation and webhook resolution paths compute the same value from the same locked state, so all three resolution sources agree without sharing a stored intermediate.
- Fee revenue is recognized when the receivable exists, not when value settles. Settlement moves already-recognized amounts; it does not create fee revenue. See [ADR-0012](0012-ledger-only-settlement.md).

## Rejected alternatives

- **Snapshot the incremental reversal at acceptance (original contract):** over-reverses under concurrent refunds and leaves a stale allocation when an earlier refund fails.
- **Reserve a fee allocation alongside the reserved refund amount:** doubles the reservation bookkeeping and its consistency triggers, for a value that is a pure function of confirmed totals and the capture snapshot.
- **Recompute from the currently active fee policy at refund time:** a policy edit would retroactively change the reversal for an existing capture.
- **Charge the fee at settlement rather than capture:** defers revenue recognition past the point where the receivable and the merchant obligation already exist, and makes a pre-settlement balance sheet wrong.
