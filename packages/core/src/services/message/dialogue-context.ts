/** Builds ordered dialogue and provider context events with speaker identity and platform reply references. */

import { unwrapUserMessageText } from "../../security/incoming-message-security";
import { OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS } from "../../security/trusted-delivery-audience";
import type { ContextEvent } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import { MESSAGE_SOURCE_SUB_AGENT } from "../../types/message-source";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { extractUserText, getUserMessageText } from "../../utils/message-text";
import { toWellFormedUnicode } from "../../utils/well-formed";
import { resolveExplicitContinuationRequestText } from "./direct-action-heuristics";
import { parseSubAgentTaskCompleteRelay } from "./task-completion-relay.js";

export function asProviderRecord(value: unknown):
	| {
			text?: unknown;
			discoveryText?: unknown;
			providerName?: unknown;
	  }
	| undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as {
		text?: unknown;
		discoveryText?: unknown;
		providerName?: unknown;
	};
}

export function asPlainRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

export function cleanPriorDialogueSpeakerName(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().split(/\s+/).join(" ");
	if (!normalized) return undefined;
	return toWellFormedUnicode(normalized);
}

export function senderIdentityName(value: unknown): string | undefined {
	const record = asPlainRecord(value);
	if (!record) return undefined;
	return (
		cleanPriorDialogueSpeakerName(record.name) ??
		cleanPriorDialogueSpeakerName(record.username) ??
		cleanPriorDialogueSpeakerName(record.tag)
	);
}

export function priorDialogueSpeakerName(memory: Memory): string | undefined {
	const metadata = asPlainRecord(memory.metadata);
	const content = asPlainRecord(memory.content);
	const contentMetadata = asPlainRecord(content?.metadata);
	const sender =
		senderIdentityName(metadata?.sender) ??
		senderIdentityName(contentMetadata?.sender);
	if (sender) return sender;
	for (const record of [metadata, contentMetadata, content]) {
		const name =
			cleanPriorDialogueSpeakerName(record?.entityName) ??
			cleanPriorDialogueSpeakerName(record?.senderName) ??
			cleanPriorDialogueSpeakerName(record?.authorName) ??
			cleanPriorDialogueSpeakerName(record?.displayName) ??
			cleanPriorDialogueSpeakerName(record?.userName) ??
			cleanPriorDialogueSpeakerName(record?.username) ??
			cleanPriorDialogueSpeakerName(record?.name);
		if (name) return name;
	}
	return undefined;
}

export function priorDialogueContent(text: string, speaker?: string): string {
	if (!speaker) return text;
	const trimmedStart = text.trimStart();
	if (trimmedStart.toLowerCase().startsWith(`${speaker.toLowerCase()}:`)) {
		return text;
	}
	return `${speaker}: ${text}`;
}

export function verifiedCrossRoomContent(memory: Memory): string {
	const text = getUserMessageText(memory);
	const attachmentText = (memory.content.attachments ?? [])
		.map((attachment) => {
			const label =
				attachment.filename ??
				attachment.title ??
				attachment.id ??
				"attachment";
			const mediaType = attachment.mimeType ?? attachment.contentType;
			const readable = attachment.text ?? attachment.description;
			return `[attachment: ${label}${mediaType ? `; ${mediaType}` : ""}${readable ? `; ${readable}` : ""}]`;
		})
		.join(" ");
	return [text, attachmentText].filter(Boolean).join(" ");
}

