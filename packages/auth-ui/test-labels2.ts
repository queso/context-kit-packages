import { Window } from "happy-dom";
const w = new Window();
const doc = w.document;
Object.defineProperty(globalThis, "window", { value: w, writable: true });
Object.defineProperty(globalThis, "document", { value: doc, writable: true });
Object.defineProperty(globalThis, "HTMLElement", { value: w.HTMLElement, writable: true });
Object.defineProperty(globalThis, "Element", { value: w.Element, writable: true });
Object.defineProperty(globalThis, "Node", { value: w.Node, writable: true });
Object.defineProperty(globalThis, "Event", { value: w.Event, writable: true });

import React from "react";
import { createRoot } from "react-dom/client";
import { getByLabelText } from "@testing-library/dom";

const container = doc.createElement("div");
doc.body.appendChild(container);

function Form() {
  return (
    <div>
      <label htmlFor="reset-password">New password</label>
      <input id="reset-password" type="password" name="password" autoComplete="new-password" />
      <label htmlFor="reset-confirm-password">Confirm password</label>
      <input id="reset-confirm-password" type="password" name="confirmPassword" autoComplete="new-password" />
    </div>
  );
}

const root = createRoot(container);

await new Promise<void>((resolve) => {
  root.render(React.createElement(Form));
  setTimeout(resolve, 100);
});

console.log("Body innerHTML:", doc.body.innerHTML.substring(0, 200));

const input1 = doc.getElementById("reset-password") as any;
const input2 = doc.getElementById("reset-confirm-password") as any;
console.log("input1 labels:", input1?.labels?.length);
console.log("input1 labels[0]:", input1?.labels?.[0]?.textContent?.trim());
console.log("input2 labels:", input2?.labels?.length);
console.log("input2 labels[0]:", input2?.labels?.[0]?.textContent?.trim());

try {
  const found = getByLabelText(doc.body as unknown as HTMLElement, /new password|^password/i);
  console.log("Found:", found.id);
} catch(e: any) {
  console.log("Error:", e.message.substring(0, 200));
}
