---
missionId: ~
---

# Port @context-kit/auth from Prisma to Drizzle

**Author:** Claude (draft), Josh (owner)  **Date:** 2026-09-10  **Status:** Draft
**Tracks:** [queso/context-kit-packages#2](https://github.com/queso/context-kit-packages/issues/2) (supersedes item 3 of that issue, which shelved the auth port)
**Depends on:** [queso/context-kit#19](https://github.com/queso/context-kit/issues/19), shipped as context-kit 0.2.0 (`b45643c feat: replace Prisma with Drizzle, SQLite by default`)

## Executive Summary

context-kit 0.2.0 replaced Prisma with Drizzle ORM (SQLite on `@libsql/client` by default, Postgres optional) and apps are built on that base going forward. `@context-kit/auth` still requires a `PrismaClient`, so it cannot be installed into a kit app today. This mission swaps the Better Auth Prisma adapter for the Drizzle adapter, ships the auth tables as Drizzle schema modules the app spreads into its own `db/schema/<dialect>.ts`, and rewrites the docs. The wire format, entry points, session helpers, middleware, client, and all of `@context-kit/auth-ui` are ORM-agnostic and do not change. Prisma support is removed rather than kept as a second lane; 0.1.x remains the Prisma release. Ships as `@context-kit/auth` 0.2.0.

Everything in this plan that touches Better Auth or drizzle-kit behaviour was verified in a scratch spike on 2026-09-10 against the versions this repo locks (`better-auth` 1.4.18) and the kit uses (`drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10, `@libsql/client` 0.18). See section 9.

## Definition of Done

- [ ] `createAuth({ db, dialect })` accepts a Drizzle instance from a context-kit app (`import { db, getDialect } from "@/db"`) and returns a working Better Auth instance for both `sqlite` and `postgres`.
- [ ] `@context-kit/auth/schema/sqlite` and `@context-kit/auth/schema/postgres` export the `user`, `session`, `account`, and `verification` tables; an app that adds `export * from "@context-kit/auth/schema/sqlite"` to `db/schema/sqlite.ts` and runs `bun run db:generate` gets a migration that creates all four tables.
- [ ] `grep -ri prisma packages/ README.md CLAUDE.md` returns only `packages/auth/CHANGELOG.md`.
- [ ] A test signs a user up and reads the session back through the adapter against an in-memory libsql database; the suite is green under `bun test`, `bun run typecheck`, and `bun run build`.
- [ ] README, CHANGELOG (with a 0.1 to 0.2 migration note), root README, and CLAUDE.md describe the Drizzle workflow; version is 0.2.0.

## 1. Context & Background

### What the packages repo has today

`packages/auth` is Better Auth wrapped for the App Router. The Prisma coupling is small and confined to the factory:

| File | Prisma coupling |
|------|-----------------|
| `packages/auth/src/create-auth.ts` | imports `prismaAdapter`, throws if `config.prisma` is missing, passes `provider: config.database` |
| `packages/auth/src/types.ts` | `AuthConfig.prisma: unknown`, `AuthConfig.database: "postgresql" \| "mysql" \| "sqlite"` |
| `packages/auth/package.json` | `@prisma/client` as peer and dev dependency; description |
| `packages/auth/tsup.config.ts` | `@prisma/client` in `external` |
| `packages/auth/src/__tests__/helpers.ts` | `mockPrisma = { $connect }` |
| `packages/auth/src/__tests__/create-auth.test.ts` | "throws when prisma is not provided" |
| `packages/auth/src/__tests__/types.test.ts` | `prisma: {}` in config literals |
| `packages/auth/src/__tests__/client.test.ts` | asserts `prismaAdapter` is not re-exported from the client entry |
| `packages/auth/README.md`, `CHANGELOG.md` | schema section, quick start, config table, "Why Better Auth" |
| `README.md`, `CLAUDE.md` (root) | "Prisma-native" philosophy, "any Next.js + Prisma stack", stack assumptions |

Already ORM-agnostic and untouched by this mission: `session.ts`, `middleware.ts`, `handler.ts`, `client.ts`, and the whole of `packages/auth-ui` (zero Prisma references; it depends only on `@context-kit/auth/client`).

No existing test exercises the database. `mockPrisma` never reaches the adapter, so the adapter wiring has never been covered. The port adds that coverage.

### What context-kit 0.2.0 expects

- `db/index.ts` exports `db` (a Proxy over a lazy singleton, typed `LibSQLDatabase | PostgresJsDatabase`), `getDialect()` returning `"sqlite" | "postgres"`, and `createDb(url)` for tests. Rule from `db/AGENTS.md`: "Always import `db` from `@/db`. Never create a second Drizzle instance."
- One schema module per dialect: `db/schema/sqlite.ts` and `db/schema/postgres.ts`, kept in sync until the app picks one. `drizzle.config.ts` chooses dialect, schema file, and `db/migrations/<dialect>` from `DATABASE_URL`.
- Migrations are plain SQL from `drizzle-kit generate`, never hand-edited, applied by `bun run db:migrate` and at server start (`instrumentation.ts`).
- Columns are `snake_case`; drivers are `@libsql/client` and `postgres`.
- The kit itself stays auth-free ("Do not add auth, billing, teams, or SaaS features"). Nothing in this mission changes context-kit.

## 2. Problem Statement

A context-kit app has no `PrismaClient` to hand to `createAuth`, and the package's README tells it to run `prisma migrate`. The package is unusable on the base every new app starts from. Issue #2 parked this ("still Prisma-native for the SaaS lane"); that decision is reversed: apps use Drizzle going forward, so the package follows.

## 3. Target Users & Use Cases

- **A developer starting an app from context-kit** needs `bun add @context-kit/auth`, one line in `db/schema/<dialect>.ts`, `bun run db:generate`, `bun run db:migrate`, and a five-line `lib/auth.ts` to have sign-up, sign-in, and sessions working on SQLite with no container.
- **A SaaS-lane app on Postgres** needs the same package to work when `DATABASE_URL` is `postgres://...`, with no code change beyond `dialect`.
- **The packages repo maintainers** need a bump to `@context-kit/auth` that changes the auth schema to surface in the consuming app as a generated migration on its next `db:generate`, which is the "fix once, inherit everywhere" contract.
- **`@context-kit/auth-ui`** needs to keep working unchanged.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Drizzle is the only adapter | Files, deps, or docs referencing Prisma outside `CHANGELOG.md` | Zero |
| Works on the kit's `db` | Test passes `createAuth` a Proxy-wrapped lazy Drizzle instance shaped like `db/index.ts` | Green |
| Both dialects | Adapter test on in-memory libsql; Postgres job in CI against a service container | Both green |
| Schema ships with the package | `drizzle-kit generate` from an app schema that re-exports the package module | Produces `CREATE TABLE` for all four tables |
| Adapter is covered | Sign-up plus `getSession` round-trip test through the adapter | Exists and passes |
| No collateral change | `packages/auth-ui` diff | Empty |

## 5. Scope

### In Scope

- **Adapter swap.** `create-auth.ts` uses `drizzleAdapter` from `better-auth/adapters/drizzle` with `provider` mapped from `dialect` (`sqlite` to `"sqlite"`, `postgres` to `"pg"`) and `schema` set to the package's own module for that dialect, so the adapter does not depend on the app having attached a schema to its Drizzle instance.
- **Config API.** `AuthConfig` replaces `prisma` and `database` with `db` (the app's Drizzle instance) and `dialect: "sqlite" | "postgres"`, the kit's `Dialect` union. `createAuth` throws a descriptive error when `db` is missing or `dialect` is not one of the two values. MySQL is dropped; the kit does not support it.
- **Schema modules.** `packages/auth/src/schema/sqlite.ts` and `packages/auth/src/schema/postgres.ts`, authored from the `@better-auth/cli generate` output for the Drizzle adapter (tables `user`, `session`, `account`, `verification`; `snake_case` columns; indexes on `session.user_id`, `account.user_id`, `verification.identifier`; cascading FKs to `user`; relations). Exposed as `./schema/sqlite` and `./schema/postgres` entry points with `types`, `import`, and `default` conditions. The `default` condition is required: drizzle-kit loads schema files through a CommonJS resolver and fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` when only `import` is present (verified).
- **Schema parity test.** Both dialect modules export the same table keys with the same column keys, mirroring the kit's "keep the two in sync" rule.
- **Adapter round-trip test.** A helper opens `@libsql/client` at `:memory:`, applies the sqlite schema (drizzle-kit's programmatic push API, or a package-local generated migration folder outside `files`; the mission picks whichever works), wraps the instance in a Proxy shaped like the kit's `db`, and runs `auth.api.signUpEmail` then `auth.api.getSession`. Postgres runs the same test only when `DATABASE_URL` is a `postgres:` URL, following the kit's `it.skipIf` pattern, with a CI job that provides a Postgres 17 service container.
- **Dependencies.** Remove `@prisma/client`. Add peer `drizzle-orm >=0.41.0` (Better Auth's own floor). Dev dependencies: `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10`, `@libsql/client ^0.18.0`, `postgres ^3.4.9`, and `@better-auth/cli` for regenerating the reference schema. `tsup` externals: `drizzle-orm` replaces `@prisma/client`; entries add the two schema files.
- **Docs.** `packages/auth/README.md` rewritten around the kit workflow: install, the one-line re-export into `db/schema/<dialect>.ts`, `db:generate` and `db:migrate`, a `lib/auth.ts` example using `db` and `getDialect()` from `@/db`, updated config table. `CHANGELOG.md` gets a 0.2.0 entry marked breaking with a 0.1 to 0.2 migration note (see edge cases). Root `README.md` and `CLAUDE.md`: "Prisma-native" becomes "Drizzle-native", "any Next.js + Prisma stack" becomes "any Next.js + Drizzle stack", package table and stack assumptions updated, `pnpm update` becomes `bun update`.
- **Version.** `@context-kit/auth` 0.2.0.

### Out of Scope

- Changes to context-kit. It stays auth-free; the package consumes its `db`.
- A dual Prisma/Drizzle lane. 0.1.x is the Prisma release; nothing in `main` keeps it alive.
- `@context-kit/auth-ui`. It imports only the client entry, which is unchanged. Its peer range `@context-kit/auth >=0.1.0` still holds.
- The Authentik identity package and `error-tracker` from issue #2. Separate missions; the schema-shipping pattern settled here (section 9) is the convention they follow.
- Upgrading Better Auth. The repo locks 1.4.18; latest is 1.7.3. The port stays on the locked version and the upgrade is its own change.
- Better Auth plugins (org, 2FA), which add tables. Their schema modules follow the same pattern when they land.
- Publishing to npm.

## 6. Requirements

### Functional Requirements

1. `createAuth` shall accept `{ db, dialect }` where `db` is any Drizzle database instance and `dialect` is `"sqlite"` or `"postgres"`, and shall configure Better Auth with `drizzleAdapter(db, { provider, schema })` using the package's schema module for that dialect.
2. `createAuth` shall throw an error naming the `db` option when `db` is missing, and an error listing both supported values when `dialect` is anything else. Existing validation for secret, base URL, social providers, session duration, and password rules is unchanged.
3. The package shall export `./schema/sqlite` and `./schema/postgres` whose modules export `user`, `session`, `account`, `verification`, and their `relations`, with column names matching Better Auth's Drizzle CLI output so the adapter needs no field mapping.
4. Those entry points shall declare `types`, `import`, and `default` conditions, and a test or CI step shall run `drizzle-kit generate` against a schema file that re-exports the package module and assert the migration creates four tables.
5. A test shall create a user via `auth.api.signUpEmail` and read it back via `auth.api.getSession` through the adapter on an in-memory libsql database, passing `db` as a Proxy over a lazily created instance (the kit's shape).
6. A schema parity test shall assert the sqlite and postgres modules export identical table and column key sets.
7. `bun run typecheck`, `bun run build`, and `bun run test` shall pass at the repo root; CI shall add a job that runs the auth tests with `DATABASE_URL` pointed at a Postgres 17 service container.
8. No file outside `packages/auth/CHANGELOG.md` shall reference Prisma. The `client.test.ts` assertion changes from `prismaAdapter` to `drizzleAdapter`.
9. `AuthInstance`, `SessionData`, `MiddlewareConfig`, `PasswordRules`, and the Better Auth re-exports shall keep their current names and shapes.

### Non-Functional Requirements

1. The runtime dependency list of `packages/auth` shall not grow: `drizzle-orm` is a peer, and the drivers are the app's.
2. The client entry shall remain free of server-only imports; the existing client test enforces this.
3. Test setup shall need no Docker for the SQLite path; Postgres coverage is CI-only and skipped locally without a URL.

### Edge Cases & Error States

- **Existing 0.1.x data on Prisma.** Better Auth's Prisma models use camelCase columns (`emailVerified`); the Drizzle schema uses `snake_case` (`email_verified`). Table names match. The CHANGELOG notes that upgrading in place needs a column-rename migration, and that context-kit apps will not hit this because they never ran the Prisma schema.
- **`"user"` is a reserved word in Postgres.** Drizzle quotes identifiers, and the Better Auth CLI emits `user` by default; keep the singular default. `usePlural` stays off.
- **App passes a Drizzle instance without the auth schema attached.** Works, because the package passes its own `schema` to the adapter; the app still needs the re-export for `db:generate` to produce the tables. The README says so.
- **Two copies of `drizzle-orm`.** The peer dependency prevents it under Bun; drizzle-kit's table detection uses entity-kind string tags, so a duplicate would still serialize, but the README lists a single `drizzle-orm` as a requirement.
- **`dialect` disagrees with the actual database.** Not detectable cheaply; the README recommends `dialect: getDialect()` from `@/db` so the two cannot drift.
- **Consumer on `drizzle-orm` older than 0.41.** Bun refuses the peer; the error is Bun's own.

## 9. Technical Considerations

### Verified in the spike (2026-09-10)

- `better-auth` 1.4.18 exposes `better-auth/adapters/drizzle` with `drizzleAdapter(db, { provider: "pg" | "mysql" | "sqlite", schema?, usePlural?, camelCase? })`.
- `@better-auth/cli generate` against a Drizzle-configured auth file emits a complete Drizzle schema for both `sqlite` (`integer(..., { mode: "timestamp_ms" })`, `unixepoch` defaults) and `pg` (`timestamp`, `boolean`, `defaultNow()`), with `snake_case` columns and singular table names. This output is the source for the package's schema modules.
- Round trip on libsql `:memory:` through a kit-style Proxy `db`: `signUpEmail` returned 200, `getSession` returned the user with `expiresAt` as a `Date`, and a `db.select().from(user)` through the same Proxy returned the row.
- `drizzle-kit generate` from an app schema containing `export * from "<package>/schema/sqlite"` plus a local table produced one migration with five `CREATE TABLE` statements, but only after the package's `exports` map gained a `default` condition alongside `import`. With `import` only it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Schema-shipping pattern (the convention issue #2 asked for)

The package owns the schema and exports it as importable Drizzle table modules, one per dialect. The app re-exports them from its own `db/schema/<dialect>.ts` so drizzle-kit sees one flat schema, and the app owns the migration history. A package bump that changes the schema shows up as a generated diff migration on the app's next `db:generate`, which the app reviews and commits like any other. Migrations are not shipped by the package: drizzle-kit has no way to compose migration journals across packages, and the app's `db/migrations/<dialect>` folder is the single source of truth for what has been applied. The rejected alternative, running `@better-auth/cli generate` inside the app, is a code drop that stops tracking the package.

### Proposed config surface

```ts
import { createAuth } from "@context-kit/auth"
import { db, getDialect } from "@/db"

export const auth = createAuth({ db, dialect: getDialect() })
```

```ts
// db/schema/sqlite.ts (app)
export * from "@context-kit/auth/schema/sqlite"
```

### Constraints

- Stay on `better-auth` 1.4.18 and Drizzle 0.4x; no ORM or auth upgrade rides along.
- `packages/auth` keeps Bun as the test runner and tsup as the builder; `bun test` needs no preload for this package.
- The package remains driver-agnostic: it never imports `@libsql/client` or `postgres` outside tests.

### Suggested work items (for `/ateam plan`)

1. Schema modules, entry points, tsup entries, `default` export condition, parity test, drizzle-kit re-export smoke test.
2. `types.ts` and `create-auth.ts` swap to `{ db, dialect }` and `drizzleAdapter`; update `helpers.ts`, `create-auth.test.ts`, `types.test.ts`, `client.test.ts`; add the in-memory libsql round-trip test.
3. Dependencies, lockfile, CI Postgres job, Postgres `skipIf` test.
4. Docs and version: `packages/auth/README.md`, `CHANGELOG.md`, root `README.md`, `CLAUDE.md`, 0.2.0.
5. Consumer check: link the built package into a scratch clone of context-kit, add the re-export, run `db:generate`, `db:migrate`, and a sign-up through the route handler.

Item 1 has no dependencies; 2 depends on 1; 3 and 4 depend on 2; 5 depends on all.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Better Auth or drizzle-kit behaviour differs from the spike once inside tsup output | Low | Item 5 fails | Item 5 uses the built `dist`, not `src` |
| drizzle-kit programmatic push API is awkward under `bun test` | Medium | Test helper churn | Fallback is a committed dev-only migration folder generated from the sqlite module |
| Schema drift between the two dialect modules over time | Medium | Postgres lane rots | Parity test plus the CI Postgres job |
| A future Better Auth upgrade changes the expected schema | Medium | Consumer migration needed | Regenerate with the CLI, diff against the modules, ship as a package bump; the app's `db:generate` produces the migration |
| Unpublished 0.1.x has consumers on Prisma | Low | Breaking change lands on someone | CHANGELOG migration note; 0.1.x stays tagged |

### Open Questions

- [ ] Replace Prisma outright versus keep a dual-adapter lane. Recommendation: replace; the kit has no Prisma and a dual lane doubles the test matrix. This plan assumes replace.
- [ ] Explicit `dialect` versus inferring it from the Drizzle instance. Recommendation: explicit, documented as `dialect: getDialect()`; inference would depend on Drizzle internals.
- [ ] Drop MySQL now or keep the `"mysql"` provider passthrough untested. Recommendation: drop; add back when a supported driver exists in the kit.
- [ ] Singular table names (`user`) versus `usePlural`. Recommendation: singular, matching Better Auth's default and its CLI output.
