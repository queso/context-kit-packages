import { describe, test, expect, mock } from "bun:test";
import type { AuthInstance } from "../types";

// Mock next/headers before importing the module under test
mock.module("next/headers", () => ({
  headers: () =>
    Promise.resolve(
      new Headers({ cookie: "better-auth.session_token=mock-token" })
    ),
}));

// Raw Better Auth response shape (before our transformation)
type RawSessionResponse = { user: typeof fakeUser; session: typeof fakeSession } | null;

// Factory: create a mock AuthInstance with a controllable getSession.
// sessionResponse should be the raw Better Auth shape, NOT the transformed SessionData.
function createMockAuth(
  sessionResponse: RawSessionResponse = null
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

// Raw Better Auth shape — expiresAt is a Date, not yet transformed to ISO string.
const fakeRawSession = {
  user: fakeUser,
  session: fakeSession,
};

describe("getSession", () => {
  test("returns session data when a valid session exists", async () => {
    const { getSession } = await import("../session");
    const auth = createMockAuth(fakeRawSession);
    const result = await getSession(auth);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe("user-1");
    expect(result!.session.id).toBe("session-1");
    expect(auth.api.getSession).toHaveBeenCalledTimes(1);
  });

  test("expiresAt is a string in the returned SessionData", async () => {
    const { getSession } = await import("../session");
    const auth = createMockAuth(fakeRawSession);
    const result = await getSession(auth);
    expect(result).not.toBeNull();
    // The Date from fakeSession must have been converted to an ISO string
    expect(typeof result!.expiresAt).toBe("string");
    expect(result!.expiresAt).toBe(fakeSession.expiresAt.toISOString());
  });

  test("expiresAt handles a pre-serialized string without throwing", async () => {
    // Simulates edge runtimes / JSON round-trips where expiresAt arrives as a string
    const { getSession } = await import("../session");
    const sessionWithStringDate = {
      user: fakeUser,
      session: { ...fakeSession, expiresAt: fakeSession.expiresAt.toISOString() as unknown as Date },
    };
    const auth = createMockAuth(sessionWithStringDate);
    const result = await getSession(auth);
    expect(result).not.toBeNull();
    expect(typeof result!.expiresAt).toBe("string");
    expect(result!.expiresAt).toBe(fakeSession.expiresAt.toISOString());
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
    const auth = createMockAuth(fakeRawSession);
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
