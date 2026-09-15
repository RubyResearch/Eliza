/**
 * Memory + knowledge HTTP endpoints for the agent's dashboard/control API,
 * mounted behind that API's auth layer (returns 503 when no runtime is
 * attached).
 *
 * Hash-memory notes: POST /api/memory/remember stores a note, GET
 * /api/memory/search BM25-ranks them. GET /api/context/quick answers a query
 * over both hash-memory notes and documents via a TEXT_SMALL model call.
 * Memory viewer: GET /api/memories/feed | /browse | /by-entity/:id | /stats
 * read across the messages/memories/facts/documents tables; DELETE and PATCH
 * /api/memories/:id delete or edit-and-re-embed a single row (the id must look
 * like a UUID, keeping the literal sibling routes unambiguous).
 */
import crypto from "node:crypto";
import {
  type AgentRuntime,
  BM25,
  ChannelType,
  compareMemoryIds,
  composePrompt,
  composeToolDiagnosticRedactor,
  createMessageMemory,
  ElizaError,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  ModelType,
  memoryContextQaTemplate,
  projectCompleteToolValueForModel,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";
import {
  PatchMemoryRequestSchema,
  PostMemoryRememberRequestSchema,
  parseCanonicalInteger,
  parsePositiveInteger,
} from "@elizaos/shared";
import {
  type DocumentsServiceResult,
  getDocumentsService,
} from "./documents-service-loader.ts";
import { decodePathComponent } from "./server-helpers.ts";

export const HASH_MEMORY_SOURCE = "hash_memory";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_SEARCH_SCAN_LIMIT = 2_000;
/**
 * Warm-corpus reuse window for the hash-memory search cache. Module-local
 * writes (remember/delete/patch) invalidate explicitly and a row-count check
 * runs before every reuse. Count-preserving out-of-band edits trigger refresh
 * after 10 seconds and may be served stale only until the 20-second hard bound.
 */
const MEMORY_SEARCH_CACHE_TTL_MS = 10_000;
const MEMORY_SEARCH_CACHE_MAX_STALE_MS = 20_000;
const MEMORY_SEARCH_CACHE_MAX_ENTRIES = 4;
const MEMORY_SEARCH_CACHE_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MEMORY_SEARCH_MAX_UNSTABLE_BUILD_ATTEMPTS = 3;
const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
const MEMORY_SEARCH_MAX_LIMIT = 50;
const QUICK_CONTEXT_DEFAULT_LIMIT = 8;
const QUICK_CONTEXT_MAX_LIMIT = 20;
const QUICK_CONTEXT_DOCUMENTS_THRESHOLD = 0.2;

const MEMORY_BROWSE_DEFAULT_LIMIT = 50;
const MEMORY_BROWSE_MAX_LIMIT = 200;
const MEMORY_BROWSE_MAX_SCAN_ROWS = 25_000;
const MEMORY_FEED_DEFAULT_LIMIT = 50;
const MEMORY_FEED_MAX_LIMIT = 100;
export const MEMORY_TABLE_NAMES = [
  "messages",
  "memories",
  "facts",
  "documents",
] as const;

export interface MemoryRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
  agentName: string;
}

type MemorySearchHit = {
  id: string;
  text: string;
  createdAt: number;
  score: number;
};

type DocumentSearchHit = {
  id: string;
  text: string;
  similarity: number;
  documentId?: string;
  documentTitle?: string;
  position?: number;
};

type DocumentSearchMatch = {
  id: UUID;
  content: { text?: string };
  similarity?: number;
  metadata?: Record<string, unknown>;
};

function resolveAgentName(runtime: AgentRuntime, fallbackName: string): string {
  return runtime.character.name?.trim() || fallbackName || "Eliza";
}

async function ensureMemoryConnection(
  runtime: AgentRuntime,
  agentName: string,
): Promise<{ roomId: UUID; entityId: UUID }> {
  const entityId = runtime.agentId as UUID;
  const roomId = stringToUuid(`${agentName}-hash-memory-room`) as UUID;
  const worldId = stringToUuid(`${agentName}-hash-memory-world`) as UUID;
  const messageServerId = stringToUuid(
    `${agentName}-hash-memory-server`,
  ) as UUID;

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "User",
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    channelId: `${agentName}-hash-memory`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId: entityId } },
  });

  return { roomId, entityId };
}

/**
 * Rank a candidate set against `query` with Okapi BM25 + Porter2 stemming,
 * returning each item with a [0,1] max-normalized relevance score in input order.
 *
 * Corpus-aware IDF down-weights filler/stop words and TF saturation + length
 * normalization rank genuinely-relevant text first; a naive pairwise substring
 * count with no IDF would let a doc that merely contains a common query word
 * ("the") tie with a real hit. We use the `search.ts` BM25
 * (not the documents `bm25Scores`) specifically for its **Porter2 stemming** —
 * short typed chat queries are usually base forms ("configure") while stored
 * messages carry inflected forms ("configuring"/"configured"/"configuration"),
 * and stemming is the standard keyword answer to that mismatch. It also brings
 * stop-word removal and proper Unicode/accent/CJK normalization (the documents
 * tokenizer strips non-ASCII, silently dropping accented + non-Latin text).
 */
export function rankByKeyword<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
): Array<{ item: T; score: number }> {
  if (items.length === 0) return [];
  // Single `content` field per doc so only the text is indexed; items are
  // tracked by array index (the BM25 result `index`).
  const bm25 = new BM25(
    items.map((item) => ({ content: getText(item) })),
    { stemming: true },
  );
  return rankWithIndex(query, items, bm25);
}

