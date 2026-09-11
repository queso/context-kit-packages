import { describe, test, expect } from "bun:test";
import type {
  AuthConfig,
  AuthDialect,
  AuthInstance,
  SessionData,
  MiddlewareConfig,
  PasswordRules,
} from "../types";

describe("types are importable and structurally sound", () => {
  test("AuthConfig accepts a valid config shape", () => {
    const config: AuthConfig = {
      db: {},
      dialect: "sqlite",
    };
    expect(config.dialect).toBe("sqlite");
  });

  test("AuthConfig accepts optional fields", () => {
    const config: AuthConfig = {
      db: {},
      dialect: "postgres",
      sessionDuration: 3600,
      secret: "test-secret",
      baseURL: "http://localhost:3000",
      passwordRules: { minLength: 12, maxLength: 64 },
      socialProviders: {
        google: { clientId: "gid", clientSecret: "gsecret" },
        github: { clientId: "ghid", clientSecret: "ghsecret" },
      },
      sendResetPasswordEmail: async (_data) => {},
    };
    expect(config.sessionDuration).toBe(3600);
    expect(config.passwordRules?.minLength).toBe(12);
  });

  test("MiddlewareConfig accepts string and RegExp route patterns", () => {
    const mwConfig: MiddlewareConfig = {
      protectedRoutes: ["/dashboard", "/settings", /^\/admin/],
      signInPath: "/sign-in",
    };
    expect(mwConfig.protectedRoutes).toHaveLength(3);
    expect(mwConfig.signInPath).toBe("/sign-in");
  });

  test("AuthDialect accepts both supported dialects", () => {
    const sqlite: AuthDialect = "sqlite";
    const postgres: AuthDialect = "postgres";
    const dialects: AuthDialect[] = [sqlite, postgres];
    expect(dialects).toEqual(["sqlite", "postgres"]);
  });
});
