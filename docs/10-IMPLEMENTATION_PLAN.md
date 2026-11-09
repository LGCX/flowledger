# Implementation plan

Status: **Proposed execution baseline**  
Last updated: 2026-11-05

## Purpose

This plan turns the FlowLedger contracts into a build sequence with explicit features, dependencies, test evidence, and exit criteria. It is deliberately organized around complete business slices rather than folders or framework layers.

The implementation is complete only when it demonstrates all four project claims:

1. Confirmed financial effects are correct and auditable.
2. Duplicate requests, messages, webhooks, and provider responses create at most one business effect.
3. Ambiguous external outcomes converge through evidence and reconciliation rather than blind retries.
4. Published throughput and latency numbers are reproducible and remain valid under correctness checks.

This plan is subordinate to the contracts in this repository. If implementation reveals that a contract is impossible or contradictory, change the contract and record the decision before changing behavior.

## Delivery definitions

The project has three useful completion levels:

| Level | Included milestones | Result |
| --- | --- | --- |
| Local vertical slice | M0-M7 | A locally runnable API can create, authorize, capture, cancel, and refund through the deterministic fake provider, with a striped immutable ledger, concurrent refunds, durable messaging, and a passing invariant checker. |
| Reliability-complete MVP | M0-M10 | Ambiguous outcomes, reconciliation, provider webhooks, merchant webhooks, DLQ recovery, and ledger settlement work end to end. |
| Portfolio-complete system | M0-M13 | The system is observable, deployed reproducibly on GCP, failure-tested, benchmarked including the ledger contention comparison, documented, and supported by evidence suitable for a résumé or technical interview. |

The local vertical slice is not sufficient for a distributed-systems performance claim. The portfolio-complete system is the target.

## Fixed implementation choices

These choices optimize for the target backend role and preserve the database-level guarantees in the contracts:

- **Language:** TypeScript in strict mode on a current supported Node.js LTS release.
- **Application framework:** NestJS with the Fastify adapter for HTTP entry points and Nest standalone application contexts for workers.
- **Repository:** pnpm workspace with shared packages and independently runnable applications.
- **Database:** PostgreSQL with explicit SQL migrations and `pg`-based repositories. Avoid an ORM that obscures locks, deferred constraints, partial indexes, RLS, or protected functions.
- **HTTP contracts:** OpenAPI is checked in; request and response types are generated or verified from it. Runtime validation rejects unknown fields.
- **Message contracts:** Draft 2020-12 JSON Schema plus generated TypeScript types; runtime validation occurs before outbox insertion and before consumer effects.
- **Messaging:** An in-memory transport for unit tests, a local adapter for deterministic integration tests, and Google Pub/Sub for deployed environments.
- **Providers:** Deterministic fake and seeded unreliable simulator only. No real-provider adapter ships in the MVP ([ADR-0011](adr/0011-simulated-providers-only-in-mvp.md)), which is what keeps every test, chaos workload, and benchmark runnable offline from a clean clone.
- **Tests:** Vitest for unit/integration orchestration, a property-testing library such as fast-check, Testcontainers for PostgreSQL, and k6 for open-model load tests.
- **Telemetry:** OpenTelemetry traces/metrics, structured JSON logs, and explicit correlation/causation propagation.
- **Infrastructure:** Docker Compose for local dependencies and Terraform for GCP resources after local correctness gates pass.

Exact dependency versions are selected and pinned during M0. A dependency update is a normal reviewed change; it cannot change a financial contract implicitly.

## Repository shape

```text
flowledger/
  apps/
    api/
    outbox-relay/
    payment-worker/
    provider-webhook-receiver/
    provider-webhook-worker/
    reconciler/
    settlement-worker/
    merchant-webhook-projector/
    merchant-webhook-dispatcher/
  packages/
    domain/
    database/
    contracts/
    providers/
    messaging/
    observability/
    config/
    testkit/
  migrations/
  schemas/
  openapi/
  test/
    contract/
    integration/
    e2e/
    chaos/
    performance/
  infra/
    docker/
    terraform/
  docs/
```

Applications are deployment entry points, not separate product domains. Domain rules remain in packages and PostgreSQL protected functions; entry points wire transport, configuration, and lifecycle concerns around them.

## Engineering rules that apply to every milestone

### Financial safety

- Money is a branded decimal-string/`bigint` type; JavaScript `number` is forbidden in financial calculations.
- No provider or merchant HTTP request occurs while a database transaction or row lock is open.
- Every external write uses a stable operation identity.
- No code path converts a timeout, connection loss, or malformed response into confirmed failure unless the provider adapter supplies the contracted no-effect proof.
- Only protected database functions may apply payment transitions or insert ledger postings.
- Direct table mutation in tests is limited to migration/constraint tests and clearly named fixture helpers.

### Delivery safety

- Every application exposes health, readiness, graceful shutdown, and bounded concurrency.
- Consumers acknowledge only after their database transaction commits.
- Every claimed job has a lease, an owner, and a deterministic stale-work policy.
- Logs, traces, messages, test snapshots, and errors use the same redaction allowlist.
- No benchmark is accepted unless the post-run accounting and duplication audits pass.

### Change discipline

- Each pull request implements one named behavior and its tests.
- Schema changes include a forward migration, migration test, and contract impact note.
- Event/API changes update the machine contract before producer or consumer code.
- A feature is not complete when the happy path works; its duplicate, concurrency, crash, and authorization cases must also pass.

## Milestone summary

Effort is expressed as focused engineering hours with AI assistance. It includes review and tests, not passive waiting for cloud resources.

| Milestone | Outcome | Depends on | Estimate | Exit gate |
| --- | --- | --- | ---: | --- |
| M0 | Repository, CI, local runtime, contract validation | Contracts | 8-12 h | Clean clone passes static and contract checks |
| M1 | Domain kernel and generated contract types | M0 | 10-16 h | Domain-ready unit/property gate |
| M2 | Database identity, payment, idempotency, and durable messaging foundation | M1 | 20-30 h | Core migration, tenant-isolation, and persistence tests pass |
| M3 | Immutable double-entry ledger, striped buckets, and the invariant checker | M2 | 26-38 h | Ledger-ready gate passes and `flowledger verify` reports zero findings |
| M4 | Authenticated payment API, HTTP idempotency, and payment timeline | M2 | 22-32 h | Create/query/replay/timeline API scenarios pass |
| M5 | Command acceptance with refund reservations, outbox, and inbox | M3-M4 | 20-30 h | Durable `202`, reservation guard, and redelivery tests pass |
| M6 | Fake providers, retry scheduler, and payment execution worker | M5 | 22-34 h | Adapter conformance and authorize/cancel paths pass |
| M7 | Capture/refund resolution integrated with ledger | M6 | 20-30 h | Full local financial lifecycle including concurrent refunds passes |
| M8 | Leases, ambiguity, reconciliation, expiry, and evidence | M7 | 28-42 h | Unknown/expiry failure suites converge safely |
| M9 | Provider and merchant webhook pipelines | M7-M8 | 22-34 h | Signed duplicate/out-of-order delivery tests pass |
| M10 | Ledger settlement, payout batches, and operational recovery | M8-M9 | 20-32 h | Settlement invariants plus runbooks pass |
| M11 | Security, telemetry, and operator visibility | M8-M10 | 12-18 h | Redaction, RLS, traces, metrics, and alerts verified |
| M12 | Local performance/chaos readiness and tuning | M11 | 24-40 h | Harness, correctness audit, and local preflight pass |
| M13 | HA GCP deployment, reference benchmark, and portfolio evidence | M12 | 28-48 h | Reproducible HA deployment and performance-ready gate complete |

