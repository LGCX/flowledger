# Test and performance plan

Status: **Draft**  
Last updated: 2026-11-05

## Purpose

This contract defines the evidence required to claim that FlowLedger is correct, recoverable, and performant. A benchmark result is invalid if accounting invariants fail, duplicate financial effects occur, load generation drops work silently, or the environment is not recorded.

## Quality gates

Implementation milestones use these gates:

| Gate | Required evidence |
| --- | --- |
| Domain-ready | Money, fee, state-machine, and idempotency unit/property tests pass |
| Persistence-ready | Real-PostgreSQL integration tests prove constraints, transactions, immutability, locks, and migration behavior |
| Ledger-ready | Posting, striping, reservation, and settlement invariants pass, and `flowledger verify` reports zero findings in every assertion class |
| Provider-ready | Every adapter passes the provider contract suite; the unreliable fake exercises each normalized outcome |
| Messaging-ready | Outbox/inbox tests prove safe duplicate publication, redelivery, ordering gaps, and poison-message handling |
| End-to-end-ready | Authorization, capture, cancellation, refund, webhook, ambiguity, and reconciliation scenarios pass |
| Performance-ready | Correctness gates remain green under the defined load, chaos, hot-key, and soak workloads |

No performance result may waive a correctness gate.

## Continuous invariant checker

Every correctness claim in this repository is asserted by one runnable command, `flowledger verify`, rather than by prose. It exists from the first milestone that has a ledger, runs in CI, runs during and after every load and chaos workload, and is the source of the correctness metrics in the recovery contract.

It is built early deliberately: an invariant checker written after the system is finished tends to assert what the implementation happens to do. Written first, it constrains the implementation.

The checker runs these classes of assertion against committed state:

| Class | Assertion |
| --- | --- |
| Journal balance | Every journal transaction's debits equal its credits, in one currency and one ledger |
| Projection equality | Every account balance rebuilt from immutable entries equals the synchronous projection |
| Bucket aggregation | Every striped logical account's bucket sum equals its rebuild from entries and its logical-balance view |
| Payment totals | Every payment's confirmed totals equal the sum over its succeeded operations, and every state-dependent invariant holds |
| Reservation integrity | Every payment's `reserved_refund_amount_minor` and `unresolved_refund_count` equal the sum and count over its unresolved refund rows |
| Posting cardinality | Every succeeded capture/refund operation has exactly one journal transaction, and none exists for a nonterminal or nonsuccessful operation |
| Orphan detection | No nonterminal operation lacks a recovery owner across outbox, queue, DLQ, and reconciliation cases |
| Settlement membership | Every movement belongs to at most one batch; every batch amount equals the recomputed net of its members' entries |
| Duplicate financial effects | The cross-system comparison defined below |

Any nonzero finding fails the run. The checker reports counts per class so a benchmark report can state exactly what was verified.

### Defining `duplicate_financial_effects_total`

This is the headline correctness claim, so its measurement is specified rather than implied.

It MUST NOT be computed as "journal transactions sharing a `payment_operation_id`." A unique index already makes that impossible, so such a metric reads zero by construction and proves nothing. A metric that cannot be nonzero is not evidence.

The detector is a cross-system comparison against the deterministic fake provider's ground truth, which is exposed only to test harnesses. For every payment operation reached during the run, let:

```text
P = count of provider-side financial effects recorded by the fake provider
    under this operation's stable provider idempotency key
L = count of journal transactions whose posting key derives from this operation
S = the operation's final FlowLedger status
```

The operation contributes to the count when any of these hold:

| Condition | Meaning |
| --- | --- |
| `P > 1` | The provider applied the effect more than once; a blind retry or a substituted key escaped |
| `L > 1` | The ledger posted the same operation twice |
| `P = 1` and `L = 0` and `S = SUCCEEDED` | FlowLedger confirmed success without posting |
| `P = 0` and `L = 1` | FlowLedger posted a journal transaction for an effect the provider never applied |
| `P = 1` and `S` in (`REJECTED`, `FAILED`) | FlowLedger recorded a definitive no-effect outcome for an effect that did occur |
| `P = 0` and `S = SUCCEEDED` | FlowLedger confirmed success the provider never performed |

The required value is zero in every run.

Two cases are deliberately excluded, because they are correct behavior rather than duplication: an operation left `UNKNOWN` or `REQUIRES_REVIEW` with `P = 1` and `L = 0` is an unresolved ambiguity, which the system is designed to produce and report; and `P = 0` with `L = 0` for a rejected operation is an ordinary decline. Both are counted separately as unresolved-ambiguity gauges so they cannot be confused with a correctness failure or hide one.

