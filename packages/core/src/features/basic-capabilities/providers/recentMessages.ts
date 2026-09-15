/**
 * RECENT_MESSAGES provider — builds the canonical complete conversation
 * transcript injected into the planner prompt for the current room. Fetches all
 * retained room memories, then filters, dedupes, and
 * formats them into `# Conversation Messages` / `# Posts in Thread` blocks plus a
 * `# Received Message` / `# Focus your response` framing for the incoming turn.
 * Part of the basic-capabilities bundle and the single source of dialogue
 * history — PLATFORM_CHAT_CONTEXT carries connector metadata, not the transcript.
 *
 * The filtering is load-bearing for prompt hygiene: internal bridge rows
 * (sub-agent-router / swarm-synthesis), synthetic provider-failure replies,
 * transient orchestrator status posts, leaked tool transcripts and local-path
 * dumps are stripped so the model does not treat its own machinery as fact on a later
 * turn. Distinct dialogue occurrences retain their IDs and exact text, even when
 * wording repeats. Only identical copies of the same record are deduplicated.
 * Every retained dialogue row is rendered; runtime conversation-length
 * settings and old compaction timestamps must never silently remove prompt
 * history. Errors are reported and returned as explicit history unavailability.
 *
 * Also surfaces cross-room `recentInteractions` between the sender's verified
 * identity cluster and the agent. These are rendered in Stage 1 so a direct
 * handoff question can be answered without a retrieval round trip, but only
 * after the live destination is revalidated as an owner-exclusive DM.
 */

import { buildCrossWorldConversationAccessContext } from "../../../access-context.ts";
import { getEntityDetails } from "../../../entities.ts";
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { isInternalBridgeMessage } from "../../../messaging/automated-turns.ts";
import {
	markOwnerExclusiveDisclosureUsed,
	OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
	recordOwnerExclusiveSuppression,
	revalidateOwnerExclusiveDisclosure,
} from "../../../security/trusted-delivery-audience.ts";
import type {
	CustomMetadata,
	Entity,
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import {
	addHeader,
	conversationMessagesHeader,
	formatMessageSegments,
	formatMessages,
	formatPosts,
} from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("RECENT_MESSAGES");
const INTERNAL_TOOL_TRANSCRIPT_MARKERS = [
	"[tool output:",
	"[/tool output]",
	"[sub-agent:",
];
const SYNTHETIC_ASSISTANT_FAILURE_TEXTS = new Set([
	"sorry, i'm having a provider issue",
	"something went wrong on my end. please try again.",
	"i don't have a reply for that — try rephrasing?",
	"i don't have a reply for that - try rephrasing?",
]);
const SYNTHETIC_ASSISTANT_FAILURE_KINDS = new Set([
	"provider_issue",
	"missing_capability",
	"planner_exhaustion",
	"local_inference",
	"no_provider",
	"insufficient_credits",
	"no_response",
	"transient_failure",
	"handler_error",
	"persistence_error",
	"coding_verification_failed",
]);

function asObjectRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hasSyntheticFailureMetadata(record: Record<string, unknown> | null) {
	if (!record) return false;
	if (
		record.elizaSyntheticFailure === true ||
		record.syntheticChatFailure === true
	) {
		return true;
	}
	const failureKind =
		typeof record.failureKind === "string"
			? record.failureKind
			: typeof record.chatFailureKind === "string"
				? record.chatFailureKind
				: "";
	return SYNTHETIC_ASSISTANT_FAILURE_KINDS.has(failureKind);
}

function hasTransientMetadata(record: Record<string, unknown> | null): boolean {
	if (!record) return false;
	return record.transient === true;
}

/**
 * Filter out the agent's own *transient* status messages — sub-agent
 * spawn acks, narration chunks, heartbeats, completion summaries — from
 * the conversation memory served to the planner. Without this, the
 * planner LLM reads its own past status text and paraphrases it as
 * "facts" on later turns (e.g. a past "Can't spawn..." hallucination
 * resurfaces as a new hallucination on the next request). Mirrors
 * `isSyntheticAssistantFailureMessage` semantically; the difference is
 * scope: synthetic-failure is provider/infra noise, transient is
 * orchestrator status. Cross-platform: connector-agnostic, the flag is
 * on the persisted Memory regardless of whether the post landed in a
 * thread, an edit-in-place, or a fresh send.
 */
function isTransientStatusMessage(
	memory: Memory,
	agentId: UUID | undefined,
): boolean {
	if (!agentId || memory.entityId !== agentId) return false;
	const content = asObjectRecord(memory.content);
	return (
		hasTransientMetadata(content) ||
		hasTransientMetadata(asObjectRecord(content?.metadata)) ||
		hasTransientMetadata(asObjectRecord(memory.metadata))
	);
}

function isSyntheticAssistantFailureMessage(
	memory: Memory,
	agentId: UUID | undefined,
): boolean {
	if (!agentId || memory.entityId !== agentId) return false;

	const content = asObjectRecord(memory.content);
	if (
		hasSyntheticFailureMetadata(content) ||
		hasSyntheticFailureMetadata(asObjectRecord(content?.metadata)) ||
		hasSyntheticFailureMetadata(asObjectRecord(memory.metadata))
	) {
		return true;
	}

	const normalized = normalizeDialogueText(memory)
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/\s+/g, " ");
	if (!normalized) return false;
	if (SYNTHETIC_ASSISTANT_FAILURE_TEXTS.has(normalized)) return true;

	return (
		/\bprovider issue\b/.test(normalized) ||
		/^something went wrong on my end\b/.test(normalized)
	);
}

