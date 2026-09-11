import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import type { AuthDialect } from "../index";

describe("barrel exports", () => {
  test("index module exports createAuth, toNextJsHandler, getSession, getUser", async () => {
    const indexModule = await import("../index");
    expect(typeof indexModule.createAuth).toBe("function");
    expect(typeof indexModule.toNextJsHandler).toBe("function");
    expect(typeof indexModule.getSession).toBe("function");
    expect(typeof indexModule.getUser).toBe("function");
  });

  test("middleware module exports createAuthMiddleware", async () => {
    const middlewareModule = await import("../middleware");
    expect(typeof middlewareModule.createAuthMiddleware).toBe("function");
  });

  test("client module exports createAuthClient", async () => {
    const clientModule = await import("../client");
    expect(typeof clientModule.createAuthClient).toBe("function");
  });
});

describe("package.json subpath exports", () => {
  const pkg = require(resolve(import.meta.dir, "../../package.json")) as {
    exports: Record<string, Record<string, string>>;
    peerDependencies: Record<string, string>;
  };

  // Consumers re-export these from their own db/schema/<dialect>.ts, and
  // drizzle-kit resolves them through a CommonJS loader, which needs the
  // `default` condition on top of `types` and `import`.
  test.each(["./schema/sqlite", "./schema/postgres"])(
    "%s is exported with types, import, and default conditions",
    (subpath) => {
      const entry = pkg.exports[subpath];
      expect(entry).toBeDefined();
      const file = subpath.replace("./", "./dist/");
      expect(entry.types).toBe(`${file}.d.ts`);
      expect(entry.import).toBe(`${file}.js`);
      expect(entry.default).toBe(`${file}.js`);
    }
  );

  test("drizzle-orm is a peer dependency", () => {
    expect(pkg.peerDependencies["drizzle-orm"]).toBe(">=0.41.0");
  });
});

// `AuthDialect` is a type-only export, so the barrel re-export is checked by
// `tsc --noEmit`, not at runtime: the `import type` above and this `satisfies`
// both fail to compile if `index.ts` stops exporting it. There is nothing a
// runtime assertion could add, so none is made.
"sqlite" satisfies AuthDialect;
