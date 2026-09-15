/**
 * Unified action for discovering, opening, managing, and authoring plugin-contributed views.
 * Sub-modes share owner checks, view resolution, and client boundaries while
 * keeping the planner surface to one action.
 */

import path from "node:path";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	RoleGateRole,
	State,
	ViewCapability,
	ViewCapabilityParameter,
	ViewType,
} from "@elizaos/core";
import {
	checkSenderRole,
	hasOwnerAccess as defaultOwnerAccessFn,
	logger,
	satisfiesRoleGate,
	testSchemaPattern,
} from "@elizaos/core";
import {
	AGENT_SURFACE_CAPABILITY_IDS,
	STANDARD_CAPABILITIES,
} from "@elizaos/shared";
import { getAppControlApiBase } from "../loopback-api.js";
import {
	describeTargetReference,
	normalizeActionOptions,
	readStringOption,
	targetReferenceLogView,
	userRequestMessageText,
} from "../params.js";
import {
	type NavigationReceipt,
	navigationDispatchBlock,
	navigationRequestSignal,
} from "./navigation-execution.js";
import { matchViewCommand } from "./view-command-matcher.js";
import { readViewInteractionClientId } from "./view-delivery.js";
import {
	createViewsClient,
	parseViewInteractionResponse,
	readViewInteractionEffectContract,
	readViewInteractionReceipt,
	type ViewSummary,
	type ViewsClient,
} from "./views-client.js";
import {
	hasPendingViewsCreateIntent,
	isChoiceReply,
	runViewsCreate,
} from "./views-create.js";
import {
	hasPendingDeleteConfirm,
	isDeleteCancellation,
	isDeleteConfirmation,
	readDeleteConfirmationOption,
	runViewsDelete,
} from "./views-delete.js";
import { runViewsEdit } from "./views-edit.js";
import { isViewIconRequest, runViewsIcon } from "./views-icon.js";
import { runViewsList } from "./views-list.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";
import { isRollbackRequest, runViewsRollback } from "./views-rollback.js";
import { runViewsSearch, scoreView } from "./views-search.js";
import { resolveIntentView, runViewsShow } from "./views-show.js";

export type ViewsMode =
	| "list"
	| "current"
	| "show"
	| "open"
	| "close"
	| "search"
	| "manager"
	| "broadcast"
	| "interact"
	| "create"
	| "edit"
	| "icon"
	| "rollback"
	| "delete"
	| "remove"
	| "pin"
	| "window"
	| "split"
	| "tile";

