/**
 * Plugin-component contracts — the things a plugin registers into the runtime:
 * `Action` (validate + handler), `Provider` (context injected into the prompt),
 * and their supporting shapes (parameter schemas, handler/validator signatures,
 * action modes, message-handler plan/extract results). The heart of the
 * action/provider surface that the message loop dispatches against.
 */
import type { ActionFailureProvenance } from "./action-failure";
import type { ActionReplyFailure } from "./action-reply";
import type { ConnectorAccountPolicy } from "./connector-account-policy";
import type {
	AgentContext,
	CacheScope,
	ContextGate,
	RoleGate,
} from "./contexts";
import type { EffectReceipt } from "./effects";
import type { DisclosureSubject, Memory } from "./memory";
import type { Content, JsonPrimitive, JsonValue } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { ActionPlan, State } from "./state";

export type {
	AgentContext,
	CacheScope,
	ContextGate,
	RoleGate,
} from "./contexts";

/**
 * JSON Schema type for action parameter validation.
 * Supports basic JSON Schema properties for parameter definition.
 */
export interface ActionParameterSchema {
	/**
	 * JSON Schema instance type. Optional because a schema may instead be a
	 * pure union (`oneOf`/`anyOf`) — a sibling `type` alongside union branches
	 * of differing types contradicts the branches, and strict provider
	 * grammars reject the contradiction. A schema should carry `type` or a
	 * union keyword, never neither.
	 */
	type?: string;
	description?: string;
	/** Default value if parameter is not provided */
	default?: JsonValue | null;
	/** For object types, define nested properties */
	properties?: Record<string, ActionParameterSchema>;
	/** Required child property names for object-valued parameters */
	required?: string[];
	/** Whether object-valued parameters allow undeclared properties */
	additionalProperties?: boolean | ActionParameterSchema;
	/** For array types, define the item schema */
	items?: ActionParameterSchema;
	/** Enumerated allowed values (schema-compatible) */
	enumValues?: string[];
	/** Enumerated allowed values */
	enum?: string[];
	/** Minimum string length for string-valued parameters */
	minLength?: number;
	/** Maximum string length for string-valued parameters */
	maxLength?: number;
	/** Regular expression pattern for string-valued parameters */
	pattern?: string;
	/** Numeric minimum */
	minimum?: number;
	/** Numeric maximum */
	maximum?: number;
	/** JSON Schema `oneOf`: value must match exactly one sub-schema */
	oneOf?: ReadonlyArray<ActionParameterSchema>;
	/** JSON Schema `anyOf`: value must match at least one sub-schema */
	anyOf?: ReadonlyArray<ActionParameterSchema>;
}

/**
 * Defines a single parameter for an action.
 * Parameters are extracted from the conversation by the LLM and passed to the action handler.
 */
export interface ActionParameter {
	/** Parameter name (used as the key in the parameters object) */
	name: string;
	/** Human-readable description for LLM guidance */
	description: string;
	/** Compressed description for prompt-optimized rendering */
	descriptionCompressed?: string;
	/** Alias accepted for plugin compatibility; canonical output uses descriptionCompressed */
	compressedDescription?: string;
	/** Whether this parameter is required (default: false) */
	required?: boolean;
	/**
	 * Subaction applicability list for umbrella actions. Names the
	 * discriminator values (matched case/separator-insensitively) this
	 * parameter belongs to, so subaction promotion can expose each virtual
	 * with only the parameters its handler actually reads instead of
	 * duplicating the parent's full schema per virtual. Omitted = applies to
	 * every subaction; an explicit empty list = parent-only. Ignored on
	 * non-umbrella actions and on the discriminator parameter itself.
	 */
	subactions?: readonly string[];
	/**
	 * Subaction values on whose promoted virtual this parameter is REQUIRED,
	 * although it stays optional on the parent umbrella (where the discriminator
	 * decides which fields matter). Live 2026-09-06: with `text` optional on the
	 * MEMORY umbrella and its children, the planner routinely omitted it on
	 * `create`, failing two remember turns in three; a schema-level `required`
	 * on MEMORY_CREATE is what native tool-calling models honour.
	 */
	requiredForSubactions?: readonly string[];
	/**
	 * Accepted arg-name synonyms for this parameter. The pre-validation
	 * normalizer renames an incoming alias key to this param's name when the
	 * param itself is absent from the args and exactly one declared param claims
	 * the alias — so the planner isn't punished for saying `to`/`recipient`
	 * instead of `target`, or `description`/`prompt` instead of `instructions`.
	 * Metadata only: never emitted into the tool JSON schema shown to the model,
	 * and never lets an unclaimed/unknown key through (that still rejects).
	 */
	aliases?: readonly string[];
	/**
	 * Exact string spellings that the model-tool boundary treats as omission for
	 * this optional top-level parameter. Matching ignores surrounding whitespace
	 * and ASCII case. This is not JSON Schema behavior and is never applied by
	 * recursive structured-output validation; use it only where these literals
	 * cannot be valid domain values, such as an optional UUID identifier.
	 */
	modelOmissionSentinels?: readonly string[];
	/** JSON Schema for parameter validation */
	schema: ActionParameterSchema;
	/**
	 * Optional example values for this parameter.
	 * These are shown to the model in action descriptions to improve extraction accuracy.
	 */
	examples?: ActionParameterExampleValue[];
}

/**
 * Primitive value types that can be used in action parameters.
 */
export type ActionParameterValue = string | number | boolean | null;

/**
 * Example value types allowed for action parameter examples.
 * Supports primitives as well as nested objects/arrays for documentation purposes.
 */
export type ActionParameterExampleValue =
	| ActionParameterValue
	| ActionParameters
	| JsonValue
	| ActionParameterValue[]
	| ActionParameters[];

