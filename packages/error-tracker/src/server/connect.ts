/**
 * DATABASE_URL parsing and driver selection for the CLI.
 *
 * A Next.js app passes its own Drizzle instance to the server handlers, so this
 * file exists only for the CLI, which runs outside the app and has to open its
 * own connection. The parsing mirrors context-kit's `db/url.ts` so a
 * DATABASE_URL the app accepts is a DATABASE_URL the CLI accepts.
 *
 * Supported forms:
 *   sqlite:./data/dev.sqlite      relative file path
 *   sqlite:/abs/path.sqlite       absolute file path
 *   sqlite://./relative           URL-style with an authority slash pair
 *   sqlite::memory:               in-memory database
 *   postgres://user:pass@host/db  PostgreSQL (postgresql:// is accepted as an alias)
 */

import { resolve as resolvePath } from "node:path";
import * as postgresSchema from "../schema/postgres.js";
import * as sqliteSchema from "../schema/sqlite.js";
import type { ErrorTrackerDialect } from "../types.js";

export type ParsedDatabaseUrl =
  | { dialect: "sqlite"; path: string }
  | { dialect: "postgres"; url: string };

export const SUPPORTED_SCHEMES = [
  "sqlite:",
  "postgres:",
  "postgresql:",
] as const;

export const SQLITE_MEMORY_PATH = ":memory:";

export const UNSUPPORTED_SCHEME_MESSAGE =
  "DATABASE_URL must start with sqlite: (e.g. sqlite:./data/dev.sqlite) or postgres: / postgresql: (e.g. postgres://user:pass@host:5432/db)";

export interface DatabaseConnection {
  db: object;
  dialect: ErrorTrackerDialect;
  close(): Promise<void>;
}

function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
  return match ? match[1].toLowerCase() : "";
}

/** True when `url` uses one of the schemes this package can connect to. */
export function hasSupportedScheme(url: string): boolean {
  return (SUPPORTED_SCHEMES as readonly string[]).includes(schemeOf(url));
}

/** Parses a DATABASE_URL into a dialect plus the driver-specific target. */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  const scheme = schemeOf(url);

  if (scheme === "sqlite:") {
    let path = url.slice(scheme.length);
    // `sqlite://./relative` and `sqlite:///abs/path` carry an empty authority;
    // drop the slashes. Anything else after `//` is a host or credentials,
    // which SQLite cannot open: fail loudly instead of creating a stray local
    // file named after the host.
    if (path.startsWith("//")) {
      path = path.slice(2);
      if (
        !(
          path.startsWith("/") ||
          path.startsWith("./") ||
          path === SQLITE_MEMORY_PATH
        )
      ) {
        throw new Error(
          `${UNSUPPORTED_SCHEME_MESSAGE} (got scheme "${scheme}": sqlite: URLs point at a local file and cannot carry a host or credentials)`
        );
      }
    }
    if (path === "") {
      throw new Error(`${UNSUPPORTED_SCHEME_MESSAGE} (got an empty sqlite path)`);
    }
    return { dialect: "sqlite", path };
  }

  if (scheme === "postgres:" || scheme === "postgresql:") {
    return { dialect: "postgres", url };
  }

  // Echo only the scheme, never the full URL: it may carry credentials that
  // should not land in CLI output or CI logs.
  throw new Error(
    `${UNSUPPORTED_SCHEME_MESSAGE} (got scheme "${scheme || "<no scheme>"}")`
  );
}

async function connectSqlite(path: string): Promise<DatabaseConnection> {
  let createClient: typeof import("@libsql/client").createClient;
  let drizzle: typeof import("drizzle-orm/libsql").drizzle;
  try {
    ({ createClient } = await import("@libsql/client"));
    ({ drizzle } = await import("drizzle-orm/libsql"));
  } catch (err) {
    throw new Error(
      `A sqlite: DATABASE_URL needs the "@libsql/client" package. Install it with \`bun add @libsql/client\`. (${(err as Error).message})`
    );
  }

  const inMemory = path === SQLITE_MEMORY_PATH;
  // Relative paths are resolved against the working directory the CLI was run
  // from, which is what the app does with the same URL.
  const client = createClient({
    url: inMemory ? SQLITE_MEMORY_PATH : `file:${resolvePath(process.cwd(), path)}`,
  });
  const db = drizzle(client, { schema: sqliteSchema });

  return {
    db,
    dialect: "sqlite",
    async close() {
      client.close();
    },
  };
}

async function connectPostgres(url: string): Promise<DatabaseConnection> {
  // `postgres` is a CJS module with `export =`, so the dynamic-import namespace
  // carries the factory on `default` at runtime while its types describe the
  // factory itself. Accept either shape.
  type PostgresFactory = typeof import("postgres");
  let postgres: PostgresFactory;
  let drizzle: typeof import("drizzle-orm/postgres-js").drizzle;
  try {
    const mod = (await import("postgres")) as unknown as {
      default?: PostgresFactory;
    };
    postgres = mod.default ?? (mod as unknown as PostgresFactory);
    ({ drizzle } = await import("drizzle-orm/postgres-js"));
  } catch (err) {
    throw new Error(
      `A postgres: DATABASE_URL needs the "postgres" package. Install it with \`bun add postgres\`. (${(err as Error).message})`
    );
  }

  const client = postgres(url);
  const db = drizzle(client, { schema: postgresSchema });

  return {
    db,
    dialect: "postgres",
    async close() {
      await client.end();
    },
  };
}

/**
 * Opens a Drizzle instance for a DATABASE_URL. The caller owns the connection
 * and must `close()` it.
 */
export async function connectFromDatabaseUrl(
  url: string
): Promise<DatabaseConnection> {
  const parsed = parseDatabaseUrl(url);
  return parsed.dialect === "sqlite"
    ? connectSqlite(parsed.path)
    : connectPostgres(parsed.url);
}
