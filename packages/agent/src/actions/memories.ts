/**
 * MEMORY action: model-driven create/search/update/delete over the agent's
 * stored memories. Reads MUST match the scope the FACTS provider uses —
 * identity-cluster-expanded entity ids — or a fact the provider surfaces
 * reads back as "0 stored items" here, and deletion becomes unreachable.
 * All model-supplied ids are parsed before touching the database so a bad
 * id becomes a clean handled result, never a raw SQL error in model context.
 */
import { createHash } from "node:crypto";
import type {
  Action,
  ActionResult,
  EffectReceipt,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  buildFactKeywordsForStorage,
  MemoryType as CoreMemoryType,
  ElizaError,
  factClaimsEquivalent,
  getActionReplyOwner,
  getRelatedEntityIds,
  inflectionTermKeys,
  isActiveMemoryEvidence,
  logger,
  ModelType,
  readStoredFactKeywords,
  toWellFormedUnicode,
  unwrapUserMessageText,
  validateUuid,
} from "@elizaos/core";

const MEMORY_OPS = ["create", "search", "update", "delete"] as const;

/** Update/delete enforce alternative selectors at the handler boundary. */
const MEMORY_MISSING_TARGET_MESSAGE =
  'A valid memoryId or nonempty query is required. Use a memoryId returned by a previous search, or quote the user\'s own words in "query", e.g. {"action":"delete","query":"favorite tea","confirm":true}. For update, keep action:"update" and include replacement "text".';
type MemoryOp = (typeof MEMORY_OPS)[number];

const MEMORY_TYPES = ["messages", "memories", "facts", "documents"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];
type MemoryQueryMode = "keywords" | "literal";
const FORGET_BY_QUERY_TABLES: readonly MemoryType[] = ["facts", "memories"];

const UUID_SCHEMA_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

interface MemoryParams {
  action?: MemoryOp;
  op?: MemoryOp;
  subaction?: MemoryOp;
  text?: string;
  kind?: string;
  tags?: string[];
  type?: MemoryType;
  entityId?: string;
  author?: "requester" | "assistant" | "any";
  roomId?: string;
  query?: string;
  queryMode?: MemoryQueryMode;
  limit?: number;
  offset?: number;
  snapshot?: string;
  memoryId?: string;
  confirm?: boolean;
}

interface MemoryListItem {
  /** Historical/review evidence remains searchable but is never presented as an active claim. */
  evidenceStatus?: "inactive";
  id: string;
  type: MemoryType;
  text: string;
  entityId: string | null;
  roomId: string | null;
  agentId: string | null;
  createdAt: number;
}

const SEARCH_QUERY_STOP_WORDS = new Set([
  "a",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
  "their",
  "his",
  "her",
  "us",
  "its",
  // Subject and naming fillers that never discriminate a saved fact: the row
  // binds the subject through its entity, and "named"/"called" only introduce
  // the value rather than distinguishing the stored relationship.
  "user",
  "users",
  "named",
  // Imperatives and memory verbs the planner copies from the user's sentence
  // ("remember that my favorite tea is yerba" → forget-by-query, live
  // 2026-09-10): they never appear in the stored fact, and delete needs every
  // remaining term to match, so one such word sank an otherwise exact hit.
  "remember",
  "remembered",
  "forget",
  "forgot",
  "recall",
  "note",
  "noted",
  "save",
  "saved",
  "store",
  "stored",
  "please",
  "know",
  "knew",
  "said",
  "told",
  "mentioned",
  "called",
]);

/**
 * A stored fact in the user's terms: whitespace-collapsed, possessives
 * rewritten to second person. Only possessives are rewritten ("user's" / "my"
 * → "your"); subject rewrites would need verb agreement ("the user prefers" →
 * "you prefer") and are left as-is, so a first-person "I" keeps its capital.
 */
function spokenMemoryText(factText: string): string {
  return toWellFormedUnicode(factText)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:the )?user'?s\b/i, "your")
    .replace(/\bthe user'?s\b/gi, "your")
    .replace(/^my\b/i, "your");
}

/**
 * A sentence the user can see verbatim for a completed memory mutation. Stored
 * facts are third person ("User's favorite tea is yerba."); the reply speaks to
 * the user. With `verifiedUserFacing` + `turnComplete` the planner loop skips
 * its post-tool evaluator round (1.3–2.5 s, ~15K tokens on the VPS) for a
 * single-tool turn and delivers this line as the reply.
 */
export function memoryUserFacingLine(verb: string, factText: string): string {
  const spoken = spokenMemoryText(factText);
  const body =
    spoken && !/^I\b/.test(spoken)
      ? spoken.charAt(0).toLowerCase() + spoken.slice(1)
      : spoken;
  const terminated = /[.!?]$/.test(body) ? body : `${body}.`;
  return body ? `${verb}: ${terminated}` : `${verb}.`;
}

/** Longest candidate excerpt quoted in an ambiguous-query question. */
const AMBIGUOUS_MEMORY_EXCERPT_CHARS = 160;

/**
 * The user-facing half of an ambiguous-query refusal: the candidate TEXTS in
 * the user's terms, never record ids. `text` keeps the id list for the planner
 * (which resolves the choice by memoryId); this question is what the planner
 * loop may relay verbatim when the planner cannot resolve it and keeps
 * re-sending the same query (live 2026-09-13 tj-f1579f952d5d21: the
 * repeated-failure limit ended that turn with a generic apology).
 */
export function ambiguousMemoryUserFacingText(
  verb: "forget" | "update",
  candidates: readonly Pick<MemoryListItem, "text">[],
): string {
  const distinct = [
    ...new Set(candidates.map((item) => spokenMemoryText(item.text))),
  ].filter((text) => text.length > 0);
  const listed = distinct
    .map((text) =>
      text.length > AMBIGUOUS_MEMORY_EXCERPT_CHARS
        ? `"${text.slice(0, AMBIGUOUS_MEMORY_EXCERPT_CHARS - 1)}…"`
        : `"${text}"`,
    )
    .join("; ");
  const count =
    distinct.length === 1
      ? "one saved memory"
      : `${distinct.length} saved memories`;
  return `That matches ${count}: ${listed}. Which one should I ${verb}?`;
}

function fail(
  text: string,
  error: string,
  context?: Record<string, unknown>,
): ActionResult {
  return { success: false, text, data: { error, ...context } };
}

type UuidParamName = "entityId" | "roomId" | "memoryId" | "author";

type ParsedUuidParam =
  | { ok: true; id: UUID | undefined }
  | { ok: false; result: ActionResult };

// error-policy:J3 model-supplied ids arrive as free text ("general", partial
// uuids); parsing before any query keeps drizzle from throwing — and from
// echoing the failed SQL statement back into model context.
function parseUuidParam(
  value: string | undefined,
  name: UuidParamName,
): ParsedUuidParam {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: true, id: undefined };
  const id = validateUuid(trimmed);
  if (!id) {
    return {
      ok: false,
      result: fail(
        `${name} "${trimmed}" is not a valid UUID. Omit it or use an id from a previous search result.`,
        "MEMORY_INVALID_UUID",
      ),
    };
  }
  return { ok: true, id };
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Planners that only have `query` available put a record id there when they
 * mean "this memory"; a UUID-shaped query with no memoryId is that id.
 */
function adoptUuidQueryAsMemoryId(params: MemoryParams): MemoryParams {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (params.memoryId || !UUID_SHAPE.test(query)) return params;
  return { ...params, memoryId: query, query: undefined };
}

function normalizeMemoryOp(params: MemoryParams): MemoryOp | undefined {
  const candidate = params.action ?? params.subaction ?? params.op;
  return candidate && MEMORY_OPS.includes(candidate) ? candidate : undefined;
}

/** Planner spellings of "no memoryId"; the schema strips them before the handler. */
const MEMORY_ID_OMISSION_SENTINELS = ["", "null", "undefined"] as const;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Structural dispatch for a MEMORY call that omitted `action`, consulted by
 * the planner executor before it delegates the umbrella to the sub-planner
 * (live 2026-09-14 tj-22eb87cbbbfac0: "remember that my favorite tea is
 * yerba" → `MEMORY {text, kind, tags}` → a second planner model call before
 * create ran). Names the promoted child only when the arguments can mean one
 * operation under this action's own contract: a legacy discriminator
 * (`op`/`subaction`, which this description's `op:create` wording invites) is
 * honored as declared; otherwise text without a target is a create, a target
 * with replacement text an update, a target with confirm a delete, and a bare
 * query a search. Anything else — including a target with neither text nor
 * confirm, which may be a delete the planner forgot to confirm — returns
 * undefined and keeps the sub-planner. A delete is never named without
 * `confirm: true`, however the operation was spelled.
 */
export function inferMemorySubaction(
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  const text = hasNonEmptyString(params.text);
  const memoryId =
    hasNonEmptyString(params.memoryId) &&
    !(MEMORY_ID_OMISSION_SENTINELS as readonly string[]).includes(
      params.memoryId.trim().toLowerCase(),
    );
  const query = hasNonEmptyString(params.query);
  const confirm = params.confirm === true;
  let op = normalizeMemoryOp(params as MemoryParams);
  if (!op) {
    const target = memoryId || query;
    if (text && !target) {
      op = "create";
    } else if (target && text) {
      op = "update";
    } else if (target && confirm) {
      op = "delete";
    } else if (query && !memoryId && !confirm) {
      op = "search";
    }
  }
  if (!op || (op === "delete" && !confirm)) return undefined;
  return `MEMORY_${op.toUpperCase()}`;
}

/**
 * Normalize complete 12-hour clock tokens only. Dotted identifiers and
 * numeric punctuation retain their mutation-target identity.
 */
function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(
      /(?<![\p{L}\p{N}_.:/-])((?:0?[1-9]|1[0-2])(?::[0-5]\d)?)[ \t]*([ap])\.?m\.?(?![\p{L}\p{N}_.:/-])/gu,
      "$1$2m",
    );
}

