/**
 * MESSAGE — single polymorphic action surface for the messaging domain, and the
 * only messaging action the runtime registers (there are no per-op leaf
 * actions).
 *
 * Dispatches on a switch over MESSAGE_OPS. Connector-backed ops (read_channel,
 * search, list_channels, list_servers, react, edit, delete, pin, join, leave,
 * get_user) call MessageConnector hooks directly. read_with_contact resolves a
 * person via the relationships graph and views their conversations across every
 * connected platform. list_worlds/list_rooms use the durable runtime topology,
 * verified identity clusters, and owner-private disclosure revalidation. Triage /
 * inbox / draft ops delegate to the triage actions in features/messaging/triage.
 */

import { searchCanonicalConversationMemories } from "../../../access-control/provenance-envelope.ts";
import { getConnectorAccountManager } from "../../../connectors/account-manager.ts";
import { createUniqueUuid, findEntityByName } from "../../../entities.ts";
import { ElizaError } from "../../../errors.ts";
import { getActionSpec } from "../../../generated/spec-helpers.ts";
import { getVerifiedRelatedEntityIds } from "../../../identity-clusters.ts";
import { logger } from "../../../logger.ts";
import { authorizeManageServerDestination } from "../../../messaging/manage-server-authorization.ts";
import {
	deterministicOwnerEntityId,
	resolveCanonicalOwnerIdForMessage,
} from "../../../roles.ts";
import { runWithActionRoutingContext } from "../../../runtime/action-routing-context.ts";
import {
	markOwnerExclusiveDisclosureUsed,
	OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
	revalidateOwnerExclusiveDisclosure,
} from "../../../security/trusted-delivery-audience.ts";
import {
	resolveMutedTargetFlags,
	resolveMutedWorldFlags,
} from "../../../services/message/mute-state.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionResult,
	Content,
	HandlerOptions,
	IAgentRuntime,
	IdentityDeliveryClaimResolution,
	Media,
	Memory,
	MessageConnector,
	MessageConnectorManageServerAuthorization,
	MessageConnectorManageServerDestination,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	MessageTargetKind,
	PrincipalService,
	Room,
	SearchCategoryRegistration,
	State,
	TargetInfo,
	UUID,
	World,
} from "../../../types/index.ts";
import {
	buildContentReference,
	buildReadSlice,
	CANONICAL_MESSAGE_TARGET_KINDS,
	ChannelType,
	IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE_SETTING,
	identityDeliveryClaimsAuthoritative,
	inspectSendHandlerResult,
	ModelType,
	ServiceType,
} from "../../../types/index.ts";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "../../../types/message-source.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import { requireConfirmation } from "../../../utils/confirmation.ts";
import { getActiveRoutingContextsForTurn } from "../../../utils/context-routing.ts";
import { createHash } from "../../../utils/crypto-compat.ts";
import { isObjectRecord as isRecord } from "../../../utils/type-guards.ts";
import { toWellFormedUnicode } from "../../../utils/well-formed.ts";
import { stringToUuid } from "../../../utils.ts";
import { draftFollowupAction } from "../../messaging/triage/actions/draftFollowup.ts";
import { draftReplyAction } from "../../messaging/triage/actions/draftReply.ts";
import { listInboxAction } from "../../messaging/triage/actions/listInbox.ts";
import { manageMessageAction } from "../../messaging/triage/actions/manageMessage.ts";
import { respondToMessageAction } from "../../messaging/triage/actions/respondToMessage.ts";
import { scheduleDraftSendAction } from "../../messaging/triage/actions/scheduleDraftSend.ts";
import { searchMessagesAction as searchInboxMessagesAction } from "../../messaging/triage/actions/searchMessages.ts";
import { sendDraftAction } from "../../messaging/triage/actions/sendDraft.ts";
import { triageMessagesAction } from "../../messaging/triage/actions/triageMessages.ts";
import { getDefaultTriageService } from "../../messaging/triage/triage-service.ts";
import {
	ALL_MESSAGE_SOURCES,
	MANAGE_OPERATION_KINDS,
	type MessageSource,
} from "../../messaging/triage/types.ts";
import {
	refreshMessageConnectorActionDescription,
	trustedConnectorAccountId,
	trustedConnectorSource,
} from "./connectorActionUtils.ts";

// ---------------------------------------------------------------------------
// Op taxonomy
// ---------------------------------------------------------------------------

export const MESSAGE_OPS = [
	"send",
	"read_channel",
	"read_with_contact",
	"read_message",
	"search",
	"list_channels",
	"list_servers",
	"list_connections",
	"list_worlds",
	"list_rooms",
	"join",
	"leave",
	"react",
	"edit",
	"delete",
	"pin",
	"get_user",
	"manage_server",
	// Inbox / triage / draft ops (delegated to triage actions)
	"triage",
	"list_inbox",
	"search_inbox",
	"draft_reply",
	"draft_followup",
	"respond",
	"send_draft",
	"schedule_draft_send",
	"manage",
] as const;

export type MessageOperation = (typeof MESSAGE_OPS)[number];

const MESSAGE_CONTEXTS = [
	"messaging",
	"email",
	"contacts",
	"connectors",
	"world",
];

const MESSAGE_DESCRIPTION =
	"Addressed messaging action: DMs, groups, channels, rooms, threads, servers, users, inboxes, drafts, and authorized cross-world continuity. Use list_worlds to discover durable worlds shared by the verified requester and this agent, list_rooms to inspect the current or an authorized worldId, and read_message to page an exact provider message or email body. Use manage_server for structural server administration on a connector that supports it (create/edit/delete channels, categories, and roles, permission overwrites, member roles, invites, moderation, guild templates) — gated by connector configuration. Public feed publishing uses POST.";
const MESSAGE_COMPRESSED =
	"primary message action send read_channel read_with_contact read_message search list_channels list_servers list_connections list_worlds list_rooms join leave react edit delete pin get_user manage_server triage list_inbox search_inbox draft_reply draft_followup respond send_draft schedule_draft_send manage dm group channel room thread user server world inbox draft connections platforms reachable";

// ---------------------------------------------------------------------------
// Param coercion / op normalization
// ---------------------------------------------------------------------------

type ParamRecord = Record<string, unknown>;

function paramsFromOptions(options: HandlerOptions | undefined): ParamRecord {
	return (options?.parameters ?? {}) as ParamRecord;
}

function textParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function boolParam(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "yes", "1", "on"].includes(normalized)) return true;
	if (["false", "no", "0", "off"].includes(normalized)) return false;
	return undefined;
}

