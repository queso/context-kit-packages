export { createIngestionHandler } from "./server/ingestion.js";
export { createQueryHandler } from "./server/query.js";
export { createRateLimiter } from "./server/rate-limiter.js";
export { resolveStack } from "./server/source-map-resolver.js";
export { computeFingerprint } from "./server/ingestion.js";

import { createIngestionHandler } from "./server/ingestion.js";
import { createQueryHandler } from "./server/query.js";
import { createRateLimiter } from "./server/rate-limiter.js";
import { resolveStack } from "./server/source-map-resolver.js";

export interface ErrorHandlersConfig {
  // biome-ignore lint/suspicious/noExplicitAny: Prisma client type varies per consumer
  prisma: any;
  secretHeaderName?: string;
  secretHeaderToken?: string;
  sourceMapDir?: string;
  deduplicationWindowMs?: number;
  rateLimiter?: { windowMs: number; maxRequests: number };
}

export function createErrorHandlers(config: ErrorHandlersConfig) {
  const {
    prisma,
    secretHeaderName,
    secretHeaderToken,
    sourceMapDir,
    deduplicationWindowMs,
    rateLimiter: rateLimiterOptions,
  } = config;

  const ingestionHandler = createIngestionHandler({
    prisma,
    secretHeaderName,
    secretHeaderToken,
    deduplicationWindowMs,
  });

  const queryHandler = createQueryHandler({
    prisma,
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
