/**
 * Per-provider LLM price table — canonical source of truth.
 *
 * Closes M40 / W1-X1 (see docs/eliza-1-pipeline/{02-gap-analysis.md,
 * 03-implementation-plan.md}). Every LLM step recorded in the trajectory
 * subsystem is annotated with `cost_usd` computed from this table.
 *
 * All numbers are USD per 1,000,000 tokens (the standard unit pricing
 * providers publish).
 *
 * Versioned via `PRICE_TABLE_ID`. When prices change, bump the date suffix
 * so downstream readers (the trajectory CLI, the cost-regression report,
 * the dashboard cost roll-ups) can detect a snapshot boundary.
 *
 * Sources and dates of the published numbers below are noted inline so the
 * table is auditable. Update both the entry and the corresponding source
 * comment if a provider changes their rate card.
 */
import { ElizaError } from "../../errors";
import { isLocalProvider as isLocalProviderName } from "../../runtime/action-model-routing";
import { readEnv } from "../../utils/read-env";
import type {
	TokenUsageForCost,
	TrajectoryRuntimeLogger,
} from "./pricing-types";

export type { TokenUsageForCost } from "./pricing-types";

/**
 * Stable identifier for the on-disk price table snapshot.
 *
 * Bump the date suffix every time any rate in `MODEL_PRICES_USD_PER_M_TOKENS`
 * changes. The recorder writes this id alongside the per-step `cost_usd`
 * so consumers can disambiguate cost numbers computed against different
 * snapshots.
 */
export const PRICE_TABLE_ID = "eliza-v1-2026-09-04" as const;
export type PriceTableId = typeof PRICE_TABLE_ID;

/**
 * Provider name as recorded on the trajectory step. Drives the local-tier
 * default (Ollama / LM Studio / llama.cpp report cost 0 with no warning).
 */
export type ProviderName =
	| "anthropic"
	| "openai"
	| "google"
	| "groq"
	| "cerebras"
	| "eliza-cloud"
	| "ollama"
	| "lm-studio"
	| "llama.cpp"
	| "local"
	| "unknown";

export interface ModelPriceUsdPerMTokens {
	/** Provider that publishes this rate card. */
	provider: ProviderName;
	/** USD per 1M input tokens (non-cached prompt). */
	input: number;
	/** USD per 1M output (completion) tokens. */
	output: number;
	/**
	 * USD per 1M tokens served from cache. 0 means the provider does not
	 * publish a separate cache-read rate — `computeCallCostUsd` falls back to
	 * the regular input rate.
	 */
	cacheRead: number;
	/**
	 * USD per 1M tokens written into cache (Anthropic's surcharge on top of
	 * the regular input cost). 0 means no surcharge — fallback to input rate.
	 */
	cacheWrite: number;
}

/**
 * Per-model price table. Keys are the canonical family name; the lookup
 * helper performs a longest-prefix match so versioned ids
 * (e.g. `claude-haiku-4-5-20251001`) resolve to the family entry.
 *
 * Pricing comments cite the source page and the date the number was
 * captured from. Update both when bumping `PRICE_TABLE_ID`.
 */
export const MODEL_PRICES_USD_PER_M_TOKENS: Record<
	string,
	ModelPriceUsdPerMTokens