function numberParam(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function requestedLimit(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(1, Math.floor(value));
}

/**
 * A "recent" read (the default range) with no limit is a page of the most
 * recent messages, not the whole channel: with no limit the Discord connector
 * paged through the entire history and ran every historical attachment
 * through the vision and transcription models (live 2026-09-15, "read the
 * last 3 messages in #general": a 5-minute turn, dozens of provider calls).
 * A dated range or an explicit limit is honored as requested.
 */
export const DEFAULT_RECENT_READ_LIMIT = 20;

export function recentReadLimit(
	range: string | undefined,
	limit: number | undefined,
): number | undefined {
	if (limit !== undefined) return limit;
	return range === "dates" ? undefined : DEFAULT_RECENT_READ_LIMIT;
}

function normalizeComparable(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/^[@#]+/, "")
		.replace(/\s+/g, " ");
}

function isUuidLike(value: string | undefined): value is UUID {
	return Boolean(
		value &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				value,
			),
	);
}

function stripTargetPrefix(value: string): string {
	return value
		.trim()
		.replace(/^[@#]+/, "")
		.trim();
}

const OP_ALIASES: Record<string, MessageOperation> = {
	send_message: "send",
	dm: "send",
	read_messages: "read_channel",
	read: "read_channel",
	read_room: "read_channel",
	read_chat: "read_channel",
	read_with_contact: "read_with_contact",
	read_message: "read_message",
	read_email: "read_message",
	read_email_body: "read_message",
	read_dms: "read_with_contact",
	conversation_with: "read_with_contact",
	chat_with: "read_with_contact",
	find: "search",
	search_messages: "search",
	search_chats: "search",
	search_conversations: "search",
	cross_channel_search: "search",
	list_rooms: "list_channels",
	list_chats: "list_channels",
	list_workspaces: "list_servers",
	list_guilds: "list_servers",
	list_platforms: "list_connections",
	list_accounts: "list_connections",
	connected_platforms: "list_connections",
	where_am_i_connected: "list_connections",
	what_am_i_connected_to: "list_connections",
	search_worlds: "list_worlds",
	find_worlds: "list_worlds",
	search_rooms: "list_rooms",
	find_rooms: "list_rooms",
	react_to_message: "react",
	reaction: "react",
	edit_message: "edit",
	update_message: "edit",
	delete_message: "delete",
	remove_message: "delete",
	pin_message: "pin",
	unpin: "pin",
	join_channel: "join",
	join_room: "join",
	leave_channel: "leave",
	leave_room: "leave",
	get_user_info: "get_user",
	lookup_user: "get_user",
	triage_messages: "triage",
	triage_inbox: "triage",
	prioritize_messages: "triage",
	rank_inbox: "triage",
	scan_messages: "triage",
	list_messages: "list_inbox",
	show_unread_across: "list_inbox",
	search_inbox: "search_inbox",
	search_email: "search_inbox",
	compose_reply: "draft_reply",
	draft_message_reply: "draft_reply",
	compose_followup: "draft_followup",
	followup_draft: "draft_followup",
	check_in_draft: "draft_followup",
	dispatch_draft: "send_draft",
	confirm_and_send: "send_draft",
	compose_message: "send_draft",
	outbound_message: "send_draft",
	schedule_send: "schedule_draft_send",
	defer_send: "schedule_draft_send",
	send_later: "schedule_draft_send",
	respond_to_message: "respond",
	reply_to_message: "respond",
	quick_reply: "respond",
	one_shot_reply: "respond",
	manage_message: "manage",
	archive_message: "manage",
	tag_message: "manage",
	unsubscribe: "manage",
	block_sender: "manage",
	mark_read: "manage",
	// Structural server management verbs route to manage_server; the concrete
	// verb is preserved via params.operation (or the raw action string).
	manage_guild: "manage_server",
	server_management: "manage_server",
	guild_management: "manage_server",
	create_channel: "manage_server",
	create_category: "manage_server",
	edit_channel: "manage_server",
	delete_channel: "manage_server",
	create_role: "manage_server",
	edit_role: "manage_server",
	delete_role: "manage_server",
	edit_permissions: "manage_server",
	edit_channel_permissions: "manage_server",
	assign_role: "manage_server",
	remove_role: "manage_server",
	create_invite: "manage_server",
	kick_member: "manage_server",
	ban_member: "manage_server",
	unban_member: "manage_server",
	timeout_member: "manage_server",
	apply_template: "manage_server",
	apply_server_template: "manage_server",
	list_templates: "manage_server",
	list_server_templates: "manage_server",
};

function normalizeOp(value: unknown): MessageOperation | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, "_");
	if ((MESSAGE_OPS as readonly string[]).includes(normalized)) {
		return normalized as MessageOperation;
	}
	return OP_ALIASES[normalized];
}

export function inferOp(params: ParamRecord): MessageOperation {
	const explicit = normalizeOp(params.action);
	if (explicit) return explicit;

	// #10471: no English natural-language keyword inference. The planner emits
	// `action` (MESSAGE_OPS enum) directly for any language; here we only honor
	// STRUCTURED params, then default to the safe primary op (send). A wrong
	// `send` default is recoverable, unlike e.g. delete/leave, so deferring an
	// unspecified op to send is the conservative choice. Ops without a
	// structured signal (edit/delete/pin/join/leave/triage/draft_*/list_*/
	// read_channel/get_user/respond/read_with_contact/search_inbox/list_inbox)
	// are reached via the `action` enum the planner selects explicitly.
	if (params.draftId && params.sendAt) return "schedule_draft_send";
	if (params.draftId) return "send_draft";
	if (params.manageOperation) return "manage";
	if (params.query) return "search";
	if (params.emoji) return "react";
	return "send";
}

// ---------------------------------------------------------------------------
// MessageConnector access (in-process — no HTTP)
// ---------------------------------------------------------------------------

type RuntimeWithLegacySendHandlers = IAgentRuntime & {
	sendHandlers?: Map<string, unknown>;
	getMessageConnectors?: () => MessageConnector[];
};

type ConnectorWithHooks = MessageConnector & {
	fetchMessages?: (
		context: MessageConnectorQueryContext,
		opts: {
			target: TargetInfo;
			limit?: number;
			cursor?: string;
			before?: string;
			after?: string;
		},
	) => Promise<Memory[]> | Memory[];
	searchMessages?: (
		context: MessageConnectorQueryContext,
		opts: {
			query: string;
			target?: TargetInfo;
			limit?: number;
			cursor?: string;
			before?: string;
			after?: string;
		},
	) => Promise<Memory[]> | Memory[];
	listServers?: (
		context: MessageConnectorQueryContext,
	) =>
		| Promise<Array<{ id?: string; name?: string }>>
		| Array<{ id?: string; name?: string }>;
	joinHandler?: (
		runtime: IAgentRuntime,
		payload: {
			roomId?: UUID;
			channelId?: string;
			serverId?: string;
			alias?: string;
			invite?: string;
			target?: TargetInfo;
		},
	) =>
		| Promise<{ id?: UUID } | null | undefined>
		| { id?: UUID }
		| null
		| undefined;
	leaveHandler?: (
		runtime: IAgentRuntime,
		payload: {
			roomId?: UUID;
			channelId?: string;
			serverId?: string;
			alias?: string;
			target?: TargetInfo;
		},
	) => Promise<void> | void;
	reactHandler?: (
		runtime: IAgentRuntime,
		payload: { target: TargetInfo; messageId: string; emoji: string },
	) => Promise<void> | void;
	editHandler?: (
		runtime: IAgentRuntime,
		payload: {
			target: TargetInfo;
			messageId: string;
			content: Content;
		},
	) =>
		| Promise<Memory | { id?: UUID } | undefined>
		| Memory
		| { id?: UUID }
		| undefined;
	deleteHandler?: (
		runtime: IAgentRuntime,
		payload: { target: TargetInfo; messageId: string },
	) => Promise<void> | void;
	pinHandler?: (
		runtime: IAgentRuntime,
		payload: { target: TargetInfo; messageId: string; pin: boolean },
	) => Promise<void> | void;
	getUser?: (
		runtime: IAgentRuntime,
		query: { userId?: string; username?: string; handle?: string },
	) => Promise<unknown> | unknown;
	resolveManageServerDestination?: (
		runtime: IAgentRuntime,
		params: { target?: TargetInfo; serverId: string },
	) =>
		| Promise<MessageConnectorManageServerDestination>
		| MessageConnectorManageServerDestination;
	manageServerHandler?: (
		runtime: IAgentRuntime,
		payload: {
			target?: TargetInfo;
			operation: string;
			serverId?: string;
			authorization: MessageConnectorManageServerAuthorization;
			params?: Record<string, unknown>;
		},
	) =>
		| Promise<{ summary: string; data?: Record<string, unknown> }>
		| { summary: string; data?: Record<string, unknown> };
	contentShaping?: {
		postProcess?: (text: string) => string;
		constraints?: { maxLength?: number };
	};
};

function listMessageConnectors(runtime: IAgentRuntime): ConnectorWithHooks[] {
	const rt = runtime as RuntimeWithLegacySendHandlers;
	if (typeof rt.getMessageConnectors === "function") {
		return rt.getMessageConnectors() as ConnectorWithHooks[];
	}
	const sendHandlers = rt.sendHandlers;
	if (!(sendHandlers instanceof Map)) return [];
	return Array.from(sendHandlers.keys())
		.sort((a, b) => a.localeCompare(b))
		.map(
			(source): ConnectorWithHooks => ({
				source,
				label: source
					.replace(/[_-]+/g, " ")
					.replace(/\b\w/g, (c) => c.toUpperCase()),
				capabilities: ["send_message"],
				supportedTargetKinds: [],
				contexts: [],
			}),
		);
}

function connectorAliases(connector: MessageConnector): string[] {
	const aliases: string[] = [connector.source, connector.label];
	if (connector.accountId) aliases.push(connector.accountId);
	if (connector.account?.accountId) aliases.push(connector.account.accountId);
	if (connector.account?.label) aliases.push(connector.account.label);
	if (connector.account?.name) aliases.push(connector.account.name);
	const metadataAliases = (
		connector.metadata as { aliases?: unknown } | undefined
	)?.aliases;
	if (Array.isArray(metadataAliases)) {
		for (const alias of metadataAliases) {
			if (typeof alias === "string" && alias.trim().length > 0)
				aliases.push(alias);
		}
	}
	return aliases;
}

function connectorAccountIds(connector: MessageConnector): string[] {
	return [connector.accountId, connector.account?.accountId].filter(
		(accountId): accountId is string => Boolean(accountId?.trim()),
	);
}

function selectAccountConnectors(
	connectors: ConnectorWithHooks[],
	accountId: string | undefined,
): ConnectorWithHooks[] {
	if (!accountId) return connectors;
	const normalized = normalizeComparable(accountId);
	const exact = connectors.filter((connector) =>
		connectorAccountIds(connector).some(
			(candidate) => normalizeComparable(candidate) === normalized,
		),
	);
	if (exact.length > 0) return exact;
	return connectors.filter(
		(connector) =>
			connectorAccountIds(connector).length === 0 &&
			connector.accountRouting === "connector",
	);
}

function findConnectorBySource(
	connectors: ConnectorWithHooks[],
	source: string | undefined,
): ConnectorWithHooks | undefined {
	if (!source) return undefined;
	const normalized = normalizeComparable(source);
	return connectors.find((connector) =>
		connectorAliases(connector).some(
			(alias) => normalizeComparable(alias) === normalized,
		),
	);
}

function connectorsWithHook<K extends keyof ConnectorWithHooks>(
	runtime: IAgentRuntime,
	hook: K,
): ConnectorWithHooks[] {
	return listMessageConnectors(runtime).filter(
		(connector) => typeof connector[hook] === "function",
	);
}

function buildQueryContext(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	source: string | undefined,
	target?: TargetInfo,
	connector?: ConnectorWithHooks,
	accountId?: string,
): MessageConnectorQueryContext {
	const trustedSource = trustedConnectorSource(message);
	const envelopeAccountId =
		trustedSource &&
		source &&
		normalizeComparable(trustedSource) === normalizeComparable(source)
			? trustedConnectorAccountId(message)
			: undefined;
	const routedAccountId =
		target?.accountId ?? connector?.accountId ?? accountId ?? envelopeAccountId;
	return {
		runtime,
		roomId: message.roomId,
		entityId: message.entityId,
		source,
		accountId: routedAccountId,
		account: connector?.account,
		target,
		contexts: getActiveRoutingContextsForTurn(state, message),
		metadata: { messageText: message.content.text },
	};
}

/**
 * A connector service registers a legacy source-level route beside one route
 * per account (plugin-discord service.ts: registerConnector(undefined) then
 * registerConnector(accountId)). With a single account that is two connectors
 * aliasing "discord", and a turn that names no account — the owner API room
 * carries no connector envelope — has nothing to disambiguate (live
 * 2026-09-14: "read the last 3 messages in #general" failed as
 * SOURCE_AMBIGUOUS, then fell back to the local room table once the
 * connector count was not 1). Only distinct sources or accounts are
 * ambiguous; the account-scoped route stands for the family.
 */
export function soleConnectorFamily(
	connectors: readonly ConnectorWithHooks[],
): ConnectorWithHooks | undefined {
	if (connectors.length === 0) return undefined;
	if (connectors.length === 1) return connectors[0];
	const sources = new Set(
		connectors.map((connector) => normalizeComparable(connector.source)),
	);
	const accountIds = new Set(
		connectors.flatMap((connector) =>
			connectorAccountIds(connector).map(normalizeComparable),
		),
	);
	if (sources.size !== 1 || accountIds.size > 1) return undefined;
	return (
		connectors.find((connector) => connectorAccountIds(connector).length > 0) ??
		connectors[0]
	);
}

// Exported for unit-test coverage of the account-resolution rules; not part
// of the public runtime surface.
export function selectConnectorForOp(
	connectors: ConnectorWithHooks[],
	source: string | undefined,
	currentSource: string | undefined,
	op: MessageOperation,
	accountId?: string,
): { connector: ConnectorWithHooks } | { error: ActionResult } {
	if (connectors.length === 0) {
		return {
			error: opFailure(
				op,
				"NO_CONNECTORS_REGISTERED",
				`MESSAGE op=${op} has no registered connectors.`,
			),
		};
	}
	const sourceMatches = source
		? connectors.filter((connector) =>
				connectorAliases(connector).some(
					(alias) => normalizeComparable(alias) === normalizeComparable(source),
				),
			)
		: [];
	const explicitMatches = selectAccountConnectors(sourceMatches, accountId);
	const sole = soleConnectorFamily(explicitMatches);
	const resolvedMatches = sole ? [sole] : explicitMatches;
	if (source && resolvedMatches.length > 1) {
		return {
			error: opFailure(
				op,
				"SOURCE_AMBIGUOUS",
				`MESSAGE op=${op} needs a connector account for "${source}".`,
			),
		};
	}
	const explicit = resolvedMatches[0];
	const sourceExists = sourceMatches.length > 0;
	if (source && !explicit) {
		return {
			error: opFailure(
				op,
				sourceExists
					? "ACCOUNT_CONNECTOR_NOT_FOUND"
					: "SOURCE_CONNECTOR_NOT_FOUND",
				sourceExists
					? `No message connector for account "${accountId}" on source "${source}".`
					: `No message connector for source "${source}". Available: ${connectors.map((c) => c.source).join(", ")}.`,
			),
		};
	}
	if (explicit) return { connector: explicit };
	const fallbackMatches = currentSource
		? selectAccountConnectors(
				connectors.filter((connector) =>
					findConnectorBySource([connector], currentSource),
				),
				accountId,
			)
		: [];
	const fallback =
		fallbackMatches.length === 1 ? fallbackMatches[0] : undefined;
	if (fallback) return { connector: fallback };
	const accountScoped = selectAccountConnectors(connectors, accountId);
	if (accountId && accountScoped.length === 1) {
		const sole = accountScoped[0];
		if (sole) return { connector: sole };
	}
	if (accountId && accountScoped.length === 0) {
		return {
			error: opFailure(
				op,
				"ACCOUNT_CONNECTOR_NOT_FOUND",
				`MESSAGE op=${op} has no connector for account "${accountId}".`,
			),
		};
	}
	if (accountScoped.length > 1) {
		return {
			error: opFailure(
				op,
				"SOURCE_AMBIGUOUS",
				`MESSAGE op=${op} needs a source/account. Choose one of: ${accountScoped
					.map((c) => (c.accountId ? `${c.source}:${c.accountId}` : c.source))
					.join(", ")}.`,
			),
		};
	}
	const fallbackConnector = accountScoped[0];
	if (!fallbackConnector) {
		return {
			error: opFailure(
				op,
				"NO_CONNECTORS_REGISTERED",
				`MESSAGE op=${op} could not resolve a connector.`,
			),
		};
	}
	return { connector: fallbackConnector };
}

// ---------------------------------------------------------------------------
// Target resolution helpers
// ---------------------------------------------------------------------------

function explicitTargetFromParams(
	source: string,
	params: ParamRecord,
): { target?: TargetInfo; query?: string } {
	const targetText =
		textParam(params.target) ??
		textParam(params.channel) ??
		textParam(params.channelName) ??
		textParam(params.room) ??
		textParam(params.user) ??
		textParam(params.username) ??
		textParam(params.handle);
	const roomId = textParam(params.roomId);
	const channelId =
		textParam(params.channelId) ??
		textParam(params.channel) ??
		(!roomId && targetText && !isUuidLike(targetText) ? targetText : undefined);
	const entityId =
		textParam(params.entityId) ??
		textParam(params.userId) ??
		(targetText && isUuidLike(targetText) ? targetText : undefined);
	const serverId = textParam(params.serverId) ?? textParam(params.server);
	const threadId = textParam(params.threadId) ?? textParam(params.thread);

	if (
		!targetText &&
		!roomId &&
		!channelId &&
		!entityId &&
		!serverId &&
		!threadId
	) {
		return {};
	}
	return {
		query: targetText,
		target: {
			source,
			roomId: roomId as UUID | undefined,
			channelId,
			serverId,
			entityId: entityId as UUID | undefined,
			threadId,
		},
	};
}

function targetLabel(target: TargetInfo): string {
	return (
		target.channelId ??
		target.roomId ??
		target.entityId ??
		target.threadId ??
		target.serverId ??
		target.source
	);
}

async function resolveOptionalTarget(
	connector: ConnectorWithHooks,
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
	op: MessageOperation,
): Promise<{ target?: TargetInfo; error?: ActionResult }> {
	const accountId = accountIdFromParams(params, message);
	const explicit = explicitTargetFromParams(connector.source, params);
	if (explicit.target)
		explicit.target.accountId ??= connector.accountId ?? accountId;
	const context = buildQueryContext(
		runtime,
		message,
		state,
		connector.source,
		explicit.target,
		connector,
		accountId,
	);

	if (explicit.query && connector.resolveTargets) {
		try {
			const matches = await connector.resolveTargets(explicit.query, context);
			if (matches.length === 1) {
				const sole = matches[0];
				if (!sole) {
					return {
						error: opFailure(
							op,
							"TARGET_RESOLVE_FAILED",
							"Target resolution returned an empty match.",
						),
					};
				}
				const target = {
					...sole.target,
					accountId: sole.target.accountId ?? connector.accountId ?? accountId,
				};
				return { target };
			}
			if (matches.length > 1) {
				const sorted = [...matches].sort(
					(a, b) => (b.score ?? 0) - (a.score ?? 0),
				);
				const [top, second] = sorted;
				if (top && second && (top.score ?? 0) > (second.score ?? 0) + 0.12) {
					return {
						target: {
							...top.target,
							accountId:
								top.target.accountId ?? connector.accountId ?? accountId,
						},
					};
				}
				return {
					error: opFailure(
						op,
						"TARGET_AMBIGUOUS",
						`Target ambiguous for ${connector.label}. Choose one of:\n` +
							sorted
								.map(
									(t, i) =>
										`${i + 1}. ${t.label ?? targetLabel(t.target)} (${t.kind ?? "target"})`,
								)
								.join("\n"),
					),
				};
			}
		} catch (error) {
			// error-policy:J1 Target resolution is an action boundary; return an
			// explicit failure instead of sending to the unresolved query.
			logger.warn(
				`[MESSAGE/${op}] resolveTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
			runtime.reportError("MESSAGE.resolveOptionalTarget", error, {
				op,
				source: connector.source,
			});
			return {
				error: opErrorWrap(op, error),
			};
		}
	}
	return { target: explicit.target };
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function opFailure(
	op: MessageOperation,
	code: string,
	text: string,
	extra?: Record<string, unknown>,
): ActionResult {
	return {
		success: false,
		text,
		values: { success: false, error: code },
		data: {
			actionName: "MESSAGE",
			operation: op,
			error: code,
			...(extra ?? {}),
		},
	};
}

function opSuccess(
	op: MessageOperation,
	text: string,
	data: Record<string, unknown>,
): ActionResult {
	return {
		success: true,
		text,
		values: { success: true },
		data: { actionName: "MESSAGE", operation: op, ...data },
	};
}

function invalidOpResult(op: MessageOperation, text: string): ActionResult {
	return opFailure(op, "MESSAGE_INVALID", text);
}

function opErrorWrap(op: MessageOperation, error: unknown): ActionResult {
	const text = error instanceof Error ? error.message : String(error);
	logger.error(`[MESSAGE/${op}] ${text}`);
	return opFailure(
		op,
		`MESSAGE_${op.toUpperCase()}_FAILED`,
		`MESSAGE op=${op} failed: ${text}`,
	);
}

// ---------------------------------------------------------------------------
// op=send
// ---------------------------------------------------------------------------

const ADMIN_TARGETS = new Set(["admin", "owner"]);
const VALID_URGENCIES = new Set(["normal", "important", "urgent"]);
const AMBIGUITY_DELTA = 0.12;
const AMBIGUITY_SCORE = 0.68;

/** Entity component recording the connector a message to this person last
 * successfully went out on. Written by handleSend after confirmed delivery and
 * read back by collectEntityCandidates as a scoring bonus, so a bare
 * "tell shadow …" prefers the channel shadow was actually last reached on
 * instead of guessing between platforms. */
const DELIVERY_PREFERENCE_COMPONENT_TYPE = "message_delivery_preference";

/** Last-channel preference bonus. Must exceed AMBIGUITY_DELTA: two connectors
 * that both hold stored handles for the same entity tie at the same base
 * score, and a bonus inside the ambiguity window would still trip the
 * multiple-plausible-targets brake instead of expressing the preference. It
 * stays a bonus, not an override — an explicit source/targetKind scopes the
 * candidate set before this is ever applied. */
const LAST_CHANNEL_BONUS = 0.15;

/** Email literal: an address-routed target that needs no contact resolution. */
const EMAIL_LITERAL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type SourceResolution = "exact" | "inferred" | "defaulted";

type NormalizedSendParams = {
	target?: string;
	source?: string;
	accountId?: string;
	sourceResolution: SourceResolution;
	targetKind?: MessageTargetKind;
	message: string;
	subject?: string;
	thread?: string;
	attachments?: Media[];
	urgency: string;
};

type SendCandidate = {
	connector: ConnectorWithHooks;
	target: TargetInfo;
	label: string;
	kind?: MessageTargetKind;
	description?: string;
	score: number;
	reasons: string[];
	/** True when the candidate's label/handle matches the query exactly (not a
	 * prefix/substring hit). Exact hits form a higher confidence tier: they win
	 * equal-score sorting and are not held ambiguous against partial matches. */
	exact?: boolean;
	/** When the resolved delivery is an in-room utterance aimed at a specific
	 * room participant (the room-first name resolution), the member to address
	 * in the outgoing text. Absent for every other candidate shape. */
	address?: { entityId: UUID; name: string };
	/** Canonical evidence that authorized this person/account delivery target. */
	identityClaim?: {
		claimId: UUID;
		canonicalPrincipalId: UUID;
		connectorAccountId: UUID;
		generation: number;
		deliveryKey: string;
	};
};

type TargetResolution =
	| {
			status: "resolved";
			candidate: SendCandidate;
			sourceResolution: SourceResolution;
	  }
	| {
			status: "ambiguous";
			text: string;
			candidates: SendCandidate[];
			sourceResolution: SourceResolution;
	  }
	| {
			status: "missing_connector" | "missing_target" | "unsupported";
			text: string;
			error: string;
			sourceResolution: SourceResolution;
	  };

function normalizeTargetKind(value: unknown): MessageTargetKind | undefined {
	const text = textParam(value);
	if (!text) return undefined;
	const n = text.toLowerCase();
	if (n === "room") return "room";
	if (n === "channel") return "channel";
	if (n === "thread") return "thread";
	if (n === "user") return "user";
	if (n === "person" || n === "recipient" || n === "contact") return "contact";
	if (n === "group") return "group";
	if (n === "server") return "server";
	if (n === "email") return "email";
	if (n === "sms" || n === "phone") return "phone";
	return n as MessageTargetKind;
}

function kindAliases(kind: MessageTargetKind): Set<string> {
	const n = String(kind).toLowerCase();
	if (n === "room") return new Set(["room", "channel", "group"]);
	if (n === "channel") return new Set(["channel", "room", "group"]);
	if (n === "user") return new Set(["user", "contact"]);
	if (n === "contact") return new Set(["contact", "user"]);
	if (n === "phone") return new Set(["phone", "sms", "contact"]);
	if (n === "email") return new Set(["email", "contact"]);
	return new Set([n]);
}

function kindsCompatible(
	requested: MessageTargetKind | undefined,
	actual: MessageTargetKind | undefined,
): boolean {
	if (!requested || !actual) return true;
	return kindAliases(requested).has(String(actual).toLowerCase());
}

function connectorSupportsKind(
	connector: ConnectorWithHooks,
	kind: MessageTargetKind | undefined,
): boolean {
	if (!kind || connector.supportedTargetKinds.length === 0) return true;
	const aliases = kindAliases(kind);
	return connector.supportedTargetKinds.some((k) =>
		aliases.has(String(k).toLowerCase()),
	);
}

function inferSourceFromTarget(
	target: string | undefined,
	connectors: ConnectorWithHooks[],
): { target?: string; source?: string } {
	if (!target) return {};
	const prefix = splitConnectorPrefix(target);
	if (prefix) {
		const connector = findConnectorBySource(connectors, prefix.source);
		if (connector) return { source: connector.source, target: prefix.target };
	}
	const suffix = splitConnectorSuffix(target);
	if (suffix) {
		const connector = findConnectorBySource(connectors, suffix.source);
		if (connector) return { source: connector.source, target: suffix.target };
	}
	return { target };
}

function isConnectorName(value: string, min: number, max: number): boolean {
	if (value.length < min || value.length > max) return false;
	for (const char of value) {
		if (!/[A-Za-z0-9 _-]/.test(char)) return false;
	}
	return true;
}

function splitConnectorPrefix(
	target: string,
): { source: string; target: string } | null {
	for (let cursor = 1; cursor < target.length && cursor <= 42; cursor += 1) {
		if (target[cursor] !== ":" && target[cursor] !== "/") continue;
		const source = target.slice(0, cursor).trimEnd();
		const remainder = target.slice(cursor + 1).trim();
		if (
			remainder &&
			isConnectorName(source, 2, 41) &&
			/[A-Za-z0-9_-]/.test(source[0])
		) {
			return { source, target: remainder };
		}
	}
	return null;
}

function splitConnectorSuffix(
	target: string,
): { source: string; target: string } | null {
	const lower = target.toLowerCase();
	for (let cursor = 1; cursor < target.length; cursor += 1) {
		if (!/\s/u.test(target[cursor - 1])) continue;
		for (const keyword of ["on", "via", "through"]) {
			if (
				!lower.startsWith(keyword, cursor) ||
				!/(?:\s)/u.test(target[cursor + keyword.length] ?? "")
			)
				continue;
			const left = target.slice(0, cursor).trim();
			const source = target.slice(cursor + keyword.length).trim();
			if (left && isConnectorName(source, 2, 40))
				return { source, target: left };
		}
	}
	return null;
}

function inferSourceFromText(
	text: string | undefined,
	connectors: ConnectorWithHooks[],
): string | undefined {
	if (!text) return undefined;
	for (const connector of connectors) {
		for (const alias of connectorAliases(connector)) {
			const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(
				`\\b(?:on|via|through|using)\\s+${escaped}\\b`,
				"i",
			);
			if (pattern.test(text)) return connector.source;
		}
	}
	return undefined;
}

function inferTargetFromText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const patterns = [
		/(?:send|message|dm|tell)\s+(?:a\s+message\s+to\s+|to\s+)?(["'][^"']+["']|[@#][\w.-]+)/i,
		/(?:post|drop|send)\s+(?:this\s+)?(?:in|to)\s+(["'][^"']+["']|#[\w.-]+)/i,
		/(?:to|for)\s+(["'][^"']+["']|[@#][\w.-]+)/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const raw = match?.[1]?.trim();
		if (raw) return raw.replace(/^["']|["']$/g, "").trim();
	}
	return undefined;
}

function recentTextFromState(state: State | undefined): string {
	const values = state?.values ?? {};
	const chunks = [
		values.recentMessage,
		values.recentMessages,
		values.recentInteractions,
		values.recentMessageInteractions,
	]
		.filter((v): v is string => typeof v === "string")
		.join("\n");
	return chunks;
}

function inferTargetFromRecentConversation(
	state: State | undefined,
): string | undefined {
	const recent = recentTextFromState(state);
	if (!recent) return undefined;
	const matches = Array.from(recent.matchAll(/[@#][\w.-]{2,}/g));
	return matches.at(-1)?.[0]?.trim();
}

function normalizeAttachments(value: unknown): Media[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attachments: Media[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const url = textParam(item.url);
		if (!url) continue;
		attachments.push({ ...item, id: textParam(item.id) ?? url, url } as Media);
	}
	return attachments.length > 0 ? attachments : undefined;
}

function accountIdFromParams(
	raw: ParamRecord,
	message: Memory,
): string | undefined {
	return (
		textParam(raw.accountId) ??
		textParam(raw.connectorAccountId) ??
		trustedConnectorAccountId(message)
	);
}

function sourceFromParams(
	raw: ParamRecord,
	_message: Memory,
): string | undefined {
	return textParam(raw.source) ?? textParam(raw.platform);
}

function normalizeSendParams(
	raw: ParamRecord,
	message: Memory,
	state: State | undefined,
	connectors: ConnectorWithHooks[],
): NormalizedSendParams {
	let target =
		textParam(raw.target) ??
		textParam(raw.recipient) ??
		textParam(message.content.target) ??
		inferTargetFromText(message.content.text) ??
		inferTargetFromRecentConversation(state);
	let source = sourceFromParams(raw, message);
	const accountId = accountIdFromParams(raw, message);
	let sourceResolution: SourceResolution = source ? "exact" : "inferred";

	const fromTarget = inferSourceFromTarget(target, connectors);
	if (!source && fromTarget.source) {
		source = fromTarget.source;
		sourceResolution = "inferred";
	}
	if (fromTarget.target) target = fromTarget.target;

	if (!source) {
		source = inferSourceFromText(message.content.text, connectors);
		if (source) sourceResolution = "inferred";
	}

	const messageText = textParam(raw.message) ?? textParam(raw.text) ?? "";
	const targetKind = normalizeTargetKind(raw.targetKind ?? raw.targetType);

	return {
		target,
		source,
		accountId,
		sourceResolution,
		targetKind,
		message: messageText,
		subject: textParam(raw.subject),
		thread: textParam(raw.thread),
		attachments: normalizeAttachments(raw.attachments),
		urgency: textParam(raw.urgency) ?? "normal",
	};
}

function queryMatchesCandidate(
	query: string | undefined,
	candidate: MessageConnectorTarget,
): boolean {
	if (!query) return true;
	const nq = normalizeComparable(query);
	const stripped = normalizeComparable(stripTargetPrefix(query));
	const haystack = normalizeComparable(
		[
			candidate.label,
			candidate.description,
			candidate.target.channelId,
			candidate.target.roomId,
			candidate.target.entityId,
			candidate.target.threadId,
			candidate.target.serverId,
			...(candidate.metadata
				? Object.values(candidate.metadata).filter(
						(v): v is string => typeof v === "string",
					)
				: []),
		]
			.filter(Boolean)
			.join(" "),
	);
	return (
		haystack.includes(nq) ||
		haystack.includes(stripped) ||
		normalizeComparable(candidate.label) === stripped
	);
}

function scoreHookCandidate(
	raw: MessageConnectorTarget,
	query: string | undefined,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	baseScore: number,
	reasons: string[],
): number {
	let score =
		typeof raw.score === "number" && Number.isFinite(raw.score)
			? raw.score
			: baseScore;
	if (query && queryMatchesCandidate(query, raw)) score += 0.12;
	if (targetKind && kindsCompatible(targetKind, raw.kind)) score += 0.08;
	if (sourceWasExact) score += 0.08;
	if (reasons.includes("resolveTargets")) score += 0.08;
	return Math.max(0, Math.min(1, score));
}

function labelMatchesQuery(
	label: string | undefined,
	query: string | undefined,
): boolean {
	if (!label || !query) return false;
	return (
		normalizeComparable(label) === normalizeComparable(stripTargetPrefix(query))
	);
}

function normalizeHookCandidate(
	connector: ConnectorWithHooks,
	raw: MessageConnectorTarget,
	query: string | undefined,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	baseScore: number,
	reasons: string[],
	accountId?: string,
): SendCandidate | null {
	if (!kindsCompatible(targetKind, raw.kind)) return null;
	if (!queryMatchesCandidate(query, raw)) return null;
	const target = {
		...raw.target,
		source: raw.target.source || connector.source,
		accountId: raw.target.accountId ?? connector.accountId ?? accountId,
	} as TargetInfo;
	const label = raw.label ?? targetLabel(target);
	const exact =
		labelMatchesQuery(label, query) ||
		[raw.target.channelId, raw.target.entityId]
			.filter((value): value is string => typeof value === "string")
			.some((value) => labelMatchesQuery(value, query));
	return {
		connector,
		target,
		label,
		kind: raw.kind ?? targetKind,
		description: raw.description,
		score: scoreHookCandidate(
			raw,
			query,
			targetKind,
			sourceWasExact,
			baseScore,
			reasons,
		),
		reasons,
		exact,
	};
}

async function collectHookTargets(
	runtime: IAgentRuntime,
	connector: ConnectorWithHooks,
	query: string | undefined,
	context: MessageConnectorQueryContext,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	accountId?: string,
): Promise<SendCandidate[]> {
	const candidates: SendCandidate[] = [];
	let firstFailure: unknown;

	if (query && connector.resolveTargets) {
		try {
			const resolved = await connector.resolveTargets(query, context);
			for (const raw of resolved) {
				const candidate = normalizeHookCandidate(
					connector,
					raw,
					query,
					targetKind,
					sourceWasExact,
					0.74,
					["resolveTargets"],
					accountId,
				);
				if (candidate) candidates.push(candidate);
			}
		} catch (error) {
			// error-policy:J4 Other connector discovery hooks may still resolve
			// the target; report this unavailable capability before continuing.
			firstFailure ??= error;
			logger.warn(
				`[MESSAGE/send] resolveTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
			runtime.reportError("MESSAGE.resolveTargets", error, {
				source: connector.source,
			});
		}
	}

	if (connector.listRecentTargets) {
		try {
			const recent = await connector.listRecentTargets(context);
			for (const raw of recent) {
				const candidate = normalizeHookCandidate(
					connector,
					raw,
					query,
					targetKind,
					sourceWasExact,
					query ? 0.52 : 0.62,
					["listRecentTargets"],
					accountId,
				);
				if (candidate) candidates.push(candidate);
			}
		} catch (error) {
			// error-policy:J4 Other connector discovery hooks may still resolve
			// the target; report this unavailable capability before continuing.
			firstFailure ??= error;
			logger.warn(
				`[MESSAGE/send] listRecentTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
			runtime.reportError("MESSAGE.listRecentTargets", error, {
				source: connector.source,
			});
		}
	}

	if (
		connector.listRooms &&
		(query ||
			!targetKind ||
			kindAliases(targetKind).has("room") ||
			kindAliases(targetKind).has("channel"))
	) {
		try {
			const rooms = await connector.listRooms(context);
			for (const raw of rooms) {
				const candidate = normalizeHookCandidate(
					connector,
					raw,
					query,
					targetKind,
					sourceWasExact,
					0.56,
					["listRooms"],
					accountId,
				);
				if (candidate) candidates.push(candidate);
			}
		} catch (error) {
			// error-policy:J4 Other connector discovery hooks may still resolve
			// the target; report this unavailable capability before continuing.
			firstFailure ??= error;
			logger.warn(
				`[MESSAGE/send] listRooms failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
			runtime.reportError("MESSAGE.listRooms", error, {
				source: connector.source,
			});
		}
	}

	if (candidates.length === 0 && firstFailure !== undefined) {
		throw firstFailure;
	}
	return candidates;
}

function explicitSendTarget(
	connector: ConnectorWithHooks,
	rawTarget: string,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	accountId?: string,
): SendCandidate {
	let kind = targetKind;
	let value = rawTarget.trim();
	const fieldMatch = value.match(
		/^(room|channel|server|entity|user|contact|thread|group|email|phone):(.+)$/i,
	);
	if (fieldMatch?.[1] && fieldMatch[2]) {
		kind = normalizeTargetKind(fieldMatch[1]);
		value = fieldMatch[2].trim();
	}
	const target = {
		source: connector.source,
		accountId: connector.accountId ?? accountId,
	} as TargetInfo;
	const stripped = stripTargetPrefix(value);

	if (kind === "room") {
		if (isUuidLike(value)) target.roomId = value;
		else target.channelId = stripped;
	} else if (kind === "channel" || kind === "group") {
		target.channelId = stripped;
	} else if (kind === "server") {
		target.serverId = value;
	} else if (kind === "thread") {
		target.threadId = value;
	} else if (kind === "phone" || kind === "email") {
		target.entityId = value as UUID;
		target.channelId = value;
	} else if (kind === "user" || kind === "contact") {
		target.entityId = stripped as UUID;
	} else if (value.startsWith("#")) {
		kind = "channel";
		target.channelId = stripped;
	} else if (value.startsWith("@")) {
		kind = "user";
		target.entityId = stripped as UUID;
	} else if (isUuidLike(value)) {
		kind = "room";
		target.roomId = value;
	} else if (EMAIL_LITERAL.test(value)) {
		// A literal email address is an unambiguous, address-routed target: it
		// needs no contact lookup and no recipient confirmation to deliver.
		kind = "email";
		target.entityId = value as UUID;
		target.channelId = value;
	} else {
		kind = targetKind ?? "contact";
		target.entityId = stripped as UUID;
	}

	return {
		connector,
		target,
		label: value,
		kind,
		score: sourceWasExact ? 0.64 : 0.52,
		reasons: ["explicitTarget"],
	};
}

/** Values deliverable without a name lookup — numeric platform ids, phone dial
 * strings, email addresses. These stay on the explicit-target path instead of
 * being treated as an unresolved human name. */
function isAddressShaped(value: string): boolean {
	return (
		/^\d{6,}$/.test(value) ||
		/^\+?\d[\d\s().-]{5,}$/.test(value) ||
		EMAIL_LITERAL.test(value)
	);
}

/**
 * True when the top candidate is nothing but the raw-string person fallback —
 * no room member, entity, or connector hook corroborated the name. Shipping it
 * anyway just fails downstream at the connector ("could not resolve user")
 * after a wasted confirmation round, so resolution converts it into an upfront
 * question instead.
 */
function isUnresolvedPersonFallback(candidate: SendCandidate): boolean {
	if (
		candidate.reasons.length === 0 ||
		!candidate.reasons.every((reason) => reason === "explicitTarget")
	) {
		return false;
	}
	if (candidate.target.channelId || candidate.target.roomId) return false;
	const entityId = String(candidate.target.entityId ?? "").trim();
	if (!entityId || isUuidLike(entityId) || isAddressShaped(entityId)) {
		return false;
	}
	if (!candidate.kind) return true;
	const aliases = kindAliases(candidate.kind);
	return aliases.has("user") || aliases.has("contact");
}

type EntityCandidateCollection =
	| { status: "not_found"; candidates: [] }
	| {
			status: "resolved";
			candidates: SendCandidate[];
			requiresChoice: boolean;
	  }
	| {
			status: "no_claim" | "authority_unavailable";
			candidates: [];
			principalId: UUID;
			detail: string;
	  };

function connectorIdentityAuthorityId(connector: ConnectorWithHooks): string {
	const service = connector.metadata?.service;
	return typeof service === "string" && service.trim().length > 0
		? service.trim()
		: connector.source;
}

/**
 * Rollout gate for claim-authoritative delivery. Until the identity-claim
 * ingestion slice (issue #23099) ships, no runtime path writes claims, so the
 * claim-mandatory branch would refuse every contact send; the legacy
 * entity-component path stays authoritative unless an operator opts in via
 * the IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE setting.
 */
function claimDeliveryAuthoritative(runtime: IAgentRuntime): boolean {
	return identityDeliveryClaimsAuthoritative(
		runtime.getSetting(IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE_SETTING),
	);
}

function componentString(
	component: { data?: Record<string, unknown> },
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = component.data?.[key];
		if (typeof value === "string" && value.trim().length > 0)
			return value.trim();
		if (typeof value === "number") return String(value);
	}
	return undefined;
}

/**
 * Legacy (pre-claim-authority) entity candidate collection: the entity store
 * plus stored connector components supply delivery coordinates. Active only
 * while {@link claimDeliveryAuthoritative} is off; the claim-based collector
 * replaces it once verified identity claims are ingested and opted in.
 */
async function collectLegacyEntityCandidates(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	query: string | undefined,
	connectors: ConnectorWithHooks[],
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	accountId?: string,
): Promise<SendCandidate[]> {
	// An email literal is a typed address, not a contact name: it routes on the
	// explicit-address path in both delivery modes rather than through entity
	// lookup heuristics.
	if (
		!query ||
		EMAIL_LITERAL.test(query.trim()) ||
		(targetKind &&
			!kindAliases(targetKind).has("user") &&
			!kindAliases(targetKind).has("contact") &&
			!kindAliases(targetKind).has("email") &&
			!kindAliases(targetKind).has("phone"))
	) {
		return [];
	}

	// An entity UUID is already an unambiguous identifier. Resolving it through
	// the language model makes deterministic connector sends depend on provider
	// availability and can reinterpret an exact target as a name.
	const entity = isUuidLike(query)
		? await runtime.getEntityById(query)
		: await findEntityByName(
				runtime,
				{ ...message, content: { ...message.content, text: query } },
				state ?? ({ values: {}, data: {}, text: "" } as State),
			);
	if (!entity?.id) return [];

	const label = entity.names[0] ?? query;
	const preferredSource = preferredDeliverySource(entity);
	const exact = entityDisplayNames(entity).some((name) =>
		labelMatchesQuery(name, query),
	);
	const candidates: SendCandidate[] = [];
	for (const connector of connectors) {
		if (!connectorSupportsKind(connector, targetKind ?? "contact")) continue;
		const matchingComponent = entity.components?.find(
			(c) =>
				normalizeComparable(c.type) === normalizeComparable(connector.source),
		);
		const target = {
			source: connector.source,
			accountId: connector.accountId ?? accountId,
			entityId: entity.id as UUID,
		} as TargetInfo;
		if (matchingComponent) {
			const channelId = componentString(matchingComponent, [
				"channelId",
				"chatId",
				"conversationId",
				"phone",
				"phoneNumber",
				"email",
			]);
			if (channelId) target.channelId = channelId;
			const roomId = componentString(matchingComponent, ["roomId"]);
			if (roomId) target.roomId = roomId as UUID;
			const serverId = componentString(matchingComponent, ["serverId"]);
			if (serverId) target.serverId = serverId;
		}
		const lastChannel =
			preferredSource !== undefined &&
			normalizeComparable(connector.source) ===
				normalizeComparable(preferredSource);
		const reasons = matchingComponent ? ["entity", "component"] : ["entity"];
		if (lastChannel) reasons.push("lastChannel");
		candidates.push({
			connector,
			target,
			label,
			kind: targetKind ?? "contact",
			score:
				(matchingComponent ? 0.78 : sourceWasExact ? 0.66 : 0.56) +
				(lastChannel ? LAST_CHANNEL_BONUS : 0),
			reasons,
			exact,
		});
	}
	return candidates;
}

async function collectEntityCandidates(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	query: string | undefined,
	connectors: ConnectorWithHooks[],
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	accountId?: string,
): Promise<EntityCandidateCollection> {
	if (
		!query ||
		EMAIL_LITERAL.test(query.trim()) ||
		(targetKind &&
			!kindAliases(targetKind).has("user") &&
			!kindAliases(targetKind).has("contact") &&
			!kindAliases(targetKind).has("email") &&
			!kindAliases(targetKind).has("phone"))
	) {
		return { status: "not_found", candidates: [] };
	}

	// An entity UUID is already an unambiguous identifier. Resolving it through
	// the language model makes deterministic connector sends depend on provider
	// availability and can reinterpret an exact target as a name.
	const entity = isUuidLike(query)
		? await runtime.getEntityById(query)
		: await findEntityByName(
				runtime,
				{ ...message, content: { ...message.content, text: query } },
				state ?? ({ values: {}, data: {}, text: "" } as State),
			);
	if (!entity?.id) return { status: "not_found", candidates: [] };

	const principalService = runtime.getService<PrincipalService>(
		ServiceType.PRINCIPAL,
	);
	if (!principalService) {
		return {
			status: "authority_unavailable",
			candidates: [],
			principalId: entity.id as UUID,
			detail: "The canonical principal service is not registered.",
		};
	}

	const label = entity.names[0] ?? query;
	const preferredSource = preferredDeliverySource(entity);
	const exact = entityDisplayNames(entity).some((name) =>
		labelMatchesQuery(name, query),
	);
	const candidates: SendCandidate[] = [];
	const noClaimReasons = new Set<string>();
	let requiresChoice = false;
	for (const connector of connectors) {
		if (!connectorSupportsKind(connector, targetKind ?? "contact")) continue;
		const requestedAccountId = connector.accountId ?? accountId;
		if (requestedAccountId && !isUuidLike(requestedAccountId)) {
			noClaimReasons.add("connector account id is not a canonical UUID");
			continue;
		}
		let resolution: IdentityDeliveryClaimResolution;
		try {
			resolution = await principalService.resolveIdentityDeliveryClaim({
				agentId: runtime.agentId,
				principalId: entity.id as UUID,
				connectorId: connectorIdentityAuthorityId(connector),
				connectorAccountId: requestedAccountId as UUID | undefined,
			});
		} catch (error) {
			// error-policy:J4 canonical identity reads fail closed; connector hooks
			// cannot replace unavailable delivery authority for a known principal.
			runtime.reportError("MESSAGE.resolveIdentityDeliveryClaim", error, {
				principalId: entity.id,
				connector: connector.source,
			});
			return {
				status: "authority_unavailable",
				candidates: [],
				principalId: entity.id as UUID,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		if (resolution.decision === "no_claim") {
			noClaimReasons.add(resolution.reason);
			continue;
		}
		const claims =
			resolution.decision === "resolved"
				? [resolution.claim]
				: [...resolution.claims];
		if (!connector.resolveIdentityClaimTarget) {
			noClaimReasons.add(
				`${connector.source} does not map identity claims to delivery targets`,
			);
			continue;
		}
		const context = buildQueryContext(
			runtime,
			message,
			state,
			connector.source,
			undefined,
			connector,
			requestedAccountId,
		);
		const lastChannel =
			preferredSource !== undefined &&
			normalizeComparable(connector.source) ===
				normalizeComparable(preferredSource);
		// Ambiguity is judged on distinct delivery destinations, not raw claim
		// rows: several verified claims that map to the same connector-owned
		// delivery key (for example one address observed as both handle and
		// subject) are one destination, and the choice list must never show
		// identical entries.
		const candidatesByDeliveryKey = new Map<string, SendCandidate>();
		for (const claim of claims) {
			let mapped: MessageConnectorTarget | null;
			try {
				mapped = await connector.resolveIdentityClaimTarget(
					claim,
					context,
					resolution.canonicalPrincipalId,
				);
			} catch (error) {
				// error-policy:J4 claim-to-target mapping is connector-owned and must
				// fail closed; shared routing cannot guess a platform identifier.
				runtime.reportError("MESSAGE.resolveIdentityClaimTarget", error, {
					principalId: entity.id,
					connector: connector.source,
					claimId: claim.id,
				});
				return {
					status: "authority_unavailable",
					candidates: [],
					principalId: entity.id as UUID,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			const deliveryKey = mapped?.identityDeliveryKey?.trim();
			if (!mapped || !deliveryKey) {
				noClaimReasons.add(
					`${connector.source} could not map verified claim ${claim.id}`,
				);
				continue;
			}
			if (candidatesByDeliveryKey.has(deliveryKey)) continue;
			const reasons = ["entity", "canonicalClaim"];
			if (lastChannel) reasons.push("lastChannel");
			candidatesByDeliveryKey.set(deliveryKey, {
				connector,
				target: {
					...mapped.target,
					source: connector.source,
					accountId: claim.connectorAccountId,
				},
				label: `${label} (${mapped.label || deliveryKey})`,
				kind: mapped.kind ?? targetKind ?? "contact",
				score:
					(sourceWasExact ? 0.86 : 0.8) +
					(lastChannel ? LAST_CHANNEL_BONUS : 0),
				reasons,
				exact,
				identityClaim: {
					claimId: claim.id,
					canonicalPrincipalId: resolution.canonicalPrincipalId,
					connectorAccountId: claim.connectorAccountId,
					generation: resolution.generation,
					deliveryKey,
				},
			});
		}
		requiresChoice ||= candidatesByDeliveryKey.size > 1;
		candidates.push(...candidatesByDeliveryKey.values());
	}
	if (candidates.length > 0)
		return { status: "resolved", candidates, requiresChoice };
	return {
		status: "no_claim",
		candidates: [],
		principalId: entity.id as UUID,
		detail:
			[...noClaimReasons].sort().join(", ") || "no eligible connector claim",
	};
}

/** The connector this entity was last successfully reached on, if recorded.
 * Read from the entity's already-loaded components — no extra lookup. */
function preferredDeliverySource(entity: {
	components?: Array<{ type?: string; data?: Record<string, unknown> }>;
}): string | undefined {
	const component = entity.components?.find(
		(c) =>
			normalizeComparable(c.type) ===
			normalizeComparable(DELIVERY_PREFERENCE_COMPONENT_TYPE),
	);
	const source = component?.data?.source;
	return typeof source === "string" && source.trim().length > 0
		? source.trim()
		: undefined;
}

async function currentRoomCandidate(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	connector: ConnectorWithHooks,
	sourceWasExact: boolean,
	accountId?: string,
): Promise<SendCandidate> {
	const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
	const target = {
		source: connector.source,
		accountId: connector.accountId ?? accountId,
		roomId: (room?.id ?? message.roomId) as UUID,
	} as TargetInfo;
	if (room?.channelId) target.channelId = room.channelId;
	if (room?.serverId) target.serverId = room.serverId;
	const roomSource =
		typeof room?.source === "string"
			? room.source
			: trustedConnectorSource(message);
	const sourceMatches =
		normalizeComparable(roomSource) === normalizeComparable(connector.source);
	return {
		connector,
		target,
		label: room?.name ?? targetLabel(target),
		kind: "room",
		score: sourceWasExact || sourceMatches ? 0.72 : 0.54,
		reasons: ["currentRoom"],
	};
}

/** Component-data keys that carry a person's platform-visible name. Used for
 * the deterministic room-first name match so "tell vega …" resolves against
 * how the participant actually appears in the channel, not only the canonical
 * entity name list. */
const MEMBER_NAME_COMPONENT_KEYS = [
	"username",
	"handle",
	"displayName",
	"globalName",
	"name",
	"nick",
	"nickname",
] as const;

function entityDisplayNames(entity: {
	names: string[];
	components?: Array<{ data?: Record<string, unknown> }>;
}): string[] {
	const names = [...entity.names];
	for (const component of entity.components ?? []) {
		for (const key of MEMBER_NAME_COMPONENT_KEYS) {
			const value = component.data?.[key];
			if (typeof value === "string" && value.trim().length > 0) {
				names.push(value);
			}
		}
	}
	return names;
}

/**
 * Room-first target resolution: a `target` name that exactly matches someone
 * PRESENT in the current room resolves to an in-room utterance addressing that
 * member — a surface the agent already speaks in — instead of falling through
 * to the saved-contacts rolodex or a connector-wide fuzzy user lookup (which
 * reported room participants as "not in your contacts", or worse, DM'd a
 * fuzzy-matched stranger). Deterministic exact-name matching only; fuzzy
 * resolution stays with the entity/connector paths.
 */
async function currentRoomMemberCandidates(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	considered: ConnectorWithHooks[],
	params: NormalizedSendParams,
): Promise<SendCandidate[]> {
	const rawTarget = params.target?.trim();
	if (!rawTarget) return [];
	// An explicit field prefix that is not user/contact-shaped pins the target
	// to a non-person kind; leave it to the explicit-target path.
	const fieldMatch = rawTarget.match(
		/^(room|channel|server|entity|user|contact|thread|group|email|phone):(.+)$/i,
	);
	if (
		fieldMatch?.[1] &&
		!["user", "contact", "entity"].includes(fieldMatch[1].toLowerCase())
	) {
		return [];
	}
	if (rawTarget.startsWith("#")) return [];
	if (
		params.targetKind &&
		!kindAliases(params.targetKind).has("user") &&
		!kindAliases(params.targetKind).has("contact")
	) {
		return [];
	}
	const query = normalizeComparable(
		stripTargetPrefix(fieldMatch?.[2] ?? rawTarget),
	);
	if (!query || isUuidLike(query)) return [];

	const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
	const roomSource =
		typeof room?.source === "string"
			? room.source
			: trustedConnectorSource(message);
	const connector = findConnectorBySource(considered, roomSource);
	if (!connector) return [];

	const entities = await runtime.getEntitiesForRoom(message.roomId, true);
	const matches: Array<{ entityId: UUID; name: string }> = [];
	for (const entity of entities) {
		if (!entity.id || entity.id === runtime.agentId) continue;
		const matched = entityDisplayNames(entity).find(
			(name) => normalizeComparable(name) === query,
		);
		if (matched) {
			matches.push({
				entityId: entity.id as UUID,
				name: entity.names[0] ?? matched,
			});
		}
	}
	if (matches.length === 0) return [];

	const base = await currentRoomCandidate(
		runtime,
		message,
		state,
		connector,
		Boolean(params.source),
		params.accountId,
	);
	return matches.map((member) => ({
		...base,
		label: `${member.name} (in ${base.label})`,
		// Deterministic room-participant hit: outranks every fuzzy connector user
		// candidate (hook base 0.74 + boosts) without an LLM in the loop.
		score: 0.97,
		reasons: ["currentRoomMember"],
		exact: true,
		address: member,
	}));
}

function dedupeCandidates(candidates: SendCandidate[]): SendCandidate[] {
	const byKey = new Map<string, SendCandidate>();
	for (const c of candidates) {
		const key = [
			c.connector.source,
			c.target.accountId ?? c.connector.accountId,
			c.target.roomId,
			c.target.channelId,
			c.target.serverId,
			c.target.entityId,
			c.target.threadId,
		].join("|");
		const existing = byKey.get(key);
		if (
			!existing ||
			c.score > existing.score ||
			(c.score === existing.score &&
				c.exact === true &&
				existing.exact !== true)
		)
			byKey.set(key, c);
	}
	return Array.from(byKey.values()).sort((l, r) => {
		if (r.score !== l.score) return r.score - l.score;
		// The 1.0 clamp saturates exact and prefix hits into the same score, so
		// tier before the alphabetical fallback can promote the wrong candidate.
		const lExact = l.exact === true ? 1 : 0;
		const rExact = r.exact === true ? 1 : 0;
		if (rExact !== lExact) return rExact - lExact;
		return l.label.localeCompare(r.label);
	});
}

function formatCandidates(candidates: SendCandidate[]): string {
	return candidates
		.map((c, i) => {
			const kind = c.kind ? ` kind=${c.kind}` : "";
			return `${i + 1}. ${c.label} source=${c.connector.source}${kind} score=${c.score.toFixed(2)} target=${JSON.stringify(c.target)}`;
		})
		.join("\n");
}

/**
 * Resolve a runtime-internal send transport (e.g. the dashboard's
 * `client_chat` handler) that registers a send handler without advertising a
 * user-selectable MessageConnector. Only the admin/owner shortcut consults
 * this; ordinary target resolution must never route arbitrary sends through
 * internal transports.
 */
function internalSendConnector(
	runtime: IAgentRuntime,
	source: string,
): ConnectorWithHooks | null {
	const sendHandlers = (runtime as RuntimeWithLegacySendHandlers).sendHandlers;
	if (!(sendHandlers instanceof Map) || !sendHandlers.has(source)) return null;
	return {
		source,
		label: source
			.replace(/[_-]+/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase()),
		capabilities: ["send_message"],
		supportedTargetKinds: [],
		contexts: [],
	};
}

/**
 * "Message the owner/admin" resolves to the canonical owner over the transport
 * the request arrived on. Source preference: an explicit `source` param, then
 * the current conversation's connector, then the internal dashboard transport
 * (`client_chat`) — which is a registered send handler but deliberately not a
 * MessageConnector, so it needs the sendHandlers fallback here. Without that
 * fallback the literal word "admin" fell through to connector-wide fuzzy user
 * matching.
 */
async function resolveAdminTarget(
	runtime: IAgentRuntime,
	message: Memory,
	connectors: ConnectorWithHooks[],
	params: NormalizedSendParams,
): Promise<SendCandidate | null> {
	if (!params.target || !ADMIN_TARGETS.has(params.target.toLowerCase()))
		return null;
	const envelopeSource = trustedConnectorSource(message);
	const source = params.source ?? envelopeSource ?? MESSAGE_SOURCE_CLIENT_CHAT;
	const accountId =
		params.accountId ??
		(!params.source && source === envelopeSource
			? trustedConnectorAccountId(message)
			: undefined);
	const sourceMatches = connectors.filter((connector) =>
		connectorAliases(connector).some(
			(alias) => normalizeComparable(alias) === normalizeComparable(source),
		),
	);
	const scoped = selectAccountConnectors(sourceMatches, accountId);
	// More than one account on the resolved source is a genuine account choice;
	// fall through so the generic account scoping surfaces it to the user.
	if (scoped.length > 1) return null;
	const registered = scoped[0];
	const connector = registered ?? internalSendConnector(runtime, source);
	if (!connector) return null;
	const ownerId =
		(await resolveCanonicalOwnerIdForMessage(runtime, message)) ??
		deterministicOwnerEntityId(runtime.agentId);
	const target = {
		source: connector.source,
		accountId: connector.accountId ?? accountId,
		entityId: ownerId as UUID,
	} as TargetInfo;
	if (!registered) {
		// Internal transports route by conversation room, not entity id: pin the
		// originating room so delivery lands in the user's active conversation.
		target.roomId = message.roomId;
	}
	return {
		connector,
		target,
		label: params.target,
		kind: "contact",
		score: 1,
		reasons: ["admin"],
	};
}

async function resolveSendTarget(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	connectors: ConnectorWithHooks[],
	params: NormalizedSendParams,
): Promise<TargetResolution> {
	// The admin/owner shortcut resolves before connector scoping: it must work
	// even when zero user-selectable connectors are registered (app-only
	// installs deliver through the internal client_chat transport).
	const adminCandidate = await resolveAdminTarget(
		runtime,
		message,
		connectors,
		params,
	);
	if (adminCandidate) {
		return {
			status: "resolved",
			candidate: adminCandidate,
			sourceResolution: params.source ? params.sourceResolution : "defaulted",
		};
	}

	if (connectors.length === 0) {
		return {
			status: "missing_connector",
			text: "No message connectors are registered. Connect a messaging connector before MESSAGE op=send.",
			error: "NO_CONNECTORS_REGISTERED",
			sourceResolution: params.sourceResolution,
		};
	}

	const sourceScoped = params.source
		? connectors.filter((connector) =>
				connectorAliases(connector).some(
					(alias) =>
						normalizeComparable(alias) === normalizeComparable(params.source),
				),
			)
		: connectors;
	if (params.source && sourceScoped.length === 0) {
		return {
			status: "missing_connector",
			text: `No message connector for source "${params.source}". Available: ${connectors.map((c) => c.source).join(", ")}.`,
			error: "SOURCE_CONNECTOR_NOT_FOUND",
			sourceResolution: "exact",
		};
	}
	const accountScoped = selectAccountConnectors(sourceScoped, params.accountId);
	if (params.accountId && accountScoped.length === 0) {
		return {
			status: "missing_connector",
			text: `No message connector for account "${params.accountId}"${params.source ? ` on ${params.source}` : ""}.`,
			error: "ACCOUNT_CONNECTOR_NOT_FOUND",
			sourceResolution: params.sourceResolution,
		};
	}
	if (params.source && !params.accountId && accountScoped.length > 1) {
		return {
			status: "ambiguous",
			text:
				`MESSAGE op=send needs a connector account for ${params.source}. Choose one of: ` +
				accountScoped
					.map((connector) =>
						connector.accountId
							? `${connector.source}:${connector.accountId}`
							: connector.source,
					)
					.join(", "),
			candidates: [],
			sourceResolution: "exact",
		};
	}
	const exact =
		params.source && accountScoped.length === 1 ? accountScoped[0] : undefined;

	const sourceWasExact = Boolean(params.source && exact);
	let considered = exact
		? [exact]
		: accountScoped.filter((c) => connectorSupportsKind(c, params.targetKind));
	if (considered.length === 0) {
		return {
			status: "unsupported",
			text: `No connector supports targetKind "${params.targetKind}".`,
			error: "TARGET_KIND_UNSUPPORTED",
			sourceResolution: params.sourceResolution,
		};
	}

	if (!params.target && !params.source) {
		const currentSource = trustedConnectorSource(message);
		const currentConnector = findConnectorBySource(considered, currentSource);
		if (currentConnector) considered = [currentConnector];
	}

	const claimsAuthoritative = claimDeliveryAuthoritative(runtime);

	// Check the room before the rolodex: someone present in the current room is
	// the closest, least-surprising referent for a bare name — resolve to an
	// in-room utterance addressing them before any connector-wide fuzzy lookup
	// or contact search gets a chance to misroute the send. An email literal
	// skips the room shortcut in both delivery modes so a typed address always
	// reaches the literal-address path instead of a same-named room member.
	if (params.target && !EMAIL_LITERAL.test(params.target.trim())) {
		const roomMembers = await currentRoomMemberCandidates(
			runtime,
			message,
			state,
			considered,
			params,
		);
		const soleMember = roomMembers.length === 1 ? roomMembers[0] : undefined;
		if (soleMember) {
			return {
				status: "resolved",
				candidate: soleMember,
				sourceResolution: params.source ? params.sourceResolution : "defaulted",
			};
		}
		if (roomMembers.length > 1) {
			return {
				status: "ambiguous",
				text:
					`MESSAGE op=send matched ${roomMembers.length} people in the current room for "${params.target}". Pick one:\n` +
					formatCandidates(roomMembers),
				candidates: roomMembers,
				sourceResolution: params.source ? params.sourceResolution : "defaulted",
			};
		}
	}

	const candidates: SendCandidate[] = [];
	// Under claim authority a resolved principal short-circuits hook lookups
	// and explicit fallbacks; the legacy path keeps the pre-claim behavior of
	// merging hook, entity-component, and explicit candidates into one ranking.
	let claimEntityFound = false;
	if (claimsAuthoritative) {
		const entityCandidates = await collectEntityCandidates(
			runtime,
			message,
			state,
			params.target,
			considered,
			params.targetKind,
			sourceWasExact,
			params.accountId,
		);
		if (entityCandidates.status === "authority_unavailable") {
			return {
				status: "missing_target",
				text: `MESSAGE op=send cannot resolve canonical delivery authority for principal ${entityCandidates.principalId}: ${entityCandidates.detail}`,
				error: "TARGET_IDENTITY_AUTHORITY_UNAVAILABLE",
				sourceResolution: params.sourceResolution,
			};
		}
		if (entityCandidates.status === "no_claim") {
			return {
				status: "missing_target",
				text:
					`MESSAGE op=send found principal ${entityCandidates.principalId}, but no active verified delivery claim matches the selected connector/account (${entityCandidates.detail}). ` +
					"Ask the user for a literal address or link and verify the connector identity before retrying.",
				error: "TARGET_DELIVERY_CLAIM_MISSING",
				sourceResolution: params.sourceResolution,
			};
		}
		if (entityCandidates.status === "resolved") {
			if (entityCandidates.requiresChoice) {
				return {
					status: "ambiguous",
					text:
						"MESSAGE op=send found multiple active verified delivery claims. Pick one:\n" +
						formatCandidates(entityCandidates.candidates),
					candidates: entityCandidates.candidates,
					sourceResolution: params.source ? "exact" : "inferred",
				};
			}
			claimEntityFound = true;
			candidates.push(...entityCandidates.candidates);
		} else {
			for (const connector of considered) {
				const context = buildQueryContext(
					runtime,
					message,
					state,
					connector.source,
					undefined,
					connector,
					params.accountId,
				);
				candidates.push(
					...(await collectHookTargets(
						runtime,
						connector,
						params.target,
						context,
						params.targetKind,
						sourceWasExact,
						params.accountId,
					)),
				);
			}
		}
	} else {
		for (const connector of considered) {
			const context = buildQueryContext(
				runtime,
				message,
				state,
				connector.source,
				undefined,
				connector,
				params.accountId,
			);
			candidates.push(
				...(await collectHookTargets(
					runtime,
					connector,
					params.target,
					context,
					params.targetKind,
					sourceWasExact,
					params.accountId,
				)),
			);
		}
		candidates.push(
			...(await collectLegacyEntityCandidates(
				runtime,
				message,
				state,
				params.target,
				considered,
				params.targetKind,
				sourceWasExact,
				params.accountId,
			)),
		);
	}

	if (params.target && !claimEntityFound) {
		for (const connector of considered) {
			candidates.push(
				explicitSendTarget(
					connector,
					params.target,
					params.targetKind,
					sourceWasExact,
					params.accountId,
				),
			);
		}
	} else if (considered.length === 1) {
		const soleConnector = considered[0];
		if (soleConnector) {
			candidates.push(
				await currentRoomCandidate(
					runtime,
					message,
					state,
					soleConnector,
					sourceWasExact,
					params.accountId,
				),
			);
		}
	}

	const sorted = dedupeCandidates(candidates);
	if (sorted.length === 0) {
		return {
			status: "missing_target",
			text: "MESSAGE op=send could not resolve a target. Provide target and (if needed) source/targetKind.",
			error: "TARGET_NOT_RESOLVED",
			sourceResolution: params.sourceResolution,
		};
	}

	const top = sorted[0];
	if (top === undefined) {
		return {
			status: "missing_target",
			text: "MESSAGE op=send could not resolve a target. Provide target and (if needed) source/targetKind.",
			error: "TARGET_NOT_RESOLVED",
			sourceResolution: params.sourceResolution,
		};
	}
	// A raw-name fallback that nothing corroborated is not a deliverable
	// recipient — turn it into an upfront question instead of a doomed send.
	if (isUnresolvedPersonFallback(top)) {
		return {
			status: "missing_target",
			text:
				`MESSAGE op=send could not find "${params.target}" in the current room, saved contacts, or connector lookups. ` +
				`Ask the user who "${params.target}" is — a contact name, @handle, #channel, or literal address — before retrying.`,
			error: "TARGET_UNRESOLVED_RECIPIENT",
			sourceResolution: params.sourceResolution,
		};
	}

	const ambiguous = sorted.filter(
		(c) =>
			c !== top &&
			Math.abs(top.score - c.score) <= AMBIGUITY_DELTA &&
			// An exact name/label hit is a higher confidence tier than the prefix/
			// substring matches sharing its score band (both clamp to 1.0):
			// "shadow" is not ambiguous against "shadowfax". Two exact hits remain
			// genuinely ambiguous.
			(top.exact !== true || c.exact === true),
	);
	if (
		ambiguous.length > 0 &&
		(!params.source || top.score >= AMBIGUITY_SCORE)
	) {
		const choices = [top, ...ambiguous];
		return {
			status: "ambiguous",
			text:
				"MESSAGE op=send found multiple plausible targets. Specify a more exact target/source or pick one:\n" +
				formatCandidates(choices),
			candidates: choices,
			sourceResolution: params.source ? "exact" : "inferred",
		};
	}

	if (top.score < 0.5 && considered.length > 1) {
		return {
			status: "ambiguous",
			text:
				"MESSAGE op=send needs a more specific target/source. Available connectors:\n" +
				connectors
					.map((c, i) => `${i + 1}. ${c.source} (${c.label})`)
					.join("\n"),
			candidates: sorted,
			sourceResolution: params.sourceResolution,
		};
	}

	return {
		status: "resolved",
		candidate: top,
		sourceResolution:
			params.sourceResolution === "exact"
				? "exact"
				: params.source
					? "inferred"
					: considered.length === 1
						? "defaulted"
						: "inferred",
	};
}

function buildContent(params: NormalizedSendParams): Content {
	const content: Content = {
		text: params.message,
		source: params.source,
		metadata: {
			urgency: params.urgency,
			targetKind: params.targetKind,
			accountId: params.accountId,
			...(params.subject ? { subject: params.subject } : {}),
		},
	};
	if (params.attachments) content.attachments = params.attachments;
	return content;
}

/**
 * Remember the channel a person was last successfully reached on. Stored as an
 * entity component and read back by collectEntityCandidates as a scoring
 * bonus, so the next bare "tell <name> …" prefers the connector that actually
 * reached them. Recorded only for entity-backed recipients (room members and
 * rolodex contacts) — raw platform ids carry no entity to attach it to.
 */
async function recordDeliveryPreference(
	runtime: IAgentRuntime,
	message: Memory,
	candidate: SendCandidate,
	target: TargetInfo,
): Promise<void> {
	const entityIdRaw = String(target.entityId ?? "").trim();
	const entityId =
		candidate.address?.entityId ??
		candidate.identityClaim?.canonicalPrincipalId ??
		(isUuidLike(entityIdRaw) ? (entityIdRaw as UUID) : undefined);
	if (
		!entityId ||
		entityId === runtime.agentId ||
		typeof runtime.upsertComponent !== "function"
	) {
		return;
	}
	try {
		await runtime.upsertComponent({
			id: stringToUuid(
				`delivery-preference-${entityId}-${runtime.agentId}`,
			) as UUID,
			entityId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			worldId:
				message.worldId ??
				(stringToUuid(`${runtime.agentId}:delivery-preference-world`) as UUID),
			sourceEntityId: runtime.agentId,
			type: DELIVERY_PREFERENCE_COMPONENT_TYPE,
			createdAt: Date.now(),
			data: {
				source: candidate.connector.source,
				...(target.accountId ? { accountId: target.accountId } : {}),
				lastDeliveredAtMs: Date.now(),
			},
		});
	} catch (error) {
		// error-policy:J7 preference recording is delivery telemetry; a failed
		// write must not turn an already-delivered send into a failure.
		runtime.reportError("MESSAGE.recordDeliveryPreference", error, {
			source: candidate.connector.source,
			entityId,
		});
	}
}

function applyContentShaping(
	connector: ConnectorWithHooks,
	content: Content,
): Content {
	let text =
		typeof content.text === "string" ? toWellFormedUnicode(content.text) : "";
	const shaping = connector.contentShaping;
	if (text && typeof shaping?.postProcess === "function")
		text = toWellFormedUnicode(shaping.postProcess(text));
	const maxLength = shaping?.constraints?.maxLength;
	if (
		text &&
		typeof maxLength === "number" &&
		Number.isFinite(maxLength) &&
		maxLength > 0 &&
		text.length > maxLength
	) {
		throw new Error(
			`Connector ${connector.source} cannot accept ${text.length} characters; its declared maximum is ${Math.floor(maxLength)}. Refusing to send partial content.`,
		);
	}
	return text === content.text ? content : { ...content, text };
}

function channelTypeForKind(
	kind: MessageTargetKind | undefined,
): Content["channelType"] {
	if (
		kind === "user" ||
		kind === "contact" ||
		kind === "email" ||
		kind === "phone"
	)
		return ChannelType.DM;
	if (kind === "thread") return ChannelType.THREAD;
	if (kind === "server") return ChannelType.WORLD;
	return ChannelType.GROUP;
}

async function ensureOutboundRoom(
	runtime: IAgentRuntime,
	source: string,
	target: TargetInfo,
	label: string,
	kind: MessageTargetKind | undefined,
): Promise<{ roomId: UUID; worldId: UUID }> {
	const serverPart = target.serverId ?? "default";
	const targetPart =
		target.roomId ??
		target.channelId ??
		target.entityId ??
		target.threadId ??
		label;
	const worldId = stringToUuid(
		`${runtime.agentId}:${source}:message-world:${serverPart}`,
	) as UUID;
	const roomId = isUuidLike(target.roomId ?? "")
		? (target.roomId as UUID)
		: (stringToUuid(
				`${runtime.agentId}:${source}:message-room:${serverPart}:${targetPart}`,
			) as UUID);
	await runtime.ensureWorldExists({
		id: worldId,
		name: `${source}${target.serverId ? ` ${target.serverId}` : ""}`,
		agentId: runtime.agentId,
		messageServerId: target.serverId
			? (stringToUuid(`${source}:server:${target.serverId}`) as UUID)
			: undefined,
		metadata: { source, type: "message_world", serverId: target.serverId },
	});
	await runtime.ensureRoomExists({
		id: roomId,
		name: label,
		source,
		type: channelTypeForKind(kind) ?? ChannelType.GROUP,
		channelId: target.channelId ?? target.roomId ?? target.entityId,
		messageServerId: target.serverId
			? (stringToUuid(`${source}:server:${target.serverId}`) as UUID)
			: undefined,
		worldId,
		metadata: {
			source,
			type: "outbound_message_target",
			target: {
				source: target.source,
				roomId: target.roomId,
				channelId: target.channelId,
				serverId: target.serverId,
				entityId: target.entityId,
				threadId: target.threadId,
			},
			targetKind: kind,
		},
	});
	await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
	return { roomId, worldId };
}

type OutboundMemoryPersistence =
	| {
			status: "persisted" | "not_requested";
			memory?: Memory;
	  }
	| {
			status: "failed";
			memory?: Memory;
			code: "MESSAGE_OUTBOUND_MEMORY_PERSISTENCE_FAILED";
			message: string;
	  };

async function persistOutboundMemory(params: {
	runtime: IAgentRuntime;
	source: string;
	target: TargetInfo;
	label: string;
	kind?: MessageTargetKind;
	content: Content;
	sentMemory?: Memory;
	providerMessageId?: string;
	persist: boolean;
}): Promise<OutboundMemoryPersistence> {
	if (!params.persist) {
		return { status: "not_requested", memory: params.sentMemory };
	}
	const { runtime, source, target, label, kind, content, sentMemory } = params;
	try {
		const { roomId, worldId } = await ensureOutboundRoom(
			runtime,
			source,
			target,
			label,
			kind,
		);
		const sentMetadata =
			typeof sentMemory?.metadata === "object" && sentMemory.metadata !== null
				? (sentMemory.metadata as Record<string, unknown>)
				: undefined;
		const platformMessageId =
			params.providerMessageId ??
			(typeof sentMetadata?.platformMessageId === "string"
				? sentMetadata.platformMessageId
				: typeof sentMetadata?.messageIdFull === "string"
					? sentMetadata.messageIdFull
					: undefined);
		const memory: Memory = {
			...(sentMemory ?? {}),
			id:
				sentMemory?.id ??
				(stringToUuid(
					platformMessageId
						? `${source}:message:${platformMessageId}`
						: `${runtime.agentId}:${source}:message:${label}:${Date.now()}:${content.text ?? ""}`,
				) as UUID),
			entityId: sentMemory?.entityId ?? runtime.agentId,
			agentId: sentMemory?.agentId ?? runtime.agentId,
			roomId: sentMemory?.roomId ?? roomId,
			worldId: sentMemory?.worldId ?? worldId,
			content: {
				...content,
				...(sentMemory?.content ?? {}),
				source,
				channelType:
					sentMemory?.content?.channelType ?? channelTypeForKind(kind),
			},
			metadata: {
				...(sentMemory?.metadata ?? {}),
				type: "message",
				source,
				provider: source,
				...(platformMessageId
					? {
							messageIdFull: platformMessageId,
							platformMessageId,
						}
					: {}),
			},
			createdAt: sentMemory?.createdAt ?? Date.now(),
		};
		if (memory.id) {
			await runtime.upsertMemory(memory, "messages");
			return { status: "persisted", memory };
		}
		const id = await runtime.createMemory(memory, "messages");
		return { status: "persisted", memory: { ...memory, id } };
	} catch (error) {
		// error-policy:J1 the action boundary preserves provider acceptance while
		// returning an explicit failed local write instead of fabricated success.
		const message = error instanceof Error ? error.message : String(error);
		runtime.logger.warn(
			{
				src: "MESSAGE/send",
				err: message,
				source,
			},
			"Message sent but target room persistence failed",
		);
		return {
			status: "failed",
			memory: params.sentMemory,
			code: "MESSAGE_OUTBOUND_MEMORY_PERSISTENCE_FAILED",
			message,
		};
	}
}

async function persistCurrentChatMemory(args: {
	runtime: IAgentRuntime;
	message: Memory;
	source: string;
	label: string;
	kind?: MessageTargetKind;
	targetMemory?: Memory;
	platformMessageId?: string;
}): Promise<void> {
	const {
		runtime,
		message,
		source,
		label,
		kind,
		targetMemory,
		platformMessageId,
	} = args;
	try {
		const memoryId = stringToUuid(
			[
				message.id ?? message.roomId,
				"MESSAGE",
				source,
				targetMemory?.id ?? platformMessageId ?? Date.now(),
			].join(":"),
		) as UUID;
		const memory: Memory = {
			id: memoryId,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			worldId: message.worldId,
			content: {
				text: `Message sent via ${source} to ${label}.`,
				actions: ["MESSAGE"],
				source: "agent_action",
				type: "action_result",
				actionName: "MESSAGE",
				actionStatus: "completed",
				responseMessageId: targetMemory?.id,
				metadata: {
					operation: "send",
					targetSource: source,
					targetLabel: label,
					targetKind: kind,
					targetRoomId: targetMemory?.roomId,
					sentMessageId: platformMessageId,
				},
			},
			metadata: {
				type: "message",
				source: "agent_action",
				provider: source,
				actionName: "MESSAGE",
				operation: "send",
				targetSource: source,
				targetLabel: label,
				targetKind: kind,
				targetRoomId: targetMemory?.roomId,
				sentMessageId: platformMessageId,
			} as Memory["metadata"],
			createdAt: Date.now(),
		};
		await runtime.upsertMemory(memory, "messages");
	} catch (error) {
		// error-policy:J7 the provider delivery is already observable; failure to
		// persist its local action trace is reported without inviting a resend.
		runtime.logger.warn(
			{
				src: "MESSAGE/send",
				err: error instanceof Error ? error.message : String(error),
				source,
			},
			"Message sent but action memory persistence failed",
		);
		runtime.reportError("MESSAGE/send-action-memory", error, {
			source,
			targetLabel: label,
			platformMessageId,
		});
	}
}

/**
 * Gate "act as the user" sends behind a verified owner binding. Sending through
 * the agent's OWN account (an AGENT account on the `open` gate) is frictionless;
 * sending through the human owner's personal account (an OWNER account on the
 * `owner_binding` gate) must not fire until the user has proven that account is
 * theirs. Returns an opFailure to abort the send, or undefined to allow it.
 *
 * Resolves only for targets that name an explicit accountId — the legacy
 * source-only route (the agent's default account) is never an owner account and
 * skips the check entirely, so this adds zero friction to normal agent sends.
 */
async function ensureSendAccountAllowed(
	runtime: IAgentRuntime,
	message: Memory,
	source: string,
	accountId: string | undefined,
): Promise<ActionResult | undefined> {
	if (!accountId) {
		return undefined;
	}
	const manager = getConnectorAccountManager(runtime);
	let account: Awaited<ReturnType<typeof manager.getAccount>>;
	try {
		account = await manager.getAccount(source, accountId);
	} catch (error) {
		// error-policy:J4 Account-policy resolution fails closed and returns a
		// distinct refusal rather than allowing an unverified owner send.
		// Fail CLOSED: a lookup failure must never silently bypass the gate. If we
		// cannot resolve the account, we cannot prove it is a frictionless
		// agent/`open` account, so we refuse the "act as the user" send rather than
		// risk firing it ungated on what may be an unverified owner account.
		runtime.reportError("MESSAGE.ensureSendAccountAllowed", error, {
			source,
			accountId,
		});
		return opFailure(
			"send",
			"OWNER_BINDING_REQUIRED",
			`Could not verify the access policy for ${accountId} on ${source}; refusing to send until the account can be resolved.`,
			{
				source,
				accountId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
	// Only owner-bound accounts are gated; agent/`open` accounts (and a resolved
	// target with no stored account record) pass straight through. Other gates
	// (`disabled`/`manual_approval`/`pairing`) are intentionally out of scope here:
	// this gate guards the owner-impersonation threat only.
	if (account?.accessGate !== "owner_binding") {
		return undefined;
	}
	const evaluation = await manager.evaluatePolicy(
		{ provider: source, accessGates: ["owner_binding"], required: true },
		{ message, accountId, purpose: "messaging" },
	);
	if (evaluation.allowed) {
		return undefined;
	}
	return opFailure(
		"send",
		"OWNER_BINDING_REQUIRED",
		`Sending as ${account.displayHandle ?? accountId} needs a verified owner binding first (${
			evaluation.reason ?? "owner binding has not been verified"
		}). Link and verify that account before the agent can act as you on it.`,
		{ source, accountId, accessGate: account.accessGate },
	);
}

/** Candidate origins whose recipient identity is already vetted: the admin
 * shortcut, the entity path (findEntityByName only surfaces room/relationship
 * entities), and in-room deliveries (no DM is involved). */
const RECIPIENT_VETTED_REASONS = new Set([
	"admin",
	"entity",
	"component",
	"canonicalClaim",
	"currentRoom",
	"currentRoomMember",
]);

/**
 * True when the selected candidate is a direct-to-person delivery whose
 * recipient identity came from an UNVETTED source — a connector discovery hook
 * (e.g. Discord's guild-wide fuzzy member match) or a raw explicit target.
 * These must be backed by a room-participant/relationship entity or confirmed
 * by the user before delivery; without this gate, `target="name"` could DM a
 * fuzzy-matched stranger with no confirmation.
 */
function isUnvettedDirectUserCandidate(candidate: SendCandidate): boolean {
	const entityId = candidate.target.entityId;
	if (!entityId) return false;
	// Address-routed deliveries (an explicit channel/room, or phone/email whose
	// dial string doubles as the channel) are not identity-fuzzy.
	if (candidate.target.channelId || candidate.target.roomId) return false;
	// An entity-store UUID is an unambiguous identifier the planner obtained
	// from a real lookup, not a fuzzy name match.
	if (isUuidLike(String(entityId))) return false;
	if (candidate.reasons.some((reason) => RECIPIENT_VETTED_REASONS.has(reason)))
		return false;
	if (candidate.kind) {
		const aliases = kindAliases(candidate.kind);
		return aliases.has("user") || aliases.has("contact");
	}
	// No declared kind: a bare entityId with no routing address is a DM shape.
	return true;
}

/**
 * A recipient is "known" when they participate in the current room or are
 * relationship-backed in the entity graph. Connector candidates carry raw
 * platform ids (e.g. Discord snowflakes), so both the raw id and its
 * agent-scoped entity UUID (`createUniqueUuid`) are checked, plus the room
 * participants' connector component data. Mere existence of an entity record
 * is NOT enough — history backfill creates entities for every past chatter.
 */
async function recipientIsKnownEntity(
	runtime: IAgentRuntime,
	message: Memory,
	target: TargetInfo,
): Promise<boolean> {
	const raw = String(target.entityId ?? "").trim();
	if (!raw) return false;
	const candidateIds = new Set<string>([
		createUniqueUuid(runtime, raw).toLowerCase(),
	]);
	if (isUuidLike(raw)) candidateIds.add(raw.toLowerCase());

	const roomEntities = await runtime.getEntitiesForRoom(message.roomId, true);
	for (const entity of roomEntities) {
		if (!entity.id) continue;
		if (candidateIds.has(String(entity.id).toLowerCase())) return true;
		for (const component of entity.components ?? []) {
			const values = Object.values(component.data ?? {});
			if (values.some((value) => typeof value === "string" && value === raw)) {
				return true;
			}
		}
	}

	const requesterId = message.entityId;
	if (!requesterId) return false;
	const recipientIds: UUID[] = [];
	for (const id of candidateIds) {
		const entity = await runtime.getEntityById(id as UUID);
		if (!entity?.id) continue;
		recipientIds.push(entity.id);
	}
	if (recipientIds.length === 0) return false;

	const relationships = await runtime.getRelationshipsByPairs(
		recipientIds.flatMap((recipientId) => [
			{ sourceEntityId: requesterId, targetEntityId: recipientId },
			{ sourceEntityId: recipientId, targetEntityId: requesterId },
		]),
	);
	return relationships.some((relationship) => relationship !== null);
}

async function handleSend(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = listMessageConnectors(runtime);
	const normalized = normalizeSendParams(params, message, state, connectors);

	if (!normalized.message && !normalized.attachments) {
		return opFailure(
			"send",
			"INVALID_PARAMETERS",
			"MESSAGE op=send requires message text or attachments.",
		);
	}
	if (!VALID_URGENCIES.has(normalized.urgency)) {
		return opFailure(
			"send",
			"INVALID_PARAMETERS",
			`MESSAGE op=send urgency must be one of normal|important|urgent. Got "${normalized.urgency}".`,
		);
	}

	const resolution = await resolveSendTarget(
		runtime,
		message,
		state,
		connectors,
		normalized,
	);
	if (resolution.status !== "resolved") {
		const code =
			resolution.status === "ambiguous" ? "TARGET_AMBIGUOUS" : resolution.error;
		return opFailure("send", code, resolution.text, {
			sourceResolution: resolution.sourceResolution,
			candidates:
				"candidates" in resolution
					? resolution.candidates.map((c) => ({
							source: c.connector.source,
							label: c.label,
							kind: c.kind,
							score: c.score,
							target: c.target,
						}))
					: undefined,
		});
	}

	const selected = resolution.candidate;
	const target: TargetInfo = normalized.thread
		? { ...selected.target, threadId: normalized.thread }
		: selected.target;

	// Block "act as the user" until the owner account is verified; agent-owned
	// accounts (open gate) and source-only routes pass through untouched.
	const gate = await ensureSendAccountAllowed(
		runtime,
		message,
		selected.connector.source,
		target.accountId,
	);
	if (gate) {
		return gate;
	}

	// A direct-to-person delivery resolved from an unvetted source (connector
	// fuzzy match / raw explicit target) must be a known recipient — present in
	// this room or relationship-backed — or explicitly confirmed by the user.
	if (isUnvettedDirectUserCandidate(selected)) {
		const known = await recipientIsKnownEntity(runtime, message, target);
		if (!known) {
			const decision = await requireConfirmation({
				runtime,
				message,
				actionName: "MESSAGE",
				pendingKey: `send:${selected.connector.source}:${String(target.entityId)}`,
				prompt: `Send this via ${selected.connector.label} to ${selected.label}? They are not in this room, your contacts, or your relationship graph.`,
			});
			if (decision.status !== "confirmed") {
				const pending = decision.status === "pending";
				return {
					success: pending,
					text: pending
						? `"${selected.label}" on ${selected.connector.label} is not in this room or the user's relationship graph. Ask the user to confirm sending to this recipient (yes/no) before the message is delivered; nothing was sent.`
						: "The user declined sending to this recipient; nothing was sent.",
					data: {
						actionName: "MESSAGE",
						operation: "send",
						confirmationRequired: pending,
						awaitingUserInput: pending,
						cancelled: !pending,
						source: selected.connector.source,
						targetLabel: selected.label,
					},
				};
			}
		}
	}

	// Room-first member delivery: the utterance lands in the shared channel, so
	// address the intended member by name unless the text already does.
	const outboundMessage =
		selected.address &&
		!normalizeComparable(normalized.message).includes(
			normalizeComparable(selected.address.name),
		)
			? `@${selected.address.name} ${normalized.message}`.trim()
			: normalized.message;

	const builtContent = buildContent({
		...normalized,
		message: outboundMessage,
		source: selected.connector.source,
	});
	if (selected.identityClaim) {
		builtContent.metadata = {
			...(isRecord(builtContent.metadata) ? builtContent.metadata : {}),
			identityDeliveryClaim: selected.identityClaim,
		};
	}
	const content = applyContentShaping(selected.connector, builtContent);

	let persisted: Memory | undefined;
	let providerMessageId: string | undefined;
	try {
		const sendResult = await runtime.sendMessageToTarget(target, content);
		const disposition = inspectSendHandlerResult(sendResult);
		if (disposition.kind === "unknown") {
			logger.warn(
				`[MESSAGE/send] ${selected.connector.source} returned no delivery evidence`,
			);
			return opFailure(
				"send",
				"MESSAGE_DELIVERY_UNKNOWN",
				`${selected.connector.label} returned no delivery receipt. The message may or may not have been accepted; no success record was persisted.`,
				{
					source: selected.connector.source,
					target,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "unknown",
					acceptance: "unknown",
					persisted: false,
				},
			);
		}
		if (disposition.kind === "in_flight") {
			return opFailure(
				"send",
				"MESSAGE_DELIVERY_IN_FLIGHT",
				`A matching message is already being delivered via ${selected.connector.label} to ${selected.label}. This attempt sent and persisted nothing, and delivery is not yet confirmed.`,
				{
					source: selected.connector.source,
					target,
					targetLabel: selected.label,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "in_flight",
					newDelivery: false,
					persisted: false,
				},
			);
		}
		if (disposition.kind === "not_delivered") {
			return opFailure(
				"send",
				"MESSAGE_NOT_DELIVERED",
				`Message was not delivered via ${selected.connector.label}: ${disposition.message}`,
				{
					source: selected.connector.source,
					target,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "not_delivered",
					connectorCode: disposition.code,
					newDelivery: false,
					persisted: false,
				},
			);
		}
		if (disposition.kind === "partially_delivered") {
			return opFailure(
				"send",
				"MESSAGE_PARTIAL_DELIVERY",
				`${selected.connector.label} accepted part of the message, but the complete payload was not delivered. Do not retry blindly; provider messages ${disposition.receipt.providerMessageIds.join(", ")} already exist. ${disposition.message}`,
				{
					source: selected.connector.source,
					target,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "partially_delivered",
					connectorCode: disposition.code,
					acceptance: "partial",
					responseMessageId: disposition.providerMessageId,
					providerMessageIds: disposition.receipt.providerMessageIds,
					replayed: disposition.replayed,
					persistenceStatus: disposition.receipt.persistence.status,
					newDelivery: !disposition.replayed,
					persisted: false,
				},
			);
		}

		providerMessageId = disposition.providerMessageId;
		if (
			disposition.receipt &&
			(disposition.receipt.persistence.status === "partial" ||
				disposition.receipt.persistence.status === "failed")
		) {
			return opFailure(
				"send",
				"MESSAGE_DELIVERED_PERSISTENCE_FAILED",
				`The provider accepted the complete message via ${selected.connector.label}, but local delivery evidence was not fully persisted. Do not resend; reconcile provider messages ${disposition.receipt.providerMessageIds.join(", ")}.`,
				{
					source: selected.connector.source,
					target,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "delivered",
					acceptance: "accepted",
					responseMessageId: providerMessageId,
					providerMessageIds: disposition.receipt.providerMessageIds,
					persistenceStatus: disposition.receipt.persistence.status,
					replayed: disposition.replayed,
					newDelivery: !disposition.replayed,
					persisted: false,
				},
			);
		}
		if (disposition.replayed) {
			return opSuccess(
				"send",
				`A matching message had already been delivered via ${selected.connector.label} to ${selected.label}; this attempt sent and persisted nothing new.`,
				{
					source: selected.connector.source,
					target,
					targetLabel: selected.label,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "duplicate",
					priorDelivery: "delivered",
					responseMessageId: providerMessageId,
					providerMessageIds: disposition.receipt?.providerMessageIds,
					newDelivery: false,
					persisted: false,
				},
			);
		}

		const sentMemory = disposition.memories.at(-1);
		const persistence = await persistOutboundMemory({
			runtime,
			source: selected.connector.source,
			target,
			label: selected.label,
			kind: selected.kind,
			content,
			sentMemory,
			providerMessageId,
			persist: boolParam(params.persist) !== false,
		});
		persisted = persistence.memory;
		if (persistence.status === "failed") {
			const providerMessageIds =
				disposition.receipt?.providerMessageIds ??
				(providerMessageId ? [providerMessageId] : undefined);
			return opFailure(
				"send",
				"MESSAGE_DELIVERED_PERSISTENCE_FAILED",
				`The provider accepted the complete message via ${selected.connector.label}, but the requested local outbound record failed. Do not resend; reconcile the accepted provider message${providerMessageIds?.length === 1 ? "" : "s"}${providerMessageIds ? ` ${providerMessageIds.join(", ")}` : ""}.`,
				{
					source: selected.connector.source,
					target,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
					deliveryStatus: "delivered",
					acceptance: "accepted",
					responseMessageId: providerMessageId,
					providerMessageIds,
					persistenceStatus: "failed",
					persistenceCode: persistence.code,
					persistenceMessage: persistence.message,
					replayed: false,
					newDelivery: true,
					persisted: false,
				},
			);
		}
	} catch (error) {
		// error-policy:J1 connector/action boundary translates transport throws
		// into an explicit failed action without fabricating persistence.
		const text = error instanceof Error ? error.message : String(error);
		logger.error(
			`[MESSAGE/send] failed via ${selected.connector.source}: ${text}`,
		);
		return opFailure(
			"send",
			"MESSAGE_SEND_FAILED",
			`Failed to send via ${selected.connector.label}: ${text}`,
			{
				source: selected.connector.source,
				target,
				targetKind: selected.kind,
				sourceResolution: resolution.sourceResolution,
			},
		);
	}

	if (!providerMessageId && typeof persisted?.metadata === "object") {
		const persistedMetadata = persisted.metadata as Record<string, unknown>;
		providerMessageId =
			typeof persistedMetadata.platformMessageId === "string"
				? persistedMetadata.platformMessageId
				: typeof persistedMetadata.messageIdFull === "string"
					? persistedMetadata.messageIdFull
					: undefined;
	}
	await recordDeliveryPreference(runtime, message, selected, target);
	await persistCurrentChatMemory({
		runtime,
		message,
		source: selected.connector.source,
		label: selected.label,
		kind: selected.kind,
		targetMemory: persisted,
		platformMessageId: providerMessageId,
	});

	return opSuccess(
		"send",
		`Message sent via ${selected.connector.label} to ${selected.label}.`,
		{
			source: selected.connector.source,
			target,
			targetLabel: selected.label,
			targetKind: selected.kind,
			sourceResolution: resolution.sourceResolution,
			resolutionReasons: selected.reasons,
			identityDeliveryClaim: selected.identityClaim,
			thread: normalized.thread,
			urgency: normalized.urgency,
			memoryId: persisted?.id,
			responseMessageId: providerMessageId,
			deliveryStatus: "delivered",
		},
	);
}

// ---------------------------------------------------------------------------
// op=read_channel — channel-centric read.
//
// Two paths:
//   1. If the connector exposes fetchMessages, use it.
//   2. Otherwise, fall back to local `messages` table by resolving the room
//      from the channel/source params (covers the original read-channel leaf behavior).
// ---------------------------------------------------------------------------

function memoryReadFailure(
	code: string,
	text: string,
	extra?: Record<string, unknown>,
): ActionResult {
	const metadata = {
		actionName: "MESSAGE",
		operation: "read_channel",
		error: code,
		...(extra ?? {}),
	};
	return {
		success: false,
		text,
		values: { success: false, error: code },
		data: metadata,
		promptData: metadata,
	};
}

function memoryScopeAllowsSameRoomRead(
	stored: Memory,
	requesterId: UUID,
	agentId: UUID,
): boolean {
	const metadata = (stored.metadata ?? {}) as Record<string, unknown>;
	const scope = metadata.scope;
	if (
		scope === undefined ||
		scope === "global" ||
		scope === "shared" ||
		scope === "room"
	) {
		return true;
	}
	const scopedTo =
		typeof metadata.scopedToEntityId === "string"
			? metadata.scopedToEntityId
			: typeof metadata.addedBy === "string"
				? metadata.addedBy
				: stored.entityId;
	if (scope === "private" || scope === "user-private") {
		return scopedTo === requesterId;
	}
	if (scope === "agent-private") return requesterId === agentId;
	// Owner-private needs a live owner-role proof that this narrow same-room
	// action does not mint. Fail closed rather than infer it from content.
	return false;
}

function safeMemoryReadInteger(
	value: number | undefined,
	label: "offset" | "limit",
	fallback?: number,
): number | undefined {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 0) return undefined;
	if (label === "limit" && value < 1) return undefined;
	return value;
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
	return (
		offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80
	);
}

async function handleReadStoredMemory(
	runtime: IAgentRuntime,
	message: Memory,
	params: ParamRecord,
	memoryReference: string,
): Promise<ActionResult> {
	const memoryRef = memoryReference.startsWith("memory:")
		? memoryReference.slice("memory:".length)
		: memoryReference;
	if (!isUuidLike(memoryRef)) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_INVALID_REFERENCE",
			"The stored message reference is invalid.",
		);
	}
	const stored = await runtime.getMemoryById(memoryRef);
	if (!stored || stored.agentId !== runtime.agentId) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_NOT_FOUND",
			"The stored message was not found.",
		);
	}
	if (stored.roomId !== message.roomId) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_ACCESS_DENIED",
			"The stored message is not readable from this room.",
		);
	}
	let stillParticipant = false;
	try {
		stillParticipant = (
			await runtime.getParticipantsForRoom(stored.roomId)
		).includes(message.entityId);
	} catch (error) {
		// error-policy:J1 The action boundary reports authorization lookup failure
		// without disclosing whether the referenced memory exists in the room.
		runtime.reportError("MESSAGE.readStoredMemory.authorization", error, {
			roomId: stored.roomId,
		});
		return memoryReadFailure(
			"MESSAGE_MEMORY_AUTHORIZATION_UNAVAILABLE",
			"Stored-message authorization is unavailable.",
		);
	}
	if (
		!stillParticipant ||
		!memoryScopeAllowsSameRoomRead(stored, message.entityId, runtime.agentId)
	) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_ACCESS_DENIED",
			"The stored message is not readable from this room.",
		);
	}

	const offset = safeMemoryReadInteger(numberParam(params.offset), "offset", 0);
	const limit = safeMemoryReadInteger(numberParam(params.limit), "limit");
	if (
		offset === undefined ||
		(params.limit !== undefined && limit === undefined)
	) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_INVALID_RANGE",
			"Stored-message offset must be a nonnegative safe integer and limit must be a positive safe integer when supplied.",
		);
	}

	const sourceText = stored.content.text ?? "";
	const bytes = new TextEncoder().encode(sourceText);
	if (offset > bytes.length || !isUtf8Boundary(bytes, offset)) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_INVALID_RANGE",
			"Stored-message offset is outside the content or splits a UTF-8 code point.",
			{ totalBytes: bytes.length },
		);
	}
	let end =
		limit === undefined ? bytes.length : Math.min(offset + limit, bytes.length);
	while (end > offset && !isUtf8Boundary(bytes, end)) end--;
	if (end === offset && offset < bytes.length) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_INVALID_RANGE",
			"Stored-message limit is too small to include the next UTF-8 code point.",
			{ minimumLimit: 4 },
		);
	}

	const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
	const revision = `rev:${sourceSha256}`;
	const expectedRevision = textParam(params.expectedRevision);
	if (offset > 0 && !expectedRevision) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_EXPECTED_REVISION_REQUIRED",
			"Stored-message continuation requires expectedRevision.",
		);
	}
	if (expectedRevision && expectedRevision !== revision) {
		return memoryReadFailure(
			"MESSAGE_MEMORY_STALE_REVISION",
			"The stored message changed before this page could be read.",
			{ currentRevision: revision },
		);
	}

	const pageBytes = bytes.slice(offset, end);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(pageBytes);
	const readView = {
		reference: buildContentReference({
			kind: "memory",
			ref: `memory:${memoryRef}`,
			revision,
		}),
		slice: buildReadSlice({
			range: { unit: "byte", start: offset, end, total: bytes.length },
			completeness: end < bytes.length ? "partial-recoverable" : "complete",
			revision,
			sliceSha256: createHash("sha256").update(pageBytes).digest("hex"),
			sourceSha256,
		}),
	};
	const metadata = {
		actionName: "MESSAGE",
		operation: "read_channel",
		messageRef: readView.reference.ref,
		readView,
	};
	// The exact page has one carrier. Structured fields contain only the opaque
	// reference and bounded range/digest metadata.
	return {
		success: true,
		text,
		values: { success: true, readView },
		data: metadata,
		promptData: metadata,
	};
}

