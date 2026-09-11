import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runResolve } from "../cli";
import * as schema from "../schema/postgres";
import { createIngestionHandler, createQueryHandler } from "../server";
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

describe("postgres dialect", () => {
  test.skipIf(!hasPostgres)(
    "reports, resolves and reopens an error against Postgres",
    async () => {
      client = postgres(url, { max: 1 });
      const db = drizzle(client, { schema });

      const { pushSchema } = await import("drizzle-kit/api");
      // drizzle-kit's pushSchema reads `result.rows` off every `execute()`, but
      // postgres-js returns the rows array directly. Hand it a shim that puts
      // the rows back where it looks for them.
      const pushTarget = {
        execute: async (query: unknown) => ({
          rows: await db.execute(query as never),
        }),
      };
      const { apply } = await pushSchema(
        schema,
        pushTarget as unknown as Parameters<typeof pushSchema>[1]
      );
      await apply();

      // A run-specific message keeps this test's rows apart from anything else
      // in a shared database.
      const message = `TypeError: pg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
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
});
