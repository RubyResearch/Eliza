/**
 * Builders for the owner-facing umbrella actions — OWNER_REMINDERS, OWNER_ALARMS,
 * OWNER_GOALS, OWNER_TODOS, OWNER_ROUTINES, OWNER_FINANCES, PERSONAL_ASSISTANT,
 * and the thin health/screen-time wrappers.
 *
 * Each surface pins its backing kind (definitions vs goals) rather than
 * offering a union, and delegates request classification and item CRUD to the
 * shared life engine (`life.ts`) and the per-domain handlers.
 */
import type {
  Action,
  ActionParameters,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { FOLLOW_UP_CAPABLE_ACTION_TAG } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { isOwnerReminderNonCommandContext } from "../lifeops/reminders/direct-routing.js";
import { runBookTravelHandler } from "./book-travel.js";
import { createOwnerHealthAction, runHealthHandler } from "./health.js";
import { runSchedulingNegotiationHandler } from "./lib/scheduling-handler.js";
import { TASK_CREATE_PLAN_PARAMETER } from "./lib/task-create-plan-parameter.js";
import {
  OWNER_OPERATION_CONTEXTS,
  OWNER_OPERATION_ROLE_GATE,
  OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION,
  OWNER_OPERATION_TAGS,
  OWNER_OPERATION_VALIDATE,
  runLifeOperationHandler,
} from "./life.js";
import {
  MONEY_CONTEXTS,
  MONEY_PARAMETERS,
  MONEY_TAGS,
  OWNER_FINANCE_SIMILES,
  runMoneyHandler,
} from "./money.js";
import { runScheduleHandler } from "./schedule.js";
import {
  createOwnerScreenTimeAction,
  runScreenTimeHandler,
} from "./screen-time.js";

const OWNER_LIFE_ACTIONS = [
  "create",
  "update",
  "delete",
  "complete",
  "skip",
  "snooze",
  "review",
] as const;

type OwnerLifeAction = (typeof OWNER_LIFE_ACTIONS)[number] | "reopen";
const OWNER_GOAL_ACTIONS = ["create", "update", "delete", "review"] as const;
const OWNER_FINANCE_ACTIONS = [
  "dashboard",
  "list_sources",
  "add_source",
  "remove_source",
  "import_csv",
  "list_transactions",
  "spending_summary",
  "recurring_charges",
  "childcare_work_scenario",
  "subscription_audit",
  "subscription_cancel",
  "subscription_status",
] as const;
function readParam(options: unknown, key: string): unknown {
  if (!options || typeof options !== "object") return undefined;
  const record = options as Record<string, unknown>;
  const params = record.parameters as Record<string, unknown> | undefined;
  return params?.[key] ?? record[key];
}

function readStringParam(options: unknown, key: string): string | undefined {
  const value = readParam(options, key);
  return typeof value === "string" ? value : undefined;
}

function readParameters(options: unknown): ActionParameters {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  const params = record.parameters;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return { ...(params as ActionParameters) };
  }
  return { ...(record as ActionParameters) };
}

function withParameters(
  options: unknown,
  parameters: ActionParameters,
): HandlerOptions {
  if (!options || typeof options !== "object") {
    return { parameters };
  }
  const record = options as HandlerOptions;
  return {
    ...record,
    parameters,
  };
}

function mirrorActionToSubaction(options: unknown): HandlerOptions {
  const params = readParameters(options);
  const action =
    typeof params.action === "string"
      ? params.action
      : typeof params.subaction === "string"
        ? params.subaction
        : undefined;
  return withParameters(options, {
    ...params,
    ...(action ? { action, subaction: action } : {}),
  });
}

function normalizeOwnerActionFromAllowed<TAction extends string>(
  options: unknown,
  allowed: readonly TAction[],
): TAction | undefined {
  const raw =
    readStringParam(options, "action") ??
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation");
  if (!raw) return undefined;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return allowed.includes(normalized as TAction)
    ? (normalized as TAction)
    : undefined;
}

