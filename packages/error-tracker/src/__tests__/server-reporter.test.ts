import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
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
import { DrizzleQueryError, sql } from "drizzle-orm";
import { parseFrames } from "../server/parse-stack";
import { createBreaker } from "../server/server-reporter";
import {
  computeServerFingerprint,
  createIngestionHandler,
  createServerErrorReporter,
  maskSecrets,
  REDACTION_PATTERNS,
  type ServerErrorReporterConfig,
} from "../server";
import {
  errorRequest,
  prepareTestDb,
  readClientErrors,
  readOnlyClientError,
  resetClientErrors,
  sqliteConfig,
  testDb,
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

  test("fingerprints with the server fingerprint, not the browser one", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const error = new Error("boom");
    const { request, context } = nextRequestArgs();

    await reporter.onRequestError(error, request, context);

    const row = await readOnlyClientError();
    expect(row.fingerprint).toBe(
      computeServerFingerprint(
        "Error",
        "boom",
        "/api/billing/webhook",
        parseFrames(error.stack!)
      )
    );
    expect(row.fingerprint).not.toBe(
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
    await reporter.reportServerError(42);

    const messages = (await readClientErrors()).map((row) => row.message).sort();
    expect(messages).toEqual(["Error: 42", "Error: plain string thrown"]);
  });

  test("a thrown plain object is stored by its keys, never its values", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError({
      code: 502,
      request: { headers: { authorization: `Bearer ${SECRET}` } },
      body: { password: SECRET },
    });

    const row = await readOnlyClientError();
    expect(row.message).toBe(
      "Error: non-Error object thrown with keys: code, request, body"
    );
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain("502");
  });

  test("a thrown array or null is described by its type", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError([SECRET]);
    await reporter.reportServerError(null);
    const messages = (await readClientErrors()).map((row) => row.message).sort();
    expect(messages).toEqual([
      "Error: non-Error array thrown",
      "Error: null thrown",
    ]);
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

    // The second failure in a row is not logged: only the first failure of a
    // streak, the breaker opening and the breaker closing are.
    expect(log.lines).toHaveLength(1);
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

    // Loose lower bound: timer jitter on a loaded runner can land under 100.
    expect(elapsed).toBeGreaterThanOrEqual(50);
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

interface Frame {
  fn?: string;
  file: string;
  line: number;
  column: number;
}

/** A V8 stack for `message` whose frames sit in the given chunk files. */
function stackIn(message: string, frames: Frame[]): string {
  return [
    `Error: ${message}`,
    ...frames.map(({ fn, file, line, column }) =>
      fn
        ? `    at ${fn} (${file}:${line}:${column})`
        : `    at ${file}:${line}:${column}`
    ),
  ].join("\n");
}

/** An Error carrying exactly `stack`. */
function errorWithStack(message: string, stack: string, name = "Error"): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

const BUILD_A: Frame[] = [
  { fn: "t", file: "/srv/app/.next/server/chunks/[root-of-the-server]__0uc8_0l0xgs3p._.js", line: 1, column: 240 },
  { fn: "AsyncLocalStorage.run", file: "node:internal/async_local_storage/async_context_frame", line: 59, column: 14 },
  { fn: "r0.renderToResponse", file: "/srv/app/node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js", line: 5, column: 3711 },
];

/** The same frames after a redeploy: new chunk hash, new directory, new positions. */
const BUILD_B: Frame[] = [
  { fn: "t", file: "/var/task/.next/server/chunks/[root-of-the-server]__9zz1_7qq2kk1x._.js", line: 3, column: 1022 },
  { fn: "AsyncLocalStorage.run", file: "node:internal/async_local_storage/async_context_frame", line: 61, column: 9 },
  { fn: "r0.renderToResponse", file: "/var/task/node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js", line: 5, column: 3790 },
];

describe("server fingerprint", () => {
  const fp = (
    frames: Frame[],
    overrides: { name?: string; message?: string; route?: string | null } = {}
  ) =>
    computeServerFingerprint(
      overrides.name ?? "Error",
      overrides.message ?? "webhook signature mismatch",
      overrides.route === undefined ? "/api/webhooks/github" : overrides.route,
      parseFrames(stackIn("x", frames))
    );

  test("ignores chunk hashes, paths, lines and columns", () => {
    expect(fp(BUILD_A)).toBe(fp(BUILD_B));
  });

  test("changes with a top frame's function name", () => {
    const renamed = BUILD_A.map((f, i) => (i === 0 ? { ...f, fn: "verify" } : f));
    expect(fp(renamed)).not.toBe(fp(BUILD_A));
  });

  test("changes with the route, the message and the error name", () => {
    expect(fp(BUILD_A, { route: "/api/webhooks/stripe" })).not.toBe(fp(BUILD_A));
    expect(fp(BUILD_A, { message: "other" })).not.toBe(fp(BUILD_A));
    expect(fp(BUILD_A, { name: "TypeError" })).not.toBe(fp(BUILD_A));
  });

  test("uses only the top three frames", () => {
    const deeper = [...BUILD_A, { fn: "extra", file: "/x.js", line: 1, column: 1 }];
    expect(fp(deeper)).toBe(fp(BUILD_A));
  });

  test("frames without function names add nothing, leaving name, message and route", () => {
    const anonymousA = BUILD_A.map(({ fn: _fn, ...rest }) => rest);
    const anonymousB = BUILD_B.map(({ fn: _fn, ...rest }) => rest);
    expect(fp(anonymousA)).toBe(fp(anonymousB));
    expect(fp(anonymousA)).toBe(fp([]));
    expect(fp(anonymousA, { route: "/other" })).not.toBe(fp(anonymousA));
  });

  test("a missing route fingerprints apart from any route", () => {
    expect(fp(BUILD_A, { route: null })).not.toBe(fp(BUILD_A));
  });

  test("the same error from two builds lands on one row", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const message = "webhook signature mismatch";
    await reporter.reportServerError(errorWithStack(message, stackIn(message, BUILD_A)), {
      route: "/api/webhooks/github",
    });
    await reporter.reportServerError(errorWithStack(message, stackIn(message, BUILD_B)), {
      route: "/api/webhooks/github",
    });

    const row = await readOnlyClientError();
    expect(row.occurrences).toBe(2);
  });
});

