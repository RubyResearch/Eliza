/**
 * MEMORY action handler tests against a deterministic in-memory runtime that
 * mimics the SQL adapter's contract: uuid params are type-checked like a
 * postgres uuid column (bad ids throw a drizzle-style error carrying the raw
 * SQL) and the relationships service exposes identity-cluster membership.
 */
import type { ActionResult, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  composeToolDiagnosticRedactor,
  normalizeActionIdentifier,
  promoteSubactionsToActions,
  renderActionResultsForModel,
  validateToolArgs,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runWithActionRoutingContext } from "../../../core/src/runtime/action-routing-context";
import { actionResultToPlannerToolResult } from "../../../core/src/runtime/planner-loop";
import { toolMessageContent } from "../../../core/src/runtime/planner-rendering";
import {
  MAX_MEMORY_ACTION_RESULT_CHARS,
  MAX_MEMORY_PAGE_ITEMS,
  memoryAction,
} from "./memories";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const SIBLING_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000ee" as UUID;

type StoredRow = { memory: Memory; tableName: string; unique?: boolean };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidOrThrowLikeDrizzle(value: unknown, column: string): void {
  if (value == null) return;
  if (typeof value === "string" && UUID_RE.test(value)) return;
  throw new Error(
    `Failed query: select "id", "content" from "memories" where "${column}" = $1 -- params: ["${String(value)}"]; invalid input syntax for type uuid`,
  );
}

function makeRuntime(options?: {
  clusters?: Partial<Record<string, UUID[]>>;
  settings?: Record<string, string | boolean>;
  embeddingResult?: number[];
}): { runtime: IAgentRuntime; rows: StoredRow[] } {
  const rows: StoredRow[] = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: (key: string) => options?.settings?.[key],
    getService: (name: string) => {
      if (name === "relationships" && options?.clusters) {
        return {
          getMemberEntityIds: async (entityId: UUID) =>
            options.clusters?.[entityId] ?? [],
        };
      }
      return null;
    },
    createMemory: async (
      memory: Memory,
      tableName: string,
      unique?: boolean,
    ) => {
      rows.push({ memory, tableName, unique });
      return memory.id;
    },
    getMemories: async (params: {
      tableName: string;
      roomId?: UUID;
      entityId?: UUID;
      authorEntityIds?: UUID[];
      limit?: number;
      cursor?: { createdAt: number; id: UUID };
    }) => {
      assertUuidOrThrowLikeDrizzle(params.roomId, "roomId");
      assertUuidOrThrowLikeDrizzle(params.entityId, "entityId");
      let matching = rows
        .filter((row) => row.tableName === params.tableName)
        .filter((row) => !params.roomId || row.memory.roomId === params.roomId)
        .filter(
          (row) => !params.entityId || row.memory.entityId === params.entityId,
        )
        .filter(
          (row) =>
            !params.authorEntityIds ||
            params.authorEntityIds.includes(row.memory.entityId as UUID),
        )
        .map((row) => row.memory)
        .sort(
          (left, right) =>
            (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
            String(right.id).localeCompare(String(left.id)),
        );
      if (params.cursor) {
        matching = matching.filter((memory) => {
          const createdAt = memory.createdAt ?? 0;
          if (createdAt !== params.cursor?.createdAt) {
            return createdAt < (params.cursor?.createdAt ?? 0);
          }
          return String(memory.id) < String(params.cursor.id);
        });
      }
      if (params.limit == null) return matching;
      return matching.slice(0, params.limit);
    },
    countMemories: async (params: {
      tableName?: string;
      roomId?: UUID;
      agentId?: UUID;
    }) =>
      rows
        .filter((row) => row.tableName === (params.tableName ?? "messages"))
        .filter((row) => !params.roomId || row.memory.roomId === params.roomId)
        .filter(
          (row) => !params.agentId || row.memory.agentId === params.agentId,
        ).length,
    getMemoryById: async (memoryId: UUID) => {
      assertUuidOrThrowLikeDrizzle(memoryId, "id");
      return rows.find((row) => row.memory.id === memoryId)?.memory ?? null;
    },
    updateMemory: async (memory: Partial<Memory> & { id: UUID }) => {
      const row = rows.find((candidate) => candidate.memory.id === memory.id);
      if (!row) throw new Error(`memory ${memory.id} was not found`);
      row.memory = { ...row.memory, ...memory } as Memory;
    },
    useModel: async () => {
      if (options?.embeddingResult) return options.embeddingResult;
      throw new Error("embedding capability should not be requested");
    },
    deleteMemory: async (memoryId: UUID) => {
      assertUuidOrThrowLikeDrizzle(memoryId, "id");
      const index = rows.findIndex((row) => row.memory.id === memoryId);
      if (index >= 0) rows.splice(index, 1);
    },
  } as unknown as IAgentRuntime;
  return { runtime, rows };
}

function seedFact(
  rows: StoredRow[],
  fields: {
    text: string;
    entityId: UUID;
    roomId?: UUID;
    metadata?: Record<string, unknown>;
  },
): UUID {
  const id = crypto.randomUUID() as UUID;
  rows.push({
    memory: {
      id,
      entityId: fields.entityId,
      agentId: AGENT_ID,
      roomId: fields.roomId ?? ROOM_ID,
      content: { text: fields.text },
      ...(fields.metadata ? { metadata: fields.metadata } : {}),
      createdAt: Date.now(),
    } as Memory,
    tableName: "facts",
  });
  return id;
}

function makeMessage(overrides: { text?: string } = {}): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: {
      text: overrides.text ?? "remember this: my favorite color is blue",
    },
    createdAt: Date.now(),
  } as Memory;
}

type TestParams = Record<string, string | string[] | number | boolean>;

async function runAction(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: TestParams,
): Promise<ActionResult> {
  const result = await memoryAction.handler(runtime, message, undefined, {
    parameters,
  });
  if (!result) throw new Error("handler returned no result");
  return result;
}

async function runCreate(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: TestParams,
): Promise<ActionResult> {
  return runAction(runtime, message, { action: "create", ...parameters });
}

describe("MEMORY op:create converges with the Stage-1 facts stage", () => {
  function seedStageFact(
    rows: StoredRow[],
    fields: {
      text: string;
      messageId: UUID;
      keywords: string[];
      entityId?: UUID;
      subject?: string;
      subjectResolved?: boolean;
    },
  ): UUID {
    const id = crypto.randomUUID() as UUID;
    rows.push({
      memory: {
        id,
        entityId: fields.entityId ?? USER_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: fields.text, type: "fact" },
        metadata: {
          type: "custom",
          source: "facts_and_relationships_stage",
          messageId: fields.messageId,
          subject: fields.subject ?? "user",
          subjectResolved: fields.subjectResolved ?? true,
          tags: ["fact", "extracted", "stage1"],
          keywords: fields.keywords,
          kind: "current",
          category: "uncategorized",
          confidence: 0.6,
          verificationStatus: "self_reported",
        },
        createdAt: Date.now() - 1_000,
      } as Memory,
      tableName: "facts",
    });
    return id;
  }

  it("upgrades the Stage-1 fact extracted from the same message instead of storing a durable twin", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    const stageId = seedStageFact(rows, {
      text: "prefers oat milk in coffee",
      messageId: message.id as UUID,
      keywords: ["prefers", "oat", "milk", "coffee"],
    });

    const result = await runCreate(runtime, message, {
      text: "User prefers oat milk in coffee.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({
      memoryId: stageId,
      upgradedStageFact: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.content.text).toBe(
      "User prefers oat milk in coffee.",
    );
    expect(rows[0].memory.metadata).toMatchObject({
      kind: "durable",
      category: "preference",
      source: "MEMORY",
      promotedFrom: "facts_and_relationships_stage",
      previousText: "prefers oat milk in coffee",
      messageId: message.id,
    });
  });

  it("stores a fresh durable row when the adapter rejects the in-place upgrade", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    const stageId = seedStageFact(rows, {
      text: "prefers oat milk in coffee",
      messageId: message.id as UUID,
      keywords: ["prefers", "oat", "milk", "coffee"],
    });
    runtime.updateMemory = (async () => false) as IAgentRuntime["updateMemory"];

    const result = await runCreate(runtime, message, {
      text: "User prefers oat milk in coffee.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(result.values).not.toMatchObject({ upgradedStageFact: true });
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.id).toBe(stageId);
    expect(rows[0].memory.metadata).toMatchObject({ kind: "current" });
    expect(rows[1].memory.metadata).toMatchObject({
      kind: "durable",
      source: "MEMORY",
    });
    expect(result.values).toMatchObject({ memoryId: rows[1].memory.id });
  });

  it("never merges a same-message Stage-1 fact with the opposite polarity", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedStageFact(rows, {
      text: "does not like oat milk",
      messageId: message.id as UUID,
      keywords: ["oat", "milk"],
    });

    const result = await runCreate(runtime, message, {
      text: "User likes oat milk.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.content.text).toBe("does not like oat milk");
    expect(rows[0].memory.metadata).toMatchObject({ kind: "current" });
  });

  it("keeps a paraphrase that adds a word as a separate row", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedStageFact(rows, {
      text: "prefers oat milk in coffee",
      messageId: message.id as UUID,
      keywords: ["prefers", "oat", "milk", "coffee"],
    });

    const result = await runCreate(runtime, message, {
      text: "User prefers oat milk in their coffee.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.content.text).toBe("prefers oat milk in coffee");
    expect(rows[0].memory.metadata).toMatchObject({ kind: "current" });
  });

  it("keeps a past claim and its present correction as two rows (review counterexample)", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedStageFact(rows, {
      text: "used to hate oat milk",
      messageId: message.id as UUID,
      keywords: ["hate", "oat", "milk"],
    });

    const result = await runCreate(runtime, message, {
      text: "User does not hate oat milk anymore.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.content.text).toBe("used to hate oat milk");
    expect(rows[0].memory.metadata).toMatchObject({ kind: "current" });
    expect(rows[1].memory.content.text).toBe(
      "User does not hate oat milk anymore.",
    );
  });

  it("never merges a same-message Stage-1 fact authored by another participant", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedStageFact(rows, {
      text: "prefers oat milk in coffee",
      messageId: message.id as UUID,
      keywords: ["prefers", "oat", "milk", "coffee"],
      entityId: OTHER_USER_ID,
    });

    const result = await runCreate(runtime, message, {
      text: "User prefers oat milk in their coffee.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.entityId).toBe(OTHER_USER_ID);
    expect(rows[0].memory.metadata).toMatchObject({ kind: "current" });
    expect(rows[1].memory.entityId).toBe(USER_ID);
  });

  it("never absorbs a same-message fact about someone the room could not resolve", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedStageFact(rows, {
      text: "prefers oat milk in coffee",
      messageId: message.id as UUID,
      keywords: ["prefers", "oat", "milk", "coffee"],
      subject: "Bob",
      subjectResolved: false,
    });

    const result = await runCreate(runtime, message, {
      text: "User prefers oat milk in their coffee.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.metadata).toMatchObject({
      kind: "current",
      subject: "Bob",
      subjectResolved: false,
    });
  });

  it("never merges a Stage-1 fact extracted from a different message", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedStageFact(rows, {
      text: "prefers oat milk in cereal",
      messageId: crypto.randomUUID() as UUID,
      keywords: ["prefers", "oat", "milk", "cereal"],
    });

    const result = await runCreate(runtime, message, {
      text: "User prefers oat milk in their coffee.",
      kind: "preference",
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].memory.metadata).toMatchObject({
      kind: "current",
      category: "uncategorized",
    });
    expect(rows[1].memory.metadata).toMatchObject({
      kind: "durable",
      source: "MEMORY",
      messageId: message.id,
    });
  });
});

describe("MEMORY op:create argument shape", () => {
  it("stores content the planner misfiled in `query` instead of failing the turn", async () => {
    // Live 2026-09-06 01:09: three identical create calls with the content in
    // `query` and no `text` errored the whole remember turn.
    const { runtime, rows } = makeRuntime();
    const result = await runCreate(runtime, makeMessage(), {
      query: "I like my coffee with oat milk",
      kind: "preference",
    });
    expect(result.success).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.content.text).toBe("I like my coffee with oat milk");
    expect(result.data).toMatchObject({
      text: "I like my coffee with oat milk",
    });
  });

  it("names the field to use when neither text nor query carries content", async () => {
    const { runtime, rows } = makeRuntime();
    const result = await runCreate(
      runtime,
      // No statement to fall back on: the message asks, it does not tell.
      makeMessage({ text: "what should I have for lunch?" }),
      {
        kind: "preference",
      },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain('"text" argument');
    expect(rows).toHaveLength(0);
  });
});

describe("MEMORY mutations settle with receipts for the grounded reply gate", () => {
  it("create returns an internal result with an applied receipt and reply facts", async () => {
    const { runtime, rows } = makeRuntime();
    const result = await runCreate(runtime, makeMessage(), {
      text: "User likes their coffee black.",
      kind: "preference",
    });
    expect(result.success).toBe(true);
    expect(result.transcriptVisibility).toBe("internal");
    // The mutation owns its verified user-facing line and completes a
    // single-tool turn (planner loop gate); compound turns still fall through
    // to the evaluator because the gate requires exactly one executed tool.
    expect(result.turnComplete).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.effectReceipts).toHaveLength(1);
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "memory.create",
      outcome: "applied",
      resource: { kind: "memory.fact", id: rows[0].memory.id },
      commit: { kind: "durable", id: rows[0].memory.id },
    });
    expect(result.data).toMatchObject({
      replyContext: {
        domain: "memory",
        scenario: "memory_stored",
        facts: expect.stringContaining('"User likes their coffee black."'),
      },
    });
  });

  it("delete by id returns an internal result with an applied receipt naming what was forgotten", async () => {
    const { runtime, rows } = makeRuntime();
    const memoryId = seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      memoryId,
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(result.transcriptVisibility).toBe("internal");
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "memory.delete",
      outcome: "applied",
      resource: { id: memoryId },
    });
    expect(result.data).toMatchObject({
      replyContext: {
        scenario: "memory_forgotten",
        facts: expect.stringContaining("Kingfisher"),
      },
    });
    expect(rows).toHaveLength(0);
  });

  it("a refused delete (no confirm) stays a plain failure without receipts", async () => {
    const { runtime, rows } = makeRuntime();
    const memoryId = seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      memoryId,
    });
    expect(result.success).toBe(false);
    expect(result.transcriptVisibility).toBeUndefined();
    expect(result.effectReceipts).toBeUndefined();
    expect(rows).toHaveLength(1);
  });
});

