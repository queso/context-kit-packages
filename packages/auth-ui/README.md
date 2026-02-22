# @context-kit/auth-ui

Pre-built authentication UI components for Next.js App Router, powered by [Better Auth](https://www.better-auth.com/) via `@context-kit/auth`.

## Installation

```bash
bun add @context-kit/auth-ui
# or
pnpm add @context-kit/auth-ui
# or
npm install @context-kit/auth-ui
```

### Peer Dependencies

- `react` >= 18
- `next` >= 14
- `@context-kit/auth` >= 0.1.0

## Quick Start

### 1. Add the AuthProvider

Wrap your application with `AuthProvider` in your root layout:

```tsx
// app/layout.tsx
import { AuthProvider } from "@context-kit/auth-ui/client";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider baseURL="/api/auth">
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
```

### 2. Scaffold auth routes with the CLI

The fastest way to set up routes:

```bash
npx @context-kit/auth-ui init
```

This generates page files under your `app/` directory for sign-in, sign-up, forgot-password, reset-password, profile, change-password, and session management.

**With options:**

```bash
npx @context-kit/auth-ui init --path "(auth)" --providers google,github
```

### 3. Or use AuthRouter for a single catch-all route

Instead of individual route files, use the `AuthRouter` component in a catch-all route:

```tsx
// app/auth/[...authPath]/page.tsx
import { AuthRouter } from "@context-kit/auth-ui";

export default function AuthPage({ params }: { params: { authPath: string[] } }) {
  return <AuthRouter params={params} />;
}
```

Default path mapping:

| Path | Component |
|------|-----------|
| `/sign-in` | SignIn |
| `/sign-up` | SignUp |
| `/forgot-password` | ForgotPassword |
| `/reset-password` | ResetPassword |
| `/profile` | UserProfile |
| `/profile/password` | ChangePassword |
| `/profile/sessions` | SessionManagement |

## Components

### Authentication Forms

| Component | Description |
|-----------|-------------|
| `SignIn` | Email/password sign-in with optional social OAuth buttons |
| `SignUp` | Registration form with email, name, and password |
| `ForgotPassword` | Request a password reset email |
| `ResetPassword` | Set a new password from a reset link |

### Account Management

| Component | Description |
|-----------|-------------|
| `UserProfile` | Edit name and email |
| `ChangePassword` | Update current password |
| `SessionManagement` | View active sessions, revoke sessions |

### Utility Components

| Component | Description |
|-----------|-------------|
| `UserButton` | Avatar dropdown with profile link and sign-out |
| `AuthGuard` | Wraps protected content; redirects unauthenticated users |
| `SocialButton` | OAuth sign-in button with provider icon |
| `AuthRouter` | Catch-all route that maps paths to page components |

### Page Components

Pre-wrapped versions of each form in a centered layout. Useful for standalone pages:

`SignInPage`, `SignUpPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `UserProfilePage`, `ChangePasswordPage`, `SessionManagementPage`

### Hooks

| Hook | Description |
|------|-------------|
| `useAuth()` | Returns the Better Auth client instance |
| `useSession()` | Returns `{ data, isPending, error }` for the current session |

Import hooks from the client entry point:

```tsx
import { useAuth, useSession } from "@context-kit/auth-ui/client";
```

## Social OAuth Providers

Pass a `providers` array to `SignIn` or `SignUp` to show social login buttons:

```tsx
<SignIn providers={["google", "github", "apple"]} />
```

Supported providers with built-in icons: Google, GitHub, Apple, Microsoft, Discord, Facebook, Twitter.

## Styling

Components use [Tailwind CSS](https://tailwindcss.com/) utility classes and are designed to work with shadcn/ui-style CSS variables (`--primary`, `--border`, `--destructive`, etc.). Each component accepts `className` and `classNames` props for targeted overrides.

## CLI Reference

```
npx @context-kit/auth-ui init [options]

Options:
  --path <group>       Route group path (e.g. "(auth)")
  --providers <list>   Comma-separated OAuth providers (e.g. "google,github")
  --force              Overwrite existing files
  --help, -h           Show help
```

## Entry Points

| Import Path | Contents |
|-------------|----------|
| `@context-kit/auth-ui` | All components, pages, types |
| `@context-kit/auth-ui/client` | AuthProvider, useAuth, useSession |
| `@context-kit/auth-ui/cli` | CLI scaffold function (programmatic use) |

## License

MIT
