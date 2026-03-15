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
- **Stack assumptions:** Next.js App Router, Prisma, TypeScript
- **No Pages Router support** — Server Components, Server Actions, and Route Handlers only
- **Prisma-native:** packages extend the consumer's Prisma schema rather than using their own database layer

### Packages

| Package | Path | Status |
|---------|------|--------|
| `@context-kit/auth` | `packages/auth` | In progress — Better Auth + Prisma |
| `@context-kit/auth-ui` | `packages/auth-ui` | 0.1.0 — Auth UI components for Next.js App Router |
| `@context-kit/billing` | `packages/billing` | Planned — Stripe subscriptions |
| `@context-kit/billing-ui` | `packages/billing-ui` | 0.1.0 — Billing UI components for pricing and checkout |
| `@context-kit/error-tracker` | `packages/error-tracker` | 0.1.0 — Client-side error tracking for Next.js App Router |

## A(i)-Team Integration

This project uses the A(i)-Team plugin for PRD-driven development. Mission and board state is managed via the `ateam` CLI (`/Users/josh/go/bin/ateam`), which communicates with the API server at the URL set in `ATEAM_API_URL`.

### When to Use A(i)-Team

Use the A(i)-Team workflow when:
- Implementing features from a PRD document
- Working on multi-file changes that benefit from TDD
- Building features that need structured test → implement → review flow

### Commands

- `/ai-team:plan <prd-file>` - Decompose a PRD into tracked work items
- `/ai-team:run` - Execute the mission with parallel agents
- `/ai-team:status` - Check current progress
- `/ai-team:resume` - Resume an interrupted mission

### ateam CLI

The `ateam` CLI is the primary tool for mission and board operations. Key commands:

```bash
ateam missions-current          # get current mission
ateam missions <id>             # get mission details
ateam board                     # view the kanban board
ateam board-move <id> <stage>   # move an item to a stage
ateam board-claim <id>          # claim an item for work
ateam board-release <id>        # release a claimed item
ateam items <id>                # get item details
ateam missions-precheck         # run pre-mission checks
ateam missions-postcheck        # run post-mission checks
```

The CLI reads `ATEAM_PROJECT_ID` and `ATEAM_API_URL` from environment variables (set in `.claude/settings.local.json`).

### Workflow

1. Place your PRD in the `prd/` directory
2. Run `/ai-team:plan prd/your-feature.md`
3. Run `/ai-team:run` to execute

The A(i)-Team will:
- Break down the PRD into testable units
- Write tests first (TDD)
- Implement to pass tests
- Review each feature
- Probe for bugs
- Update documentation and commit

**Do NOT** work on PRD features directly without using `/ai-team:plan` first.
