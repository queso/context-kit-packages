import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMapGenerator } from "source-map";
import { computeFingerprint, createErrorHandlers } from "../server";
import { parseFrames } from "../server/parse-stack";
import {
  errorRequest,
  prepareTestDb,
  queryRequest,
  readClientErrors,
  readOnlyClientError,
  resetClientErrors,
  sqliteConfig,
  stubEnv,
  testDb,
} from "./helpers";

/**
 * Replaces `console.warn` for the duration of `fn`, returning everything
 * written. `captureConsole` in helpers.ts only intercepts log/error, so the
 * production-warning check (which uses `console.warn`) needs its own stub.
 */
async function captureWarnings(fn: () => void): Promise<string> {
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

const SECRET_HEADER = "x-error-token";
const SECRET_TOKEN = "test-secret-token";

const MESSAGE = "TypeError: Cannot read properties of undefined";
const STACK = `${MESSAGE}\n  at Component (app.js:1:100)`;

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    message: MESSAGE,
    stack: STACK,
    url: "https://example.com/dashboard",
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
}

/**
 * A real source map, built with the same generator a bundler uses: app.js:1:100
 * maps to handleClick in Dashboard.tsx. A hand-written `mappings` string is easy
 * to get subtly wrong, and a map that decodes to no mapping at all would make
 * the resolver look correct while resolving nothing.
 */
function buildSourceMap(): string {
  const generator = new SourceMapGenerator({ file: "app.js" });
  generator.addMapping({
    generated: { line: 1, column: 100 },
    original: { line: 42, column: 8 },
    source: "../src/components/Dashboard.tsx",
    name: "handleClick",
  });
  return generator.toString();
}

const MINIFIED_STACK = [
  MESSAGE,
  // 1-based stack column 101 translates to the 0-based generated column 100
  // the fixture map above maps from.
  "    at http://localhost:3000/_next/static/chunks/app.js:1:101",
].join("\n");

let sourceMapDir: string;

beforeAll(async () => {
  await prepareTestDb();
  sourceMapDir = join(tmpdir(), `error-tracker-server-${Date.now()}`);
  mkdirSync(sourceMapDir, { recursive: true });
  writeFileSync(join(sourceMapDir, "app.js.map"), buildSourceMap(), "utf-8");
});