async function resolveViewCallerRoles(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<readonly RoleGateRole[]> {
	if (message.entityId === runtime.agentId) return ["OWNER"];
	const resolved = await checkSenderRole(runtime, message);
	return resolved?.role ? [resolved.role] : [];
}

// Connectors that deliver the agent's turn over an EXTERNAL chat surface which
// does NOT render Eliza desktop views to the person who sent the message. On
// these, a VIEWS navigation/layout op (show/open/close/split/…) is invisible to
// the asker: it only drives the local desktop shell. If VIEWS is then chosen as
// the turn's terminal action, the chat user gets no reply at all (#8613). We
// exclude the desktop-only modes from the planner surface for these sources so
// the turn falls back to a real text REPLY the connector reliably delivers.
// Text-producing modes (list/current/search), capability/content ops (interact)
// and owner authoring ops (create/edit/icon/delete) stay available everywhere.
// Local view-capable surfaces (dashboard / desktop / mobile app chat, identified
// by sources like "chat"/"user_chat"/"app" or no source) are intentionally NOT
// listed, so their view-switching UX is unchanged. This is a fail-open denylist:
// an unknown source keeps today's behavior.
const VIEWLESS_TEXT_CONNECTOR_SOURCES = new Set([
	"discord",
	"telegram",
	"matrix",
	"slack",
	"whatsapp",
	"twitter",
	"x",
	"instagram",
	"imessage",
	"bluebubbles",
	"line",
	"wechat",
	"nostr",
	"feishu",
	"google-chat",
	"farcaster",
]);

// VIEWS modes whose ONLY effect is a desktop UI navigation/layout change with no
// inherent text answer. Invisible (and so a silent non-answer) on a connector
// that can't surface views to the asker — see VIEWLESS_TEXT_CONNECTOR_SOURCES.
const DESKTOP_ONLY_VIEW_MODES = new Set<ViewsMode>([
	"show",
	"open",
	"close",
	"manager",
	"broadcast",
	"pin",
	"window",
	"split",
	"tile",
]);

// The synthetic source stamped on a sub-agent completion relay
// (SUB_AGENT_SOURCE / ACPX_ROUTER_SOURCE in plugin-agent-orchestrator). The
// relay also sets metadata.subAgent and preserves the true origin connector on
// metadata.originSource — this mirrors that plugin's own relay-detection.
// app-control must not import orchestrator internals, so this constant is kept
// local and points at the orchestrator's owning constant.
const SUB_AGENT_RELAY_SOURCE = "sub_agent";
function lowerSource(source: unknown): string {
	return typeof source === "string" ? source.toLowerCase() : "";
}

function readContentMetadata(message: Memory): Record<string, unknown> {
	const metadata = (message.content as { metadata?: unknown } | undefined)
		?.metadata;
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
}

/**
 * True when this message is a synthetic sub-agent completion relay rather than a
 * live inbound from a real chat surface. A relay only delivers a sub-agent's
 * result back to the connector the request came in on; it is not itself a chat
 * surface, so its `content.source` ("sub_agent") is not where the reply lands.
 */
function isSubAgentRelay(message: Memory): boolean {
	return (
		lowerSource(message.content?.source) === SUB_AGENT_RELAY_SOURCE ||
		readContentMetadata(message).subAgent === true
	);
}

/**
 * The connector this turn ultimately surfaces to. For a normal inbound that is
 * `content.source`. For a sub-agent relay, `content.source` is the synthetic
 * "sub_agent" marker, so we read the preserved origin connector from
 * `metadata.originSource` — the surface the result is actually delivered to
 * (e.g. Discord for a Discord-triggered build, or the in-app dashboard for an
 * app-triggered one). Empty string when it can't be determined.
 */
function effectiveDeliverySource(message: Memory): string {
	return isSubAgentRelay(message)
		? lowerSource(readContentMetadata(message).originSource)
		: lowerSource(message.content?.source);
}

/**
 * True when the turn surfaces to an external text connector with no Eliza view
 * surface for the recipient. Keeps desktop-only VIEWS modes off the planner so
 * such a turn never resolves to a silent view navigation with no chat reply
 * (#8613). It resolves the EFFECTIVE delivery surface, so a sub-agent build
 * relay is judged by where it actually lands: a Discord-triggered relay is
 * viewless (desktop modes excluded), while an app-triggered one keeps them.
 * A relay whose origin connector wasn't captured has no confirmed view surface,
 * so it is treated as viewless too — a relay must not navigate UI into the void.
 */
export function messageHasNoViewSurface(message: Memory): boolean {
	const source = effectiveDeliverySource(message);
	if (VIEWLESS_TEXT_CONNECTOR_SOURCES.has(source)) return true;
	return source === "" && isSubAgentRelay(message);
}

const MODES: readonly ViewsMode[] = [
	"list",
	"current",
	"show",
	"open",
	"close",
	"search",
	"manager",
	"broadcast",
	"interact",
	"create",
	"edit",
	"icon",
	"rollback",
	"delete",
	"remove",
	"pin",
	"window",
	"split",
	"tile",
] as const;

// NOTE: a declared context is also turned into KEYWORD-RETRIEVAL terms by the
// action catalog, so listing a live-data domain here (web/crypto/finance/...)
// makes VIEWS retrievable by that domain's keywords ("price", "current",
// "latest", "news") and hijacks live-info turns away from WEB_FETCH. VIEWS only
// *displays panels* — it does not fetch live data — so the pure lookup/
// live-data contexts (research, web, browser, finance, payments, crypto) are
// intentionally omitted. Keep only contexts that map to an actual navigable
// view/app surface.
const VIEW_ACTION_CONTEXTS = [
	"simple",
	"general",
	"memory",
	"documents",
	"knowledge",
	"code",
	"files",
	"terminal",
	"email",
	"notes",
	"calendar",
	"contacts",
	"tasks",
	"todos",
	"productivity",
	"health",
	"screen_time",
	"subscriptions",
	"wallet",
	"messaging",
	"phone",
	"social",
	"social_posting",
	"media",
	"automation",
	"connectors",
	"settings",
	"character",
	"secrets",
	"admin",
	"state",
	"world",
	"game",
] as const;

// Intent regexes — order matters: more specific first.
const LIST_VERBS =
	/\b(list|show all|what views|all views|available views|which views)\b/i;
// NB: "open" is deliberately excluded here — "open <name> view" is a navigate
// (show) intent, not a "report the currently-open view" query. Phrasings like
// "which view is currently open" still match via the "current" keyword.
const CURRENT_VIEW_VERBS =
	/\b(current|active|selected)\b.{0,30}\bview\b|\bwhat(?:'s| is)?\b.{0,20}\bview\b/i;
const WHAT_VIEWS_VERB = /what.{0,20}views?\b/i;
const SEARCH_VERBS = /\b(search|find|look for|filter)\b.*\bview/i;
const MANAGER_VERBS =
	/\b(view manager|views manager|manage views|open manager|show manager)\b/i;
const SHOW_ALL_VIEWS_MANAGER =
	/\b(show|open|bring up|pull up)\b\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?views\b/i;
const SHOW_APPS_VERBS =
	/\b(show|open|go to|navigate to)\b\s+(?:the\s+)?(?:apps?|app page|apps page)\b/i;
const CLOSE_VERBS =
	/\b(close|dismiss|hide|exit|quit)\b.{0,40}\b(view|app|panel|window)\b/i;
const CLOSE_ALL_VERBS =
	/\b(close|dismiss|hide|exit|quit)\b.{0,30}\ball\b.{0,30}\b(views?|apps?|panels?|windows?|tabs?)\b/i;
const CLOSE_PREFIX_VERBS = /^\s*(close|dismiss|hide|exit|quit)\b/i;
const SHOW_VERBS =
	/\b(show|open|navigate to|go to|switch to|launch|display|bring up|pull up)\b/i;
const VIEW_NOUN = /\bview[s]?\b/i;
const BROADCAST_VERBS =
	/\b(tell|notify|signal|broadcast|send.*event|emit|trigger|ping)\b.{0,60}\bview\b/i;
const INTERACT_VERBS =
	/\b(click|tap|press|focus|fill|interact|invoke|call|use capability)\b.{0,60}\b(view|button|input|field)\b/i;
const CREATE_VERBS =
	/\b(create|build|make|new|scaffold|generate|spin up)\b.{0,30}\b(view|plugin)\b/i;
const EDIT_VERBS_RE =
	/\b(edit|update|modify|change|fix|improve|rewrite)\b.{0,30}\b(view|plugin)\b/i;
const DELETE_VERBS_RE =
	/\b(delete|remove|uninstall|destroy|drop)\b.{0,30}\b(view|plugin)\b/i;
const PIN_VERBS =
	/\b(pin|pin as tab|add.*tab|pin.*desktop|keep.*tab|dock)\b.{0,40}\bview\b/i;
const WINDOW_VERBS =
	/\b(open in.*window|new window|separate window|pop.?out|detach)\b.{0,40}\bview\b|\bview\b.{0,40}\b(new window|separate window|pop.?out|detach)\b/i;
const SPLIT_VERBS =
	/\b(split|side.?by.?side|next to|beside|alongside|left|right|top|bottom)\b.{0,80}\b(views?|apps?|panels?|windows?|tabs?)\b|\b(views?|apps?|panels?|windows?|tabs?)\b.{0,80}\b(split|side.?by.?side|next to|beside|alongside|left|right|top|bottom)\b/i;
const TILE_VERBS =
	/\b(tile|grid|arrange|layout)\b.{0,80}\b(views?|apps?|panels?|windows?|tabs?)\b|\b(views?|apps?|panels?|windows?|tabs?)\b.{0,80}\b(tile|grid|arrange|layout)\b/i;
const LAYOUT_OVERRIDE_MODES = new Set([
	"create",
	"delete",
	"edit",
	"list",
	"open",
	"remove",
	"show",
]);
const VIEW_SURFACE_TOKENS = new Set([
	"app",
	"apps",
	"desktop",
	"manager",
	"panel",
	"panels",
	"screen",
	"screens",
	"tab",
	"tabs",
	"ui",
	"view",
	"views",
	"window",
	"windows",
]);
const USER_REQUEST_OPEN_TAG = "<user_request>";
const USER_REQUEST_CLOSE_TAG = "</user_request>";

function extractUserRequestText(text: string): string | null {
	const start = text.lastIndexOf(USER_REQUEST_OPEN_TAG);
	if (start < 0) return null;
	const contentStart = start + USER_REQUEST_OPEN_TAG.length;
	const end = text.indexOf(USER_REQUEST_CLOSE_TAG, contentStart);
	if (end < 0) return null;
	const value = text.slice(contentStart, end).trim();
	return value.length > 0 ? value : null;
}

function viewRequestText(text: string): string {
	return extractUserRequestText(text) ?? text;
}

function readViewTypeOption(
	text: string,
	options?: Record<string, unknown>,
): ViewType | undefined {
	const requestText = viewRequestText(text);
	const explicit =
		readStringOption(options, "viewType") ??
		readStringOption(options, "type") ??
		readStringOption(options, "surface");
	const normalized = explicit?.trim().toLowerCase();
	if (normalized === "gui" || normalized === "graphical") return "gui";
	if (normalized === "tui" || normalized === "terminal") return "tui";
	if (
		normalized === "xr" ||
		normalized === "spatial" ||
		normalized === "immersive"
	)
		return "xr";

	if (/\b(tui|terminal)\b/i.test(requestText)) return "tui";
	if (/\b(xr|spatial|immersive)\b/i.test(requestText)) return "xr";
	if (/\b(gui|graphical)\b/i.test(requestText)) return "gui";
	return undefined;
}

function readExplicitViewTypeOption(
	options?: Record<string, unknown>,
): ViewType | undefined {
	const normalized = readStringOption(options, "viewType")
		?.trim()
		.toLowerCase();
	if (normalized === "gui" || normalized === "graphical") return "gui";
	if (normalized === "tui" || normalized === "terminal") return "tui";
	if (
		normalized === "xr" ||
		normalized === "spatial" ||
		normalized === "immersive"
	)
		return "xr";
	return undefined;
}

function readBooleanOption(
	options: Record<string, unknown> | undefined,
	key: string,
): boolean {
	if (!options) return false;
	const value = options[key];
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	return /^(1|true|yes|on)$/i.test(value.trim());
}

async function resolveViewTypeForId(
	client: ViewsClient,
	viewId: string,
	explicitViewType?: ViewType,
): Promise<ViewType | undefined> {
	if (explicitViewType) return explicitViewType;
	const views = await client.listViews();
	return views.find((view) => view.id === viewId)?.viewType;
}

type OwnerAccessFn = (
	runtime: IAgentRuntime,
	message: Memory,
) => Promise<boolean>;

interface ViewsActionDeps {
	client?: ViewsClient;
	hasOwnerAccess?: OwnerAccessFn;
	repoRoot?: string;
}

function defaultRepoRoot(): string {
	const fromEnv =
		process.env.ELIZA_REPO_ROOT?.trim() ||
		process.env.ELIZA_WORKSPACE_DIR?.trim();
	if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
	return process.cwd();
}

function inferMode(
	text: string,
	options?: Record<string, unknown>,
): ViewsMode | null {
	const explicit =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const trimmed = viewRequestText(text).trim();
	const normalizedExplicit = explicit?.trim().toLowerCase().replace(/-/g, "_");
	// A planner read must stay a read even when the user asks to keep a split,
	// window, or pinned surface visible while querying its current state.
	if (
		normalizedExplicit === "list" ||
		normalizedExplicit === "current" ||
		normalizedExplicit === "search"
	) {
		return normalizedExplicit;
	}
	// The planner owns explicit navigation. Incidental words such as "right
	// now" must not turn a show call into a split layout or another operation.
	if (normalizedExplicit === "show" || normalizedExplicit === "open") {
		return normalizedExplicit;
	}
	// An explicit request to (re)generate a view's icon/image wins over the
	// generic edit/create/update verbs that share its phrasing — regenerating an
	// icon is a direct asset write, not a coding-agent edit.
	if (
		isViewIconRequest(trimmed, options) &&
		(!normalizedExplicit ||
			normalizedExplicit === "icon" ||
			normalizedExplicit === "edit" ||
			normalizedExplicit === "create" ||
			normalizedExplicit === "update" ||
			normalizedExplicit === "modify" ||
			normalizedExplicit === "change")
	) {
		return "icon";
	}
	if (
		normalizedExplicit === "close" ||
		normalizedExplicit === "close_view" ||
		normalizedExplicit === "close_all" ||
		normalizedExplicit === "close_all_views"
	) {
		return "close";
	}
	if (
		normalizedExplicit === "split" ||
		normalizedExplicit === "split_view" ||
		normalizedExplicit === "split_views"
	) {
		if (isTileLayoutRequest(trimmed) && !isSplitLayoutRequest(trimmed)) {
			return "tile";
		}
		return "split";
	}
	if (
		(normalizedExplicit === "tile" ||
			normalizedExplicit === "tile_view" ||
			normalizedExplicit === "tile_views") &&
		isSplitLayoutRequest(trimmed) &&
		!isTileLayoutRequest(trimmed)
	) {
		return "split";
	}
	if (
		normalizedExplicit === "tile" ||
		normalizedExplicit === "tile_view" ||
		normalizedExplicit === "tile_views"
	) {
		return "tile";
	}
	if (isNonDestructiveCloseRequest(trimmed)) {
		return "close";
	}
	if (
		(normalizedExplicit === "delete" || normalizedExplicit === "remove") &&
		isNonDestructiveCloseRequest(trimmed) &&
		!DELETE_VERBS_RE.test(trimmed)
	) {
		return "close";
	}
	if (normalizedExplicit && isGenericViewNavigationMode(normalizedExplicit)) {
		if (isPinRequest(trimmed)) return "pin";
		if (isWindowRequest(trimmed)) return "window";
		if (isTileLayoutRequest(trimmed)) return "tile";
		if (isSplitLayoutRequest(trimmed)) return "split";
	}
	// Explicit rollback aliases. Handled before the generic non-mode -> interact
	// fallthrough so `action=revert`/`action=undo` resolve to the rollback handler.
	if (
		normalizedExplicit === "rollback" ||
		normalizedExplicit === "roll_back" ||
		normalizedExplicit === "revert" ||
		normalizedExplicit === "undo" ||
		normalizedExplicit === "restore"
	) {
		return "rollback";
	}
	if (
		normalizedExplicit &&
		!(MODES as readonly string[]).includes(normalizedExplicit)
	) {
		return "interact";
	}
	if (
		normalizedExplicit &&
		(MODES as readonly string[]).includes(normalizedExplicit)
	) {
		if (LAYOUT_OVERRIDE_MODES.has(normalizedExplicit)) {
			if (isPinRequest(trimmed)) return "pin";
			if (isWindowRequest(trimmed)) return "window";
			if (isTileLayoutRequest(trimmed)) return "tile";
			if (isSplitLayoutRequest(trimmed)) return "split";
		}
		return normalizedExplicit as ViewsMode;
	}

	if (!trimmed) return null;

	// Rollback/undo of a view-plugin create/edit must be checked before the
	// edit/delete verbs so "undo the view creation" / "roll back the plugin edit"
	// route to the rollback handler instead of being treated as an edit/delete.
	if (isRollbackRequest(trimmed)) return "rollback";
	if (DELETE_VERBS_RE.test(trimmed)) return "delete";
	if (CREATE_VERBS.test(trimmed)) return "create";
	if (EDIT_VERBS_RE.test(trimmed)) return "edit";
	if (isPinRequest(trimmed) || PIN_VERBS.test(trimmed)) return "pin";
	if (isWindowRequest(trimmed) || WINDOW_VERBS.test(trimmed)) return "window";
	if (isTileLayoutRequest(trimmed)) return "tile";
	if (isSplitLayoutRequest(trimmed)) return "split";
	if (INTERACT_VERBS.test(trimmed)) return "interact";
	if (BROADCAST_VERBS.test(trimmed)) return "broadcast";
	if (MANAGER_VERBS.test(trimmed)) return "manager";
	if (SHOW_ALL_VIEWS_MANAGER.test(trimmed)) return "manager";
	if (SHOW_APPS_VERBS.test(trimmed)) return "manager";
	if (CLOSE_VERBS.test(trimmed)) return "close";
	if (CLOSE_PREFIX_VERBS.test(trimmed)) return "close";
	if (SEARCH_VERBS.test(trimmed)) return "search";
	if (CURRENT_VIEW_VERBS.test(trimmed)) return "current";
	if (WHAT_VIEWS_VERB.test(trimmed)) return "list";
	if (LIST_VERBS.test(trimmed) && VIEW_NOUN.test(trimmed)) return "list";
	if (SHOW_VERBS.test(trimmed) && VIEW_NOUN.test(trimmed)) return "show";
	if (
		/^\s*(show|open|navigate to|go to|switch to|launch|display|bring up|pull up)\b/i.test(
			trimmed,
		)
	)
		return "show";

	// Passive domain intent ("what's on my calendar", "add a feature to my app",
	// "check my messages") carries no explicit mode keyword but maps to a known
	// view — route it to `show` so runViewsShow can open that surface.
	if (resolveIntentView(trimmed)) return "show";

	return null;
}

function isGenericViewNavigationMode(normalizedExplicit: string): boolean {
	return (
		normalizedExplicit === "open" ||
		normalizedExplicit === "show" ||
		normalizedExplicit === "view" ||
		normalizedExplicit === "open_view" ||
		normalizedExplicit === "show_view" ||
		normalizedExplicit === "navigate" ||
		normalizedExplicit === "navigate_to_view" ||
		normalizedExplicit === "go_to_view" ||
		normalizedExplicit === "switch" ||
		normalizedExplicit === "switch_view"
	);
}

function isTileLayoutRequest(text: string): boolean {
	return (
		TILE_VERBS.test(text) || /^\s*(tile|grid|arrange|layout)\b/i.test(text)
	);
}

function isSplitLayoutRequest(text: string): boolean {
	return (
		SPLIT_VERBS.test(text) ||
		/^\s*(split|side.?by.?side|next to|beside|alongside)\b/i.test(text) ||
		/\b(?:left|right|top|bottom)\b.{0,60}\b(?:screen|side|pane|panel|window|layout)\b/i.test(
			text,
		) ||
		/\b(?:on|to|at)\s+(?:the\s+)?(?:left|right|top|bottom)\b/i.test(text)
	);
}

function normalizedWordSet(text: string): Set<string> {
	return new Set(
		normalizeLooseTerm(text)
			.split(" ")
			.map((token) => token.trim())
			.filter(Boolean),
	);
}

function hasAnyToken(tokens: ReadonlySet<string>, values: readonly string[]) {
	return values.some((value) => tokens.has(value));
}

function mentionsViewSurface(tokens: ReadonlySet<string>): boolean {
	for (const token of tokens) {
		if (VIEW_SURFACE_TOKENS.has(token)) return true;
	}
	return false;
}

function isPinRequest(text: string): boolean {
	const tokens = normalizedWordSet(text);
	return hasAnyToken(tokens, ["dock", "pin"]) && mentionsViewSurface(tokens);
}

function isWindowRequest(text: string): boolean {
	const tokens = normalizedWordSet(text);
	const hasWindowIntent =
		hasAnyToken(tokens, ["detach", "popout", "window", "windows"]) ||
		(tokens.has("pop") && tokens.has("out"));
	if (!hasWindowIntent) return false;
	return (
		hasAnyToken(tokens, [
			"detach",
			"display",
			"launch",
			"new",
			"open",
			"pop",
			"popout",
			"separate",
			"show",
			"window",
			"windows",
		]) && mentionsViewSurface(tokens)
	);
}

function isLikelyViewContentOperation(text: string): boolean {
	if (/\b(views?|apps?|panels?|windows?|tabs?|screen|layout)\b/i.test(text)) {
		return false;
	}
	return (
		/\b(add|create|make|new|delete|remove|edit|update|show|list|get|read)\b/i.test(
			text,
		) &&
		/\b(notes?|events?|tasks?|todos?|records?|items?|entries?|reminders?)\b/i.test(
			text,
		)
	);
}

function isNonDestructiveCloseRequest(text: string): boolean {
	return (
		CLOSE_ALL_VERBS.test(text) ||
		CLOSE_VERBS.test(text) ||
		CLOSE_PREFIX_VERBS.test(text)
	);
}

function extractSearchQuery(
	text: string,
	options?: Record<string, unknown>,
): string {
	const explicit =
		readStringOption(options, "query") ?? readStringOption(options, "search");
	if (explicit) return explicit;

	// Strip "search views <query>" / "find view <query>"
	const match = text.match(
		/\b(?:search|find|look for|filter)\b.*?\bview[s]?\b\s+(.+)/i,
	);
	return match?.[1]?.trim() ?? text.trim();
}

const CLOSE_TARGET_VERBS = ["close", "dismiss", "hide", "exit", "quit"];
const CLOSE_TARGET_FILLER = new Set([
	"the",
	"view",
	"app",
	"panel",
	"window",
	"tab",
	"please",
	"pls",
	"now",
]);

function readViewTargetOption(
	options?: Record<string, unknown>,
): string | null {
	return (
		readStringOption(options, "view") ??
		readStringOption(options, "viewId") ??
		readStringOption(options, "id") ??
		readStringOption(options, "name") ??
		readStringOption(options, "target")
	);
}

function readCatalogViewTargetOption(
	options?: Record<string, unknown>,
): string | null {
	return (
		readStringOption(options, "view") ?? readStringOption(options, "viewId")
	);
}

const CAPABILITY_PARAM_RESERVED_KEYS = new Set([
	"action",
	"mode",
	"view",
	"viewId",
	"id",
	"name",
	"target",
	"subview",
	"section",
	"views",
	"viewIds",
	"targets",
	"layout",
	"placement",
	"query",
	"search",
	"viewType",
	"capability",
	"params",
	"timeoutMs",
	"eventType",
	"event",
	"type",
	"payload",
	"alwaysOnTop",
	"intent",
	"editTarget",
	"choice",
	"taskId",
	"confirm",
	"sha",
	"pluginName",
	"workdir",
]);

type ResolvedViewCapability = {
	view: ViewSummary;
	capability: ViewCapability;
};

const STANDARD_VIEW_CAPABILITY_BY_KEY = new Map<string, string>(
	[
		...Object.values(STANDARD_CAPABILITIES),
		...AGENT_SURFACE_CAPABILITY_IDS,
	].map((id) => [normalizeCapabilityKey(id), id]),
);

type OperationFamily = "create" | "read" | "update" | "delete" | "select";

const OPERATION_TOKEN_FAMILIES: Record<OperationFamily, Set<string>> = {
	create: new Set(["create", "add", "new", "make", "build", "generate"]),
	read: new Set([
		"get",
		"show",
		"read",
		"list",
		"view",
		"display",
		"state",
		"contents",
		"current",
	]),
	update: new Set(["update", "edit", "change", "rename", "set", "modify"]),
	delete: new Set(["delete", "remove", "clear", "destroy"]),
	select: new Set(["select", "choose", "pick"]),
};

/**
 * Genuine negation tokens for a subsequent destructive verb. When one of
 * these immediately precedes a delete-family token (within a three-token
 * window), the destructive token is treated as negated, not as affirmative
 * authority. Apostrophes are stripped before tokenization, so "don't"
 * arrives here as "dont".
 *
 * Deliberately narrow: modal/conditional words ("could", "would", "when")
 * are NOT negation — they appear in polite imperatives ("Could you delete
 * note X") that must still execute. Semantic disambiguation beyond simple
 * adjacent negation belongs to the LLM planner, not this lexical guard.
 */
const NEGATION_TOKENS = new Set(["not", "dont", "never"]);

/**
 * Returns true when a destructive-family token is preceded by a genuine
 * negation token within a three-token window (covers "not delete",
 * "don't remove", "never destroy", "do not ever delete").
 *
 * The token array is the already-split, normalized request text. This only
 * fires for destructive tokens because the asymmetric risk (silent data
 * loss) justifies special-case handling. Read/update/create families are
 * unaffected.
 */
function isDestructiveTokenNegated(
	tokens: string[],
	destructiveTokenSet: Set<string>,
): boolean {
	const negationWindow = 3;
	for (let i = 0; i < tokens.length; i++) {
		if (!destructiveTokenSet.has(tokens[i])) continue;
		for (let j = Math.max(0, i - negationWindow); j < i; j++) {
			if (NEGATION_TOKENS.has(tokens[j])) {
				return true;
			}
		}
	}
	return false;
}

function normalizeCapabilityKey(value: string | null | undefined): string {
	return (value ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokensFor(value: string | null | undefined): Set<string> {
	const normalized = normalizeCapabilityKey(value);
	if (!normalized) return new Set();
	return new Set(normalized.split(" ").filter(Boolean));
}

function operationFamilyForTokens(tokens: Set<string>): OperationFamily | null {
	const families = operationFamiliesForTokens(tokens);
	return families.size > 0 ? ([...families][0] ?? null) : null;
}

/**
 * Returns every operation family that has at least one token in the request.
 * Unlike the single-family resolver, this does not silently prefer an
 * incidental read-family word ("current", "list") over a destructive-family
 * word ("delete") that the planner already committed to.
 */
function operationFamiliesForTokens(tokens: Set<string>): Set<OperationFamily> {
	const result = new Set<OperationFamily>();
	for (const [family, familyTokens] of Object.entries(
		OPERATION_TOKEN_FAMILIES,
	) as [OperationFamily, Set<string>][]) {
		for (const token of tokens) {
			if (familyTokens.has(token)) {
				result.add(family);
				break;
			}
		}
	}
	return result;
}

function operationFamilyForCapability(
	capability: ViewCapability,
): OperationFamily | null {
	return (
		operationFamilyForTokens(tokensFor(capability.id)) ??
		operationFamilyForTokens(tokensFor(capability.description))
	);
}

function viewTokens(view: ViewSummary): Set<string> {
	return tokensFor(
		[view.id, view.label, view.description, ...(view.tags ?? [])].join(" "),
	);
}

function capabilityTokens(capability: ViewCapability): Set<string> {
	return tokensFor(
		[
			capability.id,
			capability.description,
			...Object.keys(capability.params ?? {}),
		].join(" "),
	);
}

function countIntersection(left: Set<string>, right: Set<string>): number {
	let count = 0;
	for (const value of left) {
		if (right.has(value)) count++;
	}
	return count;
}

function capabilityCandidates(
	views: readonly ViewSummary[],
	viewType?: ViewType,
): ResolvedViewCapability[] {
	return views
		.filter((view) => !viewType || !view.viewType || view.viewType === viewType)
		.flatMap((view) =>
			(view.capabilities ?? [])
				.filter((capability) => capability.authority !== "human")
				.map((capability) => ({ view, capability })),
		);
}

function resolveViewTarget(
	target: string | null,
	views: readonly ViewSummary[],
): ViewSummary | null {
	if (!target) return null;
	const match = resolveCloseTargetView(target, views);
	return match.kind === "match" ? match.view : null;
}

function isViewPluginAuthoringRequest(
	mode: ViewsMode,
	text: string,
	options?: Record<string, unknown>,
): boolean {
	if (
		mode !== "create" &&
		mode !== "edit" &&
		mode !== "delete" &&
		mode !== "remove"
	) {
		return false;
	}
	if (
		readStringOption(options, "editTarget") ||
		readStringOption(options, "choice") ||
		readDeleteConfirmationOption(options) !== null
	) {
		return true;
	}
	if (hasExplicitViewCapabilityIntent(text, options)) {
		return false;
	}
	const intent = readStringOption(options, "intent");
	const source = `${text} ${intent ?? ""}`;
	return /\b(view|views|plugin|plugins)\b/i.test(source);
}

function hasExplicitViewCapabilityIntent(
	text: string,
	options?: Record<string, unknown>,
): boolean {
	if (readStringOption(options, "capability")) return true;

	const explicitAction =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const actionIsMode =
		!!explicitAction &&
		(MODES as readonly string[]).includes(explicitAction.trim().toLowerCase());
	if (explicitAction && !actionIsMode) return true;

	const intent = readStringOption(options, "intent");
	const source = `${text} ${intent ?? ""}`;
	return /\b(capability|interact|invoke)\b/i.test(source);
}

function isViewNavigationRequest(
	mode: ViewsMode,
	text: string,
	options?: Record<string, unknown>,
): boolean {
	const explicit =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const source = `${text} ${explicit ?? ""}`;
	if (mode === "open") return true;
	const normalizedExplicit = explicit?.trim().toLowerCase().replace(/-/g, "_");
	const explicitTarget = readViewTargetOption(options);
	// A schema-valid planner decision owns the operation boundary. Text scoring
	// may infer a capability only when the planner did not explicitly choose
	// navigation; missing or stale targets belong to the navigation boundary
	// and must fail honestly instead of becoming foreground-view operations.
	if (normalizedExplicit === "show" || normalizedExplicit === "open") {
		return true;
	}
	if (
		/\b(open|launch|switch to|go to|navigate to|pull up|bring up)\b/i.test(
			source,
		)
	) {
		return true;
	}
	// "go home" / "home" / "show home" resolve to the chat/home surface in the
	// rigid multilingual matcher. That surface is pure navigation (it exposes no
	// capabilities), so a request that targets it can never be a foreground-view
	// capability read (#17299).
	if (matchViewCommand(viewRequestText(text)) === "chat") return true;
	if (explicitTarget && matchViewCommand(explicitTarget) === "chat") {
		return true;
	}
	if (
		(mode === "show" || mode === "list") &&
		/\b(view|views|app|apps|panel|panels|tab|tabs|window|windows)\b/i.test(
			source,
		)
	) {
		return true;
	}
	return false;
}

function shouldResolveModeAsCapability(
	mode: ViewsMode,
	text: string,
	options?: Record<string, unknown>,
): boolean {
	if (isViewPluginAuthoringRequest(mode, text, options)) return false;
	if (isViewNavigationRequest(mode, text, options)) return false;
	return (
		mode === "create" ||
		mode === "edit" ||
		mode === "delete" ||
		mode === "remove" ||
		mode === "show" ||
		mode === "list"
	);
}

function resolveViewCapability({
	views,
	text,
	options,
	viewType,
	currentViewId,
}: {
	views: readonly ViewSummary[];
	text: string;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	currentViewId?: string | null;
}): ResolvedViewCapability | null {
	const explicitCapability = readStringOption(options, "capability");
	const explicitAction =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const actionIsMode =
		!!explicitAction &&
		(MODES as readonly string[]).includes(explicitAction.trim().toLowerCase());
	const actionToken = actionIsMode ? null : explicitAction;
	const requestedTarget = readViewTargetOption(options);
	const requestedView = resolveViewTarget(requestedTarget, views);
	// A resolved planner target is authoritative. Foreground UI state is only a
	// fallback for requests that name NO explicit target at all: a planner that
	// names a target this deployment cannot resolve (e.g. show/home) must not
	// have its request silently rebound to whatever view happens to be
	// foregrounded (#17299).
	const currentView = requestedTarget
		? null
		: (views.find((view) => view.id === currentViewId) ?? null);
	const candidates = capabilityCandidates(views, viewType);

	if (explicitCapability) {
		const normalized = normalizeCapabilityKey(explicitCapability);
		const exactCandidates = candidates.filter(
			(candidate) =>
				normalizeCapabilityKey(candidate.capability.id) === normalized &&
				(!requestedView || candidate.view.id === requestedView.id),
		);
		if (requestedView && exactCandidates[0]) return exactCandidates[0];
		const currentExact = exactCandidates.find(
			(candidate) => candidate.view.id === currentView?.id,
		);
		if (currentExact) return currentExact;
		if (exactCandidates.length === 1) return exactCandidates[0];
		// Explicit planner choices resolve by declared id only. Message-text
		// scoring must never turn an unknown UI interaction into a record write.
		return null;
	}

	const sourceText = [actionToken ?? text, explicitCapability]
		.filter(Boolean)
		.join(" ");
	const sourceTokens = tokensFor(sourceText);
	const sourceOperation = operationFamilyForTokens(sourceTokens);
	let best: { candidate: ResolvedViewCapability; score: number } | null = null;

	for (const candidate of candidates) {
		if (requestedView && candidate.view.id !== requestedView.id) continue;
		const vTokens = viewTokens(candidate.view);
		const cTokens = capabilityTokens(candidate.capability);
		const capOperation = operationFamilyForCapability(candidate.capability);
		if (
			explicitCapability &&
			sourceOperation &&
			capOperation &&
			capOperation !== sourceOperation
		) {
			continue;
		}
		const viewMatches =
			requestedView?.id === candidate.view.id ||
			countIntersection(sourceTokens, vTokens) > 0 ||
			currentView?.id === candidate.view.id;
		if (!viewMatches) continue;

		let score = 0;
		if (requestedView?.id === candidate.view.id) score += 5;
		if (currentViewId === candidate.view.id) score += 2;
		score += countIntersection(sourceTokens, vTokens) * 2;
		score += countIntersection(sourceTokens, cTokens);
		if (sourceOperation && capOperation === sourceOperation) score += 4;
		if (
			actionToken &&
			normalizeCapabilityKey(actionToken) ===
				normalizeCapabilityKey(candidate.capability.id)
		) {
			score += 8;
		}
		if (sourceTokens.size > 0) {
			const combined = new Set([...vTokens, ...cTokens]);
			if ([...sourceTokens].every((token) => combined.has(token))) {
				score += 3;
			}
		}

		if (score >= 5 && (!best || score > best.score)) {
			best = { candidate, score };
		}
	}

	return best?.candidate ?? null;
}

/**
 * Result of the capability correction path. It either returns a (possibly
 * corrected) capability or — when the request lexically negates the
 * destructive verb the planner selected ("do not delete X") — returns a
 * rejection so the caller refuses rather than silently destroying data.
 */
type CapabilityCorrection =
	| { kind: "capability"; capability: ViewCapability }
	| { kind: "reject"; reason: string };

function correctCapabilityOperationFamily(
	view: ViewSummary,
	capability: ViewCapability,
	text: string,
): CapabilityCorrection {
	// Strip apostrophes before normalization so "don't" tokenizes as "dont"
	// instead of splitting into meaningless "don" / "t" fragments.
	const requestText = viewRequestText(text).replace(/['‘’]/g, "");
	const normalizedRequest = normalizeCapabilityKey(requestText);
	const requestTokenArray = normalizedRequest.split(" ").filter(Boolean);
	const requestTokens = new Set(requestTokenArray);
	const requestedFamilies = operationFamiliesForTokens(requestTokens);
	const selectedFamily = operationFamilyForCapability(capability);
	const selectedIsDestructive = selectedFamily === "delete";

	// Negation gate: an explicitly negated destructive verb ("do not
	// delete", "never remove") is not affirmative authority for the
	// destructive capability the planner selected. This is deliberately the
	// ONLY lexical veto over the planner: broader guesses (conditionals,
	// requests with no recognizable English verbs) stay with the planner,
	// which is the semantic authority — otherwise polite imperatives
	// ("Could you delete note X") and non-English requests would be broken.
	if (
		selectedIsDestructive &&
		isDestructiveTokenNegated(
			requestTokenArray,
			OPERATION_TOKEN_FAMILIES.delete,
		)
	) {
		return {
			kind: "reject",
			reason:
				"the destructive verb is negated in the request — cannot confirm affirmative authority for a destructive capability",
		};
	}

	// A selected read must never become a write or UI mutation because a
	// prerequisite, prohibition or later step contains another operation verb.
	if (selectedFamily === "read") return { kind: "capability", capability };

	// Preserve the planner's explicit selection when its family has any
	// token support in the request. This prevents rewriting an explicit
	// delete-note to get-note just because the request also contained
	// read-family words like "current" or "list" (#18386).
	if (
		requestedFamilies.size === 0 ||
		!selectedFamily ||
		requestedFamilies.has(selectedFamily)
	) {
		return { kind: "capability", capability };
	}

	// The selected capability's family has NO token support in the
	// request — a potential mismatch. Before correcting, enforce the
	// asymmetric-risk rule: never lexically escalate into delete.
	// Surrounding tokens cannot authorize destructive escalation; the
	// planner must select that operation itself.
	const requestedFamily = [...requestedFamilies][0];
	const correctedIsDestructive = requestedFamily === "delete";
	if (correctedIsDestructive && !selectedIsDestructive) {
		// Create/update/select→delete escalation is
		// prohibited. Return the original capability unchanged rather
		// than guessing destructive intent from lexical tokens.
		return { kind: "capability", capability };
	}

	const familyMatches = (view.capabilities ?? []).filter(
		(candidate) =>
			candidate.authority !== "human" &&
			operationFamilyForCapability(candidate) === requestedFamily,
	);
	if (familyMatches.length === 1 && familyMatches[0])
		return { kind: "capability", capability: familyMatches[0] };

	const ranked = familyMatches
		.map((candidate) => ({
			candidate,
			score: countIntersection(requestTokens, capabilityTokens(candidate)),
		}))
		.sort((left, right) => right.score - left.score);
	// Multiple semantic siblings are corrected only when the user's nouns make
	// one a unique best match; a tie preserves the planner decision rather than
	// guessing between collection and single-record reads.
	const resolved =
		ranked[0] && ranked[0].score > (ranked[1]?.score ?? -1)
			? ranked[0].candidate
			: capability;
	return { kind: "capability", capability: resolved };
}

type CapabilityParamsResolution =
	| { ok: true; params: Record<string, unknown> | undefined }
	| { ok: false; error: string };

function isCapabilityParamsRecord(
	value: unknown,
): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCapabilityParam(
	name: string,
	schema: ViewCapabilityParameter,
	value: unknown,
): string | null {
	const typeError = (expected: string) => {
		const actual =
			value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		return `parameter "${name}" must be ${expected}, received ${actual}`;
	};
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") return typeError("a string");
			if (schema.minLength !== undefined && value.length < schema.minLength) {
				return `parameter "${name}" must be at least ${schema.minLength} character(s)`;
			}
			if (schema.maxLength !== undefined && value.length > schema.maxLength) {
				return `parameter "${name}" must be at most ${schema.maxLength} character(s)`;
			}
			if (schema.pattern !== undefined) {
				const result = testSchemaPattern(schema.pattern, value);
				if (!result.ok) return `parameter "${name}" ${result.reason}`;
			}
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value))
				return typeError("a finite number");
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isSafeInteger(value))
				return typeError("an integer");
			break;
		case "boolean":
			if (typeof value !== "boolean") return typeError("a boolean");
			break;
		case "array":
			if (!Array.isArray(value)) return typeError("an array");
			break;
		case "object":
			if (!isCapabilityParamsRecord(value)) return typeError("an object");
			break;
		default:
			return `parameter "${name}" declares unsupported schema type "${schema.type}"`;
	}
	if (
		schema.enum &&
		!schema.enum.some((candidate) => Object.is(candidate, value))
	) {
		return `parameter "${name}" must be one of: ${schema.enum.join(", ")}`;
	}
	if (
		typeof value === "number" &&
		schema.minimum !== undefined &&
		value < schema.minimum
	) {
		return `parameter "${name}" must be at least ${schema.minimum}`;
	}
	if (
		typeof value === "number" &&
		schema.maximum !== undefined &&
		value > schema.maximum
	) {
		return `parameter "${name}" must be at most ${schema.maximum}`;
	}
	return null;
}

function readCapabilityParams(
	options: Record<string, unknown> | undefined,
	capability?: ViewCapability | null,
	messageText?: string,
): CapabilityParamsResolution {
	const params: Record<string, unknown> = {};
	const capabilitySchema = capability?.params ?? {};
	const capabilityParamKeys = new Set(Object.keys(capabilitySchema));
	const nested = options?.params;
	if (nested !== undefined && !isCapabilityParamsRecord(nested)) {
		return { ok: false, error: 'parameter "params" must be an object' };
	}
	const normalizedNested = isCapabilityParamsRecord(nested)
		? { ...nested }
		: undefined;
	if (capabilityParamKeys.has("content") && normalizedNested) {
		const legacyBody = normalizedNested.body;
		if (normalizedNested.content === undefined) {
			if (typeof legacyBody === "string") {
				normalizedNested.content = legacyBody;
			} else if (
				isCapabilityParamsRecord(legacyBody) &&
				typeof legacyBody.content === "string"
			) {
				normalizedNested.content = legacyBody.content;
			}
		}
		// A one-field capability owns its own deterministic storage label. Old
		// planners may still emit a title/body pair, but forwarding either key
		// would violate the declared contract and reintroduce model-authored labels.
		if (!capabilityParamKeys.has("body")) delete normalizedNested.body;
		if (!capabilityParamKeys.has("title")) delete normalizedNested.title;
	}

	for (const [key, value] of Object.entries(options ?? {})) {
		if (key === "params") continue;
		if (key.startsWith("params.")) {
			return {
				ok: false,
				error: `dotted capability parameter "${key}" is not supported; use the params object`,
			};
		}
		if (capabilityParamKeys.has(key)) {
			params[key] = value;
			continue;
		}
		if (
			key === "body" &&
			capabilityParamKeys.has("content") &&
			params.content === undefined
		) {
			if (typeof value === "string") {
				params.content = value;
			} else if (
				isCapabilityParamsRecord(value) &&
				typeof value.content === "string"
			) {
				params.content = value.content;
			}
			continue;
		}
		if (!capability && !CAPABILITY_PARAM_RESERVED_KEYS.has(key)) {
			params[key] = value;
		}
	}

	if (normalizedNested) {
		if (capability) {
			const unknownKey = Object.keys(normalizedNested).find(
				(key) => !capabilityParamKeys.has(key),
			);
			if (unknownKey) {
				return {
					ok: false,
					error: `capability "${capability.id}" does not accept parameter "${unknownKey}"`,
				};
			}
		}
		Object.assign(params, normalizedNested);
	}

	const intent = readStringOption(options, "intent");
	if (intent) {
		Object.assign(
			params,
			deriveParamsFromIntent(intent, capability, capabilityParamKeys, params),
		);
	}
	if (messageText && capability) {
		Object.assign(
			params,
			deriveParamsFromMessageText(
				messageText,
				capability,
				capabilityParamKeys,
				params,
			),
		);
	}
	normalizeDateReadAlias(params, capability, messageText);

	for (const key of Object.keys(params)) {
		if (params[key] === undefined) {
			delete params[key];
		}
	}

	if (capability) {
		for (const [name, schema] of Object.entries(capabilitySchema)) {
			const value = params[name];
			if (schema.required === true && value === undefined) {
				return {
					ok: false,
					error: `capability "${capability.id}" requires parameter "${name}"`,
				};
			}
			if (value === undefined) continue;
			const validationError = validateCapabilityParam(name, schema, value);
			if (validationError)
				return {
					ok: false,
					error: `capability "${capability.id}" ${validationError}`,
				};
		}
	}
	return {
		ok: true,
		params: Object.keys(params).length > 0 ? params : undefined,
	};
}

function normalizeDateReadAlias(
	params: Record<string, unknown>,
	capability: ViewCapability | null | undefined,
	messageText?: string,
): void {
	if (
		!capability ||
		operationFamilyForCapability(capability) !== "read" ||
		!("date" in (capability.params ?? {})) ||
		typeof params.title !== "string" ||
		params.date !== undefined
	) {
		return;
	}
	const title = params.title.trim();
	if (
		extractIsoDate(title) !== title ||
		/\b(?:titled?|named)\b/i.test(viewRequestText(messageText ?? ""))
	) {
		return;
	}
	params.date = title;
	delete params.title;
}

function deriveParamsFromIntent(
	intent: string,
	capability: ViewCapability | null | undefined,
	capabilityParamKeys: Set<string>,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const derived: Record<string, unknown> = {};
	const trimmed = intent.trim();
	if (!trimmed) return derived;

	const title = extractIntentTitle(trimmed);
	if (capabilityParamKeys.has("title") && existing.title === undefined) {
		if (title) derived.title = title;
		else if (
			capability &&
			operationFamilyForCapability(capability) === "create"
		) {
			derived.title = trimmed;
		}
	}
	const body = extractIntentTextAfter(trimmed, ["body", "content"]);
	if (capabilityParamKeys.has("body") && existing.body === undefined && body) {
		derived.body = body;
	}
	if (
		capabilityParamKeys.has("content") &&
		existing.content === undefined &&
		body
	) {
		derived.content = body;
	}
	const notes = extractIntentTextAfter(trimmed, ["notes", "note"]);
	if (
		capabilityParamKeys.has("notes") &&
		existing.notes === undefined &&
		notes
	) {
		derived.notes = notes;
	}
	const date = extractIsoDate(trimmed);
	if (capabilityParamKeys.has("date") && existing.date === undefined && date) {
		derived.date = date;
	}
	const time = extractClockTime(trimmed);
	if (capabilityParamKeys.has("time") && existing.time === undefined && time) {
		derived.time = time;
	}

	return derived;
}

function extractIntentTitle(intent: string): string | null {
	const lower = intent.toLowerCase();
	let markerEnd = -1;
	for (const marker of ["titled", "title"]) {
		let cursor = 0;
		while (cursor < lower.length) {
			const start = lower.indexOf(marker, cursor);
			if (start < 0) break;
			const before = lower[start - 1] ?? " ";
			const after = lower[start + marker.length] ?? " ";
			if (!/[a-z0-9_]/.test(before) && after.trim() === "") {
				markerEnd = start + marker.length;
				break;
			}
			cursor = start + 1;
		}
		if (markerEnd >= 0) break;
	}
	if (markerEnd >= 0) {
		let titleStart = markerEnd;
		while (titleStart < intent.length && intent[titleStart]?.trim() === "")
			titleStart += 1;
		if (intent[titleStart] === '"' || intent[titleStart] === "'")
			titleStart += 1;
		let titleEnd = intent.length;
		for (const delimiter of ["with", "on", "at", "for"]) {
			let cursor = titleStart;
			while (cursor < lower.length) {
				const start = lower.indexOf(delimiter, cursor);
				if (start < 0) break;
				const before = intent[start - 1] ?? "";
				const after = intent[start + delimiter.length] ?? " ";
				if (before.trim() === "" && !/[a-z0-9_]/.test(after)) {
					titleEnd = Math.min(titleEnd, start);
					break;
				}
				cursor = start + 1;
			}
		}
		let title = intent.slice(titleStart, titleEnd).trim();
		if (title.endsWith('"') || title.endsWith("'"))
			title = title.slice(0, -1).trimEnd();
		if (title) return title;
	}
	const quoted = /["']([^"']{1,160})["']/.exec(intent);
	return quoted?.[1]?.trim() ?? null;
}

function extractIntentTextAfter(
	intent: string,
	labels: readonly string[],
): string | null {
	for (const label of labels) {
		const match = new RegExp(`\\b(?:with\\s+)?${label}\\s+(.+)$`, "i").exec(
			intent,
		);
		if (match?.[1]?.trim()) return match[1].trim();
	}
	return null;
}

// ASCII and typographic quote delimiters accepted in NL view-intent parsing.
const VIEW_INTENT_QUOTE_OPEN = `["'“‘]`;
const VIEW_INTENT_QUOTE_CLOSE = `["'”’]`;
const VIEW_INTENT_QUOTED_SPAN = `[^"'“”‘’]{1,240}`;

function extractQuotedSpanAfterKeyword(
	intent: string,
	keywordPattern: string,
): string | null {
	const quoted = new RegExp(
		`\\b${keywordPattern}\\s+${VIEW_INTENT_QUOTE_OPEN}(${VIEW_INTENT_QUOTED_SPAN})${VIEW_INTENT_QUOTE_CLOSE}`,
		"i",
	).exec(intent)?.[1];
	return quoted?.trim() || null;
}

function extractReferencedTitle(intent: string): string | null {
	const quoted = extractQuotedSpanAfterKeyword(intent, "(?:titled?|named)");
	if (quoted) return quoted;

	const unquoted =
		/\b(?:titled?|named)\s+(.+?)(?=\s*(?:[.,;]|\b(?:and|then|with|on|at|rename|change|update|move|delete|remove)\b|$))/i.exec(
			intent,
		)?.[1];
	return unquoted?.trim() || null;
}

function deriveParamsFromMessageText(
	text: string,
	capability: ViewCapability,
	capabilityParamKeys: Set<string>,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const derived: Record<string, unknown> = {};
	const trimmed = viewRequestText(text).trim();
	if (!trimmed) return derived;

	const family = operationFamilyForCapability(capability);
	if (family === "create") {
		const body = extractIntentTextAfter(trimmed, [
			"body",
			"content",
			"saying",
			"says",
			"say",
		]);
		if (capabilityParamKeys.has("body") && !existing.body && body) {
			derived.body = body;
		}
		if (capabilityParamKeys.has("content") && !existing.content && body) {
			derived.content = body;
		}
		const title = extractIntentTitle(trimmed);
		if (capabilityParamKeys.has("title") && !existing.title && title) {
			derived.title = title;
		}
	}

	if (
		family === "read" &&
		capabilityParamKeys.has("title") &&
		existing.title === undefined
	) {
		const title = extractReferencedTitle(trimmed);
		if (title) derived.title = title;
	}

	if (
		family === "update" &&
		capabilityParamKeys.has("oldTitle") &&
		existing.oldTitle === undefined
	) {
		const oldTitle = extractReferencedTitle(trimmed);
		if (oldTitle) derived.oldTitle = oldTitle;
	}

	if (
		family === "select" &&
		capabilityParamKeys.has("date") &&
		existing.date === undefined
	) {
		const date = extractIsoDate(trimmed);
		if (date) derived.date = date;
	}

	if (family === "delete") {
		if (existing.id || existing.query || existing.title || existing.name) {
			return derived;
		}
		const target = extractDeleteTargetText(trimmed);
		if (target) {
			// Do not infer an exact title (destructive label selector) from
			// free-form text — that reimplements the destructive-selector
			// inference #18377 rejects. Prefer query (contained-text search)
			// as the safe default; only infer title when the text explicitly
			// references a label with "titled" or "named" (#18377).
			const explicitTitle = extractReferencedTitle(trimmed);
			if (explicitTitle && capabilityParamKeys.has("title")) {
				derived.title = explicitTitle;
			} else if (capabilityParamKeys.has("query")) {
				derived.query = target;
			} else if (capabilityParamKeys.has("title")) {
				derived.title = target;
			} else if (capabilityParamKeys.has("name")) {
				derived.name = target;
			}
		}
	}

	return derived;
}

function extractDeleteTargetText(text: string): string | null {
	const quoted = new RegExp(
		`\\b(?:delete|remove|drop|destroy)\\s+(?:the\\s+)?(?:(?:sticky\\s+note|calendar\\s+event|note|notes|event|events|record|records|item|items)\\s+)?${VIEW_INTENT_QUOTE_OPEN}(${VIEW_INTENT_QUOTED_SPAN})${VIEW_INTENT_QUOTE_CLOSE}`,
		"i",
	).exec(text)?.[1];
	if (quoted?.trim()) return quoted.trim();

	const match = /\b(?:delete|remove|drop|destroy)\s+(?:the\s+)?(.+?)\s*$/i.exec(
		text,
	);
	const target = match?.[1]?.trim();
	if (!target) return null;
	const cleaned = target
		.replace(
			/^(?:(?:sticky|calendar)\s+)?(?:note|notes|event|events|record|records|item|items)\b\s*/i,
			"",
		)
		.replace(
			/\s+\b(?:note|notes|event|events|record|records|item|items)\b\s*$/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : null;
}

function extractIsoDate(intent: string): string | null {
	return /\b(\d{4}-\d{2}-\d{2})\b/.exec(intent)?.[1] ?? null;
}

function extractClockTime(intent: string): string | null {
	return /\b(?:at|time)\s+(\d{1,2}:\d{2})\b/i.exec(intent)?.[1] ?? null;
}

function isCloseAllRequest(
	text: string,
	options?: Record<string, unknown>,
): boolean {
	const requestText = viewRequestText(text);
	const explicit = readViewTargetOption(options)?.trim().toLowerCase();
	return (
		readBooleanOption(options, "all") ||
		explicit === "all" ||
		explicit === "__all__" ||
		CLOSE_ALL_VERBS.test(requestText)
	);
}

function extractCloseTarget(
	text: string,
	options?: Record<string, unknown>,
): string | null {
	const explicit = readViewTargetOption(options);
	if (explicit) return explicit;

	const requestText = viewRequestText(text);
	const lower = requestText.toLowerCase();
	for (const verb of CLOSE_TARGET_VERBS) {
		const idx = lower.indexOf(verb);
		if (idx === -1) continue;
		const rest = requestText.slice(idx + verb.length).trim();
		if (!rest) continue;
		const tokens = rest
			.split(/[\s,!.?]+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);
		let start = 0;
		while (
			start < tokens.length &&
			CLOSE_TARGET_FILLER.has(tokens[start].toLowerCase())
		) {
			start++;
		}
		let end = tokens.length;
		while (
			end > start &&
			CLOSE_TARGET_FILLER.has(tokens[end - 1].toLowerCase())
		) {
			end--;
		}
		const candidate = tokens.slice(start, end).join(" ").toLowerCase();
		if (
			candidate &&
			candidate !== "all" &&
			candidate !== "current" &&
			!CLOSE_TARGET_FILLER.has(candidate)
		) {
			return candidate;
		}
	}

	return null;
}

function resolveCloseTargetView(
	target: string,
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const q = target.toLowerCase();
	const byId = views.find((view) => view.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	const byLabel = views.find((view) => view.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	const normalizedTarget = normalizeLooseTerm(target);
	const byLooseId = views.find(
		(view) => normalizeLooseTerm(view.id) === normalizedTarget,
	);
	if (byLooseId) return { kind: "match", view: byLooseId };

	const byLooseLabel = views.find(
		(view) => normalizeLooseTerm(view.label) === normalizedTarget,
	);
	if (byLooseLabel) return { kind: "match", view: byLooseLabel };

	const byTag = views.find((view) =>
		(view.tags ?? []).some(
			(tag) =>
				tag.toLowerCase() === q || normalizeLooseTerm(tag) === normalizedTarget,
		),
	);
	if (byTag) return { kind: "match", view: byTag };

	const scored = views
		.map((view) => ({ view, score: scoreView(view, target) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length === 0) return { kind: "none" };
	if (scored.length === 1) return { kind: "match", view: scored[0].view };

	const topScore = scored[0].score;
	const topTied = scored.filter(({ score }) => score === topScore);
	if (topTied.length === 1) return { kind: "match", view: topTied[0].view };

	return { kind: "ambiguous", candidates: topTied.map(({ view }) => view) };
}

function uniqueStrings(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLooseTerm(value: string): string {
	return value
		.toLowerCase()
		.replace(/[-_./]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function textMentionsTerm(
	normalizedText: string,
	term: string,
	minimumLength = 3,
): boolean {
	const normalizedTerm = normalizeLooseTerm(term);
	if (normalizedTerm.length < minimumLength) return false;
	const re = new RegExp(`(?:^|\\W)${escapeRegExp(normalizedTerm)}(?:\\W|$)`);
	return re.test(normalizedText);
}

function readStringListOption(
	options: Record<string, unknown> | undefined,
	key: string,
): string[] {
	const value = options?.[key];
	if (Array.isArray(value)) {
		return uniqueStrings(
			value.filter((item): item is string => typeof item === "string"),
		);
	}
	if (typeof value !== "string") return [];
	return uniqueStrings(value.split(/[,|]/));
}

function readLayoutTargetsFromOptions(
	options?: Record<string, unknown>,
): string[] {
	const singleValueKeys = [
		"view",
		"id",
		"name",
		"target",
		"withView",
		"secondaryView",
	];
	return uniqueStrings([
		...readStringListOption(options, "views"),
		...readStringListOption(options, "viewIds"),
		...readStringListOption(options, "targets"),
		...singleValueKeys
			.map((key) => readStringOption(options, key))
			.filter((value): value is string => typeof value === "string"),
	]);
}

function hasCapabilityPayloadOptions(
	options?: Record<string, unknown>,
): boolean {
	for (const [key, value] of Object.entries(options ?? {})) {
		if (value === undefined || value === null || value === "") continue;
		if (
			key === "params" &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length > 0
		) {
			return true;
		}
		if (key.startsWith("params.")) return true;
		if (!CAPABILITY_PARAM_RESERVED_KEYS.has(key)) return true;
	}
	return false;
}

function preferLayoutModeOverCapability({
	text,
	options,
	views,
}: {
	text: string;
	options?: Record<string, unknown>;
	views: readonly ViewSummary[];
}): "split" | "tile" | null {
	// The planner's declared capability is authoritative. Positional words in
	// a read request (for example "title at the top") are not layout commands.
	if (readStringOption(options, "capability")?.trim()) return null;
	const trimmed = viewRequestText(text).trim();
	if (!trimmed || hasCapabilityPayloadOptions(options)) return null;

	const mode = isTileLayoutRequest(trimmed)
		? "tile"
		: isSplitLayoutRequest(trimmed)
			? "split"
			: null;
	if (!mode) return null;
	if (isLikelyViewContentOperation(trimmed)) return null;

	const targets = resolveLayoutTargets(trimmed, options, views);
	return targets.length > 0 ? mode : null;
}

function resolveLayoutTargets(
	text: string,
	options: Record<string, unknown> | undefined,
	views: readonly ViewSummary[],
): ViewSummary[] {
	const explicit = readLayoutTargetsFromOptions(options);
	const explicitResolved: ViewSummary[] = [];
	for (const target of explicit) {
		const match = resolveCloseTargetView(target, views);
		if (match.kind === "match") explicitResolved.push(match.view);
	}

	const requestText = viewRequestText(text);
	const normalizedText = normalizeLooseTerm(requestText);
	const identityResolved: ViewSummary[] = [];
	const tagResolved: ViewSummary[] = [];
	for (const view of views) {
		const normalizedLabel = normalizeLooseTerm(view.label);
		const labelIsGenericSurface = VIEW_SURFACE_TOKENS.has(normalizedLabel);
		if (
			textMentionsTerm(normalizedText, view.id, 1) ||
			(!labelIsGenericSurface && textMentionsTerm(normalizedText, view.label))
		) {
			identityResolved.push(view);
		} else if (
			(view.tags ?? []).some(
				(tag) =>
					!VIEW_SURFACE_TOKENS.has(normalizeLooseTerm(tag)) &&
					textMentionsTerm(normalizedText, tag),
			)
		) {
			tagResolved.push(view);
		}
	}

	const explicitUnique = uniqueByViewId(explicitResolved);
	const identityUnique = uniqueByViewId(identityResolved);
	const identityIds = new Set(identityUnique.map((view) => view.id));
	const declaredIdentities = explicitUnique.filter((view) =>
		identityIds.has(view.id),
	);
	// A complete declared subset belongs to this step. Other named views may
	// be excluded by the user or belong to a later step; their mere occurrence
	// must not expand the action. Likewise, trim unmentioned names from polluted
	// planner options when the user supplies a complete exact pair.
	if (declaredIdentities.length >= 2) return declaredIdentities;
	// A complete step can name its targets only in structured arguments. Other
	// prose identities may be exclusions, so do not union or substitute them.
	if (explicitUnique.length >= 2) return explicitUnique;
	// A named pair owns its layout membership even when the planner supplied
	// extra targets. Broad tags in another clause (including a data restriction
	// such as "leave reminders unchanged") must not add unrelated panes.
	if (identityUnique.length >= 2) return identityUnique;
	// Preserve legacy tag/alias resolution only when neither the user nor the
	// structured step identifies a complete layout, e.g. "notes and calender".
	const mentionedIds = new Set([
		...identityIds,
		...tagResolved.map((view) => view.id),
	]);
	const textUnique = uniqueByViewId(
		views.filter((view) => mentionedIds.has(view.id)),
	);
	return textUnique.length >= 2
		? textUnique
		: textUnique.length === 1 && explicitUnique.length <= 1
			? textUnique
			: uniqueByViewId([...explicitUnique, ...textUnique]);
}

function isLayoutOnlyFollowupRequest(
	text: string,
	views: readonly ViewSummary[],
): boolean {
	const requestText = viewRequestText(text).trim();
	if (!requestText) return false;
	if (resolveLayoutTargets(requestText, undefined, views).length > 0)
		return false;
	return /\b(instead|again|horizontal|vertical|row|column|stack|side.?by.?side|left-right|top-bottom)\b/i.test(
		requestText,
	);
}

async function resolveSingleShellTargetView({
	client,
	text,
	options,
	viewType,
}: {
	client: ViewsClient;
	text: string;
	options?: Record<string, unknown>;
	viewType?: ViewType;
}): Promise<
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" }
> {
	const requestText = viewRequestText(text);
	const explicit = readViewTargetOption(options)?.trim();
	if (
		explicit?.toLowerCase() === "current" ||
		(!explicit && /\bcurrent\b/i.test(requestText))
	) {
		// error-policy:J4 current-view read over loopback; unreachable -> null -> resolve to "none"
		const currentView = await client.getCurrentView().catch(() => null);
		if (!currentView?.viewId) return { kind: "none" };
		return {
			kind: "match",
			view: {
				id: currentView.viewId,
				label: currentView.viewLabel ?? currentView.viewId,
				available: true,
				pluginName: "current",
				viewType: currentView.viewType ?? viewType ?? "gui",
				...(currentView.viewPath ? { path: currentView.viewPath } : {}),
			},
		};
	}

	const views = await client.listViews({ viewType });
	if (explicit) return resolveCloseTargetView(explicit, views);

	const targets = resolveLayoutTargets(requestText, undefined, views);
	if (targets.length === 1) return { kind: "match", view: targets[0] };
	if (targets.length > 1) return { kind: "ambiguous", candidates: targets };
	return { kind: "none" };
}

function uniqueByViewId(views: readonly ViewSummary[]): ViewSummary[] {
	const byId = new Map<string, ViewSummary>();
	for (const view of views) byId.set(view.id, view);
	return [...byId.values()];
}

function readLayoutValue(
	text: string,
	options?: Record<string, unknown>,
): "horizontal" | "vertical" | "grid" {
	const requestText = viewRequestText(text);
	const explicit =
		readStringOption(options, "layout") ??
		readStringOption(options, "orientation") ??
		readStringOption(options, "direction");
	const value = explicit?.trim().toLowerCase();
	if (
		value === "horizontal" ||
		value === "left-right" ||
		value === "row" ||
		value === "side-by-side"
	)
		return "horizontal";
	if (
		value === "vertical" ||
		value === "top-bottom" ||
		value === "column" ||
		value === "stack"
	)
		return "vertical";
	if (value === "grid" || value === "tile" || value === "tiled") return "grid";

	if (/\b(left|right|horizontal|side.?by.?side)\b/i.test(requestText)) {
		return "horizontal";
	}
	if (/\b(next to|beside|alongside)\b/i.test(requestText)) return "horizontal";
	if (/\b(top|bottom|vertical|stack)\b/i.test(requestText)) return "vertical";
	return "grid";
}

function readPlacementValue(
	text: string,
	options?: Record<string, unknown>,
): "left" | "right" | "top" | "bottom" | undefined {
	const requestText = viewRequestText(text);
	const explicit = readStringOption(options, "placement")?.trim().toLowerCase();
	if (
		explicit === "left" ||
		explicit === "right" ||
		explicit === "top" ||
		explicit === "bottom"
	) {
		return explicit;
	}
	const match = /\b(left|right|top|bottom)\b/i.exec(requestText);
	const value = match?.[1]?.toLowerCase();
	if (
		value === "left" ||
		value === "right" ||
		value === "top" ||
		value === "bottom"
	) {
		return value;
	}
	return undefined;
}

function layoutForPlacement(
	placement?: "left" | "right" | "top" | "bottom",
): "horizontal" | "vertical" | undefined {
	if (placement === "left" || placement === "right") return "horizontal";
	if (placement === "top" || placement === "bottom") return "vertical";
	return undefined;
}

async function completeSplitTargetsWithCurrentView({
	client,
	targets,
	views,
	placement,
}: {
	client: ViewsClient;
	targets: ViewSummary[];
	views: readonly ViewSummary[];
	placement?: "left" | "right" | "top" | "bottom";
}): Promise<ViewSummary[]> {
	if (targets.length !== 1) return targets;
	// error-policy:J4 current-view read over loopback; unreachable -> null -> keep given targets
	const currentView = await client.getCurrentView().catch(() => null);
	const currentId = currentView?.viewId;
	if (!currentId || currentId === targets[0].id) return targets;
	const currentSummary = views.find((view) => view.id === currentId);
	if (!currentSummary) return targets;

	if (placement === "left" || placement === "top") {
		return [targets[0], currentSummary];
	}
	return [currentSummary, targets[0]];
}

async function completeSplitTargetsFromCurrentLayout({
	client,
	targets,
	views,
	preferCurrentLayout,
}: {
	client: ViewsClient;
	targets: ViewSummary[];
	views: readonly ViewSummary[];
	preferCurrentLayout?: boolean;
}): Promise<ViewSummary[]> {
	// error-policy:J4 current-view read over loopback; unreachable -> null -> no layout completion
	const currentView = await client.getCurrentView().catch(() => null);
	const currentLayoutIds = currentView?.views ?? [];
	const byId = new Map(views.map((view) => [view.id, view]));
	if (currentLayoutIds.some((viewId) => !byId.has(viewId))) {
		const unfilteredViews = await client.listViews().catch(() => []);
		for (const view of unfilteredViews) byId.set(view.id, view);
	}
	const currentTargets = currentLayoutIds.map((viewId) => {
		const summary = byId.get(viewId);
		if (summary) return summary;
		return {
			id: viewId,
			label: viewId === currentView?.viewId ? currentView.viewLabel : viewId,
			available: true,
			pluginName: "current-layout",
			viewType: currentView?.viewType ?? "gui",
			...(viewId === currentView?.viewId && currentView.viewPath
				? { path: currentView.viewPath }
				: {}),
		};
	});
	if (preferCurrentLayout && currentTargets.length >= 2) return currentTargets;
	if (targets.length >= 2) return targets;
	return currentTargets.length >= 2 ? currentTargets : targets;
}

async function runViewsClose({
	client,
	message,
	options,
	viewType,
	callback,
}: {
	client: ViewsClient;
	message: Memory;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	// Security-unwrapped user words — never the raw (possibly enveloped)
	// content.text; the envelope's warning contains verbs the extractors match.
	const text = userRequestMessageText(message);
	if (isCloseAllRequest(text, options)) {
		const result = await navigateViewWithShellAction(
			{ message, options },
			"__all__",
			"close-all",
			"Closed all views.",
			"Requested closing all views.",
		);
		await callback?.({ text: result.text });
		return {
			success: result.ok,
			text: result.text,
			values: { mode: "close", scope: "all" },
			data: { viewId: "__all__", action: "close-all" },
		};
	}

	const target = extractCloseTarget(text, options);
	let viewId: string | null = null;
	let label: string | null = null;
	let resolvedViewType: ViewType | undefined;

	if (!target || target.toLowerCase() === "current") {
		const currentView = await client.getCurrentView();
		viewId = currentView?.viewId ?? null;
		label = currentView?.viewLabel ?? null;
		resolvedViewType = viewType ?? currentView?.viewType;
		if (!viewId) {
			const reply =
				"No current view has been reported yet. Tell me which view to close.";
			await callback?.({ text: reply });
			return { success: false, text: reply };
		}
	} else {
		const views = await client.listViews({ viewType });
		const resolution = resolveCloseTargetView(target, views);
		if (resolution.kind === "none") {
			const reply = `No view matches ${describeTargetReference(target)}. Try action=list to see available views.`;
			await callback?.({ text: reply });
			return {
				success: false,
				text: reply,
				data: { target: targetReferenceLogView(target) },
			};
		}
		if (resolution.kind === "ambiguous") {
			const list = resolution.candidates
				.map((view) => `- ${view.label} (${view.id})`)
				.join("\n");
			const reply = `${describeTargetReference(target)} matches multiple views:\n${list}\nWhich one did you mean?`;
			await callback?.({ text: reply });
			return {
				success: false,
				text: reply,
				data: { candidates: resolution.candidates },
			};
		}
		viewId = resolution.view.id;
		label = resolution.view.label;
		resolvedViewType = viewType ?? resolution.view.viewType;
	}

	const result = await navigateViewWithShellAction(
		{ message, options },
		viewId,
		"close",
		`Closed ${label ?? viewId}.`,
		`Requested closing ${label ?? viewId}.`,
		resolvedViewType === "gui" ? undefined : resolvedViewType,
	);
	await callback?.({ text: result.text });
	return {
		success: result.ok,
		text: result.text,
		values: {
			mode: "close",
			viewId,
			viewType: resolvedViewType ?? "gui",
			label: label ?? viewId,
		},
		data: { viewId, viewType: resolvedViewType ?? "gui", action: "close" },
	};
}

async function runViewsLayout({
	client,
	message,
	mode: requestedMode,
	options,
	viewType,
	callback,
}: {
	client: ViewsClient;
	message: Memory;
	mode: "split" | "tile";
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	// Security-unwrapped user words — never the raw (possibly enveloped)
	// content.text; the envelope's warning contains verbs the extractors match.
	const text = userRequestMessageText(message);
	// The shell renders tile mode as a grid. An explicit row/column request
	// must carry split mode as well as its orientation to reach that renderer.
	const mode =
		requestedMode === "tile" && readLayoutValue("", options) !== "grid"
			? "split"
			: requestedMode;
	const views = await client.listViews({ viewType });
	const placement =
		mode === "split" ? readPlacementValue(text, options) : undefined;
	const layoutOnlyFollowup =
		mode === "split" ? isLayoutOnlyFollowupRequest(text, views) : false;
	let targets =
		mode === "split"
			? await completeSplitTargetsWithCurrentView({
					client,
					targets: resolveLayoutTargets(text, options, views),
					views,
					placement,
				})
			: resolveLayoutTargets(text, options, views);
	if (mode === "split") {
		targets = await completeSplitTargetsFromCurrentLayout({
			client,
			targets,
			views,
			preferCurrentLayout: layoutOnlyFollowup,
		});
	}
	const singleViewPlacement =
		mode === "split" && targets.length === 1 && placement !== undefined;
	if (targets.length < 2 && !singleViewPlacement) {
		const reply =
			mode === "split"
				? 'Tell me which two views to put side by side — for example, "split notes and calendar".'
				: 'Tell me which views to tile together — for example, "tile notes and calendar".';
		await callback?.({ text: reply });
		return {
			success: false,
			text: reply,
			data: { mode, resolvedCount: targets.length },
		};
	}

	const layout =
		mode === "tile"
			? "grid"
			: (layoutForPlacement(placement) ?? readLayoutValue(text, options));
	const viewIds = targets.map((view) => view.id);
	const labels = targets.map((view) => view.label).join(", ");
	const action = mode === "split" ? "split-view" : "tile-views";
	const primary = targets[0];
	const resolvedViewType = layoutOnlyFollowup
		? (primary.viewType ?? viewType)
		: (viewType ?? primary.viewType);
	const result = await navigateViewLayout({
		context: { message, options },
		viewId: primary.id,
		action,
		viewIds,
		layout,
		placement,
		viewType: resolvedViewType === "gui" ? undefined : resolvedViewType,
		successText: singleViewPlacement
			? `Placed ${labels} on the ${placement}.`
			: mode === "split"
				? `Split views: ${labels} (${layout}).`
				: `Tiled views: ${labels}.`,
		fallbackText: singleViewPlacement
			? `Requested placing ${labels} on the ${placement}.`
			: mode === "split"
				? `Requested split layout for views: ${labels}.`
				: `Requested tiled layout for views: ${labels}.`,
	});
	await callback?.({ text: result.text });
	return {
		success: result.ok,
		text: result.text,
		values: {
			mode,
			viewIds,
			layout,
			...(placement ? { placement } : {}),
		},
		data: {
			viewId: primary.id,
			viewIds,
			action,
			layout,
			...(placement ? { placement } : {}),
		},
	};
}

function isViewsInteractivePayload(text: string): boolean {
	return ["[CHOICE:", "[FORM]", "[CONFIG:"].some((marker) =>
		text.trim().startsWith(marker),
	);
}

/** Only an interactive UI payload owns delivery; ordinary receipts go to the model. */
function withViewsInteractivePayload(result: ActionResult): ActionResult {
	const text = typeof result.text === "string" ? result.text.trim() : "";
	if (!isViewsInteractivePayload(text)) {
		const {
			userFacingText: _userFacingText,
			verifiedUserFacing: _verifiedUserFacing,
			...evidence
		} = result;
		return {
			...evidence,
			turnComplete: false,
			...(result.success ? { modelReplyRequired: true } : {}),
		};
	}
	return {
		...result,
		userFacingText: text,
		verifiedUserFacing: result.success === true,
	};
}

function ownerRequiredViewMutation(mode: "create" | "delete"): ActionResult {
	return {
		success: false,
		text: `Owner authorization is required for the VIEWS ${mode} operation.`,
		transcriptVisibility: "internal",
		values: { error: "FORBIDDEN", mode },
	};
}

function asViewInteractionDataValue(
	value: unknown,
): object | string | number | boolean | null | undefined {
	if (value === null || value === undefined) return value;
	if (typeof value === "object") return value;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	return String(value);
}

const VIEWS_ROUTING_HINT = [
	"Opening one known app view -> VIEWS_SHOW with view and navigationStepId. UI layouts, catalog discovery and other operations -> VIEWS.",
	"Eliza's home screen is the chat view: return home with VIEWS_SHOW view=chat when available, otherwise VIEWS action=show view=chat. The views-manager is the app list, not home. App navigation never requires turning the user's words into a website URL.",
	"UI Context identifies the open view and its capabilities, not its displayed contents. Answer identity-only questions from that context. To describe visible text, balances, settings, or selections, first inspect the view with get-text or list-elements, or use its domain read action. Configuration diagnostics are not evidence of what the screen displays.",
	"For a request to open, show, switch to, or pull up one known surface, including a bare surface name in any language, prefer VIEWS_SHOW when available; VIEWS action=show is the fallback.",
	"Use VIEWS for close/hide, the view manager, split/tile/window/pin layouts, and explicit capabilities that the selected view declares when no dedicated domain action owns the data.",
	"Opening the Calendar surface uses VIEWS_SHOW when available, otherwise VIEWS action=show; reading or changing calendar events uses CALENDAR. Opening Calendar does not select the requested date. To show a particular day's agenda, open Calendar, then invoke its declared VIEW_CALENDAR_SELECT_VISIBLE_DAY tool directly with date, never as an interact capability. If that tool is not exposed, inspect the view's declared scoped-action steps and execute them with VIEWS interact (agent-click uses params.id); navigate the month first if needed. An event read does not prove UI selection. Verify the displayed selection before saying that day is open.",
	"Reading, searching, creating, updating, or deleting note records uses NOTES, not VIEWS. Pass the complete user-authored note in the single content field; never invent a separate title or body. Do not route Notes to documents or Knowledge.",
	"Phone flashlight requests use action=interact view=device-control capability=set-flashlight with params={enabled:true|false}; never claim success before the capability returns success.",
	"For declared domain capabilities, use action=interact with an explicit view and capability. Semantic record capabilities are required; agent-fill and agent-click are only for an explicitly requested form-control interaction. Pass parameters in params rather than dotted keys.",
	"Close/hide means VIEWS action=close, never delete/remove.",
	"Listing, launching, or restarting installed applications uses APP; only opening the apps/views page uses VIEWS.",
	"Changing a settings or permission value uses SETTINGS; VIEWS only opens the Settings surface.",
	"Reading or changing the owner's todos, goals, reminders, routines, alarms, health, or finances uses the OWNER_* actions; VIEWS only opens those surfaces and never returns that data.",
].join(" ");

export function createViewsAction(deps: ViewsActionDeps = {}): Action {
	const clientFactory = () => deps.client ?? createViewsClient();
	const ownerCheck = deps.hasOwnerAccess ?? defaultOwnerAccessFn;
	const getRepoRoot = () => deps.repoRoot ?? defaultRepoRoot();

	return {
		name: "VIEWS",
		subActions: ["VIEWS_SHOW"],
		contexts: [...VIEW_ACTION_CONTEXTS],
		// `browser` stays out of `contexts` so browser/web retrieval cannot make
		// VIEWS hijack live-information turns. It is allowed at execution time,
		// however, because the response handler can correctly select VIEWS for an
		// explicit request to open the in-app Browser surface.
		contextGate: { anyOf: [...VIEW_ACTION_CONTEXTS, "browser"] },
		roleGate: { minRole: "USER" },
		similes: [
			"VIEW",
			"SHOW_VIEW",
			"OPEN_VIEW",
			"CLOSE_VIEW",
			"CLOSE_ALL_VIEWS",
			"LIST_VIEWS",
			"VIEW_MANAGER",
			"VIEWS_LIST",
			"SWITCH_VIEW",
			"SHOW_APPS",
			"OPEN_APPS",
			"GO_TO_VIEW",
			"NAVIGATE_TO_VIEW",
			"WHAT_VIEWS",
			"BROADCAST_VIEW_EVENT",
			"NOTIFY_VIEW",
			"SIGNAL_VIEW",
			"INTERACT_WITH_VIEW",
			"CLICK_IN_VIEW",
			"INVOKE_VIEW_CAPABILITY",
			"PIN_VIEW",
			"OPEN_VIEW_WINDOW",
			"SPLIT_VIEW",
			"SPLIT_VIEWS",
			"TILE_VIEWS",
			"ARRANGE_VIEWS",
			"USE_VIEW_CAPABILITY",
			"CALL_VIEW_CAPABILITY",
			"SET_FLASHLIGHT",
			"TURN_ON_FLASHLIGHT",
			"TURN_OFF_FLASHLIGHT",
			"CREATE_NOTE",
			"CREATE_STICKY_NOTE",
			"SHOW_NOTES",
			"GET_NOTES",
			"LIST_NOTES",
			"GO_EMAIL",
			"GO_INBOX",
			"OPEN_EMAIL",
			"OPEN_INBOX",
			"SHOW_EMAIL",
			"SHOW_INBOX",
			"CHECK_EMAIL",
			"CHECK_INBOX",
			"READ_EMAIL",
			"CHECK_MESSAGES",
			"OPEN_MESSAGES",
			"READ_MESSAGES",
			"SHOW_MESSAGES",
			"REVISA_CORREO",
			"REVISAR_CORREO",
			"ABRE_CORREO",
			"ABRIR_CORREO",
			"MOSTRAR_CORREO",
			"VER_CORREO",
			"SHOW_WALLET",
			"OPEN_WALLET",
			"OPEN_WALLET_VIEW",
			"WALLET_VIEW",
			"OPEN_SETTINGS",
			"SHOW_SETTINGS",
			"GO_SETTINGS",
			"GO_TO_SETTINGS",
			"NAVIGATE_SETTINGS",
			"SWITCH_SETTINGS",
			"ADD_FEATURE",
			"ADD_APP_FEATURE",
			"BUILD_APP_FEATURE",
			"OPEN_TASK_COORDINATOR",
			"SHOW_TASK_COORDINATOR",
			"OPEN_APP_BUILDER",
			"SHOW_APP_BUILDER",
			"CREATE_VIEW",
			"CREATE_PLUGIN",
			"BUILD_VIEW",
			"MAKE_VIEW",
			"EDIT_VIEW",
			"UPDATE_VIEW",
			"ROLLBACK_VIEW",
			"ROLLBACK_PLUGIN",
			"REVERT_VIEW",
			"REVERT_PLUGIN",
			"UNDO_VIEW_CREATE",
			"UNDO_PLUGIN_CREATE",
			"RESTORE_VIEW",
			"SET_VIEW_ICON",
			"CHANGE_VIEW_ICON",
			"GENERATE_VIEW_ICON",
			"REGENERATE_VIEW_ICON",
			"UPDATE_VIEW_IMAGE",
			"DELETE_VIEW",
			"REMOVE_VIEW",
			"REMOVE_PLUGIN",
			"UNINSTALL_VIEW",
		],
		tags: [
			"views",
			"ui",
			"window",
			"panel",
			"app",
			"layout",
			"view-capability",
			"notes",
			"sticky-notes",
			"calendar",
			"events",
			"email",
			"inbox",
			"messages",
			"correo",
			"wallet",
			"portfolio",
			"finances",
			"budget",
			"subscriptions",
			"focus",
			"distractions",
			"deep-work",
			"goals",
			"routines",
			"reminders",
			"alarms",
			"habits",
			"health",
			"sleep",
			"screen-time",
			"todos",
			"to-do",
			"tasks",
			"checklist",
			"documents",
			"files",
			"docs",
			"contacts",
			"relationships",
			"people",
			"network",
			"settings",
			"preferences",
			"coding",
			"app-builder",
			"task-coordinator",
			"device",
			"hardware",
			"flashlight",
			"torch",
		],
		description:
			"Manage Eliza UI views. For opening one known view, prefer the registered VIEWS_SHOW child; this parent covers layouts, catalog discovery and other operations. Home is view=chat. List available views, report the current view, open or close a view, search views, show the view manager (app list, not home), arrange layouts, and invoke explicit capabilities that a view declares when no dedicated domain action owns the data, including native device controls. Notes records belong to NOTES and calendar events belong to CALENDAR; VIEWS opens those surfaces. action=interact invokes a capability without opening its view. An explicit open-and-edit request requires show/open navigation as well as the data operation.",
		descriptionCompressed:
			"show/open navigates UI; interact invokes capabilities without navigation; Notes data uses NOTES, Calendar data uses CALENDAR; open-and-edit requires both operations",
		routingHint: VIEWS_ROUTING_HINT,
		allowAdditionalParameters: true,
		toolSchemaStrict: false,
		// Navigation and layout modes report their authoritative outcome through
		// their handler callback. Data-bearing capability interactions stay
		// internal and request a model-written finishing pass.
		suppressEarlyReply: true,
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description:
					"Operation: list | current | show | open | close | search | manager | broadcast | interact | pin | window | split | tile | create | edit | icon | rollback | delete | remove, or a registered/generated view capability name to resolve through the view catalog. Use rollback to undo a view/plugin create or edit by resetting its source to the pre-edit snapshot.",
				required: true,
				schema: {
					type: "string",
				},
			},
			{
				name: "mode",
				description: "Legacy alias for action.",
				required: false,
				schema: {
					type: "string",
					enum: [...MODES],
				},
			},
			{
				name: "view",
				description:
					"View name, label, or id (show / open / close / edit / delete). The home/main chat screen is chat; views-manager is the app list.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "navigationIntent",
				description:
					"Use planner-step for an explicit target within a contextual or compound plan; include both view and navigationStepId. The per-step target takes precedence over unrelated original-message clauses.",
				required: false,
				schema: { type: "string", enum: ["planner-step"] },
			},
			{
				name: "navigationStepId",
				description:
					"Required with navigationIntent=planner-step. Supply a unique nonempty step identity, such as open-notes-1, to track navigation separately from domain receipts.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "id",
				description: "Alias for `view`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "name",
				description: "Alias for `view`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "target",
				description:
					"Alias for `view`, especially for close requests such as CLOSE_VIEW { target: 'settings' }.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "subview",
				description:
					"Sub-section to deep-link within the target view (show/open). For the Settings view this is a section token or id (e.g. 'voice', 'model', 'connectors', 'ai-model'); resolved to a canonical section the renderer focuses.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "section",
				description: "Alias for `subview`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "views",
				description:
					"Multiple view ids/names for split or tile mode, e.g. ['notes','calendar'].",
				required: false,
				schema: { type: "array", items: { type: "string" } },
			},
			{
				name: "layout",
				description:
					"Layout for split/tile mode: horizontal, vertical, or grid.",
				required: false,
				schema: { type: "string", enum: ["horizontal", "vertical", "grid"] },
			},
			{
				name: "placement",
				description:
					"Optional split placement hint: left, right, top, or bottom.",
				required: false,
				schema: {
					type: "string",
					enum: ["left", "right", "top", "bottom"],
				},
			},
			{
				name: "query",
				description: "Search keyword (search mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "viewType",
				description:
					'Presentation type to use for view discovery and switching. Defaults to "gui"; "tui" and "xr" are reserved for future alternate view entries.',
				required: false,
				schema: { type: "string", enum: ["gui", "tui", "xr"] },
			},
			{
				name: "search",
				description: "Alias for `query`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "eventType",
				description:
					"Event type to broadcast to all mounted views (broadcast mode), e.g. 'wallet:refresh'.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "payload",
				description: "JSON payload to include with the broadcast event.",
				required: false,
				schema: { type: "object", additionalProperties: true },
			},
			{
				name: "capability",
				description:
					"Exact capability id declared by the target view (interact mode), or a standard agent-surface operation such as agent-click with params.id from the view's controls/scoped steps. Never invent a capability name. Use semantic capabilities for domain record mutations and native device controls; agent-fill/agent-click are only for deliberate form-control interaction, not record creation, updates, or deletion.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "params",
				description:
					"Object parameters for the capability (interact mode), e.g. Notes create uses { content: 'launch checklist' }. Use only parameters declared by that capability and never dotted names like 'params.content'.",
				required: false,
				schema: { type: "object", additionalProperties: true },
			},
			{
				name: "title",
				description:
					"Top-level passthrough only for registered view capabilities that explicitly accept a title. Notes create/update use content instead.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "oldTitle",
				description:
					"Current exact title used to locate a note or event for a rename/update.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "newTitle",
				description:
					"Replacement-title alias for registered view capabilities that expose newTitle.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "body",
				description:
					"Compatibility alias for text capabilities. Prefer the capability's declared field; Notes create/update use content.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "content",
				description:
					"Complete user-authored content for a registered one-field capability, including Notes create/update. Preserve the user's wording and do not add a separate title.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "details",
				description:
					"Top-level passthrough for registered view capabilities that accept details text.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "date",
				description:
					"Top-level passthrough for a registered view capability that accepts an ISO date.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "time",
				description:
					"Top-level passthrough for a registered view capability that accepts a time label.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "notes",
				description:
					"Top-level passthrough for a registered view capability that accepts notes/details text.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "color",
				description:
					"Top-level passthrough for registered view capabilities that accept a color, such as Notes.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "timeoutMs",
				description: "Timeout in ms for interact responses. Default 5000.",
				required: false,
				schema: { type: "number" },
			},
			{
				name: "alwaysOnTop",
				description:
					"When action=window, request that the detached desktop window stays above normal windows.",
				required: false,
				schema: { type: "boolean" },
			},
			{
				name: "intent",
				description:
					"Free-form description of the view to build (create mode). Defaults to the user message text.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "editTarget",
				description:
					"Skip the picker and edit this installed view directly (create mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "taskId",
				description:
					"Exact pending VIEWS create-choice task ID from app_control_choices. Required when more than one view creation is pending; use with choice.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "choice",
				description:
					"Override choice reply (`new` | `edit-N` | `cancel`) for create-mode follow-up turns.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "confirm",
				description:
					"Structured delete confirmation. Set true to confirm and false to cancel a pending delete prompt.",
				required: false,
				schema: { type: "boolean" },
			},
			{
				name: "sha",
				description:
					"Explicit pre-edit snapshot commit id to reset to (rollback mode). Defaults to the most recent recorded snapshot for this room.",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
		): Promise<boolean> => {
			// Security-unwrapped user words — never the raw (possibly enveloped)
			// content.text; the envelope's warning contains verbs the extractors match.
			const text = userRequestMessageText(message);
			const actionOptions = normalizeActionOptions(options);
			const roomId =
				typeof message.roomId === "string" ? message.roomId : runtime.agentId;

			// Multi-turn create follow-up: choice reply matches a pending intent task.
			if (isChoiceReply(text)) {
				if (await hasPendingViewsCreateIntent(runtime, roomId)) {
					return ownerCheck(runtime, message);
				}
			}

			// Multi-turn delete follow-up: structured confirm boolean matches a
			// pending confirm task.
			if (
				isDeleteConfirmation(actionOptions) ||
				isDeleteCancellation(actionOptions)
			) {
				if (await hasPendingDeleteConfirm(runtime, roomId)) {
					return ownerCheck(runtime, message);
				}
			}

			// Create/edit/delete require owner access. The mode must be inferred the
			// same way the handler infers it — including the planner-supplied options
			// the runtime passes here (handlerOptions.parameters). Inferring from text
			// alone let a planner `{action:"delete"}` whose text lacked a "view"/
			// "plugin" noun escape the gate while the handler still mutated.
			const mode = inferMode(text, actionOptions);
			if (
				mode === "create" ||
				mode === "edit" ||
				mode === "icon" ||
				mode === "rollback" ||
				mode === "delete" ||
				mode === "remove"
			) {
				return ownerCheck(runtime, message);
			}

			if (messageHasNoViewSurface(message)) {
				// Desktop-only navigation/layout ops are invisible on a text connector
				// that can't render views for the asker. Offering them there lets the
				// planner pick VIEWS as a silent terminal action (no chat reply) — drop
				// them so the turn falls back to a real REPLY. Text/content modes stay
				// available everywhere. (#8613)
				if (mode && DESKTOP_ONLY_VIEW_MODES.has(mode)) {
					return false;
				}
				// No inferable view intent at all. This is how the runtime composes the
				// planner's action surface (validate is called without planner options),
				// so returning true here exposes VIEWS — whose description tells the
				// planner view switching is a proactive DEFAULT — on an ordinary chat
				// turn over a connector that renders no views. The planner then claims
				// a navigation it structurally cannot perform ("Opening your
				// Relationships now" into a Discord channel, observed live). Keep VIEWS
				// off the surface unless a multi-turn views flow is pending in this
				// room; execution-time validate re-checks with the planner's options,
				// so every mode-carrying call above still resolves normally.
				if (!mode) {
					if (await hasPendingViewsCreateIntent(runtime, roomId)) {
						return ownerCheck(runtime, message);
					}
					if (await hasPendingDeleteConfirm(runtime, roomId)) {
						return ownerCheck(runtime, message);
					}
					return false;
				}
			}

			// Read modes are visible to all users.
			return true;
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			deliveryCallback?: HandlerCallback,
		): Promise<ActionResult> => {
			// Only interactive payloads bypass the model's grounded final reply.
			const callback: HandlerCallback | undefined = deliveryCallback
				? async (content, actionName) =>
						isViewsInteractivePayload(content.text ?? "")
							? deliveryCallback(content, actionName)
							: []
				: undefined;
			let navigationSelected = false;
			const shellContext = {
				message,
				options: normalizeActionOptions(options),
			};
			const run = async (): Promise<ActionResult> => {
				const actionOptions = shellContext.options;
				const client = clientFactory();
				// Security-unwrapped user words — never the raw (possibly enveloped)
				// content.text; the envelope's warning contains verbs the extractors match.
				const text = userRequestMessageText(message);
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;

				const mode = inferMode(text, actionOptions);
				// A pending flow cannot change the operation explicitly selected by
				// the planner, especially the navigation-only VIEWS_SHOW child.
				if ((!mode || mode === "create") && isChoiceReply(text)) {
					if (await hasPendingViewsCreateIntent(runtime, roomId)) {
						if (!(await ownerCheck(runtime, message))) {
							return ownerRequiredViewMutation("create");
						}
						const views = await client.listViews();
						return runViewsCreate({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}
				}

				// Multi-turn follow-up: structured confirmation for a pending delete.
				if (
					(!mode || mode === "delete") &&
					(isDeleteConfirmation(actionOptions) ||
						isDeleteCancellation(actionOptions))
				) {
					if (await hasPendingDeleteConfirm(runtime, roomId)) {
						if (!(await ownerCheck(runtime, message))) {
							return ownerRequiredViewMutation("delete");
						}
						const views = await client.listViews();
						return runViewsDelete({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}
				}

				const viewType = readViewTypeOption(text, actionOptions);
				if (!mode) {
					const reply =
						'Tell me what to do with views. Try: "list views", "open wallet view", "create a new view", or "delete the LifeOps plugin".';
					await callback?.({ text: reply });
					return { success: false, text: reply };
				}

				let effectiveMode = mode;
				let prefetchedViews: ViewSummary[] | null = null;
				let prefetchedCurrentView:
					| Awaited<ReturnType<ViewsClient["getCurrentView"]>>
					| null
					| undefined;
				let forcedResolvedCapability: ResolvedViewCapability | null = null;
				const getViews = async () => {
					prefetchedViews ??= await client.listViews();
					return prefetchedViews;
				};
				const getCurrentView = async () => {
					// error-policy:J4 current-view read over loopback; unreachable -> null -> resolver degrades to no current-view context
					prefetchedCurrentView ??= await client
						.getCurrentView()
						.catch(() => null);
					return prefetchedCurrentView;
				};

				if (effectiveMode === "interact") {
					const views = await getViews().catch(() => []);
					effectiveMode =
						preferLayoutModeOverCapability({
							text,
							options: actionOptions,
							views,
						}) ?? effectiveMode;
				}

				if (shouldResolveModeAsCapability(effectiveMode, text, actionOptions)) {
					const capabilityResolutionViews = await getViews();
					const currentView = await getCurrentView();
					forcedResolvedCapability = resolveViewCapability({
						views: capabilityResolutionViews,
						text,
						options: actionOptions,
						viewType,
						currentViewId: currentView?.viewId,
					});
					if (forcedResolvedCapability) {
						effectiveMode = "interact";
					}
				}

				logger.info(
					`[plugin-app-control] VIEWS requestedMode=${mode} effectiveMode=${effectiveMode} action=${readStringOption(actionOptions, "action") ?? "inferred"} view=${readViewTargetOption(actionOptions) ?? "none"} resolvedCapability=${forcedResolvedCapability ? `${forcedResolvedCapability.view.id}:${forcedResolvedCapability.capability.id}` : "none"}`,
				);

				navigationSelected = [
					"close",
					"manager",
					"pin",
					"window",
					"split",
					"tile",
				].includes(effectiveMode);
				if (navigationSelected) {
					const blocked = blockedShellNavigation(
						{ message, options: actionOptions },
						readStringOption(actionOptions, "view"),
					);
					if (blocked) return { success: false, text: blocked.text };
				}

				switch (effectiveMode) {
					case "list":
						return runViewsList({ client, viewType });

					case "current": {
						const currentView = await client.getCurrentView();
						const resultText = currentView
							? `Current view: ${currentView.viewLabel} (${currentView.viewType}) — ${currentView.viewId}${currentView.viewPath ? ` at ${currentView.viewPath}` : ""}.`
							: "No current view has been reported yet.";

						return {
							success: true,
							text: resultText,
							values: {
								mode: "current",
								viewId: currentView?.viewId,
								viewType: currentView?.viewType,
							},
							data: { currentView },
						};
					}

					case "show":
					case "open":
						return runViewsShow({
							client,
							message,
							options: actionOptions,
							viewType,
							callback,
							originatingClientId: readViewInteractionClientId(message),
							resolveCallerRoles: async () =>
								(await ownerCheck(runtime, message))
									? ["OWNER"]
									: resolveViewCallerRoles(runtime, message),
						});

					case "close":
						return runViewsClose({
							client,
							message,
							options: actionOptions,
							viewType,
							callback,
						});

					case "search": {
						const query = extractSearchQuery(text, actionOptions);
						return runViewsSearch({ client, query, viewType, callback });
					}

					case "manager": {
						const managerView = {
							id: "__view-manager__",
							label: "View Manager",
							path: "/views",
							pluginName: "core",
							available: true,
						};
						const result = await navigateToPath(
							{ message, options: actionOptions },
							managerView.path,
							managerView.label,
						);
						await callback?.({ text: result.text });
						return {
							success: result.ok,
							text: result.text,
							values: { mode: "manager" },
							data: { view: managerView },
						};
					}

					case "broadcast": {
						const eventType =
							readStringOption(actionOptions, "eventType") ??
							readStringOption(actionOptions, "event") ??
							readStringOption(actionOptions, "type");
						if (!eventType) {
							const reply =
								"Specify an event type to broadcast, e.g. action=broadcast eventType=wallet:refresh.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						const payload =
							actionOptions?.payload !== null &&
							typeof actionOptions?.payload === "object" &&
							!Array.isArray(actionOptions?.payload)
								? (actionOptions.payload as Record<string, unknown>)
								: {};
						const result = await broadcastViewEvent(eventType, payload);
						await callback?.({ text: result.text });
						return {
							success: result.ok,
							text: result.text,
							values: { mode: "broadcast", eventType },
							data: { eventType, payload },
						};
					}

					case "interact": {
						let viewId = readCatalogViewTargetOption(actionOptions);
						let capability = readStringOption(actionOptions, "capability");
						let resolvedViewType = viewType;
						const views = await getViews().catch(() => []);
						if (!viewId && /\bcurrent\b/i.test(text)) {
							const currentView = await getCurrentView();
							viewId = currentView?.viewId ?? null;
							resolvedViewType = viewType ?? currentView?.viewType;
						}
						const currentViewForResolution =
							!viewId && !forcedResolvedCapability
								? await getCurrentView()
								: null;
						// Only INFER a target from the message text when the caller did not
						// name both a view and a capability. An explicit `view` +
						// `capability` is a structured planner decision, and
						// resolveViewCapability is a text heuristic that overwrites both on
						// a match — so `interact view=scenario-active-ledger
						// capability=agent-click` was being dispatched onto an unrelated
						// surface (task-coordinator's "list-sessions"), which then rejected
						// the caller's own params. Skipping the heuristic here leaves the
						// explicit view to the `matches`/alias resolution below, which is
						// already scoped to that one view.
						const shouldInferTarget = !viewId || !capability;
						let resolvedCapability =
							forcedResolvedCapability ??
							(shouldInferTarget
								? resolveViewCapability({
										views,
										text,
										options: actionOptions,
										viewType,
										currentViewId: viewId ?? currentViewForResolution?.viewId,
									})
								: null);
						if (!resolvedCapability && (!viewId || !capability)) {
							const currentView = await getCurrentView();
							resolvedCapability = resolveViewCapability({
								views,
								text,
								options: actionOptions,
								viewType,
								currentViewId: currentView?.viewId,
							});
							if (!viewId && currentView?.viewId) {
								resolvedViewType = viewType ?? currentView.viewType;
							}
						}
						if (resolvedCapability) {
							viewId = resolvedCapability.view.id;
							capability = resolvedCapability.capability.id;
							resolvedViewType = viewType ?? resolvedCapability.view.viewType;
						} else if (viewId) {
							const resolved = resolveViewTarget(viewId, views);
							if (resolved) {
								viewId = resolved.id;
								resolvedViewType = viewType ?? resolved.viewType;
							}
						}
						if (!viewId || !capability) {
							// Planner-facing tool syntax, not a chat reply — return it to
							// the planner without a user callback and mark it internal so
							// core's transcript-visibility resolver can spot an evaluator
							// echo of it.
							return {
								success: false,
								text: "Specify view and capability, e.g. action=interact view=wallet capability=get-state, or ask for the current view after navigating.",
								transcriptVisibility: "internal",
							};
						}
						const resolvedView =
							resolvedCapability?.view ?? resolveViewTarget(viewId, views);
						const standardCapability = STANDARD_VIEW_CAPABILITY_BY_KEY.get(
							normalizeCapabilityKey(capability),
						);
						if (!resolvedCapability && resolvedView) {
							const humanOnlyCapability = (
								resolvedView.capabilities ?? []
							).find(
								(candidate) =>
									candidate.authority === "human" &&
									normalizeCapabilityKey(candidate.id) ===
										normalizeCapabilityKey(capability),
							);
							if (humanOnlyCapability) {
								return {
									success: false,
									text: `Capability "${humanOnlyCapability.id}" on view "${resolvedView.id}" requires direct human interaction.`,
									transcriptVisibility: "internal",
								};
							}
							const matches = (resolvedView.capabilities ?? []).filter(
								(candidate) =>
									candidate.authority !== "human" &&
									normalizeCapabilityKey(candidate.id) ===
										normalizeCapabilityKey(capability),
							);
							if (matches.length === 1 && matches[0]) {
								resolvedCapability = {
									view: resolvedView,
									capability: matches[0],
								};
								capability = matches[0].id;
							} else if (matches.length === 0 && !standardCapability) {
								const scopedAction = resolvedView.scopedActions?.find(
									(action) => action.name === capability,
								);
								if (scopedAction) {
									// A known action in the capability slot is a no-effect
									// preflight error, never an alias for another operation.
									return {
										success: false,
										transcriptVisibility: "internal",
										text: `"${capability}" is a view-scoped action name, not a VIEWS interact capability. No interaction was dispatched. Invoke that action by name only if it is exposed in your tool list. Otherwise use VIEWS action=interact on this view for each declared step: step.kind is capability, step.target is params.id, and step.value is params.value for agent-fill. Substitute declared parameter references with the supplied values. A successful interaction result is still required to prove the requested UI change.`,
										data: {
											coachingFailure: true,
											viewId,
											scopedAction,
										},
									};
								}
							}
						}
						if (!resolvedCapability && !standardCapability) {
							if (
								resolvedView?.id === "browser" &&
								["browse", "navigate", "open"].includes(
									normalizeCapabilityKey(capability),
								)
							) {
								if (!(await ownerCheck(runtime, message))) {
									const reply =
										"Browser control is only available to the workspace owner.";
									await callback?.({ text: reply });
									return { success: false, text: reply };
								}
								const browserAction = runtime.actions.find(
									(action) => action.name === "BROWSER",
								);
								if (!browserAction?.handler) {
									const reply =
										"Browser control is unavailable in this runtime.";
									await callback?.({ text: reply });
									return { success: false, text: reply };
								}
								const nestedParams =
									actionOptions?.params &&
									typeof actionOptions.params === "object" &&
									!Array.isArray(actionOptions.params)
										? actionOptions.params
										: {};
								const browserParameters = {
									...nestedParams,
									action: "navigate",
								};
								if (!(await browserAction.validate(runtime, message, _state))) {
									const reply = "Browser control rejected this request.";
									await callback?.({ text: reply });
									return { success: false, text: reply };
								}
								return (
									(await browserAction.handler(
										runtime,
										message,
										_state,
										{ ...options, parameters: browserParameters },
										callback,
									)) ?? {
										success: true,
										text: "Browser navigation completed.",
									}
								);
							}
							// Catalog diagnostics return to the planner via the result,
							// never straight to the user (same policy as the HTTP
							// interaction failure below).
							return {
								success: false,
								text: `Cannot invoke capability "${capability}" on view "${viewId}": the view catalog does not declare that capability. No interaction was dispatched. Choose a declared capability or use the exact agent-surface steps from a scoped action; step.kind is the capability and step.target is params.id.`,
								transcriptVisibility: "internal",
								data: {
									viewId,
									capabilities: resolvedView?.capabilities ?? [],
									scopedActions: resolvedView?.scopedActions ?? [],
								},
							};
						}
						if (!resolvedCapability && standardCapability)
							capability = standardCapability;
						if (resolvedCapability) {
							const correction = correctCapabilityOperationFamily(
								resolvedCapability.view,
								resolvedCapability.capability,
								text,
							);
							if (correction.kind === "reject") {
								return {
									success: false,
									text: `Refusing destructive capability on view "${viewId}": ${correction.reason}. Please rephrase with explicit, unambiguous intent.`,
									transcriptVisibility: "internal",
								};
							}
							if (
								correction.capability.id !== resolvedCapability.capability.id
							) {
								resolvedCapability = {
									...resolvedCapability,
									capability: correction.capability,
								};
								capability = correction.capability.id;
							}
						}
						const authorizedView = resolvedCapability?.view ?? resolvedView;
						const viewGate = authorizedView?.roleGate;
						const ownerExclusive =
							viewGate !== undefined &&
							satisfiesRoleGate(["OWNER"], viewGate) &&
							!satisfiesRoleGate(["ADMIN"], viewGate);
						const viewAllowed = !viewGate
							? true
							: ownerExclusive
								? await ownerCheck(runtime, message)
								: satisfiesRoleGate(
										await resolveViewCallerRoles(runtime, message),
										viewGate,
									);
						if (!viewAllowed && authorizedView) {
							return {
								success: false,
								text: `The ${authorizedView.label} view is not available to this caller.`,
								transcriptVisibility: "internal",
							};
						}
						const paramsResolution = readCapabilityParams(
							actionOptions,
							resolvedCapability?.capability,
							text,
						);
						if (!paramsResolution.ok) {
							return {
								success: false,
								text: `Cannot invoke capability "${capability}" on view "${viewId}": ${paramsResolution.error}.`,
								transcriptVisibility: "internal",
							};
						}
						let params = paramsResolution.params;
						// Bind note-title deletion to the owner's current wording without
						// widening unrelated capability schemas.
						if (normalizeCapabilityKey(capability) === "delete note" && text) {
							params = { ...params, ownerText: text };
						}
						const timeoutMs =
							typeof actionOptions?.timeoutMs === "number" &&
							actionOptions.timeoutMs > 0
								? actionOptions.timeoutMs
								: 5_000;
						const interaction = await interactWithView(
							viewId,
							capability,
							params,
							timeoutMs,
							resolvedViewType,
							readViewInteractionClientId(message),
						);
						const resultText = interaction.text;
						const receipt = interaction.success
							? readViewInteractionReceipt(interaction.result)
							: undefined;
						const effectContract = interaction.success
							? readViewInteractionEffectContract(interaction.result)
							: undefined;
						const interactionPayload =
							interaction.result !== null &&
							typeof interaction.result === "object" &&
							!Array.isArray(interaction.result) &&
							"result" in interaction.result
								? (interaction.result as Record<string, unknown>).result
								: interaction.result;
						// Capability results are structured facts for the planner, not a
						// preformatted chat reply. Keep both success and failure text off the
						// user callback and require one model-owned finishing pass on success.
						// This preserves a consistent Eliza voice while receipts keep mutation
						// claims grounded in the actual view interaction.
						return {
							success: interaction.success,
							text: resultText,
							transcriptVisibility: "internal",
							...(interaction.success
								? {
										modelReplyRequired: true,
										turnComplete: false,
									}
								: {}),
							...(effectContract ?? {}),
							values: {
								mode: "interact",
								viewId,
								viewType: resolvedViewType ?? "gui",
								capability,
							},
							data: {
								viewId,
								viewType: resolvedViewType ?? "gui",
								capability,
								params,
								result: asViewInteractionDataValue(interactionPayload),
								...(receipt ? { receipt } : {}),
							},
						};
					}

					case "create": {
						// Planner-supplied choices can continue a pending task even when
						// the user's words are not a literal new/edit-N/cancel token.
						if (!(await ownerCheck(runtime, message))) {
							return ownerRequiredViewMutation("create");
						}
						const views = await client.listViews();
						return runViewsCreate({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "edit": {
						const views = await client.listViews();
						return runViewsEdit({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "icon": {
						const views = await client.listViews();
						return runViewsIcon({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "rollback":
						return runViewsRollback({
							runtime,
							message,
							options: actionOptions,
							callback,
						});

					case "delete":
					case "remove": {
						if (!(await ownerCheck(runtime, message))) {
							return ownerRequiredViewMutation("delete");
						}
						const views = await client.listViews();
						return runViewsDelete({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "pin": {
						const resolution = await resolveSingleShellTargetView({
							client,
							text,
							options: actionOptions,
							viewType,
						});
						if (resolution.kind === "none") {
							const reply =
								"Specify which view to pin as a desktop tab, e.g. action=pin view=wallet.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						if (resolution.kind === "ambiguous") {
							const list = resolution.candidates
								.map((view) => `- ${view.label} (${view.id})`)
								.join("\n");
							const reply = `That matches multiple views:\n${list}\nWhich one should I pin?`;
							await callback?.({ text: reply });
							return {
								success: false,
								text: reply,
								data: { candidates: resolution.candidates },
							};
						}
						const pinView = resolution.view;
						const resolvedViewType =
							readExplicitViewTypeOption(options) ??
							viewType ??
							pinView.viewType ??
							(await resolveViewTypeForId(client, pinView.id));
						const pinResult = await pinViewAsTab(
							{ message, options: actionOptions },
							pinView.id,
							resolvedViewType === "gui" ? undefined : resolvedViewType,
						);
						await callback?.({ text: pinResult.text });
						return {
							success: pinResult.ok,
							text: pinResult.text,
							values: {
								mode: "pin",
								viewId: pinView.id,
								viewType: resolvedViewType ?? "gui",
							},
							data: { viewId: pinView.id, viewType: resolvedViewType ?? "gui" },
						};
					}

					case "window": {
						const resolution = await resolveSingleShellTargetView({
							client,
							text,
							options: actionOptions,
							viewType,
						});
						const alwaysOnTop = readBooleanOption(actionOptions, "alwaysOnTop");
						if (resolution.kind === "none") {
							const reply =
								"Specify which view to open in a new window, e.g. action=window view=wallet.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						if (resolution.kind === "ambiguous") {
							const list = resolution.candidates
								.map((view) => `- ${view.label} (${view.id})`)
								.join("\n");
							const reply = `That matches multiple views:\n${list}\nWhich one should I open in a new window?`;
							await callback?.({ text: reply });
							return {
								success: false,
								text: reply,
								data: { candidates: resolution.candidates },
							};
						}
						const windowView = resolution.view;
						const resolvedViewType =
							readExplicitViewTypeOption(options) ??
							viewType ??
							windowView.viewType ??
							(await resolveViewTypeForId(client, windowView.id));
						const windowResult = await openViewInWindow(
							{ message, options: actionOptions },
							windowView.id,
							resolvedViewType === "gui" ? undefined : resolvedViewType,
							alwaysOnTop,
						);
						await callback?.({ text: windowResult.text });
						return {
							success: windowResult.ok,
							text: windowResult.text,
							values: {
								mode: "window",
								viewId: windowView.id,
								viewType: resolvedViewType ?? "gui",
								alwaysOnTop,
							},
							data: {
								viewId: windowView.id,
								viewType: resolvedViewType ?? "gui",
								alwaysOnTop,
							},
						};
					}

					case "split":
					case "tile":
						return runViewsLayout({
							client,
							message,
							mode: effectiveMode,
							options: actionOptions,
							viewType,
							callback,
						});
				}
			};

			try {
				const result = await run();
				const blocked =
					navigationSelected && !result.success
						? blockedShellNavigation(shellContext, null)
						: undefined;
				return withViewsInteractivePayload(
					blocked
						? {
								success: false,
								text: blocked.text,
								data: { navigation: blocked.receipt },
							}
						: result,
				);
			} catch (error) {
				// error-policy:J1 translate canonical cancellation at the navigation action boundary; other failures remain explicit.
				const blocked = navigationSelected
					? blockedShellNavigation(shellContext, null)
					: undefined;
				if (blocked)
					return {
						success: false,
						text: blocked.text,
						data: { navigation: blocked.receipt },
					};
				throw error;
			}
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "list views" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "available_views:\n  count: 3\nviews[3]{id,label,path,available}:\n  wallet.inventory,Wallet,/wallet,yes\n  chat,Chat,/,yes\n  settings,Settings,/settings,yes",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open wallet view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Navigated to Wallet.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "search views finance" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Views matching "finance" (1):\n  [60] Wallet (wallet.inventory) — /wallet — Track your crypto balances.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open view manager" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Navigated to View Manager.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "split notes and calendar side by side" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Split views: Notes, Calendar (horizontal).",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "tile notes calendar and trajectories" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Tiled views: Notes, Calendar, Trajectories.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "tell the wallet view to refresh" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Broadcast view event "wallet:refresh" to all connected views.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "get the state of the settings view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Interacted with view "settings" — capability "get-state" (returned theme and language).',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: {
						text: "create a sticky note titled launch checklist with body test auth and billing",
					},
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Created note "launch checklist".',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "show my notes" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "1 note.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "create a new view for tracking habits" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "[CHOICE:views-create id=views-create-…]\nnew = Create a new view plugin\ncancel = Cancel\n[/CHOICE]",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "edit the wallet view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Started view edit task for Wallet at /…/plugins/plugin-wallet. Task session abc123 is running.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "delete the LifeOps plugin" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Are you sure you want to delete the LifeOps view (@elizaos/plugin-personal-assistant)? Confirm with confirm=true, or cancel with confirm=false.",
						action: "VIEWS",
					},
				},
			],
		],
	};
}

/** Single-destination navigation with a complete planner-step contract. The
 * parent remains discoverable for layouts, catalog reads and interactions. */
export function createShowViewAction(deps: ViewsActionDeps = {}): Action {
	const parent = createViewsAction(deps);
	const navigationOptions = (options?: Record<string, unknown>) => {
		const params = normalizeActionOptions(options);
		return {
			action: "show",
			navigationIntent: "planner-step",
			view: readStringOption(params, "view"),
			navigationStepId: readStringOption(params, "navigationStepId"),
		};
	};
	return {
		...parent,
		name: "VIEWS_SHOW",
		subActions: undefined,
		similes: [],
		examples: [],
		description:
			"Open one authorized app view in the originating user's app. Supply the catalog view ID (Home is chat) and a unique navigation step ID. This only navigates: it never reads or changes records, selects a calendar date, or proves domain work complete. For another operation, compound layout or unknown destination, discover VIEWS. Respect the full request's navigation and destination restrictions; use the delivery receipt to report the outcome.",
		descriptionCompressed: "Open one authorized app view; navigation only.",
		routingHint:
			"Opening one known app view -> VIEWS_SHOW with view and navigationStepId. Layouts, catalog discovery and interactions -> VIEWS. Domain records still use their owning tools.",
		parameters: parent.parameters
			?.filter(({ name }) => name === "view" || name === "navigationStepId")
			.map((parameter) => ({ ...parameter, required: true })),
		allowAdditionalParameters: false,
		// This closed child has only required arguments; the polymorphic
		// parent's opt-out would disable strictness for the entire planner call.
		toolSchemaStrict: true,
		validate: (runtime, message, state, options) =>
			parent.validate(runtime, message, state, navigationOptions(options)),
		handler: (runtime, message, state, options, callback) =>
			parent.handler(
				runtime,
				message,
				state,
				navigationOptions(options),
				callback,
			),
	};
}

export function createViewsAliasAction(
	name: "CLOSE_VIEW" | "CLOSE_ALL_VIEWS",
	deps: ViewsActionDeps = {},
): Action {
	const action = createViewsAction(deps);
	const closeAll = name === "CLOSE_ALL_VIEWS";
	const targetParameters: Action["parameters"] = closeAll
		? []
		: [
				{
					name: "view",
					description: "View name, label, or id to close.",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "id",
					description: "Alias for view.",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "name",
					description: "Alias for view.",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "target",
					description: "Alias for view.",
					required: false,
					schema: { type: "string" },
				},
			];
	return {
		...action,
		name,
		subActions: undefined,
		parameters: targetParameters,
		allowAdditionalParameters: false,
		tags: closeAll
			? ["close", "hide", "dismiss", "tabs", "windows"]
			: ["close", "hide", "dismiss", "panel", "tab"],
		similes: closeAll
			? ["CLOSE_ALL_VIEW_TABS", "HIDE_ALL_VIEWS", "DISMISS_ALL_VIEWS"]
			: ["HIDE_VIEW", "DISMISS_VIEW", "CLOSE_PANEL", "CLOSE_APP_VIEW"],
		description: closeAll
			? "Close or hide all currently open UI views/tabs without deleting plugins."
			: "Close or hide one UI view/tab without deleting its plugin. Accepts view, id, name, or target.",
		descriptionCompressed: closeAll
			? "close all open UI views/tabs; never deletes plugins"
			: "close one UI view/tab by view/id/name/target; never deletes plugins",
		routingHint: closeAll
			? "Close, hide, or dismiss every open UI view/tab -> CLOSE_ALL_VIEWS. Never use this to open a view or delete a plugin."
			: "Close, hide, or dismiss one open UI view/tab -> CLOSE_VIEW. Never use this to open a view or delete a plugin.",
		handler: async (runtime, message, state, options, callback) => {
			const actionOptions = {
				...normalizeActionOptions(options),
				action: "close",
				mode: "close",
				...(closeAll ? { all: true, target: "__all__" } : {}),
			};
			return action.handler(runtime, message, state, actionOptions, callback);
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ShellNavigationContext = {
	message: Memory;
	options?: Record<string, unknown>;
};

function blockedShellNavigation(
	context: ShellNavigationContext,
	viewId: string | null,
): ShellNavResult | undefined {
	const status = navigationDispatchBlock(
		context.message,
		context.options?.navigationIntent === "planner-step",
	);
	if (!status) return undefined;
	const receipt: NavigationReceipt = {
		effect: "view_navigation",
		stepId: readStringOption(context.options, "navigationStepId"),
		viewId,
		status,
	};
	return { ok: false, text: JSON.stringify(receipt), receipt };
}

/**
 * Outcome of a shell-navigation request. `ok` is true when the shell accepted
 * the request (2xx) or genuinely does not implement the route (501/404) — the
 * latter is a soft success on shells that don't support a given capability.
 * `ok` is false for real transport failures (other non-2xx, network, timeout)
 * so the action surfaces a failure instead of claiming the UI changed.
 */
interface ShellNavResult {
	receipt?: NavigationReceipt;
	ok: boolean;
	text: string;
}

async function navigateToPath(
	context: ShellNavigationContext,
	pathStr: string,
	label: string,
): Promise<ShellNavResult> {
	const blocked = blockedShellNavigation(context, null);
	if (blocked) return blocked;
	const base = getAppControlApiBase();

	try {
		const resp = await fetch(`${base}/api/views/__view-manager__/navigate`, {
			method: "POST",
			headers: createViewsRequestHeaders(),
			body: JSON.stringify({ path: pathStr }),
			signal: navigationRequestSignal(5_000),
		});
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return { ok: true, text: `Navigated to ${label}.` };
		}
		logger.warn(
			`[plugin-app-control] VIEWS/manager navigate returned ${resp.status}`,
		);
	} catch (err) {
		// error-policy:J1 translate navigation transport failure without dispatching after cancellation.
		const blocked = blockedShellNavigation(context, null);
		if (blocked) return blocked;
		logger.warn(
			`[plugin-app-control] VIEWS/manager navigate failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		ok: false,
		text: `Couldn't navigate to ${label} — the shell did not confirm the change.`,
	};
}

async function navigateViewWithShellAction(
	context: ShellNavigationContext,
	viewId: string,
	action: "pin-tab" | "open-window" | "close" | "close-all",
	successText: string,
	fallbackText: string,
	viewType?: ViewType,
	alwaysOnTop = false,
): Promise<ShellNavResult> {
	const blocked = blockedShellNavigation(context, null);
	if (blocked) return blocked;
	const base = getAppControlApiBase();

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/navigate${viewType ? `?viewType=${viewType}` : ""}`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({ action, viewType, alwaysOnTop }),
				signal: navigationRequestSignal(5_000),
			},
		);
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return { ok: true, text: successText };
		}
		logger.warn(
			`[plugin-app-control] VIEWS/${action} navigate returned ${resp.status}`,
		);
	} catch (err) {
		// error-policy:J1 translate navigation transport failure without dispatching after cancellation.
		const blocked = blockedShellNavigation(context, null);
		if (blocked) return blocked;
		logger.warn(
			`[plugin-app-control] VIEWS/${action} navigate failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return { ok: false, text: fallbackText };
}

async function navigateViewLayout({
	context,
	viewId,
	action,
	viewIds,
	layout,
	placement,
	viewType,
	successText,
	fallbackText,
}: {
	viewId: string;
	context: ShellNavigationContext;
	action: "split-view" | "tile-views";
	viewIds: string[];
	layout: "horizontal" | "vertical" | "grid";
	placement?: "left" | "right" | "top" | "bottom";
	viewType?: ViewType;
	successText: string;
	fallbackText: string;
}): Promise<ShellNavResult> {
	const blocked = blockedShellNavigation(context, null);
	if (blocked) return blocked;
	const base = getAppControlApiBase();

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/navigate${viewType ? `?viewType=${viewType}` : ""}`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({
					action,
					views: viewIds,
					layout,
					...(placement ? { placement } : {}),
					...(viewType ? { viewType } : {}),
				}),
				signal: navigationRequestSignal(5_000),
			},
		);
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return { ok: true, text: successText };
		}
		logger.warn(
			`[plugin-app-control] VIEWS/${action} navigate returned ${resp.status}`,
		);
	} catch (err) {
		// error-policy:J1 translate navigation transport failure without dispatching after cancellation.
		const blocked = blockedShellNavigation(context, null);
		if (blocked) return blocked;
		logger.warn(
			`[plugin-app-control] VIEWS/${action} navigate failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return { ok: false, text: fallbackText };
}

function pinViewAsTab(
	context: ShellNavigationContext,
	viewId: string,
	viewType?: ViewType,
): Promise<ShellNavResult> {
	return navigateViewWithShellAction(
		context,
		viewId,
		"pin-tab",
		`Pinned ${viewType ?? "gui"} view "${viewId}" as a desktop tab.`,
		`Requested desktop tab pin for ${viewType ?? "gui"} view "${viewId}".`,
		viewType,
	);
}

function openViewInWindow(
	context: ShellNavigationContext,
	viewId: string,
	viewType?: ViewType,
	alwaysOnTop = false,
): Promise<ShellNavResult> {
	return navigateViewWithShellAction(
		context,
		viewId,
		"open-window",
		`Opened ${viewType ?? "gui"} view "${viewId}" in a separate window.`,
		`Requested separate window for ${viewType ?? "gui"} view "${viewId}".`,
		viewType,
		alwaysOnTop,
	);
}

/**
 * POST /api/views/:id/interact — invoke a capability on a mounted view and
 * return the result. Waits up to timeoutMs for the frontend to respond.
 */
async function interactWithView(
	viewId: string,
	capability: string,
	params: Record<string, unknown> | undefined,
	timeoutMs: number,
	viewType?: ViewType,
	clientId?: string,
): Promise<{ success: boolean; text: string; result?: unknown }> {
	const base = getAppControlApiBase();

	let resp: Response;
	try {
		resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/interact${viewType ? `?viewType=${viewType}` : ""}`,
			{
				method: "POST",
				headers: {
					...createViewsRequestHeaders(),
					...(clientId ? { "X-ElizaOS-Client-Id": clientId } : {}),
				},
				body: JSON.stringify({ capability, params, timeoutMs, viewType }),
				signal: AbortSignal.timeout(timeoutMs + 1_000),
			},
		);
	} catch (err) {
		logger.warn(
			`[plugin-app-control] VIEWS/interact network error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return {
			success: false,
			text: `Failed to interact with view "${viewId}": network error.`,
		};
	}

	if (resp.status === 504) {
		return {
			success: false,
			text: `View "${viewId}" did not respond to capability "${capability}" within ${timeoutMs}ms.`,
		};
	}
	if (resp.status === 404) {
		return {
			success: false,
			text: `View "${viewId}" not found or not mounted.`,
		};
	}
	if (resp.status === 400) {
		let detail = "";
		try {
			const body = (await resp.json()) as Record<string, unknown>;
			detail = typeof body.error === "string" ? ` — ${body.error}` : "";
		} catch {
			/* ignore */
		}
		return {
			success: false,
			text: `Cannot invoke capability "${capability}" on view "${viewId}"${detail}.`,
		};
	}
	if (!resp.ok) {
		logger.warn(
			`[plugin-app-control] VIEWS/interact returned ${resp.status} for view "${viewId}"`,
		);
		return {
			success: false,
			text: `Interact with view "${viewId}" failed (HTTP ${resp.status}).`,
		};
	}

	const parsed = await parseViewInteractionResponse(resp);
	if (!parsed.ok) {
		return {
			success: false,
			text: `Interact with view "${viewId}" failed: ${parsed.error}.`,
		};
	}

	const result = parsed.body;
	const text = textFromInteractionResult(result);
	const success = parsed.success && successFromInteractionResult(result);
	if (text) return { success, text, result };

	return {
		success,
		text: `Interacted with view "${viewId}" — capability "${capability}" (${summarizeInteractionResult(result)}).`,
		result,
	};
}

function summarizeInteractionResult(result: unknown): string {
	if (Array.isArray(result)) {
		return `returned ${result.length} item${result.length === 1 ? "" : "s"}`;
	}
	if (!result || typeof result !== "object") {
		return "completed with no additional details";
	}
	const record = result as Record<string, unknown>;
	const payload =
		record.result &&
		typeof record.result === "object" &&
		!Array.isArray(record.result)
			? (record.result as Record<string, unknown>)
			: record;
	const keys = Object.keys(payload).filter(
		(key) => key !== "success" && key !== "text",
	);
	if (keys.length === 0) return "completed with structured result";
	const shown = keys.slice(0, 4).join(", ");
	const suffix = keys.length > 4 ? `, and ${keys.length - 4} more` : "";
	return `returned ${shown}${suffix}`;
}

function textFromInteractionResult(result: unknown): string | null {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const record = result as Record<string, unknown>;
	if (typeof record.text === "string" && record.text.trim()) {
		return record.text.trim();
	}
	const nested = record.result;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		const nestedText = (nested as Record<string, unknown>).text;
		if (typeof nestedText === "string" && nestedText.trim()) {
			return nestedText.trim();
		}
	}
	return null;
}

function successFromInteractionResult(result: unknown): boolean {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return true;
	const record = result as Record<string, unknown>;
	if (typeof record.success === "boolean") return record.success;
	const nested = record.result;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		const nestedSuccess = (nested as Record<string, unknown>).success;
		if (typeof nestedSuccess === "boolean") return nestedSuccess;
	}
	return true;
}

/**
 * POST /api/views/events/broadcast — push a view event to all connected
 * frontend tabs via the server's WebSocket broadcast.
 */
async function broadcastViewEvent(
	eventType: string,
	payload: Record<string, unknown>,
): Promise<ShellNavResult> {
	const base = getAppControlApiBase();

	try {
		const resp = await fetch(`${base}/api/views/events/broadcast`, {
			method: "POST",
			headers: createViewsRequestHeaders(),
			body: JSON.stringify({ type: eventType, payload }),
			signal: AbortSignal.timeout(5_000),
		});
		if (resp.ok) {
			return {
				ok: true,
				text: `Broadcast view event "${eventType}" to all connected views.`,
			};
		}
		logger.warn(`[plugin-app-control] VIEWS/broadcast returned ${resp.status}`);
	} catch (err) {
		logger.warn(
			`[plugin-app-control] VIEWS/broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		ok: false,
		text: `Couldn't broadcast view event "${eventType}" — the shell did not respond.`,
	};
}

export const viewsAction: Action = createViewsAction();
export const closeViewAction: Action = createViewsAliasAction("CLOSE_VIEW");
export const showViewAction: Action = createShowViewAction();
export const closeAllViewsAction: Action =
	createViewsAliasAction("CLOSE_ALL_VIEWS");
