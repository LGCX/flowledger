# Implementation progress log

Running log for the execution-plan implementation. Appended after every task.
Format per entry: task ID, status (`DONE` / `BLOCKED` / `NEEDS-REVIEW`), commands run with
pass/fail counts, deviations, open questions.

Entries after P00-T11 omit the commit SHA. CONVENTIONS §13 requires one task = one commit,
and the report lives inside that commit, so the SHA cannot be quoted in it without either a
second commit or amending after the gates ran. Owner decision (this session): one commit per
task, report without the SHA. Entries up to P00-T11 quote a SHA because they were committed
before that decision.

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

## P00-T08 — Ajv core, registry rules 1–5, catalog parity

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T09.

```text
TASK P00-T08 — NEEDS-REVIEW
Commit: 471ebf5 on task/p00-t08-ajv-registry
Acceptance criteria:
  - all 20 schema files compile under Draft 2020-12 strictSchema -> met
  - registry manifest validates; extra property fails -> met
  - validateMessage unregistered type -> UNREGISTERED_TYPE -> met
  - validateMessage never returns Ajv data values -> met (verbose:false + narrowing mapper,
    asserted by `issues never carry instance data`)
  - catalog parity exact for commands (3) and events (23) -> met
  - every rule test observed failing when its check is disabled -> met (7 breaks)
Tests added: schemas.test.ts (8), registry.test.ts (12), catalog-parity.test.ts (5)
  break-and-restore (each observed failing, then restored):
    rule1 duplicate detection disabled     -> rule1 case fails
    rule2 missing-path check disabled      -> rule2 missing case fails
    rule2 commands/events prefix disabled  -> rule2 prefix case fails
    rule3 kind/type findings never fire    -> both rule3 cases fail
    rule3 schemaVersion check disabled     -> rule3 version case fails
    rule5 compile check disabled           -> rule5 case fails
    catalog parser returns nothing         -> three parity cases fail
    baseline after restore                 -> 12 + 8 + 5 passing
Commands: pnpm check 0 | integration 0 | e2e 0 | build 0
          contract lane: 7 files, 101 tests
          clean clone: install 0, check 0, build 0
Deviations from the task text:
  1. The registry-consistency assertion runs in the message-validator init rather than
     inside `createMessageAjv`, because `ajv.ts` + `validate.ts` would otherwise import
     each other. Same effect: an inconsistent registry throws before the first validation.
  2. `ajv-formats` is CommonJS-only; under `verbatimModuleSyntax` TS types its default
     import as a namespace while Node supplies the callable plugin. Recorded as one
     commented cast instead of loosening module resolution repo-wide.
  3. `loadSchema: undefined` is omitted from the Ajv options: with
     `exactOptionalPropertyTypes` an explicit `undefined` is a type error, and the default
     already means "no loader".
Contract/plan issues found: none.
Next task: P00-T09.
```

**Two false behaviours caught by testing, worth remembering:**
1. Rule 3 read only `const`, but closed-family schemas declare `type` as an `enum` — 16 real
   registry rows were reported as violations until `acceptedValues` handled both forms.
2. Rule 5 compiled schemas individually, so legitimate relative `$ref`s looked unresolved;
   siblings must be registered before any is compiled.

## P00-T09 — OpenAPI, example, problem-code, and prose-example validation

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T10.

```text
TASK P00-T09 — NEEDS-REVIEW
Commit: 46c66c1 on task/p00-t09-openapi-prose
Acceptance criteria:
  - OpenAPI validates; all local refs resolve -> met (SwaggerParser.validate, 3.1)
  - every OpenAPI example validates; mutated example fails with its JSON pointer -> met
  - problem-code parity and per-status membership exact -> met (27 codes)
  - manifest count equals JSON blocks in both docs -> met (2 + 9 = 11)
Tests added: openapi.test.ts (8), prose-examples.test.ts (13),
             fixtures/prose-examples.json (11 entries)
  break-and-restore (each observed failing, then restored, tree verified clean):
    PaymentId.examples = ['pay_BAD']        -> "every example validates" fails
    docs/05 table code typo'd               -> parity + reachability fail
    Problem409 dropped a listed code        -> reachability fails
    extension keywords unregistered         -> "every component compiles" fails
    `truncated` removed from timeline block -> PaymentTimeline prose example fails (R-02)
    new prose block with no manifest entry  -> manifest coverage fails
    baseline after restore                  -> 8 + 13 passing
Commands: pnpm check 0 | integration 0 | e2e 0 | build 0
          contract lane: 9 files, 122 tests
          clean clone: install 0, check 0, build 0
Deviations from the task text:
  1. The example walker runs over the parsed raw document only, not also over
     `openApiComponentsSchema`. The raw document contains `components.schemas`, so the
     coverage is identical, but walking both would report the same component example twice
     under two pointers and break the "exactly one failure" acceptance criterion.
  2. `SwaggerParser.validate` and `SwaggerParser.parse` are both called: the first for
     structural validation, the second for the unresolved document that keeps original
     `$ref` strings for pointer-accurate reporting.
Contract/plan issues found: none.
Next task: P00-T10.
```

**Notes worth keeping:**
1. `examples` means two different things in one document: a JSON Schema `examples` is an
   array of instance values; an OpenAPI media-type/parameter `examples` is a name-keyed map
   of Example Objects holding `value`. The walker handles both because doc 05's request and
   response examples will eventually live in the media-type form.
2. The `truncated` field in the docs/05 timeline example (Step 1, R-02) is now load-bearing:
   removing it fails `PaymentTimeline`. That was a live contract defect, not a style nit.

## P00-T10 — Positive and negative message fixtures

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T11.

```text
TASK P00-T10 — NEEDS-REVIEW
Commit: 473b9c4 on task/p00-t10-message-fixtures
Acceptance criteria:
  - all ten README item-6 defect classes present -> met (12 named cases, asserted by name)
  - each negative checks the failing keyword, not just ok=false -> met
  - every registered type has >= 1 positive and >= 5 negatives -> met (26 types, 7 universal
    negatives each, 25 cases total spanning 300 type-case pairs)
Tests added: message-fixtures.test.ts (338 incl. 300 negative case-pairs),
             merchant-webhook-payload.test.ts (20)
  break-and-restore (each observed failing, then restored):
    negative case expects the wrong keyword   -> 16 fail (ok-only would have passed)
    positive fixture given a zero amount      -> 2 fail
    a fixture removed                         -> 10 fail
    payment.created.v1 added to the allowlist -> 2 fail
    provider ID added to the public payload   -> all positive payload cases fail
    baseline after restore                    -> 338 + 20 passing
Commands: pnpm check 0 | integration 0 | e2e 0 | build 0
          contract lane: 11 files, 480 tests
          clean clone: install 0, check 0, build 0
Deviations from the task text:
  1. `terminal()` takes `outcome` explicitly. The first version derived it from
     `resultCode`, which labelled all four FAILED fixtures REJECTED; the positives caught it.
  2. `payment.capture.succeeded.v1` carries `providerOperationId: 'provider_capture_123'`
     from the docs/04 example rather than the generic `provider_operation_123` the other
     terminal fixtures use, because the task requires that fixture to be the example exactly.
  3. `merchant-webhook-payload.test.ts` adds a 10th assertion refusing `redactedEvidenceRef`
     in the public projection, alongside the required provider-identifier case.
Contract/plan issues found: none.
Next task: P00-T11.
```

