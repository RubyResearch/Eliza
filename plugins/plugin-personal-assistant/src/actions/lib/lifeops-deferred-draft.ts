/**
 * Deferred-draft state machine for OWNER_LIFE create flows.
 *
 * Multi-turn create_definition / create_goal flows preview a draft, then
 * wait for the user to confirm, edit, or cancel on a follow-up turn. The
 * draft lives in the trailing ActionResult / message content under
 * `lifeDraft`; this module owns the parsing, expiry, and reuse-mode
 * decision so the umbrella action can stay focused on dispatch.
 */
import type {
  ActionResult,
  IAgentRuntime,
  Memory,
  ResponseHandlerEvaluator,
  ResponseHandlerEvaluatorContext,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJsonModelRecord,
  recentConversationTexts,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";
import type {
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGoalRequest,
  LifeOpsCadence,
} from "../../contracts/index.js";
import { asCacheRuntime } from "../../lifeops/runtime-cache.js";
import { textStatesExplicitUndatedTodo } from "./undated-todo-intent.js";

/** Maximum age (ms) for a deferred draft before it expires. */
export const DRAFT_EXPIRY_MS = 5 * 60 * 1000;
/** Maximum conversation turns before a deferred draft expires. */
export const DRAFT_MAX_TURNS = 3;
const DEFERRED_LIFE_DRAFT_CACHE_PREFIX = "lifeops:deferred-draft";

const LIFE_CONFIRMATION_VETO_RE =
  /\b(?:no|not|don t|do not|cancel|hold off|wait|later|change)\b/u;
const LIFE_CONFIRMATION_CUE_RE =
  /\b(?:ok|okay|yes|yep|yeah|sure|confirm|confirmed|approve|approved|save it|save that|save this|save the goal|set it|lock it in|do it|looks good|that works|go ahead)\b/u;

/**
 * Detects owner consent to persist a previewed LifeOps draft. Consent is
 * sentence-scoped so an unrelated negated clause cannot veto a clear approval,
 * while a negation in the approving sentence still fails closed.
 */
export function isExplicitLifeCreateConfirmation(text: string): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u);
  for (const sentence of sentences) {
    const normalized = sentence
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!normalized || LIFE_CONFIRMATION_VETO_RE.test(normalized)) {
      continue;
    }
    if (LIFE_CONFIRMATION_CUE_RE.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Explicit date-decline for a pending schedule question. Delegates to the
 * canonical multilingual undated-Todo authority (one vocabulary — the same
 * directive parser the write path trusts), so routing and acceptance can
 * never disagree about what counts as an explicit decline. Live residual
 * that motivated the consolidation: the routing cue accepted "no deadline,
 * it's just a general todo" while the write path's authority did not, so the
 * routed turn wiped its own cadence and stranded the draft.
 */
export function isExplicitScheduleDecline(text: string): boolean {
  return textStatesExplicitUndatedTodo(text);
}

export type DeferredLifeDefinitionDraft = {
  intent: string;
  operation: "create_definition";
  /**
   * Set when the draft was parked by a clarify turn that is still waiting on
   * one required field. `cadence` may be absent only while this is set — the
   * owner's next answer supplies it (or explicitly declines a date, which the
   * extract-task-plan ruling maps to the `unscheduled` cadence).
   */
  awaitingField?: "schedule";
  /** Epoch ms when the draft was created. Used for expiry. */
  createdAt?: number;
  /**
   * Id of the owner message whose turn previewed this draft. Consent
   * checking uses it to tell "the owner saw this preview on an earlier turn"
   * from "the planner re-called create in the same turn it previewed":
   * planner-asserted `confirmed` only counts against a prior-turn draft.
   */
  sourceMessageId?: string;
  request: {
    idempotencyKey?: string;
    cadence?: LifeOpsCadence;
    description?: string;
    goalRef?: string;
    kind: CreateLifeOpsDefinitionRequest["kind"];
    priority?: number;
    progressionRule?: CreateLifeOpsDefinitionRequest["progressionRule"];
    checkInPolicy?: CreateLifeOpsDefinitionRequest["checkInPolicy"];
    reminderPlan?: CreateLifeOpsDefinitionRequest["reminderPlan"];
    timezone?: string;
    title: string;
    metadata?: CreateLifeOpsDefinitionRequest["metadata"];
    windowPolicy?: CreateLifeOpsDefinitionRequest["windowPolicy"];
    websiteAccess?: CreateLifeOpsDefinitionRequest["websiteAccess"];
  };
};

export type DeferredLifeGoalDraft = {
  intent: string;
  operation: "create_goal";
  /** Epoch ms when the draft was created. Used for expiry. */
  createdAt?: number;
  /** See DeferredLifeDefinitionDraft.sourceMessageId. */
  sourceMessageId?: string;
  request: {
    cadence?: CreateLifeOpsGoalRequest["cadence"];
    description?: string;
    metadata?: CreateLifeOpsGoalRequest["metadata"];
    successCriteria?: CreateLifeOpsGoalRequest["successCriteria"];
    supportStrategy?: CreateLifeOpsGoalRequest["supportStrategy"];
    title: string;
  };
};

export type DeferredLifeDraft =
  | DeferredLifeDefinitionDraft
  | DeferredLifeGoalDraft;

export type DeferredLifeDraftCacheState =
  | { kind: "draft"; draft: DeferredLifeDraft }
  | { kind: "invalidated" }
  | { kind: "none" };

export type DeferredLifeDraftReuseMode = "confirm" | "edit";
export type DeferredLifeDraftFollowupMode =
  | DeferredLifeDraftReuseMode
  | "cancel"
  | null;

function deferredLifeDraftCacheKey(
  runtime: IAgentRuntime,
  message: Memory,
): string {
  return [
    DEFERRED_LIFE_DRAFT_CACHE_PREFIX,
    runtime.agentId,
    message.roomId,
    message.entityId,
  ].join(":");
}

export async function readDeferredLifeDraftCache(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<DeferredLifeDraft | null> {
  const state = await readDeferredLifeDraftCacheState(runtime, message);
  return state.kind === "draft" ? state.draft : null;
}

export async function readDeferredLifeDraftCacheState(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<DeferredLifeDraftCacheState> {
  const stored = await asCacheRuntime(runtime).getCache<unknown>(
    deferredLifeDraftCacheKey(runtime, message),
  );
  const draft = coerceDeferredLifeDraft(stored);
  if (draft) {
    return { kind: "draft", draft };
  }
  if (stored && typeof stored === "object") {
    const record = stored as Record<string, unknown>;
    const createdAt =
      typeof record.createdAt === "number" ? record.createdAt : NaN;
    if (
      record.invalidated === true &&
      Number.isFinite(createdAt) &&
      Date.now() - createdAt < DRAFT_EXPIRY_MS
    ) {
      return { kind: "invalidated" };
    }
  }
  return { kind: "none" };
}

export async function writeDeferredLifeDraftCache(
  runtime: IAgentRuntime,
  message: Memory,
  draft: DeferredLifeDraft,
): Promise<void> {
  await asCacheRuntime(runtime).setCache(
    deferredLifeDraftCacheKey(runtime, message),
    // Stamp the previewing turn's message id so the confirm path can tell a
    // prior-turn draft (owner saw the preview) from a same-turn re-call.
    {
      ...draft,
      ...(message.id !== undefined && message.id !== null
        ? { sourceMessageId: String(message.id) }
        : {}),
    },
  );
}

export async function clearDeferredLifeDraftCache(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<void> {
  await asCacheRuntime(runtime).deleteCache(
    deferredLifeDraftCacheKey(runtime, message),
  );
}

export async function invalidateDeferredLifeDraftCache(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<void> {
  await asCacheRuntime(runtime).setCache(
    deferredLifeDraftCacheKey(runtime, message),
    {
      invalidated: true,
      createdAt: Date.now(),
      ...(message.id !== undefined && message.id !== null
        ? { sourceMessageId: String(message.id) }
        : {}),
    },
  );
}

export function coerceDeferredLifeDraft(
  value: unknown,
): DeferredLifeDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const operation = record.operation;
  const intent = typeof record.intent === "string" ? record.intent.trim() : "";
  const request =
    record.request && typeof record.request === "object"
      ? (record.request as Record<string, unknown>)
      : null;
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : undefined;
  const sourceMessageId =
    typeof record.sourceMessageId === "string" &&
    record.sourceMessageId.length > 0
      ? record.sourceMessageId
      : undefined;

  if (!request || !intent) {
    return null;
  }

  const title = typeof request.title === "string" ? request.title.trim() : "";
  if (!title) {
    return null;
  }

  if (operation === "create_definition") {
    const idempotencyKey = request.idempotencyKey;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
      return null;
    }
    const kind =
      typeof request.kind === "string"
        ? (request.kind as CreateLifeOpsDefinitionRequest["kind"])
        : null;
    const cadence = request.cadence as LifeOpsCadence | undefined;
    const awaitingField =
      record.awaitingField === "schedule" ? ("schedule" as const) : undefined;
    // A cadence-less definition draft is only coherent while a clarify turn
    // is still waiting on the schedule answer; anything else is malformed.
    if (!kind || (!cadence && awaitingField !== "schedule")) {
      return null;
    }
    return {
      awaitingField,
      createdAt,
      intent,
      operation,
      sourceMessageId,
      request: {
        idempotencyKey,
        cadence,
        description:
          typeof request.description === "string"
            ? request.description
            : undefined,
        goalRef:
          typeof request.goalRef === "string" ? request.goalRef : undefined,
        kind,
        priority:
          typeof request.priority === "number" ? request.priority : undefined,
        progressionRule:
          request.progressionRule as CreateLifeOpsDefinitionRequest["progressionRule"],
        reminderPlan:
          request.reminderPlan as CreateLifeOpsDefinitionRequest["reminderPlan"],
        timezone:
          typeof request.timezone === "string" ? request.timezone : undefined,
        title,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as CreateLifeOpsDefinitionRequest["metadata"])
            : undefined,
        windowPolicy:
          request.windowPolicy as CreateLifeOpsDefinitionRequest["windowPolicy"],
        websiteAccess:
          request.websiteAccess as CreateLifeOpsDefinitionRequest["websiteAccess"],
      },
    };
  }

  if (operation === "create_goal") {
    return {
      createdAt,
      intent,
      operation,
      sourceMessageId,
      request: {
        cadence: request.cadence as CreateLifeOpsGoalRequest["cadence"],
        description:
          typeof request.description === "string"
            ? request.description
            : undefined,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as CreateLifeOpsGoalRequest["metadata"])
            : undefined,
        successCriteria:
          request.successCriteria as CreateLifeOpsGoalRequest["successCriteria"],
        supportStrategy:
          request.supportStrategy as CreateLifeOpsGoalRequest["supportStrategy"],
        title,
      },
    };
  }

  return null;
}

function stateActionResults(state: State | undefined): ActionResult[] {
  if (!state || typeof state !== "object") {
    return [];
  }
  const stateRecord = state as Record<string, unknown>;
  const data =
    stateRecord.data && typeof stateRecord.data === "object"
      ? (stateRecord.data as Record<string, unknown>)
      : undefined;
  const providerResults =
    data?.providers && typeof data.providers === "object"
      ? (data.providers as Record<string, unknown>)
      : undefined;
  const providerActionState =
    providerResults?.ACTION_STATE &&
    typeof providerResults.ACTION_STATE === "object"
      ? (providerResults.ACTION_STATE as Record<string, unknown>)
      : undefined;
  const providerActionStateData =
    providerActionState?.data && typeof providerActionState.data === "object"
      ? (providerActionState.data as Record<string, unknown>)
      : undefined;
  const providerRecentMessages =
    providerResults?.RECENT_MESSAGES &&
    typeof providerResults.RECENT_MESSAGES === "object"
      ? (providerResults.RECENT_MESSAGES as Record<string, unknown>)
      : undefined;
  const providerRecentMessagesData =
    providerRecentMessages?.data &&
    typeof providerRecentMessages.data === "object"
      ? (providerRecentMessages.data as Record<string, unknown>)
      : undefined;

  const candidates = [
    data?.actionResults,
    providerActionStateData?.actionResults,
    providerActionStateData?.recentActionMemories,
    providerRecentMessagesData?.actionResults,
  ].filter(Array.isArray) as unknown[][];

  if (candidates.length === 0) {
    return [];
  }

  return candidates.flatMap((entries) =>
    entries.flatMap((entry): ActionResult[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      if ("content" in entry) {
        const content =
          (entry as { content?: unknown }).content &&
          typeof (entry as { content?: unknown }).content === "object"
            ? ((entry as { content: Record<string, unknown> })
                .content as Record<string, unknown>)
            : null;
        if (!content) {
          return [];
        }

        const contentData =
          content.data && typeof content.data === "object"
            ? ({ ...(content.data as Record<string, unknown>) } as Record<
                string,
                unknown
              >)
            : {};
        if (
          typeof content.actionName === "string" &&
          typeof contentData.actionName !== "string"
        ) {
          contentData.actionName = content.actionName;
        }

        return [
          {
            success: content.actionStatus !== "failed",
            text: typeof content.text === "string" ? content.text : undefined,
            data: contentData as import("@elizaos/core").ProviderDataRecord,
            error:
              typeof content.error === "string" ? content.error : undefined,
          },
        ];
      }

      return [entry as ActionResult];
    }),
  );
}

function stateMessageDrafts(state: State | undefined): DeferredLifeDraft[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const drafts: DeferredLifeDraft[] = [];
  for (const item of getRecentMessagesData(state)) {
    const content = item.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    const contentRecord = content as Record<string, unknown>;
    const candidate =
      coerceDeferredLifeDraft(contentRecord.lifeDraft) ??
      coerceDeferredLifeDraft(
        contentRecord.data && typeof contentRecord.data === "object"
          ? (contentRecord.data as Record<string, unknown>).lifeDraft
          : undefined,
      );
    if (candidate) {
      drafts.push(candidate);
    }
  }

  return drafts;
}

function stateRecentMessageEntries(state: State | undefined): Memory[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  return getRecentMessagesData(state);
}

function isDeferredLifeDraftMessageEntry(item: Memory): boolean {
  const content =
    item.content && typeof item.content === "object"
      ? (item.content as Record<string, unknown>)
      : null;
  if (!content) {
    return false;
  }
  return Boolean(
    coerceDeferredLifeDraft(content.lifeDraft) ??
      coerceDeferredLifeDraft(
        content.data && typeof content.data === "object"
          ? (content.data as Record<string, unknown>).lifeDraft
          : undefined,
      ),
  );
}

export function countTurnsSinceLatestDeferredLifeDraft(
  state: State | undefined,
): number | undefined {
  const entries = stateRecentMessageEntries(state);
  if (entries.length === 0) {
    return undefined;
  }

  let latestDraftIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry && isDeferredLifeDraftMessageEntry(entry)) {
      latestDraftIndex = index;
      break;
    }
  }
  if (latestDraftIndex < 0) {
    return undefined;
  }

  let turns = 0;
  for (const entry of entries.slice(latestDraftIndex + 1)) {
    const content =
      entry.content && typeof entry.content === "object"
        ? (entry.content as Record<string, unknown>)
        : null;
    if (!content || isDeferredLifeDraftMessageEntry(entry)) {
      continue;
    }
    if (typeof content.text === "string" && content.text.trim().length > 0) {
      turns++;
    }
  }
  return turns;
}

