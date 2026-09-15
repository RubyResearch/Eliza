/** Tests production provider discovery through the real Stage-1 and planner selectors with a deterministic runtime fixture. */
import {
  type AgentContext,
  ChannelType,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  selectV5PlannerStateProviderNames,
  stage1ResponseStateProviderNames,
} from "../../../core/src/services/message/provider-state.ts";
import {
  uiGenerativeProvider,
  uiWidgetCapabilitiesProvider,
  uiWidgetsProvider,
} from "./ui-catalog.ts";

const runtime = {
  providers: [
    uiWidgetCapabilitiesProvider,
    uiWidgetsProvider,
    uiGenerativeProvider,
  ],
  getSetting: () => undefined,
} as unknown as IAgentRuntime;
const message = {
  content: { text: "show choices", channelType: ChannelType.API },
} as Memory;

describe("production widget provider routing", () => {
  it("exposes only the discovery hint to the initial response handler", () => {
    const names = stage1ResponseStateProviderNames(runtime, message);
    expect(names).toContain("uiWidgetCapabilities");
    expect(names).not.toContain("uiWidgets");
  });

  it("makes the generative reference discoverable only for authorized roles", () => {
    for (const role of ["MEMBER", "ADMIN"] as const) {
      const stage1 = stage1ResponseStateProviderNames(runtime, message, [role]);
      const planner = selectV5PlannerStateProviderNames({
        runtime,
        message,
        selectedContexts: ["simple"],
        userRoles: [role],
      });
      expect(stage1.includes("uiGenerative")).toBe(role === "ADMIN");
      expect(planner.includes("uiGenerative")).toBe(role === "ADMIN");
    }
    expect(stage1ResponseStateProviderNames(runtime, message)).not.toContain(
      "uiGenerative",
    );
  });

  it.each(["general", "tasks", "connectors", "settings"] as AgentContext[])(
    "supplies the full guide to the %s planner without another discovery call",
    (context) => {
      const names = selectV5PlannerStateProviderNames({
        runtime,
        message,
        selectedContexts: [context],
        userRoles: ["MEMBER"],
      });
      expect(names).toContain("uiWidgets");
    },
  );

  it("keeps the full guide out of simple and unrelated document contexts", () => {
    for (const context of ["simple", "documents"] as AgentContext[]) {
      const names = selectV5PlannerStateProviderNames({
        runtime,
        message,
        selectedContexts: [context],
        userRoles: ["MEMBER"],
      });
      expect(names).not.toContain("uiWidgets");
    }
  });
});