/**
 * A made-up key of the given prefix. Assembled at runtime so the source holds
 * no literal that secret scanners (GitHub push protection) take for a real key.
 */
function fakeKey(prefix: string, body = "FAKE0000fake1111FAKE2222"): string {
  return [prefix, body].join("_");
}

describe("maskSecrets", () => {
  const KEYS = [
    fakeKey("sk_live"),
    fakeKey("sk_test"),
    fakeKey("rk_live"),
    fakeKey("pk_test"),
    fakeKey("whsec"),
    fakeKey("ghp"),
    fakeKey("gho"),
    fakeKey("ghu"),
    fakeKey("ghs"),
    fakeKey("ghr"),
    fakeKey("github_pat", "FAKE0000fake1111_FAKE2222fake3333"),
  ];

  for (const key of KEYS) {
    test(`masks ${key.split("_")[0]}_ keys`, () => {
      const masked = maskSecrets(`Invalid API key provided: ${key}.`);
      expect(masked).toBe("Invalid API key provided: [redacted].");
    });
  }

  test("masks a bearer credential whatever its shape", () => {
    expect(maskSecrets("sent Authorization: Bearer abc.DEF-123_~+/= then failed")).toBe(
      "sent Authorization: Bearer [redacted] then failed"
    );
    expect(maskSecrets("bearer opaque-token-value")).toBe("bearer [redacted]");
  });

  test("masks a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(maskSecrets(`token ${jwt} expired`)).toBe("token [redacted] expired");
  });

  test("leaves identifiers that only look like a prefix alone", () => {
    for (const text of [
      "task_list_items",
      "risk_score",
      'constraint "pk_user_roles_unique" failed',
      "sk_short1",
      "column github_pat_count",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  test("is driven by the exported REDACTION_PATTERNS list", () => {
    expect(REDACTION_PATTERNS.length).toBeGreaterThanOrEqual(3);
    for (const pattern of REDACTION_PATTERNS) {
      expect(pattern.flags).toContain("g");
    }
  });
});

describe("masking stored server errors", () => {
  test("a credential quoted back in an upstream error is masked in message and stack", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const error = new Error(
      `Invalid API key provided: ${fakeKey("sk_test")}`
    );
    await reporter.reportServerError(error, { tag: "stripe" });

    const row = await readOnlyClientError();
    expect(row.message).toBe("Error: Invalid API key provided: [redacted]");
    expect(row.stack).toStartWith("Error: Invalid API key provided: [redacted]\n");
    expect(JSON.stringify(row)).not.toContain("sk_test_");
  });

  test("a token in a caller-supplied tag or route is masked", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(new Error("x"), {
      tag: `job ${fakeKey("ghp")}`,
      route: `/api/hook/${fakeKey("whsec")}`,
    });
    const row = await readOnlyClientError();
    expect(row.tag).toBe("job [redacted]");
    expect(row.route).toBe("/api/hook/[redacted]");
  });

  test("one error carrying two different tokens is one row", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    for (const key of [
      fakeKey("sk_test"),
      fakeKey("sk_test", "FAKE9999fake8888FAKE7777"),
    ]) {
      const error = new Error(`Invalid API key provided: ${key}`);
      // Same throw site, so the frames match and only the token differs.
      error.stack = `Error: Invalid API key provided: ${key}\n    at charge (/srv/app/.next/server/chunks/a.js:1:1)`;
      await reporter.reportServerError(error, { route: "/api/billing" });
    }
    const row = await readOnlyClientError();
    expect(row.occurrences).toBe(2);
  });
});

