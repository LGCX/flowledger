# Execution conventions

Status: **Proposed — binding for every task in `docs/execution-plan/tasks/`**
Last updated: 2026-11-08

This file fixes the engineering decisions that the contracts leave open, so that agents implementing different tasks produce code that fits together. Every item below is labeled:

- **[CONTRACT]** — restated from a contract document; the contract wins if this file ever disagrees.
- **[PROPOSED]** — a decision made by this plan where the contracts are silent. Changing it requires editing this file first, in its own commit.

An agent MUST read this file in full before starting any task.

---

## 1. Source-of-truth order

1. `docs/00`–`docs/09`, `docs/adr/*`, `openapi/openapi.yaml`, `schemas/**` — normative contracts. **[CONTRACT]**
2. `docs/10-IMPLEMENTATION_PLAN.md` — milestone baseline. **[CONTRACT]**
3. This file. **[PROPOSED]**
4. The task file you were assigned.

If a task instruction contradicts a contract, stop, do not guess, and report the conflict (see §14). Do not edit a contract inside a feature commit. Contract fixes listed in README §10.3 D-08 are made as separate, human-approved `docs(contracts):` commits that precede the task needing them (P04-T12 and P05-T12 begin with one).

## 2. Toolchain and versions **[PROPOSED]** unless noted

| Tool | Version policy |
| --- | --- |
| Node.js | 24.x LTS. Pinned in `.nvmrc` and `package.json#engines`. |
| pnpm | 10.x. Pinned via `package.json#packageManager` (Corepack). |
| TypeScript | 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. |
| PostgreSQL | 17 **[CONTRACT: 09 reference environment]**. Local: `postgres:17` image. |
| Docker / Compose | Compose v2. |
| Terraform | 1.9+ (first used in P13). |
| k6 | 0.5x+ (first used in P12). |

Exact versions are pinned in P00-T01 and recorded in `docs/VERSIONS.md`. Every runtime/dev dependency is pinned to an exact version (no `^`/`~`) in `package.json`; `pnpm-lock.yaml` is committed.

### Approved dependencies **[PROPOSED]**

Only these may be added without a dedicated decision commit. Anything else needs a one-line justification in the task's commit body and must not duplicate an item below or Node's stdlib.

| Purpose | Package(s) |
| --- | --- |
| HTTP framework | `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `fastify`, `reflect-metadata`, `rxjs` (Nest peer) |
| PostgreSQL | `pg`, `@types/pg` |
| JSON Schema validation | `ajv` (use `ajv/dist/2020`), `ajv-formats` |
| OpenAPI parse/validate | `@apidevtools/swagger-parser` |
| Type generation | `openapi-typescript`, `json-schema-to-typescript` |
| IDs | `ulid` (wrapped; see §6) |
| Logging | `pino` (Fastify's logger) |
| Telemetry | `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, OTLP exporters |
| Messaging | `@google-cloud/pubsub` |
| Tests | `vitest`, `fast-check`, `@testcontainers/postgresql`, `testcontainers` |
| Lint/format | `eslint`, `typescript-eslint`, `prettier` |
| Secrets scan | `gitleaks` (binary in CI, not an npm dep) |
| Container / IaC / dependency scan | `trivy` (binary in CI, not an npm dep; P11) |

Crypto (SHA-256, HMAC, AES-256-GCM, `timingSafeEqual`, `randomUUID`) uses `node:crypto` only. No ORM, no query builder, no migration library. **[CONTRACT: 10 "Avoid an ORM"]**

## 3. Repository layout

The baseline layout is fixed by `docs/10` §Repository shape **[CONTRACT]**. This plan adds one entry point, marked **[PROPOSED]**:

