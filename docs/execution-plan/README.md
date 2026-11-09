# FlowLedger execution plan

Status: **Proposed — execution contract for coding agents**
Last updated: 2026-11-08
Applies to: repository state with contracts only (no application code, no commits on `main`).

This directory turns the FlowLedger contracts into atomic, independently executable tasks.

| File | Contents |
| --- | --- |
| `README.md` (this file) | Sections 1–11 of the plan: summary, current state, traceability, architecture, roadmap, task index, commit sequence, QA, deployment, risks, agent guide |
| [`CONVENTIONS.md`](CONVENTIONS.md) | Binding engineering decisions the contracts leave open: toolchain, layout, commands, DB roles, migration numbering, message/HTTP rules, task format, Definition of Done, provider simulator process |
| [`tasks/P00-…md` … `tasks/P13-…md`](tasks/) | Section 6: every atomic task, one file per phase, each with its own traceability table and phase risks |

Phase `Pnn` is milestone `Mnn` of [`docs/10-IMPLEMENTATION_PLAN.md`](../10-IMPLEMENTATION_PLAN.md). That document stays the milestone baseline; this plan decomposes it and never overrides a contract.

---

## 1. Executive summary

**Application.** FlowLedger is a sandbox payment orchestrator: merchants create payments and issue authorize/capture/cancel/refund commands over REST; workers execute them against simulated providers; confirmed captures and refunds post to an immutable, double-entry, striped ledger; settlement closes confirmed movements into immutable batches. Its core claim is that a possibly-transmitted provider write becomes `UNKNOWN`, posts nothing, and resolves only through read-only evidence (lookup, signed webhook, or evidenced operator review) — never a blind retry.

**Scope.** Everything in `docs/00` §MVP scope "Included", delivered as 14 phases (P00–P13). Out of scope: everything in `docs/00` "Deferred"/"Explicitly excluded" and `docs/10` §Explicit non-goals (real provider adapter, payouts, FX, chargebacks, multiple captures, archival jobs, operator web UI).

**Stack (fixed by contract).** TypeScript strict / Node.js LTS, NestJS + Fastify, PostgreSQL 17 with explicit SQL and `SECURITY DEFINER` write boundaries, Google Pub/Sub, GCP (Cloud Run, Cloud SQL), Terraform, Vitest + fast-check + Testcontainers, k6, OpenTelemetry.

**Strategy.**

1. **Contracts first, database as the enforcement layer.** Every money/state invariant is enforced in PostgreSQL (checks, partial unique indexes, deferred constraint triggers, protected functions, RLS). TypeScript orchestrates; it cannot corrupt state because runtime roles have no DML on financial tables.
2. **Vertical slices with correctness gates.** Each phase ends with a `Pnn-GATE` task proving its milestone exit criteria end-to-end, not merely that its tasks merged.
3. **Checker before features.** `flowledger verify` (P03) is written from the contracts before capture/refund exist, and each later phase turns on its assertion classes.
4. **Three delivery levels** (from `docs/10`): Local vertical slice (P00–P07), Reliability-complete MVP (P00–P10), Portfolio-complete (P00–P13). Prefer shipping P00–P07 with a working demo over a half-built P13.
5. **Tasks sized for limited agents.** Each task is one commit (< ~600 changed lines including tests), names exact files, SQL objects, signatures, error codes, tests, and commands, and references contract sections instead of relying on memory of earlier tasks.

**Effort.** `docs/10` estimates 282–436 focused hours (148–222 for P00–P07) and calls this a lower bound. This plan does not change the estimate; per-task S/M/L sizes are in the phase files.

---

## 2. Current state assessment

Verified by inspecting the repository on 2026-11-08.

| Area | State | Evidence |
| --- | --- | --- |
| Git history | Empty: branch `main` has no commits | `git log` → "does not have any commits yet" |
| Application code | **None.** No `package.json`, `apps/`, `packages/`, `migrations/`, tests, CI, Docker, or Terraform | `find` of repository |
| Product/architecture contracts | Complete drafts (dated 2026-11-05) | `docs/00`–`docs/09` |
| ADRs | 12 accepted decisions | `docs/adr/0001`–`0012` |
| HTTP contract | OpenAPI 3.1, 11 operations (create/list/get payment, authorize, capture, cancel, refund, list operations, timeline, get operation, provider webhook ingest) | `openapi/openapi.yaml` |
| Message contracts | 26 registered message types (3 commands, 23 events), Draft 2020-12 schemas, registry + manifest schema, public merchant webhook schema | `schemas/registry.v1.json`, `schemas/**` |
| Milestone plan | M0–M13 with test gates, PR sequence, risk register | `docs/10-IMPLEMENTATION_PLAN.md` |
| Test commands | **None exist.** All commands in this plan are proposed in `CONVENTIONS.md` §4 and created by P00 | — |

**Implemented:** nothing. **Partially implemented:** nothing. **Remaining:** all of P00–P13.

What the contracts already settle (agents must not re-decide): money representation and bounds, ID format, every table/column/constraint in `docs/07`, every protected function name and responsibility, every state and transition, fee formulas, posting recipes, striping rule, lock order, envelope fields, event catalog, HTTP endpoints/status codes/problem codes, idempotency semantics, provider interface and outcome taxonomy, retry/backoff defaults, sweep defaults, SLO thresholds, workload profiles and stop conditions.

What the contracts leave open (this plan decides, labeled **[PROPOSED]** in `CONVENTIONS.md`): exact tool versions and libraries, package layout inside the fixed repo shape, command names, DB role names, migration runner and numbering, transport implementations, config mechanism, where the fake provider runs, CLI entry point, task granularity.

---

## 3. Requirements traceability matrix

Traceability is kept at two levels so it stays maintainable:

- **Top level (below):** every contract document and every README/`docs/10` claim → owning phase(s) and the gate that verifies it.
- **Detailed:** each phase file ends with a `Requirements traceability` table mapping every `docs/10` bullet for that milestone and every normative MUST in the contract sections it implements to task IDs and named test cases.

### 3.1 Contract → phase map

| Requirement source | Owning phases | Verified by |
| --- | --- | --- |
| `docs/00` scope acceptance examples (12 rows) | P04, P05, P07, P08, P10 | P07-GATE, P08-GATE, P10-GATE scenario tests (each example is one named e2e case; see §8.2) |
| `docs/01` linearization points, transaction boundaries, lock order | P02, P04, P05, P06, P07, P10 | Crash-injection tests in P05/P06/P07/P10; lock-order tests in P03/P07/P10 |
| `docs/02` money, posting invariants, striping, fee, settlement accounting | P01 (pure), P03 (ledger), P05 (fee snapshot), P07 (posting), P10 (settlement) | P01 golden vectors + properties; P03-GATE (`verify` zero findings, N=1 and N=32); P07-GATE; P10-GATE |
| `docs/03` state machine, exclusion, reservation, versions, expiry, ambiguity | P01 (pure guards), P02 (constraints), P05, P06, P07, P08 | P01 model tests; P05-GATE; P07-GATE; P08-GATE |
| `docs/04` envelopes, catalog, outbox/inbox, ordering, DLQ, merchant webhook wire | P00 (schema CI), P02 (tables), P05 (relay/inbox), P09 (webhooks) | P00 contract job; P05-GATE (Messaging-ready); P09-GATE |
| `docs/05` endpoints, auth, idempotency, versions, errors, pagination, timeline | P04, P05, P07–P10 (timeline kinds) | P04-GATE; P05-GATE; OpenAPI conformance suite (`test/contract/openapi-conformance.test.ts`) |
| `docs/06` provider interface, capabilities, results, attempts, leases, webhooks, lookup, redaction | P06, P07, P08, P09 | Shared conformance suite against fake + unreliable (P06-GATE, Provider-ready) |
| `docs/07` tables, constraints, functions, RLS, migration order, schema acceptance tests | P02, P03, P04–P11 | Each schema-acceptance bullet in `docs/07` §Schema acceptance tests is a row in some phase's traceability table; P11-GATE re-runs the full cross-tenant matrix |
| `docs/08` crash matrix, retry classes, DLQ, review, runbooks, observability, SLOs, DR | P05–P13 | Crash-point suite (`pnpm test:chaos`); P10 runbook tests; P11 alerts; P13 restore + failover drill |
| `docs/09` quality gates, invariant checker, test layers, workloads, metrics, stop conditions, report | P01, P03, P05–P07, P12, P13 | Gates mapped in §8.1; P12/P13 evidence bundles |
| `docs/10` M0–M13 features and exit gates | P00–P13 one-to-one | `Pnn-GATE` tasks |
| ADR-0001…0012 | See §4.10 | Each ADR's consequence is an acceptance criterion in the phase that implements it |
| `openapi/openapi.yaml` | P04, P05, P09 | OpenAPI conformance tests per implemented operation |
| `schemas/**` | P00 (validation), P02 (`insert_outbox`), every producer/consumer task | Contract job + producer/consumer validation tests |

### 3.2 README claims → evidence

| README claim | Where it becomes evidence |
| --- | --- |
| Ambiguity is first-class; `UNKNOWN` never retried blind | P06 (no-blind-retry mapping), P08 (`mark_unknown`, reconciliation), P08-GATE timeout→lookup scenarios; P13 demo step 1 |
| Effectively-once over at-least-once | P02 (uniqueness), P05 (outbox/inbox), P07 (posting key), P09 (webhook dedupe); `duplicate_financial_effects_total = 0` via P03 checker + P06 simulator ground truth |
| Ledger contention as a measured result (N=1 vs N=32) | P03 (striping), P12 contention pair, P13 reference comparison |
| Over-refund prevented by the monetary guard, not an index | P05 reservation guard tests asserting failure source; P07 concurrent refund scenarios; P12 refund fan-out |
| Application *cannot* corrupt the ledger | P02/P03 revoked-DML tests for every runtime role; P11-GATE re-run |
| Targets (1,000 cmd/s, 500 ops/s, 2,000 env/s, 0 duplicates) | Labeled **targets** until P13 raw artifacts exist; P12 local preflight never becomes a claim |

### 3.3 Quality gates (`docs/09` §Quality gates) → phase gates

| `docs/09` gate | First satisfied at |
| --- | --- |
| Domain-ready | P01-GATE |
| Persistence-ready | P02-GATE (extended at every later DB phase) |
| Ledger-ready | P03-GATE for posting/striping; P07-GATE adds reservation; P10-GATE adds settlement (complete) |
| Provider-ready | P06-GATE |
| Messaging-ready | P05-GATE |
| End-to-end-ready | P09-GATE (auth/capture/cancel/refund/webhook/ambiguity/reconciliation) |
| Performance-ready | P13-GATE (P12 is local preflight only) |

---

## 4. Technical architecture

The normative architecture is `docs/01`. This section summarizes it and records the implementation-level contracts between components that tasks depend on. Names in `code` are either contract names or **[PROPOSED]** names from `CONVENTIONS.md`.

### 4.1 Components

| Component | Path | Phase built | Responsibility | Talks to |
| --- | --- | --- | --- | --- |
| API | `apps/api` | P04, P05 | Auth, validation, idempotent create/accept, queries, timeline | PostgreSQL (`fl_api`) |
| Outbox relay | `apps/outbox-relay` | P05 | Claim/publish/ack outbox rows | PostgreSQL, Pub/Sub |
| Payment worker | `apps/payment-worker` | P06, P07, P08 | Claim operations, call provider, apply evidence; due-work scheduler; stale sweepers | PostgreSQL, Pub/Sub, provider simulator |
| Provider simulator **[PROPOSED]** | `apps/provider-simulator` | P06 | Server side of fake/unreliable providers, own DB, signed webhooks, ground truth | Own PostgreSQL DB, webhook receiver |
| Provider webhook receiver | `apps/provider-webhook-receiver` | P09 | Verify + durably record notifications | PostgreSQL |
| Provider webhook worker | `apps/provider-webhook-worker` | P09 | Normalize notifications → evidence → common resolution path | PostgreSQL, Pub/Sub |
| Reconciler | `apps/reconciler` | P08 | Case claims, read-only lookups, expiry checks, review escalation | PostgreSQL, Pub/Sub, provider simulator |
| Settlement worker | `apps/settlement-worker` | P10 | Schedule/claim runs, `settlement.post_batch` | PostgreSQL |
| Merchant webhook projector | `apps/merchant-webhook-projector` | P09 | Events → immutable delivery snapshots | PostgreSQL, Pub/Sub |
| Merchant webhook dispatcher | `apps/merchant-webhook-dispatcher` | P09 | Signed delivery, retries, SSRF defenses | PostgreSQL, Pub/Sub, merchant endpoints |
| CLI **[PROPOSED]** | `apps/cli` | P02 (migrate/seed), P03 (verify), P07 (demo), P08/P10/P11 (operator) | `flowledger` binary | PostgreSQL (role per command), simulator DB (verify only) |

Shared packages and their dependency direction: `CONVENTIONS.md` §3.

### 4.2 Frontend / backend responsibilities

There is **no frontend** in scope (`docs/00`: operator web application deferred). The "client" surfaces are the merchant REST API (OpenAPI), the signed merchant webhook (`schemas/webhooks/merchant-event.v1.schema.json`), and the operator CLI. Any task proposing a UI is out of scope.

### 4.3 Data model and migrations

- Authoritative model: `docs/07`, schemas `identity`, `providers`, `payments`, `api`, `ledger`, `settlement`, `messaging`, `webhooks`, `reconciliation`, `audit`.
- Migration mechanics, numbering ranges per phase, incremental ordering rule, bucket-count seeding: `CONVENTIONS.md` §8.
- Phase ownership of schema objects:

