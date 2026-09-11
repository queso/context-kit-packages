# Changelog

All notable changes to `@context-kit/auth` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-09-10

### Breaking

- The Better Auth Prisma adapter is replaced by the Drizzle adapter; `@context-kit/auth` now stores users, sessions, accounts, and verifications through the app's Drizzle instance
- `createAuth()` config options `prisma` and `database` are replaced by `db` (the app's Drizzle instance) and `dialect` (`"sqlite" | "postgres"`)
- The `@prisma/client` peer dependency is replaced by `drizzle-orm` >= 0.41.0
- MySQL is no longer a supported dialect; context-kit does not support it

### Added

- `@context-kit/auth/schema/sqlite` and `@context-kit/auth/schema/postgres` entry points exporting the `user`, `session`, `account`, and `verification` Drizzle tables and their relations, for re-export from the app's `db/schema/<dialect>.ts`
- `AuthDialect` type export (`"sqlite" | "postgres"`)
- Adapter round-trip tests that sign a user up and read the session back, on an in-memory libsql database and -- via a CI job with a Postgres 17 service container -- on Postgres

### Migrating from 0.1.x

Fresh installs, and apps that never ran the 0.1.x Prisma schema, have no data to migrate: add the schema re-export line to `db/schema/<dialect>.ts`, run `bun run db:generate` and `bun run db:migrate`, and change `createAuth({ prisma, database })` to `createAuth({ db, dialect: getDialect() })`.

If you have existing data created under the 0.1.x Prisma schema, apply a column-rename migration before switching to 0.2.0: the Prisma columns are camelCase (`emailVerified`, `createdAt`) while the Drizzle schema uses snake_case (`email_verified`, `created_at`). Table names are unchanged.

## [0.1.0] - 2026-02-19

### Added

- `createAuth()` factory function that configures Better Auth with Prisma adapter, env-var fallbacks for `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`, email/password enabled by default, and configurable session duration and password rules (#WI-086)
- Social OAuth provider support with validation of `clientId`/`clientSecret` per provider (#WI-087)
- `toNextJsHandler` re-export from `better-auth/next-js` for wiring auth into Next.js Route Handlers (#WI-088)
- `getSession()` and `getUser()` server-side helpers that read cookies via `next/headers` for use in Server Components and Route Handlers (#WI-089)
- `createAuthMiddleware()` for route protection with redirect for page requests and 401 JSON for API requests; supports string prefix and RegExp route patterns (#WI-090)
- `createAuthClient` re-export from `better-auth/react` via the `@context-kit/auth/client` entry point (#WI-091)
- Full TypeScript type definitions: `AuthConfig`, `AuthInstance`, `SessionData`, `MiddlewareConfig`, `PasswordRules`, plus re-exports of `BetterAuthPlugin`, `SocialProviders`, `User`, `Session` (#WI-085)
- Three package entry points: `@context-kit/auth` (server), `@context-kit/auth/client` (React), `@context-kit/auth/middleware` (#WI-092)
- Bun test infrastructure with 9 test files and 39 tests covering all modules (#WI-084)
- tsup build config producing ESM with TypeScript declarations and sourcemaps (#WI-084)
