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

### Open items carried forward — **not** part of Step 1, need owner decision

1. **P01-T04 golden case contradicts D-07.**
   `tasks/P01-domain-kernel.md:328` lists `bp 290 / fixed 30 / minimum 30 accepted`
   as a `checkFeePolicy` case, while the same task's own rule (line 280) rejects it
   (`fee(30) = 31 > 30`). P01 starts immediately after P00-GATE, so this blocks
   P01-T04. Not fixed: the file belongs to another phase and was outside the two
   files the owner approved.
2. **P05-T03 documents an uninsertable policy.** `tasks/P05-command-acceptance-messaging.md:155-157`
   uses "policy: 290 bp, fixed 30, minimum 30" and asserts `capture 29 → CAPTURE_BELOW_MINIMUM`
   with minimum 30. With a D-07-valid policy the minimum is 50 (fixture default) and
   the boundary capture is 49.
3. **R-01 in P00 still recommends the option D-06 rejected.**
   `tasks/P00-repository-foundation.md:1056` recommends making `orderingKey` optional,
   while its own "Binding until decided (README D-06)" clause and fix 6 say the key is
   the endpoint ID. The recommendation column is stale; the conflict itself is closed
   by fix 6.
4. **`pm_sandbox_123` in P01 hash golden vectors.** `tasks/P01-domain-kernel.md:395-396`
   use it as a canonical-request-hash input. Harmless — the hash does not depend on
   token validity — but the fixture is a token the API would reject.
5. **`fee_policies_minimum_capture` is now subsumed.** For any `bp ≥ 0`, a minimum
   below the fixed component also violates `fee_within_minimum`. Both checks stay in
   `docs/07`; P02-T07 notes that overlapping negatives must assert SQLSTATE `23514`
   rather than a constraint name.

**Next task:** `P00-T01`, dependencies satisfied (no dependencies; Step 1 approved and
merged).