/** Distinct content terms of a query: length >= 2, stop words removed. */
function scoreQueryTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeMatchText(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(
          (term) => term.length >= 2 && !SEARCH_QUERY_STOP_WORDS.has(term),
        ),
    ),
  ];
}

function scoreText(text: string, query: string): number {
  const t = normalizeMatchText(text);
  const q = normalizeMatchText(query);
  if (!t || !q) return 0;
  const terms = scoreQueryTerms(q);
  const whole = t.includes(q) ? 1 : 0;
  if (terms.length === 0) return whole;
  const textTerms = new Set(
    t
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .flatMap(inflectionTermKeys),
  );
  let matches = 0;
  for (const term of terms) {
    if (inflectionTermKeys(term).some((key) => textTerms.has(key)))
      matches += 1;
  }
  const requiredMatches = terms.length >= 3 ? 2 : 1;
  if (whole === 0 && matches < requiredMatches) return 0;
  return whole + matches / terms.length;
}

function searchableMemoryText(memory: Memory): string {
  const text = memory.content.text ?? "";
  const attachments = (memory.content.attachments ?? []).map((attachment) => {
    const label =
      attachment.filename ?? attachment.title ?? attachment.id ?? "attachment";
    const mediaType = attachment.mimeType ?? attachment.contentType;
    const readableContent = attachment.text ?? attachment.description;
    return `[attachment: ${label}${mediaType ? `; ${mediaType}` : ""}${readableContent ? `; ${readableContent}` : ""}]`;
  });
  return [text, ...attachments].filter(Boolean).join(" ");
}

function toListItem(memory: Memory, type: MemoryType): MemoryListItem {
  return {
    id: memory.id ?? "",
    type,
    text: searchableMemoryText(memory),
    ...(!isActiveMemoryEvidence(memory)
      ? { evidenceStatus: "inactive" as const }
      : {}),
    entityId: memory.entityId,
    roomId: memory.roomId,
    agentId: memory.agentId ?? null,
    createdAt: memory.createdAt ?? 0,
  };
}

/**
 * Confidence for facts the user explicitly asked to store. Higher than the
 * reflection extractor's 0.7 — "remember this" is a direct instruction, not
 * an inferred claim.
 */
const EXPLICIT_MEMORY_CONFIDENCE = 0.95;

type MemoryMutationOperation =
  | "memory.create"
  | "memory.update"
  | "memory.delete";

/**
 * Applied receipt for a durable memory mutation. With `transcriptVisibility:
 * "internal"` and `data.replyContext`, the planner loop's grounded receipt
 * gate can phrase the outcome from these facts (a ~350 ms render) instead of
 * spending a full evaluator call (live 2026-09-05 23:52: 912 ms) to say
 * "Got it". Failures and confirmation refusals stay plain results.
 */
function memoryMutationReceipt(args: {
  operation: MemoryMutationOperation;
  memoryId: string;
  observedAt: string;
}): EffectReceipt {
  const digest = createHash("sha256")
    .update([args.operation, args.memoryId, args.observedAt].join("|"))
    .digest("hex");
  return {
    receiptId: `memory-mutation-receipt-v1:${digest}`,
    operation: args.operation,
    resource: { kind: "memory.fact", id: args.memoryId },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: args.observedAt,
    outcome: "applied",
    commit: {
      kind: "durable",
      id: args.memoryId,
      committedAt: args.observedAt,
    },
  };
}

function memoryReplyContext(args: {
  scenario: string;
  facts: string;
  context?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    domain: "memory",
    intent: "",
    scenario: args.scenario,
    facts: args.facts,
    context: args.context ?? {},
  };
}

/**
 * Stage-1 persists `extract.facts` as lapsing `current/uncategorized` rows in
 * parallel with the planner. When the same user message also routes to an
 * explicit MEMORY create, the two writes race and the FACTS provider renders
 * one claim twice. A Stage-1 row extracted from THIS message (its
 * `metadata.messageId`) that lexically covers the explicit text is upgraded in
 * place instead of getting a durable twin. Rows from other messages, other
 * authors, other rooms, or with the opposite polarity are never merged:
 * lexical overlap alone cannot tell a restatement from a changed value.
 */
const STAGE_FACT_SOURCE = "facts_and_relationships_stage";

function metadataRecord(memory: Memory): Record<string, unknown> {
  const meta = memory.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

async function findSameMessageStageFact(
  runtime: IAgentRuntime,
  message: Memory,
  text: string,
): Promise<(Memory & { id: UUID }) | null> {
  if (!message.id || !message.roomId || !message.entityId) return null;
  const rows = await runtime.getMemories({
    tableName: "facts",
    roomId: message.roomId,
    entityId: message.entityId,
    authorEntityIds: [message.entityId],
    unique: false,
  });
  for (const row of rows) {
    const meta = metadataRecord(row);
    if (
      !row.id ||
      row.entityId !== message.entityId ||
      row.roomId !== message.roomId ||
      meta.source !== STAGE_FACT_SOURCE ||
      meta.kind !== "current" ||
      meta.messageId !== message.id ||
      // A fact about someone this room could not resolve sits under the author
      // only as a fallback; it is not the author's own claim.
      meta.subjectResolved === false
    ) {
      continue;
    }
    const rowText =
      typeof row.content.text === "string" ? row.content.text : "";
    // Only the identical claim (same content words, same polarity) is absorbed;
    // any paraphrase that adds or drops a content word stays a separate row.
    if (factClaimsEquivalent(text, rowText)) {
      return row as Memory & { id: UUID };
    }
  }
  return null;
}

async function upgradeStageFact(
  runtime: IAgentRuntime,
  stageFact: Memory & { id: UUID },
  next: {
    text: string;
    kind: string | undefined;
    tags: string[];
    keywords: string[];
    createdAt: number;
  },
): Promise<ActionResult | null> {
  const previousMeta = metadataRecord(stageFact);
  const previousText =
    typeof stageFact.content.text === "string" ? stageFact.content.text : "";
  const previousCategory =
    typeof previousMeta.category === "string" &&
    previousMeta.category !== "uncategorized"
      ? previousMeta.category
      : undefined;
  let embedding: number[] | undefined;
  if (
    previousText !== next.text &&
    Array.isArray(stageFact.embedding) &&
    stageFact.embedding.length > 0
  ) {
    const regenerated = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: next.text,
    });
    if (!Array.isArray(regenerated) || regenerated.length === 0) {
      return fail(
        "Embedding model returned no vector.",
        "MEMORY_EMBEDDING_FAILED",
      );
    }
    embedding = regenerated;
  }
  const updated = await runtime.updateMemory({
    id: stageFact.id,
    content: { ...stageFact.content, text: next.text, source: "MEMORY" },
    metadata: {
      ...previousMeta,
      type: CoreMemoryType.CUSTOM,
      source: "MEMORY",
      promotedFrom: STAGE_FACT_SOURCE,
      ...(previousText && previousText !== next.text ? { previousText } : {}),
      kind: "durable",
      category: next.kind ?? previousCategory ?? "user_note",
      confidence: EXPLICIT_MEMORY_CONFIDENCE,
      keywords: [
        ...new Set([...readStoredFactKeywords(stageFact), ...next.keywords]),
      ],
      verificationStatus: "self_reported",
      lastConfirmedAt: new Date(next.createdAt).toISOString(),
    } as Memory["metadata"],
    ...(embedding ? { embedding } : {}),
  });
  if (updated === false) {
    // The adapter declined the in-place upgrade; the explicit request still
    // has to land, so the caller stores a fresh durable row instead.
    logger.warn(
      { memoryId: stageFact.id },
      "[MEMORY] in-place upgrade of the Stage-1 fact was rejected; storing a new durable row",
    );
    return null;
  }
  const observedAt = new Date(next.createdAt).toISOString();
  return {
    success: true,
    transcriptVisibility: "internal",
    text: `Stored memory ${stageFact.id}.`,
    userFacingText: memoryUserFacingLine("Saved", next.text),
    verifiedUserFacing: true,
    turnComplete: true,
    values: {
      memoryId: stageFact.id,
      kind: next.kind ?? null,
      tagCount: next.tags.length,
      upgradedStageFact: true,
    },
    effectReceipts: [
      memoryMutationReceipt({
        operation: "memory.create",
        memoryId: stageFact.id,
        observedAt,
      }),
    ],
    data: {
      actionName: "MEMORY",
      op: "create" as const,
      memoryId: stageFact.id,
      text: next.text,
      kind: next.kind ?? null,
      tags: next.tags,
      createdAt: next.createdAt,
      upgradedFrom: STAGE_FACT_SOURCE,
      replyContext: memoryReplyContext({
        scenario: "memory_stored",
        facts: `Saved to durable memory: "${next.text}".${next.kind ? ` Category: ${next.kind}.` : ""}`,
        context: { memoryId: stageFact.id, kind: next.kind ?? null },
      }),
    },
  };
}

