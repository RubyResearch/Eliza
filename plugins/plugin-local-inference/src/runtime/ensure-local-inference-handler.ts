/// <reference path="./capacitor-llama.d.ts" />

/**
 * Registers the standalone llama.cpp engine as the runtime handler for
 * `ModelType.TEXT_SMALL` and `ModelType.TEXT_LARGE`.
 *
 * Priority is 0 — same band as cloud and direct provider plugins. Tie-breaks
 * between local and cloud are owned by the routing-policy layer
 * (`router-handler.ts` + `routing-policy.ts`), not by this priority value:
 * the router sits at MAX_SAFE_INTEGER and consults the user's policy
 * (manual / cheapest / fastest / prefer-local / round-robin) on every call.
 *
 * Priority must not be negative: the runtime's getModel() returns undefined
 * when no priority-0 handler is registered, which on AOSP builds — where the
 * AOSP local inference loader is the only provider — surfaces as "No handler
 * found for delegate type: TEXT_SMALL". A negative priority would conflate
 * routing-policy (a user preference) with handler priority (a registration
 * ordinal). Both cloud-only and local-only deployments register a priority-0
 * handler; the router decides which one fires per request.
 *
 * Parallels `ensure-text-to-speech-handler.ts` — same shape, same guards.
 */

import {
	type AgentRuntime,
	applyBackgroundInferenceBudget,
	canonicalPromptForModelCall,
	fetchRemoteMedia,
	type GenerateTextParams,
	getInferencePriorityGate,
	getInferenceTimer,
	type IAgentRuntime,
	type ImageDescriptionParams,
	type ImageDescriptionResult,
	inferenceRamClassFromEnv,
	logger,
	type MobileDeviceBridgeService,
	ModelType,
	renderMessageHandlerStablePrefix,
	resolveBackgroundInferenceBudget,
	ServiceType,
	type TextEmbeddingParams,
	type TextToSpeechParams,
	type TranscriptionParams,
	timeInferenceSpan,
	type UUID,
} from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";
import { LocalInferenceUnavailableError } from "../provider";
import {
	type LocalInferenceLoader,
	resolveLocalInferenceLoadArgs,
} from "../services/active-model";
import {
	autoAssignAtBoot,
	isEmbeddingModelId,
	readEffectiveAssignments,
} from "../services/assignments";
import { BionicHostLoader } from "../services/bionic-host-loader";
import {
	extractConversationId,
	extractPromptCacheKey,
	resolveLocalCacheKey,
} from "../services/cache-bridge";
import { mergeElizaTurnStopSequences } from "../services/eliza-turn-stops";
import { localInferenceEngine } from "../services/engine";
import { handlerRegistry } from "../services/handler-registry";
import { probeHardware } from "../services/hardware";
import { tryGetMemoryArbiter } from "../services/memory-arbiter";
import { listInstalledModels } from "../services/registry";
import { installRouterHandler } from "../services/router-handler";
import {
	LOCAL_INFERENCE_LOADER_SERVICE_TYPE,
	registerLocalInferenceLoaderService,
	registerTimedAsrService,
	TIMED_ASR_SERVICE_TYPE,
} from "../services/runtime-services";
import {
	type ElizaHarnessSchema,
	elizaHarnessSchemaFromSkeleton,
} from "../services/structured-output";
import type { AgentModelSlot } from "../services/types";
import {
	prepareVisionImageInput,
	VISION_IMAGE_FETCH_TIMEOUT_MS,
	VISION_IMAGE_MAX_BYTES,
} from "../services/vision/image-input";
import type { VisionImageInput } from "../services/vision/types";
import { decodeMonoPcm16Wav, type TranscriptionAudio } from "../services/voice";
import {
	ELIZA_POOLING_CLS,
	ELIZA_POOLING_LAST,
	ELIZA_POOLING_MEAN,
} from "../services/voice/ffi-bindings";
import { extractRequestedKokoroVoiceId } from "../services/voice/requested-voice.js";
import { DEFAULT_MODELS_DIR } from "./embedding-manager-support";
import {
	EMBEDDING_PRESETS,
	selectEmbeddingPresetFromHardware,
} from "./embedding-presets";
import { isLocalEmbeddingDisabledByEnv } from "./embedding-warmup-policy";
import { resolveFusedEmbeddingBundleRoot } from "./fused-embedding-bundle";

type GenerateTextHandler = (
	runtime: IAgentRuntime,
	params: GenerateTextParams,
) => Promise<string>;

/**
 * Embedding handler signature — accepts the same union the runtime hands
 * to TEXT_EMBEDDING calls (`TextEmbeddingParams | string | null`) and
 * returns the raw float vector.
 */
type EmbeddingHandler = (
	runtime: IAgentRuntime,
	params: TextEmbeddingParams | string | null,
) => Promise<number[]>;

type TextToSpeechHandler = (
	runtime: IAgentRuntime,
	params: TextToSpeechParams | string,
) => Promise<Uint8Array>;

type TranscriptionHandler = (
	runtime: IAgentRuntime,
	params: TranscriptionParams | Buffer | string | LocalTranscriptionParams,
) => Promise<string>;

type ImageDescriptionHandler = (
	runtime: IAgentRuntime,
	params: ImageDescriptionParams | string,
) => Promise<ImageDescriptionResult>;

interface LocalTranscriptionParams {
	pcm?: Float32Array;
	audio?: Uint8Array | ArrayBuffer | Buffer;
	sampleRateHz?: number;
	sampleRate?: number;
	signal?: AbortSignal;
}

type LocalModelHandler =
	| GenerateTextHandler
	| EmbeddingHandler
	| TextToSpeechHandler
	| TranscriptionHandler
	| ImageDescriptionHandler;

type RuntimeWithModelRegistration = AgentRuntime & {
	getModel: (modelType: string | number) => LocalModelHandler | undefined;
	registerModel: (
		modelType: string | number,
		handler: LocalModelHandler,
		provider: string,
		priority?: number,
		metadata?: { local?: boolean; streamable?: boolean },
	) => void;
};

const LOCAL_INFERENCE_PROVIDER = "eliza-local-inference";
const DEVICE_BRIDGE_PROVIDER = "eliza-device-bridge";
const CAPACITOR_LLAMA_PROVIDER = "capacitor-llama";
const AOSP_LLAMA_PROVIDER = "eliza-aosp-llama";
const LOCAL_INFERENCE_HANDLER_INSTALLED = Symbol.for(
	"elizaos.local-inference.handlers-installed",
);
const DEDICATED_EMBEDDING_HANDLER_INSTALLED = Symbol.for(
	"elizaos.local-inference.dedicated-embedding-installed",
);
type RuntimeWithLocalInferenceFlag = RuntimeWithModelRegistration & {
	[LOCAL_INFERENCE_HANDLER_INSTALLED]?: boolean;
	[DEDICATED_EMBEDDING_HANDLER_INSTALLED]?: boolean;
};
/**
 * Same band as cloud / direct provider plugins. Tie-breaks between
 * candidates live in `routing-policy.ts`, not in this number — the
 * router (registered at MAX_SAFE_INTEGER) consults the user's
 * per-slot policy on every dispatch.
 *
 * Was -1 historically, which made `runtime.getModel(TEXT_SMALL)` return
 * undefined when the AOSP local-inference loader was the only registered
 * provider. The smoke run failed with "No handler found for delegate
 * type: TEXT_SMALL"; bumping to 0 unblocks AOSP without changing
 * cloud-only deployments (cloud providers still register at 0 and the
 * routing-policy layer picks between them).
 */
const LOCAL_INFERENCE_PRIORITY = 0;

export function shouldRegisterLocalInferenceHandlers(mode: string): boolean {
	return mode === "local" || mode === "local-only";
}

function normalizeRuntimeMode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "local-safe" || normalized === "local-yolo")
		return "local";
	if (
		normalized === "local" ||
		normalized === "local-only" ||
		normalized === "cloud" ||
		normalized === "remote"
	) {
		return normalized;
	}
	return null;
}

function getRuntimeMode(runtime: IAgentRuntime): string {
	for (const key of [
		"ELIZA_DEPLOYMENT_RUNTIME",
		"ELIZA_RUNTIME_MODE",
		"RUNTIME_MODE",
	] as const) {
		const fromSetting = normalizeRuntimeMode(runtime.getSetting(key));
		if (fromSetting) return fromSetting;
		const fromEnv = normalizeRuntimeMode(process.env[key]);
		if (fromEnv) return fromEnv;
	}
	if (
		readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1" ||
		process.env.ELIZAOS_CLOUD_ENABLED === "1"
	) {
		return "cloud";
	}
	return "local";
}

function getLoader(runtime: IAgentRuntime): LocalInferenceLoader | null {
	const candidate = (
		runtime as { getService?: (name: string) => unknown }
	).getService?.("localInferenceLoader");
	if (!candidate || typeof candidate !== "object") return null;
	const loader = candidate as Partial<LocalInferenceLoader>;
	if (
		typeof loader.loadModel === "function" &&
		typeof loader.unloadModel === "function"
	) {
		return candidate as LocalInferenceLoader;
	}
	return null;
}

