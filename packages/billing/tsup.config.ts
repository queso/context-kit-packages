import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/webhook.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["next", "@prisma/client", "react"],
});
