/** Assembles message context from ordered dialogue, selected providers, and the authorized action surface. */

import { v4 } from "uuid";
import { actionToTool, CORE_PLANNER_TERMINALS } from "../../actions/to-tool";
import { canActionRun } from "../../runtime/action-gate";
import { createContextObject } from "../../runtime/context-object";
import {
	buildCanonicalSystemPrompt,
	buildCharacterStyleDirections,
} from "../../runtime/system-prompt";
import type { Action, AgentContext } from "../../types/components";
import type { ContextEvent, ContextObject } from "../../types/context-object";
import type { ContextDefinition, RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import { MESSAGE_SOURCE_TRIGGER_PROMPT } from "../../types/message-source";
import type { ToolDefinition } from "../../types/model";
import type { JsonValue } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	collectV5PlannerCandidateActions,
	type V5PlannerActionSurface,
} from "./action-surface.js";
import { createContextCatalogReadEvent } from "./context-catalog.js";
import {
	appendPriorDialogueEvents,
	appendStateProviderEvents,
	currentMessageContentForContext,
	hasStructuredRecentMessagesProvider,
	replyReferenceEventForContext,
} from "./dialogue-context.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import { MODEL_CONTEXT_PROVIDER_EXCLUSIONS } from "./provider-state.js";

/** One owner for the current-turn policy; source-reference capability changes
 * only its recall guidance, preserving the same request and effect boundary. */
