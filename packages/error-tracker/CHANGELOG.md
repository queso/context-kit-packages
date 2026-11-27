# Changelog

All notable changes to `@context-kit/error-tracker` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-11-14

Records server-side errors.

### Migration required

The `client_error` table gains four columns and an index. After upgrading, run `bun run db:generate` and review and commit the migration it writes, then `bun run db:migrate`. The change is additive on both SQLite and Postgres: `source` is `text not null default 'client'`, so existing rows read as `client`; `route`, `method` and `tag` are nullable text; `client_error_source_idx` indexes `source`. Until the migration is applied, ingestion fails, because the package now writes the new columns.

### Added

- `createServerErrorReporter({ db, dialect, environment?, timeoutMs?, breaker? })` in `@context-kit/error-tracker/server`, returning `onRequestError` for Next.js `instrumentation.ts` (Next.js 15 and later) and `reportServerError(error, { route?, method?, tag? })` for errors the app catches itself
- Server errors go into `client_error` with `source` set to `server`, through the same upsert as browser reports, so repeats increment `occurrences` and a resolved error that recurs is reopened
- Server errors have their own fingerprint, `computeServerFingerprint(name, message, route, frames)`: the error name, the message, the route pattern and the function names of the top three frames. File paths, chunk names, lines and columns are ignored, so a deploy that rebuilds and renames chunks keeps the same error on its row. Frames without a function name contribute nothing. The browser fingerprint is unchanged
- A server row stores the error's name and message as `Name: message`, its stack, the route pattern (Next's `routePath`, never the concrete path or its query string), the HTTP method, and a tag (Next's `routeType` from `onRequestError`, or the caller's tag). Request headers, cookies, bodies and environment values are never read or stored. `route` is capped at 512 characters, `tag` at 128, and a query string or fragment in a caller-supplied `route` is dropped
- A thrown value that is not an Error is never serialized: primitives are stored as they are, and an object is stored as `non-Error object thrown with keys: ...` (top-level keys only)
- A Drizzle query error is stored as its statement plus its root cause's message (`Failed query: <sql> [cause: ...]`), with the bound parameters dropped from the message and the stack. The cause's class name is left out because a production bundle minifies it
- Credential-shaped strings are masked as `[redacted]` in a server error's message, stack, route and tag before it is fingerprinted and stored: `Bearer` tokens, JWTs, and keys prefixed `sk_`, `rk_`, `pk_`, `whsec_`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` or `github_pat_`. The patterns are exported as `REDACTION_PATTERNS`, and `maskSecrets(text)` applies them. This is a net, not a guarantee
- Reporting never throws into the caller. Each report waits at most `timeoutMs` (default 2000) for the database; a failed or timed-out write loses that report
- A breaker: after 3 consecutive failed writes, reports are skipped for 30 seconds and return at once, then one write is tried and a success resumes reporting. Configurable with `breaker: { failures, cooldownMs }`. Only database outcomes count toward it. Only the first failure of a streak, the breaker opening and the breaker closing are logged, one line each, and a failure line carries the database error's root cause, never the statement or its parameters
- `source`, `route`, `method` and `tag` columns in both schema modules, and the `client_error_source_idx` index
- Query endpoint `source` filter (`client` or `server`); any other value returns 400
- `error-tracker tail --source client|server`, and a Source column in `tail` output
- `error-tracker resolve <fingerprint> --source client|server`, which resolves only an error from that source
- `runTail` and `runResolve` accept `source`; `parseResolveArgs` is exported alongside `parseTailArgs`
- `ErrorSource`, `ServerErrorReporter`, `ServerErrorReporterConfig`, `ServerErrorContext`, `RequestErrorRequest` and `RequestErrorContext` type exports

### Changed

- Query endpoint rows carry `source`, `route`, `method` and `tag`
- `error-tracker resolve` with a missing fingerprint now prints `Error: resolve expects one fingerprint` and the usage text, and an unexpected extra argument is a usage error

### Known limitations

- Production function names are minified, so an edit to the file containing the throwing function can rename it and start a new row for the same error. The same holds for an error class from a bundled library that takes its `name` from its class. Resolving server stacks against source maps is tracked in #13
- A write that timed out can still land later, because a query handed to the driver cannot be cancelled portably
- A slow database can delay a route handler's error response by up to `timeoutMs`, since Next.js waits for `onRequestError` before sending it

## [0.1.0] - 2026-09-11

First release. Client-side error tracking for Next.js App Router apps, stored in the app's own database through its Drizzle instance.

### Added

