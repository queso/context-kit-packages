import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// The CLI module must export a `scaffold` function that can be called
// programmatically. The CLI entry point (`src/cli.ts`) should export:
//
//   export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult>
//
// Where:
//   ScaffoldOptions = {
//     cwd: string;           // project root to scaffold into
//     path?: string;         // optional route group, e.g. "(auth)"
//     providers?: string[];  // e.g. ["google", "github"]
//     force?: boolean;       // overwrite existing files
//   }
//
//   ScaffoldResult = {
//     written: string[];     // paths written
//     skipped: string[];     // paths skipped (already existed, no --force)
//     appDir: string;        // resolved app directory used
//   }
// ---------------------------------------------------------------------------

// Expected route file names (relative to appDir + optional path segment)
const ROUTE_FILES = [
  "sign-in/page.tsx",
  "sign-up/page.tsx",
  "forgot-password/page.tsx",
  "reset-password/page.tsx",
  "profile/page.tsx",
  "profile/password/page.tsx",
  "profile/sessions/page.tsx",
];

// Pages that get providers prop when --providers is set
const PROVIDER_PAGES = ["sign-in/page.tsx", "sign-up/page.tsx"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "auth-ui-cli-test-"));
}

function setupNextProject(root: string, appDirName: "app" | "src/app" = "app"): void {
  // package.json at root signals a valid Next.js project
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "my-app", dependencies: { next: "^14.0.0" } }, null, 2)
  );
  // Create the app directory
  const appPath = join(root, ...appDirName.split("/"));
  mkdirSync(appPath, { recursive: true });
}

function readRoute(root: string, appDirName: string, routeFile: string, pathPrefix = ""): string {
  const filePath = pathPrefix
    ? join(root, appDirName, pathPrefix, routeFile)
    : join(root, appDirName, routeFile);
  return readFileSync(filePath, "utf-8");
}

function routeExists(root: string, appDirName: string, routeFile: string, pathPrefix = ""): boolean {
  const filePath = pathPrefix
    ? join(root, appDirName, pathPrefix, routeFile)
    : join(root, appDirName, routeFile);
  return existsSync(filePath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI file structure", () => {
  test("src/cli.ts exports a scaffold function", async () => {
    const mod = await import("../cli");
    expect(typeof mod.scaffold).toBe("function");
  });
});

describe("app directory detection", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects app/ at project root", async () => {
    setupNextProject(tmpDir, "app");
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.appDir).toBe(join(tmpDir, "app"));
  });

  test("detects src/app/ when app/ does not exist", async () => {
    setupNextProject(tmpDir, "src/app");
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.appDir).toBe(join(tmpDir, "src", "app"));
  });

  test("prefers app/ over src/app/ when both exist", async () => {
    setupNextProject(tmpDir, "app");
    mkdirSync(join(tmpDir, "src", "app"), { recursive: true });
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.appDir).toBe(join(tmpDir, "app"));
  });

  test("throws when neither app/ nor src/app/ exists", async () => {
    // Has package.json but no app directory
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "no-app" }));
    const { scaffold } = await import("../cli");
    await expect(scaffold({ cwd: tmpDir })).rejects.toThrow(/app/i);
  });

  test("throws when no package.json exists", async () => {
    // Has app/ but no package.json
    mkdirSync(join(tmpDir, "app"), { recursive: true });
    const { scaffold } = await import("../cli");
    await expect(scaffold({ cwd: tmpDir })).rejects.toThrow(/package\.json/i);
  });
});

describe("scaffolds all 7 route files", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    setupNextProject(tmpDir, "app");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates all 7 route files", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.written).toHaveLength(7);
    for (const routeFile of ROUTE_FILES) {
      expect(routeExists(tmpDir, "app", routeFile)).toBe(true);
    }
  });

  test("result.written contains paths for all 7 files", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    for (const routeFile of ROUTE_FILES) {
      const expected = join(tmpDir, "app", routeFile);
      expect(result.written).toContain(expected);
    }
  });

  test("result.skipped is empty on a fresh scaffold", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.skipped).toHaveLength(0);
  });
});

describe("generated file content — no providers", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    setupNextProject(tmpDir, "app");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sign-in page is a one-line re-export of SignInPage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "sign-in/page.tsx");
    expect(content).toContain("SignInPage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("sign-up page is a one-line re-export of SignUpPage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "sign-up/page.tsx");
    expect(content).toContain("SignUpPage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("forgot-password page is a one-line re-export of ForgotPasswordPage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "forgot-password/page.tsx");
    expect(content).toContain("ForgotPasswordPage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("reset-password page is a one-line re-export of ResetPasswordPage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "reset-password/page.tsx");
    expect(content).toContain("ResetPasswordPage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("profile page is a one-line re-export of ProfilePage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "profile/page.tsx");
    expect(content).toContain("ProfilePage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("profile/password page is a one-line re-export of ProfilePasswordPage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "profile/password/page.tsx");
    expect(content).toContain("ProfilePasswordPage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("profile/sessions page is a one-line re-export of ProfileSessionsPage", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const content = readRoute(tmpDir, "app", "profile/sessions/page.tsx");
    expect(content).toContain("ProfileSessionsPage");
    expect(content).toContain("@context-kit/auth-ui");
    expect(content).toContain("export");
    expect(content).toContain("default");
  });

  test("no file contains a providers prop when --providers is not set", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    for (const routeFile of ROUTE_FILES) {
      const content = readRoute(tmpDir, "app", routeFile);
      // Should not have providers prop JSX inline — pure re-export pattern
      expect(content).not.toMatch(/providers\s*=/);
    }
  });
});

