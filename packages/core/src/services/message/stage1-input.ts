/** Renders complete message-handler instructions and model input with stable prompt-prefix boundaries. */

import { v4 } from "uuid";
import { HANDLE_RESPONSE_TOOL_NAME } from "../../actions/to-tool";
import { messageHandlerTemplate } from "../../prompts";
import {
	COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
	completionContextSources,
} from "../../runtime/completion-context";
import {
	normalizePromptSegments,
	renderContextObject,
	segmentBlock,
} from "../../runtime/context-renderer";
import type { ContextObject } from "../../types/context-object";
import type { ContextDefinition } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import type { ChatMessage, PromptSegment } from "../../types/model";
import type { UUID } from "../../types/primitives";
import { asUUID, ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { composePrompt } from "../../utils";
import type { OptimizedPromptTask } from "../optimized-prompt";
import {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "../optimized-prompt-resolver";
import {
	listAvailableContextsForRole,
	resolveStage1SenderRole,
} from "./addressing.js";
import {
	buildCurrentTurnBoundary,
	createV5MessageContextObject,
} from "./context-assembly.js";
import {
	CONTEXT_CATALOG_REFERENCE,
	formatAvailableContextsForPrompt,
} from "./context-catalog.js";
import {
	type HistoryDiscovery,
	historyReferenceNotice,
	loadedHistorySegments,
	REVIEWED_HISTORY_SELECTION_INSTRUCTIONS,
} from "./history-discovery.js";
import {
	labelHistorySources,
	shortenHistoryRoleLabels,
} from "./history-wire.js";
import {
	ambientTurnProviderExclusions,
	composeResponseState,
} from "./provider-state.js";

export const CODE_SNIPPET_VALIDITY_INSTRUCTION =
	"For code snippets, prioritize syntactically valid runnable code over impossible formatting constraints. If a tight line count would require invalid syntax, provide a valid version and briefly note the constraint tradeoff.";

export {
	CONTEXT_CATALOG_REFERENCE,
	formatAvailableContextsForPrompt,
} from "./context-catalog.js";

export interface ContextCatalogReference {
	text: string;
	notice: string;
	loaded: boolean;
}

/** Default direct-text routing can read the complete authorized catalog through
 * the same pre-effect context-request boundary as provider references. */
export function createContextCatalogReference(
	runtime: OptimizedPromptRuntimeLike,
	contexts: readonly ContextDefinition[],
): ContextCatalogReference | undefined {
	if (
		resolveOptimizedPromptForRuntime(
			runtime,
			selectMessageHandlerTask(contexts),
			messageHandlerTemplate,
		) !== messageHandlerTemplate
	)
		return undefined;
	const text = formatAvailableContextsForPrompt(contexts);
	const notice = [
		contexts.map(({ id }) => id).join(", "),
		`context_discovery: ${CONTEXT_CATALOG_REFERENCE}`,
		'All authorized routing-context names are listed above. Full labels, aliases, hierarchy, sensitivity and complete descriptions are available by contextRequests=["CONTEXT_CATALOG"], with contexts=["simple"], empty replyText and no action candidates. Request the catalog when those descriptions are needed to choose or explain a context; use the known names directly when the supplied instructions and live context already determine the route. This reads reference text, never app data or actions. Context names do not confer permission.',
	].join("\n");
	return notice.length < text.length
		? { text, notice, loaded: false }
		: undefined;
}

export const VOICE_ENGAGEMENT_RULES = [
	"- shouldRespond=RESPOND for a completed caller question, request, substantive statement, or conversational continuation.",
	"- This is a one-to-one conversation: respond naturally to acknowledgements, reactions, and brief follow-ups, including disagreement or requests to clarify your previous reply.",
	"- shouldRespond=IGNORE only for non-speech/noise or ambient speech clearly not addressed to the agent.",
	"- shouldRespond=STOP only when the caller explicitly asks the agent to disengage or end the conversation.",
	"- Do not use IGNORE merely because the answer is brief, uncertain, or requires a tool.",
].join("\n");

export function formatRoleGateForPrompt(
	roleGate: ContextDefinition["roleGate"],
): string | undefined {
	if (!roleGate) {
		return undefined;
	}
	if (roleGate.minRole) {
		return `role>=${roleGate.minRole}`;
	}
	const anyOf = [...(roleGate.roles ?? []), ...(roleGate.anyOf ?? [])];
	if (anyOf.length > 0) {
		return `role=${anyOf.join("|")}`;
	}
	if (roleGate.allOf?.length) {
		return `role_all=${roleGate.allOf.join("+")}`;
	}
	return undefined;
}

/**
 * The Stage-1 `messageHandlerTemplate` covers two optimized-prompt tasks:
 *
 *   - `should_respond` — the prompt asks the model to decide whether to
 *     respond or ignore the message. Optimizing this task tunes the classifier.
 *   - `response` — Stage-1 also emits the assistant's draft reply when it
 *     decides to respond, so a separately-trained `response` artifact
 *     replaces the same baseline when present and the operator wants that
 *     variant active.
 */
export function selectMessageHandlerTask(
	_availableContexts: readonly ContextDefinition[],
): OptimizedPromptTask {
	// context_routing was retired (inferContextRoutingFromText is pure regex,
	// no LLM call to optimize); the message-handler template falls back to the
	// should_respond task for both the contexts-available and contexts-empty
	// callers.
	return "should_respond";
}

export function renderMessageHandlerInstructions(
	runtime: OptimizedPromptRuntimeLike & Pick<IAgentRuntime, "character">,
	availableContexts: readonly ContextDefinition[],
	options?: {
		directMessage?: boolean;
		voiceDirectMessage?: boolean;
		responseHandlerFields?: string;
		contextCatalog?: ContextCatalogReference;
	},
): string {
	const baseline = resolveOptimizedPromptForRuntime(
		runtime,
		selectMessageHandlerTask(availableContexts),
		messageHandlerTemplate,
	);
	const rendered = composePrompt({
		state: {
			agentName: runtime.character.name?.trim() || "the agent",
			directMessage: options?.directMessage ? "true" : "",
			availableContexts:
				options?.contextCatalog?.notice ??
				formatAvailableContextsForPrompt(availableContexts),
			handleResponseToolName: HANDLE_RESPONSE_TOOL_NAME,
		},
		template: baseline,
	}).trim();
	const renderedWithVoiceRules = options?.voiceDirectMessage
		? [rendered, "", "voice engagement rules:", VOICE_ENGAGEMENT_RULES].join(
				"\n",
			)
		: rendered;
	const renderedWithSharedRules = [
		renderedWithVoiceRules,
		"",
		"## Shared Response Quality Rules",
		`- ${CODE_SNIPPET_VALIDITY_INSTRUCTION}`,
	].join("\n");
	if (!options?.responseHandlerFields?.trim()) {
		return renderedWithSharedRules;
	}
	return [
		renderedWithSharedRules,
		"",
		"## Response Handler Fields",
		"Populate every registered field. Use empty value when not applicable.",
		options.responseHandlerFields.trim(),
	].join("\n");
}

export function renderMessageHandlerModelInput(
	runtime: OptimizedPromptRuntimeLike & Pick<IAgentRuntime, "character">,
	context: ContextObject,
	availableContexts: readonly ContextDefinition[] = [],
	options?: {
		directMessage?: boolean;
		voiceDirectMessage?: boolean;
		groupTriage?: boolean;
		responseHandlerFields?: string;
		contextCatalog?: ContextCatalogReference;
		history?: HistoryDiscovery;
	},
): {
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const rendered = renderContextObject(context);
	const completionSources = options?.voiceDirectMessage
		? undefined
		: completionContextSources(context);
	const completionSourceIds = new Map(
		completionSources?.sources.map(({ id, event }) => [event.id, id]),
	);
	const directText =
		options?.directMessage &&
		!options.voiceDirectMessage &&
		!options.groupTriage;
	const history =
		directText &&
		options.history?.sourceSetId === completionSources?.sourceSetId
			? options.history
			: undefined;
	const instructions = renderMessageHandlerInstructions(
		runtime,
		availableContexts,
		options,
	);
	const stableSegments = rendered.promptSegments.filter(
		(segment) => segment.stable,
	);
	const dynamicSegments = rendered.promptSegments.filter(
		(segment) => !segment.stable,
	);
	const currentTurnBoundary = dynamicSegments
		.filter((segment) => segment.id === "current-turn-boundary")
		.map((segment) =>
			history
				? {
						...segment,
						content: buildCurrentTurnBoundary({
							hasMemoryRecallSurface: false,
							hasOriginalReferences: true,
						}),
					}
				: segment,
		);
	const remainingDynamicSegments = dynamicSegments.filter(
		(segment) => segment.id !== "current-turn-boundary",
	);
	const priorDialogueSegments = labelHistorySources(
		remainingDynamicSegments.filter(
			(segment) =>
				segment.label?.startsWith("prior_message:") === true &&
				(!history ||
					!segment.id ||
					!completionSourceIds.has(segment.id) ||
					history.visibleEventIds.has(segment.id)),
		),
		completionSourceIds,
	);
	const dynamicProviderSegments = remainingDynamicSegments.filter(
		(segment) => segment.label?.startsWith("provider:") === true,
	);
	// This fresh, authorized catalog often stays identical across turns. Put its
	// complete text before changing dialogue/providers for prefix-cache reuse,
	// without marking it stable or reusing any previous authorization decision.
	const actionCatalogSegments = directText
		? remainingDynamicSegments.filter(
				(segment) =>
					segment.id === "available-actions" &&
					segment.label === "available_actions",
			)
		: [];
	const turnTailSegments = remainingDynamicSegments.filter(
		(segment) =>
			segment.label?.startsWith("prior_message:") !== true &&
			segment.label?.startsWith("provider:") !== true &&
			!actionCatalogSegments.includes(segment),
	);
	// The boundary follows untrusted dialogue so stored messages cannot supersede
	// it with structural-looking text. Providers remain adjacent after that
	// boundary, preserving their reusable prefix before the current message.
	const orderedDynamicSegments = [
		...actionCatalogSegments,
		...(directText
			? shortenHistoryRoleLabels(priorDialogueSegments, completionSourceIds)
			: priorDialogueSegments),
		...currentTurnBoundary,
		...(completionSources?.sources.length
			? [
					{
						content: `completion_source_set: ${completionSources.sourceSetId}\nThe [hN] labels above belong to this source set. Return completionContext according to history_source_selection.${historyReferenceNotice(context, history)}`,
						stable: false,
					},
				]
			: []),
		...dynamicProviderSegments,
		...(options?.contextCatalog?.loaded
			? [
					{
						id: "context-catalog-read",
						content: `context_loaded: ${CONTEXT_CATALOG_REFERENCE}\nThe complete requested reference follows; do not request it again.\n${options.contextCatalog.text}`,
						stable: false,
					},
				]
			: []),
		...loadedHistorySegments(
			context,
			history,
			history?.loadedSourceIds.size
				? new Set(
						priorDialogueSegments.flatMap((segment) =>
							segment.id ? [segment.id] : [],
						),
					)
				: undefined,
		),
		...turnTailSegments,
	];
	const stableWireSegments = [
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
		...(completionSources?.sources.length
			? [
					{
						content: history
							? REVIEWED_HISTORY_SELECTION_INSTRUCTIONS
							: COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
						stable: true,
					},
				]
			: []),
	];
	const promptSegments = normalizePromptSegments([
		...stableWireSegments,
		...orderedDynamicSegments,
	]);
	// `normalizePromptSegments` embeds separators in segment content for cache
	// consumers that concatenate the array. Render message blocks from the raw
	// segments so those separators remain between labeled blocks instead of
	// becoming extra whitespace inside a block's content.
	const systemContent = stableWireSegments.map(segmentBlock).join("\n\n");
	const userContent = orderedDynamicSegments.map(segmentBlock).join("\n\n");
	return {
		messages: [
			{ role: "system", content: systemContent },
			{ role: "user", content: userContent },
		],
		promptSegments,
	};
}

/**
 * Render only the *stable* part of the Stage-1 (`HANDLE_RESPONSE`) model
 * input for a given room — the system prompt + tool/action schema block +
 * every segment context-assembly marks stable (rendered for the agent's own
 * OWNER-role sender, the single-owner voice device, with the action
 * discovery catalog composed through the same gates as the live render) +
 * the stable provider blocks. This is the prefix that does NOT depend on
 * the user's turn, so it is the exact text the local-inference KV cache
 * should be pre-warmed with the instant a voice session opens or VAD
 * detects speech onset (item I1/C1 of the voice swarm).
 *
 * The returned string is byte-identical to the `messages[0].content`
 * (the "system" message) that `renderMessageHandlerModelInput` would
 * produce for the first turn of a fresh conversation in that room — the
 * unstable tail (recent dialogue, the current user message) is dropped.
 * Pre-warming with this string lands the system prefix in the slot's KV
 * so the real request only forward-passes the user tokens.
 *
 * Best-effort by construction: composing state may hit providers that
 * query the DB; a synthetic empty message is used so a brand-new room
 * with no history still renders. Callers that fail to render should just
 * skip the pre-warm (the real request cold-prefills, which is the
 * pre-pre-warm behaviour).
 */
export async function renderMessageHandlerStablePrefix(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<string> {
	const syntheticMessage: Memory = {
		id: asUUID(v4()),
		entityId: (runtime.agentId ?? asUUID(v4())) as UUID,
		agentId: runtime.agentId,
		roomId,
		createdAt: Date.now(),
		content: {
			text: "",
			source: "voice-prewarm",
			channelType: ChannelType.VOICE_DM,
		},
	};
	const senderRole = await resolveStage1SenderRole(runtime, syntheticMessage);
	const availableContexts = listAvailableContextsForRole(
		runtime.contexts,
		senderRole,
	);
	const state = await composeResponseState(runtime, syntheticMessage, true);
	const context = await createV5MessageContextObject({
		runtime,
		message: syntheticMessage,
		state,
		// The pre-warm composes the action discovery catalog through the same
		// gates as the live Stage-1 render (context-assembly.ts) so whichever
		// segments that render marks stable stay byte-identical to the live
		// prefix; a catalog it marks dynamic is filtered out below like any
		// other per-turn segment.
		includeActionDiscovery: true,
		userRoles: [senderRole],
		availableContexts,
		extraProviderExclusions: ambientTurnProviderExclusions(
			runtime,
			syntheticMessage,
		),
		// Per-turn exclusions so the stable-prefix render is owned by the same
		// gate as every live render; the synthetic VOICE_DM message classifies
		// as addressed, so today this resolves to the static set.
	});
	const rendered = renderContextObject(context);
	const stableSegments = rendered.promptSegments.filter(
		(segment) => segment.stable,
	);
	const instructions = renderMessageHandlerInstructions(
		runtime,
		availableContexts,
		{ directMessage: true },
	);
	return [
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
	]
		.map(segmentBlock)
		.join("\n\n");
}