async function doCreate(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
): Promise<ActionResult> {
  // Live 2026-09-06: the planner repeatedly put the content to remember in
  // `query` (a search/delete field that means nothing on create) and left `text`
  // empty, three identical calls in a row until the turn errored. The field
  // name is a structural slip, not a different request: use it, say so.
  const explicitText =
    typeof params.text === "string" ? params.text.trim() : "";
  const queryAsText =
    !explicitText && typeof params.query === "string"
      ? params.query.trim()
      : "";
  if (queryAsText) {
    logger.warn(
      { queryLength: queryAsText.length },
      "[MEMORY] create arrived with the content in `query`; storing it as text",
    );
  }
  const impliedText =
    !explicitText && !queryAsText
      ? impliedCreateTextFromMessage(runtime, message)
      : undefined;
  const text = explicitText || queryAsText || impliedText || "";
  if (!text) {
    // Nothing was stored, so the loop may relay this question when the
    // planner keeps omitting the content (live 2026-09-14: three identical
    // MEMORY creates without text ended in "I hit a snag").
    return {
      ...fail(
        'text is required for create: put the content to remember in the "text" argument (query is only for search, update and delete lookups).',
        "MEMORY_MISSING_TEXT",
      ),
      userFacingText: "What would you like me to remember?",
      data: {
        error: "MEMORY_MISSING_TEXT",
        readOnlyOperation: true,
      },
    };
  }

  const kind =
    typeof params.kind === "string" && params.kind.trim()
      ? params.kind.trim()
      : undefined;
  const tags = Array.isArray(params.tags)
    ? params.tags.filter(
        (t): t is string => typeof t === "string" && t.trim().length > 0,
      )
    : [];

  const agentId = runtime.agentId as UUID;
  const createdAt = Date.now();
  const keywords = buildFactKeywordsForStorage(tags, text, kind ?? "");
  const stageFact = await findSameMessageStageFact(runtime, message, text);
  if (stageFact) {
    const upgraded = await upgradeStageFact(runtime, stageFact, {
      text,
      kind,
      tags,
      keywords,
      createdAt,
    });
    if (upgraded) return upgraded;
  }
  const memoryId = crypto.randomUUID() as UUID;

  // Persist where the recall read path looks. The FACTS provider — the only
  // default-on read path for user facts — scans the `facts` table scoped to
  // the conversation room and the speaker's entity ids. The previous write
  // (agent-scoped `memories` table in a synthetic manual-memories room) was
  // invisible to it, so the agent acked "I'll remember" and then denied
  // knowing the fact on the next turn.
  await runtime.createMemory(
    {
      id: memoryId,
      entityId: message.entityId ?? agentId,
      agentId,
      roomId: message.roomId,
      content: { text, source: "MEMORY" },
      metadata: {
        type: CoreMemoryType.CUSTOM,
        source: "MEMORY",
        ...(message.id ? { messageId: message.id } : {}),
        kind: "durable",
        category: kind ?? "user_note",
        confidence: EXPLICIT_MEMORY_CONFIDENCE,
        keywords: tags,
        verificationStatus: "self_reported",
        lastConfirmedAt: new Date(createdAt).toISOString(),
      },
      createdAt,
    } as Memory,
    "facts",
    true,
  );

  return {
    success: true,
    transcriptVisibility: "internal",
    text: `Stored memory ${memoryId}.`,
    userFacingText: memoryUserFacingLine("Saved", text),
    verifiedUserFacing: true,
    turnComplete: true,
    values: { memoryId, kind: kind ?? null, tagCount: tags.length },
    effectReceipts: [
      memoryMutationReceipt({
        operation: "memory.create",
        memoryId,
        observedAt: new Date(createdAt).toISOString(),
      }),
    ],
    data: {
      actionName: "MEMORY",
      op: "create" as const,
      memoryId,
      text,
      kind: kind ?? null,
      tags,
      createdAt,
      replyContext: memoryReplyContext({
        scenario: "memory_stored",
        facts: `Saved to durable memory: "${text}".${kind ? ` Category: ${kind}.` : ""}`,
        context: { memoryId, kind: kind ?? null },
      }),
    },
  };
}

interface MemoryCandidate {
  memory: Memory;
  type: MemoryType;
}

interface CandidateScan {
  matches: MemoryCandidate[];
  tables: readonly MemoryType[];
  scanned: number;
}

const COMPLETE_MEMORY_PAGE_SIZE = 10_000;
export const MAX_MEMORY_PAGE_ITEMS = 50;
/** Page size when an unbounded search exceeds MAX_MEMORY_PAGE_ITEMS. */
const DEFAULT_MEMORY_PAGE_ITEMS = 20;
export const MAX_MEMORY_ACTION_RESULT_CHARS = 256 * 1024;

function traversalError(
  code: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(
    "Memory traversal could not prove a complete snapshot",
    {
      code,
      context,
    },
  );
}

function compareMemoryTuple(left: Memory, right: Memory): number {
  const leftCreatedAt = left.createdAt;
  const rightCreatedAt = right.createdAt;
  if (
    typeof leftCreatedAt !== "number" ||
    typeof rightCreatedAt !== "number" ||
    !Number.isSafeInteger(leftCreatedAt) ||
    !Number.isSafeInteger(rightCreatedAt)
  ) {
    throw traversalError("MEMORY_TRAVERSAL_CURSOR_INVALID", {
      leftId: left.id,
      rightId: right.id,
    });
  }
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
  return String(right.id)
    .toLowerCase()
    .localeCompare(String(left.id).toLowerCase());
}

function memoryPageSnapshot(items: readonly MemoryListItem[]): string {
  const hash = createHash("sha256");
  for (const item of items) {
    const canonical = JSON.stringify([
      item.id,
      item.type,
      item.text,
      item.entityId,
      item.roomId,
      item.agentId,
      item.createdAt,
      item.evidenceStatus ?? null,
    ]);
    hash.update(String(Buffer.byteLength(canonical)));
    hash.update(":");
    hash.update(canonical);
  }
  return hash.digest("hex");
}

async function scanCompleteMemoryTable(
  runtime: IAgentRuntime,
  tableName: MemoryType,
  roomId: UUID | undefined,
): Promise<Memory[]> {
  const memories: Memory[] = [];
  const seen = new Set<string>();
  let cursor: { createdAt: number; id: UUID } | undefined;
  let previous: Memory | undefined;

  while (true) {
    const page = await runtime.getMemories({
      agentId: runtime.agentId as UUID,
      roomId,
      tableName,
      limit: COMPLETE_MEMORY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      orderBy: "createdAt",
      orderDirection: "desc",
      includeEmbedding: false,
    });
    if (page.length > COMPLETE_MEMORY_PAGE_SIZE) {
      throw traversalError("MEMORY_TRAVERSAL_PAGE_INVALID", {
        tableName,
        pageLength: page.length,
      });
    }
    if (page.length === 0) break;

    for (const memory of page) {
      const id = validateUuid(memory.id);
      if (!id || !Number.isSafeInteger(memory.createdAt)) {
        throw traversalError("MEMORY_TRAVERSAL_CURSOR_INVALID", {
          tableName,
          memoryId: memory.id,
          createdAt: memory.createdAt,
        });
      }
      if (seen.has(id)) {
        throw traversalError("MEMORY_TRAVERSAL_REPEATED_ROW", {
          tableName,
          memoryId: id,
        });
      }
      if (previous && compareMemoryTuple(previous, memory) >= 0) {
        throw traversalError("MEMORY_TRAVERSAL_ORDER_INVALID", {
          tableName,
          previousId: previous.id,
          memoryId: id,
        });
      }
      seen.add(id);
      memories.push(memory);
      previous = memory;
    }

    if (page.length < COMPLETE_MEMORY_PAGE_SIZE) break;
    const last = page.at(-1);
    const lastId = validateUuid(last?.id);
    if (!last || !lastId || !Number.isSafeInteger(last.createdAt)) {
      throw traversalError("MEMORY_TRAVERSAL_CURSOR_INVALID", { tableName });
    }
    const nextCursor = { createdAt: last.createdAt as number, id: lastId };
    if (
      cursor &&
      cursor.createdAt === nextCursor.createdAt &&
      cursor.id === nextCursor.id
    ) {
      throw traversalError("MEMORY_TRAVERSAL_CURSOR_STALLED", {
        tableName,
        cursor,
      });
    }
    cursor = nextCursor;
  }
  return memories;
}