afterAll(() => {
  rmSync(sourceMapDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetClientErrors();
});

describe("createErrorHandlers configuration", () => {
  test("returns a POST and a GET handler", () => {
    const handlers = createErrorHandlers(sqliteConfig());
    expect(typeof handlers.POST).toBe("function");
    expect(typeof handlers.GET).toBe("function");
  });

  test("throws when no db is provided", () => {
    expect(() => createErrorHandlers({ dialect: "sqlite" } as never)).toThrow(
      /A Drizzle database instance is required/
    );
  });

  test.each(["mysql", "sqlite3", "Postgres"])(
    'throws Unsupported dialect "%s"',
    (dialect) => {
      expect(() =>
        createErrorHandlers({ db: testDb, dialect } as never)
      ).toThrow(`Unsupported dialect "${dialect}"`);
    }
  );
});

describe("createErrorHandlers POST", () => {
  const { POST } = createErrorHandlers(sqliteConfig());

  test("stores the report and answers with its fingerprint", async () => {
    const res = await POST(errorRequest(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      fingerprint: computeFingerprint(MESSAGE, parseFrames(STACK)),
    });
    expect((await readOnlyClientError()).message).toBe(MESSAGE);
  });

  test("returns 400 and stores nothing when message is missing", async () => {
    const res = await POST(errorRequest({ stack: STACK }));
    expect(res.status).toBe(400);
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("merges a repeat into the row it already has", async () => {
    await POST(errorRequest(validBody()));
    await POST(errorRequest(validBody()));
    expect((await readOnlyClientError()).occurrences).toBe(2);
  });
});

describe("createErrorHandlers authentication", () => {
  const { POST, GET } = createErrorHandlers({
    ...sqliteConfig(),
    secretHeaderName: SECRET_HEADER,
    secretHeaderToken: SECRET_TOKEN,
  });

  test("POST returns 401 and stores nothing without the token", async () => {
    const res = await POST(errorRequest(validBody()));
    expect(res.status).toBe(401);
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("POST returns 401 with the wrong token", async () => {
    const res = await POST(
      errorRequest(validBody(), { [SECRET_HEADER]: "wrong" })
    );
    expect(res.status).toBe(401);
  });

  test("GET returns 401 without the token", async () => {
    const res = await GET(queryRequest());
    expect(res.status).toBe(401);
  });

  test("both handlers work with the correct token", async () => {
    const post = await POST(
      errorRequest(validBody(), { [SECRET_HEADER]: SECRET_TOKEN })
    );
    expect(post.status).toBe(200);

    const get = await GET(queryRequest({}, { [SECRET_HEADER]: SECRET_TOKEN }));
    expect(get.status).toBe(200);
    const body = (await get.json()) as { errors: { message: string }[] };
    expect(body.errors.map((row) => row.message)).toEqual([MESSAGE]);
  });
});

describe("createErrorHandlers GET reads what POST wrote", () => {
  const { POST, GET } = createErrorHandlers(sqliteConfig());

  test("the reported error comes back through the query handler", async () => {
    await POST(errorRequest(validBody()));
    await POST(errorRequest(validBody()));

    const res = await GET(queryRequest({ resolved: "false" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors: { fingerprint: string; occurrences: number }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.errors[0]?.fingerprint).toBe(
      computeFingerprint(MESSAGE, parseFrames(STACK))
    );
    expect(body.errors[0]?.occurrences).toBe(2);
  });
});

describe("createErrorHandlers source map resolution", () => {
  test("resolves the reported stack and fingerprints on the resolved frames", async () => {
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });

    const res = await POST(errorRequest(validBody({ stack: MINIFIED_STACK })));
    expect(res.status).toBe(200);
    const { fingerprint } = (await res.json()) as { fingerprint: string };

    const row = await readOnlyClientError();
    const resolvedStack = String(row.resolvedStack);
    expect(resolvedStack).toContain(
      "handleClick (../src/components/Dashboard.tsx:42:9)"
    );
    expect(row.stack).toBe(MINIFIED_STACK);
    expect(fingerprint).toBe(
      computeFingerprint(MESSAGE, parseFrames(resolvedStack))
    );
    expect(fingerprint).not.toBe(
      computeFingerprint(MESSAGE, parseFrames(MINIFIED_STACK))
    );
  });

  test("stores the report unresolved when the directory holds no matching map", async () => {
    const { POST } = createErrorHandlers({
      ...sqliteConfig(),
      sourceMapDir: join(sourceMapDir, "empty"),
    });

    const res = await POST(errorRequest(validBody({ stack: MINIFIED_STACK })));
    expect(res.status).toBe(200);
    expect((await readOnlyClientError()).stack).toBe(MINIFIED_STACK);
  });

  test("ignores stale content-length/content-encoding on the rebuilt request and still ingests with the resolved stack", async () => {
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });

    const res = await POST(
      errorRequest(validBody({ stack: MINIFIED_STACK }), {
        // Wrong on purpose: copying these onto the re-serialized request would
        // either misreport its size or make the handler try to gunzip plain JSON.
        "content-length": "1",
        "content-encoding": "gzip",
      })
    );
    expect(res.status).toBe(200);

    const row = await readOnlyClientError();
    expect(String(row.resolvedStack)).toContain(
      "handleClick (../src/components/Dashboard.tsx:42:9)"
    );
  });

  test("ignores stale content-length/content-encoding on the rebuilt request when the body has no stack", async () => {
    // Same bug as the resolved-stack rebuild, but on the no-stack path
    // (`rebuild()`): copying content-encoding verbatim would tell the
    // ingestion handler to gunzip a plain-JSON body it never gzipped.
    // Asserting the exact Request the ingestion handler receives is not
    // practical here, so this only proves the request still succeeds and the
    // row still lands, which is the observable effect of the header leak.
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });

    const { stack: _stack, ...bodyWithoutStack } = validBody();
    const res = await POST(
      errorRequest(bodyWithoutStack, {
        // Wrong on purpose, same as the resolved-stack test above.
        "content-length": "1",
        "content-encoding": "gzip",
      })
    );
    expect(res.status).toBe(200);
    expect((await readOnlyClientError()).message).toBe(MESSAGE);
  });

  test("returns 413 and never reaches the store when the body exceeds the cap and carries no content-length header", async () => {
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });

    // A ReadableStream body has no computed content-length header, so the
    // pre-resolution path can only catch this by streaming with a cap.
    const encoder = new TextEncoder();
    const payload = JSON.stringify(
      validBody({ message: "M".repeat(70 * 1024) })
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    const request = new Request("https://example.com/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const res = await POST(request);
    expect(res.status).toBe(413);
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("stops pulling the body once it is over the cap, instead of buffering it to completion", async () => {
    // Distinguishes a size-capped stream read from `request.clone().json()`:
    // the latter has no choice but to read a stream through to its end
    // before it can even attempt to parse, so it would pull every chunk
    // regardless of size. A source that lazily produces far more than the
    // cap proves the read stopped early rather than merely rejecting late.
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });

    const encoder = new TextEncoder();
    const chunkText = "a".repeat(1_000);
    const chunkCount = 200; // 200,000 bytes total, well past the 64 KiB cap
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunkText));
      },
    });
    const request = new Request("https://example.com/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const res = await POST(request);
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(chunkCount);
  });

  test("accepts a request when content-length is non-numeric and the body is small", async () => {
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });

    const res = await POST(
      errorRequest(validBody(), { "content-length": "not-a-number" })
    );
    expect(res.status).toBe(200);
  });

  test("still returns 400 on an unparseable body when resolution is configured", async () => {
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });
    const res = await POST(
      new Request("https://example.com/api/errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json at all",
      })
    );
    expect(res.status).toBe(400);
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("returns 400 with a distinct message when the body stream itself fails", async () => {
    const { POST } = createErrorHandlers({ ...sqliteConfig(), sourceMapDir });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("stream failed");
      },
    });
    const res = await POST(
      new Request("https://example.com/api/errors", {
        method: "POST",
        body: stream,
        // Streaming request bodies require duplex on this runtime's fetch impl.
        duplex: "half",
      } as RequestInit)
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Failed to read request body" });
    expect(await readClientErrors()).toHaveLength(0);
  });
});