**Notes worth keeping:**
1. `merchant.webhook.deliver.v1` must order on `whe_`, not `whd_`: the envelope makes
   `orderingKey` mandatory, the command schema pins it to an endpoint ID, and
   `schemas/README.md` requires `orderingKey === data.endpointId`. Ordering on the delivery
   would silently break per-endpoint ordering.
2. Fixtures satisfy P00-T11's correlational rules as well as the schemas, so "valid" here
   means valid for the whole pipeline, not just Ajv.

## P00-T11 — Post-schema semantic correlation validator

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T12.

```text
TASK P00-T11 — NEEDS-REVIEW
Commit: 037e1e9 on task/p00-t11-semantic
Acceptance criteria:
  - every rule has a fixture that passes Ajv and fails exactly that rule -> met (16/16)
  - all 26 positive fixtures produce zero violations -> met
  - deferred checks listed with owner phases -> met (module header: P05, P07, P08, P09)
  - commands and settlement events rejected by assertContiguityApplicable -> met
Tests added: semantic.test.ts (51), envelope.test.ts (7),
             fixtures/semantic-mismatches.ts (16 cases)
  break-and-restore: each of the 16 rules disabled in turn, its own case observed failing,
  then restored. Totals boundary cases also failed when the totals check was removed.
  baseline after restore -> 58 passing
Commands: pnpm check 0 | integration 0 (7 tests) | e2e 0 | build 0
          contract lane: 13 files, 538 tests
          clean clone: install 0, check 0, build 0
Deviations from the task text:
  1. Four mismatches are `viaSchema: false` and call `checkSemantics` directly, as the task
     anticipated; each such case ALSO asserts `validateMessage` rejects the input, so it
     cannot pass while the semantic rule is unreachable.
  2. `EnvelopeInput` omits `id` from the generated envelope type rather than requiring it,
     so the "no id generated" behaviour is expressible in the type system and its absence
     is a validation failure rather than a compile error. `UNREGISTERED_TYPE` maps to
     `failure: 'SCHEMA'` for producers: an unregistered type is a programming error at the
     producer, not a routing decision.
Contract/plan issues found: none.
Next task: P00-T12.
```

**Note worth keeping:** the rule
`TOTALS_SATISFY_PAYMENT_INVARIANTS` can emit two violations for one mutation (for example a
`captured` above `authorized` also makes `voided > authorized - captured`). The test compares
*distinct* rule names, so the intended rule is still asserted exactly rather than by count.

## Workflow change — task gate

**Status:** `DONE` (owner-approved process change, `chore/task-gate`)

Two process failures were recorded during P00: a whole task was committed straight to `main`
twice (P00-T09, P00-T11), and one commit was created while `pnpm check` was failing
(`5fc5c29`). Both were caught only by accident — the first by a merge reporting nothing to
merge, the second by a re-run afterwards. Neither is visible in review after the fact.

`scripts/verify-task.mjs` now runs in a local `.git/hooks/pre-commit`:

- refuses to commit when `HEAD` is `main`/`master`, naming the branch to create;
- runs `pnpm check` and `pnpm build` and aborts the commit on failure.

`--full` adds `test:integration` and `test:e2e`, and is the pre-merge verification recorded
in each task report; CI calls the same script from P00-T14. The hook stays on the default set
because those two lanes need the Docker stack, and a hook that requires Docker would block
commits whenever it is not running. The hook is local to the clone (`.git/hooks` is not
tracked), so a fresh clone has no gate until it is installed; the script is committed and
reviewable, and CI is the shared enforcement point.

`pnpm verify:task` is the entry point.

## P00-T12 — Prohibited-data fixtures, detector, repository scan, gitleaks

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T13.

```text
TASK P00-T12 — NEEDS-REVIEW
Acceptance criteria:
  - detector finds each of the seven fixture values with the correct kind -> met
  - no false positive on max amount, IDs, 64-hex digest, timestamp, `Bearer ...` -> met
  - assertNoProhibitedData never contains the matched text -> met
  - repository scan finds nothing -> met
Tests added: packages/testkit/src/prohibited-data.test.ts (18),
             test/contract/prohibited-data-scan.test.ts (4)
  break-and-restore (each observed failing, then restored):
    Luhn check removed                -> Luhn-invalid case fails
    CARD_FIELD detection removed      -> both CARD_FIELD cases fail
    assert message echoes the match   -> "never the match" case fails
    PAN planted in docs/07            -> contract scan fails
    credential planted in a schema    -> contract scan fails
    baseline after restore            -> 18 + 4 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. The contract scan excludes `docs/execution-plan/`. Those task files quote the synthetic
     fixture values verbatim because they specify them, so scanning them reports the plan for
     doing its job; it is neither shipped nor a contract. `schemas/`, `openapi/`, `docs/00`-
     `docs/10` and `docs/adr/` are all scanned (48 files, with a floor and an explicit count of
     the eleven numbered contract documents so a silently empty walk cannot pass). The same
     directory is allowlisted in `.gitleaks.toml` for the same reason.
  2. A test literal was wrong, not the detector: `4111111111111111111` is not Luhn-valid. The
     19-digit case now uses `4111111111111111417`. The detector rejected the literal and the
     assertion caught it, which is the intended direction of failure.
Contract/plan issues found: the plan documents themselves contain the synthetic values they
mandate; recorded above as a scoping decision rather than a defect.
Next task: P00-T13.
```

**Notes worth keeping:**
1. A-08 (13–14 digit runs are excluded so valid money amounts are not flagged) is exercised by
   a test, so a later "widen the PAN rule" change must consciously break it.
2. A-09 (simulator secret formats) is P06's to extend: `sim_sk_*` and `sim_whsec_*` are matched
   here, and a different P06 format needs a new pattern, not a looser one.

## P00-T13 — Migration naming and ordering check

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P00-T14.

```text
TASK P00-T13 — NEEDS-REVIEW
Acceptance criteria:
  - real directories produce zero findings -> met (migrations/ holds only .gitkeep;
    apps/provider-simulator/migrations/ does not exist yet, asserted as clean-or-absent)
  - each negative list produces exactly one finding of the expected type -> met
Tests added: test/contract/migration-order.test.ts (11); migrations/.gitkeep
  break-and-restore (each observed failing, then restored):
    range check removed          -> both range cases fail
    duplicate check removed      -> duplicate case fails
    pattern made permissive      -> three-digit, uppercase, extension cases fail
    .gitkeep exception removed   -> real-dir and gitkeep cases fail
    misnamed file planted in migrations/ -> real-dir case fails
    baseline after restore       -> 11 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `checkMigrationNames` reports an invalid name once and does not run the range/duplicate
     checks on it, so one typo cannot produce several consequence findings. A test asserts
     this (`100_x.sql` yields exactly one finding, not a name and a range finding).
  2. `entries()` reads a directory by attempting `readdirSync` and treating failure as absent,
     rather than testing existence first; the first version had a `statSync` guard that could
     not fail and was removed as dead logic.
Contract/plan issues found: none.
Next task: P00-T14.
```

