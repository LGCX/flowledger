# P02 — PostgreSQL and durable-messaging foundation

## Phase overview

**Goal.** Ship the M2 persistence foundation: a checksum-guarded migration runner and `flowledger migrate`, the transaction/error helpers every later phase uses, roles/schemas/helpers, identity and credential digests, provider configuration with deterministic route selection, append-only fee policies, the payment aggregate and payment-operation tables (partial unique indexes, refund-reservation fields, deferred aggregate-consistency trigger), API idempotency records with an atomic claim primitive, outbox/inbox/DLQ/replay persistence with the strict `messaging.insert_outbox` boundary, RLS, least-privilege grants, a Testcontainers fixture, and a dev seed.

**Entry criteria.** `P01-GATE` green (domain kernel: `packages/domain/src/ids.ts`, `money.ts`; contracts from P00-T11: `packages/contracts/src/envelope.ts` `buildEnvelope()` with Ajv + semantic validation). `P00-GATE` artifacts present: pnpm workspace, root `vitest.config.ts` with the five projects, inert `apps/cli` (`flowledger` bin), `infra/docker/compose.yaml` with `postgres:17`, `infra/docker/.env.example`, `docs/CONFIG.md`, `packages/testkit/src/prohibited-data.ts`.

**Exit gate (docs/10 M2).** "Core migration, tenant-isolation, and persistence tests pass" — proven by `P02-GATE`: migrations apply from an empty database and from the committed populated fixture `test/fixtures/db/P02.sql`; RLS and revoked-DML matrices pass for every runtime role; one hundred concurrent claims of one idempotency key elect one owner; deferred trigger rejects pointer/reservation drift; invalid envelopes cannot enter the outbox.

**Interfaces consumed from earlier phases**

| From | Interface |
| --- | --- |
| P00 | `vitest.config.ts` projects `unit`/`contracts`/`integration`/`e2e`/`chaos`; `apps/cli/src/main.ts` (inert bin `flowledger`); `infra/docker/compose.yaml`; `infra/docker/.env.example`; `docs/CONFIG.md`; `packages/testkit/src/prohibited-data.ts` |
| P01 | `newId(prefix)` and branded ID parsers in `packages/domain/src/ids.ts`; `MinorUnits` in `packages/domain/src/money.ts` |
| P00 | `buildEnvelope()` in `packages/contracts/src/envelope.ts` (P00-T11; schema + semantic validation on construction) |

**Interfaces provided to later phases**

| Interface | Kind | Contract |
| --- | --- | --- |
| `createPool(opts)` — `packages/database/src/pool.ts` | TS | One pool per process; OID 20 (`bigint`) parsed to JS `bigint` |
| `withTransaction(pool, ctx, fn)` — `packages/database/src/tx.ts` | TS | READ COMMITTED, `app.merchant_id`/`app.correlation_id` via `set_config(...,true)`, retries 40001/40P01 up to 5 times |
| `DomainError`, `mapPgError`, `DOMAIN_ERROR_CODES` — `packages/database/src/errors.ts` | TS | `P0001` + message → typed error; later phases append codes |
| `migrate(opts)`, `bootstrapDatabase(adminUrl, migrationUrl)`, `setLocalRolePasswords(client, pw)` — `packages/database/src/migrate.ts` | TS | CONVENTIONS §8 runner |
| `LOGIN_RUNTIME_ROLES`, `FUNCTION_OWNER_ROLES` — `packages/database/src/roles.ts` | TS | CONVENTIONS §7 role catalog |
| `useTestDatabase()`, `withRole()`, `createEmptyDatabase()` — `packages/testkit/src/pg.ts`; `createTestMerchant()` — `packages/testkit/src/fixtures/merchant.ts`; `fixture*` payment helpers — `packages/testkit/src/fixtures/payments.ts`; `assertConstraintCoverage()` — `packages/testkit/src/constraints.ts` | TS | Test infrastructure |
| `generateCredential`, `parseCredential`, `credentialDigest`, `verifyCredential`, `parsePeppers` — `packages/domain/src/credentials.ts` | TS | docs/05 §Authentication digest scheme |
| `lookupCredential`, `issueCredential`, `revokeCredential` — `packages/database/src/repositories/identity.ts` | TS | Pre-tenant credential lookup and operator issuance/revocation |
| `findPayment`, `findOperation` — `packages/database/src/repositories/payments.ts` | TS | Explicit merchant predicate + RLS |
| `public.fl_is_id`, `fl_is_sha256`, `fl_current_merchant_id`, `fl_raise_domain`, `fl_assert_unchanged`, `fl_reject_mutation`, `fl_touch_updated_at`, `fl_assign_function_owner` | SQL helpers | Reused by every migration in P03–P13 |
| `providers.select_route(p_merchant_id text, p_environment text, p_provider_code text)` | SQL, internal | Called by `payments.create_payment` (P04); raises `PROVIDER_ROUTE_UNAVAILABLE` |
| `api.claim_idempotency_key(...)` | SQL, internal | Called by `payments.create_payment` (P04) and `payments.accept_operation` (P05); returns `OWNER`/`REPLAY`/`CONFLICT`/`EXPIRED` or raises `IDEMPOTENCY_REQUEST_IN_PROGRESS` |
| `messaging.insert_outbox(p_envelope jsonb) RETURNS uuid` | SQL, `SECURITY DEFINER` | Only outbox insertion path; later phases `CREATE OR REPLACE` it to add subject-existence checks for ledger/webhook/settlement aggregates |
| `messaging.message_types` | SQL table | DB copy of `schemas/registry.v1.json`; a new message type requires a new migration row |
| Payment/operation update rule | SQL trigger | Every `UPDATE` of a `payments.payments` or `payments.payment_operations` row must set `version = OLD.version + 1`; protected functions perform exactly one `UPDATE` per row per transition |
| `test/fixtures/db/P02.sql` | Fixture | Populated dump for P03+ "migrate forward from previous fixture" tests; contains no terminal operations |
| `EXECUTE` on `messaging.insert_outbox(jsonb)` for `payments_function_owner`, `ledger_function_owner`, `settlement_function_owner`, `reconciliation_function_owner`, `webhooks_function_owner` (plus `USAGE` on schema `messaging`) | Grant (P02-T13) | Every later event-emitting protected function can insert outbox rows without a new grant |
| `fl_migration_owner` is a member of every `*_function_owner` role `WITH SET TRUE, INHERIT FALSE`; `public.fl_assign_function_owner(regprocedure, name)` reassigns ownership | Role membership + helper (P02-T03) | Later migrations create functions as `fl_migration_owner` and hand them to the owning function role |
| `migrate({ ledgerBucketCount })` / env `LEDGER_BUCKET_COUNT` (default 32, 1–1024); runner executes `set_config('flowledger.ledger_bucket_count', '<n>', true)` (equivalent to `SET LOCAL`) inside each file's transaction before the file's SQL | Runner (P02-T01) | P03 seed migration reads `current_setting('flowledger.ledger_bucket_count', true)` (CONVENTIONS §8). A `--simulator` migrate path is **not** provided by P02 (P06 decides) |

---

### P02-T01 — Migration runner, pool, bootstrap, `flowledger migrate`, and Testcontainers fixture

**Task ID:** `P02-T01`
**Feature:** Migration runner and database test infrastructure
**Commit:** `feat(db): add checksum-guarded migration runner, migrate command, and pg test fixture`
**Priority:** Critical
**Dependencies:** `P01-GATE`
**Estimated complexity:** L
**Contract references:** CONVENTIONS §3, §4, §7 (pool, roles), §8 (migrations), §11; docs/07 §Migration order; docs/10 §Fixed implementation choices ("Avoid an ORM"); docs/09 §PostgreSQL integration tests
**Files:** create: `packages/database/src/pool.ts`, `packages/database/src/roles.ts`, `packages/database/src/migrate.ts`, `packages/database/src/index.ts`, `packages/config/src/cli.ts`, `apps/cli/src/commands/migrate.ts`, `packages/testkit/src/pg.ts`, `packages/testkit/src/pg-global-setup.ts`, `migrations/.gitkeep`, `test/integration/db/migrate-runner.test.ts`; modify: `apps/cli/src/main.ts`, `apps/cli/package.json`, `packages/database/package.json`, `packages/testkit/package.json`, `packages/config/src/index.ts`, `vitest.config.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/*.sql`, `schemas/**`, `openapi/**`, `docs/0*.md`, `docs/adr/**`, `CONVENTIONS.md`

**Objective** — Provide the one forward-only SQL migration mechanism (no migration library), the per-process pool, a superuser bootstrap that creates `fl_migration_owner` and the database, the `flowledger migrate` command, and a Testcontainers PostgreSQL 17 fixture that applies all migrations once and hands each test file an isolated clone. Every later DB task builds on this.

**Implementation instructions**

1. `packages/database/src/pool.ts`:
   ```ts
   import pg from 'pg';
   pg.types.setTypeParser(20, (v: string) => BigInt(v)); // int8 -> bigint (CONVENTIONS §5)
   export interface PoolOptions { connectionString: string; max: number; applicationName: string }
   export function createPool(o: PoolOptions): pg.Pool; // new pg.Pool({ connectionString, max, application_name })
   ```
2. `packages/database/src/roles.ts` — exact names from CONVENTIONS §7:
   ```ts
   export const MIGRATION_OWNER = 'fl_migration_owner' as const;
   export const FUNCTION_OWNER_ROLES = ['payments_function_owner','ledger_function_owner','settlement_function_owner','messaging_function_owner','reconciliation_function_owner','webhooks_function_owner','audit_function_owner'] as const;
   export const LOGIN_RUNTIME_ROLES = ['fl_api','fl_relay','fl_payment_worker','fl_webhook_receiver','fl_webhook_worker','fl_reconciler','fl_settlement_worker','fl_webhook_projector','fl_webhook_dispatcher','fl_operator_readonly','fl_operator_command','fl_correction'] as const;
   export type FunctionOwnerRole = typeof FUNCTION_OWNER_ROLES[number];
   export type LoginRuntimeRole = typeof LOGIN_RUNTIME_ROLES[number];
   ```
3. `packages/database/src/migrate.ts`:
   ```ts
   export const DEFAULT_MIGRATIONS_DIR: string; // fileURLToPath(new URL('../../../migrations/', import.meta.url)) — same depth from src/ and dist/
   export interface MigrateOptions { connectionString: string; dir?: string; upTo?: string /* inclusive 4-digit prefix, e.g. '0230' */; ledgerBucketCount: number; ledgerEnvironment?: 'LOCAL' | 'SANDBOX' /* default 'LOCAL' */; expectedOwner?: string /* default 'fl_migration_owner'; P06 passes 'fl_simulator' for `migrate --simulator` */ }
   export interface MigrateResult { applied: string[]; skipped: string[] }
   export class MigrationError extends Error { constructor(readonly reason: 'NOT_MIGRATION_OWNER'|'CHECKSUM_MISMATCH'|'APPLIED_FILE_MISSING'|'OUT_OF_ORDER'|'INVALID_FILENAME'|'FILE_FAILED', readonly filename?: string) }
   export async function migrate(o: MigrateOptions): Promise<MigrateResult>;
   export async function bootstrapDatabase(adminUrl: string, migrationUrl: string): Promise<void>;
   export async function setLocalRolePasswords(client: pg.ClientBase, password: string): Promise<string[]>; // returns roles altered
   ```
   `migrate` algorithm (one dedicated `pg.Client`, not a pool):
   1. Connect; `SELECT current_user`; if not `expectedOwner` (default `fl_migration_owner`) throw `NOT_MIGRATION_OWNER`.
   2. `SELECT pg_advisory_lock(hashtext('flowledger.migrate'))` (released in `finally` with `pg_advisory_unlock`).
   3. `CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text COLLATE "C" PRIMARY KEY, sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32), applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`.
   4. List `*.sql` in `dir` (default `DEFAULT_MIGRATIONS_DIR`). Every `.sql` filename MUST match `^[0-9]{4}_[a-z0-9_]+\.sql$` else throw `INVALID_FILENAME`. Sort with plain code-unit comparison. Apply `upTo` filter (`filename.slice(0,4) <= upTo`).
   5. Compute SHA-256 (`node:crypto`) of each file's bytes. For each row in `schema_migrations`: missing on disk → `APPLIED_FILE_MISSING`; checksum differs → `CHECKSUM_MISMATCH`. Both checks happen before applying anything.
   6. Any unapplied file that sorts before the greatest applied filename → `OUT_OF_ORDER` (prevents divergent histories between developer databases and fresh databases).
   7. For each unapplied file in order: `BEGIN`; `SELECT set_config('flowledger.ledger_bucket_count', $1, true), set_config('flowledger.ledger_environment', $2, true)` with `String(ledgerBucketCount)` and `ledgerEnvironment` (CONVENTIONS §8); execute the file text with one simple-protocol `client.query(text)`; `INSERT INTO public.schema_migrations (filename, sha256) VALUES ($1,$2)`; `COMMIT`. On error: `ROLLBACK`, throw `FILE_FAILED` with `filename` and `cause`. Earlier files stay committed.
   `bootstrapDatabase` (connects with `adminUrl`, a superuser): parse `migrationUrl` with `new URL()`; user MUST be `fl_migration_owner`; if `pg_roles` lacks it run `CREATE ROLE fl_migration_owner LOGIN CREATEROLE PASSWORD <literal>` else `ALTER ROLE fl_migration_owner LOGIN CREATEROLE PASSWORD <literal>` (literal via `client.escapeLiteral`); if `pg_database` lacks the URL's database run `CREATE DATABASE <escapeIdentifier(db)> OWNER fl_migration_owner`. Idempotent.
   `setLocalRolePasswords`: for each name in `LOGIN_RUNTIME_ROLES` that exists in `pg_roles`, `ALTER ROLE <ident> PASSWORD <literal>`. Run by `fl_migration_owner` (it holds ADMIN OPTION on roles it created in `0200`).
4. `packages/config/src/cli.ts` — `loadCliConfig(env: NodeJS.ProcessEnv): Readonly<CliConfig>`; invalid values throw `Error` naming the variable, never its value:
   | Variable | Required by | Rule |
   | --- | --- | --- |
   | `MIGRATION_DATABASE_URL` | `migrate`, `seed` | URL whose user is `fl_migration_owner` |
   | `DATABASE_ADMIN_URL` | `migrate --bootstrap` | optional URL (superuser) |
   | `LEDGER_BUCKET_COUNT` | `migrate` | integer 1–1024, default `32` |
   | `LEDGER_ENVIRONMENT` | `migrate` | `LOCAL` or `SANDBOX`, default `LOCAL` (CONVENTIONS §8) |
   | `FLOWLEDGER_LOCAL_ROLE_PASSWORD` | `migrate` | optional; refused when `NODE_ENV=production` |
   | `DATABASE_POOL_MAX` | all | integer 1–100, default `4` |
   Commands check that their required variable is present. Add each variable with a synthetic value to `infra/docker/.env.example` and a row to `docs/CONFIG.md`. **[ASSUMPTION]** The CLI uses one URL variable per role it acts as (`MIGRATION_DATABASE_URL`, later `OPERATOR_DATABASE_URL`) because it is a multi-role tool; services keep `DATABASE_URL`.
5. `apps/cli/src/commands/migrate.ts`: `export async function migrateCommand(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number>` parsing with `node:util` `parseArgs` options `--bootstrap` (boolean), `--dir` (string), `--up-to` (string). Flow: if `--bootstrap` → `bootstrapDatabase(DATABASE_ADMIN_URL, MIGRATION_DATABASE_URL)`; `migrate(...)`; if `FLOWLEDGER_LOCAL_ROLE_PASSWORD` set → `setLocalRolePasswords`. Print one line per applied file (`applied 0200_foundation.sql`) and a summary; return exit code `0`, or `1` printing `MigrationError.reason` + filename. Wire `migrate` into `apps/cli/src/main.ts` subcommand dispatch (`flowledger migrate ...`). Root `pnpm db:migrate` already maps to it (CONVENTIONS §4).
6. `packages/testkit/src/pg-global-setup.ts` (Vitest `globalSetup`, registered in `vitest.config.ts` for the `integration`, `e2e`, and `chaos` projects): start `new PostgreSqlContainer('postgres:17').withCommand(['postgres','-c','max_connections=400','-c','fsync=off'])`; `bootstrapDatabase(adminUrl, ownerUrl('fl_template'))`; `migrate({ connectionString: ownerUrl('fl_template'), ledgerBucketCount: 32 })`; `setLocalRolePasswords(..., TEST_ROLE_PASSWORD)`; close all connections to `fl_template`; `provide('flowledgerPg', { adminUrl, host, port })`; teardown stops the container. Declare `interface ProvidedContext { flowledgerPg: { adminUrl: string; host: string; port: number } }`.
7. `packages/testkit/src/pg.ts`:
   ```ts
   export const TEST_ROLE_PASSWORD = 'fl_local_test_password';      // synthetic
   export const TEST_MIGRATION_OWNER_PASSWORD = 'fl_local_owner_password'; // synthetic
   export interface TestDatabase {
     name: string;
     ownerPool: pg.Pool;                       // fl_migration_owner; RLS-exempt table owner; triggers still fire
     poolAs(role: LoginRuntimeRole): pg.Pool;  // cached per role, password TEST_ROLE_PASSWORD
     urlAs(role: LoginRuntimeRole | 'fl_migration_owner'): string;
   }
   export function useTestDatabase(): () => TestDatabase; // beforeAll: CREATE DATABASE fl_t_<8 hex> TEMPLATE fl_template OWNER fl_migration_owner; afterAll: end pools, DROP DATABASE ... WITH (FORCE)
   export async function createEmptyDatabase(): Promise<{ name: string; ownerUrl: string; drop(): Promise<void> }>; // CREATE DATABASE ... OWNER fl_migration_owner (from template0)
   export async function withRole<T>(pool: pg.Pool, role: FunctionOwnerRole, fn: (c: pg.PoolClient) => Promise<T>, opts?: { merchantId?: string }): Promise<T>;
   // BEGIN; SET LOCAL ROLE <role>; optional set_config('app.merchant_id',$1,true); fn; COMMIT (ROLLBACK + rethrow on error)
   ```
   Migrations are applied once per run (into `fl_template`); each test file gets its own clone; tests isolate further by creating their own merchants (`createTestMerchant`, P02-T07). **[ASSUMPTION]** One container per Vitest run with a template clone per file replaces "one container per worker" from README §8.3; isolation and "migrations applied once" are preserved at lower cost.

**Expected behavior**
- Empty DB + `flowledger migrate --bootstrap` → `fl_migration_owner` and database exist, all files applied, exit 0. Second run → `0 applied`, exit 0.
- Editing an applied file's bytes → exit 1, `CHECKSUM_MISMATCH 0200_foundation.sql`, nothing applied.
- A file whose SQL fails → that file rolled back, earlier files remain in `schema_migrations`, exit 1 `FILE_FAILED`.
- Running as any role other than `fl_migration_owner` → `NOT_MIGRATION_OWNER`.

**Acceptance criteria**
- [ ] `migrate` applies files in lexical order, each in its own transaction, recording `(filename, sha256, applied_at)`.
- [ ] Checksum change, missing applied file, out-of-order new file, and bad filename each fail before any file is applied.
- [ ] `flowledger.ledger_bucket_count` is visible inside each file via `current_setting('flowledger.ledger_bucket_count', true)` and equals `LEDGER_BUCKET_COUNT`.
- [ ] Two concurrent `migrate` calls on one database apply each file exactly once (advisory lock).
- [ ] `bootstrapDatabase` is idempotent.
- [ ] `useTestDatabase()` yields a database containing every migration in `migrations/` and is dropped after the file.
- [ ] No migration library, ORM, or query builder added; only approved deps (`pg`, `@testcontainers/postgresql`).

**Testing requirements** — `test/integration/db/migrate-runner.test.ts` using `createEmptyDatabase()` and temp migration dirs under `os.tmpdir()`:
- applies `0001_a.sql`, `0002_b.sql` in order; `schema_migrations` has two rows with correct SHA-256.
- re-run → `applied: []`.
- modify `0001_a.sql` → `MigrationError` reason `CHECKSUM_MISMATCH`; no new file applied even if `0003_c.sql` was added.
- delete applied `0002_b.sql` → `APPLIED_FILE_MISSING`.
- add `0001b`-style earlier file `0001_z.sql` after `0002` applied → `OUT_OF_ORDER`.
- `bad-name.sql` present → `INVALID_FILENAME`.
- `0003_fail.sql` containing `SELECT 1/0;` after a `CREATE TABLE t3` statement → `FILE_FAILED`, table `t3` absent, `0001`/`0002` remain applied.
- file `SELECT set_config('x.out', current_setting('flowledger.ledger_bucket_count', true), false)` style check: create a table from `current_setting(...)` and assert value `'7'` when `ledgerBucketCount: 7`.
- connecting as a non-owner role (create a throwaway `LOGIN` role via admin) → `NOT_MIGRATION_OWNER`.
- `Promise.all` of two `migrate` calls → every file applied once (`count(*)` per filename = 1).
- `migrateCommand(['--up-to','0001'], env, out)` applies only `0001_a.sql` and returns 0.
- Command: `pnpm vitest run --project integration test/integration/db/migrate-runner.test.ts`.

