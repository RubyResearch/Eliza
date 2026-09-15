/**
 * Unit coverage for the memory + knowledge HTTP surface in
 * `api/memory-routes.ts`: route dispatch and connection setup, hash-memory
 * remember/search contracts, quick-context answering, the memory viewer
 * feed/browse/by-entity/stats reads, by-id DELETE/PATCH mutations, and the
 * exported pure helpers (`rankByKeyword`, `matchesKeyword`,
 * `parseMemoryTableFilter`). The real handler, zod schemas, and BM25 ranking
 * run against an in-memory fake runtime store.
 */

import {
  type AgentRuntime,
  ChannelType,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  ModelType,
  RoomHandlerQueue,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import {
  HASH_MEMORY_SOURCE,
  handleMemoryRoutes,
  invalidateMemorySearchCache,
  MEMORY_TABLE_NAMES,
  matchesKeyword,
  parseMemoryTableFilter,
  rankByKeyword,
} from "./memory-routes.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const DEFAULT_ROOM_ID = stringToUuid("Eliza-hash-memory-room") as UUID;

type RowOverrides = {
  source?: string;
  roomId?: UUID;
  entityId?: UUID;
};

function row(
  id: string,
  text: string,
  createdAt: number,
  overrides: RowOverrides = {},
): Memory {
  return {
    id: id as UUID,
    entityId: overrides.entityId ?? AGENT_ID,
    agentId: AGENT_ID,
    roomId: overrides.roomId ?? DEFAULT_ROOM_ID,
    createdAt,
    content: { text, source: overrides.source ?? HASH_MEMORY_SOURCE },
  } as Memory;
}

type RuntimeOptions = {
  tables?: Record<string, Memory[]>;
  characterName?: string | null;
  modelText?: unknown;
  embedding?: number[];
  embeddingError?: Error;
};

function makeRuntime(options: RuntimeOptions = {}) {
  const tables: Record<string, Memory[]> = options.tables ?? {};
  const getMemories = vi.fn(
    async (params: { roomId?: UUID; tableName?: string; limit?: number }) => {
      let rows = [...(tables[params.tableName ?? "messages"] ?? [])];
      if (params.roomId) {
        rows = rows.filter((candidate) => candidate.roomId === params.roomId);
      }
      rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return typeof params.limit === "number"
        ? rows.slice(0, params.limit)
        : rows;
    },
  );
  const countMemories = vi.fn(
    async (params: { roomId?: UUID; tableName?: string }) => {
      let rows = tables[params.tableName ?? ""] ?? [];
      if (params.roomId) {
        rows = rows.filter((candidate) => candidate.roomId === params.roomId);
      }
      return rows.length;
    },
  );
  const ensureConnection = vi.fn(async () => undefined);
  const getMemoryById = vi.fn(async (id: UUID) => {
    for (const rows of Object.values(tables)) {
      const found = rows.find((candidate) => candidate.id === id);
      if (found) return found;
    }
    return null;
  });
  const createMemory = vi.fn(async (memory: Memory, tableName: string) => {
    const bucket = tables[tableName] ?? [];
    bucket.push(memory);
    tables[tableName] = bucket;
    return memory.id;
  });
  const deleteMemory = vi.fn(async (id: UUID) => {
    for (const rows of Object.values(tables)) {
      const index = rows.findIndex((candidate) => candidate.id === id);
      if (index >= 0) rows.splice(index, 1);
    }
  });
  const updateMemory = vi.fn(async (patch: Partial<Memory> & { id: UUID }) => {
    for (const rows of Object.values(tables)) {
      const target = rows.find((candidate) => candidate.id === patch.id);
      if (target) {
        if (patch.content) target.content = patch.content as Memory["content"];
        if (patch.embedding) target.embedding = patch.embedding;
        return true;
      }
    }
    return false;
  });
  const useModel = vi.fn(
    async (
      modelType: unknown,
      _payload: { prompt?: string; text?: string },
    ) => {
      if (modelType === ModelType.TEXT_EMBEDDING) {
        if (options.embeddingError) throw options.embeddingError;
        return options.embedding ?? [0.1, 0.2, 0.3];
      }
      return options.modelText ?? "ok";
    },
  );
  const character =
    options.characterName === null
      ? {}
      : { name: options.characterName ?? "Eliza" };
  const runtime = {
    agentId: AGENT_ID,
    character,
    roomHandlerQueue: new RoomHandlerQueue(),
    ensureConnection,
    getMemories,
    countMemories,
    getMemoryById,
    createMemory,
    deleteMemory,
    updateMemory,
    useModel,
    getService: vi.fn(() => undefined),
    getServiceLoadPromise: vi.fn(async () => {
      throw new Error("documents service not registered");
    }),
    reportError: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
  return {
    runtime,
    getMemories,
    countMemories,
    ensureConnection,
    getMemoryById,
    createMemory,
    deleteMemory,
    updateMemory,
    useModel,
  };
}

type RouteCall = {
  handled: boolean;
  json: unknown[];
  errors: Array<{ message: string; status?: number }>;
};

async function callRoute(args: {
  runtime: AgentRuntime | null;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  agentName?: string;
}): Promise<RouteCall> {
  const call: RouteCall = { handled: false, json: [], errors: [] };
  const ctx: MemoryRouteContext = {
    req: {} as never,
    res: {} as never,
    method: args.method,
    pathname: args.path.split("?")[0] ?? args.path,
    url: new URL(`https://agent.test${args.path}`),
    runtime: args.runtime,
    agentName: args.agentName ?? "Eliza",
    json: (_res, value) => {
      call.json.push(value);
    },
    error: (_res, message, status) => {
      call.errors.push({ message, status });
    },
    readJsonBody: async <T extends object>() =>
      (args.body === undefined ? null : args.body) as T | null,
  };
  call.handled = await handleMemoryRoutes(ctx);
  return call;
}

async function searchRoute(
  runtime: AgentRuntime,
  queryAndLimit: string,
): Promise<{
  value: {
    query: string;
    results: Array<{ id: string; text: string; score: number }>;
    count: number;
    limit: number;
  };
}> {
  const call = await callRoute({
    runtime,
    method: "GET",
    path: `/api/memory/search?${queryAndLimit}`,
  });
  expect(call.handled).toBe(true);
  expect(call.errors).toEqual([]);
  return { value: call.json[0] as never };
}

beforeEach(() => {
  invalidateMemorySearchCache();
});

describe("memory route constants", () => {
  test("hash-memory source marker matches the stored-row contract", () => {
    expect(HASH_MEMORY_SOURCE).toBe("hash_memory");
  });

  test("table filter vocabulary is the four viewer tables", () => {
    expect(MEMORY_TABLE_NAMES).toEqual([
      "messages",
      "memories",
      "facts",
      "documents",
    ]);
  });
});

describe("rankByKeyword", () => {
  test("returns an empty list for an empty candidate set", () => {
    expect(rankByKeyword("anything", [], () => "")).toEqual([]);
  });

  test("returns every item with score zero in input order when nothing matches", () => {
    const items = ["alpha plan", "beta plan"];
    const results = rankByKeyword("zeppelin", items, (item) => item);
    expect(results.map(({ item }) => item)).toEqual(items);
    expect(results.map(({ score }) => score)).toEqual([0, 0]);
  });

  test("max-normalizes relevance so the best match scores exactly 1", () => {
    const items = [
      "quantum quantum flux notes",
      "quantum theory overview",
      "totally unrelated prose",
    ];
    const results = rankByKeyword("quantum", items, (item) => item);
    expect(results[0]?.score).toBe(1);
    expect(results[1]?.score).toBeGreaterThan(0);
    expect(results[1]?.score).toBeLessThan(1);
    expect(results[2]?.score).toBe(0);
  });

  test("keeps input order even when a later item ranks higher", () => {
    const items = ["first mention zeppelin", "zeppelin zeppelin zeppelin"];
    const results = rankByKeyword("zeppelin", items, (item) => item);
    expect(results.map(({ item }) => item)).toEqual(items);
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[1]?.score).toBe(1);
  });
});

describe("matchesKeyword", () => {
  test("matches the whole query case-insensitively", () => {
    expect(matchesKeyword("Hello World Schedule", "world")).toBe(true);
    expect(matchesKeyword("Hello World Schedule", "wORLD SCHEDULE")).toBe(true);
  });

  test("multi-term queries match when any term of two or more chars appears", () => {
    expect(matchesKeyword("fleet week schedule", "week harbor")).toBe(true);
    expect(matchesKeyword("harbor master log", "week marina")).toBe(false);
  });

  test("single-character terms are ignored", () => {
    expect(matchesKeyword("abcdef", "x y")).toBe(false);
  });

  test("empty or blank inputs never match", () => {
    expect(matchesKeyword("", "query")).toBe(false);
    expect(matchesKeyword("text", "")).toBe(false);
    expect(matchesKeyword("text", "   ")).toBe(false);
  });
});

describe("parseMemoryTableFilter", () => {
  test("null and empty mean every table", () => {
    expect(parseMemoryTableFilter(null)).toEqual({ ok: true });
    expect(parseMemoryTableFilter("")).toEqual({ ok: true });
  });

  test("a known table name is normalized to lowercase", () => {
    expect(parseMemoryTableFilter("Messages")).toEqual({
      ok: true,
      tables: ["messages"],
    });
    expect(parseMemoryTableFilter("FaCtS")).toEqual({
      ok: true,
      tables: ["facts"],
    });
  });

  test("an unknown token is rejected with the full table list", () => {
    const result = parseMemoryTableFilter("notes");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("messages, memories, facts, documents");
    }
  });
});

