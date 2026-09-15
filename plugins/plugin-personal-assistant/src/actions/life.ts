/**
 * Shared create/update/query engine for owner "life" items — reminder/todo/
 * routine definitions and goals — that backs the OWNER_* surfaces built in
 * `owner-surfaces.ts`.
 *
 * Classifies a natural-language request into a life operation, extracts the
 * structured definition and cadence via the LLM extractors in `lib/`, and
 * resolves one-off due dates against the owner timezone. Multi-turn create
 * flows preview a draft and save on a follow-up confirmation turn.
 */

import {
  extractConversationMetadataFromRoom,
  isPageScopedConversationMetadata,
  renderGroundedActionReply,
} from "@elizaos/agent";
import type {
  ActionResult,
  AgentContext,
  EffectReceipt,
  GroundedActionReply,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  applyGroundedActionReply,
  ElizaError,
  extractUserText,
  logger,
  NoModelProviderConfiguredError,
  normalizeEffectReceipt,
  resolveActionArgs,
  type SubactionsMap,
  validateUuid,
} from "@elizaos/core";
import type {
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGoalRequest,
  LifeOpsCadence,
  LifeOpsDailySlot,
  LifeOpsDefinitionRecord,
  LifeOpsDomain,
  LifeOpsGoalRecord,
  LifeOpsWindowPolicy,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
} from "../contracts/index.js";
import {
  calendarReadUnavailableMessage,
  getGoogleCapabilityStatus,
  gmailReadUnavailableMessage,
  INTERNAL_URL,
} from "../lifeops/access.js";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../lifeops/action-effect-result.js";
import {
  buildNativeAppleReminderMetadata,
  type NativeAppleReminderLikeKind,
  readNativeAppleReminderMetadata,
} from "../lifeops/apple-reminders.js";
import {
  resolveDefaultTimeZone,
  resolveDefaultWindowPolicy,
} from "../lifeops/defaults.js";
import {
  DEFINITION_CREATION_OPERATION,
  definitionCreationIdentity,
} from "../lifeops/definition-creation-identity.js";
import {
  dayRange,
  detailArray,
  detailBoolean,
  detailNumber,
  detailObject,
  detailString,
  formatCalendarEventDateTime,
  formatEmailTriage,
  formatOverviewForQuery,
  messageText,
  toActionData,
} from "../lifeops/google/format-helpers.js";
import { resolveOwnerTimeZone } from "../lifeops/owner/fact-store.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { normalizeExplicitTimeZoneToken } from "../lifeops/time/timezone.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../lifeops/time.js";
import {
  extractGoalCreatePlanWithLlm,
  extractGoalUpdatePlanWithLlm,
  mergeGoalMetadataWithGrounding,
} from "./lib/extract-goal-plan.js";
import {
  type ExtractedLifeMissingField,
  type ExtractedLifeOperation,
  extractLifeOperationWithLlm,
} from "./lib/extract-life-operation.js";
import {
  type ExtractedTaskParams,
  extractTaskCreatePlanWithLlm,
  textExplicitlyLeavesScheduleUnspecified,
  textStatesExplicitSchedule,
} from "./lib/extract-task-plan.js";
import {
  type ExtractedUpdateFields,
  extractUpdateFieldsWithLlm,
} from "./lib/extract-update-fields.js";
import {
  clearDeferredLifeDraftCache,
  clearRecentLifeSaveCache,
  countTurnsSinceLatestDeferredLifeDraft,
  type DeferredLifeDefinitionDraft,
  type DeferredLifeDraft,
  type DeferredLifeDraftFollowupMode,
  type DeferredLifeDraftReuseMode,
  type DeferredLifeGoalDraft,
  deferredLifeDraftExpiryReason,
  extractDeferredLifeDraftFollowupWithLlm,
  invalidateDeferredLifeDraftCache,
  isExplicitLifeCreateConfirmation,
  isLifeSaveRetraction,
  latestDeferredLifeDraft,
  latestDeferredLifeDraftIsInvalidated,
  readDeferredLifeDraftCacheState,
  readRecentLifeSaveCache,
  writeDeferredLifeDraftCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";
import {
  applyOwnerPolicyConfigureEscalation,
  applyOwnerPolicySetReminder,
} from "./lib/owner-policy-writes.js";
import { parseNativeTaskCreatePlan } from "./lib/task-create-plan-parameter.js";
import {
  resolveUndatedTodoAuthority,
  textStatesExplicitUndatedTodo,
} from "./lib/undated-todo-intent.js";

// ── Types ─────────────────────────────────────────────

type LifeOperation = ExtractedLifeOperation;
type LifeOwnedOperation = Exclude<
  LifeOperation,
  | "query_calendar_today"
  | "query_calendar_next"
  | "query_email"
  | "query_overview"
>;
/** Internal handler discriminator: definition vs goal flow. */
type LifeKind = "definition" | "goal";
type ResolvedLifeOperationPlan = {
  confidence: number | null;
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  kind?: LifeKind;
  shouldAct: boolean;
  /**
   * Params extracted by the shared `resolveActionArgs` pass (target, minutes,
   * preset, …). Gap-fillers only — explicit planner-supplied params win.
   */
  params?: LifeParams;
};

type LifeParams = {
  idempotencyKey?: string;
  action?: string;
  subaction?: LifeOperation;
  kind?: LifeKind;
  intent?: string;
  title?: string;
  target?: string;
  minutes?: number;
  preset?: string;
  /**
   * Planner-signalled owner confirmation of a previously previewed save.
   * The preview -> confirm handshake has no structured cross-turn draft
   * transport on the planner path, so the confirm turn ("yes, save that")
   * must re-call create with `confirmed: true`; the handler then saves the
   * re-extracted plan instead of previewing again.
   */
  confirmed?: boolean;
  createPlan?: unknown;
  details?: Record<string, unknown>;
  ownerSurface?: string;
};

const SUBACTIONS = {
  create: {
    description:
      "Create a life-item: kind=definition (habit/routine/reminder/alarm/todo) or kind=goal (long-term aspiration).",
    descriptionCompressed:
      "create life-item definition(habit|routine|reminder|alarm|todo)|goal; infer cadence/title",
    required: ["kind", "title"],
    optional: ["intent", "details"],
  },
  update: {
    description:
      "Update an existing life-item by id or title (kind: definition or goal).",
    descriptionCompressed: "update life-item by id/title: kind, target, fields",
    required: ["kind", "target"],
    optional: ["title", "details"],
  },
  delete: {
    description:
      "Delete a life-item by id or title (kind: definition or goal).",
    descriptionCompressed: "delete life-item by id/title",
    required: ["kind", "target"],
  },
  complete: {
    description:
      "Mark an occurrence as done. For a count quota, details.quantity is the positive number of units just completed and defaults to one.",
    descriptionCompressed:
      "mark occurrence done; count quota details.quantity defaults 1",
    required: ["target"],
    optional: ["details"],
  },
  reopen: {
    description:
      "Reopen a completed undated owner todo by its definition ID or unambiguous title.",
    descriptionCompressed:
      "reopen completed undated owner todo by definition ID/title",
    required: ["target"],
  },
  skip: {
    description: "Skip an occurrence.",
    descriptionCompressed: "skip occurrence",
    required: ["target"],
  },
  snooze: {
    description:
      "Snooze an occurrence by minutes or preset duration. minutes: numeric duration ('snooze 45 minutes' -> 45). preset: one of 15m | 30m | 1h | tonight | tomorrow_morning ('snooze until tomorrow morning' -> tomorrow_morning).",
    descriptionCompressed:
      "snooze occurrence; minutes=numeric duration; preset=15m|30m|1h|tonight|tomorrow_morning",
    required: ["target"],
    optional: ["minutes", "preset"],
  },
  review: {
    description: "Review progress on a goal.",
    descriptionCompressed: "review goal progress",
    required: ["target"],
  },
  policy_set_reminder: {
    description:
      "Set reminder intensity policy on the OwnerFactStore: minimal | normal | persistent | high_priority_only. Optional per-definition target.",
    descriptionCompressed:
      "policy.set_reminder: intensity=minimal|normal|persistent|high_priority_only",
    required: [],
    optional: ["intent", "details"],
  },
  policy_configure_escalation: {
    description:
      "Configure escalation policy on the OwnerFactStore (timeoutMinutes, callAfterMinutes). Optional per-definition target.",
    descriptionCompressed:
      "policy.configure_escalation: timeout-minutes call-after-no-response",
    required: [],
    optional: ["intent", "details"],
  },
} as const satisfies SubactionsMap<LifeOwnedOperation>;

/**
 * Internal handler key — the dispatch table inside the action handler still
 * branches on definition-vs-goal for create/update/delete because the
 * underlying LifeOpsService methods are split. The umbrella surface (the
 * SUBACTIONS map above) uses the 7 plain verbs and resolves the kind
 * separately via params.kind.
 */
type InternalLifeOp =
  | "create_definition"
  | "create_goal"
  | "update_definition"
  | "update_goal"
  | "delete_definition"
  | "delete_goal"
  | "complete_occurrence"
  | "reopen_definition"
  | "skip_occurrence"
  | "snooze_occurrence"
  | "review_goal"
  | "review_definitions"
  | "policy_set_reminder"
  | "policy_configure_escalation";

function toInternalLifeOp(
  operation: LifeOwnedOperation,
  kind: LifeKind | undefined,
): InternalLifeOp {
  switch (operation) {
    case "create":
      return kind === "goal" ? "create_goal" : "create_definition";
    case "update":
      return kind === "goal" ? "update_goal" : "update_definition";
    case "delete":
      return kind === "goal" ? "delete_goal" : "delete_definition";
    case "complete":
      return "complete_occurrence";
    case "reopen":
      return "reopen_definition";
    case "skip":
      return "skip_occurrence";
    case "snooze":
      return "snooze_occurrence";
    case "review":
      // A goal review ranks progress toward outcomes; every definition
      // surface (todos/habits/routines/reminders) reviews its tracked
      // definitions — including unscheduled ones that never materialize
      // occurrences and are invisible to the occurrence overview.
      return kind === "goal" ? "review_goal" : "review_definitions";
    case "policy_set_reminder":
      return "policy_set_reminder";
    case "policy_configure_escalation":
      return "policy_configure_escalation";
  }
}

function inferLifeKindFromIntent(intent: string): LifeKind {
  const normalized = intent.toLowerCase();
  if (
    /\bgoal\b|\baspirat|achiev|long[\s-]?term/.test(normalized) ||
    /\bi (?:want|hope|wish|aspire) to\b/.test(normalized)
  ) {
    return "goal";
  }
  return "definition";
}

function looksLikeGoalTrackingFollowup(intent: string): boolean {
  const normalized = intent.toLowerCase();
  const mentionsFrequency =
    /\b(?:\d+|one|two|three|four|five|six|seven)\s+times?\s+(?:a|per)\s+week\b/i.test(
      normalized,
    ) || /\b\d+\s*\/\s*week\b/i.test(normalized);
  return (
    /\bcount\s+it\s+if\b/i.test(normalized) &&
    (mentionsFrequency ||
      /\bnext\s+\d+\s+weeks?\b/i.test(normalized) ||
      /\bwalk\s+around\s+the\s+block\b/i.test(normalized))
  );
}

const GENERIC_DERIVED_TITLE_RE =
  /^(?:new\s+)?(?:habit|routine|task|goal|life goal|thing|item|something|anything|stuff|plan|reminder|todo|to do|achieve|achieve a|achieve an)$/i;
const BROAD_LIFE_DELETE_TARGET_RE =
  /^(?:all|everything|every\s+thing|all\s+(?:of\s+)?(?:it|them|this|that)|all\s+my\s+(?:reminders?|tasks?|todos?|to[- ]?dos?|goals?|habits?|routines?)|my\s+(?:whole|entire)\s+(?:list|schedule|routine|todo\s+list|to[- ]?do\s+list))$/i;
const BROAD_LIFE_DELETE_INTENT_RE =
  /\b(?:delete|remove|cancel|wipe|clear|get rid of|stop tracking)\b[\s\S]{0,80}\b(?:everything|all\s+(?:of\s+)?(?:it|them|this|that)|all\s+my\s+(?:reminders?|tasks?|todos?|to[- ]?dos?|goals?|habits?|routines?))\b/i;
const EMOTIONAL_DESTRUCTIVE_DELETE_RE =
  /\b(?:i\s+give\s+up|can't\s+do\s+(?:this|any\s+of\s+this)|clearly\s+can't|forget\s+it|i'?m\s+done|rage\s*quit|spiral(?:ing)?)\b/i;

function normalizeLifeTimeZoneToken(
  value: string | null | undefined,
): string | null {
  return normalizeExplicitTimeZoneToken(value);
}

function isBroadLifeDeleteRequest(args: {
  intent: string;
  targetName: string | undefined;
}): boolean {
  const normalizedTarget = normalizeTitle(args.targetName ?? "");
  if (normalizedTarget && BROAD_LIFE_DELETE_TARGET_RE.test(normalizedTarget)) {
    return true;
  }
  return (
    BROAD_LIFE_DELETE_INTENT_RE.test(args.intent) ||
    (/\bdelete\b|\bremove\b|\bwipe\b|\bclear\b/i.test(args.intent) &&
      EMOTIONAL_DESTRUCTIVE_DELETE_RE.test(args.intent))
  );
}

function isLifeOwnedOperation(
  value: LifeOperation | null | undefined,
): value is LifeOwnedOperation {
  return (
    value != null &&
    value !== "query_calendar_today" &&
    value !== "query_calendar_next" &&
    value !== "query_email" &&
    value !== "query_overview"
  );
}

function normalizeExplicitLifeAction(value: unknown):
  | {
      operation: LifeOperation;
      kind?: LifeKind;
    }
  | "phone"
  | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  switch (normalized) {
    case "create_goal":
    case "goal_create":
      return { operation: "create", kind: "goal" };
    case "create_definition":
    case "create_habit":
    case "create_routine":
    case "create_reminder":
    case "create_todo":
      return { operation: "create", kind: "definition" };
    case "calendar":
    case "query_calendar":
    case "query_calendar_today":
      return { operation: "query_calendar_today" };
    case "query_calendar_next":
    case "next_calendar":
      return { operation: "query_calendar_next" };
    case "email":
    case "gmail":
    case "query_email":
      return { operation: "query_email" };
    case "overview":
    case "query_overview":
      return { operation: "query_overview" };
    case "phone":
    case "capture_phone":
      return "phone";
    default:
      return isLifeOwnedOperation(normalized as LifeOperation)
        ? { operation: normalized as LifeOwnedOperation }
        : null;
  }
}

async function resolveLifeOperationPlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  explicitOperation: LifeOperation | undefined;
}): Promise<ResolvedLifeOperationPlan> {
  const { runtime, message, state, intent, explicitOperation } = args;
  if (explicitOperation) {
    return {
      operation: explicitOperation,
      confidence: 1,
      missing: [],
      shouldAct: true,
    };
  }

  const extracted = await extractLifeOperationWithLlm({
    runtime,
    message,
    state,
    intent,
  });
  if (
    !extracted.shouldAct ||
    !extracted.operation ||
    !isLifeOwnedOperation(extracted.operation)
  ) {
    return {
      operation: isLifeOwnedOperation(extracted.operation)
        ? extracted.operation
        : null,
      confidence: extracted.confidence,
      missing: extracted.missing,
      shouldAct: false,
    };
  }
  return {
    operation: extracted.operation,
    confidence: extracted.confidence,
    missing: extracted.missing,
    shouldAct: true,
  };
}

/**
 * Pre-routing pick of the owner operation action.
 *
 * Tries the shared `resolveActionArgs` substrate first (planner-trust path
 * + single LLM pass). Falls back to the LifeOps-specific extractor when
 * `resolveActionArgs` cannot pick a subaction confidently — that extractor
 * carries richer "missing field" diagnostics (`title`, `schedule`, etc.)
 * that downstream clarification messaging depends on.
 */
async function routeLifeSubaction(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  options: HandlerOptions | undefined;
  intent: string;
  explicitSubaction: LifeOperation | undefined;
}): Promise<ResolvedLifeOperationPlan> {
  const { runtime, message, state, options, intent, explicitSubaction } = args;
  if (explicitSubaction && !isLifeOwnedOperation(explicitSubaction)) {
    return {
      operation: explicitSubaction,
      confidence: 1,
      missing: [],
      shouldAct: true,
    };
  }
  try {
    const resolved = await resolveActionArgs<LifeOwnedOperation, LifeParams>({
      runtime,
      message,
      state,
      options,
      actionName: ownerSurfaceActionNameFromOptions(options),
      subactions: SUBACTIONS,
      intentHint: intent,
    });

    if (resolved.ok) {
      return {
        operation: resolved.subaction,
        confidence: 1,
        missing: [],
        shouldAct: true,
        params: resolved.params,
      };
    }

    return await resolveLifeOperationPlan({
      runtime,
      message,
      state,
      intent,
      explicitOperation: explicitSubaction,
    });
  } catch (error) {
    // error-policy:J4 A zero-key runtime cannot classify an unstructured LIFE
    // request; surface the existing reply-only state instead of a false action.
    if (error instanceof NoModelProviderConfiguredError) {
      return {
        operation: null,
        confidence: null,
        missing: [],
        shouldAct: false,
      };
    }
    throw error;
  }
}

function resolveDeferredLifeDraftReuseMode(args: {
  details: Record<string, unknown> | undefined;
  draft: DeferredLifeDraft | null;
  draftIsFromPriorTurn: boolean;
  explicitConfirmation?: boolean;
  explicitOperation: LifeOperation | undefined;
  llmMode?: DeferredLifeDraftFollowupMode;
  /** Number of messages since the draft was stored. */
  turnsSinceDraft?: number;
}): DeferredLifeDraftReuseMode | null {
  if (!args.draft) {
    return null;
  }

  if (deferredLifeDraftExpiryReason(args)) {
    return null;
  }

  // A planner can call the same action more than once while settling one
  // message. Only an explicit owner confirmation may reuse a draft whose
  // source turn cannot be proven older; planner flags and classifications are
  // never evidence that the owner saw the preview.
  if (!args.draftIsFromPriorTurn && args.explicitConfirmation !== true) {
    return null;
  }

  const explicitOperation = args.explicitOperation
    ? String(args.explicitOperation)
    : undefined;
  const draftOperation = String(args.draft.operation);
  const explicitOperationMatchesDraft =
    explicitOperation === draftOperation ||
    (explicitOperation === "create" && draftOperation.startsWith("create_"));
  if (explicitOperation && !explicitOperationMatchesDraft) {
    return null;
  }

  // Substantive follow-up text wins over planner-authored confirmation flags.
  // Otherwise “keep it undated, but Friday” can be treated as approval and
  // persist a changed schedule the owner has never previewed.
  if (args.llmMode === "edit") {
    return "edit";
  }

  if (args.explicitConfirmation === true) {
    return "confirm";
  }

  if (
    args.llmMode === "confirm" ||
    detailBoolean(args.details, "confirmed") === true
  ) {
    return "confirm";
  }
  return null;
}

// A confirmation is "bare" when stripping the yes-cues and politeness filler
// leaves essentially nothing — "yes save it exactly like that." is bare,
// "yes, save that plan. draft first, citations after dinner…" is not.
const LIFE_CONFIRMATION_CUE_STRIP_RE =
  /\b(?:ok|okay|yes|yep|yeah|sure|confirm|confirmed|approve|approved|save it|save that|save this|save the goal|set it|lock it in|do it|looks good|that works|go ahead)\b/gu;
const LIFE_CONFIRMATION_FILLER_STRIP_RE =
  /\b(?:please|pls|thanks|thank you|now|just|exactly|like|that|this|it|the|one|plan|sounds|good|great|perfect|awesome)\b/gu;

function isBareLifeCreateConfirmationMessage(text: string): boolean {
  if (!isExplicitLifeCreateConfirmation(text)) {
    return false;
  }
  const residue = extractUserText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(LIFE_CONFIRMATION_CUE_STRIP_RE, " ")
    .replace(LIFE_CONFIRMATION_FILLER_STRIP_RE, " ")
    .trim();
  return residue.length === 0;
}

function stringifyLifeDetailForPrompt(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => stringifyLifeDetailForPrompt(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const rendered = stringifyLifeDetailForPrompt(entry);
        return rendered ? `${key}: ${rendered}` : null;
      })
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join("; ") : null;
  }
  return null;
}

function summarizeGoalSupportStrategyForPreview(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["summary", "firstStep"] as const) {
    const rendered = stringifyLifeDetailForPrompt(record[key]);
    if (rendered) {
      parts.push(rendered);
    }
  }
  const suggestedSupport = record.suggestedSupport;
  if (Array.isArray(suggestedSupport)) {
    const supportItems = suggestedSupport
      .map((entry) => stringifyLifeDetailForPrompt(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (supportItems.length > 0) {
      parts.push(`Support includes ${supportItems.join(", ")}.`);
    }
  }
  return parts.length > 0 ? `Support plan: ${parts.join(" ")}` : null;
}

function textIncludesGoalDateDetail(text: string): boolean {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{2}-\d{2})\b/i.test(
    text,
  );
}

function textIncludesGoalCadenceDetail(text: string): boolean {
  return /\b(?:daily|weekly|monthly|weekday|weekends?|per\s+(?:day|week|month)|times?\s+(?:a|per)\s+(?:day|week|month)|blocks?|sessions?|practice)\b/i.test(
    text,
  );
}

