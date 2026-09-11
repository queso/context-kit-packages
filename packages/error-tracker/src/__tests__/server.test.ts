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
  "    at http://localhost:3000/_next/static/chunks/app.js:1:100",
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
      "handleClick (../src/components/Dashboard.tsx:42:8)"
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
      "handleClick (../src/components/Dashboard.tsx:42:8)"
    );
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

  test("does not rate limit GET", async () => {
    const { POST, GET } = limited();
    await POST(fromClient(validBody()));
    await POST(fromClient(validBody()));
    await POST(fromClient(validBody()));

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

describe("createErrorHandlers unauthenticated production warning", () => {
  test("warns when NODE_ENV is production and no secretHeaderToken is configured", async () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = await captureWarnings(() => {
        createErrorHandlers(sqliteConfig());
      });
      expect(out).toContain("no secretHeaderToken configured");
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