describe("createErrorHandlers rate limiting", () => {
  const CLIENT_IP = "203.0.113.7";

  function limited() {
    return createErrorHandlers({
      ...sqliteConfig(),
      rateLimiter: { windowMs: 60_000, maxRequests: 2 },
    });
  }

  function fromClient(body: unknown): Request {
    return errorRequest(body, { "x-forwarded-for": CLIENT_IP });
  }

  test("accepts requests up to the limit and rejects the next with 429", async () => {
    const { POST } = limited();
    expect((await POST(fromClient(validBody()))).status).toBe(200);
    expect((await POST(fromClient(validBody()))).status).toBe(200);

    const blocked = await POST(fromClient(validBody()));
    expect(blocked.status).toBe(429);

    // The blocked report must not have been counted.
    expect((await readOnlyClientError()).occurrences).toBe(2);
  });

  test("rate limits GET the same as POST", async () => {
    const { GET } = limited();
    const fromGetClient = () =>
      queryRequest({}, { "x-forwarded-for": CLIENT_IP });

    expect((await GET(fromGetClient())).status).toBe(200);
    expect((await GET(fromGetClient())).status).toBe(200);
    expect((await GET(fromGetClient())).status).toBe(429);
  });

  test("does not rate limit GET when no limiter is configured", async () => {
    const { GET } = createErrorHandlers(sqliteConfig());
    for (let i = 0; i < 5; i++) {
      const res = await GET(queryRequest({}, { "x-forwarded-for": CLIENT_IP }));
      expect(res.status).toBe(200);
    }
  });

  test("accepts an unlimited number of reports when no limiter is configured", async () => {
    const { POST } = createErrorHandlers(sqliteConfig());
    for (let i = 0; i < 5; i++) {
      const res = await POST(fromClient(validBody()));
      expect(res.status).toBe(200);
    }
    expect((await readOnlyClientError()).occurrences).toBe(5);
  });
});

