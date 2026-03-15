# @context-kit/error-tracker

Client-side error tracking for Next.js App Router apps. Captures React render crashes, unhandled promise rejections, and `window.onerror` events, then stores them in your app's own Postgres database via Prisma. No external service required.

## Features

- **Error Boundary** — React component that catches render errors and reports them
- **Global Error Listeners** — Captures `window.onerror` and `unhandledrejection` events
- **Fire-and-Forget Reporter** — Non-blocking error reporting with loop prevention
- **Server Ingestion** — Route handler that validates, deduplicates, and stores errors
- **Source Map Resolution** — Resolves minified stack traces on the server using build-time source maps
- **Query API** — Retrieve and filter stored errors with offset-based pagination
- **Rate Limiting** — Per-IP rate limiting on the ingestion endpoint
- **Console Patching** — Optionally capture `console.error` calls (opt-in)
- **Deduplication** — Same error fingerprints are collapsed into one row with an occurrence counter
- **CLI** — `npx error-tracker tail` and `npx error-tracker resolve <fingerprint>`

## Quick Start

### 1. Install

```bash
bun add @context-kit/error-tracker
# or
npm install @context-kit/error-tracker
```

### 2. Add the Prisma model

Copy the model from `node_modules/@context-kit/error-tracker/prisma/error-tracker.prisma` into your schema, or paste it directly:

```prisma
model ClientError {
  id             String    @id @default(cuid())
  message        String
  stack          String?
  componentStack String?
  resolvedStack  String?
  fingerprint    String    @unique
  occurrences    Int       @default(1)
  environment    String
  url            String?
  userAgent      String?
  resolvedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  lastSeenAt     DateTime
}
```

Then migrate:

```bash
bunx prisma migrate dev --name add_client_errors
```

### 3. Mount route handlers

```typescript
// app/api/errors/route.ts
import { createErrorHandlers } from "@context-kit/error-tracker/server";
import { prisma } from "@/lib/prisma";

const handlers = createErrorHandlers({
  prisma,
  secretHeaderToken: process.env.ERROR_TRACKER_TOKEN,
  sourceMapDir: process.env.NODE_ENV === "production" ? ".next/static/chunks" : undefined,
  rateLimiter: { windowMs: 60_000, maxRequests: 100 },
});

export const POST = handlers.POST;
export const GET = handlers.GET;
```

### 4. Add ErrorBoundary and initialize tracking

```tsx
// app/providers.tsx
"use client";

import { createErrorTracker } from "@context-kit/error-tracker";
import { useEffect } from "react";

const tracker = createErrorTracker({
  endpoint: "/api/errors",
  token: process.env.NEXT_PUBLIC_ERROR_TRACKER_TOKEN,
});

// Re-export the pre-configured ErrorBoundary (config is pre-bound)
export const { ErrorBoundary } = tracker;

export function ErrorTrackerInit() {
  useEffect(() => {
    const cleanup = tracker.init();
    return cleanup;
  }, []);

  return null;
}
```

```tsx
// app/layout.tsx
import { ErrorBoundary, ErrorTrackerInit } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorTrackerInit />
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}
```

The `ErrorBoundary` returned by `createErrorTracker` has config pre-bound — you don't need to pass a `config` prop. If you want a custom fallback:

```tsx
<ErrorBoundary fallback={<div>Oops! Something broke.</div>}>
  {children}
</ErrorBoundary>

{/* Or with error details: */}
<ErrorBoundary fallback={(error) => <div>Error: {error.message}</div>}>
  {children}
</ErrorBoundary>
```

## API Reference

### `createErrorTracker(options?)`

Factory function that creates a configured error tracker instance.

```typescript
interface CreateErrorTrackerOptions {
  endpoint?: string;           // Default: "/api/errors"
  token?: string;              // Secret token sent to the server
  secretHeaderName?: string;   // Header name for the token (default: "x-error-tracker-token")
  environment?: string;        // Default: process.env.NODE_ENV ?? "development"
  patchConsoleError?: boolean; // Wrap console.error to report calls (default: false)
}
```

Returns:

```typescript
{
  init: () => () => void;        // Install global listeners; returns cleanup function
  ErrorBoundary: React.Component // Pre-configured ErrorBoundary (config is pre-bound)
}
```

### `createErrorHandlers(config)`

Factory function that creates Next.js App Router route handlers.

```typescript
interface ErrorHandlersConfig {
  prisma: PrismaClient;              // Your Prisma client instance
  secretHeaderName?: string;         // Header name for auth (default: "x-error-tracker-token")
  secretHeaderToken?: string;        // Expected token value; omit for open access (dev only)
  sourceMapDir?: string;             // Path to source maps (default: ".next/static/chunks")
  deduplicationWindowMs?: number;    // Dedup window in ms (default: 86400000 = 24 hours)
  rateLimiter?: {
    windowMs: number;                // Time window in ms
    maxRequests: number;             // Max requests per IP per window
  };
}
```

