# P12 — Local performance and chaos readiness

## Phase overview

**Goal.** Build the load, chaos, and measurement harness that docs/09 requires, prove it end to end against the local stack, use it to remove obvious bottlenecks, and record three local preflight trials. Nothing in this phase is a résumé claim: every local number is labeled with its environment and every target stays labeled as a target (docs/10 §M12 Preflight targets, docs/09 §Reporting template last paragraph).

**Entry criteria.** `P11-GATE` green: every docs/08 §Recovery observability metric is exported, the redaction allowlist and prohibited-data fixtures exist, operator views exist, `flowledger verify` reports every docs/09 class including the duplicate-effect class against simulator ground truth (CONVENTIONS §16), and the deterministic crash-point suite (`pnpm test:chaos`) is green.

**Exit gate (docs/10 §M12 exit gate: "Harness, correctness audit, and local preflight pass").** `P12-GATE` proves: every docs/09 workload profile runs through `pnpm test:performance <profile>` with an open arrival model, offered/accepted/completed rates, response validation, and `flowledger verify --require-ground-truth` during and after; the contention pair runs from one commit at bucket counts 1 and 32 with per-logical-account lock-wait distributions; the crash/redelivery runner reaches its injection ratios with zero duplicate financial effects; a local soak shows bounded growth; three local preflight trials are recorded under `docs/evidence/` with raw-artifact hashes.

**Migrations.** None planned. The P12 range `1200`–`1299` is reserved for evidence-driven tuning migrations created by `P12-T24` (index or query-shape changes only), numbered `1200`, `1210`, … in commit order. No other P12 task creates a migration. The lock-wait sampler and PostgreSQL metric capture read system views (`pg_locks`, `pg_stat_*`) through a harness-only admin connection and need no schema.

**Interfaces consumed from earlier phases** (exact names; **[ASSUMPTION]** marks names the contracts do not fix — see risks R-01..R-06):

- `flowledger migrate` (P02-T01; env `MIGRATION_DATABASE_URL`, `LEDGER_BUCKET_COUNT`, `LEDGER_ENVIRONMENT`, CONVENTIONS §8) and `flowledger migrate --simulator` (P06-T03 decision: explicit command, never at simulator startup; connects with `PROVIDER_SIMULATOR_DATABASE_URL`, role `fl_simulator`).
- `flowledger seed --profile dev` (P02-T15) — P12 adds `--profile perf`.
- `flowledger verify --json --require-ground-truth` (P03-T11/T14; ground truth via `SIMULATOR_DATABASE_URL`, read-only role `fl_simulator_truth`, view `truth.provider_financial_effects(provider_idempotency_key, payment_ref, operation_type, effect_count)` from P06-T03). Exit codes 0 (PASS) / 1 (FAIL) / 2 (error). JSON shape fixed by P03-T11 (`packages/database/src/verify/index.ts`): `VerifyReport { schemaVersion: 1, result: 'PASS'|'FAIL', failureReasons: ('FINDINGS'|'GROUND_TRUTH_REQUIRED')[], bucketCount: number|null, classes: ClassResult[], gauges: { unresolvedAmbiguity: number|null } }`, `ClassResult { name, status: 'OK'|'FINDINGS'|'SKIPPED', rowsChecked: number, findings: number, skipReason: null|'TABLE_ABSENT'|'GROUND_TRUTH_UNAVAILABLE', absentTables: string[], samples: Finding[] }`; class names `journal_balance`, `projection_equality`, `bucket_aggregation`, `payment_totals`, `reservation_integrity`, `posting_cardinality`, `orphan_detection`, `settlement_membership`, `duplicate_financial_effects`. P12-T07 still isolates parsing in one function (R-01).
- Crash hooks (CONVENTIONS §3): `crashPoint(name: string)` and the `CRASH_POINTS` name catalog in `packages/config/src/crash-points.ts` (created P05-T08, catalog added P06-T02); `armCrashPoint(name)`/`disarmCrashPoints()` in `packages/testkit/src/crash-points.ts` (in-process arming throws `CrashPointError`); per-process arming `FLOWLEDGER_CRASH_POINTS=<name,…>` sends `SIGKILL` to the process (exit 137); all inert unless `FLOWLEDGER_FAULT_HOOKS=1`. SQL fault points: P06 `public.fault_point(p_name)` driven by GUC `flowledger.fault_point` (`SET LOCAL` or `PGOPTIONS`, migration 0600, P06-T02) and P04 `payments.fault_point` + `packages/testkit/src/sql-fault-hooks.ts`. Named crash points from P05–P10.
- `apps/provider-simulator` (CONVENTIONS §16): HTTP service, DB `flowledger_sim`, roles `fl_simulator`, `fl_simulator_truth`, `POST /__test/clock` behind `SIMULATOR_TEST_ENDPOINTS=1`.
- Built entry points `apps/<app>/dist/main.js` **[ASSUMPTION R-03]**; health endpoints `GET /healthz` / `GET /readyz` on every app (P00: API on `API_PORT`, workers on `HEALTH_PORT`, simulator on `SIMULATOR_PORT`).
- `packages/database/src/pool.ts` (`DATABASE_POOL_MAX`), `packages/database/src/tx.ts` (`withTransaction`, 40001/40P01 retry).
- `packages/messaging/src/topology.ts` (topics `flowledger-commands-v1`, `flowledger-events-v1`, one subscription per consumer, one DLQ topic per subscription).
- `packages/testkit/src/prohibited-data.ts` (synthetic PAN, CVV, bearer token, provider secret).
- Metric names from docs/08 §Recovery observability and the P11 metric catalog (`duplicate_financial_effects_total`, `ledger_bucket_lock_wait{logical_account,bucket}` timed inside the posting routine by P11-T09 migration 1160 and recorded by the `applyProviderEvidence`/`postBatch` TS wrappers, `db_pool_wait`, `db_pool_active_connections`, `db_transaction_retries_total{sqlstate}`, `db_commit_latency`, …).

**Interfaces provided to later phases (P13).**

- `node test/performance/run.mjs <profile> [flags]` (= `pnpm test:performance <profile>`), flags defined in P12-T06, including `--target reference`.
- Profile directories `test/performance/profiles/<profile>/{profile.mjs,script.js}` for: `prepare`, `uniform-acceptance`, `confirmed-processing`, `duplicate-storm`, `hot-merchant`, `hot-payment`, `refund-fanout`, `settlement-live`, `provider-degradation`, `crash-redelivery`, `soak`, `contention`.
- `test/performance/lib/{system,manifest,k6,verify-loop,stop-conditions,pg-metrics,timings,lock-sampler,dataset,report}.mjs`.
- `node test/performance/report.mjs <runId...>` producing the docs/09 §Reporting template.
- `infra/connection-budget.json` (local + reference sections) and its checker.
- Env vars `PERF_ADMIN_DATABASE_URL`, `PERF_SIMULATOR_ADMIN_DATABASE_URL`, `PERF_API_BASE_URL`, `PERF_SIMULATOR_BASE_URL`, `FLOWLEDGER_FAULT_PLAN`.
- Evidence layout: committed `docs/evidence/runs/<runId>/` (small artifacts) + uncommitted `artifacts/perf/<runId>/` (raw k6 output, hashed in the manifest).

### Shared harness rules (restated in every task that touches them)

