import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { is, Table } from "drizzle-orm";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, "../..");

const pkgSource = readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8");
const pkg = JSON.parse(pkgSource) as {
  name: string;
  version: string;
  type: string;
  files: string[];
  scripts: Record<string, string>;
  exports: Record<string, Record<string, string>>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  bin: Record<string, string>;
};

describe("@context-kit/error-tracker package identity", () => {
  test("is the scoped ESM package consumers install", () => {
    expect(pkg.name).toBe("@context-kit/error-tracker");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.type).toBe("module");
  });

  test("ships only the built output and the readme", () => {
    expect(pkg.files).toEqual(["dist", "README.md"]);
  });

  test("exposes build, dev, typecheck and test scripts", () => {
    expect(pkg.scripts.build).toContain("tsup");
    expect(pkg.scripts.dev).toContain("tsup");
    expect(pkg.scripts.typecheck).toContain("tsc");
    expect(pkg.scripts.test).toContain("bun test");
  });

  test("installs an error-tracker binary", () => {
    expect(pkg.bin["error-tracker"]).toBe("./dist/cli.js");
  });
});

describe("@context-kit/error-tracker subpath exports", () => {
  test.each([
    [".", "./dist/index"],
    ["./server", "./dist/server"],
    ["./cli", "./dist/cli"],
    ["./schema/sqlite", "./dist/schema/sqlite"],
    ["./schema/postgres", "./dist/schema/postgres"],
  ])("%s resolves to %s with types, import and default conditions", (subpath, file) => {
    // Consumers re-export the schema subpaths from their own
    // db/schema/<dialect>.ts, and drizzle-kit resolves them through a CommonJS
    // loader, which needs the `default` condition on top of `types` and `import`.
    const entry = pkg.exports[subpath];
    expect(entry).toBeDefined();
    expect(entry.types).toBe(`${file}.d.ts`);
    expect(entry.import).toBe(`${file}.js`);
    expect(entry.default).toBe(`${file}.js`);
  });

  test("no longer exports a Prisma subpath", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./cli",
      "./schema/postgres",
      "./schema/sqlite",
      "./server",
    ]);
  });
});

describe("@context-kit/error-tracker dependencies", () => {
  test("drizzle-orm is a peer dependency", () => {
    expect(pkg.peerDependencies["drizzle-orm"]).toBe(">=0.41.0");
  });

  test.each([
    ["@libsql/client", ">=0.14.0"],
    ["postgres", ">=3.4.0"],
  ])("%s is an optional peer, not a dependency", (driver, range) => {
    expect(pkg.peerDependencies[driver]).toBe(range);
    expect(pkg.dependencies[driver]).toBeUndefined();
  });

  test("source-map is the only runtime dependency", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["source-map"]);
  });

  test("Prisma is gone from the whole manifest", () => {
    // A leftover dependency, peer or devDependency would keep pulling the
    // Prisma client into consumers' installs after the Drizzle port.
    expect(pkgSource).not.toContain("prisma");
    expect(pkgSource).not.toContain("Prisma");
  });
});

describe("@context-kit/error-tracker typescript config", () => {
  const tsconfigPath = resolve(PACKAGE_ROOT, "tsconfig.json");

  test("compiles in strict mode", () => {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });
});

describe("@context-kit/error-tracker build output", () => {
  // One build for the whole describe block; the assertions below read what it
  // produced rather than only checking that config files exist.
  // execFileSync throws when tsup exits non-zero, so the whole block fails
  // rather than asserting against stale dist/ output from an earlier run.
  execFileSync("bun", ["--filter", "@context-kit/error-tracker", "build"], {
    cwd: MONOREPO_ROOT,
    encoding: "utf-8",
    stdio: "pipe",
  });

  test.each([
    "dist/index.js",
    "dist/index.d.ts",
    "dist/server.js",
    "dist/server.d.ts",
    "dist/cli.js",
    "dist/schema/sqlite.js",
    "dist/schema/sqlite.d.ts",
    "dist/schema/postgres.js",
    "dist/schema/postgres.d.ts",
  ])("emits %s", (file) => {
    expect(existsSync(resolve(PACKAGE_ROOT, file))).toBe(true);
  });

  test("the built index entry exports the client-side factory", async () => {
    const mod = await import(resolve(PACKAGE_ROOT, "dist/index.js"));
    expect(typeof mod.createErrorTracker).toBe("function");
  });

  test("the built server entry exports the route-handler factories", async () => {
    const mod = await import(resolve(PACKAGE_ROOT, "dist/server.js"));
    expect(typeof mod.createErrorHandlers).toBe("function");
    expect(typeof mod.createIngestionHandler).toBe("function");
    expect(typeof mod.createQueryHandler).toBe("function");
  });

  test.each(["dist/schema/sqlite.js", "dist/schema/postgres.js"])(
    "%s exports the clientError table so drizzle-kit can read it",
    async (file) => {
      const mod = await import(resolve(PACKAGE_ROOT, file));
      expect(is(mod.clientError, Table)).toBe(true);
    }
  );
});

describe("@context-kit/error-tracker workspace registration", () => {
  test("the workspace glob covers the package directory", () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(MONOREPO_ROOT, "package.json"), "utf-8")
    ) as { workspaces: string[] };
    expect(rootPkg.workspaces).toContain("packages/*");
  });
});