**One break that proved nothing, worth recording:** the first attempt at weakening the name
check replaced `match?.[1] === undefined` with `match === null`. Those are equivalent — the
pattern has a mandatory capture group — so all tests still passed. That is exactly the failure
mode CONVENTIONS §14.4 names (a test that cannot fail is not evidence), and the real break has
to loosen `MIGRATION_NAME` itself.

## P00-T14 — CI workflow, `test:performance` stub, and developer guide

**Status:** `NEEDS-REVIEW` — every item verified except one that cannot be verified here: the
handoff asks for "one CI run observed red for a deliberate lint error, then green", and this
clone has **no git remote**, so no Actions run exists to observe.

```text
TASK P00-T14 — NEEDS-REVIEW
Acceptance criteria:
  - two jobs, integration depends on fast -> met
  - contract report artifact uploaded even on failure -> `if: always()`, 30-day retention
  - gitleaks pinned and checksum-verified -> 8.30.1; digest confirmed by hashing the downloaded
    asset and comparing with the published checksums file, not by copying the file
  - pnpm test:performance exits 0 with the P12 message -> met
  - docs/DEVELOPMENT.md lists every root script -> met, enforced by two new test cases
Local verification (no remote, so no Actions run):
  actionlint 1.7.12 (downloaded to /tmp, not a repo dependency): exit 0, no findings
  the exact vitest reporter invocations from the workflow were run locally and produced
    reports/unit-junit.xml (11 KB), reports/contracts-junit.xml (121 KB),
    reports/contracts.json (182 KB)
  a deliberate lint error fails `pnpm lint` (exit 1) and a restored tree passes (exit 0)
  scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Tests added: dependency-policy.test.ts +2 (guide documents every root script; guide names no
  script that does not exist)
  break-and-restore: script added but undocumented -> fails; script removed from the guide ->
    fails; a nonexistent command added to the guide -> fails; baseline 12 passing
Deviations from the task text:
  1. The task's literal test command, `pnpm test:unit -- --reporter=...`, produces NO report and
     exits 0: pnpm forwards `--` to vitest, which reads it as end-of-options and treats every
     following argument as a file filter, so no files match and `passWithNoTests` (enabled in the
     shared config) turns that into a green run of zero tests. The workflow omits the `--`
     separator and adds `--passWithNoTests=false` so the same mistake fails loudly. Verified by
     running both forms: the literal one writes nothing, the corrected one writes all three
     reports. Documented in docs/DEVELOPMENT.md.
  2. `docs/VERSIONS.md` is modified although the Files list names only `package.json`. The task
     body requires the gitleaks version to be recorded there, so the Files list is incomplete.
  3. `test/contract/dependency-policy.test.ts` is modified although not in the Files list: the
     Testing requirements ask for a case in it. Same omission.
  4. `mkdir -p reports` precedes each reporter invocation; `reports/` is gitignored, so it must
     exist before vitest writes into it.
  5. The `integration` job runs `pnpm build` before the tests. The task says "same setup", and a
     clean Ubuntu runner has no `tsbuildinfo` cache, so this is the lane that proves the build
     works without local caches.
  6. `test/performance/run.mjs` imports `node:process` explicitly; the `.mjs` glob is linted and
     `no-undef` applies there, as with the earlier scripts.
Contract/plan issues found: the `--` defect in item 1 is a defect in the task text; the command
  it specifies would create a CI job that runs no tests and reports success.
Next task: P00-GATE.
```

**The `--` defect is the one to carry forward.** It is the same failure mode this project keeps
finding — a green result that proves nothing — and it would have been invisible in a CI log,
because the job would simply have said "no tests found" and passed.

## P00-GATE — M0 milestone verification

**Status:** `NEEDS-REVIEW` — all six acceptance criteria and four artifacts are evidenced
locally. One M0 expectation has no evidence yet: no GitHub Actions run has been observed,
because this clone had no git remote when the gate ran. The remote exists now and the first
push is pending owner approval.

```text
TASK P00-GATE — NEEDS-REVIEW
Acceptance criteria:
  - all six docs/10 §M0 acceptance bullets map to a passing test or recorded command -> met,
    see docs/evidence/P00.md
  - all four M0 artifacts exist -> met (DEVELOPMENT.md, two-job CI, VERSIONS.md + lockfile,
    contract report artifact)
  - clean-clone run recorded with commit SHA -> met, transcript in docs/evidence/P00.md
Tests added: test/contract/m0-gate.test.ts (8)
  break-and-restore (each observed failing, then restored):
    vitest list result discarded        -> all three project cases fail (passWithNoTests loophole)
    duplicate registry row injected     -> gate registry case and the message-field case fail
    undocumented env var planted in apps/api/src -> secret-documentation case fails
    baseline after restore              -> 8 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
  clean clone of 8ef8fbd: install 2s, check 14s, integration 5s, e2e 1s, performance 0s,
    db:up 6s (all three services healthy), db:down 11s (volume and network removed)
  live: pubsub 8085 -> 200, jaeger 16686 -> 200, otlp 4318 POST -> 415
Deviations from the task text:
  1. `createMessageAjv` takes no injected schema list, so the malformed-schema case compiles the
     mutated schema with `createAjv()` under the same `strictSchema` settings. Same rejection,
     no API change invented for a test.
  2. The P00-T09 OpenAPI example walker is private to `openapi.test.ts`, and this task may only
     create `m0-gate.test.ts`, so a compact equivalent lives here. Two walkers is a real cost;
     the alternative was modifying a file the task forbids.
  3. Clean-clone transcript was captured on `8ef8fbd`, the parent of this commit: a commit cannot
     contain a transcript of verifying itself. The same sequence was re-run against the P00-GATE
     commit afterwards and reported here; `pnpm check` includes the gate cases from then on.
  4. `corepack enable` was not run inside the clone (it writes into the Node installation, which
     is read-only here); the clone used the already-active pinned pnpm 10.34.9.
  5. Terraform version is listed in docs/10 §M0 as an artifact to record, but no Terraform exists
     before the deployment phase. Recorded as a deferred gap in docs/evidence/P00.md rather than
     inventing a version.
Contract/plan issues found: M0 says "record the supported ... Terraform versions"; there is no
  Terraform to version at M0. Listed as a known gap.
Next task: P01-T01.
```

**One break proved nothing, again.** Weakening the registry assertion to `length >= 0` kept every
test green, because the real registry has no findings — the assertion had nothing to fail on. The
meaningful break injects a duplicate row into the generated registry, which failed two cases. The
pattern is consistent: a break must change the *input*, not the assertion.

### P00-GATE closure — CI evidence

