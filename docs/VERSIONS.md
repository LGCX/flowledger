# Pinned versions

Every runtime and development dependency is pinned to an exact version. `pnpm-lock.yaml` is
committed. This file is updated **in the same commit as any version bump** (CONVENTIONS §2, §13).

## Toolchain

A pinned binary outside the package managers needs its integrity recorded too. gitleaks is
downloaded by CI and verified before it runs:

```text
gitleaks_8.30.1_linux_x64.tar.gz
sha256  551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
```

The digest was confirmed by downloading the release asset and hashing it, then comparing with
the published `gitleaks_8.30.1_checksums.txt`, rather than copied from the checksum file alone.
On a bump: repeat that comparison, update both workflow variables and this file in the same
commit.

| Tool             | Pinned version    | Where pinned                                                           |
| ---------------- | ----------------- | ---------------------------------------------------------------------- |
| Node.js          | 24.22.1           | `.nvmrc`, `package.json#engines.node`                                  |
| pnpm             | 10.34.9           | `package.json#packageManager` (Corepack)                               |
| gitleaks         | 8.30.1            | `.github/workflows/ci.yml` (`GITLEAKS_VERSION`, `GITLEAKS_SHA256`)     |
| PostgreSQL       | 17.11             | `compose.yaml`; `POSTGRES_IMAGE` in `packages/testkit/src/postgres.ts` |
| Pub/Sub emulator | 592.0.0-emulators | `compose.yaml` image `gcr.io/google.com/cloudsdktool/google-cloud-cli` |
| Jaeger           | 1.76.0            | `compose.yaml` image `jaegertracing/all-in-one`                        |
| Docker Engine    | 24.0 minimum      | host requirement                                                       |
| Docker Compose   | v2.20+            | host requirement                                                       |
| Terraform        | 1.9+              | first used in P13                                                      |
| k6               | 0.5x+             | first used in P12                                                      |

Node.js is the newest 24.x patch that had been released for at least 14 days when this task ran
(24.22.1, released 2026-10-20). `engine-strict=true` in `.npmrc` makes a mismatched Node or pnpm
version a hard install failure rather than a warning.

## devDependencies

| Package                       | Pinned version | Purpose                                    |
| ----------------------------- | -------------- | ------------------------------------------ |
| `typescript`                  | 5.9.3          | compiler                                   |
| `@types/node`                 | 24.19.2        | Node.js typings for the pinned Node 24     |
| `vitest`                      | 4.1.12         | test runner; `test.projects` needs >= 3.2  |
| `eslint`                      | 9.39.5         | linter (flat config)                       |
| `@eslint/js`                  | 9.39.5         | ESLint core `recommended` config           |
| `typescript-eslint`           | 8.72.1         | TypeScript parser and `recommended` config |
| `prettier`                    | 3.9.10         | formatter                                  |
| `openapi-typescript`          | 7.13.0         | `openapi.ts` generation (P00-T07)          |
| `json-schema-to-typescript`   | 16.0.0         | `messages.ts` generation (P00-T07)         |
| `@apidevtools/swagger-parser` | 13.1.0         | parses `openapi.yaml` for both generators  |

`typescript`, `@types/node`, and `@eslint/js` are not on the CONVENTIONS §2 approved-dependency
list. They are justified in the P00-T01 commit body: no approved package provides the compiler,
the Node typings, or ESLint's own recommended config, and `typescript-eslint` peer-depends on the
first two.

## Runtime dependencies

Declared per application in `apps/<app>/package.json`, pinned exactly. Every one is on the
CONVENTIONS §2 approved list, and `test/contract/dependency-policy.test.ts` fails on any addition
that is not.

| Package                      | Pinned version | Declared by                                 |
| ---------------------------- | -------------- | ------------------------------------------- |
| `@nestjs/core`               | 11.2.8         | every app (all nine)                        |
| `@nestjs/common`             | 11.2.8         | every app (all nine)                        |
| `@nestjs/platform-fastify`   | 11.2.8         | `api` only                                  |
| `fastify`                    | 5.12.8         | `api` only                                  |
| `rxjs`                       | 7.8.2          | every app (NestJS peer)                     |
| `reflect-metadata`           | 0.2.2          | every app (decorator metadata at runtime)   |
| `@testcontainers/postgresql` | 12.2.1         | `packages/testkit` (PostgreSQL fixture)     |
| `testcontainers`             | 12.2.1         | `packages/testkit`                          |
| `pg`                         | 8.23.1         | `packages/testkit`, root (integration)      |
| `@types/pg`                  | 8.23.1         | `packages/testkit`, root                    |
| `fast-check`                 | 4.10.2         | `packages/domain` (dev), `packages/testkit` |

`@flowledger/config` is a `workspace:*` dependency of every app, and every app is a `workspace:*`
devDependency of the root so `test/contract/**` can boot it.