Because this detector depends on provider ground truth, it runs against the fake and unreliable adapters only. Any future real adapter would need a reconciliation-based approximation, and that limitation would be stated in the report rather than papered over.

## Test layers

### Static checks

- TypeScript strict mode with no unchecked money conversions.
- Lint rules forbid JavaScript `number` in money-domain types and direct journal-table writes outside the ledger repository.
- OpenAPI parses, every local reference resolves, all component and checked-in prose examples validate, and response status/problem-code/header rules pass explicit contract probes.
- Every Draft 2020-12 JSON Schema compiles with UUID/date-time format assertion enabled; all local references resolve.
- The registry manifest validates, every `(kind,type)` mapping is unique and resolvable, and the docs catalog has exact type parity with the registry.
- Every registered message type has positive and high-risk negative fixtures, including amount bounds, ID prefixes, unknown fields, terminal evidence, and no-effect proof.
- Semantic checks cover envelope type/version correlation, aggregate/ordering identity, payload subject IDs, provider binding, and merchant webhook type/operation/outcome correlation where JSON Schema alone cannot express the cross-record rule.
- Event producers and consumers compile against generated schema types.
- Secrets and prohibited payment-data patterns are scanned from source, fixtures, logs, and representative messages.

### Unit tests

Unit tests cover deterministic, side-effect-free logic:

- Decimal-string parsing and `bigint` conversion.
- Amount range, currency, and precision validation.
- Fee calculation and proportional fee-refund allocation.
- Canonical API request hashing.
- Ledger posting-hash canonicalization.
- Provider error normalization.
- Retry classification and backoff calculations.
- Derived payment summary status.
- Event and webhook signature construction.

### Property and model-based tests

Generated tests MUST check properties rather than only examples.

#### Payment lifecycle

- Generate valid command/result sequences and preserve every monetary and state-dependent invariant after each transition.
- Generate invalid sequences and prove they create no provider attempt, journal transaction, or confirmed monetary change.
- Confirm that one unresolved operation blocks every conflicting operation.
- Confirm that terminal, duplicate, late, and contradictory provider evidence follows the lifecycle contract.
- Confirm that cumulative confirmed refunds never exceed captured value.

#### Ledger

- Generate random balanced postings and prove total debits equal total credits.
- Rebuild all account balances from entries and match the synchronous balance projection exactly.
- Retry postings in randomized order and prove one posting per key.
- Generate full reversals and prove zero net movement per affected account.
- Generate concurrent protected-balance debits and prove the normal-side balance cannot become negative.
- Prove the bucket derived for a payment ID is stable across processes and runs, and that a retry under an existing posting key resolves to the same bucket.
- Prove a striped logical account's bucket sum equals its rebuild from entries for every bucket count under test, including `N = 1`.

#### Fee allocation

- For any capture and legal set of refunds, allocated fee reversals are non-negative and never exceed the captured fee.
- The sum of fee reversals after a full cumulative refund equals the original fee exactly, independent of the order in which refunds confirm.
- A single refund's allocation differs by at most one minor unit between two confirmation orderings of the same refund set. The total does not vary. Allocation is order-independent in aggregate and bounded-variance per refund — the earlier claim of full per-refund determinism does not hold once refunds may confirm concurrently, and the property asserts what is actually true.
- A rejected or definitively failed refund contributes no fee reversal and leaves the remaining allocation unchanged.
- No intermediate sequence of confirmed refunds reverses more than the captured fee.

#### Refund reservation

- For any interleaving of refund acceptances and resolutions, `refunded + reserved <= captured` holds at every commit.
- The reserved total always equals the sum of unresolved refund amounts, and the unresolved count always equals their number.
- Releasing a reservation on success raises `refunded` by exactly the amount it lowers `reserved`, so the sum never rises during a transition.
- An ambiguous refund's reservation is never released without verified evidence.

#### Settlement

- A posted batch's amount equals the net of its members' merchant-clearing entries, recomputed from immutable entries.
- No movement appears in two batches under any interleaving of settlement runs and payment confirmations.
- A run with a net at or below zero posts nothing and settles nothing.
- For any sequence of captures, refunds, and settlement runs, merchant payable is non-decreasing and clearing plus payable equals the net of all confirmed movements.

