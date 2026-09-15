/**
 * `AdvancedMemoryStorageService` implements the runtime's `MemoryStorageProvider`
 * on top of ordinary agent memories, storing long-term memories as regular
 * `Memory` rows (tagged via an `advancedMemory` envelope
 * in `metadata`) in dedicated synthetic rooms rather than separate tables.
 *
 * Long-term memories are anchored to an "identity group" resolved through the
 * optional `entity_resolution` service: entities confirmed-linked to the same
 * person share one long-term-memory room (keyed by the lexicographically
 * smallest entity ID in the group), so memories written under any alias in the
 * group are visible from all of them. Reads exhaust and verify the complete
 * ordered storage snapshot before applying an explicitly requested limit.
 */
import {
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  type Memory,
  type MemoryMetadata,
  type MemoryStorageProvider,
  type Room,
  Service,
  type ServiceTypeName,
  type UUID,
  type World,
} from "@elizaos/core";
import { stringToUuid } from "../utils/string-to-uuid";

/** Plugin-registered service; widen core ServiceTypeName for dynamic keys. */
const ENTITY_RESOLUTION_SERVICE = "entity_resolution" as ServiceTypeName;

type LongTermMemoryRecord = Awaited<ReturnType<MemoryStorageProvider["storeLongTermMemory"]>>;
type LongTermMemoryInput = Parameters<MemoryStorageProvider["storeLongTermMemory"]>[0];
type LongTermMemoryCategory = LongTermMemoryRecord["category"];
type UnknownRecord = Record<string, unknown>;
type JsonRecord = Record<string, JsonValue>;

type EntityLink = {
  entityA: UUID;
  entityB: UUID;
  status?: string;
};

type EntityResolutionService = {
  getConfirmedLinks: (entityId: UUID) => Promise<EntityLink[]>;
};

function isEntityResolutionService(service: unknown): service is EntityResolutionService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { getConfirmedLinks?: unknown }).getConfirmedLinks === "function"
  );
}

type AdvancedMemoryEnvelope = {
  kind: "long_term_memory";
  originalEntityId?: UUID;
  anchorEntityId?: UUID;
  category?: LongTermMemoryCategory;
  confidence?: number;
  source?: string;
  semanticMetadata?: JsonRecord;
  updatedAt?: string;
  lastAccessedAt?: string;
  accessCount?: number;
};

const LONG_TERM_MEMORY_TABLE = "long_term_memories";
const ADVANCED_MEMORY_SOURCE = "advanced-memory";
const memoryUpdateQueues = new WeakMap<object, Map<UUID, Promise<void>>>();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => toJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .map(([key, entry]) => {
        const jsonValue = toJsonValue(entry);
        return jsonValue === undefined ? null : ([key, jsonValue] as const);
      })
      .filter((entry): entry is readonly [string, JsonValue] => entry !== null);
    return Object.fromEntries(entries) as JsonRecord;
  }

  return undefined;
}

function toJsonRecord(value: unknown): JsonRecord | undefined {
  const jsonValue = toJsonValue(value);
  return isRecord(jsonValue) ? (jsonValue as JsonRecord) : undefined;
}

function buildCustomMemoryMetadata(params: {
  scope: "shared" | "room";
  timestamp: number;
  source?: string;
  advancedMemory: JsonRecord;
  existing?: UnknownRecord | null;
}): MemoryMetadata {
  const metadata: MemoryMetadata = {
    ...(params.existing ?? {}),
    type: "custom",
    scope: params.scope,
    timestamp: params.timestamp,
    advancedMemory: params.advancedMemory,
  };

  if (params.source) {
    metadata.source = params.source;
  }

  return metadata;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toDate(value: unknown, fallback?: Date): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return fallback ?? new Date();
}

function getMemoryText(memory: Memory): string {
  return typeof memory.content.text === "string" ? memory.content.text : "";
}

function getAdvancedMemoryEnvelope(memory: Memory): AdvancedMemoryEnvelope | null {
  const metadata = asRecord(memory.metadata);
  const advancedMemory = asRecord(metadata?.advancedMemory);
  if (!advancedMemory) {
    return null;
  }
  const kind = asString(advancedMemory.kind);
  if (kind !== "long_term_memory") {
    return null;
  }

  return {
    kind,
    originalEntityId: asString(advancedMemory.originalEntityId) as UUID | undefined,
    anchorEntityId: asString(advancedMemory.anchorEntityId) as UUID | undefined,
    category: asString(advancedMemory.category) as LongTermMemoryCategory | undefined,
    confidence: asNumber(advancedMemory.confidence),
    source: asString(advancedMemory.source),
    semanticMetadata: toJsonRecord(advancedMemory.semanticMetadata),
    updatedAt: asString(advancedMemory.updatedAt),
    lastAccessedAt: asString(advancedMemory.lastAccessedAt),
    accessCount: asNumber(advancedMemory.accessCount),
  };
}