/**
 * Look up the model assigned to a given agent slot and ensure it's the
 * one loaded before generation runs. Loads lazily on first call; swaps
 * when a different slot's assignment fires with a different model.
 *
 * If no assignment is set for the slot, falls back to whatever is
 * currently loaded — UNLESS the loaded model is an embedding model and
 * this is a chat/generative slot. That combination produces `[unused{N}]`
 * garbage (a BERT model forced to autoregress), so we fail loudly with an
 * actionable message instead. See elizaOS/eliza#7687.
 */
async function ensureAssignedModelLoaded(
	loader: LocalInferenceLoader | null,
	slot: AgentModelSlot,
): Promise<void> {
	const assignments = await readEffectiveAssignments();
	const assignedId = assignments[slot];
	if (!assignedId) {
		// Loud-failure guard: an unassigned chat slot must not silently
		// dispatch to whatever model happens to be loaded — if that's an
		// embedding model, completion emits reserved-token garbage.
		if (slot === "TEXT_SMALL" || slot === "TEXT_LARGE") {
			const installed = await listInstalledModels();
			const currentPath =
				loader?.currentModelPath() ?? localInferenceEngine.currentModelPath();
			const current = currentPath
				? installed.find((m) => m.path === currentPath)
				: undefined;
			if (current && isEmbeddingModelId(current.id)) {
				throw new Error(
					`[local-inference] No chat model assigned for slot ${slot} — open Settings → Local models. The currently-loaded model (${current.id}) is an embedding model and cannot serve text generation.`,
				);
			}
		}
		return;
	}

	// Desktop fast path: check the engine state directly.
	if (!loader && localInferenceEngine.currentModelPath()) {
		const installed = await listInstalledModels();
		const current = installed.find(
			(m) => m.path === localInferenceEngine.currentModelPath(),
		);
		if (current?.id === assignedId) return;
	}

	// Via loader: compare reported path against assignment.
	if (loader) {
		const currentPath = loader.currentModelPath();
		if (currentPath) {
			const installed = await listInstalledModels();
			const current = installed.find((m) => m.path === currentPath);
			if (current?.id === assignedId) return;
		}
	}

	const installed = await listInstalledModels();
	const target = installed.find((m) => m.id === assignedId);
	if (!target) {
		throw new Error(
			`[local-inference] Slot ${slot} assigned to ${assignedId}, but that model is not installed.`,
		);
	}

	if (loader) {
		const hardware = await probeHardware();
		const resolved = await resolveLocalInferenceLoadArgs(target, undefined, {
			hardware,
		});
		await loader.unloadModel();
		await loader.loadModel(resolved);
	} else {
		const hardware = await probeHardware();
		const resolved = await resolveLocalInferenceLoadArgs(target, undefined, {
			hardware,
		});
		await localInferenceEngine.load(target.path, resolved);
	}
}

/**
 * True when the caller opted this generation into *guided structured decode* —
 * the deterministic-token prefill-plan short-circuit on top of the GBNF
 * constrained decode. Off by default: needs either an explicit
 * `providerOptions.eliza.guidedDecode === true` (the planner / message service
 * sets this when it built a forced skeleton) or the process-wide
 * `ELIZA_LOCAL_GUIDED_DECODE=1` opt-in.
 */
function guidedDecodeRequested(params: GenerateTextParams): boolean {
	const providerOptions = (params as { providerOptions?: unknown })
		.providerOptions;
	const elizaOpts =
		providerOptions && typeof providerOptions === "object"
			? (providerOptions as { eliza?: { guidedDecode?: unknown } }).eliza
			: undefined;
	if (elizaOpts && elizaOpts.guidedDecode === true) return true;
	const env = process.env.ELIZA_LOCAL_GUIDED_DECODE;
	return env === "1" || env === "true";
}

/**
 * Build the {@link ElizaHarnessSchema} for this call — the bundle of the
 * forced skeleton, the pre-built grammar (when the producer supplied one), and
 * the derived deterministic-token prefill plan. Returns undefined unless guided
 * decode is requested AND a `responseSkeleton` (or explicit `grammar`) is
 * present (schema presence == the off-by-default switch for the prefill plan).
 */
function elizaHarnessSchemaFromParams(
	params: GenerateTextParams,
): ElizaHarnessSchema | undefined {
	if (!guidedDecodeRequested(params)) return undefined;
	const skeleton = params.responseSkeleton;
	if (!skeleton) return undefined;
	return elizaHarnessSchemaFromSkeleton({
		skeleton,
		grammar: typeof params.grammar === "string" ? params.grammar : undefined,
	});
}

function extractThinkingControl(
	providerOptions: unknown,
): "auto" | "on" | "off" | undefined {
	const elizaOpts =
		providerOptions && typeof providerOptions === "object"
			? (providerOptions as { eliza?: { thinking?: unknown } }).eliza
			: undefined;
	const thinking = elizaOpts?.thinking;
	return thinking === "auto" || thinking === "on" || thinking === "off"
		? thinking
		: undefined;
}

/**
 * Project a `GenerateTextParams` onto the engine's `GenerateArgs`, threading
 * the structure-forcing extensions (`prefill`, `responseSkeleton`, `grammar`,
 * `streamStructured`, `elizaSchema`) and wiring `onStreamChunk` to the engine's
 * per-token `onTextChunk`. Cloud adapters ignore these fields; the local engine
 * honours them (the forced-span / prefill / grammar / prefill-plan path is
 * local-model-only).
 */
/**
 * Per-step token cap for USER-VISIBLE local streaming (chat replies).
 *
 * Benchmarked on the fused eliza-1 model (#9174): the per-`llmStreamNext` step
 * carries a large fixed FFI overhead, so the throughput↔smoothness curve has a
 * knee around 8 — `8` yields ~10 UI updates per 80 tokens (clearly streaming)
 * at a modest decode-throughput cost, whereas 1–4 fall off a throughput cliff
 * and 16–32 look jumpy. Internal / planner / voice calls do NOT set this and
 * keep the coarse, throughput-tuned runner default (32). Overridable via the
 * shared `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` env knob; the runner clamps it.
 */
const DEFAULT_CHAT_STREAM_TOKENS_PER_STEP = 8;

function resolveChatStreamTokensPerStep(): number {
	const raw = process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP?.trim();
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_CHAT_STREAM_TOKENS_PER_STEP;
}

function engineGenerateArgsFromParams(
	params: GenerateTextParams,
	cacheKey: string | undefined,
): {
	prompt: string;
	stopSequences?: string[];
	cacheKey?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	prefill?: string;
	responseSkeleton?: GenerateTextParams["responseSkeleton"];
	grammar?: string;
	streamStructured?: boolean;
	elizaSchema?: ElizaHarnessSchema;
	spanSamplerPlan?: GenerateTextParams["spanSamplerPlan"];
	thinking?: "auto" | "on" | "off";
	onTextChunk?: (chunk: string) => void | Promise<void>;
	maxTokensPerStep?: number;
	voiceOutput?: "user-visible" | "internal";
} {
	const promptFromMessages =
		params.messages && params.messages.length > 0
			? canonicalPromptForModelCall({ messages: params.messages })
			: "";
	const promptFromSegments =
		params.promptSegments && params.promptSegments.length > 0
			? params.promptSegments.map((segment) => segment.content).join("")
			: "";
	const streamStructured = params.streamStructured === true;
	// Surface per-token chunks to the caller only when it requested streaming.
	// Rendering and diagnostics also consume this callback, so voice ownership
	// remains an independent, explicit `voiceOutput` contract.
	const onTextChunk =
		(params.stream === true || streamStructured) &&
		typeof params.onStreamChunk === "function"
			? (chunk: string) => params.onStreamChunk?.(chunk)
			: undefined;
	return {
		prompt: params.prompt ?? (promptFromMessages || promptFromSegments),
		stopSequences: mergeElizaTurnStopSequences(params.stopSequences),
		cacheKey,
		signal: params.signal,
		maxTokens: params.maxTokens,
		temperature: params.temperature,
		topP: params.topP,
		prefill: params.prefill,
		responseSkeleton: params.responseSkeleton,
		grammar: params.grammar,
		streamStructured: streamStructured || undefined,
		elizaSchema: elizaHarnessSchemaFromParams(params),
		spanSamplerPlan: params.spanSamplerPlan,
		thinking: extractThinkingControl(params.providerOptions),
		onTextChunk,
		// Stream user-visible replies in fine-grained steps so the dashboard
		// renders token-by-token instead of in ~32-token jumps. Only when
		// streaming (onTextChunk set) — internal/planner calls keep the coarse,
		// throughput-tuned default. See resolveChatStreamTokensPerStep (#9174).
		maxTokensPerStep: onTextChunk
			? resolveChatStreamTokensPerStep()
			: undefined,
		voiceOutput: params.voiceOutput,
	};
}

