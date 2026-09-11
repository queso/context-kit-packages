# context-kit-packages

Official packages for [context-kit](https://github.com/queso/context-kit), the opinionated Next.js starter built for AI-assisted development.

These packages are designed to be installed into a context-kit project (or any Next.js + Drizzle stack on SQLite or PostgreSQL) and provide common SaaS functionality with a "fix once, inherit everywhere" model. Update a package version and every project gets the fix.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`@context-kit/auth`](./packages/auth) | Authentication powered by Better Auth with Drizzle, pre-configured for Next.js App Router | 0.2.0 |
| [`@context-kit/auth-ui`](./packages/auth-ui) | Pre-built auth UI components for Next.js App Router (forms, pages, router, CLI) | 0.1.0 |
| `@context-kit/billing` | Stripe subscription management, webhook handling, and plan gating | Planned |

## Philosophy

- **Packages, not code drops.** Bug fixes and improvements propagate to every project via `bun update`.
- **Opinionated defaults, escape hatches available.** Each package works out of the box with context-kit conventions but can be configured for different setups.
- **Drizzle-native.** Packages ship Drizzle schema modules you spread into your own `db/schema`; migrations stay app-owned, so a package bump shows up as a generated migration.
- **App Router first.** Server Components, Server Actions, Route Handlers. No Pages Router support.

## Future Packages

| Package | Description |
|---------|-------------|
| `@context-kit/email` | Transactional email with React Email + Resend (or any provider) |
| `@context-kit/analytics` | Privacy-friendly analytics (Plausible, PostHog, or similar) |
| `@context-kit/rate-limit` | Rate limiting middleware for API routes |
| `@context-kit/error-tracking` | Error tracking integration (Sentry, etc.) |
| `@context-kit/feature-flags` | Feature flag management for gradual rollouts |

## Development

This is a Bun workspace monorepo.

```bash
bun install
```

## License

MIT