export class AdvancedMemoryStorageService extends Service implements MemoryStorageProvider {
  static serviceType = "memoryStorage" as const;
  readonly supportsIdempotentWrites = true;

  capabilityDescription = "Persistent advanced-memory storage backed by SQL memory tables";

  private async serializeUpdate<T>(id: UUID, update: () => Promise<T>): Promise<T> {
    const runtimeKey = this.runtime as object;
    let queues = memoryUpdateQueues.get(runtimeKey);
    if (!queues) {
      queues = new Map<UUID, Promise<void>>();
      memoryUpdateQueues.set(runtimeKey, queues);
    }
    const previous = queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(id, current);
    await previous;
    try {
      return await update();
    } finally {
      release();
      if (queues.get(id) === current) {
        queues.delete(id);
      }
    }
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
  }

  async stop(): Promise<void> {}

  private getMemoryWorldId(): UUID {
    return stringToUuid(`advanced-memory:world:${this.runtime.agentId}`);
  }

  private getLongTermRoomId(entityId: UUID): UUID {
    return stringToUuid(`advanced-memory:long-term:${this.runtime.agentId}:${entityId}`);
  }

  private async ensureMemoryWorld(): Promise<UUID> {
    const worldId = this.getMemoryWorldId();
    const world: World = {
      id: worldId,
      agentId: this.runtime.agentId,
      name: "Advanced Memory",
      metadata: {
        purpose: ADVANCED_MEMORY_SOURCE,
      },
      createdAt: new Date(),
    } as World & { createdAt: Date };
    await this.runtime.ensureWorldExists(world);
    return worldId;
  }

  private async ensureLongTermRoom(entityId: UUID, worldId: UUID): Promise<UUID> {
    const roomId = this.getLongTermRoomId(entityId);
    const room: Room = {
      id: roomId,
      agentId: this.runtime.agentId,
      worldId,
      source: ADVANCED_MEMORY_SOURCE,
      type: ChannelType.SELF,
      name: `Advanced Memory ${entityId}`,
      metadata: {
        purpose: "long_term_memory",
        entityId,
      },
      createdAt: new Date(),
    } as Room & { createdAt: Date };
    await this.runtime.ensureRoomExists(room);
    return roomId;
  }

  private async getEntityResolutionService(): Promise<EntityResolutionService | null> {
    const existing = this.runtime.getService(ENTITY_RESOLUTION_SERVICE);
    if (isEntityResolutionService(existing)) {
      return existing;
    }
    if (!this.runtime.hasService(ENTITY_RESOLUTION_SERVICE)) {
      return null;
    }
    // error-policy:J4 optional-collaborator probe — null is the designed
    // "resolution service unavailable" signal; getIdentityGroup then degrades to
    // a single-entity group. This is an optional enhancement, not a required dep.
    try {
      const loaded = await this.runtime.getServiceLoadPromise(ENTITY_RESOLUTION_SERVICE);
      return isEntityResolutionService(loaded) ? loaded : null;
    } catch {
      return null;
    }
  }

  private async getIdentityGroup(entityId: UUID): Promise<Set<UUID>> {
    const resolution = await this.getEntityResolutionService();
    if (!resolution) {
      return new Set<UUID>([entityId]);
    }

    const group = new Set<UUID>([entityId]);
    const queue: UUID[] = [entityId];

    while (queue.length > 0) {
      const current = queue.shift() as UUID;
      const links = await resolution.getConfirmedLinks(current);
      for (const link of links) {
        const other = link.entityA === current ? link.entityB : link.entityA;
        if (!group.has(other)) {
          group.add(other);
          queue.push(other);
        }
      }
    }

    return group;
  }

  private async getAnchorEntityId(entityId: UUID): Promise<UUID> {
    const group = await this.getIdentityGroup(entityId);
    return Array.from(group).sort()[0] as UUID;
  }

  private parseLongTermMemory(memory: Memory): LongTermMemoryRecord | null {
    const envelope = getAdvancedMemoryEnvelope(memory);
    if (envelope?.kind !== "long_term_memory" || !memory.id || !memory.agentId) {
      return null;
    }

    return {
      id: memory.id,
      agentId: memory.agentId,
      entityId: envelope.originalEntityId ?? envelope.anchorEntityId ?? (memory.entityId as UUID),
      category: (envelope.category ?? "semantic") as LongTermMemoryCategory,
      content: getMemoryText(memory),
      metadata: envelope.semanticMetadata,
      embedding: Array.isArray(memory.embedding) ? memory.embedding : undefined,
      confidence: envelope.confidence,
      source: envelope.source,
      createdAt: toDate(memory.createdAt),
      updatedAt: toDate(envelope.updatedAt, toDate(memory.createdAt)),
      lastAccessedAt: envelope.lastAccessedAt ? toDate(envelope.lastAccessedAt) : undefined,
      accessCount: envelope.accessCount ?? 0,
    };
  }

