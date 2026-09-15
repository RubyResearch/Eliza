/**
 * Covers uiWidgetsProvider's marker instructions on the dashboard API channel.
 * Choice examples use the real UI parser to preserve distinguishing labels and
 * returned record identities; followups/forms retain their marker grammar and
 * no markers leak onto connector-style group channels.
 * Deterministic: the admin gate is forced open by mocking security/access; no
 * live model.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { findChoiceRegions } from "../../../ui/src/components/chat/message-choice-parser.ts";

// The followups/form instructions live behind the provider's admin gate; force
// it open so these tests focus on instruction delivery + channel gating.
vi.mock("../security/access.ts", () => ({
  hasAdminAccess: vi.fn(async () => true),
}));

import { uiWidgetsProvider } from "./ui-catalog.ts";

function makeRuntime(): IAgentRuntime {
  return {} as unknown as IAgentRuntime;
}

function makeMessage(channelType?: ChannelType): Memory {
  return { content: { channelType } } as unknown as Memory;
}

describe("uiWidgetsProvider — inline marker instructions", () => {
  it("teaches same-title record choices with distinct labels and stable returned identities", async () => {
    const result = await uiWidgetsProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API),
      {} as State,
    );
    const choices = findChoiceRegions(result.text ?? "");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      id: "note-choice-123",
      scope: "note-selection",
      options: [
        {
          value: "Select note note_123",
          label: "Travel checklist (note_123)",
        },
        {
          value: "Select note note_456",
          label: "Travel checklist (note_456)",
        },
      ],
    });
  });

  it("teaches [FOLLOWUPS] and [FORM] on the dashboard (API) channel", async () => {
    const result = await uiWidgetsProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API),
      {} as State,
    );
    const text = result.text ?? "";
    expect(text).toContain("[FOLLOWUPS]");
    expect(text).toContain("[/FOLLOWUPS]");
    expect(text).toContain("[FORM]");
    expect(text).toContain("[/FORM]");
    // Documents all three followup kinds and a concrete navigate example.
    expect(text).toContain("reply:");
    expect(text).toContain("navigate:/apps/tasks");
    expect(text).toContain("prompt:");
  });

  it("emits the followup example in the exact grammar the UI parser accepts", async () => {
    // The UI parser regex requires `[FOLLOWUPS]\n<lines>\n[/FOLLOWUPS]` with
    // `<kind>:<payload>=<label>` lines. Assert the instruction's example block
    // satisfies it so the docs can't drift from the parser.
    const result = await uiWidgetsProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API),
      {} as State,
    );
    const text = result.text ?? "";
    const block = /\[FOLLOWUPS\]\n([\s\S]*?)\n\[\/FOLLOWUPS\]/.exec(text);
    expect(block).not.toBeNull();
    const lines = (block?.[1] ?? "").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // every example line is `<something>=<label>`
      expect(line).toMatch(/^.+=.+$/);
    }
  });

  it("teaches [CHECKLIST] and [WORKFLOW] with examples the UI parsers accept", async () => {
    // The inline task-pipeline widgets (#13536) only render when the agent emits
    // these markers; assert the catalog's example blocks satisfy the exact
    // `[MARKER]\n{json}\n[/MARKER]` grammar the UI parsers require and that the
    // JSON parses into a valid spec, so the taught syntax can't drift from the
    // renderer.
    const result = await uiWidgetsProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API),
      {} as State,
    );
    const text = result.text ?? "";

    const checklist = /\[CHECKLIST\]\n([\s\S]*?)\n\[\/CHECKLIST\]/.exec(text);
    expect(checklist).not.toBeNull();
    const checklistBody = JSON.parse(checklist?.[1] ?? "null") as {
      items: Array<{ content: string; status: string }>;
    };
    expect(Array.isArray(checklistBody.items)).toBe(true);
    expect(checklistBody.items.length).toBeGreaterThan(0);
    for (const item of checklistBody.items) {
      expect(typeof item.content).toBe("string");
      expect(["pending", "in_progress", "completed"]).toContain(item.status);
    }

    const workflow = /\[WORKFLOW\]\n([\s\S]*?)\n\[\/WORKFLOW\]/.exec(text);
    expect(workflow).not.toBeNull();
    const workflowBody = JSON.parse(workflow?.[1] ?? "null") as {
      steps: Array<{ label: string; status: string }>;
    };
    expect(Array.isArray(workflowBody.steps)).toBe(true);
    expect(workflowBody.steps.length).toBeGreaterThan(0);
    for (const step of workflowBody.steps) {
      expect(typeof step.label).toBe("string");
      expect(["pending", "running", "done", "failed"]).toContain(step.status);
    }
  });

  it("emits nothing on connector-style group channels (no marker leak)", async () => {
    const result = await uiWidgetsProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.GROUP),
      {} as State,
    );
    expect(result.text ?? "").toBe("");
  });
});