export function buildCurrentTurnBoundary({
	includeTools = false,
	hasMemoryRecallSurface,
	hasOriginalReferences = false,
}: {
	includeTools?: boolean;
	hasMemoryRecallSurface: boolean;
	hasOriginalReferences?: boolean;
}): string {
	const recallGuidance = hasOriginalReferences
		? "For conversation recall, answer from supplied originals and read any missing original before answering. The blocks above are a selection, not all prior dialogue. An omitted detail is not an absent fact. A recall question itself requests the needed history lookup; the user need not separately ask you to search."
		: "Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message, did you yourself say W), you may scan the prior_message blocks above and answer from what is literally visible there.";
	const recallScope = hasOriginalReferences
		? "These conversation originals establish what was said, not current app state."
		: "This recall exception covers only what was literally SAID in the visible chat.";
	const ownReplyGuidance = hasOriginalReferences
		? "Your own prior replies are the original assistant messages. Read missing originals before asserting or denying what you said, told or promised; later assistant uncertainty does not erase earlier evidence."
		: "Your own prior replies are the prior_message:agent blocks: when asked what YOU said, told, or promised earlier, answer only from those blocks — never assert you said something that does not appear in them, and never deny saying something that does.";
	return includeTools
		? "current_turn_boundary: Plan and execute only the final message:user. Prior messages and reply_reference are context for resolving references, never pending commands. The prior_message:agent blocks are your own earlier replies, historical dialogue for resolving continuations, recalled details and corrections. They are not proof of current state or newly executed effects. For a historical conversation question, inspect the earlier dialogue and apply the user's later corrections. A later assistant claim that it lacks a detail does not erase earlier message evidence. Keep each person's details separate. If original evidence is still needed, discover and use authorized memory retrieval instead of asking the user to repeat accessible history. For live data or effects, verify with current tools. Stage 1 already decided this turn needs tools; use current tool results for live data and side effects, never answer by repeating a prior reply in place of executing the fresh check, and never claim work that no tool result proves."
		: "current_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. " +
				recallGuidance +
				" A verified_cross_room_message block is authorized visible context from this requester's linked private rooms: if the requested fact appears literally in its message text, attachment description, or transcript, answer directly from that block. This is recall, not inspection of a current-turn attachment or a live calendar lookup, so it does not require ATTACHMENT, CALENDAR, or another tool; never infer details absent from the block or expose a private attachment URL. " +
				recallScope +
				' It does NOT cover the user\'s tracked work: a recap, status, or what-did-I-get-done ask about their todos, tasks, reminders, habits, goals, notes, or day ("recap my day", "what\'s left today", "did I finish everything", "how did I do this week") is a live tasks lookup, not chat recall — route it to the tasks tools and answer from what they return; never report an empty or missing day from the visible window alone.' +
				// The planning boundary above also distinguishes historical recall
				// from current tool verification.
				(includeTools ? "" : ` ${ownReplyGuidance}`) +
				' Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly.' +
				(hasOriginalReferences
					? ' Use supplied originals and FACTS for recall, preserving speakers, scope and corrections. Read needed deferred conversation originals through contextRequests=["history:hN"]; use "history:all" when you cannot identify the source, interpretation is uncertain, or the question needs every original in this conversation. These reads do not access other rooms, query live app records or execute effects. Do not claim an unseen detail is absent before resolving the reference. An explicit request to search stored records or repeat a lookup, missing stored metadata, or a count across stored records still requires authorized memory retrieval; these conversation references are not proof of all stored records. If the user disallows app/storage tools, use the same-conversation original reads and report any remaining gap without fabricating a search. Never substitute historical dialogue for current app data. When asked about a task, build, deployment or agent run, use its authorized status tools before reporting a current outcome.'
					: hasMemoryRecallSurface
						? ' The prior_message blocks are supplied authorized dialogue; do not assume they represent every stored record. Use supplied dialogue and FACTS directly for remembered details, respecting corrections. When FACTS is advertised as context_discovery and the detail is absent, request FACTS before deciding a broader search is needed. Quote supplied original text and authors directly when only recall is requested. An explicit request to search stored messages or repeat a lookup requires a current search even when an earlier reply contains the answer: select the memory context, include the search in intents and name its authorized operation in candidateActionNames. Missing source evidence, requested metadata absent from context and whole-history counts also require memory retrieval. If the user disallows lookup, use only supplied evidence and state any actual gap. Never answer an exhaustive stored-record count from rendered dialogue or facts alone, and never claim a search or live verification that did not run. Run status is equally checkable: when the final message asks "what happened with [the build/app/task]" or disputes whether something you ran actually worked, select the applicable non-simple contexts, verification intents and candidateActionNames and CHECK the current task/sub-agent status with a tool before reporting, disclaiming, or conceding — never say you cannot verify a run you can look up.'
						: ' Use supplied dialogue and FACTS directly for remembered details, respecting corrections. If FACTS is advertised as context_discovery and the detail is absent, request it before answering. Beyond supplied context, there is no separate chat-history search tool on this turn. Only when supplied dialogue and available facts cannot answer, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action. If the user asks for a whole-conversation count or another exhaustive history claim ("how many times have I mentioned X", "have I ever told you Y"), never present visible matches as the full-history answer: either decline to give a total, or explicitly label any observation as limited to the recent messages you can see and say older history cannot be verified. This "no chat-history search" limit is about CHAT recall ONLY. It does NOT apply to what a task, build, deploy, or sub-agent YOU ran actually did: that run status IS verifiable with the task/sub-agent tools. So when the final message asks "what happened with [the build/app/task]" or disputes whether something you ran actually worked, select the applicable non-simple contexts, verification intents and candidateActionNames and CHECK the current task/sub-agent status with a tool before reporting, disclaiming, or conceding — never say you cannot verify a run you can look up.');
}

