/** Coordinates Stage 1 decisions, planner execution, visible reply resolution, and ordered trajectory finalization for a message turn. */

import { TurnAbortedError } from "../../runtime/turn-controller";
import { getStreamingContext } from "../../streaming-context";
import { isObjectRecord as isRecord } from "../../utils/type-guards";
import { generateStage1Decision } from "./stage1-decision.js";

export { directCodingResponseHandlerResult } from "./stage1-decision.js";

import { finalizePlannerReply } from "./planner-reply.js";
import type { V5MessageRuntimeInput } from "./turn-input.js";

export type { V5MessageRuntimeInput } from "./turn-input.js";

import { ElizaError } from "../../errors";
import { runShouldRespondInjectionGate } from "../../features/trust/should-respond-risk-gate";
import { timeInferenceSpan } from "../../inference-timing";
import { canActionRun } from "../../runtime/action-gate";
import { parentAliasesForCandidateAction } from "../../runtime/action-retrieval";
import {
	applyAddressedTo,
	messageAddressedToOtherParticipant,
	messageVocativelyAddressesOtherParticipant,
} from "../../runtime/addressed-to";
import {
	applyCodingActionProfile,
	parseCodingActionProfile,
} from "../../runtime/coding-action-profile";
import { appendContextEvent } from "../../runtime/context-object";
import { type EvaluatorEffects, runEvaluator } from "../../runtime/evaluator";
import {
	type FactsAndRelationshipsRunResult,
	runFactsAndRelationshipsStage,
} from "../../runtime/facts-and-relationships";
import { getLocalizedExamplesProvider } from "../../runtime/localized-examples-provider";
import {
	getMessageHandlerReply,
	routeMessageHandlerOutput,
} from "../../runtime/message-handler";
import {
	type PlannerLoopResult,
	type PlannerRuntime,
	type PlannerToolCall,
	type PlannerToolResult,
	PROGRESS_ONLY_ANSWER_REJECT,
	runPlannerLoop,
} from "../../runtime/planner-loop";
import {
	extractReplyTextFromTranscript,
	looksLikeRawFieldTranscript,
} from "../../runtime/response-field-transcript";
import { runResponseHandlerEvaluators } from "../../runtime/response-handler-evaluators";
import {
	captureToolStageIO,
	createJsonFileTrajectoryRecorder,
	finalizeTrajectoryRecording,
	isTrajectoryRecordingEnabled,
	type RecordedStage,
	type TrajectoryRecorder,
} from "../../runtime/trajectory-recorder";
import { withSemanticStageFanOut } from "../../runtime/trajectory-semantic-stage-sink";
import { getTrajectoryContext } from "../../trajectory-context";
import type {
	Action,
	HandlerCallback,
	MessageHandlerResult,
} from "../../types/components";
import type { ContextEvent } from "../../types/context-object";
import type { GenerateTextParams } from "../../types/model";
import type { JsonValue } from "../../types/primitives";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	attachAvailableContexts,
	CONTEXT_ROUTING_STATE_KEY,
} from "../../utils/context-routing";
import { getUserMessageText } from "../../utils/message-text";
import { isProviderContextOverflowFailure } from "../../utils/model-errors";
import { readEnv } from "../../utils/read-env";
import { ChannelTopicsService } from "../channel-topics";
import {
	buildRuntimeActionLookup,
	resolveRuntimeAction,
} from "./action-identifiers.js";
import {
	buildV5PlannerActionSurface,
	CODING_SUB_AGENT_CONTEXTS,
	collectV5PlannerCandidateActions,
	getMessageHandlerCandidateActions,
	getMessageHandlerParentActionHints,
	privacyDenialReplyForReasons,
	stringArrayProperty,
} from "./action-surface.js";
import {
	isAmbientStage1Turn,
	isStage1AmbientHardGated,
	listAvailableContextsForRole,
	messageChallengesPriorAgentReply,
	messageContinuesAfterRecentAgentCorrection,
	messageExplicitlyAddressesAgent,
	resolveStage1ReplyGateMode,
	resolveStage1SenderRole,
} from "./addressing.js";
import { createV5MessageContextObject } from "./context-assembly.js";
import type { V5MessageRuntimeStage1Result } from "./contracts.js";
import { withoutIntermediateVisibleText } from "./delivery.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	evaluatePlannedReplyEgress,
	resolvePlannedReplyEgress,
} from "./egress-policy.js";
import {
	buildV5ExecutorContext,
	collectPlannerTools,
	collectPreviousActionResults,
	executeV5PlannedToolCall,
} from "./planned-tool.js";
import {
	ambientTurnProviderExclusions,
	isBenchmarkForcingToolCall,
	isOwnerLifeManagementToolCandidate,
	isTextScoredBenchmarkTurn,
	selectV5PlannerStateProviderNames,
} from "./provider-state.js";
import {
	createV5ReplyStrategyResult,
	deliveredTextsCoverReply,
	normalizeVisibleTextForDuplicateCheck,
	preservedSettledToolResult,
	replyNamesStructuredEffectDestination,
	restorePiiInUserReplyText,
	structuredEffectFromToolResult,
	trackSettledPlannerToolResult,
} from "./reply-policy.js";
import {
	isTerseReplyWorthKeeping,
	isUnusableStage1Reply,
} from "./reply-quality.js";
import {
	withActionResultsForPrompt,
	withContextRoutingValues,
} from "./response-state.js";
import {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	filterSelectedContextsForRole,
} from "./stage1-evaluators.js";
import { exposedActionMatches } from "./stage1-output.js";
import {
	inferDirectCurrentRequestCandidateInference,
	uniqueActionNames,
} from "./stage1-reply-policy.js";
import { subAgentCompletionRelayBody } from "./task-completion-relay.js";
import { recordFactsAndRelationshipsStage } from "./trajectory-stages.js";
import { detachPostDeliverySideEffect } from "./turn-session.js";

/**
 * Whether the routed action owns the response-handler's pre-planner reply.
 * A deterministic call is already selected, while relevance candidates are
 * only safe to trust when they all resolve to the same canonical action.
 */
export function actionOwnsResponseHandlerEarlyReply(
	runtime: Pick<IAgentRuntime, "actions">,
	messageHandler: MessageHandlerResult,
): boolean {
	const actionLookup = buildRuntimeActionLookup(runtime);
	const deterministicToolCall = messageHandler.plan.deterministicToolCall;
	if (deterministicToolCall) {
		return (
			resolveRuntimeAction(actionLookup, deterministicToolCall.name)
				?.suppressEarlyReply === true
		);
	}

	const candidateNames = messageHandler.plan.candidateActions ?? [];
	if (candidateNames.length === 0) return false;

	const resolvedCandidates = new Map<string, Action>();
	for (const name of candidateNames) {
		if (typeof name !== "string" || !name.trim()) return false;
		const action = resolveRuntimeAction(actionLookup, name);
		if (!action) return false;
		resolvedCandidates.set(normalizeActionIdentifier(action.name), action);
	}

	if (resolvedCandidates.size !== 1) return false;
	return resolvedCandidates.values().next().value?.suppressEarlyReply === true;
}

