/**
 * `DiscordService` — the connector's main gateway service. Wraps a discord.js
 * `Client`, logs in with the configured bot token(s), and drives inbound and
 * outbound messages, voice, slash-command and interaction handling, reactions,
 * channel-history backfill, and profile sync.
 *
 * It emits `DiscordEventTypes.*` on the runtime and composes most of the other
 * files in this plugin (messages, messaging, debouncer, history, events,
 * interactions, reactions, voice, identity, allowlist) as helpers. This is the
 * service registered from `index.ts` under the `"discord"` type key.
 */

import nodePath from "node:path";
import {
	ChannelType,
	type Character,
	type Content,
	ContentType,
	createUniqueUuid,
	ElizaError,
	type EventPayload,
	getConnectorAdminWhitelist,
	getVerifiedRelatedEntityIds,
	type IAgentRuntime,
	logInboundDrop,
	type Media,
	type Memory,
	MemoryType,
	type MessageConnectorChatContext,
	type MessageConnectorCreateThreadParams,
	type MessageConnectorManageServerAuthorization,
	type MessageConnectorManageServerDestination,
	type MessageConnectorPostToThreadParams,
	type MessageConnectorQueryContext,
	type MessageConnectorTarget,
	type MessageConnectorTypingParams,
	type MessageConnectorUserContext,
	parseBooleanFromText,
	type Room,
	resolveStateDir,
	type SendHandlerOutcome,
	type SendHandlerPersistence,
	type SendHandlerPersistenceFailure,
	type SendHandlerReceipt,
	Service,
	setConnectorAdminWhitelist,
	stringToUuid,
	type TargetInfo,
	type ThreadHandle,
	toWellFormedUnicode,
	truncateWellFormed,
	type UUID,
	type World,
} from "@elizaos/core";
/**
 * IMPORTANT: Discord ID Handling - Why stringToUuid() instead of asUUID()
 *
 * Discord uses "snowflake" IDs - large 64-bit integers represented as strings
 * (e.g., "1253563208833433701"). These are NOT valid UUIDs.
 *
 * UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (8-4-4-4-12 hex digits with dashes)
 * Discord ID:  1253563208833433701 (plain number string)
 *
 * The two UUID-related functions behave differently:
 *
 * - `asUUID(str)` - VALIDATES that the string is already a valid UUID format.
 *   If not, it throws: "Error: Invalid UUID format: 1253563208833433701"
 *   Use only when you're certain the input is already a valid UUID.
 *
 * - `stringToUuid(str)` - CONVERTS any string into a deterministic UUID by hashing it.
 *   Always succeeds. The same input always produces the same UUID output.
 *   Use this for Discord snowflake IDs.
 *
 * When working with Discord IDs in ElizaOS:
 *
 * 1. `stringToUuid(discordId)` - For storing Discord IDs in UUID fields (e.g., `messageServerId`).
 *
 * 2. `createUniqueUuid(runtime, discordId)` - For `worldId` and `roomId`. This adds the agent's
 *    ID to the hash, ensuring each agent has its own unique namespace for the same Discord server.
 *
 * 3. `messageServerId` - The correct property name for server IDs on Room and World objects.
 *
 * 4. Discord-specific events (e.g., DiscordEventTypes.VOICE_STATE_UPDATE) are not in core's
 *    EventPayloadMap. When emitting these events, cast to `string[]` and payload to `any`
 *    to use the generic emitEvent overload.
 */
import {
	ActivityType,
	type Attachment,
	type AttachmentBuilder,
	type BaseGuildVoiceChannel,
	type Channel,
	type Collection,
	ChannelType as DiscordChannelType,
	Client as DiscordJsClient,
	Events,
	GatewayIntentBits,
	type Guild,
	type GuildMember,
	type GuildTextBasedChannel,
	type Interaction,
	type Message,
	type MessageReaction,
	type PartialMessageReaction,
	Partials,
	type PartialUser,
	PermissionsBitField,
	type TextChannel,
	ThreadAutoArchiveDuration,
	type ThreadChannel,
	type User,
	type Webhook,
} from "discord.js";
import {
	DiscordAccountClientPool,
	type DiscordAccountClientState,
} from "./account-client-pool";
import {
	DEFAULT_ACCOUNT_ID,
	listEnabledDiscordAccounts,
	normalizeAccountId,
	type ResolvedDiscordAccount,
	resolveDefaultDiscordAccountId,
} from "./accounts";
import type { IDiscordAudioSink } from "./audio-sink";
import type { ICompatRuntime } from "./compat";
import { DISCORD_SERVICE_NAME } from "./constants";
import type { ChannelDebouncer } from "./debouncer";
import { DiscordVoiceTargetAudioSink } from "./discord-audio-sink";
import { handleGuildCreate as handleGuildCreateExtracted } from "./discord-commands";
import {
	type DiscordServiceInternals,
	setupDiscordEventListeners,
} from "./discord-events";
import {
	buildMemoryFromMessage as buildMemoryFromMessageExtracted,
	fetchChannelHistory as fetchChannelHistoryExtracted,
	type HistoryServiceInternals,
} from "./discord-history";
import {
	handleInteractionCreate as handleInteractionCreateExtracted,
	type InteractionServiceInternals,
	onReady as onReadyExtracted,
} from "./discord-interactions";
import {
	handleReactionAdd as handleReactionAddExtracted,
	handleReactionRemove as handleReactionRemoveExtracted,
	type ReactionServiceInternals,
} from "./discord-reactions";
import { DmChannelRegistry } from "./dm-channel-registry";
import { getDiscordSettings } from "./environment";
import {
	executeGuildManagement,
	type GuildManagementReceipt,
	type GuildManagementRequest,
	type ManageableGuild,
	resolveGuildManagementGates,
	type TemplateStateStore,
} from "./guild-management";
import {
	resolveDiscordManageServerDestination,
	revalidateDiscordManageServerAuthorization,
} from "./guild-management-authorization";
import type { GuildTemplate } from "./guild-templates";
import {
	extractDiscordOwnerUserIds,
	extractDiscordTeamAdminUserIds,
	isAliasedDiscordEntityId,
	parseDiscordOwnerUserIds,
	resolveDiscordRuntimeEntityId,
	resolveElizaOwnerEntityId,
} from "./identity";
import { buildDiscordReplyPayload } from "./interactions";
import {
	beginDiscordOutboundDelivery,
	createDiscordMessageMemoryOnce,
	type DiscordOutboundDeliveryReservation,
	INTERACTION_ONLY_FALLBACK_TEXT,
	MessageManager,
} from "./messages";
import { chunkDiscordText } from "./messaging";
import {
	createTurnDrainRegistry,
	DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from "./shutdown-drain";
import {
	registerDiscordSlashCommands,
	type SlashCommandRegistrationHost,
} from "./slash-command-registration";
import {
	reconcileStrandedStatusReactions,
	reopenPersistedDms,
	STARTUP_REACTION_SCAN_SETTING,
} from "./startup-reaction-reconcile";
import type { StatusReactionController } from "./status-reactions";
import type {
	BuildMemoryFromMessageOptions,
	ChannelHistoryOptions,
	ChannelHistoryResult,
	DiscordSettings,
	DiscordSlashCommand,
	IDiscordService,
} from "./types";
import { DiscordEventTypes } from "./types";
import {
	buildDiscordComponents,
	buildOutboundDiscordAttachment,
	MAX_MESSAGE_LENGTH,
	normalizeDiscordMessageText,
	splitMessage,
} from "./utils";
import { VoiceManager } from "./voice";
import {
	type DiscordVoiceTarget,
	type DiscordVoiceTargetRegistration,
	DiscordVoiceTargetRegistry,
} from "./voice-target-registry";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{15,20}$/;

// Loose coercion for planner-supplied manage_server params: unknown shapes
// collapse to undefined so the management module's own validation reports
// missing fields instead of type errors leaking through.
function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "yes", "1", "on"].includes(normalized)) return true;
		if (["false", "no", "0", "off"].includes(normalized)) return false;
	}
	return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		if (typeof value === "string" && value.trim()) {
			return value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
		}
		return undefined;
	}
	return value.filter(
		(entry): entry is string =>
			typeof entry === "string" && Boolean(entry.trim()),
	);
}
type MessageConnectorRegistration = Parameters<
	IAgentRuntime["registerMessageConnector"]
>[0];

type DiscordSettingsForEvents = DiscordSettings & {
	shouldIgnoreBotMessages: boolean;
};

type DiscordAccountServiceFacade = IDiscordService &
	DiscordServiceInternals &
	HistoryServiceInternals &
	InteractionServiceInternals &
	ReactionServiceInternals & {
		client: DiscordJsClient;
		discordSettings: DiscordSettingsForEvents;
		admitInboundMessage(messageId: string, channelId: string): boolean;
		commandRegistrationQueue: Promise<void>;
		addAllowedChannel(channelId: string): boolean;
		removeAllowedChannel(channelId: string): boolean;
		getAllowedChannels(): string[];
		registerVoiceTarget(target: DiscordVoiceTargetRegistration): void;
		unregisterVoiceTarget(
			accountId: string,
			guildId: string,
			channelId: string,
		): void;
		isVoiceChannelClaimed(guildId: string, channelId: string): boolean;
	};

// Initial-login retry schedule. discord.js only auto-reconnects once a gateway
// session exists, so a transient failure of the FIRST `client.login()` is
// otherwise terminal — the process stays "active" but deaf (#15855). We retry
// the initial connect with capped exponential backoff (base doubles per
// attempt, clamped) and keep retrying indefinitely until a session is
// established; the network coming back is the only success condition.
const DISCORD_LOGIN_RETRY_BASE_MS = 1_000;
const DISCORD_LOGIN_RETRY_MAX_MS = 60_000;
// While an account is stuck in the failed state, warn at most this often so the
// retry storm surfaces as an observable heartbeat without flooding the log.
const DISCORD_LOGIN_HEARTBEAT_MIN_INTERVAL_MS = 30_000;
const DISCORD_TERMINAL_INITIAL_LOGIN_CLOSE_CODES = new Set([
	4004, // Authentication failed: the configured token cannot open a session.
	4010, // Invalid shard: retrying the same shard parameters cannot succeed.
	4011, // Sharding required: configuration must change before login can work.
	4012, // Invalid API version: discord.js/package config must change.
	4013, // Invalid intents: bot gateway intents are misconfigured.
	4014, // Disallowed intents: privileged intents must be enabled in Discord.
]);

// Forward Content.metadata onto the persisted Memory (e.g. `transient: true`
// for orchestrator status posts). Plain-object guard so arrays/instances don't leak through.
function extractContentMetadata(
	content: Content | undefined,
): Record<string, unknown> {
	const meta = content?.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as Record<string, unknown>;
}

function deliveryErrorCode(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code.trim().length > 0
	) {
		return error.code;
	}
	return "DISCORD_LOCAL_PERSISTENCE_FAILED";
}

function deliveryErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function providerMessageIds(
	messages: readonly Message[],
): [string, ...string[]] {
	const ids = messages.map((message) => message.id);
	const first = ids[0];
	if (!first) {
		throw new Error(
			"Discord cannot build a provider receipt without an accepted message.",
		);
	}
	return [first, ...ids.slice(1)];
}

function buildDiscordSendReceipt(input: {
	messages: readonly Message[];
	acceptedAt: number;
	persistedMemories: readonly Memory[];
	failures: readonly SendHandlerPersistenceFailure[];
}): SendHandlerReceipt {
	let persistence: SendHandlerPersistence;
	if (input.failures.length === 0) {
		persistence = {
			status: "persisted",
			memoryIds: input.persistedMemories.flatMap((memory) =>
				memory.id ? [memory.id] : [],
			),
		};
	} else if (input.persistedMemories.length > 0) {
		persistence = {
			status: "partial",
			memoryIds: input.persistedMemories.flatMap((memory) =>
				memory.id ? [memory.id] : [],
			),
			failures: input.failures,
		};
	} else {
		persistence = {
			status: "failed",
			failures: input.failures,
		};
	}
	return {
		providerMessageIds: providerMessageIds(input.messages),
		acceptedAt: input.acceptedAt,
		persistence,
	};
}

function isGuildTextBasedChannel(
	channel: Channel | null,
): channel is GuildTextBasedChannel {
	if (!channel) return false;
	const candidate = channel as Channel & {
		isTextBased?: () => boolean;
		guild?: unknown;
	};
	return candidate.isTextBased?.() === true && Boolean(candidate.guild);
}

type ConnectorFetchMessagesParams = {
	target?: TargetInfo;
	accountId?: string;
	limit?: number;
	before?: string;
	after?: string;
	cursor?: string;
	channelId?: string;
	roomId?: UUID;
	threadId?: string;
};

type ConnectorSearchMessagesParams = ConnectorFetchMessagesParams & {
	query?: string;
	author?: string;
};

type ConnectorMessageMutationParams = {
	target?: TargetInfo;
	accountId?: string;
	channelId?: string;
	roomId?: UUID;
	threadId?: string;
	messageId?: string;
	emoji?: string;
	remove?: boolean;
	pin?: boolean;
	text?: string;
	content?: Content;
};

type ConnectorChannelMutationParams = {
	target?: TargetInfo;
	accountId?: string;
	channelId?: string;
	roomId?: UUID;
	alias?: string;
};

type ConnectorUserLookupParams = {
	accountId?: string;
	userId?: string;
	username?: string;
	handle?: string;
	query?: string;
};

type ConnectorTypingParams = MessageConnectorTypingParams & {
	accountId?: string;
	channelId?: string;
	roomId?: UUID;
};

type ConnectorCreateThreadParams = MessageConnectorCreateThreadParams & {
	accountId?: string;
	channelId?: string;
	roomId?: UUID;
};

type ConnectorPostToThreadParams = MessageConnectorPostToThreadParams & {
	accountId?: string;
};

function discordReplyReferenceFromContent(
	content: Content,
): string | undefined {
	const record = content as Record<string, unknown>;
	const metadata =
		record.metadata && typeof record.metadata === "object"
			? (record.metadata as Record<string, unknown>)
			: undefined;
	const candidates = [
		record.replyToExternalMessageId,
		record.inReplyTo,
		metadata?.originConnectorMessageId,
		metadata?.replyToExternalMessageId,
		metadata?.platformMessageId,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && /^\d{16,22}$/.test(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

type ExtendedMessageConnectorRegistration = MessageConnectorRegistration & {
	listServers?: (context: MessageConnectorQueryContext) => Promise<World[]>;
	fetchMessages?: (
		context: MessageConnectorQueryContext,
		params: ConnectorFetchMessagesParams,
	) => Promise<Memory[]>;
	searchMessages?: (
		context: MessageConnectorQueryContext,
		params: ConnectorSearchMessagesParams,
	) => Promise<Memory[]>;
	reactHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<void>;
	editHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<Memory>;
	deleteHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<void>;
	pinHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<void>;
	joinHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	) => Promise<Room | null>;
	leaveHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	) => Promise<void>;
	getUser?: (
		runtime: IAgentRuntime,
		params: ConnectorUserLookupParams,
	) => Promise<unknown>;
	resolveManageServerDestination?: (
		runtime: IAgentRuntime,
		params: { target?: TargetInfo; serverId: string },
	) =>
		| Promise<MessageConnectorManageServerDestination>
		| MessageConnectorManageServerDestination;
	manageServerHandler?: (
		runtime: IAgentRuntime,
		params: {
			target?: TargetInfo;
			operation: string;
			serverId?: string;
			authorization: MessageConnectorManageServerAuthorization;
			params?: Record<string, unknown>;
		},
	) => Promise<{ summary: string; data?: Record<string, unknown> }>;
};

const DISCORD_CONNECTOR_CONTEXTS = ["social", "connectors"];
const DISCORD_CONNECTOR_CAPABILITIES = [
	"send_message",
	"read_messages",
	"search_messages",
	"resolve_targets",
	"list_rooms",
	"list_servers",
	"chat_context",
	"user_context",
	"react_message",
	"edit_message",
	"delete_message",
	"pin_message",
	"join_channel",
	"leave_channel",
	"get_user",
	"typing_indicator",
	"create_thread",
	"post_to_thread",
	"webhook_identity",
	"rich_components",
	"rich_embed",
	"manage_server",
];

function normalizeDiscordConnectorQuery(value: string): string {
	return value
		.trim()
		.replace(/^<#(\d+)>$/, "$1")
		.replace(/^<@!?(\d+)>$/, "$1")
		.replace(/^#/, "")
		.replace(/^@/, "")
		.toLowerCase();
}

function normalizeRequestedConnectorLimit(
	limit: number | undefined,
): number | undefined {
	if (limit === undefined) return undefined;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RangeError(
			"Discord connector limit must be a positive safe integer",
		);
	}
	return limit;
}

function scoreDiscordConnectorMatch(
	query: string,
	id: string,
	labels: Array<string | null | undefined>,
): number {
	if (!query) {
		return 0.45;
	}
	if (id === query) {
		return 1;
	}

	let bestScore = 0;
	for (const label of labels) {
		const normalized = label?.trim().toLowerCase();
		if (!normalized) {
			continue;
		}
		if (normalized === query) {
			bestScore = Math.max(bestScore, 0.95);
		} else if (normalized.startsWith(query)) {
			bestScore = Math.max(bestScore, 0.85);
		} else if (normalized.includes(query)) {
			bestScore = Math.max(bestScore, 0.7);
		}
	}
	return bestScore;
}

/** Attachment records for a history read: identity, url, name and kind only. */
export function historyAttachmentMedia(
	attachments: Iterable<
		Pick<Attachment, "id" | "url" | "name" | "contentType">
	>,
): Media[] {
	const media: Media[] = [];
	for (const attachment of attachments) {
		const mime = (attachment.contentType ?? "").toLowerCase();
		const contentType = mime.startsWith("image/")
			? ContentType.IMAGE
			: mime.startsWith("video/")
				? ContentType.VIDEO
				: mime.startsWith("audio/")
					? ContentType.AUDIO
					: ContentType.DOCUMENT;
		media.push({
			id: attachment.id,
			url: attachment.url,
			title: attachment.name ?? "attachment",
			source: "discord",
			contentType,
			description: "",
			text: "",
		});
	}
	return media;
}

function isDiscordTextTarget(channel: unknown): boolean {
	const maybeChannel = channel as {
		isTextBased?: () => boolean;
		isVoiceBased?: () => boolean;
	};
	return Boolean(
		maybeChannel.isTextBased?.() && !maybeChannel.isVoiceBased?.(),
	);
}

function normalizeDiscordTargetUserId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return DISCORD_SNOWFLAKE_PATTERN.test(trimmed) ? trimmed : null;
}

function extractDiscordUserIdFromMetadata(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object") {
		return null;
	}

	const record = metadata as Record<string, unknown>;
	const discord =
		record.discord && typeof record.discord === "object"
			? (record.discord as Record<string, unknown>)
			: null;

	return (
		normalizeDiscordTargetUserId(discord?.userId) ??
		normalizeDiscordTargetUserId(discord?.id) ??
		normalizeDiscordTargetUserId(record.originalId)
	);
}