/**
 * Same ranking contract as {@link rankByKeyword} but against a prebuilt BM25
 * index whose docs correspond 1:1 (by array index) with `items`. This is the
 * shared scoring tail, so cached and cold paths cannot drift.
 */
function rankWithIndex<T>(
  query: string,
  items: T[],
  bm25: BM25,
): Array<{ item: T; score: number }> {
  if (items.length === 0) return [];
  const results = bm25.search(query, items.length);
  if (results.length === 0) return items.map((item) => ({ item, score: 0 }));
  const firstScore = results[0]?.score;
  const maxScore = typeof firstScore === "number" ? firstScore : 0;
  const scoreByIndex = new Map(results.map((r) => [r.index, r.score]));
  return items.map((item, i) => {
    const indexedScore = scoreByIndex.get(i);
    return {
      item,
      score:
        maxScore > 0
          ? (typeof indexedScore === "number" ? indexedScore : 0) / maxScore
          : 0,
    };
  });
}

/**
 * Boolean keyword match for *filtering* (not ranking): does the text contain the
 * whole query or any query term (≥2 chars)? Used where the caller wants
 * "messages matching this text", not a relevance ranking.
 */
export function matchesKeyword(text: string, query: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedText || !normalizedQuery) return false;
  if (normalizedText.includes(normalizedQuery)) return true;
  return normalizedQuery
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .some((term) => normalizedText.includes(term));
}

type MemorySearchCandidate = { id: UUID; text: string; createdAt: number };

type MemorySearchCorpus = {
  candidates: MemorySearchCandidate[];
  /** BM25 index whose doc order matches `candidates` by array index. */
  bm25: BM25;
  /** Room message-row count observed when this corpus was built. */
  rowCount: number;
  builtAt: number;
};

type MemorySearchCacheSlot = {
  generation: number;
  corpus?: MemorySearchCorpus;
  inFlight?: Promise<MemorySearchCorpusBuild>;
  builds: Set<Promise<MemorySearchCorpusBuild>>;
  leases: number;
};

type MemorySearchCorpusBuild = {
  corpus: MemorySearchCorpus;
  disposition: "cacheable" | "uncached" | "obsolete";
  countBefore: number | null;
  countAfter: number | null;
};

type MemorySearchBuildRetryBudget = {
  unstableAttempts: number;
};

/**
 * Per-runtime, per-room corpus + BM25 index cache for the hash-memory search
 * endpoints. Building this per request was the whole latency story: a full
 * `getMemories` scan (up to {@link MEMORY_SEARCH_SCAN_LIMIT} rows, some
 * multi-KB) plus a fresh BM25 tokenize/index pass cost ~2s+ at ~2k rows while
 * the actual query scoring is sub-millisecond.
 *
 * Freshness model (memories can be written outside this module, e.g. normal
 * chat writes to the "messages" table):
 *  - explicit invalidation on every mutation routed through this module
 *    (remember / DELETE / PATCH);
 *  - a cheap COUNT check before every reuse catches out-of-band creates and
 *    deletes immediately;
 *  - a short TTL triggers refresh for count-preserving out-of-band edits, and
 *    {@link MEMORY_SEARCH_CACHE_MAX_STALE_MS} is their absolute stale bound.
 */
let memorySearchCorpusCaches = new WeakMap<
  AgentRuntime,
  Map<string, MemorySearchCacheSlot>
>();

type MemorySearchBuildAdmission = {
  active: number;
  waiters: Array<() => void>;
};

let memorySearchBuildAdmissions = new WeakMap<
  AgentRuntime,
  MemorySearchBuildAdmission
>();
let memorySearchSlotWaiters = new WeakMap<AgentRuntime, Set<() => void>>();

function invalidateMemorySearchCacheSlot(slot: MemorySearchCacheSlot): void {
  slot.generation++;
  slot.corpus = undefined;
  // Detach an older build so a request arriving after invalidation cannot join
  // a stale snapshot. Its generation check prevents that build from publishing.
  slot.inFlight = undefined;
}

export function invalidateMemorySearchCache(
  runtime?: AgentRuntime,
  roomId?: UUID,
): void {
  if (!runtime) {
    // Test/process reset only. Runtime-owned maps otherwise disappear when the
    // runtime is collected, without keeping tenant state alive module-wide.
    memorySearchCorpusCaches = new WeakMap();
    memorySearchBuildAdmissions = new WeakMap();
    memorySearchSlotWaiters = new WeakMap();
    return;
  }
  const cache = memorySearchCorpusCaches.get(runtime);
  if (!cache) return;
  if (roomId) {
    const slot = cache.get(roomId);
    if (slot) invalidateMemorySearchCacheSlot(slot);
    return;
  }
  for (const slot of cache.values()) invalidateMemorySearchCacheSlot(slot);
}

