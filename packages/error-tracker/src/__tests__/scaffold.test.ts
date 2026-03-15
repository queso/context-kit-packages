import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, "../..");

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("@context-kit/error-tracker package.json", () => {
  const pkgPath = resolve(PACKAGE_ROOT, "package.json");

  test("package.json exists", () => {
    expect(existsSync(pkgPath)).toBe(true);
  });

  test("name is @context-kit/error-tracker", () => {
    const pkg = readJson(pkgPath);
    expect(pkg.name).toBe("@context-kit/error-tracker");
  });

  test("version is 0.1.0", () => {
    const pkg = readJson(pkgPath);
    expect(pkg.version).toBe("0.1.0");
  });

  test("type is module", () => {
    const pkg = readJson(pkgPath);
    expect(pkg.type).toBe("module");
  });

  test("has test script using bun test", () => {
    const pkg = readJson(pkgPath);
    const scripts = pkg.scripts as Record<string, string>;
    expect(typeof scripts?.test).toBe("string");
    expect(scripts.test).toContain("bun test");
  });

  test("has build script using tsup", () => {
    const pkg = readJson(pkgPath);
    const scripts = pkg.scripts as Record<string, string>;
    expect(typeof scripts?.build).toBe("string");
    expect(scripts.build).toContain("tsup");
  });

  test("has typecheck script", () => {
    const pkg = readJson(pkgPath);
    const scripts = pkg.scripts as Record<string, string>;
    expect(typeof scripts?.typecheck).toBe("string");
    expect(scripts.typecheck).toContain("tsc");
  });

  test("has . export (main entry point)", () => {
    const pkg = readJson(pkgPath);
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports?.["."]).toBeDefined();
  });

  test("has ./server export", () => {
    const pkg = readJson(pkgPath);
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports?.["./server"]).toBeDefined();
  });

  test("has ./prisma export", () => {
    const pkg = readJson(pkgPath);
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports?.["./prisma"]).toBeDefined();
  });

  test("peerDependencies includes @prisma/client >=5.0.0", () => {
    const pkg = readJson(pkgPath);
    const peers = pkg.peerDependencies as Record<string, string>;
    expect(peers?.["@prisma/client"]).toBeDefined();
    expect(peers["@prisma/client"]).toMatch(/>=5/);
  });

  test("peerDependencies includes next >=14.0.0", () => {
    const pkg = readJson(pkgPath);
    const peers = pkg.peerDependencies as Record<string, string>;
    expect(peers?.["next"]).toBeDefined();
    expect(peers["next"]).toMatch(/>=14/);
  });

  test("peerDependencies includes react >=18.0.0", () => {
    const pkg = readJson(pkgPath);
    const peers = pkg.peerDependencies as Record<string, string>;
    expect(peers?.["react"]).toBeDefined();
    expect(peers["react"]).toMatch(/>=18/);
  });

  test("peerDependencies includes react-dom >=18.0.0", () => {
    const pkg = readJson(pkgPath);
    const peers = pkg.peerDependencies as Record<string, string>;
    expect(peers?.["react-dom"]).toBeDefined();
    expect(peers["react-dom"]).toMatch(/>=18/);
  });

  test("dependencies includes source-map", () => {
    const pkg = readJson(pkgPath);
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps?.["source-map"]).toBeDefined();
  });
});

describe("@context-kit/error-tracker tsconfig.json", () => {
  const tsconfigPath = resolve(PACKAGE_ROOT, "tsconfig.json");

  test("tsconfig.json exists", () => {
    expect(existsSync(tsconfigPath)).toBe(true);
  });

  test("extends a workspace base config or includes strict: true", () => {
    const tsconfig = readJson(tsconfigPath);
    const strict =
      (tsconfig.compilerOptions as Record<string, unknown>)?.strict === true ||
      typeof tsconfig.extends === "string";
    expect(strict).toBe(true);
  });

  test("strict mode is enabled", () => {
    const tsconfig = readJson(tsconfigPath);
    const opts = tsconfig.compilerOptions as Record<string, unknown>;
    expect(opts?.strict).toBe(true);
  });
});

describe("@context-kit/error-tracker tsup.config.ts", () => {
  test("tsup.config.ts exists", () => {
    expect(existsSync(resolve(PACKAGE_ROOT, "tsup.config.ts"))).toBe(true);
  });

  test("tsup config references index.ts entry point", () => {
    const content = readFileSync(resolve(PACKAGE_ROOT, "tsup.config.ts"), "utf-8");
    expect(content).toContain("index.ts");
  });

  test("tsup config references server.ts entry point", () => {
    const content = readFileSync(resolve(PACKAGE_ROOT, "tsup.config.ts"), "utf-8");
    expect(content).toContain("server.ts");
  });
});

describe("@context-kit/error-tracker source barrel files", () => {
  test("src/index.ts exists", () => {
    expect(existsSync(resolve(PACKAGE_ROOT, "src/index.ts"))).toBe(true);
  });

  test("src/server.ts exists", () => {
    expect(existsSync(resolve(PACKAGE_ROOT, "src/server.ts"))).toBe(true);
  });
});

describe("@context-kit/error-tracker workspace registration", () => {
  test("workspace root package.json workspaces glob covers packages/*", () => {
    const rootPkgPath = resolve(MONOREPO_ROOT, "package.json");
    const rootPkg = readJson(rootPkgPath);
    const workspaces = rootPkg.workspaces as string[];
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.some((w) => w === "packages/*" || w.startsWith("packages/"))).toBe(true);
  });
});

describe("@context-kit/error-tracker build output", () => {
  test("package builds successfully", () => {
    const result = execSync(
      "bun --filter @context-kit/error-tracker build",
      { cwd: MONOREPO_ROOT, stdio: "pipe" }
    );
    expect(result).toBeDefined();
  }, 30000);

  test("dist/index.js exists after build", () => {
    expect(existsSync(resolve(PACKAGE_ROOT, "dist/index.js"))).toBe(true);
  });

  test("dist/server.js exists after build", () => {
    expect(existsSync(resolve(PACKAGE_ROOT, "dist/server.js"))).toBe(true);
  });

  test("main entry point can be imported without error", async () => {
    const mod = await import(resolve(PACKAGE_ROOT, "dist/index.js"));
    expect(mod).toBeDefined();
  });
});
