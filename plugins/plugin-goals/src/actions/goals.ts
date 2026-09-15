/**
 * OWNER_GOALS — owner-set long-horizon life goals.
 *
 * Self-contained goal CRUD surface backed by {@link GoalsService} (the goals
 * back-end this plugin owns). Used in the PA-free deployment topology; when
 * `@elizaos/plugin-personal-assistant` is loaded it registers its own richer
 * `OWNER_GOALS` natural-language flow, which delegates to the same
 * {@link GoalsService} CRUD methods.
 *
 * Dispatch: create | update | delete | review. The handler resolves the
 * subaction + params (planner-trust path first, LLM extraction fallback) via
 * `resolveActionArgs`, then calls the goals back-end.
 */

import {
  type Action,
  type ActionResult,
  appendInteractionBlock,
  type ChoiceInteraction,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  resolveActionArgs,
  type State,
  type SubactionsMap,
} from "@elizaos/core";
import type { LifeOpsGoalRecord } from "@elizaos/shared";
import { GoalsServiceError } from "../goal-normalize.ts";
import { createOwnerGoalsService } from "../goals-runtime.ts";
import {
  GOAL_CHECKIN_PROGRESS_STATES,
  type GoalCheckinProgress,
  getGoalsCheckinService,
} from "../services/checkin.ts";
import { GOAL_ACTIONS, GOALS_CONTEXTS, GOALS_LOG_PREFIX } from "../types.ts";

type GoalSubaction = (typeof GOAL_ACTIONS)[number];

interface GoalActionParams {
  id?: string;
  title?: string;
  description?: string;
  note?: string;
  progress?: string;
}

function parseCheckinProgress(
  value: string | undefined,
): GoalCheckinProgress | undefined {
  if (value === undefined) return undefined;
  return GOAL_CHECKIN_PROGRESS_STATES.find((state) => state === value);
}

/**
 * One-tap progress picker for a goal check-in (#14733). A tapped option
 * round-trips as the user's next message carrying the bare progress token
 * (`on_track` | `at_risk` | `needs_attention`) — exactly the values the
 * `checkin` subaction's `progress` parameter accepts, so the follow-up turn
 * records structured progress with no free-text classification.
 */
export function buildGoalCheckinProgressChoice(
  goalId: string,
): ChoiceInteraction {
  return {
    kind: "choice",
    id: `goal-checkin-${goalId}`,
    scope: "goal-checkin",
    options: [
      { value: "on_track", label: "On track" },
      { value: "at_risk", label: "At risk" },
      { value: "needs_attention", label: "Needs attention" },
    ],
  };
}

const SUBACTIONS: SubactionsMap<GoalSubaction> = {
  create: {
    description: "Create a new owner long-horizon life goal.",
    descriptionCompressed: "create owner long-horizon goal",
    required: ["title"],
    optional: ["description"],
  },
  update: {
    description: "Update an existing owner goal by id.",
    descriptionCompressed: "update owner goal by id",
    required: ["id"],
    optional: ["title", "description"],
  },
  delete: {
    description: "Delete an owner goal by id.",
    descriptionCompressed: "delete owner goal by id",
    required: ["id"],
  },
  review: {
    description: "Review the current state of an owner goal by id.",
    descriptionCompressed: "review owner goal state by id",
    required: ["id"],
  },
  checkin: {
    description:
      "Record the owner's check-in response for a goal by id: optional note plus progress (on_track | at_risk | needs_attention).",
    descriptionCompressed: "record goal check-in response by id",
    required: ["id"],
    optional: ["note", "progress"],
  },
};

function describeGoal(record: LifeOpsGoalRecord): string {
  return record.goal.title;
}