function cleanGoalPreviewDetailText(text: string): string {
  return text
    .replace(
      /^(?:let'?s\s+define\s+success\s+as|define\s+success\s+as|make\s+it\s+mean|count\s+it\s+if)\s+/i,
      "",
    )
    .trim();
}

function summarizeGoalInputDetailsForPreview(
  inputText: string,
  previewText: string,
): string | null {
  const detailText = cleanGoalPreviewDetailText(inputText);
  if (!detailText) {
    return null;
  }
  const inputHasDate = textIncludesGoalDateDetail(detailText);
  const previewHasConcreteDate =
    textIncludesGoalDateDetail(previewText) &&
    !/\b(?:the\s+)?deadline\b/i.test(previewText);
  const inputHasCadence = textIncludesGoalCadenceDetail(detailText);
  const previewHasCadence = textIncludesGoalCadenceDetail(previewText);
  if (
    (inputHasDate && !previewHasConcreteDate) ||
    (inputHasCadence && !previewHasCadence)
  ) {
    return `Details: ${detailText}`;
  }
  return null;
}

function buildGoalGroundingIntent(
  intent: string,
  details: Record<string, unknown> | undefined,
): string {
  if (!details) {
    return intent;
  }
  const detailLines = Object.entries(details)
    .filter(([key]) => key !== "confirmed" && key !== "metadata")
    .map(([key, value]) => {
      const rendered = stringifyLifeDetailForPrompt(value);
      return rendered ? `${key}: ${rendered}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (detailLines.length === 0) {
    return intent;
  }
  return `${intent}\nDetails:\n${detailLines.join("\n")}`;
}

function shouldForceLifeCreateExecution(args: {
  intent: string;
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  kind: LifeKind | undefined;
  details: Record<string, unknown> | undefined;
  title: string | undefined;
}): boolean {
  if (args.operation !== "create" || args.kind === "goal") {
    return false;
  }

  const blockingFields = args.missing.filter(
    (field) => field !== "title" && field !== "schedule",
  );
  if (blockingFields.length > 0) {
    return false;
  }

  if (typeof args.title === "string" && args.title.trim().length > 0) {
    return true;
  }

  if (normalizeCadenceDetail(detailObject(args.details, "cadence"))) {
    return true;
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────

type LifeSnoozePreset = "15m" | "30m" | "1h" | "tonight" | "tomorrow_morning";

const LIFE_SNOOZE_PRESETS: ReadonlySet<string> = new Set([
  "15m",
  "30m",
  "1h",
  "tonight",
  "tomorrow_morning",
] satisfies LifeSnoozePreset[]);

function normalizeSnoozePreset(value: unknown): LifeSnoozePreset | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return LIFE_SNOOZE_PRESETS.has(normalized)
    ? (normalized as LifeSnoozePreset)
    : undefined;
}

/** LLM-extracted params arrive as raw JSON — minutes may be a numeric string. */
function normalizeSnoozeMinutes(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function requestedOwnership(domain?: LifeOpsDomain) {
  if (domain === "agent_ops") {
    return { domain: "agent_ops" as const, subjectType: "agent" as const };
  }
  return { domain: "user_lifeops" as const, subjectType: "owner" as const };
}

function normalizeIntentText(value: string): string {
  return normalizeLifeInputText(value).toLowerCase();
}

function normalizeLifeInputText(value: string): string {
  return value
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrimaryLifeInputText(value: string): string {
  const startMarker = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
  const endMarker = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
  const start = value.lastIndexOf(startMarker);
  if (start < 0) {
    return value;
  }

  const afterStart = value.slice(start + startMarker.length);
  const end = afterStart.indexOf(endMarker);
  const block = end >= 0 ? afterStart.slice(0, end) : afterStart;
  const delimiter = block.lastIndexOf("\n---");
  const payload = (delimiter >= 0 ? block.slice(delimiter + 4) : block).trim();
  return payload.length > 0 ? payload : value;
}

function normalizeTitle(value: string): string {
  return normalizeIntentText(value);
}

function goalSuccessCriteriaLooksConcrete(
  request: Pick<CreateLifeOpsGoalRequest, "successCriteria">,
): boolean {
  const criteriaText = JSON.stringify(request.successCriteria ?? "")
    .toLowerCase()
    .trim();
  if (!criteriaText) {
    return false;
  }
  return (
    /\d/.test(criteriaText) ||
    /\b(once|twice|daily|weekly|monthly)\b|(?:\bevery|\beach)\s+(?:day|week|month)\b|\bwithin\s+(?:a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:day|week|month)s?\b/.test(
      criteriaText,
    )
  );
}

function ownerTextHasConcreteGoalCriteria(value: string): boolean {
  const text = normalizeIntentText(value);
  return (
    /(?:\$|€|£)\s*\d/.test(text) ||
    /\b\d+\s*(?:x|times?|sessions?|blocks?|minutes?|mins?|hours?|days?|weeks?|months?|years?|percent|%)\b/.test(
      text,
    ) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:times?|sessions?|blocks?|minutes?|mins?|hours?|days?|weeks?|months?|years?)\b/.test(
      text,
    ) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/.test(
      text,
    ) ||
    /\b(?:once|twice|daily|weekly|monthly|every day|each day|every week|each week|per week|per month)\b/.test(
      text,
    )
  );
}

function buildConcreteGoalSuccessQuestion(title: string): string {
  return `I can draft this as "${title}", and I will not save it yet. What would count as success: how often you want to do it, what kind of attempt counts, or what evidence I should track?`;
}

function summaryFromGoalSection(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim().length > 0
    ? summary.trim()
    : null;
}

function buildSavedGoalReply(goal: {
  title: string;
  successCriteria?: unknown;
  supportStrategy?: unknown;
}): string {
  const parts = [`Saved — "${goal.title}".`];
  const successSummary = summaryFromGoalSection(goal.successCriteria);
  const supportSummary = summaryFromGoalSection(goal.supportStrategy);
  if (successSummary) {
    parts.push(`Success: ${successSummary}`);
  }
  if (supportSummary) {
    parts.push(`Plan: ${supportSummary}`);
  }
  return parts.join(" ");
}

function matchByTitle<
  T extends { definition?: { title: string }; goal?: { title: string } },
>(entries: T[], targetTitle: string): T | null {
  const normalized = normalizeTitle(targetTitle);
  return (
    entries.find(
      (e) =>
        normalizeTitle(e.definition?.title ?? e.goal?.title ?? "") ===
        normalized,
    ) ??
    entries.find((e) =>
      normalizeTitle(e.definition?.title ?? e.goal?.title ?? "").includes(
        normalized,
      ),
    ) ??
    null
  );
}

async function resolveGoal(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<LifeOpsGoalRecord | null> {
  if (!target) return null;
  const goals = (await service.listGoals()).filter((e) =>
    domain ? e.goal.domain === domain : true,
  );
  return goals.find((e) => e.goal.id === target) ?? matchByTitle(goals, target);
}

type DefinitionResult = {
  match: LifeOpsDefinitionRecord | null;
  ambiguousCandidates: string[];
};

/**
 * Definitions eligible for chat-side fuzzy/title resolution are only those
 * bound to this runtime's own identities: agent-subject rows must belong to
 * the agent and owner-subject rows to the configured owner entity. Rows
 * recorded for any other subject under the same agent are invisible here, so
 * planner text can only nominate — and mutations can only target — the
 * caller's own definitions (#17398).
 */
async function listCallerDefinitions(
  service: LifeOpsService,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord[]> {
  const agentId = service.agentId();
  const ownerEntityId = service.ownerEntityId();
  return (await service.listDefinitions()).filter((entry) => {
    if (domain && entry.definition.domain !== domain) return false;
    const expectedSubjectId =
      entry.definition.subjectType === "agent" ? agentId : ownerEntityId;
    return entry.definition.subjectId === expectedSubjectId;
  });
}

function resolveDefinitionInRecords(
  defs: LifeOpsDefinitionRecord[],
  target: string | undefined,
  destructive = false,
): DefinitionResult {
  if (!target) return { match: null, ambiguousCandidates: [] };
  const byId = defs.find((entry) => entry.definition.id === target);
  if (byId) {
    return { match: byId, ambiguousCandidates: [] };
  }
  const normalized = normalizeTitle(target);
  const exactMatches = defs.filter(
    (entry) => normalizeTitle(entry.definition.title) === normalized,
  );
  if (exactMatches.length === 1) {
    return {
      match: exactMatches.at(0) ?? null,
      ambiguousCandidates: [],
    };
  }
  if (exactMatches.length > 1) {
    return {
      match: null,
      ambiguousCandidates: exactMatches.map(definitionDisambiguationLabel),
    };
  }
  const substringMatches = defs.filter((entry) =>
    normalizeTitle(entry.definition.title).includes(normalized),
  );
  if (substringMatches.length === 1) {
    return {
      match: substringMatches.at(0) ?? null,
      ambiguousCandidates: [],
    };
  }
  if (substringMatches.length > 1) {
    return {
      match: null,
      ambiguousCandidates: substringMatches.map(definitionDisambiguationLabel),
    };
  }
  const targetTokens = new Set(tokenizeTitle(target));
  const scored = defs
    .map((entry) => ({
      entry,
      score: tokenizeTitle(entry.definition.title).filter((token) =>
        targetTokens.has(token),
      ).length,
    }))
    .filter(({ score }) => score > 0);
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  const bestMatches = scored
    .filter(({ score }) => score === bestScore)
    .map(({ entry }) => entry);
  // Destructive ops never act on a token-overlap guess: shared filler tokens
  // let "check the oven" resolve to "check the kettle" and DELETE the wrong
  // record with a confident receipt (live, watchtower's post-resurrection
  // audit). Sibling of the trigger path's TRIGGER_REF_MISMATCH guard: the
  // containment stages above (id / exact / substring) satisfy "one name
  // contains the other" and still resolve; a scorer-only "match" degrades to
  // a clarification candidate so the handler ASKS instead of deleting.
  if (bestMatches.length === 1 && !destructive) {
    return {
      match: bestMatches.at(0) ?? null,
      ambiguousCandidates: [],
    };
  }
  if (bestMatches.length >= 1) {
    return {
      match: null,
      ambiguousCandidates: bestMatches.map(definitionDisambiguationLabel),
    };
  }
  return { match: null, ambiguousCandidates: [] };
}

async function resolveDefinition(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
  destructive = false,
): Promise<DefinitionResult> {
  if (!target) return { match: null, ambiguousCandidates: [] };
  const defs = await listCallerDefinitions(service, domain);
  return resolveDefinitionInRecords(defs, target, destructive);
}

/** "title — cadence" disambiguation label so identical-title duplicates are
 * tellable-apart in a clarification list (live matrix F37: two "water the
 * ficus" reminders rendered as two identical lines with no times — an
 * unanswerable question). */
function definitionDisambiguationLabel(entry: LifeOpsDefinitionRecord): string {
  const when = summarizeCadence(entry.definition.cadence)?.trim();
  return when && when.length > 0
    ? `${entry.definition.title} — ${when}`
    : entry.definition.title;
}

/** Resolve a duplicate-title tie by a clock hint in the owner's own words:
 * each candidate's cadence summary contributes its clock tokens ("10am",
 * "5:30 pm"), and the tie resolves only when EXACTLY ONE candidate's tokens
 * appear in the owner text — zero or multiple hits keep the clarification
 * ask (destructive ops never act on a guess). */
function resolveDuplicateByTimeHint(
  candidates: LifeOpsDefinitionRecord[],
  ownerText: string,
): LifeOpsDefinitionRecord | null {
  const normalizedOwner = ownerText.toLowerCase().replace(/\s+/g, " ");
  const hits = candidates.filter((entry) => {
    const summary = summarizeCadence(entry.definition.cadence) ?? "";
    const clockTokens =
      summary.toLowerCase().match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/g) ?? [];
    return clockTokens.some((token) => {
      const variants = [token];
      // "10:00 am" and the owner's "10am" are the same clock time — an
      // on-the-hour summary also matches its bare-hour form.
      const onTheHour = token.match(/^(\d{1,2}):00\s*(am|pm)$/);
      if (onTheHour) variants.push(`${onTheHour[1]} ${onTheHour[2]}`);
      return variants.some((variant) => {
        const flexible = variant
          .replace(/\s+/g, "\\s*")
          .replace(/:/g, "[:. ]?");
        return new RegExp(`\\b${flexible}\\b`).test(normalizedOwner);
      });
    });
  });
  return hits.length === 1 ? (hits.at(0) ?? null) : null;
}

/** Records whose DISTINCT titles the owner named verbatim in one enumerated
 * delete ask ("delete these todos: A, B and C. keep D."). Destructive, so
 * every guard fails toward the single-target clarify path: at least two
 * DISTINCT titles must be verbatim-contained in the owner's own words; a
 * contained title matching more than one stored record aborts entirely
 * (duplicate titles keep the disambiguation ask); and a title preceded by a
 * keep-style cue ("keep X", "except X", "leave X", "but not X", "don't
 * delete X") is excluded from deletion rather than deleted by containment. */
const ENUMERATED_DELETE_KEEP_CUE_RE =
  /(?:\bkeep|\bexcept(?:\s+for)?|\bleave|\bbut\s+not|\bdon'?t\s+(?:delete|remove)|\bnot|\bspare)\s*(?:the\s+)?$/i;

async function resolveEnumeratedDeleteTargets(
  service: LifeOpsService,
  ownerText: string,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord[]> {
  const normalizedOwner = normalizeTitle(ownerText);
  if (!normalizedOwner) return [];
  const defs = (await service.listDefinitions()).filter((entry) =>
    domain ? entry.definition.domain === domain : true,
  );
  const byTitle = new Map<string, LifeOpsDefinitionRecord[]>();
  for (const entry of defs) {
    const key = normalizeTitle(entry.definition.title);
    if (!key) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), entry]);
  }
  const targets: LifeOpsDefinitionRecord[] = [];
  for (const [key, records] of byTitle) {
    // A very short title ("go", "gym") is contained in too much ordinary
    // prose to serve as a deletion warrant on its own.
    if (key.length < 4) continue;
    const index = normalizedOwner.indexOf(key);
    if (index < 0) continue;
    if (records.length !== 1) return [];
    const prefix = normalizedOwner.slice(Math.max(0, index - 32), index);
    if (ENUMERATED_DELETE_KEEP_CUE_RE.test(prefix)) continue;
    targets.push(records[0]);
  }
  return targets.length > 1 ? targets : [];
}

async function resolveDefinitionForMutation(
  service: LifeOpsService,
  target: string | undefined,
  ownerText: string,
  domain?: LifeOpsDomain,
  destructive = false,
): Promise<DefinitionResult> {
  const allDefinitions = await listCallerDefinitions(service, domain);
  const normalizedOwnerText = normalizeTitle(ownerText);
  // Exclusions apply to every matching path, including exact IDs and fuzzy
  // fallbacks. A later heuristic must not reintroduce a protected item.
  const defs = allDefinitions.filter((entry) => {
    const title = normalizeTitle(entry.definition.title);
    if (!title) return true;
    let index = normalizedOwnerText.indexOf(title);
    while (index >= 0) {
      if (
        ENUMERATED_DELETE_KEEP_CUE_RE.test(normalizedOwnerText.slice(0, index))
      )
        return false;
      index = normalizedOwnerText.indexOf(title, index + title.length);
    }
    return true;
  });
  const explicitlyNamed = defs.filter((entry) => {
    const title = normalizeTitle(entry.definition.title);
    return title.length > 0 && normalizedOwnerText.includes(title);
  });
  // An explicit durable ID is an identity constraint, never a hint that can
  // fall back to another owner's or another explicitly named item's title.
  if (validateUuid(target)) {
    const exactTarget = defs.find((entry) => entry.definition.id === target);
    if (
      !exactTarget ||
      (explicitlyNamed.length > 0 && !explicitlyNamed.includes(exactTarget))
    ) {
      return { match: null, ambiguousCandidates: [] };
    }
    return { match: exactTarget, ambiguousCandidates: [] };
  }
  const exactTitleTargets = target
    ? allDefinitions.filter(
        (entry) =>
          normalizeTitle(entry.definition.title) === normalizeTitle(target),
      )
    : [];
  if (
    exactTitleTargets.length > 0 &&
    exactTitleTargets.every((entry) => !defs.includes(entry))
  ) {
    return { match: null, ambiguousCandidates: [] };
  }
  if (destructive && exactTitleTargets.length > 0) {
    // Retain the original exact identity even when a keep cue excludes it.
    // Otherwise a longer title could replace that protected record as an alias.
    const authorizedTargets = exactTitleTargets.filter(
      (entry) =>
        defs.includes(entry) &&
        (explicitlyNamed.length === 0 || explicitlyNamed.includes(entry)),
    );
    const match =
      authorizedTargets.length === 1
        ? authorizedTargets[0]
        : resolveDuplicateByTimeHint(authorizedTargets, ownerText);
    return match
      ? { match, ambiguousCandidates: [] }
      : {
          match: null,
          ambiguousCandidates: authorizedTargets.map(
            definitionDisambiguationLabel,
          ),
        };
  }
  // A destructive target that failed exact matching must not be replaced by
  // a different title elsewhere in the request. Retain the existing narrow
  // target alias/substring contract, including its refusal to guess by tokens.
  if (destructive && target?.trim())
    return resolveDefinitionInRecords(defs, target, true);
  if (explicitlyNamed.length === 1) {
    return {
      match: explicitlyNamed.at(0) ?? null,
      ambiguousCandidates: [],
    };
  }
  if (explicitlyNamed.length > 1) {
    const byTimeHint = resolveDuplicateByTimeHint(explicitlyNamed, ownerText);
    if (byTimeHint) {
      return { match: byTimeHint, ambiguousCandidates: [] };
    }
    return {
      match: null,
      ambiguousCandidates: explicitlyNamed.map(definitionDisambiguationLabel),
    };
  }

  const ownerTokens = new Set(tokenizeTitle(ownerText));
  const scored = defs
    .map((entry) => ({
      entry,
      score: tokenizeTitle(entry.definition.title).filter((token) =>
        ownerTokens.has(token),
      ).length,
    }))
    .filter(({ score }) => score > 0);
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  const bestMatches = scored
    .filter(({ score }) => score === bestScore)
    .map(({ entry }) => entry);
  // Same destructive guard as resolveDefinitionInRecords: a token-overlap
  // "best match" is a guess, and guesses may not delete records. The explicit
  // containment branch above already resolved anything whose stored title
  // appears in the owner's text.
  if (bestMatches.length === 1 && !destructive) {
    return {
      match: bestMatches.at(0) ?? null,
      ambiguousCandidates: [],
    };
  }
  if (bestMatches.length >= 1) {
    const byTimeHint = resolveDuplicateByTimeHint(bestMatches, ownerText);
    if (byTimeHint) {
      return { match: byTimeHint, ambiguousCandidates: [] };
    }
    return {
      match: null,
      ambiguousCandidates: bestMatches.map(definitionDisambiguationLabel),
    };
  }
  return target
    ? resolveDefinitionInRecords(defs, target, destructive)
    : { match: null, ambiguousCandidates: [] };
}

function tokenizeTitle(value: string): string[] {
  return normalizeTitle(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

export async function resolveDefinitionFromIntent(
  service: LifeOpsService,
  target: string | undefined,
  intent: string,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord | null> {
  const direct = await resolveDefinition(service, target, domain);
  if (direct.match || direct.ambiguousCandidates.length > 0) {
    return direct.match;
  }
  const defs = await listCallerDefinitions(service, domain);
  const intentTokens = new Set(tokenizeTitle(intent));
  let best: LifeOpsDefinitionRecord | null = null;
  let bestScore = 0;
  let tied = false;
  for (const entry of defs) {
    const title = normalizeTitle(entry.definition.title);
    if (title.length > 0 && normalizeTitle(intent).includes(title)) {
      return entry;
    }
    const overlap = tokenizeTitle(entry.definition.title).filter((token) =>
      intentTokens.has(token),
    ).length;
    if (overlap === 0) {
      continue;
    }
    if (overlap > bestScore) {
      best = entry;
      bestScore = overlap;
      tied = false;
      continue;
    }
    if (overlap === bestScore) {
      tied = true;
    }
  }
  return bestScore > 0 && !tied ? best : null;
}

type OccurrenceResult = {
  match:
    | Awaited<
        ReturnType<LifeOpsService["getOverview"]>
      >["owner"]["occurrences"][number]
    | null;
  /** Non-empty only when resolution was ambiguous (2+ substring matches, no exact/prefix winner). */
  ambiguousCandidates: string[];
};

function formatOccurrenceDisambiguationLabel(
  occurrence: Awaited<
    ReturnType<LifeOpsService["getOverview"]>
  >["owner"]["occurrences"][number],
): string {
  const hints: string[] = [];
  if (
    typeof occurrence.windowName === "string" &&
    occurrence.windowName.trim()
  ) {
    hints.push(occurrence.windowName.trim());
  }
  if (occurrence.dueAt) {
    const dueAt = new Date(occurrence.dueAt);
    if (!Number.isNaN(dueAt.getTime())) {
      hints.push(
        dueAt.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    }
  }
  return hints.length > 0
    ? `${occurrence.title} (${hints.join(", ")})`
    : occurrence.title;
}

function narrowOccurrenceCandidates(
  matches: Awaited<
    ReturnType<LifeOpsService["getOverview"]>
  >["owner"]["occurrences"],
) {
  const actionableMatches = matches.filter(
    (occurrence) =>
      occurrence.state === "visible" || occurrence.state === "snoozed",
  );
  return actionableMatches.length > 0 ? actionableMatches : matches;
}

async function resolveOccurrence(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<OccurrenceResult> {
  if (!target) return { match: null, ambiguousCandidates: [] };
  const overview = await service.getOverview();
  const all = [
    ...overview.owner.occurrences,
    ...overview.agentOps.occurrences,
  ].filter((o) => (domain ? o.domain === domain : true));
  const normalized = normalizeTitle(target);

  // Exact ID match
  const byId = all.find((o) => o.id === target);
  if (byId) return { match: byId, ambiguousCandidates: [] };

  // Exact normalized-title match
  const exactMatches = all.filter(
    (o) => normalizeTitle(o.title) === normalized,
  );
  if (exactMatches.length === 1) {
    return { match: exactMatches.at(0) ?? null, ambiguousCandidates: [] };
  }
  if (exactMatches.length > 1) {
    const narrowedMatches = narrowOccurrenceCandidates(exactMatches);
    if (narrowedMatches.length === 1) {
      return { match: narrowedMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    return {
      match: null,
      ambiguousCandidates: narrowedMatches.map(
        formatOccurrenceDisambiguationLabel,
      ),
    };
  }

  // Substring matches — disambiguate when multiple
  const substringMatches = all.filter((o) =>
    normalizeTitle(o.title).includes(normalized),
  );
  if (substringMatches.length === 1) {
    return { match: substringMatches.at(0) ?? null, ambiguousCandidates: [] };
  }
  if (substringMatches.length > 1) {
    const narrowedSubstringMatches =
      narrowOccurrenceCandidates(substringMatches);
    if (narrowedSubstringMatches.length === 1) {
      return {
        match: narrowedSubstringMatches.at(0) ?? null,
        ambiguousCandidates: [],
      };
    }
    // Prefer startsWith over generic includes
    const startsWithMatches = narrowedSubstringMatches.filter((o) =>
      normalizeTitle(o.title).startsWith(normalized),
    );
    if (startsWithMatches.length === 1) {
      return {
        match: startsWithMatches.at(0) ?? null,
        ambiguousCandidates: [],
      };
    }
    if (startsWithMatches.length > 1) {
      return {
        match: null,
        ambiguousCandidates: startsWithMatches.map(
          formatOccurrenceDisambiguationLabel,
        ),
      };
    }
    // Still ambiguous — return candidates for the caller to list
    return {
      match: null,
      ambiguousCandidates: narrowedSubstringMatches.map(
        formatOccurrenceDisambiguationLabel,
      ),
    };
  }

  const targetTokens = normalized.split(/\s+/).filter(Boolean);
  if (targetTokens.length > 1) {
    const tokenSetMatches = all.filter((occurrence) => {
      const occurrenceTokens = new Set(
        normalizeTitle(occurrence.title).split(/\s+/).filter(Boolean),
      );
      return targetTokens.every((token) => occurrenceTokens.has(token));
    });
    if (tokenSetMatches.length === 1) {
      return { match: tokenSetMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    if (tokenSetMatches.length > 1) {
      const narrowedTokenSetMatches =
        narrowOccurrenceCandidates(tokenSetMatches);
      if (narrowedTokenSetMatches.length === 1) {
        return {
          match: narrowedTokenSetMatches.at(0) ?? null,
          ambiguousCandidates: [],
        };
      }
      return {
        match: null,
        ambiguousCandidates: narrowedTokenSetMatches.map(
          formatOccurrenceDisambiguationLabel,
        ),
      };
    }
  }

  return { match: null, ambiguousCandidates: [] };
}

function deriveOccurrenceTargetFromIntent(
  intent: string,
  operation: LifeOperation,
): string | null {
  const normalized = normalizeLifeInputText(intent);
  if (!normalized) {
    return null;
  }

  let candidate = normalized;
  if (operation === "snooze") {
    candidate = candidate
      .replace(
        /^(?:please\s+)?(?:snooze|postpone|push\b.*\bback|remind me later about)\s+/i,
        "",
      )
      .replace(/\bfor\s+\d+\s*(?:minutes?|hours?)\b.*$/i, "")
      .replace(/\b(?:until|til)\b.+$/i, "")
      .trim();
  } else if (operation === "skip") {
    candidate = candidate
      .replace(/^(?:please\s+)?(?:skip|pass on)\s+/i, "")
      .replace(/\b(?:today|tonight|for now)\b.*$/i, "")
      .trim();
  } else if (operation === "complete") {
    candidate = candidate
      .replace(
        /^(?:please\s+)?(?:mark\s+|i(?:'ve| have)?\s+|just\s+)?(?:done|completed|finished|did)\s+/i,
        "",
      )
      .replace(/\b(?:done|complete|completed|finished)\b.*$/i, "")
      .trim();
  }

  return candidate.length > 0 ? candidate : null;
}

async function resolveOccurrenceWithIntentFallback(args: {
  service: LifeOpsService;
  target: string | undefined;
  domain?: LifeOpsDomain;
  intent: string;
  operation: LifeOperation;
}): Promise<OccurrenceResult> {
  const direct = await resolveOccurrence(
    args.service,
    args.target,
    args.domain,
  );
  if (
    direct.match ||
    direct.ambiguousCandidates.length > 0 ||
    validateUuid(args.target)
  ) {
    return direct;
  }

  const fallbackTarget = deriveOccurrenceTargetFromIntent(
    args.intent,
    args.operation,
  );
  if (
    !fallbackTarget ||
    (args.target &&
      normalizeTitle(fallbackTarget) === normalizeTitle(args.target))
  ) {
    return direct;
  }

  return resolveOccurrence(args.service, fallbackTarget, args.domain);
}

function summarizeCadence(cadence: LifeOpsCadence): string {
  const cadenceWindows = Array.isArray(
    (cadence as { windows?: unknown }).windows,
  )
    ? ((cadence as { windows: string[] }).windows ?? []).filter(
        (windowName) =>
          typeof windowName === "string" && windowName.trim().length > 0,
      )
    : [];

  switch (cadence.kind) {
    case "unscheduled":
      return "no due date";
    case "once": {
      const dueAt = new Date(cadence.dueAt);
      if (Number.isNaN(dueAt.getTime())) {
        return "once";
      }
      return `once on ${dueAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: resolveDefaultTimeZone(),
      })}`;
    }
    case "daily":
      return cadenceWindows.length > 0
        ? `every day in ${cadenceWindows.join(", ")}`
        : "every day";
    case "times_per_day":
      return cadence.slots
        .map((slot) => slot.label.trim() || `${slot.minuteOfDay}`)
        .filter(Boolean)
        .join(" and ");
    case "count_per_day": {
      const work =
        cadence.perOccurrenceWork !== null
          ? `${cadence.perOccurrenceWork} `
          : "";
      const timing =
        cadence.timing.kind === "windows"
          ? `in the ${cadence.timing.windows.join(", ")}`
          : "any time";
      return `${work}${cadence.targetCount} ${cadence.unit}${
        cadence.targetCount === 1 ? "" : "s"
      } a day, ${timing}`;
    }
    case "interval":
      return cadenceWindows.length > 0
        ? `every ${cadence.everyMinutes} minutes in ${cadenceWindows.join(", ")}`
        : `every ${cadence.everyMinutes} minutes`;
    case "weekly":
      return `weekly on ${cadence.weekdays
        .map(
          (weekday) =>
            [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ][weekday] ?? String(weekday),
        )
        .join(", ")}`;
  }
}

type LifeReplyScenario =
  | "reply_only"
  | "clarify_create_definition"
  | "clarify_create_goal"
  | "preview_definition"
  | "saved_definition"
  | "preview_goal"
  | "saved_goal"
  | "updated_definition"
  | "updated_goal"
  | "deleted_definition"
  | "deleted_goal"
  | "completed_occurrence"
  | "skipped_occurrence"
  | "snoozed_occurrence"
  | "overview"
  | "calendar_today"
  | "calendar_next"
  | "email_triage"
  | "weekly_goal_review"
  | "definitions_review"
  | "service_error";

function buildRuleBasedLifeReply(args: {
  scenario: LifeReplyScenario;
  intent: string;
  fallback: string;
  context?: Record<string, unknown>;
}): string {
  const context = args.context ?? {};
  const updated =
    context.updated && typeof context.updated === "object"
      ? (context.updated as Record<string, unknown>)
      : null;
  const created =
    context.created && typeof context.created === "object"
      ? (context.created as Record<string, unknown>)
      : null;
  const title =
    (typeof updated?.title === "string" ? updated.title : null) ??
    (typeof created?.title === "string" ? created.title : null) ??
    (typeof context.title === "string" ? context.title : null) ??
    null;
  // Time-phrase nuance ("mornings now", "7pm now", etc.) is rendered by the
  // LLM in renderGroundedActionReply via the additionalRules contract. The
  // rule-based fallback intentionally only carries the title — never tries
  // to parse English-only time phrases out of the intent.

  switch (args.scenario) {
    case "updated_definition":
      if (title) {
        return `${title} is updated.`;
      }
      break;
    case "deleted_definition":
      if (title) {
        return `${title} is off your list.`;
      }
      break;
    case "deleted_goal":
      if (title) {
        return `${title} is off your goals list.`;
      }
      break;
    case "completed_occurrence":
      if (title) {
        return `Marked ${title} done.`;
      }
      break;
    case "skipped_occurrence":
      if (title) {
        return `Okay, skipping ${title} for now.`;
      }
      break;
    case "snoozed_occurrence":
      if (title) {
        return `Okay, I'll bring ${title} back a bit later.`;
      }
      break;
    default:
      break;
  }

  return args.fallback;
}

