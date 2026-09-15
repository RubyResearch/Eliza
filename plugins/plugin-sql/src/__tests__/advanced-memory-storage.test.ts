/**
 * Exercises long-term-memory access timestamp updates through the real runtime,
 * migrated PGlite adapter, and AdvancedMemoryStorageService persistence path.
 */
import type { Entity, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvancedMemoryStorageService } from "../services/advanced-memory-storage";
import { createTestDatabase } from "./test-helpers";

describe("AdvancedMemoryStorageService.updateLongTermMemory", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("keeps one durable supplied-ID record through replay, concurrent delivery, and service restart", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const id = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const input = {
      id,
      agentId,
      entityId,
      category: "semantic" as const,
      content: "Original durable memory",
      metadata: {
        extractionEvidenceId: "batch-1",
        sourceMessageRevisions: { source: "revision-1" },
      },
    };
    const results = await Promise.all([
      service.storeLongTermMemory(input),
      service.storeLongTermMemory(input),
    ]);
    expect(results.map((memory) => memory.id)).toEqual([id, id]);
    expect(await service.getLongTermMemories(agentId, entityId)).toHaveLength(1);
    const restarted = new AdvancedMemoryStorageService();
    await restarted.initialize(runtime);
    const createMemory = vi.spyOn(runtime, "createMemory");
    const replay = await restarted.storeLongTermMemory({ ...input, content: "Do not overwrite" });
    expect(replay).toMatchObject({ id, content: input.content, metadata: input.metadata });
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("recovers supplied-ID writes after commit acknowledgement failure", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const id = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const originalCreate = runtime.createMemory.bind(runtime);
    const failure = new Error("write acknowledgement lost");
    const createMemory = vi
      .spyOn(runtime, "createMemory")
      .mockImplementationOnce(async (...args) => {
        await originalCreate(...args);
        throw failure;
      });
    const input = {
      id,
      agentId,
      entityId,
      category: "semantic" as const,
      content: "Committed memory",
    };
    await expect(service.storeLongTermMemory(input)).rejects.toBe(failure);
    await expect(service.storeLongTermMemory(input)).resolves.toMatchObject({
      id,
      content: input.content,
    });
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(await service.getLongTermMemories(agentId, entityId)).toHaveLength(1);
  });

  it("does not return or replace another entity's supplied-ID memory", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const otherEntityId = uuidv4() as UUID;
    const id = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities(
      [entityId, otherEntityId].map(
        (entity) => ({ id: entity, agentId, names: ["Test Entity"], metadata: {} }) as Entity
      )
    );
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const input = {
      id,
      agentId,
      entityId,
      category: "semantic" as const,
      content: "Private memory",
    };
    await service.storeLongTermMemory(input);
    await expect(
      service.storeLongTermMemory({ ...input, entityId: otherEntityId })
    ).rejects.toMatchObject({ code: "LONG_TERM_MEMORY_ID_CONFLICT" });
    expect(await service.getLongTermMemories(agentId, otherEntityId)).toEqual([]);
    expect(await service.getLongTermMemories(agentId, entityId)).toHaveLength(1);
  });

  it("retains the persisted access timestamp when an unrelated field is updated", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const lastAccessedAt = new Date("2026-08-02T15:30:00.000Z");

    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
    });

    await service.updateLongTermMemory(stored.id, agentId, entityId, { lastAccessedAt });
    await service.updateLongTermMemory(stored.id, agentId, entityId, {
      content: "Updated memory",
    });

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.content).toBe("Updated memory");
    expect(updated?.lastAccessedAt?.toISOString()).toBe(lastAccessedAt.toISOString());
  });

  it("persists an access timestamp supplied while storing the memory", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const lastAccessedAt = new Date("2026-08-04T12:00:00.000Z");

    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
      lastAccessedAt,
    });

    expect(stored.lastAccessedAt?.toISOString()).toBe(lastAccessedAt.toISOString());
    const [persisted] = await service.getLongTermMemories(agentId, entityId);
    expect(persisted?.lastAccessedAt?.toISOString()).toBe(lastAccessedAt.toISOString());
  });

  it("names the long-term room with the complete entity UUID", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const ensureRoomExists = vi.spyOn(runtime, "ensureRoomExists");

    await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Remember the complete room identity",
    });

    expect(ensureRoomExists).toHaveBeenCalledWith(
      expect.objectContaining({ name: `Advanced Memory ${entityId}` })
    );
  });

  it("returns every long-term memory when no explicit limit is requested", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);

    for (let index = 0; index < 25; index += 1) {
      await service.storeLongTermMemory({
        agentId,
        entityId,
        category: "semantic",
        content: `Complete memory ${index}`,
      });
    }

    const complete = await service.getLongTermMemories(agentId, entityId);
    expect(complete).toHaveLength(25);
    expect(complete.map((memory) => memory.content)).toContain("Complete memory 0");
    await expect(
      service.getLongTermMemories(agentId, entityId, { limit: 3 })
    ).resolves.toHaveLength(3);
  });

  it("replaces the creation access timestamp with an explicit older value", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const initial = new Date("2026-08-03T09:45:00.000Z");
    const replacement = new Date("2026-08-02T15:30:00.000Z");

    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
      lastAccessedAt: initial,
    });
    expect(stored.lastAccessedAt?.toISOString()).toBe(initial.toISOString());

    await service.updateLongTermMemory(stored.id, agentId, entityId, {
      lastAccessedAt: replacement,
    });

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.lastAccessedAt?.toISOString()).toBe(replacement.toISOString());
  });

  it("serializes concurrent partial updates so a stale snapshot cannot replace newer metadata", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const initial = new Date("2026-08-03T09:45:00.000Z");
    const replacement = new Date("2026-08-02T15:30:00.000Z");
    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
      lastAccessedAt: initial,
    });

    let firstUpdateStarted!: () => void;
    const firstUpdate = new Promise<void>((resolve) => {
      firstUpdateStarted = resolve;
    });
    let releaseFirstUpdate!: () => void;
    const firstUpdateRelease = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const originalUpdateMemory = runtime.updateMemory.bind(runtime);
    const updateMemory = vi.spyOn(runtime, "updateMemory").mockImplementation(async (memory) => {
      firstUpdateStarted();
      await firstUpdateRelease;
      await originalUpdateMemory(memory);
    });

    const contentUpdate = service.updateLongTermMemory(stored.id, agentId, entityId, {
      content: "Updated memory",
    });
    await firstUpdate;
    const explicitUpdate = service.updateLongTermMemory(stored.id, agentId, entityId, {
      lastAccessedAt: replacement,
    });
    releaseFirstUpdate();
    await Promise.all([contentUpdate, explicitUpdate]);
    updateMemory.mockRestore();

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.content).toBe("Updated memory");
    expect(updated?.lastAccessedAt?.toISOString()).toBe(replacement.toISOString());
  });

  it("applies the explicit access timestamp from each serialized update", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const older = new Date("2026-08-02T15:30:00.000Z");
    const newer = new Date("2026-08-03T09:45:00.000Z");
    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
    });

    await Promise.all([
      service.updateLongTermMemory(stored.id, agentId, entityId, {
        lastAccessedAt: newer,
      }),
      service.updateLongTermMemory(stored.id, agentId, entityId, {
        lastAccessedAt: older,
      }),
    ]);

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.lastAccessedAt?.toISOString()).toBe(older.toISOString());
  });

  it("maintains strict total ordering when updatedAt or createdAt contain invalid dates", async () => {
    const service = new AdvancedMemoryStorageService();
    const sorted = (service as any).sortLongTermMemories([
      {
        id: "mem-valid",
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        confidence: 0.9,
      },
      {
        id: "mem-invalid",
        updatedAt: new Date("invalid-date"),
        createdAt: new Date("invalid-date"),
        confidence: 0.5,
      },
    ]);

    expect(sorted).toHaveLength(2);
    expect(sorted[0]?.id).toBe("mem-valid");
    expect(sorted[1]?.id).toBe("mem-invalid");
  });
});