describe("MEMORY op:delete by query scope", () => {
  it("requires explicit selection when a query matches the requester and an unresolved friend's preference", async () => {
    const { runtime, rows } = makeRuntime();
    const ownId = seedFact(rows, {
      text: "I prefer green tea without sugar",
      entityId: USER_ID,
      metadata: {
        messageId: "msg-tea-preferences",
        subject: "user",
        subjectResolved: true,
      },
    });
    const friendId = seedFact(rows, {
      text: "My friend prefers green tea without sugar",
      entityId: USER_ID,
      metadata: {
        messageId: "msg-tea-preferences",
        subject: "friend",
        subjectResolved: false,
      },
    });
    seedFact(rows, {
      text: "I prefer green tea without sugar",
      entityId: OTHER_USER_ID,
    });
    const before = structuredClone(rows);
    const message = makeMessage();
    message.content.text =
      "Forget that I prefer green tea without sugar, but keep what you know about my friend.";

    const ambiguous = await runAction(runtime, message, {
      action: "delete",
      query: "I prefer green tea without sugar",
      confirm: true,
    });

    expect(ambiguous.success).toBe(false);
    expect(ambiguous.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(ambiguous.text).toContain(ownId);
    expect(ambiguous.text).toContain(friendId);
    expect(ambiguous.effectReceipts).toBeUndefined();
    // The user-facing half names the candidate texts, never record ids, and
    // marks the refusal as a read-only observation (nothing was deleted).
    expect(ambiguous.userFacingText).toContain("Which one should I forget?");
    expect(ambiguous.userFacingText).toContain("green tea without sugar");
    expect(ambiguous.userFacingText).not.toContain(ownId);
    expect(ambiguous.userFacingText).not.toContain(friendId);
    expect(ambiguous.data).toMatchObject({ readOnlyOperation: true });
    expect(rows).toEqual(before);

    const selected = await runAction(runtime, message, {
      action: "delete",
      memoryId: ownId,
      confirm: true,
    });

    expect(selected.success).toBe(true);
    expect(rows).toEqual(before.filter((row) => row.memory.id !== ownId));
    expect(selected.effectReceipts).toHaveLength(1);
    expect(selected.effectReceipts?.[0]).toMatchObject({
      operation: "memory.delete",
      resource: { id: ownId },
      outcome: "applied",
      commit: { kind: "durable", id: ownId },
    });
  });

  it("forgets a durable fact together with the observation rows that shadow it", async () => {
    const { runtime, rows } = makeRuntime();
    const durableId = seedFact(rows, {
      text: "The user's favorite color is teal.",
      entityId: USER_ID,
      metadata: {
        source: "MEMORY",
        kind: "durable",
        messageId: "msg-color",
      },
    });
    const echoId = seedFact(rows, {
      text: "user favorite_color teal",
      entityId: USER_ID,
      metadata: {
        source: "facts_and_relationships_stage",
        kind: "current",
        messageId: "msg-color",
      },
    });
    const keptId = seedFact(rows, {
      text: "The user's favorite tea is assam.",
      entityId: USER_ID,
      metadata: { source: "MEMORY", kind: "durable", messageId: "msg-tea" },
    });
    const message = makeMessage();
    message.content.text = "forget my favorite color";

    const result = await runAction(runtime, message, {
      action: "delete",
      query: "favorite color",
      confirm: true,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(rows.map((row) => row.memory.id)).toEqual([keptId]);
    expect(rows.map((row) => row.memory.id)).not.toContain(durableId);
    expect(rows.map((row) => row.memory.id)).not.toContain(echoId);
    // The reply names the durable memory, not its observation shadow.
    expect(result.userFacingText).toBe("Forgot: your favorite color is teal.");
  });

  it("stores the user's own statement when a create arrives without text", async () => {
    const { runtime, rows } = makeRuntime();

    const result = await runAction(
      runtime,
      makeMessage({ text: "remember that my favorite tea is oolong." }),
      { action: "create", kind: "preference", tags: ["tea"] },
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memory.content.text).toBe("my favorite tea is oolong");
  });

  it("asks what to remember when a text-less create arrives with a two-request message", async () => {
    const { runtime, rows } = makeRuntime();

    const result = await runAction(
      runtime,
      makeMessage({
        text: "remember my dog is named Biscuit and also what day is it today?",
      }),
      { action: "create", kind: "fact", tags: ["pet"] },
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MEMORY_MISSING_TEXT",
      readOnlyOperation: true,
    });
    expect(result.userFacingText).toBe("What would you like me to remember?");
    expect(rows).toHaveLength(0);
  });

  it("still asks for an id when two durable facts match the query", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The user's favorite color is teal.",
      entityId: USER_ID,
      metadata: { source: "MEMORY", kind: "durable", messageId: "msg-a" },
    });
    seedFact(rows, {
      text: "The user's favorite color for cars is black.",
      entityId: USER_ID,
      metadata: { source: "MEMORY", kind: "durable", messageId: "msg-b" },
    });
    const before = structuredClone(rows);
    const message = makeMessage();
    message.content.text = "forget my favorite color";

    const result = await runAction(runtime, message, {
      action: "delete",
      query: "favorite color",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(rows).toEqual(before);
  });

  it("deletes only the explicit id and preserves unrelated facts from the same source message", async () => {
    const { runtime, rows } = makeRuntime();
    const id = seedFact(rows, {
      text: "The user's dog is named Biscuit.",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-and-jazz" },
    });
    seedFact(rows, {
      text: "User has_dog Biscuit",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-and-jazz" },
    });
    seedFact(rows, {
      text: "User likes jazz.",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-and-jazz" },
    });
    const preservedRows = structuredClone(rows.slice(1));
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      memoryId: String(id),
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(rows).toEqual(preservedRows);
    expect(result.effectReceipts).toHaveLength(1);
    expect(result.effectReceipts?.[0]).toMatchObject({
      resource: { id },
      outcome: "applied",
    });
  });

  it("preserves a different same-message claim sharing the queried subject", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "user's dog is named Biscuit",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-care" },
    });
    const careId = seedFact(rows, {
      text: "The user's dog needs a daily walk",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-care" },
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "user's dog is named Biscuit",
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(result.effectReceipts).toBeUndefined();
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.memory.id === careId)?.memory.content.text,
    ).toBe("The user's dog needs a daily walk");
  });

  it.each(["delete", "update"] as const)(
    "%s matches clock forms without changing a different time or owner's fact",
    async (action) => {
      const cases: Array<[string, string]> = [
        ["6a.m.", "6am"],
        ["6 am", "6a.m."],
        ["6 a.m.", "6am"],
        ["6am", "6 am"],
        ["6 A.M.", "6am"],
        ["6p.m.", "6pm"],
        ["6:30a.m.", "6:30am"],
      ];
      for (const [storedTime, queryTime] of cases) {
        const { runtime, rows } = makeRuntime();
        const targetId = seedFact(rows, {
          text: `The user usually wakes up at ${storedTime}`,
          entityId: USER_ID,
        });
        seedFact(rows, {
          text: "The user usually wakes up at 7am",
          entityId: USER_ID,
        });
        seedFact(rows, {
          text: `The user usually wakes up at ${storedTime}`,
          entityId: OTHER_USER_ID,
        });
        const untouchedRows = structuredClone(rows.slice(1));
        const replacement = "The user usually wakes up at 8am";
        const result = await runAction(runtime, makeMessage(), {
          action,
          query: `usually wake up at ${queryTime}`,
          text: replacement,
          confirm: true,
        });
        expect(result.success).toBe(true);
        const target = rows.find((row) => row.memory.id === targetId);
        if (action === "delete") expect(target).toBeUndefined();
        else expect(target?.memory.content.text).toBe(replacement);
        expect(rows.filter((row) => row.memory.id !== targetId)).toEqual(
          untouchedRows,
        );
      }
    },
  );
  it("returns sibling candidates for selective deletion by id before any mutation", async () => {
    // Live 2026-09-06 05:40: "forget my dog's name" removed "user's dog is
    // named Biscuit" and left the extractor's "User has_dog Biscuit" row from
    // the same message, so the bot still knew the name.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "user's dog is named Biscuit",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-1" },
    });
    seedFact(rows, {
      text: "User has_dog Biscuit",
      entityId: USER_ID,
      metadata: { messageId: "msg-dog-1" },
    });
    seedFact(rows, {
      text: "User likes jazz.",
      entityId: USER_ID,
      metadata: { messageId: "msg-jazz" },
    });
    const targetIds = rows.slice(0, 2).map((row) => row.memory.id);
    const originalRows = structuredClone(rows);
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "user's dog is named Biscuit",
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MEMORY_AMBIGUOUS_QUERY",
      candidates: expect.arrayContaining(
        targetIds.map((id) => expect.objectContaining({ id })),
      ),
    });
    expect(result.effectReceipts).toBeUndefined();
    expect(rows).toEqual(originalRows);
    for (const memoryId of targetIds) {
      if (!memoryId) throw new Error("Seeded fact must have an id");
      const deletion = await runAction(runtime, makeMessage(), {
        action: "delete",
        memoryId,
        confirm: true,
      });
      expect(deletion.success).toBe(true);
    }
    const left = rows.filter((row) => row.tableName === "facts");
    expect(left).toHaveLength(1);
    expect(String(left[0]?.memory.content.text)).toContain("jazz");
  });

  it("matches clock times across abbreviation dots and spacing (6am vs 6a.m. vs 6 am)", async () => {
    // Live 2026-09-06 02:36: "forget that I usually wake up at 6am" scanned 20
    // rows and matched nothing against "The user usually wakes up at 6a.m.".
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The user usually wakes up at 6a.m.",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "usually wake up at 6 am",
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(rows.filter((row) => row.tableName === "facts")).toHaveLength(0);
  });

  it.each(["delete", "update"] as const)(
    "%s preserves distinct query targets",
    async (action) => {
      const cases: Array<[string, string]> = [
        ["User takes a 1.5mg dose nightly.", "takes 15mg dose nightly"],
        [
          "User runs firmware v1.2 on the router.",
          "runs firmware v12 on the router",
        ],
        [
          "User's blog lives at example.com today.",
          "blog lives at examplecom today",
        ],
        ["The service is hosted at a.b.com", "hosted at ab.com"],
        [
          "The service is hosted at x.y.example.com",
          "hosted at xy.example.com",
        ],
        ["The service is hosted at 6a.m.com", "hosted at 6amcom"],
        ["The setting is config1a.m", "setting config1am"],
        ["The user usually wakes up at 6a.m.", "usually wake up at 6pm"],
        [
          "The user usually wakes up at 6a.m.",
          "does not usually wake up at 6am",
        ],
      ];
      for (const [stored, query] of cases) {
        const { runtime, rows } = makeRuntime();
        seedFact(rows, { text: stored, entityId: USER_ID });
        const originalRows = structuredClone(rows);
        const result = await runAction(runtime, makeMessage(), {
          action,
          query,
          text: "Replacement content for the requested target",
          confirm: true,
        });
        expect(result.success).toBe(false);
        expect(result.data).toMatchObject({ error: "MEMORY_NOT_FOUND" });
        expect(result.effectReceipts).toBeUndefined();
        expect(rows).toEqual(originalRows);
      }
    },
  );

  it("keeps a UUID-shaped search query as a filter instead of adopting it as the id", async () => {
    const { runtime, rows } = makeRuntime();
    const id = seedFact(rows, { text: "User likes jazz.", entityId: USER_ID });
    seedFact(rows, { text: "User likes hiking.", entityId: USER_ID });
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: String(id),
    });
    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ count: 0 });
  });

  it("treats a UUID-shaped query as the memory id when memoryId is absent", async () => {
    const { runtime, rows } = makeRuntime();
    const id = seedFact(rows, {
      text: "User likes jazz.",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: String(id),
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(rows.filter((row) => row.tableName === "facts")).toHaveLength(0);
  });

  it("matches a verb's -ing form against the stored base form", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "User usually wakes up at 6am.",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "waking up at 6am",
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(rows.filter((row) => row.tableName === "facts")).toHaveLength(0);
  });

  it("does not let a short term match an unrelated stored word", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "User takes the bus to work.",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "takes the bu to work",
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(rows.filter((row) => row.tableName === "facts")).toHaveLength(1);
  });

  it("matches the user's phrasing against a stored sentence across inflection and pronouns", async () => {
    // Live 2026-09-06 01:20: "forget that I like my coffee with oat milk" found
    // nothing although "User likes their coffee with oat milk." was stored.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "User likes their coffee with oat milk.",
      entityId: USER_ID,
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "like my coffee with oat milk",
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ deletedCount: 1 });
    expect(rows.filter((row) => row.tableName === "facts")).toHaveLength(0);
  });

  it("forgets stored facts but never the chat transcript when no type is given", async () => {
    const { runtime, rows } = makeRuntime();
    const factId = seedFact(rows, {
      text: "drinks tea without sugar",
      entityId: USER_ID,
    });
    rows.push({
      memory: {
        id: crypto.randomUUID() as UUID,
        entityId: USER_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "forget that I drink my tea without sugar" },
        createdAt: Date.now(),
      } as Memory,
      tableName: "messages",
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "tea without sugar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ deletedCount: 1 });
    expect(rows.find((row) => row.memory.id === factId)).toBeUndefined();
    expect(rows.filter((row) => row.tableName === "messages")).toHaveLength(1);
  });

  it("requires explicit ids for the requester's matching facts with different wording", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "User takes their tea without sugar.",
      entityId: USER_ID,
    });
    seedFact(rows, { text: "takes tea without sugar", entityId: USER_ID });
    const before = structuredClone(rows);

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "takes tea without sugar",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(result.effectReceipts).toBeUndefined();
    expect(rows).toEqual(before);
    for (const row of before) expect(result.text).toContain(row.memory.id);
  });

  it("stays ambiguous when a matching row is not one of the requester's facts", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "User takes their tea without sugar.",
      entityId: USER_ID,
    });
    rows.push({
      memory: {
        id: crypto.randomUUID() as UUID,
        entityId: USER_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "takes tea without sugar" },
        createdAt: Date.now(),
      } as Memory,
      tableName: "memories",
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "takes tea without sugar",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(rows).toHaveLength(2);
  });

  it("stays ambiguous for a short phrase that matches several facts", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "likes green tea", entityId: USER_ID });
    seedFact(rows, { text: "drinks tea at night", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "tea",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(rows.filter((row) => row.tableName === "facts")).toHaveLength(2);
  });

  it("still deletes from an explicitly named table", async () => {
    const { runtime, rows } = makeRuntime();
    rows.push({
      memory: {
        id: crypto.randomUUID() as UUID,
        entityId: USER_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "scratch note about tea" },
        createdAt: Date.now(),
      } as Memory,
      tableName: "messages",
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "scratch note about tea",
      type: "messages",
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(rows.filter((row) => row.tableName === "messages")).toHaveLength(0);
  });
});

