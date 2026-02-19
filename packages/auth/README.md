# @context-kit/auth

Authentication for [context-kit](https://github.com/queso/context-kit) projects, powered by [Better Auth](https://www.better-auth.com/) + Prisma.

Pre-configured for Next.js App Router. Install it, add your env vars, wire up a route handler, and you have auth.

## What You Get

- Email/password authentication (enabled by default)
- OAuth social providers (Google, GitHub, etc.)
- Session management with secure cookies
- Prisma adapter for user/session/account storage
- Server-side helpers for App Router (`getSession`, `getUser`)
- Route-protecting middleware with pattern matching
- Client-side React hooks via a separate entry point

## Planned

- `@context-kit/auth/plugins/org` -- Multi-tenancy with organizations, invites, and role-based access
- `@context-kit/auth/plugins/2fa` -- Two-factor authentication

## Installation

```bash
bun add @context-kit/auth
```

### Peer Dependencies

- `@prisma/client` >= 5.0.0
- `next` >= 14.0.0 (optional -- required for `getSession`/`getUser` and middleware)

## Environment Variables

Set these in your `.env` file:

```bash
BETTER_AUTH_SECRET=your-random-secret-here
BETTER_AUTH_URL=http://localhost:3000
```

Both are required. You can also pass them directly via the `secret` and `baseURL` config options, but environment variables are recommended.

## Prisma Schema

Better Auth requires specific models in your Prisma schema. Run the Better Auth CLI to generate them:

```bash
bunx @better-auth/cli generate
```

This adds the `User`, `Session`, `Account`, and `Verification` models to your schema. Then run your migrations:

```bash
bunx prisma migrate dev
```

See the [Better Auth Prisma docs](https://www.better-auth.com/docs/adapters/prisma) for full details.

## Quick Start

### 1. Create the Auth Instance

Create a shared auth instance in a server-only file (e.g., `lib/auth.ts`):

```ts
import { createAuth } from "@context-kit/auth";
import { prisma } from "./prisma"; // your PrismaClient instance

export const auth = createAuth({
  prisma,
  database: "postgresql", // must match your Prisma datasource
});
```

### 2. Wire Up the API Route Handler

Create a catch-all route at `app/api/auth/[...all]/route.ts`:

```ts
import { toNextJsHandler } from "@context-kit/auth";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
```

This exposes all Better Auth endpoints under `/api/auth/*`.

### 3. Read Sessions in Server Components

Use `getSession` or `getUser` in any Server Component or Route Handler:

```ts
import { getSession, getUser } from "@context-kit/auth";
import { auth } from "@/lib/auth";

export default async function DashboardPage() {
  const session = await getSession(auth);

  if (!session) {
    redirect("/sign-in");
  }

  return <h1>Welcome, {session.user.name}</h1>;
}
```

`getSession` returns a `SessionData` object with `user`, `session`, and `expiresAt` fields, or `null` if unauthenticated. `getUser` is a convenience wrapper that returns just the user object.

### 4. Protect Routes with Middleware

Create `middleware.ts` at your project root:

```ts
import { createAuthMiddleware } from "@context-kit/auth/middleware";
import { auth } from "@/lib/auth";

const middleware = createAuthMiddleware(auth, {
  protectedRoutes: ["/dashboard", "/settings", /^\/admin/],
  signInPath: "/sign-in", // default
});

export default middleware;
```

- Page requests from unauthenticated users are redirected to `signInPath`.
- API requests under protected routes receive a `401 Unauthorized` JSON response.
- Supports both string prefixes (`"/dashboard"` matches `/dashboard/anything`) and RegExp patterns.

### 5. Client-Side Auth (React)

Import from the `/client` entry point -- this is a separate bundle that includes React dependencies:

```ts
"use client";

import { createAuthClient } from "@context-kit/auth/client";

const authClient = createAuthClient();

export default function SignInButton() {
  const handleSignIn = async () => {
    await authClient.signIn.email({
      email: "user@example.com",
      password: "securepassword",
    });
  };

  return <button onClick={handleSignIn}>Sign In</button>;
}
```

`createAuthClient` is a direct re-export from `better-auth/react`. See the [Better Auth React docs](https://www.better-auth.com/docs/reference/react) for the full client API.

## Configuration Reference

The `createAuth` function accepts an `AuthConfig` object:

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `prisma` | `PrismaClient` | Yes | -- | Your Prisma client instance |
| `database` | `"postgresql" \| "mysql" \| "sqlite"` | Yes | -- | Must match your Prisma datasource provider |
| `secret` | `string` | No | `process.env.BETTER_AUTH_SECRET` | Auth secret for signing tokens |
| `baseURL` | `string` | No | `process.env.BETTER_AUTH_URL` | Base URL of your application |
| `sessionDuration` | `number` | No | `604800` (7 days) | Session expiration in seconds |
| `passwordRules` | `PasswordRules` | No | `{ minLength: 8, maxLength: 128 }` | Password validation rules |
| `socialProviders` | `SocialProviders` | No | -- | OAuth provider config (see below) |
| `sendResetPasswordEmail` | `(data) => Promise<void>` | No | -- | Callback to send password reset emails |
| `callbacks.onSignIn` | `(user) => Promise<void>` | No | -- | Called after successful sign-in |
| `callbacks.onSignOut` | `(userId) => Promise<void>` | No | -- | Called after sign-out |

### Social Providers

Configure OAuth providers by passing a `socialProviders` object. Each provider requires `clientId` and `clientSecret`:

```ts
const auth = createAuth({
  prisma,
  database: "postgresql",
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
});
```

Both `clientId` and `clientSecret` are validated at startup -- missing values throw immediately so you catch configuration errors early.

### Password Rules

Customize password validation:

```ts
const auth = createAuth({
  prisma,
  database: "postgresql",
  passwordRules: {
    minLength: 12,
    maxLength: 256,
  },
});
```

## Package Entry Points

| Import Path | Contents | Use In |
|-------------|----------|--------|
| `@context-kit/auth` | `createAuth`, `toNextJsHandler`, `getSession`, `getUser`, all types | Server Components, Route Handlers |
| `@context-kit/auth/client` | `createAuthClient` | Client Components (`"use client"`) |
| `@context-kit/auth/middleware` | `createAuthMiddleware`, `MiddlewareConfig` | Next.js Middleware |

## TypeScript Types

All types are exported from the main entry point:

```ts
import type {
  AuthConfig,
  AuthInstance,
  SessionData,
  MiddlewareConfig,
  PasswordRules,
  // Re-exports from better-auth
  BetterAuthPlugin,
  SocialProviders,
  User,
  Session,
} from "@context-kit/auth";
```

## Why Better Auth?

- TypeScript-first with full type safety
- Plugin architecture (2FA, organizations, roles) maps cleanly to our package model
- Prisma adapter out of the box
- Framework-agnostic core with first-class Next.js support
- Open source -- no vendor lock-in at the foundation layer

## License

MIT
