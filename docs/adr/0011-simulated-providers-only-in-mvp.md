# ADR-0011: Simulated providers only in the MVP; a real adapter is deferred

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

The original plan included a Stripe PaymentIntents test-mode adapter as milestone M10, alongside the deterministic fake provider and the seeded unreliable simulator.

A real sandbox adapter demonstrates integration against a provider nobody controls. It also introduces a credential dependency, network variance, rate limits, and a set of failure modes that cannot be produced on demand — which are the failure modes this project is built to handle.

## Decision

The MVP ships two adapters: the deterministic fake provider and the seeded unreliable simulator built on top of it.

The provider-neutral interface, the capability model, the normalized outcome taxonomy, and the shared adapter conformance suite are unchanged. A real adapter remains an additive change that implements an existing interface and passes an existing suite.

## Consequences

- A clean clone runs every test offline: no credentials, no network, no rate limits, no shared sandbox state. That is what makes the benchmark and chaos workloads reproducible by a reviewer rather than only by the author.
- Ambiguous outcomes, duplicate webhooks, out-of-order webhooks, malformed success responses, and contradictory evidence are injected deterministically from a recorded seed. A real sandbox cannot be asked to time out after committing.
- The project cannot claim real-provider integration, and should not. The adapter abstraction is evidenced by two independent implementations plus a conformance suite that both pass, rather than by one real integration.
- Engineering time moves from HTTP plumbing to settlement, which exercises the ledger. See [ADR-0012](0012-ledger-only-settlement.md).
- The capability model keeps fields that no MVP adapter needs, such as declared same-key write idempotency. They stay because they are what a real adapter must declare, and they are conformance-tested.

## Rejected alternatives

- **Stripe test mode in the MVP:** cannot be load tested, cannot inject the ambiguity this project is about, adds a credential dependency that breaks offline reproducibility, and demonstrates integration rather than design.
- **A mock provider only:** a mock that always succeeds proves nothing about recovery. The deterministic fake is a complete reference implementation with its own persisted state and its own idempotency, which is why it can serve as the conformance oracle.
- **Both simulated and real adapters in the MVP:** doubles provider work on the critical path before the recovery paths that make the project interesting are finished.
- **A recorded-cassette replay of a real provider:** fixes the fault distribution at record time, so the simulator's configurable seeded faults are strictly more useful.
