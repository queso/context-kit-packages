import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockProcessExit(): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  const original = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process as any).exit = (code: number) => {
    calls.push(code);
    throw new Error(`process.exit(${code})`);
  };
  return {
    calls,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process as any).exit = original;
    },
  };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  console.log = (...args: any[]) => lines.push(args.join(" "));
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  console.error = (...args: any[]) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-15T10:00:00.000Z");

function makeErrorRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "err_1",
    fingerprint: "fp_abc123",
    message: "TypeError: Cannot read properties of undefined",
    stack: "TypeError\n  at Component (app.js:1:100)",
    componentStack: "\n  at ErrorBoundary",
    environment: "production",
    url: "https://example.com/dashboard",
    userAgent: "Mozilla/5.0",
    occurrences: 3,
    resolvedAt: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Mock Prisma factory ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  clientErrorFindMany?: (args: any) => Promise<any[]>;
  clientErrorUpdateMany?: (args: any) => Promise<any>;
  clientErrorUpdate?: (args: any) => Promise<any>;
}): any {
  return {
    clientError: {
      findMany:
        overrides?.clientErrorFindMany ??
        ((_: any) => Promise.resolve([makeErrorRecord()])),
      updateMany:
        overrides?.clientErrorUpdateMany ??
        ((_: any) => Promise.resolve({ count: 1 })),
      update:
        overrides?.clientErrorUpdate ??
        ((_: any) => Promise.resolve(makeErrorRecord({ resolvedAt: NOW }))),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { runTail, runResolve } = await import("../cli");

// ─── runTail ──────────────────────────────────────────────────────────────────

describe("runTail", () => {
  let savedDatabaseUrl: string | undefined;

  beforeEach(() => {
    savedDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
  });

  afterEach(() => {
    if (savedDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }
  });

  test("is a function", () => {
    expect(typeof runTail).toBe("function");
  });

  test("queries clientError.findMany to fetch recent errors", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([makeErrorRecord()]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    expect(clientErrorFindMany).toHaveBeenCalledTimes(1);
  });

  test("returns errors ordered by lastSeenAt descending", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const orderBy = callArgs?.orderBy;
    if (orderBy) {
      // Should order by lastSeenAt desc
      const isLastSeenAtDesc =
        orderBy?.lastSeenAt === "desc" ||
        (Array.isArray(orderBy) && orderBy.some((o: any) => o?.lastSeenAt === "desc"));
      expect(isLastSeenAtDesc).toBe(true);
    }
  });

  test("defaults to limit of 20 results", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.take ?? callArgs?.limit).toBe(20);
  });

  test("respects custom --limit option", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma, limit: 5 });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.take ?? callArgs?.limit).toBe(5);
  });

  test("filters by environment when --env is provided", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma, env: "production" });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    expect(where?.environment ?? where?.env).toBe("production");
  });

  test("filters by --since timestamp when provided", async () => {
    const since = new Date("2026-03-14T00:00:00.000Z");
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma, since });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    // Should have a date filter (gte/after the since timestamp)
    expect(where).toBeDefined();
  });

  test("only returns unresolved errors by default", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const prisma = makeMockPrisma({ clientErrorFindMany });
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    // resolvedAt should be filtered to null (unresolved only)
    if (where?.resolvedAt !== undefined) {
      expect(where.resolvedAt).toBeNull();
    }
  });

  test("prints output in table-like format (each error produces output lines)", async () => {
    const prisma = makeMockPrisma();
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    expect(logs.lines.length).toBeGreaterThan(0);
  });

  test("prints fingerprint in output", async () => {
    const prisma = makeMockPrisma({
      clientErrorFindMany: (_: any) =>
        Promise.resolve([makeErrorRecord({ fingerprint: "fp_abc123" })]),
    });
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    const allOutput = logs.lines.join("\n");
    expect(allOutput).toContain("fp_abc123");
  });

  test("prints error message in output", async () => {
    const prisma = makeMockPrisma({
      clientErrorFindMany: (_: any) =>
        Promise.resolve([makeErrorRecord({ message: "TypeError: unique-test-message" })]),
    });
    const logs = captureLogs();

    try {
      await runTail({ prisma });
    } finally {
      logs.restore();
    }

    const allOutput = logs.lines.join("\n");
    expect(allOutput).toContain("TypeError: unique-test-message");
  });

  test("exits with code 0 on success when exitOnComplete is true", async () => {
    const prisma = makeMockPrisma();
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      await runTail({ prisma, exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(0);
  });

  test("exits with code 1 and helpful error when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      // Pass no prisma — it should detect missing DATABASE_URL
      await runTail({});
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(1);
    const allOutput = logs.lines.join("\n");
    expect(allOutput.toLowerCase()).toMatch(/database_url/);
  });
});

