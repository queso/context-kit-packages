# PRD-0006: @context-kit/error-tracker

**Author:** Josh  **Date:** 2026-03-14  **Status:** Draft

## Revision (2026-09-11)

The storage layer is Drizzle, not Prisma. The package ships `client_error` as a Drizzle schema module per dialect (`@context-kit/error-tracker/schema/sqlite` and `/schema/postgres`); the app re-exports the module from its own `db/schema/<dialect>.ts` and owns the migration. The server factories take the app's Drizzle instance and its dialect (`{ db, dialect }`) instead of a Prisma client. SQLite is supported alongside PostgreSQL.

Deduplication is a single upsert on the unique `fingerprint` column. A repeat increments `occurrences`, bumps `last_seen_at`, and clears `resolved_at`, so an error marked resolved is reopened when it happens again. The configurable dedup window described below is gone: one row per fingerprint, for the life of the table.

Prisma references in the rest of this document are historical.

## 1. Context & Background

Client-side JavaScript errors are invisible to server logs. When a React component crashes, an unhandled promise rejects, or `console.error` fires in a user's browser, nothing appears in stdout, nothing lands in your log aggregator, and the developer finds out via a screenshot or a confused user message.

The standard solution — Sentry, GlitchTip, Datadog RUM — requires an external service, a DSN, an account, and in the case of source maps, either publicly serving your source code or a deployment pipeline that uploads maps to the vendor. That's a non-trivial integration for a project just trying to get visibility.

Context-kit apps already have Postgres. They already have a Next.js API layer. The instrumentation needed to catch and store errors is a thin wrapper around infrastructure that already exists. A purpose-built package that writes errors into the app's own database removes the external service dependency entirely, works offline, and gives developers (and AI coding tools) direct SQL access to error data.

## 2. Problem Statement

Context-kit developers have no visibility into client-side runtime errors in their apps. React error boundaries silently swallow crashes, unhandled promise rejections disappear into the void, and minified production stack traces are unreadable without tooling. Debugging requires manual reproduction rather than inspecting captured error data. There is no context-kit package that solves this without reaching for an external service.

## 3. Target Users & Use Cases

**Primary users:**
- **Context-kit developers** — developers building apps on the context-kit stack who want error visibility without wiring up a third-party observability service.
- **Solo/small-team developers using AI coding tools** — developers who collaborate with AI assistants that can query Postgres directly; having errors in the app's own database means the AI can look up recent crashes without needing access to a separate dashboard.

**Key use cases:**
- A developer needs to know why the campaign detail page is crashing in production so they can fix it without waiting for a user report.
- A developer wants an AI coding assistant to diagnose a bug by querying recent errors directly from the database.
- A developer wants to see whether a deployment introduced new errors by filtering the error table by timestamp and environment.
- A developer needs a readable stack trace from a production crash without publishing source maps publicly.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Capture client-side errors automatically | % of React error boundary catches that produce a DB row | 100% |
| Readable production stack traces | % of production errors with a resolved (non-minified) stack | >90% |
| No performance impact on error path | Time added to error boundary render by reporting | <50ms (fire-and-forget) |
| Safe write endpoint | Ability for unauthenticated public to spam the errors table | Blocked by secret header + rate limiting |
| Manageable table size | Row growth rate under normal operation with deduplication | Occurrences counter, not duplicate rows |
| Fast integration | Time from `bun add` to first error captured | <15 minutes |

## 5. Scope

### In Scope

- **`ClientError` Prisma model** — schema fragment consumers add to their schema; includes message, stack, component stack, fingerprint, occurrences counter, environment, URL, user agent, and timestamps
- **Ingestion route handler** — `POST /api/errors` that validates the payload, resolves the stack trace against source maps, deduplicates by fingerprint, and upserts to the DB
- **Query route handler** — `GET /api/errors` that returns recent errors with filtering by environment, date range, and fingerprint
- **React error boundary component** — drop-in `<ErrorBoundary>` that catches React render errors and reports them via the ingestion endpoint
- **Global error hooks** — `initErrorTracker()` function that installs `window.onerror` and `unhandledrejection` listeners; monkey-patches `console.error` with a configurable opt-in flag
- **Server-side source map resolution** — resolves minified stack traces using the `source-map` npm package against maps generated at build time; maps are read from the server filesystem, never served publicly
- **Deduplication** — errors with the same message + stack fingerprint within a configurable time window are collapsed into one row with an incrementing `occurrences` counter
- **Loop prevention** — the reporter detects if an error originates from within the error tracker itself and skips reporting to prevent infinite loops
- **Secret header auth** — the ingestion endpoint requires a configurable header token to block unauthenticated public writes in production
- **Rate limiting** — per-IP rate limiting on the ingestion endpoint, compatible with the context-kit middleware pattern
- **Environment tagging** — every error row includes `env` (`development` / `production`) derived from `NODE_ENV`
- **`npx error-tracker` CLI** — `tail` command that streams recent unresolved errors from the DB; `resolve <fingerprint>` command to mark an issue resolved
- **TypeScript types** for all public APIs, strict mode compatible

