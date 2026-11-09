# ADR-0006: `If-Match` participates in the canonical idempotency hash

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

`If-Match` is optional on provider-backed command endpoints. It carries a strong Payment ETag and gives a client a lost-update defense: the command is rejected with `412` if the payment advanced since the client read it.

Idempotency implementations commonly hash the request body and route only. Stripe, the closest reference implementation, ignores request headers when comparing a replayed idempotency key. Under that rule a retry that supplies a different `If-Match` — or drops it — replays the original stored result.

## Decision

When `If-Match` is supplied, its exact value is semantic request input and participates in the canonical request hash. Omission hashes an explicit null marker, so present-and-omitted are distinguishable rather than equivalent.

Exact idempotency replay is still resolved *before* the current payment version is compared, so a true byte-identical retry returns its stored `202` even after the payment has advanced. The precondition is not re-evaluated on replay.

## Consequences

- A retry that refreshes its ETag is a different semantic request and returns `409 IDEMPOTENCY_CONFLICT` rather than a replay. This diverges from Stripe and must be stated plainly in the API contract.
- In exchange, a client cannot silently convert a version-guarded command into an unguarded one by retrying. Dropping the header on retry is exactly the lost-update case `If-Match` exists to prevent; ignoring the header in the hash would let the retry succeed against a payment that moved.
- Clients must retry byte-identically, header included. This is the correct discipline for a money-moving retry and is cheap for any client that stores its request before sending it.
- The hash input list grows by one field and gains an explicit absence marker, which the canonicalization tests must cover in both forms.

## Rejected alternatives

- **Exclude `If-Match` from the hash (Stripe behavior):** a retry could drop the precondition and apply to a payment that has since advanced, which defeats the header's only purpose.
- **Reject `If-Match` entirely:** removes the lost-update defense and leaves clients with no way to assert the state they observed.
- **Make `If-Match` mandatory:** forces a read before every write and offers nothing beyond what the server-side guards and the active-operation rule already enforce.
- **Re-evaluate the precondition on replay:** a replay would then fail after the payment advanced, which breaks the central promise that an exact retry is safe.