/**
 * Validated parameters passed to an action handler.
 * Keys are parameter names, values are the validated parameter values.
 * Supports nested objects and arrays for complex parameter structures.
 */
export interface ActionParameters {
	[key: string]:
		| ActionParameterValue
		| ActionParameters
		| ActionParameterValue[]
		| ActionParameters[]
		| JsonValue;
}

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample {
	name: string;
	content: Content;
}

export type MessageHandlerAction = "RESPOND" | "IGNORE" | "STOP";

/** Model-declared status of work described by the reply, not execution proof. */
export type ReplyEffectStatus = "none" | "applied" | "non_applied" | "pending";

export interface MessageHandlerDeterministicToolCall {
	name: string;
	params?: Record<string, JsonValue>;
}

/** Stage-1 source selection for planning and completion; it never edits stored history. */
export type CompletionContextSelection = {
	mode: "full" | "selected";
	sourceSetId: string;
	/** The model reviewed every source for applicability before selecting. */
	complete: boolean;
	relevantSourceIds: string[];
	constraintSourceIds: string[];
	referentSourceIds: string[];
	pendingIntentSourceIds: string[];
};

export interface MessageHandlerPlan {
	contexts: AgentContext[];
	reply?: string;
	replyEffectStatus?: ReplyEffectStatus;
	/**
	 * When true, Stage 1 marks this turn as requiring a tool call. The router
	 * upgrades empty / simple-only plans to planning against `general` and the
	 * planner loop will retry if the planner returns terminal output before any
	 * non-terminal tool has executed.
	 */
	requiresTool?: boolean;
	contextSlices?: string[];
	completionContext?: CompletionContextSelection;
	candidateActions?: string[];
	/**
	 * Stage 1's declared user intents for the turn, verbatim ("delete
	 * reminder", "create reminder", …). Multi-intent turns feed these to the
	 * planner context so the loop serves every declared leg or says which it
	 * did not — small planner models otherwise complete leg one and finish
	 * (live: "delete and recreate my reminder" deleted, never recreated).
	 */
	intents?: string[];
	parentActionHints?: string[];
	/**
	 * Per-turn cap on the planner's required-tool miss budget, set by the
	 * Stage-1 router when the ONLY tool evidence for an already-answered
	 * simple turn is a text-inferred view-surface token overlap. The planner
	 * loop honors it only when the stage-1 reply passes its answer-shape gate
	 * (see PlannerLoopParams.requiredToolMissBudgetOverride); it can shrink
	 * the budget, never grow it.
	 */
	requiredToolMissBudget?: number;
	/**
	 * Set to "inferred" when the plan's candidate actions were injected by a
	 * relaxable text heuristic and Stage 1's model emitted none of its own.
	 * Absent for model-authored candidates and strong deterministic coding-work
	 * inference. The planner loop treats an inferred-only requirement as weaker
	 * evidence — a planner
	 * that re-commits to the identical terminal answer on consecutive
	 * misses is accepted early instead of burning the full required-tool
	 * miss budget on a heuristic's guess.
	 */
	requiredToolEvidence?: "inferred";
	deterministicToolCall?: MessageHandlerDeterministicToolCall;
	[key: string]: JsonValue | MessageHandlerDeterministicToolCall | undefined;
}

export interface MessageHandlerExtractedRelationship {
	subject: string;
	predicate: string;
	object: string;
}

export interface MessageHandlerExtract {
	facts?: string[];
	relationships?: MessageHandlerExtractedRelationship[];
	/**
	 * Entities the inbound message is directed at — entity UUIDs or
	 * participant names that the post-parse pipeline resolves to UUIDs.
	 * Empty / omitted means "unknown / not directed at anyone in particular".
	 * Drives the "addressed" relationship edge from speaker → target.
	 */
	addressedTo?: string[];
	/**
	 * Short, normalized topic labels for the current message (1-5, lowercase,
	 * trimmed, deduped). Maintained per-channel as an LRU by
	 * `ChannelTopicsService` and surfaced back into Stage-1 routing via the
	 * `CHANNEL_TOPICS` provider. Empty / omitted means "no salient topic".
	 */
	topics?: string[];
}

export interface MessageHandlerResult {
	processMessage: MessageHandlerAction;
	plan: MessageHandlerPlan;
	thought: string;
	extract?: MessageHandlerExtract;
}

export type EvaluationDecision = "FINISH" | "NEXT_RECOMMENDED" | "CONTINUE";

export interface EvaluationResult {
	success: boolean;
	decision: EvaluationDecision;
	thought: string;
	messageToUser?: string;
	copyToClipboard?: {
		title: string;
		content: string;
		tags?: string[];
	};
	recommendedToolCallId?: string;
}

/**
 * Delivers handler output to a transport. `actionName` is present only when an
 * executing action produced the callback; message-service deliveries such as
 * simple, early, terminal, attachment, and voice output omit it. Consumers must
 * not infer action provenance from `Content.actions`.
 */
export type HandlerCallback = (
	response: Content,
	actionName?: string,
) => Promise<Memory[]>;

/**
 * Handler function type for processing messages
 */
export type Handler = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
	callback?: HandlerCallback,
	responses?: Memory[],
) => Promise<ActionResult | undefined>;

/**
 * Validator function type for actions/evaluators
 *
 * `options` mirrors {@link Handler}: runtimes may omit it; actions that read
 * structured parameters should treat it as optional.
 */
export type Validator = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
) => Promise<boolean>;