/** Preserve ordered user and assistant dialogue while excluding non-dialogue artifacts. */
export function appendPriorDialogueEvents(
	events: ContextEvent[],
	runtime: IAgentRuntime,
	state: State,
	currentMessage: Memory,
	options?: {
		includeOwnReplies?: boolean;
	},
): void {
	const includeOwnReplies = options?.includeOwnReplies ?? false;
	const providers = state.data?.providers;
	if (!providers || typeof providers !== "object") {
		return;
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return;
	}
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(recentMessages)) {
		return;
	}
	const dialogue = recentMessages
		.filter((memory): memory is Memory => {
			if (!memory || typeof memory !== "object") return false;
			const m = memory as Memory;
			if (m.id && currentMessage.id && m.id === currentMessage.id) return false;
			if (m.entityId === runtime.agentId && !includeOwnReplies) return false;
			if (
				typeof m.content?.source === "string" &&
				m.content.source.includes("sub-agent")
			) {
				return false;
			}
			if (
				m.content?.metadata &&
				typeof m.content.metadata === "object" &&
				(m.content.metadata as { subAgent?: unknown }).subAgent === true
			) {
				return false;
			}
			const contentType =
				m.content && typeof m.content === "object"
					? (m.content as { type?: string }).type
					: undefined;
			if (contentType === "action_result") return false;
			if (isSubAgentCompletionArtifact(m)) return false;
			const text =
				typeof m.content?.text === "string" ? m.content.text.trim() : "";
			if (looksLikePriorDialogueArtifact(text)) return false;
			return text.length > 0;
		})
		.sort((a, b) => {
			const aTime = Number.isFinite(a.createdAt as unknown as number)
				? (a.createdAt as unknown as number)
				: 0;
			const bTime = Number.isFinite(b.createdAt as unknown as number)
				? (b.createdAt as unknown as number)
				: 0;
			return aTime - bTime;
		});
	for (const memory of dialogue) {
		const text = getUserMessageText(memory);
		if (!text) continue;
		const isOwnReply = memory.entityId === runtime.agentId;
		const speakerName = isOwnReply
			? (runtime.character?.name ?? priorDialogueSpeakerName(memory))
			: priorDialogueSpeakerName(memory);
		events.push({
			id: `history:${memory.id}`,
			type: "segment",
			source: "prior-dialogue",
			createdAt: memory.createdAt,
			segment: {
				id: `history:${memory.id}`,
				label: isOwnReply ? "prior_message:agent" : "prior_message:user",
				content: priorDialogueContent(text, speakerName),
				stable: false,
				metadata: {
					roomId: memory.roomId,
					entityId: memory.entityId,
					...(speakerName ? { speakerName } : {}),
				},
			},
		});
	}

	const recentInteractions =
		data &&
		typeof data === "object" &&
		(data as { recentInteractionsDisclosure?: unknown })
			.recentInteractionsDisclosure ===
			OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS &&
		Array.isArray((data as { recentInteractions?: unknown }).recentInteractions)
			? (data as { recentInteractions: unknown[] }).recentInteractions
			: [];
	for (const candidate of recentInteractions) {
		if (!candidate || typeof candidate !== "object") continue;
		const memory = candidate as Memory;
		if (memory.roomId === currentMessage.roomId) continue;
		if (memory.content?.type === "action_result") continue;
		if (isSubAgentCompletionArtifact(memory)) continue;
		if (memory.entityId === runtime.agentId && !includeOwnReplies) {
			continue;
		}
		const content = verifiedCrossRoomContent(memory);
		if (!content || looksLikePriorDialogueArtifact(content)) continue;
		const isOwnReply = memory.entityId === runtime.agentId;
		const speakerName = isOwnReply
			? (runtime.character?.name ?? priorDialogueSpeakerName(memory))
			: priorDialogueSpeakerName(memory);
		events.push({
			id: `verified-cross-room:${memory.id}`,
			type: "segment",
			source: "verified-cross-room-context",
			createdAt: memory.createdAt,
			segment: {
				id: `verified-cross-room:${memory.id}`,
				label: isOwnReply
					? "verified_cross_room_message:agent"
					: "verified_cross_room_message:user",
				content: priorDialogueContent(content, speakerName),
				stable: false,
				metadata: {
					roomId: memory.roomId,
					entityId: memory.entityId,
					disclosureBasis: OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
					...(speakerName ? { speakerName } : {}),
				},
			},
		});
	}
}

export function currentMessageContentForContext(
	message: Memory,
): Memory["content"] {
	const currentText = getUserMessageText(message);
	const content = message.content;
	if (!content || typeof content !== "object") {
		return content;
	}
	const projected =
		currentText &&
		typeof content.text === "string" &&
		content.text !== currentText
			? { ...content, text: currentText }
			: content;
	if (
		content.source !== "client_chat" ||
		content.channelType !== ChannelType.DM
	) {
		return projected;
	}
	// These client-chat carriers belong to replay protection and UI dispatch,
	// not the model's request. Never mutate the Memory used by persistence,
	// recovery or action execution, and retain every other content/metadata key.
	const modelContent = { ...projected };
	delete modelContent.chatIdempotency;
	const metadata = modelContent.metadata;
	if (
		metadata &&
		typeof metadata === "object" &&
		!Array.isArray(metadata) &&
		"viewClientId" in metadata
	) {
		const modelMetadata = { ...metadata };
		delete modelMetadata.viewClientId;
		modelContent.metadata = modelMetadata;
	}
	return modelContent;
}

