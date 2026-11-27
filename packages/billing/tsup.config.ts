import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/schema/postgres.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["drizzle-orm", "stripe"],
});
