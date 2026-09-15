/** Resolves user-visible replies from settled tool results, verified effects, and actual delivery receipts. */

import { bindEffectDelivery } from "../../runtime/effect-delivery";
import {
	isTerminalPlannerToolName,
	type PlannerToolResult,
} from "../../runtime/planner-loop";
import { getTrajectoryContext } from "../../trajectory-context";
import type { Action, ActionResult } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { MessageTerminalFailure } from "../../types/message-service";
import type { Content, Media, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import type { StrategyMode, StrategyResult } from "./contracts.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";

/**
 * Canonical form for delivered-text dedup: callers that thread
 * `deliveredVisibleTexts` into `runV5MessageRuntimeStage1` must add entries in
 * this form for the action-echo suppression to match them.
 */
export function normalizeVisibleTextForDuplicateCheck(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when a text already delivered through an action callback covers the
 * (normalized) planned reply — either verbatim or as a strict superset ending
 * at a non-word boundary, so a short prefix never swallows an unrelated longer
 * line ("created" must not match "created issue …"). Shared by the planner
 * echo suppression and the reply-egress claim gate so both agree on what
 * "the user already saw this" means.
 */
export function deliveredTextsCoverReply(
	deliveredVisibleTexts: ReadonlySet<string>,
	normalizedReply: string,
): boolean {
	if (normalizedReply.length === 0) return false;
	for (const delivered of deliveredVisibleTexts) {
		if (
			delivered === normalizedReply ||
			(delivered.startsWith(normalizedReply) &&
				/[^a-z0-9]/i.test(delivered.charAt(normalizedReply.length)))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Records a settled planner tool result on the turn-scoped list the
 * planner-loop failure catch reads, returning the result unchanged so the
 * capture composes inline with the executor call.
 */
export function trackSettledPlannerToolResult(
	settled: Array<{ name: string; result: PlannerToolResult }>,
	name: string,
	result: PlannerToolResult,
): PlannerToolResult {
	settled.push({ name, result });
	return result;
}

/**
 * The most recent completed tool result whose `userFacingText` can still
 * rescue a turn after the planner loop dies: successful, non-terminal, and not
 * already delivered to the user through an action callback. Diagnostic
 * `text` is never a candidate — the wire contract says it must not render as
 * assistant prose — so a turn whose tools produced only diagnostics still
 * falls through to the caller's failure handling.
 */
export function preservedSettledToolResult(
	settled: ReadonlyArray<{ name: string; result: PlannerToolResult }>,
	deliveredVisibleTexts: ReadonlySet<string>,
): (PlannerToolResult & { userFacingText: string }) | undefined {
	for (let index = settled.length - 1; index >= 0; index--) {
		const entry = settled[index];
		if (isTerminalPlannerToolName(entry.name)) continue;
		// A later failed operation makes earlier success prose incomplete.
		// Keep the failure boundary unless a subsequent successful result owns
		// the reply; never discard the intervening failure while scanning back.
		if (entry.result.success !== true) return undefined;
		const candidate = entry.result.userFacingText?.trim();
		if (!candidate) continue;
		// A text the user already saw via an action callback must not be
		// re-sent; keep scanning for an undelivered result.
		if (
			deliveredTextsCoverReply(
				deliveredVisibleTexts,
				normalizeVisibleTextForDuplicateCheck(candidate),
			)
		) {
			continue;
		}
		return { ...entry.result, userFacingText: candidate };
	}
	return undefined;
}

export const NO_REPORTABLE_TOOL_OUTCOME_MESSAGE =
	"I ran that, but it finished without producing a result I can report back.";

/**
 * Structured machine effect parsed from a tool result's receipt `text` — the
 * shape actions emit as an internal-visibility JSON receipt when the effect
 * has already been applied out-of-band (plugin-app-control's
 * `view_navigation`: `{"effect","status","viewId","label",...}`). `effect`
 * and `status` are the family contract; `label` is the optional human name of
 * the affected thing.
 */
export interface StructuredToolEffect {
	effect: string;
	status: string;
	label?: string;
	viewId?: string;
}

export function structuredEffectFromToolResult(
	result: PlannerToolResult,
): StructuredToolEffect | undefined {
	const raw = result.text?.trim();
	if (!raw?.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// error-policy:J3 a tool's diagnostic text is untrusted input for this
		// projection; non-JSON text is explicitly "no structured effect" —
		// never a fake-valid effect — and the caller keeps its fallback.
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	const { effect, status, label, viewId } = parsed as {
		effect?: unknown;
		status?: unknown;
		label?: unknown;
		viewId?: unknown;
	};
	if (typeof effect !== "string" || effect.trim().length === 0) {
		return undefined;
	}
	if (typeof status !== "string" || status.trim().length === 0) {
		return undefined;
	}
	return {
		effect: effect.trim(),
		status: status.trim(),
		...(typeof label === "string" && label.trim().length > 0
			? { label: label.trim() }
			: {}),
		...(effect.trim() === "view_navigation" &&
		typeof viewId === "string" &&
		viewId.trim().length > 0
			? { viewId: viewId.trim() }
			: {}),
	};
}

export function replyNamesStructuredEffectDestination(
	reply: string,
	effect: StructuredToolEffect,
): boolean {
	if (effect.effect !== "view_navigation" || !effect.label) return true;
	const normalize = (value: string): string =>
		value
			.toLocaleLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	const normalizedReply = normalize(reply);
	const normalizedLabel = normalize(effect.label);
	return (
		normalizedReply.length > 0 &&
		((normalizedLabel.length > 0 &&
			normalizedReply.includes(normalizedLabel)) ||
			// A delivered view has a canonical identity as well as its display
			// label (for example chat / Home). Use only that receipt's identity,
			// not guessed aliases or request text, and match complete words.
			(effect.status === "delivered" &&
				!!effect.viewId &&
				normalize(effect.viewId).length > 0 &&
				` ${normalizedReply} `.includes(` ${normalize(effect.viewId)} `)))
	);
}

export function preservedVerifiedFailure(
	settled: ReadonlyArray<{ name: string; result: PlannerToolResult }>,
	deliveredVisibleTexts: ReadonlySet<string>,
): string | undefined {
	for (let index = settled.length - 1; index >= 0; index--) {
		const entry = settled[index];
		if (entry?.result.success !== false) continue;
		if (entry.result.verifiedUserFacing !== true) continue;
		if (isTerminalPlannerToolName(entry.name)) continue;
		const candidate = entry.result.userFacingText?.trim();
		if (!candidate) continue;
		if (
			deliveredTextsCoverReply(
				deliveredVisibleTexts,
				normalizeVisibleTextForDuplicateCheck(candidate),
			)
		) {
			continue;
		}
		return candidate;
	}
	return undefined;
}

export function hasAcceptedAsyncHandoff(result: ActionResult): boolean {
	if (result.success !== true) return false;
	return (
		result.effectReceipts?.some(
			(receipt) =>
				receipt.outcome === "applied" &&
				receipt.commit !== undefined &&
				receipt.commit.id.trim().length > 0,
		) === true
	);
}

/**
 * Terminal report for a tool turn whose planner produced no prose. A
 * pre-tool acknowledgement is retained only when a successful action carries
 * authoritative acceptance proof that work continues beyond this turn.
 */
export function answerlessToolTurnReport(args: {
	settledToolResults: ReadonlyArray<{
		name: string;
		result: PlannerToolResult;
	}>;
	deliveredVisibleTexts: ReadonlySet<string>;
	actionResults: readonly ActionResult[];
	actions: readonly Action[] | undefined;
	stageOneAck: string;
}): string {
	const successful = preservedSettledToolResult(
		args.settledToolResults,
		args.deliveredVisibleTexts,
	);
	if (successful) return successful.userFacingText;
	const failed = preservedVerifiedFailure(
		args.settledToolResults,
		args.deliveredVisibleTexts,
	);
	if (failed) return failed;
	if (args.deliveredVisibleTexts.size > 0) return "";
	const acceptedActionNames = args.actionResults
		.filter(hasAcceptedAsyncHandoff)
		.map((result) =>
			typeof result.data?.actionName === "string" ? result.data.actionName : "",
		)
		.filter((name) => name.length > 0);
	if (candidateActionsIncludeAsyncHandoff(args.actions, acceptedActionNames)) {
		return args.stageOneAck;
	}
	// Missing prose belongs to model-backed reply recovery, not an effect-to-text template.
	return "";
}

/** Where the zero-delivery recovery sourced its terminal reply from. */
export type ZeroDeliveryRecoverySource =
	| "plannedText"
	| "actionUserFacingText"
	| "stageOneAck"
	| "fallbackText";

/**
 * Decides whether — and with what text — a turn that owes the user a terminal
 * response but delivered nothing recovers instead of ending silent (#20083,
 * corrected by #20086). The turn may have run tools or may be an addressed,
 * toolless turn covered by the delivery floor. Source precedence is the
 * planner's surviving terminal text, then the last explicit action-owned
 * `userFacingText`, then the Stage-1 ack ONLY when no early ack already shipped
 * it. Missing prose is left empty for model-backed recovery from the settled
 * results; this function never manufactures dialogue. After an early progress ack,
 * the turn recovers only when grounded text exists or any tool failed: a
 * successful async handoff reports through a later completion relay, so
 * manufacturing a "finished" line behind its ack would be a lie, while a failed
 * handoff will never relay anything and the ack's promise must be corrected.
 * `plannedText` must arrive pre-blanked when it merely repeats the early ack.
 */
export function resolveZeroDeliveryRecovery(args: {
	plannedText: string;
	actionResults: ReadonlyArray<
		Pick<ActionResult, "success" | "userFacingText">
	>;
	stageOneAck: string;
	earlyReplySent: boolean;
}): {
	recover: boolean;
	text: string;
	source: ZeroDeliveryRecoverySource;
	actionSuccessCount: number;
	actionFailureCount: number;
} {
	const actionSuccessCount = args.actionResults.filter(
		(result) => result.success === true,
	).length;
	const actionFailureCount = args.actionResults.filter(
		(result) => result.success === false,
	).length;
	const lastActionUserFacingText =
		args.actionResults
			.map((result) =>
				typeof result.userFacingText === "string"
					? result.userFacingText.trim()
					: "",
			)
			.filter((ownedText) => ownedText.length > 0)
			.at(-1) ?? "";
	const ackRecoveryText = args.earlyReplySent ? "" : args.stageOneAck;
	const text = args.plannedText || lastActionUserFacingText || ackRecoveryText;
	const source: ZeroDeliveryRecoverySource = args.plannedText
		? "plannedText"
		: lastActionUserFacingText
			? "actionUserFacingText"
			: ackRecoveryText
				? "stageOneAck"
				: "fallbackText";
	const recover =
		!args.earlyReplySent ||
		Boolean(args.plannedText) ||
		lastActionUserFacingText.length > 0 ||
		actionFailureCount > 0;
	return { recover, text, source, actionSuccessCount, actionFailureCount };
}

/**
 * Restore PII surrogates → real values at the final user-facing reply egress
 * (#10827). The NER pseudonymization layer swaps real PII to surrogates on
 * ingress and restores them at the tool-call execution boundary
 * (`execute-planned-tool-call.ts`) — but a direct/terminal reply that does NOT
 * go through a tool call was still shipping the surrogate to the user. Mirror
 * the tool-call egress restore here so the user (and the persisted assistant
 * message they read back) sees the real value, while the model, trajectory,
 * logs, and providers upstream keep the surrogate. Best-effort + a zero-cost
 * no-op when PII swap is disabled (no session on the trajectory context) or the
 * text carries no surrogate. Scoped to the reply TEXT only — the `thought`
 * (reasoning trajectory) is intentionally left pseudonymized.
 */
export function restorePiiInUserReplyText(text: string): string {
	const piiSwapSession = getTrajectoryContext()?.piiSwapSession;
	return piiSwapSession ? piiSwapSession.restoreInValue(text) : text;
}

export function createV5ReplyStrategyResult(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	text: string;
	thought: string;
	mode?: StrategyMode;
	attachments?: Media[];
	transcriptVisibility?: "internal";
	/** Applied receipt IDs grounding this exact text at the final send boundary. */
	effectReceiptIds?: readonly string[];
	/**
	 * Provenance for the humanness voice gate (#14873): `true` when `text` is
	 * already final user-facing copy — either the model's own composed reply or
	 * a byte-exact canonical `verifiedUserFacing` action result. Gated transports
	 * (`sendMessageToTarget`) then preserve it instead of spending a blocking
	 * TEXT_SMALL re-voice that could alter exact names, punctuation, or values.
	 * Leave unset for templates, ordinary tool output, and mixed-provenance
	 * planner text so the gate can still rewrite canned strings.
	 */
	agentVoiced?: boolean;
	/**
	 * Machine-readable terminal failure for coding/CLI callers. The visible
	 * text still reaches interactive surfaces, while adapters can return a
	 * non-success process/result instead of treating any nonempty reply as done.
	 */
	terminalFailure?: MessageTerminalFailure;
}): StrategyResult {
	let responseContent: Content = {
		thought: args.thought,
		actions: ["REPLY"],
		text: restorePiiInUserReplyText(args.text),
		simple: args.mode !== "actions",
		responseId: args.responseId,
		...(args.agentVoiced === true ? { agentVoiced: true } : {}),
		...(args.terminalFailure
			? {
					failureKind: args.terminalFailure.kind,
					terminalFailure: {
						kind: args.terminalFailure.kind,
						message: args.terminalFailure.message,
						transient: args.terminalFailure.transient,
						...(args.terminalFailure.code
							? { code: args.terminalFailure.code }
							: {}),
					},
					elizaSyntheticFailure: true,
					transient: args.terminalFailure.transient,
				}
			: {}),
		...(args.attachments?.length ? { attachments: args.attachments } : {}),
		...(args.transcriptVisibility
			? { transcriptVisibility: args.transcriptVisibility }
			: {}),
		...(args.effectReceiptIds?.length
			? { effectReceiptIds: [...args.effectReceiptIds] }
			: {}),
	};
	if (args.effectReceiptIds?.length && responseContent.text) {
		responseContent = bindEffectDelivery(
			responseContent,
			responseContent.text,
			args.effectReceiptIds,
			true,
		);
	}

	return {
		responseContent,
		responseMessages: [
			{
				id: args.responseId,
				entityId: args.runtime.agentId,
				agentId: args.runtime.agentId,
				content: responseContent,
				roomId: args.message.roomId,
				createdAt: Date.now(),
			},
		],
		state: args.state,
		mode: args.mode ?? "simple",
		...(args.terminalFailure ? { terminalFailure: args.terminalFailure } : {}),
	};
}

/**
 * Bind an internal transcript marker only to the exact action diagnostic that
 * became the selected reply. A distinct evaluator or sub-planner summary stays
 * visible even when it follows an internal tool result.
 */
export function resolveActionResultTranscriptVisibility(
	text: string,
	actionResults: readonly ActionResult[] | undefined,
): "internal" | undefined {
	const canonicalize = (value: string) =>
		value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.join("\n")
			.trim();
	const selected = canonicalize(text);
	if (!selected) return undefined;
	return actionResults?.some((result) => {
		if (result.transcriptVisibility !== "internal") return false;
		const candidates = typeof result.text === "string" ? [result.text] : [];
		const subSteps =
			result.data &&
			typeof result.data === "object" &&
			Array.isArray(result.data.subSteps)
				? result.data.subSteps
				: [];
		const terminalSubStep = subSteps.at(-1);
		if (
			terminalSubStep &&
			typeof terminalSubStep === "object" &&
			"internalTranscriptText" in terminalSubStep &&
			typeof terminalSubStep.internalTranscriptText === "string"
		) {
			candidates.push(terminalSubStep.internalTranscriptText);
		}
		return candidates.some((candidate) => canonicalize(candidate) === selected);
	})
		? "internal"
		: undefined;
}

/**
 * True when any of the turn's candidate actions resolves to a registered
 * action flagged `asyncHandoff` — work whose execution continues after the
 * turn returns (sub-agent spawn class). This is the structural gate for the
 * Stage-1 pre-planner early ack: an ack ahead of the final reply is only
 * warranted when the routed work is an async handoff; synchronous retrieval
 * turns deliver a single reply (the answer) on every channel. Candidates are
 * matched against canonical names AND similes because Stage 1 routinely
 * hints an action by one of its similes.
 */
export function candidateActionsIncludeAsyncHandoff(
	actions: readonly Action[] | undefined,
	candidateActionNames: readonly string[],
): boolean {
	if (!actions || actions.length === 0 || candidateActionNames.length === 0) {
		return false;
	}
	const candidates = new Set(
		candidateActionNames.map((name) => normalizeActionIdentifier(name)),
	);
	return actions.some(
		(action) =>
			action.asyncHandoff === true &&
			[action.name, ...(action.similes ?? [])].some((identifier) =>
				candidates.has(normalizeActionIdentifier(identifier)),
			),
	);
}
