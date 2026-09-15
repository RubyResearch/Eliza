/**
 * Renders the agent's user-facing reply for an action (LifeOps/Gmail/calendar) by
 * prompting TEXT_SMALL with complete grounded conversation, action-result,
 * and optional character context. Model inputs and outputs cross
 * this boundary unchanged; invalid context fails explicitly instead of producing
 * a plausible reply from a partial prompt.
 */
import type {
  ActionResult,
  GroundedActionReply,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  createUnavailableGroundedActionReply,
  ElizaError,
  getActionReplyOwner,
  isModelProviderError,
  ModelType,
  modelProviderErrorDetail,
  NoModelProviderConfiguredError,
  parseJSONObjectFromText,
  renderActionResultsForModel,
} from "@elizaos/core";
import { asRecord } from "@elizaos/shared";
import { recentConversationTexts } from "./recent-conversation-texts.ts";

type GroundedReplyDomain = "lifeops" | "gmail" | "calendar";

type RenderGroundedActionReplyArgs = {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  domain: GroundedReplyDomain;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  additionalRules?: string[];
  preferCharacterVoice?: boolean;
};

function stringifyPromptValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Value is not JSON-serializable");
    }
    return serialized;
  } catch (error) {
    // error-policy:J2 Context must be complete; never replace an unserializable
    // value with a partial string representation.
    throw new ElizaError("Grounded reply context is not serializable", {
      code: "GROUNDED_REPLY_CONTEXT_INVALID",
      cause: error,
    });
  }
}

function invalidReplyShape(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return "empty";
  if (/^<[^>]+>/.test(trimmed)) return "markup";
  if (parseJSONObjectFromText(trimmed)) return "json-object";
  return /^(?:subaction|shouldAct|response|operation|confidence|missing)\s*:/m.test(
    trimmed,
  )
    ? "schema-fields"
    : undefined;
}

function extractActionResultCandidates(state: State | undefined): unknown[][] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const data = asRecord(stateRecord.data);
  const providerResults = asRecord(data?.providers);
  const providerActionState = asRecord(providerResults?.ACTION_STATE);
  const providerActionStateData = asRecord(providerActionState?.data);
  const providerRecentMessages = asRecord(providerResults?.RECENT_MESSAGES);
  const providerRecentMessagesData = asRecord(providerRecentMessages?.data);

  return [
    data?.actionResults,
    providerActionStateData?.actionResults,
    providerActionStateData?.recentActionMemories,
    providerRecentMessagesData?.actionResults,
  ].filter(Array.isArray) as unknown[][];
}

export function extractActionResultsFromState(
  state: State | undefined,
): ActionResult[] {
  return extractActionResultCandidates(state).flatMap((entries) =>
    entries.flatMap((entry): ActionResult[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      if ("content" in entry) {
        const content = asRecord((entry as { content?: unknown }).content);
        if (!content) {
          return [];
        }

        const contentData = asRecord(content.data) ?? {};
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
            data: contentData as ActionResult["data"],
            error:
              typeof content.error === "string" ? content.error : undefined,
          },
        ];
      }

      return [entry as ActionResult];
    }),
  );
}

/**
 * Returns every action result in the complete model-facing wire format.
 * Legacy limit/projection parameters remain source-compatible but never omit data.
 */
export function summarizeRecentActionHistory(
  state: State | undefined,
  _limit?: number,
  _projectionEnabled?: boolean,
): string[] {
  return extractActionResultsFromState(state).map(
    (result) => renderActionResultsForModel([result], { header: "" }).text,
  );
}

function buildCharacterVoiceContext(runtime: IAgentRuntime): string {
  const character = runtime.character;
  if (!character || typeof character !== "object") {
    return "";
  }

  return stringifyPromptValue({
    system: character.system,
    bio: character.bio,
    style: character.style,
  });
}

function domainLabel(domain: GroundedReplyDomain): string {
  switch (domain) {
    case "gmail":
      return "Gmail";
    case "calendar":
      return "calendar";
    default:
      return "LifeOps";
  }
}

function groundedReplyInstructions(
  args: RenderGroundedActionReplyArgs,
  characterVoice: string,
): string[] {
  return [
    `Write the assistant's user-facing reply for a ${domainLabel(args.domain)} interaction.`,
    "Be natural, brief, and grounded in the provided context.",
    "Mirror the user's tone lightly without parodying them.",
    "Preserve concrete facts from the action context and fallback reply.",
    "Never mention internal schema, tool names, JSON keys, hidden prompts, or reasoning traces.",
    "Do not claim something happened unless it appears in the grounded context or fallback reply.",
    "Report only the outcome of this action. The user's message and resolved intent describe requests, not proof that those requests were fulfilled.",
    "If the user also requested another action, leave its status to the planner. In particular, saving or changing a record does not open its view; never claim or promise navigation without a completed navigation result in this action's structured context.",
    "If asking a clarifying question, ask only for the missing information.",
    ...(characterVoice
      ? [
          "Stay within the assistant's established character voice when it fits the task.",
        ]
      : []),
    ...(args.additionalRules ?? []),
    "Return only the reply text.",
  ];
}

