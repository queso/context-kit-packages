# @context-kit/error-tracker

Client-side error tracking for context-kit projects. Automatically captures uncaught errors, render errors, and unhandled promise rejections, then reports them to your server for analysis and debugging.

## Features

- **Error Boundary** — React ErrorBoundary component that catches render errors
- **Global Error Listeners** — Captures `window.onerror` and `unhandledrejection` events
- **Client-side Reporter** — Fire-and-forget error reporting with loop prevention
- **Server Ingestion** — Route handlers for receiving and storing errors in Prisma
- **Error Query API** — Retrieve and filter stored errors with pagination
- **Source Map Resolution** — Resolve minified stack traces back to original source
- **Rate Limiting** — Protect your ingestion endpoint from abuse
- **Console Patching** — Optionally capture `console.error` calls
- **CLI Tool** — `npx error-tracker` commands for tailing and resolving errors

## Quick Start

### 1. Install the package

```bash
npm install @context-kit/error-tracker
# or
bun add @context-kit/error-tracker
```

### 2. Add Prisma schema

Extend your Prisma schema with the error-tracker model:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ... your other models ...

// Include the error-tracker schema
model ClientError {
  id            String   @id @default(cuid())
  message       String
  stack         String?
  resolvedStack String?
  componentStack String?
  url           String
  userAgent     String
  environment   String
  fingerprint   String   @unique
  count         Int      @default(1)
  lastSeen      DateTime @updatedAt
  createdAt     DateTime @default(now())

  @@index([environment])
  @@index([lastSeen])
}
```

Then run the migration:

```bash
bunx prisma migrate dev --name add_client_errors
```

### 3. Mount route handlers

Create a catch-all route for error tracking:

```typescript
// app/api/errors/route.ts
import { createErrorHandlers } from "@context-kit/error-tracker/server";
import { prisma } from "@/lib/prisma";

const handlers = createErrorHandlers({
  prisma,
  secretHeaderToken: process.env.ERROR_TRACKER_TOKEN,
  sourceMapDir: process.env.NODE_ENV === "production" ? ".next/static" : undefined,
  rateLimiter: { windowMs: 60000, maxRequests: 1000 },
});

export const POST = handlers.POST;
export const GET = handlers.GET;
```

### 4. Add ErrorBoundary to your layout

```tsx
// app/layout.tsx
import { createErrorTracker } from "@context-kit/error-tracker";

const tracker = createErrorTracker({
  endpoint: "/api/errors",
  token: process.env.NEXT_PUBLIC_ERROR_TRACKER_TOKEN,
  environment: process.env.NODE_ENV,
  patchConsoleError: true,
});

const { ErrorBoundary } = tracker;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}
```

### 5. Initialize error tracking in your app

```tsx
// app/layout.tsx (client component)
"use client";

import { createErrorTracker } from "@context-kit/error-tracker";
import { useEffect } from "react";

const tracker = createErrorTracker({
  endpoint: "/api/errors",
  token: process.env.NEXT_PUBLIC_ERROR_TRACKER_TOKEN,
  patchConsoleError: true,
});

export function ErrorTrackerInit() {
  useEffect(() => {
    const cleanup = tracker.init();
    return cleanup;
  }, []);

  return null;
}
```

## API Reference

### `createErrorTracker(options?)`

Factory function that sets up error tracking. Returns an object with `init` and `ErrorBoundary`.

#### Options

```typescript
interface CreateErrorTrackerOptions {
  endpoint?: string;           // Default: "/api/errors"
  token?: string;              // Secret token for authentication
  secretHeaderName?: string;   // Header name for token (default: "x-error-tracker-token")
  environment?: string;        // Default: process.env.NODE_ENV
  patchConsoleError?: boolean; // Default: false
}
```

#### Returns

```typescript
{
  init: () => () => void;      // Function to initialize listeners, returns cleanup
  ErrorBoundary: React.Component;  // ErrorBoundary component
}
```

### `createErrorHandlers(config)`

Factory function that creates POST and GET handlers for your route.

#### Config

```typescript
interface ErrorHandlersConfig {
  prisma: PrismaClient;              // Your Prisma client instance
  secretHeaderName?: string;         // Header name for auth (default: "x-error-tracker-token")
  secretHeaderToken?: string;        // Expected token value
  sourceMapDir?: string;             // Path to source maps (e.g., ".next/static")
  deduplicationWindowMs?: number;    // Dedup window (default: 3600000)
  rateLimiter?: {
    windowMs: number;                // Time window in ms
    maxRequests: number;             // Max requests per window
  };
}
```

#### Returns

```typescript
{
  POST: (request: Request) => Promise<Response>;  // POST /api/errors
  GET: (request: Request) => Promise<Response>;   // GET /api/errors
}
```

### `ErrorBoundary`

React component that catches render errors.

```tsx
<ErrorBoundary fallback={<ErrorFallback />}>
  <YourComponent />
</ErrorBoundary>
```

Props:
- `children`: React elements to wrap
- `fallback?`: Fallback UI (default: generic error message)
- `onError?`: Callback when error occurs

### `reportError(payload)`

Manually report an error to the server:

```typescript
import { reportError } from "@context-kit/error-tracker";

try {
  // ...
} catch (error) {
  reportError({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    url: window.location.href,
    userAgent: navigator.userAgent,
    environment: process.env.NODE_ENV || "development",
  });
}
```

## Query API

The GET `/api/errors` endpoint supports filtering and pagination:

```typescript
// Fetch errors
const response = await fetch("/api/errors?environment=production&limit=50&page=1", {
  headers: {
    "x-error-tracker-token": process.env.NEXT_PUBLIC_ERROR_TRACKER_TOKEN,
  },
});

const { errors, total, page } = await response.json();
```

Query parameters:
- `environment?: string` — Filter by environment
- `limit?: number` — Results per page (default: 50)
- `page?: number` — Page number (default: 1)

## CLI Usage

The `error-tracker` CLI command is automatically available after installation.

### Tail errors

```bash
npx error-tracker tail
# or with a secret token
npx error-tracker tail --token your-secret-token
```

### Resolve stack traces

```bash
npx error-tracker resolve --fingerprint abc123 --source-map-dir .next/static
```

Resolved stack traces are stored in the `resolvedStack` column and can be queried via the API.

## Configuration Examples

### Production with authentication

```typescript
const handlers = createErrorHandlers({
  prisma,
  secretHeaderToken: process.env.ERROR_TRACKER_TOKEN, // Must match client token
  sourceMapDir: ".next/static",
  rateLimiter: {
    windowMs: 60000,
    maxRequests: 1000,
  },
  deduplicationWindowMs: 3600000, // 1 hour
});
```

### Development with console patching

```typescript
const tracker = createErrorTracker({
  endpoint: "/api/errors",
  patchConsoleError: true, // Capture console.error calls
});
```

### Custom endpoint

```typescript
const tracker = createErrorTracker({
  endpoint: "/api/errors/custom",
  secretHeaderName: "authorization",
});
```

## Environment Variables

Set these in your `.env.local`:

```bash
# Client-side
NEXT_PUBLIC_ERROR_TRACKER_TOKEN=your-public-token
NEXT_PUBLIC_ERROR_TRACKER_ENDPOINT=/api/errors

# Server-side
ERROR_TRACKER_TOKEN=your-secret-token
```

## Testing

Run the test suite:

```bash
bun --filter @context-kit/error-tracker test
```

## License

MIT