Expected total: **282-436 focused hours** for the full portfolio-complete system. M0-M7, the complete local financial slice, is **148-222 hours**. At 20 focused hours per week, expect roughly 7-11 weeks for that local slice and 14-22 weeks for the complete cloud/benchmark portfolio; full-time execution is roughly 4-6 and 7-11 weeks respectively.

### Estimate calibration

Treat these numbers as a lower bound, not a forecast. Three things make them optimistic:

- The contracts specify production-grade mechanisms — RLS, `SECURITY DEFINER` write boundaries, deferrable constraint triggers, canonical lock ordering, dual-approval operator flows, Terraform HA, a failover drill. Each is individually modest and collectively expensive.
- Crash-point and concurrency tests are slow to write correctly and are where most of the real time goes. They are also the reason the project is worth building, so they cannot be the thing that gets cut.
- AI assistance reduces scaffolding and test-authoring time. It does not reduce the database, concurrency, recovery, or benchmark verification work, which is the majority.

The honest planning assumption is that a part-time single engineer should expect the upper end or beyond, and should prefer shipping M0-M7 with a working demo over reaching M13 with nothing runnable. Scope was already cut once for this reason: retention archival and dual-approval operator tooling came out of M11, and the real-provider adapter came out of M10.

## M0 — Repository and verification foundation

### Features and tasks

