/**
 * Resolves a requested view and asks the active shell to navigate to it.
 * The action returns an internal effect receipt after the shell accepts the
 * navigation; the post-tool model owns all visible wording.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
	ActionResult,
	HandlerCallback,
	Memory,
	RoleGateRole,
	ViewType,
} from "@elizaos/core";
import { getStreamingContext, logger, satisfiesRoleGate } from "@elizaos/core";
import { resolveSettingsSectionToken } from "@elizaos/ui/components/settings/settings-section-tokens";
import { getAppControlApiBase } from "../loopback-api.js";
import { describeTargetReference, targetReferenceLogView } from "../params.js";
import {
	type NavigationReceipt,
	navigationDispatchBlock,
	navigationRequestSignal,
} from "./navigation-execution.js";
import {
	CALLER_VIEW_CATALOG_SCOPE,
	VIEW_CATALOG_SCOPE_CONTEXT,
} from "./view-catalog-scope.js";
import { matchViewCommand } from "./view-command-matcher.js";
import { isRealtimeVoiceTurn } from "./view-delivery.js";
import {
	NAVIGATION_CAPABILITY_READ_INSTRUCTION,
	navigationDestinationReference,
} from "./view-navigation-context.js";
import { resolveCanonicalViewTarget } from "./view-target.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";
import { scoreView } from "./views-search.js";

const DOCUMENT_SURFACE_WORDS =
	/\b(?:documents?|docs?|files?|knowledge|uploads?|retrieval|papers?)\b/i;

const NOTES_SURFACE_WORD = /\bnotes?\b/i;

export function isStandaloneNotesSurfaceRequest(text: string): boolean {
	return NOTES_SURFACE_WORD.test(text) && !DOCUMENT_SURFACE_WORDS.test(text);
}

function extractViewTarget(
	options: Record<string, unknown> | undefined,
): string | null {
	// Only structured options select navigation. Accept the same target aliases
	// as the VIEWS schema and other sub-modes; never infer one from user text.
	return (
		readStringOpt(options, "view") ??
		readStringOpt(options, "viewId") ??
		readStringOpt(options, "id") ??
		readStringOpt(options, "target") ??
		readStringOpt(options, "name")
	);
}

function readStringOpt(
	options: Record<string, unknown> | undefined,
	key: string,
): string | null {
	if (!options) return null;
	const v = options[key];
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

// Legacy classification rules used by compatibility exports and context hints.
// Navigation does not use these rules to supply or override a structured target.
const INTENT_VIEW_RULES: ReadonlyArray<{ re: RegExp; viewId: string }> = [
	{
		re: /\b(add (a |an )?(new )?feature|build (me )?(an? )?(new )?app|app builder|work on my app|coding view|code something|write some code|ship (a |an )?feature)\b/i,
		viewId: "task-coordinator",
	},
	{
		re: /\b(what'?s on my (calendar|agenda|schedule)|what is on my (calendar|agenda|schedule)|my (calendar|agenda|schedule)|my next (meeting|event|appointment)|am i free)\b/i,
		viewId: "calendar",
	},
	{
		re: /\b(check (my )?messages|my messages|my (e-?mail|inbox|mail)|check my (e-?mail|inbox|mail)|any new (e-?mail|messages|mail)|triage my inbox)\b/i,
		viewId: "inbox",
	},
	{
		re: /\b(my wallet|my balance|my portfolio|my crypto|my funds|my tokens|my holdings)\b/i,
		viewId: "wallet",
	},
	{
		re: /\b(my finances|my spending|my money|my budget|my transactions|my bank|how much (did|have) i (spend|spent)|recurring charges|my subscriptions)\b/i,
		viewId: "finances",
	},
	{
		re: /\b(i need to focus|help me focus|focus mode|block (out )?distractions|stop distractions|deep work)\b/i,
		viewId: "focus",
	},
	{
		re: /\b(my goals|my routines|my reminders|my alarms|my habits)\b/i,
		viewId: "goals",
	},
	{
		re: /\b(my health|my sleep|my screen ?time|my activity|my steps|my workouts?|how did i sleep)\b/i,
		viewId: "health",
	},
	{
		re: /\b(my (to-?dos?|tasks|task list|checklist)|what('?s| is) on my (to-?do|task) list|things to do)\b/i,
		viewId: "todos",
	},
	{
		re: /\b(my (documents?|files?|papers?)|my docs|pull up (the |my )?(documents?|files?))\b/i,
		viewId: "documents",
	},
	{
		re: /\b(my (contacts?|relationships?|people|network|address book)|who do i know|my rolodex)\b/i,
		viewId: "relationships",
	},
	{
		re: /\b(my (settings|preferences)|(change|update|edit|open|go to|show|take me to) (my |the |app )?(settings|preferences|configuration)|app settings|settings (page|screen|menu)|configure (the )?app)\b/i,
		viewId: "settings",
	},
	// --- Multilingual deterministic rules ---
	// Eliza is local-first; a small/local model may not reliably route a
	// non-English navigation request, so the deterministic safety net handles the
	// common surfaces in major languages too. Anchored on a possessive
	// (mi/mon/mein/我的/내) or a navigation verb (muéstrame/montre-moi/zeig/打开/
	// 보여줘/열어) immediately around a surface noun, so they only fire on genuine
	// navigation intent. Match against the lowercased message.
	{
		re: /(?:mi|mon|mein|我的|내\s?)\s*(?:calendario|calendrier|kalender|日历|カレンダー|캘린더|agenda)|(?:mu[eé]strame|montre-moi|zeig mir|打开|显示|보여줘|열어)[\s\S]{0,12}(?:calendario|calendrier|kalender|日历|캘린더)/i,
		viewId: "calendar",
	},
	{
		re: /(?:mi|mis|mon|mes|mein|meine|我的|내\s?)\s*(?:correo|bandeja|mensajes|courrier|messages|nachrichten|postfach|邮件|消息|메시지|메일)|(?:mu[eé]strame|montre-moi|zeig mir|打开|显示|보여줘|열어)[\s\S]{0,12}(?:correo|mensajes|messages|nachrichten|邮件|메시지)/i,
		viewId: "inbox",
	},
	{
		re: /(?:mi|mis|mon|mes|mein|meine|我的|내\s?)\s*(?:cartera|billetera|portefeuille|brieftasche|geldb[oö]rse|钱包|지갑|wallet)/i,
		viewId: "wallet",
	},
	{
		re: /(?:mis|mes|meine|我的)\s*(?:finanzas|gastos|finances|d[eé]penses|finanzen|财务|花费|开销)|(?:cu[aá]nto (?:gast[eé]|he gastado)|combien (?:j'ai d[eé]pens[eé]))/i,
		viewId: "finances",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:metas|objetivos|objectifs|ziele|目标|목표|routines?|rutinas)/i,
		viewId: "goals",
	},
	{
		re: /(?:mi|ma|mein|meine|我的|내\s?)\s*(?:salud|sue[nñ]o|sant[eé]|sommeil|gesundheit|健康|睡眠|건강)/i,
		viewId: "health",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:tareas|pendientes|t[aâ]ches|aufgaben|待办|任务|할\s?일|todos?)/i,
		viewId: "todos",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:documentos|archivos|documents|fichiers|dokumente|dateien|文档|文件|문서)/i,
		viewId: "documents",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:contactos|contacts|kontakte|联系人|연락처|relaciones|relations)/i,
		viewId: "relationships",
	},
	{
		re: /(?:concentrarme|necesito concentrarme|me concentrer|konzentrieren|专注|集中|집중)|modo (?:enfoque|concentraci[oó]n)|mode concentration/i,
		viewId: "focus",
	},
];

/**
 * All view ids any `INTENT_VIEW_RULES` rule can resolve to. Exported for the
 * cross-list drift guard (#8797) so a passive intent can never target a view the
 * matcher cannot also reach by explicit command.
 */
