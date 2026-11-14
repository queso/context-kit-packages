import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runResolve } from "../cli";
import * as schema from "../schema/postgres";
import {
  createIngestionHandler,
  createQueryHandler,
  createServerErrorReporter,
} from "../server";
import * as postgres010 from "./fixtures/schema-0.1.0-postgres";
import {
  captureConsole,
  errorRequest,
  ProcessExitError,
  queryRequest,
  stubProcessExit,
} from "./helpers";

const url = process.env.DATABASE_URL ?? "";
const hasPostgres = /^postgres(ql)?:/.test(url);

// Locally the suite skips when no Postgres is configured. CI sets
// REQUIRE_POSTGRES so a missing or malformed DATABASE_URL fails the job
// instead of letting it pass with the only Postgres test skipped.
if (process.env.REQUIRE_POSTGRES && !hasPostgres) {
  // The URL itself is deliberately not included: it may carry credentials, and
  // this message ends up in CI logs.
  throw new Error(
    "REQUIRE_POSTGRES is set but DATABASE_URL is missing or is not a postgres:// or postgresql:// URL"
  );
}

// Only created when a Postgres server is actually configured — importing this
// file without DATABASE_URL must not open a connection.
let client: ReturnType<typeof postgres> | undefined;

afterAll(async () => {
  await client?.end({ timeout: 5 });
});

/**
 * Connects and creates only this package's table. drizzle-kit's pushSchema
 * diffs the whole database against the schema it is given, so with another
 * package's tables present (the auth tests run first in CI's Postgres job) it
 * asks whether to drop them and fails without a TTY. Generating the migration
 * from an empty snapshot yields just the CREATE statements for
 * `client_error`; IF NOT EXISTS keeps reruns idempotent.
 */
async function connect() {
  client ??= postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  const { generateDrizzleJson, generateMigration } = await import(
    "drizzle-kit/api"
  );
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema)
  );
  for (const statement of statements) {
    await db.execute(
      sql.raw(
        statement
          .replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ")
          .replace(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS ")
      )
    );
  }
  return db;
}

