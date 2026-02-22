import { afterEach, beforeEach } from "bun:test";
import type { AuthConfig } from "../types";

// Minimal PrismaClient-shaped object for testing
export const mockPrisma = { $connect: () => Promise.resolve() };

// Helper to build a minimal valid config
export function validConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    prisma: mockPrisma,
    database: "postgresql",
    secret: "test-secret-at-least-32-chars-long!!",
    baseURL: "http://localhost:3000",
    ...overrides,
  };
}

// Store original env vars and restore after each test
export function setupEnvGuard(): void {
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
}