describe("route dispatch", () => {
  test("unrelated paths are not handled and never touch the runtime", async () => {
    const call = await callRoute({
      runtime: null,
      method: "GET",
      path: "/api/unrelated",
    });
    expect(call.handled).toBe(false);
    expect(call.json).toEqual([]);
    expect(call.errors).toEqual([]);
  });

  test("recognized paths answer 503 when no runtime is attached", async () => {
    const memoriesCall = await callRoute({
      runtime: null,
      method: "GET",
      path: "/api/memories",
    });
    expect(memoriesCall.handled).toBe(true);
    expect(memoriesCall.json).toEqual([]);
    expect(memoriesCall.errors).toEqual([
      { message: "Agent runtime is not available", status: 503 },
    ]);

    const quickCall = await callRoute({
      runtime: null,
      method: "GET",
      path: "/api/context/quick?q=x",
    });
    expect(quickCall.handled).toBe(true);
    expect(quickCall.errors).toEqual([
      { message: "Agent runtime is not available", status: 503 },
    ]);
  });

  test("recognized path with an unsupported method connects then falls through", async () => {
    const { runtime, ensureConnection } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memory/remember",
    });
    expect(call.handled).toBe(false);
    expect(call.json).toEqual([]);
    expect(call.errors).toEqual([]);
    expect(ensureConnection).toHaveBeenCalledTimes(1);
  });

  test("the connection room derives from the trimmed character name", async () => {
    const { runtime, ensureConnection } = makeRuntime({
      characterName: "  Spaced  ",
    });
    await callRoute({
      runtime,
      method: "GET",
      path: "/api/memory/search?q=x&q2=y",
    });
    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: stringToUuid("Spaced-hash-memory-room"),
        channelId: "Spaced-hash-memory",
        userName: "User",
        source: MESSAGE_SOURCE_CLIENT_CHAT,
        type: ChannelType.DM,
      }),
    );
  });

  test("a missing character name falls back to agentName then Eliza", async () => {
    const fallback = makeRuntime({ characterName: null });
    await callRoute({
      runtime: fallback.runtime,
      method: "GET",
      path: "/api/memories",
      agentName: "BackupName",
    });
    expect(fallback.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: stringToUuid("BackupName-hash-memory-room"),
      }),
    );

    const elizaDefault = makeRuntime({ characterName: null });
    await callRoute({
      runtime: elizaDefault.runtime,
      method: "GET",
      path: "/api/memories",
      agentName: "",
    });
    expect(elizaDefault.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: DEFAULT_ROOM_ID,
      }),
    );
  });

  test("ensureConnection receives the agent-owned DM ownership metadata", async () => {
    const { runtime, ensureConnection } = makeRuntime();
    await callRoute({ runtime, method: "GET", path: "/api/memories/stats" });
    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: AGENT_ID,
        worldId: stringToUuid("Eliza-hash-memory-world"),
        messageServerId: stringToUuid("Eliza-hash-memory-server"),
        metadata: { ownership: { ownerId: AGENT_ID } },
      }),
    );
  });
});

