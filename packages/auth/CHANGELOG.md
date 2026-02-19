# Changelog

All notable changes to `@context-kit/auth` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
