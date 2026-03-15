import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["next", "@prisma/client", "react", "react-dom"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