**Non-goals** — No SQL migrations (P02-T03 onward). No down migrations. No `tx.ts`/`errors.ts` (P02-T02). No seed command.

**Handoff checklist**
- [ ] Each failure-mode test was seen to fail with the corresponding guard removed.
- [ ] `.env.example` and `docs/CONFIG.md` list every new variable with synthetic values.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T02 — Transaction helper and domain-error mapping

**Task ID:** `P02-T02`
**Feature:** Database access helpers
**Commit:** `feat(db): add withTransaction retry helper and SQLSTATE domain-error mapping`
**Priority:** Critical
**Dependencies:** `P02-T01`
**Estimated complexity:** M
**Contract references:** CONVENTIONS §7 (tx, SQLSTATE mapping); docs/07 §Tenant isolation (`SET LOCAL app.merchant_id`), §Transaction and lock ownership (retries reuse keys); docs/05 §Canonical error format
**Files:** create: `packages/database/src/tx.ts`, `packages/database/src/errors.ts`, `packages/database/src/errors.test.ts`, `test/integration/db/tx.test.ts`; modify: `packages/database/src/index.ts`; must not touch: `migrations/**`

**Objective** — One transaction helper with tenant/correlation context and bounded retry on serialization/deadlock, and one mapping from protected-function exceptions to typed errors, so no later task hand-rolls `BEGIN`/`COMMIT` or parses SQLSTATEs.

**Implementation instructions**
1. `packages/database/src/errors.ts`:
   ```ts
   export const DOMAIN_ERROR_CODES = [
     // docs/05 problem codes raised from SQL (later phases append, never rename)
     'IDEMPOTENCY_REQUEST_IN_PROGRESS','PROVIDER_ROUTE_UNAVAILABLE','ACTIVE_OPERATION_EXISTS','INVALID_PAYMENT_STATE',
     'MONETARY_GUARD_FAILED','CAPTURE_BELOW_MINIMUM','PAYMENT_VERSION_MISMATCH','RESOURCE_NOT_FOUND',
     // internal invariant codes (no docs/05 code; API maps them to 500 INTERNAL_ERROR)
     'INVALID_ENVELOPE','IMMUTABLE_ROW','IMMUTABLE_FIELD','INVALID_TRANSITION','TENANT_CONTEXT_MISMATCH',
   ] as const;
   export type DomainErrorCode = typeof DOMAIN_ERROR_CODES[number];
   export class DomainError extends Error {
     constructor(readonly code: DomainErrorCode, readonly detail: Readonly<Record<string, unknown>>) { super(code); }
   }
   export function mapPgError(err: unknown): unknown;
   ```
   `mapPgError`: if `err` is a `pg.DatabaseError` with `code === 'P0001'` and `message` ∈ `DOMAIN_ERROR_CODES`, return `new DomainError(message, JSON.parse(detail ?? '{}'))` (unparseable detail → `{}`); otherwise return `err` unchanged. `23505`/`23514` are not mapped here. **[ASSUMPTION]** internal invariant codes share `DomainError`; risk R11.
2. `packages/database/src/tx.ts`:
   ```ts
   export interface TxContext { merchantId?: string; correlationId?: string }
   export async function withTransaction<T>(pool: pg.Pool, ctx: TxContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
   ```
   Per attempt: `pool.connect()`; `BEGIN ISOLATION LEVEL READ COMMITTED`; if `ctx.merchantId` → `SELECT set_config('app.merchant_id', $1, true)`; if `ctx.correlationId` → `SELECT set_config('app.correlation_id', $1, true)`; `await fn(client)`; `COMMIT`; release. On error: `ROLLBACK` (if ROLLBACK itself fails, `client.release(err)` to destroy the connection); if SQLSTATE is `40001` or `40P01` and fewer than 5 retries done, sleep a uniform random 10–200 ms and retry the whole attempt (max 6 attempts total); else throw `mapPgError(err)`. Errors thrown by `COMMIT` (deferred-constraint failures) follow the same path.
3. Export both modules from `packages/database/src/index.ts`.

**Expected behavior**
- `fn` raising `RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MONETARY_GUARD_FAILED', DETAIL='{"available":"5"}'` → rejects with `DomainError { code:'MONETARY_GUARD_FAILED', detail:{ available:'5' } }`.
- `fn` failing with `40001` twice then succeeding → resolves; `fn` invoked 3 times.

**Acceptance criteria**
- [ ] `app.merchant_id` is visible inside `fn` and empty (`''` or null) on the same pooled connection after the transaction ends.
- [ ] 40001/40P01 retried at most 5 times; the 6th failure propagates the original `pg` error.
- [ ] Non-retryable errors roll back all statements of the attempt.
- [ ] Deferred-constraint failure at `COMMIT` rejects the promise and leaves no rows.

**Testing requirements**
- `packages/database/src/errors.test.ts` (unit): known code maps with parsed detail; unknown `P0001` message returned unchanged; non-`P0001` returned unchanged; malformed detail → `{}`.
- `test/integration/db/tx.test.ts` (uses `useTestDatabase()`, temp table created by `ownerPool`): context visible inside, absent after (pool `max: 1` to force connection reuse); retry on `RAISE EXCEPTION USING ERRCODE='40001'` controlled by a JS attempt counter (succeeds on 3rd); 40P01 same; 6 consecutive 40001 → rejects with code `40001` after exactly 6 attempts; error after an `INSERT` leaves zero rows; deferred constraint (temp `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` raising always) fails at commit and leaves zero rows.
- Commands: `pnpm vitest run --project unit packages/database/src/errors.test.ts`; `pnpm vitest run --project integration test/integration/db/tx.test.ts`.

**Non-goals** — No repositories, no SQL migrations, no HTTP problem mapping (P04 owns `apps/api/src/errors/problem-map.ts`).

**Handoff checklist**
- [ ] Retry cap test fails if the cap is removed.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T03 — Migration 0200: schemas, roles, and common helpers

**Task ID:** `P02-T03`
**Feature:** Database foundation
**Commit:** `feat(db): add 0200 foundation migration with schemas, roles, and helpers`
**Priority:** Critical
**Dependencies:** `P02-T01`
**Estimated complexity:** M
**Contract references:** docs/07 §PostgreSQL conventions (Schemas, IDs, Common types), §Migration order step 1, §Tenant isolation items 3–4; CONVENTIONS §7 (roles), §8; ADR-0007
**Files:** create: `migrations/0200_foundation.sql`, `packages/testkit/src/constraints.ts`, `test/integration/db/foundation.test.ts`; modify: `packages/testkit/src/index.ts`; must not touch: other migrations

**Objective** — Create all ten contract schemas, every role in CONVENTIONS §7, and the helper functions every later migration reuses, without exposing anything to `PUBLIC`.

**Implementation instructions** (single file, order: schemas/roles → helper functions → grants)
1. Roles — idempotent because roles are cluster-wide and test databases share a cluster:
   ```sql
   DO $$
   DECLARE r text;
   BEGIN
     FOREACH r IN ARRAY ARRAY['payments_function_owner','ledger_function_owner','settlement_function_owner',
       'messaging_function_owner','reconciliation_function_owner','webhooks_function_owner','audit_function_owner'] LOOP
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
       EXECUTE format('GRANT %I TO fl_migration_owner WITH INHERIT FALSE, SET TRUE', r);
     END LOOP;
     FOREACH r IN ARRAY ARRAY['fl_api','fl_relay','fl_payment_worker','fl_webhook_receiver','fl_webhook_worker',
       'fl_reconciler','fl_settlement_worker','fl_webhook_projector','fl_webhook_dispatcher',
       'fl_operator_readonly','fl_operator_command','fl_correction'] LOOP
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I LOGIN', r); END IF;
     END LOOP;
   END $$;
   ```
   No passwords in SQL (set by `setLocalRolePasswords`, P02-T01).
2. Schemas (owner `fl_migration_owner`): `identity`, `providers`, `payments`, `api`, `ledger`, `settlement`, `messaging`, `webhooks`, `reconciliation`, `audit`. `REVOKE ALL ON SCHEMA <each> FROM PUBLIC`.
3. `ALTER DEFAULT PRIVILEGES FOR ROLE fl_migration_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;` (must precede every `CREATE FUNCTION`).
4. `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;` (`docs/07` §Migration order step 1). P02 itself uses only built-ins (`sha256(bytea)`, `gen_random_uuid()`), and the credential HMAC stays in TypeScript because the pepper never enters PostgreSQL; `pgcrypto` (`hmac`, `digest`) is required by P03 and by P11 operator-token verification (decision D-03).
5. Helper functions in `public` (owner `fl_migration_owner`):
   ```sql
   CREATE FUNCTION public.fl_is_id(p_value text, p_prefix text) RETURNS boolean
     LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
     RETURN p_value ~ ('^' || p_prefix || '_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
   CREATE FUNCTION public.fl_is_sha256(p_value bytea) RETURNS boolean
     LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE RETURN octet_length(p_value) = 32;
   CREATE FUNCTION public.fl_current_merchant_id() RETURNS text
     LANGUAGE sql STABLE PARALLEL SAFE RETURN nullif(current_setting('app.merchant_id', true), '');
   CREATE FUNCTION public.fl_raise_domain(p_code text, p_detail jsonb DEFAULT '{}') RETURNS void
     LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = p_detail::text; END $$;
   -- raises IMMUTABLE_FIELD {"table":..,"column":..} for the first listed column whose value differs
   CREATE FUNCTION public.fl_assert_unchanged(p_table text, p_old jsonb, p_new jsonb, p_columns text[]) RETURNS void LANGUAGE plpgsql ...;
   -- trigger: raises IMMUTABLE_ROW {"table":..,"operation":TG_OP}; usable BEFORE UPDATE/DELETE (row) and BEFORE TRUNCATE (statement)
   CREATE FUNCTION public.fl_reject_mutation() RETURNS trigger LANGUAGE plpgsql ...;
   -- trigger: NEW.updated_at := clock_timestamp(); RETURN NEW;
   CREATE FUNCTION public.fl_touch_updated_at() RETURNS trigger LANGUAGE plpgsql ...;
   -- migration-only: GRANT CREATE ON SCHEMA <fn schema> TO p_owner; ALTER FUNCTION p_function OWNER TO p_owner; REVOKE CREATE ...
   CREATE FUNCTION public.fl_assign_function_owner(p_function regprocedure, p_owner name) RETURNS void LANGUAGE plpgsql ...;
   ```
   Every helper sets `SET search_path = pg_catalog, pg_temp` where it is plpgsql.
6. Grants (last): `GRANT EXECUTE ON FUNCTION public.fl_is_id(text,text), public.fl_is_sha256(bytea), public.fl_current_merchant_id() TO PUBLIC` (pure functions used in CHECK constraints and RLS expressions evaluated as the querying role). `fl_raise_domain`, `fl_assert_unchanged` granted `EXECUTE` to all seven function-owner roles. `fl_assign_function_owner` has no grant (owner only).
7. `packages/testkit/src/constraints.ts`:
   ```ts
   // Lists CHECK/FK/UNIQUE/EXCLUDE constraints (pg_constraint contype IN ('c','f','u','x')) plus unique indexes
   // not backing a constraint (pg_index.indisunique) on `table`; fails listing any name missing from `covered`.
   export async function assertConstraintCoverage(pool: pg.Pool, table: string, covered: readonly string[]): Promise<void>;
   ```
   Every later table task names all its constraints/indexes explicitly and calls this helper.

**Expected behavior** — After `0200`: `SELECT public.fl_is_id('pay_01ARZ3NDEKTSV4RRFFQ69G5FAV','pay')` → `true`; `('pay_81ARZ3NDEKTSV4RRFFQ69G5FAV','pay')` → `false` (first char > 7); `fl_assert_unchanged` with a changed listed column raises `P0001 IMMUTABLE_FIELD`.

**Acceptance criteria**
- [ ] All 19 roles exist; function owners are `NOLOGIN`; runtime roles are `LOGIN`; none has `SUPERUSER`, `CREATEROLE`, `CREATEDB`, or `BYPASSRLS`.
- [ ] `fl_migration_owner` is a member of every function-owner role with `SET TRUE`, `INHERIT FALSE`.
- [ ] All 10 schemas exist, owned by `fl_migration_owner`; `PUBLIC` has neither `USAGE` nor `CREATE` on them.
- [ ] Re-applying `0200` SQL to a second database in the same cluster succeeds (role creation idempotent).
- [ ] A function created by `fl_migration_owner` after `0200` is not executable by `PUBLIC`.

**Testing requirements** — `test/integration/db/foundation.test.ts`:
- role attributes from `pg_roles` for every name in `roles.ts`; membership from `pg_auth_members` (`set_option`, `inherit_option`).
- `has_schema_privilege('fl_api', s, 'USAGE')` false for each schema at this point; `has_schema_privilege('public', s, 'CREATE')` false.
- `fl_is_id` table: valid; wrong prefix; 25 chars; lower-case ULID; contains `I`/`L`/`O`/`U`; first char `8`.
- `fl_is_sha256`: 32 bytes true, 31/33 false.
- `fl_current_merchant_id()`: unset → null; `set_config('app.merchant_id','',true)` → null; set → value.
- `fl_assert_unchanged` raises `IMMUTABLE_FIELD` with `{"table","column"}` detail; unchanged → no error.
- create a throwaway function as owner in a temp schema; `has_function_privilege('fl_api', ..., 'EXECUTE')` false.
- second-database idempotency: `createEmptyDatabase()` + `migrate({ upTo: '0200' })` succeeds while roles already exist.
- Command: `pnpm vitest run --project integration test/integration/db/foundation.test.ts`.

**Non-goals** — No tables. No database-level `CONNECT` changes (**[ASSUMPTION]** risk R13). No simulator roles (P06).

**Handoff checklist**
- [ ] Removing the `ALTER DEFAULT PRIVILEGES` line makes the PUBLIC-execute test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T04 — API credential scheme (pure domain)

**Task ID:** `P02-T04`
**Feature:** Merchant API credential digests
**Commit:** `feat(domain): add API credential generation, parsing, and peppered HMAC digest`
**Priority:** High
**Dependencies:** `P01-GATE`
**Estimated complexity:** S
**Contract references:** docs/05 §Authentication, authorization, and tenant scope; docs/07 §`identity.merchant_api_credentials` (digest paragraph); docs/05 §Normative acceptance criteria #8
**Files:** create: `packages/domain/src/credentials.ts`, `packages/domain/src/credentials.test.ts`; modify: `packages/domain/src/index.ts`, `packages/domain/src/ids.ts`; must not touch: `packages/domain/src/state/**`

**Objective** — Fix the exact credential format and digest so seed, CLI issuance (P02), and API authentication (P04) agree byte-for-byte.

**Implementation instructions**
1. Format (docs/05): `fl_test_<locator>_<secret>`; `locator` = 12 Crockford Base32 chars (`0-9A-HJKMNP-TV-Z`) from 60 random bits; `secret` = 32 random bytes, unpadded base64url (43 chars). Parse regex: `^fl_test_([0-9A-HJKMNP-TV-Z]{12})_([A-Za-z0-9_-]{43})$`.
2. Digest: `HMAC-SHA-256(key = pepper bytes, message = ASCII bytes of the complete credential string)` → 32 bytes. `digest_version` = pepper version. Pepper set syntax (env `API_CREDENTIAL_PEPPERS`): comma-separated `<version>:<base64url>` where version is a positive integer and decoded pepper ≥ 32 bytes; current version = highest.
3. API (all `node:crypto`):
   ```ts
   export type Peppers = ReadonlyMap<number, Buffer>;
   export function parsePeppers(spec: string): { peppers: Peppers; currentVersion: number }; // throws Error('API_CREDENTIAL_PEPPERS invalid') — never echoes values
   export interface GeneratedCredential { raw: string; keyPrefix: string; digest: Buffer; digestVersion: number }
   export function generateCredential(p: { peppers: Peppers; currentVersion: number }): GeneratedCredential;
   export function parseCredential(raw: string): { keyPrefix: string } | null;
   export function credentialDigest(raw: string, pepper: Buffer): Buffer;
   export function verifyCredential(raw: string, stored: { digest: Buffer; digestVersion: number } | null, peppers: Peppers): boolean;
   ```
   `verifyCredential`: when `stored` is null or its version is unknown, still compute one HMAC with the current pepper over `raw` and return `false` (keeps the lookup-miss path timing-similar); when stored digest length ≠ 32 return `false`; otherwise `crypto.timingSafeEqual(credentialDigest(raw, pepper), stored.digest)`.
4. Add branded ID prefixes to `packages/domain/src/ids.ts` following its existing pattern, if absent: `mcr` (`MerchantCredentialId`), `pac` (`ProviderAccountCredentialId`), `pwe` (`ProviderWebhookEndpointId`), `fee` (`FeePolicyId`), `pev` (`ProviderEvidenceId`). **[ASSUMPTION]** these docs/07 prefixes are absent from `schemas/common/entity-ids.v1.schema.json`; risk R1.

**Expected behavior** — `generateCredential` → `raw` matching the regex, `keyPrefix` = locator, `verifyCredential(raw, {digest, digestVersion}, peppers)` → `true`; one flipped character in the secret → `false`.

**Acceptance criteria**
- [ ] Golden vector: pepper version 1 = base64url of bytes `0x00..0x1f`, credential `fl_test_0123456789AB_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` → digest hex recorded in the test (computed once with `node:crypto`, checked in).
- [ ] `timingSafeEqual` used for comparison; no `===` on digests.
- [ ] No credential or pepper value appears in any thrown error message.

**Testing requirements** — `packages/domain/src/credentials.test.ts`: format regex over 1,000 generated credentials; locator alphabet excludes `I L O U`; parse rejects wrong prefix, 11/13-char locator, 42/44-char secret, lowercase locator; golden vector; wrong pepper version → false; unknown version → false; null stored → false; digest length 31 → false; rotation: credentials made with v1 verify after `parsePeppers('1:...,2:...')` and new ones use v2; `parsePeppers` rejects version 0, duplicate versions, short pepper, and error text contains no pepper. Command: `pnpm vitest run --project unit packages/domain/src/credentials.test.ts`.

**Non-goals** — No database access, no HTTP header parsing (P04).

**Handoff checklist**
- [ ] Golden vector checked in.
- [ ] `pnpm check` green.

---

### P02-T05 — Migration 0210: identity tables and credential repository

**Task ID:** `P02-T05`
**Feature:** Merchant identities and API credentials
**Commit:** `feat(db): add identity merchants and API credentials with scopes, expiry, and revocation`
**Priority:** Critical
**Dependencies:** `P02-T02`, `P02-T03`, `P02-T04`
**Estimated complexity:** M
**Contract references:** docs/07 §Identity and authentication, §Tenant isolation, §Mutability rules (Merchants and API credentials); docs/05 §Authentication; docs/10 M2 bullet 2
**Files:** create: `migrations/0210_identity.sql`, `packages/database/src/repositories/identity.ts`, `test/integration/db/identity.test.ts`; modify: `packages/database/src/index.ts`; must not touch: `migrations/0200_foundation.sql`

**Objective** — Merchants and credential rows whose digest, ownership, and creation time are immutable, whose scopes are allowlisted, which can be looked up by key prefix before tenant context exists, and which operators can issue and revoke (rotation = issue new + revoke old).