export const INTENT_VIEW_IDS: readonly string[] = [
	...new Set(INTENT_VIEW_RULES.map((rule) => rule.viewId)),
];

/**
 * Map a passive domain intent to a concrete view id, or null when no rule
 * matches. Retained for existing compatibility exports, context hints, and
 * legacy operation classification. `runViewsShow` never consumes this result:
 * the real planner must select a structured destination in every language.
 */
export function resolveIntentView(text: string | undefined): string | null {
	const t = (text ?? "").toLowerCase();
	if (!t) return null;
	// Fast rigid multilingual matcher first (every explicit "open X" phrasing in
	// every language); fall back to the legacy intent rules for the few passive
	// phrasings it intentionally does not cover (e.g. "am i free" → calendar).
	const rigid = matchViewCommand(text);
	if (rigid) return rigid;
	for (const rule of INTENT_VIEW_RULES) {
		if (rule.re.test(t)) return rule.viewId;
	}
	return null;
}

function resolveView(
	target: string,
	views: readonly ViewSummary[],
	canonicalViewId?: string,
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const q = target.toLowerCase();

	// Exact id match.
	const byId = views.find((v) => v.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	// Exact label match.
	const byLabel = views.find((v) => v.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	// A canonical alias names a specific destination, not a fuzzy search query.
	if (canonicalViewId) {
		const canonicalView = views.find((view) => view.id === canonicalViewId);
		return canonicalView
			? { kind: "match", view: canonicalView }
			: { kind: "none" };
	}

	// Scored fuzzy — reuse search scoring.
	const scored = views
		.map((v) => ({ view: v, score: scoreView(v, target) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) return { kind: "none" };
	if (scored.length === 1) return { kind: "match", view: scored[0].view };

	// Top-score tie-break: single winner if top score is strictly higher.
	const topScore = scored[0].score;
	const topTied = scored.filter(({ score }) => score === topScore);
	if (topTied.length === 1) return { kind: "match", view: topTied[0].view };

	return { kind: "ambiguous", candidates: topTied.map(({ view }) => view) };
}

export interface NavigateResult {
	ok: boolean;
	status: "accepted" | "unsupported-route" | "http-error" | "transport-error";
	receiptStatus?: "delivered" | "not-delivered" | "malformed" | "not-requested";
	/** Internal tool receipt for post-tool reasoning; never assistant prose. */
	text: string;
	/** Resolved sub-section the renderer was asked to focus (settings only). */
	subview?: string;
	/** The server synchronously accepted delivery to the originating renderer. */
	completedActionDelivered?: true;
	/** Renderer-observed idempotency key echoed by a supporting server. */
	completedActionHandoffId?: string;
}

function navigationEffectReceipt({
	status,
	view,
	navigationLabel,
	subview,
}: {
	status: "accepted" | "unsupported-route" | "unconfirmed";
	view: ViewSummary;
	navigationLabel: string;
	subview?: string;
}): string {
	return JSON.stringify({
		effect: "view_navigation",
		status,
		viewId: view.id,
		label: navigationLabel,
		...(view.path ? { path: view.path } : {}),
		...(subview ? { subview } : {}),
	});
}

/** Accept only the own, literal confirmation field emitted by the agent route. */
function confirmsCompletedActionDelivery(body: unknown): boolean {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return false;
	}
	return (
		Object.getOwnPropertyDescriptor(body, "completedActionDelivered")?.value ===
		true
	);
}

/**
 * Resolve a caller-supplied sub-section token into the value the renderer
 * focuses. Settings is the only view with addressable sub-sections today, so we
 * reuse the canonical client token→section-id map (`resolveSettingsSectionToken`)
 * rather than inventing a second mapping. An unknown token for the settings view
 * (or any token for another view) is passed through verbatim — the renderer
 * applies the same resolution and ignores values it doesn't recognize.
 */
function resolveSubviewForView(
	view: ViewSummary,
	subview: string | undefined,
): string | undefined {
	const token = subview?.trim();
	if (!token) return undefined;
	if (view.id === "settings") {
		return resolveSettingsSectionToken(token) ?? token.toLowerCase();
	}
	return token;
}

export async function navigateToView(
	view: ViewSummary,
	requestedViewType?: ViewType,
	subview?: string,
	navigationLabel = view.label,
	delivery?: "originating-client" | "completed-action",
	originatingClientId?: string,
	completedActionHandoffId?: string,
): Promise<NavigateResult> {
	// Emit navigate event via POST /api/views/:id/navigate (shell listens).
	// A shell without the navigate route did not accept the requested effect.
	// Keep 404/501 distinct in the internal receipt, but never claim success or
	// request a model-authored acknowledgement for an effect that did not occur.
	// A real transport failure (other non-2xx, network, timeout) is also NOT success:
	// reporting "Switched to X" when nothing happened misleads the user and the
	// chain's verifiedUserFacing logic.
	const base = getAppControlApiBase();
	const resolvedSubview = resolveSubviewForView(view, subview);

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(view.id)}/navigate${requestedViewType ? `?viewType=${requestedViewType}` : ""}`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({
					path: view.path,
					viewType: requestedViewType,
					...(resolvedSubview ? { subview: resolvedSubview } : {}),
					...(delivery ? { delivery } : {}),
					...(originatingClientId ? { clientId: originatingClientId } : {}),
					...(completedActionHandoffId ? { completedActionHandoffId } : {}),
				}),
				signal: navigationRequestSignal(5_000),
			},
		);
		if (resp.ok) {
			let responseBody: unknown;
			let malformedReceipt = false;
			try {
				responseBody = await resp.json();
			} catch (error) {
				// error-policy:J3 malformed optional receipt JSON keeps the terminal
				// navigation fallback enabled; transport/body failures remain failures.
				if (!(error instanceof SyntaxError)) throw error;
				responseBody = null;
				malformedReceipt = true;
			}
			const echoedCompletedActionHandoffId =
				completedActionHandoffId &&
				typeof responseBody === "object" &&
				responseBody !== null &&
				!Array.isArray(responseBody) &&
				Object.getOwnPropertyDescriptor(
					responseBody,
					"completedActionHandoffId",
				)?.value === completedActionHandoffId
					? completedActionHandoffId
					: undefined;
			return {
				ok: true,
				status: "accepted",
				receiptStatus:
					malformedReceipt && delivery === "completed-action"
						? "malformed"
						: delivery === "completed-action"
							? confirmsCompletedActionDelivery(responseBody) &&
								(!completedActionHandoffId || echoedCompletedActionHandoffId)
								? "delivered"
								: "not-delivered"
							: "not-requested",
				text: navigationEffectReceipt({
					status: "accepted",
					view,
					navigationLabel,
					subview: resolvedSubview,
				}),
				subview: resolvedSubview,
				...(delivery === "completed-action" &&
				confirmsCompletedActionDelivery(responseBody) &&
				(!completedActionHandoffId || echoedCompletedActionHandoffId)
					? { completedActionDelivered: true as const }
					: {}),
				...(echoedCompletedActionHandoffId
					? { completedActionHandoffId: echoedCompletedActionHandoffId }
					: {}),
			};
		}
		// Preserve the unsupported-route diagnosis without fabricating success.
		if (resp.status === 501 || resp.status === 404)
			return {
				ok: false,
				status: "unsupported-route",
				text: navigationEffectReceipt({
					status: "unsupported-route",
					view,
					navigationLabel,
					subview: resolvedSubview,
				}),
				subview: resolvedSubview,
			};

		let body = "";
		try {
			body = await resp.text();
		} catch (error) {
			// error-policy:J4 response diagnostics are optional; navigation already
			// has an explicit HTTP failure and must remain failed.
			logger.warn(
				{ error },
				"[plugin-app-control] Could not read navigation error body",
			);
		}
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate returned ${resp.status}: ${body}`,
		);
		return {
			ok: false,
			status: "http-error",
			text: navigationEffectReceipt({
				status: "unconfirmed",
				view,
				navigationLabel,
				subview: resolvedSubview,
			}),
		};
	} catch (err) {
		// error-policy:J4 navigation transport failures preserve a visibly distinct
		// failed action so the planner can recover without claiming the effect.
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		ok: false,
		status: "transport-error",
		text: navigationEffectReceipt({
			status: "unconfirmed",
			view,
			navigationLabel,
			subview: resolvedSubview,
		}),
	};
}