async function countRoomMessages(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<number | null> {
  if (typeof runtime.countMemories !== "function") return null;
  try {
    return await runtime.countMemories({
      roomId,
      tableName: "messages",
    });
  } catch (error) {
    // error-policy:J7 A freshness-probe failure is reported but cannot turn a
    // safe uncached search into a user-visible route failure.
    runtime.reportError("MemorySearchCache.countRoomMessages", error, {
      roomId,
    });
    return null;
  }
}

function runtimeMemorySearchCache(
  runtime: AgentRuntime,
): Map<string, MemorySearchCacheSlot> {
  let cache = memorySearchCorpusCaches.get(runtime);
  if (!cache) {
    cache = new Map();
    memorySearchCorpusCaches.set(runtime, cache);
  }
  return cache;
}

function retainMemorySearchCacheSlot(
  cache: Map<string, MemorySearchCacheSlot>,
  roomId: string,
  slot: MemorySearchCacheSlot,
): void {
  // Map insertion order is the LRU order.
  cache.delete(roomId);
  cache.set(roomId, slot);
}

async function acquireMemorySearchCacheSlot(
  runtime: AgentRuntime,
  roomId: string,
): Promise<{
  cache: Map<string, MemorySearchCacheSlot>;
  slot: MemorySearchCacheSlot;
}> {
  const cache = runtimeMemorySearchCache(runtime);
  while (true) {
    const existing = cache.get(roomId);
    if (existing) {
      retainMemorySearchCacheSlot(cache, roomId, existing);
      existing.leases++;
      return { cache, slot: existing };
    }

    if (cache.size < MEMORY_SEARCH_CACHE_MAX_ENTRIES) {
      const slot: MemorySearchCacheSlot = {
        generation: 0,
        builds: new Set(),
        leases: 1,
      };
      retainMemorySearchCacheSlot(cache, roomId, slot);
      return { cache, slot };
    }

    // Never evict a slot while one of its current or invalidated builds still
    // owns work. Otherwise the caller retains an orphaned slot, a later request
    // starts a replacement scan, and the Map bound says nothing about live work.
    const evictable = [...cache].find(
      ([, candidate]) => candidate.builds.size === 0 && candidate.leases === 0,
    );
    if (evictable) {
      cache.delete(evictable[0]);
      continue;
    }

    // All bounded slots are busy. Wait for one to become evictable before
    // allocating another slot; concurrent callers remain ordinary request
    // promises rather than cache-owned room state.
    await new Promise<void>((resolve) => {
      let waiters = memorySearchSlotWaiters.get(runtime);
      if (!waiters) {
        waiters = new Set();
        memorySearchSlotWaiters.set(runtime, waiters);
      }
      waiters.add(resolve);
    });
  }
}

function signalMemorySearchSlotAvailability(runtime: AgentRuntime): void {
  const waiters = memorySearchSlotWaiters.get(runtime);
  if (!waiters) return;
  memorySearchSlotWaiters.delete(runtime);
  for (const resolve of waiters) resolve();
}

async function withMemorySearchBuildPermit<T>(
  runtime: AgentRuntime,
  task: () => Promise<T>,
): Promise<T> {
  let admission = memorySearchBuildAdmissions.get(runtime);
  if (!admission) {
    admission = { active: 0, waiters: [] };
    memorySearchBuildAdmissions.set(runtime, admission);
  }

  if (admission.active < MEMORY_SEARCH_CACHE_MAX_ENTRIES) {
    admission.active++;
  } else {
    await new Promise<void>((resolve) => {
      admission.waiters.push(() => {
        admission.active++;
        resolve();
      });
    });
  }

  try {
    return await task();
  } finally {
    admission.active--;
    const next = admission.waiters.shift();
    if (next) {
      next();
    } else if (
      admission.active === 0 &&
      memorySearchBuildAdmissions.get(runtime) === admission
    ) {
      memorySearchBuildAdmissions.delete(runtime);
    }
  }
}

async function buildMemorySearchCorpus(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<MemorySearchCorpusBuild> {
  // The two counts form a lightweight seqlock around the scan. A create/delete
  // interleaving with getMemories makes the counts disagree, so that mixed
  // snapshot is marked obsolete and retried instead of being returned or
  // published for later reuse.
  const countBefore = await countRoomMessages(runtime, roomId);
  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    limit: MEMORY_SEARCH_SCAN_LIMIT,
    includeEmbedding: false, // only reads content.text
  });
  const countAfter =
    countBefore === null ? null : await countRoomMessages(runtime, roomId);

  const candidates: MemorySearchCandidate[] = [];
  const textEncoder = new TextEncoder();
  let retainedTextBytes = 0;
  for (const memory of memories) {
    const text = (
      memory.content as { text?: string } | undefined
    )?.text?.trim();
    if (!text) continue;
    const source = (memory.content as { source?: string } | undefined)?.source;
    if (source !== HASH_MEMORY_SOURCE) continue;
    if (!memory.id || typeof memory.createdAt !== "number") continue;
    retainedTextBytes += textEncoder.encode(text).byteLength;
    candidates.push({
      id: memory.id,
      text,
      createdAt: memory.createdAt,
    });
  }

  const countsMatch =
    countBefore !== null && countAfter !== null && countBefore === countAfter;
  return {
    corpus: {
      candidates,
      bm25: new BM25(
        candidates.map((candidate) => ({ content: candidate.text })),
        { stemming: true },
      ),
      rowCount: countAfter ?? memories.length,
      builtAt: Date.now(),
    },
    disposition:
      countBefore !== null && countAfter !== null && !countsMatch
        ? "obsolete"
        : countsMatch && retainedTextBytes <= MEMORY_SEARCH_CACHE_MAX_TEXT_BYTES
          ? "cacheable"
          : "uncached",
    countBefore,
    countAfter,
  };
}

function startMemorySearchCorpusBuild(
  runtime: AgentRuntime,
  roomId: UUID,
  slot: MemorySearchCacheSlot,
): Promise<MemorySearchCorpusBuild> {
  if (slot.inFlight) return slot.inFlight;
  const generation = slot.generation;
  const build = withMemorySearchBuildPermit(runtime, async () =>
    buildMemorySearchCorpus(runtime, roomId),
  ).then((result) => {
    if (slot.generation === generation) {
      slot.corpus =
        result.disposition === "cacheable" ? result.corpus : undefined;
    }
    return result;
  });
  slot.inFlight = build;
  slot.builds.add(build);
  // error-policy:J7 A background refresh is observed and reported here; a
  // synchronous caller awaiting the same promise still receives the failure.
  void build.then(
    () => {
      slot.builds.delete(build);
      if (slot.inFlight === build) slot.inFlight = undefined;
      signalMemorySearchSlotAvailability(runtime);
    },
    (error: unknown) => {
      slot.builds.delete(build);
      if (slot.inFlight === build) slot.inFlight = undefined;
      signalMemorySearchSlotAvailability(runtime);
      runtime.reportError("MemorySearchCache.refresh", error, { roomId });
    },
  );
  return build;
}