| Phase | Schema objects introduced |
| --- | --- |
| P02 | Extensions, schemas, roles, ID/hash helpers; `identity.*`; provider accounts, routes, account versions, credentials, provider webhook endpoints/secret versions/endpoint-accounts; `payments.fee_policies`; `payments.payments`, `payments.payment_operations` (indexes, deferred trigger); `api.idempotency_records`; `messaging.*` + `messaging.insert_outbox`; RLS + grants |
| P03 | `ledger.ledgers`, `ledger.accounts` (striping columns), `ledger.journal_transactions`, `ledger.journal_entries`, `ledger.account_balances`, `ledger.correction_requests`, `ledger.bucket_for_payment`, `ledger.logical_account_balances`, private posting routine, `ledger.post_approved_correction`; ledger seed migration |
| P04 | `payments.create_payment`; timeline read views |
| P05 | `payments.accept_operation`; relay/inbox claim functions |
| P06 | `providers.provider_attempts`, `provider_notifications`, `provider_event_claims`, `provider_identity_conflicts`, `provider_evidence` (+ deferrable evidence FKs); `claim_operation`, `mark_dispatch`, `defer_operation`, `schedule_same_operation_retry`, `enqueue_due_operations`, `providers.stage_attempt_evidence`, `apply_provider_evidence` for AUTHORIZE/CANCEL; simulator DB (separate) |
| P07 | `ledger.post_payment_operation`; `payments.apply_provider_evidence` extended to CAPTURE/REFUND (contradictory evidence returned `UNAPPLIED_*`, never applied) |
| P08 | `reconciliation.cases`, `reconciliation.case_activity`; `requeue_stale_pre_dispatch`, `mark_unknown`, `require_operation_review`, `record_authorization_expiry`, `record_discrepancy`, case parts of `apply_provider_evidence`; `payments.recovery_epochs` |
| P09 | `webhooks.endpoints`, `webhooks.deliveries`, `webhooks.delivery_attempts`; notification correlation/quarantine functions |
| P10 | `settlement.runs`, `settlement.batches`, `settlement.batch_members`, `settlement.post_batch` |
| P11 | `audit.*` append-only table(s); operator security-barrier views |

Phase files are authoritative for the exact split; the table above reflects their decisions.

### 4.4 APIs and error handling

- Endpoints, schemas, statuses, headers: `openapi/openapi.yaml`; semantics: `docs/05`.
- Error body: RFC 9457 problem details; codes from `docs/05` §Canonical error format; one mapping table `apps/api/src/errors/problem-map.ts` (P04).
- Database domain errors cross the boundary as `P0001` + code (`CONVENTIONS.md` §7) and map 1:1 to problem codes.
- `202 Accepted` = durably accepted (operation + idempotency + version + outbox committed), never provider success.

### 4.5 Authentication, authorization, security

- Merchant auth: bearer API credentials, prefix lookup + constant-time digest compare, scopes per operation (`x-required-scopes`), expiry/revocation (P02 schema, P04 guard).
- Tenant isolation: `SET LOCAL app.merchant_id`, RLS, explicit merchant predicates, composite tenant FKs, separate non-login service roles (`docs/07` §Tenant isolation).
- Write boundary: `SECURITY DEFINER` functions with fixed `search_path`, owned by non-login function-owner roles; runtime roles have no DML on payments/ledger/settlement/outbox (ADR-0007).
- Sensitive data: payment-method token encrypted with AES-256-GCM (AAD = merchant/payment/provider-account IDs), decrypted only in the authorize path of the payment worker; one redaction allowlist for logs/traces/errors/DLQ previews (`CONVENTIONS.md` §12).
- Provider webhooks: raw-body signature verification, timestamp window, endpoint/account allowlist, quarantine of uncorrelated events (P09).
- Merchant webhooks: HMAC signing with snapshotted secret version, SSRF defenses, byte/time bounds (P09).
- Operator: separate authenticated CLI surface, named principal + MFA claim, append-only audit (P11).
- Threat model document: P11.

### 4.6 Third-party services

| Service | Use | Local substitute |
| --- | --- | --- |
| Google Pub/Sub | Commands/events transport | Pub/Sub emulator (e2e) / `InMemoryTransport` (unit, integration) |
| Cloud SQL PostgreSQL 17 | Authoritative store | `postgres:17` in Docker / Testcontainers |
| Cloud Run | Process hosting | Node processes / Docker Compose |
| Secret Manager | Credentials, encryption keys, webhook secrets | `.env` with synthetic values |
| Cloud Monitoring / OTel backend | Metrics, traces, dashboards, alerts | OTel collector + local backend from Compose |
| Payment providers | **None real** (ADR-0011) | `apps/provider-simulator` |

### 4.7 State management and data flow

There is no in-memory authoritative state; processes coordinate only through committed PostgreSQL rows and versioned messages (`docs/01`). The canonical flows:

```text
Create:   API ──tx{idempotency, payment v1, outbox payment.created.v1}──▶ 201
Accept:   API ──tx{idempotency, lock payment, guards, operation, pointer|reservation, v+1, outbox requested + execute}──▶ 202
Relay:    claim outbox (SKIP LOCKED) → publish → mark published
Execute:  worker inbox → claim_operation (REQUESTED→PROCESSING, RESERVED attempt) → mark_dispatch → provider call (no tx)
          → stage evidence → apply_provider_evidence (terminal; capture/refund post ledger in same tx) | schedule_same_operation_retry | mark_unknown
Recover:  reconciler claims case → read-only lookup → stage evidence → same apply path | require_operation_review
Webhook:  receiver verify → notification row → worker → evidence → same apply path
Settle:   claim run → settlement.post_batch (anti-join selection, membership, clearing→payable posting, event) | DEFERRED
Notify:   projector → delivery snapshot → dispatcher signed POST → attempts
```

### 4.8 Infrastructure, configuration, deployment

- Local: Docker Compose (`infra/docker/compose.yaml`): PostgreSQL 17 (FlowLedger DB + simulator DB), Pub/Sub emulator, OTel collector + trace/metrics UI.
- Config: environment variables only, typed parsing per app, listed in `.env.example` and `docs/CONFIG.md` (`CONVENTIONS.md` §11).
- Cloud (P13): Terraform for Cloud Run services/jobs, regional HA Cloud SQL, Pub/Sub topics/subscriptions/DLQs, Secret Manager, per-process service accounts, Artifact Registry, monitoring; migrations as an explicit Cloud Run job.

### 4.9 Logging, monitoring, observability

- pino JSON logs with request/correlation/causation/envelope/payment/operation IDs; never as metric labels.
- OTel traces linking HTTP → outbox → worker → provider → ledger → settlement → merchant delivery (P11-GATE proves one end-to-end trace).
- Metrics: exact names from `docs/08` §Recovery observability and `docs/09` §Required metrics (P11), including `duplicate_financial_effects_total` as defined in `docs/09`.
- Alerts: thresholds from `docs/08` §MVP recovery decisions; each links to a runbook under `docs/runbooks/` (P10/P11).

### 4.10 Architectural decisions

The twelve ADRs are binding. Implementation consequences per ADR:

| ADR | Consequence tasks must honor | Phases |
| --- | --- | --- |
| 0001 Modular monolith + workers | One repo, one DB cluster, separate entry points; no service-per-module | All |
| 0002 PostgreSQL authoritative | Pub/Sub is never the linearization point | P02, P05 |
| 0003 Exclusive ops + reserved refunds | Partial unique index for exclusive ops only; refunds bounded by `refunded + reserved <= captured` under lock + check; tests assert guard is the failure source | P02, P05, P07 |
| 0004 Read-only ambiguity resolution | No same-key write retry for `UNKNOWN`/`REQUIRES_REVIEW` even if adapter advertises `SAME_KEY_REPLAY` | P06, P08 |
| 0005 Synchronous balance projection | Balances updated in posting tx; rebuild/audit tooling | P03, P07 |
| 0006 `If-Match` in idempotency hash | Hash includes semantic `If-Match`; replay resolved before version compare | P01, P05 |
| 0007 Protected functions as write boundary | Revoked DML, `SECURITY DEFINER`, fixed `search_path` | P02–P10 |
| 0008 Fee at capture; refund reversal at confirmation | Snapshot at acceptance; `floor(F*R/G)` cumulative at confirmation | P01, P05, P07 |
| 0009 Keys never expire; bodies 90 days | Tombstone semantics → `409 IDEMPOTENCY_KEY_EXPIRED` | P02, P04 |
| 0010 Striped clearing accounts | `N=32` default, bucket from payment ID inside DB, N=1 comparison | P03, P12, P13 |
| 0011 Simulated providers only | Fake + unreliable, shared conformance suite; simulator process (§G-01) | P06 |
| 0012 Ledger-only settlement | Clearing→payable batches; no payout; immutable membership | P10 |

Plan-level decisions added here (all **[PROPOSED]**, see `CONVENTIONS.md`): provider simulator as a separate process with its own DB (§16), `apps/cli` entry point (§3), two transports only (§9), role catalog (§7), migration numbering by phase (§8).

---

## 5. Implementation roadmap

### 5.1 Phases and milestones

| Phase | Milestone (`docs/10`) | Depends on | Exit gate task | Delivery level reached |
| --- | --- | --- | --- | --- |
| P00 | M0 Repository & verification foundation | — | P00-GATE | |
| P01 | M1 Domain kernel | P00 | P01-GATE (Domain-ready) | |
| P02 | M2 PostgreSQL & durable messaging foundation | P01 | P02-GATE (Persistence-ready) | |
| P03 | M3 Ledger core, striping, invariant checker | P02 | P03-GATE | |
| P04 | M4 Merchant API & HTTP idempotency | P02 | P04-GATE | |
| P05 | M5 Command acceptance & messaging core | P03, P04 | P05-GATE (Messaging-ready) | |
| P06 | M6 Providers & execution worker | P05 | P06-GATE (Provider-ready) | |
| P07 | M7 Capture, refund, local lifecycle | P06 | P07-GATE | **Local vertical slice** |
| P08 | M8 Ambiguity & reconciliation | P07 | P08-GATE | |
| P09 | M9 Provider & merchant webhooks | P07, P08 | P09-GATE (End-to-end-ready) | |
| P10 | M10 Settlement & operational recovery | P08, P09 | P10-GATE (Ledger-ready complete) | **Reliability-complete MVP** |
| P11 | M11 Security, observability, operator visibility | P10 | P11-GATE | |
| P12 | M12 Local performance & chaos readiness | P11 | P12-GATE | |
| P13 | M13 GCP, reference benchmark, evidence | P12 | P13-GATE (Performance-ready) | **Portfolio-complete** |

### 5.2 Critical path

```text
P00 → P01 → P02 → P03 ─┐
                  └→ P04 ┴→ P05 → P06 → P07 → P08 → P09 → P10 → P11 → P12 → P13
```

P03 and P04 are the only phase-level parallel branch (both need only P02-GATE). The critical path runs through whichever of P03/P04 finishes later; P03 (ledger + checker, 26–38 h) is normally longer. Everything after P05 is sequential at phase level because each phase extends the same payment-transition functions.

### 5.3 Parallelism inside phases

Each phase file has a **Parallelization** section listing concurrent task groups and the shared files they would conflict on. General rules:

