/** Resolves the completed planner turn into a deliverable reply or an explicit silent terminal. Preserves tool receipts, prior delivery deduplication, and the addressed-turn delivery guarantee. */

import { logger } from "../../logger";
import {
	FAILED_TOOL_FALLBACK_MESSAGE,
	HANDLED_STEP_FALLBACK_MESSAGE,
	type PlannerLoopResult,
	type PlannerToolResult,
	PROGRESS_ONLY_ANSWER_REJECT,
} from "../../runtime/planner-loop";
import type { Action, MessageHandlerResult } from "../../types/components";
import type { State } from "../../types/state";
import type { V5MessageRuntimeStage1Result } from "./contracts.js";
import {
	appliedEffectReceiptIdsForReply,
	capturePlannerReplyRecovery,
	evaluatePlannedReplyEgress,
	resolvePlannedReplyEgress,
} from "./egress-policy.js";
import {
	collectMediaDeliveryUrls,
	sanitizeReplyTextAfterMediaDelivery,
} from "./media-delivery.js";
import { collectPreviousActionResults } from "./planned-tool.js";
import {
	answerlessToolTurnReport,
	createV5ReplyStrategyResult,
	deliveredTextsCoverReply,
	NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
	normalizeVisibleTextForDuplicateCheck,
	resolveActionResultTranscriptVisibility,
	resolveZeroDeliveryRecovery,
} from "./reply-policy.js";
import { withActionResultsForPrompt } from "./response-state.js";
import { subAgentCompletionRelayBody } from "./task-completion-relay.js";
import type { V5MessageRuntimeInput } from "./turn-input.js";

