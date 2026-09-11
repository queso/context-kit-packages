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