/**
 * When an action should fire.
 *
 * Three trigger scopes (ALWAYS / CONTEXT / MESSAGE) × three lifecycle phases
 * (BEFORE / DURING / AFTER) plus the default planner mode. All non-PLANNER
 * modes are hooks; the runtime fires them at fixed positions in the message
 * pipeline.
 *
 * - ALWAYS_*: every message, regardless of routing decision.
 * - CONTEXT_*: only when one of the action's `contexts` was selected by Stage 1.
 * - MESSAGE_*: hooks specifically on the messageHandler model call.
 * - PLANNER (default): planner picks based on user intent.
 *
 * `*_DURING` modes are non-blocking (parallel with the corresponding pipeline
 * step). All other hook modes are blocking.
 *
 * Cache contract: any hook that wants to influence the model prompt MUST use
 * the v5 staged-prefix renderer so Cerebras-style prompt-cache hits stay
 * intact across iterations.
 */
export const ActionMode = {
	PLANNER: "PLANNER",
	ALWAYS_BEFORE: "ALWAYS_BEFORE",
	ALWAYS_DURING: "ALWAYS_DURING",
	ALWAYS_AFTER: "ALWAYS_AFTER",
	CONTEXT_BEFORE: "CONTEXT_BEFORE",
	CONTEXT_DURING: "CONTEXT_DURING",
	CONTEXT_AFTER: "CONTEXT_AFTER",
	RESPONSE_HANDLER_BEFORE: "RESPONSE_HANDLER_BEFORE",
	RESPONSE_HANDLER_DURING: "RESPONSE_HANDLER_DURING",
	RESPONSE_HANDLER_AFTER: "RESPONSE_HANDLER_AFTER",
} as const;
export type ActionMode = (typeof ActionMode)[keyof typeof ActionMode];

/** Hook modes that run in parallel with the corresponding pipeline step. */
export const NON_BLOCKING_MODES = new Set<ActionMode>([
	ActionMode.ALWAYS_DURING,
	ActionMode.CONTEXT_DURING,
	ActionMode.RESPONSE_HANDLER_DURING,
]);

/** All non-PLANNER hook modes, in canonical pipeline order. */
export const HOOK_MODES: readonly ActionMode[] = [
	ActionMode.ALWAYS_BEFORE,
	ActionMode.RESPONSE_HANDLER_BEFORE,
	ActionMode.RESPONSE_HANDLER_DURING,
	ActionMode.RESPONSE_HANDLER_AFTER,
	ActionMode.CONTEXT_BEFORE,
	ActionMode.CONTEXT_DURING,
	ActionMode.CONTEXT_AFTER,
	ActionMode.ALWAYS_DURING,
	ActionMode.ALWAYS_AFTER,
];

/**
 * Represents an action the agent can perform
 */
export const FOLLOW_UP_CAPABLE_ACTION_TAG = "follow-up-capable" as const;

/**
 * Non-overridable policy for components whose prompt or result can contain
 * owner-private data. Unlike a role gate, this binds access to the attested
 * destination audience as well as the actor.
 *
 * Two forms, both fail-closed:
 *  - `owner_exclusive` (the original, unchanged): the destination must be a
 *    verified owner-only room — evaluated by `decisionFromAudience`.
 *  - `audience_admission` (added with the min-over-members policy wiring): the
 *    gate admits the component only when the ATTESTED delivery audience as a
 *    whole earns full disclosure for `subject`, computed by
 *    `resolveAudienceAdmission` over the same attested census. One ungranted
 *    non-agent member caps the room, exactly like `owner_exclusive` is the
 *    degenerate two-party-owner-DM case of this policy.
 */
export type DisclosureGate =
	| { require: "owner_exclusive" }
	| { require: "audience_admission"; subject: DisclosureSubject };

export interface Action {
	/** Action name */
	name: string;

	/** Detailed description */
	description: string;

	/** Compressed description for prompt-optimized action selection */
	descriptionCompressed?: string;
	/** Alias accepted for plugin compatibility; canonical output uses descriptionCompressed */
	compressedDescription?: string;

	/** Handler function */
	handler: Handler;

	/** Validation function */
	validate: Validator;

	/** Similar action descriptions */
	similes?: string[];

	/** Example usages */
	examples?: ActionExample[][];

	/** Optional priority for action ordering */
	priority?: number;

	/**
	 * Explicit override policy for name collisions during registration.
	 *
	 * When two components register under the same `name`, the runtime keeps the
	 * first-registered instance (deterministic first-wins) and emits a WARN for
	 * the undeclared collision. Set `override: true` on the LATER registrant to
	 * declare that it intentionally supersedes an already-registered component of
	 * the same name; the runtime then replaces the incumbent and logs the
	 * override at INFO instead of warning. This turns a silent, order-sensitive
	 * dedupe into an explicit, declared precedence contract.
	 *
	 * NOTE: `override` is honored on the DIRECT host/core registration path only.
	 * Across `registerPlugin` boundaries it is downgraded to safe first-wins,
	 * because hot plugin teardown (unload/reload/rollback) does not restore a
	 * displaced incumbent — a plugin override would otherwise destructively strip
	 * another plugin's component on unload.
	 */
	override?: boolean;

	/**
	 * Optional structural capability tags. Effectful actions use
	 * `capability:write|update|delete|schedule|send|delegate|execute`; add
	 * `effect:idempotent` only when every invocation carries a stable operation
	 * key and the authoritative provider or store safely replays it. Add
	 * `effect:receipt-required` only after every successful visible branch binds
	 * exact user-facing text to a validated effect receipt.
	 */
	tags?: string[];

