import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AuthConfig } from "../types";

// Minimal PrismaClient-shaped object for testing
const mockPrisma = { $connect: () => Promise.resolve() };

// Helper to build a minimal valid config
function validConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    prisma: mockPrisma,
    database: "postgresql",
    secret: "test-secret-at-least-32-chars-long!!",
    baseURL: "http://localhost:3000",
    ...overrides,
  };
}

// Store original env vars and restore after each test
let origSecret: string | undefined;
let origURL: string | undefined;

beforeEach(() => {
  origSecret = process.env.BETTER_AUTH_SECRET;
  origURL = process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
});

afterEach(() => {
  if (origSecret !== undefined) process.env.BETTER_AUTH_SECRET = origSecret;
  else delete process.env.BETTER_AUTH_SECRET;
  if (origURL !== undefined) process.env.BETTER_AUTH_URL = origURL;
  else delete process.env.BETTER_AUTH_URL;
});

describe("social provider configuration", () => {
  test("auth works with no social providers (omitted)", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(validConfig());
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  test("auth works with socialProviders explicitly undefined", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(validConfig({ socialProviders: undefined }));
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  test("google provider configured correctly via record", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(
      validConfig({
        socialProviders: {
          google: {
            clientId: "google-client-id",
            clientSecret: "google-client-secret",
          },
        },
      })
    );
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  test("missing clientId throws error naming the provider and field", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(
        validConfig({
          socialProviders: {
            google: {
              clientId: "",
              clientSecret: "google-client-secret",
            },
          },
        })
      )
    ).toThrow(/google.*clientId/i);
  });

  test("missing clientSecret throws error naming the provider and field", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(
        validConfig({
          socialProviders: {
            github: {
              clientId: "github-client-id",
              clientSecret: "",
            },
          },
        })
      )
    ).toThrow(/github.*clientSecret/i);
  });

  test("multiple providers can be configured simultaneously", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(
      validConfig({
        socialProviders: {
          google: {
            clientId: "google-client-id",
            clientSecret: "google-client-secret",
          },
          github: {
            clientId: "github-client-id",
            clientSecret: "github-client-secret",
          },
        },
      })
    );
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });
});