describe("MEMORY op:update", () => {
  it("does not mistake this turn's extracted update request for an older saved fact", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    seedFact(rows, {
      text: "Indigo Finch review starts at 6 a.m.",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "Indigo Finch review time changes from 6 a.m. to 7 a.m.",
      entityId: USER_ID,
    });
    rows[1].memory.metadata = {
      type: "custom",
      source: "facts_and_relationships_stage",
      messageId: message.id,
    };
    const before = structuredClone(rows);
    const result = await runAction(runtime, message, {
      action: "update",
      type: "facts",
      query: "Indigo Finch review time",
      text: "Indigo Finch review starts at 7 a.m.",
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_NOT_FOUND" });
    expect(rows).toEqual(before);
  });

  it("updates an extractor relationship row through a natural query with filler words", async () => {
    // Live 2026-09-06 20:52: the owner asked to anonymise their sister; the
    // planner sent query "sister named Dana" and the update reported no match
    // because "named" counted as a required term against "user has_sister Dana".
    const { runtime, rows } = makeRuntime();
    const id = seedFact(rows, {
      text: "user has_sister Dana",
      entityId: USER_ID,
      metadata: { source: "facts_and_relationships_stage" },
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "update",
      query: "sister named Dana",
      text: "the user has a sister but wants to keep her name anonymous",
      confirm: true,
    });
    expect(result.success).toBe(true);
    const updated = rows.find((row) => row.memory.id === id);
    expect(updated?.memory.content.text).toBe(
      "the user has a sister but wants to keep her name anonymous",
    );
  });

  it("updates saved knowledge by default without rewriting a matching chat message", async () => {
    const { runtime, rows } = makeRuntime();
    const text = "Indigo Finch review starts at 6 a.m.";
    seedFact(rows, { text, entityId: USER_ID });
    rows.push({
      tableName: "messages",
      memory: { ...makeMessage(), content: { text } },
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "update",
      query: text,
      text: "Indigo Finch review starts at 7 a.m.",
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(rows[0].memory.content.text).toContain("7 a.m.");
    expect(rows[1].memory.content.text).toBe(text);
  });

  it("updates a text-only memory without requiring an embedding provider", async () => {
    const { runtime, rows } = makeRuntime();
    const memoryId = seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "update",
      memoryId,
      text: "the project codename is Nightjar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(rows[0].memory.content.text).toBe(
      "the project codename is Nightjar",
    );
    expect(rows[0].memory.embedding).toBeUndefined();
  });

  it("regenerates the vector when updating an embedded memory", async () => {
    const { runtime, rows } = makeRuntime({ embeddingResult: [0.4, 0.8] });
    const memoryId = seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: USER_ID,
    });
    rows[0].memory.embedding = [0.1, 0.2];

    const result = await runAction(runtime, makeMessage(), {
      action: "update",
      memoryId,
      text: "the project codename is Nightjar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(rows[0].memory.embedding).toEqual([0.4, 0.8]);
  });

  it("resolves a uniquely matching requester memory from a query", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: OTHER_USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "update",
      query: "project codename Kingfisher",
      text: "the project codename is Nightjar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(rows[0].memory.content.text).toBe(
      "the project codename is Nightjar",
    );
    expect(rows[1].memory.content.text).toBe(
      "the project codename is Kingfisher",
    );
  });

  it("refuses a query that matches distinct requester memories", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "the project codename is Kingfisher",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "the archived project codename is Kingfisher Two",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "update",
      query: "project codename Kingfisher",
      text: "the project codename is Nightjar",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_AMBIGUOUS_QUERY" });
    expect(
      rows.every(
        (row) => !(row.memory.content.text ?? "").includes("Nightjar"),
      ),
    ).toBe(true);
  });
});

