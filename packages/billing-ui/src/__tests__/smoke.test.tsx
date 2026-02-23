import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";

const projectRoot = resolve(import.meta.dir, "../../../..");

describe("@context-kit/billing-ui package smoke tests", () => {
  test("package typechecks without errors", async () => {
    const result = await $`bun --filter @context-kit/billing-ui typecheck`
      .cwd(projectRoot)
      .nothrow();
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("package builds successfully and produces dist/", async () => {
    const result = await $`bun --filter @context-kit/billing-ui build`
      .cwd(projectRoot)
      .nothrow();
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("dist/ contains expected entry points after build", async () => {
    const distIndex = Bun.file(resolve(import.meta.dir, "../../dist/index.js"));
    const distClient = Bun.file(
      resolve(import.meta.dir, "../../dist/client.js")
    );
    expect(await distIndex.exists()).toBe(true);
    expect(await distClient.exists()).toBe(true);
  });
});
