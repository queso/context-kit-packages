import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { AuthInstance, SessionData } from "../types";

// Mock next/server before any middleware import so that the module is
// resolved without needing Next.js installed as a dependency. The stubs
// replicate the surface area that createAuthMiddleware uses.
beforeAll(() => {
  mock.module("next/server", () => {
    class MockNextResponse extends Response {
      static next() {
        return new MockNextResponse(null, { status: 200 });
      }

      static redirect(url: string, status: number) {
        return new MockNextResponse(null, {
          status,
          headers: { location: url },
        });
      }
    }

    return {
      NextResponse: MockNextResponse,
    };
  });
});

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
    const response = await middleware(request as never);

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
  });

  test("includes callbackUrl in redirect to sign-in", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard"],
    });

    const request = new Request("http://localhost:3000/dashboard");
    const response = await middleware(request as never);

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("callbackUrl=%2Fdashboard");
  });

  test("includes callbackUrl in redirect when using custom signInPath", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/settings"],
      signInPath: "/login",
    });

    const request = new Request("http://localhost:3000/settings");
    const response = await middleware(request as never);

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/login");
    expect(location).toContain("callbackUrl=%2Fsettings");
  });

  test("returns 401 for unauthenticated API request to protected route", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/api/data"],
    });

    const request = new Request("http://localhost:3000/api/data");
    const response = await middleware(request as never);

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
    const response = await middleware(request as never);

    // NextResponse.next() passes through (200, not a redirect)
    expect(response.status).toBe(200);
  });

  test("passes through unprotected route regardless of auth state", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      protectedRoutes: ["/dashboard"],
    });

    const request = new Request("http://localhost:3000/about");
    const response = await middleware(request as never);

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
    const response = await middleware(request as never);

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
    const dashboardRes = await middleware(dashboardReq as never);
    expect(dashboardRes.status).toBe(302);

    const settingsReq = new Request("http://localhost:3000/settings");
    const settingsRes = await middleware(settingsReq as never);
    expect(settingsRes.status).toBe(302);

    const apiReq = new Request("http://localhost:3000/api/private");
    const apiRes = await middleware(apiReq as never);
    expect(apiRes.status).toBe(401);
  });

  test("matches RegExp patterns in protectedRoutes", async () => {
    const { createAuthMiddleware } = await import("../middleware");
    const auth = createMockAuth(null);
    const middleware = createAuthMiddleware(auth, {
      // Protect any path under /admin or /org/*/settings
      protectedRoutes: [/^\/admin/, /^\/org\/[^/]+\/settings/],
    });

    // Paths matching the RegExp patterns should be protected
    const adminReq = new Request("http://localhost:3000/admin/users");
    const adminRes = await middleware(adminReq as never);
    expect(adminRes.status).toBe(302);

    const orgSettingsReq = new Request(
      "http://localhost:3000/org/acme/settings"
    );
    const orgSettingsRes = await middleware(orgSettingsReq as never);
    expect(orgSettingsRes.status).toBe(302);

    // A path that does not match any pattern should pass through
    const publicReq = new Request("http://localhost:3000/pricing");
    const publicRes = await middleware(publicReq as never);
    expect(publicRes.status).toBe(200);
  });
});