  private sortLongTermMemories(memories: LongTermMemoryRecord[]): LongTermMemoryRecord[] {
    return [...memories].sort((left, right) => {
      const leftUpdated = Number.isFinite(left.updatedAt.getTime()) ? left.updatedAt.getTime() : 0;
      const rightUpdated = Number.isFinite(right.updatedAt.getTime())
        ? right.updatedAt.getTime()
        : 0;
      if (rightUpdated !== leftUpdated) {
        return rightUpdated - leftUpdated;
      }
      const leftConfidence = Number.isFinite(left.confidence) ? (left.confidence as number) : 0;
      const rightConfidence = Number.isFinite(right.confidence) ? (right.confidence as number) : 0;
      if (rightConfidence !== leftConfidence) {
        return rightConfidence - leftConfidence;
      }
      const leftCreated = Number.isFinite(left.createdAt.getTime()) ? left.createdAt.getTime() : 0;
      const rightCreated = Number.isFinite(right.createdAt.getTime())
        ? right.createdAt.getTime()
        : 0;
      return rightCreated - leftCreated;
    });
  }

  async storeLongTermMemory(memory: LongTermMemoryInput): Promise<LongTermMemoryRecord> {
    if (memory.agentId !== this.runtime.agentId) {
      throw new ElizaError("Long-term memory belongs to a different agent", {
        code: "LONG_TERM_MEMORY_ID_CONFLICT",
      });
    }
    if (memory.id) {
      const existing = await this.runtime.getMemoryById(memory.id);
      if (existing) {
        const parsed = this.parseLongTermMemory(existing);
        const allowedGroup = await this.getIdentityGroup(memory.entityId);
        if (
          !parsed ||
          existing.agentId !== this.runtime.agentId ||
          !allowedGroup.has(parsed.entityId)
        ) {
          throw new ElizaError("Long-term memory ID belongs to a different record", {
            code: "LONG_TERM_MEMORY_ID_CONFLICT",
          });
        }
        return parsed;
      }
    }
    const now = new Date();
    const anchorEntityId = await this.getAnchorEntityId(memory.entityId);
    const worldId = await this.ensureMemoryWorld();
    const roomId = await this.ensureLongTermRoom(anchorEntityId, worldId);
    const advancedMemory = toJsonRecord({
      kind: "long_term_memory",
      originalEntityId: memory.entityId,
      anchorEntityId,
      category: memory.category,
      confidence: memory.confidence,
      source: memory.source,
      semanticMetadata: memory.metadata,
      updatedAt: now.toISOString(),
      lastAccessedAt: memory.lastAccessedAt?.toISOString(),
      accessCount: 0,
    });
    if (!advancedMemory) {
      throw new Error("Long-term memory metadata is not JSON-serializable");
    }
    const id = await this.runtime.createMemory(
      {
        ...(memory.id ? { id: memory.id } : {}),
        agentId: this.runtime.agentId,
        entityId: anchorEntityId,
        roomId,
        worldId,
        content: { text: memory.content },
        metadata: buildCustomMemoryMetadata({
          scope: "shared",
          timestamp: now.getTime(),
          source: memory.source,
          advancedMemory,
        }),
        embedding: memory.embedding,
        createdAt: now.getTime(),
        unique: false,
      },
      LONG_TERM_MEMORY_TABLE,
      false
    );

    const stored = await this.runtime.getMemoryById(id);
    const parsed = stored ? this.parseLongTermMemory(stored) : null;
    if (!parsed || stored?.agentId !== this.runtime.agentId) {
      throw new Error("Failed to persist long-term memory");
    }
    // The insert is ON CONFLICT DO NOTHING: validate ownership again if a
    // concurrent writer won the supplied ID, rather than exposing its row.
    const allowedGroup = await this.getIdentityGroup(memory.entityId);
    if (!allowedGroup.has(parsed.entityId)) {
      throw new ElizaError("Long-term memory ID belongs to a different record", {
        code: "LONG_TERM_MEMORY_ID_CONFLICT",
      });
    }
    return parsed;
  }

  async getLongTermMemories(
    agentId: UUID,
    entityId: UUID,
    opts?: { category?: LongTermMemoryCategory; limit?: number }
  ): Promise<LongTermMemoryRecord[]> {
    const group = await this.getIdentityGroup(entityId);
    const roomIds = Array.from(group).map((memberEntityId) =>
      this.getLongTermRoomId(memberEntityId)
    );
    if (roomIds.length === 0) {
      return [];
    }

    const memories = await this.readCompleteLongTermMemoryRows(roomIds);

    const filtered = memories
      .filter((memory) => memory.agentId === agentId)
      .map((memory) => this.parseLongTermMemory(memory))
      .filter((memory): memory is LongTermMemoryRecord => memory !== null)
      .filter((memory) => (opts?.category ? memory.category === opts.category : true));

    const sorted = this.sortLongTermMemories(filtered);
    return opts?.limit === undefined ? sorted : sorted.slice(0, opts.limit);
  }