export const ownerGoalsAction: Action = {
  name: "OWNER_GOALS",
  description:
    "Manage the owner's long-horizon life goals. Actions: create, update, delete, review, checkin. Goals carry a horizon (e.g. quarter, year, life), feed routine + reminder generation, and cadenced goals get scheduled check-ins whose responses are recorded via checkin.",
  descriptionCompressed:
    "owner goals: create|update|delete|review|checkin; long-horizon, drives routines",
  contexts: [...GOALS_CONTEXTS],
  contextGate: { anyOf: [...GOALS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  tags: [
    "domain:goals",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:owner",
  ],
  similes: ["GOALS", "LIFE_GOALS", "SET_GOAL", "UPDATE_GOAL", "REVIEW_GOALS"],
  parameters: [
    {
      name: "action",
      description: "Action: create | update | delete | review.",
      required: true,
      schema: { type: "string" as const, enum: [...GOAL_ACTIONS] },
    },
    {
      name: "id",
      description: "Goal id (update/delete/review).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Goal title (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "description",
      description: "Longer goal description (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "note",
      description: "Owner's check-in note (checkin).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "progress",
      description: "Reported goal progress (checkin).",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...GOAL_CHECKIN_PROGRESS_STATES],
      },
    },
  ],
  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const resolved = await resolveActionArgs<GoalSubaction, GoalActionParams>({
      runtime,
      message,
      state,
      options,
      actionName: "OWNER_GOALS",
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      await callback?.({ text: resolved.clarification });
      return {
        success: false,
        text: resolved.clarification,
        data: { action: "clarify", missing: resolved.missing },
      };
    }

    const service = createOwnerGoalsService(runtime);
    const { subaction, params } = resolved;

    try {
      switch (subaction) {
        case "create": {
          const title =
            typeof params.title === "string" ? params.title.trim() : undefined;
          if (!title) {
            const text = "Goal title is required for create.";
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "create", error: "missing_title" },
            };
          }
          const record = await service.createGoal({
            title,
            description: params.description,
          });
          const text = `Added goal "${describeGoal(record)}".`;
          await callback?.({ text });
          return { success: true, text, data: { action: "create", record } };
        }
        case "update": {
          const id =
            typeof params.id === "string" ? params.id.trim() : undefined;
          if (!id) {
            const text = "Goal id is required for update.";
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "update", error: "missing_id" },
            };
          }
          if (params.title === undefined && params.description === undefined) {
            const text =
              "At least one of title or description is required for update.";
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "update", error: "missing_fields" },
            };
          }
          const record = await service.updateGoal(id, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.description !== undefined
              ? { description: params.description }
              : {}),
          });
          const text = `Updated goal "${describeGoal(record)}".`;
          await callback?.({ text });
          return { success: true, text, data: { action: "update", record } };
        }
        case "delete": {
          const id =
            typeof params.id === "string" ? params.id.trim() : undefined;
          if (!id) {
            const text = "Goal id is required for delete.";
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "delete", error: "missing_id" },
            };
          }
          const record = await service.getGoal(id);
          await service.deleteGoal(id);
          const text = `${describeGoal(record)} is off your goals list.`;
          await callback?.({ text });
          return {
            success: true,
            text,
            data: { action: "delete", id },
          };
        }
        case "review": {
          const id =
            typeof params.id === "string" ? params.id.trim() : undefined;
          if (!id) {
            const text = "Goal id is required for review.";
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "review", error: "missing_id" },
            };
          }
          const record = await service.getGoal(id);
          const text = `Goal "${describeGoal(record)}" is ${record.goal.reviewState.replace(/_/g, " ")} (status: ${record.goal.status}).`;
          await callback?.({ text });
          return { success: true, text, data: { action: "review", record } };
        }
        case "checkin": {
          const checkinService = getGoalsCheckinService(runtime);
          if (!checkinService) {
            const text = `${GOALS_LOG_PREFIX} the goal check-in engine is not available on this runtime.`;
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "checkin", error: "checkin_service_missing" },
            };
          }
          const progress = parseCheckinProgress(params.progress);
          if (params.progress !== undefined && progress === undefined) {
            // Ask again with one-tap chips instead of a typed-token demand;
            // the tapped value is a valid `progress` on the next turn.
            const text = appendInteractionBlock(
              "How is this goal tracking?",
              buildGoalCheckinProgressChoice(params.id ?? ""),
            );
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "checkin", error: "invalid_progress" },
            };
          }
          const { goal, completedTaskId } =
            await checkinService.recordCheckinResponse({
              goalId: params.id ?? "",
              ...(params.note !== undefined ? { note: params.note } : {}),
              ...(progress !== undefined ? { progress } : {}),
            });
          let text = `Logged check-in for "${goal.title}"${progress ? ` — ${progress.replace(/_/g, " ")}` : ""}.`;
          if (progress === undefined) {
            // Note-only check-in: harvest structured progress with one tap
            // (a second `checkin` turn with progress-only is valid — the
            // engine updates reviewState without needing a live fired task).
            text = appendInteractionBlock(
              `${text} How is it tracking?`,
              buildGoalCheckinProgressChoice(goal.id),
            );
          }
          await callback?.({ text });
          return {
            success: true,
            text,
            data: { action: "checkin", goal, completedTaskId },
          };
        }
      }
    } catch (error) {
      if (error instanceof GoalsServiceError) {
        const text = `${GOALS_LOG_PREFIX} ${error.message}`;
        await callback?.({ text });
        return {
          success: false,
          text,
          data: { action: subaction, error: error.message },
        };
      }
      throw error;
    }
  },
};