function stringArraySetting(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const values = value
			.map((item) => String(item).trim())
			.filter((item) => item.length > 0);
		return values.length > 0 ? values : undefined;
	}
	if (typeof value === "string" && value.trim()) {
		const values = value
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return values.length > 0 ? values : undefined;
	}
	return undefined;
}

function accountIdFromRecord(value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const accountId = (value as { accountId?: unknown }).accountId;
	return typeof accountId === "string" && accountId.trim()
		? accountId.trim()
		: undefined;
}

type DiscordAccountSettingsConfig = ResolvedDiscordAccount["config"] &
	Partial<DiscordSettings> & {
		allowedChannelIds?: string[];
		channelIds?: string[];
		listenChannelIds?: string[];
		dm?: {
			policy?: DiscordSettings["dmPolicy"];
			allowFrom?: Array<string | number>;
		};
	};

/**
 * DiscordService class representing a service for interacting with Discord.
 * @extends Service
 * @implements IDiscordService
 * @property {string} serviceType - The type of service, set to DISCORD_SERVICE_NAME.
 * @property {string} capabilityDescription - A description of the service's capabilities.
 * @property {DiscordJsClient} client - The DiscordJsClient used for communication.
 * @property {Character} character - The character associated with the service.
 * @property {MessageManager} messageManager - The manager for handling messages.
 * @property {VoiceManager} voiceManager - The manager for handling voice communication.
 */

export class DiscordService extends Service implements IDiscordService {
	// Override runtime type for messageServerId cross-core compatibility (see compat.ts)
	protected declare runtime: ICompatRuntime;

	static serviceType: string = DISCORD_SERVICE_NAME;
	capabilityDescription =
		"The agent is able to send and receive messages on discord";
	/**
	 * Connector account ID this service instance speaks for. Single-account
	 * env-only deployments use DEFAULT_ACCOUNT_ID. When the multi-account
	 * pool is wired in, each pool slot owns one client and one accountId.
	 */
	public accountId: string = DEFAULT_ACCOUNT_ID;
	private defaultAccountId = DEFAULT_ACCOUNT_ID;
	private readonly accountPool = new DiscordAccountClientPool();
	private readonly voiceTargets = new DiscordVoiceTargetRegistry();
	private readonly audioSinks = new Map<string, IDiscordAudioSink>();
	/**
	 * Serializes one template reconciliation per account/guild/template within
	 * this DiscordService instance. A service instance owns the Discord clients
	 * for its configured accounts, so this covers concurrent deliveries through
	 * those facades; it is intentionally not a cross-process distributed lock.
	 */
	private guildTemplateReconcileLocks = new Map<string, Promise<void>>();
	/**
	 * In-flight message turns and their status-reaction controllers, so
	 * `stop()` can drain outstanding work (bounded) and reconcile any
	 * reaction left showing "in progress" instead of tearing down mid-turn.
	 */
	private readonly turnDrainRegistry = createTurnDrainRegistry();
	/**
	 * Shared across every account facade. `stop()` closes this synchronously
	 * before it awaits the turn drain, so gateway deliveries racing shutdown can
	 * never start a new message turn behind the drain snapshot.
	 */
	private ingressClosedReason: string | null = null;
	client: DiscordJsClient | null = null;
	character: Character;
	discordSettings: DiscordSettings;
	messageManager?: MessageManager;
	voiceManager?: VoiceManager;
	private channelDebouncer?: ChannelDebouncer;
	private _loginFailed = false;
	private timeouts: ReturnType<typeof setTimeout>[] = [];
	public clientReadyPromise: Promise<void> | null = null;
	/**
	 * List of allowed channel IDs (parsed from CHANNEL_IDS env var).
	 * If undefined, all channels are allowed.
	 */
	private allowedChannelIds?: string[];

	/**
	 * Set of dynamically added channel IDs through joinChannel action.
	 * These are merged with allowedChannelIds for runtime channel management.
	 */
	private dynamicChannelIds: Set<string> = new Set();
	private ownerDiscordUserIds: Set<string> = new Set();

	// Slash command registration state. Mutated by registerSlashCommands and
	// read by onReadyExtracted via the InteractionServiceInternals contract.
	public slashCommands: DiscordSlashCommand[] = [];
	private commandRegistrationQueue: Promise<void> = Promise.resolve();
	public allowAllSlashCommands: Set<string> = new Set();

	/**
	 * Resolves Discord IDs that should alias to the canonical owner entity.
	 * Discord team members stay separate entities and are registered only as
	 * connector admins so their messages remain attributable.
	 * Called from the extracted onReady handler once the client is ready.
	 */
	public async refreshOwnerDiscordUserIds(
		client: DiscordJsClient,
	): Promise<void> {
		const explicitSetting = this.runtime.getSetting(
			"ELIZA_DISCORD_OWNER_USER_IDS_JSON",
		);
		const hasExplicitSetting =
			explicitSetting !== undefined &&
			explicitSetting !== null &&
			!(typeof explicitSetting === "string" && explicitSetting.trim() === "");

		let ownerIds: string[];
		let teamAdminIds: string[] = [];
		if (hasExplicitSetting) {
			ownerIds = parseDiscordOwnerUserIds(
				Array.isArray(explicitSetting)
					? explicitSetting
					: typeof explicitSetting === "string"
						? explicitSetting
						: [String(explicitSetting)],
			);
		} else {
			let application: unknown;
			try {
				application =
					client.application && typeof client.application.fetch === "function"
						? await client.application.fetch()
						: client.application;
			} catch (error) {
				this.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to fetch Discord application — owner will not be recognized. " +
						"Set ELIZA_DISCORD_OWNER_USER_IDS_JSON to fix this.",
				);
				application = client.application;
			}
			ownerIds = [...new Set(extractDiscordOwnerUserIds(application))];
			teamAdminIds = [
				...new Set(
					extractDiscordTeamAdminUserIds(application).filter(
						(userId) => !ownerIds.includes(userId),
					),
				),
			];
		}