function makeHandler(slot: AgentModelSlot): GenerateTextHandler {
	return async (runtime, params) => {
		const loader = getLoader(runtime);

		// Lazy-load the assigned model for this slot, if any. Swaps are
		// expensive; the user is expected to assign a small number of models.
		await ensureAssignedModelLoaded(loader, slot);

		// Resolve the strongest cache key the runtime can give us. Order of
		// precedence (see `resolveLocalCacheKey`):
		//   1. Conversation id   — survives any prompt drift
		//   2. Stable-prefix hash — survives unstable-tail timestamps
		//   3. Provider plan hashes — back-compat
		const providerOptions = (params as { providerOptions?: unknown })
			.providerOptions;
		const conversationId = extractConversationId(providerOptions);
		const cacheKey =
			resolveLocalCacheKey(providerOptions) ??
			extractPromptCacheKey(providerOptions) ??
			undefined;
		const engineArgs = engineGenerateArgsFromParams(params, cacheKey);

		// Prefer a runtime-registered loader that implements `generate` — that's
		// the mobile / device-bridge path (bionic host / AOSP adapter / device
		// bridge). Those backends decode ONE request at a time on a shared
		// resident model, so route through the process-wide interactive-over-
		// background lane (#11914): interactive turns dispatch ahead of queued
		// background jobs; background jobs wait a bounded time without changing
		// the generation request. Desktop falls through to the standalone
		// engine, which owns its own session pool and is NOT gated.
		if (loader?.generate) {
			const generate = loader.generate.bind(loader);
			const priority = params.priority ?? "interactive";
			let lockWaitMs: number | undefined;
			if (priority === "background") {
				const budget = resolveBackgroundInferenceBudget(
					inferenceRamClassFromEnv() ?? "standard",
				);
				const budgetedArgs = applyBackgroundInferenceBudget(
					{ prompt: engineArgs.prompt, maxTokens: engineArgs.maxTokens },
					budget,
				);
				engineArgs.prompt = budgetedArgs.prompt;
				engineArgs.maxTokens = budgetedArgs.maxTokens;
				lockWaitMs = budget.lockWaitMs;
			}
			return getInferencePriorityGate().runExclusive(
				{
					priority,
					label: `${slot} local-loader (${engineArgs.prompt.length} chars)`,
					...(lockWaitMs !== undefined ? { waitMs: lockWaitMs } : {}),
					...(params.signal ? { signal: params.signal } : {}),
				},
				() => generate(engineArgs),
			);
		}
		if (!(await localInferenceEngine.available())) {
			// No native binding: signal UNAVAILABLE (typed) so the cross-provider
			// router skips local inference and falls back to a registered cloud/API
			// provider, instead of hard-failing the whole turn.
			throw new LocalInferenceUnavailableError(
				slot,
				"backend_unavailable",
				`[local-inference] No llama.cpp binding available for ${slot} request`,
			);
		}
		if (!localInferenceEngine.hasLoadedModel()) {
			// No local model loaded: signal UNAVAILABLE (typed) so the router falls
			// back to a registered cloud/API provider (e.g. Anthropic) when one
			// exists, rather than hard-failing while a usable provider is present.
			throw new LocalInferenceUnavailableError(
				slot,
				"backend_unavailable",
				`[local-inference] No local model is active. Assign a model to ${slot} or activate one in Settings → Local models.`,
			);
		}

		// Long-lived conversation? Open / reuse a registry handle so this
		// turn lands on the same slot every time, regardless of prompt
		// hash drift. The handle API additionally returns Anthropic-shape
		// usage telemetry, which we surface at INFO once per generation.
		if (conversationId) {
			const modelId =
				localInferenceEngine.currentModelPath() ?? "default-local-model";
			const handle =
				localInferenceEngine.conversation(conversationId, modelId) ??
				localInferenceEngine.openConversation({
					conversationId,
					modelId,
				});
			const { cacheKey: _drop, ...convArgs } = engineArgs;
			const result = await localInferenceEngine.generateInConversation(
				handle,
				convArgs,
			);
			// Per-generation usage log. Match the Anthropic plugin's
			// observability surface so cloud and local share the same
			// mental model. Cache hit rate is reported when input_tokens > 0.
			const u = result.usage;
			const hitRate =
				u.cache_hit_rate !== undefined
					? `${Math.round(u.cache_hit_rate * 100)}%`
					: "n/a";
			const mtpRate =
				typeof u.mtp_acceptance_rate === "number"
					? ` mtp=${Math.round(u.mtp_acceptance_rate * 100)}%`
					: "";
			logger.info(
				`[local-inference] usage conv=${conversationId} slot=${result.slotId} in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens} cache_create=${u.cache_creation_input_tokens} hit=${hitRate}${mtpRate}`,
			);
			// Auto-tune signal — emits a one-line warn if the high-water mark
			// outgrew the configured slot count this turn. Cheap to call,
			// and the warning is what the operator needs to see.
			localInferenceEngine.warnIfParallelTooLow({ warn: logger.warn });
			return result.text;
		}

		// No conversation context: fall through to the existing hash-based
		// slot allocation. Doesn't break any caller that wasn't aware of
		// conversation handles.
		return localInferenceEngine.generate(engineArgs);
	};
}

/**
 * Normalize the runtime's TEXT_EMBEDDING input shape — `params` may be the
 * structured `TextEmbeddingParams` (when called from a typed plugin), a
 * raw string (when called from action runners), or `null` (an internal
 * warmup probe used to size the shipped embedding vector).
 */
function extractEmbeddingText(
	params: TextEmbeddingParams | string | null,
): string {
	if (params === null) return "";
	if (typeof params === "string") return params;
	return params.text;
}

/**
 * Build the TEXT_EMBEDDING handler. Mirrors `makeHandler` for generate:
 * routes through the loader's `embed` if available, otherwise throws so
 * the runtime falls back to a non-local provider rather than serving a
 * silent zero-vector (Commandment 8: don't hide broken pipelines).
 */
function makeEmbeddingHandler(): EmbeddingHandler {
	return async (runtime, params) => {
		const loader = getLoader(runtime);
		if (!loader?.embed) {
			throw new Error(
				"[local-inference] Active loader does not implement embed; falling through to next provider",
			);
		}
		// Embeddings in this runtime are not slot-aware — there's a single
		// active model. Make sure the user's TEXT_EMBEDDING assignment, if
		// any, is loaded before we hit the loader.
		await ensureAssignedModelLoaded(loader, "TEXT_EMBEDDING");
		const text = extractEmbeddingText(params);
		const result = await loader.embed({ input: text });
		return result.embedding;
	};
}

interface DesktopEmbeddingConfig {
	modelsDir: string;
	model: string;
	contextSize: number;
	gpuLayers: number;
}

/**
 * Resolve the desktop embedding model + load params from the same
 * `LOCAL_EMBEDDING_*` env that `configureLocalEmbeddingPlugin` and the boot
 * warmup set, falling back to the compact gte-small preset.
 */
function resolveDesktopEmbeddingConfig(
	hardware?: Awaited<ReturnType<typeof probeHardware>>,
): DesktopEmbeddingConfig {
	const preset = hardware
		? selectEmbeddingPresetFromHardware(hardware)
		: EMBEDDING_PRESETS.performance;
	const modelsDir = process.env.MODELS_DIR?.trim() || DEFAULT_MODELS_DIR;
	const model = process.env.LOCAL_EMBEDDING_MODEL?.trim() || preset.model;
	const ctxEnv = Number(process.env.LOCAL_EMBEDDING_CONTEXT_SIZE);
	const contextSize =
		Number.isFinite(ctxEnv) && ctxEnv > 0 ? ctxEnv : preset.contextSize;
	const gpuLayersEnv = process.env.LOCAL_EMBEDDING_GPU_LAYERS?.trim();
	const gpuLayersNum = Number(gpuLayersEnv);
	// "999 = all layers on GPU" per llama.cpp; the desktop adapter clamps to
	// the model's metadata layer count, so "auto"/"max" map to 999.
	const gpuLayers =
		gpuLayersEnv === "auto" || gpuLayersEnv === "max"
			? 999
			: Number.isFinite(gpuLayersNum)
				? gpuLayersNum
				: preset.gpuLayers === "auto"
					? 999
					: 0;
	return { modelsDir, model, contextSize, gpuLayers };
}

/**
 * Lazily-resolved fused embedding handle. When the fused `libelizainference`
 * (ABI v9) is present, reports `embedSupported()`, and a `<root>/text/` bundle
 * root resolves for the embedding model, the desktop TEXT_EMBEDDING handler
 * computes embeddings through `eliza_inference_embed` over the fused handle's
 * resident text vocab — retiring the node-llama-cpp / libllama embedding path.
 * `null` once resolution fails (the handler then falls back).
 */
