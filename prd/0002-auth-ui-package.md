# PRD-0002: @context-kit/auth-ui

**Author:** Josh
**Date:** 2026-02-21
**Status:** Draft

## Problem Statement

Developers using `@context-kit/auth` get a fully functional auth backend in minutes, but still have to build every auth-related UI from scratch: sign-in forms, sign-up flows, forgot/reset password pages, user profile editing, session management, and password changes. This front-end work takes 4-8 hours per project, produces inconsistent results, and is the #1 reason auth "feels incomplete" in the context-kit experience. The auth PRD (0001) explicitly called this out as the highest-likelihood risk: "Package feels incomplete without forms."

## Business Context

Auth UI is the visible surface of authentication. The backend package handles the hard security work, but developers judge the experience by what they see. Every context-kit project rebuilds the same ~10 screens with the same form validation, the same error handling, and the same shadcn components. A drop-in `@context-kit/auth-ui` that matches the project's existing shadcn + Tailwind stack eliminates this duplication and makes the auth story complete end-to-end. This also validates the "layered packages" model: `auth` for the engine, `auth-ui` for the interface, independently versioned and adoptable.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Reduce time-to-working-auth-UI | Time from install to rendered sign-in page | <5 minutes |
| Cover the full auth lifecycle | Screens provided vs. screens developers build manually | 100% of common flows |
| Match consumer's existing stack | Dependencies beyond what context-kit already uses | 0 new UI dependencies |
| Style customization without friction | Ability to override every visual element via className | All components accept className overrides |

## User Stories

- **As a** context-kit developer, **I want** to render a sign-in page by importing a single component and passing my auth config **so that** I don't have to build forms, validation, and error handling myself.
- **As a** context-kit developer, **I want** to specify which social providers to show (e.g., Google, GitHub) by passing a `providers` prop **so that** the UI matches my auth backend configuration without coupling.
- **As a** context-kit developer, **I want** a user profile page component with password change and session management **so that** my users can manage their own accounts without me building those screens.
- **As a** context-kit developer, **I want** to customize the look of auth components using Tailwind classes **so that** they match my app's design without forking the package.
- **As a** context-kit developer, **I want** the auth UI to handle all form validation, loading states, and error messages **so that** I only need to configure and place the components, not manage form state.
- **As a** context-kit developer, **I want** the forgot/reset password flow to work end-to-end with proper form screens **so that** my users can recover their accounts without me building custom pages.
- **As a** context-kit developer, **I want** to run a single CLI command that scaffolds all auth route files into my Next.js app **so that** I get working pages instantly without manually creating route files.

## Scope

### In Scope

- **Sign In page component** — email/password form + configurable social provider buttons
- **Sign Up page component** — registration form with password rules validation
- **Forgot Password page component** — email input to request a password reset
- **Reset Password page component** — new password form (consumes token from URL)
- **User Profile component** — display and edit name, email, avatar
- **Change Password component** — current password + new password form
- **Session Management component** — list active sessions, revoke sessions
- **User Button component** — avatar dropdown with sign-out, link to profile
- **Auth Guard component** — client-side wrapper that redirects unauthenticated users
- **Social provider buttons** — rendered based on `providers` prop (not auto-detected)
- **Form validation** — client-side validation with zod schemas matching `@context-kit/auth` password rules
- **Error handling** — inline error messages for all failure states (wrong password, email taken, etc.)
- **Loading states** — button/form disabled states during submission
- **Tailwind + shadcn/ui styling** — uses shadcn primitives (`Input`, `Button`, `Card`, `Form`, `Avatar`, `DropdownMenu`)
- **className overrides** — every component accepts `className` and sub-component class overrides
- **Accessible** — WCAG 2.1 AA compliant, keyboard navigable, screen reader labels
- **CLI scaffolding** — `npx @context-kit/auth-ui init` generates thin route files into the consumer's `app/` directory
- **Catch-all route handler** — `<AuthRouter>` component for zero-config setup via a single `[...authPath]/page.tsx` file
- **Page-level components** — `<SignInPage>`, `<SignUpPage>`, etc. with centered card layout for use in scaffolded routes
- **Social provider icons** — bundled icon library with brand icons for supported providers (Google, GitHub, Apple, etc.)
- **Bundled shadcn/ui primitives** — package ships its own shadcn components so consumers don't need to install them separately

