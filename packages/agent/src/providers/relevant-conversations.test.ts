/**
 * Coverage for relevantConversationsProvider's recall paths: the shared per-turn
 * embed (embedRecallQuery) failing open to `null` (no vector search issued,
 * empty result), resolving to a vector (drives searchMemories), lexical
 * hash-memory recall surfacing even when the embed fails open, short messages
 * short-circuiting before any embed, the hash scan overlapping the semantic
 * branch instead of serializing, and result-room tags resolving through one
 * batched getRoomsByIds read (degrading to untagged on failure). Deterministic:
 * @elizaos/core is partially mocked to drive embedRecallQuery, and the
 * runtime's searchMemories / getMemories / getRoomsByIds are in-memory vi
 * fakes.
 */
import type { IAgentRuntime, Memory, Room, State } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider closes over `embedRecallQuery` from @elizaos/core at import time.
// Partially mock the module so we can drive the shared recall embed to a
// resolved vector or a fail-open `null`, while keeping every other real export
// (relied on by @elizaos/shared and the provider's helper modules) intact.
const embedRecallQuery =
  vi.fn<(runtime: IAgentRuntime, text: string) => Promise<number[] | null>>();
const buildAccessContext = vi.fn();
const revalidateOwnerExclusiveDisclosure = vi.fn(
  async (
    _runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<Record<string, unknown>> => ({
    allowed: true,
    basis: "owner_private_destination",
  }),
);
const markOwnerExclusiveDisclosureUsed = vi.fn();
const recordOwnerExclusiveSuppression = vi.fn();
const searchCanonicalConversationMemories = vi.fn(
  async (input: {
    runtime: IAgentRuntime;
    embedding: number[];
    deliveryMessage: Memory;
  }): Promise<{
    items: Array<{
      memory: Memory;
      provenance: Record<string, never>;
      dedupeKey: string;
    }>;
    withheld: Array<{ source?: string; code: string; reason: string }>;
    availability: "complete" | "partial" | "unavailable";
  }> => {
    const disclosure = await revalidateOwnerExclusiveDisclosure(
      input.runtime,
      input.deliveryMessage,
    );
    if (!disclosure.allowed) {
      return { items: [], withheld: [], availability: "partial" };
    }
    return {
      items: (
        await input.runtime.searchMemories({
          embedding: input.embedding,
          tableName: "messages",
        })
      ).map((memory) => ({
        memory,
        provenance: {},
        dedupeKey: memory.id ?? "memory",
      })),
      withheld: [],
      availability: "complete",
    };
  },
);
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    buildAccessContext: (...args: unknown[]) => buildAccessContext(...args),
    embedRecallQuery: (runtime: IAgentRuntime, text: string) =>
      embedRecallQuery(runtime, text),
    markOwnerExclusiveDisclosureUsed,
    recordOwnerExclusiveSuppression,
    revalidateOwnerExclusiveDisclosure,
    searchCanonicalConversationMemories,
  };
});

// Imported after the mock so the provider binds the mocked embedder.
const { relevantConversationsProvider } = await import(
  "./relevant-conversations.ts"
);

const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as Room["id"];
const OTHER_ROOM = "00000000-0000-0000-0000-0000000000c2" as Room["id"];

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): {
  runtime: IAgentRuntime;
  searchMemories: ReturnType<typeof vi.fn>;
} {
  const searchMemories = vi.fn(async () => [
    {
      id: "00000000-0000-0000-0000-0000000000m1",
      roomId: OTHER_ROOM,
      entityId: "00000000-0000-0000-0000-0000000000e1",
      content: { text: "earlier relevant message" },
      metadata: { type: "message", scope: "shared" },
      createdAt: 1,
    } as unknown as Memory,
  ]);
  const runtime = createMockRuntime({
    getRoom: vi.fn(async () => ({ id: ROOM_ID }) as unknown as Room),
    // Lexical hash-memory scan runs concurrently with the semantic embed;
    // default to no hash memories so these tests isolate the embed path.
    getMemories: vi.fn(async () => []),
    // Recall-result room tags resolve through one batched read; default to no
    // rooms (tags degrade to "[unknown]").
    getRoomsByIds: vi.fn(async () => []),
    searchMemories,
    reportError: vi.fn(),
    ...overrides,
  });
  return { runtime, searchMemories };
}

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    entityId: "00000000-0000-0000-0000-0000000000e0",
    agentId: "00000000-0000-0000-0000-0000000000ag",
    roomId: ROOM_ID,
    content: { text },
    createdAt: 2,
  } as unknown as Memory;
}

