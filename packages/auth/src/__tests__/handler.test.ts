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

describe("toNextJsHandler", () => {
  test("returns an object with GET and POST functions", async () => {
    const { createAuth } = await import("../create-auth");
    const { toNextJsHandler } = await import("../handler");
    const auth = createAuth(validConfig());
    const handlers = toNextJsHandler(auth);

    expect(handlers).toBeDefined();
    expect(typeof handlers.GET).toBe("function");
    expect(typeof handlers.POST).toBe("function");
  });

  test("GET handler is callable and returns a Response", async () => {
    const { createAuth } = await import("../create-auth");
    const { toNextJsHandler } = await import("../handler");
    const auth = createAuth(validConfig());
    const { GET } = toNextJsHandler(auth);

    const request = new Request("http://localhost:3000/api/auth/session");
    const response = await GET(request);
    expect(response).toBeInstanceOf(Response);
  });

  test("POST handler is callable and returns a Response", async () => {
    const { createAuth } = await import("../create-auth");
    const { toNextJsHandler } = await import("../handler");
    const auth = createAuth(validConfig());
    const { POST } = toNextJsHandler(auth);

    const request = new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        password: "test-password-123",
        name: "Test User",
      }),
    });
    const response = await POST(request);
    expect(response).toBeInstanceOf(Response);
  });
});