  private async traverseLongTermMemoryRows(roomIds: UUID[]): Promise<Memory[]> {
    const pageSize = 200;
    const rows: Memory[] = [];
    const seenIds = new Set<UUID>();
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.runtime.getMemoriesByRoomIds({
        tableName: LONG_TERM_MEMORY_TABLE,
        roomIds,
        limit: pageSize,
        offset,
      });
      const ids = page.flatMap((memory) => (memory.id ? [memory.id] : []));
      if (
        page.length === pageSize &&
        ids.length === page.length &&
        ids.every((id) => seenIds.has(id))
      ) {
        throw new ElizaError("Long-term memory pagination made no progress", {
          code: "LONG_TERM_MEMORY_PAGINATION_STALLED",
          context: { offset, pageSize },
          severity: "fatal",
        });
      }
      for (const id of ids) seenIds.add(id);
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  private async readCompleteLongTermMemoryRows(roomIds: UUID[]): Promise<Memory[]> {
    const first = await this.traverseLongTermMemoryRows(roomIds);
    const verified = await this.traverseLongTermMemoryRows(roomIds);
    const firstIds = first.map((memory) => memory.id);
    const verifiedIds = verified.map((memory) => memory.id);
    if (JSON.stringify(firstIds) !== JSON.stringify(verifiedIds)) {
      throw new ElizaError("Long-term memory changed during complete traversal", {
        code: "LONG_TERM_MEMORY_SNAPSHOT_UNSTABLE",
        context: { firstCount: first.length, verifiedCount: verified.length },
      });
    }
    return verified;
  }

  async updateLongTermMemory(
    id: UUID,
    agentId: UUID,
    entityId: UUID,
    updates: Partial<Omit<LongTermMemoryRecord, "id" | "agentId" | "entityId" | "createdAt">>
  ): Promise<void> {
    return this.serializeUpdate(id, async () => {
      const existing = await this.runtime.getMemoryById(id);
      const parsed = existing ? this.parseLongTermMemory(existing) : null;
      if (!existing || !parsed || existing.agentId !== agentId) {
        throw new Error(`Long-term memory ${id} not found`);
      }

      const allowedGroup = await this.getIdentityGroup(entityId);
      if (!allowedGroup.has(parsed.entityId)) {
        throw new Error(`Long-term memory ${id} does not belong to entity ${entityId}`);
      }

      const currentEnvelope = getAdvancedMemoryEnvelope(existing);
      const updatedAt = new Date();
      const advancedMemory = toJsonRecord({
        ...(currentEnvelope ?? {}),
        kind: "long_term_memory",
        originalEntityId: currentEnvelope?.originalEntityId ?? entityId,
        anchorEntityId: parsed.entityId,
        category: updates.category ?? parsed.category,
        confidence: updates.confidence ?? parsed.confidence,
        source: updates.source ?? parsed.source,
        semanticMetadata: updates.metadata ?? parsed.metadata,
        updatedAt: updatedAt.toISOString(),
        lastAccessedAt: (updates.lastAccessedAt ?? parsed.lastAccessedAt)?.toISOString(),
        accessCount: updates.accessCount ?? parsed.accessCount ?? 0,
      });
      if (!advancedMemory) {
        throw new Error("Updated long-term memory metadata is not JSON-serializable");
      }
      await this.runtime.updateMemory({
        id,
        content: {
          text: updates.content ?? parsed.content,
        },
        metadata: buildCustomMemoryMetadata({
          existing: asRecord(existing.metadata),
          scope: "shared",
          timestamp: updatedAt.getTime(),
          source: updates.source ?? parsed.source,
          advancedMemory,
        }),
        ...(updates.embedding ? { embedding: updates.embedding } : {}),
      });
    });
  }

  async deleteLongTermMemory(id: UUID, agentId: UUID, entityId: UUID): Promise<void> {
    const existing = await this.runtime.getMemoryById(id);
    const parsed = existing ? this.parseLongTermMemory(existing) : null;
    if (!existing || !parsed || existing.agentId !== agentId) {
      throw new Error(`Long-term memory ${id} not found`);
    }
    const allowedGroup = await this.getIdentityGroup(entityId);
    if (!allowedGroup.has(parsed.entityId)) {
      throw new Error(`Long-term memory ${id} does not belong to entity ${entityId}`);
    }
    await this.runtime.deleteMemory(id);
  }
}
