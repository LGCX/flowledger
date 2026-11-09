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

**Next task:** `P00-T01` — Workspace, toolchain pins, project references, and test
projects. Dependencies: none. Step 1 approved and merged.