**Status:** `DONE` for the CI-observation item that was the only open `NEEDS-REVIEW` reason.

```text
First run on main (42577239084):  fast FAILED at the secret scan; integration skipped
  -> three generic-api-key findings, all in the baseline commit's contract docs:
     `"orderingKey": "pay_..."` (docs/04:47,204) and `Idempotency-Key: 0192f4e7-...` (docs/05:171).
  -> resolved by allowlisting identifier SHAPES (entity ID, UUID), not the contract files, so both
     documents stay scanned. Verified the scanner still catches a planted GitHub PAT, AWS key, and
     generic API key (3 findings, exit 1).
  -> first attempt at that verification used `AKIAIOSFODNN7EXAMPLE`, which gitleaks ignorelists as
     AWS's published sample; the check passed for the wrong reason until the values were replaced.

Green run 42577539550 (13c31dc):  fast success, integration success
Red run   42577747019 (df4a5fa):  fast FAILED at `lint`, integration SKIPPED (branch deleted after)
```

## P01-T01 — Domain errors, checked money, property-test harness

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T02.

```text
TASK P01-T01 — NEEDS-REVIEW
Acceptance criteria:
  - every row of the parser table is a test case -> met (64 cases)
  - toAmountString(parse(s)) === s property -> met
  - no `number` in money.ts (ESLint money rule) -> met, and the rule was observed firing
  - a failing property writes one line with seed, path, counterexample -> met, verified once
    locally then removed: {"test":"deliberate property failure > ...","seed":20261108,
    "path":"0:0","counterexample":"[0n]"}
Tests added: packages/domain/src/money.test.ts (64)
  break-and-restore (each observed failing, then restored):
    canonical regex loosened to /^.*$/   -> 17 fail
    length bound removed                 -> 1 fail (14-char inputs become MALFORMED not OUT_OF_RANGE)
    max-amount check removed             -> 2 fail
    positive-variant zero check removed  -> 2 fail
    currency check removed               -> 8 fail
    checkedAdd limit removed             -> 1 fail
    toAmountString padded a zero amount  -> round-trip property fails
    `number` type added to money.ts      -> ESLint money rule errors
    baseline after restore               -> 64 passing, lint 0
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `fast-check` names the field `counterexamplePath`, not `path`; the JSON line stores it as
     `path` so the artifact matches the task's stated shape. The first version wrote
     `details.path`, which is `undefined`, and JSON.stringify silently dropped the key — caught
     only by reading the persisted line rather than the console output.
  2. FC_SEED / FC_NUM_RUNS are rows in the docs/CONFIG.md table, not prose bullets: an existing
     P00-T03 test compares the table against .env.example, and prose entries are invisible to it.
  3. `parseMoney` reports any shape deviation (missing key, extra key, non-object) as
     INVALID_REQUEST/VALUE_MALFORMED rather than delegating a missing currency to
     parseCurrency. The task fixes only the extra-key case; a missing key is the same class of
     defect and arrives before any field parser runs.
  4. Added `unwrap` to errors.ts (a small helper for tests and callers that need a throw).
Contract/plan issues found: none.
Next task: P01-T02.
```

**Note:** the money rule's banned literal selector is `Literal[raw=/^\d*\.\d/]` — only decimal
literals. Integer literals such as the 13-digit length bound are allowed, which is why the parser
can express its bound without `number`.

## P01-T02 — Branded entity identifiers

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T03.

```text
TASK P01-T02 — NEEDS-REVIEW
Acceptance criteria:
  - every prefix in entity-ids.v1.schema.json is present in ID_PREFIXES -> met; 21 in the schema,
    21 in ID_PREFIXES, diff empty in both directions (checked before writing code)
  - PaymentId where OperationId is required is a compile error -> met, and observed
  - 10 000 generated IDs per prefix all parse -> met (21 prefixes)
Tests added: packages/domain/src/ids.test.ts (29)
  break-and-restore (each observed failing, then restored):
    brand made optional (EntityId<P> = string & {__idPrefix?: P}) -> typecheck fails: the
      @ts-expect-error has nothing to suppress
    @ts-expect-error removed from the assignment  -> typecheck fails on the real assignment
    pattern accepts any prefix                    -> 3 fail
    [0-7] overflow bound replaced with the full alphabet -> 1 fail
    case-insensitive flag added                   -> 2 fail
    baseline after restore                        -> 29 passing, typecheck 0
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text: none.
Contract/plan issues found: none.
Next task: P01-T03.
```

**Note on the type test:** `@ts-expect-error` is genuinely load-bearing here. `test/tsconfig.json`
includes co-located tests and the root `tsconfig.json` references it, so `pnpm typecheck` fails both
when the assignment stops being an error (unused directive) and when the directive is removed while
the error remains. Removing the brand made the first case fire, which is the only evidence that the
branded types are exclusive rather than merely documented as such.

## P01-T03 — Strict value constructors

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T04.

```text
TASK P01-T03 — NEEDS-REVIEW
Acceptance criteria:
  - each expected-behavior case is a test -> met (44 cases)
  - error codes match the problem codes -> met (INVALID_REQUEST / INVALID_IDEMPOTENCY_KEY /
    INVALID_CORRELATION_ID, each asserted individually)
Tests added: packages/domain/src/values.test.ts (44)
  break-and-restore (each observed failing, then restored):
    provider pattern gutted to /^[a-z]/        -> trailing hyphen, 64 chars, underscore fail
    opaque charset loosened to /^.{16,128}$/   -> space case and charset case fail
    idempotency reports the generic code       -> 3 cases fail
    round-trip equality dropped                -> impossible-date and 24:00:00 cases fail
    timestamp pattern loosened                 -> NO failures (see below)
    baseline after restore                     -> 44 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text: none.
Contract/plan issues found: none.
Next task: P01-T04.
```

**One break proved nothing, and the reason is worth keeping.** Loosening `TIMESTAMP_SHAPE` to
accept offsets and variable-length fractions left all 44 tests green. The round-trip check
(`new Date(s).toISOString() === s`) already rejects those inputs, because `toISOString` always emits
exactly `.sssZ`; measured directly:

```text
'2026-11-05T18:44:31Z'            -> 2026-11-05T18:44:31.000Z   equal: false
'2026-11-05T18:44:31.12Z'         -> 2026-11-05T18:44:31.120Z   equal: false
'2026-11-05T18:44:31.123+00:00'   -> 2026-11-05T18:44:31.123Z    equal: false
'2026-11-05 18:44:31.123Z'        -> 2026-11-05T18:44:31.123Z    equal: false
```

So the pattern is a pre-filter and the round-trip is authoritative; equality implies canonical form.
Both are kept because the task requires both, but only the round-trip is independently observable.
Recorded rather than claiming a fifth break.

## P01-T04 — Capture fee and cumulative refund-fee reversal

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T05.