export async function createV5MessageContextObject(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	selectedContexts?: readonly AgentContext[];
	includeTools?: boolean;
	/** A framework catalog reference was requested earlier in this turn. */
	includeContextCatalog?: boolean;
	/** Per-turn routing catalog for the response handler, which has no action tools. */
	includeActionDiscovery?: boolean | "index";
	userRoles?: readonly RoleGateRole[];
	availableContexts?: readonly ContextDefinition[];
	extraProviderExclusions?: readonly string[];
	preselectedActions?: readonly Action[];
	actionSurface?: V5PlannerActionSurface;
	/**
	 * Structural "this turn does not address the agent" signal (the
	 * isUnaddressedTextGroupTurn classifier — channel type + addressing +
	 * source metadata, never message text). When set, the rendered context
	 * carries the ambient-turn policy instruction; absent/false renders
	 * byte-identical to before, so addressed turns are untouched.
	 */
	ambientTurn?: boolean;
	/**
	 * When the ambient turn's effective reply_gate is the restrained
	 * `addressed_or_ambient` mode, Stage-1 renders the HARD-GATE IGNORE bias;
	 * otherwise the participatory default policy renders (no @-mention needed,
	 * model judges each turn on concrete value).
	 */
	ambientHardGate?: boolean;
	/** Trusted same-speaker continuation after a recent correction of this agent. */
	peerCorrectionContinuation?: boolean;
}): Promise<ContextObject> {
	const events: ContextEvent[] = [];

	const renderExclusions = [
		...MODEL_CONTEXT_PROVIDER_EXCLUSIONS,
		...(args.extraProviderExclusions ?? []),
		// The recent-messages provider exposes structured prior turns in
		// data.recentMessages. appendPriorDialogueEvents renders those as proper
		// chat-message events, so also rendering provider.text would duplicate the
		// same conversation and can leak stored assistant thought/action metadata
		// into the prompt. Keep the text fallback only for legacy/unstructured
		// provider states.
		...(hasStructuredRecentMessagesProvider(args.state)
			? ["RECENT_MESSAGES"]
			: []),
	];
	appendStateProviderEvents(
		events,
		args.state,
		renderExclusions,
		args.runtime.providers,
	);

	if (args.includeContextCatalog) {
		events.push(
			await createContextCatalogReadEvent(args.runtime, args.message),
		);
	}

	if (hasStructuredRecentMessagesProvider(args.state)) {
		events.push({
			id: "prior-dialogue-policy",
			type: "segment",
			source: "message-service",
			segment: {
				id: "prior-dialogue-policy",
				label: "system",
				content:
					"prior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn's tools/context instead of answering from prior tool results or stale sub-agent transcripts.",
				stable: true,
			},
		});
	}

	// Planning and restoration need the same complete historical dialogue as
	// interpretation. Prior answers remain history, never current effect proof.
	appendPriorDialogueEvents(events, args.runtime, args.state, args.message, {
		includeOwnReplies: true,
	});

	// Contexts are routing taxonomy, not proof that a handler exists. Promise
	// beyond-window recall only when this role can execute the registered MEMORY
	// action and its declared discriminator explicitly includes search; custom
	// runtimes that register only the context must keep the honest bounded-window
	// response instead of escalating to a tool the planner cannot expose.
	const hasMemoryRecallSurface =
		(args.availableContexts ?? []).some((context) => context.id === "memory") &&
		(args.runtime.actions ?? []).some((action) => {
			if (normalizeActionIdentifier(action.name) !== "MEMORY") {
				return false;
			}
			const searchDiscriminator = action.parameters?.some((parameter) => {
				const name = normalizeActionIdentifier(parameter.name);
				if (name !== "ACTION" && name !== "OP") {
					return false;
				}
				// schema is required by ActionParameter, but an untyped third-party
				// plugin can register a malformed parameter; a capability probe must
				// not throw on it.
				return [
					...(parameter.schema?.enum ?? []),
					...(parameter.schema?.enumValues ?? []),
				].some((value) => normalizeActionIdentifier(value) === "SEARCH");
			});
			return (
				searchDiscriminator === true &&
				canActionRun(action, {
					message: args.message,
					activeContexts: ["memory"],
					userRoles: args.userRoles,
				})
			);
		});
	events.push({
		id: "current-turn-boundary",
		type: "instruction",
		source: "message-service",
		stable: false,
		content: buildCurrentTurnBoundary({
			includeTools: args.includeTools,
			hasMemoryRecallSurface,
		}),
	});

	// Prompt automations execute without a visible human message; their reply is
	// the delivered result. Make that boundary explicit so the model performs
	// the instruction instead of acknowledging framing the recipient never sees.
	if (args.message.content.source === MESSAGE_SOURCE_TRIGGER_PROMPT) {
		events.push({
			id: "trigger-automation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'trigger_automation_policy: The final message:user below is a scheduled automation of yours firing, not a person talking to you. Its "Do this now:" clause is the instruction you must carry out on this turn, and whatever you reply is delivered to the user as the automation\'s output. Produce that output: if the instruction is to remind, the reply IS the reminder addressed to the user — phrase it in your voice so it reads as a reminder arriving (lead with something like "reminder:" or equivalent), never a bare echo of the item text alone; if it is to check or report something, run the needed tools and reply with the result. Never reply with an acknowledgement of the instruction itself ("noted.", "got it", "will do") — the user never sees the instruction, so an acknowledgement reaches them as a bare non-sequitur.',
		});
	}

	// Ambient-turn policy (live incident tj-f637475edcb7bd): on an unaddressed
	// group turn the planner ran, produced no tool activity, and still shipped
	// a filler completion as the reply. Nothing in the planner prompt told the
	// model the turn was ambient, so "end the turn" read as "compose a status".
	// Rendered only when the caller's structural classifier flagged the turn
	// ambient — addressed turns (and callers that do not pass the flag) render
	// byte-identical context, and the IGNORE terminal invoked here already
	// flows to deliberate, recorded non-delivery (see the ambient
	// deliberate-silence terminal in runV5MessageRuntimeStage1).
	//
	// The instruction names the SHAPE of a process description and quotes no
	// sentence. It used to quote HANDLED_STEP_FALLBACK_MESSAGE as its negative
	// example, which bought nothing: that string is runtime-emitted, so no
	// instruction could suppress it, while an emittable forbidden sentence
	// sitting in context is a live hazard on weak models. The guarantee is
	// structural now, in the terminal named above.
	if (args.ambientTurn) {
		events.push({
			id: "ambient-turn-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content: args.includeTools
				? "ambient_turn_policy: The final message:user below was not addressed to you — it is other participants talking to each other, and no reply is expected from you. Contribute only if this turn's work produced something concrete and useful to those participants (a tool result, a substantive answer to what they are discussing). If your work yields nothing concrete to contribute, end the turn by calling the IGNORE tool — deliberate silence — instead of composing a reply. Never send a status update, a progress note, or a description of your own process as the reply — any sentence whose subject is what you did, tried, handled, or checked rather than what they are discussing: on an unaddressed message, an empty outcome means silence."
				: args.ambientHardGate
					? // Restrained opt-in (reply_gate=addressed_or_ambient): the
						// quiet-ambient bias, kept for rooms that want it. Live group-chat
						// evaluation (five ambient-mode rooms, gemma-4-31b) replied to
						// nearly every unaddressed message — "Hard to miss.", "Sounds
						// like the move." — a running commentary nobody asked for; this
						// mode keeps that hard IGNORE default.
						"ambient_turn_policy: HARD GATE. The final message:user below was not addressed to you — it is other participants talking to each other, and no reply is expected from you. Default shouldRespond=IGNORE. You MUST set shouldRespond=IGNORE unless the current turn explicitly challenges or asks to clarify your immediately preceding prior_message:agent reply, silence would allow a concrete consequential error or harm you can specifically prevent, or an explicit standing responsibility makes this turn yours to handle. A broadcast question, a useful fact you could add, your ability to answer, or your desire to keep the discussion moving is never enough. IGNORE banter, jokes, reactions, acknowledgements, open group questions, and side chatter where you would only answer, agree, comment, restate, or continue the conversation. Having replied earlier is a reason to stay silent unless the current turn directly challenges or needs clarification of that reply."
					: // Participatory default: no @-mention required — the agent is a
						// full participant and judges each unaddressed turn on concrete
						// value. Chatter still resolves to IGNORE, so ambient rooms get
						// contribution, not commentary.
						"ambient_turn_policy: The final message:user below was not addressed to you — it is other participants talking to each other. You are a full participant in this room and need no @-mention to reply, but replying is optional: judge each turn on concrete value. Set shouldRespond=RESPOND when you can add something genuinely useful — answer a question you can answer well, correct a consequential error, supply a fact or next step the discussion is missing. Set shouldRespond=IGNORE for banter, jokes, reactions, acknowledgements, and side chatter where you would only agree, restate, or keep the conversation moving. Do not reply to every message; when you do reply, be brief and on-topic.",
		});
	}
	if (args.peerCorrectionContinuation) {
		events.push({
			id: "peer-correction-continuation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				"peer_correction_continuation_policy: Trusted recent-message structure shows that the current participant corrected your last contribution and is now continuing within the same short exchange. Set shouldRespond=RESPOND. Follow the correction in a brief, natural acknowledgment; do not repeat the behavior they corrected or add unsolicited advice.",
		});
	}

	// A fired prompt-automation is an INSTRUCTION to carry out now, not a
	// notification to acknowledge. Live incident 2026-08-05 01:00: a "take
	// vitamins" reminder fired and the turn replied "noted." — the model read
	// "Scheduled trigger ... fired. Do this now: <instructions>" as a status
	// message about itself and acknowledged it, so the user got an
	// acknowledgement instead of the reminder. Gated on the connector-set
	// source (never on message text), the same structural shape the ambient
	// classifier uses: the reply of an automation turn IS its user-facing
	// output.
	if (args.message.content.source === MESSAGE_SOURCE_TRIGGER_PROMPT) {
		events.push({
			id: "trigger-automation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'trigger_automation_policy: The final message:user below is a scheduled automation of yours firing, not a person talking to you. Its "Do this now:" clause is the instruction you must carry out on this turn, and whatever you reply is delivered to the user as the automation\'s output. Produce that output: if the instruction is to remind, the reply IS the reminder addressed to the user — phrase it in your voice so it reads as a reminder arriving (lead with something like "reminder:" or equivalent), never a bare echo of the item text alone; if it is to check or report something, run the needed tools and reply with the result. Never reply with an acknowledgement of the instruction itself ("noted.", "got it", "will do") — the user never sees the instruction, so an acknowledgement reaches them as a bare non-sequitur.',
		});
	}

	if (args.includeActionDiscovery) {
		const actions = await collectV5PlannerCandidateActions({
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			selectedContexts: args.selectedContexts,
			userRoles: args.userRoles,
			discoverActions: true,
		});
		// Every name remains visible. Full reference text and schemas are read
		// through the existing permission-checked planner discovery protocol.
		const fullCatalog = JSON.stringify(
			actions.map((action) => ({
				name: action.name,
				description: action.description,
				contexts: action.contexts,
				similes: action.similes,
			})),
		);
		const index = [
			// This is a name lookup index, not the planner's relevance ranking.
			// Keep equal authorized sets byte-identical when the active view changes.
			JSON.stringify(actions.map((action) => action.name).sort()),
			"All currently authorized action names are listed above. For a known operation, name its exact action in candidateActionNames. When descriptions or aliases are needed to identify or explain a capability, select DISCOVER_TOOLS and a non-simple context: the planner can read complete descriptions with names=[] and load complete schemas by exact name. Do not infer that an unfamiliar name means a capability is absent. Discovery is reference reading, never execution or permission. A conversational reply needs no discovery.",
		].join("\n");
		events.push({
			id: "available-actions",
			type: "segment",
			source: "message-service",
			segment: {
				id: "available-actions",
				label: "available_actions",
				stable: false,
				content:
					args.includeActionDiscovery === "index" &&
					index.length < fullCatalog.length
						? index
						: fullCatalog,
			},
		});
	}

	const replyReferenceEvent = replyReferenceEventForContext(args.message);
	if (replyReferenceEvent) {
		events.push(replyReferenceEvent);
	}

	events.push({
		id: String(args.message.id ?? "current-message"),
		type: "message",
		source: args.message.content.source ?? "user",
		createdAt: args.message.createdAt,
		message: {
			id: args.message.id,
			role: "user",
			content: currentMessageContentForContext(args.message),
			metadata: {
				roomId: args.message.roomId,
				entityId: args.message.entityId,
			},
		},
	});

	if (args.includeTools && args.selectedContexts?.length) {
		const actions =
			args.preselectedActions ??
			(await collectV5PlannerCandidateActions({
				runtime: args.runtime,
				message: args.message,
				state: args.state,
				selectedContexts: args.selectedContexts,
				userRoles: args.userRoles,
			}));
		const displayActions = args.actionSurface
			? actions.filter((action) =>
					args.actionSurface?.exposedActionNames.has(
						normalizeActionIdentifier(action.name),
					),
				)
			: actions;
		for (const action of displayActions) {
			const tool = actionToTool(action);
			events.push({
				id: `tool:${tool.function.name}`,
				type: "tool",
				source: "message-service",
				tool: {
					name: tool.function.name,
					description: tool.function.description,
					parameters: tool.function.parameters,
					action,
				},
			});
		}
	}

	const systemPrompt = buildCanonicalSystemPrompt({
		character: args.runtime.character,
		userRole: args.userRoles?.[0],
	});
	// Chat style directions (style.all + style.chat) render exactly once here,
	// in the stable prefix. Computed statically from the character — not via the
	// per-room CHARACTER provider — so the KV-cacheable prefix stays
	// byte-identical across turns (#17026).
	const characterStyleDirections = buildCharacterStyleDirections({
		character: args.runtime.character,
	});
	// Stage 2 exposes each Action as its own native tool. Per-action specs live
	// in `events[type=tool]`; the LLM calls each action directly by name. We
	// also expose the universal terminal-sentinel tools (REPLY / IGNORE / STOP)
	// so the planner has a stable way to end the turn regardless of narrowing.
	// Empty when no actions are gated so the planner can short-circuit.
	const hasAnyAction = events.some(
		(event) =>
			event.type === "tool" &&
			"tool" in event &&
			Boolean(
				(event as { tool?: { name?: string } }).tool?.name?.trim().length,
			),
	);
	const expandedTools: ToolDefinition[] = hasAnyAction
		? [...CORE_PLANNER_TERMINALS]
		: [];
	return createContextObject({
		id: String(args.message.id ?? v4()),
		createdAt: Date.now(),
		metadata: {
			roomId: args.message.roomId,
			messageId: args.message.id,
			selectedContexts: [...(args.selectedContexts ?? [])],
			...(args.actionSurface
				? { actionSurface: args.actionSurface.summary as JsonValue }
				: {}),
		},
		staticPrefix: {
			systemPrompt: systemPrompt
				? {
						id: "system",
						label: "system",
						content: systemPrompt,
						stable: true,
					}
				: undefined,
			characterPrompt: characterStyleDirections
				? {
						id: "character-style",
						label: "system",
						content: characterStyleDirections,
						stable: true,
					}
				: undefined,
		},
		trajectoryPrefix: {
			selectedContexts: [...(args.selectedContexts ?? [])],
			contextDefinitions:
				args.selectedContexts && args.availableContexts
					? args.availableContexts.filter((def) =>
							args.selectedContexts?.includes(def.id),
						)
					: [],
			expandedTools,
			createdAtStageId: "message-handler",
		},
		plannedQueue: [],
		metrics: {},
		limits: {},
		events,
	});
}
