# Implementation progress log

Running log for the execution-plan implementation. Appended after every task.
Format per entry: task ID, status (`DONE` / `BLOCKED` / `NEEDS-REVIEW`), commit SHA,
commands run with pass/fail counts, deviations, open questions.

---

## Session 1 — orientation and Step 1 (contract fixes)

### Step 0 — Baseline commit

**Status:** `DONE` (satisfied before this session; no action taken)

`git log` showed one commit, `e9123d8 initial commit`, containing `README.md`,
`docs/00`–`docs/10`, `docs/adr/*`, `docs/execution-plan/**`, `openapi/openapi.yaml`,
and `schemas/**` — exactly the baseline Step 0 describes.

Deviation: the baseline commit predates this session and its message is
`initial commit`, not the prescribed `docs: add contracts and execution plan`
(body `Baseline before implementation.`). Step 0 is conditional on `git log` being
empty, which it was not, so no commit was made and history was not rewritten.

### Step 1 — Contract fixes 1–9 (README §10.6)

**Status:** `DONE` — owner approved all nine; merged into `main` (linear, fast-forward,
no merge commits). SHAs below are the post-rebase SHAs on `main`.

| # | Commit | Files | What it fixed |
| --- | --- | --- | --- |
| 1 | `816eed3` | `schemas/common/entity-ids.v1.schema.json`, `schemas/README.md` | `$defs` 12 → 22: 9 DB-only prefixes + wire-visible `req_`; prefix table in `schemas/README.md` |
| 2 | `387b1aa` | `docs/05` | `"truncated": false` in the timeline example |
| 3 | `dadb047` | `openapi/openapi.yaml` | `Problem422` added to `Problem.oneOf` (13 members) |
| 4 | `8f9ab55` | `openapi/openapi.yaml` | Refund description → ADR-0003 concurrent class + reservation bound |
| 5 | `b8c7522` | `openapi/openapi.yaml`, `docs/05` | `pm_sandbox_123` → `pm_fake_approveDemo` (both examples) |
| 6 | `64e42bb` | `docs/01`, `docs/04`, `schemas/README.md` | Ordering key `none` → endpoint ID (D-06) |
| 7 | `2417fdc` | `docs/02`, `docs/07`, `docs/09`, `docs/10`, P02-T07 | `fee_policies_fee_within_minimum` insertion rule (D-07) |
| 8 | `373a0ff` | `README.md`, `docs/10` | Dual approval built; only tiers/expiry/notifications/UI deferred (D-01) |
| 9 | `69e161a` | `docs/10` | Discrepancy event M7 → M8 (needs `caseId`) |
| — | `06cf7ee` | P00, P04 task files | `docs(plan):` — retires the R-02 `knownDeviation` and the R-10 `Problem422` workaround |

**Commands run:** `git log`, `git status`, `git diff --stat`, `git rebase` + `git merge --ff-only`
per branch, plus Python structural verification per fix. No `pnpm` command exists yet —
`pnpm check` and friends are `not yet available (created by P00-T01/T07)`.

**Verification on merged `main`** (16 assertions, all passing): every `docs/07` PK
prefix is now defined in `entity-ids`; `$defs` = 22 with the 9 DB-only ones described
as such; timeline example carries `truncated` and the plan no longer expects a
deviation; `Problem422` is a `Problem.oneOf` member; refund wording matches ADR-0003;
no `pm_sandbox` remains in any contract; ordering key = endpoint ID in all three
files; the fee constraint body appears verbatim plus three consistent references;
P02-T07's fixture policy is now insertable; README states dual approval is built and
no `single-principal` claim survives; the discrepancy path sits in M8.

**Fix 7 correctness argument** (the only fix that changed behavior, not just prose):
the old rule ("minimum ≥ fixed component ⇒ `fee ≤ gross`") is false because the
percentage component is charged on top — `B=5000, K=30, min=30` admits `G=40` with
fee `50`. The new rule is
`floor((minimum*bp + 5000)/10000) + fixed <= minimum`. Brute force over `bp` 0–10000,
five fixed components, seven minimums and captures to 10^12 found no insertable
policy admitting `fee > gross`; the counterexample is rejected; `fee == gross` stays
reachable (`bp=10000, K=0, min=1`); the intermediate product is ≤ 10^16, inside
`bigint`.

