/** Owns provider selection, shared execution lifetime, and audience-aware state composition for one runtime. Uses the runtime’s canonical public state cache and preserves original runtime identity at provider and hook boundaries. */

import { ElizaError } from "../../errors";
import { recordInferenceSpan } from "../../inference-timing";
import {
	authorizeOwnerExclusiveDisclosure,
	ownerExclusiveSuppressionNote,
	PRIVACY_DENIED_TEXT,
	revalidateOwnerExclusiveDisclosure,
	trustedDeliveryAudienceCacheKey,
} from "../../security/index.js";
import {
	getStreamingContext,
	runWithStreamingContext,
	runWithSuppressedModelStream,
} from "../../streaming-context";
import { getTrajectoryContext } from "../../trajectory-context";
import {
	type TrajectoryProviderAccessLogger,
	withProviderStep,
} from "../../trajectory-utils";
import type {
	IAgentRuntime,
	Memory,
	PipelineHookPhase,
	Provider,
	ResolvedPipelineHook,
	Service,
	ServiceTypeName,
	State,
	StateValue,
} from "../../types";
import { composeStateProvidersPipelineHookContext } from "../../types/pipeline-hooks";
import { resolveProviderContexts } from "../../utils/context-catalog";
import {
	getActiveRoutingContextsForTurn,
	shouldIncludeByContext,
} from "../../utils/context-routing";
import { buildDeterministicSeed } from "../../utils/deterministic";
import { toWellFormedUnicode } from "../../utils/well-formed.js";
import { buildProviderAttributionsFromState } from "../trajectory-provider-attribution";
import {
	awaitProviderExecution,
	type CachedProviderResult,
	calculateProviderOverlaps,
	type InFlightProviderExecution,
	type ProviderExecutionOutcome,
	type ProviderExecutionRecord,
	providerCancellationReason,
	runProviderExecution,
	throwIfProviderCompositionAborted,
} from "./provider-execution.js";

// stateCache holds up to 2 entries per message (base State + `${id}_action_results`).
// Previously it was never unconditionally evicted at end-of-turn, so a long-lived
// runtime accumulated one State per processed message for its lifetime (~4.7 KB/msg,
// ~23 MB at 5k messages). Cap it; oldest entries evict once over the cap, which keeps
// recent and in-flight turns while bounding memory.
export const STATE_CACHE_LIMIT = 512;

