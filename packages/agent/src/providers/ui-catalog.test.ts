/**
 * Coverage for the split UI-guide providers (#14324). Asserts the common marker
 * path (`uiWidgetsProvider`) leads with the closed marker vocabulary and no
 * longer carries the GenUI JSONL method or the full component catalog, that the
 * heavy generative guide (`uiGenerativeProvider`) is a separate provider gated
 * on its own visualisation keywords, that both keep the DM/API channel gate, and
 * that the marker path stays materially smaller than the pre-split guide via an
 * enforced size ceiling. Deterministic: no live model.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  uiGenerativeProvider,
  uiWidgetCapabilitiesProvider,
  uiWidgetsProvider,
} from "./ui-catalog.ts";

function makeRuntime(): IAgentRuntime {
  return {} as unknown as IAgentRuntime;
}

function makeMessage(channelType?: ChannelType, text = ""): Memory {
  return { content: { channelType, text } } as unknown as Memory;
}

async function widgetsText(
  channelType: ChannelType = ChannelType.API,
): Promise<string> {
  const result = await uiWidgetsProvider.get(
    makeRuntime(),
    makeMessage(channelType),
    {} as State,
  );
  return result.text ?? "";
}

async function generativeText(
  channelType: ChannelType = ChannelType.API,
  text = "show me a dashboard table",
): Promise<string> {
  const result = await uiGenerativeProvider.get(
    makeRuntime(),
    makeMessage(channelType, text),
    {} as State,
  );
  return result.text ?? "";
}

describe("uiWidgetsProvider — marker vocabulary (common path)", () => {
  it("leads with the marker vocabulary and omits the GenUI JSONL method + catalog", async () => {
    const text = await widgetsText();

    // Marker vocabulary the MVP relies on is all present.
    expect(text).toContain("[CONFIG:pluginId]");
    expect(text).toContain("[FORM]");
    expect(text).toContain("[/FORM]");
    expect(text).toContain("[FOLLOWUPS]");
    expect(text).toContain("[/FOLLOWUPS]");
    expect(text).toContain("[CHECKLIST]");
    expect(text).toContain("[WORKFLOW]");

    // The marker guide leads with the common path and does not teach raw JSONL.
    const configIdx = text.indexOf("[CONFIG:pluginId]");
    expect(configIdx).toBeGreaterThan(-1);

    // The heavy GenUI method and the full catalog do NOT leak onto this path.
    expect(text).not.toMatch(/RFC 6902/);
    expect(text).not.toMatch(/JSON patch lines INLINE/);
    expect(text).not.toContain("Available components");
    expect(text).not.toContain('"op":"add"');
  });

  it("teaches followup grammar that the UI parser accepts", async () => {
    const text = await widgetsText();
    const block = /\[FOLLOWUPS\]\n([\s\S]*?)\n\[\/FOLLOWUPS\]/.exec(text);
    expect(block).not.toBeNull();
    const lines = (block?.[1] ?? "").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^.+=.+$/);
    }
    expect(text).toContain("reply:");
    expect(text).toContain("navigate:/apps/tasks");
    expect(text).toContain("prompt:");
  });

  it("teaches [FORM]/[CHECKLIST]/[WORKFLOW] example bodies the UI parsers accept", async () => {
    const text = await widgetsText();

    const form = /\[FORM\]\n([\s\S]*?)\n\[\/FORM\]/.exec(text);
    expect(form).not.toBeNull();
    const formBody = JSON.parse(form?.[1] ?? "null") as {
      fields: Array<{ name: string; type: string }>;
    };
    expect(Array.isArray(formBody.fields)).toBe(true);
    expect(formBody.fields.length).toBeGreaterThan(0);

    const checklist = /\[CHECKLIST\]\n([\s\S]*?)\n\[\/CHECKLIST\]/.exec(text);
    expect(checklist).not.toBeNull();
    const checklistBody = JSON.parse(checklist?.[1] ?? "null") as {
      items: Array<{ content: string; status: string }>;
    };
    expect(Array.isArray(checklistBody.items)).toBe(true);
    for (const item of checklistBody.items) {
      expect(["pending", "in_progress", "completed"]).toContain(item.status);
    }

    const workflow = /\[WORKFLOW\]\n([\s\S]*?)\n\[\/WORKFLOW\]/.exec(text);
    expect(workflow).not.toBeNull();
    const workflowBody = JSON.parse(workflow?.[1] ?? "null") as {
      steps: Array<{ label: string; status: string }>;
    };
    expect(Array.isArray(workflowBody.steps)).toBe(true);
    for (const step of workflowBody.steps) {
      expect(["pending", "running", "done", "failed"]).toContain(step.status);
    }
  });

  it("keeps the marker path materially smaller than the pre-split guide", async () => {
    const text = await widgetsText();
    // Pre-split the combined guide was 138 lines / ~9.9k chars. The marker path
    // must stay well under that; this ceiling stops the guide silently regrowing.
    const lineCount = text.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(60);
    expect(text.length).toBeLessThanOrEqual(5000);
  });

  it("emits nothing on connector-style group channels (no marker leak)", async () => {
    expect(await widgetsText(ChannelType.GROUP)).toBe("");
  });
});

describe("uiGenerativeProvider — generative UI escape hatch", () => {
  it("carries the JSONL method and the full component catalog", async () => {
    const text = await generativeText();
    expect(text).toContain('{"op":"add","path":"/root"');
    expect(text).toContain("Available components");
  });

  it("does not restate the marker widgets it defers to", async () => {
    const text = await generativeText();
    expect(text).toContain("For plugin setup use [CONFIG:pluginId]");
    expect(text).not.toContain("[FOLLOWUPS]");
    expect(text).not.toContain("[CHECKLIST]");
    expect(text).not.toContain("[WORKFLOW]");
  });

  it("emits nothing on connector-style group channels", async () => {
    expect(await generativeText(ChannelType.GROUP)).toBe("");
  });
});

describe("relevance keyword separation", () => {
  it("fires uiWidgets on plugin-setup intent, not uiGenerative", () => {
    // "set up discord" → marker path only.
    expect(uiWidgetsProvider.relevanceKeywords).toContain("discord");
    expect(uiWidgetsProvider.relevanceKeywords).toContain("setup");
    expect(uiGenerativeProvider.relevanceKeywords).not.toContain("discord");
    expect(uiGenerativeProvider.relevanceKeywords).not.toContain("setup");
  });

  it("fires uiWidgets on scheduling and form intent", () => {
    for (const term of ["reminder", "schedule", "date", "time", "datetime"]) {
      expect(uiWidgetsProvider.relevanceKeywords).toContain(term);
      expect(uiGenerativeProvider.relevanceKeywords).not.toContain(term);
    }
  });

  it("fires uiGenerative on visualisation intent, not on plugin config", () => {
    // "show me a table of my week" → generative path reachable.
    expect(uiGenerativeProvider.relevanceKeywords).toContain("dashboard");
    expect(uiGenerativeProvider.relevanceKeywords).toContain("table");
    expect(uiGenerativeProvider.relevanceKeywords).toContain("chart");
    expect(uiWidgetsProvider.relevanceKeywords).not.toContain("dashboard");
  });

  it("keeps the compact marker guide available to ordinary response turns", () => {
    expect(uiWidgetsProvider.dynamic).toBe(true);
    expect(uiWidgetsProvider.alwaysInResponseState).toBeUndefined();
    expect(uiWidgetsProvider.cacheStable).toBe(true);
    expect(uiWidgetsProvider.cacheScope).toBe("agent");
    expect(uiWidgetsProvider.roleGate).toBeUndefined();
    expect(uiWidgetsProvider.relevanceKeywords?.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps uiWidgets context-gated to scheduling and setup turns, not only general", () => {
    const expectedContexts = [
      "general",
      "tasks",
      "todos",
      "productivity",
      "connectors",
      "settings",
    ];
    expect(uiWidgetsProvider.contexts).toEqual(expectedContexts);
    expect(uiWidgetsProvider.contextGate).toEqual({
      anyOf: expectedContexts,
    });
  });

  it("keeps the heavy generative guide dynamic + turn-scoped + ADMIN-gated", () => {
    expect(uiGenerativeProvider.dynamic).toBe(true);
    expect(uiGenerativeProvider.cacheStable).toBeUndefined();
    expect(uiGenerativeProvider.cacheScope).toBeUndefined();
    expect(uiGenerativeProvider.roleGate).toEqual({ minRole: "ADMIN" });
    expect(uiGenerativeProvider.relevanceKeywords?.length ?? 0).toBeGreaterThan(
      0,
    );
  });

  it("both providers keep relevance keywords", () => {
    for (const provider of [uiWidgetsProvider, uiGenerativeProvider]) {
      expect(provider.relevanceKeywords?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("widget guide progressive discovery", () => {
  it("supports direct controls without forcing another model call", async () => {
    const hint = await uiWidgetCapabilitiesProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API, "hi"),
      {} as State,
    );
    expect(hint.text).toContain("[CHOICE:scope]");
    expect(hint.text).toContain('contexts=["simple"]');
    expect(hint.text).toContain("never secrets/API keys");
    expect(hint.text).toContain("[FORM]");
    expect(hint.text).toContain("[CONFIG:pluginId]");
    expect(hint.text?.length).toBeLessThan(2000);
  });

  it("keeps the discovery hint off connector group and feed channels", async () => {
    for (const channel of [ChannelType.GROUP, ChannelType.FEED]) {
      expect(
        (
          await uiWidgetCapabilitiesProvider.get(
            makeRuntime(),
            makeMessage(channel),
            {} as State,
          )
        ).text,
      ).toBe("");
    }
  });
});