**Consequence found and fixed during review:** P02-T07's own fixture default was
`290 bp / fixed 30 / minimum 30`, which the new rule makes uninsertable
(`fee(30) = 31 > 30`), so `createTestMerchant` could not have inserted the policy it
documents. Default minimum is now 50 (matching the P02 dev seed and the P07 fixture);
the accepted boundary example is minimum 31, where `fee == gross`.

### Step 1b — plan reconciliation (owner-approved follow-ups)

**Status:** `DONE` — three `docs(plan):` commits, one per phase file, merged
fast-forward into `main`. Resolves items 1–3 of the open list below.

| Commit | File | Change |
| --- | --- | --- |
| `01469a6` | `tasks/P01-domain-kernel.md` | `checkFeePolicy` case `bp 290/30/min 30 accepted` → `min 31 accepted` + `min 30 rejected`; notes that `pm_sandbox_123` in the request-hash vectors is a synthetic input (digests unchanged) |
| `ba22053` | `tasks/P05-command-acceptance-messaging.md` | documented policy floor 30 → 50 (matches P02-T07 fixture + dev seed); boundary capture 29 → 49; HTTP mapping `DETAIL` 30 → 50 |
| `48619a6` | `tasks/P00-repository-foundation.md` | R-01 closed on D-06; the ordering rule `orderingKey === data.endpointId` is now enforced as `WEBHOOK_DELIVERY_ORDERING_KEY_EQUALS_ENDPOINT_ID` in both the `SemanticRule` union and the rule table, replacing three "not checked / blocked by R-01 / do not touch" instructions |

**Verification:** all seven P01 `checkFeePolicy` cases recomputed against
`floor((minimum*bp+5000)/10000) + fixed <= minimum` and confirmed; P05's documented
`fee 320` and its `(0 bp, fixed 500, minimum 500)` example still hold; P01's eight
golden vectors and both SHA-256 digests confirmed untouched; P00's `SemanticRule`
union (16) reconciles with its rule table (13 rows, one collapsing the four
`SETTLEMENT_*` rules); no "not checked", "blocked by R-01", or stale "no
orderingKey" claim remains in any touched file.

**Owner decisions taken during this step:** use the tightest boundary (31) for P01;
align P05 to the fixture floor (50) rather than the tightest valid (31); leave the
hash golden vectors alone and document the token as synthetic; commit one file per
commit.

### Open items carried forward

4. **`pm_sandbox_123` in P01 hash golden vectors** — closed as *by design*: request
   hashing never validates the token, the two digests are unchanged, and P01 now
   says so in place. Revisit only if a future reader mistakes it for a valid token.
5. **`fee_policies_minimum_capture` is subsumed by `fee_policies_fee_within_minimum`**
   for any minimum below the fixed component. Deliberately left in place: keeping a
   redundant safety `CHECK` is the safe default, and P02-T07 instructs overlapping
   negatives to assert SQLSTATE `23514` rather than a constraint name.

No blocking items remain before `P00-T01`.

**Next task:** `P00-T01`.

---

## P00-T01 — Workspace, toolchain pins, project references, and test projects

**Status:** `NEEDS-REVIEW` — all gates green, awaiting owner approval before P00-T02.