function parseDateParam(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isNaN(parsed)) return parsed;
	const num = Number(value);
	if (!Number.isNaN(num)) return num > 1e12 ? num : num * 1000;
	return undefined;
}

function connectorReadRequest(
	target: TargetInfo,
	params: ParamRecord,
	limit: number | undefined,
) {
	return {
		target,
		...(limit === undefined ? {} : { limit }),
		cursor: textParam(params.cursor),
		before: textParam(params.before),
		after: textParam(params.after),
	};
}

async function fetchRecentMessagesFromConnector(
	connector: ConnectorWithHooks,
	context: MessageConnectorQueryContext,
	params: ParamRecord,
	limit: number | undefined,
): Promise<Memory[]> {
	if (!connector.fetchMessages || !connector.listRecentTargets) return [];
	const recent = await connector.listRecentTargets(context);
	const memories: Memory[] = [];
	for (const r of recent) {
		const target = {
			...r.target,
			accountId: r.target.accountId ?? connector.accountId,
		};
		memories.push(
			...((await connector.fetchMessages(
				{ ...context, target },
				connectorReadRequest(target, params, limit),
			)) as Memory[]),
		);
	}
	return memories;
}

/**
 * The stored room a channel name denotes. An exact name beats a substring
 * match and a text channel beats a voice channel: the Discord test server
 * has a text channel "general" and a voice channel "General", and the first
 * room in participant order was the voice one, so "read the last 3 messages
 * in #general" read 0 messages from an empty room (live 2026-09-15).
 */
