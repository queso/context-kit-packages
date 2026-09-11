export {
  computeFingerprint,
  createIngestionHandler,
  type IngestionConfig,
} from "./server/ingestion.js";
export { createQueryHandler, type QueryConfig } from "./server/query.js";
export { createRateLimiter } from "./server/rate-limiter.js";
export { resolveStack } from "./server/source-map-resolver.js";
export type { DatabaseConfig, ErrorTrackerDialect } from "./types.js";

import { createIngestionHandler, MAX_BODY_BYTES } from "./server/ingestion.js";
import { createQueryHandler } from "./server/query.js";
import { createRateLimiter } from "./server/rate-limiter.js";
import { resolveStack } from "./server/source-map-resolver.js";
import type { DatabaseConfig } from "./types.js";

export interface ErrorHandlersConfig extends DatabaseConfig {
  secretHeaderName?: string;
  secretHeaderToken?: string;
  sourceMapDir?: string;
  rateLimiter?: { windowMs: number; maxRequests: number };
}

export function createErrorHandlers(config: ErrorHandlersConfig) {
  const {
    db,
    dialect,
    secretHeaderName,
    secretHeaderToken,
    sourceMapDir,
    rateLimiter: rateLimiterOptions,
  } = config;

  const ingestionHandler = createIngestionHandler({
    db,
    dialect,
    secretHeaderName,
    secretHeaderToken,
  });

  const queryHandler = createQueryHandler({
    db,
    dialect,
    secretHeaderName,
    secretHeaderToken,
  });

  const limiter = rateLimiterOptions
    ? createRateLimiter(rateLimiterOptions)
    : null;

  if (process.env.NODE_ENV === "production" && !secretHeaderToken) {
    console.warn(
      "[error-tracker] Warning: no secretHeaderToken configured. The ingestion and query endpoints accept unauthenticated requests. Set `secretHeaderToken` in production."
    );
  }

  async function POST(request: Request): Promise<Response> {
    // Rate limit check before anything else
    if (limiter) {
      const limitResponse = await limiter.check(request);
      if (limitResponse) return limitResponse;
    }

    // If sourceMapDir configured, resolve the stack before ingestion
    if (sourceMapDir) {
      // Reject an oversized body up front so this pre-resolution path cannot be
      // forced to parse a huge body before the ingestion handler gets a look.
      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }

      // Clone request so we can read body once for resolution, once for ingestion
      let body: Record<string, unknown>;
      try {
        body = await request.clone().json();
      } catch {
        // Let the ingestion handler deal with the parse error
        return ingestionHandler(request);
      }

      if (typeof body.stack === "string") {
        const resolvedStack = await resolveStack(body.stack, { sourceMapDir });
        // Rebuild request with resolved stack. The original content-length no
        // longer matches the re-serialized body, and a copied content-encoding
        // would make the ingestion handler try to decode plain JSON, so both
        // are dropped rather than copied from the original request.
        const newBody = { ...body, resolvedStack };
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        const newRequest = new Request(request.url, {
          method: request.method,
          headers,
          body: JSON.stringify(newBody),
        });
        return ingestionHandler(newRequest);
      }
    }

    return ingestionHandler(request);
  }

  async function GET(request: Request): Promise<Response> {
    return queryHandler(request);
  }

  return { POST, GET };
}