Returns:

```typescript
{
  POST: (request: Request) => Promise<Response>;  // Ingestion endpoint
  GET: (request: Request) => Promise<Response>;    // Query endpoint
}
```

### `ErrorBoundary`

React class component that catches render errors. When used via the factory (`createErrorTracker`), config is pre-bound. When used directly, pass `config` explicitly.

Props:
- `config?` — Error tracker configuration (pre-bound when created via factory)
- `fallback?` — `ReactNode` or `(error: Error) => ReactNode` (default: `<div>Something went wrong.</div>`)
- `children` — React elements to wrap

## Query API

The GET `/api/errors` endpoint supports filtering and offset-based pagination:

```typescript
const response = await fetch("/api/errors?env=production&resolved=false&limit=50&offset=0", {
  headers: { "x-error-tracker-token": "your-token" },
});

const { errors, total } = await response.json();
```

Query parameters:
- `env` — Filter by environment (`development`, `production`)
- `since` — ISO timestamp; return errors with `lastSeenAt >= since`
- `fingerprint` — Filter by exact fingerprint
- `resolved` — `"true"` or `"false"`; filter by resolution status
- `limit` — Results per page (default: 50, max: 200)
- `offset` — Number of results to skip (default: 0)

## Deduplication & Fingerprinting

Errors are deduplicated using a SHA-256 fingerprint computed from the error message and the first three stack frames (resolved frames preferred over minified):

```
SHA-256( message | file:line:col:fn | file:line:col:fn | file:line:col:fn )
```

When the same fingerprint appears within the deduplication window (default: 24 hours), the existing record's `occurrences` counter is incremented atomically instead of creating a new row.

**Resolved errors:** If an error was previously marked resolved (`resolvedAt` is set), a new occurrence with the same fingerprint creates a fresh record rather than reopening the old one.

**Fingerprint collisions:** Two distinct errors that share the same message and top-3 frames merge under one fingerprint. This is an acceptable tradeoff in v1. Query by fingerprint and inspect full stacks if you suspect a collision.

## CLI

Requires `DATABASE_URL` set in the environment and `@prisma/client` installed.

### Tail recent errors

```bash
npx error-tracker tail
npx error-tracker tail --limit 50
npx error-tracker tail --env production
npx error-tracker tail --since 2024-01-01T00:00:00Z
```

### Mark an error resolved

```bash
npx error-tracker resolve <fingerprint>
```

## Configuration Examples

### Production with auth and source maps

```typescript
// Server — app/api/errors/route.ts
const handlers = createErrorHandlers({
  prisma,
  secretHeaderToken: process.env.ERROR_TRACKER_TOKEN,
  sourceMapDir: ".next/static/chunks",
  rateLimiter: { windowMs: 60_000, maxRequests: 100 },
  deduplicationWindowMs: 86_400_000, // 24 hours
});

// Client — app/providers.tsx
const tracker = createErrorTracker({
  endpoint: "/api/errors",
  token: process.env.NEXT_PUBLIC_ERROR_TRACKER_TOKEN,
});
```

### Development with console patching

```typescript
const tracker = createErrorTracker({
  endpoint: "/api/errors",
  patchConsoleError: true,
});
```

### Custom header name

```typescript
// Both client and server must agree on the header name
const tracker = createErrorTracker({
  endpoint: "/api/errors",
  token: "my-token",
  secretHeaderName: "authorization",
});

const handlers = createErrorHandlers({
  prisma,
  secretHeaderName: "authorization",
  secretHeaderToken: "my-token",
});
```

## Environment Variables

```bash
# Server-side
ERROR_TRACKER_TOKEN=your-secret-token
DATABASE_URL=postgresql://...

# Client-side (exposed to browser)
NEXT_PUBLIC_ERROR_TRACKER_TOKEN=your-secret-token
```

When no token is configured, the ingestion endpoint accepts all requests (permissive default for local dev). In production, a console warning is emitted if `token` is not set.

## Further Reading

- [Source Map Resolution](docs/source-maps.md) — Next.js config, deployment requirements, caching, troubleshooting
- [SQL Recipes](docs/sql-recipes.md) — Copy-paste queries for debugging, aggregation, and maintenance
- [Architecture](docs/architecture.md) — Data flow, module responsibilities, and design decisions

## Testing

```bash
bun --filter @context-kit/error-tracker test
```

## License

MIT
