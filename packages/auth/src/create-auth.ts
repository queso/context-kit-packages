import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { AuthConfig, AuthInstance } from "./types";

/**
 * Creates a configured Better Auth instance wired to Prisma.
 *
 * Validates required configuration, reads env-var fallbacks for
 * BETTER_AUTH_SECRET and BETTER_AUTH_URL, and returns a ready-to-use
 * auth instance with email/password enabled by default.
 */
export function createAuth(config: AuthConfig): AuthInstance {
  if (!config.prisma) {
    throw new Error(
      "A Prisma client instance is required. Pass your PrismaClient as the `prisma` option."
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
  const minPasswordLength = config.passwordRules?.minLength ?? 8;
  const maxPasswordLength = config.passwordRules?.maxLength ?? 128;

  return betterAuth({
    database: prismaAdapter(config.prisma as any, {
      provider: config.database,
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