type LatestDeferredLifeDraftState =
  | { kind: "draft"; draft: DeferredLifeDraft }
  | { kind: "invalidated" }
  | { kind: "none" };

function latestDeferredLifeDraftState(
  state: State | undefined,
): LatestDeferredLifeDraftState {
  for (const result of [...stateActionResults(state)].reverse()) {
    const resultData =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : null;
    if (resultData?.lifeDraftInvalidated === true) {
      return { kind: "invalidated" };
    }
    const completedCreate =
      result.success &&
      resultData &&
      !coerceDeferredLifeDraft(resultData.lifeDraft) &&
      ((resultData.definition && typeof resultData.definition === "object") ||
        (resultData.goal && typeof resultData.goal === "object"));
    if (completedCreate) {
      return { kind: "none" };
    }

    const candidate = coerceDeferredLifeDraft(result.data?.lifeDraft);
    if (candidate) {
      return { kind: "draft", draft: candidate };
    }
  }

  const messageDrafts = stateMessageDrafts(state);
  const draft = messageDrafts.at(-1);
  return draft ? { kind: "draft", draft } : { kind: "none" };
}

export function latestDeferredLifeDraft(
  state: State | undefined,
): DeferredLifeDraft | null {
  const latest = latestDeferredLifeDraftState(state);
  return latest.kind === "draft" ? latest.draft : null;
}

