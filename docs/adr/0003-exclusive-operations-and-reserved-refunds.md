# ADR-0003: Exclusive operation classes with reserved refund amounts

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

The original MVP rule permitted at most one unresolved operation per payment, regardless of type. That containment is simple and it does prevent conflicting provider writes, but it has two costs.

First, it makes the project's headline concurrency claim untestable. "Two refunds race for the last refundable amount and cannot over-refund" is satisfied by the one-active-operation unique index, which rejects the second command before the monetary guard runs. The guard `refunded + requested <= captured` is therefore unreachable under concurrency, and the test proves an index works rather than proving the money rule works.

Second, an unresolved refund blocks every later refund for as long as it stays `UNKNOWN`. A single ambiguous partial refund freezes the remaining refundable value indefinitely, which is a worse outcome than the race it prevents.

## Decision

Classify operation types by whether they may overlap.

- `AUTHORIZE`, `CAPTURE`, and `CANCEL` are **exclusive**. At most one unresolved exclusive operation may exist for a payment, and while one exists no other command of any type is accepted.
- `REFUND` is **concurrent**. Many unresolved refund operations may exist for one payment simultaneously.

Each unresolved refund reserves its amount. The payment aggregate carries `reserved_refund_amount_minor` and `unresolved_refund_count`. Refund acceptance locks the payment row and requires:

```text
refunded_amount_minor + reserved_refund_amount_minor + requested_amount <= captured_amount_minor
```

Resolution releases the reservation: success moves the amount from reserved to confirmed `refunded`, and rejection or definitive failure returns it to available. An `UNKNOWN` or `REQUIRES_REVIEW` refund keeps holding its reservation, because the provider may yet have applied it.

`payments.active_operation_id` is renamed `active_exclusive_operation_id` so the field name cannot imply that it accounts for unresolved refunds.

## Consequences

- Over-refund protection now lives in the monetary guard under the payment row lock, which is the mechanism the property test was always meant to exercise.
- A stuck `UNKNOWN` refund holds only its own reserved amount. Remaining refundable value stays available.
- Exclusivity between the other command types still falls out of the monetary guards — capture requires `captured = 0`, refund requires a succeeded capture — so the exclusive index and the guards agree rather than duplicating each other.
- Incremental fee reversal can no longer be snapshotted at refund acceptance. See [ADR-0008](0008-fee-recognized-at-capture.md).
- Cancellation stays blocked while an authorization is `UNKNOWN`. Cancelling requires the provider authorization reference that only a confirmed authorization produces, so cancelling a maybe-authorization would itself be a blind write against an object that may not exist. Ambiguity containment, not a concurrency limit, is the reason.
- The aggregate has two more mutable numeric fields, each of which must be proven consistent with the set of unresolved refund rows by a deferred constraint trigger.

## Rejected alternatives

- **Keep one active operation of any type:** simple, but it makes the concurrency claim vacuous and freezes refundable value behind one ambiguous operation.
- **Allow unlimited concurrent refunds with no reservation, checking only confirmed totals:** two refunds that individually fit can collectively over-refund. This is precisely the race the ledger contract already forbids for protected balances.
- **Reserve by inserting a hold row in a separate table:** another table and another lock for a value that is a sum over existing operation rows.
- **Allow concurrent captures:** the domain permits one capture. Concurrency adds no capability and makes the release-the-remainder rule ambiguous.
