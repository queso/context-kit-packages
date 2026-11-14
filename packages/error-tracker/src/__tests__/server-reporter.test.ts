import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
// The module `Instrumentation` is declared in. Importing "next" itself would
// pull Next's global types into the program, which make NODE_ENV read-only.
import type { Instrumentation } from "next/dist/server/instrumentation/types";
import postgres from "postgres";
import { computeFingerprint } from "../server/ingestion";
import { parseFrames } from "../server/parse-stack";
import {
  createIngestionHandler,
  createServerErrorReporter,
  type ServerErrorReporterConfig,
} from "../server";
import {
  errorRequest,
  prepareTestDb,
  readClientErrors,
  readOnlyClientError,
  resetClientErrors,
  sqliteConfig,
} from "./helpers";

const SECRET = "sk_live_DO_NOT_STORE_7f3a9c";

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetClientErrors();
});

/** Swaps `console.error` for a collector until `restore()` is called. */
function captureErrorLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

let log: ReturnType<typeof captureErrorLog>;

beforeEach(() => {
  log = captureErrorLog();
});

afterEach(() => {
  log.restore();
});

/** The request and context objects Next.js 16 passes to `onRequestError`. */
function nextRequestArgs(overrides: {
  path?: string;
  method?: string;
  routePath?: string;
  routeType?: "render" | "route" | "action" | "proxy";
} = {}) {
  const request = {
    path: overrides.path ?? `/api/billing/webhook?token=${SECRET}`,
    method: overrides.method ?? "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      cookie: `session=${SECRET}; theme=dark`,
      "x-api-key": SECRET,
      "user-agent": "Stripe/1.0",
    },
  } as const;
  const context = {
    routerKind: "App Router",
    routePath: overrides.routePath ?? "/api/billing/webhook",
    routeType: overrides.routeType ?? "route",
    revalidateReason: undefined,
  } as const;
  return { request, context };
}

describe("redaction", () => {
  test("a secret in the failing request's header, cookie, query string and body is absent from the stored row", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());

    // A real route handler receiving a request that carries the secret in
    // every place a request can carry one, failing after reading the body.
    const incoming = new Request(
      `https://app.example.com/api/billing/webhook?token=${SECRET}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          cookie: `session=${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ apiKey: SECRET, event: "invoice.paid" }),
      }
    );
    async function POST(request: Request): Promise<Response> {
      const body = (await request.json()) as { event: string };
      throw new TypeError(`unhandled event type ${body.event}`);
    }

    let thrown: unknown;
    try {
      await POST(incoming);
    } catch (error) {
      thrown = error;
    }

    const { request, context } = nextRequestArgs();
    await reporter.onRequestError(thrown, request, context);

    // A caller that hands the whole request (or anything else) to
    // reportServerError gets only the documented fields stored.
    const careless = {
      tag: "stripe-webhook",
      route: `/api/billing/webhook?token=${SECRET}`,
      method: "POST",
      request: incoming,
      headers: { authorization: `Bearer ${SECRET}` },
      body: { apiKey: SECRET },
      env: { STRIPE_SECRET_KEY: SECRET },
    };
    await reporter.reportServerError(
      new Error("second failure"),
      careless as Parameters<typeof reporter.reportServerError>[1]
    );

    const rows = await readClientErrors();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe("server");
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(row.url).toBeNull();
      expect(row.userAgent).toBeNull();
    }
    expect(log.lines.join("\n")).not.toContain(SECRET);
  });

  test("an environment variable's value is not stored", async () => {
    const previous = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = SECRET;
    try {
      const reporter = createServerErrorReporter(sqliteConfig());
      await reporter.reportServerError(new Error("stripe call failed"), {
        tag: "billing",
      });
      const row = await readOnlyClientError();
      expect(JSON.stringify(row)).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previous;
    }
  });
});

