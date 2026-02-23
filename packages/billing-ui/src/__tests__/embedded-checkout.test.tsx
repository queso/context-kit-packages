import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";

// ---------------------------------------------------------------------------
// Mock @stripe/react-stripe-js -- do NOT load real Stripe in tests
// ---------------------------------------------------------------------------

// Track EmbeddedCheckoutProvider calls so we can assert on options (e.g. returnUrl)
const providerCalls: Array<Record<string, unknown>> = [];

mock.module("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: (props: {
    children: React.ReactNode;
    options?: Record<string, unknown>;
    stripe?: unknown;
  }) => {
    providerCalls.push(props);
    return <div data-testid="stripe-provider">{props.children}</div>;
  },
  EmbeddedCheckout: () => (
    <div data-testid="stripe-embedded-checkout">Stripe Checkout Form</div>
  ),
}));

mock.module("@stripe/stripe-js", () => ({
  loadStripe: mock(() =>
    Promise.resolve({
      /* mock stripe object */
    })
  ),
}));

// ---------------------------------------------------------------------------
// EmbeddedCheckout
// ---------------------------------------------------------------------------

describe("EmbeddedCheckout", () => {
  test("renders loading state initially while fetching client secret", async () => {
    const { EmbeddedCheckout } = await import(
      "../components/embedded-checkout"
    );

    // fetchClientSecret that never resolves immediately — stays in loading
    let _resolveSecret: (s: string) => void;
    const fetchClientSecret = () =>
      new Promise<string>((resolve) => {
        _resolveSecret = resolve;
      });

    render(
      <EmbeddedCheckout
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
      />
    );

    // Should show some loading indicator before the secret resolves
    const container = screen.getByTestId ? document.body : document.body;
    const text = container.textContent ?? "";
    const hasLoadingIndicator =
      text.toLowerCase().includes("load") ||
      document.querySelector("[data-testid='loading']") !== null ||
      document.querySelector("[aria-busy='true']") !== null ||
      document.querySelector(".animate-spin") !== null ||
      document.querySelector("[role='status']") !== null;

    expect(hasLoadingIndicator).toBe(true);
  });

  test("shows error message with retry button when fetchClientSecret throws", async () => {
    const { EmbeddedCheckout } = await import(
      "../components/embedded-checkout"
    );

    const fetchClientSecret = mock(() =>
      Promise.reject(new Error("Session creation failed"))
    );

    render(
      <EmbeddedCheckout
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
      />
    );

    // Wait for the error state to render
    await waitFor(
      () => {
        const retryButton = screen.queryByRole("button", {
          name: /try again/i,
        });
        expect(retryButton).not.toBeNull();
      },
      { timeout: 3000 }
    );
  });

  test("retry button calls fetchClientSecret again after error", async () => {
    const { EmbeddedCheckout } = await import(
      "../components/embedded-checkout"
    );

    const fetchClientSecret = mock(() =>
      Promise.reject(new Error("Session creation failed"))
    );

    render(
      <EmbeddedCheckout
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
      />
    );

    await waitFor(
      () => {
        expect(
          screen.queryByRole("button", { name: /try again/i })
        ).not.toBeNull();
      },
      { timeout: 3000 }
    );

    const retryButton = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryButton);

    // fetchClientSecret should be called again after retry
    expect(fetchClientSecret.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("accepts className prop on container", async () => {
    const { EmbeddedCheckout } = await import(
      "../components/embedded-checkout"
    );

    // fetchClientSecret that never settles (stays in loading, avoids async noise)
    const fetchClientSecret = () => new Promise<string>(() => {});

    const { container } = render(
      <EmbeddedCheckout
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
        className="my-checkout"
      />
    );

    expect(container.firstElementChild?.className).toContain("my-checkout");
  });

  test("component source does not import @context-kit/billing", async () => {
    const { resolve } = await import("node:path");
    const sourcePath = resolve(
      import.meta.dir,
      "../components/embedded-checkout.tsx"
    );
    const source = await Bun.file(sourcePath).text();
    expect(source).not.toContain("@context-kit/billing");
  });

  test("component uses fetchClientSecret and stripePublishableKey props (not planId/interval)", async () => {
    const { resolve } = await import("node:path");
    const sourcePath = resolve(
      import.meta.dir,
      "../components/embedded-checkout.tsx"
    );
    const source = await Bun.file(sourcePath).text();
    expect(source).toContain("fetchClientSecret");
    expect(source).toContain("stripePublishableKey");
    expect(source).not.toContain("planId");
  });

  test("passes returnUrl to EmbeddedCheckoutProvider options when provided", async () => {
    const { EmbeddedCheckout } = await import(
      "../components/embedded-checkout"
    );

    const fetchClientSecret = mock(() => Promise.resolve("cs_test_secret_123"));

    // Clear previous provider calls
    providerCalls.length = 0;

    render(
      <EmbeddedCheckout
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
        returnUrl="https://example.com/return"
      />
    );

    // Wait for the ready state so EmbeddedCheckoutProvider renders
    await waitFor(
      () => {
        expect(screen.queryByTestId("stripe-provider")).not.toBeNull();
      },
      { timeout: 3000 }
    );

    // The provider should have been called with options that include returnUrl
    const lastCall = providerCalls[providerCalls.length - 1];
    expect(lastCall).toBeDefined();
    const options = lastCall.options as Record<string, unknown> | undefined;
    expect(options).toBeDefined();
    expect(options!.returnUrl).toBe("https://example.com/return");
  });
});
