import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/client.ts",
    "src/middleware.ts",
    "src/schema/sqlite.ts",
    "src/schema/postgres.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["next", "drizzle-orm", "react"],
});
