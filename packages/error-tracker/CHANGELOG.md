# Changelog

All notable changes to `@context-kit/error-tracker` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-11

First release. Client-side error tracking for Next.js App Router apps, stored in the app's own database through its Drizzle instance.

### Added

- `createErrorTracker()` client factory returning `init()` (installs `window.onerror` and `unhandledrejection` listeners, optionally patches `console.error`) and a config-pre-bound `ErrorBoundary`
- `ErrorBoundary` React class component with a `ReactNode` or `(error) => ReactNode` fallback
- Fire-and-forget reporter with loop prevention: errors thrown inside the tracker are not reported, and network failures are swallowed
- `createErrorHandlers({ db, dialect, secretHeaderName?, secretHeaderToken?, sourceMapDir?, rateLimiter? })` producing `POST` (ingestion) and `GET` (query) route handlers, plus `createIngestionHandler` and `createQueryHandler` for mounting the two halves separately
- `@context-kit/error-tracker/schema/sqlite` and `@context-kit/error-tracker/schema/postgres` entry points exporting the `client_error` Drizzle table, for re-export from the app's `db/schema/<dialect>.ts`. Columns are snake_case, with a unique index on `fingerprint` and plain indexes on `last_seen_at` and `environment`
- Deduplication by SHA-256 fingerprint of the message and the top three stack frames, applied as one `insert ... on conflict (fingerprint) do update`
- Server-side source map resolution against build-time `.map` files read from the filesystem, with an LRU cache of parsed consumers
- Per-IP rate limiting on the ingestion endpoint, and secret-header auth on both endpoints
- Query endpoint filters: `env`, `since`, `fingerprint`, `resolved`, with offset pagination capped at 200 rows
- `npx error-tracker tail [--limit N] [--env ENV] [--since DATE]` and `npx error-tracker resolve <fingerprint>`. The CLI reads `DATABASE_URL` and loads `@libsql/client` for `sqlite:` URLs or `postgres` for `postgres://` and `postgresql://` URLs. `resolve` exits 1 on an unknown or already-resolved fingerprint
- `runTail` and `runResolve` exported from the `@context-kit/error-tracker/cli` entry point, for programmatic use with `{ db, dialect }`
- `ErrorTrackerDialect` and `DatabaseConfig` type exports

### Compared to the unreleased Prisma draft

This package was drafted against Prisma and never published. The storage layer is Drizzle instead, and the dedup logic is a fix rather than a port.

- `prisma` is replaced by `db` (the app's Drizzle instance) and `dialect` (`"sqlite" | "postgres"`) on `createErrorHandlers`, `createIngestionHandler` and `createQueryHandler`. The `@prisma/client` peer dependency is replaced by `drizzle-orm` >= 0.41.0, with `@libsql/client` and `postgres` as optional peers the CLI loads on demand
- The copy-paste `ClientError` Prisma model and the `./prisma` export are gone. Consumers add `export * from "@context-kit/error-tracker/schema/<dialect>"` to their schema file and run `bun run db:generate` and `bun run db:migrate`, so the app owns the migration
- `deduplicationWindowMs` is removed. The draft's find/create/catch logic dropped every recurrence of a resolved error: the unique `fingerprint` blocked the insert and the fallback update only matched unresolved rows, so the occurrence was lost. The 24-hour window never produced a second row for the same reason, which is why the option has no meaning to preserve. Ingestion is now one upsert on `fingerprint` that increments `occurrences`, bumps `last_seen_at`, keeps the stored `resolved_stack` unless a new one arrives, and clears `resolved_at`. A resolved error that happens again is reopened and reappears in `tail` and in `resolved=false` queries. Concurrent identical reports are serialized by the database rather than by a catch block
- SQLite is supported alongside PostgreSQL