	/**
	 * When true, this action is "private": it may only be selected and executed
	 * by the agent inside its own autonomous loop, never in direct response to a
	 * user request. The planner does not expose private actions on user-driven
	 * turns, and the executor rejects them on user-driven turns as a
	 * defense-in-depth backstop (so a hallucinated tool call cannot bypass the
	 * exposure gate).
	 *
	 * A turn is considered autonomous when the triggering message carries
	 * `content.metadata.isAutonomous === true` (the marker the autonomy service
	 * stamps on its self-prompts). This lets an agent reserve self-initiated
	 * capabilities — e.g. minting a coin, opening a position, or kicking off a
	 * long-running plan — for its own decision loop, so they cannot be triggered
	 * on demand by a user.
	 *
	 * Default: false (the action is available on both user and autonomous turns).
	 */
	private?: boolean;

	/**
	 * One-line routing hint surfaced to the planner. Replaces hand-written
	 * domain-routing prose in the v5 planner template. Format:
	 *   "<TRIGGER> -> <action> [+ secondary contexts]; <do/don't note>"
	 * Examples:
	 *   - PERSONAL_ASSISTANT: "real flight/hotel/trip booking -> PERSONAL_ASSISTANT action=book_travel; no browse-first or web-search-first"
	 *   - VOICE_CALL:  "explicit call/phone/dial a person/business -> VOICE_CALL first; calendar/email secondary"
	 * Surfaced into the planner prompt via {{actionRoutingHints}} so each
	 * action carries its own routing rule alongside its description.
	 *
	 * CANONICAL "when to use / when NOT to use" carrier. Prefer this field over
	 * burying disambiguation in `description`: `routingHint` is prepended
	 * VERBATIM to the planner tool description (see `actions/to-tool.ts`) — it is
	 * NOT run through `compressPromptDescription`, so it is never abbreviated and
	 * is captured in recorded trajectories via the planner stage's `model.tools`.
	 * Any action that shares
	 * a noun or simile with a sibling (e.g. TASKS vs SCHEDULED_TASKS, WEB_SEARCH
	 * vs MEMORY search) should state its boundary here, and name the sibling to
	 * route to, e.g.:
	 *   "coding/software delegation -> TASKS; reminders/check-ins/recurring
	 *    personal items -> SCHEDULED_TASKS/OWNER_REMINDERS (NOT this action)".
	 * Reference an UPPER_SNAKE_CASE sibling action name explicitly — those tokens
	 * also survive description compression, so the cross-reference stays intact
	 * even in the compressed form.
	 */
	routingHint?: string;

	/**
	 * When true, the message service treats this action as owning the turn
	 * instead of adding extra planner follow-up text after execution.
	 *
	 * Use this for actions that already emit a complete user-facing reply or
	 * that launch asynchronous background work whose progress will continue
	 * outside the current chat turn.
	 */
	suppressPostActionContinuation?: boolean;

	/**
	 * When true, the message service suppresses the response-handler's draft
	 * reply text (the "early reply" emitted before the planner runs) on turns
	 * where this action is a candidate. Pair with an in-handler `callback`
	 * that emits the canonical ack/answer.
	 *
	 * Use this for delegation actions where the model's speculative draft is
	 * premature — e.g. TASKS_SPAWN_AGENT, where the real answer arrives
	 * asynchronously from the sub-agent via the router, and the action's own
	 * "On it — spawning…" ack supersedes whatever the model guessed up front.
	 */
	suppressEarlyReply?: boolean;

	/**
	 * When true, this action performs an asynchronous handoff: its handler
	 * returns while the real work continues in the background (e.g. spawning a
	 * coding sub-agent) and the user-visible result arrives later through a
	 * separate delivery path.
	 *
	 * The message service uses this to decide whether a Stage-1 pre-planner
	 * early ack is warranted on latency-sensitive channels (voice): only turns
	 * whose candidate actions include an async-handoff action get an early
	 * ack, so synchronous retrieval turns deliver one reply — the answer — on
	 * every channel. At the terminal no-answer floor, the same flag retains an
	 * ack only when the executed action succeeded and supplied an applied
	 * receipt with commit proof. Promoted subactions inherit the parent's flag.
	 */
	asyncHandoff?: boolean;

	/**
	 * When true, runtime-level action result finalizers must not store this
	 * action's visible result text in task clipboard state.
	 */
	suppressActionResultClipboard?: boolean;

	/**
	 * Optional owner-declared short summary for planner fallback messages.
	 *
	 * The planner uses this only as a last-resort "what I did" projection when a
	 * successful tool turn has no clean model/evaluator final text. Keep the
	 * returned text terse and user-facing, e.g. "edited app.ts" or
	 * "ran `bun test`". Return undefined when the action result should not
	 * contribute to a synthesized fallback.
	 */
	summarize?: (
		result: ActionResult | undefined,
		params: Record<string, unknown>,
	) => string | undefined;

	/**
	 * Optional input parameters for the action.
	 * When defined, the LLM will be prompted to extract these parameters from the conversation
	 * and they will be validated before being passed to the handler via HandlerOptions.parameters.
	 *
	 * Parameters can be required or optional. Optional parameters may have defaults
	 * or can be backfilled inside the action handler if not provided.
	 *
	 * @example
	 * ```typescript
	 * parameters: [
	 *   {
	 *     name: "targetUser",
	 *     description: "The username or ID of the user to send the message to",
	 *     required: true,
	 *     schema: { type: "string" }
	 *   },
	 *   {
	 *     name: "platform",
	 *     description: "The platform to send the message on (telegram, discord, etc)",
	 *     required: false,
	 *     schema: { type: "string", enum: ["telegram", "discord", "x"], default: "telegram" }
	 *   }
	 * ]
	 * ```
	 */
	parameters?: ActionParameter[];