export function readMessageContentString(
	message: Memory,
	key: string,
): string | undefined {
	const content = message.content;
	if (!content || typeof content !== "object") return undefined;
	const value = (content as Record<string, unknown>)[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export type PlatformReplyReference = {
	text: string;
	sender?: string;
	externalId?: string;
};

export const PLATFORM_REPLY_REFERENCE_START = "[platform_reply_reference]";

export const PLATFORM_REPLY_REFERENCE_END = "[/platform_reply_reference]";

export function valueAfterPrefix(
	line: string,
	prefix: string,
): string | undefined {
	if (!line.startsWith(prefix)) return undefined;
	const value = line.slice(prefix.length).trim();
	return value.length > 0 ? value : undefined;
}

export function parsePlatformReplyReferenceBlock(
	text: string | undefined,
): PlatformReplyReference | null {
	if (!text) return null;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let start = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (lines[index]?.trim() === PLATFORM_REPLY_REFERENCE_START) {
			start = index;
			break;
		}
	}
	if (start === -1) return null;
	const end = lines.findIndex(
		(line, index) =>
			index > start && line.trim() === PLATFORM_REPLY_REFERENCE_END,
	);
	if (end === -1) return null;

	const body = lines.slice(start + 1, end);
	const textIndex = body.findIndex((line) => line.trim() === "text:");
	if (textIndex === -1) return null;

	let sender: string | undefined;
	let externalId: string | undefined;
	for (const line of body.slice(0, textIndex)) {
		const trimmed = line.trim();
		sender ??= valueAfterPrefix(trimmed, "author:");
		externalId ??= valueAfterPrefix(trimmed, "message_id:");
	}

	const referenceText = body
		.slice(textIndex + 1)
		.join("\n")
		.trim();
	return referenceText ? { text: referenceText, sender, externalId } : null;
}

export function replyReferenceForContext(
	message: Memory,
): PlatformReplyReference | null {
	const explicitText = readMessageContentString(message, "replyToMessageText");
	if (explicitText) {
		return {
			text: explicitText,
			sender: readMessageContentString(message, "replyToSenderName"),
			externalId: readMessageContentString(message, "replyToExternalMessageId"),
		};
	}

	const content = message.content;
	return parsePlatformReplyReferenceBlock(
		content && typeof content === "object" && typeof content.text === "string"
			? content.text
			: undefined,
	);
}

export function replyReferenceEventForContext(
	message: Memory,
): ContextEvent | null {
	const reference = replyReferenceForContext(message);
	if (!reference) return null;
	const header = reference.sender
		? `${reference.sender}: ${reference.text}`
		: reference.text;
	const externalId = reference.externalId;
	const id = `reply-reference:${message.id ?? externalId ?? "current"}`;
	return {
		id,
		type: "segment",
		source: message.content.source ?? "platform",
		segment: {
			id,
			label: "reply_reference",
			content: externalId
				? `${header}\n(platform message id: ${externalId})`
				: header,
			stable: false,
		},
	};
}

export function isSubAgentCompletionArtifact(memory: Memory): boolean {
	const content = memory.content;
	if (!content || typeof content !== "object") return false;
	const metadata =
		content.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>)
			: undefined;
	const source = typeof content.source === "string" ? content.source : "";
	return source === MESSAGE_SOURCE_SUB_AGENT && metadata?.subAgent === true;
}

/** The inbound turn has the routing shape of a finished sub-agent lane. This
 * classifier controls presentation only; it does not prove that any claimed
 * effect occurred. */
export function isTaskCompleteRelayTurn(memory: Memory): boolean {
	return (
		isSubAgentCompletionArtifact(memory) &&
		parseSubAgentTaskCompleteRelay(String(memory.content?.text ?? "")) !==
			undefined
	);
}

