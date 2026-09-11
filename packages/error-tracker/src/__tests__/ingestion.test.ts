import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tokenMatches } from "../server/auth";
import {
  computeFingerprint,
  createIngestionHandler,
  readBodyWithCap,
} from "../server/ingestion";
import { parseFrames } from "../server/parse-stack";
import type { StackFrame } from "../types";
import {
  errorRequest,
  findClientError,
  prepareTestDb,
  rawRequest,
  readClientErrors,
  readOnlyClientError,
  resetClientErrors,
  seedClientError,
  sqliteConfig,
  stubEnv,
  testDb,
} from "./helpers";

const SECRET_HEADER = "x-error-token";
const SECRET_TOKEN = "test-secret-token";

const STACK = [
  "TypeError: Cannot read properties of undefined",
  "  at Component (app.js:1:100)",
  "  at App (app.js:2:200)",
  "  at Root (app.js:3:300)",
].join("\n");

const MESSAGE = "TypeError: Cannot read properties of undefined";

/** The fingerprint the handler must derive for `message` plus `stack`. */
function fingerprintFor(message: string, stack: string): string {
  return computeFingerprint(message, parseFrames(stack));
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    message: MESSAGE,
    stack: STACK,
    componentStack: "\n  at ErrorBoundary\n  at App",
    url: "https://example.com/dashboard",
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
}

const frame = (over: Partial<StackFrame> = {}): StackFrame => ({
  file: "app.js",
  line: 1,
  column: 1,
  functionName: "Component",
  ...over,
});

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetClientErrors();
});

describe("computeFingerprint", () => {
  test("is stable for the same message and frames", () => {
    const frames = [frame(), frame({ line: 2 })];
    expect(computeFingerprint(MESSAGE, frames)).toBe(
      computeFingerprint(MESSAGE, [frame(), frame({ line: 2 })])
    );
  });

  test("is a 64-character hex digest", () => {
    expect(computeFingerprint(MESSAGE, [frame()])).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when the message changes", () => {
    expect(computeFingerprint("a", [frame()])).not.toBe(
      computeFingerprint("b", [frame()])
    );
  });

  test("changes when a top frame changes", () => {
    expect(computeFingerprint(MESSAGE, [frame()])).not.toBe(
      computeFingerprint(MESSAGE, [frame({ line: 99 })])
    );
  });

  test("ignores frames after the third so a deeper trace still groups", () => {
    const topThree = [
      frame({ line: 1 }),
      frame({ line: 2 }),
      frame({ line: 3 }),
    ];
    expect(computeFingerprint(MESSAGE, [...topThree, frame({ line: 4 })])).toBe(
      computeFingerprint(MESSAGE, topThree)
    );
  });

  test("groups messages with no frames at all by message alone", () => {
    expect(computeFingerprint(MESSAGE, [])).toBe(
      computeFingerprint(MESSAGE, [])
    );
    expect(computeFingerprint(MESSAGE, [])).not.toBe(
      computeFingerprint(MESSAGE, [frame()])
    );
  });
});

describe("createIngestionHandler configuration", () => {
  test("throws when no db is provided", () => {
    expect(() =>
      createIngestionHandler({ dialect: "sqlite" } as never)
    ).toThrow(/A Drizzle database instance is required/);
  });

  test.each(["mysql", "sqlite3", "Postgres"])(
    'throws Unsupported dialect "%s"',
    (dialect) => {
      expect(() =>
        createIngestionHandler({ db: testDb, dialect } as never)
      ).toThrow(`Unsupported dialect "${dialect}"`);
    }
  );

  test("returns a request handler for each supported dialect", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      expect(typeof createIngestionHandler({ db: testDb, dialect })).toBe(
        "function"
      );
    }
  });
});

describe("createIngestionHandler production warning", () => {
  /** Mirrors captureWarnings in server.test.ts: captureConsole only intercepts log/error. */
  function captureWarnings(fn: () => void): string {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return lines.join("\n");
  }

  test("warns when NODE_ENV is production and no secretHeaderToken is configured", () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = captureWarnings(() => {
        createIngestionHandler(sqliteConfig());
      });
      expect(out).toContain("The ingestion endpoint accepts unauthenticated requests");
    } finally {
      restore();
    }
  });

  test("does not warn when a secretHeaderToken is configured", () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = captureWarnings(() => {
        createIngestionHandler({ ...sqliteConfig(), secretHeaderToken: "shh" });
      });
      expect(out).toBe("");
    } finally {
      restore();
    }
  });

  test("does not warn outside production", () => {
    const restore = stubEnv("NODE_ENV", "test");
    try {
      const out = captureWarnings(() => {
        createIngestionHandler(sqliteConfig());
      });
      expect(out).toBe("");
    } finally {
      restore();
    }
  });
});