	/**
	 * When true, the JSON Schema generated for this action's top-level
	 * parameters object will set `additionalProperties: true`, accepting
	 * unknown keys and passing them through to the handler unchanged.
	 *
	 * This is useful for "group" / aggregator actions whose declared shape is
	 * `{ action, parameters }` but where smaller LLMs frequently emit the
	 * child-action fields at the top level (e.g. `{action, url, selector}`
	 * instead of `{action, parameters: { url, selector }}`). The handler is
	 * expected to auto-lift those extras into the child-action's parameters.
	 *
	 * Default: false (strict — unknown top-level fields are rejected).
	 */
	allowAdditionalParameters?: boolean;

	/**
	 * Whether provider-native tool calls should use strict JSON Schema mode.
	 *
	 * Defaults to true. Set false only for an aggregator whose single planner
	 * tool intentionally spans multiple parameter shapes and therefore needs
	 * optional fields to remain optional on the wire. Runtime argument
	 * validation and the handler's resolved child contract still enforce the
	 * selected operation before execution. The tool adapter permits strict
	 * normalization on providers that preserve optional properties; native
	 * ToolDefinition callers can still explicitly disable strict mode.
	 */
	toolSchemaStrict?: boolean;

	/**
	 * Domain contexts this action belongs to.
	 * Used by the context-routing classifier to scope the planner's action search.
	 * An action may belong to multiple contexts (e.g., a token-swap action is both
	 * "wallet" and "automation").
	 */
	contexts?: AgentContext[];

	/** Declarative context gate for v5 native tool planning. */
	contextGate?: ContextGate;

	/** Whether prompt/tool metadata for this action is stable enough to cache. */
	cacheStable?: boolean;

	/** Cache partition hint for stable action metadata. */
	cacheScope?: CacheScope;

	/** Optional role gate checked by planners before exposing this action. */
	roleGate?: RoleGate;

	/**
	 * Destination-audience policy enforced before catalog exposure, execution,
	 * provider composition, and visible delivery. Operator role policy cannot
	 * weaken this gate.
	 */
	disclosureGate?: DisclosureGate;

	/**
	 * Optional connector account policy checked by planner tool exposure and
	 * again immediately before handler execution. This must not be implemented
	 * only inside validate(); validate is advisory and can be bypassed by native
	 * tool calls.
	 */
	connectorAccountPolicy?:
		| ConnectorAccountPolicy
		| readonly ConnectorAccountPolicy[];

	/** Compatibility alias for early adopters of connectorAccountPolicy. */
	accountPolicy?: ConnectorAccountPolicy | readonly ConnectorAccountPolicy[];

	/** Child tool/action names or inline definitions exposed beneath this action. */
	subActions?: Array<string | Action>;

	/**
	 * Deterministic dispatch for a call to this umbrella that omits its
	 * discriminator. Returns the name of one promoted child in `subActions`
	 * when `params` can only mean that sub-action, otherwise `undefined`. The
	 * planner executor consults it before delegating such a call to the
	 * sub-planner, a second planner model call over the child tools (live
	 * 2026-09-14: `MEMORY {text, kind, tags}` with no `action` took 4.5 s
	 * instead of ~2 s). Must be pure and synchronous, return `undefined` on
	 * any ambiguity, and never name a destructive sub-action without the
	 * call's own confirmation argument; the umbrella's handler still enforces
	 * its per-operation contract on the pinned call.
	 */
	inferSubaction?: (
		params: Readonly<Record<string, unknown>>,
	) => string | undefined;

	/** Whether this action should delegate selection to a sub-planner. */
	subPlanner?: boolean | { name?: string; description?: string };

	/**
	 * When this action should fire. Defaults to {@link ActionMode.PLANNER}.
	 * Non-PLANNER values turn the action into a hook that fires at a fixed
	 * pipeline position; see {@link ActionMode} for the full taxonomy.
	 */
	mode?: ActionMode;

	/**
	 * Ordering hint for hook actions sharing the same mode. Lower priority
	 * runs first. Default: 100. Ignored for `*_DURING` modes (parallel) and
	 * for `PLANNER`.
	 */
	modePriority?: number;

	/**
	 * Per-action model routing hint. When present, the runtime resolves
	 * `runtime.useModel(...)` calls made on behalf of this action to a model
	 * registration that matches this class, rather than to whatever model the
	 * caller passed. This lets the planner run on a large/cloud model while
	 * cheap, narrow actions run on a small or local model.
	 *
	 * Closes gap A5 / W1-R2 in the Eliza-1 pipeline plan.
	 *
	 * Semantics (cost-aware, ascending escalation on failure):
	 * - `LOCAL`     — prefer a local-provider registration (e.g. Ollama, LM
	 *                 Studio, MLX, llama.cpp). If the local registration errors
	 *                 or no local handler is registered, the runtime escalates
	 *                 one step up: `LOCAL → TEXT_SMALL → TEXT_LARGE`.
	 * - `TEXT_SMALL`— prefer a small cloud-class model. Escalates to
	 *                 `TEXT_LARGE` on error.
	 * - `TEXT_LARGE`— prefer a large cloud-class model. Top of the chain — no
	 *                 escalation.
	 *
	 * The resolver applies this routing only when the action handler invokes
	 * `runtime.useModel()` for a text-generation model type. Non-text model
	 * types (embeddings, image, audio, tokenizer) are not rerouted. Backwards
	 * compatibility: if `modelClass` is absent, the runtime uses today's model
	 * resolution and fallback behavior verbatim.
	 *
	 * @see eliza/packages/core/src/runtime/action-model-routing.ts for the
	 *      strategy-registry implementation.
	 */
	modelClass?: ActionModelClass;
}