- Initialize the pnpm workspace, shared TypeScript configuration, formatting, linting, and dependency pinning.
- Create every application entry point with a common configuration and graceful-shutdown module, even if initially inert.
- Add Docker Compose for PostgreSQL, the Pub/Sub emulator or local transport, and telemetry development services.
- Add commands for `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, `test:contracts`, and `test:performance`.
- Validate OpenAPI, all JSON Schemas, registry mappings, local references, examples, and migration ordering in CI.
- Generate TypeScript types from OpenAPI/JSON Schema into a build directory and fail on an uncommitted contract drift.
- Add secret scanning and prohibited-data fixtures for PAN/CVV/token redaction tests.
- Record the supported Node.js, PostgreSQL, package-manager, Docker, and Terraform versions.

### Test and acceptance criteria

- A clean clone reaches a green static pipeline using one documented command.
- The OpenAPI file parses and all local references resolve.
- Every registry type maps to an existing schema and the documented command-and-event catalog has exact one-to-one parity with the registry.
- Every schema compiles with UUID/date-time format assertions enabled.
- Intentionally malformed schema, unknown message field, and invalid OpenAPI examples fail the contract job.
- No application needs an undocumented local secret to start in test mode.

### Artifacts

- Root development README and command reference.
- CI workflow with separate fast and integration jobs.
- Version manifest and dependency-lock file.
- Contract validation report retained as a CI artifact.

## M1 — Domain kernel

### Features and tasks

- Implement branded types for every entity ID and strict constructors for currency, amount, provider name, idempotency key, and timestamp.
- Implement decimal-string to `bigint` conversion with bounds and checked arithmetic.
- Implement payment aggregate states, operation states, guards, aggregate-version increments, and derived summary status as pure functions.
- Implement capture fee and cumulative proportional refund-fee allocation exactly as specified.
- Implement canonical API request hashing and canonical ledger posting hashing.
- Implement normalized provider result/error/evidence types as discriminated unions.
- Implement retry classification, backoff calculation, and stable provider-idempotency-key derivation.
- Expose domain errors as codes; do not embed HTTP, Pub/Sub, provider SDK, or SQL concerns in the domain package.

### Test and acceptance criteria

- Unit tests cover minimum, maximum, zero, malformed, overflow, and non-USD amounts.
- Property tests generate valid and invalid operation sequences and check every monetary invariant after each step.
- Capture-fee golden vectors cover below-half, exact-half, and above-half minor-unit boundaries, fixed-plus-percentage composition, checked overflow, zero fee, fee equal to gross, and fee greater than gross.
- Fee properties prove non-negative incremental reversals, no over-reversal, and exact full-fee reversal after a full refund.
- Same canonical API input always hashes identically; semantic input changes alter the hash.
- Ledger posting hashes are independent of input entry order and match checked-in golden vectors.
- Provider result unions make it impossible to construct `FAILED` without no-effect proof or `SUCCEEDED` without a provider operation ID.
- Randomized tests persist seed and minimized counterexample on failure.

## M2 — PostgreSQL and durable-messaging foundation

### Features and tasks

- Create schemas, extensions, owner/runtime roles, prefixed-ID validation functions, and common timestamp/hash helpers.
- Implement merchant identities and API credential digests, scopes, activation, expiry, rotation, and revocation.
- Implement provider accounts, immutable configuration versions, credential references, webhook endpoints, and endpoint-account allowlists.
- Implement merchant provider routes with one active route per provider code/environment and one optional active default; route selection and current account-version snapshot are deterministic inside payment creation.
- Implement append-only fee-policy versions.
- Implement payments and payment operations, including composite tenant/provider/version keys, the refund reservation fields, the exclusive-operation partial unique index, and the deferred trigger proving both the exclusive pointer and the reservation aggregate against the operation rows.
- Implement API idempotency ownership, result replay data, immutable tombstones, and result-resource integrity.
- Create outbox, inbox, dead-letter, and replay-history persistence before any payment or ledger feature needs to emit an atomic event. Implement strict envelope-column derivation and the protected outbox insertion boundary; transport publication and consumer execution remain in M5.
- Implement RLS and explicit merchant-scoped views/repository queries.
- Add deterministic seed data for two merchants, fake providers, fee policies, and test credentials.

### Test and acceptance criteria

- Migrations apply from an empty database and from the previous checked-in migration fixture.
- Invalid IDs, currencies, amounts, statuses, and provider/configuration bindings fail at the database boundary.
- Cross-tenant reads and references fail through every exposed role/view/function.
- Missing `app.merchant_id` sees no merchant data.
- A payment cannot change provider account, provider version, payment-method ciphertext, currency, requested amount, or fee policy after creation.
- Deferred constraints reject a mismatch between `active_exclusive_operation_id` and the one unresolved exclusive operation, and reject any drift between the refund reservation fields and the unresolved refund rows.
- One hundred concurrent claims of one idempotency key elect one owner.
- Same key plus changed canonical request hash deterministically conflicts.
- Runtime roles cannot bypass transition functions with direct updates.
- Invalid envelopes cannot enter the outbox, and direct runtime DML cannot forge outbox, inbox, or DLQ identity/content fields.

## M3 — Ledger core, striping, and the invariant checker

Two things that were originally much later in the plan belong here.

Striping is designed in from the start because it changes the account model, the seed, the posting function, and the audit — retrofitting it after capture and refund are built would touch every one of those. It is also the project's primary measured result, so the baseline must be reproducible from the same code.

The invariant checker is built now because a checker written after the system is finished tends to assert whatever the implementation happens to do. Written against the contracts first, it constrains the implementation instead.

### Features and tasks

- Implement ledgers, accounts, zero balance creation, journal transaction headers, journal entries, and synchronous balance projections.
- Implement striped platform accounts: `logical_code`/`bucket_index`/`bucket_count` columns and their derivation checks, the seeded bucket set at the environment's bucket count, the `IMMUTABLE` `ledger.bucket_for_payment` derivation, and the `ledger.logical_account_balances` aggregating view. Bucket selection happens inside the protected posting function; no caller may choose a bucket.
- Implement merchant clearing and merchant payable account types with their negative-balance policies: clearing permits a negative balance, payable does not.
- Implement `flowledger verify`, the invariant checker, covering every assertion class in the test plan: journal balance, projection equality, bucket aggregation, payment totals, reservation integrity, posting cardinality, orphan detection, settlement membership, and the cross-system duplicate-effect detector. Classes whose subject tables do not exist yet report zero rows checked rather than passing silently; each later milestone turns its class on.
- Wire `flowledger verify` into CI so it runs against the integration database on every database or domain change.
- Implement the private canonical posting routine and the protected dual-approved correction/reversal entry point. Defer the evidence-bound `ledger.post_payment_operation` wrapper until M7, after M6 creates provider evidence persistence.
- Implement canonical balance-row lock ordering and protected negative-balance checks.
- Derive merchant, currency, account identities, and posting hash inside the trusted database boundary; payment-operation/evidence derivation is added by the M7 wrapper.
- Implement pure exact capture/refund recipe generation and golden vectors, including proportional fee reversal, without yet exposing a production payment-posting entry point.
- Implement idempotent replay: same posting key plus same computed financial hash returns the original transaction; a changed hash raises a conflict.
- Implement full reversal links and the separately protected, dual-approved correction path.
- Implement balance rebuild/audit tooling.

### Test and acceptance criteria

- Unbalanced, cross-currency, cross-ledger, cross-merchant, zero-entry, closed-account, or negative-protected-balance postings fail.
- Direct insert/update/delete/truncate against journal tables fails for every runtime role.
- One hundred concurrent identical postings through the correction entry point or migration-owner integration harness produce one journal transaction, one entry set, and one balance effect; no runtime role can execute the private routine directly.
- Random balanced postings rebuild to exactly the synchronous balance projection.
- Random posting order and retries do not change results.
- Full reversals produce a zero net effect per account and cannot be duplicated.
- Deadlock/serialization retries retain the original posting key and converge.
- Every striped logical account has a contiguous complete bucket set; a physical `code` always agrees with its `logical_code` and `bucket_index`; a merchant-owned account cannot be striped.
- `ledger.bucket_for_payment` is stable for a payment ID across sessions and processes, and a retry under an existing posting key resolves to the same bucket and returns the original transaction.
- Bucket sums equal both the logical-balance view and a rebuild from immutable entries, at `N = 1` and at the seeded bucket count.
- Postings for payment IDs in different buckets commit concurrently; postings in the same bucket serialize without deadlocking under every capture/refund interleaving.
- `flowledger verify` runs against a populated database, reports per-class counts, and fails the build on any nonzero finding. A deliberately corrupted fixture — an unbalanced transaction, a divergent projection, a bucket-sum mismatch — is detected by the correct class.

## M4 — Merchant API and HTTP idempotency

### Features and tasks

- Implement bearer credential parsing, constant-time digest verification, scope checks, revocation/expiry checks, and merchant context.
- Add request-size, content-type, duplicate-JSON-key, unknown-field, credential-shape, and prohibited-payment-data defenses.
- Implement `POST /v1/payments` with derived provider routing, encrypted sandbox token storage, fee/configuration snapshots, idempotency, and `payment.created.v1` outbox insertion.
- Implement payment and operation retrieval/listing with tenant scope, cursor pagination, ETags, and conditional GET.
- Implement `GET /v1/payments/{paymentId}/timeline` with the closed per-`kind` detail shapes, database-recorded ordering, the bounded entry count with `truncated`, and the redaction allowlist. Entry kinds whose source tables arrive in later milestones are added as those milestones land; the endpoint and its contract exist from here so the demo and the operator views build on one surface.
- Implement problem-details errors and exact HTTP status/code mapping, including `422 CAPTURE_BELOW_MINIMUM`.
- Implement idempotency replay, in-progress wait, conflict, and expired-body/tombstone behavior.
- Ensure logs record request/correlation IDs but never bearer credentials or payment method references.

### Test and acceptance criteria

- OpenAPI request/response conformance tests cover every create/query status and header implemented in this milestone.
- Identical create requests replay byte-equivalent status, selected headers, and body.
- Changed create body under the same idempotency key returns the contracted conflict and creates no effect.
- Concurrent identical creates produce one payment and one created event.
- Wrong-tenant resource IDs return `404`; missing scope returns `403`; invalid credential returns `401`.
- Invalid conditional-GET ETags, malformed cursors, non-USD amounts, JSON numbers for money, unknown fields, and raw-card fixtures fail without an idempotency/business row.
- Pagination is stable and cannot cross tenants.
- The timeline orders entries by database-recorded time, never by provider timestamps; truncates at the documented bound with `truncated: true`; exposes no prohibited field in any `detail` variant; and returns `404` for a cross-tenant payment ID.
- Explicit provider selection, omitted-provider default selection, missing default, disabled route/account, and concurrent route-version rollover tests prove that one exact account/configuration snapshot is chosen or the request fails before idempotency/business state commits.

## M5 — Durable command acceptance and messaging core

### Features and tasks

- Implement authorize, capture, cancellation, and refund acceptance endpoints.
- In one transaction, claim idempotency, lock/version-check payment, evaluate guards, create the operation, set the exclusive pointer or add the refund reservation, increment aggregate version, create requested event, create execute command through the M2 protected outbox boundary, and store the replay response.
- Implement the exclusion model: one unresolved `AUTHORIZE`/`CAPTURE`/`CANCEL` per payment behind the partial unique index, with any number of concurrent unresolved refunds bounded by the reservation guard `refunded + reserved + amount <= captured` under the payment lock, plus the deferred constraint trigger proving the reservation fields against the operation rows.
- At capture acceptance, snapshot the immutable fee-policy identity/version, basis points, fixed amount, capture rounding mode, refund mode, exact charged fee, and capture gross; reject an amount below the policy's `minimum_capture_amount_minor`. At refund acceptance, copy the capture's fee inputs and store **no** fee effect — the incremental reversal is computed at confirmation in M7.
- Enforce the authorization retry policy at acceptance: at most three authorization operations total, with a new operation/key allowed only after the predecessor is `REJECTED` or `FAILED` with conclusive no-effect proof.
- Implement relay claiming with `FOR UPDATE SKIP LOCKED`, bounded leases, retry schedule, publication acknowledgement, and stable envelope UUIDs.
- Implement the Pub/Sub transport adapter and deterministic local transport.
- Implement inbox claim/effect transactions using `(consumer_name, envelope_id)` rather than broker message ID.
- Implement strict consumer validation and durable DLQ insertion using the M2 tables; schema/version failures have no domain effect.
- Add sweepers that rediscover committed unpublished outbox rows and accepted operations.

### Test and acceptance criteria

- Every money-changing endpoint returns `202` only after the complete acceptance transaction commits.
- Failure injected after each statement rolls back idempotency, operation, pointer, version, and outbox together.
- One hundred duplicate API calls create one operation and one pair of outbox messages.
- A stale new-key `If-Match` returns `412 PAYMENT_VERSION_MISMATCH` without consuming the idempotency key or creating an operation/outbox row.
- An exact idempotency replay is resolved before comparing the current payment version and returns its stored `202` even after the payment advances.
- Reusing a key after changing, adding, or removing its semantic `If-Match` input returns `409 IDEMPOTENCY_CONFLICT` with no second effect.
- A capture below the bound policy's `minimum_capture_amount_minor` returns `422 CAPTURE_BELOW_MINIMUM` before an operation, idempotency result, or outbox row commits. A fee policy is inserted only when `floor((minimum_capture_amount_minor*basis_points+5000)/10000)+fixed_amount_minor <= minimum_capture_amount_minor`, which is stronger than requiring the minimum to cover the fixed component, so `fee > gross` is unreachable at acceptance rather than guarded at runtime; the boundary `fee == gross` remains valid.
- Several refunds that collectively fit are all accepted concurrently, each returning `202`; the reserved total and unresolved count match the operation rows under every interleaving; a refund exceeding `captured - refunded - reserved` returns `409 MONETARY_GUARD_FAILED` from the locked guard, and the test asserts the failure source is the guard rather than a uniqueness constraint.
- An exclusive command is rejected while any refund is unresolved, and a refund is rejected while any exclusive operation is unresolved.
- Changing the active fee policy after capture/refund acceptance cannot change the stored fee inputs, provider retries, reconciliation result, or eventual journal posting.
- Authorization attempts one through three may be accepted only after the contracted predecessor outcome; the fourth is rejected, and `UNKNOWN`/`REQUIRES_REVIEW` never permits a replacement operation or key.
- Provider-command OpenAPI conformance covers every documented command status, problem code, and required/conditional header.
- Relay crash after publish/before acknowledgement republishes the same envelope ID.
- Consumer crash before commit replays; crash after commit produces no second local effect.
- Unknown schema versions and invalid messages enter the DLQ with contracted metadata and no domain effect.
- Aggregate-version gaps are parked/rebuilt rather than silently applied.

## M6 — Provider adapters and execution worker

### Features and tasks

- Implement the provider-neutral interface and capability checks.
- Implement the deterministic fake provider with stable records keyed by provider idempotency key.
- Implement the unreliable simulator with configurable latency, rate limits, timeouts, connection loss, malformed responses, duplicate webhooks, and out-of-order webhooks.
- Implement operation claim, payment/operation locking, `REQUESTED -> PROCESSING`, `RESERVED` attempt creation, lease acquisition, and pre-call dispatch marker.
- Create provider-attempt, verified-notification, and append-only evidence persistence with tenant/operation-safe keys and source-shape constraints. Reconciliation-case foreign keys remain deferred until M8 creates cases.
- Implement `RETRYABLE_NO_EFFECT` as a proof-bearing nonterminal result: stage evidence, complete the current attempt, atomically move `PROCESSING -> REQUESTED`, persist bounded `notBefore`, clear the lease, retain the same operation/provider key, and increment only operation version.
- Implement a due-work scheduler that claims deferred `REQUESTED` operations with `SKIP LOCKED` and atomically clears `notBefore` plus inserts a fresh execution command for the same operation.
- Decrypt the payment method reference only immediately before building the authorization command and keep it out of durable attempt/message/log data.
- Execute provider calls without database locks and stage normalized evidence before applying it.
- Apply authorization and cancellation outcomes through protected transitions.
- Implement per-provider-account concurrency limits, backoff, circuit breaking, and fairness.

### Test and acceptance criteria

- Deterministic fake and unreliable simulator pass the same adapter conformance suite.
- Capability mismatch fails before an attempt or provider write.
- Every transport retry reuses the stable provider idempotency key.
- Confirmed success, rejection, definitive no-effect failure, rate limit, auth error, malformed response, timeout, and connection loss map exactly to contracted outcomes.
- Every ambiguous observation maps to the closed reconciliation-reason vocabulary, including provider 5xx, post-send SDK exception, missing correlation identity, stale dispatch, and adapter defect.
- An open circuit before dispatch leaves work safely queued; it does not invent failure or ambiguity.
- A safe retry cannot dispatch before `notBefore`; crashes before/after scheduling and while clearing due work neither lose the operation nor create two provider effects.
- Every proven-no-effect retry preserves payment version, confirmed totals, the exclusive pointer or refund reservation, operation ID, and provider key while incrementing operation version exactly once per protected scheduling mutation.
- A slow/rate-limited provider account cannot consume another account's concurrency budget.
- Credentials, payment method references, and raw provider bodies are absent from all retained telemetry and evidence.

## M7 — Capture, refund, and complete local lifecycle

### Features and tasks

- Apply confirmed capture evidence atomically with payment totals, operation resolution, ledger posting, balance updates, and terminal/ledger outbox events.
- Install `ledger.post_payment_operation(operation_id, evidence_id, outbox_envelope)` now that operation/evidence tables exist; only the protected payment-transition role may execute it, and it derives every posting input from the locked operation and evidence.
- Support full and partial single capture; release the uncaptured authorization remainder.
- Apply refunds atomically, computing the incremental proportional fee reversal **inside the confirming transaction** from confirmed cumulative refunds and the capture's immutable `F` and `G`, then writing it to the operation's `fee_effect_amount_minor` and passing it to the ledger function.
- Release the refund reservation on every terminal outcome: success converts it to confirmed `refunded` in the same statement sequence so `refunded + reserved` never rises mid-transition; rejection and definitive failure return it to available and leave the fee effect null.
- Prevent confirmed plus reserved refunds from exceeding captured value.
- Turn on the invariant checker's reservation-integrity, posting-cardinality, and duplicate-effect classes now that their subject tables are populated.
- Resolve rejections and definitive failures without ledger effects.
- Make duplicate/late evidence idempotent and contradictory evidence create a discrepancy instead of overwriting history.
- Add end-to-end polling helpers and a local demo CLI.

### Test and acceptance criteria

- Create → authorize → full capture produces the exact journal and balances once.
- A declined authorization and a conclusively no-effect failed authorization may be retried with new operations/keys up to the three-attempt ceiling; ambiguous/review states remain blocking.
- Partial capture releases the remainder and cannot be captured again.
- Create → authorize → cancel produces no journal transaction.
- Partial refunds followed by full cumulative refund reverse exactly the captured principal and fee.
- Confirming the same refund set in different orders reverses the same total fee; any single allocation differs by at most one minor unit.
- Two refunds racing for the final refundable amount cannot over-refund, and the loser fails on the monetary guard.
- Several concurrent refunds that all fit confirm independently; the reserved total drains to zero and confirmed refunds equal their sum.
- A rejected or failed refund releases its reservation, leaves `fee_effect_amount_minor` null, and returns the amount to refundable.
- An `UNKNOWN` refund keeps its reservation across process restarts while later refunds against the remaining amount still succeed.
- Direct response duplicated 100 times produces one terminal transition and one journal transaction.
- `flowledger verify` reports zero findings after every scenario in this milestone.
- Each distinct newly deduplicated contradictory evidence row increments payment version and emits exactly one discrepancy event without rewriting the terminal operation; duplicate or corroborating evidence changes neither payment nor operation version.
- Post-scenario balance rebuild matches the projection exactly.

## M8 — Ambiguous outcomes and reconciliation

### Features and tasks

- Implement processing leases, worker fencing, stale `REQUESTED` and stale `PROCESSING` sweepers.
- Move possible-dispatch crashes and ambiguous adapter results to `UNKNOWN`; never create a replacement operation.
- Write reconciliation-required events and commands in the same transition transaction.
- Implement reconciliation cases, scheduling/backoff, activity history, provider lookup by operation ID or idempotency key, and evidence staging.
- Apply verified lookup evidence through the same transition/ledger path used by direct responses.
- Move exhausted automated lookups to `REQUIRES_REVIEW` without releasing the payment.
- On authorization success, create the durable `AUTHORIZATION_EXPIRY` case and schedule its first authoritative status lookup from the provider expiry hint or immutable account policy.
- Implement the separate `ACTIVE`/`EXPIRED`/`INCONCLUSIVE` authorization lookup: reschedule active/inconclusive cases, and apply only explicit signed/authoritative expiry evidence through the guarded payment transition.
- Apply expiry only while the payment remains authorized with zero captured/refunded/voided totals, a null exclusive pointer, and zero unresolved refunds; set `EXPIRED`, void the authorization, close the case, increment payment version, and emit `payment.authorization.expired.v1` without mutating the terminal authorization operation.
- Implement evidence attachment and audited operator escalation; do not implement arbitrary state-edit endpoints.
- Add disaster-recovery fencing epoch and restored-window reconciliation tooling.

### Test and acceptance criteria

- Kill the worker before dispatch: the same operation is safely reclaimed.
- Kill after dispatch marker or during possible provider receipt: the operation becomes `UNKNOWN` and no blind write retry occurs.
- An adapter advertising `SAME_KEY_REPLAY` still cannot move an `UNKNOWN` or `REQUIRES_REVIEW` operation back to execution in the MVP; only proof-bearing `RETRYABLE_NO_EFFECT` can reschedule the existing operation.
- Timeout → lookup confirms success posts exactly once.
- Timeout → conclusive no-effect proof resolves failure with no ledger posting.
- Inconclusive lookup exhausts policy and becomes visible `REQUIRES_REVIEW` while conflicting commands stay blocked.
- Direct response and reconciliation evidence races converge on one transition/effect; the equivalent real webhook race is added in M9.
- Authorization lookup `ACTIVE` reschedules without changing payment version; `INCONCLUSIVE` backs off/escalates; only explicit `EXPIRED` evidence changes the payment.
- Expiry raced against capture/cancellation acceptance serializes on the payment lock: exactly one ordering wins, duplicate expiry is a no-op, and the expiry case is dismissed atomically after a successful capture or cancellation.
- Restaging/reapplying the same evidence is idempotent.
- Recovery sweeps meet the timing objectives in the failure contract under local chaos tests.

## M9 — Provider and merchant webhooks

### Features and tasks

- Implement opaque provider webhook endpoint keys, body-size bounds, raw-body signature verification, timestamp/replay policy, endpoint/account allowlists, and fast durable receipt.
- Deduplicate provider notifications by `(webhook_endpoint_id, provider_event_id)`.
- Correlate tenant/account only after verification using immutable provider references; quarantine valid uncorrelated notifications.
- Process notifications asynchronously into normalized evidence and the common resolution path.
- Implement merchant webhook endpoint seeds/configuration, event projection allowlist, payload signing, immutable delivery snapshots, retries, leases, and delivery attempts.
- Enforce HTTPS outside local tests, refuse redirects, reject loopback/private/link-local/metadata destinations, bound request and response bodies to 64 KiB, and enforce the 10-second connection/response deadline.
- Implement the exact delivery classification: `2xx` succeeds; network/timeout, `408`, `425`, `429`, and `5xx` retry; every other `3xx`/`4xx` is terminal. Honor valid `Retry-After` only up to one hour.
- Implement terminal delivery states, replay controls, per-endpoint ordering key, and endpoint-level circuit/fairness controls.
- Implement DLQ records and replay history without allowing replay to change financial truth directly.

### Test and acceptance criteria

- Tampered, expired, oversized, and unknown-endpoint provider webhooks fail before durable domain effects.
- Crash before receipt insert permits provider retry; crash after insert returns/retries to the same unique receipt.
- One provider event delivered 100 times applies once.
- Valid uncorrelated events remain quarantined and never invent a merchant/payment.
- Out-of-order success/rejection/expiry evidence follows the state-machine rules.
- Merchant deliveries have stable payload/signature inputs, bounded retries, and one delivery record per endpoint/event.
- Signature golden vectors prove the exact timestamp/delivery-ID/raw-body HMAC input, constant-time verification expectations, stable body/delivery ID across retries, and snapshotted secret-version behavior across rotation.
- Outbound URL/DNS tests prove HTTPS, no redirects, SSRF address rejection, byte bounds, deadline enforcement, and exact retry/terminal classification.
- Direct response, verified provider webhook, and reconciliation races converge on one transition/effect; expiry webhooks obey the same guarded expiry path.
- Duplicate projection/dispatch produces no duplicate delivery identity, while intentional HTTP retries remain visible as attempts.
- DLQ replay against every operation state is safe and audited.

## M10 — Ledger settlement and operational recovery

This milestone replaces the Stripe test-mode adapter that previously sat here. The reasoning is in [ADR-0011](adr/0011-simulated-providers-only-in-mvp.md) and [ADR-0012](adr/0012-ledger-only-settlement.md): a real sandbox adapter is HTTP plumbing that cannot be load tested and cannot produce the ambiguity this project handles, while settlement is pure local logic that exercises the ledger — batching, membership proof, holding positions — which is where double entry stops being decorative.

### Features and tasks

- Implement the `settlement` schema: runs with their claim/lease/outcome lifecycle, immutable batches, and immutable batch membership.
- Implement the protected `settlement.post_batch(run_id, outbox_envelope)` entry point. Selection, membership insertion, the clearing-to-payable posting, the run outcome, and the batch event share one transaction.
- Implement eligibility as an anti-join against batch membership with a database-read cutoff, so the journal stays insert-only and no mutable settled flag exists.
- Implement the deferral path: a run whose net is at or below zero posts nothing, fixes no membership, and leaves every movement eligible.
- Implement the settlement scheduler and the stale-run sweeper with `SKIP LOCKED` claims and bounded batches.
- Add `settlement.batch.posted.v1` to the schema registry and the event catalog, with its `settlement_batch` aggregate identity and merchant ordering key.
- Add the `SETTLEMENT` operation type to the ledger posting recipes and the ledger event schema.
- Add the `SETTLEMENT` entry kind to the payment timeline.
- Turn on the invariant checker's settlement-membership class.
- Execute every recovery runbook against the fake and unreliable providers, including the new stalled/deferring settlement runbook.
- Add safe commands for republishing an outbox envelope, rescheduling reconciliation, replaying a nonfinancial message, triggering a settlement run, and inspecting evidence.
- Require named operator identity and dual approval for compensating ledger corrections.

### Test and acceptance criteria

- A batch amount always equals the recomputed net of its members' merchant-clearing journal entries; a seeded mismatch is caught.
- No movement appears in two batches under any interleaving of runs and payment confirmations; concurrent runs for one merchant yield at most one batch.
- A run with a zero or negative net posts nothing, settles nothing, and records `DEFERRED`.
- A refund confirmed after its capture settled drives merchant clearing negative, defers subsequent runs, and never mutates the closed batch or reduces merchant payable.
- Batch and membership rows reject `UPDATE`, `DELETE`, and `TRUNCATE` for every runtime role.
- Crashing at every point in the settlement transaction leaves no batch, membership, posting, or settled marker; an abandoned `CLAIMED` run is reclaimed and restarts selection cleanly.
- Merchant payable is non-decreasing, and clearing plus payable equals the net of all confirmed movements after randomized capture/refund/settlement traffic.
- Settlement never locks a payment row and never issues a provider call.
- Test logs, traces, messages, and evidence contain no credential, payment method token, PAN-like fixture, or raw provider payload.
- Each runbook has a reproducible setup, expected queries/metrics, safe action, and exit check.
- `flowledger verify` reports zero findings across every assertion class, which is now the complete set.

## M11 — Security, observability, and operator visibility

This milestone was cut down deliberately. Retention archival jobs and the full dual-approval operator tooling were removed from the MVP: they are roughly a week of work that produces no portfolio evidence and no demonstrable property, and the contracts already specify them for a later release. Stating that limit is a better signal than building it.

What remains is everything that is either a security boundary or the evidence that the system behaves as claimed.

### Features and tasks

- Write the focused threat model covering tenant escape, credential theft, webhook forgery/replay, provider ambiguity, message tampering, unsafe operator actions, and sensitive-data leakage.
- Propagate request, correlation, causation, envelope, payment, and operation identifiers through structured logs and traces without using them as unbounded metric labels.
- Implement every minimum metric in the recovery contract and dashboards for API, PostgreSQL, outbox, subscriptions, workers, providers, ledger buckets, refund reservations, settlement, and reconciliation.
- Configure warning/critical alerts using the contracted thresholds.
- Implement read-only operator views over the timeline surface plus attempts, evidence, journal postings and bucket balances, outbox/inbox records, webhooks, settlement runs/batches, and reconciliation cases.
- Keep cross-tenant operator access on a separate authenticated surface or CLI; require a named principal and an MFA-authenticated identity claim, and never accept merchant credentials or tenant override headers.
- Record every privileged operator command with actor, reason, evidence references, before/after state identifiers and versions, database time, correlation ID, and resulting event IDs, in an append-only audit table.
- Add dependency, container, IaC, and secret scans.

### Deliberately deferred from the MVP

These remain specified in the data model and recovery contracts, and are listed in the known-limits document rather than implemented:

- Clock-driven copy-verify-tombstone archival for published outbox bodies, provider attempt and notification hot detail, successful merchant-webhook attempt bodies, resolved DLQ payloads, and expired API replay bodies. The MVP retains everything online; nothing is deleted, so no archival correctness risk exists.
- Raw-quarantine object deletion by deadline. The MVP does not create raw quarantine objects at all, which removes the need rather than deferring the risk.
- Second-approver enforcement for compensating ledger corrections. The correction request table, its approver column, and its distinct-principal check exist; the operator workflow that drives them is single-principal in the MVP and the limitation is documented.

### Test and acceptance criteria

- Automated cross-tenant tests cover API, RLS, protected functions, background roles, operator views, settlement views, and webhook correlation.
- Representative secrets and prohibited payment data are detected by negative tests and absent from captured telemetry.
- One end-to-end trace links HTTP acceptance, outbox publication, worker execution, provider evidence, ledger posting, settlement, and merchant delivery.
- Dashboards show queue age, processing leases, unknown/review age, ledger conflicts, per-bucket lock wait, projection mismatches, reserved refund totals, unsettled movement age, and the duplicate-effect count.
- Alerts fire in a controlled fault injection and link to the correct runbook.
- Operator actions are authenticated, authorized, immutable in audit history, and unable to mutate journal, payment, or settlement tables directly.
- The known-limits document lists every deferred item above, and a reviewer can map each one to the contract section that specifies it.

## M12 — Local performance and chaos readiness

### Features and tasks

- Implement k6 open-arrival workloads for uniform acceptance, duplicate storm, hot merchant/payment, refund fan-out, settlement under live traffic, provider degradation, crash/redelivery, and soak.
- Implement the ledger contention comparison as a controlled pair: the same confirmed capture/refund workload at bucket count 1 and at the seeded bucket count, identical in every other respect, reporting per-logical-account lock wait for both.
- Add deterministic process-kill and fault-injection hooks at every named crash point, disabled outside test environments.
- Instrument PostgreSQL commit/lock/pool/WAL/IO metrics, per-bucket balance lock wait, and application queue/provider timings.
- Model the future Cloud Run/Cloud SQL connection budget and enforce equivalent bounded local pools.
- Tune indexes, query shapes, batch sizes, relay claims, worker concurrency, Fastify/Nest overhead, and telemetry sampling using profiles rather than guesses.
- Preserve raw local results, configuration, commit SHA, dashboards, and post-run correctness audit.
- Run at least three local preflight trials and use them to remove obvious bottlenecks before provisioning the reference environment.

### Preflight targets

The local harness attempts the same numerical targets so bottlenecks are visible early, but local results are labeled by their actual environment and are not accepted as the résumé/reference claim. The performance-ready gate occurs in M13 after the contracted GCP environment exists.

For durable command acceptance, the initial target is:

```text
accepted rate                 >= 1,000 commands/second for 10 minutes
p50                           < 40 ms
p95                           < 100 ms
p99                           < 250 ms
unexpected HTTP error rate    < 0.1%
dropped generator work        0
duplicate business effects    0
```

For confirmed fake-provider capture/refund processing:

```text
confirmed rate                >= 500 operations/second
p95 internal completion       < 250 ms
duplicate journal postings    0
ledger invariant failures     0
```

For messaging at 1,000 accepted commands/second:

```text
outbox publish rate           >= 2,000 envelopes/second
p95 unpublished outbox age    < 2 seconds
p95 ordinary event lag        < 3 seconds
lost committed envelopes      0
duplicate local effects       0
```

### Test and acceptance criteria

- Every workload uses an open arrival model, reports offered/accepted/completed rates, and keeps response validation enabled.
- `flowledger verify` runs during and after every load workload and reports per-class counts. Any nonzero finding invalidates the run.
- The contention comparison produces both runs from the same commit and configuration, differing only in bucket count, with lock-wait distributions for each. A result showing no improvement is recorded with its limiting factor rather than retried until it looks better.
- Refund fan-out proves accepted refunds never exceed refundable value under contention, every rejection comes from the locked monetary guard, and fee reversals sum exactly to the captured fee on full refund.
- Settlement under live traffic proves no movement settles twice, payable is non-decreasing, and clearing plus payable equals the net of confirmed movements at the end.
- Duplicate financial effects, unbalanced journal transactions, bucket-sum mismatch, reservation drift, double-settled movements, projection mismatch, dropped generator work, or prohibited-data leakage immediately invalidate the run.
- A local soak at 75% of demonstrated local capacity shows no unbounded memory, connection, outbox, inbox, or reconciliation growth.
- If preflight targets are missed, record the bottleneck and tuning evidence before M13; do not convert a local target into a résumé claim.

## M13 — GCP deployment, reference benchmark, and portfolio evidence

### Features and tasks

- Use Terraform to create Cloud Run services/jobs, regional/high-availability Cloud SQL for PostgreSQL with synchronous standby/automatic failover, Pub/Sub topics/subscriptions/DLQs, Secret Manager entries, retention archive/quarantine storage, service accounts, networking, artifact storage, dashboards, and alert policies.
- Give every process a distinct least-privilege service account and database role.
- Configure minimum/maximum instances, request/worker concurrency, timeouts, leases, and the global database connection budget.
- Implement automated migration as an explicit deployment step, not application startup side effect.
- Add backup/PITR configuration and perform one restoration rehearsal with provider writes fenced.
- Perform a planned Cloud SQL failover while acceptance/workers are active; clients must reconnect within the measured recovery window, bounded retries must preserve operation/envelope identities, and no committed financial effect may be lost or duplicated.
- Run the full reference-environment workload matrix only after Cloud Run, Cloud SQL, Pub/Sub, telemetry, autoscaling bounds, and the global connection budget are deployed and verified.
- Run at least three measured trials per headline workload plus the 60-minute soak; retain raw output, infrastructure revision, dashboards, and the post-run correctness audit.
- Run the ledger contention comparison in the reference environment and publish both results with their lock-wait evidence and the next identified bottleneck.
- Create architecture diagrams, an evidence index, benchmark report, known-limits document, failure-demo script, and concise setup instructions.
- Record a deterministic demo using the unreliable provider: an idempotent capture repeated, a provider timeout converging through reconciliation to exactly one posting, concurrent refunds bounded by the reservation guard, and a settlement batch closing over the result. The whole demo runs offline from a clean clone.

### Test and acceptance criteria

- A new environment can be created from Terraform and the documented bootstrap process without manual resource mutation.
- Service accounts cannot access another process's secrets or unnecessary topics/tables.
- Deployment health checks, graceful shutdown, Pub/Sub acknowledgement deadlines, and Cloud SQL connection limits behave under scale-up/down.
- Backup restore meets the project RPO/RTO target in the rehearsal or the measured miss is documented.
- Terraform and runtime inspection prove regional HA is enabled; the planned failover produces measured recovery evidence and all post-failover payment, outbox, journal, and balance audits remain exact.
- The M12 numerical targets pass in the contracted reference environment, or the final report states the measured result and bottleneck without presenting the target as achieved.
- The contention comparison is published as a measured ratio with both runs' lock-wait distributions. Its value does not depend on hitting an absolute target; a negative result is published as-is.
- Correctness remains green during and after the reference trials: `flowledger verify` reports zero findings in every class, and dropped generator work is zero.
- The final evidence index links every résumé claim to a raw result, test, dashboard, or reproducible command.
- The public repository contains only synthetic credentials/data and can be run locally without paid cloud services.

## Feature acceptance matrix

| Feature | Happy path | Duplicate/retry | Concurrency | Failure/recovery | Security/isolation | Performance evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Payment creation | `201` + event | Exact response replay | One owner/payment | Pre-commit rollback | Merchant scope, token encryption | Included in API acceptance |
| Authorize | Confirmed state | Stable operation/provider keys | One unresolved exclusive operation | Timeout → lookup/review | No token in durable telemetry | Worker throughput/latency |
| Capture | Totals + balanced journal | One terminal/posting effect | One successful capture | Ambiguity → same operation | Protected posting only; policy minimum enforced | Confirmed-op target |
| Cancel | Authorization released | One effect | Blocks every command while unresolved | Safe no-effect resolution | Tenant/provider binding | Worker metrics |
| Refund | Principal + proportional fee reversal computed at confirmation | One journal per refund op | Many concurrent; bounded by `refunded + reserved <= captured` under the payment lock | Ambiguity holds only its reservation; others proceed | Protected balance policy; reservation row check | Refund fan-out profile |
| Settlement | Balanced clearing-to-payable batch | Posting-key replay; one batch per movement | One in-flight run per merchant/currency | Crash leaves no partial batch; negative net defers | Immutable membership; settlement role isolated | Settlement throughput |
| Outbox/inbox | Event reaches consumer | Stable envelope dedupe | `SKIP LOCKED` claims | Publish/consumer crash replay | Strict schema/redaction | 2,000 envelopes/sec target |
| Provider webhook | Verified evidence applies | Endpoint/event dedupe | Races converge | Uncorrelated quarantine | Signature/replay/account allowlist | Ingress and processing age |
| Reconciliation | Lookup resolves original op | Evidence dedupe | Case lease/fencing | Review after exhaustion | Audited operator actions | Recovery distribution |
| Authorization expiry | Explicit provider expiry | Evidence/case dedupe | Races with capture/cancel | Active/inconclusive reschedule; capture/cancel dismiss | Signed/authoritative evidence only | Expiry-case age/distribution |
| Merchant webhook | Signed notification delivered | Delivery identity + attempts | Endpoint ordering/fairness | Retry/DLQ/replay | Payload allowlist/secret rotation | Backlog/delivery lag |
| Ledger | Balanced immutable posting | Posting-key replay reaches the same bucket | Canonical balance locks; striped platform buckets | Rebuild/reversal/correction | DML revoked/RLS views | Striped-versus-single-row comparison |

## CI and verification lanes

### Every pull request

- Formatting, lint, strict typecheck, dependency-policy check.
- OpenAPI/JSON-Schema parse, reference, registry, and generated-type drift checks.
- Unit and property tests with fixed regression seeds.
- Changed-package tests and prohibited-data scan.
- Migration lint and an empty-database migration when migrations change.

Target duration: under 10 minutes.

### Required before merge for database/domain changes

- PostgreSQL integration suite against a real supported version.
- Runtime-role permission and cross-tenant tests.
- Concurrent idempotency/posting/refund tests.
- Forward migration from the previous populated fixture.

Target duration: under 25 minutes, parallelized by suite.

### Nightly or scheduled

- Full end-to-end matrix with fake and unreliable providers.
- Messaging emulator/redelivery tests.
- Deterministic crash-point suite.
- Settlement under live capture/refund traffic.
- `flowledger verify` against a database populated by the full end-to-end matrix.
- Dependency/container/IaC scans.
- Fifteen-minute regression load test.

### Release/evidence run

- Full reference-environment benchmark with three trials.
- Sixty-minute soak and chaos workload.
- Balance rebuild, duplicate-effect audit, and provider/internal reconciliation.
- Backup/restore rehearsal when infrastructure changes materially.
- Immutable evidence bundle retained with commit and infrastructure revision.

## Pull-request sequence

Keep changes reviewable by using approximately this sequence:

1. Workspace and contract validation.
2. Money/ID/domain types and property tests.
3. Initial roles/schemas/identity/provider migrations.
4. Payment/idempotency migrations, exclusion indexes, refund reservation fields and their deferred trigger, and concurrency tests.
5. Outbox/inbox/DLQ persistence, replay history, and protected outbox insertion.
6. Ledger tables, striped account model and seed, bucket derivation, private canonical posting primitive, correction wrapper, and invariant tests.
7. `flowledger verify` with every assertion class and its deliberately corrupted fixtures.
8. Auth and create/query payment API.
9. Payment timeline endpoint.
10. Command acceptance with the exclusion model and reservation guard, plus atomic outbox insertion.
11. Relay/transport/inbox consumer and DLQ-routing core.
12. Deterministic fake plus unreliable simulator and shared adapter conformance.
13. Provider attempt/notification/evidence persistence, worker claim, proven-no-effect retry scheduler, and authorize path.
14. Evidence-bound payment-posting wrapper plus capture/ledger path.
15. Cancellation and concurrent refund path with fee reversal computed at confirmation.
16. Ambiguity, reconciliation evidence/cases, and authorization-expiry workflow.
17. Provider webhook receiver/worker and real three-source race tests.
18. Merchant webhook projector/dispatcher and outbound-security tests.
19. Settlement schema, protected batch posting, scheduler/sweeper, and settlement invariants.
20. Telemetry, dashboards, alerts, security gates, operator views, and the known-limits document.
21. Local chaos/load harness, refund fan-out and settlement profiles, the ledger contention comparison, and tuning.
22. Terraform/HA GCP deployment, failover drill, reference benchmark, and evidence package.

Do not combine a foundational migration, provider adapter, and API feature into one large change. The database and contract review surface becomes too broad to verify safely.

## Effective AI-agent workflow

AI agents can accelerate this plan when they work against narrow contracts and independently verifiable outputs.

### Roles per slice

- **Implementer:** owns one small feature and its tests.
- **Contract reviewer:** compares the implementation with the exact normative sections and reports mismatches without editing.
- **Database/concurrency reviewer:** inspects SQL, lock order, uniqueness, RLS, and crash boundaries.
- **Adversarial tester:** adds duplicate, race, malformed-input, failure-injection, and tenant-escape tests.

One agent may fill several roles sequentially, but the implementation and adversarial review should not share the same uninterrupted context.

### Agent task format

Every task should include:

1. Exact contract sections and machine schemas in scope.
2. Files/directories the agent may change.
3. Business invariant being implemented.
4. Required positive, negative, duplicate, concurrent, and crash tests.
5. Commands that must pass.
6. Explicit non-goals.

Example:

```text
Implement capture command acceptance only. Follow sections X/Y and schema Z.
Do not call a provider or post a ledger transaction. The commit must contain
idempotency ownership, one CAPTURE operation, active pointer/version update,
requested event, execute command, and replay response. Add 100-request duplicate
and two-client version-race tests. Stop if SQL cannot enforce one unresolved exclusive operation.
```

### Parallelization rules

Safe parallel work:

- An adapter implementation and an independent contract-test harness after the interface is frozen.
- A read-only dashboard and metrics definitions after canonical field names exist.
- Load-test scripts and seed-data tools after endpoint/message contracts are stable.
- Documentation/runbook validation alongside implementation.

Serialize or assign one owner:

- Shared domain state types.
- Migration sequence and protected database functions.
- OpenAPI and event schemas.
- Payment transition/evidence application logic.
- Global error and redaction policies.

### Merge gate

Before accepting agent-generated code:

- Read the complete diff, especially SQL and transaction boundaries.
- Run tests rather than trusting generated explanations.
- Verify no direct payment/journal writes bypass protected functions.
- Inspect error paths for accidental success/failure classification.
- Force at least one duplicate, concurrent, and crash case.
- Ask a separate reviewer to explain the linearization point and uniqueness boundary from the code.

AI output is a draft until the repository proves it.

## Risk register

| Risk | Early warning | Mitigation |
| --- | --- | --- |
| SQL design becomes ORM-driven | Missing explicit locks/constraints in reviews | Use explicit SQL and database integration tests from M2 onward |
| Happy path crowds out recovery | `UNKNOWN` and crash tests postponed | M8 is a release gate; add fault hooks while implementing M6/M7 |
| Node event loop stalls | Rising p99 with low CPU/DB utilization | Profile serialization/crypto/logging; bound work; move only proven CPU hotspots |
| Cloud Run exhausts Cloud SQL | Pool waits/connections grow during autoscaling | Enforce global connection budget and max instances before load tests |
| Provider simulator is unrealistic | Tests cannot reproduce partial/ambiguous failures | Make fault distribution configurable and preserve deterministic seeds |
| Provider semantics leak into domain | Provider SDK types appear in payment/ledger packages | Normalize strictly at the adapter boundary and run the common conformance suite against both fakes |
| Striping is treated as optional and retrofitted | Capture/refund built against single platform rows | Striping lands in M3 with the account model, so there is no single-row code path to migrate from |
| The invariant checker is written to match the implementation | Checker added after a feature, asserting current behavior | Build it in M3 from the contracts, and prove each class catches a deliberately corrupted fixture |
| Refund reservation drifts from its operation rows | Reservation updated outside the protected function | Deferred constraint trigger recomputes it at commit; a drift is a commit failure, not a repair job |
| Settlement mutates closed financial history | A late refund nets into an existing batch | Membership is immutable and a negative net defers; both are enforced and tested |
| Duplicate protection exists at only one layer | Inbox dedupe hides missing domain uniqueness | Test API, operation, provider, evidence, and ledger boundaries independently |
| Benchmarks become résumé theater | Missing raw artifacts or post-run audit | Evidence bundle and correctness audit are mandatory for every claim |
| AI creates broad inconsistent changes | Large diffs touch contracts, SQL, and apps together | Narrow tasks, single owners for shared surfaces, independent review agents |
| Scope expands into payouts/FX/chargebacks | New states appear without contracts | Enforce MVP exclusions and track later ideas separately |

## Demo and portfolio acceptance

The final five-to-eight-minute technical demo should show:

1. A provider timeout where the operation becomes `UNKNOWN`, remains financially unposted, and later resolves from verified lookup evidence — shown through one `GET /v1/payments/{id}/timeline` call, before and after. This leads because it is the claim no other portfolio project makes: ambiguity is a first-class state and the system never guesses whether money moved.
2. An idempotent payment/capture request sent repeatedly, resulting in one operation and one journal posting.
3. Concurrent refunds racing the last refundable amount: the ones that fit are accepted, the one that does not is rejected by the monetary guard, and the fee reversals sum exactly to the captured fee.
4. `flowledger verify` printing zero findings across every assertion class, including the cross-system duplicate-effect detector.
5. Duplicate and out-of-order webhook delivery converging without duplicate effects.
6. A settlement batch closing over the confirmed movements, and a late refund landing in the next batch instead of mutating the closed one.
7. The ledger contention comparison: the same workload at one platform row versus the striped bucket set, with the lock-wait collapse beside it.
8. A dashboard showing throughput, p95/p99 latency, outbox age, unknown-operation age, per-bucket lock wait, and duplicate-financial-effect count of zero.
9. A benchmark report with environment, offered/accepted/completed rates, raw artifacts, bottleneck, and post-run audit.

The entire demo runs offline from a clean clone, with no credentials and no cloud account, because the providers are simulated ([ADR-0011](adr/0011-simulated-providers-only-in-mvp.md)). A reviewer can reproduce it rather than watch it.

Portfolio-complete means all of the following are true:

- The public setup path works from a clean clone, with no credentials and no cloud account, including the full demo.
- Every contract quality gate has linked test evidence.
- All financial tables pass immutability and reconstruction audits, and `flowledger verify` reports zero findings in every assertion class.
- Failure-injection scenarios converge or stop in explicit review; none invent an outcome.
- Measured results, not targets, are used in résumé language.
- Every contestable design decision has an ADR naming the alternatives that were rejected and why.
- A known-limits document states what was deliberately not built, so a reviewer learns the boundaries from the repository rather than by finding a gap.
- Architecture, tradeoffs, known limits, and the next scaling boundary can be explained from the code and evidence.

## Explicit non-goals for implementation

Do not add these while executing this plan:

- Multiple captures, external payouts, bank settlement, chargebacks, subscriptions, FX, marketplace splits, or production card processing. Internal ledger settlement is in scope; moving value out of the system is not.
- A real-provider adapter. The interface and conformance suite are built for one; the implementation is deliberately deferred.
- Draining merchant payable, or any simulated bank file or payout API.
- GraphQL before the REST and asynchronous contracts pass their gates.
- Kafka, Kubernetes, event sourcing, or service-per-module decomposition without measured need.
- A custom operator mutation UI that bypasses the evidence/approval model.
- Retention archival jobs and raw-quarantine deletion workflows, which are specified but deferred and recorded in the known-limits document.
- Multi-region writes or claims of PCI/regulatory compliance.

Ideas outside the MVP go into a separate backlog and do not change this plan's critical path.
