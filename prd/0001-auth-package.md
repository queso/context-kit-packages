# PRD-0001: @context-kit/auth

**Author:** Josh
**Date:** 2026-02-19
**Status:** Draft

## Problem Statement

Developers starting a new context-kit project must manually wire up authentication every time: configuring Better Auth, writing the Prisma adapter glue, creating Next.js route handlers, building middleware for protected routes, and setting up client-side hooks. This setup takes 1-2 hours of repetitive boilerplate work per project and is error-prone (misconfigured sessions, missing CSRF protection, broken OAuth callbacks). There is no reusable package that provides working auth for the context-kit stack.

## Business Context

Authentication is table-stakes for every SaaS project. It's also the first thing a developer touches after scaffolding, so it sets the tone for the context-kit experience. If auth setup is painful, developers abandon the starter. A working `bun add @context-kit/auth` that "just works" makes context-kit dramatically more valuable as a starting point and validates the "packages, not code drops" model for future packages (billing, email, etc.).

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Adoption by context-kit projects | % of context-kit projects that install the package | >80% of new projects |
| Fast time-to-auth | Time from `bun add` to working login flow | <5 minutes |
| Stable foundation | Bug reports related to auth in context-kit projects | Fewer than ad-hoc setup |

## User Stories

- **As a** context-kit developer, **I want** to install a single package and have email/password auth working **so that** I can skip boilerplate and start building my app.
- **As a** context-kit developer, **I want** to add Google or GitHub OAuth by providing client credentials **so that** my users can sign in with their existing accounts.
- **As a** context-kit developer, **I want** server-side helpers to check auth in Server Components and Route Handlers **so that** I can protect pages and APIs without writing session logic.
- **As a** context-kit developer, **I want** middleware that redirects unauthenticated users **so that** I can protect entire route segments declaratively.
- **As a** context-kit developer, **I want** client-side hooks for session state **so that** I can build login/logout UI in client components.
- **As a** context-kit developer, **I want** to customize auth behavior (password rules, session duration, providers) without forking the package **so that** the package works for my specific app's needs.

## Scope

### In Scope

- Server-side auth instance factory pre-configured with Prisma adapter (`@context-kit/auth`)
- Email/password authentication (sign up, sign in, sign out, password reset)
- OAuth/social provider support (Google, GitHub, and generic OAuth — configurable by the consumer)
- Next.js App Router route handler (catch-all `/api/auth/[...all]`)
- Middleware helper for protecting routes by pattern
- Server-side session helpers (`getSession`, `getUser`) for Server Components and Route Handlers
- Client-side auth via Better Auth's built-in `createAuthClient` and hooks (`@context-kit/auth/client`), preserving plugin extensibility and automatic signal-based invalidation
- TypeScript types for all public APIs
- Configuration interface for overriding defaults (session duration, password rules, providers, callbacks)

### Out of Scope

- **UI components** (login form, sign-up form, user menu) — consumers build their own UI or we provide these in a separate `@context-kit/auth-ui` package later
- **Multi-tenancy / organizations** — planned as `@context-kit/auth/plugins/org` in a future PRD
- **Two-factor authentication** — planned as `@context-kit/auth/plugins/2fa` in a future PRD
- **Email sending** — the package accepts a callback for sending password reset emails but does not include an email provider; that's `@context-kit/email`
- **Prisma schema generation** — consumers run `npx @better-auth/cli generate` themselves; the package documents this but doesn't automate it
- **Pages Router support** — App Router only, per project philosophy

## Requirements

### Functional Requirements