/**
 * Per-action model routing classes. Closes gap A5: provider switching was
 * previously per-provider only — actions could not request a small/local
 * model independently of the planner's choice.
 *
 * The runtime maps each class to a fallback chain via the strategy registry
 * in `runtime/action-model-routing.ts`. Order of escalation on error is:
 *   `LOCAL → TEXT_SMALL → TEXT_LARGE`
 */
export type ActionModelClass = "TEXT_LARGE" | "TEXT_SMALL" | "LOCAL";

export type { JsonPrimitive } from "./primitives";

/**
 * Value types allowed in provider results.
 *
 * This type accepts:
 * - Primitive JSON values (string, number, boolean, null, undefined)
 * - Arrays of values
 * - Any object (Record<string, unknown>)
 *
 * The broad object type (Record<string, unknown>) ensures that domain types
 * like Memory[], Character, Content, etc. are accepted without requiring
 * unsafe double assertions, while still maintaining JSON-serializable
 * semantics at runtime.
 */
export type ProviderValue =
	| JsonPrimitive
	| JsonValue
	| Uint8Array
	| bigint
	| object
	| ProviderValue[]
	| { [key: string]: ProviderValue | undefined }
	| undefined;

/**
 * Data record type that accepts any JSON-serializable values.
 * This is broader than ProviderValue to accommodate domain types
 * like Memory[], Character, Content without requiring casts.
 * The index signature allows dynamic property access.
 */
export type ProviderDataRecord = {
	[key: string]: ProviderValue;
};

/**
 * Result returned by a provider
 */
export interface ProviderResult {
	/** Human-readable text for LLM prompt inclusion */
	text?: string;

	/** Optional Stage-1 discovery notice. Keep standing constraints complete here;
	 * the response handler can request the entire authorized `text` before answering.
	 * Other consumers retain `text`. This never replaces stored provider evidence. */
	discoveryText?: string;

	/**
	 * Complete, explicit retrieval representation used only when the primary
	 * text cannot fit the selected model's input boundary. This must describe
	 * how the omitted bodies can be retrieved losslessly; it is an atomic
	 * alternative to `text`, never a truncated prefix or summary of it.
	 */
	overflowText?: string;

	/** Key-value pairs for template variable substitution */
	values?: Record<string, ProviderValue>;

	/**
	 * Structured data for programmatic access by other components.
	 * Accepts JSON-serializable values and domain objects.
	 */
	data?: ProviderDataRecord;
}

/**
 * Turn-scoped execution controls supplied by the runtime to every provider.
 *
 * Providers that start database, network, subprocess, or other interruptible
 * work must propagate `signal` to that boundary. Every compose caller observes
 * its own lifecycle owner; coalesced provider work remains active while any
 * caller is interested and this signal aborts when the final owner leaves or
 * the runtime stops.
 */
export interface ProviderExecutionContext {
	signal: AbortSignal;
}

/**
 * Provider for external data/services. `get` is a read-only context operation:
 * it must not commit external side effects because an owner can stop waiting
 * for a provider that has not cooperatively observed its abort signal.
 */
export interface Provider {
	/** Provider name */
	name: string;

	/**
	 * Human-readable metadata for catalogs and diagnostics. The v5 chat planner
	 * does not see this text unless a caller explicitly composes the provider;
	 * route provider prompt text with `contexts`/`contextGate` or
	 * `alwaysInResponseState`.
	 */
	description?: string;

	/** Compressed description for legacy catalog rendering and diagnostics. */
	descriptionCompressed?: string;
	/** Alias accepted for plugin compatibility; canonical output uses descriptionCompressed */
	compressedDescription?: string;

	/** Whether the provider is dynamic */
	dynamic?: boolean;

	/** Position of the provider in the provider list, positive or negative */
	position?: number;

	/**
	 * Explicit override policy for name collisions during registration.
	 * See {@link Action.override}: set `override: true` on the later registrant
	 * to intentionally supersede an already-registered provider of the same name.
	 * Undeclared collisions keep the incumbent (first-wins) and emit a WARN.
	 */
	override?: boolean;

	/**
	 * Whether the provider is private
	 *
	 * Private providers are not displayed in the regular provider list, they have to be called explicitly
	 */
	private?: boolean;

	/**
	 * Advisory keywords for provider-owned self-gates and catalogs. Core does
	 * not run a global keyword selector over providers.
	 */
	relevanceKeywords?: string[];

	/**
	 * Domain contexts this provider belongs to.
	 * The context-routing classifier uses these to decide which providers to
	 * include in the planner's state composition for a given turn.
	 *
	 * When neither `contexts` nor a `contextGate` with context terms is
	 * declared, registration materializes this field from the provider-context
	 * catalog (`utils/context-catalog.ts`), defaulting to `["general"]` —
	 * present on ordinary chat turns, absent from narrow planner/tool turns.
	 * Declare contexts or a gate to route the provider, or opt into
	 * `alwaysInResponseState` for an always-on signal.
	 */
	contexts?: AgentContext[];

	/**
	 * Declarative context gate for v5 provider selection. All context terms
	 * (contexts/anyOf/allOf/noneOf) are honored; a gate-only declaration also
	 * materializes `contexts` from the gate's anyOf surface at registration.
	 * A contextGate adds context requirements on top of the provider's
	 * top-level `roleGate`; it does not waive it unless it declares its own
	 * (#12087 Item 14).
	 */
	contextGate?: ContextGate;

	/** Whether this provider's prompt contribution is stable enough to cache. */
	cacheStable?: boolean;

	/** Cache partition hint for stable provider content. */
	cacheScope?: CacheScope;

	/**
	 * Whether plugin registration should install this provider into the runtime.
	 *
	 * Defaults to true. Set to false for plugin-owned providers that are
	 * available for direct composition or alternative host wiring, but should
	 * not be part of the default provider surface every time the plugin loads.
	 */
	registerByDefault?: boolean;

