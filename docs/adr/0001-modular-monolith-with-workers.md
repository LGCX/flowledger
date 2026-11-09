# ADR-0001: Modular monolith with independently scalable workers

Status: **Accepted for MVP**  
Date: 2026-11-05

## Context

FlowLedger needs independent scaling and realistic asynchronous failure modes, but its payment, idempotency, and ledger invariants require closely coordinated transactions during the first implementation.

## Decision

Use one TypeScript repository and one PostgreSQL cluster with strict module ownership. Deploy the API, outbox relay, payment worker, reconciliation worker, webhook receiver, and merchant webhook dispatcher as separate processes.

Modules communicate across process boundaries using committed database state and Pub/Sub messages. Modules do not bypass each other's write interfaces even though they share a codebase.

## Consequences

- Capture/refund confirmation and ledger posting can commit atomically without distributed transactions.
- Processes can scale independently and experience genuine message redelivery and crash recovery.
- Local development and end-to-end testing remain tractable for one engineer.
- A shared database is a coupling point. Module-owned tables and explicit APIs are required to keep a later extraction possible.
- A service may be extracted only after measurements or organizational ownership justify the additional failure boundary.

## Rejected alternatives

- **Microservice per domain immediately:** Adds network and deployment failure modes before contracts are stable and makes atomic financial transitions harder.
- **Single synchronous web process:** Cannot demonstrate durable asynchronous execution, independent scaling, or realistic recovery.
- **Serverless function per handler:** Fragments ownership and observability without improving the initial correctness model.