1. The package shall export a `createAuth` function that accepts a configuration object and returns a configured Better Auth instance with the Prisma adapter.
2. The `createAuth` function shall accept the consumer's `PrismaClient` instance and database provider (`postgresql`, `mysql`, `sqlite`).
3. The package shall enable email/password authentication by default with sensible defaults (min 8 characters, scrypt hashing, 7-day sessions).
4. The package shall allow consumers to configure OAuth providers (Google, GitHub, or any provider supported by Better Auth) by passing provider credentials.
5. The package shall export a `toNextJsHandler` or equivalent that returns `GET` and `POST` handlers for use in a Next.js catch-all route (`/api/auth/[...all]/route.ts`).
6. The package shall export a `createAuthMiddleware` function that accepts route patterns to protect and redirects unauthenticated users to a configurable sign-in path.
7. The package shall export `getSession` and `getUser` server-side helpers that read the current session from cookies in Server Components and Route Handlers.
8. The `@context-kit/auth/client` entry point shall re-export Better Auth's `createAuthClient` (React) and its built-in hooks (`useSession`, sign-in, sign-up, sign-out, OAuth sign-in). Using Better Auth's native client preserves automatic signal-based cache invalidation across hooks and ensures future plugins (org, 2FA) extend the client automatically.
9. All configuration shall have sensible defaults so that a minimal setup (PrismaClient + env vars) produces a working auth system.
10. The package shall read `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` from environment variables, falling back to explicit config if provided.
11. The package shall allow consumers to pass a `sendResetPasswordEmail` callback for password reset flows.
12. All public APIs shall be fully typed with TypeScript, with types exported from the package.

### Non-Functional Requirements

1. The package shall have zero runtime dependencies beyond `better-auth` and peer dependencies (`@prisma/client`, `next`).
2. The package shall be tree-shakeable — unused entry points (`/client`, `/middleware`) shall not increase server or client bundle size.
3. The package shall ship ESM only (no CJS), matching context-kit's module strategy.
4. The package build output shall include source maps and declaration maps for debugging.
5. The package shall not expose or log secrets, tokens, or session data in error messages.

## Edge Cases & Error States

- **Missing env vars:** If `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL` is not set and not provided in config, `createAuth` shall throw a clear error at initialization time (not at request time).
- **PrismaClient not passed:** `createAuth` shall throw a descriptive error if no PrismaClient is provided.
- **OAuth misconfiguration:** If a social provider is configured without `clientId` or `clientSecret`, the error shall name the missing field and the provider.
- **Session expired:** `getSession` shall return `null` (not throw) for expired or missing sessions. Consumers check for `null`.
- **Middleware on API routes:** `createAuthMiddleware` shall not redirect API routes (they should return 401 instead). The middleware shall distinguish between page requests and API requests.
- **Multiple auth instances:** Creating multiple `createAuth` instances (e.g., in tests) shall not cause global state conflicts.

## Dependencies

- **better-auth** (`^1.4.18`) — core auth library, runtime dependency
- **@prisma/client** (`>=5.0.0`) — peer dependency, provided by consumer
- **next** (`>=14.0.0`) — optional peer dependency for middleware and route handlers
- **tsup** — build tool (dev only)
- **TypeScript** — type checking (dev only)

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Better Auth breaking changes | Medium | Package breaks on update | Pin to `^1.x`, test against new releases |
| Prisma version incompatibility | Low | Adapter fails | Broad peer dep range (`>=5.0.0`), CI matrix |
| Consumers need UI components | High | Package feels incomplete without forms | Document that UI is consumer-owned; plan `@context-kit/auth-ui` as follow-up |

### Open Questions

- [ ] Should the package re-export Better Auth's plugin types so consumers can extend with community plugins directly?
- [ ] Should `createAuthMiddleware` support a callback for custom authorization logic (role checks), or is pattern-based route protection sufficient for v0.1?
- [ ] What's the right default for session duration — 7 days (Better Auth default) or 30 days (common in SaaS)?
- [ ] Should the package include a `signOut` server action for use in Server Components, or leave that to the client?

## Phases

- **Phase 1 (this PRD):** Core auth — `createAuth`, route handler, `getSession`/`getUser`, middleware, client hooks. Email/password + OAuth.
- **Phase 2:** `@context-kit/auth/plugins/org` — multi-tenancy, organizations, invites, role-based access.
- **Phase 3:** `@context-kit/auth/plugins/2fa` — two-factor authentication.
