import { describe, expect, test } from "bun:test";
import { setupEnvGuard, validConfig } from "./helpers";

setupEnvGuard();

describe("createAuth", () => {
  test("returns an auth instance for a valid config", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(validConfig());
    expect(auth).toBeDefined();
    // Better Auth instances expose a handler and api
    expect(typeof auth.handler).toBe("function");
    expect(auth.api).toBeDefined();
  });

  test("throws a descriptive error when BETTER_AUTH_SECRET is missing", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() => createAuth(validConfig({ secret: undefined }))).toThrow(
      /BETTER_AUTH_SECRET/i
    );
  });

  test("throws a descriptive error when BETTER_AUTH_URL is missing", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() => createAuth(validConfig({ baseURL: undefined }))).toThrow(
      /BETTER_AUTH_URL/i
    );
  });

  test("throws a descriptive error when prisma is not provided", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() => createAuth(validConfig({ prisma: null }))).toThrow(/prisma/i);
  });

  test("reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from environment", async () => {
    process.env.BETTER_AUTH_SECRET = "env-secret-at-least-32-chars-long!!";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const { createAuth } = await import("../create-auth");
    // Should not throw when env vars are set and no config override
    const auth = createAuth(
      validConfig({ secret: undefined, baseURL: undefined })
    );
    expect(auth).toBeDefined();
  });

  test("respects sessionDuration override", async () => {
    const { createAuth } = await import("../create-auth");
    // Should not throw — just verifies the config is accepted and instance created
    const auth = createAuth(validConfig({ sessionDuration: 3600 }));
    expect(auth).toBeDefined();
  });

  test("respects passwordRules override", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(
      validConfig({ passwordRules: { minLength: 12, maxLength: 64 } })
    );
    expect(auth).toBeDefined();
  });

  test("multiple createAuth calls do not conflict", async () => {
    const { createAuth } = await import("../create-auth");
    const auth1 = createAuth(validConfig({ baseURL: "http://app1.test" }));
    const auth2 = createAuth(validConfig({ baseURL: "http://app2.test" }));
    expect(auth1).toBeDefined();
    expect(auth2).toBeDefined();
    // Each call returns its own instance
    expect(auth1).not.toBe(auth2);
  });
});
