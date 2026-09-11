# Architecture

The error-tracker is split into two halves: a **client module** that instruments the browser and a **server module** that receives, resolves, and stores errors.

## Data Flow

```
Browser                                    Server
┌──────────────────────┐                  ┌──────────────────────────────┐
│                      │                  │                              │
│  ErrorBoundary ──┐   │   POST           │  Rate Limiter                │
│  window.onerror ─┤   │  /api/errors     │       │                      │
│  unhandledrejection ─┤ ──────────────►  │  Auth Check (secret header)  │
│  console.error ──┘   │  fire-and-forget │       │                      │
│      │               │                  │  Source Map Resolution       │
│   reporter.ts        │                  │       │                      │
│   (builds payload,   │                  │  Fingerprint                 │
│    sends fetch,      │                  │       │                      │
│    never awaits)     │                  │  Upsert → client_error       │
│                      │                  │                              │
└──────────────────────┘                  └──────────────────────────────┘
```

The server half never opens its own connection. It writes through the `db` instance the app passes to `createErrorHandlers`, so errors land in the same database, the same pool, and the same transaction semantics as the rest of the app.

## Client Module

### Entry Point: `createErrorTracker(options)`

The factory in `src/factory.ts` creates a configured tracker instance. It returns:

- **`init()`** - installs `window.onerror` and `unhandledrejection` listeners; optionally patches `console.error`. Returns a cleanup function that removes all listeners.
- **`ErrorBoundary`** - a React class component with `config` pre-bound via `defaultProps`, so consumers use it without passing config.

### Reporter (`src/reporter.ts`)

All error sources funnel into `reportError()`, which:

1. **Loop prevention** - checks if the error stack contains `@context-kit/error-tracker` (the package itself) and skips reporting to prevent infinite loops
2. **Payload construction** - builds a JSON body with message, stack, componentStack, URL, userAgent, environment, and timestamp
3. **Auth header** - if `token` and `secretHeaderName` are configured, attaches the token as a request header
4. **Fire-and-forget** - calls `fetch()` without `await`; any network error is caught and swallowed

### Error Sources

| Source | File | Captures |
|--------|------|----------|
| React render errors | `error-boundary.tsx` | `componentDidCatch`, captures error + component stack |
| Uncaught exceptions | `init.ts` | `window.onerror`, error, source, line, column |
| Unhandled rejections | `init.ts` | `unhandledrejection` event, serializes the rejection reason |
| Console errors | `console-patch.ts` | Wraps `console.error`, opt-in via `patchConsoleError: true` |

### Stack Truncation

Both `reporter.ts` (client-side) and `ingestion.ts` (server-side) truncate stack traces at 10,000 characters to prevent oversized payloads and database bloat.

## Server Module

### Entry Point: `createErrorHandlers(config)`