async function renderLifeActionReply(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: LifeReplyScenario;
  fallback: string;
  context?: Record<string, unknown>;
}): Promise<GroundedActionReply> {
  const { runtime, message, state, intent, scenario, fallback, context } = args;
  const naturalFallback = buildRuleBasedLifeReply({
    scenario,
    intent,
    fallback,
    context,
  });
  return renderGroundedActionReply({
    runtime,
    message,
    state,
    intent,
    domain: "lifeops",
    scenario,
    fallback: naturalFallback,
    context,
    preferCharacterVoice: true,
    additionalRules: [
      "Mirror the user's phrasing for time and date when possible.",
      "Prefer phrases like tomorrow morning, every night, 7 am, or the user's own wording over robotic schedule language.",
      "Never surface raw ISO timestamps unless the user used raw ISO timestamps.",
      "If this is a preview, make clear it is not saved yet and the user can confirm or change it naturally.",
      "If this is reply-only, do not pretend you saved or changed anything.",
      // Live receipts behind the two rules below: a review turn reported
      // "1/12 books done" for a goal that was never saved (the number came
      // from chat history, not records), and a compound ask got a false
      // "don't know your favorite color" from this renderer even though the
      // assistant's own context knew it (the fact lives outside lifeops).
      "Ground every factual claim — counts, progress numbers, item names, schedules, states — in the structured context provided for THIS reply. Never carry numbers or outcomes in from the conversation that the records here do not show; if the records show nothing, say the records show nothing.",
      "Answer only about the user's tracked items (todos, reminders, goals, routines, habits, alarms). If the user's message also asked about something outside these records — a personal fact, general knowledge, another tool — leave that part unaddressed rather than answering or denying it; the assistant covers it separately.",
    ],
  });
}

// Keep reply availability attached to the outcome until the action boundary
// binds its receipt. A missing reply must not discard an already committed write.
type PendingLifeActionResult = Omit<ActionResult, "text" | "userFacingText"> & {
  text?: string | GroundedActionReply;
  userFacingText?: string | GroundedActionReply;
};

function settleLifeActionReply(result: PendingLifeActionResult): ActionResult {
  const { text, userFacingText, ...outcome } = result;
  if (typeof text !== "object") {
    return {
      ...outcome,
      ...(text !== undefined ? { text } : {}),
      ...(typeof userFacingText === "string" ? { userFacingText } : {}),
    };
  }
  if (outcome.success === false && text.kind === "model") {
    // A renderer's prose is not verification of a rejected operation. Keep
    // the complete draft with its typed failure for the planner to resolve.
    return applyGroundedActionReply(
      {
        ...outcome,
        transcriptVisibility: "internal",
        verifiedUserFacing: false,
        turnComplete: false,
      },
      text,
    );
  }
  return applyGroundedActionReply(
    {
      ...outcome,
      ...(userFacingText !== undefined && text.kind === "model"
        ? { userFacingText: text.text }
        : {}),
    },
    text,
  );
}

function buildLifeClarificationFallback(args: {
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  kind: LifeKind | undefined;
}): string {
  const missing = new Set(args.missing);
  if (args.operation === "create" && args.kind === "goal") {
    return "What do you want the goal to be?";
  }
  if (missing.has("title") && missing.has("schedule")) {
    return "What do you want the todo to be, and when should it happen?";
  }
  if (missing.has("title")) {
    return "What do you want it to be?";
  }
  if (missing.has("schedule")) {
    return "When should it happen?";
  }
  return "Tell me a bit more about what you want to set up.";
}

function buildLifeServiceErrorFallback(
  error: LifeOpsServiceError,
  intent: string,
): string {
  const normalized = error.message.toLowerCase();
  if (
    normalized.includes("utc 'z' suffix") ||
    normalized.includes("local datetime without 'z'") ||
    normalized.includes("time didn't parse") ||
    normalized.includes("invalid dueat") ||
    normalized.includes("cadence.dueat")
  ) {
    return `I couldn't pin down the reminder time from "${intent}". Tell me the time again in plain language, like "Friday at 8 pm Pacific."`;
  }
  if (
    normalized.includes("when windowpreset is not provided") ||
    normalized.includes("startat is required")
  ) {
    return "I still need the time for that reminder. Tell me when it should happen.";
  }
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "LifeOps is rate-limited right now. Try again in a bit.";
  }
  return "I couldn't finish that LifeOps change yet. Tell me the task and timing again, and I'll try it a different way.";
}

type LifeConnectedQueryOperation =
  | "query_calendar_today"
  | "query_calendar_next"
  | "query_email";

/**
 * Serves the read-only connected-account queries (today's calendar, next
 * event, email triage). Availability is decided by the real Google capability
 * snapshot from `lifeops/access.ts` — plus `listCalendars` for Apple-native
 * calendars — so connected owners get their data and only genuinely
 * unconnected owners get a refusal. Exported for direct unit testing with a
 * stubbed service.
 */
async function runLifeConnectedQueryInner(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  service: LifeOpsService;
  queryOperation: LifeConnectedQueryOperation;
  actionName: string;
}): Promise<PendingLifeActionResult> {
  const {
    runtime,
    message,
    state,
    intent,
    service,
    queryOperation,
    actionName,
  } = args;
  try {
    const google = await getGoogleCapabilityStatus(service);
    if (queryOperation === "query_email") {
      if (!google.hasGmailTriage) {
        return {
          success: false,
          text: gmailReadUnavailableMessage(google),
          data: { actionName, operation: queryOperation },
        };
      }
      const feed = await service.getGmailTriage(INTERNAL_URL);
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "email_triage",
          fallback: formatEmailTriage(feed),
          context: {
            unreadCount: feed.summary.unreadCount,
            importantNewCount: feed.summary.importantNewCount,
            likelyReplyNeededCount: feed.summary.likelyReplyNeededCount,
            subjects: feed.messages.map((entry) => entry.subject),
          },
        }),
        data: toActionData(feed),
      };
    }
    const hasCalendarAccess =
      google.hasCalendarRead ||
      (await service.listCalendars(INTERNAL_URL)).length > 0;
    if (!hasCalendarAccess) {
      return {
        success: false,
        text: calendarReadUnavailableMessage(google),
        data: { actionName, operation: queryOperation },
      };
    }
    if (queryOperation === "query_calendar_next") {
      const next = await service.getNextCalendarEventContext(INTERNAL_URL);
      const fallback = next.event
        ? `Next up: "${next.event.title}" — ${formatCalendarEventDateTime(
            next.event,
            { includeTimeZoneName: true },
          )}${next.location ? ` at ${next.location}` : ""}.`
        : "No upcoming events on your calendar.";
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "calendar_next",
          fallback,
          context: {
            title: next.event?.title ?? null,
            startsAt: next.startsAt,
            startsInMinutes: next.startsInMinutes,
            location: next.location,
            attendeeNames: next.attendeeNames,
          },
        }),
        data: toActionData(next),
      };
    }
    const feed = await service.getCalendarFeed(INTERNAL_URL, {
      ...dayRange(0),
      timeZone: resolveDefaultTimeZone(),
    });
    const fallback =
      feed.events.length === 0
        ? "Your calendar is clear today."
        : [
            `You have ${feed.events.length} event${
              feed.events.length === 1 ? "" : "s"
            } today:`,
            ...feed.events.map(
              (event) =>
                `- ${event.title} (${formatCalendarEventDateTime(event)})`,
            ),
          ].join("\n");
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "calendar_today",
        fallback,
        context: {
          eventCount: feed.events.length,
          eventTitles: feed.events.map((event) => event.title),
        },
      }),
      data: toActionData(feed),
    };
  } catch (err) {
    if (err instanceof LifeOpsServiceError) {
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "service_error",
          fallback: buildLifeServiceErrorFallback(err, intent),
          context: { status: err.status, operation: queryOperation },
        }),
        data: { actionName, operation: queryOperation },
      };
    }
    throw err;
  }
}

export async function runLifeConnectedQuery(
  args: Parameters<typeof runLifeConnectedQueryInner>[0],
): Promise<ActionResult> {
  return settleLifeActionReply(await runLifeConnectedQueryInner(args));
}

// ── Calendar/email formatters ─────────────────────────

const DEFAULT_WINDOW_SLOT_TIMES: Record<
  "morning" | "afternoon" | "evening" | "night",
  { minuteOfDay: number; durationMinutes: number; label: string }
> = {
  morning: {
    minuteOfDay: 8 * 60,
    durationMinutes: 45,
    label: "Morning",
  },
  afternoon: {
    minuteOfDay: 13 * 60,
    durationMinutes: 45,
    label: "Afternoon",
  },
  evening: {
    minuteOfDay: 18 * 60,
    durationMinutes: 45,
    label: "Evening",
  },
  night: {
    minuteOfDay: 21 * 60,
    durationMinutes: 45,
    label: "Night",
  },
};

function buildSlotsFromWindows(
  windows: Array<"morning" | "afternoon" | "evening" | "night">,
): LifeOpsDailySlot[] {
  return windows.map((window, index) => {
    const preset = DEFAULT_WINDOW_SLOT_TIMES[window];
    return {
      key:
        windows.indexOf(window) === index ? window : `${window}-${index + 1}`,
      label: preset.label,
      minuteOfDay: preset.minuteOfDay,
      durationMinutes: preset.durationMinutes,
    };
  });
}

function inferWindowFromMinuteOfDay(
  minuteOfDay: number,
): "morning" | "afternoon" | "evening" | "night" {
  if (minuteOfDay < 12 * 60) {
    return "morning";
  }
  if (minuteOfDay < 17 * 60) {
    return "afternoon";
  }
  if (minuteOfDay < 21 * 60) {
    return "evening";
  }
  return "night";
}

function buildSingleDailySlot(
  minuteOfDay: number,
  durationMinutes = 45,
): LifeOpsDailySlot {
  return {
    key: `time-${minuteOfDay}`,
    label: formatMinuteOfDayLabel(minuteOfDay),
    minuteOfDay,
    durationMinutes,
  };
}

function buildCustomTimeWindowPolicy(
  minuteOfDay: number,
  timeZone: string,
): LifeOpsWindowPolicy {
  const basePolicy = resolveDefaultWindowPolicy(timeZone);
  return {
    timezone: basePolicy.timezone,
    windows: [
      ...basePolicy.windows,
      {
        name: "custom",
        label: formatMinuteOfDayLabel(minuteOfDay),
        startMinute: minuteOfDay,
        endMinute: Math.min(minuteOfDay + 1, 24 * 60),
      },
    ],
  };
}

function formatMinuteOfDayLabel(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const meridiem = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
}

function parseClockToken(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "noon") {
    return 12 * 60;
  }
  if (normalized === "midnight") {
    return 0;
  }
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute >= 60) {
    return null;
  }
  if (hour < 1 || hour > 12) {
    return null;
  }
  const meridiem = match[3];
  const normalizedHour =
    meridiem === "am" ? hour % 12 : hour % 12 === 0 ? 12 : (hour % 12) + 12;
  return normalizedHour * 60 + minute;
}

function parseTimeOfDayToken(token: string): number | null {
  const normalized = normalizeLifeInputText(token).toLowerCase();
  const hhmmMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const hour = Number(hhmmMatch[1]);
    const minute = Number(hhmmMatch[2]);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute < 60
    ) {
      return hour * 60 + minute;
    }
  }
  return parseClockToken(normalized);
}

function buildOneOffDueAtFromMinuteOfDay(args: {
  minuteOfDay: number;
  now?: Date;
  timeZone?: string;
}): string {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? resolveDefaultTimeZone();
  const nowParts = getZonedDateParts(now, timeZone);
  let localDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  const buildCandidate = () =>
    buildUtcDateFromLocalParts(timeZone, {
      ...localDate,
      hour: Math.floor(args.minuteOfDay / 60),
      minute: args.minuteOfDay % 60,
      second: 0,
    });

  let candidate = buildCandidate();
  if (candidate.getTime() <= now.getTime()) {
    localDate = addDaysToLocalDate(localDate, 1);
    candidate = buildCandidate();
  }

  return candidate.toISOString();
}

/** Default local wall-clock minute for dated one-off tasks without an explicit time (9:00 AM). */
const DEFAULT_ONCE_MINUTE_OF_DAY = 9 * 60;

/**
 * Resolve a one-off dueAt from the LLM-extracted datetime fields, against
 * the owner timezone. Returns null when the request carries no resolvable
 * time expression (or only a past instant) — the caller must then ask the
 * owner to clarify instead of scheduling anything.
 */
export function resolveOnceDueAt(args: {
  dueDate: string | null;
  dueInDays: number | null;
  dueWeekday: number | null;
  dueInMinutes: number | null;
  timeOfDayMinute: number | null;
  now?: Date;
  timeZone?: string;
}): string | null {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? resolveDefaultTimeZone();

  if (args.dueInMinutes !== null && args.dueInMinutes > 0) {
    return new Date(now.getTime() + args.dueInMinutes * 60_000).toISOString();
  }

  const minuteOfDay = args.timeOfDayMinute ?? DEFAULT_ONCE_MINUTE_OF_DAY;
  const buildCandidate = (localDate: {
    year: number;
    month: number;
    day: number;
  }) =>
    buildUtcDateFromLocalParts(timeZone, {
      ...localDate,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    });

  if (args.dueDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.dueDate);
    if (!match) {
      return null;
    }
    const candidate = buildCandidate({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    });
    // A named date already in the past is unresolvable — clarify, don't shift.
    return candidate.getTime() > now.getTime() ? candidate.toISOString() : null;
  }

  const nowParts = getZonedDateParts(now, timeZone);
  const today = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  if (args.dueInDays !== null && args.dueInDays >= 0) {
    const candidate = buildCandidate(addDaysToLocalDate(today, args.dueInDays));
    // "today at 8am" after 8am is unresolvable — clarify, don't roll forward.
    return candidate.getTime() > now.getTime() ? candidate.toISOString() : null;
  }

  if (
    args.dueWeekday !== null &&
    args.dueWeekday >= 0 &&
    args.dueWeekday <= 6
  ) {
    for (let offset = 0; offset <= 7; offset += 1) {
      const localDate = addDaysToLocalDate(today, offset);
      const weekday = new Date(
        Date.UTC(localDate.year, localDate.month - 1, localDate.day, 12),
      ).getUTCDay();
      if (weekday !== args.dueWeekday) {
        continue;
      }
      const candidate = buildCandidate(localDate);
      if (candidate.getTime() > now.getTime()) {
        return candidate.toISOString();
      }
    }
    return null;
  }

  if (args.timeOfDayMinute !== null) {
    return buildOneOffDueAtFromMinuteOfDay({
      minuteOfDay: args.timeOfDayMinute,
      now,
      timeZone,
    });
  }

  return null;
}

// Canonical comparison key for a cadence: deep key-sorted JSON, so two
// structurally identical cadences compare equal regardless of construction
// order. Used only by the duplicate-create guard.
function stableCadenceKey(cadence: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) continue;
        // Visibility lead/lag are scheduling presentation hints, not item
        // identity — a re-call that adds a lead-up shape must still hit the
        // content-duplicate guard.
        if (key === "visibilityLeadMinutes" || key === "visibilityLagMinutes")
          continue;
        out[key] = canonicalize(record[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(canonicalize(cadence));
}

function mergeMetadataRecords(
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign(
    {},
    ...records.filter(
      (record): record is Record<string, unknown> =>
        record != null && Object.keys(record).length > 0,
    ),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// A clock token under a preceding negation cue in the same clause is an
// EXCLUDED time ("no 8am/9am reminders", "do not set me a 9am ping"), not a
// requested slot. Clause scope resets at sentence boundaries and at
// contrastive connectives, so "no mornings, but 9pm works" still yields 9pm.
// "don't forget" is an idiom that AFFIRMS the following time, hence the
// lookahead carve-out.
const NEGATED_CLOCK_CUE_RE =
  /\b(?:no|not|don'?t|do\s+not|never|avoid|without|skip|drop|stop|instead\s+of|rather\s+than|none\s+of)\b(?!\s+forget\b)/i;
const CLOCK_CLAUSE_BOUNDARY_RE = /[.;!?\n—–]|\bbut\b/gi;

function clockClauseStart(intent: string, tokenStart: number): number {
  let clauseStart = 0;
  for (const boundary of intent.matchAll(CLOCK_CLAUSE_BOUNDARY_RE)) {
    if (boundary.index >= tokenStart) {
      break;
    }
    clauseStart = boundary.index + boundary[0].length;
  }
  return clauseStart;
}

function clockTokenIsNegated(intent: string, tokenStart: number): boolean {
  return NEGATED_CLOCK_CUE_RE.test(
    intent.slice(clockClauseStart(intent, tokenStart), tokenStart),
  );
}

// "due thursday at 5pm" names the DEADLINE, not a work slot — storing it as a
// daily slot schedules the work session exactly at the due instant (#16941
// live, night-owl: the saved plan's 17:00 slot coincided with the deadline).
const DEADLINE_CLOCK_CONTEXT_RE =
  /\b(?:due|deadline|submit(?:ted)?\s+by|turn(?:\s+it)?\s+in\s+by|hand(?:\s+it)?\s+in\s+by)\b[^.!?\n;]*$/i;

function clockTokenIsDeadline(intent: string, tokenStart: number): boolean {
  return DEADLINE_CLOCK_CONTEXT_RE.test(
    intent.slice(clockClauseStart(intent, tokenStart), tokenStart),
  );
}

// Owner-vocabulary day anchors that carry a concrete time but never match the
// numeric clock pattern ("citations after dinner", "again late evening").
// Conservative midpoints; negation/deadline scoping applies the same way.
const PHRASE_SLOT_MINUTES: ReadonlyArray<[RegExp, number]> = [
  [/\bafter\s+dinner\b/gi, 19 * 60 + 30],
  [/\bafter\s+lunch\b/gi, 13 * 60 + 30],
  [/\bafter\s+school\b/gi, 15 * 60 + 30],
  [/\blate\s+(?:evening|night)\b/gi, 21 * 60 + 30],
  [/\bbefore\s+bed(?:time)?\b/gi, 21 * 60 + 30],
];

function extractExplicitDailySlots(intent: string): LifeOpsDailySlot[] {
  const tokens: Array<{ label: string; minuteOfDay: number }> = [];
  for (const match of intent.matchAll(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/gi,
  )) {
    const token = match[1];
    if (typeof token !== "string" || token.length === 0) {
      continue;
    }
    if (
      clockTokenIsNegated(intent, match.index) ||
      clockTokenIsDeadline(intent, match.index)
    ) {
      continue;
    }
    const minuteOfDay = parseClockToken(token);
    if (minuteOfDay !== null) {
      tokens.push({ label: token.trim(), minuteOfDay });
    }
  }
  for (const [phraseRe, minuteOfDay] of PHRASE_SLOT_MINUTES) {
    for (const match of intent.matchAll(phraseRe)) {
      if (
        clockTokenIsNegated(intent, match.index) ||
        clockTokenIsDeadline(intent, match.index)
      ) {
        continue;
      }
      tokens.push({ label: match[0].trim().toLowerCase(), minuteOfDay });
    }
  }
  const seen = new Set<number>();
  const slots: LifeOpsDailySlot[] = [];
  for (const [index, token] of tokens.entries()) {
    if (seen.has(token.minuteOfDay)) {
      continue;
    }
    seen.add(token.minuteOfDay);
    slots.push({
      key: `clock-${index + 1}`,
      label: token.label,
      minuteOfDay: token.minuteOfDay,
      durationMinutes: 45,
    });
  }
  return slots.sort((left, right) => left.minuteOfDay - right.minuteOfDay);
}

function normalizeLifeWindows(
  value: unknown,
): Array<"morning" | "afternoon" | "evening" | "night"> {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = values.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const lower = normalizeLifeInputText(entry).toLowerCase();
    if (lower === "morning") return ["morning" as const];
    if (lower === "afternoon") return ["afternoon" as const];
    if (lower === "evening") return ["evening" as const];
    if (lower === "night") return ["night" as const];
    return [];
  });
  return [...new Set(normalized)];
}

function normalizeCadenceDetail(value: unknown): LifeOpsCadence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const cadenceKind =
    typeof record.kind === "string"
      ? normalizeLifeInputText(record.kind).toLowerCase()
      : typeof record.type === "string"
        ? normalizeLifeInputText(record.type).toLowerCase()
        : "";

  if (!cadenceKind) {
    return undefined;
  }

  if (cadenceKind === "unscheduled") {
    return { kind: "unscheduled" };
  }

  if (cadenceKind === "once" && typeof record.dueAt === "string") {
    return {
      kind: "once",
      dueAt: record.dueAt,
    };
  }

  if (cadenceKind === "interval") {
    const everyMinutes =
      typeof record.everyMinutes === "number"
        ? record.everyMinutes
        : typeof record.everyMinutes === "string"
          ? Number(record.everyMinutes)
          : typeof record.minutes === "number"
            ? record.minutes
            : typeof record.minutes === "string"
              ? Number(record.minutes)
              : NaN;
    if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
      return {
        kind: "interval",
        everyMinutes,
        windows: normalizeLifeWindows(record.windows),
      };
    }
    return undefined;
  }

  if (cadenceKind === "weekly") {
    const weekdays = Array.isArray(record.weekdays)
      ? record.weekdays
          .map((entry) =>
            typeof entry === "number"
              ? entry
              : typeof entry === "string"
                ? Number(entry)
                : NaN,
          )
          .filter((entry) => Number.isFinite(entry))
      : [];
    if (weekdays.length > 0) {
      return {
        kind: "weekly",
        weekdays,
        windows: normalizeLifeWindows(record.windows),
      };
    }
    return undefined;
  }

  const explicitTimes = Array.isArray(record.times)
    ? record.times
        .map((entry) =>
          typeof entry === "string" ? parseTimeOfDayToken(entry) : null,
        )
        .filter((entry): entry is number => entry !== null)
    : [];
  if (explicitTimes.length > 0) {
    return {
      kind: "times_per_day",
      slots: explicitTimes.map((minuteOfDay, index) => ({
        key: `time-${index + 1}`,
        label: formatMinuteOfDayLabel(minuteOfDay),
        minuteOfDay,
        durationMinutes: 45,
      })),
      visibilityLeadMinutes: 90,
      visibilityLagMinutes: 180,
    };
  }

  if (cadenceKind === "times_per_day") {
    if (Array.isArray(record.slots)) {
      const slots = record.slots
        .map((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return null;
          }
          const slot = entry as Record<string, unknown>;
          const minuteOfDay =
            typeof slot.minuteOfDay === "number"
              ? slot.minuteOfDay
              : typeof slot.minuteOfDay === "string"
                ? Number(slot.minuteOfDay)
                : null;
          if (minuteOfDay === null || !Number.isFinite(minuteOfDay)) {
            return null;
          }
          return {
            key:
              typeof slot.key === "string" && slot.key.trim().length > 0
                ? slot.key
                : `slot-${index + 1}`,
            label:
              typeof slot.label === "string" && slot.label.trim().length > 0
                ? slot.label
                : formatMinuteOfDayLabel(minuteOfDay),
            minuteOfDay,
            durationMinutes:
              typeof slot.durationMinutes === "number" &&
              Number.isFinite(slot.durationMinutes) &&
              slot.durationMinutes > 0
                ? slot.durationMinutes
                : 45,
          } satisfies LifeOpsDailySlot;
        })
        .filter((entry): entry is LifeOpsDailySlot => entry !== null);
      if (slots.length > 0) {
        return {
          kind: "times_per_day",
          slots,
          visibilityLeadMinutes:
            typeof record.visibilityLeadMinutes === "number"
              ? record.visibilityLeadMinutes
              : 90,
          visibilityLagMinutes:
            typeof record.visibilityLagMinutes === "number"
              ? record.visibilityLagMinutes
              : 180,
        };
      }
    }

    const count =
      typeof record.count === "number"
        ? record.count
        : typeof record.count === "string"
          ? Number(record.count)
          : NaN;
    // A bare count ("3 times a day") is a flexible daily quota: never
    // fabricate wall-clock slot times the owner did not name.
    if (Number.isFinite(count) && count > 0) {
      return {
        kind: "count_per_day",
        targetCount: Math.trunc(count),
        unit: "time",
        perOccurrenceWork: null,
        timing: { kind: "anytime" },
      };
    }
  }

  if (cadenceKind === "count_per_day") {
    const rawTarget = record.targetCount ?? record.count;
    const targetCount =
      typeof rawTarget === "number"
        ? rawTarget
        : typeof rawTarget === "string"
          ? Number(rawTarget)
          : NaN;
    if (Number.isFinite(targetCount) && targetCount > 0) {
      const timingRecord =
        record.timing && typeof record.timing === "object"
          ? (record.timing as Record<string, unknown>)
          : undefined;
      const timingWindows = normalizeLifeWindows(
        timingRecord?.windows ?? record.windows,
      );
      return {
        kind: "count_per_day",
        targetCount: Math.trunc(targetCount),
        unit:
          typeof record.unit === "string" && record.unit.trim().length > 0
            ? record.unit.trim()
            : "time",
        perOccurrenceWork:
          typeof record.perOccurrenceWork === "string" &&
          record.perOccurrenceWork.trim().length > 0
            ? record.perOccurrenceWork.trim()
            : null,
        timing:
          timingWindows.length > 0
            ? { kind: "windows", windows: timingWindows }
            : { kind: "anytime" },
      };
    }
    return undefined;
  }

  if (cadenceKind === "daily") {
    const windows = normalizeLifeWindows(record.windows ?? record.window);
    if (windows.length > 0) {
      return {
        kind: "daily",
        windows,
      };
    }
    return {
      kind: "daily",
      windows: ["morning"],
    };
  }

  return undefined;
}