### Out of Scope

- **Headless/unstyled mode** — all components ship with shadcn/Tailwind styling; headless extraction is a future refactor if demand exists
- **Organization/team management UI** — depends on the org plugin (`@context-kit/auth/plugins/org`), separate PRD
- **Two-factor authentication setup UI** — depends on the 2FA plugin, separate PRD
- **Email verification UI** — Better Auth handles this via redirect; no custom screen needed
- **Theming system** — consumers override via Tailwind classes and CSS variables (shadcn's existing model), not a custom theme API
- **Server Components** — all auth-ui components are client components (`"use client"`) since they manage form state and call the auth client
- **Custom form library support** — react-hook-form only; not pluggable
- **Pages Router support** — App Router only, per project philosophy

## Requirements

### Functional Requirements

#### Auth Flow Components

1. `<SignIn>` shall render an email/password form with a submit button and optional social provider buttons.
2. `<SignIn>` shall accept a `providers` prop (array of provider names, e.g., `["google", "github"]`) and render a social button for each.
3. `<SignIn>` shall accept a `callbackUrl` prop specifying where to redirect after successful sign-in (defaults to `"/"`).
4. `<SignIn>` shall display inline error messages for invalid credentials, network failures, and validation errors.
5. `<SignUp>` shall render a registration form with name, email, password, and confirm password fields.
6. `<SignUp>` shall validate password against configurable rules (min length, max length) using a zod schema, showing errors before submission.
7. `<SignUp>` shall accept the same `providers` prop as `<SignIn>` for social sign-up.
8. `<ForgotPassword>` shall render an email input form that triggers the password reset flow via the auth client.
9. `<ForgotPassword>` shall display a success message after submission regardless of whether the email exists (to prevent user enumeration).
10. `<ResetPassword>` shall read the reset token from the URL (query param or path segment) and render a new password form.
11. `<ResetPassword>` shall validate the new password against the same rules as `<SignUp>` and display an error if the token is invalid or expired.

#### Account Management Components

12. `<UserProfile>` shall display the current user's name, email, and avatar (display-only), with inline editing for name and email.
13. `<ChangePassword>` shall render a form with current password, new password, and confirm new password fields.
14. `<ChangePassword>` shall validate that the new password meets password rules and that confirm matches.
15. `<SessionManagement>` shall list the user's active sessions with browser/device info and a "revoke" button for each.
16. `<SessionManagement>` shall highlight the current session and prevent revoking it without confirmation.

#### Utility Components

17. `<UserButton>` shall render the user's avatar; clicking it shall open a dropdown with the user's name, email, a link to profile/settings, and a sign-out button.
18. `<UserButton>` shall accept an `onSignOut` callback and a `profileUrl` prop.
19. `<AuthGuard>` shall wrap child components and redirect to a configurable sign-in path if the user is not authenticated, showing a loading state during the session check.

#### Route Scaffolding & Routing

20. The package shall provide a CLI command (`npx @context-kit/auth-ui init`) that generates Next.js route files into the consumer's `app/` directory.
21. The CLI shall scaffold the following route files, each as a one-line re-export of the corresponding page component:
    - `app/(auth)/sign-in/page.tsx` → `<SignInPage>`
    - `app/(auth)/sign-up/page.tsx` → `<SignUpPage>`
    - `app/(auth)/forgot-password/page.tsx` → `<ForgotPasswordPage>`
    - `app/(auth)/reset-password/page.tsx` → `<ResetPasswordPage>`
    - `app/(auth)/profile/page.tsx` → `<UserProfilePage>`
    - `app/(auth)/profile/password/page.tsx` → `<ChangePasswordPage>`
    - `app/(auth)/profile/sessions/page.tsx` → `<SessionManagementPage>`
22. The CLI shall auto-detect the consumer's existing route group structure (scanning `app/` for existing groups like `(marketing)`, `(dashboard)`) and suggest placement. It shall default to `(auth)` if no groups exist or the user accepts the default.
23. The CLI shall accept a `--path` flag to override the auto-detected route group.
23. The CLI shall accept a `--providers` flag (e.g., `--providers google,github`) to pre-configure the generated route files with social provider props.
24. The CLI shall not overwrite existing files without a `--force` flag and shall warn the user when files already exist.
26. The package shall export an `<AuthRouter>` catch-all component that reads path segments and renders the correct page component, for consumers who prefer a single `app/(auth)/[...authPath]/page.tsx` route file over individual routes.
27. `<AuthRouter>` shall accept a `pathMap` prop to customize route-to-component mappings (e.g., `{ "/login": "signIn", "/register": "signUp" }`), enabling custom URL paths without ejecting from the catch-all pattern.
26. Each form component (e.g., `<SignIn>`) shall be exported separately from its page wrapper (e.g., `<SignInPage>`) so consumers can compose forms into their own layouts.
27. Page components (`<SignInPage>`, `<SignUpPage>`, etc.) shall render a centered card layout suitable for full-page auth screens.

#### Social Provider Icons

28. The package shall bundle inline SVG icons for supported social providers: Google, GitHub, Apple, Microsoft, Discord, and X (Twitter).
29. Social provider buttons shall display the provider's brand icon alongside the provider name (e.g., icon + "Continue with Google").
30. Social provider buttons shall accept a `renderIcon` prop to override the default icon for a given provider.

#### Common Behavior

31. All form components shall use react-hook-form for state management and zod for validation.
32. All components shall use the package's bundled shadcn/ui primitives (`Button`, `Input`, `Card`, `Form`, `Label`, `Avatar`, `DropdownMenu`) — consumers do not need to install shadcn components separately.
33. All components shall accept a `className` prop that applies to the root element.
34. All components shall accept a `classNames` prop (object) for overriding styles on sub-elements (e.g., `classNames={{ card: "...", submitButton: "...", input: "..." }}`).
35. All form components shall disable the submit button and show a loading indicator during submission.
36. All components shall receive the auth client via a `baseURL` prop (passed to `createAuthClient` internally) or via a React context provider.

### Non-Functional Requirements

1. The package shall bundle its own shadcn/ui primitives as runtime dependencies (`@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`) so consumers do not need to install or configure shadcn separately.
2. The package shall be tree-shakeable — importing `<SignIn>` shall not bundle `<SessionManagement>`.
3. The package shall ship ESM only, matching `@context-kit/auth`.
4. All components shall be keyboard navigable and include proper ARIA labels (WCAG 2.1 AA).
5. All components shall work without JavaScript for initial render (SSR-compatible shell) but require JS for interactivity.
6. The package shall not make any auth API calls at import time — only when components mount or forms submit.

## Edge Cases & Error States

- **Social provider not configured on backend:** If a consumer passes `providers={["google"]}` but Google isn't configured in `createAuth`, the social sign-in attempt shall display an error from the auth API (not crash).
- **Expired reset token:** `<ResetPassword>` shall display "This link has expired. Request a new one." with a link back to `<ForgotPassword>`.
- **Account already exists (social sign-up):** If a user tries to sign up with Google but an account with that email already exists, the error from Better Auth shall be displayed inline.
- **Session revocation of current session:** `<SessionManagement>` shall show a confirmation dialog ("This will sign you out") before revoking the current session, then redirect to sign-in.
- **Network failure mid-submission:** All forms shall display a generic "Something went wrong. Please try again." error and re-enable the submit button.
- **Password rules mismatch:** If `<SignUp>` or `<ChangePassword>` is used without matching the backend's password rules, the server-side validation error shall be displayed (client-side validation is best-effort).
- **No user session (account management):** `<UserProfile>`, `<ChangePassword>`, and `<SessionManagement>` shall redirect to sign-in if rendered without an active session.
- **Avatar not set:** `<UserButton>` and `<UserProfile>` shall render initials (first letter of name) as fallback when no avatar URL exists.
- **CLI: no `app/` directory found:** The CLI shall detect the Next.js app directory (checking `app/`, `src/app/`) and error with a helpful message if neither exists.
- **CLI: existing route files:** The CLI shall list conflicting files and skip them unless `--force` is passed. It shall never silently overwrite.
- **CLI: no package.json found:** The CLI shall error with "Run this command from your Next.js project root."
- **Catch-all route with unknown path:** `<AuthRouter>` shall render a 404-style "Page not found" for unrecognized auth paths rather than crashing.

## Dependencies

- **@context-kit/auth** (`>=0.1.0`) — peer dependency for `createAuthClient` and types
- **react** (`>=18`) — peer dependency
- **next** (`>=14`) — peer dependency for `useRouter`, `Link`, `useSearchParams`
- **react-hook-form** (`^7`) — runtime dependency for form state
- **zod** (`^3`) — runtime dependency for validation schemas
- **@radix-ui/react-*** — runtime dependencies (bundled shadcn/ui primitives: dialog, dropdown-menu, avatar, label, slot)
- **class-variance-authority** — runtime dependency (shadcn variant system)
- **tailwind-merge** / **clsx** — runtime dependency for className merging
- **lucide-react** — runtime dependency for UI icons (spinner, eye/eye-off, check, etc.)

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bundled Radix version conflicts with consumer's Radix | Medium | Duplicate React trees, style inconsistencies | Use exact versions; document in README; test with common version ranges |
| Consumer's Tailwind config conflicts | Low | Class conflicts or missing utilities | Document required Tailwind config; components use standard utilities only |
| Better Auth API changes affect form behavior | Medium | Forms submit wrong data or mishandle responses | Pin to `better-auth ^1.x`; integration tests against auth client |
| CLI scaffolding feels like a code drop | Low | Philosophical conflict with "packages not code drops" | Generated files are one-line re-exports that delegate to the package; updates flow via `bun update`, not re-scaffolding |
| Social provider brand icons become outdated | Low | Visual inconsistency with provider branding | Inline SVGs are easy to update; accept `renderIcon` override |

### Resolved Questions

- [x] **shadcn bundling:** Package bundles its own shadcn/ui primitives. Consumers don't need to install shadcn separately. This avoids setup friction.
- [x] **Page layouts vs form cards:** Both. Form components (`<SignIn>`) are composable cards. Page components (`<SignInPage>`) wrap them in a centered full-page layout. CLI scaffolds route files pointing to page components.
- [x] **Social provider icons:** Bundled inline SVGs for major providers (Google, GitHub, Apple, Microsoft, Discord, X). `renderIcon` prop for custom overrides.

### Open Questions

All resolved.

- [x] **Avatar upload:** Display-only for now. Upload support is a future enhancement (requires file storage dependency).
- [x] **CLI route group detection:** CLI auto-detects existing route groups and suggests placement. Defaults to `(auth)`.
- [x] **Custom path mappings:** `<AuthRouter>` accepts a `pathMap` prop for custom URLs (e.g., `/login` → signIn).

## Phases

- **Phase 1 (this PRD):** Auth flow components (`SignIn`, `SignUp`, `ForgotPassword`, `ResetPassword`), utility components (`UserButton`, `AuthGuard`), account management (`UserProfile`, `ChangePassword`, `SessionManagement`).
- **Phase 2:** Organization management UI (invite members, role assignment, team switcher) — depends on org plugin.
- **Phase 3:** 2FA setup UI (QR code display, backup codes, verification input) — depends on 2FA plugin.