export class ProviderStateComposer {
	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly lifecycle: {
			hasProviderSelectionHooks: () => boolean;
			ensureServiceStarted: (
				serviceType: ServiceTypeName | string,
			) => Promise<Service | null>;
			isStopping: () => boolean;
		},
	) {}

	// Owner-private providers are revalidated on every compose and therefore
	// prevent the mixed State from entering stateCache. Public provider results
	// are still safe to reuse within the same Memory object's turn; WeakMap
	// lifetime keeps that reuse request-local without retaining messages.
	private readonly publicProviderStateByMessage = new WeakMap<
		Memory,
		{ text: unknown; state: State }
	>();

	private providerExecutionsInFlight = new Map<
		string,
		InFlightProviderExecution
	>();

	// Includes keyed/coalescible work and one-off executions (missing message id
	// or an explicit refresh). The coalescing map alone cannot own shutdown:
	// those one-off executions still need their controller aborted at teardown.
	private providerExecutionsActive = new Set<InFlightProviderExecution>();
	stop(): void {
		for (const execution of this.providerExecutionsActive)
			execution.controller.abort(new Error("Runtime stopped"));
		this.providerExecutionsActive.clear();
		this.providerExecutionsInFlight.clear();
	}

	async composeState(
		message: Memory,
		includeList: string[] | null = null,
		onlyInclude = false,
		skipCache = false,
		refreshProviders: string[] | null = null,
	): Promise<State> {
		const trajectoryStepIdFromMessage =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryStepId" in message.metadata
				? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
				: undefined;
		const trajectoryStepId =
			typeof trajectoryStepIdFromMessage === "string" &&
			trajectoryStepIdFromMessage.trim() !== ""
				? trajectoryStepIdFromMessage
				: getTrajectoryContext()?.trajectoryStepId;

		// Recording is observational: it must neither blank cached state nor force
		// cached providers to execute again. Reused providers are logged as cache
		// hits below, so enabling trajectories cannot add latency or change what a
		// provider observes.
		const filterList = onlyInclude ? includeList : null;
		const emptyObj = {
			values: {},
			data: {},
			text: "",
		} as State;
		const audienceCacheKey = trustedDeliveryAudienceCacheKey(message);
		const publicProviderCache = this.publicProviderStateByMessage.get(message);
		const cachedPublicState =
			publicProviderCache !== undefined &&
			publicProviderCache.text === message.content.text
				? publicProviderCache.state
				: undefined;
		const cachedCandidate =
			skipCache || !message.id
				? emptyObj
				: (this.runtime.stateCache.get(message.id) ??
					cachedPublicState ??
					emptyObj);
		const cachedState =
			cachedCandidate === emptyObj ||
			(cachedCandidate.data.__trustedDeliveryAudienceCacheKey ===
				audienceCacheKey &&
				(cachedCandidate.data as Record<string, unknown>).__roomId ===
					message.roomId)
				? cachedCandidate
				: emptyObj;
		const activeContexts = getActiveRoutingContextsForTurn(
			cachedState,
			message,
		);
		const providerNames = new Set<string>();
		if (filterList && filterList.length > 0) {
			// The onlyInclude path honors the explicit name list without enforcing
			// provider roleGates: the Stage-1 response state deliberately
			// force-includes recall providers like FACTS for every sender, and
			// unassigned senders (ordinary humans AND relay/webhook bridges
			// carrying human conversation) resolve to GUEST by default (roles.ts
			// getEntityRole), so gate enforcement here would silently strip
			// cross-turn recall from exactly the turns that need it. Callers that
			// name a provider explicitly own that inclusion decision.
			for (const name of filterList) {
				providerNames.add(name);
			}
		} else {
			for (const p of this.runtime.providers.filter(
				(p) => !p.private && !p.dynamic,
			)) {
				if (
					activeContexts.length > 0 &&
					!shouldIncludeByContext(resolveProviderContexts(p), activeContexts)
				) {
					continue;
				}
				providerNames.add(p.name);
			}
		}
		if (!filterList && includeList && includeList.length > 0) {
			for (const name of includeList) {
				providerNames.add(name);
			}
		}
		// Opt-in provider-selection hook: lets a host app filter, extend, or
		// reorder the provider set per message intent before any provider runs.
		// Guarded so the default (no-hook) path stays allocation-free.
		if (this.lifecycle.hasProviderSelectionHooks()) {
			const selection = composeStateProvidersPipelineHookContext({
				message,
				providers: { current: [...providerNames] },
				activeContexts,
				onlyInclude,
				includeList,
			});
			await this.runtime.applyPipelineHooks(
				"compose_state_providers",
				selection,
			);
			// Boundary validation: a buggy hook may replace `current` with a
			// non-array (or throw mid-mutation). Only adopt a well-formed list;
			// otherwise keep the pre-hook selection rather than crash the turn.
			const selected = selection.providers.current;
			if (Array.isArray(selected)) {
				providerNames.clear();
				for (const name of selected) {
					if (typeof name === "string" && name.length > 0) {
						providerNames.add(name);
					}
				}
			} else {
				this.runtime.logger.warn(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						phase: "compose_state_providers",
					},
					"compose_state_providers hook left providers.current non-array; keeping pre-hook selection",
				);
			}
		}
		const providersToGet: Provider[] = [];
		const deniedSensitiveProviderNames = new Set<string>();
		let ownerDisclosureDecision:
			| Awaited<ReturnType<typeof authorizeOwnerExclusiveDisclosure>>
			| undefined;
		let containsSensitiveProvider = false;
		for (const provider of this.runtime.providers) {
			if (!providerNames.has(provider.name)) {
				continue;
			}
			if (provider.disclosureGate?.require === "owner_exclusive") {
				ownerDisclosureDecision ??= await authorizeOwnerExclusiveDisclosure(
					this.runtime,
					message,
				);
				if (!ownerDisclosureDecision.allowed) {
					deniedSensitiveProviderNames.add(provider.name);
					this.runtime.logger.info(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							provider: provider.name,
							reason: ownerDisclosureDecision.reason,
						},
						"Owner-private provider denied for untrusted delivery audience",
					);
					continue;
				}
				containsSensitiveProvider = true;
			}
			providersToGet.push(provider);
		}
		providersToGet.sort(
			(a, b) =>
				(a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name),
		);

		// `refreshProviders` lets a caller reuse cached provider results and re-run
		// only the named providers, plus providers not yet cached for this
		// message. An empty array requests maximum reuse. `null` preserves the
		// explicit full-recompose behavior used by callers that need a fresh view.
		// Trajectory recording logs reused entries as cache hits instead of
		// changing execution behavior.
		const refreshSet =
			refreshProviders !== null ? new Set(refreshProviders) : null;
		const cachedProviderNames = refreshSet
			? new Set(
					Object.keys(
						(cachedState.data.providers as
							| Record<string, unknown>
							| undefined) ?? {},
					),
				)
			: null;
		const providersToRun = refreshSet
			? providersToGet.filter(
					(p) =>
						p.disclosureGate?.require === "owner_exclusive" ||
						refreshSet.has(p.name) ||
						!cachedProviderNames?.has(p.name),
				)
			: providersToGet;
		const providersToRunNames = new Set(providersToRun.map((p) => p.name));
		const reusedProviders = providersToGet.filter(
			(provider) => !providersToRunNames.has(provider.name),
		);

		// Optional trajectory logging service; absent unless configured.
		let trajLogger: (Service & TrajectoryProviderAccessLogger) | null;
		try {
			trajLogger = (await this.lifecycle.ensureServiceStarted(
				"trajectories",
			)) as (Service & TrajectoryProviderAccessLogger) | null;
		} catch (error) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — a trajectory
			// logger that fails to start must never abort composeState; continue
			// without provider-access logging. Surfaced via reportError.
			this.runtime.reportError(
				"AgentRuntime.composeState.trajectories",
				error,
				{
					serviceType: "trajectories",
				},
			);
			trajLogger = null;
		}
		const composeStartedAt = Date.now();
		// The host installs its merged request/room owner in streaming context.
		// Prefer that composite signal over the raw room controller so a client
		// disconnect remains observable while a room turn is active.
		const providerSignal =
			getStreamingContext()?.abortSignal ??
			this.runtime.turnControllers.signalFor(message.roomId) ??
			undefined;
		const providerData: ProviderExecutionRecord[] = await Promise.all(
			providersToRun.map(async (provider) => {
				const providerRuntime: IAgentRuntime = this.runtime;
				const inFlightKey =
					message.id && !refreshSet?.has(provider.name)
						? `${message.id}\u0000${message.roomId}\u0000${provider.name}\u0000${
								provider.disclosureGate?.require === "owner_exclusive"
									? trustedDeliveryAudienceCacheKey(message)
									: "public"
							}`
						: null;
				let execution =
					inFlightKey !== null
						? this.providerExecutionsInFlight.get(inFlightKey)
						: undefined;
				const providerCoalesced = execution !== undefined;
				if (!execution) {
					const startedAt = Date.now();
					const startedAtMonotonic = performance.now();
					const callerStreamingContext = getStreamingContext();
					// The work is deliberately NOT wired to this caller's signal:
					// coalesced waiters each race the shared promise against their own
					// signal in awaitProviderExecution, and the dedicated controller
					// aborts the provider only when no interested caller remains.
					const workController = new AbortController();
					const promise = runProviderExecution(
						() =>
							runWithStreamingContext(
								{
									// A caller without its own streaming context contributes
									// no chunk consumer, so the scope stays cancellation-only
									// and provider-internal useModel calls remain off the
									// streaming path.
									...callerStreamingContext,
									// Nested useModel calls read cancellation from this
									// scope. They belong to the shared execution, not to
									// whichever caller happened to create it.
									abortSignal: workController.signal,
								},
								() =>
									runWithSuppressedModelStream(() =>
										withProviderStep(providerRuntime, provider.name, () =>
											provider.get(providerRuntime, message, cachedState, {
												signal: workController.signal,
											}),
										),
									),
							),
						workController.signal,
					);
					execution = {
						promise,
						controller: workController,
						waiters: 0,
						startedAt,
						startedAtMonotonic,
					};
					this.providerExecutionsActive.add(execution);
					if (this.lifecycle.isStopping()) {
						workController.abort(new Error("Runtime stopped"));
					}
					if (inFlightKey !== null) {
						this.providerExecutionsInFlight.set(inFlightKey, execution);
					}
				}
				// Hoisted so BOTH the owner path (the `execution` just created
				// above) and the coalesced path (the `execution` fetched from the
				// map before this `if`) can evict the SAME map entry the moment it
				// stops being viable, rather than waiting for `promise` to unwind.
				// Identity-checked against the specific execution this call
				// attached to, so a later execution occupying the same key is
				// never evicted by a stale caller; idempotent so calling it
				// synchronously from awaitProviderExecution's abort path AND again
				// from `promise.then(evict, evict)` below is harmless.
				const attachedExecution = execution;
				const evict =
					inFlightKey !== null
						? () => {
								if (
									this.providerExecutionsInFlight.get(inFlightKey) ===
									attachedExecution
								) {
									this.providerExecutionsInFlight.delete(inFlightKey);
								}
							}
						: () => {};
				if (!providerCoalesced) {
					const releaseExecution = () => {
						this.providerExecutionsActive.delete(attachedExecution);
						evict();
					};
					void attachedExecution.promise.then(
						releaseExecution,
						releaseExecution,
					);
				}
				try {
					const result = await awaitProviderExecution(
						execution,
						providerSignal,
						evict,
					);
					const endedAt = Date.now();
					const duration = performance.now() - execution.startedAtMonotonic;
					recordInferenceSpan(`provider:${provider.name}`, duration, {
						outcome: "success",
						coalesced: providerCoalesced,
					});

					return {
						...result,
						providerName: provider.name,
						providerStartedAt: execution.startedAt,
						providerEndedAt: endedAt,
						providerDurationMs: duration,
						providerOutcome: "success",
						providerCoalesced,
					};
				} catch (cause) {
					const endedAt = Date.now();
					const duration = performance.now() - execution.startedAtMonotonic;
					const outcome: ProviderExecutionOutcome = providerCancellationReason(
						providerSignal,
						execution.controller.signal,
						cause,
					)
						? "aborted"
						: "error";
					const code =
						outcome === "aborted"
							? "PROVIDER_COMPOSITION_ABORTED"
							: "PROVIDER_COMPOSITION_FAILED";
					const error = new ElizaError(
						`Provider "${provider.name}" ${
							outcome === "aborted" ? "was aborted" : "failed"
						} during state composition`,
						{
							code,
							cause,
							severity: "ephemeral",
							context: {
								provider: provider.name,
								durationMs: duration,
								roomId: message.roomId,
								messageId: message.id,
								outcome,
							},
						},
					);
					recordInferenceSpan(`provider:${provider.name}`, duration, {
						outcome,
						errorCode: code,
						coalesced: providerCoalesced,
					});
					this.runtime.reportError("AgentRuntime.composeState.provider", error);
					return {
						providerName: provider.name,
						providerStartedAt: execution.startedAt,
						providerEndedAt: endedAt,
						providerDurationMs: duration,
						providerOutcome: outcome,
						providerCoalesced,
						providerError: error,
					};
				}
			}),
		);
		const providerOverlaps = calculateProviderOverlaps(providerData);
		const failedProviderData = providerData.filter(
			(record) => record.providerError !== undefined,
		);
		for (const provider of reusedProviders) {
			const cached = (
				cachedState.data.providers as
					| Record<string, CachedProviderResult>
					| undefined
			)?.[provider.name];
			recordInferenceSpan(`provider-cache:${provider.name}`, 0, {
				cacheHit: true,
				...(typeof cached?.providerDurationMs === "number"
					? { sourceDurationMs: cached.providerDurationMs }
					: {}),
			});
		}
		recordInferenceSpan("composeState", Date.now() - composeStartedAt, {
			providers: providersToRun.length,
			reused: providersToGet.length - providersToRun.length,
			failed: failedProviderData.length,
		});

		const currentProviderResults: Record<string, CachedProviderResult> = {
			...(cachedState.data.providers as
				| Record<string, CachedProviderResult>
				| undefined),
		};
		for (const provider of this.runtime.providers) {
			if (
				provider.disclosureGate?.require === "owner_exclusive" ||
				deniedSensitiveProviderNames.has(provider.name)
			) {
				delete currentProviderResults[provider.name];
			}
		}
		for (const freshResult of providerData) {
			if (freshResult.providerError) continue;
			// Redact secrets from individual provider text results
			const redactedText = freshResult.text
				? this.runtime.redactSecrets(freshResult.text)
				: freshResult.text;
			currentProviderResults[freshResult.providerName] = {
				...freshResult,
				text: redactedText,
				discoveryText: freshResult.discoveryText
					? this.runtime.redactSecrets(freshResult.discoveryText)
					: freshResult.discoveryText,
				values:
					freshResult.values && typeof freshResult.values === "object"
						? Object.fromEntries(
								Object.entries(freshResult.values).filter(
									([, value]) => value !== undefined,
								),
							)
						: undefined,
			};
		}
		const orderedTexts: string[] = [];
		for (const provider of providersToGet) {
			const result = currentProviderResults[provider.name];
			if (
				result?.text &&
				typeof result.text === "string" &&
				result.text.trim() !== ""
			) {
				orderedTexts.push(result.text);
			}
		}
		// Denial UX: when the disclosure gate suppressed owner-private providers
		// or actions this turn, the model sees an explicit notice instead of a
		// silently thinner toolset — otherwise it fabricates either the missing
		// data or a permanent inability. Suppressions are recorded by the gate
		// itself (security/trusted-delivery-audience.ts), so this covers both
		// the provider drop above and action-gate drops during selection.
		const suppressionNote = ownerExclusiveSuppressionNote(message);
		if (suppressionNote) {
			orderedTexts.push(suppressionNote);
		}
		// Redact any secrets from provider context before use
		const rawProvidersText = orderedTexts.join("\n");
		const providersText = this.runtime.redactSecrets(rawProvidersText);
		const providerOrderNames = providersToGet.map((provider) => provider.name);
		const attributionState = {
			values: {},
			data: {
				providerOrder: providerOrderNames,
				providers: currentProviderResults,
			},
			text: providersText,
		} as State;
		// Spans against `providersText` are composition-local only. Model-call
		// writers rebind from `providerAttributionState` against the exact
		// recorded messages/prompt; do not treat these offsets as model-prompt
		// indices.
		const providerAttribution = buildProviderAttributionsFromState({
			state: attributionState,
			prompt: providersText,
		});
		const providerAttributionByName = new Map(
			providerAttribution.providerAttributions.map((entry) => [
				entry.providerName,
				entry,
			]),
		);
		const activeTrajectoryContext = getTrajectoryContext();
		if (activeTrajectoryContext) {
			activeTrajectoryContext.providerOrder = providerAttribution.providerOrder;
			activeTrajectoryContext.providerAttributions =
				providerAttribution.providerAttributions;
			activeTrajectoryContext.providerAttributionState = attributionState;
		}
		const recordProviderAccesses = (includeText: boolean) => {
			if (trajectoryStepId && trajLogger) {
				const userText =
					typeof message.content.text === "string" ? message.content.text : "";
				const trajCtx = activeTrajectoryContext;
				const providerTraceId = this.runtime.getActiveTrace(
					this.runtime.getCurrentRunId(),
				)?.id;
				for (const [providerIndex, r] of providerData.entries()) {
					try {
						const overlapsWith = providerOverlaps[providerIndex];
						if (!overlapsWith) {
							throw new Error(
								`Missing provider overlap row at index ${providerIndex}`,
							);
						}
						const redactedText =
							currentProviderResults[r.providerName]?.text ?? "";
						const attribution = providerAttributionByName.get(r.providerName);
						trajLogger.logProviderAccess({
							stepId: trajectoryStepId,
							providerName: r.providerName,
							startedAt: r.providerStartedAt,
							endedAt: r.providerEndedAt,
							durationMs: r.providerDurationMs,
							overlapsWith,
							data: {
								// Retain only audience-authorized, secret-redacted text; never raw values/data.
								...(includeText && !r.providerError
									? { text: redactedText }
									: {}),
								textLength: redactedText.length,
								outcome: r.providerOutcome,
								coalesced: r.providerCoalesced,
								cacheHit: false,
								...(r.providerError ? { errorCode: r.providerError.code } : {}),
							},
							sha256: attribution?.sha256,
							tokenCount: attribution?.tokenCount,
							position: attribution?.position,
							// Spans index providersText, which is not persisted on the
							// access row — omit them so readers do not slice a different
							// string with compose-local offsets.
							purpose: "compose_state",
							query: { message: toWellFormedUnicode(userText) },
							runId: trajCtx?.runId,
							roomId: trajCtx?.roomId,
							messageId: trajCtx?.messageId,
							executionTraceId: providerTraceId,
						});
					} catch (error) {
						// error-policy:J7 trajectory diagnostics must not replace the
						// provider result or kill the message loop.
						this.runtime.reportError(
							"AgentRuntime.composeState.providerTrajectory",
							error,
							{
								provider: r.providerName,
								messageId: message.id,
							},
						);
					}
				}
				for (const provider of reusedProviders) {
					try {
						const cached = currentProviderResults[provider.name];
						const attribution = providerAttributionByName.get(provider.name);
						trajLogger.logProviderAccess({
							stepId: trajectoryStepId,
							providerName: provider.name,
							startedAt: composeStartedAt,
							endedAt: composeStartedAt,
							durationMs: 0,
							overlapsWith: [],
							data: {
								...(includeText && cached ? { text: cached.text ?? "" } : {}),
								textLength:
									typeof cached?.text === "string" ? cached.text.length : 0,
								outcome: cached?.providerOutcome ?? "success",
								coalesced: false,
								cacheHit: true,
								...(typeof cached?.providerDurationMs === "number"
									? { sourceDurationMs: cached.providerDurationMs }
									: {}),
							},
							sha256: attribution?.sha256,
							tokenCount: attribution?.tokenCount,
							position: attribution?.position,
							purpose: "compose_state",
							query: { message: toWellFormedUnicode(userText) },
							runId: trajCtx?.runId,
							roomId: trajCtx?.roomId,
							messageId: trajCtx?.messageId,
							executionTraceId: providerTraceId,
						});
					} catch (error) {
						// error-policy:J7 trajectory diagnostics must not replace the
						// cached provider result or kill the message loop.
						this.runtime.reportError(
							"AgentRuntime.composeState.cachedProviderTrajectory",
							error,
							{
								provider: provider.name,
								messageId: message.id,
							},
						);
					}
				}
			}
		};
		let includeProviderText = false;
		try {
			// A designed turn abort (threadOps abort op, user "stop", client
			// disconnect) owns the whole composition, including the post-provider
			// assembly window. Surface that owner cancellation even when every provider
			// already settled; provider-originated failures were reported above and are
			// not misclassified as aborts merely because their Error name resembles one.
			throwIfProviderCompositionAborted(
				providerSignal,
				this.lifecycle.isStopping(),
			);
			if (failedProviderData.length === 1) {
				const failedProvider = failedProviderData[0];
				if (failedProvider?.providerError) {
					throw failedProvider.providerError;
				}
			}
			if (failedProviderData.length > 1) {
				// error-policy:J2 preserve every provider failure behind one
				// state-composition error so callers receive the complete cause chain.
				throw new ElizaError(
					`State composition failed in ${failedProviderData.length} providers`,
					{
						code: "STATE_COMPOSITION_PROVIDER_FAILURES",
						cause: new AggregateError(
							failedProviderData.flatMap((record) =>
								record.providerError ? [record.providerError] : [],
							),
						),
						severity: "ephemeral",
						context: {
							providers: failedProviderData.map(
								(record) => record.providerName,
							),
							messageId: message.id,
							roomId: message.roomId,
						},
					},
				);
			}
			if (containsSensitiveProvider) {
				const disclosure = await revalidateOwnerExclusiveDisclosure(
					this.runtime,
					message,
				);
				if (!disclosure.allowed) {
					throw new ElizaError(PRIVACY_DENIED_TEXT, {
						code: "OWNER_PRIVATE_AUDIENCE_CHANGED",
						severity: "ephemeral",
						context: {
							messageId: message.id,
							roomId: message.roomId,
							reason: disclosure.reason,
						},
					});
				}
			}
			throwIfProviderCompositionAborted(
				providerSignal,
				this.lifecycle.isStopping(),
			);
			includeProviderText = true;
		} finally {
			// Preserve failure diagnostics, but retain text only after final audience and cancellation checks.
			recordProviderAccesses(includeProviderText);
		}
		const conversationSeed = buildDeterministicSeed(
			this.runtime.agentId,
			message.roomId,
			"conversation",
		);
		const aggregatedStateValues: Record<string, StateValue> = {
			...cachedState.values,
		};
		for (const provider of providersToGet) {
			const providerResult = currentProviderResults[provider.name];
			if (
				providerResult?.values &&
				typeof providerResult.values === "object" &&
				providerResult.values !== null
			) {
				Object.assign(aggregatedStateValues, providerResult.values);
			}
		}
		const providersToGetNames = new Set(providersToGet.map((p) => p.name));
		for (const providerName in currentProviderResults) {
			if (!providersToGetNames.has(providerName)) {
				const providerResult = currentProviderResults[providerName];
				if (
					providerResult?.values &&
					typeof providerResult.values === "object" &&
					providerResult.values !== null
				) {
					Object.assign(aggregatedStateValues, providerResult.values);
				}
			}
		}
		const newState = {
			values: {
				...aggregatedStateValues,
				__conversationSeed: conversationSeed,
				providers: providersText,
			},
			data: {
				...cachedState.data,
				__roomId: message.roomId,
				__conversationSeed: conversationSeed,
				__trustedDeliveryAudienceCacheKey: audienceCacheKey,
				providerOrder: providerOrderNames,
				providers: currentProviderResults,
			},
			text: providersText,
		} as State;
		// Provider values can be lazily materialized while assembling the state;
		// recheck at the mutation boundary so a cancellation in that window cannot
		// populate either the normal cache or the audience-scoped public cache.
		throwIfProviderCompositionAborted(
			providerSignal,
			this.lifecycle.isStopping(),
		);
		if (message.id && !containsSensitiveProvider) {
			this.publicProviderStateByMessage.delete(message);
			this.runtime.stateCache.set(message.id, newState);
			// Evict oldest entries beyond the cap. The just-set entry and recent
			// in-flight turns are kept; only stale messages drop out.
			while (this.runtime.stateCache.size > STATE_CACHE_LIMIT) {
				const oldest = this.runtime.stateCache.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				this.runtime.stateCache.delete(oldest);
			}
		} else if (message.id) {
			const publicProviders = providersToGet.filter(
				(provider) => provider.disclosureGate?.require !== "owner_exclusive",
			);
			const publicProviderResults = Object.fromEntries(
				publicProviders.flatMap((provider) => {
					const result = currentProviderResults[provider.name];
					return result ? [[provider.name, result]] : [];
				}),
			) as Record<string, CachedProviderResult>;
			const publicValues: Record<string, StateValue> = {
				__conversationSeed: conversationSeed,
			};
			const publicTexts: string[] = [];
			for (const provider of publicProviders) {
				const result = publicProviderResults[provider.name];
				if (result?.values && typeof result.values === "object") {
					Object.assign(publicValues, result.values);
				}
				if (typeof result?.text === "string" && result.text.trim() !== "") {
					publicTexts.push(result.text);
				}
			}
			const publicText = this.runtime.redactSecrets(publicTexts.join("\n"));
			// Public projection assembly reads provider-owned values after the full
			// state guard above. A getter can synchronously cancel the owner in that
			// window, so guard the actual WeakMap mutation as well.
			throwIfProviderCompositionAborted(
				providerSignal,
				this.lifecycle.isStopping(),
			);
			this.publicProviderStateByMessage.set(message, {
				text: message.content.text,
				state: {
					values: { ...publicValues, providers: publicText },
					data: {
						__roomId: message.roomId,
						__conversationSeed: conversationSeed,
						__trustedDeliveryAudienceCacheKey: audienceCacheKey,
						providerOrder: publicProviders.map((provider) => provider.name),
						providers: publicProviderResults,
					},
					text: publicText,
				},
			});
		}
		return newState;
	}
}
