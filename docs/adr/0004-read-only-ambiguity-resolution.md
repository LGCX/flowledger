# ADR-0004: Ambiguous outcomes resolve read-only

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

When a provider write may have been transmitted but its outcome is unknown, the cheapest recovery is to reissue the write with the same provider idempotency key and let the provider deduplicate. Several providers document this behavior, and the capability model already lets an adapter declare `writeIdempotency: SAME_KEY_REPLAY`.

The alternative is to treat the operation as unresolved and learn the truth through read-only lookup, verified webhooks, or operator investigation.

## Decision

`UNKNOWN` and `REQUIRES_REVIEW` have no transition back to provider execution. Once an attempt may have been transmitted, the only permitted provider activity for that operation is read-only lookup.

One narrow exception exists and it is not a retry of an ambiguous write: a normalized `RETRYABLE_NO_EFFECT` result carries typed `NoEffectProof` that the just-finished attempt caused no provider effect. Consuming it reschedules the same operation and the same key through `REQUESTED` with a bounded `not_before`. The operation was never ambiguous.

`SAME_KEY_REPLAY` remains declared and conformance-tested as an adapter property and a future guarded-recovery option. It is not invoked.

## Consequences

- A provider whose documented idempotency retention window has silently elapsed cannot be turned into a second charge by a retry. This is the failure mode the rule exists to prevent and it is invisible at the moment of retry.
- Resolution latency is bounded by lookup availability rather than by retry attempts. Some operations reach `REQUIRES_REVIEW` that a same-key replay would have cleared automatically. That is accepted: a visible unresolved case is a better outcome than an invisible duplicate.
- Provider eligibility for the MVP requires a lookup path capable of resolving ambiguous writes. A provider with same-key replay but no lookup is not eligible.
- The reconciliation worker needs no write credentials for the ambiguous path, which makes the blast radius of a reconciler defect read-only.
- Operators get a deliberately short list of permitted actions, none of which is "retry and hope."

## Rejected alternatives

- **Trust declared same-key replay:** retention windows are provider-*documented*, not provider-*guaranteed*. An expired window converts a retry into a second financial effect with no local signal.
- **Operator-triggered replay from `UNKNOWN`:** moves the guess from code to a human without supplying new evidence. The failure mode is identical.
- **Treat a timeout as failure after a fixed delay:** converts ambiguity into a false record. A payment the provider captured would show as uncaptured with no journal entry.
- **Automatically create a replacement operation with a fresh key:** this is a new financial action, not recovery, and it duplicates by construction.