function makeOwnerLifeAction(args: {
  name: string;
  similes: string[];
  description: string;
  descriptionCompressed: string;
  defaultKind: "definition" | "goal";
  actions?: readonly OwnerLifeAction[];
}): Action {
  const allowedActions = args.actions ?? OWNER_LIFE_ACTIONS;
  return {
    name: args.name,
    similes: args.similes,
    description: args.description,
    descriptionCompressed: args.descriptionCompressed,
    routingHint: `${args.descriptionCompressed} -> ${args.name}; owner-only LifeOps`,
    tags: OWNER_OPERATION_TAGS,
    contexts: OWNER_OPERATION_CONTEXTS,
    roleGate: OWNER_OPERATION_ROLE_GATE,
    suppressPostActionContinuation:
      OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION,
    validate: OWNER_OPERATION_VALIDATE,
    parameters: [
      {
        name: "action",
        description: `Owner item op: ${allowedActions.join("|")}.`,
        required: false,
        schema: { type: "string" as const, enum: [...allowedActions] },
      },
      {
        // The backing store is structural per umbrella (reminders/alarms/
        // todos/routines -> definitions; goals -> goals), so the kind is
        // pinned rather than offered as a union. Observed live (gemma-4-31b,
        // #10722 brush-teeth-basic): the planner set kind:"goal" on
        // OWNER_ROUTINES and silently rerouted a habit save into the goals
        // store, so the definitionCountDelta contract never saw the save.
        name: "kind",
        description: `Backing kind (fixed to "${args.defaultKind}" for this surface; do not change).`,
        required: false,
        schema: {
          type: "string" as const,
          enum: [args.defaultKind],
          default: args.defaultKind,
        },
      },
      {
        name: "intent",
        description: "Free-form owner request.",
        required: false,
        // Planners naturally phrase a change as `when`/`time`/`reschedule`;
        // funnel those into the free-form intent instead of rejecting the
        // whole call with "Unexpected argument" (observed live: an
        // OWNER_REMINDERS update with `reschedule:"today 18:00"` burned a
        // planner round on arg errors, #16935).
        aliases: ["request", "reschedule", "when", "time"],
        schema: { type: "string" as const },
      },
      {
        name: "title",
        description: "Item title when known.",
        required: false,
        aliases: ["name", "subject"],
        schema: { type: "string" as const },
      },
      {
        name: "target",
        description:
          "Existing item id/title for update/delete/complete/skip/snooze or a single-item review. For review of all items, omit target or use an empty string; do not send the literal string null.",
        required: false,
        aliases: ["query", "item", "task", "reminder", "id", "which"],
        schema: { type: "string" as const },
      },
      {
        name: "minutes",
        description: "Snooze minutes when action=snooze.",
        required: false,
        aliases: ["snoozeMinutes", "durationMinutes"],
        schema: { type: "number" as const },
      },
      {
        name: "idempotencyKey",
        description:
          "Create-definition operation identity: reuse the same key and request when retrying; use distinct keys only for intentionally separate items, even if their content is identical. For other operations or unkeyed creation, omit this field or send an empty string. Whitespace-only tool values also mean omission.",
        required: false,
        modelOmissionSentinels: [""],
        schema: { type: "string" as const, minLength: 1, maxLength: 256 },
      },
      {
        name: "confirmed",
        description:
          'create-only: set true ONLY when the owner is confirming a save the assistant previously previewed ("yes, save that") — it saves immediately instead of previewing. Never set on the first request.',
        required: false,
        schema: { type: "boolean" as const },
      },
      {
        name: "details",
        description: "Structured schedule/cadence/notes/details.",
        required: false,
        schema: { type: "object" as const, additionalProperties: true },
      },
      ...(args.defaultKind === "definition"
        ? [TASK_CREATE_PLAN_PARAMETER]
        : []),
    ],
    handler: async (runtime, message, state, options, callback) => {
      const params = readParameters(options);
      const action = normalizeOwnerActionFromAllowed(options, allowedActions);
      const messageText =
        typeof message.content.text === "string" ? message.content.text : "";
      if (
        args.name === "OWNER_REMINDERS" &&
        (action === undefined || action === "create") &&
        isOwnerReminderNonCommandContext(messageText)
      ) {
        const text =
          "I didn't create a reminder because that wasn't an unambiguous request to remind you.";
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          data: {
            outcome: "no_action",
            reason: "REMINDER_CREATE_CONTEXT_REJECTED",
          },
          turnComplete: true,
        };
      }
      const merged = {
        ...params,
        // Pinned, not defaulted: a planner-supplied kind must not flip the
        // umbrella onto the other backing store (see the kind parameter note).
        kind: args.defaultKind,
        ...(action ? { action, subaction: action } : {}),
        ownerSurface: args.name,
      };
      return runLifeOperationHandler(
        runtime,
        message,
        state,
        withParameters(options, merged),
        callback,
      );
    },
  };
}

