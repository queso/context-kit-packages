export interface QueryConfig {
  // biome-ignore lint/suspicious/noExplicitAny: Prisma client type varies per consumer
  prisma: any;
  secretHeaderName?: string;
  secretHeaderToken?: string;
}

export function createQueryHandler(config: QueryConfig) {
  const {
    prisma,
    secretHeaderName = "x-error-tracker-token",
    secretHeaderToken,
  } = config;

  return async function GET(request: Request): Promise<Response> {
    // Auth check
    if (secretHeaderName && secretHeaderToken) {
      const provided = request.headers.get(secretHeaderName);
      if (provided !== secretHeaderToken) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const url = new URL(request.url);
    const params = url.searchParams;

    // Pagination
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 200);
    const offset = parseInt(params.get("offset") ?? "0", 10);

    // Build where clause
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma where
    const where: Record<string, any> = {};

    const env = params.get("env");
    if (env) {
      where.environment = env;
    }

    const since = params.get("since");
    if (since) {
      where.lastSeenAt = { gte: new Date(since) };
    }

    const fingerprint = params.get("fingerprint");
    if (fingerprint) {
      where.fingerprint = fingerprint;
    }

    const resolved = params.get("resolved");
    if (resolved === "false") {
      where.resolvedAt = null;
    } else if (resolved === "true") {
      where.resolvedAt = { not: null };
    }

    const [errors, total] = await Promise.all([
      prisma.clientError.findMany({
        where,
        orderBy: { lastSeenAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.clientError.count({ where }),
    ]);

    return Response.json({ errors, total });
  };
}
