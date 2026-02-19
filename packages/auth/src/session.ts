import { headers } from "next/headers";
import type { AuthInstance, SessionData } from "./types";

/**
 * Returns the current session data from cookies, or null if unauthenticated.
 *
 * Reads the request headers via Next.js `headers()` and delegates to
 * Better Auth's `auth.api.getSession()`. Safe to call in Server Components
 * and Route Handlers — never throws on missing or expired sessions.
 */
export async function getSession(
  auth: AuthInstance
): Promise<SessionData | null> {
  const reqHeaders = await headers();
  const result = await auth.api.getSession({ headers: reqHeaders });
  if (!result) return null;
  return {
    user: result.user,
    session: result.session,
    expiresAt: result.session.expiresAt.toISOString(),
  };
}

/**
 * Returns the current authenticated user, or null if unauthenticated.
 *
 * Convenience wrapper over `getSession` — extracts just the user object.
 */
export async function getUser(
  auth: AuthInstance
): Promise<SessionData["user"] | null> {
  const session = await getSession(auth);
  return session?.user ?? null;
}