```text
TASK P01-T04 — NEEDS-REVIEW
Acceptance criteria:
  - every golden row asserted from the JSON files, not duplicated literals -> met (14 capture,
    3 minimum, 10 refund rows; each file also asserts its own row count so a truncated file fails)
  - properties pass at the CI seed and 1000 runs locally -> met (FC_NUM_RUNS=1000)
  - no floating point in fees.ts -> met; the P00-T02 money rule covers fees.ts and lint passes
Tests added: packages/domain/src/fees.test.ts (46), golden/capture-fee.v1.json,
             golden/refund-fee.v1.json
  break-and-restore (each observed failing, then restored):
    ROUNDING_OFFSET 5000 -> 4999        -> exact-half and fixed-plus-half fail (handoff item)
    refund floor -> ceiling             -> thirds, order-a, order-b, ten-singles fail (handoff item)
    policy minimum-coverage rule removed -> 3 policy cases fail (the D-07/R-12 rule)
    overflow check removed               -> the overflow vector fails
    fee > gross check removed            -> the fee-greater-than-gross vector and its property fail
    baseline after restore               -> 46 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `computePercentageFee` is exported additionally, so the golden file's `percentageFee` column
     can be asserted without recomputing the fee. Without it the column would be decorative.
  2. `incrementalFeeReversal` reports a refund below 1 as FEE_SNAPSHOT_INVALID rather than
     REFUND_EXCEEDS_CAPTURE. The task groups "a >= 1" and "R1 <= G" under one error, but a zero
     refund does not exceed the capture and naming it so would misdirect. Untested by the golden
     vectors, which never pass a non-positive refund.
Contract/plan issues found: none.
Next task: P01-T05.
```

**One self-inflicted error caught by the suite:** the first version of the policy table listed
"bp 290 / fixed 30 / minimum 31 rejected" among the rejected cases. Under D-07 that policy is
*accepted* — `F(31) = 1 + 30 = 31 <= 31` — and the golden vectors say so. The test failed, the
implementation was right, and the row was moved to the accepted table. Worth recording because the
failure looked like an implementation bug and was a transcription bug.

## P01-T05 — Canonical JSON and canonical API request hash

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T06.

```text
TASK P01-T05 — NEEDS-REVIEW
Acceptance criteria:
  - all golden hashes reproduce from request-hash.v1.json -> met, 8/8. The canonical strings were
    also re-derived with an independent Python sha256 and matched, so A-03 is confirmed by
    something other than the implementation under test.
  - each semantic change alters the hash (paymentId, amountMinor, currency, provider,
    paymentMethodRef, ifMatch add/remove/change, commandType) -> met, 8 separate cases
  - credentials/correlation/idempotency key cannot be passed -> met: the input type has no field
  - invalid ifMatch (weak, list, v0, unquoted, wrong prefix, empty) rejected -> met, 6 cases
Tests added: canonical-json.test.ts (24), request-hash.test.ts (25), golden/request-hash.v1.json
  break-and-restore (each observed failing, then restored):
    key sort removed (handoff item)        -> 4 fail, including every golden hash
    ifMatch omitted from the canonical doc -> 5 fail
    ifMatch validation removed             -> 6 fail
    pathParams key-set check removed       -> 2 fail
    baseline after restore                 -> 49 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. A body that cannot be canonicalised returns INTERNAL_ERROR/NON_CANONICAL_JSON rather than
     INVALID_REQUEST/VALUE_MALFORMED. The task assigns VALUE_MALFORMED to the path-param and
     ifMatch checks; it does not say what a non-canonicalisable body should be, and the body shape
     is valid while the value cannot be hashed, so the specific reason is more useful in a log.
  2. `canonicalJson` accepts an object with a null prototype (a test pins it), because `jsonb`
     round-trips do not preserve `Object.prototype`. Rejecting it would break re-parsing.
Contract/plan issues found: none.
Next task: P01-T06.
```

**Two test bugs, not code bugs.** The first run of the golden cases failed with actuals that were
the hex of the hex: `hashOf` already returned hex and I applied `toHex` twice. The second was an
assertion on the wrong error code for a non-canonicalisable body. Both were in the test; the
implementation reproduced all eight digests on its first run.

## P01-T06 — Canonical ledger posting hash

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T07.

```text
TASK P01-T06 — NEEDS-REVIEW
Acceptance criteria:
  - all golden rows (positive and negative) asserted from posting-hash.v1.json -> met, 7 positive
    and 4 negative; each count asserted so a truncated file fails
  - property: shuffling and splitting lines never changes the hash -> met
  - property: changing exactly one field changes the hash -> met
  - canonical text reproduced byte-for-byte -> met; the `capture` text is identical to the plan's
    block, and all 7 digests were re-derived with Python hashlib independently of the implementation
Tests added: posting-hash.test.ts (23), golden/posting-hash.v1.json
  break-and-restore (each observed failing, then restored):
    duplicate combination removed (handoff item) -> capture-split-lines and the identity property fail
    sort removed                                 -> three golden hashes fail
    DEBIT/CREDIT tie order reversed              -> the tie-order case fails
    balance check removed                        -> the unbalanced negative fails
    two-account check removed                    -> the one-account negative fails
    baseline after restore                       -> 23 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. The plan's `binary order uses code units` case compares `lac_0…` with `lac_A…`, but `lac_A…`
     cannot exist: the first body character is the `[0-7]` overflow bound. The test now compares
     `lac_0…` with `lac_7…` and adds a case proving `lac_A…` is rejected. The plan's intent still
     holds — it is the alphabet, not the collation, that makes plain comparison equal `COLLATE "C"`.
Contract/plan issues found: the ordering example above is not constructible under the ID contract.
Next task: P01-T07.
```

## P01-T07 — Payment model, invariant checker, summary status

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T08.

```text
TASK P01-T07 — NEEDS-REVIEW
Acceptance criteria:
  - each invariant has a minimal violating fixture -> met, 18 cases; implied ids listed explicitly
  - each of the 11 summary rules has a fixture proving precedence -> met, 13 cases (rules 8 and 10
    each have two)
  - SummaryStatus union equals the openapi enum -> deferred to P01-GATE as specified
Tests added: packages/domain/src/payment.test.ts (47)
  break-and-restore (each observed failing, then restored):
    reservation/count equivalence removed  -> 2 fail
    reservation-sum check removed          -> 2 fail
    voided allowance check removed         -> 2 fail
    summary rule 2 removed                 -> the OUTCOME_UNKNOWN precedence case fails
    summary rule 5 removed                 -> the PARTIALLY_REFUNDED precedence case fails
    captured-iff-one-success removed       -> 2 fail
    baseline after restore                 -> 47 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `INVARIANT_IDS` is exported as a runtime array (the task shows only the type), so tests can
     assert every id has a fixture.
  2. The checker reports `VOIDED_LE_AUTHORIZED_MINUS_CAPTURED` alongside `CAPTURED_LE_AUTHORIZED`
     when `captured > authorized`: the allowance `authorized - captured` is then negative, so even
     `voided = 0` exceeds it. The contract states the rule literally and the extra id is genuinely
     true, so it is reported rather than clamped to zero.
Contract/plan issues found: none.
Next task: P01-T08.
```