Use a reproducible random seed. A failing generated case MUST print and persist the minimal counterexample.

### PostgreSQL integration tests

Tests run against the supported PostgreSQL major version, not an in-memory substitute. They MUST prove:

- Every declared foreign key, unique constraint, partial unique index, and check constraint rejects an invalid direct write.
- The application role cannot update/delete journal transactions or entries or bypass the protected posting function.
- Payment command acceptance atomically commits idempotency, operation, active-operation pointer, version, requested event, and execution command.
- Capture/refund confirmation atomically commits the terminal transition, confirmed totals, journal posting, balances, and outbox events.
- A failure injected after each statement but before commit leaves no partial business effect.
- One hundred concurrent identical API commands produce one operation and one replayable result.
- One hundred concurrent identical ledger requests produce one journal transaction.
- Conflicting idempotency payloads produce a deterministic conflict.
- Two refunds racing for the final refundable amount cannot over-refund, and the losing request fails on the monetary guard rather than a uniqueness constraint.
- Refunds that collectively fit are all accepted concurrently; the reserved total and unresolved count stay consistent with the operation rows under every interleaving, enforced by the deferred constraint trigger.
- An exclusive command and a refund cannot both be unresolved for one payment.
- A direct attempt to desynchronize the reservation fields, or to set a refund's fee effect at acceptance, fails at the database boundary.
- A fee policy whose fixed component exceeds its declared minimum capture amount cannot be inserted, and a capture below that minimum is rejected before any row commits.
- Account locks are acquired in canonical order and safe retries survive deadlock/serialization errors, including when two postings contend on the same platform bucket.
- Every striped logical account has a contiguous, complete bucket set, and a posting retry resolves to the same bucket.
- Settlement: concurrent runs for one merchant produce at most one batch; batch and membership rows reject update and delete; a zero or negative net posts and settles nothing.
- The balance rebuild matches the projection after randomized committed traffic, including bucket aggregation across striped accounts.
- Migrations upgrade a populated previous schema and roll forward safely. Destructive rollback is not assumed.

### Provider contract tests

The same adapter suite runs against the deterministic fake and the seeded unreliable fake. No real-provider adapter ships in the MVP ([ADR-0011](adr/0011-simulated-providers-only-in-mvp.md)); the suite is written so a future adapter is plugged into it unchanged:

- Stable idempotency key on every retry.
- Confirmed success, definitive rejection, definitive no-effect failure, rate limiting, authentication failure, malformed response, timeout, and broken connection.
- Lookup by provider operation ID and by idempotency key where supported.
- Signed webhook verification, replay, duplicate event, out-of-order event, and contradictory evidence.
- Redaction of credentials and prohibited data.
- Capability mismatch fails before a provider write.

The fake provider simulates an explicitly configured latency and error distribution from a recorded seed, which is what makes the chaos and benchmark workloads reproducible. A real sandbox could not be asked to time out after committing, and could not participate in a high-volume load test at all.

### Messaging integration tests

- Publish one outbox envelope repeatedly with different Pub/Sub-generated message IDs; consumers deduplicate by stable envelope `id`.
- Crash the relay after broker publication but before marking the outbox row; prove safe republish.
- Crash a consumer before and after its database commit; prove correct replay.
- Deliver lifecycle events out of order and prove gap parking or rebuild.
- Deliver an unknown schema version and prove DLQ plus alert metadata.
- Redeliver execution commands for `REQUESTED`, actively leased `PROCESSING`, stale `PROCESSING`, `UNKNOWN`, `REQUIRES_REVIEW`, and terminal operations.
- Prove that DLQ placement never changes a financial outcome.

### End-to-end scenarios

At minimum, CI or a scheduled environment runs:

