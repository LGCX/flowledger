# Configuration

Every setting is an environment variable, parsed once at startup into a frozen, typed object
(CONVENTIONS §11). There is no config file, no runtime re-read, and no config discovered from the
filesystem.

**Failure contract.** Invalid or missing configuration fails startup with a `ConfigError` whose
message names the variable and never echoes its value: `NODE_ENV: must be one of development, test,
production`. A secret therefore cannot leak through a crash log.

**Test mode.** `NODE_ENV=test` starts every app using only `infra/docker/.env.example` values. No
application requires an undocumented secret to boot (docs/10 §M0).

**Commands that print a credential.** `flowledger seed` and `flowledger credentials issue` print a raw
synthetic `fl_test_` credential once, so they run only when `NODE_ENV` is `development` or `test`. An
unset or unrecognised `NODE_ENV` is refused like `production`; `infra/docker/.env.example` sets
`development`. `credentials revoke` prints nothing secret and is not restricted.

**Adding a variable.** Every task that adds a variable appends a row to the table below _and_ a line
to `infra/docker/.env.example` in the same commit. A test in `packages/config/src/base.test.ts`
fails when the two lists disagree.

## Variables

| Variable                          | Read by                                                                                                                                                       | Required                 | Default                         | Allowed values                                                                         | Secret? | Introduced in |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------- | ------- | ------------- |
| `NODE_ENV`                        | `packages/config/src/base.ts` (`parseBaseConfig`) — every app                                                                                                 | Yes                      | —                               | `development`, `test`, `production`                                                    | No      | P00-T03       |
| `SHUTDOWN_GRACE_MS`               | `packages/config/src/base.ts` → `runMain` — every app                                                                                                         | No                       | `10000`                         | integer `1000`–`60000`                                                                 | No      | P00-T03       |
| `API_PORT`                        | `apps/api` (`readPort`)                                                                                                                                       | Yes                      | —                               | integer `0`–`65535`                                                                    | No      | P00-T04       |
| `HEALTH_PORT`                     | the eight worker apps (`readPort`)                                                                                                                            | Yes                      | —                               | integer `0`–`65535`                                                                    | No      | P00-T04       |
| `SIMULATOR_PORT`                  | `apps/provider-simulator/src/config.ts` (`parseSimulatorConfig`)                                                                                              | Yes                      | —                               | integer `0`–`65535`                                                                    | No      | P00-T05       |
| `SIMULATOR_TEST_ENDPOINTS`        | `apps/provider-simulator/src/config.ts`; rejected when `NODE_ENV=production`                                                                                  | No                       | `0`                             | `0`, `1`                                                                               | No      | P00-T05       |
| `POSTGRES_PASSWORD`               | `infra/docker/compose.yaml` (`postgres` service)                                                                                                              | No                       | `flowledger_local_only`         | non-empty string                                                                       | Yes     | P00-T06       |
| `FL_SIMULATOR_PASSWORD`           | `infra/docker/postgres-init/10-simulator-db.sh` (via compose)                                                                                                 | No                       | `fl_simulator_local_only`       | non-empty string                                                                       | Yes     | P00-T06       |
| `FL_SIMULATOR_TRUTH_PASSWORD`     | `infra/docker/postgres-init/10-simulator-db.sh` (via compose)                                                                                                 | No                       | `fl_simulator_truth_local_only` | non-empty string                                                                       | Yes     | P00-T06       |
| `MIGRATION_DATABASE_URL`          | `packages/config/src/cli.ts` (`loadCliConfig`) — `flowledger migrate`, `seed`                                                                                 | Yes for `migrate`/`seed` | —                               | postgres URL whose user is `fl_migration_owner`                                        | Yes     | P02-T01       |
| `DATABASE_ADMIN_URL`              | `packages/config/src/cli.ts` — `flowledger migrate --bootstrap`                                                                                               | No                       | —                               | postgres URL (superuser)                                                               | Yes     | P02-T01       |
| `LEDGER_BUCKET_COUNT`             | `packages/config/src/cli.ts` → `migrate` GUC `flowledger.ledger_bucket_count`                                                                                 | No                       | `32`                            | integer `1`–`1024`                                                                     | No      | P02-T01       |
| `LEDGER_ENVIRONMENT`              | `packages/config/src/cli.ts` → `migrate` GUC `flowledger.ledger_environment`                                                                                  | No                       | `LOCAL`                         | `LOCAL`, `SANDBOX`                                                                     | No      | P02-T01       |
| `FLOWLEDGER_LOCAL_ROLE_PASSWORD`  | `packages/config/src/cli.ts` — sets local role passwords; refused in production                                                                               | No                       | —                               | non-empty string                                                                       | Yes     | P02-T01       |
| `API_CREDENTIAL_PEPPERS`          | `packages/config/src/cli.ts`, `apps/cli/src/commands/seed.ts`, `apps/cli/src/commands/credentials.ts` — peppered credential digest material                   | No                       | —                               | `<version>:<base64url pepper>[,<version>:<base64url pepper>]`, each pepper >= 32 bytes | No      | P02-T15       |
| `OPERATOR_DATABASE_URL`           | `packages/config/src/cli.ts`, `apps/cli/src/commands/credentials.ts` — operator connection for credential issue/revoke; must connect as `fl_operator_command` | No                       | —                               | postgres URL with user `fl_operator_command`                                           | No      | P02-T15       |
| `POSTGRES_HOST_PORT`              | `infra/docker/compose.yaml` — host port the Compose PostgreSQL publishes; set it when a local server already owns 5432                                        | No                       | `5432`                          | integer port                                                                           | Yes     | P02-GATE      |
| `DATABASE_POOL_MAX`               | `packages/config/src/cli.ts`; `packages/database` pool sizing                                                                                                 | No                       | `4`                             | integer `1`–`100`                                                                      | No      | P02-T01       |
| `PROVIDER_SIMULATOR_DATABASE_URL` | `apps/provider-simulator` only                                                                                                                                | Yes (simulator)          | —                               | `postgres://` URL, role `fl_simulator`                                                 | Yes     | P06           |
| `SIMULATOR_DATABASE_URL`          | harness only: `packages/testkit`, `flowledger verify`                                                                                                         | No                       | unset                           | `postgres://` URL, role `fl_simulator_truth`                                           | Yes     | P03           |
| `PUBSUB_EMULATOR_HOST`            | `packages/messaging` transport                                                                                                                                | No                       | unset                           | `host:port`                                                                            | No      | P05           |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | `packages/observability`                                                                                                                                      | No                       | unset                           | `http://host:port`                                                                     | No      | P11           |
| `FC_SEED`                         | `packages/testkit/src/fast-check-setup.ts` — unit tests only                                                                                                  | No                       | `20261108`                      | integer                                                                                | No      | P01-T01       |
| `FC_NUM_RUNS`                     | `packages/testkit/src/fast-check-setup.ts` — unit tests only                                                                                                  | No                       | `200`                           | integer `1`–`100000`                                                                   | No      | P01-T01       |