export async function runV5MessageRuntimeStage1(
	args: V5MessageRuntimeInput,
): Promise<V5MessageRuntimeStage1Result> {
	const codingActionProfile = parseCodingActionProfile(
		args.codingActionProfile,
	);
	if (codingActionProfile && args.codingMode !== true) {
		throw new ElizaError(
			"Coding action profile requires codingMode to be enabled",
			{
				code: "CODING_ACTION_PROFILE_REQUIRES_CODING_MODE",
				context: { kind: codingActionProfile.kind },
			},
		);
	}
	const senderRole =
		getTrajectoryContext()?.userRole ??
		(await resolveStage1SenderRole(args.runtime, args.message));
	const availableContexts = listAvailableContextsForRole(
		args.runtime.contexts,
		senderRole,
	);
	const directMessageChannel =
		args.message.content?.channelType === ChannelType.DM ||
		args.message.content?.channelType === ChannelType.VOICE_DM ||
		args.message.content?.channelType === ChannelType.API ||
		args.message.content?.channelType === ChannelType.SELF;
	// Ambient turn = a positively-identified unaddressed text-group turn
	// (structural classifier only — channel type + addressing + source
	// metadata, never message text; anything uncertain fails open to
	// addressed). Classified before the Stage-1 context is built so the
	// shouldRespond decision sees the ambient-turn policy too: without it an
	// ambient-mode group (every message forwarded, nobody addressing the agent)
	// got a reply to nearly every message — the Stage-1 field guidance alone
	// ("active in the conversation") reads as RESPOND. Also drives the planner's
	// ambient-turn policy instruction and the deliberate-silence terminal below.
	const peerCorrectionContinuation = messageContinuesAfterRecentAgentCorrection(
		args.runtime,
		args.message,
		args.state,
	);
	const ambientTurn = isAmbientStage1Turn(
		args.runtime,
		args.message,
		messageExplicitlyAddressesAgent(args.runtime, args.message) ||
			messageChallengesPriorAgentReply(
				args.runtime,
				args.message,
				args.state,
			) ||
			peerCorrectionContinuation,
	);
	const ambientHardGate =
		ambientTurn && isStage1AmbientHardGated(args.runtime, args.message);
	const context = await timeInferenceSpan("message:stage1:context", () =>
		createV5MessageContextObject({
			...args,
			includeActionDiscovery: true,
			userRoles: [senderRole],
			availableContexts,
			ambientTurn,
			ambientHardGate,
			peerCorrectionContinuation,
			extraProviderExclusions: ambientTurnProviderExclusions(
				args.runtime,
				args.message,
			),
			// Per-turn exclusions (not the static list): even if a cached compose
			// left RECENT_ERRORS in state, an unaddressed group turn must not
			// render internal diagnostics into its Stage-1 context.
		}),
	);
	const stage1PreprocessStartedAt = performance.now();

	// G10/G11: construct the per-trajectory recorder. No-op when disabled via
	// ELIZA_TRAJECTORY_RECORDING=0. Failures inside the recorder must NEVER
	// propagate up — the recorder is observability, not load-bearing.
	const recordingEnabled = isTrajectoryRecordingEnabled();
	// Every stage emitted below also mirrors into the turn's database
	// trajectory step (#17030) so the app viewer carries the same
	// Stage-1/planner/tool/evaluation semantics as the file trajectory.
	const recorder: TrajectoryRecorder | undefined = recordingEnabled
		? withSemanticStageFanOut(
				createJsonFileTrajectoryRecorder({
					logger: args.runtime.logger as {
						warn?: (context: unknown, message?: string) => void;
					},
					reportError: args.runtime.reportError.bind(args.runtime),
					// Final-persistence tool-diagnostic projection: the recorder always
					// runs the shared tool-shape pattern pass; this adds the runtime's
					// character-configured secret masking on top. Optional-bound because
					// lightweight/test runtimes may not implement redactSecrets — the
					// pattern pass must keep running for them.
					redactSecrets: args.runtime.redactSecrets?.bind(args.runtime),
				}),
				args.runtime,
			)
		: undefined;
	const trajectoryId = recorder
		? recorder.startTrajectory({
				agentId: String(args.runtime.agentId ?? "unknown-agent"),
				roomId: args.message.roomId ? String(args.message.roomId) : undefined,
				// Run/scenario correlation the aggregator joins on. The scenario CLI
				// sets these env vars before each scenario (packages/scenario-runner/
				// src/cli.ts); passing them here makes this call site the source of
				// truth so file-recorder trajectories carry the join keys without the
				// recorder inferring them from env buried in its persistence layer.
				runId: readEnv("ELIZA_LIFEOPS_RUN_ID"),
				scenarioId: readEnv("ELIZA_LIFEOPS_SCENARIO_ID"),
				// Root-turn correlation minted on the turn's trajectory context
				// (#13775). Threading it here makes the file trajectory join the DB
				// row and any spawned sub-agent trajectory on one traceId.
				traceId: getTrajectoryContext()?.traceId,
				...(codingActionProfile
					? {
							codingActionProfile: {
								kind: codingActionProfile.kind,
								includeWorktree: codingActionProfile.includeWorktree === true,
							},
						}
					: {}),
				rootMessage: {
					id: String(args.message.id ?? args.responseId),
					text: getUserMessageText(args.message) ?? "",
					sender: args.message.entityId
						? String(args.message.entityId)
						: undefined,
				},
			})
		: undefined;

	let endStatus: "finished" | "errored" = "finished";
	let factsTask: Promise<{
		startedAt: number;
		endedAt: number;
		result: FactsAndRelationshipsRunResult | null;
		error?: unknown;
	} | null> = Promise.resolve(null);
	let settledFactsOutcome: Awaited<typeof factsTask> | undefined;
	let messageHandlerStageTask: Promise<void> = Promise.resolve();
	try {
		const {
			messageHandler,
			fieldRunResult,
			inferenceMessageText,
			parsedResponseHandlerReply,
			messageHandlerEndedAt,
		} = await generateStage1Decision(
			args,
			{
				senderRole,
				context,
				availableContexts,
				directMessageChannel,
				stage1PreprocessStartedAt,
				recorder,
				trajectoryId,
			},
			(task) => {
				messageHandlerStageTask = task;
			},
		);

		if (messageHandler.processMessage === "RESPOND") {
			const injectionGate = await timeInferenceSpan(
				"evaluators:injection-risk-gate",
				() =>
					runShouldRespondInjectionGate({
						runtime: args.runtime,
						message: args.message,
						resolveSenderRole: () => senderRole,
					}),
			);
			if (injectionGate.blocked) {
				args.runtime.logger.warn(
					{
						src: "service:message",
						agentId: args.runtime.agentId,
						reason: injectionGate.reason,
						score: injectionGate.score,
					},
					"[ShouldRespondRiskGate] suppressing Stage 1 response before side effects or planner tools",
				);
				return {
					kind: "terminal",
					action: "IGNORE",
					messageHandler,
					state: args.state,
				};
			}
		}

		// Kick off the FACTS_AND_RELATIONSHIPS stage in parallel with whichever
		// Stage 2 path runs (simple reply or planner). This stage is purely a
		// side-effect: it dedups + persists user-stated facts/relationships
		// without blocking the user reply. A result that settles before terminal
		// trajectory persistence is recorded there; slower extraction remains a
		// tracked data task but cannot leave the completed turn marked running.
		if (
			!args.stage1DecisionOnly &&
			messageHandler.extract &&
			((messageHandler.extract.facts?.length ?? 0) > 0 ||
				(messageHandler.extract.relationships?.length ?? 0) > 0)
		) {
			const startedAt = Date.now();
			factsTask = runFactsAndRelationshipsStage({
				runtime: args.runtime,
				message: args.message,
				state: args.state,
				extract: messageHandler.extract,
			})
				.then((result) => ({ startedAt, endedAt: Date.now(), result }))
				.catch((error) => {
					// error-policy:J7 Facts persistence is detached from reply delivery;
					// its explicit failed outcome is recorded in the trajectory below.
					args.runtime.reportError(
						"MessageService.factsAndRelationships",
						error,
						{ roomId: args.message.roomId },
					);
					return { startedAt, endedAt: Date.now(), result: null, error };
				})
				.then((outcome) => {
					settledFactsOutcome = outcome;
					return outcome;
				});
			args.runTerminalOwner?.adopt("facts-and-relationships", factsTask);
		}

		// Persist `addressedTo` as relationship edges from the speaker to each
		// addressee. No LLM call: UUIDs pass through verbatim, names resolve
		// against the room's participants. Fire-and-forget like the facts task;
		// failures land in the logger but never block the reply.
		const addressedTo = messageHandler.extract?.addressedTo ?? [];
		if (!args.stage1DecisionOnly && addressedTo.length > 0) {
			const addressedToTask = applyAddressedTo({
				runtime: args.runtime,
				message: args.message,
				addressedTo,
			}).catch((error) => {
				// error-policy:J7 Relationship enrichment is a detached data write;
				// report failure while preserving the already-produced reply.
				args.runtime.reportError("MessageService.applyAddressedTo", error, {
					messageId: args.message.id,
				});
				args.runtime.logger?.warn?.(
					{
						err: error,
						messageId: args.message.id,
						addressedToCount: addressedTo.length,
					},
					"[message] applyAddressedTo failed",
				);
			});
			if (args.runTerminalOwner) {
				args.runTerminalOwner.adopt("apply-addressed-to", addressedToTask);
			} else {
				void addressedToTask;
			}
		}

		// Record Stage-1-extracted topics into the per-channel LRU. Pure
		// fire-and-forget side-effect (like facts/addressedTo): it persists the
		// room's running topic list for the CHANNEL_TOPICS provider and must
		// never block or break the turn.
		const topics = messageHandler.extract?.topics ?? [];
		if (!args.stage1DecisionOnly && topics.length > 0 && args.message.roomId) {
			const channelTopics = args.runtime.getService<ChannelTopicsService>(
				ChannelTopicsService.serviceType,
			);
			if (channelTopics) {
				const recordTopicsTask = channelTopics
					.recordTopics(args.message.roomId, topics)
					.catch((error) => {
						// error-policy:J7 Channel-topic state is detached enrichment; report
						// failed persistence without dropping the reply.
						args.runtime.reportError("MessageService.recordTopics", error, {
							roomId: args.message.roomId,
						});
						args.runtime.logger?.warn?.(
							{
								err: error,
								messageId: args.message.id,
								roomId: args.message.roomId,
								topicCount: topics.length,
							},
							"[message] recordTopics failed",
						);
					});
				if (args.runTerminalOwner) {
					args.runTerminalOwner.adopt(
						"record-channel-topics",
						recordTopicsTask,
					);
				} else {
					void recordTopicsTask;
				}
			}
		}

		// Stamp the turn's topics onto the inbound message memory so the dashboard
		// can group the transcript by topic + show a topic chips bar (#8928).
		// Additive, fire-and-forget metadata write — never blocks/breaks the turn.
		if (!args.stage1DecisionOnly && topics.length > 0 && args.message.id) {
			// args.message is always a message memory, so its metadata is
			// MessageMetadata; force `type: "message"` so the spread result is a
			// valid, discriminated MessageMetadata regardless of the inbound shape
			// (never a sibling union member with an unexpected `topics` field).
			const existingMetadata = args.message.metadata;
			const stampTopicsTask = args.runtime
				.updateMemory({
					id: args.message.id,
					metadata: {
						...(existingMetadata ?? {}),
						type: "message" as const,
						topics,
					},
				})
				.catch((error) => {
					// error-policy:J7 Transcript topic metadata is detached enrichment;
					// report a failed stamp without changing message delivery.
					args.runtime.reportError("MessageService.stampTopics", error, {
						messageId: args.message.id,
					});
					args.runtime.logger?.warn?.(
						{ err: error, messageId: args.message.id },
						"[message] stamp message topics failed",
					);
				});
			if (args.runTerminalOwner) {
				args.runTerminalOwner.adopt("stamp-message-topics", stampTopicsTask);
			} else {
				void stampTopicsTask;
			}
		}

		// Response-handler evaluators may promote a simple turn to planning and
		// clobber a COMPLETE stage-0 answer with an "On it." ack (observed live:
		// stage-0 held the full contributors answer; the promotion flailed through
		// NOTIFY and the turn ended answerless). Preserve the pre-patch reply so
		// the planner loop's answer rescue and the answerless-final fallback can
		// still deliver it.
		const candidateGateDiagnostics = {
			disclosureRejectedExplicitCandidates: [] as string[],
			disclosureRejectedReasons: [] as string[],
			nonDisclosureRejectedExplicitCandidates: [] as string[],
		};
		const prePatchStageOneReply =
			messageHandler.plan.replyEffectStatus !== "pending" &&
			typeof messageHandler.plan.reply === "string" &&
			messageHandler.plan.reply.trim().length > 0
				? messageHandler.plan.reply
				: undefined;
		const prePatchStageOneReplyEffectStatus =
			messageHandler.plan.replyEffectStatus;
		const prePatchStageOneReplyIsUngroundedAppliedClaim =
			prePatchStageOneReplyEffectStatus === "applied";
		const responseHandlerEvaluation = args.codingMode
			? {
					activeEvaluators: [],
					appliedPatches: [],
					candidateActionsAddedByEvaluators: [],
					candidateActionsClearedByEvaluators: false,
					errors: [],
				}
			: fieldRunResult?.preempt
				? {
						activeEvaluators: [],
						appliedPatches: [],
						candidateActionsAddedByEvaluators: [],
						candidateActionsClearedByEvaluators: false,
						errors: [],
					}
				: await timeInferenceSpan("evaluators:response-handler", () =>
						runResponseHandlerEvaluators({
							runtime: args.runtime,
							message: args.message,
							state: args.state,
							messageHandler,
							availableContexts,
							userRoles: [senderRole],
							evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS,
						}),
					);
		messageHandler.plan.contexts = filterSelectedContextsForRole(
			messageHandler.plan.contexts,
			availableContexts,
		);
		// Full engagement addressing gate (extends #9874 item 1 from tool
		// promotion to reply + planner + early-ack routing): when Stage 1 tagged
		// this turn as explicitly addressed to ANOTHER participant (not us), the
		// agent is overhearing — it must not reply, enter the planner, or
		// fabricate a tool task. Uniform, NOT bot-specific: it fires the same
		// for human and bot addressees (bot-ness is surfaced to the model as
		// transcript context, not handled here). Undirected banter
		// (addressedTo: []) never gates, so chatty agents still interject per
		// their character. Eligibility is bounded by the canonical `ambientTurn`
		// classifier: only positively identified unaddressed text-group traffic
		// can be suppressed. Direct/API/self turns, client chat, autonomous and
		// sub-agent traffic, explicit mentions/replies/names, and unknown channel
		// types all fail open. The sender's effective personality reply_gate also
		// provides a deliberate opt-out when it is explicitly "always".
		//
		// Fail OPEN on any resolution error (DB hiccup in getEntitiesForRoom): a
		// transient failure must NOT convert a normal turn into silence — it
		// just means "don't suppress", matching the conservative contract and
		// the fire-and-forget addressee handling above.
		// Candidate suppression first (corroborated Stage-1 tag, or — when the
		// tag is empty — the structural vocative check: a message that OPENS by
		// addressing another participant by name, "hey eliza", is evidence the
		// gate verifies itself, closing the fail-open interjection path, live
		// 2026-08-22). The personality reply_gate override is consulted LAST and
		// only on a positive, so turns with no gating signal never pay the
		// personality-store lookup.
		const suppressionCandidate = ambientTurn
			? await (addressedTo.length > 0
					? messageAddressedToOtherParticipant({
							runtime: args.runtime,
							message: args.message,
							addressedTo,
						})
					: messageVocativelyAddressesOtherParticipant({
							runtime: args.runtime,
							message: args.message,
						})
				).catch((error) => {
					// error-policy:J7 addressee-resolution diagnostics must not kill
					// the message loop or suppress a response, but the required runtime
					// error stream still owns the failure.
					args.runtime.reportError("MessageService.resolveAddressees", error, {
						roomId: args.message.roomId,
					});
					return false;
				})
			: false;
		const addressedToOtherParticipant =
			suppressionCandidate &&
			resolveStage1ReplyGateMode(args.runtime, args.message) !== "always";
		if (addressedToOtherParticipant) {
			// warn, not debug: this gate converts a turn into TOTAL silence, and a
			// silent non-delivery must be diagnosable from the server log (live
			// 2026-08-22: four suppressed replies left zero log evidence).
			args.runtime.logger?.warn?.(
				{
					src: "service:message",
					roomId: args.message.roomId,
					addressedTo,
				},
				"[message] Turn addressed to another participant — engagement gate ignores it",
			);
		}
		const route = routeMessageHandlerOutput(messageHandler, {
			addressedToOtherParticipant,
			messageText: getUserMessageText(args.message) ?? "",
		});
		if (args.stage1DecisionOnly) {
			return {
				kind: "decision",
				action:
					route.type === "ignored"
						? "IGNORE"
						: route.type === "stopped"
							? "STOP"
							: "RESPOND",
				messageHandler,
				state: args.state,
			};
		}
		if (route.type === "ignored" || route.type === "stopped") {
			return {
				kind: "terminal",
				action: route.type === "stopped" ? "STOP" : "IGNORE",
				messageHandler,
				state: args.state,
			};
		}

		// Past this point the Stage-1 model has committed this turn to a
		// response (final reply or planning). Surface the per-message decision
		// so a later runtime failure can qualify for a visible failure reply
		// instead of the unaddressed-turn suppression — evaluator-demoted
		// IGNOREs and the injection-gate return above never reach this.
		args.onStage1RespondDecision?.();

		if (route.type === "final_reply") {
			// The simple-context reply IS the answer: Stage 1 emits `replyText` (→
			// `route.reply`) inline as part of the required HANDLE_RESPONSE envelope,
			// uncapped for direct channels. There is no separate fast-path model
			// call. When that text is unusable — empty, or a known low-quality
			// scaffold/fragment from strict-JSON generation — ship a clear deferral
			// instead of a blank/garbled bubble, but keep a valid-but-terse answer
			// (e.g. "144" to a math question).
			let reply = route.reply;
			// Voice-gate provenance (#14873): `route.reply` is the Stage-1
			// RESPONSE_HANDLER model's own composed reply — already genuine agent
			// voice — so it must skip the last-mile re-voice pass. Only the
			// hardcoded deferral substitutions below reset this to false; they are
			// templates the gate still owns.
			let replyIsModelVoice = true;
			// Fail-closed guard (#11712): never ship the raw HANDLE_RESPONSE field
			// transcript to a user channel. If the reply still carries the
			// `shouldRespond:/replyText:/...` skeleton (a parse fell through
			// somewhere upstream), extract the intended replyText value; if that
			// can't be recovered, drop it and let the unusable-reply deferral below
			// take over. Cheap: line scan only, no full parse on the common path.
			// Replies that merely QUOTE a transcript — prose preamble before the
			// first field line, or field lines inside a code fence (the agent
			// diagnosing a transcript the user pasted) — are exempt: the detector
			// fires only when the skeleton IS the reply, so a legitimate diagnosis
			// is never rewritten down to its quoted replyText tail.
			if (looksLikeRawFieldTranscript(reply)) {
				const recovered = extractReplyTextFromTranscript(reply);
				args.runtime.logger?.warn?.(
					{
						src: "service:message",
						agentId: args.runtime.agentId,
						recovered: recovered !== null,
					},
					"[message] Blocked raw response-handler field transcript at send boundary; extracting replyText",
				);
				// Fail closed: never send the raw transcript. When extraction cannot
				// recover a reply, blank it so the unusable-reply guard below owns
				// the failure path (already logged above).
				reply = recovered !== null ? recovered : "";
			}
			if (
				isUnusableStage1Reply(reply) &&
				!isTerseReplyWorthKeeping({
					reply,
					messageText: getUserMessageText(args.message),
				})
			) {
				reply = "I'm not sure how to answer that.";
				replyIsModelVoice = false;
			}
			const directReplyEgressDecision = evaluatePlannedReplyEgress({
				providers: args.state.data.providers,
				request: args.message.content.text,
				reply,
				actionResults: [],
				actions: args.runtime.actions,
			});
			if (directReplyEgressDecision.verdict === "reject") {
				reply = (
					await resolvePlannedReplyEgress({
						providers: args.state.data.providers,
						runtime: args.runtime,
						message: args.message,
						reply,
						actionResults: [],
					})
				).text;
				replyIsModelVoice = true;
			}
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					text: reply,
					thought: messageHandler.thought,
					agentVoiced: replyIsModelVoice,
				}),
			};
		}

		const selectedContexts =
			route.type === "planning_needed" ? route.contexts : [];
		// Merge direct-request candidate inference before the early-ack gate so
		// the async-handoff check below sees the turn's full candidate set. An
		// evaluator that cleared Stage-1 candidates has already established an
		// authoritative route from richer runtime state, so the generic text
		// heuristic must not undo that decision.
		const directPlannerInference = inferDirectCurrentRequestCandidateInference(
			args.runtime.actions ?? [],
			inferenceMessageText ?? "",
		);
		const directPlannerCandidateActions = directPlannerInference.names;
		if (
			directPlannerCandidateActions.length > 0 &&
			!responseHandlerEvaluation.candidateActionsClearedByEvaluators
		) {
			messageHandler.plan.candidateActions =
				directPlannerInference.kind === "owner-reads"
					? directPlannerCandidateActions
					: uniqueActionNames([
							...getMessageHandlerCandidateActions(messageHandler),
							...directPlannerCandidateActions,
						]);
		}
		const routedResponseHandlerReply = getMessageHandlerReply(messageHandler);
		let earlyReplyText = actionOwnsResponseHandlerEarlyReply(
			args.runtime,
			messageHandler,
		)
			? ""
			: routedResponseHandlerReply || parsedResponseHandlerReply;
		// `replyEffectStatus: applied` is the model's prediction, not an effect
		// receipt. Keep it buffered until the planner either produces a verified
		// action result or returns the terminal failure; otherwise the client sees a
		// fabricated success flash immediately before the real outcome replaces it.
		if (prePatchStageOneReplyIsUngroundedAppliedClaim) {
			earlyReplyText = "";
		}
		const onResponseHandlerEarlyReply = args.onResponseHandlerEarlyReply;
		if (earlyReplyText.length > 0 && onResponseHandlerEarlyReply) {
			const earlyReplyEgressDecision = evaluatePlannedReplyEgress({
				providers: args.state.data.providers,
				request: args.message.content.text,
				reply: earlyReplyText,
				actionResults: [],
				actions: args.runtime.actions,
			});
			if (earlyReplyEgressDecision.verdict === "reject") {
				// Planning is still in progress, so an ungrounded completion claim
				// cannot ship. Drop the early reply entirely — the delivery floor
				// must not manufacture a substitute ack; the planner's final reply
				// (or the final-path ack fallback) owns this turn's delivery.
				earlyReplyText = "";
			}
		}
		// The addressing gate above already terminal-routes addressed-to-other
		// turns to ignored, so a gated turn cannot normally reach this planning
		// path — but the early ack ships user-visible text BEFORE the planner,
		// so it is re-checked here as defense in depth: no ack may leak from a
		// gated turn regardless of how routing evolves upstream.
		const earlyReplyEligible =
			!addressedToOtherParticipant &&
			messageHandler.processMessage === "RESPOND" &&
			earlyReplyText.length > 0 &&
			typeof onResponseHandlerEarlyReply === "function";
		let earlyReplySent = false;
		if (
			earlyReplyEligible &&
			typeof onResponseHandlerEarlyReply === "function"
		) {
			// The consumer owns the final delivery decision (the voice fast path
			// gates on async-handoff candidates); an explicit `false` means it
			// dropped the event, so downstream dedupe/rescue bookkeeping must
			// treat the turn as having no delivered early reply.
			const delivered = await onResponseHandlerEarlyReply({
				text: restorePiiInUserReplyText(earlyReplyText),
				messageHandler,
			});
			earlyReplySent = delivered !== false;
		}
		// A deterministic tool call skips the planner entirely, so the planner
		// provider recompose (~600ms of planner-only providers) buys nothing the
		// executor or the structured-effect confirmation reads — Stage-1 state is
		// the executor state for that path.
		const plannerProviderNames = selectV5PlannerStateProviderNames({
			runtime: args.runtime,
			message: args.message,
			selectedContexts,
			userRoles: [senderRole],
		});
		const recomposedPlannerState =
			typeof args.runtime.composeState === "function" &&
			!messageHandler.plan.deterministicToolCall
				? // Reuse what the Stage-1 compose already ran for this message;
					// refresh RECENT_MESSAGES only when an early reply actually
					// changed history. An empty refresh set means maximum reuse;
					// planner-only context-gated providers still run because they
					// are not cached yet.
					await args.runtime.composeState(
						args.message,
						plannerProviderNames,
						true,
						false,
						earlyReplySent ? ["RECENT_MESSAGES"] : [],
					)
				: args.state;
		const selectedContextRoutingState =
			selectedContexts.length > 0
				? {
						[CONTEXT_ROUTING_STATE_KEY]: {
							primaryContext: selectedContexts[0],
							secondaryContexts: selectedContexts.slice(1),
						},
					}
				: undefined;
		const plannerState = withContextRoutingValues(
			attachAvailableContexts(recomposedPlannerState, args.runtime),
			selectedContextRoutingState,
		);
		if (args.codingMode === true) {
			plannerState.data = {
				...(plannerState.data ?? {}),
				// Execution-mode provenance only; actions must never use this as an
				// authorization signal. Coding tools use it to skip chat-only command
				// rewrites that would alter an explicit repository command.
				elizaTrustedCodingMode: true,
			};
		}
		// A focused coding turn receives every action whose ordinary execution gates
		// pass for the coding contexts unless its trusted host selected an explicit
		// per-turn profile. Generic coding mode keeps the complete authorized surface.
		const useFullSurface = args.codingMode === true;
		const authorizedCodingActions = useFullSurface
			? (args.runtime.actions ?? []).filter((action) =>
					// The execution gates are the authority for a focused coding turn.
					// Absent an explicit profile, names cannot form a second fixed allowlist
					// that silently hides newly registered coding capabilities.
					canActionRun(action, {
						activeContexts: CODING_SUB_AGENT_CONTEXTS,
						userRoles: [senderRole],
						// There is no concrete turn message in this static surface build;
						// execution still enforces the private gate.
						skipPrivateGate: true,
					}),
				)
			: undefined;
		const plannerCandidateActions = authorizedCodingActions
			? applyCodingActionProfile(authorizedCodingActions, codingActionProfile)
			: await collectV5PlannerCandidateActions({
					runtime: args.runtime,
					message: args.message,
					state: plannerState,
					selectedContexts,
					candidateActions: getMessageHandlerCandidateActions(messageHandler),
					userRoles: [senderRole],
					diagnostics: candidateGateDiagnostics,
				});
		// Surface-privacy short-circuit: stage-1 named a capability that EXISTS
		// but its owner-exclusive disclosure gate rejected this destination, and
		// no named candidate survived into the collected set. Planning anyway
		// hands the model an unrelated retrieval surface and
		// it improvises around the missing capability — observed live on the
		// Discord group channel: a "todos" ask got a WEB_SEARCH surface and
		// shipped a fabricated "todo added" with zero writes, and a todos READ
		// answered a false empty from the orchestrator task store. Answer with an
		// honest surface denial instead. The phrasing confirms nothing about the
		// data — only that the disclosure boundary rejected this requester or
		// destination. Role, context, and autonomy denials keep the ordinary
		// planner path because they do not prove a privacy denial.
		const collectedCandidateNames = new Set(
			plannerCandidateActions.map((action) =>
				normalizeActionIdentifier(action.name),
			),
		);
		const stageOneCandidateLookup = buildRuntimeActionLookup(args.runtime);
		// Resolve candidates exactly the way collection does — direct name/simile
		// first, then the shared parent-alias map. Collection admits an aliased
		// action (Stage-1's invented "SEARCH" → WEB_SEARCH) but a direct-only
		// check here reads that same candidate as resolving to nothing, counts
		// the turn as "no survivors", and the privacy denial fires on a turn
		// whose web capability is sitting in the collected set (observed live:
		// group "search the web … within my budget" — the possessive-budget
		// heuristic's OWNER_FINANCES was rightly privacy-rejected, and the
		// denial swallowed a servable web search).
		const anyNamedStageOneCandidateSurvived = (
			getMessageHandlerCandidateActions(messageHandler) ?? []
		).some((name) => {
			const candidateName = String(name);
			const direct = resolveRuntimeAction(
				stageOneCandidateLookup,
				candidateName,
			);
			const resolvedSet = direct
				? [direct]
				: parentAliasesForCandidateAction(candidateName)
						.map((alias) =>
							resolveRuntimeAction(stageOneCandidateLookup, alias),
						)
						.filter((action): action is Action => action !== undefined);
			return resolvedSet.some((resolved) =>
				collectedCandidateNames.has(normalizeActionIdentifier(resolved.name)),
			);
		});
		// The privacy denial is only terminal when NO ungated sibling can serve
		// the ask. Reminders have one: the agent-level TRIGGER action claims
		// "remind me …" and legitimately works in group channels (observed live:
		// in-channel triggers created and fired there for months; the denial
		// regressed that the moment OWNER_REMINDERS got named as the candidate).
		// When the rejected candidates are reminder/alarm-shaped and TRIGGER
		// survived collection, let the turn plan — the trigger path serves it.
		const rejectedReminderish =
			candidateGateDiagnostics.disclosureRejectedExplicitCandidates.some(
				(name) => {
					const normalized = normalizeActionIdentifier(name);
					return (
						normalized.includes("REMINDER") || normalized.includes("ALARM")
					);
				},
			);
		const ungatedTriggerSiblingAvailable =
			rejectedReminderish && collectedCandidateNames.has("TRIGGER");
		// The privacy denial only proves an owner-exclusive disclosure boundary.
		// A MIXED rejection set — one candidate denied by disclosure AND another
		// explicit candidate denied by a role/context/private-action gate — is a
		// compound request whose non-disclosure limitation the planner/recovery
		// path must answer honestly. Short-circuit ONLY when the rejection set is
		// purely disclosure-based; any non-disclosure rejection stands the privacy
		// template down (#20679, refining #20660).
		const onlyDisclosureRejections =
			candidateGateDiagnostics.nonDisclosureRejectedExplicitCandidates
				.length === 0;
		if (
			candidateGateDiagnostics.disclosureRejectedExplicitCandidates.length >
				0 &&
			onlyDisclosureRejections &&
			!anyNamedStageOneCandidateSurvived &&
			!ungatedTriggerSiblingAvailable
		) {
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					text: privacyDenialReplyForReasons(
						candidateGateDiagnostics.disclosureRejectedReasons,
					),
					thought: messageHandler.thought,
					agentVoiced: false,
				}),
			};
		}
		const localizedExamplesProvider = getLocalizedExamplesProvider(
			args.runtime,
		);
		const localizedExamples = localizedExamplesProvider
			? await localizedExamplesProvider({
					recentMessage: getUserMessageText(args.message),
				})
			: null;
		// A deterministic tool call executes exactly one pre-selected action and
		// never dispatches the outer planner, so the planner surface (and the
		// context tool payload the sub-planner inherits) narrows to that action.
		// Without this, a wide keyword tier builds and re-estimates a
		// multi-hundred-K-token surface only to discard it (observed live:
		// deterministic calendar turns spent seconds on a ~590K-token build plus
		// overflow recovery and fed the CALENDAR sub-planner an 82K prompt).
		// An unresolvable selection falls back to the full surface unchanged;
		// the deterministic invoker below owns that failure path.
		const deterministicPlanSelection =
			messageHandler.plan.deterministicToolCall;
		const deterministicSurfaceAction = deterministicPlanSelection
			? resolveRuntimeAction(
					buildRuntimeActionLookup(args.runtime),
					deterministicPlanSelection.name,
				)
			: undefined;
		const actionSurface = buildV5PlannerActionSurface({
			actions: deterministicSurfaceAction
				? [deterministicSurfaceAction]
				: plannerCandidateActions,
			forceFullSurface: args.codingMode === true,
			codingActionProfile,
			message: args.message,
			state: plannerState,
			messageHandler,
			restrictToCandidateActions:
				responseHandlerEvaluation.candidateActionsClearedByEvaluators,
			selectedContexts,
			recorder,
			trajectoryId,
			logger: args.runtime.logger,
			reportError: args.runtime.reportError.bind(args.runtime),
			localizedExamples: localizedExamples ?? undefined,
		});
		const exposedPlannerActions = plannerCandidateActions.filter((action) =>
			actionSurface.exposedActionNames.has(
				normalizeActionIdentifier(action.name),
			),
		);
		args.runtime.logger.debug?.(
			{
				src: "service:message",
				actionSurface: actionSurface.summary,
			},
			"Built v5 planner action surface",
		);
		const plannerContext = await createV5MessageContextObject({
			...args,
			state: plannerState,
			selectedContexts,
			includeTools: true,
			userRoles: [senderRole],
			availableContexts,
			preselectedActions: exposedPlannerActions,
			actionSurface,
			ambientTurn,
			extraProviderExclusions: ambientTurnProviderExclusions(
				args.runtime,
				args.message,
			),
		});
		const responseHandlerContextSlices = stringArrayProperty(
			(messageHandler.plan as { contextSlices?: unknown }).contextSlices,
		);
		const plannerDecisionEvent: ContextEvent = {
			id: `message-handler:${messageHandlerEndedAt}`,
			type: "message_handler",
			source: "message-service",
			createdAt: messageHandlerEndedAt,
			...(responseHandlerContextSlices.length > 0
				? { content: responseHandlerContextSlices.join("\n\n") }
				: {}),
			metadata: {
				processMessage: messageHandler.processMessage,
				plan: {
					contexts: messageHandler.plan.contexts,
					replyEffectStatus: messageHandler.plan.replyEffectStatus ?? "none",
					intents: messageHandler.plan.intents ?? [],
					...(messageHandler.plan.requiresTool !== undefined
						? { requiresTool: messageHandler.plan.requiresTool }
						: {}),
					candidateActions: getMessageHandlerCandidateActions(messageHandler),
					parentActionHints: getMessageHandlerParentActionHints(messageHandler),
					...(responseHandlerContextSlices.length > 0
						? { contextSlices: responseHandlerContextSlices }
						: {}),
					...(messageHandler.plan.reply !== undefined
						? { reply: messageHandler.plan.reply }
						: {}),
					...(responseHandlerEvaluation.appliedPatches.length > 0
						? {
								responseHandlerPatches:
									responseHandlerEvaluation.appliedPatches.map((patch) => ({
										evaluatorName: patch.evaluatorName,
										changed: patch.changed,
										debug: patch.debug,
									})),
							}
						: {}),
					actionSurface: actionSurface.summary,
				} as JsonValue,
				thought: messageHandler.thought,
			},
		};
		const plannerContextWithDecision = appendContextEvent(
			plannerContext,
			plannerDecisionEvent,
		);
		const runtimeWithOptionalServices = args.runtime as typeof args.runtime & {
			getService?: (service: string) => unknown;
		};
		const plannerRuntime: PlannerRuntime = {
			getService: (service) =>
				typeof runtimeWithOptionalServices.getService === "function"
					? runtimeWithOptionalServices.getService(service)
					: null,
			useModel: (modelType, modelParams, provider) =>
				args.runtime.useModel(
					modelType,
					modelParams as GenerateTextParams,
					provider,
				),
			logger: args.runtime.logger as PlannerRuntime["logger"],
		};
		const plannerTools = collectPlannerTools(
			plannerContextWithDecision,
			undefined,
			{
				canonicalFamilies: true,
				candidateActions: getMessageHandlerCandidateActions(messageHandler),
			},
		);
		const budgetedPlannerContextWithDecision = plannerContextWithDecision;
		const plannerProviderAttributionState = plannerState;
		const benchmarkForcingToolCall = isBenchmarkForcingToolCall(args.message);
		// Only HARD-enforce a non-terminal tool when Stage 1 both flagged the turn
		// tool-required AND named at least one candidate action. A bare
		// `requiresTool=true` with NO named tool is the Stage-1 classifier
		// over-flagging pure-knowledge and sub-agent-relay turns (verified in the
		// 2026-06-21 deepscan): forcing then makes the planner either loop
		// re-emitting REPLY (rejected up to maxRequiredToolMisses times, answer
		// only via fallback) or run an irrelevant tool (VIEWS / TASKS_HISTORY) just
		// to satisfy the gate. When Stage 1 names no tool, plan with "auto" and
		// trust the planner — it still calls a tool when one genuinely fits and
		// answers directly when none does.
		// The named candidate must also RESOLVE against the tools actually
		// exposed to the planner this turn: an unresolvable hint (e.g. a
		// web/fetch-style hint on a runtime with no web action) cannot be
		// satisfied, so hard-enforcing it would only burn the required-tool
		// miss budget re-rejecting the planner's honest answer before the
		// exhaustion hatch ships it. The turn still plans — the planner
		// delivers the capability decline in one iteration. Candidates are
		// resolved through the runtime action lookup, not by name alone: Stage 1
		// routinely names a SIMILE of an exposed action (SPAWN_AGENT for TASKS),
		// and a name-only membership test would silently drop enforcement for a
		// tool that IS exposed (the exposedActionMatches doc records the live
		// ack-then-nothing regression that pattern causes).
		const plannerToolNames = new Set(
			plannerTools.map((tool) => normalizeActionIdentifier(tool.name)),
		);
		const stageOneActionLookup = buildRuntimeActionLookup(args.runtime);
		const plannerToolActions = plannerTools.flatMap(
			(tool) => resolveRuntimeAction(stageOneActionLookup, tool.name) ?? [],
		);
		const candidateResolvesToPlannerTool = (name: string): boolean => {
			const normalized = normalizeActionIdentifier(name);
			if (plannerToolNames.has(normalized)) return true;
			// Retrieval can replace an umbrella candidate (TASKS) with the precise
			// promoted child exposed this turn (TASKS_SPAWN_AGENT). Promoted children
			// deliberately carry the parent name as a simile, so resolve against the
			// ACTUAL planner surface before consulting the full runtime. Otherwise the
			// runtime lookup finds the exact parent, which is absent from plannerTools,
			// and incorrectly disables hard-tool enforcement even though its child is
			// exposed and runnable.
			if (exposedActionMatches(plannerToolActions, normalized)) return true;
			const resolved = resolveRuntimeAction(stageOneActionLookup, name);
			return (
				resolved !== undefined &&
				plannerToolNames.has(normalizeActionIdentifier(resolved.name))
			);
		};
		const stageOneNamedAToolForThisTurn =
			messageHandler.plan.requiresTool === true &&
			messageHandler.plan.candidateActions?.some((name) =>
				candidateResolvesToPlannerTool(String(name)),
			) === true;
		const stageOneNamedOwnerLifeManagementTool =
			stageOneNamedAToolForThisTurn &&
			Array.isArray(messageHandler.plan.candidateActions) &&
			messageHandler.plan.candidateActions.some(
				isOwnerLifeManagementToolCandidate,
			);
		const requireNonTerminalToolCall =
			(stageOneNamedAToolForThisTurn || benchmarkForcingToolCall) &&
			plannerTools.length > 0 &&
			(!isTextScoredBenchmarkTurn(args.message) ||
				stageOneNamedOwnerLifeManagementTool);
		const effectivePlannerContext = requireNonTerminalToolCall
			? appendContextEvent(budgetedPlannerContextWithDecision, {
					id: `tool-required:${messageHandlerEndedAt}`,
					type: "instruction",
					source: "message-service",
					createdAt: messageHandlerEndedAt,
					content: benchmarkForcingToolCall
						? "Benchmark harness mode: every turn must invoke a structured tool from the exposed action surface. " +
							"Do not answer with REPLY/RESPOND prose — the harness scores tool calls, not conversation. " +
							"Pick the single best non-terminal action (e.g. MESSAGE, CALENDAR, TODO) that can attempt the request and call it now."
						: "The Stage 1 router marked this current turn as requiring a tool. " +
							"prior_dialogue_policy: " +
							"Do not answer directly from memory, chat history, prior attachments, or prior tool output. " +
							"Call at least one exposed non-terminal tool that can attempt the current request.",
				})
			: budgetedPlannerContextWithDecision;
		const plannerContextAfterEarlyReply = earlyReplySent
			? appendContextEvent(effectivePlannerContext, {
					id: `early-reply:${messageHandlerEndedAt}`,
					type: "instruction",
					source: "message-service",
					createdAt: Date.now(),
					content:
						"The Stage 1 router already sent this visible reply to the user before planning: " +
						JSON.stringify(earlyReplyText) +
						". Do not repeat it. Send only additional follow-up text if the planner or tool work adds something new.",
				})
			: effectivePlannerContext;
		const evaluatorEffects: EvaluatorEffects = {
			copyToClipboard: () => undefined,
			messageToUser: () => undefined,
		};

		// CONTEXT_BEFORE (blocking): hooks tagged with one of the selected
		// contexts run after Stage 1 routes, before the planner loop begins.
		await timeInferenceSpan(
			"actions:context-before",
			() =>
				args.runtime.runActionsByMode(
					"CONTEXT_BEFORE",
					args.message,
					plannerState,
					{ selectedContexts },
				),
			{ mode: "CONTEXT_BEFORE" },
		);
		// CONTEXT_DURING (non-blocking): runs in parallel with the planner.
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a rejection escaping
		// runActionsByMode must not abort the planner, but it must surface.
		const contextDuring = args.runtime
			.runActionsByMode("CONTEXT_DURING", args.message, plannerState, {
				selectedContexts,
			})
			.catch((err) =>
				args.runtime.reportError("MessageService.runActionsByMode", err, {
					mode: "CONTEXT_DURING",
				}),
			);
		if (args.runTerminalOwner) {
			args.runTerminalOwner.adopt("CONTEXT_DURING", contextDuring);
		} else {
			void contextDuring;
		}

		// Track visible text an action already delivered to the user through the
		// callback during this planner run. The set is populated by the outer
		// instrumented callback after voice rewrite / verbosity shaping, so it
		// matches the string the connector actually sent.
		const deliveredVisibleTexts =
			args.deliveredVisibleTexts ?? new Set<string>();
		const recordingCallback: HandlerCallback | undefined = args.callback
			? async (content, ...rest) => args.callback?.(content, ...rest) ?? []
			: undefined;
		const intermediateCallback: HandlerCallback | undefined = recordingCallback
			? async (content, ...rest) => {
					const nonTextContent = withoutIntermediateVisibleText(content);
					return nonTextContent
						? recordingCallback(nonTextContent, ...rest)
						: [];
				}
			: undefined;

		// Settled planner tool results, in execution order, captured OUTSIDE the
		// loop so they survive a planner/evaluator crash. When the loop dies
		// after a tool already completed, the catch below can still deliver that
		// tool's user-facing text instead of the canned transient-failure reply
		// (observed live 2026-08-07/08: intermittent provider 400s on the
		// post-tool evaluator canned 26 turns whose tool had already succeeded).
		const settledPlannerToolResults: Array<{
			name: string;
			result: PlannerToolResult;
		}> = [];

		const invokeDeterministicToolCall =
			async (): Promise<PlannerLoopResult> => {
				const selected = messageHandler.plan.deterministicToolCall;
				if (!selected) {
					throw new Error(
						"Deterministic tool execution requires a selected call",
					);
				}
				const actionLookup = buildRuntimeActionLookup(args.runtime);
				const action = resolveRuntimeAction(actionLookup, selected.name);
				const toolCall: PlannerToolCall = {
					id: `response-handler:${normalizeActionIdentifier(action?.name ?? selected.name)}`,
					name: action?.name ?? selected.name,
					...(selected.params ? { params: selected.params } : {}),
				};
				const startedAt = Date.now();
				let callbackDelivered = false;
				const deterministicCallback: HandlerCallback | undefined =
					recordingCallback
						? async (...callbackArgs) => {
								callbackDelivered = true;
								return recordingCallback(...callbackArgs);
							}
						: undefined;
				let result: PlannerToolResult;
				try {
					result = trackSettledPlannerToolResult(
						settledPlannerToolResults,
						toolCall.name,
						await executeV5PlannedToolCall({
							runtime: args.runtime,
							toolCall,
							plannerContext: plannerContextAfterEarlyReply,
							executorCtx: buildV5ExecutorContext({
								message: args.message,
								state: plannerState,
								selectedContexts,
								senderRole,
								previousResults: [],
								...(deterministicCallback
									? { callback: deterministicCallback }
									: {}),
							}),
							plannerRuntime,
							executorOptions: {
								// The evaluator selected one exact action. Keep that single-action
								// surface while the canonical executor rechecks role, context,
								// private-action, argument, account, and validate gates.
								actions: action ? [action] : [],
								...(args.onSettledActionResult
									? { onSettledResult: args.onSettledActionResult }
									: {}),
							},
							evaluatorEffects,
							recorder,
							trajectoryId,
							plannerLoopConfig: args.plannerLoopConfig,
							activateActionContexts: false,
							announceDirectExecution: true,
						}),
					);
				} catch (error) {
					// error-policy:J1 Match the planner loop's tool boundary: a handler or
					// sub-planner throw becomes one explicit failed result for the normal
					// reply/error path rather than falling through to a second planner call.
					result = trackSettledPlannerToolResult(
						settledPlannerToolResults,
						toolCall.name,
						{
							success: false,
							error,
							text: error instanceof Error ? error.message : String(error),
						},
					);
				}
				const endedAt = Date.now();
				if (recorder && trajectoryId) {
					try {
						const input = selected.params ?? {};
						const io = captureToolStageIO({
							input,
							output: result,
							error: result.error,
						});
						const stage: RecordedStage = {
							stageId: `stage-tool-${toolCall.name}-${startedAt}`,
							kind: "tool",
							startedAt,
							endedAt,
							latencyMs: endedAt - startedAt,
							tool: {
								name: toolCall.name,
								args: input,
								result,
								success: result.success,
								durationMs: endedAt - startedAt,
								description: action?.description,
								input: io.input,
								output: io.output,
								errorText: io.errorText,
							},
						};
						await recorder.recordStage(trajectoryId, stage);
					} catch (error) {
						// error-policy:J7 Trajectory persistence is diagnostic and cannot
						// change the already-settled deterministic action result.
						args.runtime.reportError(
							"MessageService.recordDeterministicTool",
							error,
							{ trajectoryId, tool: toolCall.name },
						);
						args.runtime.logger.warn(
							{
								src: "service:message",
								err: error instanceof Error ? error.message : String(error),
								trajectoryId,
								tool: toolCall.name,
							},
							"Failed to record deterministic tool stage",
						);
					}
				}

				if (
					!callbackDelivered &&
					result.success === true &&
					result.modelReplyRequired === true
				) {
					// Stage 1 already wrote this turn in the agent's voice. Hold that prose
					// until the deterministic action returns an accepted effect receipt, then
					// release it without a second inference. The normal reply-egress guard
					// below still rejects unrelated mutation claims. Missing prose keeps the
					// post-tool synthesis path so an internal receipt never becomes canned UI.
					const acceptedEffect = structuredEffectFromToolResult(result);
					const groundedModelReply = prePatchStageOneReply?.trim();
					const groundedModelReplyEgress = groundedModelReply
						? evaluatePlannedReplyEgress({
								providers: plannerState.data.providers,
								request: args.message.content.text,
								reply: groundedModelReply,
								actionResults: [],
								actions: args.runtime.actions,
							})
						: undefined;
					if (
						acceptedEffect?.status === "accepted" &&
						groundedModelReply &&
						replyNamesStructuredEffectDestination(
							groundedModelReply,
							acceptedEffect,
						) &&
						groundedModelReplyEgress?.verdict === "allow"
					) {
						return {
							status: "finished",
							trajectory: {
								context: plannerContextAfterEarlyReply,
								steps: [{ iteration: 0, toolCall, result }],
								archivedSteps: [],
								plannedQueue: [],
								evaluatorOutputs: [],
							},
							finalMessage: groundedModelReply,
						};
					}
					return runPlannerLoop({
						runtime: plannerRuntime,
						context: plannerContextAfterEarlyReply,
						config: args.plannerLoopConfig,
						postToolReplySeed: { toolCall, result },
						executeToolCall: () => {
							throw new Error(
								"Post-tool reply synthesis cannot execute another tool",
							);
						},
						evaluate: ({
							runtime: plannerRuntimeForEval,
							context,
							trajectory,
						}) =>
							runEvaluator({
								runtime: plannerRuntimeForEval,
								context,
								trajectory,
								effects: evaluatorEffects,
								recorder,
								trajectoryId,
								cacheConversationId: JSON.stringify([
									args.runtime.agentId,
									args.message.roomId,
								]),
							}),
						evaluatorEffects,
						recorder,
						trajectoryId,
						cacheConversationId: JSON.stringify([
							args.runtime.agentId,
							args.message.roomId,
						]),
						providerAttributionState: plannerProviderAttributionState,
					});
				}

				const reportableResultText = result.userFacingText?.trim();
				const finalMessage =
					!callbackDelivered &&
					reportableResultText &&
					(result.success === true || result.verifiedUserFacing === true)
						? reportableResultText
						: undefined;
				return {
					status: "finished",
					trajectory: {
						context: plannerContextAfterEarlyReply,
						steps: [{ iteration: 0, toolCall, result }],
						archivedSteps: [],
						plannedQueue: [],
						evaluatorOutputs: [],
					},
					...(finalMessage ? { finalMessage } : {}),
					...(result.replyFailure
						? { terminalFailure: result.replyFailure }
						: {}),
				};
			};

		const invokePlannerLoop = (
			loopContext: typeof plannerContextAfterEarlyReply,
		) =>
			timeInferenceSpan("message:planner", () =>
				runPlannerLoop({
					runtime: plannerRuntime,
					context: loopContext,
					codingMode: args.codingMode === true,
					config: args.plannerLoopConfig,
					tools: plannerTools.length > 0 ? plannerTools : undefined,
					requireNonTerminalToolCall,
					// Fallback honesty for required-tool exhaustion: Stage 1's own
					// replyText (when answer-shaped) is surfaced instead of the
					// generic transient-failure apology. Duplicate delivery is safe —
					// early-reply turns dedup via plannedTextRepeatsEarlyReply.
					stageOneReplyText: (() => {
						const postPatch =
							typeof messageHandler.plan.reply === "string"
								? messageHandler.plan.reply
								: undefined;
						if (
							prePatchStageOneReplyIsUngroundedAppliedClaim &&
							postPatch === prePatchStageOneReply
						) {
							return undefined;
						}
						// A promotion patch that replaced a substantive stage-0 answer
						// with a bare progress ack must not also disarm the loop's
						// answer rescue — feed the preserved pre-patch answer instead.
						if (
							prePatchStageOneReply &&
							postPatch &&
							postPatch !== prePatchStageOneReply &&
							!prePatchStageOneReplyIsUngroundedAppliedClaim &&
							PROGRESS_ONLY_ANSWER_REJECT.test(postPatch.trim())
						) {
							return prePatchStageOneReply;
						}
						// A promotion patch that CLEARED the answer outright (clearReply,
						// e.g. core.simple_registered_action_request keyword-matching a
						// conversational remark to TASKS) is the same disarm with a worse
						// outcome: the planner sanely refuses the forced tool, the miss
						// cap exhausts with no captured text, and the user gets the
						// canned apology in place of the good answer Stage 1 already
						// wrote ("test the cloud app version" in a group chat → "i'm
						// sorry, i couldn't quite finish that", live 2026-08-21).
						if (
							prePatchStageOneReply &&
							postPatch === undefined &&
							!prePatchStageOneReplyIsUngroundedAppliedClaim
						) {
							return prePatchStageOneReply;
						}
						return postPatch;
					})(),
					// Per-turn miss-budget cap for answered turns escalated only by a
					// view-surface token overlap (see viewOverlapRequiredToolMissBudget);
					// the loop honors it only when stageOneReplyText is answer-shaped.
					...(typeof messageHandler.plan.requiredToolMissBudget === "number"
						? {
								requiredToolMissBudgetOverride:
									messageHandler.plan.requiredToolMissBudget,
							}
						: {}),
					// Provenance of the tool requirement: heuristic-inferred candidates
					// let the loop accept a firmly repeated terminal answer early.
					...(messageHandler.plan.requiredToolEvidence === "inferred"
						? { requiredToolEvidence: "inferred" as const }
						: {}),
					evaluatorEffects,
					recorder,
					trajectoryId,
					cacheConversationId: JSON.stringify([
						args.runtime.agentId,
						args.message.roomId,
					]),
					providerAttributionState: plannerProviderAttributionState,
					executeToolCall: (toolCall, ctx) =>
						timeInferenceSpan(
							"actions:planner-tool",
							async () =>
								trackSettledPlannerToolResult(
									settledPlannerToolResults,
									toolCall.name,
									await executeV5PlannedToolCall({
										runtime: args.runtime,
										toolCall,
										plannerContext: loopContext,
										executorCtx: buildV5ExecutorContext({
											message: args.message,
											state: plannerState,
											selectedContexts,
											senderRole,
											previousResults: collectPreviousActionResults(
												ctx.trajectory,
												exposedPlannerActions,
											),
											// A pending batch has not earned transcript prose, but its
											// media and interactive payloads still belong to the user.
											...(recordingCallback
												? {
														callback:
															ctx.plannerCompleted === false
																? intermediateCallback
																: recordingCallback,
													}
												: {}),
										}),
										plannerRuntime,
										executorOptions: {
											actions: exposedPlannerActions,
											...(args.onSettledActionResult
												? {
														onSettledResult: args.onSettledActionResult,
													}
												: {}),
										},
										evaluatorEffects,
										recorder,
										trajectoryId,
										plannerLoopConfig: args.plannerLoopConfig,
									}),
								),
							{ tool: toolCall.name },
						),
					evaluate: ({ runtime: plannerRuntimeForEval, context, trajectory }) =>
						timeInferenceSpan("evaluators:planner", () =>
							runEvaluator({
								runtime: plannerRuntimeForEval,
								context,
								trajectory,
								effects: evaluatorEffects,
								recorder,
								trajectoryId,
								cacheConversationId: JSON.stringify([
									args.runtime.agentId,
									args.message.roomId,
								]),
							}),
						),
				}),
			);

		let plannerResult: Awaited<ReturnType<typeof invokePlannerLoop>>;
		try {
			plannerResult = messageHandler.plan.deterministicToolCall
				? await timeInferenceSpan(
						"actions:response-handler-deterministic-tool",
						invokeDeterministicToolCall,
					)
				: await invokePlannerLoop(plannerContextAfterEarlyReply);
			getStreamingContext()?.abortSignal?.throwIfAborted();
		} catch (error) {
			// Cancellation belongs to the interrupted-turn boundary, even after preliminary delivery.
			getStreamingContext()?.abortSignal?.throwIfAborted();
			if (
				error instanceof TurnAbortedError ||
				(isRecord(error) && error.code === "TURN_ABORTED")
			)
				throw error;
			// Provider capacity failures retain their explicit failure receipt.
			if (isProviderContextOverflowFailure(error)) throw error;
			// A coding turn is an all-the-way-to-verification transaction. A
			// successful intermediate file operation cannot rescue a loop that hit
			// its call/token/provider limit before a grounded terminal result; doing
			// so makes CLI/ACP report partial work as success.
			if (args.codingMode === true) throw error;
			const preservedAnswer = prePatchStageOneReplyIsUngroundedAppliedClaim
				? undefined
				: prePatchStageOneReply?.trim();
			if (
				!preservedAnswer ||
				PROGRESS_ONLY_ANSWER_REJECT.test(preservedAnswer)
			) {
				// No answer-shaped Stage-1 text to rescue with — but a tool that
				// already completed this turn may still own the user-facing result
				// (observed live: the post-tool evaluator died on an intermittent
				// provider 400 and the canned transient-failure reply replaced a
				// result the turn had already produced). Deliver the preserved tool
				// result; the canned line remains only when there is genuinely
				// nothing user-facing to deliver.
				const preservedToolResult = preservedSettledToolResult(
					settledPlannerToolResults,
					deliveredVisibleTexts,
				);
				if (!preservedToolResult) {
					// #18208: a task_complete relay turn carries the sub-agent's
					// finished result in its own body — the last preserved source
					// before conceding to the canned failure reply.
					const relayBody = subAgentCompletionRelayBody(
						args.message?.content?.text,
					);
					if (!relayBody) {
						throw error;
					}
					// error-policy:J4 a completed sub-agent result is a designed
					// degrade when the relay turn's planning fails; report the loop
					// failure and deliver the result the sub-agent already produced.
					endStatus = "errored";
					args.runtime.reportError("MessageService.plannerLoop", error, {
						roomId: args.message.roomId,
					});
					return {
						kind: "direct_reply",
						messageHandler,
						result: createV5ReplyStrategyResult({
							...args,
							state: plannerState,
							text: relayBody,
							thought: messageHandler.thought,
						}),
					};
				}
				// error-policy:J4 a completed tool's user-facing result is a designed
				// degrade when later planning/evaluation fails; report the loop
				// failure and deliver the tool's known-good text.
				endStatus = "errored";
				args.runtime.reportError("MessageService.plannerLoop", error, {
					roomId: args.message.roomId,
				});
				return {
					kind: "direct_reply",
					messageHandler,
					result: createV5ReplyStrategyResult({
						...args,
						state: plannerState,
						text: preservedToolResult.userFacingText,
						thought: messageHandler.thought,
						// Only byte-exact canonical action text may skip the voice
						// gate; ordinary tool output stays eligible for re-voicing.
						...(preservedToolResult.verifiedUserFacing === true
							? { agentVoiced: true }
							: {}),
						...(preservedToolResult.userFacingEffectReceiptIds?.length
							? {
									effectReceiptIds:
										preservedToolResult.userFacingEffectReceiptIds,
								}
							: {}),
					}),
				};
			}
			// error-policy:J4 A completed Stage-1 answer is a designed degrade when
			// later planning fails; report the planner failure and deliver known-good text.
			endStatus = "errored";
			args.runtime.reportError("MessageService.plannerLoop", error, {
				roomId: args.message.roomId,
			});
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					state: plannerState,
					text: preservedAnswer,
					thought: messageHandler.thought,
					agentVoiced: true,
				}),
			};
		}

		// The planner's terminal prose may ship without executing REPLY. Validate
		// state assertions against capability-specific results from this same
		// trajectory; rejection fails closed here and never starts a fresh loop
		// that could discard results or replay a partial side effect.
		const egressActionResults = collectPreviousActionResults(
			plannerResult.trajectory,
			exposedPlannerActions,
		);
		if (
			plannerResult.terminalFailure &&
			(egressActionResults.some(
				(result) => result.replyFailure !== undefined,
			) ||
				(plannerResult.terminalFailure.code ===
					"PLANNER_SCOPE_DECLARATION_REQUIRED" &&
					!plannerResult.finalMessage?.trim()))
		) {
			// There is no model-authored reply to deliver. Preserve every action
			// outcome and surface the unavailable system status separately; none of
			// the answerless/egress/context-after fallbacks may call another model
			// or execute another action after this presentation failure.
			return {
				kind: "planned_reply",
				messageHandler,
				result: {
					responseContent: null,
					responseMessages: [],
					state: withActionResultsForPrompt(
						plannerState,
						egressActionResults,
						args.runtime,
					),
					mode: "none",
					terminalFailure: plannerResult.terminalFailure,
					actionResults: egressActionResults,
				},
			};
		}
		let replyRecovered = false;
		let recoveredReply:
			| Awaited<ReturnType<typeof resolvePlannedReplyEgress>>
			| undefined;
		const plannedReplyEgressDecision =
			args.codingMode === true
				? ({ verdict: "allow" } as const)
				: evaluatePlannedReplyEgress({
						providers: plannerState.data.providers,
						request: args.message.content.text,
						reply: String(plannerResult.finalMessage ?? ""),
						actionResults: egressActionResults,
						actions: args.runtime.actions,
						evaluator: plannerResult.evaluator,
					});
		// A reply an action callback already delivered this turn (verbatim or as
		// a strict superset) is a planner echo: the suppression below drops it, so
		// it never egresses. Bouncing it here instead would follow the visible,
		// action-owned confirmation with a contradicting "couldn't verify" bubble.
		const plannedReplyAlreadyDelivered = deliveredTextsCoverReply(
			deliveredVisibleTexts,
			normalizeVisibleTextForDuplicateCheck(
				String(plannerResult.finalMessage ?? ""),
			),
		);
		if (
			plannedReplyEgressDecision.verdict === "reject" &&
			!plannedReplyAlreadyDelivered
		) {
			args.runtime.logger?.warn?.(
				{
					src: "service:message",
					agentId: args.runtime.agentId,
					kind: plannedReplyEgressDecision.kind,
				},
				"[message] replaced a planned reply whose state claim lacked a matching action receipt",
			);
			recoveredReply = await resolvePlannedReplyEgress({
				providers: plannerState.data.providers,
				runtime: args.runtime,
				message: args.message,
				reply: plannerResult.finalMessage ?? "",
				actionResults: egressActionResults,
				evaluator: plannerResult.evaluator,
			});
			plannerResult = {
				...plannerResult,
				finalMessage: recoveredReply.text,
			};
			replyRecovered = true;
		}

		// CONTEXT_AFTER (blocking): hooks fire after the planner loop, before
		// the response is delivered. Lets a context post-process planner
		// output (e.g. enrich the reply with context-specific data).
		await timeInferenceSpan(
			"actions:context-after",
			() =>
				args.runtime.runActionsByMode(
					"CONTEXT_AFTER",
					args.message,
					plannerState,
					{ selectedContexts },
				),
			{ mode: "CONTEXT_AFTER" },
		);
		return await finalizePlannerReply(args, {
			recoveredReply,
			replyRecovered,
			plannerResult,
			exposedPlannerActions,
			plannerState,
			ambientTurn,
			earlyReplySent,
			messageHandler,
			prePatchStageOneReplyIsUngroundedAppliedClaim,
			prePatchStageOneReply,
			earlyReplyText,
			settledPlannerToolResults,
			deliveredVisibleTexts,
		});
	} catch (err) {
		// error-policy:J2 Preserve the failing status for trajectory diagnostics,
		// then rethrow the original failure to the message boundary. A provider
		// context-overflow rejection classified by the planner boundary is the
		// exception: the message boundary converts it into a designed
		// honest reply, so the trajectory FINISHES with that outcome instead of
		// recording a dead errored turn.
		endStatus = isProviderContextOverflowFailure(err) ? "finished" : "errored";
		throw err;
	} finally {
		// Trajectory persistence is diagnostic work. Preserve stage ordering in
		// its own task without adding filesystem latency to the user-visible turn.
		const finalizeTrajectory = async (waitForFacts: boolean) => {
			if (!recorder || !trajectoryId) return;
			await messageHandlerStageTask;
			const factsOutcome = waitForFacts ? await factsTask : settledFactsOutcome;
			if (factsOutcome) {
				await recordFactsAndRelationshipsStage({
					recorder,
					trajectoryId,
					outcome: factsOutcome,
					runtime: args.runtime,
				});
			}
			await finalizeTrajectoryRecording({
				recorder,
				trajectoryId,
				status: endStatus,
				reportError: args.runtime.reportError.bind(args.runtime),
				logger: args.runtime.logger as {
					warn?: (context: unknown, message?: string) => void;
				},
			});
		};
		if (process.env.ELIZA_AWAIT_FACTS_STAGE === "true") {
			await finalizeTrajectory(true);
		} else if (recorder && trajectoryId) {
			detachPostDeliverySideEffect(
				args.runtime,
				"trajectory-finalization",
				() => finalizeTrajectory(false),
				"diagnostic",
			);
			if (
				settledFactsOutcome === undefined &&
				args.runTerminalOwner === undefined
			) {
				detachPostDeliverySideEffect(
					args.runtime,
					"facts-and-relationships",
					async () => {
						await factsTask;
					},
					"room-state",
					args.message.roomId,
					args.roomHandlerLease,
				);
			}
		}
	}
}
