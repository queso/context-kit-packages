import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a request's token against the configured secret without leaking
 * timing information. Hashing both sides first means the comparison buffers
 * are always the same length, so timingSafeEqual never throws on a
 * length mismatch and the digest itself, not the raw token, is compared.
 */
export function tokenMatches(
  provided: string | null,
  expected: string
): boolean {
  if (provided === null) return false;

  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Warns once, at handler-creation time, when a standalone ingestion or query
 * handler is created in production without a token configured. Both
 * `createIngestionHandler` and `createQueryHandler` are exported as drop-in
 * route handlers, so a consumer who mounts one directly (not through
 * `createErrorHandlers`) would otherwise get a public endpoint with no signal.
 */
export function warnIfUnauthenticated(
  endpoint: "ingestion" | "query",
  token: string | undefined
): void {
  if (process.env.NODE_ENV === "production" && !token) {
    console.warn(
      `[error-tracker] Warning: no secretHeaderToken configured. The ${endpoint} endpoint accepts unauthenticated requests. Set \`secretHeaderToken\` in production.`
    );
  }
}
