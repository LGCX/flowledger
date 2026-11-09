# P13 — GCP deployment, reference benchmark, and portfolio evidence

## Phase overview

**Goal.** Deploy FlowLedger reproducibly to an HA GCP environment with Terraform, prove backup/restore and planned failover with measured recovery, run the reference benchmark matrix and the ledger contention comparison there, and publish the evidence package (benchmark report, evidence index, diagrams, known-limits linkage) plus an offline demo that runs from a clean clone with no cloud account.

**Entry criteria.** `P12-GATE` green: harness, stop conditions, lock sampler, report generator, connection budget, and local preflight evidence exist.

**Exit gate (docs/10 §M13 exit gate: "Reproducible HA deployment and performance-ready gate complete").** `P13-GATE` proves: Terraform creates a new environment plus documented bootstrap with no manual resource mutation; per-process service accounts cannot reach other processes' secrets/topics; regional HA is enabled and the planned failover produced measured recovery with exact post-failover audits; the restore rehearsal met RPO ≤ 5 min / RTO ≤ 60 min or the miss is documented; reference trials (3 per headline workload + 60-min soak) and the contention pair exist with zero verify findings and zero dropped work; the evidence index links every claim to a raw result, test, dashboard, or command; the demo runs offline from a clean clone.

**Migrations.** None planned. Range `1300`–`1399` is reserved; P13 creates no migration. Cloud SQL harness-admin grants (P12 risk R-05) are applied by the bootstrap script (`infra/deploy/grant-harness-admin.sql`, executed as table owner `fl_migration_owner`), not by a migration, because they are environment-specific benchmark access, not application schema.

**Who can do what.**

| Executor | Tasks |
| --- | --- |
| **Agent, offline** (no GCP account; verifiable with `terraform validate`, unit/contract tests, Docker builds) | P13-T01 … P13-T12, P13-T19, P13-T20, P13-T21, P13-T22 (structure; final values filled after T18) |
| **HUMAN with a GCP project + billing — blocked on human input (decision D-04 deferred 2026-11-08; revisit after P10-GATE or P12-GATE)** | P13-T13, P13-T14, P13-T15, P13-T16, P13-T17 |
| **Agent, blocked on human-produced artifacts** | P13-T18 (needs T16/T17 evidence), P13-GATE (final checks need T13–T18 evidence) |

**Interfaces consumed from earlier phases.**

- From P12: `node test/performance/run.mjs <profile>` with `--target reference`, `report.mjs`, `infra/connection-budget.json` (`reference` section), `test/performance/lib/{system,lock-sampler,pg-metrics,timings,stop-conditions,verify-loop,dataset}.mjs`, env vars `PERF_ADMIN_DATABASE_URL`, `PERF_SIMULATOR_ADMIN_DATABASE_URL`, `PERF_API_BASE_URL`, `PERF_SIMULATOR_BASE_URL`, evidence layout `docs/evidence/runs/<runId>/`.
- From P05: `packages/messaging/src/topology.json` (`{ topics: { COMMAND, EVENT }, subscriptions: [{ name, consumer, topic, messageTypes, ordered, deadLetterTopic }] }`, e.g. `flowledger-payment-worker-v1` / `flowledger-payment-worker-dlq-v1`) + `topology.ts` (`TOPICS`, `SUBSCRIPTIONS`, `subscriptionFor`, `pubsubFilter`, `ensureTopology`, `MAX_DELIVERY_ATTEMPTS = 8`; `ensureTopology` uses ack deadline 60 s and broker `maxDeliveryAttempts = MAX_DELIVERY_ATTEMPTS + 2`) — topics `flowledger-commands-v1`, `flowledger-events-v1`, one subscription per consumer (`payment-worker`, `reconciler`, `provider-webhook-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`), one dead-letter topic per subscription, and per-subscription settings (ack deadline, max delivery attempts, ordering). `provider-webhook-worker` has a subscription only if P09 added one.
- From P08: `payments.recovery_epochs` / `payments.current_recovery_fence()` and CLI `flowledger dr fence --actor --reason` (new epoch; provider dispatch and notification application off, webhook receipt continues), `flowledger dr reconcile-window --since <ISO timestamp> --actor --reason [--json]`, `flowledger dr unfence --epoch <n> --actor --reason` (refuses unless the latest reconcile-window result is clean and verify reports zero findings). Republishing committed unpublished outbox envelopes (docs/08 DR step 5) is the normal outbox relay running against the restored database (original UUIDs).
- From P11: metric catalog (`ledger_bucket_lock_wait`, `db_pool_wait`, `db_pool_active_connections`, `db_transaction_retries_total`, …), dashboard JSON (incl. `overview-correctness.json`, the demo dashboard) and alert-rule definitions with docs/08 thresholds, IaC/container scan tooling, `docs/KNOWN_LIMITS.md`, `docs/security/THREAT_MODEL.md`.
- From P02: database roles (CONVENTIONS §7) created by migration `0200`; from P06/CONVENTIONS §16: `apps/provider-simulator`, roles `fl_simulator`, `fl_simulator_truth`, simulator migrations.
- `flowledger migrate`, `flowledger verify --json --require-ground-truth`, `flowledger seed --profile perf`.

**Interfaces provided.** Final: `infra/terraform/**`, `infra/docker/Dockerfile`, `infra/deploy/deploy.sh`, `infra/deploy/verify-iam.sh`, `infra/drills/{restore-rehearsal.sh,failover-drill.sh}`, `docs/DEPLOY.md`, `docs/BENCHMARK_REPORT.md`, `docs/EVIDENCE_INDEX.md`, `docs/ARCHITECTURE_DIAGRAMS.md`, `scripts/demo.mjs` (`pnpm demo`).

### Evidence honesty rule (restated in every report task)

Measured values are copied only from raw artifacts (`docs/evidence/runs/<runId>/*.json` generated by the harness, drill output files, Terraform/gcloud output captured to files). Targets stay labeled as targets. A number with no artifact path next to it is not allowed in any P13 document. No task may fabricate, estimate, or "fill in" a result; if a human task has not run, documents say "not yet measured".

---
### P13-T01 — Container images (one Dockerfile pattern)

**Task ID:** `P13-T01`
**Feature:** Reproducible images for every process and job
**Commit:** `build(infra): add single parameterized Dockerfile for all apps`
**Priority:** Critical
**Dependencies:** `P12-GATE`
**Estimated complexity:** M
**Contract references:** docs/10 §M13 bullet 1 (Cloud Run services/jobs), §Delivery safety (health, graceful shutdown); docs/01 §Deployable processes; CONVENTIONS §2 (Node 24, pnpm 10), §3 (apps list), §16 (provider-simulator)
**Files:** create: `infra/docker/Dockerfile`, `.dockerignore`, `test/contract/dockerfile.test.ts`; modify: `.github/workflows/ci.yml` (image build matrix job, no push); must not touch: app source
**Executor:** Agent, offline.

**Objective** — One Dockerfile builds any app selected by build arg, so every Cloud Run service and job uses the same base, user, and build steps.