function isLeakedAssistantToolTranscript(
	memory: Memory,
	agentId: UUID | undefined,
): boolean {
	if (!agentId || memory.entityId !== agentId) return false;
	const text =
		typeof memory.content.text === "string" ? memory.content.text : "";
	return INTERNAL_TOOL_TRANSCRIPT_MARKERS.some((marker) =>
		text.includes(marker),
	);
}

function isLocalPathLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		(trimmed.startsWith("/") && trimmed.includes("/", 1)) ||
		/^[A-Za-z]:[\\/]/.test(trimmed)
	);
}

function isLeakedAssistantPathDump(
	memory: Memory,
	agentId: UUID | undefined,
): boolean {
	if (!agentId || memory.entityId !== agentId) return false;
	const text =
		typeof memory.content.text === "string" ? memory.content.text : "";
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 5) return false;
	const pathLineCount = lines.filter(isLocalPathLine).length;
	return pathLineCount >= 5 && pathLineCount / lines.length >= 0.6;
}

function normalizeDialogueText(memory: Memory): string {
	return typeof memory.content.text === "string"
		? memory.content.text.replace(/\s+/g, " ").trim()
		: "";
}

/**
 * The canonical dialogue-hygiene boundary predicate: true when a stored room
 * row is real conversation that may be exposed to the model, false for
 * machinery and noise — the agent's own `action_result` records, internal
 * bridge relays (sub-agent-router / swarm-synthesis), synthetic assistant
 * failure replies, transient orchestrator status posts, leaked tool
 * transcripts, and leaked local-path dumps. This is the single model-exposure
 * contract for room history: RECENT_MESSAGES applies it to the prompt
 * transcript and CHANNEL_RECAP applies it before rows count toward a
 * requested recap depth, so a row this boundary strips can never resurface
 * through either surface. Exported for that reuse — do not fork the logic.
 */
export function isHygienicDialogueMessage(
	memory: Memory,
	agentId: UUID | undefined,
): boolean {
	return (
		!(memory.content && memory.content.type === "action_result") &&
		!isInternalBridgeMessage(memory) &&
		!isSyntheticAssistantFailureMessage(memory, agentId) &&
		!isTransientStatusMessage(memory, agentId) &&
		!isLeakedAssistantToolTranscript(memory, agentId) &&
		!isLeakedAssistantPathDump(memory, agentId)
	);
}

/** Drop identical copies of the same stored record, never distinct dialogue
 * occurrences. Conflicting copies and records without IDs remain intact rather
 * than guessing identity from wording, time, speaker or connector metadata. */
export function dedupeHygienicDialogueMessages(
	messages: Memory[],
	_agentId: UUID | undefined,
): Memory[] {
	const seen = new Map<UUID, Memory>();
	return messages.filter((message) => {
		if (!message.id) return true;
		const previous = seen.get(message.id);
		if (previous && JSON.stringify(previous) === JSON.stringify(message))
			return false;
		seen.set(message.id, message);
		return true;
	});
}

