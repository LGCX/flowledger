# Scope and glossary

Status: **Draft**  
Last updated: 2026-11-05

## Product statement

FlowLedger accepts merchant payment commands, executes them against sandbox payment providers, records confirmed financial effects in an immutable double-entry ledger, and recovers safely from duplicate delivery, process crashes, and ambiguous provider outcomes.

The project optimizes for four demonstrable qualities:

1. Financial correctness.
2. Effectively-once business effects over at-least-once infrastructure.
3. Measurable throughput and latency.
4. Explainable failure detection and recovery.

## Actors

- **Merchant:** Tenant that creates and manages payments through the API.
- **Merchant operator:** Human who inspects transactions and resolves cases requiring manual review.
- **Payment provider:** External sandbox that authorizes, captures, cancels, and refunds payments.
- **Platform operator:** Human responsible for FlowLedger reliability and reconciliation.
- **Customer:** Person paying the merchant. FlowLedger stores only synthetic customer references, never raw payment credentials.

## MVP scope

### Included

- Multiple isolated merchants.
- USD payments. All models remain currency-aware, but the MVP rejects non-USD commands.
- At most one successful authorization per payment. Declined or definitively failed attempts may be retried under the provider policy.
- One capture per authorization. A capture may be full or partial; a provider-confirmed partial capture releases the uncaptured remainder.
- Multiple refunds, concurrent or sequential, whose confirmed plus reserved total cannot exceed the confirmed captured amount.
- Cancellation of an authorization before capture.
- Configurable platform fee recorded at capture time, with a declared minimum capture amount per fee policy.
- A deterministic fake provider plus a seeded unreliable simulator. No real-provider adapter ships in the MVP.
- An unreliable provider simulator that injects timeouts, latency, rate limits, malformed responses, duplicate webhooks, and out-of-order webhooks.
- Immutable double-entry journal with striped platform clearing buckets, synchronous balance projection, transactional outbox/inbox, webhooks, and reconciliation.
- Ledger-only settlement: confirmed captures and refunds accumulate in a merchant clearing position and are closed into immutable payout batches that move value to merchant payable.
- REST merchant command/query API including a read-only payment timeline, authenticated read-only operator views/CLI, and audited recovery commands. A cross-tenant operator HTTP API is not an MVP dependency.

### Deferred

- Multiple captures against one authorization.
- A real-provider adapter. The provider interface, capability model, and conformance suite are built for one; only the implementation is deferred.
- Merchant payouts and bank settlement. Internal ledger settlement is in scope; moving value out of the system is not.
- Draining merchant payable. Payable accumulates and is never paid out in the MVP.
- A merchant-facing settlement list endpoint and merchant settlement webhooks. Settlement is ledger and operator state in the MVP, visible to a merchant through the payment timeline.
- Cross-currency payments and foreign exchange.
- Chargebacks and representment.
- Recurring billing and subscriptions.
- Split payments and marketplace connected accounts.
- Real customer authentication flows such as 3-D Secure.
- Multi-region active-active writes.
- A cross-tenant operator HTTP API or operator web application; MVP operator access uses separately authenticated read-only views/CLI and protected recovery commands.

### Explicitly excluded

- Production card processing.
- Storage, logging, or transmission of PAN, CVV, bank credentials, or other raw payment credentials.
- Custody of real funds.
- Claims of PCI certification or regulatory compliance.
- Scraping or reverse-engineering a provider in violation of its terms.

## Canonical terms

### Merchant

The tenant and ownership boundary. Every payment, operation, ledger account, journal transaction, idempotency record, and webhook endpoint belongs to exactly one merchant unless explicitly marked platform-owned.

### Payment

The aggregate representing one merchant request to collect a fixed maximum amount in one currency. It owns the authorization, capture, and refund limits but does not itself represent a ledger entry.

### Payment operation

A durable command to perform one external action: `AUTHORIZE`, `CAPTURE`, `CANCEL`, or `REFUND`. Operations have their own lifecycle so retries and unknown provider outcomes do not overwrite the last confirmed payment state.

### Provider attempt

One recorded interaction with a provider for a payment operation. It uses a stable provider idempotency key. Transport retries belonging to the same logical provider request do not create a new financial operation.

### Authorization

A provider-confirmed reservation of spending capacity. Authorization does not move settled funds and therefore creates no journal transaction in the MVP.

### Capture

A provider-confirmed instruction to collect all or part of an authorization. Capture creates the initial ledger transaction because a financial receivable and merchant obligation now exist. The obligation is credited to merchant clearing, not directly to a payable position.

### Cancellation

Release of an uncaptured authorization. Cancellation creates no journal transaction in the MVP.

### Refund

A provider-confirmed return of captured value. Each refund creates its own ledger transaction. A refund is a business event, not an accounting reversal of the capture journal transaction.

### Ledger account

A currency-specific accounting bucket with an owner, account type, and negative-balance policy. Examples include processor receivable, merchant clearing liability, merchant payable liability, and platform fee revenue.