const EMPTY_STATE = { values: {}, data: {}, text: "" } as unknown as State;

describe("relevantConversationsProvider — shared recall embed fail-open", () => {
  it.each(["hello!", "hey there", "Good morning.", "bonjour"])(
    "does not retrieve old conversations for %s",
    async (greeting) => {
      const { runtime } = makeRuntime();
      const result = await relevantConversationsProvider.get(
        runtime,
        makeMessage(greeting),
        EMPTY_STATE,
      );
      expect(result.text).toBe("");
      expect(runtime.getMemories).not.toHaveBeenCalled();
      expect(embedRecallQuery).not.toHaveBeenCalled();
    },
  );
  it.each(["Mira", "hi, what was Mira's earlier packing list?"])(
    "retains substantive recall for %s",
    async (query) => {
      embedRecallQuery.mockResolvedValue(null);
      const { runtime } = makeRuntime();
      await relevantConversationsProvider.get(
        runtime,
        makeMessage(query),
        EMPTY_STATE,
      );
      expect(embedRecallQuery).toHaveBeenCalledWith(runtime, query);
    },
  );
  it("skips a greeting even when the host appended language instructions", async () => {
    const { runtime, searchMemories } = makeRuntime();
    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage(
        "hi\n\n[Language instruction: Reply in natural English unless the user explicitly requests another language.]",
      ),
      EMPTY_STATE,
    );
    expect(result.text).toBe("");
    expect(embedRecallQuery).not.toHaveBeenCalled();
    expect(searchMemories).not.toHaveBeenCalled();
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("searches the complete authored recall query without host instructions", async () => {
    embedRecallQuery.mockResolvedValue(null);
    const { runtime } = makeRuntime();
    const query = "What color was Rowan's mug before blue?";
    await relevantConversationsProvider.get(
      runtime,
      makeMessage(
        `${query}\n\n[Language instruction: Reply in natural English unless the user explicitly requests another language.]`,
      ),
      EMPTY_STATE,
    );
    expect(embedRecallQuery).toHaveBeenCalledWith(runtime, query);
  });
  beforeEach(() => {
    // A resolved role is required: `filterByAccessContext` folds an absent
    // `role` into the `UNRESOLVED` actor, which every scope denies, so a
    // roleless context would read as "recall is broken" rather than "a
    // non-owner reader". These cases model an ordinary authenticated USER.
    buildAccessContext.mockResolvedValue({
      requesterEntityId: "00000000-0000-0000-0000-0000000000e0",
      isOwner: false,
      role: "USER",
    });
  });

  afterEach(() => {
    embedRecallQuery.mockReset();
    buildAccessContext.mockReset();
    revalidateOwnerExclusiveDisclosure.mockClear();
    revalidateOwnerExclusiveDisclosure.mockResolvedValue({
      allowed: true,
      basis: "owner_private_destination",
    });
    markOwnerExclusiveDisclosureUsed.mockClear();
    recordOwnerExclusiveSuppression.mockClear();
    searchCanonicalConversationMemories.mockClear();
  });

  it("returns the empty result and never searches when the shared embed fails open (null)", async () => {
    embedRecallQuery.mockResolvedValue(null);
    const { runtime, searchMemories } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(embedRecallQuery).toHaveBeenCalledWith(
      runtime,
      "what did we decide about the launch date",
    );
    // Fail-open: no vector search issued.
    expect(searchMemories).not.toHaveBeenCalled();
  });

  it("uses the shared embed vector to search when it resolves", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const { runtime, searchMemories } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(embedRecallQuery).toHaveBeenCalledTimes(1);
    expect(searchCanonicalConversationMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: [0.1, 0.2, 0.3],
        deliveryMessage: expect.objectContaining({
          roomId: ROOM_ID,
          content: expect.objectContaining({
            text: "what did we decide about the launch date",
          }),
        }),
      }),
    );
    expect(
      searchCanonicalConversationMemories.mock.calls[0]?.[0],
    ).not.toHaveProperty("count");
    expect(searchMemories).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: [0.1, 0.2, 0.3] }),
    );
    expect(result.text).toContain("Relevant past conversations:");
  });

  it("withholds relevant conversation context when the destination is not owner-private", async () => {
    revalidateOwnerExclusiveDisclosure.mockResolvedValue({
      allowed: false,
      reason: "destination_not_private",
    });
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const { runtime, searchMemories } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(embedRecallQuery).not.toHaveBeenCalled();
    expect(searchCanonicalConversationMemories).not.toHaveBeenCalled();
    expect(searchMemories).not.toHaveBeenCalled();
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
    expect(recordOwnerExclusiveSuppression).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_ID }),
      "destination_not_private",
    );
  });

  it("renders an unavailable canonical result instead of presenting withheld matches as no history", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    searchCanonicalConversationMemories.mockResolvedValueOnce({
      items: [],
      withheld: [
        {
          source: "client_chat",
          code: "invalid_provenance",
          reason: "stored memory is missing a connector account id",
        },
      ],
      availability: "unavailable",
    });
    const { runtime } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("unavailable");
    expect(result.text).toContain("withheld by access policy");
    expect(result.values?.relevantConversationAvailability).toBe("unavailable");
    expect(result.data?.availability).toBe("unavailable");
    expect(result.data?.withheld).toEqual([
      expect.objectContaining({ code: "invalid_provenance" }),
    ]);
  });

  it("labels mixed canonical recall as partial and preserves withheld reasons", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const recalled = {
      id: "00000000-0000-0000-0000-0000000000m4",
      roomId: OTHER_ROOM,
      entityId: "00000000-0000-0000-0000-0000000000e1",
      content: { text: "disclosable launch note" },
      metadata: { type: "message", scope: "shared" },
      createdAt: 1,
    } as unknown as Memory;
    searchCanonicalConversationMemories.mockResolvedValueOnce({
      items: [{ memory: recalled, provenance: {}, dedupeKey: "memory-4" }],
      withheld: [
        {
          source: "telegram",
          code: "scope_denied",
          reason: "requester is not authorized to read the memory scope",
        },
      ],
      availability: "partial",
    });
    const { runtime } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("Relevant past conversations (partial;");
    expect(result.text).toContain("disclosable launch note");
    expect(result.values?.relevantConversationAvailability).toBe("partial");
    expect(result.data?.withheld).toEqual([
      expect.objectContaining({ code: "scope_denied" }),
    ]);
  });

  it("fails both recall branches together when access-context resolution fails", async () => {
    buildAccessContext.mockRejectedValueOnce(
      new Error("role store unavailable"),
    );
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const reportError = vi.fn();
    const getMemories = vi.fn(async () => []);
    const { runtime } = makeRuntime({ reportError, getMemories });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(getMemories).not.toHaveBeenCalled();
    expect(embedRecallQuery).not.toHaveBeenCalled();
    expect(searchCanonicalConversationMemories).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "RelevantConversationsProvider",
      expect.any(Error),
      expect.objectContaining({ roomId: ROOM_ID }),
    );
  });

  it("surfaces lexical hash memories even when the embed fails open (null)", async () => {
    embedRecallQuery.mockResolvedValue(null);
    const getMemories = vi.fn(async () => [
      {
        id: "00000000-0000-0000-0000-0000000000h1",
        roomId: "00000000-0000-0000-0000-0000000000hr",
        entityId: "00000000-0000-0000-0000-0000000000e9",
        content: {
          text: "the launch date is set for next Friday",
          source: "hash_memory",
        },
        metadata: { type: "message", scope: "shared" },
        createdAt: 5,
      } as unknown as Memory,
      {
        id: "00000000-0000-0000-0000-0000000000h2",
        roomId: "00000000-0000-0000-0000-0000000000hr",
        entityId: "00000000-0000-0000-0000-0000000000e9",
        content: { text: "unrelated note", source: "hash_memory" },
        metadata: { type: "message", scope: "shared" },
        createdAt: 6,
      } as unknown as Memory,
    ]);
    const { runtime, searchMemories } = makeRuntime({ getMemories });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what is the launch date for the release"),
      EMPTY_STATE,
    );

    // No embed vector → no semantic search, but the lexical hit still surfaces.
    expect(searchMemories).not.toHaveBeenCalled();
    expect(result.text).toContain("Relevant past conversations:");
    expect(result.text).toContain("the launch date is set for next Friday");
    expect(result.text).not.toContain("unrelated note");
    expect(result.values?.relevantConversationCount).toBe(1);
    expect(markOwnerExclusiveDisclosureUsed).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_ID }),
    );
  });

  it("withholds lexical hash memory without an owner-private destination", async () => {
    embedRecallQuery.mockResolvedValue(null);
    revalidateOwnerExclusiveDisclosure.mockResolvedValue({
      allowed: false,
      reason: "destination_not_private",
    });
    const getMemories = vi.fn(async () => [
      {
        id: "00000000-0000-0000-0000-0000000000h1",
        roomId: "00000000-0000-0000-0000-0000000000hr",
        entityId: "00000000-0000-0000-0000-0000000000e9",
        content: {
          text: "the launch date is set for next Friday",
          source: "hash_memory",
        },
        createdAt: 5,
      } as unknown as Memory,
    ]);
    const { runtime } = makeRuntime({ getMemories });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what is the launch date for the release"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(getMemories).not.toHaveBeenCalled();
    expect(embedRecallQuery).not.toHaveBeenCalled();
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
  });

  it("short messages short-circuit before embedding", async () => {
    embedRecallQuery.mockResolvedValue([0.1]);
    const { runtime } = makeRuntime();

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("hi"),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(embedRecallQuery).not.toHaveBeenCalled();
  });

  it("omits owner-private pendant memories from a non-owner recall", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2]);
    const searchMemories = vi.fn(async () => [
      {
        id: "00000000-0000-0000-0000-0000000000p1",
        roomId: OTHER_ROOM,
        entityId: "00000000-0000-0000-0000-0000000000e0",
        content: { text: "owner pendant canary" },
        metadata: {
          type: "message",
          scope: "owner-private",
          scopedToEntityId: "00000000-0000-0000-0000-0000000000e0",
        },
        createdAt: 4,
      } as unknown as Memory,
      {
        id: "00000000-0000-0000-0000-0000000000g1",
        roomId: OTHER_ROOM,
        entityId: "00000000-0000-0000-0000-0000000000e2",
        content: { text: "shared launch note" },
        metadata: { type: "message", scope: "shared" },
        createdAt: 3,
      } as unknown as Memory,
    ]);
    const { runtime } = makeRuntime({ searchMemories });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what was the private launch note"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("shared launch note");
    expect(result.text).not.toContain("owner pendant canary");
  });

  it("resolves recall-result room tags with one batched getRoomsByIds read", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const THIRD_ROOM = "00000000-0000-0000-0000-0000000000c3" as Room["id"];
    const searchMemories = vi.fn(async () => [
      {
        id: "00000000-0000-0000-0000-0000000000m1",
        roomId: OTHER_ROOM,
        entityId: "00000000-0000-0000-0000-0000000000e1",
        content: { text: "first relevant message" },
        metadata: { type: "message", scope: "shared" },
        createdAt: 3,
      } as unknown as Memory,
      {
        id: "00000000-0000-0000-0000-0000000000m2",
        roomId: THIRD_ROOM,
        entityId: "00000000-0000-0000-0000-0000000000e2",
        content: { text: "second relevant message" },
        metadata: { type: "message", scope: "shared" },
        createdAt: 2,
      } as unknown as Memory,
      {
        id: "00000000-0000-0000-0000-0000000000m3",
        roomId: OTHER_ROOM,
        entityId: "00000000-0000-0000-0000-0000000000e1",
        content: { text: "third relevant message" },
        metadata: { type: "message", scope: "shared" },
        createdAt: 1,
      } as unknown as Memory,
    ]);
    const getRoomsByIds = vi.fn(async () => [
      { id: OTHER_ROOM, source: "discord", name: "general" } as unknown as Room,
      { id: THIRD_ROOM, source: "slack", name: "ops" } as unknown as Room,
    ]);
    const { runtime } = makeRuntime({ searchMemories, getRoomsByIds });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    // One batched read over the distinct result rooms — never one call per row.
    expect(getRoomsByIds).toHaveBeenCalledTimes(1);
    expect(getRoomsByIds).toHaveBeenCalledWith([OTHER_ROOM, THIRD_ROOM]);
    expect(result.text).toContain("[discord] general");
    expect(result.text).toContain("[slack] ops");
  });

  it("degrades room tags to [unknown] when the batched room read fails, keeping the recall text", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const getRoomsByIds = vi.fn(async () => {
      throw new Error("room store unavailable");
    });
    const reportError = vi.fn();
    const { runtime } = makeRuntime({ getRoomsByIds, reportError });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    // Cosmetic tag degrade, not a recall failure: text survives untagged while
    // the failed room lookup remains observable through diagnostics.
    expect(result.text).toContain("Relevant past conversations:");
    expect(result.text).toContain("[unknown]");
    expect(result.text).toContain("earlier relevant message");
    expect(reportError).toHaveBeenCalledWith(
      "RelevantConversationsProvider.roomTags",
      expect.any(Error),
      { roomIds: [OTHER_ROOM] },
    );
  });

  it("overlaps the lexical hash scan with the semantic embed+search instead of serializing them", async () => {
    embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    let releaseHashScan: ((memories: Memory[]) => void) | undefined;
    const hashScan = new Promise<Memory[]>((resolve) => {
      releaseHashScan = resolve;
    });
    const getMemories = vi.fn(() => hashScan);
    const { runtime, searchMemories } = makeRuntime({ getMemories });

    const pending = relevantConversationsProvider.get(
      runtime,
      makeMessage("what did we decide about the launch date"),
      EMPTY_STATE,
    );

    // The semantic branch must reach searchMemories while the hash scan is
    // still in flight — a serial pipeline would block on getMemories first.
    await vi.waitFor(() => expect(searchMemories).toHaveBeenCalledTimes(1));
    expect(getMemories).toHaveBeenCalledTimes(1);
    releaseHashScan?.([]);

    const result = await pending;
    expect(result.text).toContain("Relevant past conversations:");
    expect(result.text).toContain("earlier relevant message");
  });

  it("allows the authenticated owner to recall owner-private pendant memory", async () => {
    buildAccessContext.mockResolvedValue({
      requesterEntityId: "00000000-0000-0000-0000-0000000000e0",
      isOwner: true,
      role: "OWNER",
    });
    embedRecallQuery.mockResolvedValue([0.1, 0.2]);
    const searchMemories = vi.fn(async () => [
      {
        id: "00000000-0000-0000-0000-0000000000p1",
        roomId: OTHER_ROOM,
        entityId: "00000000-0000-0000-0000-0000000000e0",
        content: { text: "owner pendant canary" },
        metadata: {
          type: "message",
          scope: "owner-private",
          scopedToEntityId: "00000000-0000-0000-0000-0000000000e0",
        },
        createdAt: 4,
      } as unknown as Memory,
    ]);
    const { runtime } = makeRuntime({ searchMemories });

    const result = await relevantConversationsProvider.get(
      runtime,
      makeMessage("what was the private launch note"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("owner pendant canary");
  });
});
