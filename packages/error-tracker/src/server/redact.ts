/**
 * Masks credential-shaped strings in text the server reporter stores. This is
 * a net for the common shapes, not a guarantee: a secret in any other form is
 * stored as it appears.
 */

const MASK = "[redacted]";

/**
 * The patterns `maskSecrets` replaces, in order. Each match becomes
 * `[redacted]`; for `Bearer`, the scheme word is kept.
 *
 * Prefixed keys must have at least 16 characters after the prefix, one of
 * them a digit, so identifiers such as `pk_user_roles_unique` (a constraint
 * name in a database error) are left alone.
 */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer <anything up to whitespace>`
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  // JSON Web Tokens: base64url header and payload, optional signature.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  // Stripe (sk_, rk_, pk_, whsec_) and GitHub (ghp_, gho_, ghu_, ghs_, ghr_,
  // github_pat_) keys.
  /\b(?:github_pat|whsec|sk|rk|pk|ghp|gho|ghu|ghs|ghr)_(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{16,}/g,
];

/** Replaces every `REDACTION_PATTERNS` match in `text` with `[redacted]`. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const pattern of REDACTION_PATTERNS) {
    masked = masked.replace(pattern, (match: string, scheme?: string) =>
      typeof scheme === "string" ? `${scheme} ${MASK}` : MASK
    );
  }
  return masked;
}