export const ownerRemindersAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_REMINDERS",
    similes: [
      "REMINDER",
      "REMINDERS",
      "SET_REMINDER",
      "UPDATE_REMINDER",
      "MODIFY_REMINDER",
      "SEARCH_REMINDERS",
      "REMIND_ME",
      "REMIND_ME_TO",
      "CREATE_REMINDER",
      "DAILY_REMINDER",
      "RECURRING_REMINDER",
    ],
    description:
      'Owner reminders: create/update/delete/complete/skip/snooze/review one-off, date-only, deadline ("by the 20th"), and recurring reminders.',
    descriptionCompressed:
      "owner reminders/deadlines: action=create|update|delete|complete|skip|snooze|review",
    defaultKind: "definition",
  }),
  name: "OWNER_REMINDERS",
  tags: [...OWNER_OPERATION_TAGS, FOLLOW_UP_CAPABLE_ACTION_TAG],
  similes: [
    "REMINDER",
    "REMINDERS",
    "SET_REMINDER",
    "UPDATE_REMINDER",
    "MODIFY_REMINDER",
    "SEARCH_REMINDERS",
    "REMIND_ME",
    "REMIND_ME_TO",
    "CREATE_REMINDER",
    "DAILY_REMINDER",
    "RECURRING_REMINDER",
  ],
  description:
    'Owner reminders: create/update/delete/complete/skip/snooze/review one-off, date-only, deadline ("by the 20th"), and recurring reminders.',
  descriptionCompressed:
    "owner reminders/deadlines: action=create|update|delete|complete|skip|snooze|review",
};

export const ownerAlarmsAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_ALARMS",
    similes: ["ALARM", "ALARMS", "WAKE_ME", "WAKE_UP"],
    description:
      "Owner alarms: create/update/delete/complete/skip/snooze/review alarm reminders.",
    descriptionCompressed:
      "owner alarms: action=create|update|delete|complete|skip|snooze|review",
    defaultKind: "definition",
  }),
  name: "OWNER_ALARMS",
  similes: ["ALARM", "ALARMS", "WAKE_ME", "WAKE_UP"],
  description:
    "Owner alarms: create/update/delete/complete/skip/snooze/review alarm reminders.",
  descriptionCompressed:
    "owner alarms: action=create|update|delete|complete|skip|snooze|review",
};

// Primary OWNER_GOALS surface. @elizaos/plugin-goals also declares an action
// named OWNER_GOALS (its `goals.ts`); when personal-assistant is loaded THIS one
// registers first and first-registration-wins silently skips plugin-goals'.
// That is intentional, not a collision to "fix": both delegate to the same
// GoalsService back-end, and plugin-goals' action is the deliberate fallback for
// the PA-free topology. Do not remove either. See plugin-goals CLAUDE.md.
export const ownerGoalsAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_GOALS",
    similes: [
      "GOAL",
      "GOALS",
      "LIFE_GOALS",
      "LONG_TERM_GOAL",
      "ADD_GOAL",
      "ADD_GOALS",
      "CREATE_SAVINGS_PLAN",
      "SAVINGS_GOAL",
      "SAVINGS_PLAN",
      "SAVE_MONEY_GOAL",
      "SAVE_MONEY_FOR_TRIP",
      "TRAVEL_SAVINGS_PLAN",
      "TRAVEL_GOAL",
      "TRIP_GOAL",
      "TRIP_SAVINGS_PLAN",
      "FITNESS_GOAL",
      "LEARNING_GOAL",
      "SET_GOAL",
      "SAVE_GOAL",
      "CREATE_GOAL",
      "CONFIRM_GOAL",
      "TRACK_GOAL",
      "GOAL_CREATE",
      "GOAL_SAVE",
      "GOALS_CREATE",
      "GOALS_SAVE",
      "UPDATE_GOAL",
      "DELETE_GOAL",
      "REVIEW_GOALS",
    ],
    description:
      "Owner goals: create/update/delete/review long-horizon goals/progress. Use for savings, travel/trip, fitness, learning, sleep, health, and other owner outcomes that need success criteria, support strategy, or check-ins.",
    descriptionCompressed:
      "owner goals: create|update|delete|review savings/trip/fitness/learning/sleep outcomes",
    defaultKind: "goal",
    actions: [...OWNER_GOAL_ACTIONS],
  }),
  name: "OWNER_GOALS",
  similes: [
    "GOAL",
    "GOALS",
    "LIFE_GOALS",
    "LONG_TERM_GOAL",
    "ADD_GOAL",
    "ADD_GOALS",
    "CREATE_SAVINGS_PLAN",
    "SAVINGS_GOAL",
    "SAVINGS_PLAN",
    "SAVE_MONEY_GOAL",
    "SAVE_MONEY_FOR_TRIP",
    "TRAVEL_SAVINGS_PLAN",
    "TRAVEL_GOAL",
    "TRIP_GOAL",
    "TRIP_SAVINGS_PLAN",
    "FITNESS_GOAL",
    "LEARNING_GOAL",
    "SET_GOAL",
    "SAVE_GOAL",
    "CREATE_GOAL",
    "CONFIRM_GOAL",
    "TRACK_GOAL",
    "GOAL_CREATE",
    "GOAL_SAVE",
    "GOALS_CREATE",
    "GOALS_SAVE",
    "UPDATE_GOAL",
    "DELETE_GOAL",
    "REVIEW_GOALS",
  ],
  description:
    "Owner goals: create/update/delete/review long-horizon goals/progress. Use for savings, travel/trip, fitness, learning, sleep, health, and other owner outcomes that need success criteria, support strategy, or check-ins.",
  descriptionCompressed:
    "owner goals: create|update|delete|review savings/trip/fitness/learning/sleep outcomes",
  routingHint:
    "long-horizon outcomes/aspirations the owner is working toward ('my goal is X', 'life goal') -> OWNER_GOALS; do NOT use for time-triggered reminders ('remind me at 9pm') -> OWNER_REMINDERS, one-off checklist items -> OWNER_TODOS, or recurring daily habits -> OWNER_ROUTINES",
};