export async function finalizePlannerReply(
	args: V5MessageRuntimeInput,
	{
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
		recoveredReply,
		replyRecovered,
	}: {
		plannerResult: PlannerLoopResult;
		exposedPlannerActions: Action[];
		plannerState: State;
		ambientTurn: boolean;
		earlyReplySent: boolean;
		messageHandler: MessageHandlerResult;
		prePatchStageOneReplyIsUngroundedAppliedClaim: boolean;
		prePatchStageOneReply: string | undefined;
		earlyReplyText: string;
		settledPlannerToolResults: Array<{
			name: string;
			result: PlannerToolResult;
		}>;
		deliveredVisibleTexts: Set<string>;
		recoveredReply:
			| Awaited<ReturnType<typeof resolvePlannedReplyEgress>>
			| undefined;
		replyRecovered: boolean;
	},
): Promise<V5MessageRuntimeStage1Result> {
	const actionResults = collectPreviousActionResults(
		plannerResult.trajectory,
		exposedPlannerActions,
	);
	const finalPlannerState =
		actionResults.length > 0
			? withActionResultsForPrompt(plannerState, actionResults, args.runtime)
			: plannerState;
	const plannedTextRaw = String(plannerResult.finalMessage ?? "").trim();
	const deliveredMediaUrls = collectMediaDeliveryUrls(actionResults);
	// HANDLED_STEP_FALLBACK_MESSAGE is the planner's marker for "this turn
	// produced no usable user-facing text": `userSafeFinalMessage` emits it
	// when every model candidate failed the egress safety chain and no tool
	// exposed user-facing text. The tool-turn reply guarantee normally
	// replaces it, but only for turns that ran a successful non-terminal
	// tool — a turn with no tool work keeps the placeholder and ships it.
	// On an unaddressed turn that is a description of the agent's own
	// process posted into a room full of other people, the exact filler the
	// ambient-turn policy forbids, and the policy's own semantics for an
	// empty outcome are silence. Structural, not prompt-dependent: the
	// placeholder is runtime-produced, so no instruction to the model can
	// prevent it. On a turn that owes a response, blanking this internal marker
	// routes through `resolveZeroDeliveryRecovery`, whose toolless fallback is
	// a truthful no-answer rather than a fabricated claim of completed work.
	const unusablePlannerReply = plannedTextRaw === HANDLED_STEP_FALLBACK_MESSAGE;
	const ambientPlaceholderOnlyReply = ambientTurn && unusablePlannerReply;
	const plannedText = unusablePlannerReply
		? ""
		: sanitizeReplyTextAfterMediaDelivery(plannedTextRaw, deliveredMediaUrls);
	// Single source of truth for "this ambient turn ends in silence",
	// covering both the planner's own IGNORE/STOP terminal and the
	// placeholder outcome above. Both resolve through the same terminal and
	// the same reply suppression below, so there is one silence path.
	const ambientDeliberateSilence =
		ambientTurn &&
		(plannerResult.endedWithDeliberateSilence === true ||
			ambientPlaceholderOnlyReply);
	// Deliberate silence on an ambient turn — the planner's own IGNORE/STOP
	// terminal, or the placeholder outcome that means the same thing. The
	// ambient-turn policy instruction tells the planner to end an empty
	// unaddressed turn with IGNORE, so honor that the way a Stage-1 IGNORE is —
	// a terminal decision handleMessage records observably (an
	// actions:["IGNORE"] terminal memory + MESSAGE_SENT), not a bare
	// mode-"none" result indistinguishable from a dropped turn. Scoped to
	// turns where nothing reached the user (no early ack, no action results,
	// no planner text): once anything was delivered, the existing
	// planned-reply bookkeeping below must keep owning dedupe and delivery.
	// This also pre-empts the stage-one-ack fallback below — on an ambient
	// turn an undelivered drafted ack is exactly the filler the policy
	// exists to suppress. Addressed turns never take this branch, so the
	// turn-delivery floor (an addressed turn always delivers) is untouched.
	if (
		ambientDeliberateSilence &&
		!earlyReplySent &&
		actionResults.length === 0 &&
		!plannedText
	) {
		return {
			kind: "terminal",
			action: plannerResult.silentTerminalAction ?? "IGNORE",
			messageHandler,
			state: finalPlannerState,
		};
	}
	// Some action turns intentionally finish without planner prose. For async
	// work (for example spawning a coding task), still return a non-empty
	// synchronous acknowledgement so HTTP/connector callers don't render a blank
	// "(no response)" while the real work continues in the background. Respect
	// explicit suppressPlannerReply terminal actions (IGNORE/STOP-style flows),
	// which are deliberately silent.
	// Ambient deliberate silence counts as suppression even after tool work:
	// the ambient-turn policy invites the planner to attempt work before
	// choosing IGNORE, so a turn that ran a tool and then ended on a silent
	// terminal must not have the ack fallback below "fix" that silence into
	// filler ("on it, working on that now.") — the exact narration the
	// policy suppresses — nor resurrect a preserved stage-0 draft the
	// planner deliberately declined to send.
	const suppressesPlannerReply =
		actionResults.some(
			(result) =>
				(result.data as { suppressPlannerReply?: unknown } | undefined)
					?.suppressPlannerReply === true,
		) || ambientDeliberateSilence;
	const ranNonSilentAction =
		actionResults.length > 0 && !suppressesPlannerReply;
	const rawStageOneAck =
		typeof messageHandler.plan.reply === "string"
			? messageHandler.plan.reply.trim()
			: "";
	const stageOneAck =
		prePatchStageOneReplyIsUngroundedAppliedClaim &&
		rawStageOneAck === prePatchStageOneReply?.trim()
			? ""
			: rawStageOneAck;
	// Answerless-final fallback: when the planner loop finished with NO final
	// text, a preserved substantive stage-0 answer is strictly better than
	// silence or filler — deliver it. This applies whether or not an early
	// ack shipped; when one did, the dedup guard keeps the early text from
	// delivering twice. The action dedup guards below still apply.
	const preservedAnswerFallback =
		!plannedText &&
		!suppressesPlannerReply &&
		!messageHandler.plan.deterministicToolCall &&
		prePatchStageOneReply &&
		!prePatchStageOneReplyIsUngroundedAppliedClaim &&
		!PROGRESS_ONLY_ANSWER_REJECT.test(prePatchStageOneReply.trim()) &&
		(!earlyReplySent ||
			normalizeVisibleTextForDuplicateCheck(prePatchStageOneReply) !==
				normalizeVisibleTextForDuplicateCheck(earlyReplyText))
			? prePatchStageOneReply
			: "";
	// The answerless floor reports an undelivered canonical tool outcome, stays
	// silent after a callback delivery, retains an ack only for a successfully
	// accepted async handoff, and otherwise says no result was produced.
	// A media deliverable delivered through an action's own callback
	// (GENERATE_MEDIA posts an attachment-only, text:"" callback) IS the turn's
	// answer. The answerless-final floor must not then resurrect the Stage-1
	// "on it" ack behind the image — a redundant, out-of-order second bubble.
	// deliveredMediaUrls is non-empty only for a SYNCHRONOUSLY delivered media
	// attachment, so a slow/async generation (nothing delivered yet) still acks.
	const mediaDeliverableShipped = deliveredMediaUrls.length > 0;
	const ackFallback =
		!plannedText && !earlyReplySent && !suppressesPlannerReply
			? preservedAnswerFallback ||
				(ranNonSilentAction && !mediaDeliverableShipped
					? answerlessToolTurnReport({
							settledToolResults: settledPlannerToolResults,
							deliveredVisibleTexts,
							actionResults,
							actions: args.runtime.actions,
							stageOneAck,
						})
					: "")
			: preservedAnswerFallback;
	let effectiveReplyText = plannedText || ackFallback;
	// #18208: a failed sub-agent completion relay must not discard the
	// finished result it carries. When the turn ended on the generic
	// failed-tool fallback and the triggering message IS a task_complete
	// relay — whose body is the sub-agent's completed result, composed for
	// user delivery — deliver that body instead of the canned line. Every
	// other failed turn keeps the canned fallback, and the replacement
	// still flows through the egress/dedupe checks below.
	if (
		effectiveReplyText === FAILED_TOOL_FALLBACK_MESSAGE ||
		// Same rescue for the answerless variant: a relay turn whose planner
		// misfired into a rejected tool otherwise shipped "ran that, but no
		// result came back" while the finished result sat in the message body
		// (live 2026-08-19: maze-runner relay → deterministic MODEL_SWITCH
		// role-rejected → filler instead of the build result).
		effectiveReplyText === NO_REPORTABLE_TOOL_OUTCOME_MESSAGE
	) {
		const relayBody = subAgentCompletionRelayBody(args.message?.content?.text);
		if (relayBody) {
			logger.debug(
				"[MessageService] failed relay turn degraded to preserved sub-agent result",
			);
			effectiveReplyText = relayBody;
		}
	}
	// Coding-mode terminal claims were already checked against the concrete
	// planner trajectory (including mandatory post-mutation SHELL proof).
	// Generic chat egress requires EffectReceipts, which local file tools do
	// not mint, and would replace a verified coding result with a false
	// "couldn't verify" fallback.
	const finalReplyEgressDecision =
		args.codingMode === true || recoveredReply?.text === effectiveReplyText
			? ({ verdict: "allow" } as const)
			: evaluatePlannedReplyEgress({
					providers: finalPlannerState.data.providers,
					request: args.message.content.text,
					reply: effectiveReplyText,
					actionResults,
					actions: args.runtime.actions,
					evaluator: plannerResult.evaluator,
				});
	if (finalReplyEgressDecision.verdict === "reject") {
		recoveredReply = await resolvePlannedReplyEgress({
			providers: finalPlannerState.data.providers,
			runtime: args.runtime,
			message: args.message,
			reply: effectiveReplyText,
			actionResults,
			evaluator: plannerResult.evaluator,
			recovery: capturePlannerReplyRecovery(
				args.runtime,
				args.message,
				plannerResult.trajectory,
			),
		});
		effectiveReplyText = recoveredReply.text;
		replyRecovered = true;
	}
	const plannedTextRepeatsEarlyReply =
		earlyReplySent &&
		normalizeVisibleTextForDuplicateCheck(effectiveReplyText) ===
			normalizeVisibleTextForDuplicateCheck(earlyReplyText);
	// An action that already delivered this text through its own callback makes
	// the planner's finalMessage a redundant second bubble. Suppress the planner
	// echo when an action already delivered the same text OR a strict superset of
	// it — the action's richer confirmation (a created-issue URL, an id, a "reply
	// yes to confirm" follow-up) carries everything the planner's shorter
	// restatement does and more, so keep the action's text and drop the echo. The
	// non-word-boundary guard stops a short prefix from swallowing an unrelated
	// longer line ("created" must not match "created issue …").
	const normalizedPlannedReply =
		normalizeVisibleTextForDuplicateCheck(effectiveReplyText);
	const plannedTextRepeatsActionReply = deliveredTextsCoverReply(
		deliveredVisibleTexts,
		normalizedPlannedReply,
	);
	// The planner's generic failed-tool fallback exists so a failed turn is
	// never silent. When the failed action's own callback already delivered
	// its user-facing explanation (a confirmation preview, a "cloud-only"
	// boundary notice), appending "I tried … but it failed" contradicts what
	// the user just read — drop the fallback and let the tool's words stand.
	const plannedTextIsRedundantFailureFallback =
		effectiveReplyText === FAILED_TOOL_FALLBACK_MESSAGE &&
		actionResults.some((result) => {
			if (result.success !== false) return false;
			return [result.userFacingText, result.text].some((ownedText) => {
				const normalized = normalizeVisibleTextForDuplicateCheck(
					String(ownedText ?? ""),
				);
				return normalized.length > 0 && deliveredVisibleTexts.has(normalized);
			});
		});
	// The planned ⊇ delivered direction of the suppression above, gated on
	// callback-delivery provenance (the delivered-set membership) not text
	// equality: when a verifiedUserFacing action already sent its userFacingText
	// through its own callback, a planned reply that merely re-renders that block
	// verbatim duplicates a message the user already has. Only a TRIVIAL
	// re-render collapses, though — if the planner appended substantive prose to
	// the verbatim block (the evaluator's grounded answer, #7960: a `df -h` mount
	// table followed by "still 95%, 22G free"), that prose was never
	// callback-delivered and still ships; the remainder check below enforces
	// that. Verified actions that never invoked the callback fail delivered-set
	// membership, so finalMessage remains their sole delivery.
	const plannedTextRepeatsVerifiedActionDelivery = actionResults.some(
		(result) => {
			if (result.verifiedUserFacing !== true) return false;
			const verified =
				typeof result.userFacingText === "string"
					? normalizeVisibleTextForDuplicateCheck(result.userFacingText)
					: "";
			if (verified.length === 0 || !deliveredVisibleTexts.has(verified)) {
				return false;
			}
			if (!normalizedPlannedReply.includes(verified)) return false;
			// Trivial-re-render check the block comment above promises (#7960).
			const remainder = normalizedPlannedReply
				.replace(verified, " ")
				.replace(/```/g, " ");
			return !/[a-z0-9]/.test(remainder);
		},
	);
	// Substantive-remainder counterpart of the suppression above, #7960 kept
	// intact: combinedVerifiedToolTextAndProse deterministically composes
	// `<verified block>\n\n<evaluator prose>` (fencing a multiline verified
	// text), so when the verified block was already callback-delivered the
	// planned reply re-sends a verbatim copy of a message the user has and
	// the prose is the only content they have not seen. Strip the block ONLY
	// in that code-composed leading position, matched byte-exactly (fenced
	// form first, then bare) against the delivered userFacingText. A
	// paraphrased re-render or a mid-prose mention is never touched — the
	// strip must not remove anything it cannot prove was already delivered,
	// and cutting inside flowing prose could mutilate a sentence.
	let strippedPlannedReplyText = effectiveReplyText;
	for (const result of actionResults) {
		if (result.verifiedUserFacing !== true) continue;
		if (typeof result.userFacingText !== "string") continue;
		const rawVerified = result.userFacingText.trim();
		if (
			rawVerified.length === 0 ||
			!deliveredVisibleTexts.has(
				normalizeVisibleTextForDuplicateCheck(rawVerified),
			)
		) {
			continue;
		}
		const fencedVerified = `\`\`\`\n${rawVerified}\n\`\`\``;
		const source = strippedPlannedReplyText;
		if (source.startsWith(`${fencedVerified}\n\n`)) {
			strippedPlannedReplyText = source.slice(fencedVerified.length).trim();
		} else if (source.startsWith(`${rawVerified}\n\n`)) {
			strippedPlannedReplyText = source.slice(rawVerified.length).trim();
		}
	}
	let effectiveDeliveredReplyText =
		strippedPlannedReplyText || effectiveReplyText;
	let shouldSendPlannedText =
		Boolean(effectiveReplyText) &&
		// suppressPlannerReply is the action's declaration that this turn's
		// answer was already delivered outside the planner (out-of-band ack,
		// IGNORE/STOP-style terminal). The flag gated the fallbacks but not
		// the evaluator's own FINISH text, so a mimicked "On it — building
		// that now." trailed the real result (live 2026-08-19, trajectory
		// eval-FINISH evidence across four runs).
		!suppressesPlannerReply &&
		!plannedTextRepeatsEarlyReply &&
		!plannedTextRepeatsActionReply &&
		!plannedTextIsRedundantFailureFallback &&
		!plannedTextRepeatsVerifiedActionDelivery;
	// NEVER-SILENT INVARIANT (matrix F24/F12, tj-bfe764bf544bed /
	// tj-fda9d65e8d04b9): a RESPOND turn that executed tools must not end
	// with zero deliveries. Every suppression above presupposes the user
	// already received the content through some earlier delivery — when
	// NOTHING was delivered this turn (no early ack, empty delivered-set)
	// that premise is false by construction, and an empty
	// `effectiveReplyText` (a FINISH whose message evaporated in the
	// safety chain) otherwise ships `responseContent: null`: the runtime
	// produced a correct answer and the user got silence. Recover with the
	// best grounded text available and name the failure in the log so the
	// upstream emptying path is diagnosable instead of invisible.
	// Three states are NOT recoverable silence: a synchronously delivered
	// media deliverable is a delivery even though it never enters the
	// visible-TEXT set; deliberate silence (suppressPlannerReply
	// terminals, ambient IGNORE after tool work) is a contract this
	// invariant must honor, not a failure for it to "fix" into filler;
	// and a planned reply suppressed because the early ack ALREADY said it
	// verbatim means the terminal content did reach the user. An early
	// PROGRESS ack alone, however, is not a terminal answer — the turn
	// still owes the user its outcome, so `earlyReplySent` by itself does
	// not disarm the recovery; it only removes the ack (and any text that
	// repeats it) from the pool of recovery sources so nothing delivers
	// twice (#20086). One asymmetry is deliberate: the early ack only
	// ships ahead of an async handoff, whose completion arrives through a
	// later relay turn — after an ack, recover only when grounded terminal
	// text exists or any tool failed (a failed handoff will never relay
	// a completion, so the ack's promise must be corrected). A successful
	// ack-then-background turn with nothing grounded to say stays silent.
	const zeroDeliveryRecovery = resolveZeroDeliveryRecovery({
		plannedText: plannedTextRepeatsEarlyReply
			? ""
			: effectiveDeliveredReplyText,
		actionResults,
		stageOneAck,
		earlyReplySent,
	});
	if (
		!shouldSendPlannedText &&
		!suppressesPlannerReply &&
		!(earlyReplySent && plannedTextRepeatsEarlyReply) &&
		zeroDeliveryRecovery.recover &&
		deliveredVisibleTexts.size === 0 &&
		deliveredMediaUrls.length === 0 &&
		// Toolless planner deaths on an ADDRESSED turn are the same
		// recoverable silence: the planner exhausted its retries with no
		// tool call and no usable terminal text, every fallback above
		// rejected the ack-shaped Stage-1 reply, and the user saw nothing
		// (live 2026-08-17: casual-phrased coding asks after the
		// gpt-oss-120b cutover ended [messageHandler, toolSearch, planner]
		// with zero deliveries). Ambient turns keep their silence contract.
		(actionResults.length > 0 || !ambientTurn)
	) {
		args.runtime.logger.warn(
			{
				src: "service:message",
				emptyFinal: !effectiveReplyText,
				earlyReplySent,
				suppressedByEarlyReply: plannedTextRepeatsEarlyReply,
				suppressedByActionReply: plannedTextRepeatsActionReply,
				actionSuccessCount: zeroDeliveryRecovery.actionSuccessCount,
				actionFailureCount: zeroDeliveryRecovery.actionFailureCount,
				recoveredFrom: zeroDeliveryRecovery.source,
			},
			"RESPOND turn reached the reply gate with zero deliveries; recovering instead of ending silent",
		);
		recoveredReply = await resolvePlannedReplyEgress({
			providers: finalPlannerState.data.providers,
			runtime: args.runtime,
			message: args.message,
			reply: zeroDeliveryRecovery.text,
			actionResults,
			recovery: capturePlannerReplyRecovery(
				args.runtime,
				args.message,
				plannerResult.trajectory,
			),
		});
		effectiveReplyText = recoveredReply.text;
		strippedPlannedReplyText = effectiveReplyText;
		effectiveDeliveredReplyText = effectiveReplyText;
		replyRecovered = true;
		shouldSendPlannedText = true;
	}
	const effectiveReplyReceiptIds =
		recoveredReply?.text === effectiveDeliveredReplyText
			? recoveredReply.effectReceiptIds
			: appliedEffectReceiptIdsForReply(
					effectiveDeliveredReplyText,
					actionResults,
					plannerResult.evaluator,
				);
	// Voice-gate provenance (#14873): the Stage-1 ack has unambiguous model
	// provenance. A byte-exact canonical action result also needs preservation:
	// `verifiedUserFacing` promises do-not-paraphrase semantics, so routing that
	// text through a second model would violate its contract and can corrupt
	// punctuation or exact values. Mixed evaluator/tool prose and hardcoded
	// fallbacks remain unmarked so canned strings still receive the voice pass.
	const effectiveReplyIsModelVoice =
		(!plannedText &&
			stageOneAck.length > 0 &&
			effectiveReplyText === stageOneAck) ||
		(effectiveReplyReceiptIds.length > 0 &&
			plannerResult.evaluator?.messageToUser?.trim() ===
				effectiveDeliveredReplyText);
	const effectiveReplyIsCanonicalActionText = actionResults.some(
		(result) =>
			result.verifiedUserFacing === true &&
			typeof result.userFacingText === "string" &&
			effectiveDeliveredReplyText === result.userFacingText.trim(),
	);
	const transcriptVisibility = resolveActionResultTranscriptVisibility(
		plannedTextRaw || effectiveReplyText,
		actionResults,
	);
	const terminalFailure = plannerResult.terminalFailure;

	return {
		kind: "planned_reply",
		messageHandler,
		result: shouldSendPlannedText
			? {
					...createV5ReplyStrategyResult({
						...args,
						state: finalPlannerState,
						text: effectiveDeliveredReplyText,
						thought:
							plannerResult.evaluator?.thought ??
							plannerResult.trajectory.steps.at(-1)?.thought ??
							messageHandler.thought,
						agentVoiced:
							replyRecovered ||
							effectiveReplyIsModelVoice ||
							effectiveReplyIsCanonicalActionText,
						...(effectiveReplyReceiptIds.length > 0
							? { effectReceiptIds: effectiveReplyReceiptIds }
							: {}),
						...(transcriptVisibility ? { transcriptVisibility } : {}),
						...(terminalFailure ? { terminalFailure } : {}),
					}),
					...(actionResults.length > 0 ? { actionResults } : {}),
				}
			: {
					responseContent: null,
					responseMessages: [],
					state: finalPlannerState,
					mode: "none",
					...(terminalFailure ? { terminalFailure } : {}),
					...(actionResults.length > 0 ? { actionResults } : {}),
				},
	};
}