describe("POST /api/memory/remember", () => {
  test("a null body is handled without writing any response or row", async () => {
    const { runtime, createMemory } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "POST",
      path: "/api/memory/remember",
    });
    expect(call.handled).toBe(true);
    expect(call.json).toEqual([]);
    expect(call.errors).toEqual([]);
    expect(createMemory).not.toHaveBeenCalled();
  });

  test("blank text is rejected with the schema message", async () => {
    const { runtime, createMemory } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "POST",
      path: "/api/memory/remember",
      body: { text: "   " },
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([{ message: "text is required", status: 400 }]);
    expect(createMemory).not.toHaveBeenCalled();
  });

  test("unknown body fields are rejected before any write", async () => {
    const { runtime, createMemory } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "POST",
      path: "/api/memory/remember",
      body: { text: "hello", extra: "field" },
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toHaveLength(1);
    expect(call.errors[0]?.status).toBe(400);
    expect(createMemory).not.toHaveBeenCalled();
  });

  test("valid text stores an agent-private hash-memory DM note once", async () => {
    const before = Date.now() - 5_000;
    const { runtime, createMemory } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "POST",
      path: "/api/memory/remember",
      body: { text: "  remember the quartz deadline  " },
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    expect(createMemory).toHaveBeenCalledTimes(1);
    const created = createMemory.mock.calls[0]?.[0] as Memory;
    expect(created.content).toMatchObject({
      text: "remember the quartz deadline",
      source: HASH_MEMORY_SOURCE,
      channelType: ChannelType.DM,
    });
    expect(created.metadata).toMatchObject({ scope: "agent-private" });
    expect(created.entityId).toBe(AGENT_ID);
    expect(created.roomId).toBe(DEFAULT_ROOM_ID);
    expect(createMemory.mock.calls[0]?.[1]).toBe("messages");
    const response = call.json[0] as Record<string, unknown>;
    expect(response).toMatchObject({
      ok: true,
      id: created.id,
      text: "remember the quartz deadline",
      replayed: false,
    });
    const createdAt = response.createdAt as number;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("a repeated idempotency key replays the original note without rewriting", async () => {
    const existingId = stringToUuid(`hash_memory:${AGENT_ID}:replay-key`);
    const existing = row(existingId, "original replayed note", 42);
    const { runtime, createMemory } = makeRuntime({
      tables: { messages: [existing] },
    });
    const call = await callRoute({
      runtime,
      method: "POST",
      path: "/api/memory/remember",
      body: { text: "second submission", idempotencyKey: "replay-key" },
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    expect(createMemory).not.toHaveBeenCalled();
    expect(call.json[0]).toEqual({
      ok: true,
      id: existingId,
      text: "original replayed note",
      createdAt: 42,
      replayed: true,
    });
  });

  test("a fresh idempotency key creates exactly one deterministic id", async () => {
    const expectedId = stringToUuid(`hash_memory:${AGENT_ID}:fresh-key`);
    const { runtime, createMemory, getMemoryById } = makeRuntime();
    const first = await callRoute({
      runtime,
      method: "POST",
      path: "/api/memory/remember",
      body: { text: "idempotent note", idempotencyKey: "fresh-key" },
    });
    expect(first.errors).toEqual([]);
    expect(getMemoryById).toHaveBeenCalledWith(expectedId);
    expect(createMemory).toHaveBeenCalledTimes(1);
    const created = createMemory.mock.calls[0]?.[0] as Memory;
    expect(created.id).toBe(expectedId);
    expect(first.json[0]).toMatchObject({
      ok: true,
      id: expectedId,
      replayed: false,
    });
  });
});

describe("GET /api/memory/search", () => {
  test("a missing query answers 400", async () => {
    const { runtime } = makeRuntime();
    for (const path of ["/api/memory/search", "/api/memory/search?q=%20%20"]) {
      const call = await callRoute({ runtime, method: "GET", path });
      expect(call.handled).toBe(true);
      expect(call.errors).toEqual([
        { message: "Search query (q) is required", status: 400 },
      ]);
    }
  });

  test("limit falls back on junk and clamps into [1, 50]", async () => {
    const { runtime } = makeRuntime();
    for (const [raw, expected] of [
      ["", 10],
      ["limit=0", 10],
      ["limit=abc", 10],
      ["limit=-4", 10],
      ["limit=9999", 50],
      ["limit=3", 3],
    ] as const) {
      const suffix = raw ? `&${raw}` : "";
      const { value } = await searchRoute(runtime, `q=tide${suffix}`);
      expect(value.limit).toBe(expected);
    }
  });

  test("only non-blank hash-memory rows are ranked", async () => {
    const matching = row(
      "aaaaaaaa-0000-4000-8000-000000000001",
      "seagull flight paths",
      3,
    );
    const foreignSource = row(
      "aaaaaaaa-0000-4000-8000-000000000002",
      "seagull nesting cliffs",
      4,
      { source: MESSAGE_SOURCE_CLIENT_CHAT },
    );
    const blankText = row("aaaaaaaa-0000-4000-8000-000000000003", "   ", 5);
    const { runtime } = makeRuntime({
      tables: { messages: [matching, foreignSource, blankText] },
    });

    const { value } = await searchRoute(runtime, "q=seagull");
    expect(value.count).toBe(1);
    expect(value.results).toEqual([
      expect.objectContaining({
        id: matching.id,
        text: "seagull flight paths",
      }),
    ]);
    expect(value.results[0]?.score).toBeGreaterThan(0);
    expect(value.query).toBe("seagull");
  });

  test("equal-score hits tie-break newest first", async () => {
    const older = row(
      "aaaaaaaa-0000-4000-8000-000000000001",
      "tide chart correction",
      100,
    );
    const newer = row(
      "aaaaaaaa-0000-4000-8000-000000000002",
      "tide chart correction",
      200,
    );
    const { runtime } = makeRuntime({ tables: { messages: [older, newer] } });

    const { value } = await searchRoute(runtime, "q=tide");
    expect(value.results.map((result) => result.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  test("a query with no hits returns empty results and count", async () => {
    const { runtime } = makeRuntime({
      tables: {
        messages: [
          row("aaaaaaaa-0000-4000-8000-000000000001", "unrelated note", 1),
        ],
      },
    });
    const { value } = await searchRoute(runtime, "q=nothing-matches-this-word");
    expect(value.results).toEqual([]);
    expect(value.count).toBe(0);
  });
});

describe("GET /api/context/quick", () => {
  test("a missing query answers 400", async () => {
    const { runtime } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/context/quick",
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([
      { message: "Search query (q) is required", status: 400 },
    ]);
  });

  test("answers from memory hits through a TEXT_SMALL prompt with numbered sections", async () => {
    const { runtime, useModel } = makeRuntime({
      tables: {
        messages: [
          row(
            "aaaaaaaa-0000-4000-8000-000000000001",
            "quartz deadline moved to friday",
            1,
          ),
        ],
      },
      modelText: "  Quartz moves Friday.  ",
    });

    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/context/quick?q=quartz",
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);

    expect(useModel).toHaveBeenCalledTimes(1);
    const [modelType, payload] = useModel.mock.calls[0] as [
      unknown,
      { prompt: string },
    ];
    expect(modelType).toBe(ModelType.TEXT_SMALL);
    expect(payload.prompt).toContain("quartz");
    expect(payload.prompt).toContain("[M1] quartz deadline moved to friday");
    expect(payload.prompt).toContain("- none");

    expect(call.json[0]).toMatchObject({
      query: "quartz",
      answer: "Quartz moves Friday.",
      documents: [],
    });
    const memories = (call.json[0] as { memories: Array<{ id: string }> })
      .memories;
    expect(memories.map((hit) => hit.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
    ]);
  });

  test("document hits above the similarity threshold are mapped with filename-first titles", async () => {
    const documentsService = {
      searchDocuments: vi.fn(async () => [
        {
          id: "dddddddd-0000-4000-8000-000000000001" as UUID,
          content: { text: "alpha document body" },
          similarity: 0.9,
          metadata: { filename: "a.pdf", position: 2 },
        },
        {
          id: "dddddddd-0000-4000-8000-000000000002" as UUID,
          content: { text: "boundary document body" },
          similarity: 0.2,
          metadata: { title: "Boundary Title" },
        },
        {
          id: "dddddddd-0000-4000-8000-000000000003" as UUID,
          content: { text: "below threshold body" },
          similarity: 0.15,
          metadata: {},
        },
      ]),
    };
    const runtime = {
      ...makeRuntime({ modelText: "answered" }).runtime,
      getService: vi.fn(() => documentsService),
    } as unknown as AgentRuntime;

    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/context/quick?q=document",
    });
    expect(call.handled).toBe(true);

    const payload = call.json[0] as {
      documents: Array<{
        id: UUID;
        text: string;
        similarity: number;
        documentTitle?: string;
        position?: number;
      }>;
    };
    expect(payload.documents).toHaveLength(2);
    expect(payload.documents[0]).toMatchObject({
      id: "dddddddd-0000-4000-8000-000000000001",
      text: "alpha document body",
      similarity: 0.9,
      documentTitle: "a.pdf",
      position: 2,
    });
    expect(payload.documents[1]).toMatchObject({
      id: "dddddddd-0000-4000-8000-000000000002",
      similarity: 0.2,
      documentTitle: "Boundary Title",
    });
    expect(payload.documents[1]?.position).toBeUndefined();
  });

  test("non-string model output is coerced and blank output falls back", async () => {
    const coerced = makeRuntime({ modelText: 42 });
    const coercedCall = await callRoute({
      runtime: coerced.runtime,
      method: "GET",
      path: "/api/context/quick?q=anything",
    });
    expect(coercedCall.json[0]).toMatchObject({ answer: "42" });

    const blank = makeRuntime({ modelText: "   \n\t" });
    const blankCall = await callRoute({
      runtime: blank.runtime,
      method: "GET",
      path: "/api/context/quick?q=anything",
    });
    expect(blankCall.json[0]).toMatchObject({
      answer: "I couldn't generate a quick answer right now.",
    });
  });
});

describe("GET /api/memories/feed", () => {
  function feedTables() {
    return {
      messages: [
        row("aaaaaaaa-0000-4000-8000-000000000001", "message alpha", 30),
      ],
      facts: [row("bbbbbbbb-0000-4000-8000-000000000002", "fact beta", 20)],
      documents: [
        row("dddddddd-0000-4000-8000-000000000003", "document gamma", 10),
      ],
    };
  }

  test("cursor validation rejects junk before any table scan", async () => {
    const { runtime, getMemories } = makeRuntime({ tables: feedTables() });
    for (const query of [
      "before=12.5",
      "before=%201700",
      "before=1e3",
      "beforeId=aaaaaaaa-0000-4000-8000-000000000009",
      "before=1700&beforeId=not-a-uuid",
      "type=notes",
    ]) {
      const call = await callRoute({
        runtime,
        method: "GET",
        path: `/api/memories/feed?${query}`,
      });
      expect(call.handled).toBe(true);
      expect(call.errors).toHaveLength(1);
      expect(call.errors[0]?.status).toBe(400);
    }
    expect(getMemories).not.toHaveBeenCalled();
  });

  test("pages newest-first across tables and reports hasMore", async () => {
    const { runtime } = makeRuntime({ tables: feedTables() });
    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memories/feed?limit=2",
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    expect(call.json[0]).toMatchObject({ count: 2, limit: 2, hasMore: true });
    const page = (call.json[0] as { memories: Array<Record<string, unknown>> })
      .memories;
    expect(page.map((item) => item.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "bbbbbbbb-0000-4000-8000-000000000002",
    ]);
    expect(page[0]).toEqual({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      type: "messages",
      text: "message alpha",
      entityId: AGENT_ID,
      roomId: DEFAULT_ROOM_ID,
      agentId: AGENT_ID,
      createdAt: 30,
      metadata: null,
      source: HASH_MEMORY_SOURCE,
    });
  });

  test("a full page under the limit has no more rows", async () => {
    const { runtime } = makeRuntime({ tables: feedTables() });
    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memories/feed",
    });
    expect(call.json[0]).toMatchObject({ count: 3, hasMore: false });
  });
});

describe("GET /api/memories/browse", () => {
  function browseTables(): Record<string, Memory[]> {
    return {
      messages: [
        row("aaaaaaaa-0000-4000-8000-000000000001", "harbor pilot license", 30),
        row("aaaaaaaa-0000-4000-8000-000000000002", "seal colony census", 20),
        row("aaaaaaaa-0000-4000-8000-000000000003", "unrelated minutes", 10),
      ],
    };
  }

  test("keyword filters apply OR semantics across terms", async () => {
    const { runtime } = makeRuntime({ tables: browseTables() });
    const call = await callRoute({
      runtime,
      method: "GET",
      path: `/api/memories/browse?q=${encodeURIComponent("harbor colony")}`,
    });
    expect(call.handled).toBe(true);
    const payload = call.json[0] as {
      total: number;
      totalIsExact: boolean;
      hasMore: boolean;
      memories: Array<{ text: string }>;
    };
    expect(payload.total).toBe(2);
    expect(payload.memories.map((item) => item.text).sort()).toEqual([
      "harbor pilot license",
      "seal colony census",
    ]);
    expect(payload.totalIsExact).toBe(false);
    expect(payload.hasMore).toBe(false);
  });

  test("entityId narrows scanned rows", async () => {
    const entityA = "22222222-2222-4222-8222-222222222222" as UUID;
    const entityB = "33333333-3333-4333-8333-333333333333" as UUID;
    const { runtime } = makeRuntime({
      tables: {
        messages: [
          row("aaaaaaaa-0000-4000-8000-000000000001", "alpha row", 30, {
            entityId: entityA,
          }),
          row("aaaaaaaa-0000-4000-8000-000000000002", "beta row", 20, {
            entityId: entityB,
          }),
          row("aaaaaaaa-0000-4000-8000-000000000003", "gamma row", 10, {
            entityId: entityA,
          }),
        ],
      },
    });
    const call = await callRoute({
      runtime,
      method: "GET",
      path: `/api/memories/browse?entityId=${entityA}`,
    });
    expect(call.handled).toBe(true);
    const payload = call.json[0] as {
      total: number;
      memories: Array<{ id: string }>;
    };
    expect(payload.total).toBe(2);
    expect(payload.memories.map((item) => item.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000003",
    ]);
  });

  test("offset slices the newest-first ordering and drives hasMore", async () => {
    const { runtime } = makeRuntime({ tables: browseTables() });
    const firstPage = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memories/browse?limit=2&offset=0",
    });
    const firstPayload = firstPage.json[0] as {
      memories: Array<{ id: string }>;
      hasMore: boolean;
      total: number;
      offset: number;
    };
    expect(firstPayload.memories.map((item) => item.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
    ]);
    expect(firstPayload.hasMore).toBe(true);
    expect(firstPayload.total).toBe(3);
    expect(firstPayload.offset).toBe(0);

    const secondPage = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memories/browse?limit=2&offset=1",
    });
    const secondPayload = secondPage.json[0] as {
      memories: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondPayload.memories.map((item) => item.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000003",
    ]);
    expect(secondPayload.hasMore).toBe(false);
  });
});

