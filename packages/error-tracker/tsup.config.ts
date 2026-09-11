import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/cli.ts",
    "src/schema/sqlite.ts",
    "src/schema/postgres.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Database drivers are optional peers loaded on demand by the CLI; they must
  // never be bundled into dist.
  external: [
    "next",
    "react",
    "react-dom",
    "drizzle-orm",
    "@libsql/client",
    "postgres",
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
