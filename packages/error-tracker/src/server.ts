export {
  computeFingerprint,
  createIngestionHandler,
  type IngestionConfig,
} from "./server/ingestion.js";
export { createQueryHandler, type QueryConfig } from "./server/query.js";
export { createRateLimiter } from "./server/rate-limiter.js";
export { resolveStack } from "./server/source-map-resolver.js";
export type { DatabaseConfig, ErrorTrackerDialect } from "./types.js";

import { createIngestionHandler } from "./server/ingestion.js";
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

  async function POST(request: Request): Promise<Response> {
    // Rate limit check before anything else
    if (limiter) {
      const limitResponse = await limiter.check(request);
      if (limitResponse) return limitResponse;
    }

    // If sourceMapDir configured, resolve the stack before ingestion
    if (sourceMapDir) {
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
        // Rebuild request with resolved stack
        const newBody = { ...body, resolvedStack };
        const newRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
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