export async function resolveLocalChannelRoom(
	runtime: IAgentRuntime,
	source: string | undefined,
	channel: string,
): Promise<Room | null> {
	if (isUuidLike(channel)) {
		const direct = await runtime.getRoom(channel as UUID);
		if (direct) return direct;
	}
	const agentRooms = await runtime.getRoomsForParticipant(runtime.agentId);
	const rooms = await Promise.all(
		agentRooms.map((roomId) => runtime.getRoom(roomId)),
	);
	return rankLocalChannelRooms(rooms, source, channel)[0] ?? null;
}

const VOICE_ROOM_TYPES = new Set<string>([
	ChannelType.VOICE_GROUP,
	ChannelType.VOICE_DM,
]);

export function rankLocalChannelRooms(
	rooms: ReadonlyArray<Room | null | undefined>,
	source: string | undefined,
	channel: string,
): Room[] {
	const channelLower = channel.trim().toLowerCase().replace(/^#/, "");
	const sourceLower = source?.toLowerCase();
	const ranked: Array<{ room: Room; rank: number; index: number }> = [];
	rooms.forEach((room, index) => {
		if (!room) return;
		const roomRecord = room as Room & {
			name?: string;
			source?: string;
			type?: string;
		};
		const name = (roomRecord.name ?? "").toLowerCase();
		const roomSource = (roomRecord.source ?? "").toLowerCase();
		if (sourceLower && roomSource !== sourceLower) return;
		const exact = name === channelLower;
		if (!exact && !name.includes(channelLower)) return;
		const voice = VOICE_ROOM_TYPES.has(String(roomRecord.type ?? ""));
		ranked.push({ room, rank: (exact ? 0 : 2) + (voice ? 1 : 0), index });
	});
	return ranked
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.room);
}