// Owner-store todos surface. Backed by the app-lifeops owner definitions store
// (with kind=definition occurrence tracking). The general-purpose planner
// surface — backed by @elizaos/core TodosService — is implemented in
// plugins/plugin-todos/src/actions/task item.ts. The two surfaces target different
// stores and must not be merged.
export const ownerTodosAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_TODOS",
    similes: ["OWNER_TODO", "PERSONAL_TODO", "PERSONAL_TODOS", "PERSONAL_TASK"],
    description:
      "Owner todos: create/update/delete/complete/reopen/skip/snooze/review personal.",
    descriptionCompressed:
      "owner todos: action=create|update|delete|complete|reopen|skip|snooze|review",
    defaultKind: "definition",
    actions: [...OWNER_LIFE_ACTIONS, "reopen"],
  }),
  name: "OWNER_TODOS",
  similes: ["OWNER_TODO", "PERSONAL_TODO", "PERSONAL_TODOS", "PERSONAL_TASK"],
  description:
    "Owner todos: create/update/delete/complete/reopen/skip/snooze/review personal.",
  descriptionCompressed:
    "owner todos: action=create|update|delete|complete|reopen|skip|snooze|review",
};

const OWNER_ROUTINE_ACTIONS = [
  ...OWNER_LIFE_ACTIONS,
  "schedule_summary",
  "schedule_inspect",
] as const;

type OwnerRoutineAction = (typeof OWNER_ROUTINE_ACTIONS)[number];

function normalizeOwnerRoutineAction(
  options: unknown,
): OwnerRoutineAction | undefined {
  const raw =
    readStringParam(options, "action") ??
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation");
  if (!raw) return undefined;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return (OWNER_ROUTINE_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerRoutineAction)
    : undefined;
}

