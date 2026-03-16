import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "react",
    "next",
    "@context-kit/billing",
    "@stripe/react-stripe-js",
    "@stripe/stripe-js",
  ],
});