export interface RunViewsShowInput {
	client: ViewsClient;
	message: Memory;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
	originatingClientId?: string;
	userRoles?: readonly RoleGateRole[];
	resolveCallerRoles?: () => Promise<readonly RoleGateRole[]>;
}

export async function runViewsShow({
	client,
	message,
	options,
	viewType,
	originatingClientId,
	userRoles,
	resolveCallerRoles,
}: RunViewsShowInput): Promise<ActionResult> {
	const plannerStep =
		readStringOpt(options, "navigationIntent") === "planner-step";
	const navigationStepId = readStringOpt(options, "navigationStepId");
	const receipt = (
		status: NavigationReceipt["status"],
		viewId: string | null = null,
		reason?: string,
	): NavigationReceipt => ({
		effect: "view_navigation",
		stepId: navigationStepId,
		viewId,
		status,
		...(reason ? { reason } : {}),
	});
	const blockedResult = (): ActionResult | undefined => {
		const status = navigationDispatchBlock(message, plannerStep);
		if (!status) return undefined;
		const navigation = receipt(
			status,
			null,
			status === "invalid"
				? "Missing trusted navigation decision for this turn"
				: "Navigation is forbidden or the turn was cancelled",
		);
		return {
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			text: JSON.stringify(navigation),
			data: { navigation },
		};
	};
	const initialBlock = blockedResult();
	if (initialBlock) return initialBlock;
	const target = extractViewTarget(options);
	if (plannerStep && (!readStringOpt(options, "view") || !navigationStepId)) {
		return {
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			text: "A planner navigation step requires an explicit view and navigationStepId. Domain work has not completed by navigation.",
			data: {
				navigation: receipt("invalid", null, "VIEW_STEP_INVALID"),
				// Use the planner's existing malformed-call recovery contract. A
				// later successful retry must still preserve this call's destination.
				parameterErrors: ["view", "navigationStepId"]
					.filter((name) => !readStringOpt(options, name))
					.map((name) => ({
						name,
						message: `${name} is required when navigationIntent is planner-step.`,
					})),
			},
		};
	}
	if (!target) {
		const text =
			'Tell me which view to open. Try: "open wallet" or "show settings".';
		return {
			success: false,
			text,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: { navigation: receipt("invalid", null, "Missing target") },
		};
	}

	let views: ViewSummary[];
	try {
		views = await client.listViews({ viewType });
	} catch (error) {
		// error-policy:J1 catalog/abort failure is a typed navigation outcome.
		const navigation = receipt(
			getStreamingContext()?.abortSignal?.aborted ? "cancelled" : "unavailable",
			null,
			error instanceof Error ? error.message : String(error),
		);
		return {
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			text: JSON.stringify(navigation),
			data: { navigation },
		};
	}
	const catalogBlock = blockedResult();
	if (catalogBlock) return catalogBlock;
	// Resolve only the structured destination; other request clauses cannot replace it.
	const canonicalTarget = resolveCanonicalViewTarget(target);
	const resolution = resolveView(target, views, canonicalTarget?.viewId);

	if (resolution.kind === "none") {
		const text = `No view matches ${describeTargetReference(target)} in the caller-authorized catalog. ${VIEW_CATALOG_SCOPE_CONTEXT} Try \`action=list\` to see available views.`;
		return {
			success: false,
			text,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: {
				target: targetReferenceLogView(target),
				navigation: receipt("not-found", null),
				catalogScope: CALLER_VIEW_CATALOG_SCOPE,
			},
		};
	}

	if (resolution.kind === "ambiguous") {
		const candidates = resolution.candidates;
		const list = candidates.map((v) => `- ${v.label} (${v.id})`).join("\n");
		const text = `${describeTargetReference(target)} matches multiple views:\n${list}\nWhich one did you mean?`;
		return {
			success: false,
			text,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: { candidates, navigation: receipt("ambiguous", null) },
		};
	}

	const view = resolution.view;

	let callerRoles = userRoles;
	try {
		if (view.roleGate && resolveCallerRoles)
			callerRoles = await resolveCallerRoles();
	} catch (error) {
		// error-policy:J1 role resolution failures remain explicit navigation failures.
		const navigation = receipt(
			getStreamingContext()?.abortSignal?.aborted ? "cancelled" : "unavailable",
			view.id,
			error instanceof Error ? error.message : String(error),
		);
		return {
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			text: JSON.stringify(navigation),
			data: { navigation },
		};
	}
	const roleBlock = blockedResult();
	if (roleBlock) return roleBlock;
	if (
		!view.available ||
		(view.roleGate && !satisfiesRoleGate(callerRoles, view.roleGate))
	) {
		const navigation = receipt("unavailable", view.id);
		return {
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
			text: JSON.stringify(navigation),
			data: { navigation, navigationAttempted: false },
		};
	}
	const subview =
		readStringOpt(options, "subview") ?? readStringOpt(options, "section");
	const navigationLabel =
		canonicalTarget?.viewId === view.id ? canonicalTarget.label : view.label;
	const completedActionDelivery =
		!isRealtimeVoiceTurn(message) && Boolean(originatingClientId);
	const completedActionHandoffId = completedActionDelivery
		? message.id
			? createHash("sha256")
					.update(
						JSON.stringify([
							message.id,
							message.roomId,
							message.entityId,
							originatingClientId,
							navigationStepId,
							view.id,
							subview,
							viewType,
						]),
					)
					.digest("hex")
			: randomUUID()
		: undefined;
	const dispatchBlock = blockedResult();
	if (dispatchBlock) return dispatchBlock;
	const result = await navigateToView(
		view,
		viewType,
		subview ?? undefined,
		navigationLabel,
		!completedActionDelivery && isRealtimeVoiceTurn(message)
			? "originating-client"
			: completedActionDelivery
				? "completed-action"
				: undefined,
		originatingClientId,
		completedActionHandoffId,
	);

	const navigationSucceeded =
		result.ok &&
		(!completedActionDelivery || result.completedActionDelivered === true);
	const navigation: NavigationReceipt = {
		label: navigationLabel,
		...(view.path ? { path: view.path } : {}),
		...(result.subview ? { subview: result.subview } : {}),
		...receipt(
			result.ok
				? result.receiptStatus === "delivered"
					? "delivered"
					: result.receiptStatus === "not-delivered" ||
							result.receiptStatus === "malformed"
						? result.receiptStatus
						: "accepted"
				: getStreamingContext()?.abortSignal?.aborted
					? "cancelled"
					: result.status === "accepted"
						? "transport-error"
						: result.status,
			view.id,
		),
		...(completedActionHandoffId
			? { handoffId: completedActionHandoffId }
			: {}),
	};
	logger.info(
		`[plugin-app-control] VIEWS/show viewId=${view.id} viewType=${view.viewType ?? "gui"}${result.subview ? ` subview=${result.subview}` : ""}`,
	);
	return {
		success: navigationSucceeded,
		text: JSON.stringify(navigation),
		// Navigation has already been handed to the shell. A confirmed success
		// requires a model-authored reply. The caller can release a held same-turn
		// draft after checking this receipt, or synthesize a post-tool reply when
		// needed. Failed/unconfirmed navigation retains evaluation and recovery.
		transcriptVisibility: "internal",
		...(navigationSucceeded
			? { modelReplyRequired: true }
			: { turnComplete: false }),
		values: {
			mode: "show",
			viewId: view.id,
			...(view.path ? { viewPath: view.path } : {}),
			viewType: view.viewType ?? viewType ?? "gui",
			label: navigationLabel,
			...(result.subview ? { subview: result.subview } : {}),
			...(confirmsCompletedActionDelivery(result)
				? { completedActionDelivered: true }
				: {}),
			...(result.completedActionHandoffId
				? { completedActionHandoffId: result.completedActionHandoffId }
				: {}),
		},
		data: {
			view,
			navigation,
			...(result.subview ? { subview: result.subview } : {}),
		},
		// Clients retain the complete catalog object in data. The model receives
		// the same navigation evidence without eagerly reloading interaction
		// schemas that were already deferred by the pre-planner handoff.
		promptData: {
			view: navigationDestinationReference(view),
			navigation,
			...(result.subview ? { subview: result.subview } : {}),
			...(view.capabilities?.some(({ params }) => params !== undefined)
				? { capabilityRead: NAVIGATION_CAPABILITY_READ_INSTRUCTION }
				: {}),
		},
		promptDataMode: "replace-data",
	};
}