function buildFormattingFallbackEntity(memory: Memory): Entity | null {
	const metadata = memory.metadata as CustomMetadata | undefined;
	const entityName =
		typeof metadata?.entityName === "string" ? metadata.entityName.trim() : "";

	if (!memory.entityId || entityName.length === 0) {
		return null;
	}

	return {
		id: memory.entityId,
		agentId: memory.agentId,
		names: [entityName],
		metadata: {
			name: entityName,
			userName: entityName,
			username: entityName,
		},
	} as Entity;
}

/**
 * Backfill formatting entities for message senders missing from the room's
 * entity list: re-resolve each missing sender by id (they may have left the
 * room but still have an entity row), then fall back to a synthetic entity
 * built from the message's stamped `entityName` metadata. Exported so the
 * CHANNEL_RECAP action names historical senders identically to this provider.
 */
export async function ensureFormattingEntities(
	runtime: IAgentRuntime,
	entities: Entity[],
	messages: Memory[],
): Promise<Entity[]> {
	const entitiesById = new Map<UUID, Entity>();
	for (const entity of entities) {
		if (entity.id) {
			entitiesById.set(entity.id, entity);
		}
	}

	const missingMessageByEntityId = new Map<UUID, Memory>();
	for (const memory of messages) {
		if (!memory.entityId || entitiesById.has(memory.entityId)) {
			continue;
		}

		if (!missingMessageByEntityId.has(memory.entityId)) {
			missingMessageByEntityId.set(memory.entityId, memory);
		}
	}

	const missingEntityIds = Array.from(missingMessageByEntityId.keys());
	if (missingEntityIds.length === 0) {
		return Array.from(entitiesById.values());
	}

	const resolvedEntities = await Promise.all(
		missingEntityIds.map((entityId) => runtime.getEntityById(entityId)),
	);

	for (let i = 0; i < missingEntityIds.length; i += 1) {
		const entityId = missingEntityIds[i];
		const resolvedEntity = resolvedEntities[i];

		if (resolvedEntity) {
			entitiesById.set(entityId, resolvedEntity);
			continue;
		}

		const fallbackMemory = missingMessageByEntityId.get(entityId);
		const fallbackEntity =
			fallbackMemory && buildFormattingFallbackEntity(fallbackMemory);
		if (fallbackEntity) {
			entitiesById.set(entityId, fallbackEntity);
		}
	}

	return Array.from(entitiesById.values());
}

// Cross-room history from rooms shared by the sender's identity cluster and
// the target entity, excluding the current room.
const getRecentInteractions = async (
	runtime: IAgentRuntime,
	message: Memory,
	targetEntityId: UUID,
	excludeRoomId: UUID,
): Promise<Memory[]> => {
	// The standalone agent installs a richer, always-on provider for this exact
	// cross-room surface. Let it own those rows so Stage 1 does not render the
	// same private transcript once as structured RECENT_MESSAGES events and a
	// second time as a recent-conversations text block. Hosts without that
	// provider continue to use core's portable fallback below.
	const hasDedicatedCrossRoomProvider = runtime.providers?.some((provider) => {
		const name = provider.name?.trim().toLowerCase();
		return (
			name === "recent-conversations" &&
			provider.alwaysInResponseState === true &&
			provider.private !== true
		);
	});
	if (hasDedicatedCrossRoomProvider) return [];

	const disclosure = await revalidateOwnerExclusiveDisclosure(runtime, message);
	if (
		!disclosure.allowed ||
		disclosure.basis !== OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
	) {
		if (!disclosure.allowed) {
			recordOwnerExclusiveSuppression(message, disclosure.reason);
		}
		return [];
	}
	if (targetEntityId !== runtime.agentId) return [];
	const accessContext = await buildCrossWorldConversationAccessContext(
		runtime,
		message,
	);
	const otherRooms = (accessContext.authorizedRoomIds ?? []).filter(
		(room) => room !== excludeRoomId,
	);
	if (otherRooms.length === 0) {
		return [];
	}

	// Check the existing memories in the database
	const interactions = await runtime.getMemoriesByRoomIds({
		tableName: "messages",
		roomIds: otherRooms,
		accessContext,
	});
	if (interactions.length > 0) {
		markOwnerExclusiveDisclosureUsed(message);
	}
	return interactions;
};

