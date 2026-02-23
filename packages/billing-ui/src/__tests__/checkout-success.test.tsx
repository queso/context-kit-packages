import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type React from "react";

// ---------------------------------------------------------------------------
// Mock next/link -- renders a plain <a> so href is inspectable in tests
// ---------------------------------------------------------------------------

mock.module("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// CheckoutSuccess
// ---------------------------------------------------------------------------

describe("CheckoutSuccess", () => {
  test("renders a success heading", async () => {
    const { CheckoutSuccess } = await import("../components/checkout-success");

    render(<CheckoutSuccess redirectUrl="/dashboard" />);

    // Should contain something like "Subscription Confirmed" or "Success"
    const heading = screen.getByRole("heading");
    expect(heading).toBeDefined();
    expect(heading.textContent?.toLowerCase()).toMatch(
      /subscri|success|confirm/i
    );
  });

  test("displays plan name in message when planName is provided", async () => {
    const { CheckoutSuccess } = await import("../components/checkout-success");

    render(<CheckoutSuccess redirectUrl="/dashboard" planName="Pro" />);

    expect(screen.getByText(/pro/i)).toBeDefined();
    // Should include something like "subscribed to Pro"
    expect(document.body.textContent).toContain("Pro");
  });

  test("shows generic active message when planName is not provided", async () => {
    const { CheckoutSuccess } = await import("../components/checkout-success");

    render(<CheckoutSuccess redirectUrl="/dashboard" />);

    // Generic message: "Your subscription is now active" or similar
    expect(document.body.textContent?.toLowerCase()).toMatch(
      /subscription.*active|active.*subscription/i
    );
  });

  test("CTA links to the provided redirectUrl", async () => {
    const { CheckoutSuccess } = await import("../components/checkout-success");

    render(<CheckoutSuccess redirectUrl="/dashboard" />);

    const link = screen.getByRole("link");
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("/dashboard");
  });

  test("accepts className prop on container", async () => {
    const { CheckoutSuccess } = await import("../components/checkout-success");

    const { container } = render(
      <CheckoutSuccess redirectUrl="/dashboard" className="my-success" />
    );

    expect(container.firstElementChild?.className).toContain("my-success");
  });
});