/** True while the newest deferred-draft terminal marker rejects stale consent. */
export function latestDeferredLifeDraftIsInvalidated(
  state: State | undefined,
): boolean {
  return latestDeferredLifeDraftState(state).kind === "invalidated";
}

export function deferredLifeDraftExpiryReason(args: {
  draft: DeferredLifeDraft | null;
  turnsSinceDraft?: number;
}): "age" | "turns" | null {
  if (!args.draft) {
    return null;
  }

  if (args.draft.createdAt) {
    const ageMs = Date.now() - args.draft.createdAt;
    if (ageMs >= DRAFT_EXPIRY_MS) {
      return "age";
    }
  }
  if (
    typeof args.turnsSinceDraft === "number" &&
    args.turnsSinceDraft >= DRAFT_MAX_TURNS
  ) {
    return "turns";
  }
  return null;
}

const OWNER_TODOS_ACTION = "OWNER_TODOS";

function isDeferredOwnerTodoDraft(
  draft: DeferredLifeDraft | null,
): draft is DeferredLifeDefinitionDraft {
  if (
    draft?.operation !== "create_definition" ||
    draft.request.kind !== "task"
  ) {
    return false;
  }

  const ownerSurface = draft.request.metadata?.ownerSurface;
  return (
    ownerSurface === OWNER_TODOS_ACTION ||
    (ownerSurface === undefined &&
      (draft.request.cadence?.kind === "unscheduled" ||
        draft.awaitingField === "schedule"))
  );
}

