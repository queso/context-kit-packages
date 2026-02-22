import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { AuthInstance, MiddlewareConfig } from "./types";

export type { MiddlewareConfig } from "./types";

/**
 * Creates a Next.js-compatible middleware function that protects routes
 * based on authentication status.
 *
 * Page requests from unauthenticated users are redirected to `signInPath`
 * with a `callbackUrl` query parameter set to the original pathname so the
 * sign-in page can redirect back after authentication.
 * API requests from unauthenticated users receive a 401 response.
 * Unprotected routes and authenticated requests pass through via
 * NextResponse.next() so Next.js headers and middleware chaining work
 * correctly.
 */
export function createAuthMiddleware(
  auth: AuthInstance,
  config: MiddlewareConfig
): (request: NextRequest) => Promise<NextResponse> {
  const { protectedRoutes, signInPath = "/sign-in" } = config;

  return async (request: NextRequest): Promise<NextResponse> => {
    const url = new URL(request.url);
    const { pathname } = url;

    // Check if this route is protected
    const isProtected = protectedRoutes.some((pattern) => {
      if (typeof pattern === "string") {
        return pathname.startsWith(pattern);
      }
      return pattern.test(pathname);
    });

    // Unprotected routes pass through immediately
    if (!isProtected) {
      return NextResponse.next();
    }

    // Check session for protected routes
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (session) {
      return NextResponse.next();
    }

    // Unauthenticated: API routes get 401, page routes get redirected
    if (pathname.startsWith("/api")) {
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    // Redirect to sign-in for page requests, preserving the original path
    // as callbackUrl so the sign-in page can redirect back after authentication.
    const redirectUrl = new URL(signInPath, url.origin);
    redirectUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(redirectUrl.toString(), 302);
  };
}
