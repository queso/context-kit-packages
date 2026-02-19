import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AuthInstance, SessionData } from "../types";

// Mock next/headers before importing the module under test
mock.module("next/headers", () => ({
  headers: () =>
    Promise.resolve(
      new Headers({ cookie: "better-auth.session_token=mock-token" })
    ),
}));

// Factory: create a mock AuthInstance with a controllable getSession
function createMockAuth(
  sessionResponse: SessionData | null = null
): AuthInstance {
  return {
    api: {
      getSession: mock((_opts: { headers: Headers }) =>
        Promise.resolve(sessionResponse)
      ),
    },
    handler: mock(),
  } as unknown as AuthInstance;
}

// Fixtures
const fakeUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  image: null,
};

const fakeSession = {
  id: "session-1",
  userId: "user-1",
  token: "mock-token",
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 86400 * 1000),
  ipAddress: null,
  userAgent: null,
};

const fakeSessionData: SessionData = {
  user: fakeUser,
  session: fakeSession,
  expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
};

describe("getSession", () => {
  test("returns session data when a valid session exists", async () => {
    const { getSession } = await import("../session");
    const auth = createMockAuth(fakeSessionData);
    const result = await getSession(auth);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe("user-1");
    expect(result!.session.id).toBe("session-1");
    expect(auth.api.getSession).toHaveBeenCalledTimes(1);
  });

  test("returns null when no session exists", async () => {
    const { getSession } = await import("../session");
    const auth = createMockAuth(null);
    const result = await getSession(auth);
    expect(result).toBeNull();
  });

  test("does not throw on missing cookies", async () => {
    // Mock headers returning empty headers (no cookie)
    mock.module("next/headers", () => ({
      headers: () => Promise.resolve(new Headers()),
    }));
    const { getSession } = await import("../session");
    const auth = createMockAuth(null);
    // Should resolve to null, not throw
    const result = await getSession(auth);
    expect(result).toBeNull();
    // Restore cookie header for subsequent tests
    mock.module("next/headers", () => ({
      headers: () =>
        Promise.resolve(
          new Headers({ cookie: "better-auth.session_token=mock-token" })
        ),
    }));
  });
});

describe("getUser", () => {
  test("returns the user object when a session exists", async () => {
    const { getUser } = await import("../session");
    const auth = createMockAuth(fakeSessionData);
    const user = await getUser(auth);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("user-1");
    expect(user!.email).toBe("test@example.com");
  });

  test("returns null when no session exists", async () => {
    const { getUser } = await import("../session");
    const auth = createMockAuth(null);
    const user = await getUser(auth);
    expect(user).toBeNull();
  });
});