/** A message no other run or test shares, so rows can be found and cleaned up. */
function uniqueMessage(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("postgres dialect", () => {
  test.skipIf(!hasPostgres)(
    "reports, resolves and reopens an error against Postgres",
    async () => {
      const db = await connect();

      // A run-specific message keeps this test's rows apart from anything else
      // in a shared database.
      const message = uniqueMessage("TypeError: pg");
      const stack = `${message}\n  at Component (app.js:1:100)`;
      const body = {
        message,
        stack,
        componentStack: "\n  at ErrorBoundary",
        url: "https://example.com/dashboard",
        userAgent: "Mozilla/5.0",
      };

      const config = { db, dialect: "postgres" as const };
      const POST = createIngestionHandler(config);
      const GET = createQueryHandler(config);

      const rowsFor = () =>
        db
          .select()
          .from(schema.clientError)
          .where(eq(schema.clientError.message, message));

      try {
        const first = await POST(errorRequest(body));
        expect(first.status).toBe(200);
        const { fingerprint } = (await first.json()) as { fingerprint: string };

        const second = await POST(errorRequest(body));
        expect(second.status).toBe(200);

        const afterTwo = await rowsFor();
        expect(afterTwo).toHaveLength(1);
        expect(afterTwo[0]?.fingerprint).toBe(fingerprint);
        expect(afterTwo[0]?.occurrences).toBe(2);
        expect(afterTwo[0]?.stack).toBe(stack);
        expect(afterTwo[0]?.lastSeenAt).toBeInstanceOf(Date);
        expect(afterTwo[0]?.resolvedAt).toBeNull();

        const queried = await GET(queryRequest({ fingerprint }));
        expect(queried.status).toBe(200);
        const queryBody = (await queried.json()) as {
          errors: { message: string; occurrences: number }[];
          total: number;
        };
        expect(queryBody.total).toBe(1);
        expect(queryBody.errors[0]?.message).toBe(message);
        expect(queryBody.errors[0]?.occurrences).toBe(2);

        const exit = stubProcessExit();
        const resolveRun = await captureConsole(() =>
          runResolve({ db, dialect: "postgres", fingerprint })
        );
        exit.restore();
        if (resolveRun.error && !(resolveRun.error instanceof ProcessExitError)) {
          throw resolveRun.error;
        }
        expect(exit.codes).toEqual([]);
        expect(resolveRun.out).toContain(
          `Resolved error with fingerprint: ${fingerprint}`
        );

        const afterResolve = await rowsFor();
        expect(afterResolve[0]?.resolvedAt).toBeInstanceOf(Date);

        // The same error happening again reopens the row rather than leaving it
        // resolved or starting a second one.
        const third = await POST(errorRequest(body));
        expect(third.status).toBe(200);

        const afterReopen = await rowsFor();
        expect(afterReopen).toHaveLength(1);
        expect(afterReopen[0]?.resolvedAt).toBeNull();
        expect(afterReopen[0]?.occurrences).toBe(3);
      } finally {
        await db
          .delete(schema.clientError)
          .where(eq(schema.clientError.message, message));
      }
    }
  );

  test.skipIf(!hasPostgres)(
    "records server errors against Postgres with source server and a counter",
    async () => {
      const db = await connect();
      const reporter = createServerErrorReporter({ db, dialect: "postgres" });
      const message = uniqueMessage("pg-server");
      const error = new Error(message);
      const rowsFor = () =>
        db
          .select()
          .from(schema.clientError)
          .where(eq(schema.clientError.message, `Error: ${message}`));

      try {
        await reporter.onRequestError(
          error,
          { path: "/api/x?token=secret", method: "POST", headers: {} },
          { routePath: "/api/x", routeType: "route" }
        );
        // Same route, so the same fingerprint: the route is part of it.
        await reporter.reportServerError(error, { tag: "job", route: "/api/x" });

        const rows = await rowsFor();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.source).toBe("server");
        expect(rows[0]?.route).toBe("/api/x");
        expect(rows[0]?.method).toBe("POST");
        expect(rows[0]?.tag).toBe("route");
        expect(rows[0]?.occurrences).toBe(2);

        const GET = createQueryHandler({ db, dialect: "postgres" });
        const response = await GET(
          queryRequest({ source: "server", fingerprint: rows[0]!.fingerprint })
        );
        const body = (await response.json()) as { total: number };
        expect(body.total).toBe(1);
      } finally {
        await db
          .delete(schema.clientError)
          .where(eq(schema.clientError.message, `Error: ${message}`));
      }
    }
  );

  test.skipIf(!hasPostgres)(
    "upgrading a 0.1.0 table is additive and existing rows read as client",
    async () => {
      // A schema of its own, so the 0.1.0 table never meets the current one
      // in `public`.
      const namespace = `et_upgrade_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const admin = await connect();
      await admin.execute(sql.raw(`CREATE SCHEMA "${namespace}"`));
      const scoped = postgres(url, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: namespace },
      });
      try {
        const db = drizzle(scoped);
        const { generateDrizzleJson, generateMigration } = await import(
          "drizzle-kit/api"
        );
        const run = async (statements: string[]) => {
          // drizzle-kit qualifies nothing for the default schema, so the
          // search_path decides where these land.
          for (const statement of statements) await db.execute(sql.raw(statement));
        };

        await run(
          await generateMigration(
            generateDrizzleJson({}),
            generateDrizzleJson(postgres010)
          )
        );
        await db.insert(postgres010.clientError).values({
          message: "written by 0.1.0",
          fingerprint: "fp-old",
          environment: "production",
          lastSeenAt: new Date(),
        });

        await run(
          await generateMigration(
            generateDrizzleJson(postgres010),
            generateDrizzleJson(schema)
          )
        );

        const [row] = await db.select().from(schema.clientError);
        expect(row?.message).toBe("written by 0.1.0");
        expect(row?.source).toBe("client");
        expect(row?.route).toBeNull();
      } finally {
        // The schema is dropped even if closing the scoped connection fails,
        // so a rerun against a shared database starts clean.
        try {
          await scoped.end({ timeout: 5 });
        } finally {
          await admin.execute(sql.raw(`DROP SCHEMA "${namespace}" CASCADE`));
        }
      }
    }
  );
});
