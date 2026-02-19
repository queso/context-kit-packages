import { describe, test, expect, mock } from "bun:test";
import type { AuthInstance, SessionData } from "../types";

// Factory: create a mock AuthInstance whose getSession resolves to a given value
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

// Fixture: a valid session
const fakeSessionData: SessionData = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    image: null,
  },
  session: {
    id: "session-1",
    userId: "user-1",
    token: "mock-token",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400 * 1000),
    ipAddress: null,
    userAgent: null,
  },
  expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
};

describe("createAuthMiddleware", () => {
  test("redirects unauthenticated page request to /sign-in", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard"],
    });

    const request = new Request("http://localhost:3000/dashboard");
    const response = await middleware(request);

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
  });

  test("returns 401 for unauthenticated API request to protected route", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/api/data"],
    });

    const request = new Request("http://localhost:3000/api/data");
    const response = await middleware(request);

    expect(response.status).toBe(401);
  });

  test("passes through authenticated request to protected route", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(fakeSessionData);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard"],
    });

    const request = new Request("http://localhost:3000/dashboard", {
      headers: { cookie: "better-auth.session_token=mock-token" },
    });
    const response = await middleware(request);

    // Should pass through (200 OK, not a redirect)
    expect(response.status).toBe(200);
  });

  test("passes through unprotected route regardless of auth state", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard"],
    });

    const request = new Request("http://localhost:3000/about");
    const response = await middleware(request);

    // Unprotected route should pass through without checking session
    expect(response.status).toBe(200);
  });

  test("uses custom signInPath for redirect", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard"],
      signInPath: "/login",
    });

    const request = new Request("http://localhost:3000/dashboard");
    const response = await middleware(request);

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/login");
  });

  test("matches multiple route patterns", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard", "/settings", "/api/private"],
    });

    // All protected routes should trigger protection
    const dashboardReq = new Request("http://localhost:3000/dashboard");
    const dashboardRes = await middleware(dashboardReq);
    expect(dashboardRes.status).toBe(302);

    const settingsReq = new Request("http://localhost:3000/settings");
    const settingsRes = await middleware(settingsReq);
    expect(settingsRes.status).toBe(302);

    const apiReq = new Request("http://localhost:3000/api/private");
    const apiRes = await middleware(apiReq);
    expect(apiRes.status).toBe(401);
  });
});