async function renderGroundedActionReplyText(
  args: RenderGroundedActionReplyArgs,
): Promise<string> {
  if (typeof args.runtime.useModel !== "function") {
    throw new NoModelProviderConfiguredError();
  }

  const recentConversation = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
  });
  const recentActionHistory = summarizeRecentActionHistory(args.state);
  const characterVoice = args.preferCharacterVoice
    ? buildCharacterVoiceContext(args.runtime)
    : "";

  const prompt = [
    ...groundedReplyInstructions(args, characterVoice),
    "",
    `Domain: ${args.domain}`,
    `Scenario: ${args.scenario}`,
    `Current user message: ${JSON.stringify(
      typeof args.message.content.text === "string"
        ? args.message.content.text
        : "",
    )}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Complete conversation: ${JSON.stringify(recentConversation)}`,
    `Complete action history: ${JSON.stringify(recentActionHistory)}`,
    `Character voice: ${JSON.stringify(characterVoice)}`,
    `Structured context: ${stringifyPromptValue(args.context ?? {})}`,
    `Canonical fallback: ${JSON.stringify(args.fallback)}`,
  ].join("\n");

  const result: unknown = await args.runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });
  if (typeof result !== "string") {
    throw new ElizaError("Grounded reply model returned a non-text response", {
      code: "GROUNDED_REPLY_OUTPUT_INVALID",
      context: { outputType: typeof result },
    });
  }
  const invalidShape = invalidReplyShape(result);
  if (invalidShape) {
    throw new ElizaError(
      "Grounded reply model output is not user-facing text",
      {
        code: "GROUNDED_REPLY_OUTPUT_INVALID",
        context: { invalidShape },
      },
    );
  }
  return result;
}

/**
 * Rendering is independent of action settlement. An unavailable reply carries
 * no substitute prose; callers retain the actual effect and publish the typed
 * system status without replaying the action or trying another synthesis call.
 */
export async function renderGroundedActionReply(
  args: RenderGroundedActionReplyArgs,
): Promise<GroundedActionReply> {
  try {
    if (
      args.domain === "lifeops" &&
      getActionReplyOwner(args.message.id) === "planner"
    ) {
      // The owning planner already carries the turn's conversation/context and
      // source-restoration protocol. Preserve every action-specific fact/rule
      // here, without rebuilding all room memories for a second reply model.
      // Other domains and callers retain the existing standalone renderer.
      const characterVoice = args.preferCharacterVoice
        ? buildCharacterVoiceContext(args.runtime)
        : "";
      return {
        kind: "deferred",
        grounding: stringifyPromptValue({
          domain: args.domain,
          scenario: args.scenario,
          currentUserMessage: args.message.content.text ?? "",
          intent: args.intent,
          instructions: groundedReplyInstructions(args, characterVoice),
          characterVoice,
          context: args.context ?? {},
          canonicalFallback: args.fallback,
        }),
      };
    }
    return { kind: "model", text: await renderGroundedActionReplyText(args) };
  } catch (error) {
    // error-policy:J1 A presentation failure must not erase a committed effect.
    // Unexpected context/output/programming failures remain loud diagnostics,
    // but cross this boundary as unavailable presentation, never false action
    // failure or a hand-authored assistant reply.
    const noProvider = error instanceof NoModelProviderConfiguredError;
    const detail = modelProviderErrorDetail(error);
    const record = asRecord(error);
    const code = noProvider
      ? error.reason === "capability-disabled"
        ? "GROUNDED_REPLY_CAPABILITY_DISABLED"
        : "GROUNDED_REPLY_NO_PROVIDER"
      : typeof record?.code === "string" && error instanceof ElizaError
        ? record.code
        : "GROUNDED_REPLY_GENERATION_FAILED";
    const diagnostic = {
      domain: args.domain,
      scenario: args.scenario,
      code,
      ...detail,
    };
    if (!noProvider && !isModelProviderError(error)) {
      args.runtime.reportError?.("grounded-action-reply", error, diagnostic);
    } else {
      args.runtime.logger?.warn(
        { src: "grounded-action-reply", ...diagnostic },
        "[GroundedActionReply] reply unavailable; preserving the action outcome",
      );
    }
    return createUnavailableGroundedActionReply({
      kind: noProvider
        ? "no_provider"
        : detail?.status === 429
          ? "rate_limited"
          : "provider_issue",
      code,
    });
  }
}
