import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import React from "react";

test("aria-hidden in labelledby", () => {
  render(
    <form>
      <label htmlFor="pwd1">New password</label>
      <input id="pwd1" type="password" />

      <span id="confirm-label" aria-hidden="true">
        Confirm password
      </span>
      <input id="pwd2" type="password" aria-labelledby="confirm-label" />
    </form>
  );

  try {
    const el = screen.getByLabelText(/new password|password/i);
    console.log("A: found 1 element:", el.id);
  } catch (e: any) {
    console.log("A error:", e.message.split("\n")[0]);
  }

  try {
    const el = screen.getByLabelText(/confirm password/i);
    console.log("B: found:", el.id);
  } catch (e: any) {
    console.log("B error:", e.message.split("\n")[0]);
  }
});