**Implementation instructions** (order: tables → constraints/indexes → triggers → RLS → grants)
1. `identity.merchants`: columns exactly per docs/07. Named constraints: `merchants_pkey`, `merchants_id_format CHECK (public.fl_is_id(id,'mer'))`, `merchants_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 200)`, `merchants_status CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED'))`, `merchants_default_currency CHECK (default_currency = 'USD')`, `merchants_closed_at CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))`. Defaults `created_at`/`updated_at` = `clock_timestamp()`.
2. `identity.merchant_api_credentials`: columns per docs/07. Named: `merchant_api_credentials_pkey`, `merchant_api_credentials_id_format` (`mcr`), `merchant_api_credentials_key_prefix_key UNIQUE (key_prefix)`, `merchant_api_credentials_key_prefix_format CHECK (key_prefix ~ '^[0-9A-HJKMNP-TV-Z]{12}$')`, `merchant_api_credentials_merchant_id_id_key UNIQUE (merchant_id, id)`, `merchant_api_credentials_merchant_fkey FOREIGN KEY (merchant_id) REFERENCES identity.merchants(id)` (no cascade), `merchant_api_credentials_digest_length CHECK (public.fl_is_sha256(credential_digest))`, `merchant_api_credentials_digest_version CHECK (digest_version > 0)`, `merchant_api_credentials_scopes_nonempty CHECK (cardinality(scopes) > 0)`, `merchant_api_credentials_scopes_allowlisted CHECK (scopes <@ ARRAY['payments:read','payments:write']::text[])`, `merchant_api_credentials_status CHECK (status IN ('ACTIVE','REVOKED'))`, `merchant_api_credentials_revoked_at CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))`. `merchant_id` is the leading column of `merchant_api_credentials_merchant_id_id_key` (FK supported). **[ASSUMPTION]** a CHECK replaces docs/07's "trigger rejects unknown scopes" (same rule, native mechanism); risk R4.
3. Triggers:
   - `merchants_guard BEFORE UPDATE` → `fl_assert_unchanged(..., ARRAY['id','default_currency','created_at','display_name'])` then `fl_touch_updated_at` semantics (set `updated_at`). `merchants_no_delete BEFORE DELETE` and `merchants_no_truncate BEFORE TRUNCATE` → `fl_reject_mutation()`.
   - `merchant_api_credentials_guard BEFORE INSERT OR UPDATE`: on INSERT require `status='ACTIVE'` and `revoked_at IS NULL` (else `INVALID_TRANSITION {"reason":"CREDENTIAL_NOT_ISSUED_ACTIVE"}`); on UPDATE `fl_assert_unchanged` over every column except `status`, `revoked_at`, `last_used_at`, and require `OLD.status='REVOKED' ⇒ NEW.status='REVOKED' AND NEW.revoked_at = OLD.revoked_at` (`INVALID_TRANSITION {"reason":"CREDENTIAL_REVOCATION_ONE_WAY"}`). No-delete/no-truncate triggers.
