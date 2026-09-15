/**
 * Outbound message creation and send logic used by `DiscordService` — builds
 * and dispatches replies to Discord (content, attachments, chunking, pairing
 * gate) and maps interaction URLs into the outgoing payload.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	type ChannelType,
	type Content,
	ContentType,
	createUniqueUuid,
	type EventPayload,
	EventType,
	type FetchedDocumentUrl as FetchedKnowledgeUrl,
	fetchDocumentFromUrl,
	type HandlerCallback,
	type IAgentRuntime,
	isInAllowlist,
	lifeOpsPassiveConnectorsEnabled,
	type Media,
	type Memory,
	MemoryType,
	parseBooleanValue,
	type SendHandlerPersistenceFailure,
	type SendHandlerReceipt,
	type Service,
	ServiceType,
	stringToUuid,
	TurnAbortedError,
	toWellFormedUnicode,
	truncateWellFormed,
	type UUID,
} from "@elizaos/core";
import {
	type ActionRowBuilder,
	type AttachmentBuilder,
	type Channel,
	type Client,
	ChannelType as DiscordChannelType,
	type Message as DiscordMessage,
	type MessageActionRowComponentBuilder,
	type TextChannel,
} from "discord.js";
import { isDiscordUserAddressed } from "./addressing";
import { AttachmentManager } from "./attachments";
// See service.ts for detailed documentation on Discord ID handling.
// Key point: Discord snowflake IDs (e.g., "1253563208833433701") are NOT valid UUIDs.
// Use stringToUuid() to convert them, not asUUID() which would throw an error.
import type { ICompatRuntime } from "./compat";
import { checkDiscordDmAccess } from "./dm-access";
import { createDraftStreamController } from "./draft-stream";
import { getDiscordSettings } from "./environment";
import {
	type CoordinationScope,
	claimSpeakerLease,
	createDiscordContenderToken,
	DISCORD_COORDINATION_AUDIT_SCOPE,
	deterministicCoordinationNonce,
	deterministicDiscordNonce,
	emitCoordinationReceipt,
	evaluateEdgeCurrency,
	type GroupCoordinationConfig,
	getGroupCoordinationConfig,
	rearmSweptCoordinationSlot,
	reconcileDiscordDelivery,
	recordDiscordHumanEdge,
	registerCoordinationTrustMember,
	releaseSpeakerLease,
	renewSpeakerLease,
	requireCoordinationScope,
	type SpeakerLease,
	shouldSuppressBotReply,
	sweepExpiredCoordinationSlots,
	verifySpeakerLease,
} from "./group-coordination";
import {
	buildDiscordWorldMetadata,
	isAliasedDiscordEntityId,
} from "./identity";
import { formatInboundEnvelope } from "./inbound-envelope";
import { buildDiscordReplyPayload } from "./interactions";
import {
	appendCoalescedDiscordMetadata,
	type DiscordMessageWithCoalescedMetadata,
} from "./message-coalesce";
import { chunkDiscordText } from "./messaging";
import { waitForDiscordIngressReadiness } from "./readiness";
import {
	applyDiscordStalenessGuard,
	type DiscordStalenessConfig,
	getDiscordChannelMessageSequence,
	getDiscordStalenessConfig,
} from "./staleness";
import {
	createStatusReactionController,
	type StatusReactionController,
	type StatusReactionScope,
	shouldShowStatusReaction,
} from "./status-reactions";
import {
	claimDiscordTurn,
	type DiscordTurnRecord,
	decideResume,
	findDeliveredReply,
	markDiscordTurnDispatched,
	markDiscordTurnFailed,
	markDiscordTurnReplied,
} from "./turn-state";
import {
	DiscordEventTypes,
	type DiscordSettings,
	type IDiscordService,
	type JsonObject,
	type JsonValue,
} from "./types";
import { createTypingController } from "./typing";
import {
	buildDiscordComponents,
	buildOutboundDiscordAttachment,
	canSendMessage,
	extractUrls,
	getMessageService,
	getMessagingAPI,
	MAX_MESSAGE_LENGTH,
	normalizeDiscordMessageText,
	sendMessageInChunks,
} from "./utils";

export const INTERACTION_ONLY_FALLBACK_TEXT = "Choose an option:";

// Filler tokens carrying no answer content — two single-fact replies differing
// only in these words are the same fact reworded.
const NUMERIC_FACT_STOPWORDS = new Set<string>([
	"the",
	"is",
	"are",
	"was",
	"at",
	"of",
	"to",
	"in",
	"on",
	"for",
	"it",
	"its",
	"that",
	"this",
	"and",
	"currently",
	"current",
	"now",
	"right",
	"about",
	"approximately",
	"around",
	"price",
	"priced",
	"cost",
	"costs",
	"value",
	"trading",
	"worth",
	"usd",
	"dollars",
]);

// Only guard short single-fact replies; longer output can restate context while
// adding new information.
const NUMERIC_FACT_MAX_LEN = 160;

/**
 * Significant tokens of a short numeric single-fact reply (a number plus its
 * subject), or null when the reply is long or carries no number. Two replies
 * whose token sets are in a subset relationship are the same fact reworded —
 * the tool-turn double where an action relays the raw value ("$61,883 USD") and
 * the planner restates it as a sentence ("Bitcoin is currently priced at
 * $61,883 USD"). The connector is the one point every delivery converges, so
 * catching it here covers the multiple independent runtime delivery paths that
 * #15601's exact-text reservation cannot (the two texts differ). Conservative:
 * requires a number, so only single-fact answers (prices, counts, temps) are
 * ever collapsed; additive replies carry new numbers/entities and pass.
 */
export function numericFactSignatureTokens(text: string): Set<string> | null {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > NUMERIC_FACT_MAX_LEN)
		return null;
	const tokens = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9., ]+/g, " ")
		.split(/\s+/)
		.map((token) => token.replace(/^[.,]+/, "").replace(/[.,]+$/, ""))
		.filter(
			(token) =>
				token.length > 0 &&
				(/[0-9]/.test(token) || token.length >= 4) &&
				!NUMERIC_FACT_STOPWORDS.has(token),
		);
	const set = new Set(tokens);
	const hasNumber = [...set].some((token) => /[0-9]/.test(token));
	return hasNumber && set.size > 0 ? set : null;
}

/** Maximum UTF-16 code units of message text carried in a suppression log. */
const DUPLICATE_TEXT_PREVIEW_LIMIT = 200;

/**
 * Collapses external message text into a bounded log preview. Discord text is
 * untrusted and may already carry lone surrogates, and a plain slice can split
 * an astral pair, so the value is repaired and truncated on code-point
 * boundaries before it reaches the logger. This is a preview only; the complete
 * text is never replaced by it.
 */
export function buildDuplicateTextPreview(text: string): string {
	return truncateWellFormed(
		toWellFormedUnicode(text.replace(/\s+/g, " ").trim()),
		DUPLICATE_TEXT_PREVIEW_LIMIT,
	);
}

export function isSubsetOrEqual(a: Set<string>, b: Set<string>): boolean {
	for (const token of a) if (!b.has(token)) return false;
	return true;
}

export function resolveGenerationTimeoutMs(
	timeoutSetting: unknown,
	fallbackSetting: unknown,
	mediaGenerationTimeoutSetting?: unknown,
): number | null {
	const hasExplicitDiscordTimeout =
		timeoutSetting !== undefined &&
		timeoutSetting !== null &&
		String(timeoutSetting).trim() !== "";

	const parsed = Number.parseInt(
		String(timeoutSetting ?? fallbackSetting ?? "120000"),
		10,
	);
	let base: number | null;
	if (!Number.isFinite(parsed)) {
		base = 120_000;
	} else {
		base = parsed > 0 ? Math.max(30_000, parsed) : null;
	}

	if (hasExplicitDiscordTimeout || base === null) {
		return base;
	}

	const mediaParsed = Number.parseInt(
		String(mediaGenerationTimeoutSetting ?? ""),
		10,
	);
	if (!Number.isFinite(mediaParsed) || mediaParsed <= 0) {
		return base;
	}
	return Math.max(base, Math.max(30_000, mediaParsed));
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

function compactJsonObject(record: Record<string, unknown>): JsonObject {
	const json: JsonObject = {};
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) continue;
		if (isJsonValue(value)) {
			json[key] = value;
		}
	}
	return json;
}

function normalizeReplyToMode(
	replyToMode: DiscordSettings["replyToMode"],
): "off" | "first" | "all" {
	if (replyToMode === "off" || replyToMode === "all") {
		return replyToMode;
	}

	return "first";
}

function getAddressingContent(message: DiscordMessage): string {
	return (
		(message as DiscordMessageWithCoalescedMetadata)
			.__discordAddressingContent ?? message.content
	);
}

function fetchedUrlToAttachment(
	url: string,
	fetched: FetchedKnowledgeUrl,
): Media {
	const hasReadableText = fetched.contentType !== "binary";
	return {
		id: webpageAttachmentId(url),
		url,
		title: fetched.filename || "Web Page",
		source: fetched.contentType === "transcript" ? "YouTube" : "Web",
		text: hasReadableText ? fetched.content : "",
		contentType: ContentType.LINK,
	};
}