async function awaitCurrentMemorySearchCorpusBuild(
  runtime: AgentRuntime,
  roomId: UUID,
  cache: Map<string, MemorySearchCacheSlot>,
  slot: MemorySearchCacheSlot,
  retryBudget: MemorySearchBuildRetryBudget,
): Promise<MemorySearchCorpus> {
  while (true) {
    const generation = slot.generation;
    const result = await startMemorySearchCorpusBuild(runtime, roomId, slot);
    // The slot may have been replaced while its scan was pending. Re-enter via
    // the bounded canonical map so a mutation cannot be missed by an orphaned
    // in-flight request.
    if (
      memorySearchCorpusCaches.get(runtime) !== cache ||
      cache.get(roomId) !== slot
    ) {
      consumeMemorySearchRetryBudget(retryBudget, roomId, "map_identity", {
        countBefore: result.countBefore,
        countAfter: result.countAfter,
      });
      return await getMemorySearchCorpus(runtime, roomId, retryBudget);
    }
    // Invalidation already prevents this build from publishing. It must also
    // prevent a request awaiting the old generation from returning that stale
    // snapshot after the mutation has completed.
    if (slot.generation !== generation) {
      consumeMemorySearchRetryBudget(retryBudget, roomId, "generation", {
        countBefore: result.countBefore,
        countAfter: result.countAfter,
      });
      continue;
    }
    if (result.disposition !== "obsolete") return result.corpus;

    invalidateMemorySearchCacheSlot(slot);
    consumeMemorySearchRetryBudget(retryBudget, roomId, "count_mismatch", {
      countBefore: result.countBefore,
      countAfter: result.countAfter,
    });
  }
}

function consumeMemorySearchRetryBudget(
  retryBudget: MemorySearchBuildRetryBudget,
  roomId: UUID,
  reason: "count_mismatch" | "generation" | "map_identity",
  context: { countBefore?: number | null; countAfter?: number | null } = {},
): void {
  retryBudget.unstableAttempts++;
  if (
    retryBudget.unstableAttempts < MEMORY_SEARCH_MAX_UNSTABLE_BUILD_ATTEMPTS
  ) {
    return;
  }
  throw new ElizaError(
    "Memory search corpus could not obtain a stable room snapshot",
    {
      code: "MEMORY_SEARCH_UNSTABLE_SNAPSHOT",
      context: {
        roomId,
        attempts: retryBudget.unstableAttempts,
        reason,
        ...context,
      },
    },
  );
}

async function getMemorySearchCorpus(
  runtime: AgentRuntime,
  roomId: UUID,
  retryBudget: MemorySearchBuildRetryBudget = { unstableAttempts: 0 },
): Promise<MemorySearchCorpus> {
  const { cache, slot } = await acquireMemorySearchCacheSlot(runtime, roomId);
  try {
    const cached = slot.corpus;
    if (cached) {
      const rowCount = await countRoomMessages(runtime, roomId);

      // A process/test cache reset may replace this runtime's canonical map while
      // COUNT is pending. Re-enter through that map with the shared retry budget.
      if (
        memorySearchCorpusCaches.get(runtime) !== cache ||
        cache.get(roomId) !== slot
      ) {
        consumeMemorySearchRetryBudget(retryBudget, roomId, "map_identity");
        return await getMemorySearchCorpus(runtime, roomId, retryBudget);
      }

      // A module-local mutation may have invalidated this slot while COUNT was
      // pending. Never return the snapshot captured before that mutation.
      if (slot.corpus !== cached) {
        consumeMemorySearchRetryBudget(retryBudget, roomId, "generation");
        return await awaitCurrentMemorySearchCorpusBuild(
          runtime,
          roomId,
          cache,
          slot,
          retryBudget,
        );
      }

      if (rowCount !== null && rowCount === cached.rowCount) {
        const age = Date.now() - cached.builtAt;
        if (age <= MEMORY_SEARCH_CACHE_TTL_MS) return cached;
        if (age <= MEMORY_SEARCH_CACHE_MAX_STALE_MS) {
          // Keep the first post-TTL request warm while one shared refresh runs.
          // The absolute max-stale boundary below prevents persistent failures
          // from extending this stale-while-revalidate window indefinitely.
          startMemorySearchCorpusBuild(runtime, roomId, slot);
          return cached;
        }
      } else {
        // A changed/unknown count makes both the cached corpus and any older
        // background refresh ineligible. Detach that refresh before rebuilding;
        // otherwise this request could join a snapshot that predates the count
        // mismatch it just observed.
        invalidateMemorySearchCacheSlot(slot);
      }
    }
    return await awaitCurrentMemorySearchCorpusBuild(
      runtime,
      roomId,
      cache,
      slot,
      retryBudget,
    );
  } finally {
    slot.leases--;
    signalMemorySearchSlotAvailability(runtime);
  }
}