```text
TASK P00-T01 — NEEDS-REVIEW
Commit: 430e860 on task/p00-t01-workspace-toolchain
Acceptance criteria:
  - every dep spec exact or workspace:* -> met (9 manifests, 0 non-exact specs)
  - packageManager/engines.node/.nvmrc agree and recorded in docs/VERSIONS.md -> met
    (.nvmrc 24.22.1 = engines.node 24.22.1; packageManager pnpm@10.34.9)
  - tsc -b succeeds with the step-5 strict flags -> met (and proven able to fail:
    a `const bad: number = "s"` in a package source yields TS2322)
  - vitest.config.ts defines exactly unit/contracts/integration/e2e/chaos with the
    CONVENTIONS §4 globs -> met; each of the five resolves via `--project <name>`
  - pnpm check exits 0; pnpm lint does not touch contract files -> met
Tests added: none — the task states "No test files in this task".
  Break-and-restore proof instead (all restored):
    1. strict-mode violation in packages/domain/src/index.ts -> tsc -b exit 1 (TS2322)
    2. prettier spec `^3.9.10` -> install exit 1 (ERR_PNPM_OUTDATED_LOCKFILE)
    3. vitest project renamed -> `--project chaos` exit 1
    4. .prettierignore entry removed -> prettier exit 1 on 17 plan files
Commands: pnpm install --frozen-lockfile -> 0
          pnpm check -> 0 (lint 0, typecheck 0, test:unit 0 "no test files",
                           test:contracts 0 "no test files")
          pnpm test:integration -> 0 | pnpm test:e2e -> 0
          clean clone (/tmp): install --frozen-lockfile 0, check 0,
                              test:integration 0, test:e2e 0
Deviations from the task text:
  1. .prettierignore extended with docs/10-IMPLEMENTATION_PLAN.md, docs/execution-plan,
     .pnpm-store, .reasonix. `prettier --check .` covers Markdown; without these the
     gate fails on 187 files and the only other fix is `prettier --write`, which would
     reformat docs/10 and the binding plan — forbidden (contracts change only in
     owner-approved commits). Break 4 above is the evidence that these entries are
     load-bearing.
  2. .gitignore merges the task's required entries with the four already present
     (*.log, .env.*, !.env.example) and adds .pnpm-store/.
  3. `test/tsconfig.json` builds cleanly with no test files, contrary to my pre-flight
     concern about TS18003; verified `tsc -p test/tsconfig.json` exits 0, so no
     placeholder file was added.
Contract/plan issues found: none.
Next task: P00-T02 (dependencies satisfied: yes — P00-T01).
```

**Environment note (not a task deviation).** Node 24.22.1 and pnpm 10.34.9 were not
installed on this machine, and `~/.nvm/versions/node` is not writable by the agent
sandbox (`Operation not permitted`), so nvm could not install the pinned Node. The
gates were run against a sandbox-local extract of the official
`node-v24.22.1-darwin-arm64` tarball (`/tmp/fl-node24`) with Corepack providing
pnpm 10.34.9 from `packageManager`. Nothing on the host was modified. On a normal
machine `nvm install && corepack enable` reproduces this exactly; `.nvmrc` and
`engines.node` pin it either way.

## P00-T02 — ESLint policy rules and dependency-policy check

**Status:** `NEEDS-REVIEW` — all gates green, awaiting owner approval before P00-T03.