export const ownerRoutinesAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_ROUTINES",
    similes: [
      "HABIT",
      "HABITS",
      "ROUTINE",
      "ROUTINES",
      "SAVE_HABIT",
      "CREATE_HABIT",
      "NEW_HABIT",
      "DAILY_HABIT",
      "TRACK_HABIT",
      "CREATE_ROUTINE",
      "RECURRING_TASK",
      "CREATE_RECURRING_TASK",
      "DAILY_TASK",
      "WEEKLY_TASK",
    ],
    description:
      'Owner habits & routines: save a new recurring habit/routine from chat ("brush my teeth at 8 am and 9 pm every day", "meditate daily") — builds the habit definition + reminder plan; also update/delete/complete/skip/snooze/review; passive schedule inference.',
    descriptionCompressed:
      "owner habits/routines: create new habit from chat (daily/weekly times + reminder plan)|update|delete|complete|skip|snooze|review|schedule_summary|inspect",
    defaultKind: "definition",
  }),
  name: "OWNER_ROUTINES",
  similes: [
    "HABIT",
    "HABITS",
    "ROUTINE",
    "ROUTINES",
    "SAVE_HABIT",
    "CREATE_HABIT",
    "NEW_HABIT",
    "DAILY_HABIT",
    "TRACK_HABIT",
    "CREATE_ROUTINE",
    "RECURRING_TASK",
    "CREATE_RECURRING_TASK",
    "DAILY_TASK",
    "WEEKLY_TASK",
  ],
  description:
    'Owner habits & routines: save a new recurring habit/routine from chat ("brush my teeth at 8 am and 9 pm every day", "meditate daily") — builds the habit definition + reminder plan; also update/delete/complete/skip/snooze/review; passive schedule inference.',
  descriptionCompressed:
    "owner habits/routines: create new habit from chat (daily/weekly times + reminder plan)|update|delete|complete|skip|snooze|review|schedule_summary|inspect",
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Help me brush my teeth at 8 am and 9 pm every day.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll set that up as a brushing habit at 8:00 am and 9:00 pm daily — confirm and I'll save it.",
          action: "OWNER_ROUTINES",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Yes, save that brushing routine." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Saved — I'll remind you at 8 am and 9 pm every day.",
          action: "OWNER_ROUTINES",
        },
      },
    ],
  ],
  parameters: [
    {
      name: "action",
      description:
        "Routine op: create|update|delete|complete|skip|snooze|review|schedule_summary|schedule_inspect.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_ROUTINE_ACTIONS] },
    },
    ...(
      makeOwnerLifeAction({
        name: "OWNER_ROUTINES",
        similes: [],
        description:
          "Owner routines: recurring habits and scheduled routine occurrences.",
        descriptionCompressed:
          "owner routines create|update|delete|complete|skip|snooze|review|schedule",
        defaultKind: "definition",
      }).parameters ?? []
    ).filter((parameter) => parameter.name !== "action"),
  ],
  handler: async (runtime, message, state, options, callback) => {
    const action = normalizeOwnerRoutineAction(options);
    if (action === "schedule_summary" || action === "schedule_inspect") {
      const params = {
        ...readParameters(options),
        subaction: action === "schedule_inspect" ? "inspect" : "summary",
      };
      return runScheduleHandler(
        runtime,
        message,
        state,
        withParameters(options, params),
        callback,
      );
    }
    const params = readParameters(options);
    const merged = {
      ...params,
      // Pinned: routines/habits are definition-backed. Live gemma-4-31b set
      // kind:"goal" here and rerouted a habit save into the goals store
      // (#10722 brush-teeth-basic).
      kind: "definition",
      ...(action ? { action, subaction: action } : {}),
      ownerSurface: "OWNER_ROUTINES",
    };
    return runLifeOperationHandler(
      runtime,
      message,
      state,
      withParameters(options, merged),
      callback,
    );
  },
};

export const ownerHealthAction: Action = createOwnerHealthAction({
  validate: OWNER_OPERATION_VALIDATE,
  handler: (runtime, message, state, options, callback) =>
    runHealthHandler(
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
});

export const ownerScreenTimeAction: Action = createOwnerScreenTimeAction({
  validate: OWNER_OPERATION_VALIDATE,
  handler: (runtime, message, state, options, callback) =>
    runScreenTimeHandler(
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
});

export const ownerFinancesAction: Action = {
  name: "OWNER_FINANCES",
  similes: ["FINANCES", ...OWNER_FINANCE_SIMILES],
  description:
    "Owner finances: sources, imports, spending, recurring charges, subscriptions.",
  descriptionCompressed:
    "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
  routingHint:
    "owner finance records, spending, payments, and subscriptions -> OWNER_FINANCES; owner-only LifeOps",
  tags: [...MONEY_TAGS],
  contexts: [...MONEY_CONTEXTS],
  roleGate: OWNER_OPERATION_ROLE_GATE,
  suppressPostActionContinuation:
    OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION,
  parameters: [
    {
      name: "action",
      description: "Owner finance op.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_FINANCE_ACTIONS] },
    },
    ...MONEY_PARAMETERS.filter((parameter) => parameter.name !== "subaction"),
  ],
  validate: OWNER_OPERATION_VALIDATE,
  handler: (runtime, message, state, options, _callback) =>
    runMoneyHandler(runtime, message, state, mirrorActionToSubaction(options)),
};

const PERSONAL_ASSISTANT_ACTIONS = [
  "book_travel",
  "scheduling",
  "sign_document",
] as const;

function getMessageText(message: Memory): string {
  const text = message.content.text;
  return typeof text === "string" ? text : "";
}

function firstUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+/u)?.[0] ?? null;
}

