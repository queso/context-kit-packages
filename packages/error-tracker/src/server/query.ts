import type { DatabaseConfig } from "../types.js";
import { createStore, type ListFilters } from "./store.js";

export interface QueryConfig extends DatabaseConfig {
  secretHeaderName?: string;
  secretHeaderToken?: string;
}

export function createQueryHandler(config: QueryConfig) {
  const {
    secretHeaderName = "x-error-tracker-token",
    secretHeaderToken,
  } = config;

  // Validates the database configuration up front so a misconfigured route
  // fails at module load rather than on the first request.
  const store = createStore(config);

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

    const filters: ListFilters = {};

    const env = params.get("env");
    if (env) {
      filters.environment = env;
    }

    const since = params.get("since");
    if (since) {
      filters.since = new Date(since);
    }

    const fingerprint = params.get("fingerprint");
    if (fingerprint) {
      filters.fingerprint = fingerprint;
    }

    const resolved = params.get("resolved");
    if (resolved === "false") {
      filters.resolved = false;
    } else if (resolved === "true") {
      filters.resolved = true;
    }

    const { errors, total } = await store.list({ filters, limit, offset });

    return Response.json({ errors, total });
  };
}