```text
TASK P00-T02 — NEEDS-REVIEW
Commit: cbd19da on task/p00-t02-lint-policy
Acceptance criteria:
  - every boundary row errors on one forbidden import, silent on one allowed -> met
    (16 cases: boundary/<pkg>/forbidden + /allowed for all 8 packages)
  - both simulator variables rejected outside their allowed dirs, accepted inside -> met
    (SIMULATOR_DATABASE_URL: rejected in providers/payment-worker incl. bracket access,
    accepted in testkit/cli/test; PROVIDER_SIMULATOR_DATABASE_URL: rejected in api,
    accepted in provider-simulator)
  - money and ledger-DML rules fire on positives, silent on controls -> met
  - dependency-policy test fails on a mutated in-memory manifest -> met (checker is
    exported; negative cases feed objects, never files)
  - pnpm check green -> met
Tests added: test/contract/lint-rules.test.ts :: 42 cases
             test/contract/dependency-policy.test.ts :: 10 cases
  break-and-restore (each observed failing, then restored):
    boundary configs removed            -> 10 failed
    simulator selectors removed         ->  5 failed
    money selectors removed             ->  5 failed
    ledger selectors removed            ->  5 failed
    exact-version check disabled        ->  2 failed
    checker returns no findings         ->  5 failed
    baseline after restore              -> 42 and 10 passing
Commands: pnpm check -> 0 (52 contract tests) | pnpm test:integration -> 0
          pnpm test:e2e -> 0 | eslint . -> 0
          clean clone: install --frozen-lockfile 0, check 0
Deviations from the task text:
  1. Steps 2-4 describe four separate `no-restricted-syntax` config objects. A file
     such as packages/domain/src/money.ts matches four of them, and flat config
     replaces the rule wholesale on the last match, so following the steps literally
     would drop the ledger and simulator rules in money.ts. Each config now carries a
     complete selector set for the files it matches; two regression cases pin it
     (money/ledger-rule-still-applies-in-money-file,
     money/simulator-rule-still-applies-in-money-file).
  2. approved-dependencies.json adds `approvedPatterns` because CONVENTIONS §2 names
     "OTLP exporters" as a family, not packages. Encoded as
     ["@opentelemetry/exporter-"] instead of inventing concrete exporter names.
Contract/plan issues found: none. (docs/09:85 asks for "no number in money-domain
types" without naming files; the task narrows it to money.ts/fees.ts per R-05, which
is followed.)
Next task: P00-T03 (dependencies satisfied: yes — P00-T01).
```

## P00-T03 — Base configuration, lifecycle, `.env.example`, and `docs/CONFIG.md`

**Status:** `NEEDS-REVIEW` — all gates green, awaiting owner approval before P00-T04.

```text
TASK P00-T03 — NEEDS-REVIEW
Commit: 5ef53ee on task/p00-t03-base-config
Acceptance criteria:
  - no message from packages/config contains a variable's value -> met
    (ConfigError builds `${variable}: ${reason}` from fixed phrases; proven by break 4)
  - runMain calls stop at most once across repeated signals -> met (break 1)
  - health server returns the exact bodies/status codes -> met
    (/healthz 200 {"status":"ok"}, /readyz 503 {"status":"not_ready"} then
     200 {"status":"ready"}, unknown path 404, port 0 reports the bound port)
  - every .env.example variable has a CONFIG.md row and vice versa -> met
    (13 = 13, enforced by a test; break 5)
Tests added: packages/config/src/base.test.ts :: 16 cases
             packages/config/src/lifecycle.test.ts :: 11 cases
  break-and-restore (each observed failing, then restored):
    once-only shutdown guard removed   -> `second signal ignored` fails  [handoff item]
    grace timeout removed              -> `stop exceeds grace exits 1` fails
    readiness gating removed           -> `/readyz 503 then 200` fails
    ConfigError echoes value           -> `non-integer ... not echoed` fails
    CONFIG.md row renamed              -> parity test fails
    Object.freeze removed              -> `result is frozen` fails
    baseline after restore             -> 27 passing
Commands: pnpm check -> 0 (27 unit + 52 contract) | pnpm test:integration -> 0
          pnpm test:e2e -> 0 | eslint . -> 0
          clean clone: install --frozen-lockfile 0, check 0
Deviations from the task text:
  1. `.env.example` carries a `# Consumer:` line above each variable. The task prose
     requires "every line commented with its consumer" while its sample block shows
     no comments; followed the prose.
  2. `docs/CONFIG.md` adds the two required restricted-reader notes plus a short
     "Not in this table yet" section (DATABASE_URL arrives P02; the secret resolver P06).
