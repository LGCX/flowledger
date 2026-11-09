# P00 — Repository and verification foundation

## Phase overview

**Goal.** Turn the contracts-only repository into a pnpm/TypeScript workspace in which every application entry point exists (inert), local dependencies run under Docker Compose, and CI proves on every pull request that the OpenAPI document, every JSON Schema, the message registry, the generated TypeScript types, the documented message catalog, and the prohibited-data policy agree with each other. Milestone M0 in `docs/10-IMPLEMENTATION_PLAN.md` §M0.

**Entry criteria.** Contracts present (`README.md`, `docs/00`–`docs/10`, `docs/adr/*`, `openapi/openapi.yaml`, `schemas/**`). No code exists. No earlier phase gate.

**Exit gate (docs/10 §M0 "Clean clone passes static and contract checks").** From a fresh `git clone`, `corepack enable && pnpm install --frozen-lockfile && pnpm check` exits 0; `pnpm test:integration` exits 0 with Docker available; CI runs a separate fast job and integration job; the contract job demonstrably fails on a malformed schema, an unknown message field, and an invalid OpenAPI example; every app starts in test mode with only `infra/docker/.env.example` values.

**Planning verification already done (so implementers do not rediscover it).** During planning the contracts were checked with `ajv@8.20.0`, `ajv-formats@3.0.1`, `@apidevtools/swagger-parser@13.1.0`:
- `new Ajv2020({ strict: true })` **fails** on the checked-in schemas (`strictTypes` on `allOf` branches without `type`, `strictRequired` on conditional `required`). The contract only requires *unknown keywords* to be configuration errors (`schemas/README.md:21-31`). The binding Ajv configuration is therefore `{ strictSchema: true, strictTypes: false, strictRequired: false, strictTuples: true, allowUnionTypes: true, allErrors: true, verbose: false }` plus `ajv-formats` — all schemas compile with it.
- `SwaggerParser.validate('openapi/openapi.yaml')` passes. The only `x-` keyword inside `components.schemas` is `x-flowledger-http-status-must-equal-body-status`.
- Both JSON examples in `docs/04-EVENT_CONTRACTS.md` (lines 33 and 191) validate against their registered schemas.
- Of the nine JSON examples in `docs/05-API_AND_IDEMPOTENCY_CONTRACT.md`, eight validate; the timeline example (line 314) fails **only** with `must have required property 'truncated'` (risk R-02).

### Interfaces consumed from earlier phases
None.

### Interfaces provided to later phases
| Interface | Path | Shape |
| --- | --- | --- |
| Workspace/package resolution | `package.json` `exports` with condition `@flowledger/source` → `src/index.ts`, `default` → `dist/index.js` | every `@flowledger/*` package/app |
| Base config + lifecycle | `packages/config/src/base.ts`, `packages/config/src/lifecycle.ts` | `parseBaseConfig(env): BaseConfig`; `runMain(start: StartFn): void`; `type StartFn = (env: Env) => Promise<RunningApp>`; `interface RunningApp { stop(): Promise<void> }`; `startHealthServer(port: number, isReady: () => boolean): Promise<HealthServer>` |
| App start functions | `apps/<app>/src/main.ts` | `export const start: StartFn` (each app) |
| Message validation | `packages/contracts/src/validate.ts` | `validateMessage(input: unknown): MessageValidationResult`; `validateMerchantWebhookPayload(input: unknown): PayloadValidationResult` |
| Envelope builder | `packages/contracts/src/envelope.ts` (P00-T11) | `buildEnvelope(input: EnvelopeInput): RegisteredEnvelope` — runs `validateMessage` (schema + semantic) and throws `EnvelopeValidationError { issues }` on failure; CONVENTIONS §9 |
| Semantic correlation validator | `packages/contracts/src/semantic.ts` | `checkSemantics(envelope): SemanticViolation[]`; `checkMerchantWebhookSemantics(payload): SemanticViolation[]`; `contiguityApplies(kind, type): boolean`; `assertContiguityApplicable(kind, type): void` |
| Ajv factory | `packages/contracts/src/ajv.ts` | `createAjv(): Ajv2020` (binding options above) |
| Generated contract artifacts | `packages/contracts/src/generated/{schemas,openapi-components,messages,openapi}.ts` | JSON Schema objects, registry, OpenAPI `$defs` wrapper, TS types |
| Prohibited-data fixtures | `packages/testkit/src/prohibited-data.ts` | `PROHIBITED_FIXTURES`, `findProhibitedData(text): ProhibitedFinding[]` |
| PostgreSQL 17 test fixture | `packages/testkit/src/postgres.ts` | `startPostgres(): Promise<StartedPostgres>` |
| Compose stack | `infra/docker/compose.yaml`, `infra/docker/postgres-init/10-simulator-db.sh` | `pnpm db:up`, `pnpm db:down` |
| Commands | root `package.json` | see P00-T01/T06/T07/T14 |