/**
 * Convert LLM-extracted params into a typed LifeOpsCadence.
 * Returns null when the LLM output is insufficient to construct a
 * valid cadence — for "once" that means no resolvable time expression,
 * and the caller asks the owner to clarify instead of scheduling.
 */
export function buildCadenceFromLlmParams(
  params: ExtractedTaskParams,
  context?: {
    allowUnscheduled?: boolean;
    intent?: string;
    now?: Date;
    timeZone?: string;
  },
): {
  cadence: LifeOpsCadence;
  windowPolicy?: CreateLifeOpsDefinitionRequest["windowPolicy"];
} | null {
  const kind = params.cadenceKind;
  if (!kind) return null;
  // Explicitly undated ("no due date", "just a plain todo"): a real answer,
  // not a missing one — no windows/slots machinery applies.
  if (kind === "unscheduled") {
    return context?.allowUnscheduled === true
      ? { cadence: { kind: "unscheduled" } }
      : null;
  }
  const effectiveTimeZone = context?.timeZone;
  const timeOfDayMinute =
    typeof params.timeOfDay === "string"
      ? parseTimeOfDayToken(params.timeOfDay)
      : null;
  const explicitSlots =
    typeof context?.intent === "string"
      ? extractExplicitDailySlots(context.intent)
      : [];
  const slotDuration =
    typeof params.durationMinutes === "number" && params.durationMinutes > 0
      ? params.durationMinutes
      : 45;

  const windows = (params.windows ?? []).filter(
    (w): w is "morning" | "afternoon" | "evening" | "night" =>
      w === "morning" || w === "afternoon" || w === "evening" || w === "night",
  );
  const effectiveWindows =
    windows.length > 0
      ? windows
      : timeOfDayMinute !== null
        ? [inferWindowFromMinuteOfDay(timeOfDayMinute)]
        : ["morning" as const];

  if (kind === "once") {
    const dueAt = resolveOnceDueAt({
      dueDate: params.dueDate,
      dueInDays: params.dueInDays,
      dueWeekday: params.dueWeekday,
      dueInMinutes: params.dueInMinutes,
      timeOfDayMinute,
      now: context?.now,
      timeZone: effectiveTimeZone,
    });
    // No resolvable time expression — never fabricate an immediate dueAt.
    return dueAt ? { cadence: { kind: "once", dueAt } } : null;
  }
  if (kind === "daily") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes,
          })),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute, slotDuration)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (effectiveWindows.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: buildSlotsFromWindows(effectiveWindows),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return { cadence: { kind: "daily", windows: effectiveWindows } };
  }
  if (kind === "weekly") {
    const weekdays = params.weekdays;
    if (!weekdays || weekdays.length === 0) return null;
    if (timeOfDayMinute !== null) {
      return {
        cadence: { kind: "weekly", weekdays, windows: ["custom"] },
        windowPolicy: buildCustomTimeWindowPolicy(
          timeOfDayMinute,
          effectiveTimeZone ?? resolveDefaultTimeZone(),
        ),
      };
    }
    return { cadence: { kind: "weekly", weekdays, windows: effectiveWindows } };
  }
  if (kind === "interval") {
    const everyMinutes = params.everyMinutes;
    if (!everyMinutes || everyMinutes <= 0) return null;
    return {
      cadence: {
        kind: "interval",
        everyMinutes,
        windows: effectiveWindows,
        startMinuteOfDay: timeOfDayMinute ?? undefined,
        durationMinutes:
          typeof params.durationMinutes === "number" &&
          params.durationMinutes > 0
            ? params.durationMinutes
            : undefined,
      },
    };
  }
  if (kind === "times_per_day" || kind === "count_per_day") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes,
          })),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute, slotDuration)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    const count = params.quotaTargetCount ?? params.timesPerDay;
    if (!count || count <= 0) return null;
    // The owner gave a count with no clock times: this is a flexible daily
    // quota. Fabricating distributed minuteOfDay slots here invented
    // 08:00/13:00/20:00 schedules the owner never asked for (#17025); an
    // explicitly named window set constrains the quota without slot times.
    return {
      cadence: {
        kind: "count_per_day",
        targetCount: Math.trunc(count),
        unit: params.quotaUnit ?? "time",
        perOccurrenceWork: params.perOccurrenceWork ?? null,
        timing:
          windows.length > 0
            ? { kind: "windows", windows }
            : { kind: "anytime" },
      },
    };
  }
  return null;
}

export function buildCadenceFromUpdateFields(args: {
  currentCadence: LifeOpsCadence;
  currentWindowPolicy: LifeOpsWindowPolicy;
  update: ExtractedUpdateFields;
  timeZone: string;
  /** Clock override for tests; defaults to the system clock. */
  now?: Date;
}): {
  cadence: LifeOpsCadence;
  windowPolicy?: UpdateLifeOpsDefinitionRequest["windowPolicy"];
} | null {
  const { currentCadence, currentWindowPolicy, timeZone, update } = args;
  const kind = (update.cadenceKind ??
    currentCadence.kind) as LifeOpsCadence["kind"];
  const requestedWindows = normalizeLifeWindows(update.windows ?? []);
  const timeOfDayMinute =
    typeof update.timeOfDay === "string"
      ? parseTimeOfDayToken(update.timeOfDay)
      : null;

  if (kind === "interval") {
    const everyMinutes =
      update.everyMinutes ??
      (currentCadence.kind === "interval" ? currentCadence.everyMinutes : null);
    if (!everyMinutes || everyMinutes <= 0) {
      return null;
    }
    const windows: Array<"morning" | "afternoon" | "evening" | "night"> =
      requestedWindows.length > 0
        ? requestedWindows
        : currentCadence.kind === "interval" &&
            currentCadence.windows.length > 0
          ? normalizeLifeWindows(currentCadence.windows)
          : timeOfDayMinute !== null
            ? [inferWindowFromMinuteOfDay(timeOfDayMinute)]
            : ["morning"];
    return {
      cadence: {
        kind: "interval",
        everyMinutes,
        windows,
        startMinuteOfDay:
          timeOfDayMinute ??
          (currentCadence.kind === "interval"
            ? currentCadence.startMinuteOfDay
            : undefined),
        maxOccurrencesPerDay:
          currentCadence.kind === "interval"
            ? currentCadence.maxOccurrencesPerDay
            : undefined,
        durationMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.durationMinutes
            : undefined,
        visibilityLeadMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
    };
  }

  if (kind === "weekly") {
    const weekdays =
      update.weekdays ??
      (currentCadence.kind === "weekly" ? currentCadence.weekdays : null);
    if (!weekdays || weekdays.length === 0) {
      return null;
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "weekly",
          weekdays,
          windows: ["custom"],
          visibilityLeadMinutes:
            currentCadence.kind === "weekly"
              ? currentCadence.visibilityLeadMinutes
              : undefined,
          visibilityLagMinutes:
            currentCadence.kind === "weekly"
              ? currentCadence.visibilityLagMinutes
              : undefined,
        },
        windowPolicy: buildCustomTimeWindowPolicy(timeOfDayMinute, timeZone),
      };
    }
    return {
      cadence: {
        kind: "weekly",
        weekdays,
        windows:
          requestedWindows.length > 0
            ? requestedWindows
            : currentCadence.kind === "weekly" &&
                currentCadence.windows.length > 0
              ? currentCadence.windows
              : ["morning"],
        visibilityLeadMinutes:
          currentCadence.kind === "weekly"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "weekly"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
      windowPolicy: currentWindowPolicy.windows.some((window) =>
        (requestedWindows.length > 0
          ? requestedWindows
          : ["morning" as const]
        ).includes(
          window.name as "morning" | "afternoon" | "evening" | "night",
        ),
      )
        ? undefined
        : resolveDefaultWindowPolicy(timeZone),
    };
  }

  if (kind === "daily") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return {
      cadence: {
        kind: "daily",
        windows:
          requestedWindows.length > 0
            ? requestedWindows
            : currentCadence.kind === "daily" &&
                currentCadence.windows.length > 0
              ? currentCadence.windows
              : ["morning"],
        visibilityLeadMinutes:
          currentCadence.kind === "daily"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "daily"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
    };
  }

  if (kind === "count_per_day") {
    const targetCount =
      update.quotaTargetCount ??
      (currentCadence.kind === "count_per_day"
        ? currentCadence.targetCount
        : null);
    if (!targetCount || targetCount <= 0) return null;
    return {
      cadence: {
        kind: "count_per_day",
        targetCount: Math.trunc(targetCount),
        unit:
          update.quotaUnit ??
          (currentCadence.kind === "count_per_day"
            ? currentCadence.unit
            : "time"),
        perOccurrenceWork:
          update.perOccurrenceWork ??
          (currentCadence.kind === "count_per_day"
            ? currentCadence.perOccurrenceWork
            : null),
        timing:
          requestedWindows.length > 0
            ? { kind: "windows", windows: requestedWindows }
            : currentCadence.kind === "count_per_day"
              ? currentCadence.timing
              : { kind: "anytime" },
      },
    };
  }

  if (kind === "times_per_day") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (requestedWindows.length > 0) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: buildSlotsFromWindows(requestedWindows),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return currentCadence.kind === "times_per_day"
      ? { cadence: currentCadence }
      : null;
  }

  // once: a date-level move ("push it to Friday", "move it to april 17")
  // and/or an explicit new time moves the dueAt. With neither there is
  // nothing to change — return null so the caller reports that honestly
  // instead of re-saving the old dueAt and claiming an update happened.
  if (kind === "once") {
    const hasDateMove =
      update.dueDate !== null ||
      update.dueInDays !== null ||
      update.dueWeekday !== null ||
      update.dueInMinutes !== null;
    if (hasDateMove) {
      const dueAt = resolveOnceDueAt({
        dueDate: update.dueDate,
        dueInDays: update.dueInDays,
        dueWeekday: update.dueWeekday,
        dueInMinutes: update.dueInMinutes,
        timeOfDayMinute,
        now: args.now,
        timeZone,
      });
      // Unresolvable (e.g. a named date already in the past) — report
      // honestly rather than writing a bogus dueAt.
      return dueAt ? { cadence: { kind: "once", dueAt } } : null;
    }
    if (timeOfDayMinute !== null) {
      if (currentCadence.kind !== "once") {
        return null;
      }
      const currentLocalDate = getZonedDateParts(
        new Date(currentCadence.dueAt),
        currentWindowPolicy.timezone,
      );
      return {
        cadence: {
          kind: "once",
          dueAt: buildUtcDateFromLocalParts(timeZone, {
            year: currentLocalDate.year,
            month: currentLocalDate.month,
            day: currentLocalDate.day,
            hour: Math.floor(timeOfDayMinute / 60),
            minute: timeOfDayMinute % 60,
            second: 0,
          }).toISOString(),
        },
      };
    }
  }
  return null;
}

function hasDefinitionUpdateChanges(
  request: UpdateLifeOpsDefinitionRequest,
): boolean {
  return (
    request.title != null ||
    request.timezone != null ||
    request.cadence != null ||
    request.priority != null ||
    request.description != null ||
    request.windowPolicy != null ||
    request.reminderPlan != null ||
    request.checkInPolicy !== undefined
  );
}

function buildDefaultReminderPlan(
  label: string,
): NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]> {
  return {
    steps: [{ channel: "in_app", offsetMinutes: 0, label }],
  };
}