Contract/plan issues found: **P00 phase-overview interface table (line 24) disagrees
with this task's body and with its consumer.** It states
`startHealthServer(port: number, isReady: () => boolean)`; the task body's signature
block and P00-T04 step 5 (`startHealthServer(readPort(env, 'HEALTH_PORT'))` then
`health.setReady(true)`) both use `startHealthServer(port)` returning an object with
`setReady`. Implemented the body/consumer form — 2 of 3 sources including the real
caller. Proposed `docs(plan):` edit: change line 24 to
`startHealthServer(port: number): Promise<HealthServer>; interface HealthServer { readonly port: number; setReady(ready: boolean): void; close(): Promise<void> }`.
Not applied: outside this task's Files list.
Next task: P00-T04 (dependencies satisfied: yes — P00-T01).
```

## P00-T04 — Inert NestJS application entry points (API + eight workers)

**Status:** `NEEDS-REVIEW` — all gates green, awaiting owner approval before P00-T05.

```text
TASK P00-T04 — NEEDS-REVIEW
Commit: 00c74c0 on task/p00-t04-app-entry-points
Acceptance criteria:
  - nine apps exist with the CONVENTIONS §3 names and `@flowledger/app-<dir>` -> met
    (45 files: 9 x {package.json, tsconfig.json, src/{main,index,app.module}.ts})
  - no main.ts reads process.env; only index.ts touches the process -> met (enforced by
    a test, proven by break 5)
  - app-startup.test.ts passes using only .env.example values -> met (14 cases)
  - pnpm build emits apps/<app>/dist/index.js for all nine -> met (verified per app)
  - node apps/api/dist/index.js and payment-worker start and exit 0 on SIGTERM -> met
    (manual check: both exit 0)
Tests added: test/contract/app-startup.test.ts :: 14 cases
  break-and-restore (each observed failing, then restored):
    api requires an extra var absent from .env.example -> 2 fail  [handoff item]
    api /readyz returns 503                            -> 1 fails
    api drops parseBaseConfig                          -> 1 fails
    worker stop omits health.close()                   -> 1 fails
    a main.ts reads process.env                        -> 1 fails
    baseline after restore                             -> 14 passing
Commands: pnpm check -> 0 (14 startup + 66 contract) | pnpm build -> 0
          pnpm test:integration -> 0 | pnpm test:e2e -> 0
          clean clone (committed state): install --frozen-lockfile 0, check 0, build 0
Deviations from the task text:
  1. The startup test imports each app relatively (`../../apps/<app>/src/main.js`)
     rather than as `@flowledger/app-<app>/main`. Verified cause: vitest externalises
     workspace packages, so the bare specifier resolves through Node and picks the
     package's `default` export condition -> unbuilt `dist/main.js`
     (ERR_MODULE_NOT_FOUND). `server.deps.inline` did not change it. The relative form
     passes under vitest and under `tsc -b` (the test project references the apps).
  2. Per owner decision, the readiness case asserts ready-before-stop and
     port-released-after-stop instead of racing the microsecond window between
     `setReady(false)` and `health.close()` inside `await ctx.close()`. The 503
     transition is covered exactly by P00-T03's `/readyz` case.
Contract/plan issues found: the `@flowledger/source` condition does not rescue bare
workspace specifiers in vitest, and `node_modules/@flowledger` contains only packages
the root manifest depends on. Any later `test/contract` file importing
`@flowledger/<package>` will hit the same wall — and P00-T05 extends this exact test
file. Recommended `docs(plan)`/config follow-up for the task that first needs it: add
the workspace packages to root devDependencies AND inline them in vitest
(`test.server.deps.inline` per project, not only at the root project, since the named
projects define their own `test` blocks). Not applied: `vitest.config.ts` is outside
this task's Files list.
Next task: P00-T05 (dependencies satisfied: yes — P00-T01).
```

## Infrastructure — workspace specifier resolution

**Status:** `DONE` — `cb8fdf4`, merged into `main`.

Bridged the gap that P00-T04 had to work around and that P00-T05 would have hit again.
Root cause was two independent failures:

1. The root manifest linked only the nine apps, so `@flowledger/<package>` was absent
   from `node_modules`. All eight packages are now root `workspace:*` devDependencies.
2. Vitest externalises `node_modules`, so a bare specifier resolved through Node to the
   package's `default` condition — the unbuilt `dist/index.js`. `server.deps.inline`
   for `@flowledger/` is now part of `shared`, which all five projects spread. A
   root-level `test.server` setting does not reach the named projects; that was tried
   first and had no effect.

`test/contract/app-startup.test.ts` now imports `@flowledger/app-<app>/main`, as
P00-T04 specified, so that task's deviation 1 is retired.

Verified: `@flowledger/config` and `@flowledger/app-api/main` resolve; `pnpm check` 0,
`pnpm build` 0, `pnpm test:integration` 0, `pnpm test:e2e` 0; clean clone install 0,
check 0, build 0.

### Toolchain (resolved, no longer a caveat)

Node 24.22.1 is now installed under `~/.nvm` by the owner, so the earlier
`/tmp/fl-node24` extract was deleted and nothing depends on it. Gates run as
`PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"` with
`COREPACK_HOME=/tmp/fl-corepack`.