function webpageAttachmentId(url: string): string {
	return `webpage-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

const ACTIVE_TASK_AGENT_STATUSES = new Set([
	"active",
	"blocked",
	"tool_running",
]);
const DISCORD_OUTBOUND_DEDUPE_WINDOW_MS = 2000;
const DISCORD_OUTBOUND_DEDUPE_MAX_KEYS = 512;

export type DiscordOutboundSettledDelivery =
	| {
			kind: "settled";
			delivery: "delivered" | "partially_delivered";
			receipt: SendHandlerReceipt;
	  }
	| { kind: "released" };

export type DiscordOutboundDeliveryState =
	| {
			status: "in_flight";
			startedAt: number;
			settlement: Promise<DiscordOutboundSettledDelivery>;
	  }
	| {
			status: "settled";
			settledAt: number;
			delivery: "delivered" | "partially_delivered";
			receipt: SendHandlerReceipt;
	  };

const recentOutboundDiscordDeliveries = new Map<
	string,
	DiscordOutboundDeliveryState
>();

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringField(
	record: Record<string, unknown> | null,
	field: string,
): string | undefined {
	const value = record?.[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasSqlExecutor(runtime: ICompatRuntime): boolean {
	const candidate = runtime as ICompatRuntime & {
		db?: { execute?: unknown };
		adapter?: { db?: { execute?: unknown } };
	};
	return (
		typeof candidate.db?.execute === "function" ||
		typeof candidate.adapter?.db?.execute === "function"
	);
}

export function hasActiveTaskAgentWorkForMessage(
	runtime: Pick<IAgentRuntime, "getService">,
	messageId: string,
): boolean {
	try {
		const coordinator = asRecord(runtime.getService("SWARM_COORDINATOR"));
		const tasks = coordinator?.tasks;
		if (!(tasks instanceof Map)) {
			return false;
		}

		for (const taskValue of tasks.values()) {
			const task = asRecord(taskValue);
			const status = stringField(task, "status");
			if (!status || !ACTIVE_TASK_AGENT_STATUSES.has(status)) {
				continue;
			}

			const metadata = asRecord(task?.originMetadata);
			const originMessageId = stringField(metadata, "messageId");
			if (originMessageId === messageId) {
				return true;
			}
		}
	} catch {
		return false;
	}

	return false;
}

export function shouldSuppressTimeoutForInFlightDispatchForTests({
	generationTimedOut,
	responseDispatchInFlight,
}: {
	generationTimedOut: boolean;
	responseDispatchInFlight: boolean;
}): boolean {
	return generationTimedOut && responseDispatchInFlight;
}

export interface DiscordOutboundDeliveryReservation {
	commit(
		delivery: "delivered" | "partially_delivered",
		receipt: SendHandlerReceipt,
		settledAt?: number,
	): void;
	release(): void;
}

export type BeginDiscordOutboundDeliveryResult =
	| {
			kind: "in_flight";
			settlement: Promise<DiscordOutboundSettledDelivery>;
	  }
	| {
			kind: "duplicate";
			priorDelivery: "delivered" | "partially_delivered";
			receipt: SendHandlerReceipt;
	  }
	| { kind: "deliver"; reservation: DiscordOutboundDeliveryReservation };

export interface DiscordOutboundDeliveryParams {
	accountId?: string;
	channelId: string;
	replyToMessageId?: string;
	text?: string;
	attachmentUrls?: readonly string[];
	interactionIdentity?: string;
	now?: number;
	windowMs?: number;
	state?: Map<string, DiscordOutboundDeliveryState>;
}

function normalizeOutboundText(text: string | undefined): string {
	return typeof text === "string"
		? text.replace(/\s+/g, " ").trim().toLowerCase()
		: "";
}

function outboundAttachmentIdentity(
	attachmentUrls: readonly string[] | undefined,
): string {
	return attachmentUrls?.filter(Boolean).sort().join(",") ?? "";
}

function pruneOutboundDedupeState(
	state: Map<string, DiscordOutboundDeliveryState>,
	now: number,
	windowMs: number,
): void {
	for (const [key, delivery] of state) {
		if (delivery.status === "settled" && now - delivery.settledAt > windowMs) {
			state.delete(key);
		}
	}
	if (state.size <= DISCORD_OUTBOUND_DEDUPE_MAX_KEYS) return;
	const settled = [...state.entries()]
		.filter(
			(
				entry,
			): entry is [
				string,
				Extract<
					DiscordOutboundDeliveryState,
					{
						status: "settled";
					}
				>,
			] => entry[1].status === "settled",
		)
		.sort((left, right) => left[1].settledAt - right[1].settledAt);
	const overflow = Math.max(0, state.size - DISCORD_OUTBOUND_DEDUPE_MAX_KEYS);
	for (const [key] of settled.slice(0, overflow)) {
		state.delete(key);
	}
}

/**
 * Reserve one outbound Discord delivery. Discord can receive the same logical
 * tool-backed answer through the inbound response callback and the generic
 * message-connector send path in the same event-loop burst. Callers join the
 * active attempt, then replay its exact receipt; only settled entries expire,
 * because aging out an active provider call would permit a concurrent resend.
 */
export function beginDiscordOutboundDelivery(
	params: DiscordOutboundDeliveryParams,
): BeginDiscordOutboundDeliveryResult {
	const text = normalizeOutboundText(params.text);
	const attachments = outboundAttachmentIdentity(params.attachmentUrls);
	const interactionIdentity = params.interactionIdentity?.trim() ?? "";
	if (!text && !attachments && !interactionIdentity) {
		return {
			kind: "deliver",
			reservation: {
				commit(
					_delivery: "delivered" | "partially_delivered",
					_receipt: SendHandlerReceipt,
				) {},
				release() {},
			},
		};
	}

	const now = params.now ?? Date.now();
	const windowMs = params.windowMs ?? DISCORD_OUTBOUND_DEDUPE_WINDOW_MS;
	const state = params.state ?? recentOutboundDiscordDeliveries;
	const key = [
		params.accountId ?? "default",
		params.channelId,
		params.replyToMessageId ?? "",
		attachments,
		interactionIdentity,
		text,
	].join("\u0000");

	pruneOutboundDedupeState(state, now, windowMs);
	const previous = state.get(key);
	if (previous?.status === "in_flight") {
		return { kind: "in_flight", settlement: previous.settlement };
	}
	if (previous?.status === "settled") {
		return {
			kind: "duplicate",
			priorDelivery: previous.delivery,
			receipt: previous.receipt,
		};
	}

	let resolveSettlement!: (value: DiscordOutboundSettledDelivery) => void;
	const settlement = new Promise<DiscordOutboundSettledDelivery>((resolve) => {
		resolveSettlement = resolve;
	});
	const reservationState: Extract<
		DiscordOutboundDeliveryState,
		{ status: "in_flight" }
	> = {
		status: "in_flight",
		startedAt: now,
		settlement,
	};
	state.set(key, reservationState);
	let settled = false;
	return {
		kind: "deliver",
		reservation: {
			commit(delivery, receipt, settledAt = Date.now()) {
				if (settled) return;
				settled = true;
				if (state.get(key) === reservationState) {
					state.delete(key);
					state.set(key, {
						status: "settled",
						settledAt,
						delivery,
						receipt,
					});
				}
				resolveSettlement({ kind: "settled", delivery, receipt });
			},
			release() {
				if (settled) return;
				settled = true;
				if (state.get(key) === reservationState) {
					state.delete(key);
				}
				resolveSettlement({ kind: "released" });
			},
		},
	};
}

function callbackPersistenceFailure(
	message: DiscordMessage,
	error: unknown,
): SendHandlerPersistenceFailure {
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: "DISCORD_CALLBACK_MEMORY_PERSISTENCE_FAILED";
	return {
		providerMessageId: message.id,
		stage: "memory",
		code,
		message: error instanceof Error ? error.message : String(error),
	};
}

function callbackDeliveryReceipt(input: {
	messages: readonly DiscordMessage[];
	memories: readonly Memory[];
	failures: readonly SendHandlerPersistenceFailure[];
}): SendHandlerReceipt {
	const ids = input.messages.map((message) => message.id);
	const first = ids[0];
	if (!first) {
		throw new Error(
			"Discord callback cannot build a receipt without a provider message.",
		);
	}
	const memoryIds = input.memories.flatMap((memory) =>
		memory.id ? [memory.id] : [],
	);
	return {
		providerMessageIds: [first, ...ids.slice(1)],
		acceptedAt:
			input.messages.find((message) =>
				Number.isFinite(message.createdTimestamp),
			)?.createdTimestamp ?? Date.now(),
		persistence:
			input.failures.length === 0
				? { status: "persisted", memoryIds }
				: memoryIds.length > 0
					? {
							status: "partial",
							memoryIds,
							failures: input.failures,
						}
					: { status: "failed", failures: input.failures },
	};
}

/**
 * Outcome of {@link runGenerationWithAbortableTimeout}.
 *
 * - `timedOut`   — the timeout won the race; the abort signal was fired.
 * - `settled`    — the generation promise fulfilled or rejected before the
 *                  timeout. When `timedOut` is true, `settled` reflects
 *                  whether the orphaned generation had ALREADY completed at
 *                  the moment the timeout fired (almost always `false`).
 * - `error`      — the rejection value when generation rejected on its own
 *                  (not a timeout). `undefined` on success or timeout.
 */
export interface AbortableTimeoutResult {
	timedOut: boolean;
	settled: boolean;
	error?: unknown;
}

/**
 * Reads core's designed TurnAbortedError contract. Both user cancellation and
 * runtime lifecycle shutdown use TURN_ABORTED, so callers preserve the reason
 * instead of misclassifying every designed abort as user-requested. Designed
 * aborts are control flow, not provider failures, and must not emit retry text.
 */
export function designedTurnAbortReason(error: unknown): string | null {
	if (error instanceof TurnAbortedError && error.reason.trim().length > 0) {
		return error.reason;
	}
	return null;
}

/**
 * Runs a single generation attempt against a wall-clock timeout, wiring an
 * {@link AbortController} so that a timeout ACTUALLY CANCELS the underlying
 * work instead of leaving it running as an orphan.
 *
 * Why this exists (the bug):
 * The previous Discord dispatch did `Promise.race([generationPromise,
 * timeoutPromise])` where `generationPromise` called
 * `messageService.handleMessage(runtime, message, callback)` with NO abort
 * signal. When the timeout won the race we set a `generationTimedOut` flag
 * and sent the "I timed out" reply — but the model call kept running,
 * burning tokens and (worse) racing to emit a late response into the same
 * room. The alternating "timeout / then instant" pattern is the classic
 * signature of an orphaned run that resolves late and poisons the next slot.
 *
 * The core message service ALREADY threads
 * `MessageProcessingOptions.abortSignal` → `StreamingContext.abortSignal` →
 * `runtime.useModel` (`params.signal ??= abortSignal`) → provider fetch
 * (see packages/core/src/services/message.ts and
 * message-handler-abort.test.ts). The only missing link was the connector
 * never CREATING a controller and never PASSING the signal down. This helper
 * closes that gap.
 *
 * Contract:
 * - `generate(signal)` MUST forward `signal` into the generation call so the
 *   abort actually propagates. The helper cannot enforce this — the call
 *   site is responsible for plumbing `{ abortSignal: signal }` through.
 * - On timeout: `controller.abort()` fires, `timedOut` is `true`, and the
 *   orphaned promise's eventual rejection is swallowed so it never surfaces
 *   as an unhandled rejection.
 * - `timeoutMs === null` disables the timeout entirely (media / long jobs);
 *   the generation is awaited to completion and no controller races it.
 *
 * @param generate  Callback receiving the abort signal; returns the
 *                  generation promise. Must forward the signal downstream.
 * @param timeoutMs Wall-clock budget in ms, or `null` to disable the timeout.
 * @returns         {@link AbortableTimeoutResult} describing how the race
 *                  resolved.
 */
export async function runGenerationWithAbortableTimeout(
	generate: (signal: AbortSignal) => Promise<unknown>,
	timeoutMs: number | null,
): Promise<AbortableTimeoutResult> {
	const controller = new AbortController();
	let settled = false;

	const generationPromise = Promise.resolve()
		.then(() => generate(controller.signal))
		.then(
			() => {
				settled = true;
				return { kind: "ok" as const };
			},
			(error: unknown) => {
				settled = true;
				return { kind: "error" as const, error };
			},
		);

	// Never let the orphaned generation surface as an unhandled rejection.
	// The `.then(onRejected)` above already converts rejection into a value,
	// but attach a defensive catch in case `generate` throws synchronously
	// off the microtask edge.
	void generationPromise.catch(() => {});

	if (timeoutMs === null) {
		const outcome = await generationPromise;
		return {
			timedOut: false,
			settled: true,
			...(outcome.kind === "error" ? { error: outcome.error } : {}),
		};
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
	});

	try {
		const winner = await Promise.race([generationPromise, timeoutPromise]);
		if (winner === "timeout") {
			// Timeout won: abort the underlying work so the orphaned run stops
			// burning tokens and cannot race a late response into the room.
			controller.abort();
			return { timedOut: true, settled };
		}
		return {
			timedOut: false,
			settled: true,
			...(winner.kind === "error" ? { error: winner.error } : {}),
		};
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

export async function createDiscordMessageMemoryOnce(
	runtime: Pick<
		IAgentRuntime,
		"agentId" | "createMemory" | "getMemoryById" | "logger"
	>,
	memory: Memory,
	context: {
		operation: string;
		platformMessageId?: string;
	} = { operation: "discord-message-persist" },
): Promise<Memory | null> {
	const result = await persistDiscordMessageMemoryOnce(
		runtime,
		memory,
		context,
	);
	return result.memory;
}

interface DiscordMessageMemoryPersistenceResult {
	memory: Memory;
	created: boolean;
}

async function persistDiscordMessageMemoryOnce(
	runtime: Pick<
		IAgentRuntime,
		"agentId" | "createMemory" | "getMemoryById" | "logger"
	>,
	memory: Memory,
	context: {
		operation: string;
		platformMessageId?: string;
	} = { operation: "discord-message-persist" },
): Promise<DiscordMessageMemoryPersistenceResult> {
	if (!memory.id) {
		const id = await runtime.createMemory(memory, "messages");
		return { memory: { ...memory, id }, created: true };
	}

	const existing = await runtime.getMemoryById(memory.id);
	if (existing) {
		runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: runtime.agentId,
				memoryId: memory.id,
				messageId: context.platformMessageId,
				operation: context.operation,
			},
			"Skipping duplicate Discord message memory",
		);
		return { memory: existing, created: false };
	}

	await runtime.createMemory(memory, "messages");
	return { memory, created: true };
}

/** Options handed to `User.send` when delivering a Discord DM reply. */
export interface DmSendOptions {
	content: string;
	files?: AttachmentBuilder[];
	components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/**
 * Build the option bag for a DM reply using the same widget rows as guild
 * sends. Discord supports action rows of buttons and string selects in DMs, so
 * the connector does not need a DM-specific fallback for the component types it
 * emits.
 *
 * `components`/`files` keys are omitted entirely when empty so we never send an
 * empty `components: []` (which Discord rejects) or an empty `files: []`.
 *
 * @param textContent - Prose to send (already normalized, may be the
 *   "Choose an option:" fallback when the reply is components-only).
 * @param files - Outbound attachments, if any.
 * @param components - Already-built discord.js action rows (from
 *   `buildDiscordComponents`), if any.
 */
export function buildDmSendOptions(
	textContent: string,
	files: AttachmentBuilder[],
	components: ActionRowBuilder<MessageActionRowComponentBuilder>[] | undefined,
): DmSendOptions {
	return {
		content: textContent,
		...(files.length > 0 ? { files } : {}),
		...(components && components.length > 0 ? { components } : {}),
	};
}

/** Minimal `User.send` surface needed to deliver a chunked DM reply. */
export interface DmSendTarget {
	send(options: DmSendOptions): Promise<DiscordMessage>;
}

/**
 * Deliver a DM reply through the same transport chunking as guild sends.
 *
 * Discord hard-caps message content at 2000 characters; a single
 * `user.send(...)` with a longer body (e.g. a multi-day recall digest) is
 * rejected outright, so the reply never arrives. This routes DM text through
 * `chunkDiscordText` — the fence-aware chunker every other outbound Discord
 * path already uses — with the shared 2,000-character provider budget
 * and sends the chunks sequentially so ordering is preserved.
 *
 * Attachments and interactive components ride the LAST chunk, mirroring
 * `sendMessageInChunks`, so widgets sit directly under the end of the answer.
 *
 * A components/files-only reply (no prose after trimming) still produces a
 * single send so those payloads are never dropped.
 */
export async function sendDmInChunks(
	user: DmSendTarget,
	textContent: string,
	files: AttachmentBuilder[],
	components: ActionRowBuilder<MessageActionRowComponentBuilder>[] | undefined,
): Promise<DiscordMessage[]> {
	const chunks =
		textContent.trim().length > 0
			? chunkDiscordText(textContent, { maxChars: MAX_MESSAGE_LENGTH })
			: [];
	if (chunks.length <= 1) {
		const content = chunks[0] ?? textContent;
		return [await user.send(buildDmSendOptions(content, files, components))];
	}
	const sent: DiscordMessage[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const isLast = i === chunks.length - 1;
		sent.push(
			await user.send(
				buildDmSendOptions(
					chunks[i],
					isLast ? files : [],
					isLast ? components : undefined,
				),
			),
		);
	}
	return sent;
}

/**
 * Class representing a Message Manager for handling Discord messages.
 */

export class MessageManager {
	private client: Client;
	private runtime: ICompatRuntime;
	private attachmentManager: AttachmentManager;
	private getChannelType: (channel: Channel) => Promise<ChannelType>;
	private discordSettings: DiscordSettings;
	private discordService: IDiscordService;
	private accountId: string;
	private statusReactionScope: StatusReactionScope;
	private readonly draftStreamFactory: typeof createDraftStreamController;
	private envelopeEnabled: boolean;
	private draftStreamingEnabled: boolean;
	private stalenessConfig: DiscordStalenessConfig;
	private groupCoordinationConfig: GroupCoordinationConfig;
	private readonly runtimeInstanceId: string;
	private readonly contenderToken: string;
	private coordinationSweeperHandle?: ReturnType<typeof setInterval>;
	private coordinationSweepInFlight = false;
	private recentlyProcessedMessageIds = new Map<string, number>();
	private static readonly PROCESSED_MESSAGE_TTL_MS = 2 * 60 * 1000;
	/**
	 * Constructor for a new instance of MessageManager.
	 * @param {IDiscordService} discordService - The Discord service instance.
	 * @param {ICompatRuntime} runtime - The agent runtime instance (with cross-core compat).
	 * @throws {Error} If the Discord client is not initialized
	 */
	constructor(
		discordService: IDiscordService,
		runtime: ICompatRuntime,
		options: {
			draftStreamFactory?: typeof createDraftStreamController;
		} = {},
	) {
		// Guard against null client - fail fast with a clear error
		if (!discordService.client) {
			const errorMsg =
				"Discord client not initialized - cannot create MessageManager";
			runtime.logger.error(
				{ src: "plugin:discord", agentId: runtime.agentId },
				errorMsg,
			);
			throw new Error(errorMsg);
		}

		this.client = discordService.client;
		this.runtime = runtime;
		this.draftStreamFactory =
			options.draftStreamFactory ?? createDraftStreamController;
		this.attachmentManager = new AttachmentManager(this.runtime);
		this.getChannelType = discordService.getChannelType;
		this.discordService = discordService;
		this.accountId = discordService.accountId ?? "default";
		// Load Discord settings with proper priority (env vars > character settings > defaults)
		this.discordSettings =
			discordService.discordSettings ?? getDiscordSettings(this.runtime);
		const reactionScopeSetting = this.runtime.getSetting(
			"DISCORD_STATUS_REACTIONS",
		) as string | undefined;
		// Default: react on all handled messages. Set DISCORD_STATUS_REACTIONS to
		// "group-mentions" or "none" to narrow the acknowledgement scope.
		this.statusReactionScope = (
			["all", "group-mentions", "none"].includes(reactionScopeSetting ?? "")
				? reactionScopeSetting
				: "all"
		) as StatusReactionScope;

		// The runtime coerces "true"/"false" to booleans before returning, so
		// both flags are parsed rather than compared against string literals.
		this.envelopeEnabled =
			parseBooleanValue(this.runtime.getSetting("DISCORD_ENVELOPE_ENABLED")) ??
			true;
		this.draftStreamingEnabled =
			parseBooleanValue(this.runtime.getSetting("DISCORD_DRAFT_STREAMING")) ??
			false;
		this.stalenessConfig = getDiscordStalenessConfig((key) =>
			this.runtime.getSetting(key),
		);
		this.groupCoordinationConfig = getGroupCoordinationConfig((key) =>
			this.runtime.getSetting(key),
		);
		// Draft streaming creates/edits Discord messages before the final callback.
		// Keep it off until that path is protected by the same outbound fence.
		if (this.groupCoordinationConfig.enabled) {
			this.draftStreamingEnabled = false;
		}
		this.runtimeInstanceId =
			String(
				this.runtime.getSetting("ELIZA_RUNTIME_INSTANCE_ID") ?? "",
			).trim() || randomUUID();
		this.contenderToken = createDiscordContenderToken({
			accountId: this.accountId,
			agentId: this.runtime.agentId,
			runtimeInstanceId: this.runtimeInstanceId,
		});
		this.startCoordinationSweeper();
	}

	/**
	 * Crash-recovery sweeper (production trigger for expired claims). A winner
	 * that crashed between claim and delivery leaves a `claimed` slot with no
	 * `delivered_message_id`; nothing else in the protocol revisits that edge
	 * unless the identical message is redelivered. This interval atomically
	 * expires such slots (first sweeper wins the UPDATE) and re-dispatches the
	 * original inbound Discord message through the NORMAL handleMessage path,
	 * where the durable turn record resumes the reply (bounded by its attempt
	 * counter) and the ordinary claim/fence machinery decides who answers.
	 */
	private startCoordinationSweeper(): void {
		const config = this.groupCoordinationConfig;
		if (!config.enabled || config.sweepMs <= 0) return;
		if (!hasSqlExecutor(this.runtime)) return;
		let scope: CoordinationScope;
		try {
			scope = requireCoordinationScope(
				{
					agentId: this.runtime.agentId,
					getSetting: (key) =>
						key === "ELIZA_RUNTIME_INSTANCE_ID"
							? this.runtimeInstanceId
							: this.runtime.getSetting(key),
				},
				this.accountId,
			);
		} catch {
			// Incomplete coordination config surfaces loudly on the message path;
			// the sweeper simply has nothing durable to sweep.
			return;
		}
		scope.contenderToken = this.contenderToken;
		this.coordinationSweeperHandle = setInterval(() => {
			void this.runCoordinationSweep(scope);
		}, config.sweepMs);
		this.coordinationSweeperHandle.unref?.();
	}

	private async runCoordinationSweep(scope: CoordinationScope): Promise<void> {
		if (this.coordinationSweepInFlight) return;
		this.coordinationSweepInFlight = true;
		try {
			// Only sweep channels this client can actually re-dispatch into.
			// Terminally expiring a slot for an unreachable channel spends a recovery
			// attempt while the re-dispatch silently fails, which loses the edge.
			const swept = await sweepExpiredCoordinationSlots(
				this.runtime,
				scope,
				Date.now(),
				[...this.client.channels.cache.keys()],
			);
			for (const slot of swept) {
				const roomId = createUniqueUuid(this.runtime, slot.channelId);
				await emitCoordinationReceipt(this.runtime, {
					kind: "sweeper-recovery",
					channelId: slot.channelId,
					edgeMessageId: slot.inboundMessageId,
					roomId,
					entityId: this.runtime.agentId,
					outcome: "expired-claim-recovered",
					generation: slot.slotIndex,
					holderToken: slot.holderToken,
					edgeEpoch: slot.edgeEpoch,
					detail: {
						lane: slot.lane,
						recoveryAttempts: slot.recoveryAttempts,
					},
					scope,
				});
				try {
					await this.redispatchSweptMessage(
						slot.channelId,
						slot.inboundMessageId,
					);
				} finally {
					// Sweeping changes `claimed` -> `expired` before Discord fetch. If
					// fetch/dispatch fails (or dispatch declines before claiming), re-arm
					// the exact old row so a later sweep retries. If dispatch DID claim
					// it, the guarded state/token CAS is a no-op.
					await rearmSweptCoordinationSlot(
						this.runtime,
						scope,
						slot,
						this.groupCoordinationConfig.sweepMs,
					);
				}
			}
		} catch (error) {
			this.runtime.reportError?.("discord:coordination.sweeper", error, {
				accountId: this.accountId,
			});
		} finally {
			this.coordinationSweepInFlight = false;
		}
	}

	private async redispatchSweptMessage(
		channelId: string,
		inboundMessageId: string,
	): Promise<void> {
		try {
			const channel = await this.client.channels.fetch(channelId);
			if (!channel || !("messages" in channel)) return;
			const inbound = await (channel as TextChannel).messages.fetch(
				inboundMessageId,
			);
			if (!inbound) return;
			// Clear this manager's in-process dedupe entry before re-dispatching.
			// The sweep interval (60s default) is SHORTER than the processed-id TTL
			// (120s), so on the crash path that matters most — the holder process
			// still alive but its generation dead — handleMessage would drop the
			// recovery as a "duplicate" and the edge would never be answered.
			// Cross-process safety does not rest on this guard: the durable slot
			// claim + outbound fence decide who may actually send.
			this.releaseMessageProcessing(inboundMessageId);
			await this.handleMessage(inbound);
		} catch (error) {
			this.runtime.reportError?.("discord:coordination.sweeper", error, {
				channelId,
				inboundMessageId,
				phase: "redispatch",
			});
		}
	}

	/**
	 * Resolve this manager's durable coordination scope, or undefined when the
	 * feature is off / not backed by plugin-sql. Never throws: callers on the
	 * gateway path must not break message intake on a misconfiguration, which the
	 * dispatch path already reports loudly.
	 */
	private tryCoordinationScope(): CoordinationScope | undefined {
		if (!this.groupCoordinationConfig.enabled) return undefined;
		if (!hasSqlExecutor(this.runtime)) return undefined;
		try {
			const scope = requireCoordinationScope(
				{
					agentId: this.runtime.agentId,
					getSetting: (key) =>
						key === "ELIZA_RUNTIME_INSTANCE_ID"
							? this.runtimeInstanceId
							: this.runtime.getSetting(key),
				},
				this.accountId,
			);
			scope.contenderToken = this.contenderToken;
			return scope;
		} catch {
			return undefined;
		}
	}

	/**
	 * Advance the durable human edge from the GATEWAY listener (messageCreate),
	 * i.e. for every human message the connector observes — not only the ones
	 * this agent goes on to dispatch.
	 *
	 * This is the production path for "latest human edge wins". Previously the
	 * gateway hook wrote only to the in-process WeakMap, so on a mention-gated
	 * deployment a human message that did not trigger a dispatch never advanced
	 * the persisted edge, and an in-flight generation answering an older message
	 * was never recognised as stale. The durable table is the shared surface all
	 * contenders read, so the gateway must write THERE.
	 */
	public async noteHumanEdge(
		channelId: string | undefined,
		messageId: string | undefined,
		createdTimestamp: number,
	): Promise<void> {
		if (!this.groupCoordinationConfig.enabled || !channelId || !messageId) {
			return;
		}
		const scope = this.tryCoordinationScope();
		if (!scope) return;
		try {
			await registerCoordinationTrustMember(this.runtime, scope);
			await recordDiscordHumanEdge(
				this.runtime,
				channelId,
				messageId,
				createdTimestamp,
				scope,
			);
		} catch (error) {
			this.runtime.reportError?.(DISCORD_COORDINATION_AUDIT_SCOPE, error, {
				channelId,
				messageId,
				phase: "gateway-edge",
				accountId: this.accountId,
			});
		}
	}

	/** Stop background coordination work. Idempotent. */
	public destroy(): void {
		if (this.coordinationSweeperHandle) {
			clearInterval(this.coordinationSweeperHandle);
			this.coordinationSweeperHandle = undefined;
		}
	}

	/**
	 * Check DM access based on the configured dmPolicy.
	 *
	 * @param message - The Discord DM message
	 * @returns Access check result with allowed status and optional reply message
	 */
	private async checkDmAccess(message: DiscordMessage): Promise<{
		allowed: boolean;
		replyMessage?: string;
	}> {
		return checkDiscordDmAccess(
			this.runtime,
			this.discordSettings,
			message.author,
		);
	}

	private async persistInboundMemory(
		memory: Memory,
		platformMessageId?: string,
	): Promise<"created" | "existing" | "missing-id"> {
		if (!memory.id) {
			return "missing-id";
		}

		const result = await persistDiscordMessageMemoryOnce(this.runtime, memory, {
			operation: "discord-inbound",
			platformMessageId,
		});
		return result.created ? "created" : "existing";
	}

	private async hasPersistedInboundMemory(
		memory: Memory,
		platformMessageId?: string,
	): Promise<boolean> {
		if (!memory.id) {
			return false;
		}

		const existing = await this.runtime.getMemoryById(memory.id);
		if (!existing) {
			return false;
		}

		this.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				messageId: platformMessageId,
				memoryId: memory.id,
			},
			"Skipping already persisted Discord inbound message",
		);
		return true;
	}

	/**
	 * Close a durable turn as terminal REPLIED for the deliberate ingest-only
	 * branches (auto-reply off, wrong target, strict-mode ignore, cannot-send).
	 * These branches persist the inbound but owe no reply, so the turn is
	 * genuinely complete; marking it terminal keeps a later redelivery a no-op
	 * instead of resuming forever. Best-effort: failure to stamp is non-fatal.
	 */
	private async closeTurnAsIngestOnly(
		turnRecord: DiscordTurnRecord | undefined,
	): Promise<DiscordTurnRecord | undefined> {
		if (!turnRecord || turnRecord.state === "REPLIED") {
			return turnRecord;
		}
		try {
			return await markDiscordTurnReplied(this.runtime, turnRecord);
		} catch (error) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					messageId: turnRecord.platformMessageId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to close ingest-only Discord turn record",
			);
			return turnRecord;
		}
	}

	private markMessageAsProcessing(messageId: string): boolean {
		const now = Date.now();
		for (const [candidateId, processedAt] of this.recentlyProcessedMessageIds) {
			if (now - processedAt > MessageManager.PROCESSED_MESSAGE_TTL_MS) {
				this.recentlyProcessedMessageIds.delete(candidateId);
			}
		}

		if (this.recentlyProcessedMessageIds.has(messageId)) {
			return false;
		}

		this.recentlyProcessedMessageIds.set(messageId, now);
		return true;
	}

	private releaseMessageProcessing(messageId: string | undefined): void {
		if (messageId) {
			this.recentlyProcessedMessageIds.delete(messageId);
		}
	}

	private async releaseMessageProcessingIfInboundNotPersisted(
		messageId: string | undefined,
		inboundMemoryId: UUID | undefined,
	): Promise<boolean> {
		let inboundMemoryCommitted = false;
		if (inboundMemoryId) {
			try {
				inboundMemoryCommitted =
					!!(await this.runtime.getMemoryById(inboundMemoryId));
			} catch (persistenceCheckError) {
				this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						messageId,
						memoryId: inboundMemoryId,
						error:
							persistenceCheckError instanceof Error
								? persistenceCheckError.message
								: String(persistenceCheckError),
					},
					"Could not verify Discord inbound persistence after failure",
				);
			}
		}
		if (!inboundMemoryCommitted) {
			this.releaseMessageProcessing(messageId);
		}
		return inboundMemoryCommitted;
	}

	/**
	 * Handles incoming Discord messages and processes them accordingly.
	 *
	 * Thin wrapper: registers the returned promise with the connector's
	 * shutdown-drain registry (shutdown-drain.ts) before delegating to the
	 * real handler, so `DiscordService#stop` can await outstanding turns
	 * within a bounded window instead of destroying the client mid-turn. The
	 * registration is fire-and-forget from this call's perspective — it does
	 * not change what this method returns or throws.
	 *
	 * @param {DiscordMessage} message - The Discord message to be handled
	 */
	async handleMessage(message: DiscordMessage): Promise<void> {
		// Choke point for gateway, direct/replay, and coordination-sweeper turns.
		// Event-listener gates avoid wasted preprocessing, but only this check can
		// guarantee no alternate caller registers work behind the drain snapshot.
		if (
			this.discordService.admitInboundMessage?.(
				message.id,
				message.channel.id,
			) === false
		) {
			return;
		}
		const turn = this.runMessageTurn(message);
		this.discordService.trackInFlightTurn?.(message.id, turn);
		return turn;
	}

	/**
	 * Real Discord message handler; see `handleMessage` for the shutdown-drain
	 * registration this is wrapped with.
	 *
	 * @param {DiscordMessage} message - The Discord message to be handled
	 */
	private async runMessageTurn(message: DiscordMessage) {
		// this filtering is already done in setupEventListeners
		/*
    if (
      (this.discordSettings.allowedChannelIds && this.discordSettings.allowedChannelIds.length) &&
      !this.discordSettings.allowedChannelIds.some((id: string) => id === message.channel.id)
    ) {
      return;
    }
    */

		const clientUser = this.client.user;
		if (
			message.interaction ||
			(clientUser && message.author.id === clientUser.id)
		) {
			return;
		}

		if (this.discordSettings.shouldIgnoreBotMessages && message.author?.bot) {
			return;
		}

		// Discord can emit messageCreate immediately after ClientReady while the
		// async onReady sequence is still resolving application-owner aliases.
		// Ingesting before that boundary permanently attributes an owner message to
		// a platform-derived entity, which makes owner-private recall fail closed
		// for the wrong reason and leaves split identity in memory. Wait before the
		// dedupe reservation or any room/entity write. A failed ready sequence is a
		// fail-closed connector state: ordinary chat must not race ahead of it.
		try {
			await waitForDiscordIngressReadiness(
				this.discordService.clientReadyPromise,
			);
		} catch (error) {
			this.runtime.reportError("discord:message-before-ready", error, {
				accountId: this.accountId,
				messageId: message.id,
				channelId: message.channel.id,
			});
			return;
		}

		if (message.id && !this.markMessageAsProcessing(message.id)) {
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					messageId: message.id,
				},
				"Skipping duplicate Discord message",
			);
			return;
		}

		// DM policy check - applies access control policies for direct messages
		if (message.channel.type === DiscordChannelType.DM) {
			const userId = message.author.id;
			if (this.discordSettings.shouldIgnoreDirectMessages) {
				const staticallyAllowed =
					this.discordSettings.allowFrom?.includes(userId) === true;
				const dynamicallyAllowed = await isInAllowlist(
					this.runtime,
					"discord",
					userId,
				);
				if (!staticallyAllowed && !dynamicallyAllowed) {
					return;
				}
			}

			const accessCheck = await this.checkDmAccess(message);
			if (!accessCheck.allowed) {
				// If a reply message was generated (new pairing request), send it
				if (accessCheck.replyMessage) {
					try {
						await message.author.send(accessCheck.replyMessage);
					} catch (err) {
						this.runtime.logger.warn(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								userId: message.author.id,
								error: err instanceof Error ? err.message : String(err),
							},
							"Failed to send pairing reply",
						);
					}
				}
				return;
			}
		}

		const isBotPlatformMentioned = !!(
			clientUser?.id && message.mentions.users?.has(clientUser.id)
		);
		const isReplyToBot =
			!!message.reference?.messageId &&
			message.mentions.repliedUser?.id === clientUser?.id;
		const isBotAddressed = isDiscordUserAddressed({
			text: getAddressingContent(message),
			userId: clientUser?.id,
			hasMessageReference: Boolean(message.reference?.messageId),
			repliedUserId: message.mentions.repliedUser?.id,
		});
		const mentionedOtherUsers = message.mentions.users
			? Array.from(message.mentions.users.values()).some(
					(user) => user.id !== clientUser?.id && user.id !== message.author.id,
				)
			: false;
		const isReplyToOtherUser =
			!!message.reference?.messageId &&
			!!message.mentions.repliedUser?.id &&
			message.mentions.repliedUser.id !== clientUser?.id &&
			message.mentions.repliedUser.id !== message.author.id;
		// `isBotAddressed` marks the PRIMARY addressee (first mention / reply-to)
		// so the bot does not butt into a message aimed at someone else. But an
		// explicit @mention of the bot — even alongside or after other mentions
		// (`@ruby @osiris @remilio`) — is a deliberate call to THIS bot and must
		// get a response. Treat any explicit platform mention as directly
		// addressed for the respond/ignore decision, while leaving
		// `isDiscordUserAddressed`'s first-mention semantics (and its tests)
		// untouched.
		const isBotDirectlyAddressed = isBotAddressed || isBotPlatformMentioned;
		const isInThread = message.channel.isThread();
		const isDM = message.channel.type === DiscordChannelType.DM;
		if (isDM) {
			// Cold-start scan coverage (#18746): remember this DM channel so a
			// restart after a hard kill can re-open and sweep it. Never throws.
			this.discordService.recordDmChannel?.(
				this.accountId,
				message.channel.id,
				message.author.id,
			);
		}
		const strictModeEnabled =
			this.discordSettings.shouldRespondOnlyToMentions === true;
		const replyToMode = normalizeReplyToMode(this.discordSettings.replyToMode);
		const outboundReplyToMessageId =
			!isDM && replyToMode !== "off" && isBotDirectlyAddressed
				? message.id
				: undefined;
		const strictModeShouldProcess = isDM || isBotDirectlyAddressed;
		let inboundMemoryCommitted = false;
		let inboundMemoryId: UUID | undefined;
		// Durable turn record for this Discord message (RECEIVED -> DISPATCHED ->
		// REPLIED | FAILED). Populated once we have a stable platform message id and
		// have decided to run the reply path. See turn-state.ts.
		let turnRecord: DiscordTurnRecord | undefined;
		let turnReplied = false;

		const userName = message.author.bot
			? `${message.author.username}#${message.author.discriminator}`
			: message.author.username;
		const name =
			message.member?.displayName ??
			message.author.globalName ??
			message.author.displayName ??
			message.author.username;
		const channelId = message.channel.id;
		const roomId = createUniqueUuid(this.runtime, channelId);
		const roomName =
			message.guild &&
			"name" in message.channel &&
			typeof message.channel.name === "string"
				? message.channel.name
				: name || userName;

		// Determine channel type and server ID for ensureConnection
		// messageServerId is a Discord snowflake string, converted to UUID when needed
		let type: ChannelType;
		let messageServerId: string | undefined;

		if (message.guild) {
			// Use the gateway-cached guild directly; do NOT call
			// `await message.guild.fetch()`. That issues a REST GET /guilds/{id} on
			// EVERY message; in a large, busy guild (thousands of members) the
			// per-message fetch storm saturates discord.js's REST queue and starves
			// message handling — the bot goes silent in big servers while staying
			// fine in small ones (rate-limits are queued, not thrown, so nothing
			// shows in the logs). `guild.id` (all that's used below) is already on
			// the cached object.
			const guild = message.guild;
			type = await this.getChannelType(message.channel as Channel);
			if (type === null) {
				// usually a forum type post
				this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Null channel type",
				);
			}
			messageServerId = guild.id;
		} else {
			type = await this.getChannelType(message.channel as Channel);
			messageServerId = message.channel.id;
		}
		const worldId = createUniqueUuid(this.runtime, messageServerId ?? roomId);

		// Declared outside the try so the outer catch can drive the controller to
		// a terminal state. Scoped inside, a throw escaping the inner handlers
		// left the reaction stuck on its last in-progress emoji forever — visible
		// to users on every failed turn, and it also pinned the turn in the
		// shutdown-drain registry, since that retires an entry only once the
		// reaction settles (#17749 review, @lalalune).
		let statusReactions: StatusReactionController | null = null;

		try {
			let { processedContent, attachments } =
				await this.processMessage(message);
			const currentMessageText = processedContent;
			// Audio attachments already processed in processMessage via attachmentManager

			if (this.envelopeEnabled && processedContent) {
				try {
					const envelope = await formatInboundEnvelope(
						message,
						processedContent,
					);
					processedContent = envelope.formattedContent;
				} catch {
					// Envelope formatting is best-effort only.
				}
			}

			if (!processedContent && !attachments?.length) {
				// Only process messages that are not empty
				return;
			}

			// Users often mention a teammate and then ask the bot by name in the
			// same message. Only short-circuit these messages when the bot is not
			// also clearly addressed.
			const ignoresOtherTarget =
				!isDM &&
				!isBotDirectlyAddressed &&
				(mentionedOtherUsers || isReplyToOtherUser);

			// Use the service's buildMemoryFromMessage method with pre-processed content
			const newMessage = await this.discordService.buildMemoryFromMessage(
				message,
				{
					processedContent,
					processedAttachments: attachments,
					extraContent: {
						currentMessageText,
						mentionContext: {
							isMention: isBotPlatformMentioned,
							isReply: isReplyToBot,
							isThread: isInThread,
							mentionType: isBotPlatformMentioned
								? "platform_mention"
								: isReplyToBot
									? "reply"
									: isInThread
										? "thread"
										: "none",
						},
					},
					extraMetadata: compactJsonObject(
						appendCoalescedDiscordMetadata(message, {
							// Reply attribution for cross-agent filtering
							// WHY: When user replies to another bot's message, we need to know
							// so other agents can ignore it (only the replied-to agent should respond)
							...(message.mentions.repliedUser
								? {
										replyToAuthor: {
											id: message.mentions.repliedUser.id,
											displayName:
												message.mentions.repliedUser.globalName ??
												message.mentions.repliedUser.username,
											username: message.mentions.repliedUser.username,
											isBot: message.mentions.repliedUser.bot,
										},
										replyToSenderId: message.mentions.repliedUser.id,
										replyToSenderName:
											message.mentions.repliedUser.globalName ??
											message.mentions.repliedUser.username,
										replyToSenderUserName:
											message.mentions.repliedUser.username,
									}
								: {}),
							...(message.reference?.messageId
								? {
										replyToMessageId: createUniqueUuid(
											this.runtime,
											message.reference.messageId,
										),
										replyToExternalMessageId: message.reference.messageId,
									}
								: {}),
						}),
					),
				},
			);

			if (!newMessage) {
				this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						messageId: message.id,
					},
					"Failed to build memory from message",
				);
				return;
			}
			inboundMemoryId = newMessage.id;

			// Owner-aliased authors (ELIZA_DISCORD_OWNER_USER_IDS_JSON) resolve to
			// the canonical owner entity while the wire author is someone else — a
			// webhook or a deliberate alias account. Attaching that author's
			// name/userName/id here rewrote the canonical entity's identity record
			// to whichever alias spoke last, so identity fields are attached only
			// when the entity id actually derives from this author.
			const aliasedAuthor = isAliasedDiscordEntityId(
				this.runtime,
				message.author.id,
				newMessage.entityId,
			);
			await this.runtime.ensureConnection({
				entityId: newMessage.entityId,
				roomId,
				roomName,
				...(aliasedAuthor ? {} : { userName, name }),
				source: "discord",
				channelId: message.channel.id,
				serverId: messageServerId,
				// Convert Discord snowflake to UUID (see service.ts header for why stringToUuid not asUUID)
				messageServerId: messageServerId
					? stringToUuid(messageServerId)
					: undefined,
				type,
				worldId,
				worldName: message.guild?.name,
				// Preserve the raw Discord user id in source metadata for role and
				// allowlist checks — but only when it is the entity's own id.
				...(aliasedAuthor ? {} : { userId: message.author.id as UUID }),
				metadata: {
					...buildDiscordWorldMetadata(
						this.runtime,
						message.guild?.ownerId ?? undefined,
					),
					accountId: this.accountId,
				},
			});
			try {
				await attestDeliveryAudienceFromCanonicalRoom(this.runtime, newMessage);
			} catch (error) {
				// error-policy:J4 ordinary chat remains available, while every
				// owner-private component fails closed without this evidence.
				this.runtime.reportError(
					"DiscordMessageManager.deliveryAudience",
					error,
					{ roomId, messageId: newMessage.id },
				);
			}

			// Durable turn / outbox state machine (charter rows D4/D5).
			//
			// #16696 returned here unconditionally whenever the inbound memory was
			// already persisted. That closed the double-dispatch window but left a
			// crash AFTER inbound persistence and BEFORE the reply permanently
			// suppressed: the message was ingested but no reply ever went out.
			//
			// Instead, consult a durable turn record keyed by the Discord message
			// id. A pre-existing record means this is a redelivery/restart:
			//   - terminal (REPLIED/FAILED) -> genuine no-op
			//   - a reply memory already exists -> reconcile to REPLIED, no resend
			//     (send-then-record safety: a crash happened in the send<->record gap)
			//   - retry budget exhausted -> mark terminal FAILED (no silent drop)
			//   - otherwise -> RESUME the reply path below instead of returning.
			if (message.id) {
				inboundMemoryCommitted = await this.hasPersistedInboundMemory(
					newMessage,
					message.id,
				);
				const claim = await claimDiscordTurn(this.runtime, message.id, {
					entityId: newMessage.entityId,
					roomId: newMessage.roomId,
					worldId,
				});
				turnRecord = claim.record;
				if (!claim.created) {
					const deliveredReplyId = newMessage.id
						? await findDeliveredReply(this.runtime, roomId, newMessage.id)
						: null;
					const decision = decideResume(claim.record, deliveredReplyId);
					if (decision.action === "noop") {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								messageId: message.id,
								state: claim.record.state,
							},
							"Discord turn already terminal; skipping redelivery",
						);
						return;
					}
					if (decision.action === "reconciled-replied") {
						turnRecord = await markDiscordTurnReplied(
							this.runtime,
							claim.record,
							decision.replyMessageId || undefined,
						);
						turnReplied = true;
						this.runtime.logger.info(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								messageId: message.id,
								replyMessageId: decision.replyMessageId,
							},
							"Reconciled Discord turn to REPLIED from existing reply memory; no resend",
						);
						return;
					}
					if (decision.action === "exhausted") {
						turnRecord = await markDiscordTurnFailed(
							this.runtime,
							claim.record,
							"reply retry budget exhausted after restart/redelivery",
						);
						this.runtime.logger.error(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								messageId: message.id,
								attempts: claim.record.attempts,
							},
							"Discord turn exhausted retries; marking terminal FAILED",
						);
						return;
					}
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							messageId: message.id,
							attempts: claim.record.attempts,
							state: claim.record.state,
						},
						"Resuming Discord turn with no prior reply (crash after persist before reply)",
					);
					// fall through: resume the reply path for this persisted turn
				}
			}

			if (
				!this.discordSettings.autoReply ||
				lifeOpsPassiveConnectorsEnabled(this.runtime)
			) {
				const inboundPersistence = await this.persistInboundMemory(
					newMessage,
					message.id,
				);
				inboundMemoryCommitted = inboundPersistence !== "missing-id";
				turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Auto-reply disabled; message ingested without response",
				);
				return;
			}

			if (ignoresOtherTarget) {
				const inboundPersistence = await this.persistInboundMemory(
					newMessage,
					message.id,
				);
				inboundMemoryCommitted = inboundPersistence !== "missing-id";
				turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Ignoring message that targets another mentioned user",
				);
				return;
			}

			if (strictModeEnabled && !strictModeShouldProcess) {
				const inboundPersistence = await this.persistInboundMemory(
					newMessage,
					message.id,
				);
				inboundMemoryCommitted = inboundPersistence !== "missing-id";
				turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Strict mode: ignoring message (no mention or reply)",
				);
				return;
			}

			if (strictModeEnabled) {
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Strict mode: processing message",
				);
			}

			const canSendResult = canSendMessage(message.channel);
			if (!canSendResult.canSend) {
				const inboundPersistence = await this.persistInboundMemory(
					newMessage,
					message.id,
				);
				inboundMemoryCommitted = inboundPersistence !== "missing-id";
				turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
				return this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
						reason: canSendResult.reason,
					},
					"Cannot send message to channel",
				);
			}

			// ── P4 group coordination gate (multi-human + multi-agent rooms) ──
			//
			// Opt-in via DISCORD_GROUP_COORDINATION_ENABLED. Three structural
			// guarantees before this agent may commit a model turn in a group room:
			//   1. Bot-to-bot loop prevention: a bot-authored message only earns a
			//      reply when it explicitly addresses this bot AND the per-channel
			//      consecutive bot-reply budget (reset by each human message) is
			//      not exhausted. Suppressed messages are still ingested.
			//   2. One active speaker per human edge: a durable speaker lease keyed
			//      (channelId, edgeMessageId) — agent-independent row id — must be
			//      won. Losing the race is a silent ingest, with a receipt.
			//   3. Latest-human-edge-wins at claim time: a turn whose edge has been
			//      superseded by a newer human message aborts here, unless the
			//      message explicitly addressed this bot (explicitly addressed work
			//      is never dropped) or the coalesced batch contains the new edge.
			// A second edge/lease verification runs again in the response callback
			// immediately before the third-party send (see below).
			let speakerLease: SpeakerLease | undefined;
			let coordinationScope: CoordinationScope | undefined;
			const coordination = this.groupCoordinationConfig;
			const coalescedEdgeIds = (message as DiscordMessageWithCoalescedMetadata)
				.__discordCoalescedMessageIds;
			if (coordination.enabled && !isDM && message.id) {
				const coordinationDbAvailable = hasSqlExecutor(this.runtime);
				if (coordinationDbAvailable) {
					coordinationScope = requireCoordinationScope(
						{
							agentId: this.runtime.agentId,
							getSetting: (key) => {
								if (key === "ELIZA_RUNTIME_INSTANCE_ID") {
									return this.runtimeInstanceId;
								}
								return this.runtime.getSetting(key);
							},
						},
						this.accountId,
					);
					coordinationScope.contenderToken = this.contenderToken;
					await registerCoordinationTrustMember(
						this.runtime,
						coordinationScope,
					);
				} else {
					// Fail closed, with no test escape hatch. A NODE_ENV bypass here let
					// the suites exercise the in-process WeakMap fallback while claiming
					// to cover the durable protocol; the coordination tests now boot a
					// real plugin-sql runtime instead.
					throw new Error(
						"DISCORD_GROUP_COORDINATION_ENABLED requires plugin-sql runtime.db",
					);
				}
				// Direct dispatch paths (and tests) may bypass the gateway listener
				// that records edges; recording here is idempotent (monotonic guard).
				if (!message.author?.bot) {
					await recordDiscordHumanEdge(
						this.runtime,
						message.channel.id,
						message.id,
						message.createdTimestamp ?? Date.now(),
						coordinationScope,
					);
				} else {
					const suppression = await shouldSuppressBotReply({
						owner: this.runtime,
						channelId: message.channel.id,
						explicitlyAddressed: isBotDirectlyAddressed,
						budget: coordination.botReplyBudget,
						scope: coordinationScope,
					});
					if (suppression.suppress) {
						const inboundPersistence = await this.persistInboundMemory(
							newMessage,
							message.id,
						);
						inboundMemoryCommitted = inboundPersistence !== "missing-id";
						turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
						await emitCoordinationReceipt(this.runtime, {
							kind: "bot-loop-suppress",
							channelId: message.channel.id,
							edgeMessageId: message.id,
							roomId,
							entityId: newMessage.entityId,
							worldId,
							outcome: suppression.reason,
							scope: coordinationScope,
						});
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								channelId: message.channel.id,
								messageId: message.id,
								reason: suppression.reason,
							},
							"Group coordination: suppressing reply to bot message",
						);
						return;
					}
				}

				const claim = await claimSpeakerLease(this.runtime, {
					channelId: message.channel.id,
					edgeMessageId: message.id,
					roomId,
					entityId: newMessage.entityId,
					worldId,
					leaseMs: coordination.leaseMs,
					// Human replies and bot-to-bot replies are separate lanes with
					// separate budgets; sharing a lane made the human answer spend the
					// bot budget for the same edge.
					lane: message.author?.bot ? "bot" : "human",
					slotCount: message.author?.bot ? coordination.botReplyBudget : 1,
					accountId: this.accountId,
					scope: coordinationScope,
					contenderToken: this.contenderToken,
					nonce: deterministicDiscordNonce({
						accountId: this.accountId,
						channelId: message.channel.id,
						authorId: message.author.id,
						edgeMessageId: message.id,
					}),
				});
				await emitCoordinationReceipt(this.runtime, {
					kind: "lease-claim",
					channelId: message.channel.id,
					edgeMessageId: message.id,
					roomId,
					entityId: newMessage.entityId,
					worldId,
					outcome: claim.outcome,
					generation: claim.lease.generation,
					holderAgentId: claim.lease.holderAgentId,
					holderToken: claim.lease.contenderToken,
					edgeEpoch: claim.lease.edgeEpoch,
					scope: coordinationScope,
				});
				if (claim.outcome === "lost") {
					const inboundPersistence = await this.persistInboundMemory(
						newMessage,
						message.id,
					);
					inboundMemoryCommitted = inboundPersistence !== "missing-id";
					turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
					this.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							channelId: message.channel.id,
							messageId: message.id,
							holderAgentId: claim.lease.holderAgentId,
						},
						"Group coordination: another agent holds the speaker lease; ingesting silently",
					);
					return;
				}
				speakerLease = claim.lease;

				const edgeAtClaim = await evaluateEdgeCurrency({
					owner: this.runtime,
					channelId: message.channel.id,
					edgeMessageId: message.id,
					coalescedMessageIds: coalescedEdgeIds,
					explicitlyAddressed: isBotDirectlyAddressed,
					scope: coordinationScope,
				});
				if (!edgeAtClaim.current) {
					const inboundPersistence = await this.persistInboundMemory(
						newMessage,
						message.id,
					);
					inboundMemoryCommitted = inboundPersistence !== "missing-id";
					turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
					// This claim will never produce a reply. Release the slot now
					// instead of leaving it `claimed` until expiry, otherwise the crash
					// sweeper re-dispatches an edge we deliberately abandoned.
					await releaseSpeakerLease(
						this.runtime,
						claim.lease,
						"stale-edge-at-claim",
					);
					speakerLease = undefined;
					await emitCoordinationReceipt(this.runtime, {
						kind: "stale-edge-abort",
						channelId: message.channel.id,
						edgeMessageId: message.id,
						roomId,
						entityId: newMessage.entityId,
						worldId,
						outcome: "claim-time",
						edgeEpoch: edgeAtClaim.edgeEpoch,
						detail: { latestEdgeMessageId: edgeAtClaim.latestEdgeMessageId },
						scope: coordinationScope,
					});
					this.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							channelId: message.channel.id,
							messageId: message.id,
							latestEdgeMessageId: edgeAtClaim.latestEdgeMessageId,
						},
						"Group coordination: human edge superseded before dispatch; ingesting silently",
					);
					return;
				}

				// NOTE: the bot-lane budget needs no separate "consume" write. Winning
				// the bot-lane slot IS the spend: the claim is a single atomic upsert,
				// and shouldSuppressBotReply counts claimed/consumed/delivered bot-lane
				// rows for the edge. A separate state='consumed' write here also broke
				// the outbound fence, which requires state='claimed' to renew, so the
				// agent aborted its own bot reply as a lost lease.
			}

			const messageId = newMessage.id;
			const stalenessStartSequence = getDiscordChannelMessageSequence(
				this,
				message.channel.id,
			);
			const channel = message.channel as TextChannel;
			const typingController = createTypingController(channel);
			const clientUserId = this.client.user?.id;
			const useReactions = shouldShowStatusReaction(
				this.statusReactionScope,
				message,
				clientUserId,
			);
			statusReactions = useReactions
				? createStatusReactionController(message)
				: null;
			if (statusReactions) {
				// Let the shutdown-drain registry reach this controller if the
				// connector stops while this turn is still in flight, so the
				// reaction gets reconciled instead of orphaned on the message.
				this.discordService.trackStatusReaction?.(message.id, statusReactions);
			}
			const draftStream = this.draftStreamingEnabled
				? this.draftStreamFactory({
						log: (entry) =>
							this.runtime.logger.debug(
								{ src: "plugin:discord", agentId: this.runtime.agentId },
								entry,
							),
						warn: (entry) =>
							this.runtime.logger.warn(
								{ src: "plugin:discord", agentId: this.runtime.agentId },
								entry,
							),
					})
				: null;
			let typingStarted = false;
			let responseEmitted = false;
			let responseDispatchInFlight = false;
			let generationTimedOut = false;
			const generationTimeoutMs = resolveGenerationTimeoutMs(
				this.runtime.getSetting("DISCORD_GENERATION_TIMEOUT_MS") ??
					process.env.DISCORD_GENERATION_TIMEOUT_MS,
				this.runtime.getSetting("MESSAGE_TIMEOUT_MS") ??
					process.env.MESSAGE_TIMEOUT_MS,
				this.runtime.getSetting("ZEROLLAMA_VIDEO_TIMEOUT_MS") ??
					process.env.ZEROLLAMA_VIDEO_TIMEOUT_MS,
			);

			const finalizePendingDraft = async () => {
				if (draftStream?.isStarted() && !draftStream.isDone()) {
					await draftStream.finalize("");
				}
			};

			const abortPendingDraft = async () => {
				if (draftStream?.isStarted() && !draftStream.isDone()) {
					await draftStream.abort(
						"An error occurred while generating the response.",
					);
				}
			};

			const sendFailureReply = async (text: string) => {
				try {
					const fenced = await verifyFencedOutboundSend("failure-reply");
					if (!fenced) {
						return;
					}
					const sent = await channel.send({
						content: text,
						...(speakerLease
							? {
									nonce: deterministicCoordinationNonce(
										speakerLease,
										"failure",
									),
									enforceNonce: true,
								}
							: {}),
						...(outboundReplyToMessageId && replyToMode !== "off"
							? {
									reply: {
										messageReference: outboundReplyToMessageId,
									},
								}
							: {}),
					});
					if (speakerLease) {
						await reconcileDiscordDelivery(this.runtime, speakerLease, sent.id);
						await emitCoordinationReceipt(this.runtime, {
							kind: "delivery-reconciled",
							channelId: message.channel.id,
							edgeMessageId: message.id,
							roomId,
							entityId: newMessage.entityId,
							worldId,
							outcome: "failure-reply",
							generation: speakerLease.generation,
							holderToken: speakerLease.contenderToken,
							edgeEpoch: speakerLease.edgeEpoch,
							detail: { deliveredMessageId: sent.id },
							scope: coordinationScope,
						});
					}
					responseEmitted = true;
				} catch (sendError) {
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							error:
								sendError instanceof Error
									? sendError.message
									: String(sendError),
						},
						"Failed to send Discord failure reply",
					);
				}
			};

			const verifyFencedOutboundSend = async (
				outcome: "normal" | "failure-reply",
			): Promise<boolean> => {
				if (!speakerLease || !message.id) {
					return true;
				}
				const renewed = await renewSpeakerLease(
					this.runtime,
					speakerLease,
					coordination.leaseMs,
				);
				const leaseCheck = renewed
					? await verifySpeakerLease(this.runtime, speakerLease)
					: { held: false as const, reason: "expired" as const };
				if (!leaseCheck.held) {
					// The slot is already someone else's (or expired); do NOT release it,
					// that would clear the new holder's claim. Just abort.
					await emitCoordinationReceipt(this.runtime, {
						kind: "lost-lease-abort",
						channelId: message.channel.id,
						edgeMessageId: message.id,
						roomId,
						entityId: newMessage.entityId,
						worldId,
						outcome: leaseCheck.reason,
						generation: speakerLease.generation,
						holderToken: speakerLease.contenderToken,
						edgeEpoch: speakerLease.edgeEpoch,
						detail: { sendPath: outcome },
						scope: coordinationScope,
					});
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							channelId: message.channel.id,
							messageId: message.id,
							reason: leaseCheck.reason,
							sendPath: outcome,
						},
						"Group coordination: speaker lease no longer held; aborting before send",
					);
					return false;
				}
				const edgeAtSend = await evaluateEdgeCurrency({
					owner: this.runtime,
					channelId: message.channel.id,
					edgeMessageId: message.id,
					coalescedMessageIds: coalescedEdgeIds,
					explicitlyAddressed: isBotDirectlyAddressed,
					scope: coordinationScope,
				});
				if (!edgeAtSend.current) {
					// We still hold the slot but will never use it: release so the edge is
					// not resurrected by the sweeper and the bot lane's budget is not
					// consumed by an attempt that produced no message.
					await releaseSpeakerLease(
						this.runtime,
						speakerLease,
						"stale-edge-pre-send",
					);
					await emitCoordinationReceipt(this.runtime, {
						kind: "stale-edge-abort",
						channelId: message.channel.id,
						edgeMessageId: message.id,
						roomId,
						entityId: newMessage.entityId,
						worldId,
						outcome: outcome === "normal" ? "pre-send" : "failure-reply",
						holderToken: speakerLease.contenderToken,
						edgeEpoch: edgeAtSend.edgeEpoch,
						detail: {
							latestEdgeMessageId: edgeAtSend.latestEdgeMessageId,
							sendPath: outcome,
						},
						scope: coordinationScope,
					});
					this.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							channelId: message.channel.id,
							messageId: message.id,
							latestEdgeMessageId: edgeAtSend.latestEdgeMessageId,
							sendPath: outcome,
						},
						"Group coordination: human edge superseded; aborting before send",
					);
					return false;
				}
				return true;
			};

			const runResponseDispatch = async <T>(
				dispatch: () => Promise<T>,
			): Promise<T> => {
				responseDispatchInFlight = true;
				try {
					return await dispatch();
				} finally {
					responseDispatchInFlight = false;
				}
			};

			if (draftStream) {
				await draftStream.start(channel, outboundReplyToMessageId, replyToMode);
			}
			// Typing indicator is deferred until the runtime actually invokes the
			// handler callback (see the `typingStarted` guard further down). This
			// avoids showing "Eliza is typing…" for messages the agent decides to
			// IGNORE/NONE, and lines up with the message-service preamble that
			// fires the callback the moment we commit to responding.

			statusReactions?.setQueued();
			statusReactions?.setThinking();

			const callback: HandlerCallback = async (content: Content) => {
				let outboundReservation: DiscordOutboundDeliveryReservation | undefined;
				let acceptedMessages: DiscordMessage[] = [];
				let providerSendFailure: unknown;
				let deliveredReplyDedupKey: string | undefined;
				let deliveredFactSignature: Set<string> | null = null;
				try {
					const pendingAttachmentCount = Array.isArray(content.attachments)
						? content.attachments.filter((media) => Boolean(media?.url)).length
						: 0;
					// Long-running media (e.g. Wan video ~10 min) can outlive the Discord
					// generation timeout. Still deliver attachments when the job finishes.
					if (generationTimedOut && pendingAttachmentCount === 0) {
						return [];
					}
					// target is set but not addressed to us handling
					if (
						content.target &&
						typeof content.target === "string" &&
						content.target.toLowerCase() !== "discord"
					) {
						return [];
					}

					const stalenessDecision = applyDiscordStalenessGuard({
						config: this.stalenessConfig,
						owner: this,
						message,
						startSequence: stalenessStartSequence,
						content,
					});
					if (stalenessDecision.stale) {
						this.runtime.logger.warn(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								channelId: message.channel.id,
								messageId: message.id,
								messagesSinceTurnStart:
									stalenessDecision.messagesSinceTurnStart,
								threshold: this.stalenessConfig.threshold,
								behavior: stalenessDecision.behavior,
							},
							"Discord response completed after newer channel messages arrived",
						);
					}
					if (!stalenessDecision.shouldSend) {
						typingController.stop();
						statusReactions?.setDone();
						await finalizePendingDraft();
						return [];
					}

					if (!(await verifyFencedOutboundSend("normal"))) {
						typingController.stop();
						statusReactions?.setDone();
						await finalizePendingDraft();
						return [];
					}

					if (message.id && !content.inReplyTo) {
						content.inReplyTo = createUniqueUuid(this.runtime, message.id);
					}

					// Reasoning-tag / native tool-syntax sanitization happens once at
					// the shared outbound boundary in @elizaos/core (#15888) — the
					// text arriving here is already sanitized.

					// Project embedded interaction blocks (choices, task cards, …) onto
					// native Discord components, and strip their markers from the prose.
					const rendered = buildDiscordReplyPayload(this.runtime, content);
					const hasComponents = rendered.components.length > 0;
					const interactionIdentity = hasComponents
						? JSON.stringify(rendered.components)
						: undefined;
					let textContent = normalizeDiscordMessageText(rendered.text);
					if (textContent.trim().length === 0 && hasComponents) {
						textContent = INTERACTION_ONLY_FALLBACK_TEXT;
					}
					const hasText = textContent.trim().length > 0;
					let attachmentCount = Array.isArray(content.attachments)
						? content.attachments.filter((media) => Boolean(media?.url)).length
						: 0;

					// Skip attachment URLs already delivered by an action callback this turn.
					if (attachmentCount > 0 && content.inReplyTo) {
						const callbackDedup = message as DiscordMessage & {
							_elizaSentReplyKeys?: Set<string>;
							_elizaSentAttachmentUrls?: Set<string>;
						};
						callbackDedup._elizaSentAttachmentUrls ??= new Set();
						const sentAttachmentUrls = callbackDedup._elizaSentAttachmentUrls;
						const pendingAttachments = (content.attachments ?? []).filter(
							(media) =>
								Boolean(media?.url) && !sentAttachmentUrls.has(media.url),
						);
						if (pendingAttachments.length === 0) {
							content = { ...content, attachments: undefined };
							attachmentCount = 0;
						} else if (
							pendingAttachments.length !== (content.attachments ?? []).length
						) {
							content = { ...content, attachments: pendingAttachments };
							attachmentCount = pendingAttachments.length;
						}
					}

					if (!hasText && attachmentCount === 0) {
						return [];
					}

					if (!typingStarted) {
						typingStarted = true;
						typingController.start();
					}

					// Dedup: error when the runtime emits identical text
					// twice in response to the same inbound message (e.g.
					// planner follow-up repeating action output).
					if (hasText && content.inReplyTo) {
						const dedupKey = `${content.inReplyTo}::${textContent.replace(/\s+/g, " ").trim()}::${interactionIdentity ?? ""}`;
						const callbackDedup = message as DiscordMessage & {
							_elizaSentReplyKeys?: Set<string>;
							_elizaSentFactSignatures?: Array<Set<string>>;
						};
						callbackDedup._elizaSentReplyKeys ??= new Set();
						callbackDedup._elizaSentFactSignatures ??= [];
						// Paraphrase/subset guard (#15585): a short numeric single-fact
						// reply that restates one already sent for this inbound message —
						// even in different words or as the bare value — is a redundant
						// second bubble the exact-text key above cannot catch.
						// Directional: suppress only when the NEW reply adds nothing over
						// an already-sent one (its tokens ⊆ a prior's). This drops the
						// bare-value/paraphrase second bubble while always letting a
						// genuinely-additive follow-up (which carries a token the prior
						// lacks) through, regardless of delivery order.
						const factSignature = numericFactSignatureTokens(textContent);
						const repeatsPriorFact =
							!hasComponents &&
							factSignature !== null &&
							callbackDedup._elizaSentFactSignatures.some((prior) =>
								isSubsetOrEqual(factSignature, prior),
							);
						if (
							callbackDedup._elizaSentReplyKeys.has(dedupKey) ||
							repeatsPriorFact
						) {
							this.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: this.runtime.agentId,
									messageId: message.id,
									reason: repeatsPriorFact
										? "fact-signature"
										: "identical-text",
									textPreview: buildDuplicateTextPreview(textContent),
								},
								"Suppressing duplicate callback reply",
							);
							return [];
						}
						deliveredReplyDedupKey = dedupKey;
						deliveredFactSignature = factSignature;
					}

					const dedupeParams = {
						accountId: this.accountId,
						channelId: channel.id,
						replyToMessageId:
							outboundReplyToMessageId ??
							(typeof content.inReplyTo === "string"
								? content.inReplyTo
								: undefined),
						text: textContent,
						attachmentUrls: content.attachments
							?.map((media) => media.url)
							.filter((url): url is string => typeof url === "string"),
						interactionIdentity,
					};
					let outboundDedupe = beginDiscordOutboundDelivery(dedupeParams);
					while (outboundDedupe.kind === "in_flight") {
						const settlement = await outboundDedupe.settlement;
						if (settlement.kind === "settled") {
							return [];
						}
						outboundDedupe = beginDiscordOutboundDelivery(dedupeParams);
					}
					if (outboundDedupe.kind === "duplicate") {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								channelId: channel.id,
								messageId: message.id,
								textPreview: buildDuplicateTextPreview(textContent),
							},
							"Suppressing duplicate Discord outbound delivery",
						);
						return [];
					}
					outboundReservation = outboundDedupe.reservation;

					const files: AttachmentBuilder[] = [];
					if (content.attachments && content.attachments.length > 0) {
						for (const media of content.attachments) {
							if (media.url) {
								files.push(
									await buildOutboundDiscordAttachment(media, this.runtime),
								);
							}
						}
						if (files.length > 0) {
							this.runtime.logger.info(
								{
									src: "plugin:discord",
									agentId: this.runtime.agentId,
									messageId: message.id,
									attachmentCount: files.length,
								},
								"Sending Discord message attachments",
							);
						}
					}

					let messages: DiscordMessage[] = [];
					if (draftStream?.isStarted() && !draftStream.isDone()) {
						if (hasText || files.length === 0) {
							const draftComponents = hasComponents
								? buildDiscordComponents(rendered.components)
								: undefined;
							messages = await runResponseDispatch(() =>
								draftStream.finalize(textContent, draftComponents),
							);
						} else {
							await finalizePendingDraft();
						}

						if (files.length > 0) {
							try {
								const attachmentMessage = await runResponseDispatch(() =>
									channel.send({
										files,
										...(outboundReplyToMessageId &&
										(replyToMode === "all" || !hasText)
											? {
													reply: {
														messageReference: outboundReplyToMessageId,
													},
												}
											: {}),
									}),
								);
								messages.push(attachmentMessage);
							} catch (error) {
								// error-policy:J1 provider boundary retains the
								// finalized draft receipt while exposing attachment failure.
								providerSendFailure = error;
								this.runtime.reportError(
									"discord:callback-partial-attachment",
									error,
									{
										channelId: channel.id,
										providerMessageIds: messages.map((message) => message.id),
									},
								);
							}
						}
					} else if (content && content.channelType === "DM") {
						const user = await this.client.users.fetch(message.author.id);
						if (!user) {
							this.runtime.logger.warn(
								{
									src: "plugin:discord",
									agentId: this.runtime.agentId,
									entityId: message.author.id,
								},
								"User not found for DM",
							);
							outboundReservation.release();
							outboundReservation = undefined;
							return [];
						}

						const dmComponents = hasComponents
							? buildDiscordComponents(rendered.components)
							: undefined;
						messages = await runResponseDispatch(() =>
							sendDmInChunks(user, textContent, files, dmComponents),
						);
					} else {
						if (!message.id) {
							this.runtime.logger.warn(
								{ src: "plugin:discord", agentId: this.runtime.agentId },
								"Cannot send message: message.id is missing",
							);
							outboundReservation.release();
							outboundReservation = undefined;
							return [];
						}
						messages = await runResponseDispatch(() =>
							sendMessageInChunks(
								channel,
								textContent,
								outboundReplyToMessageId ?? "",
								files,
								hasComponents ? rendered.components : undefined,
								this.runtime,
								replyToMode,
								(outcome) => {
									providerSendFailure = outcome.failure;
								},
								speakerLease
									? {
											beforeSend: () => verifyFencedOutboundSend("normal"),
											nonceForChunk: (chunkIndex) =>
												deterministicCoordinationNonce(
													speakerLease,
													String(chunkIndex),
												),
										}
									: undefined,
							),
						);
					}
					acceptedMessages = [...messages];

					const attemptedSend = hasText || attachmentCount > 0;
					if (attemptedSend && messages.length === 0) {
						throw new Error(
							"Discord response callback completed without sending any messages",
						);
					}
					// Coordination delivery reconciliation runs as soon as Discord
					// accepted a chunk, BEFORE local persistence: the slot must record
					// `delivered_message_id` even if memory writes later fail, otherwise
					// the crash sweeper would treat a delivered edge as unanswered and
					// re-dispatch it (double reply).
					if (speakerLease && messages.length > 0) {
						await reconcileDiscordDelivery(
							this.runtime,
							speakerLease,
							messages[0]?.id ?? "",
						);
						await emitCoordinationReceipt(this.runtime, {
							kind: "delivery-reconciled",
							channelId: message.channel.id,
							edgeMessageId: message.id,
							roomId,
							entityId: newMessage.entityId,
							worldId,
							outcome: "delivered",
							generation: speakerLease.generation,
							holderToken: speakerLease.contenderToken,
							edgeEpoch: speakerLease.edgeEpoch,
							detail: { deliveredMessageId: messages[0]?.id ?? "" },
							scope: coordinationScope,
						});
					}
					const memories: Memory[] = [];
					for (const m of messages) {
						const actions = content.actions;
						// Only attach files to the memory for the message that actually carries them
						const hasAttachments = m.attachments?.size > 0;

						const memory: Memory = {
							id: createUniqueUuid(this.runtime, m.id),
							entityId: this.runtime.agentId,
							agentId: this.runtime.agentId,
							content: {
								...content,
								source: "discord",
								text: m.content || textContent || " ",
								actions,
								inReplyTo: messageId,
								url: m.url,
								channelType: type,
								// Only include attachments for the message chunk that actually has them
								attachments:
									hasAttachments && content.attachments
										? content.attachments
										: undefined,
							},
							roomId,
							metadata: {
								type: MemoryType.MESSAGE,
								accountId: this.accountId,
								platformMessageId: m.id,
								// Trusted scope stamp at ingestion: the reply belongs to the
								// room it was delivered into.
								scope: "room",
							},
							createdAt: m.createdTimestamp,
						};
						memories.push(memory);
					}

					const persistedMemories: Memory[] = [];
					const persistenceFailures: SendHandlerPersistenceFailure[] = [];
					for (let index = 0; index < memories.length; index += 1) {
						const candidate = memories[index];
						const providerMessage = messages[index];
						if (!candidate || !providerMessage) continue;
						try {
							const persisted = await createDiscordMessageMemoryOnce(
								this.runtime,
								candidate,
								{
									operation: "discord-response-callback",
									platformMessageId: providerMessage.id,
								},
							);
							if (!persisted) {
								throw new Error(
									"Discord callback persistence returned no stored record.",
								);
							}
							persistedMemories.push(persisted);
						} catch (error) {
							// error-policy:J1 local persistence boundary binds the
							// failure to the provider receipt and keeps delivery truthful.
							persistenceFailures.push(
								callbackPersistenceFailure(providerMessage, error),
							);
							this.runtime.reportError(
								"discord:callback-memory-persistence",
								error,
								{
									channelId: channel.id,
									providerMessageId: providerMessage.id,
								},
							);
						}
					}

					const receipt = callbackDeliveryReceipt({
						messages,
						memories: persistedMemories,
						failures: persistenceFailures,
					});
					const deliveryKind = providerSendFailure
						? "partially_delivered"
						: "delivered";
					outboundReservation?.commit(deliveryKind, receipt);
					outboundReservation = undefined;

					if (messages.length > 0) {
						responseEmitted = true;
						if (deliveredReplyDedupKey && !providerSendFailure) {
							const callbackDedup = message as DiscordMessage & {
								_elizaSentReplyKeys?: Set<string>;
								_elizaSentFactSignatures?: Array<Set<string>>;
							};
							callbackDedup._elizaSentReplyKeys ??= new Set();
							callbackDedup._elizaSentReplyKeys.add(deliveredReplyDedupKey);
							if (deliveredFactSignature) {
								callbackDedup._elizaSentFactSignatures ??= [];
								callbackDedup._elizaSentFactSignatures.push(
									deliveredFactSignature,
								);
							}
						}
					}
					if (
						messages.length > 0 &&
						!providerSendFailure &&
						content.attachments?.length &&
						content.inReplyTo
					) {
						const callbackDedup = message as DiscordMessage & {
							_elizaSentAttachmentUrls?: Set<string>;
						};
						callbackDedup._elizaSentAttachmentUrls ??= new Set();
						for (const media of content.attachments) {
							if (media.url) {
								callbackDedup._elizaSentAttachmentUrls.add(media.url);
							}
						}
					}
					typingController.stop();
					if (providerSendFailure || persistenceFailures.length > 0) {
						statusReactions?.setError();
					} else {
						statusReactions?.setDone();
					}

					return persistedMemories;
				} catch (error) {
					// error-policy:J1 callback delivery boundary never releases a
					// reservation after provider acceptance, which would duplicate it.
					if (outboundReservation && acceptedMessages.length > 0) {
						const failures = acceptedMessages.map((message) =>
							callbackPersistenceFailure(message, error),
						);
						const receipt = callbackDeliveryReceipt({
							messages: acceptedMessages,
							memories: [],
							failures,
						});
						outboundReservation.commit(
							providerSendFailure ? "partially_delivered" : "delivered",
							receipt,
						);
						outboundReservation = undefined;
						responseEmitted = true;
						this.runtime.reportError("discord:callback-finalization", error, {
							channelId: channel.id,
							providerMessageIds: receipt.providerMessageIds,
						});
						typingController.stop();
						statusReactions?.setError();
						await abortPendingDraft();
						return [];
					}
					outboundReservation?.release();
					this.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Error handling message callback",
					);
					typingController.stop();
					statusReactions?.setError();
					await abortPendingDraft();
					throw error;
				}
			};

			const messagingAPI = getMessagingAPI(this.runtime);
			const messageService = getMessageService(this.runtime);
			// Advance the durable turn to DISPATCHED (increments the attempt
			// counter) immediately before we commit to a model turn. If we crash
			// during generation/send the record stays non-terminal so a later
			// redelivery resumes, bounded by the attempt counter recorded here.
			if (turnRecord) {
				turnRecord = await markDiscordTurnDispatched(this.runtime, turnRecord);
			}
			// AbortController for the whole generation attempt. On timeout we fire
			// this so the underlying model call ACTUALLY cancels instead of running
			// on as an orphan (the root cause of the alternating timeout / instant
			// pattern). The signal threads into `messageService.handleMessage`
			// options → StreamingContext → runtime.useModel → provider fetch. See
			// runGenerationWithAbortableTimeout above and __tests__/generation-abort.
			const generationAbortController = new AbortController();
			const generationSignal = generationAbortController.signal;
			let generationTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
			let coordinationHeartbeatHandle:
				| ReturnType<typeof setInterval>
				| undefined;
			try {
				if (speakerLease && coordination.heartbeatMs > 0) {
					coordinationHeartbeatHandle = setInterval(() => {
						void renewSpeakerLease(
							this.runtime,
							speakerLease as SpeakerLease,
							coordination.leaseMs,
						).catch((error) => {
							this.runtime.reportError?.(
								"discord:coordination.heartbeat",
								error,
								{
									channelId: message.channel.id,
									messageId: message.id,
									contenderToken: speakerLease?.contenderToken,
								},
							);
						});
					}, coordination.heartbeatMs);
				}
				const generationPromise = (async () => {
					if (messageService) {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using messageService API",
						);
						await messageService.handleMessage(
							this.runtime,
							newMessage,
							callback,
							{ abortSignal: generationSignal },
						);
					} else if (messagingAPI?.handleMessage) {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using messaging API handleMessage",
						);
						await messagingAPI.handleMessage(this.runtime.agentId, newMessage, {
							onResponse: callback,
						});
					} else if (messagingAPI?.sendMessage) {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using messaging API sendMessage",
						);
						await messagingAPI.sendMessage(this.runtime.agentId, newMessage, {
							onResponse: callback,
						});
					} else {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using event-based message handling",
						);
						const payload: EventPayload & {
							message: Memory;
							callback: HandlerCallback;
							accountId: string;
						} = {
							runtime: this.runtime,
							message: newMessage,
							callback,
							source: "discord",
							accountId: this.accountId,
						};
						await this.runtime.emitEvent(
							[
								DiscordEventTypes.MESSAGE_RECEIVED,
								EventType.MESSAGE_RECEIVED,
							] as string[],
							payload,
						);
					}
				})();

				// Never let the orphaned generation surface as an unhandled
				// rejection once we stop awaiting it on timeout.
				generationPromise.catch(() => {});
				if (generationTimeoutMs === null) {
					await generationPromise;
				} else {
					const timeoutPromise = new Promise<never>((_, reject) => {
						generationTimeoutHandle = setTimeout(() => {
							generationTimedOut = true;
							// Abort the underlying generation BEFORE rejecting so the
							// orphaned model call stops burning tokens and cannot race a
							// late response into this room. Without this the run stayed
							// live and poisoned the next message slot.
							generationAbortController.abort();
							reject(
								new Error(
									`Discord generation timeout after ${generationTimeoutMs}ms`,
								),
							);
						}, generationTimeoutMs);
					});

					await Promise.race([generationPromise, timeoutPromise]);
				}
			} catch (generationError) {
				const activeTaskAgentWork =
					generationTimedOut &&
					!!messageId &&
					hasActiveTaskAgentWorkForMessage(this.runtime, messageId);
				const designedAbortReason = designedTurnAbortReason(generationError);
				if (designedAbortReason) {
					typingController.stop();
					statusReactions?.setDone();
					await draftStream?.discard();
					if (speakerLease) {
						await releaseSpeakerLease(
							this.runtime,
							speakerLease,
							"designed-turn-abort",
						);
					}
					this.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							messageId: message.id,
							memoryId: messageId,
							roomId,
							reason: designedAbortReason,
						},
						"Suppressing Discord failure reply for a designed turn abort",
					);
					if (!inboundMemoryCommitted) {
						inboundMemoryCommitted =
							await this.releaseMessageProcessingIfInboundNotPersisted(
								message.id,
								inboundMemoryId,
							);
					}
					// A designed abort is terminal only once the inbound message is
					// durable. If generation was cancelled before ingress persisted,
					// leave the durable turn DISPATCHED and release the local admission
					// slot so a gateway redelivery / crash sweep can retry without data
					// loss. Marking REPLIED first made that retry impossible.
					if (inboundMemoryCommitted) {
						turnRecord = await this.closeTurnAsIngestOnly(turnRecord);
					}
					return;
				}
				this.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						messageId: message.id,
						timeoutMs: generationTimeoutMs,
						activeTaskAgentWork,
						error:
							generationError instanceof Error
								? generationError.message
								: String(generationError),
					},
					"Discord generation failed or timed out",
				);
				typingController.stop();
				if (activeTaskAgentWork) {
					statusReactions?.setDone();
					await abortPendingDraft();
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							messageId: message.id,
							memoryId: messageId,
							roomId,
							timeoutMs: generationTimeoutMs,
						},
						"Suppressing Discord timeout reply while task-agent work is still active",
					);
					return;
				}

				if (
					shouldSuppressTimeoutForInFlightDispatchForTests({
						generationTimedOut,
						responseDispatchInFlight,
					})
				) {
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							messageId: message.id,
							memoryId: messageId,
							roomId,
							timeoutMs: generationTimeoutMs,
						},
						"Suppressing Discord timeout handling while response dispatch is in flight",
					);
					return;
				}

				statusReactions?.setError();
				await abortPendingDraft();

				if (!responseEmitted) {
					await sendFailureReply(
						generationTimedOut
							? "I timed out while generating that reply. Please retry."
							: "I hit a provider issue while generating the reply. Please retry.",
					);
				}
				if (!inboundMemoryCommitted) {
					inboundMemoryCommitted =
						await this.releaseMessageProcessingIfInboundNotPersisted(
							message.id,
							inboundMemoryId,
						);
				}
				return;
			} finally {
				if (generationTimeoutHandle) {
					clearTimeout(generationTimeoutHandle);
				}
				if (coordinationHeartbeatHandle) {
					clearInterval(coordinationHeartbeatHandle);
				}
			}

			if (!responseEmitted) {
				typingController.stop();
				statusReactions?.setDone();
				await finalizePendingDraft();
				// Generation finished and the agent deliberately produced no reply
				// (IGNORE/empty). The slot must be released: left `claimed` it expires
				// and the crash sweeper re-dispatches an edge the agent CHOSE not to
				// answer, which turns every IGNORE into a recurring redelivery.
				if (speakerLease) {
					await releaseSpeakerLease(
						this.runtime,
						speakerLease,
						"no-response-emitted",
					);
				}
			}

			// Generation completed without throwing. Whether the agent emitted a
			// reply or deliberately produced none (IGNORE/empty), the turn is done:
			// mark it terminal REPLIED so a redelivery is a genuine no-op and cannot
			// loop. A crash BEFORE reaching this line leaves the record DISPATCHED,
			// so a later redelivery resumes (bounded by the attempt counter).
			if (turnRecord && !turnReplied) {
				turnRecord = await markDiscordTurnReplied(this.runtime, turnRecord);
				turnReplied = true;
			}
		} catch (error) {
			// Terminal, always: this is the only path a throw can take out of the
			// turn body, so without it the controller never resolves whenFinished
			// — leaving the user looking at a "thinking" emoji on a turn that died,
			// and leaving the drain registry holding the entry for the process
			// lifetime. Idempotent when an inner handler already settled it.
			statusReactions?.setError();
			if (!inboundMemoryCommitted) {
				inboundMemoryCommitted =
					await this.releaseMessageProcessingIfInboundNotPersisted(
						message.id,
						inboundMemoryId,
					);
			}
			this.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling message",
			);
			this.runtime.reportError?.(DISCORD_COORDINATION_AUDIT_SCOPE, error, {
				channelId: message.channel.id,
				messageId: message.id,
				accountId: this.accountId,
			});
		}
	}

	/**
	 * Processes the message content, mentions, code blocks, attachments, and URLs to generate
	 * processed content and media attachments.
	 *
	 * @param {DiscordMessage} message The message to process
	 * @returns {Promise<{ processedContent: string; attachments: Media[] }>} Processed content and media attachments
	 */
	async processMessage(
		message: DiscordMessage,
	): Promise<{ processedContent: string; attachments: Media[] }> {
		let processedContent = message.content;
		const attachments: Media[] = [];

		if (message.embeds?.length) {
			for (const i in message.embeds) {
				const embed = message.embeds[i];
				// type: rich
				processedContent += `\nEmbed #${parseInt(i, 10) + 1}:\n`;
				processedContent += `  Title:${embed.title ?? "(none)"}\n`;
				processedContent += `  Description:${embed.description ?? "(none)"}\n`;
			}
		}
		const mentionRegex = /<@!?(\d+)>/g;
		processedContent = processedContent.replace(
			mentionRegex,
			(match, entityId) => {
				const user = message.mentions.users.get(entityId);
				if (user) {
					return `${user.username} (@${entityId})`;
				}
				return match;
			},
		);

		const codeBlockRegex = /```([\s\S]*?)```/g;
		let match: RegExpExecArray | null = codeBlockRegex.exec(processedContent);
		while (match !== null) {
			const fullMatch = match[0];
			const codeBlock = match[1];
			const lines = codeBlock.split("\n");
			const title = lines[0];
			const description = lines.slice(0, 3).join("\n");
			const attachmentId =
				`code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(-5);
			attachments.push({
				id: attachmentId,
				url: "",
				title: title || "Code Block",
				source: "Code",
				description,
				text: codeBlock,
			});
			processedContent = processedContent.replace(
				fullMatch,
				`Code Block (${attachmentId})`,
			);
			match = codeBlockRegex.exec(processedContent);
		}

		if (message.attachments.size > 0) {
			attachments.push(
				...(await this.attachmentManager.processAttachments(
					message.attachments,
				)),
			);
		}

		// Extract and clean URLs from the message content
		const urls = extractUrls(processedContent, this.runtime);

		for (const url of urls) {
			// Use string literal type for getService, assume methods exist at runtime
			const videoService = this.runtime.getService(ServiceType.VIDEO) as
				| ({
						isVideoUrl?: (url: string) => boolean;
						processVideo?: (
							url: string,
							runtime: IAgentRuntime,
						) => Promise<{
							title: string;
							description: string;
							text: string;
						}>;
				  } & Service)
				| null;
			if (
				typeof videoService?.isVideoUrl === "function" &&
				typeof videoService.processVideo === "function" &&
				videoService.isVideoUrl(url)
			) {
				try {
					const videoInfo = await videoService.processVideo(url, this.runtime);

					attachments.push({
						id: `youtube-${Date.now()}`,
						url,
						title: videoInfo.title,
						source: "YouTube",
						description: videoInfo.description,
						text: videoInfo.text,
					});
				} catch (error) {
					// Handle video processing errors gracefully - the URL is still preserved in the message
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					this.runtime.logger.warn(
						`Failed to process video ${url}: ${errorMsg}`,
					);
				}
			} else {
				try {
					const fetched = await fetchDocumentFromUrl(url);
					attachments.push(fetchedUrlToAttachment(url, fetched));
					continue;
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					this.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							url,
							error: errorMsg,
						},
						"Direct URL enrichment failed; trying browser service fallback",
					);
				}

				const browserService = this.runtime.getService(ServiceType.BROWSER) as
					| ({
							getPageContent?: (
								url: string,
								runtime: IAgentRuntime,
							) => Promise<{ title?: string; description?: string }>;
					  } & Service)
					| null;
				if (!browserService) {
					this.runtime.logger.debug(
						{ src: "plugin:discord", agentId: this.runtime.agentId },
						"Skipping URL enrichment because browser service is unavailable",
					);
					continue;
				}

				try {
					this.runtime.logger.debug(
						`Fetching page content for cleaned URL: "${url}"`,
					);
					if (typeof browserService.getPageContent !== "function") {
						continue;
					}
					const { title, description: summary } =
						await browserService.getPageContent(url, this.runtime);

					attachments.push({
						id: webpageAttachmentId(url),
						url,
						title: title || "Web Page",
						source: "Web",
						description: summary,
						text: summary,
						contentType: ContentType.LINK,
					});
				} catch (error) {
					// Silently handle browser errors (certificate issues, timeouts, dead sites, etc.)
					// The URL is still preserved in the message content, just without scraped metadata
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					const errorString = String(error);

					// Check for common expected failures that don't need logging
					const isExpectedFailure =
						errorMsg.includes("ERR_CERT") ||
						errorString.includes("ERR_CERT") ||
						errorMsg.includes("Timeout") ||
						errorString.includes("Timeout") ||
						errorMsg.includes("ERR_NAME_NOT_RESOLVED") ||
						errorString.includes("ERR_NAME_NOT_RESOLVED") ||
						errorMsg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE") ||
						errorString.includes("ERR_HTTP_RESPONSE_CODE_FAILURE");

					if (!isExpectedFailure) {
						this.runtime.logger.warn(
							`Failed to fetch page content for ${url}: ${errorMsg}`,
						);
					}
					// Expected failures are silently handled - no logging needed
				}
			}
		}

		return { processedContent, attachments };
	}

	/**
	 * Asynchronously fetches the bot's username and discriminator from Discord API.
	 *
	 * @param {string} botToken The token of the bot to authenticate the request
	 * @returns {Promise<string>} A promise that resolves with the bot's username and discriminator
	 * @throws {Error} If there is an error while fetching the bot details
	 */

	async fetchBotName(botToken: string) {
		const url = "https://discord.com/api/v10/users/@me";
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bot ${botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Error fetching bot details: ${response.statusText}`);
		}

		const data = await response.json();
		const discriminator = data.discriminator;
		return (
			(data as { username: string }).username +
			(discriminator ? `#${discriminator}` : "")
		);
	}
}