## Variables with restricted readers

Two variables are deliberately readable by only one class of process. Both restrictions are
machine-checked by ESLint (P00-T02), not merely documented here.

- **`SIMULATOR_DATABASE_URL`** — Harness-only (testkit, `flowledger verify`); runtime code must not
  read it — enforced by ESLint (P00-T02). When unset, the duplicate-effect check reports
  `0 rows checked (ground truth unavailable)`.
- **`PROVIDER_SIMULATOR_DATABASE_URL`** — provider-simulator service only, owner role `fl_simulator`;
  first read in P06.
- **`PUBSUB_EMULATOR_HOST`** — first read in P05. When unset, deployed processes use real Pub/Sub.
- **`OTEL_EXPORTER_OTLP_ENDPOINT`** — first read in P11. When unset, telemetry export is disabled.

## Not in this table yet

`DATABASE_URL` arrives with the first service that connects (P05), and secret references
(`local-secret://…`) are resolved by `packages/config/src/secrets.ts`, created in P06. Neither exists
yet, so neither is listed.

## CLI variables are per role

`flowledger` acts as several database roles, so it takes one URL per role it performs
(`MIGRATION_DATABASE_URL` now, `OPERATOR_DATABASE_URL` later). A service process keeps exactly one
`DATABASE_URL`. This was chosen over a single overloaded variable because the CLI must never connect as
the migration owner by accident, and a URL that names its role makes that impossible to misread.