describe("Drizzle query errors", () => {
  const QUERY = 'insert into "users" ("email", "stripe_customer_id") values ($1, $2)';
  const queryError = (params: unknown[]) => {
    const error = new DrizzleQueryError(
      QUERY,
      params,
      new Error('duplicate key value violates unique constraint "users_email_key"')
    );
    error.stack = `Error: ${error.message}\n    at insertUser (/srv/app/.next/server/chunks/a.js:1:1)`;
    return error;
  };

  test("stores the statement and the root cause, not the parameters", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(
      queryError(["alice@example.com", "cus_Q1w2e3r4t5y6"]),
      { route: "/api/signup" }
    );

    const row = await readOnlyClientError();
    expect(row.message).toBe(
      `Error: Failed query: ${QUERY} [cause: duplicate key value violates unique constraint "users_email_key"]`
    );
    expect(row.stack).toBe(
      `Error: Failed query: ${QUERY} [cause: duplicate key value violates unique constraint "users_email_key"]\n    at insertUser (/srv/app/.next/server/chunks/a.js:1:1)`
    );
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("alice@example.com");
    expect(stored).not.toContain("cus_Q1w2e3r4t5y6");
    expect(stored).not.toContain("params:");
  });

  test("the cause's class name is left out, since bundling minifies it", async () => {
    // postgres-js names its errors after the class, which a production
    // bundle renames.
    class ei extends Error {
      override name = this.constructor.name;
    }
    const minified = new DrizzleQueryError(QUERY, [1], new ei("relation \"users\" does not exist"));
    minified.name = "Error";
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(minified);
    expect((await readOnlyClientError()).message).toBe(
      `Error: Failed query: ${QUERY} [cause: relation "users" does not exist]`
    );
  });

  test("the same failed statement with different parameters is one row", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(queryError(["a@example.com", "cus_1"]));
    await reporter.reportServerError(queryError(["b@example.com", "cus_2"]));
    expect((await readOnlyClientError()).occurrences).toBe(2);
  });

  test("parameters spanning several lines are dropped from the stack too", async () => {
    const reporter = createServerErrorReporter(sqliteConfig());
    const error = new DrizzleQueryError(QUERY, ["line one\nline two SECRET_PARAM", 2]);
    error.stack = `Error: ${error.message}\n    at insertUser (/srv/app/a.js:1:1)`;
    await reporter.reportServerError(error);

    const row = await readOnlyClientError();
    expect(row.message).toBe(`Error: Failed query: ${QUERY}`);
    expect(row.stack).toBe(`Error: Failed query: ${QUERY}\n    at insertUser (/srv/app/a.js:1:1)`);
  });

  test("a real query failure through Drizzle stores no bound values", async () => {
    let thrown: unknown;
    try {
      await testDb.run(
        sql`select * from no_such_table where email = ${"carol@example.com"}`
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("carol@example.com");

    const reporter = createServerErrorReporter(sqliteConfig());
    await reporter.reportServerError(thrown);

    const row = await readOnlyClientError();
    expect(row.message).toStartWith(
      "Error: Failed query: select * from no_such_table where email = ? [cause: "
    );
    expect(row.message).toContain("no such table");
    expect(JSON.stringify(row)).not.toContain("carol@example.com");
  });
});

