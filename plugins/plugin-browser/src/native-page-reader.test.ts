/** Exercises native result validation before complete content reaches browser tools; transport payloads are controlled fixtures. */
import { describe, expect, it } from "vitest";
import { readNativeBrowserPage } from "./native-page-reader";

describe("complete native browser context", () => {
  it.each(["snapshot", "get"] as const)(
    "preserves a long %s through the tool boundary",
    async (subaction) => {
      const text = "visible complete text ".repeat(4000) + "最後 Ω";
      const result = await readNativeBrowserPage(
        { subaction },
        "requesting-client",
        async () => ({
          url: "https://example.test/",
          title: "Page",
          text,
          truncated: false,
        }),
      );
      expect(
        subaction === "snapshot"
          ? (result.value as { bodyText: string }).bodyText
          : result.value,
      ).toBe(text);
    },
  );
  it.each(["snapshot", "get"] as const)(
    "rejects clipped %s before returning a model payload",
    async (subaction) => {
      await expect(
        readNativeBrowserPage({ subaction }, "requesting-client", async () => ({
          url: "https://example.test/",
          title: "Page",
          text: "clipped prefix",
          truncated: true,
        })),
      ).rejects.toMatchObject({ code: "NATIVE_PAGE_READ_INCOMPLETE" });
    },
  );
});