		this.ownerDiscordUserIds = new Set(ownerIds);
		if (ownerIds.length === 0) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
				},
				"No Discord owner user IDs resolved — owner will not be recognized from Discord messages. " +
					"Set ELIZA_DISCORD_OWNER_USER_IDS_JSON to fix this.",
			);
		}
		if (ownerIds.length === 0 && teamAdminIds.length === 0) {
			return;
		}
		const existingWhitelist = getConnectorAdminWhitelist(this.runtime);
		const nextDiscordAdmins = [
			...new Set([
				...(existingWhitelist.discord ?? []),
				...ownerIds,
				...teamAdminIds,
			]),
		];
		setConnectorAdminWhitelist(this.runtime, {
			...existingWhitelist,
			discord: nextDiscordAdmins,
		});
		this.runtime.logger.info(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				ownerDiscordUserIds: ownerIds,
				teamAdminDiscordUserIds: teamAdminIds,
			},
			"Resolved Discord privileged identities for owner mapping and connector admin access",
		);
	}

	/**
	 * Registers slash commands with Discord. Called from the onReady event
	 * handler via the DISCORD_REGISTER_COMMANDS event emitted by
	 * registerBuiltinSlashCommands(). Merges incoming commands with the
	 * existing set, then pushes them to Discord both globally (for DMs) and
	 * per-guild (for instant availability).
	 */
	public async registerSlashCommands(
		commands: DiscordSlashCommand[],
		accountId?: string | null,
	): Promise<void> {
		const service = this;
		// `runtime` is protected on DiscordService, so the host object copies it
		// rather than passing `this` directly (which TS structurally rejects: a
		// protected member can't satisfy a public interface field). The mutable
		// fields are live getters/setters so the extracted registration logic's
		// writes (queue chaining, merged command list) land back on the service.
		const host: SlashCommandRegistrationHost = {
			runtime: this.runtime,
			get slashCommands() {
				return service.slashCommands;
			},
			set slashCommands(value) {
				service.slashCommands = value;
			},
			allowAllSlashCommands: this.allowAllSlashCommands,
			get commandRegistrationQueue() {
				return service.commandRegistrationQueue;
			},
			set commandRegistrationQueue(value) {
				service.commandRegistrationQueue = value;
			},
			requireAccountState: (id) => this.requireAccountState(id),
		};
		return registerDiscordSlashCommands(
			host,
			commands,
			parseBooleanFromText,
			accountId,
		);
	}

	private async resolveDiscordTargetUserId(
		targetEntityId: string,
	): Promise<string | null> {
		const directId = normalizeDiscordTargetUserId(targetEntityId);
		if (directId) {
			return directId;
		}

		if (targetEntityId === resolveElizaOwnerEntityId(this.runtime)) {
			const knownOwnerUserId = this.ownerDiscordUserIds.values().next().value;
			if (typeof knownOwnerUserId === "string" && knownOwnerUserId.length > 0) {
				return knownOwnerUserId;
			}
		}

		const directEntity = this.runtime.getEntityById
			? await this.runtime.getEntityById(targetEntityId as UUID)
			: null;
		const directMetadataUserId = extractDiscordUserIdFromMetadata(
			directEntity?.metadata,
		);
		if (directMetadataUserId) {
			return directMetadataUserId;
		}

		if (typeof this.runtime.getRelationships !== "function") {
			return null;
		}

		const identityLinks = await this.runtime.getRelationships({
			entityIds: [targetEntityId as UUID],
			tags: ["identity_link"],
		});
		for (const relationship of identityLinks) {
			const metadata =
				relationship.metadata && typeof relationship.metadata === "object"
					? (relationship.metadata as Record<string, unknown>)
					: null;
			if (metadata?.status !== "confirmed") {
				continue;
			}
			const linkedEntityId =
				relationship.sourceEntityId === targetEntityId
					? relationship.targetEntityId
					: relationship.targetEntityId === targetEntityId
						? relationship.sourceEntityId
						: null;
			if (!linkedEntityId || linkedEntityId === targetEntityId) {
				continue;
			}
			const linkedEntity = this.runtime.getEntityById
				? await this.runtime.getEntityById(linkedEntityId as UUID)
				: null;
			const linkedMetadataUserId = extractDiscordUserIdFromMetadata(
				linkedEntity?.metadata,
			);
			if (linkedMetadataUserId) {
				return linkedMetadataUserId;
			}
		}

		return null;
	}

	private resolveDiscordSettingsForAccount(
		account: ResolvedDiscordAccount,
	): DiscordSettings {
		const base = getDiscordSettings(this.runtime);
		const config = account.config as DiscordAccountSettingsConfig;
		const dmAllowFrom = config.dm?.allowFrom
			?.map((value) => String(value).trim())
			.filter((value) => value.length > 0);

		return {
			...base,
			allowedChannelIds:
				stringArraySetting(config.allowedChannelIds) ??
				stringArraySetting(config.channelIds) ??
				base.allowedChannelIds,
			shouldIgnoreBotMessages:
				config.shouldIgnoreBotMessages ?? base.shouldIgnoreBotMessages,
			shouldIgnoreDirectMessages:
				config.shouldIgnoreDirectMessages ?? base.shouldIgnoreDirectMessages,
			shouldRespondOnlyToMentions:
				config.shouldRespondOnlyToMentions ?? base.shouldRespondOnlyToMentions,
			replyToMode: config.replyToMode ?? base.replyToMode,
			dmPolicy: config.dm?.policy ?? base.dmPolicy,
			allowFrom:
				dmAllowFrom && dmAllowFrom.length > 0 ? dmAllowFrom : base.allowFrom,
			syncProfile: config.syncProfile ?? base.syncProfile,
			profileName: config.profileName ?? base.profileName,
			profileAvatar: config.profileAvatar ?? base.profileAvatar,
			autoReply: config.autoReply ?? base.autoReply,
		};
	}

	private resolveListenChannelIdsForAccount(
		account: ResolvedDiscordAccount,
	): string[] | undefined {
		return (
			stringArraySetting(
				(account.config as DiscordAccountSettingsConfig).listenChannelIds,
			) ??
			stringArraySetting(this.runtime.getSetting("DISCORD_LISTEN_CHANNEL_IDS"))
		);
	}

	private createDiscordJsClient(accountId: string): DiscordJsClient {
		const client = new DiscordJsClient({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.GuildPresences,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.GuildVoiceStates,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.DirectMessageTyping,
				GatewayIntentBits.GuildMessageTyping,
				GatewayIntentBits.GuildMessageReactions,
			],
			partials: [
				Partials.Channel,
				Partials.Message,
				Partials.User,
				Partials.Reaction,
			],
		});
		// discord.js builds its Client with `captureRejections: true`
		// (BaseClient.js) and installs no Symbol.for("nodejs.rejection")
		// handler, so a rejected async gateway listener is routed into
		// `client.emit("error", ...)`. EventEmitter THROWS when "error" is
		// emitted with no listener, and that throw lands on a process.nextTick
		// stack that no call-stack try/catch can reach — an uncaughtException,
		// which the agent crash guard turns into a whole-process restart.
		//
		// The per-attempt `once(Events.Error)` in attemptDiscordLogin is consumed
		// by the FIRST such rejection, leaving the client error-listener-less
		// from the second one on. This durable listener is what guarantees the
		// client always has one. It owns the logging; the `once` keeps only the
		// login-retry decision, so a single error still produces one line.
		client.on(Events.Error, (error: unknown) => {
			this.runtime.logger.error(
				`Discord client error for account ${accountId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
		return client;
	}

	private syncLegacyDefaultAliases(
		state: DiscordAccountClientState | null,
	): void {
		this.accountId = state?.accountId ?? this.defaultAccountId;
		this.client = state?.client ?? null;
		this.discordSettings = state?.settings ?? getDiscordSettings(this.runtime);
		this.messageManager = state?.messageManager;
		this.voiceManager = state?.voiceManager;
		this.channelDebouncer = state?.channelDebouncer;
		this.allowedChannelIds = state?.allowedChannelIds;
		this.dynamicChannelIds = state?.dynamicChannelIds ?? new Set();
		this.clientReadyPromise = state?.clientReadyPromise ?? null;
	}

	private getAccountState(
		accountId?: string | null,
	): DiscordAccountClientState | null {
		const requested = accountId
			? normalizeAccountId(accountId)
			: this.defaultAccountId;
		return this.accountPool.get(requested) ?? null;
	}

	private getDefaultAccountState(): DiscordAccountClientState | null {
		return this.accountPool.getDefault() ?? null;
	}

	private requireAccountState(
		accountId?: string | null,
	): DiscordAccountClientState {
		const normalized = accountId
			? normalizeAccountId(accountId)
			: this.defaultAccountId;
		const state = this.getAccountState(normalized);
		if (!state) {
			throw new Error(`Discord account is not configured: ${normalized}`);
		}
		return state;
	}

	private resolveAccountIdFromTarget(
		target?: TargetInfo | null,
		fallback?: unknown,
	): string {
		return normalizeAccountId(
			accountIdFromRecord(target) ??
				accountIdFromRecord(fallback) ??
				this.defaultAccountId,
		);
	}

	public getDefaultAccountId(): string {
		return this.defaultAccountId;
	}

	public getAccountIds(): string[] {
		return this.accountPool.listAccountIds();
	}

	public getClient(accountId?: string | null): DiscordJsClient | null {
		const state = this.getAccountState(accountId);
		if (state?.client) {
			return state.client;
		}
		const requested = accountId
			? normalizeAccountId(accountId)
			: this.defaultAccountId;
		const defaultAccountId = this.defaultAccountId;
		return requested === defaultAccountId ? (this.client ?? null) : null;
	}

	public getVoiceTargets(query?: {
		accountId?: string | null;
		guildId?: string | null;
		channelId?: string | null;
	}): DiscordVoiceTarget[] {
		const targets = this.voiceTargets.list();
		if (!query) {
			return targets;
		}
		return targets.filter((target) => {
			if (
				query.accountId &&
				target.accountId !== normalizeAccountId(query.accountId)
			) {
				return false;
			}
			if (query.guildId && target.guildId !== query.guildId) {
				return false;
			}
			if (query.channelId && target.channelId !== query.channelId) {
				return false;
			}
			return true;
		});
	}

	public getVoiceTarget(query: {
		targetId?: string | null;
		accountId?: string | null;
		guildId?: string | null;
		channelId?: string | null;
	}): DiscordVoiceTarget | null {
		if (query.targetId) {
			return this.voiceTargets.get(query.targetId);
		}
		return this.voiceTargets.find({
			accountId: query.accountId
				? normalizeAccountId(query.accountId)
				: undefined,
			guildId: query.guildId,
			channelId: query.channelId,
		});
	}

	public getAudioSink(query: {
		targetId?: string | null;
		accountId?: string | null;
		guildId?: string | null;
		channelId?: string | null;
	}): IDiscordAudioSink | null {
		const target = this.getVoiceTarget(query);
		if (!target) {
			return null;
		}
		const existing = this.audioSinks.get(target.id);
		if (existing) {
			return existing;
		}
		const sink = new DiscordVoiceTargetAudioSink(target);
		this.audioSinks.set(target.id, sink);
		return sink;
	}

	public async setListeningActivity(
		activity: string,
		options?: { accountId?: string | null; url?: string },
	): Promise<boolean> {
		const accountId = normalizeAccountId(
			options?.accountId ?? this.defaultAccountId,
		);
		const client = this.getClient(accountId);
		if (!client?.isReady() || !client.user) {
			this.runtime.logger.warn(
				{ src: "plugin:discord", agentId: this.runtime.agentId, accountId },
				"Cannot set Discord listening activity before client is ready",
			);
			return false;
		}
		await client.user.setActivity(activity, {
			type: ActivityType.Listening,
			url: options?.url,
		});
		return true;
	}

	public async clearActivity(options?: {
		accountId?: string | null;
	}): Promise<boolean> {
		const accountId = normalizeAccountId(
			options?.accountId ?? this.defaultAccountId,
		);
		const client = this.getClient(accountId);
		if (!client?.isReady() || !client.user) {
			this.runtime.logger.warn(
				{ src: "plugin:discord", agentId: this.runtime.agentId, accountId },
				"Cannot clear Discord activity before client is ready",
			);
			return false;
		}
		client.user.setPresence({ activities: [] });
		return true;
	}

	public async setVoiceChannelStatus(
		channelId: string,
		status: string,
		options?: { accountId?: string | null },
	): Promise<boolean> {
		const accountId = normalizeAccountId(
			options?.accountId ?? this.defaultAccountId,
		);
		const client = this.getClient(accountId);
		if (!client?.isReady()) {
			this.runtime.logger.warn(
				{ src: "plugin:discord", agentId: this.runtime.agentId, accountId },
				"Cannot set Discord voice channel status before client is ready",
			);
			return false;
		}

		const channel = await client.channels.fetch(channelId);
		if (!channel?.isVoiceBased?.()) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					accountId,
					channelId,
				},
				"Discord channel is not a voice channel",
			);
			return false;
		}

		const voiceChannel = channel as BaseGuildVoiceChannel;
		const normalizedStatus = truncateWellFormed(
			toWellFormedUnicode(status.trim()),
			500,
		);
		await client.rest.put(`/channels/${voiceChannel.id}/voice-status`, {
			body: {
				status: normalizedStatus || null,
			},
		});
		return true;
	}

	private registerVoiceTarget(target: DiscordVoiceTargetRegistration): void {
		this.voiceTargets.register({
			...target,
			accountId: normalizeAccountId(target.accountId),
		});
		this.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				accountId: target.accountId,
				guildId: target.channel.guild.id,
				channelId: target.channel.id,
			},
			"Registered Discord voice target",
		);
	}

	private unregisterVoiceTarget(
		accountId: string,
		guildId: string,
		channelId: string,
	): void {
		const normalizedAccountId = normalizeAccountId(accountId);
		const target = this.voiceTargets.find({
			accountId: normalizedAccountId,
			guildId,
			channelId,
		});
		if (target) {
			this.audioSinks.get(target.id)?.destroy();
			this.audioSinks.delete(target.id);
		}
		this.voiceTargets.unregister(normalizedAccountId, guildId, channelId);
	}

	private isVoiceChannelClaimed(guildId: string, channelId: string): boolean {
		return this.voiceTargets
			.list()
			.some(
				(target) =>
					target.guildId === guildId && target.channelId === channelId,
			);
	}

	public getAccountLabel(accountId?: string | null): string {
		const state = this.getAccountState(accountId);
		return state?.account.name ?? state?.accountId ?? this.defaultAccountId;
	}

	private createAccountServiceFacade(
		state?: DiscordAccountClientState | null,
	): DiscordAccountServiceFacade {
		const parent = this;
		const accountId = () => state?.accountId ?? parent.accountId;
		const accountClient = (): DiscordJsClient => {
			const client = state?.client ?? parent.client;
			if (!client) {
				throw new Error(
					`Discord client is not available for account ${accountId()}`,
				);
			}
			return client;
		};
		const accountSettings = (): DiscordSettingsForEvents => {
			const settings = state?.settings ?? parent.discordSettings;
			return {
				...settings,
				shouldIgnoreBotMessages: settings.shouldIgnoreBotMessages ?? false,
			};
		};
		const facade: DiscordAccountServiceFacade = {
			// Forward DM observations to the parent registry (#18746): the facade
			// is what MessageManager holds; without this forward the optional
			// call in the message path silently no-ops and cold-start DM
			// coverage records nothing.
			recordDmChannel: (acct: string, channelId: string, recipientId: string) =>
				parent.recordDmChannel(acct, channelId, recipientId),
			get accountId() {
				return accountId();
			},
			get client() {
				return accountClient();
			},
			set client(value: DiscordJsClient) {
				if (state) {
					state.client = value;
				}
				if (!state || state.accountId === parent.defaultAccountId) {
					parent.client = value;
				}
			},
			get runtime() {
				return parent.runtime;
			},
			get character() {
				return parent.character;
			},
			get discordSettings() {
				return accountSettings();
			},
			set discordSettings(value: DiscordSettingsForEvents) {
				if (state) {
					state.settings = value;
				}
				if (!state || state.accountId === parent.defaultAccountId) {
					parent.discordSettings = value;
				}
			},
			get messageManager() {
				return state?.messageManager ?? parent.messageManager;
			},
			set messageManager(value: MessageManager | undefined) {
				if (state) {
					state.messageManager = value;
				}
				if (!state || state.accountId === parent.defaultAccountId) {
					parent.messageManager = value;
				}
			},
			get voiceManager() {
				return state?.voiceManager ?? parent.voiceManager;
			},
			set voiceManager(value: VoiceManager | undefined) {
				if (state) {
					state.voiceManager = value;
				}
				if (!state || state.accountId === parent.defaultAccountId) {
					parent.voiceManager = value;
				}
			},
			get channelDebouncer() {
				return state?.channelDebouncer ?? parent.channelDebouncer;
			},
			set channelDebouncer(value: ChannelDebouncer | undefined) {
				if (state) {
					state.channelDebouncer = value;
				}
				if (!state || state.accountId === parent.defaultAccountId) {
					parent.channelDebouncer = value;
				}
			},
			get allowedChannelIds() {
				return state?.allowedChannelIds ?? parent.allowedChannelIds;
			},
			set allowedChannelIds(value: string[] | undefined) {
				if (state) {
					state.allowedChannelIds = value;
				}
				if (!state || state.accountId === parent.defaultAccountId) {
					parent.allowedChannelIds = value;
				}
			},
			get listenChannelIds() {
				return state?.listenChannelIds;
			},
			get allowAllSlashCommands() {
				return parent.allowAllSlashCommands;
			},
			get slashCommands() {
				return parent.slashCommands;
			},
			set slashCommands(value: DiscordSlashCommand[]) {
				parent.slashCommands = value;
			},
			get commandRegistrationQueue() {
				return parent.commandRegistrationQueue;
			},
			set commandRegistrationQueue(value: Promise<void>) {
				parent.commandRegistrationQueue = value;
			},
			get timeouts() {
				return parent.timeouts;
			},
			isChannelAllowed: (channelId: string) =>
				parent.isChannelAllowed(channelId, state?.accountId),
			addAllowedChannel: (channelId: string) =>
				parent.addAllowedChannel(channelId, state?.accountId),
			removeAllowedChannel: (channelId: string) =>
				parent.removeAllowedChannel(channelId, state?.accountId),
			getAllowedChannels: () => parent.getAllowedChannels(state?.accountId),
			registerVoiceTarget: (target: DiscordVoiceTargetRegistration) =>
				parent.registerVoiceTarget(target),
			unregisterVoiceTarget: (
				targetAccountId: string,
				guildId: string,
				channelId: string,
			) => parent.unregisterVoiceTarget(targetAccountId, guildId, channelId),
			isVoiceChannelClaimed: (guildId: string, channelId: string) =>
				parent.isVoiceChannelClaimed(guildId, channelId),
			resolveDiscordEntityId: (userId: string) =>
				parent.resolveDiscordEntityId(userId),
			isOwnerAliasedDiscordUser: (userId: string) =>
				parent.isOwnerAliasedDiscordUser(userId),
			getChannelType: (channel: Channel) => parent.getChannelType(channel),
			isGuildTextBasedChannel,
			buildMemoryFromMessage: (
				message: Message,
				options?: BuildMemoryFromMessageOptions,
			) =>
				parent.buildMemoryFromMessage(message, {
					...options,
					accountId: state?.accountId ?? parent.accountId,
				}),
			handleInteractionCreate: (interaction: Interaction) =>
				parent.handleInteractionCreateForAccount(accountId(), interaction),
			handleGuildCreate: (guild: Guild) =>
				parent.handleGuildCreateForAccount(accountId(), guild),
			handleGuildMemberAdd: (member: GuildMember) =>
				parent.handleGuildMemberAddForAccount(accountId(), member),
			handleReactionAdd: (
				reaction: MessageReaction | PartialMessageReaction,
				user: User | PartialUser,
			) => parent.handleReactionAddForAccount(accountId(), reaction, user),
			handleReactionRemove: (
				reaction: MessageReaction | PartialMessageReaction,
				user: User | PartialUser,
			) => parent.handleReactionRemoveForAccount(accountId(), reaction, user),
			refreshOwnerDiscordUserIds: (client: unknown) => {
				if (!(client instanceof DiscordJsClient)) {
					throw new Error("Discord client is not available for owner refresh");
				}
				return parent.refreshOwnerDiscordUserIds(client);
			},
			registerSlashCommands: (commands: DiscordSlashCommand[]) =>
				parent.registerSlashCommands(commands, state?.accountId),
			// MessageManager is constructed before initializeAccount assigns the
			// ready promise. Keep this live rather than snapshotting the initial null,
			// otherwise a messageCreate racing ClientReady can be attributed before
			// onReady hydrates the canonical Discord owner aliases.
			get clientReadyPromise() {
				return state?.clientReadyPromise ?? parent.clientReadyPromise;
			},
			admitInboundMessage: (messageId: string, channelId: string) =>
				parent.admitInboundMessage(messageId, channelId, accountId()),
			accountToken: state?.account.token,
		};
		return facade;
	}

	private initializeAccount(account: ResolvedDiscordAccount): void {
		const accountId = normalizeAccountId(account.accountId);
		const settings = this.resolveDiscordSettingsForAccount(account);
		const state: DiscordAccountClientState = {
			accountId,
			account: { ...account, accountId },
			client: this.createDiscordJsClient(accountId),
			settings,
			allowedChannelIds: settings.allowedChannelIds,
			listenChannelIds: this.resolveListenChannelIdsForAccount(account),
			dynamicChannelIds: new Set(),
			clientReadyPromise: null,
			loginFailed: false,
			loginStopRequested: false,
		};

		this.accountPool.set(state);
		const facade = this.createAccountServiceFacade(state);
		state.voiceManager = new VoiceManager(facade, this.runtime);
		state.messageManager = new MessageManager(facade, this.runtime);

		// Initial login now retries with backoff instead of settling terminal on
		// a transient transport failure (#15855). The promise resolves on the
		// first successful ClientReady (any attempt) and only rejects on a
		// terminal post-ready onReady failure — never on a login rejection.
		state.clientReadyPromise = new Promise<void>((resolve, reject) => {
			state.loginReadyReject = reject;
			this.attemptDiscordLogin(state, account.token, 0, resolve, reject);
		});

		state.clientReadyPromise.catch((error) => {
			if (state.loginStopRequested) {
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						accountId: state.accountId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Discord client ready promise rejected during service stop",
				);
				return;
			}
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					accountId: state.accountId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Discord client ready promise rejected (already logged above)",
			);
			state.loginFailed = true;
			if (state.accountId === this.defaultAccountId) {
				this._loginFailed = true;
			}
		});
	}

	/**
	 * Drives one initial-login attempt for an account and re-arms the next on
	 * failure. discord.js destroys the client when `login()` rejects, so each
	 * attempt binds a fresh client (created here once the prior one was torn
	 * down), re-attaches the gateway listeners, and races ClientReady against the
	 * login rejection / gateway Error. Success resolves the ready promise and
	 * clears the failed state; a transient failure discards the client and
	 * schedules `attempt + 1` after a capped-exponential backoff, keeping the
	 * connector self-healing instead of running deaf-but-active (#15855). Once
	 * ClientReady fires, discord.js owns reconnection — this loop stops.
	 */
	private attemptDiscordLogin(
		state: DiscordAccountClientState,
		token: string,
		attempt: number,
		resolve: () => void,
		reject: (error: unknown) => void,
	): void {
		state.loginReadyReject = reject;
		if (state.loginStopRequested) {
			reject(this.createLoginStoppedError(state));
			return;
		}
		if (!state.client) {
			state.client = this.createDiscordJsClient(state.accountId);
		}
		const client = state.client;
		// Rebind message/reaction/guild listeners onto this (possibly fresh)
		// client; the prior attempt's debouncer is discarded with its client.
		state.channelDebouncer?.destroy();
		this.setupEventListenersForAccount(state);

		// ClientReady, gateway Error, and the login() rejection can all fire for
		// one attempt — settle exactly once so we never both resolve and retry.
		let settled = false;

		const settleStopped = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			reject(this.createLoginStoppedError(state));
		};

		const settleTerminal = (error: unknown, closeCode?: number): void => {
			if (settled) {
				return;
			}
			settled = true;
			state.loginFailed = true;
			if (state.accountId === this.defaultAccountId) {
				this._loginFailed = true;
				this.syncLegacyDefaultAliases(state);
			}
			state.loginReadyReject = undefined;
			state.client?.destroy().catch((destroyError: unknown) => {
				// error-policy:J6 best-effort teardown of the client we are replacing
				this.runtime.logger.debug(
					`Discord client teardown after terminal login failure for account ${state.accountId}: ${
						destroyError instanceof Error
							? destroyError.message
							: String(destroyError)
					}`,
				);
			});
			state.client = null;
			const terminalError = this.createTerminalLoginError(
				state,
				error,
				closeCode,
			);
			this.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					accountId: state.accountId,
					closeCode,
					error:
						terminalError instanceof Error
							? terminalError.message
							: String(terminalError),
				},
				"Discord initial login stopped on terminal gateway close",
			);
			reject(terminalError);
		};

		const scheduleRetry = (error: unknown): void => {
			if (settled) {
				return;
			}
			if (state.loginStopRequested) {
				settleStopped();
				return;
			}
			settled = true;
			state.loginFailed = true;
			if (state.accountId === this.defaultAccountId) {
				this._loginFailed = true;
				this.syncLegacyDefaultAliases(state);
			}
			state.client?.destroy().catch((destroyError: unknown) => {
				// error-policy:J6 best-effort teardown of the client we are replacing
				this.runtime.logger.debug(
					`Discord client teardown after failed login for account ${state.accountId}: ${
						destroyError instanceof Error
							? destroyError.message
							: String(destroyError)
					}`,
				);
			});
			state.client = null;
			const delayMs = this.computeLoginBackoffMs(attempt);
			this.emitLoginFailureHeartbeat(state, error, attempt, delayMs);
			const timer = setTimeout(() => {
				state.loginRetryTimer = undefined;
				this.attemptDiscordLogin(state, token, attempt + 1, resolve, reject);
			}, delayMs);
			state.loginRetryTimer = timer;
			this.timeouts.push(timer);
		};

		client.once(Events.ClientReady, async (readyClient) => {
			if (settled) {
				return;
			}
			if (state.loginStopRequested) {
				settleStopped();
				return;
			}
			settled = true;
			if (state.loginRetryTimer) {
				clearTimeout(state.loginRetryTimer);
				state.loginRetryTimer = undefined;
			}
			state.loginFailed = false;
			state.lastLoginHeartbeatAt = undefined;
			if (state.accountId === this.defaultAccountId) {
				this._loginFailed = false;
			}
			try {
				await this.onReadyForAccount(state.accountId, readyClient);
				state.loginReadyReject = undefined;
				resolve();
			} catch (error) {
				// A post-ready onReady failure (backfill/voice scan) is terminal, not
				// a login-transport problem — surface it rather than looping login.
				this.runtime.logger.error(
					`Error in Discord onReady for account ${state.accountId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				state.loginReadyReject = undefined;
				reject(error);
			}
		});
		client.once(Events.ShardDisconnect, (closeEvent: unknown) => {
			if (state.loginStopRequested) {
				settleStopped();
				return;
			}
			const closeCode = this.getGatewayCloseCode(closeEvent);
			if (this.isTerminalInitialLoginCloseCode(closeCode)) {
				settleTerminal(closeEvent, closeCode);
				return;
			}
			scheduleRetry(closeEvent);
		});
		// Logging lives on the durable listener attached at client creation; this
		// one only carries the login-retry decision for the current attempt.
		client.once(Events.Error, (error: unknown) => {
			scheduleRetry(error);
		});
		client.login(token).catch((error: unknown) => {
			const closeCode = this.getGatewayCloseCode(error);
			if (
				this.isTerminalInitialLoginCloseCode(closeCode) ||
				this.isTerminalInitialLoginError(error)
			) {
				settleTerminal(error, closeCode);
				return;
			}
			scheduleRetry(error);
		});
	}

	// Capped exponential backoff for the initial-login retry loop: the delay
	// doubles per attempt and clamps at DISCORD_LOGIN_RETRY_MAX_MS.
	private computeLoginBackoffMs(attempt: number): number {
		const scaled = DISCORD_LOGIN_RETRY_BASE_MS * 2 ** attempt;
		return Math.min(scaled, DISCORD_LOGIN_RETRY_MAX_MS);
	}

	private getGatewayCloseCode(closeEvent: unknown): number | undefined {
		if (
			typeof closeEvent === "object" &&
			closeEvent !== null &&
			"code" in closeEvent
		) {
			const code = (closeEvent as { code?: unknown }).code;
			return typeof code === "number" ? code : undefined;
		}
		return undefined;
	}

	private isTerminalInitialLoginCloseCode(
		closeCode: number | undefined,
	): boolean {
		return (
			closeCode !== undefined &&
			DISCORD_TERMINAL_INITIAL_LOGIN_CLOSE_CODES.has(closeCode)
		);
	}

	private isTerminalInitialLoginError(error: unknown): boolean {
		if (typeof error !== "object" || error === null || !("code" in error)) {
			return false;
		}
		return (error as { code?: unknown }).code === "TokenInvalid";
	}

	private createLoginStoppedError(state: DiscordAccountClientState): Error {
		return new Error(
			`Discord initial login stopped before ClientReady for account ${state.accountId}`,
		);
	}

	private createTerminalLoginError(
		state: DiscordAccountClientState,
		error: unknown,
		closeCode?: number,
	): Error {
		const reason =
			typeof error === "object" && error !== null && "reason" in error
				? (error as { reason?: unknown }).reason
				: undefined;
		const detail =
			typeof reason === "string" && reason.length > 0
				? reason
				: error instanceof Error
					? error.message
					: String(error);
		return new Error(
			`Discord initial login terminal failure for account ${state.accountId}${
				closeCode === undefined ? "" : ` (gateway close ${closeCode})`
			}: ${detail}`,
		);
	}

	/**
	 * Warn-level heartbeat naming the account and the login failure, throttled to
	 * at most once per DISCORD_LOGIN_HEARTBEAT_MIN_INTERVAL_MS so a fast retry
	 * storm surfaces observably (#15855) without flooding the log.
	 */
	private emitLoginFailureHeartbeat(
		state: DiscordAccountClientState,
		error: unknown,
		attempt: number,
		delayMs: number,
	): void {
		const now = Date.now();
		const last = state.lastLoginHeartbeatAt;
		if (
			last !== undefined &&
			now - last < DISCORD_LOGIN_HEARTBEAT_MIN_INTERVAL_MS
		) {
			return;
		}
		state.lastLoginHeartbeatAt = now;
		this.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				accountId: state.accountId,
				attempt: attempt + 1,
				retryInMs: delayMs,
				error: error instanceof Error ? error.message : String(error),
			},
			`Discord account ${state.accountId} failed to log in and is connected-but-deaf; retrying in ${delayMs}ms (attempt ${attempt + 1})`,
		);
	}

	/**
	 * Constructor for Discord client.
	 * Initializes the Discord client with specified intents and partials,
	 * sets up event listeners, and ensures all servers exist.
	 *
	 * @param {IAgentRuntime} runtime - The AgentRuntime instance
	 */
	constructor(runtime?: IAgentRuntime) {
		super(runtime);

		// Load Discord settings with proper priority (env vars > character settings > defaults)
		this.discordSettings = getDiscordSettings(this.runtime);

		this.character = this.runtime.character;

		this.defaultAccountId = normalizeAccountId(
			resolveDefaultDiscordAccountId(this.runtime),
		);
		this.accountPool.setDefaultAccountId(this.defaultAccountId);
		this.accountId = this.defaultAccountId;

		const accounts = listEnabledDiscordAccounts(this.runtime);
		if (accounts.length === 0) {
			this.runtime.logger.warn("Discord API Token not provided");
			this.syncLegacyDefaultAliases(null);
			return;
		}

		try {
			for (const account of accounts) {
				this.initializeAccount(account);
			}

			const defaultState = this.getDefaultAccountState();
			if (defaultState) {
				this.defaultAccountId = defaultState.accountId;
				this.accountPool.setDefaultAccountId(defaultState.accountId);
			}
			this.syncLegacyDefaultAliases(defaultState);
			this.runtime.logger.info(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					defaultAccountId: this.defaultAccountId,
					accountIds: this.getAccountIds(),
				},
				"Initialized Discord account client pool",
			);
		} catch (error) {
			this.runtime.logger.error(
				`Error initializing Discord client: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.syncLegacyDefaultAliases(null);
		}
	}

	public isHealthy(): boolean {
		const state = this.getDefaultAccountState();
		if (this._loginFailed || !state?.client || state.loginFailed) {
			return false;
		}
		return state.client.isReady();
	}

	static async start(runtime: IAgentRuntime) {
		const service = new DiscordService(runtime);
		return service;
	}

	/**
	 * The SendHandlerFunction implementation for Discord.
	 * @param {IAgentRuntime} runtime - The runtime instance.
	 * @param {TargetInfo} target - The target information for the message.
	 * @param {Content} content - The content of the message to send.
	 * @returns Provider acceptance plus exact local-persistence evidence.
	 * @throws {Error} If the client is not ready, target is invalid, or sending fails.
	 */
	async handleSendMessage(
		runtime: IAgentRuntime,
		target: TargetInfo,
		content: Content,
	): Promise<Memory | SendHandlerOutcome | undefined> {
		let outboundReservation: DiscordOutboundDeliveryReservation | undefined;
		let acceptedProviderMessages: Message[] = [];
		let providerSendFailure: unknown;
		let providerAcceptedAt: number | undefined;
		// Resolve the connector account this outbound message must use.
		// Priority: explicit target.accountId > this service instance's default.
		// `Content.metadata` is intentionally NOT consulted because it may be
		// user-supplied per the MessageMetadata contract — actions thread the
		// trusted inbound `Memory.metadata.accountId` into `target.accountId`.
		const accountId = this.resolveAccountIdFromTarget(target);
		const state = this.getAccountState(accountId);
		const client = state?.client ?? null;
		if (!client?.isReady()) {
			runtime.logger.error("Client not ready");
			throw new Error(`Discord client is not ready for account ${accountId}.`);
		}

		// Reference content to avoid an unused-parameter lint hit; outbound
		// resolution only consults `target.accountId` for trust reasons.
		void content;

		let targetChannel: Channel | undefined | null = null;
		let resolvedChannelId: string | null = null;
		let dmRecipient:
			| {
					entityId: UUID;
					discordUserId: string;
					userName?: string;
					name?: string;
			  }
			| undefined;

		try {
			if (target.channelId) {
				resolvedChannelId = target.channelId;
				targetChannel = await client.channels.fetch(target.channelId);
			} else if (target.roomId) {
				const room =
					typeof runtime.getRoom === "function"
						? await runtime.getRoom(target.roomId as UUID)
						: null;
				const roomChannelId =
					room?.channelId && typeof room.channelId === "string"
						? room.channelId
						: null;
				if (!roomChannelId) {
					throw new Error(
						`Could not resolve Discord channel ID for room ${target.roomId}`,
					);
				}
				resolvedChannelId = roomChannelId;
				targetChannel = await client.channels.fetch(roomChannelId);
			} else if (target.entityId) {
				const discordUserId = await this.resolveDiscordTargetUserId(
					target.entityId as string,
				);
				if (!discordUserId) {
					throw new Error(
						`Could not resolve Discord user ID for runtime entity ${target.entityId}`,
					);
				}
				const user = await client.users.fetch(discordUserId);
				if (user) {
					targetChannel = user.dmChannel ?? (await user.createDM());
					const recipientEntityId = normalizeDiscordTargetUserId(
						target.entityId,
					)
						? this.resolveDiscordEntityId(discordUserId)
						: (target.entityId as UUID);
					dmRecipient = {
						entityId: recipientEntityId,
						discordUserId,
						userName: user.username,
						name: user.displayName || user.username,
					};
				}
			} else {
				throw new Error(
					"Discord SendHandler requires channelId, roomId, or entityId.",
				);
			}

			if (!targetChannel) {
				const targetStr = JSON.stringify(target, (_key, value) => {
					if (typeof value === "bigint") {
						return value.toString();
					}
					return value;
				});
				throw new Error(
					`Could not find target Discord channel/DM for target: ${targetStr}`,
				);
			}

			const allowedByParentThread =
				typeof targetChannel.isThread === "function" &&
				targetChannel.isThread() &&
				"parentId" in targetChannel &&
				typeof targetChannel.parentId === "string" &&
				targetChannel.parentId.length > 0 &&
				this.isChannelAllowed(targetChannel.parentId, accountId);
			// DMs (and group DMs) are exempt from the guild-channel allowlist,
			// mirroring the inbound gate (#18419): CHANNEL_IDS scopes which *guild*
			// surfaces the bot participates in, while DM access is governed by the
			// DM policy. A DM channel id is by definition never in CHANNEL_IDS, so
			// without this exemption an allowlisted deployment could receive DMs
			// but never send them (including scheduled/proactive owner DMs).
			const isDmTarget =
				targetChannel.type === DiscordChannelType.DM ||
				targetChannel.type === DiscordChannelType.GroupDM;
			if (
				!isDmTarget &&
				state?.allowedChannelIds &&
				!this.isChannelAllowed(targetChannel.id, accountId) &&
				!allowedByParentThread
			) {
				const resolvedFromText =
					resolvedChannelId && resolvedChannelId !== targetChannel.id
						? ` (resolved from ${resolvedChannelId})`
						: "";
				runtime.logger.warn(
					`Channel ${targetChannel.id}${resolvedFromText} not in allowed list, skipping send`,
				);
				return {
					kind: "not_delivered",
					code: "DISCORD_CHANNEL_NOT_ALLOWED",
					message: `Discord channel ${targetChannel.id} is not in the configured allowlist.`,
				};
			}

			if (targetChannel.isTextBased() && !targetChannel.isVoiceBased()) {
				if (
					"send" in targetChannel &&
					typeof targetChannel.send === "function"
				) {
					const files: AttachmentBuilder[] = [];
					if (content.attachments && content.attachments.length > 0) {
						for (const media of content.attachments) {
							if (media.url) {
								files.push(
									await buildOutboundDiscordAttachment(media, runtime),
								);
							}
						}
					}

					const sentMessages: Message[] = [];
					const roomId = createUniqueUuid(runtime, targetChannel.id);
					const channelType = await this.getChannelType(
						targetChannel as Channel,
					);
					const targetChannelGuild =
						"guild" in targetChannel ? targetChannel.guild : null;
					const serverId = targetChannelGuild?.id
						? targetChannelGuild.id
						: targetChannel.id;
					const worldId = createUniqueUuid(runtime, serverId) as UUID;
					const worldName = targetChannelGuild?.name
						? targetChannelGuild.name
						: undefined;

					// Project embedded interaction blocks the same way the reply path
					// does. This handler serves runtime.sendMessageToTarget — the
					// sub-agent relay / progress / notice path — and sending
					// `content.text` raw leaked literal `[FOLLOWUPS]…[/FOLLOWUPS]`
					// markup to Discord (live 2026-08-17, wind-chimes relay). Blocks
					// become action rows on the final chunk; block-free text is
					// byte-identical to the previous behavior.
					const rendered = buildDiscordReplyPayload(runtime, content);
					const renderedComponents =
						rendered.components.length > 0
							? buildDiscordComponents(rendered.components)
							: undefined;
					const hasComponents = rendered.components.length > 0;
					const interactionIdentity = hasComponents
						? JSON.stringify(rendered.components)
						: undefined;
					let textContent = normalizeDiscordMessageText(rendered.text);
					if (textContent.trim().length === 0 && hasComponents) {
						textContent = INTERACTION_ONLY_FALLBACK_TEXT;
					}
					const outboundReplyToMessageId =
						discordReplyReferenceFromContent(content);
					if (textContent || files.length > 0) {
						if (dmRecipient) {
							// Establish canonical recipient participation before the
							// reservation. A waiting duplicate may inherit the first
							// provider receipt, but it must never inherit a missing DM
							// room relationship from an attempt that failed before send.
							await this.runtime.ensureConnection({
								entityId: dmRecipient.entityId,
								roomId,
								userName: dmRecipient.userName,
								userId: dmRecipient.discordUserId as UUID,
								name: dmRecipient.name,
								source: "discord",
								channelId: targetChannel.id,
								serverId,
								messageServerId: stringToUuid(serverId),
								type: channelType,
								worldId,
								worldName,
								metadata: {
									accountId,
								},
							});
						}
						const dedupeParams = {
							accountId,
							channelId: targetChannel.id,
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
							const settled = await outboundDedupe.settlement;
							if (settled.kind === "settled") {
								return {
									kind: "duplicate",
									priorDelivery: settled.delivery,
									receipt: settled.receipt,
								};
							}
							outboundDedupe = beginDiscordOutboundDelivery(dedupeParams);
						}
						if (outboundDedupe.kind === "duplicate") {
							runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: runtime.agentId,
									channelId: targetChannel.id,
									accountId,
									textPreview: truncateWellFormed(
										toWellFormedUnicode(
											textContent.replace(/\s+/g, " ").trim(),
										),
										200,
									),
								},
								"Suppressing duplicate Discord connector delivery",
							);
							return {
								kind: "duplicate",
								priorDelivery: outboundDedupe.priorDelivery,
								receipt: outboundDedupe.receipt,
							};
						}
						outboundReservation = outboundDedupe.reservation;
						try {
							if (textContent) {
								const chunks = splitMessage(textContent, MAX_MESSAGE_LENGTH);
								if (chunks.length > 1) {
									for (let i = 0; i < chunks.length - 1; i++) {
										const sent = await targetChannel.send({
											content: chunks[i],
											...(outboundReplyToMessageId && i === 0
												? {
														reply: {
															messageReference: outboundReplyToMessageId,
														},
													}
												: {}),
										});
										sentMessages.push(sent);
										acceptedProviderMessages = [...sentMessages];
										providerAcceptedAt ??= Date.now();
									}
									const sent = await targetChannel.send({
										content: chunks[chunks.length - 1],
										files: files.length > 0 ? files : undefined,
										...(renderedComponents
											? { components: renderedComponents }
											: {}),
										...(outboundReplyToMessageId && chunks.length === 1
											? {
													reply: {
														messageReference: outboundReplyToMessageId,
													},
												}
											: {}),
									});
									sentMessages.push(sent);
									acceptedProviderMessages = [...sentMessages];
									providerAcceptedAt ??= Date.now();
								} else {
									const sent = await targetChannel.send({
										content: chunks[0],
										files: files.length > 0 ? files : undefined,
										...(renderedComponents
											? { components: renderedComponents }
											: {}),
										...(outboundReplyToMessageId
											? {
													reply: {
														messageReference: outboundReplyToMessageId,
													},
												}
											: {}),
									});
									sentMessages.push(sent);
									acceptedProviderMessages = [...sentMessages];
									providerAcceptedAt ??= Date.now();
								}
							} else {
								const sent = await targetChannel.send({
									files,
									...(outboundReplyToMessageId
										? {
												reply: {
													messageReference: outboundReplyToMessageId,
												},
											}
										: {}),
								});
								sentMessages.push(sent);
								acceptedProviderMessages = [...sentMessages];
								providerAcceptedAt ??= Date.now();
							}
						} catch (error) {
							// error-policy:J1 provider boundary translation preserves any
							// accepted prefix as a partial delivery instead of retrying it.
							providerSendFailure = error;
							if (sentMessages.length === 0) {
								throw error;
							}
							runtime.reportError("discord:outbound-partial-delivery", error, {
								accountId,
								channelId: targetChannel.id,
								providerMessageIds: sentMessages.map((message) => message.id),
							});
						}
					} else {
						outboundReservation?.release();
						outboundReservation = undefined;
						runtime.logger.warn("No text content or attachments provided");
					}

					const persistenceFailures: SendHandlerPersistenceFailure[] = [];
					const persistedMemories: Memory[] = [];
					const clientUser = client.user;
					try {
						await this.runtime.ensureConnection({
							entityId: runtime.agentId,
							roomId,
							roomName:
								"name" in targetChannel &&
								typeof targetChannel.name === "string"
									? targetChannel.name
									: clientUser.displayName || clientUser.username || undefined,
							userName: clientUser.username ? clientUser.username : undefined,
							name: clientUser.displayName || clientUser.username || undefined,
							source: "discord",
							channelId: targetChannel.id,
							serverId,
							messageServerId: stringToUuid(serverId),
							type: channelType,
							worldId,
							worldName,
							metadata: {
								accountId,
							},
						});
					} catch (error) {
						// error-policy:J1 local persistence boundary keeps provider
						// acceptance successful while exposing failed connection evidence.
						for (const sentMsg of sentMessages) {
							persistenceFailures.push({
								providerMessageId: sentMsg.id,
								stage: "connection",
								code: deliveryErrorCode(error),
								message: deliveryErrorMessage(error),
							});
						}
						runtime.reportError(
							"discord:outbound-connection-persistence",
							error,
							{
								accountId,
								channelId: targetChannel.id,
								providerMessageIds: sentMessages.map((message) => message.id),
							},
						);
					}

					for (const sentMsg of sentMessages) {
						try {
							const hasAttachments = sentMsg.attachments.size > 0;

							const memory: Memory = {
								id: createUniqueUuid(runtime, sentMsg.id),
								entityId: runtime.agentId,
								agentId: runtime.agentId,
								roomId,
								content: {
									text: sentMsg.content || textContent || " ",
									url: sentMsg.url,
									channelType,
									...(outboundReplyToMessageId
										? {
												inReplyTo: createUniqueUuid(
													runtime,
													outboundReplyToMessageId,
												),
											}
										: {}),
									...(hasAttachments && content.attachments
										? { attachments: content.attachments }
										: {}),
									...(content.action ? { action: content.action } : {}),
								},
								metadata: {
									type: MemoryType.MESSAGE,
									accountId,
									platformMessageId: sentMsg.id,
									...extractContentMetadata(content),
								},
								createdAt: sentMsg.createdTimestamp || Date.now(),
							};
							const persisted = await createDiscordMessageMemoryOnce(
								runtime,
								memory,
								{
									operation: "discord-connector-send",
									platformMessageId: sentMsg.id,
								},
							);
							if (!persisted) {
								throw new Error(
									"Discord memory persistence returned no stored record.",
								);
							}
							persistedMemories.push(persisted);
							runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: runtime.agentId,
									messageId: sentMsg.id,
								},
								"Saved sent message to memory",
							);
						} catch (error) {
							// error-policy:J1 local persistence boundary records the
							// failed provider-id binding without fabricating a stored memory.
							persistenceFailures.push({
								providerMessageId: sentMsg.id,
								stage: "memory",
								code: deliveryErrorCode(error),
								message: deliveryErrorMessage(error),
							});
							runtime.reportError(
								"discord:outbound-memory-persistence",
								error,
								{
									accountId,
									channelId: targetChannel.id,
									providerMessageId: sentMsg.id,
								},
							);
						}
					}
					if (sentMessages.length === 0) {
						return {
							kind: "not_delivered",
							code: "DISCORD_EMPTY_MESSAGE",
							message: "Discord received no text or attachment to send.",
						};
					}
					const receipt = buildDiscordSendReceipt({
						messages: sentMessages,
						acceptedAt: providerAcceptedAt ?? Date.now(),
						persistedMemories,
						failures: persistenceFailures,
					});
					const deliveryKind = providerSendFailure
						? "partially_delivered"
						: "delivered";
					outboundReservation?.commit(deliveryKind, receipt);
					outboundReservation = undefined;
					if (providerSendFailure) {
						return {
							kind: "partially_delivered",
							receipt,
							memories: persistedMemories,
							code: "DISCORD_PROVIDER_PARTIAL_DELIVERY",
							message: `Discord accepted ${sentMessages.length} message chunk${sentMessages.length === 1 ? "" : "s"} before a later provider send failed: ${deliveryErrorMessage(providerSendFailure)}`,
						};
					}
					return {
						kind: "delivered",
						receipt,
						memories: persistedMemories,
					};
				} else {
					throw new Error(
						`Target channel ${targetChannel.id} does not have a send method.`,
					);
				}
			} else {
				throw new Error(
					`Target channel ${targetChannel.id} is not a valid text-based channel for sending messages.`,
				);
			}
		} catch (error) {
			// error-policy:J1 connector boundary returns provider acceptance with
			// failed local evidence, or releases an unaccepted reservation and throws.
			if (outboundReservation && acceptedProviderMessages.length > 0) {
				const receipt: SendHandlerReceipt = {
					providerMessageIds: providerMessageIds(acceptedProviderMessages),
					acceptedAt: Date.now(),
					persistence: {
						status: "failed",
						failures: acceptedProviderMessages.map((message) => ({
							providerMessageId: message.id,
							stage: "memory",
							code: deliveryErrorCode(error),
							message: deliveryErrorMessage(error),
						})),
					},
				};
				const deliveryKind = providerSendFailure
					? "partially_delivered"
					: "delivered";
				outboundReservation.commit(deliveryKind, receipt);
				outboundReservation = undefined;
				runtime.reportError("discord:outbound-finalization", error, {
					accountId,
					providerMessageIds: receipt.providerMessageIds,
				});
				return providerSendFailure
					? {
							kind: "partially_delivered",
							receipt,
							memories: [],
							code: "DISCORD_PROVIDER_PARTIAL_DELIVERY",
							message: `Discord accepted ${acceptedProviderMessages.length} message chunk${acceptedProviderMessages.length === 1 ? "" : "s"} before a later provider send failed: ${deliveryErrorMessage(providerSendFailure)}`,
						}
					: {
							kind: "delivered",
							receipt,
							memories: [],
						};
			}
			outboundReservation?.release();
			runtime.logger.error(
				`Error sending message to ${JSON.stringify(target)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	private buildConnectorChannelTarget(
		channel: Channel,
		score = 0.5,
		accountId = this.defaultAccountId,
	): MessageConnectorTarget | null {
		if (!isDiscordTextTarget(channel)) {
			return null;
		}

		const channelRecord = channel as Channel & {
			guild?: Guild;
			name?: string;
			parentId?: string | null;
			isThread?: () => boolean;
			url?: string;
		};
		const parentId =
			typeof channelRecord.parentId === "string"
				? channelRecord.parentId
				: undefined;
		const isThread = Boolean(channelRecord.isThread());
		const state = this.getAccountState(accountId);
		if (
			state?.allowedChannelIds &&
			!this.isChannelAllowed(channel.id, accountId) &&
			!(parentId && this.isChannelAllowed(parentId, accountId))
		) {
			return null;
		}

		const guild = channelRecord.guild;
		const roomId = createUniqueUuid(this.runtime, channel.id) as UUID;
		const label =
			typeof channelRecord.name === "string" && channelRecord.name.length > 0
				? `${isThread ? "Thread" : "#"}${channelRecord.name}`
				: channel.id;

		return {
			target: {
				source: "discord",
				accountId,
				roomId,
				channelId: channel.id,
				serverId: guild?.id,
				threadId: isThread ? channel.id : undefined,
				// The inbound gate drops messages on the [room, parent] mute chain
				// (discord-events), so listings carry the same parent linkage for
				// muted-state inheritance — a thread of a muted parent must never
				// list as unmuted while its messages are being dropped.
				parentChannelId: parentId,
			} as TargetInfo,
			label,
			kind: isThread ? "thread" : "channel",
			description: guild?.name ? `${label} in ${guild.name}` : label,
			score,
			contexts: ["social", "connectors"],
			metadata: {
				accountId,
				discordChannelId: channel.id,
				discordGuildId: guild?.id,
				discordGuildName: guild?.name,
				discordParentChannelId: parentId,
				channelName: channelRecord.name,
				isThread,
				url: channelRecord.url,
			},
		};
	}

	private buildConnectorUserTarget(
		user: User,
		guild?: Guild | null,
		displayName?: string,
		score = 0.5,
		accountId = this.defaultAccountId,
	): MessageConnectorTarget | null {
		if (!user || user.bot) {
			return null;
		}

		const label = displayName || user.globalName || user.username || user.id;
		return {
			target: {
				source: "discord",
				accountId,
				entityId: user.id as UUID,
				serverId: guild?.id,
			} as TargetInfo,
			label: `@${label}`,
			kind: "user",
			description: guild?.name
				? `Discord user in ${guild.name}`
				: "Discord user",
			score,
			contexts: ["social", "connectors"],
			metadata: {
				accountId,
				discordUserId: user.id,
				discordUsername: user.username,
				discordGlobalName: user.globalName,
				discordGuildId: guild?.id,
				discordGuildName: guild?.name,
			},
		};
	}

	private dedupeConnectorTargets(
		targets: MessageConnectorTarget[],
	): MessageConnectorTarget[] {
		const byKey = new Map<string, MessageConnectorTarget>();
		for (const target of targets) {
			const key = [
				target.kind ?? "target",
				target.target.channelId ?? "",
				target.target.entityId ?? "",
				target.target.threadId ?? "",
			].join(":");
			const existing = byKey.get(key);
			if (!existing || (target.score ?? 0) > (existing.score ?? 0)) {
				byKey.set(key, target);
			}
		}
		return Array.from(byKey.values()).sort(
			(a, b) => (b.score ?? 0) - (a.score ?? 0),
		);
	}

	public async resolveConnectorTargets(
		query: string,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const accountId = this.resolveAccountIdFromTarget(context.target, context);
		const client = this.getClient(accountId);
		if (!client) {
			return [];
		}

		const normalizedQuery = normalizeDiscordConnectorQuery(query);
		const results: MessageConnectorTarget[] = [];
		const guilds = Array.from(client.guilds.cache.values());

		for (const guild of guilds) {
			const cachedChannels = Array.from(guild.channels.cache.values());
			for (const channel of cachedChannels) {
				if (!channel || !isDiscordTextTarget(channel)) {
					continue;
				}
				const channelRecord = channel as Channel & { name?: string };
				const score = scoreDiscordConnectorMatch(normalizedQuery, channel.id, [
					channelRecord.name,
				]);
				if (score <= 0) {
					continue;
				}
				const target = this.buildConnectorChannelTarget(
					channel,
					score,
					accountId,
				);
				if (target) {
					results.push(target);
				}
			}

			if (normalizedQuery.length >= 2) {
				try {
					const members = await guild.members.fetch();
					for (const member of members.values()) {
						const score = scoreDiscordConnectorMatch(
							normalizedQuery,
							member.id,
							[
								member.displayName,
								member.user.username,
								member.user.globalName,
								member.user.tag,
							],
						);
						const target = this.buildConnectorUserTarget(
							member.user,
							guild,
							member.displayName,
							score || 0.65,
							accountId,
						);
						if (target) {
							results.push(target);
						}
					}
				} catch (error) {
					this.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							guildId: guild.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"Discord connector member query failed",
					);
				}
			}

			for (const member of guild.members.cache.values()) {
				const score = scoreDiscordConnectorMatch(normalizedQuery, member.id, [
					member.displayName,
					member.user.username,
					member.user.globalName,
					member.user.tag,
				]);
				if (score <= 0) {
					continue;
				}
				const target = this.buildConnectorUserTarget(
					member.user,
					guild,
					member.displayName,
					score,
					accountId,
				);
				if (target) {
					results.push(target);
				}
			}
		}

		if (DISCORD_SNOWFLAKE_PATTERN.test(normalizedQuery)) {
			try {
				const channel = await client.channels.fetch(normalizedQuery);
				if (channel) {
					const target = this.buildConnectorChannelTarget(
						channel,
						1,
						accountId,
					);
					if (target) {
						results.push(target);
					}
				}
			} catch {
				// Snowflake may be a user id; try user lookup below.
			}
			try {
				const user = await client.users.fetch(normalizedQuery);
				const target = this.buildConnectorUserTarget(
					user,
					null,
					undefined,
					1,
					accountId,
				);
				if (target) {
					results.push(target);
				}
			} catch {
				// No exact user match.
			}
		}

		if (context.target?.channelId) {
			try {
				const channel = await client.channels.fetch(context.target.channelId);
				if (channel) {
					const target = this.buildConnectorChannelTarget(
						channel,
						0.6,
						accountId,
					);
					if (target) {
						results.push(target);
					}
				}
			} catch {
				// Ignore stale current-channel hints.
			}
		}

		return this.dedupeConnectorTargets(results);
	}

	public async listConnectorRooms(
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const accountId = this.resolveAccountIdFromTarget(context.target, context);
		const client = this.getClient(accountId);
		if (!client) {
			return [];
		}

		const targets: MessageConnectorTarget[] = [];
		for (const guild of client.guilds.cache.values()) {
			for (const channel of guild.channels.cache.values()) {
				const target = this.buildConnectorChannelTarget(
					channel as Channel,
					0.5,
					accountId,
				);
				if (target) {
					targets.push(target);
				}
			}
		}
		// The complete set is the contract: list_channels/list_connections derive
		// channel + muted counts from the returned length, so any cap here makes
		// those counts silently wrong past the cap. The gateway cache already
		// holds every channel per guild (GUILD_CREATE delivers the full list);
		// bounding what gets rendered is the op layer's job.
		return this.dedupeConnectorTargets(targets);
	}

	public async listRecentConnectorTargets(
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const accountId = this.resolveAccountIdFromTarget(context.target, context);
		const client = this.getClient(accountId);
		const targets: MessageConnectorTarget[] = [];
		const currentRoom =
			context.roomId && typeof context.runtime.getRoom === "function"
				? await context.runtime.getRoom(context.roomId)
				: null;
		const currentChannelId =
			context.target?.channelId ??
			(currentRoom?.source === "discord" ? currentRoom.channelId : undefined);

		if (currentChannelId && client) {
			try {
				const channel = await client.channels.fetch(currentChannelId);
				if (channel) {
					const target = this.buildConnectorChannelTarget(
						channel,
						0.95,
						accountId,
					);
					if (target) {
						targets.push(target);
					}
				}
			} catch {
				// Ignore stale current-channel hints.
			}
		}

		targets.push(...(await this.listConnectorRooms(context)));
		return this.dedupeConnectorTargets(targets);
	}

	public async getConnectorChatContext(
		target: TargetInfo,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorChatContext | null> {
		const accountId = this.resolveAccountIdFromTarget(target, context);
		const client = this.getClient(accountId);
		if (!client) {
			return null;
		}

		// The room read exists only to recover a channelId the caller did not
		// resolve — skip the DB round-trip when the target already carries one.
		const room =
			!target.channelId &&
			target.roomId &&
			typeof context.runtime.getRoom === "function"
				? await context.runtime.getRoom(target.roomId)
				: null;
		const channelId = target.channelId ?? room?.channelId;
		if (!channelId) {
			return null;
		}

		const channel = await client.channels.fetch(channelId);
		if (!channel || !isDiscordTextTarget(channel)) {
			return null;
		}

		const channelRecord = channel as Channel & {
			name?: string;
			topic?: string | null;
			guild?: Guild;
			messages?: {
				cache?: Collection<string, Message>;
			};
		};
		// Recent history comes from the gateway-populated message cache, never a
		// REST fetch: this hook runs on the Stage-1 critical path every turn, a
		// GET /channels/{id}/messages costs 100ms-3s+ behind discord.js's
		// rate-limit buckets, and the transcript in the prompt is owned by
		// RECENT_MESSAGES anyway (the provider strips recentMessages before
		// rendering — the fetched history was diagnostics-only). The cache holds
		// the same gateway-delivered messages at zero cost; right after boot it
		// is simply empty.
		const recentMessages: MessageConnectorChatContext["recentMessages"] = [];
		const cached = channelRecord.messages?.cache;
		if (cached) {
			for (const message of cached.values()) {
				if (!message.content.trim()) {
					continue;
				}
				recentMessages.push({
					entityId: this.resolveDiscordEntityId(message.author.id),
					name:
						message.member?.displayName ||
						message.author.globalName ||
						message.author.username,
					text: message.content,
					timestamp: message.createdTimestamp,
					metadata: {
						accountId,
						discordMessageId: message.id,
						discordUserId: message.author.id,
					},
				});
			}
		}

		const label =
			typeof channelRecord.name === "string" && channelRecord.name.length > 0
				? `#${channelRecord.name}`
				: channelId;
		return {
			target: {
				source: "discord",
				accountId,
				roomId: target.roomId ?? room?.id,
				channelId,
				serverId: target.serverId ?? channelRecord.guild?.id,
				threadId: target.threadId,
			} as TargetInfo,
			label,
			summary:
				channelRecord.topic ||
				(channelRecord.guild?.name
					? `Discord channel in ${channelRecord.guild.name}`
					: undefined),
			recentMessages,
			metadata: {
				accountId,
				discordChannelId: channelId,
				discordGuildId: channelRecord.guild?.id,
				discordGuildName: channelRecord.guild?.name,
			},
		};
	}

	public async getConnectorUserContext(
		entityId: UUID | string,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorUserContext | null> {
		const accountId = this.resolveAccountIdFromTarget(context.target, context);
		const client = this.getClient(accountId);
		if (!client) {
			return null;
		}

		const discordUserId = await this.resolveDiscordTargetUserId(
			String(entityId),
		);
		if (!discordUserId) {
			return null;
		}

		const user = await client.users.fetch(discordUserId);
		if (!user) {
			return null;
		}

		return {
			entityId,
			label: user.globalName || user.username || user.id,
			aliases: [user.username, user.globalName, user.tag].filter(
				(value): value is string => Boolean(value),
			),
			handles: { discord: user.id },
			metadata: {
				accountId,
				discordUserId: user.id,
				discordUsername: user.username,
				discordGlobalName: user.globalName,
				requestRoomId: context.roomId,
			},
		};
	}

	private async resolveConnectorTextChannel(
		target?: TargetInfo | null,
		fallback?: ConnectorFetchMessagesParams | ConnectorChannelMutationParams,
	): Promise<
		Channel & {
			id: string;
			name?: string;
			guild?: Guild;
			messages: TextChannel["messages"];
			permissionsFor?: TextChannel["permissionsFor"];
		}
	> {
		const accountId = this.resolveAccountIdFromTarget(target, fallback);
		const client = this.getClient(accountId);
		if (!client) {
			throw new Error("Discord client is not initialized.");
		}

		let channelId =
			target?.channelId ??
			(fallback && "channelId" in fallback ? fallback.channelId : undefined);
		const roomId =
			target?.roomId ??
			(fallback && "roomId" in fallback ? fallback.roomId : undefined);

		if (roomId && !channelId) {
			const room = await this.runtime.getRoom(roomId);
			channelId = room?.channelId;
		}

		if (!channelId && fallback && "alias" in fallback && fallback.alias) {
			const normalizedAlias = normalizeDiscordConnectorQuery(fallback.alias);
			for (const guild of client.guilds.cache.values()) {
				const found = guild.channels.cache.find((channel) => {
					if (!channel || !isDiscordTextTarget(channel)) {
						return false;
					}
					const channelRecord = channel as Channel & { name?: string };
					return (
						channel.id === normalizedAlias ||
						channelRecord.name?.toLowerCase() === normalizedAlias
					);
				});
				if (found) {
					channelId = found.id;
					break;
				}
			}
		}

		if (!channelId) {
			throw new Error("Discord connector operation requires a channel target.");
		}

		const channel = await client.channels.fetch(channelId);
		if (!channel || !isDiscordTextTarget(channel) || !("messages" in channel)) {
			throw new Error(
				`Discord channel ${channelId} is not a text message channel.`,
			);
		}
		return channel as Channel & {
			id: string;
			name?: string;
			guild?: Guild;
			messages: TextChannel["messages"];
			permissionsFor?: TextChannel["permissionsFor"];
		};
	}

	private async fetchConnectorDiscordMessage(
		params: ConnectorMessageMutationParams,
	): Promise<Message> {
		const messageId = params.messageId;
		if (!messageId) {
			throw new Error("Discord message operation requires messageId.");
		}
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		return (await channel.messages.fetch(messageId)) as Message;
	}

	public async listConnectorServers(
		context: MessageConnectorQueryContext,
	): Promise<World[]> {
		const accountId = this.resolveAccountIdFromTarget(context.target, context);
		const client = this.getClient(accountId);
		if (!client) {
			return [];
		}
		return Promise.all(
			Array.from(client.guilds.cache.values()).map(async (guild) => {
				const worldId = createUniqueUuid(this.runtime, guild.id);
				// The persisted world carries durable metadata (server-wide
				// agentMuteState, ownership/roles) that a freshly fabricated World
				// would drop — start from it and refresh the live guild fields.
				const persisted = await this.runtime.getWorld(worldId);
				return {
					...persisted,
					id: worldId,
					agentId: this.runtime.agentId,
					name: guild.name,
					messageServerId: stringToUuid(guild.id),
					metadata: {
						...persisted?.metadata,
						source: "discord",
						accountId,
						discordGuildId: guild.id,
						memberCount: guild.memberCount,
					},
				};
			}),
		);
	}

	public async fetchConnectorMessages(
		_context: MessageConnectorQueryContext,
		params: ConnectorFetchMessagesParams,
	): Promise<Memory[]> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		const requestedLimit = normalizeRequestedConnectorLimit(params.limit);
		let before = params.before ?? params.cursor;
		const afterBoundary = params.after;
		if (before && afterBoundary) {
			throw new RangeError(
				"Discord message reads cannot combine before/cursor with after",
			);
		}
		if (afterBoundary && !/^\d+$/.test(afterBoundary)) {
			throw new RangeError("Discord after must be a snowflake message id");
		}
		const memories: Memory[] = [];
		const seenCursors = new Set<string>();
		while (requestedLimit === undefined || memories.length < requestedLimit) {
			const pageLimit = Math.min(
				100,
				requestedLimit === undefined ? 100 : requestedLimit - memories.length,
			);
			const fetched = await channel.messages.fetch({
				limit: pageLimit,
				...(before ? { before } : {}),
			});
			const page = Array.from(fetched.values()) as Message[];
			if (page.length === 0) break;
			const eligible = afterBoundary
				? page.filter((message) => BigInt(message.id) > BigInt(afterBoundary))
				: page;
			for (const discordMessage of eligible) {
				// A history read returns what was said; describing every historical
				// image and transcribing every clip through the models (one provider
				// call per attachment) turned a 3-message read into a minutes-long
				// turn (live 2026-09-15). Attachments are listed, not processed.
				const memory = await this.buildMemoryFromMessage(discordMessage, {
					accountId,
					processedContent: discordMessage.content,
					processedAttachments: historyAttachmentMedia(
						discordMessage.attachments.values(),
					),
				});
				if (memory) memories.push(memory);
			}
			if (
				afterBoundary &&
				page.some((message) => BigInt(message.id) <= BigInt(afterBoundary))
			) {
				break;
			}
			const cursorMessage = page.reduce((selected, candidate) => {
				return candidate.createdTimestamp < selected.createdTimestamp
					? candidate
					: selected;
			});
			if (seenCursors.has(cursorMessage.id)) {
				throw new Error("Discord message pagination repeated a cursor");
			}
			seenCursors.add(cursorMessage.id);
			before = cursorMessage.id;
		}
		const sorted = memories.sort(
			(left, right) =>
				Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
		);
		return requestedLimit === undefined
			? sorted
			: sorted.slice(0, requestedLimit);
	}

	public async searchConnectorMessages(
		context: MessageConnectorQueryContext,
		params: ConnectorSearchMessagesParams,
	): Promise<Memory[]> {
		const query = params.query?.trim().toLowerCase();
		if (!query) {
			return [];
		}
		const author = params.author?.trim().toLowerCase();
		const requestedLimit = normalizeRequestedConnectorLimit(params.limit);
		const memories = await this.fetchConnectorMessages(context, {
			...params,
			limit: undefined,
		});
		const matches = memories.filter((memory) => {
			const text = String(memory.content.text ?? "").toLowerCase();
			const name = String(memory.content.name ?? "").toLowerCase();
			const metadata = memory.metadata as Record<string, unknown> | undefined;
			const sender = metadata?.sender as Record<string, unknown> | undefined;
			const username = String(sender?.username ?? "").toLowerCase();
			const matchesQuery = text.includes(query) || name.includes(query);
			const matchesAuthor =
				!author || name.includes(author) || username.includes(author);
			return matchesQuery && matchesAuthor;
		});
		return requestedLimit === undefined
			? matches
			: matches.slice(0, requestedLimit);
	}

	public async reactConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<void> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const state = this.requireAccountState(accountId);
		const emoji = params.emoji?.trim();
		if (!emoji) {
			throw new Error("Discord reaction requires emoji.");
		}
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		if (params.remove) {
			const clientUserId = state.client?.user?.id;
			const reaction = targetMessage.reactions.cache.find(
				(candidate) =>
					candidate.emoji.name === emoji ||
					candidate.emoji.toString() === emoji,
			);
			if (reaction && clientUserId) {
				await reaction.users.remove(clientUserId);
			}
			return;
		}
		await targetMessage.react(emoji);
	}

	public async editConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<Memory> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const state = this.requireAccountState(accountId);
		const text = params.content?.text ?? params.text;
		if (!text?.trim()) {
			throw new Error("Discord edit requires non-empty text.");
		}
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		if (targetMessage.author.id !== state.client?.user?.id) {
			throw new Error(
				"Discord connector can only edit the bot's own messages.",
			);
		}
		const edited = await targetMessage.edit(text);
		const memory = await this.buildMemoryFromMessage(edited as Message, {
			accountId,
			extraMetadata: extractContentMetadata(params.content),
		});
		if (!memory) {
			throw new Error(
				"Discord edit succeeded but could not build updated memory.",
			);
		}
		return memory;
	}

	public async deleteConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<void> {
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		await targetMessage.delete();
	}

	public async pinConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<void> {
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		if (params.pin === false) {
			await targetMessage.unpin();
			return;
		}
		await targetMessage.pin();
	}

	public async sendConnectorTyping(
		_runtime: IAgentRuntime,
		params: ConnectorTypingParams,
	): Promise<void> {
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		await (channel as TextChannel).sendTyping();
	}

	public async createConnectorThread(
		_runtime: IAgentRuntime,
		params: ConnectorCreateThreadParams,
	): Promise<ThreadHandle> {
		const channel = (await this.resolveConnectorTextChannel(
			params.target,
			params,
		)) as TextChannel;
		if (!channel.threads) {
			throw new Error(
				`Discord channel ${channel.id} does not support thread creation.`,
			);
		}
		const name = (params.name ?? "thread").slice(0, 100);
		let startMessage: Message | undefined;
		if (params.parentMessageId) {
			try {
				startMessage = (await channel.messages.fetch(
					params.parentMessageId,
				)) as Message;
			} catch (err) {
				this.runtime.logger?.warn?.(
					{
						src: "plugin:discord",
						channelId: channel.id,
						parentMessageId: params.parentMessageId,
						err: err instanceof Error ? err.message : String(err),
					},
					"createConnectorThread: parent message lookup failed; creating channel-level thread",
				);
			}
		}
		const thread = await channel.threads.create({
			name,
			autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			...(startMessage ? { startMessage } : {}),
		});
		return { threadId: thread.id, parentChannelId: channel.id };
	}

	public async postToConnectorThread(
		runtime: IAgentRuntime,
		params: ConnectorPostToThreadParams,
	): Promise<Memory | undefined> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const state = this.requireAccountState(accountId);
		const client = state.client;
		if (!client?.isReady()) {
			throw new Error(`Discord client is not ready for account ${accountId}.`);
		}
		const text = params.content.text ?? "";
		if (!text.trim()) {
			throw new Error("postToConnectorThread requires non-empty content.text.");
		}
		const threadChannel = (await client.channels.fetch(
			params.thread.threadId,
		)) as ThreadChannel | null;
		if (!threadChannel) {
			throw new Error(`Discord thread ${params.thread.threadId} not found.`);
		}

		const chunks = chunkDiscordText(text);
		if (chunks.length === 0) {
			return undefined;
		}

		const textContent = text;
		const dedupeParams = {
			accountId,
			channelId: params.thread.threadId,
			text: textContent,
		};
		let outboundDedupe = beginDiscordOutboundDelivery(dedupeParams);
		while (outboundDedupe.kind === "in_flight") {
			const settled = await outboundDedupe.settlement;
			if (settled.kind === "settled") {
				const receiptIds = settled.receipt.providerMessageIds;
				if (receiptIds.length > 0) {
					try {
						const priorMemoryId = createUniqueUuid(runtime, receiptIds[0]);
						const prior = await runtime.getMemoryById?.(priorMemoryId);
						if (prior) return prior as Memory;
					} catch (error) {
						// error-policy:J1 The connector boundary preserves the settled
						// provider receipt while exposing an unavailable local memory.
						runtime.reportError("discord:outbound-dedupe-memory-read", error, {
							accountId,
							channelId: params.thread.threadId,
							providerMessageId: receiptIds[0],
						});
					}
				}
				return undefined;
			}
			outboundDedupe = beginDiscordOutboundDelivery(dedupeParams);
		}
		if (outboundDedupe.kind === "duplicate") {
			const receiptIds = outboundDedupe.receipt.providerMessageIds;
			if (receiptIds.length > 0) {
				try {
					const priorMemoryId = createUniqueUuid(runtime, receiptIds[0]);
					const prior = await runtime.getMemoryById?.(priorMemoryId);
					if (prior) return prior as Memory;
				} catch (error) {
					// error-policy:J1 The connector boundary preserves the settled
					// provider receipt while exposing an unavailable local memory.
					runtime.reportError("discord:outbound-dedupe-memory-read", error, {
						accountId,
						channelId: params.thread.threadId,
						providerMessageId: receiptIds[0],
					});
				}
			}
			return undefined;
		}
		let outboundReservation: DiscordOutboundDeliveryReservation | undefined =
			outboundDedupe.kind === "deliver"
				? outboundDedupe.reservation
				: undefined;

		// Resolve webhook once if identity requested; shared dedupe/persistence contract covers both paths.
		let webhook: Webhook | null = null;
		if (params.identity?.name && params.thread.parentChannelId) {
			try {
				const parent = (await client.channels.fetch(
					params.thread.parentChannelId,
				)) as TextChannel | null;
				if (parent) {
					webhook = await this.findOrCreateWebhook(
						parent,
						params.identity.name,
					);
					if (!webhook) {
						runtime.logger?.warn?.(
							{
								src: "plugin:discord",
								channelId: parent.id,
								requestedIdentity: params.identity.name,
							},
							"postToConnectorThread: webhook unavailable (likely missing MANAGE_WEBHOOKS or 10-per-channel limit); falling back to bot identity",
						);
					}
				}
			} catch (err) {
				// error-policy:J4 Webhook identity is optional, so a parent lookup
				// failure visibly falls back to the bot identity.
				runtime.logger.warn(
					{
						src: "plugin:discord",
						channelId: params.thread.parentChannelId,
						err: err instanceof Error ? err.message : String(err),
					},
					"postToConnectorThread: parent channel fetch failed; falling back to bot identity",
				);
			}
		}

		const sentMessages: Message[] = [];
		let providerAcceptedAt: number | undefined;
		let providerSendFailure: unknown;
		let acceptedProviderMessages: Message[] = [];

		try {
			for (const chunk of chunks) {
				try {
					let sent: Message;
					if (webhook) {
						sent = (await webhook.send({
							content: chunk,
							threadId: params.thread.threadId,
							username: params.identity?.name,
							...(params.identity?.avatarUrl
								? { avatarURL: params.identity.avatarUrl }
								: {}),
						})) as unknown as Message;
					} else {
						sent = (await threadChannel.send(chunk)) as Message;
					}
					sentMessages.push(sent);
					acceptedProviderMessages = [...sentMessages];
					providerAcceptedAt ??=
						(sent as unknown as { createdTimestamp?: number })
							.createdTimestamp ?? Date.now();
				} catch (error) {
					// error-policy:J1 The provider boundary records an accepted prefix
					// as partial delivery instead of allowing a duplicate retry.
					providerSendFailure = error;
					if (sentMessages.length === 0) {
						throw error;
					}
					runtime.reportError("discord:outbound-partial-delivery", error, {
						accountId,
						channelId: params.thread.threadId,
						providerMessageIds: sentMessages.map((m) => m.id),
					});
					break;
				}
			}

			if (sentMessages.length === 0) {
				outboundReservation?.release();
				outboundReservation = undefined;
				throw (
					providerSendFailure ??
					new Error("Discord thread send produced no accepted messages.")
				);
			}

			const persistedMemories: Memory[] = [];
			const persistenceFailures: SendHandlerPersistenceFailure[] = [];
			for (const sentMsg of sentMessages) {
				try {
					const built = await this.buildMemoryFromMessage(sentMsg, {
						accountId,
						extraMetadata: extractContentMetadata(params.content),
					});
					if (!built)
						throw new Error("Failed to build memory from thread message.");
					const persisted = await createDiscordMessageMemoryOnce(
						runtime,
						built,
						{
							operation: "discord-connector-postToThread",
							platformMessageId: sentMsg.id,
						},
					);
					if (!persisted)
						throw new Error(
							"Discord thread memory persistence returned no stored record.",
						);
					persistedMemories.push(persisted);
				} catch (error) {
					// error-policy:J1 The connector boundary records provider
					// acceptance even when its local memory cannot be persisted.
					persistenceFailures.push({
						providerMessageId: sentMsg.id,
						stage: "memory",
						code: deliveryErrorCode(error),
						message: deliveryErrorMessage(error),
					});
					runtime.reportError("discord:outbound-memory-persistence", error, {
						accountId,
						channelId: params.thread.threadId,
						providerMessageId: sentMsg.id,
					});
				}
			}

			const receipt = buildDiscordSendReceipt({
				messages: sentMessages,
				acceptedAt: providerAcceptedAt ?? Date.now(),
				persistedMemories,
				failures: persistenceFailures,
			});
			const deliveryKind = providerSendFailure
				? "partially_delivered"
				: "delivered";
			outboundReservation?.commit(deliveryKind, receipt);
			outboundReservation = undefined;

			if (persistedMemories.length === 0) {
				return undefined;
			}
			return persistedMemories[persistedMemories.length - 1];
		} catch (error) {
			// error-policy:J1 The connector boundary preserves any provider-
			// accepted prefix and releases only reservations with no acceptance.
			if (outboundReservation && acceptedProviderMessages.length > 0) {
				const receipt: SendHandlerReceipt = {
					providerMessageIds: providerMessageIds(acceptedProviderMessages),
					acceptedAt: Date.now(),
					persistence: {
						status: "failed",
						failures: acceptedProviderMessages.map((m) => ({
							providerMessageId: m.id,
							stage: "memory" as const,
							code: deliveryErrorCode(error),
							message: deliveryErrorMessage(error),
						})),
					},
				};
				outboundReservation.commit(
					providerSendFailure ? "partially_delivered" : "delivered",
					receipt,
				);
				outboundReservation = undefined;
				runtime.reportError("discord:outbound-finalization", error, {
					accountId,
					providerMessageIds: receipt.providerMessageIds,
				});
				try {
					const fallbackId = createUniqueUuid(
						runtime,
						acceptedProviderMessages[0].id,
					);
					const prior = await runtime.getMemoryById?.(fallbackId);
					if (prior) return prior as Memory;
				} catch (memoryReadError) {
					// error-policy:J1 Provider delivery remains settled while the
					// failed local lookup is reported as unavailable.
					runtime.reportError(
						"discord:outbound-finalization-memory-read",
						memoryReadError,
						{
							accountId,
							channelId: params.thread.threadId,
							providerMessageId: acceptedProviderMessages[0].id,
						},
					);
				}
				return undefined;
			}
			outboundReservation?.release();
			throw error;
		}
	}

	private async findOrCreateWebhook(
		channel: TextChannel,
		name: string,
	): Promise<Webhook | null> {
		let existing: Collection<string, Webhook> | undefined;
		try {
			existing = await channel.fetchWebhooks();
		} catch (err) {
			this.runtime.logger?.warn?.(
				{
					src: "plugin:discord",
					channelId: channel.id,
					err: err instanceof Error ? err.message : String(err),
				},
				"findOrCreateWebhook: fetchWebhooks failed",
			);
			return null;
		}
		const found = existing.find((w) => w.name === name);
		if (found) return found;
		try {
			return await channel.createWebhook({ name });
		} catch (err) {
			this.runtime.logger?.warn?.(
				{
					src: "plugin:discord",
					channelId: channel.id,
					name,
					err: err instanceof Error ? err.message : String(err),
				},
				"findOrCreateWebhook: createWebhook failed (likely 10-webhook channel limit or permissions)",
			);
			return null;
		}
	}

	public async joinConnectorChannel(
		_runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	): Promise<Room> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		this.addAllowedChannel(channel.id, accountId);

		const guild = "guild" in channel ? channel.guild : null;
		const roomId = createUniqueUuid(this.runtime, channel.id);
		const worldId = createUniqueUuid(this.runtime, guild?.id ?? channel.id);
		const room: Room = {
			id: roomId,
			agentId: this.runtime.agentId,
			name: channel.name ?? channel.id,
			source: "discord",
			type: await this.getChannelType(channel as Channel),
			channelId: channel.id,
			worldId,
			serverId: guild?.id,
			messageServerId: guild?.id ? stringToUuid(guild.id) : undefined,
			metadata: {
				accountId,
				discordChannelId: channel.id,
				discordGuildId: guild?.id,
				discordGuildName: guild?.name,
			},
		};

		const runtimeWithEnsure = this.runtime as typeof this.runtime & {
			ensureRoomExists?: (room: Room) => Promise<void>;
			createRoom?: (room: Room) => Promise<UUID | undefined>;
		};
		if (typeof runtimeWithEnsure.ensureRoomExists === "function") {
			await runtimeWithEnsure.ensureRoomExists(room);
		} else if (typeof runtimeWithEnsure.createRoom === "function") {
			const existing = await this.runtime.getRoom(roomId);
			if (!existing) {
				await runtimeWithEnsure.createRoom(room);
			}
		}

		return (await this.runtime.getRoom(roomId)) ?? room;
	}

	public async leaveConnectorChannel(
		_runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	): Promise<void> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		this.removeAllowedChannel(channel.id, accountId);
	}

	public resolveManageConnectorServerDestination(
		runtime: IAgentRuntime,
		params: { target?: TargetInfo; serverId: string; accountId?: string },
	): MessageConnectorManageServerDestination {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		return resolveDiscordManageServerDestination(runtime, params, accountId);
	}

	private async revalidateLiveGuildManagementAuthorization(
		runtime: IAgentRuntime,
		authorization: MessageConnectorManageServerAuthorization,
		accountId: string,
		guild: Guild,
	): Promise<void> {
		await revalidateDiscordManageServerAuthorization(
			runtime,
			authorization,
			accountId,
			guild.id,
		);

		let members: Collection<string, GuildMember>;
		try {
			members = await guild.members.fetch();
		} catch (error) {
			// error-policy:J2 live provider membership is required for authorization.
			throw new ElizaError(
				"Discord could not verify live guild membership for server management.",
				{
					code: "DISCORD_MANAGE_SERVER_MEMBERSHIP_LOOKUP_FAILED",
					context: { accountId, guildId: guild.id },
					cause: error,
				},
			);
		}
		// Refresh durable identity membership after the provider fetch; the
		// initial authorization may have memoized a cluster that was revoked
		// while Discord was resolving the guild members.
		await revalidateDiscordManageServerAuthorization(
			runtime,
			authorization,
			accountId,
			guild.id,
		);
		const verifiedCluster = new Set(
			await getVerifiedRelatedEntityIds(
				runtime,
				authorization.requesterEntityId,
			),
		);
		const isLiveMember = [...members.values()].some((member) =>
			verifiedCluster.has(this.resolveDiscordEntityId(member.id)),
		);
		if (!isLiveMember) {
			throw new ElizaError(
				"Discord server management requires the authorized entity to remain a live guild member.",
				{
					code: "DISCORD_MANAGE_SERVER_LIVE_MEMBERSHIP_REQUIRED",
					context: {
						accountId,
						guildId: guild.id,
						authorizedEntityId: authorization.authorizedEntityId,
					},
				},
			);
		}

		// The provider lookup above is an awaited revocation window. Re-read the
		// durable entity, room, binding, and role state immediately before the
		// caller is allowed to proceed to a Discord write.
		await revalidateDiscordManageServerAuthorization(
			runtime,
			authorization,
			accountId,
			guild.id,
		);
	}

	private async withGuildTemplateReconcileLock<T>(
		key: string,
		run: () => Promise<T>,
	): Promise<T> {
		// Some focused tests construct the service from its prototype, so retain
		// the production field initializer while also making that harness safe.
		this.guildTemplateReconcileLocks ??= new Map<string, Promise<void>>();
		const previous = this.guildTemplateReconcileLocks.get(key);
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.guildTemplateReconcileLocks.set(key, current);
		if (previous) await previous;
		try {
			return await run();
		} finally {
			release();
			if (this.guildTemplateReconcileLocks.get(key) === current) {
				this.guildTemplateReconcileLocks.delete(key);
			}
		}
	}

	/**
	 * Structural guild management entry point for the message tool
	 * (`MESSAGE op=manage_server source=discord`). Fail-closed: every write
	 * requires the corresponding `actions.channels|roles|permissions|moderation`
	 * gate to be explicitly enabled for this account, and role/member writes
	 * validate Discord role hierarchy inside `executeGuildManagement`.
	 */
	public async manageConnectorServer(
		runtime: IAgentRuntime,
		params: {
			target?: TargetInfo;
			operation: string;
			serverId?: string;
			authorization: MessageConnectorManageServerAuthorization;
			params?: Record<string, unknown>;
			accountId?: string;
		},
	): Promise<{ summary: string; data?: Record<string, unknown> }> {
		const accountId = this.resolveAccountIdFromTarget(params.target, params);
		const client = this.getClient(accountId);
		if (!client?.isReady()) {
			throw new Error(`Discord client is not ready for account ${accountId}.`);
		}
		if (
			params.serverId !== params.authorization.serverId ||
			params.target?.serverId !== params.authorization.serverId
		) {
			throw new ElizaError(
				"Discord guild-management parameters do not match the trusted destination authorization.",
				{
					code: "DISCORD_MANAGE_SERVER_PROVENANCE_MISMATCH",
					context: { accountId },
				},
			);
		}
		await revalidateDiscordManageServerAuthorization(
			runtime,
			params.authorization,
			accountId,
			params.authorization.serverId,
		);
		const guild = await client.guilds.fetch(params.authorization.serverId);
		await this.revalidateLiveGuildManagementAuthorization(
			runtime,
			params.authorization,
			accountId,
			guild,
		);
		const gates = this.getGuildManagementGates(accountId);
		const raw = params.params ?? {};
		const request: GuildManagementRequest = {
			operation: params.operation as GuildManagementRequest["operation"],
			guildId: guild.id,
			channelId: stringOrUndefined(raw.channelId ?? params.target?.channelId),
			parentId: stringOrUndefined(raw.parentId),
			roleId: stringOrUndefined(raw.roleId),
			userId: stringOrUndefined(raw.userId),
			name: stringOrUndefined(raw.name),
			topic: stringOrUndefined(raw.topic),
			channelType: stringOrUndefined(raw.channelType),
			color: stringOrUndefined(raw.color),
			hoist: booleanOrUndefined(raw.hoist),
			mentionable: booleanOrUndefined(raw.mentionable),
			permissions: stringArrayOrUndefined(raw.permissions),
			allow: stringArrayOrUndefined(raw.allow),
			deny: stringArrayOrUndefined(raw.deny),
			overwriteId: stringOrUndefined(raw.overwriteId),
			reason: stringOrUndefined(raw.reason),
			durationMinutes: numberOrUndefined(raw.durationMinutes),
			deleteMessageSeconds: numberOrUndefined(raw.deleteMessageSeconds),
			maxAgeSeconds: numberOrUndefined(raw.maxAgeSeconds),
			maxUses: numberOrUndefined(raw.maxUses),
			unique: booleanOrUndefined(raw.unique),
			template: stringOrUndefined(raw.template),
			templateSpec:
				raw.templateSpec && typeof raw.templateSpec === "object"
					? (raw.templateSpec as GuildTemplate)
					: undefined,
			variables:
				raw.variables && typeof raw.variables === "object"
					? (raw.variables as Record<string, string>)
					: undefined,
			dryRun: booleanOrUndefined(raw.dryRun),
		};
		const stateStore: TemplateStateStore = {
			get: async (guildId, templateId) =>
				(await runtime.getCache<Record<string, string>>(
					`discord:guild-template:${accountId}:${guildId}:${templateId}`,
				)) ?? undefined,
			set: async (guildId, templateId, state) => {
				await runtime.setCache(
					`discord:guild-template:${accountId}:${guildId}:${templateId}`,
					state,
				);
			},
		};
		const executeAuthorized = async (): Promise<GuildManagementReceipt> => {
			await this.revalidateLiveGuildManagementAuthorization(
				runtime,
				params.authorization,
				accountId,
				guild,
			);
			return executeGuildManagement(
				{
					guild: guild as unknown as ManageableGuild,
					gates,
					stateStore,
					templateRegistry: this.getGuildTemplateRegistry(accountId),
					agentName: this.runtime.character?.name,
					reasonPrefix: `eliza:${this.runtime.character?.name ?? "agent"} guild management`,
					beforeMutation: async () => {
						await this.revalidateLiveGuildManagementAuthorization(
							runtime,
							params.authorization,
							accountId,
							guild,
						);
					},
				},
				request,
			);
		};
		const templateIdentity =
			request.templateSpec?.id?.trim() || request.template?.trim();
		const receipt =
			request.operation === "apply_template" && templateIdentity
				? await this.withGuildTemplateReconcileLock(
						JSON.stringify([accountId, guild.id, templateIdentity]),
						executeAuthorized,
					)
				: await executeAuthorized();
		return {
			summary: receipt.summary,
			data: receipt as unknown as Record<string, unknown>,
		};
	}

	/**
	 * Structural-management gates for one account. Reads
	 * `settings.discord.actions` with per-account overrides and env fallbacks
	 * (`DISCORD_ACTIONS_CHANNELS|ROLES|PERMISSIONS|MODERATION`). Absent means
	 * OFF — structural writes are opt-in.
	 */
	private getGuildManagementGates(accountId: string) {
		const settings = this.runtime.character?.settings?.discord as
			| {
					actions?: Record<string, unknown>;
					accounts?: Record<string, { actions?: Record<string, unknown> }>;
			  }
			| undefined;
		const merged: Record<string, unknown> = {
			...(settings?.actions ?? {}),
			...(settings?.accounts?.[accountId]?.actions ?? {}),
		};
		for (const [envKey, gateKey] of [
			["DISCORD_ACTIONS_CHANNELS", "channels"],
			["DISCORD_ACTIONS_ROLES", "roles"],
			["DISCORD_ACTIONS_PERMISSIONS", "permissions"],
			["DISCORD_ACTIONS_MODERATION", "moderation"],
		] as const) {
			if (merged[gateKey] === undefined) {
				const rawSetting = this.runtime.getSetting(envKey);
				if (rawSetting !== undefined && rawSetting !== null) {
					merged[gateKey] = parseBooleanFromText(String(rawSetting));
				}
			}
		}
		return resolveGuildManagementGates(merged);
	}

	/** Deployment-supplied template registry (merged over the built-ins). */
	private getGuildTemplateRegistry(
		accountId: string,
	): Record<string, GuildTemplate> | undefined {
		const settings = this.runtime.character?.settings?.discord as
			| {
					guildTemplates?: Record<string, GuildTemplate>;
					accounts?: Record<
						string,
						{ guildTemplates?: Record<string, GuildTemplate> }
					>;
			  }
			| undefined;
		const base = settings?.guildTemplates;
		const account = settings?.accounts?.[accountId]?.guildTemplates;
		if (!base && !account) return undefined;
		return { ...(base ?? {}), ...(account ?? {}) };
	}

	public async getConnectorUser(
		_runtime: IAgentRuntime,
		params: ConnectorUserLookupParams,
	): Promise<unknown> {
		const accountId = normalizeAccountId(
			params.accountId ?? this.defaultAccountId,
		);
		const client = this.getClient(accountId);
		if (!client) {
			return null;
		}
		const lookup =
			params.userId ?? params.handle ?? params.username ?? params.query;
		if (!lookup) {
			return null;
		}

		let user: User | null = null;
		if (DISCORD_SNOWFLAKE_PATTERN.test(lookup)) {
			user = await client.users.fetch(lookup).catch(() => null);
		}
		if (!user) {
			const normalized = normalizeDiscordConnectorQuery(lookup);
			for (const guild of client.guilds.cache.values()) {
				const cached = guild.members.cache.find((member) =>
					[
						member.id,
						member.displayName,
						member.user.username,
						member.user.globalName,
						member.user.tag,
					]
						.filter((value): value is string => Boolean(value))
						.some((value) =>
							normalizeDiscordConnectorQuery(value).includes(normalized),
						),
				);
				if (cached) {
					user = cached.user;
					break;
				}
			}
		}
		if (!user) {
			return null;
		}

		return {
			id: this.resolveDiscordEntityId(user.id),
			agentId: this.runtime.agentId,
			names: [user.globalName, user.username, user.tag].filter(
				(value): value is string => Boolean(value),
			),
			metadata: {
				source: "discord",
				accountId,
				discord: {
					accountId,
					id: user.id,
					userId: user.id,
					username: user.username,
					globalName: user.globalName,
					tag: user.tag,
				},
			},
		};
	}

	/**
	 * Set up event listeners for the client.
	 * Delegates to the extracted setupDiscordEventListeners() function.
	 * @private
	 */
	private setupEventListenersForAccount(state: DiscordAccountClientState) {
		if (!state.client) {
			return;
		}

		const { channelDebouncer } = setupDiscordEventListeners(
			this.createAccountServiceFacade(state),
		);

		state.channelDebouncer = channelDebouncer;
		if (state.accountId === this.defaultAccountId) {
			this.channelDebouncer = channelDebouncer;
		}
	}

	/** Per-account DM channel registries for cold-start scan coverage (#18746). */
	private dmRegistries = new Map<string, DmChannelRegistry>();

	/**
	 * Record an observed DM channel so a cold restart can re-open and scan it.
	 * Called from the message path; must never throw into message handling.
	 */
	public recordDmChannel(
		accountId: string,
		channelId: string,
		recipientId: string,
	): void {
		this.getDmRegistry(accountId).record(channelId, recipientId);
	}

	/**
	 * Construct-on-demand so the READY path can load persisted records on a
	 * cold boot. Getting the registry only when a DM arrives would leave the
	 * scan with an empty map on exactly the restart the persistence exists
	 * for (#18746 live-run finding).
	 */
	private getDmRegistry(accountId: string): DmChannelRegistry {
		let registry = this.dmRegistries.get(accountId);
		if (!registry) {
			registry = new DmChannelRegistry({
				filePath: nodePath.join(
					resolveStateDir(),
					"discord",
					`dm-channels-${accountId}.json`,
				),
				logger: this.runtime.logger,
			});
			this.dmRegistries.set(accountId, registry);
		}
		return registry;
	}

	/**
	 * Handles tasks to be performed once the Discord client is fully ready. Delegates to extracted module.
	 * @private
	 */
	private async onReadyForAccount(
		accountId: string,
		readyClient: DiscordJsClient<true>,
	) {
		const state = this.requireAccountState(accountId);
		await onReadyExtracted(this.createAccountServiceFacade(state), readyClient);
		// Detached: a stranded-reaction cleanup must never reject the ready
		// path (a post-ready throw is treated as a terminal login failure),
		// and it needs no result — it logs its own summary (#16318).
		const scanSetting = String(
			this.runtime.getSetting(STARTUP_REACTION_SCAN_SETTING) ?? "",
		).toLowerCase();
		if (scanSetting !== "0" && scanSetting !== "false") {
			void (async () => {
				const reopened = await reopenPersistedDms({
					client: readyClient,
					records: this.getDmRegistry(accountId).listRecent(),
					logger: this.runtime.logger,
				});
				return reconcileStrandedStatusReactions({
					client: readyClient,
					logger: this.runtime.logger,
					dmChannels: reopened.channels,
					// Listeners bind before login, so a turn started by THIS process
					// can already be in flight (with a live ⏳/🤔) when the scan runs;
					// the registry marks those markers as current, not crash residue.
					isTurnActive: (messageId) =>
						this.turnDrainRegistry.isPending(messageId),
				});
			})().catch((error) => {
				// error-policy:J7 the scan is detached diagnostics/cleanup off the
				// ready path; a failure is warned here and must never surface as a
				// terminal login failure for the account.
				this.runtime.logger.warn(
					`[DiscordService] Startup reaction scan failed for account ${accountId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
		}
		const voiceChannelIds = String(
			this.runtime.getSetting("DISCORD_VOICE_CHANNEL_ID") ?? "",
		)
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
		if (voiceChannelIds.length > 0 && state.voiceManager) {
			const guilds = await readyClient.guilds.fetch();
			for (const [, guild] of guilds) {
				const fullGuild = await guild.fetch();
				await state.voiceManager.scanGuild(fullGuild);
			}
		}
	}

	/**
	 * Registers send handlers for the Discord service instance.
	 * @static
	 */
	static registerSendHandlers(
		runtime: IAgentRuntime,
		serviceInstance: DiscordService,
	) {
		if (serviceInstance) {
			if (typeof runtime.registerMessageConnector === "function") {
				const accountIds =
					typeof serviceInstance.getAccountIds === "function"
						? serviceInstance.getAccountIds()
						: [];
				const defaultAccountId =
					typeof serviceInstance.getDefaultAccountId === "function"
						? serviceInstance.getDefaultAccountId()
						: DEFAULT_ACCOUNT_ID;
				const registerConnector = (
					accountId: string | undefined,
					legacy = false,
				) => {
					const scopedTarget = (target: TargetInfo): TargetInfo =>
						({
							...target,
							accountId: accountIdFromRecord(target) ?? accountId,
						}) as TargetInfo;
					const scopedContext = (
						context: MessageConnectorQueryContext,
					): MessageConnectorQueryContext =>
						({
							...context,
							accountId: accountIdFromRecord(context) ?? accountId,
							target: context.target ? scopedTarget(context.target) : undefined,
						}) as MessageConnectorQueryContext;
					const scopedFetchParams = <
						T extends
							| ConnectorFetchMessagesParams
							| ConnectorSearchMessagesParams
							| ConnectorMessageMutationParams
							| ConnectorChannelMutationParams
							| ConnectorUserLookupParams
							| ConnectorTypingParams
							| ConnectorCreateThreadParams
							| ConnectorPostToThreadParams,
					>(
						params: T,
					): T => ({
						...params,
						accountId: params.accountId ?? accountId,
						...("target" in params && params.target
							? { target: scopedTarget(params.target) }
							: {}),
					});
					const label = accountId
						? `Discord (${serviceInstance.getAccountLabel(accountId)})`
						: "Discord";
					const registration: ExtendedMessageConnectorRegistration = {
						source: "discord",
						...(accountId ? { accountId } : {}),
						...(accountId
							? {
									account: {
										source: "discord",
										accountId,
										label: serviceInstance.getAccountLabel(accountId),
									},
								}
							: {}),
						label,
						description:
							"Discord connector for sending, reading, searching, reacting to, editing, deleting, pinning, joining, and leaving messages/channels, plus gated structural server management (channels, categories, roles, permissions, invites, moderation, guild templates).",
						capabilities: [...DISCORD_CONNECTOR_CAPABILITIES],
						supportedTargetKinds: ["channel", "thread", "user"],
						contexts: [...DISCORD_CONNECTOR_CONTEXTS],
						metadata: {
							service: DISCORD_SERVICE_NAME,
							supportsAttachments: true,
							maxMessageLength: MAX_MESSAGE_LENGTH,
							defaultAccountId,
							...(accountId ? { accountId } : {}),
						},
						resolveTargets: (query, context) =>
							serviceInstance.resolveConnectorTargets(
								query,
								scopedContext(context),
							),
						listRecentTargets: (context) =>
							serviceInstance.listRecentConnectorTargets(
								scopedContext(context),
							),
						listRooms: (context) =>
							serviceInstance.listConnectorRooms(scopedContext(context)),
						listServers: (context) =>
							serviceInstance.listConnectorServers(scopedContext(context)),
						fetchMessages: (context, params) =>
							serviceInstance.fetchConnectorMessages(
								scopedContext(context),
								scopedFetchParams(params),
							),
						searchMessages: (context, params) =>
							serviceInstance.searchConnectorMessages(
								scopedContext(context),
								scopedFetchParams(params),
							),
						reactHandler: (runtime, params) =>
							serviceInstance.reactConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						editHandler: (runtime, params) =>
							serviceInstance.editConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						deleteHandler: (runtime, params) =>
							serviceInstance.deleteConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						pinHandler: (runtime, params) =>
							serviceInstance.pinConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						joinHandler: (runtime, params) =>
							serviceInstance.joinConnectorChannel(
								runtime,
								scopedFetchParams(params),
							),
						leaveHandler: (runtime, params) =>
							serviceInstance.leaveConnectorChannel(
								runtime,
								scopedFetchParams(params),
							),
						getUser: (runtime, params) =>
							serviceInstance.getConnectorUser(
								runtime,
								scopedFetchParams(params),
							),
						getChatContext: (target, context) =>
							serviceInstance.getConnectorChatContext(
								scopedTarget(target),
								scopedContext(context),
							),
						getUserContext: (entityId, context) =>
							serviceInstance.getConnectorUserContext(
								entityId,
								scopedContext(context),
							),
						sendHandler: (runtime, target, content) =>
							serviceInstance.handleSendMessage(
								runtime,
								scopedTarget(target),
								content,
							),
						typingHandler: (runtime, params) =>
							serviceInstance.sendConnectorTyping(
								runtime,
								scopedFetchParams(params),
							),
						createThreadHandler: (runtime, params) =>
							serviceInstance.createConnectorThread(
								runtime,
								scopedFetchParams(params),
							),
						postToThreadHandler: (runtime, params) =>
							serviceInstance.postToConnectorThread(
								runtime,
								scopedFetchParams(params),
							),
						resolveManageServerDestination: (runtime, params) =>
							serviceInstance.resolveManageConnectorServerDestination(runtime, {
								...params,
								accountId:
									accountIdFromRecord(params.target) ??
									accountId ??
									defaultAccountId,
								target: params.target ? scopedTarget(params.target) : undefined,
							}),
						manageServerHandler: (runtime, params) =>
							serviceInstance.manageConnectorServer(runtime, {
								...params,
								accountId: accountIdFromRecord(params.target) ?? accountId,
								target: params.target ? scopedTarget(params.target) : undefined,
							}),
					};
					runtime.registerMessageConnector(registration);
					runtime.logger.info(
						accountId && !legacy
							? `Registered Discord message connector for account ${accountId}`
							: "Registered Discord message connector",
					);
				};

				registerConnector(undefined, true);
				for (const accountId of accountIds) {
					registerConnector(accountId);
				}
			} else {
				const sendHandler =
					serviceInstance.handleSendMessage.bind(serviceInstance);
				runtime.registerSendHandler("discord", sendHandler);
				runtime.logger.info("Registered send handler");
			}
		}
	}

	/**
	 * Fetches all members who have access to a specific text channel.
	 */
	public async getTextChannelMembers(
		channelId: string,
		useCache: boolean = true,
		accountId?: string | null,
	): Promise<Array<{ id: string; username: string; displayName: string }>> {
		const state = this.getAccountState(accountId);
		const client = state?.client ?? null;
		this.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				accountId: state?.accountId ?? this.defaultAccountId,
				channelId,
				useCache,
			},
			"Fetching members for text channel",
		);

		try {
			const channel = client
				? ((await client.channels.fetch(channelId)) as TextChannel)
				: null;

			if (!channel) {
				this.runtime.logger.error(
					{ src: "plugin:discord", agentId: this.runtime.agentId, channelId },
					"Channel not found",
				);
				return [];
			}

			if (channel.type !== DiscordChannelType.GuildText) {
				this.runtime.logger.error(
					{ src: "plugin:discord", agentId: this.runtime.agentId, channelId },
					"Channel is not a text channel",
				);
				return [];
			}

			const guild = channel.guild;
			if (!guild) {
				this.runtime.logger.error(
					{ src: "plugin:discord", agentId: this.runtime.agentId, channelId },
					"Channel is not in a guild",
				);
				return [];
			}

			const useCacheOnly = useCache && guild.memberCount > 1000;
			let members: Collection<string, GuildMember>;

			if (useCacheOnly) {
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						guildId: guild.id,
						memberCount: guild.memberCount.toLocaleString(),
					},
					"Using cached members for large guild",
				);
				members = guild.members.cache;
			} else {
				try {
					if (useCache && guild.members.cache.size > 0) {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								cacheSize: guild.members.cache.size,
							},
							"Using cached members",
						);
						members = guild.members.cache;
					} else {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								guildId: guild.id,
							},
							"Fetching members for guild",
						);
						members = await guild.members.fetch();
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								memberCount: members.size.toLocaleString(),
							},
							"Fetched members",
						);
					}
				} catch (error) {
					this.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Error fetching members",
					);
					members = guild.members.cache;
					this.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							cacheSize: members.size,
						},
						"Fallback to cache",
					);
				}
			}

			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					channelId: channel.id,
				},
				"Filtering members for channel access",
			);
			const memberArray: GuildMember[] = Array.from(members.values());
			const channelMembers = memberArray
				.filter((member: GuildMember) => {
					const clientUser = client?.user;
					if (member.user.bot && clientUser && member.id !== clientUser.id) {
						return false;
					}

					return (
						channel
							.permissionsFor(member)
							.has(PermissionsBitField.Flags.ViewChannel) || false
					);
				})
				.map((member: GuildMember) => ({
					id: member.id,
					username: member.user.username,
					displayName: member.displayName || member.user.username,
				}));

			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					channelId: channel.id,
					memberCount: channelMembers.length.toLocaleString(),
				},
				"Found members with channel access",
			);
			return channelMembers;
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error fetching channel members",
			);
			return [];
		}
	}

	/**
	 * Fetches the topic/description of a Discord text channel.
	 */
	public async getChannelTopic(
		channelId: string,
		accountId?: string | null,
	): Promise<string | null> {
		try {
			const client = this.getClient(accountId);
			const channel = client ? await client.channels.fetch(channelId) : null;
			if (channel && "topic" in channel) {
				return (channel as TextChannel).topic;
			}
			return null;
		} catch (error) {
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					channelId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to fetch channel topic",
			);
			return null;
		}
	}

	/**
	 * Checks if a channel ID is allowed based on both env config and dynamic additions.
	 */
	public isChannelAllowed(
		channelId: string,
		accountId?: string | null,
	): boolean {
		const state = this.getAccountState(accountId);
		const allowedChannelIds =
			state?.allowedChannelIds ??
			(accountId ? undefined : this.allowedChannelIds);
		const dynamicChannelIds =
			state?.dynamicChannelIds ??
			(accountId ? new Set<string>() : this.dynamicChannelIds);
		if (!allowedChannelIds) {
			return true;
		}
		return (
			allowedChannelIds.includes(channelId) || dynamicChannelIds.has(channelId)
		);
	}

	/**
	 * Adds a channel to the dynamic allowed list.
	 */
	public addAllowedChannel(
		channelId: string,
		accountId?: string | null,
	): boolean {
		const state = this.getAccountState(accountId);
		const client = state?.client ?? this.client;
		if (!client?.channels.cache.has(channelId)) {
			return false;
		}
		(state?.dynamicChannelIds ?? this.dynamicChannelIds).add(channelId);
		return true;
	}

	/**
	 * Removes a channel from the dynamic allowed list.
	 */
	public removeAllowedChannel(
		channelId: string,
		accountId?: string | null,
	): boolean {
		const state = this.getAccountState(accountId);
		const allowedChannelIds =
			state?.allowedChannelIds ?? this.allowedChannelIds;
		const dynamicChannelIds =
			state?.dynamicChannelIds ?? this.dynamicChannelIds;
		if (allowedChannelIds?.includes(channelId)) {
			return false;
		}
		return dynamicChannelIds.delete(channelId);
	}

	/**
	 * Gets the list of all allowed channels (env + dynamic).
	 */
	public getAllowedChannels(accountId?: string | null): string[] {
		const state = this.getAccountState(accountId);
		const envChannels =
			state?.allowedChannelIds ?? this.allowedChannelIds ?? [];
		const dynamicChannels = Array.from(
			state?.dynamicChannelIds ?? this.dynamicChannelIds,
		);
		return [...new Set([...envChannels, ...dynamicChannels])];
	}

	/**
	 * Fetches and persists message history from a Discord channel. Delegates to extracted module.
	 */
	public async fetchChannelHistory(
		channelId: string,
		options: ChannelHistoryOptions = {},
	): Promise<ChannelHistoryResult> {
		const state = this.getAccountState(options.accountId);
		return fetchChannelHistoryExtracted(
			this.createAccountServiceFacade(state),
			channelId,
			options,
		);
	}

	/**
	 * Builds a Memory object from a Discord Message. Delegates to extracted module.
	 */
	public async buildMemoryFromMessage(
		message: Message,
		options?: {
			processedContent?: string;
			processedAttachments?: Media[];
			extraContent?: Record<string, unknown>;
			extraMetadata?: Record<string, unknown>;
			accountId?: string;
		},
	): Promise<Memory | null> {
		// Always stamp the connector accountId on inbound memory. Explicit
		// per-call overrides win for legacy callers that already supply one.
		const merged = {
			...options,
			accountId: options?.accountId ?? this.accountId,
		};
		return buildMemoryFromMessageExtracted(
			this.createAccountServiceFacade(this.getAccountState(merged.accountId)),
			message,
			merged,
		);
	}

	/**
	 * Maps a Discord snowflake user id to the runtime entity UUID, substituting
	 * the canonical Eliza owner entity when the user is a known Discord owner.
	 */
	public resolveDiscordEntityId(userId: string): UUID {
		return resolveDiscordRuntimeEntityId(
			this.runtime,
			userId,
			this.ownerDiscordUserIds,
		) as UUID;
	}

	/**
	 * True when the Discord user reaches the canonical owner entity through the
	 * owner alias list rather than through its own derived entity id. Aliased
	 * identities must never contribute display names or metadata to the
	 * canonical entity.
	 */
	public isOwnerAliasedDiscordUser(userId: string): boolean {
		return isAliasedDiscordEntityId(
			this.runtime,
			userId,
			this.resolveDiscordEntityId(userId),
		);
	}

	/**
	 * Handles reaction addition. Delegates to extracted module.
	 */
	public async handleReactionAdd(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		await this.handleReactionAddForAccount(
			this.defaultAccountId,
			reaction,
			user,
		);
	}

	private async handleReactionAddForAccount(
		accountId: string,
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await handleReactionAddExtracted(
			this.createAccountServiceFacade(state),
			reaction,
			user,
		);
	}

	/**
	 * Handles reaction removal. Delegates to extracted module.
	 */
	public async handleReactionRemove(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		await this.handleReactionRemoveForAccount(
			this.defaultAccountId,
			reaction,
			user,
		);
	}

	private async handleReactionRemoveForAccount(
		accountId: string,
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await handleReactionRemoveExtracted(
			this.createAccountServiceFacade(state),
			reaction,
			user,
		);
	}

	/**
	 * Handles guild creation (bot joined a guild). Delegates to extracted module.
	 */
	public async handleGuildCreate(guild: Guild): Promise<void> {
		await this.handleGuildCreateForAccount(this.defaultAccountId, guild);
	}

	private async handleGuildCreateForAccount(
		accountId: string,
		guild: Guild,
	): Promise<void> {
		await handleGuildCreateExtracted(
			this.createAccountServiceFacade(this.getAccountState(accountId)),
			guild,
		);
	}

	/**
	 * Handles interaction creation (slash commands, modals, etc). Delegates to
	 * extracted module.
	 */
	public async handleInteractionCreate(
		interaction: Interaction,
	): Promise<void> {
		await this.handleInteractionCreateForAccount(
			this.defaultAccountId,
			interaction,
		);
	}

	private async handleInteractionCreateForAccount(
		accountId: string,
		interaction: Interaction,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await handleInteractionCreateExtracted(
			this.createAccountServiceFacade(state),
			interaction,
		);
	}

	/**
	 * Handles a new guild member joining — emits an ENTITY_JOINED event so the
	 * runtime can create the entity record.
	 */
	public async handleGuildMemberAdd(member: GuildMember): Promise<void> {
		await this.handleGuildMemberAddForAccount(this.defaultAccountId, member);
	}

	private async handleGuildMemberAddForAccount(
		accountId: string,
		member: GuildMember,
	): Promise<void> {
		this.runtime.logger.info(
			`New member joined: ${member.user.username} (${member.id})`,
		);

		const guild = member.guild;
		const tag = member.user.bot
			? `${member.user.username}#${member.user.discriminator}`
			: member.user.username;

		const worldId = createUniqueUuid(this.runtime, guild.id);
		const entityId = this.resolveDiscordEntityId(member.id);

		this.runtime.emitEvent(
			[DiscordEventTypes.ENTITY_JOINED] as string[],
			{
				runtime: this.runtime,
				entityId,
				worldId,
				source: "discord",
				metadata: {
					accountId,
					type: member.user.bot ? "bot" : "user",
					originalId: member.id,
					username: tag,
					displayName: member.displayName || member.user.username,
					roles: member.roles.cache.map((r) => r.name),
					joinedAt: member.joinedAt?.getTime
						? member.joinedAt.getTime()
						: undefined,
				},
				member,
			} as EventPayload,
		);
	}

	/**
	 * Registers an in-flight `MessageManager#handleMessage` turn so `stop()`
	 * can drain it (bounded) instead of destroying the client mid-turn. See
	 * shutdown-drain.ts.
	 */
	public trackInFlightTurn(messageId: string, promise: Promise<unknown>): void {
		this.turnDrainRegistry.trackTurn(messageId, promise);
	}

	/**
	 * Attaches the status-reaction controller for a tracked turn so a drain
	 * timeout can reconcile it instead of leaving it on its last emoji. See
	 * shutdown-drain.ts.
	 */
	public trackStatusReaction(
		messageId: string,
		controller: StatusReactionController,
	): void {
		this.turnDrainRegistry.trackStatusReaction(messageId, controller);
	}

	/**
	 * Admission gate for Discord gateway messages. The check is synchronous so
	 * a delivery either owns admission before shutdown begins or is observably
	 * rejected; there is no await boundary where it can slip behind the drain.
	 */
	public admitInboundMessage(
		messageId: string,
		channelId: string,
		accountId = this.accountId,
	): boolean {
		if (this.ingressClosedReason === null) {
			return true;
		}
		const context = {
			src: "plugin:discord",
			agentId: this.runtime.agentId,
			accountId,
			messageId,
			channelId,
			reason: this.ingressClosedReason,
		};
		logInboundDrop({
			log: (message) => this.runtime.logger.info(context, message),
			channel: "discord",
			reason: this.ingressClosedReason,
			target: channelId,
		});
		return false;
	}

	/** Close inbound admissions exactly once while allowing admitted turns to drain. */
	public cordonIngress(reason = "shutdown-cordon"): void {
		this.ingressClosedReason ??= reason;
	}

	/** Runtime-level pre-drain hook; intentionally synchronous. */
	public override prepareStop(_reason: string): void {
		this.cordonIngress();
	}

	/**
	 * Stops the Discord service and cleans up resources.
	 */
	public async stop(): Promise<void> {
		this.runtime.logger.info("Stopping Discord service");
		// Cordon before the first await and before taking the drain snapshot. New
		// gateway deliveries are rejected by the messageCreate gate below, while
		// turns admitted before this point remain tracked and may finish normally.
		this.cordonIngress();

		// Drain before any teardown below: in-flight turns depend on the
		// debouncers, message managers, and client this method is about to
		// destroy. Bounded by DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS — no unbounded
		// wait, since a hang here would block process shutdown indefinitely.
		const {
			observedCount,
			timedOut,
			unfinishedMessageIds,
			abandonedMessageIds,
		} = await this.turnDrainRegistry.drain(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS);
		// Branch on `timedOut`, never on the abandoned-reaction count. Status
		// reactions are scope-gated — `none`, and un-addressed guild messages
		// under `group-mentions`, produce no controller at all — so on a typical
		// server most turns can hang through the whole bound while contributing
		// nothing to `abandonedMessageIds`. Reporting the success line for those
		// announced a clean drain for a shutdown that dropped work (#17749
		// review, @lalalune).
		if (timedOut) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					observedInFlightTurns: observedCount,
					unfinishedMessageIds,
					abandonedMessageIds,
					drainTimeoutMs: DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS,
				},
				`[DiscordService] Shutdown drain timeout elapsed after ${DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS}ms — ${unfinishedMessageIds.length} of ${observedCount} in-flight turn(s) still running and abandoned, ${abandonedMessageIds.length} status reaction(s) reconciled`,
			);
		} else if (observedCount > 0) {
			this.runtime.logger.info(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					drainedCount: observedCount,
				},
				`[DiscordService] Drained ${observedCount} in-flight turn(s) before shutdown`,
			);
		}

		this.timeouts.forEach(clearTimeout);
		this.timeouts = [];

		const states = this.accountPool.list();
		for (const state of states) {
			state.loginStopRequested = true;
			if (state.loginRetryTimer) {
				clearTimeout(state.loginRetryTimer);
				state.loginRetryTimer = undefined;
			}
			const rejectLoginReady = state.loginReadyReject;
			state.loginReadyReject = undefined;
			rejectLoginReady?.(this.createLoginStoppedError(state));
		}
		for (const state of states) {
			state.channelDebouncer?.destroy();
			state.channelDebouncer = undefined;
		}
		this.channelDebouncer = undefined;

		for (const state of states) {
			try {
				state.voiceManager?.stop();
				state.messageManager?.destroy();
				this.voiceTargets.unregisterAccount(state.accountId);
			} catch (error) {
				this.runtime.logger.warn(
					`Discord voice cleanup failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		for (const state of states) {
			const client = state.client;
			if (!client) {
				continue;
			}
			try {
				await client.destroy();
				this.runtime.logger.info(
					`Discord client destroyed for account ${state.accountId}`,
				);
			} catch (error) {
				this.runtime.logger.warn(
					`Discord client destroy failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			} finally {
				state.client = null;
			}
		}

		for (const sink of this.audioSinks.values()) {
			sink.destroy();
		}
		this.audioSinks.clear();
		this.voiceTargets.clear();

		this.accountPool.clear();
		this.clientReadyPromise = null;
		this.messageManager = undefined;
		this.voiceManager = undefined;
		this.client = null;
		this.runtime.logger.info("Discord service stopped");
	}

	/**
	 * Asynchronously retrieves the type of a given channel.
	 */
	async getChannelType(channel: Channel): Promise<ChannelType> {
		switch (channel.type) {
			case DiscordChannelType.DM:
				return ChannelType.DM;

			case DiscordChannelType.GroupDM:
				return ChannelType.GROUP;

			case DiscordChannelType.GuildText:
			case DiscordChannelType.GuildNews:
			case DiscordChannelType.PublicThread:
			case DiscordChannelType.PrivateThread:
			case DiscordChannelType.AnnouncementThread:
			case DiscordChannelType.GuildForum:
				return ChannelType.GROUP;

			case DiscordChannelType.GuildVoice:
			case DiscordChannelType.GuildStageVoice:
				return ChannelType.VOICE_GROUP;

			default:
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelType: channel.type,
					},
					"Unknown channel type, defaulting to GROUP",
				);
				return ChannelType.GROUP;
		}
	}
}
