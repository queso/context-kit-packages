export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  /** Caps how many distinct IPs the in-memory store tracks at once. */
  maxEntries?: number;
}

/** Default cap on distinct IPs tracked at once, absent an explicit `maxEntries`. */
const DEFAULT_MAX_ENTRIES = 10_000;

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
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const store = new Map<string, BucketEntry>();
  let lastCleanup = Date.now();
  const CLEANUP_INTERVAL = windowMs * 2; // Clean up every 2 windows

  function cleanup(now: number): void {
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;
    for (const [key, entry] of store) {
      if (now - entry.windowStart >= windowMs) {
        store.delete(key);
      }
    }
  }

  /**
   * Makes room for a new key when the store is at capacity. Sweeps expired
   * entries first (a flood of unique IPs can outrun the periodic `cleanup`
   * sweep above); if the store is still full, evicts the oldest-inserted
   * entry by Map iteration order rather than dropping the new request.
   */
  function evictIfNeeded(now: number): void {
    if (store.size < maxEntries) return;

    for (const [key, entry] of store) {
      if (now - entry.windowStart >= windowMs) {
        store.delete(key);
      }
    }

    if (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) {
        store.delete(oldestKey);
      }
    }
  }

  return {
    async check(request: Request): Promise<Response | null> {
      const ip = extractIp(request);
      const now = Date.now();

      cleanup(now);

      const entry = store.get(ip);

      if (!entry || now - entry.windowStart >= windowMs) {
        // New window. Only a genuinely new key can grow the store past
        // maxEntries, so only evict/sweep when this key is not already in it.
        if (!entry) {
          evictIfNeeded(now);
        }
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