async function handleReadChannel(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const memoryReference =
		textParam(params.reference) ??
		textParam(params.messageId) ??
		textParam(params.id);
	if (memoryReference) {
		return handleReadStoredMemory(runtime, message, params, memoryReference);
	}
	const connectors = listMessageConnectors(runtime);
	const source = sourceFromParams(params, message);
	const accountId = accountIdFromParams(params, message);
	const channel = textParam(params.channel) ?? textParam(params.target);
	const range = textParam(params.range);
	const limit = recentReadLimit(
		range,
		requestedLimit(numberParam(params.limit)),
	);

	// Prefer in-process connector fetchMessages when available.
	const hookConnectors = connectors.filter(
		(c) => typeof c.fetchMessages === "function",
	);
	const selectedResult =
		source || accountId
			? selectConnectorForOp(
					hookConnectors,
					source,
					trustedConnectorSource(message),
					"read_channel",
					accountId,
				)
			: undefined;
	if (selectedResult && "error" in selectedResult) return selectedResult.error;
	const selectedConnector =
		selectedResult && "connector" in selectedResult
			? selectedResult.connector
			: soleConnectorFamily(hookConnectors);

	if (selectedConnector?.fetchMessages) {
		const resolved = await resolveOptionalTarget(
			selectedConnector,
			runtime,
			message,
			state,
			params,
			"read_channel",
		);
		if (resolved.error) return resolved.error;
		const context = buildQueryContext(
			runtime,
			message,
			state,
			selectedConnector.source,
			resolved.target,
			selectedConnector,
			accountId,
		);
		try {
			let memories: Memory[] = [];
			if (resolved.target) {
				memories = (await selectedConnector.fetchMessages(context, {
					...connectorReadRequest(resolved.target, params, limit),
				})) as Memory[];
			} else {
				memories = await fetchRecentMessagesFromConnector(
					selectedConnector,
					context,
					params,
					limit,
				);
				memories = memories.sort(compareMemoryByCreatedAtDesc);
				if (limit !== undefined) memories = memories.slice(0, limit);
			}
			return opSuccess(
				"read_channel",
				`Read ${memories.length} messages from ${selectedConnector.label}.`,
				{ source: selectedConnector.source, memories },
			);
		} catch (error) {
			// error-policy:J1 Connector failures become structured action failures.
			return opErrorWrap("read_channel", error);
		}
	}

	if (!channel && hookConnectors.length > 1) {
		const results = await Promise.allSettled(
			hookConnectors.map(async (connector) => {
				const context = buildQueryContext(
					runtime,
					message,
					state,
					connector.source,
					undefined,
					connector,
				);
				return {
					connector,
					memories: await fetchRecentMessagesFromConnector(
						connector,
						context,
						params,
						limit,
					),
				};
			}),
		);
		const memories: Memory[] = [];
		const sources: Array<{
			source: string;
			accountId?: string;
			count: number;
		}> = [];
		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn(
					`[MESSAGE/read_channel] recent connector read failed: ${
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason)
					}`,
				);
				continue;
			}
			memories.push(...result.value.memories);
			sources.push({
				source: result.value.connector.source,
				accountId: result.value.connector.accountId,
				count: result.value.memories.length,
			});
		}
		memories.sort(compareMemoryByCreatedAtDesc);
		const limited = limit === undefined ? memories : memories.slice(0, limit);
		return opSuccess(
			"read_channel",
			limited.length
				? `Read ${limited.length} recent messages across ${sources.length} connectors.`
				: "No recent conversations found.",
			{ sources, memories: limited },
		);
	}

	// Local-room fallback: read the channel from the agent runtime's own rooms.
	if (!channel) {
		return opFailure(
			"read_channel",
			"INVALID_PARAMETERS",
			"MESSAGE op=read_channel requires a channel parameter (channel name, ID, or room ID), or a connector that supports fetchMessages.",
		);
	}

	const room = await resolveLocalChannelRoom(runtime, source, channel);
	if (!room) {
		return opFailure(
			"read_channel",
			"CHANNEL_NOT_FOUND",
			`Could not find channel "${channel}"${source ? ` on ${source}` : ""}.`,
			{ channel, source },
		);
	}

	try {
		const queryParams: Parameters<IAgentRuntime["getMemories"]>[0] = {
			tableName: "messages",
			roomId: room.id,
			...(limit === undefined ? {} : { count: limit }),
			...(range === "dates"
				? {
						start: parseDateParam(textParam(params.from)),
						end: parseDateParam(
							textParam(params.until) ??
								textParam(params.end) ??
								textParam(params.to),
						),
					}
				: {}),
		} as Parameters<IAgentRuntime["getMemories"]>[0];

		const raw = (await runtime.getMemories(queryParams)) as Memory[];
		const memories = (
			limit === undefined ? raw : raw.slice(0, limit)
		).reverse();
		return opSuccess(
			"read_channel",
			`Read ${memories.length} messages from ${(room as Room & { name?: string }).name ?? channel}.`,
			{
				channel,
				roomId: room.id,
				messages: memories.map((m, i) => ({
					line: i + 1,
					id: m.id,
					entityId: m.entityId,
					text: m.content.text,
					createdAt: m.createdAt,
				})),
			},
		);
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		return opErrorWrap("read_channel", error);
	}
}

