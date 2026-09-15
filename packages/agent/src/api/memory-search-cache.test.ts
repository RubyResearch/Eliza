/**
 * Regression coverage for the /api/memory/search corpus + BM25 cache:
 * identical ranking cached vs cold, explicit invalidation on module-local
 * mutations (remember / DELETE / PATCH), count-based staleness detection,
 * same-request retry and bounded typed failure for unstable snapshots, bounded
 * refresh failure, runtime isolation, rebuild races, and memory limits.
 */

import {
  type AgentRuntime,
  ElizaError,
  InMemoryDatabaseAdapter,
  type Memory,
  RoomHandlerQueue,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import {
  HASH_MEMORY_SOURCE,
  handleMemoryRoutes,
  invalidateMemorySearchCache,
} from "./memory-routes.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;

type Store = { rows: Memory[] };

function note(
  id: string,
  text: string,
  createdAt: number,
  roomId = stringToUuid("Eliza-hash-memory-room") as UUID,
): Memory {
  return {
    id: id as UUID,
    entityId: AGENT_ID,
    agentId: AGENT_ID,
    roomId,
    createdAt,
    content: { text, source: HASH_MEMORY_SOURCE },
  } as Memory;
}

function makeRuntime(store: Store) {
  const getMemories = vi.fn(async () => [...store.rows]);
  const countMemories = vi.fn(
    async (_params: { roomId?: UUID }) => store.rows.length,
  );
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    roomHandlerQueue: new RoomHandlerQueue(),
    ensureConnection: vi.fn(async () => undefined),
    getMemories,
    countMemories,
    getMemoryById: vi.fn(
      async (id: UUID) => store.rows.find((row) => row.id === id) ?? null,
    ),
    createMemory: vi.fn(async (memory: Memory) => {
      store.rows.push(memory);
      return memory.id;
    }),
    deleteMemory: vi.fn(async (id: UUID) => {
      store.rows = store.rows.filter((row) => row.id !== id);
    }),
    updateMemory: vi.fn(
      async (patch: { id: UUID; content: Record<string, unknown> }) => {
        const row = store.rows.find((r) => r.id === patch.id);
        if (row) row.content = patch.content as Memory["content"];
      },
    ),
    useModel: vi.fn(async () => [0.1, 0.2, 0.3]),
    reportError: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
  return { runtime, getMemories, countMemories };
}

async function makeAdapterRuntime() {
  const adapter = new InMemoryDatabaseAdapter();
  await adapter.initialize();
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    roomHandlerQueue: new RoomHandlerQueue(),
    ensureConnection: vi.fn(async () => undefined),
    getMemories: vi.fn(
      async (params: Parameters<InMemoryDatabaseAdapter["getMemories"]>[0]) =>
        adapter.getMemories(params),
    ),
    countMemories: vi.fn(
      async (params: { roomId?: UUID; tableName?: string }) =>
        adapter.countMemories({
          roomIds: params.roomId ? [params.roomId] : undefined,
          tableName: params.tableName,
        }),
    ),
    getMemoryById: vi.fn(
      async (id: UUID) => (await adapter.getMemoriesByIds([id]))[0] ?? null,
    ),
    createMemory: vi.fn(
      async (memory: Memory, tableName: string) =>
        (await adapter.createMemories([{ memory, tableName }]))[0],
    ),
    deleteMemory: vi.fn(async (id: UUID) => adapter.deleteMemories([id])),
    updateMemory: vi.fn(async (patch: Partial<Memory> & { id: UUID }) =>
      adapter.updateMemories([patch]),
    ),
    useModel: vi.fn(async () => [0.1, 0.2, 0.3]),
    reportError: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
  return { runtime, adapter };
}

function contextFor(args: {
  runtime: AgentRuntime;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  response: { value?: unknown };
}): MemoryRouteContext {
  return {
    req: {} as never,
    res: {} as never,
    method: args.method,
    pathname: args.path.split("?")[0] ?? args.path,
    url: new URL(`https://agent.test${args.path}`),
    runtime: args.runtime,
    agentName: "Eliza",
    json: (_res, value) => {
      args.response.value = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => (args.body ?? {}) as T,
  };
}

async function search(
  runtime: AgentRuntime,
  query: string,
): Promise<Array<{ id: string; text: string; score: number }>> {
  const response: { value?: unknown } = {};
  const handled = await handleMemoryRoutes(
    contextFor({
      runtime,
      method: "GET",
      path: `/api/memory/search?q=${encodeURIComponent(query)}&limit=50`,
      response,
    }),
  );
  expect(handled).toBe(true);
  return (
    response.value as {
      results: Array<{ id: string; text: string; score: number }>;
    }
  ).results;
}

async function waitForTestCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}

beforeEach(() => {
  invalidateMemorySearchCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/memory/search corpus cache", () => {
  test("finds remember-created rows through the real adapter", async () => {
    const { runtime } = await makeAdapterRuntime();
    for (const text of [
      "quartz deadline moved to Friday",
      "voice pipeline ships tonight",
      "morning workout at the gym",
    ]) {
      const response: { value?: unknown } = {};
      await handleMemoryRoutes(
        contextFor({
          runtime,
          method: "POST",
          path: "/api/memory/remember",
          body: { text },
          response,
        }),
      );
    }

    const results = await search(runtime, "quartz");

    expect(results).toEqual([
      expect.objectContaining({ text: "quartz deadline moved to Friday" }),
    ]);
    expect(runtime.getMemories).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
    expect(runtime.countMemories).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
  });

  test("warm search reuses the corpus (no rescan) and returns identical ordering", async () => {
    const store: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "alexis gym signup together planned",
          3,
        ),
        note(
          "aaaaaaaa-0000-4000-8000-000000000002",
          "shipping the voice pipeline tonight",
          2,
        ),
        note(
          "aaaaaaaa-0000-4000-8000-000000000003",
          "alexis prefers morning workouts at the gym",
          1,
        ),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);

    const cold = await search(runtime, "alexis gym");
    expect(getMemories).toHaveBeenCalledTimes(1);

    const warm = await search(runtime, "alexis gym");
    expect(getMemories).toHaveBeenCalledTimes(1); // corpus reused
    expect(warm).toEqual(cold);

    // Cold path after explicit invalidation must produce the exact same
    // ranking (cache is a pure perf optimization, not a semantic change).
    invalidateMemorySearchCache();
    const rebuilt = await search(runtime, "alexis gym");
    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(rebuilt).toEqual(cold);
  });

  test("remember invalidates: new note is searchable immediately", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "old note about tea", 1),
      ],
    };
    const { runtime } = makeRuntime(store);

    await search(runtime, "quartz"); // prime the cache

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "POST",
        path: "/api/memory/remember",
        body: { text: "the quartz deadline moved to friday" },
        response,
      }),
    );
    expect(response.value).toEqual(expect.objectContaining({ ok: true }));

    const results = await search(runtime, "quartz");
    expect(results.some((r) => r.text.includes("quartz deadline"))).toBe(true);
  });

  test("DELETE invalidates: removed note stops appearing immediately", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000009";
    const store: Store = {
      rows: [
        note(target, "obsolete plan about zeppelin logistics", 2),
        note("aaaaaaaa-0000-4000-8000-000000000002", "unrelated note", 1),
      ],
    };
    const { runtime } = makeRuntime(store);

    const before = await search(runtime, "zeppelin");
    expect(before.some((r) => r.id === target)).toBe(true);

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "DELETE",
        path: `/api/memories/${target}`,
        response,
      }),
    );
    expect(response.value).toEqual(expect.objectContaining({ deleted: true }));

    const after = await search(runtime, "zeppelin");
    expect(after.some((r) => r.id === target)).toBe(false);
  });

  test("PATCH invalidates: edited text is searchable immediately", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const store: Store = {
      rows: [note(target, "original wording", 1)],
    };
    const { runtime } = makeRuntime(store);

    await search(runtime, "gyroscope"); // prime the cache with the old text

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );
    expect(response.value).toEqual(expect.objectContaining({ updated: true }));

    const results = await search(runtime, "gyroscope");
    expect(results.some((r) => r.id === target)).toBe(true);
  });

  test("PATCH invalidates the mutated memory room, not the current hash room", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const roomId = (name: string) =>
      stringToUuid(`${name}-hash-memory-room`) as UUID;
    const store: Store = {
      rows: [note(target, "original wording", 1, roomId("A"))],
    };
    const { runtime } = makeRuntime(store);

    runtime.character.name = "A";
    await search(runtime, "gyroscope");

    // A by-id mutation can be issued while a different character-derived room
    // is current. The memory's own room is the cache ownership authority.
    runtime.character.name = "B";
    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );

    runtime.character.name = "A";
    await expect(search(runtime, "gyroscope")).resolves.toEqual([
      expect.objectContaining({
        id: target,
        text: "corrected wording about the gyroscope",
      }),
    ]);
  });

  test("does not return a cached snapshot invalidated while COUNT is pending", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const store: Store = { rows: [note(target, "original wording", 1)] };
    const { runtime, getMemories, countMemories } = makeRuntime(store);
    await search(runtime, "gyroscope");

    let releaseCount = () => {};
    const countGate = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });
    countMemories.mockImplementationOnce(async () => {
      await countGate;
      return store.rows.length;
    });
    const pendingSearch = search(runtime, "gyroscope");
    await vi.waitFor(() => expect(countMemories).toHaveBeenCalledTimes(3));

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );
    releaseCount();

    await expect(pendingSearch).resolves.toEqual([
      expect.objectContaining({
        text: "corrected wording about the gyroscope",
      }),
    ]);
    expect(getMemories).toHaveBeenCalledTimes(2);
  });

  test("does not return a cached snapshot whose COUNT-waiting slot was evicted", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const roomId = (name: string) =>
      stringToUuid(`${name}-hash-memory-room`) as UUID;
    const stores = new Map<UUID, Store>([
      [
        roomId("A"),
        { rows: [note(target, "original wording", 1, roomId("A"))] },
      ],
      [
        roomId("B"),
        {
          rows: [note("bbbbbbbb-0000-4000-8000-000000000001", "room B", 1)],
        },
      ],
      [
        roomId("C"),
        {
          rows: [note("cccccccc-0000-4000-8000-000000000001", "room C", 1)],
        },
      ],
      [
        roomId("D"),
        {
          rows: [note("dddddddd-0000-4000-8000-000000000001", "room D", 1)],
        },
      ],
      [
        roomId("E"),
        {
          rows: [note("eeeeeeee-0000-4000-8000-000000000001", "room E", 1)],
        },
      ],
      [
        roomId("F"),
        {
          rows: [note("ffffffff-0000-4000-8000-000000000001", "room F", 1)],
        },
      ],
      [
        roomId("G"),
        {
          rows: [note("99999999-0000-4000-8000-000000000001", "room G", 1)],
        },
      ],
      [
        roomId("H"),
        {
          rows: [note("88888888-0000-4000-8000-000000000001", "room H", 1)],
        },
      ],
    ]);
    const getMemories = vi.fn(
      async ({ roomId: currentRoomId }: { roomId: UUID }) => [
        ...(stores.get(currentRoomId)?.rows ?? []),
      ],
    );
    const countMemories = vi.fn(
      async ({ roomId: currentRoomId }: { roomId: UUID }) =>
        stores.get(currentRoomId)?.rows.length ?? 0,
    );
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "A" },
      roomHandlerQueue: new RoomHandlerQueue(),
      ensureConnection: vi.fn(async () => undefined),
      getMemories,
      countMemories,
      getMemoryById: vi.fn(async (id: UUID) => {
        for (const store of stores.values()) {
          const row = store.rows.find((candidate) => candidate.id === id);
          if (row) return row;
        }
        return null;
      }),
      updateMemory: vi.fn(
        async (patch: { id: UUID; content: Record<string, unknown> }) => {
          for (const store of stores.values()) {
            const row = store.rows.find(
              (candidate) => candidate.id === patch.id,
            );
            if (row) row.content = patch.content as Memory["content"];
          }
        },
      ),
      useModel: vi.fn(async () => [0.1, 0.2, 0.3]),
      reportError: vi.fn(() => undefined),
    } as unknown as AgentRuntime;

    for (const room of ["A", "B", "C", "D"]) {
      runtime.character.name = room;
      await search(runtime, "gyroscope");
    }

    let releaseCount = () => {};
    const countGate = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });
    let markCountEntered = () => {};
    const countEntered = new Promise<void>((resolve) => {
      markCountEntered = resolve;
    });
    let gateNextACount = true;
    countMemories.mockImplementation(async ({ roomId: currentRoomId }) => {
      if (gateNextACount && currentRoomId === roomId("A")) {
        gateNextACount = false;
        markCountEntered();
        await countGate;
      }
      return stores.get(currentRoomId)?.rows.length ?? 0;
    });
    runtime.character.name = "A";
    const pendingSearch = search(runtime, "gyroscope");
    await countEntered;

    for (const room of ["E", "F", "G", "H"]) {
      runtime.character.name = room;
      await search(runtime, "gyroscope");
    }

    const response: { value?: unknown } = {};
    runtime.character.name = "A";
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );
    releaseCount();

    await expect(pendingSearch).resolves.toEqual([
      expect.objectContaining({
        text: "corrected wording about the gyroscope",
      }),
    ]);
    await expect(search(runtime, "gyroscope")).resolves.toEqual([
      expect.objectContaining({
        text: "corrected wording about the gyroscope",
      }),
    ]);
    expect(getMemories).toHaveBeenCalledTimes(9);
  });

  test("retains an in-flight room slot instead of starting orphaned replacement work", async () => {
    const roomId = (name: string) =>
      stringToUuid(`${name}-hash-memory-room`) as UUID;
    let releaseFirstA = () => {};
    const firstAGate = new Promise<void>((resolve) => {
      releaseFirstA = resolve;
    });
    let aScans = 0;
    const getMemories = vi.fn(
      async ({ roomId: currentRoomId }: { roomId: UUID }) => {
        if (currentRoomId === roomId("A")) {
          aScans++;
          if (aScans === 1) await firstAGate;
        }
        return [
          note(
            "aaaaaaaa-0000-4000-8000-000000000001",
            `${currentRoomId} puffin`,
            1,
            currentRoomId,
          ),
        ];
      },
    );
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "A" },
      roomHandlerQueue: new RoomHandlerQueue(),
      ensureConnection: vi.fn(async () => undefined),
      getMemories,
      // No countMemories means every result is intentionally uncached.
      reportError: vi.fn(() => undefined),
    } as unknown as AgentRuntime;

    const firstA = search(runtime, "puffin");
    await waitForTestCondition(() => aScans === 1);
    for (const room of ["B", "C", "D", "E"]) {
      runtime.character.name = room;
      await search(runtime, "puffin");
    }

    // Completed uncached slots remain evictable, but A stays canonical while
    // its scan is pending. A second request joins that work instead of starting
    // an orphaned replacement scan outside the Map bound.
    runtime.character.name = "A";
    const secondA = search(runtime, "puffin");
    await waitForTestCondition(() => aScans === 1);

    releaseFirstA();
    await expect(firstA).resolves.toHaveLength(1);
    await expect(secondA).resolves.toHaveLength(1);
    expect(getMemories).toHaveBeenCalledTimes(5);
  });

  test("caps peak active corpus builds across concurrent room churn", async () => {
    let activeBuilds = 0;
    let peakActiveBuilds = 0;
    const getMemories = vi.fn(
      async ({ roomId }: { roomId: UUID }): Promise<Memory[]> => {
        activeBuilds++;
        peakActiveBuilds = Math.max(peakActiveBuilds, activeBuilds);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        activeBuilds--;
        return [
          note(crypto.randomUUID(), `${roomId} bounded puffin`, 1, roomId),
        ];
      },
    );
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "room-0" },
      ensureConnection: vi.fn(async () => undefined),
      getMemories,
      // No countMemories keeps every completed result intentionally uncached.
      reportError: vi.fn(() => undefined),
    } as unknown as AgentRuntime;

    const searches = Array.from({ length: 12 }, (_, index) => {
      runtime.character.name = `room-${index}`;
      return search(runtime, "puffin");
    });

    const settled = await Promise.allSettled(searches);
    expect(
      settled.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof ElizaError
                ? { code: result.reason.code, context: result.reason.context }
                : result.reason,
            ]
          : [],
      ),
    ).toEqual([]);
    expect(settled).toHaveLength(12);
    expect(getMemories).toHaveBeenCalledTimes(12);
    expect(activeBuilds).toBe(0);
    expect(peakActiveBuilds).toBe(4);
  });

  test("caps detached same-room builds during invalidation churn", async () => {
    let activeBuilds = 0;
    let peakActiveBuilds = 0;
    let releaseBuilds = () => {};
    const buildGate = new Promise<void>((resolve) => {
      releaseBuilds = resolve;
    });
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "storm petrel", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);
    getMemories.mockImplementation(async () => {
      activeBuilds++;
      peakActiveBuilds = Math.max(peakActiveBuilds, activeBuilds);
      await buildGate;
      activeBuilds--;
      return [...store.rows];
    });
    const roomId = stringToUuid("Eliza-hash-memory-room") as UUID;

    const searches: Array<Promise<unknown>> = [];
    for (let index = 0; index < 4; index++) {
      searches.push(search(runtime, "petrel"));
      await waitForTestCondition(
        () => getMemories.mock.calls.length === index + 1,
      );
      invalidateMemorySearchCache(runtime, roomId);
    }
    for (let index = 4; index < 12; index++) {
      searches.push(search(runtime, "petrel"));
      invalidateMemorySearchCache(runtime, roomId);
    }

    expect(activeBuilds).toBe(4);
    expect(peakActiveBuilds).toBe(4);
    releaseBuilds();

    await expect(Promise.all(searches)).resolves.toHaveLength(12);
    expect(activeBuilds).toBe(0);
    expect(peakActiveBuilds).toBeLessThanOrEqual(4);
  });

  test("retries a cold build invalidated by a completed mutation", async () => {
    const target = "aaaaaaaa-0000-4000-8000-000000000005";
    const store: Store = { rows: [note(target, "original wording", 1)] };
    const { runtime, getMemories } = makeRuntime(store);
    let releaseScan = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    getMemories.mockImplementationOnce(async () => {
      const staleSnapshot = [...store.rows];
      await scanGate;
      return staleSnapshot;
    });

    const pendingSearch = search(runtime, "gyroscope");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledOnce());

    const response: { value?: unknown } = {};
    await handleMemoryRoutes(
      contextFor({
        runtime,
        method: "PATCH",
        path: `/api/memories/${target}`,
        body: { text: "corrected wording about the gyroscope" },
        response,
      }),
    );
    releaseScan();

    await expect(pendingSearch).resolves.toEqual([
      expect.objectContaining({
        text: "corrected wording about the gyroscope",
      }),
    ]);
    expect(getMemories).toHaveBeenCalledTimes(2);
  });

  test("out-of-band create (row count change) is picked up on the next search", async () => {
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "baseline note", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);

    await search(runtime, "meteor");
    expect(getMemories).toHaveBeenCalledTimes(1);

    // Simulate a write that did NOT go through this module (normal chat
    // writing to the "messages" table).
    store.rows.push(
      note("aaaaaaaa-0000-4000-8000-000000000002", "meteor shower friday", 2),
    );

    const results = await search(runtime, "meteor");
    expect(getMemories).toHaveBeenCalledTimes(2); // count mismatch forced rebuild
    expect(results.some((r) => r.text.includes("meteor shower"))).toBe(true);
  });

  test("count mismatch supersedes an older in-flight background refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00Z"));
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "baseline note", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);
    await search(runtime, "meteor");

    let releaseStaleScan = () => {};
    const staleScanGate = new Promise<void>((resolve) => {
      releaseStaleScan = resolve;
    });
    getMemories.mockImplementationOnce(async () => {
      const staleSnapshot = [...store.rows];
      await staleScanGate;
      return staleSnapshot;
    });

    // Start a stale-while-revalidate build and leave its old snapshot in flight.
    vi.advanceTimersByTime(11_000);
    await search(runtime, "meteor");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledTimes(2));

    // The next request observes the changed count. It must start a new scan,
    // not join the older refresh that captured the one-row corpus.
    store.rows.push(
      note("aaaaaaaa-0000-4000-8000-000000000002", "meteor shower friday", 2),
    );
    const freshSearch = search(runtime, "meteor");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledTimes(3));
    await expect(freshSearch).resolves.toEqual([
      expect.objectContaining({ text: "meteor shower friday" }),
    ]);

    releaseStaleScan();
  });

  test("count-preserving edit refreshes after one bounded stale response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00Z"));
    const target = "aaaaaaaa-0000-4000-8000-000000000001";
    const store: Store = { rows: [note(target, "stale text", 1)] };
    const { runtime } = makeRuntime(store);

    await search(runtime, "kestrel");

    // In-place edit that keeps the row count identical.
    const row = store.rows.find((r) => r.id === target);
    if (row)
      row.content = { text: "kestrel sighting", source: HASH_MEMORY_SOURCE };

    // The first request after the TTL remains warm and launches one refresh.
    vi.advanceTimersByTime(16_000);
    const staleWhileRefreshing = await search(runtime, "kestrel");
    expect(staleWhileRefreshing).toEqual([]);
    for (let index = 0; index < 10; index++) await Promise.resolve();

    const results = await search(runtime, "kestrel");
    expect(results.some((r) => r.text === "kestrel sighting")).toBe(true);
  });

  test("persistent refresh failure cannot extend staleness past the hard bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00Z"));
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "old osprey", 1)],
    };
    const { runtime, getMemories } = makeRuntime(store);
    await search(runtime, "osprey");
    const row = store.rows[0];
    if (row)
      row.content = {
        text: "replacement condor",
        source: HASH_MEMORY_SOURCE,
      };
    getMemories.mockRejectedValue(new Error("refresh backend unavailable"));

    vi.advanceTimersByTime(11_000);
    const boundedStale = await search(runtime, "osprey");
    expect(boundedStale).toHaveLength(1);
    for (let index = 0; index < 10; index++) await Promise.resolve();

    vi.advanceTimersByTime(10_000);
    await expect(search(runtime, "osprey")).rejects.toThrow(
      "refresh backend unavailable",
    );
    expect(runtime.reportError).toHaveBeenCalledWith(
      "MemorySearchCache.refresh",
      expect.objectContaining({ message: "refresh backend unavailable" }),
      expect.objectContaining({ roomId: expect.any(String) }),
    );
  });

  test("runtime without countMemories degrades to the uncached scan", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "fallback path note", 1),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    (runtime as unknown as Record<string, unknown>).countMemories = undefined;

    const first = await search(runtime, "fallback");
    const second = await search(runtime, "fallback");
    expect(getMemories).toHaveBeenCalledTimes(2); // no cache without a freshness signal
    expect(second).toEqual(first);
  });

  test("isolates equal-count corpora owned by distinct runtime instances", async () => {
    const firstStore: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "first runtime albatross",
          1,
        ),
      ],
    };
    const secondStore: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000002",
          "second runtime kestrel",
          1,
        ),
      ],
    };
    const first = makeRuntime(firstStore);
    const second = makeRuntime(secondStore);

    expect(await search(first.runtime, "albatross")).toHaveLength(1);
    const secondResults = await search(second.runtime, "kestrel");

    expect(secondResults.map((result) => result.text)).toEqual([
      "second runtime kestrel",
    ]);
    expect(second.getMemories).toHaveBeenCalledOnce();
  });

  test("retries a corpus whose scan raced a row-count change before returning", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "baseline sparrow", 1),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    getMemories.mockImplementationOnce(async () => {
      const staleSnapshot = [...store.rows];
      store.rows.push(
        note("aaaaaaaa-0000-4000-8000-000000000002", "racing pelican", 2),
      );
      return staleSnapshot;
    });

    const fresh = await search(runtime, "pelican");

    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(fresh.map((result) => result.text)).toEqual(["racing pelican"]);
  });

  test("single-flights the retry shared by count-mismatch joiners", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "baseline sparrow", 1),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    getMemories.mockImplementationOnce(async () => {
      const staleSnapshot = [...store.rows];
      store.rows.push(
        note("aaaaaaaa-0000-4000-8000-000000000002", "racing pelican", 2),
      );
      return staleSnapshot;
    });

    const [first, second] = await Promise.all([
      search(runtime, "pelican"),
      search(runtime, "pelican"),
    ]);

    expect(first.map((result) => result.text)).toEqual(["racing pelican"]);
    expect(second).toEqual(first);
    expect(getMemories).toHaveBeenCalledTimes(2);
  });

  test("fails with a typed bounded error when room counts never stabilize", async () => {
    const store: Store = {
      rows: [note("aaaaaaaa-0000-4000-8000-000000000001", "restless tern", 1)],
    };
    const { runtime, getMemories, countMemories } = makeRuntime(store);
    let count = 0;
    countMemories.mockImplementation(async () => ++count);

    await expect(search(runtime, "tern")).rejects.toMatchObject({
      code: "MEMORY_SEARCH_UNSTABLE_SNAPSHOT",
      context: {
        attempts: 3,
        countBefore: 5,
        countAfter: 6,
      },
    });
    expect(getMemories).toHaveBeenCalledTimes(3);
  });

  test("shares the retry budget across perpetual generation invalidation", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "restless petrel", 1),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    const releases: Array<() => void> = [];
    getMemories.mockImplementation(async () => {
      const snapshot = [...store.rows];
      await new Promise<void>((resolve) => releases.push(resolve));
      return snapshot;
    });
    const roomId = stringToUuid("Eliza-hash-memory-room") as UUID;

    const pending = search(runtime, "petrel");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitForTestCondition(
        () => getMemories.mock.calls.length === attempt,
      );
      invalidateMemorySearchCache(runtime, roomId);
      const release = releases.shift();
      if (!release) throw new Error("Expected a gated memory scan");
      release();
    }

    await expect(pending).rejects.toMatchObject({
      code: "MEMORY_SEARCH_UNSTABLE_SNAPSHOT",
      context: { attempts: 3, reason: "generation" },
    });
    expect(getMemories).toHaveBeenCalledTimes(3);
  });

  test("shares the retry budget across repeated canonical slot replacement", async () => {
    const roomA = stringToUuid("A-hash-memory-room") as UUID;
    const store: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "canonical sparrow",
          1,
          roomA,
        ),
      ],
    };
    const { runtime, countMemories } = makeRuntime(store);
    runtime.character.name = "A";
    let roomACountCalls = 0;
    const countGates = new Map<number, Promise<void>>();
    const releaseCountGates = new Map<number, () => void>();
    for (const call of [3, 6, 9]) {
      countGates.set(
        call,
        new Promise<void>((resolve) => releaseCountGates.set(call, resolve)),
      );
    }
    countMemories.mockImplementation(
      async ({ roomId }: { roomId?: UUID }): Promise<number> => {
        if (!roomId) return store.rows.length;
        if (roomId === roomA) {
          roomACountCalls++;
          const gate = countGates.get(roomACountCalls);
          if (gate) await gate;
        }
        return store.rows.filter((row) => row.roomId === roomId).length;
      },
    );

    await expect(search(runtime, "sparrow")).resolves.toHaveLength(1);
    const pending = search(runtime, "sparrow");

    const replaceMapAndRebuildRoomA = async () => {
      invalidateMemorySearchCache();
      runtime.character.name = "A";
      await search(runtime, "sparrow");
    };

    for (const gatedCall of [3, 6, 9]) {
      await waitForTestCondition(() => roomACountCalls >= gatedCall);
      await replaceMapAndRebuildRoomA();
      const release = releaseCountGates.get(gatedCall);
      if (!release) throw new Error("Expected a gated COUNT probe");
      release();
    }

    await expect(pending).rejects.toMatchObject({
      code: "MEMORY_SEARCH_UNSTABLE_SNAPSHOT",
      context: { attempts: 3, reason: "map_identity" },
    });
    expect(roomACountCalls).toBe(11);
  });

  test("single-flights concurrent cold rebuilds for one runtime and room", async () => {
    const store: Store = {
      rows: [
        note(
          "aaaaaaaa-0000-4000-8000-000000000001",
          "shared rebuild puffin",
          1,
        ),
      ],
    };
    const { runtime, getMemories } = makeRuntime(store);
    let releaseScan = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    getMemories.mockImplementationOnce(async () => {
      await scanGate;
      return [...store.rows];
    });

    const first = search(runtime, "puffin");
    const second = search(runtime, "puffin");
    await vi.waitFor(() => expect(getMemories).toHaveBeenCalledOnce());
    releaseScan();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ]);
    expect(getMemories).toHaveBeenCalledOnce();
  });

  test("reports count failures and keeps the fallback corpus uncached", async () => {
    const store: Store = {
      rows: [
        note("aaaaaaaa-0000-4000-8000-000000000001", "fallback count heron", 1),
      ],
    };
    const { runtime, getMemories, countMemories } = makeRuntime(store);
    countMemories.mockRejectedValue(new Error("count backend unavailable"));

    await search(runtime, "heron");
    await search(runtime, "heron");

    expect(getMemories).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "MemorySearchCache.countRoomMessages",
      expect.objectContaining({ message: "count backend unavailable" }),
      expect.objectContaining({ roomId: expect.any(String) }),
    );
  });

  test("does not retain a corpus whose source text exceeds the byte budget", async () => {
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      note(
        `aaaaaaaa-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        `oversized-${index}-${"x".repeat(4_200)}`,
        index,
      ),
    );
    const { runtime, getMemories } = makeRuntime({ rows });

    await search(runtime, "term-not-present");
    await search(runtime, "term-not-present");

    expect(getMemories).toHaveBeenCalledTimes(2);
  });
});