- **Run ID:** `<UTC yyyymmddTHHMMSSZ>-<profile>-<git short SHA>`.
- **Raw artifacts:** `artifacts/perf/<runId>/` (add `artifacts/` to `.gitignore` in P12-T06). Contains `k6-raw.ndjson.gz`, app logs, sampler NDJSON.
- **Committed evidence:** `docs/evidence/runs/<runId>/` containing `manifest.json`, `k6-summary.json`, `timeseries.csv`, `verify-during.ndjson`, `verify-after.json`, `stop-conditions.json`, `pg-metrics.json`, `timings.json`, `lock-wait-summary.json` (when sampled), `result.json`. `manifest.json` records the SHA-256 of every raw file left in `artifacts/`.
- **Result status** (`result.json.status`): `PASS` (no stop condition fired and the profile's own correctness criteria hold), `FAILED` (a docs/09 §Stop conditions entry or a profile correctness criterion fired — `result.json.failedBy` names it), `INVALID` (run is not evidence: `--smoke`, dirty tree, k6/PG version mismatch, missing ground truth). A target miss never changes the status; targets are reported separately as `targets: [{ name, target, measured, met: boolean }]` where `measured` is copied from artifacts, never typed by hand.
- **Environment label:** `manifest.environment` is `local-<hostname-hash>` or `reference-gcp`; a local run can never be labeled `reference`.

---
### P12-T01 — Crash-point coverage audit, rate-based fault plan, production guard

**Task ID:** `P12-T01`
**Feature:** Deterministic fault-injection hooks at every named crash point
**Commit:** `test(chaos): audit crash-point coverage and add seeded rate-based fault plan`
**Priority:** Critical
**Dependencies:** `P11-GATE`
**Estimated complexity:** M
**Contract references:** docs/08 §Crash-point matrix (all subsections), §Required failure-injection tests; docs/09 §Crash and redelivery; docs/10 §M12 bullet 3 ("hooks at every named crash point, disabled outside test environments")
**Files:** create: `packages/config/src/fault-plan.ts`, `packages/config/src/fault-plan.test.ts`, `test/chaos/crash-point-coverage.test.ts`; modify: `packages/config/src/crash-points.ts` (`CRASH_POINTS` additions and the plan check only), `packages/config/src/*.ts` (production guard), `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`, protected SQL, any handler logic other than inserting a missing `crashPoint(...)` line

**Objective** — P05–P10 placed `crashPoint(name)` hooks. Before load-level chaos depends on them, prove every docs/08 crash-matrix row that a process can die at has a registered, invoked hook; add a seeded probabilistic mode so the crash/redelivery workload (P12-T19) can kill a deterministic fraction of attempts; and make it impossible to enable hooks in production.

**Implementation instructions**
1. In `test/chaos/crash-point-coverage.test.ts` define `const MATRIX: ReadonlyArray<{ section: string; row: string; point: string | null; reason?: string }>` — one entry per row of every docs/08 crash-point table (API acceptance, Transactional outbox, Worker claim and provider dispatch, Provider result resolution, Provider webhook ingestion and processing, Ledger and balance projection, Settlement, Message acknowledgement and DLQ, Merchant webhook delivery). `point` is the registered name from `CRASH_POINTS`; `null` only for rows that are not process-death points (e.g. "Response is attempted before commit — Forbidden implementation", "Signature is invalid", "Late webhook agrees"), each with a `reason` string.
2. The test asserts: (a) every `MATRIX.point` is in `CRASH_POINTS` or is a SQL fault-point name; (b) every `CRASH_POINTS` entry is referenced by at least one `MATRIX` row; (c) every `CRASH_POINTS` entry appears as a literal `crashPoint('<name>'` in at least one file under `apps/*/src` or `packages/*/src`, and every `MATRIX.point` that is a SQL fault point (P06 `flowledger.fault_point`) appears in a `migrations/*.sql` fault-point check (read files with `node:fs`, no shell grep); (d) rows with `point: null` have a non-empty `reason`.
3. If the audit finds rows with no hook: add the missing `crashPoint('<name>')` call at the boundary the row names and append the name to `CRASH_POINTS`. If more than 5 hooks are missing, stop: `BLOCKED: P12-T01 — crash-point coverage gap > 5 — docs/08 §Crash-point matrix vs packages/config/src/crash-points.ts`.
4. `packages/config/src/fault-plan.ts` (in `packages/config` because `crashPoint` lives there and packages may not import testkit, CONVENTIONS §3):
   ```ts
   export interface FaultPlan { seed: string; points: Record<string, number> } // rate in [0,1]
   export function parseFaultPlan(raw: string | undefined): FaultPlan | null;   // throws on unknown point name or rate outside [0,1]
   export function shouldFire(plan: FaultPlan, point: string, key: string): boolean;
   ```
   `shouldFire` = 32-bit FNV-1a of the UTF-16 code units of `seed + '\0' + point + '\0' + key`, divided by 2^32, `< rate`. FNV-1a (a dozen lines, no import) keeps `crash-points.ts` and `fault-plan.ts` free of imports beyond `node:process` (they are loaded by production apps). Deterministic across processes and restarts.
5. Extend `crashPoint` to `crashPoint(name: string, key?: string)`. Behavior: if `process.env.FLOWLEDGER_FAULT_HOOKS !== '1'` return immediately (existing behavior). If `FLOWLEDGER_FAULT_PLAN` is set, fire when `shouldFire(plan, name, key ?? String(++perPointCounter[name]))`. Otherwise keep the existing P05-T08 behavior (in-process armed → `CrashPointError`; listed in `FLOWLEDGER_CRASH_POINTS` → `SIGKILL`). A plan fire writes one line `crash_point_fired name=<name>\n` with `process.stderr.write` and then sends `SIGKILL` to itself exactly like a `FLOWLEDGER_CRASH_POINTS` fire (exit 137), so the orchestrator treats plan fires and env-armed fires identically. Do not log the key (it may be an operation ID; logs are fine to contain IDs but keep the line fixed-shape for parsing).
6. At call sites where a stable key is available cheaply (provider idempotency key in the payment worker, envelope UUID in the relay and consumers), pass it as `key`. Change no other line at those sites.
7. Production guard: every app config parser rejects `FLOWLEDGER_FAULT_HOOKS=1` when `NODE_ENV=production`, failing startup with the message `FLOWLEDGER_FAULT_HOOKS must not be enabled when NODE_ENV=production`.
8. Add `FLOWLEDGER_FAULT_PLAN=` (empty) to `.env.example` and document the JSON shape in `docs/CONFIG.md`.

**Expected behavior** — `FLOWLEDGER_FAULT_PLAN='{"seed":"s1","points":{"worker.after_dispatch_mark":0.1}}'` kills ≈10% of payment-worker attempts at that point, always the same keys for seed `s1`. Unset `FLOWLEDGER_FAULT_HOOKS` → no hook fires regardless of plan.

**Acceptance criteria**
- [ ] Every docs/08 crash-matrix row is in `MATRIX`; non-death rows carry a reason.
- [ ] `CRASH_POINTS` ↔ `MATRIX` ↔ source call sites are a bijection as asserted in step 2.
- [ ] `shouldFire` is deterministic and its empirical rate over 100,000 keys is within ±1 percentage point of the configured rate.
- [ ] Production config rejects enabled hooks.

**Testing requirements**
- `packages/config/src/fault-plan.test.ts`: determinism (same inputs → same answer across two calls and after re-parsing), rate 0 never fires, rate 1 always fires, empirical rate 0.1 ± 0.01 over 100k keys, unknown point name rejected, rate 1.5 rejected, malformed JSON rejected.
- `test/chaos/crash-point-coverage.test.ts`: cases (a)–(d) from step 2. Break check: remove one name from `CRASH_POINTS` → (a) fails; delete one call site → (c) fails.
- Config test in the existing config package tests: `NODE_ENV=production FLOWLEDGER_FAULT_HOOKS=1` → startup error naming the variable.
- Commands: `pnpm vitest run --project unit packages/config/src/fault-plan.test.ts`, `pnpm test:chaos`, `pnpm check`.

**Non-goals** — No new recovery behavior; no changes to transaction boundaries; no load workload.

**Handoff checklist**
- [ ] Coverage test observed failing with a removed registry entry, then restored.
- [ ] Any added hook is one line at the boundary named by the docs/08 row.
- [ ] `docs/CONFIG.md` and `.env.example` updated.

---

### P12-T02 — Connection budget model and bounded pools

**Task ID:** `P12-T02`
**Feature:** Global database connection budget (local and reference)
**Commit:** `perf(infra): add connection budget model with enforced bounded pools`
**Priority:** Critical
**Dependencies:** `P11-GATE`
**Estimated complexity:** M
**Contract references:** docs/09 §Reference benchmark environment (bullets on Cloud Run API sizing and "connection pool with a documented global limit"); docs/10 §M12 bullet 5, §M13 bullet 3, §Risk register "Cloud Run exhausts Cloud SQL"; CONVENTIONS §7 (one pool per process, `DATABASE_POOL_MAX`), §16 (simulator)
**Files:** create: `infra/connection-budget.json`, `infra/connection-budget.md`, `test/contract/connection-budget.test.ts`; modify: `infra/docker/compose.yaml` (PostgreSQL `max_connections`), `infra/docker/.env.example` (per-app `DATABASE_POOL_MAX`), `docs/CONFIG.md`; must not touch: `migrations/**`, app business code, `packages/database/**`

**Objective** — Make "application pools MUST NOT multiply beyond the database budget during autoscaling" a checked fact. One JSON file is the single source for pool sizes and instance bounds; a test fails if any configuration exceeds it; P13 Terraform reads the same file.

**Implementation instructions**
1. `infra/connection-budget.json` schema (exact keys):
   ```json
   {
     "local":     { "instances": { "flowledger": { "maxConnections": 200, "reserved": { "superuser": 3, "harnessAdmin": 4, "migration": 1, "headroom": 12 } },
                                    "simulator-on-same-server": true },
                    "processes": { "<app>": { "maxInstances": 1, "poolMax": 0, "database": "flowledger" } } },
     "reference": { "instances": { "flowledger": { "maxConnections": 400, "reserved": { ... } },
                                    "simulator":  { "maxConnections": 100, "reserved": { ... } } },
                    "processes": { "<app>": { "maxInstances": 0, "minInstances": 0, "poolMax": 0, "database": "flowledger" | "simulator" } } }
   }
   ```
   One `processes` entry for each of: `api`, `outbox-relay`, `payment-worker`, `provider-webhook-receiver`, `provider-webhook-worker`, `reconciler`, `settlement-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`, `provider-simulator` (`database: "simulator"`), `cli-migrate`, `cli-verify` (verify holds one connection to each database). Choose the starting values so that `Σ maxInstances × poolMax ≤ maxConnections − Σ reserved` per database instance; for `reference.api` use `minInstances: 4` (docs/09) and a `maxInstances` that satisfies the inequality. Locally the simulator shares the server (CONVENTIONS §16), so the `local.flowledger` budget includes it.
2. `infra/connection-budget.md`: the inequality, why each reserved slot exists (harness admin = lock sampler + metrics + verify; migration = migrate job), and the rule "raising any `maxInstances` or `poolMax` requires editing this file first; the test fails otherwise".
3. `test/contract/connection-budget.test.ts`: (a) the inequality holds for every instance in both sections; (b) every `DATABASE_POOL_MAX_<APP>` value in `infra/docker/.env.example` equals `local.processes.<app>.poolMax`; (c) `infra/docker/compose.yaml` passes `-c max_connections=<local.flowledger.maxConnections>` to PostgreSQL; (d) every app listed in CONVENTIONS §3 plus `provider-simulator` has an entry. **[ASSUMPTION R-07]** per-app variables are named `DATABASE_POOL_MAX_<APP_UPPER_SNAKE>` in `.env.example` and mapped to each process's `DATABASE_POOL_MAX`; if P00–P11 used a different spelling, keep theirs and assert that instead.
4. Pool and retry metrics already exist from P11 (`db_pool_wait`, `db_pool_active_connections`, `db_transaction_retries_total{sqlstate}`); this task adds none. The harness reads them from the apps' metrics export, and P12-T07/P12-T21 use `db_transaction_retries_total` as the docs/09 "deadlock/serialization retry rate" source.

**Expected behavior** — Raising `api.poolMax` from 10 to 40 without editing other values → `connection-budget.test.ts` fails naming the instance and the overflow.

**Acceptance criteria**
- [ ] Budget file covers every process including the simulator and both CLI jobs.
- [ ] The inequality holds in both sections and is asserted by a test.
- [ ] Compose and `.env.example` match the local section.

**Testing requirements**
- `test/contract/connection-budget.test.ts` cases (a)–(d); boundary: a fixture budget where the sum equals the limit passes, limit+1 fails (test the checker function on in-memory objects, then the real file).
- Commands: `pnpm vitest run --project contracts test/contract/connection-budget.test.ts`, `pnpm check`.

**Non-goals** — No PgBouncer or external pooler (not required; record as a P13 option only if measured pool wait demands it). No Terraform.

**Handoff checklist**
- [ ] Test observed failing with an over-budget value.
- [ ] `docs/CONFIG.md` lists every pool variable.

---

### P12-T03 — `flowledger seed --profile perf`

**Task ID:** `P12-T03`
**Feature:** Benchmark identity and provider configuration seed
**Commit:** `feat(cli): add perf seed profile for benchmark merchants and credentials`
**Priority:** High
**Dependencies:** `P11-GATE`
**Estimated complexity:** M
**Contract references:** docs/09 §Uniform acceptance ("10,000 merchants"), §Provider degradation ("Rate limits affect one provider account"); docs/05 §Authentication (credential format `fl_test_<locator>_<secret>`); docs/07 §Identity and authentication, §Provider configuration; CONVENTIONS §8 (developer data is seed, never migration)
**Files:** create: `apps/cli/src/seed/perf.ts`, `apps/cli/src/seed/perf.test.ts`; modify: the seed command dispatcher in `apps/cli/src` to accept `perf`; must not touch: `migrations/**`, protected SQL

**Objective** — Create the merchants, credentials, provider accounts and routes the workloads need, through the same seed path the dev profile uses, writing raw credentials only to a local file outside git.

**Implementation instructions**
1. `flowledger seed --profile perf --merchants <n=10000> --provider-accounts <k=4> --out <path>`. Reuse the dev-profile builders (merchant, credential, provider account, merchant route, fee policy binding) — call them in batches of 500 per transaction.
2. Provider accounts: `k` simulator accounts; merchant `i` is routed to account `i mod k`. Account index 0 is the "degradable" account used by `provider-degradation`; record its ID in the output.
3. Output `<path>` (default `artifacts/perf/seed/credentials.json`, mode `0600`): `{ "merchants": [{ "index": 0, "merchantId": "mer_…", "credential": "fl_test_…", "providerAccountId": "…" }], "degradableProviderAccountId": "…" }`. Credentials are synthetic and generated with `node:crypto.randomBytes`; they are printed nowhere else.
4. Refuse to run when `NODE_ENV=production` or when the target database already contains more than zero merchants not created by a prior perf seed (detect via a `merchant_reference`/name prefix `perf-` — use the dev seed's existing naming field; **[ASSUMPTION]** merchants have a human-readable name column; if not, refuse when any merchant exists).
5. Idempotent rerun: if exactly `n` `perf-` merchants exist and `--out` exists, exit 0 without changes.

**Expected behavior** — `flowledger seed --profile perf --merchants 10000` completes; `SELECT count(*) FROM identity.merchants` = 10000; the credentials file authenticates against `GET /v1/payments/{id}` (404 for unknown ID, not 401).

**Acceptance criteria**
- [ ] 10,000 merchants with one active credential each and a route to one of `k` accounts.
- [ ] Credentials file mode 0600, under `artifacts/` (gitignored).
- [ ] No raw credential is logged (redaction negative test).

**Testing requirements**
- `apps/cli/src/seed/perf.test.ts` (unit, pure planning logic): route assignment `i mod k`; degradable account is index 0.
- `test/integration/seed-perf.test.ts`: seed 50 merchants into a Testcontainers DB; every credential authenticates via the API auth verifier function; rerun is a no-op; a pre-existing non-perf merchant makes the seed refuse; captured log output contains none of the generated credentials and none of the `prohibited-data.ts` fixtures.
- Commands: `pnpm vitest run --project integration test/integration/seed-perf.test.ts`, `pnpm check`.

**Non-goals** — No payments (P12-T11 prepares them through the real API). No merchant webhook endpoints.

**Handoff checklist**
- [ ] `artifacts/` confirmed gitignored (P12-T06 adds it; add here if this task merges first).
- [ ] Redaction negative test present.

---

### P12-T04 — Simulator runtime fault/latency profile endpoint

**Task ID:** `P12-T04`
**Feature:** Configurable simulator latency and fault distribution
**Commit:** `feat(providers): add simulator test endpoint for latency and fault profiles`
**Priority:** High
**Dependencies:** `P11-GATE`
**Estimated complexity:** M
**Contract references:** docs/09 §Confirmed capture/refund processing ("25 ms median and 100 ms p95 configured latency"), §Provider degradation, §Provider contract tests last paragraph (seeded latency/error distribution); docs/06 §Deterministic fake provider, §Unreliable provider; CONVENTIONS §16
**Files:** create: `apps/provider-simulator/src/test-endpoints/profile.ts`, `apps/provider-simulator/src/test-endpoints/profile.test.ts`, `test/integration/simulator-profile.test.ts`; modify: simulator route registration, `apps/provider-simulator/src/core.ts` (latency sampler only), `docs/CONFIG.md`; must not touch: adapter normalization in `packages/providers`, ground-truth tables' semantics

**Objective** — Workloads need to set and change the simulator's latency and fault mix at runtime per provider account (latency ramp 25 ms → 2 s, rate limit on one account, 5% ambiguous). **[ASSUMPTION R-04]** P06 configured faults only at startup; if P06 already exposes an equivalent runtime endpoint, this task reduces to adding the latency distribution and the tests below.

**Implementation instructions**
1. `PUT /__test/profile/:providerAccountId` (registered only when `SIMULATOR_TEST_ENDPOINTS=1`; 404 otherwise) with body:
   ```json
   { "latency": { "medianMs": 25, "p95Ms": 100 },
     "rateLimit": { "requestsPerSecond": null },
     "faults": { "timeoutAfterCommit": 0.0, "connectionLossAfterCommit": 0.0, "timeoutBeforeCommit": 0.0, "malformedSuccess": 0.0, "server5xxUncertain": 0.0 } }
   ```
   `PUT /__test/profile/*` applies to all accounts. `GET /__test/profile/:providerAccountId` returns the active profile. Validate: rates in [0,1], sum of fault rates ≤ 1, `p95Ms ≥ medianMs > 0`.
2. Latency: log-normal with `mu = ln(medianMs)`, `sigma = ln(p95Ms / medianMs) / 1.6448536`; sample from the seeded PRNG keyed by provider idempotency key + attempt counter so a rerun with the same seed reproduces latencies.
3. Rate limit: token bucket per provider account; over-limit requests return the simulator's rate-limit response with a retry hint (the shape P06 defined for "Rate limiting with a retry hint").
4. Faults reuse P06's server-side injection; the profile only sets their probabilities. Fault selection continues to be recorded in the simulator diagnostics table.
5. Profiles persist in the simulator database so all simulator instances and restarts agree (store as one row per account; simulator caches for at most 1 s).

**Expected behavior** — After `PUT` with `{latency:{medianMs:25,p95Ms:100}}`, 10,000 sampled latencies have median 25 ± 2 ms and p95 100 ± 8 ms.

**Acceptance criteria**
- [ ] Endpoint absent unless `SIMULATOR_TEST_ENDPOINTS=1`.
- [ ] Latency distribution matches configured median/p95 within the tolerances above.
- [ ] A profile change is visible to a second simulator instance within 1 s.

**Testing requirements**
- `apps/provider-simulator/src/test-endpoints/profile.test.ts`: validation rejects rate 1.2, fault sum 1.1, `p95Ms < medianMs`; distribution tolerance over 10k samples; same seed → identical sequence.
- `test/integration/simulator-profile.test.ts`: two simulator instances on one Testcontainers DB; profile set on A is served by B within 1 s; endpoint returns 404 with test endpoints disabled; rate limit of 10 rps yields ~10 accepted per second over 3 s (±2).
- Commands: `pnpm vitest run --project integration test/integration/simulator-profile.test.ts`, `pnpm check`.

**Non-goals** — No change to normalized outcomes or ground truth recording.

**Handoff checklist**
- [ ] `SIMULATOR_TEST_ENDPOINTS` documented as test/benchmark only.

---

### P12-T05 — Local system orchestrator

**Task ID:** `P12-T05`
**Feature:** Reproducible local system under test
**Commit:** `perf(test): add local system orchestrator for load and chaos runs`
**Priority:** Critical
**Dependencies:** `P12-T02`, `P12-T04`
**Estimated complexity:** L
**Contract references:** docs/09 §Load-generation method; docs/01 §Deployable processes; CONVENTIONS §3, §8 (bucket count via `LEDGER_BUCKET_COUNT`), §11, §16
**Files:** create: `test/performance/lib/system.mjs`, `test/performance/system-config/local.json`, `test/integration/performance/system.test.ts`; modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: app source, migrations

**Objective** — One module that brings up the full local system exactly as configured by the connection budget, restarts killed processes (chaos), samples process memory, and tears down — so every profile measures the same system.

**Implementation instructions**
1. Export:
   ```js
   export async function startSystem({ runDir, databaseName = 'flowledger', simulatorDatabaseName = 'flowledger_sim', bucketCount = 32, faultPlan = null, restartOnExit = false, cpuProfile = false, env = {} })
     // -> { urls: { api, simulator, webhookReceiver }, databaseUrl, simulatorDatabaseUrl, stop(): Promise<void>, restarts(): Record<app, number>, crashFires(): Record<point, number> }
   export async function createDatabases({ databaseName, simulatorDatabaseName, bucketCount })  // drop-if-exists + create + migrate both
   ```
2. `createDatabases` connects with `PERF_ADMIN_DATABASE_URL` (local superuser from `.env.example`), `DROP DATABASE IF EXISTS … WITH (FORCE)`, `CREATE DATABASE`, runs `flowledger migrate` with `LEDGER_BUCKET_COUNT=<bucketCount>` against the new FlowLedger DB and `flowledger migrate --simulator` (P06-T03, `PROVIDER_SIMULATOR_DATABASE_URL` = `fl_simulator` on the new simulator DB) against the simulator DB, then asserts the bucket count: `SELECT logical_code, count(*), min(bucket_count), max(bucket_count) FROM ledger.accounts WHERE bucket_index IS NOT NULL GROUP BY logical_code` — every row must have `count = min = max = bucketCount`, else throw.
3. `startSystem` requires `pnpm db:up` to have started PostgreSQL and the Pub/Sub emulator, bootstraps the emulator topology from `packages/messaging/src/topology.json` via `flowledger messaging bootstrap` (P05), then spawns `node apps/<app>/dist/main.js` for: `provider-simulator`, `api`, `outbox-relay`, `payment-worker`, `provider-webhook-receiver`, `provider-webhook-worker`, `reconciler`, `settlement-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`. Each child gets its own role's `DATABASE_URL` (the simulator gets `PROVIDER_SIMULATOR_DATABASE_URL` for `fl_simulator`), `API_PORT`/`HEALTH_PORT`/`SIMULATOR_PORT` (distinct fixed ports from `system-config/local.json`), `DATABASE_POOL_MAX` from `infra/connection-budget.json` `local.processes.<app>.poolMax`, `NODE_ENV=test`, `SIMULATOR_TEST_ENDPOINTS=1` (simulator only), and, if `faultPlan` is set, `FLOWLEDGER_FAULT_HOOKS=1` and `FLOWLEDGER_FAULT_PLAN=<json>`. `SIMULATOR_DATABASE_URL` is given to no FlowLedger app (CONVENTIONS §16).
4. `test/performance/system-config/local.json` holds every other non-secret runtime knob used by the run (worker concurrency, relay claim size 500 and lease 30 s from docs/08 §Sweep and claim defaults, API rate limit raised for benchmarking, telemetry sampling ratio). The manifest (P12-T06) copies this file verbatim.
5. Readiness: poll `GET /readyz` on every HTTP-serving app until 200 (timeout 60 s).
6. Logs: child stdout/stderr → `artifacts/perf/<runId>/logs/<app>.log`. Parse stderr lines `crash_point_fired name=<n>` into `crashFires()`.
7. `restartOnExit`: when a child dies by SIGKILL / exit code 137 (a `FLOWLEDGER_CRASH_POINTS` or fault-plan fire), restart it after 200 ms and increment `restarts()[app]`; any other non-zero exit is a harness failure (throw).
8. Memory/CPU: every 10 s record `{ ts, app, pid, rssBytes, cpuSeconds }` to `artifacts/perf/<runId>/process-samples.ndjson` using `ps -o rss=,time= -p <pid>` (macOS and Linux both support these fields).
9. `cpuProfile: true` starts children with `--cpu-prof --cpu-prof-dir=<runDir>/cpuprof` (used by P12-T24 tuning).
10. `stop()` sends SIGTERM to all, waits up to 30 s (graceful shutdown), then SIGKILL.

**Expected behavior** — `startSystem({ runDir, bucketCount: 1 })` after `createDatabases({bucketCount:1})` yields a running system whose striped logical accounts each have exactly one bucket row.

**Acceptance criteria**
- [ ] All ten processes start and report ready; pool sizes come from the budget file.
- [ ] Bucket-count assertion fails loudly on mismatch.
- [ ] SIGKILLed child is restarted when `restartOnExit` and counted.
- [ ] No FlowLedger app receives `SIMULATOR_DATABASE_URL`.

**Testing requirements**
- `test/integration/performance/system.test.ts` (requires Docker; built apps via `pnpm build`): create DBs at bucket count 4, assert 4 buckets per striped logical account; start system, all ready; `kill -9` the payment worker → restarted within 2 s and `restarts()['payment-worker'] === 1`; child env inspection (spawn hook) shows no `SIMULATOR_DATABASE_URL` in FlowLedger apps; `stop()` completes within 35 s.
- Commands: `pnpm build && pnpm vitest run --project integration test/integration/performance/system.test.ts`.

**Non-goals** — No load generation, no Cloud Run orchestration (P13).

**Handoff checklist**
- [ ] `PERF_ADMIN_DATABASE_URL` added to `.env.example` (synthetic local superuser) and `docs/CONFIG.md`, marked harness-only.

---

### P12-T06 — Runner core: `pnpm test:performance <profile>`

**Task ID:** `P12-T06`
**Feature:** k6 runner with manifest and rate accounting
**Commit:** `perf(test): add performance runner with manifest, k6 invocation, and rate accounting`
**Priority:** Critical
**Dependencies:** `P12-T05`
**Estimated complexity:** L
**Contract references:** docs/09 §Load-generation method (all bullets), §Reporting template items 1–6, §Reference benchmark environment last paragraph (environment labeling); docs/10 §M12 Test and acceptance bullet 1; CONVENTIONS §4 (`pnpm test:performance`)
**Files:** create: `test/performance/run.mjs`, `test/performance/lib/manifest.mjs`, `test/performance/lib/k6.mjs`, `test/performance/lib/rates.mjs`, `test/contract/performance/rates.test.ts`, `test/contract/performance/manifest.test.ts`; modify: `.gitignore` (add `artifacts/`), `package.json` (only if `test:performance` script differs from CONVENTIONS §4), `docs/VERSIONS.md` (pin k6); must not touch: app source

**Objective** — The single entry point for every workload: records exactly what ran, runs k6 with an open arrival model, extracts offered/accepted/completed rates, and writes the evidence layout.

**Implementation instructions**
1. CLI: `node test/performance/run.mjs <profile> [--target local|reference] [--rate <n/s>] [--warmup 5m] [--measure 10m] [--trial <label>] [--dataset <dir>] [--bucket-count <n>] [--smoke] [--allow-dirty] [--no-boot]`. Profiles are discovered from `test/performance/profiles/<name>/profile.mjs`; unknown name → exit 2 listing available profiles. `--smoke` sets warmup 30 s, measure 90 s, rate ≤ 20/s and forces status `INVALID`.
2. `profile.mjs` contract (every profile task implements it):
   ```js
   export default {
     name: 'uniform-acceptance',
     script: 'script.js',                    // k6 script in the same dir
     defaultRate: 1000,                      // offered arrivals per second in the measured scenario
     needsDataset: true,
     simulatorProfile: { latency: { medianMs: 25, p95Ms: 100 } },   // applied via PUT /__test/profile/* before warm-up
     completedSql: 'SELECT count(*) FROM payments.payment_operations WHERE resolved_at >= $1 AND resolved_at < $2',
     extraCriteria: async (ctx) => [],       // returns [{ name, ok, detail }] — profile-specific correctness criteria
     targets: async (ctx) => [],             // returns [{ name, target, measured, met }] from ctx artifacts only
   };
   ```
3. `manifest.mjs` writes `manifest.json` before load starts with: `runId`, `profile`, `environment` (`local-<sha256(hostname) first 8 hex>` or `reference-gcp`), `git.sha` (`git rev-parse HEAD`), `git.dirty` (`git status --porcelain` non-empty), contract/schema versions (`openapi/openapi.yaml` `info.version`, `schemas/registry.v1.json` version, SHA-256 of both files), `k6.version` (`k6 version`), `node.version`, `postgres.version` (`SHOW server_version`), PostgreSQL settings (`SELECT name, setting, unit FROM pg_settings WHERE name IN ('max_connections','shared_buffers','work_mem','synchronous_commit','wal_level','checkpoint_timeout','max_wal_size','effective_io_concurrency','random_page_cost','default_transaction_isolation')`), `ledgerBucketCount` (queried, not taken from the flag), `connectionBudget` (copy of the relevant section), `systemConfig` (copy of `system-config/local.json` or the reference equivalent), hardware (`os.cpus().length`, model, `os.totalmem()`), dataset descriptor (P12-T11), offered rate, warm-up/measure durations, `infrastructureRevision` (`--target reference` only: Terraform state serial + `git` SHA of `infra/terraform`, passed via `PERF_INFRA_REVISION`). A dirty tree without `--allow-dirty` aborts; with it, status is forced `INVALID`.
4. k6 invocation (`k6.mjs`): `k6 run --out json=<artifacts>/k6-raw.ndjson --summary-export <evidence>/k6-summary.json --address 127.0.0.1:6565 -e PROFILE_CONFIG=<path-to-json> <script>`. Scripts MUST use only `constant-arrival-rate` or `ramping-arrival-rate` executors (open model) with two scenarios: `warmup` (not counted) and `measured` (`startTime` = warm-up duration); `k6.mjs` rejects a script whose exported `options.scenarios` uses any closed-model executor (`constant-vus`, `ramping-vus`, `per-vu-iterations`, `shared-iterations`) — parse via `k6 inspect --execution-requirements`. After the run, gzip the raw file and record its SHA-256.
5. Verify the installed k6 version equals `docs/VERSIONS.md`; mismatch → status `INVALID`.
6. `rates.mjs` computes, for the measured window only (from k6 raw points tagged `scenario=measured`): `offeredPerSec` (configured rate), `scheduledIterations`, `droppedIterations` (k6 `dropped_iterations`), `acceptedPerSec` (responses whose status is in the profile's accepted set, tagged `accepted:true` by the script), `businessRejections` by problem `code`, `unexpectedErrors` by status/code, latency p50/p95/p99/max per endpoint tag, `completedPerSec` = `completedSql` count over the measured window ÷ seconds (window bounds taken from the DB clock at measured start/end: `SELECT clock_timestamp()` at both edges), and schedule lag (k6 `iteration_duration` vs scheduled start is unavailable — record k6 `vus_max` reached and `dropped_iterations` as the schedule-pressure indicators, and state that in the summary).
7. Emit `timeseries.csv` (1-second buckets: offered, accepted, unexpected errors, p95 latency) derived from the raw file.
8. Every k6 script tags each request with `endpoint` and sets `accepted` and `expected` tags from response validation (status in expected set AND body checks pass). Response validation is always on; there is no flag to disable it.
9. Write `result.json` = `{ status, failedBy: null|string, rates, targets, extraCriteria, notes: [] }`. Until P12-T07 merges, `status` is `INVALID` with note `verify loop not yet wired`.

**Expected behavior** — `pnpm test:performance uniform-acceptance --smoke` (after P12-T12) produces `docs/evidence/runs/<runId>/` with all listed files and `status: "INVALID"` because of `--smoke`.

**Acceptance criteria**
- [ ] Closed-model executors are rejected.
- [ ] Manifest contains every field in step 3; bucket count is queried from the database.
- [ ] Raw k6 output is preserved (gz) and hashed; summary and timeseries are committed-size (< 2 MB for a 15-minute run).
- [ ] Accepted/unexpected/business-rejection counts come from response validation tags.

**Testing requirements**
- `test/contract/performance/rates.test.ts`: feed a synthetic k6 NDJSON fixture (checked in under `test/contract/performance/fixtures/k6-small.ndjson`, ≤ 200 lines) and assert offered/accepted/dropped/percentiles; warm-up points excluded; a fixture with `dropped_iterations` > 0 in `measured` reports it.
- `test/contract/performance/manifest.test.ts`: dirty-tree detection (stub `git status` output), environment label never `reference-gcp` without `--target reference`, closed-model executor rejection (feed `k6 inspect` JSON fixtures).
- Commands: `pnpm vitest run --project contracts test/contract/performance`, `pnpm check`.

**Non-goals** — No stop conditions or verify loop (P12-T07); no profile scripts.

**Handoff checklist**
- [ ] `artifacts/` in `.gitignore`.
- [ ] k6 version pinned in `docs/VERSIONS.md`.

---
### P12-T07 — Verify loop and docs/09 stop conditions

**Task ID:** `P12-T07`
**Feature:** Correctness audit during and after every load run
**Commit:** `perf(test): run flowledger verify during and after load and enforce stop conditions`
**Priority:** Critical
**Dependencies:** `P12-T06`
**Estimated complexity:** L
**Contract references:** docs/09 §Continuous invariant checker, §Stop conditions (all nine bullets), §Quality gates last line; docs/10 §M12 Test and acceptance bullets 2 and 6; docs/10 §Delivery safety last bullet; CONVENTIONS §12, §16 (`--require-ground-truth`)
**Files:** create: `test/performance/lib/verify-loop.mjs`, `test/performance/lib/stop-conditions.mjs`, `test/performance/lib/prohibited-scan.mjs`, `test/contract/performance/stop-conditions.test.ts`; modify: `test/performance/run.mjs`; must not touch: `apps/cli/src/verify/**`

**Objective** — A benchmark result is invalid if any invariant fails (docs/09 §Purpose). Run `flowledger verify` repeatedly during the measured window and once after drain, stop k6 the moment a stop condition fires, and record why.

**Implementation instructions**
1. `verify-loop.mjs`: every run invokes `flowledger verify --json --require-ground-truth` with `DATABASE_URL` = verify role URL and `SIMULATOR_DATABASE_URL` = `fl_simulator_truth` URL. During load: start one invocation, wait for it to finish, sleep 30 s, repeat (never overlapping). Append each result with `{ startedAt, finishedAt, durationMs, result }` to `verify-during.ndjson`. After k6 ends: drain (P12-T07 step 4), then one final invocation → `verify-after.json`. Parse with one function `parseVerify(json)` over P03's `VerifyReport` returning `{ ok: result === 'PASS', classes: [{ name, status, rowsChecked, findings }] }`. If the duplicate-effect class has `status: 'SKIPPED'` or `failureReasons` contains `GROUND_TRUTH_REQUIRED`, the run is `INVALID`, never `PASS`.
2. `stop-conditions.mjs` exports `evaluate(state) → { fire: false } | { fire: true, condition, detail }` over a state snapshot updated every 5 s. Conditions (names are stable strings written to `stop-conditions.json`):
   - `duplicate_financial_effect` — duplicate-effect class findings > 0.
   - `journal_or_projection_or_bucket` — findings > 0 in journal balance, projection equality, or bucket aggregation.
   - `reservation_drift` — reservation integrity findings > 0.
   - `settlement_membership` — settlement membership findings > 0.
   - `refund_or_fee_bound` — payment totals findings > 0 (covers refunds > captured and cumulative fee reversal > captured fee).
   - `posting_cardinality_or_orphan` — posting cardinality or orphan detection findings > 0.
   - `dropped_work` — k6 `dropped_iterations` > 0 in the `measured` scenario (read from k6 REST `GET http://127.0.0.1:6565/v1/metrics/dropped_iterations` deltas tagged by scenario; if the REST API cannot split by scenario, compute from the raw NDJSON tail).
   - `unexpected_error_rate` — over any trailing 30 s window, `unexpectedErrors / requests > 0.01` (six consecutive 5 s samples of k6 REST counters `http_reqs` and the script's `unexpected_errors` Counter).
   - `connection_exhaustion` — `SELECT count(*) FROM pg_stat_activity` ≥ 95% of `max_connections` for 3 consecutive samples, or any app log line containing SQLSTATE `53300`.
   - `runaway_retries` — `db_transaction_retries_total` rate > 5% of committed transactions (`pg_stat_database.xact_commit` delta) for 30 s, or `pg_stat_database.deadlocks` delta > 100 in 30 s.
   - `unbounded_backlog` — unpublished outbox rows (`SELECT count(*) FROM messaging.outbox_messages WHERE published_at IS NULL`) increase monotonically across 24 consecutive samples (2 minutes) and exceed `60 × offeredPerSec × 2`.
   - `prohibited_data` — `prohibited-scan.mjs` finds any `packages/testkit/src/prohibited-data.ts` fixture value in app logs, in `messaging.outbox_messages.envelope::text`, in `providers.provider_evidence` rows (`row_to_json(e)::text`), or in `providers.provider_attempts.normalized_response::text`. Scan logs every 60 s during load and the full set after drain.
   **[ASSUMPTION R-09]** the numeric thresholds for "connection exhaustion", "runaway retries", and "unbounded backlog" are this plan's operationalization of docs/09's qualitative wording; they are written into `stop-conditions.json` with every run.
3. On fire: `PATCH http://127.0.0.1:6565/v1/status` with `{"data":{"type":"status","id":"default","attributes":{"stopped":true}}}`, record `{ condition, detail, at }`, still drain and run the final verify, set `result.status = "FAILED"`, `failedBy = condition`. Do not retry or rerun automatically.
4. Drain after load: wait until `SELECT count(*) FROM payments.payment_operations WHERE status IN ('REQUESTED','PROCESSING')` = 0 and unpublished outbox count = 0, polling every 5 s, timeout 10 min (profiles may override). A timeout is recorded as condition `drain_timeout` → `FAILED`.
5. `PASS` requires: no condition fired, final verify `ok` with zero findings in every class and nonzero `rowsChecked` for the duplicate-effect class, and every `extraCriteria` entry `ok`.

**Expected behavior** — Injecting a fixture verify result with one duplicate-effect finding mid-run stops k6 within 5 s and yields `status: FAILED, failedBy: duplicate_financial_effect`.

**Acceptance criteria**
- [ ] Verify runs during (non-overlapping) and after every non-smoke run; outputs stored.
- [ ] Each of the 12 conditions has a unit case that fires and one that does not.
- [ ] Missing ground truth makes the run `INVALID`.
- [ ] k6 is stopped via its REST API on fire.

**Testing requirements**
- `test/contract/performance/stop-conditions.test.ts`: one firing and one non-firing state per condition; boundary cases: error rate exactly 1% for 30 s does not fire, 1.01% fires; 5 samples over threshold do not fire, 6 do; backlog increasing for 23 samples does not fire; `parseVerify` on a fixture with ground truth unavailable → `INVALID`.
- `test/integration/performance/verify-loop.test.ts`: against a Testcontainers DB with a deliberately corrupted journal fixture (use the P03 corrupted-fixture builder), the loop records a nonzero journal-balance finding and `evaluate` fires `journal_or_projection_or_bucket`; the prohibited-data scan detects a fixture PAN written into a temp log file and does not flag a clean log.
- Commands: `pnpm vitest run --project contracts test/contract/performance/stop-conditions.test.ts`, `pnpm vitest run --project integration test/integration/performance/verify-loop.test.ts`, `pnpm check`.

**Non-goals** — No change to `flowledger verify` semantics; no automatic rerun.

**Handoff checklist**
- [ ] Every condition name appears in `stop-conditions.json` output with its threshold.
- [ ] Break test: make `evaluate` ignore the duplicate-effect class → its unit case fails.

---

### P12-T08 — PostgreSQL metrics capture and boundary timings

**Task ID:** `P12-T08`
**Feature:** PostgreSQL commit/lock/pool/WAL/IO metrics and per-boundary timings
**Commit:** `perf(obs): capture postgres metrics and boundary timings for load runs`
**Priority:** High
**Dependencies:** `P12-T06`
**Estimated complexity:** L
**Contract references:** docs/09 §Performance claims and boundaries (all four boundaries and their measurement start/stop points), §Required metrics, §Load-generation method ("Synchronize clocks and state exactly where each latency timer starts and stops"); docs/10 §M12 bullet 4; docs/07 §`payments.payment_operations`, §`providers.provider_attempts`, §`messaging.outbox_messages`, §`messaging.inbox_messages`, §`settlement.runs`, §`settlement.batches`
**Files:** create: `test/performance/lib/pg-metrics.mjs`, `test/performance/lib/timings.mjs`, `test/performance/sql/timings.sql`, `test/integration/performance/timings.test.ts`; modify: `test/performance/run.mjs`, `infra/docker/compose.yaml` (enable `pg_stat_statements`); must not touch: migrations, app source

**Objective** — Report docs/09's separate boundaries from one clock (the database's), and capture the database resource metrics that identify the bottleneck.

**Implementation instructions**
1. `infra/docker/compose.yaml`: PostgreSQL command adds `-c shared_preload_libraries=pg_stat_statements -c track_io_timing=on -c track_wal_io_timing=on`. `run.mjs` executes `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` and `SELECT pg_stat_statements_reset()` through `PERF_ADMIN_DATABASE_URL` before warm-up. The extension is harness-only, never a migration.
2. `pg-metrics.mjs` snapshots via the admin connection at measured start, every 10 s, and measured end: `pg_stat_database` (current DB: `xact_commit`, `xact_rollback`, `deadlocks`, `blks_read`, `blks_hit`, `temp_bytes`, `conflicts`), `pg_stat_wal` (`wal_records`, `wal_bytes`, `wal_write`, `wal_sync`, `wal_write_time`, `wal_sync_time`), `pg_stat_io` (sum `reads`, `writes`, `read_time`, `write_time`, `fsyncs` by `backend_type`), `pg_stat_checkpointer` (PG17), `pg_stat_activity` counts grouped by `state`, `wait_event_type`, `wait_event` (admin connection sees all rows). At end, top 25 `pg_stat_statements` by `total_exec_time` with `calls`, `mean_exec_time`, `rows`, `shared_blks_hit/read` (query text kept — it contains no data values because queries are parameterized; scan it with `prohibited-scan.mjs` anyway). Derived values written to `pg-metrics.json`: commits/s, rollback ratio, deadlocks, WAL bytes/s, IO ops/s and avg latency (read_time/reads), buffer hit ratio, max active connections, wait-event histogram.
3. Host resources (local): CPU and memory of the PostgreSQL container via `docker stats --no-stream --format '{{json .}}' <container>` every 10 s; reference target: Cloud SQL metrics are pulled in P13.
4. `timings.mjs` runs `test/performance/sql/timings.sql` after drain with `$1 = measuredStart`, `$2 = measuredEnd` (DB clock values recorded by P12-T06) and writes `timings.json`:
   - **Durable command acceptance** is measured client-side by k6 (documented boundary difference: k6 measures from the load generator, including network; docs/09 defines receipt-at-container to response-ready). Also record the API's server-side histogram from the P11 request-latency metric if available, and label which boundary each number uses.
   - **Confirmed capture/refund internal completion** per succeeded CAPTURE/REFUND operation resolved in the window: `availability = min(o.published_at)` over outbox rows with `message_type = 'payment.operation.execute.v1'` and `envelope->'data'->>'operationId' = op.id`; `completion = op.resolved_at`; `internal = completion − availability`; `provider = Σ (a.response_received_at − a.dispatch_marked_at)` over its `providers.provider_attempts`; `dbAndQueue = internal − provider`. Report p50/p95/p99/max of each, separately (docs/09: provider-simulation latency reported separately from database/queue time).
   - **Messaging:** publish rate = rows with `published_at` in window ÷ seconds; unpublished age = `published_at − recorded_at` p50/p95/max; ordinary event lag = `i.processed_at − o.recorded_at` for `o.kind = 'EVENT'` joined to `messaging.inbox_messages i` on `envelope_id` (per `consumer_name`), p95; lost committed envelopes = outbox rows recorded before `measuredEnd` still unpublished after drain, plus execute commands (`payment.operation.execute.v1`) with no `payment-worker` inbox row.
   - **Settlement:** per run with `status IN ('POSTED','DEFERRED')` started in window: `completed_at − started_at`; movements/s = Σ `batches.member_count` ÷ window seconds; batch-size distribution (histogram buckets 1, 10, 100, 500, 1000, 5000+) and p95 commit time per bucket.
   All timestamps come from PostgreSQL `timestamptz` columns written by the database clock, so start and stop share one clock.
5. `run.mjs` adds `timings.json` and `pg-metrics.json` to evidence for every profile.

**Expected behavior** — For a run with the simulator at median 25 ms, `timings.json.confirmedProcessing.provider.p50` ≈ 25 ms and `dbAndQueue` is reported as a separate distribution.

**Acceptance criteria**
- [ ] Every number in `timings.json` names its boundary and its start/stop columns.
- [ ] Provider time is separated from DB/queue time.
- [ ] `pg-metrics.json` contains commit rate, deadlocks, WAL rate, IO latency, active connections, wait-event histogram, top statements.

**Testing requirements**
- `test/integration/performance/timings.test.ts`: build a fixture through protected functions/fixture helpers in a Testcontainers DB with known timestamps (use fixture helpers that set column values directly in a disposable DB as superuser — allowed for measurement tests only) — one capture op with execute envelope published at T, two attempts with 30 ms and 20 ms provider time, resolved at T+120 ms → `internal=120`, `provider=50`, `dbAndQueue=70`; an outbox row unpublished after drain counts as lost; an event with inbox `processed_at` 2 s after `recorded_at` yields lag 2 s.
- Commands: `pnpm vitest run --project integration test/integration/performance/timings.test.ts`, `pnpm check`.

**Non-goals** — No lock-wait sampling (P12-T09); no dashboards (P11 owns them).

**Handoff checklist**
- [ ] Break test: swap provider/dbAndQueue in the SQL → fixture assertion fails.

---

### P12-T09 — Balance-row lock-wait sampler (per logical account and per bucket)

**Task ID:** `P12-T09`
**Feature:** `ledger_bucket_lock_wait` evidence per logical account and bucket
**Commit:** `perf(ledger): add pg_locks-based balance-row lock-wait sampler`
**Priority:** Critical
**Dependencies:** `P12-T06`
**Estimated complexity:** L
**Contract references:** docs/09 §Ledger contention (reporting rules), §Hot merchant and hot payment (report merchant-row, platform-bucket, idempotency-index contention separately), §Required metrics (Ledger and recovery: "Balance lock wait per logical account and per bucket"); docs/08 §Recovery observability (`ledger_bucket_lock_wait by logical account`); docs/07 §`ledger.accounts`, §Striped platform accounts, §`ledger.account_balances`, §Protected posting function steps 5–7; ADR-0010
**Files:** create: `test/performance/lib/lock-sampler.mjs`, `test/performance/sql/lock-waiters.sql`, `test/integration/performance/lock-sampler.test.ts`, `test/contract/performance/lock-summary.test.ts`; modify: `test/performance/run.mjs`; must not touch: protected SQL, migrations

**Objective** — Measure who waits on which balance row, attributed to `logical_code` and `bucket_index`, with no change to the system under test.

**Mechanism decision (pg_locks sampling, joined to the locked tuple by `ctid`) and justification.**
- The posting function locks balance rows (docs/07 §Protected posting function step 5). A PostgreSQL backend blocked on a row lock first takes the heavyweight **tuple** lock (`pg_locks.locktype = 'tuple'`, with `relation`, `page`, `tuple`) and then waits on the holder's `transactionid`; further waiters queue on the tuple lock itself (`granted = false`). So `pg_locks` names the exact physical tuple being waited for. While the holder has not committed, the last committed version of that row is exactly the locked tuple, so joining `ledger.account_balances` on `ctid = '(page,tuple)'` inside the same statement resolves the waiter to an `account_id`, hence `logical_code` and `bucket_index`.
- Rejected: `pg_stat_activity.wait_event` sampling — shows `Lock/transactionid` or `Lock/tuple` but not which row, so it cannot attribute per account. `log_lock_waits` — logs only waits longer than `deadlock_timeout` (1 s default); lowering `deadlock_timeout` to see short waits changes deadlock-detection cost on the system under test, and the logged ctid has usually moved by the time it is parsed. Reusing P11's in-routine `clock_timestamp()` measurement (`ledger_bucket_lock_wait`, migration 1160) as the only source — it times the single ordered `FOR UPDATE` statement that locks all of a posting's balance rows and attributes the same wait to every account touched, so it cannot say *which* row (receivable bucket, fee-revenue bucket, or merchant clearing) the posting queued behind. That attribution is exactly what the contention claim needs. The P12 report shows both: P11's histogram (per-posting total lock wait, every posting, no sampling error) and the sampler (which row was waited on).
- Ceiling (stated in the report): sampling at interval Δ estimates waiter-seconds as `samples × Δ` and misses waits shorter than Δ; waits not on a tuple lock (unique-index insertion waits) are classified by heuristic or `unattributed`.

**Implementation instructions**
1. `test/performance/sql/lock-waiters.sql` (single statement, one snapshot), run via `PERF_ADMIN_DATABASE_URL`:
   ```sql
   WITH l AS (
     SELECT pid, locktype, relation, page, tuple, granted, mode
     FROM pg_locks WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database()) OR locktype IN ('transactionid','speculative token')
   ),
   tuple_waiters AS (
     SELECT t.pid, t.relation, t.page, t.tuple FROM l t
     WHERE t.locktype = 'tuple' AND (NOT t.granted OR EXISTS (
       SELECT 1 FROM l x WHERE x.pid = t.pid AND x.locktype IN ('transactionid','speculative token') AND NOT x.granted))
   ),
   xact_only_waiters AS (
     SELECT DISTINCT x.pid FROM l x
     WHERE x.locktype IN ('transactionid','speculative token') AND NOT x.granted
       AND NOT EXISTS (SELECT 1 FROM tuple_waiters tw WHERE tw.pid = x.pid)
   )
   SELECT 'tuple' AS kind, tw.pid, n.nspname || '.' || c.relname AS rel,
          b.account_id, a.logical_code, a.bucket_index, a.owner_type
   FROM tuple_waiters tw
   JOIN pg_class c ON c.oid = tw.relation JOIN pg_namespace n ON n.oid = c.relnamespace
   LEFT JOIN ledger.account_balances b
     ON tw.relation = 'ledger.account_balances'::regclass AND b.ctid = format('(%s,%s)', tw.page, tw.tuple)::tid
   LEFT JOIN ledger.accounts a ON a.id = b.account_id
   UNION ALL
   SELECT 'xact', w.pid,
          CASE WHEN EXISTS (SELECT 1 FROM l r WHERE r.pid = w.pid AND r.relation = 'api.idempotency_records'::regclass AND r.mode = 'RowExclusiveLock')
                AND NOT EXISTS (SELECT 1 FROM l r WHERE r.pid = w.pid AND r.relation = 'payments.payments'::regclass)
               THEN 'api.idempotency_records' ELSE NULL END,
          NULL, NULL, NULL, NULL
   FROM xact_only_waiters w;
   ```
   Classification per row: `rel = 'ledger.account_balances'` with resolved account → category `platform_bucket` (owner `PLATFORM`) or `merchant_account_row` (owner `MERCHANT`); unresolved balance tuple → `balance_unattributed`; `payments.payments` → `payment_row`; `api.idempotency_records` → `idempotency_index` (heuristic: the acceptance transaction claims the idempotency key before locking the payment, docs/07 §Transaction and lock ownership); anything else → `other:<rel>` or `unattributed`. Mark the idempotency heuristic with a `// ponytail:` comment naming its ceiling.
2. `lock-sampler.mjs`: `startLockSampler({ adminUrl, intervalMs = 50, outPath })` runs the statement on one dedicated connection in a loop (next sample scheduled at `start + k × interval`, skipping missed ticks and counting them), writes NDJSON `{ ts, rows: [...] }` to `artifacts/perf/<runId>/lock-samples.ndjson`, and `stop()` returns a summary. Only samples inside the measured window count.
3. Summary (`lock-wait-summary.json`):
   - `intervalMs`, `samples`, `missedTicks`, achieved mean interval.
   - Per category: `waiterSeconds = waiterSamples × intervalMs / 1000`.
   - Per `logical_code`: `waiterSeconds`, `meanQueueDepth`, `p95QueueDepth`, `maxQueueDepth` (queue depth = waiters on that logical account in a sample).
   - Per `(logical_code, bucket_index)`: `waiterSeconds`; plus the distribution across buckets (min, p50, p95, max, coefficient of variation).
   - Episodes: consecutive samples in which the same `pid` waits on the same `account_id` form one episode of duration `n × intervalMs`; report episode p50/p95/p99/max per logical account (resolution = interval; lower bound `(n−1) × interval` stated).
   - `unattributedShare` = unattributed waiter samples ÷ all waiter samples.
4. `run.mjs`: start the sampler for profiles whose `profile.mjs` sets `sampleLocks: true` (confirmed-processing, hot-merchant, hot-payment, refund-fanout, settlement-live, contention).
5. Harness connection accounting: the sampler uses one of the `harnessAdmin` reserved slots from `infra/connection-budget.json`.

**Expected behavior** — Two sessions holding/locking the same platform bucket balance row (one `SELECT … FOR UPDATE` held open, one blocked) → the sampler reports the blocked session under `platform_bucket` with the bucket's `logical_code` and `bucket_index`.

**Acceptance criteria**
- [ ] Waits on a platform bucket, a merchant clearing row, a payment row, and an idempotency key insertion are each classified into their own category.
- [ ] Per-logical-account and per-bucket waiter-seconds, queue depth, and episode distributions are produced.
- [ ] No change to protected SQL or migrations.

**Testing requirements**
- `test/integration/performance/lock-sampler.test.ts` (Testcontainers PG17 with migrations applied at bucket count 4, superuser connection as admin):
  - Session A `BEGIN; SELECT … FROM ledger.account_balances WHERE account_id = <bucket 2 of the processor-receivable logical account> FOR UPDATE;` (as superuser in a disposable DB — measurement fixture only); sessions B and C issue the same lock; sample → two waiters attributed to that `logical_code`, `bucket_index = 2`, category `platform_bucket` (B is the queue head with granted tuple lock + waiting transactionid; C waits on the tuple lock — both paths covered).
  - Same for a merchant clearing row → `merchant_account_row`.
  - A on `payments.payments` row → `payment_row`.
  - Two sessions inserting the same `api.idempotency_records` key (first uncommitted) → `idempotency_index`.
  - After A commits, the next sample shows zero waiters for that account.
- `test/contract/performance/lock-summary.test.ts`: summary math on synthetic samples — waiter-seconds, queue-depth percentiles, episode segmentation (gap of one tick splits an episode), samples outside the measured window excluded, `unattributedShare`.
- Commands: `pnpm vitest run --project integration test/integration/performance/lock-sampler.test.ts`, `pnpm vitest run --project contracts test/contract/performance/lock-summary.test.ts`.

**Non-goals** — No change to the production `ledger_bucket_lock_wait` metric implemented in P11 (see risk R-10). No pg_locks sampling in production.

**Handoff checklist**
- [ ] Break test: remove the `ctid` join → attribution assertions fail.
- [ ] Mechanism justification copied into the file header comment of `lock-sampler.mjs`.

---

### P12-T10 — Duplicate-effect detector conformance and per-condition breakdown

**Task ID:** `P12-T10`
**Feature:** `duplicate_financial_effects_total` exactly as docs/09 defines it
**Commit:** `test(ledger): prove cross-system duplicate-effect detector conditions and exclusions`
**Priority:** Critical
**Dependencies:** `P11-GATE`
**Estimated complexity:** M
**Contract references:** docs/09 §Defining `duplicate_financial_effects_total` (P, L, S; six conditions; two exclusions; fake/unreliable only), §Required metrics last bullet; docs/08 §Recovery observability last paragraphs; CONVENTIONS §16 (ground truth via `SIMULATOR_DATABASE_URL`, role `fl_simulator_truth`, `--require-ground-truth`)
**Files:** create: `test/chaos/duplicate-effects-detector.test.ts`; modify: `packages/database/src/verify/ground-truth.ts` (the P03-T14 duplicate-effect class) only to add the per-condition breakdown if absent; must not touch: protected SQL, migrations, simulator semantics

**Objective** — The headline correctness number must be able to read nonzero. Prove, against real databases, that each of the six docs/09 conditions increments it and that both excluded cases go to the separate unresolved-ambiguity gauges instead — and that `verify --json` reports the breakdown the benchmark report prints (docs/09 §Reporting template item 8).

**Implementation instructions**
1. Definitions (restate in the test header): for every payment operation reached, `P` = count of provider-side financial effects recorded by the simulator under the operation's `(provider_account_id, provider_idempotency_key)`; `L` = count of journal transactions whose posting key derives from the operation; `S` = final FlowLedger operation status. Counted when: `P > 1`; `L > 1`; `P = 1 ∧ L = 0 ∧ S = SUCCEEDED`; `P = 0 ∧ L = 1`; `P = 1 ∧ S ∈ {REJECTED, FAILED}`; `P = 0 ∧ S = SUCCEEDED`. Excluded (counted in gauges `unresolved_ambiguity_with_effect` and `ordinary_decline`): `S ∈ {UNKNOWN, REQUIRES_REVIEW} ∧ P = 1 ∧ L = 0`; `P = 0 ∧ L = 0 ∧ S = REJECTED`. **[ASSUMPTION R-11]** gauge names; reuse P11's names if they exist.
2. Ensure `verify --json`'s duplicate-effect `ClassResult` carries an optional `breakdown` field (the only addition to the P03-T11 `ClassResult` shape) containing `{ byCondition: { p_gt_1, l_gt_1, success_without_posting, posting_without_effect, no_effect_recorded_for_real_effect, success_never_performed, substituted_key_duplicate }, ambiguityGauges: { unresolved_ambiguity_with_effect, ordinary_decline }, operationsChecked }`. Add it if absent (no other change to verify).
3. Test setup: Testcontainers PG17 with both databases (`flowledger`, `flowledger_sim`) migrated; drive real operations through the system path used by P07 e2e helpers to obtain a consistent baseline (verify → zero). Then, for each condition, create the inconsistency in a **disposable** database as superuser with clearly named fixture helpers (`fixtureInsertSimulatorEffect`, `fixtureDuplicateJournalTransaction`, …): for `L > 1`, drop the partial unique index on `ledger.journal_transactions(payment_operation_id)` and disable immutability triggers in that disposable DB only, then insert a second journal transaction with a posting key derived from the same operation — this proves the detector counts posting keys rather than relying on the index.
4. Each case asserts `findings = 1` and `byCondition.<name> = 1` with all other condition counters 0; exclusion cases assert `findings = 0` and the matching gauge = 1.
5. Ground truth unavailable: run verify without `SIMULATOR_DATABASE_URL` → class reports `0 rows checked (ground truth unavailable)`; with `--require-ground-truth` exit code non-zero.

**Expected behavior** — Baseline: `findings = 0`, `operationsChecked > 0`. Each injected condition: exactly one finding in its own counter.

**Acceptance criteria**
- [ ] Six condition cases, the substituted-key case (P03-T14 per-payment check: two truth CAPTURE effects for one payment under different provider keys → `byCondition.substituted_key_duplicate = 1`), and two exclusion cases pass.
- [ ] `L > 1` case runs with the unique index removed, so it cannot pass by construction.
- [ ] Breakdown keys present in `verify --json`.

**Testing requirements**
- `test/chaos/duplicate-effects-detector.test.ts` with the 6 + 2 + baseline + ground-truth-unavailable cases above.
- Extra case `l_gt_1_null_operation_ref`: insert (disposable DB, triggers disabled) a second journal transaction whose posting key derives from the operation but whose `payment_operation_id` is NULL → `byCondition.l_gt_1 = 1`. Break check: change the detector to count rows by `payment_operation_id` instead of by posting-key derivation → this case fails (a `payment_operation_id`-based count cannot see it).
- Commands: `pnpm test:chaos`, `pnpm check`.

**Non-goals** — No real-provider approximation (docs/09: stated as a limitation, not built).

**Handoff checklist**
- [ ] Fixture helpers are named `fixture*` and used only in this test.
- [ ] Detector break check observed failing, then restored.

---

### P12-T11 — Dataset preparation, snapshot, and restore

**Task ID:** `P12-T11`
**Feature:** Pre-generated aggregate states and request data
**Commit:** `perf(test): prepare benchmark dataset through the real API and snapshot it`
**Priority:** Critical
**Dependencies:** `P12-T03`, `P12-T07`
**Estimated complexity:** L
**Contract references:** docs/09 §Uniform acceptance (10,000 merchants; ≥ 1,000,000 payments or large enough to avoid cache-only results; generator prepares valid aggregate states), §Load-generation method ("Pre-generate request data"); docs/05 §Idempotency (key format), §Authentication; CONVENTIONS §16
**Files:** create: `test/performance/profiles/prepare/profile.mjs`, `test/performance/profiles/prepare/script.js`, `test/performance/lib/dataset.mjs`, `test/contract/performance/dataset.test.ts`; modify: `test/performance/run.mjs` (`--dataset`); must not touch: app source, migrations

**Objective** — Every measured run starts from an identical, realistic dataset whose provider-side state exists in the simulator, so the duplicate-effect detector holds over every operation (prepared ones included) and no measured interval benchmarks data creation.

**Implementation instructions**
1. `pnpm test:performance prepare --for <profile[,profile]> [--rate <n>] [--bucket-count 32] [--out <dir>]` computes required state counts from each target profile's `needs(rate, warmup, measure)` export (add `needs` to `profile.mjs` contract: returns `{ CREATED, AUTHORIZED, CAPTURED, merchants }` with a 1.15 safety factor) and takes the max over profiles. It never prepares fewer than 10,000 merchants for `uniform-acceptance`.
2. Preparation runs through the **real system** (API → relay → worker → simulator), with the simulator profile `{latency:{medianMs:1,p95Ms:2}}` and no faults: create payments (`POST /v1/payments`), authorize a subset, capture a subset of those, waiting for each step to drain (P12-T07 drain rule). Distribute payments uniformly across merchants. k6 open-model scenario at `--rate` (default 500/s).
3. After drain, run `flowledger verify --require-ground-truth` (must be zero findings), then snapshot both databases: `pg_dump -Fc` of `flowledger` and `flowledger_sim` into `<out>/flowledger.dump`, `<out>/flowledger_sim.dump`, and write `<out>/dataset.json`: `{ bucketCount, merchants, payments: {CREATED, AUTHORIZED, CAPTURED}, gitSha, createdAt, dbSizeBytes: pg_database_size, sharedBuffersBytes, sha256: {…dumps…} }`.
4. Request data: write `<out>/requests/<profile>.ndjson` per target profile with one line per planned request: `{ seq, scenario, method, path, merchantIndex, idempotencyKey, ifMatch?, body, expect: [statuses], acceptedStatuses: [...], replayOf?: seq }`. Idempotency keys are generated now (docs/05 key format), bodies are complete, replays reuse the original line's key and body. k6 scripts read these with `SharedArray` and index by `exec.scenario.iterationInTest` — no random-number generation or data creation during the measured interval.
5. `--dataset <dir>` on any profile: `dataset.mjs` restores both dumps into fresh databases (`pg_restore --clean --if-exists -j 4`) before `startSystem`, verifies the bucket count matches `dataset.json`, and copies `dataset.json` into the manifest. Each trial restores from the same dump, so trials share an identical starting dataset.
6. Cache realism: `manifest.dataset.cacheRatio = dbSizeBytes / sharedBuffersBytes`; if `< 4` the run notes `dataset may be cache-resident` in `result.notes` (docs/09 "large enough to avoid cache-only results"). **[ASSUMPTION R-12]** the factor 4.
7. Merchant credentials file from P12-T03 is referenced by path; requests carry `merchantIndex`, and the k6 script maps it to the credential at init.

**Expected behavior** — `prepare --for uniform-acceptance --rate 1000` with defaults (5 min warm-up, 10 min measure) prepares ≥ 1.15 × (0.35 × 900,000) CREATED payments, ≥ 1.15 × (0.35 × 900,000) AUTHORIZED payments for capture+cancel, ≥ 1.15 × (0.20 × 900,000) CAPTURED payments, and emits `requests/uniform-acceptance.ndjson` with ~900,000 lines including 5% replays.

**Acceptance criteria**
- [ ] All prepared operations went through the simulator (verify duplicate-effect class `operationsChecked` equals the count of prepared provider-backed operations, findings 0).
- [ ] Two restores from the same dump yield identical `count(*)` per payment status and identical `ledger.account_balances` totals.
- [ ] Request files contain no generated values at k6 runtime (scripts never call `Math.random` or `uuidv4` in the default function — enforced by a test scanning `test/performance/profiles/*/script.js`).

**Testing requirements**
- `test/contract/performance/dataset.test.ts`: `needs` arithmetic for the uniform mix; replay lines reference earlier `seq` with identical key/body; scan of all `script.js` files for `Math.random`, `uuidv4`, `crypto.randomUUID` anywhere in the file (any occurrence fails).
- `test/integration/performance/dataset-restore.test.ts`: prepare a 200-payment dataset (smoke), restore twice, compare status counts and balance totals.
- Commands: `pnpm vitest run --project contracts test/contract/performance/dataset.test.ts`, `pnpm vitest run --project integration test/integration/performance/dataset-restore.test.ts`.

**Non-goals** — No direct inserts of payments or operations; no synthetic ground truth.

**Handoff checklist**
- [ ] Dumps and request files written under `artifacts/` (not committed); `dataset.json` copied into each run's manifest.

---

### P12-T12 — Profile: uniform acceptance (with messaging metrics)

**Task ID:** `P12-T12`
**Feature:** Durable command acceptance and messaging workload
**Commit:** `perf(test): add uniform-acceptance k6 profile`
**Priority:** Critical
**Dependencies:** `P12-T08`, `P12-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Durable command acceptance (target block; ten measured minutes after warm-up), §Messaging and recovery (target block), §Uniform acceptance (mix, 5% replays, expected business rejections separate); docs/05 command endpoints (`POST /v1/payments`, `/v1/payments/{paymentId}/authorizations`, `/captures`, `/cancellations`, `/refunds`, `GET /v1/payments/{paymentId}`), §Canonical error format
**Files:** create: `test/performance/profiles/uniform-acceptance/profile.mjs`, `test/performance/profiles/uniform-acceptance/script.js`, `test/e2e/performance/uniform-acceptance.smoke.test.ts`; modify: none; must not touch: other profiles, app source

**Objective** — Measure durable command acceptance at the 1,000 commands/s target and, in the same run, outbox publication and event lag at that rate.

**Implementation instructions**
1. Mix (fixed, recorded in manifest): 35% authorize, 25% capture, 10% cancel, 20% refund, 5% create (`POST /v1/payments`), 5% read (`GET /v1/payments/{paymentId}`); 5% of all mutating requests are identical replays of an earlier request (same key, same body), scheduled ≥ 2 s after their original. Refund amount = 25% of the captured amount so at most one refund per prepared CAPTURED payment is needed.
2. k6 `options.scenarios`: `warmup` (`constant-arrival-rate`, rate = profile rate, duration = warm-up) and `measured` (`constant-arrival-rate`, same rate, duration = measure, `startTime` = warm-up), `preAllocatedVUs` = rate × 0.25, `maxVUs` = rate × 2 (VU exhaustion appears as `dropped_iterations`, which is a stop condition).
3. Response validation per request type: expected statuses — create `201`; commands `202`; read `200`; a replay line expects the same status class as its original (`201` or `202`) — k6 VUs cannot share the original's response, so ID equality between original and replay is checked post-run by SQL in `extraCriteria` (a). Expected business rejections (counted separately, `accepted:false, expected:true`): `409 MONETARY_GUARD_FAILED`, `409 INVALID_PAYMENT_STATE`, `409 ACTIVE_OPERATION_EXISTS`. Everything else (including `409 IDEMPOTENCY_CONFLICT`, `429`, `5xx`, timeouts) increments the `unexpected_errors` Counter. Body checks: `202` body has an `op_` ID matching `^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$` and an operation status; `201` body has a `pay_` ID.
4. `completedSql`: operations with `resolved_at` in window. `extraCriteria`: (a) post-run, every replayed key maps to one operation (`SELECT idempotency key… HAVING count(*) > 1` returns 0 rows); (b) `timings.messaging.lostCommittedEnvelopes = 0`.
5. `targets` (all read from artifacts): accepted ≥ 1000/s; p50 < 40 ms; p95 < 100 ms; p99 < 250 ms (k6 latency over accepted commands, boundary labeled "load-generator observed, includes local network"); unexpected error rate < 0.1%; dropped work = 0; duplicate business effects = 0 (from final verify); outbox publish ≥ 2000/s; p95 unpublished age < 2 s; p95 ordinary event lag < 3 s; lost committed envelopes = 0; duplicate local effects = 0.

**Expected behavior** — `pnpm test:performance uniform-acceptance --dataset <dir>` runs 5 + 10 minutes and writes the evidence set with targets marked met/missed from measured values.

**Acceptance criteria**
- [ ] Open model only; mix and replay ratio match within ±0.5 percentage points (computed from the request file).
- [ ] Business rejections and unexpected errors are separate in `result.json`.
- [ ] Messaging metrics come from `timings.json`.

**Testing requirements**
- `test/e2e/performance/uniform-acceptance.smoke.test.ts`: prepare a smoke dataset (≈ 2,000 payments), run `--smoke`; assert evidence files exist, `result.status === 'INVALID'` (smoke), final verify zero findings, `unexpected_errors` = 0, mix within ±3 pp over the smoke sample.
- Commands: `pnpm build && pnpm vitest run --project e2e test/e2e/performance/uniform-acceptance.smoke.test.ts`.

**Non-goals** — No tuning; no reference-environment run.

**Handoff checklist**
- [ ] Break test: make the script count `409 IDEMPOTENCY_CONFLICT` as expected → a test fixture asserting it is unexpected fails (add to the smoke test via an injected conflicting replay).

---
### P12-T13 — Profile: confirmed capture/refund processing

**Task ID:** `P12-T13`
**Feature:** Confirmed processing workload (also the contention-pair workload)
**Commit:** `perf(test): add confirmed-processing k6 profile`
**Priority:** Critical
**Dependencies:** `P12-T08`, `P12-T09`, `P12-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Confirmed capture/refund processing (target block; fake provider 25 ms median / 100 ms p95; provider latency reported separately), §Ledger contention (the "same confirmed capture/refund workload"); ADR-0010
**Files:** create: `test/performance/profiles/confirmed-processing/profile.mjs`, `test/performance/profiles/confirmed-processing/script.js`, `test/e2e/performance/confirmed-processing.smoke.test.ts`; must not touch: other profiles, app source

**Objective** — Drive capture and refund commands against prepared payments so the measured quantity is execution-command availability → terminal commit, and so the same script is reusable unchanged by the contention pair.

**Implementation instructions**
1. Mix: 60% capture (on prepared AUTHORIZED payments, full amount), 40% refund (on prepared CAPTURED payments, 25% of captured amount). Commands spread across all merchants uniformly. Simulator profile: `{ latency: { medianMs: 25, p95Ms: 100 } }`, no faults.
2. Two modes in `profile.mjs`, selected by `--mode fixed|step` (default `fixed`):
   - `fixed`: `constant-arrival-rate` at `--rate` (default 500/s).
   - `step`: `ramping-arrival-rate` stages from 100/s to 1,000/s in +100/s steps of 2 minutes each (warm-up = first stage). Per stage, `sustained` = completed rate ≥ 0.99 × offered **and** p95 internal completion < 250 ms over that stage's last 90 s (window boundaries from the DB clock). `sustainedConfirmedRate` = highest sustained stage. **[ASSUMPTION R-13]** this operationalization of "sustained confirmed rate".
3. `sampleLocks: true`. `completedSql`: succeeded CAPTURE/REFUND operations resolved in window.
4. Response validation: `202` with `op_` ID; business rejections `409 ACTIVE_OPERATION_EXISTS` / `MONETARY_GUARD_FAILED` are unexpected here (the dataset guarantees validity) and count as `unexpected_errors`.
5. `extraCriteria`: `timings.confirmedProcessing` present and `provider` and `dbAndQueue` distributions both non-empty.
6. `targets`: confirmed ≥ 500/s (fixed mode: completed rate; step mode: `sustainedConfirmedRate`); p95 internal completion < 250 ms; duplicate journal postings = 0 (posting cardinality + duplicate-effect classes); ledger invariant failures = 0.

**Expected behavior** — Fixed mode at 500/s: `timings.json` shows internal p95, provider p95 ≈ 100 ms, and DB/queue p95 as separate values; `lock-wait-summary.json` shows waiter-seconds for platform logical accounts.

**Acceptance criteria**
- [ ] Both modes implemented; step mode computes `sustainedConfirmedRate` per the rule above.
- [ ] Lock sampling active; provider and DB/queue time separated.

**Testing requirements**
- `test/e2e/performance/confirmed-processing.smoke.test.ts`: smoke run in fixed mode at 20/s; evidence present; `lock-wait-summary.json.samples > 0`; final verify zero findings; `timings.confirmedProcessing.provider.p50` between 15 and 40 ms.
- `test/contract/performance/step-mode.test.ts`: sustained-stage computation on synthetic per-stage numbers (stage at 0.989 × offered is not sustained; p95 = 250 ms is not sustained; 249 ms is).
- Commands: `pnpm vitest run --project e2e test/e2e/performance/confirmed-processing.smoke.test.ts`, `pnpm vitest run --project contracts test/contract/performance/step-mode.test.ts`.

**Non-goals** — Bucket-count variation (P12-T21).

**Handoff checklist**
- [ ] Script has no bucket-count-dependent logic (grep `bucket` in `script.js` returns nothing).

---

### P12-T14 — Profile: duplicate storm

**Task ID:** `P12-T14`
**Feature:** Ten deliveries of every selected command and message
**Commit:** `perf(test): add duplicate-storm k6 profile`
**Priority:** High
**Dependencies:** `P12-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Duplicate storm; docs/08 §Load and isolation ("retry storm"); docs/05 §Idempotency (`IDEMPOTENCY_REQUEST_IN_PROGRESS` 409 for a concurrent owner); docs/07 §`messaging.inbox_messages`
**Files:** create: `test/performance/profiles/duplicate-storm/profile.mjs`, `test/performance/profiles/duplicate-storm/script.js`, `test/e2e/performance/duplicate-storm.smoke.test.ts`; must not touch: other profiles, app source

**Objective** — Prove one business effect per original operation under 10× duplication at the API and message layers, and measure the idempotency/inbox contention it causes.

**Implementation instructions**
1. API duplication: ≥ 10,000 distinct original commands (mix: 40% authorize, 30% capture, 30% refund on prepared states), each sent 10 times with identical key and body. Schedule the 10 copies of one original within a 500 ms burst (copies interleave with other originals), so some copies race the in-flight owner.
2. Message duplication: run the system with `FLOWLEDGER_FAULT_PLAN` setting the relay crash point "after broker acknowledgement but before marking published" at rate 0.5 and each consumer's "after commit before acknowledgement" crash point at rate 0.5 (names from `CRASH_POINTS`; the system orchestrator restarts killed processes). **[ASSUMPTION R-14]** this crash-based duplication stands in for "ten deliveries of every message"; the achieved duplicate-delivery count per envelope is reported from `duplicate_envelopes_total` and inbox-hit logs rather than asserted to be exactly 10.
3. Response validation: first response per original `202`/`201`; each copy returns the same operation ID (checked post-run by SQL), or `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` while the owner is uncommitted (expected, `accepted:false, expected:true`). Any other status is unexpected.
4. `extraCriteria` (SQL post-drain): (a) exactly one `payments.payment_operations` row per original idempotency key; (b) for succeeded captures/refunds exactly one journal transaction each; (c) simulator ground truth `P ≤ 1` for every operation (covered by the duplicate-effect class, findings 0); (d) number of distinct `api.idempotency_records` keys = number of originals.
5. Report "bounded inbox/idempotency contention": from `lock-wait-summary.json` (`sampleLocks: true`) the `idempotency_index` category waiter-seconds, and from `pg-metrics.json` the rollback ratio.

**Expected behavior** — 100,000 requests for 10,000 originals → 10,000 operations, final verify zero findings.

**Acceptance criteria**
- [ ] ≥ 10,000 originals × 10 copies offered under an open model.
- [ ] Criteria (a)–(d) evaluated and stored in `result.json.extraCriteria`.

**Testing requirements**
- `test/e2e/performance/duplicate-storm.smoke.test.ts`: smoke with 100 originals × 10; criteria (a)–(d) pass; at least one copy observed `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` or replay (assert the union count = 900).
- Commands: `pnpm vitest run --project e2e test/e2e/performance/duplicate-storm.smoke.test.ts`.

**Non-goals** — No new dedup mechanism.

**Handoff checklist**
- [ ] Break test: run the smoke with criterion (a) evaluated against a fixture DB containing a duplicated operation → criterion reports `ok:false`.

---

### P12-T15 — Profiles: hot merchant and hot payment

**Task ID:** `P12-T15`
**Feature:** Skewed-load contention and fairness
**Commit:** `perf(test): add hot-merchant and hot-payment k6 profiles`
**Priority:** High
**Dependencies:** `P12-T09`, `P12-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Hot merchant and hot payment (report merchant-row, platform-bucket, idempotency-index contention separately); docs/08 §Load and isolation ("Generate a hot merchant and prove bounded fairness for other merchants"); ADR-0010 last consequence (merchant accounts not striped); docs/05 problem codes `ACTIVE_OPERATION_EXISTS`, `PAYMENT_VERSION_MISMATCH`, `MONETARY_GUARD_FAILED`, `INVALID_PAYMENT_STATE`
**Files:** create: `test/performance/profiles/hot-merchant/{profile.mjs,script.js}`, `test/performance/profiles/hot-payment/{profile.mjs,script.js}`, `test/e2e/performance/hot.smoke.test.ts`; must not touch: other profiles, app source

**Objective** — Find whether the unstriped merchant clearing row becomes the limit after platform striping, prove other merchants keep bounded latency, and prove conflicting commands on one payment serialize or conflict rather than inflate throughput.

**Implementation instructions**
1. `hot-merchant`: confirmed-processing mix (60% capture / 40% refund) where 50% of commands belong to merchant index 0 across independent payments and 50% spread across all other merchants. `prepare --for hot-merchant` must give merchant 0 enough AUTHORIZED/CAPTURED payments. `sampleLocks: true`. Tag each request `merchant_class=hot|other`.
2. `hot-payment`: one prepared CAPTURED payment per "hot set"; 50 hot sets; each receives a burst of 20 concurrent conflicting commands (capture on already-captured → `INVALID_PAYMENT_STATE`, cancels, and refunds whose total exceeds refundable) using `If-Match` with the version observed at preparation for half of them. Expected outcomes: `202` for at most the commands that fit; `409 ACTIVE_OPERATION_EXISTS`, `409 INVALID_PAYMENT_STATE`, `409 MONETARY_GUARD_FAILED`, `412 PAYMENT_VERSION_MISMATCH` are expected rejections. `sampleLocks: true`.
3. Reports (in `result.json.extraCriteria` details, not targets): per category from the lock sampler — `merchant_account_row` waiter-seconds for merchant 0's clearing row, `platform_bucket` per logical account, `idempotency_index`, `payment_row` — never summed together. Fairness: p95 and p99 command latency for `merchant_class=other` vs. the same metric in a uniform `confirmed-processing` run at the same total rate (the comparison run ID is passed via `--baseline-run`; if absent, report without comparison and note it).
4. `extraCriteria`: hot-payment — for every hot payment, `refunded + reserved ≤ captured` at end (payment totals class), accepted refunds ≤ refundable, and offered rate − accepted rate shows conflicts (accepted per hot payment ≤ the number of commands that can legally fit).

**Expected behavior** — Hot-merchant lock summary shows merchant 0's clearing row with a distinct waiter-seconds value next to platform bucket values.

**Acceptance criteria**
- [ ] Contention categories reported separately.
- [ ] Fairness metric for non-hot merchants reported.
- [ ] Hot-payment never accepts more than legally fits.

**Testing requirements**
- `test/e2e/performance/hot.smoke.test.ts`: smoke for both profiles; hot-payment smoke with 5 hot sets × 20 commands asserts per-payment accepted refund total ≤ refundable and at least one `409`/`412` per set; hot-merchant smoke asserts the lock summary contains a `merchant_account_row` category key.
- Commands: `pnpm vitest run --project e2e test/e2e/performance/hot.smoke.test.ts`.

**Non-goals** — No merchant-row striping (out of MVP; ADR-0010).

**Handoff checklist**
- [ ] No summed "total contention" field exists in output.

---

### P12-T16 — Profile: refund fan-out

**Task ID:** `P12-T16`
**Feature:** Reservation guard under real contention
**Commit:** `perf(test): add refund-fanout k6 profile`
**Priority:** Critical
**Dependencies:** `P12-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Refund fan-out; docs/10 §M12 Test and acceptance bullet 4; docs/03 / ADR-0003 (guard `refunded + reserved + amount ≤ captured` under the payment lock); docs/05 `409 MONETARY_GUARD_FAILED`; ADR-0008 (fee reversal `floor(F*R1/G) − floor(F*R0/G)`)
**Files:** create: `test/performance/profiles/refund-fanout/{profile.mjs,script.js}`, `test/e2e/performance/refund-fanout.smoke.test.ts`; must not touch: other profiles, app source

**Objective** — Measure the over-refund guard under contention rather than assert it: many concurrent refunds per payment whose amounts collectively exceed the refundable value.

**Implementation instructions**
1. ≥ 1,000 prepared CAPTURED payments; each receives ≥ 8 concurrent refunds (default 10) fired within 50 ms. Amounts per payment: a deterministic split (from the request file) summing to 150% of captured, chosen so that some subsets fit exactly to the captured amount (e.g. 10 refunds of 15% each). Distinct idempotency keys per refund.
2. Expected statuses: `202` or `409 MONETARY_GUARD_FAILED` only. Any other 409 code (including `ACTIVE_OPERATION_EXISTS` or `IDEMPOTENCY_*`) is unexpected — this is the proof that rejection comes from the locked monetary guard, not a uniqueness index.
3. After drain (all refunds terminal under the no-fault simulator), `extraCriteria` by SQL per payment: (a) Σ accepted refund amounts ≤ captured; (b) every rejected request's problem code was `MONETARY_GUARD_FAILED` (from k6 tags: count by code); (c) `reserved_refund_amount_minor = 0` and `unresolved_refund_count = 0` once terminal, and the reservation integrity class has zero findings; (d) for payments whose confirmed refunds total exactly the captured amount: Σ refund `fee_effect_amount_minor` = capture `fee_effect_amount_minor`; (e) cumulative fee reversals ≤ captured fee for every payment.
4. During the run, the verify loop's reservation-integrity class must stay at zero (stop condition `reservation_drift`).
5. `sampleLocks: true` (payment-row waits are expected and reported).

**Expected behavior** — For 1,000 payments × 10 refunds of 15%: ≥ 6 accepted per payment (90%) and the rest `MONETARY_GUARD_FAILED`; criteria (a)–(e) hold.

**Acceptance criteria**
- [ ] ≥ 1,000 payments × ≥ 8 concurrent refunds.
- [ ] Rejections are exclusively `MONETARY_GUARD_FAILED`.
- [ ] Fee reversals sum exactly to the captured fee on full refund.

**Testing requirements**
- `test/e2e/performance/refund-fanout.smoke.test.ts`: 20 payments × 10 refunds; criteria (a)–(e); break check: point the criteria at a fixture DB where one payment's accepted refunds exceed captured (built in a disposable DB as superuser) → (a) reports `ok:false`.
- Commands: `pnpm vitest run --project e2e test/e2e/performance/refund-fanout.smoke.test.ts`.

**Non-goals** — No ambiguous refunds here (crash/redelivery and degradation cover them).

**Handoff checklist**
- [ ] Unexpected-code classification asserted in the smoke test.

---

### P12-T17 — Profile: settlement under live traffic (and settlement throughput)

**Task ID:** `P12-T17`
**Feature:** Settlement correctness and throughput under live captures/refunds
**Commit:** `perf(test): add settlement-live k6 profile with throughput phase`
**Priority:** High
**Dependencies:** `P12-T08`, `P12-T11`
**Estimated complexity:** L
**Contract references:** docs/09 §Settlement throughput (target block; movements-per-batch distribution), §Settlement under live traffic; docs/10 §M12 Test and acceptance bullet 5; docs/08 §Settlement crash table, §Sweep and claim defaults (settlement scheduler every 60 s, 50 merchants, lease 120 s); docs/07 §Settlement; ADR-0012
**Files:** create: `test/performance/profiles/settlement-live/{profile.mjs,script.js}`, `test/e2e/performance/settlement-live.smoke.test.ts`; must not touch: settlement worker source, other profiles

**Objective** — Prove no movement settles twice, payable never decreases, and clearing plus payable equals the net of confirmed movements while settlement runs continuously against live traffic; and measure settled movements/s and batch commit latency vs batch size.

**Implementation instructions**
1. Phase A (backlog): start the system without `settlement-worker` (orchestrator option `exclude: ['settlement-worker']`); run captures and refunds across ≥ 1,000 merchants until each has ≥ 1,000 unsettled movements on average for the throughput phase (smoke: 10). A configured fraction (default 10%) of refunds target payments whose capture will settle in phase B first: schedule them in phase C.
2. Phase B (throughput): start `settlement-worker` while no other traffic runs; measure until no eligible movements remain. Settlement throughput = Σ `member_count` ÷ (last `completed_at` − first `started_at`); batch commit p95 per batch-size bucket (from `timings.settlement`).
3. Phase C (live): k6 confirmed-processing traffic (60/40 capture/refund) at a configured rate for the measured window while the settlement worker keeps running; include the late refunds from phase A.
4. Payable monotonicity: during phases B and C sample every 10 s `SELECT a.owner_id, b.normal_balance_minor FROM ledger.account_balances b JOIN ledger.accounts a ON a.id = b.account_id WHERE a.owner_type = 'MERCHANT' AND a.logical_code = <merchant payable logical code from docs/02>` and fail criterion (b) if any merchant's value decreases between samples.
5. `extraCriteria` post-drain: (a) `settlement.batch_members.movement_transaction_id` has no duplicates (settlement membership class zero — also a stop condition); (b) payable non-decreasing; (c) every batch `net_amount_minor` = Σ merchant-clearing entry net of its members recomputed from `ledger.journal_entries`; (d) every `DEFERRED` run has `net_amount_minor ≤ 0` and no batch; (e) per merchant: clearing balance + payable balance = net of all confirmed capture/refund movements' clearing entries; (f) at least one run deferred because of a late refund (proves the negative-net path was exercised; if none, the run notes `negative-net path not exercised` and (f) is `ok:false`).
6. `targets`: settled movements ≥ 5,000/s; p95 batch commit < 400 ms at the 1,000-movement bucket; movements settled twice = 0; batch amount mismatches = 0. Movements-per-batch distribution always printed.

**Expected behavior** — Phase B drains the backlog; phase C keeps criteria (a)–(e) true; at least one deferred run exists.

**Acceptance criteria**
- [ ] Three phases implemented with the settlement worker excluded during phase A.
- [ ] Criteria (a)–(f) evaluated; batch-size distribution reported.

**Testing requirements**
- `test/e2e/performance/settlement-live.smoke.test.ts`: 20 merchants, small backlog; criteria (a)–(f) pass; break check on a disposable fixture DB where a payable balance is lowered between two samples → (b) reports `ok:false`.
- Commands: `pnpm vitest run --project e2e test/e2e/performance/settlement-live.smoke.test.ts`.

**Non-goals** — No change to settlement scheduling defaults (tuning goes through P12-T24).

**Handoff checklist**
- [ ] Merchant payable/clearing logical codes copied from docs/02 into the profile, not invented.

---

### P12-T18 — Profile: provider degradation (load and isolation)

**Task ID:** `P12-T18`
**Feature:** Bounded provider concurrency and isolation under degradation
**Commit:** `perf(test): add provider-degradation k6 profile`
**Priority:** High
**Dependencies:** `P12-T04`, `P12-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Provider degradation; docs/08 §Load and isolation (slow provider vs healthy; retry storm limits), §Runbook: provider outage or rate limiting; docs/01 §Failure-containment rules; docs/06 §Unreliable provider
**Files:** create: `test/performance/profiles/provider-degradation/{profile.mjs,script.js}`, `test/e2e/performance/provider-degradation.smoke.test.ts`; must not touch: worker concurrency code, other profiles

**Objective** — Show API acceptance stays available, provider concurrency stays bounded, healthy provider accounts are not starved, and no speculative ledger entries appear when one provider account degrades.

**Implementation instructions**
1. Traffic: the uniform-acceptance mix at a configured rate across all merchants (provider accounts `0..k-1`).
2. Timeline (applied by `profile.mjs` through `PUT /__test/profile/<degradableProviderAccountId>` from P12-T03's seed output): minutes 0–2 normal (median 25 ms); minutes 2–6 latency ramps linearly to median 2,000 ms / p95 4,000 ms (update every 30 s); minutes 4–8 rate limit 50 rps on account 0; minutes 0–10 `timeoutAfterCommit + connectionLossAfterCommit = 0.05` on all accounts (5% ambiguous). Other accounts keep median 25 ms.
3. Measurements (into `extraCriteria` details): API accepted rate and p95 per minute (acceptance must remain available: unexpected error rate < 0.1% for command acceptance); provider in-flight requests per account sampled every second from `SELECT provider_account_id, count(*) FROM providers.provider_attempts WHERE state = 'DISPATCH_MARKED' GROUP BY 1` — max must be ≤ the configured per-account provider concurrency from `system-config/local.json`; per-account completion rate and p95 internal completion for healthy accounts during degradation vs minutes 0–2 (starvation criterion: healthy-account p95 internal completion ≤ 2× its minutes-0–2 value **[ASSUMPTION R-15]**); `provider_rate_limited_total` increases only for account 0.
4. No speculative ledger entries: post-drain, posting cardinality class zero; every `UNKNOWN`/`REQUIRES_REVIEW` operation has zero journal transactions (SQL check joining `payment_operations` to `journal_transactions` on `payment_operation_id`); duplicate-effect class zero; ambiguity gauges reported.
5. Drain timeout for this profile: 20 minutes (reconciliation must resolve the 5% ambiguous via lookup); operations still `UNKNOWN` at the end are reported (not failures) if they have an open reconciliation case.

**Expected behavior** — Account 0's in-flight count plateaus at its concurrency limit while accounts 1..k-1 keep near-baseline completion latency.

**Acceptance criteria**
- [ ] Degradation timeline applied at runtime; schedule recorded in the manifest.
- [ ] Bounded concurrency, starvation, availability, and no-speculative-posting criteria evaluated.

**Testing requirements**
- `test/e2e/performance/provider-degradation.smoke.test.ts`: compressed timeline (10× faster), assert in-flight max ≤ limit, no journal rows for unresolved operations, final verify zero.
- Commands: `pnpm vitest run --project e2e test/e2e/performance/provider-degradation.smoke.test.ts`.

**Non-goals** — No change to retry/backoff policy.

**Handoff checklist**
- [ ] Timeline JSON stored in `manifest.json`.

---

### P12-T19 — Crash/redelivery chaos runner

**Task ID:** `P12-T19`
**Feature:** Load-level crash, republish, and redelivery workload
**Commit:** `test(chaos): add crash-redelivery workload runner`
**Priority:** Critical
**Dependencies:** `P12-T01`, `P12-T05`, `P12-T07`, `P12-T11`
**Estimated complexity:** L
**Contract references:** docs/09 §Crash and redelivery (≥ 10% worker attempts terminated at pre/post-call points; ≥ 10% outbox envelopes republished; ≥ 20% consumed messages redelivered; zero duplicate financial effects; eventual convergence or explicit review), §End-to-end scenario 19; docs/08 §Crash-point matrix, §Required failure-injection tests (Worker and provider, Messaging and DLQ, Load and isolation bullet 4)
**Files:** create: `test/performance/profiles/crash-redelivery/{profile.mjs,script.js}`, `test/performance/lib/chaos-ratios.mjs`, `test/contract/performance/chaos-ratios.test.ts`, `test/e2e/performance/crash-redelivery.smoke.test.ts`; must not touch: app source, testkit (fault plan already exists)

**Objective** — Under sustained traffic, kill processes at deterministic crash points with enough frequency to meet docs/09's ratios, and prove zero duplicate financial effects and convergence.

**Implementation instructions**
1. Fault plan (seed recorded in the manifest), using names from `CRASH_POINTS` that correspond to these docs/08 rows: worker "after operation becomes PROCESSING … before dispatchMarkedAt" 0.03, "after dispatchMarkedAt commits but before the network stack sends bytes" 0.03, "provider commits effect, response is lost"/"complete provider response arrives, process crashes before it is durably recorded" 0.03, "during terminal payment transaction before commit" 0.02, "terminal transaction commits … before command acknowledgement" 0.02 (worker attempts total ≥ 0.12); relay "after broker acknowledgement but before marking published" 0.12; every consumer "handler commits inbox and local effects, crashes before acknowledgement" 0.22; settlement "during the posting transaction before commit" 0.05; API "after provider-backed command commit but before 202" 0.02. The orchestrator runs with `restartOnExit: true`.
2. Traffic: uniform-acceptance mix at a configured rate (default 100/s locally), 10 measured minutes, with clients retrying any request that receives no response with the same key and body (pre-generated retry lines) — covers "Lose every successful API response".
3. `chaos-ratios.mjs` computes achieved ratios post-run: worker attempts terminated = Σ fires at worker points ÷ `count(*) FROM providers.provider_attempts` created in window; envelopes republished = relay fires ÷ outbox rows published in window, cross-checked with `duplicate_envelopes_total`; consumed messages redelivered = consumer fires ÷ inbox rows in window. Fire counts come from `system.crashFires()`. If any achieved ratio is below docs/09's minimum (0.10, 0.10, 0.20), the run is `INVALID` with note `injection ratio below contract minimum` (not `PASS`).
4. Convergence (drain timeout 30 min): every operation is terminal, or `REQUIRES_REVIEW` with a review case, or `UNKNOWN` with an open reconciliation case; orphan detection class zero. Report the recovery-time distribution for operations that passed through `UNKNOWN` (from reconciliation case creation to resolution, grouped by attempt count and provider visibility — docs/09 §Messaging and recovery last paragraph), unknown backlog over time, outbox age, queue age, duplicate deliveries (`duplicate_envelopes_total`, `duplicate_provider_notifications_total`), and duplicate financial effects (must be 0).
5. `extraCriteria`: ratios met; convergence met; duplicate-effect class zero with `operationsChecked > 0`.

**Expected behavior** — A 10-minute local run at 100/s restarts processes many times, meets all three ratios, converges, and reports zero duplicate financial effects.

**Acceptance criteria**
- [ ] Ratios computed from fire counts and DB denominators; below-minimum ratios invalidate the run.
- [ ] Convergence rule enforced with orphan detection zero.
- [ ] Recovery-time distribution reported by attempt count.

**Testing requirements**
- `test/contract/performance/chaos-ratios.test.ts`: ratio math; 0.099 → INVALID, 0.10 → OK; missing denominator → INVALID.
- `test/e2e/performance/crash-redelivery.smoke.test.ts`: 2-minute run at 10/s with rates doubled; at least one fire per configured point; convergence; duplicate-effect class zero.
- Commands: `pnpm vitest run --project contracts test/contract/performance/chaos-ratios.test.ts`, `pnpm vitest run --project e2e test/e2e/performance/crash-redelivery.smoke.test.ts`.

**Non-goals** — No database failover (P13-T15). No new crash points beyond P12-T01.

**Handoff checklist**
- [ ] Seed and plan stored in manifest; rerun with the same seed fires at the same keys (spot-check 10 keys from logs).

---
### P12-T20 — Profile: soak

**Task ID:** `P12-T20`
**Feature:** 60-minute soak at 75% of demonstrated maximum
**Commit:** `perf(test): add soak profile with bounded-growth analysis`
**Priority:** High
**Dependencies:** `P12-T12`
**Estimated complexity:** M
**Contract references:** docs/09 §Soak; docs/10 §M12 Test and acceptance bullet 7; docs/08 §Recovery objectives and alerts
**Files:** create: `test/performance/profiles/soak/{profile.mjs,script.js}`, `test/performance/lib/growth.mjs`, `test/contract/performance/growth.test.ts`; must not touch: other profiles

**Objective** — Show no unbounded growth in memory, connections, outbox backlog, inbox latency, or unreconciled operations over ≥ 60 minutes.

**Implementation instructions**
1. Rate: `--from-runs <runId,runId,runId>` reads the `result.json` of three `uniform-acceptance` trials, requires all `PASS`, takes the median `acceptedPerSec` (the "demonstrated ten-minute maximum") and sets rate = `floor(0.75 × median)`. `--rate` overrides only with `--allow-manual-rate`, which adds note `rate not derived from demonstrated maximum`. The derivation is stored in the manifest.
2. Script: the uniform-acceptance mix and request generator (reuse that profile's `script.js` via `import`), measured 60 minutes after a 5-minute warm-up; `prepare --for soak` computes needs.
3. Series sampled every 60 s: per-process RSS (from `process-samples.ndjson`), `pg_stat_activity` count, unpublished outbox count and oldest unpublished age, p95 event lag over the last minute (inbox `processed_at − recorded_at`), counts of `UNKNOWN` and `REQUIRES_REVIEW` operations.
4. `growth.mjs` bounded rule per series **[ASSUMPTION R-16]**: bounded when the least-squares slope over the second half of the measured window, multiplied by 30 minutes, is ≤ 10% of the series mean over that half, OR the series' final value is ≤ its floor (floors: outbox backlog 2 × rate rows, oldest unpublished age 10 s (docs/08 warning threshold), unknown count 50). Every series is reported with slope, mean, floor, verdict.
5. `extraCriteria`: every series bounded; final verify zero findings (balance rebuild and journal audit pass after the run).

**Expected behavior** — With three passing uniform trials at medians 600/640/620/s, soak rate = 465/s for 60 minutes.

**Acceptance criteria**
- [ ] Rate derived from three passing trials.
- [ ] Five series families analyzed with explicit verdicts.

**Testing requirements**
- `test/contract/performance/growth.test.ts`: flat series bounded; linearly growing RSS (+20% over the half) unbounded; growing backlog under floor bounded; rate derivation rejects a non-PASS trial.
- Smoke: `pnpm test:performance soak --smoke --allow-manual-rate --rate 10` completes (manual check recorded in the commit body; no e2e test to avoid a 65-minute CI job).
- Commands: `pnpm vitest run --project contracts test/contract/performance/growth.test.ts`.

**Non-goals** — No reference soak (P13-T16).

**Handoff checklist**
- [ ] Growth thresholds written into `result.json` for every series.

---

### P12-T21 — Ledger contention comparison pair

**Task ID:** `P12-T21`
**Feature:** Striped versus single-row platform accounts (N=1 vs N=32)
**Commit:** `perf(ledger): add controlled contention comparison runner`
**Priority:** Critical
**Dependencies:** `P12-T05`, `P12-T09`, `P12-T13`
**Estimated complexity:** L
**Contract references:** docs/09 §Ledger contention: striped versus single-row platform accounts (table and all reporting rules), §Reporting template item 9 and last paragraph; docs/10 §M12 bullet 2 and Test and acceptance bullet 3; ADR-0010; docs/07 §Striped platform accounts; CONVENTIONS §8 (two databases from the same commit; bucket count fixed at creation)
**Files:** create: `test/performance/profiles/contention/profile.mjs`, `test/performance/lib/contention.mjs`, `test/contract/performance/contention.test.ts`; must not touch: migrations, protected SQL, `confirmed-processing/script.js`

**Objective** — Produce the project's primary measured result as a controlled comparison where the bucket count is the only variable.

**Implementation instructions**
1. `pnpm test:performance contention [--mode step|fixed] [--rate n] [--trials 3]`:
   - Prepare two datasets from the **same commit**: `prepare --for confirmed-processing --bucket-count 1 --out artifacts/perf/datasets/b1` and `--bucket-count 32 --out …/b32` (each creates its databases via `createDatabases({ bucketCount })`, which asserts the bucket count). Same merchant count, same payment counts, same request file shape (request files are generated per dataset because payment IDs differ; counts and mix are identical).
   - Run order alternates to cancel drift: b1, b32, b1, b32, b1, b32 (`--trials 3`), each a full `confirmed-processing` run with `--dataset` restored fresh, identical `system-config`, identical simulator profile, identical rate/mode, lock sampling on.
   - Before each pair, `contention.mjs` asserts manifests are identical except `ledgerBucketCount`, `runId`, timestamps, dataset hashes: compare `git.sha`, `systemConfig`, `connectionBudget`, PostgreSQL settings, k6 version, offered-rate schedule, mix. Any difference → abort with `INVALID: contention pair differs in <field>`.
2. Per run, collect (from that run's artifacts only): sustained confirmed rate (step mode) or completed rate (fixed), p95 internal completion, balance-row lock wait per logical account (`lock-wait-summary.json` per `logical_code`: waiter-seconds, queue depth p95, episode p95), per-bucket distribution (N=32 only), deadlock/serialization retry rate (`db_transaction_retries_total` delta ÷ commits, plus `pg_stat_database.deadlocks` delta), and correctness (final verify). A run that is not `PASS` is reported as failed — "a throughput gain with a failed invariant check is a failed run" — and its numbers are not used for the ratio.
3. `contention-summary.json` (committed to `docs/evidence/runs/<contentionRunId>/`): both medians, the measured ratio `median(b32) / median(b1)` for rate and p95, per-logical-account lock-wait for both, per-bucket distribution for b32, and `nextBottleneck` = the largest contributor among {`merchant_account_row` waiter-seconds, WAL (`wal_sync_time` share of measured time), `db_pool_wait` p95, `payment_row` waits, CPU saturation of the PostgreSQL container} in the b32 runs, with the evidence values that selected it. The selection rule is computed, not hand-written; a human-readable sentence is generated from it.
4. No retry-until-better: the runner refuses `--trials` reruns into an existing contention run ID; every trial ever started is listed in the summary (including failed/invalid ones).
5. If the ratio ≤ 1.10, the summary sets `result: "no material improvement"` and still reports the limiting factor (docs/09: a negative result is published as-is).

**Expected behavior** — Six runs; summary shows per-logical-account lock wait collapsing (or not) between N=1 and N=32, the ratio, and the computed next bottleneck.

**Acceptance criteria**
- [ ] Both datasets created from one commit with asserted bucket counts 1 and 32.
- [ ] Manifest equality check enforced except the allowed fields.
- [ ] Per-logical-account lock wait reported for both; per-bucket for N=32.
- [ ] Ratio and next bottleneck computed from artifacts; all trials listed.

**Testing requirements**
- `test/contract/performance/contention.test.ts`: manifest diff allows only the listed fields (changing `systemConfig.workerConcurrency` → INVALID); ratio computation with one failed trial excludes it and lists it; ratio 1.05 → `no material improvement`; next-bottleneck selection on synthetic inputs picks the largest normalized contributor.
- Integration smoke (manual, recorded in commit body): `pnpm test:performance contention --smoke --trials 1`.
- Commands: `pnpm vitest run --project contracts test/contract/performance/contention.test.ts`.

**Non-goals** — No rebalancing migration; no runtime bucket-count change.

**Handoff checklist**
- [ ] The two databases are dropped and recreated per dataset, never altered in place.

---

### P12-T22 — Benchmark report generator

**Task ID:** `P12-T22`
**Feature:** docs/09 §Reporting template from raw artifacts
**Commit:** `perf(docs): add benchmark report generator from run artifacts`
**Priority:** High
**Dependencies:** `P12-T07`, `P12-T08`, `P12-T09`
**Estimated complexity:** M
**Contract references:** docs/09 §Reporting template (items 1–11 and the two closing paragraphs), §Performance claims and boundaries (never combine boundaries); docs/10 §Demo and portfolio acceptance item 9
**Files:** create: `test/performance/report.mjs`, `test/contract/performance/report.test.ts`, `test/contract/performance/fixtures/run-*/` (two small synthetic evidence sets); must not touch: evidence of real runs

**Objective** — Generate the report mechanically so no number in it can be typed by hand: every value is read from committed evidence files.

**Implementation instructions**
1. `node test/performance/report.mjs --out <file.md> <runId|contentionRunId>...` reads `docs/evidence/runs/<id>/` and writes Markdown with exactly these sections, in order: 1 Git commit and contract/schema versions; 2 Infrastructure and database configuration (including seeded ledger bucket count); 3 Dataset size and workload mix; 4 Offered, accepted, completed rates; 5 Latency percentiles with the exact measurement boundary per number; 6 Error, retry, duplicate, dropped-work counts; 7 Resource utilization and identified bottleneck; 8 Invariant checker output per assertion class (table of every class: rows checked, findings — never a single "passed" line), including the duplicate-effect per-condition breakdown and ambiguity gauges; 9 Ledger contention comparison (both runs, lock-wait distributions, ratio, next bottleneck) when a contention summary is given; 10 Coverage bounded or dropped (smoke/invalid runs excluded, profiles not run, sampled lock-wait resolution, unattributed share, idempotency heuristic, k6 client-side latency boundary, any `result.notes`); 11 Deviations from docs/09 (derived from manifest: environment not reference, dataset smaller than 1M payments, cache ratio < 4, trials < 3).
2. Every number is followed by a source reference `([runId]/<file>#<jsonPath>)`. Targets appear in a separate table with columns `Target (docs/09) | Measured | Met?`; the word "achieved" is never emitted for a target that is not met.
3. Headline selection: for a set of ≥ 3 trials of the same profile, list every trial and mark the median trial (by the profile's headline metric) as the headline; with < 3 trials, emit "fewer than three trials — no headline" in section 11.
4. Header block states `Environment: <manifest.environment>`; when not `reference-gcp`, it states "Local preflight — not the reference result (docs/09 §Reference benchmark environment)".
5. Refuse to include runs with `status: INVALID` except in section 10's excluded list; `FAILED` runs are included and labeled failed.

**Expected behavior** — Running on the two fixture evidence sets produces a deterministic Markdown file matching a checked-in golden file.

**Acceptance criteria**
- [ ] All 11 sections present in order; every number carries a source reference.
- [ ] Targets and measured values are separate; unmet targets are never phrased as achieved.
- [ ] Local runs are labeled as not the reference result.

**Testing requirements**
- `test/contract/performance/report.test.ts`: golden-file comparison; a fixture with an unmet target renders `Met? no`; a fixture with 2 trials yields "no headline"; an INVALID run is excluded and listed; removing a source file makes the generator fail rather than print a blank.
- Commands: `pnpm vitest run --project contracts test/contract/performance/report.test.ts`.

**Non-goals** — No dashboards; no prose analysis beyond the generated bottleneck sentence.

**Handoff checklist**
- [ ] Fixtures are synthetic and labeled `synthetic-fixture` in their manifests.

---

### P12-T23 — Nightly regression load lane

**Task ID:** `P12-T23`
**Feature:** Nightly fifteen-minute regression load test and settlement-under-traffic run
**Commit:** `ci(perf): add nightly regression load and settlement-live jobs`
**Priority:** Medium
**Dependencies:** `P12-T12`, `P12-T17`
**Estimated complexity:** S
**Contract references:** docs/10 §CI and verification lanes — Nightly or scheduled ("Settlement under live capture/refund traffic", "Fifteen-minute regression load test", "`flowledger verify` against a database populated by the full end-to-end matrix" already owned by earlier phases)
**Files:** modify: `.github/workflows/nightly.yml` (create if absent, with only these jobs); must not touch: PR workflow

**Objective** — Catch performance and correctness regressions nightly without claiming any number.

**Implementation instructions**
1. Job `perf-regression`: install k6 at the pinned version, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm db:up`, `pnpm test:performance prepare --for uniform-acceptance --rate 100 --warmup 5m --measure 10m`, then `pnpm test:performance uniform-acceptance --rate 100 --warmup 5m --measure 10m --trial nightly`. Fail the job if `result.json.status !== 'PASS'`. Upload `docs/evidence/runs/<runId>/` and `artifacts/perf/<runId>/` as workflow artifacts (retention 30 days). Do not commit them.
2. Job `settlement-live-nightly`: same pattern with `settlement-live` at a small scale (100 merchants).
3. Both jobs' results are labeled `environment: local-<runner hash>` automatically; no target is evaluated as a gate (targets are printed only).

**Expected behavior** — Nightly run produces two PASS results or a failed job naming the stop condition.

**Acceptance criteria**
- [ ] Two scheduled jobs; gate on `status`, not on targets.
- [ ] Artifacts uploaded, nothing committed.

**Testing requirements**
- `test/contract/ci-nightly.test.ts`: parse the workflow YAML (use the YAML parser already in the repo; if none, assert by string search) and assert both jobs exist, run on `schedule`, and gate on `result.json.status`.
- Commands: `pnpm vitest run --project contracts test/contract/ci-nightly.test.ts`.

**Non-goals** — No reference-environment lane (P13-T10).

**Handoff checklist**
- [ ] `workflow_dispatch` also enabled for manual reruns.

---

### P12-T24 — Evidence-driven tuning iteration (repeatable; one commit per change)

**Task ID:** `P12-T24`
**Feature:** Tuning by profile, not guesses
**Commit:** `perf(<scope>): <one change> (<metric> <before> -> <after>)` — one commit per change; scope is the area changed (`db`, `api`, `messaging`, `worker`, `obs`, …)
**Priority:** High
**Dependencies:** `P12-T12`, `P12-T13`, `P12-T22`
**Estimated complexity:** M per iteration
**Contract references:** docs/10 §M12 bullets 6–8 and Test and acceptance last bullet; docs/09 §Stop conditions, §Quality gates ("No performance result may waive a correctness gate"); docs/08 §Sweep and claim defaults last paragraph (values may be tuned; batches remain bounded; safety transitions do not change); CONVENTIONS §8 (migrations in `1200`–`1299`)
**Files:** create per iteration: `docs/evidence/tuning/<NN>-<slug>.md`, at most one migration `migrations/12N0_<slug>.sql` if the change is an index; modify: only the files the single change requires; must not touch: protected function semantics (state transitions, guards, posting logic), `docs/0*-*.md` contracts, `test/performance/lib/stop-conditions.mjs` thresholds

**Objective** — Remove obvious bottlenecks before provisioning the reference environment, with each change proven by before/after numbers from the same harness.

**Implementation instructions** (protocol for each iteration `NN` = 01, 02, …)
1. Baseline: run the affected headline profile (uniform-acceptance and/or confirmed-processing) once at the current commit with `system.cpuProfile = true` (`--cpu-profile` flag passed through `run.mjs`), from the same dataset dump. Record `runId_before`.
2. Identify one bottleneck from evidence only: `pg-metrics.json` top statements and wait-event histogram, `lock-wait-summary.json`, `timings.json` (provider vs DB/queue), CPU profiles (`.cpuprofile` files opened in Chrome DevTools; cite the top self-time frames), `db_pool_wait`. Allowed change families (docs/10 §M12 bullet 6): an index (new migration `12N0_*.sql`, `CREATE INDEX CONCURRENTLY` is not allowed inside the migration runner's transaction — use plain `CREATE INDEX` and note the lock in the evidence note), a query shape in a repository or a protected function body that keeps identical semantics (protected function changes require `pnpm test:integration` + the full P03/P05/P07 suites green), relay claim size/lease, worker concurrency, pool sizes (edit `infra/connection-budget.json` first; budget test must stay green), Fastify/Nest overhead (logger level, serialization, validation compilation caching — response validation in k6 stays on), telemetry sampling ratio (correctness/audit metrics remain unsampled, docs/09 §Reference benchmark environment).
3. Make exactly one change. Run `pnpm check`, `pnpm test:integration`, `pnpm test:chaos`.
4. After: rerun the same profile from the same dump at the same rate → `runId_after`. Both runs must be `PASS`; a change that causes any stop condition is reverted, not kept.
5. Write `docs/evidence/tuning/<NN>-<slug>.md`: hypothesis, evidence that identified it (file + JSON path in `runId_before`), the change (diff summary), before/after table (accepted rate, p95/p99, internal completion p95, the targeted metric) with source references, and verdict (`kept` if the targeted metric improved by ≥ 5% without regressing others by > 5%; otherwise `reverted` — a reverted iteration still commits its note with the code change undone).
6. Commit message includes the before → after numbers of the targeted metric copied from the two `result.json`/`timings.json` files.

**Expected behavior** — Example: top statement is the outbox claim query with a sequential scan → add the missing partial index migration `1200_outbox_claim_index.sql` → p95 unpublished age before/after recorded.

**Acceptance criteria** (per iteration)
- [ ] One change per commit; before/after runs both `PASS` from the same dataset dump and commit lineage.
- [ ] Evidence note cites artifact paths for every number.
- [ ] No contract-visible behavior change; all correctness suites green.

**Testing requirements**
- Per iteration: `pnpm check`, `pnpm test:integration`, `pnpm test:chaos`, and the before/after profile runs. A new index migration adds a migration test in `test/integration/migrations/12N0.test.ts` asserting the index exists and that the forward migration applies to a populated previous schema (docs/09 §PostgreSQL integration tests last bullet).

**Non-goals** — No change to stop-condition thresholds, targets, isolation level, transaction boundaries, or lock order. No dependency additions without the CONVENTIONS §2 justification.

**Handoff checklist**
- [ ] `docs/evidence/tuning/<NN>-<slug>.md` committed in the same commit as the change.
- [ ] Reverted experiments documented, not hidden.

---

### P12-T25 — Three local preflight trials (headline workloads)

**Task ID:** `P12-T25`
**Feature:** Local preflight evidence
**Commit:** `docs(perf): record three local preflight trials`
**Priority:** Critical
**Dependencies:** `P12-T12`, `P12-T13`, `P12-T17`, `P12-T22`, `P12-T24` (at least the iterations judged necessary; zero iterations is allowed if evidence shows no obvious bottleneck)
**Estimated complexity:** M (wall-clock: ~3–5 h of runs on a workstation with Docker and k6)
**Contract references:** docs/10 §M12 bullets 7–8, §Preflight targets, Test and acceptance last bullet; docs/09 §Load-generation method ("at least three measured trials; report every result; median trial is the headline"), §Reporting template
**Files:** create: `docs/evidence/P12-preflight.md`, `docs/evidence/runs/<runId>/**` (generated); modify: none; must not touch: README targets table

**Objective** — Record three full local trials of each headline workload from one commit, generated report included, with targets labeled as targets.

**Implementation instructions**
1. From a clean tree at one commit: `prepare --for uniform-acceptance,confirmed-processing` once; then three trials each of `uniform-acceptance` (rate 1000/s or the highest rate the local machine sustains without `dropped_work` — if 1000/s fires `dropped_work`, record that FAILED run as-is and add trials at a lower rate labeled as such) and `confirmed-processing --mode step`; then `settlement-live` three times.
2. Generate `docs/evidence/P12-preflight.md` with `node test/performance/report.mjs --out docs/evidence/P12-preflight.md <runIds>` and add, above the generated content, a short hand-written header listing the hardware, the commit, and the statement: "Local preflight results. Not the reference result. Targets in this file are docs/09 targets, not claims." Hand-written text must not contain any number that is not also in the generated section.
3. Commit the evidence directories (small files only; raw k6 output stays in `artifacts/` with hashes in manifests).
4. If any preflight target is missed, the report's bottleneck section and the P12-T24 tuning notes are the required "bottleneck and tuning evidence before M13" (docs/10 §M12 last bullet). Do not rerun to improve a number; every started trial is listed.

**Expected behavior** — `docs/evidence/P12-preflight.md` lists 9+ trials, medians as headlines, every class of the invariant checker per run, and target table with measured values copied from artifacts.

**Acceptance criteria**
- [ ] Three trials per headline workload from one commit.
- [ ] Report generated by `report.mjs`; no hand-typed measurements.
- [ ] Every trial ever started is listed; FAILED runs included and labeled.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` (create): for every `docs/evidence/runs/*/manifest.json`, the referenced files exist, `result.status ∈ {PASS, FAILED, INVALID}`, and every number in `docs/evidence/P12-preflight.md` that is followed by a source reference matches the referenced JSON value.
- Commands: `pnpm vitest run --project contracts test/contract/evidence-consistency.test.ts`.

**Non-goals** — No résumé language; no README changes.

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; targets stay labeled as targets.
- [ ] `artifacts/` hashes recorded; raw files retained locally until P13-GATE.

---

### P12-T26 — Local soak, contention pair, and remaining profiles

**Task ID:** `P12-T26`
**Feature:** Local evidence for every remaining workload
**Commit:** `docs(perf): record local soak, contention pair, and workload profile runs`
**Priority:** High
**Dependencies:** `P12-T14`, `P12-T15`, `P12-T16`, `P12-T18`, `P12-T19`, `P12-T20`, `P12-T21`, `P12-T25`
**Estimated complexity:** M (wall-clock: ~5–7 h of runs)
**Contract references:** docs/09 §Workload profiles (all), §Ledger contention; docs/10 §M12 Test and acceptance bullets 3–7
**Files:** create: `docs/evidence/P12-workloads.md`, `docs/evidence/runs/<runId>/**`; must not touch: README

**Objective** — One recorded local run of each remaining profile, the local contention pair (three trials each), and a local soak derived from P12-T25's uniform trials.

**Implementation instructions**
1. Same commit as P12-T25 unless a P12-T24 iteration landed in between (then rerun P12-T25 first — the soak rate must derive from trials at the soak's commit).
2. Run: `duplicate-storm`, `hot-merchant` (with `--baseline-run` = a confirmed-processing trial from P12-T25 at the same total rate), `hot-payment`, `refund-fanout`, `provider-degradation`, `crash-redelivery`, `contention --mode step --trials 3`, `soak --from-runs <three P12-T25 uniform runIds>`.
3. Generate `docs/evidence/P12-workloads.md` via `report.mjs` with the same header rule as P12-T25 (local, not reference, targets are targets). The contention section must show both runs' per-logical-account lock-wait, the ratio, and the computed next bottleneck — including a negative result if that is what was measured.

**Expected behavior** — Every docs/09 workload profile except database failover (reference-only, P13) has at least one recorded local run.

**Acceptance criteria**
- [ ] All listed profiles recorded; failed runs included.
- [ ] Contention pair: 3 + 3 trials, same commit, manifest-equality check passed.
- [ ] Soak rate derived from three PASS uniform trials.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` (from P12-T25) passes over the new files.
- Commands: `pnpm vitest run --project contracts test/contract/evidence-consistency.test.ts`.

**Non-goals** — No reference runs; no résumé claims.

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; targets stay labeled as targets.

---

### P12-GATE — Local performance and chaos readiness gate

**Task ID:** `P12-GATE`
**Feature:** M12 exit gate verification
**Commit:** `test(perf): add P12 gate verification and evidence note`
**Priority:** Critical
**Dependencies:** `P12-T01` … `P12-T26`
**Estimated complexity:** M
**Contract references:** docs/10 §M12 (all bullets), §Milestone summary row M12 ("Harness, correctness audit, and local preflight pass"); docs/09 §Quality gates (Performance-ready is P13), §Stop conditions; docs/08 §Required failure-injection tests §Load and isolation
**Files:** create: `test/e2e/performance/p12-gate.test.ts`, `docs/evidence/P12.md`; must not touch: feature code

**Objective** — Prove the harness itself is trustworthy end to end (it detects what it claims to detect) and that the local evidence exists.

**Implementation instructions**
1. `test/e2e/performance/p12-gate.test.ts` (runs in the e2e project; uses `--smoke` runs):
   - **Detects corruption:** start a smoke `confirmed-processing` run; mid-run, as superuser in that disposable DB, insert an extra unbalanced journal entry via a fixture helper with immutability triggers disabled → run ends `FAILED` with `failedBy = journal_or_projection_or_bucket` within 60 s.
   - **Detects duplicates:** mid-run, insert a second simulator effect for one completed operation's provider key in `flowledger_sim` (fixture helper) → `FAILED` with `duplicate_financial_effect`.
   - **Detects dropped work:** smoke run with `maxVUs = 1` and rate 200/s → `FAILED` with `dropped_work`.
   - **Detects prohibited data:** write a `prohibited-data.ts` PAN into an app log file mid-run → `FAILED` with `prohibited_data`.
   - **Requires ground truth:** run with the simulator truth URL unset → `INVALID`.
   - **Open model:** every `test/performance/profiles/*/script.js` passes `k6 inspect` with no closed-model executor.
   - **Contention pair integrity:** two smoke datasets at bucket counts 1 and 32 produce manifests whose only differences are the allowed fields; the bucket-count query returns 1 and 32.
   - **Evidence present:** `docs/evidence/P12-preflight.md` and `docs/evidence/P12-workloads.md` exist, list ≥ 3 trials for uniform-acceptance and confirmed-processing, include a contention section with both bucket counts, a soak section, and a crash-redelivery run whose ratios meet docs/09 minimums.
2. `docs/evidence/P12.md`: table mapping each docs/10 §M12 bullet and Test-and-acceptance bullet to the run ID, file, or test that proves it; list every preflight target with `met`/`missed` copied from the generated reports; list unmet targets with their recorded bottleneck (docs/10 §M12 last bullet). States: "No local number in this repository is a résumé claim."

**Expected behavior** — All gate cases pass; `docs/evidence/P12.md` maps every M12 bullet.

**Acceptance criteria**
- [ ] Each harness-detection case fails the run for the right reason.
- [ ] Evidence files exist and are internally consistent.
- [ ] `P12.md` maps every M12 bullet; unmet targets have a recorded bottleneck.

**Testing requirements**
- `test/e2e/performance/p12-gate.test.ts` with the cases above; `pnpm vitest run --project contracts test/contract/evidence-consistency.test.ts`; `pnpm check`; `pnpm test:integration`; `pnpm test:chaos`.

**Non-goals** — No feature code; no reference environment.

**Handoff checklist**
- [ ] Every detection case was observed failing the run, and the corresponding stop condition was briefly disabled to confirm the case then passes incorrectly (proving the test can fail), then restored.

---

## Parallelization

- **Wave 1 (after P11-GATE, parallel):** P12-T01, P12-T02, P12-T03, P12-T04, P12-T10. Conflicts: T01 and T02 both may touch `infra/docker/.env.example` and `docs/CONFIG.md` (append-only; rebase). T04 touches `apps/provider-simulator` only.
- **Wave 2:** P12-T05 (needs T02, T04) → P12-T06 → then P12-T07, P12-T08, P12-T09 in parallel. All three modify `test/performance/run.mjs` (small hook insertions; serialize merges or land T07 first). T08 modifies `infra/docker/compose.yaml`, which T02 also modifies (`max_connections` vs `shared_preload_libraries` lines) — merge T02 first.
- **Wave 3:** P12-T11 (needs T03, T07), then profiles P12-T12 … P12-T19 in parallel (each owns its own `test/performance/profiles/<name>/` directory and its own smoke test file; no shared file). P12-T22 can run in parallel with profiles once T07–T09 merge.
- **Wave 4:** P12-T20 (needs T12), P12-T21 (needs T13), P12-T23 (needs T12, T17).
- **Wave 5 (serial, single machine):** P12-T24 iterations → P12-T25 → P12-T26 → P12-GATE. Runs must not share the machine with other load.
- Single-owner surfaces touched: `packages/config/src/crash-points.ts` + `fault-plan.ts` (T01 only), `packages/database/src/pool.ts`/`tx.ts` (T02 only), `apps/cli/src` seed (T03), verify duplicate-effect module (T10 only), migrations `12N0` (T24 only).

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M12: k6 open-arrival workloads for uniform acceptance | P12-T06, P12-T12 | test/e2e/performance/uniform-acceptance.smoke.test.ts :: smoke evidence; test/contract/performance/manifest.test.ts :: closed-model rejection |
| docs/10 M12: duplicate storm | P12-T14 | test/e2e/performance/duplicate-storm.smoke.test.ts :: criteria (a)–(d) |
| docs/10 M12: hot merchant/payment | P12-T15 | test/e2e/performance/hot.smoke.test.ts :: categories separate; accepted ≤ refundable |
| docs/10 M12: refund fan-out | P12-T16 | test/e2e/performance/refund-fanout.smoke.test.ts :: (a)–(e), MONETARY_GUARD_FAILED only |
| docs/10 M12: settlement under live traffic | P12-T17 | test/e2e/performance/settlement-live.smoke.test.ts :: (a)–(f) |
| docs/10 M12: provider degradation | P12-T18 | test/e2e/performance/provider-degradation.smoke.test.ts :: bounded in-flight, no speculative posting |
| docs/10 M12: crash/redelivery | P12-T19 | test/contract/performance/chaos-ratios.test.ts :: ratio thresholds; test/e2e/performance/crash-redelivery.smoke.test.ts :: convergence |
| docs/10 M12: soak | P12-T20, P12-T26 | test/contract/performance/growth.test.ts :: bounded rule; docs/evidence/P12-workloads.md soak section |
| docs/10 M12: contention comparison as controlled pair, per-logical-account lock wait | P12-T09, P12-T21, P12-T26 | test/integration/performance/lock-sampler.test.ts :: attribution; test/contract/performance/contention.test.ts :: manifest diff |
| docs/10 M12: hooks at every named crash point, disabled outside tests | P12-T01 | test/chaos/crash-point-coverage.test.ts :: (a)–(d); config test :: production rejects hooks |
| docs/10 M12: PG commit/lock/pool/WAL/IO metrics, per-bucket lock wait, queue/provider timings | P12-T02, P12-T08, P12-T09 | test/integration/performance/timings.test.ts :: provider vs dbAndQueue; packages/database/src/pool.test.ts :: wait metric |
| docs/10 M12: connection budget model, bounded local pools | P12-T02 | test/contract/connection-budget.test.ts :: (a)–(d) |
| docs/10 M12: tune by profiles | P12-T24 | docs/evidence/tuning/*.md before/after with source refs |
| docs/10 M12: preserve raw results, config, SHA, dashboards, audit | P12-T06, P12-T07, P12-T08 | test/contract/performance/manifest.test.ts; test/contract/evidence-consistency.test.ts |
| docs/10 M12: ≥ 3 local preflight trials | P12-T25 | test/e2e/performance/p12-gate.test.ts :: evidence present |
| docs/10 M12 T&A: open model, offered/accepted/completed, response validation on | P12-T06, P12-T12–T19 | test/contract/performance/rates.test.ts; p12-gate :: open model |
| docs/10 M12 T&A: verify during and after; nonzero invalidates | P12-T07 | test/contract/performance/stop-conditions.test.ts; p12-gate :: detects corruption |
| docs/10 M12 T&A: contention pair same commit/config, no-improvement recorded | P12-T21 | test/contract/performance/contention.test.ts :: ratio 1.05 → no material improvement |
| docs/10 M12 T&A: refund fan-out guard + fee sum | P12-T16 | refund-fanout.smoke.test.ts :: (b),(d) |
| docs/10 M12 T&A: settlement no double-settle, payable non-decreasing, clearing+payable | P12-T17 | settlement-live.smoke.test.ts :: (a),(b),(e) |
| docs/10 M12 T&A: invalidation list (dup effects, unbalanced, bucket, reservation, double-settle, projection, dropped, prohibited) | P12-T07 | stop-conditions.test.ts :: one case per condition; p12-gate :: duplicates, dropped work, prohibited data |
| docs/10 M12 T&A: local soak bounded | P12-T20 | growth.test.ts |
| docs/10 M12 T&A: missed targets → record bottleneck | P12-T24, P12-T25, P12-GATE | docs/evidence/P12.md unmet-target table |
| docs/09 §Continuous invariant checker: runs during and after every load/chaos workload | P12-T07 | verify-loop.test.ts |
| docs/09 §Defining duplicate_financial_effects_total (six conditions, two exclusions) | P12-T10 | test/chaos/duplicate-effects-detector.test.ts :: 6 + 2 cases, L>1 with index dropped |
| docs/09 §Confirmed processing: provider latency separate | P12-T08, P12-T13 | timings.test.ts :: internal=120, provider=50 |
| docs/09 §Settlement throughput: batch-size distribution | P12-T08, P12-T17 | timings.json settlement histogram; settlement-live smoke |
| docs/09 §Messaging and recovery: publish rate, unpublished age, event lag, lost envelopes | P12-T08, P12-T12 | timings.test.ts :: lost envelope, lag 2 s |
| docs/09 §Messaging and recovery: recovery time by attempt/provider visibility | P12-T19 | crash-redelivery smoke :: recovery distribution present |
| docs/09 §Hot merchant: report merchant-row, bucket, idempotency contention separately | P12-T09, P12-T15 | lock-sampler.test.ts :: four categories |
| docs/09 §Load-generation: 5-min warm-up, ≥3 trials, median headline, schedule lag, pre-generated data, raw artifacts | P12-T06, P12-T11, P12-T22 | dataset.test.ts :: no runtime RNG; report.test.ts :: <3 trials → no headline |
| docs/09 §Stop conditions (9 bullets) | P12-T07 | stop-conditions.test.ts (12 named conditions cover all 9 bullets) |
| docs/09 §Reporting template items 1–11 | P12-T22 | report.test.ts :: golden file, 11 sections |
| docs/09 §Reference env last paragraph: label local runs | P12-T06, P12-T22 | manifest.test.ts :: environment label; report.test.ts :: local header |
| docs/09 §End-to-end scenario 19 (termination at every named crash point) | P12-T01, P12-T19 | crash-point-coverage.test.ts; crash-redelivery smoke :: one fire per point |
| docs/08 §Required failure-injection — Load and isolation: slow provider vs healthy | P12-T18 | provider-degradation smoke :: healthy accounts not starved |
| docs/08 — Load and isolation: hot merchant bounded fairness | P12-T15 | hot-merchant fairness metric in result.json |
| docs/08 — Load and isolation: retry storm, DB/provider limits hold | P12-T14, P12-T18, P12-T02 | duplicate-storm smoke; in-flight ≤ limit; connection_exhaustion stop condition |
| docs/08 — Load and isolation: measure recovery time, unknown backlog, outbox age, queue age, duplicate deliveries, duplicate financial effects | P12-T19 | crash-redelivery result.json extraCriteria details |
| docs/08 — Load and isolation: duplicate financial-effect count zero | P12-T07, P12-T10 | stop condition duplicate_financial_effect |
| docs/08 §Recovery observability: `ledger_bucket_lock_wait by logical account` (benchmark evidence) | P12-T09 | lock-sampler.test.ts |
| docs/08 §Sweep and claim defaults: tuning keeps batches bounded | P12-T24 | tuning protocol non-goals; budget test |
| docs/10 §CI nightly: fifteen-minute regression load; settlement under live traffic | P12-T23 | test/contract/ci-nightly.test.ts |
| CONVENTIONS §8: N=1 and N=32 databases from the same commit | P12-T05, P12-T21 | system.test.ts :: bucket assertion; contention.test.ts |
| CONVENTIONS §16: simulator started; verify with `--require-ground-truth`; no FlowLedger app gets `SIMULATOR_DATABASE_URL` | P12-T05, P12-T07 | system.test.ts :: env inspection; stop-conditions.test.ts :: ground truth unavailable → INVALID |

## Phase risks / open questions

- **R-01 — `flowledger verify --json` shape comes from P03 (`VerifyReport`), not from a contract.** Impact: a P03 change breaks parsing. Severity: Low. Resolution: P12-T07 isolates parsing in `parseVerify`. Blocked: none.
- **R-02 — Crash hooks inside `packages/database`/`packages/messaging` cannot import `@flowledger/testkit` (CONVENTIONS §3 dependency direction); resolved by placing `crashPoint` in `packages/config/src/crash-points.ts` (P05-T08); P06 covers in-SQL points with `public.fault_point` / GUC `flowledger.fault_point`.** Impact: P12-T01's source-scan must also accept SQL fault-point names and app-level call sites. Severity: Medium. Resolution: `MATRIX.point` may name either a `CRASH_POINTS` entry or a SQL fault point; the coverage test scans `apps/*/src`, `packages/*/src`, and `migrations/*.sql` accordingly. Blocked: P12-T01, P12-T19.
- **R-03 — Health endpoint paths and `dist/main.js` entry points assumed.** Severity: Low. Resolution: use whatever P05/P11 shipped; update `system.mjs` only. Blocked: P12-T05.
- **R-04 — Simulator runtime profile endpoint may already exist from P06.** Severity: Low. Resolution: P12-T04 reduces to latency distribution + tests. Blocked: P12-T04.
- **R-05 — Lock sampler uses a harness-only superuser/admin URL (`PERF_ADMIN_DATABASE_URL`).** No contract role covers benchmark sampling; CONVENTIONS §7 role list is fixed. Locally it is the compose superuser; in Cloud SQL the built-in `postgres` user is not a true superuser and may lack `SELECT` on `ledger.account_balances` (needed for the ctid join) — P13-T11 (`grant-harness-admin.sql`) grants it explicitly. Severity: Medium. Resolution: keep it harness-only, never configured in any app. Blocked: P12-T09 (local: none), P13-T16.
- **R-06 — `docs/09` names pool/retry metrics by description only; P11 fixed `db_pool_wait`, `db_pool_active_connections`, `db_transaction_retries_total`.** Severity: Low. Resolution: P12 reuses P11's names and adds none. Blocked: none.
- **R-07 — Per-app pool variable naming in `.env.example`.** Severity: Low. Resolution: assert whatever spelling exists. Blocked: P12-T02.
- **R-09 — Numeric thresholds for "connection exhaustion", "runaway retries", "unbounded backlog" are this plan's operationalization of docs/09 §Stop conditions (docs/09:437).** Severity: Medium (could invalidate or wrongly pass runs). Resolution: thresholds are recorded in every run's `stop-conditions.json`; changing them requires editing this task file first. Blocked: none.
- **R-10 — Two lock-wait mechanisms exist: P11's in-routine timing (`ledger_bucket_lock_wait`, timed by P11-T09 migration 1160, recorded from the `applyProviderEvidence`/`postBatch` wrappers — total wait per posting, attributed equally to all touched accounts) and the P12 pg_locks sampler (which row is waited on, sampled).** Impact: the numbers differ by construction. Severity: Medium. Resolution: the report prints both, labeled with their mechanism; the per-logical-account attribution claim cites the sampler, the total-wait distribution cites P11's histogram. Blocked: none.
- **R-11 — Ambiguity gauge names not defined in the contracts (docs/09:76 says "counted separately as unresolved-ambiguity gauges").** Severity: Low. Resolution: P12-T10 uses `unresolved_ambiguity_with_effect`, `ordinary_decline` unless P11 named them. Blocked: none.
- **R-12 — "Large enough to avoid cache-only results" (docs/09:331) operationalized as DB size ≥ 4 × shared_buffers.** Severity: Low. Resolution: note, not fail. Blocked: none.
- **R-13 — "Sustained confirmed rate" (docs/09:271) operationalized as the highest step with completed ≥ 0.99 × offered and p95 < 250 ms.** Severity: Medium (defines the contention headline). Resolution: rule fixed before any run and recorded in manifests. Blocked: P12-T13, P12-T21.
- **R-14 — "Ten deliveries of every selected … message" (docs/09:340) is realized for messages via crash-induced redelivery at 50% rates, not exactly ten deliveries.** Severity: Medium. Resolution: report achieved per-envelope delivery counts; API commands get exactly ten. Blocked: P12-T14.
- **R-15 — "Other provider accounts avoid starvation" (docs/09:369) operationalized as healthy p95 ≤ 2× baseline.** Severity: Low. Blocked: P12-T18.
- **R-16 — "No unbounded growth" (docs/09:388) operationalized by slope-over-second-half rule with floors.** Severity: Medium. Blocked: P12-T20.
- **R-17 — Local hardware may not reach 1,000 commands/s.** Impact: preflight targets missed locally. Severity: Medium. Resolution: docs/10 §M12 allows it — record bottleneck, do not convert to claims. Blocked: none.
- **R-18 — Raw k6 output is not committed (size).** Impact: public reviewers can verify hashes but not re-read raw local data. Severity: Low. Resolution: committed summaries + timeseries; reference raw bundles go to the P13 evidence bucket. Blocked: none.