1. Create → authorize → full capture.
2. Create → authorize → partial capture with authorization remainder released, reporting `CAPTURED`.
3. Create → authorize → cancel.
4. Capture → one partial refund → full cumulative refund.
5. Capture → two concurrent partial refunds that both fit → both confirm → fee reversals sum exactly to the captured fee.
6. Capture → two concurrent refunds that collectively exceed the refundable amount → exactly one is accepted, rejected by the monetary guard rather than a uniqueness index.
7. Capture → refund left `UNKNOWN` → a further refund against the remaining available amount is still accepted.
8. Capture below the fee policy's minimum → `422 CAPTURE_BELOW_MINIMUM` with no durable effect.
9. Declined authorization followed by an allowed retry.
10. Duplicate API request before, during, and after operation completion.
11. Provider timeout → `UNKNOWN` → reconciliation confirms success → exactly one journal posting.
12. Provider timeout → reconciliation proves failure → no journal posting.
13. Automated reconciliation exhausted → `REQUIRES_REVIEW` → later verified evidence resolves the original operation.
14. Direct response and webhook race with the same outcome.
15. Direct response and webhook contradict; discrepancy is raised and history is not overwritten.
16. Capture → settlement run posts a batch → merchant payable reflects the net → batch membership is immutable.
17. Capture → settlement → refund confirms after the batch closed → clearing goes negative, the next run defers, the closed batch is unchanged.
18. Timeline retrieval after an ambiguous-then-reconciled capture shows the ambiguous attempt, the reconciliation evidence, exactly one ledger posting, and the settlement entry.
19. Worker, relay, settlement, and API process termination at every named crash point in the recovery contract.

## Performance claims and boundaries

FlowLedger reports separate metrics for separate boundaries. They MUST NOT be combined into an ambiguous "end-to-end payment latency."

### Durable command acceptance

Measured from receipt at the API container until the HTTP response is ready after PostgreSQL commit. It includes authentication, validation, idempotency, payment locking/version checks, operation creation, and two outbox rows. It excludes provider execution.

Initial résumé target:

```text
Sustained accepted rate:       >= 1,000 commands/second
p50 latency:                   < 40 ms
p95 latency:                   < 100 ms
p99 latency:                   < 250 ms
Unexpected HTTP error rate:    < 0.1%
Dropped load-generator work:   0
Duplicate business effects:    0
```

The 1,000-command rate is sustained for ten measured minutes after warm-up.

### Confirmed capture/refund processing

Measured from availability of the execution command to commit of terminal operation state, journal entries, balance updates, and outbox events, using the fake provider with 25 ms median and 100 ms p95 configured latency.

Initial engineering target:

```text
Sustained confirmed rate:      >= 500 operations/second
p95 internal completion:       < 250 ms
Duplicate journal postings:    0
Ledger invariant failures:     0
```

This result MUST report provider-simulation latency separately from database/queue time.

### Ledger contention: striped versus single-row platform accounts

This is the project's primary measured engineering result, so it is reported as a controlled comparison rather than a single number.

Every capture and refund debits a platform processor-receivable account and credits a platform fee-revenue account. With one balance row per logical account, those two rows are locked by every capture and refund in the deployment, which caps ledger throughput regardless of how the load is distributed across merchants and payments. Striping removes that cap ([ADR-0010](adr/0010-striped-clearing-accounts.md)).

The same confirmed capture/refund workload runs twice in the same environment, changing only the seeded bucket count:

| Run | Bucket count | Reported |
| --- | ---: | --- |
| Baseline | 1 | Sustained confirmed rate, p95 internal completion, balance-row lock wait, deadlock/serialization retry rate |
| Striped | 32 | The same metrics, plus per-bucket lock-wait distribution |

Required reporting rules:

- Both runs use identical hardware, configuration, dataset, workload mix, and commit SHA. The bucket count is the only variable.
- `ledger_bucket_lock_wait` is reported per logical account for both runs, because the claim is specifically about lock contention and the lock-wait collapse is the mechanism.
- The correctness audit passes in both runs. A throughput gain with a failed invariant check is a failed run.
- The report states the measured ratio and identifies the next bottleneck after striping, which is expected to move to the merchant clearing row, WAL throughput, or connection-pool wait rather than disappearing.
- If striping does not materially improve throughput, that result is published as-is together with the observed limiting factor. A negative result here is still a result; presenting the target as achieved is not permitted.

### Settlement throughput

Measured from settlement-run claim to commit of the batch, its membership, the clearing-to-payable posting, balance updates, and the outbox event. Settlement calls no external system, so this boundary is pure database work.

Initial engineering target:

```text
Sustained settled movements:   >= 5,000 movements/second
p95 batch commit:              < 400 ms at 1,000 movements per batch
Movements settled twice:       0
Batch amount mismatches:       0
```

The report states the movements-per-batch distribution, because batch commit latency scales with membership size and a single number without it is meaningless.

### Messaging and recovery

At 1,000 accepted commands/second:

```text
Outbox publish rate:            >= 2,000 envelopes/second
p95 unpublished outbox age:    < 2 seconds
p95 ordinary event lag:        < 3 seconds
Lost committed envelopes:      0
Duplicate local effects:       0
```

