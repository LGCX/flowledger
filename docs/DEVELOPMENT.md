# Development

Everything needed to run FlowLedger locally, and what each command is for. The version pins
live in [`docs/VERSIONS.md`](VERSIONS.md); the environment variables each process reads live in
[`docs/CONFIG.md`](CONFIG.md).

## Prerequisites

- **Node** — the version in [`.nvmrc`](../.nvmrc). With nvm: `nvm install && nvm use`, and
  `nvm alias default "$(cat .nvmrc)"` so a new shell does not fall back to an older Node.
- **pnpm** — pinned by `packageManager` in `package.json`. Enable it once with
  `corepack enable pnpm`. `engine-strict=true` in `.npmrc` means a wrong Node or pnpm version
  fails the install instead of warning.
- **Docker** — only for the integration lane and `db:up`. The fast lane does not need it.

### If `pnpm` reports `Cannot find matching keyid`

The Corepack bundled with an older Node carries stale signing keys. Use the pinned Node and
refresh the shim:

```bash
nvm use
corepack enable pnpm
nvm alias default "$(cat .nvmrc)"
```

## First run

A clean clone needs exactly this:

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm check
```

## Command reference

Every root script. "Deferred" means the command exists but its real behaviour arrives with a
later phase — it is listed here so nobody assumes it is implemented.

| Command                   | What it does                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`            | Install workspace dependencies from the lockfile (`--frozen-lockfile` in CI).                                                     |
| `pnpm check`              | The gate: `lint`, `contracts:check`, `typecheck`, `test:unit`, `test:contracts`.                                                  |
| `pnpm lint`               | ESLint over the tree, then `prettier --check .`.                                                                                  |
| `pnpm format`             | `prettier --write .` — safe to run on code, but it also formats docs and the contract files' fenced examples, so review its diff. |
| `pnpm typecheck`          | `tsc -b` across the project references.                                                                                           |
| `pnpm build`              | `tsc -b`, emitting `dist/`. Required before `pnpm exec flowledger` works.                                                         |
| `pnpm test:unit`          | Vitest `unit` project: `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts`.                                                  |
| `pnpm test:contracts`     | Vitest `contracts` project: the contract, registry, fixture, and policy suites.                                                   |
| `pnpm test:integration`   | Vitest `integration` project. Needs Docker (Testcontainers).                                                                      |
| `pnpm test:e2e`           | Vitest `e2e` project.                                                                                                             |
| `pnpm test:performance`   | Deferred: prints `test:performance: not implemented until P12` and exits 0. P12 replaces it.                                      |
| `pnpm contracts:generate` | Regenerate `packages/contracts/src/generated/**` from `schemas/` and `openapi/`.                                                  |
| `pnpm contracts:check`    | Fail if the committed generated files differ from a fresh generation.                                                             |
| `pnpm db:up`              | Start Postgres, the Pub/Sub emulator, and Jaeger, and wait for health.                                                            |
| `pnpm db:down`            | Stop them and remove the volumes.                                                                                                 |
| `pnpm db:migrate`         | Apply pending migrations as `fl_migration_owner` (add `--bootstrap` once per fresh volume).                                       |
| `pnpm db:seed`            | Load the dev seed and print the synthetic credentials once.                                                                       |
| `pnpm verify:task`        | The task gate: refuses to run on `main`, then runs `pnpm check` and `pnpm build`. Add `--full` for the integration and e2e lanes. |

### Running one test file

```bash
pnpm vitest run --project contracts test/contract/semantic.test.ts
```

The project name is one of `unit`, `contracts`, `integration`, `e2e`, `chaos`. Running a file
without `--project` skips it if its project does not match.

When passing flags to vitest through a `pnpm` script, **omit the `--` separator**:

```bash
pnpm test:contracts --reporter=junit --outputFile.junit=reports/contracts.xml
```

With `--`, pnpm forwards it verbatim, vitest reads it as end-of-options, and every following
argument becomes a file filter. The run then matches no files and still exits 0 because
`passWithNoTests` is enabled in the shared config — a green run that executed nothing. CI passes
`--passWithNoTests=false` so a mis-filtering of that kind fails instead.

## Local infrastructure

`pnpm db:up` brings up three services and waits for all of them to report healthy.

| Service          | Port        | Notes                                                                                 |
| ---------------- | ----------- | ------------------------------------------------------------------------------------- |
| PostgreSQL       | 5432        | Databases `flowledger` and `flowledger_sim`; roles created by migration `0200` (P02). |
| Pub/Sub emulator | 8085        | Real Pub/Sub is not available locally; producers and consumers use the emulator.      |
| Jaeger UI        | 16686       | Trace UI.                                                                             |
| OTLP collector   | 4317 / 4318 | gRPC / HTTP. `4318` answers `405` to a `GET` — it accepts `POST` only.                |

Credentials are synthetic and come from `infra/docker/.env.example`. Copy it to
`infra/docker/.env` before `db:up`; never commit that file.

## The `flowledger` CLI and the bin linking rule

pnpm only creates the `flowledger` shim once `apps/cli/dist/index.js` exists. On a fresh clone
`pnpm install` links nothing, so `pnpm exec flowledger` fails with `exit 254` — and a second
`pnpm install` after the build fixes it:

```bash
pnpm build && pnpm install     # then: pnpm exec flowledger --help
```

Any job or script that runs the CLI — P02 `migrate`, P03 `verify` — must build first and install
again, or invoke `node apps/cli/dist/index.js` directly, which has no linking requirement.

## Committing

`.git/hooks/pre-commit` runs `pnpm verify:task`. It refuses a commit on `main` (a task needs its
own branch, `task/<task-id>-<slug>`) and aborts if `pnpm check` or `pnpm build` fails. The hook
is local to a clone, not tracked; install it with:

```bash
printf '#!/bin/sh\nexec node scripts/verify-task.mjs\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

CI re-runs the same script content through the `fast` and `integration` jobs, which is the
enforcement that applies to everyone rather than to one clone.

## A local PostgreSQL already on 5432

`pnpm db:up` publishes the container on `POSTGRES_HOST_PORT` (default 5432). If a local PostgreSQL is
already listening there, macOS resolves `localhost` to `127.0.0.1` and the CLI reaches _that_ server
instead of the container — so migrations run against a database nobody intended, often failing with
syntax errors in SQL that is perfectly valid (an older server rejecting PG16+ `GRANT ... WITH INHERIT`).

`pnpm db:up` now compares the `version()` reported through the published port with the one the container
reports and refuses to continue when they differ, printing the commands to use another port:

```bash
POSTGRES_HOST_PORT=5433 pnpm db:up
MIGRATION_DATABASE_URL=postgres://fl_migration_owner:fl_local_owner_password@localhost:5433/flowledger \
DATABASE_ADMIN_URL=postgres://postgres:flowledger_local_only@localhost:5433/postgres \
pnpm db:migrate --bootstrap
pnpm db:migrate
pnpm db:seed
```

`db:migrate --bootstrap` is needed once per fresh volume: it creates `fl_migration_owner` and takes
ownership of the database, which the PostgreSQL image otherwise leaves with the superuser.
