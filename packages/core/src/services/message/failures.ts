/** Builds user-visible failure responses while preserving complete dialogue context and explicit missing-provider failures. */

import { getRecentMessagesData } from "../../recent-messages-state";
import { sanitizeUserVisibleModelOutput } from "../../runtime/user-visible-model-output";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import type { Content, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { addHeader, conversationMessagesHeader } from "../../utils";
import type { FailureReplyAttempt, StrategyResult } from "./contracts.js";
import {
	buildFailureReplyPrompt,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isElizaCloudGatewayWarmingExhaustedError,
	isInsufficientCreditsError,
	isRateLimitError,
	type StructuredFailureCause,
	stripReasoningBlocks,
} from "./fallback-reply";
import { labelHistorySources } from "./history-wire";
import { reportRejectedUserVisibleModelOutput } from "./stage1-output.js";
import { hasTextGenerationHandler } from "./trajectory-stages.js";
export class MessageFailures {
	resolveRecentMessagesForFailureReply(state: State, message: Memory): string {
		if (
			typeof state.values?.recentMessages === "string" &&
			state.values.recentMessages.trim().length > 0
		) {
			const recentMessages = state.values.recentMessages;
			const entries =
				state.data?.providers?.RECENT_MESSAGES?.data?.formattedMessageSegments;
			if (
				Array.isArray(entries) &&
				entries.every((entry) => typeof entry === "string")
			) {
				const header = conversationMessagesHeader(
					getRecentMessagesData(state).length,
				);
				// Only the exact provider rendering may use entry references. Custom,
				// stale or incomplete formatting retains the full legacy string.
				if (addHeader(header, entries.join("\n")) === recentMessages) {
					const segments = entries.map((content, index) => ({
						id: `failure-history:${index}`,
						content,
						stable: false,
					}));
					const encoded = labelHistorySources(
						segments,
						new Map(
							segments.map((segment, index) => [segment.id, `h${index + 1}`]),
						),
						"referenced",
					);
					const referenced = addHeader(
						header,
						encoded.map((segment) => segment.content).join("\n"),
					);
					if (referenced.length < recentMessages.length) return referenced;
				}
			}
			return recentMessages;
		}
		if (typeof state.text === "string" && state.text.trim().length > 0) {
			return state.text;
		}
		if (typeof message.content.text === "string") {
			return message.content.text;
		}
		return "(unavailable)";
	}

	async generateFailureReplyText(
		runtime: IAgentRuntime,
		prompt: string,
		stage: string,
	): Promise<FailureReplyAttempt> {
		let sawCreditsExhausted = false;
		let sawRateLimit = false;
		let sawAuthError = false;
		for (const modelType of [
			ModelType.TEXT_LARGE,
			ModelType.RESPONSE_HANDLER,
			ModelType.TEXT_SMALL,
			ModelType.TEXT_NANO,
		] as const) {
			try {
				// Bound reasoning on reasoning models (#16394): the failure-reply
				// path is a plain-text fallback that must stay low-latency, so every
				// slot carries thinking="off" like Stage-1, the evaluator, and every
				// planner iteration. Without it a drained/failed turn can still spend
				// hundreds of hidden reasoning tokens before producing visible text.
				const response = await runtime.useModel(modelType, {
					prompt,
					providerOptions: { eliza: { thinking: "off" } },
				});
				if (typeof response !== "string") {
					continue;
				}

				const cleaned = stripReasoningBlocks(response);
				const visible = sanitizeUserVisibleModelOutput(cleaned);
				if (visible.kind === "text" && visible.format === "plain") {
					return { kind: "text", value: visible.text };
				}
				if (visible.kind === "empty") {
					continue;
				}

				// error-policy:J3 the fallback prompt requires plain text. A
				// typed invalid/control result advances to the next model slot
				// and is reported instead of masquerading as a valid reply.
				reportRejectedUserVisibleModelOutput({
					runtime,
					scope: "MessageService.generateFailureReplyText",
					code: "FAILURE_REPLY_INVALID_MODEL_OUTPUT",
					message:
						"Failure-reply model violated the plain-text output contract",
					stage,
					output: visible,
					context: { modelType },
				});
			} catch (error) {
				// error-policy:J1 this model-fallback boundary translates
				// provider failures into the typed outcome the caller renders.
				// If the runtime reports no LLM provider is configured at all,
				// no further model attempts will succeed. Surface the actionable
				// hint instead of the generic transient-failure message. See
				// elizaOS/eliza#7203.
				if (
					error instanceof Error &&
					error.name === "NoModelProviderConfiguredError"
				) {
					return { kind: "noProvider" };
				}
				// Eliza Cloud already spent its complete in-handler warming
				// budget. Starting the next failure-reply model slot would create a
				// fresh useModel dispatch and repay that same provider budget (up to
				// four times) before falling back to the canned reply. Treat the
				// typed exhaustion as terminal for this fallback loop while
				// preserving any more actionable sticky failure seen earlier.
				if (isElizaCloudGatewayWarmingExhaustedError(error)) {
					runtime.logger.warn(
						{
							src: "service:message",
							stage,
							modelType,
							error: error instanceof Error ? error.message : String(error),
						},
						"Structured failure reply stopped after Cloud warming exhaustion",
					);
					if (sawCreditsExhausted) return { kind: "creditsExhausted" };
					if (sawAuthError) return { kind: "authFailed" };
					if (sawRateLimit) return { kind: "rateLimited" };
					return { kind: "text", value: "" };
				}
				// Credit exhaustion and account authorization are sticky across
				// slots because no later model tier can heal the shared account.
				// The rate-limit flag still tracks the most recent slot's cause:
				// reporting "rate-limited" only when the LAST attempted slot was
				// a 429 avoids misleading the user in a mixed-failure run.
				// Credits are classified before rate limits below: a 429 *with*
				// billing context is a drained balance ("top up"), not a
				// transient throttle ("try again in a few seconds").
				sawCreditsExhausted ||= isInsufficientCreditsError(error);
				sawRateLimit = isRateLimitError(error);
				sawAuthError ||= isAuthError(error);
				runtime.logger.warn(
					{
						src: "service:message",
						stage,
						modelType,
						error: error instanceof Error ? error.message : String(error),
					},
					"Structured failure reply generation failed for model",
				);
			}
		}
		// Every model slot failed without a usable reply. When the final cause
		// was credit exhaustion (402/insufficient_credits), the condition is
		// permanent until the user tops up — "try again" can never succeed, so
		// surface the actionable top-up message.
		if (sawCreditsExhausted) {
			return { kind: "creditsExhausted" };
		}
		// When the final cause was provider rate-limiting (429), tell the user
		// that plainly instead of the opaque generic message — the honest
		// signal is "try again shortly", not "something broke".
		if (sawRateLimit) {
			return { kind: "rateLimited" };
		}
		// An auth failure (bad/expired/unauthorized cloud key) is actionable —
		// tell the user to fix their key/credits, not the opaque generic message.
		if (sawAuthError) {
			return { kind: "authFailed" };
		}
		return { kind: "text", value: "" };
	}

	async buildStructuredFailureReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
		cause: StructuredFailureCause = "transient",
	): Promise<StrategyResult> {
		// Short-circuit when no LLM provider is configured at all. The fallback
		// model loop below would just throw `NoModelProviderConfiguredError` for
		// every model type and surface a misleading generic failure to the user.
		// Instead, render an actionable hint directly. See elizaOS/eliza#7203.
		if (!hasTextGenerationHandler(runtime)) {
			return this.buildNoModelProviderReply(
				runtime,
				message,
				state,
				responseId,
				stage,
			);
		}

		const recentMessages = this.resolveRecentMessagesForFailureReply(
			state,
			message,
		);
		const failurePrompt = buildFailureReplyPrompt(recentMessages, cause);

		const attempt = await this.generateFailureReplyText(
			runtime,
			failurePrompt,
			stage,
		);
		if (attempt.kind === "noProvider") {
			return this.buildNoModelProviderReply(
				runtime,
				message,
				state,
				responseId,
				stage,
			);
		}

		let replyText = attempt.kind === "text" ? attempt.value : "";
		if (!replyText) {
			// Last-ditch fallback when every model call above also failed.
			// Voice-neutral so any character can ship this default; characters
			// can override with their own phrasing via
			// character.templates.transientFailureReply (or
			// rateLimitedReply / insufficientCreditsReply for the specific
			// cases).
			if (attempt.kind === "creditsExhausted") {
				const tmpl = runtime.character.templates?.insufficientCreditsReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					INSUFFICIENT_CREDITS_REPLY;
			} else if (attempt.kind === "rateLimited") {
				const tmpl = runtime.character.templates?.rateLimitedReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"My model provider is rate-limiting me right now — give it a few seconds and try again.";
			} else if (attempt.kind === "authFailed") {
				const tmpl = runtime.character.templates?.authFailedReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"My Eliza Cloud key isn't authorized for inference right now — check that your cloud key is valid and your account has credits, then try again.";
			} else if (cause === "missing_capability") {
				// Permanent gap: never fall through to transientFailureReply
				// ("try again in a moment") — that copy invites a retry that
				// cannot succeed until the capability is enabled (#17027 AC6).
				// Dedicated template when present; otherwise the built-in
				// capability-unavailable default.
				const tmpl = runtime.character.templates?.missingCapabilityFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"I can't do that here right now - it needs a capability that isn't available in this setup.";
			} else if (cause === "planner_exhaustion") {
				// Retryable budget exhaustion. Dedicated template first; the
				// legacy transientFailureReply remains a voice-compatible
				// fallback only for this recoverable class.
				const tmpl = runtime.character.templates?.plannerExhaustionFailureReply;
				const fallbackTmpl = runtime.character.templates?.transientFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					(typeof fallbackTmpl === "function"
						? fallbackTmpl({ state })
						: fallbackTmpl) ||
					"I ran out of attempts before I could finish that. Nothing was completed - please try again.";
			} else if (cause === "context_overflow") {
				// The provider rejected the call at its context limit; retrying the
				// identical request cannot succeed, so the honest reply asks for a
				// smaller ask instead of the generic "try again".
				const tmpl = runtime.character.templates?.contextOverflowFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"That needed more context than my model can take in one call - try a smaller range or a narrower request.";
			} else {
				const tmpl = runtime.character.templates?.transientFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"Something went wrong on my end. Please try again.";
			}
		}

		replyText = replyText.trim();

		// Preserve the terminal cause at the delivery boundary. Provider failures
		// encountered while generating the apology take precedence because the
		// canned reply describes that condition. Capability, action, persistence,
		// auth, and credit failures remain stable until their cause changes;
		// throttling, planner exhaustion, and generic infrastructure failures can
		// be retried without presenting a durable success record.
		const failureKind =
			attempt.kind === "creditsExhausted"
				? "insufficient_credits"
				: attempt.kind === "rateLimited"
					? "rate_limited"
					: attempt.kind === "authFailed"
						? "provider_issue"
						: cause === "transient"
							? "transient_failure"
							: cause;
		const responseContent: Content = {
			thought: `Handle a ${cause} reply failure during ${stage}.`,
			actions: ["REPLY"],
			failureKind,
			elizaSyntheticFailure: true,
			transient:
				failureKind === "transient_failure" || failureKind === "rate_limited",
			doNotPersist: true,
			text: replyText,
			responseId,
		};

		const responseMessages: Memory[] = [
			{
				id: responseId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

		return {
			responseContent,
			responseMessages,
			state,
			mode: "simple",
		};
	}

	/**
	 * Render the no-LLM-provider hint as a chat reply. Used when `useModel`
	 * throws `NoModelProviderConfiguredError`, which means no provider plugin
	 * is registered and no fallback model call will ever succeed. The user
	 * sees an actionable message instead of a generic transient-failure
	 * template. See elizaOS/eliza#7203.
	 */
	buildNoModelProviderReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
	): StrategyResult {
		const noProviderTmpl = runtime.character.templates?.noModelProviderReply;
		const replyText =
			(typeof noProviderTmpl === "function"
				? noProviderTmpl({ state })
				: noProviderTmpl) ||
			"This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).";

		runtime.logger.warn(
			{ src: "service:message", stage },
			"No LLM provider configured; rendering setup hint reply",
		);

		const responseContent: Content = {
			thought: `No LLM provider configured during ${stage}.`,
			actions: ["REPLY"],
			failureKind: "no_provider",
			text: replyText,
			responseId,
		};

		const responseMessages: Memory[] = [
			{
				id: responseId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

		return {
			responseContent,
			responseMessages,
			state,
			mode: "simple",
		};
	}
}
