import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const pkgRoot = resolve(import.meta.dir, "../..");

function readJson(relativePath: string) {
  const fullPath = resolve(pkgRoot, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

function fileExists(relativePath: string) {
  return existsSync(resolve(pkgRoot, relativePath));
}

describe("package.json", () => {
  let pkg: Record<string, unknown>;

  test("package.json exists", () => {
    expect(fileExists("package.json")).toBe(true);
    pkg = readJson("package.json");
  });

  test("name is @context-kit/auth-ui", () => {
    pkg = readJson("package.json");
    expect(pkg.name).toBe("@context-kit/auth-ui");
  });

  test("type is module", () => {
    pkg = readJson("package.json");
    expect(pkg.type).toBe("module");
  });

  test("scripts include build, dev, typecheck, test", () => {
    pkg = readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts).toBeDefined();
    expect(scripts.build).toBe("tsup");
    expect(scripts.dev).toBe("tsup --watch");
    expect(scripts.typecheck).toBe("tsc --noEmit");
    expect(scripts.test).toBe("bun test");
  });

  test("exports has . and ./client and ./cli entries", () => {
    pkg = readJson("package.json");
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports).toBeDefined();
    expect(exports["."]).toBeDefined();
    expect(exports["./client"]).toBeDefined();
    expect(exports["./cli"]).toBeDefined();
  });

  test("peerDependencies includes react >=18, next >=14, @context-kit/auth >=0.1.0", () => {
    pkg = readJson("package.json");
    const peers = pkg.peerDependencies as Record<string, string>;
    expect(peers).toBeDefined();
    expect(peers["react"]).toBeDefined();
    expect(peers["react"]).toMatch(/>=18/);
    expect(peers["next"]).toBeDefined();
    expect(peers["next"]).toMatch(/>=14/);
    expect(peers["@context-kit/auth"]).toBeDefined();
    expect(peers["@context-kit/auth"]).toMatch(/>=0\.1\.0/);
  });

  test("dependencies includes react-hook-form, zod, radix-ui packages, cva, clsx, tailwind-merge, lucide-react", () => {
    pkg = readJson("package.json");
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps).toBeDefined();
    expect(deps["react-hook-form"]).toBeDefined();
    expect(deps["react-hook-form"]).toMatch(/^\^7/);
    expect(deps["zod"]).toBeDefined();
    expect(deps["zod"]).toMatch(/^\^3/);
    expect(deps["@radix-ui/react-avatar"]).toBeDefined();
    expect(deps["@radix-ui/react-dropdown-menu"]).toBeDefined();
    expect(deps["@radix-ui/react-label"]).toBeDefined();
    expect(deps["@radix-ui/react-slot"]).toBeDefined();
    expect(deps["@radix-ui/react-dialog"]).toBeDefined();
    expect(deps["class-variance-authority"]).toBeDefined();
    expect(deps["clsx"]).toBeDefined();
    expect(deps["tailwind-merge"]).toBeDefined();
    expect(deps["lucide-react"]).toBeDefined();
  });

  test("devDependencies includes tsup, typescript, @types/react, @types/bun, react, next, @context-kit/auth, @testing-library/react, @testing-library/jest-dom, happy-dom", () => {
    pkg = readJson("package.json");
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps).toBeDefined();
    expect(devDeps["tsup"]).toBeDefined();
    expect(devDeps["typescript"]).toBeDefined();
    expect(devDeps["@types/react"]).toBeDefined();
    expect(devDeps["@types/bun"]).toBeDefined();
    expect(devDeps["react"]).toBeDefined();
    expect(devDeps["next"]).toBeDefined();
    expect(devDeps["@context-kit/auth"]).toBeDefined();
    expect(devDeps["@testing-library/react"]).toBeDefined();
    expect(devDeps["@testing-library/jest-dom"]).toBeDefined();
    expect(devDeps["happy-dom"]).toBeDefined();
  });

  test("bin field maps auth-ui to ./dist/cli.js", () => {
    pkg = readJson("package.json");
    const bin = pkg.bin as Record<string, string>;
    expect(bin).toBeDefined();
    expect(bin["auth-ui"]).toBe("./dist/cli.js");
  });
});

describe("tsconfig.json", () => {
  test("tsconfig.json exists", () => {
    expect(fileExists("tsconfig.json")).toBe(true);
  });

  test("tsconfig.json has jsx: react-jsx", () => {
    const tsconfig = readJson("tsconfig.json");
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions).toBeDefined();
    expect(compilerOptions["jsx"]).toBe("react-jsx");
  });
});

describe("tsup.config.ts", () => {
  test("tsup.config.ts exists", () => {
    expect(fileExists("tsup.config.ts")).toBe(true);
  });

  test("tsup.config.ts contains entry points for index, client, and cli", () => {
    const content = readFileSync(resolve(pkgRoot, "tsup.config.ts"), "utf-8");
    expect(content).toContain("index");
    expect(content).toContain("client");
    expect(content).toContain("cli");
  });

  test("tsup.config.ts uses ESM format", () => {
    const content = readFileSync(resolve(pkgRoot, "tsup.config.ts"), "utf-8");
    expect(content).toContain("esm");
  });

  test("tsup.config.ts has dts enabled", () => {
    const content = readFileSync(resolve(pkgRoot, "tsup.config.ts"), "utf-8");
    expect(content).toContain("dts");
  });

  test("tsup.config.ts externals include react, next, @context-kit/auth", () => {
    const content = readFileSync(resolve(pkgRoot, "tsup.config.ts"), "utf-8");
    expect(content).toContain("react");
    expect(content).toContain("next");
    expect(content).toContain("@context-kit/auth");
  });
});

describe("directory structure", () => {
  test("src/components/ directory exists", () => {
    expect(fileExists("src/components")).toBe(true);
  });

  test("src/components/ui/ directory exists", () => {
    expect(fileExists("src/components/ui")).toBe(true);
  });

  test("src/lib/ directory exists", () => {
    expect(fileExists("src/lib")).toBe(true);
  });

  test("src/__tests__/ directory exists", () => {
    expect(fileExists("src/__tests__")).toBe(true);
  });
});

describe("entry point files", () => {
  test("src/index.ts exists", () => {
    expect(fileExists("src/index.ts")).toBe(true);
  });

  test("src/client.ts exists", () => {
    expect(fileExists("src/client.ts")).toBe(true);
  });

  test("src/cli.ts exists", () => {
    expect(fileExists("src/cli.ts")).toBe(true);
  });
});

describe("build and typecheck", () => {
  test("bun build succeeds", () => {
    expect(() => {
      execSync("bun run build", {
        cwd: pkgRoot,
        stdio: "pipe",
      });
    }).not.toThrow();
  });

  test("bun typecheck succeeds", () => {
    expect(() => {
      execSync("bun run typecheck", {
        cwd: pkgRoot,
        stdio: "pipe",
      });
    }).not.toThrow();
  });
});