> = {
	// ---- Anthropic ----------------------------------------------------------
	// Source: https://platform.claude.com/docs/en/about-claude/models/overview
	// + https://platform.claude.com/docs/en/pricing (captured 2026-07-02).
	// Opus-tier is $5/$25 per MTok; cacheRead is 0.1x input, cacheWrite is
	// 1.25x input (5-minute TTL) per the published prompt-caching multipliers.
	"claude-opus-4-8": {
		provider: "anthropic",
		input: 5.0,
		output: 25.0,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	"claude-opus-4-7": {
		provider: "anthropic",
		input: 5.0,
		output: 25.0,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	},
	// Sonnet 5 sticker rate is $3/$15 per MTok (an introductory $2/$10 runs
	// through 2026-08-31; we bill the standard tier — see the pricing page).
	"claude-sonnet-5": {
		provider: "anthropic",
		input: 3.0,
		output: 15.0,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-sonnet-4-6": {
		provider: "anthropic",
		input: 3.0,
		output: 15.0,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-haiku-4-5": {
		provider: "anthropic",
		input: 1.0,
		output: 5.0,
		cacheRead: 0.1,
		cacheWrite: 1.25,
	},

	// ---- OpenAI -------------------------------------------------------------
	// Source: https://openai.com/api/pricing (captured 2026-05-11)
	"gpt-5.5": {
		provider: "openai",
		input: 1.25,
		output: 10.0,
		cacheRead: 0.125,
		cacheWrite: 0,
	},
	"gpt-5.5-mini": {
		provider: "openai",
		input: 0.25,
		output: 2.0,
		cacheRead: 0.025,
		cacheWrite: 0,
	},

	// ---- Google -------------------------------------------------------------
	// Source: https://ai.google.dev/pricing (captured 2026-05-11).
	// Gemini 2.5 Pro published rate is $1.25/M input ($2.50 above 200k tokens)
	// and $10/M output. We bill the standard tier; long-context premium is
	// tracked separately if a downstream consumer needs it.
	"gemini-2.5-pro": {
		provider: "google",
		input: 1.25,
		output: 10.0,
		cacheRead: 0.31,
		cacheWrite: 0,
	},
	"gemini-2.5-flash": {
		provider: "google",
		input: 0.3,
		output: 2.5,
		cacheRead: 0.075,
		cacheWrite: 0,
	},

	// ---- Groq ---------------------------------------------------------------
	// Source: https://groq.com/pricing (captured 2026-05-11). Groq publishes
	// per-model rates; numbers below are the Llama-3.3-70B and Llama-3.1-8B
	// production endpoints.
	"llama-3.3-70b-versatile": {
		provider: "groq",
		input: 0.59,
		output: 0.79,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"llama-3.1-8b-instant": {
		provider: "groq",
		input: 0.05,
		output: 0.08,
		cacheRead: 0,
		cacheWrite: 0,
	},

	// ---- Cerebras -----------------------------------------------------------
	// Qwen source: https://inference-docs.cerebras.ai/models/qwen-3.8-27b
	// (captured 2026-09-04). Published paid-tier rates; no separate cache rate.
	"qwen-3.8-27b": {
		provider: "cerebras",
		input: 0.99,
		output: 1.49,
		cacheRead: 0,
		cacheWrite: 0,
	},
	// Source: https://api.cerebras.ai/public/v1/models/{model_id} (captured
	// 2026-08-14). These rates also match the forced Cerebras rows used by the
	// cloud billing ledger in packages/cloud/shared.
	"gpt-oss-120b": {
		provider: "cerebras",
		input: 0.35,
		output: 0.75,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"gemma-4-31b": {
		provider: "cerebras",
		input: 0.99,
		output: 1.49,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"zai-glm-4.7": {
		provider: "cerebras",
		input: 2.25,
		output: 2.75,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"llama-3.3-70b": {
		provider: "cerebras",
		input: 0.85,
		output: 1.2,
		cacheRead: 0,
		cacheWrite: 0,
	},

	// ---- Eliza Cloud --------------------------------------------------------
	// Source: internal price card (captured 2026-05-11). Eliza Cloud passes
	// through Anthropic + OpenAI inventory at a published markup; the table
	// below reflects the customer-facing rate for the two ship targets.
	// When a different upstream model is routed via the elizacloud provider,
	// the provider tag stays "eliza-cloud" and the model id determines the
	// rate (longest-prefix match still resolves the Anthropic/OpenAI key).
	"eliza-cloud-opus": {
		provider: "eliza-cloud",
		input: 18.0,
		output: 90.0,
		cacheRead: 1.8,
		cacheWrite: 22.5,
	},
	"eliza-cloud-sonnet": {
		provider: "eliza-cloud",
		input: 3.6,
		output: 18.0,
		cacheRead: 0.36,
		cacheWrite: 4.5,
	},

	// ---- Local (zero cost) --------------------------------------------------
	// Ollama / LM Studio / llama.cpp run on user hardware — no metered cost.
	// Listed explicitly so `lookupModelPrice` returns a known-zero entry
	// instead of warning on common local model ids.
	ollama: {
		provider: "ollama",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"lm-studio": {
		provider: "lm-studio",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"llama.cpp": {
		provider: "llama.cpp",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
};

/**
 * Per-model maximum input context window, in tokens.
 *
 * Used by `buildModelInputBudget` when the caller does not pass an explicit
 * `contextWindowTokens` — letting the compaction planner size its budget to
 * the actual model ceiling instead of a one-size-fits-all default.
 *
 * Numbers reflect the smallest documented input-context limit per family,
 * captured from the provider's docs as of 2026-05-11. A few providers
 * advertise larger windows on specific tiers; using the conservative
 * number gives a safety margin and avoids per-tier lookup that we cannot
 * resolve at compaction-decision time.
 *
 * This table SHOULD line up with `MODEL_PRICES_USD_PER_M_TOKENS` keys, but
 * does not have to be a strict superset/subset: the price table sometimes
 * carries a model under a provider's naming convention (e.g. Groq's
 * `llama-3.3-70b-versatile`) while the same family appears in the window
 * table under a different vendor's name (Cerebras's `llama3.1-8b`). When
 * adding entries, prefer the canonical id the provider returns from
 * `GET /v1/models` rather than aliasing — the lookup helper's substring
 * fallback keeps the two tables interoperable for versioned ids without
 * forcing every alias to be enumerated.
 *
 * Local-tier entries are omitted on purpose: callers building a budget for
 * an Ollama / LM Studio / llama.cpp / local provider should pass an
 * explicit `contextWindowTokens` for the loaded GGUF, since the actual
 * window varies per-file.
 */
export const MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
	// ---- Anthropic ----------------------------------------------------------
	// Source: https://platform.claude.com/docs/en/about-claude/models/overview
	// (captured 2026-07-02). Opus 4.7+, Sonnet 4.6, and Sonnet 5 ship a 1M
	// input context window at standard pricing; Haiku 4.5 remains 200k.
	"claude-opus-4-8": 1_000_000,
	"claude-opus-4-7": 1_000_000,
	"claude-sonnet-5": 1_000_000,
	"claude-sonnet-4-6": 1_000_000,
	"claude-haiku-4-5": 200_000,

	// ---- OpenAI -------------------------------------------------------------
	// Source: https://platform.openai.com/docs/models (captured 2026-05-11)
	"gpt-5.5": 200_000,
	"gpt-5.5-mini": 128_000,

	// ---- Google -------------------------------------------------------------
	// Source: https://ai.google.dev/gemini-api/docs/models (captured 2026-05-11)
	"gemini-2.5-pro": 1_048_576,
	"gemini-2.5-flash": 1_048_576,

	// ---- Cerebras -----------------------------------------------------------
	// Source: api.cerebras.ai/v1 self-reported limits (`context_length_exceeded`
	// body cites the per-model ceiling). Captured 2026-05-11.
	"gpt-oss-120b": 131_000,
	// Source: https://inference-docs.cerebras.ai/models/gemma-4-31b +
	// live API probe (captured 2026-07-02): a 140k-token prompt returns
	// `context_length_exceeded ... limit is 131072`, and the `context_length`
	// request param is rejected (`property 'context_length' is unsupported`) —
	// so 131072 is the hard, non-extensible ceiling on the paid tier. (The
	// model card's larger figure is not what Cerebras serves; the public free
	// tier caps at 65k.)
	"gemma-4-31b": 131_072,
	// Paid-tier serving limit; Free Trial is 65,536. Operators on the free
	// tier can declare the lower ceiling via MODEL_CONTEXT_WINDOWS_JSON.
	// Source: https://inference-docs.cerebras.ai/models/qwen-3.8-27b (2026-09-04).
	"qwen-3.8-27b": 131_072,
	"qwen-3-235b-a22b-instruct-2507": 64_000,
	"zai-glm-4.7": 131_000,
	"llama3.1-8b": 32_000,

	// ---- Groq ---------------------------------------------------------------
	// Source: https://console.groq.com/docs/models (captured 2026-05-11)
	"openai/gpt-oss-120b": 131_000,
	"llama-3.3-70b-versatile": 131_000,
	"llama-3.1-8b-instant": 131_000,
};

/**
 * Operator-supplied table overrides, read from the environment.
 *
 * New model ids ship faster than this file. Rather than forcing a code change
 * (and a release) to price or size a model we have not enumerated yet,
 * operators can supply per-id entries via two env vars:
 *
 *   - `MODEL_PRICES_JSON` — JSON object mapping model id → price entry:
 *     `{"my-model": {"input": 5, "output": 25, "cacheRead": 0.5,
 *     "cacheWrite": 6.25, "provider": "anthropic"}}`. `input` and `output`
 *     (USD per 1M tokens) are required; `cacheRead` / `cacheWrite` default
 *     to 0 (= bill at the input rate, matching the static-table convention)
 *     and `provider` defaults to `"unknown"`.
 *   - `MODEL_CONTEXT_WINDOWS_JSON` — JSON object mapping model id → context
 *     window in tokens: `{"my-model": 1000000}`.
 *
 * Overrides are merged BEFORE the static tables in both lookups, so an env
 * entry wins over a static entry with the same key and env keys participate
 * in the same longest-substring fallback as static keys. Malformed documents
 * and entries fail fast so a broken operator override cannot silently fall back
 * to a different price or context window.
 *
 * Parses are memoized per raw env string so hot-path lookups stay cheap while
 * tests (and long-lived processes with mutated env) still observe changes.
 */
interface EnvOverrideCache<T> {
	raw: string | undefined;
	value: Record<string, T>;
}

function parseJsonObject(
	raw: string | undefined,
	envName: string,
): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		throw new ElizaError(`${envName} must be a JSON object`, {
			code: "INVALID_TRAJECTORY_PRICING_OVERRIDE",
			context: { envName },
		});
	} catch (error) {
		// error-policy:J2 Environment overrides are operator-controlled data; retain
		// the parser cause and prevent an invalid override from looking unapplied.
		if (error instanceof ElizaError) throw error;
		throw new ElizaError(`${envName} is not valid JSON`, {
			code: "INVALID_TRAJECTORY_PRICING_OVERRIDE",
			cause: error,
			context: { envName },
		});
	}
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

let priceOverridesCache: EnvOverrideCache<ModelPriceUsdPerMTokens> | null =
	null;

function getPriceOverrides(): Record<string, ModelPriceUsdPerMTokens> {
	const raw = readEnv("MODEL_PRICES_JSON");
	if (priceOverridesCache && priceOverridesCache.raw === raw) {
		return priceOverridesCache.value;
	}
	const value: Record<string, ModelPriceUsdPerMTokens> = {};
	const parsed = parseJsonObject(raw, "MODEL_PRICES_JSON");
	if (parsed) {
		for (const [modelId, entry] of Object.entries(parsed)) {
			const record =
				entry && typeof entry === "object" && !Array.isArray(entry)
					? (entry as Record<string, unknown>)
					: null;
			if (
				!record ||
				!isNonNegativeFinite(record.input) ||
				!isNonNegativeFinite(record.output)
			) {
				throw new ElizaError(
					"MODEL_PRICES_JSON entry needs numeric input and output rates",
					{
						code: "INVALID_TRAJECTORY_PRICING_OVERRIDE",
						context: { envName: "MODEL_PRICES_JSON", modelId },
					},
				);
			}
			value[modelId] = {
				provider:
					typeof record.provider === "string"
						? (record.provider as ProviderName)
						: "unknown",
				input: record.input,
				output: record.output,
				cacheRead: isNonNegativeFinite(record.cacheRead) ? record.cacheRead : 0,
				cacheWrite: isNonNegativeFinite(record.cacheWrite)
					? record.cacheWrite
					: 0,
			};
		}
	}
	priceOverridesCache = { raw, value };
	return value;
}

let contextWindowOverridesCache: EnvOverrideCache<number> | null = null;

function getContextWindowOverrides(): Record<string, number> {
	const raw = readEnv("MODEL_CONTEXT_WINDOWS_JSON");
	if (contextWindowOverridesCache && contextWindowOverridesCache.raw === raw) {
		return contextWindowOverridesCache.value;
	}
	const value: Record<string, number> = {};
	const parsed = parseJsonObject(raw, "MODEL_CONTEXT_WINDOWS_JSON");
	if (parsed) {
		for (const [modelId, tokens] of Object.entries(parsed)) {
			if (!isNonNegativeFinite(tokens) || tokens < 1) {
				throw new ElizaError(
					"MODEL_CONTEXT_WINDOWS_JSON entry needs a positive token count",
					{
						code: "INVALID_TRAJECTORY_PRICING_OVERRIDE",
						context: { envName: "MODEL_CONTEXT_WINDOWS_JSON", modelId },
					},
				);
			}
			value[modelId] = Math.floor(tokens);
		}
	}
	contextWindowOverridesCache = { raw, value };
	return value;
}

/** Merge env overrides over a static table (env wins on key conflicts). */
function withOverrides<T>(
	table: Record<string, T>,
	overrides: Record<string, T>,
): Record<string, T> {
	return Object.keys(overrides).length === 0
		? table
		: { ...table, ...overrides };
}

/**
 * Result of a context-window lookup. Carries the matched table key so callers
 * can surface "matched as family X" diagnostics if needed — mirrors
 * `PriceLookupResult`.
 */
export interface ContextWindowLookupResult {
	matchedKey: string;
	contextWindowTokens: number;
}

/**
 * Look up the documented input-context window for a model name.
 *
 * Returns null when the model has no entry — callers should fall back to
 * `DEFAULT_CONTEXT_WINDOW_TOKENS` (see `runtime/model-input-budget`) or to
 * a provider-supplied number.
 *
 * Matching strategy (parallel to `lookupModelPrice`):
 *   1. exact key match
 *   2. longest-key **substring** match — every table key whose
 *      lowercased form appears anywhere in the lowercased model name is
 *      a candidate, and the longest such key wins. This handles
 *      versioned ids like `claude-haiku-4-5-20251001` (resolves to
 *      `claude-haiku-4-5`) and provider prefixes like `openai/gpt-5.5`
 *      (resolves to `gpt-5.5`) uniformly. The substring fallback is
 *      permissive by design: an adversarial / synthetic id such as
 *      `acme-gpt-oss-120b-finetune` would also match the `gpt-oss-120b`
 *      entry, which is the right answer when the finetune inherits its
 *      parent's context window — and a safe under-estimate otherwise.
 */
export function lookupModelContextWindow(
	modelName: string | undefined,
): ContextWindowLookupResult | null {
	if (!modelName) return null;
	const table = withOverrides(
		MODEL_CONTEXT_WINDOW_TOKENS,
		getContextWindowOverrides(),
	);
	const exact = table[modelName];
	if (typeof exact === "number") {
		return { matchedKey: modelName, contextWindowTokens: exact };
	}

	const normalized = modelName.toLowerCase();
	const candidates = Object.keys(table)
		.filter((k) => normalized.includes(k.toLowerCase()))
		.sort((a, b) => b.length - a.length);
	const match = candidates[0];
	if (!match) return null;
	const tokens = table[match];
	if (typeof tokens !== "number") return null;
	return { matchedKey: match, contextWindowTokens: tokens };
}

/**
 * Whether a provider counts as local-tier for pricing (cost 0 with no
 * missing-price warning). Local inference is a real zero, not a missing price
 * — per AGENTS.md: "cost=0 for local is a real zero (not 'missing'). No
 * fallback that masks."
 *
 * Delegates to the shared name heuristic in action-model-routing so pricing no
 * longer maintains its own drifting provider list (see #12635 / #12090 item 7).
 * When a caller has the provider-declared `local` capability flag it should
 * pass it via `localCapability`, which is authoritative over the name guess.
 */
function isLocalTierProvider(
	provider: string | undefined,
	localCapability?: boolean,
): boolean {
	if (typeof localCapability === "boolean") {
		return localCapability;
	}
	if (!provider) return false;
	return isLocalProviderName(provider);
}

/**
 * Result of a price lookup. Carries the matched table key so callers can
 * surface "matched as family X" diagnostics if needed.
 */
export interface PriceLookupResult {
	matchedKey: string;
	price: ModelPriceUsdPerMTokens;
}

/**
 * Look up the price entry for a model name. Returns null when the model is
 * unknown.
 *
 * Falls back to the longest-prefix family-key match when an exact key is
 * missing — adapters often emit a versioned id
 * (e.g. `claude-haiku-4-5-20251001`) where the table only stores the
 * family key (`claude-haiku-4-5`).
 */
export function lookupModelPrice(
	modelName: string | undefined,
): PriceLookupResult | null {
	if (!modelName) return null;
	const table = withOverrides(
		MODEL_PRICES_USD_PER_M_TOKENS,
		getPriceOverrides(),
	);
	const exact = table[modelName];
	if (exact) return { matchedKey: modelName, price: exact };

	const normalized = modelName.toLowerCase();
	const candidates = Object.keys(table)
		.filter((k) => normalized.includes(k.toLowerCase()))
		.sort((a, b) => b.length - a.length);
	const match = candidates[0];
	if (!match) return null;
	const price = table[match];
	if (!price) return null;
	return { matchedKey: match, price };
}

/**
 * Compute the USD cost of a single LLM call.
 *
 * Returns `undefined` when usage or hosted-model pricing is unavailable. A
 * known local tier (Ollama / LM Studio / llama.cpp / "local") returns a real
 * zero because no hosted inference charge exists.
 *
 * When the model is unknown and the provider is *not* local, the optional
 * `logger.warn` is invoked once per call. Callers in hot paths can pass
 * `logger: undefined` to suppress noise.
 *
 * `promptTokens` is treated as INCLUSIVE of the cache counts: the non-cached
 * portion is `promptTokens - cacheRead - cacheWrite`, clamped at 0.
 *
 * Each portion is then billed exactly once:
 * - non-cached input at `input`;
 * - cache-read tokens at `cacheRead`, or at `input` when `cacheRead` is 0 or
 *   unset (a provider with no separate cache-read price bills them as input);
 * - cache-creation tokens at `cacheWrite`, or at `input` under the same rule.
 *
 * `cacheWrite` is a FULL rate, not a surcharge added to `input` — Anthropic's
 * cache-write entries are 1.25x their input rate, so billing a cache-creation
 * token at both `input` and `cacheWrite` would overcharge it by 1.8x.
 */
export function computeCallCostUsd(
	modelName: string | undefined,
	usage: TokenUsageForCost | undefined,
	options: {
		provider?: string;
		/**
		 * Provider-declared `local` capability (`ModelRegistrationMetadata.local`),
		 * when the caller has it. Authoritative over the provider-name heuristic.
		 */
		local?: boolean;
		logger?: TrajectoryRuntimeLogger;
	} = {},
): number | undefined {
	if (!usage) return undefined;
	const tokenValues = [
		usage.promptTokens,
		usage.completionTokens,
		usage.cacheReadInputTokens,
		usage.cacheCreationInputTokens,
		usage.totalTokens,
	];
	if (!tokenValues.some((value) => typeof value === "number")) return undefined;

	const provider = options.provider?.toLowerCase().trim();
	const isLocalProvider = isLocalTierProvider(provider, options.local);
	if (isLocalProvider) return 0;

	const lookup = lookupModelPrice(modelName);
	if (!lookup) {
		options.logger?.warn?.(
			{
				modelName: modelName ?? "(undefined)",
				provider: provider ?? "(unknown)",
				priceTableId: PRICE_TABLE_ID,
			},
			"[pricing] no price entry — cost_usd omitted",
		);
		return undefined;
	}

	const { price } = lookup;
	const cacheRead = usage.cacheReadInputTokens ?? 0;
	const cacheWrite = usage.cacheCreationInputTokens ?? 0;
	const totalPrompt = usage.promptTokens ?? 0;
	const nonCachedInput = Math.max(0, totalPrompt - cacheRead - cacheWrite);
	const completion = usage.completionTokens ?? 0;

	const inputCost = (nonCachedInput / 1_000_000) * price.input;
	const cacheReadRate =
		price.cacheRead !== undefined && price.cacheRead > 0
			? price.cacheRead
			: price.input;
	const cacheWriteRate =
		price.cacheWrite !== undefined && price.cacheWrite > 0
			? price.cacheWrite
			: price.input;
	const cacheReadCost = (cacheRead / 1_000_000) * cacheReadRate;
	const cacheWriteCost = (cacheWrite / 1_000_000) * cacheWriteRate;
	const outputCost = (completion / 1_000_000) * price.output;

	return inputCost + cacheReadCost + cacheWriteCost + outputCost;
}

/**
 * Whether the provided provider tag is a known local-tier inference target.
 * Used by the recorder to suppress the missing-model warning when a user
 * runs entirely on local hardware.
 */
export function isLocalProvider(
	provider: string | undefined,
	localCapability?: boolean,
): boolean {
	return isLocalTierProvider(provider?.toLowerCase().trim(), localCapability);
}
