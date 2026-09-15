/** Executes the bundled native read operation against a DOM with controlled layout, preserving complete visible text without exposing hidden form data. */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../resources/read-page.js"),
  "utf8",
);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("reads beyond the former character and node limits without returning a partial payload", () => {
  const rects = Object.assign([new DOMRect(0, 0, 100, 20)], {
    item(index: number) {
      return this[index] ?? null;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(rects);
  const longText = "unabridged text ".repeat(2000) + "終端 Ω";
  const paragraph = document.createElement("p");
  paragraph.append(document.createTextNode(longText));
  const lines = [longText];
  for (let i = 0; i < 10_002; i++) {
    const text = `visible-${i}`;
    paragraph.append(document.createTextNode(text));
    lines.push(text);
  }
  document.body.append(paragraph);
  const hidden = document.createElement("div");
  hidden.hidden = true;
  hidden.textContent = "hidden secret";
  const input = document.createElement("input");
  input.value = "private form value";
  document.body.append(hidden, input);
  const result: unknown = runInNewContext(`${source}; readPage("body")`, {
    document,
    NodeFilter,
    getComputedStyle,
    location,
    Error,
  });
  expect(result).toMatchObject({ text: lines.join("\n"), truncated: false });
});