For an injected ambiguous outcome, recovery-time measurements start when the operation becomes `UNKNOWN` and end when it reaches a verified terminal state. Results are reported by reconciliation attempt and provider visibility; no blanket latency claim is made when the provider has not exposed the result.

## Reference benchmark environment

Every report records exact versions and configuration. The initial target environment is:

- One Google Cloud region, initially `us-central1`.
- API on Cloud Run: 2 vCPU, at least 1 GiB memory, concurrency initially 40, minimum 4 warm instances, maximum chosen so aggregate database connections remain bounded.
- Payment workers: 2 vCPU, independently autoscaled, explicit operation leases, bounded provider concurrency.
- PostgreSQL/Cloud SQL: PostgreSQL 17 or the current chosen supported version, regional high availability with synchronous standby/automatic failover, 8 vCPU, 32 GiB memory, SSD storage, synchronous commits enabled.
- A connection pool with a documented global limit; application pools MUST NOT multiply beyond the database budget during autoscaling.
- Google Pub/Sub with ordering by payment ID.
- Load generator in the same region but on separate compute from the system under test.
- OpenTelemetry sampling configured so benchmark overhead is stated; correctness/audit metrics remain unsampled.

A cheaper local or smaller-cloud run is useful for regression testing but MUST NOT be presented as the reference result without labeling its environment.

## Workload profiles

### Uniform acceptance

- 10,000 merchants.
- At least 1,000,000 pre-generated payments or a dataset large enough to avoid cache-only results.
- Commands distributed across independent payments.
- Valid idempotency keys with 5% deliberate identical replays.
- Mix: 35% authorize, 25% capture, 10% cancel, 20% refund, 10% reads or creation as specified by the test report.

The generator prepares valid aggregate states before the measured interval; expected business rejections are reported separately from system errors.

### Duplicate storm

- Ten deliveries of every selected API command or message.
- At least 10,000 distinct original operations.
- Expected result: one business effect per original operation and bounded inbox/idempotency contention.

### Hot merchant and hot payment

- Hot merchant: 50% of traffic belongs to one merchant but spans independent payments. Because merchant clearing is not striped, this profile measures whether a single merchant balance row becomes the next limit after platform striping.
- Hot payment: concurrent conflicting commands target one payment and should serialize or return the documented conflict, not increase throughput artificially.
- Report merchant-account-row, platform-bucket, and idempotency-index contention separately. Aggregating them hides which row is the bottleneck, which is the question these profiles exist to answer.

### Refund fan-out

- One captured payment receives many concurrent refund commands whose amounts collectively exceed the refundable value.
- At least 1,000 such payments, each with at least 8 concurrent refunds.
- Expected result: accepted refunds never exceed the refundable amount, every rejection is `MONETARY_GUARD_FAILED` from the locked guard, the reserved total always equals the sum of unresolved refund rows, and the fee reversals of all confirmed refunds sum exactly to the captured fee once a payment is fully refunded.
- This profile exists because the reservation guard, not a uniqueness index, is what prevents over-refund. It must be measured under real contention rather than asserted.

### Settlement under live traffic

- Settlement runs continuously for all merchants while capture and refund traffic is active.
- At least 1,000 merchants with a backlog of unsettled movements.
- A configured fraction of refunds confirms after their capture has already settled.
- Expected result: no movement settles twice, every batch amount matches the recomputed net of its members, merchant payable is non-decreasing, runs with a negative net defer without posting, and clearing plus payable equals the net of all confirmed movements at the end of the run.

### Provider degradation

- Fake provider latency rises from 25 ms to 2 seconds.
- Rate limits affect one provider account.
- Five percent of requests become ambiguous.
- Expected result: API command acceptance stays available, provider concurrency remains bounded, other provider accounts avoid starvation, and no speculative ledger entries appear.

### Crash and redelivery

- Terminate at least 10% of worker attempts at deterministic pre/post-call injection points.
- Republish at least 10% of outbox envelopes.
- Redeliver at least 20% of consumed messages.
- Expected result: zero duplicate financial effects and eventual convergence or explicit review.

### Database failover