// "bug me before friday too", "remind me earlier as well", "not just friday
// morning" — an explicit ask for a lead-up nudge on top of the due-time
// reminder. Kept as a deterministic detector because the ask arrives inside a
// confirmation turn where extraction focuses on the base item (#16941 live:
// the earlier checkpoint was proposed in prose but never persisted).
const EARLIER_NUDGE_ASK_RE =
  /(?:\b(?:bug|remind|nudge|ping|poke)\s+me\b[^.!?\n]{0,60}\b(?:before|earlier|ahead of|leading up)\b|\bcan\s+it\b[^.!?\n]{0,60}\bbefore\b|\bnot just\b[^.!?\n]{0,40}\b(?:morning|tonight|that day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bearlier\s+(?:nudge|reminder|check[-\s]?in|checkpoint|heads[-\s]?up)\b)/i;

export function wantsEarlierReminderNudge(text: string): boolean {
  return EARLIER_NUDGE_ASK_RE.test(text);
}

/** "-4320" -> "3 days", "-1440" -> "a day", "-90" -> "1.5 hours". */
export function formatLeadOffsetPhrase(offsetMinutes: number): string {
  const minutes = Math.abs(offsetMinutes);
  if (minutes >= 1380 && minutes <= 1500) {
    return "a day";
  }
  if (minutes > 1500) {
    const days = minutes / 1440;
    const rendered =
      days >= 10 || Number.isInteger(days)
        ? String(Math.round(days))
        : days.toFixed(1);
    return `${rendered} days`;
  }
  if (minutes >= 60) {
    const hours = minutes / 60;
    const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `${rendered} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Reshapes a dated one-off into the store's lead-up form when the owner asked
 * to be nudged before the due time too. Reminder-plan step offsets must be
 * >= 0 and fire at `relevanceStartAt + offset`, so earliness is expressed by
 * widening the once cadence's `visibilityLeadMinutes` (relevance opens at
 * `dueAt - lead`) and anchoring the early step at offset 0 with the due-time
 * step at `lead`. A first attempt stored negative offsets and the service
 * rightly rejected them (#16941 live: every "bug me before friday too" plan
 * collapsed to a single due-time step).
 */
export function applyLeadUpReminderShape(args: {
  cadence: LifeOpsCadence;
  plan: NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]>;
  ownerText: string;
  title: string;
  milestones: string[];
  now?: number;
}): {
  cadence: LifeOpsCadence;
  plan: NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]>;
} {
  const unchanged = { cadence: args.cadence, plan: args.plan };
  if (args.cadence.kind !== "once") {
    return unchanged;
  }
  const dueAtMs = Date.parse(args.cadence.dueAt);
  if (!Number.isFinite(dueAtMs)) {
    return unchanged;
  }
  const now = args.now ?? Date.now();
  const runwayMinutes = Math.floor((dueAtMs - now) / 60_000);
  const hasMilestones = args.milestones.length >= 2 && runwayMinutes >= 120;
  const wantsLead =
    wantsEarlierReminderNudge(args.ownerText) && runwayMinutes >= 60;
  if (!hasMilestones && !wantsLead) {
    return unchanged;
  }
  // Already shaped (an explicit lead plus a multi-step ladder) — keep it.
  if (
    (args.cadence.visibilityLeadMinutes ?? 0) >= 60 &&
    args.plan.steps.length >= 2
  ) {
    return unchanged;
  }
  // 15-minute granularity keeps a same-turn planner re-call from minting a
  // slightly different lead and slipping past the content-duplicate guard.
  const quantize = (minutes: number): number => Math.round(minutes / 15) * 15;
  if (hasMilestones) {
    const count = args.milestones.length;
    const lead = Math.max(15, quantize((runwayMinutes * count) / (count + 1)));
    const steps = args.milestones.map((label, index) => ({
      channel: "in_app" as const,
      offsetMinutes: Math.min(
        lead,
        quantize((runwayMinutes * index) / (count + 1)),
      ),
      label,
    }));
    steps.push({
      channel: "in_app",
      offsetMinutes: lead,
      label: `Due: ${args.title}`,
    });
    return {
      cadence: { ...args.cadence, visibilityLeadMinutes: lead },
      plan: { ...args.plan, steps },
    };
  }
  const lead = Math.max(
    15,
    quantize(Math.min(1440, Math.floor(runwayMinutes / 2))),
  );
  return {
    cadence: { ...args.cadence, visibilityLeadMinutes: lead },
    plan: {
      ...args.plan,
      steps: [
        {
          channel: "in_app",
          offsetMinutes: 0,
          label: `Early start: ${args.title}`,
        },
        {
          channel: "in_app",
          offsetMinutes: lead,
          label: `${args.title} reminder`,
        },
      ],
    },
  };
}

/**
 * Minutes before the due instant a plan step fires, given the cadence lead:
 * a step at offset 0 fires at `dueAt - lead`, the step at offset = lead fires
 * at the due time. Non-positive results mean "at (or after) the due time".
 */
export function reminderStepMinutesBeforeDue(
  cadence: LifeOpsCadence,
  offsetMinutes: number,
): number {
  const lead =
    cadence.kind === "once" ? (cadence.visibilityLeadMinutes ?? 15) : 0;
  return lead - offsetMinutes;
}

/**
 * Pulls an enumerated milestone list ("outline, rough draft, and final
 * proofread") out of a multi-milestone create ask. Prefers the segment after
 * a colon, else after "for"; the list ends at the "and X" item or at the
 * first segment that reads like schedule prose rather than a milestone name.
 */
export function parseMilestoneListFromIntent(text: string): string[] {
  const match =
    text.match(/:\s*([^.!?\n]+)/) ?? text.match(/\bfor\b\s+([^.!?\n]+)/i);
  if (!match) {
    return [];
  }
  const items: string[] = [];
  for (const rawPart of match[1].split(/,\s*/)) {
    const isLast = /^and\s+/i.test(rawPart.trim());
    const part = rawPart
      .trim()
      .replace(/^and\s+/i, "")
      .trim();
    if (
      part.length === 0 ||
      part.length > 40 ||
      part.split(/\s+/).length > 5 ||
      /\b(?:due|deadline|ahead|before|by|remind|reminders?)\b/i.test(part)
    ) {
      break;
    }
    items.push(part);
    if (isLast) {
      break;
    }
  }
  return items.length >= 2 ? items : [];
}

function resolveMilestoneLabels(args: {
  details: Record<string, unknown> | undefined;
  intent: string;
  ownerText: string;
  multiStep: boolean;
}): string[] {
  // Planner-supplied steps are trusted directly; intent parsing only runs
  // when extraction itself judged the ask multi-milestone, so a plain
  // comma-separated errand list never becomes a staged plan.
  const fromDetails = (detailArray(args.details, "steps") ?? [])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  if (fromDetails.length >= 2) {
    return fromDetails;
  }
  if (!args.multiStep) {
    return [];
  }
  const fromIntent = parseMilestoneListFromIntent(args.intent);
  return fromIntent.length >= 2
    ? fromIntent
    : parseMilestoneListFromIntent(args.ownerText);
}

function scoreDefinitionTitleQuality(value: string | null | undefined): number {
  const normalized = normalizeTitle(value ?? "");
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = normalized.split(/\s+/).filter(Boolean).length;
  if (/\b\d+\b/.test(normalized)) {
    score += 6;
  }
  if (/[+&]/.test(value ?? "") || /\band\b/.test(normalized)) {
    score += 4;
  }
  if (
    /^(?:do|work out|workout|habit|routine|task|todo|reminder|alarm)\b/.test(
      normalized,
    )
  ) {
    score -= 5;
  }
  if (GENERIC_DERIVED_TITLE_RE.test(normalized)) {
    score -= 6;
  }
  return score;
}

function shouldAdoptPlannerTitle(args: {
  currentTitle: string | null | undefined;
  plannerTitle: string | null | undefined;
}): boolean {
  const plannerTitle = args.plannerTitle?.trim();
  if (!plannerTitle) {
    return false;
  }
  const currentTitle = args.currentTitle?.trim();
  if (!currentTitle) {
    return true;
  }
  if (normalizeTitle(currentTitle) === normalizeTitle(plannerTitle)) {
    return false;
  }
  return (
    scoreDefinitionTitleQuality(plannerTitle) >
    scoreDefinitionTitleQuality(currentTitle)
  );
}

function shouldAdoptPlannerCadence(args: {
  currentCadence: LifeOpsCadence | undefined;
  plannerCadence: LifeOpsCadence;
}): boolean {
  const { currentCadence, plannerCadence } = args;
  if (!currentCadence) {
    return true;
  }
  if (currentCadence.kind === "times_per_day") {
    return (
      (plannerCadence.kind === "times_per_day" &&
        plannerCadence.slots.length >= currentCadence.slots.length) ||
      (plannerCadence.kind === "once" && currentCadence.slots.length === 1)
    );
  }
  if (currentCadence.kind === "weekly") {
    return (
      plannerCadence.kind === "weekly" &&
      plannerCadence.weekdays.length >= currentCadence.weekdays.length &&
      (currentCadence.windows.includes("custom")
        ? plannerCadence.windows.includes("custom")
        : plannerCadence.windows.length >= currentCadence.windows.length)
    );
  }
  if (currentCadence.kind === "interval") {
    return plannerCadence.kind === "interval";
  }
  if (currentCadence.kind === "once") {
    return plannerCadence.kind === "once";
  }
  if (currentCadence.kind === "daily") {
    return (
      plannerCadence.kind === "times_per_day" ||
      (plannerCadence.kind === "daily" &&
        plannerCadence.windows.length >= currentCadence.windows.length)
    );
  }
  return true;
}

/** Explicit deferred-consent request: the owner asked to SEE it before it is
 * written ("preview it first", "do not save until I confirm", "don't save it
 * yet", "ask me before"). A user-requested preview outranks every
 * crisp-ask immediate-save exemption below. */
const LIFE_TEXT_REQUESTS_PREVIEW_RE = new RegExp(
  [
    // A direct preview request does not need the extra word "first".
    String.raw`(?:^|[.!?;]\s*)(?:please\s+)?preview\s+(?:one|a|an|the|this|that|it|my|our)\b`,
    String.raw`\bpreview\b[^.!?]{0,40}\bfirst`,
    String.raw`\b(?:do not|don['’]?t)\s+(?:save|add|create|write)\b[^.!?]{0,40}\b(?:until|unless|before)\b`,
    String.raw`\b(?:until|unless|before)\s+i\s+(?:confirm|approve|say so)`,
    // Plain no-save instructions are authority too, not only "not yet".
    // Keep the object scoped: "don't create other reminders" does not veto
    // the requested reminder, and quoted titles are not preview directives.
    String.raw`\b(?:don['’]?t|do not)\s+(?:save|add|create|write)(?:\s+(?:it|this|that|anything|any\s+records?))?\s*(?:yet\b|[.!?;]|$|or\s+(?:change|modify|edit|delete)\b)`,
    String.raw`\bask\s+(?:me\s+)?(?:first|before)`,
  ].join("|"),
  "i",
);

function shouldRequireLifeCreateConfirmation(args: {
  confirmed: boolean;
  messageSource: string | undefined;
  requestKind?: NativeAppleReminderLikeKind | null;
  cadence?: LifeOpsCadence;
  multiStep?: boolean;
  explicitUndated?: boolean;
  operationScopedUndated?: boolean;
  previewRequested?: boolean;
}): boolean {
  if (args.messageSource === "autonomy") {
    return false;
  }
  // An explicit "preview first / don't save until I confirm" in the owner's
  // own words defeats BOTH immediate-save exemptions below AND the extracted
  // `confirmed` flag itself: a future-consent clause means consent has NOT
  // been given on THIS turn, even when the extractor (mis)reads the sentence
  // as a confirmation. The follow-up turn's plain "yes, save it" carries no
  // such clause and confirms normally.
  if (args.previewRequested === true) {
    return true;
  }
  // Crisp single dated asks save immediately (#16935); a multi-milestone ask
  // ("reminders for outline, rough draft, and final proofread") collapses into
  // one definition whose derived breakdown the owner has not seen, so it keeps
  // the two-phase preview even when extraction resolved a once cadence
  // (#16941 live finding: the exemption over-triggered and wrote pre-consent).
  if (args.requestKind && args.cadence?.kind === "once" && !args.multiStep) {
    return false;
  }
  // #16935 symmetry for undated todos: when the owner's own words state both
  // halves — the item AND that it has no date ("add a todo: X, no deadline") —
  // a preview would ask them to confirm exactly what they just said. Scoped to
  // an EXPLICIT textual no-date statement (the same canonical authority that
  // guards the unscheduled-cadence wipe). Multi-step requests need a unique
  // authored Todo clause; model-only scope cannot bypass confirmation.
  if (
    args.cadence?.kind === "unscheduled" &&
    args.explicitUndated === true &&
    (!args.multiStep || args.operationScopedUndated === true)
  ) {
    return false;
  }
  return !args.confirmed;
}

function formatGoalExperienceLoopSummary(
  experienceLoop:
    | {
        summary?: string | null;
        similarGoals?: Array<{ title?: string }>;
        suggestedCarryForward?: Array<{ title?: string }>;
      }
    | null
    | undefined,
): string | null {
  if (!experienceLoop?.summary) {
    return null;
  }
  const similarGoalTitle = experienceLoop.similarGoals?.[0]?.title?.trim();
  const carryForwardTitle =
    experienceLoop.suggestedCarryForward?.[0]?.title?.trim();
  const parts = [experienceLoop.summary.trim()];
  if (similarGoalTitle) {
    parts.push(`Closest match: "${similarGoalTitle}".`);
  }
  if (carryForwardTitle) {
    parts.push(`Carry forward "${carryForwardTitle}" if it still fits.`);
  }
  return parts.join(" ");
}

function formatWeeklyGoalReview(args: {
  summary: {
    totalGoals: number;
    onTrackCount: number;
    atRiskCount: number;
    needsAttentionCount: number;
  };
  onTrack: Array<{ goal: { title: string } }>;
  atRisk: Array<{ goal: { title: string } }>;
  needsAttention: Array<{ goal: { title: string } }>;
}): string {
  const parts = [
    `Weekly goal review: ${args.summary.totalGoals} active ${args.summary.totalGoals === 1 ? "goal" : "goals"}, ${args.summary.onTrackCount} on track, ${args.summary.atRiskCount} at risk, ${args.summary.needsAttentionCount} needing attention.`,
  ];
  if (args.atRisk.length > 0) {
    parts.push(
      `Drifting: ${args.atRisk.map((review) => review.goal.title).join(", ")}.`,
    );
  }
  if (args.needsAttention.length > 0) {
    parts.push(
      `Needs attention: ${args.needsAttention
        .map((review) => review.goal.title)
        .join(", ")}.`,
    );
  }
  if (args.onTrack.length > 0) {
    parts.push(
      `On track: ${args.onTrack
        .map((review) => review.goal.title)
        .join(", ")}.`,
    );
  }
  return parts.join(" ");
}

// ── Main action ───────────────────────────────────────

// Owner-operation actions belong to the home chat (the non-page-scoped
// assistant surface). On any page-* scope the action set is scoped to that
// surface (page-automations → WORKFLOW, page-browser → browser actions, etc.).
// When owner-operation actions stay eligible on those scopes, their long
// descriptions contaminate the ACTION_PLANNER candidate list, driving the LLM
// to mimic the life-param-extractor structured schema and producing envelopes
// the planner cannot read.
async function isForeignPageScope(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  const room = await runtime.getRoom(message.roomId);
  const metadata = extractConversationMetadataFromRoom(room);
  return isPageScopedConversationMetadata(metadata);
}

// Metadata reused by the owner-* umbrella actions in owner-surfaces.ts.
// The old umbrella is no longer planner-visible — owner-surfaces publishes the
// individual reminder/alarm/goal/task-list/routine umbrellas that delegate into
// `runLifeOperationHandler` below.
export const OWNER_OPERATION_TAGS: string[] = [
  "domain:reminders",
  // "resource:tracked-work" + "capability:read" ground empty-tracked-state
  // replies at the planned-reply egress guard: a verified owner-surface review
  // that authored the exact reply ("nothing on the list") is real evidence,
  // not a fabricated recap, so the guard must not replace it with a canned
  // failure (core services/message.ts plannedReplyHasClaimGroundingReceipt).
  "resource:tracked-work",
  "capability:read",
  "capability:write",
  "capability:update",
  "capability:delete",
  "capability:schedule",
  "effect:receipt-required",
  "surface:internal",
];

const EMPTY_TRACKED_STATE_CLAIM_GROUNDING = ["empty_tracked_state"] as const;

function ownerOverviewIsEmpty(overview: {
  owner: { goals: unknown[]; occurrences: unknown[]; reminders: unknown[] };
}): boolean {
  return (
    overview.owner.goals.length === 0 &&
    overview.owner.occurrences.length === 0 &&
    overview.owner.reminders.length === 0
  );
}

// "productivity" is deliberate: Stage-1 routinely tags habit/reminder-shaped
// asks with the productivity context (a child of tasks). Retrieval uses
// selected contexts as a +0.3 weight, and the tier narrow only keeps parents
// that match a Stage-1 candidate name or score >= 0.97 — without this context
// the owner-life umbrellas lost the boost to SCHEDULED_TASKS (which declares
// productivity) and were never exposed for "brush my teeth at 8 am and 9 pm
// every day" (#10722 brush-teeth-basic live trajectory).
export const OWNER_OPERATION_CONTEXTS: AgentContext[] = [
  "general",
  "tasks",
  "goals",
  "todos",
  "productivity",
  "calendar",
  "health",
];

export const OWNER_OPERATION_ROLE_GATE = { minRole: "OWNER" } as const;
export const OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION = true;

export const OWNER_OPERATION_VALIDATE = async (
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> => {
  if (await isForeignPageScope(runtime, message)) {
    return false;
  }
  return true;
};

function ownerSurfaceActionNameFromOptions(
  options: HandlerOptions | undefined,
): string {
  const raw = (options as HandlerOptions | undefined)?.parameters as
    | LifeParams
    | undefined;
  return typeof raw?.ownerSurface === "string" && raw.ownerSurface.length > 0
    ? raw.ownerSurface
    : "OWNER_TODOS";
}

const OWNER_DEFINITION_SURFACES = [
  "OWNER_TODOS",
  "OWNER_REMINDERS",
  "OWNER_ALARMS",
  "OWNER_ROUTINES",
] as const;

type OwnerDefinitionSurface = (typeof OWNER_DEFINITION_SURFACES)[number];

function ownerDefinitionSurface(value: unknown): OwnerDefinitionSurface | null {
  return typeof value === "string" &&
    OWNER_DEFINITION_SURFACES.includes(value as OwnerDefinitionSurface)
    ? (value as OwnerDefinitionSurface)
    : null;
}

function definitionReviewSurface(
  record: LifeOpsDefinitionRecord,
): OwnerDefinitionSurface | null {
  const persisted = ownerDefinitionSurface(
    record.definition.metadata.ownerSurface,
  );
  if (persisted) return persisted;

  const nativeReminder = readNativeAppleReminderMetadata(
    record.definition.metadata,
  );
  if (nativeReminder?.kind === "alarm") return "OWNER_ALARMS";
  if (nativeReminder?.kind === "reminder") return "OWNER_REMINDERS";
  if (record.definition.kind === "task") return "OWNER_TODOS";
  if (
    record.definition.kind === "habit" ||
    record.definition.kind === "routine"
  ) {
    return "OWNER_ROUTINES";
  }
  return null;
}

function definitionReviewSurfaceLabel(surface: OwnerDefinitionSurface): string {
  switch (surface) {
    case "OWNER_TODOS":
      return "todos";
    case "OWNER_REMINDERS":
      return "reminders";
    case "OWNER_ALARMS":
      return "alarms";
    case "OWNER_ROUTINES":
      return "habits or routines";
  }
}

function lifeEffectRequestId(message: Memory): string {
  return message.id ?? `room:${message.roomId}`;
}

const lifeEffectObservedAtFallbacks = new WeakMap<object, string>();

function lifeEffectObservedAt(message: Memory): string {
  if (message.createdAt !== undefined) {
    return new Date(message.createdAt).toISOString();
  }
  const existing = lifeEffectObservedAtFallbacks.get(message);
  if (existing) {
    return existing;
  }
  // One planner turn can retry the same action. Legacy transports without a
  // message timestamp still need byte-identical receipts across those retries.
  const observedAt = new Date().toISOString();
  lifeEffectObservedAtFallbacks.set(message, observedAt);
  return observedAt;
}

function lifeEffectReceiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `OWNER_LIFE:${operation}:${lifeEffectRequestId(message)}:${resourceId}`;
}

function lifeEffectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lifeEffectString(value: unknown, field: string): string | null {
  const record = lifeEffectRecord(value);
  const candidate = record?.[field];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function lifeEffectPreview(
  message: Memory,
  operation: string,
  key: string | null = null,
): EffectReceipt {
  const id = key ?? lifeEffectRequestId(message);
  return normalizeEffectReceipt({
    receiptId: lifeEffectReceiptId(message, operation, id),
    operation,
    resource: {
      kind: "lifeops.owner_draft",
      id,
    },
    artifacts: [],
    idempotency: { key, replayed: false },
    observedAt: lifeEffectObservedAt(message),
    outcome: "preview",
  });
}

function lifeRequestedOperation(options: HandlerOptions | undefined): string {
  const params = lifeEffectRecord(options?.parameters);
  const raw =
    lifeEffectString(params, "subaction") ??
    lifeEffectString(params, "action") ??
    "resolve";
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

async function latestLifeAudit(args: {
  runtime: IAgentRuntime;
  ownerType: "definition" | "goal" | "occurrence";
  ownerId: string;
  eventTypes: readonly string[];
  auditId?: string;
}) {
  const service = new LifeOpsService(args.runtime);
  const audits = args.auditId
    ? [
        await service.repository.getAuditEvent(
          args.runtime.agentId,
          args.ownerType,
          args.ownerId,
          args.auditId,
        ),
      ]
    : await service.repository.listAuditEvents(
        args.runtime.agentId,
        args.ownerType,
        args.ownerId,
      );
  const audit = audits.find(
    (candidate) =>
      candidate !== null && args.eventTypes.includes(candidate.eventType),
  );
  if (!audit) {
    throw new ElizaError(
      `LifeOps ${args.ownerType} mutation committed without matching audit proof`,
      {
        code: "LIFEOPS_EFFECT_AUDIT_REQUIRED",
        context: {
          ownerId: args.ownerId,
          ownerType: args.ownerType,
          eventTypes: args.eventTypes,
        },
        severity: "fatal",
      },
    );
  }
  return audit;
}

function lifeFailureCode(result: ActionResult): string {
  const data = lifeEffectRecord(result.data);
  const values = lifeEffectRecord(result.values);
  return (
    lifeEffectString(data, "error") ??
    lifeEffectString(values, "error") ??
    (data?.missingField ? "LIFEOPS_MISSING_FIELD" : null) ??
    "LIFEOPS_OPERATION_REJECTED"
  );
}

async function lifeEffectReceiptForResult(args: {
  runtime: IAgentRuntime;
  message: Memory;
  options: HandlerOptions | undefined;
  result: ActionResult;
}): Promise<EffectReceipt> {
  const data = lifeEffectRecord(args.result.data);
  const operationHint = lifeRequestedOperation(args.options);
  const operation = `lifeops.owner.${operationHint}`;
  const requestId = lifeEffectRequestId(args.message);

  if (
    data?.deferred === true ||
    data?.saved === false ||
    data?.requiresConfirmation === true
  ) {
    const draft = lifeEffectRecord(data.lifeDraft);
    const draftRequest = lifeEffectRecord(draft?.request);
    if (
      draft?.operation === "create_definition" &&
      typeof draftRequest?.idempotencyKey === "string"
    ) {
      const service = new LifeOpsService(args.runtime, {
        ownerEntityId: args.message.entityId,
      });
      const parameters = lifeEffectRecord(args.options?.parameters);
      const details = lifeEffectRecord(parameters?.details);
      const ownership = service.normalizeOwnership(
        requestedOwnership(
          details?.domain === "agent_ops" ? "agent_ops" : undefined,
        ),
      );
      const key = definitionCreationIdentity({
        agentId: args.runtime.agentId,
        actorId: service.ownerEntityId(),
        ownership,
        key: draftRequest.idempotencyKey,
      });
      return lifeEffectPreview(
        args.message,
        DEFINITION_CREATION_OPERATION,
        key,
      );
    }
    return lifeEffectPreview(args.message, `${operation}.preview`);
  }

  if (args.result.success === false) {
    const failureCode = lifeFailureCode(args.result);
    return lifeOpsFailedEffect({
      receiptId: lifeEffectReceiptId(
        args.message,
        operation,
        `${requestId}:${failureCode}`,
      ),
      operation,
      resource: { kind: "runtime.message", id: requestId },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: lifeEffectObservedAt(args.message),
      failure: {
        code: failureCode,
        retryable: false,
        acceptance: "rejected",
      },
    });
  }

  const readOnlyOperation =
    operationHint === "review" ||
    operationHint === "overview" ||
    operationHint === "calendar" ||
    operationHint === "email" ||
    operationHint.startsWith("query_");
  if (
    (data?.noop === true || readOnlyOperation) &&
    lifeEffectRecord(data?.deleted) === null
  ) {
    const readGoal = lifeEffectRecord(data?.goal);
    const readGoalId = lifeEffectString(readGoal, "id");
    const resourceId = readGoalId ?? requestId;
    return lifeOpsNoopEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, resourceId),
      operation,
      resource: readGoalId
        ? {
            kind: "lifeops.goal",
            id: readGoalId,
            ...(lifeEffectString(readGoal, "updatedAt")
              ? { version: lifeEffectString(readGoal, "updatedAt") as string }
              : {}),
          }
        : { kind: "runtime.message", id: requestId },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: lifeEffectObservedAt(args.message),
      reason:
        "The operation only read, evaluated, clarified, or intentionally left state unchanged.",
    });
  }

  const deleted = lifeEffectRecord(data?.deleted);
  const deletedId = lifeEffectString(deleted, "id");
  const deletedType = lifeEffectString(deleted, "kind");
  if (deletedId && (deletedType === "definition" || deletedType === "goal")) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: deletedType,
      ownerId: deletedId,
      eventTypes:
        deletedType === "definition"
          ? ["definition_deleted"]
          : ["goal_deleted"],
    });
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, deletedId),
      operation:
        deletedType === "definition"
          ? "lifeops.definition.delete"
          : "lifeops.goal.delete",
      resource: {
        kind: `lifeops.${deletedType}`,
        id: deletedId,
        version: audit.id,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const definition =
    lifeEffectRecord(data?.definition) ??
    lifeEffectRecord(lifeEffectRecord(data?.updated)?.definition);
  const definitionId = lifeEffectString(definition, "id");
  const definitionUpdatedAt = lifeEffectString(definition, "updatedAt");
  const todoTransition = lifeEffectString(data, "todoTransition");
  if (
    definitionId &&
    definitionUpdatedAt &&
    (todoTransition === "complete" || todoTransition === "reopen")
  ) {
    const base = {
      receiptId: lifeEffectReceiptId(
        args.message,
        operation,
        `${definitionId}:${definitionUpdatedAt}`,
      ),
      operation: `lifeops.definition.${todoTransition}`,
      resource: {
        kind: "lifeops.definition",
        id: definitionId,
        version: definitionUpdatedAt,
      },
      artifacts: [],
      idempotency: {
        key: `${definitionId}:${definitionUpdatedAt}:${todoTransition}`,
        replayed: data?.replayed === true,
      },
      observedAt: definitionUpdatedAt,
    };
    if (data?.replayed === true)
      return lifeOpsNoopEffect({
        ...base,
        reason: "The todo already has the requested completion state.",
      });
    const transitionAuditId = lifeEffectString(data, "auditId");
    if (!transitionAuditId)
      throw new ElizaError(
        "The todo transition omitted its committed audit identity.",
        { code: "LIFEOPS_TODO_RECEIPT_MISMATCH", context: { definitionId } },
      );
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "definition",
      ownerId: definitionId,
      auditId: transitionAuditId,
      eventTypes: [
        todoTransition === "complete"
          ? "definition_completed"
          : "definition_reopened",
      ],
    });
    if (
      audit.id !== lifeEffectString(data, "auditId") ||
      audit.createdAt !== definitionUpdatedAt
    )
      throw new ElizaError(
        "The todo transition receipt could not be matched to its committed audit.",
        { code: "LIFEOPS_TODO_RECEIPT_MISMATCH", context: { definitionId } },
      );
    return lifeOpsAppliedEffect({
      ...base,
      commit: { kind: "durable", id: audit.id, committedAt: audit.createdAt },
    });
  }
  const definitionIdempotency = lifeEffectRecord(data?.idempotency);
  const definitionOperationKey = lifeEffectString(definitionIdempotency, "key");
  if (
    definitionId &&
    (data?.deduplicated === true || definitionIdempotency?.replayed === true)
  ) {
    return lifeOpsNoopEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, definitionId),
      operation: DEFINITION_CREATION_OPERATION,
      resource: {
        kind: "lifeops.definition",
        id: definitionId,
        ...(definitionUpdatedAt ? { version: definitionUpdatedAt } : {}),
      },
      artifacts: [],
      idempotency: {
        key: definitionOperationKey ?? definitionId,
        replayed: true,
      },
      observedAt: new Date().toISOString(),
      reason: definitionOperationKey
        ? "This creation operation already completed."
        : "An equivalent active definition already exists.",
    });
  }
  if (definitionId && definitionUpdatedAt) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "definition",
      ownerId: definitionId,
      eventTypes: ["definition_updated", "definition_created"],
    });
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, definitionId),
      operation:
        audit.eventType === "definition_created"
          ? DEFINITION_CREATION_OPERATION
          : "lifeops.definition.update",
      resource: {
        kind: "lifeops.definition",
        id: definitionId,
        version: definitionUpdatedAt,
      },
      artifacts: [],
      idempotency:
        audit.eventType === "definition_created"
          ? { key: definitionOperationKey ?? definitionId, replayed: false }
          : { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const goal = lifeEffectRecord(data?.goal);
  const goalId = lifeEffectString(goal, "id");
  const goalUpdatedAt = lifeEffectString(goal, "updatedAt");
  if (goalId && data?.deduplicated === true) {
    return lifeOpsNoopEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, goalId),
      operation: "lifeops.goal.create",
      resource: {
        kind: "lifeops.goal",
        id: goalId,
        ...(goalUpdatedAt ? { version: goalUpdatedAt } : {}),
      },
      artifacts: [],
      idempotency: { key: goalId, replayed: true },
      observedAt: new Date().toISOString(),
      reason: "An equivalent active goal already exists.",
    });
  }
  if (goalId && goalUpdatedAt) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "goal",
      ownerId: goalId,
      eventTypes: ["goal_updated", "goal_created"],
    });
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, goalId),
      operation:
        audit.eventType === "goal_created"
          ? "lifeops.goal.create"
          : "lifeops.goal.update",
      resource: {
        kind: "lifeops.goal",
        id: goalId,
        version: goalUpdatedAt,
      },
      artifacts: [],
      idempotency:
        audit.eventType === "goal_created"
          ? { key: goalId, replayed: false }
          : { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const occurrenceId = lifeEffectString(data, "id");
  const occurrenceUpdatedAt = lifeEffectString(data, "updatedAt");
  const occurrenceState = lifeEffectString(data, "state");
  const definitionIdForOccurrence = lifeEffectString(data, "definitionId");
  if (
    occurrenceId &&
    occurrenceUpdatedAt &&
    occurrenceState &&
    definitionIdForOccurrence
  ) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "occurrence",
      ownerId: occurrenceId,
      eventTypes: [
        "occurrence_completed",
        "occurrence_skipped",
        "occurrence_snoozed",
      ],
    });
    const replayed = data?.effectReplayed === true;
    if (replayed) {
      return lifeOpsNoopEffect({
        receiptId: lifeEffectReceiptId(args.message, operation, occurrenceId),
        operation: `lifeops.occurrence.${occurrenceState}`,
        resource: {
          kind: "lifeops.occurrence",
          id: occurrenceId,
          version: occurrenceUpdatedAt,
        },
        artifacts: [
          {
            kind: "lifeops.definition",
            id: definitionIdForOccurrence,
          },
        ],
        idempotency: { key: occurrenceId, replayed: true },
        observedAt: new Date().toISOString(),
        reason: `The occurrence was already ${occurrenceState}.`,
      });
    }
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, occurrenceId),
      operation: `lifeops.occurrence.${occurrenceState}`,
      resource: {
        kind: "lifeops.occurrence",
        id: occurrenceId,
        version: occurrenceUpdatedAt,
      },
      artifacts: [
        {
          kind: "lifeops.definition",
          id: definitionIdForOccurrence,
        },
      ],
      idempotency:
        occurrenceState === "completed" || occurrenceState === "skipped"
          ? { key: occurrenceId, replayed: false }
          : { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const preference = lifeEffectRecord(data?.preference);
  const effectivePreference = lifeEffectRecord(preference?.effective);
  const preferenceUpdatedAt = lifeEffectString(
    effectivePreference,
    "updatedAt",
  );
  if (preference && preferenceUpdatedAt) {
    const preferenceDefinitionId = lifeEffectString(preference, "definitionId");
    const resourceId = preferenceDefinitionId ?? "global";
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, resourceId),
      operation: "lifeops.reminder_policy.update",
      resource: {
        kind: "lifeops.reminder_policy",
        id: resourceId,
        version: preferenceUpdatedAt,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: preferenceUpdatedAt,
      commit: {
        kind: "durable",
        id: `lifeops.reminder_policy:${resourceId}:${preferenceUpdatedAt}`,
        committedAt: preferenceUpdatedAt,
      },
    });
  }

  const facts = lifeEffectRecord(data?.facts);
  const escalationRules = lifeEffectRecord(facts?.escalationRules);
  const escalationProvenance = lifeEffectRecord(escalationRules?.provenance);
  const escalationUpdatedAt = lifeEffectString(
    escalationProvenance,
    "recordedAt",
  );
  if (escalationUpdatedAt) {
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, "global"),
      operation: "lifeops.escalation_policy.update",
      resource: {
        kind: "lifeops.escalation_policy",
        id: "global",
        version: escalationUpdatedAt,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: escalationUpdatedAt,
      commit: {
        kind: "durable",
        id: `lifeops.escalation_policy:global:${escalationUpdatedAt}`,
        committedAt: escalationUpdatedAt,
      },
    });
  }

  return lifeOpsNoopEffect({
    receiptId: lifeEffectReceiptId(args.message, operation, requestId),
    operation,
    resource: { kind: "runtime.message", id: requestId },
    artifacts: [],
    idempotency: {
      key:
        data?.deduplicated === true
          ? (lifeEffectString(data, "id") ?? requestId)
          : null,
      replayed: data?.deduplicated === true,
    },
    observedAt: lifeEffectObservedAt(args.message),
    reason:
      data?.deduplicated === true
        ? "The requested resource already exists."
        : "The operation only read, evaluated, clarified, or intentionally left state unchanged.",
  });
}