describe("onRequestError", () => {
  test("is assignable to Next.js's Instrumentation.onRequestError", () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const hook: Instrumentation.onRequestError = reporter.onRequestError;
    expect(typeof hook).toBe("function");
  });

  test("stores name, message, stack, route pattern, method and route type with source server", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const error = new RangeError("plan limit exceeded");
    const { request, context } = nextRequestArgs({
      path: "/api/entitlements/acct_123?verbose=1",
      method: "get",
      routePath: "/api/entitlements/[account]",
      routeType: "route",
    });

    await reporter.onRequestError(error, request, context);

    const row = await readOnlyClientError();
    expect(row.source).toBe("server");
    expect(row.message).toBe("RangeError: plan limit exceeded");
    expect(row.stack).toBe(error.stack!);
    expect(row.route).toBe("/api/entitlements/[account]");
    expect(row.method).toBe("GET");
    expect(row.tag).toBe("route");
    expect(row.occurrences).toBe(1);
    expect(row.resolvedAt).toBeNull();
    expect(row.componentStack).toBeNull();
  });

  test("never stores the request path, which carries the concrete URL and its query string", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const { request, context } = nextRequestArgs({
      path: "/dashboard/acct_123?invite=abc",
      routePath: "/dashboard/[account]",
      routeType: "render",
    });

    await reporter.onRequestError(new Error("render failed"), request, context);

    const row = await readOnlyClientError();
    expect(JSON.stringify(row)).not.toContain("acct_123");
    expect(JSON.stringify(row)).not.toContain("invite");
    expect(row.route).toBe("/dashboard/[account]");
    expect(row.tag).toBe("render");
  });

  test("a second occurrence of the same error increments the counter", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const { request, context } = nextRequestArgs();
    const error = new Error("webhook signature mismatch");

    await reporter.onRequestError(error, request, context);
    await reporter.onRequestError(error, request, context);

    const row = await readOnlyClientError();
    expect(row.occurrences).toBe(2);
  });

  test("fingerprints with the same function browser reports use", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const error = new Error("boom");
    const { request, context } = nextRequestArgs();

    await reporter.onRequestError(error, request, context);

    const row = await readOnlyClientError();
    expect(row.fingerprint).toBe(
      computeFingerprint("Error: boom", parseFrames(error.stack!))
    );
  });

  test("reopens a resolved server error that happens again", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const { request, context } = nextRequestArgs();
    const error = new Error("reopen me");
    await reporter.onRequestError(error, request, context);

    const { createStore } = await import("../server/store");
    const store = createStore(sqliteConfig());
    const row = await readOnlyClientError();
    expect(await store.resolve(row.fingerprint)).toBe(1);

    await reporter.onRequestError(error, request, context);
    const reopened = await readOnlyClientError();
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.occurrences).toBe(2);
  });
});

describe("reportServerError", () => {
  test("stores the caller's tag, route and method", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(new Error("callback failed"), {
      tag: "github-webhook",
      route: "/api/webhooks/github",
      method: "post",
    });

    const row = await readOnlyClientError();
    expect(row.source).toBe("server");
    expect(row.tag).toBe("github-webhook");
    expect(row.route).toBe("/api/webhooks/github");
    expect(row.method).toBe("POST");
  });

  test("works with no context at all, for a background job", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(new Error("nightly sync failed"));

    const row = await readOnlyClientError();
    expect(row.source).toBe("server");
    expect(row.route).toBeNull();
    expect(row.method).toBeNull();
    expect(row.tag).toBeNull();
  });

  test("strips a query string or fragment from a caller-supplied route", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(new Error("x"), {
      route: "/api/callback?code=abc#frag",
    });
    expect((await readOnlyClientError()).route).toBe("/api/callback");
  });

  test("drops a method that is not an HTTP token", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(new Error("x"), {
      method: "GET /admin HTTP/1.1",
    });
    expect((await readOnlyClientError()).method).toBeNull();
  });

  test("caps message, stack, route and tag lengths", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const error = new Error("m".repeat(5_000));
    error.stack = `Error: ${"s".repeat(20_000)}`;
    await reporter.reportServerError(error, {
      route: `/${"r".repeat(5_000)}`,
      tag: "t".repeat(1_000),
    });

    const row = await readOnlyClientError();
    expect(row.message.length).toBe(2_000);
    expect(row.stack!.length).toBe(10_000);
    expect(row.route!.length).toBe(512);
    expect(row.tag!.length).toBe(128);
  });

  test("records a thrown non-Error value", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError("plain string thrown");
    await reporter.reportServerError({ code: 42 });

    const messages = (await readClientErrors()).map((row) => row.message).sort();
    expect(messages).toEqual(['Error: plain string thrown', 'Error: {"code":42}']);
  });

  test("survives an error whose properties throw when read", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const hostile = new Proxy(new Error("hostile"), {
      get() {
        throw new Error("getter exploded");
      },
    });

    await expect(reporter.reportServerError(hostile)).resolves.toBeUndefined();
  });

  test("uses the configured environment, falling back to NODE_ENV", async () => {
    await createServerErrorReporter({
      ...sqliteConfig(),
      environment: "staging",
    }).reportServerError(new Error("staged"));
    expect((await readOnlyClientError()).environment).toBe("staging");

    await resetClientErrors();
    await createServerErrorReporter(sqliteConfig()).reportServerError(
      new Error("defaulted")
    );
    expect((await readOnlyClientError()).environment).toBe(
      process.env.NODE_ENV ?? "development"
    );
  });

  test("shares the table and counter logic with browser reports, keeping each row's source", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(new Error("server side"));
    const POST = createIngestionHandler(sqliteConfig());
    const response = await POST(
      errorRequest({ message: "client side", stack: "Error: client side" })
    );
    expect(response.status).toBe(200);

    const sources = Object.fromEntries(
      (await readClientErrors()).map((row) => [row.message, row.source])
    );
    expect(sources).toEqual({
      "Error: server side": "server",
      "client side": "client",
    });
  });
});