async function searchMemoryNotes(
  runtime: AgentRuntime,
  roomId: UUID,
  query: string,
  limit: number,
): Promise<MemorySearchHit[]> {
  const corpus = await getMemorySearchCorpus(runtime, roomId);

  const hits: MemorySearchHit[] = rankWithIndex(
    query,
    corpus.candidates,
    corpus.bm25,
  )
    .filter(({ score }) => score > 0)
    .map(({ item, score }) => ({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      score,
    }));

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
  return hits.slice(0, limit);
}

async function searchDocuments(
  runtime: AgentRuntime,
  query: string,
  limit: number,
): Promise<DocumentSearchHit[]> {
  const documents: DocumentsServiceResult = await getDocumentsService(runtime);
  const documentsService = documents.service;
  if (!documentsService || !runtime.agentId) return [];

  const agentId = runtime.agentId as UUID;
  const searchMessage: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: agentId,
    agentId,
    roomId: agentId,
    content: { text: query },
    createdAt: Date.now(),
  };

  const matches: DocumentSearchMatch[] = await documentsService.searchDocuments(
    searchMessage,
    {
      roomId: agentId,
    },
  );

  return matches
    .filter(
      (match) => (match.similarity ?? 0) >= QUICK_CONTEXT_DOCUMENTS_THRESHOLD,
    )
    .slice(0, limit)
    .map((match) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      return {
        id: match.id,
        text: match.content.text ?? "",
        similarity: match.similarity ?? 0,
        documentId:
          typeof metadata?.documentId === "string"
            ? metadata.documentId
            : undefined,
        documentTitle:
          typeof metadata?.filename === "string"
            ? metadata.filename
            : typeof metadata?.title === "string"
              ? metadata.title
              : undefined,
        position:
          typeof metadata?.position === "number"
            ? metadata.position
            : undefined,
      };
    });
}

function buildQuickContextPrompt(params: {
  query: string;
  memories: MemorySearchHit[];
  documents: DocumentSearchHit[];
}): string {
  const { query, memories, documents } = params;
  const memorySection =
    memories.length > 0
      ? memories
          .map((item, index) => `- [M${index + 1}] ${item.text}`)
          .join("\n")
      : "- none";
  const documentsSection =
    documents.length > 0
      ? documents
          .map((item, index) => `- [D${index + 1}] ${item.text}`)
          .join("\n")
      : "- none";

  return composePrompt({
    state: { query, memorySection, knowledgeSection: documentsSection },
    template: memoryContextQaTemplate,
  });
}

type MemoryBrowseItem = {
  id: string;
  type: string;
  text: string;
  entityId: string | null;
  roomId: string | null;
  agentId: string | null;
  createdAt: number;
  metadata: Record<string, unknown> | null;
  source: string | null;
};

type TaggedMemory = Memory & { _table: string };

/** Ordering key — `Memory.createdAt` is optional; rows without one sort as oldest. */
const memoryCreatedAt = (memory: { createdAt?: number }): number =>
  memory.createdAt ?? 0;

/** Newest-first comparator shared by the browse/search/feed list routes. */
const byNewestFirst = (
  a: { createdAt?: number; id?: string; _table?: string },
  b: { createdAt?: number; id?: string; _table?: string },
): number => {
  const timestampOrder = memoryCreatedAt(b) - memoryCreatedAt(a);
  if (timestampOrder !== 0) return timestampOrder;
  const idOrder = compareMemoryIds(b.id ?? "", a.id ?? "");
  if (idOrder !== 0) return idOrder;
  return (a._table ?? "").localeCompare(b._table ?? "");
};

function memoryToBrowseItem(memory: TaggedMemory): MemoryBrowseItem {
  const content = memory.content as Record<string, unknown> | undefined;
  return {
    id: memory.id ?? "",
    type: memory._table,
    text: (content?.text as string) ?? "",
    entityId: memory.entityId,
    roomId: memory.roomId,
    agentId: memory.agentId ?? null,
    createdAt: memoryCreatedAt(memory),
    metadata: (memory.metadata as Record<string, unknown>) ?? null,
    source: (content?.source as string) ?? null,
  };
}

function hasBrowsableContent(memory: TaggedMemory): boolean {
  const text = (memory.content as { text?: string } | undefined)?.text;
  return typeof text === "string" && text.trim().length > 0;
}

