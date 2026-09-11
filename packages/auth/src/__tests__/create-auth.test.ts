import { describe, test, expect } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { prepareTestDb, testDb, validConfig, setupEnvGuard } from "./helpers";

setupEnvGuard();

describe("createAuth", () => {
  test("returns an auth instance for a valid config", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(validConfig());
    expect(auth).toBeDefined();
    // Better Auth instances expose a handler and api
    expect(typeof auth.handler).toBe("function");
    expect(auth.api).toBeDefined();
  });

  test("throws a descriptive error when BETTER_AUTH_SECRET is missing", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(validConfig({ secret: undefined }))
    ).toThrow(/BETTER_AUTH_SECRET/i);
  });

  test("throws a descriptive error when BETTER_AUTH_URL is missing", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(validConfig({ baseURL: undefined }))
    ).toThrow(/BETTER_AUTH_URL/i);
  });

  test("throws a descriptive error when db is not provided", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(validConfig({ db: null as unknown as object }))
    ).toThrow(/db/i);
  });

  test("throws a descriptive error for an unsupported dialect", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(validConfig({ dialect: "mysql" as never }))
    ).toThrow(/sqlite[\s\S]*postgres/);
  });

  test("reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from environment", async () => {
    process.env.BETTER_AUTH_SECRET = "env-secret-at-least-32-chars-long!!";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const { createAuth } = await import("../create-auth");
    // Should not throw when env vars are set and no config override
    const auth = createAuth(validConfig({ secret: undefined, baseURL: undefined }));
    expect(auth).toBeDefined();
  });

  test("respects sessionDuration override", async () => {
    const { createAuth } = await import("../create-auth");
    // Should not throw — just verifies the config is accepted and instance created
    const auth = createAuth(validConfig({ sessionDuration: 3600 }));
    expect(auth).toBeDefined();
  });

  test("respects passwordRules override", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(
      validConfig({ passwordRules: { minLength: 12, maxLength: 64 } })
    );
    expect(auth).toBeDefined();
  });

  test("multiple createAuth calls do not conflict", async () => {
    const { createAuth } = await import("../create-auth");
    const auth1 = createAuth(validConfig({ baseURL: "http://app1.test" }));
    const auth2 = createAuth(validConfig({ baseURL: "http://app2.test" }));
    expect(auth1).toBeDefined();
    expect(auth2).toBeDefined();
    // Each call returns its own instance
    expect(auth1).not.toBe(auth2);
  });

  test("signs a user up and reads the session back through the consumer's db", async () => {
    await prepareTestDb();
    const { createAuth } = await import("../create-auth");
    const { user } = await import("../schema/sqlite");

    // Unique per run so an in-process retry cannot collide on the email unique index.
    const email = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

    const auth = createAuth(validConfig());
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

    // Reading through the same Proxy-wrapped instance proves the adapter wrote
    // to the db the consumer handed us, not to one of its own making.
    // Filtered by email rather than asserting on the whole table: the in-memory
    // db is a process-wide singleton, and other suites (handler.test.ts) sign up
    // through it too.
    const rows = await testDb.select().from(user);
    const created = rows.filter((row) => row.email === email);
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe("Test User");
  });

  test("works with a Drizzle instance created without a schema attached", async () => {
    // createAuth passes the package's own schema module to the adapter, so a
    // consumer's `drizzle(client)` with no `{ schema }` must still work. This
    // db is separate from `testDb` and deliberately has no schema attached.
    const { createAuth } = await import("../create-auth");
    const schema = await import("../schema/sqlite");
    const { pushSQLiteSchema } = await import("drizzle-kit/api");

    const schemalessDb = drizzle(createClient({ url: ":memory:" }));
    expect(Object.keys(schemalessDb._.fullSchema)).toHaveLength(0);
    const { apply } = await pushSQLiteSchema(
      schema,
      schemalessDb as Parameters<typeof pushSQLiteSchema>[1]
    );
    await apply();

    const email = `schemaless-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const auth = createAuth(validConfig({ db: schemalessDb }));
    const res = await auth.api.signUpEmail({
      body: { name: "Schemaless User", email, password: "password123" },
      asResponse: true,
    });
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie") ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe(email);

    const rows = await schemalessDb.select().from(schema.user);
    expect(rows.map((row) => row.email)).toEqual([email]);
  });
});