async function deferredOwnerTodoDraft(
  context: ResponseHandlerEvaluatorContext,
): Promise<DeferredLifeDefinitionDraft | null> {
  const stateDraft = latestDeferredLifeDraft(context.state);
  const draft =
    stateDraft ??
    (await readDeferredLifeDraftCache(context.runtime, context.message));
  if (!isDeferredOwnerTodoDraft(draft)) {
    return null;
  }

  const turnsSinceDraft = stateDraft
    ? (countTurnsSinceLatestDeferredLifeDraft(context.state) ?? 0) + 1
    : undefined;
  return deferredLifeDraftExpiryReason({ draft, turnsSinceDraft }) === null
    ? draft
    : null;
}

// The runtime calls shouldRun() and evaluate() with the same context object.
// Retaining the promise weakly avoids a second persistent-cache read on the
// confirmation turn without extending the draft's lifetime.
const deferredOwnerTodoDraftByContext = new WeakMap<
  ResponseHandlerEvaluatorContext,
  Promise<DeferredLifeDefinitionDraft | null>
>();

function routedOwnerTodoDraft(
  context: ResponseHandlerEvaluatorContext,
): Promise<DeferredLifeDefinitionDraft | null> {
  const existing = deferredOwnerTodoDraftByContext.get(context);
  if (existing) {
    return existing;
  }
  const pending = deferredOwnerTodoDraft(context);
  deferredOwnerTodoDraftByContext.set(context, pending);
  return pending;
}