describe("circuit breaker", () => {
  const START = new Date("2026-11-14T12:00:00.000Z");

  beforeEach(() => {
    setSystemTime(START);
  });

  afterEach(() => {
    setSystemTime();
  });

  const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));

  /** A fake db whose writes fail while `down` is set, counting every attempt. */
  function flakyDb() {
    const state = { down: true, attempts: 0 };
    return {
      state,
      db: fakeDb(() => {
        state.attempts += 1;
        return state.down
          ? Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432"))
          : Promise.resolve();
      }),
    };
  }

  test("after 3 failures the 4th report returns at once without touching the database", async () => {
    const { db, state } = flakyDb();
    const reporter = createServerErrorReporter({ db, dialect: "sqlite" });

    for (let i = 0; i < 3; i++) await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(3);

    const started = performance.now();
    await reporter.reportServerError(new Error("x"));
    expect(performance.now() - started).toBeLessThan(20);
    expect(state.attempts).toBe(3);

    expect(log.lines).toEqual([
      "[error-tracker] failed to record server error: Error: connect ECONNREFUSED 10.0.0.5:5432",
      "[error-tracker] 3 consecutive writes failed; skipping server error reports for 30000 ms",
    ]);
  });

  test("timed-out writes count as failures, and an open breaker does not wait", async () => {
    let attempts = 0;
    const reporter = createServerErrorReporter({
      db: fakeDb(() => {
        attempts += 1;
        return new Promise(() => {});
      }),
      dialect: "sqlite",
      timeoutMs: 20,
    });

    for (let i = 0; i < 3; i++) await reporter.reportServerError(new Error("x"));
    const started = performance.now();
    await reporter.reportServerError(new Error("x"));
    expect(performance.now() - started).toBeLessThan(15);
    expect(attempts).toBe(3);
    expect(log.lines).toHaveLength(2);
    expect(log.lines[1]).toContain("skipping server error reports");
  });

  test("tries one write after the window; a failure reopens it without logging", async () => {
    const { db, state } = flakyDb();
    const reporter = createServerErrorReporter({ db, dialect: "sqlite" });
    for (let i = 0; i < 3; i++) await reporter.reportServerError(new Error("x"));

    advance(29_999);
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(3);

    advance(1);
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(4);

    // Reopened: the next report inside the new window is skipped.
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(4);
    expect(log.lines).toHaveLength(2);
  });

  test("a successful trial write closes the breaker and logs it once", async () => {
    const { db, state } = flakyDb();
    const reporter = createServerErrorReporter({ db, dialect: "sqlite" });
    for (let i = 0; i < 3; i++) await reporter.reportServerError(new Error("x"));
    await reporter.reportServerError(new Error("skipped"));
    await reporter.reportServerError(new Error("skipped"));

    state.down = false;
    advance(30_000);
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(4);
    expect(log.lines[2]).toBe(
      "[error-tracker] database writes succeeded again; resuming server error reports (2 skipped)"
    );

    // Closed: every report writes again.
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(5);
    expect(log.lines).toHaveLength(3);
  });

  test("only one trial write runs at a time; reports during it are skipped", async () => {
    let attempts = 0;
    let release: (() => void) | undefined;
    let down = true;
    const reporter = createServerErrorReporter({
      db: fakeDb(() => {
        attempts += 1;
        if (down) return Promise.reject(new Error("down"));
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }),
      dialect: "sqlite",
    });
    for (let i = 0; i < 3; i++) await reporter.reportServerError(new Error("x"));

    down = false;
    advance(30_000);
    const trial = reporter.reportServerError(new Error("trial"));
    await reporter.reportServerError(new Error("during trial"));
    expect(attempts).toBe(4);

    release?.();
    await trial;
    await reporter.reportServerError(new Error("after"));
    expect(attempts).toBe(5);
  });

  test("a success resets the count, so failures must be consecutive", async () => {
    const { db, state } = flakyDb();
    const reporter = createServerErrorReporter({ db, dialect: "sqlite" });

    await reporter.reportServerError(new Error("x"));
    await reporter.reportServerError(new Error("x"));
    state.down = false;
    await reporter.reportServerError(new Error("x"));
    state.down = true;
    await reporter.reportServerError(new Error("x"));
    await reporter.reportServerError(new Error("x"));

    expect(state.attempts).toBe(5);
    // Two streaks, each logging its first failure; neither reached 3.
    expect(log.lines).toHaveLength(2);
    expect(log.lines.every((line) => line.includes("failed to record"))).toBe(true);
  });

  test("a report that never reached the database neither counts toward the breaker nor spends the trial", () => {
    // `report` calls `abandoned` when its own code throws before writing, so
    // a bug in the reporter cannot pass for a database outage.
    const breaker = createBreaker(3, 30_000);

    for (let i = 0; i < 5; i++) {
      expect(breaker.admit()).toBe("write");
      breaker.abandoned("write");
    }
    expect(breaker.admit()).toBe("write");

    for (let i = 0; i < 3; i++) breaker.failed("write", "down");
    expect(breaker.admit()).toBe("skip");

    advance(30_000);
    expect(breaker.admit()).toBe("trial");
    breaker.abandoned("trial");
    // The slot is free again and the window has not restarted.
    expect(breaker.admit()).toBe("trial");
    breaker.succeeded("trial");
    expect(breaker.admit()).toBe("write");
  });

  test("the threshold and the window are configurable", async () => {
    const { db, state } = flakyDb();
    const reporter = createServerErrorReporter({
      db,
      dialect: "sqlite",
      breaker: { failures: 1, cooldownMs: 1_000 },
    });

    await reporter.reportServerError(new Error("x"));
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(1);
    expect(log.lines[1]).toBe(
      "[error-tracker] 1 consecutive writes failed; skipping server error reports for 1000 ms"
    );

    advance(1_000);
    await reporter.reportServerError(new Error("x"));
    expect(state.attempts).toBe(2);
  });

  test("rejects a threshold or window that is not positive", () => {
    for (const breaker of [
      { failures: 0 },
      { failures: 1.5 },
      { cooldownMs: 0 },
      { cooldownMs: Number.NaN },
    ]) {
      expect(() =>
        createServerErrorReporter({ ...sqliteConfig(), breaker })
      ).toThrow(/breaker/);
    }
  });
});
