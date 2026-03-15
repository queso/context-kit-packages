export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

interface BucketEntry {
  count: number;
  windowStart: number;
}

export interface RateLimiter {
  check(request: Request): Promise<Response | null>;
}

function extractIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Use the first IP in a potentially comma-separated list
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

export function createRateLimiter(options?: RateLimiterOptions): RateLimiter {
  const windowMs = options?.windowMs ?? 60_000;
  const maxRequests = options?.maxRequests ?? 60;

  const store = new Map<string, BucketEntry>();

  return {
    async check(request: Request): Promise<Response | null> {
      const ip = extractIp(request);
      const now = Date.now();

      const entry = store.get(ip);

      if (!entry || now - entry.windowStart >= windowMs) {
        // New window
        store.set(ip, { count: 1, windowStart: now });
        return null;
      }

      if (entry.count < maxRequests) {
        entry.count++;
        return null;
      }

      // Rate limit exceeded
      const windowEnd = entry.windowStart + windowMs;
      const retryAfterMs = windowEnd - now;
      const retryAfterSecs = Math.ceil(retryAfterMs / 1000);

      return new Response(JSON.stringify({ error: "Too Many Requests" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSecs),
        },
      });
    },
  };
}
