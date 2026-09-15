/** Provider-owned discovery keeps full syntax reachable without using unrelated
 * historical keywords as an implicit request. Deterministic provider tests;
 * core restoration tests cover the actual planner/evaluator wire projection. */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { uiGenerativeProvider, uiWidgetsProvider } from "./ui-catalog.ts";

const runtime = {} as IAgentRuntime;
const message = (text: string, channelType: ChannelType = ChannelType.API) =>
  ({ content: { text, channelType } }) as Memory;
const history = (text: string) =>
  ({
    data: {
      providers: {
        RECENT_MESSAGES: { data: { recentMessages: [{ content: { text } }] } },
      },
    },
  }) as unknown as State;
describe("generative reference discovery", () => {
  it.each([
    ["open notes", "UI check: open Notes and tell me which view is open."],
    ["set up discord", "build a dashboard"],
    ["make the second column green", "build a dashboard"],
    ["add a filter row", '{"op":"add","path":"/root","value":"card-1"}'],
    ["show me a dashboard of my metrics", ""],
  ])(
    "offers the same complete reference for %s without sticky history activation",
    async (text, old) => {
      const result = await uiGenerativeProvider.get(
        runtime,
        message(text),
        history(old),
      );
      const fresh = await uiGenerativeProvider.get(
        runtime,
        message(text),
        history(""),
      );
      expect(result).toEqual(fresh);
      expect(result.discoveryText).toContain("context_discovery: uiGenerative");
      expect(result.discoveryText).not.toContain('{"op":"add"');
      expect(result.text).toContain('{"op":"add"');
      expect(result.text).toContain("Available components");
    },
  );
  it("keeps full guides off forbidden channels", async () => {
    for (const provider of [uiWidgetsProvider, uiGenerativeProvider]) {
      const result = await provider.get(
        runtime,
        message("dashboard chart", ChannelType.GROUP),
        history("build a dashboard"),
      );
      expect(result.text).toBe("");
      expect(result.discoveryText).toBeUndefined();
    }
  });
});