- `createErrorTracker()` client factory returning `init()` (installs `window.onerror` and `unhandledrejection` listeners, optionally patches `console.error`) and a config-pre-bound `ErrorBoundary`
- `ErrorBoundary` React class component with a `ReactNode` or `(error) => ReactNode` fallback
- Fire-and-forget reporter with loop prevention: errors thrown inside the tracker are not reported, and network failures are swallowed
- `createErrorHandlers({ db, dialect, secretHeaderName?, secretHeaderToken?, queryHeaderToken?, sourceMapDir?, rateLimiter? })` producing `POST` (ingestion) and `GET` (query) route handlers, plus `createIngestionHandler` and `createQueryHandler` for mounting the two halves separately
- `@context-kit/error-tracker/schema/sqlite` and `@context-kit/error-tracker/schema/postgres` entry points exporting the `client_error` Drizzle table, for re-export from the app's `db/schema/<dialect>.ts`. Columns are snake_case, with a unique index on `fingerprint` and plain indexes on `last_seen_at` and `environment`
- Deduplication by SHA-256 fingerprint of the message and the top three stack frames, applied as one `insert ... on conflict (fingerprint) do update`
- Server-side source map resolution against build-time `.map` files read from the filesystem, with an LRU cache of parsed consumers
- Per-IP rate limiting, applied to both the ingestion and query endpoints, and secret-header auth on both endpoints
- `queryHeaderToken` on `createErrorHandlers` lets the query endpoint require a token separate from ingestion's `secretHeaderToken`, so a `NEXT_PUBLIC_`-prefixed ingestion token does not also authorize reading stored errors. Defaults to `secretHeaderToken` for backward compatibility
- Query endpoint filters: `env`, `since`, `fingerprint`, `resolved`, with offset pagination capped at 200 rows
- `npx error-tracker tail [--limit N] [--env ENV] [--since DATE]` and `npx error-tracker resolve <fingerprint>`. The CLI reads `DATABASE_URL` and loads `@libsql/client` for `sqlite:` URLs or `postgres` for `postgres://` and `postgresql://` URLs. `resolve` exits 1 on an unknown or already-resolved fingerprint
- `runTail` and `runResolve` exported from the `@context-kit/error-tracker/cli` entry point, for programmatic use with `{ db, dialect }`
- `ErrorTrackerDialect` and `DatabaseConfig` type exports
- Ingestion rejects request bodies over 64 KB with a 413 response, checked against the `content-length` header and again after the body is read
- Stored fields are capped in length rather than rejected: `message` at 2,000 characters, `stack` and `resolved_stack` at 10,000, `component_stack` at 10,000, `url` at 2,048, `user_agent` at 1,024
- Header token comparison is constant-time, comparing SHA-256 digests with `timingSafeEqual`
- Query endpoint `limit` falls back to 50 when missing, non-numeric, or below 1, and is capped at 200; `offset` falls back to 0 when non-numeric or negative; an invalid `since` value returns 400
- CLI validates `--limit` as a positive integer and `--since` as a valid date; a flag missing its value, or followed by another flag, is a usage error that exits 1
- The client reporter's fetch is bounded by a 5 second timeout via `AbortSignal.timeout` where the browser supports it
- Source map resolution reads maps asynchronously, dedups concurrent loads of the same file so simultaneous errors share one read, evicts its cache with true LRU (20 entries), validates chunk filenames against `[\w.-]+\.m?js` before touching the filesystem, and remembers a missing map so it is not reprobed on later reports
- Ingestion stores the client-reported `environment` from the payload when it is a non-empty string (truncated to 64 characters), falling back to the server's `NODE_ENV` (`development` when unset) when the payload omits it

- `runTail` and `runResolve` throw `CliUsageError`, `CliConfigError` or `NotFoundError` for programmatic callers; only the `error-tracker` binary prints them and exits 1
- The `unhandledrejection` listener calls `preventDefault()` only when `patchConsoleError` is enabled, so the browser console keeps reporting rejections by default
- Missing or corrupt source maps are remembered for 60 seconds, then re-probed

### Compared to the unreleased Prisma draft

This package was drafted against Prisma and never published. The storage layer is Drizzle instead, and the dedup logic is a fix rather than a port.

- `prisma` is replaced by `db` (the app's Drizzle instance) and `dialect` (`"sqlite" | "postgres"`) on `createErrorHandlers`, `createIngestionHandler` and `createQueryHandler`. The `@prisma/client` peer dependency is replaced by `drizzle-orm` >= 0.41.0, with `@libsql/client` and `postgres` as optional peers the CLI loads on demand
- The copy-paste `ClientError` Prisma model and the `./prisma` export are gone. Consumers add `export * from "@context-kit/error-tracker/schema/<dialect>"` to their schema file and run `bun run db:generate` and `bun run db:migrate`, so the app owns the migration
- `deduplicationWindowMs` is removed. The draft's find/create/catch logic dropped every recurrence of a resolved error: the unique `fingerprint` blocked the insert and the fallback update only matched unresolved rows, so the occurrence was lost. The 24-hour window never produced a second row for the same reason, which is why the option has no meaning to preserve. Ingestion is now one upsert on `fingerprint` that increments `occurrences`, bumps `last_seen_at`, keeps the stored `resolved_stack` unless a new one arrives, and clears `resolved_at`. A resolved error that happens again is reopened and reappears in `tail` and in `resolved=false` queries. Concurrent identical reports are serialized by the database rather than by a catch block
- SQLite is supported alongside PostgreSQL