/**
 * Keeps an acknowledged owner-Todo draft on its durable action path when the
 * Stage-1 model omits the owning action or claims the save already completed.
 */
export const deferredOwnerTodoRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "lifeops.deferred-owner-todo-routing",
  description:
    "Routes owner consent or an applied completion claim for a pending Todo draft through OWNER_TODOS before completion text can reach the user.",
  priority: 25,
  async shouldRun(context) {
    const messageBody =
      typeof context.message.content.text === "string"
        ? context.message.content.text
        : "";
    const ownerConfirmedDraft = isExplicitLifeCreateConfirmation(messageBody);
    const declinedSchedule = isExplicitScheduleDecline(messageBody);
    if (
      context.messageHandler.processMessage !== "RESPOND" ||
      (context.messageHandler.plan.replyEffectStatus !== "applied" &&
        !ownerConfirmedDraft &&
        !declinedSchedule) ||
      !context.runtime.actions.some(
        (action) => action.name === OWNER_TODOS_ACTION,
      )
    ) {
      return false;
    }
    const draft = await routedOwnerTodoDraft(context);
    if (!draft) {
      return false;
    }
    if (
      context.messageHandler.plan.replyEffectStatus === "applied" ||
      ownerConfirmedDraft
    ) {
      return true;
    }
    // A date-decline is a real ANSWER to the pending schedule question, not
    // chat: Stage-1 routinely classifies "no deadline, it's just a general
    // todo" as simple and acks without any tool call, so the parked draft
    // never persists (live matrix F32, tj-ea2db8b2be106f). Route it back to
    // the owning action; the LLM plan extraction maps the decline to the
    // `unscheduled` cadence under its existing ruling.
    return declinedSchedule && draft.awaitingField === "schedule";
  },
  async evaluate(context) {
    const draft = await routedOwnerTodoDraft(context);
    if (!draft) {
      return undefined;
    }
    return {
      requiresTool: true,
      addContexts: ["tasks"],
      clearCandidateActions: true,
      addCandidateActions: [OWNER_TODOS_ACTION],
      clearParentActionHints: true,
      addParentActionHints: [OWNER_TODOS_ACTION],
      clearReply: true,
      debug: [
        draft.awaitingField === "schedule"
          ? `pending owner Todo draft "${draft.request.title}" received its schedule answer; routing through OWNER_TODOS`
          : `pending owner Todo draft "${draft.request.title}" requires a durable OWNER_TODOS result before completion`,
      ],
    };
  },
};