### Out of Scope

- **Purge/retention policy** — no auto-delete; consumers manage table size themselves if needed
- **Error dashboard UI** — no admin UI; errors are queried directly from Postgres or via the GET endpoint
- **User identity on errors** — no automatic association of errors to authenticated users (could be added by the consumer via context)
- **Network request errors / failed fetches** — only JavaScript runtime errors, not HTTP errors
- **React Native / non-Next.js frameworks** — App Router only; no support for Pages Router, Remix, etc.
- **Source map upload pipeline** — the package reads maps from the local filesystem; consumers must ensure maps are present on the server at runtime (documented, not automated)
- **Alerting / notifications** — no Slack/email alerts; out of scope for v1

## 6. Requirements

### Functional Requirements

1. The package shall export a `createErrorTracker` factory that accepts configuration (endpoint URL, secret header token, environment) and returns an initializer and error boundary component.
2. The `initErrorTracker()` function shall install a global `unhandledrejection` listener that reports unhandled promise rejections to the ingestion endpoint.
3. The `initErrorTracker()` function shall, when `patchConsoleError: true` is passed, wrap `console.error` so that calls to it are reported to the ingestion endpoint in addition to their normal output.
4. The `<ErrorBoundary>` component shall catch React render errors and report them to the ingestion endpoint via a fire-and-forget `fetch` (not awaited, shall not block rendering of the fallback UI).
5. The ingestion endpoint shall reject requests that do not include the configured secret header token with a 401 response.
6. The ingestion endpoint shall compute a fingerprint from the error message and the first three frames of the resolved stack trace.
7. The ingestion endpoint shall upsert by fingerprint: if a matching row exists and was last seen within the deduplication window, it shall increment the `occurrences` counter and update `lastSeenAt`; otherwise it shall insert a new row.
8. The ingestion endpoint shall attempt to resolve the minified stack trace against source maps on the server filesystem before writing to the database; if resolution fails, the raw stack shall be stored.
9. The ingestion endpoint shall tag every error with `env` derived from `NODE_ENV` at request time.
10. The query endpoint shall require the same secret header token as the ingestion endpoint; unauthenticated requests shall be rejected with a 401.
11. The query endpoint shall return errors ordered by `lastSeenAt` descending and shall support filtering by `env`, `since` (ISO timestamp), `fingerprint`, and `resolved` (boolean) query parameters.
12. The `ClientError` model shall include a `resolvedAt` nullable timestamp. When an error is marked resolved, `resolvedAt` is set and `occurrences` stops incrementing. If the same fingerprint is seen again after resolution, a new row shall be inserted (treating it as a new issue).
13. The package shall export the Prisma schema fragment as a documented copy-paste block and as a `prisma/error-tracker.prisma` file consumers can reference.
14. The reporter shall detect if the error originates within the error tracker module itself (by inspecting the stack) and shall skip reporting to prevent feedback loops.

### Non-Functional Requirements

1. The client-side `fetch` to the ingestion endpoint shall be fire-and-forget — it shall not be awaited and shall not block error boundary fallback rendering or any other UI path.
2. The ingestion endpoint shall respond within 200ms under normal load (deduplication lookup + optional source map resolution + upsert).
3. The package shall not bundle any runtime dependencies beyond what the consuming app already has (Next.js, Prisma); `source-map` is a server-only dependency.
4. All exported types shall be compatible with TypeScript strict mode (`strict: true`).
5. The package shall not make any outbound network requests; all writes go to the consuming app's own Postgres instance.
6. Per-IP rate limiting on the ingestion endpoint shall reject excess requests with a 429 before they reach database logic.

### Edge Cases & Error States

- **Ingestion endpoint is down when an error occurs** — the client `fetch` fails silently (fire-and-forget); no user-visible impact, error is lost for that occurrence.
- **Source map file is missing or corrupt** — the server logs a warning and stores the raw unresolved stack instead of failing the request.
- **Error occurs during source map resolution** — caught internally; raw stack stored, resolution failure is not reported as a new error (loop prevention).
- **Fingerprint collision** — two distinct errors produce the same fingerprint; occurrences are merged under one row. Acceptable tradeoff for simplicity in v1.
- **Extremely large stack traces** — stack strings shall be truncated at 10,000 characters before storage.
- **`console.error` called with non-Error arguments** — the monkey-patch shall serialize the arguments to a string and report as `message` with no stack.
- **Error during error boundary `fetch`** — caught with a try/catch; not re-thrown; no cascading failure.
- **Multiple rapid occurrences of the same error** — race condition on the upsert; Prisma upsert on fingerprint handles this; worst case is a duplicate row that gets merged on the next occurrence.
- **Secret header not configured** — if no token is set, the endpoint shall accept all requests (permissive default for local dev); documented that production deployments must set the token.

