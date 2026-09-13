/**
 * Compares document authorization, search, mutation snapshots, cursor bounds,
 * and production query plans across real PGlite/Postgres and in-memory storage.
 */
import {
  ChannelType,
  type DocumentListCursor,
  type DocumentListQueryParams,
  type Entity,
  InMemoryDatabaseAdapter,
  type Memory,
  MemoryType,
  type Room,
  readDocumentMutationSnapshot,
  type UUID,
  type World,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const REQUESTER_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const OTHER_ENTITY_ID = "10000000-0000-0000-0000-000000000002" as UUID;
const DIRECT_GRANTEE_ID = "10000000-0000-0000-0000-000000000003" as UUID;
const postgresIt = process.env.POSTGRES_URL ? it : it.skip;

describe("document list query (real SQL parity)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  let roomId: UUID;
  let worldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("document_list_query");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
    worldId = v4() as UUID;
    roomId = v4() as UUID;

    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "Document query world",
      serverId: "document-query",
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "documents",
        source: "test",
        type: ChannelType.DM,
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: REQUESTER_ID,
        agentId,
        names: ["Requester"],
      } as Entity,
      {
        id: OTHER_ENTITY_ID,
        agentId,
        names: ["Other"],
      } as Entity,
      {
        id: DIRECT_GRANTEE_ID,
        agentId,
        names: ["Direct grantee"],
      } as Entity,
    ]);
    await adapter.addParticipant(REQUESTER_ID, roomId);
    await adapter.addParticipant(OTHER_ENTITY_ID, roomId);
  }, 120_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  function document(
    index: number,
    overrides: Partial<Memory> & { metadata?: Record<string, unknown> } = {}
  ): Memory {
    const { metadata, ...memoryOverrides } = overrides;
    const id = `30000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
    return {
      id,
      agentId,
      entityId: REQUESTER_ID,
      roomId,
      worldId,
      createdAt: 10_000,
      content: { text: `Document body ${index}` },
      metadata: {
        type: MemoryType.DOCUMENT,
        documentId: id,
        title: `Document ${index}`,
        scope: "global",
        timestamp: 10_000,
        tags: ["archive"],
        ...metadata,
      },
      ...memoryOverrides,
    };
  }

  async function seedSql(documents: Memory[]): Promise<void> {
    await adapter.createMemories(documents.map((memory) => ({ memory, tableName: "documents" })));
  }

  async function seedInMemory(documents: Memory[]): Promise<InMemoryDatabaseAdapter> {
    const inMemory = new InMemoryDatabaseAdapter();
    await inMemory.initialize();
    // Mirror SQL setup so isolation reads compare the same room membership.
    await inMemory.createRoomParticipants([REQUESTER_ID, OTHER_ENTITY_ID], roomId);
    await inMemory.createMemories(documents.map((memory) => ({ memory, tableName: "documents" })));
    return inMemory;
  }

  const ids = (memories: Memory[]): UUID[] =>
    memories.map((memory) => memory.id).filter((id): id is UUID => typeof id === "string");

  it("keeps entityId as isolation context instead of a row predicate", async () => {
    const documents = [document(1), document(2, { entityId: OTHER_ENTITY_ID })];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);

    const sqlRows = await adapter.getMemories({
      tableName: "documents",
      agentId,
      entityId: REQUESTER_ID,
      includeEmbedding: false,
    });
    const inMemoryRows = await inMemory.getMemories({
      tableName: "documents",
      agentId,
      entityId: REQUESTER_ID,
      includeEmbedding: false,
    });

    expect(ids(sqlRows)).toEqual(ids(inMemoryRows));
    expect(new Set(ids(sqlRows))).toEqual(new Set(ids(documents)));
  });

  it("matches visibility, filters, counts, and fallback pages across adapters", async () => {
    const documents = [
      document(1),
      document(2, {
        metadata: {
          scope: "user-private",
          scopedToEntityId: REQUESTER_ID,
        },
      }),
      document(3, {
        entityId: OTHER_ENTITY_ID,
        metadata: {
          scope: "user-private",
          scopedToEntityId: OTHER_ENTITY_ID,
        },
      }),
      document(4, { metadata: { scope: "owner-private" } }),
      document(5, { metadata: { scope: "agent-private" } }),
    ];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "USER",
      query: "missing",
      limit: 1,
      offset: 0,
    };
    const withEntityContext = vi.spyOn(
      adapter as unknown as {
        withEntityContext: (
          entityId: UUID | null,
          callback: (tx: unknown) => Promise<unknown>
        ) => Promise<unknown>;
      },
      "withEntityContext"
    );

    const sqlResult = await adapter.queryDocuments(params);
    const inMemoryResult = await inMemory.queryDocuments(params);

    expect(withEntityContext).toHaveBeenCalledWith(REQUESTER_ID, expect.any(Function));
    expect(sqlResult).toMatchObject({
      totalVisible: 2,
      totalAvailable: 2,
      totalMatched: 0,
      documents: [],
      availableHasMore: true,
    });
    expect(sqlResult.availableNextCursor).toBeDefined();
    expect(ids(sqlResult.availableDocuments)).toEqual(ids(inMemoryResult.availableDocuments));
    expect(sqlResult).toEqual(inMemoryResult);

    const secondSqlPage = await adapter.queryDocuments({
      ...params,
      offset: 1,
    });
    const secondInMemoryPage = await inMemory.queryDocuments({
      ...params,
      offset: 1,
    });
    expect(secondSqlPage).toMatchObject({
      totalAvailable: 2,
      availableHasMore: false,
    });
    expect(secondSqlPage).toEqual(secondInMemoryPage);
    expect(ids(secondSqlPage.availableDocuments)).not.toEqual(ids(sqlResult.availableDocuments));

    const cursorSqlPage = await adapter.queryDocuments({
      ...params,
      cursor: sqlResult.availableNextCursor,
    });
    expect(cursorSqlPage.availableDocuments).toEqual(secondSqlPage.availableDocuments);
    expect(cursorSqlPage.availableHasMore).toBe(false);

    const ownerResult = await adapter.queryDocuments({
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "OWNER",
      limit: 10,
      offset: 0,
    });
    expect(ownerResult).toMatchObject({
      totalVisible: 5,
      totalAvailable: 5,
      totalMatched: 5,
    });
  });

  it("keeps OWNER, RUNTIME, and AGENT global while USER remains room-limited", async () => {
    const otherRoomId = v4() as UUID;
    await adapter.createRooms([
      {
        id: otherRoomId,
        agentId,
        worldId,
        name: "other-documents",
        source: "test",
        type: ChannelType.DM,
      } as Room,
    ]);
    const documents = [document(1), document(2, { roomId: otherRoomId })];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const baseParams: Omit<DocumentListQueryParams, "requesterRole"> = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      limit: 10,
      offset: 0,
    };

    const userSql = await adapter.queryDocuments({ ...baseParams, requesterRole: "USER" });
    const userMemory = await inMemory.queryDocuments({ ...baseParams, requesterRole: "USER" });
    expect(userSql).toEqual(userMemory);
    expect(ids(userSql.documents)).toEqual([documents[0]?.id]);

    for (const requesterRole of ["OWNER", "RUNTIME", "AGENT"] as const) {
      const roleParams = {
        ...baseParams,
        requesterRoomIds: [],
        requesterRole,
      };
      const sqlResult = await adapter.queryDocuments(roleParams);
      const memoryResult = await inMemory.queryDocuments(roleParams);
      expect(sqlResult).toEqual(memoryResult);
      expect(new Set(ids(sqlResult.documents))).toEqual(new Set(ids(documents)));
      expect(sqlResult.totalVisible).toBe(2);
    }
  });

  it("keeps GUEST room-global and UNRESOLVED fail-closed across SQL and memory", async () => {
    const documents = [
      document(1),
      document(2, {
        metadata: {
          scope: "user-private",
          scopedToEntityId: REQUESTER_ID,
        },
      }),
    ];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const baseParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      limit: 10,
      offset: 0,
    };

    for (const requesterRole of ["GUEST", "UNRESOLVED"] as const) {
      const roleParams = { ...baseParams, requesterRole };
      const sqlResult = await adapter.queryDocuments(roleParams);
      const memoryResult = await inMemory.queryDocuments(roleParams);
      expect(sqlResult).toEqual(memoryResult);
      expect(ids(sqlResult.documents)).toEqual(requesterRole === "GUEST" ? [documents[0]?.id] : []);
    }
  });

  it("authorizes direct grants outside current rooms before list and fragment construction", async () => {
    const otherRoomId = v4() as UUID;
    await adapter.createRooms([
      {
        id: otherRoomId,
        agentId,
        worldId,
        name: "direct-grant-room",
        source: "test",
        type: ChannelType.DM,
      } as Room,
    ]);
    const granted = document(20, {
      roomId: otherRoomId,
      metadata: {
        scope: "owner-private",
        directGrantEntityIds: [REQUESTER_ID],
      },
    });
    const agentOnly = document(21, {
      roomId: otherRoomId,
      metadata: {
        scope: "agent-private",
        directGrantEntityIds: [REQUESTER_ID],
      },
    });
    const fragment = document(22, {
      roomId: otherRoomId,
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: granted.id,
        documentRevision: 0,
        position: 0,
      },
    });
    await seedSql([granted, agentOnly]);
    await adapter.createMemories([{ memory: fragment, tableName: "document_fragments" }]);
    const inMemory = await seedInMemory([granted, agentOnly]);
    await inMemory.createMemories([{ memory: fragment, tableName: "document_fragments" }]);
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [],
      requesterRole: "USER" as const,
    };

    const sqlDocuments = await adapter.queryDocuments({ ...context, limit: 10, offset: 0 });
    const memoryDocuments = await inMemory.queryDocuments({ ...context, limit: 10, offset: 0 });
    expect(sqlDocuments).toEqual(memoryDocuments);
    expect(ids(sqlDocuments.documents)).toEqual([granted.id]);
    expect(await adapter.getDocument({ ...context, documentId: granted.id as UUID })).toMatchObject(
      {
        id: granted.id,
      }
    );
    expect(
      ids(
        await adapter.queryDocumentFragments({
          ...context,
          documentId: granted.id as UUID,
          limit: 10,
        })
      )
    ).toEqual([fragment.id as UUID]);
    expect(
      await adapter.queryDocuments({ ...context, requesterRole: "GUEST", limit: 10, offset: 0 })
    ).toEqual(
      await inMemory.queryDocuments({
        ...context,
        requesterRole: "GUEST",
        limit: 10,
        offset: 0,
      })
    );
  });

  it("shares only the selected document with a guest and removes every read path on revocation", async () => {
    const shared = document(71, { metadata: { scope: "owner-private" } });
    const privateSibling = document(72, { metadata: { scope: "owner-private" } });
    const fragment = document(73, {
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: shared.id,
        documentRevision: 0,
        position: 0,
      },
    });
    await seedSql([shared, privateSibling]);
    const inMemory = await seedInMemory([shared, privateSibling]);
    await inMemory.createEntities([{ id: DIRECT_GRANTEE_ID, agentId, names: ["Guest"] }]);
    const owner = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [] as UUID[],
      requesterRole: "OWNER" as const,
    };
    const guest = {
      ...owner,
      requesterEntityId: DIRECT_GRANTEE_ID,
      requesterRole: "GUEST" as const,
    };
    for (const store of [adapter, inMemory]) {
      await store.createMemories([{ memory: fragment, tableName: "document_fragments" }]);
      const list = () => store.queryDocuments({ ...guest, limit: 10, offset: 0 });
      const get = () => store.getDocument({ ...guest, documentId: shared.id! });
      const fragments = () =>
        store.queryDocumentFragments({ ...guest, documentId: shared.id!, limit: 10 });
      expect((await list()).documents).toEqual([]);
      const grant = await store.updateDocumentDirectGrants({
        ...owner,
        documentId: shared.id!,
        expected: readDocumentMutationSnapshot(shared)!,
        directGrantEntityIds: [DIRECT_GRANTEE_ID],
      });
      expect(grant.status).toBe("updated");
      const visible = await list();
      expect(ids(visible.documents)).toEqual([shared.id]);
      expect(visible.totalVisible).toBe(1);
      expect(await get()).toMatchObject({ id: shared.id });
      expect(ids(await fragments())).toEqual([fragment.id]);
      const current = await get();
      const expected = readDocumentMutationSnapshot(current!)!;
      await expect(
        store.updateDocumentDirectGrants({
          ...guest,
          documentId: shared.id!,
          expected,
          directGrantEntityIds: [OTHER_ENTITY_ID],
        })
      ).resolves.toEqual({ status: "forbidden" });
      expect(
        await store.getDocument({ ...guest, requesterRole: "UNRESOLVED", documentId: shared.id! })
      ).toBeNull();
      expect(
        await store.getDocument({
          ...guest,
          requesterEntityId: OTHER_ENTITY_ID,
          documentId: shared.id!,
        })
      ).toBeNull();
      await expect(
        store.updateDocumentDirectGrants({
          ...owner,
          documentId: shared.id!,
          expected,
          directGrantEntityIds: [],
        })
      ).resolves.toMatchObject({ status: "updated" });
      expect((await list()).documents).toEqual([]);
      expect((await list()).totalVisible).toBe(0);
      expect(await get()).toBeNull();
      expect(await fragments()).toEqual([]);
    }
  });

  it("filters fragment pages by exact authorized parent before pagination", async () => {
    const firstParent = document(1);
    const secondParent = document(2);
    const fragment = (index: number, documentId: UUID, createdAt: number): Memory =>
      document(index, {
        createdAt,
        metadata: {
          type: MemoryType.FRAGMENT,
          documentId,
          documentRevision: 0,
          position: index,
        },
      });
    const firstFragments = [
      fragment(3, firstParent.id as UUID, 3_000),
      fragment(4, firstParent.id as UUID, 2_000),
    ];
    const otherFragment = fragment(5, secondParent.id as UUID, 4_000);
    const rows = [firstParent, secondParent, ...firstFragments, otherFragment];
    await seedSql([firstParent, secondParent]);
    await adapter.createMemories(
      [...firstFragments, otherFragment].map((memory) => ({
        memory,
        tableName: "document_fragments",
      }))
    );
    const inMemory = await seedInMemory(rows);
    const query = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "OWNER" as const,
      documentId: firstParent.id,
      limit: 1,
      offset: 1,
    };

    const sqlFragments = await adapter.queryDocumentFragments(query);
    const memoryFragments = await inMemory.queryDocumentFragments(query);

    expect(sqlFragments).toEqual(memoryFragments);
    expect(ids(sqlFragments)).toEqual([firstFragments[1]?.id]);
  });

  it("does not skip or duplicate equal-timestamp rows across keyset pages", async () => {
    const documents = Array.from({ length: 151 }, (_, index) => document(index));
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const baseParams: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 37,
      offset: 0,
    };

    const collect = async (
      query: (
        params: DocumentListQueryParams
      ) => Promise<{ documents: Memory[]; hasMore: boolean; nextCursor?: DocumentListCursor }>
    ): Promise<UUID[]> => {
      const seen: UUID[] = [];
      let cursor: DocumentListCursor | undefined;
      do {
        const page = await query({
          ...baseParams,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...ids(page.documents));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        expect(cursor).toBeDefined();
      } while (cursor);
      return seen;
    };

    const sqlIds = await collect((params) => adapter.queryDocuments(params));
    const inMemoryIds = await collect((params) => inMemory.queryDocuments(params));

    expect(sqlIds).toHaveLength(151);
    expect(new Set(sqlIds).size).toBe(151);
    expect(sqlIds).toEqual(inMemoryIds);
  }, 30_000);

  it("normalizes microsecond database timestamps before applying keyset cursors", async () => {
    const documents = [document(1), document(2), document(3)];
    await seedSql(documents);
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.execute(
      sql`UPDATE ${memoryTable}
          SET created_at = CASE id
            WHEN ${documents[0]?.id}::uuid THEN '2026-01-01 00:00:00.123900'::timestamp
            WHEN ${documents[1]?.id}::uuid THEN '2026-01-01 00:00:00.123800'::timestamp
            ELSE '2026-01-01 00:00:00.123700'::timestamp
          END`
    );
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 1,
      offset: 0,
    };
    const seen: UUID[] = [];
    let cursor: DocumentListCursor | undefined;
    do {
      const page = await adapter.queryDocuments({
        ...params,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(page.documents));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor);

    expect(seen).toEqual(ids(documents).sort((left, right) => right.localeCompare(left)));
    expect(new Set(seen).size).toBe(3);
  });

  it("excludes fragments stored in the documents table across adapters", async () => {
    const canonical = document(1);
    const fragment = document(2, {
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: canonical.id,
        position: 0,
        timestamp: 10_000,
      },
    });
    await seedSql([canonical, fragment]);
    const inMemory = await seedInMemory([canonical, fragment]);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 10,
      offset: 0,
    };

    const sqlResult = await adapter.queryDocuments(params);
    const inMemoryResult = await inMemory.queryDocuments(params);

    expect(ids(sqlResult.documents)).toEqual([canonical.id]);
    expect(sqlResult).toEqual(inMemoryResult);
    expect(sqlResult.totalVisible).toBe(1);
  });

  it("keeps each count and page coherent while writes race the query", async () => {
    await seedSql(Array.from({ length: 10 }, (_, index) => document(index)));
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 100,
      offset: 0,
    };

    const reads = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const [result] = await Promise.all([
          adapter.queryDocuments(params),
          seedSql([document(100 + index)]),
        ]);
        return result;
      })
    );

    for (const result of reads) {
      expect(result.totalVisible).toBe(result.documents.length);
      expect(result.totalAvailable).toBe(result.documents.length);
      expect(result.totalMatched).toBe(result.documents.length);
      expect(result.hasMore).toBe(false);
    }
  });

  it("anchors cursor pages so newer concurrent inserts do not duplicate or skip the original set", async () => {
    const original = Array.from({ length: 10 }, (_, index) => document(index));
    await seedSql(original);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [],
      requesterRole: "RUNTIME",
      limit: 3,
      offset: 0,
    };
    const first = await adapter.queryDocuments(params);
    expect(first.nextCursor?.snapshotCreatedAt).toBeDefined();
    expect(first.nextCursor?.snapshotId).toBeDefined();
    await seedSql([document(100)]);

    const seen = [...ids(first.documents)];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await adapter.queryDocuments({ ...params, cursor });
      seen.push(...ids(page.documents));
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(original.length);
    expect(new Set(seen)).toEqual(new Set(ids(original)));
  });

  it("rejects unbounded offsets before issuing a database query", async () => {
    await expect(
      adapter.queryDocuments({
        agentId,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [roomId],
        requesterRole: "RUNTIME",
        limit: 10,
        offset: 10_001,
      })
    ).rejects.toMatchObject({
      code: "DOCUMENT_LIST_INVALID_PAGINATION",
    });
  });

  it("matches portable email, version, URL, punctuation, locale, and Unicode queries", async () => {
    const corpus = [
      document(1, { content: { text: "Contact Test.User+Tag@Example.COM today" } }),
      document(2, { content: { text: "Release v1.2.3 is stable" } }),
      document(3, { content: { text: "Visit https://Example.com/a?b=c#d now" } }),
      document(4, { content: { text: "C++ foo_bar don't stop" } }),
      document(5, { content: { text: "İstanbul 東京 café" } }),
    ];
    await seedSql(corpus);
    const inMemory = await seedInMemory(corpus);
    const cases: Array<[string, UUID]> = [
      ["test.user+tag@example.com", corpus[0]!.id!],
      ["V1.2.3", corpus[1]!.id!],
      ["https://example.com/a?b=c#d", corpus[2]!.id!],
      ["C++ foo_bar don't", corpus[3]!.id!],
      ["İstanbul 東京", corpus[4]!.id!],
    ];
    for (const [query, expectedId] of cases) {
      const params: DocumentListQueryParams = {
        agentId,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [],
        requesterRole: "RUNTIME",
        query,
        limit: 10,
        offset: 0,
      };
      const sqlResult = await adapter.queryDocuments(params);
      const memoryResult = await inMemory.queryDocuments(params);
      expect(ids(sqlResult.documents)).toEqual([expectedId]);
      expect(sqlResult).toEqual(memoryResult);
    }
    const partialEmail = await adapter.queryDocuments({
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [],
      requesterRole: "RUNTIME",
      query: "example",
      limit: 10,
      offset: 0,
    });
    expect(partialEmail.documents).toEqual([]);
  });

  it("fails closed consistently for malformed parent scopes and fragment metadata", async () => {
    const embedding = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
    const malformedParents = [
      document(1, { metadata: { scope: "public" } }),
      document(4, { metadata: { scope: "user-private" } }),
      document(5, { metadata: { addedBy: "not-a-uuid" } }),
      document(6, { metadata: { documentRevision: 1.5 } }),
      document(9, { metadata: { documentRevision: "1" } }),
      document(11, { metadata: { directGrantEntityIds: ["not-a-uuid"] } }),
      document(12, {
        metadata: { directGrantEntityIds: [REQUESTER_ID, REQUESTER_ID] },
      }),
    ];
    const validParent = document(2, {
      metadata: {
        scope: "user-private",
        scopedToEntityId: REQUESTER_ID,
      },
    });
    const hiddenParent = document(3, {
      metadata: {
        scope: "user-private",
        scopedToEntityId: OTHER_ENTITY_ID,
      },
    });
    const visibleFragment = document(7, {
      embedding,
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: validParent.id,
        position: 0,
        scope: "owner-private",
      },
    });
    const forgedFragment = document(8, {
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: hiddenParent.id,
        position: 0,
        scope: "global",
        scopedToEntityId: REQUESTER_ID,
      },
    });
    const staleFragment = document(10, {
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: validParent.id,
        position: 1,
        documentRevision: 1,
      },
    });
    await seedSql([...malformedParents, validParent, hiddenParent]);
    const inMemory = await seedInMemory([
      ...malformedParents,
      validParent,
      hiddenParent,
      visibleFragment,
      forgedFragment,
      staleFragment,
    ]);
    await adapter.createMemories(
      [visibleFragment, forgedFragment, staleFragment].map((memory) => ({
        memory,
        tableName: "document_fragments",
      }))
    );
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "USER" as const,
    };
    const listed = await adapter.queryDocuments({ ...context, limit: 10, offset: 0 });
    expect(ids(listed.documents)).toEqual([validParent.id]);
    expect(listed).toEqual(await inMemory.queryDocuments({ ...context, limit: 10, offset: 0 }));
    await expect(
      adapter.getDocument({ ...context, documentId: malformedParents[0]!.id! })
    ).resolves.toBeNull();
    const fragments = await adapter.queryDocumentFragments({ ...context, limit: 10 });
    expect(ids(fragments)).toEqual([visibleFragment.id]);
    expect(ids(fragments)).toEqual(
      ids(await inMemory.queryDocumentFragments({ ...context, limit: 10 }))
    );
    const vectorFragments = await adapter.queryDocumentFragments({
      ...context,
      embedding,
      limit: 10,
      matchThreshold: 0.5,
    });
    const inMemoryVectorFragments = await inMemory.queryDocumentFragments({
      ...context,
      embedding,
      limit: 10,
      matchThreshold: 0.5,
    });
    expect(ids(vectorFragments)).toEqual([visibleFragment.id]);
    expect(ids(vectorFragments)).toEqual(ids(inMemoryVectorFragments));
    expect(vectorFragments[0]?.similarity).toBeCloseTo(
      inMemoryVectorFragments[0]?.similarity ?? -1,
      6
    );
    await expect(
      adapter.queryDocumentFragments({
        ...context,
        embedding: [Number.NaN],
        limit: 10,
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_FRAGMENT_QUERY_INVALID" });

    for (const requesterRole of ["OWNER", "ADMIN"] as const) {
      const roleContext = {
        ...context,
        requesterRole,
        requesterRoomIds: requesterRole === "OWNER" ? [] : [roomId],
      };
      const sqlResult = await adapter.queryDocuments({
        ...roleContext,
        limit: 20,
        offset: 0,
      });
      const memoryResult = await inMemory.queryDocuments({
        ...roleContext,
        limit: 20,
        offset: 0,
      });
      expect(sqlResult).toEqual(memoryResult);
      expect(ids(sqlResult.documents)).not.toEqual(expect.arrayContaining(ids(malformedParents)));
    }
  });

  it("rejects update and delete after concurrent scope or owner changes", async () => {
    const original = document(1, {
      metadata: {
        scope: "user-private",
        scopedToEntityId: REQUESTER_ID,
        documentRevision: 0,
      },
    });
    await seedSql([original]);
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "USER" as const,
    };
    const observed = await adapter.getDocument({ ...context, documentId: original.id! });
    expect(observed).not.toBeNull();
    const snapshot = readDocumentMutationSnapshot(observed!);
    expect(snapshot).not.toBeNull();

    await adapter.updateMemories([
      {
        id: original.id!,
        metadata: {
          ...original.metadata,
          scope: "owner-private",
        },
      },
    ]);
    const replacement = { ...observed!, content: { text: "unauthorized replacement" } };
    await expect(
      adapter.compareAndSwapDocument({
        ...context,
        documentId: original.id!,
        expected: snapshot!,
        replacement,
      })
    ).resolves.toEqual({ status: "conflict" });

    await adapter.updateMemories([
      {
        id: original.id!,
        metadata: {
          ...original.metadata,
          scopedToEntityId: OTHER_ENTITY_ID,
        },
      },
    ]);
    await expect(
      adapter.deleteDocumentWithSnapshot({
        ...context,
        documentId: original.id!,
        expected: snapshot!,
      })
    ).resolves.toEqual({ status: "conflict" });
    await expect(adapter.getMemoryById(original.id!)).resolves.not.toBeNull();
  });

  it("atomically replaces direct grants under owner and current-room-admin authority", async () => {
    const global = document(41, { metadata: { documentRevision: 0 } });
    const ownerPrivate = document(42, {
      metadata: { scope: "owner-private", documentRevision: 0 },
    });
    await seedSql([global, ownerPrivate]);
    const ownerContext = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [] as UUID[],
      requesterRole: "OWNER" as const,
    };
    const adminContext = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "ADMIN" as const,
    };
    const globalSnapshot = readDocumentMutationSnapshot(global)!;

    await expect(
      adapter.updateDocumentDirectGrants({
        ...adminContext,
        documentId: global.id!,
        expected: globalSnapshot,
        directGrantEntityIds: [DIRECT_GRANTEE_ID],
      })
    ).resolves.toMatchObject({
      status: "updated",
      document: { metadata: { directGrantEntityIds: [DIRECT_GRANTEE_ID] } },
    });
    await expect(
      adapter.getDocument({
        agentId,
        documentId: global.id!,
        requesterEntityId: DIRECT_GRANTEE_ID,
        requesterRoomIds: [],
        requesterRole: "USER",
      })
    ).resolves.toMatchObject({ id: global.id });

    await expect(
      adapter.updateDocumentDirectGrants({
        ...adminContext,
        documentId: ownerPrivate.id!,
        expected: readDocumentMutationSnapshot(ownerPrivate)!,
        directGrantEntityIds: [DIRECT_GRANTEE_ID],
      })
    ).resolves.toEqual({ status: "forbidden" });
    await expect(
      adapter.updateDocumentDirectGrants({
        ...ownerContext,
        documentId: ownerPrivate.id!,
        expected: readDocumentMutationSnapshot(ownerPrivate)!,
        directGrantEntityIds: [DIRECT_GRANTEE_ID],
      })
    ).resolves.toMatchObject({ status: "updated" });

    await expect(
      adapter.updateDocumentDirectGrants({
        ...adminContext,
        documentId: global.id!,
        expected: globalSnapshot,
        directGrantEntityIds: [],
      })
    ).resolves.toEqual({ status: "conflict" });
    const currentGlobal = await adapter.getMemoryById(global.id!);
    await expect(
      adapter.updateDocumentDirectGrants({
        ...ownerContext,
        documentId: global.id!,
        expected: readDocumentMutationSnapshot(currentGlobal!)!,
        directGrantEntityIds: ["10000000-0000-0000-0000-000000000099" as UUID],
      })
    ).resolves.toEqual({ status: "not_found" });
  });

  it("rolls back a complete revision when a staged fragment cannot be inserted", async () => {
    const original = document(1, { metadata: { documentRevision: 0 } });
    const oldFragment = {
      ...document(2),
      id: v4() as UUID,
      content: { text: "old fragment" },
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: original.id,
        documentRevision: 0,
        position: 0,
      },
    };
    const collision = document(3);
    await adapter.createMemories([
      { memory: original, tableName: "documents" },
      { memory: oldFragment, tableName: "document_fragments" },
      { memory: collision, tableName: "documents" },
    ]);
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "OWNER" as const,
    };
    const snapshot = readDocumentMutationSnapshot(original)!;
    const replacement = {
      ...original,
      content: { text: "new body" },
      metadata: { ...original.metadata, documentRevision: 1 },
    };
    const conflictingFragment = {
      ...oldFragment,
      id: collision.id,
      content: { text: "new fragment" },
      metadata: { ...oldFragment.metadata, documentRevision: 1 },
    };

    await expect(
      adapter.replaceDocumentRevision({
        ...context,
        documentId: original.id!,
        expected: snapshot,
        replacement,
        fragments: [conflictingFragment],
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_REVISION_FRAGMENT_ID_CONFLICT" });

    await expect(adapter.getMemoryById(original.id!)).resolves.toMatchObject({
      content: { text: "Document body 1" },
      metadata: { documentRevision: 0 },
    });
    await expect(adapter.getMemoryById(oldFragment.id!)).resolves.toMatchObject({
      content: { text: "old fragment" },
    });
    await expect(adapter.getMemoryById(collision.id!)).resolves.toMatchObject({
      metadata: { type: MemoryType.DOCUMENT },
    });
  });

  it("rejects replacement fragment ids from the committed generation", async () => {
    const original = document(10, { metadata: { documentRevision: 0 } });
    const oldFragment = {
      ...document(11),
      id: v4() as UUID,
      content: { text: "old fragment" },
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: original.id,
        documentRevision: 0,
        position: 0,
      },
    };
    await adapter.createMemories([
      { memory: original, tableName: "documents" },
      { memory: oldFragment, tableName: "document_fragments" },
    ]);
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "OWNER" as const,
    };
    const snapshot = readDocumentMutationSnapshot(original)!;
    const replacement = {
      ...original,
      content: { text: "new body" },
      metadata: { ...original.metadata, documentRevision: 1 },
    };
    const reusedFragment = {
      ...oldFragment,
      content: { text: "new fragment with reused id" },
      metadata: { ...oldFragment.metadata, documentRevision: 1 },
    };

    await expect(
      adapter.replaceDocumentRevision({
        ...context,
        documentId: original.id!,
        expected: snapshot,
        replacement,
        fragments: [reusedFragment],
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_REVISION_FRAGMENT_ID_CONFLICT" });
    await expect(adapter.getMemoryById(original.id!)).resolves.toMatchObject({
      content: { text: "Document body 10" },
      metadata: { documentRevision: 0 },
    });
    await expect(adapter.getMemoryById(oldFragment.id!)).resolves.toMatchObject({
      content: { text: "old fragment" },
      metadata: { documentRevision: 0 },
    });
  });

  it("serializes competing revisions and exposes one complete winning generation", async () => {
    const original = document(1, { metadata: { documentRevision: 0 } });
    const oldFragment = {
      ...original,
      id: v4() as UUID,
      content: { text: "old fragment" },
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: original.id,
        documentRevision: 0,
        position: 0,
      },
    };
    await adapter.createMemories([
      { memory: original, tableName: "documents" },
      { memory: oldFragment, tableName: "document_fragments" },
    ]);
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "OWNER" as const,
    };
    const snapshot = readDocumentMutationSnapshot(original)!;
    const revision = (label: string) => {
      const fragmentId = v4() as UUID;
      return {
        ...context,
        documentId: original.id!,
        expected: snapshot,
        replacement: {
          ...original,
          content: { text: `${label} body` },
          metadata: { ...original.metadata, documentRevision: 1 },
        },
        fragments: [
          {
            ...original,
            id: fragmentId,
            content: { text: `${label} fragment` },
            metadata: {
              type: MemoryType.FRAGMENT,
              documentId: original.id,
              documentRevision: 1,
              position: 0,
            },
          },
        ],
      };
    };
    const observations = Promise.all(
      Array.from({ length: 12 }, () => adapter.queryDocumentFragments({ ...context, limit: 10 }))
    );
    const [left, right, observed] = await Promise.all([
      adapter.replaceDocumentRevision(revision("left")),
      adapter.replaceDocumentRevision(revision("right")),
      observations,
    ]);
    expect([left.status, right.status].sort()).toEqual(["conflict", "updated"]);
    const parent = await adapter.getDocument({ ...context, documentId: original.id! });
    const fragments = await adapter.queryDocumentFragments({ ...context, limit: 10 });
    expect(parent?.metadata?.documentRevision).toBe(1);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.metadata?.documentRevision).toBe(1);
    expect(fragments[0]?.content.text).toBe(
      `${String(parent?.content.text).split(" ")[0]} fragment`
    );
    for (const snapshotFragments of observed) {
      expect(snapshotFragments).toHaveLength(1);
      expect([0, 1]).toContain(snapshotFragments[0]?.metadata?.documentRevision);
    }
  });

  it("stores and searches complete oversized tokens without admitting partial-word candidates", async () => {
    const token = "界".repeat(9000) + "finish";
    const queryToken = "文".repeat(256);
    const source = document(801, { content: { text: `Before ${token} ${queryToken} after` } });
    const different = document(802, { content: { text: `Before ${token}extra after` } });
    await seedSql([source, different]);
    const inMemory = await seedInMemory([source, different]);
    const context = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "USER" as const,
      limit: 10,
      offset: 0,
    };
    for (const query of [queryToken, "界".repeat(128), "after", "文".repeat(128)]) {
      const result = await adapter.queryDocuments({ ...context, query });
      expect(result).toEqual(await inMemory.queryDocuments({ ...context, query }));
      if (query === queryToken) {
        expect(ids(result.documents)).toEqual([source.id]);
        expect(result.documents[0]?.content.text).toBe(source.content.text);
      }
      if (query === "界".repeat(128) || query === "文".repeat(128)) {
        expect(result.documents).toEqual([]);
      }
    }
  });

  it("installs the evidence-backed portable-token index", async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    const result = await db.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE indexname = 'idx_memories_document_search'
      ORDER BY indexname
    `);
    const definitions = new Map(
      result.rows.map((row) => [String(row.indexname), String(row.indexdef)])
    );

    expect(definitions.get("idx_memories_document_search")).toContain("USING gin");
    expect(definitions.get("idx_memories_document_search")).toContain("regexp_split_to_array");
  });

  postgresIt(
    "uses the document GIN index at 20k rows with bounded search latency",
    async () => {
      expect(adapter).toBeInstanceOf(PgDatabaseAdapter);
      const db = adapter.getDatabase() as DrizzleDatabase;
      await db.execute(sql`
      INSERT INTO ${memoryTable} (
        id,
        type,
        created_at,
        content,
        entity_id,
        agent_id,
        room_id,
        world_id,
        "unique",
        metadata
      )
      SELECT
        gen_random_uuid(),
        'documents',
        NOW() - (series.value * interval '1 millisecond'),
        jsonb_build_object(
          'text',
          CASE
            WHEN series.value = 19_999 THEN 'rareplanmarker release evidence'
            ELSE 'ordinary archived document ' || series.value::text
          END
        ),
        ${REQUESTER_ID}::uuid,
        ${agentId}::uuid,
        ${roomId}::uuid,
        ${worldId}::uuid,
        true,
        jsonb_build_object(
          'type',
          'document',
          'documentId',
          gen_random_uuid()::text,
          'timestamp',
          series.value,
          'scope',
          'global',
          'scopedToEntityId',
          ${REQUESTER_ID}::text,
          'addedBy',
          ${REQUESTER_ID}::text,
          'tags',
          jsonb_build_array('archive', 'scale')
        )
      FROM generate_series(1, 20_000) AS series(value)
    `);
      await db.execute(sql`ANALYZE ${memoryTable}`);

      const productionResult = await adapter.queryDocuments({
        agentId,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [roomId],
        requesterRole: "USER",
        query: "rareplanmarker release",
        scope: "global",
        scopedToEntityId: REQUESTER_ID,
        addedBy: REQUESTER_ID,
        tags: ["archive", "scale"],
        timeRangeStart: 0,
        timeRangeEnd: 20_000,
        limit: 25,
        offset: 0,
      });
      expect(productionResult.totalMatched).toBe(1);
      const explain = await adapter.explainLastDocumentListQuery();
      const plan = JSON.stringify(explain[0]);
      const executionTime = plan.match(/"Execution Time":\s*([0-9.]+)/)?.[1];

      expect(plan).toContain("idx_memories_document_search");
      expect(plan).toMatch(/Bitmap Index Scan|Index Scan/);
      expect(executionTime).toBeDefined();
      expect(Number(executionTime)).toBeLessThan(5_000);

      const highOffsetResult = await adapter.queryDocuments({
        agentId,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [roomId],
        requesterRole: "USER",
        limit: 25,
        offset: 10_000,
      });
      expect(highOffsetResult.documents).toHaveLength(25);
      const highOffsetPlan = JSON.stringify((await adapter.explainLastDocumentListQuery())[0]);
      const highOffsetExecutionTime = highOffsetPlan.match(/"Execution Time":\s*([0-9.]+)/)?.[1];
      expect(highOffsetExecutionTime).toBeDefined();
      expect(Number(highOffsetExecutionTime)).toBeLessThan(10_000);
    },
    120_000
  );

  it("pushes metadata, text, and document timestamp filters down with parity", async () => {
    const documents = [
      document(1, {
        metadata: {
          title: "Quarterly Launch Needle",
          scope: "global",
          scopedToEntityId: REQUESTER_ID,
          addedBy: REQUESTER_ID,
          tags: ["archive", "launch"],
          timestamp: 5_000,
        },
      }),
      document(2, {
        metadata: {
          title: "Quarterly Launch Needle",
          scope: "global",
          scopedToEntityId: REQUESTER_ID,
          addedBy: REQUESTER_ID,
          tags: ["archive"],
          timestamp: 5_000,
        },
      }),
      document(3, {
        metadata: {
          title: "Quarterly Launch Needle",
          scope: "global",
          scopedToEntityId: REQUESTER_ID,
          addedBy: REQUESTER_ID,
          tags: ["archive", "launch"],
          timestamp: 50_000,
        },
      }),
    ];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      query: "launch needle",
      scope: "global",
      scopedToEntityId: REQUESTER_ID,
      addedBy: REQUESTER_ID,
      tags: ["archive", "launch"],
      timeRangeStart: 4_000,
      timeRangeEnd: 6_000,
      limit: 10,
      offset: 0,
    };

    const sqlResult = await adapter.queryDocuments(params);
    const inMemoryResult = await inMemory.queryDocuments(params);

    expect(ids(sqlResult.documents)).toEqual([documents[0]?.id]);
    expect(sqlResult).toEqual(inMemoryResult);
    expect(sqlResult).toMatchObject({
      totalVisible: 3,
      totalAvailable: 1,
      totalMatched: 1,
      hasMore: false,
    });
  });
});
