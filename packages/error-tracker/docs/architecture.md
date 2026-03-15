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
│      │               │                  │  Source Map Resolution        │
│   reporter.ts        │                  │       │                      │
│   (builds payload,   │                  │  Fingerprint + Dedup         │
│    sends fetch,      │                  │       │                      │
│    never awaits)     │                  │  Prisma Upsert → Postgres    │
│                      │                  │                              │
└──────────────────────┘                  └──────────────────────────────┘
```

## Client Module

### Entry Point: `createErrorTracker(options)`

The factory in `src/factory.ts` creates a configured tracker instance. It returns:

- **`init()`** — installs `window.onerror` and `unhandledrejection` listeners; optionally patches `console.error`. Returns a cleanup function that removes all listeners.
- **`ErrorBoundary`** — a React class component with `config` pre-bound via `defaultProps`, so consumers use it without passing config.

### Reporter (`src/reporter.ts`)

All error sources funnel into `reportError()`, which:

1. **Loop prevention** — checks if the error stack contains `@context-kit/error-tracker` (the package itself) and skips reporting to prevent infinite loops
2. **Payload construction** — builds a JSON body with message, stack, componentStack, URL, userAgent, environment, and timestamp
3. **Auth header** — if `token` and `secretHeaderName` are configured, attaches the token as a request header
4. **Fire-and-forget** — calls `fetch()` without `await`; any network error is caught and swallowed

### Error Sources

| Source | File | Captures |
|--------|------|----------|
| React render errors | `error-boundary.tsx` | `componentDidCatch` — captures error + component stack |
| Uncaught exceptions | `init.ts` | `window.onerror` — error, source, line, column |
| Unhandled rejections | `init.ts` | `unhandledrejection` event — serializes the rejection reason |
| Console errors | `console-patch.ts` | Wraps `console.error` — opt-in via `patchConsoleError: true` |

### Stack Truncation

Both `reporter.ts` (client-side) and `ingestion.ts` (server-side) truncate stack traces at 10,000 characters to prevent oversized payloads and database bloat.

## Server Module

### Entry Point: `createErrorHandlers(config)`

The factory in `src/server.ts` composes the server-side pipeline:

1. **Rate limiter** (`src/server/rate-limiter.ts`) — per-IP sliding window with lazy cleanup of expired entries
2. **Source map resolution** (`src/server/source-map-resolver.ts`) — if `sourceMapDir` is configured, resolves the stack before ingestion
3. **Ingestion handler** (`src/server/ingestion.ts`) — validates, fingerprints, deduplicates, and upserts
4. **Query handler** (`src/server/query.ts`) — filtered read access to stored errors

### Ingestion Pipeline

```
Request → Auth Check → Parse JSON → Validate → Truncate Stacks
    → Parse Frames → Compute Fingerprint → Find Existing
    → Upsert (atomic increment or create with P2002 fallback)
    → Response
```

**Fingerprinting:** SHA-256 of `message | frame1 | frame2 | frame3` where each frame is `file:line:column:functionName`. Uses resolved frames when available so the same logical error from different builds produces a stable fingerprint.

**Deduplication:** If an unresolved record with the same fingerprint exists within the dedup window (default 24h), the `occurrences` counter is atomically incremented. If the fingerprint exists but was resolved, a new record is created.

**Race condition handling:** The create path wraps in `try/catch` for Prisma's P2002 (unique constraint violation). If two concurrent requests both pass the `findFirst` check and both attempt to create, the loser falls back to `updateMany` with atomic increment.

### Stack Frame Parsing

A shared parser (`src/server/parse-stack.ts`) is used by both the fingerprinting logic and the source map resolver. It handles V8-style stack traces with both file paths and full URLs:

```
at MyComponent (http://localhost:3000/_next/static/chunks/app-abc123.js:42:15)
at /app/.next/static/chunks/main-def456.js:100:8
```

### Query Handler

Supports filtering by `env`, `since` (ISO timestamp), `fingerprint`, and `resolved` (boolean). Pagination is offset-based with a max limit of 200 per request.

## File Structure

```
src/
├── index.ts              # Client barrel export
├── server.ts             # Server barrel export + createErrorHandlers factory
├── types.ts              # Shared types (ErrorTrackerConfig, ErrorPayload, StackFrame)
├── factory.ts            # createErrorTracker client factory
├── reporter.ts           # Fire-and-forget error reporter
├── init.ts               # Global error listener installation
├── error-boundary.tsx    # React ErrorBoundary component
├── console-patch.ts      # console.error monkey-patch (opt-in)
├── cli.ts                # CLI entry point (tail, resolve)
└── server/
    ├── ingestion.ts      # POST handler + fingerprint + dedup
    ├── query.ts          # GET handler with filters
    ├── rate-limiter.ts   # Per-IP rate limiting with lazy cleanup
    ├── source-map-resolver.ts  # Stack resolution with LRU cache
    └── parse-stack.ts    # Shared V8 stack frame regex parser
```

## Package Exports

```json
{
  ".":        "dist/index.js",      // Client: createErrorTracker, ErrorBoundary, types
  "./server": "dist/server.js",     // Server: createErrorHandlers, createRateLimiter, etc.
  "./prisma": "dist/index.js"       // Alias (for potential future Prisma extension use)
}
```

## Design Decisions

**Why not Sentry/GlitchTip?** Context-kit apps already have Postgres. Writing errors to the app's own database removes the external service dependency, works offline, and gives AI coding tools direct SQL access.

**Why fire-and-forget?** Error reporting must never degrade the user experience. The `fetch` is not awaited, and any failure (network down, server error) is silently caught.

**Why SHA-256 fingerprinting?** Deterministic, fast, and collision-resistant enough for error grouping. Using the top 3 resolved frames (not raw frames) ensures stability across builds.

**Why `defaultProps` for the factory ErrorBoundary?** The factory needs to pre-bind config so consumers can use `<ErrorBoundary>` without passing a config prop. `defaultProps` is the standard React pattern for this — it allows consumers to override config if needed while providing a sensible default.

**Why atomic increment + P2002 fallback?** The dedup upsert must be safe under concurrent load. Using Prisma's `{ increment: 1 }` avoids lost updates, and catching P2002 on the create path handles the race where two requests try to insert the same fingerprint simultaneously.