**Command inventory (CONVENTIONS §4) and where each is created.** docs/10 §M0 requires `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, `test:contracts`, `test:performance` now.

| Command | Created in | Status after P00 |
| --- | --- | --- |
| `lint`, `format`, `typecheck`, `build`, `test:unit`, `test:contracts`, `test:integration`, `test:e2e` | P00-T01 | implemented |
| `contracts:generate`, `contracts:check` | P00-T07 | implemented |
| `check` | P00-T01 (partial), completed P00-T07 | implemented |
| `db:up`, `db:down` | P00-T06 | implemented |
| `test:performance` | P00-T14 | required now by docs/10 §M0, implemented in P12 → stub prints `test:performance: not implemented until P12` and exits 0 |
| `test:chaos` | **deferred** — created by the first task that adds a file under `test/chaos/` (expected P05 relay/consumer crash tests). The `chaos` Vitest project is defined in P00-T01 so that task only adds the script. | absent |
| `db:migrate`, `db:seed` | **deferred to P02** (migration runner P02-T01; seed P02) | absent |
| `verify:ledger` | **deferred to P03** (`flowledger verify`) | absent |

---

### P00-T01 — Workspace, toolchain pins, project references, and test projects

**Task ID:** `P00-T01`
**Feature:** Repository foundation
**Commit:** `chore(repo): initialize pnpm workspace, TypeScript project references, and vitest projects`
**Priority:** Critical
**Dependencies:** none
**Estimated complexity:** M
**Contract references:** docs/10 §Fixed implementation choices, §Repository shape, §M0; CONVENTIONS §2, §3, §4, §13
**Files:** create: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.nvmrc`, `.npmrc`, `.gitignore`, `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `tsconfig.base.json`, `tsconfig.json`, `test/tsconfig.json`, `vitest.config.ts`, `docs/VERSIONS.md`, `packages/{config,contracts,domain,database,messaging,providers,observability,testkit}/{package.json,tsconfig.json,src/index.ts}`; modify: none; must not touch: `docs/0*`, `docs/adr/**`, `openapi/**`, `schemas/**`, `README.md`

**Objective** — Create the pnpm workspace skeleton every later task builds on, with exact pins, strict TypeScript, and the five Vitest projects, so that `pnpm check` (partial) is green on an otherwise empty repository.

**Implementation instructions**
1. `.nvmrc`: the exact Node 24 LTS version chosen (e.g. `24.11.0`). Choose the newest 24.x patch released at least 14 days before implementation.
2. Root `package.json`:
   - `"name": "flowledger"`, `"private": true`, `"type": "module"`, `"packageManager": "pnpm@10.<x>.<y>"` (exact), `"engines": { "node": "24.<x>.<y>" }` matching `.nvmrc` exactly.
   - devDependencies, **exact versions, no `^`/`~`**: `typescript` (5.x), `@types/node` (24.x), `vitest` (≥ 3.2 — needs `test.projects`), `eslint` (9.x), `@eslint/js` (same major as eslint), `typescript-eslint` (8.x), `prettier` (3.x). `typescript`, `@types/node`, `@eslint/js` are not on the CONVENTIONS §2 approved list; justify them in the commit body ("compiler, Node typings, ESLint core recommended config — no approved package provides them").
   - scripts (exactly):
     ```json
     {
       "lint": "eslint . && prettier --check .",
       "format": "prettier --write .",
       "typecheck": "tsc -b",
       "build": "tsc -b",
       "test:unit": "vitest run --project unit",
       "test:contracts": "vitest run --project contracts",
       "test:integration": "vitest run --project integration",
       "test:e2e": "vitest run --project e2e",
       "check": "pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:contracts"
     }
     ```
     (`contracts:check` is inserted into `check` by P00-T07; do not add it here.)
3. `.npmrc`: `save-exact=true`, `engine-strict=true`, `auto-install-peers=false`, `strict-peer-dependencies=true`.
4. `pnpm-workspace.yaml`: `packages: ['apps/*', 'packages/*']`.
5. `tsconfig.base.json` compilerOptions: `"target": "ES2023"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"verbatimModuleSyntax": true`, `"isolatedModules": true`, `"declaration": true`, `"declarationMap": true`, `"sourceMap": true`, `"composite": true`, `"customConditions": ["@flowledger/source"]`, `"skipLibCheck": true`, `"types": ["node"]`. Relative imports use `.js` extensions (NodeNext rule).
6. Each package `packages/<dir>/package.json`: `"name": "@flowledger/<dir>"`, `"private": true`, `"type": "module"`, `"exports": { ".": { "@flowledger/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`. `tsconfig.json` extends `../../tsconfig.base.json` with `"rootDir": "src"`, `"outDir": "dist"`, `"include": ["src"]`, `"exclude": ["src/**/*.test.ts"]`. `src/index.ts` contains only `export {};`.
7. Root `tsconfig.json`: `{ "files": [], "references": [ { "path": "packages/config" }, … all eight packages …, { "path": "test" } ] }`. Apps are appended by P00-T04/T05.
8. `test/tsconfig.json`: extends base with `"composite": true`, `"emitDeclarationOnly": true`, `"outDir": "../node_modules/.cache/tsc-test"` (so `tsc -b` type-checks tests without emitting into the tree), `"rootDir": ".."`, `"include": ["**/*.ts", "../packages/*/src/**/*.test.ts", "../apps/*/src/**/*.test.ts"]` (co-located unit tests are excluded from their package's emit build, so this project is what type-checks them — including `@ts-expect-error` type tests), references to all eight packages.
9. `vitest.config.ts` (single source of the five projects, CONVENTIONS §4):
   ```ts
   import { defineConfig } from 'vitest/config';
   const shared = { resolve: { conditions: ['@flowledger/source'] } };
   export default defineConfig({
     test: {
       passWithNoTests: true, // [ASSUMPTION] see R-07; P00-GATE asserts unit/contracts/integration each run ≥1 file
       projects: [
         { ...shared, test: { name: 'unit', include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'] } },
         { ...shared, test: { name: 'contracts', include: ['test/contract/**/*.test.ts'] } },
         { ...shared, test: { name: 'integration', include: ['test/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 } },
         { ...shared, test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 300_000, hookTimeout: 300_000 } },
         { ...shared, test: { name: 'chaos', include: ['test/chaos/**/*.test.ts'], testTimeout: 300_000, hookTimeout: 300_000 } },
       ],
     },
   });
   ```
10. `eslint.config.js` (flat config, ESM): ignores `**/dist/**`, `**/node_modules/**`, `packages/contracts/src/generated/**`, `coverage/**`, `reports/**`; `@eslint/js` recommended + `typescript-eslint` `recommended` for `**/*.ts`. Policy rules come in P00-T02.
11. `.prettierrc.json`: `{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }`. `.prettierignore`: `pnpm-lock.yaml`, `**/dist`, `reports`, `coverage`, `docs/0*.md`, `docs/adr`, `openapi/openapi.yaml`, `schemas`, `README.md` (contract files are never reformatted).
12. `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `reports/`, `*.tsbuildinfo`, `.env`, `infra/docker/.env`, `.DS_Store`.
13. `docs/VERSIONS.md`: a table `| Tool | Pinned version | Where pinned |` with rows Node.js (`.nvmrc`, `engines`), pnpm (`packageManager`), TypeScript, PostgreSQL `17` (image tag, see P00-T06), Docker Engine minimum `24.0`, Docker Compose `v2.20+`, Terraform `1.9+` ("first used in P13"), k6 `0.5x+` ("first used in P12"), plus every devDependency with its exact version. State the rule: "updated in the same commit as any version bump".
14. Run `pnpm install` to produce `pnpm-lock.yaml`; commit it.

**Expected behavior**
- `pnpm install --frozen-lockfile` on a clean clone succeeds.
- `pnpm typecheck` builds all eight empty packages.
- `pnpm test:unit` prints "No test files found, exiting with code 0".
- `pnpm check` exits 0.

**Acceptance criteria**
- [ ] Every dependency spec in every `package.json` is an exact version (`^\d+\.\d+\.\d+$`) or `workspace:*`.
- [ ] `packageManager`, `engines.node`, `.nvmrc` agree and are recorded in `docs/VERSIONS.md`.
- [ ] `tsc -b` succeeds with the strict flags listed in step 5.
- [ ] `vitest.config.ts` defines exactly the projects `unit`, `contracts`, `integration`, `e2e`, `chaos` with the globs from CONVENTIONS §4.
- [ ] `pnpm check` exits 0; `pnpm lint` does not touch contract files.

**Testing requirements** — No test files in this task (nothing to test yet). Run: `pnpm install --frozen-lockfile && pnpm check && pnpm test:integration && pnpm test:e2e` — all exit 0.

**Non-goals** — No ESLint policy rules (P00-T02); no apps (P00-T04/T05); no runtime dependencies; no `test:chaos`, `test:performance`, `db:*`, `contracts:*` scripts.

**Handoff checklist**
- [ ] `pnpm-lock.yaml` committed.
- [ ] `docs/VERSIONS.md` lists every pinned tool and devDependency.
- [ ] Commit body contains `Task: P00-T01` and the justification for `typescript`, `@types/node`, `@eslint/js`.

---

### P00-T02 — ESLint policy rules and dependency-policy check

**Task ID:** `P00-T02`
**Feature:** Static policy enforcement
**Commit:** `chore(repo): enforce package boundaries, money and ledger-DML lint rules, and dependency policy`
**Priority:** Critical
**Dependencies:** P00-T01
**Estimated complexity:** M
**Contract references:** CONVENTIONS §2 (approved deps, exact pins), §3 (dependency direction), §5, §16 (simulator ground-truth variable); docs/09 §Static checks (line 85: "Lint rules forbid JavaScript `number` in money-domain types and direct journal-table writes outside the ledger repository"); docs/10 §CI lanes "dependency-policy check"
**Files:** create: `test/contract/lint-rules.test.ts`, `test/contract/dependency-policy.test.ts`, `test/contract/approved-dependencies.json`; modify: `eslint.config.js`; must not touch: contract files, `vitest.config.ts`

**Objective** — Make architectural rules machine-checked: package import direction, no package importing from `apps/`, no reading of simulator ground-truth connection strings outside the harness, no JavaScript `number` arithmetic in the money/fee modules, no literal ledger DML in application code, and only pinned, approved dependencies.

**Implementation instructions**
1. In `eslint.config.js` add one config object per package with `rules: { 'no-restricted-imports': ['error', { patterns: [...] }] }` scoped by `files: ['packages/<dir>/src/**/*.ts']`, forbidding exactly the internal packages not allowed by CONVENTIONS §3:
   | Package | Forbidden `@flowledger/*` imports |
   | --- | --- |
   | `domain` | all other `@flowledger/*` |
   | `contracts` | all other `@flowledger/*` |
   | `config` | all other `@flowledger/*` |
   | `observability` | all other `@flowledger/*` |
   | `database` | `messaging`, `providers`, `testkit`, `app-*` |
   | `messaging` | `domain`, `providers`, `testkit`, `app-*` |
   | `providers` | `database`, `messaging`, `testkit`, `app-*` |
   | `testkit` | `app-*` |
   Additionally, for every `packages/**` file forbid patterns `@flowledger/app-*` and `**/apps/**` (relative escape into apps).
2. Simulator ground-truth restriction (CONVENTIONS §16, coordinator update): for `files: ['**/*.ts']` with `ignores: ['packages/testkit/**', 'apps/cli/**', 'test/**']` add `no-restricted-syntax` entries:
   - `{ selector: "MemberExpression[property.name='SIMULATOR_DATABASE_URL']", message: 'Simulator ground truth is harness-only (CONVENTIONS §16).' }`
   - `{ selector: "Literal[value='SIMULATOR_DATABASE_URL']", message: … }` (covers `env['SIMULATOR_DATABASE_URL']`).
   And for `files: ['**/*.ts']` with `ignores: ['apps/provider-simulator/**', 'packages/testkit/**', 'test/**']` the same two selectors for `PROVIDER_SIMULATOR_DATABASE_URL` **[ASSUMPTION A-03]** (the simulator service's own owner-role connection string; see R-06).
3. Money rule (docs/09:85, narrowed — see R-05): for `files: ['packages/domain/src/money.ts', 'packages/domain/src/fees.ts']` add `no-restricted-syntax` selectors `TSNumberKeyword`, `CallExpression[callee.name='Number']`, `CallExpression[callee.name='parseInt']`, `CallExpression[callee.name='parseFloat']`, `MemberExpression[object.name='Math']`, `Literal[raw=/^\\d*\\.\\d/]` (decimal number literals; string literals start with a quote and never match), each with message `Money code uses bigint only (docs/02 §Money representation).` The files do not exist yet; the rule activates when P01 creates them.
4. Ledger-DML rule (docs/09:85): for `files: ['apps/**/*.ts', 'packages/**/*.ts']` with `ignores: ['packages/testkit/**']` add `no-restricted-syntax` selectors
   `Literal[value=/\\b(insert\\s+into|update|delete\\s+from|truncate(\\s+table)?)\\s+ledger\\./i]` and `TemplateElement[value.raw=/\\b(insert\\s+into|update|delete\\s+from|truncate(\\s+table)?)\\s+ledger\\./i]`, message `Ledger rows are written only by protected SQL functions (ADR-0007).`
5. `test/contract/approved-dependencies.json`: `{ "approved": [ … every package in CONVENTIONS §2 table … ], "justified": { "typescript": "compiler", "@types/node": "Node typings", "@eslint/js": "ESLint recommended config" } }`. Later tasks that add a justified dependency append it here with a one-line reason in the same commit.
6. `test/contract/dependency-policy.test.ts`: glob every `package.json` (root, `apps/*`, `packages/*`), and for each of `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` assert (a) spec is `workspace:*` or matches `/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/`; (b) name starts with `@flowledger/` or is in `approved ∪ keys(justified)`; (c) `@types/*` packages are allowed only when the un-typed package is approved (e.g. `@types/pg` for `pg`). Failure messages name the file and dependency.
7. `test/contract/lint-rules.test.ts`: use `new ESLint({ cwd: repoRoot })` and `eslint.lintText(code, { filePath })` with in-memory snippets (no files written) to prove each rule fires and does not over-fire.

**Expected behavior**
- `import { x } from '@flowledger/database'` in `packages/domain/src/a.ts` → `no-restricted-imports` error.
- `process.env.SIMULATOR_DATABASE_URL` in `packages/providers/src/a.ts` → error; same code in `packages/testkit/src/a.ts` → no error.
- `const n: number = 1` in `packages/domain/src/money.ts` → error; in `packages/domain/src/payment.ts` → no error.
- `"INSERT INTO ledger.journal_entries"` in `packages/database/src/a.ts` → error; `"SELECT ledger.post_payment_operation($1)"` → no error.

**Acceptance criteria**
- [ ] Every row of the boundary table produces an error for one forbidden import and no error for one allowed import (e.g. `database` → `@flowledger/domain` allowed).
- [ ] Both simulator variables are rejected outside their allowed directories and accepted inside them.
- [ ] Money and ledger-DML rules fire on the positive snippets and stay silent on the control snippets.
- [ ] Dependency-policy test fails when a `^1.2.3` spec or an unapproved package is introduced in a temporary in-memory copy of a manifest (test feeds a mutated object to the checker function, not a file).
- [ ] `pnpm check` green.

**Testing requirements**
- `test/contract/lint-rules.test.ts` cases: `boundary/<package>/forbidden`, `boundary/<package>/allowed` for all 8 packages; `packages-cannot-import-apps` (both `@flowledger/app-api` and `../../apps/api/src/main.js`); `simulator-url/forbidden-in-providers`, `simulator-url/forbidden-in-apps-payment-worker`, `simulator-url/allowed-in-testkit`, `simulator-url/allowed-in-cli`, `simulator-url/bracket-access-forbidden`; `provider-simulator-url/forbidden-in-api`, `provider-simulator-url/allowed-in-provider-simulator`; `money/number-keyword`, `money/Number-call`, `money/parseInt`, `money/Math`, `money/decimal-literal`, `money/control-file-not-checked`; `ledger-dml/insert`, `ledger-dml/update-template-literal`, `ledger-dml/delete`, `ledger-dml/truncate`, `ledger-dml/select-function-allowed`, `ledger-dml/testkit-exempt`.
- `test/contract/dependency-policy.test.ts` cases: `all manifests comply`, `caret spec rejected`, `tilde spec rejected`, `unapproved package rejected`, `@types without approved base rejected`, `workspace:* accepted`.
- Command: `pnpm vitest run --project contracts test/contract/lint-rules.test.ts test/contract/dependency-policy.test.ts` then `pnpm check`.

**Non-goals** — No custom ESLint plugin; no rule for apps importing each other (allowed); no `number` ban outside `money.ts`/`fees.ts`.

**Handoff checklist**
- [ ] Each rule observed to fail its positive snippet when the rule is temporarily removed.
- [ ] `test/contract/approved-dependencies.json` mirrors CONVENTIONS §2 exactly.
- [ ] Commit body contains `Task: P00-T02`.

---

### P00-T03 — Base configuration, lifecycle, `.env.example`, and `docs/CONFIG.md`

**Task ID:** `P00-T03`
**Feature:** Common configuration and graceful shutdown
**Commit:** `feat(repo): add base config parsing, graceful-shutdown lifecycle, and documented env`
**Priority:** Critical
**Dependencies:** P00-T01
**Estimated complexity:** M
**Contract references:** docs/10 §M0 ("common configuration and graceful-shutdown module"; "No application needs an undocumented local secret to start in test mode"), §Delivery safety ("health, readiness, graceful shutdown"); CONVENTIONS §11, §16
**Files:** create: `packages/config/src/base.ts`, `packages/config/src/lifecycle.ts`, `packages/config/src/base.test.ts`, `packages/config/src/lifecycle.test.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; modify: `packages/config/src/index.ts`; must not touch: apps (none exist yet)

**Objective** — Provide the single configuration/lifecycle module every app uses: env parsing that fails with the variable *name* only, a once-only graceful shutdown on SIGTERM/SIGINT with a bounded grace period, and a minimal health/readiness server for processes without their own HTTP server.

**Implementation instructions**
1. `packages/config/src/base.ts`:
   ```ts
   export type Env = Readonly<Record<string, string | undefined>>;
   export type NodeEnv = 'development' | 'test' | 'production';
   export interface BaseConfig { readonly nodeEnv: NodeEnv; readonly shutdownGraceMs: number }
   export class ConfigError extends Error { constructor(readonly variable: string, reason: string) } // message: `${variable}: ${reason}` — never the value
   export function parseBaseConfig(env: Env): BaseConfig;
   export function readPort(env: Env, name: string): number;          // integer 0..65535, required
   export function readFlag(env: Env, name: string, fallback: boolean): boolean; // '0' | '1' only
   ```
   Rules: `NODE_ENV` required, one of the three values. `SHUTDOWN_GRACE_MS` optional, default `10000`, integer `1000..60000`. Return `Object.freeze`d objects. A `ConfigError` message never contains the offending value.
2. `packages/config/src/lifecycle.ts`:
   ```ts
   export interface RunningApp { stop(): Promise<void> }
   export type StartFn = (env: Env) => Promise<RunningApp>;
   export function runMain(start: StartFn, deps?: { env?: Env; exit?: (code: number) => void; on?: (sig: 'SIGTERM' | 'SIGINT', h: () => void) => void; graceMs?: number }): void;
   export interface HealthServer { readonly port: number; setReady(ready: boolean): void; close(): Promise<void> }
   export function startHealthServer(port: number): Promise<HealthServer>;
   ```
   - `runMain`: calls `start(env)`; on rejection writes `startup failed: <error.message>` to stderr and exits 1. On the first SIGTERM or SIGINT calls `stop()` exactly once; exits 0 when it resolves; exits 1 if it rejects or if it has not resolved within `graceMs` (from `parseBaseConfig`). A second signal during shutdown is ignored.
   - `startHealthServer` uses `node:http` only: `GET /healthz` → `200 {"status":"ok"}` always; `GET /readyz` → `200 {"status":"ready"}` when ready else `503 {"status":"not_ready"}`; anything else `404`. Port `0` binds an ephemeral port and `port` reports the bound one. Starts not-ready.
3. `infra/docker/.env.example` (synthetic values only; every line commented with its consumer):
   ```text
   NODE_ENV=development
   SHUTDOWN_GRACE_MS=10000
   API_PORT=3000
   HEALTH_PORT=0
   SIMULATOR_PORT=3100
   SIMULATOR_TEST_ENDPOINTS=1
   POSTGRES_PASSWORD=flowledger_local_only
   FL_SIMULATOR_PASSWORD=fl_simulator_local_only
   FL_SIMULATOR_TRUTH_PASSWORD=fl_simulator_truth_local_only
   PROVIDER_SIMULATOR_DATABASE_URL=postgres://fl_simulator:fl_simulator_local_only@localhost:5432/flowledger_sim
   SIMULATOR_DATABASE_URL=postgres://fl_simulator_truth:fl_simulator_truth_local_only@localhost:5432/flowledger_sim
   PUBSUB_EMULATOR_HOST=localhost:8085
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
   ```
4. `docs/CONFIG.md`: table `| Variable | Read by | Required | Default | Allowed values | Secret? | Introduced in |` with one row per variable above. For `SIMULATOR_DATABASE_URL` state: "Harness-only (testkit, `flowledger verify`); runtime code must not read it — enforced by ESLint (P00-T02)". For `PROVIDER_SIMULATOR_DATABASE_URL`: "provider-simulator service only, owner role `fl_simulator`; first read in P06". `PUBSUB_EMULATOR_HOST`: first read in P05. `OTEL_EXPORTER_OTLP_ENDPOINT`: first read in P11. Add the rule: "Every task that adds a variable appends a row here and a line in `infra/docker/.env.example` in the same commit."

**Expected behavior**
- `parseBaseConfig({ NODE_ENV: 'test' })` → `{ nodeEnv: 'test', shutdownGraceMs: 10000 }` (frozen).
- `parseBaseConfig({ NODE_ENV: 'prod' })` → throws `ConfigError` with message `NODE_ENV: must be one of development, test, production`.
- `parseBaseConfig({ NODE_ENV: 'test', SHUTDOWN_GRACE_MS: 'abc' })` → message contains `SHUTDOWN_GRACE_MS` and not `abc`.
- SIGTERM with a `stop` that resolves in 10 ms → `exit(0)` once; `stop` that never resolves with `graceMs: 50` → `exit(1)` after ~50 ms.

**Acceptance criteria**
- [ ] No error message produced by `packages/config` contains a variable's value.
- [ ] `runMain` calls `stop` at most once across repeated signals.
- [ ] Health server returns the exact bodies/status codes above.
- [ ] Every variable in `.env.example` has a `docs/CONFIG.md` row and vice versa.

**Testing requirements**
- `packages/config/src/base.test.ts`: `NODE_ENV valid values`, `NODE_ENV missing → ConfigError(NODE_ENV)`, `NODE_ENV invalid`, `SHUTDOWN_GRACE_MS default`, `boundary 1000 and 60000 accepted`, `999 and 60001 rejected`, `non-integer rejected and value not echoed`, `readPort 0 and 65535 accepted, -1/65536/'x' rejected`, `readFlag '0'/'1' only`, `result is frozen`.
- `packages/config/src/lifecycle.test.ts` (inject `on`/`exit` fakes, no real signals): `startup rejection → exit(1)`, `SIGTERM → stop once → exit(0)`, `second signal ignored`, `stop rejects → exit(1)`, `stop exceeds grace → exit(1)`, `health /healthz 200`, `/readyz 503 then 200 after setReady(true)`, `unknown path 404`, `port 0 reports bound port`.
- A test in `base.test.ts` named `.env.example and CONFIG.md list the same variables` parses both files.
- Command: `pnpm vitest run --project unit packages/config` then `pnpm check`.

**Non-goals** — No per-app config modules (each app task adds its own); no logger (P11 owns `packages/observability`); no `DATABASE_URL` (P02).

**Handoff checklist**
- [ ] Each lifecycle test observed failing when the once-only guard is removed.
- [ ] Commit body contains `Task: P00-T03`.

---

### P00-T04 — Inert NestJS application entry points (API + eight workers)

**Task ID:** `P00-T04`
**Feature:** Application entry points
**Commit:** `feat(repo): add inert NestJS entry points for api and worker applications`
**Priority:** High
**Dependencies:** P00-T02, P00-T03
**Estimated complexity:** M
**Contract references:** docs/10 §Fixed implementation choices (NestJS + Fastify for HTTP; Nest standalone contexts for workers), §Repository shape, §M0; CONVENTIONS §3
**Files:** create: for each `<app>` in `api, outbox-relay, payment-worker, provider-webhook-receiver, provider-webhook-worker, reconciler, settlement-worker, merchant-webhook-projector, merchant-webhook-dispatcher`: `apps/<app>/package.json`, `apps/<app>/tsconfig.json`, `apps/<app>/src/main.ts`, `apps/<app>/src/index.ts`, `apps/<app>/src/app.module.ts`; and `test/contract/app-startup.test.ts`; modify: `tsconfig.json` (references), `test/tsconfig.json` (references), `package.json`/`pnpm-lock.yaml` (via pnpm install), `docs/VERSIONS.md`; must not touch: `packages/*/src/**` except imports

**Objective** — Every deployable application exists, starts in test mode using only `.env.example` values, exposes health/readiness, and shuts down gracefully — doing no business work yet.

**Implementation instructions**
1. `apps/<app>/package.json`: `"name": "@flowledger/app-<app>"`, `"private": true`, `"type": "module"`, `"exports": { "./main": { "@flowledger/source": "./src/main.ts", "default": "./dist/main.js" } }`, `"scripts": { "start": "node dist/index.js" }`, dependencies `@flowledger/config: workspace:*`, `@nestjs/core`, `@nestjs/common`, `reflect-metadata`, `rxjs` (exact versions, NestJS 11.x); `api` additionally `@nestjs/platform-fastify` and `fastify` (5.x).
2. `apps/<app>/tsconfig.json`: extends base; `"experimentalDecorators": true`, `"emitDecoratorMetadata": true`, `rootDir: src`, `outDir: dist`, references `../../packages/config`. Rule for all Nest code in this repo: inject providers with explicit `@Inject(TOKEN)` tokens, because Vitest (esbuild) does not emit decorator metadata.
3. `apps/<app>/src/app.module.ts`: `@Module({})` empty `AppModule`.
4. `apps/api/src/main.ts`:
   ```ts
   import 'reflect-metadata';
   import { NestFactory } from '@nestjs/core';
   import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
   import { parseBaseConfig, readPort, type StartFn } from '@flowledger/config';
   export const start: StartFn = async (env) => {
     parseBaseConfig(env);
     const port = readPort(env, 'API_PORT');
     const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
     const fastify = app.getHttpAdapter().getInstance();
     fastify.get('/healthz', async () => ({ status: 'ok' }));
     fastify.get('/readyz', async () => ({ status: 'ready' }));
     await app.listen(port, '0.0.0.0');
     return { stop: () => app.close() };
   };
   ```
   `/healthz` and `/readyz` are registered on the raw Fastify instance and are **not** OpenAPI operations **[ASSUMPTION A-04]** (R-08).
5. Worker `main.ts` (all eight): `parseBaseConfig(env)`; `const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false })`; `const health = await startHealthServer(readPort(env, 'HEALTH_PORT'))`; `health.setReady(true)`; `return { stop: async () => { health.setReady(false); await ctx.close(); await health.close(); } }`.
6. `src/index.ts` (all nine): `import { runMain } from '@flowledger/config'; import { start } from './main.js'; runMain(start);`.
7. `test/contract/app-startup.test.ts`: parse `infra/docker/.env.example` into an object (`KEY=VALUE` lines, `#` comments ignored), override `NODE_ENV=test`, `API_PORT=0`, `HEALTH_PORT=0`; for each app dynamically `import('@flowledger/app-<app>/main')`, call `start(env)` with **only** that object (never `process.env`), then `stop()`; for `api`, obtain a free port from a temporary `node:net` listener (closed just before `start`), set `API_PORT` to it, and fetch `/healthz` and `/readyz` on that port. `RunningApp` stays `{ stop }` only.
8. Add each app to root `tsconfig.json` and `test/tsconfig.json` references.

**Expected behavior** — `start(env)` for every app resolves in < 5 s with only `.env.example` values and `NODE_ENV=test`; `stop()` resolves and releases its port; with `NODE_ENV` removed, `start` rejects with `ConfigError` naming `NODE_ENV`.

**Acceptance criteria**
- [ ] Nine apps exist with the exact names from CONVENTIONS §3 and package names `@flowledger/app-<dir>`.
- [ ] No app reads `process.env` directly inside `main.ts`; only `index.ts` (through `runMain`) touches the process.
- [ ] `test/contract/app-startup.test.ts` passes using only `.env.example` values.
- [ ] `pnpm build` emits `apps/<app>/dist/index.js` for every app; `node apps/api/dist/index.js` with the `.env.example` env starts and exits 0 on SIGTERM (manual check recorded in commit body).

**Testing requirements**
- `test/contract/app-startup.test.ts`: one case per app named `<app> starts in test mode with only .env.example and stops`; `api serves /healthz 200 and /readyz 200`; `worker health endpoint ready then not-ready after stop begins` (payment-worker); `missing NODE_ENV fails startup naming the variable` (api and one worker).
- Command: `pnpm vitest run --project contracts test/contract/app-startup.test.ts` then `pnpm check`.

**Non-goals** — No routes beyond health; no DB, Pub/Sub, telemetry, or logger; no Dockerfiles (P13).

**Handoff checklist**
- [ ] Startup test observed failing when an app is given an extra required variable not in `.env.example`.
- [ ] `docs/VERSIONS.md` updated with NestJS/Fastify versions.
- [ ] Commit body contains `Task: P00-T04`.

---

### P00-T05 — Inert `cli` (`flowledger` bin) and `provider-simulator` entry points

**Task ID:** `P00-T05`
**Feature:** Application entry points
**Commit:** `feat(cli): add inert flowledger binary and provider-simulator entry point`
**Priority:** High
**Dependencies:** P00-T04
**Estimated complexity:** S
**Contract references:** CONVENTIONS §3 (`cli`, `provider-simulator`), §4 (`flowledger migrate|seed|verify`), §16; docs/06 §Deterministic fake provider ("controllable clock", ground truth harness-only)
**Files:** create: `apps/cli/{package.json,tsconfig.json,src/main.ts,src/index.ts,src/main.test.ts}`, `apps/provider-simulator/{package.json,tsconfig.json,src/main.ts,src/index.ts,src/config.ts,src/config.test.ts}`; modify: `test/contract/app-startup.test.ts`, `tsconfig.json`, `test/tsconfig.json`, `package.json`/`pnpm-lock.yaml`, `docs/CONFIG.md` (Read-by column); must not touch: other apps

**Objective** — Complete the entry-point set: an inert `flowledger` CLI whose later subcommands already have stable names, and an inert Fastify provider-simulator process with a safety-checked test-endpoint flag.

**Implementation instructions**
1. `apps/cli/package.json`: `"name": "@flowledger/app-cli"`, `"bin": { "flowledger": "./dist/index.js" }`, dependency `@flowledger/config`. No CLI framework — use `node:util` `parseArgs`.
2. `apps/cli/src/main.ts`:
   ```ts
   export interface CliIo { out(line: string): void; err(line: string): void }
   export async function runCli(argv: readonly string[], io: CliIo): Promise<number>; // returns exit code
   ```
   Behavior: no args or `--help` → prints usage listing `migrate`, `seed`, `verify` and returns 0. `migrate` → err `flowledger migrate: not implemented until P02` return 2. `seed` → `... not implemented until P02` return 2. `verify` → `... not implemented until P03` return 2. Unknown command → err `unknown command: <name>` return 64.
3. `apps/cli/src/index.ts`: `#!/usr/bin/env node` shebang; `process.exitCode = await runCli(process.argv.slice(2), { out: console.log, err: console.error })`.
4. `apps/provider-simulator/package.json`: `"name": "@flowledger/app-provider-simulator"`, deps `fastify`, `@flowledger/config`; `exports` `./main` as in P00-T04.
5. `apps/provider-simulator/src/config.ts`:
   ```ts
   export interface SimulatorConfig extends BaseConfig { readonly port: number; readonly testEndpoints: boolean }
   export function parseSimulatorConfig(env: Env): SimulatorConfig;
   ```
   `SIMULATOR_PORT` via `readPort`; `SIMULATOR_TEST_ENDPOINTS` via `readFlag(…, false)`; if `testEndpoints && nodeEnv === 'production'` throw `ConfigError('SIMULATOR_TEST_ENDPOINTS', 'must be 0 when NODE_ENV=production')` **[ASSUMPTION A-05]**. Does not read `PROVIDER_SIMULATOR_DATABASE_URL` yet (P06).
6. `apps/provider-simulator/src/main.ts`: Fastify instance with `GET /healthz` → `{status:'ok'}`, `GET /readyz` → `{status:'ready'}`; listen on config port; `stop` closes it. No `/__test/*` routes yet (P06).
7. Extend `test/contract/app-startup.test.ts` with `provider-simulator` (override `SIMULATOR_PORT=0` via free-port helper) and a CLI case calling `runCli(['--help'])`.

**Expected behavior** — `flowledger --help` exit 0; `flowledger verify` exit 2 with `not implemented until P03`; `flowledger nope` exit 64; simulator starts with `.env.example`; `NODE_ENV=production` + `SIMULATOR_TEST_ENDPOINTS=1` fails startup naming `SIMULATOR_TEST_ENDPOINTS`.

**Acceptance criteria**
- [ ] `pnpm --filter @flowledger/app-cli exec flowledger --help` prints the three subcommands after `pnpm build`.
- [ ] Each "not implemented" message names the implementing phase exactly as above.
- [ ] Simulator config rejects test endpoints in production.

**Testing requirements**
- `apps/cli/src/main.test.ts`: `no args prints usage → 0`, `--help → 0`, `migrate → 2 + P02 message`, `seed → 2 + P02 message`, `verify → 2 + P03 message`, `unknown → 64`.
- `apps/provider-simulator/src/config.test.ts`: `defaults`, `flag '1' in test accepted`, `flag '1' in production rejected`, `flag 'yes' rejected`, `port invalid rejected`.
- `test/contract/app-startup.test.ts`: `provider-simulator starts in test mode with only .env.example and stops`.
- Command: `pnpm vitest run --project unit apps/cli apps/provider-simulator && pnpm vitest run --project contracts test/contract/app-startup.test.ts`.

**Non-goals** — No migrate/seed/verify logic; no simulator state, DB, webhooks, or clock endpoints.

**Handoff checklist**
- [ ] Commit body contains `Task: P00-T05`.

---

### P00-T06 — Docker Compose stack, simulator database bootstrap, and PostgreSQL test fixture

**Task ID:** `P00-T06`
**Feature:** Local runtime
**Commit:** `feat(infra): add docker compose with postgres 17, pubsub emulator, jaeger, and simulator database bootstrap`
**Priority:** High
**Dependencies:** P00-T03
**Estimated complexity:** M
**Contract references:** docs/10 §M0 (Compose for PostgreSQL, Pub/Sub emulator, telemetry), docs/09 §Reference benchmark environment (PostgreSQL 17); CONVENTIONS §2, §4 (`db:up`/`db:down`), §16 (`flowledger_sim`, `fl_simulator`, `fl_simulator_truth`)
**Files:** create: `infra/docker/compose.yaml`, `infra/docker/postgres-init/10-simulator-db.sh`, `packages/testkit/src/postgres.ts`, `test/integration/simulator-db-bootstrap.test.ts`; modify: `package.json` (scripts `db:up`, `db:down`; testkit deps), `packages/testkit/package.json`, `packages/testkit/src/index.ts`, `docs/VERSIONS.md`, `test/contract/approved-dependencies.json` (none expected); must not touch: `migrations/` (P02)

**Objective** — One command brings up every local dependency; the provider-simulator database and its two roles exist with the isolation CONVENTIONS §16 requires; integration tests get a reusable PostgreSQL 17 container that applies the same bootstrap.

**Implementation instructions**
1. `infra/docker/compose.yaml` (Compose v2, no `version:` key), project name `flowledger`:
   - `postgres`: `image: postgres:17.<minor>` (exact minor, recorded in VERSIONS.md); env `POSTGRES_USER: postgres`, `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-flowledger_local_only}`, `POSTGRES_DB: flowledger`, `FL_SIMULATOR_PASSWORD: ${FL_SIMULATOR_PASSWORD:-fl_simulator_local_only}`, `FL_SIMULATOR_TRUTH_PASSWORD: ${FL_SIMULATOR_TRUTH_PASSWORD:-fl_simulator_truth_local_only}`; port `5432:5432`; volume `./postgres-init:/docker-entrypoint-initdb.d:ro`; named volume for data; healthcheck `pg_isready -U postgres -d flowledger`.
   - `pubsub`: `image: gcr.io/google.com/cloudsdktool/google-cloud-cli:<exact>-emulators`; command `gcloud beta emulators pubsub start --host-port=0.0.0.0:8085 --project=flowledger-local`; port `8085:8085`.
   - `jaeger`: `image: jaegertracing/all-in-one:<exact 1.x>`; env `COLLECTOR_OTLP_ENABLED: "true"`; ports `16686:16686` (UI), `4317:4317`, `4318:4318` (OTLP). One container replaces a separate collector; a metrics backend is deferred to P11 **[ASSUMPTION A-06]**.
   Defaults via `${VAR:-default}` mean a clean clone needs no `.env` file.
2. `infra/docker/postgres-init/10-simulator-db.sh` (executable, `set -euo pipefail`) runs `psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v sim_pw="$FL_SIMULATOR_PASSWORD" -v truth_pw="$FL_SIMULATOR_TRUTH_PASSWORD"` with heredoc SQL:
   ```sql
   CREATE ROLE fl_simulator LOGIN PASSWORD :'sim_pw';
   CREATE ROLE fl_simulator_truth LOGIN PASSWORD :'truth_pw';
   ALTER ROLE fl_simulator_truth SET default_transaction_read_only = on;
   CREATE DATABASE flowledger_sim OWNER fl_simulator;
   REVOKE ALL ON DATABASE flowledger_sim FROM PUBLIC;
   GRANT CONNECT ON DATABASE flowledger_sim TO fl_simulator, fl_simulator_truth;
   \connect flowledger_sim
   REVOKE ALL ON SCHEMA public FROM PUBLIC;
   ALTER SCHEMA public OWNER TO fl_simulator;
   GRANT USAGE ON SCHEMA public TO fl_simulator_truth;
   ALTER DEFAULT PRIVILEGES FOR ROLE fl_simulator IN SCHEMA public GRANT SELECT ON TABLES TO fl_simulator_truth;
   ```
   The script does not create FlowLedger roles (CONVENTIONS §7: migration `0200`, P02) and does not assume the main database name (works under Testcontainers' `POSTGRES_DB=test`).
3. Root scripts: `"db:up": "docker compose -f infra/docker/compose.yaml up -d --wait"`, `"db:down": "docker compose -f infra/docker/compose.yaml down -v"`.
4. `packages/testkit/src/postgres.ts` (deps `@testcontainers/postgresql`, `testcontainers`, `pg`, exact versions):
   ```ts
   export interface StartedPostgres { readonly uri: string; uriFor(database: string, user?: string, password?: string): string; stop(): Promise<void> }
   export async function startPostgres(): Promise<StartedPostgres>;
   ```
   Uses image `postgres:17.<minor>` (same constant as compose — export `POSTGRES_IMAGE` from this file and assert equality with compose in the test), copies `infra/docker/postgres-init` to `/docker-entrypoint-initdb.d`, sets the two simulator password env vars to the `.env.example` values.
5. `test/integration/simulator-db-bootstrap.test.ts` uses `startPostgres()` and `pg.Client`.

**Expected behavior**
- `pnpm db:up` → three healthy/running containers; `psql postgres://fl_simulator_truth:…@localhost:5432/flowledger_sim -c 'select 1'` works.
- `fl_simulator` can `CREATE TABLE t(x int)` in `flowledger_sim`; `fl_simulator_truth` can `SELECT * FROM t` but `INSERT INTO t` fails with SQLSTATE `25006` (read-only transaction) or `42501`.
- `fl_simulator` connecting to the main database succeeds at the network level but holds no object privileges after P02 (R-09).

**Acceptance criteria**
- [ ] `docker compose -f infra/docker/compose.yaml config` validates.
- [ ] Image tags are exact (no `latest`) and recorded in `docs/VERSIONS.md`.
- [ ] Integration test proves the role isolation listed in Expected behavior.
- [ ] `server_version_num` in the container is `>= 170000` and `< 180000`.

**Testing requirements**
- `test/integration/simulator-db-bootstrap.test.ts`: `server is PostgreSQL 17`, `flowledger_sim exists owned by fl_simulator`, `fl_simulator can create and write a table`, `fl_simulator_truth can read new tables via default privileges`, `fl_simulator_truth cannot insert (25006 or 42501)`, `PUBLIC has no CONNECT on flowledger_sim` (query `has_database_privilege('public', 'flowledger_sim', 'CONNECT')` = false via a third throwaway login role), `testkit image constant equals compose image`.
- Command: `pnpm test:integration` (Docker required).

**Non-goals** — No FlowLedger roles/schemas; no Pub/Sub topic bootstrap (P05); no OTel SDK wiring (P11).

**Handoff checklist**
- [ ] `pnpm db:up && pnpm db:down` executed locally; result noted in commit body.
- [ ] Commit body contains `Task: P00-T06`.

---

### P00-T07 — Contract code generation and drift check

**Task ID:** `P00-T07`
**Feature:** Generated contract types
**Commit:** `feat(contracts): generate schema modules and TypeScript types with drift check`
**Priority:** Critical
**Dependencies:** P00-T01
**Estimated complexity:** M
**Contract references:** docs/10 §M0 ("Generate TypeScript types from OpenAPI/JSON Schema … fail on an uncommitted contract drift"), §M1; docs/05 §MVP API decisions ("TypeScript request/response types … generated from it"); schemas/README §Validator requirements; CONVENTIONS §4, §13
**Files:** create: `scripts/contracts-generate.mjs`, `scripts/contracts-check.mjs`, `packages/contracts/src/generated/schemas.ts`, `packages/contracts/src/generated/openapi-components.ts`, `packages/contracts/src/generated/messages.ts`, `packages/contracts/src/generated/openapi.ts`, `test/contract/contracts-drift.test.ts`; modify: `package.json` (scripts, devDeps `openapi-typescript`, `json-schema-to-typescript`, `@apidevtools/swagger-parser`), `packages/contracts/package.json`, `packages/contracts/src/index.ts`, `docs/VERSIONS.md`; must not touch: `schemas/**`, `openapi/**`

**Objective** — Make `schemas/**` and `openapi/openapi.yaml` the only sources of contract types and runtime schema objects; any change to them without regenerating fails CI.

**Implementation instructions**
1. `scripts/contracts-generate.mjs [--out <dir>]` (plain Node ESM; default out `packages/contracts/src/generated`):
   - `schemas.ts`: reads every `schemas/**/*.json` sorted by path; emits `export const jsonSchemas = [ … ] as const;` (all `*.schema.json` objects, including `registry-manifest.v1.schema.json` and `webhooks/merchant-event.v1.schema.json`), `export const registry = { … } as const;` (contents of `registry.v1.json`), and `export const registeredTypes = [ 'payment.operation.execute.v1', … ] as const; export type MessageType = (typeof registeredTypes)[number];`.
   - `openapi-components.ts`: parse `openapi/openapi.yaml` with `SwaggerParser.parse` (no dereference); emit `export const openApiComponentsSchema = { $id: 'https://flowledger.dev/openapi/components.json', $defs: <components.schemas with every '#/components/schemas/' replaced by '#/$defs/'> } as const;` and `export const openApiExtensionKeywords = ['x-flowledger-http-status-must-equal-body-status'] as const;` (computed: every key starting `x-` found inside `components.schemas`, sorted).
   - `messages.ts`: `json-schema-to-typescript` `compileFromFile` for each schema referenced by `registry.v1.json` (unique paths) plus `webhooks/merchant-event.v1.schema.json`, `bannerComment: ''`, `additionalProperties: false`, `strictIndexSignatures: true`, `unreachableDefinitions: false`; concatenate with duplicate-declaration removal for shared `$defs` (dedupe by exported identifier, first wins, deterministic file order).
   - `openapi.ts`: `openapi-typescript` on `openapi/openapi.yaml`.
   - Every emitted file starts with `// GENERATED by scripts/contracts-generate.mjs — do not edit.` and is formatted with the Prettier API using the repo config before writing, so output is byte-deterministic.
2. `scripts/contracts-check.mjs`: run the generator into `fs.mkdtemp(os.tmpdir()/fl-contracts-)`, compare every file byte-for-byte with the committed directory (also detect extra/missing files); on mismatch print `contract drift: <file>` per file and `run pnpm contracts:generate` and exit 1.
3. Root scripts: `"contracts:generate": "node scripts/contracts-generate.mjs"`, `"contracts:check": "node scripts/contracts-check.mjs"`, and change `check` to `pnpm lint && pnpm typecheck && pnpm contracts:check && pnpm test:unit && pnpm test:contracts`.
4. `packages/contracts/src/index.ts` re-exports `./generated/schemas.js`, `./generated/openapi-components.js`, and types from `./generated/messages.js` and `./generated/openapi.js`.
5. Run `pnpm contracts:generate` and commit the generated files (CONVENTIONS §13 permits committing exactly this directory).

**Expected behavior** — Fresh generate then check → exit 0. Editing a `description` in a copy of a schema fed to the generator via `--schemas-dir` (test-only flag) produces a diff.

**Acceptance criteria**
- [ ] `pnpm contracts:check` exits 0 on a clean tree and 1 after any manual edit to a generated file.
- [ ] Two consecutive generator runs produce identical bytes.
- [ ] `registeredTypes` has exactly the 26 types in `schemas/registry.v1.json`, in file order.
- [ ] `pnpm typecheck` passes with the generated files included.

**Testing requirements**
- `test/contract/contracts-drift.test.ts`: `generator is deterministic` (two runs into two temp dirs, byte-compare), `committed output matches fresh output`, `check detects an edited generated file` (copy committed dir to temp, append a byte, run check function with `--committed <temp>`), `check detects a missing file`, `registeredTypes equals registry order`, `openApiComponentsSchema contains no '#/components/schemas/' refs`. Add test-only CLI flags `--schemas-dir`, `--openapi`, `--committed` to the scripts to support these without touching real contract files.
- Command: `pnpm vitest run --project contracts test/contract/contracts-drift.test.ts && pnpm check`.

**Non-goals** — No runtime validation (P00-T08); no request validators for the API (P04).

**Handoff checklist**
- [ ] `pnpm contracts:check` observed failing after hand-editing `generated/schemas.ts`, then restored.
- [ ] Commit body contains `Task: P00-T07` and justification "devDependency `yaml` not added — SwaggerParser.parse reads YAML".

---

### P00-T08 — Ajv message validation core, registry semantic rules 1–5, and catalog parity

**Task ID:** `P00-T08`
**Feature:** Contract validation
**Commit:** `feat(contracts): compile all schemas with format assertion and enforce registry rules`
**Priority:** Critical
**Dependencies:** P00-T07
**Estimated complexity:** M
**Contract references:** schemas/README §Validator requirements, §Registry manifest rules 1–5 (lines 66-78), §Local validation expectations 1–4; docs/04 §Initial command catalog, §Initial event catalog, §Schema evolution (unsupported version → DLQ); docs/09 §Static checks; docs/10 §M0 acceptance bullets 2–5
**Files:** create: `packages/contracts/src/ajv.ts`, `packages/contracts/src/validate.ts`, `test/contract/schemas.test.ts`, `test/contract/registry.test.ts`, `test/contract/catalog-parity.test.ts`; modify: `packages/contracts/package.json` (deps `ajv`, `ajv-formats`), `packages/contracts/src/index.ts`; must not touch: `schemas/**`, `docs/04-EVENT_CONTRACTS.md`

**Objective** — Compile every JSON Schema under Draft 2020-12 with format assertion and no network, enforce the registry rules JSON Schema cannot express, prove the documented catalog equals the registry, and expose one `validateMessage` entry point.

**Implementation instructions**
1. `packages/contracts/src/ajv.ts`:
   ```ts
   import Ajv2020 from 'ajv/dist/2020.js';
   import addFormats from 'ajv-formats';
   export function createAjv(): Ajv2020 {
     const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictRequired: false, strictTuples: true,
       allowUnionTypes: true, allErrors: true, verbose: false, loadSchema: undefined });
     addFormats(ajv); // asserts uuid, date-time, uri among others
     return ajv;
   }
   export function createMessageAjv(): Ajv2020; // createAjv() + addSchema(every jsonSchemas entry) + eager getSchema of every $id
   ```
   `strictSchema: true` makes unknown keywords throw (contract requirement). `verbose: false` keeps instance data out of errors (prohibited-data hygiene). Remote refs: none configured; any `$ref` that is not in `jsonSchemas` throws `MissingRefError` at compile time.
2. `packages/contracts/src/validate.ts`:
   ```ts
   export interface ValidationIssue { readonly path: string; readonly rule: string; readonly message: string }
   export type MessageValidationResult =
     | { ok: true; message: RegisteredEnvelope }
     | { ok: false; failure: 'UNREGISTERED_TYPE' | 'SCHEMA' | 'SEMANTIC'; issues: readonly ValidationIssue[] };
   export type RegisteredEnvelope = { kind: 'COMMAND' | 'EVENT'; type: MessageType; schemaVersion: number; [k: string]: unknown };
   export function validateMessage(input: unknown): MessageValidationResult;
   export function validateMerchantWebhookPayload(input: unknown): { ok: true } | { ok: false; failure: 'SCHEMA' | 'SEMANTIC'; issues: readonly ValidationIssue[] };
   ```
   Algorithm: if `input` is not an object with string `kind` and `type` → `SCHEMA` (path `''`, rule `envelope`). Look up `(kind, type)` in `registry.messages`; absent → `UNREGISTERED_TYPE` (this is the docs/04 "unsupported version → DLQ" signal). Else validate with the schema compiled from the entry's `schema` path (`https://flowledger.dev/schemas/<path>`); failure → `SCHEMA` with `issues` from Ajv (`instancePath`, `keyword`, `message`). The `SEMANTIC` branch is wired in P00-T11 (until then return `ok: true` after schema success). Compile once at module load (lazy singleton).
3. Registry rules (implement as exported pure function `checkRegistry(registry, schemasById): string[]` in `validate.ts`, used by tests and by `createMessageAjv` startup assertion):
   1. `(kind, type)` unique across rows.
   2. Every `schema` path exists in `jsonSchemas` under `commands/` or `events/`.
   3. The referenced schema accepts the entry's exact `kind` and `type`: evaluate the schema's root `allOf[1].properties.kind.const` and `allOf[1].properties.type` (`const` or `enum` containing `type`). Also assert `schemaVersion.const` equals the `.vN` suffix of `type`.
   4. Catalog parity (see step 4).
   5. No unresolved `$ref`: compiling every registered schema succeeds under `createAjv()` with no remote loader.
4. `test/contract/catalog-parity.test.ts`: parse `docs/04-EVENT_CONTRACTS.md`; take the markdown tables under the headings `## Initial command catalog` and `## Initial event catalog`; the first cell of each body row is a backticked type. Assert: commands set == registry `COMMAND` types (3) and events set == registry `EVENT` types (23), exact one-to-one (report missing and extra separately). Also parse `schemas/README.md` sections `## Commands`/`## Events` file lists and assert every listed file is referenced by the registry and vice versa.

**Expected behavior**
- All 20 `*.schema.json` files (3 commands, 6 common, 9 events, 1 webhook, 1 registry manifest) compile; the registry manifest validates against `registry-manifest.v1.schema.json`.
- `validateMessage({ kind: 'EVENT', type: 'payment.created.v2', … })` → `{ ok: false, failure: 'UNREGISTERED_TYPE' }`.
- A schema with `"typo": true` added (in-memory copy) → `createAjv().compile(...)` throws `strict mode: unknown keyword: "typo"`.
- `{ "type": "string", "format": "uuid" }` rejects `"not-a-uuid"`; `{ "format": "date-time" }` rejects `"2026-11-05 18:44"`.

**Acceptance criteria**
- [ ] Every file under `schemas/` parses as JSON (Local validation expectation 1).
- [ ] Every schema compiles with format assertion; compile of a schema with an unknown keyword throws (malformed-schema negative, docs/10 §M0).
- [ ] Rules 1, 2, 3, 5 each have a negative test using an in-memory mutated registry/schema set that fails with a message naming the rule.
- [ ] Catalog parity is exact for commands and events.
- [ ] `validateMessage` never returns Ajv `data` values in issues.

**Testing requirements**
- `test/contract/schemas.test.ts`: `every schemas/**/*.json parses`, `every schema compiles under Draft 2020-12 strictSchema`, `uuid format asserted`, `date-time format asserted`, `unknown keyword is a configuration error`, `remote $ref is rejected without network` (in-memory schema referencing `https://example.com/x.json` → `MissingRefError`), `registry manifest validates`, `registry manifest with extra property fails`.
- `test/contract/registry.test.ts`: `rule1 duplicate (kind,type) detected` (two different rows, same pair, different schema path — `uniqueItems` alone passes), `rule2 missing schema path detected`, `rule2 path outside commands/events detected`, `rule3 kind mismatch detected`, `rule3 type not in schema enum detected`, `rule3 schemaVersion/suffix mismatch detected`, `rule5 unresolved $ref detected`, `real registry has zero findings`, `validateMessage unregistered type → UNREGISTERED_TYPE`, `validateMessage non-object → SCHEMA`.
- `test/contract/catalog-parity.test.ts`: `command catalog == registry commands`, `event catalog == registry events`, `schemas README file list == registry schema paths`, `parity failure message lists missing and extra types` (feed a mutated table string).
- Command: `pnpm vitest run --project contracts test/contract/schemas.test.ts test/contract/registry.test.ts test/contract/catalog-parity.test.ts`.

**Non-goals** — No message fixtures (P00-T10); no semantic checks (P00-T11); no OpenAPI (P00-T09).

**Handoff checklist**
- [ ] Each rule test observed failing when its check is commented out.
- [ ] Commit body contains `Task: P00-T08`.

---

### P00-T09 — OpenAPI parse, reference, component-example, and prose-example validation

**Task ID:** `P00-T09`
**Feature:** Contract validation
**Commit:** `test(contracts): validate openapi structure, examples, problem codes, and prose examples`
**Priority:** Critical
**Dependencies:** P00-T08
**Estimated complexity:** M
**Contract references:** docs/10 §M0 ("The OpenAPI file parses and all local references resolve"; "invalid OpenAPI examples fail the contract job"); docs/09 §Static checks ("all component and checked-in prose examples validate"); docs/05 §Canonical error format table, §Resource representations, §Pagination; docs/04 §Envelope, §Capture event example; openapi.yaml `components.schemas`
**Files:** create: `test/contract/openapi.test.ts`, `test/contract/prose-examples.test.ts`, `test/contract/fixtures/prose-examples.json`; modify: none; must not touch: `openapi/**`, `docs/0*`

**Objective** — Prove the OpenAPI document is structurally valid, every example it contains validates against its own schema, every JSON example in the prose contracts validates against the schema it illustrates, and the problem-code table in docs/05 equals the OpenAPI enum.

**Implementation instructions**
1. `openapi.test.ts`:
   - `SwaggerParser.validate(<path>)` resolves (parse + local `$ref` resolution + OpenAPI 3.1 structural validation).
   - Build `ajv = createAjv()`, `ajv.addKeyword(k)` for each `openApiExtensionKeywords`, `ajv.addSchema(openApiComponentsSchema)`; compile every `$defs/<name>`.
   - Walk `openApiComponentsSchema` and the parsed raw document (paths, parameters, responses, headers): for every node with `examples` (array) or `example`, compile the node (with refs rewritten as in generation, resolved against the components `$id`) and validate each example. Collect failures as `<json-pointer>: <ajv message>`.
   - Problem-code parity: parse the table under `## Canonical error format` in docs/05 (`| HTTP | Code | Meaning |`), compare the code set with `components.schemas.ProblemCode.enum` (exact), and for each code assert the `ProblemNNN` schema for its HTTP status lists it (read `Problem400` … `Problem503` `allOf[1].properties.code.enum` or `const`).
   - Negative proofs (in-memory copies only): replace `components.schemas.PaymentId.examples` with `['pay_BAD']` → the example walker reports exactly one failure at `/components/schemas/PaymentId/examples/0`; add `"x-unknown"` keyword without registering → compile throws.
2. `test/contract/fixtures/prose-examples.json`: ordered list of every ```` ```json ```` block in `docs/04-EVENT_CONTRACTS.md` and `docs/05-API_AND_IDEMPOTENCY_CONTRACT.md` with its validation target:
   ```json
   [
     { "file": "docs/04-EVENT_CONTRACTS.md", "index": 0, "target": { "registry": true } },
     { "file": "docs/04-EVENT_CONTRACTS.md", "index": 1, "target": { "registry": true } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 0, "target": { "openapi": "PositiveMoney" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 1, "target": { "openapi": "Payment" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 2, "target": { "openapi": "PaymentOperation" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 3, "target": { "openapi": "CreatePaymentRequest" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 4, "target": { "openapi": "AmountCommandRequest" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 5, "target": { "openapi": "AmountCommandRequest" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 6, "target": { "openapi": "PaymentTimeline" },
       "knownDeviation": { "risk": "R-02", "onlyError": { "instancePath": "", "keyword": "required", "missingProperty": "truncated" } } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 7, "target": { "openapi": "Problem" } },
     { "file": "docs/05-API_AND_IDEMPOTENCY_CONTRACT.md", "index": 8, "target": { "openapi": "PaymentPage" } }
   ]
   ```
3. `prose-examples.test.ts`: extract blocks with `/^```json\n([\s\S]*?)^```/gm`; assert the number of blocks per file equals the manifest count (a new prose example without a manifest entry fails); `registry: true` → `validateMessage(block).ok === true`; `openapi: X` → validate against `$defs/X`. For `knownDeviation`, assert validation fails with **exactly** the one listed error (so any other drift is caught, and if the contract is fixed the test fails and the entry must be removed — R-02).

**Expected behavior** — 10 of 11 prose examples validate; the timeline example fails only on `truncated`; all component examples validate; docs/05 has 27 problem codes equal to the OpenAPI enum.

**Acceptance criteria**
- [ ] OpenAPI validates and all local refs resolve.
- [ ] Every OpenAPI example validates; a mutated invalid example fails the test with its JSON pointer (docs/10 §M0 negative).
- [ ] Problem-code set parity and per-status membership are exact.
- [ ] Prose-example manifest count equals the number of JSON blocks in both docs.

**Testing requirements**
- `test/contract/openapi.test.ts`: `openapi validates with swagger-parser`, `all component schemas compile`, `all component examples validate`, `invalid component example is reported with pointer`, `unregistered x- keyword is a configuration error`, `problem codes in docs/05 equal ProblemCode enum`, `each problem code is allowed by its HTTP-status Problem schema`.
- `test/contract/prose-examples.test.ts`: `manifest covers every json block`, one case per manifest entry named `<file>#<index> validates against <target>`, `timeline example deviates only by missing truncated (R-02)`.
- Command: `pnpm vitest run --project contracts test/contract/openapi.test.ts test/contract/prose-examples.test.ts`.

**Non-goals** — No HTTP conformance probes against a running API (P04); no timeline `detail` per-kind validation (P04, R-03).

**Handoff checklist**
- [ ] Negative example test observed passing only when the walker actually validates (temporarily make the walker skip examples → test fails).
- [ ] Commit body contains `Task: P00-T09`.

---

### P00-T10 — Positive and negative message fixtures for every registered type and the merchant webhook payload

**Task ID:** `P00-T10`
**Feature:** Contract validation
**Commit:** `test(contracts): add positive and high-risk negative fixtures for every registered message type`
**Priority:** Critical
**Dependencies:** P00-T08
**Estimated complexity:** L
**Contract references:** schemas/README §Local validation expectations items 5–6, §Provider-result requirements, §Closed-version policy; docs/04 §Envelope rules, §Capture event example, §Merchant webhook wire contract; docs/09 §Static checks (fixtures incl. amount bounds, ID prefixes, unknown fields, terminal evidence, no-effect proof)
**Files:** create: `test/contract/fixtures/messages.ts`, `test/contract/fixtures/mutations.ts`, `test/contract/message-fixtures.test.ts`, `test/contract/merchant-webhook-payload.test.ts`; modify: none; must not touch: `schemas/**`

**Objective** — One schema-valid positive fixture per registered type (26) plus a public merchant-webhook payload per allowlisted type, and a negative suite proving each high-risk defect is rejected *for the right reason*.

**Implementation instructions**
1. `fixtures/messages.ts` exports `validMessages: Readonly<Record<MessageType, Record<string, unknown>>>`. Shared constants (all valid Crockford ULIDs):
   `MER='mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ'`, `PAY='pay_01ARZ3NDEKTSV4RRFFQ69G5FAV'`, `OP='op_01ARZ3NDEKTSV4RRFFQ69G5FAX'`, `PACC='pacc_01ARZ3NDEKTSV4RRFFQ69G5FAY'`, `PAT='pat_01ARZ3NDEKTSV4RRFFQ69G5FAW'`, `LTX='ltx_01ARZ3NDEKTSV4RRFFQ69G5FA0'`, `CASE='case_01ARZ3NDEKTSV4RRFFQ69G5FA2'`, `WHD='whd_01ARZ3NDEKTSV4RRFFQ69G5FAS'`, `WHE='whe_01ARZ3NDEKTSV4RRFFQ69G5FA3'`, `SRN='srn_01ARZ3NDEKTSV4RRFFQ69G5FA4'`, `SBT='sbt_01ARZ3NDEKTSV4RRFFQ69G5FB5'`; envelope ids are fixed UUID v4 strings; `correlationId='cor_01ARZ3NDEKTSV4RRFFQ69G5FAW'`; timestamps `2026-11-05T18:44:31.123Z`.
   Every fixture must satisfy both its schema **and** every semantic rule of P00-T11 (aggregateId/orderingKey equal `data.paymentId` for payment messages; execute `aggregateVersion === data.expectedPaymentVersion`; `resolutionSource === evidence.source`; terminal rejection/failure `resultCode === normalizedError.code`; totals invariants; ledger debits == credits; settlement `aggregateVersion: 1`, `orderingKey: MER`, `postingKey: 'settlement:' + SBT`). `payment.capture.succeeded.v1` is exactly the docs/04 capture example. `merchant.webhook.deliver.v1` uses `orderingKey: WHE` because the schema requires it (R-01). Terminal FAILED fixtures use `noEffectProof: { kind: 'AUTHENTICATED_PROVIDER_REJECTION', providerCode: 'card_not_charged' }`; one FAILED fixture per proof kind is covered by a parameterized positive case.
2. `fixtures/mutations.ts` exports `negativeCases: readonly { name: string; appliesTo: readonly MessageType[] | 'all'; mutate(m): unknown; expect: { keyword: string; instancePathPrefix?: string } }[]` covering (each `appliesTo` explicit):
   | Name | Mutation | Expected Ajv keyword |
   | --- | --- | --- |
   | `unknown-envelope-field` | add `extra: 1` at root | `additionalProperties` (path `''`) |
   | `unknown-data-field` | add `data.extra = 1` | `additionalProperties` (path `/data`) |
   | `invalid-uuid-id` | `id = '0192f4e7-8b30-7c83-b462'` | `format` (path `/id`) |
   | `invalid-date-time` | `occurredAt = '2026-11-05 18:44:31'` | `format` |
   | `overflow-ulid` | aggregate/subject ULID first char `8` (e.g. `pay_81ARZ3NDEKTSV4RRFFQ69G5FAV`) | `pattern` |
   | `wrong-entity-prefix` | `data.paymentId = MER` (payment types) / `data.deliveryId = WHE` (deliver) | `pattern` |
   | `zero-operation-amount` | `data.amount.amountMinor = '0'` (requested, terminal) | `pattern` |
   | `amount-above-max` | `amountMinor = '1000000000001'` | `pattern` |
   | `json-number-amount` | `amountMinor = 10000` | `type` |
   | `non-usd` | `currency = 'EUR'` | `const` |
   | `schema-version-mismatch` | `schemaVersion = 2` | `const` |
   | `mismatched-outcome` | terminal success type with `outcome: 'REJECTED'` | `const` |
   | `success-with-error` | `*.succeeded.v1` with non-null `normalizedError` | `type` |
   | `missing-evidence` | delete `data.evidence` (terminal, expired) | `required` |
   | `failed-without-proof` | `*.failed.v1` with `noEffectProof: null` | `oneOf`/`type` |
   | `rejected-without-error` | `*.rejected.v1` with `normalizedError: null` | `$ref`/`type` |
   | `fee-on-refund-success` | `payment.refund.succeeded.v1` add `feeAmountMinor` | `false schema` (Ajv keyword `false schema`) |
   | `fee-reversal-on-capture` | capture success add `feeReversalAmountMinor` | `false schema` |
   | `fee-on-unrelated-type` | `payment.authorization.succeeded.v1` add `feeAmountMinor` | `false schema` |
   | `ledger-txn-on-non-posting-type` | authorization success `ledgerTransactionId = LTX` | `type` |
   | `capture-requested-missing-fee` | delete `data.feeAmountMinor` on capture requested | `required` |
   | `settlement-version-not-one` | `aggregateVersion = 2` on settlement | `const` |
   | `settlement-posting-key-pattern` | `data.postingKey = 'settlement:x'` | `pattern` |
   | `ledger-settlement-with-payment` | ledger SETTLEMENT with `paymentId = PAY` | `type` |
   | `invalid-traceparent` | `traceparent = '00-xyz'` | `pattern` |
3. `message-fixtures.test.ts`: (a) for each of the 26 types: `validateMessage(validMessages[type]).ok === true`; (b) for each negative case × applicable type: deep-clone, mutate, assert `failure === 'SCHEMA'` and at least one issue has the expected `keyword` and path prefix; (c) assert every registered type has ≥ 5 applicable negative cases (README "multiple negative fixtures for each registered type").
4. `merchant-webhook-payload.test.ts`: one valid payload per public type in docs/04 §Merchant webhook wire contract table (9), with `createdAt` exactly millisecond `Z`; negatives: `type payment.created.v1 rejected` (enum), `type settlement.batch.posted.v1 rejected`, `outcome/type mismatch` (refund.succeeded with `REJECTED`), `operationType/type mismatch`, `expired with outcome SUCCEEDED`, `createdAt without milliseconds`, `unknown field`, `provider identifiers not allowed` (add `data.providerPaymentId`).

**Expected behavior** — 26 positives pass; every negative fails with the asserted keyword; public payload allowlist enforced.

**Acceptance criteria**
- [ ] All ten README §Local validation item-6 defect classes (unknown fields, invalid UUID/date-time, overflow ULID, wrong prefix, zero amount, above max, mismatched outcome, missing evidence, invalid conditional fields) are present.
- [ ] Each negative assertion checks the failing keyword, not just `ok === false`.
- [ ] Every registered type has ≥ 1 positive and ≥ 5 negatives.

**Testing requirements**
- Files and cases as above. Command: `pnpm vitest run --project contracts test/contract/message-fixtures.test.ts test/contract/merchant-webhook-payload.test.ts`.

**Non-goals** — No semantic-mismatch fixtures (P00-T11); no producer code.

**Handoff checklist**
- [ ] One negative observed passing wrongly when the `keyword` assertion is removed and a different defect is introduced — then restored.
- [ ] Commit body contains `Task: P00-T10`.

---

### P00-T11 — Semantic correlation validator

**Task ID:** `P00-T11`
**Feature:** Contract validation
**Commit:** `feat(contracts): add post-schema semantic correlation validator`
**Priority:** Critical
**Dependencies:** P00-T10
**Estimated complexity:** M
**Contract references:** schemas/README §Required post-schema semantic correlation validator (lines 80-99), §Local validation expectations item 7; docs/04 §Envelope rules (lines 66-83: `schemaVersion` equals suffix; commands not subject to contiguity), §Required contract tests (line 354: settlement contiguity rejected), §Ordering and gaps; docs/03 §Monetary invariants; CONVENTIONS §9
**Files:** create: `packages/contracts/src/semantic.ts`, `packages/contracts/src/envelope.ts`, `test/contract/semantic.test.ts`, `test/contract/envelope.test.ts`, `test/contract/fixtures/semantic-mismatches.ts`; modify: `packages/contracts/src/validate.ts` (wire SEMANTIC branch), `packages/contracts/src/index.ts`; must not touch: `schemas/**`

**Objective** — Run the cross-field equality and invariant checks JSON Schema cannot express, after schema validation, for every message; a failure is an invariant error (`failure: 'SEMANTIC'`) that consumers route to the DLQ/discrepancy path.

**Implementation instructions**
1. Location decision: `packages/contracts/src/semantic.ts` (CONVENTIONS §3/§9). It has no internal imports; amounts are compared with `BigInt(string)` (strings are already pattern-validated).
2. API:
   ```ts
   export type SemanticRule =
     | 'SCHEMA_VERSION_MATCHES_TYPE_SUFFIX'
     | 'PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID'
     | 'PAYMENT_ORDERING_KEY_EQUALS_PAYMENT_ID'
     | 'EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION'
     | 'WEBHOOK_DELIVERY_AGGREGATE_ID_EQUALS_DELIVERY_ID'
     | 'LEDGER_AGGREGATE_ID_EQUALS_TRANSACTION_ID'
     | 'LEDGER_REFERENCES_MATCH_OPERATION_TYPE'
     | 'LEDGER_DEBITS_EQUAL_CREDITS'
     | 'SETTLEMENT_AGGREGATE_ID_EQUALS_BATCH_ID'
     | 'SETTLEMENT_ORDERING_KEY_EQUALS_MERCHANT_ID'
     | 'SETTLEMENT_AGGREGATE_VERSION_IS_ONE'
     | 'SETTLEMENT_POSTING_KEY_DERIVED'
     | 'RESOLUTION_SOURCE_EQUALS_EVIDENCE_SOURCE'
     | 'RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE'
     | 'TOTALS_SATISFY_PAYMENT_INVARIANTS';
   export interface SemanticViolation { readonly rule: SemanticRule; readonly path: string; readonly message: string }
   export function checkSemantics(envelope: RegisteredEnvelope): SemanticViolation[];
   export function checkMerchantWebhookSemantics(payload: Record<string, unknown>): SemanticViolation[];
   export function contiguityApplies(kind: 'COMMAND' | 'EVENT', type: string): boolean;
   export function assertContiguityApplicable(kind: 'COMMAND' | 'EVENT', type: string): void; // throws Error('CONTIGUITY_NOT_APPLICABLE: <type>')
   ```
3. Rules (all implementable without a database):
   | Rule | Applies to | Check |
   | --- | --- | --- |
   | `SCHEMA_VERSION_MATCHES_TYPE_SUFFIX` | all | `schemaVersion === Number(/\.v([1-9][0-9]*)$/.exec(type)[1])` |
   | `PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID` | `aggregateType === 'payment'` (execute, reconcile, created, 4 requested, 12 terminal, expired, reconciliation.required, review.required, discrepancy) | `aggregateId === data.paymentId` |
   | `PAYMENT_ORDERING_KEY_EQUALS_PAYMENT_ID` | same | `orderingKey === data.paymentId` |
   | `EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION` | `payment.operation.execute.v1` | `aggregateVersion === data.expectedPaymentVersion` |
   | `WEBHOOK_DELIVERY_AGGREGATE_ID_EQUALS_DELIVERY_ID` | `merchant.webhook.deliver.v1` | `aggregateId === data.deliveryId`. The README/docs/04 "no orderingKey" rule is **not** checked — see R-01 |
   | `LEDGER_AGGREGATE_ID_EQUALS_TRANSACTION_ID` | `ledger.transaction.posted.v1` | `aggregateId === data.ledgerTransactionId` |
   | `LEDGER_REFERENCES_MATCH_OPERATION_TYPE` | ledger | `SETTLEMENT` ⇒ `settlementBatchId` non-null and `paymentId`, `paymentOperationId` null/absent; `CAPTURE`/`REFUND` ⇒ inverse |
   | `LEDGER_DEBITS_EQUAL_CREDITS` | ledger | `BigInt(totalDebitsMinor) === BigInt(totalCreditsMinor)` |
   | `SETTLEMENT_*` (4 rules) | `settlement.batch.posted.v1` | `aggregateId === data.settlementBatchId`; `orderingKey === merchantId`; `aggregateVersion === 1`; `data.postingKey === 'settlement:' + data.settlementBatchId` |
   | `RESOLUTION_SOURCE_EQUALS_EVIDENCE_SOURCE` | any `data` having both `resolutionSource` and `evidence.source` (terminal family, expired) | equality |
   | `RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE` | terminal `*.rejected.v1`, `*.failed.v1` | `data.resultCode === data.normalizedError.code` |
   | `TOTALS_SATISFY_PAYMENT_INVARIANTS` | any `data.totalsAfter` (terminal, expired); public payload `data.totals` | `authorized <= requested`, `captured <= authorized`, `refunded <= captured`, `voided <= authorized - captured` |
4. `contiguityApplies(kind, type)`: `false` when `kind === 'COMMAND'` (docs/04:76) or `type === 'settlement.batch.posted.v1'` (docs/04:78, README:87); `false` for `ledger.transaction.posted.v1` (its aggregate is a transaction emitted once, not a payment stream) **[ASSUMPTION A-07]**; `true` for every other registered `EVENT`. P05's consumer registration MUST call `assertContiguityApplicable` before enabling contiguous-version enforcement.
5. Wire into `validateMessage`: after schema success run `checkSemantics`; non-empty → `{ ok: false, failure: 'SEMANTIC', issues: violations.map(v => ({ path: v.path, rule: v.rule, message: v.message })) }`. `validateMerchantWebhookPayload` likewise calls `checkMerchantWebhookSemantics`.
6. **Explicitly deferred (need authoritative DB rows; implemented by the consuming phase, not here):**
   - "An operation ID resolves to the stated payment and merchant" → each consumer reloads the operation scoped by `(merchant_id, payment_id, id)`: P05 (payment-worker execute command, inbox consumer core), P08 (reconcile command), P09 (projector/dispatcher).
   - "Provider, provider account, provider payment/operation references, and provider idempotency key match the immutable original operation" → P07 (terminal producers), P08 (reconciliation), P09 (provider webhook worker).
   - "A terminal success amount, currency, and operation type match the original accepted operation" → P07.
   - "A capture/refund success references the journal transaction posted with the original operation's stable posting key" → P07.
   Each deferral is listed in the module's top-of-file comment with the phase ID so consumers find it.
7. `packages/contracts/src/envelope.ts` (CONVENTIONS §9 builder used by every producer): `export function buildEnvelope(input: EnvelopeInput): RegisteredEnvelope` where `EnvelopeInput` is the generated envelope type with optional `traceparent`; it adds nothing the caller did not pass (no generated `id`, no clock read), runs `validateMessage`, returns a frozen copy on success, and throws `EnvelopeValidationError` (`issues` = the validation issues, `failure` = `'SCHEMA' | 'SEMANTIC'`) otherwise. Export it from `index.ts`.

**Expected behavior**
- `buildEnvelope` with a positive P00-T10 fixture returns an equal frozen object; with the execute-command semantic mismatch below throws `EnvelopeValidationError` with `failure: 'SEMANTIC'`.
- Execute command with `aggregateId = PAY` and `data.paymentId = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FB9'` (schema-valid) → `failure: 'SEMANTIC'`, rule `PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID`.
- `payment.refund.rejected.v1` with `resultCode: 'card_declined'`, `normalizedError.code: 'insufficient_funds'` → `RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE`.
- Terminal with `totalsAfter.capturedAmountMinor: '10001'`, `authorizedAmountMinor: '10000'` → `TOTALS_SATISFY_PAYMENT_INVARIANTS`.
- `assertContiguityApplicable('EVENT', 'settlement.batch.posted.v1')` throws; `('EVENT', 'payment.created.v1')` does not.

**Acceptance criteria**
- [ ] Every rule in the table has a schema-valid/semantically-mismatched fixture that passes Ajv and fails exactly that rule (for `LEDGER_REFERENCES_MATCH_OPERATION_TYPE`, `SETTLEMENT_AGGREGATE_VERSION_IS_ONE`, `SETTLEMENT_POSTING_KEY_DERIVED` and `SCHEMA_VERSION_MATCHES_TYPE_SUFFIX` the schema already rejects such inputs, so the test calls `checkSemantics` directly on the mutated object and asserts the rule — documented in the test).
- [ ] All 26 positive fixtures from P00-T10 produce zero violations.
- [ ] Deferred checks are listed with owner phases in the module header.
- [ ] Commands and settlement events are rejected by `assertContiguityApplicable`.

**Testing requirements**
- `test/contract/semantic.test.ts`: one case per rule `<RULE> mismatch detected`, `positive fixtures have no violations`, `validateMessage returns SEMANTIC for a schema-valid mismatch`, `voided boundary: voided == authorized - captured accepted, +1 rejected`, `refunded == captured accepted`, `contiguity: COMMAND rejected`, `contiguity: settlement rejected`, `contiguity: ledger rejected`, `contiguity: payment event accepted`, `public payload totals invariant`.
- `test/contract/envelope.test.ts`: `positive fixtures build`, `schema-invalid input throws SCHEMA`, `semantic mismatch throws SEMANTIC`, `result is frozen`, `no id generated when absent (throws)`.
- Command: `pnpm vitest run --project contracts test/contract/semantic.test.ts test/contract/envelope.test.ts test/contract/message-fixtures.test.ts`.

**Non-goals** — No DB lookups; no DLQ routing (P05); no change to the deliver-command orderingKey contract (R-01).

**Handoff checklist**
- [ ] Each rule test observed failing when its check is removed.
- [ ] Commit body contains `Task: P00-T11`.

---

### P00-T12 — Prohibited-data fixtures, detector, repository scan, and secret scanning config

**Task ID:** `P00-T12`
**Feature:** Security baseline
**Commit:** `feat(security): add prohibited-data fixtures, detector, contract scan, and gitleaks config`
**Priority:** High
**Dependencies:** P00-T10
**Estimated complexity:** M
**Contract references:** docs/10 §M0 ("secret scanning and prohibited-data fixtures for PAN/CVV/token redaction tests"), §CI lanes ("prohibited-data scan"); docs/04 §Sensitive data; docs/05 §General conventions, §Authentication (credential format `fl_test_<locator>_<secret>`); docs/06 §Redaction and retained evidence; docs/09 §Static checks (last bullet); CONVENTIONS §12
**Files:** create: `packages/testkit/src/prohibited-data.ts`, `packages/testkit/src/prohibited-data.test.ts`, `test/contract/prohibited-data-scan.test.ts`, `.gitleaks.toml`; modify: `packages/testkit/src/index.ts`; must not touch: contract files

**Objective** — Give every later task one set of synthetic prohibited values and one detector, and prove now that no contract file, fixture, or representative message contains prohibited data.

**Implementation instructions**
1. `packages/testkit/src/prohibited-data.ts`:
   ```ts
   export const PROHIBITED_FIXTURES = {
     pan: '4111111111111111',
     panFormatted: '4111 1111 1111 1111',
     cvvField: '{"cvv":"123"}',
     bearerCredential: 'Bearer fl_test_0123456789AB_' + 'A'.repeat(43),
     rawCredential: 'fl_test_0123456789AB_' + 'A'.repeat(43),
     providerSecret: 'sim_sk_test_0123456789abcdef0123456789abcdef',
     webhookSigningSecret: 'sim_whsec_0123456789abcdef0123456789abcdef',
   } as const;
   export type ProhibitedKind = 'PAN' | 'CARD_FIELD' | 'BEARER_CREDENTIAL' | 'MERCHANT_CREDENTIAL' | 'PROVIDER_SECRET';
   export interface ProhibitedFinding { readonly kind: ProhibitedKind; readonly index: number }
   export function findProhibitedData(text: string): ProhibitedFinding[];
   export function assertNoProhibitedData(label: string, text: string): void; // throws Error(`${label}: prohibited data (${kinds})`) — never echoes the match
   ```
   Detection rules:
   - `PAN`: runs of 15–19 digits, optionally grouped by single spaces or hyphens, not adjacent to `[A-Za-z0-9_]`, whose digits pass the Luhn check. 13–14 digit runs are excluded because valid money amounts reach 13 digits (`1000000000000`) **[ASSUMPTION A-08]**.
   - `CARD_FIELD`: JSON/property keys (case-insensitive) `cvv`, `cvc`, `cvv2`, `securityCode`, `security_code`, `cardNumber`, `card_number`, `pan`, `accountNumber` followed by `:` or `=`.
   - `BEARER_CREDENTIAL`: `/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/`.
   - `MERCHANT_CREDENTIAL`: `/fl_test_[0-9A-HJKMNP-TV-Z]{12}_[A-Za-z0-9_-]{43}/` (docs/05 format: 12-char Crockford locator, 32 bytes unpadded base64url).
   - `PROVIDER_SECRET`: `/sim_(sk|whsec)_[a-z_]*[0-9a-f]{32}/` **[ASSUMPTION A-09]** (P06 defines simulator secret formats and must extend this detector if they differ).
2. `.gitleaks.toml`: `[extend] useDefault = true`; `[allowlist] paths = ['''packages/testkit/src/prohibited-data\.ts''', '''packages/testkit/src/prohibited-data\.test\.ts''', '''infra/docker/\.env\.example''']`. Fixture values are synthetic; no other allowlist.
3. `test/contract/prohibited-data-scan.test.ts` scans with `findProhibitedData`: every file under `schemas/`, `openapi/`, `docs/` (all `.md`), `infra/`, `test/contract/fixtures/` (excluding intentionally negative fixtures — none contain prohibited data in P00), and `JSON.stringify` of every `validMessages` fixture and every valid merchant webhook payload ("representative messages"). Zero findings expected.

**Expected behavior** — Every fixture value yields at least one finding of its kind; `'1000000000000'`, ULIDs, UUIDs, SHA-256 hex digests, and `'Authorization: Bearer ...'` (docs placeholder) yield none.

**Acceptance criteria**
- [ ] Detector finds each of the seven fixture values with the correct kind.
- [ ] No false positive on: max amount, each ID constant from P00-T10, a 64-hex digest, an RFC 3339 timestamp, `Bearer ...`.
- [ ] `assertNoProhibitedData` error messages never contain the matched text.
- [ ] Repository scan finds nothing.

**Testing requirements**
- `packages/testkit/src/prohibited-data.test.ts`: `detects <fixture>` × 7, `luhn-invalid 16 digits not flagged` (`4111111111111112`), `13-digit amount not flagged`, `19-digit luhn-valid flagged`, `grouped with hyphens flagged`, `digits embedded in alnum token not flagged`, `CARD_FIELD key detection case-insensitive`, `docs placeholder Bearer ... not flagged`, `assert message omits match`.
- `test/contract/prohibited-data-scan.test.ts`: `contracts and docs contain no prohibited data`, `representative messages contain no prohibited data`, `infra and fixtures contain no prohibited data`.
- Command: `pnpm vitest run --project unit packages/testkit && pnpm vitest run --project contracts test/contract/prohibited-data-scan.test.ts`; gitleaks is exercised in CI (P00-T14).

**Non-goals** — No redaction allowlist implementation (P11, `packages/observability/src/redaction.ts`); no log scanning (no logs yet).

**Handoff checklist**
- [ ] Commit body contains `Task: P00-T12`.

---

### P00-T13 — Migration file naming and ordering check

**Task ID:** `P00-T13`
**Feature:** Contract validation
**Commit:** `test(contracts): enforce migration file naming, ranges, and ordering`
**Priority:** Medium
**Dependencies:** P00-T01
**Estimated complexity:** S
**Contract references:** docs/10 §M0 ("Validate … migration ordering in CI"); docs/07 §Migration order; CONVENTIONS §8 (names `NNNN_<slug>.sql`, lexical order, per-phase ranges, forward-only), §16 (`apps/provider-simulator/migrations/`)
**Files:** create: `test/contract/migration-order.test.ts`, `migrations/.gitkeep`; modify: none; must not touch: any `.sql` file

**Objective** — Before any migration exists, make CI reject misnamed, duplicated, or out-of-range migration files so parallel phases cannot collide.

**Implementation instructions**
1. In the test file export a pure function `checkMigrationNames(names: readonly string[], opts: { min: number; max: number }): string[]` returning human-readable findings:
   - Ignore exactly `.gitkeep`. Every other name must match `/^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/`.
   - Numbers unique (two files `0210_a.sql`, `0210_b.sql` → finding).
   - Number within `[min, max]`; for `migrations/` use `0200..1399` (CONVENTIONS §8 phase ranges); for `apps/provider-simulator/migrations/` (if the directory exists) use `0001..9999`.
   - Lexical order equals numeric order (guaranteed by fixed width; assert anyway).
2. Test applies it to the real directories (empty in P00 → zero findings) and to in-memory negative lists.

**Expected behavior** — `['0200_roles.sql', '0210_identity.sql']` → `[]`; `['200_roles.sql']` → name finding; `['0100_x.sql']` → range finding; `['0200_Roles.sql']` → name finding; `['0200_a.sql','0200_b.sql']` → duplicate finding; `['0200_a.SQL']` → name finding.

**Acceptance criteria**
- [ ] Real directories produce zero findings.
- [ ] Each negative list produces exactly one finding of the expected type.

**Testing requirements** — `test/contract/migration-order.test.ts` cases: `real migrations dir clean`, `real simulator migrations dir clean or absent`, `valid sequence accepted`, `three-digit number rejected`, `uppercase slug rejected`, `wrong extension rejected`, `duplicate number rejected`, `below range rejected`, `above range rejected`, `.gitkeep ignored`. Command: `pnpm vitest run --project contracts test/contract/migration-order.test.ts`.

**Non-goals** — No migration runner or checksum logic (P02-T01); no SQL linting (P02).

**Handoff checklist**
- [ ] Commit body contains `Task: P00-T13`.

---

### P00-T14 — CI workflow (fast + integration), `test:performance` stub, and development guide

**Task ID:** `P00-T14`
**Feature:** CI and developer documentation
**Commit:** `ci(repo): add fast and integration workflows with gitleaks and contract report artifacts`
**Priority:** Critical
**Dependencies:** P00-T02, P00-T04, P00-T05, P00-T06, P00-T07, P00-T08, P00-T09, P00-T10, P00-T11, P00-T12, P00-T13
**Estimated complexity:** M
**Contract references:** docs/10 §M0 Artifacts (README/command reference, CI with separate fast and integration jobs, version manifest and lockfile, contract validation report as CI artifact), §CI and verification lanes; CONVENTIONS §4, §13
**Files:** create: `.github/workflows/ci.yml`, `test/performance/run.mjs`, `docs/DEVELOPMENT.md`; modify: `package.json` (script `test:performance`); must not touch: `README.md` (contract file — R-10)

**Objective** — Every PR runs the fast gate (< 10 min target) and the integration gate in separate jobs, scans secrets, and retains the contract validation report; developers have one document listing every command.

**Implementation instructions**
1. `package.json`: `"test:performance": "node test/performance/run.mjs"`.
2. `test/performance/run.mjs`: prints `test:performance: not implemented until P12` to stdout and exits 0 (docs/10 §M0 requires the command now; P12 replaces the file).
3. `.github/workflows/ci.yml`:
   - `on: [push, pull_request]`; `permissions: contents: read`; `concurrency` per ref with cancel-in-progress.
   - Job `fast` (`ubuntu-24.04`, `timeout-minutes: 15`): `actions/checkout@v4` with `fetch-depth: 0`; `pnpm/action-setup@v4`; `actions/setup-node@v4` with `node-version-file: .nvmrc`, `cache: pnpm`; `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm typecheck`; `pnpm contracts:check`; `pnpm test:unit -- --reporter=default --reporter=junit --outputFile.junit=reports/unit-junit.xml`; `pnpm test:contracts -- --reporter=default --reporter=junit --outputFile.junit=reports/contracts-junit.xml --reporter=json --outputFile.json=reports/contracts.json`; gitleaks step: download pinned `gitleaks` release (exact version recorded in `docs/VERSIONS.md`), verify its published SHA-256 checksum, run `gitleaks git --config .gitleaks.toml --redact --exit-code 1 .`; `actions/upload-artifact@v4` name `contract-validation-report`, path `reports/`, `if: always()`, `retention-days: 30`.
   - Job `integration` (`needs: fast`, `ubuntu-24.04`, `timeout-minutes: 30`): same setup; `pnpm test:integration -- --reporter=default --reporter=junit --outputFile.junit=reports/integration-junit.xml`; upload `reports/` as `integration-report` `if: always()`.
   - No secrets referenced anywhere in the workflow.
4. `docs/DEVELOPMENT.md`: prerequisites (Node via `.nvmrc`, `corepack enable`, Docker), the single clean-clone command `corepack enable && pnpm install --frozen-lockfile && pnpm check`, then a command reference table copied from the P00 command inventory (including which commands are deferred and to which phase), how to run one test file (`pnpm vitest run --project <name> <path>`), `pnpm db:up`/`db:down` and the local ports (5432, 8085, 16686/4317/4318), and links to `docs/VERSIONS.md` and `docs/CONFIG.md`.

**Expected behavior** — A PR with a lint error fails `fast` and skips `integration`; a PR adding `^` to a dependency fails `fast` (dependency-policy test); a committed string matching a gitleaks default rule fails `fast`; `reports/contracts.json` downloadable from the run.

**Acceptance criteria**
- [ ] Two jobs, `integration` depends on `fast`.
- [ ] Contract report artifact uploaded even on failure.
- [ ] gitleaks binary version pinned and checksum-verified.
- [ ] `pnpm test:performance` exits 0 with the P12 message.
- [ ] `docs/DEVELOPMENT.md` lists every script in root `package.json` (checked by test below).

**Testing requirements**
- Add case `docs/DEVELOPMENT.md documents every root script` to `test/contract/dependency-policy.test.ts` (reads root `package.json` scripts and asserts each name appears in backticks in the doc).
- Validate the workflow locally with `actionlint` if available (record result in commit body; not a repo dependency).
- Command: `pnpm check`; push a branch and observe both jobs green (link the run in the commit body or PR).

**Non-goals** — No nightly/scheduled lanes (P12/P13); no deployment; no container/IaC scans (P11).

**Handoff checklist**
- [ ] One CI run observed red for a deliberate lint error, then green.
- [ ] Commit body contains `Task: P00-T14`.

---

### P00-GATE — M0 milestone verification

**Task ID:** `P00-GATE`
**Feature:** Milestone gate
**Commit:** `test(repo): verify M0 clean-clone static and contract gate`
**Priority:** Critical
**Dependencies:** P00-T01 … P00-T14
**Estimated complexity:** S
**Contract references:** docs/10 §M0 Test and acceptance criteria (all six bullets) and Artifacts; docs/09 §Quality gates; CONVENTIONS §15 Definition of Done
**Files:** create: `test/contract/m0-gate.test.ts`, `docs/evidence/P00.md`; modify: none; must not touch: any feature code

**Objective** — Prove the M0 exit gate end-to-end rather than per task.

**Implementation instructions**
1. `test/contract/m0-gate.test.ts`:
   - `each mandatory project runs at least one test file`: run `vitest list --project unit --json`, `--project contracts`, `--project integration` via `node:child_process` `execFileSync('pnpm', ['vitest', 'list', …])` and assert ≥ 1 file each (closes the `passWithNoTests` loophole, R-07).
   - `contract job fails on malformed schema`: in a temp dir copy `schemas/`, add `"typo": true` to `common/money.v1.schema.json`, run the generator/validator entry (`createMessageAjv` with injected schema list) → throws.
   - `contract job fails on unknown message field`: `validateMessage({ ...validMessages['payment.created.v1'], extra: 1 }).failure === 'SCHEMA'`.
   - `contract job fails on invalid OpenAPI example`: reuse the walker from P00-T09 on a mutated copy → ≥ 1 failure.
   - `every registry type maps to an existing schema and catalog parity holds`: call `checkRegistry` → `[]`.
   - `no app needs an undocumented secret`: assert every `process.env`/`env['X']`/`readPort(env,'X')`/`readFlag(env,'X')` variable name referenced under `apps/*/src` and `packages/config/src` (regex scan) appears in `infra/docker/.env.example`.
2. Manual clean-clone run (record outputs and durations in `docs/evidence/P00.md`): `git clone <repo> /tmp/fl-m0 && cd /tmp/fl-m0 && corepack enable && pnpm install --frozen-lockfile && pnpm check && pnpm test:integration && pnpm test:e2e && pnpm test:performance && pnpm db:up && pnpm db:down`.
3. `docs/evidence/P00.md`: table mapping each docs/10 §M0 acceptance bullet and artifact to the test case / file / CI run URL that proves it; the commit SHA; the CI run URL for both jobs; tool versions from `docs/VERSIONS.md`.

**Expected behavior** — All gate cases pass; the evidence note links a green CI run.

**Acceptance criteria**
- [ ] All six docs/10 §M0 acceptance bullets map to a passing test or recorded command.
- [ ] All four docs/10 §M0 artifacts exist (DEVELOPMENT.md command reference, CI with two jobs, VERSIONS.md + lockfile, contract report artifact).
- [ ] Clean-clone run recorded with commit SHA.

**Testing requirements** — `test/contract/m0-gate.test.ts` cases as listed. Command: `pnpm check && pnpm test:integration`.

**Non-goals** — No feature code; no fixes to earlier tasks inside this commit (a failure reopens the owning task).

**Handoff checklist**
- [ ] `docs/evidence/P00.md` complete with CI links.
- [ ] Commit body contains `Task: P00-GATE`.

---

## Parallelization

| Wave | Tasks that may run concurrently | Notes |
| --- | --- | --- |
| 1 | P00-T01 | Everything depends on it. |
| 2 | P00-T02, P00-T03, P00-T07, P00-T13 | T03 and T07 both edit `package.json` and `pnpm-lock.yaml` (T03 none if no deps; T07 adds devDeps) — rebase the second; T02 edits only `eslint.config.js` + tests. |
| 3 | P00-T04 (after T02, T03), P00-T06 (after T03), P00-T08 (after T07) | T04 and T06 both edit `package.json`/`pnpm-lock.yaml`/`docs/VERSIONS.md`; T04 edits root `tsconfig.json`. |
| 4 | P00-T05 (after T04), P00-T09 and P00-T10 (after T08) | T05 edits `test/contract/app-startup.test.ts` and `tsconfig.json` owned by T04 — serialize after T04. T09/T10 touch disjoint files. |
| 5 | P00-T11 (after T10), P00-T12 (after T10) | T11 edits `packages/contracts/src/validate.ts` and `index.ts`; T12 edits `packages/testkit/src/index.ts` (also touched by T06 — serialize after T06). |
| 6 | P00-T14, then P00-GATE | |

Shared-conflict files: `package.json`, `pnpm-lock.yaml`, `docs/VERSIONS.md`, `tsconfig.json`, `test/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/testkit/src/index.ts`, `test/contract/approved-dependencies.json`.

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M0: pnpm workspace, shared TS config, formatting, linting, dependency pinning | T01, T02 | `test/contract/dependency-policy.test.ts :: all manifests comply`; `pnpm check` |
| docs/10 M0: every application entry point with common config + graceful shutdown, inert | T03, T04, T05 | `test/contract/app-startup.test.ts :: <app> starts in test mode…` (11 apps); `packages/config/src/lifecycle.test.ts :: SIGTERM → stop once → exit(0)` |
| docs/10 M0: Docker Compose for PostgreSQL, Pub/Sub emulator, telemetry | T06 | `test/integration/simulator-db-bootstrap.test.ts :: server is PostgreSQL 17`; `docker compose config` |
| docs/10 M0: commands lint, typecheck, test:unit, test:integration, test:e2e, test:contracts, test:performance | T01, T14 | `test/contract/dependency-policy.test.ts :: docs/DEVELOPMENT.md documents every root script`; `docs/evidence/P00.md` clean-clone log |
| docs/10 M0: validate OpenAPI, JSON Schemas, registry, local refs, examples, migration ordering in CI | T08, T09, T13, T14 | `schemas.test.ts`, `registry.test.ts`, `openapi.test.ts`, `prose-examples.test.ts`, `migration-order.test.ts` |
| docs/10 M0: generate TS types; fail on uncommitted drift | T07 | `test/contract/contracts-drift.test.ts :: committed output matches fresh output`; `pnpm contracts:check` in CI |
| docs/10 M0: secret scanning + prohibited-data fixtures | T12, T14 | `packages/testkit/src/prohibited-data.test.ts`; `test/contract/prohibited-data-scan.test.ts`; CI gitleaks step |
| docs/10 M0: record Node, PostgreSQL, pnpm, Docker, Terraform versions | T01, T06 | `docs/VERSIONS.md` (review) |
| docs/10 M0 AC: clean clone green with one documented command | T14, GATE | `docs/evidence/P00.md` clean-clone run |
| docs/10 M0 AC: OpenAPI parses, local refs resolve | T09 | `openapi.test.ts :: openapi validates with swagger-parser` |
| docs/10 M0 AC: registry ↔ schema mapping; catalog one-to-one parity | T08 | `catalog-parity.test.ts :: command catalog == registry commands`, `:: event catalog == registry events` |
| docs/10 M0 AC: every schema compiles with UUID/date-time format assertion | T08 | `schemas.test.ts :: uuid format asserted`, `:: date-time format asserted` |
| docs/10 M0 AC: malformed schema, unknown message field, invalid OpenAPI example fail the contract job | T08, T09, T10, GATE | `m0-gate.test.ts :: contract job fails on malformed schema / unknown message field / invalid OpenAPI example` |
| docs/10 M0 AC: no app needs undocumented local secret in test mode | T03, T04, T05, GATE | `app-startup.test.ts`; `m0-gate.test.ts :: no app needs an undocumented secret` |
| docs/10 M0 artifacts: dev README + command reference | T14 | `docs/DEVELOPMENT.md`; dependency-policy test case |
| docs/10 M0 artifacts: CI with separate fast and integration jobs | T14 | `.github/workflows/ci.yml` (review), CI run link in `docs/evidence/P00.md` |
| docs/10 M0 artifacts: version manifest + lockfile | T01 | `docs/VERSIONS.md`, `pnpm-lock.yaml` |
| docs/10 M0 artifacts: contract validation report retained in CI | T14 | `contract-validation-report` artifact |
| docs/10 CI lanes (every PR): format, lint, strict typecheck, dependency-policy | T01, T02, T14 | `lint-rules.test.ts`, `dependency-policy.test.ts`, CI `fast` |
| docs/10 CI lanes: OpenAPI/JSON-Schema parse, ref, registry, generated-type drift | T07–T09, T14 | as above |
| docs/10 CI lanes: unit + property tests with fixed regression seeds | T14 (lane), P01-T01 (seed config) | CI `fast` step `pnpm test:unit` |
| docs/10 CI lanes: prohibited-data scan | T12, T14 | `prohibited-data-scan.test.ts` |
| docs/10 CI lanes: migration lint + empty-DB migration when migrations change | T13 (naming); empty-DB migration deferred to P02 | `migration-order.test.ts` |
| docs/10 CI lanes (DB/domain): PostgreSQL integration suite on real supported version | T06, T14 | CI `integration` job; `simulator-db-bootstrap.test.ts :: server is PostgreSQL 17` |
| schemas/README Validator req.: no remote fetch; local `$id` resolution | T08 | `schemas.test.ts :: remote $ref is rejected without network` |
| schemas/README Validator req.: format assertion uuid/date-time | T08 | `schemas.test.ts :: uuid/date-time format asserted` |
| schemas/README Validator req.: unknown keywords are configuration errors | T08, T09 | `schemas.test.ts :: unknown keyword is a configuration error`; `openapi.test.ts :: unregistered x- keyword…` |
| schemas/README Validator req.: all schemas compiled in CI even if unreferenced | T08 | `schemas.test.ts :: every schema compiles…` (includes webhook + manifest) |
| schemas/README Registry rules 1–5 | T08 | `registry.test.ts :: rule1…rule5`; `catalog-parity.test.ts` (rule 4) |
| schemas/README Local validation 1–4 | T08 | `schemas.test.ts` |
| schemas/README Local validation 5–6 (positive + multiple negatives per type; listed defect classes) | T10 | `message-fixtures.test.ts` |
| schemas/README Local validation 7 (semantic validator vs mismatched-identity fixtures) | T11 | `semantic.test.ts :: <RULE> mismatch detected` |
| schemas/README semantic: payment aggregateId/orderingKey == paymentId | T11 | `semantic.test.ts :: PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID`, `:: PAYMENT_ORDERING_KEY_EQUALS_PAYMENT_ID` |
| schemas/README semantic: execute aggregateVersion == expectedPaymentVersion | T11 | `:: EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION` |
| schemas/README semantic: deliver aggregateId == deliveryId; no orderingKey | T11 (aggregateId); orderingKey rule blocked by R-01 | `:: WEBHOOK_DELIVERY_AGGREGATE_ID_EQUALS_DELIVERY_ID` |
| schemas/README semantic: ledger aggregateId; references by operationType; debits == credits | T11 | `:: LEDGER_*` |
| schemas/README semantic: settlement aggregate/ordering/version/postingKey | T11 | `:: SETTLEMENT_*` |
| schemas/README semantic: resolutionSource == evidence.source | T11 | `:: RESOLUTION_SOURCE_EQUALS_EVIDENCE_SOURCE` |
| schemas/README semantic: resultCode == normalizedError.code | T11 | `:: RESULT_CODE_EQUALS_NORMALIZED_ERROR_CODE` |
| schemas/README semantic: totalsAfter invariants | T11 | `:: TOTALS_SATISFY_PAYMENT_INVARIANTS`, `:: voided boundary…` |
| schemas/README semantic: operation→payment/merchant; provider binding; success amount/type; posting-key reference | Deferred: P05, P07, P08, P09 | listed in `packages/contracts/src/semantic.ts` header |
| docs/04 Envelope: schemaVersion equals `.vN` suffix | T08 (registry rule 3), T11 | `registry.test.ts :: rule3 schemaVersion/suffix mismatch`; `semantic.test.ts :: SCHEMA_VERSION_MATCHES_TYPE_SUFFIX` |
| docs/04 Envelope: unknown/missing fields are schema errors | T10 | `message-fixtures.test.ts :: unknown-envelope-field`, `:: missing-evidence` |
| docs/04 Required contract test: validate every produced envelope against schema | T08, T10 (producers in later phases call `validateMessage`) | `message-fixtures.test.ts` |
| docs/04 Required contract test: merchant webhook payload schema + type/operation/outcome table | T10, T11 | `merchant-webhook-payload.test.ts` |
| docs/04 Required contract test: payload outside allowlist fails before delivery row | T10 (schema half) | `merchant-webhook-payload.test.ts :: type payment.created.v1 rejected` |
| docs/04 Required contract test: settlement schema, identity rules, contiguity rejected by semantic validator | T10, T11 | `semantic.test.ts :: contiguity: settlement rejected`, `:: SETTLEMENT_*` |
| docs/04 Required contract test: ledger event accepts SETTLEMENT with no payment refs | T10, T11 | `message-fixtures.test.ts :: ledger-settlement-with-payment`; positive `ledger.transaction.posted.v1` SETTLEMENT variant |
| docs/04 Required contract test: scan representative messages for prohibited data | T12 | `prohibited-data-scan.test.ts :: representative messages…` |
| docs/04 Schema evolution: unsupported version → terminal schema error (DLQ) | T08 (signal), P05 (routing) | `registry.test.ts :: validateMessage unregistered type → UNREGISTERED_TYPE` |
| docs/09 Static: TS strict; lint forbids `number` in money types and direct journal writes | T01, T02 | `lint-rules.test.ts :: money/*`, `:: ledger-dml/*` |
| docs/09 Static: OpenAPI parses, refs, component + prose examples; problem-code rules | T09 | `openapi.test.ts`, `prose-examples.test.ts` |
| docs/09 Static: schemas compile; registry unique/resolvable; docs catalog parity | T08 | `schemas.test.ts`, `registry.test.ts`, `catalog-parity.test.ts` |
| docs/09 Static: positive + high-risk negative fixtures per type | T10 | `message-fixtures.test.ts` |
| docs/09 Static: semantic checks incl. merchant webhook correlation | T10, T11 | `semantic.test.ts`, `merchant-webhook-payload.test.ts` |
| docs/09 Static: producers/consumers compile against generated types | T07 | `pnpm typecheck` over `packages/contracts/src/generated/messages.ts` |
| docs/09 Static: secrets + prohibited-data scanned from source/fixtures/messages | T12, T14 | gitleaks CI step; `prohibited-data-scan.test.ts` |
| docs/05 Canonical error format: exact codes | T09 | `openapi.test.ts :: problem codes in docs/05 equal ProblemCode enum` |
| CONVENTIONS §3 dependency direction enforced by ESLint | T02 | `lint-rules.test.ts :: boundary/*` |
| CONVENTIONS §16 simulator DB + roles; SIMULATOR_DATABASE_URL harness-only | T03, T05, T06, T02 | `simulator-db-bootstrap.test.ts`; `lint-rules.test.ts :: simulator-url/*` |
| docs/08 required failure-injection tests | none in M0 (no runtime behavior) | n/a |

## Phase risks / open questions

| ID | Risk / conflict | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | `merchant.webhook.deliver.v1` ordering key contradiction. `schemas/common/message-envelope.v1.schema.json:18,55` makes `orderingKey` required (minLength 1) and `schemas/commands/merchant-webhook-deliver.v1.schema.json:14` pins it to a `whe_` ID; `docs/04-EVENT_CONTRACTS.md:79,102,106,353,363` and `schemas/README.md:86` say the command carries **no** ordering key; `docs/10-IMPLEMENTATION_PLAN.md:540` says "per-endpoint ordering key". | A schema-valid deliver command must carry an ordering key, so the docs/04:353 contract test ("published without an ordering key") cannot pass. | High | Contract-owner commit before P09: make `orderingKey` optional in the envelope and set `"orderingKey": false` in the deliver schema (unpublished v1, so in-place), update docs/10:540. Binding until decided (README D-06): the deliver command carries `orderingKey` = webhook endpoint ID per its machine schema, the relay passes it unchanged, and the dispatcher subscription is unordered; P00 checks only `aggregateId === data.deliveryId` and fixtures use `orderingKey = endpointId`. | P09 delivery publication (not P00) |
| R-02 | `docs/05-API_AND_IDEMPOTENCY_CONTRACT.md:314-353` timeline example lacks required `truncated` (`openapi/openapi.yaml:1241-1245`). | Prose-example validation cannot be fully green. | Low | Contract fix: add `"truncated": false` to the docs/05 example. P00-T09 records it as `knownDeviation` asserting it is the *only* error; remove the entry when fixed. | none |
| R-03 | `openapi/openapi.yaml:1300-1306` says timeline `detail` per-kind shapes "are enumerated in docs/05", but `docs/05:357` only states "closed per-kind object" without listing shapes. | P04 cannot write per-kind validators from the contract. | Medium | Contract owner enumerates per-kind `detail` shapes before P04 timeline work. | P04 (timeline) |
| R-04 | Ajv `strict: true` fails on the checked-in schemas (strictTypes/strictRequired). | A naive "strict" configuration blocks CI. | Medium | Use the binding option set in P00-T08 (`strictSchema: true`, others off) — satisfies `schemas/README.md:21-31`, which only requires unknown keywords to be errors. Verified during planning. | none |
| R-05 | `docs/09-TEST_AND_PERFORMANCE_PLAN.md:85` requires lint rules forbidding `number` in money types; CONVENTIONS §5 (line 139) says an ESLint rule is not feasible. | Ambiguous enforcement. | Low | P00-T02 adds a narrow, feasible rule scoped to `packages/domain/src/money.ts` and `fees.ts`; reviewer grep stays for other money paths. | none |
| R-06 | CONVENTIONS §16 forbids `SIMULATOR_DATABASE_URL` outside testkit/cli, but the simulator service itself needs an owner-role connection string; none is named. | P06 would need to violate the lint rule or invent a name. | Medium | **[ASSUMPTION A-03]** `PROVIDER_SIMULATOR_DATABASE_URL` (role `fl_simulator`) is read only by `apps/provider-simulator`; lint-enforced. Coordinator should add it to CONVENTIONS §16. | none (P06 consumes) |
| R-07 | `passWithNoTests: true` could hide a broken glob. | False green. | Low | P00-GATE asserts unit/contracts/integration each list ≥ 1 test file; e2e/chaos legitimately empty until later phases. | none |
| R-08 | API `/healthz` and `/readyz` are not in `openapi.yaml`; docs/05 §MVP API decisions say Nest route metadata is compared with the document. | P04 route-drift check would flag them. | Low | **[ASSUMPTION A-04]** Health routes are registered on the raw Fastify instance (not Nest controllers) and P04's drift check compares Nest controller routes only. | none |
| R-09 | PUBLIC retains `CONNECT` on the main FlowLedger database, so `fl_simulator` can open a connection (no object privileges after P02). CONVENTIONS §16 says the simulator has no privilege on the FlowLedger DB. | Weaker isolation than stated. | Low | P02 roles migration should `REVOKE CONNECT ON DATABASE <current> FROM PUBLIC` via `EXECUTE format(... current_database())` and grant CONNECT to each `fl_*` role. | none |
| R-10 | docs/10 §M0 artifact "Root development README" vs `README.md` being a contract file. | Editing README risks contract drift. | Low | **[ASSUMPTION A-10]** Developer guide lives in `docs/DEVELOPMENT.md`; contract owner may add one link from README. | none |
| R-11 | Resolved: topic names are the contract names `flowledger-commands-v1`/`flowledger-events-v1` (`docs/04-EVENT_CONTRACTS.md:359`; CONVENTIONS §9 now matches). | — | Low | Closed. | P05 |
| R-12 | `openapi/openapi.yaml:974` example `pm_sandbox_123` vs `docs/05:684` "fake provider accepts only `pm_fake_...`". | Example is schema-valid but not an accepted token. | Low | P04 tests must use `pm_fake_` tokens; contract owner may update the example. | none |
| A-05 | **[ASSUMPTION]** `SIMULATOR_TEST_ENDPOINTS=1` is refused when `NODE_ENV=production`. | Safety default. | Low | Keep; P06 may extend. | none |
| A-06 | **[ASSUMPTION]** Jaeger all-in-one (OTLP) is the dev telemetry service; metrics backend deferred to P11. | Metrics not viewable locally until P11. | Low | P11 adds Prometheus/Grafana if needed. | none |
| A-07 | **[ASSUMPTION]** `ledger.transaction.posted.v1` is excluded from payment-style contiguity (aggregate is a transaction emitted once). | Consumer configuration. | Low | Confirm with contract owner; docs/04 only names settlement explicitly. | none |
| A-08 | **[ASSUMPTION]** PAN detector ignores 13–14 digit runs to avoid flagging valid amounts. | Legacy 13-digit PANs undetected. | Low | Acceptable for synthetic-data project. | none |
| A-09 | **[ASSUMPTION]** Simulator secret fixture format `sim_sk_…`/`sim_whsec_…`. | Detector mismatch if P06 picks another format. | Low | P06 updates fixtures + detector in the same commit as its secret format. | none |
