import type { betterAuth, BetterAuthPlugin, SocialProviders, User, Session } from "better-auth";

// Re-export Better Auth plugin types so consumers can extend without importing better-auth directly
export type { BetterAuthPlugin, SocialProviders, User, Session };

/**
 * Password strength rules for email/password authentication.
 */
export interface PasswordRules {
  /** Minimum password length. Defaults to 8. */
  minLength?: number;
  /** Maximum password length. Defaults to 128. */
  maxLength?: number;
}

/**
 * The database dialect the auth tables live in.
 */
export type AuthDialect = "sqlite" | "postgres";

/**
 * Configuration for the auth package, passed to `createAuth()`.
 *
 * Wraps Better Auth's options with a Drizzle-native interface.
 */
export interface AuthConfig {
  /**
   * Your app's Drizzle database instance — e.g. `import { db } from "@/db"`
   * in a context-kit app.
   *
   * Any Drizzle instance works (libsql, better-sqlite3, postgres-js,
   * node-postgres, ...). Typed as `object` because Drizzle's types are
   * generic over the consumer's schema.
   */
  db: object;

  /**
   * Which database `db` points at. In a context-kit app pass `getDialect()`
   * from `@/db` so the two cannot drift.
   */
  dialect: AuthDialect;

  /**
   * Session expiration duration in seconds.
   * @default 604800 (7 days)
   */
  sessionDuration?: number;

  /**
   * Password validation rules for email/password auth.
   */
  passwordRules?: PasswordRules;

  /**
   * Social OAuth provider configuration.
   *
   * Uses record-style config matching Better Auth's format:
   * @example
   * ```ts
   * socialProviders: {
   *   google: { clientId: "...", clientSecret: "..." },
   *   github: { clientId: "...", clientSecret: "..." },
   * }
   * ```
   */
  socialProviders?: SocialProviders;

  /**
   * Override for the BETTER_AUTH_SECRET environment variable.
   * If not set, Better Auth reads from process.env.BETTER_AUTH_SECRET.
   */
  secret?: string;

  /**
   * Override for the BETTER_AUTH_URL environment variable.
   * If not set, Better Auth reads from process.env.BETTER_AUTH_URL.
   */
  baseURL?: string;

  /**
   * Callback invoked when a password reset email should be sent.
   * @param data - The user, the reset URL, and the raw token.
   */
  sendResetPasswordEmail?: (data: {
    user: User;
    url: string;
    token: string;
  }) => Promise<void>;

}

/**
 * The configured auth instance returned by `createAuth()`.
 *
 * Preserves Better Auth's full generic type information so consumers
 * can access the complete typed API (e.g. `auth.api`, `auth.$Infer`).
 */
export type AuthInstance = ReturnType<typeof betterAuth>;

/**
 * Session data returned from session lookups.
 *
 * Combines Better Auth's Session and User models with an explicit expiry field.
 */
export interface SessionData {
  /** The authenticated user. */
  user: User;
  /** The session record from the database. */
  session: Session;
  /** ISO timestamp string at which this session expires. */
  expiresAt: string;
}

/**
 * Configuration for the Next.js middleware that protects routes.
 *
 * v0.1 supports pattern-based route matching only.
 */
export interface MiddlewareConfig {
  /**
   * Array of route path patterns to protect.
   * Unauthenticated requests to these paths are redirected to `signInPath`.
   *
   * Supports string prefixes or RegExp patterns.
   * @example ["/dashboard", "/settings", /^\/admin/]
   */
  protectedRoutes: Array<string | RegExp>;

  /**
   * The path to redirect unauthenticated users to.
   * @default "/sign-in"
   */
  signInPath?: string;
}