describe("ingestion handler authentication", () => {
  const handler = () =>
    createIngestionHandler({
      ...sqliteConfig(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });

  test("returns 401 and stores nothing when the token header is missing", async () => {
    const res = await handler()(errorRequest(validBody()));
    expect(res.status).toBe(401);
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("returns 401 and stores nothing when the token header is wrong", async () => {
    const res = await handler()(
      errorRequest(validBody(), { [SECRET_HEADER]: "wrong" })
    );
    expect(res.status).toBe(401);
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("stores the report when the correct token is provided", async () => {
    const res = await handler()(
      errorRequest(validBody(), { [SECRET_HEADER]: SECRET_TOKEN })
    );
    expect(res.status).toBe(200);
    expect(await readClientErrors()).toHaveLength(1);
  });

  test("stores the report when no token is configured", async () => {
    const res = await createIngestionHandler(sqliteConfig())(
      errorRequest(validBody())
    );
    expect(res.status).toBe(200);
    expect(await readClientErrors()).toHaveLength(1);
  });
});

describe("ingestion handler request validation", () => {
  const handler = createIngestionHandler(sqliteConfig());

  test("returns 400 and stores nothing when the body is not JSON", async () => {
    const res = await handler(rawRequest("not json at all"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(await readClientErrors()).toHaveLength(0);
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   \t\n"],
    ["a non-string", 42],
  ])(
    "returns 400 and stores nothing when message is %s",
    async (_label, message) => {
      const { message: _dropped, ...rest } = validBody();
      const body = message === undefined ? rest : { ...rest, message };
      const res = await handler(errorRequest(body));
      expect(res.status).toBe(400);
      expect(await readClientErrors()).toHaveLength(0);
    }
  );
});

describe("ingestion handler first report", () => {
  const handler = createIngestionHandler(sqliteConfig());

  test("responds with the computed fingerprint", async () => {
    const res = await handler(errorRequest(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      fingerprint: fingerprintFor(MESSAGE, STACK),
    });
  });

  test("stores one row carrying the reported payload", async () => {
    const before = Date.now();
    await handler(errorRequest(validBody()));
    const row = await readOnlyClientError();

    expect(row.message).toBe(MESSAGE);
    expect(row.stack).toBe(STACK);
    expect(row.componentStack).toBe("\n  at ErrorBoundary\n  at App");
    expect(row.url).toBe("https://example.com/dashboard");
    expect(row.userAgent).toBe("Mozilla/5.0");
    expect(row.fingerprint).toBe(fingerprintFor(MESSAGE, STACK));
    expect(row.occurrences).toBe(1);
    expect(row.resolvedAt).toBeNull();
    expect(row.resolvedStack).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test("stores null for the optional fields the report omits", async () => {
    await handler(errorRequest({ message: MESSAGE }));
    const row = await readOnlyClientError();
    expect(row.stack).toBeNull();
    expect(row.componentStack).toBeNull();
    expect(row.url).toBeNull();
    expect(row.userAgent).toBeNull();
  });

  test("tags the row with NODE_ENV at request time when the report carries no environment", async () => {
    const restore = stubEnv("NODE_ENV", "staging");
    try {
      await handler(errorRequest(validBody()));
    } finally {
      restore();
    }
    expect((await readOnlyClientError()).environment).toBe("staging");
  });

  test("falls back to development when NODE_ENV is unset and the report carries no environment", async () => {
    const restore = stubEnv("NODE_ENV", undefined);
    try {
      await handler(errorRequest(validBody()));
    } finally {
      restore();
    }
    expect((await readOnlyClientError()).environment).toBe("development");
  });

  test("stores the client-reported environment instead of NODE_ENV", async () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      await handler(errorRequest(validBody({ environment: "staging" })));
    } finally {
      restore();
    }
    expect((await readOnlyClientError()).environment).toBe("staging");
  });

  test.each([
    ["an empty string", ""],
    ["a blank string", "   "],
    ["a non-string", 42],
  ])(
    "falls back to NODE_ENV when the reported environment is %s",
    async (_label, environment) => {
      const restore = stubEnv("NODE_ENV", "staging");
      try {
        await handler(errorRequest(validBody({ environment })));
      } finally {
        restore();
      }
      expect((await readOnlyClientError()).environment).toBe("staging");
    }
  );

  test("truncates an overlong reported environment to 64 characters", async () => {
    const longEnvironment = "e".repeat(100);
    await handler(errorRequest(validBody({ environment: longEnvironment })));
    expect((await readOnlyClientError()).environment).toBe(
      longEnvironment.slice(0, 64)
    );
  });

  test("truncates a stack longer than 10,000 characters", async () => {
    const longStack = `Error\n${"  at Component (app.js:1:100)\n".repeat(1000)}`;
    expect(longStack.length).toBeGreaterThan(10_000);
    await handler(errorRequest(validBody({ stack: longStack })));
    expect((await readOnlyClientError()).stack).toBe(
      longStack.slice(0, 10_000)
    );
  });

  test("stores the resolved stack when the report carries one", async () => {
    const resolvedStack = "Error\n  at Component (src/Component.tsx:12:4)";
    await handler(errorRequest(validBody({ resolvedStack })));
    expect((await readOnlyClientError()).resolvedStack).toBe(resolvedStack);
  });

  test("fingerprints on the resolved frames when a resolved stack is present", async () => {
    // Minified frames differ between builds; the resolved frames do not, so the
    // fingerprint has to come from the resolved stack when one is available.
    const resolvedStack = "Error\n  at Component (src/Component.tsx:12:4)";
    const res = await handler(errorRequest(validBody({ resolvedStack })));
    const { fingerprint } = (await res.json()) as { fingerprint: string };

    expect(fingerprint).toBe(fingerprintFor(MESSAGE, resolvedStack));
    expect(fingerprint).not.toBe(fingerprintFor(MESSAGE, STACK));
    expect((await readOnlyClientError()).fingerprint).toBe(fingerprint);
  });

  test("treats an empty-string resolvedStack as absent", async () => {
    const res = await handler(errorRequest(validBody({ resolvedStack: "" })));
    const { fingerprint } = (await res.json()) as { fingerprint: string };

    expect(fingerprint).toBe(fingerprintFor(MESSAGE, STACK));
    expect((await readOnlyClientError()).resolvedStack).toBeNull();
  });

  test("groups two builds of the same error under one row via the resolved stack", async () => {
    const resolvedStack = "Error\n  at Component (src/Component.tsx:12:4)";
    await handler(
      errorRequest(
        validBody({ stack: "Error\n  at a (a.min.js:1:9)", resolvedStack })
      )
    );
    await handler(
      errorRequest(
        validBody({ stack: "Error\n  at b (b.min.js:7:31)", resolvedStack })
      )
    );

    const row = await readOnlyClientError();
    expect(row.occurrences).toBe(2);
  });
});

describe("ingestion handler field size caps", () => {
  const handler = createIngestionHandler(sqliteConfig());

  test("truncates an oversized message to 2,000 characters", async () => {
    const longMessage = "M".repeat(2_500);
    const res = await handler(errorRequest(validBody({ message: longMessage })));
    expect(res.status).toBe(200);
    const row = await readOnlyClientError();
    expect(row.message).toBe(longMessage.slice(0, 2_000));
    expect(row.message.length).toBe(2_000);
  });

  test("fingerprints on the truncated message, not the full one", async () => {
    const longMessage = "M".repeat(2_500);
    const res = await handler(errorRequest(validBody({ message: longMessage })));
    const { fingerprint } = (await res.json()) as { fingerprint: string };
    expect(fingerprint).toBe(fingerprintFor(longMessage.slice(0, 2_000), STACK));
  });

  test("truncates an oversized componentStack to 10,000 characters", async () => {
    const longComponentStack = "  at Component\n".repeat(1000);
    expect(longComponentStack.length).toBeGreaterThan(10_000);
    await handler(
      errorRequest(validBody({ componentStack: longComponentStack }))
    );
    expect((await readOnlyClientError()).componentStack).toBe(
      longComponentStack.slice(0, 10_000)
    );
  });

  test("truncates an oversized url to 2,048 characters", async () => {
    const longUrl = `https://example.com/${"a".repeat(2_100)}`;
    expect(longUrl.length).toBeGreaterThan(2_048);
    await handler(errorRequest(validBody({ url: longUrl })));
    expect((await readOnlyClientError()).url).toBe(longUrl.slice(0, 2_048));
  });

  test("truncates an oversized userAgent to 1,024 characters", async () => {
    const longUserAgent = "Mozilla/5.0 ".repeat(100);
    expect(longUserAgent.length).toBeGreaterThan(1_024);
    await handler(errorRequest(validBody({ userAgent: longUserAgent })));
    expect((await readOnlyClientError()).userAgent).toBe(
      longUserAgent.slice(0, 1_024)
    );
  });
});

describe("ingestion handler body size limit", () => {
  const handler = createIngestionHandler(sqliteConfig());

  test("returns 413 when content-length exceeds the cap", async () => {
    const res = await handler(
      errorRequest(validBody(), { "content-length": String(64 * 1024 + 1) })
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload too large" });
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("returns 413 when the body exceeds the cap and no content-length header is present", async () => {
    const body = validBody({ message: "M".repeat(70 * 1024) });
    const request = errorRequest(body);
    expect(request.headers.get("content-length")).toBeNull();

    const res = await handler(request);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload too large" });
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("accepts a body just under the cap", async () => {
    const body = validBody({ message: "M".repeat(60 * 1024) });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(64 * 1024);

    const res = await handler(errorRequest(body));
    expect(res.status).toBe(200);
    expect(await readClientErrors()).toHaveLength(1);
  });
});

describe("readBodyWithCap", () => {
  /** A request whose body is a stream, so no content-length header is set. */
  function streamRequest(chunks: string[]): Request {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Request("https://example.com/api/errors", {
      method: "POST",
      body: stream,
      // Streaming request bodies require duplex on this runtime's fetch impl.
      duplex: "half",
    } as RequestInit);
  }

  test("rejects once the accumulated chunks exceed the cap", async () => {
    const chunks = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const result = await readBodyWithCap(streamRequest(chunks), 50);
    expect(result).toEqual({ ok: false });
  });

  test("decodes the accumulated text when it stays under the cap", async () => {
    const chunks = ["hello ", "world"];
    const result = await readBodyWithCap(streamRequest(chunks), 1024);
    expect(result).toEqual({ ok: true, text: "hello world" });
  });
});

describe("ingestion handler body read failures", () => {
  const handler = createIngestionHandler(sqliteConfig());

  /** A request whose body stream errors as soon as it is first read. */
  function erroringStreamRequest(): Request {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("stream failed");
      },
    });
    return new Request("https://example.com/api/errors", {
      method: "POST",
      body: stream,
      // Streaming request bodies require duplex on this runtime's fetch impl.
      duplex: "half",
    } as RequestInit);
  }

  test("returns 400 with a distinct message when the body stream itself fails", async () => {
    const res = await handler(erroringStreamRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Failed to read request body" });
    expect(await readClientErrors()).toHaveLength(0);
  });
});

describe("tokenMatches", () => {
  test("returns true for equal tokens", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
  });

  test("returns false for different tokens of the same length", () => {
    expect(tokenMatches("secreu", "secret")).toBe(false);
  });

  test("returns false for tokens of different length", () => {
    expect(tokenMatches("short", "a-much-longer-token")).toBe(false);
  });

  test("returns false for a null provided token", () => {
    expect(tokenMatches(null, "secret")).toBe(false);
  });
});

describe("ingestion handler repeat reports", () => {
  const handler = createIngestionHandler(sqliteConfig());
  const fingerprint = fingerprintFor(MESSAGE, STACK);
  const OLD = new Date("2026-01-01T00:00:00.000Z");

  test("increments occurrences and bumps lastSeenAt however old the row is", async () => {
    // There is no deduplication window any more: a recurrence merges into the
    // row for its fingerprint even when the previous sighting is months old.
    // The Prisma version inserted a second row once the window had passed.
    await seedClientError({
      message: MESSAGE,
      stack: STACK,
      fingerprint,
      occurrences: 4,
      lastSeenAt: OLD,
      createdAt: OLD,
    });

    const res = await handler(errorRequest(validBody()));
    expect(res.status).toBe(200);

    const row = await readOnlyClientError();
    expect(row.occurrences).toBe(5);
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(OLD.getTime());
    expect(row.createdAt.getTime()).toBe(OLD.getTime());
  });

  test("keeps the first report's message, stack, context and environment", async () => {
    await seedClientError({
      message: MESSAGE,
      stack: STACK,
      fingerprint,
      componentStack: "first component stack",
      url: "https://example.com/first",
      userAgent: "FirstAgent/1.0",
      environment: "production",
      lastSeenAt: OLD,
    });

    const restore = stubEnv("NODE_ENV", "staging");
    try {
      await handler(
        errorRequest(
          validBody({
            componentStack: "second component stack",
            url: "https://example.com/second",
            userAgent: "SecondAgent/2.0",
          })
        )
      );
    } finally {
      restore();
    }

    const row = await readOnlyClientError();
    expect(row.componentStack).toBe("first component stack");
    expect(row.url).toBe("https://example.com/first");
    expect(row.userAgent).toBe("FirstAgent/1.0");
    expect(row.environment).toBe("production");
    expect(row.message).toBe(MESSAGE);
    expect(row.stack).toBe(STACK);
  });

  test("keeps the stored resolved stack when the repeat omits one", async () => {
    await seedClientError({
      message: MESSAGE,
      stack: STACK,
      fingerprint,
      resolvedStack: "Error\n  at Component (src/Component.tsx:12:4)",
      lastSeenAt: OLD,
    });

    await handler(errorRequest(validBody()));

    expect((await readOnlyClientError()).resolvedStack).toBe(
      "Error\n  at Component (src/Component.tsx:12:4)"
    );
  });

  test("takes the newer resolved stack when the repeat carries one", async () => {
    const resolvedStack = "Error\n  at Component (src/Component.tsx:12:4)";
    await seedClientError({
      message: MESSAGE,
      stack: STACK,
      fingerprint: fingerprintFor(MESSAGE, resolvedStack),
      resolvedStack: "Error\n  at Stale (src/Stale.tsx:1:1)",
      lastSeenAt: OLD,
    });

    await handler(errorRequest(validBody({ resolvedStack })));

    expect((await readOnlyClientError()).resolvedStack).toBe(resolvedStack);
  });

  test("reopens a resolved error instead of leaving it resolved", async () => {
    // A resolved error that happens again is not fixed. Before the Drizzle port
    // the recurrence inserted a second row (or was swallowed) and the resolved
    // row stayed resolved, so the recurrence never showed up in `tail`.
    await handler(errorRequest(validBody()));
    await handler(errorRequest(validBody()));

    const resolvedAt = new Date("2026-02-01T00:00:00.000Z");
    const { clientError } = await import("../schema/sqlite");
    const { eq } = await import("drizzle-orm");
    await testDb
      .update(clientError)
      .set({ resolvedAt })
      .where(eq(clientError.fingerprint, fingerprint));
    expect((await readOnlyClientError()).resolvedAt).toEqual(resolvedAt);

    await handler(errorRequest(validBody()));

    const row = await readOnlyClientError();
    expect(row.resolvedAt).toBeNull();
    expect(row.occurrences).toBe(3);
    expect(row.fingerprint).toBe(fingerprint);
  });

  test("keeps distinct errors in distinct rows", async () => {
    await handler(errorRequest(validBody()));
    await handler(errorRequest(validBody({ message: "RangeError: boom" })));

    const rows = await readClientErrors();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.occurrences)).toEqual([1, 1]);
  });

  test("collapses concurrent reports of the same error into one row", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => handler(errorRequest(validBody())))
    );
    expect(responses.map((res) => res.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);

    const row = await readOnlyClientError();
    expect(row.occurrences).toBe(6);
    expect(row.fingerprint).toBe(fingerprint);
  });

  test("keeps counts separate when concurrent reports carry different errors", async () => {
    await Promise.all([
      handler(errorRequest(validBody())),
      handler(errorRequest(validBody())),
      handler(errorRequest(validBody({ message: "RangeError: boom" }))),
    ]);

    expect(await readClientErrors()).toHaveLength(2);
    expect((await findClientError(fingerprint))?.occurrences).toBe(2);
  });
});
