/**
 * Exercises Notes dispatch, validation, ownership, and persistence against a
 * real NotesService over a temp-file store. Scripted model outputs drive the
 * real core planner to verify corrected-call recovery and unrelated failures.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  satisfiesRoleGate,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PlannerToolCall,
  runPlannerLoop,
} from "../../../packages/core/src/runtime/planner-loop.js";
import { collectBudgetedStageOneCandidateActions } from "../../../packages/core/src/services/message/planned-tool.js";
import { notesAction } from "./action.js";
import { notesPlugin } from "./plugin.js";
import {
  getNotesService,
  NOTES_SERVICE_TYPE,
  NotesService,
} from "./service.js";
import { NotesStore } from "./store.js";
import { parseNoteContent } from "./validation.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function harness(): Promise<IAgentRuntime> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-action-"));
  tmpDirs.push(dir);
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath: path.join(dir, "notes.json") }),
  });
  await service.initialize();
  return {
    getService: (type: string) =>
      type === NOTES_SERVICE_TYPE ? service : null,
  } as unknown as IAgentRuntime;
}

const message = { content: { text: "" } } as unknown as Memory;

async function run(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  callback?: Parameters<typeof notesAction.handler>[4],
): Promise<ActionResult> {
  const result = await notesAction.handler(
    runtime,
    message,
    undefined,
    {
      parameters,
    } as never,
    callback,
  );
  if (!result) throw new Error("NOTES action returned no result.");
  return result;
}

async function executorHarness(): Promise<IAgentRuntime> {
  const runtime = await harness();
  Object.assign(runtime, {
    actions: notesPlugin.actions,
    agentId: "agent-id" as UUID,
    getRoom: vi.fn(async () => null),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return runtime;
}

function execute(
  runtime: IAgentRuntime,
  call: PlannerToolCall,
  userRoles: Parameters<typeof executePlannedToolCall>[1]["userRoles"] = [
    "OWNER",
  ],
) {
  return executePlannedToolCall(
    runtime,
    {
      message: {
        id: "message-id" as UUID,
        entityId: "owner-id" as UUID,
        roomId: "room-id" as UUID,
        content: { text: "Create the requested note." },
      } as Memory,
      activeContexts: ["notes"],
      userRoles,
    },
    call,
  );
}

describe("promoted Notes execution", () => {
  it("reads exact IDs without substituting matching text or exposing other notes", async () => {
    const runtime = await executorHarness();
    const created = await run(runtime, {
      action: "create",
      content: "Exact read fixture\nComplete original body",
    });
    const id = created.data?.noteId;
    expect(typeof id).toBe("string");
    await run(runtime, {
      action: "create",
      content: `Decoy\n${id}\nnote_missing_qa`,
    });
    const before = getNotesService(runtime).listNotes();
    const selected = collectBudgetedStageOneCandidateActions({
      actions: runtime.actions,
      candidateActions: ["NOTES_GET", "NOTES_GET_NOTE"],
      contexts: ["notes"],
      deferUnselectedContexts: true,
      deferParentHints: true,
    });
    expect(selected.map((action) => action.name)).toEqual(["NOTES_GET"]);
    const found = await execute(runtime, {
      name: selected[0].name,
      params: { noteId: id },
    });
    expect(found).toMatchObject({
      success: true,
      data: {
        lookupMode: "exact_id",
        requestedNoteId: id,
        count: 1,
        notes: [created.data?.note],
      },
    });
    const missingId = await execute(runtime, {
      name: "NOTES_GET",
      params: {},
    });
    expect(missingId.success).toBe(false);
    expect(missingId.data).not.toHaveProperty("notes");
    const absent = await execute(runtime, {
      name: "NOTES_LIST",
      params: { noteId: "note_missing_qa" },
    });
    expect(absent).toMatchObject({
      success: true,
      data: { lookupMode: "exact_id", count: 0, notes: [] },
    });
    const text = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "note_missing_qa" },
    });
    expect(text).toMatchObject({
      success: true,
      data: { lookupMode: "text", count: 1 },
    });
    const conflict = await execute(runtime, {
      name: "NOTES_LIST",
      params: { noteId: id, content: "Decoy" },
    });
    expect(conflict).toMatchObject({ success: false });
    const denied = await execute(
      runtime,
      { name: "NOTES_GET", params: { noteId: id } },
      ["NONE"],
    );
    expect(denied.success).toBe(false);
    expect(denied.data).not.toHaveProperty("notes");
    expect(getNotesService(runtime).listNotes()).toEqual(before);
  });

  it("exposes complete replacement content separately from the create-only body", async () => {
    const update = notesPlugin.actions?.find(
      (action) => action.name === "NOTES_UPDATE",
    );
    expect(
      update?.parameters?.map((parameter) => parameter.name),
    ).not.toContain("body");
    expect(
      update?.parameters?.find(
        (parameter) => parameter.name === "replacementContent",
      ),
    ).toMatchObject({
      required: false,
      aliases: ["body", "newText"],
    });
    const runtime = await executorHarness();
    await execute(runtime, {
      name: "NOTES_CREATE",
      params: { content: "Packing list\nCharger" },
    });
    const result = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        content: "Packing list",
        replacementContent: "Packing list\nCharger and water",
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.note).toMatchObject({
      title: "Packing list",
      body: "Charger and water",
    });
  });

  it("creates, lists, updates, and deletes through the registered children", async () => {
    const runtime = await executorHarness();
    const created = await execute(runtime, {
      name: "NOTES_CREATE",
      params: {
        content:
          "Conversation context QA\nBring the blue notebook and charger; no water.",
      },
    });
    expect(created.success).toBe(true);
    expect(created.data?.note).toMatchObject({
      title: "Conversation context QA",
      body: "Bring the blue notebook and charger; no water.",
    });
    const updated = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        content: "Conversation context QA",
        body: "Conversation context QA\nBring only the blue notebook.",
      },
    });
    expect(updated.success).toBe(true);
    expect(updated.data?.noteId).toBe(created.data?.noteId);
    const listed = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "" },
    });
    expect(listed.data?.notes).toMatchObject([
      {
        title: "Conversation context QA",
        body: "Bring only the blue notebook.",
      },
    ]);
    expect(listed.data?.filterApplied).toBe(false);
    const deleted = await execute(runtime, {
      name: "NOTES_DELETE",
      params: { content: "Conversation context QA" },
    });
    expect(deleted.success).toBe(true);
    expect(deleted.data?.note).toEqual(updated.data?.note);
    expect((await run(runtime, { action: "list" })).data?.notes).toEqual([]);

    for (const result of [created, listed, updated, deleted]) {
      expect(result).toMatchObject({
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
      });
      expect(result).not.toHaveProperty("userFacingText");
      expect(result).not.toHaveProperty("text");
      expect(result).not.toHaveProperty("verifiedUserFacing");
      expect(result).not.toHaveProperty("turnComplete");
    }
    expect(listed.effectReceipts).toBeUndefined();
    for (const result of [created, updated, deleted]) {
      expect(result.effectReceipts).toEqual([
        expect.objectContaining({
          outcome: "applied",
          resource: { kind: "notes.note", id: created.data?.noteId },
          commit: expect.objectContaining({ kind: "durable" }),
        }),
      ]);
    }
  });

  it("advances a committed Notes step to queued navigation but still evaluates the final reply", async () => {
    const runtime = await executorHarness();
    const useModel = vi.fn().mockResolvedValue({
      toolCalls: [
        {
          id: "create-note",
          name: "NOTES_CREATE",
          arguments: {
            content: "Queue contract QA\nBring the notebook.",
            eliza_turn_scope: "final",
          },
        },
        {
          id: "open-notes",
          name: "VIEWS",
          arguments: {
            action: "show",
            view: "notes",
            eliza_turn_scope: "final",
          },
        },
      ],
    });
    const executeToolCall = vi.fn(async (call: PlannerToolCall) =>
      call.name === "VIEWS"
        ? {
            success: true,
            text: "Navigation accepted: notes.",
            transcriptVisibility: "internal" as const,
            modelReplyRequired: true,
            turnComplete: false,
          }
        : execute(runtime, call),
    );
    const evaluate = vi.fn<
      NonNullable<Parameters<typeof runPlannerLoop>[0]["evaluate"]>
    >(async ({ trajectory }) =>
      trajectory.steps.at(-1)?.toolCall?.name === "VIEWS"
        ? {
            success: true,
            decision: "FINISH",
            thought: "The note is saved and navigation completed.",
            messageToUser: "Your notebook note is saved, and Notes is open.",
            effectReceiptIds: trajectory.steps.flatMap((step) =>
              (step.result?.effectReceipts ?? []).map(
                (receipt) => receipt.receiptId,
              ),
            ),
          }
        : {
            success: false,
            decision: "NEXT_RECOMMENDED",
            thought: "Opening Notes remains queued.",
            recommendedToolCallId: "open-notes",
          },
    );

    const result = await runPlannerLoop({
      runtime: { useModel },
      context: { id: "notes-navigation", events: [] },
      executeToolCall,
      evaluate,
    });

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls.map(([call]) => call.name)).toEqual([
      "NOTES_CREATE",
      "VIEWS",
    ]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.finalMessage).toBe(
      "Your notebook note is saved, and Notes is open.",
    );
    expect((await run(runtime, { action: "list" })).data?.notes).toMatchObject([
      { title: "Queue contract QA", body: "Bring the notebook." },
    ]);
  });

  it.each([
    ["NOTES_CREATE", { body: "Bring the notebook." }, "content"],
    ["NOTES_CREATE", { content: "" }, "content"],
    ["NOTES_UPDATE", { body: "Replacement" }, "content"],
    ["NOTES_UPDATE", { content: "" }, "content"],
    ["NOTES_UPDATE", { content: "Existing note" }, "replacementContent"],
    [
      "NOTES_UPDATE",
      { content: "Existing note", body: "" },
      "replacementContent",
    ],
    ["NOTES_DELETE", {}, "content"],
    ["NOTES_DELETE", { content: "" }, "content"],
  ])(
    "rejects incomplete %s arguments before writing: %j",
    async (name, params, missing) => {
      const runtime = await executorHarness();
      await run(runtime, {
        action: "create",
        content: "Existing note\nKeep this body.",
      });
      const before = (await run(runtime, { action: "list" })).data?.notes;
      const rejected = await execute(runtime, { name, params });
      expect(rejected.success).toBe(false);
      expect(rejected.effectReceipts).toBeUndefined();
      expect(rejected.verifiedUserFacing).not.toBe(true);
      expect(rejected.turnComplete).not.toBe(true);
      expect(rejected.data?.parameterErrors).toEqual(
        expect.arrayContaining([expect.stringContaining(missing)]),
      );
      expect((await run(runtime, { action: "list" })).data?.notes).toEqual(
        before,
      );
    },
  );

  it("denies a non-owner promoted write without changing the store", async () => {
    const runtime = await executorHarness();
    const rejected = await execute(
      runtime,
      {
        name: "NOTES_CREATE",
        params: { content: "Unauthorized note" },
      },
      ["USER"],
    );
    expect(rejected.success).toBe(false);
    expect(rejected.effectReceipts).toBeUndefined();
    expect((await run(runtime, { action: "list" })).data?.notes).toEqual([]);
  });

  it.each([
    { name: "NOTES", related: true },
    { name: "NOTES", related: false },
    { name: "NOTES_CREATE", related: true },
    { name: "NOTES_CREATE", related: false },
  ])(
    "retains only unresolved $name failure authority after a related retry: $related",
    async ({ name, related }) => {
      const runtime = await executorHarness();
      const body = "Bring the blue notebook and charger; no water.";
      const content = related
        ? `Conversation context QA\n${body}`
        : "Dentist appointment\nTuesday afternoon.";
      const useModel = vi
        .fn()
        .mockResolvedValue(
          "The first note could not be saved; the second note was saved.",
        )
        .mockResolvedValueOnce({
          toolCalls: [
            {
              id: "missing-content",
              name,
              arguments: { action: "create", body },
            },
          ],
        })
        .mockResolvedValueOnce({
          toolCalls: [
            { id: "retry", name, arguments: { action: "create", content } },
          ],
        });
      const completion = "Hecho. La nota solicitada está guardada.";
      const result = await runPlannerLoop({
        runtime: { useModel },
        context: { id: "notes-recovery", events: [] },
        executeToolCall: (call) => execute(runtime, call),
        evaluate: ({ trajectory }) => {
          const lastResult = trajectory.steps.at(-1)?.result;
          return lastResult?.success
            ? {
                success: true,
                decision: "FINISH",
                thought: "The requested note was saved.",
                messageToUser: completion,
                effectReceiptIds: lastResult.effectReceipts?.map(
                  (receipt) => receipt.receiptId,
                ),
              }
            : {
                success: false,
                decision: "CONTINUE",
                thought: "Correct the missing content.",
              };
        },
      });
      expect((await run(runtime, { action: "list" })).data?.count).toBe(1);
      expect(
        result.trajectory.steps.filter(
          (step) => step.result?.success === false,
        ),
      ).toHaveLength(1);
      if (related) {
        expect(result.finalMessage).toBe(completion);
        expect(useModel).toHaveBeenCalledTimes(2);
      } else {
        expect(result.finalMessage).not.toBe(completion);
        expect(useModel.mock.calls.length).toBeGreaterThan(2);
      }
    },
  );
});

describe("NOTES operation parsing", () => {
  it.each(["text", "note", "title"])(
    "preserves the direct handler's legacy %s content alias",
    async (alias) => {
      const runtime = await harness();
      const created = await run(runtime, {
        action: "create",
        [alias]: "Legacy title",
        body: "Legacy body",
      });
      expect(created.success).toBe(true);
      expect(
        (await run(runtime, { action: "list" })).data?.notes,
      ).toMatchObject([{ title: "Legacy title", body: "Legacy body" }]);
    },
  );

  it("keeps canonical Notes aliases distinct from generic view navigation", () => {
    expect(notesAction.similes).toEqual(
      expect.arrayContaining(["NOTES_LIST", "NOTES_READ", "SEARCH_NOTES"]),
    );
    expect(notesAction.similes).not.toContain("LIST_NOTES");
    expect(notesAction.similes).not.toContain("SHOW_NOTES");
  });

  it("denies every non-owner role before the handler can access the store", () => {
    expect(notesAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(satisfiesRoleGate(["GUEST"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["USER"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["ADMIN"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["OWNER"], notesAction.roleGate)).toBe(true);
  });

  it("refuses an operation it does not implement instead of listing", async () => {
    const runtime = await harness();
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    // "remove" is plausible planner output: DELETE_NOTE is an advertised simile.
    const result = await run(runtime, {
      action: "remove",
      content: "spare key",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOTES_UNKNOWN_OP");
    // The failure names what it CAN do, and never renders the note list.
    expect(result.text).toContain("delete");
    expect(result.text).not.toContain("spare key under the mat");
  });

  it("still reads when no operation was named at all", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "wifi is on the fridge" });

    const result = await run(runtime, {});

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ count: 1, total: 1 });
    expect(result.data?.notes).toMatchObject([
      { title: "wifi is on the fridge", body: "", color: "yellow" },
    ]);
  });

  it("returns structured note facts for one natural model-authored reply", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "wifi is on the fridge" });
    const callback = vi.fn();

    const result = await run(runtime, { action: "list" }, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      transcriptVisibility: "internal",
      modelReplyRequired: true,
      data: {
        count: 1,
        total: 1,
        notes: [{ title: "wifi is on the fridge", body: "" }],
      },
    });
    expect(result).not.toHaveProperty("userFacingText");
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("modelReplyFallback");
    expect(result).not.toHaveProperty("verifiedUserFacing");
    expect(result).not.toHaveProperty("turnComplete");
  });

  it("treats a strict-provider empty content field as omission for an unfiltered count", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "first note" });
    await run(runtime, { action: "create", content: "second note" });
    Object.assign(runtime, {
      actions: [notesAction],
      agentId: "agent-id" as UUID,
      getRoom: vi.fn(async () => null),
      reportError: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const result = await executePlannedToolCall(
      runtime,
      {
        message: {
          id: "message-id" as UUID,
          entityId: "owner-id" as UUID,
          roomId: "room-id" as UUID,
          content: { text: "How many notes do I have?" },
        } as Memory,
        activeContexts: ["notes"],
        userRoles: ["OWNER"],
      },
      {
        name: "NOTES",
        params: { action: "list", content: "", body: "" },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        count: 2,
        total: 2,
        filterApplied: false,
      },
    });
  });

  it("preserves stored identity and timestamps so the model can compare recency", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Recency check\noriginal body",
    });
    const updated = await run(runtime, {
      action: "update",
      content: "Recency check",
      body: "Recency check\nupdated body",
    });
    const result = await run(runtime, { action: "list" });

    expect(result.data?.notes).toEqual([updated.data?.note]);
    expect(result.data?.notes).toMatchObject([
      {
        id: created.data?.noteId,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        title: "Recency check",
        body: "updated body",
      },
    ]);
    const filtered = await run(runtime, {
      action: "list",
      content: "Recency check",
    });
    expect(filtered.data?.notes).toEqual(result.data?.notes);
  });

  it("keeps a topic-scoped read from exposing unrelated notes", async () => {
    const runtime = await harness();
    await run(runtime, {
      action: "create",
      content: "the plumber comes thursday morning",
    });
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    const match = await run(runtime, { action: "list", content: "PLUMBER" });
    expect(match.data?.notes).toMatchObject([
      {
        title: "the plumber comes thursday morning",
        body: "",
        color: "yellow",
      },
    ]);
    expect(match.data).toMatchObject({
      count: 1,
      total: 2,
      filterApplied: true,
    });

    const absent = await run(runtime, { action: "list", query: "dentist" });
    expect(absent.data?.notes).toEqual([]);
    expect(absent.data).toMatchObject({
      count: 0,
      total: 2,
      filterApplied: true,
    });
  });

  it('stores "titled X saying Y" planner content as label plus body, not one merged title', async () => {
    const runtime = await harness();
    // Live planner output for "create a note titled Demo Checklist saying
    // mic, charger, water" arrives as one colon-joined content field.
    const created = await run(runtime, {
      action: "create",
      content: "Demo Checklist: mic, charger, water",
    });
    expect(created.success).toBe(true);
    expect(created.data?.note).toMatchObject({
      title: "Demo Checklist",
      body: "mic, charger, water",
    });
  });

  it.each(["Stable Local Notes QA", "QA: afternoon"])(
    "preserves a separate create body with title %s",
    async (title) => {
      const runtime = await harness();
      const created = await run(runtime, {
        action: "create",
        content: title,
        body: "Cerebras local note persistence",
      });

      expect(created.success).toBe(true);
      expect(created.data?.note).toMatchObject({
        title,
        body: "Cerebras local note persistence",
      });
      const listed = await run(runtime, { action: "list" });
      expect(listed.data?.notes).toMatchObject([
        {
          title,
          body: "Cerebras local note persistence",
          color: "yellow",
        },
      ]);
    },
  );

  it("stores a redundant create body once without removing intentional repeated lines", async () => {
    const runtime = await harness();
    const body = "Bring a charger and water.\nBring a charger and water.";
    const created = await run(runtime, {
      action: "create",
      content: `Checklist\n${body}`,
      body,
    });
    expect(created.success).toBe(true);
    const listed = await run(runtime, { action: "list", content: "Checklist" });
    expect(listed.data?.notes).toMatchObject([{ title: "Checklist", body }]);
    expect(listed.data?.count).toBe(1);
  });

  it("rejects conflicting create bodies without persisting either version", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Checklist\nBring water.",
      body: "Bring a charger.",
    });
    expect(created).toMatchObject({
      success: false,
      error: "NOTES_CONFLICTING_BODY",
    });
    const listed = await run(runtime, { action: "list" });
    expect(listed.data?.notes).toEqual([]);
  });

  it("returns the persisted label and body as evidence after a content update", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Demo checklist",
      body: "charger",
    });
    const updated = await run(runtime, {
      action: "update",
      content: "Demo checklist",
      body: "Demo checklist\ncharger and water",
    });
    expect(updated.success).toBe(true);
    expect(updated.modelReplyRequired).toBe(true);
    expect(updated.data?.note).toMatchObject({
      id: created.data?.noteId,
      title: "Demo checklist",
      body: "charger and water",
    });
    const listed = await run(runtime, {
      action: "list",
      content: "Demo checklist",
    });
    expect(listed.data?.notes).toMatchObject([
      { title: "Demo checklist", body: "charger and water", color: "yellow" },
    ]);
  });

  it("lets the owner create, search/list, update, and delete in one store", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "bins go out tuesday",
    });
    expect(created.success).toBe(true);
    expect(created.data?.note).toMatchObject({ title: "bins go out tuesday" });

    const listed = await run(runtime, { action: "list" });
    expect(listed.success).toBe(true);
    expect(listed.data?.notes).toMatchObject([
      { title: "bins go out tuesday", body: "", color: "yellow" },
    ]);

    const updated = await run(runtime, {
      action: "update",
      content: "bins",
      body: "bins go out wednesday",
    });
    expect(updated.success).toBe(true);
    expect(updated.data?.note).toMatchObject({
      title: "bins go out wednesday",
    });

    const deleted = await run(runtime, {
      action: "delete",
      content: "wednesday",
    });
    expect(deleted.success).toBe(true);
    expect(deleted.data?.note).toEqual(updated.data?.note);

    const after = await run(runtime, { action: "list" });
    expect(after.data).toMatchObject({ count: 0, total: 0, notes: [] });
  });
});

describe("identical-duplicate notes", () => {
  async function seedLegacyCopies(
    runtime: IAgentRuntime,
    content: string,
    copies: number,
  ): Promise<NotesService> {
    const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
    if (!service) throw new Error("NotesService missing from harness");
    const original = await service.createNote(parseNoteContent(content));
    await service.store.transact((draft) => {
      for (let index = 1; index < copies; index += 1) {
        draft.notes.push({ ...original, id: `legacy-copy-${index}` });
      }
    });
    return service;
  }

  it("makes concurrent identical creates one replayable logical note", async () => {
    const runtime = await harness();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(runtime, { action: "create", content: "i need to buy milk" }),
      ),
    );

    expect(
      results.filter((result) => result.data?.replayed === false),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.data?.replayed === true),
    ).toHaveLength(3);
    const listed = await run(runtime, { action: "list" });
    expect(listed.data).toMatchObject({ count: 1, total: 1 });
  });

  it("deletes every byte-identical copy as one logical note", async () => {
    const runtime = await harness();
    await seedLegacyCopies(runtime, "i need to buy milk", 4);
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    const result = await run(runtime, { action: "delete", content: "milk" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      removedCount: 4,
      note: { title: "i need to buy milk", body: "" },
    });

    const after = await run(runtime, { action: "list" });
    expect(after.data?.notes).toMatchObject([
      { title: "spare key under the mat", body: "", color: "yellow" },
    ]);
  });

  it("still refuses genuinely differing matches as ambiguous", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "buy milk at aldi" });
    await run(runtime, { action: "create", content: "buy milk for the cat" });

    await expect(
      run(runtime, { action: "delete", content: "milk" }),
    ).rejects.toMatchObject({ code: "NOTES_AMBIGUOUS_NOTE" });
  });

  it("updates one logical note and consolidates its identical stored copies", async () => {
    const runtime = await harness();
    await seedLegacyCopies(runtime, "i need to buy milk", 4);

    const result = await run(runtime, {
      action: "update",
      content: "milk",
      body: "i already bought milk",
    });

    expect(result.data).toMatchObject({ consolidatedCount: 3 });
    const after = await run(runtime, { action: "list" });
    expect(after.data).toMatchObject({ count: 1, total: 1 });
    expect(after.data?.notes).toMatchObject([
      { title: "i already bought milk", body: "", color: "yellow" },
    ]);
  });

  it("keeps same-text notes with different visible colors distinct", async () => {
    const runtime = await harness();
    const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
    if (!service) throw new Error("NotesService missing from harness");
    await service.createNote({ title: "buy milk", body: "", color: "yellow" });
    await service.createNote({ title: "buy milk", body: "", color: "green" });

    await expect(
      run(runtime, { action: "delete", content: "buy milk" }),
    ).rejects.toMatchObject({ code: "NOTES_AMBIGUOUS_NOTE" });

    const deleted = await run(runtime, {
      action: "delete",
      content: "buy milk green",
    });
    expect(deleted.success).toBe(true);
    expect(service.listNotes().map((note) => note.color)).toEqual(["yellow"]);
  });
});

describe("literal Notes edits", () => {
  it("updates through the promoted tool without a read and persists only the requested substring", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const original = await service.createNote({
      title: "Literal edit",
      body: "Bring a green folder and a charger.",
      color: "rose",
    });
    const other = await service.createNote({
      title: "Other note",
      body: "green",
      color: "slate",
    });
    const result = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        content: "Literal edit",
        textEdit: { field: "body", oldText: "green", newText: "orange" },
      },
    });
    expect(result.success).toBe(true);
    expect(result.effectReceipts).toEqual([
      expect.objectContaining({ outcome: "applied" }),
    ]);
    const updated = service.getNote(original.id);
    expect(updated).toEqual({
      ...original,
      body: "Bring a orange folder and a charger.",
      updatedAt: updated.updatedAt,
    });
    expect(service.getNote(other.id)).toEqual(other);
    const filePath = service.store.filePath;
    await service.stop();
    const reopened = new NotesService(undefined, {
      store: new NotesStore({ filePath }),
    });
    await reopened.initialize();
    expect(reopened.getNote(original.id)).toEqual(updated);
    await reopened.stop();
  });

  it.each([
    ["body", "green", "$& \n$1 🟠", "Use $& \n$1 🟠 here.", "Exact title"],
    ["body", "green ", "", "Use here.", "Exact title"],
    ["title", "Exact", "Precise", "Use green here.", "Precise title"],
  ] as const)(
    "preserves literal strings when editing %s",
    async (field, oldText, newText, body, title) => {
      const runtime = await executorHarness();
      await execute(runtime, {
        name: "NOTES_CREATE",
        params: { content: "Exact title\nUse green here." },
      });
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: {
          content: "Exact title",
          textEdit: { field, oldText, newText },
        },
      });
      expect(result.success).toBe(true);
      expect(result.data?.note).toMatchObject({ title, body });
    },
  );

  it.each([
    ["missing", "orange", "green", "NOTES_EDIT_TEXT_NOT_FOUND"],
    ["green", "orange", "green green", "NOTES_EDIT_TEXT_AMBIGUOUS"],
    ["aa", "b", "aaa", "NOTES_EDIT_TEXT_AMBIGUOUS"],
    ["green", " orange ", "green", "NOTES_EDIT_NORMALIZATION_REQUIRED"],
  ])(
    "rejects %s -> %s without any revision or record change",
    async (oldText, newText, body, code) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      await service.createNote({ title: "Exact title", body });
      const before = service.snapshot();
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: {
          content: "Exact title",
          textEdit: { field: "body", oldText, newText },
        },
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain(code);
      expect(service.snapshot()).toEqual(before);
    },
  );

  it("checks the old text inside the write barrier when two edits race", async () => {
    const runtime = await harness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Exact title",
      body: "green",
    });
    const before = service.snapshot();
    const results = await Promise.allSettled(
      ["orange", "violet"].map((newText) =>
        service.updateNoteByLookupWithCommit("title", note.title, {
          textEdit: { field: "body", oldText: "green", newText },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(service.getNote(note.id).body).toBe("orange");
    expect(service.snapshot().revision).toBe(before.revision + 1);
  });

  it("keeps owner admission and conflicting update forms from mutating records", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    await service.createNote({ title: "Exact title", body: "green" });
    const before = service.snapshot();
    const params = {
      content: "Exact title",
      textEdit: { field: "body", oldText: "green", newText: "orange" },
    };
    expect(
      (await execute(runtime, { name: "NOTES_UPDATE", params }, ["MEMBER"]))
        .success,
    ).toBe(false);
    expect(
      (
        await execute(runtime, {
          name: "NOTES_UPDATE",
          params: { ...params, replacementContent: "Wrong title\nred" },
        })
      ).success,
    ).toBe(false);
    expect(service.snapshot()).toEqual(before);
  });
});