- Trigger one planned regional Cloud SQL failover while command acceptance, outbox relay, and payment workers are active at a documented steady load.
- Record last successful commit, client disconnect/reconnect interval, pool wait, retry classifications, accepted/completed rates, outbox age, and worker lease recovery.
- Expected result: acknowledged commits remain present, ambiguous in-flight provider work follows reconciliation, bounded database retries preserve operation/envelope identities, and post-failover payment/journal/balance audits show zero loss or duplicate financial effects.
- The measured recovery must meet the architecture RTO/RPO objectives or be published as a miss; backup/PITR rehearsal is separate and does not substitute for HA failover evidence.

### Soak

- Run at 75% of the demonstrated ten-minute maximum for at least 60 minutes.
- No unbounded growth in memory, connections, outbox backlog, inbox latency, or unreconciled operations.
- Balance rebuild and journal audit must pass after the run.

## Load-generation method

- Use an open arrival-rate model so server slowdown appears as latency and queueing rather than silently reducing offered load.
- Warm the system for five minutes before measurement.
- Run at least three measured trials; report every result and use the median trial for the headline number.
- Record offered rate, accepted rate, completed rate, dropped iterations, p50/p95/p99/max latency, errors by code, and schedule lag.
- Keep response validation enabled during load generation.
- Pre-generate request data; do not benchmark test-data creation or random-number generation.
- Synchronize clocks and state exactly where each latency timer starts and stops.
- Preserve raw benchmark output, configuration, commit SHA, infrastructure revision, database settings, and dashboards as artifacts.

## Required metrics

### API and database

- Request rate and latency by endpoint/outcome.
- Idempotency new/replay/conflict counts.
- Database commit latency, lock wait, deadlock/serialization retry rate, connection-pool wait, active connections, CPU, memory, WAL rate, IOPS, and storage latency.
- Payment-operation state counts, age of the oldest unresolved exclusive operation, and age of the oldest unresolved refund.

### Messaging and workers

- Outbox rows created, published, retried, and oldest unpublished age.
- Subscription backlog, oldest unacknowledged age, delivery attempts, inbox duplicates, and DLQ count.
- Worker lease acquisition/contention, provider concurrency, result classification, and per-provider rate-limit state.

### Ledger and recovery

- Journal postings by type, idempotent replays, conflicts, and posting latency.
- Balance lock wait per logical account and per bucket, and projection-rebuild mismatch count.
- Reserved refund total, unresolved refund count, and refund-reservation guard rejections.
- Settlement runs by outcome, movements settled, batch size distribution, unsettled movement age, and negative-clearing age.
- `UNKNOWN` and `REQUIRES_REVIEW` counts/age, reconciliation attempts, resolution source, and discrepancies.
- Duplicate financial effect count as defined by the invariant checker, which MUST remain zero, reported alongside the separate unresolved-ambiguity gauges so the two are never conflated.

## Stop conditions

A test stops and the result is marked failed if:

- Any duplicate capture, refund, or journal posting is observed, as determined by the invariant checker's cross-system detector.
- Any journal transaction is unbalanced, a balance projection diverges, or a striped account's bucket sum disagrees with its rebuild.
- A payment's reserved refund total disagrees with its unresolved refund rows.
- A movement settles twice, or a batch amount disagrees with the recomputed net of its members.
- Confirmed refunds exceed captured value, or cumulative fee reversals exceed the captured fee.
- Load-generator dropped work is nonzero during the headline interval.
- Unexpected errors exceed 1% for 30 seconds.
- Database connection exhaustion, runaway retries, or an unbounded backlog threatens the environment.
- Prohibited sensitive data appears in logs, traces, messages, or stored provider evidence.

## Reporting template

Every published benchmark includes:

1. Git commit and contract/schema versions.
2. Complete infrastructure and database configuration, including the seeded ledger bucket count.
3. Dataset size and workload mix.
4. Offered, accepted, and completed rates.
5. Latency percentiles and exact measurement boundary.
6. Error, retry, duplicate, and dropped-work counts.
7. Resource utilization and identified bottleneck.
8. The invariant checker's output per assertion class, not a summary claim that it passed.
9. For the ledger contention comparison, both the `N = 1` and striped runs with their lock-wait distributions and the next identified bottleneck.
10. Any coverage the run bounded or dropped — sampled workloads, skipped profiles, top-N truncation — stated explicitly. A report that is silent about what it did not cover reads as full coverage.
11. Deviations from this contract.

Until a target passes under this method, résumé language MUST describe it as a target rather than a measured result.

The ledger contention comparison is the exception worth stating plainly: its value does not depend on hitting a target number. A measured before/after ratio with the lock-wait evidence behind it is a result regardless of the absolute throughput, and it is reported that way.