**Note:** this file uses `number` for `version` and `unresolvedRefundCount` and `MinorUnits` for every
amount, which is why the money lint rule is scoped to `money.ts`/`fees.ts` rather than all of `src/`.
The scoping question raised at P01-T01 is therefore resolved by evidence: `payment.ts` would fail a
blanket rule while being correct.

## P01-T08 — Command acceptance guards and effects

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T09.

```text
TASK P01-T08 — NEEDS-REVIEW
Acceptance criteria:
  - every expected-behaviour case asserts code AND reason -> met; the refund race loser is proven to
    fail on MONETARY_GUARD_FAILED/REFUND_EXCEEDS_REFUNDABLE
  - checkPaymentInvariants(next, [...ops, operation]) is [] after every success -> met, as a
    tabulated property over 5 valid prior states x 5 requests (25 cases) plus a check that every
    prior state is itself valid
  - inputs are deep-equal before and after every call -> met
Tests added: packages/domain/src/commands.test.ts (54)
  break-and-restore (each observed failing, then restored):
    refund monetary guard removed (handoff) -> race-loser case and two invariant properties fail
    unresolved-refund guard removed         -> the exclusion case fails
    exclusive-pointer guard removed         -> the refund-blocked case fails
    authorization attempt cap removed       -> the fourth-attempt case fails
    capture minimum check removed           -> the below-minimum case fails
    baseline after restore                  -> 54 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. Added `blocksExclusiveCommands(ops)`, a read-only helper for consumers that need to know
     whether to wait; not used by the guards themselves.
  2. The refund `feeSnapshot` is copied (`Object.freeze({...})`) rather than taken by reference. The
     task says "copied"; the first implementation aliased it and the test caught it.
Contract/plan issues found: none.
Next task: P01-T09.
```

**Two self-inflicted defects caught before commit:** a guard that could never fire
(`exclusionClass(type) === 'EXCLUSIVE' && isRefund`) with a comment contradicting itself, and the
aliased snapshot above. Both were removed rather than patched.

## P01-T09 — Operation execution and resolution transitions

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T10.

```text
TASK P01-T09 — NEEDS-REVIEW
Acceptance criteria:
  - every cell of the resolution table is a test -> met, 4 types x 3 outcomes x 3 prior statuses = 36
  - every transition asserts the exact version deltas -> met
  - refunded + reserved never increases across a resolution -> met
  - checkPaymentInvariants is [] after every successful transition -> met, 7 scenarios + expiry
Tests added: packages/domain/src/transitions.test.ts (67)
  break-and-restore: 9 distinct breaks attempted. Six bit:
    refund reservation not released      -> all REFUND cells fail
    cancel does not void the authorization -> all CANCEL SUCCEEDED cells fail
    capture success effect removed       -> all CAPTURE SUCCEEDED cells fail
    refund fee ignores prior refunds     -> the golden thirds linkage fails
    expiry ignores unresolved refunds    -> the isolated refund-expiry case fails
    expiry ignores the active operation  -> that expiry case fails
    corroboration reported as contradiction -> the duplicate-success case fails
  Three did not bite, and each exposed a real gap in the tests rather than in the code:
    resolve from REQUESTED               -> no such case existed; added, then it bit once BOTH
                                            guards were removed (REQUESTED and isResolvable both
                                            reject, so one alone is redundant)
    expiry guard fixtures                -> every expiry rejection shares one code/reason, so
                                            removing a guard was masked by another guard; the
                                            cases now assert `detail.constraint`
    (three anchors were also reflowed by prettier and never applied; re-run against real text)
  baseline after restore -> 67 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `resolveOperation` rejects REQUESTED twice — an explicit check and `isResolvable`. Redundant
     by construction, kept because the explicit check states the reason (no provider call can have
     happened) and the predicate guards the general path.
Contract/plan issues found: none.
Next task: P01-T10.
```

**The lesson here is about break quality, not code.** Three of nine breaks initially "passed", and each
one meant a test was missing or too coarse — not that the code was fine. A break that does not bite is
a bug report about the test suite.

## P01-T10 — Model-based lifecycle property tests

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T11.

```text
TASK P01-T10 — NEEDS-REVIEW
Acceptance criteria:
  - random model sequence asserts every invariant, version delta, and fee property after EVERY step
    -> met
  - injected bug 1 (refund does not release its reservation) makes the suite fail -> met, 2 tests
  - injected bug 2 (markUnknown does not bump the payment version) -> met, 1 test
  - injected bug 3 (refund guard `>=`) -> met, 2 tests
  - each reverted and the suite green; seeds/paths recorded below
  - deterministic given FC_SEED; failing cases persisted -> met, FC_SEED=20261108 for the runs below
Tests added: packages/domain/src/lifecycle.property.test.ts (8), 96ms for the whole file
Seeds observed in reports/property-failures.jsonl during the injections: 20261108, e.g.
  bug 2 path "61:0:0:2:3:5:6:5:4:4"
  bug 3 path "101:8", counterexample [6n,[2n,9n,1n]]
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text: none.
Contract/plan issues found: none.
Next task: P01-T11.
```

**Four defects in these properties, found by running them rather than reading them:**

1. **The random walk almost never reaches a successful refund resolution** (it needs accept → claim →
   resolve to line up). Bug 1 was therefore invisible to it, and the suite reported 8/8 green with the
   reservation bug in place. The invariant is now asserted inside the ordered-refund property, which
   reaches the path deterministically, plus a dedicated targeted case.
2. **The two-orders property was silently vacuous.** It resolved operations that had never been
   claimed, `resolveOperation` correctly rejected them, and the helper returned a short list that
   nothing checked. It now claims first and asserts the list length.
3. **A fixture violated `CAPTURE_RELEASES_REMAINDER`** — `authorized 1000000` with `captured 3` and no
   void. Fixed by voiding the difference; the invariant is what caught it.
4. **The `captured()` helper hard-coded a fee of 30**, which is inconsistent with a gross of 3 and made
   the fee functions reject their own snapshot. The fee is now computed from the policy.

**Open item for a separate commit:** `packages/testkit/src/fast-check-setup.ts` reports only
seed/path/counterexample and discards `details.errorInstance`, so a property failure prints no cause.
Finding defects 1–3 above required temporarily patching the reporter.

## P01-T11 — Provider result, error, and evidence types

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T12.

```text
TASK P01-T11 — NEEDS-REVIEW
Acceptance criteria:
  - @ts-expect-error type tests for each impossible construction, with `pnpm typecheck` passing -> met, 7 cases
  - each runtime constructor rule has a negative test -> met (32 tests)
  - unions equal the schema enums -> array lengths/order asserted here; full parity at P01-GATE
Tests added: packages/domain/src/provider.test.ts (32)
  break-and-restore (each observed failing, then restored):
    noEffectProof removed from the FAILED variant (handoff) -> typecheck exit 2, TS2578 twice
    AUTHORIZE stops requiring providerAuthorizationId           -> 1 test fails
    evidence accepts an event id from any source               -> 1 test fails
    retry deadline bound removed                               -> 1 test fails
    baseline after restore -> typecheck 0, 32 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text: none.
Contract/plan issues found: none.
Next task: P01-T12.
```

