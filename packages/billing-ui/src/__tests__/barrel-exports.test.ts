import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";

const projectRoot = resolve(import.meta.dir, "../../../..");
const pkgSrc = resolve(import.meta.dir, "..");

describe("@context-kit/billing-ui barrel exports", () => {
  test("build produces dist/index.js and dist/client.js", async () => {
    const result = await $`bun --filter @context-kit/billing-ui build`
      .cwd(projectRoot)
      .nothrow();
    expect(result.exitCode).toBe(0);

    const distIndex = Bun.file(resolve(pkgSrc, "../dist/index.js"));
    const distClient = Bun.file(resolve(pkgSrc, "../dist/client.js"));
    expect(await distIndex.exists()).toBe(true);
    expect(await distClient.exists()).toBe(true);
  }, 30_000);

  test("index.ts exports page components, CheckoutSuccess, and types — NOT client-only components", async () => {
    const source = await Bun.file(resolve(pkgSrc, "index.ts")).text();

    // Page components belong in index (server-safe re-exports)
    expect(source).toContain("PricingPage");
    expect(source).toContain("CheckoutPage");
    expect(source).toContain("CheckoutSuccessPage");

    // CheckoutSuccess (the inner component) in index
    expect(source).toContain("CheckoutSuccess");

    // Types re-exported from index
    expect(source).toContain("PlanDefinition");

    // Client-only components must NOT be in index.ts
    expect(source).not.toContain("BillingProvider");
    expect(source).not.toContain("PricingCard");
    expect(source).not.toContain("PricingTable");
    expect(source).not.toContain("IntervalToggle");
    expect(source).not.toContain("EmbeddedCheckout");
    expect(source).not.toContain("useBilling");
  });

  test("client.ts exports client components and hook — NOT page components", async () => {
    const source = await Bun.file(resolve(pkgSrc, "client.ts")).text();

    // Client-only components/hooks
    expect(source).toContain("BillingProvider");
    expect(source).toContain("PricingTable");
    expect(source).toContain("PricingCard");
    expect(source).toContain("IntervalToggle");
    expect(source).toContain("EmbeddedCheckout");
    expect(source).toContain("useBilling");

    // Page-level wrappers should not be in client.ts
    expect(source).not.toContain("PricingPage");
    expect(source).not.toContain("CheckoutPage");
    expect(source).not.toContain("CheckoutSuccessPage");
  });
});
