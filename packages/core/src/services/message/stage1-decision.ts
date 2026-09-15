/** Builds the complete Stage 1 request, performs bounded empty-output retries, and validates the response decision. Registers diagnostic persistence with the outer turn before handing control to routing and planning. */

import {
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../../actions/to-tool";
import { recordInferenceSpan, timeInferenceSpan } from "../../inference-timing";
import { getCandidateActionBackstopRules } from "../../runtime/candidate-action-backstop";
import { withRequiredCompletionSourceIdentity } from "../../runtime/completion-context";
import { computePrefixHashes, hashString } from "../../runtime/context-hash";
import { getUserMessageText } from "../../utils/message-text";
import { getMessageHandlerReply } from "../../runtime/message-handler";
import {
	buildModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "../../runtime/model-input-budget";
import { cacheProviderOptions } from "../../runtime/planner-loop";
import {
	buildResponseGrammar,
	buildSpanSamplerPlan,
	withGuidedDecodeProviderOptions,
} from "../../runtime/response-grammar";
import type {
	ResponseHandlerFieldContext,
	ResponseHandlerFieldRunResult,
	ResponseHandlerSenderRole,
} from "../../runtime/response-handler-field-evaluator";
import type { TrajectoryRecorder } from "../../runtime/trajectory-recorder";
import { sanitizeUserVisibleModelOutput } from "../../runtime/user-visible-model-output";
import { getStreamingContext } from "../../streaming-context";
import type { MessageHandlerResult } from "../../types/components";
import type { GenerateTextResult } from "../../types/model";
import { ModelType } from "../../types/model";
import { ChannelType } from "../../types/primitives";
import { getEvaluatorProgressState } from "../evaluator-progress.ts";
import { HISTORY_RETENTION_EVALUATOR } from "../history-retention.ts";
import { CODING_SUB_AGENT_CONTEXTS } from "./action-surface.js";
import {
	listAvailableContextsForRole,
	resolveStage1SenderRole,
} from "./addressing.js";
import { createV5MessageContextObject } from "./context-assembly.js";
import {
	projectDiscoverableContext,
	withAvailableContextRequests,
} from "./context-discovery.js";
import {
	getActionInferenceMessageText,
	isSubAgentCompletionArtifact,
	resolveContinuationInferenceMessageText,
} from "./dialogue-context.js";
import {
	canRepairIncompleteHistorySelection,
	HISTORY_REFERENCE_PREFIX,
	type HistoryDiscovery,
	historyReferences,
	loadHistoryReferences,
	projectReviewedHistory,
	readHistoryContextRequests,
	requestedHistory,
	withReviewedHistorySelection,
} from "./history-discovery.js";
import { composeResponseState } from "./provider-state.js";
import {
	getStage1FinishReason,
	stage1HitCompletionLimit,
	synthesizeStage1CompletionLimitReply,
} from "./stage1-completion.js";
import {
	getStage1RetryReason,
	getStage1RoutingRepair,
	getStage1UnusableDecisionRepair,
	isEmptyStage1Result,
	parseMessageHandlerModelOutput,
	readStage1EmptyRetryLimit,
	shouldRetryStage1Generation,
	shouldUseStage1PlannerFallback,
	synthesizePlannerFallbackFromStage1Failure,
} from "./stage1-generation.js";
import {
	CONTEXT_CATALOG_REFERENCE,
	createContextCatalogReference,
	renderMessageHandlerModelInput,
} from "./stage1-input.js";
import {
	extractMessageHandlerRawParsed,
	messageHandlerFromFieldResult,
	normalizeRawParsedForFieldRegistry,
	reportRejectedUserVisibleModelOutput,
} from "./stage1-output.js";
import { recordMessageHandlerStage } from "./trajectory-stages.js";
import type { V5MessageRuntimeInput } from "./turn-input.js";

/**
 * Trusted host routing for a dedicated coding turn. This deliberately looks
 * like the canonical Stage 1 tool result so the existing parsing and safety
 * pipeline stays shared, but it is never recorded or accounted as a model
 * response. Authorization remains owned by the normal context/action gates.
 */
export function directCodingResponseHandlerResult(): GenerateTextResult {
	return {
		text: "",
		toolCalls: [
			{
				id: "direct-coding-route",
				name: HANDLE_RESPONSE_TOOL_NAME,
				arguments: {
					shouldRespond: "RESPOND",
					contexts: [...CODING_SUB_AGENT_CONTEXTS],
					intents: [],
					replyText: "",
					replyEffectStatus: "none",
					candidateActionNames: [],
					facts: [],
					relationships: [],
					topics: [],
					addressedTo: [],
					emotion: "none",
				},
			},
		],
		finishReason: "tool_calls",
	};
}

export async function generateStage1Decision(
	args: V5MessageRuntimeInput,
	{
		senderRole,
		context,
		availableContexts,
		directMessageChannel,
		stage1PreprocessStartedAt,
		recorder,
		trajectoryId,
	}: {
		senderRole: Awaited<ReturnType<typeof resolveStage1SenderRole>>;
		context: Awaited<ReturnType<typeof createV5MessageContextObject>>;
		availableContexts: ReturnType<typeof listAvailableContextsForRole>;
		directMessageChannel: boolean;
		stage1PreprocessStartedAt: number;
		recorder: TrajectoryRecorder | undefined;
		trajectoryId: ReturnType<TrajectoryRecorder["startTrajectory"]> | undefined;
	},
	registerStageTask: (task: Promise<void>) => void,
) {
	const voiceDirectMessageChannel =
		args.message.content?.channelType === ChannelType.VOICE_DM;
	const messageHandlerStartedAt = Date.now();
	const stage1TurnSignal =
		getStreamingContext()?.abortSignal ?? new AbortController().signal;

	const responseHandlerFieldContext: ResponseHandlerFieldContext = {
		runtime: args.runtime,
		message: args.message,
		state: args.state,
		senderRole: senderRole as ResponseHandlerSenderRole,
		turnSignal: stage1TurnSignal,
	};
	const selectedResponseHandlerFields =
		args.runtime.responseHandlerFieldRegistry.list();
	let responseHandlerFieldPrompt =
		await args.runtime.responseHandlerFieldRegistry.composePromptSlices(
			responseHandlerFieldContext,
		);
	const responseHandlerSchema =
		args.runtime.responseHandlerFieldRegistry.composeSchema();
	const loadedContext = new Set<string>();
	const discoveryEnabled =
		directMessageChannel && !voiceDirectMessageChannel && !args.codingMode;
	let history: HistoryDiscovery | undefined;
	if (
		discoveryEnabled &&
		args.runtime.evaluators?.some(
			(evaluator) => evaluator.name === HISTORY_RETENTION_EVALUATOR,
		) &&
		!args.runtime.providers?.some((provider) =>
			provider.name.startsWith(HISTORY_REFERENCE_PREFIX),
		)
	) {
		const started = performance.now();
		try {
			const checkpoint = await getEvaluatorProgressState(
				args.runtime,
				args.message,
				HISTORY_RETENTION_EVALUATOR,
			);
			history = projectReviewedHistory(
				context,
				{
					agentId: args.runtime.agentId,
					roomId: args.message.roomId,
					entityId: args.message.entityId,
					roles: [senderRole],
				},
				checkpoint,
			);
		} catch (error) {
			// error-policy:J4 Report the optional index failure and render complete
			// original history instead; no unavailable source is treated as absent.
			args.runtime.reportError("MessageService.historyRetention", error, {
				roomId: args.message.roomId,
			});
		}
		recordInferenceSpan(
			"message:history-checkpoint",
			performance.now() - started,
			{
				applied: !!history,
				retainedSourceCount: history?.visibleEventIds.size ?? 0,
			},
		);
	}
	// A plugin that owns this name retains its ordinary provider-reference
	// contract; framework catalog discovery must not shadow its requests.
	let contextCatalogRead = false;
	let contextCatalog =
		discoveryEnabled &&
		Array.isArray(args.runtime.providers) &&
		!args.runtime.providers.some(
			(provider) => provider.name === CONTEXT_CATALOG_REFERENCE,
		)
			? createContextCatalogReference(args.runtime, availableContexts)
			: undefined;
	let discovery = discoveryEnabled
		? projectDiscoverableContext(context, args.state, loadedContext)
		: { context, available: new Set<string>() };
	if (contextCatalog) discovery.available.add(CONTEXT_CATALOG_REFERENCE);
	for (const reference of historyReferences(context, history))
		discovery.available.add(reference);
	let messageHandlerInput = renderMessageHandlerModelInput(
		args.runtime,
		discovery.context,
		availableContexts,
		{
			directMessage: directMessageChannel,
			voiceDirectMessage: voiceDirectMessageChannel,
			responseHandlerFields: responseHandlerFieldPrompt.rendered,
			contextCatalog,
			history,
		},
	);
	let stage1PrefixHashes = computePrefixHashes(
		messageHandlerInput.promptSegments,
	);
	const stableStage1Segments = messageHandlerInput.promptSegments.filter(
		(segment) => segment.stable,
	);
	const stableStage1PrefixHashes = computePrefixHashes(stableStage1Segments);
	const stage1SystemContent =
		typeof messageHandlerInput.messages[0]?.content === "string"
			? messageHandlerInput.messages[0].content
			: "";
	let stage1PrefixHash =
		stableStage1PrefixHashes[stableStage1PrefixHashes.length - 1]?.hash ??
		hashString(`stage1:${stage1SystemContent}`);
	const createMessageHandlerTools = () => {
		const referenceSchema =
			discoveryEnabled && !history
				? withAvailableContextRequests(
						responseHandlerSchema,
						discovery.available,
					)
				: responseHandlerSchema;
		return [
			createHandleResponseTool({
				directMessage: directMessageChannel,
				parameters: voiceDirectMessageChannel
					? referenceSchema
					: withRequiredCompletionSourceIdentity(
							history
								? withReviewedHistorySelection(referenceSchema)
								: referenceSchema,
							discovery.context,
						),
				description:
					"Stage 1: populate registered response-handler fields once before action tools. Empty values for non-applicable fields.",
			}),
		];
	};
	let messageHandlerTools = createMessageHandlerTools();
	// Keep shared-room agents and pipeline stages on separate cache slots, and
	// keep this slot's identity across the discovery re-render: a read or
	// repair continues the same scoped workflow even as its input expands.
	const stage1ConversationId = args.message.roomId
		? JSON.stringify([args.runtime.agentId, args.message.roomId, "stage1"])
		: undefined;
	const messageHandlerProviderOptions = withModelInputBudgetProviderOptions(
		cacheProviderOptions({
			prefixHash: stage1PrefixHash,
			segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
			promptSegments: messageHandlerInput.promptSegments,
			conversationId: stage1ConversationId,
		}),
		buildModelInputBudget({
			messages: messageHandlerInput.messages,
			promptSegments: messageHandlerInput.promptSegments,
			tools: messageHandlerTools,
		}),
	);

	if (!args.codingMode) {
		// RESPONSE_HANDLER_BEFORE (blocking): hooks fire right before the Stage 1
		// model call. A direct coding turn has no such model boundary.
		await timeInferenceSpan(
			"actions:response-handler-before",
			() =>
				args.runtime.runActionsByMode(
					"RESPONSE_HANDLER_BEFORE",
					args.message,
					args.state,
				),
			{ mode: "RESPONSE_HANDLER_BEFORE" },
		);

		// RESPONSE_HANDLER_DURING runs only alongside a real handler model call.
		const responseHandlerDuring = args.runtime
			.runActionsByMode("RESPONSE_HANDLER_DURING", args.message, args.state)
			.catch((err) =>
				args.runtime.reportError("MessageService.runActionsByMode", err, {
					mode: "RESPONSE_HANDLER_DURING",
				}),
			);
		if (args.runTerminalOwner) {
			args.runTerminalOwner.adopt(
				"RESPONSE_HANDLER_DURING",
				responseHandlerDuring,
			);
		} else {
			void responseHandlerDuring;
		}
	}

	// Per-turn structure forcing. `buildResponseGrammar` composes the
	// HANDLE_RESPONSE envelope skeleton (fixed key order + the `contexts`
	// element enum from the available context ids + any registered Stage-1
	// field evaluators, single-value enums collapsed to literals) and a
	// precise GBNF grammar. The local llama-server engine (W4) constrains the
	// envelope with it so the model never spends tokens on the scaffold; the
	// prompt text stays byte-stable, only the grammar varies per turn. Cloud
	// adapters ignore `responseSkeleton` / `grammar` — `tools` carries the
	// equivalent (unforced) contract for them.
	const responseGrammar = buildResponseGrammar(
		{
			actions: args.runtime.actions ?? [],
			responseHandlerFields: selectedResponseHandlerFields,
			responseHandlerFieldSignature:
				args.runtime.responseHandlerFieldRegistry?.composeSchemaSignature(),
		},
		{
			contexts: availableContexts.map((definition) => String(definition.id)),
			channelType:
				typeof args.message.content?.channelType === "string"
					? args.message.content.channelType
					: undefined,
		},
	);

	// Per-span argmax sampling for the structured envelope: every enum,
	// number, and boolean span gets temperature=0 / topK=1 so the model
	// never randomly tips a decision (shouldRespond, requiresTool, …) that
	// has a clear argmax winner. Free-string spans (replyText, thought)
	// keep the call-level temperature. Engines that don’t honor per-span
	// sampling ignore the field (grammar still constrains the tokens).
	const stage1SpanSamplerPlan = buildSpanSamplerPlan(
		responseGrammar.responseSkeleton,
	);
	const stage1ProviderOptions = withGuidedDecodeProviderOptions(
		messageHandlerProviderOptions,
	);
	stage1ProviderOptions.eliza = {
		...((stage1ProviderOptions as { eliza?: Record<string, unknown> }).eliza ??
			{}),
		thinking: "off",
	};
	let stage1ModelParams = {
		messages: messageHandlerInput.messages,
		promptSegments: messageHandlerInput.promptSegments,
		tools: messageHandlerTools,
		toolChoice: "required" as const,
		// Stage 1 packs the complete structured response and user-visible answer
		// into one generation on every channel. Let the adapter use the selected
		// provider/model maximum; an application-level ceiling can only turn a
		// valid long answer into an incomplete envelope.
		maxTokens: undefined,
		omitMaxTokens: true,
		// Streamed structured generation: the local engine (W4) streams the
		// HANDLE_RESPONSE envelope and parses it incrementally so `shouldRespond`
		// / `contexts` route the moment they are known. User-visible `replyText`
		// remains buffered until routing and effect validation complete. Cloud
		// adapters ignore the flag and return the result whole.
		streamStructured: true,
		// This is the only Stage 1 field intended for the user. Local voice
		// consumes the validated replyText field; planner/evaluator calls leave
		// this unset and therefore cannot leak their structured output to TTS.
		voiceOutput: "user-visible" as const,
		responseSkeleton: responseGrammar.responseSkeleton,
		grammar: responseGrammar.grammar,
		spanSamplerPlan: stage1SpanSamplerPlan,
		signal: stage1TurnSignal,
		// Guided structured decode on by default for Stage 1 (the call always
		// carries a forced skeleton): the local engine derives the
		// deterministic-token prefill plan and the fork fast-forwards the
		// forced scaffold spans. Opt out with `ELIZA_LOCAL_GUIDED_DECODE=0`.
		// Cloud adapters ignore `providerOptions.eliza.guidedDecode`.
		providerOptions: stage1ProviderOptions,
	};
	// Provider-shape retry: cloud reasoning models reached over
	// OpenAI-compatible providers can intermittently return either no
	// content at all or a required native tool call with no arguments. Both
	// shapes have no recoverable Stage 1 payload, so retry a small bounded
	// number of times before falling back to the planner.
	const stage1RetryLimit = readStage1EmptyRetryLimit(args.runtime);
	let stage1RetryCount = 0;
	if (!args.codingMode) {
		recordInferenceSpan(
			"message:stage1:preprocess",
			performance.now() - stage1PreprocessStartedAt,
		);
	} else {
		args.runtime.logger.debug?.(
			{ src: "service:message", codingMode: true },
			"Skipping Stage 1 model call for direct coding loop",
		);
	}
	let rawMessageHandler: string | GenerateTextResult = args.codingMode
		? directCodingResponseHandlerResult()
		: ((await args.runtime.useModel(
				ModelType.RESPONSE_HANDLER,
				stage1ModelParams,
			)) as string | GenerateTextResult);
	let stage1RetryReason = getStage1RetryReason(rawMessageHandler);
	while (
		!args.codingMode &&
		stage1RetryCount < stage1RetryLimit &&
		shouldRetryStage1Generation(
			stage1RetryReason,
			rawMessageHandler,
			stage1ModelParams.maxTokens,
		)
	) {
		stage1RetryCount += 1;
		args.runtime.logger?.warn?.(
			{
				src: "service:message",
				attempt: stage1RetryCount + 1,
				maxAttempts: stage1RetryLimit + 1,
				reason: stage1RetryReason,
			},
			`[message] Stage 1 returned ${stage1RetryReason} — retrying (${stage1RetryCount}/${stage1RetryLimit})`,
		);
		rawMessageHandler = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			stage1ModelParams,
		)) as string | GenerateTextResult;
		stage1RetryReason = getStage1RetryReason(rawMessageHandler);
	}
	// A parseable decision that ends an addressed turn without an answer gets
	// one repaired re-ask on every channel (the discovery loop below is direct
	// text only). An unusable re-ask keeps the original decision so the
	// deferral contract (#11504) is unchanged.
	// Voice keeps its complete path: its spoken answer need not sit in replyText.
	if (!args.codingMode && !voiceDirectMessageChannel) {
		const unusableRepair = getStage1UnusableDecisionRepair(
			extractMessageHandlerRawParsed(rawMessageHandler),
			getUserMessageText(args.message),
		);
		if (
			unusableRepair &&
			shouldUseStage1PlannerFallback(args.runtime, args.message)
		) {
			args.runtime.logger?.warn?.(
				{ src: "service:message", roomId: args.message.roomId },
				"[message] Stage 1 ended an addressed turn without an answer — one repaired re-ask",
			);
			const repairedInput = {
				...messageHandlerInput,
				messages: [
					...messageHandlerInput.messages,
					{ role: "user" as const, content: unusableRepair },
				],
				promptSegments: [
					...messageHandlerInput.promptSegments,
					{ content: unusableRepair, stable: false },
				],
			};
			const repairedHashes = computePrefixHashes(repairedInput.promptSegments);
			const repairedCacheOptions = cacheProviderOptions({
				prefixHash: stage1PrefixHash,
				segmentHashes: repairedHashes.map((entry) => entry.segmentHash),
				promptSegments: repairedInput.promptSegments,
				conversationId: stage1ConversationId,
			});
			stage1TurnSignal.throwIfAborted();
			const repaired = (await args.runtime.useModel(
				ModelType.RESPONSE_HANDLER,
				{
					...stage1ModelParams,
					messages: repairedInput.messages,
					promptSegments: repairedInput.promptSegments,
					providerOptions: withModelInputBudgetProviderOptions(
						{
							...stage1ProviderOptions,
							...repairedCacheOptions,
							eliza: {
								...(stage1ProviderOptions.eliza as object),
								...(repairedCacheOptions.eliza as object),
							},
						},
						buildModelInputBudget({
							messages: repairedInput.messages,
							promptSegments: repairedInput.promptSegments,
							tools: messageHandlerTools,
						}),
					),
				},
			)) as string | GenerateTextResult;
			if (extractMessageHandlerRawParsed(repaired)) {
				rawMessageHandler = repaired;
			}
		}
	}
	// A context request is an incomplete decision. Recompose through the same
	// permission/disclosure gates before another model call, and never dispatch
	// its draft, extraction fields, or action candidates. Each provider can be
	// expanded once; there is no action-planner loop for reading provider text.
	let routingRepairAttempted = false;
	while (discoveryEnabled) {
		const parsedDecision = extractMessageHandlerRawParsed(rawMessageHandler);
		const explicit = readHistoryContextRequests(
			context,
			history,
			parsedDecision,
			discovery.available,
		);
		const historyRequested = requestedHistory(
			context,
			history,
			parsedDecision,
			explicit,
		);
		const requested = [...new Set([...explicit, ...historyRequested])];
		const routingRepair =
			!routingRepairAttempted &&
			explicit.length === 0 &&
			(requested.length === 0 ||
				canRepairIncompleteHistorySelection(context, history, parsedDecision))
				? getStage1RoutingRepair(parsedDecision)
				: undefined;
		if (requested.length === 0 && !routingRepair) break;
		stage1TurnSignal.throwIfAborted();
		if (routingRepair) {
			// One correction before field processors/effects. If it remains
			// contradictory, normal pending-intent guards still own routing.
			routingRepairAttempted = true;
			messageHandlerInput = {
				...messageHandlerInput,
				messages: [
					...messageHandlerInput.messages,
					{ role: "user", content: routingRepair },
				],
				promptSegments: [
					...messageHandlerInput.promptSegments,
					{
						content: routingRepair,
						stable: false,
					},
				],
			};
		} else {
			const contextReadStartedAt = performance.now();
			for (const name of requested) {
				if (history && name.startsWith(HISTORY_REFERENCE_PREFIX)) continue;
				if (name === CONTEXT_CATALOG_REFERENCE && contextCatalog) {
					contextCatalogRead = true;
					contextCatalog.loaded = true;
				} else loadedContext.add(name);
			}
			if (contextCatalog?.loaded) {
				// Re-read role-filtered definitions for this read. Never restore an
				// old catalog after the requester's role or registrations changed.
				const role = await resolveStage1SenderRole(args.runtime, args.message);
				const current = listAvailableContextsForRole(
					args.runtime.contexts,
					role,
				);
				const refreshedCatalog = createContextCatalogReference(
					args.runtime,
					current,
				);
				if (refreshedCatalog) {
					contextCatalog = { ...refreshedCatalog, loaded: true };
				} else {
					// A small/currently empty catalog or an optimized prompt needs no
					// deferred representation. Render its complete current definitions.
					contextCatalog = undefined;
				}
				availableContexts = current;
			}
			const refreshed = await composeResponseState(
				args.runtime,
				args.message,
				true,
			);
			Object.assign(args.state, refreshed);
			if (history) {
				const currentRole = await resolveStage1SenderRole(
					args.runtime,
					args.message,
				);
				if (currentRole !== senderRole) {
					senderRole = currentRole;
					availableContexts = listAvailableContextsForRole(
						args.runtime.contexts,
						currentRole,
					);
					responseHandlerFieldPrompt =
						await args.runtime.responseHandlerFieldRegistry.composePromptSlices(
							{
								...responseHandlerFieldContext,
								senderRole: currentRole as ResponseHandlerSenderRole,
							},
						);
					if (contextCatalog) {
						const freshCatalog = createContextCatalogReference(
							args.runtime,
							availableContexts,
						);
						contextCatalog = freshCatalog
							? { ...freshCatalog, loaded: contextCatalog.loaded }
							: undefined;
					}
				}
				if (
					history.scope.roles.length !== 1 ||
					history.scope.roles[0] !== currentRole ||
					args.runtime.providers?.some((provider) =>
						provider.name.startsWith(HISTORY_REFERENCE_PREFIX),
					)
				)
					history = undefined;
			}
			const refreshedRole = await resolveStage1SenderRole(
				args.runtime,
				args.message,
			);
			const refreshedContext = await createV5MessageContextObject({
				...args,
				includeActionDiscovery: discoveryEnabled ? "index" : true,
				userRoles: [refreshedRole],
				availableContexts,
			});
			Object.assign(context, refreshedContext, { id: context.id });
			if (history)
				history = loadHistoryReferences(context, history, historyRequested);
			discovery = projectDiscoverableContext(
				context,
				args.state,
				loadedContext,
			);
			if (contextCatalog && !contextCatalog.loaded)
				discovery.available.add(CONTEXT_CATALOG_REFERENCE);
			for (const reference of historyReferences(context, history))
				discovery.available.add(reference);
			if (historyRequested.length)
				recordInferenceSpan(
					"message:history-reference-read",
					performance.now() - contextReadStartedAt,
					{
						requestedCount: historyRequested.length,
						fullRestoration: !history,
					},
				);
			messageHandlerInput = renderMessageHandlerModelInput(
				args.runtime,
				discovery.context,
				availableContexts,
				{
					directMessage: directMessageChannel,
					voiceDirectMessage: voiceDirectMessageChannel,
					responseHandlerFields: responseHandlerFieldPrompt.rendered,
					contextCatalog,
					history,
				},
			);
		}
		stage1PrefixHashes = computePrefixHashes(
			messageHandlerInput.promptSegments,
		);
		const stableHashes = computePrefixHashes(
			messageHandlerInput.promptSegments.filter((segment) => segment.stable),
		);
		stage1PrefixHash =
			stableHashes.at(-1)?.hash ?? hashString("context-discovery");
		const expandedCacheOptions = cacheProviderOptions({
			prefixHash: stage1PrefixHash,
			segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
			promptSegments: messageHandlerInput.promptSegments,
			conversationId: stage1ConversationId,
		});
		// Full restoration returns to the ordinary selection contract. Keep the
		// actual tool schema aligned with the newly rendered history policy.
		messageHandlerTools = createMessageHandlerTools();
		stage1ModelParams = {
			...stage1ModelParams,
			tools: messageHandlerTools,
			messages: messageHandlerInput.messages,
			promptSegments: messageHandlerInput.promptSegments,
			providerOptions: withModelInputBudgetProviderOptions(
				{
					...stage1ProviderOptions,
					...expandedCacheOptions,
					eliza: {
						...(stage1ProviderOptions.eliza as object),
						...(expandedCacheOptions.eliza as object),
					},
				},
				buildModelInputBudget({
					messages: messageHandlerInput.messages,
					promptSegments: messageHandlerInput.promptSegments,
					tools: messageHandlerTools,
				}),
			),
		};
		args.runtime.logger.debug(
			{ providers: requested, routingRepair: Boolean(routingRepair) },
			"[message] Resolving context or routing before final response decision",
		);
		stage1TurnSignal.throwIfAborted();
		rawMessageHandler = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			stage1ModelParams,
		)) as string | GenerateTextResult;
	}
	const messageHandlerEndedAt = Date.now();
	// Capture the provider that served the Stage-1 (RESPONSE_HANDLER) call
	// right after it completes, before any later model call could overwrite the
	// runtime-wide last-resolved-provider, so the recorded stage names the real
	// provider instead of the fabricated "default" literal (#13623).
	const messageHandlerProvider = args.codingMode
		? undefined
		: args.runtime.getLastResolvedModelProvider?.(ModelType.RESPONSE_HANDLER);
	const rawFieldParsed = extractMessageHandlerRawParsed(rawMessageHandler);
	// An explicit continuation turn ("finish my request", "that is good")
	// carries no inferable intent of its own, so candidate inference runs on
	// the nearest pending prior user request instead. The substitution feeds
	// only routing heuristics — prompts keep the literal user text.
	const continuationResolvedMessageText =
		resolveContinuationInferenceMessageText(
			args.runtime,
			args.message,
			args.state,
		);
	const inferenceMessageText =
		continuationResolvedMessageText ??
		getActionInferenceMessageText(args.message);
	if (continuationResolvedMessageText) {
		args.runtime.logger?.debug?.(
			{ src: "service:message" },
			"[message] continuation turn resolved to prior user request for candidate inference",
		);
	}
	let fieldRunResult: ResponseHandlerFieldRunResult | null = null;
	let messageHandler: MessageHandlerResult | null = null;
	if (rawFieldParsed) {
		const normalizedRawParsed =
			normalizeRawParsedForFieldRegistry(rawFieldParsed);
		fieldRunResult = await timeInferenceSpan(
			"evaluators:response-handler-fields",
			() =>
				args.runtime.responseHandlerFieldRegistry.dispatch({
					rawParsed: normalizedRawParsed,
					runtime: args.runtime,
					message: args.message,
					state: args.state,
					senderRole: senderRole as ResponseHandlerSenderRole,
					turnSignal: stage1TurnSignal,
				}),
		);
		messageHandler = messageHandlerFromFieldResult(
			{
				...fieldRunResult.parsed,
				// Registry defaults are not an explicit model no-effect decision.
				// Keep missing/malformed statuses conservative without discarding
				// pending or applied statuses produced by field evaluators.
				replyEffectStatus:
					fieldRunResult.parsed.replyEffectStatus === "none" &&
					!(
						typeof normalizedRawParsed.replyEffectStatus === "string" &&
						normalizedRawParsed.replyEffectStatus.trim().toLowerCase() ===
							"none"
					)
						? undefined
						: fieldRunResult.parsed.replyEffectStatus,
			},
			fieldRunResult,
			{
				actions: args.runtime.actions,
				messageText: inferenceMessageText,
				candidateBackstopRules: getCandidateActionBackstopRules(args.runtime),
				subAgentCompletionRelay: isSubAgentCompletionArtifact(args.message),
			},
		);
	}
	if (!messageHandler) {
		messageHandler = parseMessageHandlerModelOutput(rawMessageHandler, {
			actions: args.runtime.actions,
			messageText: inferenceMessageText,
			subAgentCompletionRelay: isSubAgentCompletionArtifact(args.message),
		});
	}
	const stage1CompletionLimitHit = stage1HitCompletionLimit(
		rawMessageHandler,
		stage1ModelParams.maxTokens,
	);
	if (stage1CompletionLimitHit) {
		args.runtime.logger?.warn?.(
			{
				src: "service:message",
				finishReason: getStage1FinishReason(rawMessageHandler),
				usage:
					typeof rawMessageHandler === "string"
						? undefined
						: rawMessageHandler.usage,
				maxTokens: stage1ModelParams.maxTokens,
				recovered: Boolean(messageHandler),
			},
			"[message] Stage 1 hit the completion-token limit",
		);
	}
	if (stage1CompletionLimitHit) {
		messageHandler = synthesizeStage1CompletionLimitReply();
	}
	if (
		!messageHandler &&
		shouldUseStage1PlannerFallback(args.runtime, args.message)
	) {
		const stage1FailureKind = getStage1RetryReason(rawMessageHandler);
		const stage1FailureReason =
			stage1FailureKind === "empty completion"
				? `empty output after ${stage1RetryLimit + 1} attempts`
				: stage1FailureKind === "malformed HANDLE_RESPONSE tool call"
					? `malformed HANDLE_RESPONSE tool call after ${stage1RetryLimit + 1} attempts`
					: "unparseable output";
		messageHandler = synthesizePlannerFallbackFromStage1Failure({
			reason: stage1FailureReason,
			actions: args.runtime.actions,
			messageText: inferenceMessageText,
		});
		args.runtime.logger?.warn?.(
			{
				src: "service:message",
				reason: stage1FailureReason,
			},
			"[message] Stage 1 did not produce a valid handler result; falling back to planner for explicitly addressed message",
		);
	}

	// RESPONSE_HANDLER_AFTER (blocking): hooks fire after Stage 1 returns and the
	// routing decision is parsed, but before the runtime acts on it.
	// Lets a hook inspect / mutate the parsed plan.
	if (!args.codingMode) {
		await timeInferenceSpan(
			"actions:response-handler-after",
			() =>
				args.runtime.runActionsByMode(
					"RESPONSE_HANDLER_AFTER",
					args.message,
					args.state,
				),
			{ mode: "RESPONSE_HANDLER_AFTER" },
		);
	}

	if (!messageHandler) {
		if (isEmptyStage1Result(rawMessageHandler)) {
			throw new Error(
				`v5 messageHandler returned empty Stage 1 result after ${stage1RetryLimit + 1} attempts`,
			);
		}
		throw new Error("v5 messageHandler returned invalid MessageHandlerResult");
	}
	const stageOneVisibleReply = sanitizeUserVisibleModelOutput(
		getMessageHandlerReply(messageHandler),
	);
	if (stageOneVisibleReply.kind === "text") {
		messageHandler.plan.reply = stageOneVisibleReply.text;
	} else {
		messageHandler.plan.reply = "";
		if (stageOneVisibleReply.kind !== "empty") {
			// error-policy:J3 Stage 1 is an untrusted model boundary. A
			// control/invalid reply becomes an observable invalid signal,
			// never a string that a direct or early-reply channel can send.
			reportRejectedUserVisibleModelOutput({
				runtime: args.runtime,
				scope: "MessageService.runV5MessageRuntimeStage1",
				code: "STAGE1_INVALID_USER_VISIBLE_OUTPUT",
				message:
					"Stage-1 model placed control data in the user-visible reply field",
				stage: "response-handler",
				output: stageOneVisibleReply,
			});
		}
	}
	const parsedResponseHandlerReply = getMessageHandlerReply(messageHandler);
	args.onStage1Decision?.({
		...(trajectoryId ? { trajectoryId } : {}),
		provider: messageHandlerProvider,
		prefixHash: stage1PrefixHash,
		decision: messageHandler.processMessage,
		// Evaluators may patch the live handler later. Preserve the exact model
		// boundary value observed here instead of exposing a mutable alias.
		parsed: structuredClone(messageHandler),
	});

	if (!args.codingMode && recorder && trajectoryId) {
		registerStageTask(
			recordMessageHandlerStage({
				recorder,
				trajectoryId,
				messages: messageHandlerInput.messages,
				tools: messageHandlerTools,
				toolChoice: "required",
				providerOptions: stage1ModelParams.providerOptions,
				raw: rawMessageHandler,
				parsed: messageHandler,
				startedAt: messageHandlerStartedAt,
				endedAt: messageHandlerEndedAt,
				segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
				prefixHash: stage1PrefixHash,
				provider: messageHandlerProvider,
				state: args.state,
				runtime: args.runtime,
			}),
		);
	}

	return {
		messageHandler,
		providerDiscoveryEnabled: discoveryEnabled,
		loadedContextProviders: [...loadedContext],
		contextCatalogRead,
		fieldRunResult,
		inferenceMessageText,
		parsedResponseHandlerReply,
		messageHandlerEndedAt,
	};
}