One caveat remains until the owner runs `nvm use 24.22.1 && corepack enable pnpm` in
their own terminal: Node 24 ships no `pnpm` shim, so `pnpm` still resolves to the
`v23.1.0` shim (it works — Corepack reads the `packageManager` pin and runs 10.34.9),
and the Corepack cache lives in `/tmp`, so pnpm re-downloads after a reboot.

## P00-T05 — Inert `cli` (`flowledger` bin) and `provider-simulator` entry points

**Status:** `NEEDS-REVIEW` — all gates green, awaiting owner approval before P00-T06.

```text
TASK P00-T05 — NEEDS-REVIEW
Commit: 9dc9d9f on task/p00-t05-cli-simulator
Acceptance criteria:
  - flowledger --help prints migrate/seed/verify and exits 0 -> met (verified directly
    and via `pnpm --filter @flowledger/app-cli exec flowledger --help`)
  - each "not implemented" message names its phase exactly -> met
    (migrate/seed -> P02, verify -> P03, exit 2; unknown command -> 64)
  - simulator config rejects test endpoints in production -> met
  - pnpm check green -> met
Tests added: apps/cli/src/main.test.ts :: 6 cases
             apps/provider-simulator/src/config.test.ts :: 7 cases
             test/contract/app-startup.test.ts :: +3 cases (17 total)
  break-and-restore (each observed failing, then restored):
    migrate returns 0 instead of 2           -> fails
    unknown command returns 0 instead of 64  -> fails
    usage omits a subcommand                 -> both usage cases fail
    production guard removed                 -> production case fails
    flowledger --help exits 1                -> CLI startup case fails
    simulator rejects ephemeral port         -> simulator startup case fails
    simulator never binds                    -> added health case fails
    baseline after restore                   -> 13 unit + 17 contract passing
Commands: pnpm check -> 0 | pnpm build -> 0 | pnpm check -> 0 (re-run after build)
          pnpm test:integration -> 0 | pnpm test:e2e -> 0
          clean clone: install --frozen-lockfile 0, check 0, build 0
Deviations from the task text:
  1. `apps/cli/package.json` gains an `./main` export (the spec lists only `bin`),
     because the contract test imports `runCli`. Same shape as the other apps.
  2. One strengthening: `provider-simulator serves /healthz 200`. The listed case only
     asserts start/stop, so a simulator that never binds passed — demonstrated by one of
     the breaks above.
Contract/plan issues found: the `flowledger` bin only appears after a build. pnpm links
a dependency's bin to `apps/cli/dist/index.js`, so on a fresh clone
`pnpm install && pnpm build` leaves `pnpm --filter @flowledger/app-cli exec flowledger`
failing with 254 until `pnpm install` runs again. Confirmed in a clean clone; a second
install links it and the command exits 0. P00-T14 owns CI and the developer guide and
should sequence build-then-install (or invoke `node apps/cli/dist/index.js`).
Next task: P00-T06 (dependencies satisfied: yes — P00-T04).
```

## P00-T06 — Docker stack, simulator DB bootstrap, PostgreSQL fixture

**Status:** `NEEDS-REVIEW` — all gates green including the integration lane; proceeding to
P00-T07 under the owner's standing instruction to test-then-commit without asking.