	/**
	 * When true, this provider is always composed into the Stage-1 response
	 * state regardless of the turn's selected contexts (like the built-in
	 * FACTS / CURRENT_TIME signals). Lets a plugin opt a dynamic provider into
	 * always-on Stage-1 rendering without core having to name it — keeping the
	 * core → plugin dependency direction inward-only.
	 *
	 * This is the explicit opt-in for FACTS/CURRENT_TIME-class always-on
	 * signals; it bypasses context routing entirely, so keep the provider's
	 * happy-path render empty/cheap (e.g. RECENT_ERRORS renders nothing when
	 * healthy). Providers whose relevance is turn-scoped should declare
	 * `contexts`/`contextGate` instead.
	 */
	alwaysInResponseState?: boolean;

	/** Optional role gate checked before including this provider. */
	roleGate?: RoleGate;

	/**
	 * Non-overridable destination-audience policy for sensitive context.
	 *
	 * Deliberately narrower than `Action.disclosureGate`: every provider
	 * enforcement site in `runtime.ts` tests `require === "owner_exclusive"`
	 * literally, so a provider declaring `audience_admission` would compose
	 * into the prompt with NO enforcement at all. Widen this only in the same
	 * change that wires the provider path.
	 */
	disclosureGate?: Extract<DisclosureGate, { require: "owner_exclusive" }>;

	/** Child provider/action names exposed beneath this provider, if any. */
	subActions?: string[];

	/** Data retrieval function */
	get: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		context?: ProviderExecutionContext,
	) => Promise<ProviderResult>;
}

/**
 * Error codes an action handler may set on `ActionResult.values.error` or
 * `ActionResult.data.error` to signal that the next step requires a fresh
 * confirmation message from the user. Native planner execution checks for
 * these (alongside the canonical `requiresConfirmation: true` flag) and
 * pauses the chain so the agent does not spin re-running the same step.
 *
 * Keep this list aligned with `ACTION_CONFIRMATION_STATUS_VALUES` below —
 * both the type and the runtime set are exported so callers (actions,
 * test-spies, downstream packages) can `Set.has(code)` without re-declaring
 * the strings.
 */
export type ActionConfirmationStatus =
	| "CONFIRMATION_REQUIRED"
	| "NOT_CONFIRMED"
	| "REQUIRES_CONFIRMATION"
	| "AWAITING_CONFIRMATION"
	| "NEEDS_CONFIRMATION";

/**
 * Runtime set of {@link ActionConfirmationStatus} values. Frozen so callers
 * cannot mutate the canonical list.
 */
export const ACTION_CONFIRMATION_STATUS_VALUES: ReadonlySet<ActionConfirmationStatus> =
	new Set<ActionConfirmationStatus>([
		"CONFIRMATION_REQUIRED",
		"NOT_CONFIRMED",
		"REQUIRES_CONFIRMATION",
		"AWAITING_CONFIRMATION",
		"NEEDS_CONFIRMATION",
	]);

/**
 * Type-narrowing predicate. Returns true when `value` is a known confirmation
 * status string. Use this on stringly-typed error fields off `ActionResult`.
 */
export function isActionConfirmationStatus(
	value: unknown,
): value is ActionConfirmationStatus {
	return (
		typeof value === "string" &&
		ACTION_CONFIRMATION_STATUS_VALUES.has(value as ActionConfirmationStatus)
	);
}

/**
 * Result returned by an action after execution
 * Used for action chaining and state management
 */
export interface ActionResult {
	/** Whether the action succeeded */
	success: boolean;

	/** Optional text description of the result */
	text?: string;

	/** Marks raw machine-only output that must not render as assistant prose. */
	transcriptVisibility?: "internal";

	/**
	 * Optional clean user-facing answer. When set, the planner-loop's
	 * terminal-FINISH fallback uses this as the reply shown to the user
	 * instead of the diagnostic `text`. Leave unset for log-emitting
	 * actions (BASH, file readers); set for Q&A actions, REPLY actions,
	 * and content generators.
	 *
	 * By default an explicit evaluator `messageToUser` outranks this.
	 * Set `verifiedUserFacing: true` to mark this text as canonical
	 * (do-not-paraphrase) — e.g. when it contains paths, ids, counts,
	 * numeric metrics, or a saved-vs-preview state the evaluator might
	 * otherwise hallucinate.
	 */
	userFacingText?: string;

	/**
	 * When `true` and `userFacingText` is set, the planner-loop prefers
	 * the action's `userFacingText` over the evaluator's `messageToUser`
	 * for the terminal-FINISH reply. Use for structured outputs and
	 * explicit confirmation previews where a paraphrase risk is worse
	 * than echoing the action verbatim.
	 */
	verifiedUserFacing?: boolean;

	/**
	 * Canonical mutation outcomes produced by this action. `success` alone is
	 * never proof that an external change committed; only an applied receipt with
	 * commit proof can ground a user-facing completion claim.
	 */
	effectReceipts?: readonly EffectReceipt[];

	/**
	 * Receipt IDs described by the exact `userFacingText`. The runtime accepts a
	 * completion confirmation only when every ID resolves to an active applied
	 * receipt from this turn.
	 */
	userFacingEffectReceiptIds?: readonly string[];

	/**
	 * Structural origin of a failed action. Persistence code sets this at its
	 * commit boundary; the runtime sets it when capability lookup or a handler
	 * throws. It must be absent on successful results.
	 */
	failureProvenance?: ActionFailureProvenance;

	/** Reply generation failed; success and effect receipts still describe the action. */
	replyFailure?: ActionReplyFailure;

	/** Values to merge into the state */
	values?: Record<string, ProviderValue>;