describe("configuration", () => {
  test("throws at creation when no db is passed, like the route handler factories", () => {
    expect(() =>
      createServerErrorReporter({
        dialect: "sqlite",
      } as unknown as ServerErrorReporterConfig)
    ).toThrow(/Drizzle database instance is required/);
  });

  test("rejects a non-positive timeout at creation", () => {
    expect(() =>
      createServerErrorReporter({ ...sqliteConfig(), timeoutMs: 0 })
    ).toThrow(/timeoutMs/);
  });
});

/**
 * A Drizzle-shaped stand-in whose insert chain ends in `outcome()`, for the
 * failure modes a real driver cannot be made to produce on demand.
 */
function fakeDb(outcome: () => Promise<unknown>) {
  const chain = {
    values: () => chain,
    onConflictDoUpdate: () => chain,
    run: outcome,
  };
  return { insert: () => chain };
}

describe("a database that is down", () => {
  let client: ReturnType<typeof postgres>;

  afterEach(async () => {
    await client?.end({ timeout: 0 });
  });

  test("a refused connection resolves and logs one line per report", async () => {
    // Port 1 on loopback refuses connections, so this is the real driver
    // failing the way it does when Postgres is not running.
    client = postgres("postgres://nobody:nothing@127.0.0.1:1/none", {
      max: 1,
      connect_timeout: 2,
      onnotice: () => {},
    });
    const reporter = createServerErrorReporter({
      db: drizzle(client),
      dialect: "postgres",
      timeoutMs: 5_000,
    });

    const { request, context } = nextRequestArgs();
    await expect(
      reporter.onRequestError(new Error("lost"), request, context)
    ).resolves.toBeUndefined();
    await expect(
      reporter.reportServerError(new Error("lost too"))
    ).resolves.toBeUndefined();

    expect(log.lines).toHaveLength(2);
    for (const line of log.lines) {
      expect(line).toStartWith(
        "[error-tracker] failed to record server error: Error: connect ECONNREFUSED"
      );
      // Drizzle's wrapping error spells out the statement and its
      // parameters, which are the reported error's message and stack.
      expect(line).not.toContain("Failed query");
      expect(line).not.toContain("lost");
      expect(line).not.toContain("\n");
    }
  });

  test("logs the innermost cause of a wrapped driver error, on one line", async () => {
    const wrapped = new Error(`Failed query: insert ...\nparams: ${SECRET}`, {
      cause: new Error("outer", { cause: new Error("socket hang up\nat x") }),
    });
    const reporter = createServerErrorReporter({
      db: fakeDb(() => Promise.reject(wrapped)),
      dialect: "sqlite",
    });

    await reporter.reportServerError(new Error(SECRET));

    expect(log.lines).toEqual([
      "[error-tracker] failed to record server error: Error: socket hang up",
    ]);
  });

  test("a write that rejects synchronously inside the driver does not throw", async () => {
    const reporter = createServerErrorReporter({
      db: {
        insert() {
          throw new Error("driver exploded");
        },
      },
      dialect: "sqlite",
    });

    await expect(
      reporter.reportServerError(new Error("x"))
    ).resolves.toBeUndefined();
    expect(log.lines).toEqual([
      "[error-tracker] failed to record server error: Error: driver exploded",
    ]);
  });
});

describe("a database that hangs", () => {
  let server: Server;
  let sockets: Socket[] = [];
  let client: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    // Accepts the TCP connection and never answers, which is what a wedged
    // Postgres or a black-holed network path looks like to the driver.
    server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await client?.end({ timeout: 0 });
    client = undefined;
  });

  test("returns within the configured bound and logs one line", async () => {
    const { port } = server.address() as AddressInfo;
    client = postgres(`postgres://nobody:nothing@127.0.0.1:${port}/none`, {
      max: 1,
      connect_timeout: 30,
      onnotice: () => {},
    });
    const reporter = createServerErrorReporter({
      db: drizzle(client),
      dialect: "postgres",
      timeoutMs: 100,
    });

    const started = performance.now();
    await reporter.reportServerError(new Error("stuck"));
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1_000);
    expect(log.lines).toEqual([
      "[error-tracker] failed to record server error: no answer from the database within 100 ms; stopped waiting",
    ]);
  });

  test("defaults to a 2 second bound", async () => {
    const reporter = createServerErrorReporter({
      db: fakeDb(() => new Promise(() => {})),
      dialect: "sqlite",
    });

    const started = performance.now();
    await reporter.reportServerError(new Error("stuck"));
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("a write that fails after the bound neither logs again nor leaves an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const reporter = createServerErrorReporter({
        db: fakeDb(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("late failure")), 60)
            )
        ),
        dialect: "sqlite",
        timeoutMs: 20,
      });

      await reporter.reportServerError(new Error("slow"));
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(unhandled).toEqual([]);
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toContain("no answer from the database within 20 ms");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
