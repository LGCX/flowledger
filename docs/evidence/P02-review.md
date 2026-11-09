# P02 — independent review: findings and fixes

**Branch:** `review/p02-audit-fixes` (5 commits on top of `740b545`). **Task ID used in commits:** `P02-REVIEW`.
**Written for:** the agent that implemented P00–P02, so the reasoning behind each change can be checked
rather than taken on trust.

## Outcome

| Gate                                  | Before review                        | After review                                                 |
| ------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `pnpm check`                          | pass                                 | pass (unit 637)                                              |
| `pnpm build`                          | pass                                 | pass                                                         |
| `pnpm test:integration`               | **flaky** — 393/394 on the first run | 418/418 on three consecutive runs; `idempotency.test.ts` 8/8 |
| `pnpm test:e2e`                       | pass                                 | pass                                                         |
| `node scripts/verify-task.mjs --full` | —                                    | all gates green                                              |
| Committed P02 dump migrates forward   | 0 files                              | exactly `0291`–`0294`, then 0 on a second run                |

Every fix below was proven the way the plan asks: the guard was mutated in the working tree, the named
tests were observed failing, and the file was restored before committing. Contracts (`docs/00`–`docs/10`,
`docs/adr`, `schemas`, `openapi`) were not edited. Frozen migrations `0200`–`0290` were not edited; every
schema change is a new forward migration.

## How the review was done

- Read all ten migrations, the money/hash modules, the repositories and the CLI against docs/02, 03, 05
  and 07; a sub-review covered `payment.ts`, `commands.ts`, `transitions.ts` and the property test.
- Ran probes in throwaway `postgres:17` containers (catalog queries; dropping single constraints to test
  claims of redundancy; DST arithmetic under `America/Chicago`).
- Measured the property test's reach with counters on a scratch copy of `packages/domain/src`.

## Findings fixed

### 1. Replay window depended on the session TimeZone; its boundary test was flaky — `b0ddd06`

- **Defect.** `0270` wrote the window as `committed_at + interval '90 days'` in the CHECK and in
  `claim_idempotency_key`. For `timestamptz`, `+ 'N days'` is calendar arithmetic in the session
  `TimeZone`: measured +1 h under `America/Chicago` across the 2026-11-01 DST end, 0 under UTC. docs/07
  says "Exactly 90 days after commit". The CHECK was therefore not immutable: a row written by a session
  in a DST-observing zone could fail the same CHECK on restore under UTC.
- **Flake, separately.** `idempotency.test.ts > 90 days is expired` asserted at the exact boundary with
  two clocks: the fixture aged rows with host `Date.now()`, the claim compares with container
  `clock_timestamp()`. One run in four returned `REPLAY`.
- **Fix.** `migrations/0291_idempotency_replay_window.sql` re-adds `idempotency_records_replay_window`
  (same name) as `committed_at + interval '2160 hours'`, `NOT VALID` because existing rows are
  immutable, and replaces the claim with the same body using hours. The fixture now computes ages in SQL
  (`clock_timestamp() - N hours`), so one clock decides. `populate-p02.ts` also called `clock_timestamp()`
  twice in one row, which can differ between calls; it now uses `statement_timestamp()` for both.
- **A trap worth knowing.** `CREATE OR REPLACE FUNCTION` must run as the function's owner. The committed
  P02 dump is restored with `pg_dump --no-owner`, so there the owner is `fl_migration_owner`, not
  `payments_function_owner`. 0291 looks the owner up and `SET LOCAL ROLE`s to it only when it differs,
  granting and revoking `CREATE` on `api` around the replace.
- **Proof.** New test "measures the window in hours, independent of the session TimeZone" (inserts at
  2026-08-11 under `America/Chicago`; calendar-day row refused; claim writes exactly 2160 h). Reverting
  the CHECK to `'90 days'` fails it.

### 2. Outbox derivation proof had two gaps — `b0ddd06`

- **Defect.** The CHECK proved `id` plus 11 fields but not `occurred_at`, which the envelope repeats as
  `occurredAt`. `kind` and `aggregate_type` were compared with the registry only inside `insert_outbox`.
  `messaging_function_owner` holds direct `INSERT`, so "the copies can never diverge" held only for rows
  that went through the function.
- **Fix.** `0292_outbox_derivation.sql`: `occurred_at = (envelope->>'occurredAt')::timestamptz` joins
  `outbox_messages_envelope_derivation` (same name, still one CHECK), with an explicit-offset requirement
  so the cast is the same instant in any TimeZone. `message_types_registry_key UNIQUE (message_type, kind,
aggregate_type)` plus `outbox_messages_registry_fkey` make registry agreement structural.
- **Proof.** Four new cases in `messaging-tables.test.ts`; removing either guard fails them.