type FusedEmbeddingHandle = {
	ffi: import("../services/voice/ffi-bindings").ElizaInferenceFfi;
	ctx: import("../services/voice/ffi-bindings").ElizaInferenceContextHandle;
	embed: NonNullable<
		import("../services/voice/ffi-bindings").ElizaInferenceFfi["embed"]
	>;
};

let fusedEmbedHandlePromise: Promise<FusedEmbeddingHandle | null> | null = null;
let liveFusedEmbeddingHandle: FusedEmbeddingHandle | null = null;
let fusedEmbeddingExitCleanupInstalled = false;

function installFusedEmbeddingExitCleanup(): void {
	if (fusedEmbeddingExitCleanupInstalled) return;
	fusedEmbeddingExitCleanupInstalled = true;
	process.once("exit", () => {
		const handle = liveFusedEmbeddingHandle;
		liveFusedEmbeddingHandle = null;
		if (!handle) return;
		try {
			handle.ffi.destroy(handle.ctx);
		} catch (error) {
			// error-policy:J6 process-exit teardown is best-effort; the process is
			// already terminating, but the dylib close must still be attempted.
			logger.debug(
				`[local-inference] fused embedding context teardown failed during exit: ${String(error)}`,
			);
		}
		try {
			handle.ffi.close();
		} catch (error) {
			// error-policy:J6 process-exit teardown cannot be retried safely.
			logger.debug(
				`[local-inference] fused embedding library close failed during exit: ${String(error)}`,
			);
		}
	});
}

// A null resolution is retried on the next embed rather than cached for the
// process lifetime — the boot dimension-probe can call getFusedEmbeddingHandle
// before the gte-small GGUF / fused lib finishes staging, and caching that miss
// would pin embeddings to the cloud fallback forever. But bound the retry to this
// window after the first failure so a host that genuinely cannot serve on-device
// embeddings (no fused lib) stops re-probing every embed and quietly stays on the
// configured fallback instead of logging + re-loading the FFI on every call.
const FUSED_EMBED_RETRY_WINDOW_MS = 3 * 60_000;
let fusedEmbedFirstFailureMs: number | null = null;

async function getFusedEmbeddingHandle(cfg: DesktopEmbeddingConfig): Promise<{
	embed: (text: string) => Float32Array;
} | null> {
	if (fusedEmbedHandlePromise === null) {
		fusedEmbedHandlePromise = (async () => {
			try {
				require.resolve("bun:ffi");
			} catch (e) {
				logger.warn(
					`[local-inference] fused embed unavailable: bun:ffi not resolvable (${String(e)})`,
				);
				return null;
			}
			const { resolveFusedLibraryPath } = await import(
				"../services/desktop-fused-ffi-backend-runtime"
			);
			let bundleRoot: string | null;
			try {
				bundleRoot = resolveFusedEmbeddingBundleRoot({
					...cfg,
					override: process.env.ELIZA_EMBED_BUNDLE_ROOT?.trim(),
				});
			} catch (error) {
				// error-policy:J4 a failed local artifact stage is an explicit
				// unavailable provider state; the runtime can select another provider.
				logger.warn(
					`[local-inference] could not stage the fused embed bundle for "${cfg.model}": ${String(error)}`,
				);
				return null;
			}
			if (!bundleRoot) {
				logger.warn(
					`[local-inference] fused embed unavailable: no bundle root for "${cfg.model}" under "${cfg.modelsDir}"`,
				);
				return null;
			}
			const libPath = resolveFusedLibraryPath(bundleRoot);
			if (!libPath) {
				logger.warn(
					`[local-inference] fused embed unavailable: fused lib not found for bundle "${bundleRoot}"`,
				);
				return null;
			}
			const { loadElizaInferenceFfi } = await import(
				"../services/voice/ffi-bindings"
			);
			const ffi = loadElizaInferenceFfi(libPath);
			if (
				typeof ffi.embedSupported !== "function" ||
				ffi.embedSupported() !== true ||
				typeof ffi.embed !== "function"
			) {
				logger.warn(
					`[local-inference] fused embed unavailable: lib "${libPath}" reports no embed support`,
				);
				ffi.close();
				return null;
			}
			const ctx = ffi.create(bundleRoot);
			const handle = { ffi, ctx, embed: ffi.embed };
			liveFusedEmbeddingHandle = handle;
			installFusedEmbeddingExitCleanup();
			logger.info(
				`[local-inference] Desktop embeddings via fused libelizainference (eliza_inference_embed) anchored at ${bundleRoot} — node-llama-cpp embedding path retired`,
			);
			return handle;
		})().catch((e) => {
			logger.warn(
				`[local-inference] fused embed init threw: ${e instanceof Error ? e.message : String(e)}`,
			);
			return null;
		});
	}
	const handle = await fusedEmbedHandlePromise;
	if (!handle) {
		fusedEmbedFirstFailureMs ??= Date.now();
		if (Date.now() - fusedEmbedFirstFailureMs < FUSED_EMBED_RETRY_WINDOW_MS) {
			// Still within the staging window — clear the memo so the next embed
			// retries once the on-device model finishes staging. Past the window we
			// keep the cached miss so an unservable host stops re-probing.
			fusedEmbedHandlePromise = null;
		}
		return null;
	}
	// Pooling is part of the vector space: BGE uses CLS, GTE uses MEAN.
	// Retain the legacy default for existing stores until explicitly migrated.
	const requestedPooling =
		process.env.ELIZA_EMBED_POOLING?.trim().toLowerCase();
	const pooling =
		requestedPooling === "cls"
			? ELIZA_POOLING_CLS
			: requestedPooling === "last"
				? ELIZA_POOLING_LAST
				: ELIZA_POOLING_MEAN;
	return {
		embed: (text: string) => handle.embed({ ctx: handle.ctx, text, pooling }),
	};
}

/**
 * Desktop TEXT_EMBEDDING handler over the FUSED `libelizainference`
 * (`eliza_inference_embed`, ABI v9). The dedicated embedding GGUF (gte-small,
 * 384-dim — an exact match for plugin-sql's dim384 column) is staged as the
 * sole entry of an isolated fused embed bundle (see
 * `resolveFusedEmbeddingBundleRoot`)
 * so the fused lib loads it directly. libllama is retired: there is no
 * capacitor/libllama fallback. When the fused embed cannot resolve (no bun:ffi,
 * no fused lib, or the embedding GGUF is still downloading) this throws so the
 * runtime falls through to the operator-configured provider — never a silent
 * zero-vector (Commandment 8).
 */
