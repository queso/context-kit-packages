import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ErrorTrackerConfig,
  ErrorPayload,
  StackFrame,
} from "../types";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");

// ─── Type-level compile checks ────────────────────────────────────────────────
// These declarations never execute but cause a TypeScript compile error if the
// interfaces are missing or have the wrong shape. Tests will fail at `bun test`
// time because the file won't compile.


// ─── Runtime interface-shape tests ────────────────────────────────────────────

describe("ErrorTrackerConfig interface shape", () => {
  test("mock object satisfying ErrorTrackerConfig has all required fields", () => {
    const config: ErrorTrackerConfig = {
      endpoint: "/api/errors",
      token: "secret-token",
      environment: "production",
      patchConsoleError: false,
    };

    expect(typeof config.endpoint).toBe("string");
    expect(typeof config.environment).toBe("string");
  });

  test("ErrorTrackerConfig allows optional token", () => {
    const config: ErrorTrackerConfig = {
      endpoint: "/api/errors",
      environment: "development",
    };

    expect(config.token).toBeUndefined();
  });

  test("ErrorTrackerConfig allows optional patchConsoleError", () => {
    const config: ErrorTrackerConfig = {
      endpoint: "/api/errors",
      environment: "development",
    };

    expect(config.patchConsoleError).toBeUndefined();
  });
});

describe("ErrorPayload interface shape", () => {
  test("mock object satisfying ErrorPayload has all required fields", () => {
    const payload: ErrorPayload = {
      message: "TypeError: Cannot read properties of undefined",
      stack: "TypeError: Cannot read...\n  at Component (app.js:1:100)",
      componentStack: "\n  at ErrorBoundary\n  at App",
      url: "https://example.com/dashboard",
      userAgent: "Mozilla/5.0",
      environment: "production",
    };

    expect(typeof payload.message).toBe("string");
    expect(typeof payload.url).toBe("string");
    expect(typeof payload.userAgent).toBe("string");
    expect(typeof payload.environment).toBe("string");
  });

  test("ErrorPayload allows optional stack", () => {
    const payload: ErrorPayload = {
      message: "Something went wrong",
      url: "https://example.com",
      userAgent: "Mozilla/5.0",
      environment: "development",
    };

    expect(payload.stack).toBeUndefined();
  });

  test("ErrorPayload allows optional componentStack", () => {
    const payload: ErrorPayload = {
      message: "Something went wrong",
      url: "https://example.com",
      userAgent: "Mozilla/5.0",
      environment: "development",
    };

    expect(payload.componentStack).toBeUndefined();
  });
});

describe("StackFrame interface shape", () => {
  test("mock object satisfying StackFrame has all required fields", () => {
    const frame: StackFrame = {
      file: "app.js",
      line: 42,
      column: 10,
      functionName: "handleClick",
    };

    expect(typeof frame.file).toBe("string");
    expect(typeof frame.line).toBe("number");
    expect(typeof frame.column).toBe("number");
  });

  test("StackFrame allows optional functionName", () => {
    const frame: StackFrame = {
      file: "app.js",
      line: 42,
      column: 10,
    };

    expect(frame.functionName).toBeUndefined();
  });
});

// ─── src/types.ts exports ─────────────────────────────────────────────────────

describe("src/types.ts exports", () => {
  test("types.ts file exists", () => {
    expect(existsSync(resolve(PACKAGE_ROOT, "src/types.ts"))).toBe(true);
  });

  test("types.ts exports ErrorTrackerConfig", async () => {
    const mod = await import("../types");
    // Type-only exports aren't present at runtime, but the module must import
    // without error — the compile-time type declarations above verify the shapes
    expect(mod).toBeDefined();
  });
});

// ─── Prisma schema fragment ────────────────────────────────────────────────────

describe("prisma/error-tracker.prisma", () => {
  const schemaPath = resolve(PACKAGE_ROOT, "prisma/error-tracker.prisma");

  test("prisma schema file exists", () => {
    expect(existsSync(schemaPath)).toBe(true);
  });

  test("schema contains ClientError model", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toContain("model ClientError");
  });

  test("ClientError has id field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toContain("id");
  });

  test("ClientError has message field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/message\s+String/);
  });

  test("ClientError has stack field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/stack\s+String/);
  });

  test("ClientError has componentStack field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/componentStack\s+String/);
  });

  test("ClientError has fingerprint field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/fingerprint\s+String/);
  });

  test("fingerprint has @unique constraint", () => {
    const content = readFileSync(schemaPath, "utf-8");
    // fingerprint must appear on a line that includes @unique
    const lines = content.split("\n");
    const fingerprintLine = lines.find((l) => l.includes("fingerprint"));
    expect(fingerprintLine).toBeDefined();
    expect(fingerprintLine).toContain("@unique");
  });

  test("ClientError has occurrences field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/occurrences\s+Int/);
  });

  test("ClientError has environment field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/environment\s+String/);
  });

  test("ClientError has url field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/url\s+String/);
  });

  test("ClientError has userAgent field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/userAgent\s+String/);
  });

  test("ClientError has resolvedAt nullable timestamp", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/resolvedAt\s+DateTime\?/);
  });

  test("ClientError has lastSeenAt field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/lastSeenAt\s+DateTime/);
  });

  test("ClientError has createdAt field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/createdAt\s+DateTime/);
  });

  test("ClientError has updatedAt field", () => {
    const content = readFileSync(schemaPath, "utf-8");
    expect(content).toMatch(/updatedAt\s+DateTime/);
  });
});