**Implementation instructions**
1. Multi-stage `infra/docker/Dockerfile`: `ARG APP`; stage `build` from `node:24-<pinned digest>-slim`, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm --filter @flowledger/app-${APP} deploy --prod /out` (pnpm deploy copies the app with its production dependencies). Stage `runtime` from the same base digest: copy `/out`, `USER node`, `ENV NODE_ENV=production`, `EXPOSE 8080`, `CMD ["node","dist/main.js"]`. For `APP=cli` the CMD is `["node","dist/main.js","--help"]` (jobs pass args).
2. Valid `APP` values: `api`, `outbox-relay`, `payment-worker`, `provider-webhook-receiver`, `provider-webhook-worker`, `reconciler`, `settlement-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`, `provider-simulator`, `cli`. The simulator image also contains `apps/provider-simulator/migrations/`.
3. Port contract (P00): the API listens on `API_PORT`, workers serve `/healthz`/`/readyz` on `HEALTH_PORT`, the simulator on `SIMULATOR_PORT`. Cloud Run requires the container to listen on its configured port (8080), so P13-T08 sets the matching variable to `8080` per service; the image only `EXPOSE`s 8080.
4. `.dockerignore`: `node_modules`, `artifacts`, `docs/evidence`, `.git`, `**/*.test.ts`, `infra/terraform/.terraform`.
5. CI job `images` builds all 11 images (`docker build --build-arg APP=<app> -f infra/docker/Dockerfile .`) on PRs that touch `apps/**`, `packages/**`, `infra/docker/**`; runs the container scan configured in P11 on each.

**Expected behavior** — `docker build --build-arg APP=api -f infra/docker/Dockerfile -t fl-api .` produces an image running as `node`; `docker run -e … fl-api` serves `/healthz`.

**Acceptance criteria**
- [ ] All 11 images build from one Dockerfile; base image pinned by digest.
- [ ] Runtime stage runs as non-root and contains no dev dependencies or test files.
- [ ] No secret, `.env`, or credentials file in any image (scan step).

**Testing requirements**
- `test/contract/dockerfile.test.ts`: Dockerfile has `USER node`, base `FROM` lines pinned by `@sha256:`, `NODE_ENV=production`; `.dockerignore` contains the listed entries; the `APP` list equals the app directories in `apps/`.
- CI `images` job green; locally: `docker build --build-arg APP=provider-simulator -f infra/docker/Dockerfile .`.
- Commands: `pnpm vitest run --project contracts test/contract/dockerfile.test.ts`.

**Non-goals** — No push to a registry (P13-T11 deploy script pushes).

**Handoff checklist**
- [ ] Image sizes recorded in the commit body.

---

### P13-T02 — Terraform inputs generated from code (topology, budget)

**Task ID:** `P13-T02`
**Feature:** Single source for Pub/Sub topology and connection budget
**Commit:** `build(infra): export messaging topology and connection budget for terraform`
**Priority:** High
**Dependencies:** `P12-GATE`
**Estimated complexity:** S
**Contract references:** CONVENTIONS §9 ("the emulator bootstrap script and Terraform both read the same list"); docs/10 §M13 bullet 3 (global connection budget)
**Files:** create: `scripts/export-terraform-inputs.mjs`, `infra/terraform/generated/topology.json`, `test/contract/terraform-inputs.test.ts`; modify: `package.json` (script `infra:inputs`); must not touch: `packages/messaging/src/topology.ts`
**Executor:** Agent, offline.

**Objective** — Terraform cannot import TypeScript; generate a committed JSON from `topology.ts` and fail CI on drift so the Pub/Sub resources always match the code.

**Implementation instructions**
1. `scripts/export-terraform-inputs.mjs` reads `packages/messaging/src/topology.json` plus the built `@flowledger/messaging` exports `pubsubFilter`, `MAX_DELIVERY_ATTEMPTS` (and the same ack-deadline/broker-attempt values `ensureTopology` uses) and writes `infra/terraform/generated/topology.json`: `{ "topics": ["flowledger-commands-v1","flowledger-events-v1"], "subscriptions": [{ "name", "topic", "consumer", "ackDeadlineSeconds", "maxDeliveryAttempts", "enableMessageOrdering", "deadLetterTopic", "filter"? }] }` — every field copied from `topology.json` / those exports (`enableMessageOrdering` = `ordered`, `filter` = `pubsubFilter(sub)`), none invented here.
2. `pnpm infra:inputs` runs it. Terraform reads `infra/connection-budget.json` directly (`jsondecode(file(...))`); no copy.
3. `test/contract/terraform-inputs.test.ts`: regenerate into a temp file and compare byte-for-byte with the committed file; assert every subscription in `topology.json` appears with its dead-letter topic.

**Expected behavior** — Adding a subscription in `topology.ts` without rerunning `pnpm infra:inputs` fails the contract test.

**Acceptance criteria**
- [ ] Generated JSON committed; drift test in `pnpm check` (contracts project).

**Testing requirements**
- `test/contract/terraform-inputs.test.ts` (drift + consumer coverage). Commands: `pnpm build && pnpm vitest run --project contracts test/contract/terraform-inputs.test.ts`.

**Non-goals** — No Terraform resources.

**Handoff checklist**
- [ ] Break test: edit one ack deadline in the JSON → drift test fails.

---

### P13-T03 — `flowledger db set-role-passwords`

**Task ID:** `P13-T03`
**Feature:** Least-privilege runtime role credentials without Cloud SQL built-in users
**Commit:** `feat(cli): add set-role-passwords command for deployed environments`
**Priority:** High
**Dependencies:** `P12-GATE`
**Estimated complexity:** S
**Contract references:** docs/10 §M13 bullet 2 ("distinct least-privilege service account and database role"); CONVENTIONS §7 (role table), §16 (`fl_simulator`, `fl_simulator_truth`)
**Files:** create: `apps/cli/src/commands/set-role-passwords.ts`, `apps/cli/src/commands/set-role-passwords.test.ts`, `test/integration/set-role-passwords.test.ts`; modify: CLI command registry, `docs/CONFIG.md`; must not touch: `migrations/**`
**Executor:** Agent, offline.

**Objective** — Cloud SQL users created through the Cloud SQL API join `cloudsqlsuperuser` (over-privileged). Runtime roles are instead created by migration `0200` as plain roles (owned with ADMIN OPTION by `fl_migration_owner`, P02). P02's `setLocalRolePasswords` sets one shared password and is refused when `NODE_ENV=production`, so deployed environments need a per-role command: this one, run by the migrate job with passwords from Secret Manager.

**Implementation instructions**
1. `flowledger db set-role-passwords [--database flowledger|simulator]` reads, for each role in a fixed allowlist, env var `ROLE_PASSWORD_<ROLE_UPPER>` (e.g. `ROLE_PASSWORD_FL_API`). FlowLedger allowlist: every login role in CONVENTIONS §7 except `fl_migration_owner`. Simulator allowlist: `fl_simulator`, `fl_simulator_truth`.
2. For each role with a set variable: `ALTER ROLE <quote_ident(role)> WITH LOGIN PASSWORD <literal>` built with `pg`'s `escapeIdentifier`/`escapeLiteral` (password never interpolated unescaped), executed as the connecting migration owner. Missing variable → skip with a log line naming the role (not the value). Unknown `ROLE_PASSWORD_*` variable → exit 1.
3. Never log or echo a password; the command's own log output passes through the redaction allowlist.

**Expected behavior** — With `ROLE_PASSWORD_FL_API=x…`, `fl_api` can log in with that password afterwards.

**Acceptance criteria**
- [ ] Only allowlisted roles can be altered; unknown variables rejected.
- [ ] Passwords never appear in output.

**Testing requirements**
- `apps/cli/src/commands/set-role-passwords.test.ts`: env parsing, allowlist rejection, escaping of a password containing `'` and `\`.
- `test/integration/set-role-passwords.test.ts`: after running, `fl_api` connects with the new password; captured stdout/stderr contain neither the password nor any `prohibited-data.ts` fixture.
- Commands: `pnpm vitest run --project integration test/integration/set-role-passwords.test.ts`, `pnpm check`.

**Non-goals** — No role creation, no grants.

**Handoff checklist**
- [ ] Redaction negative test present.

---

### P13-T04 — Terraform foundation: project services, networking, registry, evidence bucket

**Task ID:** `P13-T04`
**Feature:** Base GCP infrastructure
**Commit:** `feat(infra): add terraform foundation for networking, registry, and evidence storage`
**Priority:** Critical
**Dependencies:** `P13-T02`
**Estimated complexity:** M
**Contract references:** docs/10 §M13 bullet 1 (networking, artifact storage), §M13 T&A bullet 1; docs/09 §Reference benchmark environment (one region, `us-central1`), §Load-generation method (preserve raw output); docs/01 §Initial deployment, §MVP deployment decisions (single region); CONVENTIONS §2 (Terraform 1.9+)
**Files:** create: `infra/terraform/versions.tf`, `infra/terraform/variables.tf`, `infra/terraform/locals.tf`, `infra/terraform/project.tf`, `infra/terraform/network.tf`, `infra/terraform/registry.tf`, `infra/terraform/evidence.tf`, `infra/terraform/outputs.tf`, `infra/terraform/terraform.tfvars.example`, `.github/workflows/ci.yml` (job `terraform`: fmt/validate/IaC scan); must not touch: app source
**Executor:** Agent, offline (validated with `terraform init -backend=false && terraform validate`).

**Objective** — A single root module (no submodules — one environment shape, no reuse requirement) with the base resources every later file uses.

**Implementation instructions**
1. `versions.tf`: `required_version = ">= 1.9"`; providers `hashicorp/google` and `hashicorp/random` pinned to exact versions; backend `gcs` with `bucket`/`prefix` supplied at `terraform init -backend-config` (documented in P13-T11).
2. `variables.tf`: `project_id` (string), `region` (default `"us-central1"`), `environment` (default `"reference"`), `image_tag` (string), `deletion_protection` (bool, default `true`), `enable_ops_vm` (bool, default `true`), `alert_notification_email` (string). No secret values as variables.
3. `locals.tf`: `budget = jsondecode(file("${path.module}/../connection-budget.json")).reference`; `topology = jsondecode(file("${path.module}/generated/topology.json"))`; `apps` = the 10 runtime process names + `cli`.
4. `project.tf`: `google_project_service` for `run`, `sqladmin`, `pubsub`, `secretmanager`, `artifactregistry`, `compute`, `servicenetworking`, `monitoring`, `logging`, `cloudtrace`, `iam`.
5. `network.tf`: VPC `flowledger-vpc` (custom mode), subnet `flowledger-run` (/24) for Cloud Run Direct VPC egress, subnet `flowledger-ops` (/28) for the ops VM; private services access (`google_compute_global_address` purpose `VPC_PEERING` + `google_service_networking_connection`) for Cloud SQL private IP; Cloud NAT for the ops VM egress (package installs); firewall: allow only IAP TCP forwarding (`35.235.240.0/20`) to the ops VM on 22.
6. `registry.tf`: Artifact Registry Docker repo `flowledger` in `region`.
7. `evidence.tf`: GCS bucket `<project>-flowledger-evidence`, uniform bucket-level access, versioning on, retention policy 365 days (immutable evidence bundles, docs/10 §Release/evidence run "Immutable evidence bundle retained"), public access prevention enforced.
8. `terraform.tfvars.example` with synthetic values only.
9. CI job `terraform`: `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`, and the IaC scanner chosen in P11.

**Expected behavior** — `terraform validate` passes offline; `terraform plan` (human, P13-T13) shows only the resources above.

**Acceptance criteria**
- [ ] Single region from a variable defaulting to `us-central1`.
- [ ] Cloud SQL private IP path exists; no public IP resources for databases.
- [ ] Evidence bucket has retention and versioning.
- [ ] fmt/validate/scan green in CI.

**Testing requirements**
- CI `terraform` job. `test/contract/terraform-static.test.ts` (create): parse `.tf` files as text and assert providers are pinned to exact versions, no `0.0.0.0/0` ingress firewall rule, evidence bucket has `retention_policy` and `public_access_prevention = "enforced"`.
- Commands: `cd infra/terraform && terraform init -backend=false && terraform validate`; `pnpm vitest run --project contracts test/contract/terraform-static.test.ts`.

**Non-goals** — No retention-archive or raw-quarantine buckets (see risk R-06).

**Handoff checklist**
- [ ] `.terraform/` and `*.tfstate*` gitignored.

---

### P13-T05 — Cloud SQL: HA PostgreSQL 17 and the separate simulator instance

**Task ID:** `P13-T05`
**Feature:** Regional HA authoritative database with backups/PITR; isolated simulator database
**Commit:** `feat(infra): add regional HA Cloud SQL PostgreSQL 17 and simulator instance`
**Priority:** Critical
**Dependencies:** `P13-T04`
**Estimated complexity:** M
**Contract references:** docs/09 §Reference benchmark environment (PG17, regional HA, synchronous standby/automatic failover, 8 vCPU, 32 GiB, SSD, synchronous commits); docs/08 §Disaster recovery (RPO ≤ 5 min, RTO ≤ 60 min, continuous backups, PITR); docs/01 §MVP deployment decisions; docs/10 §M13 bullets 1, 3, 5, T&A bullets 4–5; CONVENTIONS §16 (simulator DB unreachable from FlowLedger credentials)
**Files:** create: `infra/terraform/cloudsql.tf`; modify: `infra/terraform/outputs.tf`; must not touch: migrations
**Executor:** Agent, offline.

**Objective** — Provision the contracted database and keep the simulator's database physically separate so FlowLedger credentials cannot reach ground truth and the simulator's load does not share the system under test's resources.

**Implementation instructions**
1. `google_sql_database_instance.flowledger`: `database_version = "POSTGRES_17"`, `region = var.region`, `deletion_protection = var.deletion_protection`, settings: `tier = "db-custom-8-32768"`, `availability_type = "REGIONAL"`, `disk_type = "PD_SSD"`, `disk_autoresize = true`, `ip_configuration { ipv4_enabled = false, private_network = <vpc id>, ssl_mode = "ENCRYPTED_ONLY" }`, `backup_configuration { enabled = true, point_in_time_recovery_enabled = true, transaction_log_retention_days = 7, start_time = "03:00", backup_retention_settings { retained_backups = 14 } }`, `database_flags`: `max_connections = local.budget.instances.flowledger.maxConnections`, `track_io_timing = on`, `track_wal_io_timing = on`, `cloudsql.enable_pg_stat_statements` / `pg_stat_statements.track = all` (whichever flag name Cloud SQL accepts for PG17 — verify in the provider docs; record it), `log_min_duration_statement = 1000`. Do not set `synchronous_commit` (default `on` is the contract).
2. `google_sql_database.flowledger` (`flowledger`).
3. `google_sql_user.migration_owner`: name `fl_migration_owner`, built-in user, password from `random_password.migration_owner` stored in Secret Manager (P13-T07 creates the secret container; this file writes the version). This is the only built-in Cloud SQL user created for the FlowLedger database (all runtime roles come from migration `0200` + P13-T03).
4. `google_sql_database_instance.simulator`: same version, `tier = "db-custom-2-8192"`, `availability_type = "ZONAL"`, private IP only, backups enabled, `max_connections = local.budget.instances.simulator.maxConnections`; database `flowledger_sim`; built-in user `fl_simulator_owner` (migrations), passwords in Secret Manager. Roles `fl_simulator` and `fl_simulator_truth` come from the simulator migrations and get passwords via `flowledger db set-role-passwords --database simulator`.
5. Outputs: private IPs and connection names of both instances (no passwords).
6. In `infra/terraform/README` comments inside `cloudsql.tf` header: why the simulator is a separate instance (CONVENTIONS §16 isolation + no resource sharing with the system under test) and that the connection budget has one section per instance.

**Expected behavior** — `terraform plan` shows a REGIONAL PG17 instance with PITR and a separate ZONAL simulator instance; no public IPs.

**Acceptance criteria**
- [ ] HA (`REGIONAL`), PITR, backups, SSD, PG17, 8 vCPU / 32 GiB, private IP only, SSL required.
- [ ] `max_connections` comes from the budget file for both instances.
- [ ] Simulator on its own instance; no FlowLedger role exists there and vice versa.

**Testing requirements**
- `test/contract/terraform-static.test.ts` (extend): asserts `availability_type = "REGIONAL"`, `point_in_time_recovery_enabled = true`, `database_version = "POSTGRES_17"`, `ipv4_enabled = false`, and `max_connections` references `local.budget`.
- Commands: `terraform validate`; `pnpm vitest run --project contracts test/contract/terraform-static.test.ts`.

**Non-goals** — No read replicas (docs ADR-0002: authoritative checks on the primary).

**Handoff checklist**
- [ ] The exact Cloud SQL flag names used are recorded in the file header with the provider version.

---

### P13-T06 — Pub/Sub topics, subscriptions, and DLQs from the topology

**Task ID:** `P13-T06`
**Feature:** Messaging infrastructure matching code topology
**Commit:** `feat(infra): add pubsub topics, ordered subscriptions, and dead-letter topics`
**Priority:** Critical
**Dependencies:** `P13-T02`, `P13-T04`
**Estimated complexity:** S
**Contract references:** docs/09 §Reference benchmark environment ("Google Pub/Sub with ordering by payment ID"); docs/01 §MVP deployment decisions (pull/StreamingPull, flow control); docs/08 §DLQ contract; docs/04 §Retention; CONVENTIONS §9
**Files:** create: `infra/terraform/pubsub.tf`; must not touch: `generated/topology.json` (generated only)
**Executor:** Agent, offline.

**Objective** — Create exactly the topics and subscriptions listed in the generated topology.

**Implementation instructions**
1. `google_pubsub_topic` for each `local.topology.topics` entry and each distinct `deadLetterTopic`.
2. `google_pubsub_subscription` per `local.topology.subscriptions` (`for_each` keyed by name): `topic`, `ack_deadline_seconds`, `enable_message_ordering`, `filter` (if present), `message_retention_duration = "604800s"`, `retry_policy { minimum_backoff = "10s", maximum_backoff = "600s" }`, `dead_letter_policy { dead_letter_topic = <dlq>, max_delivery_attempts = <from JSON> }`, `expiration_policy { ttl = "" }` (never expire).
3. One pull subscription per DLQ topic (`<name>-dlq-sub`, retention 7 days) so dead-lettered envelopes are retained for the DLQ/orphan detector.
4. Pub/Sub service agent IAM: `roles/pubsub.publisher` on each DLQ topic and `roles/pubsub.subscriber` on each source subscription for `service-<project number>@gcp-sa-pubsub.iam.gserviceaccount.com` (required for dead-lettering).

**Expected behavior** — Plan lists 2 topics + N DLQ topics + N subscriptions + N DLQ subscriptions where N = consumer count.

**Acceptance criteria**
- [ ] Every subscription has ordering per topology, a DLQ, and never expires.
- [ ] No hand-written topic or subscription names (all from the JSON).

**Testing requirements**
- `test/contract/terraform-static.test.ts` (extend): `pubsub.tf` contains no string literal subscription names; references `local.topology`.
- Commands: `terraform validate`.

**Non-goals** — No push subscriptions.

**Handoff checklist**
- [ ] Service-agent IAM bindings present for dead-lettering.

---

### P13-T07 — Service accounts, IAM, and Secret Manager

**Task ID:** `P13-T07`
**Feature:** Distinct least-privilege identity per process
**Commit:** `feat(infra): add per-process service accounts, secrets, and least-privilege IAM`
**Priority:** Critical
**Dependencies:** `P13-T05`, `P13-T06`
**Estimated complexity:** M
**Contract references:** docs/10 §M13 bullet 2, T&A bullet 2 ("Service accounts cannot access another process's secrets or unnecessary topics/tables"); docs/05 §Authentication (credential pepper in Secret Manager); CONVENTIONS §7 (role per process, `fl_payment_worker` sole decryptor of payment-method references), §16
**Files:** create: `infra/terraform/iam.tf`, `infra/terraform/secrets.tf`; modify: `infra/terraform/outputs.tf`, `infra/terraform/variables.tf` (`database_name`, `simulator_database_name`); must not touch: app source
**Executor:** Agent, offline.

**Objective** — Each process can read only its own secrets, publish/subscribe only where its code does, and reach only its own database.

**Implementation instructions**
1. Service accounts `fl-<process>@…` for: `api`, `outbox-relay`, `payment-worker`, `provider-webhook-receiver`, `provider-webhook-worker`, `reconciler`, `settlement-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`, `provider-simulator`, `migrate` (job), `verify` (job), `ops` (ops VM: load generator + drills), `otel` is not separate (sidecar runs as the service's SA).
2. Secrets (`google_secret_manager_secret`, automatic replication, values written by Terraform from `random_password` or left for the human to add, as listed): `db-url-<process>` for each FlowLedger runtime process (value: `postgres://<role>:<random>@<private ip>:5432/${var.database_name}?sslmode=require` — add `variable "database_name"` (default `"flowledger"`) to `variables.tf`; the reference contention pair switches it (risk R-10); role per CONVENTIONS §7 mapping — api→`fl_api`, outbox-relay→`fl_relay`, payment-worker→`fl_payment_worker`, provider-webhook-receiver→`fl_webhook_receiver`, provider-webhook-worker→`fl_webhook_worker`, reconciler→`fl_reconciler`, settlement-worker→`fl_settlement_worker`, merchant-webhook-projector→`fl_webhook_projector`, merchant-webhook-dispatcher→`fl_webhook_dispatcher`); `db-url-simulator` (`fl_simulator` on the simulator instance, database `${var.simulator_database_name}`, default `"flowledger_sim"`); `db-url-simulator-truth` likewise uses `var.simulator_database_name`; `db-url-simulator-truth` (`fl_simulator_truth`); `db-url-migration-owner`; `db-url-simulator-owner`; `db-url-verify` (the read role `verify` uses — `fl_operator_readonly` unless P03 defined a dedicated verify role); `db-url-operator-command` (`fl_operator_command`, drills only); `db-url-harness-admin` (Cloud SQL `postgres` built-in user, ops VM only); `role-passwords` (JSON of `ROLE_PASSWORD_*` values, migrate job only); app secrets the contracts require: `api-credential-pepper` (api), `payment-method-encryption-key` (payment-worker only), `provider-webhook-secrets` (provider-webhook-receiver, provider-simulator), `provider-credentials` (payment-worker, reconciler, provider-simulator), `merchant-webhook-signing-keys` (merchant-webhook-dispatcher). **[ASSUMPTION R-07]** exact app-secret list and variable names come from `docs/CONFIG.md`; one secret per variable marked secret there, none added beyond it. Secret-reference columns (`secret_reference`, `signing_secret_reference`) stay `local-secret://<path>` in this MVP deployment: each referenced value is injected from its Secret Manager secret into the owning service as env var `FLOWLEDGER_SECRET_<PATH>`, so `resolveSecretReference` (P06, `packages/config/src/secrets.ts`; UTF-8 bytes, no base64) resolves it unchanged; the `gsm://` scheme (CONVENTIONS §11) is not needed by any P13 task and is recorded in `docs/KNOWN_LIMITS.md`.
3. `google_secret_manager_secret_iam_member` `roles/secretmanager.secretAccessor` per secret for its owning SA(s) only — no project-level accessor bindings.
4. Pub/Sub: `roles/pubsub.publisher` on `flowledger-commands-v1` and `flowledger-events-v1` for `fl-outbox-relay` only; `roles/pubsub.subscriber` on each subscription for the SA of its consumer process only (subscription `consumer` field in `generated/topology.json` → the SA of the process hosting that consumer); DLQ subscriptions: subscriber for the SA running the DLQ/orphan detector (payment-worker per CONVENTIONS §3) and `ops`.
5. Project roles: `roles/cloudsql.client` for SAs that connect to Cloud SQL (all FlowLedger runtime SAs, simulator, migrate, verify, ops); `roles/logging.logWriter`, `roles/monitoring.metricWriter`, `roles/cloudtrace.agent` for all runtime SAs; `roles/artifactregistry.reader` on the repo for Cloud Run service agent.
6. Simulator invocation: `roles/run.invoker` on `provider-simulator` for `fl-payment-worker`, `fl-reconciler`, `fl-ops` only (used if the service requires auth — see P13-T08 step 4).

**Expected behavior** — `fl-api` has accessor on `db-url-api` and `api-credential-pepper` and nothing else.

**Acceptance criteria**
- [ ] One SA per process/job; no SA has a project-level secret accessor or Pub/Sub admin role.
- [ ] No FlowLedger SA can access `db-url-simulator*` secrets; only `verify` and `ops` can access `db-url-simulator-truth`.
- [ ] Only `fl-payment-worker` can access `payment-method-encryption-key`.

**Testing requirements**
- `test/contract/iam-matrix.test.ts` (create): parse `iam.tf`/`secrets.tf` text into `(secret, member)` pairs and assert the matrix exactly equals a table declared in the test (expected owners per secret); assert no `google_project_iam_member` grants `secretmanager.secretAccessor`, `pubsub.admin`, `pubsub.editor`, or `owner/editor`.
- Commands: `terraform validate`; `pnpm vitest run --project contracts test/contract/iam-matrix.test.ts`.

**Non-goals** — Runtime verification against a live project (P13-T11 script, executed in P13-T13).

**Handoff checklist**
- [ ] Break test: add `fl-api` as accessor on `payment-method-encryption-key` → matrix test fails.

---
### P13-T08 — Cloud Run services and jobs (migration as an explicit job)

**Task ID:** `P13-T08`
**Feature:** Deployed processes with bounded scaling, concurrency, timeouts, and connection budget
**Commit:** `feat(infra): add cloud run services and migrate/verify jobs within the connection budget`
**Priority:** Critical
**Dependencies:** `P13-T01`, `P13-T03`, `P13-T07`
**Estimated complexity:** L
**Contract references:** docs/09 §Reference benchmark environment (API: 2 vCPU, ≥ 1 GiB, concurrency 40, min 4 warm, max bounded by DB connections; workers 2 vCPU independently autoscaled, bounded provider concurrency); docs/10 §M13 bullets 1–4, T&A bullet 3; docs/01 §MVP deployment decisions (StreamingPull workers, dedicated webhook receiver); docs/08 §Sweep and claim defaults; CONVENTIONS §11, §16
**Files:** create: `infra/terraform/run.tf`, `infra/terraform/jobs.tf`, `test/contract/no-migrate-on-startup.test.ts`; modify: `infra/terraform/outputs.tf`; must not touch: app source
**Executor:** Agent, offline.

**Objective** — Deploy every process as its own Cloud Run service with instance bounds taken from the connection budget, and run migrations only as an explicit job.

**Implementation instructions**
1. `run.tf`: `google_cloud_run_v2_service` per process (`for_each` over a local map), image `<region>-docker.pkg.dev/<project>/flowledger/<app>:${var.image_tag}`, `service_account = fl-<process>`, `vpc_access { network_interfaces { network, subnetwork = flowledger-run } egress = "PRIVATE_RANGES_ONLY" }` (payment-worker and reconciler: `ALL_TRAFFIC` so they reach the internal simulator), `scaling { min_instance_count = local.budget.processes[p].minInstances, max_instance_count = local.budget.processes[p].maxInstances }`, env `DATABASE_POOL_MAX = local.budget.processes[p].poolMax`, `API_PORT=8080` (api) / `HEALTH_PORT=8080` (workers, receiver if it uses the health server) / `SIMULATOR_PORT=8080` (simulator), `DATABASE_URL` from secret `db-url-<p>`, other secrets from P13-T07 mounted as env, `NODE_ENV=production`, OTel env (P13-T09). Startup probe and liveness probe: HTTP `/readyz` and `/healthz`.
   - `api`: `cpu = "2"`, `memory = "1Gi"`, `max_instance_request_concurrency = 40`, `min_instance_count = 4` (must equal the budget file value), ingress `INGRESS_TRAFFIC_ALL`, unauthenticated invoker (`allUsers` `roles/run.invoker`) — merchant auth is the API's own bearer credential (docs/05).
   - `provider-webhook-receiver`: ingress all, unauthenticated invoker (signature verification is the auth, docs/06).
   - Workers (`outbox-relay`, `payment-worker`, `provider-webhook-worker`, `reconciler`, `settlement-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`): `cpu = "2"`, `memory = "1Gi"`, `cpu_idle = false` (CPU always allocated — StreamingPull and sweepers run outside requests), ingress `INGRESS_TRAFFIC_INTERNAL_ONLY`, no invoker bindings, `min_instance_count ≥ 1`.
   - `provider-simulator`: ingress `INGRESS_TRAFFIC_INTERNAL_ONLY`, `SIMULATOR_TEST_ENDPOINTS=1` (benchmark environment; the service is unreachable from the internet), `PROVIDER_SIMULATOR_DATABASE_URL` from `db-url-simulator` (P00/P06 variable name), the receiver URL in the simulator's webhook-target variable from `docs/CONFIG.md`. Invoker: **[ASSUMPTION R-08]** P06 adapters do not attach Google ID tokens, so the simulator allows unauthenticated invocations and relies on internal-only ingress for isolation; record in KNOWN_LIMITS (P13-T20).
   - `timeout`: api 30 s; receiver 30 s; workers 3600 s (not request-driven).
   - Graceful shutdown: Cloud Run sends SIGTERM with 10 s grace; workers must stop pulling and finish/nack in-flight messages within that window — the app behavior is from P05/P11; this task sets nothing beyond the default and P13-T13 verifies it.
2. `jobs.tf`: `google_cloud_run_v2_job.migrate` (image `cli`, SA `fl-migrate`, args `["migrate"]` followed by a second job step: Cloud Run jobs run one container command, so use `command = ["sh","-c","node dist/main.js migrate && node dist/main.js db set-role-passwords && node dist/main.js migrate --simulator && node dist/main.js db set-role-passwords --database simulator"]`; `migrate --simulator` is P06-T03's explicit path), env `LEDGER_BUCKET_COUNT = var.ledger_bucket_count` (new variable, default 32), secrets `db-url-migration-owner` as `MIGRATION_DATABASE_URL` (P02 variable), `db-url-simulator-owner` as `PROVIDER_SIMULATOR_DATABASE_URL` (P06-T03, role `fl_simulator`), `role-passwords` (one env var per `ROLE_PASSWORD_*`); `max_retries = 0`, `task_count = 1`. `google_cloud_run_v2_job.verify` (image `cli`, SA `fl-verify`, args `["verify","--json","--require-ground-truth"]`, secrets `db-url-verify` as `DATABASE_URL`, `db-url-simulator-truth` as `SIMULATOR_DATABASE_URL`).
3. `ledger_bucket_count` variable: documented as fixed at database creation; changing it after the first migrate is a rebalancing migration, never a variable change (docs/02 §MVP decisions; CONVENTIONS §8). The contention comparison uses separate databases created by the harness (P13-T17), not this variable.
4. `test/contract/no-migrate-on-startup.test.ts`: assert no file under `apps/*/src` except `apps/cli/src` imports `packages/database/src/migrate` (docs/10 §M13 bullet 4: migration is a deployment step, not a startup side effect).

**Expected behavior** — `terraform plan` shows 10 services and 2 jobs; Σ `maxInstances × poolMax` per instance equals what the budget test approved.

**Acceptance criteria**
- [ ] Instance bounds and pool sizes read from `infra/connection-budget.json` (no literals for those values in `run.tf` except api concurrency 40 and vCPU/memory).
- [ ] API sizing matches docs/09; workers have CPU always allocated.
- [ ] Migration only via the `migrate` job; no app migrates on startup (test).
- [ ] Simulator internal-only; no FlowLedger service receives `db-url-simulator*` or `SIMULATOR_DATABASE_URL`.

**Testing requirements**
- `test/contract/no-migrate-on-startup.test.ts`.
- `test/contract/terraform-static.test.ts` (extend): `run.tf` references `local.budget.processes` for `min_instance_count`, `max_instance_count`, `DATABASE_POOL_MAX`; no FlowLedger service block references `db-url-simulator`.
- Commands: `terraform validate`; `pnpm vitest run --project contracts test/contract`.

**Non-goals** — No custom domain, load balancer, or Cloud Armor (not required by docs/10).

**Handoff checklist**
- [ ] Every env var set in Terraform exists in `docs/CONFIG.md`.

---

### P13-T09 — Monitoring: telemetry export, dashboards, alert policies

**Task ID:** `P13-T09`
**Feature:** Cloud dashboards and contracted alerts
**Commit:** `feat(infra): add otel collector sidecar, cloud dashboards, and alert policies`
**Priority:** High
**Dependencies:** `P13-T08`
**Estimated complexity:** L
**Contract references:** docs/08 §Recovery observability (metric list, bounded labels), §Recovery objectives and alerts (warning/critical thresholds); docs/09 §Required metrics, §Reference benchmark environment (OTel sampling stated; correctness/audit metrics unsampled); docs/10 §M11 T&A bullet 4 (dashboard contents), §M13 bullet 1, §Demo item 8
**Files:** create: `infra/terraform/monitoring.tf`, `infra/terraform/dashboards/*.json`, `infra/otel/collector.yaml`, `test/contract/alerts-parity.test.ts`; modify: `infra/terraform/run.tf` (sidecar container per service); must not touch: metric names in app code
**Executor:** Agent, offline.

**Objective** — Make P11's dashboards and alerts exist in the reference environment, with the same metric names and thresholds, plus Cloud SQL resource charts the benchmark report needs.

**Implementation instructions**
1. Sidecar: each Cloud Run service gets a second container `otel-collector` (image `otel/opentelemetry-collector-contrib:<pinned version>`) with config `infra/otel/collector.yaml` mounted from a Secret Manager secret or baked env: receivers OTLP gRPC on `localhost:4317`; exporters `googlemanagedprometheus` (metrics) and `googlecloud` (traces); processor `batch`. App containers set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317` and the trace sampling ratio from `test/performance/system-config/reference.json` (`telemetrySamplingRatio`); metrics are not sampled.
2. Dashboards (`infra/terraform/dashboards/<name>.json`, `google_monitoring_dashboard` per file): translate each P11 dashboard (API, PostgreSQL, outbox, subscriptions, workers, providers, ledger buckets, refund reservations, settlement, reconciliation) panel-for-panel using PromQL against Managed Prometheus; add Cloud SQL panels (CPU, memory, disk IOPS, disk read/write latency, connections, transaction count, WAL/replication lag) and Pub/Sub panels (`subscription/num_undelivered_messages`, `pubsub.googleapis.com/subscription/oldest_unacked_message_age` (GCP metric, not a FlowLedger one), dead-letter count). A "Demo" dashboard has exactly the docs/10 §Demo item 8 panels: throughput, p95/p99 latency, outbox age, unknown-operation age, per-bucket lock wait, `duplicate_financial_effects_total`.
3. Alerts (`google_monitoring_alert_policy`): one warning and one critical policy for each row of docs/08 §Recovery objectives and alerts that has a metric (REQUESTED claim age 15 s / 60 s; overdue stale PROCESSING any / 60 s; first reconciliation 30 s / 2 min; automated unknown resolution 15 min / 75 min; outbox oldest unpublished 10 s / 60 s; verified webhook processing oldest 30 s / 5 min; settlement oldest unsettled 4 / 12 intervals; negative clearing 4 business hours / 2 business days approximated as 4 h / 48 h with the approximation noted in the policy documentation), plus `duplicate_financial_effects_total > 0` critical. Each policy's `documentation.content` links to the runbook section in docs/08 (e.g. `docs/08-FAILURE_AND_RECOVERY.md#runbook-unknown-operation`). Rows without a metric (manual-review acknowledgement, business days) are listed in `monitoring.tf` comments as "operator process, not an alert".
4. Notification channel: email from `var.alert_notification_email`.
5. `test/contract/alerts-parity.test.ts`: the set of (metric, threshold) pairs in P11's alert definitions equals the set in `monitoring.tf`; every alert has runbook documentation; no label in any PromQL uses `payment_id`, `operation_id`, `merchant_id` (docs/08: IDs never metric labels).

**Expected behavior** — After deploy, the Demo dashboard renders the six panels; injecting a stuck operation fires the REQUESTED-age warning (verified in P13-T13).

**Acceptance criteria**
- [ ] Dashboards and alerts mirror P11 with identical metric names and thresholds.
- [ ] Sampling ratio is configured and recorded; correctness metrics unsampled.
- [ ] Alerts link to runbooks.

**Testing requirements**
- `test/contract/alerts-parity.test.ts`; JSON dashboards validated by `terraform validate`.
- Commands: `pnpm vitest run --project contracts test/contract/alerts-parity.test.ts`; `terraform validate`.

**Non-goals** — No Grafana deployment in GCP.

**Handoff checklist**
- [ ] Collector image version pinned in `docs/VERSIONS.md`.

---

### P13-T10 — Ops VM (load generator) and reference target in the runner

**Task ID:** `P13-T10`
**Feature:** Separate-compute load generation in-region and the release/evidence lane
**Commit:** `feat(infra): add ops vm and reference target for performance runner`
**Priority:** Critical
**Dependencies:** `P13-T08`
**Estimated complexity:** M
**Contract references:** docs/09 §Reference benchmark environment ("Load generator in the same region but on separate compute"), §Load-generation method (preserve raw output, infrastructure revision, dashboards), §Database failover; docs/10 §CI Release/evidence run; P12 harness interfaces
**Files:** create: `infra/terraform/ops.tf`, `infra/ops/startup.sh`, `test/performance/system-config/reference.json`, `.github/workflows/evidence.yml`; modify: `test/performance/run.mjs` (reference target branch), `test/performance/lib/manifest.mjs` (Cloud SQL/Cloud Run config capture); must not touch: profile scripts
**Executor:** Agent, offline (the VM itself is created in P13-T13 by a human).

**Objective** — Run the same harness from a VM in `us-central1`, separate from the system under test, against Cloud Run/Cloud SQL, capturing the reference environment's exact configuration.

**Implementation instructions**
1. `ops.tf` (count = `var.enable_ops_vm ? 1 : 0`): `google_compute_instance` `flowledger-ops`, `e2-standard-16` **[ASSUMPTION R-09]** (sized so the generator is not the bottleneck; the report records CPU of the generator), subnet `flowledger-ops`, no external IP (Cloud NAT egress), SA `fl-ops`, shielded VM, OS Login, startup script `infra/ops/startup.sh` installs pinned Node 24, pnpm 10, k6 (version from `docs/VERSIONS.md`), PostgreSQL 17 client tools, and clones the repository at the commit passed in metadata `flowledger_git_sha`.
2. `run.mjs --target reference`: skips `startSystem` (Cloud Run is the system); reads URLs and DB URLs from Secret Manager via `gcloud secrets versions access` (the VM SA has access per P13-T07): `PERF_API_BASE_URL` (Terraform output), `PERF_SIMULATOR_BASE_URL` (internal simulator URL), `PERF_ADMIN_DATABASE_URL` (`db-url-harness-admin`), verify URLs. Environment label `reference-gcp`. Dataset restore uses `pg_restore` from the VM to the Cloud SQL private IP. Database creation for the contention pair uses `createDatabases` via the admin URL (as `fl_migration_owner`, which has `CREATEDB` via `cloudsqlsuperuser`) and runs migrations from the VM.
3. Manifest additions for reference runs: `infrastructureRevision` (`PERF_INFRA_REVISION` = git SHA of `infra/terraform` + Terraform state serial, passed by the operator), Cloud SQL settings (`gcloud sql instances describe --format=json` saved as `cloudsql-instance.json` with IPs removed), Cloud Run service configs (`gcloud run services describe <svc> --format=json` per service, saved with env secret references only — values never resolved), deployed image digests, `system-config/reference.json`.
4. Raw bundle: after each reference run, `tar czf` of `artifacts/perf/<runId>` uploaded to `gs://<project>-flowledger-evidence/runs/<runId>.tar.gz`; its SHA-256 and `gs://` URI are written into the committed `manifest.json`. Dashboard evidence: export the Demo and PostgreSQL dashboards' time series for the run window via the Monitoring API (`projects.timeSeries.list`) into `cloud-metrics.json` (committed if < 2 MB, else uploaded with hash).
5. `test/performance/system-config/reference.json`: worker concurrency, relay claim size/lease, provider concurrency per account, telemetry sampling ratio — the reference equivalents of the local file.
6. `.github/workflows/evidence.yml`: `workflow_dispatch` only; documents the release/evidence lane steps (three trials per headline workload, soak + chaos, verify, restore rehearsal when infra changed) as a checklist job that SSHes nowhere — it validates that the evidence directories for a given commit exist and pass `test/contract/evidence-consistency.test.ts`. (Cloud execution is manual from the ops VM; CI holds no GCP credentials in a public repo.)

**Expected behavior** — On the ops VM, `node test/performance/run.mjs uniform-acceptance --target reference --dataset <dir>` produces an evidence directory labeled `reference-gcp` with Cloud SQL/Run configs and a `gs://` raw bundle reference.

**Acceptance criteria**
- [ ] Load generator on separate compute in the same region.
- [ ] Reference manifests contain infra revision, Cloud SQL and Cloud Run configs, image digests; no secret values.
- [ ] Raw bundles stored in the evidence bucket with hashes in committed manifests.

**Testing requirements**
- `test/contract/performance/manifest.test.ts` (extend): reference manifest redacts IPs and never includes secret values (fixture `gcloud` JSON containing a secret env value → output contains only the secret reference); `environment` is `reference-gcp` only with `--target reference`.
- Commands: `pnpm vitest run --project contracts test/contract/performance/manifest.test.ts`; `terraform validate`.

**Non-goals** — No CI-driven cloud runs.

**Handoff checklist**
- [ ] VM has no external IP; access via IAP only.

---

### P13-T11 — Bootstrap/deploy script, IAM isolation verifier, setup documentation

**Task ID:** `P13-T11`
**Feature:** New environment from Terraform plus documented bootstrap, no manual mutation
**Commit:** `feat(infra): add deploy bootstrap script, iam isolation verifier, and DEPLOY.md`
**Priority:** Critical
**Dependencies:** `P13-T05`, `P13-T06`, `P13-T07`, `P13-T08`, `P13-T09`, `P13-T10`
**Estimated complexity:** M
**Contract references:** docs/10 §M13 bullet 4 (explicit migration step), T&A bullets 1–2; P12-R-05 (harness admin grants)
**Files:** create: `infra/deploy/deploy.sh`, `infra/deploy/verify-iam.sh`, `infra/deploy/grant-harness-admin.sql`, `docs/DEPLOY.md`, `test/contract/deploy-script.test.ts`; must not touch: Terraform resources (only invoke them)
**Executor:** Agent, offline (scripts are executed by a human in P13-T13).

**Objective** — One ordered, rerunnable script takes an empty GCP project to a running environment; a second script proves the IAM isolation claims from inside the project.

**Implementation instructions**
1. `infra/deploy/deploy.sh <project_id> <image_tag>` (bash, `set -euo pipefail`), steps in order, each idempotent and logging a step banner: (1) create the Terraform state bucket if absent (`gcloud storage buckets create`, versioning on); (2) `terraform init -backend-config=bucket=… -backend-config=prefix=reference`; (3) `terraform apply -target` for project services, network, registry (APIs must exist before other resources); (4) build and push all 11 images with `docker buildx build --platform linux/amd64 --push`, record digests to `artifacts/deploy/<timestamp>/images.json`; (5) full `terraform apply -var image_tag=<tag>` — services are created with `min_instance_count` from the budget but their readiness depends on the schema, so (6) execute the `migrate` job (`gcloud run jobs execute flowledger-migrate --wait`) — migration runs strictly before services are expected healthy; (7) from the ops VM, execute `grant-harness-admin.sql` as `fl_migration_owner` (table owner): `GRANT USAGE ON SCHEMA ledger TO postgres; GRANT SELECT ON ledger.accounts, ledger.account_balances TO postgres;` — the harness admin (`postgres` built-in user, `PERF_ADMIN_DATABASE_URL`) needs these for the lock sampler's ctid join; then, as `postgres`, check `SELECT count(*) FROM pg_locks` and full `pg_stat_activity` visibility (Cloud SQL's `cloudsqlsuperuser` membership) and record the result in `artifacts/deploy/<timestamp>/harness-admin-check.json`; (8) wait for every service's latest revision to be `Ready`; (9) `gcloud run jobs execute flowledger-verify --wait` must succeed; (10) print the API URL and the evidence bucket.
2. Re-running `deploy.sh` with a new tag performs: push → migrate job → `terraform apply` (new revisions) → verify job. Migration always precedes the revision rollout.
3. `infra/deploy/verify-iam.sh <project_id>`: for each SA, impersonate (`--impersonate-service-account`) and attempt `gcloud secrets versions access latest --secret=<s>` for every secret; expected allow/deny matrix is read from the same table used in `test/contract/iam-matrix.test.ts` (export it to `infra/deploy/iam-matrix.json` in this task and have the test import it); attempt `gcloud pubsub topics publish` for non-relay SAs (expect denied) and `gcloud pubsub subscriptions pull` on another consumer's subscription (expect denied). Writes `artifacts/deploy/<timestamp>/iam-verification.json`; exits non-zero on any mismatch. DB isolation: from the ops VM, attempt to connect to the simulator instance with each FlowLedger role's credentials (expect auth failure) and to run `SELECT 1 FROM ledger.journal_entries` with roles lacking privilege (expect `42501`).
4. `docs/DEPLOY.md`: prerequisites (gcloud, Terraform 1.9+, Docker buildx, a GCP project with billing, roles needed by the human operator: Owner or the listed set), the two commands, expected durations, cost warning and `terraform destroy` teardown (with `deletion_protection=false` first), and a clear note that nothing here is needed for local development or the demo.

**Expected behavior** — A human runs `deploy.sh` on an empty project and gets a healthy environment with no console clicks.

**Acceptance criteria**
- [ ] Ordered steps with migration before rollout; idempotent rerun.
- [ ] IAM verifier reads the same matrix the static test uses.
- [ ] DEPLOY.md documents prerequisites, run, verify, teardown.

**Testing requirements**
- `test/contract/deploy-script.test.ts`: `deploy.sh` passes `bash -n`; step order (migrate job execution line appears before the final revision readiness wait, and before verify); `shellcheck` if available in CI (P11 tooling), else skip with a note; `iam-matrix.json` is the import source of `iam-matrix.test.ts`.
- Commands: `pnpm vitest run --project contracts test/contract/deploy-script.test.ts`.

**Non-goals** — No execution against GCP.

**Handoff checklist**
- [ ] Scripts never print secret values (`set -x` not used).

---

### P13-T12 — Drill tooling: restore rehearsal and planned failover

**Task ID:** `P13-T12`
**Feature:** Scripted, measured recovery drills
**Commit:** `feat(infra): add restore-rehearsal and failover-drill scripts with probes`
**Priority:** Critical
**Dependencies:** `P13-T10`, `P13-T11`
**Estimated complexity:** L
**Contract references:** docs/08 §Disaster recovery (steps 1–6), §MVP recovery decisions; docs/09 §Database failover (all bullets); docs/10 §M13 bullets 5–6, T&A bullets 4–5; docs/01 §MVP deployment decisions (restore does not immediately re-enable provider writes)
**Files:** create: `infra/drills/restore-rehearsal.sh`, `infra/drills/failover-drill.sh`, `test/performance/lib/failover-probe.mjs`, `test/performance/lib/drill-report.mjs`, `test/contract/performance/drill-report.test.ts`; must not touch: P08 recovery commands
**Executor:** Agent, offline (executed by a human in P13-T14/T15).

**Objective** — Turn both drills into commands that capture every docs/09 §Database failover and docs/08 §Disaster recovery measurement into files, so the human only runs them.

**Implementation instructions**
1. `failover-probe.mjs`: one connection via `PERF_ADMIN_DATABASE_URL`, `SELECT now()` every 100 ms with a 1 s statement timeout; on error, reconnect with 100 ms backoff; writes NDJSON `{ clientTs, ok, dbNow?, sqlstate? }`. Summary: last successful query before the first failure, first success after, disconnect interval, error SQLSTATEs.
2. `failover-drill.sh` (on the ops VM): (a) start `run.mjs uniform-acceptance --target reference --rate <documented steady rate = 50% of the reference demonstrated max> --warmup 5m --measure 20m --trial failover` with an extra k6 tag `op_id` recorded for every `202` response (acknowledged commits); (b) start the probe; (c) at measured minute 5, record `gcloud sql operations` start and run `gcloud sql instances failover flowledger-pg --quiet`; (d) wait for the operation to finish; (e) after the run, `drill-report.mjs failover` computes: last successful commit before the gap (`max(created_at)` of operations with `created_at` < first probe failure), client disconnect/reconnect interval (probe), per-service pool wait and reconnect (Cloud Monitoring `db_pool_wait` series exported for the window; app log SQLSTATE counts `57P01`, `08006`, `08003` from Cloud Logging export), retry classifications (`db_transaction_retries_total` by sqlstate), accepted/completed rate timeseries around the failover, outbox oldest unpublished age series, worker lease recovery (count of `PROCESSING` operations with expired leases over time and their resolution), and **acknowledged commits present**: every `op_id` tagged in k6 output exists in `payments.payment_operations` (missing count must be 0). Post-drill: `flowledger verify --require-ground-truth` (all classes zero) and the measured recovery compared with RTO ≤ 60 min and RPO ≤ 5 min (failover RPO = acknowledged-but-missing commits, expected 0 with synchronous standby). Output `docs/evidence/drills/failover-<date>/` (`probe-summary.json`, `drill-summary.json`, `verify-after.json`, the run's evidence ID).
3. `restore-rehearsal.sh` (on the ops VM; never touches the primary): (a) with steady load running (rate as above), record `T_incident = now()` from the DB; (b) `gcloud sql instances clone flowledger-pg flowledger-pg-restore-<date> --point-in-time <T_incident>` (PITR clone into a new instance); (c) on the clone, following docs/08 §Disaster recovery in order: step 1 `flowledger dr fence --actor drill --reason restore-rehearsal` (new recovery epoch; provider dispatch and notification application off); step 2 start `provider-webhook-receiver` on the VM against the clone (receipt continues; application stays fenced per P08); step 3 run `flowledger migrate --check` (schema version) and `flowledger verify --require-ground-truth` (journal balance, projection rebuild, idempotency uniqueness, outbox/inbox integrity); step 4 `flowledger dr reconcile-window --since <T_incident − 5 min> --actor drill --reason restore-rehearsal --json` with the reconciler running on the VM against the clone and the **live** simulator (provider state did not roll back); step 5 start `outbox-relay` on the VM against the clone so committed unpublished envelopes republish with their original UUIDs, and record the unpublished count reaching zero; step 6 `flowledger dr unfence --epoch <n> --actor drill --reason restore-rehearsal` (P08 refuses unless reconcile-window was clean and verify is zero) — only then is provider dispatch re-enabled. (d) Measurements: RPO = `T_incident − max(recorded_at)` over `messaging.outbox_messages` in the clone (the latest committed fact restored); RTO = time from `T_incident` to unfence; plus count of operations reconciled, count of operations that changed state through reconciliation, verify output. (e) Output `docs/evidence/drills/restore-<date>/` (`timeline.json` with every step's start/end DB timestamps, `verify-*.json`, `rehearsal-summary.json` with `rpoSeconds`, `rtoSeconds`, `rpoMet`, `rtoMet`). (f) Delete the clone at the end unless `--keep`.
4. `drill-report.mjs` renders each summary into Markdown with source references, following the evidence honesty rule; a miss is written as "missed: measured X vs target Y" from the summary values.

**Expected behavior** — Both scripts produce evidence directories whose summary values are all computed from captured files.

**Acceptance criteria**
- [ ] Failover drill captures all seven docs/09 §Database failover record items and the acknowledged-commit check.
- [ ] Restore rehearsal executes docs/08 DR steps 1–6 in order with provider writes fenced, on a clone, and measures RPO/RTO.
- [ ] Reports are generated from summaries; misses reported as misses.

**Testing requirements**
- `test/contract/performance/drill-report.test.ts`: probe summary on a synthetic NDJSON with a 23 s gap → disconnect 23 s; acknowledged-commit check with one missing `op_id` → `missing: 1` and `rpoMet: false`; rehearsal summary with RTO 3,700 s → `rtoMet: false` and the Markdown says "missed".
- `bash -n` on both scripts in `test/contract/deploy-script.test.ts` (extend).
- Commands: `pnpm vitest run --project contracts test/contract/performance/drill-report.test.ts`.

**Non-goals** — No cross-region DR (out of MVP).

**Handoff checklist**
- [ ] Scripts refuse to run if the target instance name equals the primary for any destructive step.

---

### P13-T13 — HUMAN: provision the reference environment and verify deployment behavior

**Task ID:** `P13-T13`
**Feature:** Reproducible HA deployment
**Commit:** `docs(evidence): record reference environment provisioning and deployment verification`
**Priority:** Critical
**Dependencies:** `P13-T11`, `P13-T12`
**Estimated complexity:** M (plus cloud wait time)
**Contract references:** docs/10 §M13 bullets 1–4, T&A bullets 1–3, 5 (HA enabled — Terraform and runtime inspection); docs/09 §Reference benchmark environment
**Files:** create: `docs/evidence/P13-deploy.md`, `docs/evidence/deploy/<date>/**` (captured outputs); must not touch: code
**Executor:** **HUMAN with a GCP project + billing (blocked on human input).** An agent cannot complete this task.

**Objective** — Prove a new environment comes up from Terraform and the documented bootstrap alone, that isolation holds at runtime, that HA is on, and that scaling, shutdown, ack deadlines, and connection limits behave.

**Implementation instructions**
1. In a fresh project: run `infra/deploy/deploy.sh <project> <tag>` exactly as documented. Capture `terraform plan`/`apply` output (redact nothing secret is printed; verify) to `docs/evidence/deploy/<date>/terraform-apply.txt`. Record any manual step needed; if one is needed, the task fails and the script is fixed in a follow-up commit before re-running.
2. `infra/deploy/verify-iam.sh` → `iam-verification.json` (all expected allows/denies).
3. HA proof: `gcloud sql instances describe flowledger-pg --format=json` → `availabilityType: REGIONAL`, `backupConfiguration.pointInTimeRecoveryEnabled: true`, failover replica zone present; save redacted JSON.
4. Scale test from the ops VM: run `uniform-acceptance --target reference` as a ramp (`--rate` stepping until API instances reach `maxInstances`), then drop to 10% for 10 minutes. Record: max `pg_stat_activity` count (must be ≤ `maxConnections − reserved`), any `53300` errors (must be 0), 5xx during scale-in, final verify zero findings, Pub/Sub `pubsub.googleapis.com/subscription/oldest_unacked_message_age` (GCP metric, not a FlowLedger one) during worker scale-in, redeliveries vs inbox duplicates (no effect without commit).
5. Graceful shutdown: deploy a no-op revision of each worker during load (`gcloud run services update --update-labels=drill=<n>`); confirm no message is acknowledged without commit (verify zero, duplicate-effect zero) and in-flight provider work follows the stale-lease path.
6. Alert test: stop the `outbox-relay` service (`min/max = 0`) for 2 minutes under load → outbox-age warning and critical alerts fire and link to the runbook; restore.
7. Write `docs/evidence/P13-deploy.md` with every claim followed by its captured file path.

**Expected behavior** — Environment healthy; all checks recorded with files.

**Acceptance criteria**
- [ ] No manual resource mutation was required (statement backed by the captured apply log).
- [ ] IAM matrix verified at runtime.
- [ ] HA confirmed by inspection; connection max stayed within budget during scale-up/down.
- [ ] Alerts fired in a controlled fault and linked to runbooks.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` passes over `docs/evidence/deploy/**` (files referenced exist).
- Commands: `pnpm vitest run --project contracts test/contract/evidence-consistency.test.ts`.

**Non-goals** — No benchmark claims.

**Handoff checklist**
- [ ] Measured values come only from captured files; nothing estimated.
- [ ] No secret, IP, or credential in committed files.

---

### P13-T14 — HUMAN: backup/PITR restore rehearsal with provider writes fenced

**Task ID:** `P13-T14`
**Feature:** Restore rehearsal against RPO ≤ 5 min / RTO ≤ 60 min
**Commit:** `docs(evidence): record PITR restore rehearsal with fenced provider writes`
**Priority:** Critical
**Dependencies:** `P13-T13`
**Estimated complexity:** M
**Contract references:** docs/08 §Disaster recovery; docs/10 §M13 bullet 5, T&A bullet 4; docs/09 §Database failover last bullet (rehearsal does not substitute for HA failover evidence)
**Files:** create: `docs/evidence/drills/restore-<date>/**`, `docs/evidence/P13-restore.md`; must not touch: code
**Executor:** **HUMAN with a GCP project + billing (blocked on human input).**

**Objective** — Execute the rehearsal once and publish the measured RPO/RTO, met or missed.

**Implementation instructions**
1. Prepare the reference dataset (P13-T16 step 1 can be reused) and start steady load.
2. Run `infra/drills/restore-rehearsal.sh` with the documented parameters; do not intervene manually between steps except where the script prompts; record any manual intervention in the evidence.
3. Generate `docs/evidence/P13-restore.md` with `drill-report.mjs restore`. If RPO or RTO is missed, the document states the measured value and the identified cause (e.g. clone provisioning time).

**Expected behavior** — Summary shows provider writes stayed fenced until reconciliation coverage completed, verify zero findings on the clone, RPO/RTO measured.

**Acceptance criteria**
- [ ] DR steps 1–6 executed in order with timestamps.
- [ ] RPO/RTO measured; misses documented, not hidden.
- [ ] Verify zero findings before unfence.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` over the new files.

**Non-goals** — Not a substitute for P13-T15.

**Handoff checklist**
- [ ] Measured values come only from drill output files; targets stay labeled as targets.
- [ ] Clone deleted after the rehearsal (or retention justified).

---

### P13-T15 — HUMAN: planned Cloud SQL failover drill under load

**Task ID:** `P13-T15`
**Feature:** HA failover evidence
**Commit:** `docs(evidence): record planned cloud sql failover drill under load`
**Priority:** Critical
**Dependencies:** `P13-T13`, `P13-T16` (needs the demonstrated maximum to set the steady rate; if T16 has not run, use the P12 local median and label the rate as such)
**Estimated complexity:** M
**Contract references:** docs/09 §Database failover; docs/10 §M13 bullet 6, T&A bullet 5
**Files:** create: `docs/evidence/drills/failover-<date>/**`, `docs/evidence/P13-failover.md`; must not touch: code
**Executor:** **HUMAN with a GCP project + billing (blocked on human input).**

**Objective** — One planned failover while acceptance, relay, and workers are active; publish recovery measurements and exact post-failover audits.

**Implementation instructions**
1. Run `infra/drills/failover-drill.sh` at the documented steady rate.
2. Generate `docs/evidence/P13-failover.md` with `drill-report.mjs failover`: last successful commit, disconnect/reconnect interval, pool wait, retry classifications, accepted/completed rates, outbox age, worker lease recovery, acknowledged commits missing (must be 0), post-failover verify per class, RTO/RPO comparison (met or published as a miss).

**Expected behavior** — Acknowledged commits all present; verify zero; ambiguous in-flight provider work resolved through reconciliation.

**Acceptance criteria**
- [ ] All docs/09 §Database failover record items present with file references.
- [ ] Zero acknowledged commits missing; zero duplicate financial effects; verify zero in every class.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` over the new files.

**Non-goals** — No repeated failovers to find a better number.

**Handoff checklist**
- [ ] Measured values come only from drill output files; targets stay labeled as targets.

---

### P13-T16 — HUMAN: reference benchmark matrix, soak, and chaos

**Task ID:** `P13-T16`
**Feature:** Reference-environment trials
**Commit:** `docs(evidence): record reference benchmark trials, soak, and chaos runs`
**Priority:** Critical
**Dependencies:** `P13-T13`
**Estimated complexity:** L (≈ 1–2 days of cloud time)
**Contract references:** docs/09 §Reference benchmark environment, §Workload profiles, §Load-generation method, §Stop conditions; docs/10 §M13 bullets 7–8, T&A bullets 6, 8; §CI Release/evidence run
**Files:** create: `docs/evidence/runs/<runId>/**` (reference runs); must not touch: code, README
**Executor:** **HUMAN with a GCP project + billing (blocked on human input).**

**Objective** — Run the full workload matrix in the contracted environment only after Cloud Run, Cloud SQL, Pub/Sub, telemetry, autoscaling bounds, and the connection budget are deployed and verified (P13-T13 evidence exists).

**Implementation instructions**
1. On the ops VM at one commit and one infra revision: `prepare --target reference --for uniform-acceptance,confirmed-processing,settlement-live,…` with ≥ 1,000,000 payments and 10,000 merchants (docs/09 §Uniform acceptance).
2. Headline workloads, three trials each, restored from the same dump per trial: `uniform-acceptance` (1,000/s; acceptance + messaging targets), `confirmed-processing --mode step`, `settlement-live`.
3. Once each: `duplicate-storm`, `hot-merchant`, `hot-payment`, `refund-fanout`, `provider-degradation`, `crash-redelivery` (release lane chaos).
4. `soak --from-runs <three reference uniform runIds>` for 60 minutes.
5. Do not rerun a trial to improve a number; every started trial is kept (FAILED ones included). If a stop condition fires, keep the evidence, fix the cause in a separate commit, and start a new full set of three at the new commit.

**Expected behavior** — Evidence directories labeled `reference-gcp`, each with raw bundle URIs, verify per class, and dashboards exported.

**Acceptance criteria**
- [ ] 3 trials per headline workload + 60-min soak + each other profile once, same commit/infra revision.
- [ ] Every run: verify per-class output, dropped work recorded (headline runs must show 0 for a valid result).
- [ ] Raw bundles in the evidence bucket with hashes in manifests.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` over the new run directories.

**Non-goals** — No report writing (P13-T18).

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; targets stay labeled as targets.
- [ ] Every started trial is committed.

---

### P13-T17 — HUMAN: ledger contention comparison in the reference environment

**Task ID:** `P13-T17`
**Feature:** Primary measured result (N=1 vs N=32) in the contracted environment
**Commit:** `docs(evidence): record reference ledger contention comparison`
**Priority:** Critical
**Dependencies:** `P13-T13`
**Estimated complexity:** M
**Contract references:** docs/09 §Ledger contention (all rules), §Reporting template item 9; docs/10 §M13 bullet 9, T&A bullet 7; ADR-0010; CONVENTIONS §8
**Files:** create: `docs/evidence/runs/<contentionRunId>/**`; must not touch: code
**Executor:** **HUMAN with a GCP project + billing (blocked on human input).**

**Objective** — Run `pnpm test:performance contention --target reference --mode step --trials 3` against two databases created on the reference Cloud SQL instance from the same commit (`flowledger_b1`, `flowledger_b32`, plus matching simulator databases on the simulator instance), with the Cloud Run services pointed at each in turn.

**Implementation instructions**
1. Because deployed services read `DATABASE_URL` from Secret Manager, switching databases means: add a new secret version for each `db-url-<process>` pointing at `flowledger_b1` and `flowledger_sim_b1` (same roles, same instances), redeploy revisions (`terraform apply -var image_tag=<same tag> -var database_name=flowledger_b1 -var simulator_database_name=flowledger_sim_b1`, the variable added by P13-T07; risk R-10), run the b1 trial, switch to `flowledger_b32`, run the b32 trial, alternate three times. Record each switch's revision IDs in the manifests; the manifest-equality check must pass except the allowed fields.
2. Publish `contention-summary.json` as produced; if the ratio shows no material improvement, publish as-is with the computed limiting factor.

**Expected behavior** — Six trials and one contention summary with per-logical-account lock-wait distributions for both bucket counts and the next bottleneck.

**Acceptance criteria**
- [ ] Same commit, same infra revision, same service config; bucket count the only variable (manifest check passed).
- [ ] Lock-wait per logical account for both runs; per-bucket for N=32; ratio and next bottleneck computed.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` over the new files.

**Non-goals** — No change to the production database's bucket count.

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; a negative result is published as-is.

---
### P13-T18 — Benchmark report (reference)

**Task ID:** `P13-T18`
**Feature:** Published benchmark report per docs/09 template
**Commit:** `docs(perf): publish reference benchmark report from evidence`
**Priority:** Critical
**Dependencies:** `P13-T16`, `P13-T17` (blocked until their evidence exists), `P13-T14`, `P13-T15`
**Estimated complexity:** M
**Contract references:** docs/09 §Reporting template (1–11 + closing paragraphs), §Performance claims and boundaries (separate boundaries), §Reference benchmark environment; docs/10 §M13 bullet 10, T&A bullets 6–8; README §Status and §Targets
**Files:** create: `docs/BENCHMARK_REPORT.md`; modify: none; must not touch: evidence files
**Executor:** Agent, **blocked on human-produced artifacts** from P13-T14..T17.

**Objective** — Generate the reference report from evidence and add only a narrative that restates generated values.

**Implementation instructions**
1. `node test/performance/report.mjs --out docs/BENCHMARK_REPORT.md <all reference runIds> <contentionRunId>`; then append generated sections for the failover and restore drills from their `drill-report.mjs` outputs.
2. Add a hand-written top section (≤ 40 lines): what was measured, the environment, where each boundary starts/stops, the contention ratio and next bottleneck, and which targets were met or missed — every number in it must also appear in the generated body with a source reference, and the narrative cites that reference. Local preflight numbers (P12) appear only in a separate "Local preflight (not reference)" subsection.
3. Include "Coverage bounded or dropped" and "Deviations" exactly as generated, plus any human-recorded deviations from P13-T13..T17 evidence notes.
4. If P13-T16/T17 evidence does not exist, this task is BLOCKED — do not produce a report with placeholders presented as results.

**Expected behavior** — A report whose every measured value links to `docs/evidence/runs/...` or `docs/evidence/drills/...`.

**Acceptance criteria**
- [ ] Generated by `report.mjs`; narrative numbers all present in the generated body.
- [ ] Targets labeled as targets; unmet targets stated as missed with bottleneck.
- [ ] Contention result shown with both runs' lock-wait distributions and next bottleneck, negative or positive.

**Testing requirements**
- `test/contract/evidence-consistency.test.ts` (extend): every number in `docs/BENCHMARK_REPORT.md` followed by a source reference matches the referenced JSON value; the report contains no sentence matching `/achieved|measured at/i` adjacent to a target whose `met` is false.
- Commands: `pnpm vitest run --project contracts test/contract/evidence-consistency.test.ts`.

**Non-goals** — No README résumé edits (P13-T22).

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; targets stay labeled as targets.

---

### P13-T19 — Architecture diagrams

**Task ID:** `P13-T19`
**Feature:** Diagrams explaining the system and deployment
**Commit:** `docs(arch): add architecture and deployment diagrams`
**Priority:** Medium
**Dependencies:** `P13-T08`
**Estimated complexity:** S
**Contract references:** docs/01 §System context, §Deployable processes, §Linearization points, §Happy-path capture, §Ambiguous timeout and reconciliation; docs/07 §Transaction and lock ownership (canonical lock order); ADR-0010; docs/10 §M13 bullet 10
**Files:** create: `docs/ARCHITECTURE_DIAGRAMS.md`; must not touch: contract docs
**Executor:** Agent, offline.

**Objective** — Mermaid diagrams (rendered by GitHub, no image files) that a reviewer can check against the code and Terraform.

**Implementation instructions**
1. Diagrams, each with a one-paragraph caption citing the contract section it depicts: (1) process topology (10 processes incl. simulator, Pub/Sub topics/subscriptions/DLQs by name from `generated/topology.json`, both databases); (2) GCP deployment (Cloud Run services/jobs, VPC, two Cloud SQL instances, Secret Manager, ops VM, evidence bucket) — names copied from Terraform resource names; (3) sequence: capture command acceptance → outbox → worker → simulator → terminal transaction with ledger posting (docs/01 §Happy-path capture); (4) sequence: provider timeout → `UNKNOWN` → reconciliation lookup → resolution (docs/01 §Ambiguous timeout); (5) lock order chains for financial resolution and settlement (docs/07 §Transaction and lock ownership); (6) striped bucket selection `bucketIndex = crockford_ulid_entropy(paymentId) mod N` (ADR-0010).
2. No numbers (performance or otherwise) in diagrams.

**Expected behavior** — Diagrams render on GitHub; names match code and Terraform.

**Acceptance criteria**
- [ ] Six diagrams with captions and contract citations.
- [ ] Every process, topic, and resource name appears in code/Terraform.

**Testing requirements**
- `test/contract/diagram-names.test.ts`: every identifier in a Mermaid node label that matches `flowledger-[a-z-]+` or an app name exists in `generated/topology.json`, `apps/`, or a Terraform resource name.
- Commands: `pnpm vitest run --project contracts test/contract/diagram-names.test.ts`.

**Non-goals** — No image exports.

**Handoff checklist**
- [ ] Diagrams contain no performance claims.

---

### P13-T20 — KNOWN_LIMITS linkage

**Task ID:** `P13-T20`
**Feature:** Known limits tied to evidence and contracts
**Commit:** `docs(limits): link known limits to deployment and benchmark evidence`
**Priority:** High
**Dependencies:** `P13-T08`, `P13-T10`
**Estimated complexity:** S
**Contract references:** docs/10 §M11 Deliberately deferred, §M13 bullet 10, §Demo and portfolio acceptance (known-limits bullet), §Explicit non-goals; docs/09 §Defining duplicate_financial_effects_total last paragraph; README §Deliberate limits
**Files:** modify: `docs/KNOWN_LIMITS.md` (created in P11); must not touch: contract docs
**Executor:** Agent, offline (benchmark-dependent entries refreshed after P13-T18 by a second commit with the same task ID if needed).

**Objective** — Extend the P11 known-limits document with every limit introduced or confirmed by P12/P13, each mapped to its contract section and evidence.

**Implementation instructions**
1. Add entries (each: limit, why, contract section, evidence or test link): retention archive / raw-quarantine buckets not provisioned (docs/10 §M13 bullet 1 vs §M11 deferred items — see risk R-06); simulator invoked without Google ID tokens, isolated by internal ingress (R-08); duplicate-effect detector valid only against simulated providers (docs/09); lock-wait evidence is sampled at 50 ms with stated unattributed share (P12-T09); k6 latency boundary is client-observed (P12-T12); single region; merchant clearing rows unstriped (ADR-0010; link hot-merchant evidence); the CI holds no GCP credentials, so reference runs are manual from the ops VM; local preflight is not the reference result; any target missed in `docs/BENCHMARK_REPORT.md` (linked, not restated).
2. Every entry links to the file or test that demonstrates it.

**Expected behavior** — A reviewer maps each limit to a contract section and an artifact.

**Acceptance criteria**
- [ ] All listed entries present with contract and evidence links.
- [ ] No limit is phrased as a future promise.

**Testing requirements**
- `test/contract/known-limits-links.test.ts`: every relative link in `docs/KNOWN_LIMITS.md` resolves to an existing file/anchor.
- Commands: `pnpm vitest run --project contracts test/contract/known-limits-links.test.ts`.

**Non-goals** — No new features to remove limits.

**Handoff checklist**
- [ ] Benchmark-related entries link to the report, not to numbers typed here.

---

### P13-T21 — Offline demo script and concise setup instructions

**Task ID:** `P13-T21`
**Feature:** Deterministic offline demo from a clean clone
**Commit:** `feat(demo): add offline deterministic demo script and quickstart`
**Priority:** Critical
**Dependencies:** `P12-GATE`
**Estimated complexity:** L
**Contract references:** docs/10 §M13 bullet 11 ("idempotent capture repeated, timeout converging through reconciliation to exactly one posting, concurrent refunds bounded by the reservation guard, settlement batch closing over the result; runs offline from a clean clone"), §Demo and portfolio acceptance items 1–9 and the offline paragraph, T&A last bullet; ADR-0011; docs/05 §timeline endpoint (`GET /v1/payments/{paymentId}/timeline`)
**Files:** create: `scripts/demo.mjs`, `test/e2e/demo.test.ts`; modify: `package.json` (script `demo`), `README.md` (add a "Run it locally" section only — do not touch the Targets table or Status here); must not touch: app source
**Executor:** Agent, offline.

**Objective** — `pnpm demo` walks through the docs/10 demo, printing real system output, with no credentials and no cloud account.

**Implementation instructions**
1. `scripts/demo.mjs` uses `test/performance/lib/system.mjs` (`createDatabases`, `startSystem`) and `flowledger seed --profile dev`; sets the simulator via `PUT /__test/profile` and `POST /__test/clock` for determinism (fixed seed `demo-1`). Steps, each printing a numbered heading and the raw HTTP responses (status + redacted JSON):
   1. Provider timeout after commit (simulator fault `timeoutAfterCommit` for the next capture's key) → operation `UNKNOWN`; `GET /v1/payments/{id}/timeline` shown before; advance the simulator clock / wait for reconciliation; timeline after shows the ambiguous attempt, reconciliation evidence, exactly one ledger posting.
   2. Idempotent capture/payment request sent 5 times with the same `Idempotency-Key` → one operation ID; SQL count of journal transactions for it = 1 (query via operator read view / CLI).
   3. Concurrent refunds racing the last refundable amount (e.g. 3 refunds of 40% on a captured payment) → two `202`, one `409 MONETARY_GUARD_FAILED`; after confirmation, Σ fee reversals = captured fee when fully refunded (use amounts that fully refund: 50% + 50% + 1 minor unit).
   4. `flowledger verify --require-ground-truth` output printed verbatim (zero findings per class, including the cross-system duplicate-effect detector).
   5. Duplicate and out-of-order provider webhooks (simulator duplicates/delays enabled for one payment) converging with no duplicate effect (verify again).
   6. Settlement: run the settlement worker cycle; batch posted over confirmed movements; then a late refund confirms; next run defers or lands in the next batch; closed batch unchanged (print batch rows before/after).
   7. Ledger contention comparison: short local `contention --smoke --trials 1` printing both lock-wait summaries side by side — labeled "smoke, local, illustrative only; see docs/BENCHMARK_REPORT.md for measured results".
   8. Dashboard: print the URL of the local observability stack from P11 (if P11 ships one) and a metrics snapshot (`duplicate_financial_effects_total`, outbox age, unknown-operation age, per-bucket lock wait); offline only.
   9. Benchmark report: print the path to `docs/BENCHMARK_REPORT.md` if it exists, else to `docs/evidence/P12-preflight.md`, with its environment label.
2. Every step asserts its expected outcome and exits non-zero with the step name if it fails (the demo is also a test).
3. README "Run it locally": prerequisites (Node 24, pnpm 10, Docker, k6 for step 7), `pnpm install --frozen-lockfile && pnpm build && pnpm db:up && pnpm demo`, expected duration, "no credentials, no cloud account".
4. `test/e2e/demo.test.ts`: runs `scripts/demo.mjs --skip-contention` (step 7 needs k6) and asserts exit 0; added to the nightly lane by being in the e2e project.

**Expected behavior** — From a clean clone with Docker, `pnpm demo` finishes all steps with exit 0 and prints the timeline before/after the ambiguous capture.

**Acceptance criteria**
- [ ] All four docs/10 §M13 demo behaviors and the nine §Demo items are shown, offline.
- [ ] Deterministic: two consecutive runs print identical step outcomes (IDs differ; statuses and counts identical).
- [ ] No credentials or cloud account required; all secrets from `.env.example`.

**Testing requirements**
- `test/e2e/demo.test.ts` (exit 0; each step's assertion present); determinism check: run twice in the test and compare the step-outcome summary JSON the script prints at the end.
- Commands: `pnpm build && pnpm vitest run --project e2e test/e2e/demo.test.ts`.

**Non-goals** — No video recording (the human may record one; not required to pass).

**Handoff checklist**
- [ ] Output passes through the redaction allowlist (no credential printed — test greps output for `fl_test_` secrets and `prohibited-data.ts` fixtures).

---

### P13-T22 — Evidence index and README targets linkage

**Task ID:** `P13-T22`
**Feature:** Every claim linked to a raw result, test, dashboard, or command
**Commit:** `docs(evidence): add evidence index and link README claims`
**Priority:** Critical
**Dependencies:** `P13-T21`, `P13-T20`, `P13-T19`; final values depend on `P13-T18`
**Estimated complexity:** M
**Contract references:** docs/10 §M13 T&A bullet 9 ("final evidence index links every résumé claim…"), §Demo and portfolio acceptance (Portfolio-complete bullets), §Quality gates mapping in docs/09; README §Status, §Targets ("Every number below is a target… until a benchmark produces that evidence")
**Files:** create: `docs/EVIDENCE_INDEX.md`, `test/contract/evidence-index.test.ts`; modify: `README.md` (Status and Targets sections only); must not touch: contract docs
**Executor:** Agent, offline; values that depend on reference results are filled only from `docs/BENCHMARK_REPORT.md` evidence (if P13-T18 has not run, those rows say "not yet measured").

**Objective** — One page a reviewer uses to verify any claim, and a README whose numbers are either labeled targets or link to measured evidence.

**Implementation instructions**
1. `docs/EVIDENCE_INDEX.md` table: `| Claim | Kind (correctness/recovery/performance/security) | Evidence (test file::case, run ID + file, drill dir, dashboard name, command) | Status (verified / not yet measured / missed) |`. Rows at minimum: each docs/09 quality gate (Domain-ready … Performance-ready) → its CI job/test suite; the four project claims (docs/10 §Purpose); `duplicate_financial_effects_total = 0` → P12-T10 detector test + reference verify outputs; each README Targets row; the contention comparison → contention summary; failover and restore → drill dirs; IAM isolation → `iam-verification.json`; tenant isolation → P11 tests; offline demo → `test/e2e/demo.test.ts` + `pnpm demo`.
2. README: in "Targets", add a "Measured (reference)" column: for each row, either the measured value with a link to its `docs/BENCHMARK_REPORT.md` anchor/evidence file, or "not yet measured", or "missed — see report". Keep the "Target" column unchanged. Update "Status" to describe what exists, linking `docs/EVIDENCE_INDEX.md`; keep the sentence that unmeasured numbers are targets.
3. `test/contract/evidence-index.test.ts`: every Evidence cell link/path resolves (file exists; test file contains the named case string; run IDs have a manifest); every README "Measured" value equals the value at its linked evidence JSON path; no README row shows a measured value whose linked target `met` is false without the word "missed".

**Expected behavior** — Before P13-T18: performance rows read "not yet measured". After: values link to evidence.

**Acceptance criteria**
- [ ] Every claim row has resolvable evidence or an explicit non-verified status.
- [ ] README numbers are targets or linked measured values; nothing else.

**Testing requirements**
- `test/contract/evidence-index.test.ts` as above. Commands: `pnpm vitest run --project contracts test/contract/evidence-index.test.ts`, `pnpm check`.

**Non-goals** — No résumé text outside the repository.

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; targets stay labeled as targets.

---

### P13-GATE — GCP deployment, reference benchmark, and portfolio evidence gate

**Task ID:** `P13-GATE`
**Feature:** M13 exit gate verification (Performance-ready gate)
**Commit:** `test(evidence): add P13 gate verification and evidence note`
**Priority:** Critical
**Dependencies:** `P13-T01` … `P13-T22`
**Estimated complexity:** M
**Contract references:** docs/10 §M13 (all bullets and T&A), §Milestone summary row M13, §Demo and portfolio acceptance; docs/09 §Quality gates (Performance-ready), §Stop conditions
**Files:** create: `test/contract/p13-gate.test.ts`, `docs/evidence/P13.md`; must not touch: feature code
**Executor:** Agent; the offline checks (1–3) can run anytime; checks 4–7 need the human-produced evidence of P13-T13..T18 and are BLOCKED until it exists.

**Objective** — Prove the M13 exit gate from repository contents: reproducible infrastructure, isolation, HA, drills, reference trials, contention, evidence linkage, and offline runnability.

**Implementation instructions**
1. Offline: `terraform validate`, IaC scan, `iam-matrix.test.ts`, `no-migrate-on-startup.test.ts`, `terraform-inputs.test.ts`, `alerts-parity.test.ts` all green.
2. Offline runnability: a clean-clone job (`git clone` into a temp dir, `pnpm install --frozen-lockfile && pnpm build && pnpm db:up && pnpm demo --skip-contention`) with no GCP env vars set succeeds; `gitleaks` over the repository finds nothing; no file contains a non-synthetic credential pattern (reuse P11 secret scan).
3. `test/contract/p13-gate.test.ts` asserts presence and consistency of: `docs/evidence/P13-deploy.md` (HA inspection, IAM verification, scale test, alert test files), `docs/evidence/P13-restore.md` (RPO/RTO values and met flags from `rehearsal-summary.json`), `docs/evidence/P13-failover.md` (acknowledged missing = 0, verify zero in every class), ≥ 3 `reference-gcp` PASS-or-FAILED trials per headline workload at one commit/infra revision, one 60-min soak, a reference contention summary with both bucket counts, `docs/BENCHMARK_REPORT.md` consistency (evidence-consistency test), `docs/EVIDENCE_INDEX.md` (evidence-index test).
4. Correctness during and after reference trials: every reference run's `verify-after.json` has zero findings in every class and nonzero duplicate-effect `operationsChecked`; headline runs used for the report have `droppedIterations = 0`.
5. Targets: for each docs/10 §M12 numerical target, the report states met or missed with the measured value; the test fails if any target appears as met without a PASS run whose measured value satisfies it.
6. `docs/evidence/P13.md`: maps each docs/10 §M13 bullet and T&A bullet to evidence; lists the human-executed tasks with dates and the GCP project label (no IDs).
7. If evidence from P13-T13..T18 is missing, the gate reports `BLOCKED: P13-GATE — human-executed evidence missing: <task ids>` and does not pass.

**Expected behavior** — With all evidence present, the gate passes; otherwise it names the missing human tasks.

**Acceptance criteria**
- [ ] Every M13 bullet maps to verified evidence or an explicit documented miss.
- [ ] Clean-clone offline demo passes without cloud credentials.
- [ ] Correctness zero-findings rule holds for every reference run.

**Testing requirements**
- `test/contract/p13-gate.test.ts`; `pnpm check`; `pnpm vitest run --project e2e test/e2e/demo.test.ts`; `terraform validate`.

**Non-goals** — No new feature code or infrastructure.

**Handoff checklist**
- [ ] Measured values come only from raw artifacts; targets stay labeled as targets.
- [ ] Gate test observed failing with one evidence file removed, then restored.

---

## Parallelization

- **Offline wave 1 (after P12-GATE, parallel):** P13-T01, P13-T02, P13-T03, P13-T21. No shared files except `package.json` scripts (T02 `infra:inputs`, T21 `demo` — trivial rebase).
- **Offline wave 2:** P13-T04 → then P13-T05 and P13-T06 in parallel (separate `.tf` files; both extend `outputs.tf` and `test/contract/terraform-static.test.ts` — rebase) → P13-T07 → P13-T08 → P13-T09 and P13-T10 in parallel (T09 modifies `run.tf` to add sidecars; T10 adds `ops.tf` — no overlap except `outputs.tf`) → P13-T11 → P13-T12. P13-T19 after T08; P13-T20 after T08/T10.
- **Human wave (serial, one environment):** P13-T13 → P13-T16 → (P13-T17, P13-T15, P13-T14 in any order; they must not overlap in time because they share the database).
- **Agent after human wave:** P13-T18 → P13-T22 final values → P13-GATE.
- Single-owner surfaces: `infra/terraform/run.tf` (T08, then T09 sidecar edit), `README.md` (T21 adds a section; T22 edits Status/Targets — different sections), `infra/connection-budget.json` (read-only in P13; changing a value is a P12-T02-style edit with the budget test).

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M13: Terraform for Cloud Run services/jobs | P13-T08 | terraform validate; test/contract/terraform-static.test.ts :: budget references |
| docs/10 M13: regional HA Cloud SQL with synchronous standby/automatic failover | P13-T05, P13-T13 | terraform-static :: REGIONAL/PITR/PG17; docs/evidence/deploy/*/cloudsql-instance.json |
| docs/10 M13: Pub/Sub topics/subscriptions/DLQs | P13-T02, P13-T06 | test/contract/terraform-inputs.test.ts :: drift; terraform-static :: no literal names |
| docs/10 M13: Secret Manager entries | P13-T07 | test/contract/iam-matrix.test.ts :: secret owner matrix |
| docs/10 M13: retention archive/quarantine storage | P13-T20 (documented omission) | known-limits entry; risk R-06 |
| docs/10 M13: service accounts, networking, artifact storage | P13-T04, P13-T07 | terraform-static :: no open ingress; iam-matrix |
| docs/10 M13: dashboards and alert policies | P13-T09 | test/contract/alerts-parity.test.ts |
| docs/10 M13: distinct least-privilege SA and DB role per process | P13-T03, P13-T07, P13-T11, P13-T13 | iam-matrix.test.ts; infra/deploy/verify-iam.sh → iam-verification.json |
| docs/10 M13: min/max instances, concurrency, timeouts, leases, global connection budget | P13-T08, P12-T02 | terraform-static :: local.budget refs; connection-budget.test.ts |
| docs/10 M13: migration as explicit deployment step | P13-T08, P13-T11 | test/contract/no-migrate-on-startup.test.ts; deploy-script.test.ts :: order |
| docs/10 M13: backup/PITR + restore rehearsal with provider writes fenced | P13-T05, P13-T12, P13-T14 | drill-report.test.ts; docs/evidence/drills/restore-*/rehearsal-summary.json |
| docs/10 M13: planned failover under load, identities preserved, nothing lost/duplicated | P13-T12, P13-T15 | drill-report.test.ts :: missing op_id; docs/evidence/drills/failover-*/drill-summary.json |
| docs/10 M13: run matrix only after infra/telemetry/bounds verified | P13-T13, P13-T16 | P13-T16 dependency on P13-T13 evidence; p13-gate.test.ts |
| docs/10 M13: 3 trials per headline workload + 60-min soak, raw output, infra revision, dashboards, audit | P13-T10, P13-T16 | evidence-consistency.test.ts; p13-gate.test.ts :: ≥3 reference trials |
| docs/10 M13: contention comparison in reference env | P13-T17 | p13-gate.test.ts :: contention summary both bucket counts |
| docs/10 M13: diagrams, evidence index, report, known limits, failure-demo script, setup | P13-T18, P13-T19, P13-T20, P13-T21, P13-T22 | diagram-names.test.ts; evidence-index.test.ts; known-limits-links.test.ts; demo.test.ts |
| docs/10 M13: deterministic offline demo (idempotent capture, timeout→reconciliation→one posting, concurrent refunds, settlement) | P13-T21 | test/e2e/demo.test.ts :: steps 1–3, 6 |
| docs/10 M13 T&A: new environment from Terraform + bootstrap, no manual mutation | P13-T11, P13-T13 | deploy-script.test.ts; docs/evidence/deploy/*/terraform-apply.txt |
| docs/10 M13 T&A: SAs cannot access other secrets/topics/tables | P13-T07, P13-T11, P13-T13 | iam-matrix.test.ts; iam-verification.json |
| docs/10 M13 T&A: health checks, graceful shutdown, ack deadlines, connection limits under scale | P13-T08, P13-T13 | P13-deploy.md scale/shutdown sections with captured files |
| docs/10 M13 T&A: restore meets RPO/RTO or miss documented | P13-T14 | rehearsal-summary.json rpoMet/rtoMet; drill-report.test.ts :: miss wording |
| docs/10 M13 T&A: HA proven by Terraform + runtime inspection; failover audits exact | P13-T05, P13-T13, P13-T15 | terraform-static; cloudsql-instance.json; failover verify-after.json |
| docs/10 M13 T&A: M12 targets pass in reference env or report states measured result + bottleneck | P13-T18, P13-GATE | p13-gate.test.ts :: target met only with PASS run |
| docs/10 M13 T&A: contention published as measured ratio with lock-wait distributions | P13-T17, P13-T18 | report.test.ts section 9; evidence-consistency |
| docs/10 M13 T&A: verify zero in every class; dropped work zero | P13-T16, P13-GATE | p13-gate.test.ts :: verify-after zero, droppedIterations 0 |
| docs/10 M13 T&A: evidence index links every claim | P13-T22 | evidence-index.test.ts |
| docs/10 M13 T&A: public repo synthetic only, runs locally without paid cloud | P13-T21, P13-GATE | clean-clone demo job; gitleaks |
| docs/09 §Reference benchmark environment (region, API sizing, workers, Cloud SQL sizing, connection limit, Pub/Sub ordering, separate load generator, OTel sampling stated) | P13-T04, P13-T05, P13-T06, P13-T08, P13-T09, P13-T10 | terraform-static; manifest.test.ts :: reference config captured |
| docs/09 §Database failover (record list; RTO/RPO or miss; rehearsal separate) | P13-T12, P13-T15 | drill-report.test.ts |
| docs/09 §Soak (reference) | P13-T16 | p13-gate.test.ts :: soak present |
| docs/09 §Reporting template | P13-T18 (via P12-T22) | report.test.ts; evidence-consistency.test.ts |
| docs/08 §Disaster recovery steps 1–6 | P13-T12, P13-T14 | restore timeline.json step order |
| docs/08 §Recovery objectives and alerts (thresholds as alert policies with runbook links) | P13-T09, P13-T13 | alerts-parity.test.ts; alert test in P13-deploy.md |
| docs/01 §Initial deployment / §MVP deployment decisions (Cloud Run, Pub/Sub StreamingPull, dedicated receiver, single region, HA+PITR, provider writes not re-enabled before reconciliation) | P13-T05, P13-T06, P13-T08, P13-T12 | terraform-static; restore timeline unfence after reconcile |
| docs/10 §CI Release/evidence run | P13-T10, P13-T16 | .github/workflows/evidence.yml; evidence-consistency |
| docs/10 §Demo and portfolio acceptance items 1–9, offline | P13-T21 | demo.test.ts |
| CONVENTIONS §16: simulator own Cloud Run service, own DB + SA, unreachable from FlowLedger credentials, in connection budget | P13-T05, P13-T07, P13-T08, P13-T11 | iam-matrix :: simulator secrets; verify-iam.sh DB isolation; connection-budget.json reference.simulator |
| README Targets remain targets until measured | P13-T22 | evidence-index.test.ts :: README measured values |

## Phase risks / open questions

- **R-01 — Resolved:** P05 ships `topology.json` (plain data) and `topology.ts` helpers; the export script reads the JSON directly. Severity: Low. Blocked: none.
- **R-02 — DR tooling names come from P08 (`flowledger dr fence|reconcile-window|unfence`), not the contracts (docs/08:645, docs/10:401); P08 has no explicit republish command, so DR step 5 relies on running the relay against the restored database.** Severity: Medium. Resolution: if P08's commands change, update `restore-rehearsal.sh` only. Blocked: P13-T12, P13-T14.
- **R-03 — `docs/KNOWN_LIMITS.md` path comes from P11 (docs/10:511 names the document, not the path).** Severity: Low. Blocked: none.
- **R-04 — Cloud Run needs a listening port per service; P00 provides `API_PORT`/`HEALTH_PORT`/`SIMULATOR_PORT`, set to 8080 by P13-T08.** If a worker's health server does not bind until fully started, Cloud Run's startup probe timeout must cover worker start. Severity: Low. Blocked: none.
- **R-05 — Runtime role passwords on Cloud SQL.** Cloud SQL API users join `cloudsqlsuperuser`; this plan creates only `fl_migration_owner`/`fl_simulator_owner` as built-in users (so P02's `bootstrapDatabase` superuser step is not used in GCP) and sets runtime role passwords via `flowledger db set-role-passwords` in the migrate job (P02's `setLocalRolePasswords` is local-only). `fl_migration_owner` needs `CREATEROLE` (granted through `cloudsqlsuperuser`). The harness admin (`postgres` built-in user) needs explicit `SELECT` on `ledger.accounts` / `ledger.account_balances` for the lock sampler's ctid join, and `pg_locks` visibility (public) — granted in `deploy.sh` step 7. Severity: Medium. Blocked: P13-T03, P13-T11, P13-T16.
- **R-06 — Contract conflict: docs/10:576 (M13 Terraform includes "retention archive/quarantine storage") vs docs/10:497–500 and :806 (archival jobs and raw-quarantine deletion deferred; "The MVP does not create raw quarantine objects at all").** Recommended resolution: provision no archive/quarantine buckets (nothing writes them; an unused bucket is not evidence), record the omission in KNOWN_LIMITS (P13-T20), and ask the contract owner to strike the phrase from docs/10:576. Tasks follow this resolution. Severity: Low. Blocked: none.
- **R-07 — App secret variable names come from `docs/CONFIG.md`, not the contracts.** Severity: Low. Blocked: P13-T07.
- **R-08 — Simulator invoked without ID tokens; isolation by internal-only ingress.** Severity: Low (synthetic system). Resolution: documented limit. Blocked: none.
- **R-09 — Ops VM machine type `e2-standard-16` assumed.** Severity: Low. Resolution: report records generator CPU; if the generator saturates (> 80% CPU) the run notes it and a larger type is used for the next full set. Blocked: none.
- **R-10 — Contention pair in the reference env requires pointing services at alternate databases; `run.tf`/`secrets.tf` must compose `DATABASE_URL` from `database_name` / `simulator_database_name` variables (defaults `flowledger` / `flowledger_sim`).** P13-T07 MUST add both variables to the secret value composition so the human task does not edit code. Severity: Medium. Blocked: P13-T17.
- **R-11 — Cost and access.** P13-T13..T17 need a GCP project with billing and an operator with Owner (or equivalent) role; HA Cloud SQL 8 vCPU + Cloud Run min instances + VM incur meaningful hourly cost. Resolution: DEPLOY.md documents teardown; run human tasks in one contiguous window. Severity: Medium. Blocked: P13-T13–T18, P13-GATE.
- **R-12 — CONVENTIONS §16 says the simulator gets "its own Cloud SQL database"; this plan uses a separate small Cloud SQL *instance* (containing database `flowledger_sim`).** Reason: CONVENTIONS §16 isolation plus keeping simulator load off the system under test's database server so the benchmark measures FlowLedger alone; the connection budget has one section per instance. Severity: Low. Resolution: if the coordinator wants a shared instance, change only `cloudsql.tf` and the budget file. Blocked: none.
- **R-13 — Cloud SQL PG17 flag names for `pg_stat_statements`/IO timing must be checked against the provider at implementation time.** Severity: Low. Blocked: P13-T05.