function defaultSignatureDeadline(text: string): string {
  const inDays = /\bin\s+(\d+)\s+days?\b/iu.exec(text);
  if (inDays?.[1]) {
    const date = new Date(Date.now() + Number(inDays[1]) * 24 * 60 * 60 * 1000);
    return date.toISOString();
  }
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}

async function enqueueDocumentSignatureApproval(args: {
  runtime: IAgentRuntime;
  message: Memory;
  options: unknown;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const params = readParameters(args.options);
  const text = getMessageText(args.message);
  const documentName =
    readStringParam(args.options, "documentName") ??
    readStringParam(args.options, "document_name") ??
    (/nda/i.test(text) ? "NDA" : "Document for signature");
  const documentId =
    readStringParam(args.options, "documentId") ??
    readStringParam(args.options, "document_id") ??
    `signature-${String(args.message.id ?? Date.now())}`;
  const signatureUrl =
    readStringParam(args.options, "signatureUrl") ??
    readStringParam(args.options, "signature_url") ??
    firstUrl(text) ??
    "pending-signature-url";
  const deadline =
    readStringParam(args.options, "deadline") ?? defaultSignatureDeadline(text);
  const subjectUserId =
    typeof args.message.entityId === "string"
      ? args.message.entityId
      : String(args.runtime.agentId);

  const queue = createApprovalQueue(args.runtime, {
    agentId: args.runtime.agentId,
  });
  const request = await queue.enqueue({
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId,
      documentName,
      signatureUrl,
      deadline,
    },
    channel: "internal",
    reason:
      typeof params.reason === "string" && params.reason.trim().length > 0
        ? params.reason.trim()
        : `Initiate signing flow for ${documentName}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const responseText = `Queued the ${documentName} signing flow for approval before anything is sent.`;
  await args.callback?.({
    text: responseText,
    source: "action",
    action: "PERSONAL_ASSISTANT",
  });
  return {
    success: true,
    text: responseText,
    data: {
      actionName: "PERSONAL_ASSISTANT",
      action: "sign_document",
      approvalRequestId: request.id,
    },
  };
}

export const personalAssistantAction: Action = {
  name: "PERSONAL_ASSISTANT",
  similes: [
    "ASSISTANT",
    "SCHEDULING",
    "SIGN_DOCUMENT",
    "DOCUSIGN",
    // PRD action-catalog aliases. Travel workflows resolve to action=book_travel
    // on PERSONAL_ASSISTANT.
    // See packages/docs/action-prd-map.md.
    "TRAVEL_CAPTURE_PREFERENCES",
    "TRAVEL_BOOK_FLIGHT",
    "TRAVEL_BOOK_HOTEL",
    "TRAVEL_SYNC_ITINERARY_TO_CALENDAR",
    "TRAVEL_REBOOK_AFTER_CONFLICT",
  ],
  description:
    "Owner personal-assistant workflows: action=book_travel travel booking; action=scheduling negotiation; action=sign_document signature, owner approval queue.",
  descriptionCompressed:
    "personal assistant workflows: action=book_travel|scheduling|sign_document",
  contexts: ["general", "calendar", "travel", "tasks"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async () => true,
  parameters: [
    {
      name: "action",
      description: "Assistant op: book_travel|scheduling|sign_document.",
      required: true,
      schema: {
        type: "string" as const,
        enum: [...PERSONAL_ASSISTANT_ACTIONS],
      },
    },
  ],
  handler: async (runtime, message, state, options, callback) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return {
        success: false,
        text: "Personal-assistant workflows are restricted to the owner.",
        data: { actionName: "PERSONAL_ASSISTANT", error: "PERMISSION_DENIED" },
      };
    }

    const action = readStringParam(options, "action")?.trim().toLowerCase();
    if (action === "book_travel") {
      return runBookTravelHandler(runtime, message, state, options, callback);
    }
    if (action === "scheduling") {
      return runSchedulingNegotiationHandler(
        runtime,
        message,
        state,
        options,
        callback,
      );
    }
    if (action === "sign_document") {
      return enqueueDocumentSignatureApproval({
        runtime,
        message,
        options,
        callback,
      });
    }
    return {
      success: false,
      text: "PERSONAL_ASSISTANT requires action=book_travel, action=scheduling, or action=sign_document.",
      data: { error: "MISSING_ACTION" },
    };
  },
};