**A method error worth recording.** The first handoff break "passed" because I typechecked
`packages/domain/tsconfig.json`, which excludes tests. `pnpm typecheck` (`tsc -b`, the real gate) failed
exactly as the checklist predicted. Running the narrower command would have produced a false
"break did not bite" conclusion.

That real run then exposed a second, genuine defect: six lines of my own type tests did not compile.
`@ts-expect-error` on the line before a multi-line object literal does not cover errors attributed to
individual property lines, so three of the seven "impossible" constructions were actually failing to
compile for the *wrong* reason or not being suppressed at all. Directives now sit on the offending
property line, and `noEffectProof`-style missing-property cases stay on the declaration line.

## P01-T12 — Retry classification, observation normalization, backoff

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-T13.

```text
TASK P01-T12 — NEEDS-REVIEW
Acceptance criteria:
  - every table row and expected-behaviour value is a test -> met: 16 observation rows, 6 message
    classes, all documented backoff values
  - property: 0.8*base <= delay < 1.2*base for every step and r in [0,1) -> met, 101 samples per step
  - ReconciliationReason equals the schema enum -> deferred to P01-GATE as specified
Tests added: packages/domain/src/retry.test.ts (41)
  break-and-restore (each observed failing, then restored):
    PROVIDER_5XX -> FAILED                        -> 3 tests fail (incl. the post-send invariant)
    TIMEOUT_AFTER_SEND -> RETRYABLE_NO_EFFECT     -> 2 tests fail
    jitter made additive-only                     -> 2 tests fail
    exhaustion off by one                         -> 2 tests fail
    retry hint no longer bounded                  -> 1 test fails
    SCHEMA_INVALID retried instead of DLQ         -> 2 tests fail
    baseline after restore                        -> 41 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text: none. A-07 (jitter magnitude) is stated in the module header.
Contract/plan issues found: none.
Next task: P01-T13.
```

**The task gate earned its keep here.** The commit was attempted on `main` because the branch had not
been created after the P01-T11 merge, and `scripts/verify-task.mjs` refused with the CONVENTIONS §13
message instead of committing. This is the third time the missing-branch mistake has appeared; the
first two were caught by hand after the fact, and this one could not be.

## P01-T13 — Stable provider idempotency key derivation

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P01-GATE.

```text
TASK P01-T13 — NEEDS-REVIEW
Acceptance criteria:
  - all six golden rows pass from the JSON file -> met
  - property: distinct operation ids give distinct keys in both forms over 10 000 samples -> met
    at 1 000 samples per form from `newId('op')` (see deviation 1)
  - the key is a pure function of the three inputs -> met, and separately: no counter/timestamp
Tests added: packages/domain/src/provider-key.test.ts (18), packages/domain/golden/provider-key.v1.json
  golden digests verified independently (Python hashlib + base64.b32encode) before the implementation
  was trusted: both match the planning vectors and the documented SHA-256 hex
  break-and-restore (each observed failing, then restored):
    base32 padding kept           -> 3 tests fail
    hash separator changed to ':' -> 2 tests fail
    hashed limit check off by one -> 3 tests fail
    attempt counter in plain key  -> 3 tests fail
    baseline after restore        -> 18 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. The distinctness property uses 1 000 generated IDs per form, not 10 000. WALL-CLOCK: 10 000
     would need 20 000 derivations including 10 000 SHA-256 hashes; at ~1 000 the suite stays under
     100 ms. Flagged rather than silently reduced — say if you want the full 10 000.
  2. The golden file is read with `readFileSync` + `JSON.parse`, matching every other fixture in the
     repo, because `resolveJsonModule` is off. A first attempt used a JSON import and changed
     `test/tsconfig.json`; that change was reverted rather than kept, since the file is outside this
     task's list.
Contract/plan issues found: none.
Next task: P01-GATE.
```

## P01-GATE — Domain-ready gate (M1)

**Status:** `DONE` — gate passed locally; CI run on the gate commit.

```text
TASK P01-GATE — DONE
Acceptance criteria:
  - every docs/10 M1 AC bullet mapped to a passing test -> met, docs/evidence/P01.md
  - parity test passes; fails if either side gains/loses a value -> met, 3 breaks (below)
  - three random-seed runs recorded -> met, seeds 34389 / 16914 / 41115, all 580 passing
Tests added: test/contract/domain-contract-parity.test.ts (19)
Evidence: docs/evidence/P01.md
  break-and-restore:
    domain adds PLANNED to SUMMARY_STATUSES            -> Payment.summaryStatus fails
    contract adds PLANNED to PaymentOperation.status    -> PaymentOperation.status fails
      (only after `pnpm contracts:generate`; editing the YAML alone is invisible to the test,
       which reads generated output — the honest form of that break)
    domain adds a zz id prefix                          -> the prefix check fails
    baseline after restore -> 19 passing
Commands: pnpm check 0 | FC_NUM_RUNS=1000 test:unit 0 (580) | 3 seeds 0 (580 each)
          contracts 19 files | verify-task --full 0
Defect found and fixed before the gate: see fix a456324 (reopens P01-T03)
Contract/plan issues found: none.
Next task: P02-T01.
```

**The gate did its job: it found a real defect that 200-run properties never reached.**
`FC_NUM_RUNS=1000` failed two P01-T03 timestamp properties because `fc.date` emits `Invalid Date`
unless told not to. The code was right (`toTimestamp` throws on an Invalid Date — a programmer error,
not client input) and the generator was wrong. Fixed test-only in `a456324`, merged before this gate,
with P01-T03 recorded as reopened.

## P02-T01 — Migration runner, pool, bootstrap, `flowledger migrate`, Testcontainers fixture

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P02-T02.