describe("MEMORY op:create", () => {
  it("persists to the facts table scoped to the conversation room and speaker", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();

    const result = await runCreate(runtime, message, {
      text: "the user's favorite color is blue",
      kind: "preference",
      tags: ["color"],
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(1);
    const { memory, tableName, unique } = rows[0];
    expect(tableName).toBe("facts");
    expect(unique).toBe(true);
    expect(memory.entityId).toBe(USER_ID);
    expect(memory.roomId).toBe(ROOM_ID);
    expect(memory.content.text).toBe("the user's favorite color is blue");

    const metadata = memory.metadata as Record<string, unknown>;
    expect(metadata.kind).toBe("durable");
    expect(metadata.category).toBe("preference");
    expect(metadata.keywords).toEqual(["color"]);
    expect(metadata.confidence).toBeGreaterThan(0.7);
    expect(metadata.verificationStatus).toBe("self_reported");
  });

  it("is retrievable by the FACTS provider candidate queries", async () => {
    // The FACTS provider builds two candidate pools over the `facts` table:
    // one scoped to the conversation room, one to the speaker's entity ids.
    // The old write (agent-scoped `memories` table in a synthetic room)
    // matched neither, so the saved fact could never be recalled.
    const { runtime } = makeRuntime();
    await runCreate(runtime, makeMessage(), {
      text: "the user's dog is named Jeff",
    });

    const roomPool = await runtime.getMemories({
      tableName: "facts",
      roomId: ROOM_ID,
    });
    expect(roomPool).toHaveLength(1);
    expect(roomPool[0].content.text).toBe("the user's dog is named Jeff");

    const entityPool = await runtime.getMemories({
      tableName: "facts",
      entityId: USER_ID,
    });
    expect(entityPool).toHaveLength(1);
    expect(entityPool[0].content.text).toBe("the user's dog is named Jeff");
  });

  it("labels retired inference evidence without hiding its original text or explicit saved memories", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "favorite tea is jasmine",
      entityId: USER_ID,
      metadata: { extractionStatus: "source_invalidated" },
    });
    seedFact(rows, {
      text: "favorite tea is rooibos",
      entityId: USER_ID,
      metadata: { source: "MEMORY", extractionStatus: "source_invalidated" },
    });
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "favorite tea",
    });
    expect(result.success).toBe(true);
    const memories = (
      result.data as {
        memories: Array<{ text: string; evidenceStatus?: string }>;
      }
    ).memories;
    expect(
      memories.find((row) => row.text.includes("jasmine"))?.evidenceStatus,
    ).toBe("inactive");
    expect(
      memories.find((row) => row.text.includes("rooibos"))?.evidenceStatus,
    ).toBeUndefined();
    expect(result.text).toContain("INACTIVE source evidence");
    expect(result.text).toContain("favorite tea is jasmine");
  });

  it("is found by MEMORY op:search after create", async () => {
    const { runtime } = makeRuntime();
    const message = makeMessage();
    await runCreate(runtime, message, {
      text: "the user's favorite color is blue",
    });

    const result = await runAction(runtime, message, {
      action: "search",
      query: "favorite color",
    });
    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toBe("the user's favorite color is blue");
  });

  it("falls back to the agent entity when the message has none", async () => {
    const { runtime, rows } = makeRuntime();
    const message = {
      ...makeMessage(),
      entityId: undefined,
    } as unknown as Memory;
    const result = await runCreate(runtime, message, { text: "agent note" });
    expect(result.success).toBe(true);
    expect(rows[0].memory.entityId).toBe(AGENT_ID);
  });

  it("rejects an empty text", async () => {
    const { runtime, rows } = makeRuntime();
    const result = await runCreate(
      runtime,
      makeMessage({ text: "what should I have for lunch?" }),
      { text: "   " },
    );
    expect(result.success).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe("MEMORY op:search identity-cluster expansion", () => {
  it("finds a fact stored under a cluster sibling of the requested entityId", async () => {
    // Live failure shape: the FACTS provider surfaced "nubs plays guitar"
    // (stored under sibling entity ids) while MEMORY search on the primary
    // entityId reported "Found 0 (total 0)". Search must read through the
    // same identity-cluster expansion the provider uses.
    const { runtime, rows } = makeRuntime({
      clusters: { [USER_ID]: [SIBLING_ID] },
    });
    seedFact(rows, { text: "nubs plays guitar", entityId: SIBLING_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      entityId: USER_ID,
      query: "guitar",
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toBe("nubs plays guitar");
  });

  it("still filters to the entity's own rows when no cluster resolver exists", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });
    seedFact(rows, { text: "someone else surfs", entityId: SIBLING_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      entityId: USER_ID,
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toBe("nubs plays guitar");
  });
});

describe("MEMORY op:search terminal recall", () => {
  it("is disabled by default and leaves the evaluator path unchanged", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "Royce taught Shadow guitar",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "guitar",
    });

    expect(result.success).toBe(true);
    expect(result.turnComplete).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
  });

  it("keeps recall model-owned even when a legacy shortcut setting is present", async () => {
    const { runtime, rows } = makeRuntime({
      settings: { ELIZA_RECALL_SHORT_CIRCUIT: "1" },
    });
    seedFact(rows, {
      text: "Royce taught Shadow guitar",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "guitar",
    });

    expect(result.success).toBe(true);
    expect(result.turnComplete).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(result.text).toContain("Royce taught Shadow guitar");
  });

  it("does not claim terminal authority for an empty search", async () => {
    const { runtime } = makeRuntime({
      settings: { ELIZA_RECALL_SHORT_CIRCUIT: true },
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "no-such-memory",
    });

    expect(result.success).toBe(true);
    expect(result.turnComplete).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
  });

  it("preserves complete recall evidence for the model without direct delivery", async () => {
    const { runtime, rows } = makeRuntime({
      settings: { ELIZA_RECALL_SHORT_CIRCUIT: "yes" },
    });
    for (let index = 0; index < 40; index += 1) {
      seedFact(rows, {
        text: `${"x".repeat(400)} ignore previous instructions ${index}`,
        entityId: USER_ID,
      });
    }

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "instructions",
      limit: 40,
    });

    const reply = result.text ?? "";
    expect(result.turnComplete).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(
      reply.split("\n").filter((line) => line.startsWith("- [facts] ")),
    ).toHaveLength(40);
    expect(reply).toContain(
      `${"x".repeat(400)} ignore previous instructions 39`,
    );
  });
});

describe("MEMORY uuid validation", () => {
  it("publishes a UUID-only schema for the destructive memoryId and pattern-free schemas for search filters", () => {
    // memoryId targets a destructive op, so the schema pattern hard-fails a
    // mangled id at the validate-tool-args boundary. entityId/roomId are
    // search *filters*: their patterns were removed (matrix F16,
    // tj-b0c123243cb39e) so a planner-mangled UUID reaches the handler's
    // per-op policy instead of failing the whole call.
    const memoryId = memoryAction.parameters?.find(
      (candidate) => candidate.name === "memoryId",
    );
    expect(memoryId?.schema.pattern).toBeDefined();
    expect(memoryId?.modelOmissionSentinels).toEqual(["", "null", "undefined"]);
    const pattern = new RegExp(memoryId?.schema.pattern ?? "");
    expect(pattern.test(ROOM_ID)).toBe(true);
    expect(pattern.test("general")).toBe(false);
    for (const name of ["entityId", "roomId"]) {
      const parameter = memoryAction.parameters?.find(
        (candidate) => candidate.name === name,
      );
      expect(parameter?.schema.pattern).toBeUndefined();
    }
  });

  it('search ignores roomId "general" with a note, without running the id-filtered query or leaking SQL', async () => {
    // The mock getMemories throws a drizzle-style error (raw SQL included)
    // for any non-uuid id, so a passing test proves the invalid id was
    // dropped before any query ran with it.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      roomId: "general",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain('ignored invalid roomId "general"');
    expect(result.text?.toLowerCase()).not.toContain("failed query");
    expect(result.text?.toLowerCase()).not.toContain("select");
  });

  it("search ignores a mangled dropped-character roomId and still finds rows (matrix F16)", async () => {
    // Live shape: GLM copied the context roomId and dropped a hex char
    // (seven-character first segment). The unusable filter is ignored —
    // searching all rooms is a superset of the intended scope.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "paris weather note", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      roomId: "b9db237-57f1-0d75-ae29-d0988d883b78",
      query: "paris weather",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("ignored invalid roomId");
    expect(result.text).toContain("paris weather note");
  });

  it("search ignores a partial-uuid entityId with a note", async () => {
    const { runtime } = makeRuntime();
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      entityId: "0b8db237",
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('ignored invalid entityId "0b8db237"');
    expect(result.text?.toLowerCase()).not.toContain("failed query");
  });

  it("handles a partial-uuid memoryId on delete cleanly", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      memoryId: "82bdd9bb",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_INVALID_UUID",
    );
    expect(result.text?.toLowerCase()).not.toContain("failed query");
    expect(rows).toHaveLength(1);
  });
});

