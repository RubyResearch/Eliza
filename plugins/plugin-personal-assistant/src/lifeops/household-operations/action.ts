/**
 * Action-construction seam for household-operation records and projections.
 *
 * Hosts inject owner authentication and register the runtime service. The
 * action persists evidence, evaluates policy, and creates drafts or review
 * proposals only; it has no send, purchase, registration, calendar-mutation,
 * vendor-booking, or responsibility-reassignment verb.
 */
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { resolveActionArgs, type SubactionsMap } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../action-effect-result.js";
import {
  getHouseholdOperationsService,
  type HouseholdOperationsService,
} from "./service.js";
import {
  type HouseholdCalendarCheck,
  HouseholdOperationsError,
  normalizeCalendarCheck,
  normalizeObservationInput,
  normalizeOperationDefinition,
  normalizeResponsibilitySignalInput,
  normalizeServiceEventInput,
  normalizeServiceWindow,
  requireOperationsInteger,
  requireOperationsText,
} from "./types.js";

const ACTION_NAME = "HOUSEHOLD_OPERATIONS";
const HOUSEHOLD_OPERATION_SUBACTIONS = [
  "put_record",
  "record_observation",
  "record_service_event",
  "record_responsibility_signal",
  "evaluate_opportunity",
  "evaluate_item_replacement",
  "assess_responsibility",
  "generate_weekly_brief",
  "read_weekly_brief",
] as const;
type HouseholdOperationSubaction =
  (typeof HOUSEHOLD_OPERATION_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<HouseholdOperationSubaction> = {
  put_record: {
    description:
      "Append a versioned vendor, almanac, opportunity, child-item threshold, or accepted C/P/E/M responsibility record.",
    descriptionCompressed:
      "append versioned household-operation record with CAS",
    required: ["input", "expectedRevision"],
  },
  record_observation: {
    description:
      "Append a provenance- and confidence-bearing home, inventory, or child-size observation, optionally correcting or superseding an earlier observation.",
    descriptionCompressed: "append source-grounded household observation",
    required: ["input"],
  },
  record_service_event: {
    description:
      "Append an evidenced vendor/service-history event; completion requires completion evidence and sent/scheduled states require approval plus provider receipt.",
    descriptionCompressed: "append evidenced vendor service history",
    required: ["input"],
  },
  record_responsibility_signal: {
    description:
      "Append an authenticated or provider-observed delivery, dismissal, overdue, or completion signal for the exact responsibility version.",
    descriptionCompressed:
      "append exact-version responsibility engagement signal",
    required: ["input"],
  },
  evaluate_opportunity: {
    description:
      "Evaluate availability, confirmed coverage, and protected unstructured-time capacity without registering or charging.",
    descriptionCompressed: "evaluate opportunity state and family capacity",
    required: ["recordId"],
  },
  evaluate_item_replacement: {
    description:
      "Evaluate current child-size and usable-count evidence and return no action, a verification request, or an approval-gated replacement draft.",
    descriptionCompressed:
      "evaluate child item size/count threshold; no purchase",
    required: ["recordId"],
  },
  assess_responsibility: {
    description:
      "Evaluate repeated dismissal or overdue signals and propose human responsibility renegotiation without changing any owner.",
    descriptionCompressed:
      "propose non-use responsibility review; never reassign",
    required: ["recordId"],
  },
  generate_weekly_brief: {
    description:
      "Create a scoped structural weekly brief from current revisions, source events, observations, calendar-check evidence, and non-use reviews.",
    descriptionCompressed: "generate structural weekly household brief",
    required: ["householdId", "window", "calendarChecks"],
  },
  read_weekly_brief: {
    description:
      "Read a weekly brief through the caller's graph-backed household and child visibility.",
    descriptionCompressed: "read role-scoped weekly household brief",
    required: ["briefId"],
  },
};

export interface HouseholdOperationsActionDependencies {
  authorize(runtime: IAgentRuntime, message: Memory): Promise<boolean>;
  getService?(runtime: IAgentRuntime): HouseholdOperationsService | null;
}

function serviceFor(
  runtime: IAgentRuntime,
  deps: HouseholdOperationsActionDependencies,
): HouseholdOperationsService {
  const service =
    deps.getService?.(runtime) ?? getHouseholdOperationsService(runtime);
  if (!service) {
    throw new HouseholdOperationsError(
      "Household-operations runtime service is unavailable",
      "HOUSEHOLD_OPERATIONS_GRAPH_UNAVAILABLE",
      { agentId: runtime.agentId },
    );
  }
  return service;
}

function requestId(message: Memory): string {
  return message.id ?? `room:${message.roomId}`;
}

function receiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `${ACTION_NAME}:${operation}:${requestId(message)}:${resourceId}`;
}