function summarizeInteractionAttachments(memory: Memory): string {
	return (memory.content.attachments ?? [])
		.map((attachment) => {
			const label =
				attachment.filename ??
				attachment.title ??
				attachment.id ??
				"attachment";
			const mediaType = attachment.mimeType ?? attachment.contentType;
			const readableContent = attachment.text ?? attachment.description;
			return `[attachment: ${label}${mediaType ? `; ${mediaType}` : ""}${readableContent ? `; ${readableContent}` : ""}]`;
		})
		.join(" ");
}

export const recentMessagesProvider: Provider = {
	name: spec.name,
	description: spec.description,
	position: spec.position ?? 100,
	contexts: ["memory", "messaging"],
	contextGate: { anyOf: ["memory", "messaging"] },
	cacheStable: false,
	cacheScope: "turn",
	// Stage 1 chooses routing contexts, so cross-world handoff evidence must be
	// available before a context gate can use that choice. The provider itself
	// revalidates owner-exclusive delivery before reading any other room.
	alwaysInResponseState: true,
	// GUEST floor: this is the CURRENT room's transcript — content every
	// participant can already read in their client. Gating it at USER made the
	// agent-host role gate (packages/agent plugin-role-gating) withhold the
	// entire conversation window from unassigned group-channel senders (they
	// resolve to GUEST), so the bot answered "chat's empty" to anyone who was
	// not a seeded admin. Cross-room/cross-platform recall stays gated on its
	// own providers (recent-conversations ADMIN, relevant-conversations USER).
	roleGate: { minRole: "GUEST" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const { roomId } = message;

			// Parallelize initial data fetching operations including recentInteractions
			const [entitiesData, recentMessagesData, recentInteractionsData, room] =
				await Promise.all([
					getEntityDetails({ runtime, roomId }),
					runtime.getMemories({
						tableName: "messages",
						roomId,
						unique: false,
					}),
					message.entityId !== runtime.agentId
						? getRecentInteractions(runtime, message, runtime.agentId, roomId)
						: Promise.resolve([]),
					runtime.getRoom(roomId),
				]);

			// Separate action results from regular messages
			const actionResultMessages = recentMessagesData.filter(
				(msg) => msg.content && msg.content.type === "action_result",
			);

			const rawDialogueMessages = recentMessagesData
				.filter((msg) => isHygienicDialogueMessage(msg, runtime.agentId))
				.sort((a, b) => {
					// Chronological (oldest first) is the order the prompt renders. A
					// non-finite `createdAt` from an adapter row made the raw subtraction
					// return NaN, which the sort spec treats as "equal", leaving the row
					// at an arbitrary position in model-facing history. Normalize it to 0
					// (oldest) and break exact ties on id so the window is deterministic.
					const aCreatedAt = a.createdAt ?? 0;
					const bCreatedAt = b.createdAt ?? 0;
					const aSafe = Number.isFinite(aCreatedAt) ? aCreatedAt : 0;
					const bSafe = Number.isFinite(bCreatedAt) ? bCreatedAt : 0;
					if (aSafe !== bSafe) return aSafe - bSafe;
					return String(a.id ?? "").localeCompare(String(b.id ?? ""));
				});
			const dialogueMessages = dedupeHygienicDialogueMessages(
				rawDialogueMessages,
				runtime.agentId,
			);

			// Room entity lookups only include current participants. Historical room
			// context can still contain messages from senders who left the room or
			// whose entity row is temporarily unavailable, so backfill those before
			// formatting to avoid noisy "No entity found for message" warnings.
			const entitiesForFormatting = await ensureFormattingEntities(
				runtime,
				entitiesData,
				[message, ...dialogueMessages],
			);

			// Default to message format if room is not found or type is undefined
			const isPostFormat = room?.type
				? room.type === ChannelType.FEED || room.type === ChannelType.THREAD
				: false;

			// Format recent messages and posts in parallel, using only dialogue messages
			const [formattedMessageSegments, formattedRecentPosts] =
				await Promise.all([
					formatMessageSegments({
						messages: dialogueMessages,
						entities: entitiesForFormatting,
					}),
					formatPosts({
						messages: dialogueMessages,
						entities: entitiesForFormatting,
						conversationHeader: false,
					}),
				]);

			const formattedRecentMessages = formattedMessageSegments.join("\n");

			// Action results are formatted exclusively by the ACTION_STATE provider
			// (position 150) to avoid duplication in the LLM context.

			// Create formatted text with headers
			const recentPostsBody =
				formattedRecentPosts && formattedRecentPosts.length > 0
					? addHeader("# Posts in Thread", formattedRecentPosts)
					: "";

			const recentPosts = recentPostsBody;

			const recentMessagesBody =
				formattedRecentMessages && formattedRecentMessages.length > 0
					? addHeader(
							conversationMessagesHeader(dialogueMessages.length),
							formattedRecentMessages,
						)
					: "";
			const recentMessages = recentMessagesBody;

			// If there are no messages at all, and no current message to process, return a specific message.
			// The check for dialogueMessages.length === 0 ensures we only show this if there's truly nothing.
			if (
				!recentPosts &&
				!recentMessages &&
				dialogueMessages.length === 0 &&
				!message.content.text
			) {
				return {
					data: {
						recentMessages: dialogueMessages,
						recentInteractions: [],
						actionResults: actionResultMessages,
					},
					values: {
						recentPosts: "",
						recentMessages: "",
						recentMessageInteractions: "",
						recentPostInteractions: "",
						recentInteractions: "",
						recentActionResults: "",
					},
					text: "No recent messages available",
				};
			}

			let recentMessage = "No recent message available.";

			if (dialogueMessages.length > 0) {
				// Get the most recent dialogue message (create a copy to avoid mutating original array)
				const mostRecentMessage = [...dialogueMessages].sort(
					(a, b) => (b.createdAt || 0) - (a.createdAt || 0),
				)[0];

				// Format just this single message to get the internal thought
				const formattedSingleMessage = formatMessages({
					messages: [mostRecentMessage],
					entities: entitiesForFormatting,
				});

				if (formattedSingleMessage) {
					recentMessage = formattedSingleMessage;
				}
			}

			// `Memory.metadata` is optional — a message with no metadata from a
			// sender whose entity row is unavailable must not throw here, or the
			// catch below silently drops the ENTIRE conversation history for the
			// turn ("No recent messages available").
			const metaData = message.metadata as CustomMetadata | undefined;
			const foundEntity = entitiesForFormatting.find(
				(entity: Entity) => entity.id === message.entityId,
			);
			const senderName =
				foundEntity?.names?.[0] || metaData?.entityName || "Unknown User";
			const receivedMessageContent = message.content.text;

			const hasReceivedMessage = !!receivedMessageContent?.trim();

			const receivedMessageHeader = hasReceivedMessage
				? addHeader(
						"# Received Message",
						`${senderName}: ${receivedMessageContent}`,
					)
				: "";

			const focusHeader = hasReceivedMessage
				? addHeader(
						"# Focus your response",
						`You are replying to the above message from **${senderName}**. Keep your answer relevant to that message, but include as context any previous messages in the thread from after your last reply.`,
					)
				: "";

			// Preload all necessary entities for both types of interactions
			const interactionEntityMap = new Map<UUID, Entity>();

			// Only proceed if there are interactions to process
			if (recentInteractionsData.length > 0) {
				// Get unique entity IDs that aren't the runtime agent
				const uniqueEntityIds = [
					...new Set(
						recentInteractionsData
							.map((message) => message.entityId)
							.filter((id) => id !== runtime.agentId),
					),
				];

				// Create a Set for faster lookup
				const uniqueEntityIdSet = new Set(uniqueEntityIds);

				// Add entities already fetched in entitiesData to the map
				const entitiesDataIdSet = new Set<UUID>();
				entitiesForFormatting.forEach((entity: Entity) => {
					const entityId = entity.id;
					if (entityId && uniqueEntityIdSet.has(entityId)) {
						interactionEntityMap.set(entityId, entity);
						entitiesDataIdSet.add(entityId);
					}
				});

				// Get the remaining entities that weren't already loaded
				// Use Set difference for efficient filtering
				const remainingEntityIds = uniqueEntityIds.filter(
					(id) => !entitiesDataIdSet.has(id),
				);

				// Only fetch the entities we don't already have
				if (remainingEntityIds.length > 0) {
					const entities = await Promise.all(
						remainingEntityIds.map((entityId) =>
							runtime.getEntityById(entityId),
						),
					);

					entities.forEach((entity, index) => {
						if (entity) {
							interactionEntityMap.set(remainingEntityIds[index], entity);
						}
					});
				}
			}

			// Format recent message interactions
			const getRecentMessageInteractions = async (
				recentInteractionsData: Memory[],
			): Promise<string> => {
				// Format messages using the pre-fetched entities
				const formattedInteractions = recentInteractionsData.map((message) => {
					const isSelf = message.entityId === runtime.agentId;
					let sender: string;

					if (isSelf) {
						sender = runtime.character.name ?? "Agent";
					} else {
						const interactionEntity = interactionEntityMap.get(
							message.entityId,
						);
						const interactionMetadata = interactionEntity?.metadata;
						sender =
							(interactionMetadata &&
								(interactionMetadata.userName as string)) ||
							"unknown";
					}

					return `${sender}: ${[
						message.content.text,
						summarizeInteractionAttachments(message),
					]
						.filter(Boolean)
						.join(" ")}`;
				});

				return formattedInteractions.join("\n");
			};

			// Format recent post interactions
			const getRecentPostInteractions = async (
				recentInteractionsData: Memory[],
				entities: Entity[],
			): Promise<string> => {
				// Combine pre-loaded entities with any other entities
				const combinedEntities = [...entities];

				// Add entities from interactionEntityMap that aren't already in entities
				const actorIds = new Set(entities.map((entity) => entity.id));
				for (const [id, entity] of interactionEntityMap.entries()) {
					if (!actorIds.has(id)) {
						combinedEntities.push(entity);
					}
				}

				const formattedInteractions = formatPosts({
					messages: recentInteractionsData,
					entities: combinedEntities,
					conversationHeader: true,
				});

				return formattedInteractions;
			};

			// Process both types of interactions in parallel
			const [recentMessageInteractions, recentPostInteractions] =
				await Promise.all([
					getRecentMessageInteractions(recentInteractionsData),
					getRecentPostInteractions(
						recentInteractionsData,
						entitiesForFormatting,
					),
				]);

			const data = {
				recentMessages: dialogueMessages,
				recentInteractions: recentInteractionsData,
				...(recentInteractionsData.length > 0
					? {
							recentInteractionsDisclosure:
								OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
						}
					: {}),
				actionResults: actionResultMessages,
			};

			const values = {
				recentPosts,
				recentMessages,
				recentMessageInteractions,
				recentPostInteractions,
				recentInteractions: isPostFormat
					? recentPostInteractions
					: recentMessageInteractions,
				recentActionResults: "",
				recentMessage,
			};

			// Combine all text sections
			const text = [
				isPostFormat ? recentPosts : recentMessages,
				recentMessageInteractions
					? addHeader(
							"# Recent conversations across verified accounts",
							recentMessageInteractions,
						)
					: "",
				// Only add received message and focus headers if there are messages or a current message to process
				recentMessages || recentPosts || message.content.text
					? receivedMessageHeader
					: "",
				recentMessages || recentPosts || message.content.text
					? focusHeader
					: "",
			]
				.filter(Boolean)
				.join("\n\n");

			return {
				data: {
					recentMessages: data.recentMessages,
					formattedMessageSegments,
					recentInteractions: data.recentInteractions,
					...(data.recentInteractionsDisclosure
						? {
								recentInteractionsDisclosure: data.recentInteractionsDisclosure,
							}
						: {}),
					actionResults: data.actionResults,
				},
				values,
				text,
			};
		} catch (error) {
			// error-policy:J4 recent-message context becomes explicitly unavailable;
			// a failed query is not a legitimate empty conversation.
			runtime.reportError("RecentMessagesProvider.get", error, {
				roomId: message.roomId,
			});
			return {
				data: {
					available: false,
					error: error instanceof Error ? error.message : String(error),
				},
				values: { recentMessagesAvailable: false },
				text: "Recent conversation context is unavailable.",
			};
		}
	},
};