describe("MEMORY op:delete by query", () => {
  it("falls back to the user's own message when the planner sends confirm alone (live regression)", async () => {
    // Live 2026-09-11: "forget my favorite tea" dispatched `{"confirm": true}`;
    // the missing-target failure cost an evaluator round and a second planner
    // call before the query was quoted. The message text is the contract's
    // query, and the every-term match still guards the delete.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "nubs's favorite tea is darjeeling",
      entityId: USER_ID,
    });
    seedFact(rows, { text: "nubs lives on a boat", entityId: USER_ID });

    const result = await runAction(
      runtime,
      makeMessage({ text: "forget my favorite tea" }),
      { action: "delete", confirm: true },
    );

    expect(result.success).toBe(true);
    expect(result.userFacingText).toBe(
      "Forgot: nubs's favorite tea is darjeeling.",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.content.text).toBe("nubs lives on a boat");
  });

  it("reads the user's words through the external-content envelope (live regression)", async () => {
    // Connector messages arrive wrapped in the security envelope with the
    // real text retained in metadata.userPayloadText; the fallback must
    // query the payload, never the warning banner.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The user's favorite tea is oolong.",
      entityId: USER_ID,
    });
    const wrapped = makeMessage({
      text: "SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source. forget my favorite tea",
    });
    (wrapped.content as { metadata?: Record<string, unknown> }).metadata = {
      userPayloadText: "forget my favorite tea",
      externalContentWrapped: true,
    };

    const result = await runAction(runtime, wrapped, {
      action: "delete",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("ignores platform mention tokens in the implied query (live regression)", async () => {
    // Discord renders the addressed bot as "Eliza (@1490833425802854491)";
    // the name and id must not become query terms.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The user's favorite tea is oolong.",
      entityId: USER_ID,
    });

    const result = await runAction(
      runtime,
      makeMessage({
        text: "Eliza (@1490833425802854491) forget my favorite tea <@1490833425802854491>",
      }),
      { action: "delete", confirm: true },
    );

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("retries a planner-invented query with the user's own words before reporting a miss (live regression)", async () => {
    // Live 2026-09-13: the planner queried "favorite tea is matcha" for a
    // stored genmaicha fact twice before the message-text fallback ran.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The user's favorite tea is genmaicha.",
      entityId: USER_ID,
    });

    const result = await runAction(
      runtime,
      makeMessage({ text: "forget my favorite tea" }),
      { action: "delete", query: "favorite tea is matcha", confirm: true },
    );

    expect(result.success).toBe(true);
    expect(
      (result.data as { retriedWithMessageText?: boolean })
        .retriedWithMessageText,
    ).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("stores a target-less update as a new memory when no prior fact matches the user's words", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs lives on a boat", entityId: USER_ID });

    const result = await runAction(
      runtime,
      makeMessage({ text: "remember that my favorite tea is oolong" }),
      {
        action: "update",
        text: "The user's favorite tea is oolong.",
        confirm: true,
      },
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({
      op: "create",
      updateFallback: "created",
    });
    expect(result.userFacingText).toContain("favorite tea is oolong");
    expect(rows).toHaveLength(2);
    expect(
      rows.some(
        (row) =>
          row.memory.content.text === "The user's favorite tea is oolong.",
      ),
    ).toBe(true);
  });

  it("updates the prior fact a target-less update implies from the user's words", async () => {
    const { runtime, rows } = makeRuntime();
    const priorId = seedFact(rows, {
      text: "The user's favorite tea is oolong.",
      entityId: USER_ID,
      metadata: { source: "MEMORY", kind: "durable", messageId: "msg-old" },
    });

    const result = await runAction(
      runtime,
      makeMessage({ text: "remember that my favorite tea is oolong" }),
      {
        action: "update",
        text: "The user's favorite tea is oolong, loose leaf.",
        confirm: true,
      },
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ op: "update" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memory.id).toBe(priorId);
    expect(rows[0]?.memory.content.text).toBe(
      "The user's favorite tea is oolong, loose leaf.",
    );
  });

  it("returns the missing-target failure, not a verdict, when the implied query misses", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs lives on a boat", entityId: USER_ID });

    const result = await runAction(
      runtime,
      makeMessage({ text: "forget my favorite tea" }),
      { action: "delete", confirm: true },
    );

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe("MEMORY_MISSING_ID");
    expect(rows).toHaveLength(1);
  });

  it("still refuses a target-less delete when the message carries no content terms", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs lives on a boat", entityId: USER_ID });

    const result = await runAction(
      runtime,
      makeMessage({ text: "forget that" }),
      { action: "delete", confirm: true },
    );

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe("MEMORY_MISSING_ID");
    expect(rows).toHaveLength(1);
  });

  it("resolves the fact by text and deletes every duplicate row of it", async () => {
    // Reflection dedup failures store the same fact several times (live: six
    // copies of "nubs plays guitar" across two sibling entity ids). One
    // logical fact -> all rows removed.
    const { runtime, rows } = makeRuntime({
      clusters: { [USER_ID]: [SIBLING_ID] },
    });
    seedFact(rows, { text: "nubs plays guitar", entityId: SIBLING_ID });
    seedFact(rows, { text: "nubs plays guitar", entityId: SIBLING_ID });
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });
    seedFact(rows, { text: "nubs lives on a boat", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "nubs plays guitar",
      entityId: USER_ID,
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect((result.values as { deletedCount: number }).deletedCount).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.content.text).toBe("nubs lives on a boat");
  });

  it("scopes delete-by-query to the requesting user's identity cluster", async () => {
    // Multi-user room: another entity holds a fact with the exact same text.
    // "Forget that I play guitar" from USER_ID must remove only USER_ID's
    // row — a text-only match would silently delete the other user's fact.
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "i play guitar", entityId: USER_ID });
    seedFact(rows, { text: "i play guitar", entityId: OTHER_USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "i play guitar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect((result.values as { deletedCount: number }).deletedCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.entityId).toBe(OTHER_USER_ID);
  });

  it("deletes cluster-sibling rows of the requester but not a third user's", async () => {
    // The requester scope is identity-cluster expanded (getRelatedEntityIds),
    // so duplicates stored under the requester's sibling ids are still one
    // logical fact — while an unrelated user's identical text stays out.
    const { runtime, rows } = makeRuntime({
      clusters: { [USER_ID]: [SIBLING_ID] },
    });
    seedFact(rows, { text: "i play guitar", entityId: USER_ID });
    seedFact(rows, { text: "i play guitar", entityId: SIBLING_ID });
    seedFact(rows, { text: "i play guitar", entityId: OTHER_USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "i play guitar",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect((result.values as { deletedCount: number }).deletedCount).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].memory.entityId).toBe(OTHER_USER_ID);
  });

  it("refuses an ambiguous query matching distinct memories and lists ids", async () => {
    const { runtime, rows } = makeRuntime();
    const idA = seedFact(rows, {
      text: "nubs plays guitar",
      entityId: USER_ID,
    });
    const idB = seedFact(rows, {
      text: "nubs plays guitar hero on fridays",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "plays guitar",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_AMBIGUOUS_QUERY",
    );
    expect(result.text).toContain(idA);
    expect(result.text).toContain(idB);
    expect(rows).toHaveLength(2);
  });

  it("returns a clean not-found when no stored memory matches", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "rides a unicycle",
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe("MEMORY_NOT_FOUND");
    expect(rows).toHaveLength(1);
  });

  it("still requires confirm:true before deleting by query", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "nubs plays guitar", entityId: USER_ID });

    const result = await runAction(runtime, makeMessage(), {
      action: "delete",
      query: "nubs plays guitar",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_CONFIRMATION_REQUIRED",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("MEMORY op:search complete traversal", () => {
  it("matches literal source text without normalizing it and preserves other filters", async () => {
    const { runtime, rows } = makeRuntime();
    const query = "  Blue mug,\nnot green 🟣  ";
    const source = `Earlier words. ${query} Later words.`;
    const original = seedFact(rows, { text: source, entityId: USER_ID });
    for (const text of [
      "Blue mug, not green 🟣",
      "  blue mug,\nnot green 🟣  ",
      "The green mug was blue.",
    ])
      seedFact(rows, { text, entityId: USER_ID });
    seedFact(rows, { text: source, entityId: OTHER_USER_ID });
    seedFact(rows, {
      text: source,
      entityId: USER_ID,
      roomId: "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID,
    });
    const before = structuredClone(rows);
    const parameters = {
      action: "search",
      author: "any",
      type: "facts",
      entityId: USER_ID,
      roomId: ROOM_ID,
      query,
    };
    const literal = await runAction(runtime, makeMessage(), {
      ...parameters,
      queryMode: "literal",
    });
    expect(literal.success).toBe(true);
    expect(literal.data).toMatchObject({
      memories: [{ id: original, text: source }],
      totalMatches: 1,
    });
    expect(literal.text).toContain("queryMode=literal");
    const legacy = await runAction(runtime, makeMessage(), parameters);
    expect(legacy.values?.totalMatches).toBe(4);
    expect(
      await runAction(runtime, makeMessage(), {
        ...parameters,
        queryMode: "keywords",
      }),
    ).toEqual(legacy);
    expect(rows).toEqual(before);
  });

  it("retains every literal match across pages and preserves the mode on snapshot recovery", async () => {
    const { runtime, rows } = makeRuntime();
    const query = "Mug is blue, not green.";
    const expected = new Set<string>();
    for (let index = 0; index < 7; index++) {
      expected.add(
        seedFact(rows, { text: `${index}: ${query}`, entityId: USER_ID }),
      );
    }
    seedFact(rows, { text: "Green mug; blue notebook.", entityId: USER_ID });
    const parameters = {
      action: "search",
      author: "any",
      query,
      queryMode: "literal",
      limit: 3,
    };
    const first = await runAction(runtime, makeMessage(), parameters);
    const snapshot = String(first.values?.snapshot);
    const results = [first];
    for (const offset of [3, 6]) {
      results.push(
        await runAction(runtime, makeMessage(), {
          ...parameters,
          snapshot,
          offset,
        }),
      );
    }
    expect(results.every((result) => result.success)).toBe(true);
    expect(
      new Set(
        results.flatMap((result) =>
          (result.data as { memories: { id: string }[] }).memories.map(
            (row) => row.id,
          ),
        ),
      ),
    ).toEqual(expected);
    expect(results[2].values?.nextOffset).toBeNull();
    seedFact(rows, { text: query, entityId: USER_ID });
    const stale = await runAction(runtime, makeMessage(), {
      ...parameters,
      snapshot,
      offset: 3,
    });
    expect(stale.success).toBe(false);
    expect(stale.data).toMatchObject({
      error: "MEMORY_PAGE_SNAPSHOT_CHANGED",
      retryParameters: { queryMode: "literal", query, offset: 0 },
    });
  });

  it.each<TestParams>([
    { queryMode: "regex", query: "mug" },
    { queryMode: "literal" },
    { queryMode: "literal", query: "" },
    { queryMode: "literal", query: 42 },
  ])(
    "rejects invalid search modes instead of broadening the query: %j",
    async (parameters) => {
      const { runtime, rows } = makeRuntime();
      seedFact(rows, { text: "Mug is blue.", entityId: USER_ID });
      const before = structuredClone(rows);
      const result = await runAction(runtime, makeMessage(), {
        action: "search",
        ...parameters,
      });
      expect(result.success).toBe(false);
      expect(rows).toEqual(before);
    },
  );

  it("finds attachment descriptions without exposing capability URLs", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "", entityId: USER_ID });
    rows[0].memory.content = {
      attachments: [
        {
          id: "receipt-photo",
          url: "https://private.example/receipt.png",
          thumbnailUrl: "https://private.example/receipt-thumb.png",
          filename: "receipt.png",
          mimeType: "image/png",
          description: "A receipt showing a 6:30 PM dinner reservation",
        },
      ],
    };

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      type: "facts",
      query: "dinner reservation",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain(
      "[attachment: receipt.png; image/png; A receipt showing a 6:30 PM dinner reservation]",
    );
    expect(result.text).not.toContain("private.example");
  });

  it("distinguishes requester originals, assistant restatements and other speakers", async () => {
    const { runtime, rows } = makeRuntime();
    for (const [index, entityId] of [
      USER_ID,
      AGENT_ID,
      OTHER_USER_ID,
    ].entries()) {
      rows.push({
        tableName: "messages",
        memory: {
          id: `00000000-0000-0000-0000-00000000000${index + 1}` as UUID,
          agentId: AGENT_ID,
          entityId,
          roomId: ROOM_ID,
          createdAt: index + 1,
          content: { text: "Mira correction: burgundy charger" },
        } as Memory,
      });
    }
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      type: "messages",
      query: "burgundy",
    });
    expect(result.text).toContain(`[author=assistant; entityId=${AGENT_ID}]`);
    expect(result.text).toContain(`[author=requester; entityId=${USER_ID}]`);
    const original = await runAction(runtime, makeMessage(), {
      action: "search",
      type: "messages",
      query: "burgundy",
      entityId: USER_ID,
    });
    expect(original.text).not.toContain("[author=assistant;");
    expect(original.text).toContain(`[author=requester; entityId=${USER_ID}]`);
    expect(result.text).toContain(
      `[author=other speaker; entityId=${OTHER_USER_ID}]`,
    );
    expect(rows).toHaveLength(3);
  });

  it("resolves requester and assistant authors from the current turn without widening scope", async () => {
    const { runtime, rows } = makeRuntime();
    const thirdParty = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;
    for (const [index, entityId] of [USER_ID, AGENT_ID, thirdParty].entries()) {
      rows.push({
        tableName: "messages",
        memory: {
          id: crypto.randomUUID() as UUID,
          agentId: AGENT_ID,
          entityId,
          roomId: ROOM_ID,
          createdAt: index + 1,
          content: { text: "Mira correction: burgundy charger" },
        } as Memory,
      });
    }
    for (const [author, entityId] of [
      ["requester", USER_ID],
      ["assistant", AGENT_ID],
    ]) {
      const result = await runAction(runtime, makeMessage(), {
        action: "search",
        author,
        query: "burgundy",
      });
      expect(result.success).toBe(true);
      expect(result.text).toContain(`entityId=${entityId}`);
      expect(result.text).toContain(`[author=${author}; entityId=${entityId}]`);
      for (const other of [USER_ID, AGENT_ID, thirdParty].filter(
        (id) => id !== entityId,
      )) {
        expect(result.text).not.toContain(`entityId=${other}`);
      }
    }
    const differentRequester = { ...makeMessage(), entityId: thirdParty };
    const third = await runAction(runtime, differentRequester, {
      action: "search",
      author: "requester",
      query: "burgundy",
    });
    expect(third.success).toBe(true);
    expect(third.text).toContain(`entityId=${thirdParty}`);
    expect(third.text).toContain(`[author=requester; entityId=${thirdParty}]`);
    expect(third.text).not.toContain(`entityId=${USER_ID}`);
    expect(rows).toHaveLength(3);
  });

  it("keeps explicit any searches equivalent to legacy unfiltered calls and preserves other filters", async () => {
    const { runtime, rows } = makeRuntime();
    for (const [index, entityId] of [
      USER_ID,
      AGENT_ID,
      OTHER_USER_ID,
    ].entries()) {
      rows.push({
        tableName: "messages",
        memory: {
          id: crypto.randomUUID() as UUID,
          agentId: AGENT_ID,
          entityId,
          roomId: ROOM_ID,
          createdAt: index + 1,
          content: { text: "Mira correction: burgundy charger" },
        } as Memory,
      });
    }
    seedFact(rows, { text: "Mira likes burgundy.", entityId: USER_ID });
    const before = structuredClone(rows);
    const filterCases: TestParams[] = [
      {},
      { type: "facts" },
      { type: "messages" },
      { type: "messages", entityId: OTHER_USER_ID, roomId: ROOM_ID },
    ];
    for (const filters of filterCases) {
      const parameters = { action: "search", query: "Mira", ...filters };
      const legacy = await runAction(runtime, makeMessage(), parameters);
      const explicit = await runAction(runtime, makeMessage(), {
        ...parameters,
        author: "any",
      });
      expect(legacy.success).toBe(true);
      expect(explicit).toEqual(legacy);
    }
    expect(rows).toEqual(before);
  });

  it("rejects ambiguous or unavailable author filters instead of searching everyone", async () => {
    const { runtime } = makeRuntime();
    const invalidFilters: TestParams[] = [
      { author: "anyone" },
      { author: "requester", type: "facts" },
      { author: "requester", entityId: AGENT_ID },
      { author: "requester", entityId: "malformed" },
    ];
    for (const params of invalidFilters) {
      const result = await runAction(runtime, makeMessage(), {
        action: "search",
        ...params,
      });
      expect(result.success).toBe(false);
    }
    const missing = await runAction(
      runtime,
      { ...makeMessage(), entityId: undefined } as unknown as Memory,
      { action: "search", author: "requester" },
    );
    expect(missing.success).toBe(false);
  });

  it("ranks an exact all-term match ahead of newer partial decoys", async () => {
    const { runtime, rows } = makeRuntime();
    const targetId = seedFact(rows, {
      text: "the archival project codename is Copper Heron 9184",
      entityId: USER_ID,
    });
    rows[0].memory.createdAt = 1;
    seedFact(rows, {
      text: "the archival project codename is Copper Heron 8194",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "the archival project codename is Bronze Heron 9184",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      type: "facts",
      query: "archival project codename Copper Heron 9184",
    });

    expect(result.success).toBe(true);
    const responseText = result.text ?? "";
    expect(responseText.indexOf(targetId)).toBeLessThan(
      responseText.indexOf("Copper Heron 8194"),
    );
    expect(responseText).toContain("1970-01-01T00:00:00.001Z");
  });

  it("finds a matching fact older than the former 200-row window", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "my sister is named vega", entityId: USER_ID });
    for (let i = 0; i < 250; i++) {
      seedFact(rows, { text: `unrelated note ${i}`, entityId: USER_ID });
    }

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "sister",
    });

    const text = String(result.text ?? "");
    expect(text).toContain("my sister is named vega");
    expect(text).toContain("Scanned all 251 stored row(s)");
    expect(result.values).toMatchObject({
      totalMatches: 1,
      scanned: 251,
    });
  });

  it("reports a complete empty result when every row was considered", async () => {
    const { runtime, rows } = makeRuntime();
    // perTable = max(limit * 2, 200); the default limit is 50, so 200.
    for (let i = 0; i < 200; i++) {
      seedFact(rows, { text: `unrelated note ${i}`, entityId: USER_ID });
    }

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "unicycle",
    });

    const text = String(result.text ?? "");
    expect(text).toContain("Showing all 0 match(es)");
    expect(text).toContain("Scanned all 200 stored row(s)");
    expect(result.values).toMatchObject({ totalMatches: 0, scanned: 200 });
  });

  it("reports every rendered match when no result cap applies", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < 30; i++) {
      seedFact(rows, { text: `the user plays guitar ${i}`, entityId: USER_ID });
    }

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "guitar",
    });

    const text = String(result.text ?? "");
    expect(text).toContain("Showing all 30 match(es)");
    expect(text).toContain('query="guitar"');
    expect(text.split("\n").filter((l) => l.startsWith("- ["))).toHaveLength(
      30,
    );
    expect(result.values).toMatchObject({ rendered: 30, totalMatches: 30 });
  });

  it("returns an explicit lossless continuation when the caller requests a page", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < 12; i++) {
      seedFact(rows, { text: `invoice number ${i}`, entityId: USER_ID });
    }

    const first = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 5,
    });
    const snapshot = String(first.values?.snapshot);
    const second = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 5,
      offset: 5,
      snapshot,
    });
    const third = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 5,
      offset: 10,
      snapshot,
    });

    const pageTexts = [first, second, third].flatMap((result) => {
      const data = result.data as { memories: Array<{ text: string }> };
      return data.memories.map((memory) => memory.text);
    });
    expect(new Set(pageTexts)).toEqual(
      new Set(Array.from({ length: 12 }, (_, i) => `invoice number ${i}`)),
    );
    expect(first.values).toMatchObject({
      rendered: 5,
      totalMatches: 12,
      offset: 0,
      nextOffset: 5,
      snapshot,
    });
    expect(first.text).toContain("continue losslessly");
    expect(second.values).toMatchObject({ offset: 5, nextOffset: 10 });
    expect(third.values).toMatchObject({
      rendered: 2,
      offset: 10,
      nextOffset: null,
    });
  });

  it("rejects a caller page size above the enforced maximum", async () => {
    const { runtime } = makeRuntime();
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: MAX_MEMORY_PAGE_ITEMS + 1,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MEMORY_PAGE_LIMIT_EXCEEDED",
      requestedLimit: MAX_MEMORY_PAGE_ITEMS + 1,
      maxLimit: MAX_MEMORY_PAGE_ITEMS,
    });
  });

  it("pages the best-ranked matches instead of refusing an oversized complete search", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i <= MAX_MEMORY_PAGE_ITEMS; i++) {
      seedFact(rows, { text: `invoice number ${i}`, entityId: USER_ID });
    }

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({
      op: "search",
      totalMatches: MAX_MEMORY_PAGE_ITEMS + 1,
      offset: 0,
      nextOffset: 20,
    });
    expect((result.data as { memories: unknown[] }).memories).toHaveLength(20);
    expect(result.text).toContain("best-ranked");
    expect(result.text).toContain("limit=20, offset=20");
  });

  it("rejects one indivisible memory that exceeds the page character budget", async () => {
    const { runtime, rows } = makeRuntime();
    const memoryId = seedFact(rows, {
      text: `invoice ${"x".repeat(MAX_MEMORY_ACTION_RESULT_CHARS)}`,
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice",
      limit: 1,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MEMORY_RECORD_EXCEEDS_PAGE_BUDGET",
      memoryId,
      maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
    });
    expect(JSON.stringify(result).length).toBeLessThan(1_048_576);
  });

  it("keeps the maximum accepted page below the Codex input boundary", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < MAX_MEMORY_PAGE_ITEMS; i++) {
      seedFact(rows, { text: `invoice number ${i}`, entityId: USER_ID });
    }

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: MAX_MEMORY_PAGE_ITEMS,
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MAX_MEMORY_ACTION_RESULT_CHARS,
    );
    expect(JSON.stringify(result).length).toBeLessThan(1_048_576);
  });

  it("rejects an offset without an explicit page size", async () => {
    const { runtime } = makeRuntime();
    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      offset: 5,
    });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MEMORY_INVALID_PAGE" });
  });

  it("rejects a continuation when the ordered matches changed", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < 6; i++) {
      seedFact(rows, { text: `invoice number ${i}`, entityId: USER_ID });
    }
    const first = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 3,
    });
    seedFact(rows, { text: "invoice number 6", entityId: USER_ID });

    const continuation = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 3,
      offset: 3,
      snapshot: String(first.values?.snapshot),
    });

    expect(continuation.success).toBe(false);
    expect(continuation.data).toMatchObject({
      error: "MEMORY_PAGE_SNAPSHOT_CHANGED",
    });
    const { retryParameters } = continuation.data as {
      retryParameters: TestParams;
    };
    expect(retryParameters).not.toHaveProperty("snapshot");
    const restarted = await runAction(runtime, makeMessage(), retryParameters);
    expect(restarted.success).toBe(true);
    expect(restarted.values).toMatchObject({
      totalMatches: 7,
      offset: 0,
      nextOffset: 3,
    });
    expect(restarted.values?.snapshot).not.toBe(first.values?.snapshot);
  });

  it("restarts a narrowed search without dropping its author, room or query filters", async () => {
    const { runtime, rows } = makeRuntime();
    for (const [index, entityId, text, roomId] of [
      [1, USER_ID, "Rowan packs a green mug and yellow notebook.", ROOM_ID],
      [2, AGENT_ID, "Rowan packs a red mug.", ROOM_ID],
      [3, USER_ID, "Unrelated travel checklist.", ROOM_ID],
      [4, USER_ID, "Rowan is in another story.", SIBLING_ID],
    ] as const) {
      rows.push({
        tableName: "messages",
        memory: {
          id: `00000000-0000-0000-0000-00000000000${index}` as UUID,
          agentId: AGENT_ID,
          entityId,
          roomId,
          createdAt: index,
          content: { text },
        },
      });
    }
    const broad = await runAction(runtime, makeMessage(), {
      action: "search",
      limit: 2,
    });
    const narrowed = {
      action: "search",
      type: "messages",
      author: "requester",
      roomId: ROOM_ID,
      query: "Rowan",
      limit: 2,
      offset: 0,
    };
    const rejected = await runAction(runtime, makeMessage(), {
      ...narrowed,
      snapshot: String(broad.values?.snapshot),
    });
    expect(rejected.success).toBe(false);
    const { retryParameters } = rejected.data as {
      retryParameters: TestParams;
    };
    expect(retryParameters).toEqual(narrowed);
    const restarted = await runAction(runtime, makeMessage(), retryParameters);
    expect(restarted.success).toBe(true);
    expect(restarted.values).toMatchObject({
      totalMatches: 1,
      nextOffset: null,
    });
    expect(restarted.text).toContain(
      "Rowan packs a green mug and yellow notebook.",
    );
    expect(restarted.text).not.toContain("red mug");
    expect(restarted.text).not.toContain("Unrelated travel");
    expect(restarted.text).not.toContain("another story");
  });

  it("rejects a continuation when a matched record changes under the same id", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < 6; i++) {
      seedFact(rows, { text: `invoice number ${i}`, entityId: USER_ID });
    }
    const first = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 3,
    });
    rows[0].memory.content.text = "invoice number corrected in place";

    const continuation = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "invoice number",
      limit: 3,
      offset: 3,
      snapshot: String(first.values?.snapshot),
    });

    expect(continuation.success).toBe(false);
    expect(continuation.data).toMatchObject({
      error: "MEMORY_PAGE_SNAPSHOT_CHANGED",
    });
  });

  it("does not treat one weak token as a multi-word query match", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < 100; i++) {
      seedFact(rows, {
        text: `Would you like to revisit the reading list item ${i}?`,
        entityId: USER_ID,
      });
    }
    seedFact(rows, {
      text: "The owner's newest archival project codename is Silver Falcon 2042.",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "newest archival project codename told you",
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toContain("Silver Falcon 2042");
    expect(result.values).toMatchObject({ totalMatches: 1, scanned: 101 });
  });

  it("matches separate rows for a natural cross-topic query", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The tomato variety that ripened first was Sungold.",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "The Kyoto booking is at Kumo Ryokan.",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "The first ten minutes of the recording were silent.",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "which tomato ripened first and where is the Kyoto booking",
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories.map((memory) => memory.text)).toEqual([
      "The tomato variety that ripened first was Sungold.",
      "The Kyoto booking is at Kumo Ryokan.",
    ]);
  });

  it("keeps a single exact anchor for a two-term query", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, {
      text: "The owner is allergic to pistachios, not almonds.",
      entityId: USER_ID,
    });
    seedFact(rows, {
      text: "The first ten minutes of the recording were silent.",
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "nut allergic",
    });

    expect(result.success).toBe(true);
    const data = result.data as { memories: Array<{ text: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].text).toContain("pistachios");
  });

  it("rejects a repeated full page instead of returning partial memories", async () => {
    const { runtime, rows } = makeRuntime();
    for (let i = 0; i < 10_000; i++) {
      seedFact(rows, { text: `memory ${i}`, entityId: USER_ID });
    }
    const firstPage = await runtime.getMemories({
      tableName: "facts",
      limit: 10_000,
    });
    runtime.getMemories = async ({ tableName }) =>
      tableName === "facts" ? firstPage : [];

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      type: "facts",
      query: "memory",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_TRAVERSAL_REPEATED_ROW",
    );
  });

  it("rejects an inventory that changes between traversal passes", async () => {
    const { runtime, rows } = makeRuntime();
    seedFact(rows, { text: "stable memory", entityId: USER_ID });
    const originalCount = runtime.countMemories.bind(runtime);
    let factsCountCalls = 0;
    runtime.countMemories = async (params) => {
      const count = await originalCount(params);
      if (params.tableName !== "facts") return count;
      factsCountCalls += 1;
      return factsCountCalls === 1 ? count : count + 1;
    };

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      type: "facts",
      query: "stable",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error: string }).error).toBe(
      "MEMORY_TRAVERSAL_INVENTORY_CHANGED",
    );
  });
});