async function runLifeOperationHandlerInner(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<PendingLifeActionResult> {
  const ownerSurfaceActionName = ownerSurfaceActionNameFromOptions(options);
  // Defense-in-depth: validate() excludes owner-operation candidates on
  // foreign page-* scopes, and this handler keeps direct tool execution a
  // no-op if a stale or malformed plan still reaches it.
  if (await isForeignPageScope(runtime, message)) {
    return {
      success: false,
      text: "Owner life actions are unavailable from this page.",
      data: {
        actionName: ownerSurfaceActionName,
        reason: "foreign_page_scope",
      },
    };
  }

  const rawParams = (options as HandlerOptions | undefined)?.parameters as
    | LifeParams
    | undefined;
  const params = rawParams ?? ({} as LifeParams);
  const authoredText = extractPrimaryLifeInputText(messageText(message));
  const currentText = normalizeLifeInputText(authoredText);
  const details = params.details;
  const stateDeferredDraft = latestDeferredLifeDraft(state);
  const cachedDeferredDraftState = await readDeferredLifeDraftCacheState(
    runtime,
    message,
  );
  const cachedDeferredDraft =
    cachedDeferredDraftState.kind === "draft"
      ? cachedDeferredDraftState.draft
      : null;
  const deferredDraft = stateDeferredDraft ?? cachedDeferredDraft;
  const deferredDraftIsInvalidated =
    deferredDraft === null &&
    (latestDeferredLifeDraftIsInvalidated(state) ||
      cachedDeferredDraftState.kind === "invalidated");
  const explicitCreateConfirmation =
    isExplicitLifeCreateConfirmation(currentText);
  const currentMessageId =
    message.id !== undefined && message.id !== null ? String(message.id) : "";
  const draftSourceMessageId = deferredDraft?.sourceMessageId?.trim() ?? "";
  const draftIsFromPriorTurn =
    currentMessageId.length > 0 &&
    draftSourceMessageId.length > 0 &&
    draftSourceMessageId !== currentMessageId;
  const turnsSinceDraft =
    deferredDraft != null
      ? (countTurnsSinceLatestDeferredLifeDraft(state) ?? 0) + 1
      : undefined;
  // A bare yes skips the classifier; a yes that CARRIES content ("yes, save
  // that plan. draft first, citations after dinner…") must still be
  // classified, because confirm-mode reuses the parked draft verbatim and
  // would drop the newly named specifics (#16941 live, night-owl: the saved
  // plan kept the draft's slots and lost the after-dinner citations session).
  // The classifier abstaining never cancels an explicit yes, though — that
  // falls back to confirm instead of dropping consent.
  const deferredDraftFollowupMode = deferredDraft
    ? explicitCreateConfirmation &&
      isBareLifeCreateConfirmationMessage(currentText)
      ? "confirm"
      : ((await extractDeferredLifeDraftFollowupWithLlm({
          runtime,
          message,
          state,
          currentText,
          draft: deferredDraft,
        })) ?? (explicitCreateConfirmation ? "confirm" : null))
    : null;
  const draftExpiryReason = deferredLifeDraftExpiryReason({
    draft: deferredDraft,
    turnsSinceDraft,
  });
  if (draftExpiryReason && deferredDraftFollowupMode === "confirm") {
    await invalidateDeferredLifeDraftCache(runtime, message);
    const fallback =
      "That LifeOps draft expired. Please restate it and I'll preview it again.";
    return {
      success: false,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: currentText,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "draft_expired",
        },
      }),
      values: {
        success: false,
        error: "DRAFT_EXPIRED",
        awaitingUserInput: true,
      },
      data: {
        actionName: ownerSurfaceActionName,
        reason: "draft_expired",
        lifeDraftInvalidated: true,
        awaitingUserInput: true,
      },
    };
  }
  if (deferredDraftFollowupMode === "cancel") {
    await invalidateDeferredLifeDraftCache(runtime, message);
    const fallback = "Okay, I won't save it yet.";
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: currentText,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "draft_cancelled",
          draft: deferredDraft
            ? {
                operation: deferredDraft.operation,
                title: deferredDraft.request.title,
              }
            : null,
        },
      }),
      data: {
        actionName: ownerSurfaceActionName,
        noop: true,
      },
    };
  }
  const explicitAction = normalizeExplicitLifeAction(params.action);
  // Retraction of an un-previewed save: the crisp-ask fast path persists with
  // no draft to cancel, and the planner cannot be trusted to translate
  // "actually don't save that one" into action=delete — observed live
  // (#16941, child-cancel-reask) it reviewed the row, replied "I won't save
  // it", and left the definition active. This runs before extraction so no
  // classifier verdict can strand the stale row; a same-message create
  // (retract + replace in one utterance) still runs after the deletion.
  if (deferredDraft === null && isLifeSaveRetraction(messageText(message))) {
    const recentSave = await readRecentLifeSaveCache(runtime, message);
    const retractionMessageId =
      message.id !== undefined && message.id !== null ? String(message.id) : "";
    if (
      recentSave !== null &&
      (recentSave.sourceMessageId === undefined ||
        recentSave.sourceMessageId !== retractionMessageId)
    ) {
      const retractionService = new LifeOpsService(runtime, {
        ownerEntityId: message.entityId,
      });
      const retracted = (await retractionService.listDefinitions()).find(
        (record) =>
          record.definition.id === recentSave.definitionId &&
          record.definition.status === "active",
      );
      await clearRecentLifeSaveCache(runtime, message);
      if (retracted) {
        await retractionService.deleteDefinition(retracted.definition.id);
        logger.info(
          `[LifeAction] retracted recent un-previewed save "${retracted.definition.title}" (${retracted.definition.id})`,
        );
        const plannerRequestedCreate =
          explicitAction !== null &&
          explicitAction !== "phone" &&
          explicitAction.operation === "create";
        if (!plannerRequestedCreate) {
          const fallback = `Okay — I removed "${retracted.definition.title}". Nothing is saved for it now.`;
          const text = await renderLifeActionReply({
            runtime,
            message,
            state,
            intent: currentText,
            scenario: "deleted_definition",
            fallback,
            context: {
              deleted: { title: retracted.definition.title },
              reason: "retracted_recent_save",
            },
          });
          return {
            success: true,
            text,
            userFacingText: text,
            verifiedUserFacing: true,
            data: {
              actionName: ownerSurfaceActionName,
              retractedRecentSave: true,
              deleted: {
                kind: "definition",
                id: retracted.definition.id,
                title: retracted.definition.title,
              },
            },
          };
        }
      }
    }
  }
  if (explicitAction === "phone") {
    return {
      success: false,
      text: "I need the phone number before I can save text reminders.",
      data: {
        actionName: ownerSurfaceActionName,
        missingField: "phone_number",
      },
    };
  }
  const explicitSubaction =
    typeof params.subaction === "string" &&
    Object.hasOwn(SUBACTIONS, params.subaction)
      ? (params.subaction as LifeOwnedOperation)
      : explicitAction?.operation;
  const deferredDraftReuseMode = resolveDeferredLifeDraftReuseMode({
    details,
    draft: deferredDraft,
    draftIsFromPriorTurn,
    explicitConfirmation: explicitCreateConfirmation,
    explicitOperation: explicitSubaction,
    llmMode: deferredDraftFollowupMode,
    turnsSinceDraft,
  });
  const reuseDeferredDraft = deferredDraftReuseMode !== null;
  const intent = reuseDeferredDraft
    ? deferredDraftReuseMode === "confirm"
      ? normalizeLifeInputText(deferredDraft?.intent ?? "")
      : normalizeLifeInputText(params.intent?.trim() ?? currentText)
    : normalizeLifeInputText(params.intent?.trim() ?? currentText);
  if (!intent) {
    const fallback = "Tell me what you want me to do.";
    return {
      success: false,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: currentText,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "missing_intent",
        },
      }),
    };
  }

  // Pre-routing: pick the subaction. When reusing a deferred draft we
  // inherit its operation. When the planner supplied an explicit subaction
  // we trust it. Otherwise dispatch through resolveActionArgs (the
  // shared LLM pre-routing substrate). The text extractor
  // stays available as a fallback for richer "missing field" diagnostics.
  const operationPlan: ResolvedLifeOperationPlan =
    reuseDeferredDraft && deferredDraft
      ? {
          confidence: 1,
          missing: [] as ExtractedLifeMissingField[],
          operation: "create",
          kind:
            deferredDraft.operation === "create_goal" ? "goal" : "definition",
          shouldAct: true,
        }
      : explicitAction
        ? {
            confidence: 1,
            missing: [],
            operation: explicitAction.operation,
            kind: explicitAction.kind,
            shouldAct: true,
          }
        : await routeLifeSubaction({
            runtime,
            message,
            state,
            options,
            intent,
            explicitSubaction,
          });
  const explicitKind: LifeKind | undefined =
    params.kind === "definition" || params.kind === "goal"
      ? params.kind
      : undefined;
  const forceGoalKind =
    looksLikeGoalTrackingFollowup(currentText) ||
    looksLikeGoalTrackingFollowup(intent);
  const resolvedKind: LifeKind | undefined = forceGoalKind
    ? "goal"
    : (operationPlan.kind ?? explicitKind);
  const forceCreateExecution = shouldForceLifeCreateExecution({
    intent,
    missing: operationPlan.missing,
    operation: operationPlan.operation,
    kind: resolvedKind,
    details,
    title: params.title,
  });
  if (!operationPlan.shouldAct && !forceCreateExecution) {
    const fallback = buildLifeClarificationFallback({
      missing: operationPlan.missing,
      operation: operationPlan.operation,
      kind: resolvedKind,
    });
    const text = await renderLifeActionReply({
      runtime,
      message,
      state,
      intent,
      scenario:
        operationPlan.operation === "create" && resolvedKind === "goal"
          ? "clarify_create_goal"
          : "clarify_create_definition",
      fallback,
      context: {
        missing: operationPlan.missing,
        operation: operationPlan.operation,
      },
    });
    return {
      success: true,
      text,
      userFacingText: text,
      values: {
        success: true,
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: operationPlan.operation,
      },
      data: {
        actionName: ownerSurfaceActionName,
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: operationPlan.operation,
      },
    };
  }
  const operation: LifeOwnedOperation | null = forceCreateExecution
    ? "create"
    : isLifeOwnedOperation(operationPlan.operation)
      ? operationPlan.operation
      : null;
  const queryOperation = forceCreateExecution
    ? null
    : !isLifeOwnedOperation(operationPlan.operation)
      ? operationPlan.operation
      : null;
  const service = new LifeOpsService(runtime, {
    ownerEntityId: message.entityId,
  });
  if (
    queryOperation === "query_calendar_today" ||
    queryOperation === "query_calendar_next" ||
    queryOperation === "query_email"
  ) {
    // Read-only connected-account queries: gate on the real Google capability
    // snapshot (lifeops/access.ts) and serve them; refuse only when calendar
    // or Gmail access is actually missing.
    return runLifeConnectedQuery({
      runtime,
      message,
      state,
      intent,
      service,
      queryOperation,
      actionName: ownerSurfaceActionName,
    });
  }
  if (queryOperation === "query_overview") {
    const overview = await service.getOverview();
    const userQuery = messageText(message) || intent || "overview";
    const fallback = formatOverviewForQuery(overview, userQuery);
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: userQuery,
        scenario: "overview",
        fallback,
        context: {
          summary: overview.owner.summary,
          occurrenceTitles: overview.owner.occurrences.map(
            (occurrence) => occurrence.title,
          ),
          goalTitles: overview.owner.goals.map((goal) => goal.title),
        },
      }),
      data: toActionData({
        ...overview,
        actionName: ownerSurfaceActionName,
        ...(ownerOverviewIsEmpty(overview)
          ? { claimGrounding: EMPTY_TRACKED_STATE_CLAIM_GROUNDING }
          : {}),
      }),
    };
  }
  // Internal handler dispatch key (definition vs goal split lives here).
  // For create/update/delete, infer kind from explicit param, plan, draft, or
  // intent; for occurrence-level verbs the kind is irrelevant.
  const kind: LifeKind =
    resolvedKind ??
    (operation === "create" || operation === "update" || operation === "delete"
      ? inferLifeKindFromIntent(intent)
      : "definition");
  const internalOp: InternalLifeOp | null = operation
    ? toInternalLifeOp(operation, kind)
    : null;
  if (!operation) {
    const fallback = "Tell me what LifeOps action you want me to take.";
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "missing_operation_after_extraction",
        },
      }),
      data: {
        actionName: ownerSurfaceActionName,
        noop: true,
      },
    };
  }
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
  const ownership = requestedOwnership(domain);
  // Params extracted by the routing pass (resolveActionArgs) fill gaps the
  // planner left open — snooze minutes/preset and the target especially.
  const routedParams = operationPlan.params;
  const targetName = [
    params.target,
    params.title,
    routedParams?.target,
    routedParams?.title,
  ].find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
  // Consent must come from the owner's current text. A pending draft proves
  // only that a preview exists; neither a planner `confirmed:true` field nor a
  // Stage-1 applied-effect claim can authorize the consequential write.
  const createConfirmed =
    deferredDraftReuseMode === "confirm" || explicitCreateConfirmation;

  try {
    const createDefinition = async () => {
      const deferredDefinitionDraft =
        reuseDeferredDraft && deferredDraft?.operation === "create_definition"
          ? deferredDraft
          : null;
      const editingDeferredDefinitionDraft =
        deferredDraftReuseMode === "edit" &&
        deferredDefinitionDraft?.operation === "create_definition";
      const explicitCadenceDetail = normalizeCadenceDetail(
        detailObject(details, "cadence"),
      );
      const hasCompleteNativeDefinitionCreatePlan = Boolean(
        params.title && explicitCadenceDetail && detailString(details, "kind"),
      );
      const nativeCreatePlan = parseNativeTaskCreatePlan(params.createPlan);
      const fallbackTitle = deferredDefinitionDraft?.request.title ?? null;
      let title: string | null = editingDeferredDefinitionDraft
        ? (params.title ?? fallbackTitle)
        : (fallbackTitle ?? params.title ?? null);
      const fallbackCadence = deferredDefinitionDraft?.request.cadence;
      let cadence: LifeOpsCadence | undefined = editingDeferredDefinitionDraft
        ? (explicitCadenceDetail ?? fallbackCadence ?? undefined)
        : (fallbackCadence ?? explicitCadenceDetail ?? undefined);
      let windowPolicy:
        | CreateLifeOpsDefinitionRequest["windowPolicy"]
        | undefined = editingDeferredDefinitionDraft
        ? // detailObject returns Record<string,unknown>; cast to the policy
          // type at this validated boundary.
          ((detailObject(details, "windowPolicy") as
            | CreateLifeOpsDefinitionRequest["windowPolicy"]
            | undefined) ?? deferredDefinitionDraft.request.windowPolicy)
        : (deferredDefinitionDraft?.request.windowPolicy ??
          (detailObject(details, "windowPolicy") as
            | CreateLifeOpsDefinitionRequest["windowPolicy"]
            | undefined));
      const explicitPriority = detailNumber(details, "priority");
      const explicitDescription = detailString(details, "description");
      const explicitMetadata = detailObject(details, "metadata") as
        | Record<string, unknown>
        | undefined;
      const rejectsStaleInvalidatedDraftConfirmation =
        deferredDraftIsInvalidated &&
        explicitCreateConfirmation &&
        !textStatesExplicitUndatedTodo(currentText) &&
        !textStatesExplicitSchedule(currentText);
      if (rejectsStaleInvalidatedDraftConfirmation) {
        await invalidateDeferredLifeDraftCache(runtime, message);
        const text =
          "That draft is no longer active. Restate what you want saved, including its timing or that it has no due date.";
        return {
          success: false as const,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          values: {
            success: false,
            error: "MISSING_DEFINITION_FIELD",
            missingField: "schedule",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            lifeDraftInvalidated: true,
            missingField: "schedule",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
        };
      }

      // Owner's stored timezone fact (travel-aware), used as the fallback zone
      // for a conversational create when no zone was stated out loud and no
      // more-specific candidate (explicit detail / planner / deferred draft /
      // window policy) is present. Without this, "remind me tomorrow at 9am"
      // resolves 9am against the HOST clock (`resolveDefaultTimeZone()` = UTC
      // on shared-server / TZ=UTC topologies) instead of the owner's wall
      // clock (#13509). Read once here; the store call falls back to the host
      // zone itself when no owner fact is stored, so `ownerFactTimeZone` is
      // always a concrete zone (never fabricated).
      const ownerFactTimeZone = await resolveOwnerTimeZone(runtime, new Date());

      // Track whether cadence/title came from explicit high-confidence
      // sources so the planner only fills genuine gaps.
      const hadExplicitCadence = Boolean(
        (editingDeferredDefinitionDraft
          ? (explicitCadenceDetail ?? deferredDefinitionDraft.request.cadence)
          : deferredDefinitionDraft?.request.cadence) ?? explicitCadenceDetail,
      );
      const hadExplicitTitle = Boolean(
        (editingDeferredDefinitionDraft
          ? params.title
          : deferredDefinitionDraft?.request.title) ?? params.title,
      );

      // Parameter enhancement fills gaps when structured planner input is partial.
      // Skip when options.parameters already contain the complete
      // definition-create shape, or when reusing a confirmed deferred draft.
      let llmPlan: Awaited<
        ReturnType<typeof extractTaskCreatePlanWithLlm>
      > | null = null;
      let llmDescription: string | undefined;
      let llmPriority: number | undefined;
      let llmRequestKind: NativeAppleReminderLikeKind | null = null;
      if (
        (!deferredDefinitionDraft || editingDeferredDefinitionDraft) &&
        (nativeCreatePlan || !hasCompleteNativeDefinitionCreatePlan)
      ) {
        try {
          llmPlan =
            nativeCreatePlan ??
            (await extractTaskCreatePlanWithLlm({
              runtime,
              intent,
              state: state ?? undefined,
              message: message,
              timeZone:
                normalizeLifeTimeZoneToken(
                  detailString(details, "timeZone") ??
                    deferredDefinitionDraft?.request.timezone ??
                    windowPolicy?.timezone,
                ) ?? undefined,
            }));
        } catch (error) {
          // error-policy:J4 Explicit create parameters remain usable without a
          // model; missing fields fall through to the visible clarifications.
          if (!(error instanceof NoModelProviderConfiguredError)) {
            throw error;
          }
        }
        const plannerResponse =
          llmPlan?.mode === "respond" ? llmPlan.response : undefined;
        const shouldHonorPlannerResponse =
          Boolean(plannerResponse) &&
          !editingDeferredDefinitionDraft &&
          !params.title &&
          !explicitCadenceDetail &&
          !detailString(details, "description") &&
          !detailString(details, "goalId") &&
          !detailString(details, "goalTitle") &&
          !detailString(details, "kind");
        if (shouldHonorPlannerResponse && plannerResponse) {
          const text = plannerResponse;
          return {
            success: true as const,
            text,
            userFacingText: text,
            values: {
              success: true,
              noop: true,
              awaitingUserInput: true,
              suggestedOperation: "create",
            },
            data: {
              actionName: ownerSurfaceActionName,
              noop: true,
              awaitingUserInput: true,
              suggestedOperation: "create",
            },
          };
        }
        if (llmPlan) {
          llmRequestKind = llmPlan.requestKind;
          if (
            !hadExplicitTitle &&
            shouldAdoptPlannerTitle({
              currentTitle: title,
              plannerTitle: llmPlan.title,
            })
          ) {
            title = llmPlan.title;
          }
          if (
            (editingDeferredDefinitionDraft || !hadExplicitCadence) &&
            llmPlan.cadenceKind
          ) {
            const llmCadenceTimeZone =
              normalizeLifeTimeZoneToken(
                detailString(details, "timeZone") ??
                  llmPlan.timeZone ??
                  deferredDefinitionDraft?.request.timezone ??
                  windowPolicy?.timezone,
              ) ?? ownerFactTimeZone;
            const llmCadence = buildCadenceFromLlmParams(llmPlan, {
              allowUnscheduled: ownerSurfaceActionName === "OWNER_TODOS",
              intent,
              timeZone: llmCadenceTimeZone ?? undefined,
            });
            if (
              llmCadence &&
              shouldAdoptPlannerCadence({
                currentCadence: cadence,
                plannerCadence: llmCadence.cadence,
              })
            ) {
              cadence = llmCadence.cadence;
              windowPolicy = llmCadence.windowPolicy ?? windowPolicy;
            }
          }
          if (!explicitDescription && llmPlan.description) {
            llmDescription = llmPlan.description;
          }
          if (explicitPriority === undefined && llmPlan.priority) {
            llmPriority = llmPlan.priority;
          }
        }
      }
      const resolvedTimeZone =
        normalizeLifeTimeZoneToken(
          detailString(details, "timeZone") ??
            llmPlan?.timeZone ??
            deferredDefinitionDraft?.request.timezone ??
            windowPolicy?.timezone,
        ) ?? ownerFactTimeZone;
      const ownerDefinitionAction = ownerDefinitionSurface(
        ownerSurfaceActionName,
      );
      if (
        ownerDefinitionAction !== null &&
        ownerDefinitionAction !== "OWNER_TODOS" &&
        textExplicitlyLeavesScheduleUnspecified(currentText)
      ) {
        cadence = undefined;
        if (editingDeferredDefinitionDraft) {
          await invalidateDeferredLifeDraftCache(runtime, message);
        }
      }
      const undatedAuthority = resolveUndatedTodoAuthority(authoredText, title);
      // A uniquely authored no-date directive supplies the cadence even when
      // the planner omits it; timing on another operation cannot fill this slot.
      if (
        ownerSurfaceActionName === "OWNER_TODOS" &&
        !editingDeferredDefinitionDraft &&
        cadence === undefined &&
        undatedAuthority.operationScoped &&
        undatedAuthority.explicit
      ) {
        cadence = { kind: "unscheduled" };
      }
      const confirmsValidatedUndatedDraft =
        deferredDraftReuseMode === "confirm" &&
        deferredDefinitionDraft?.request.cadence?.kind === "unscheduled";
      if (
        (editingDeferredDefinitionDraft &&
          deferredDefinitionDraft.request.cadence?.kind === "unscheduled" &&
          undatedAuthority.contradicts) ||
        (cadence?.kind === "unscheduled" &&
          (ownerSurfaceActionName !== "OWNER_TODOS" ||
            (!confirmsValidatedUndatedDraft && !undatedAuthority.explicit)))
      ) {
        cadence = undefined;
        if (editingDeferredDefinitionDraft) {
          await invalidateDeferredLifeDraftCache(runtime, message);
        }
      }
      const timedRequestKind = llmRequestKind;
      const nativeAppleMetadata =
        timedRequestKind && cadence?.kind === "once"
          ? buildNativeAppleReminderMetadata({
              kind: timedRequestKind,
              source: "llm",
            })
          : undefined;
      const surfaceMetadata = ownerDefinitionSurface(ownerSurfaceActionName)
        ? { ownerSurface: ownerSurfaceActionName }
        : undefined;
      const definitionMetadata = editingDeferredDefinitionDraft
        ? mergeMetadataRecords(
            deferredDefinitionDraft.request.metadata,
            explicitMetadata,
            nativeAppleMetadata,
            surfaceMetadata,
          )
        : mergeMetadataRecords(
            deferredDefinitionDraft?.request.metadata,
            explicitMetadata,
            nativeAppleMetadata,
            surfaceMetadata,
          );

      if (!title) {
        const fallback = "What should I call it?";
        const text = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "clarify_create_definition",
          fallback,
          context: {
            missing: ["title"],
            operation: "create_definition",
          },
        });
        return {
          success: false as const,
          text,
          userFacingText: text,
          // Asking the owner to fill in a missing field — selection +
          // execution were both correct, terminal state is "needs human
          // input". Flag so the native planner chain breaks and the spy
          // scores this as completed.
          values: {
            success: false,
            error: "MISSING_DEFINITION_FIELD",
            missingField: "title",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            missingField: "title",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
        };
      }
      if (!cadence) {
        const fallback = "When should it happen?";
        const text = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "clarify_create_definition",
          fallback,
          context: {
            missing: ["schedule"],
            operation: "create_definition",
          },
        });
        // Park the answered-so-far request so the owner's next turn (a date,
        // or an explicit date-decline) can resume THIS create instead of
        // starting over. Without the parked draft the decline answer had
        // nothing to resume and persisted nothing (live matrix F32). Scoped
        // to OWNER_TODOS: only the todos surface accepts the unscheduled
        // cadence, so only its clarify is answerable by a decline. Never park
        // on the contradicted-edit path — that branch just INVALIDATED the
        // prior draft, and writing a fresh one here would clobber the
        // invalidation and let a later bare confirmation resurrect the
        // create the contradiction rejected.
        const scheduleAwaitingDraft: DeferredLifeDraft | null =
          !editingDeferredDefinitionDraft &&
          ownerSurfaceActionName === "OWNER_TODOS" &&
          title
            ? {
                awaitingField: "schedule",
                createdAt: Date.now(),
                intent,
                operation: "create_definition",
                sourceMessageId:
                  typeof message.id === "string" ? message.id : undefined,
                request: {
                  idempotencyKey:
                    params.idempotencyKey !== undefined
                      ? params.idempotencyKey
                      : deferredDefinitionDraft?.request.idempotencyKey,
                  kind: "task",
                  metadata: definitionMetadata,
                  title,
                },
              }
            : null;
        if (scheduleAwaitingDraft) {
          await writeDeferredLifeDraftCache(
            runtime,
            message,
            scheduleAwaitingDraft,
          );
        }
        return {
          success: false as const,
          text,
          userFacingText: text,
          values: {
            success: false,
            error: "MISSING_DEFINITION_FIELD",
            missingField: "schedule",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            ...(editingDeferredDefinitionDraft
              ? { lifeDraftInvalidated: true }
              : {}),
            ...(scheduleAwaitingDraft
              ? { lifeDraft: scheduleAwaitingDraft }
              : {}),
            missingField: "schedule",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
        };
      }
      const kind =
        (editingDeferredDefinitionDraft
          ? (detailString(details, "kind") as
              | CreateLifeOpsDefinitionRequest["kind"]
              | undefined)
          : deferredDefinitionDraft?.request.kind) ??
        (detailString(details, "kind") as
          | CreateLifeOpsDefinitionRequest["kind"]
          | undefined) ??
        (ownerSurfaceActionName === "OWNER_TODOS" ? "task" : "habit");
      const leadShaped =
        // An anytime quota has no fixed clock time to remind at: a default
        // offset-0 step would fire at local midnight (the occurrence's day
        // start). Check-in nudges for quotas are policy work, not a default
        // due-time reminder.
        cadence.kind === "unscheduled" || cadence.kind === "count_per_day"
          ? { cadence, plan: null }
          : applyLeadUpReminderShape({
              cadence,
              plan:
                (detailObject(details, "reminderPlan") as
                  | CreateLifeOpsDefinitionRequest["reminderPlan"]
                  | undefined) ??
                deferredDefinitionDraft?.request.reminderPlan ??
                buildDefaultReminderPlan(`${title} reminder`),
              ownerText: messageText(message),
              title,
              milestones: resolveMilestoneLabels({
                details,
                intent,
                ownerText: messageText(message),
                multiStep: llmPlan?.multiStep === true,
              }),
            });
      const extractedCheckInPolicy = (() => {
        if (
          leadShaped.cadence.kind !== "count_per_day" ||
          llmPlan?.checkInRequested !== true
        ) {
          return undefined;
        }
        const requestedWindows = normalizeLifeWindows(
          llmPlan.checkInWindows ?? [],
        );
        return {
          kind: "quota_progress" as const,
          windows:
            requestedWindows.length > 0
              ? requestedWindows
              : leadShaped.cadence.timing.kind === "windows"
                ? leadShaped.cadence.timing.windows
                : normalizeLifeWindows(["afternoon"]),
          followupAfterMinutes: 120,
          noReplyPolicy: {
            maxRetries: 1,
            retryCadenceMinutes: [120],
            terminalStatus: "expired" as const,
            terminalReason: "quota_checkin_no_reply",
          },
          stopWhenComplete: true as const,
        };
      })();
      const definitionDraft = {
        intent,
        operation: "create_definition",
        createdAt: editingDeferredDefinitionDraft
          ? Date.now()
          : (deferredDefinitionDraft?.createdAt ?? Date.now()),
        // Preserve the ORIGINAL previewing turn's id on reuse — a same-turn
        // re-preview must not launder the draft into "prior-turn" consent.
        sourceMessageId:
          deferredDefinitionDraft?.sourceMessageId ??
          (currentMessageId !== "" ? currentMessageId : undefined),
        request: {
          idempotencyKey:
            params.idempotencyKey !== undefined
              ? params.idempotencyKey
              : deferredDefinitionDraft?.request.idempotencyKey,
          cadence: leadShaped.cadence,
          description:
            explicitDescription ??
            llmDescription ??
            (editingDeferredDefinitionDraft
              ? deferredDefinitionDraft.request.description
              : undefined),
          goalRef:
            detailString(details, "goalId") ??
            detailString(details, "goalTitle") ??
            deferredDefinitionDraft?.request.goalRef ??
            undefined,
          kind,
          priority:
            explicitPriority ??
            llmPriority ??
            deferredDefinitionDraft?.request.priority,
          progressionRule:
            (detailObject(
              details,
              "progressionRule",
            ) as CreateLifeOpsDefinitionRequest["progressionRule"]) ??
            deferredDefinitionDraft?.request.progressionRule,
          checkInPolicy:
            (detailObject(details, "checkInPolicy") as
              | CreateLifeOpsDefinitionRequest["checkInPolicy"]
              | undefined) ??
            extractedCheckInPolicy ??
            deferredDefinitionDraft?.request.checkInPolicy,
          reminderPlan: leadShaped.plan,
          timezone:
            normalizeLifeTimeZoneToken(llmPlan?.timeZone) ??
            normalizeLifeTimeZoneToken(
              resolvedTimeZone ?? deferredDefinitionDraft?.request.timezone,
            ) ??
            resolvedTimeZone ??
            deferredDefinitionDraft?.request.timezone,
          title,
          metadata: definitionMetadata,
          windowPolicy,
          // detailObject returns Record<string,unknown>; cast at validated boundary.
          websiteAccess:
            (detailObject(details, "websiteAccess") as
              | CreateLifeOpsDefinitionRequest["websiteAccess"]
              | undefined) ?? deferredDefinitionDraft?.request.websiteAccess,
        },
      } satisfies DeferredLifeDefinitionDraft;
      if (
        shouldRequireLifeCreateConfirmation({
          confirmed: createConfirmed,
          messageSource:
            typeof message.content.source === "string"
              ? message.content.source
              : undefined,
          requestKind: timedRequestKind,
          cadence: definitionDraft.request.cadence,
          multiStep: llmPlan?.multiStep === true,
          // Creates only: an EDIT that re-states undatedness keeps the
          // two-phase preview (the #20182 draft-lifecycle contract) — the
          // skip is for the owner's fresh "add a todo: X, no deadline" ask,
          // where the preview would echo back exactly what they just said.
          explicitUndated:
            !editingDeferredDefinitionDraft && undatedAuthority.explicit,
          operationScopedUndated: undatedAuthority.operationScoped,
          previewRequested: LIFE_TEXT_REQUESTS_PREVIEW_RE.test(currentText),
        })
      ) {
        const draftLeadSteps = (
          definitionDraft.request.reminderPlan?.steps ?? []
        )
          .map((step) => ({
            label: step.label,
            minutesBeforeDue: reminderStepMinutesBeforeDue(
              leadShaped.cadence,
              step.offsetMinutes,
            ),
          }))
          .filter((step) => step.minutesBeforeDue >= 60);
        const draftLeadPhrase =
          draftLeadSteps.length > 0
            ? ` It includes early nudges: ${draftLeadSteps
                .map(
                  (step) =>
                    `"${step.label}" ${formatLeadOffsetPhrase(step.minutesBeforeDue)} before`,
                )
                .join(", ")}.`
            : "";
        const fallback = `I can save this as a ${definitionDraft.request.kind} named "${definitionDraft.request.title}" that happens ${summarizeCadence(leadShaped.cadence)}.${draftLeadPhrase} Confirm and I'll save it, or tell me what to change.`;
        const previewText = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "preview_definition",
          fallback,
          context: {
            draft: definitionDraft.request,
            requestKind: timedRequestKind,
          },
        });
        // A preview is NOT a save: nothing is persisted here, only a draft is
        // parked for the confirm turn. Reporting success:true made the model
        // render "I've set it" for a recurring create that never persisted
        // (task_611a9f0b — a no-fabricate violation). success:false +
        // requiresConfirmation makes the deferred state honest; the draft still
        // survives on `data.lifeDraft` for the next-turn confirmation.
        await writeDeferredLifeDraftCache(runtime, message, definitionDraft);
        return {
          success: false as const,
          text: previewText,
          userFacingText: previewText,
          verifiedUserFacing: true,
          data: {
            actionName: ownerSurfaceActionName,
            deferred: true,
            saved: false,
            requiresConfirmation: true,
            lifeDraft: definitionDraft,
            preview: {
              cadence: definitionDraft.request.cadence,
              kind: definitionDraft.request.kind,
              title: definitionDraft.request.title,
            },
          },
        };
      }
      const resolvedGoal = definitionDraft.request.goalRef
        ? await resolveGoal(service, definitionDraft.request.goalRef, domain)
        : null;

      // Preserve legacy content-based confirmation replay when the caller has no
      // operation identity. Explicit keys distinguish intentional copies from
      // retries; the repository elects their single creator durably.
      const duplicateOf =
        definitionDraft.request.idempotencyKey === undefined
          ? (await listCallerDefinitions(service)).find(
              (record) =>
                record.definition.status === "active" &&
                normalizeLifeInputText(
                  record.definition.title,
                ).toLowerCase() ===
                  normalizeLifeInputText(
                    definitionDraft.request.title,
                  ).toLowerCase() &&
                stableCadenceKey(record.definition.cadence) ===
                  stableCadenceKey(definitionDraft.request.cadence),
            )
          : undefined;
      if (duplicateOf) {
        await clearDeferredLifeDraftCache(runtime, message);
        const alreadyText = `"${duplicateOf.definition.title}" is already saved as ${summarizeCadence(duplicateOf.definition.cadence)} — nothing new was created.`;
        return {
          success: true as const,
          text: alreadyText,
          userFacingText: alreadyText,
          verifiedUserFacing: true,
          data: {
            actionName: ownerSurfaceActionName,
            deduplicated: true,
            definition: duplicateOf.definition,
          },
        };
      }

      const created = await service.createDefinition(
        {
          idempotencyKey: definitionDraft.request.idempotencyKey,
          ownership,
          kind: definitionDraft.request.kind,
          title: definitionDraft.request.title,
          description: definitionDraft.request.description,
          originalIntent:
            definitionDraft.intent || definitionDraft.request.title,
          cadence: leadShaped.cadence,
          timezone:
            normalizeLifeTimeZoneToken(definitionDraft.request.timezone) ??
            definitionDraft.request.timezone,
          priority: definitionDraft.request.priority,
          windowPolicy: definitionDraft.request.windowPolicy,
          progressionRule: definitionDraft.request.progressionRule,
          checkInPolicy: definitionDraft.request.checkInPolicy,
          reminderPlan: definitionDraft.request.reminderPlan,
          metadata: definitionDraft.request.metadata,
          websiteAccess: definitionDraft.request.websiteAccess,
          goalId: resolvedGoal?.goal.id ?? null,
          source: "chat",
        },
        {
          originalIntentSource:
            typeof params.intent === "string" && params.intent.trim().length > 0
              ? "argument"
              : "message",
        },
      );
      await clearDeferredLifeDraftCache(runtime, message);
      if (
        definitionDraft.request.idempotencyKey !== undefined &&
        created.idempotency.replayed
      ) {
        const alreadyText = `"${created.definition.title}" was already saved by this operation; nothing new was created.`;
        return {
          success: true as const,
          text: alreadyText,
          userFacingText: alreadyText,
          verifiedUserFacing: true,
          data: toActionData(created),
        };
      }
      // The un-previewed fast path leaves no draft to cancel, so park an undo
      // handle: a next-turn retraction deletes this row deterministically.
      await writeRecentLifeSaveCache(runtime, message, {
        definitionId: created.definition.id,
        title: created.definition.title,
        createdAt: Date.now(),
        ...(currentMessageId !== ""
          ? { sourceMessageId: currentMessageId }
          : {}),
      });
      const savedLeadSteps = (created.reminderPlan?.steps ?? [])
        .map((step) => ({
          label: step.label,
          minutesBeforeDue: reminderStepMinutesBeforeDue(
            created.definition.cadence,
            step.offsetMinutes,
          ),
        }))
        .filter((step) => step.minutesBeforeDue >= 60);
      const leadPhrase =
        savedLeadSteps.length === 1
          ? ` with an early nudge ${formatLeadOffsetPhrase(savedLeadSteps[0].minutesBeforeDue)} before`
          : savedLeadSteps.length > 1
            ? ` with early nudges ${savedLeadSteps
                .map(
                  (step) =>
                    `"${step.label}" ${formatLeadOffsetPhrase(step.minutesBeforeDue)} before`,
                )
                .join(", ")}`
            : "";
      const fallback = `Saved "${created.definition.title}" as ${summarizeCadence(created.definition.cadence)}${leadPhrase}.`;
      const savedText = await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "saved_definition",
        fallback,
        context: {
          created: {
            title: created.definition.title,
            cadence: created.definition.cadence,
            ...(savedLeadSteps.length > 0
              ? {
                  earlyNudges: savedLeadSteps.map(
                    (step) =>
                      `${step.label} ${formatLeadOffsetPhrase(step.minutesBeforeDue)} before`,
                  ),
                }
              : {}),
          },
          requestKind: timedRequestKind,
        },
      });
      // verifiedUserFacing mirrors the preview branch: a completed persist is
      // exactly the state the evaluator must not paraphrase — observed live
      // (#16941): the synthesized reply told the owner "nothing is saved yet"
      // after this branch had already persisted the definition.
      return {
        success: true as const,
        text: savedText,
        userFacingText: savedText,
        verifiedUserFacing: true,
        data: toActionData(created),
      };
    };

    // ── Mutations ───────────────────────────────────

    if (internalOp === "create_definition") {
      return await createDefinition();
    }

    if (internalOp === "create_goal") {
      const goalCreateConfirmed =
        createConfirmed &&
        isExplicitLifeCreateConfirmation(messageText(message));
      const deferredGoalDraft =
        reuseDeferredDraft && deferredDraft?.operation === "create_goal"
          ? deferredDraft
          : null;
      const editingDeferredGoalDraft =
        deferredDraftReuseMode === "edit" &&
        deferredGoalDraft?.operation === "create_goal";
      const explicitDescription = detailString(details, "description");
      const explicitCadence = normalizeCadenceDetail(
        detailObject(details, "cadence"),
      ) as CreateLifeOpsGoalRequest["cadence"];
      const explicitSuccessCriteria = detailObject(
        details,
        "successCriteria",
      ) as CreateLifeOpsGoalRequest["successCriteria"] | undefined;
      const explicitSupportStrategy = detailObject(
        details,
        "supportStrategy",
      ) as CreateLifeOpsGoalRequest["supportStrategy"] | undefined;
      const explicitMetadata = detailObject(details, "metadata") as
        | CreateLifeOpsGoalRequest["metadata"]
        | undefined;
      let title: string | null = editingDeferredGoalDraft
        ? (params.title ?? deferredGoalDraft.request.title)
        : (deferredGoalDraft?.request.title ?? params.title ?? null);
      let description: string | undefined = editingDeferredGoalDraft
        ? (explicitDescription ?? deferredGoalDraft.request.description)
        : (deferredGoalDraft?.request.description ?? explicitDescription);
      let cadence = editingDeferredGoalDraft
        ? (explicitCadence ?? deferredGoalDraft.request.cadence)
        : (deferredGoalDraft?.request.cadence ?? explicitCadence);
      let successCriteria = editingDeferredGoalDraft
        ? (explicitSuccessCriteria ?? deferredGoalDraft.request.successCriteria)
        : (deferredGoalDraft?.request.successCriteria ??
          explicitSuccessCriteria);
      let supportStrategy = editingDeferredGoalDraft
        ? (explicitSupportStrategy ?? deferredGoalDraft.request.supportStrategy)
        : (deferredGoalDraft?.request.supportStrategy ??
          explicitSupportStrategy);
      let goalMetadata: CreateLifeOpsGoalRequest["metadata"] | undefined =
        editingDeferredGoalDraft
          ? (explicitMetadata ?? deferredGoalDraft.request.metadata)
          : (deferredGoalDraft?.request.metadata ?? explicitMetadata);
      let evaluationSummary: string | null = null;

      const hasExplicitGroundedGoal =
        Boolean(title) && Boolean(successCriteria) && Boolean(supportStrategy);

      if (hasExplicitGroundedGoal) {
        const successSummary =
          successCriteria &&
          typeof successCriteria.summary === "string" &&
          successCriteria.summary.trim().length > 0
            ? successCriteria.summary.trim()
            : null;
        goalMetadata = mergeGoalMetadataWithGrounding({
          metadata: {
            ...goalMetadata,
            source: "chat",
            originalIntent: intent,
          },
          nowIso: new Date().toISOString(),
          plan: {
            cadence,
            confidence: null,
            evaluationSummary:
              successSummary ?? description ?? "Goal has explicit criteria.",
            groundingState: "grounded",
            missingCriticalFields: [],
            successCriteria,
            targetDomain: null,
          },
        });
      }

      if (
        (!deferredGoalDraft || editingDeferredGoalDraft) &&
        !hasExplicitGroundedGoal
      ) {
        const groundingIntent = buildGoalGroundingIntent(intent, details);
        const llmPlan = await extractGoalCreatePlanWithLlm({
          runtime,
          intent: groundingIntent,
          state: state ?? undefined,
          message: message,
        });
        if (!title && llmPlan.title) {
          title = llmPlan.title;
        }
        if (!description && llmPlan.description) {
          description = llmPlan.description;
        }
        if (!cadence && llmPlan.cadence) {
          cadence = llmPlan.cadence;
        }
        if (!successCriteria && llmPlan.successCriteria) {
          successCriteria = llmPlan.successCriteria;
        }
        if (!supportStrategy && llmPlan.supportStrategy) {
          supportStrategy = llmPlan.supportStrategy;
        }
        evaluationSummary = llmPlan.evaluationSummary;
        if (
          llmPlan.groundingState === "grounded" &&
          llmPlan.successCriteria &&
          title
        ) {
          goalMetadata = mergeGoalMetadataWithGrounding({
            metadata: {
              ...goalMetadata,
              source: "chat",
              originalIntent: intent,
            },
            nowIso: new Date().toISOString(),
            plan: llmPlan,
          });
        }
        if (
          llmPlan.groundingState !== "grounded" ||
          !title ||
          !successCriteria ||
          !supportStrategy
        ) {
          const text =
            llmPlan.response ??
            "What would count as success for that goal, and over what time window?";
          // A clarification request is a successful outcome from the
          // agent's point of view — the agent chose to ask instead of
          // invent an ungrounded goal. Callers rely on `success: true +
          // data.noop: true` to distinguish a deliberate clarify from a
          // handler error.
          return {
            success: true,
            text,
            userFacingText: text,
            values: {
              success: true,
              error: "NOOP_GOAL_UNGROUNDED",
              noop: true,
              suggestedOperation: "create_goal",
            },
            data: {
              actionName: ownerSurfaceActionName,
              noop: true,
              error: "NOOP_GOAL_UNGROUNDED",
              suggestedOperation: "create_goal",
            },
          };
        }
      }

      if (!title)
        return {
          success: false,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "clarify_create_goal",
            fallback: "What are you trying to achieve?",
            context: {
              missing: ["title"],
              operation: "create_goal",
            },
          }),
        };
      const goalDraft: DeferredLifeGoalDraft = deferredGoalDraft ?? {
        intent,
        operation: "create_goal",
        createdAt: Date.now(),
        sourceMessageId: currentMessageId !== "" ? currentMessageId : undefined,
        request: {
          cadence,
          description,
          metadata: goalMetadata,
          successCriteria,
          supportStrategy,
          title,
        },
      };
      const experienceLoop = await service.buildGoalExperienceLoop({
        title: goalDraft.request.title,
        description: goalDraft.request.description,
        successCriteria:
          (goalDraft.request.successCriteria as
            | Record<string, unknown>
            | undefined) ?? null,
      });
      if (
        shouldRequireLifeCreateConfirmation({
          confirmed: goalCreateConfirmed,
          messageSource:
            typeof message.content.source === "string"
              ? message.content.source
              : undefined,
          previewRequested: LIFE_TEXT_REQUESTS_PREVIEW_RE.test(
            messageText(message),
          ),
        })
      ) {
        if (
          !goalSuccessCriteriaLooksConcrete(goalDraft.request) ||
          (!deferredGoalDraft &&
            !ownerTextHasConcreteGoalCriteria(messageText(message)))
        ) {
          const text = buildConcreteGoalSuccessQuestion(
            goalDraft.request.title,
          );
          return {
            success: false,
            text,
            userFacingText: text,
            data: {
              actionName: ownerSurfaceActionName,
              deferred: true,
              saved: false,
              requiresConfirmation: true,
              lifeDraft: goalDraft,
              experienceLoop,
              preview: {
                title: goalDraft.request.title,
              },
            },
          };
        }
        const fallbackParts = [
          evaluationSummary
            ? `I can save "${goalDraft.request.title}" as a goal. Success looks like this: ${evaluationSummary} Confirm and I'll save it, or tell me what to change.`
            : `I can save this goal as "${goalDraft.request.title}". Confirm and I'll save it, or tell me what to change.`,
        ];
        const supportSummary = summarizeGoalSupportStrategyForPreview(
          goalDraft.request.supportStrategy,
        );
        if (supportSummary) {
          fallbackParts.push(supportSummary);
        }
        const detailSummary = summarizeGoalInputDetailsForPreview(
          currentText,
          fallbackParts.join(" "),
        );
        if (detailSummary) {
          fallbackParts.push(detailSummary);
        }
        const experienceSummary =
          formatGoalExperienceLoopSummary(experienceLoop);
        if (experienceSummary) {
          fallbackParts.push(experienceSummary);
        }
        const previewText = fallbackParts.join(" ");
        // Preview only — the goal is not persisted until the confirm turn.
        // success:false keeps the "not saved yet" state honest (no-fabricate,
        // task_611a9f0b); `verifiedUserFacing` prevents a later evaluator pass
        // from adding a second generic question after the concrete confirmation
        // prompt. The draft survives on `data.lifeDraft` for confirm.
        await writeDeferredLifeDraftCache(runtime, message, goalDraft);
        return {
          success: false,
          text: previewText,
          userFacingText: previewText,
          verifiedUserFacing: true,
          values: {
            success: false,
            saved: false,
            requiresConfirmation: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            deferred: true,
            saved: false,
            requiresConfirmation: true,
            lifeDraft: goalDraft,
            experienceLoop,
            preview: {
              title: goalDraft.request.title,
            },
          },
        };
      }
      const created = await service.createGoal({
        ownership,
        title: goalDraft.request.title,
        description: goalDraft.request.description,
        cadence: goalDraft.request.cadence,
        supportStrategy: goalDraft.request.supportStrategy,
        successCriteria: goalDraft.request.successCriteria,
        metadata: {
          ...goalDraft.request.metadata,
          source: "chat",
          originalIntent: goalDraft.intent || goalDraft.request.title,
        },
      });
      await clearDeferredLifeDraftCache(runtime, message);
      const createAudit = await latestLifeAudit({
        runtime,
        ownerType: "goal",
        ownerId: created.goal.id,
        eventTypes: ["goal_created"],
      });
      if (createAudit.decision.dedup === true) {
        const text = `"${created.goal.title}" is already saved as a goal — nothing new was created.`;
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          data: toActionData({
            ...created,
            deduplicated: true,
          }),
        };
      }
      const createdExperienceLoop = await service.buildGoalExperienceLoop({
        goalId: created.goal.id,
        title: created.goal.title,
        description: created.goal.description,
        successCriteria:
          (created.goal.successCriteria as
            | Record<string, unknown>
            | undefined) ?? null,
      });
      const experienceSummary = formatGoalExperienceLoopSummary(
        createdExperienceLoop,
      );
      const text = experienceSummary
        ? `${buildSavedGoalReply(created.goal)} ${experienceSummary}`
        : buildSavedGoalReply(created.goal);
      return {
        success: true,
        text,
        userFacingText: text,
        data: toActionData({
          ...created,
          experienceLoop: createdExperienceLoop,
        }),
      };
    }

    if (internalOp === "update_definition") {
      const requestedTime = detailString(details, "time");
      const requestedTimeZone = normalizeLifeTimeZoneToken(
        detailString(details, "timezone"),
      );
      const { match: target, ambiguousCandidates } =
        await resolveDefinitionForMutation(
          service,
          targetName,
          messageText(message) || intent,
          domain,
        );
      if (!target)
        return {
          success: false,
          text:
            ambiguousCandidates.length > 0
              ? ambiguousCandidates.some((title) =>
                  /\b(?:landing|arrival|outbound|departure|flight|trip|travel)\b/i.test(
                    title,
                  ),
                ) &&
                requestedTime !== undefined &&
                requestedTimeZone === null
                ? `Multiple items match — which reminder do you mean, and what timezone should I use for ${requestedTime}?\n${ambiguousCandidates.map((title) => `  - ${title}`).join("\n")}`
                : `Multiple items match — which one?\n${ambiguousCandidates.map((title) => `  - ${title}`).join("\n")}`
              : "I could not find that item to update.",
        };
      if (
        requestedTime !== undefined &&
        requestedTimeZone === null &&
        /\b(?:landing|arrival|outbound|departure|flight|trip|travel)\b/i.test(
          target.definition.title,
        )
      ) {
        return {
          success: false,
          text: `Which timezone should I use for ${requestedTime} on "${target.definition.title}"?`,
        };
      }
      const request: UpdateLifeOpsDefinitionRequest = {
        ownership,
        title:
          params.title !== target.definition.title ? params.title : undefined,
        timezone: requestedTimeZone ?? undefined,
        description: detailString(details, "description"),
        cadence: normalizeCadenceDetail(detailObject(details, "cadence")),
        priority: detailNumber(details, "priority"),
        // detailObject returns Record<string,unknown>; cast at validated boundary.
        windowPolicy: detailObject(
          details,
          "windowPolicy",
        ) as UpdateLifeOpsDefinitionRequest["windowPolicy"],
        reminderPlan: detailObject(
          details,
          "reminderPlan",
        ) as UpdateLifeOpsDefinitionRequest["reminderPlan"],
        checkInPolicy: detailObject(
          details,
          "checkInPolicy",
        ) as UpdateLifeOpsDefinitionRequest["checkInPolicy"],
      };

      // If no explicit changes from structured details, try LLM extraction
      if (request.cadence == null && intent) {
        const llmFields = await extractUpdateFieldsWithLlm({
          runtime,
          intent,
          currentTitle: target.definition.title,
          currentCadenceKind: target.definition.cadence.kind,
          currentWindows: target.definition.windowPolicy.windows.map(
            (w) => w.name,
          ),
        });
        if (llmFields) {
          if (llmFields.title) request.title = llmFields.title;
          if (llmFields.priority) request.priority = llmFields.priority;
          if (llmFields.description)
            request.description = llmFields.description;
          if (
            llmFields.cadenceKind ||
            llmFields.windows ||
            llmFields.weekdays ||
            llmFields.everyMinutes ||
            llmFields.quotaTargetCount ||
            llmFields.quotaUnit ||
            llmFields.perOccurrenceWork ||
            llmFields.timeOfDay ||
            llmFields.dueDate ||
            llmFields.dueInDays !== null ||
            llmFields.dueWeekday !== null ||
            llmFields.dueInMinutes !== null
          ) {
            const built = buildCadenceFromUpdateFields({
              currentCadence: target.definition.cadence,
              currentWindowPolicy: target.definition.windowPolicy,
              timeZone: requestedTimeZone ?? target.definition.timezone,
              update: llmFields,
            });
            if (built) {
              request.cadence = built.cadence;
              request.windowPolicy =
                built.windowPolicy ??
                (requestedTimeZone
                  ? {
                      ...target.definition.windowPolicy,
                      timezone: requestedTimeZone,
                    }
                  : undefined);
            }
          }
          if (llmFields.checkInRequested !== null) {
            const effectiveCadence =
              request.cadence ?? target.definition.cadence;
            if (
              llmFields.checkInRequested === true &&
              effectiveCadence.kind === "count_per_day"
            ) {
              const requestedCheckInWindows = normalizeLifeWindows(
                llmFields.checkInWindows ?? [],
              );
              request.checkInPolicy = {
                kind: "quota_progress",
                windows:
                  requestedCheckInWindows.length > 0
                    ? requestedCheckInWindows
                    : effectiveCadence.timing.kind === "windows"
                      ? effectiveCadence.timing.windows
                      : ["afternoon"],
                followupAfterMinutes: 120,
                noReplyPolicy: {
                  maxRetries: 1,
                  retryCadenceMinutes: [120],
                  terminalStatus: "expired",
                  terminalReason: "quota_checkin_no_reply",
                },
                stopWhenComplete: true,
              };
            } else if (llmFields.checkInRequested === false) {
              request.checkInPolicy = null;
            }
          }
        }
      }

      if (!hasDefinitionUpdateChanges(request)) {
        return {
          success: false,
          text: `Tell me what to change about "${target.definition.title}" and I'll update it.`,
        };
      }

      const updated = await service.updateDefinition(
        target.definition.id,
        request,
      );
      const fallback = `Updated "${updated.definition.title}".`;
      const text = await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "updated_definition",
        fallback,
        context: {
          previousTitle: target.definition.title,
          updated: {
            title: updated.definition.title,
          },
        },
      });
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        data: toActionData(updated),
      };
    }

    if (internalOp === "update_goal") {
      const target = await resolveGoal(service, targetName, domain);
      if (!target)
        return {
          success: false,
          text: "I could not find that goal to update.",
        };
      const request: UpdateLifeOpsGoalRequest = {
        ownership,
        title: params.title !== target.goal.title ? params.title : undefined,
        description: detailString(details, "description"),
        cadence: normalizeCadenceDetail(
          detailObject(details, "cadence"),
        ) as UpdateLifeOpsGoalRequest["cadence"],
        supportStrategy: detailObject(details, "supportStrategy"),
        successCriteria: detailObject(details, "successCriteria"),
      };
      const hasExplicitGoalChanges =
        request.title !== undefined ||
        request.description !== undefined ||
        request.cadence !== undefined ||
        request.supportStrategy !== undefined ||
        request.successCriteria !== undefined;
      if (!hasExplicitGoalChanges) {
        const llmPlan = await extractGoalUpdatePlanWithLlm({
          runtime,
          currentGoal: target.goal,
          intent,
          state: state ?? undefined,
          message: message,
        });
        if (llmPlan.mode === "respond") {
          return {
            success: true,
            text:
              llmPlan.response ??
              `Tell me what to change about "${target.goal.title}" and I'll update it.`,
            data: {
              actionName: ownerSurfaceActionName,
              noop: true,
              suggestedOperation: "update_goal",
            },
          };
        }
        if (llmPlan.title) request.title = llmPlan.title;
        if (llmPlan.description) request.description = llmPlan.description;
        if (llmPlan.cadence) request.cadence = llmPlan.cadence;
        if (llmPlan.supportStrategy)
          request.supportStrategy = llmPlan.supportStrategy;
        if (llmPlan.successCriteria)
          request.successCriteria = llmPlan.successCriteria;
        if (llmPlan.groundingState) {
          request.metadata = mergeGoalMetadataWithGrounding({
            metadata: target.goal.metadata,
            nowIso: new Date().toISOString(),
            plan: {
              cadence: llmPlan.cadence,
              confidence: llmPlan.confidence,
              evaluationSummary: llmPlan.evaluationSummary,
              groundingState: llmPlan.groundingState,
              missingCriticalFields: llmPlan.missingCriticalFields,
              successCriteria:
                llmPlan.successCriteria ?? target.goal.successCriteria,
              targetDomain: llmPlan.targetDomain,
            },
          });
        }
      }
      if (
        request.title === undefined &&
        request.description === undefined &&
        request.cadence === undefined &&
        request.supportStrategy === undefined &&
        request.successCriteria === undefined &&
        request.metadata === undefined
      ) {
        return {
          success: false,
          text: `Tell me what to change about "${target.goal.title}" and I'll update it.`,
        };
      }
      const updated = await service.updateGoal(target.goal.id, request);
      const fallback = `Updated goal "${updated.goal.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "updated_goal",
          fallback,
          context: {
            previousTitle: target.goal.title,
            updated: {
              title: updated.goal.title,
            },
          },
        }),
        data: toActionData(updated),
      };
    }

    if (internalOp === "delete_definition") {
      if (isBroadLifeDeleteRequest({ intent, targetName })) {
        const fallback =
          "I won't delete everything from a moment like this. I can pause or snooze things while you take a breath, or delete one specific item if you name it.";
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "reply_only",
            fallback,
            context: {
              reason: "blocked_broad_destructive_delete",
              target: targetName ?? null,
            },
          }),
          data: {
            actionName: ownerSurfaceActionName,
            noop: true,
            blockedReason: "broad_destructive_delete",
          },
        };
      }
      // Enumerated multi-target delete first: several DISTINCT verbatim-named
      // items in one ask delete together (guards documented on the resolver;
      // anything ambiguous falls through to the single-target path below).
      // A supplied target constrains this operation even when the complete
      // request names other records for different steps. Resolve that single
      // identity (or reject it) rather than widening it through bulk matching.
      const enumeratedTargets = targetName?.trim()
        ? []
        : await resolveEnumeratedDeleteTargets(
            service,
            messageText(message) || intent,
            domain,
          );
      if (enumeratedTargets.length > 1) {
        for (const entry of enumeratedTargets) {
          await service.deleteDefinition(entry.definition.id);
        }
        const titles = enumeratedTargets.map(
          (entry) => `"${entry.definition.title}"`,
        );
        const lastDeleted =
          enumeratedTargets[enumeratedTargets.length - 1].definition;
        const fallback = `Deleted ${enumeratedTargets.length} items: ${titles.join(", ")}.`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "deleted_definition",
            fallback,
            context: {
              deleted: {
                title: titles.join(", "),
              },
            },
          }),
          data: {
            actionName: ownerSurfaceActionName,
            // The receipt deriver reads `deleted` (single record, audit-backed
            // commit proof); the full enumeration rides `deletedMany` so the
            // canonical text stays bound to a real committed receipt.
            deleted: {
              kind: "definition",
              id: lastDeleted.id,
              title: lastDeleted.title,
            },
            deletedMany: enumeratedTargets.map((entry) => ({
              kind: "definition",
              id: entry.definition.id,
              title: entry.definition.title,
            })),
          },
        };
      }
      const { match: target, ambiguousCandidates } =
        await resolveDefinitionForMutation(
          service,
          targetName,
          messageText(message) || intent,
          domain,
          // Destructive: a fuzzy near-miss must ask, never delete (the
          // wrong-item deletion guard — sibling of TRIGGER_REF_MISMATCH).
          true,
        );
      if (!target) {
        // Users call scheduled triggers "reminders" too: "delete the landlord
        // reminder" reached this branch, reported not-found, and the trigger it
        // named was never tried (live 2026-09-13). Point the planner at it.
        const trigger = await triggerNamedLikeReminder(
          runtime,
          targetName ?? "",
        );
        if (trigger)
          return {
            success: false,
            text: `"${trigger.displayName}" is a scheduled trigger, not a reminder definition; delete it with the trigger tool (taskId ${trigger.taskId}).`,
            data: {
              error: "REMINDER_IS_TRIGGER",
              triggerTaskId: trigger.taskId,
              suggestedAction: "TRIGGER_DELETE",
              retryable: true,
            },
          };
        return {
          success: false,
          text:
            ambiguousCandidates.length > 0
              ? `I found ${ambiguousCandidates.length === 1 ? "a similarly named item" : "similarly named items"} but not an exact match — delete ${ambiguousCandidates.length === 1 ? "it" : "which one"}?\n${ambiguousCandidates.map((title) => `  - ${title}`).join("\n")}`
              : "I could not find that item to delete.",
        };
      }
      await service.deleteDefinition(target.definition.id);
      const fallback = `Deleted "${target.definition.title}" and its occurrences.`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "deleted_definition",
          fallback,
          context: {
            deleted: {
              title: target.definition.title,
            },
          },
        }),
        data: {
          actionName: ownerSurfaceActionName,
          deleted: {
            kind: "definition",
            id: target.definition.id,
            title: target.definition.title,
          },
        },
      };
    }

    if (internalOp === "delete_goal") {
      if (isBroadLifeDeleteRequest({ intent, targetName })) {
        const fallback =
          "I won't delete every goal from a moment like this. I can help pause the pressure or delete one specific goal if you name it.";
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "reply_only",
            fallback,
            context: {
              reason: "blocked_broad_destructive_delete",
              target: targetName ?? null,
            },
          }),
          data: {
            actionName: ownerSurfaceActionName,
            noop: true,
            blockedReason: "broad_destructive_delete",
          },
        };
      }
      const target = await resolveGoal(service, targetName, domain);
      if (!target)
        return {
          success: false,
          text: "I could not find that goal to delete.",
        };
      await service.deleteGoal(target.goal.id);
      const fallback = `Deleted goal "${target.goal.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "deleted_goal",
          fallback,
          context: {
            deleted: {
              title: target.goal.title,
            },
          },
        }),
        data: {
          actionName: ownerSurfaceActionName,
          deleted: {
            kind: "goal",
            id: target.goal.id,
            title: target.goal.title,
          },
        },
      };
    }

    if (
      internalOp === "reopen_definition" ||
      (internalOp === "complete_occurrence" &&
        ownerSurfaceActionName === "OWNER_TODOS" &&
        !detailString(details, "occurrenceId"))
    ) {
      if (ownerSurfaceActionName !== "OWNER_TODOS")
        return {
          success: false,
          text: "Only undated owner todos support reopening.",
        };
      const { match: target, ambiguousCandidates } =
        await resolveDefinitionForMutation(
          service,
          targetName,
          messageText(message) || intent,
          domain,
        );
      if (ambiguousCandidates.length > 0)
        return {
          success: false,
          text: `Multiple items match — which one?\n${ambiguousCandidates.join("\n")}`,
        };
      if (target?.definition.cadence.kind === "unscheduled") {
        const transition =
          internalOp === "reopen_definition"
            ? await service.reopenTodo(target.definition.id)
            : await service.completeTodo(target.definition.id);
        const completed = transition.definition.status === "completed";
        return {
          success: true,
          text: transition.replayed
            ? `"${transition.definition.title}" was already ${completed ? "done" : "open"} — nothing changed.`
            : `${completed ? "Marked" : "Reopened"} "${transition.definition.title}"${completed ? " done" : ""}.`,
          data: toActionData({
            ...transition,
            todoTransition: completed ? "complete" : "reopen",
          }),
        };
      }
      if (internalOp === "reopen_definition")
        return {
          success: false,
          text: "I could not find that completed undated todo to reopen.",
        };
    }

    if (internalOp === "complete_occurrence") {
      // Direct occurrenceId path: when the planner already knows the
      // occurrence id we skip title/intent matching.
      const directOccurrenceId = detailString(details, "occurrenceId");
      let resolvedTargetId: string;
      if (directOccurrenceId) {
        resolvedTargetId = directOccurrenceId;
      } else {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to complete.",
          };
        }
        resolvedTargetId = target.id;
      }
      const priorOccurrence = await service.repository.getOccurrence(
        runtime.agentId,
        resolvedTargetId,
      );
      const priorView = await service.repository.getOccurrenceView(
        runtime.agentId,
        resolvedTargetId,
      );
      // A count-per-day quota occurrence treats "done"/"did one" as ONE
      // increment toward the daily target, not a terminal completion; the
      // occurrence completes itself when the derived count reaches the
      // target. The message id keys the increment so a replayed or
      // re-planned turn never double-counts.
      if (
        priorView &&
        priorView.cadence.kind === "count_per_day" &&
        priorView.state !== "completed"
      ) {
        const progressResult = await service.recordOccurrenceProgress(
          resolvedTargetId,
          {
            idempotencyKey: `msg:${message.id}`,
            quantity: detailNumber(details, "quantity") ?? undefined,
            note: detailString(details, "note"),
          },
        );
        const { progress } = progressResult;
        const unitLabel =
          progress.completedCount === 1 ? progress.unit : `${progress.unit}s`;
        const fallback = progressResult.completed
          ? `That's ${progress.targetCount}/${progress.targetCount} — "${priorView.title}" is done for today.`
          : `Logged ${progress.completedCount}/${progress.targetCount} ${unitLabel} for "${priorView.title}" — ${progress.remainingCount} to go.`;
        return {
          success: true,
          text: fallback,
          data: toActionData({
            ...progressResult.occurrence,
            progress,
            applied: progressResult.applied,
            progressEventId: progressResult.progressEventId,
            effectReplayed: !progressResult.applied,
          }),
        };
      }
      const completed = await service.completeOccurrence(resolvedTargetId, {
        note: detailString(details, "note"),
      });
      const effectReplayed = priorOccurrence?.state === "completed";
      const fallback = effectReplayed
        ? `"${completed.title}" was already marked done — nothing changed.`
        : `Marked "${completed.title}" done.`;
      return {
        success: true,
        text: effectReplayed
          ? fallback
          : await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "completed_occurrence",
              fallback,
              context: {
                completed: {
                  title: completed.title,
                },
                note: detailString(details, "note"),
              },
            }),
        data: toActionData({
          ...completed,
          effectReplayed,
        }),
      };
    }

    if (internalOp === "skip_occurrence") {
      const { match: target, ambiguousCandidates } =
        await resolveOccurrenceWithIntentFallback({
          service,
          target: targetName,
          domain,
          intent,
          operation,
        });
      if (!target) {
        if (ambiguousCandidates.length > 0) {
          return {
            success: false,
            text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
          };
        }
        return {
          success: false,
          text: "I could not find that active item to skip.",
        };
      }
      const skipped = await service.skipOccurrence(target.id);
      const fallback = `Skipped "${skipped.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "skipped_occurrence",
          fallback,
          context: {
            skipped: {
              title: skipped.title,
            },
          },
        }),
        data: toActionData({
          ...skipped,
          effectReplayed: target.state === "skipped",
        }),
      };
    }

    if (internalOp === "snooze_occurrence") {
      // Direct occurrenceId path for reminder_snooze.
      const directOccurrenceId = detailString(details, "occurrenceId");
      let resolvedTargetId: string;
      if (directOccurrenceId) {
        resolvedTargetId = directOccurrenceId;
      } else {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to snooze.",
          };
        }
        resolvedTargetId = target.id;
      }
      const preset =
        normalizeSnoozePreset(detailString(details, "preset")) ??
        normalizeSnoozePreset(params.preset) ??
        normalizeSnoozePreset(routedParams?.preset);
      const minutes =
        detailNumber(details, "minutes") ??
        normalizeSnoozeMinutes(params.minutes) ??
        normalizeSnoozeMinutes(routedParams?.minutes);
      const snoozed = await service.snoozeOccurrence(resolvedTargetId, {
        preset,
        minutes,
      });
      const fallback = `Snoozed "${snoozed.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "snoozed_occurrence",
          fallback,
          context: {
            snoozed: {
              title: snoozed.title,
            },
            preset: preset ?? null,
            minutes: minutes ?? null,
          },
        }),
        data: toActionData(snoozed),
      };
    }

    if (internalOp === "review_definitions") {
      const surface = ownerDefinitionSurface(ownerSurfaceActionName);
      if (!surface) {
        return {
          success: false,
          text: "That owner surface cannot review LifeOps definitions.",
          data: toActionData({
            actionName: ownerSurfaceActionName,
            definitions: [],
            error: "LIFEOPS_DEFINITION_SURFACE_UNSUPPORTED",
          }),
        };
      }
      const reviewDomain = domain ?? "user_lifeops";
      const scoped = (await listCallerDefinitions(service)).filter(
        (record) =>
          (record.definition.status === "active" ||
            (surface === "OWNER_TODOS" &&
              record.definition.status === "completed" &&
              record.definition.id === targetName)) &&
          record.definition.domain === reviewDomain &&
          definitionReviewSurface(record) === surface,
      );
      const active = scoped.filter(
        (record) => record.definition.status === "active",
      );
      let selected = active;
      // A list-shaped review sometimes arrives with the planner's own list
      // verbiage stamped into the target ("list all my todos" → title
      // "list all"); treating that junk as a hard filter empty-matched and
      // answered "couldn't find an item matching \"list all\"" against a
      // store with real rows (observed live). List verbiage is never an item
      // name — drop the filter and list normally.
      const isListVerbiageTarget =
        typeof targetName === "string" &&
        /^(?:list|show|view|all|everything|(?:list|show|view)\s+all|all\s+of\s+them|(?:all\s+)?my\s+\w+|todos?|goals?|reminders?|routines?|alarms?|habits?)$/iu.test(
          targetName.trim(),
        );
      if (targetName && !isListVerbiageTarget) {
        // A returned todo ID remains readable after completion. Keep ordinary
        // lists and fuzzy title resolution restricted to active definitions.
        const completedTodo =
          surface === "OWNER_TODOS"
            ? scoped.find(
                (record) =>
                  record.definition.id === targetName &&
                  record.definition.status === "completed",
              )
            : undefined;
        const resolved = completedTodo
          ? { match: completedTodo, ambiguousCandidates: [] }
          : resolveDefinitionInRecords(active, targetName);
        if (resolved.ambiguousCandidates.length > 0) {
          const fallback = `Multiple ${definitionReviewSurfaceLabel(surface)} match "${targetName}": ${resolved.ambiguousCandidates.join(", ")}. Which one did you mean?`;
          return {
            success: false,
            text: fallback,
            data: toActionData({
              actionName: ownerSurfaceActionName,
              ambiguousCandidates: resolved.ambiguousCandidates,
              definitions: [],
              error: "LIFEOPS_DEFINITION_AMBIGUOUS",
            }),
          };
        }
        if (!resolved.match) {
          // A genuine miss stays a pure not-found: disclosing other items
          // here is a deliberate no-leak contract (see
          // life.review-definitions.test.ts isolation coverage).
          const fallback = `I couldn't find an active ${definitionReviewSurfaceLabel(surface)} item matching "${targetName}".`;
          return {
            success: false,
            text: fallback,
            data: toActionData({
              actionName: ownerSurfaceActionName,
              definitions: [],
              error: "LIFEOPS_DEFINITION_NOT_FOUND",
            }),
          };
        }
        selected = [resolved.match];
      }
      if (selected.length === 0) {
        const label = definitionReviewSurfaceLabel(surface);
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "definitions_review",
            fallback: `You aren't tracking any active ${label} right now.`,
            context: { definitions: [] },
          }),
          data: toActionData({
            actionName: ownerSurfaceActionName,
            claimGrounding: EMPTY_TRACKED_STATE_CLAIM_GROUNDING,
            definitions: [],
          }),
        };
      }
      const listed = selected.map((record) => ({
        id: record.definition.id,
        title: record.definition.title,
        status: record.definition.status,
        cadence: summarizeCadence(record.definition.cadence),
        kind: record.definition.kind,
      }));
      const fallback = [
        `You're tracking ${selected.length} ${definitionReviewSurfaceLabel(surface)} item${selected.length === 1 ? "" : "s"}:`,
        ...listed.map(
          (item) =>
            `- ${item.title} (${item.status}; ${item.cadence}; ID: ${item.id})`,
        ),
        ...(selected.length > listed.length
          ? [`…and ${selected.length - listed.length} more.`]
          : []),
      ].join("\n");
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "definitions_review",
          fallback,
          context: { definitions: listed, total: selected.length },
        }),
        data: toActionData({
          actionName: ownerSurfaceActionName,
          definitions: selected.map((record) => record.definition),
        }),
      };
    }

    if (internalOp === "review_goal") {
      const target = await resolveGoal(service, targetName, domain);
      if (!target) {
        const weeklyReview = await service.reviewGoalsForWeek();
        if (weeklyReview.summary.totalGoals === 0) {
          // No goals to review — fall through to overview so task-list-style
          // queries like "what's on my task item list today?" still resolve.
          const overview = await service.getOverview();
          const userQuery = messageText(message) || intent || "overview";
          const fallback = formatOverviewForQuery(overview, userQuery);
          return {
            success: true,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent: userQuery,
              scenario: "overview",
              fallback,
              context: {
                summary: overview.owner.summary,
                occurrenceTitles: overview.owner.occurrences.map(
                  (occurrence) => occurrence.title,
                ),
                goalTitles: overview.owner.goals.map((goal) => goal.title),
              },
            }),
            data: toActionData({
              ...overview,
              actionName: ownerSurfaceActionName,
              claimGrounding: EMPTY_TRACKED_STATE_CLAIM_GROUNDING,
            }),
          };
        }
        const fallback = formatWeeklyGoalReview(weeklyReview);
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "weekly_goal_review",
            fallback,
            context: {
              summary: weeklyReview.summary,
              atRiskTitles: weeklyReview.atRisk.map(
                (review) => review.goal.title,
              ),
              needsAttentionTitles: weeklyReview.needsAttention.map(
                (review) => review.goal.title,
              ),
              onTrackTitles: weeklyReview.onTrack.map(
                (review) => review.goal.title,
              ),
            },
          }),
          data: toActionData(weeklyReview),
        };
      }
      const review = await service.reviewGoal(target.goal.id);
      return {
        success: true,
        text: review.summary.explanation,
        data: toActionData(review),
      };
    }

    if (internalOp === "policy_set_reminder") {
      const intensityDetail = detailString(details, "intensity");
      const intensity =
        intensityDetail === "minimal" ||
        intensityDetail === "normal" ||
        intensityDetail === "persistent" ||
        intensityDetail === "high_priority_only"
          ? intensityDetail
          : undefined;
      return applyOwnerPolicySetReminder({
        runtime,
        message,
        intent,
        resolveDefinition: resolveDefinitionFromIntent,
        intensity,
        target: targetName,
        details,
      });
    }

    if (internalOp === "policy_configure_escalation") {
      return applyOwnerPolicyConfigureEscalation({
        runtime,
        message,
        intent,
        resolveDefinition: resolveDefinitionFromIntent,
        target: targetName,
        timeoutMinutes: detailNumber(details, "timeoutMinutes"),
        callAfterMinutes: detailNumber(details, "callAfterMinutes"),
        details,
      });
    }

    return {
      success: false,
      text: "I didn't understand that life management request.",
    };
  } catch (err) {
    // error-policy:J1 The action boundary translates typed domain failures into a rejected user-visible operation.
    if (err instanceof LifeOpsServiceError) {
      logger.error(
        {
          boundary: "lifeops-owner-action",
          operation,
          status: err.status,
          err,
        },
        `[LifeAction] ${operation ?? "unknown"} failed: ${err.message}`,
      );
      const fallback = buildLifeServiceErrorFallback(err, intent);
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "service_error",
          fallback,
          context: {
            status: err.status,
            operation,
          },
        }),
        data: {
          actionName: ownerSurfaceActionName,
          error: "LIFEOPS_SERVICE_ERROR",
          status: err.status,
        },
      };
    }
    throw err;
  }
}

