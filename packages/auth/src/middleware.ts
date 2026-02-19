import type { AuthInstance, MiddlewareConfig } from "./types";

export type { MiddlewareConfig } from "./types";

/**
 * Creates a Next.js-compatible middleware function that protects routes
 * based on authentication status.
 *
 * Page requests from unauthenticated users are redirected to `signInPath`.
 * API requests from unauthenticated users receive a 401 response.
 * Unprotected routes and authenticated requests pass through.
 */
export function createAuthMiddleware(
  auth: AuthInstance,
  config: MiddlewareConfig
): (request: Request) => Promise<Response> {
  const { protectedRoutes, signInPath = "/sign-in" } = config;

  return async (request: Request): Promise<Response> => {
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
      return new Response(null, { status: 200 });
    }

    // Check session for protected routes
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (session) {
      return new Response(null, { status: 200 });
    }

    // Unauthenticated: API routes get 401, page routes get redirected
    if (pathname.startsWith("/api")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    // Redirect to sign-in for page requests
    const redirectUrl = new URL(signInPath, url.origin);
    return Response.redirect(redirectUrl.toString(), 302);
  };
}