async function fetchMemoriesFromTables(
  runtime: AgentRuntime,
  params: {
    entityIds?: UUID[];
    roomId?: UUID;
    tables?: readonly string[];
    /** Stop after this many eligible rows per table. */
    target: number;
    before?: number;
    beforeId?: UUID;
    searchQuery?: string;
  },
): Promise<TaggedMemory[]> {
  const tables = params.tables ?? MEMORY_TABLE_NAMES;
  const entityIds = params.entityIds?.length
    ? new Set<string>(params.entityIds)
    : undefined;
  const searchQuery = params.searchQuery?.trim() ?? "";
  const searchTerms = searchQuery.split(/\s+/).filter(Boolean);
  // matchesKeyword has OR semantics for multi-token queries, so only a
  // single token can be pushed into the adapter without excluding valid rows.
  const textContains = searchTerms.length === 1 ? searchTerms[0] : undefined;
  const maxScannedRowsPerTable = Math.max(
    1,
    Math.floor(MEMORY_BROWSE_MAX_SCAN_ROWS / Math.max(tables.length, 1)),
  );

  // Tables are independent and remain concurrent, but each table advances an
  // exclusive keyset cursor instead of repeatedly reading a larger prefix.
  // Requiring the target from every non-exhausted table makes the final
  // cross-table merge safe. The request-wide row budget fails closed when a
  // filter is too sparse to prove the page without draining an unbounded store.
  const tableResults = await Promise.all(
    tables.map(async (tableName) => {
      const eligible: TaggedMemory[] = [];
      let cursor: { createdAt: number; id: UUID } | undefined =
        params.before !== undefined && params.beforeId !== undefined
          ? { createdAt: params.before, id: params.beforeId }
          : undefined;
      let batchSize = 200;
      let scannedRows = 0;

      for (;;) {
        const queryLimit = Math.min(
          batchSize,
          maxScannedRowsPerTable - scannedRows,
        );
        if (queryLimit <= 0) {
          throw new ElizaError(
            "Memory browse exceeded its bounded scan budget before proving the page",
            {
              code: "MEMORY_BROWSE_SCAN_LIMIT",
              context: {
                tableName,
                scannedRows,
                maxScannedRows: maxScannedRowsPerTable,
                target: params.target,
              },
            },
          );
        }
        const memories = await runtime.getMemories({
          agentId: runtime.agentId as UUID,
          roomId: params.roomId,
          tableName,
          limit: queryLimit,
          cursor,
          // Timestamp-only callers retain the original strict-before filter.
          // A tuple cursor is already the complete exclusive boundary.
          end: params.beforeId === undefined ? params.before : undefined,
          textContains,
          includeEmbedding: false, // browse feed discards embeddings
        });
        scannedRows += memories.length;

        let nextCursor = cursor;
        for (const memory of memories) {
          if (!memory.id) {
            throw new ElizaError(
              "A paged memory row did not contain the required id",
              {
                code: "MEMORY_BROWSE_CURSOR_MISSING_ID",
                context: { tableName },
              },
            );
          }
          const candidate = {
            createdAt: memoryCreatedAt(memory),
            id: memory.id,
          };
          if (
            nextCursor &&
            (candidate.createdAt > nextCursor.createdAt ||
              (candidate.createdAt === nextCursor.createdAt &&
                compareMemoryIds(candidate.id, nextCursor.id) >= 0))
          ) {
            throw new ElizaError(
              "Memory adapter did not advance the requested keyset cursor",
              {
                code: "MEMORY_BROWSE_CURSOR_NO_PROGRESS",
                context: {
                  tableName,
                  cursorCreatedAt: nextCursor.createdAt,
                  cursorId: nextCursor.id,
                  returnedCreatedAt: candidate.createdAt,
                  returnedId: candidate.id,
                },
              },
            );
          }
          nextCursor = candidate;
        }

        for (const memory of memories) {
          const tagged = { ...memory, _table: tableName };
          if (!hasBrowsableContent(tagged)) continue;
          if (
            entityIds &&
            (!tagged.entityId || !entityIds.has(tagged.entityId))
          ) {
            continue;
          }
          if (params.before !== undefined) {
            const createdAt = memoryCreatedAt(tagged);
            if (createdAt > params.before) continue;
            if (createdAt === params.before) {
              if (
                params.beforeId === undefined ||
                compareMemoryIds(tagged.id ?? "", params.beforeId) >= 0
              ) {
                continue;
              }
            }
          }
          if (
            searchQuery &&
            !matchesKeyword(
              (tagged.content as { text?: string } | undefined)?.text ?? "",
              searchQuery,
            )
          ) {
            continue;
          }
          eligible.push(tagged);
        }

        if (memories.length < queryLimit) {
          return eligible;
        }
        if (eligible.length >= params.target) {
          return eligible;
        }
        if (scannedRows >= maxScannedRowsPerTable) {
          throw new ElizaError(
            "Memory browse exceeded its bounded scan budget before proving the page",
            {
              code: "MEMORY_BROWSE_SCAN_LIMIT",
              context: {
                tableName,
                scannedRows,
                maxScannedRows: maxScannedRowsPerTable,
                target: params.target,
              },
            },
          );
        }
        cursor = nextCursor;
        batchSize = Math.min(batchSize * 2, 5_000);
      }
    }),
  );
  return tableResults.flat();
}

/**
 * Parse the memory-viewer `type` query. Omitted/empty means every table
 * (the "all" tab). A known table name narrows the scan. Any other token
 * used to fall through to that same unfiltered scan, so `type=notes` or
 * `type=message` silently returned the whole feed.
 */
export function parseMemoryTableFilter(
  typeParam: string | null,
): { ok: true; tables?: readonly string[] } | { ok: false; message: string } {
  if (typeParam === null || typeParam === "") return { ok: true };
  const t = typeParam.toLowerCase();
  if (MEMORY_TABLE_NAMES.includes(t as (typeof MEMORY_TABLE_NAMES)[number])) {
    return { ok: true, tables: [t] };
  }
  return {
    ok: false,
    message: `type must be one of: ${MEMORY_TABLE_NAMES.join(", ")}`,
  };
}