### 3. A fee snapshot could disagree with the policy it named — `b0ddd06`

- **Defect.** `0250` bound only `(merchant_id, fee_policy_id, fee_policy_version)`. Nothing tied the
  snapshotted basis points / fixed amount / modes to that row, nothing tied the operation's policy to the
  payment's immutable binding (docs/07: "Immutable policy binding"), and the capture fee was bounded to
  `0..amount` rather than equal to the docs/02 formula. docs/07 leaves the check to the P04 function,
  which does not exist yet.
- **Fix.** `0293_fee_snapshot_binding.sql`: composite FKs `payment_operations_fee_snapshot_fkey` (snapshot
  = policy row) and `payment_operations_payment_fee_binding_fkey` (policy = payment's binding);
  `payment_operations_capture_fee_formula` (`(amount × bp + 5000) / 10000 + fixed`, intermediate ≤ 10¹⁶);
  `payment_operations_refund_fee_bound` (reversal ≤ refund amount, which holds because F ≤ G). A refund's
  snapshot equals its capture's by transitivity.
- **Side effect, and a second finding.** `fixtureInsertOperation` stamped a capture fee of `30` on every
  amount and hard-coded `290`/`30` in the snapshot whatever the merchant's policy was. Those rows are not
  contract-valid. `TestMerchant` now carries `feeBasisPoints`/`feeFixedAmountMinor`, and the fixture
  derives the fee. Three raw SQL inserts in tests changed `30` → `33` (the formula's fee for 100).
- **Test changes, and why none weakens a check.** "rejects a CAPTURE fee of amount + 1" became "rejects a
  CAPTURE whose exact fee exceeds its amount": with the formula in place, `fee > amount` can only be
  reached below the policy minimum (amount 1 at 290/30 → 30), which still exercises
  `payment_operations_fee_effect` alone. "accepts a CAPTURE fee exactly equal to the amount" now uses a
  10000 bp / 0 fixed policy, the only kind that prices a capture at its full amount.
- **Proof.** Five new cases; removing each `payment_operations` constraint fails them.

### 4. The three-authorization limit existed only in TypeScript — `b0ddd06`

- **Defect.** docs/03 §MVP policy decisions: at most three AUTHORIZE operations, and a new attempt only
  after the previous one is REJECTED or FAILED. No constraint mirrored it.
- **Fix.** `0294_authorization_attempt_limit.sql`: constraint trigger
  `payment_operations_authorization_attempts` (immediate; raises `23514`, constraint
  `payment_authorization_attempts`): more than three, or any open AUTHORIZE beside a succeeded one.
- **Test change.** Two exclusion-index cases put an AUTHORIZE on an already-authorized payment, which is
  exactly what docs/03 forbids. They now start from an unauthorized payment, so they test the index and
  not the new rule.
- **Proof.** Three new cases in `payment-consistency.test.ts`; loosening either rule fails them.

### 5. `fee_policies_minimum_capture` is not redundant; the recorded proof was wrong — `b821d30`

- **Defect.** PROGRESS.md (item 5 and P02-T07) says any row passing `fee_policies_fee_within_minimum` also
  passes `fee_policies_minimum_capture`. That holds for the `>= fixed` half only. With `fixed = 0,
minimum = 0`: `(0·bp + 5000)/10000 + 0 ≤ 0` is true. I dropped the constraint in a throwaway database
  and `(290 bp, 0, 0)` inserted. The break that was run relaxed the check to `>= 1`, which kept exactly the
  half that matters, so it could not fail. The existing "rejects minimum 0" case uses `fixed = 30`, so the
  other check refuses it.
- **Fix.** A fixed-0, minimum-0 case asserting `constraint = 'fee_policies_minimum_capture'`; the test's
  comment and PROGRESS.md are corrected. No money harm was possible (captures are ≥ 1), but docs/02
  requires "at least 1" and this check is the only thing enforcing it.

### 6. Two guards no test could fail without — `b821d30`

- **0260, authorization branch.** A succeeded AUTHORIZE with the payment left `NOT_REQUESTED` satisfies
  every CHECK on `payments` (all totals zero). Only this branch refuses it, and nothing exercised it.
  Covered now, plus "CANCELED without a succeeded CANCEL".
- **No catalog guard.** The 0280 `message_types` defect (RLS on, no policy for the role granted SELECT)
  was invisible to that table's own tests. `test/integration/db/catalog.test.ts` asserts across every
  application schema: each role granted a privilege on an RLS table has a policy; RLS is enabled
  everywhere; every function whose body is resolved at run time pins `search_path`; only the three pure
  predicates are PUBLIC-executable. Dropping 0290's policy fails it.

### 7. A FAILED authorization was recorded as DECLINED — `79b0f30`

- **Defect.** `transitions.ts` mapped every non-success to `DECLINED`. docs/03 §Authorization outcomes:
  "Definitive no-effect failure — Leave confirmed fields unchanged". `transitions.test.ts` asserted the
  wrong behaviour. Side effect: the A-05 summary rule (last attempt FAILED → `AUTHORIZATION_FAILED`) was
  unreachable.
- **Fix.** REJECTED → DECLINED, FAILED → unchanged. Test corrected; A-05 now exercised.

### 8. Zero amounts were accepted by the domain — `79b0f30`

- **Defect.** A refund of `0n` was accepted with count 1 and reservation 0, breaking
  `(reservedRefund = 0) = (unresolvedRefundCount = 0)`. A capture of 0 was reported as
  `CAPTURE_BELOW_MINIMUM`. Only the API schema prevented both.
- **Fix.** `INVALID_AMOUNT/AMOUNT_NOT_POSITIVE` (both existing codes) ahead of every state guard. Also: a
  REJECTED/FAILED refund without a fee snapshot errored instead of releasing its reservation; only a
  success needs the snapshot now.

### 9. The lifecycle property walk was vacuous — `6ac96f9`

- **Defect.** Measured: 0/100 walks reached a succeeded authorization, 0/2000 a capture. Removing the
  refund guard, the three-authorization limit, `capture ≤ authorized`, the capture minimum, or a failed
  refund's release left every property green. The race property's `if (raced.ok) return` was dead code
  in a correct build (first + second = captured + 1 always), so it only ever fired with the guard
  removed. The oracle was `checkPaymentInvariants`, the code under test.
- **Fix.** An `ADVANCE` action drives the oldest open operation; amounts are relative to the state they act
  on and biased to exact fits; arrays use `size: 'max'` (fast-check's default size kept walks to about ten
  actions); policies are generated valid per `checkFeePolicy`. `expectAggregateMatchesOperations`
  recomputes the aggregate from operation rows like the 0260 trigger and also checks attempts, outcomes,
  the fee formula and the capture minimum. A coverage property pins reach on a fixed seed (209 / 64 / 48 /
  32 / 21 of 300 for authorized / captured / refund accepted / refunded / fully refunded). The race
  property asserts the loser outright. The separate "invalid actions are no-ops" walk was folded into the
  main walk, which now asserts the model is returned by identity on rejection.
- **Proof.** Mutations M1, M2, M4, M5, M7, M8 each now fail at least one property; seeds 1, 42, 777 and
  the default pass at 500 runs. **M6** (previous attempt must be terminal) still survives, and must: an
  open previous attempt is refused by the pointer guard and a succeeded one by the outcome guard, so the
  state it protects is unreachable. That guard is fail-closed defence, not dead weight.

### 10. Tenant scope was entered before the credential verified — `e33aeb7`

- **Defect.** `lookupCredential` set `app.merchant_id` from the row its _prefix_ matched. The prefix is the
  non-secret, loggable half of a credential; a P04 caller that kept using the transaction after a failed
  digest check would run in the guessed merchant's scope.
- **Fix.** A required `verify(stored)` argument, in `verifyCredential`'s `stored` shape. Tenant scope is
  set only when it passes; on a miss it is called with null so that path still computes one HMAC (the
  P02-T04 timing rule); `app.credential_key_prefix` is cleared once the lookup is done.
- **API change for P04.** Call `lookupCredential(client, prefix, (stored) => verifyCredential(raw, stored,
peppers))`.

### 11. CLI credential guards were fail-open — `e33aeb7`

- **Defect.** `seed` refused only `NODE_ENV=production`; unset or misspelled `NODE_ENV` seeded and printed
  credentials. `credentials issue` had no guard and always mints `fl_test_` keys labelled synthetic.
- **Fix.** Both require `NODE_ENV` `development` or `test` (`apps/cli/src/commands/local-only.ts`).
  `credentials revoke` prints nothing secret and is unchanged. The plan required only the seed refusal;
  the reviewer brief required both — flagging the divergence rather than choosing silently.
  `docs/CONFIG.md` documents it; `.env.example` already sets `development`.

## Findings not fixed — need an owner ruling

These are contract questions, not code defects. Changing code would mean choosing an interpretation.

1. **Expired key reused with different input.** docs/05 §Retention says "any reuse returns
   `IDEMPOTENCY_KEY_EXPIRED`"; docs/07 §Acceptance says "Changed input always conflicts". The claim
   follows docs/05 and returns the original `resource_id` and `correlation_id` to a _different_ request
   after 90 days (same merchant only). Needs a `docs(contracts):` ruling before P04.
2. **Envelope hash byte form (risk R6, `0290:245`).** SHA-256 over `jsonb::text`, which is not RFC 8785:
   key order and whitespace differ from `canonical-json.ts`, contrary to A-02's "byte-identical" comment.
   _Corrected after a sweep of the later plans:_ P05-T09 already hashes inbox rows the same way
   (`sha256(convert_to(p_envelope::text, 'UTF8'))`), so outbox and inbox agree and this is not a P05
   blocker. Two loose ends remain: P05-T10's dead-letter path hashes the **raw broker bytes**
   (`envelope_hash = sha256(data)`), so a parseable envelope's DLQ hash will not equal its outbox/inbox
   hash; and archive copy-verify (docs/07 §outbox, P10) must archive exactly the `jsonb::text` bytes.
   Recommend: in P05-T10, hash the `jsonb::text` form when the payload parses and raw bytes only when it
   does not; record R6 as decided in the P02 risk table.
3. **API function-owner role (`0270:209`).** Works today; needs a CONVENTIONS §7 decision before P04 adds
   more `api` functions, since the EXECUTE ACL is the only caller boundary.
4. **DLQ failure-class names (R16, `0280:299`).** Invented strings; rule before P10 persists any.
5. **`insert_outbox` tenant check for non-payment aggregates.** Only `payment` aggregates are checked
   against their merchant; the other tables do not exist yet. Must be added with P03/P09/P10.
6. **`checkPaymentInvariants` is weaker than docs/03 and the SQL.** It lacks the `>= 0` checks,
   `exclusive ⇒ no unresolved refunds` (docs/03 exclusion rules), and totals recomputed from operations.
   The property test's independent oracle now covers these in tests, but adding them to the checker means
   new `INVARIANT_IDS`, which the P01 plan enumerates — a plan decision, not mine to make.

## Later-phase plan docs corrected by this review

A sweep of `docs/execution-plan/tasks/P03`–`P13` for anything these fixes invalidate:

- **P04-T04 Bearer authentication (`P04-merchant-api.md`).** Described the old `lookupCredential(client,
locator)` that set `app.merchant_id` before verification. Rewritten to the new
  `lookupCredential(client, locator, verify)` contract, and the interface table updated.
- **P06-T11 provider evidence migration (`P06-providers-worker.md`).** Two CHECKs specified the same calendar-day bug
  as 0270: `received_at + interval '7 days'` and `+ interval '90 days'`. Now `'168 hours'` and
  `'2160 hours'`.
- **P02 plan text** for the claim is annotated as superseded by 0291 (history kept).

Checked and already consistent with the fixes: P05-T02 snapshots the fee from the payment-bound policy
with the same HALF_UP formula as 0293's CHECK; P05/P06 already say a FAILED authorization leaves
confirmed fields unchanged (the TypeScript was the deviation, not the plan); P05's authorization-ceiling
tests raise from the acceptance guard before 0294's trigger could fire; P04's expiry tests use
`fixtureInsertIdempotencyRecord`, which still works and now ages records on the database clock.

Worth a look when P10 is planned in detail: its settlement example says "capture 10000 / fee 300". At
the default fixture policy (290 bp + 30) a 10000 capture costs 320, and 0293 now rejects any other fee
on a capture row. The example is consistent only if that test's merchant has a 300 bp / 0 fixed policy.

## Known residue, deliberately left

- **Comment drift in frozen migrations.** `0220:578` says "No UPDATE policy exists for this role", but
  `provider_account_versions_function_owner_lock` is an UPDATE policy (`WITH CHECK (false)`). `0210:217`
  says trigger functions need EXECUTE for the mutating role (only their callees do). Editing either would
  change the file checksum and break every existing database, so they are recorded here instead.
- **`select_route` under a concurrent supersede** can report `NO_CURRENT_VERSION` for an instant (the
  locked re-read sees the old row superseded but not the new one). Fails closed; not a correctness hole.

## Checks that were already right

The idempotency claim (one OWNER among 100, no `23505`, waiter takes over on rollback, CONFLICT reveals
nothing); explicit `merchant_id` predicates in both repositories, proven on the owner pool; every
run-time-resolved function pins `search_path` (SQL-standard `RETURN` bodies bind names at creation);
money is `bigint` throughout and the HALF_UP and cumulative-reversal arithmetic match docs/02; the 0290
`message_types` repair was the right forward-only fix.
