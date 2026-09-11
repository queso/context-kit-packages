# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Bun workspace monorepo of official packages for [context-kit](https://github.com/queso/context-kit), an opinionated Next.js starter for AI-assisted development. Packages provide common SaaS functionality (auth, billing, etc.) that propagate fixes via version updates rather than code drops.

## Development

```bash
bun install                              # install all workspace deps
bun --filter @context-kit/auth build     # build the auth package (tsup)
bun --filter @context-kit/auth dev       # build in watch mode
bun --filter @context-kit/auth typecheck # type-check without emitting
bun --filter @context-kit/auth-ui build  # build the auth-ui package
bun --filter @context-kit/auth-ui test   # run auth-ui tests
```

## Architecture

- **Monorepo layout:** `packages/<name>/` — each directory is a separate npm package under the `@context-kit` scope
- **Stack assumptions:** Next.js App Router, Drizzle, TypeScript
- **No Pages Router support** — Server Components, Server Actions, and Route Handlers only
- **Drizzle-native:** packages export Drizzle schema modules the consumer re-exports from its own `db/schema/<dialect>.ts`; the consumer owns the migrations, so a package bump surfaces as a generated migration

### Packages

| Package | Path | Status |
|---------|------|--------|
| `@context-kit/auth` | `packages/auth` | 0.2.0 — Better Auth + Drizzle |
| `@context-kit/auth-ui` | `packages/auth-ui` | 0.1.0 — Auth UI components for Next.js App Router |
| `@context-kit/billing` | `packages/billing` | Planned — Stripe subscriptions |

## A(i)-Team Integration

This project uses the A(i)-Team plugin for PRD-driven development.

### When to Use A(i)-Team

Use the A(i)-Team workflow when:
- Implementing features from a PRD document
- Working on multi-file changes that benefit from TDD
- Building features that need structured test → implement → review flow

### Commands

- `/ateam plan <prd-file>` - Decompose a PRD into tracked work items
- `/ateam run` - Execute the mission with parallel agents
- `/ateam status` - Check current progress
- `/ateam resume` - Resume an interrupted mission

### Workflow

1. Place your PRD in the `prd/` directory
2. Run `/ateam plan prd/your-feature.md`
3. Run `/ateam run` to execute

The A(i)-Team will:
- Break down the PRD into testable units
- Write tests first (TDD)
- Implement to pass tests
- Review each feature
- Probe for bugs
- Update documentation and commit

**Do NOT** work on PRD features directly without using `/ateam plan` first.
