/**
 * Prompt-assembly reachability contract for the widget marker vocabulary
 * (#14488 / #14540): a plain scheduling turn from an ordinary (GUEST/MEMBER)
 * user must put the `[FORM]` date/time field vocabulary into the composed
 * planner state, because that guide text is the ONLY place the model learns
 * the marker grammar — when it is absent the model improvises raw HTML the
 * chat surface cannot render (the live-trajectory failure that opened #14540).
 *
 * The metadata tests in `ui-catalog.test.ts` pin the provider's declared
 * flags; these tests drive the REAL pipeline instead: the production
 * providers registered on a real in-memory `AgentRuntime`, selected by the
 * real `selectV5PlannerStateProviderNames`, and rendered by the real
 * `composeState` — no provider mocks. Deterministic; no model or database.
 */
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Memory,
  type RoleGateRole,
  selectV5PlannerStateProviderNames,
  type UUID,
} from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  uiGenerativeProvider,
  uiWidgetCapabilitiesProvider,
  uiWidgetsProvider,
} from "./ui-catalog.ts";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;

function schedulingMessage(channelType: ChannelType = ChannelType.DM): Memory {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    content: {
      text: "I need a reminder for my report deadline — I'll give you the day and the time.",
      channelType,
    },
  } as Memory;
}

let runtime: AgentRuntime;

beforeAll(() => {
  runtime = new AgentRuntime({
    character: { name: "ui-catalog-prompt-assembly-test" } as Character,
  });
  runtime.registerProvider(uiWidgetsProvider);
  runtime.registerProvider(uiWidgetCapabilitiesProvider);
  runtime.registerProvider(uiGenerativeProvider);
});

function plannerNames(
  userRoles: RoleGateRole[],
  selectedContexts: Parameters<
    typeof selectV5PlannerStateProviderNames
  >[0]["selectedContexts"] = ["tasks"],
): string[] {
  return selectV5PlannerStateProviderNames({
    runtime,
    message: schedulingMessage(),
    selectedContexts,
    userRoles,
  });
}

describe("v5 planner selection — ordinary-user reachability, no admin leak", () => {
  it("selects uiWidgets for a GUEST scheduling turn", () => {
    expect(plannerNames(["GUEST"])).toContain("uiWidgets");
  });

  it("keeps compact marker support reachable without injecting long examples into unrelated contexts", () => {
    expect(plannerNames(["GUEST"], ["wallet"])).toContain(
      "uiWidgetCapabilities",
    );
    expect(plannerNames(["GUEST"], ["wallet"])).not.toContain("uiWidgets");
  });

  it("keeps the ADMIN-gated generative catalog out of non-admin turns", () => {
    for (const role of ["GUEST", "MEMBER", "USER"] as RoleGateRole[]) {
      expect(plannerNames([role], ["general"])).not.toContain("uiGenerative");
    }
  });

  it("still selects the generative catalog for ADMIN/OWNER general turns", () => {
    for (const role of ["ADMIN", "OWNER"] as RoleGateRole[]) {
      expect(plannerNames([role], ["general"])).toContain("uiGenerative");
    }
  });
});

describe("composed planner state — the [FORM] vocabulary reaches the prompt", () => {
  it("carries the FORM grammar and native date/time field types for a GUEST scheduling turn", async () => {
    const names = plannerNames(["GUEST"]);
    const state = await runtime.composeState(
      schedulingMessage(),
      names,
      true,
      true,
    );

    // The exact vocabulary the model needs to emit a scheduling form: the
    // marker itself, the temporal field types, and the scheduling preference.
    expect(state.text).toContain("### [FORM]");
    expect(state.text).toContain('"type":"datetime"');
    expect(state.text).toContain("checkbox | date | time |");
    expect(state.text).toContain("prefer temporal types for schedules");
  });

  it("does not leak the generative-UI catalog into a non-admin composition", async () => {
    const names = plannerNames(["GUEST"], ["general"]);
    const state = await runtime.composeState(
      schedulingMessage(),
      names,
      true,
      true,
    );

    expect(state.text).not.toContain('{"op":"add"');
    expect(state.text).not.toContain("Generative UI — inline JSONL patches");
  });

  it("composes no marker vocabulary on group channels", async () => {
    const names = plannerNames(["GUEST"]);
    const state = await runtime.composeState(
      schedulingMessage(ChannelType.GROUP),
      names,
      true,
      true,
    );

    expect(state.text).not.toContain("[FORM]");
    expect(state.text).not.toContain("[CHOICE");
  });
});