export async function runLifeOperationHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const result = settleLifeActionReply(
    await runLifeOperationHandlerInner(runtime, message, state, options),
  );
  const receipt = await lifeEffectReceiptForResult({
    runtime,
    message,
    options,
    result,
  });
  // A rejected lookup leaves no write to reconcile. Preserve its failure and
  // diagnostics while allowing the planner's existing observation recovery.
  const observationFailure =
    result.success === false &&
    lifeRequestedOperation(options) === "review" &&
    receipt.outcome === "failed" &&
    receipt.failure.acceptance === "rejected";
  const settledResult = observationFailure
    ? { ...result, data: { ...result.data, readOnlyOperation: true } }
    : result;
  if (
    result.replyFailure ||
    (result.transcriptVisibility === "internal" &&
      result.success === false &&
      result.userFacingText === undefined)
  ) {
    return { ...settledResult, effectReceipts: [receipt] };
  }
  return completeLifeOpsEffect(callback, settledResult, receipt);
}

/**
 * A trigger task whose display name matches a reminder title the user gave
 * (case-insensitive, exact or containing). Returns nothing when the match is
 * absent or ambiguous so a wrong trigger is never suggested for deletion.
 */
async function triggerNamedLikeReminder(
  runtime: IAgentRuntime,
  targetName: string,
): Promise<{ taskId: string; displayName: string } | undefined> {
  const wanted = targetName.trim().toLowerCase();
  if (!wanted) return undefined;
  let tasks: Awaited<ReturnType<IAgentRuntime["getTasks"]>>;
  try {
    tasks = await runtime.getTasks({
      tags: ["trigger"],
      agentIds: [runtime.agentId],
    });
  } catch {
    return undefined;
  }
  const matches = tasks.flatMap((task) => {
    const displayName = (
      task.metadata as { trigger?: { displayName?: unknown } } | undefined
    )?.trigger?.displayName;
    if (typeof displayName !== "string" || !task.id) return [];
    const name = displayName.trim().toLowerCase();
    return name === wanted || name.includes(wanted) || wanted.includes(name)
      ? [{ taskId: String(task.id), displayName }]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}