The factory in `src/server.ts` composes the server-side pipeline. `config` carries `db` (the app's Drizzle instance) and `dialect` (`"sqlite" | "postgres"`), which the package uses to pick the matching schema module and the matching upsert builder.

1. **Rate limiter** (`src/server/rate-limiter.ts`) - per-IP fixed window; the counter resets once `windowMs` elapses since the window opened, applied to both POST and GET
2. **Source map resolution** (`src/server/source-map-resolver.ts`) - if `sourceMapDir` is configured, resolves the stack before ingestion
3. **Ingestion handler** (`src/server/ingestion.ts`) - validates, fingerprints, and upserts
4. **Query handler** (`src/server/query.ts`) - filtered read access to stored errors

### Ingestion Pipeline

```
Request → Auth Check → Parse JSON → Validate → Truncate Stacks
    → Parse Frames → Compute Fingerprint
    → INSERT ... ON CONFLICT (fingerprint) DO UPDATE
    → Response
```

**Fingerprinting:** SHA-256 of `message | frame1 | frame2 | frame3` where each frame is `file:line:column:functionName`. Uses resolved frames when available so the same logical error from different builds produces a stable fingerprint.

**Deduplication:** one statement, no read-then-write. The insert targets the unique `fingerprint` column; on conflict the update:

- sets `occurrences` to `occurrences + 1`
- sets `last_seen_at` to the incoming timestamp
- keeps the stored `resolved_stack` unless the incoming report carries one
- sets `resolved_at` to `NULL`

So there is exactly one row per fingerprint for the life of the table, and an error marked resolved is reopened the next time it fires. It reappears in `error-tracker tail` and in `resolved=false` queries, which is the signal that the fix did not hold.

**Concurrency:** the database resolves races on the unique index. Two simultaneous reports of the same error produce one row with `occurrences` at 2. There is no application-level retry or error-code fallback.

### Stack Frame Parsing

A shared parser (`src/server/parse-stack.ts`) is used by both the fingerprinting logic and the source map resolver. It handles V8-style stack traces with both file paths and full URLs:

```
at MyComponent (http://localhost:3000/_next/static/chunks/app-abc123.js:42:15)
at /app/.next/static/chunks/main-def456.js:100:8
```

### Query Handler

Supports filtering by `env`, `since` (ISO timestamp), `fingerprint`, and `resolved` (boolean). Pagination is offset-based with a max limit of 200 per request. Results are Drizzle rows, so the JSON keys are the schema's TypeScript property names (`lastSeenAt`, `resolvedAt`, `componentStack`, `resolvedStack`, `userAgent`) even though the columns are snake_case.

## File Structure

```
src/
├── index.ts              # Client barrel export
├── server.ts             # Server barrel export + createErrorHandlers factory
├── types.ts              # Shared types (ErrorTrackerConfig, ErrorPayload, StackFrame,
│                         #   ErrorTrackerDialect, DatabaseConfig)
├── factory.ts            # createErrorTracker client factory
├── reporter.ts           # Fire-and-forget error reporter
├── init.ts               # Global error listener installation
├── error-boundary.tsx    # React ErrorBoundary component
├── console-patch.ts      # console.error monkey-patch (opt-in)
├── cli.ts                # CLI entry point (tail, resolve) + runTail / runResolve
├── schema/
│   ├── sqlite.ts         # client_error table for SQLite
│   └── postgres.ts       # client_error table for PostgreSQL
└── server/
    ├── auth.ts           # Constant-time token comparison + prod no-token warning
    ├── connect.ts        # DATABASE_URL parsing and driver selection for the CLI
    ├── ingestion.ts      # POST handler + fingerprint + upsert
    ├── query.ts          # GET handler with filters
    ├── rate-limiter.ts   # Per-IP fixed-window rate limiting
    ├── source-map-resolver.ts  # Stack resolution with LRU cache
    ├── parse-stack.ts    # Shared V8 stack frame regex parser
    └── store.ts          # The package's only database access point (per-dialect Drizzle store behind one interface)
```

## Package Exports

```json
{
  ".":                 "dist/index.js",            // Client: createErrorTracker, ErrorBoundary, types
  "./server":          "dist/server.js",           // Server: createErrorHandlers, createRateLimiter, ...
  "./cli":             "dist/cli.js",              // runTail, runResolve for scripts
  "./schema/sqlite":   "dist/schema/sqlite.js",    // client_error table for db/schema/sqlite.ts
  "./schema/postgres": "dist/schema/postgres.js"   // client_error table for db/schema/postgres.ts
}
```

The `bin` field maps the `error-tracker` binary to the same `dist/cli.js`.

## Design Decisions

**Why not Sentry/GlitchTip?** Context-kit apps already have a database. Writing errors to it removes the external service dependency, works offline, and gives AI coding tools direct SQL access.

**Why the app's Drizzle instance instead of a connection string?** The route handlers run inside the app, which already has a configured, pooled `db`. Taking `db` keeps the package out of the connection-management business and means a package bump can never open a second pool. The CLI is the exception: it runs outside the app, so it reads `DATABASE_URL` and constructs its own client.

**Why ship a schema module per dialect instead of one copy-paste model?** The consumer re-exports the module from `db/schema/<dialect>.ts` and runs `bun run db:generate`, so drizzle-kit produces the migration and the app owns the history. A schema change in a later version arrives as a reviewable diff migration rather than a docs instruction to edit a model by hand.

**Why fire-and-forget?** Error reporting must never degrade the user experience. The `fetch` is not awaited, and any failure (network down, server error) is caught and dropped.

**Why SHA-256 fingerprinting?** Deterministic, fast, and collision-resistant enough for error grouping. Using the top 3 resolved frames (not raw frames) keeps fingerprints stable across builds.

**Why `defaultProps` for the factory ErrorBoundary?** The factory needs to pre-bind config so consumers can use `<ErrorBoundary>` without passing a config prop. `defaultProps` is the standard React pattern for this: it allows consumers to override config if needed while providing a sensible default.

**Why a single upsert instead of a dedup window?** A read-then-write dedup path has to decide what counts as "the same error, recently enough", and it has to handle the race where two requests both read nothing and both insert. The unique `fingerprint` column already answers both. One row per fingerprint, the database increments the counter, and the window option disappears along with the class of bugs it created.

**Why reopen a resolved error instead of inserting a new row?** The fingerprint identifies the error, not the incident. A second row would split the occurrence count and hide the history of the first. Clearing `resolved_at` puts the same row back in the unresolved list with its full count and its original `created_at` intact.