describe("MEMORY routing aliases", () => {
  it("resolves planner-generated LIST_MEMORIES / SEARCH_MEMORY to MEMORY", () => {
    // Mirrors buildRuntimeActionLookup (core services/message.ts): canonical
    // action names claim their normalized identifier first, then similes fill
    // the remaining slots. Without these aliases a listing intent fell
    // through to VIEWS and errored.
    const lookup = new Map<string, string>();
    const actions = [memoryAction];
    for (const action of actions) {
      const normalized = normalizeActionIdentifier(action.name);
      if (normalized && !lookup.has(normalized))
        lookup.set(normalized, action.name);
    }
    for (const action of actions) {
      for (const simile of action.similes ?? []) {
        const normalized = normalizeActionIdentifier(simile);
        if (normalized && !lookup.has(normalized))
          lookup.set(normalized, action.name);
      }
    }

    expect(lookup.get(normalizeActionIdentifier("LIST_MEMORIES"))).toBe(
      "MEMORY",
    );
    expect(lookup.get(normalizeActionIdentifier("SEARCH_MEMORY"))).toBe(
      "MEMORY",
    );
  });

  it("resolves the bare stage-1 RECALL_MEMORY candidate to MEMORY", () => {
    const lookup = new Map<string, string>();
    const normalized = normalizeActionIdentifier(memoryAction.name);
    if (normalized) lookup.set(normalized, memoryAction.name);
    for (const simile of memoryAction.similes ?? []) {
      const key = normalizeActionIdentifier(simile);
      if (key && !lookup.has(key)) lookup.set(key, memoryAction.name);
    }
    for (const candidate of [
      "RECALL_MEMORY",
      "RECALL_MEMORIES",
      "MEMORY_RECALL",
      "MEMORY_SEARCH",
    ]) {
      expect(lookup.get(normalizeActionIdentifier(candidate))).toBe("MEMORY");
    }
  });
});

