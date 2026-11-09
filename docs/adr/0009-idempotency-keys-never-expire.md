# ADR-0009: API idempotency keys never expire; replay bodies expire at 90 days

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

Most payment APIs expire idempotency keys. Stripe retains them for 24 hours; after that the same key is treated as a new request. Expiry bounds storage and keeps the replay path simple.

For a money-moving command, expiry has a specific consequence: a client that retries an old request — a queued job that drained late, a replayed webhook, a restored backup of a client's outbox — creates a second financial effect under a key it believes is protected.

## Decision

Separate the uniqueness record from the replay record.

The uniqueness tombstone — merchant, command type, key, canonical request hash, result resource identity, original status, correlation ID, commit time — is retained for the lifetime of the merchant's financial records. A key is never reusable inside its scope.

The replayable response body and safe headers are retained 90 days from original commit, then removed in a one-way transition that sets `tombstoned_at`. Reuse after that returns `409 IDEMPOTENCY_KEY_EXPIRED` with a safe `resourceLocation` when the original resource still exists, and never executes the command again.

## Consequences

- Duplicate-command prevention is unbounded in time. A year-late retry cannot double-charge.
- Storage grows with accepted command count, but the per-row cost after 90 days is a fixed-size tombstone, not a response body. This is the cheap half of the record.
- A client that lost its response more than 90 days ago cannot recover the original representation. It receives an explicit expired-replay error plus a pointer to the resource, which is enough to reconcile and is strictly better than silently re-executing.
- The error taxonomy needs a distinct code, because "replay unavailable" and "key conflicts with different input" require different client behavior.
- Retention jobs must be proven unable to delete a tombstone. The retention test asserts that lifetime rows survive every cleanup pass.

## Rejected alternatives

- **24-hour expiry (Stripe behavior):** after the window a key becomes a new command. For `CAPTURE` or `REFUND` that is the exact failure the mechanism exists to prevent.
- **Retain full replay bodies forever:** unbounded storage growth for no additional financial safety, since the tombstone already blocks re-execution.
- **No tombstone, delete the row entirely:** equivalent to expiry.
- **Extend the replay window on each replay:** makes retention unpredictable and rewards clients that poll, without changing the safety property.