describe("createErrorHandlers query token", () => {
  const INGESTION_TOKEN = "ingestion-token";
  const QUERY_TOKEN = "query-only-token";

  test("GET requires the query token, not the ingestion token, when both are set", async () => {
    const { POST, GET } = createErrorHandlers({
      ...sqliteConfig(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: INGESTION_TOKEN,
      queryHeaderToken: QUERY_TOKEN,
    });

    const post = await POST(
      errorRequest(validBody(), { [SECRET_HEADER]: INGESTION_TOKEN })
    );
    expect(post.status).toBe(200);

    const getWithIngestionToken = await GET(
      queryRequest({}, { [SECRET_HEADER]: INGESTION_TOKEN })
    );
    expect(getWithIngestionToken.status).toBe(401);

    const getWithQueryToken = await GET(
      queryRequest({}, { [SECRET_HEADER]: QUERY_TOKEN })
    );
    expect(getWithQueryToken.status).toBe(200);
  });

  test("GET still accepts secretHeaderToken when queryHeaderToken is not set", async () => {
    const { GET } = createErrorHandlers({
      ...sqliteConfig(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });

    const res = await GET(queryRequest({}, { [SECRET_HEADER]: SECRET_TOKEN }));
    expect(res.status).toBe(200);
  });
});

describe("createErrorHandlers unauthenticated production warning", () => {
  test("warns twice, once per handler, when NODE_ENV is production and no secretHeaderToken is configured", async () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = await captureWarnings(() => {
        createErrorHandlers(sqliteConfig());
      });
      const lines = out.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(out).toContain("The ingestion endpoint accepts unauthenticated requests");
      expect(out).toContain("The query endpoint accepts unauthenticated requests");
    } finally {
      restore();
    }
  });

  test("warns for ingestion only when queryHeaderToken is set and no secretHeaderToken is configured", async () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = await captureWarnings(() => {
        createErrorHandlers({
          ...sqliteConfig(),
          queryHeaderToken: "query-only-token",
        });
      });
      const lines = out.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(out).toContain("The ingestion endpoint accepts unauthenticated requests");
    } finally {
      restore();
    }
  });

  test("does not warn when a secretHeaderToken is configured", async () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = await captureWarnings(() => {
        createErrorHandlers({ ...sqliteConfig(), secretHeaderToken: "shh" });
      });
      expect(out).toBe("");
    } finally {
      restore();
    }
  });

  test("does not warn outside production", async () => {
    const restore = stubEnv("NODE_ENV", "test");
    try {
      const out = await captureWarnings(() => {
        createErrorHandlers(sqliteConfig());
      });
      expect(out).toBe("");
    } finally {
      restore();
    }
  });
});

describe("server barrel exports", () => {
  test("re-exports the server-side surface consumers import", async () => {
    const mod = await import("../server");
    expect(typeof mod.createErrorHandlers).toBe("function");
    expect(typeof mod.createIngestionHandler).toBe("function");
    expect(typeof mod.createQueryHandler).toBe("function");
    expect(typeof mod.createRateLimiter).toBe("function");
    expect(typeof mod.resolveStack).toBe("function");
    expect(typeof mod.computeFingerprint).toBe("function");
  });

  test("the re-exported factories are wired to the same implementations", async () => {
    const mod = await import("../server");
    const ingestion = await import("../server/ingestion");
    const queryModule = await import("../server/query");
    expect(mod.createIngestionHandler).toBe(ingestion.createIngestionHandler);
    expect(mod.computeFingerprint).toBe(ingestion.computeFingerprint);
    expect(mod.createQueryHandler).toBe(queryModule.createQueryHandler);
  });
});