function failedReceipt(input: {
  message: Memory;
  operation: string;
  code: string;
  retryable: boolean;
}) {
  const observedAt = new Date().toISOString();
  const id = requestId(input.message);
  return lifeOpsFailedEffect({
    receiptId: receiptId(input.message, input.operation, id),
    operation: input.operation,
    resource: { kind: "runtime.message", id },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    failure: {
      code: input.code,
      retryable: input.retryable,
      acceptance: "rejected",
    },
  });
}

export function createHouseholdOperationsAction(
  deps: HouseholdOperationsActionDependencies,
): Action {
  return {
    name: ACTION_NAME,
    similes: [
      "HOME_MAINTENANCE",
      "HOUSEHOLD_VENDOR",
      "SEASONAL_PLANNING",
      "CHILD_CLOTHING_SIZE",
      "HOUSEHOLD_RESPONSIBILITY",
      "HOUSEHOLD_WEEKLY_BRIEF",
    ],
    tags: [
      "domain:household",
      "domain:tasks",
      "capability:read",
      "capability:write",
      "effect:receipt-required",
      "surface:internal",
    ],
    description:
      "Capture source-grounded household observations and vendor history; version seasonal, child-item, and C/P/E/M policy; and create scoped weekly briefs or approval-gated drafts. This action never sends, purchases, registers, books, mutates calendars, or silently reassigns another adult.",
    descriptionCompressed:
      "household vendors|maintenance|seasonal opportunities|child sizes|CPEM|weekly brief; drafts only",
    routingHint:
      "vendor/service history, due home work, seasonal registration, child clothing size, household responsibility non-use, or weekly family brief -> HOUSEHOLD_OPERATIONS",
    contexts: ["general", "calendar", "tasks", "finance", "documents"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: deps.authorize,
    parameters: [
      {
        name: "action",
        description: "Household-operation verb.",
        required: true,
        schema: {
          type: "string",
          enum: [...HOUSEHOLD_OPERATION_SUBACTIONS],
        },
      },
      {
        name: "input",
        description:
          "Typed record, observation, service event, or responsibility signal.",
        subactions: [
          "put_record",
          "record_observation",
          "record_service_event",
          "record_responsibility_signal",
        ],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "expectedRevision",
        description:
          "Current revision for compare-and-swap; zero creates a record.",
        subactions: ["put_record"],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "recordId",
        description:
          "Opportunity, item-threshold, or responsibility-assignment record ID.",
        subactions: [
          "evaluate_opportunity",
          "evaluate_item_replacement",
          "assess_responsibility",
        ],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "householdId",
        description: "Household projection ID.",
        subactions: ["generate_weekly_brief"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "window",
        description: "Weekly brief ISO start/end window.",
        subactions: ["generate_weekly_brief"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "calendarChecks",
        description:
          "Provider-neutral availability results for exact maintenance windows; absent evidence blocks outreach drafting.",
        subactions: ["generate_weekly_brief"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "briefId",
        description: "Persisted household weekly-brief ID.",
        subactions: ["read_weekly_brief"],
        schema: { type: "string", minLength: 1 },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      if (!(await deps.authorize(runtime, message))) {
        return completeLifeOpsEffect(
          callback,
          {
            success: false,
            text: "Household operations are restricted to the authenticated owner.",
            data: { error: "PERMISSION_DENIED" },
          },
          failedReceipt({
            message,
            operation: "lifeops.household_operations.authorize",
            code: "PERMISSION_DENIED",
            retryable: false,
          }),
        );
      }
      const resolved = await resolveActionArgs<
        HouseholdOperationSubaction,
        Record<string, unknown>
      >({
        runtime,
        message,
        state,
        options,
        actionName: ACTION_NAME,
        subactions: SUBACTIONS,
      });
      if (!resolved.ok) {
        return completeLifeOpsEffect(
          callback,
          {
            success: false,
            text: resolved.clarification,
            data: {
              error: "MISSING_HOUSEHOLD_OPERATION_PARAMETERS",
              missing: resolved.missing,
            },
          },
          failedReceipt({
            message,
            operation: "lifeops.household_operations.resolve_request",
            code: "MISSING_HOUSEHOLD_OPERATION_PARAMETERS",
            retryable: true,
          }),
        );
      }
      const service = serviceFor(runtime, deps);
      if (resolved.subaction === "put_record") {
        const revision = await service.putRevision({
          principalEntityId: SELF_ENTITY_ID,
          definition: normalizeOperationDefinition(resolved.params.input),
          expectedRevision: requireOperationsInteger(
            resolved.params.expectedRevision,
            "expectedRevision",
            0,
          ),
        });
        const operation = "lifeops.household_operation.put_revision";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: `Household ${revision.kind} revision ${revision.revision} was appended.`,
            data: { revision },
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(
              message,
              operation,
              `${revision.recordId}:${revision.revision}`,
            ),
            operation,
            resource: {
              kind: "lifeops.household_operation",
              id: revision.recordId,
              version: String(revision.revision),
            },
            artifacts: [],
            idempotency: { key: null, replayed: false },
            observedAt: revision.createdAt,
            commit: {
              kind: "durable",
              id: `${revision.kind}:${revision.recordId}:${revision.revision}`,
              committedAt: revision.createdAt,
            },
          }),
        );
      }
      if (resolved.subaction === "record_observation") {
        const result = await service.recordObservation({
          principalEntityId: SELF_ENTITY_ID,
          observation: normalizeObservationInput(resolved.params.input),
        });
        const operation = "lifeops.household_observation.record";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: result.inserted
              ? "The household observation was appended."
              : "The exact household observation was already recorded.",
            data: result,
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(
              message,
              operation,
              result.observation.observationId,
            ),
            operation,
            resource: {
              kind: "lifeops.household_observation",
              id: result.observation.observationId,
              version: result.observation.contentSha256,
            },
            artifacts: [],
            idempotency: {
              key: result.observation.observationId,
              replayed: !result.inserted,
            },
            observedAt: result.observation.createdAt,
            commit: {
              kind: "durable",
              id: result.observation.observationId,
              committedAt: result.observation.createdAt,
            },
          }),
        );
      }
      if (resolved.subaction === "record_service_event") {
        const result = await service.recordServiceEvent({
          principalEntityId: SELF_ENTITY_ID,
          event: normalizeServiceEventInput(resolved.params.input),
        });
        const operation = "lifeops.household_service_event.record";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: result.inserted
              ? "The service-history event was appended."
              : "The exact service-history event was already recorded.",
            data: result,
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(message, operation, result.event.eventId),
            operation,
            resource: {
              kind: "lifeops.household_service_event",
              id: result.event.eventId,
              version: result.event.contentSha256,
            },
            artifacts: [],
            idempotency: {
              key: result.event.eventId,
              replayed: !result.inserted,
            },
            observedAt: result.event.createdAt,
            commit: {
              kind: "durable",
              id: result.event.eventId,
              committedAt: result.event.createdAt,
            },
          }),
        );
      }
      if (resolved.subaction === "record_responsibility_signal") {
        const result = await service.recordResponsibilitySignal({
          actingEntityId: SELF_ENTITY_ID,
          signal: normalizeResponsibilitySignalInput(resolved.params.input),
        });
        const operation = "lifeops.household_responsibility_signal.record";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: result.inserted
              ? "The responsibility signal was appended."
              : "The exact responsibility signal was already recorded.",
            data: result,
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(message, operation, result.signal.signalId),
            operation,
            resource: {
              kind: "lifeops.household_responsibility_signal",
              id: result.signal.signalId,
              version: result.signal.contentSha256,
            },
            artifacts: [],
            idempotency: {
              key: result.signal.signalId,
              replayed: !result.inserted,
            },
            observedAt: result.signal.createdAt,
            commit: {
              kind: "durable",
              id: result.signal.signalId,
              committedAt: result.signal.createdAt,
            },
          }),
        );
      }
      if (resolved.subaction === "evaluate_opportunity") {
        const recordId = requireOperationsText(
          resolved.params.recordId,
          "recordId",
          300,
        );
        const evaluation = await service.evaluateOpportunity({
          principalEntityId: SELF_ENTITY_ID,
          opportunityRecordId: recordId,
        });
        const operation = "lifeops.household_opportunity.evaluate";
        const observedAt = new Date().toISOString();
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: "The opportunity was evaluated without registration or charge.",
            data: { evaluation },
          },
          lifeOpsNoopEffect({
            receiptId: receiptId(message, operation, recordId),
            operation,
            resource: { kind: "lifeops.household_opportunity", id: recordId },
            artifacts: [],
            idempotency: { key: null, replayed: false },
            observedAt,
            reason: "Evaluation performed no registration or charge.",
          }),
        );
      }
      if (resolved.subaction === "evaluate_item_replacement") {
        const recordId = requireOperationsText(
          resolved.params.recordId,
          "recordId",
          300,
        );
        const recommendation = await service.evaluateItemReplacement({
          principalEntityId: SELF_ENTITY_ID,
          thresholdRecordId: recordId,
        });
        const operation = "lifeops.household_item_replacement.evaluate";
        const observedAt = new Date().toISOString();
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text:
              recommendation.state === "replacement_draft"
                ? "A replacement draft is available; no purchase was made."
                : "The child-item threshold was evaluated; no purchase was made.",
            data: { recommendation },
          },
          lifeOpsNoopEffect({
            receiptId: receiptId(message, operation, recordId),
            operation,
            resource: {
              kind: "lifeops.household_item_threshold",
              id: recordId,
            },
            artifacts: [],
            idempotency: { key: null, replayed: false },
            observedAt,
            reason: "Evaluation produced no purchase or external mutation.",
          }),
        );
      }
      if (resolved.subaction === "assess_responsibility") {
        const assignmentRecordId = requireOperationsText(
          resolved.params.recordId,
          "recordId",
          300,
        );
        const proposal = await service.assessResponsibility({
          principalEntityId: SELF_ENTITY_ID,
          assignmentRecordId,
        });
        const operation = "lifeops.household_responsibility.assess";
        const result = {
          success: true,
          text: proposal
            ? "A responsibility-renegotiation proposal was created; no owner changed."
            : "The responsibility record does not currently cross its non-use review threshold.",
          data: { proposal },
        } satisfies Parameters<typeof completeLifeOpsEffect>[1];
        if (!proposal) {
          const observedAt = new Date().toISOString();
          return completeLifeOpsEffect(
            callback,
            result,
            lifeOpsNoopEffect({
              receiptId: receiptId(message, operation, assignmentRecordId),
              operation,
              resource: {
                kind: "lifeops.household_responsibility_assignment",
                id: assignmentRecordId,
              },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt,
              reason: "The non-use threshold did not require a proposal.",
            }),
          );
        }
        return completeLifeOpsEffect(
          callback,
          result,
          lifeOpsAppliedEffect({
            receiptId: receiptId(message, operation, proposal.reviewId),
            operation,
            resource: {
              kind: "lifeops.household_responsibility_review",
              id: proposal.reviewId,
              version: proposal.snapshotSha256,
            },
            artifacts: [],
            idempotency: {
              key: proposal.reviewId,
              replayed: proposal.replayed,
            },
            observedAt: proposal.createdAt,
            commit: {
              kind: "durable",
              id: proposal.reviewId,
              committedAt: proposal.createdAt,
            },
          }),
        );
      }
      if (resolved.subaction === "generate_weekly_brief") {
        const calendarChecksValue = resolved.params.calendarChecks;
        if (!Array.isArray(calendarChecksValue)) {
          throw new HouseholdOperationsError(
            "calendarChecks must be an array",
            "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          );
        }
        const calendarChecks: HouseholdCalendarCheck[] =
          calendarChecksValue.map((check, index) =>
            normalizeCalendarCheck(check, `calendarChecks[${index}]`),
          );
        const brief = await service.generateWeeklyBrief({
          principalEntityId: SELF_ENTITY_ID,
          householdId: requireOperationsText(
            resolved.params.householdId,
            "householdId",
            300,
          ),
          window: normalizeServiceWindow(resolved.params.window, "window"),
          calendarChecks,
        });
        const operation = "lifeops.household_weekly_brief.generate";
        return completeLifeOpsEffect(
          callback,
          {
            success: true,
            text: `The weekly brief contains ${brief.items.length} material items and ${brief.questions.length} questions.`,
            data: { brief },
          },
          lifeOpsAppliedEffect({
            receiptId: receiptId(message, operation, brief.briefId),
            operation,
            resource: {
              kind: "lifeops.household_weekly_brief",
              id: brief.briefId,
              version: brief.snapshotSha256,
            },
            artifacts: brief.responsibilityReviewIds.map((reviewId) => ({
              kind: "lifeops.household_responsibility_review",
              id: reviewId,
            })),
            idempotency: {
              key: brief.briefId,
              replayed: brief.replayed,
            },
            observedAt: brief.createdAt,
            commit: {
              kind: "durable",
              id: brief.briefId,
              committedAt: brief.createdAt,
            },
          }),
        );
      }
      const view = await service.readWeeklyBrief({
        principalEntityId: SELF_ENTITY_ID,
        briefId: requireOperationsText(resolved.params.briefId, "briefId", 300),
      });
      const operation = "lifeops.household_weekly_brief.read";
      const observedAt = new Date().toISOString();
      return completeLifeOpsEffect(
        callback,
        {
          success: true,
          text: `The weekly brief contains ${view.items.length} visible material items.`,
          data: { brief: view },
        },
        lifeOpsNoopEffect({
          receiptId: receiptId(message, operation, view.briefId),
          operation,
          resource: {
            kind: "lifeops.household_weekly_brief",
            id: view.briefId,
            version: view.snapshotSha256,
          },
          artifacts: [],
          idempotency: { key: null, replayed: false },
          observedAt,
          reason: "The operation read an existing brief without changing it.",
        }),
      );
    },
  };
}