```text
TASK P00-T06 — NEEDS-REVIEW
Commit: da5b33a on task/p00-t06-docker-postgres
Acceptance criteria:
  - docker compose config validates -> met
  - image tags exact and recorded in docs/VERSIONS.md -> met
    (postgres:17.11, cloud-cli:592.0.0-emulators, jaeger 1.76.0)
  - integration test proves role isolation -> met (7 cases)
  - server_version_num between 170000 and 179999 -> met
Tests added: test/integration/simulator-db-bootstrap.test.ts :: 7 cases
  break-and-restore (each observed failing, then restored):
    truth granted INSERT + read-only default dropped -> cannot-insert fails
    PUBLIC keeps CONNECT on flowledger_sim           -> PUBLIC test fails
    ALTER DEFAULT PRIVILEGES removed                 -> read-access test fails
    testkit pins postgres:16.11                      -> version + image tests fail
    baseline after restore                           -> 7 passing
Commands: docker compose config -> valid | pnpm check -> 0
          pnpm test:integration -> 0 | pnpm test:e2e -> 0 | pnpm build -> 0
          clean clone: install 0, check 0, integration 0, compose config valid,
          init script executable in git (100755)
          live: pnpm db:up -> all 3 healthy; pnpm db:down -> containers/network/volume removed
Deviations from the task text: the init script uses two psql invocations instead of one
heredoc with `\connect` (the second needs no password variables). Same SQL and order.
Contract/plan issues found: none.
Next task: P00-T07.
```

**Environment note:** this session started with the Docker daemon down; `open -a Docker`
brought Docker Desktop 28.1.1 up, so the integration lane is genuinely verified here
rather than reported as unverifiable.

## P00-T07 — Contract code generation and drift check

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T08.

```text
TASK P00-T07 — NEEDS-REVIEW
Commit: 37b73d1 on task/p00-t07-contract-codegen
Acceptance criteria:
  - contracts:check exits 0 on a clean tree, 1 after editing a generated file -> met
  - two consecutive runs produce identical bytes -> met (byte-compared in test and by hand)
  - registeredTypes has the 26 registry types in file order -> met
  - pnpm typecheck passes with generated files included -> met
Tests added: test/contract/contracts-drift.test.ts :: 7 cases
  break-and-restore (each observed failing, then restored):
    hand-edit generated/schemas.ts      -> contracts:check exits 1  [handoff item]
    generator emits a timestamp         -> determinism + committed-match fail
    ref rewrite removed (+regenerated)  -> no-components-refs test fails
    registeredTypes reversed (+regen)   -> registered-types test fails
    baseline after restore              -> 7 passing, contracts:check 0
Commands: contracts:check 0 | pnpm check 0 | typecheck 0 | integration 0 | e2e 0 | build 0
          clean clone: install 0, check 0, build 0
Deviations from the task text:
  1. `jsonSchemas` entries are `{ path, schema }`, not bare schema objects. P00-T08 must
     resolve registry paths against them ("every schema path exists in jsonSchemas under
     commands/ or events/"), which bare objects cannot support. Consumers use `entry.schema`.
  2. Compilation uses `compile()` on an external-ref-inlined document instead of
     `compileFromFile()`, because the latter cannot resolve `file.json#/$defs/x` refs
     (every message uses them). An assertion fails the build on any unresolvable ref.
Contract/plan issues found: none.
Next task: P00-T08.
```

**Defects found while building this** (recorded because they would have shipped silently):
1. Cross-file `$ref` with a fragment is unsupported by `json-schema-to-typescript`; the
   schemas were verified acyclic and external refs are inlined before compiling.
2. All 26 messages declare a local `$defs/data`, so independent compilation produced 26
   types named `Data` which name-dedupe collapsed into one — `PaymentCreatedEventV1.data`
   carried the merchant-delivery fields. Local defs are now namespaced per message.
3. Prettier config resolved beside the output directory, making generated bytes depend on
   the destination and causing the drift check to fail against its own output.

**Next task:** `P00-T08`.




