export {
  computeFingerprint,
  createIngestionHandler,
  type IngestionConfig,
} from "./server/ingestion.js";
export { createQueryHandler, type QueryConfig } from "./server/query.js";
export { createRateLimiter } from "./server/rate-limiter.js";
export { resolveStack } from "./server/source-map-resolver.js";
export type { DatabaseConfig, ErrorTrackerDialect } from "./types.js";

import {
  createIngestionHandler,
  MAX_BODY_BYTES,
  readBodyWithCap,
} from "./server/ingestion.js";
import { createQueryHandler } from "./server/query.js";
import { createRateLimiter } from "./server/rate-limiter.js";
import { resolveStack } from "./server/source-map-resolver.js";
import type { DatabaseConfig } from "./types.js";

export interface ErrorHandlersConfig extends DatabaseConfig {
  secretHeaderName?: string;
  secretHeaderToken?: string;
  /**
   * Token required by the GET query endpoint. Defaults to `secretHeaderToken`
   * when not set. The ingestion token is commonly bundled into client
   * JavaScript (e.g. as `NEXT_PUBLIC_ERROR_TRACKER_TOKEN`) so it can accompany
   * browser-side error reports; set `queryHeaderToken` to a different,
   * server-only value so that browser-visible token cannot be used to read
   * stored errors back out.
   */
  queryHeaderToken?: string;
  sourceMapDir?: string;
  rateLimiter?: { windowMs: number; maxRequests: number };
}

export function createErrorHandlers(config: ErrorHandlersConfig) {
  const {
    db,
    dialect,
    secretHeaderName,
    secretHeaderToken,
    queryHeaderToken,
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
    secretHeaderToken: queryHeaderToken ?? secretHeaderToken,
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
      // Read the body once, capped, instead of request.clone().json(): a
      // missing or non-numeric content-length would otherwise skip the size
      // check entirely and let an arbitrarily large body be buffered and
      // parsed before the ingestion handler's own cap ever runs. This reads
      // `request` directly rather than a clone because cancelling a reader on
      // one branch of a cloned (tee'd) stream while the other branch is never
      // read can hang indefinitely; every path below rebuilds a fresh request
      // from the captured text instead of reusing the original.
      let capped: Awaited<ReturnType<typeof readBodyWithCap>>;
      try {
        capped = await readBodyWithCap(request, MAX_BODY_BYTES);
      } catch {
        // The body stream itself failed; there is no text left to hand the
        // ingestion handler, so answer the same way it would for a body it
        // could not read.
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (!capped.ok) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }

      const rebuild = () =>
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: capped.text,
        });

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(capped.text);
      } catch {
        // Let the ingestion handler deal with the parse error
        return ingestionHandler(rebuild());
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

      return ingestionHandler(rebuild());
    }

    return ingestionHandler(request);
  }

  async function GET(request: Request): Promise<Response> {
    // Rate limit check before anything else, same as POST.
    if (limiter) {
      const limitResponse = await limiter.check(request);
      if (limitResponse) return limitResponse;
    }

    return queryHandler(request);
  }

  return { POST, GET };
}