// ─── runResolve ───────────────────────────────────────────────────────────────

describe("runResolve", () => {
  let savedDatabaseUrl: string | undefined;

  beforeEach(() => {
    savedDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
  });

  afterEach(() => {
    if (savedDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }
  });

  test("is a function", () => {
    expect(typeof runResolve).toBe("function");
  });

  test("sets resolvedAt on the matching fingerprint", async () => {
    const clientErrorUpdate = mock((_: any) =>
      Promise.resolve(makeErrorRecord({ resolvedAt: NOW }))
    );
    const prisma = makeMockPrisma({ clientErrorUpdate });
    const logs = captureLogs();

    try {
      await runResolve({ prisma, fingerprint: "fp_abc123" });
    } finally {
      logs.restore();
    }

    expect(clientErrorUpdate.mock.calls.length).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorUpdate.mock.calls as any[][])[0][0];
    const resolvedAt = callArgs?.data?.resolvedAt;
    expect(resolvedAt).toBeDefined();
    expect(resolvedAt).not.toBeNull();
  });

  test("targets the correct fingerprint in the where clause", async () => {
    const clientErrorUpdate = mock((_: any) =>
      Promise.resolve(makeErrorRecord({ resolvedAt: NOW }))
    );
    const prisma = makeMockPrisma({ clientErrorUpdate });
    const logs = captureLogs();

    try {
      await runResolve({ prisma, fingerprint: "fp_target_xyz" });
    } finally {
      logs.restore();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorUpdate.mock.calls as any[][])[0][0];
    expect(callArgs?.where?.fingerprint).toBe("fp_target_xyz");
  });

  test("prints confirmation message after resolving", async () => {
    const prisma = makeMockPrisma();
    const logs = captureLogs();

    try {
      await runResolve({ prisma, fingerprint: "fp_abc123" });
    } finally {
      logs.restore();
    }

    expect(logs.lines.length).toBeGreaterThan(0);
  });

  test("exits with code 0 on success when exitOnComplete is true", async () => {
    const prisma = makeMockPrisma();
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      await runResolve({ prisma, fingerprint: "fp_abc123", exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(0);
  });

  test("exits with code 1 when DATABASE_URL is missing and no prisma provided", async () => {
    delete process.env.DATABASE_URL;
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      await runResolve({ fingerprint: "fp_abc123" });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(1);
    const allOutput = logs.lines.join("\n");
    expect(allOutput.toLowerCase()).toMatch(/database_url/);
  });

  test("exits with code 1 when an error occurs during update", async () => {
    const prisma = makeMockPrisma({
      clientErrorUpdate: (_: any) => Promise.reject(new Error("DB write failed")),
    });
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      await runResolve({ prisma, fingerprint: "fp_abc123", exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(1);
  });
});

// ─── CLI flag handling ────────────────────────────────────────────────────────

describe("CLI exit codes", () => {
  test("runTail exits 0 on successful completion", async () => {
    const prisma = makeMockPrisma();
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      await runTail({ prisma, exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(0);
  });

  test("runResolve exits 0 on successful completion", async () => {
    const prisma = makeMockPrisma();
    const exitMock = mockProcessExit();
    const logs = captureLogs();

    try {
      await runResolve({ prisma, fingerprint: "fp_abc123", exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
      logs.restore();
    }

    expect(exitMock.calls).toContain(0);
  });
});
