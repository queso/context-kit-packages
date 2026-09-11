import { betterAuth } from "better-auth";
import { drizzleAdapter, type DB } from "better-auth/adapters/drizzle";
import * as sqliteSchema from "./schema/sqlite";
import * as postgresSchema from "./schema/postgres";
import type { AuthConfig, AuthInstance } from "./types";

/**
 * Creates a configured Better Auth instance wired to Drizzle.
 *
 * Validates required configuration, reads env-var fallbacks for
 * BETTER_AUTH_SECRET and BETTER_AUTH_URL, and returns a ready-to-use
 * auth instance with email/password enabled by default.
 */
export function createAuth(config: AuthConfig): AuthInstance {
  if (!config.db) {
    throw new Error(
      'A Drizzle database instance is required. Pass your Drizzle db as the `db` option (e.g. `import { db } from "@/db"`).'
    );
  }

  if (config.dialect !== "sqlite" && config.dialect !== "postgres") {
    throw new Error(
      `Unsupported dialect "${config.dialect}". Expected "sqlite" or "postgres".`
    );
  }

  const secret = config.secret ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is required. Set it as an environment variable or pass `secret` in config."
    );
  }

  const baseURL = config.baseURL ?? process.env.BETTER_AUTH_URL;
  if (!baseURL) {
    throw new Error(
      "BETTER_AUTH_URL is required. Set it as an environment variable or pass `baseURL` in config."
    );
  }

  if (config.socialProviders) {
    for (const [name, provider] of Object.entries(config.socialProviders)) {
      if (!provider.clientId) {
        throw new Error(
          `Social provider "${name}" is missing a valid clientId. Provide a non-empty clientId.`
        );
      }
      if (!provider.clientSecret) {
        throw new Error(
          `Social provider "${name}" is missing a valid clientSecret. Provide a non-empty clientSecret.`
        );
      }
    }
  }

  const sessionDuration = config.sessionDuration ?? 604800; // 7 days
  if (sessionDuration <= 0) {
    throw new Error("sessionDuration must be a positive number of seconds.");
  }

  const minPasswordLength = config.passwordRules?.minLength ?? 8;
  const maxPasswordLength = config.passwordRules?.maxLength ?? 128;
  if (minPasswordLength > maxPasswordLength) {
    throw new Error(
      `passwordRules.minLength (${minPasswordLength}) cannot exceed maxLength (${maxPasswordLength}).`
    );
  }

  return betterAuth({
    // Drizzle instances are generic over the consumer's schema, so `db` is
    // typed as `object` in AuthConfig and narrowed to the adapter's DB here.
    // `schema` is passed explicitly so the adapter works even when the
    // consumer's Drizzle instance was created without a schema attached.
    database: drizzleAdapter(config.db as DB, {
      provider: config.dialect === "postgres" ? "pg" : "sqlite",
      schema: config.dialect === "postgres" ? postgresSchema : sqliteSchema,
    }),
    secret,
    baseURL,
    session: {
      expiresIn: sessionDuration,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength,
      maxPasswordLength,
      sendResetPassword: config.sendResetPasswordEmail
        ? async ({ user, url, token }) => {
            await config.sendResetPasswordEmail!({ user, url, token });
          }
        : undefined,
    },
    socialProviders: config.socialProviders,
  });
}