export function looksLikePriorDialogueArtifact(text: string): boolean {
	if (!text) return false;
	return /^\s*\[(?:sub-agent|tool output|tool result|command output)\b/im.test(
		text,
	);
}

export function getStructuredRecentMessages(
	state: State | undefined,
): Memory[] | null {
	const providers = state?.data?.providers;
	if (!providers || typeof providers !== "object") {
		return null;
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return null;
	}
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	return Array.isArray(recentMessages) ? (recentMessages as Memory[]) : null;
}

export function hasStructuredRecentMessagesProvider(state: State): boolean {
	return getStructuredRecentMessages(state) !== null;
}

/**
 * Resolves an explicit continuation turn ("finish my request", "that is
 * good") to the nearest prior user request from the composed RECENT_MESSAGES
 * window so candidate inference reruns against the request the turn refers
 * to. Returns null for every non-continuation turn (topic switches, fresh
 * asks, and turns without structured history are untouched); the resolved
 * text feeds ONLY action-candidate inference — the prompt keeps the user's
 * literal message.
 */
export function resolveContinuationInferenceMessageText(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
): string | null {
	const currentText = getActionInferenceMessageText(message);
	if (!currentText?.trim()) return null;
	const recentMessages = getStructuredRecentMessages(state);
	if (!recentMessages) return null;
	return resolveExplicitContinuationRequestText(
		currentText,
		recentMessages,
		runtime.agentId,
		message.entityId,
		message.id,
	);
}

/**
 * Returns only the authenticated user payload for deterministic action routing.
 * The model-facing external-content envelope intentionally contains imperative
 * security examples (for example, "Delete data"); treating that armor as user
 * intent can combine one of those verbs with an unrelated payload noun and
 * force a tool the user never requested.
 */
export function getActionInferenceMessageText(message: Memory): string {
	return extractUserText(unwrapUserMessageText(message));
}

export function getRecentConversationSearchText(
	state: State | undefined,
	currentMessage: Memory,
): string[] {
	const providers = state?.data?.providers;
	if (!providers || typeof providers !== "object") {
		return [];
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return [];
	}
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(recentMessages)) {
		return [];
	}
	return recentMessages
		.filter((memory): memory is Memory & { content: { text: string } } => {
			if (!memory || typeof memory !== "object") return false;
			if (memory.id && currentMessage.id && memory.id === currentMessage.id) {
				return false;
			}
			if (isSubAgentCompletionArtifact(memory)) return false;
			return typeof memory.content?.text === "string";
		})
		.sort((a, b) => {
			const aTime = Number.isFinite(a.createdAt as unknown as number)
				? (a.createdAt as unknown as number)
				: 0;
			const bTime = Number.isFinite(b.createdAt as unknown as number)
				? (b.createdAt as unknown as number)
				: 0;
			return bTime - aTime;
		})
		.map((memory) => memory.content.text.trim())
		.filter(Boolean);
}

export function appendStateProviderEvents(
	events: ContextEvent[],
	state: State,
	excludedProviderNames?: readonly string[],
	providerDefinitions?: readonly { name: string; cacheStable?: boolean }[],
): void {
	const providers = state.data?.providers;
	const excluded = excludedProviderNames
		? new Set(excludedProviderNames.map((name) => name.toUpperCase()))
		: null;
	// Provider.cacheStable lives on the registered provider definition, not on
	// composeState's per-call ProviderResult, so resolve it by name here and
	// stamp it on the event for context-renderer.ts to read.
	const cacheStableByName = new Map<string, boolean>();
	if (providerDefinitions) {
		for (const def of providerDefinitions) {
			if (typeof def.cacheStable === "boolean") {
				cacheStableByName.set(def.name.toUpperCase(), def.cacheStable);
			}
		}
	}
	if (!providers || typeof providers !== "object") {
		const fallbackText =
			typeof state.text === "string" ? state.text.trim() : "";
		if (fallbackText) {
			events.push({
				id: "state:fallback",
				type: "provider",
				source: "composeState",
				name: "COMPOSED_STATE",
				text: fallbackText,
			});
		}
		return;
	}

	const providerOrder = Array.isArray(state.data.providerOrder)
		? state.data.providerOrder.map((name) => String(name))
		: Object.keys(providers).sort();
	const seen = new Set<string>();
	for (const providerName of providerOrder) {
		if (seen.has(providerName)) {
			continue;
		}
		seen.add(providerName);
		if (excluded?.has(providerName.toUpperCase())) {
			continue;
		}
		if (
			providerName.toUpperCase() === "RECENT_MESSAGES" &&
			hasStructuredRecentMessagesProvider(state)
		) {
			continue;
		}
		const provider = asProviderRecord(
			(providers as Record<string, unknown>)[providerName],
		);
		if (!provider) {
			continue;
		}
		const text = typeof provider.text === "string" ? provider.text.trim() : "";
		if (!text) {
			continue;
		}
		const resolvedName =
			typeof provider.providerName === "string"
				? provider.providerName
				: providerName;
		events.push({
			id: `provider:${providerName}`,
			type: "provider",
			source: "composeState",
			name: resolvedName,
			text,
			...(typeof provider.discoveryText === "string"
				? { discoveryText: provider.discoveryText }
				: {}),
			cacheStable: cacheStableByName.get(resolvedName.toUpperCase()),
		});
	}
}