function formatPromptRecord(value: unknown): string {
  if (value === null || value === undefined) {
    return "  null";
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return `  ${String(value)}`;
  }
  const lines = Object.entries(value as Record<string, unknown>).map(
    ([key, entry]) => {
      if (entry === null || entry === undefined) {
        return `  ${key}: null`;
      }
      if (Array.isArray(entry)) {
        return `  ${key}: [${entry.map((item) => String(item)).join(", ")}]`;
      }
      if (typeof entry === "object") {
        return `  ${key}: ${formatPromptRecord(entry).trim()}`;
      }
      return `  ${key}: ${String(entry)}`;
    },
  );
  return lines.length > 0 ? lines.join("\n") : "  null";
}

export function stringifyDeferredLifeDraftForPrompt(
  draft: DeferredLifeDraft,
): string {
  if (draft.operation === "create_definition") {
    return [
      `operation: ${draft.operation}`,
      `title: ${draft.request.title}`,
      `kind: ${draft.request.kind}`,
      "cadence:",
      formatPromptRecord(draft.request.cadence),
      `timezone: ${draft.request.timezone ?? "null"}`,
      `description: ${draft.request.description ?? "null"}`,
    ].join("\n");
  }

  return [
    `operation: ${draft.operation}`,
    `title: ${draft.request.title}`,
    "cadence:",
    formatPromptRecord(draft.request.cadence ?? null),
    `description: ${draft.request.description ?? "null"}`,
  ].join("\n");
}

export async function extractDeferredLifeDraftFollowupWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  currentText: string;
  draft: DeferredLifeDraft;
}): Promise<DeferredLifeDraftFollowupMode> {
  if (typeof args.runtime.useModel !== "function") {
    return null;
  }

  const recentConversation = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
  });
  const prompt = [
    "Decide how the assistant should interpret the user's follow-up to a previewed LifeOps draft that has not been saved yet.",
    "Use the current message, the draft summary, and recent conversation.",
    "The user may speak in any language.",
    "",
    'Return ONLY a JSON object with exactly this field, for example {"mode":"confirm"}.',
    "",
    "Choose confirm when the user clearly approves saving the current draft now, exactly as previewed.",
    "Choose edit when the user wants to change the draft or continue specifying it before saving. This INCLUDES an approval that adds or changes details in the same message ('yes, save it — but make it 9pm', 'save that plan. draft first, citations after dinner, final pass before the deadline'): approval that carries new or changed specifics is edit, not confirm, so the added details reach the saved item.",
    "Choose cancel when the user says not to save it, never mind, not now, hold off, or equivalent.",
    "Choose none when the follow-up is unrelated or too ambiguous to attach to the draft.",
    "",
    "Previewed draft:",
    stringifyDeferredLifeDraftForPrompt(args.draft),
    "",
    `Current user message: ${args.currentText.trim() || "(empty)"}`,
    "Recent conversation:",
    recentConversation.join("\n").trim() || "(empty)",
  ].join("\n");

  // A failed classification cannot mean "unrelated": that would start a new
  // extraction and may replace the pending draft. Let action settlement retain
  // the provider failure, including terminal context overflow, without effects.
  const result = await runWithTrajectoryPurpose("lifeops-deferred-draft", () =>
    args.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    }),
  );
  const raw = typeof result === "string" ? result : "";
  const parsed = parseJsonModelRecord<Record<string, unknown>>(raw);
  const mode =
    parsed && typeof parsed.mode === "string"
      ? parsed.mode.trim().toLowerCase()
      : "";
  switch (mode) {
    case "confirm":
    case "edit":
    case "cancel":
      return mode;
    default:
      return null;
  }
}