// ---------------------------------------------------------------------------
// op=read_with_contact — person-centric, cross-platform.
//
// Resolves a person via the relationships graph (RelationshipsService /
// graph snapshot) and aggregates their conversations from all rooms the
// person participates in, regardless of platform.
// ---------------------------------------------------------------------------

type RelationshipsPersonSummary = {
	primaryEntityId: UUID;
	memberEntityIds: UUID[];
	displayName: string;
	platforms: string[];
	aliases: string[];
};

type RelationshipsGraphSnapshot = {
	people: RelationshipsPersonSummary[];
};

type RelationshipsServiceLike = {
	getGraphSnapshot?: (query?: {
		search?: string | null;
		limit?: number;
	}) => Promise<RelationshipsGraphSnapshot>;
};

function getRelationshipsServiceLike(
	runtime: IAgentRuntime,
): RelationshipsServiceLike | null {
	const candidates: Array<RelationshipsServiceLike | null> = [
		(runtime.getService(
			"relationships_graph",
		) as RelationshipsServiceLike | null) ?? null,
		(runtime.getService("relationships") as RelationshipsServiceLike | null) ??
			null,
	];
	for (const candidate of candidates) {
		if (candidate && typeof candidate.getGraphSnapshot === "function")
			return candidate;
	}
	return null;
}