```text
apps/
  api/                          # NestJS + Fastify merchant API
  outbox-relay/
  payment-worker/               # also hosts the due-work scheduler and stale sweepers (P06/P08)
  provider-webhook-receiver/
  provider-webhook-worker/
  reconciler/
  settlement-worker/
  merchant-webhook-projector/
  merchant-webhook-dispatcher/
  cli/                          # [PROPOSED] `flowledger` binary: migrate, seed, verify, operator commands
  provider-simulator/           # [DECIDED D-02] standalone fake/unreliable provider HTTP service (see §16)
packages/
  config/        # env parsing, typed config objects
  contracts/     # generated types + Ajv validators + semantic correlation validator
  domain/        # pure TS: money, ids, fees, state guards, hashing, retry policy
  database/      # pg pool, tx helper, migration runner, repositories, SQL-call wrappers
  messaging/     # transport interface, local + in-memory + Pub/Sub transports, relay, inbox consumer
  providers/     # adapter interface, fake provider, unreliable simulator, conformance suite
  observability/ # logger, redaction allowlist, OTel bootstrap, metrics registry
  testkit/       # Testcontainers PG fixture, seed builders, polling helpers, crash hooks
migrations/      # forward-only SQL (see §8)
schemas/  openapi/  docs/
test/{contract,integration,e2e,chaos,performance}/
test/support/     # shared test helpers that must import from apps/ (e.g. simulator fixture); testkit cannot import apps/
infra/{docker,terraform}/
```

Package names: `@flowledger/<dir>` (e.g. `@flowledger/domain`). Apps: `@flowledger/app-<dir>`.

Dependency direction (enforced by an ESLint `no-restricted-imports` rule added in P00):
`domain` → nothing. `contracts` → nothing internal. `config`, `observability` → nothing internal. `database` → `domain`, `contracts`, `config`, `observability`. `messaging` → `contracts`, `database`, `config`, `observability`. `providers` → `domain`, `contracts`, `config`, `observability`. `testkit` → anything. `apps/*` → any package. **No package imports from `apps/`.** Crash hooks: the primitive `crashPoint(name)` lives in `packages/config/src/crash-points.ts` (created P05-T08; no-op unless `FLOWLEDGER_FAULT_HOOKS=1`; in-process armed points throw `CrashPointError`, points listed in `FLOWLEDGER_CRASH_POINTS` SIGKILL the process — exit 137). `packages/testkit/src/crash-points.ts` only arms/disarms. No other crash-hook module exists. SQL-side fault points (test-only GUC checks inside protected functions) are equally valid crash points.

## 4. Commands **[PROPOSED]** — created in P00, used by every task

All run from the repo root.

| Command | What it runs |
| --- | --- |
| `pnpm install --frozen-lockfile` | install |
| `pnpm lint` | `eslint . && prettier --check .` |
| `pnpm format` | `prettier --write .` |
| `pnpm typecheck` | `tsc -b` over all project references |
| `pnpm build` | `tsc -b` emit for apps/packages |
| `pnpm contracts:generate` | regenerate `packages/contracts/src/generated/**` from `openapi/` + `schemas/` |
| `pnpm contracts:check` | regenerate into a temp dir and fail on diff (drift check) |
| `pnpm test:unit` | `vitest run --project unit` |
| `pnpm test:contracts` | `vitest run --project contracts` |
| `pnpm test:integration` | `vitest run --project integration` (Testcontainers PostgreSQL 17; Docker required) |
| `pnpm test:e2e` | `vitest run --project e2e` (spawns apps against Testcontainers PG + local transport) |
| `pnpm test:chaos` | `vitest run --project chaos` (crash-point suite; `FLOWLEDGER_FAULT_HOOKS=1`) |
| `pnpm test:performance` | `node test/performance/run.mjs <profile>` (k6 wrapper; P12) |
| `pnpm db:up` / `pnpm db:down` | `docker compose -f infra/docker/compose.yaml up -d` / `down -v` |
| `pnpm db:migrate` | `pnpm --filter @flowledger/app-cli exec flowledger migrate` |
| `pnpm db:seed` | `flowledger seed --profile dev` |
| `pnpm verify:ledger` | `flowledger verify` against `DATABASE_URL` (P03+) |
| `pnpm check` | `lint && typecheck && contracts:check && test:unit && test:contracts` (the fast PR gate) |

Run a single test file: `pnpm vitest run --project <unit|contracts|integration|e2e|chaos> <path>`.

Vitest projects are defined once in the root `vitest.config.ts`:

| Project | Includes |
| --- | --- |
| `unit` | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` |
| `contracts` | `test/contract/**/*.test.ts` |
| `integration` | `test/integration/**/*.test.ts` |
| `e2e` | `test/e2e/**/*.test.ts` |
| `chaos` | `test/chaos/**/*.test.ts` |

Pure-logic tests of the performance harness live under `test/contract/performance/` (contracts project); k6 scripts under `test/performance/` are not Vitest files.

A task's "Testing requirements" name exact file paths under these globs.

## 5. Money **[CONTRACT: 02, 05]**

- Domain type: `type MinorUnits = bigint & { readonly __brand: 'MinorUnits' }` in `packages/domain/src/money.ts`.
- Wire: unsigned decimal string, `^(0|[1-9][0-9]*)$`, max `1000000000000`. JSON numbers for money are rejected.
- DB: `bigint`. `pg` returns `bigint` as string — `packages/database` sets a type parser for OID 20 that returns a JS `bigint`. JavaScript `number` MUST NOT appear in any money calculation. P01 adds a narrow ESLint `no-restricted-syntax` rule over `packages/domain/src/money.ts` and `fees.ts` banning `Number(`, `parseInt(`, `parseFloat(`, and numeric literals in arithmetic (`docs/09:85`); reviewers grep other money paths. Refund fee math `F*R` can reach 10^24: SQL uses `numeric` for the intermediate (P07), TS uses `bigint`.
- Currency: literal `'USD'` only.

## 6. Identifiers **[CONTRACT: 07 §IDs, schemas/common/entity-ids]**

- Public IDs: `<prefix>_<26-char Crockford ULID>`, first ULID char `0`–`7`. Generated by `newId(prefix)` in `packages/domain/src/ids.ts` (wraps `ulid`). Each prefix has a branded type (`PaymentId`, `OperationId`, …) and a parser that rejects anything not matching `^<prefix>_[0-7][0-9A-HJKMNP-TV-Z]{25}$`.
- Wire-visible prefixes: `schemas/common/entity-ids.v1.schema.json` is authoritative. Database-only IDs (never on the wire) use the prefixes `docs/07` gives (e.g. `led_`, `lac_`, `lcr_`, `mcr_`, `pac_`, `pwe_`, `fee_`, `pev_`); these are known gaps in the schema file (README §10.4). Any prefix in neither place: stop and report (§14).
- Envelope IDs and event IDs: UUID v4 from `crypto.randomUUID()`, stored as PostgreSQL `uuid`.

## 7. Database access **[PROPOSED]** unless noted

- One `pg.Pool` per process, created in `packages/database/src/pool.ts` from `DATABASE_URL` and `DATABASE_POOL_MAX`.
- All writes go through `withTransaction(pool, ctx, fn)` in `packages/database/src/tx.ts`:
  - `BEGIN ISOLATION LEVEL READ COMMITTED`.
  - If `ctx.merchantId` is set: `SELECT set_config('app.merchant_id', $1, true)` **[CONTRACT: 07 §Tenant isolation]**.
  - If `ctx.correlationId` is set: `set_config('app.correlation_id', $1, true)`.
  - Retries the whole callback up to 5 times on SQLSTATE `40001` (serialization) and `40P01` (deadlock) with jittered backoff 10–200 ms. The callback MUST be re-entrant and reuse the same idempotency/provider/posting keys **[CONTRACT: 07 lock order]**.
- No HTTP/provider call inside `fn` **[CONTRACT]**. `withTransaction` does not enforce this; reviewers check it.
- Application code mutates `payments.*`, `ledger.*`, `settlement.*`, `messaging.outbox_messages` **only** by calling protected `SECURITY DEFINER` functions **[CONTRACT: ADR-0007]**. TypeScript wrappers for each function live in `packages/database/src/functions/<schema>.ts`, one exported function per SQL function, same name in camelCase.
- SQLSTATE mapping: protected functions raise domain errors with `RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '<DOMAIN_CODE>', DETAIL = '<json>'`. `packages/database/src/errors.ts` maps `P0001` + message to a typed `DomainError` with `code` equal to the problem code in `docs/05` §Canonical error format. Internal invariant failures with no merchant-facing problem code (e.g. ledger posting rejections reachable only through protected paths) use an `INTERNAL_`-prefixed code, are listed in `packages/database/src/errors.ts`, and map to HTTP `500 INTERNAL_ERROR` if they ever reach the API. Unique-violation (`23505`) and check-violation (`23514`) are mapped only where a task says so.

### Roles **[PROPOSED]** — the contracts require these roles but do not name them

| Role | Login | Purpose |
| --- | --- | --- |
| `fl_migration_owner` | yes | Runs migrations; owns schemas/tables. Never used by an app. |
| `payments_function_owner` | no | Owns `payments.*` protected functions ("protected payment-transition role" in 07). |
| `ledger_function_owner` | no | Owns `ledger.*` protected functions **[CONTRACT name]**. |
| `settlement_function_owner` | no | Owns `settlement.*` protected functions. |
| `messaging_function_owner` | no | Owns `messaging.*` protected functions. |
| `reconciliation_function_owner` | no | Owns `reconciliation.*` protected functions (P08). |
| `webhooks_function_owner` | no | Owns `webhooks.*` protected functions (P09). |
| `audit_function_owner` | no | Owns `audit.*` append functions (first used P10; audit table moved to P10-T11 because `docs/08` requires M10 operator commands to be audited). |

Identity/API credential lookup needs no function-owner role: it uses an RLS policy keyed on a transaction-local setting (P02 decision).
| `fl_api` | yes | API process. |
| `fl_relay` | yes | Outbox relay. |
| `fl_payment_worker` | yes | Payment worker, due-work scheduler, stale sweepers. Only role allowed to decrypt payment-method references (enforced in app config, not DB). |
| `fl_webhook_receiver` | yes | Provider webhook ingress. |
| `fl_webhook_worker` | yes | Provider notification processing. |
| `fl_reconciler` | yes | Reconciler. |
| `fl_settlement_worker` | yes | Settlement worker **[CONTRACT: separate role]**. |
| `fl_webhook_projector` | yes | Merchant webhook projector. |
| `fl_webhook_dispatcher` | yes | Merchant webhook dispatcher. |
| `fl_operator_readonly` | yes | Operator CLI read views. |
| `fl_operator_command` | yes | Operator CLI audited recovery commands. |
| `fl_perf_harness` | — | Not a role: P12/P13 harnesses use `PERF_ADMIN_DATABASE_URL` (superuser locally, `postgres` user with explicit grants on Cloud SQL) for `pg_locks`/`pg_stat_*` sampling only; never used by app code. |
| `fl_correction` | yes | Dual-control ledger correction entry point **[CONTRACT: 07 §Protected posting function]**. |

Roles are created by migration `0200` (P02). Local passwords come from `infra/docker/.env.example` (synthetic). Each app's `DATABASE_URL` uses its own role. The CLI acts as several roles and uses `MIGRATION_DATABASE_URL` (migrate/seed), `OPERATOR_DATABASE_URL` (read views), plus the command-specific URLs its phase tasks define.

## 8. Migrations **[PROPOSED]**

- Plain SQL files in `/migrations`, named `NNNN_<slug>.sql`, applied in lexical order by `flowledger migrate` (implemented in `packages/database/src/migrate.ts`, P02-T01).
- The runner records `(filename, sha256, applied_at)` in `public.schema_migrations`, runs each file in its own transaction as `fl_migration_owner`, and **fails** if an already-applied file's checksum changed.
- **Number ranges per phase** (prevents merge conflicts between parallel phases):

  | Phase | Range | Phase | Range |
  | --- | --- | --- | --- |
  | P02 | `0200`–`0299` | P08 | `0800`–`0899` |
  | P03 | `0300`–`0399` | P09 | `0900`–`0999` |
  | P04 | `0400`–`0499` | P10 | `1000`–`1099` |
  | P05 | `0500`–`0599` | P11 | `1100`–`1199` |
  | P06 | `0600`–`0699` | P12 | `1200`–`1299` |
  | P07 | `0700`–`0799` | P13 | `1300`–`1399` |

  Within a phase, tasks take numbers in steps of 10 (`0200`, `0210`, …) in task order, so a later fix-up can slot in between.
- **Incremental ordering rule (resolves conflict C-01, see README §10):** `docs/07` §Migration order lists one global order with all protected functions (step 16) and grants (step 17) last. Because this plan ships the schema milestone by milestone, **each migration file** applies that ordering locally: tables → constraints/indexes → triggers → protected functions → RLS policies → `REVOKE`/`GRANT` last. Grants always come last in their file so a partially applied migration never exposes an unprotected table.
- Branches from parallel phases (P03 ∥ P04) merge so that `main` always applies migrations in numeric order; the runner rejects a new file sorting before an applied one, so rebase onto `main` before merging.
- Forward-only. No down migrations. A wrong migration is fixed by a new migration.
- Seed data that the system requires to function (ledger, striped buckets, account templates) is a migration **[CONTRACT: 07 step 18]**. Developer convenience data (test merchants, credentials) is `flowledger seed --profile dev`, never a migration.
- Ledger bucket count: the seed migration reads `current_setting('flowledger.ledger_bucket_count', true)`, defaulting to `32` when unset. The migrate runner sets it from env `LEDGER_BUCKET_COUNT` via `SET` before running each file. It is fixed per database at creation; changing it later is a rebalancing migration **[CONTRACT: 02 §MVP decisions]**. Benchmarks create two separate databases (N=1, N=32) from the same commit (resolves conflict C-03). The ledger environment label (`LOCAL`/`SANDBOX`, `docs/07` §`ledger.ledgers`) is set the same way: GUC `flowledger.ledger_environment` from env `LEDGER_ENVIRONMENT`, default `LOCAL`.

## 9. Messages **[CONTRACT: 04, schemas/README]**

- Every outbox envelope is built by `buildEnvelope()` in `packages/contracts/src/envelope.ts`, validated by the Ajv 2020 validator (formats on, no remote refs) **and** the semantic correlation validator (`packages/contracts/src/semantic.ts`), then inserted only via `messaging.insert_outbox(envelope jsonb)` **[CONTRACT name: 07]**. Exception: where `docs/07` requires a protected SQL function to complete an envelope from authoritative rows (e.g. ledger and settlement events, `docs/07` §Protected posting function), TS builds and validates the envelope skeleton and the function fills only the contract-designated fields, then calls `insert_outbox`, whose derived-column checks still apply; tests validate the stored envelope with the same Ajv + semantic validators.
- Consumers validate (schema + semantic) before any effect; failures go to the DLQ path, never to a domain transition.
- Inbox key: `(consumer_name, envelope_id)` **[CONTRACT]**. Consumer names are kebab-case constants in `packages/messaging/src/consumers.ts`: `payment-worker`, `reconciler`, `provider-webhook-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`.
- Transport interface (`packages/messaging/src/transport.ts`, P05):

  ```ts
  export interface Transport {
    publish(topic: string, envelope: Envelope, orderingKey?: string): Promise<string>; // broker message ID, recorded on the outbox row
    subscribe(subscription: string, handler: (msg: ReceivedMessage) => Promise<'ack' | 'nack'>): Promise<Unsubscribe>;
    close(): Promise<void>;
  }
  ```
  Implementations (exactly two): `InMemoryTransport` (unit + integration, in-process) and `PubSubTransport` (e2e against the Pub/Sub emulator in Docker Compose via `PUBSUB_EMULATOR_HOST`, and deployed GCP). No third "local" transport.
- `provider-webhook-worker` consumes no cataloged message: it claims `providers.provider_notifications` rows from PostgreSQL (`SKIP LOCKED`), so it has an inbox consumer name only if a task gives it a subscription.
- Topics/subscriptions: one topic per message kind family — `flowledger-commands-v1` and `flowledger-events-v1` **[CONTRACT: 04 §MVP messaging decisions]** — plus one subscription per consumer name and one dead-letter topic per subscription. Names are constants in `packages/messaging/src/topology.ts`; the emulator bootstrap script and Terraform both read the same list.

## 10. HTTP **[CONTRACT: 05, openapi]**

- Errors: RFC 9457 problem details, content type `application/problem+json`, exact `code` values from `docs/05` §Canonical error format and `openapi.yaml` components. One mapping table in `apps/api/src/errors/problem-map.ts`.
- Request validation is generated from `openapi.yaml` component schemas compiled by Ajv 2020 with `additionalProperties: false` respected; unknown fields → `400`.
- Raw body is preserved for idempotency hashing and webhook signature verification.

## 11. Configuration **[PROPOSED]**

- All config is environment variables, parsed once at startup by `packages/config/src/<app>.ts` into a frozen typed object; invalid/missing config fails startup with the variable name (never its value).
- Test mode (`NODE_ENV=test`) MUST start with only `.env.example` values — no undocumented secret **[CONTRACT: 10 M0]**.
- Secret references (columns such as `secret_reference`, `signing_secret_reference`) are opaque strings resolved by `resolveSecretReference(ref: string): Promise<Uint8Array>` in `packages/config/src/secrets.ts`. Schemes: `local-secret://<path>` (local/test) resolves to env var `FLOWLEDGER_SECRET_<PATH>` where `<PATH>` is `<path>` upper-cased with every non-alphanumeric character replaced by `_`; the result is the UTF-8 bytes of the variable's value (no base64), matching the P09 HMAC golden vectors; in GCP (P13) Cloud Run injects Secret Manager values as those same env vars, so `local-secret://` is the only scheme. Unknown scheme or missing variable throws at use, naming the reference but never a value. The resolver is created by P06 (first runtime consumer: provider credentials); later phases reuse it. HMAC keys are exactly these bytes.
- Every variable is listed in `infra/docker/.env.example` with a synthetic value and in `docs/CONFIG.md` (created P00, appended by any task that adds a variable).

## 12. Observability and redaction **[CONTRACT: 04 §Sensitive data, 06 §Redaction, 08 §Recovery observability]**

- Single redaction allowlist in `packages/observability/src/redaction.ts`. Logs, traces, error bodies, test snapshots, and DLQ payload previews pass through it. Fields not on the allowlist are dropped, not masked.
- Prohibited-data fixtures (synthetic PAN, CVV, bearer token, provider secret) live in `packages/testkit/src/prohibited-data.ts` (created in P00) and every task that adds a log/trace/event surface adds a negative test using them.
- Metric names: `docs/08` §Recovery observability names are contractual. `docs/09` §Required metrics describes but does not name metrics; the single registry of exact names is the metric table in `tasks/P11-security-observability.md`, implemented in `packages/observability/src/metrics.ts`. Code before P11 that emits a metric uses a name from that table. No IDs as metric labels **[CONTRACT]**.

## 13. Git and commits

- Conventional Commits. Scope = package/app/area: `repo`, `ci`, `contracts`, `domain`, `db`, `ledger`, `api`, `messaging`, `providers`, `worker`, `reconciler`, `webhooks`, `settlement`, `obs`, `security`, `cli`, `perf`, `infra`, `docs`.
- One task = one commit unless the task file says otherwise. Commit body lists the Task ID (`Task: P03-T04`).
- Every commit leaves `pnpm check` green. Commits touching `migrations/`, `packages/database/`, or protected SQL also leave `pnpm test:integration` green.
- Never commit generated files except `packages/contracts/src/generated/**` (committed so drift is reviewable).
- Branch per task: `task/p03-t04-<slug>`.

## 14. When to stop and ask

Stop and report instead of improvising when:

1. A contract and a task instruction disagree.
2. A required name (table, column, function, error code, event type, ID prefix) is not in the contracts or this file.
3. SQL cannot enforce an invariant the task says the database enforces.
4. A test the task requires cannot be made to fail by breaking the invariant it claims to test (a test that cannot fail is not evidence **[CONTRACT: README]**).
5. The task would need to modify a file owned by a later phase or a shared surface listed in README §5.4 (single-owner surfaces).

Report format: `BLOCKED: <task id> — <one-line reason> — <file:line of conflicting sources>`.

## 15. Task file format

Every task in `tasks/*.md` uses exactly these headings, in this order:

```markdown
### P03-T04 — <short title>

**Task ID:** `P03-T04`
**Feature:** <feature name>
**Commit:** `feat(ledger): <message>`
**Priority:** Critical | High | Medium | Low
**Dependencies:** <task IDs, or `P02-GATE` for a whole phase>
**Estimated complexity:** S | M | L
**Contract references:** <doc § and schema paths the agent must read>
**Files:** create: <paths>; modify: <paths>; must not touch: <paths>

**Objective** — what and why.

**Implementation instructions** — numbered steps; exact names, SQL, signatures, error codes.

**Expected behavior** — representative inputs → outputs.

**Acceptance criteria** — `- [ ]` checklist, each objectively checkable.

**Testing requirements** — exact test files, cases (positive/negative/boundary/concurrency/crash), fixtures, and the exact command(s).

**Non-goals** — what this task must not do.

**Handoff checklist** — `- [ ]` items the agent ticks before committing.
```

The Definition of Done is common to all tasks and is not repeated per task (README §6.0):

1. Every acceptance criterion is satisfied.
2. Every required test exists, passes, and was observed to **fail** when the invariant it protects is deliberately broken (then restored).
3. `pnpm check` passes; `pnpm test:integration` passes if the task touches SQL, `packages/database`, or any app that talks to PostgreSQL.
4. Only files listed under **Files** changed (plus `docs/CONFIG.md` / `.env.example` when a variable is added).
5. No debug output, commented-out code, `TODO` without a task ID, skipped tests, or unapproved dependency.
6. The commit message matches the task's **Commit** line and its body contains `Task: <id>`.

Cross-phase dependencies use the phase gate ID `Pnn-GATE` (the last task of each phase file, which runs that phase's integration verification). Within a phase, depend on specific task IDs.

## 16. Provider simulator process **[DECIDED D-02, 2026-11-08 — resolves gap G-01]**

The contracts require the fake provider to "persist provider-side state separately from FlowLedger state", emit signed webhooks, use a controllable clock, and expose ground truth only to test harnesses (docs/06 §Deterministic fake provider), and require the duplicate-effect detector to compare against that ground truth (docs/09). Because the payment worker, reconciler, and webhook pipeline run as separate processes (locally and on Cloud Run), provider state cannot live in one process's memory. Therefore:

- `apps/provider-simulator` is a Fastify HTTP service (no NestJS needed) that implements the fake provider's server side. Its state lives in a **separate PostgreSQL database** `flowledger_sim` (same server locally; a separate small Cloud SQL instance in P13 so simulator load stays off the system under test), owned by login role `fl_simulator`. No FlowLedger role has any privilege on it, and the simulator has none on the FlowLedger database. Its own forward-only SQL lives in `apps/provider-simulator/migrations/` and is applied by the simulator at startup in test/dev only, or by `flowledger migrate --simulator` (P06 decides one; document it).
- The simulator's own owner connection string is `PROVIDER_SIMULATOR_DATABASE_URL` (role `fl_simulator`); `SIMULATOR_DATABASE_URL` is the read-only truth connection.
- `packages/providers` contains the `PaymentProvider` adapters as **HTTP clients** of that service: `FakeProviderAdapter` (honest client) and `UnreliableProviderAdapter`. Faults that must happen *after* the provider commits (timeout/connection loss after commit, malformed success) are injected **server-side** by the simulator from a seeded PRNG keyed per provider idempotency key, so they are deterministic across processes and restarts; pre-dispatch faults may be client-side. Fault selection is recorded in a simulator diagnostics table (test-only).
- Webhooks: the simulator POSTs signed provider webhooks to `provider-webhook-receiver`, including configured duplicates, delays, and out-of-order delivery.
- Controllable clock: `POST /__test/clock` on the simulator, enabled only when `SIMULATOR_TEST_ENDPOINTS=1`.
- Ground truth: harnesses (including `flowledger verify`'s duplicate-effect class) read it via `SIMULATOR_DATABASE_URL` with a read-only role `fl_simulator_truth`. FlowLedger runtime code (packages other than `testkit`, apps other than `cli verify`) MUST NOT read this variable; an ESLint `no-restricted-syntax`/import rule enforces it for `packages/providers` and all worker apps. When `SIMULATOR_DATABASE_URL` is unset, the duplicate-effect class reports `0 rows checked (ground truth unavailable)` and `verify` exits non-zero only if `--require-ground-truth` is passed (CI passes it from P06-GATE onward, once the simulator exists; benchmarks always pass it).
- Unit tests of adapter mapping logic may use an in-memory simulator core (`apps/provider-simulator/src/core.ts` exported pure logic) — the same code the HTTP service runs, not a separate mock.
