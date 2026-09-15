/** Coordinates message preparation, response decisions, and delivery with explicit attachment, failure, and reply-persistence collaborators. The outer message lifetime retains preemption and terminal-event ownership. */

import { v4 } from "uuid";
import { createUniqueUuid } from "../../entities";
import { ElizaError } from "../../errors";
import { decideReplyGate } from "../../features/advanced-capabilities/personality";
import { getPersonalityStore } from "../../features/advanced-capabilities/personality/services/personality-store.ts";
import {
	aliasRecallQuery,
	embedRecallQuery,
} from "../../features/documents/recall-embed";
import { runShouldRespondInjectionGate } from "../../features/trust/should-respond-risk-gate";
import {
	INFERENCE_MARKS,
	markInference,
	timeInferenceSpan,
} from "../../inference-timing";
import { isCanonicalModelCapabilityDisabled } from "../../runtime/canonical-model-capabilities.ts";
import { TurnAbortedError } from "../../runtime/turn-controller";
import { getStreamingContext } from "../../streaming-context";
import { getTrajectoryContext } from "../../trajectory-context";
import { withEvaluatorStep } from "../../trajectory-utils";
import type {
	ActionResult,
	HandlerCallback,
	MessageHandlerExtract,
} from "../../types/components";
import type { Room } from "../../types/environment";
import { EventType } from "../../types/events";
import type { Memory } from "../../types/memory";
import type {
	ContextRoutedResponseDecision,
	MessageProcessingResult,
	MessageReplyRecoveryContext,
	MessageTerminalFailure,
} from "../../types/message-service";
import { ModelType } from "../../types/model";
import {
	incomingPipelineHookContext,
	outgoingPipelineHookContext,
	parallelWithShouldRespondPipelineHookContext,
	preShouldRespondPipelineHookContext,
} from "../../types/pipeline-hooks";
import type {
	Content,
	JsonValue,
	MentionContext,
	UUID,
} from "../../types/primitives";
import { asUUID, ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { parseBooleanFromText, truncateToCompleteSentence } from "../../utils";
import {
	attachAvailableContexts,
	type ContextRoutingDecision,
	parseContextRoutingMetadata,
	setContextRoutingMetadata,
} from "../../utils/context-routing";
import { stripAugmentationForPersistence } from "../../utils/message-text";
import { modelProviderErrorDetail } from "../../utils/model-errors";
import { isObjectRecord as isRecord } from "../../utils/type-guards";
import { runPostTurnEvaluators } from "../evaluator";
import { resolveSupersededResponseKeepReason } from "./action-ownership.js";
import {
	messageExplicitlyAddressesAgent,
	resolveStage1SenderRole,
} from "./addressing.js";
import { sanitizeAttachmentsForStorage } from "./attachment-input.js";
import type { MessageAttachments } from "./attachments.js";
import { runBotGroupAddressGate, runBotLoopGate } from "./bot-loop-gate";
import { runBotNoiseTriage } from "./bot-noise-triage";
import type {
	ResolvedMessageOptions,
	ResponseHandlerEarlyReplyEvent,
	StrategyMode,
	StrategyResult,
} from "./contracts.js";
import {
	enforceEffectGroundedVisibleContent,
	enforceTrustedDeliveryAudienceAtEgress,
	enforceTrustedDeliveryAudienceOnResult,
	evaluatePlannedReplyEgress,
} from "./egress-policy.js";
import type { MessageFailures } from "./failures.js";
import { classifyStructuredFailureCause } from "./fallback-reply";
import { resolveEffectiveMuteState } from "./mute-state";
import { runV5MessageRuntimeStage1 } from "./pipeline.js";
import {
	hasPostTurnSemanticSignal,
	isStopResponse,
} from "./post-turn-policy.js";
import { shouldSkipResponseMemoryPersistence } from "./processor-policy.js";
import { composeResponseState } from "./provider-state.js";
import { candidateActionsIncludeAsyncHandoff } from "./reply-policy.js";
import { withInferredContextRoutingFallback } from "./response-state.js";
import { runShortcutGate } from "./shortcut-turn.js";
import { hasTextGenerationHandler } from "./trajectory-stages.js";
import {
	clearLatestResponseId,
	getLatestResponseId,
	latestResponseIds,
} from "./turn-session.js";
import {
	getVoiceSpeakerEntityId,
	isVoiceChannelMessage,
} from "./voice-signals.js";

export interface MessageProcessorHost {
	awaitDeliveredReplyPersistence(
		runtime: IAgentRuntime,
		roomId: UUID,
	): Promise<void>;
	processAttachments(
		...args: Parameters<MessageAttachments["processAttachments"]>
	): ReturnType<MessageAttachments["processAttachments"]>;
	buildStructuredFailureReply(
		...args: Parameters<MessageFailures["buildStructuredFailureReply"]>
	): ReturnType<MessageFailures["buildStructuredFailureReply"]>;
	/**
	 * Determines whether the agent should respond to a message.
	 * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
	 */
	shouldRespond(
		runtime: IAgentRuntime,
		message: Memory,
		room?: Room,
		mentionContext?: MentionContext,
	): ContextRoutedResponseDecision;
	buildNoModelProviderReply(
		...args: Parameters<MessageFailures["buildNoModelProviderReply"]>
	): ReturnType<MessageFailures["buildNoModelProviderReply"]>;
	registerPendingReplyPersist(runtime: IAgentRuntime, roomId: UUID): () => void;
}

export class MessageProcessor {
	constructor(private readonly host: MessageProcessorHost) {}

	/**
	 * Internal message processing implementation
	 */
	async processMessage(
		runtime: IAgentRuntime,
		message: Memory,
		callback: HandlerCallback | undefined,
		deliveredVisibleTexts: Set<string>,
		responseId: UUID,
		runId: UUID,
		opts: ResolvedMessageOptions,
	): Promise<MessageProcessingResult> {
		const runTerminalOwner = opts.runTerminalOwner;
		if (!runTerminalOwner) {
			throw new ElizaError(
				"Message processing requires a live run terminal owner",
				{
					code: "RUN_TERMINAL_OWNER_REQUIRED",
					context: { runId, messageId: message.id, roomId: message.roomId },
				},
			);
		}
		// A reply already handed to a delivery callback for this room may still
		// be persisting (deliver-then-persist fast path). Composing now would
		// read RECENT_MESSAGES without the reply this message may be answering,
		// so wait for those persists to settle first. Same room only, a few
		// hundred ms worst case, and a no-op when nothing is pending.
		await this.host.awaitDeliveredReplyPersistence(runtime, message.roomId);

		if (!latestResponseIds.has(runtime.agentId)) {
			throw new Error("Agent responses map not found");
		}

		// Skip messages from self (unless it's an autonomous message)
		const isAutonomousMessage =
			message.content?.metadata &&
			typeof message.content.metadata === "object" &&
			(message.content.metadata as Record<string, unknown>).isAutonomous ===
				true;

		if (message.entityId === runtime.agentId && !isAutonomousMessage) {
			runtime.logger.debug(
				{ src: "service:message", agentId: runtime.agentId },
				"Skipping message from self",
			);
			runTerminalOwner.request("self");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		runtime.logger.debug(
			{
				src: "service:message",
				messagePreview: truncateToCompleteSentence(
					message.content.text || "",
					50,
				),
			},
			"Processing message",
		);

		// ── Save the incoming message to memory ────────────────────────────
		runtime.logger.debug(
			{ src: "service:message" },
			"Saving message to memory",
		);
		await timeInferenceSpan("message:ingress:persistence", async () => {
			let memoryToQueue: Memory;

			// The document augmentation envelope
			// (`<contextual_documents>...</contextual_documents>` + `<user_request>`)
			// is a model-facing wrapper added just for this turn's LLM prompt. Persist
			// and embed the clean user text so the stored memory does not echo raw
			// wrapper XML back into the user's chat bubble or re-enter context as
			// history on later turns. `message` (used downstream this turn) keeps its
			// wrap.
			const persistableMessage = stripAugmentationForPersistence(message);

			if (message.id) {
				const createdMemoryId = await runtime.createMemory(
					persistableMessage,
					"messages",
				);
				memoryToQueue = { ...persistableMessage, id: createdMemoryId };
				await runtime.queueEmbeddingGeneration(memoryToQueue, "high");
			} else {
				const memoryId = await runtime.createMemory(
					persistableMessage,
					"messages",
				);
				message.id = memoryId;
				memoryToQueue = { ...persistableMessage, id: memoryId };
				await runtime.queueEmbeddingGeneration(memoryToQueue, "normal");
			}
		});

		// Participant state and room are independent reads. Resolving them together
		// also lets mute evaluation reuse this room instead of fetching it once to
		// discover the world and again before should-respond routing.
		const [agentUserState, room] = await Promise.all([
			timeInferenceSpan("message:ingress:participant-state", () =>
				runtime.getParticipantUserState(message.roomId, runtime.agentId),
			),
			timeInferenceSpan("message:ingress:room", () =>
				runtime.getRoom(message.roomId),
			),
		]);

		// Check if LLM is off by default
		const defLllmOff = parseBooleanFromText(
			String(runtime.getSetting("BASIC_CAPABILITIES_DEFLLMOFF") || ""),
		);

		if (defLllmOff && agentUserState === null) {
			runtime.logger.debug({ src: "service:message" }, "LLM is off by default");
			runTerminalOwner.request("off");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Effective mute check — room participant state, server-wide world mute,
		// and the timed-mute due-check — independent of any addressing logic. A
		// muted room drops even a direct @mention: on mention-gated deployments
		// (strict mode) every turn reaching this point IS a mention, so a
		// mention bypass here made mute a complete no-op. Unmuting a muted room
		// is done from another room (or DM) via the ROOM action's cross-room
		// targeting.
		const mentionContext = message.content.mentionContext;
		const explicitlyAddressesAgent = messageExplicitlyAddressesAgent(
			runtime,
			message,
		);
		const muteState = await timeInferenceSpan(
			"message:ingress:mute-state",
			() =>
				resolveEffectiveMuteState(runtime, {
					roomIds: [message.roomId],
					primaryRoom: room,
					primaryParticipantState: agentUserState,
					...(message.worldId || room?.worldId
						? { worldId: message.worldId ?? room?.worldId }
						: {}),
				}),
		);
		if (muteState.muted) {
			runtime.logger.debug(
				{
					src: "service:message",
					roomId: message.roomId,
					scope: muteState.scope,
				},
				"Ignoring muted room",
			);
			runTerminalOwner.request("muted");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// PERSONALITY reply-gate enforcement. Short-circuits BEFORE the planner /
		// model call so a user who said "shut up" or "only when mentioned" does
		// NOT cost tokens this turn. Agent's own messages and autonomous turns
		// are not subject to the gate (already filtered above).
		const personalityStore = getPersonalityStore(runtime);
		if (personalityStore && message.entityId !== runtime.agentId) {
			const userSlot = personalityStore.getSlot(message.entityId);
			const globalSlot = personalityStore.getSlot("global");
			const gateDecision = decideReplyGate({
				userSlot,
				globalSlot,
				messageText: message.content?.text,
				explicitlyAddressesAgent,
			});
			if (gateDecision.allow === false) {
				runtime.logger.debug(
					{
						src: "service:message",
						roomId: message.roomId,
						reason: gateDecision.reason,
						gateMode: gateDecision.gateMode,
						gateScope: gateDecision.scope,
					},
					"Reply suppressed by personality reply_gate",
				);
				runTerminalOwner.request("personality_gate");
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state: { values: {}, data: {}, text: "" } as State,
					mode: "none",
				};
			}
		}

		// Trusted-metadata group floor. A bot-authored group turn that does not
		// address this agent is deterministically silent; human text containing a
		// spoofed "(bot)" label never qualifies. Direct address wins so deliberate
		// agent-to-agent orchestration remains available.
		const botGroupAddressGate = await runBotGroupAddressGate({
			runtime,
			message,
			explicitlyAddressesAgent,
		});
		if (botGroupAddressGate.ignored) {
			runtime.logger.info(
				{
					src: "service:message",
					agentId: runtime.agentId,
					roomId: message.roomId,
					entityId: message.entityId,
				},
				"Unaddressed bot-authored group turn ignored by deterministic address gate",
			);
			runTerminalOwner.request("bot_group_address_gate");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Cheap-tier triage for unaddressed bot/webhook traffic. A relay channel
		// flooding automated embeds otherwise burns a full composeState + Stage 1
		// RESPONSE_HANDLER call (the most expensive model in the stack — on
		// subscription-backed providers ~1000 IGNOREs/day drain the daily session
		// budget and take the agent down) just to conclude IGNORE. Triage those
		// turns on TEXT_SMALL BEFORE state composition; an IGNORE verdict ends the
		// turn with zero large-tier calls. Addressed/human/private-channel turns
		// never enter this gate, and any triage failure falls open to the full
		// pipeline.
		const botNoiseTriage = await runBotNoiseTriage({
			runtime,
			message,
			explicitlyAddressesAgent,
		});
		if (botNoiseTriage.applied && !botNoiseTriage.respond) {
			runtime.logger.info(
				{
					src: "service:message",
					agentId: runtime.agentId,
					roomId: message.roomId,
					entityId: message.entityId,
				},
				"Unaddressed bot/webhook message ignored by small-model triage (skipped Stage 1)",
			);
			runTerminalOwner.request("bot_noise_triage");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Deterministic bot-to-bot loop gate — the model-size-independent floor
		// beneath the soft ANXIETY / BOT_AWARENESS providers and the #25405
		// shouldRespond restraint rules. Small models (gemma-class) do not
		// reliably follow those prompt signals, so the hard stop lives here in
		// code: a bot-authored group turn arriving after the agent has already
		// produced N consecutive turns with no intervening human message ends
		// deterministically with IGNORE before any model call. Every
		// unverifiable input (untagged sender, unknown channel, read failure)
		// fails OPEN — the gate only ever biases toward silence, never speech.
		const botLoopGate = await runBotLoopGate({
			runtime,
			message,
			explicitlyAddressesAgent,
		});
		if (botLoopGate.ignored) {
			runtime.logger.info(
				{
					src: "service:message",
					agentId: runtime.agentId,
					roomId: message.roomId,
					entityId: message.entityId,
					agentTurnsSinceLastHuman: botLoopGate.agentTurnsSinceLastHuman,
				},
				"Bot-to-bot exchange with no intervening human turn — deterministic IGNORE (bot-loop gate)",
			);
			runTerminalOwner.request("bot_loop_gate");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Prefetch the shared per-turn recall-query embed now that every cheap
		// short-circuit gate (self, LLM-off, mute, personality reply-gate,
		// bot-noise triage) has passed — so a dropped turn never issues a wasted
		// embed and the "muted room = zero model calls" invariant holds. Placed
		// before the remaining serial pre-compose work (room fetch, attachment
		// processing, incoming hooks, composeState) so this embed round-trip
		// overlaps it instead of gating the Stage-1 model call: the
		// relevant-conversations provider, document recall, experience recall,
		// and the FACTS path all route the same text through `embedRecallQuery`
		// (keyed by this run), so they await this in-flight result rather than
		// starting a fresh round-trip. Delivery does not await it, but RUN_ENDED
		// does; the value is re-read from the per-run cache by normalized-text key.
		// Present the turn's `messageId` so this prefetch ADOPTS the pre-run cache
		// the API chat path's document augmentation already warmed under the same
		// id (#15253): on a no-match turn the query text is byte-identical, so the
		// adopted vector resolves here with ZERO new embed instead of a second
		// identical round-trip.
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a warm failure only
		// forfeits the overlap; the compose-time caller re-embeds and fails open.
		const recallWarmText = message.content?.text;
		if (
			typeof recallWarmText === "string" &&
			recallWarmText.trim() !== "" &&
			!isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_EMBEDDING)
		) {
			const recallWarmMessageId =
				typeof message.id === "string" ? message.id : undefined;
			const recallWarmTask = embedRecallQuery(runtime, recallWarmText, {
				messageId: recallWarmMessageId,
				...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
			}).catch((error) => {
				if (opts.abortSignal?.aborted) {
					// error-policy:J5 the request boundary observes cancellation;
					// suppress only this detached speculative warm's rejection.
					return;
				}
				runtime.reportError("MessageService.recallEmbedPrefetch", error, {
					roomId: message.roomId,
					runId,
				});
			});
			runTerminalOwner.adopt("recall-embed-prefetch", recallWarmTask);
		}

		// Process attachments before state composition / incoming hooks
		if (message.content.attachments && message.content.attachments.length > 0) {
			const attachments = message.content.attachments;
			message.content.attachments = await timeInferenceSpan(
				"message:ingress:attachments",
				() => this.host.processAttachments(runtime, attachments),
			);
			if (message.id) {
				// API chat can pass a prompt-only clone whose text includes language
				// or document guidance while the canonical user memory already exists.
				// Attachment enrichment must update only the durable attachment view,
				// not overwrite the stored user's words with those internal prompt
				// instructions. Preserve the canonical persisted text when available.
				const canonicalMessage = await runtime.getMemoryById(message.id);
				const canonicalText = canonicalMessage?.content?.text;
				await runtime.updateMemory({
					id: message.id,
					content: {
						...message.content,
						...(typeof canonicalText === "string"
							? { text: canonicalText }
							: {}),
						attachments: sanitizeAttachmentsForStorage(
							message.content.attachments,
						),
					},
				});
			}
		}

		const preIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		await timeInferenceSpan("message:ingress:hooks", () =>
			runtime.applyPipelineHooks(
				"incoming_before_compose",
				incomingPipelineHookContext(message, {
					roomId: message.roomId,
					responseId,
					runId,
				}),
			),
		);

		const postIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		if (postIncomingHookText !== preIncomingHookText) {
			// An incoming hook rewrote the turn's text — the core security hook
			// replaces `content.text` with the external-content envelope for every
			// untrusted-source message (incoming-message-security.ts), and the
			// storage scrub can rewrite trusted text too. Compose-time recall
			// callers (relevant-conversations, document recall, experience recall)
			// present the REWRITTEN text, whose normalized cache key misses the
			// raw-text vector the prefetch above is already fetching — a guaranteed
			// second, serial TEXT_EMBEDDING round-trip on every rewritten turn.
			// Declare the rewritten text equivalent to the raw prompt for this
			// turn's recall so those callers join the prefetch round-trip instead;
			// the raw user text is also the semantically correct recall query (the
			// user's words, not the security armor around them).
			if (
				preIncomingHookText.trim() !== "" &&
				postIncomingHookText.trim() !== ""
			) {
				aliasRecallQuery(runtime, {
					...(typeof message.id === "string" ? { messageId: message.id } : {}),
					sourceText: preIncomingHookText,
					aliasText: postIncomingHookText,
				});
			}
			if (message.id) {
				await runtime.updateMemory({
					id: message.id,
					content: message.content,
				});
				await runtime.queueEmbeddingGeneration(
					{ ...message, id: message.id },
					"normal",
				);
			}
		}

		// Compose initial state (after incoming hooks so providers/actions text matches this turn)
		let state = await composeResponseState(runtime, message);
		state = attachAvailableContexts(state, runtime);

		const metadata =
			typeof message.content.metadata === "object" &&
			message.content.metadata !== null
				? (message.content.metadata as Record<string, unknown>)
				: null;
		const isAutonomous = metadata?.isAutonomous === true;
		const autonomyMode =
			typeof metadata?.autonomyMode === "string" ? metadata.autonomyMode : null;

		await timeInferenceSpan("message:ingress:pre-respond-hooks", () =>
			runtime.applyPipelineHooks(
				"pre_should_respond",
				preShouldRespondPipelineHookContext(message, {
					roomId: message.roomId,
					responseId,
					runId,
					state,
					isAutonomous,
				}),
			),
		);

		let shouldRespondToMessage = true;
		let terminalDecision: "IGNORE" | "STOP" | null = null;
		let routedDecision: ContextRoutingDecision | null = null;
		let strategyResult: StrategyResult | null = null;
		let _usedV5Runtime = false;
		let stage1DecidedRespond = false;
		let stage1RiskGateApplied = false;
		let stage1Extract: MessageHandlerExtract | undefined;
		const earlyReplyMessages: Memory[] = [];
		const persistedEarlyReplyIds = new Set<string>();
		const voiceResponseHandlerFastPath = isVoiceChannelMessage(message);
		// Canonicalize the resolved speaker (imprint → entityId) onto
		// `content.metadata.speakerEntityId` for every voice turn that carries one
		// (#8786). Attribution can arrive top-level (in-process engine) or nested
		// (chat clients); collapsing to one spot lets providers/extraction and the
		// facts/relationships stage attribute the turn to the right person.
		if (voiceResponseHandlerFastPath && message.content) {
			const speakerEntityId = getVoiceSpeakerEntityId(message);
			if (speakerEntityId) {
				const md =
					message.content.metadata &&
					typeof message.content.metadata === "object" &&
					!Array.isArray(message.content.metadata)
						? (message.content.metadata as Record<string, unknown>)
						: {};
				if (md.speakerEntityId !== speakerEntityId) {
					message.content.metadata = { ...md, speakerEntityId };
				}
			}
		}
		const deliverResponseHandlerEarlyReply = voiceResponseHandlerFastPath
			? async (event: ResponseHandlerEarlyReplyEvent): Promise<boolean> => {
					// Structural early-ack gate: a pre-planner ack is only warranted
					// when the routed work is an async handoff — a candidate action
					// whose execution continues after the turn returns (sub-agent
					// spawn class), where the real result arrives long after the turn.
					// Synchronous turns (retrieval, in-turn tool work) deliver one
					// reply — the final answer — so voice matches text channels
					// bubble-for-bubble. Returning false tells the Stage-1 producer
					// nothing was delivered.
					if (
						!candidateActionsIncludeAsyncHandoff(
							runtime.actions,
							event.messageHandler.plan.candidateActions ?? [],
						)
					) {
						return false;
					}
					const proposedText = event.text.trim();
					const earlyReplyEgressDecision = evaluatePlannedReplyEgress({
						providers: state.data.providers,
						request: message.content.text,
						reply: proposedText,
						actionResults: [],
						actions: runtime.actions,
					});
					if (earlyReplyEgressDecision.verdict !== "allow") {
						// An ungrounded completion claim cannot ship, and this delivery
						// floor must not manufacture a substitute ack — drop the early
						// reply; the planner's final delivery owns the turn.
						return false;
					}
					const text = proposedText;
					if (!text || !message.id) return false;
					const currentResponseId = getLatestResponseId(
						runtime.agentId,
						message.roomId,
					);
					if (currentResponseId !== responseId && !opts.keepExistingResponses) {
						runtime.logger.info(
							{
								src: "service:message",
								agentId: runtime.agentId,
								roomId: message.roomId,
								responseId,
								currentResponseId,
							},
							"Response-handler early voice reply discarded - newer message being processed",
						);
						return false;
					}
					if (getStreamingContext()?.abortSignal?.aborted) {
						return false;
					}
					const earlyResponseId = asUUID(v4());
					let earlyContent: Content = {
						thought: event.messageHandler.thought,
						actions: ["REPLY"],
						text,
						responseId: earlyResponseId,
						inReplyTo: createUniqueUuid(runtime, message.id),
						// #14873: the early reply IS the Stage-1 model's replyText —
						// genuine agent voice (egress-rejected text never reaches this
						// point) — so gated transports must not re-voice it.
						agentVoiced: true,
					};
					await runtime.applyPipelineHooks(
						"outgoing_before_deliver",
						outgoingPipelineHookContext(earlyContent, {
							source: "response-handler",
							roomId: message.roomId,
							message,
							responseId: earlyResponseId,
						}),
					);
					earlyContent = await enforceEffectGroundedVisibleContent(
						runtime,
						message,
						earlyContent,
					);
					earlyContent = await enforceTrustedDeliveryAudienceAtEgress(
						runtime,
						message,
						earlyContent,
					);
					const earlyMemory: Memory = {
						id: earlyResponseId,
						entityId: runtime.agentId,
						agentId: runtime.agentId,
						content: earlyContent,
						roomId: message.roomId,
						createdAt: Date.now(),
					};
					await runtime.createMemory(earlyMemory, "messages");
					await this.emitMessageSent(
						runtime,
						earlyMemory,
						message.content.source ?? "messageHandler",
					);
					earlyReplyMessages.push(earlyMemory);
					persistedEarlyReplyIds.add(earlyResponseId);
					if (callback) {
						await callback(earlyContent);
					}
					return true;
				}
			: undefined;

		const parallelJoin: { translatedUserText?: string } = {};
		const setTranslatedUserText = (text: string) => {
			parallelJoin.translatedUserText = text;
		};
		const parallelHookCtx = parallelWithShouldRespondPipelineHookContext({
			roomId: message.roomId,
			responseId,
			runId,
			message,
			state,
			room: room ?? undefined,
			mentionContext,
			isAutonomous,
			setTranslatedUserText,
		});

		// #8791: the explicit-protocol shortcut gate runs first so slash/`!`
		// commands cannot be pre-empted by another handler. Ordinary language is
		// never eligible here and always reaches the planner.
		if (!strategyResult) {
			// Reuse the role resolved once per turn in handleMessage (stamped on the
			// trajectory context) — resolving again here costs a room+world lookup.
			const shortcutSenderRole =
				getTrajectoryContext()?.userRole ??
				(await resolveStage1SenderRole(runtime, message));
			const shortcutOutcome = await runShortcutGate({
				runtime,
				message,
				state,
				responseId,
				senderRole: shortcutSenderRole,
				...(opts.onSettledActionResult
					? { onSettledActionResult: opts.onSettledActionResult }
					: {}),
			});
			if (shortcutOutcome && shortcutOutcome.kind === "direct_reply") {
				strategyResult = shortcutOutcome.result;
				_usedV5Runtime = true;
				runtime.logger?.debug?.(
					{ src: "service:message", agentId: runtime.agentId },
					"Message resolved via pre-LLM shortcut gate",
				);
			}
		}

		if (!strategyResult && hasTextGenerationHandler(runtime)) {
			let hasSettledEffectEvidence = false;
			const onSettledActionResult = (result: ActionResult) => {
				// Any recorded mutation outcome (including a rollback or uncertain
				// commit) makes the pre-action state unsuitable for failure prose.
				// The caller retains the complete results and resolves their status;
				// this boundary must not reinterpret them as a successful commit.
				hasSettledEffectEvidence ||=
					(result.effectReceipts?.length ?? 0) > 0 ||
					result.data?.reconciliationRequired === true;
				opts.onSettledActionResult?.(result);
			};
			if (isAutonomous) {
				runtime.logger.debug(
					{ src: "service:message", autonomyMode },
					"Autonomy message using v5 messageHandler/planner runtime",
				);
			}
			try {
				const [outcome] = await Promise.all([
					timeInferenceSpan("message:planner", () =>
						runV5MessageRuntimeStage1({
							runtime,
							message,
							state,
							responseId,
							codingMode: opts.codingMode,
							...(opts.codingActionProfile
								? { codingActionProfile: opts.codingActionProfile }
								: {}),
							...(callback ? { callback } : {}),
							deliveredVisibleTexts,
							...(opts.roomHandlerLease
								? { roomHandlerLease: opts.roomHandlerLease }
								: {}),
							runTerminalOwner,
							onSettledActionResult,
							onResponseHandlerEarlyReply: deliverResponseHandlerEarlyReply,
							onStage1RespondDecision: () => {
								stage1DecidedRespond = true;
							},
						}),
					),
					timeInferenceSpan("message:ingress:parallel-respond-hooks", () =>
						runtime.applyPipelineHooks(
							"parallel_with_should_respond",
							parallelHookCtx,
						),
					),
				]);
				stage1RiskGateApplied = outcome.kind !== "terminal";
				stage1Extract = outcome.messageHandler.extract;
				const routedContexts = outcome.messageHandler.plan.contexts;
				routedDecision =
					routedContexts.length > 0
						? {
								primaryContext: routedContexts[0],
								secondaryContexts: routedContexts.slice(1),
							}
						: {};
				setContextRoutingMetadata(message, routedDecision);

				if (outcome.kind === "terminal" || outcome.kind === "decision") {
					shouldRespondToMessage = false;
					terminalDecision =
						outcome.action === "RESPOND" ? "IGNORE" : outcome.action;
					state = outcome.state;
				} else {
					shouldRespondToMessage = true;
					terminalDecision = null;
					strategyResult = outcome.result;
					_usedV5Runtime = true;
					state = outcome.result.state;
				}
			} catch (error) {
				// error-policy:J1 This is the user-message boundary: translate
				// planner/model failures into the designed structured failure state.
				const callerSignal = getStreamingContext()?.abortSignal;
				if (callerSignal?.aborted) {
					const reason = callerSignal.reason;
					throw reason instanceof TurnAbortedError
						? reason
						: new TurnAbortedError(
								reason instanceof Error ? reason.message : String(reason),
							);
				}
				if (
					error instanceof TurnAbortedError ||
					(isRecord(error) && error.code === "TURN_ABORTED")
				) {
					throw error;
				}
				if (isRecord(error) && error.code === "REPLY_GROUNDING_FAILED") {
					// The result renderer already exhausted its grounded model reply.
					// Effects may be committed: preserve the typed delivery failure for
					// the caller's settled-result handling, never synthesize an apology
					// from the pre-action state or invite a duplicate mutation.
					throw error;
				}
				if (hasSettledEffectEvidence) {
					// Preserve the original unexpected failure for the caller's
					// settled-result boundary. Do not make another model call from
					// pre-action state or invite replay of a completed mutation.
					throw error;
				}
				const errMsg = error instanceof Error ? error.message : String(error);
				const errStack = error instanceof Error ? error.stack : undefined;
				// Provider failures often surface with a masked statusText message
				// ("Bad Request") while the actionable cause lives on the AI SDK
				// error's responseBody — carry it so the failure is diagnosable
				// from logs and RECENT_ERRORS without a wire capture.
				const providerErrorDetail = modelProviderErrorDetail(error);
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						error: errMsg,
						stack: errStack,
						...(providerErrorDetail ? { providerErrorDetail } : {}),
					},
					"v5 message runtime failed",
				);
				runtime.reportError("MessageService.v5Runtime", error, {
					entityId: message.entityId,
					roomId: message.roomId,
					// This boundary owns user-facing failure delivery, including when
					// a fallback masks the original provider error. Retain diagnostics
					// without escalating a second, raw technical message into chat.
					diagnosticOnly: true,
					...(providerErrorDetail
						? { providerError: providerErrorDetail as JsonValue }
						: {}),
				});
				// Mirror to process.stderr so bench / orchestrator runs can see
				// the underlying cause when runtime.logger output is buffered or
				// silenced. The previous behavior swallowed the stack and only
				// the user-facing "something flaked" template appeared in
				// trajectories — making the cold-start failure-fallback issue
				// invisible in bench server logs.
				try {
					process.stderr.write(
						`[v5-runtime-failed] agentId=${runtime.agentId} ` +
							`error=${errMsg}\n${errStack ?? ""}\n`,
					);
				} catch {
					// error-policy:J5 The same failure is already observed by the
					// runtime logger and reportError immediately above.
				}
				// Rate limits and provider outages throw from the Stage 1 model
				// call itself — before any RESPOND/IGNORE decision exists. For
				// ambiguous group traffic the pre-failure outcome would have been
				// IGNORE, so an unconditional failure reply spams rooms that never
				// addressed the agent (observed live: 91 canned-failure sends in
				// 2 days into relay rooms during a rate-limit window). Surface
				// failure text only when the turn deterministically addressed the
				// agent (DM/API/SELF channel, platform mention/reply, whitelisted
				// source, name+tag address), the turn is autonomous, or an early
				// ack already went out (the user saw the bot engage). Everything
				// else stays silent, matching the IGNORE it would have gotten.
				const failureGate = this.isDeterministicallyAddressedTurn({
					runtime,
					message,
					room,
					mentionContext,
					isAutonomous,
					hasDeliveredEarlyReply: earlyReplyMessages.length > 0,
				});
				// Stage 1 already made the per-message RESPOND decision for this
				// turn before the runtime died — that is the model evaluation the
				// deterministic gate defers to, so the anti-spam suppression
				// (which exists for pre-decision throws) does not apply.
				if (failureGate.addressed || stage1DecidedRespond) {
					shouldRespondToMessage = true;
					terminalDecision = null;
					// Distinguish WHY the runtime died so the failure reply names
					// the real condition: a capability that was never invocable is
					// not a transient blip and must not read like one (#17027 AC6).
					const failureCause = classifyStructuredFailureCause(error);
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
							failureCause,
						},
						"MessageService: structured failure reply cause classified",
					);
					strategyResult = await this.host.buildStructuredFailureReply(
						runtime,
						message,
						state,
						responseId,
						"running the native tool message runtime",
						failureCause,
					);
					_usedV5Runtime = true;
					state = strategyResult.state;
				} else {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
							reason: failureGate.reason,
						},
						"v5 runtime failed before a respond decision on an unaddressed message; suppressing failure reply",
					);
					shouldRespondToMessage = false;
					terminalDecision = "IGNORE";
				}
			}
		} else if (!hasTextGenerationHandler(runtime)) {
			await runtime.applyPipelineHooks(
				"parallel_with_should_respond",
				parallelHookCtx,
			);
			// Without a text delegate, apply only deterministic gates. Ambiguous
			// group traffic that needs model judgment must not auto-reply with
			// NO_LLM_PROVIDER_REPLY.
			const checkShouldRespondEnabled = runtime.isCheckShouldRespondEnabled();
			const responseDecision = this.host.shouldRespond(
				runtime,
				message,
				room ?? undefined,
				mentionContext,
			);
			if (!checkShouldRespondEnabled) {
				routedDecision = withInferredContextRoutingFallback({}, message);
				setContextRoutingMetadata(message, routedDecision);
				shouldRespondToMessage = true;
			} else if (responseDecision.skipEvaluation) {
				routedDecision = withInferredContextRoutingFallback(
					parseContextRoutingMetadata(responseDecision),
					message,
				);
				setContextRoutingMetadata(message, routedDecision);
				shouldRespondToMessage = responseDecision.shouldRespond;
			} else {
				runtime.logger.debug(
					{
						src: "service:message",
						agentId: runtime.agentId,
						reason: responseDecision.reason,
					},
					"No text-generation handler: skipping message that requires LLM should-respond",
				);
				shouldRespondToMessage = false;
			}
			terminalDecision = null;
			if (shouldRespondToMessage) {
				strategyResult = this.host.buildNoModelProviderReply(
					runtime,
					message,
					state,
					responseId,
					"v5 message handling",
				);
				_usedV5Runtime = true;
			}
		}

		// #9949: role-keyed injection / social-engineering verify gate. The
		// deterministic RiskFactors were stamped during the
		// parallel_with_should_respond phase; here — and only when we are about
		// to respond — escalate a borderline USER/GUEST message to a single
		// TEXT_LARGE adjudication. OWNER/ADMIN bypass; benign traffic short-circuits
		// before any model call. A blocked verdict suppresses the response.
		if (shouldRespondToMessage && !stage1RiskGateApplied) {
			const injectionGate = await timeInferenceSpan(
				"evaluators:injection-risk-gate",
				() =>
					runShouldRespondInjectionGate({
						runtime,
						message,
						// Per-turn role already resolved in handleMessage; fall back to a
						// fresh lookup only outside a trajectory scope.
						resolveSenderRole: () =>
							getTrajectoryContext()?.userRole ??
							resolveStage1SenderRole(runtime, message),
					}),
			);
			if (injectionGate.blocked) {
				shouldRespondToMessage = false;
				terminalDecision = null;
				strategyResult = null;
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						reason: injectionGate.reason,
						score: injectionGate.score,
					},
					"[ShouldRespondRiskGate] suppressing response: injection/social-engineering verify blocked",
				);
			}
		}

		const joinedTranslation =
			typeof parallelJoin.translatedUserText === "string"
				? parallelJoin.translatedUserText
				: undefined;
		if (
			joinedTranslation !== undefined &&
			joinedTranslation !== message.content.text
		) {
			message.content.text = joinedTranslation;
			if (message.id) {
				await runtime.updateMemory({
					id: message.id,
					content: message.content,
				});
				await runtime.queueEmbeddingGeneration(
					{ ...message, id: message.id },
					"normal",
				);
			}
			if (message.id) {
				runtime.stateCache.delete(message.id);
				runtime.stateCache.delete(`${message.id}_action_results`);
			}
			state = await composeResponseState(runtime, message);
			state = attachAvailableContexts(state, runtime);
		}

		let responseContent: Content | null = null;
		let responseMessages: Memory[] = [];
		const persistedResponseMessageIds = new Set<UUID>(
			Array.from(persistedEarlyReplyIds, (id) => id as UUID),
		);
		let actionResults: ActionResult[] | undefined;
		let replyRecovery: MessageReplyRecoveryContext | undefined;
		let terminalFailure: MessageTerminalFailure | undefined;
		let mode: StrategyMode = "none";

		if (shouldRespondToMessage) {
			let result: StrategyResult;
			if (strategyResult) {
				result = strategyResult;
			} else {
				_usedV5Runtime = true;
				// No thrown trajectory error reaches this fallback-only branch, so
				// there is no structural capability/exhaustion cause to preserve.
				// Keep the default generic transient classification.
				result = await this.host.buildStructuredFailureReply(
					runtime,
					message,
					state,
					responseId,
					"running the native tool message runtime",
				);
			}

			responseContent = result.responseContent;
			responseMessages =
				earlyReplyMessages.length > 0
					? [...earlyReplyMessages, ...result.responseMessages]
					: result.responseMessages;
			state = result.state;
			actionResults = result.actionResults;
			replyRecovery = result.replyRecovery;
			terminalFailure = result.terminalFailure;
			mode = result.mode;

			// Race check before we send anything.
			//
			// When a newer message arrives in the same room while we were
			// generating a response, the default behavior is to drop the older
			// response so the bot only replies to the freshest input.
			//
			// Keep only a deliverable response carrying the explicit REPLY/RESPOND
			// marker. Action results opt into the user channel through userFacingText,
			// and that path constructs the same explicit reply marker.
			const currentResponseId = getLatestResponseId(
				runtime.agentId,
				message.roomId,
			);
			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				const keepReason = resolveSupersededResponseKeepReason(responseContent);
				if (keepReason) {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						`Race detected but keeping response (${keepReason})`,
					);
				} else {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						"Response discarded - newer message being processed",
					);
					// Mirror the ignore-path sibling below: a superseded turn ends
					// its run as "replaced" so the discard is an observable terminal
					// outcome instead of an unrecorded nothing.
					runTerminalOwner.request("replaced");
					return {
						didRespond: false,
						responseContent: null,
						responseMessages: [],
						state,
						mode: "none",
					};
				}
			}

			if (responseContent && message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}
			if (responseContent) {
				responseContent = await enforceTrustedDeliveryAudienceAtEgress(
					runtime,
					message,
					responseContent,
				);
			}

			// Save response memory to database.
			// - simple mode: persists after hooks in the branch below.
			// - actions mode: do NOT persist the initial LLM text here.
			//   The action callbacks produce the real user-facing messages;
			//   saving the planner text now would emit a premature reply that
			//   may be contradicted once the action completes or fails.
			// - other non-simple modes (e.g. "none"): persist immediately.
			if (
				responseMessages.length > 0 &&
				mode !== "simple" &&
				mode !== "actions"
			) {
				for (const responseMemory of responseMessages) {
					if (
						responseMemory.id &&
						persistedEarlyReplyIds.has(responseMemory.id)
					) {
						continue;
					}
					// Update the content in case inReplyTo was added
					if (responseContent) {
						responseContent = await enforceTrustedDeliveryAudienceAtEgress(
							runtime,
							message,
							responseContent,
						);
						responseMemory.content = responseContent;
					}
					if (shouldSkipResponseMemoryPersistence(responseMemory)) {
						runtime.logger.debug(
							{ src: "service:message", memoryId: responseMemory.id },
							"Skipping transient response memory persistence",
						);
						continue;
					}
					runtime.logger.debug(
						{ src: "service:message", memoryId: responseMemory.id },
						"Saving response to memory",
					);
					await timeInferenceSpan("message:delivery:persistence", () =>
						runtime.createMemory(responseMemory, "messages"),
					);
					if (responseMemory.id) {
						persistedResponseMessageIds.add(responseMemory.id);
					}

					await timeInferenceSpan("message:delivery:event", () =>
						this.emitMessageSent(
							runtime,
							responseMemory,
							message.content.source ?? "messageHandler",
						),
					);
				}
			}

			if (responseContent) {
				let deliverableResponseContent = responseContent;
				if (mode === "simple") {
					// Keep content hooks before delivery so the wire response carries
					// their edits. The response-memory DB write starts alongside the
					// callback so its largest post-LLM cost (~250-440ms measured via
					// the message:delivery:persistence InferenceTiming span) does not
					// delay delivery. Both operations still settle before this turn
					// proceeds, so
					// everything downstream in THIS turn (MESSAGE_SENT, post-turn
					// evaluators, followUp) observes the stored reply — and a
					// CONCURRENT same-room turn started off this delivery waits on
					// the pendingReplyPersists barrier before composing, so its
					// RECENT_MESSAGES read observes it too. Do not put MESSAGE_SENT
					// handlers or post-turn evaluators before the callback; they are
					// side effects and must not stall user-visible streaming.
					await timeInferenceSpan("message:delivery:hooks", () =>
						runtime.applyPipelineHooks(
							"outgoing_before_deliver",
							outgoingPipelineHookContext(deliverableResponseContent, {
								source: "simple",
								roomId: message.roomId,
								message,
								responseId:
									deliverableResponseContent.responseId ??
									responseMessages[0]?.id,
							}),
						),
					);
					deliverableResponseContent =
						await enforceEffectGroundedVisibleContent(
							runtime,
							message,
							deliverableResponseContent,
						);
					deliverableResponseContent =
						await enforceTrustedDeliveryAudienceAtEgress(
							runtime,
							message,
							deliverableResponseContent,
						);
					responseContent = deliverableResponseContent;
					// Registered BEFORE the callback fires so a follow-up prompted
					// by this delivery always finds the barrier pending; released
					// (never rejected) in the finally once the persist settles.
					const releaseReplyPersistBarrier =
						this.host.registerPendingReplyPersist(runtime, message.roomId);
					try {
						// Settled-result handling instead of catch blocks: a delivery
						// failure must not skip the persist, and callers classify the
						// raw delivery error by identity (TURN_ABORTED / generation-
						// timeout checks at the conversation route), so both failures
						// are rethrown UNCHANGED after both operations settle.
						const deliveryTask = callback
							? timeInferenceSpan("message:delivery:callback", () =>
									callback(deliverableResponseContent),
								).then((value) => {
									markInference(INFERENCE_MARKS.replyDelivered);
									return value;
								})
							: Promise.resolve(undefined);
						// Memories owed a MESSAGE_SENT claim once — and only if — the
						// delivery boundary succeeds. Collected during the persist pass
						// (which runs concurrently with the callback), committed below
						// strictly after both operations settle.
						const deliveredClaimMemories: Memory[] = [];
						const persistTask = (async () => {
							for (const responseMemory of responseMessages) {
								if (
									responseMemory.id &&
									persistedEarlyReplyIds.has(responseMemory.id)
								) {
									continue;
								}
								responseMemory.content =
									await enforceTrustedDeliveryAudienceAtEgress(
										runtime,
										message,
										deliverableResponseContent,
									);
								if (shouldSkipResponseMemoryPersistence(responseMemory)) {
									runtime.logger.debug(
										{ src: "service:message", memoryId: responseMemory.id },
										"Skipping transient response memory persistence",
									);
								} else {
									runtime.logger.debug(
										{ src: "service:message", memoryId: responseMemory.id },
										"Saving response to memory",
									);
									await timeInferenceSpan("message:delivery:persistence", () =>
										runtime.createMemory(responseMemory, "messages"),
									);
									if (responseMemory.id) {
										persistedResponseMessageIds.add(responseMemory.id);
									}
								}
								deliveredClaimMemories.push(responseMemory);
							}
						})();
						const [deliveryOutcome, persistOutcome] = await Promise.allSettled([
							deliveryTask,
							persistTask,
						]);
						// MESSAGE_SENT signals delivery, not persistence — and delivery
						// is only a fact once the callback boundary has resolved.
						// Claiming from inside the persist pass raced the callback and
						// recorded a durable sent-claim for deliveries that then failed,
						// turning a dropped reply into recorded success. The claim
						// commits here, strictly after the boundary succeeded: a
						// rejected callback produces no claim, and the error rethrown
						// below reaches the caller with the turn still unclaimed, so a
						// later retry that delivers can claim exactly once. It still
						// fires for transient/doNotPersist replies (structured failure
						// replies skip the memory write above): their delivery is just
						// as real, and suppressing the event made those delivered turns
						// indistinguishable from drops in logs, activity streams, and
						// trajectory closure.
						if (deliveryOutcome.status === "fulfilled") {
							for (const responseMemory of deliveredClaimMemories) {
								runTerminalOwner.track("MESSAGE_SENT", () =>
									this.emitMessageSent(
										runtime,
										responseMemory,
										message.content.source ?? "messageHandler",
									),
								);
							}
						}
						if (persistOutcome.status === "rejected") {
							// The persist failure (data loss) outranks the delivery
							// failure for propagation; the held delivery failure is
							// reported so it is never silently superseded.
							if (deliveryOutcome.status === "rejected") {
								runtime.reportError(
									"MessageService.simpleDeliveryCallback",
									deliveryOutcome.reason,
									{
										agentId: runtime.agentId,
										roomId: message.roomId,
									},
								);
							}
							throw persistOutcome.reason;
						}
						if (deliveryOutcome.status === "rejected") {
							throw deliveryOutcome.reason;
						}
					} finally {
						releaseReplyPersistBarrier();
					}
				}
			}
		} else {
			// Agent decided not to respond
			runtime.logger.debug(
				{ src: "service:message" },
				"Agent decided not to respond",
			);

			// Check if we still have the latest response ID
			const currentResponseId = getLatestResponseId(
				runtime.agentId,
				message.roomId,
			);

			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						roomId: message.roomId,
					},
					"Ignore response discarded - newer message being processed",
				);
				runTerminalOwner.request("replaced");
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			if (!message.id) {
				runtime.logger.error(
					{ src: "service:message", agentId: runtime.agentId },
					"Message ID is missing, cannot create ignore response",
				);
				runTerminalOwner.request("noMessageId");
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			// Construct a minimal content object indicating the terminal decision
			const terminalAction = terminalDecision ?? "IGNORE";
			let terminalContent: Content = {
				thought:
					terminalAction === "STOP"
						? "Agent decided to stop and end the run."
						: "Agent decided not to respond to this message.",
				actions: [terminalAction],
				inReplyTo: createUniqueUuid(runtime, message.id),
			};

			await timeInferenceSpan("message:delivery:hooks", () =>
				runtime.applyPipelineHooks(
					"outgoing_before_deliver",
					outgoingPipelineHookContext(terminalContent, {
						source: "excluded",
						roomId: message.roomId,
						message,
					}),
				),
			);
			terminalContent = await enforceTrustedDeliveryAudienceAtEgress(
				runtime,
				message,
				terminalContent,
			);

			const terminalMemory: Memory = {
				id: asUUID(v4()),
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: terminalContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			};
			await timeInferenceSpan("message:delivery:persistence", () =>
				runtime.createMemory(terminalMemory, "messages"),
			);
			await timeInferenceSpan("message:delivery:event", () =>
				this.emitMessageSent(
					runtime,
					terminalMemory,
					message.content.source ?? "messageHandler",
				),
			);
			runtime.logger.debug(
				{ src: "service:message", memoryId: terminalMemory.id },
				"Saved terminal response to memory",
			);

			if (
				callback &&
				!(terminalAction === "IGNORE" && isVoiceChannelMessage(message))
			) {
				await timeInferenceSpan("message:delivery:callback", () =>
					callback(terminalContent),
				);
			}
		}

		// Clean up the response ID
		clearLatestResponseId(runtime.agentId, message.roomId, responseId);
		({ responseContent, responseMessages } =
			await enforceTrustedDeliveryAudienceOnResult(
				runtime,
				message,
				responseContent,
				responseMessages,
			));

		// Post-turn evaluation durably queues replay-safe memory extraction. Legacy
		// evaluators and ALWAYS_AFTER plugin hooks retain their ordered boundary.
		const didRespondGate =
			shouldRespondToMessage && !isStopResponse(responseContent);
		const semanticSignal = hasPostTurnSemanticSignal(
			message,
			state,
			responseContent,
			stage1Extract,
		);
		// Delivery settlement precedes the durable enqueue. The foreground trajectory
		// waits for enqueueing and ordered legacy/hooks; TaskService owns subsequent
		// memory inference in a separate trajectory and reacquires the room to write.
		runTerminalOwner.trackAfterDelivery("post_turn", async () => {
			if (actionResults?.some((result) => result.replyFailure !== undefined)) {
				// The action already settled and response generation is unavailable.
				// Close the run without another evaluation/model or action hook.
				return;
			}
			await withEvaluatorStep(runtime, "post_turn", async () => {
				if (semanticSignal) {
					await runPostTurnEvaluators(runtime, message, state, {
						didRespond: didRespondGate,
						responses: responseMessages,
						semanticSignal,
					});
				}
				await runtime.runActionsByMode("ALWAYS_AFTER", message, state, {
					didRespond: didRespondGate,
					responses: responseMessages,
				});
			});
		});

		const didRespond =
			responseMessages.length > 0 && !isStopResponse(responseContent);

		// Collect metadata for logging
		let entityName = "noname";
		if (
			message.metadata &&
			"entityName" in message.metadata &&
			typeof message.metadata.entityName === "string"
		) {
			entityName = message.metadata.entityName;
		}

		const isDM =
			message.content && message.content.channelType === ChannelType.DM;
		let roomName = entityName;

		if (!isDM) {
			const roomDatas = await timeInferenceSpan(
				"message:lifecycle:log-context-room",
				() => runtime.getRoomsByIds([message.roomId]),
			);
			if (roomDatas?.length) {
				const roomData = roomDatas[0];
				if (roomData.name) {
					roomName = roomData.name;
				}
				if (roomData.worldId) {
					const worldId = roomData.worldId;
					const worldData = await timeInferenceSpan(
						"message:lifecycle:log-context-world",
						() => runtime.getWorld(worldId),
					);
					if (worldData) {
						roomName = `${worldData.name}-${roomName}`;
					}
				}
			}
		}

		const date = new Date();
		// Extract available actions from provider data
		const stateData = state.data;
		const stateDataProviders = stateData?.providers;
		const actionsProvider = stateDataProviders?.ACTIONS;
		const actionsProviderData = actionsProvider?.data;
		const actionsData =
			actionsProviderData && "actionsData" in actionsProviderData
				? (actionsProviderData.actionsData as Array<{ name: string }>)
				: undefined;
		const availableActions = actionsData?.map((a) => a.name) ?? [];

		const _logData = {
			at: date.toString(),
			timestamp: Math.floor(date.getTime() / 1000),
			messageId: message.id,
			userEntityId: message.entityId,
			input: message.content.text,
			thought: responseContent?.thought,
			availableActions,
			actions: responseContent?.actions,
			providers: responseContent?.providers,
			irt: responseContent?.inReplyTo,
			output: responseContent?.text,
			entityName,
			source: message.content.source,
			channelType: message.content.channelType,
			roomName,
		};

		return {
			didRespond,
			responseContent,
			responseMessages,
			...(persistedResponseMessageIds.size > 0
				? {
						persistedResponseMessageIds: Array.from(
							persistedResponseMessageIds,
						),
					}
				: {}),
			...(actionResults ? { actionResults } : {}),
			...(replyRecovery ? { replyRecovery } : {}),
			...(terminalFailure ? { terminalFailure } : {}),
			state,
			mode,
		};
	}

	/**
	 * Deterministic "this turn addressed the agent" predicate shared by the
	 * Stage-1 failure catch (failure-reply gating) and the race-discard check.
	 * Both are silent-exit gates: when they misjudge an addressed turn the user
	 * sees terminal, unobservable silence — so they must agree on exactly which
	 * turns owe the user a delivery. Addressed means: a deterministic
	 * shouldRespond hit (DM/API/SELF channel, whitelisted source), a platform
	 * mention or reply, an autonomous turn, or a turn where an early ack
	 * already went out (the user watched the agent engage).
	 */
	isDeterministicallyAddressedTurn(args: {
		runtime: IAgentRuntime;
		message: Memory;
		room: Room | null | undefined;
		mentionContext: MentionContext | undefined;
		isAutonomous: boolean;
		hasDeliveredEarlyReply: boolean;
	}): { addressed: boolean; reason: string | undefined } {
		const gate = this.host.shouldRespond(
			args.runtime,
			args.message,
			args.room ?? undefined,
			args.mentionContext,
		);
		return {
			addressed:
				gate.shouldRespond ||
				args.mentionContext?.isMention === true ||
				args.mentionContext?.isReply === true ||
				args.isAutonomous ||
				args.hasDeliveredEarlyReply,
			reason: gate.reason,
		};
	}

	async emitMessageSent(
		runtime: IAgentRuntime,
		message: Memory,
		source: string,
	): Promise<void> {
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message,
			source,
			trajectoryTerminalOwner: "run",
		});
	}
}