function makeFusedEmbeddingHandler(): EmbeddingHandler {
	let loadedConfig: DesktopEmbeddingConfig | undefined;
	return async (_runtime, params) => {
		const text = extractEmbeddingText(params);
		let cfg = loadedConfig;
		if (!cfg) {
			// When the probe fails, resolveDesktopEmbeddingConfig(undefined) uses the
			// `performance` preset (gpuLayers: auto — inert on a CPU-only fused lib).
			// Log WHY so a broken probe on an accelerated box is visible, not silent
			// (#10727) — the tier is then chosen without hardware evidence.
			const hardware = await timeInferenceSpan("embedding:hardware-probe", () =>
				probeHardware(),
			).catch((error) => {
				logger.warn(
					`[ensureLocalInferenceHandler] hardware probe failed; embedding tier chosen without hardware evidence (performance preset, gpuLayers: auto): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return undefined;
			});
			cfg = resolveDesktopEmbeddingConfig(hardware);
		}
		const fused = await timeInferenceSpan("embedding:handle", () =>
			getFusedEmbeddingHandle(cfg),
		);
		if (!fused) {
			throw new LocalInferenceUnavailableError(
				ModelType.TEXT_EMBEDDING,
				"backend_unavailable",
				`[local-inference] TEXT_EMBEDDING unavailable: the fused libelizainference ` +
					`embed path could not resolve for "${cfg.model}" (needs bun:ffi, the fused ` +
					`lib, and the embedding GGUF present). libllama is retired — falling through ` +
					`to the next embedding provider.`,
			);
		}
		// A loaded native handle keeps its model/configuration for the process lifetime.
		// Failed initialization must keep probing so a later staging retry can recover.
		loadedConfig = cfg;
		const close = getInferenceTimer()?.openSpan("embedding:native");
		try {
			return Array.from(fused.embed(text));
		} finally {
			close?.();
		}
	};
}

function extractSpeechText(params: TextToSpeechParams | string): string {
	if (typeof params === "string") return params;
	if (params && typeof params.text === "string") return params.text;
	throw new Error(
		"[local-inference] TEXT_TO_SPEECH requires a string or { text } input",
	);
}

function extractSpeechSignal(
	params: TextToSpeechParams | string,
): AbortSignal | undefined {
	return typeof params === "object" && params !== null
		? params.signal
		: undefined;
}

function makeTextToSpeechHandler(): TextToSpeechHandler {
	return async (_runtime, params) => {
		const text = extractSpeechText(params);
		if (text.length === 0) {
			throw new Error(
				"[local-inference] TEXT_TO_SPEECH text must be non-empty",
			);
		}
		// Do not filter singing, emotion tags, or lyrical phrasing here. The
		// local voice bundle advertises its expressive capability in the
		// manifest; runtime safety policy lives above this model adapter.
		await localInferenceEngine.ensureActiveBundleVoiceReady();
		return localInferenceEngine.synthesizeSpeech(
			text,
			extractSpeechSignal(params),
			extractRequestedKokoroVoiceId(params),
		);
	};
}

function toUint8Array(value: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
	if (value instanceof Uint8Array) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return new Uint8Array(value);
}

function extractTranscriptionAudio(
	params: TranscriptionParams | Buffer | string | LocalTranscriptionParams,
): TranscriptionAudio {
	if (typeof params === "string") {
		throw new Error(
			"[local-inference] TRANSCRIPTION via the local voice runtime requires PCM/WAV bytes; URL/path strings are not fetched by this provider",
		);
	}
	if (params instanceof Uint8Array || params instanceof ArrayBuffer) {
		return decodeMonoPcm16Wav(toUint8Array(params));
	}
	if (!params || typeof params !== "object") {
		throw new Error(
			"[local-inference] TRANSCRIPTION requires PCM/WAV bytes or { pcm, sampleRateHz }",
		);
	}
	if ("audioUrl" in params && typeof params.audioUrl === "string") {
		throw new Error(
			"[local-inference] TRANSCRIPTION audioUrl is not fetched by the local voice runtime; pass mono PCM16 WAV bytes or { pcm, sampleRateHz }",
		);
	}
	if ("pcm" in params && params.pcm instanceof Float32Array) {
		const sampleRate =
			("sampleRateHz" in params ? params.sampleRateHz : undefined) ??
			("sampleRate" in params ? params.sampleRate : undefined);
		if (typeof sampleRate !== "number" || sampleRate <= 0) {
			throw new Error(
				"[local-inference] TRANSCRIPTION { pcm } requires a positive sampleRateHz",
			);
		}
		return { pcm: params.pcm, sampleRate };
	}
	if (
		"audio" in params &&
		(params.audio instanceof Uint8Array || params.audio instanceof ArrayBuffer)
	) {
		return decodeMonoPcm16Wav(toUint8Array(params.audio));
	}
	throw new Error(
		"[local-inference] TRANSCRIPTION requires mono PCM16 WAV bytes or { pcm, sampleRateHz } for the local voice runtime",
	);
}

function extractTranscriptionSignal(
	params: TranscriptionParams | Buffer | string | LocalTranscriptionParams,
): AbortSignal | undefined {
	return typeof params === "object" && params !== null
		? (params as { signal?: AbortSignal }).signal
		: undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("Aborted", "AbortError");
}

function makeTranscriptionHandler(): TranscriptionHandler {
	return async (_runtime, params) => {
		const signal = extractTranscriptionSignal(params);
		throwIfAborted(signal);
		const audio = extractTranscriptionAudio(params);
		// The fused libelizainference ASR runtime is the sole on-device
		// transcriber. A startup/availability failure propagates (AGENTS.md §3) —
		// there is no whisper.cpp second attempt and no silent empty transcript.
		await localInferenceEngine.ensureActiveBundleAsrReady();
		throwIfAborted(signal);
		// Stream partial transcripts through the same pipe as chat text when the
		// runtime wired a chunk sink (useModel injects onStreamChunk into local
		// model params inside a streaming reply turn). The fused streaming-ASR
		// session surfaces each running partial; we forward the deltas. Read the
		// sink structurally so this stays robust to the core param type surface.
		const streamSink =
			params && typeof params === "object"
				? (
						params as {
							onStreamChunk?: (chunk: string) => void | Promise<void>;
						}
					).onStreamChunk
				: undefined;
		const onPartial =
			typeof streamSink === "function"
				? (delta: string) => {
						void streamSink(delta);
					}
				: undefined;
		const transcript = await localInferenceEngine.transcribePcm(
			audio,
			signal,
			onPartial,
		);
		throwIfAborted(signal);
		return transcript;
	};
}

function paramsToVisionRequest(params: ImageDescriptionParams | string): {
	image: VisionImageInput;
	prompt?: string;
	signal?: AbortSignal;
	onTextChunk?: (chunk: string) => void | Promise<void>;
} {
	const url = typeof params === "string" ? params : params.imageUrl;
	if (typeof url !== "string" || url.length === 0) {
		throw new Error(
			"[local-inference] IMAGE_DESCRIPTION requires a non-empty imageUrl",
		);
	}
	const prompt = typeof params === "object" ? params.prompt : undefined;
	const signal =
		typeof params === "object"
			? (params as { signal?: AbortSignal }).signal
			: undefined;
	const wantsStream =
		typeof params === "object" &&
		(params as { stream?: boolean }).stream === true;
	const streamSink =
		wantsStream && typeof params === "object"
			? (params as { onStreamChunk?: (chunk: string) => void | Promise<void> })
					.onStreamChunk
			: undefined;
	const onTextChunk =
		typeof streamSink === "function"
			? (chunk: string) => streamSink(chunk)
			: undefined;
	if (url.startsWith("data:")) {
		return {
			image: { kind: "dataUrl", dataUrl: url },
			prompt,
			...(signal ? { signal } : {}),
			...(onTextChunk ? { onTextChunk } : {}),
		};
	}
	return {
		image: { kind: "url", url },
		prompt,
		...(signal ? { signal } : {}),
		...(onTextChunk ? { onTextChunk } : {}),
	};
}

function normalizeImageDescription(
	result: ImageDescriptionResult | string,
): ImageDescriptionResult {
	if (typeof result === "string") {
		const description = result.trim();
		if (!description) {
			throw new Error(
				"[local-inference] IMAGE_DESCRIPTION backend returned an empty description",
			);
		}
		return {
			title: description.split(/[.!?]/, 1)[0]?.trim() || "Image",
			description,
		};
	}
	if (
		result &&
		typeof result === "object" &&
		typeof result.title === "string" &&
		typeof result.description === "string" &&
		result.title.trim().length > 0 &&
		result.description.trim().length > 0
	) {
		return {
			title: result.title.trim(),
			description: result.description.trim(),
		};
	}
	throw new Error(
		"[local-inference] IMAGE_DESCRIPTION backend returned an invalid description",
	);
}

/**
 * Runtime setting marker that plugin-vision polls before preferring the
 * Eliza-1 vision path over its legacy Florence path. We set it only when
 * the process-wide arbiter advertises the `vision-describe` capability.
 */
const ELIZA1_VISION_MARKER = "ELIZA1_VISION_HANDLER_PRESENT";

function markEliza1VisionHandlerPresent(runtime: IAgentRuntime): void {
	const r = runtime as IAgentRuntime & {
		setSetting?: (key: string, value: unknown) => void;
		getSetting?: (key: string) => unknown;
	};
	if (typeof r.setSetting !== "function") return;
	if (typeof r.getSetting === "function") {
		const existing = r.getSetting(ELIZA1_VISION_MARKER);
		if (existing === "1" || existing === true) return;
	}
	try {
		r.setSetting(ELIZA1_VISION_MARKER, "1");
	} catch {
		// Some test runtimes don't accept setSetting at runtime — non-fatal.
	}
}

function makeImageDescriptionHandler(): ImageDescriptionHandler {
	return async (runtime, params) => {
		const arbiter = tryGetMemoryArbiter();
		if (
			!arbiter?.hasCapability("vision-describe") ||
			typeof arbiter.requestVisionDescribe !== "function"
		) {
			throw new Error(
				"[local-inference] IMAGE_DESCRIPTION requires an active Eliza-1 vision-capable bundle with the vision-describe capability registered",
			);
		}
		markEliza1VisionHandlerPresent(runtime);
		const modelKeyCandidate =
			typeof params === "object"
				? (params as ImageDescriptionParams & { modelKey?: unknown }).modelKey
				: undefined;
		const modelKey =
			typeof modelKeyCandidate === "string" && modelKeyCandidate
				? modelKeyCandidate
				: "gemma-vl";
		const request = paramsToVisionRequest(params);
		request.image = await prepareVisionImageInput(runtime, request.image, {
			signal: request.signal,
		});
		const result = await arbiter.requestVisionDescribe<
			typeof request,
			ImageDescriptionResult | string
		>({ modelKey, payload: request });
		return normalizeImageDescription(result);
	};
}

// ── Bionic-host TRANSCRIPTION / IMAGE_DESCRIPTION (Android GPU delegation) ──
//
// On the bionic-delegated path the musl agent can't load the fused
// libelizainference, so the engine-driven transcriber / memory-arbiter vision
// paths above can't run here. Instead the audio / image bytes are forwarded to
// the in-process bionic host over the UDS (op="asr" / op="image"), which runs
// the fused Gemma ASR + mmproj vision path on the Mali GPU and returns text.
// This is the same delegation `BionicHostLoader` already does for text
// generation.

/** The bionic-host loader when registered (exposes transcribe + describeImage). */
function getBionicHostLoader(runtime: IAgentRuntime): BionicHostLoader | null {
	const svc = (
		runtime as { getService?: (name: string) => unknown }
	).getService?.("localInferenceLoader");
	if (
		svc &&
		typeof (svc as BionicHostLoader).transcribe === "function" &&
		typeof (svc as BionicHostLoader).describeImage === "function"
	) {
		return svc as BionicHostLoader;
	}
	return null;
}

/** Pack a mono fp32 PCM buffer little-endian and base64-encode it for the UDS frame. */
export function float32ToBase64LE(pcm: Float32Array): string {
	const buf = Buffer.allocUnsafe(pcm.length * 4);
	for (let i = 0; i < pcm.length; i++) {
		buf.writeFloatLE(pcm[i] ?? 0, i * 4);
	}
	return buf.toString("base64");
}

/** Resolve a vision request to base64 image bytes for the bionic host. */
export async function imageRequestToBase64(
	image: VisionImageInput,
): Promise<string> {
	if (image.kind === "dataUrl" && image.dataUrl) {
		const comma = image.dataUrl.indexOf(",");
		return comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl;
	}
	if (image.kind === "base64") {
		return image.base64;
	}
	if (image.kind === "bytes") {
		return Buffer.from(image.bytes).toString("base64");
	}
	if (image.kind === "url") {
		const url = typeof image.url === "string" ? image.url.trim() : "";
		if (!url) {
			throw new Error(
				"[local-inference] IMAGE_DESCRIPTION requires a valid image URL",
			);
		}
		try {
			// Caller-supplied image URLs must go through the shared SSRF media
			// guard; bare `fetch` would let vision describe internal hosts.
			const media = await fetchRemoteMedia({
				url,
				maxBytes: VISION_IMAGE_MAX_BYTES,
				timeoutMs: VISION_IMAGE_FETCH_TIMEOUT_MS,
				maxRedirects: 5,
			});
			return media.buffer.toString("base64");
		} catch (err) {
			// error-policy:J2 context-adding rethrow — preserve guarded-fetch cause
			throw new Error(
				`[local-inference] IMAGE_DESCRIPTION failed to fetch ${url}: ${
					err instanceof Error ? err.message : String(err)
				}`,
				{ cause: err },
			);
		}
	}
	throw new Error(
		"[local-inference] IMAGE_DESCRIPTION could not resolve image bytes",
	);
}

function makeBionicTranscriptionHandler(): TranscriptionHandler {
	return async (runtime, params) => {
		const signal = extractTranscriptionSignal(params);
		throwIfAborted(signal);
		const loader = getBionicHostLoader(runtime);
		if (!loader) {
			throw new Error(
				"[local-inference] bionic-host TRANSCRIPTION requires the bionic-host loader (localInferenceLoader service)",
			);
		}
		const audio = extractTranscriptionAudio(params);
		throwIfAborted(signal);
		const transcript = await loader.transcribe({
			pcmBase64: float32ToBase64LE(audio.pcm),
			sampleRate: audio.sampleRate,
		});
		throwIfAborted(signal);
		return transcript;
	};
}

function makeBionicImageDescriptionHandler(): ImageDescriptionHandler {
	return async (runtime, params) => {
		const loader = getBionicHostLoader(runtime);
		if (!loader) {
			throw new Error(
				"[local-inference] bionic-host IMAGE_DESCRIPTION requires the bionic-host loader (localInferenceLoader service)",
			);
		}
		const request = paramsToVisionRequest(params);
		request.image = await prepareVisionImageInput(runtime, request.image, {
			signal: request.signal,
		});
		const description = await loader.describeImage({
			imageBase64: await imageRequestToBase64(request.image),
			prompt: request.prompt,
		});
		return normalizeImageDescription(description);
	};
}

/**
 * AOSP / generic-FFI path: load the fused `libelizainference.so` into the bun
 * process via `bun:ffi` (the AOSP plugin's loader; libllama is retired). The
 * loader stays inactive at runtime when neither `ELIZA_LOCAL_LLAMA === "1"`
 * (kept as the legacy opt-in env name) nor `process.arch === "riscv64"` is
 * true (see `isAospEnabled` in `@elizaos/plugin-native-inference`), so the
 * dynamic import below is safe on every platform; we only attempt registration
 * when one of the triggers fires.
 *
 * riscv64 rationale: `capacitor-llama` ships prebuilts only for
 * linux-{x64,arm64}, darwin-arm64, win-x64. Riscv64 hosts have no native NAPI
 * binding option; the cross-built fused `libelizainference.so` is the only
 * in-process llama.cpp path. The FFI loader satisfies the same
 * `localInferenceLoader` service contract, so the rest of the engine —
 * model handlers, embedding routing, response handler — works unchanged.
 *
 * The `try`/`catch` is justified because the AOSP build can ship the .so on
 * one ABI but be invoked on another (e.g. cuttlefish_x86_64 reporting both
 * x86_64 and arm64-v8a). When `ELIZA_LOCAL_LLAMA=1` is set but registration
 * fails, the loader logs at `error` level — we must NOT silently fall
 * through to the device-bridge or stock engine: the operator opted in and
 * deserves the failure surfaced clearly. The riscv64 auto-trigger uses the
 * same path; if the bundled `libelizainference.so` is missing the failure is
 * logged but inference falls through to Cloud routing (per CLAUDE.md deployment
 * topologies — local-only is supported but Cloud is an acceptable fallback
 * when the on-device backend is unavailable).
 */
export function shouldAttemptAospLlamaLoader(
	env: NodeJS.ProcessEnv = process.env,
	arch: NodeJS.Architecture = process.arch,
): boolean {
	if (env.ELIZA_DISABLE_FFI_LLAMA?.trim() === "1") return false;
	if (env.ELIZA_LOCAL_LLAMA?.trim() === "1") return true;
	if (arch === "riscv64") return true;
	return false;
}

/**
 * Bionic-host delegation gate. On Android the app shell sets
 * `ELIZA_BIONIC_HOST_DELEGATED=1` + `ELIZA_BIONIC_INFERENCE_SOCK=<name>` when a
 * dynamic-Vulkan `libelizainference.so` is staged — meaning the GPU is reachable
 * only from the bionic app process, never this musl agent. When set, the agent
 * delegates inference to that in-process host over the abstract UDS instead of
 * dlopen'ing the native lib itself (which would hit the Vulkan/HIDL wall).
 */
export function bionicInferenceSocketName(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (env.ELIZA_BIONIC_HOST_DELEGATED?.trim() !== "1") return null;
	const sock = env.ELIZA_BIONIC_INFERENCE_SOCK?.trim();
	return sock ? sock : null;
}

/**
 * Register the bionic-host loader when delegation is enabled. Wins over the
 * AOSP / Capacitor / device-bridge loaders: the whole point is that the GPU is
 * out of reach for the in-process FFI path on this (musl) process.
 */
async function tryRegisterBionicHostLoader(
	runtime: AgentRuntime,
): Promise<boolean> {
	const socketName = bionicInferenceSocketName();
	if (!socketName) return false;
	const loader: LocalInferenceLoader = new BionicHostLoader(socketName);
	const loaderWithArbiter = Object.assign(loader, {
		getMemoryArbiter: () => tryGetMemoryArbiter(),
	});
	await registerLocalInferenceLoaderService(runtime, loaderWithArbiter);
	await runtime.getServiceLoadPromise(LOCAL_INFERENCE_LOADER_SERVICE_TYPE);
	logger.info(
		`[local-inference] Registered bionic-host loader; text generation delegates to the in-process GPU host over UDS "${socketName}"`,
	);
	return true;
}

async function tryRegisterAospLlamaLoader(
	runtime: AgentRuntime,
): Promise<boolean> {
	if (!shouldAttemptAospLlamaLoader()) return false;
	try {
		const mod = (await import("@elizaos/plugin-native-inference")) as {
			registerAospLlamaLoader?: (r: AgentRuntime) => Promise<boolean> | boolean;
		};
		if (typeof mod.registerAospLlamaLoader !== "function") {
			logger.error(
				"[local-inference] AOSP llama adapter import resolved but missing registerAospLlamaLoader export",
			);
			return false;
		}
		const registered = Boolean(await mod.registerAospLlamaLoader(runtime));
		if (registered) {
			await runtime.getServiceLoadPromise(LOCAL_INFERENCE_LOADER_SERVICE_TYPE);
		}
		return registered;
	} catch (err) {
		logger.error(
			"[local-inference] AOSP llama adapter unavailable while ELIZA_LOCAL_LLAMA=1:",
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
}

async function tryRegisterCapacitorLoader(
	runtime: AgentRuntime,
): Promise<boolean> {
	// Only meaningful under Capacitor (iOS/Android). Dynamic import so web /
	// desktop bundlers don't choke on the native plugin metadata.
	const cap = (globalThis as Record<string, unknown>).Capacitor as
		| { isNativePlatform?: () => boolean }
		| undefined;
	if (!cap?.isNativePlatform?.()) return false;
	try {
		const { registerCapacitorLlamaLoader } = await import(
			"@elizaos/capacitor-llama"
		);
		const registered = await registerCapacitorLlamaLoader(runtime);
		if (!registered) return false;
		await runtime.getServiceLoadPromise(LOCAL_INFERENCE_LOADER_SERVICE_TYPE);
		logger.info(
			"[local-inference] Registered capacitor-llama loader for mobile on-device inference",
		);
		return true;
	} catch (err) {
		logger.debug(
			"[local-inference] capacitor-llama not available:",
			err instanceof Error ? err.message : String(err),
		);
	}
	return false;
}

async function resolveMobileDeviceBridgeService(
	runtime: AgentRuntime,
): Promise<MobileDeviceBridgeService | null> {
	if (!runtime.hasService(ServiceType.MOBILE_DEVICE_BRIDGE)) return null;
	await runtime.getServiceLoadPromise(ServiceType.MOBILE_DEVICE_BRIDGE);
	return runtime.getService<MobileDeviceBridgeService>(
		ServiceType.MOBILE_DEVICE_BRIDGE,
	);
}

function installLocalRouterAndMark(
	runtime: AgentRuntime,
	runtimeWithRegistration: RuntimeWithLocalInferenceFlag,
): void {
	installRouterHandler(runtime, {
		skipSlots: isLocalEmbeddingDisabledByEnv() ? ["TEXT_EMBEDDING"] : [],
	});
	runtimeWithRegistration[LOCAL_INFERENCE_HANDLER_INSTALLED] = true;
}

/**
 * Synthetic conversation id used to keep the Stage-1 stable prefix
 * (system prompt + tool/action schema block + stable provider blocks)
 * resident on a deterministic slot before any real conversation lands.
 * `deriveSlotId("conv:__system_prefix__", parallel)` is stable, so this
 * always warms the same slot; per-room conversations get their own slot
 * via `conv:<roomId>` and inherit the radix-shared prefix tokens.
 */
const SYSTEM_PREFIX_CONVERSATION_ID = "__system_prefix__";

/**
 * Render the Stage-1 stable prefix for `roomId` and KV-prefill the
 * local-inference slot that conversation pins to. Wire this from the
 * voice turn controller (W9) on `speech-start` / voice-session-open so
 * the response-handler prompt is hot before STT finishes — items I1/C1.
 *
 * Best-effort end to end: returns false (no throw) when there's no
 * loaded local model, the active backend can't pre-warm (node-llama-cpp
 * pins by cache key already), or rendering/pre-warm fails. A miss just
 * means the real request cold-prefills.
 */
export async function prewarmResponseHandler(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<boolean> {
	if (!localInferenceEngine.hasLoadedModel()) return false;
	if (localInferenceEngine.activeBackendId() !== "llama-cpp") return false;
	try {
		const prefix = await renderMessageHandlerStablePrefix(runtime, roomId);
		if (!prefix) return false;
		return await localInferenceEngine.prewarmConversation(
			String(roomId),
			prefix,
		);
	} catch (err) {
		logger.debug(
			"[local-inference] prewarmResponseHandler failed (best-effort):",
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
}

/**
 * Warm the Stage-1 stable prefix onto the deterministic
 * `conv:__system_prefix__` slot at model-load / boot time, before any
 * user message — item I3 (warm-on-load). The room id is irrelevant for
 * the stable prefix (it carries no per-room state), so a fixed synthetic
 * id is fine. No-op when no local model is loaded or the backend can't
 * pre-warm. Best-effort: failures are logged at debug and swallowed.
 */
export async function prewarmSystemPrefix(
	runtime: IAgentRuntime,
): Promise<boolean> {
	if (!localInferenceEngine.hasLoadedModel()) return false;
	if (localInferenceEngine.activeBackendId() !== "llama-cpp") return false;
	try {
		const fixedRoomId = runtime.agentId as UUID;
		const prefix = await renderMessageHandlerStablePrefix(runtime, fixedRoomId);
		if (!prefix) return false;
		return await localInferenceEngine.prewarmConversation(
			SYSTEM_PREFIX_CONVERSATION_ID,
			prefix,
		);
	} catch (err) {
		logger.debug(
			"[local-inference] prewarmSystemPrefix failed (best-effort):",
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
}

export async function ensureLocalInferenceHandler(
	runtime: AgentRuntime,
): Promise<void> {
	const runtimeMode = getRuntimeMode(runtime);
	if (!shouldRegisterLocalInferenceHandlers(runtimeMode)) {
		// A provisioned Dedicated runtime can keep text generation in the cloud
		// while explicitly owning embeddings locally. The collector yields the
		// cloud embedding slot for this same opt-in, so skipping both providers
		// leaves durable memory without vectors. Register only the fused embedder:
		// cloud clients must not activate local text, voice, or model loaders.
		if (
			runtimeMode === "cloud" &&
			readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1" &&
			readAliasedEnv("ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS") === "1" &&
			process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS?.trim().toLowerCase() !==
				"true" &&
			!isLocalEmbeddingDisabledByEnv()
		) {
			const target = runtime as RuntimeWithLocalInferenceFlag;
			if (!target[DEDICATED_EMBEDDING_HANDLER_INSTALLED]) {
				target.registerModel(
					ModelType.TEXT_EMBEDDING,
					makeFusedEmbeddingHandler(),
					LOCAL_INFERENCE_PROVIDER,
					LOCAL_INFERENCE_PRIORITY,
				);
				target[DEDICATED_EMBEDDING_HANDLER_INSTALLED] = true;
			}
			return;
		}
		logger.info(
			`[local-inference] Runtime mode is ${runtimeMode}; skipping local model handler registration`,
		);
		return;
	}

	const runtimeWithRegistration = runtime as RuntimeWithLocalInferenceFlag;
	if (
		typeof runtimeWithRegistration.getModel !== "function" ||
		typeof runtimeWithRegistration.registerModel !== "function"
	) {
		return;
	}
	if (runtimeWithRegistration[LOCAL_INFERENCE_HANDLER_INSTALLED]) {
		logger.debug(
			"[local-inference] Local model handlers already registered on this runtime; skipping duplicate registration",
		);
		return;
	}

	// Mirror the runtime's model registry into the side-registry: it seeds
	// from the current registrations and stays live via the `MODEL_REGISTERED`
	// event — capturing our own handlers below plus anything else that
	// registers during the rest of boot. Idempotent per-runtime.
	handlerRegistry.installOn(runtime);
	await registerTimedAsrService(runtime);
	await runtime.getServiceLoadPromise(TIMED_ASR_SERVICE_TYPE);

	// Loader precedence:
	//   1. AOSP native FFI loader when running inside the AOSP agent process
	//      itself (ELIZA_LOCAL_LLAMA=1). This is the canonical AOSP path —
	//      libllama.so is dlopen'd directly, no IPC.
	//   2. Capacitor native adapter when running on a mobile device with the
	//      Capacitor APK shell.
	//   3. Standalone node-llama-cpp engine for desktop / server.
	//
	// These backends satisfy the `localInferenceLoader` service contract. Select
	// exactly one: duplicate service classes make `getService()` ambiguous and
	// transfer teardown ownership away from the backend that actually won. The
	// stock WebSocket device bridge is deliberately separate: capacitor-bridge
	// owns it through `MobileDeviceBridgeService` and registers model handlers
	// only after a paired device can serve them.
	// Bionic-host delegation wins over every other loader: when set, the GPU is
	// only reachable from the in-process app host, so the musl agent must NOT try
	// the in-process FFI / device-bridge paths (the app shell already suppressed
	// ELIZA_LOCAL_LLAMA in this case).
	const bionicHostRegistered = await tryRegisterBionicHostLoader(runtime);
	const aospRegistered =
		!bionicHostRegistered && (await tryRegisterAospLlamaLoader(runtime));
	const capacitorRegistered =
		!bionicHostRegistered &&
		!aospRegistered &&
		(await tryRegisterCapacitorLoader(runtime));
	const deviceBridgeEnabled =
		!bionicHostRegistered &&
		process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";

	// The AOSP bootstrap already registered its complete handler set before
	// runtime.initialize() so embedding probes can use it. The post-init hook
	// only starts/reuses that same service owner and installs routing metadata;
	// adding generic handlers here would duplicate the same provider and revive
	// the earlier-loader tie that leaked native ownership.
	if (aospRegistered) {
		installLocalRouterAndMark(runtime, runtimeWithRegistration);
		logger.info(
			"[local-inference] Reused the pre-initialize AOSP loader and handler set",
		);
		return;
	}

	// Stock device-bridge handlers belong to plugin-capacitor-bridge and are
	// registered only after its canonical singleton has a real attached device.
	// Resolve that singleton through the core service seam for lifecycle
	// ownership, but never manufacture a second loader/provider from the env flag.
	if (!capacitorRegistered && deviceBridgeEnabled) {
		const bridgeService = await resolveMobileDeviceBridgeService(runtime);
		if (bridgeService) {
			const status = bridgeService.getMobileDeviceBridgeStatus();
			logger.info(
				`[local-inference] Canonical mobile device bridge service ready (${status.connected ? "device attached" : "waiting for attach"}); handler registration stays with the bridge owner`,
			);
		} else {
			logger.warn(
				"[local-inference] ELIZA_DEVICE_BRIDGE_ENABLED=1 but the canonical mobile device bridge service is not registered; leaving device handlers unregistered",
			);
		}
		installLocalRouterAndMark(runtime, runtimeWithRegistration);
		return;
	}

	// Text/voice availability and embedding availability are independent on
	// desktop. gte-small uses the dedicated fused embedding entry point and can
	// be present even when no generative model/backend is active. The old
	// process-wide preflight returned here and therefore never registered the
	// perfectly usable local 384-dim embedder; the runtime then pinned Eliza
	// Cloud's synthetic 1536-dim probe and every real embedding hit the network.
	// Keep text handlers registered (their router gate already drops unavailable
	// local candidates), but only advertise voice/vision when a general backend
	// is actually available.
	const generalBackendAvailable =
		bionicHostRegistered ||
		capacitorRegistered ||
		(await localInferenceEngine.available());
	if (!generalBackendAvailable) {
		logger.debug(
			"[local-inference] No general local inference backend available; local text candidates stay dormant while the independent desktop embedding path remains registered",
		);
	}

	// First-light convenience: when exactly one model is installed and no
	// slot assignments exist, auto-fill TEXT_SMALL/TEXT_LARGE so the user
	// lands in chat without opening Settings. The downloader handles the
	// post-install case; this catches the user who pre-staged a model
	// (external scan, prior install) and is now booting fresh.
	try {
		const installed = await listInstalledModels();
		const filled = await autoAssignAtBoot(installed);
		if (filled) {
			logger.info(
				`[local-inference] Auto-assigned single installed model to empty slots: ${JSON.stringify(filled)}`,
			);
		}
	} catch (err) {
		logger.warn(
			"[local-inference] autoAssignAtBoot failed:",
			err instanceof Error ? err.message : String(err),
		);
	}

	const provider = aospRegistered
		? AOSP_LLAMA_PROVIDER
		: capacitorRegistered
			? CAPACITOR_LLAMA_PROVIDER
			: deviceBridgeEnabled
				? DEVICE_BRIDGE_PROVIDER
				: LOCAL_INFERENCE_PROVIDER;

	const textGenerationSlots: Array<
		[(typeof ModelType)[keyof typeof ModelType], AgentModelSlot]
	> = [
		[ModelType.TEXT_SMALL, "TEXT_SMALL"],
		[ModelType.TEXT_LARGE, "TEXT_LARGE"],
		// V5 chat calls semantic text model types directly. Register them as
		// first-class local handlers so structured streaming sees the concrete
		// local provider instead of falling through TEXT_SMALL via the router.
		[ModelType.RESPONSE_HANDLER, "TEXT_SMALL"],
		[ModelType.ACTION_PLANNER, "TEXT_SMALL"],
		[ModelType.TEXT_COMPLETION, "TEXT_SMALL"],
	];
	for (const [modelType, slot] of textGenerationSlots) {
		try {
			runtimeWithRegistration.registerModel(
				modelType,
				makeHandler(slot),
				provider,
				LOCAL_INFERENCE_PRIORITY,
				{ local: true, streamable: true },
			);
		} catch (err) {
			logger.warn(
				"[local-inference] Could not register ModelType",
				modelType,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// Register TEXT_EMBEDDING separately — the runtime contract returns
	// `number[]` instead of `string`, so it can't share `makeHandler`.
	//   - AOSP / device-bridge loaders expose `embed()` on the
	//     `localInferenceLoader` service → route through that.
	//   - Desktop has no `localInferenceLoader`; it serves embeddings through
	//     the fused `libelizainference` (`eliza_inference_embed`) over the
	//     dedicated gte-small GGUF staged as an isolated embed bundle. libllama
	//     is retired — there is no capacitor/libllama embedding fallback.
	// Neither path registers a handler that would serve a silent zero-vector:
	// both throw when there's nothing real to call, so the runtime falls
	// through to the operator-configured provider (Commandment 8).
	const loaderForEmbed = (
		runtime as { getService?: (name: string) => unknown }
	).getService?.("localInferenceLoader") as
		| { embed?: unknown }
		| null
		| undefined;
	const embeddingHandler = isLocalEmbeddingDisabledByEnv()
		? null
		: loaderForEmbed && typeof loaderForEmbed.embed === "function"
			? makeEmbeddingHandler()
			: provider === LOCAL_INFERENCE_PROVIDER
				? makeFusedEmbeddingHandler()
				: null;
	if (embeddingHandler) {
		try {
			runtimeWithRegistration.registerModel(
				ModelType.TEXT_EMBEDDING,
				embeddingHandler,
				provider,
				LOCAL_INFERENCE_PRIORITY,
			);
			logger.info(
				`[local-inference] Registered ${provider} embedding handler for TEXT_EMBEDDING at priority ${LOCAL_INFERENCE_PRIORITY}`,
			);
		} catch (err) {
			logger.warn(
				"[local-inference] Could not register TEXT_EMBEDDING handler",
				err instanceof Error ? err.message : String(err),
			);
		}
	} else if (isLocalEmbeddingDisabledByEnv()) {
		logger.info(
			"[local-inference] Local TEXT_EMBEDDING handler disabled by ELIZA_DISABLE_LOCAL_EMBEDDINGS",
		);
	}

	if (generalBackendAvailable) {
		try {
			runtimeWithRegistration.registerModel(
				ModelType.TEXT_TO_SPEECH,
				makeTextToSpeechHandler(),
				provider,
				LOCAL_INFERENCE_PRIORITY,
			);
			// TRANSCRIPTION is registered default-on at the local-inference floor
			// priority (0). It is the last-resort handler: any cloud / other-plugin
			// TRANSCRIPTION handler registers above 0 and wins. When the handler
			// does run, it drives the fused libelizainference ASR runtime — the sole
			// on-device transcriber (Gemma ASR streaming → fused batch interim →
			// AsrUnavailableError) via the engine's armed voice bridge — see
			// makeTranscriptionHandler / EngineVoiceBridge.createStreamingTranscriber.
			// (The old ELIZA_LOCAL_TRANSCRIPTION env gate is removed — voice is a
			// first-class Eliza-1 surface, not opt-in.)
			// On the bionic-delegated path the fused lib lives in the app process, not
			// this musl agent — so transcription + vision must forward audio/image
			// bytes to the bionic host (op="asr" / op="image") rather than the
			// in-process engine / memory-arbiter, which can't load the lib here.
			runtimeWithRegistration.registerModel(
				ModelType.TRANSCRIPTION,
				bionicHostRegistered
					? makeBionicTranscriptionHandler()
					: makeTranscriptionHandler(),
				provider,
				LOCAL_INFERENCE_PRIORITY,
			);
			runtimeWithRegistration.registerModel(
				ModelType.IMAGE_DESCRIPTION,
				bionicHostRegistered
					? makeBionicImageDescriptionHandler()
					: makeImageDescriptionHandler(),
				provider,
				LOCAL_INFERENCE_PRIORITY,
			);
			logger.info(
				`[local-inference] Registered ${provider} voice and vision handlers for TEXT_TO_SPEECH / TRANSCRIPTION / IMAGE_DESCRIPTION at priority ${LOCAL_INFERENCE_PRIORITY}${bionicHostRegistered ? " (bionic-host delegated)" : ""}`,
			);
		} catch (err) {
			logger.warn(
				"[local-inference] Could not register local voice/vision handlers",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	logger.info(
		`[local-inference] Registered ${provider} llama.cpp text handlers at priority ${LOCAL_INFERENCE_PRIORITY}`,
	);

	// Install the top-priority router AFTER everything else has registered.
	// The router sits at Number.MAX_SAFE_INTEGER so the runtime dispatches
	// to it first; at dispatch time it picks a real provider via
	// `routing-policy` and calls that handler directly.
	installLocalRouterAndMark(runtime, runtimeWithRegistration);
	logger.info(
		"[local-inference] Installed top-priority router for cross-provider routing",
	);

	// Warm-on-load (item I3): if a local model is already resident, KV-prefill
	// the Stage-1 stable prefix onto the deterministic system-prefix slot so
	// the system prompt + tool schema is hot before the first user turn.
	// Fire-and-forget — pre-warm is best-effort and must never block boot.
	void prewarmSystemPrefix(runtime).catch(() => {
		// Logged inside prewarmSystemPrefix at debug; nothing more to do here.
	});
}