describe("GET /api/memories/by-entity/:id", () => {
  test("a non-UUID entity id answers 400", async () => {
    const { runtime } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memories/by-entity/not-a-uuid",
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([
      { message: "Invalid entity identifier.", status: 400 },
    ]);
  });

  test("entityIds widen the scan while echoing the primary path identity", async () => {
    const entityOne = "22222222-2222-4222-8222-222222222222";
    const entityTwo = "33333333-3333-4333-8333-333333333333";
    const entityThree = "44444444-4444-4444-8444-444444444444";
    const { runtime } = makeRuntime({
      tables: {
        messages: [
          row("aaaaaaaa-0000-4000-8000-000000000001", "one", 30, {
            entityId: entityOne as UUID,
          }),
          row("aaaaaaaa-0000-4000-8000-000000000002", "two", 20, {
            entityId: entityTwo as UUID,
          }),
          row("aaaaaaaa-0000-4000-8000-000000000003", "three", 10, {
            entityId: entityThree as UUID,
          }),
        ],
      },
    });
    const call = await callRoute({
      runtime,
      method: "GET",
      path: `/api/memories/by-entity/${entityOne}?entityIds=${entityOne},${entityTwo}`,
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    const payload = call.json[0] as {
      entityId: string;
      total: number;
      totalIsExact: boolean;
      memories: Array<{ id: string; type: string }>;
    };
    expect(payload.entityId).toBe(entityOne);
    expect(payload.total).toBe(2);
    expect(payload.totalIsExact).toBe(false);
    expect(payload.memories.map((item) => item.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
    ]);
  });
});

describe("DELETE and PATCH /api/memories/:id", () => {
  test("literal sibling names stay unambiguous via the UUID guard", async () => {
    const { runtime } = makeRuntime();
    const deletedFeed = await callRoute({
      runtime,
      method: "DELETE",
      path: "/api/memories/feed",
    });
    expect(deletedFeed.handled).toBe(true);
    expect(deletedFeed.errors).toEqual([
      { message: "Invalid memory id.", status: 400 },
    ]);

    const patchedStats = await callRoute({
      runtime,
      method: "PATCH",
      path: "/api/memories/stats",
      body: { text: "new text" },
    });
    expect(patchedStats.errors).toEqual([
      { message: "Invalid memory id.", status: 400 },
    ]);
  });

  test("deleting an unknown id answers 404", async () => {
    const { runtime } = makeRuntime();
    const call = await callRoute({
      runtime,
      method: "DELETE",
      path: "/api/memories/aaaaaaaa-0000-4000-8000-000000000009",
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([
      { message: "Memory not found.", status: 404 },
    ]);
  });

  test("delete removes the row and answers the deleted contract", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const { runtime, deleteMemory } = makeRuntime({
      tables: { messages: [row(target, "obsolete note", 1)] },
    });
    const call = await callRoute({
      runtime,
      method: "DELETE",
      path: `/api/memories/${target}`,
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    expect(deleteMemory).toHaveBeenCalledWith(target);
    expect(call.json[0]).toEqual({ deleted: true, id: target });
  });

  test("PATCH keeps prior content fields and re-reads the updated row", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000007";
    const existing = row(target, "old wording", 7, { source: "chat" });
    existing.content.tag = "keep";
    const { runtime, updateMemory, useModel } = makeRuntime({
      tables: { messages: [existing] },
      embedding: [9, 8, 7],
    });
    const call = await callRoute({
      runtime,
      method: "PATCH",
      path: `/api/memories/${target}`,
      body: { text: "new wording" },
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    expect(useModel).toHaveBeenCalledWith(
      ModelType.TEXT_EMBEDDING,
      expect.objectContaining({ text: "new wording" }),
    );
    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: target,
        content: { text: "new wording", source: "chat", tag: "keep" },
        embedding: [9, 8, 7],
      }),
    );
    expect(call.json[0]).toMatchObject({
      updated: true,
      id: target,
    });
    const memory = (call.json[0] as { memory: { content: { text: string } } })
      .memory;
    expect(memory.content.text).toBe("new wording");
  });

  test("PATCH waits for a conversational lease and preserves content committed before admission", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000017";
    const tables = { messages: [row(target, "old wording", 7)] };
    const { runtime, updateMemory, useModel } = makeRuntime({ tables });
    const acquire = vi.spyOn(runtime.roomHandlerQueue, "acquire");
    const lease = await runtime.roomHandlerQueue.acquire(DEFAULT_ROOM_ID);
    const pending = callRoute({
      runtime,
      method: "PATCH",
      path: `/api/memories/${target}`,
      body: { text: "edited wording" },
    });
    try {
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
      expect(useModel).not.toHaveBeenCalled();
      expect(updateMemory).not.toHaveBeenCalled();
      tables.messages[0] = {
        ...row(target, "recovered wording", 7),
        content: { text: "recovered wording", settledField: "keep latest" },
      };
    } finally {
      await lease.release();
    }
    const result = await pending;
    expect(result.errors).toEqual([]);
    expect(tables.messages[0]?.content).toEqual({
      text: "edited wording",
      settledField: "keep latest",
    });
  });

  test.each(["PATCH", "DELETE"])(
    "%s rechecks existence after waiting for a conversational lease",
    async (method) => {
      const target = "aaaaaaaa-0000-4000-8000-000000000018";
      const tables = { messages: [row(target, "obsolete wording", 7)] };
      const { runtime, deleteMemory, updateMemory, useModel } = makeRuntime({
        tables,
      });
      const acquire = vi.spyOn(runtime.roomHandlerQueue, "acquire");
      const lease = await runtime.roomHandlerQueue.acquire(DEFAULT_ROOM_ID);
      const pending = callRoute({
        runtime,
        method,
        path: `/api/memories/${target}`,
        body: { text: "edited wording" },
      });
      try {
        await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
        expect(deleteMemory).not.toHaveBeenCalled();
        expect(updateMemory).not.toHaveBeenCalled();
        expect(useModel).not.toHaveBeenCalled();
        tables.messages.length = 0;
      } finally {
        await lease.release();
      }
      const result = await pending;
      expect(result.errors).toEqual([
        { message: "Memory not found.", status: 404 },
      ]);
      expect(deleteMemory).not.toHaveBeenCalled();
      expect(updateMemory).not.toHaveBeenCalled();
      expect(useModel).not.toHaveBeenCalled();
    },
  );

  test("PATCH preserves private reply recovery evidence in storage but excludes it from the response", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000019";
    const existing = row(target, "old wording", 7, { source: "chat" });
    const marker = {
      version: 1,
      scope: "original-turn",
      clientMessageId: "original-client-id",
      fingerprint: "original-fingerprint",
      replyRecoveryJson: JSON.stringify({
        context: "private-recovery-context-fixture",
        actionResults: [{ success: true, text: "private-effect-fixture" }],
      }),
    };
    existing.content.chatIdempotency = marker;
    const { runtime } = makeRuntime({ tables: { messages: [existing] } });
    const call = await callRoute({
      runtime,
      method: "PATCH",
      path: `/api/memories/${target}`,
      body: { text: "new wording" },
    });
    expect(call.errors).toEqual([]);
    expect(call.json[0]).toMatchObject({
      updated: true,
      id: target,
      memory: { content: { text: "new wording", source: "chat" } },
    });
    expect(JSON.stringify(call.json)).not.toContain(
      "private-recovery-context-fixture",
    );
    expect(JSON.stringify(call.json)).not.toContain("private-effect-fixture");
    expect(existing.content.chatIdempotency).toEqual(marker);
    expect(existing.content.text).toBe("new wording");
  });

  test("an embedding failure answers 500 before touching the store", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000008";
    const { runtime, updateMemory } = makeRuntime({
      tables: { messages: [row(target, "stable note", 8)] },
      embeddingError: new Error("embedding backend down"),
    });
    const call = await callRoute({
      runtime,
      method: "PATCH",
      path: `/api/memories/${target}`,
      body: { text: "attempted wording" },
    });
    expect(call.handled).toBe(true);
    expect(updateMemory).not.toHaveBeenCalled();
    expect(call.errors).toEqual([
      {
        message: "Failed to regenerate embedding: embedding backend down",
        status: 500,
      },
    ]);
  });

  test("an empty embedding vector answers 500 before touching the store", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000006";
    const { runtime, updateMemory } = makeRuntime({
      tables: { messages: [row(target, "stable note", 6)] },
      embedding: [],
    });
    const call = await callRoute({
      runtime,
      method: "PATCH",
      path: `/api/memories/${target}`,
      body: { text: "attempted wording" },
    });
    expect(call.handled).toBe(true);
    expect(updateMemory).not.toHaveBeenCalled();
    expect(call.errors).toEqual([
      { message: "Embedding model returned no vector.", status: 500 },
    ]);
  });
});