4. RLS — `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on both tables:
   - `merchants_tenant_read FOR SELECT TO fl_api USING (id = public.fl_current_merchant_id())`.
   - `merchants_function_owner_all FOR ALL TO payments_function_owner, messaging_function_owner USING (true) WITH CHECK (true)`.
   - `merchant_api_credentials_lookup FOR SELECT TO fl_api USING (merchant_id = public.fl_current_merchant_id() OR key_prefix = nullif(current_setting('app.credential_key_prefix', true), ''))`. **[ASSUMPTION]** pre-tenant lookup uses a transaction-local GUC instead of a `SECURITY DEFINER` function because CONVENTIONS §7 has no identity function-owner role; risk R3.
   - `merchant_api_credentials_operator_all FOR ALL TO fl_operator_command USING (true) WITH CHECK (true)`; `merchant_api_credentials_function_owner_read FOR SELECT TO payments_function_owner USING (true)`.
5. Grants (last): `GRANT USAGE ON SCHEMA identity TO fl_api, fl_operator_command, payments_function_owner, messaging_function_owner`; `GRANT SELECT ON identity.merchants TO fl_api, payments_function_owner, messaging_function_owner`; `GRANT SELECT ON identity.merchant_api_credentials TO fl_api, payments_function_owner`; `GRANT SELECT, INSERT (id, merchant_id, key_prefix, credential_digest, digest_version, scopes, expires_at), UPDATE (status, revoked_at) ON identity.merchant_api_credentials TO fl_operator_command`. No `DELETE`/`TRUNCATE` to anyone.
6. `packages/database/src/repositories/identity.ts` (callers pass a client inside `withTransaction`):
   ```ts
   export interface CredentialRow { id: string; merchantId: string; keyPrefix: string; credentialDigest: Buffer; digestVersion: number; scopes: string[]; status: 'ACTIVE'|'REVOKED'; expiresAt: Date | null; merchantStatus: 'ACTIVE'|'SUSPENDED'|'CLOSED' }
   // set_config('app.credential_key_prefix',$1,true); SELECT credential WHERE key_prefix=$1 AND status='ACTIVE'
   //   AND (expires_at IS NULL OR expires_at > clock_timestamp()); if found set_config('app.merchant_id', merchant_id, true) and read merchants.status.
   export async function lookupCredential(c: pg.ClientBase, keyPrefix: string): Promise<CredentialRow | null>;
   export async function issueCredential(c: pg.ClientBase, i: { id: string; merchantId: string; keyPrefix: string; digest: Buffer; digestVersion: number; scopes: readonly string[]; expiresAt: Date | null }): Promise<void>;
   export async function revokeCredential(c: pg.ClientBase, id: string): Promise<boolean>; // UPDATE ... SET status='REVOKED', revoked_at=clock_timestamp() WHERE id=$1 AND status='ACTIVE'
   ```

**Expected behavior** — As `fl_api` with no context: `SELECT * FROM identity.merchant_api_credentials` → 0 rows; after `set_config('app.credential_key_prefix','0123456789AB',true)` → exactly that row; with `app.merchant_id` = A → A's credentials only.

**Acceptance criteria**
- [ ] Every named constraint has a passing negative test (`assertConstraintCoverage`).
- [ ] `credential_digest`, `merchant_id`, `created_at`, `key_prefix`, `scopes`, `digest_version`, `expires_at` cannot change after insert (owner role included).
- [ ] Revocation is one-way and requires `revoked_at`; an expired or revoked credential is not returned by `lookupCredential`.
- [ ] `fl_api` cannot insert/update/delete credentials or merchants; `fl_operator_command` can insert and revoke but cannot change digests or delete.
- [ ] Missing `app.merchant_id` and missing prefix → `fl_api` sees no merchant or credential rows.

**Testing requirements** — `test/integration/db/identity.test.ts`:
- constraint negatives (owner inserts): bad `mer_`/`mcr_` IDs, display name '' and 201 chars, status `DELETED`, currency `EUR`, `CLOSED` without `closed_at`, `ACTIVE` with `closed_at`, key prefix 11 chars and lowercase, duplicate key prefix (`merchant_api_credentials_key_prefix_key`), unknown merchant FK, 31-byte digest, version 0, empty scopes, scope `payments:admin`, `REVOKED` without `revoked_at`; each asserts `err.constraint` equals the name.
- triggers: insert `REVOKED` → `INVALID_TRANSITION`; update digest → `IMMUTABLE_FIELD` column `credential_digest`; REVOKED→ACTIVE → `INVALID_TRANSITION`; delete → `IMMUTABLE_ROW`; truncate → `IMMUTABLE_ROW`; merchant `display_name` update → `IMMUTABLE_FIELD`.
- repository: issue via `poolAs('fl_operator_command')`; `lookupCredential` via `poolAs('fl_api')` returns row with `merchantStatus`; past `expires_at` (owner insert with `expires_at = now() - '1 second'`) → null; revoked → null; rotation: two active credentials for one merchant both found by their own prefixes, revoking the old leaves the new.
- RLS: `fl_api` no context → 0 rows on both tables; prefix GUC reveals only that row; merchant A context never reveals merchant B rows; `fl_api` `INSERT`/`UPDATE`/`DELETE` → SQLSTATE `42501`; `fl_operator_command` `UPDATE ... SET credential_digest` → `42501` (column privilege).
- Command: `pnpm vitest run --project integration test/integration/db/identity.test.ts`.

**Non-goals** — No HTTP auth guard, scope enforcement, or `last_used_at` writes (P04). No merchant-creation API.

**Handoff checklist**
- [ ] Each RLS test fails when its policy is replaced by `USING (true)`.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T06 — Migration 0220: provider configuration and deterministic route selection

**Task ID:** `P02-T06`
**Feature:** Provider accounts, versions, credentials, webhook endpoints, routes
**Commit:** `feat(db): add provider configuration tables and deterministic route selection`
**Priority:** Critical
**Dependencies:** `P02-T05`
**Estimated complexity:** L
**Contract references:** docs/07 §Provider configuration (all six tables), §Mutability rules, §Tenant isolation item 9; docs/05 §Create a payment (routing bullets, `PROVIDER_ROUTE_UNAVAILABLE`); docs/10 M2 bullets 3–4
**Files:** create: `migrations/0220_provider_configuration.sql`, `test/integration/db/providers.test.ts`; must not touch: earlier migrations

**Objective** — Tenant-owned provider accounts with immutable identity, immutable configuration versions, credential and webhook-secret version history, endpoint-account allowlists, and routes that select exactly one account and one current version or fail with `PROVIDER_ROUTE_UNAVAILABLE`.

**Implementation instructions** (order: tables → constraints/indexes → triggers → function → RLS → grants)
1. `providers.provider_accounts` per docs/07. Named: `provider_accounts_pkey`, `provider_accounts_id_format` (`pacc`), `provider_accounts_merchant_id_id_key UNIQUE (merchant_id, id)`, `provider_accounts_route_target_key UNIQUE (merchant_id, id, provider_code, environment)`, `provider_accounts_external_identity_key UNIQUE NULLS NOT DISTINCT (merchant_id, provider_code, external_account_reference, environment)`, `provider_accounts_merchant_fkey`, `provider_accounts_provider_code_format CHECK (provider_code ~ '^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$')`, `provider_accounts_environment CHECK (environment IN ('SANDBOX','SIMULATOR'))`, `provider_accounts_status CHECK (status IN ('ACTIVE','DISABLED','REVOKED'))`; index `provider_accounts_lookup (merchant_id, provider_code, status)`. Trigger: immutable `id, merchant_id, provider_code, environment, external_account_reference, created_at`; set `updated_at`; no delete/truncate.
2. `providers.merchant_routes` per docs/07. Named: `merchant_routes_pkey (merchant_id, provider_code, environment)`, `merchant_routes_account_key UNIQUE (merchant_id, provider_account_id)`, `merchant_routes_account_fkey FOREIGN KEY (merchant_id, provider_account_id, provider_code, environment) REFERENCES providers.provider_accounts (merchant_id, id, provider_code, environment)`, `merchant_routes_status CHECK (status IN ('ACTIVE','DISABLED'))`, unique index `merchant_routes_one_default ON (merchant_id, environment) WHERE status = 'ACTIVE' AND is_default`. Trigger: immutable `merchant_id, provider_code, environment, created_at`; set `updated_at`; no delete/truncate.
3. `providers.provider_account_versions` per docs/07. Named: `provider_account_versions_pkey (provider_account_id, version)`, `provider_account_versions_account_fkey → provider_accounts(id)`, `provider_account_versions_version_positive CHECK (version > 0)`, `provider_account_versions_configuration_object CHECK (jsonb_typeof(configuration) = 'object')`, `provider_account_versions_capabilities_hash CHECK (public.fl_is_sha256(capabilities_hash))`, unique index `provider_account_versions_one_current ON (provider_account_id) WHERE superseded_at IS NULL`. Trigger `BEFORE INSERT`: `NEW.version` must equal `coalesce(max(version),0)+1` for the account (`INVALID_TRANSITION {"reason":"VERSION_NOT_MONOTONIC"}`); `BEFORE UPDATE`: all columns immutable except `superseded_at` null→value once; no delete/truncate.
4. `providers.provider_account_credentials` per docs/07. Named: `provider_account_credentials_pkey`, `..._id_format` (`pac`), `..._account_version_key UNIQUE (provider_account_id, version)`, `..._account_fkey FOREIGN KEY (merchant_id, provider_account_id) REFERENCES providers.provider_accounts (merchant_id, id)`, `..._version_positive`, `..._secret_reference_nonempty CHECK (char_length(secret_reference) > 0)`, `..._status CHECK (status IN ('ACTIVE','RETIRED','REVOKED'))`, `..._retired_at CHECK ((status = 'ACTIVE') = (retired_at IS NULL))`, unique index `provider_account_credentials_one_active ON (provider_account_id) WHERE status = 'ACTIVE'`. Insert trigger enforces monotonic version per account; update trigger: only `status`/`retired_at` change, transitions `ACTIVE→RETIRED`, `ACTIVE→REVOKED`, `RETIRED→REVOKED`; no delete/truncate.
5. `providers.webhook_endpoints` per docs/07. Named: `webhook_endpoints_pkey`, `..._id_format` (`pwe`), `..._endpoint_key UNIQUE (provider_code, endpoint_key)`, `..._endpoint_key_format CHECK (endpoint_key ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$')`, `..._provider_code_format`, `..._status CHECK (status IN ('ACTIVE','REVOKED'))`, `..._retired_at CHECK ((status = 'REVOKED') = (retired_at IS NOT NULL))`. Update trigger: immutable `id, provider_code, endpoint_key, external_account_reference, created_at`; `REVOKED` one-way; no delete/truncate.
6. `providers.webhook_endpoint_secret_versions` per docs/07. Named: `..._pkey (webhook_endpoint_id, version)`, `..._endpoint_fkey`, `..._version_positive`, `..._status CHECK (status IN ('ACTIVE','OVERLAP','RETIRED'))`, `..._window CHECK (accepted_until IS NULL OR accepted_until > accepted_from)`, `..._bounded CHECK (status = 'ACTIVE' OR accepted_until IS NOT NULL)`, unique index `webhook_endpoint_secret_versions_one_active ON (webhook_endpoint_id) WHERE status = 'ACTIVE'`. Update trigger: only `ACTIVE→OVERLAP` or `ACTIVE→RETIRED` with `accepted_until` set from null in the same update; everything else immutable; no delete/truncate.
7. `providers.webhook_endpoint_accounts` per docs/07. Named: `..._pkey (webhook_endpoint_id, provider_account_id)`, `..._endpoint_fkey`, `..._account_fkey → provider_accounts(id)`; index `webhook_endpoint_accounts_account (provider_account_id)`. Update trigger: only `retired_at` null→value; no delete/truncate.
8. Route selection (internal, `SECURITY INVOKER`, owner `payments_function_owner` via `fl_assign_function_owner`, `SET search_path = pg_catalog, pg_temp`, no dynamic SQL):
   ```sql
   CREATE FUNCTION providers.select_route(p_merchant_id text, p_environment text, p_provider_code text)
   RETURNS TABLE (provider_account_id text, provider_code text, provider_account_version integer)
   LANGUAGE plpgsql STABLE ...
   -- 1. SELECT r.* FROM providers.merchant_routes r WHERE r.merchant_id = p_merchant_id AND r.environment = p_environment
   --      AND ((p_provider_code IS NOT NULL AND r.provider_code = p_provider_code) OR (p_provider_code IS NULL AND r.is_default AND r.status = 'ACTIVE'))
   -- 2. require route found, route ACTIVE, account ACTIVE (join provider_accounts)
   -- 3. SELECT version FROM providers.provider_account_versions WHERE provider_account_id = r.provider_account_id AND superseded_at IS NULL FOR SHARE
   -- any miss: PERFORM public.fl_raise_domain('PROVIDER_ROUTE_UNAVAILABLE', jsonb_build_object('providerCode', p_provider_code));
   ```
   `FOR SHARE` makes a concurrent supersede wait for the creating transaction, so the snapshot cannot change mid-create. `REVOKE ALL ON FUNCTION ... FROM PUBLIC; GRANT EXECUTE ... TO payments_function_owner`. Never falls back to another route or account.
9. RLS enabled on all six tables. Policies `<table>_function_owner_read FOR SELECT TO payments_function_owner USING (true)` on all six. No `fl_api` access in this phase.
10. Grants (last): `GRANT USAGE ON SCHEMA providers TO payments_function_owner`; `GRANT SELECT ON` all six tables `TO payments_function_owner`. No runtime-role grants (P04 adds what the API needs; P06/P09 add worker/receiver grants).

**Expected behavior** — Merchant with active default `fake-provider` route (SIMULATOR) and current version 2: `select_route(m, 'SIMULATOR', NULL)` → `(pacc_..., 'fake-provider', 2)`; `select_route(m, 'SIMULATOR', 'unreliable-provider')` with that route `DISABLED` → `P0001 PROVIDER_ROUTE_UNAVAILABLE`.

**Acceptance criteria**
- [ ] Every named constraint/unique index has a negative test (`assertConstraintCoverage` on all six tables).
- [ ] A route cannot reference another merchant's account or an account with a different provider code/environment.
- [ ] At most one active default route per merchant/environment; at most one current version per account; at most one active credential and one active webhook secret.
- [ ] `select_route` returns exactly one `(account, version)` or raises `PROVIDER_ROUTE_UNAVAILABLE` for: missing explicit route, missing default, disabled route, disabled/revoked account, no current version.
- [ ] No runtime role can read or write any provider table.

**Testing requirements** — `test/integration/db/providers.test.ts` (owner fixtures; `withRole(..., 'payments_function_owner')` for `select_route`):
- constraint negatives for every name listed above, including cross-merchant route (`merchant_routes_account_fkey`), provider-code mismatch, second default (`merchant_routes_one_default`), second current version, second active credential, second active secret, bad endpoint key, `REVOKED` endpoint without `retired_at`.
- trigger negatives: change account `provider_code`/`environment`/`external_account_reference` → `IMMUTABLE_FIELD`; change version `configuration` → `IMMUTABLE_FIELD`; clear `superseded_at` → `IMMUTABLE_FIELD`; insert version 3 when max is 1 → `INVALID_TRANSITION`; credential `REVOKED→ACTIVE` → `INVALID_TRANSITION`; secret `OVERLAP→ACTIVE` → `INVALID_TRANSITION`; delete any row → `IMMUTABLE_ROW`.
- `select_route`: explicit, default, missing default, disabled route, disabled account, superseded-only versions, two merchants with identical provider codes return their own accounts.
- rollover race: txn A calls `select_route` (holds `FOR SHARE`); txn B supersedes v1 and inserts v2 → B blocks until A commits (assert via `pg_stat_activity.wait_event_type = 'Lock'`), then succeeds; A returned v1.
- privileges: every `LOGIN_RUNTIME_ROLES` member `SELECT` on each table → `42501`; `fl_api` `EXECUTE providers.select_route` → `42501`.
- Command: `pnpm vitest run --project integration test/integration/db/providers.test.ts`.

**Non-goals** — No provider attempts/notifications/evidence (P06), no webhook receiver grants (P09), no adapter configuration schema validation (P06).

**Handoff checklist**
- [ ] Removing `FOR SHARE` makes the rollover test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T07 — Migration 0230: append-only fee policies and merchant test fixture

**Task ID:** `P02-T07`
**Feature:** Versioned fee policy
**Commit:** `feat(db): add immutable fee-policy versions and per-test merchant fixture`
**Priority:** Critical
**Dependencies:** `P02-T06`
**Estimated complexity:** M
**Contract references:** docs/07 §Versioned fee policy; docs/02 §Capture-fee calculation, §Minimum capture amount; ADR-0008; docs/10 M2 bullet 5
**Files:** create: `migrations/0230_fee_policies.sql`, `packages/testkit/src/fixtures/merchant.ts`, `test/integration/db/fee-policies.test.ts`; modify: `packages/testkit/src/index.ts`; must not touch: earlier migrations

**Objective** — Immutable fee-policy versions whose declared minimum capture structurally guarantees `fee <= gross`, plus the fixture every later DB test uses to get an isolated merchant.

**Implementation instructions**
1. `payments.fee_policies` per docs/07. Named: `fee_policies_pkey`, `fee_policies_id_format` (`fee`), `fee_policies_merchant_version_key UNIQUE (merchant_id, version)`, `fee_policies_merchant_id_version_key UNIQUE (merchant_id, id, version)`, `fee_policies_merchant_fkey`, `fee_policies_version_positive CHECK (version > 0)`, `fee_policies_currency CHECK (currency = 'USD')`, `fee_policies_basis_points CHECK (basis_points BETWEEN 0 AND 10000)`, `fee_policies_fixed_amount CHECK (fixed_amount_minor BETWEEN 0 AND 1000000000000)`, `fee_policies_minimum_capture CHECK (minimum_capture_amount_minor >= GREATEST(fixed_amount_minor, 1))`, `fee_policies_minimum_capture_max CHECK (minimum_capture_amount_minor <= 1000000000000)`, `fee_policies_fee_within_minimum CHECK ((minimum_capture_amount_minor * basis_points + 5000) / 10000 + fixed_amount_minor <= minimum_capture_amount_minor)` (**[DECISION D-07, README §10.3]** — without it `fee > gross` is reachable, e.g. bp 5000, fixed 30, minimum 30, gross 40 → fee 50; integer division on non-negative `bigint` is floor; max intermediate 1e16 fits `bigint`; mirrors P01 `checkFeePolicy`), `fee_policies_capture_rounding_mode CHECK (capture_rounding_mode = 'HALF_UP')`, `fee_policies_refund_fee_mode CHECK (refund_fee_mode = 'PROPORTIONAL')`, unique index `fee_policies_one_current ON (merchant_id, currency) WHERE superseded_at IS NULL`.
2. Triggers: `BEFORE INSERT` monotonic version per merchant (`coalesce(max,0)+1`, else `INVALID_TRANSITION {"reason":"VERSION_NOT_MONOTONIC"}`); `BEFORE UPDATE` every column immutable except `superseded_at` null→value once; no delete/truncate.
3. RLS enabled; `fee_policies_function_owner_read FOR SELECT TO payments_function_owner USING (true)`. Grants (last): `GRANT USAGE ON SCHEMA payments TO payments_function_owner; GRANT SELECT ON payments.fee_policies TO payments_function_owner`. No runtime grants. Appending a new version = owner/fixture `UPDATE ... SET superseded_at` + `INSERT` in one transaction; no runtime function is required by M2–M13.
4. `packages/testkit/src/fixtures/merchant.ts` (direct owner inserts — a clearly named fixture helper allowed by docs/10 §Financial safety):
   ```ts
   export interface TestMerchant {
     merchantId: string; credentialId: string; rawCredential: string; keyPrefix: string;
     providerAccountId: string; providerCode: 'fake-provider'; environment: 'SIMULATOR'; providerAccountVersion: 1;
     feePolicyId: string; feePolicyVersion: 1;
   }
   export async function createTestMerchant(ownerPool: pg.Pool, o?: { basisPoints?: number; fixedAmountMinor?: bigint; minimumCaptureAmountMinor?: bigint; scopes?: string[] }): Promise<TestMerchant>;
   export const TEST_PEPPERS: string; // '1:<base64url of 32 synthetic bytes>' parsed with parsePeppers
   ```
   Inserts: merchant (`ACTIVE`, USD); credential via `generateCredential` (scopes default `['payments:read','payments:write']`); provider account `fake-provider`/`SIMULATOR`/`ACTIVE`; version 1 (`configuration '{}'`, `capabilities_hash = sha256('fake-provider')`); active credential version 1 (`secret_reference 'local-secret://test'`); active default route; fee policy v1 (defaults 290 bp, fixed 30, minimum 30). All IDs from `newId`.

**Expected behavior** — Inserting `(basis_points 290, fixed 30, minimum 29)` → `23514 fee_policies_minimum_capture`; `(fixed 30, minimum 30)` → accepted (boundary `fee == gross` remains valid).

**Acceptance criteria**
- [ ] A policy whose fixed component exceeds its declared minimum cannot be inserted; minimum 0 rejected; minimum equal to fixed accepted.
- [ ] Only `superseded_at` may change, once; at most one current policy per merchant/currency.
- [ ] `createTestMerchant` called twice yields disjoint IDs and both commit.

**Testing requirements** — `test/integration/db/fee-policies.test.ts`: every named constraint negative (bp −1, 10001; fixed −1, 1000000000001; minimum below fixed, minimum 0, minimum 1000000000001; rounding `HALF_EVEN`; refund mode `FLAT`; EUR; duplicate version; second current policy); trigger negatives (change `basis_points` → `IMMUTABLE_FIELD`; clear `superseded_at` → `IMMUTABLE_FIELD`; version gap → `INVALID_TRANSITION`; delete → `IMMUTABLE_ROW`); append v2 after superseding v1 succeeds; every runtime role `SELECT`/`INSERT` → `42501`; `createTestMerchant` twice → disjoint IDs, `assertConstraintCoverage(ownerPool, 'payments.fee_policies', [...])`. Command: `pnpm vitest run --project integration test/integration/db/fee-policies.test.ts`.

**Non-goals** — No fee calculation in SQL (capture snapshot recomputation belongs to `payments.accept_operation`, P05). No fee-policy admin command.

**Handoff checklist**
- [ ] Relaxing `fee_policies_minimum_capture` to `>= 1` makes the boundary test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T08 — Migration 0240: payment aggregate table

**Task ID:** `P02-T08`
**Feature:** Payment aggregate
**Commit:** `feat(db): add payments table with monetary checks and immutable bindings`
**Priority:** Critical
**Dependencies:** `P02-T07`
**Estimated complexity:** M
**Contract references:** docs/07 §`payments.payments` (all), §Protected payment transition functions (first paragraph), §Mutability rules; docs/03 §Canonical aggregate, §Monetary invariants, §Operation exclusion model; ADR-0003, ADR-0007
**Files:** create: `migrations/0240_payments.sql`, `packages/testkit/src/fixtures/payments.ts`, `test/integration/db/payments.test.ts`; modify: `packages/testkit/src/index.ts`; must not touch: earlier migrations

**Objective** — The payment row with every monetary and state check from docs/07, tenant-safe composite FKs to provider account, version, fee policy, and credential, immutable bindings, append-once provider references, and no runtime DML. The active-exclusive FK is added in P02-T09 (after operations exist; docs/07 step 7).

**Implementation instructions**
1. Columns exactly per docs/07 (`version bigint NOT NULL DEFAULT 1`, totals `DEFAULT 0`, `authorization_outcome DEFAULT 'NOT_REQUESTED'`, timestamps `DEFAULT clock_timestamp()`).
2. Named constraints:
   - keys: `payments_pkey`, `payments_merchant_id_id_key UNIQUE (merchant_id, id)`, `payments_binding_key UNIQUE (merchant_id, id, provider_account_id, provider_account_version)`; unique index `payments_merchant_reference_key ON (merchant_id, merchant_reference) WHERE merchant_reference IS NOT NULL`.
   - FKs: `payments_provider_account_fkey (merchant_id, provider_account_id) → providers.provider_accounts (merchant_id, id)`, `payments_provider_account_version_fkey (provider_account_id, provider_account_version) → providers.provider_account_versions`, `payments_fee_policy_fkey (merchant_id, fee_policy_id, fee_policy_version) → payments.fee_policies (merchant_id, id, version)`, `payments_created_by_credential_fkey (merchant_id, created_by_credential_id) → identity.merchant_api_credentials (merchant_id, id)`.
   - checks: `payments_id_format` (`pay`); `payments_currency CHECK (currency = 'USD')`; `payments_merchant_reference_length CHECK (merchant_reference IS NULL OR char_length(merchant_reference) BETWEEN 1 AND 200)`; `payments_payment_method_ciphertext CHECK (octet_length(payment_method_reference_ciphertext) > 0)`; `payments_payment_method_key_version CHECK (char_length(payment_method_key_version) > 0)`; `payments_payment_method_hash CHECK (public.fl_is_sha256(payment_method_reference_hash))`; `payments_provider_refs_nonempty CHECK (coalesce(char_length(provider_payment_id),1) > 0 AND coalesce(char_length(provider_authorization_id),1) > 0 AND coalesce(char_length(provider_capture_id),1) > 0)`; `payments_requested_amount CHECK (requested_amount_minor BETWEEN 1 AND 1000000000000)`; `payments_totals_nonnegative CHECK (authorized_amount_minor >= 0 AND captured_amount_minor >= 0 AND refunded_amount_minor >= 0 AND voided_amount_minor >= 0 AND reserved_refund_amount_minor >= 0 AND unresolved_refund_count >= 0)`; `payments_authorized_le_requested`; `payments_captured_le_authorized`; `payments_refunded_le_captured`; `payments_voided_le_uncaptured CHECK (voided_amount_minor <= authorized_amount_minor - captured_amount_minor)`; `payments_refund_reservation_bound CHECK (refunded_amount_minor + reserved_refund_amount_minor <= captured_amount_minor)`; `payments_reservation_count CHECK ((reserved_refund_amount_minor = 0) = (unresolved_refund_count = 0))`; `payments_exclusive_excludes_refunds CHECK (active_exclusive_operation_id IS NULL OR unresolved_refund_count = 0)` (docs/03 exclusion rules 2–3: an exclusive and a refund are never both unresolved); `payments_active_operation_format CHECK (active_exclusive_operation_id IS NULL OR public.fl_is_id(active_exclusive_operation_id,'op'))`; `payments_authorization_outcome CHECK (authorization_outcome IN ('NOT_REQUESTED','AUTHORIZED','DECLINED','CANCELED','EXPIRED'))`; `payments_unauthorized_zero CHECK (authorization_outcome NOT IN ('NOT_REQUESTED','DECLINED') OR (authorized_amount_minor = 0 AND captured_amount_minor = 0 AND refunded_amount_minor = 0 AND voided_amount_minor = 0))`; `payments_released_authorization CHECK (authorization_outcome NOT IN ('CANCELED','EXPIRED') OR (captured_amount_minor = 0 AND refunded_amount_minor = 0 AND voided_amount_minor = authorized_amount_minor))`; `payments_capture_releases_remainder CHECK (captured_amount_minor = 0 OR captured_amount_minor + voided_amount_minor = authorized_amount_minor)`; `payments_version_positive CHECK (version >= 1)`.
   - indexes (docs/07 + FK support): `payments_merchant_history (merchant_id, created_at DESC, id)`, `payments_operator_outcome (merchant_id, authorization_outcome, updated_at DESC)`, `payments_active_exclusive (active_exclusive_operation_id) WHERE active_exclusive_operation_id IS NOT NULL`, `payments_unresolved_refunds (merchant_id, updated_at DESC, id) WHERE unresolved_refund_count > 0`, `payments_provider_version (provider_account_id, provider_account_version)`, `payments_fee_policy (fee_policy_id)`, `payments_created_by_credential (created_by_credential_id) WHERE created_by_credential_id IS NOT NULL`.
3. Trigger `payments_guard BEFORE UPDATE` (`payments.guard_payment_update()`): `fl_assert_unchanged` over `id, merchant_id, merchant_reference, currency, payment_method_reference_ciphertext, payment_method_key_version, payment_method_reference_hash, provider_account_id, provider_account_version, fee_policy_id, fee_policy_version, requested_amount_minor, created_by_credential_id, created_at`; for each of `provider_payment_id`, `provider_authorization_id`, `provider_capture_id`: `OLD IS NOT NULL AND NEW IS DISTINCT FROM OLD` → `IMMUTABLE_FIELD` (append-once); `NEW.version <> OLD.version + 1` → `INVALID_TRANSITION {"reason":"VERSION_NOT_INCREMENTED"}`. `payments_no_delete`, `payments_no_truncate` → `fl_reject_mutation()`.
4. RLS enabled. `payments_tenant_read FOR SELECT TO fl_api USING (merchant_id = public.fl_current_merchant_id())`; `payments_function_owner_all FOR ALL TO payments_function_owner USING (true) WITH CHECK (true)`; `payments_messaging_owner_read FOR SELECT TO messaging_function_owner USING (true)`.
5. Grants (last): `GRANT USAGE ON SCHEMA payments TO fl_api, messaging_function_owner`; `GRANT SELECT (<every column except payment_method_reference_ciphertext>) ON payments.payments TO fl_api`; `GRANT SELECT, INSERT, UPDATE ON payments.payments TO payments_function_owner`; `GRANT SELECT ON payments.payments TO messaging_function_owner`. No `DELETE`/`TRUNCATE` to anyone; no DML to any runtime role.
6. `packages/testkit/src/fixtures/payments.ts` (owner role; names start with `fixture`):
   ```ts
   export async function fixtureInsertPayment(c: pg.ClientBase, m: TestMerchant, o?: Partial<{ id: string; requestedAmountMinor: bigint }>): Promise<string>;
   export async function fixtureUpdatePayment(c: pg.ClientBase, paymentId: string, set: Record<string, unknown>): Promise<void>; // also sets version = version + 1
   ```
   `fixtureInsertPayment` uses `ciphertext = '\x01'`, `key_version 'test-k1'`, `hash = sha256(id)`.

**Expected behavior** — Owner `UPDATE payments.payments SET provider_account_version = 2, version = version + 1` → `P0001 IMMUTABLE_FIELD {"column":"provider_account_version"}`; `fl_api` `UPDATE ... SET captured_amount_minor = 1` → `42501`.

**Acceptance criteria**
- [ ] Every named constraint has a negative test (`assertConstraintCoverage(ownerPool, 'payments.payments', ...)`).
- [ ] Provider account, provider version, payment-method ciphertext, currency, requested amount, and fee policy cannot change after creation (docs/10 M2 test 5), including for the table owner.
- [ ] Provider references are append-once; version must increase by exactly 1 per update.
- [ ] A payment cannot reference another merchant's provider account, fee policy, or credential.
- [ ] No runtime role can insert/update/delete/truncate; `fl_api` cannot read `payment_method_reference_ciphertext`.

**Testing requirements** — `test/integration/db/payments.test.ts`:
- negatives for every check, including boundary pairs: requested 0/1/1000000000000/1000000000001; `refunded + reserved = captured` accepted vs `+1` rejected (`payments_refund_reservation_bound`); reserved 0 with count 1 (`payments_reservation_count`); pointer set with count 1 (`payments_exclusive_excludes_refunds`); `CANCELED` with voided ≠ authorized; capture without remainder release. Each case asserts the immediate CHECK error raised by the `INSERT`/`UPDATE` statement itself (inside a transaction that is then rolled back), so the outcome does not depend on the deferred trigger added in P02-T10.
- cross-merchant FKs: merchant A payment with merchant B's account, fee policy, credential → each FK name.
- immutability: each immutable column → `IMMUTABLE_FIELD` with that column; `provider_payment_id` null→'x' ok (with version+1), 'x'→'y' rejected; version unchanged → `INVALID_TRANSITION`; delete/truncate → `IMMUTABLE_ROW`.
- privileges: for every `LOGIN_RUNTIME_ROLES` member: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` → `42501`; `fl_api` `SELECT payment_method_reference_ciphertext` → `42501`; `fl_api` `SELECT id` without context → 0 rows, with context A → only A's.
- Command: `pnpm vitest run --project integration test/integration/db/payments.test.ts`.

**Non-goals** — No `payments.create_payment` (P04), no operations table, no deferred trigger.

**Handoff checklist**
- [ ] Removing a column from the immutability list makes its test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T09 — Migration 0250: payment operations, exclusion indexes, active-exclusive FK

**Task ID:** `P02-T09`
**Feature:** Payment operations
**Commit:** `feat(db): add payment operations with exclusive-operation index and transition guard`
**Priority:** Critical
**Dependencies:** `P02-T08`
**Estimated complexity:** L
**Contract references:** docs/07 §`payments.payment_operations` (all), §Migration order steps 6–7, §Exact idempotency and uniqueness boundaries; docs/03 §Payment operation, §Operation exclusion model, §Aggregate and operation version rules; ADR-0003, ADR-0008
**Files:** create: `migrations/0250_payment_operations.sql`, `test/integration/db/payment-operations.test.ts`; modify: `packages/testkit/src/fixtures/payments.ts`; must not touch: earlier migrations

**Objective** — Operation rows that inherit the payment's immutable provider binding by composite FK, enforce one unresolved exclusive operation by partial unique index (refunds deliberately absent), forbid a refund fee effect before confirmation, freeze terminal rows, and link `payments.active_exclusive_operation_id` by deferrable composite FK.

**Implementation instructions**
1. Columns exactly per docs/07 (`version bigint NOT NULL DEFAULT 1`; timestamps default `clock_timestamp()`).
2. Named constraints:
   - keys: `payment_operations_pkey`, `payment_operations_merchant_id_id_key UNIQUE (merchant_id, id)`, `payment_operations_payment_scope_key UNIQUE (merchant_id, payment_id, id)`, `payment_operations_attempt_binding_key UNIQUE (merchant_id, id, provider_account_id, provider_idempotency_key)`, `payment_operations_provider_key UNIQUE (provider_account_id, provider_idempotency_key)`.
   - FKs: `payment_operations_payment_binding_fkey (merchant_id, payment_id, provider_account_id, provider_account_version) → payments.payments (merchant_id, id, provider_account_id, provider_account_version)`; `payment_operations_fee_policy_fkey (merchant_id, fee_policy_id, fee_policy_version) → payments.fee_policies (merchant_id, id, version)`; `payment_operations_capture_fkey (merchant_id, payment_id, capture_operation_id) → payments.payment_operations (merchant_id, payment_id, id)`.
   - checks: `payment_operations_id_format` (`op`); `payment_operations_type CHECK (type IN ('AUTHORIZE','CAPTURE','CANCEL','REFUND'))`; `payment_operations_amount CHECK (amount_minor BETWEEN 1 AND 1000000000000)`; `payment_operations_currency`; `payment_operations_status CHECK (status IN ('REQUESTED','PROCESSING','SUCCEEDED','REJECTED','FAILED','UNKNOWN','REQUIRES_REVIEW'))`; `payment_operations_provider_key_nonempty CHECK (char_length(provider_idempotency_key) BETWEEN 1 AND 255)`; `payment_operations_resolved_at CHECK ((status IN ('SUCCEEDED','REJECTED','FAILED')) = (resolved_at IS NOT NULL))`; `payment_operations_resolution CHECK ((status IN ('SUCCEEDED','REJECTED','FAILED')) = (resolution_evidence_id IS NOT NULL) AND (resolution_evidence_id IS NULL) = (resolution_source IS NULL))`; `payment_operations_resolution_source CHECK (resolution_source IS NULL OR resolution_source IN ('API_RESPONSE','PROVIDER_WEBHOOK','RECONCILIATION'))`; `payment_operations_resolution_evidence_format CHECK (resolution_evidence_id IS NULL OR public.fl_is_id(resolution_evidence_id,'pev'))`; `payment_operations_success_reference CHECK (status <> 'SUCCEEDED' OR (provider_operation_id IS NOT NULL AND result_code IS NULL))`; `payment_operations_result_code CHECK ((status IN ('REJECTED','FAILED')) = (result_code IS NOT NULL) AND (result_code IS NULL OR result_code ~ '^[A-Z][A-Z0-9_]{0,63}$'))`; `payment_operations_refund_capture_link CHECK ((type = 'REFUND') = (capture_operation_id IS NOT NULL))`; `payment_operations_fee_snapshot CHECK (CASE WHEN type IN ('CAPTURE','REFUND') THEN fee_policy_id IS NOT NULL AND fee_policy_version IS NOT NULL AND fee_basis_points IS NOT NULL AND fee_fixed_amount_minor IS NOT NULL AND fee_capture_rounding_mode IS NOT NULL AND fee_refund_mode IS NOT NULL ELSE fee_policy_id IS NULL AND fee_policy_version IS NULL AND fee_basis_points IS NULL AND fee_fixed_amount_minor IS NULL AND fee_capture_rounding_mode IS NULL AND fee_refund_mode IS NULL END)`; `payment_operations_fee_snapshot_values CHECK ((fee_basis_points IS NULL OR fee_basis_points BETWEEN 0 AND 10000) AND (fee_fixed_amount_minor IS NULL OR fee_fixed_amount_minor BETWEEN 0 AND 1000000000000) AND (fee_capture_rounding_mode IS NULL OR fee_capture_rounding_mode = 'HALF_UP') AND (fee_refund_mode IS NULL OR fee_refund_mode = 'PROPORTIONAL'))`; `payment_operations_fee_effect CHECK (CASE type WHEN 'CAPTURE' THEN fee_effect_type = 'CHARGE' AND fee_effect_amount_minor IS NOT NULL AND fee_effect_amount_minor BETWEEN 0 AND amount_minor WHEN 'REFUND' THEN fee_effect_type = 'REFUND' AND ((status = 'SUCCEEDED' AND fee_effect_amount_minor IS NOT NULL AND fee_effect_amount_minor >= 0) OR (status <> 'SUCCEEDED' AND fee_effect_amount_minor IS NULL)) ELSE fee_effect_type = 'NONE' AND fee_effect_amount_minor IS NULL END)`; `payment_operations_not_before CHECK (not_before IS NULL OR status = 'REQUESTED')`; `payment_operations_version_positive CHECK (version >= 1)`.
   - unique indexes copied verbatim from docs/07: `payment_operations_one_active_exclusive`, `payment_operations_one_successful_authorization`, `payment_operations_one_successful_capture`, `payment_operations_one_successful_cancel`. **No** index limits refunds.
   - operational indexes: `payment_operations_history (merchant_id, payment_id, created_at, id)`, `payment_operations_due (not_before, created_at, id) WHERE status = 'REQUESTED' AND not_before IS NOT NULL`, `payment_operations_leases (status, lease_expires_at) WHERE status IN ('PROCESSING','UNKNOWN','REQUIRES_REVIEW')`, `payment_operations_provider_operation (provider_account_id, provider_operation_id) WHERE provider_operation_id IS NOT NULL`, `payment_operations_capture (capture_operation_id) WHERE capture_operation_id IS NOT NULL`, `payment_operations_fee_policy (fee_policy_id) WHERE fee_policy_id IS NOT NULL`.
   - after the table: `ALTER TABLE payments.payments ADD CONSTRAINT payments_active_exclusive_operation_fkey FOREIGN KEY (merchant_id, id, active_exclusive_operation_id) REFERENCES payments.payment_operations (merchant_id, payment_id, id) DEFERRABLE INITIALLY IMMEDIATE`.
   - `resolution_evidence_id` gets its deferrable FK in P06 (docs/07 step 12).
3. Trigger `payment_operations_guard BEFORE UPDATE` (`payments.guard_operation_update()`):
   - if `OLD.status IN ('SUCCEEDED','REJECTED','FAILED')` → any change raises `INVALID_TRANSITION {"reason":"TERMINAL_OPERATION"}` (terminal states are one-way and frozen; later evidence is appended elsewhere).
   - `fl_assert_unchanged` over `id, merchant_id, payment_id, type, amount_minor, currency, provider_account_id, provider_account_version, provider_idempotency_key, capture_operation_id, fee_policy_id, fee_policy_version, fee_basis_points, fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode, fee_effect_type, created_at`; plus `fee_effect_amount_minor` when `type <> 'REFUND'`.
   - `provider_operation_id` append-once (non-null old cannot change).
   - `NEW.version <> OLD.version + 1` → `INVALID_TRANSITION {"reason":"VERSION_NOT_INCREMENTED"}`.
   - `payment_operations_no_delete`, `payment_operations_no_truncate`.
4. RLS enabled: `payment_operations_tenant_read FOR SELECT TO fl_api USING (merchant_id = public.fl_current_merchant_id())`; `payment_operations_function_owner_all FOR ALL TO payments_function_owner USING (true) WITH CHECK (true)`; `payment_operations_messaging_owner_read FOR SELECT TO messaging_function_owner USING (true)`.
5. Grants (last): `GRANT SELECT ON payments.payment_operations TO fl_api, messaging_function_owner`; `GRANT SELECT, INSERT, UPDATE ON payments.payment_operations TO payments_function_owner`.
6. Extend `packages/testkit/src/fixtures/payments.ts`:
   ```ts
   export async function fixtureInsertOperation(c: pg.ClientBase, m: TestMerchant, paymentId: string, o: { type: 'AUTHORIZE'|'CAPTURE'|'CANCEL'|'REFUND'; amountMinor: bigint; status?: string; captureOperationId?: string; feeEffectAmountMinor?: bigint | null; id?: string }): Promise<string>;
   // terminal statuses fill resolved_at, resolution_source 'API_RESPONSE', resolution_evidence_id newId('pev'), provider_operation_id / result_code as the checks require;
   // CAPTURE/REFUND copy m's fee policy snapshot (HALF_UP / PROPORTIONAL); provider_idempotency_key = 'flowledger:test:fake-provider:' + id
   export async function fixtureUpdateOperation(c: pg.ClientBase, operationId: string, set: Record<string, unknown>): Promise<void>; // also version + 1
   export async function fixtureCapturedPayment(c: pg.ClientBase, m: TestMerchant, amountMinor: bigint): Promise<{ paymentId: string; authorizeId: string; captureId: string }>;
   // succeeded AUTHORIZE + succeeded CAPTURE, payment AUTHORIZED with authorized = captured = amountMinor, version 5 — internally consistent per P02-T10 rules
   ```

**Expected behavior** — Inserting a second `REQUESTED` `CAPTURE` while an `AUTHORIZE` is `UNKNOWN` → `23505 payment_operations_one_active_exclusive`; inserting two `REQUESTED` refunds → both accepted by indexes (aggregate fields are checked by P02-T10's trigger).

**Acceptance criteria**
- [ ] Every named constraint and unique index has a negative test (`assertConstraintCoverage`).
- [ ] An operation cannot carry a provider account or version different from its payment (`payment_operations_payment_binding_fkey`).
- [ ] Two unresolved exclusive operations for one payment are impossible; two successful captures are impossible; multiple unresolved and multiple succeeded refunds are permitted by indexes.
- [ ] A refund cannot store `fee_effect_amount_minor` while nonterminal or after rejection/failure; it must store it on success; it cannot change afterward.
- [ ] Terminal rows reject every update; `provider_idempotency_key`, amount, type, binding, and fee snapshot never change.
- [ ] `payments.active_exclusive_operation_id` can reference only an operation of the same merchant and payment.

**Testing requirements** — `test/integration/db/payment-operations.test.ts` (owner role, `fixture*` helpers; each test runs inside `BEGIN ... ROLLBACK` or asserts errors raised before commit so the deferred trigger of P02-T10 does not change outcomes):
- constraint negatives for every name above, including: AUTHORIZE with fee snapshot; CAPTURE without snapshot; CAPTURE fee `amount+1` and `-1`; CAPTURE fee `= amount` accepted (boundary); REFUND `REQUESTED` with fee 0 (`payment_operations_fee_effect`); REFUND `SUCCEEDED` with null fee; REFUND without `capture_operation_id`; CANCEL with capture link; `SUCCEEDED` without provider operation ID; `REJECTED` without result code; lowercase result code; terminal without evidence; `not_before` on `PROCESSING`; operation bound to provider version 2 of a payment bound to version 1 (FK); capture link to an operation of another payment (FK); second unresolved exclusive for each pair (AUTHORIZE+CAPTURE, CAPTURE+CANCEL, AUTHORIZE `UNKNOWN`+CANCEL, CAPTURE `REQUIRES_REVIEW`+AUTHORIZE); second succeeded AUTHORIZE / CAPTURE / CANCEL; duplicate `(provider_account_id, provider_idempotency_key)`.
- positive: three unresolved REFUND rows on one payment pass every index; two `SUCCEEDED` refunds pass.
- trigger: update terminal row's `result_code` → `INVALID_TRANSITION`; change `amount_minor`, `provider_idempotency_key`, `fee_basis_points` on a `REQUESTED` row → `IMMUTABLE_FIELD`; `provider_operation_id` 'a'→'b' → `IMMUTABLE_FIELD`; update without version bump → `INVALID_TRANSITION`; delete/truncate → `IMMUTABLE_ROW`.
- active FK: pointer to an operation of another payment of the same merchant → `23503 payments_active_exclusive_operation_fkey`.
- privileges: each `LOGIN_RUNTIME_ROLES` member `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` → `42501`.
- Command: `pnpm vitest run --project integration test/integration/db/payment-operations.test.ts`.

**Non-goals** — No `accept_operation`, `claim_operation`, or any transition function (P05–P08). No evidence FK (P06). No deferred aggregate trigger (P02-T10).

**Handoff checklist**
- [ ] Adding `'REFUND'` to the exclusive index makes the three-unresolved-refunds test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T10 — Migration 0260: deferred payment-aggregate consistency trigger

**Task ID:** `P02-T10`
**Feature:** Exclusive pointer and refund-reservation integrity
**Commit:** `feat(db): add deferred trigger proving exclusive pointer and refund reservation against operations`
**Priority:** Critical
**Dependencies:** `P02-T09`
**Estimated complexity:** M
**Contract references:** docs/07 §`payments.payments` (deferred consistency trigger bullets), §Protected payment transition functions (final "deferrable constraint trigger" list); docs/03 §Monetary invariants (reservation sum/count), §Operation exclusion model; ADR-0003; docs/10 M2 test 6
**Files:** create: `migrations/0260_payment_consistency_trigger.sql`, `test/integration/db/payment-consistency.test.ts`; must not touch: earlier migrations

**Objective** — Make the maintained aggregate fields trustworthy: at commit, every touched payment's exclusive pointer, refund reservation sum/count, and confirmed totals agree with its operation rows, or the transaction fails.

**Implementation instructions**
1. Function `payments.assert_payment_consistency() RETURNS trigger` (plpgsql, owner `fl_migration_owner`, `SECURITY INVOKER`, `SET search_path = pg_catalog, pg_temp`). Resolve `v_payment_id` = `NEW.id` (payments) or `NEW.payment_id` (operations). Read the payment's current row and aggregate over its operations, then assert, in this order, raising `RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_aggregate_consistency', MESSAGE = 'payment_aggregate_consistency: <field>', DETAIL = jsonb_build_object('paymentId', v_payment_id)::text`:
   | `<field>` | Assertion |
   | --- | --- |
   | `active_exclusive_operation_id` | `active_exclusive_operation_id IS NOT DISTINCT FROM (SELECT id FROM payments.payment_operations WHERE payment_id = v AND type IN ('AUTHORIZE','CAPTURE','CANCEL') AND status IN ('REQUESTED','PROCESSING','UNKNOWN','REQUIRES_REVIEW'))` |
   | `reserved_refund_amount_minor` | equals `coalesce(sum(amount_minor),0)` over `type='REFUND' AND status IN ('REQUESTED','PROCESSING','UNKNOWN','REQUIRES_REVIEW')` |
   | `unresolved_refund_count` | equals `count(*)` over the same rows |
   | `captured_amount_minor` | equals `coalesce(amount_minor,0)` of the `SUCCEEDED` `CAPTURE` |
   | `refunded_amount_minor` | equals `coalesce(sum(amount_minor),0)` over `SUCCEEDED` `REFUND` |
   | `authorization_outcome` | `authorization_outcome IN ('AUTHORIZED','CANCELED','EXPIRED')` exactly when a `SUCCEEDED` `AUTHORIZE` exists; `authorized_amount_minor > 0` exactly when it exists |
   | `canceled` | `authorization_outcome = 'CANCELED'` exactly when a `SUCCEEDED` `CANCEL` exists |
   Return `NULL`.
2. Install on both tables (docs/07 "installed on both payment and payment-operation insert/update"):
   ```sql
   CREATE CONSTRAINT TRIGGER payments_aggregate_consistency AFTER INSERT OR UPDATE ON payments.payments
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.assert_payment_consistency();
   CREATE CONSTRAINT TRIGGER payment_operations_aggregate_consistency AFTER INSERT OR UPDATE ON payments.payment_operations
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.assert_payment_consistency();
   ```
   Disabling requires table ownership (`fl_migration_owner` only). Terminal one-way enforcement remains in `payment_operations_guard` (P02-T09).
3. No RLS or grant changes (the function runs as the DML-issuing role, which already holds `SELECT` on both tables).
4. Update `fixtureCapturedPayment` only if its rows violate a rule (they must not; verify in tests).

**Expected behavior**
- Owner txn: insert `REQUESTED` `CAPTURE` on an authorized payment without setting the pointer → statements succeed; `COMMIT` fails `23514` constraint `payment_aggregate_consistency`, message suffix `active_exclusive_operation_id`; no rows persist.
- Same txn plus `fixtureUpdatePayment(pay, { active_exclusive_operation_id: op })` → commits.

**Acceptance criteria**
- [ ] A pointer that is null while an unresolved exclusive operation exists, set while none exists, or pointing at a terminal/refund operation fails at commit.
- [ ] Any drift between `reserved_refund_amount_minor`/`unresolved_refund_count` and the unresolved refund rows fails at commit, whether the drift was caused by updating the payment or only an operation row.
- [ ] Captured/refunded totals and authorization outcome disagreeing with successful-operation cardinality fail at commit.
- [ ] Consistent multi-row transitions commit (accept refund, resolve refund success, resolve rejection).
- [ ] No runtime role or function-owner role can disable the trigger.

**Testing requirements** — `test/integration/db/payment-consistency.test.ts` (owner, `fixture*` helpers, `createTestMerchant` per test). Every failure case asserts `err.code === '23514'`, `err.constraint === 'payment_aggregate_consistency'`, the exact message suffix, and that the payment/operation rows are unchanged afterward:
- pointer: unresolved CAPTURE inserted, pointer null → `active_exclusive_operation_id`; pointer set to a `SUCCEEDED` AUTHORIZE → same; pointer set to a REFUND operation (count 0 path: use a refund with reservation fields consistent) → same; pointer cleared while CAPTURE still `PROCESSING` → same.
- reservation: on `fixtureCapturedPayment(1000)`: insert `REQUESTED` refund 100 without payment update → `reserved_refund_amount_minor`; update payment reserved=100,count=1 with no refund row → `reserved_refund_amount_minor`; refund 100 with reserved=100,count=2 → fails (`payments_reservation_count` passes; trigger reports `unresolved_refund_count`); move refund `REQUESTED→REJECTED` (operation-only update) without releasing → `reserved_refund_amount_minor`.
- positive: accept refunds 300 and 200 (reserved 500, count 2) commits; resolve the 300 refund `SUCCEEDED` with fee and payment `refunded=300, reserved=200, count=1` in one txn commits; resolve the 200 refund `REJECTED` releasing reservation commits; `refunded + reserved` never exceeded captured.
- totals: set `captured_amount_minor` on a payment with no succeeded capture → `captured_amount_minor`; two succeeded refunds 100+200 with `refunded=250` → `refunded_amount_minor`; `AUTHORIZED` with no succeeded AUTHORIZE → `authorization_outcome`; succeeded CANCEL with outcome `AUTHORIZED` → `canceled`.
- privilege: as `payments_function_owner` (`withRole`) and as `fl_api`: `ALTER TABLE payments.payments DISABLE TRIGGER payments_aggregate_consistency` → `42501`.
- immediate mode: `SET CONSTRAINTS ALL IMMEDIATE`, then the pointer-null CAPTURE insert fails at that statement with the same constraint and message, proving the check runs regardless of deferral mode.
- Command: `pnpm vitest run --project integration test/integration/db/payment-consistency.test.ts`.

**Non-goals** — No acceptance guard (`409 MONETARY_GUARD_FAILED`, P05), no fee computation, no transition functions.

**Handoff checklist**
- [ ] Each failing case was seen to commit successfully with its assertion commented out, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T11 — Migration 0270: API idempotency records and atomic claim primitive

**Task ID:** `P02-T11`
**Feature:** API idempotency ownership, replay data, tombstones, result integrity
**Commit:** `feat(db): add API idempotency records with atomic claim and lifetime tombstones`
**Priority:** Critical
**Dependencies:** `P02-T10`
**Estimated complexity:** L
**Contract references:** docs/07 §API idempotency; docs/05 §API idempotency contract (all subsections), §Request and correlation identifiers; ADR-0006, ADR-0009; docs/10 M2 bullet 7, tests 7–8; README §10.1 C-07
**Files:** create: `migrations/0270_api_idempotency.sql`, `test/integration/db/idempotency.test.ts`; modify: `packages/testkit/src/fixtures/payments.ts`; must not touch: earlier migrations

**Objective** — The `(merchant_id, command_type, idempotency_key)` boundary, a claim function that elects exactly one owner without aborting waiters, deterministic replay/conflict/expired outcomes, a deferred result-resource integrity check, and immutable lifetime tombstones. `create_payment`/`accept_operation` (P04/P05) call the claim as their first statement.

**Implementation instructions**
1. `api.idempotency_records` per docs/07. Named: `idempotency_records_pkey (merchant_id, command_type, idempotency_key)`, `idempotency_records_merchant_fkey`, `idempotency_records_credential_fkey (merchant_id, credential_id) → identity.merchant_api_credentials (merchant_id, id)`, `idempotency_records_command_type CHECK (command_type IN ('CREATE_PAYMENT','AUTHORIZE','CAPTURE','CANCEL','REFUND'))`, `idempotency_records_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$')`, `idempotency_records_request_hash CHECK (public.fl_is_sha256(request_hash))`, `idempotency_records_response_hash CHECK (public.fl_is_sha256(response_hash))`, `idempotency_records_resource_type CHECK ((resource_type = 'PAYMENT') = (command_type = 'CREATE_PAYMENT') AND resource_type IN ('PAYMENT','PAYMENT_OPERATION'))`, `idempotency_records_resource_id_format CHECK (CASE resource_type WHEN 'PAYMENT' THEN public.fl_is_id(resource_id,'pay') ELSE public.fl_is_id(resource_id,'op') END)`, `idempotency_records_http_status CHECK (http_status IN (201, 202) AND (http_status = 201) = (command_type = 'CREATE_PAYMENT'))`, `idempotency_records_replay_shape CHECK ((tombstoned_at IS NULL AND response_body IS NOT NULL AND response_headers IS NOT NULL AND jsonb_typeof(response_body) = 'object' AND jsonb_typeof(response_headers) = 'object') OR (tombstoned_at IS NOT NULL AND response_body IS NULL AND response_headers IS NULL))`, `idempotency_records_replay_window CHECK (replay_expires_at = committed_at + interval '90 days')`, `idempotency_records_correlation_id CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{16,128}$')`. Indexes: `idempotency_records_audit (merchant_id, committed_at DESC)`, `idempotency_records_tombstone_due (replay_expires_at) WHERE tombstoned_at IS NULL`, `idempotency_records_credential (credential_id)`.
2. Triggers:
   - `idempotency_records_guard BEFORE UPDATE`: `fl_assert_unchanged` over every column except `response_body`, `response_headers`, `tombstoned_at`; the only permitted change is `OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NOT NULL AND NEW.response_body IS NULL AND NEW.response_headers IS NULL AND clock_timestamp() >= OLD.replay_expires_at`, else `INVALID_TRANSITION {"reason":"TOMBSTONE_ONLY"}`. No delete/truncate.
   - `idempotency_records_resource_integrity` — `CONSTRAINT TRIGGER AFTER INSERT ON api.idempotency_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` → `api.assert_idempotency_resource()`: `PAYMENT` requires `EXISTS (payments.payments WHERE id = resource_id AND merchant_id = NEW.merchant_id)`; `PAYMENT_OPERATION` requires `EXISTS (payments.payment_operations WHERE id = resource_id AND merchant_id = NEW.merchant_id AND type = NEW.command_type)`; else `RAISE ... ERRCODE '23514', CONSTRAINT 'idempotency_records_resource_integrity'`. Deferred so the claim (lock order step 1) can precede the payment/operation insert in the same transaction.
3. Claim function (internal; `SECURITY INVOKER`; owner `payments_function_owner` via `fl_assign_function_owner`; `SET search_path = pg_catalog, pg_temp`; EXECUTE only to `payments_function_owner`). **[ASSUMPTION]** no `api` function-owner role exists in CONVENTIONS §7; `payments_function_owner` owns it because only payment functions call it (risk R3).
   ```sql
   CREATE FUNCTION api.claim_idempotency_key(
     p_merchant_id text, p_command_type text, p_idempotency_key text, p_request_hash bytea,
     p_resource_type text, p_resource_id text, p_http_status smallint,
     p_response_body jsonb, p_response_headers jsonb, p_response_hash bytea,
     p_correlation_id text, p_credential_id text, p_lock_timeout_ms integer)
   RETURNS TABLE (outcome text, resource_type text, resource_id text, http_status smallint,
                  response_body jsonb, response_headers jsonb, correlation_id text)
   LANGUAGE plpgsql VOLATILE ...
   ```
   Body:
   1. `p_merchant_id IS DISTINCT FROM public.fl_current_merchant_id()` → `fl_raise_domain('TENANT_CONTEXT_MISMATCH')`.
   2. `v_prev := current_setting('lock_timeout'); PERFORM set_config('lock_timeout', p_lock_timeout_ms || 'ms', true);`
   3. `BEGIN INSERT INTO api.idempotency_records (...) VALUES (..., committed_at := clock_timestamp(), replay_expires_at := clock_timestamp() + interval '90 days') ON CONFLICT (merchant_id, command_type, idempotency_key) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; EXCEPTION WHEN lock_not_available THEN PERFORM public.fl_raise_domain('IDEMPOTENCY_REQUEST_IN_PROGRESS', jsonb_build_object('retryAfterSeconds', 1)); END;` (use one `v_now := clock_timestamp()` for both timestamps so the window check holds exactly).
   4. `PERFORM set_config('lock_timeout', v_prev, true);`
   5. `v_rows = 1` → return `('OWNER', p_resource_type, p_resource_id, p_http_status, p_response_body, p_response_headers, p_correlation_id)`.
   6. Else read the existing row: if `tombstoned_at IS NOT NULL OR clock_timestamp() >= replay_expires_at` → `('EXPIRED', resource_type, resource_id, http_status, NULL, NULL, correlation_id)` (read-time expiry, C-07); elsif `request_hash = p_request_hash` → `('REPLAY', <stored row values>)`; else `('CONFLICT', NULL, NULL, NULL, NULL, NULL, NULL)` (reveals nothing of the original).
   A waiter blocks on the uncommitted conflicting insert; owner commit → waiter gets `REPLAY`/`CONFLICT`; owner rollback → waiter's insert succeeds and it becomes `OWNER`. No unhandled unique violation aborts the caller's transaction.
4. RLS enabled: `idempotency_records_function_owner_all FOR ALL TO payments_function_owner USING (true) WITH CHECK (true)`. Grants (last): `GRANT USAGE ON SCHEMA api TO payments_function_owner; GRANT SELECT, INSERT, UPDATE (response_body, response_headers, tombstoned_at) ON api.idempotency_records TO payments_function_owner`. No runtime grants.
5. Add to `packages/testkit/src/fixtures/payments.ts`: `fixtureClaim(pool, m, o)` — opens a client, `BEGIN`, `SET LOCAL ROLE payments_function_owner`, sets `app.merchant_id`, calls `api.claim_idempotency_key`, optionally `pg_sleep(o.holdMs)`, then `COMMIT` or `ROLLBACK` per `o.finish`; returns the outcome row. And `fixtureInsertIdempotencyRecord(c, m, o)` for direct owner inserts (used to create past `committed_at` records).

**Expected behavior** — 100 concurrent identical claims for `(m, 'CREATE_PAYMENT', key)` with the same hash → one `OWNER`, 99 `REPLAY` with identical body; one row. Same key, different hash → `CONFLICT`. Record with `committed_at = now() - 91 days` → `EXPIRED` for any hash.

**Acceptance criteria**
- [ ] One hundred concurrent claims of one key elect exactly one owner (docs/10 M2 test 7); the others receive the owner's stored result.
- [ ] Same key + changed request hash → `CONFLICT` deterministically (docs/10 M2 test 8), including when racing.
- [ ] Owner rollback lets exactly one waiter become owner.
- [ ] Holding the owner transaction past `p_lock_timeout_ms` → waiter raises `P0001 IDEMPOTENCY_REQUEST_IN_PROGRESS` and inserts nothing.
- [ ] After 90 days (or tombstoning) any reuse → `EXPIRED` with resource identity; nothing executes.
- [ ] Result resource must be a same-merchant payment (CREATE_PAYMENT) or same-merchant operation of the exact command type, checked at commit.
- [ ] Only the one-way tombstone transition is permitted, and only after `replay_expires_at`; the same key text is isolated across merchants and command types.

**Testing requirements** — `test/integration/db/idempotency.test.ts` (pool `max` ≥ 110 for the concurrency case; payment created by `fixtureInsertPayment` beforehand so the deferred resource check passes):
- concurrency (identical): 100 `fixtureClaim` with `holdMs: 50`, `finish: 'commit'` via `Promise.all` → outcomes `{OWNER:1, REPLAY:99}`, all REPLAY bodies deep-equal the owner's, `count(*) = 1`. Breaking check: the test asserts no promise rejected with `23505`.
- concurrency (divergent): 100 claims, 50 with hash A and 50 with hash B → exactly one `OWNER`; every other claim with the owner's hash is `REPLAY`, every other with the other hash is `CONFLICT`.
- rollback: owner `finish: 'rollback'`, one waiter → waiter `OWNER`; row has waiter's hash.
- in-progress: owner `holdMs: 1500`; waiter `p_lock_timeout_ms: 200` → rejects `P0001 IDEMPOTENCY_REQUEST_IN_PROGRESS`; after owner commits, `count(*) = 1`.
- expired: `fixtureInsertIdempotencyRecord` with `committed_at = now() - interval '91 days'` → same hash `EXPIRED`, different hash `EXPIRED`, `resource_id` returned, row unchanged; exactly at 90 days boundary (`committed_at = clock_timestamp() - interval '90 days'`) → `EXPIRED`; at 89 days → `REPLAY`.
- tombstone: tombstone transition on an 89-day record → `INVALID_TRANSITION`; on a 91-day record → succeeds; tombstoned record → `EXPIRED`; changing `request_hash` → `IMMUTABLE_FIELD`; delete → `IMMUTABLE_ROW`.
- scope: same key text for merchant B and for command `AUTHORIZE` under merchant A both `OWNER`.
- tenant: `app.merchant_id` = B while claiming for A → `TENANT_CONTEXT_MISMATCH`.
- resource integrity (commit-time `23514 idempotency_records_resource_integrity`): `PAYMENT` resource owned by merchant B; nonexistent payment; `PAYMENT_OPERATION` of type `CAPTURE` under command `REFUND`.
- constraint negatives for every named check (`assertConstraintCoverage`), including key length 15/129, key with `/`, `http_status 200`, `CREATE_PAYMENT` with `PAYMENT_OPERATION`, window ≠ 90 days.
- privileges: every `LOGIN_RUNTIME_ROLES` member `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the table and `EXECUTE api.claim_idempotency_key` → `42501`.
- Command: `pnpm vitest run --project integration test/integration/db/idempotency.test.ts`.

**Non-goals** — No HTTP header parsing, canonical request hashing (P01/P04), `create_payment` (P04), or tombstoning job (deferred in docs/10 M11; expiry is evaluated at read time).

**Handoff checklist**
- [ ] Replacing `ON CONFLICT DO NOTHING` with a plain `INSERT` makes the 100-claim test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T12 — Migration 0280: messaging tables and message-type registry

**Task ID:** `P02-T12`
**Feature:** Outbox, inbox, dead-letter, replay persistence
**Commit:** `feat(db): add outbox, inbox, DLQ, replay tables and seeded message-type registry`
**Priority:** Critical
**Dependencies:** `P02-T11`
**Estimated complexity:** L
**Contract references:** docs/07 §Messaging (all four tables), §Mutability rules (Outbox, Inbox), §Retention (no deletes in MVP); docs/04 §Envelope, §Transactional outbox, §Inbox consumption, §Retry and dead-letter policy; docs/08 §DLQ contract; `schemas/registry.v1.json`; `schemas/common/message-envelope.v1.schema.json`
**Files:** create: `migrations/0280_messaging_tables.sql`, `test/integration/db/messaging-tables.test.ts`; must not touch: earlier migrations, `schemas/**`

**Objective** — Durable message persistence whose identity/content columns cannot be forged or altered by any role, plus a database copy of the registry so `insert_outbox` (P02-T13) can reject unregistered types inside the transaction.

**Implementation instructions**
1. `messaging.message_types` — the registry inside PostgreSQL. **[ASSUMPTION]** the registry reaches the DB as a migration-seeded table kept in sync by a parity test (risk R7):
   ```sql
   CREATE TABLE messaging.message_types (
     message_type text COLLATE "C" CONSTRAINT message_types_pkey PRIMARY KEY
       CONSTRAINT message_types_type_format CHECK (message_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.v[1-9][0-9]*$'),
     kind text NOT NULL CONSTRAINT message_types_kind CHECK (kind IN ('COMMAND','EVENT')),
     schema_version integer NOT NULL CONSTRAINT message_types_schema_version CHECK (schema_version = substring(message_type from '\.v([1-9][0-9]*)$')::integer),
     aggregate_type text NOT NULL CONSTRAINT message_types_aggregate_type CHECK (aggregate_type IN ('payment','payment_operation','ledger_transaction','webhook_delivery','settlement_batch')),
     schema_path text NOT NULL
   );
   ```
   Insert all 26 rows of `schemas/registry.v1.json` (same `kind`, `type`, `schema`), with `aggregate_type` = the schema's `aggregateType` const: `payment` for every `payment.*` type and both `payment.operation.*` commands; `webhook_delivery` for `merchant.webhook.deliver.v1`; `ledger_transaction` for `ledger.transaction.posted.v1`; `settlement_batch` for `settlement.batch.posted.v1`. Insert-only: no update/delete/truncate triggers (`fl_reject_mutation`). A new type = a new migration row.
2. `messaging.outbox_messages` — columns exactly per docs/07; defaults `recorded_at`/`available_at` = `clock_timestamp()`, `publication_attempts` = 0. Named: `outbox_messages_pkey (envelope_id)`, `outbox_messages_message_type_fkey → messaging.message_types`, `outbox_messages_merchant_fkey`, `outbox_messages_kind`, `outbox_messages_schema_version CHECK (schema_version >= 1 AND schema_version = substring(message_type from '\.v([1-9][0-9]*)$')::integer)`, `outbox_messages_aggregate_version CHECK (aggregate_version >= 1)`, `outbox_messages_publication_attempts CHECK (publication_attempts >= 0)`, `outbox_messages_envelope_hash CHECK (public.fl_is_sha256(envelope_hash))`, `outbox_messages_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))`, `outbox_messages_archive_state CHECK (envelope IS NOT NULL OR (archived_envelope_reference IS NOT NULL AND published_at IS NOT NULL))`, and the derivation proof:
   ```sql
   CONSTRAINT outbox_messages_envelope_derivation CHECK (envelope IS NULL OR (
     jsonb_typeof(envelope) = 'object'
     AND envelope_id::text = envelope->>'id' AND kind = envelope->>'kind' AND message_type = envelope->>'type'
     AND schema_version::text = envelope->>'schemaVersion' AND source = envelope->>'source'
     AND merchant_id = envelope->>'merchantId' AND aggregate_type = envelope->>'aggregateType'
     AND aggregate_id = envelope->>'aggregateId' AND aggregate_version::text = envelope->>'aggregateVersion'
     AND ordering_key = envelope->>'orderingKey' AND correlation_id = envelope->>'correlationId'
     AND causation_id = envelope->>'causationId'))
   ```
   (UUID comparison uses lower-case text; `insert_outbox` stores `id` lower-cased.) Indexes: `outbox_due` exactly as docs/07; `outbox_lease_recovery (lease_expires_at) WHERE published_at IS NULL AND lease_token IS NOT NULL`; `outbox_messages_merchant (merchant_id)`; `outbox_messages_message_type (message_type)`.
   Trigger `outbox_messages_guard BEFORE UPDATE`: `fl_assert_unchanged` over `envelope_id, kind, message_type, schema_version, source, merchant_id, aggregate_type, aggregate_id, aggregate_version, ordering_key, correlation_id, causation_id, occurred_at, recorded_at, envelope_hash`; `envelope` may change only from non-null to null when `NEW.archived_envelope_reference IS NOT NULL AND NEW.published_at IS NOT NULL`; `archived_envelope_reference` and `published_at` are set-once; `publication_attempts` non-decreasing. Mutable: `available_at`, lease fields, `publication_attempts`, `published_at`, `broker_message_id`, `last_error_class`. No delete/truncate.
3. `messaging.inbox_messages` per docs/07. Named: `inbox_messages_pkey (consumer_name, envelope_id)`, `inbox_messages_merchant_fkey`, `inbox_messages_consumer_name CHECK (consumer_name ~ '^[a-z][a-z0-9-]{1,62}$')`, `inbox_messages_message_type_format` (same regex as message types), `inbox_messages_envelope_hash`, `inbox_messages_processed_after_received CHECK (processed_at >= received_at)`; index `inbox_messages_merchant (merchant_id)`. Insert-only: `fl_reject_mutation` on UPDATE/DELETE/TRUNCATE.
4. `messaging.dead_letter_records` per docs/07. Named: `dead_letter_records_pkey`, `dead_letter_records_consumer_envelope_key UNIQUE (consumer_name, envelope_id)`, `dead_letter_records_merchant_fkey`, `dead_letter_records_payment_fkey (merchant_id, payment_id) → payments.payments (merchant_id, id)`, `dead_letter_records_operation_fkey (merchant_id, operation_id) → payments.payment_operations (merchant_id, id)`, `dead_letter_records_subject_requires_merchant CHECK ((payment_id IS NULL AND operation_id IS NULL) OR merchant_id IS NOT NULL)`, `dead_letter_records_failure_class CHECK (failure_class IN ('SCHEMA_INVALID','INVARIANT_VIOLATION','UNSUPPORTED_VERSION','RETRY_EXHAUSTED'))` (**[ASSUMPTION]** names for docs/07's "Schema, invariant, unsupported version, or retry exhausted"; risk R16), `dead_letter_records_attempt_count CHECK (attempt_count > 0)`, `dead_letter_records_envelope_hash`, `dead_letter_records_envelope_object CHECK (envelope IS NULL OR jsonb_typeof(envelope) = 'object')`, `dead_letter_records_error_detail_object CHECK (jsonb_typeof(error_detail) = 'object')`, `dead_letter_records_archive_state CHECK (envelope IS NOT NULL OR archived_envelope_reference IS NOT NULL)`, `dead_letter_records_failure_window CHECK (last_failed_at >= first_failed_at)`, `dead_letter_records_traceparent CHECK (traceparent IS NULL OR traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')`; indexes `dead_letter_records_merchant (merchant_id) WHERE merchant_id IS NOT NULL`, `dead_letter_records_payment (merchant_id, payment_id) WHERE payment_id IS NOT NULL`, `dead_letter_records_operation (merchant_id, operation_id) WHERE operation_id IS NOT NULL`. Update trigger: immutable `id, consumer_name, subscription_name, envelope_id, envelope_hash, merchant_id, payment_id, operation_id, correlation_id, traceparent, failure_class, first_failed_at`; `attempt_count` and `last_failed_at` non-decreasing; `resolved_at` and `archived_envelope_reference` set-once; `envelope` non-null→null only with archive reference. No delete/truncate.
5. `messaging.dead_letter_replays` per docs/07. Named: `dead_letter_replays_pkey`, `dead_letter_replays_dead_letter_fkey`, `dead_letter_replays_outcome CHECK (outcome IN ('PUBLISHED','SKIPPED_TERMINAL','FAILED'))`, `dead_letter_replays_actor CHECK (char_length(actor_id) > 0)`, `dead_letter_replays_reason CHECK (char_length(reason) > 0)`, `dead_letter_replays_error_class CHECK ((outcome = 'FAILED') = (error_class IS NOT NULL))`; index `dead_letter_replays_dead_letter (dead_letter_id)`. Append-only (`fl_reject_mutation` on UPDATE/DELETE/TRUNCATE).
6. RLS enabled on outbox, inbox, DLQ, replays. Policies: `outbox_messages_messaging_owner_all FOR ALL TO messaging_function_owner USING (true) WITH CHECK (true)`. No other policies in this phase (P05 adds relay/consumer policies with their functions).
7. Grants (last): `GRANT USAGE ON SCHEMA messaging TO messaging_function_owner; GRANT SELECT ON messaging.message_types TO messaging_function_owner; GRANT SELECT, INSERT ON messaging.outbox_messages TO messaging_function_owner`. **No runtime role receives any privilege on any messaging table** (insertion paths for inbox/DLQ/relay leases arrive with their protected functions in P05).

**Expected behavior** — Owner `UPDATE messaging.outbox_messages SET merchant_id = '<other>'` → `IMMUTABLE_FIELD`; with the guard trigger disabled inside a rolled-back owner txn, the same update → `23514 outbox_messages_envelope_derivation` (two independent layers).

**Acceptance criteria**
- [ ] `messaging.message_types` equals `schemas/registry.v1.json` exactly (type, kind, schema path) and each `aggregate_type` equals the referenced schema's `aggregateType` const.
- [ ] Every named constraint/index has a negative test (`assertConstraintCoverage` on all five tables).
- [ ] Outbox identity/content columns cannot change and cannot diverge from `envelope`; the hot envelope clears only with an archive reference after publication.
- [ ] Inbox rows and replay rows are insert-only; DLQ identity fields are immutable; DLQ subject IDs are tenant-safe.
- [ ] Every runtime role gets `42501` for `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on all five tables.

**Testing requirements** — `test/integration/db/messaging-tables.test.ts` (owner direct inserts allowed — migration/constraint test):
- registry parity: read `schemas/registry.v1.json` and each referenced schema file; compare with `SELECT * FROM messaging.message_types` (set equality on `(message_type, kind, schema_path)`, aggregate type from `allOf[1].properties.aggregateType.const`).
- outbox: every named check negative (schema version ≠ suffix; unregistered type FK; wrong envelope copy per derived field — 12 cases each asserting `outbox_messages_envelope_derivation`; envelope null while unpublished; lease token without expiry; 31-byte hash); guard: change each immutable column → `IMMUTABLE_FIELD`; clear envelope while unpublished → error; clear with archive ref after publish → ok; `publication_attempts` decrease → error; delete/truncate → `IMMUTABLE_ROW`.
- inbox: update/delete/truncate → `IMMUTABLE_ROW`; duplicate `(consumer_name, envelope_id)` → `inbox_messages_pkey`; bad consumer name.
- DLQ: payment of merchant B with merchant A → `dead_letter_records_payment_fkey`; payment without merchant → `dead_letter_records_subject_requires_merchant`; `failure_class 'OTHER'`; attempt 0; duplicate consumer/envelope; change `envelope_hash` → `IMMUTABLE_FIELD`; lower `attempt_count` → error; delete → `IMMUTABLE_ROW`.
- replays: `FAILED` without `error_class`; update → `IMMUTABLE_ROW`.
- message_types: update/delete → `IMMUTABLE_ROW`.
- privileges: loop `LOGIN_RUNTIME_ROLES` × five tables × (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`) → `42501`.
- Command: `pnpm vitest run --project integration test/integration/db/messaging-tables.test.ts`.

**Non-goals** — No `insert_outbox` (P02-T13), relay claim, inbox/DLQ insertion functions, transports (P05), or archival jobs (deferred, docs/10 M11).

**Handoff checklist**
- [ ] Removing one registry row from the migration makes the parity test fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T13 — Migration 0290: protected outbox insertion `messaging.insert_outbox`

**Task ID:** `P02-T13`
**Feature:** Strict envelope-column derivation and protected outbox boundary
**Commit:** `feat(db): add messaging.insert_outbox with registry and correlation checks`
**Priority:** Critical
**Dependencies:** `P02-T12`
**Estimated complexity:** L
**Contract references:** docs/07 §`messaging.outbox_messages` (insert_outbox bullets); docs/04 §Envelope (rules), §Transactional outbox; `schemas/README.md` §Required post-schema semantic correlation validator; `schemas/common/message-envelope.v1.schema.json`; `schemas/commands/*.json`, `schemas/events/*.json`; ADR-0007; CONVENTIONS §9; docs/10 M2 bullet 8, test 10
**Files:** create: `migrations/0290_insert_outbox.sql`, `packages/testkit/src/envelopes.ts`, `test/integration/db/insert-outbox.test.ts`; modify: `packages/testkit/src/index.ts`; must not touch: earlier migrations, `schemas/**`

**Objective** — The only way a row enters `messaging.outbox_messages`: a `SECURITY DEFINER` function that rejects unregistered or malformed envelopes, enforces the identity/correlation rules expressible from the envelope plus authoritative rows, derives every relational column from the envelope, and aborts the enclosing domain transaction on failure.

**Implementation instructions**
1. Signature (CONVENTIONS §9, docs/07): `CREATE FUNCTION messaging.insert_outbox(p_envelope jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp`. Owner `messaging_function_owner` (`fl_assign_function_owner`). Fully qualified names only; no dynamic SQL.
2. Every rejection: `PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', '<REASON>', 'field', '<field or null>'))`. Checks in order:
   | # | Check | Reason |
   | --- | --- | --- |
   | 1 | `jsonb_typeof(p_envelope) = 'object'` | `NOT_OBJECT` |
   | 2 | no key outside `{id, kind, type, schemaVersion, source, occurredAt, recordedAt, merchantId, aggregateType, aggregateId, aggregateVersion, orderingKey, correlationId, causationId, traceparent, data}` | `UNKNOWN_FIELD` |
   | 3 | every key except `traceparent` present and non-null | `MISSING_FIELD` |
   | 4 | `id` matches `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`; `occurredAt`/`recordedAt` match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$`; `source` matches `^flowledger\.[a-z][a-z0-9.]*$` (≤100); `merchantId` is a `mer` ID; `aggregateId` matches `^[a-z][a-z0-9]{1,15}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`; `schemaVersion` and `aggregateVersion` are JSON integers ≥ 1; `orderingKey` 1–128 chars; `correlationId` matches `^[A-Za-z0-9._:-]{16,128}$`; `causationId` 1–128 chars; `traceparent` (if present) matches the envelope schema pattern; `data` is an object | `INVALID_FIELD_FORMAT` |
   | 5 | `type` exists in `messaging.message_types` | `UNREGISTERED_TYPE` |
   | 6 | `kind` = registered kind | `KIND_MISMATCH` |
   | 7 | `schemaVersion` = registered `schema_version` (= `.vN` suffix) | `SCHEMA_VERSION_MISMATCH` |
   | 8 | `aggregateType` = registered `aggregate_type` | `AGGREGATE_TYPE_MISMATCH` |
   | 9 | aggregate `payment`: `aggregateId` is a `pay` ID, `aggregateId = data->>'paymentId'` and `orderingKey = data->>'paymentId'` | `AGGREGATE_ID_MISMATCH` / `ORDERING_KEY_MISMATCH` |
   | 10 | type `payment.operation.execute.v1`: `aggregateVersion = (data->>'expectedPaymentVersion')::bigint` | `AGGREGATE_VERSION_MISMATCH` |
   | 11 | aggregate `payment`: `EXISTS (payments.payments WHERE id = aggregateId AND merchant_id = merchantId)`; if `data ? 'operationId'`: `EXISTS (payments.payment_operations WHERE id = data->>'operationId' AND payment_id = aggregateId AND merchant_id = merchantId)` | `SUBJECT_NOT_FOUND` |
   | 12 | aggregate `ledger_transaction`: `aggregateId = data->>'ledgerTransactionId'` | `AGGREGATE_ID_MISMATCH` |
   | 13 | aggregate `webhook_delivery`: `aggregateId = data->>'deliveryId'` and `orderingKey = data->>'endpointId'` (**[ASSUMPTION]** risk R2) | `AGGREGATE_ID_MISMATCH` / `ORDERING_KEY_MISMATCH` |
   | 14 | aggregate `settlement_batch`: `aggregateId = data->>'settlementBatchId'`, `orderingKey = merchantId`, `aggregateVersion = 1`, `data->>'postingKey' = 'settlement:' || aggregateId` | `AGGREGATE_ID_MISMATCH` / `ORDERING_KEY_MISMATCH` / `AGGREGATE_VERSION_MISMATCH` / `POSTING_KEY_MISMATCH` |
   Subject-existence checks for ledger, webhook, and settlement aggregates are added by P03/P09/P10 via `CREATE OR REPLACE` when those tables exist. Full JSON Schema payload validation stays in TypeScript before the call (docs/07: "producer runs the checked-in strict JSON Schema validator, then calls").
3. Insert: `v_env := jsonb_set(p_envelope, '{id}', to_jsonb(lower(p_envelope->>'id')))`; `INSERT INTO messaging.outbox_messages (envelope_id, kind, message_type, schema_version, source, merchant_id, aggregate_type, aggregate_id, aggregate_version, ordering_key, correlation_id, causation_id, occurred_at, envelope, envelope_hash) VALUES (... all derived from v_env ..., (v_env->>'occurredAt')::timestamptz, v_env, sha256(convert_to(v_env::text, 'UTF8')))`; `recorded_at`/`available_at` take database defaults. A duplicate `envelope_id` raises `23505 outbox_messages_pkey` (producer bug; never silently ignored). Return `envelope_id`. **[ASSUMPTION]** `envelope_hash` = SHA-256 of PostgreSQL's canonical `jsonb` text form (risk R6).
4. Invoker validation = the EXECUTE ACL (**[ASSUMPTION]** risk R15): `REVOKE ALL ON FUNCTION messaging.insert_outbox(jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION messaging.insert_outbox(jsonb) TO payments_function_owner, ledger_function_owner, settlement_function_owner, reconciliation_function_owner, webhooks_function_owner`. No runtime role may execute it in M2.
5. Grants (last) also: `GRANT USAGE ON SCHEMA messaging TO payments_function_owner, ledger_function_owner, settlement_function_owner, reconciliation_function_owner, webhooks_function_owner`.
6. `packages/testkit/src/envelopes.ts` — envelope builders producing schema-valid envelopes via `buildEnvelope()` from `@flowledger/contracts` (validates schema + semantics on construction):
   ```ts
   export function paymentCreatedEnvelope(p: { merchantId: string; paymentId: string; providerAccountId: string; amountMinor: bigint; feePolicyVersion: number }): Envelope;
   export function executeCommandEnvelope(p: { merchantId: string; paymentId: string; operationId: string; expectedPaymentVersion: number }): Envelope;
   export function ledgerPostedEnvelope(p: { merchantId: string; ledgerTransactionId: string; /* remaining required data fields per schema */ }): Envelope;
   export function webhookDeliverEnvelope(p: { merchantId: string; deliveryId: string; endpointId: string; domainEventId: string }): Envelope;
   export function settlementPostedEnvelope(p: { merchantId: string; settlementBatchId: string; /* remaining required data fields per schema */ }): Envelope;
   ```

**Expected behavior** — As `payments_function_owner` (with an existing payment): `SELECT messaging.insert_outbox(<payment.created.v1>)` → returns its UUID; row columns equal the envelope fields; `envelope_hash` 32 bytes. Same envelope with `"orderingKey": "<other pay_ id>"` → `P0001 INVALID_ENVELOPE {"reason":"ORDERING_KEY_MISMATCH"}` and the enclosing transaction aborts.

**Acceptance criteria**
- [ ] Each reason in the table has a test that fails if that check is removed (assert `detail.reason`, not just "an error").
- [ ] Every registered type with a positive builder fixture is accepted and every relational column equals its envelope field.
- [ ] A rejected call inside a transaction that already inserted other rows leaves none of them committed.
- [ ] No runtime role can execute `insert_outbox` or insert into the outbox directly.
- [ ] Unknown envelope fields and unregistered type/version pairs never reach the table.

**Testing requirements** — `test/integration/db/insert-outbox.test.ts` (`withRole(ownerPool, 'payments_function_owner', ...)`; payment/operation via `fixtureInsertPayment`/`fixtureInsertOperation` beforehand):
- positive: `payment.created.v1`, `payment.operation.execute.v1`, `ledger.transaction.posted.v1`, `merchant.webhook.deliver.v1`, `settlement.batch.posted.v1` → accepted, each relational column equals the envelope field; upper-case UUID input stored lower-case; envelope passes `buildEnvelope` validation (proves fixtures are schema-valid, so rejections come from the DB checks).
- negatives (one per reason, each starting from a valid envelope and mutating one thing): array input; extra field `foo`; missing `causationId`; bad UUID; bad `occurredAt`; `merchantId` with `pay_` prefix; `schemaVersion` `"1"` (string); unregistered `payment.created.v2`; `kind: 'COMMAND'` on an event; `type` `payment.created.v1` with `schemaVersion: 2`; `aggregateType: 'payment_operation'` on `payment.created.v1`; payment `aggregateId ≠ data.paymentId`; `orderingKey ≠ data.paymentId`; execute `aggregateVersion ≠ expectedPaymentVersion`; nonexistent payment; payment owned by merchant B with `merchantId` A; `operationId` of another payment; ledger `aggregateId ≠ ledgerTransactionId`; webhook `orderingKey ≠ endpointId`; settlement `orderingKey ≠ merchantId`; settlement `aggregateVersion: 2`; settlement wrong `postingKey`.
- atomicity: in one transaction as `payments_function_owner`: insert a valid outbox row, then call with an invalid envelope → error; after rollback, zero outbox rows for that merchant.
- duplicate `envelope_id` → `23505 outbox_messages_pkey`.
- privileges: each `LOGIN_RUNTIME_ROLES` member `EXECUTE` → `42501`; `has_function_privilege('public', ...)` false; function is `prosecdef = true` with `proconfig` containing `search_path=pg_catalog, pg_temp`.
- Command: `pnpm vitest run --project integration test/integration/db/insert-outbox.test.ts`.

**Non-goals** — No relay, transport, inbox, or DLQ insertion (P05). No producer code beyond test builders.

**Handoff checklist**
- [ ] Each negative case was seen to pass through (row inserted) with its check removed, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T14 — Merchant-scoped repositories and cross-tenant / runtime-role matrices

**Task ID:** `P02-T14`
**Feature:** RLS and explicit merchant-scoped queries
**Commit:** `feat(db): add merchant-scoped payment repositories and tenant-isolation matrix tests`
**Priority:** High
**Dependencies:** `P02-T13`
**Estimated complexity:** M
**Contract references:** docs/07 §Tenant isolation (items 1–6), §Protected payment transition functions (first paragraph); docs/05 §Authentication (cross-tenant → `404`); ADR-0007; docs/10 M2 bullet 9, tests 3, 4, 9, 10
**Files:** create: `packages/database/src/repositories/payments.ts`, `test/integration/db/tenant-isolation.test.ts`, `test/integration/db/runtime-role-dml.test.ts`; modify: `packages/database/src/index.ts`; must not touch: `migrations/**`

**Objective** — Give later phases read queries that always carry an explicit merchant predicate (RLS is defense in depth), and prove in one place that every M2 table/function denies cross-tenant reads/references and direct runtime DML.

**Implementation instructions**
1. `packages/database/src/repositories/payments.ts` (explicit column lists; never `SELECT *`; never the ciphertext column):
   ```ts
   export interface PaymentRow { id: string; merchantId: string; currency: 'USD'; providerAccountId: string; providerAccountVersion: number; feePolicyId: string; feePolicyVersion: number; requestedAmountMinor: bigint; authorizedAmountMinor: bigint; capturedAmountMinor: bigint; refundedAmountMinor: bigint; voidedAmountMinor: bigint; reservedRefundAmountMinor: bigint; unresolvedRefundCount: number; authorizationOutcome: string; activeExclusiveOperationId: string | null; version: bigint; createdAt: Date; updatedAt: Date }
   export interface OperationRow { id: string; merchantId: string; paymentId: string; type: string; amountMinor: bigint; currency: 'USD'; status: string; providerOperationId: string | null; feePolicyVersion: number | null; feeEffectAmountMinor: bigint | null; resultCode: string | null; notBefore: Date | null; version: bigint; createdAt: Date; resolvedAt: Date | null }
   export async function findPayment(c: pg.ClientBase, merchantId: string, paymentId: string): Promise<PaymentRow | null>;     // WHERE merchant_id = $1 AND id = $2
   export async function findOperation(c: pg.ClientBase, merchantId: string, operationId: string): Promise<OperationRow | null>; // WHERE merchant_id = $1 AND id = $2
   ```
   Callers run them inside `withTransaction(pool, { merchantId }, ...)` as `fl_api`.
2. `test/integration/db/tenant-isolation.test.ts` — two merchants A and B via `createTestMerchant`, each with a payment, an operation, an idempotency record, and an outbox row (fixtures + `insert_outbox`):
   - for `fl_api` with context A: raw `SELECT` (no predicate) on `identity.merchants`, `identity.merchant_api_credentials`, `payments.payments`, `payments.payment_operations` returns only A rows; with no context → 0 rows on each; with `app.merchant_id = ''` → 0 rows.
   - `findPayment(c, A, paymentOfB)` → null under context A **and** under context B (explicit predicate independent of RLS); `findOperation` likewise.
   - cross-tenant references (owner inserts, each asserting the named FK/trigger): payment A with B's provider account/fee policy/credential; operation of payment A bound to B's account; route A → account B; idempotency record A → payment B (commit-time `idempotency_records_resource_integrity`); DLQ A → payment B; `insert_outbox` with `merchantId` A for payment B (`SUBJECT_NOT_FOUND`); `api.claim_idempotency_key` with context B for merchant A (`TENANT_CONTEXT_MISMATCH`).
   - every other `LOGIN_RUNTIME_ROLES` member (not `fl_api`) `SELECT` on payments/operations/merchants/credentials → `42501` (except `fl_operator_command` on credentials, which is the audited operator grant).
3. `test/integration/db/runtime-role-dml.test.ts` — table-driven: for every role in `LOGIN_RUNTIME_ROLES` × every M2 table (`identity.merchants`, `identity.merchant_api_credentials`, six `providers.*`, `payments.fee_policies`, `payments.payments`, `payments.payment_operations`, `api.idempotency_records`, `messaging.message_types`, `messaging.outbox_messages`, `messaging.inbox_messages`, `messaging.dead_letter_records`, `messaging.dead_letter_replays`) × (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`) → SQLSTATE `42501`, except the explicit allowlist `{fl_operator_command: identity.merchant_api_credentials INSERT, UPDATE}` which is asserted to succeed for a valid issue/revoke. Also: every runtime role `EXECUTE` on `messaging.insert_outbox`, `api.claim_idempotency_key`, `providers.select_route` → `42501`. The test enumerates tables from `information_schema.tables` for schemas `identity, providers, payments, api, messaging` and fails if a table is missing from the matrix (so new tables cannot slip through).

**Expected behavior** — `fl_api` under context A: `UPDATE payments.payments SET version = version + 1 WHERE id = '<A payment>'` → `42501`; `SELECT count(*) FROM payments.payments` → A's count only.

**Acceptance criteria**
- [ ] Cross-tenant reads and references fail through every exposed role, view, and function (docs/10 M2 test 3).
- [ ] Missing `app.merchant_id` sees no merchant data (docs/10 M2 test 4).
- [ ] Runtime roles cannot bypass transition functions with direct DML on payments, operations, idempotency, or messaging tables (docs/10 M2 test 9, test 10 "direct runtime DML cannot forge").
- [ ] The DML matrix fails when any table in the five schemas is absent from it.

**Testing requirements** — the two test files above. Commands: `pnpm vitest run --project integration test/integration/db/tenant-isolation.test.ts test/integration/db/runtime-role-dml.test.ts`.

**Non-goals** — No HTTP routes or `404` mapping (P04). No operator views (P11).

**Handoff checklist**
- [ ] Temporarily granting `UPDATE ON payments.payments TO fl_api` makes the matrix fail.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-T15 — Dev seed and credential issue/revoke commands

**Task ID:** `P02-T15`
**Feature:** Deterministic dev seed data
**Commit:** `feat(cli): add flowledger seed --profile dev and credentials issue/revoke`
**Priority:** High
**Dependencies:** `P02-T13`
**Estimated complexity:** M
**Contract references:** docs/10 M2 bullet 10; docs/05 §Authentication (rotation, revocation, scopes); docs/07 §Identity and authentication, §Provider configuration, §Versioned fee policy; CONVENTIONS §8 (dev data is never a migration), §11
**Files:** create: `apps/cli/src/commands/seed.ts`, `apps/cli/src/commands/credentials.ts`, `test/integration/cli/seed.test.ts`; modify: `apps/cli/src/main.ts`, `packages/config/src/cli.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`

**Objective** — One command that gives a fresh local database two working merchants with fake provider routes, fee policies, and printed synthetic credentials; plus operator commands to issue (rotate) and revoke credentials.

**Implementation instructions**
1. Config additions in `packages/config/src/cli.ts`: `API_CREDENTIAL_PEPPERS` (required by `seed` and `credentials issue`; parsed with `parsePeppers`), `OPERATOR_DATABASE_URL` (required by `credentials`; user must be `fl_operator_command`). Synthetic values in `.env.example`; rows in `docs/CONFIG.md`.
2. `seedCommand(argv, env, out)`: requires `--profile dev`; refuses when `NODE_ENV=production` (exit 1, `seed refused in production`). Connects with `MIGRATION_DATABASE_URL` (owner; direct inserts). One transaction. If `mer_0000000000000000000000DEVA` exists → print `already seeded` and exit 0 without changes or new credentials.
3. Fixed rows (deterministic IDs; all validated by DB checks):
   | Entity | Merchant A | Merchant B |
   | --- | --- | --- |
   | merchant | `mer_0000000000000000000000DEVA`, "Dev Merchant A" | `mer_0000000000000000000000DEVB`, "Dev Merchant B" |
   | provider account `fake-provider`, `SIMULATOR`, ext ref `sim-fake-a`/`sim-fake-b` | `pacc_000000000000000000000FAKEA` | `pacc_000000000000000000000FAKEB` |
   | provider account `unreliable-provider`, `SIMULATOR`, ext ref `sim-rnd-a`/`sim-rnd-b` | `pacc_0000000000000000000000RNDA` | `pacc_0000000000000000000000RNDB` |
   | account version 1 for each | `configuration '{}'`, `capabilities_hash = sha256(convert_to(provider_code,'UTF8'))` | same |
   | provider credential v1 (`ACTIVE`) | `pac_000000000000000000000FAKEA`, `pac_0000000000000000000000RNDA`, `secret_reference 'local-secret://<provider_code>/<merchant id>/v1'` | `pac_..FAKEB`, `pac_..RNDB` |
   | routes (`ACTIVE`, `SIMULATOR`) | `fake-provider` default; `unreliable-provider` non-default | same |
   | fee policy v1 | `fee_0000000000000000000000DEVA`: 290 bp, fixed 30, minimum 50 | `fee_0000000000000000000000DEVB`: 150 bp, fixed 0, minimum 1 |
   Shared webhook endpoints: `pwe_0000000000000000000000FAKE` (`fake-provider`, key `0000000000000000000EPKFAKE`) and `pwe_00000000000000000000000RND` (`unreliable-provider`, key `00000000000000000000EPKRND`), each with secret version 1 `ACTIVE` (`signing_secret_reference 'local-secret://webhook/<provider_code>/v1'`, `verifier_version 'v1'`, `accepted_from = clock_timestamp()`), and endpoint-account rows allowlisting both merchants' accounts of that provider. **[ASSUMPTION]** provider code `unreliable-provider`, placeholder capability hashes, and non-random dev endpoint keys (risk R12).
4. Credentials (random each fresh seed; shown once): A gets one `payments:read,payments:write` and one `payments:read`; B gets one `payments:read,payments:write`; via `generateCredential` + `issueCredential`. Print one line per credential to stdout: `<merchantId>  <credentialId>  <scopes>  <raw credential>` followed by `credentials are synthetic and shown once`. Never written through the logger or to a file.
5. `credentialsCommand(argv, env, out)` (connects with `OPERATOR_DATABASE_URL`):
   - `flowledger credentials issue --merchant <mer_id> --scopes payments:read,payments:write [--expires-at <ISO-8601>]` → prints credential ID and raw credential once.
   - `flowledger credentials revoke --id <mcr_id>` → exit 0 if revoked, exit 1 `not found or already revoked`.
   Rotation = `issue` then `revoke` the old ID (docs/05 intended overlap ≤ 7 days is operational guidance, not enforced).
6. Register both in `apps/cli/src/main.ts`. Root `pnpm db:seed` maps to `flowledger seed --profile dev` (CONVENTIONS §4).

**Expected behavior** — Fresh migrated DB: `pnpm db:seed` prints three credential lines, exit 0; second run prints `already seeded`, exit 0, row counts unchanged.

**Acceptance criteria**
- [ ] Seed creates exactly 2 merchants, 4 provider accounts, 4 account versions, 4 provider credentials, 4 routes (2 default), 2 fee policies, 2 webhook endpoints, 2 secret versions, 4 endpoint-account rows, 3 API credentials.
- [ ] Every printed credential verifies against its stored digest with `verifyCredential` and is found by `lookupCredential` as `fl_api`.
- [ ] `providers.select_route(<A>, 'SIMULATOR', NULL)` returns `pacc_000000000000000000000FAKEA` version 1.
- [ ] Second run is a no-op; production refusal works; no migration file contains dev data.
- [ ] `credentials revoke` makes `lookupCredential` return null for that prefix.

**Testing requirements** — `test/integration/cli/seed.test.ts` (calls `seedCommand`/`credentialsCommand` directly with an env pointing at a `useTestDatabase()` clone and `out` capturing lines): counts above; output line regex `^mer_\S+  mcr_\S+  payments:\S+  fl_test_[0-9A-HJKMNP-TV-Z]{12}_[A-Za-z0-9_-]{43}$`; each printed credential verifies; second run `already seeded`; `NODE_ENV=production` → exit 1 and zero merchants created; `select_route` default for A and B; issue → lookup found → revoke → lookup null → revoke again exit 1; `issue --scopes payments:admin` → exit 1 (DB `merchant_api_credentials_scopes_allowlisted`). Command: `pnpm vitest run --project integration test/integration/cli/seed.test.ts`.

**Non-goals** — No ledger accounts (P03 seed migration), no simulator DB seeding (P06), no merchant webhook endpoints (P09).

**Handoff checklist**
- [ ] `gitleaks` passes (no credential committed; output only at runtime).
- [ ] `.env.example` / `docs/CONFIG.md` updated.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P02-GATE — Persistence-ready verification

**Task ID:** `P02-GATE`
**Feature:** M2 milestone gate (C2 Persistence-ready)
**Commit:** `test(db): add P02 gate acceptance tests, populated fixture, and evidence`
**Priority:** Critical
**Dependencies:** `P02-T01` … `P02-T15`
**Estimated complexity:** M
**Contract references:** docs/10 M2 §Test and acceptance criteria (all ten), §CI and verification lanes ("Forward migration from the previous populated fixture"); docs/09 §PostgreSQL integration tests; README §8.3, §9.2, §11.5
**Files:** create: `test/integration/db/p02-acceptance.test.ts`, `test/integration/db/migrate-forward.test.ts`, `packages/testkit/src/fixtures/populate-p02.ts`, `test/fixtures/db/generate-p02.mjs`, `test/fixtures/db/P02.sql`, `docs/evidence/P02.md`; modify: `packages/testkit/src/index.ts`; must not touch: `migrations/**`, `packages/database/src/**`, `apps/**` (no feature code)

**Objective** — Prove the M2 exit gate end to end, commit the populated fixture later phases migrate forward from, and record evidence.

**Implementation instructions**
1. `packages/testkit/src/fixtures/populate-p02.ts` — `populateP02(ownerPool)`: two `createTestMerchant` merchants; per merchant one `NOT_REQUESTED` payment (version 1) with a `CREATE_PAYMENT` idempotency record and a `payment.created.v1` outbox row, and one payment with a `REQUESTED` `AUTHORIZE` operation, pointer set, version 2, an `AUTHORIZE` idempotency record, and `payment.authorization.requested.v1` + `payment.operation.execute.v1` outbox rows (outbox via `insert_outbox` as `payments_function_owner`); one inbox row and one DLQ row with one replay (owner fixture inserts). **No terminal operations** (so P06's evidence FK validates; risk R8).
2. `test/fixtures/db/generate-p02.mjs` (run after `pnpm build`: `node test/fixtures/db/generate-p02.mjs`): starts `postgres:17` via `@testcontainers/postgresql`, bootstraps, migrates, sets role passwords, runs `populateP02`, then `container.exec(['pg_dump','-U',<admin>,'--no-comments','fl_p02'])` and writes `test/fixtures/db/P02.sql`. Commit the dump.
3. `test/integration/db/migrate-forward.test.ts`: `createEmptyDatabase()` → restore `P02.sql` via `psql` executed inside the container as the admin user → `migrate({ connectionString })` → assert `applied: []` (in P02; later phases assert their own files apply), checksums accepted, and every payment satisfies the consistency rules (`UPDATE` nothing; run one owner transaction touching each payment with `SET CONSTRAINTS ALL IMMEDIATE` and a no-op version bump that rolls back). Header comment instructs P03+ to keep this file and add their own `<phase>.sql`.
4. `test/integration/db/p02-acceptance.test.ts` (cross-task scenarios):
   - empty DB: `createEmptyDatabase()` + `migrateCommand(['--bootstrap'])`-equivalent path → all ten migrations `0200`–`0290` applied in order; second run applies none.
   - atomic primitive composition: as `payments_function_owner` with `app.merchant_id` set, in one transaction: `api.claim_idempotency_key` (OWNER) → insert payment → `messaging.insert_outbox(payment.created.v1)` → commit → all three rows exist; repeat with a new key and force failure after the outbox insert (`SELECT 1/0`) → none of the three rows exist (docs/09 "failure injected ... leaves no partial business effect").
   - replay after commit: second claim for the committed key → `REPLAY` with stored body.
   - re-run the M2 headline cases by importing nothing new: execute the existing suites in CI (`pnpm test:integration`).
5. `docs/evidence/P02.md`: commit SHA; commands run and summaries (`pnpm check`, `pnpm test:integration`, `pnpm db:up && pnpm db:migrate && pnpm db:seed` against Docker Compose, second `pnpm db:migrate` output `0 applied`); a table mapping each docs/10 M2 test criterion to `file :: case` from the traceability table below, each marked pass.

**Expected behavior** — Fresh clone: `pnpm db:up && pnpm db:migrate && pnpm db:seed` succeeds; `pnpm test:integration` green including the forward-migration test.

**Acceptance criteria**
- [ ] All ten docs/10 M2 test criteria map to passing tests listed in `docs/evidence/P02.md`.
- [ ] `test/fixtures/db/P02.sql` restores and migrates forward with zero errors.
- [ ] Composition test proves claim + payment + outbox commit or roll back together.
- [ ] No feature code changed in this commit.

**Testing requirements** — `pnpm vitest run --project integration test/integration/db/p02-acceptance.test.ts test/integration/db/migrate-forward.test.ts`; then full `pnpm test:integration` and `pnpm check`.

**Non-goals** — No ledger, API, relay, or provider work.

**Handoff checklist**
- [ ] Evidence note committed with real command output summaries.
- [ ] CI green on the gate commit.

---

## Parallelization

| Group | Tasks | Can run concurrently with | Shared files / conflicts |
| --- | --- | --- | --- |
| A | P02-T01 | P02-T04 | — |
| B | P02-T02, P02-T03 | each other (after T01) | both edit `packages/database/src/index.ts` / `packages/testkit/src/index.ts` (trivial export merges) |
| C | P02-T04 | T01–T03 | `packages/domain/src/ids.ts` (P01-owned file; append only) |
| D (serial) | P02-T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 | nothing else that adds a migration | `migrations/` single-owner within P02 (README §5.4); runner rejects out-of-order files; `packages/testkit/src/fixtures/payments.ts` edited by T08, T09, T11 in order |
| E | P02-T14, P02-T15 | each other (after T13) | `packages/database/src/index.ts` (export merge); T15 edits `apps/cli/src/main.ts` and `packages/config/src/cli.ts` (also edited by T01 — already merged) |
| F | P02-GATE | — | last |

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M2 F1 — schemas, extensions, owner/runtime roles, prefixed-ID validation, timestamp/hash helpers | P02-T03 | `test/integration/db/foundation.test.ts` :: role attributes; schemas; `fl_is_id` table; `fl_is_sha256` |
| docs/10 M2 F2 — merchant identities, credential digests, scopes, activation, expiry, rotation, revocation | P02-T04, P02-T05, P02-T15 | `packages/domain/src/credentials.test.ts` :: golden vector, rotation; `test/integration/db/identity.test.ts` :: expiry, revocation one-way, rotation; `test/integration/cli/seed.test.ts` :: issue→revoke |
| docs/10 M2 F3 — provider accounts, immutable versions, credential refs, webhook endpoints, endpoint-account allowlists | P02-T06 | `test/integration/db/providers.test.ts` :: constraint negatives, trigger negatives |
| docs/10 M2 F4 — one active route per code/env, one default, deterministic selection and version snapshot | P02-T06 | `providers.test.ts` :: `select_route` cases; rollover race |
| docs/10 M2 F5 — append-only fee-policy versions | P02-T07 | `test/integration/db/fee-policies.test.ts` :: immutability, monotonic version |
| docs/10 M2 F6 — payments/operations, composite keys, reservation fields, exclusive partial unique index, deferred trigger | P02-T08, P02-T09, P02-T10 | `payments.test.ts`; `payment-operations.test.ts` :: exclusive pairs, three refunds; `payment-consistency.test.ts` |
| docs/10 M2 F7 — idempotency ownership, replay data, tombstones, result-resource integrity | P02-T11 | `test/integration/db/idempotency.test.ts` |
| docs/10 M2 F8 — outbox/inbox/DLQ/replay persistence, envelope derivation, protected outbox insertion | P02-T12, P02-T13 | `messaging-tables.test.ts`; `insert-outbox.test.ts` |
| docs/10 M2 F9 — RLS and explicit merchant-scoped views/repository queries | P02-T05…T13 (policies), P02-T14 | `test/integration/db/tenant-isolation.test.ts` |
| docs/10 M2 F10 — deterministic seed: two merchants, fake providers, fee policies, test credentials | P02-T15 | `test/integration/cli/seed.test.ts` :: counts, verify printed credentials |
| docs/10 M2 T1 — migrations apply from empty DB and previous fixture | P02-T01, P02-GATE | `migrate-runner.test.ts`; `p02-acceptance.test.ts` :: empty DB; `migrate-forward.test.ts` |
| docs/10 M2 T2 — invalid IDs, currencies, amounts, statuses, provider/config bindings fail at DB | P02-T05…T13 | each table test :: constraint negatives + `assertConstraintCoverage` |
| docs/10 M2 T3 — cross-tenant reads/references fail via every role/view/function | P02-T14 | `tenant-isolation.test.ts` :: cross-tenant reads, references |
| docs/10 M2 T4 — missing `app.merchant_id` sees no merchant data | P02-T05, P02-T14 | `identity.test.ts` :: no context; `tenant-isolation.test.ts` :: no context / empty context |
| docs/10 M2 T5 — payment binding columns immutable | P02-T08 | `payments.test.ts` :: immutability per column |
| docs/10 M2 T6 — deferred constraints reject pointer mismatch and reservation drift | P02-T10 | `payment-consistency.test.ts` :: pointer cases, reservation cases |
| docs/10 M2 T7 — 100 concurrent claims elect one owner | P02-T11 | `idempotency.test.ts` :: concurrency (identical) |
| docs/10 M2 T8 — same key + changed hash deterministically conflicts | P02-T11 | `idempotency.test.ts` :: concurrency (divergent) |
| docs/10 M2 T9 — runtime roles cannot bypass transition functions | P02-T08, P02-T09, P02-T14 | `runtime-role-dml.test.ts` :: matrix |
| docs/10 M2 T10 — invalid envelopes cannot enter outbox; runtime DML cannot forge outbox/inbox/DLQ | P02-T12, P02-T13, P02-T14 | `insert-outbox.test.ts` :: negatives; `messaging-tables.test.ts` :: guard + derivation; `runtime-role-dml.test.ts` |
| docs/07 §IDs — table-specific prefixed-ID checks | P02-T05…T11 | constraint negatives `*_id_format` |
| docs/07 §Common types — USD-only, 32-byte hashes, jsonb object checks, FK supporting indexes | P02-T05…T13 | constraint negatives; `assertConstraintCoverage` |
| docs/07 §credentials — HMAC-SHA-256 full-credential digest, versioned pepper, constant-time compare | P02-T04 | `credentials.test.ts` :: golden vector, timingSafeEqual path |
| docs/07 §credentials — digest/ownership/created_at immutable; status/revoked_at consistency | P02-T05 | `identity.test.ts` :: trigger negatives |
| docs/07 §merchant_routes — never falls back to another account; `PROVIDER_ROUTE_UNAVAILABLE` | P02-T06 | `providers.test.ts` :: disabled route/account |
| docs/07 §fee_policies — `minimum_capture_amount_minor >= GREATEST(fixed,1)`; supersede once | P02-T07 | `fee-policies.test.ts` :: boundary |
| D-07 fee never exceeds gross for any gross ≥ minimum | P02-T07 | `fee-policies.test.ts` :: rejects bp 5000 / fixed 30 / minimum 30; accepts bp 5000 / fixed 15 / minimum 30 |
| docs/07 §payments — all row checks incl. `refunded + reserved <= captured`, `(reserved=0)=(count=0)` | P02-T08 | `payments.test.ts` :: boundary pairs |
| docs/03 §Exclusion rules 2–3 — exclusive and refund never both unresolved | P02-T08 | `payments.test.ts` :: `payments_exclusive_excludes_refunds` |
| docs/07 §payment_operations — refund fee null until terminal, nonnull only on success, immutable after | P02-T09 | `payment-operations.test.ts` :: fee effect cases |
| docs/07 §payment_operations — no index limits refunds (ADR-0003) | P02-T09 | `payment-operations.test.ts` :: three unresolved refunds |
| docs/07 §Schema acceptance — one payment cannot commit two successful captures; multiple refunds allowed | P02-T09, P02-T10 | `payment-operations.test.ts` :: second succeeded CAPTURE; `payment-consistency.test.ts` :: two succeeded refunds commit |
| docs/07 §Schema acceptance — direct desync of reservation fields fails at commit | P02-T10 | `payment-consistency.test.ts` :: reservation cases |
| docs/07 §deferred trigger — disabling restricted to migration owner | P02-T10 | `payment-consistency.test.ts` :: privilege |
| docs/07 §API idempotency — claim via `ON CONFLICT DO NOTHING`; bounded wait → `IDEMPOTENCY_REQUEST_IN_PROGRESS` | P02-T11 | `idempotency.test.ts` :: in-progress |
| docs/05 §Retention / ADR-0009 — tombstone returns `IDEMPOTENCY_KEY_EXPIRED`, never re-executes | P02-T11 | `idempotency.test.ts` :: expired, tombstone |
| docs/05 §Scope — same key isolated per merchant and command type | P02-T11 | `idempotency.test.ts` :: scope |
| docs/07 §outbox — derived columns equal envelope fields; immutable identity | P02-T12, P02-T13 | `messaging-tables.test.ts` :: derivation 12 cases; `insert-outbox.test.ts` :: positive column equality |
| docs/07 §outbox — rejects unregistered type/version, `.vN` = schemaVersion, payment/ledger/webhook aggregate+ordering rules | P02-T13 | `insert-outbox.test.ts` :: negatives |
| schemas/README §semantic validator — settlement ordering/version/posting key; execute version | P02-T13 | `insert-outbox.test.ts` :: settlement, execute negatives |
| docs/07 §inbox — insert-only; `(consumer_name, envelope_id)` PK | P02-T12 | `messaging-tables.test.ts` :: inbox |
| docs/07 §DLQ — unique per consumer/envelope; tenant-safe subjects; replay append-only | P02-T12 | `messaging-tables.test.ts` :: DLQ, replays |
| docs/07 §Tenant isolation 3–5 — `SET LOCAL app.merchant_id`; explicit predicates | P02-T02, P02-T14 | `tx.test.ts` :: context; `tenant-isolation.test.ts` :: `findPayment` |
| ADR-0007 — `SECURITY DEFINER`, fixed `search_path`, PUBLIC no execute | P02-T03, P02-T13 | `foundation.test.ts` :: default privileges; `insert-outbox.test.ts` :: prosecdef/proconfig |
| docs/09 §PostgreSQL integration — every FK/unique/partial unique/check rejects invalid direct write | P02-T05…T13 | `assertConstraintCoverage` in every table test |
| docs/09 §PostgreSQL integration — failure after each statement leaves no partial effect | P02-T02, P02-GATE | `tx.test.ts` :: rollback; `p02-acceptance.test.ts` :: composition failure |
| docs/09 §PostgreSQL integration — 100 concurrent identical commands → one result (DB primitive) | P02-T11 | `idempotency.test.ts` :: concurrency (full HTTP path in P04/P05) |
| docs/09 §PostgreSQL integration — exclusive command and refund cannot both be unresolved | P02-T08, P02-T09 | `payments.test.ts`; `payment-operations.test.ts` |
| docs/09 §PostgreSQL integration — fee policy fixed > minimum cannot be inserted | P02-T07 | `fee-policies.test.ts` |
| docs/09 §PostgreSQL integration — migrations upgrade a populated previous schema | P02-GATE | `migrate-forward.test.ts` |
| docs/08 §Required failure-injection (API and outbox) — partial acceptance never visible | P02-GATE (primitive level; full in P04/P05) | `p02-acceptance.test.ts` :: composition failure |
| docs/08 §DLQ contract — record retains envelope, consumer, subscription, times, attempts, class, redacted detail, subject IDs, correlation/trace | P02-T12 | `messaging-tables.test.ts` :: DLQ columns |

## Phase risks / open questions

| ID | Risk / conflict | Impact | Severity | Recommended resolution (followed by tasks) | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R1 | Prefixes `mcr_`, `pac_`, `pwe_`, `fee_`, `pev_` are defined by docs/07 (lines 132, 218, 240, 290, 707) but absent from `schemas/common/entity-ids.v1.schema.json`; CONVENTIONS §6 (line 145) says stop if absent | Agents may block on T04/T05 | Medium | Treat docs/07 as the authority for DB-only IDs never on the wire; add branded types in `ids.ts` (T04). Follow-up contract commit adds them to entity-ids. | P02-T04, T05, T06, T07, T09 |
| R2 | `merchant.webhook.deliver.v1` orderingKey: docs/04:79, schemas/README:86, docs/01:237 say "no orderingKey"; `schemas/commands/merchant-webhook-deliver.v1.schema.json:14` sets it to the endpoint ID, envelope schema requires it (line 18), docs/07:1067/1090 say endpoint ID | Contradictory DB check | Medium | Machine schema + docs/07 win: envelope carries `orderingKey = data.endpointId`; "no ordering key" means the relay publishes without a Pub/Sub ordering key (P05/P09). T13 enforces equality. Contract prose fix recommended. | P02-T13 |
| R3 | No identity/api function-owner role in CONVENTIONS §7 | Pre-tenant credential lookup and claim ownership need a home | Low | Credential lookup via RLS + transaction-local GUC `app.credential_key_prefix`; issuance/revocation via column-limited grants to `fl_operator_command`; claim function owned by `payments_function_owner`. | P02-T05, T11 |
| R4 | docs/07:150 says "a trigger rejects unknown scopes"; T05 uses a CHECK | Mechanism differs | Low | CHECK is the native equivalent with identical semantics. | P02-T05 |
| R5 | docs/07:1452 and docs/10:205 require `pgcrypto` | Resolved | Low | Created in 0200 (needed by P03 and P11 operator-token HMAC, D-03); P02 code still uses only built-ins | P02-T03 |
| R6 | `envelope_hash` canonicalization unspecified | Inbox (P05) could hash differently | Medium | `sha256(convert_to(envelope::text,'UTF8'))` of the stored `jsonb`; P05 inbox insertion computes it DB-side the same way. | P05 inbox task |
| R7 | Registry is a JSON file; DB needs it | Drift between registry and DB | Medium | Migration-seeded `messaging.message_types` + parity test (T12); any registry change requires a migration in the same PR. | P02-T12 |
| R8 | P06 adds the deferrable `resolution_evidence_id` FK; terminal fixture rows with synthetic `pev_` IDs would fail validation | Forward-migration test breaks in P06 | Medium | `P02.sql` contains no terminal operations; P06 must keep that or add the FK `NOT VALID` then `VALIDATE`. | P06 evidence FK task |
| R9 | Guard triggers require `version = OLD.version + 1` on every UPDATE | A protected function updating a row twice in one transaction fails | Low | Documented interface rule: one UPDATE per row per transition. | P04–P08 function tasks |
| R10 | DLQ tenant-safe FKs (docs/07) reject rows whose subject IDs do not resolve | DLQ insertion could fail for malformed messages | Medium | P05 consumer sets `payment_id`/`operation_id` only after verifying they resolve; otherwise null. | P05 DLQ task |
| R11 | Internal invariant codes (`INVALID_ENVELOPE`, `IMMUTABLE_*`, `INVALID_TRANSITION`, `TENANT_CONTEXT_MISMATCH`) are not docs/05 problem codes | API mapping ambiguity | Low | `DomainError` carries them; `problem-map.ts` (P04) maps all internal codes to `500 INTERNAL_ERROR`. | P04 problem-map task |
| R12 | Seed assumes provider code `unreliable-provider`, placeholder `capabilities_hash`, fixed endpoint keys | P06 may choose other names/hashes | Low | P06 inserts version 2 with real capability hashes or adjusts seed; dev data only. | P06 |
| R13 | Database `CONNECT` stays granted to `PUBLIC` | Minor hardening gap | Low | Object-level privileges are the boundary; P13 can revoke at instance level. | — |
| R14 | README §8.3 says one container per Vitest worker; T01 uses one container per run + template clone per file | Divergence from README text | Low | Equivalent isolation, faster. Update README §8.3 wording at gate. | — |
| R15 | `insert_outbox` invoker validation relies on the EXECUTE ACL, not `session_user` | Weaker than "validates the invoker role" if grants widen | Low | Runtime-role EXECUTE is tested denied (T13/T14); a phase granting a runtime role must add a `session_user` allowlist check. | P05/P09 grant tasks |
| R16 | DLQ `failure_class` values unnamed in contracts | Divergent names | Low | `SCHEMA_INVALID`, `INVARIANT_VIOLATION`, `UNSUPPORTED_VERSION`, `RETRY_EXHAUSTED`. | P05 |
| R17 | CLI uses `MIGRATION_DATABASE_URL` / `OPERATOR_DATABASE_URL` while CONVENTIONS §7 (line 185) says each app uses `DATABASE_URL` | Naming divergence for the multi-role CLI | Low | Keep per-role variables for the CLI only; document in `docs/CONFIG.md`. | — |
| R18 | `api.claim_idempotency_key` needs the full replay response before the payment/operation insert | P04/P05 must build the response body inside the creating transaction before claiming | Medium | Response fields are derivable from app-generated IDs and transaction time; P04 builds the body in `create_payment` using `now()` for `created_at`. | P04 create_payment task |
| R19 | `committed_at` is the claim time, not literal commit time | Replay window off by transaction duration | Low | Accept (sub-second); document. | — |