async function readStableCompleteMemoryTable(
  runtime: IAgentRuntime,
  tableName: MemoryType,
  roomId: UUID | undefined,
): Promise<Memory[]> {
  const countParams = {
    agentId: runtime.agentId as UUID,
    ...(roomId ? { roomId } : {}),
    tableName,
  };
  const before = await runtime.countMemories(countParams);
  const first = await scanCompleteMemoryTable(runtime, tableName, roomId);
  const between = await runtime.countMemories(countParams);
  const second = await scanCompleteMemoryTable(runtime, tableName, roomId);
  const after = await runtime.countMemories(countParams);
  const firstIds = first.map((memory) => memory.id);
  const secondIds = second.map((memory) => memory.id);
  if (
    !Number.isSafeInteger(before) ||
    before < 0 ||
    before !== between ||
    before !== after ||
    first.length !== before ||
    second.length !== before ||
    firstIds.some((id, index) => id !== secondIds[index])
  ) {
    throw traversalError("MEMORY_TRAVERSAL_INVENTORY_CHANGED", {
      tableName,
      before,
      between,
      after,
      firstLength: first.length,
      secondLength: second.length,
    });
  }
  return second;
}

/**
 * Shared read scope for search and delete-by-query. The entity filter is
 * identity-cluster expanded via getRelatedEntityIds — the same expansion the
 * FACTS provider applies — so a fact stored under a cluster sibling of the
 * requested entityId is in scope. A strict-equality filter here made the same
 * fact the provider had just surfaced report as "0 stored items".
 */
async function collectCandidates(
  runtime: IAgentRuntime,
  scope: {
    type?: MemoryType;
    /** Explicit table set; wins over `type` and the full default. */
    tables?: readonly MemoryType[];
    entityId?: UUID;
    roomId?: UUID;
    query?: string;
    queryMode?: MemoryQueryMode;
  },
): Promise<CandidateScan> {
  const tables: readonly MemoryType[] =
    scope.tables ?? (scope.type ? [scope.type] : MEMORY_TYPES);
  const collected: MemoryCandidate[] = [];

  for (const tableName of tables) {
    const memories = await readStableCompleteMemoryTable(
      runtime,
      tableName,
      scope.roomId,
    );
    for (const m of memories) collected.push({ memory: m, type: tableName });
  }

  let filtered = collected.filter((c) => {
    return searchableMemoryText(c.memory).trim().length > 0;
  });

  if (scope.entityId) {
    const clusterIds = new Set<string>(
      await getRelatedEntityIds(runtime, scope.entityId),
    );
    filtered = filtered.filter(
      (c) => c.memory.entityId != null && clusterIds.has(c.memory.entityId),
    );
  }

  if (scope.query) {
    const query = scope.query;
    filtered = filtered.filter((c) => {
      const text = searchableMemoryText(c.memory);
      return scope.queryMode === "literal"
        ? text.includes(query)
        : scoreText(text, query) > 0;
    });
  }

  filtered.sort((a, b) => {
    if (scope.query && scope.queryMode !== "literal") {
      const leftText = searchableMemoryText(a.memory);
      const rightText = searchableMemoryText(b.memory);
      const relevance =
        scoreText(rightText, scope.query) - scoreText(leftText, scope.query);
      if (relevance !== 0) return relevance;
    }
    return (b.memory.createdAt ?? 0) - (a.memory.createdAt ?? 0);
  });
  return { matches: filtered, tables, scanned: collected.length };
}