	/**
	 * Data payload containing action-specific results.
	 * Accepts any JSON-serializable object values including domain types.
	 */
	data?: ProviderDataRecord;

	/**
	 * Supplemental model-bound metadata. By default both this and data remain
	 * complete on the model wire. A producer may explicitly declare replace-data
	 * only when this contains the complete model contract, including a fresh read
	 * route for any deferred schema. Text and effect receipts are never replaced.
	 */
	promptData?: ProviderDataRecord;
	/** Explicit producer opt-in; complete data stays in runtime state/recordings. */
	promptDataMode?: "replace-data";

	/** Error information if the action failed */
	error?: string | Error;

	/**
	 * Declares that this result fully answers a single-operation turn. The
	 * planner may skip its in-loop evaluator only when this was the turn's sole
	 * executed tool, no planned tools remain, the result succeeded, and it
	 * supplies safe canonical `userFacingText` via `verifiedUserFacing`. Unlike
	 * `continueChain: false`, this does not discard already-queued tool calls.
	 * Set `false` to explicitly require evaluation; omit it when the action has
	 * no opinion about whether the overall turn is complete.
	 */
	turnComplete?: boolean;

	/**
	 * Requests exactly one model-authored reply after this successful action.
	 * The planner honors this only when the result is the turn's sole completed
	 * tool, its queue is empty, and the native call explicitly declared final
	 * scope. A safe no-tool model reply then completes the turn without a second
	 * evaluator model call; failures, additional tools, unsafe replies, and
	 * incomplete planner scope retain the normal evaluator path.
	 *
	 * Use for UI effects whose wording must remain model-owned (for example,
	 * navigation). Do not pair it with canned `userFacingText`; use the narrowly
	 * vetted `modelReplyFallback` only for provider-outage recovery.
	 */
	modelReplyRequired?: boolean;
	/** Safe action-owned prose used only if required model synthesis is unavailable. */
	modelReplyFallback?: string;

	/**
	 * Explicit chain-control override. `false` aborts the remaining planner queue
	 * and returns immediately, including for legacy failure and fire-and-forget
	 * actions that do not own a complete user reply. Prefer `turnComplete` for the
	 * safe single-operation evaluator fast path.
	 */
	continueChain?: boolean;

	/** Optional cleanup function to execute after action completion */
	cleanup?: () => void | Promise<void>;
}

/**
 * Context provided to actions during execution
 * Allows actions to access previous results and execution state
 */
export interface ActionContext {
	/** Results from previously executed actions in this run */
	previousResults: ActionResult[];

	/** Get a specific previous result by action name */
	getPreviousResult?: (actionName: string) => ActionResult | undefined;
}

/**
 * Canonical callback type for streaming response chunks.
 *
 * WHY one type: Before this consolidation the same `(chunk, messageId?) => …`
 * signature was inlined in 8+ locations across runtime, model, message-service,
 * and streaming-context types — with inconsistent return types (`Promise<void>`
 * vs `void | Promise<void>`). Adding data (e.g. `accumulated`) required editing
 * every copy. A single alias eliminates drift and makes additional fields
 * (field name, token index, session handle) a one-line additive change.
 *
 * WHY `accumulated`: Two independent stream extractors in `useModel`
 * previously caused TTS garbling because consumers had to re-derive the full
 * text from deltas — and the two extractors produced deltas at different
 * timings. Providing the authoritative accumulated text from the extractor
 * makes that entire category of reassembly bugs impossible.
 *
 * WHY `void | Promise<void>`: The most permissive return — allows both sync
 * callbacks (simple loggers, test spies) and async ones (network, TTS).
 *
 * @param chunk - Delta text since the last emission for this field.
 * @param messageId - Streaming session / message identifier (UUID or opaque string).
 * @param accumulated - Full extracted text so far for the streaming field.
 *   Present when the emission originates from a structured field extractor.
 *   Undefined for raw-token streams (useModel without an extractor) where no
 *   field-level accumulation exists.
 * @param streamRevision - Monotonically allocated structured-extractor attempt
 *   number. A change means `accumulated` restarted and consumers must discard
 *   incremental state from the preceding attempt. Undefined for raw-token
 *   streams.
 */
export type StreamChunkCallback = (
	chunk: string,
	messageId?: string,
	accumulated?: string,
	streamRevision?: number,
) => void | Promise<void>;

/**
 * Options passed to action handlers during execution
 * Provides context about the current execution and queued action plans
 */
export interface HandlerOptions {
	/** Context with previous action results and utilities */
	actionContext?: ActionContext;

	/** Multi-step action plan information */
	actionPlan?: ActionPlan;

	/** Optional stream chunk callback for streaming responses */
	onStreamChunk?: StreamChunkCallback;

	/**
	 * Validated input parameters extracted from the conversation.
	 * Only present when the action defines parameters and they were successfully extracted.
	 *
	 * Parameters are validated against the action's parameter schema before being passed here.
	 * Optional parameters may be undefined if not provided in the conversation.
	 *
	 * @example
	 * ```typescript
	 * handler: async (runtime, message, state, options) => {
	 *   const params = options?.parameters;
	 *   if (params) {
	 *     const targetUser = params.targetUser as string;
	 *     const platform = params.platform as string ?? "telegram"; // backfill default
	 *   }
	 * }
	 * ```
	 */
	parameters?: ActionParameters;

	/**
	 * Parameter validation errors, if the action defined parameters but extraction/validation was partial.
	 *
	 * Actions SHOULD handle these errors gracefully (e.g. ask the user for missing required values,
	 * or infer from context when safe).
	 */
	parameterErrors?: string[];

	/** Allow extensions from plugins */
	[key: string]: JsonValue | object | undefined;
}