export async function handleMemoryRoutes(
  ctx: MemoryRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    runtime,
    agentName,
    json,
    error,
    readJsonBody,
  } = ctx;

  if (
    !pathname.startsWith("/api/memory") &&
    !pathname.startsWith("/api/memories") &&
    pathname !== "/api/context/quick"
  ) {
    return false;
  }

  if (!runtime) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }

  const resolvedAgentName = resolveAgentName(runtime, agentName);
  const { roomId, entityId } = await ensureMemoryConnection(
    runtime,
    resolvedAgentName,
  );

  if (method === "POST" && pathname === "/api/memory/remember") {
    const rawRem = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawRem === null) return true;
    const parsedRem = PostMemoryRememberRequestSchema.safeParse(rawRem);
    if (!parsedRem.success) {
      error(res, parsedRem.error.issues[0]?.message ?? "text is required", 400);
      return true;
    }
    const text = parsedRem.data.text;
    const createdAt = Date.now();
    const memoryId = parsedRem.data.idempotencyKey
      ? (stringToUuid(
          `${HASH_MEMORY_SOURCE}:${runtime.agentId}:${parsedRem.data.idempotencyKey}`,
        ) as UUID)
      : (crypto.randomUUID() as UUID);
    const existing = parsedRem.data.idempotencyKey
      ? await runtime.getMemoryById(memoryId)
      : null;
    if (existing) {
      json(res, {
        ok: true,
        id: existing.id,
        text: existing.content.text ?? text,
        createdAt: existing.createdAt,
        replayed: true,
      });
      return true;
    }
    const message = createMessageMemory({
      id: memoryId,
      entityId,
      roomId,
      content: {
        text,
        source: HASH_MEMORY_SOURCE,
        channelType: ChannelType.DM,
      },
      // Hash-memory notes are the agent's personal store: fail closed against
      // strangers, but keep the AGENT tier readable. `agent-private` (OWNER +
      // AGENT + RUNTIME) rather than `owner-private` (OWNER + RUNTIME only),
      // because owner-private would silently deny the agent its own recall
      // once readers enforce scope. Without an explicit scope the factory
      // default is `shared` — world-readable — which is wrong for these rows.
      scope: "agent-private",
    });
    await runtime.createMemory(message, "messages");
    invalidateMemorySearchCache(runtime, roomId);
    json(res, {
      ok: true,
      id: message.id,
      text,
      createdAt,
      replayed: false,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/memory/search") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (!query) {
      error(res, "Search query (q) is required", 400);
      return true;
    }
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_SEARCH_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MEMORY_SEARCH_MAX_LIMIT,
    );
    const results = await searchMemoryNotes(runtime, roomId, query, limit);
    json(res, {
      query,
      results,
      count: results.length,
      limit,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/context/quick") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (!query) {
      error(res, "Search query (q) is required", 400);
      return true;
    }
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      QUICK_CONTEXT_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      QUICK_CONTEXT_MAX_LIMIT,
    );

    const [memories, documents] = await Promise.all([
      searchMemoryNotes(runtime, roomId, query, limit),
      searchDocuments(runtime, query, limit),
    ]);

    const prompt = buildQuickContextPrompt({ query, memories, documents });
    let answer = "I couldn't generate a quick answer right now.";
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const text = typeof response === "string" ? response : String(response);
    if (text.trim()) {
      answer = text.trim();
    }

    json(res, {
      query,
      answer,
      memories,
      documents,
    });
    return true;
  }

  // ── Memory Viewer endpoints ───────────────────────────────────────────

  if (method === "GET" && pathname === "/api/memories/feed") {
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_FEED_DEFAULT_LIMIT,
    );
    const limit = Math.min(Math.max(requestedLimit, 1), MEMORY_FEED_MAX_LIMIT);
    // A cursor is a createdAt millisecond timestamp, so only its canonical
    // decimal form is a valid value. Bare Number() coercion admitted
    // whitespace (" " -> 0, silently emptying the feed as an epoch cursor)
    // and hex/exponent forms; parseCanonicalInteger distinguishes an absent
    // cursor (undefined) from junk ("invalid"), which 400s like the `type`
    // guard below.
    const before = parseCanonicalInteger(url.searchParams.get("before"));
    if (before === "invalid") {
      error(res, "before must be a Unix timestamp in milliseconds", 400);
      return true;
    }
    const beforeIdParam = url.searchParams.get("beforeId");
    if (
      beforeIdParam !== null &&
      (before === undefined || !UUID_REGEX.test(beforeIdParam))
    ) {
      error(res, "beforeId must be a UUID paired with before", 400);
      return true;
    }
    const tableFilter = parseMemoryTableFilter(url.searchParams.get("type"));
    if (!tableFilter.ok) {
      error(res, tableFilter.message, 400);
      return true;
    }
    const tables = tableFilter.tables;

    const allMemories = await fetchMemoriesFromTables(runtime, {
      tables,
      target: limit + 1,
      before,
      beforeId: beforeIdParam === null ? undefined : (beforeIdParam as UUID),
    });

    allMemories.sort(byNewestFirst);
    const items = allMemories.slice(0, limit).map(memoryToBrowseItem);

    json(res, {
      memories: items,
      count: items.length,
      limit,
      hasMore: allMemories.length > limit,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/memories/browse") {
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_BROWSE_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MEMORY_BROWSE_MAX_LIMIT,
    );
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);
    const tableFilter = parseMemoryTableFilter(url.searchParams.get("type"));
    if (!tableFilter.ok) {
      error(res, tableFilter.message, 400);
      return true;
    }
    const tables = tableFilter.tables;
    const entityIdParam = url.searchParams.get("entityId");
    const entityIdsParam = url.searchParams.get("entityIds");
    const roomIdParam = url.searchParams.get("roomId");
    const searchQuery = url.searchParams.get("q")?.trim() ?? "";

    const entityIds: UUID[] | undefined = entityIdsParam
      ? (entityIdsParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean) as UUID[])
      : entityIdParam
        ? [entityIdParam as UUID]
        : undefined;

    const allMemories = await fetchMemoriesFromTables(runtime, {
      tables,
      entityIds,
      roomId: roomIdParam ? (roomIdParam as UUID) : undefined,
      searchQuery,
      target: offset + limit + 1,
    });

    allMemories.sort(byNewestFirst);
    const total = allMemories.length;
    const page = allMemories
      .slice(offset, offset + limit)
      .map(memoryToBrowseItem);

    json(res, {
      memories: page,
      total,
      // Adapter calls do not share a transactional snapshot, so even an
      // exhausted offset scan cannot promise an exact total under mutation.
      totalIsExact: false,
      hasMore: allMemories.length > offset + limit,
      limit,
      offset,
    });
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/memories/by-entity/")) {
    const primaryEntityId = decodePathComponent(
      pathname.slice("/api/memories/by-entity/".length),
      res,
      "entity identifier",
    );
    if (primaryEntityId === null) return true;
    if (!UUID_REGEX.test(primaryEntityId)) {
      error(res, "Invalid entity identifier.", 400);
      return true;
    }

    // Support multi-identity people: ?entityIds=id1,id2,id3
    // Falls back to the single path param if not provided.
    const entityIdsParam = url.searchParams.get("entityIds");
    const entityIds: UUID[] = entityIdsParam
      ? (entityIdsParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean) as UUID[])
      : [primaryEntityId as UUID];

    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_BROWSE_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MEMORY_BROWSE_MAX_LIMIT,
    );
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);
    const tableFilter = parseMemoryTableFilter(url.searchParams.get("type"));
    if (!tableFilter.ok) {
      error(res, tableFilter.message, 400);
      return true;
    }
    const tables = tableFilter.tables;

    const allMemories = await fetchMemoriesFromTables(runtime, {
      entityIds,
      tables,
      target: offset + limit + 1,
    });

    allMemories.sort(byNewestFirst);
    const total = allMemories.length;
    const page = allMemories
      .slice(offset, offset + limit)
      .map(memoryToBrowseItem);

    json(res, {
      entityId: primaryEntityId,
      memories: page,
      total,
      totalIsExact: false,
      hasMore: allMemories.length > offset + limit,
      limit,
      offset,
    });
    return true;
  }

  // ── Memory mutation by id ─────────────────────────────────────────────
  // DELETE /api/memories/:id and PATCH /api/memories/:id operate on the bare
  // id segment. Path matching only fires when the segment looks like a UUID,
  // which keeps the literal sibling routes (`feed`, `browse`, `stats`,
  // `by-entity/...`) unambiguous.

  const memoryIdMatch = /^\/api\/memories\/([^/]+)$/.exec(pathname);
  if (memoryIdMatch && (method === "DELETE" || method === "PATCH")) {
    const rawId = decodePathComponent(memoryIdMatch[1] ?? "", res, "memory id");
    if (rawId === null) return true;
    if (!UUID_REGEX.test(rawId)) {
      error(res, "Invalid memory id.", 400);
      return true;
    }
    const memoryId = rawId as UUID;
    const existing = await runtime.getMemoryById(memoryId);
    if (!existing) {
      error(res, "Memory not found.", 404);
      return true;
    }

    let patchedText: string | undefined;
    if (method === "PATCH") {
      const rawPat = await readJsonBody<Record<string, unknown>>(req, res);
      if (rawPat === null) return true;
      const parsedPat = PatchMemoryRequestSchema.safeParse(rawPat);
      if (!parsedPat.success) {
        error(
          res,
          parsedPat.error.issues[0]?.message ?? "text is required",
          400,
        );
        return true;
      }
      patchedText = parsedPat.data.text;
    }

    // Share the conversational persistence boundary with reply recovery and
    // normal turns. Re-read after acquiring it so a queued edit never restores
    // old content or a row deleted by the turn that held the lease before us.
    return runtime.roomHandlerQueue.withLease(existing.roomId, async () => {
      const current = await runtime.getMemoryById(memoryId);
      if (!current) {
        error(res, "Memory not found.", 404);
        return true;
      }
      if (current.roomId !== existing.roomId) {
        error(res, "Memory room changed. Reload and try again.", 409);
        return true;
      }
      if (method === "DELETE") {
        await runtime.deleteMemory(memoryId);
        invalidateMemorySearchCache(runtime, current.roomId);
        json(res, { deleted: true, id: memoryId });
        return true;
      }

      // PATCH updates content and its embedding atomically. Generate first so
      // an embedding failure leaves the stored memory unchanged.
      const text = patchedText as string;
      const existingContent =
        (current.content as Record<string, unknown> | undefined) ?? {};
      const nextContent = { ...existingContent, text };

      let embedding: number[];
      try {
        embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
          text,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        error(res, `Failed to regenerate embedding: ${detail}`, 500);
        return true;
      }
      if (!Array.isArray(embedding) || embedding.length === 0) {
        error(res, "Embedding model returned no vector.", 500);
        return true;
      }

      await runtime.updateMemory({
        id: memoryId,
        content: nextContent,
        embedding,
      });
      invalidateMemorySearchCache(runtime, current.roomId);

      const updated = await runtime.getMemoryById(memoryId);
      json(res, {
        updated: true,
        id: memoryId,
        // Recovery evidence and credentials stay server-local even when an
        // operator edits the text of their owning memory through the dashboard.
        memory: projectCompleteToolValueForModel(
          updated,
          composeToolDiagnosticRedactor(runtime),
        ),
      });
      return true;
    });
  }

  if (method === "GET" && pathname === "/api/memories/stats") {
    const counts: Record<string, number> = {};
    let total = 0;

    for (const tableName of MEMORY_TABLE_NAMES) {
      // Exact count straight from the store. The previous implementation
      // fetched getMemories({ limit: 10000 }).length per table, which capped
      // every larger table at exactly 10,000 and reported the truncated value
      // as success — a silent window that violates the repo's no-silent-drop
      // invariant once any table exceeds the cap.
      const count = await runtime.countMemories({
        agentId: runtime.agentId as UUID,
        tableName,
      });
      counts[tableName] = count;
      total += count;
    }

    json(res, { total, byType: counts, totalIsExact: true });
    return true;
  }

  return false;
}