/** Names every narrowing that was applied, so an empty result can say why. */
function describeSearchScope(scope: {
  type?: MemoryType;
  entityId?: UUID;
  roomId?: UUID;
  query?: string;
  queryMode?: MemoryQueryMode;
}): string {
  const parts: string[] = [];
  if (scope.query) parts.push(`query="${scope.query}"`);
  if (scope.queryMode === "literal") parts.push("queryMode=literal");
  if (scope.type) parts.push(`type=${scope.type}`);
  if (scope.entityId) parts.push(`entityId=${scope.entityId}`);
  if (scope.roomId) parts.push(`roomId=${scope.roomId}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** States the complete storage scope proven before applying caller filters. */
function describeCompleteScan(scan: CandidateScan): string {
  return `Scanned all ${scan.scanned} stored row(s) across ${scan.tables.join(", ")} before filtering.`;
}

async function doSearch(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
): Promise<ActionResult> {
  if (
    params.queryMode !== undefined &&
    params.queryMode !== "keywords" &&
    params.queryMode !== "literal"
  ) {
    return fail(
      "queryMode must be keywords or literal.",
      "MEMORY_INVALID_QUERY_MODE",
    );
  }
  if (
    params.queryMode === "literal" &&
    (typeof params.query !== "string" || params.query.length === 0)
  ) {
    return fail(
      "Literal search requires a nonempty query copied exactly from the requested text.",
      "MEMORY_LITERAL_QUERY_REQUIRED",
    );
  }
  const author = params.author === "any" ? undefined : params.author;
  const type =
    author !== undefined
      ? "messages"
      : params.type && MEMORY_TYPES.includes(params.type)
        ? params.type
        : undefined;
  let authorId: UUID | undefined;
  if (author !== undefined) {
    if (author !== "requester" && author !== "assistant") {
      return fail(
        "author must be requester, assistant, or any.",
        "MEMORY_INVALID_AUTHOR",
      );
    }
    if (params.type !== undefined && params.type !== "messages") {
      return fail(
        "author applies only to messages.",
        "MEMORY_INVALID_AUTHOR_SCOPE",
      );
    }
    const resolved = parseUuidParam(
      author === "requester" ? message.entityId : runtime.agentId,
      "author",
    );
    if (!resolved.ok || !resolved.id) {
      return fail(
        "The requested author could not be resolved from this turn.",
        "MEMORY_AUTHOR_UNAVAILABLE",
      );
    }
    authorId = resolved.id;
    if (params.entityId !== undefined) {
      const explicit = parseUuidParam(params.entityId, "entityId");
      if (
        !explicit.ok ||
        explicit.id?.toLowerCase() !== authorId.toLowerCase()
      ) {
        return fail(
          "entityId conflicts with author. Use author alone for the current requester or assistant.",
          "MEMORY_AUTHOR_CONFLICT",
        );
      }
    }
  }
  // Read-only salvage (matrix F16): a mangled planner-copied UUID is an
  // unusable *filter*, and failing the whole search over it turns a
  // recoverable turn into a failed one. Searching without the filter is a
  // superset of the intended scope, so ignore the id and say so in the
  // result. Destructive ops keep parseUuidParam's hard fail — a mangled id
  // must never widen a delete's scope.
  const entityParam = parseUuidParam(params.entityId, "entityId");
  const roomParam = parseUuidParam(params.roomId, "roomId");
  const ignoredIdNotes: string[] = [];
  if (!entityParam.ok) {
    ignoredIdNotes.push(
      `ignored invalid entityId "${params.entityId?.trim()}" (searched all entities)`,
    );
  }
  if (!roomParam.ok) {
    ignoredIdNotes.push(
      `ignored invalid roomId "${params.roomId?.trim()}" (searched all rooms)`,
    );
  }
  const query =
    params.queryMode === "literal" ? params.query : params.query?.trim();
  const limit = params.limit;
  const offset = params.offset ?? 0;
  const requestedSnapshot = params.snapshot?.trim();
  if (
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (limit === undefined && offset !== 0) ||
    (offset > 0 && !requestedSnapshot)
  ) {
    return fail(
      "search limit must be a positive integer, and a continuation offset requires limit and snapshot.",
      "MEMORY_INVALID_PAGE",
    );
  }
  if (limit !== undefined && limit > MAX_MEMORY_PAGE_ITEMS) {
    return fail(
      `search limit ${limit} exceeds the maximum page size of ${MAX_MEMORY_PAGE_ITEMS}. Retry with a smaller limit.`,
      "MEMORY_PAGE_LIMIT_EXCEEDED",
      { requestedLimit: limit, maxLimit: MAX_MEMORY_PAGE_ITEMS },
    );
  }

  const scope = {
    type,
    entityId: authorId ?? (entityParam.ok ? entityParam.id : undefined),
    roomId: roomParam.ok ? roomParam.id : undefined,
    query,
    queryMode: params.queryMode,
  };
  const scan = await collectCandidates(runtime, scope);

  const allItems = scan.matches.map((candidate) =>
    toListItem(candidate.memory, candidate.type),
  );
  const totalMatches = allItems.length;
  const snapshot = memoryPageSnapshot(allItems);
  if (requestedSnapshot && requestedSnapshot !== snapshot) {
    return fail(
      "The snapshot does not match this search's ordered results. The records or filters may have changed. Restart at offset 0 WITHOUT snapshot, keeping the intended query, author and other filters. Do not remove filters to reuse an old snapshot. retryParameters contains the fresh search arguments.",
      "MEMORY_PAGE_SNAPSHOT_CHANGED",
      {
        retryParameters: {
          action: "search",
          ...(type ? { type } : {}),
          ...(params.author ? { author: params.author } : {}),
          ...(entityParam.ok && entityParam.id
            ? { entityId: entityParam.id }
            : {}),
          ...(scope.roomId ? { roomId: scope.roomId } : {}),
          ...(query ? { query } : {}),
          ...(params.queryMode === "literal" ? { queryMode: "literal" } : {}),
          ...(limit !== undefined ? { limit } : {}),
          offset: 0,
        },
      },
    );
  }
  // Candidates are ranked by relevance, so an unbounded search over a large
  // store answers with its best page rather than a refusal that costs the
  // planner another round (live 2026-09-14: "favorite tea" matched 406 rows).
  const autoPaged = limit === undefined && totalMatches > MAX_MEMORY_PAGE_ITEMS;
  const pageLimit = autoPaged
    ? Math.min(DEFAULT_MEMORY_PAGE_ITEMS, MAX_MEMORY_PAGE_ITEMS)
    : limit;
  const items =
    pageLimit === undefined
      ? allItems
      : allItems.slice(offset, offset + pageLimit);
  const nextOffset =
    pageLimit !== undefined && offset + items.length < totalMatches
      ? offset + items.length
      : undefined;
  // The trusted planner consumes structured results, so keep source bodies in
  // data once. Standalone/text-only callers retain their full text rendering.
  // Keeping strings structured also lets the model boundary redact credentials
  // before JSON escaping, without changing any stored source.
  const plannerOwnsReply = getActionReplyOwner(message.id) === "planner";
  const authorRole = (entityId: string | null): string => {
    if (entityId === runtime.agentId) return "assistant";
    return entityId !== null && entityId === message.entityId
      ? "requester"
      : "other speaker";
  };
  const records = plannerOwnsReply
    ? items.map((m) => ({
        ...m,
        createdAtIso: new Date(m.createdAt).toISOString(),
        ...(m.type === "messages"
          ? {
              authorRole: authorRole(m.entityId),
            }
          : {}),
      }))
    : items;
  const lines = plannerOwnsReply
    ? [
        "Complete source records are in data.memories; text contains the original source wording. Records with evidenceStatus=inactive are historical evidence, not current facts.",
      ]
    : items.map(
        (m) =>
          `- [${m.type}${m.evidenceStatus === "inactive" ? "; INACTIVE source evidence: historical record, not a current fact" : ""}] ${m.id} at ${new Date(m.createdAt).toISOString()}${m.type === "messages" ? ` [author=${authorRole(m.entityId)}; entityId=${m.entityId}]` : ""}: ${toWellFormedUnicode(m.text)}`,
      );
  const renderNote =
    pageLimit === undefined
      ? `Showing all ${items.length} match(es) found in the complete scan`
      : autoPaged
        ? `Showing the ${items.length} best-ranked match(es) of ${totalMatches} found in the complete scan (more than ${MAX_MEMORY_PAGE_ITEMS} matched, so the list is ranked by relevance; if narrowing the query, author or other filters, start at offset 0 without snapshot, since the snapshot below belongs only to the current filters)`
        : `Showing ${items.length} match(es) at offset ${offset} of ${totalMatches} found in the complete scan`;
  const continuationNote =
    nextOffset === undefined
      ? []
      : [
          `More matches remain. To continue losslessly, call MEMORY_SEARCH with the same filters, limit=${pageLimit}, offset=${nextOffset}, snapshot=${snapshot}.`,
        ];

  const result: ActionResult = {
    success: true,
    text: [
      `${renderNote} (filters: ${describeSearchScope(scope)}).`,
      ...(ignoredIdNotes.length > 0
        ? [`Note: ${ignoredIdNotes.join("; ")}.`]
        : []),
      describeCompleteScan(scan),
      ...(items.some((item) => item.type === "messages")
        ? [
            "Authorship matters: assistant replies are not original user statements. For the current requester's original correction, use author=requester and verify their message; do not call an assistant restatement the original correction.",
          ]
        : []),
      ...lines,
      ...continuationNote,
    ].join("\n"),
    values: {
      count: items.length,
      rendered: items.length,
      totalMatches,
      scanned: scan.scanned,
      offset,
      nextOffset: nextOffset ?? null,
      snapshot,
    },
    data: {
      actionName: "MEMORY",
      op: "search" as const,
      memories: records,
      totalMatches,
      scanned: scan.scanned,
      offset,
      nextOffset: nextOffset ?? null,
      snapshot,
    },
    promptData: {
      actionName: "MEMORY",
      op: "search" as const,
      totalMatches,
      rendered: items.length,
      scanned: scan.scanned,
      offset,
      nextOffset: nextOffset ?? null,
      snapshot,
    },
  };
  const serializedChars = JSON.stringify(result).length;
  if (serializedChars > MAX_MEMORY_ACTION_RESULT_CHARS) {
    if (pageLimit === undefined) {
      return fail(
        `The complete search result requires ${serializedChars} characters, exceeding the safe action-result budget of ${MAX_MEMORY_ACTION_RESULT_CHARS}. Retry with an explicit page limit.`,
        "MEMORY_SEARCH_REQUIRES_PAGINATION",
        {
          totalMatches,
          renderedChars: serializedChars,
          maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
          suggestedLimit: Math.min(20, MAX_MEMORY_PAGE_ITEMS),
          snapshot,
        },
      );
    }
    if (items.length === 1) {
      return fail(
        `Memory ${items[0].id} alone requires ${serializedChars} action-result characters, exceeding the safe budget of ${MAX_MEMORY_ACTION_RESULT_CHARS}. Narrow the search or use a provider with a larger input boundary.`,
        "MEMORY_RECORD_EXCEEDS_PAGE_BUDGET",
        {
          memoryId: items[0].id,
          renderedChars: serializedChars,
          maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
        },
      );
    }
    const suggestedLimit = Math.max(
      1,
      Math.min(
        items.length - 1,
        Math.floor(
          (items.length * MAX_MEMORY_ACTION_RESULT_CHARS) / serializedChars,
        ),
      ),
    );
    return fail(
      `The requested page requires ${serializedChars} action-result characters, exceeding the safe budget of ${MAX_MEMORY_ACTION_RESULT_CHARS}. Retry with limit=${suggestedLimit}.`,
      "MEMORY_PAGE_RESULT_TOO_LARGE",
      {
        requestedLimit: pageLimit,
        suggestedLimit,
        renderedChars: serializedChars,
        maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
        snapshot,
      },
    );
  }
  return result;
}

async function doUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
): Promise<ActionResult> {
  const memoryParam = parseUuidParam(params.memoryId, "memoryId");
  if (!memoryParam.ok) return memoryParam.result;
  const memoryId = memoryParam.id;
  const explicitQuery = params.query?.trim();
  const text = typeof params.text === "string" ? params.text.trim() : "";
  // A target-less update carrying replacement text is how the planner phrases
  // "remember that …" when it guesses a prior fact exists (live 2026-09-14:
  // three sub-planner rounds before it fell back to create). Resolve the
  // target from the user's own words; with no prior match the request is a
  // create and is stored as one.
  const impliedQuery =
    !memoryId && !explicitQuery
      ? mutationQueryFromMessage(runtime, message)
      : undefined;
  const query = explicitQuery || impliedQuery;
  if (!memoryId && !query) {
    return fail(MEMORY_MISSING_TARGET_MESSAGE, "MEMORY_MISSING_ID");
  }
  if (!text) return fail("text is required.", "MEMORY_MISSING_TEXT");
  if (params.confirm !== true) {
    return fail(
      "Refusing to update: pass confirm:true to acknowledge overwriting an existing memory.",
      "MEMORY_CONFIRMATION_REQUIRED",
    );
  }

  let existingMemories: Memory[];
  if (memoryId) {
    const existing = await runtime.getMemoryById(memoryId);
    if (!existing) {
      return fail(`Memory ${memoryId} was not found.`, "MEMORY_NOT_FOUND");
    }
    existingMemories = [existing];
  } else {
    const type =
      params.type && MEMORY_TYPES.includes(params.type)
        ? params.type
        : undefined;
    const scan = await collectCandidates(runtime, {
      type,
      tables: type ? [type] : FORGET_BY_QUERY_TABLES,
      entityId: message.entityId,
      query,
    });
    const matched = scan.matches.filter((candidate) => {
      // Stage 1 may already have stored the requested change as an observation.
      // Updating that observation cannot fulfill a request to correct prior facts.
      if (
        message.id &&
        candidate.memory.metadata?.source === "facts_and_relationships_stage" &&
        "messageId" in candidate.memory.metadata &&
        candidate.memory.metadata.messageId === message.id
      )
        return false;
      const candidateText =
        (candidate.memory.content as { text?: string } | undefined)?.text ?? "";
      return scoreText(candidateText, query ?? "") >= 1;
    });
    if (matched.length === 0 && impliedQuery !== undefined) {
      const created = await doCreate(runtime, message, params);
      if (!created.success) return created;
      return {
        ...created,
        text: `No stored memory matched the user's words ("${impliedQuery}"), so this is new information; stored it. ${created.text ?? ""}`.trim(),
        data: {
          ...(created.data ?? {}),
          updateFallback: "created",
          impliedQuery,
        },
      };
    }
    if (matched.length === 0) {
      return fail(
        `No prior stored memory matches "${query}". ${describeCompleteScan(scan)} Search saved facts for the subject, then update the existing records by id. An observation extracted from this update request is not an existing target.`,
        "MEMORY_NOT_FOUND",
      );
    }
    const distinctTexts = new Set(
      matched.map((candidate) =>
        (
          (candidate.memory.content as { text?: string } | undefined)?.text ??
          ""
        )
          .trim()
          .toLowerCase(),
      ),
    );
    if (distinctTexts.size > 1) {
      const candidates = matched.map((candidate) =>
        toListItem(candidate.memory, candidate.type),
      );
      const lines = candidates.map(
        (item) =>
          `- [${item.type}] ${item.id}: ${toWellFormedUnicode(item.text)}`,
      );
      return {
        success: false,
        text: [
          `Query "${query}" matches ${distinctTexts.size} distinct memories. Review all candidates and update each record affected by the user's correction by memoryId, preserving unrelated facts in each replacement:`,
          ...lines,
        ].join("\n"),
        userFacingText: ambiguousMemoryUserFacingText("update", candidates),
        // Nothing was written: an ambiguous query is an observation, not a
        // broken mutation, so it must not own the turn's terminal message
        // once a later by-id update succeeds.
        data: {
          error: "MEMORY_AMBIGUOUS_QUERY",
          candidates,
          readOnlyOperation: true,
        },
      };
    }
    existingMemories = matched.map((candidate) => candidate.memory);
  }

  const updatedIds: UUID[] = [];
  for (const existing of existingMemories) {
    if (!existing.id) continue;
    const existingContent =
      (existing.content as Record<string, unknown> | undefined) ?? {};
    const nextContent = { ...existingContent, text };
    let embedding: number[] | undefined;
    if (Array.isArray(existing.embedding) && existing.embedding.length > 0) {
      const regenerated = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text,
      });
      if (!Array.isArray(regenerated) || regenerated.length === 0) {
        return fail(
          "Embedding model returned no vector.",
          "MEMORY_EMBEDDING_FAILED",
        );
      }
      embedding = regenerated;
    }

    await runtime.updateMemory({
      id: existing.id,
      content: nextContent,
      ...(embedding ? { embedding } : {}),
    });
    updatedIds.push(existing.id);
  }

  const primaryMemoryId = updatedIds[0];
  const updated = primaryMemoryId
    ? await runtime.getMemoryById(primaryMemoryId)
    : null;
  const updatedAt = new Date().toISOString();
  const updatedText =
    typeof updated?.content.text === "string" ? updated.content.text : text;
  return {
    success: true,
    transcriptVisibility: "internal",
    text: `Updated ${updatedIds.length} memory record(s).`,
    userFacingText: memoryUserFacingLine("Updated", updatedText),
    verifiedUserFacing: true,
    turnComplete: true,
    values: { memoryId: primaryMemoryId, updatedCount: updatedIds.length },
    effectReceipts: updatedIds.map((id) =>
      memoryMutationReceipt({
        operation: "memory.update",
        memoryId: id,
        observedAt: updatedAt,
      }),
    ),
    data: {
      actionName: "MEMORY",
      op: "update" as const,
      memoryId: primaryMemoryId,
      memoryIds: updatedIds,
      memory: updated ?? null,
      replyContext: memoryReplyContext({
        scenario: "memory_updated",
        facts:
          updatedIds.length === 1
            ? `Updated the memory; it now says: "${updatedText}".`
            : `Updated ${updatedIds.length} memories; they now say: "${updatedText}".`,
        context: { memoryIds: updatedIds },
      }),
    },
  };
}