/**
 * Record of the most recent chat-sourced definition save in a room. The crisp
 * single-dated-ask fast path (#16935) persists without a preview turn, so the
 * owner's only undo affordance is a retraction on the NEXT turn ("actually
 * don't save that one"). Observed live (#16941, child-cancel-reask): the
 * planner answered such a retraction with a review call and a "won't save it"
 * reply while the row stayed active. This record lets the life handler
 * deterministically delete the just-saved row instead of trusting the
 * planner to pick action=delete.
 */
export type RecentLifeSaveRecord = {
  definitionId: string;
  title: string;
  /** Owner message id of the turn that saved. Guards same-turn re-entry. */
  sourceMessageId?: string;
  /** Epoch ms of the save. The retraction window mirrors draft expiry. */
  createdAt: number;
};

const RECENT_LIFE_SAVE_CACHE_PREFIX = "lifeops:recent-save";

/** Retraction is only honored this soon after an un-previewed save. */
export const RECENT_SAVE_RETRACTION_WINDOW_MS = DRAFT_EXPIRY_MS;

function recentLifeSaveCacheKey(
  runtime: IAgentRuntime,
  message: Memory,
): string {
  return [
    RECENT_LIFE_SAVE_CACHE_PREFIX,
    runtime.agentId,
    message.roomId,
    message.entityId,
  ].join(":");
}

export function coerceRecentLifeSaveRecord(
  value: unknown,
): RecentLifeSaveRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const definitionId =
    typeof record.definitionId === "string" && record.definitionId.length > 0
      ? record.definitionId
      : null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : null;
  if (!definitionId || !title || createdAt === null) {
    return null;
  }
  return {
    definitionId,
    title,
    createdAt,
    ...(typeof record.sourceMessageId === "string" &&
    record.sourceMessageId.length > 0
      ? { sourceMessageId: record.sourceMessageId }
      : {}),
  };
}

export async function readRecentLifeSaveCache(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RecentLifeSaveRecord | null> {
  const stored = await asCacheRuntime(runtime).getCache<unknown>(
    recentLifeSaveCacheKey(runtime, message),
  );
  const record = coerceRecentLifeSaveRecord(stored);
  if (!record) {
    return null;
  }
  if (Date.now() - record.createdAt > RECENT_SAVE_RETRACTION_WINDOW_MS) {
    return null;
  }
  return record;
}

export async function writeRecentLifeSaveCache(
  runtime: IAgentRuntime,
  message: Memory,
  record: RecentLifeSaveRecord,
): Promise<void> {
  await asCacheRuntime(runtime).setCache(
    recentLifeSaveCacheKey(runtime, message),
    record,
  );
}

export async function clearRecentLifeSaveCache(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<void> {
  await asCacheRuntime(runtime).deleteCache(
    recentLifeSaveCacheKey(runtime, message),
  );
}

// A retraction is a short-window undo of the item that just saved, so the
// vocabulary stays narrow: negated save/keep verbs and demonstrative
// cancel/undo forms. Broad phrases ("forget it") are still safe because the
// caller only consults this within RECENT_SAVE_RETRACTION_WINDOW_MS of an
// un-previewed save in the same room.
const LIFE_SAVE_RETRACTION_RE =
  /(?:\b(?:don'?t|do not|no,? don'?t)\b[^.!?\n]{0,40}\b(?:save|keep|set|schedule|add|create)\b\s+(?:that(?:\s+one)?|this(?:\s+one)?|it)\b|\b(?:cancel|undo|scrap|delete|remove|drop)\b\s+(?:that(?:\s+one)?|it|this(?:\s+one)?|the last one)\b|\bnever\s?mind\b|\bget rid of (?:that|it)\b)/i;

export function isLifeSaveRetraction(text: string): boolean {
  return LIFE_SAVE_RETRACTION_RE.test(text);
}