describe("GET /api/memories/stats", () => {
  test("counts each table exactly and sums the total", async () => {
    const { runtime, countMemories } = makeRuntime({
      tables: {
        messages: [
          row("aaaaaaaa-0000-4000-8000-000000000001", "one", 3),
          row("aaaaaaaa-0000-4000-8000-000000000002", "two", 2),
        ],
        facts: [row("bbbbbbbb-0000-4000-8000-000000000003", "three", 1)],
      },
    });
    const call = await callRoute({
      runtime,
      method: "GET",
      path: "/api/memories/stats",
    });
    expect(call.handled).toBe(true);
    expect(call.errors).toEqual([]);
    expect(countMemories).toHaveBeenCalledTimes(4);
    expect(countMemories).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      tableName: "memories",
    });
    expect(call.json[0]).toEqual({
      total: 3,
      byType: { messages: 2, memories: 0, facts: 1, documents: 0 },
      totalIsExact: true,
    });
  });
});

describe("invalidateMemorySearchCache", () => {
  test("resetting the whole cache still leaves search working", async () => {
    const { runtime, getMemories } = makeRuntime({
      tables: {
        messages: [
          row("aaaaaaaa-0000-4000-8000-000000000001", "osprey sighting", 1),
        ],
      },
    });
    await searchRoute(runtime, "q=osprey");
    expect(getMemories).toHaveBeenCalledTimes(1);

    invalidateMemorySearchCache();
    const { value } = await searchRoute(runtime, "q=osprey");
    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(value.count).toBe(1);
  });

  test("unknown runtimes and rooms are safe no-ops", async () => {
    const stranger = {} as AgentRuntime;
    expect(() => invalidateMemorySearchCache(stranger)).not.toThrow();

    const { runtime } = makeRuntime();
    expect(() =>
      invalidateMemorySearchCache(runtime, stringToUuid("unknown-room")),
    ).not.toThrow();
    expect(() => invalidateMemorySearchCache(runtime)).not.toThrow();
  });
});
