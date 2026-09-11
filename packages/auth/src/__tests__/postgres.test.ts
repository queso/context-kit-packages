import { describe, test, expect, afterAll } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../schema/postgres";
import { setupEnvGuard } from "./helpers";

setupEnvGuard();

const url = process.env.DATABASE_URL ?? "";
const hasPostgres = /^postgres(ql)?:/.test(url);

// Locally the suite skips when no Postgres is configured. CI sets
// REQUIRE_POSTGRES so a missing or malformed DATABASE_URL fails the job
// instead of letting it pass with the only Postgres test skipped.
if (process.env.REQUIRE_POSTGRES && !hasPostgres) {
  throw new Error(
    `REQUIRE_POSTGRES is set but DATABASE_URL is not a postgres:// URL (got ${JSON.stringify(url)})`
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
    "signs a user up and reads the session back against Postgres",
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

      const { createAuth } = await import("../create-auth");
      const email = `pg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}@example.com`;

      const auth = createAuth({
        db,
        dialect: "postgres",
        secret: "test-secret-at-least-32-chars-long!!",
        baseURL: "http://localhost:3000",
      });

      const res = await auth.api.signUpEmail({
        body: { name: "Test User", email, password: "password123" },
        asResponse: true,
      });
      expect(res.status).toBe(200);

      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).not.toBe("");

      const session = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      expect(session?.user.email).toBe(email);
      expect(session?.session.expiresAt).toBeInstanceOf(Date);

      const rows = await db.select().from(schema.user);
      const created = rows.filter((row) => row.email === email);
      expect(created).toHaveLength(1);
      expect(created[0]?.name).toBe("Test User");
    }
  );
});