## 7. Design Principles

- **Zero external dependencies at runtime** — the package must work in an airplane-mode dev environment. No calls leave the machine.
- **Convention over configuration** — sensible defaults for everything; the minimum viable integration is two lines: add the schema fragment, mount the route handler.
- **Never break the app** — error reporting is best-effort. Any failure in the tracker (network down, DB unavailable, source map missing) must be caught and silenced. The tracker must never cause the app to crash or degrade.
- **SQL as the interface** — the query endpoint is a convenience; the real interface is Postgres. Consumers (and AI tools) should be able to run a SELECT and get useful answers without any additional tooling.
- **Readable over compressed** — store resolved, human-readable stack traces rather than raw minified stacks. The extra storage cost is worth the debugging value.

## 8. Solution Approach

The package is structured in two halves: a client module that instruments the browser, and a server module that receives, resolves, and stores errors.

On the client, a lightweight initializer attaches to the browser's global error events and optionally wraps `console.error`. A React error boundary component catches render-time crashes. Both funnel errors to a single internal reporter that constructs a JSON payload and fires a POST to the app's own API — without awaiting the response.

On the server, a pair of Next.js route handlers handle ingestion and querying. The ingestion handler validates the request, resolves the stack trace against build-time source maps stored on the server filesystem, computes a deduplication fingerprint, and upserts to the `ClientError` table. The query handler provides filtered access to stored errors.

The `ClientError` Prisma model lives in the consuming app's own schema. The package ships the model definition as a documented fragment; consumers copy it in, run their migration, and own the table alongside the rest of their data.

## 9. Technical Considerations

**Constraints:**
- Next.js App Router only; route handlers use the `export async function POST/GET` pattern
- Prisma 5+ required; the upsert relies on `createOrUpdate` with a unique constraint on `fingerprint`
- Source map resolution requires build-time source maps to be present on the server at runtime; for Next.js this means `productionBrowserSourceMaps: true` in `next.config.ts` (or equivalent), which writes maps to `.next/static/chunks/` — the server can read these at request time
- Source maps are read from the filesystem, never served as static assets; consumers must ensure the deployment includes the `.next/` directory (standard for self-hosted Next.js, not valid for edge runtimes)

**Dependencies:**
- `source-map` (npm) — server-only, for stack frame resolution
- `Prisma` — peer dependency; consumers provide their own client instance
- No additional runtime dependencies

**Integration points:**
- Consuming app's Prisma schema (model fragment addition)
- Consuming app's Next.js route structure (two route handlers mounted at `/api/errors`)
- Consuming app's middleware (rate limiting — package documents the pattern, consumers wire it in)
- Next.js build config (`productionBrowserSourceMaps: true` for production resolution)

**Out of scope — recommended separately:**
- OpenTelemetry covers server-side observability (traces, spans, API errors) and is natively supported by Next.js. This package fills the client-side blind spot OTel does not cover (React render crashes, unhandled rejections, console errors). The package README shall recommend OTel as the complement for server-side instrumentation rather than duplicating that concern here.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Secret header not set in production | Medium | Endpoint open to public writes, table spam | Warn loudly at startup if `NODE_ENV=production` and no token configured |
| Error storm fills Postgres table | Medium | Disk pressure, slow queries | Deduplication collapses repeats; document `DELETE FROM "ClientError" WHERE ...` cleanup query |
| Source maps not present on server at runtime | Medium | Unresolved stacks in production | Document the build config requirement clearly; fail gracefully with raw stack |
| `console.error` monkey-patch conflicts with React DevTools or third-party libs | Low | Unexpected suppression or double-reporting | Make `patchConsoleError` opt-in, default false |
| Edge runtime deployment (Vercel Edge, Cloudflare Workers) | Low | Source map resolution fails (no filesystem) | Document incompatibility; resolution is skipped gracefully, raw stack stored |
| Fingerprint collision causes unrelated errors to merge | Low | Confusing occurrence counts | Acceptable in v1; document fingerprinting logic so consumers can debug |

### Open Questions

No open questions remaining.

## 11. Rollout & Measurement

**Phasing:**
- **Phase 1 — Core capture:** `ClientError` model, ingestion endpoint, React error boundary, unhandled rejection listener. Enough to replace manual error boundary logging in KindredShelf.
- **Phase 2 — Production readiness:** Source map resolution, secret header auth, rate limiting, deduplication, loop prevention. Ready to deploy to production apps.
- **Phase 3 — DX polish:** `console.error` patching, query endpoint with filters, `npx error-tracker tail` and `resolve` CLI commands, documented SQL recipes, README with copy-paste integration guide.

**Measurement:**
- Integration test: errors thrown in a test app appear in the `ClientError` table within one request cycle
- Source map test: a known minified stack resolves to the correct file/line in the resolved output
- Load test: 100 rapid identical errors produce one row with `occurrences = 100`, not 100 rows
- Security test: requests without the secret header are rejected with 401