describe("--providers flag", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    setupNextProject(tmpDir, "app");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sign-in page includes providers prop when --providers is set", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir, providers: ["google", "github"] });
    const content = readRoute(tmpDir, "app", "sign-in/page.tsx");
    expect(content).toMatch(/providers/);
    expect(content).toMatch(/google|github/i);
  });

  test("sign-up page includes providers prop when --providers is set", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir, providers: ["google", "github"] });
    const content = readRoute(tmpDir, "app", "sign-up/page.tsx");
    expect(content).toMatch(/providers/);
    expect(content).toMatch(/google|github/i);
  });

  test("non-provider pages remain one-line re-exports even with --providers", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir, providers: ["google"] });

    const nonProviderRoutes = ROUTE_FILES.filter((f) => !PROVIDER_PAGES.includes(f));
    for (const routeFile of nonProviderRoutes) {
      const content = readRoute(tmpDir, "app", routeFile);
      // Should still be a simple re-export, not a wrapper component
      expect(content).toContain("@context-kit/auth-ui");
      expect(content).not.toMatch(/providers\s*=/);
    }
  });

  test("single provider is handled without error", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir, providers: ["google"] });
    expect(result.written).toHaveLength(7);
    const content = readRoute(tmpDir, "app", "sign-in/page.tsx");
    expect(content).toMatch(/google/i);
  });

  test("multiple providers are all reflected in generated output", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir, providers: ["google", "github", "discord"] });
    const content = readRoute(tmpDir, "app", "sign-in/page.tsx");
    expect(content).toMatch(/google/i);
    expect(content).toMatch(/github/i);
    expect(content).toMatch(/discord/i);
  });
});

describe("--path flag (route groups)", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    setupNextProject(tmpDir, "app");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("scaffolds files under the provided path segment", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir, path: "(auth)" });
    expect(result.appDir).toBe(join(tmpDir, "app"));
    for (const routeFile of ROUTE_FILES) {
      expect(routeExists(tmpDir, "app", routeFile, "(auth)")).toBe(true);
    }
  });

  test("result.written paths include the path segment", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir, path: "(auth)" });
    for (const routeFile of ROUTE_FILES) {
      const expected = join(tmpDir, "app", "(auth)", routeFile);
      expect(result.written).toContain(expected);
    }
  });

  test("nested path segment is created if it does not exist", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir, path: "(auth)" });
    expect(existsSync(join(tmpDir, "app", "(auth)"))).toBe(true);
  });

  test("scaffold without --path puts files directly in appDir", async () => {
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    // No path segment in written paths beyond appDir
    for (const written of result.written) {
      // All written paths should start with appDir
      expect(written.startsWith(join(tmpDir, "app"))).toBe(true);
    }
  });
});

describe("--force flag and conflict handling", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    setupNextProject(tmpDir, "app");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("skips existing files without --force", async () => {
    const { scaffold } = await import("../cli");
    // First scaffold
    await scaffold({ cwd: tmpDir });
    // Write a sentinel to one file
    const signInPath = join(tmpDir, "app", "sign-in", "page.tsx");
    writeFileSync(signInPath, "// sentinel content");
    // Second scaffold without force
    const result = await scaffold({ cwd: tmpDir });
    expect(result.skipped).toContain(signInPath);
    // File content should be unchanged
    expect(readFileSync(signInPath, "utf-8")).toBe("// sentinel content");
  });

  test("result.skipped lists all pre-existing files when no --force", async () => {
    const { scaffold } = await import("../cli");
    // First scaffold creates all 7
    await scaffold({ cwd: tmpDir });
    // Second scaffold: all 7 should be skipped
    const result = await scaffold({ cwd: tmpDir });
    expect(result.skipped).toHaveLength(7);
    expect(result.written).toHaveLength(0);
  });

  test("overwrites existing files with --force", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const signInPath = join(tmpDir, "app", "sign-in", "page.tsx");
    writeFileSync(signInPath, "// sentinel content");
    // Second scaffold with force
    const result = await scaffold({ cwd: tmpDir, force: true });
    expect(result.written).toContain(signInPath);
    expect(result.skipped).not.toContain(signInPath);
    // Sentinel should be gone
    expect(readFileSync(signInPath, "utf-8")).not.toBe("// sentinel content");
  });

  test("--force overwrites all 7 files", async () => {
    const { scaffold } = await import("../cli");
    await scaffold({ cwd: tmpDir });
    const result = await scaffold({ cwd: tmpDir, force: true });
    expect(result.written).toHaveLength(7);
    expect(result.skipped).toHaveLength(0);
  });

  test("partial pre-existence: only existing files are skipped", async () => {
    const { scaffold } = await import("../cli");
    // Pre-create just the sign-in directory and file
    mkdirSync(join(tmpDir, "app", "sign-in"), { recursive: true });
    writeFileSync(join(tmpDir, "app", "sign-in", "page.tsx"), "// existing");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.skipped).toHaveLength(1);
    expect(result.written).toHaveLength(6);
  });
});

describe("src/app detection", () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("scaffolds all 7 files into src/app/ when that is the detected dir", async () => {
    setupNextProject(tmpDir, "src/app");
    const { scaffold } = await import("../cli");
    const result = await scaffold({ cwd: tmpDir });
    expect(result.appDir).toBe(join(tmpDir, "src", "app"));
    expect(result.written).toHaveLength(7);
    for (const routeFile of ROUTE_FILES) {
      expect(routeExists(tmpDir, "src/app", routeFile)).toBe(true);
    }
  });
});
