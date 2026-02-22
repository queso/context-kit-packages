# Changelog

All notable changes to `@context-kit/auth-ui` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-02-21

### Added

- AuthProvider context component with Better Auth client integration
- `useAuth` and `useSession` hooks for accessing auth state
- Authentication form components: SignIn, SignUp, ForgotPassword, ResetPassword
- Account management components: UserProfile, ChangePassword, SessionManagement
- UserButton component with avatar dropdown menu and sign-out action
- AuthGuard component for protecting routes with automatic redirect
- AuthRouter catch-all route component with configurable path mapping
- Pre-built page wrapper components with centered layout (SignInPage, SignUpPage, etc.)
- SocialButton component with built-in provider icons (Google, GitHub, Apple, Microsoft, Discord, Facebook, Twitter)
- UI primitives based on Radix UI: Button, Input, Label, Card, Avatar, Dialog, DropdownMenu, Form
- CLI scaffolding tool (`npx @context-kit/auth-ui init`) for generating route files
- CLI options: `--path` for route groups, `--providers` for OAuth, `--force` to overwrite
- TypeScript type exports: AuthUIContextValue, AuthClient, SessionData
- Tree-shakeable ESM bundle with three entry points: main, client, cli
- Zod-based form validation schemas
- Tailwind CSS styling with class-variance-authority and tailwind-merge
- 528 tests across 16 test files
