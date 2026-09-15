/**
 * Config schema: the keyed web-search settings are retired. WEB_SEARCH is
 * keyless, so the settings surface hides the provider and API-key fields and
 * describes the enable toggle without a key requirement, while the shape still
 * accepts those keys from an existing config file. Pure builder, no runtime.
 */
import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema";
import { ToolsWebSearchSchema } from "./zod-schema.agent-runtime";

describe("web search config surface", () => {
  it("hides the retired provider and API-key fields and keeps the keyless toggle", () => {
    const { uiHints } = buildConfigSchema();
    for (const path of [
      "tools.web.search.provider",
      "tools.web.search.apiKey",
      "tools.web.search.perplexity",
      "tools.web.search.perplexity.apiKey",
      "tools.web.search.perplexity.baseUrl",
      "tools.web.search.perplexity.model",
    ]) {
      expect(uiHints[path]?.hidden).toBe(true);
      expect(uiHints[path]?.label).toBeUndefined();
    }
    expect(uiHints["tools.web.search.enabled"]?.hidden).toBeUndefined();
    expect(uiHints["tools.web.search.enabled"]?.help).toContain("keyless");
    expect(uiHints["tools.web.search.enabled"]?.help).not.toMatch(
      /requires .*key/i,
    );
  });

  it("still accepts an existing config that carries the retired keys", () => {
    expect(
      ToolsWebSearchSchema.safeParse({
        enabled: true,
        provider: "brave",
        apiKey: "old",
        perplexity: { apiKey: "old", baseUrl: "https://x", model: "m" },
      }).success,
    ).toBe(true);
  });
});