describe("MEMORY op:search rendered text", () => {
  it("keeps complete paginated sources once in planner results and preserves standalone text", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    const exactText = `  SOURCE_COPY_MARKER\r\n"Don’t change this."\\path\t🟣e\u0301\n${"long source ".repeat(250)}\nCorrection: violet, not green.  `;
    for (const [index, entityId] of [USER_ID, AGENT_ID, USER_ID].entries()) {
      rows.push({
        tableName: "messages",
        memory: {
          id: crypto.randomUUID() as UUID,
          agentId: AGENT_ID,
          entityId,
          roomId: ROOM_ID,
          createdAt: index + 1,
          content: { text: exactText },
        },
      });
    }
    const params = {
      action: "search",
      type: "messages",
      query: "violet",
      limit: 2,
    };
    const standalone = await runAction(runtime, message, params);
    expect(standalone.text).toContain(exactText);
    const frame = {
      actionName: "MEMORY_SEARCH",
      modelClass: undefined,
      messageId: message.id,
      replyOwner: "planner" as const,
    };
    const first = await runWithActionRoutingContext(frame, () =>
      runAction(runtime, message, params),
    );
    const second = await runWithActionRoutingContext(frame, () =>
      runAction(runtime, message, {
        ...params,
        offset: 2,
        snapshot: String(first.values?.snapshot),
      }),
    );
    expect(first.values).toEqual(standalone.values);
    expect(first.values).toMatchObject({
      count: 2,
      rendered: 2,
      totalMatches: 3,
      nextOffset: 2,
    });
    expect(second.values).toMatchObject({
      count: 1,
      rendered: 1,
      totalMatches: 3,
      nextOffset: null,
    });
    const originals = structuredClone(rows);
    const sourceIds = new Set<unknown>();
    for (const result of [first, second]) {
      const converted = actionResultToPlannerToolResult(result);
      const rendered = toolMessageContent(converted);
      const wire = JSON.parse(rendered);
      const records = wire.data.memories;
      expect(wire.data.values).toEqual(result.values);
      expect(records).toEqual(result.data?.memories);
      expect(rendered.match(/SOURCE_COPY_MARKER/g)).toHaveLength(
        records.length,
      );
      for (const record of records) {
        expect(record.text).toBe(exactText);
        expect(record.createdAtIso).toBe(
          new Date(record.createdAt).toISOString(),
        );
        expect(record.authorRole).toBe(
          record.entityId === AGENT_ID ? "assistant" : "requester",
        );
        expect(record.roomId).toBe(ROOM_ID);
        expect(record.agentId).toBe(AGENT_ID);
        sourceIds.add(record.id);
      }
    }
    expect(sourceIds).toEqual(new Set(rows.map((row) => row.memory.id)));
    expect(rows).toEqual(originals);
    const wrongTurn = await runWithActionRoutingContext(
      { ...frame, messageId: crypto.randomUUID() },
      () => runAction(runtime, message, params),
    );
    expect(wrongTurn.text).toBe(standalone.text);
    const spoofed = await runAction(runtime, message, {
      ...params,
      replyOwner: "planner",
    });
    expect(spoofed.text).toBe(standalone.text);
  });

  it("redacts structured source credentials without rewriting runtime evidence", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    const knownSecret = 'known-secret-with-"quotes"\nand-a-newline';
    runtime.redactSecrets = (text) =>
      text.replaceAll(knownSecret, "[REDACTED]");
    const text =
      '{"apiKey":"synthetic-key-value"}\n--token="synthetic-token-value"\n' +
      knownSecret +
      '\nRetain the correction: "violet", not green.';
    seedFact(rows, { text, entityId: USER_ID });
    const result = await runWithActionRoutingContext(
      {
        actionName: "MEMORY_SEARCH",
        modelClass: undefined,
        messageId: message.id,
        replyOwner: "planner",
      },
      () =>
        runAction(runtime, message, {
          action: "search",
          type: "facts",
          query: "violet",
        }),
    );
    const rendered = renderActionResultsForModel([result], {
      redactText: composeToolDiagnosticRedactor(runtime),
    }).text;
    const jsonLine = rendered.split("\n").find((line) => line.startsWith("{"));
    if (!jsonLine) throw new Error("model result JSON missing");
    const record = JSON.parse(jsonLine).data.memories[0];
    expect(record.text).not.toContain("synthetic-key-value");
    expect(record.text).not.toContain("synthetic-token-value");
    expect(record.text).not.toContain(knownSecret);
    expect(record.text).toContain(
      '[REDACTED]\nRetain the correction: "violet", not green.',
    );
    expect(result.data?.memories).toEqual([expect.objectContaining({ text })]);
    expect(rows[0].memory.content.text).toBe(text);
  });

  it("preserves the complete text of each hit", async () => {
    const { runtime, rows } = makeRuntime();
    const head = "CORRECTION (2026-08-18): the user's earlier claim was ";
    const operative =
      "retracted because it quoted song lyrics, not a real decision";
    const filler = "x".repeat(1_000);
    seedFact(rows, {
      text: `${head}${filler} ${operative}`,
      entityId: USER_ID,
    });

    const result = await runAction(runtime, makeMessage(), {
      action: "search",
      query: "correction claim retracted",
    });
    expect(result.success).toBe(true);
    const text = String(result.text ?? "");
    expect(text).toContain(operative);
    expect(result.promptData).toMatchObject({
      actionName: "MEMORY",
      op: "search",
      totalMatches: 1,
      rendered: 1,
    });
    expect(result.promptData).not.toHaveProperty("memories");
  });
});

