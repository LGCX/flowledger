# ADR-0002: PostgreSQL as the authoritative store

Status: **Accepted for MVP**  
Date: 2026-11-05

## Context

Payment transitions, idempotency decisions, ledger postings, balance-policy checks, and outgoing messages must share reliable atomic boundaries. The project also needs explicit concurrency controls and inspectable performance characteristics.

## Decision

Use PostgreSQL as the authoritative store for payment aggregates, operations, provider attempts, the immutable journal, synchronous account balances, API idempotency, inbox records, and outbox records.

Use database transactions, row locks or compare-and-swap versions, unique constraints, protected ledger writes, and transactional outbox/inbox patterns. Pub/Sub transports committed work but is not a source of truth.

## Consequences

- Money-changing state and events can be committed atomically.
- Database constraints provide the final duplicate-prevention boundary.
- PostgreSQL contention and write-ahead logging will likely define initial throughput limits; these are useful and measurable constraints.
- Read replicas or asynchronous projections may serve analytics, but authoritative balance checks remain on the primary transactional path.
- Multi-region active-active writes and arbitrary horizontal sharding are deferred.

## Rejected alternatives

- **Pub/Sub as transaction record:** A message broker cannot enforce the required cross-record invariants.
- **Eventually consistent balance store:** Unsafe for authoritative sufficient-funds decisions.
- **Distributed transaction coordinator across services:** Adds substantial complexity and still cannot include external providers atomically.
- **Specialized ledger database initially:** Reduces the opportunity to demonstrate the underlying invariant and concurrency design and adds another dependency before requirements justify it.
