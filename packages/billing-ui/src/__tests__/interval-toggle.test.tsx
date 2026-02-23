import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// IntervalToggle
// ---------------------------------------------------------------------------

describe("IntervalToggle", () => {
  test("renders Monthly and Yearly options", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    render(
      <IntervalToggle interval="monthly" onIntervalChange={onIntervalChange} />
    );

    expect(screen.getByText(/monthly/i)).toBeDefined();
    expect(screen.getByText(/yearly/i)).toBeDefined();
  });

  test("calls onIntervalChange with 'yearly' when Yearly is clicked", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    render(
      <IntervalToggle interval="monthly" onIntervalChange={onIntervalChange} />
    );

    const yearlyButton = screen.getByRole("radio", { name: /yearly/i });
    fireEvent.click(yearlyButton);

    expect(onIntervalChange).toHaveBeenCalledWith("yearly");
  });

  test("calls onIntervalChange with 'monthly' when Monthly is clicked", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    render(
      <IntervalToggle interval="yearly" onIntervalChange={onIntervalChange} />
    );

    const monthlyButton = screen.getByRole("radio", { name: /monthly/i });
    fireEvent.click(monthlyButton);

    expect(onIntervalChange).toHaveBeenCalledWith("monthly");
  });

  test("displays savings badge when savingsPercentage is provided and > 0", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    render(
      <IntervalToggle
        interval="monthly"
        onIntervalChange={onIntervalChange}
        savingsPercentage={20}
      />
    );

    expect(screen.getByText(/20%/)).toBeDefined();
  });

  test("does not display savings badge when savingsPercentage is 0", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    const { container } = render(
      <IntervalToggle
        interval="monthly"
        onIntervalChange={onIntervalChange}
        savingsPercentage={0}
      />
    );

    expect(container.textContent).not.toContain("Save");
  });

  test("does not display savings badge when savingsPercentage is undefined", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    const { container } = render(
      <IntervalToggle interval="monthly" onIntervalChange={onIntervalChange} />
    );

    expect(container.textContent).not.toContain("Save");
  });

  test("has ARIA radiogroup role on container", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    render(
      <IntervalToggle interval="monthly" onIntervalChange={onIntervalChange} />
    );

    expect(screen.getByRole("radiogroup")).toBeDefined();
  });

  test("active option has aria-checked='true'", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    render(
      <IntervalToggle interval="yearly" onIntervalChange={onIntervalChange} />
    );

    const yearlyRadio = screen.getByRole("radio", { name: /yearly/i });
    const monthlyRadio = screen.getByRole("radio", { name: /monthly/i });

    expect(yearlyRadio.getAttribute("aria-checked")).toBe("true");
    expect(monthlyRadio.getAttribute("aria-checked")).toBe("false");
  });

  test("accepts className prop", async () => {
    const { IntervalToggle } = await import("../components/interval-toggle");
    const onIntervalChange = mock(() => {});

    const { container } = render(
      <IntervalToggle
        interval="monthly"
        onIntervalChange={onIntervalChange}
        className="custom-toggle"
      />
    );

    expect(container.firstElementChild?.className).toContain("custom-toggle");
  });
});