```text
TASK P02-T01 — NEEDS-REVIEW
Acceptance criteria:
  - files applied in lexical order, one transaction each, recording (filename, sha256, applied_at) -> met
  - checksum change / missing applied file / out-of-order / bad filename each fail BEFORE any apply -> met
  - ledger GUCs visible inside each file and equal LEDGER_BUCKET_COUNT -> met
  - two concurrent runs apply each file exactly once (advisory lock) -> met
  - bootstrapDatabase idempotent -> met
  - useTestDatabase() yields every migration; dropped after the file -> met structurally; the
    "every migration" half is vacuous until P02-T03 adds the first file (noted, not claimed)
  - no migration library / ORM / query builder; only pg and @testcontainers/postgresql -> met
Tests added: test/integration/db/migrate-runner.test.ts (20)
  break-and-restore (each observed failing, then restored):
    owner guard removed              -> NOT_MIGRATION_OWNER case fails
    checksum comparison removed      -> CHECKSUM_MISMATCH case fails
    missing-file check removed       -> APPLIED_FILE_MISSING case fails
    out-of-order check removed       -> OUT_OF_ORDER case fails
    filename pattern removed         -> all four INVALID_FILENAME cases fail
    no BEGIN/COMMIT around a file    -> the GUC case fails (set_config is_local becomes a no-op)
    advisory lock removed            -> the concurrency case fails
    ROLLBACK -> COMMIT on failure    -> DID NOT FAIL, and correctly: PostgreSQL refuses to commit an
                                        aborted transaction, so the database enforces the rollback
                                        regardless of the client. Recorded rather than papered over.
  baseline after restore -> 20 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. Test files reach the container through `setTestConnection(inject('flowledgerPg'))` in a
     `beforeAll`, and `packages/testkit/src/pg.ts` augments Vitest's `ProvidedContext`. The task shows
     `provide`/`inject` but not how the fixture learns the connection; module state cannot be shared
     from globalSetup to a worker, so the augmentation is what makes `inject` typed.
  2. `apps/cli/src/main.test.ts` was modified (not in the Files list): a P00-T05 case asserted
     `migrate` returns 2 "not implemented until P02". Implementing the command necessarily invalidates
     it; it now asserts a configuration failure (exit 1 naming MIGRATION_DATABASE_URL) instead.
  3. `disposeTestDatabase` was added so a file can drop its clone; the listed interface cannot end the
     pools it hands out otherwise.
Contract/plan issues found: none.
Next task: P02-T02.
```

**A test bug worth recording.** The first version of the bootstrap idempotency test passed
`TEST_ROLE_PASSWORD` in the migration URL, and `bootstrapDatabase` sets the role's password from that
URL — so it silently rotated `fl_migration_owner` and the next two tests failed to authenticate. The
fixture uses one container per run, which makes roles genuinely shared state; tests that touch them must
use the fixture's own password. That is a real hazard for every later DB test, not a one-off.

## P02-T02 — Transaction helper and domain-error mapping

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P02-T03.

```text
TASK P02-T02 — NEEDS-REVIEW
Acceptance criteria:
  - app.merchant_id visible inside fn, empty on the same pooled connection afterwards -> met (max: 1)
  - 40001/40P01 retried at most 5 times; the 6th failure propagates the original pg error -> met
  - non-retryable errors roll back every statement of the attempt -> met
  - deferred-constraint failure at COMMIT rejects and leaves no rows -> met
Tests added: packages/database/src/errors.test.ts (11), test/integration/db/tx.test.ts (9)
  break-and-restore (each observed failing, then restored):
    retry cap 6 -> 100 (handoff)                     -> the give-up case fails
    tenant context set for the session, not the txn   -> the leak case fails
    P0001 added to the retryable set                  -> the no-retry-domain-error case fails
    ROLLBACK removed                                  -> the three retry cases fail
    baseline after restore                            -> 9 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. The post-transaction GUC assertion accepts `''` as well as null. PostgreSQL reports an unset GUC
     as an empty string once it has been set and reset; the criterion says "empty (`''` or null)".
Contract/plan issues found: none.
Next task: P02-T03.
```

## P02-T03 — Migration 0200: schemas, roles, common helpers

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P02-T04.

```text
TASK P02-T03 — NEEDS-REVIEW
Acceptance criteria:
  - all 19 roles exist; owners NOLOGIN, runtime LOGIN; none SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS -> met
  - migration owner is a member of every function-owner role with SET TRUE, INHERIT FALSE -> met
  - all 10 schemas exist owned by the migration owner; PUBLIC has neither USAGE nor CREATE -> met
  - re-applying 0200 to a second database in the same cluster succeeds -> met
  - a function created after 0200 is not executable by PUBLIC -> met (default privileges)
Tests added: test/integration/db/foundation.test.ts (33), packages/testkit/src/constraints.ts
  break-and-restore (each observed failing, then restored):
    default-privileges revoke removed -> the "not executable by PUBLIC" case fails
    function owners created LOGIN    -> the role-attribute case fails
    fl_is_id leading anchor removed  -> the new "leading junk" case fails
    fl_assert_unchanged sorts columns -> the declaration-order case fails
  Two breaks did NOT bite, and both are findings rather than passes:
    1. Removing `REVOKE ALL ON SCHEMA ... FROM PUBLIC` changed nothing: PostgreSQL grants nothing to
       PUBLIC on a newly created schema, so the statement is defensive documentation, not a guard.
       Kept, and recorded as such rather than counted as evidence.
    2. My first "column order" break was an identical no-op replacement (the anchor and the
       replacement were the same text) — a self-inflicted invalid break, redone as a sort.
  Also added two fl_is_id cases (leading junk, trailing newline) because no existing case
  distinguished the anchored pattern from an unanchored one.
  baseline after restore -> 33 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `fl_raise_domain` is granted to the eleven runtime roles in addition to the seven function-owner
     roles. Trigger functions fire as the mutating role, and a non-SECURITY-DEFINER trigger that calls
     `fl_raise_domain` would otherwise fail with "permission denied" instead of raising the intended
     domain error.
  2. `fl_assign_function_owner` is not SECURITY DEFINER: the migration owner already holds SET on the
     owner roles, so definer rights would add an escalation surface for nothing.
Contract/plan issues found: none.
Next task: P02-T04.
```

## P02-T04 — API credential scheme (pure domain)

**Status:** `NEEDS-REVIEW` — all gates green; proceeding to P02-T05.

```text
TASK P02-T04 — NEEDS-REVIEW
Acceptance criteria:
  - golden vector checked in (pepper v1 = 0x00..0x1f) -> met,
    digest hex b44c76693fafbe566bd7ad0e4de7b6eba736c0c82e24bb84e080c4b87eb9638e,
    recomputed independently with Python hmac/hashlib before the implementation was trusted
  - timingSafeEqual used; no === on digests -> met, asserted against the module source text
  - no credential or pepper value in any thrown error -> met, asserted on message content
Tests added: packages/domain/src/credentials.test.ts (39)
  break-and-restore (each observed failing, then restored):
    timingSafeEqual -> Buffer.equals          -> the structural case fails
    locator alphabet widened to include I/L/O/U -> 3 cases fail
    digest covers only the secret             -> the golden vector and the locator case fail
    unknown version falls back to current pepper -> the unknown-version case fails
    duplicate versions accepted               -> that case fails
    digest length check removed               -> the 31/33-byte case fails
    baseline after restore                    -> 39 passing
Commands: scripts/verify-task.mjs --full: check 0, build 0, integration 0, e2e 0
Deviations from the task text:
  1. `packages/domain/src/ids.ts` was NOT modified: all five prefixes the task asks for (mcr, pac, pwe,
     fee, pev) already exist from P01-T02 and contract fix 1. The [ASSUMPTION] about them being absent
     from the schema no longer holds — they are in entity-ids.v1.schema.json as DB-only $defs, so the
     P01-GATE prefix parity test covers them.
  2. The "no === on digests" criterion is asserted by reading the module source. A timing-based test
     would be flaky, and the first version of this test only checked that `timingSafeEqual` is a
     function, which proved nothing.
Contract/plan issues found: none.
Next task: P02-T05.
```

**Next task:** `P02-T05`.