- Tasks that only add tests, docs, k6 scripts, or dashboards parallelize freely after the interface they target is merged.
- Two tasks that each add a migration in the same phase serialize (they take sequential numbers in that phase's range).

### 5.4 Single-owner surfaces (never edit in parallel)

Assign one agent at a time to any task touching:

1. `migrations/` within one phase range, and any `SECURITY DEFINER` function body.
2. `packages/domain/src/state/**` (shared state types and guards).
3. `openapi/openapi.yaml`, `schemas/**`, `schemas/registry.v1.json` (contract changes require a contract-update commit first).
4. `payments.apply_provider_evidence` and `ledger.post_payment_operation` (P07 → P08 → P09 extend them sequentially).
5. `packages/observability/src/redaction.ts` and `apps/api/src/errors/problem-map.ts`.
6. `CONVENTIONS.md`.

### 5.5 Integration checkpoints (application must build and these must pass)

| Checkpoint | After | What must work end to end |
| --- | --- | --- |
| C0 Static green | P00-GATE | Clean clone: `pnpm install --frozen-lockfile && pnpm check` green; contract job rejects malformed fixtures |
| C1 Domain-ready | P01-GATE | All fee/hash golden vectors and lifecycle properties |
| C2 Persistence-ready | P02-GATE | Migrations from empty DB; RLS; revoked DML; idempotency election under 100 concurrent claims |
| C3 Ledger-ready (core) | P03-GATE | `flowledger verify` zero findings on a randomized populated DB at N=1 and N=32; each class catches its corrupted fixture |
| C4 API up | P04-GATE | `POST /v1/payments` + queries + timeline with replay/conflict/tenant tests |
| C5 Durable acceptance | P05-GATE | 202 only after commit; reservation guard; relay/inbox redelivery; DLQ |
| C6 Provider-ready | P06-GATE | Authorize/cancel through simulator; conformance suite green for both adapters |
| C7 **Local vertical slice** | P07-GATE | Full create→authorize→capture→refunds→verify locally; demo CLI |
| C8 Ambiguity converges | P08-GATE | Timeout→lookup→one posting; exhaustion→review; expiry races |
| C9 End-to-end-ready | P09-GATE | Three-source races converge; merchant webhook signatures/SSRF |
| C10 **Reliability-complete** | P10-GATE | Settlement invariants; runbooks executed; verify complete set |
| C11 Observable & secured | P11-GATE | One full trace; alerts fire under fault injection; cross-tenant matrix |
| C12 Local preflight | P12-GATE | Three local trials with valid post-run audits |
| C13 **Portfolio-complete** | P13-GATE | HA deploy, restore + failover drill, reference trials, evidence index, offline demo |

---

## 6. Detailed task specifications

Every task follows the template in `CONVENTIONS.md` §15 and lives in its phase file.

### 6.0 Definition of Done (applies to every task)

See `CONVENTIONS.md` §15. In short: acceptance criteria met; required tests exist, pass, and were seen to fail when the protected invariant was broken; `pnpm check` (plus `pnpm test:integration` for DB-touching tasks) green; only listed files changed; no debug code, skipped tests, or unapproved dependencies; commit message matches the task.

### 6.1 Task index

<!-- TASK-INDEX:BEGIN -->
239 tasks across 14 phase files.

| Task | Title | Priority | Size | Dependencies | File |
| --- | --- | --- | --- | --- | --- |
| `P00-T01` | Workspace, toolchain pins, project references, and test projects | Critical | M | none | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T02` | ESLint policy rules and dependency-policy check | Critical | M | P00-T01 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T03` | Base configuration, lifecycle, `.env.example`, and `docs/CONFIG.md` | Critical | M | P00-T01 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T04` | Inert NestJS application entry points (API + eight workers) | High | M | P00-T02, P00-T03 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T05` | Inert `cli` (`flowledger` bin) and `provider-simulator` entry points | High | S | P00-T04 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T06` | Docker Compose stack, simulator database bootstrap, and PostgreSQL test fixture | High | M | P00-T03 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T07` | Contract code generation and drift check | Critical | M | P00-T01 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T08` | Ajv message validation core, registry semantic rules 1–5, and catalog parity | Critical | M | P00-T07 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T09` | OpenAPI parse, reference, component-example, and prose-example validation | Critical | M | P00-T08 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T10` | Positive and negative message fixtures for every registered type and the merchant webhook payload | Critical | L | P00-T08 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T11` | Semantic correlation validator | Critical | M | P00-T10 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T12` | Prohibited-data fixtures, detector, repository scan, and secret scanning config | High | M | P00-T10 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T13` | Migration file naming and ordering check | Medium | S | P00-T01 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-T14` | CI workflow (fast + integration), `test:performance` stub, and development guide | Critical | M | P00-T02, P00-T04, P00-T05, P00-T06, P00-T07, P00-T08, P00-T09, P00-T10, P00-T11, P00-T12, P00-T13 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P00-GATE` | M0 milestone verification | Critical | S | P00-T01 … P00-T14 | [P00-repository-foundation.md](tasks/P00-repository-foundation.md) |
| `P01-T01` | Domain errors, checked money, and property-test harness | Critical | M | P00-GATE | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T02` | Branded entity identifiers | Critical | S | P01-T01 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T03` | Strict value constructors (provider name, idempotency key, correlation ID, timestamp) | High | S | P01-T01 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T04` | Capture fee and cumulative proportional refund-fee reversal | Critical | M | P01-T01 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T05` | Canonical JSON (RFC 8785 subset) and canonical API request hash | Critical | M | P01-T02, P01-T03 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T06` | Canonical ledger posting hash | Critical | M | P01-T05 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T07` | Payment and operation model, invariant checker, and derived summary status | Critical | M | P01-T02, P01-T04 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T08` | Command acceptance guards and effects | Critical | M | P01-T07 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T09` | Operation execution and resolution transitions | Critical | L | P01-T08 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T10` | Model-based property tests for the payment lifecycle | Critical | M | P01-T09 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T11` | Normalized provider result, error, and evidence types | High | M | P01-T02, P01-T03 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T12` | Retry classification, observation normalization, and backoff | High | M | P01-T11 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-T13` | Stable provider idempotency key derivation | High | S | P01-T02, P01-T03 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P01-GATE` | Domain-ready gate (M1) | Critical | S | P01-T01 … P01-T13 | [P01-domain-kernel.md](tasks/P01-domain-kernel.md) |
| `P02-T01` | Migration runner, pool, bootstrap, `flowledger migrate`, and Testcontainers fixture | Critical | L | `P01-GATE` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T02` | Transaction helper and domain-error mapping | Critical | M | `P02-T01` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T03` | Migration 0200: schemas, roles, and common helpers | Critical | M | `P02-T01` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T04` | API credential scheme (pure domain) | High | S | `P01-GATE` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T05` | Migration 0210: identity tables and credential repository | Critical | M | `P02-T02`, `P02-T03`, `P02-T04` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T06` | Migration 0220: provider configuration and deterministic route selection | Critical | L | `P02-T05` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T07` | Migration 0230: append-only fee policies and merchant test fixture | Critical | M | `P02-T06` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T08` | Migration 0240: payment aggregate table | Critical | M | `P02-T07` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T09` | Migration 0250: payment operations, exclusion indexes, active-exclusive FK | Critical | L | `P02-T08` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T10` | Migration 0260: deferred payment-aggregate consistency trigger | Critical | M | `P02-T09` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T11` | Migration 0270: API idempotency records and atomic claim primitive | Critical | L | `P02-T10` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T12` | Migration 0280: messaging tables and message-type registry | Critical | L | `P02-T11` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T13` | Migration 0290: protected outbox insertion `messaging.insert_outbox` | Critical | L | `P02-T12` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T14` | Merchant-scoped repositories and cross-tenant / runtime-role matrices | High | M | `P02-T13` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-T15` | Dev seed and credential issue/revoke commands | High | M | `P02-T13` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P02-GATE` | Persistence-ready verification | Critical | M | `P02-T01` … `P02-T15` | [P02-database-foundation.md](tasks/P02-database-foundation.md) |
| `P03-T01` | Ledger SQL helpers: ID generator, JCS serializer, bucket derivation | Critical | M | `P02-GATE` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T02` | Ledgers, accounts, balance projection, account creation, logical-balance view | Critical | L | `P03-T01` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T03` | Ledger seed: striped platform buckets at the configured bucket count, merchant accounts, N=1/N=32 fixture | Critical | M | `P03-T02` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T04` | Journal transactions and entries: constraints, immutability, deferred balance check, RLS, grants | Critical | M | `P03-T02` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T05` | Canonical line combination and database-computed posting hash with shared golden vectors | Critical | M | `P03-T01`, `P01-GATE` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T06` | Private canonical posting routine `ledger.post_journal_internal` and owner harness | Critical | L | `P03-T03`, `P03-T04`, `P03-T05` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T07` | Pure capture/refund recipes, fee reversal, and bucket-resolved account lines | High | M | `P03-T06`, `P01-GATE` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T08` | Concurrency, retry, and property suite for posting and striping | Critical | L | `P03-T07` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T09` | Dual-control corrections: requests, decisions, and `ledger.post_approved_correction` | Critical | L | `P03-T06` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T10` | Balance rebuild tooling and ledger crash-point tests | High | M | `P03-T09` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T11` | `flowledger verify` framework, output formats, and ledger classes | Critical | L | `P03-T06` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T12` | Verify classes: payment totals, reservation integrity, posting cardinality | High | M | `P03-T11` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T13` | Verify classes: orphan detection and settlement membership (table-absent aware) | High | M | `P03-T11` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T14` | Verify class: duplicate financial effects against provider ground truth | High | M | `P03-T11` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-T15` | CI wiring: `pnpm verify:ledger` in the integration job | High | S | `P03-T11` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P03-GATE` | Ledger-ready milestone verification | Critical | M | `P03-T01` … `P03-T15` | [P03-ledger-core.md](tasks/P03-ledger-core.md) |
| `P04-T01` | API bootstrap, request context, and problem details | Critical | M | `P02-GATE` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T02` | Strict JSON body parsing, size bound, and media type | Critical | M | `P04-T01` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T03` | Schema validation, money encoding, header parsing, and prohibited payment data | Critical | L | `P04-T02` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T04` | Bearer authentication, scopes, and merchant context | Critical | M | `P04-T01` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T05` | Payment-method token validation, encryption, and supported providers | High | S | `P02-GATE` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T06` | SQL read surface: representations, summary status, and list functions | Critical | L | `P02-GATE` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T07` | Protected `payments.create_payment` boundary and SQL fault hooks | Critical | L | `P04-T06` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T08` | Provider route selection and rollover tests | High | M | `P04-T07` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T09` | `POST /v1/payments` endpoint and HTTP idempotency behavior | Critical | L | `P04-T03`, `P04-T04`, `P04-T05`, `P04-T07` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T10` | `GET /v1/payments/{paymentId}` and `GET /v1/operations/{operationId}` with ETags | High | M | `P04-T06`, `P04-T09` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T11` | Encrypted cursor pagination for `GET /v1/payments` and `GET /v1/payments/{paymentId}/operations` | High | M | `P04-T06`, `P04-T09` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T12` | `GET /v1/payments/{paymentId}/timeline` with closed per-kind details | High | M | `P04-T06`, `P04-T09` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T13` | Request logging and redaction for the API surface | High | S | `P04-T09` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-T14` | OpenAPI response conformance helper and suite | High | M | `P04-T10`, `P04-T11`, `P04-T12` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P04-GATE` | Merchant API milestone verification | Critical | M | `P04-T01` … `P04-T14` | [P04-merchant-api.md](tasks/P04-merchant-api.md) |
| `P05-T01` | `accept_operation` core: claim, replay, `If-Match`, exclusion, `AUTHORIZE`, `CANCEL` | Critical | L | `P04-GATE`, `P03-GATE` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T02` | `accept_operation`: `CAPTURE` fee snapshot and minimum, `REFUND` reservation guard | Critical | L | `P05-T01` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T03` | Command acceptance endpoints | Critical | L | `P05-T02` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T04` | Concurrency and guard-source suite with operation-state fixtures | Critical | M | `P05-T03` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T05` | Per-statement failure injection and crash/replay for acceptance | Critical | M | `P05-T03` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T06` | `Transport` interface, `InMemoryTransport`, and topology | Critical | M | `P04-GATE` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T07` | `PubSubTransport`, topology bootstrap, and emulator e2e | High | M | `P05-T06` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T08` | Outbox relay: claim, publish, acknowledge, retry, crash safety | Critical | L | `P05-T06` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T09` | Inbox and dead-letter SQL boundaries | Critical | M | `P05-T01` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T10` | Inbox consumer framework, strict validation, DLQ classification, and gap parking | Critical | L | `P05-T06`, `P05-T09` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T11` | Stale accepted-operation sweeper | High | M | `P05-T08`, `P05-T09` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-T12` | Timeline kind `OPERATION_ACCEPTED` | Medium | S | `P05-T03` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P05-GATE` | Durable acceptance and messaging milestone verification | Critical | M | `P05-T01` … `P05-T12` | [P05-command-acceptance-messaging.md](tasks/P05-command-acceptance-messaging.md) |
| `P06-T01` | Provider-neutral interface, capabilities, and startup validation | Critical | S | `P05-GATE` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T02` | Crash hooks, SQL fault points, and SQL ID generator | Critical | S | `P05-GATE` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T03` | Simulator database bootstrap and `flowledger migrate --simulator` | Critical | M | `P05-GATE` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T04` | Simulator core: provider-side state machine, idempotency, deterministic IDs | Critical | L | `P06-T03` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T05` | Simulator HTTP service, PostgreSQL store, and test endpoints | Critical | L | `P06-T04` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T06` | Simulator fault engine (seeded, server-side, post-commit) | Critical | M | `P06-T05` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T07` | Simulator signed webhook emitter | High | M | `P06-T06` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T08` | Adapters: write path and result classification | Critical | L | `P06-T01`, `P06-T06` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T09` | Adapters: lookup, authorization status, webhook verification | High | M | `P06-T08`, `P06-T07` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T10` | Shared adapter conformance suite | Critical | L | `P06-T09` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T11` | Migration: provider attempts and provider evidence | Critical | L | `P06-T02` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T12` | Migration: provider notifications, event claims, identity conflicts | High | M | `P06-T11` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T13` | Migration: claim, dispatch mark, deferral, and evidence staging functions | Critical | L | `P06-T12` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T14` | Migration: authorization/cancellation resolution, retry scheduling, due enqueue | Critical | L | `P06-T13` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T15` | Database wrappers, payment-method decryption, worker config | Critical | M | `P06-T14` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T16` | Payment worker execute handler | Critical | L | `P06-T15`, `P06-T10` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T17` | Per-account concurrency, fairness, backoff, and circuit breaking | High | M | `P06-T16` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T18` | Due-work scheduler and staged-evidence recovery | Critical | M | `P06-T16` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-T19` | Timeline entries for attempts, evidence, and resolutions | Medium | S | `P06-T14` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P06-GATE` | Provider-ready milestone verification | Critical | L | `P06-T01` … `P06-T19` | [P06-providers-worker.md](tasks/P06-providers-worker.md) |
| `P07-T01` | Migration: `ledger.post_payment_operation` | Critical | L | `P06-GATE` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T02` | Migration: capture resolution in `apply_provider_evidence` | Critical | M | `P07-T01` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T03` | Migration: refund resolution with fee reversal and reservation release | Critical | M | `P07-T02` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T04` | Worker executes capture and refund; event contract checks | Critical | S | `P07-T03` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T05` | `flowledger verify`: reservation integrity, posting cardinality, duplicate effects | Critical | M | `P07-T04` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T06` | Testkit polling helpers, API client, and lifecycle fixtures | High | S | `P06-GATE` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T07` | Timeline entries for ledger postings | Medium | S | `P07-T03` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-T08` | `flowledger demo` local lifecycle command | High | M | `P07-T06`, `P07-T07` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P07-GATE` | Local vertical slice verification | Critical | L | `P07-T01` … `P07-T08` | [P07-capture-refund-lifecycle.md](tasks/P07-capture-refund-lifecycle.md) |
| `P08-T01` | Simulator scripting for ambiguity, lookup, and expiry scenarios | High | M | `P07-GATE` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T02` | Reconciliation cases, activity, and evidence case FK | Critical | M | `P07-GATE` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T03` | Recovery epoch fence for provider dispatch | High | S | `P08-T02` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T04` | `payments.mark_unknown` with atomic case creation | Critical | L | `P08-T02` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T05` | Worker routes ambiguity to `mark_unknown`; redelivery by status | Critical | M | `P08-T03`, `P08-T04` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T06` | Stale pre-dispatch requeue and stale-`REQUESTED` republish functions | Critical | M | `P08-T03` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T07` | Stale `REQUESTED`/`PROCESSING` and staged-evidence sweepers | Critical | M | `P08-T05`, `P08-T06`, `P08-T09` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T08` | Case claim, observation, recheck, and note functions | Critical | M | `P08-T04` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T09` | Case resolution, expiry-case lifecycle, and discrepancy cases in the evidence path | Critical | L | `P08-T08` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T10` | `payments.require_operation_review` | Critical | M | `P08-T09` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T11` | `payments.record_authorization_expiry` | Critical | M | `P08-T09`, `P08-T07` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T12` | Reconciler app: ambiguity cases | Critical | L | `P08-T10`, `P08-T01` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T13` | Reconciler: authorization-expiry cases | High | M | `P08-T11`, `P08-T12` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T14` | Operator CLI: cases, evidence notes, recheck, escalation | High | M | `P08-T10`, `P08-T08` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T15` | DR fence CLI and restored-window reconciliation tooling | Medium | M | `P08-T03`, `P08-T12` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T16` | Worker/provider and refund-reservation chaos suite | Critical | L | `P08-T07`, `P08-T12`, `P08-T13` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-T17` | `payments.record_discrepancy` and contradiction routing | Critical | L | `P08-T09`, `P08-T11` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P08-GATE` | Milestone M8 verification | Critical | M | `P08-T01`…`P08-T17` | [P08-ambiguity-reconciliation.md](tasks/P08-ambiguity-reconciliation.md) |
| `P09-T01` | Merchant webhook tables | Critical | M | `P08-GATE` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T02` | Provider notification receipt function | Critical | M | `P08-GATE` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T03` | Webhook verification binding and simulator emission controls | Critical | M | `P08-GATE` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T04` | Provider webhook receiver app | Critical | M | `P09-T02`, `P09-T03` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T05` | Notification correlation and quarantine functions | Critical | M | `P09-T02` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T06` | Provider notification worker | Critical | L | `P09-T05`, `P09-T04` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T07` | Merchant webhook protected functions | Critical | M | `P09-T01` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T08` | Merchant webhook projector | High | M | `P09-T07` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T09` | Merchant webhook signature module and golden vectors | High | S | `P08-GATE` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T10` | SSRF-safe bounded outbound HTTP client | Critical | M | `P08-GATE` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T11` | Merchant webhook dispatcher | Critical | L | `P09-T07`, `P09-T09`, `P09-T10` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T12` | Operator CLI: merchant endpoints, delivery replay, notification reprocess | Medium | M | `P09-T07`, `P09-T05`, `P09-T10` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T13` | DLQ replay controls with operation-state checks | High | M | `P09-T12` (migration order `0940` → `0950`) | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-T14` | Webhook duplicate, ordering, and three-source race suite | Critical | L | `P09-T06`, `P09-T11` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P09-GATE` | Milestone M9 / End-to-end-ready verification | Critical | M | `P09-T01`…`P09-T14` | [P09-webhooks.md](tasks/P09-webhooks.md) |
| `P10-T01` | Verify and wire the settlement event, ledger `SETTLEMENT` type, and timeline kind contracts | High | S | `P08-GATE`, `P09-GATE` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T02` | Settlement schema: runs, batches, membership, immutability, RLS, grants | Critical | L | `P10-T01` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T03` | `SETTLEMENT` ledger recipe: hash golden vectors and posting-routine acceptance | Critical | M | `P10-T02` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T04` | Run scheduling, claim, failure, and stale-run sweep functions | Critical | M | `P10-T02` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T05` | Protected `settlement.post_batch` | Critical | L | `P10-T03`, `P10-T04` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T06` | Settlement crash-point suite | Critical | M | `P10-T05` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T07` | `apps/settlement-worker`: scheduler, poster, stale-run sweeper | Critical | L | `P10-T05` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T08` | Settlement property tests under randomized traffic | High | M | `P10-T05` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T09` | Turn on the invariant checker's settlement-membership class | Critical | M | `P10-T05` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T10` | Payment timeline `SETTLEMENT` entry | High | M | `P10-T05` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T11` | Append-only operator audit table | Critical | M | `P08-GATE`, `P09-GATE` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T12` | Operator commands: republish outbox envelope and replay nonfinancial DLQ message | High | M | `P10-T11` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T13` | Operator commands: reschedule reconciliation, trigger settlement run, inspect evidence | High | M | `P10-T07`, `P10-T11` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T14` | Two-principal compensating ledger correction workflow | High | M | `P10-T11` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T15` | Runbooks: stalled/deferring settlement and ledger/payment discrepancy | High | M | `P10-T09`, `P10-T13`, `P10-T14` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T16` | Runbooks: stale `REQUESTED`, stale `PROCESSING`, `UNKNOWN` operation | High | L | `P10-T15`, `P10-T12`, `P10-T13` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T17` | Runbooks: provider outage/rate limiting and provider webhook incident | Medium | M | `P10-T15`, `P10-T13` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-T18` | Runbooks: outbox/subscriber backlog and provider execution command in DLQ | High | M | `P10-T15`, `P10-T12` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P10-GATE` | M10 milestone verification | Critical | M | `P10-T01` … `P10-T18` | [P10-settlement-recovery.md](tasks/P10-settlement-recovery.md) |
| `P11-T01` | Focused threat model | High | M | `P10-GATE` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T02` | Operator identity: dev IdP stub, signed MFA token, session binding | Critical | L | `P10-GATE` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T03` | Bind every audited operator command to the authenticated principal | Critical | M | `P11-T02` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T04` | Operator views: payments, attempts, evidence, journal postings, bucket balances | High | M | `P11-T03` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T05` | Operator views: outbox/inbox, DLQ, webhooks, settlement, reconciliation, audit | High | M | `P11-T04` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T06` | Correlation and causation propagation through logs and traces | Critical | L | `P10-GATE` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T07` | Metrics pipeline, registry, label guard, API and database metrics | Critical | L | `P10-GATE` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T08` | Messaging, worker, provider, and webhook metrics | High | L | `P11-T07` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T09` | Ledger posting and per-bucket lock-wait metrics | High | M | `P11-T07` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T10` | Payment operation, refund reservation, and reconciliation metrics | High | M | `P11-T07` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T11` | Settlement and invariant-checker metrics | High | M | `P11-T07` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T12` | Dashboards as code | High | M | `P11-T08`, `P11-T09`, `P11-T10`, `P11-T11` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T13` | Alert rules with contracted thresholds | Critical | M | `P11-T08`, `P11-T10`, `P11-T11` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T14` | Alerts fire under controlled fault injection; runbooks assert their signals | High | M | `P11-T12`, `P11-T13` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T15` | Systematic cross-tenant isolation suite | Critical | M | `P11-T05` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T16` | Captured-telemetry redaction suite | Critical | M | `P11-T06`, `P11-T11` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T17` | Dependency, container, IaC, and secret scans in CI | High | S | `P10-GATE` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-T18` | Known-limits document | High | S | `P11-T03`, `P11-T13` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P11-GATE` | M11 milestone verification | Critical | M | `P11-T01` … `P11-T18` | [P11-security-observability.md](tasks/P11-security-observability.md) |
| `P12-T01` | Crash-point coverage audit, rate-based fault plan, production guard | Critical | M | `P11-GATE` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T02` | Connection budget model and bounded pools | Critical | M | `P11-GATE` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T03` | `flowledger seed --profile perf` | High | M | `P11-GATE` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T04` | Simulator runtime fault/latency profile endpoint | High | M | `P11-GATE` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T05` | Local system orchestrator | Critical | L | `P12-T02`, `P12-T04` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T06` | Runner core: `pnpm test:performance <profile>` | Critical | L | `P12-T05` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T07` | Verify loop and docs/09 stop conditions | Critical | L | `P12-T06` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T08` | PostgreSQL metrics capture and boundary timings | High | L | `P12-T06` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T09` | Balance-row lock-wait sampler (per logical account and per bucket) | Critical | L | `P12-T06` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T10` | Duplicate-effect detector conformance and per-condition breakdown | Critical | M | `P11-GATE` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T11` | Dataset preparation, snapshot, and restore | Critical | L | `P12-T03`, `P12-T07` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T12` | Profile: uniform acceptance (with messaging metrics) | Critical | M | `P12-T08`, `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T13` | Profile: confirmed capture/refund processing | Critical | M | `P12-T08`, `P12-T09`, `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T14` | Profile: duplicate storm | High | M | `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T15` | Profiles: hot merchant and hot payment | High | M | `P12-T09`, `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T16` | Profile: refund fan-out | Critical | M | `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T17` | Profile: settlement under live traffic (and settlement throughput) | High | L | `P12-T08`, `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T18` | Profile: provider degradation (load and isolation) | High | M | `P12-T04`, `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T19` | Crash/redelivery chaos runner | Critical | L | `P12-T01`, `P12-T05`, `P12-T07`, `P12-T11` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T20` | Profile: soak | High | M | `P12-T12` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T21` | Ledger contention comparison pair | Critical | L | `P12-T05`, `P12-T09`, `P12-T13` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T22` | Benchmark report generator | High | M | `P12-T07`, `P12-T08`, `P12-T09` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T23` | Nightly regression load lane | Medium | S | `P12-T12`, `P12-T17` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T24` | Evidence-driven tuning iteration (repeatable; one commit per change) | High | M per iteration | `P12-T12`, `P12-T13`, `P12-T22` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T25` | Three local preflight trials (headline workloads) | Critical | M (wall-clock: ~3–5 h of runs on a workstation with Docker and k6) | `P12-T12`, `P12-T13`, `P12-T17`, `P12-T22`, `P12-T24` (at least the iterations judged necessary; zero iterations is allowed if evidence shows no obvious bottleneck) | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-T26` | Local soak, contention pair, and remaining profiles | High | M (wall-clock: ~5–7 h of runs) | `P12-T14`, `P12-T15`, `P12-T16`, `P12-T18`, `P12-T19`, `P12-T20`, `P12-T21`, `P12-T25` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P12-GATE` | Local performance and chaos readiness gate | Critical | M | `P12-T01` … `P12-T26` | [P12-performance-chaos.md](tasks/P12-performance-chaos.md) |
| `P13-T01` | Container images (one Dockerfile pattern) | Critical | M | `P12-GATE` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T02` | Terraform inputs generated from code (topology, budget) | High | S | `P12-GATE` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T03` | `flowledger db set-role-passwords` | High | S | `P12-GATE` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T04` | Terraform foundation: project services, networking, registry, evidence bucket | Critical | M | `P13-T02` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T05` | Cloud SQL: HA PostgreSQL 17 and the separate simulator instance | Critical | M | `P13-T04` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T06` | Pub/Sub topics, subscriptions, and DLQs from the topology | Critical | S | `P13-T02`, `P13-T04` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T07` | Service accounts, IAM, and Secret Manager | Critical | M | `P13-T05`, `P13-T06` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T08` | Cloud Run services and jobs (migration as an explicit job) | Critical | L | `P13-T01`, `P13-T03`, `P13-T07` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T09` | Monitoring: telemetry export, dashboards, alert policies | High | L | `P13-T08` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T10` | Ops VM (load generator) and reference target in the runner | Critical | M | `P13-T08` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T11` | Bootstrap/deploy script, IAM isolation verifier, setup documentation | Critical | M | `P13-T05`, `P13-T06`, `P13-T07`, `P13-T08`, `P13-T09`, `P13-T10` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T12` | Drill tooling: restore rehearsal and planned failover | Critical | L | `P13-T10`, `P13-T11` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T13` | HUMAN: provision the reference environment and verify deployment behavior | Critical | M (plus cloud wait time) | `P13-T11`, `P13-T12` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T14` | HUMAN: backup/PITR restore rehearsal with provider writes fenced | Critical | M | `P13-T13` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T15` | HUMAN: planned Cloud SQL failover drill under load | Critical | M | `P13-T13`, `P13-T16` (needs the demonstrated maximum to set the steady rate; if T16 has not run, use the P12 local median and label the rate as such) | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T16` | HUMAN: reference benchmark matrix, soak, and chaos | Critical | L (≈ 1–2 days of cloud time) | `P13-T13` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T17` | HUMAN: ledger contention comparison in the reference environment | Critical | M | `P13-T13` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T18` | Benchmark report (reference) | Critical | M | `P13-T16`, `P13-T17` (blocked until their evidence exists), `P13-T14`, `P13-T15` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T19` | Architecture diagrams | Medium | S | `P13-T08` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T20` | KNOWN_LIMITS linkage | High | S | `P13-T08`, `P13-T10` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T21` | Offline demo script and concise setup instructions | Critical | L | `P12-GATE` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-T22` | Evidence index and README targets linkage | Critical | M | `P13-T21`, `P13-T20`, `P13-T19`; final values depend on `P13-T18` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
| `P13-GATE` | GCP deployment, reference benchmark, and portfolio evidence gate | Critical | M | `P13-T01` … `P13-T22` | [P13-gcp-benchmark-evidence.md](tasks/P13-gcp-benchmark-evidence.md) |
<!-- TASK-INDEX:END -->

---

## 7. Proposed Git commit sequence

One commit per task, in the order below (phase order, then task order). Each commit's exact scope, expected changes, and verification are the corresponding task's **Files**, **Implementation instructions**, and **Testing requirements**. Commits marked ★ are integration checkpoints (§5.5): the full suite for every lane introduced so far must be green there.

Rules: Conventional Commits; body contains `Task: <id>`; never commit a red `pnpm check`; DB-touching commits also keep `pnpm test:integration` green; no commit knowingly leaves an invariant unenforced for a later commit to fix.

<!-- COMMIT-SEQUENCE:BEGIN -->
| # | Task | Commit message |
| ---: | --- | --- |
| 1 | `P00-T01` | `chore(repo): initialize pnpm workspace, TypeScript project references, and vitest projects` |
| 2 | `P00-T02` | `chore(repo): enforce package boundaries, money and ledger-DML lint rules, and dependency policy` |
| 3 | `P00-T03` | `feat(repo): add base config parsing, graceful-shutdown lifecycle, and documented env` |
| 4 | `P00-T04` | `feat(repo): add inert NestJS entry points for api and worker applications` |
| 5 | `P00-T05` | `feat(cli): add inert flowledger binary and provider-simulator entry point` |
| 6 | `P00-T06` | `feat(infra): add docker compose with postgres 17, pubsub emulator, jaeger, and simulator database bootstrap` |
| 7 | `P00-T07` | `feat(contracts): generate schema modules and TypeScript types with drift check` |
| 8 | `P00-T08` | `feat(contracts): compile all schemas with format assertion and enforce registry rules` |
| 9 | `P00-T09` | `test(contracts): validate openapi structure, examples, problem codes, and prose examples` |
| 10 | `P00-T10` | `test(contracts): add positive and high-risk negative fixtures for every registered message type` |
| 11 | `P00-T11` | `feat(contracts): add post-schema semantic correlation validator` |
| 12 | `P00-T12` | `feat(security): add prohibited-data fixtures, detector, contract scan, and gitleaks config` |
| 13 | `P00-T13` | `test(contracts): enforce migration file naming, ranges, and ordering` |
| 14 | `P00-T14` | `ci(repo): add fast and integration workflows with gitleaks and contract report artifacts` |
| 15 | `P00-GATE` ★ | `test(repo): verify M0 clean-clone static and contract gate` |
| 16 | `P01-T01` | `feat(domain): add domain errors, branded minor-unit money, and seeded property-test harness` |
| 17 | `P01-T02` | `feat(domain): add prefixed ULID identifiers with branded types` |
| 18 | `P01-T03` | `feat(domain): add strict constructors for provider name, idempotency key, correlation id, and timestamp` |
| 19 | `P01-T04` | `feat(domain): implement capture fee and cumulative refund-fee reversal with golden vectors` |
| 20 | `P01-T05` | `feat(domain): add canonical JSON and versioned API request hash with golden vectors` |
| 21 | `P01-T06` | `feat(domain): add canonical ledger entry normalization and posting hash with golden vectors` |
| 22 | `P01-T07` | `feat(domain): add payment aggregate model, invariant checker, and derived summary status` |
| 23 | `P01-T08` | `feat(domain): implement command acceptance guards, exclusion model, and refund reservation` |
| 24 | `P01-T09` | `feat(domain): implement operation claim, ambiguity, resolution, expiry, and discrepancy transitions` |
| 25 | `P01-T10` | `test(domain): add model-based lifecycle, reservation, and fee properties` |
| 26 | `P01-T11` | `feat(domain): add provider result discriminated unions and proof-enforcing constructors` |
| 27 | `P01-T12` | `feat(domain): add retry classification, provider observation normalization, and jittered backoff` |
| 28 | `P01-T13` | `feat(domain): derive stable provider idempotency keys with versioned hashed fallback` |
| 29 | `P01-GATE` ★ | `test(domain): verify M1 domain-ready gate and domain/contract parity` |
| 30 | `P02-T01` | `feat(db): add checksum-guarded migration runner, migrate command, and pg test fixture` |
| 31 | `P02-T02` | `feat(db): add withTransaction retry helper and SQLSTATE domain-error mapping` |
| 32 | `P02-T03` | `feat(db): add 0200 foundation migration with schemas, roles, and helpers` |
| 33 | `P02-T04` | `feat(domain): add API credential generation, parsing, and peppered HMAC digest` |
| 34 | `P02-T05` | `feat(db): add identity merchants and API credentials with scopes, expiry, and revocation` |
| 35 | `P02-T06` | `feat(db): add provider configuration tables and deterministic route selection` |
| 36 | `P02-T07` | `feat(db): add immutable fee-policy versions and per-test merchant fixture` |
| 37 | `P02-T08` | `feat(db): add payments table with monetary checks and immutable bindings` |
| 38 | `P02-T09` | `feat(db): add payment operations with exclusive-operation index and transition guard` |
| 39 | `P02-T10` | `feat(db): add deferred trigger proving exclusive pointer and refund reservation against operations` |
| 40 | `P02-T11` | `feat(db): add API idempotency records with atomic claim and lifetime tombstones` |
| 41 | `P02-T12` | `feat(db): add outbox, inbox, DLQ, replay tables and seeded message-type registry` |
| 42 | `P02-T13` | `feat(db): add messaging.insert_outbox with registry and correlation checks` |
| 43 | `P02-T14` | `feat(db): add merchant-scoped payment repositories and tenant-isolation matrix tests` |
| 44 | `P02-T15` | `feat(cli): add flowledger seed --profile dev and credentials issue/revoke` |
| 45 | `P02-GATE` ★ | `test(db): add P02 gate acceptance tests, populated fixture, and evidence` |
| 46 | `P03-T01` | `feat(ledger): add id generator, jcs serializer, and bucket_for_payment` |
| 47 | `P03-T02` | `feat(ledger): add ledgers, accounts, account_balances, and logical balance view` |
| 48 | `P03-T03` | `feat(ledger): seed ledger and striped platform buckets from ledger_bucket_count` |
| 49 | `P03-T04` | `feat(ledger): add journal_transactions and journal_entries with immutability` |
| 50 | `P03-T05` | `feat(ledger): add canonicalize_lines and posting_hash with golden vectors` |
| 51 | `P03-T06` | `feat(ledger): add private post_journal_internal with locking, balances, and outbox` |
| 52 | `P03-T07` | `feat(ledger): add capture/refund recipes, fee reversal, and recipe resolution` |
| 53 | `P03-T08` | `test(ledger): add concurrency, retry, and property tests for posting and buckets` |
| 54 | `P03-T09` | `feat(ledger): add correction_requests and post_approved_correction` |
| 55 | `P03-T10` | `feat(ledger): add rebuild_balance_projection and crash-point tests` |
| 56 | `P03-T11` | `feat(cli): add flowledger verify with journal, projection, and bucket classes` |
| 57 | `P03-T12` | `feat(db): add payment totals, reservation, and posting cardinality verify classes` |
| 58 | `P03-T13` | `feat(db): add orphan detection and settlement membership verify classes` |
| 59 | `P03-T14` | `feat(db): add duplicate_financial_effects verify class with ground-truth interface` |
| 60 | `P03-T15` | `ci: run pnpm verify:ledger in the integration job` |
| 61 | `P03-GATE` ★ | `test(ledger): add P03 gate suite and evidence` |
| 62 | `P04-T01` | `feat(api): bootstrap nest fastify api with request context and problem details` |
| 63 | `P04-T02` | `feat(api): add strict json parser with duplicate-key and size rejection` |
| 64 | `P04-T03` | `feat(api): validate requests against openapi and reject prohibited payment data` |
| 65 | `P04-T04` | `feat(api): authenticate bearer credentials with constant-time digest and scopes` |
| 66 | `P04-T05` | `feat(domain): encrypt payment method references and validate sandbox tokens` |
| 67 | `P04-T06` | `feat(db): add merchant-scoped payment and operation representation functions` |
| 68 | `P04-T07` | `feat(db): add protected create_payment with idempotent replay and outbox` |
| 69 | `P04-T08` | `test(db): prove deterministic provider route selection and rollover safety` |
| 70 | `P04-T09` | `feat(api): add idempotent payment creation endpoint` |
| 71 | `P04-T10` | `feat(api): add payment and operation retrieval with etag conditional get` |
| 72 | `P04-T11` | `feat(api): add encrypted snapshot cursor pagination for payment lists` |
| 73 | `P04-T12` | `feat(api): add bounded payment timeline endpoint` |
| 74 | `P04-T13` | `feat(obs): log api requests through the redaction allowlist` |
| 75 | `P04-T14` | `test(api): add openapi response conformance suite for p04 operations` |
| 76 | `P04-GATE` ★ | `test(api): verify p04 merchant api milestone end to end` |
| 77 | `P05-T01` | `feat(db): add protected accept_operation for authorize and cancel` |
| 78 | `P05-T02` | `feat(db): accept capture with fee snapshot and refunds under reservation guard` |
| 79 | `P05-T03` | `feat(api): add durable 202 command acceptance endpoints` |
| 80 | `P05-T04` | `test(api): prove exclusion and reservation guard under concurrent acceptance` |
| 81 | `P05-T05` | `test(api): inject failures after every acceptance statement` |
| 82 | `P05-T06` | `feat(messaging): add transport interface, in-memory transport, and topology` |
| 83 | `P05-T07` | `feat(messaging): add pubsub transport with ordered publish and topology bootstrap` |
| 84 | `P05-T08` | `feat(messaging): add outbox relay with skip-locked leases and retry schedule` |
| 85 | `P05-T09` | `feat(db): add protected inbox recording and dead-letter insertion functions` |
| 86 | `P05-T10` | `feat(messaging): add inbox consumer framework with dlq and version-gap parking` |
| 87 | `P05-T11` | `feat(worker): add sweeper that re-enqueues stale requested operations` |
| 88 | `P05-T12` | `feat(api): add operation accepted entries to the payment timeline` |
| 89 | `P05-GATE` ★ | `test(messaging): verify p05 durable acceptance and messaging milestone` |
| 90 | `P06-T01` | `feat(providers): add provider-neutral interface and capability validation` |
| 91 | `P06-T02` | `feat(config): add execution crash-point catalog and SQL fault points` |
| 92 | `P06-T03` | `feat(infra): bootstrap provider simulator database and migrations` |
| 93 | `P06-T04` | `feat(providers): add provider simulator core state machine` |
| 94 | `P06-T05` | `feat(providers): serve provider simulator over HTTP with postgres state` |
| 95 | `P06-T06` | `feat(providers): add seeded server-side fault injection to simulator` |
| 96 | `P06-T07` | `feat(providers): emit signed simulator webhooks with seeded delivery faults` |
| 97 | `P06-T08` | `feat(providers): add fake and unreliable adapters with outcome classification` |
| 98 | `P06-T09` | `feat(providers): add adapter lookup, authorization status, and webhook verification` |
| 99 | `P06-T10` | `test(providers): add shared adapter conformance suite` |
| 100 | `P06-T11` | `feat(db): add provider attempts and append-only provider evidence` |
| 101 | `P06-T12` | `feat(db): add provider notification, event claim, and identity conflict tables` |
| 102 | `P06-T13` | `feat(db): add protected claim, dispatch, defer, and evidence staging functions` |
| 103 | `P06-T14` | `feat(db): add evidence application for authorize/cancel and same-operation retry scheduling` |
| 104 | `P06-T15` | `feat(worker): add execution function wrappers and payment-method decryption` |
| 105 | `P06-T16` | `feat(worker): execute authorize and cancel operations against providers` |
| 106 | `P06-T17` | `feat(worker): add per-account limits, merchant fairness, and circuit breaking` |
| 107 | `P06-T18` | `feat(worker): add due-work scheduler and staged evidence recovery loop` |
| 108 | `P06-T19` | `feat(api): add provider attempt, evidence, and resolution timeline entries` |
| 109 | `P06-GATE` ★ | `test(worker): add P06 provider-ready gate scenarios and evidence` |
| 110 | `P07-T01` | `feat(ledger): add evidence-bound post_payment_operation entry point` |
| 111 | `P07-T02` | `feat(db): apply capture evidence with ledger posting and remainder release` |
| 112 | `P07-T03` | `feat(db): apply refund evidence with fee reversal and reservation release` |
| 113 | `P07-T04` | `feat(worker): execute capture and refund operations` |
| 114 | `P07-T05` | `feat(cli): enable reservation, posting cardinality, and duplicate-effect verify classes` |
| 115 | `P07-T06` | `feat(testkit): add polling helpers, api client, and lifecycle fixtures` |
| 116 | `P07-T07` | `feat(api): add ledger posting timeline entries` |
| 117 | `P07-T08` | `feat(cli): add flowledger demo lifecycle command` |
| 118 | `P07-GATE` ★ | `test(e2e): add P07 local lifecycle gate scenarios and evidence` |
| 119 | `P08-T01` | `test(providers): add simulator scripting for ambiguity and expiry scenarios` |
| 120 | `P08-T02` | `feat(db): add reconciliation cases and activity tables` |
| 121 | `P08-T03` | `feat(db): add recovery epoch fence for provider dispatch` |
| 122 | `P08-T04` | `feat(db): add mark_unknown with atomic reconciliation case` |
| 123 | `P08-T05` | `feat(worker): route ambiguous results to mark_unknown and fence dispatch` |
| 124 | `P08-T06` | `feat(db): add stale pre-dispatch requeue and stale requested republish` |
| 125 | `P08-T07` | `feat(worker): add stale operation and staged evidence sweepers` |
| 126 | `P08-T08` | `feat(db): add reconciliation case claim and observation functions` |
| 127 | `P08-T09` | `feat(db): resolve reconciliation cases in apply_provider_evidence` |
| 128 | `P08-T10` | `feat(db): add require_operation_review transition` |
| 129 | `P08-T11` | `feat(db): add guarded authorization expiry transition` |
| 130 | `P08-T12` | `feat(reconciler): resolve unknown operations by read-only lookup` |
| 131 | `P08-T13` | `feat(reconciler): check authorization expiry cases` |
| 132 | `P08-T14` | `feat(cli): add reconciliation case operator commands` |
| 133 | `P08-T15` | `feat(cli): add disaster recovery fence and restored-window reconciliation` |
| 134 | `P08-T16` | `test(chaos): add worker crash-point and ambiguity convergence suite` |
| 135 | `P08-T17` | `feat(db): add record_discrepancy and route contradictory evidence` |
| 136 | `P08-GATE` ★ | `test(reconciler): verify M8 ambiguity and reconciliation gate` |
| 137 | `P09-T01` | `feat(db): add merchant webhook endpoints, deliveries, and attempts` |
| 138 | `P09-T02` | `feat(db): add protected provider notification receipt` |
| 139 | `P09-T03` | `feat(providers): verify provider webhooks against endpoint secret versions` |
| 140 | `P09-T04` | `feat(webhooks): add provider webhook receiver` |
| 141 | `P09-T05` | `feat(db): add provider notification correlation and quarantine` |
| 142 | `P09-T06` | `feat(webhooks): process verified provider notifications into evidence` |
| 143 | `P09-T07` | `feat(db): add merchant webhook delivery functions` |
| 144 | `P09-T08` | `feat(webhooks): project domain events into merchant webhook deliveries` |
| 145 | `P09-T09` | `feat(domain): add merchant webhook signature with golden vectors` |
| 146 | `P09-T10` | `feat(webhooks): add ssrf-safe bounded webhook http client` |
| 147 | `P09-T11` | `feat(webhooks): dispatch signed merchant webhooks with bounded retries` |
| 148 | `P09-T12` | `feat(cli): add merchant webhook endpoint and replay commands` |
| 149 | `P09-T13` | `feat(cli): add operation-aware dlq replay` |
| 150 | `P09-T14` | `test(webhooks): add three-source race and duplicate delivery suite` |
| 151 | `P09-GATE` ★ | `test(webhooks): verify M9 webhook gate and end-to-end readiness` |
| 152 | `P10-T01` | `test(contracts): verify settlement event and SETTLEMENT ledger type wiring` |
| 153 | `P10-T02` | `feat(settlement): add settlement runs, batches, and immutable membership tables` |
| 154 | `P10-T03` | `feat(ledger): accept SETTLEMENT recipe in canonical posting` |
| 155 | `P10-T04` | `feat(settlement): add run scheduling, SKIP LOCKED claim, and stale sweep functions` |
| 156 | `P10-T05` | `feat(settlement): add protected post_batch with anti-join selection and deferral` |
| 157 | `P10-T06` | `test(settlement): add settlement crash-point chaos suite` |
| 158 | `P10-T07` | `feat(settlement): implement settlement worker scheduler and stale-run sweeper` |
| 159 | `P10-T08` | `test(settlement): add randomized settlement property tests` |
| 160 | `P10-T09` | `feat(cli): enable settlement-membership class in flowledger verify` |
| 161 | `P10-T10` | `feat(api): add SETTLEMENT entries to the payment timeline` |
| 162 | `P10-T11` | `feat(security): add append-only operator action audit table` |
| 163 | `P10-T12` | `feat(cli): add audited outbox republish and DLQ replay operator commands` |
| 164 | `P10-T13` | `feat(cli): add reconciliation reschedule, settlement trigger, and evidence inspection commands` |
| 165 | `P10-T14` | `feat(ledger): add named two-principal correction request and approval commands` |
| 166 | `P10-T15` | `docs(runbooks): add executable settlement and discrepancy runbooks` |
| 167 | `P10-T16` | `docs(runbooks): add executable operation-recovery runbooks` |
| 168 | `P10-T17` | `docs(runbooks): add executable provider outage and webhook incident runbooks` |
| 169 | `P10-T18` | `docs(runbooks): add executable messaging backlog and DLQ runbooks` |
| 170 | `P10-GATE` ★ | `test(settlement): add M10 gate verification and evidence note` |
| 171 | `P11-T01` | `docs(security): add focused threat model` |
| 172 | `P11-T02` | `feat(security): add MFA-bound operator token verification and session binding` |
| 173 | `P11-T03` | `feat(security): require authenticated operator principal for audited commands` |
| 174 | `P11-T04` | `feat(security): add authenticated read-only operator views for payments and ledger` |
| 175 | `P11-T05` | `feat(security): add authenticated operator views for messaging, webhooks, settlement, and reconciliation` |
| 176 | `P11-T06` | `feat(obs): propagate correlation, causation, and trace context end to end` |
| 177 | `P11-T07` | `feat(obs): add metrics registry, collector pipeline, and API/database metrics` |
| 178 | `P11-T08` | `feat(obs): add messaging, provider, worker, and webhook metrics` |
| 179 | `P11-T09` | `feat(obs): add ledger posting and bucket lock-wait metrics` |
| 180 | `P11-T10` | `feat(obs): add operation, refund reservation, and reconciliation metrics` |
| 181 | `P11-T11` | `feat(obs): add settlement metrics and flowledger verify metric export` |
| 182 | `P11-T12` | `feat(obs): add provisioned Grafana dashboards as code` |
| 183 | `P11-T13` | `feat(obs): add Prometheus alert rules with contracted thresholds and runbook links` |
| 184 | `P11-T14` | `test(obs): prove alerts fire under fault injection and runbook signals move` |
| 185 | `P11-T15` | `test(security): add catalog-driven cross-tenant isolation suite` |
| 186 | `P11-T16` | `test(security): prove secrets and prohibited data are absent from captured telemetry` |
| 187 | `P11-T17` | `ci(security): add dependency, container, IaC, and secret scans` |
| 188 | `P11-T18` | `docs: add known-limits document mapped to contract sections` |
| 189 | `P11-GATE` ★ | `test(obs): add M11 gate verification and evidence note` |
| 190 | `P12-T01` | `test(chaos): audit crash-point coverage and add seeded rate-based fault plan` |
| 191 | `P12-T02` | `perf(infra): add connection budget model with enforced bounded pools` |
| 192 | `P12-T03` | `feat(cli): add perf seed profile for benchmark merchants and credentials` |
| 193 | `P12-T04` | `feat(providers): add simulator test endpoint for latency and fault profiles` |
| 194 | `P12-T05` | `perf(test): add local system orchestrator for load and chaos runs` |
| 195 | `P12-T06` | `perf(test): add performance runner with manifest, k6 invocation, and rate accounting` |
| 196 | `P12-T07` | `perf(test): run flowledger verify during and after load and enforce stop conditions` |
| 197 | `P12-T08` | `perf(obs): capture postgres metrics and boundary timings for load runs` |
| 198 | `P12-T09` | `perf(ledger): add pg_locks-based balance-row lock-wait sampler` |
| 199 | `P12-T10` | `test(ledger): prove cross-system duplicate-effect detector conditions and exclusions` |
| 200 | `P12-T11` | `perf(test): prepare benchmark dataset through the real API and snapshot it` |
| 201 | `P12-T12` | `perf(test): add uniform-acceptance k6 profile` |
| 202 | `P12-T13` | `perf(test): add confirmed-processing k6 profile` |
| 203 | `P12-T14` | `perf(test): add duplicate-storm k6 profile` |
| 204 | `P12-T15` | `perf(test): add hot-merchant and hot-payment k6 profiles` |
| 205 | `P12-T16` | `perf(test): add refund-fanout k6 profile` |
| 206 | `P12-T17` | `perf(test): add settlement-live k6 profile with throughput phase` |
| 207 | `P12-T18` | `perf(test): add provider-degradation k6 profile` |
| 208 | `P12-T19` | `test(chaos): add crash-redelivery workload runner` |
| 209 | `P12-T20` | `perf(test): add soak profile with bounded-growth analysis` |
| 210 | `P12-T21` | `perf(ledger): add controlled contention comparison runner` |
| 211 | `P12-T22` | `perf(docs): add benchmark report generator from run artifacts` |
| 212 | `P12-T23` | `ci(perf): add nightly regression load and settlement-live jobs` |
| 213 | `P12-T24` | `perf(<scope>): <one change> (<metric> <before> -> <after>)` — one commit per change; scope is the area changed (`db`, `api`, `messaging`, `worker`, `obs`, …)` |
| 214 | `P12-T25` | `docs(perf): record three local preflight trials` |
| 215 | `P12-T26` | `docs(perf): record local soak, contention pair, and workload profile runs` |
| 216 | `P12-GATE` ★ | `test(perf): add P12 gate verification and evidence note` |
| 217 | `P13-T01` | `build(infra): add single parameterized Dockerfile for all apps` |
| 218 | `P13-T02` | `build(infra): export messaging topology and connection budget for terraform` |
| 219 | `P13-T03` | `feat(cli): add set-role-passwords command for deployed environments` |
| 220 | `P13-T04` | `feat(infra): add terraform foundation for networking, registry, and evidence storage` |
| 221 | `P13-T05` | `feat(infra): add regional HA Cloud SQL PostgreSQL 17 and simulator instance` |
| 222 | `P13-T06` | `feat(infra): add pubsub topics, ordered subscriptions, and dead-letter topics` |
| 223 | `P13-T07` | `feat(infra): add per-process service accounts, secrets, and least-privilege IAM` |
| 224 | `P13-T08` | `feat(infra): add cloud run services and migrate/verify jobs within the connection budget` |
| 225 | `P13-T09` | `feat(infra): add otel collector sidecar, cloud dashboards, and alert policies` |
| 226 | `P13-T10` | `feat(infra): add ops vm and reference target for performance runner` |
| 227 | `P13-T11` | `feat(infra): add deploy bootstrap script, iam isolation verifier, and DEPLOY.md` |
| 228 | `P13-T12` | `feat(infra): add restore-rehearsal and failover-drill scripts with probes` |
| 229 | `P13-T13` | `docs(evidence): record reference environment provisioning and deployment verification` |
| 230 | `P13-T14` | `docs(evidence): record PITR restore rehearsal with fenced provider writes` |
| 231 | `P13-T15` | `docs(evidence): record planned cloud sql failover drill under load` |
| 232 | `P13-T16` | `docs(evidence): record reference benchmark trials, soak, and chaos runs` |
| 233 | `P13-T17` | `docs(evidence): record reference ledger contention comparison` |
| 234 | `P13-T18` | `docs(perf): publish reference benchmark report from evidence` |
| 235 | `P13-T19` | `docs(arch): add architecture and deployment diagrams` |
| 236 | `P13-T20` | `docs(limits): link known limits to deployment and benchmark evidence` |
| 237 | `P13-T21` | `feat(demo): add offline deterministic demo script and quickstart` |
| 238 | `P13-T22` | `docs(evidence): add evidence index and link README claims` |
| 239 | `P13-GATE` ★ | `test(evidence): add P13 gate verification and evidence note` |
<!-- COMMIT-SEQUENCE:END -->

---

## 8. Testing and quality assurance plan

The normative test strategy is `docs/09`; failure-injection requirements are `docs/08` §Required failure-injection tests. This section fixes where tests live, what each lane runs, and the per-feature matrix. Every phase file names the exact test files and cases.

### 8.1 Lanes and quality gates

| Lane | Command | Runs | When | Target duration (`docs/10`) |
| --- | --- | --- | --- | --- |
| Fast PR | `pnpm check` | lint, typecheck, contract drift, unit + property (fixed seeds), contract tests, gitleaks, prohibited-data scan | Every PR | < 10 min |
| DB/domain PR | `pnpm test:integration` then `pnpm verify:ledger` (P03+) | Real PostgreSQL 17: migrations from empty + previous fixture, role/RLS, concurrency, crash-rollback | PRs touching SQL, `packages/database`, domain, or DB apps | < 25 min |
| Nightly | `pnpm test:e2e && pnpm test:chaos && pnpm test:performance regression-15m` | Full e2e matrix (fake + unreliable), emulator redelivery, crash points, settlement under traffic, verify on populated DB, dependency/container/IaC scans | Scheduled | — |
| Release/evidence | `pnpm test:performance <profile>` ×3 + soak | Reference benchmark, chaos, rebuild, duplicate-effect audit, restore rehearsal | P13 and material infra changes | — |

Quality-gate mapping: §3.3. No performance result waives a correctness gate (`docs/09`).

### 8.2 Feature test matrix

Levels: U = unit/property, I = PostgreSQL integration, C = contract (OpenAPI/schema/conformance), E = e2e, X = chaos/crash, P = performance, M = manual/scripted procedure.

| Feature | Expected behavior | Success | Failure | Boundary / edge | Security | Data integrity | Levels | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Money & IDs | Exact bigint minor units; prefixed ULIDs | Valid parse/format | JSON number, negative, >1e12, malformed, non-USD, wrong prefix, ULID first char >7 | 0, 1, 1e12, 1e12+1 | Never logged raw | No `number` arithmetic | U, C | P01 |
| Fees | Capture fee snapshot; cumulative proportional refund reversal | Golden vectors | fee policy with fixed > minimum rejected at insert | half-unit rounding; fee == gross; full refund reverses full fee | — | Σ reversals = F on full refund, any order | U, I | P01, P05, P07 |
| Payment creation | `201`, payment v1, `payment.created.v1` | Replay byte-equal | Changed body same key → `409 IDEMPOTENCY_CONFLICT`; missing default route | 100 concurrent identical → 1 payment | Wrong tenant `404`; scope `403`; raw PAN rejected, not logged | Immutable bindings | I, C, E | P04 |
| Command acceptance | `202` only after full tx | One operation + 2 outbox rows | Stale new-key `If-Match` → `412`; guard fail `409 MONETARY_GUARD_FAILED`; below minimum `422 CAPTURE_BELOW_MINIMUM` | 4th authorization rejected; replay after version advance returns stored `202` | Tenant scope | Rollback at every injected statement | I, C, X | P05 |
| Exclusion & reservation | One unresolved exclusive op; refunds bounded by guard | Concurrent fitting refunds all accepted | Exclusive blocked by unresolved refund and vice versa; over-refund rejected **by guard** | `refunded + reserved == captured` exactly | — | Deferred trigger rejects drift at commit | I, U(property) | P02, P05, P07 |
| Outbox/inbox | Stable envelope IDs; dedupe by `(consumer, envelope_id)` | Event reaches consumer once | Unknown version/invalid → DLQ, no effect | Relay crash after publish → same envelope ID republished | Strict schemas; redaction | Version gaps parked | I, X, E | P05 |
| Provider execution | Claim → dispatch mark → call → evidence → apply | Authorize/cancel confirmed | Capability mismatch fails pre-attempt; open circuit leaves work queued | `RETRYABLE_NO_EFFECT` respects `notBefore` | Token decrypted only for authorize; no credentials in evidence | Same provider key on every transport retry | U, C, I, X | P06 |
| Capture/refund posting | Totals + journal + balances + events in one tx | Exact journal once | Rejection/failure → no ledger, reservation released | Partial capture releases remainder; 100× duplicate response → 1 posting | Protected posting only | `verify` zero findings; rebuild == projection | I, E, X | P07 |
| Ambiguity & reconciliation | Possible dispatch → `UNKNOWN`; read-only resolution | Lookup success posts once | Exhaustion → `REQUIRES_REVIEW`, holds kept | Direct/lookup race → one effect | Operator escalation audited, no outcome input | One open case per `UNKNOWN` op | I, X, E | P08 |
| Authorization expiry | Only explicit verified expiry changes payment | `EXPIRED`, voided = authorized, event | `ACTIVE`/`INCONCLUSIVE` reschedule only | Expiry vs capture/cancel race serializes | Signed/authoritative evidence only | Auth operation version unchanged | I, X | P08 |
| Provider webhooks | Verified, deduped, correlated post-verification | 100× same event → 1 effect | Tampered/expired/oversized/unknown endpoint rejected before effect | Uncorrelated → quarantine | HMAC raw body, replay window, allowlist | No invented merchant/payment | I, C, E, X | P09 |
| Merchant webhooks | Signed immutable snapshot, retries | Delivered `2xx` | `3xx`/other `4xx` terminal; `408/425/429/5xx`/network retry | `Retry-After` capped 1 h; 64 KiB; 10 s | HTTPS, no redirects, SSRF ranges rejected after DNS | Identical `body_bytes` across retries | U, I, E | P09 |
| Settlement | Clearing→payable batch or `DEFERRED` | Batch amount = recomputed member net | Net ≤ 0 defers, no membership | Late refund → clearing negative, closed batch untouched | Settlement role isolated | No movement in two batches; payable non-decreasing | I, X, U(property), P | P10 |
| Ledger core | Balanced immutable postings, striped buckets | Posting-key replay returns original | Unbalanced/cross-currency/cross-merchant/closed/negative-protected rejected | N=1 and N=32; 100 concurrent identical postings → 1 | DML revoked for every runtime role | Bucket sums == view == rebuild | I, U(property) | P03 |
| Invariant checker | Per-class counts; nonzero exit on finding | Zero findings on valid data | Each corrupted fixture detected by the correct class | Absent tables → "0 rows checked" | Ground truth only via harness DB | Duplicate-effect detector can be nonzero | I | P03, P07, P10 |
| Observability & operator | Trace continuity, metrics, alerts, audited commands | One linked trace | Alert fires under injected fault | No IDs as labels | Operator MFA claim; no merchant creds; no tenant override header | Audit append-only | I, E, M | P11 |
| Performance & chaos | Open-model workloads with audits | Targets measured (not assumed) | Any stop condition invalidates run | N=1 vs N=32 identical except N | No prohibited data in telemetry under load | `verify` during and after | P, X | P12, P13 |

Cross-cutting test categories and where they are mandatory: invalid input (P01, P04, P05, P09); authn/authz failures (P04, P09, P11); provider failures/timeouts (P06, P08); DB errors and rollback (P05, P07, P10 crash injection); duplicates/idempotency (P04, P05, P07, P09); concurrency/races (P02, P03, P05, P07, P08, P09, P10); empty states (P04 list/timeline, P10 deferral); network interruption (P05 relay, P06 provider, P09 dispatcher); performance bottlenecks (P12); accessibility/responsive — **not applicable** (no UI in scope).

### 8.3 Test infrastructure decisions

- Testcontainers PostgreSQL 17, one container per test run, migrations applied once into a template database, one cloned database per test file, per-test merchant isolation (P02 builds `packages/testkit/src/pg.ts`).
- Randomized tests persist seed + minimized counterexample on failure (`docs/10` M1); fixed regression seeds in the fast lane.
- Crash points: `crashPoint(name)` in `packages/config/src/crash-points.ts` (armed via `packages/testkit`), plus SQL `payments.fault_point(name)`; active only with `FLOWLEDGER_FAULT_HOOKS=1`; names come from `docs/08` crash matrix (introduced in P05–P10 where the code is written).
- Ground truth for duplicate-effect detection: simulator DB via `SIMULATOR_DATABASE_URL` (`CONVENTIONS.md` §16).

---

## 9. Integration and deployment plan

### 9.1 Environment setup (local, offline, no credentials)

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm db:up                 # PostgreSQL 17 (FlowLedger + simulator DBs), Pub/Sub emulator, OTel stack
pnpm db:migrate            # applies migrations/ in order (P02+)
pnpm db:seed               # dev merchants, credentials, fake provider routes (P02+)
pnpm check && pnpm test:integration
```

All commands above are **proposed** and created by P00/P02; none exist today.

### 9.2 Migrations

- Forward-only SQL, checksum-guarded runner, numbering by phase (`CONVENTIONS.md` §8).
- Local/CI: `pnpm db:migrate`. Tests: Testcontainers fixture applies all migrations.
- Each DB phase adds an "apply from previous checked-in populated fixture" test (`docs/10` CI lanes) — the fixture is a SQL dump committed at each phase gate under `test/fixtures/db/<phase>.sql`.
- GCP: dedicated Cloud Run job runs migrations as `fl_migration_owner` before service rollout; application startup never migrates (`docs/10` M13).
- Expand/backfill/validate/contract for non-null columns on large tables (`docs/07` §Migration order).

### 9.3 CI/CD

- GitHub Actions (P00): `fast` job (`pnpm check`), `integration` job (Docker; `pnpm test:integration`, `pnpm verify:ledger`), nightly workflow (e2e, chaos, 15-min regression load, scans), manual release/evidence workflow (P13).
- Contract validation report and `verify --json` output retained as CI artifacts.
- CD to GCP (P13): build one image per app, push to Artifact Registry, run migration job, deploy Cloud Run revisions, run smoke + `verify`.

### 9.4 Release verification

A release is accepted only when: migration job succeeded; health/readiness green on every service; smoke scenario (create→authorize→capture→refund) completes; `flowledger verify --require-ground-truth` reports zero findings; dashboards show zero `duplicate_financial_effects_total`.

---

## 10. Risks and open questions

Phase-specific risks live in each phase file. This section lists plan-wide conflicts, gaps, and decisions. **Severity:** High = blocks correctness or a phase gate; Medium = blocks a task; Low = clarification.

### 10.1 Conflicts between specifications

| ID | Conflict | Sources | Impact | Severity | Recommended resolution | Blocks |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | `docs/07` §Migration order puts all protected functions (step 16) and grants (step 17) after every table, but `docs/10` ships tables milestone by milestone | `docs/07` §Migration order steps 16–17; `docs/10` M2–M10 | Following `docs/07` literally means no milestone can be tested until all tables exist | Medium | Apply the same ordering **inside each migration file** (tables → constraints → triggers → functions → RLS → grants). Adopted in `CONVENTIONS.md` §8 | None once adopted |
| C-03 | Bucket count is "a migration … never a runtime setting", yet the benchmark compares N=1 and N=32 "from the same commit" | `docs/02` §MVP decisions (N=32); `docs/10` M12; `docs/09` contention section | Without a mechanism, comparison needs two commits | Medium | Seed migration reads `flowledger.ledger_bucket_count` set by the migrate runner from `LEDGER_BUCKET_COUNT` (default 32); fixed per database; comparison uses two databases. `CONVENTIONS.md` §8 | P03 seed task, P12 contention pair |
| C-04 | Dual approval for ledger corrections: required in M3/M10 and `docs/07` (distinct-principal check), but "dual-approval operator tooling" is deferred in README and M11, which says the workflow is "single-principal" while the distinct-principal check exists | `docs/10` lines 244, 249, 462, 480, 501; `docs/07` §correction_requests, §Protected posting function; README §Deliberate limits | A DB distinct-principal check makes a single-principal workflow impossible; agents could drop the check or build full tooling | **High** | Keep the DB check (safety boundary, already in schema). Ship two minimal CLI commands — `correction request` and `correction approve` — run by two different named principals; defer only richer tooling (UI, MFA step-up, notifications). **Decided D-01** | P03 correction entry point, P10/P11 operator commands |
| C-05 | `docs/10` M10 says "Add `settlement.batch.posted.v1` to the schema registry and event catalog" and add the `SETTLEMENT` posting type, but both already exist in `schemas/registry.v1.json` and `schemas/events/*` | `docs/10` M10; `schemas/registry.v1.json` | Agent may duplicate or rewrite contracts | Low | Treat as verify-and-wire, not add (P10 file records this) | — |
| C-06 | `docs/10` repo shape has no CLI app, but `flowledger verify`, migrate, seed, demo, and operator commands are required | `docs/10` §Repository shape vs M3/M7/M10/M11 | Agents invent different homes | Low | `apps/cli` (`CONVENTIONS.md` §3) | — |
| C-07 | Replay bodies "expire" at 90 days and keys tombstone, but archival jobs are deferred and "nothing is deleted in the MVP" | `docs/05` §Retention; ADR-0009; `docs/10` M11 deferred list | `409 IDEMPOTENCY_KEY_EXPIRED` behavior could be left untestable | Medium | Evaluate expiry at read time from `committed_at + 90 days` (no deletion needed); body physically retained until archival exists; tests set `committed_at` in the past via a fixture helper | P02 idempotency table, P04 replay task |

Additional conflicts found by phase writers are recorded in each phase file's risks section and summarized in §10.4.

### 10.2 Gaps (missing requirements)

| ID | Gap | Impact | Severity | Recommended resolution | Blocks |
| --- | --- | --- | --- | --- | --- |
| G-01 | Where the fake provider runs and how its state is shared across worker/reconciler/webhook processes and exposed as ground truth | Duplicate-effect detector and multi-process e2e impossible without it | **High** | Separate `apps/provider-simulator` with own DB; adapters are HTTP clients; ground truth via `SIMULATOR_DATABASE_URL` (`CONVENTIONS.md` §16). **Decided D-02** | P03 duplicate-effect class, P06 onward |
| G-02 | Database role names are required but unnamed (except `ledger_function_owner`) | Divergent role names across migrations | Medium | Role catalog in `CONVENTIONS.md` §7 | P02-T* role migration |
| G-03 | Exact tool/library versions ("current LTS", "a property-testing library such as fast-check") | Divergent dependencies | Low | `CONVENTIONS.md` §2 (Node 24 LTS, PostgreSQL 17, approved list) | P00 |
| G-04 | Operator MFA identity claim: how it is produced and verified offline | P11 operator auth can't be tested locally | Medium | Locally verifiable signed operator token from a dev issuer stub; real IdP deferred (P11 file details). **Decided D-03** | P11 operator auth |
| G-05 | No test commands exist yet | Agents could invent commands | Low | Commands defined once in `CONVENTIONS.md` §4, created by P00 | — |

### 10.3 Decisions (interviewed and recorded 2026-11-08)

All decisions below were made by the project owner on 2026-11-08. Tasks implement the **Decision** column; changing one requires editing this table first in a `docs(plan):` commit.

| ID | Question | Decision | Consequences recorded in | Status |
| --- | --- | --- | --- | --- |
| D-01 | Ledger corrections: dual approval (C-04) | **Keep the DB distinct-principal check; ship two CLI commands, `correction request` and `correction approve`, run by two named operators.** Defer only approver tiers, approval expiry, notifications, and any UI | P03 correction entry point, P10-T14, P11 operator auth; `docs/10` M11 deferral text and README §Deliberate limits to be corrected under D-08 | Decided |
| D-02 | Where the simulated provider runs (G-01) | **Separate `apps/provider-simulator` HTTP service with its own database `flowledger_sim`; adapters are HTTP clients; ground truth via `SIMULATOR_DATABASE_URL` only** | `CONVENTIONS.md` §16; P00, P03, P06, P09, P12, P13 | Decided |
| D-03 | Operator identity (G-04) | **Locally signed operator token from a dev issuer stub, carrying a named principal and `amr` containing `mfa` (+ `otp`), verified before any operator command; a real IdP replaces the issuer later without changing the checks.** Implementation per P11: HS256 compact JWS verified inside PostgreSQL with `pgcrypto` `hmac` (chosen over Ed25519 because PostgreSQL can verify it natively), principal bound to the DB session | P11 operator-auth task; P02 creates `pgcrypto` | Decided |
| D-04 | GCP project and billing for P13 | **Decide later.** P13-T13…T18 and P13-GATE stay blocked; P00–P12 and P13's offline tasks proceed. Revisit after P10-GATE or P12-GATE | P13 file (human-blocked tasks) | Deferred — blocks P13-T13…T18, P13-GATE |
| D-05 | CI host and repo visibility | **GitHub Actions; public repository** | P00 CI task, README §9.3 | Decided |
| D-06 | `merchant.webhook.deliver.v1` ordering key | **Endpoint ID** (machine schemas + `docs/07` + `docs/10` M9 win); correct the prose in `docs/01:237`, `docs/04:79,102,106,365`, `schemas/README.md:86` under D-08 | P02 messaging, P05 relay, P09 projector | Decided |
| D-07 | Fee can exceed gross | **Stricter policy check at insertion:** `floor((minimum·bp + 5000)/10000) + fixed <= minimum` (P01 `checkFeePolicy`, P02 `fee_policies_fee_within_minimum`); correct `docs/02:268` and `docs/07` §fee_policies under D-08 | P01, P02-T07 | Decided |
| D-08 | Contract text fixes | **An agent drafts one `docs(contracts):` commit per fix before P00 starts; the owner reviews and approves each.** Timeline per-kind detail shapes may land just before P04's timeline task. List: §10.6 | §10.6 | Decided — fixes pending review |

### 10.4 Phase-reported conflicts and risks

<!-- PHASE-RISKS:BEGIN -->
Summary of conflicts and gaps reported by phase writers, with the resolution the plan applies. Full detail (file:line on both sides, blocked tasks) is in each phase file's risks section. Rows that depended on an owner decision are now settled by §10.3; remaining contract-text corrections are tracked in §10.6.

| Phase | Issue | Severity | Resolution applied | Affects |
| --- | --- | --- | --- | --- |
| P03 | Prefixes `led_`, `lac_`, `lcr_` used in `docs/07` (L771, L783, L917) but missing from `schemas/common/entity-ids.v1.schema.json` | Medium | Add them to entity-ids schema in a `docs(contracts):` commit before P03 (they never appear on the wire, so the schema is the only gap) | P03 |
| P03 | `docs/07:808` `lpad(bucket_index, 2)` pads with spaces in PostgreSQL | Low | Zero-pad (`lpad(bucket_index::text, 2, '0')`); fix contract text | P03-T01..T03 |
| P03 | `docs/02:140` "exactly one merchant" vs capture with fee == gross having no merchant line | Low | Read as "at most one merchant"; amend contract | P03 posting routine |
| P03 | No posting key defined for adjustments (`docs/02:181-185`) | Low | `ledger:adjustment:{id}` [ASSUMPTION] | P03 correction tasks |
| P03 | Fee-revenue negative policy and rounding "pair" (`docs/02:66,69`) don't fit one `allow_negative` flag | Medium | Fee revenue allows negative; seed one expense + one revenue rounding account | P03 seed |
| P03 | Ledger posting routine lacks settlement batch ID needed by SETTLEMENT event | Medium | P10 extends routine (single-owner surface) | P10 |
| P03 | "Audited" corrections/rebuilds before `audit.*` exists (P11) | Medium | Record actor/reason on `ledger.correction_requests` now; P11 backfills audit linkage | P03, P11 |
| P03 | Bucket derivation entropy unspecified | Medium | Last 16 ULID chars as base-32 big-endian mod N, golden vectors at N=32/7/1 [ASSUMPTION] | P03-T01 |
| P03 | Ground-truth table shape unspecified | Medium | `truth.provider_financial_effects(provider_idempotency_key, effect_count)` in simulator DB; P06 creates it | P03, P06 |
| P02 | Prefixes `mcr_`, `pac_`, `pwe_`, `fee_`, `pev_` in `docs/07` (L132, L218, L240, L290, L707) missing from entity-ids schema | Medium | Same as P03 prefix gap: add to schema in one `docs(contracts):` commit | P02 |
| P02 | `merchant.webhook.deliver.v1` orderingKey: "none" in `docs/04:79`, `schemas/README:86`, `docs/01:237` vs endpoint ID in the command schema (L14), envelope required field (L18), `docs/07:1067,1090` | **High** | Human decision D-06. Machine schema currently requires a key; P02 follows schema + `docs/07`. Recommend: keep schema (endpoint ID key = per-endpoint ordering, which `docs/10` M9 "per-endpoint ordering key" also says) and fix the prose in 01/04/schemas README | P02 messaging, P09 projector/dispatcher |
| P02 | `docs/07:150` asks for a trigger rejecting unknown scopes | Low | CHECK constraint, same effect | P02-T05 |
| P02 | Extensions (pgcrypto) named in `docs/07:1452`, `docs/10:205` not needed on PG 17 | Low | Create none | P02-T03 |
| P02 | Envelope-hash method and DLQ `failure_class` values unspecified | Medium | Chosen in P02 [ASSUMPTION]; P05 must reuse | P02, P05 |
| P02 | Registry must be visible inside DB for `insert_outbox` | Medium | Migration-seeded `messaging.message_types` + parity test vs `schemas/registry.v1.json` [ASSUMPTION] | P02 |
| P02 | Credential digest scheme unspecified | Medium | HMAC-SHA-256 with versioned pepper `API_CREDENTIAL_PEPPERS`, dummy HMAC on miss [ASSUMPTION] | P02, P04 |
| P08 | `payment.discrepancy.detected.v1` requires `caseId` but reconciliation cases are created in P08, while `docs/10` M7 asks P07 to emit discrepancy events | **High** | Move `payments.record_discrepancy` and its event to P08-T09. In P07, contradictory evidence is staged but never applied and never overwrites terminal state; P07 tests assert no overwrite and no event. Deviation from `docs/10` M7 recorded here | P07, P08-T09 |
| P08 | `verifyWebhook` (`docs/06:160`) has no failure result or secret input, yet notifications record verifying secret version (`docs/06:507`) | Medium | One secret per adapter instance; throw on rejection; try candidate versions in order [ASSUMPTION] | P09 receiver |
| P08 | `require_operation_review(case_id, expected_case_version)` (`docs/07:525`) lacks reason/actor though event allows `OPERATOR_ESCALATION` | Medium | Add reason, actor, envelope parameters | P08 |
| P08 | Restore-window reconciliation of terminal operations has no case type (`docs/08` DR step 4) | Medium | Report mismatches and block unfence; no evidence staging | P08-T15 |
| P08 | Recovery fencing epoch table unnamed | Low | `payments.recovery_epochs` [ASSUMPTION] | P08 |
| P09 | Reconcile command reasons ≠ event reason vocabulary; no 409 for webhook content conflict (chose 400); no DLQ replay outcome for "ambiguous, reconciliation scheduled"; `case_activity.activity_type` values prose-only; merchant payload `summaryStatus` not derivable from event alone | Low–Medium | Each resolved inline in P08/P09 tasks with [ASSUMPTION]; contract text should be amended | P08, P09 |
| Plan | Secret-reference scheme: P02 seed uses `local-secret://`, P09 assumed `env://` | Medium | Unified in `CONVENTIONS.md` §11 (`local-secret://`, resolver in P06); P09 file updated | P06, P09 |
| P10 | `docs/10:456-458` "add" settlement event, `SETTLEMENT` posting type, timeline kind — all already exist (`registry.v1.json:33`, ledger event schema, `openapi.yaml:1286`) | Low | Verify-and-wire (P10-T01) | — |
| P10 | `post_batch(run_id, outbox_envelope)` (`docs/07:1038`) lacks lease token required by `docs/07:1040` | Medium | Add `p_lease_token` parameter | P10 |
| P10 | Audit table placed in M11 (`docs/10:492`) but M10 operator commands must be audited (`docs/08:268`) | Medium | Audit table moved to P10-T11 | P10, P11 |
| P10 | `SETTLEMENT` timeline `detail` shape undefined (`docs/05`, `openapi.yaml:1303`) | Medium | Shape chosen [ASSUMPTION]; add to OpenAPI in a contract commit first | P10 timeline task |
| P10 | Run creation before claim and "reclaimed" undefined (`docs/07:989,1338`); batch net could exceed 1e12 cap (`docs/02:331` vs `docs/07:874`); "business hours" thresholds (`docs/08:611,613`) | Medium | Scheduled runs = unleased `CLAIMED` rows, stale → `FAILED`; cap selection; wall-clock hours [ASSUMPTION] | P10, P11 |
| P11 | `docs/09:402-424` describes metrics without names; some `docs/08` alerts have no metric | Medium | Names fixed in P11 metric table (single registry, `CONVENTIONS.md` §12) | P11 |
| P13 | `docs/10:576` asks Terraform for retention archive/quarantine storage, but archival is deferred and quarantine objects are never created (`docs/10:497-500,806`) | Low | Do not provision; record in KNOWN_LIMITS | P13 |
| P12 | Stop conditions `docs/09:437` qualitative; undefined terms "sustained confirmed rate" (`:271`), "ten deliveries" (`:340`), "avoid starvation" (`:369`), "no unbounded growth" (`:388`), "avoid cache-only results" (`:331`) | Medium | Numeric thresholds defined in P12 (R-09, R-12–R-16) — human should review before results are published | P12 runner, P13 report |
| P12 | Per-logical-account lock wait (`docs/09:277`) not attributable from P11 statement timing | Medium | `pg_locks` tuple-lock sampler joined by `ctid`; report both measures, labeled | P12-T09 |
| P12 | DR step 5 (`docs/08:645`) needs outbox republish after restore; no republish command in P08 | Low | Run outbox relay against restored DB (P10 adds republish command) | P13 restore rehearsal |
| P13 | T13–T17 need a human with GCP project + billing (D-04) | **High** for portfolio level | Agent completes offline tasks; human runs provisioning/drills/trials | P13-T13…T18, P13-GATE |
| P01 | **`fee > gross` is reachable** despite `docs/02:268`, `docs/07` fee-policy check, `docs/10` claiming it is not (bp 5000, fixed 30, minimum 30, gross 40 → fee 50) | **High** | Decision D-07: add `floor((minimum*bp+5000)/10000) + fixed <= minimum` to policy insertion (P01 `checkFeePolicy`, P02 `fee_policies_fee_within_minimum`); proven sufficient since `F(G)-G` is non-increasing for bp ≤ 10000. Applied to P01/P02 pending confirmation; amend `docs/02`/`docs/07` | P01, P02, P05 |
| P01 | Refund fee `F*R` reaches 10^24, beyond `bigint` | **High** | SQL intermediate `numeric`, TS `bigint` (`CONVENTIONS.md` §5) | P03 `incremental_fee_reversal`, P07 |
| P00 | Ajv `strict: true` rejects checked-in schemas | Low | Use `strictSchema` only (what `schemas/README.md:21-31` requires) | P00 |
| P00 | Timeline example `docs/05:314` lacks required `truncated` (`openapi.yaml:1241`); per-kind detail shapes promised at `openapi.yaml:1303` not listed in `docs/05:357` | Medium | Fix example; define detail shapes in a contract commit before P04 timeline task | P04, P07–P10 timeline kinds |
| P00 | Byte encodings for request hash (`docs/05:414`), posting hash (`docs/02:187`, `docs/07:887`), provider key (`docs/06:404`) unspecified | Medium | Defined with golden vectors in P01 [ASSUMPTION]; P03 SQL posting hash must reproduce P01 vector | P01, P03 |
| P00 | `openapi.yaml:974` example `pm_sandbox_123` vs `docs/05:684` only `pm_fake_` tokens accepted | Low | Fix example | P00 contract tests |
| P00 | `docs/10:153` asks for a "local adapter" transport; plan uses two transports (in-memory + Pub/Sub emulator) | Low | Emulator *is* the local adapter for cross-process tests; documented in `CONVENTIONS.md` §9 | P05 |
| P00 | Additional prefixes missing from entity-ids schema: `pno`, `req` (beyond those above) | Medium | Include in the single prefix contract commit | P00–P09 |
| P07 | Contradictory evidence in P07 returns `UNAPPLIED_*` without event — deviation from `docs/10:367,384` (event needs `caseId` from P08) | Medium | Accepted; P08-T17 adds discrepancy path; amend `docs/10` M7 | P07, P08 |
| P06 | Duplicate-effect detector keyed only by provider idempotency key cannot attribute a blind retry under a *substituted* key to the original operation — exactly the escape `docs/09` row `P > 1` targets | **High** | Simulator records the FlowLedger payment ID and operation type sent as provider metadata; truth view adds `(payment_ref, operation_type)` and verify also flags >1 effect of the same type per payment beyond allowed cardinality (1 auth success, 1 capture, refunds ≤ count of refund ops). Needs P03 duplicate-effect class + P06 truth view amendment | P03, P06 |
| P06 | `CONFLICT` (`docs/06:414`) not among reconciliation reasons (`docs/06:482`) | Medium | Map to `UNKNOWN` with `ADAPTER_DEFECT` | P06 |
| P06 | Terminal event requires `normalizedError.safeMessage` but no evidence column stores it | Medium | Use error code as safe message; add column in a contract commit if wording matters | P06, P07 |
| P06 | `payment_operations` has no correlation column (`docs/05:499`) | Low | Read correlation from `api.idempotency_records` | P06 |
| P06 | Unnamed functions/codes: direct-response evidence staging, internal SQL codes | Low | `providers.stage_attempt_evidence`; `INTERNAL_*` codes | P06 |
| P06 | Several earlier-phase interface names assumed (P03 posting routine, `merchant.clearing` code, P04 encryption format/timeline module, P05 inbox helper) | **High** until checked | Cross-phase interface reconciliation pass (done in plan review; see §10.4 note) | P06, P07 |
| P05 | `openapi.yaml:272-273` says one unresolved refund at a time; ADR-0003 and `docs/05:263` allow concurrent refunds | **High** | Follow ADR-0003; fix OpenAPI description in a contract commit | P05 refund endpoint |
| P05 | `openapi.yaml:1424-1436` `Problem` oneOf omits `Problem422` | Medium | Add in contract commit before P05 conformance tests | P05 |
| P05 | DLQ stores "redacted" envelope (`docs/07:1127`) vs original envelope (`docs/04:326`, `docs/08` DLQ contract) | Medium | Store original envelope (never contains prohibited data by schema); redact only previews | P05 DLQ |
| P05 | No problem code for 4th authorization or missing fee policy; `causationId` undefined; `docs/04:50` uses nonexistent `cmd_` prefix | Medium | 4th authorization → `INVALID_PAYMENT_STATE` [ASSUMPTION]; others defined in P05 risks | P05 |
| P05 | Operations don't store resulting payment version | Low | `OPERATION_ACCEPTED` timeline entry reads it from outbox row | P05 |
| Plan | Crash-hook module location diverged (P05 `packages/config`, P06/P12 `packages/testkit/src/crash.ts`) | Medium | Unified on `packages/config/src/crash-points.ts` (`CONVENTIONS.md` §3); reconciled in review pass | P05, P06, P12 |
<!-- PHASE-RISKS:END -->

### 10.6 Contract fixes to draft (D-08)

Each row is one `docs(contracts):` commit, drafted by an agent and approved by the owner before the listed task starts. Drafts change contract text only; they never change behavior the plan has not already adopted.

| # | Fix | Files | Before |
| --- | --- | --- | --- |
| 1 | Add database-only and missing ID prefixes (`mcr`, `pac`, `pwe`, `fee`, `pno`, `pev`, `led`, `lac`, `lcr`, `req`) or document them as DB-only | `schemas/common/entity-ids.v1.schema.json` (+ `schemas/README.md`) | P00 |
| 2 | Add required `truncated` to timeline example | `docs/05` §Retrieve a payment timeline | P00 |
| 3 | Add `Problem422` to `Problem` oneOf | `openapi/openapi.yaml` components | P00 |
| 4 | Concurrent-refund wording (ADR-0003) in refund operation description | `openapi/openapi.yaml:272-273` | P00 |
| 5 | Payment-method example `pm_sandbox_123` → `pm_fake_…` | `openapi/openapi.yaml:974` | P00 |
| 6 | Merchant webhook ordering-key prose → endpoint ID (D-06) | `docs/01:237`, `docs/04:79,102,106,365`, `schemas/README.md:86` | P00 |
| 7 | Fee-policy insertion rule and "fee > gross unreachable" text (D-07) | `docs/02:268`, `docs/07` §`payments.fee_policies`, `docs/10` M5 | P00 |
| 8 | Dual-approval wording (D-01): build two-person request/approve; defer only tiers/expiry/notifications/UI | `docs/10` M10/M11 deferred list, README §Deliberate limits | P00 |
| 9 | Discrepancy event moves to M8 (needs `caseId`) | `docs/10` M7/M8 bullets | P00 |
| 10 | `lpad(bucket_index, 2)` → zero padding | `docs/07:808` | P03 |
| 11 | "Exactly one merchant" → "at most one" per posting | `docs/02:140` | P03 |
| 12 | `settlement.post_batch` lease-token parameter | `docs/07:1038` | P10 |
| 13 | DLQ stores original envelope (redact previews only) | `docs/07:1127` | P05 |
| 14 | Per-kind timeline `detail` shapes, including `SETTLEMENT` | `docs/05` §timeline, `openapi.yaml:1303` | P04-T12 (first kinds); P10 (`SETTLEMENT`) |
| 15 | `docs/10` M10 "add settlement event/type/timeline kind" → "verify" (already present) | `docs/10` M10 | P10 |

### 10.5 Plan-wide technical risks

From `docs/10` §Risk register (still valid; mitigations are encoded as tasks): ORM-driven SQL, happy path crowding out recovery, Node event-loop stalls, Cloud Run exhausting Cloud SQL, unrealistic simulator, provider semantics leaking into domain, striping retrofitted, checker written to match implementation, reservation drift, settlement mutating history, single-layer dedupe, benchmark theater, broad AI diffs, scope creep. Additional plan-level risks:

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Phase files written by different authors diverge on shared names | Integration failures at gates | `CONVENTIONS.md` is binding; names come from contracts; §5.4 single-owner surfaces; gate tasks run cross-phase e2e |
| Agents edit contracts to make code pass | Silent spec drift | Contract edits only in dedicated `docs(contracts):` commits approved by a human; CI drift check on generated types |
| Tests that cannot fail | False evidence | DoD item 2: every invariant test must be observed failing with the invariant broken |

---

## 11. Agent execution guide

### 11.1 Before you start a task

1. Confirm every dependency in the task's **Dependencies** line is merged (gate tasks: the gate's evidence note `docs/evidence/Pnn.md` exists).
2. Check §10.3: if your task is listed as blocked by an undecided item, stop.
3. Read `CONVENTIONS.md` in full, then your task, then every contract section in its **Contract references**.
4. Create branch `task/<id-lowercase>-<slug>`.

### 11.2 While implementing

- Change only files under **Files** (plus `docs/CONFIG.md`/`.env.example` for new variables).
- Copy names exactly from contracts; never invent a table, column, function, error code, event type, metric, or ID prefix.
- Money is `bigint`; no `number` in money paths. No provider/merchant HTTP inside a DB transaction. All financial writes through protected functions.
- Write the tests first where the task lists invariants; break the invariant once to see each test fail; restore.
- Stop on any condition in `CONVENTIONS.md` §14 and report `BLOCKED: <id> — <reason> — <refs>`.

### 11.3 Before you commit

```bash
pnpm check
pnpm test:integration          # if you touched SQL, packages/database, or a DB-backed app
pnpm verify:ledger             # P03+ when you touched SQL
```

Then tick the task's **Handoff checklist**, commit with the exact **Commit** line and `Task: <id>` in the body.

### 11.4 Reviewer checklist (from `docs/10` §Merge gate)

- Read the full diff, especially SQL and transaction boundaries.
- Run the tests; do not trust the agent summary.
- No direct writes to payments/journal/settlement/outbox outside protected functions.
- Error paths never turn timeout/connection loss/malformed response into confirmed failure without typed no-effect proof.
- At least one duplicate, one concurrent, and one crash case exercised where the task touches state.
- Ask a separate reviewer to state the linearization point and uniqueness boundary from the code.

### 11.5 Gate tasks

A `Pnn-GATE` task adds no feature code. It runs the phase's end-to-end verification, adds any missing cross-task integration tests, commits the populated DB fixture for the next phase's migration-forward test (DB phases), and writes `docs/evidence/Pnn.md` listing commands run, their output summaries, and commit SHA. A gate is not passed by assertion; it is passed by the committed evidence note plus a green CI run on that commit.