describe("promoted MEMORY_UPDATE / MEMORY_DELETE target selection", () => {
  const children = promoteSubactionsToActions(memoryAction);

  async function runPromotedMutation(
    operation: "update" | "delete",
    runtime: IAgentRuntime,
    parameters: Record<string, unknown>,
    message: Memory = makeMessage(),
  ): Promise<ActionResult> {
    const name = `MEMORY_${operation.toUpperCase()}`;
    const action = children.find((candidate) => candidate.name === name);
    if (!action) throw new Error(`missing promoted child ${name}`);
    const validated = validateToolArgs(action, parameters);
    expect(validated.errors).toEqual([]);
    if (!validated.valid || !validated.args) {
      throw new Error(`Promoted mutation arguments rejected for ${name}`);
    }
    return (await action.handler(runtime, message, undefined, {
      parameters: validated.args,
    } as never)) as ActionResult;
  }

  for (const operation of ["update", "delete"] as const) {
    describe(operation, () => {
      it.each(["memoryId", "query"] as const)(
        "accepts %s alone through validation and mutates only the selected record",
        async (selector) => {
          const { runtime, rows } = makeRuntime();
          const originalText = "My favorite tea is green tea.";
          const replacementText = "My favorite tea is oolong.";
          const memoryId = seedFact(rows, {
            text: originalText,
            entityId: USER_ID,
          });
          const unrelatedId = seedFact(rows, {
            text: "The project codename is Kingfisher.",
            entityId: USER_ID,
          });
          const unrelated = structuredClone(
            rows.find((row) => row.memory.id === unrelatedId),
          );

          const result = await runPromotedMutation(operation, runtime, {
            confirm: true,
            ...(operation === "update" ? { text: replacementText } : {}),
            ...(selector === "memoryId"
              ? { memoryId }
              : { query: originalText }),
          });

          expect(result.success).toBe(true);
          expect(result.effectReceipts).toHaveLength(1);
          expect(result.effectReceipts?.[0]).toMatchObject({
            operation: `memory.${operation}`,
            resource: { id: memoryId },
            outcome: "applied",
          });
          expect(
            rows.find((row) => row.memory.id === memoryId)?.memory.content.text,
          ).toBe(operation === "update" ? replacementText : undefined);
          expect(rows.find((row) => row.memory.id === unrelatedId)).toEqual(
            unrelated,
          );
        },
      );

      it.each([
        { name: "missing", parameters: {} },
        { name: "empty", parameters: { query: "" } },
        { name: "whitespace-only", parameters: { query: " \t\n" } },
      ])(
        "rejects a $name selector at the handler without changing any record",
        async ({ parameters }) => {
          const { runtime, rows } = makeRuntime();
          seedFact(rows, {
            text: "My favorite tea is green tea.",
            entityId: USER_ID,
          });
          const before = structuredClone(rows);

          // A delete may fall back to the user's own words, so the message
          // here carries none: the handler's own rejection is what is pinned.
          const result = await runPromotedMutation(
            operation,
            runtime,
            {
              confirm: true,
              ...(operation === "update"
                ? { text: "My favorite tea is oolong." }
                : {}),
              ...parameters,
            },
            makeMessage({ text: "forget that" }),
          );

          expect(result.success).toBe(false);
          expect(result.data).toMatchObject({ error: "MEMORY_MISSING_ID" });
          expect(result.text).toContain("valid memoryId or nonempty query");
          expect(result.effectReceipts).toBeUndefined();
          expect(rows).toEqual(before);
        },
      );
    });
  }
});

describe("MEMORY op:delete by query ignores copied imperatives", () => {
  it("deletes the fact when the planner's query repeats the user's 'remember that …' sentence", async () => {
    // Live 2026-09-10 10:45: "forget my favorite tea" reached MEMORY_DELETE as
    // query "remember that my favorite tea is yerba"; "remember" never appears
    // in the stored fact, and delete requires every non-stop term to match.
    const { runtime, rows } = makeRuntime();
    const factId = seedFact(rows, {
      text: "User's favorite tea is yerba.",
      entityId: USER_ID,
      metadata: {
        messageId: "msg-yerba",
        subject: "user",
        subjectResolved: true,
      },
    });
    const message = makeMessage();
    message.content.text = "forget my favorite tea";

    const result = await runAction(runtime, message, {
      action: "delete",
      query: "remember that my favorite tea is yerba",
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(rows.some((row) => row.memory.id === factId)).toBe(false);
  });
});

describe("MEMORY results own a verified user-facing line", () => {
  it("speaks to the user on create and forget so the planner loop can skip its evaluator round", async () => {
    const { runtime, rows } = makeRuntime();
    const message = makeMessage();
    message.content.text = "remember that my favorite tea is yerba";
    const created = await runAction(runtime, message, {
      action: "create",
      text: "User's favorite tea is yerba.",
    });
    expect(created.success).toBe(true);
    expect(created).toMatchObject({
      userFacingText: "Saved: your favorite tea is yerba.",
      verifiedUserFacing: true,
      turnComplete: true,
    });
    expect(rows.length).toBeGreaterThan(0);

    message.content.text = "forget my favorite tea";
    const forgotten = await runAction(runtime, message, {
      action: "delete",
      query: "favorite tea",
      confirm: true,
    });
    expect(forgotten.success).toBe(true);
    expect(forgotten).toMatchObject({
      userFacingText: "Forgot: your favorite tea is yerba.",
      verifiedUserFacing: true,
      turnComplete: true,
    });
  });

  it("renders memory lines in second person without inventing content", async () => {
    const { memoryUserFacingLine } = await import("./memories");
    expect(
      memoryUserFacingLine("Saved", "The user prefers green tea without sugar"),
    ).toBe("Saved: the user prefers green tea without sugar.");
    expect(memoryUserFacingLine("Updated", "user's dog is named Rex.")).toBe(
      "Updated: your dog is named Rex.",
    );
    // Live 2026-09-10: the planner stored "My favorite tea is genmaicha.";
    // the possessive flips to second person, a first-person "I" keeps its
    // capital because the verb would not agree after a rewrite.
    expect(memoryUserFacingLine("Saved", "My favorite tea is genmaicha.")).toBe(
      "Saved: your favorite tea is genmaicha.",
    );
    expect(memoryUserFacingLine("Saved", "I like my coffee black")).toBe(
      "Saved: I like my coffee black.",
    );
    expect(memoryUserFacingLine("Forgot", "   ")).toBe("Forgot.");
  });

  it("phrases an ambiguous query as a choice between candidate texts, never ids", async () => {
    const { ambiguousMemoryUserFacingText } = await import("./memories");
    // Live 2026-09-13 tj-f1579f952d5d21: the durable fact and its
    // observation echo both matched "forget my favorite color".
    const question = ambiguousMemoryUserFacingText("forget", [
      { text: "user favorite_color teal" },
      { text: "The user's favorite color is teal." },
      { text: "The user's favorite color is teal." },
    ]);
    expect(question).toBe(
      'That matches 2 saved memories: "user favorite_color teal"; "your favorite color is teal.". Which one should I forget?',
    );
    expect(question).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(
      ambiguousMemoryUserFacingText("update", [{ text: "a".repeat(400) }]),
    ).toMatch(
      /^That matches one saved memory: "a{159}…"\. Which one should I update\?$/,
    );
  });
});

describe("MEMORY inferSubaction (umbrella call without action)", () => {
  // Live 2026-09-14 tj-22eb87cbbbfac0: "remember that my favorite tea is
  // yerba" → `MEMORY {text, kind, tags}` with no `action`, routed through the
  // sub-planner (a second planner model call) before MEMORY_CREATE ran.
  const MEMORY_ID = "00000000-0000-0000-0000-0000000000f1";
  const infer = (params: Record<string, unknown>) =>
    memoryAction.inferSubaction?.(params);
  const promotedNames = promoteSubactionsToActions(memoryAction)
    .slice(1)
    .map((action) => action.name);

  it("names only promoted children of MEMORY", () => {
    expect(promotedNames).toEqual([
      "MEMORY_CREATE",
      "MEMORY_SEARCH",
      "MEMORY_UPDATE",
      "MEMORY_DELETE",
    ]);
    for (const params of [
      { text: "t" },
      { query: "q" },
      { query: "q", text: "t" },
      { query: "q", confirm: true },
    ]) {
      expect(promotedNames).toContain(infer(params));
    }
  });

  it("infers create from text without a target", () => {
    expect(
      infer({
        text: "The user's favorite tea is yerba.",
        kind: "preference",
        tags: ["tea", "preference"],
      }),
    ).toBe("MEMORY_CREATE");
    expect(infer({ text: "t" })).toBe("MEMORY_CREATE");
    // The schema's omission sentinels are not a target.
    expect(infer({ text: "t", memoryId: "null" })).toBe("MEMORY_CREATE");
  });

  it("infers search from a bare query", () => {
    expect(infer({ query: "favorite tea" })).toBe("MEMORY_SEARCH");
    expect(infer({ query: "favorite tea", type: "facts", limit: 5 })).toBe(
      "MEMORY_SEARCH",
    );
  });

  it("infers update from a target with replacement text", () => {
    expect(
      infer({
        query: "favorite tea",
        text: "The user's favorite tea is matcha.",
      }),
    ).toBe("MEMORY_UPDATE");
    expect(
      infer({
        memoryId: MEMORY_ID,
        text: "The user's favorite tea is matcha.",
        confirm: true,
      }),
    ).toBe("MEMORY_UPDATE");
  });

  it("infers delete only from a target with confirm:true and no text", () => {
    expect(infer({ query: "favorite tea", confirm: true })).toBe(
      "MEMORY_DELETE",
    );
    expect(infer({ memoryId: MEMORY_ID, confirm: true })).toBe("MEMORY_DELETE");
  });

  it("never names delete without confirm:true, however the op is spelled", () => {
    const withoutConfirm = [
      { memoryId: MEMORY_ID },
      { query: "favorite tea", memoryId: MEMORY_ID },
      { memoryId: MEMORY_ID, confirm: false },
      { memoryId: MEMORY_ID, confirm: "true" },
      { op: "delete", query: "favorite tea" },
      { subaction: "delete", memoryId: MEMORY_ID },
      { action: "delete", query: "favorite tea" },
    ];
    for (const params of withoutConfirm) {
      expect(infer(params)).toBeUndefined();
    }
  });

  it("honors a declared legacy discriminator", () => {
    expect(infer({ op: "search", query: "q", confirm: true })).toBe(
      "MEMORY_SEARCH",
    );
    expect(infer({ subaction: "create", text: "t", query: "q" })).toBe(
      "MEMORY_CREATE",
    );
    expect(infer({ op: "delete", memoryId: MEMORY_ID, confirm: true })).toBe(
      "MEMORY_DELETE",
    );
    // An unknown spelling carries no declaration; the structure decides.
    expect(infer({ op: "bogus", text: "t" })).toBe("MEMORY_CREATE");
  });

  it("returns undefined when the arguments are ambiguous", () => {
    for (const params of [
      {},
      { kind: "preference" },
      { confirm: true },
      { type: "facts" },
      { text: "   " },
      { query: "   " },
      { memoryId: "null", confirm: true },
    ]) {
      expect(infer(params)).toBeUndefined();
    }
  });
});
