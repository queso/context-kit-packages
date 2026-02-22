import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";

describe("React rendering smoke test", () => {
  test("renders a div with text content", () => {
    render(<div>Hello</div>);
    expect(screen.getByText("Hello")).toBeDefined();
  });
});
