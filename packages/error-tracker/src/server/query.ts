import type { DatabaseConfig } from "../types.js";
import { tokenMatches, warnIfUnauthenticated } from "./auth.js";
import { createStore, type ListFilters } from "./store.js";

export interface QueryConfig extends DatabaseConfig {
  secretHeaderName?: string;
  secretHeaderToken?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A missing, non-numeric, or sub-1 limit falls back to the default; the rest is capped. */
function parseLimit(raw: string | null): number {
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** A missing, non-numeric, or negative offset falls back to 0. */
function parseOffset(raw: string | null): number {
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function createQueryHandler(config: QueryConfig) {
  const {
    secretHeaderName = "x-error-tracker-token",
    secretHeaderToken,
  } = config;

  // Validates the database configuration up front so a misconfigured route
  // fails at module load rather than on the first request.
  const store = createStore(config);

  warnIfUnauthenticated("query", secretHeaderToken);

  return async function GET(request: Request): Promise<Response> {
    // Auth check
    if (secretHeaderName && secretHeaderToken) {
      const provided = request.headers.get(secretHeaderName);
      if (!tokenMatches(provided, secretHeaderToken)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const url = new URL(request.url);
    const params = url.searchParams;

    // Pagination
    const limit = parseLimit(params.get("limit"));
    const offset = parseOffset(params.get("offset"));

    const filters: ListFilters = {};

    const env = params.get("env");
    if (env) {
      filters.environment = env;
    }

    const since = params.get("since");
    if (since) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return Response.json(
          { error: "since must be an ISO 8601 date" },
          { status: 400 }
        );
      }
      filters.since = sinceDate;
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