/**
 * The planner sometimes dispatches a forget with `confirm` alone ("forget my
 * favorite tea" → `{"confirm": true}`, live 2026-09-11), which cost a failed
 * step, an evaluator round and a second planner call (~3 s) before it quoted
 * the message. The query contract is the user's own words from this message,
 * so use them directly when the message carries content terms; the same
 * every-term match and ambiguity refusal still guard the delete.
 */
const LEADING_ADDRESSING_PREFIX =
  /^\s*(?:<@!?\d+>\s*|@\S+\s+|[^()\n]{0,80}\(@\d+\)\s*)/u;
const MENTION_MARKER_PATTERN = /<@!?\d{6,}>|\(@\d{6,}\)/gu;

const REMEMBER_REQUEST_PREFIX =
  /^(?:(?:hey|hi|ok|okay|please)[\s,]+)*(?:please\s+)?(?:remember|note|keep in mind|save)\s+(?:this[:,]?\s+)?(?:that\s+)?/i;
const SECOND_CLAUSE_PATTERN = /\b(?:and also|and then|also|but|then)\b|[?;]/i;

/**
 * The content of a single-clause "remember that X" request, for a create the
 * planner sent without `text`. A message that carries a second request or a
 * question is left to the planner; storing it whole would remember the
 * question.
 */
function impliedCreateTextFromMessage(
  runtime: IAgentRuntime,
  message: Memory,
): string | undefined {
  const residual = mutationQueryFromMessage(runtime, message);
  if (!residual) return undefined;
  const content = residual.replace(REMEMBER_REQUEST_PREFIX, "").trim();
  if (
    !content ||
    content === residual.trim() ||
    content.length > 240 ||
    SECOND_CLAUSE_PATTERN.test(content) ||
    scoreQueryTerms(content).length < 2
  ) {
    return undefined;
  }
  logger.info(
    "[MEMORY] create carried no text; storing the user's own statement",
  );
  return content.replace(/[.!\s]+$/, "");
}

