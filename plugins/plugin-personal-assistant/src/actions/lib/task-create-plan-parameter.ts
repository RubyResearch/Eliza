import type { ActionParameter, ActionParameterSchema } from "@elizaos/core";
import { validateSchema } from "@elizaos/core";
import {
  buildTaskCreatePlan,
  type ExtractedTaskCreatePlan,
  taskCreatePlanGuidance,
} from "./extract-task-plan.js";

// The native planner and fallback extractor share the same semantic plan.
// Omitted tool fields normalize to the extractor's unknown (null) values.
// Keep this on definition CREATE only: reads/deletes/goals do not consume it.
const schema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["mode", "multiStep", "requestKind"],
  properties: {
    mode: { type: "string" as const, enum: ["create", "respond"] },
    response: { type: "string" as const, minLength: 1 },
    requestKind: {
      type: "string" as const,
      enum: ["alarm", "reminder", "unspecified"],
    },
    title: { type: "string" as const, minLength: 1 },
    description: { type: "string" as const, minLength: 1 },
    cadenceKind: {
      type: "string" as const,
      enum: [
        "unscheduled",
        "once",
        "daily",
        "weekly",
        "times_per_day",
        "count_per_day",
        "interval",
      ],
    },
    windows: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
    },
    weekdays: {
      type: "array" as const,
      items: { type: "integer" as const, minimum: 0, maximum: 6 },
    },
    timeOfDay: {
      type: "string" as const,
      pattern: "^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$",
    },
    timeZone: { type: "string" as const, minLength: 1 },
    everyMinutes: { type: "number" as const, minimum: 1 },
    timesPerDay: { type: "integer" as const, minimum: 1 },
    quotaTargetCount: { type: "number" as const, minimum: 1 },
    quotaUnit: { type: "string" as const, minLength: 1 },
    perOccurrenceWork: { type: "string" as const, minLength: 1 },
    checkInRequested: { type: "boolean" as const },
    checkInWindows: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
    },
    priority: { type: "integer" as const, minimum: 1, maximum: 5 },
    durationMinutes: { type: "number" as const, minimum: 1 },
    dueDate: {
      type: "string" as const,
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    },
    dueInDays: { type: "integer" as const, minimum: 0 },
    dueWeekday: { type: "integer" as const, minimum: 0, maximum: 6 },
    dueInMinutes: { type: "number" as const, minimum: 1 },
    multiStep: { type: "boolean" as const },
  },
} satisfies ActionParameterSchema;

export const TASK_CREATE_PLAN_PARAMETER: ActionParameter = {
  name: "createPlan",
  required: false,
  subactions: ["create"],
  description: [
    "For a definition create, supply the complete semantic plan here using the current owner request and relevant conversation already in context. This avoids a second interpretation call. Use intent for the owner's full request; do not duplicate this plan in title/details. Omit createPlan if the necessary context is unavailable. This plan never grants permission to save or confirm a pending draft; the handler applies owner consent and draft rules.",
    "Always include mode, multiStep and requestKind. Use requestKind=unspecified only when neither alarm nor reminder is explicit. Omit other unknown/inapplicable fields; do not send null. Use the current date/time in context for date grounding; retain relative date fields when applicable.",
    taskCreatePlanGuidance(true),
  ].join("\n"),
  schema,
};

/** Validate direct callers too; malformed/partial plans keep normal extraction. */
export function parseNativeTaskCreatePlan(
  value: unknown,
): ExtractedTaskCreatePlan | null {
  if (value === undefined) return null;
  const errors: string[] = [];
  const validated = validateSchema(schema, value, "createPlan", errors);
  if (
    errors.length ||
    !validated ||
    typeof validated !== "object" ||
    Array.isArray(validated)
  )
    return null;
  const plan = buildTaskCreatePlan(validated as Record<string, unknown>);
  if (!plan || (plan.mode === "create" && (!plan.title || !plan.cadenceKind)))
    return null;
  // Do not silently discard an explicit invalid timezone/date before applying
  // the owner's fallback zone or resolving relative dates.
  const raw = validated as Record<string, unknown>;
  if (
    (raw.timeZone !== undefined && !plan.timeZone) ||
    (raw.dueDate !== undefined && !plan.dueDate)
  )
    return null;
  const dateFields = [
    plan.dueDate,
    plan.dueInDays,
    plan.dueWeekday,
    plan.dueInMinutes,
  ].filter((field) => field !== null);
  if (
    dateFields.length > 1 ||
    (plan.cadenceKind !== "once" && dateFields.length > 0)
  )
    return null;
  return plan;
}
