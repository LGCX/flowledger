# ADR-0007: Protected database functions are the only write boundary

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

Payment transitions, ledger postings, and outbox insertion all have invariants that must hold unconditionally: debits equal credits, one journal posting per operation, confirmed totals agree with operation cardinality, an event accompanies every version increment.

Those invariants can be enforced in application repositories, in database constraints and triggers, or behind `SECURITY DEFINER` functions that the application role is required to call.

## Decision

Runtime roles hold no direct `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` privilege on `payments.payments`, `payments.payment_operations`, `ledger.journal_transactions`, `ledger.journal_entries`, `ledger.account_balances`, or the messaging outbox. All mutation flows through fixed-`search_path` `SECURITY DEFINER` functions owned by non-login function roles, each of which validates the invoker role and the authenticated principal.

Declarative constraints, partial unique indexes, and deferred constraint triggers remain in place underneath. The functions do not replace them; they add the checks that span rows and tables.

## Consequences

- A defect in application code, a hand-run `psql` session, or a careless migration cannot post an unbalanced journal, clear an active pointer, or advance a version without its event.
- Tests can assert "the application role *cannot* do X." That is a materially stronger claim than "the application *does not* do X," and it is the strongest claim this project makes.
- Domain logic is split between TypeScript and PL/pgSQL. The split is deliberate: pure calculation, classification, and orchestration stay in TypeScript; atomic multi-row invariants live in the function. Each function's contract is documented in the data model.
- Golden vectors for the canonical posting hash must pass identically in both languages, because both compute it.
- A function signature change is a migration with a deployment ordering constraint, not a refactor.
- Debugging crosses a language boundary and stack traces are less direct.

## Rejected alternatives

- **Application-layer enforcement only:** cannot survive an application bug, which is the scenario the guarantee is for. It also makes cross-tenant and prohibited-write tests untestable, because the role would be allowed to do the thing under test.
- **Triggers only:** express per-row rules well, but cannot own canonical lock ordering across balance rows or guarantee that the outbox insert happens in the same statement sequence.
- **ORM-managed writes:** hides explicit locks, `SKIP LOCKED` claims, partial indexes, and deferred constraints — the exact mechanisms this project exists to demonstrate.
- **A separate ledger service with its own database:** reintroduces a distributed transaction between the payment transition and the posting, which [ADR-0001](0001-modular-monolith-with-workers.md) deliberately avoids.