function mutationQueryFromMessage(
  runtime: IAgentRuntime,
  message: Memory,
): string | undefined {
  // The user's actual words, not the external-content security envelope that
  // wraps connector messages: the envelope's warning text matched nothing and
  // turned a plain "forget my favorite tea" into a hard miss (live 2026-09-12).
  // Drop platform mention tokens ("Eliza (@1490833…)" / "<@1490833…>"): they
  // are addressing, not content, and their name and id would have to match
  // the stored fact for the every-term rule (live 2026-09-12, harness room).
  const raw = unwrapUserMessageText(message);
  const addressed = MENTION_MARKER_PATTERN.test(raw);
  MENTION_MARKER_PATTERN.lastIndex = 0;
  let text = raw
    .replace(LEADING_ADDRESSING_PREFIX, "")
    .replace(MENTION_MARKER_PATTERN, " ");
  if (addressed) {
    // The agent's own name next to a mention marker is addressing too.
    for (const word of (runtime.character?.name ?? "").split(/\s+/)) {
      if (word.length >= 2)
        text = text.replace(
          new RegExp(
            `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "gi",
          ),
          " ",
        );
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text || scoreQueryTerms(text).length === 0) return undefined;
  logger.info(
    "[MEMORY] delete carried no query; using the user's message text",
  );
  return text;
}

async function doDelete(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
): Promise<ActionResult> {
  const memoryParam = parseUuidParam(params.memoryId, "memoryId");
  if (!memoryParam.ok) return memoryParam.result;
  const memoryId = memoryParam.id;
  const explicitQuery = params.query?.trim();
  const query = explicitQuery || mutationQueryFromMessage(runtime, message);
  if (!memoryId && !query) {
    return fail(MEMORY_MISSING_TARGET_MESSAGE, "MEMORY_MISSING_ID");
  }
  if (params.confirm !== true) {
    return fail(
      "Refusing to delete: pass confirm:true to acknowledge this destructive action.",
      "MEMORY_CONFIRMATION_REQUIRED",
    );
  }

  if (memoryId) {
    const existing = await runtime.getMemoryById(memoryId);
    if (!existing) {
      return fail(`Memory ${memoryId} was not found.`, "MEMORY_NOT_FOUND");
    }

    await runtime.deleteMemory(memoryId);
    const forgottenText =
      typeof existing.content.text === "string" ? existing.content.text : "";
    return {
      success: true,
      transcriptVisibility: "internal",
      text: `Forgot memory ${memoryId}: ${toWellFormedUnicode(existing.content.text ?? "")}`,
      userFacingText: memoryUserFacingLine("Forgot", forgottenText),
      verifiedUserFacing: true,
      turnComplete: true,
      values: { memoryId },
      effectReceipts: [
        memoryMutationReceipt({
          operation: "memory.delete",
          memoryId,
          observedAt: new Date().toISOString(),
        }),
      ],
      data: {
        actionName: "MEMORY",
        op: "delete" as const,
        memoryId,
        replyContext: memoryReplyContext({
          scenario: "memory_forgotten",
          facts: forgottenText
            ? `Forgot the memory: "${forgottenText}".`
            : "Forgot the requested memory.",
          context: { memoryId },
        }),
      },
    };
  }

  if (!query) {
    return fail(MEMORY_MISSING_TARGET_MESSAGE, "MEMORY_MISSING_ID");
  }
  const result = await doDeleteByQuery(runtime, message, params, query);
  // A planner-invented query ("favorite tea is matcha" for a stored genmaicha,
  // live 2026-09-13) misses twice before the user's own words are tried; try
  // them once here, under the same single-match rule, before reporting a miss.
  if (
    explicitQuery &&
    !result.success &&
    (result.data as { error?: unknown } | undefined)?.error ===
      "MEMORY_NOT_FOUND"
  ) {
    const implied = mutationQueryFromMessage(runtime, message);
    if (implied && implied.toLowerCase() !== explicitQuery.toLowerCase()) {
      const retried = await doDeleteByQuery(runtime, message, params, implied);
      if (retried.success) {
        return {
          ...retried,
          data: { ...(retried.data ?? {}), retriedWithMessageText: true },
        };
      }
    }
    return result;
  }
  // A miss on the implied query is not evidence that nothing is stored; hand
  // the planner the original ask for an explicit query instead of a verdict.
  if (
    !explicitQuery &&
    !result.success &&
    (result.data as { error?: unknown } | undefined)?.error ===
      "MEMORY_NOT_FOUND"
  ) {
    return fail(MEMORY_MISSING_TARGET_MESSAGE, "MEMORY_MISSING_ID");
  }
  return result;
}

/**
 * Delete-by-query: "remove that fact" carries no memoryId, so resolve the
 * memory through the same cluster-expanded read scope search uses, then
 * delete. Reflection dedup failures leave several rows with identical text —
 * one logical fact — so all rows of the single matched text are removed.
 * A query that strongly matches more than one distinct text is ambiguous:
 * refuse and list the candidates so the model can delete by exact id.
 *
 * The read is pinned to the requesting entity's identity cluster: a text-only
 * match in a multi-user room would also hit another user's identical-text
 * fact, so "forget that I play guitar" may only remove the asking user's own
 * rows. Cross-entity deletes must go through op:search + delete by memoryId.
 */
async function doDeleteByQuery(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
  query: string,
): Promise<ActionResult> {
  const type =
    params.type && MEMORY_TYPES.includes(params.type) ? params.type : undefined;
  const entityParam = parseUuidParam(params.entityId, "entityId");
  if (!entityParam.ok) return entityParam.result;
  const roomParam = parseUuidParam(params.roomId, "roomId");
  if (!roomParam.ok) return roomParam.result;

  // Requester wins over a model-supplied entityId: model ids arrive as free
  // text and could name another user, reopening the cross-user match this
  // scope exists to close. The parsed param is a fallback only for messages
  // that carry no entity (internal maintenance invocations).
  const scopeEntityId = message.entityId ?? entityParam.id;

  // "Forget X" targets stored knowledge. Without an explicit type the scan
  // covers facts and agent memories only — never the chat transcript or
  // documents (live 2026-09-06 00:16: a forget-by-query matched the user's own
  // "forget that I…" message and reported it as a deletable memory).
  const scan = await collectCandidates(runtime, {
    type,
    tables: type ? [type] : FORGET_BY_QUERY_TABLES,
    entityId: scopeEntityId,
    roomId: roomParam.id,
    query,
  });

  // Deletion needs a stronger bar than search ranking: scoreText >= 1 means
  // the whole phrase matched or every query term matched.
  const matched = scan.matches.filter((c) => {
    const text =
      (c.memory.content as { text?: string } | undefined)?.text ?? "";
    return scoreText(text, query) >= 1;
  });

  if (matched.length === 0) {
    return fail(
      `No stored memory matches "${query}". ${describeCompleteScan(scan)}`,
      "MEMORY_NOT_FOUND",
    );
  }

  const normalize = (c: MemoryCandidate) =>
    ((c.memory.content as { text?: string } | undefined)?.text ?? "")
      .trim()
      .toLowerCase();
  const distinctTexts = new Set(matched.map(normalize));
  // One durable fact plus the observation rows that shadow it (the facts
  // stage's `current` rows for the same claim, including relationship echoes)
  // is one memory to the user. Live 2026-09-13 "forget my favorite color"
  // matched "The user's favorite color is teal." and the echo
  // "user favorite_color teal"; the planner resent the same query and the
  // turn died on the repeated-failure limit.
  const factKindOf = (c: MemoryCandidate): "durable" | "current" | null => {
    if (c.type !== "facts") return null;
    const meta = metadataRecord(c.memory);
    if (meta.kind === "current") return "current";
    if (meta.kind === "durable") return "durable";
    return meta.source === STAGE_FACT_SOURCE ? "current" : null;
  };
  const durableMatches = matched.filter((c) => factKindOf(c) === "durable");
  const shadowsOfOneDurableFact =
    durableMatches.length === 1 &&
    matched.every(
      (c) =>
        c.memory.entityId === durableMatches[0]?.memory.entityId &&
        (factKindOf(c) === "durable" || factKindOf(c) === "current"),
    );
  // Retrieval matches do not establish that distinct texts express the same
  // claim, even when their records share an author. Let the planner select ids.
  if (distinctTexts.size > 1 && !shadowsOfOneDurableFact) {
    const candidates = matched.map((c) => toListItem(c.memory, c.type));
    const lines = candidates.map(
      (m) => `- [${m.type}] ${m.id}: ${toWellFormedUnicode(m.text)}`,
    );
    return {
      success: false,
      text: [
        `Query "${query}" matches ${distinctTexts.size} distinct memories. Delete by memoryId instead:`,
        ...lines,
      ].join("\n"),
      userFacingText: ambiguousMemoryUserFacingText("forget", candidates),
      // Nothing was deleted: an ambiguous query is an observation, not a
      // broken mutation, so it must not own the turn's terminal message
      // once a later by-id delete succeeds (the failure-authority tail would
      // otherwise append this question after "Forgot: …").
      data: {
        error: "MEMORY_AMBIGUOUS_QUERY",
        candidates,
        readOnlyOperation: true,
      },
    };
  }

  // One source message can contain both another rendering of this claim and
  // unrelated facts. Partial retrieval overlap is not deletion authority;
  // expose these candidates to the planner before changing any records.
  const messageIdOf = (c: MemoryCandidate): string | undefined => {
    const value = (c.memory.metadata as { messageId?: unknown } | undefined)
      ?.messageId;
    return typeof value === "string" && value ? value : undefined;
  };
  const matchedIds = new Set(matched.map((c) => c.memory.id));
  const forgottenMessageIds = new Set(
    matched
      .filter(
        (c) => c.type === "facts" && c.memory.entityId === message.entityId,
      )
      .map(messageIdOf)
      .filter((value): value is string => value !== undefined),
  );
  const sameMessageSiblings = scan.matches.filter(
    (c) =>
      !matchedIds.has(c.memory.id) &&
      c.type === "facts" &&
      !!message.entityId &&
      c.memory.entityId === message.entityId &&
      forgottenMessageIds.has(messageIdOf(c) ?? ""),
  );
  if (sameMessageSiblings.length > 0) {
    const candidates = [...matched, ...sameMessageSiblings].map((candidate) =>
      toListItem(candidate.memory, candidate.type),
    );
    return {
      success: false,
      text: [
        `No records were deleted. The source message also produced other partially matching facts. Review these candidates and delete only records expressing the user's requested claim by memoryId; preserve other facts even when they came from the same message.`,
        ...candidates.map(
          (item) =>
            `- [${item.type}] ${item.id}: ${toWellFormedUnicode(item.text)}`,
        ),
      ].join("\n"),
      userFacingText: ambiguousMemoryUserFacingText("forget", candidates),
      data: {
        error: "MEMORY_AMBIGUOUS_QUERY",
        candidates,
        readOnlyOperation: true,
      },
    };
  }

  const deleted: MemoryListItem[] = [];
  for (const c of matched) {
    const id = c.memory.id;
    if (!id) continue;
    await runtime.deleteMemory(id);
    deleted.push(toListItem(c.memory, c.type));
  }

  const forgottenAt = new Date().toISOString();
  const forgottenTexts = deleted
    .map((item) => toWellFormedUnicode(item.text))
    .filter((value) => value.trim().length > 0);
  // Observation rows collapsed with a durable fact are the same memory to the
  // user; the reply names the durable text only.
  const spokenTexts = shadowsOfOneDurableFact
    ? durableMatches
        .map((c) =>
          toWellFormedUnicode(
            (c.memory.content as { text?: string } | undefined)?.text ?? "",
          ),
        )
        .filter((value) => value.trim().length > 0)
    : forgottenTexts;
  return {
    success: true,
    transcriptVisibility: "internal",
    text: `Forgot ${deleted.length} memory record(s) matching "${query}": ${toWellFormedUnicode(deleted[0]?.text ?? "")}`,
    userFacingText: memoryUserFacingLine("Forgot", spokenTexts.join("; ")),
    verifiedUserFacing: true,
    turnComplete: true,
    values: { deletedCount: deleted.length },
    effectReceipts: deleted.map((item) =>
      memoryMutationReceipt({
        operation: "memory.delete",
        memoryId: item.id,
        observedAt: forgottenAt,
      }),
    ),
    data: {
      actionName: "MEMORY",
      op: "delete" as const,
      query,
      deleted,
      replyContext: memoryReplyContext({
        scenario: "memory_forgotten",
        facts:
          deleted.length === 1
            ? `Forgot the memory: "${forgottenTexts[0] ?? query}".`
            : `Forgot ${deleted.length} memories matching "${query}": ${forgottenTexts.map((value) => `"${value}"`).join("; ")}.`,
        context: { query, deletedCount: deleted.length },
      }),
    },
  };
}

export const memoryAction: Action = {
  name: "MEMORY",
  contexts: ["memory", "documents", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old leaf action names
    "CREATE_MEMORY",
    "SEARCH_MEMORIES",
    "UPDATE_MEMORY",
    "DELETE_MEMORY",
    "RECALL_MEMORY_FILTERED",
    // Stage-1 recall names bind directly to the MEMORY umbrella action.
    "RECALL_MEMORY",
    "RECALL_MEMORIES",
    "MEMORY_RECALL",
    "MEMORY_SEARCH",
    "FORGET_MEMORY",
    "EDIT_MEMORY",
    // Common aliases
    "MEMORIZE",
    "REMEMBER_THIS",
    "STORE_MEMORY",
    "WRITE_MEMORY",
    "SAVE_MEMORY",
    "BROWSE_MEMORIES",
    "FILTER_MEMORIES",
    "FIND_MEMORIES",
    "LIST_MEMORIES",
    "SEARCH_MEMORY",
    "REMOVE_MEMORY",
    "MODIFY_MEMORY",
  ],
  description:
    "Manage agent memory records. op:create stores a new memory (text is required); op:search filters by type/entityId/roomId/query; op:update edits by memoryId or a unique requester-scoped query match (requires confirm:true); op:delete removes by memoryId or requester-scoped query match (requires confirm:true). To forget something the user states, call delete with query and confirm:true directly — a prior search is unnecessary.",
  descriptionCompressed:
    "manage agent memory create search update delete; update/delete by memoryId or query; update/delete require confirm:true",
  routingHint:
    "NOTES ARE NOT MEMORY: 'make a note', 'note to self', 'jot this down', 'what notes do i have' -> NOTES. MEMORY manages the agent's stored knowledge: create/search/update/delete. Use supplied conversation and fact evidence directly when it answers the question, applying later corrections; referring to an earlier turn alone does not require a search. Use op:search for evidence absent from supplied context, other conversations, or exact stored-message counts (rendered dialogue may filter internal rows and duplicates). Search type=facts for saved facts/preferences; type=messages for conversation history. Do NOT use for open-web lookups -> WEB_SEARCH, connected external inboxes -> MESSAGE, or skill catalog -> SKILL",
  validate: async () => true,
  inferSubaction: inferMemorySubaction,
  handler: async (
    runtime: IAgentRuntime,
    message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as MemoryParams;
    const op = normalizeMemoryOp(rawParams);
    // Search keeps a UUID-shaped query as a filter; only a mutation may read
    // it as the record id (review 2026-09-06: adopting it before every op made
    // MEMORY_SEARCH query=<uuid> an unfiltered scan).
    const params =
      op === "update" || op === "delete"
        ? adoptUuidQueryAsMemoryId(rawParams)
        : rawParams;
    if (!op) {
      return fail(
        `op/subaction is required and must be one of ${MEMORY_OPS.join(", ")}.`,
        "MEMORY_INVALID",
      );
    }
    try {
      switch (op) {
        case "create":
          return await doCreate(runtime, message, params);
        case "search":
          return await doSearch(runtime, message, params);
        case "update":
          return await doUpdate(runtime, message, params);
        case "delete":
          return await doDelete(runtime, message, params);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[memory:${op}] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to ${op} memory: ${msg}`,
        data: {
          error:
            err instanceof ElizaError
              ? err.code
              : `MEMORY_${op.toUpperCase()}_FAILED`,
        },
      };
    }
  },
  parameters: [
    {
      name: "action",
      description:
        "Operation to perform. One of: create, search, update, delete.",
      required: false,
      schema: { type: "string" as const, enum: [...MEMORY_OPS] },
    },
    {
      name: "text",
      description:
        'create: REQUIRED — the content to remember, as a complete third-person sentence about the user ("The user\'s favorite tea is matcha." — not "my", not their name; never leave it empty and never put it in query). update: complete replacement text for the existing record; preserve every unrelated fact. When correcting saved knowledge, search the subject and reconcile all affected records before reporting completion.',
      required: false,
      requiredForSubactions: ["create", "update"],
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description:
        'create: optional category label, e.g. "fact", "preference".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "tags",
      description: "create: optional list of string tags.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "type",
      description:
        "search: optional table filter. Use facts for saved facts and preferences (the usual target of remember/forget); memories is only explicitly saved memory records; messages is conversation history and is large. Omit to search all record types.",
      required: false,
      schema: { type: "string" as const, enum: [...MEMORY_TYPES] },
    },
    {
      name: "author",
      description:
        "search: choose requester for the current user's original statements or corrections, assistant for your own replies, or any for no author restriction. Requester/assistant resolve the author from this turn and imply type=messages. Use any for other record types or an explicit other entityId. Existing access, type, entityId, and roomId filters still apply.",
      required: false,
      requiredForSubactions: ["search"],
      schema: {
        type: "string" as const,
        enum: ["requester", "assistant", "any"],
      },
    },
    // entityId/roomId carry no schema `pattern` on purpose (matrix F16): a
    // planner-copied UUID arrives mangled often enough (live: a dropped hex
    // char in the roomId first segment, tj-b0c123243cb39e) that the
    // validate-tool-args pattern check failed the whole call before the
    // handler could apply its per-op policy — search salvages by ignoring the
    // unusable filter, destructive ops still hard-fail via parseUuidParam.
    {
      name: "entityId",
      description:
        "search: optional exact author/entity UUID for another known speaker. Prefer author=requester for my original statements and author=assistant for your replies; do not copy your own UUID to search the requester. Omit when no exact UUID is known.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description:
        'search: optional room UUID from a previous result. Omit it to search all stored rooms; never pass a source label such as "chat".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        'search: ranked keyword matching, not an all-words filter. Prefer a distinctive subject or name; combining unrelated topics broadens matches and can require pagination. update/delete: the memory to change or forget, quoted in the user\'s own words from this message (never paraphrase: "like my coffee with oat milk", not "prefer oat milk"). Either a valid memoryId or a nonempty query is required. memoryId alone selects one exact record and takes precedence when both are supplied.',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queryMode",
      description:
        "search: literal finds a case-sensitive substring of source text, preserving punctuation, whitespace and Unicode. Use literal for an exact quotation; copy only its text into query, without adding quote delimiters. keywords (default) ranks related terms for conceptual recall. Literal searches require a nonempty query and still honor every other filter and pagination.",
      required: false,
      subactions: ["search"],
      schema: { type: "string" as const, enum: ["keywords", "literal"] },
    },
    {
      name: "limit",
      description: `search: optional positive page size up to ${MAX_MEMORY_PAGE_ITEMS}. Large complete results reject with a typed instruction to retry using this lossless pagination contract.`,
      required: false,
      schema: {
        type: "integer" as const,
        minimum: 1,
        maximum: MAX_MEMORY_PAGE_ITEMS,
      },
    },
    {
      name: "offset",
      description:
        "search: zero-based continuation offset from a previous paginated result. Requires the same filters and limit.",
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      name: "snapshot",
      description:
        "search: continuation fingerprint for the same filters and ordered results. Required with a positive offset. Omit when starting or restarting at offset 0, including after changing query, author, type or roomId.",
      required: false,
      schema: { type: "string" as const, pattern: "^[0-9a-f]{64}$" },
    },
    {
      name: "memoryId",
      description:
        "update/delete: exact memory UUID from a previous search result; sufficient without query. Takes precedence when both memoryId and query are supplied.",
      required: false,
      modelOmissionSentinels: [...MEMORY_ID_OMISSION_SENTINELS],
      schema: { type: "string" as const, pattern: UUID_SCHEMA_PATTERN },
    },
    {
      name: "confirm",
      description:
        "update/delete: must be true to proceed with the destructive operation.",
      required: false,
      requiredForSubactions: ["update", "delete"],
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Remember that I prefer dark mode." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Stored memory abc-123.", action: "MEMORY" },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Find recent memories that mention scheduling." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Showing all N match(es) found in the complete scan...",
          action: "MEMORY",
        },
      },
    ],
  ],
};