### Clearing bucket

One of `N` deterministic stripes of a shared platform ledger account. A posting selects its bucket from the payment ID, so concurrent postings for different payments do not contend on one balance row. The logical account balance is the sum over its buckets.

### Merchant clearing

The merchant liability position holding value a provider has confirmed but that no settlement batch has closed over. It may go negative when a refund confirms after its capture has settled.

### Merchant payable

The merchant liability position holding value a closed settlement batch has recognized as owed. It never decreases in the MVP, because there is no payout step.

### Movement

One confirmed capture or refund journal transaction, considered as a candidate for settlement. A movement is settled exactly when a settlement batch membership row references it.

### Settlement batch

An immutable record of one settlement run that posted. It fixes its member movements at posting time, carries the net amount moved from clearing to payable, and is never mutated — a late refund lands in a later batch instead.

### Reserved refund amount

Value held by refund operations that have been accepted but not yet resolved. It is not confirmed money. It exists so that concurrent refunds cannot collectively exceed captured value, and it is released when the refund reaches any terminal state.

### Ledger transaction

An immutable, atomic journal record containing two or more entries. Its entries MUST balance within its single currency.

### Ledger entry

One debit or credit to one ledger account for a positive amount. An entry has no independent lifecycle outside its ledger transaction.

### Balance projection

A rebuildable table containing the current balance of each ledger account. It is updated in the same PostgreSQL transaction as journal posting for strongly consistent reads, but the immutable entries remain authoritative.

### Provider reference

An opaque identifier issued by a provider. The platform never derives meaning from its format.

### Idempotency key

A merchant-supplied identifier for one API command. Repeating the same key and canonical request returns the original command result; reusing the key for different input is a conflict.

### Business effect

A change visible to the domain, such as creating one operation, confirming one capture, or posting one journal transaction. Multiple deliveries of the same request or message MUST NOT create multiple business effects.

### Ambiguous outcome

A provider interaction for which FlowLedger cannot prove success or failure—for example, a timeout after the request might have reached the provider. The operation becomes `UNKNOWN` and is resolved by lookup, webhook, or reconciliation rather than a new blind financial request.

### Reconciliation

Comparison of FlowLedger state with authoritative provider state, followed by an idempotent correction or escalation when they differ.

## Scope acceptance examples

| Scenario | MVP behavior |
| --- | --- |
| Duplicate authorize request with identical idempotency key and payload | Return the original operation; create no second provider action |
| Same idempotency key with a different amount | Reject with `409 Conflict` |
| Capture request times out after submission | Mark the operation `UNKNOWN`; do not post the ledger; reconcile by stable provider key |
| Provider later confirms the capture | Atomically mark capture successful, post the journal transaction, and write outbox events |
| Duplicate capture webhook | Inbox/uniqueness constraints reduce it to one confirmed capture and one ledger posting |
| Two refunds race and exceed captured value together | At most one reserves the remaining refundable amount; the other is rejected by the monetary guard under the payment lock |
| Two refunds that both fit are submitted concurrently | Both are accepted and both reserve their amount; neither waits for the other |
| A refund stays `UNKNOWN` indefinitely | It keeps holding only its reserved amount; further refunds against the remaining available amount are still accepted |
| Capture of USD 0.10 under a policy with a USD 0.30 fixed fee | Reject with `422 CAPTURE_BELOW_MINIMUM`; the fee is never capped and the capture is never priced below cost |
| Capture confirms, then a refund confirms after settlement closed | Merchant clearing goes negative and the next run defers; the closed batch is never mutated |
| Non-USD payment | Reject during command validation in the MVP |
| Raw card number submitted | Reject and ensure it is never logged |

## MVP decisions

- **Providers:** No real-provider adapter ships in the MVP. The deterministic fake provider is the conformance oracle and the seeded unreliable simulator is the failure-testing target. Both pass the same adapter conformance suite, which is what evidences the abstraction. See [ADR-0011](adr/0011-simulated-providers-only-in-mvp.md).
- **Fee behavior on refund:** Refunds reverse the capture fee proportionally. The cumulative calculation in the ledger contract guarantees that a full refund reverses the complete fee without floating-point arithmetic. The incremental reversal is computed when a refund confirms, not when it is accepted, so concurrent refunds cannot over-reverse. See [ADR-0008](adr/0008-fee-recognized-at-capture.md).
- **Refund concurrency:** The refundable amount, not an operation count, limits refunds in flight. See [ADR-0003](adr/0003-exclusive-operations-and-reserved-refunds.md).
- **Settlement:** Settlement is internal to the ledger and is not a payout. See [ADR-0012](adr/0012-ledger-only-settlement.md).
- **Idempotency retention:** API idempotency ownership does not expire in the MVP. Records may later be compacted into immutable tombstones containing the key scope, canonical request hash, response status, and result locator, but reusing an old key MUST never become a new command merely because its full response was archived. See [ADR-0009](adr/0009-idempotency-keys-never-expire.md).