async function handleReadWithContact(
	runtime: IAgentRuntime,
	_message: Memory,
	_state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const contact = textParam(params.contact);
	const entityId = textParam(params.entityId);
	const platform = textParam(params.platform);
	const limit = requestedLimit(numberParam(params.limit));

	if (!contact && !entityId) {
		return opFailure(
			"read_with_contact",
			"INVALID_PARAMETERS",
			"MESSAGE op=read_with_contact requires either contact (person name) or entityId.",
		);
	}

	const relationships = getRelationshipsServiceLike(runtime);
	if (!relationships?.getGraphSnapshot) {
		return opFailure(
			"read_with_contact",
			"SERVICE_NOT_FOUND",
			"RelationshipsService not available — cannot resolve cross-platform conversations.",
		);
	}

	let person: RelationshipsPersonSummary | null = null;
	try {
		const snapshot = await relationships.getGraphSnapshot({
			search: (entityId ?? contact ?? "").trim(),
		});
		const candidates = snapshot.people;
		if (entityId) {
			person =
				candidates.find(
					(p) =>
						p.primaryEntityId === entityId ||
						p.memberEntityIds.includes(entityId as UUID),
				) ??
				candidates[0] ??
				null;
		} else {
			person = candidates[0] ?? null;
		}
	} catch (error) {
		// error-policy:J1 Relationship lookup failures become structured action failures.
		return opErrorWrap("read_with_contact", error);
	}

	if (!person) {
		return opFailure(
			"read_with_contact",
			"CONTACT_NOT_FOUND",
			`No contacts matching "${contact ?? entityId}" in the relationships graph.`,
		);
	}

	const entityIds = new Set<UUID>();
	entityIds.add(person.primaryEntityId);
	for (const id of person.memberEntityIds) entityIds.add(id);

	const seenRooms = new Set<string>();
	const conversations: Array<{
		platform: string;
		roomId: UUID;
		roomName: string;
		messageCount: number;
		lastMessageAt: string | null;
	}> = [];
	let totalMessages = 0;
	let scanFailures = 0;

	for (const id of entityIds) {
		try {
			const roomIds = await runtime.getRoomsForParticipant(id);
			for (const roomId of roomIds) {
				if (seenRooms.has(roomId)) continue;
				seenRooms.add(roomId);
				const room = await runtime.getRoom(roomId);
				if (!room) continue;
				const roomRecord = room as Room & { name?: string; source?: string };
				const roomPlatform = roomRecord.source;
				if (platform && roomPlatform.toLowerCase() !== platform.toLowerCase())
					continue;
				const memories = (await runtime.getMemories({
					tableName: "messages",
					roomId: room.id,
					...(limit === undefined ? {} : { count: limit }),
				} as Parameters<IAgentRuntime["getMemories"]>[0])) as Memory[];
				if (memories.length === 0) continue;
				const last = memories[0];
				conversations.push({
					platform: roomPlatform,
					roomId: room.id,
					roomName: roomRecord.name ?? `Room ${room.id}`,
					messageCount: memories.length,
					lastMessageAt: last?.createdAt
						? new Date(last.createdAt).toISOString()
						: null,
				});
				totalMessages += memories.length;
			}
		} catch (error) {
			// error-policy:J4 Other linked identities remain independently
			// searchable; expose this response as partial and report the failure.
			scanFailures++;
			logger.debug(
				`[MESSAGE/read_with_contact] room scan failed for entity ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			runtime.reportError("MESSAGE.readWithContact", error, { entityId: id });
		}
	}

	conversations.sort((a, b) => {
		if (!a.lastMessageAt && !b.lastMessageAt) return 0;
		if (!a.lastMessageAt) return 1;
		if (!b.lastMessageAt) return -1;
		return b.lastMessageAt.localeCompare(a.lastMessageAt);
	});

	return opSuccess(
		"read_with_contact",
		scanFailures > 0
			? `Partial conversations with ${person.displayName}: ${conversations.length} thread(s), ${totalMessages} messages; ${scanFailures} linked identity scan(s) failed.`
			: `Conversations with ${person.displayName}: ${conversations.length} thread(s), ${totalMessages} messages.`,
		{
			personName: person.displayName,
			primaryEntityId: person.primaryEntityId,
			conversations,
			totalMessages,
			availability: scanFailures > 0 ? "partial" : "complete",
			scanFailures,
			platforms: [...new Set(conversations.map((c) => c.platform))],
		},
	);
}

// ---------------------------------------------------------------------------
// op=search — connector passthrough OR semantic conversation search.
// ---------------------------------------------------------------------------

const SEARCH_MATCH_THRESHOLD = 0.6;

const CONVERSATION_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "conversations",
	label: "Conversations",
	description:
		"Search stored conversation messages across connected platforms.",
	contexts: ["social_posting", "documents"],
	filters: [
		{
			name: "source",
			label: "Source",
			description: 'Optional platform source, e.g. "discord" or "slack".',
			type: "string",
		},
		{
			name: "entityId",
			label: "Entity ID",
			description: "Optional participant entity ID.",
			type: "string",
		},
	],
	resultSchemaSummary:
		"Message results with line, id, roomId, entityId, text, and createdAt.",
	capabilities: ["semantic", "messages", "cross-platform"],
	source: "core:conversations",
};

function ensureConversationSearchCategory(runtime: IAgentRuntime): void {
	const registered = runtime
		.getSearchCategories({ includeDisabled: true })
		.some(
			(category) => category.category === CONVERSATION_SEARCH_CATEGORY.category,
		);
	if (!registered) {
		runtime.registerSearchCategory(CONVERSATION_SEARCH_CATEGORY);
	}
}

function conversationSearchText(
	query: string,
	count: number,
	availability: "complete" | "partial" | "unavailable",
): string {
	if (availability === "unavailable") {
		return `No disclosable conversations matching "${query}".`;
	}
	if (count === 0) {
		return `No conversations matching "${query}".`;
	}
	if (availability === "partial") {
		return `Partial search results for "${query}": ${count} messages found.`;
	}
	return `Search results for "${query}": ${count} messages found.`;
}

async function handleSearch(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const query =
		textParam(params.query) ??
		textParam(params.searchTerm) ??
		textParam(params.content);
	if (!query)
		return opFailure(
			"search",
			"INVALID_PARAMETERS",
			"MESSAGE op=search requires a query.",
		);
	const limit = requestedLimit(numberParam(params.limit));
	const source = sourceFromParams(params, message);
	const entityId = textParam(params.entityId);

	// Channel-mode: when a connector source supports searchMessages and the user
	// asked for a connector-scoped search, passthrough.
	const connectors = connectorsWithHook(runtime, "searchMessages");
	if (source && connectors.length > 0) {
		const selection = selectConnectorForOp(
			connectors,
			source,
			trustedConnectorSource(message),
			"search",
			accountIdFromParams(params, message),
		);
		if ("error" in selection) {
			// fall back to semantic search if explicit source not found
			if (!findConnectorBySource(listMessageConnectors(runtime), source)) {
				return selection.error;
			}
		} else {
			const connector = selection.connector;
			const resolved = await resolveOptionalTarget(
				connector,
				runtime,
				message,
				state,
				params,
				"search",
			);
			if (resolved.error) return resolved.error;
			const context = buildQueryContext(
				runtime,
				message,
				state,
				connector.source,
				resolved.target,
				connector,
				accountIdFromParams(params, message),
			);
			try {
				const searchMessages = connector.searchMessages;
				if (typeof searchMessages !== "function") {
					return opFailure(
						"search",
						"NOT_SUPPORTED",
						`Search is not supported for ${connector.label}.`,
					);
				}
				const memories = (await searchMessages(context, {
					query,
					target: resolved.target,
					...(limit === undefined ? {} : { limit }),
					cursor: textParam(params.cursor),
					before: textParam(params.before),
					after: textParam(params.after),
				})) as Memory[];
				return opSuccess(
					"search",
					`Found ${memories.length} messages on ${connector.label}.`,
					{ source: connector.source, query, memories, mode: "connector" },
				);
			} catch (error) {
				// error-policy:J1 Connector failures become structured action failures.
				return opErrorWrap("search", error);
			}
		}
	}

	// Conversation-mode: semantic search across stored messages.
	ensureConversationSearchCategory(runtime);
	try {
		const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: query,
		});
		const embedding = Array.isArray(embeddingResult)
			? embeddingResult
			: (embeddingResult as { embedding?: number[] })?.embedding;
		if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
			return opFailure(
				"search",
				"EMBEDDING_FAILED",
				"Failed to generate search embedding.",
			);
		}

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding,
			query,
			agentId: runtime.agentId,
			deliveryMessage: message,
			...(limit === undefined ? {} : { count: limit + 10 }),
			matchThreshold: SEARCH_MATCH_THRESHOLD,
			...(entityId ? { entityId: entityId as UUID } : {}),
			source,
		});

		const matchingResults = recall.items
			.map((item) => item.memory)
			.filter((m) => m.content.text);
		const results =
			limit === undefined ? matchingResults : matchingResults.slice(0, limit);
		return opSuccess(
			"search",
			conversationSearchText(query, results.length, recall.availability),
			{
				query,
				source,
				mode: "conversation",
				availability: recall.availability,
				withheld: recall.withheld,
				results: results.map((m, i) => ({
					line: i + 1,
					id: m.id,
					roomId: m.roomId,
					entityId: m.entityId,
					text: m.content.text,
					createdAt: m.createdAt,
				})),
			},
		);
	} catch (error) {
		// error-policy:J1 Search failures become structured action failures.
		return opErrorWrap("search", error);
	}
}

// ---------------------------------------------------------------------------
// op=list_channels / list_servers
// ---------------------------------------------------------------------------

async function handleListChannels(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = connectorsWithHook(runtime, "listRooms");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		trustedConnectorSource(message),
		"list_channels",
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const context = buildQueryContext(
		runtime,
		message,
		state,
		connector.source,
		undefined,
		connector,
		accountIdFromParams(params, message),
	);
	try {
		const listRooms = connector.listRooms;
		if (typeof listRooms !== "function") {
			return opFailure(
				"list_channels",
				"NOT_SUPPORTED",
				`Listing channels is not supported for ${connector.label}.`,
			);
		}
		const targets = await listRooms(context);
		// Muted visibility: without the flag "which channels are you muted in"
		// is unanswerable — the participant/world mute state is queryable
		// nowhere else. Flags cover the FULL set, matching the complete listing
		// rendered below.
		const mutedFlags = await resolveMutedTargetFlags(runtime, targets);
		const mutedCount = mutedFlags.filter(Boolean).length;
		return opSuccess(
			"list_channels",
			`Listed ${targets.length} channels from ${connector.label}${
				mutedCount > 0 ? ` (${mutedCount} muted)` : ""
			}.`,
			{
				source: connector.source,
				channelCount: targets.length,
				channels: targets.map((t, index) => ({
					label: t.label,
					kind: t.kind,
					target: t.target,
					muted: mutedFlags[index] === true,
				})),
			},
		);
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		return opErrorWrap("list_channels", error);
	}
}

async function handleListServers(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = connectorsWithHook(runtime, "listServers");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		trustedConnectorSource(message),
		"list_servers",
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const context = buildQueryContext(
		runtime,
		message,
		state,
		connector.source,
		undefined,
		connector,
		accountIdFromParams(params, message),
	);
	try {
		const listServers = connector.listServers;
		if (typeof listServers !== "function") {
			return opFailure(
				"list_servers",
				"NOT_SUPPORTED",
				`Listing servers is not supported for ${connector.label}.`,
			);
		}
		const servers = await listServers(context);
		// Server-level muted visibility: the world-wide mute (ROOM scope=server)
		// lives on the persisted world's metadata, which a connector listing may
		// not carry — resolve it here so "which servers are you muted in" is
		// answerable, mirroring list_channels' per-channel flag.
		const mutedFlags = await resolveMutedWorldFlags(runtime, servers);
		const mutedCount = mutedFlags.filter(Boolean).length;
		return opSuccess(
			"list_servers",
			`Listed ${servers.length} servers from ${connector.label}${
				mutedCount > 0 ? ` (${mutedCount} muted)` : ""
			}.`,
			{
				source: connector.source,
				servers: servers.map((world, index) => ({
					...world,
					muted: mutedFlags[index] === true,
				})),
			},
		);
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		return opErrorWrap("list_servers", error);
	}
}

// Cross-connector: unlike list_channels/list_servers (which pick ONE connector
// via selectConnectorForOp), this iterates EVERY connector exposing listRooms
// and reports a per-platform summary — platform + label + account + room count,
// not the rooms themselves (full room lists are list_channels' job).
async function handleListConnections(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	_params: ParamRecord,
): Promise<ActionResult> {
	const connectors = connectorsWithHook(runtime, "listRooms");

	// The framework registers each connector twice for routing: a source-only
	// fallback (no accountId) plus one entry per real account. Skip the
	// source-only fallback when the same source also has a per-account entry, so
	// a single account isn't double-counted; genuinely distinct accounts stay.
	const sourcesWithAccount = new Set(
		connectors.filter((c) => c.accountId).map((c) => c.source),
	);

	const connections: Array<{
		platform: string;
		label: string;
		accountId: string | undefined;
		// null = the count could not be resolved (see `error`) — a broken
		// connector must never read as a healthy zero-room connection.
		roomCount: number | null;
		mutedRoomCount: number | null;
		error?: string;
	}> = [];

	for (const connector of connectors) {
		if (!connector.accountId && sourcesWithAccount.has(connector.source)) {
			continue;
		}
		const context = buildQueryContext(
			runtime,
			message,
			state,
			connector.source,
			undefined,
			connector,
		);
		let roomCount: number | null = null;
		let mutedRoomCount: number | null = null;
		let listError: string | undefined;
		try {
			const targets = (await connector.listRooms?.(context)) ?? [];
			roomCount = targets.length;
			mutedRoomCount = (await resolveMutedTargetFlags(runtime, targets)).filter(
				Boolean,
			).length;
		} catch (error) {
			// error-policy:J4 one broken connector must not hide the healthy ones;
			// its entry carries an explicit error instead of a fabricated count.
			listError = error instanceof Error ? error.message : String(error);
			logger.debug(
				`[MESSAGE/list_connections] listRooms failed for ${connector.source}: ${listError}`,
			);
		}
		connections.push({
			platform: connector.source,
			label: connector.label,
			accountId: connector.accountId,
			roomCount,
			mutedRoomCount,
			...(listError === undefined ? {} : { error: listError }),
		});
	}

	const labels = connections.map((c) =>
		c.error === undefined ? c.label : `${c.label} (unavailable)`,
	);
	return opSuccess(
		"list_connections",
		`Connected via ${connections.length} connection(s): ${labels.join(", ")}.`,
		{ connections, connectionCount: connections.length },
	);
}

// ---------------------------------------------------------------------------
// op=list_worlds / list_rooms — durable, identity-cluster-scoped topology.
//
// Connector list hooks describe what a provider can currently enumerate.
// These operations answer a different question from the runtime's canonical
// stores: which worlds and rooms this verified person has actually shared with
// this agent. Cross-world topology is private continuity metadata, so even an
// ADMIN caller must arrive through a freshly revalidated owner-private room.
// ---------------------------------------------------------------------------

type AuthorizedTopology = {
	worlds: World[];
	rooms: Room[];
};

type ExplicitPage<T> = {
	items: T[];
	offset: number;
	total: number;
	nextOffset: number | null;
};

function explicitPage<T>(items: T[], params: ParamRecord): ExplicitPage<T> {
	const rawOffset = numberParam(params.offset);
	const rawLimit = numberParam(params.limit);
	const offset = Math.max(0, Math.floor(rawOffset ?? 0));
	const start = Math.min(offset, items.length);
	const end =
		rawLimit === undefined
			? items.length
			: Math.min(items.length, start + Math.max(1, Math.floor(rawLimit)));
	return {
		items: items.slice(start, end),
		offset: start,
		total: items.length,
		nextOffset: end < items.length ? end : null,
	};
}

function topologySearchText(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function matchesTopologyQuery(
	query: string,
	values: Array<string | undefined>,
): boolean {
	if (!query) return true;
	return values.some((value) => value?.toLowerCase().includes(query));
}

async function loadAuthorizedTopology(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AuthorizedTopology | ActionResult> {
	if (!message.entityId) {
		return opFailure(
			"list_worlds",
			"REQUESTER_IDENTITY_REQUIRED",
			"World and room discovery requires a verified requester identity.",
		);
	}

	const disclosure = await revalidateOwnerExclusiveDisclosure(runtime, message);
	if (
		!disclosure.allowed ||
		disclosure.basis !== OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
	) {
		return opFailure(
			"list_worlds",
			"PRIVATE_DESTINATION_REQUIRED",
			"Cross-world continuity is available only in a revalidated owner-private conversation.",
			{
				reason: disclosure.allowed
					? "invalid_disclosure_basis"
					: disclosure.reason,
			},
		);
	}

	const requesterEntityIds = await getVerifiedRelatedEntityIds(
		runtime,
		message.entityId,
	);
	const [requesterRoomLists, agentRoomIds] = await Promise.all([
		Promise.all(
			requesterEntityIds.map((entityId) =>
				runtime.getRoomsForParticipant(entityId),
			),
		),
		runtime.getRoomsForParticipant(runtime.agentId),
	]);
	const agentRooms = new Set(agentRoomIds);
	const sharedRoomIds = Array.from(new Set(requesterRoomLists.flat())).filter(
		(roomId) => agentRooms.has(roomId),
	);
	const rooms =
		sharedRoomIds.length > 0 ? await runtime.getRoomsByIds(sharedRoomIds) : [];
	const worldIds = Array.from(
		new Set(
			rooms
				.map((room) => room.worldId)
				.filter((worldId): worldId is UUID => worldId !== undefined),
		),
	);
	const worlds =
		worldIds.length > 0 ? await runtime.getWorldsByIds(worldIds) : [];
	// The topology result can now influence model text. Latch the turn so
	// streaming remains suppressed and the final delivery seam revalidates the
	// destination after this read, including while the planner is still running.
	markOwnerExclusiveDisclosureUsed(message);
	return { worlds, rooms };
}

async function handleListWorlds(
	runtime: IAgentRuntime,
	message: Memory,
	params: ParamRecord,
): Promise<ActionResult> {
	const topology = await loadAuthorizedTopology(runtime, message);
	if ("success" in topology) return topology;
	const query = topologySearchText(params.query);
	const source = topologySearchText(params.source);
	const roomsByWorld = new Map<UUID, Room[]>();
	for (const room of topology.rooms) {
		if (!room.worldId) continue;
		const existing = roomsByWorld.get(room.worldId) ?? [];
		existing.push(room);
		roomsByWorld.set(room.worldId, existing);
	}

	const matches = topology.worlds
		.map((world) => {
			const sharedRooms = roomsByWorld.get(world.id) ?? [];
			const sources = Array.from(
				new Set(sharedRooms.map((room) => room.source)),
			).sort();
			return {
				worldId: world.id,
				name: world.name ?? null,
				messageServerId: world.messageServerId ?? null,
				sources,
				sharedRoomCount: sharedRooms.length,
			};
		})
		.filter(
			(world) =>
				(!source ||
					world.sources.some(
						(candidate) => candidate.toLowerCase() === source,
					)) &&
				matchesTopologyQuery(query, [
					world.worldId,
					world.name ?? undefined,
					world.messageServerId ?? undefined,
					...world.sources,
				]),
		)
		.sort(
			(left, right) =>
				(left.name ?? left.worldId).localeCompare(
					right.name ?? right.worldId,
				) || left.worldId.localeCompare(right.worldId),
		);
	const page = explicitPage(matches, params);
	const lines = page.items.map(
		(world) =>
			`- ${world.name ?? "Unnamed world"} (worldId=${world.worldId}, sources=${world.sources.join(",") || "unknown"}, sharedRooms=${world.sharedRoomCount})`,
	);
	return opSuccess(
		"list_worlds",
		[
			`Authorized worlds: ${page.items.length} returned of ${page.total}.`,
			...lines,
			...(page.nextOffset === null
				? []
				: [`Continue with offset=${page.nextOffset}.`]),
		].join("\n"),
		{
			query: query || null,
			source: source || null,
			worlds: page.items,
			offset: page.offset,
			total: page.total,
			nextOffset: page.nextOffset,
		},
	);
}

async function handleListRooms(
	runtime: IAgentRuntime,
	message: Memory,
	params: ParamRecord,
): Promise<ActionResult> {
	const topology = await loadAuthorizedTopology(runtime, message);
	if ("success" in topology) {
		return {
			...topology,
			data: { ...(topology.data ?? {}), operation: "list_rooms" },
		};
	}
	const explicitWorldId = textParam(params.worldId);
	if (explicitWorldId && !isUuidLike(explicitWorldId)) {
		return opFailure(
			"list_rooms",
			"INVALID_WORLD_ID",
			`worldId "${explicitWorldId}" is not a valid UUID.`,
		);
	}
	const currentRoom = explicitWorldId
		? null
		: await runtime.getRoom(message.roomId);
	const worldId = (explicitWorldId as UUID | undefined) ?? currentRoom?.worldId;
	if (!worldId) {
		return opFailure(
			"list_rooms",
			"WORLD_ID_REQUIRED",
			"MESSAGE op=list_rooms requires worldId when the current room has no world.",
		);
	}
	if (!topology.worlds.some((world) => world.id === worldId)) {
		return opFailure(
			"list_rooms",
			"WORLD_NOT_AUTHORIZED",
			`World ${worldId} is not associated with the verified requester and this agent.`,
			{ worldId },
		);
	}
	const query = topologySearchText(params.query);
	const source = topologySearchText(params.source);
	const matches = topology.rooms
		.filter(
			(room) =>
				room.worldId === worldId &&
				(!source || room.source.toLowerCase() === source) &&
				matchesTopologyQuery(query, [
					room.id,
					room.name,
					room.source,
					room.channelId,
					room.serverId,
				]),
		)
		.map((room) => ({
			roomId: room.id,
			worldId,
			name: room.name ?? null,
			source: room.source,
			type: room.type,
			channelId: room.channelId ?? null,
			serverId: room.serverId ?? null,
		}))
		.sort(
			(left, right) =>
				(left.name ?? left.roomId).localeCompare(right.name ?? right.roomId) ||
				left.roomId.localeCompare(right.roomId),
		);
	const page = explicitPage(matches, params);
	const lines = page.items.map(
		(room) =>
			`- ${room.name ?? "Unnamed room"} (roomId=${room.roomId}, source=${room.source}, type=${room.type})`,
	);
	return opSuccess(
		"list_rooms",
		[
			`Authorized rooms in world ${worldId}: ${page.items.length} returned of ${page.total}.`,
			...lines,
			...(page.nextOffset === null
				? []
				: [`Continue with offset=${page.nextOffset}.`]),
		].join("\n"),
		{
			worldId,
			query: query || null,
			source: source || null,
			rooms: page.items,
			offset: page.offset,
			total: page.total,
			nextOffset: page.nextOffset,
		},
	);
}

// ---------------------------------------------------------------------------
// op=join / leave
// ---------------------------------------------------------------------------

async function handleJoinLeave(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
	op: "join" | "leave",
): Promise<ActionResult> {
	const hookName = op === "join" ? "joinHandler" : "leaveHandler";
	const connectors = connectorsWithHook(runtime, hookName);
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		trustedConnectorSource(message),
		op,
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const resolved = await resolveOptionalTarget(
		connector,
		runtime,
		message,
		state,
		params,
		op,
	);
	if (resolved.error) return resolved.error;
	const payload = {
		roomId: resolved.target?.roomId,
		channelId: resolved.target?.channelId ?? textParam(params.channelId),
		serverId: resolved.target?.serverId ?? textParam(params.serverId),
		alias: textParam(params.alias) ?? textParam(params.channel),
		invite: textParam(params.invite),
		target: resolved.target,
	};
	try {
		if (op === "join") {
			const joinHandler = connector.joinHandler;
			if (typeof joinHandler !== "function") {
				return opFailure(
					"join",
					"NOT_SUPPORTED",
					`Join is not supported for ${connector.label}.`,
				);
			}
			const room = (await joinHandler(runtime, payload)) ?? null;
			return opSuccess("join", `Joined via ${connector.label}.`, {
				source: connector.source,
				room,
			});
		}
		const leaveHandler = connector.leaveHandler;
		if (typeof leaveHandler !== "function") {
			return opFailure(
				"leave",
				"NOT_SUPPORTED",
				`Leave is not supported for ${connector.label}.`,
			);
		}
		await leaveHandler(runtime, payload);
		return opSuccess("leave", `Left via ${connector.label}.`, {
			source: connector.source,
		});
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		return opErrorWrap(op, error);
	}
}

// ---------------------------------------------------------------------------
// op=react / edit / delete / pin
// ---------------------------------------------------------------------------

async function handleMessageMutation(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
	op: "react" | "edit" | "delete" | "pin",
): Promise<ActionResult> {
	const messageId = textParam(params.messageId) ?? textParam(params.id);
	if (!messageId) {
		return opFailure(
			op,
			"INVALID_PARAMETERS",
			`MESSAGE op=${op} requires messageId.`,
		);
	}
	const hookName = (
		{
			react: "reactHandler",
			edit: "editHandler",
			delete: "deleteHandler",
			pin: "pinHandler",
		} as const
	)[op];
	const connectors = connectorsWithHook(runtime, hookName);
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		trustedConnectorSource(message),
		op,
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const resolved = await resolveOptionalTarget(
		connector,
		runtime,
		message,
		state,
		params,
		op,
	);
	if (resolved.error) return resolved.error;
	const target = resolved.target ?? {
		source: connector.source,
		accountId: connector.accountId ?? accountIdFromParams(params, message),
	};

	try {
		if (op === "react") {
			const emoji = textParam(params.emoji) ?? textParam(params.reaction);
			if (!emoji)
				return opFailure(
					"react",
					"INVALID_PARAMETERS",
					"MESSAGE op=react requires emoji.",
				);
			const reactHandler = connector.reactHandler;
			if (typeof reactHandler !== "function") {
				return opFailure(
					"react",
					"NOT_SUPPORTED",
					`React is not supported for ${connector.label}.`,
				);
			}
			await reactHandler(runtime, { target, messageId, emoji });
		} else if (op === "edit") {
			const text = textParam(params.text) ?? textParam(params.message);
			if (!text)
				return opFailure(
					"edit",
					"INVALID_PARAMETERS",
					"MESSAGE op=edit requires text.",
				);
			const editHandler = connector.editHandler;
			if (typeof editHandler !== "function") {
				return opFailure(
					"edit",
					"NOT_SUPPORTED",
					`Edit is not supported for ${connector.label}.`,
				);
			}
			const updated = await editHandler(runtime, {
				target,
				messageId,
				content: { text, source: connector.source },
			});
			if (
				updated &&
				typeof updated === "object" &&
				"id" in updated &&
				updated.id
			) {
				await runtime.updateMemory({
					...(updated as Memory),
					id: updated.id as UUID,
				});
			}
		} else if (op === "delete") {
			const deleteHandler = connector.deleteHandler;
			if (typeof deleteHandler !== "function") {
				return opFailure(
					"delete",
					"NOT_SUPPORTED",
					`Delete is not supported for ${connector.label}.`,
				);
			}
			await deleteHandler(runtime, { target, messageId });
		} else {
			const pinHandler = connector.pinHandler;
			if (typeof pinHandler !== "function") {
				return opFailure(
					"pin",
					"NOT_SUPPORTED",
					`Pin is not supported for ${connector.label}.`,
				);
			}
			await pinHandler(runtime, {
				target,
				messageId,
				pin: boolParam(params.pin) ?? true,
			});
		}
		return opSuccess(op, `MESSAGE op=${op} completed via ${connector.label}.`, {
			source: connector.source,
			messageId,
			target,
		});
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		return opErrorWrap(op, error);
	}
}

// ---------------------------------------------------------------------------
// op=manage_server
// ---------------------------------------------------------------------------

/**
 * Raw `action` strings that alias to manage_server while naming a concrete
 * management verb. Preserved as the connector operation so `action:
 * "create_channel"` works without a separate `operation` param.
 */
const MANAGE_SERVER_GENERIC_ALIASES = new Set([
	"manage_server",
	"manage_guild",
	"server_management",
	"guild_management",
]);

const MANAGE_SERVER_OPERATION_RENAMES: Record<string, string> = {
	kick_member: "kick",
	ban_member: "ban",
	unban_member: "unban",
	timeout_member: "timeout",
	edit_channel_permissions: "edit_permissions",
	apply_server_template: "apply_template",
	list_server_templates: "list_templates",
};

function manageServerOperation(params: ParamRecord): string | undefined {
	const explicit = textParam(params.operation) ?? textParam(params.op);
	if (explicit) {
		const normalized = explicit.toLowerCase().replace(/[-\s]+/g, "_");
		return MANAGE_SERVER_OPERATION_RENAMES[normalized] ?? normalized;
	}
	const raw = textParam(params.action);
	if (!raw) return undefined;
	const normalized = raw.toLowerCase().replace(/[-\s]+/g, "_");
	if (MANAGE_SERVER_GENERIC_ALIASES.has(normalized)) return undefined;
	return MANAGE_SERVER_OPERATION_RENAMES[normalized] ?? normalized;
}

/** Bounded param names forwarded verbatim to the connector. */
const MANAGE_SERVER_FORWARDED_PARAMS = [
	"channelId",
	"parentId",
	"roleId",
	"userId",
	"name",
	"topic",
	"channelType",
	"color",
	"hoist",
	"mentionable",
	"permissions",
	"allow",
	"deny",
	"overwriteId",
	"reason",
	"durationMinutes",
	"deleteMessageSeconds",
	"maxAgeSeconds",
	"maxUses",
	"unique",
	"template",
	"templateSpec",
	"variables",
	"dryRun",
] as const;

async function handleManageServer(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const op: MessageOperation = "manage_server";
	const operation = manageServerOperation(params);
	if (!operation) {
		return opFailure(
			op,
			"INVALID_PARAMETERS",
			'MESSAGE op=manage_server requires an operation (e.g. operation: "create_channel").',
		);
	}
	const connectors = connectorsWithHook(runtime, "manageServerHandler");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		trustedConnectorSource(message),
		op,
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	if (!connector.accountId) {
		return opFailure(
			op,
			"ACCOUNT_ID_REQUIRED",
			"Server management requires an explicitly account-scoped connector.",
		);
	}
	const selectedAccountId = connector.accountId;
	const handler = connector.manageServerHandler;
	const resolveDestination = connector.resolveManageServerDestination;
	if (
		typeof handler !== "function" ||
		typeof resolveDestination !== "function"
	) {
		return opFailure(
			op,
			"NOT_SUPPORTED",
			`Server management is not supported for ${connector.label}.`,
		);
	}
	const resolved = await resolveOptionalTarget(
		connector,
		runtime,
		message,
		state,
		params,
		op,
	);
	if (resolved.error) return resolved.error;
	const forwarded: Record<string, unknown> = {};
	for (const key of MANAGE_SERVER_FORWARDED_PARAMS) {
		if (params[key] !== undefined) forwarded[key] = params[key];
	}
	let serverId =
		textParam(params.serverId) ??
		textParam(params.server) ??
		textParam(params.guildId) ??
		resolved.target?.serverId;
	if (!serverId) {
		const currentRoom = await runtime.getRoom(message.roomId);
		serverId =
			currentRoom?.source === connector.source
				? currentRoom.serverId
				: undefined;
	}
	if (!serverId) {
		return opFailure(
			op,
			"SERVER_ID_REQUIRED",
			"MESSAGE op=manage_server requires an exact platform serverId or a current room with an exact persisted server binding.",
		);
	}
	try {
		const destination = await resolveDestination(runtime, {
			target: resolved.target,
			serverId,
		});
		if (
			destination.source !== connector.source ||
			destination.accountId !== selectedAccountId ||
			destination.target.accountId !== selectedAccountId
		) {
			return opFailure(
				op,
				"DESTINATION_CONNECTOR_MISMATCH",
				"The resolved server destination does not match the selected connector source and account.",
			);
		}
		const authorization = await authorizeManageServerDestination(
			runtime,
			message.entityId,
			destination,
		);
		const result = await handler(runtime, {
			target: destination.target,
			operation,
			serverId: destination.serverId,
			authorization,
			params: forwarded,
		});
		return opSuccess(op, result.summary, {
			source: connector.source,
			operation,
			...(result.data ? { receipt: result.data } : {}),
		});
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		if (error instanceof ElizaError) {
			logger.error(`[MESSAGE/${op}] ${error.message}`);
			return opFailure(
				op,
				error.code,
				`MESSAGE op=${op} failed: ${error.message}`,
			);
		}
		return opErrorWrap(op, error);
	}
}

// ---------------------------------------------------------------------------
// op=get_user
// ---------------------------------------------------------------------------

async function handleGetUser(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const userId = textParam(params.userId) ?? textParam(params.entityId);
	const username = textParam(params.username);
	const handle = textParam(params.handle) ?? textParam(params.target);
	if (!userId && !username && !handle) {
		return opFailure(
			"get_user",
			"INVALID_PARAMETERS",
			"MESSAGE op=get_user requires userId, username, handle, or target.",
		);
	}
	const connectors = connectorsWithHook(runtime, "getUser");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		trustedConnectorSource(message),
		"get_user",
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	try {
		const getUserFn = connector.getUser;
		if (typeof getUserFn !== "function") {
			return opFailure(
				"get_user",
				"NOT_SUPPORTED",
				`User lookup is not supported for ${connector.label}.`,
			);
		}
		const user = await getUserFn(runtime, {
			userId,
			username,
			handle,
		});
		return opSuccess(
			"get_user",
			user
				? `Found user on ${connector.label}.`
				: `No user found on ${connector.label}.`,
			{ source: connector.source, user },
		);
	} catch (error) {
		// error-policy:J1 Connector failures become structured action failures.
		return opErrorWrap("get_user", error);
	}
}

async function handleReadMessage(
	runtime: IAgentRuntime,
	_message: Memory,
	params: ParamRecord,
): Promise<ActionResult> {
	const sourceValue = textParam(params.source) ?? "gmail";
	if (!(ALL_MESSAGE_SOURCES as readonly string[]).includes(sourceValue)) {
		return opFailure(
			"read_message",
			"MESSAGE_READ_INVALID_SOURCE",
			`MESSAGE op=read_message does not recognize source "${sourceValue}".`,
		);
	}
	const messageId = textParam(params.messageId) ?? textParam(params.id);
	const reference = textParam(params.reference);
	if (!messageId && !reference) {
		return opFailure(
			"read_message",
			"MESSAGE_READ_MISSING_REFERENCE",
			"MESSAGE op=read_message requires messageId for the first page or reference for a continuation.",
		);
	}
	const unitValue = textParam(params.unit) ?? "byte";
	if (!(["line", "fragment", "byte"] as const).includes(unitValue as never)) {
		return opFailure(
			"read_message",
			"MESSAGE_READ_INVALID_UNIT",
			"MESSAGE op=read_message unit must be line, fragment, or byte.",
		);
	}
	try {
		const result = await getDefaultTriageService().readMessage(
			runtime,
			sourceValue as MessageSource,
			{
				messageId,
				reference,
				worldId: textParam(params.accountId),
				offset: numberParam(params.offset),
				limit: numberParam(params.limit),
				unit: unitValue as "line" | "fragment" | "byte",
				expectedRevision: textParam(params.expectedRevision),
			},
		);
		const projection = {
			readView: result.readView,
			...(result.control ? { control: result.control } : {}),
		};
		// The exact body page has one carrier. Structured projections contain
		// only source identity, integrity, range, and continuation metadata.
		return {
			success: true,
			text: result.text,
			values: { success: true },
			data: projection,
			promptData: projection,
		};
	} catch (error) {
		// error-policy:J1 Provider/auth/range failures become explicit action failures.
		return opErrorWrap("read_message", error);
	}
}

// ---------------------------------------------------------------------------
// Triage / inbox / draft delegations
// ---------------------------------------------------------------------------

const TRIAGE_OP_TO_ACTION: Record<
	Extract<
		MessageOperation,
		| "triage"
		| "list_inbox"
		| "search_inbox"
		| "draft_reply"
		| "draft_followup"
		| "respond"
		| "send_draft"
		| "schedule_draft_send"
		| "manage"
	>,
	Action
> = {
	triage: triageMessagesAction,
	list_inbox: listInboxAction,
	search_inbox: searchInboxMessagesAction,
	draft_reply: draftReplyAction,
	draft_followup: draftFollowupAction,
	respond: respondToMessageAction,
	send_draft: sendDraftAction,
	schedule_draft_send: scheduleDraftSendAction,
	manage: manageMessageAction,
};

async function delegateToTriage(
	op: keyof typeof TRIAGE_OP_TO_ACTION,
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	options: HandlerOptions | undefined,
	callback: Parameters<Action["handler"]>[4],
	responses: Parameters<Action["handler"]>[5],
): Promise<ActionResult> {
	const action = TRIAGE_OP_TO_ACTION[op];
	const actionCallback: typeof callback = callback
		? (response, actionName) => callback(response, actionName ?? action.name)
		: undefined;
	const result = await runWithActionRoutingContext(
		{ actionName: action.name, modelClass: action.modelClass },
		() =>
			action.handler(
				runtime,
				message,
				state,
				options,
				actionCallback,
				responses,
			),
	);
	const normalized: ActionResult = result ?? {
		success: true,
		text: `MESSAGE operation=${op} completed.`,
	};
	return {
		...normalized,
		data: {
			...(normalized.data ?? {}),
			actionName: "MESSAGE",
			operation: op,
			subAction: op,
		},
	};
}

// ---------------------------------------------------------------------------
// Parameters (single declarative schema)
//
// Each parameter's `subactions` list names the ops whose handler actually
// reads it (including alias fallbacks in the triage parsers). Subaction
// promotion slices on these lists so each MESSAGE_<OP> virtual exposes only
// its own parameters instead of duplicating this whole schema 23 times in the
// planner's tool payload; the MESSAGE parent always keeps the full surface.
// When adding a parameter or teaching an op a new one, keep the list in sync
// with the handler's reads.
// ---------------------------------------------------------------------------

export const MESSAGE_PARAMETERS: ActionParameter[] = [
	{
		name: "action",
		description:
			`Message action. One of: ${MESSAGE_OPS.join(", ")}. ` +
			"list_connections — every connected messaging platform/account. list_worlds — durable worlds shared by this verified requester and the agent. list_rooms — durable shared rooms in the current world or an authorized worldId.",
		required: false,
		schema: { type: "string", enum: [...MESSAGE_OPS] },
	},
	{
		name: "source",
		description:
			"Connector source: discord, slack, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail.",
		required: false,
		subactions: [
			"send",
			"read_channel",
			"search",
			"list_channels",
			"list_servers",
			"list_worlds",
			"list_rooms",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"manage_server",
			"triage",
			"list_inbox",
			"search_inbox",
			"draft_reply",
			"draft_followup",
			"respond",
			"send_draft",
			"manage",
			"read_message",
		],
		schema: { type: "string" },
	},
	{
		name: "worldId",
		description:
			"For op=list_rooms, an exact world UUID returned by list_worlds. Omit it to inspect the current room's world.",
		required: false,
		subactions: ["list_rooms"],
		schema: { type: "string" },
	},
	{
		name: "accountId",
		description: "Connector account id for multi-account messages.",
		required: false,
		subactions: [
			"send",
			"read_channel",
			"search",
			"list_channels",
			"list_servers",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"read_message",
		],
		schema: { type: "string" },
	},
	{
		name: "sources",
		description: "Inbox sources for triage, list_inbox, search_inbox.",
		required: false,
		subactions: [
			"triage",
			"list_inbox",
			"search_inbox",
			"draft_reply",
			"respond",
			"manage",
		],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "folder",
		description: "Inbox folder hint for triage/list/search/draft/respond.",
		required: false,
		subactions: [
			"triage",
			"list_inbox",
			"search_inbox",
			"draft_reply",
			"respond",
		],
		schema: { type: "string" },
	},
	{
		name: "target",
		description:
			"Loose target: user, handle, channel, room, group, server, contact, phone, email, platform ID.",
		required: false,
		subactions: [
			"send",
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "targetKind",
		description:
			"Target kind for op=send: user, contact, channel, room, thread, group, server, email, phone.",
		required: false,
		subactions: ["send"],
		schema: {
			type: "string",
			enum: [...CANONICAL_MESSAGE_TARGET_KINDS],
		},
	},
	{
		name: "channel",
		description:
			"Channel/room/group for read_channel, list_channels, join, leave.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "roomId",
		description: "Platform room or stored room ID.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
		],
		schema: { type: "string" },
	},
	{
		name: "channelId",
		description: "Platform channel ID.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"draft_followup",
			"manage_server",
		],
		schema: { type: "string" },
	},
	{
		name: "server",
		description: "Loose server/guild/workspace/team name/ref.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
		],
		schema: { type: "string" },
	},
	{
		name: "serverId",
		description: "Platform server/guild/workspace/team ID.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"manage_server",
		],
		schema: { type: "string" },
	},
	{
		name: "userId",
		description: "Platform user ID or stored entity ID.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"manage_server",
		],
		schema: { type: "string" },
	},
	{
		name: "username",
		description: "Loose username for get_user.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
		],
		schema: { type: "string" },
	},
	{
		name: "handle",
		description: "Loose platform handle for get_user.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
		],
		schema: { type: "string" },
	},
	{
		name: "contact",
		description: "Person name for op=read_with_contact.",
		required: false,
		subactions: ["read_with_contact"],
		schema: { type: "string" },
	},
	{
		name: "entityId",
		description:
			"Person/entity ID for read_with_contact, get_user, scoped search.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"read_with_contact",
			"get_user",
		],
		schema: { type: "string" },
	},
	{
		name: "platform",
		description: "Platform filter for read_with_contact/search.",
		required: false,
		subactions: [
			"send",
			"read_channel",
			"search",
			"list_channels",
			"list_servers",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"get_user",
			"read_with_contact",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "threadId",
		description: "Thread ID for threaded ops.",
		required: false,
		subactions: [
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
			"draft_followup",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "thread",
		description: "Thread parent ref for op=send.",
		required: false,
		subactions: [
			"send",
			"read_channel",
			"search",
			"join",
			"leave",
			"react",
			"edit",
			"delete",
			"pin",
		],
		schema: { type: "string" },
	},
	{
		name: "alias",
		description: "Channel/room alias for op=join or op=leave.",
		required: false,
		subactions: ["join", "leave"],
		schema: { type: "string" },
	},
	{
		name: "invite",
		description: "Invite URL or token for op=join.",
		required: false,
		subactions: ["join"],
		schema: { type: "string" },
	},
	{
		name: "message",
		description: "Message text for op=send; replacement for op=edit.",
		required: false,
		subactions: [
			"send",
			"edit",
			"draft_reply",
			"respond",
			"draft_followup",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "text",
		description: "Replacement text for op=edit (alias of message).",
		required: false,
		subactions: [
			"send",
			"edit",
			"draft_reply",
			"respond",
			"draft_followup",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "query",
		description:
			"Search term for op=search, search_inbox, list_worlds, or list_rooms.",
		required: false,
		subactions: [
			"search",
			"search_inbox",
			"draft_reply",
			"respond",
			"manage",
			"list_worlds",
			"list_rooms",
		],
		schema: { type: "string" },
	},
	{
		name: "content",
		description: "Inbox search text or lookup hint for triage/draft/respond.",
		required: false,
		subactions: [
			"search",
			"search_inbox",
			"draft_reply",
			"respond",
			"manage",
			"send_draft",
		],
		schema: { type: "string" },
	},
	{
		name: "sender",
		description: "Sender identifier for inbox search or reply lookup.",
		required: false,
		subactions: ["search_inbox", "draft_reply", "respond", "manage"],
		schema: { type: "string" },
	},
	{
		name: "body",
		description:
			"Draft/response body for draft_reply, draft_followup, respond.",
		required: false,
		subactions: ["draft_reply", "draft_followup", "respond", "send_draft"],
		schema: { type: "string" },
	},
	{
		name: "reply",
		description: "Alias for body for draft/respond.",
		required: false,
		subactions: ["draft_reply", "respond"],
		schema: { type: "string" },
	},
	{
		name: "replyText",
		description: "Alias for body for draft/respond.",
		required: false,
		subactions: ["draft_reply", "respond"],
		schema: { type: "string" },
	},
	{
		name: "messageBody",
		description: "Alias for body for draft/respond.",
		required: false,
		subactions: ["draft_reply", "respond"],
		schema: { type: "string" },
	},
	{
		name: "to",
		description: "Recipient identifiers for op=draft_followup.",
		required: false,
		subactions: ["read_channel", "draft_followup", "send_draft"],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "subject",
		description: "Subject for email-like sends and draft operations.",
		required: false,
		subactions: ["send", "draft_followup", "send_draft"],
		schema: { type: "string" },
	},
	{
		name: "draftId",
		description: "Draft ID for send_draft or schedule_draft_send.",
		required: false,
		subactions: ["send_draft", "schedule_draft_send"],
		schema: { type: "string" },
	},
	{
		name: "confirmed",
		description: "Explicit send confirmation for op=send_draft.",
		required: false,
		subactions: ["send_draft"],
		schema: { type: "boolean" },
	},
	{
		name: "sendAt",
		description: "Scheduled send time for op=schedule_draft_send.",
		required: false,
		subactions: ["schedule_draft_send"],
		schema: { type: "string" },
	},
	{
		name: "messageId",
		description:
			"Platform/full message ID or stored memory ID for read_channel/react/edit/delete/pin/respond. With read_channel, returns an exact byte page of that stored message.",
		required: false,
		subactions: [
			"read_channel",
			"react",
			"edit",
			"delete",
			"pin",
			"draft_reply",
			"respond",
			"manage",
			"read_message",
		],
		schema: { type: "string" },
	},
	{
		name: "inReplyToId",
		description: "Alias for messageId for draft/respond.",
		required: false,
		subactions: ["draft_reply", "respond"],
		schema: { type: "string" },
	},
	{
		name: "id",
		description: "Alias for messageId.",
		required: false,
		subactions: [
			"read_channel",
			"react",
			"edit",
			"delete",
			"pin",
			"draft_reply",
			"respond",
			"manage",
			"send_draft",
			"schedule_draft_send",
			"read_message",
		],
		schema: { type: "string" },
	},
	{
		name: "reference",
		description:
			"Opaque continuation reference returned by read_message or a stored read_channel page.",
		required: false,
		subactions: ["read_channel", "read_message"],
		schema: { type: "string" },
	},
	{
		name: "offset",
		description:
			"Zero-based range offset for read_message/list_worlds/list_rooms, or UTF-8 byte offset for read_channel with a stored messageId.",
		required: false,
		subactions: ["read_channel", "read_message", "list_worlds", "list_rooms"],
		schema: { type: "number", minimum: 0 },
	},
	{
		name: "unit",
		description: "Paging unit for read_message; byte is the bounded default.",
		required: false,
		subactions: ["read_message"],
		schema: { type: "string", enum: ["line", "fragment", "byte"] },
	},
	{
		name: "expectedRevision",
		description:
			"Revision returned by the preceding read_message or stored read_channel page.",
		required: false,
		subactions: ["read_channel", "read_message"],
		schema: { type: "string" },
	},
	{
		name: "emoji",
		description: "Reaction value for op=react.",
		required: false,
		subactions: ["react"],
		schema: { type: "string" },
	},
	{
		name: "pin",
		description: "Pin state for op=pin (false to unpin when supported).",
		required: false,
		subactions: ["pin"],
		schema: { type: "boolean" },
	},
	{
		name: "manageOperation",
		description:
			"op=manage operation: archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, unsubscribe.",
		required: false,
		subactions: ["manage"],
		schema: { type: "string", enum: [...MANAGE_OPERATION_KINDS] },
	},
	{
		name: "label",
		description: "Label for op=manage label_add/label_remove.",
		required: false,
		subactions: ["manage"],
		schema: { type: "string" },
	},
	{
		name: "tag",
		description: "Tag for op=manage tag_add/tag_remove.",
		required: false,
		subactions: ["manage"],
		schema: { type: "string" },
	},
	{
		name: "attachments",
		description: "Attachments for op=send.",
		required: false,
		subactions: ["send"],
		schema: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					url: { type: "string" },
					title: { type: "string" },
					source: { type: "string" },
					description: { type: "string" },
					contentType: { type: "string" },
				},
			},
		},
	},
	{
		name: "urgency",
		description: "Urgency for op=send: normal, important, urgent.",
		required: false,
		subactions: ["send"],
		schema: { type: "string", enum: ["normal", "important", "urgent"] },
	},
	{
		name: "persist",
		description:
			"op=send persists outbound content to room memory. Default true.",
		required: false,
		subactions: ["send"],
		schema: { type: "boolean" },
	},
	{
		name: "limit",
		description: "Max items.",
		required: false,
		subactions: [
			"read_channel",
			"read_with_contact",
			"search",
			"triage",
			"list_inbox",
			"search_inbox",
			"read_message",
			"list_worlds",
			"list_rooms",
		],
		schema: { type: "number" },
	},
	{
		name: "range",
		description: 'For op=read_channel: "recent" (default) or "dates".',
		required: false,
		subactions: ["read_channel"],
		schema: { type: "string", enum: ["recent", "dates"] },
	},
	{
		name: "from",
		description: "Start date/timestamp for op=read_channel range=dates.",
		required: false,
		subactions: ["read_channel", "draft_reply", "respond", "manage"],
		schema: { type: "string" },
	},
	{
		name: "worldIds",
		description: "Account/server scopes for inbox ops.",
		required: false,
		subactions: ["triage", "list_inbox", "search_inbox"],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "channelIds",
		description: "Channel/conversation scopes for inbox ops.",
		required: false,
		subactions: ["triage", "list_inbox", "search_inbox"],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "sinceMs",
		description: "Start timestamp (ms) for inbox list/search/triage.",
		required: false,
		subactions: ["triage", "list_inbox", "search_inbox"],
		schema: { type: "number" },
	},
	{
		name: "since",
		description: "Start date for op=search_inbox.",
		required: false,
		subactions: ["search_inbox"],
		schema: { type: "string" },
	},
	{
		name: "until",
		description:
			"End date/timestamp for read_channel range=dates or search_inbox.",
		required: false,
		subactions: ["read_channel", "search_inbox"],
		schema: { type: "string" },
	},
	{
		name: "cursor",
		description: "Opaque pagination cursor.",
		required: false,
		subactions: ["read_channel", "search"],
		schema: { type: "string" },
	},
	{
		name: "before",
		description: "Older boundary for read/search results.",
		required: false,
		subactions: ["read_channel", "search"],
		schema: { type: "string" },
	},
	{
		name: "after",
		description: "Newer boundary for read/search results.",
		required: false,
		subactions: ["read_channel", "search"],
		schema: { type: "string" },
	},
	{
		name: "operation",
		description:
			"Server-management verb for op=manage_server: create_category, create_channel, edit_channel, delete_channel, create_role, edit_role, delete_role, edit_permissions, assign_role, remove_role, create_invite, kick, ban, unban, timeout, list_templates, apply_template. Connector configuration gates every write (fail closed).",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "name",
		description:
			"Name for created/edited channels, categories, and roles (manage_server).",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "topic",
		description: "Channel topic for manage_server create/edit channel.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "channelType",
		description:
			"Channel type for manage_server create_channel: text, voice, announcement, forum, stage.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "parentId",
		description:
			"Parent category channel id for manage_server create/edit channel.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "roleId",
		description:
			"Role id for manage_server edit_role, delete_role, assign_role, remove_role.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "permissions",
		description:
			"Named permission list for manage_server create_role/edit_role (Administrator is always rejected).",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "allow",
		description:
			"Permissions to allow in a manage_server edit_permissions overwrite.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "deny",
		description:
			"Permissions to deny in a manage_server edit_permissions overwrite.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "overwriteId",
		description:
			'Overwrite subject for manage_server edit_permissions: a role id, user id, or "@everyone".',
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "template",
		description:
			"Registered template id for manage_server apply_template (see list_templates).",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
	{
		name: "dryRun",
		description:
			"For manage_server: report the plan (would_create/would_update) without writing.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "boolean" },
	},
	{
		name: "reason",
		description: "Audit-log reason for manage_server writes.",
		required: false,
		subactions: ["manage_server"],
		schema: { type: "string" },
	},
];

// ---------------------------------------------------------------------------
// Action surface
// ---------------------------------------------------------------------------

const spec = getActionSpec("MESSAGE");

function refreshDescriptions(action: Action, runtime: IAgentRuntime): void {
	refreshMessageConnectorActionDescription(action, runtime, {
		baseDescription: MESSAGE_DESCRIPTION,
		baseCompressed: MESSAGE_COMPRESSED,
	});
}

function createdAtSortKey(memory: { createdAt?: number }): number {
	const value = memory.createdAt;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compareMemoryByCreatedAtDesc(
	a: { createdAt?: number; id?: string },
	b: { createdAt?: number; id?: string },
): number {
	const aSafe = createdAtSortKey(a);
	const bSafe = createdAtSortKey(b);
	if (bSafe !== aSafe) return bSafe - aSafe;
	return String(b.id ?? "").localeCompare(String(a.id ?? ""));
}

export const __testCompareMemoryByCreatedAtDesc = compareMemoryByCreatedAtDesc;
export const __testCreatedAtSortKey = createdAtSortKey;

export const messageAction: Action = {
	name: "MESSAGE",
	similes: [
		"DM",
		"DIRECT_MESSAGE",
		"CHAT",
		"CHANNEL",
		// PRD action-catalog aliases. These resolve to MESSAGE subactions via
		// handler argument routing; see packages/docs/action-prd-map.md.
		"INBOX_LIST_UNREAD",
		"INBOX_TRIAGE_PRIORITY",
		"INBOX_SUMMARIZE_CHANNEL",
		"MESSAGE_DRAFT_REPLY",
		"MESSAGE_SEND_APPROVAL_REQUEST",
		"MESSAGE_SEND_CONFIRMED",
		"MESSAGE_ARCHIVE_OR_DEFER",
		"MESSAGE_REPAIR_AFTER_MISS",
		"FOLLOWUP_CREATE_DRAFT",
		"FOLLOWUP_SEND_CONFIRMED",
	],
	tags: [
		"domain:messages",
		"capability:read",
		"capability:write",
		"capability:update",
		"capability:delete",
		"capability:send",
		"capability:schedule",
		"surface:remote-api",
		"risk:irreversible",
	],
	description: MESSAGE_DESCRIPTION,
	descriptionCompressed: MESSAGE_COMPRESSED,
	routingHint:
		"send/read/search/triage messages on a connector or channel, discover authorized worlds/rooms, or manage the inbox/drafts -> MESSAGE; do NOT use to reply in the CURRENT chat/thread -> REPLY, to join/mute/follow a channel -> ROOM, or to publish to a public feed/timeline -> POST",
	contexts: MESSAGE_CONTEXTS,
	roleGate: { minRole: "ADMIN" },
	parameters: MESSAGE_PARAMETERS,
	examples: (spec?.examples ?? []) as ActionExample[][],
	validate: async (runtime, message, state, options) => {
		refreshDescriptions(messageAction, runtime);
		const explicitOp = inferOp(paramsFromOptions(options));
		if (explicitOp === "list_worlds" || explicitOp === "list_rooms") {
			// Scenario and API callers may invoke an explicit topology read without
			// a model-composed routing state. The handlers still revalidate the
			// owner-private audience and authorized room intersection themselves.
			return true;
		}
		return hasActionContext(message, state, {
			contexts: MESSAGE_CONTEXTS,
		});
	},
	handler: async (runtime, message, state, options, callback, responses) => {
		refreshDescriptions(messageAction, runtime);
		const params = paramsFromOptions(options);
		const op = inferOp(params);
		switch (op) {
			case "send":
				return handleSend(runtime, message, state, params);
			case "read_channel":
				return handleReadChannel(runtime, message, state, params);
			case "read_with_contact":
				return handleReadWithContact(runtime, message, state, params);
			case "read_message":
				return handleReadMessage(runtime, message, params);
			case "search":
				return handleSearch(runtime, message, state, params);
			case "list_channels":
				return handleListChannels(runtime, message, state, params);
			case "list_servers":
				return handleListServers(runtime, message, state, params);
			case "list_connections":
				return handleListConnections(runtime, message, state, params);
			case "list_worlds":
				return handleListWorlds(runtime, message, params);
			case "list_rooms":
				return handleListRooms(runtime, message, params);
			case "join":
			case "leave":
				return handleJoinLeave(runtime, message, state, params, op);
			case "react":
			case "edit":
			case "delete":
			case "pin":
				return handleMessageMutation(runtime, message, state, params, op);
			case "get_user":
				return handleGetUser(runtime, message, state, params);
			case "manage_server":
				return handleManageServer(runtime, message, state, params);
			case "triage":
			case "list_inbox":
			case "search_inbox":
			case "draft_reply":
			case "draft_followup":
			case "respond":
			case "send_draft":
			case "schedule_draft_send":
			case "manage":
				return delegateToTriage(
					op,
					runtime,
					message,
					state,
					options,
					callback,
					responses,
				);
			default: {
				const unreachable: never = op;
				return invalidOpResult(
					unreachable as MessageOperation,
					`MESSAGE received unknown operation "${String(unreachable)}".`,
				);
			}
		}
	},
};

export default messageAction;
