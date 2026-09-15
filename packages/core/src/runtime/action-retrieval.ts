/**
 * Multi-stage action retrieval for the planner: scores catalog parents by
 * exact-hint, candidate-regex, keyword, BM25, embedding tie-breaker, and
 * context-match signals, then fuses the per-stage rankings with reciprocal-rank
 * fusion into a complete relevance-ranked catalog.
 */
import {
	collectPreparedKeywordTermMatches,
	type PreparedKeywordTerm,
	prepareKeywordTerms,
} from "../i18n/validation-keywords";
import { logger } from "../logger";
import type { ActionCatalog, ActionCatalogParent } from "./action-catalog";
import { normalizeActionName } from "./action-catalog";
import { matchActionWildcardParts } from "./action-wildcard-glob";

export type RetrievalStageName =
	| "exact"
	| "regex"
	| "keyword"
	| "bm25"
	| "embedding"
	| "contextMatch";

export type ActionEmbeddingTieBreaker = {
	enabled?: boolean;
	scoresByParentName?: Record<string, number>;
};

export type RetrieveActionsInput = {
	catalog: ActionCatalog;
	messageText?: string;
	recentConversationText?: string | readonly string[];
	candidateActions?: string[];
	parentActionHints?: string[];
	embedding?: ActionEmbeddingTieBreaker;
	/** @deprecated Retrieval ranks every parent; it never limits availability. */
	limit?: number;
	/**
	 * The messageHandler-selected contexts for this turn. Used as a *weight*
	 * (boost actions whose declared `contexts` intersect this set) — never
	 * as a filter. Filtering by context masked OWNER_TODOS/CALENDAR/etc. when the
	 * messageHandler routed to "general"; weighting keeps them retrievable
	 * while still preferring on-context candidates when scores are close.
	 */
	selectedContexts?: readonly string[];
	/**
	 * When `true`, capture each stage's full pre-fusion output and emit it
	 * in `response.measurement`. Default `false` — no allocation cost in
	 * production. Toggle via the `ELIZA_RETRIEVAL_MEASUREMENT=1` env var
	 * on the caller side.
	 */
	measurementMode?: boolean;
	/**
	 * Optional per-tier overrides for retrieval. When provided, the call
	 * uses these instead of the in-file constants. Wired by the external benchmark
	 * harness from `RETRIEVAL_DEFAULTS_BY_TIER`.
	 */
	tierOverrides?: {
		/** @deprecated Retrieval ranks every parent; it never caps the catalog. */
		topK?: number;
		stageWeights?: Partial<Record<RetrievalStageName, number>>;
	};
};

export type RetrievalStageEntry = {
	actionName: string;
	score: number;
	rank: number;
};

export type RetrievalPerStageScores = {
	exact: RetrievalStageEntry[];
	regex: RetrievalStageEntry[];
	keyword: RetrievalStageEntry[];
	bm25: RetrievalStageEntry[];
	embedding: RetrievalStageEntry[];
	contextMatch: RetrievalStageEntry[];
};

export type RetrievalMeasurement = {
	perStageScores: RetrievalPerStageScores;
	fusedTopK: Array<{ actionName: string; rrfScore: number; rank: number }>;
};

export type ActionRetrievalResult = {
	parent: ActionCatalogParent;
	name: string;
	normalizedName: string;
	score: number;
	rank: number;
	rrfScore: number;
	stageScores: Partial<Record<RetrievalStageName, number>>;
	matchedBy: RetrievalStageName[];
};

export type ActionRetrievalResponse = {
	results: ActionRetrievalResult[];
	warnings: ActionCatalog["warnings"];
	query: {
		text: string;
		tokens: string[];
		candidateActions: string[];
		parentActionHints: string[];
	};
	/**
	 * Per-stage retrieval funnel. Populated only when
	 * `input.measurementMode === true`. The benchmark harness consumes
	 * this to compute stage-by-stage recall.
	 */
	measurement?: RetrievalMeasurement;
};

const BM25_K1 = 0.9;
const BM25_B = 0.4;
const RRF_K = 60;

/**
 * Per-tier retrieval defaults inlined in core so the runtime never takes a
 * dep on the benchmark tooling. Kept in sync by hand with
 * `retrieval-defaults.ts` in https://github.com/elizaOS/benchmarks — the
 * benchmark repo is the source of truth (it's where the Pareto sweep emits
 * recommended values). If the two drift, fix this file from that copy.
 */
const RETRIEVAL_TIER_DEFAULTS: Record<
	"small" | "mid" | "large" | "frontier",
	{ stageWeights: Partial<Record<RetrievalStageName, number>> }
> = {
	small: {
		stageWeights: {
			exact: 1.5,
			regex: 1.3,
			bm25: 1.2,
			keyword: 1,
			embedding: 0.7,
			contextMatch: 0.9,
		},
	},
	mid: {
		stageWeights: {
			exact: 1.4,
			regex: 1.2,
			bm25: 1.15,
			keyword: 1,
			embedding: 0.85,
			contextMatch: 1,
		},
	},
	large: {
		stageWeights: {
			exact: 1.2,
			regex: 1.1,
			bm25: 1,
			keyword: 1,
			embedding: 1,
			contextMatch: 1,
		},
	},
	frontier: {
		stageWeights: {
			exact: 1,
			regex: 1,
			bm25: 1,
			keyword: 1.1,
			embedding: 1.2,
			contextMatch: 1,
		},
	},
};

// A candidate name can hint MORE than one parent when the phrasing is genuinely
// ambiguous between surfaces. "OPEN_APP" can mean the apps *page* (VIEWS) or
// launching the application itself (APP) — hint both and let the planner
// arbitrate from the exposed descriptions (#9950).
const CANDIDATE_ACTION_PARENT_ALIASES: Record<string, readonly string[]> = {
	ADD_GOAL: ["OWNER_GOALS"],
	// Email-shaped candidates bind to the inbox triage umbrella. Stage-1
	// routinely invents these exact names (matrix F21, caught live by the
	// #20001 resolved-to-nothing observability: EMAIL and EMAIL_SEARCH bound
	// to no runtime action and the candidate died silently pre-#20001).
	EMAIL: ["MESSAGE", "INBOX"],
	EMAILS: ["MESSAGE", "INBOX"],
	EMAIL_SEARCH: ["MESSAGE", "INBOX"],
	SEARCH_EMAILS: ["MESSAGE", "INBOX"],
	READ_EMAIL: ["MESSAGE", "INBOX"],
	CHECK_EMAIL: ["MESSAGE", "INBOX"],
	CHECK_INBOX: ["MESSAGE", "INBOX"],
	// Memory-recall candidates bind to the canonical MEMORY umbrella action.
	RECALL_MEMORY: ["MEMORY"],
	RECALL_MEMORIES: ["MEMORY"],
	MEMORY_RECALL: ["MEMORY"],
	MEMORY_SEARCH: ["MEMORY"],
	SEARCH_MEMORIES: ["MEMORY"],
	CHECK_MEMORY: ["MEMORY"],
	// Terminal-shaped candidates bind to the shell surface (same F21 batch:
	// TERMINAL_COMMAND resolved to nothing).
	TERMINAL_COMMAND: ["SHELL", "TERMINAL_SHELL"],
	TERMINAL: ["SHELL", "TERMINAL_SHELL"],
	RUN_COMMAND: ["SHELL", "TERMINAL_SHELL"],
	// "write X and run it" asks: stage-1 invents EXEC/EXECUTE spellings the
	// simile table does not carry; unresolved, the planner ran toolless and
	// answered with unexecuted code (live 2026-08-17: a "run this python
	// one-liner" ask returned the code, never the output).
	EXEC_COMMAND: ["SHELL", "TERMINAL_SHELL"],
	EXECUTE_COMMAND: ["SHELL", "TERMINAL_SHELL"],
	EXEC: ["SHELL", "TERMINAL_SHELL"],
	RUN_SCRIPT: ["SHELL", "TERMINAL_SHELL"],
	RUN_PYTHON: ["SHELL", "TERMINAL_SHELL"],
	// Todo-shaped candidates hint BOTH todo owners: the personal-assistant
	// umbrella and plugin-todos' TODO parent. Deployments load one or the
	// other; the resolver keeps whichever is registered. Without these the
	// names Stage-1 actually emits ("add a todo: buy milk" → CREATE_TODO,
	// "what todos do i have" → USER_TODOS_READ, live trajectories
	// tj-060255231afe39 / tj-06105af841e1c1) resolve to nothing — the
	// candidate narrow then dropped every todo tool and the planner
	// improvised (replayed a stale OWNER_GOALS create; invented a VIEWS
	// "get-todos" capability that errored). Same class as the habit/goal
	// aliases above (#10722).
	ADD_TODO: ["OWNER_TODOS", "TODO"],
	CREATE_TODO: ["OWNER_TODOS", "TODO"],
	TODO: ["OWNER_TODOS"],
	TODOS: ["OWNER_TODOS", "TODO"],
	TODO_ADD: ["OWNER_TODOS", "TODO"],
	TODO_CREATE: ["OWNER_TODOS", "TODO"],
	TODOS_CREATE: ["OWNER_TODOS", "TODO"],
	NEW_TODO: ["OWNER_TODOS", "TODO"],
	SAVE_TODO: ["OWNER_TODOS", "TODO"],
	TODO_LIST: ["OWNER_TODOS", "TODO"],
	LIST_TODOS: ["OWNER_TODOS", "TODO"],
	GET_TODOS: ["OWNER_TODOS", "TODO"],
	SHOW_TODOS: ["OWNER_TODOS", "TODO"],
	READ_TODOS: ["OWNER_TODOS", "TODO"],
	USER_TODOS_READ: ["OWNER_TODOS", "TODO"],
	COMPLETE_TODO: ["OWNER_TODOS", "TODO"],
	TODO_COMPLETE: ["OWNER_TODOS", "TODO"],
	DELETE_TODO: ["OWNER_TODOS", "TODO"],
	REMOVE_TODO: ["OWNER_TODOS", "TODO"],
	// Canonical OWNER_* fallbacks for non-PA topologies: the stage-1 routing
	// floor names these parents, and on deployments without
	// @elizaos/plugin-personal-assistant the names resolve to nothing while
	// modelCommittedToPlanning preserves the unregistered plan and forces an
	// unavailable surface. These aliases only apply when the named parent is
	// NOT registered (direct name resolution wins first), so PA deployments
	// are untouched. Only capability-equivalent fallbacks are allowed: a plain
	// todo remains a TODO, while scheduled owner surfaces can use TRIGGER. Goals
	// intentionally fail closed when OWNER_GOALS is unavailable because neither
	// a checklist item nor a raw trigger preserves the goal contract.
	OWNER_TODOS: ["TODO"],
	OWNER_REMINDERS: ["TRIGGER"],
	OWNER_ALARMS: ["TRIGGER"],
	OWNER_ROUTINES: ["TRIGGER"],
	// Alarm-shaped candidates: same dual hint as reminders/habits — the
	// owner umbrella plus the always-registered TRIGGER scheduler.
	ADD_ALARM: ["OWNER_ALARMS", "TRIGGER"],
	SET_ALARM: ["OWNER_ALARMS", "TRIGGER"],
	CREATE_ALARM: ["OWNER_ALARMS", "TRIGGER"],
	ALARM_CREATE: ["OWNER_ALARMS", "TRIGGER"],
	WAKE_ME_UP: ["OWNER_ALARMS", "TRIGGER"],
	// Coding/repo-shaped candidates bind to the TASKS coding umbrella. Stage-1
	// invents CODE_*/PR spellings for repo asks ("add a one-line description to
	// the readme and put up a pr" → CODE_EDIT + CODE_PR_CREATE, live
	// tj-79876bf0f950e8): CODE_EDIT resolved to nothing while CODE_PR_CREATE's
	// CREATE token tripped the view heuristic into VIEWS, so the planner surface
	// carried no coding tool and the turn ended on a bare re-ack — the promised
	// PR never started. TASKS owns repo work end-to-end (clone, commits, push,
	// PR), so the intent hint routes there; admission still passes through
	// appendIfAllowed's role/context gates.
	CODE_EDIT: ["TASKS"],
	CODE_CHANGE: ["TASKS"],
	CODE_WRITE: ["TASKS"],
	EDIT_CODE: ["TASKS"],
	WRITE_CODE: ["TASKS"],
	CODE_FIX: ["TASKS"],
	FIX_CODE: ["TASKS"],
	FIX_BUG: ["TASKS"],
	CODE_PR_CREATE: ["TASKS"],
	CREATE_PR: ["TASKS"],
	OPEN_PR: ["TASKS"],
	SUBMIT_PR: ["TASKS"],
	PR_CREATE: ["TASKS"],
	PULL_REQUEST: ["TASKS"],
	CREATE_PULL_REQUEST: ["TASKS"],
	OPEN_PULL_REQUEST: ["TASKS"],
	GITHUB_PR: ["TASKS"],
	UPDATE_REPO_README: ["TASKS"],
	GITHUB_ISSUE_FIX: ["TASKS"],
	COMMIT_CHANGES: ["TASKS"],
	CREATE_BRANCH: ["TASKS"],
	// Finance-shaped candidates: OWNER_FINANCES declares only one simile
	// ("FINANCES"), so the common Stage-1 inventions need explicit hints.
	// Reminder-mutation inventions ("update my vitamins reminder" →
	// TASKS_UPDATE_REMINDER, live 2026-08-18; the TASKS prefix fuzzy-matched
	// VIEWS and the turn errored) bind to the reminder owners like the other
	// reminder aliases above.
	TASKS_UPDATE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	UPDATE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	CHANGE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	EDIT_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	FIX_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	REMINDER_UPDATE: ["OWNER_REMINDERS", "TRIGGER"],
	RESCHEDULE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	FINANCE: ["OWNER_FINANCES"],
	SPENDING: ["OWNER_FINANCES"],
	SPENDING_SUMMARY: ["OWNER_FINANCES"],
	EXPENSES: ["OWNER_FINANCES"],
	// Habit/reminder-shaped candidates hint BOTH the owner-life umbrella and the
	// always-registered TRIGGER scheduler. Stage-1 routinely invents these names
	// ("can u help me to brush my teeth everyday" → SET_HABIT), and on
	// deployments without @elizaos/plugin-personal-assistant the OWNER_* similes
	// resolve to nothing — the candidate narrow then demoted the retrieved
	// TRIGGER_* actions off the planner surface entirely, leaving only
	// PAGE_DELEGATE guesses ("CREATE_HABIT is not available on the owner page"
	// x4, live trajectory tj-9e6b825e91d725). With the TRIGGER hint the only
	// real scheduled-work capability stays exposed; on full deployments the
	// owner umbrella is also kept and its de-claim description still routes new
	// habits to OWNER_ROUTINES_CREATE (#10722).
	ADD_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	ADD_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	CONFIRM_GOAL: ["OWNER_GOALS"],
	CREATE_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	CREATE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	CREATE_ROUTINE: ["OWNER_ROUTINES", "TRIGGER"],
	DAILY_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	DAILY_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	HABIT_CREATE: ["OWNER_ROUTINES", "TRIGGER"],
	NEW_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	NEW_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	RECURRING_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	REMINDER_CREATE: ["OWNER_REMINDERS", "TRIGGER"],
	SAVE_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	SET_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	TRACK_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	CROSS_CHANNEL_SEARCH: ["MESSAGE"],
	// Structural server/guild management binds to the MESSAGE umbrella (op=
	// manage_server), never the VIEWS window surface. Stage-1 invents these
	// verb-first spellings for Discord/guild administration ("apply the code-ops
	// template to this server" -> APPLY_SERVER_TEMPLATE; "add a channel called
	// builds" -> CREATE_CHANNEL). Without the explicit hint the CREATE/DELETE/
	// LIST + CHANNEL/ROLE tokens trip looksLikeViewCandidateAction and route the
	// structural write to the VIEWS catalog, so op=manage_server never reaches the
	// planner and the turn falsely reports no template / no server tools (live
	// 2026-08-25: "apply the code-ops template to this server as a dry run"
	// wandered RUNTIME_STATUS/PERSONALITY/WORKFLOW/FILE and answered
	// "no template exists"). explicitParentAliasesForCandidateAction runs before
	// the view/app heuristics, so these entries win. Admission still passes
	// through appendIfAllowed's role/context gates and the connector's own
	// structural-action config gates (channels/roles/permissions/moderation).
	MANAGE_SERVER: ["MESSAGE"],
	MANAGE_GUILD: ["MESSAGE"],
	SERVER_MANAGEMENT: ["MESSAGE"],
	GUILD_MANAGEMENT: ["MESSAGE"],
	APPLY_SERVER_TEMPLATE: ["MESSAGE"],
	APPLY_DISCORD_TEMPLATE: ["MESSAGE"],
	LIST_SERVER_TEMPLATES: ["MESSAGE"],
	SERVER_TEMPLATE: ["MESSAGE"],
	SERVER_TEMPLATES: ["MESSAGE"],
	GUILD_TEMPLATE: ["MESSAGE"],
	CREATE_CHANNEL: ["MESSAGE"],
	EDIT_CHANNEL: ["MESSAGE"],
	DELETE_CHANNEL: ["MESSAGE"],
	CREATE_CATEGORY: ["MESSAGE"],
	EDIT_CATEGORY: ["MESSAGE"],
	DELETE_CATEGORY: ["MESSAGE"],
	CREATE_INVITE: ["MESSAGE"],
	EDIT_CHANNEL_PERMISSIONS: ["MESSAGE"],
	KICK_MEMBER: ["MESSAGE"],
	BAN_MEMBER: ["MESSAGE"],
	UNBAN_MEMBER: ["MESSAGE"],
	TIMEOUT_MEMBER: ["MESSAGE"],
	// Structural role LIFECYCLE (create/edit/delete a connector role) is
	// manage_server, distinct from the ROLE action's world-role ASSIGNMENT
	// (ASSIGN_ROLE/SET_ROLE/REVOKE_ROLE are ROLE similes and stay there). These
	// creation/deletion spellings are claimed by no parent's similes, so hinting
	// MESSAGE steals nothing; without it CREATE_ROLE's CREATE+ROLE tokens route to
	// VIEWS.
	CREATE_ROLE: ["MESSAGE"],
	EDIT_ROLE: ["MESSAGE"],
	DELETE_ROLE: ["MESSAGE"],
	CREATE_GOAL: ["OWNER_GOALS"],
	CREATE_SAVINGS_PLAN: ["OWNER_GOALS"],
	GOAL_CREATE: ["OWNER_GOALS"],
	GOAL_SAVE: ["OWNER_GOALS"],
	GOALS_CREATE: ["OWNER_GOALS"],
	GOALS_SAVE: ["OWNER_GOALS"],
	SEARCH_EMAIL: ["MESSAGE"],
	SEARCH_INBOX: ["MESSAGE"],
	SEARCH_MESSAGES: ["MESSAGE"],
	SAVE_GOAL: ["OWNER_GOALS"],
	SAVE_MONEY_FOR_TRIP: ["OWNER_GOALS"],
	SAVINGS_PLAN: ["OWNER_GOALS"],
	MESSAGE_SEARCH: ["MESSAGE"],
	TRAVEL_SAVINGS_PLAN: ["OWNER_GOALS"],
	TRIP_SAVINGS_PLAN: ["OWNER_GOALS"],
	SEARCH_CHATS: ["MESSAGE"],
	SEARCH_CHAT: ["MESSAGE"],
	// OWNER_<VERB>_<NOUN> permutations: the registered owner umbrellas are
	// noun-first (OWNER_TODOS, promoted OWNER_TODOS_DELETE), but Stage-1
	// routinely inverts to verb-first ("actually delete it" one turn after a
	// todo create emitted candidate OWNER_DELETE_TODO, live trajectory
	// tj-85d166dc4710f0 — it resolved to nothing, the candidate narrow
	// collapsed the surface to VIEWS, and the planner invented an undeclared
	// "delete-todo" view capability). Same dual-owner hints as the noun-first
	// entries above.
	OWNER_ADD_TODO: ["OWNER_TODOS", "TODO"],
	OWNER_CREATE_TODO: ["OWNER_TODOS", "TODO"],
	OWNER_DELETE_TODO: ["OWNER_TODOS", "TODO"],
	OWNER_COMPLETE_TODO: ["OWNER_TODOS", "TODO"],
	OWNER_DELETE_GOAL: ["OWNER_GOALS"],
	OWNER_CREATE_GOAL: ["OWNER_GOALS"],
	OWNER_DELETE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	OWNER_CREATE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	OWNER_DELETE_ALARM: ["OWNER_ALARMS", "TRIGGER"],
	OWNER_CREATE_ALARM: ["OWNER_ALARMS", "TRIGGER"],
	OWNER_DELETE_ROUTINE: ["OWNER_ROUTINES", "TRIGGER"],
	OWNER_CREATE_ROUTINE: ["OWNER_ROUTINES", "TRIGGER"],
	// Bare "SEARCH" is a routine Stage-1 invention for open-web asks ("latest
	// merged PR on develop, search for it" emitted candidate SEARCH, live
	// trajectory tj-df4f61ac001a27). It resolved to nothing, the candidate
	// narrow kept only the arbitrary rank-1 parent of a saturated tie, and the
	// planner ran CALENDAR_BULK_RESCHEDULE for a web query. Genuinely ambiguous
	// with message search, so hint both owners and let the planner arbitrate
	// from the selected contexts (#9950 pattern).
	SEARCH: ["WEB_SEARCH", "MESSAGE"],
	SEARCH_ONLINE: ["WEB_SEARCH"],
	INTERNET_SEARCH: ["WEB_SEARCH"],
	GOOGLE_SEARCH: ["WEB_SEARCH"],
	// Contact lookups: stage-1 invents CONTACTS_LOOKUP and similar names for
	// "who is X in my rolodex", which resolves to nothing — the candidate narrow
	// then collapsed the surface to PAGE_DELEGATE (saturated-tie rank-1) and the
	// planner invented a non-existent "CONTACTS_LOOKUP" page capability, failing
	// the read even though CONTACT (score 1.0) and ENTITY (0.99) were retrieved
	// (observed live). Hint both the CONTACT CRUD umbrella and the ENTITY graph,
	// but only for names that unambiguously identify a contact surface. Generic
	// inventions such as WHO_IS must remain available to public-information
	// actions, and existing CONTACT similes already cover CRUD names.
	CONTACTS_LOOKUP: ["CONTACT", "ENTITY"],
	CONTACT_LOOKUP: ["CONTACT", "ENTITY"],
	LOOKUP_CONTACT: ["CONTACT", "ENTITY"],
	FIND_CONTACT: ["CONTACT", "ENTITY"],
	CONTACT_INFO: ["CONTACT", "ENTITY"],
	SHOW_CONTACT: ["CONTACT", "ENTITY"],
	CONTACTS: ["CONTACT", "ENTITY"],
	ROLODEX: ["CONTACT", "ENTITY"],
	// Document-read inventions resolve to the DOCUMENT umbrella. Stage-1 (and
	// the evaluator) routinely invent DOCUMENT_SEARCH / LIST_DOCUMENTS for
	// "what documents do i have"; without the alias the turn fell through to a
	// raw DATABASE_QUERY guessing a `documents` table (which failed), observed
	// live. The DOCUMENT similes are lowercase phrases that never match these
	// UPPER_SNAKE inventions.
	DOCUMENT_SEARCH: ["DOCUMENT"],
	SEARCH_DOCUMENTS: ["DOCUMENT"],
	SEARCH_DOCUMENT: ["DOCUMENT"],
	LIST_DOCUMENTS: ["DOCUMENT"],
	LIST_DOCUMENT: ["DOCUMENT"],
	READ_DOCUMENT: ["DOCUMENT"],
	READ_DOCUMENTS: ["DOCUMENT"],
	DOCUMENTS: ["DOCUMENT"],
	GET_DOCUMENTS: ["DOCUMENT"],
	SHOW_DOCUMENTS: ["DOCUMENT"],
	FIND_MESSAGES: ["MESSAGE"],
	FIND_MESSAGE: ["MESSAGE"],
	ARRANGE_VIEWS: ["VIEWS"],
	CLOSE_ALL_VIEWS: ["VIEWS"],
	CLOSE_VIEW: ["VIEWS"],
	LIST_VIEWS: ["VIEWS"],
	// Stage-1 sometimes names the Home destination rather than its navigation
	// action. Resolve that model hint through the existing VIEWS parent; the
	// authorized view catalog and planner still select and execute the target.
	HOME: ["VIEWS"],
	OPEN_APP: ["VIEWS", "APP"],
	OPEN_APPLICATION: ["VIEWS", "APP"],
	OPEN_VIEW: ["VIEWS"],
	SHOW_APP: ["VIEWS", "APP"],
	SHOW_APPLICATION: ["VIEWS", "APP"],
	SHOW_VIEW: ["VIEWS"],
	SPLIT_VIEW: ["VIEWS"],
	SPLIT_VIEWS: ["VIEWS"],
	SWITCH_VIEW: ["VIEWS"],
	TILE_VIEWS: ["VIEWS"],
	VIEW_MANAGER: ["VIEWS"],
};

const VIEW_SURFACE_TOKENS = new Set([
	"VIEW",
	"VIEWS",
	"WINDOW",
	"WINDOWS",
	"PANEL",
	"PANELS",
	"APP",
	"APPS",
	"APPLICATION",
	"APPLICATIONS",
	"PLUGIN",
	"PLUGINS",
]);

const VIEW_OPERATION_TOKENS = new Set([
	"ADD",
	"ARRANGE",
	"CLOSE",
	"CREATE",
	"DELETE",
	"DISMISS",
	"GET",
	"GO",
	"HIDE",
	"LAYOUT",
	"LIST",
	"MANAGER",
	"NAVIGATE",
	"OPEN",
	"PIN",
	"READ",
	"REMOVE",
	"SELECT",
	"SET",
	"SHOW",
	"SPLIT",
	"SWITCH",
	"TILE",
	"UPDATE",
]);

function resolveTierOverridesFromEnv():
	| { stageWeights: Partial<Record<RetrievalStageName, number>> }
	| undefined {
	const raw =
		typeof process !== "undefined" ? process.env.MODEL_TIER?.trim() : undefined;
	if (
		raw !== "small" &&
		raw !== "mid" &&
		raw !== "large" &&
		raw !== "frontier"
	) {
		return undefined;
	}
	const entry = RETRIEVAL_TIER_DEFAULTS[raw];
	return {
		stageWeights: { ...entry.stageWeights },
	};
}

export function retrieveActions(
	input: RetrieveActionsInput,
): ActionRetrievalResponse {
	const candidateActions = dedupeNormalizedStrings(input.candidateActions);
	const catalogParentNames = new Set(
		input.catalog.parents.map((parent) => parent.normalizedName),
	);
	const parentActionHints = dedupeNormalizedStrings([
		...(input.parentActionHints ?? []),
		// A Stage-1 candidate that names an exposed parent is already an exact
		// catalog reference. Preserve that signal instead of forcing it through
		// fuzzy retrieval, where unrelated keyword-heavy parents can outrank it.
		...candidateActions.filter((actionName) =>
			catalogParentNames.has(normalizeActionName(actionName)),
		),
		...candidateActions.flatMap((actionName) => {
			// A candidate that IS a registered catalog parent already contributed
			// its exact hint above; its fallback aliases must not fire (the
			// canonical OWNER_* rows exist only for topologies where the parent
			// is absent).
			if (catalogParentNames.has(normalizeActionName(actionName))) return [];
			const explicitAliases =
				explicitParentAliasesForCandidateAction(actionName);
			if (explicitAliases.length > 0) return explicitAliases;
			// A candidate that is a real simile claimed by multiple parents is
			// ambiguous by contract — the shape heuristics below (coding-name →
			// TASKS, view-name → VIEWS) must not overrule that refusal (live
			// regression: GITHUB_LIST_ISSUES claimed by TASKS and a repo-issues
			// parent still exact-hinted TASKS via the coding-token heuristic).
			if (
				collectAmbiguousSimiles(input.catalog.parents).has(
					normalizeActionName(actionName),
				)
			) {
				return [];
			}
			return candidateNamespaceParentExists(input.catalog.parents, actionName)
				? []
				: parentAliasesForCandidateAction(actionName);
		}),
		// Stage-1 routinely hints an action by one of its similes — the canonical
		// documented example is candidateActions=["BASH"] for the SHELL parent
		// (message-handler.ts). Similes feed the fuzzy search text but carry no
		// rank guarantee, so a simile hint can lose the surface cut to unrelated
		// keyword matches and reach the planner as a dead hint (it then improvises
		// with whatever tools did rank, or falsely reports missing tool access).
		// Resolve simile hints to their catalog parent so they exact-score like
		// any explicit parent hint.
		...resolveSimileParentHints(input.catalog.parents, candidateActions),
	]);
	const recentConversationText = shouldUseRecentConversationForActionSearch(
		input.messageText ?? "",
	)
		? normalizeTextList(input.recentConversationText)
		: [];
	const candidateActionsForSearch =
		recentConversationText.length > 0
			? candidateActions.filter(
					(actionName) =>
						parentAliasesForCandidateAction(actionName).length > 0,
				)
			: candidateActions;
	const queryText = [
		input.messageText ?? "",
		...recentConversationText,
		...candidateActionsForSearch,
	].join("\n");
	const queryTokens = tokenizeActionSearchText(queryText);
	const keywordQueryTexts = [
		input.messageText ?? "",
		...recentConversationText,
		...candidateActionsForSearch,
	].filter((text) => text.trim().length > 0);
	const exactScores = scoreExactHints(input.catalog.parents, parentActionHints);
	const regexScores = scoreCandidateRegex(
		input.catalog.parents,
		candidateActionsForSearch,
	);
	const keywordScores = scoreKeywordMatches(
		input.catalog.parents,
		keywordQueryTexts,
	);
	const bm25Scores = scoreBm25(input.catalog.parents, queryTokens);
	const embeddingScores = scoreEmbeddingTieBreaker(
		input.catalog.parents,
		input.embedding,
	);
	const isBareSingleTokenQuery =
		parentActionHints.length === 0 &&
		candidateActions.length === 0 &&
		queryTokens.length <= 1;

	const stageRankings: Partial<
		Record<RetrievalStageName, Map<string, number>>
	> = {
		exact: rankScores(exactScores),
		regex: rankScores(regexScores),
		keyword: rankScores(keywordScores),
		bm25: rankScores(bm25Scores),
		embedding: rankScores(embeddingScores),
	};
	const envOverrides = resolveTierOverridesFromEnv();
	const effectiveOverrides = input.tierOverrides ?? envOverrides;
	const stageWeights = effectiveOverrides?.stageWeights;
	const rrfScores = reciprocalRankFusion(stageRankings, stageWeights);
	const maxRrf = Math.max(0, ...rrfScores.values());
	const maxKeyword = Math.max(0, ...keywordScores.values());
	const maxBm25 = Math.max(0, ...bm25Scores.values());
	const maxEmbedding = Math.max(0, ...embeddingScores.values());

	const selectedContextSet = new Set(
		(input.selectedContexts ?? []).map((c) => c.toLowerCase()),
	);
	const results = input.catalog.parents.map((parent) => {
		const normalizedName = parent.normalizedName;
		const exact = exactScores.get(normalizedName) ?? 0;
		const regex = regexScores.get(normalizedName) ?? 0;
		const keywordRaw = keywordScores.get(normalizedName) ?? 0;
		const bm25Raw = bm25Scores.get(normalizedName) ?? 0;
		const embeddingRaw = embeddingScores.get(normalizedName) ?? 0;
		const keyword = maxKeyword > 0 ? keywordRaw / maxKeyword : 0;
		const bm25 = maxBm25 > 0 ? bm25Raw / maxBm25 : 0;
		const embedding = maxEmbedding > 0 ? embeddingRaw / maxEmbedding : 0;
		const rrfRaw = rrfScores.get(normalizedName) ?? 0;
		const rrf = maxRrf > 0 ? rrfRaw / maxRrf : 0;
		const stageScores: ActionRetrievalResult["stageScores"] = {};

		if (exact > 0) {
			stageScores.exact = exact;
		}
		if (regex > 0) {
			stageScores.regex = regex;
		}
		if (keyword > 0) {
			stageScores.keyword = roundScore(keyword);
		}
		if (bm25 > 0) {
			stageScores.bm25 = roundScore(bm25);
		}
		if (embedding > 0) {
			stageScores.embedding = roundScore(embedding);
		}

		const baseScore = Math.max(
			exact,
			regex,
			keyword > 0 ? 0.35 + keyword * 0.5 : 0,
			bm25 > 0 ? 0.28 + bm25 * (isBareSingleTokenQuery ? 0.38 : 0.49) : 0,
			embedding > 0 ? 0.25 + embedding * 0.45 : 0,
			rrf > 0 ? 0.2 + rrf * (isBareSingleTokenQuery ? 0.45 : 0.5) : 0,
		);

		// Context-match boost: when the messageHandler picked contexts that
		// intersect this parent's declared `contexts`, give it a meaningful
		// additive bump. The boost is large enough to reorder tier-A when a
		// context-aligned candidate has a comparable raw retrieval score
		// (e.g. OWNER_ROUTINES vs BLOCK both keyword-match "every day" — context
		// says the user is in tasks/general, so OWNER_ROUTINES wins). Context alone is not a
		// retrieval signal; otherwise every action sharing a broad context can
		// leak into Tier B without matching the turn.
		const parentContexts: readonly unknown[] = Array.isArray(parent.contexts)
			? parent.contexts
			: [];
		let contextBoost = 0;
		if (
			baseScore > 0 &&
			selectedContextSet.size > 0 &&
			parentContexts.length > 0
		) {
			const intersect = parentContexts.some((c) =>
				selectedContextSet.has(String(c).toLowerCase()),
			);
			if (intersect) {
				contextBoost = 0.3;
				stageScores.contextMatch = contextBoost;
			}
		}

		const score = clampScore(baseScore + contextBoost);

		return {
			parent,
			name: parent.name,
			normalizedName,
			score,
			rank: 0,
			rrfScore: roundScore(rrfRaw),
			stageScores,
			matchedBy: Object.keys(stageScores) as RetrievalStageName[],
		};
	});

	const saturatedResults = results.filter((result) => result.score === 1);
	const needsMessageOnlyTieBreak =
		saturatedResults.length > 1 &&
		saturatedResults.some((result) => (result.stageScores.exact ?? 0) > 0);
	const messageEvidenceByParent = new Map<string, number>();
	if (needsMessageOnlyTieBreak) {
		// Candidate names intentionally participate in the main fuzzy retrieval
		// so invented child/simile hints can still resolve to a catalog parent.
		// Re-score without candidate text only for a saturated exact-hint tie;
		// otherwise the hint gives itself the BM25/keyword evidence that should
		// distinguish a wrong Stage-1 guess from the user's actual request.
		const messageOnlyQueryTexts = [
			input.messageText ?? "",
			...recentConversationText,
		].filter((text) => text.trim().length > 0);
		const messageOnlyKeywordScores = scoreKeywordMatches(
			input.catalog.parents,
			messageOnlyQueryTexts,
		);
		const messageOnlyBm25Scores = scoreBm25(
			input.catalog.parents,
			tokenizeActionSearchText(messageOnlyQueryTexts.join("\n")),
		);
		const maxMessageOnlyKeyword = Math.max(
			0,
			...messageOnlyKeywordScores.values(),
		);
		const maxMessageOnlyBm25 = Math.max(0, ...messageOnlyBm25Scores.values());
		for (const parent of input.catalog.parents) {
			const keywordRaw =
				messageOnlyKeywordScores.get(parent.normalizedName) ?? 0;
			const bm25Raw = messageOnlyBm25Scores.get(parent.normalizedName) ?? 0;
			const embeddingRaw = embeddingScores.get(parent.normalizedName) ?? 0;
			const keyword =
				maxMessageOnlyKeyword > 0 ? keywordRaw / maxMessageOnlyKeyword : 0;
			const bm25 = maxMessageOnlyBm25 > 0 ? bm25Raw / maxMessageOnlyBm25 : 0;
			const embedding = maxEmbedding > 0 ? embeddingRaw / maxEmbedding : 0;
			const hasMessageEvidence = keyword > 0 || bm25 > 0 || embedding > 0;
			const parentContexts: readonly unknown[] = Array.isArray(parent.contexts)
				? parent.contexts
				: [];
			const contextMatch =
				hasMessageEvidence &&
				selectedContextSet.size > 0 &&
				parentContexts.some((context) =>
					selectedContextSet.has(String(context).toLowerCase()),
				)
					? 0.3
					: 0;
			messageEvidenceByParent.set(
				parent.normalizedName,
				roundScore(keyword + bm25 + embedding + contextMatch),
			);
		}
	}

	results.sort((left, right) => {
		// Use one key for the whole saturated cohort once an exact hint contests
		// it. A pair-specific "one side is exact" key can make a three-result
		// comparator non-transitive; runs without a saturated exact hint still
		// fall through to their unchanged RRF ordering.
		const saturatedHintCohortTie =
			needsMessageOnlyTieBreak && left.score === 1 && right.score === 1;
		return (
			right.score - left.score ||
			(saturatedHintCohortTie
				? (messageEvidenceByParent.get(right.normalizedName) ?? 0) -
					(messageEvidenceByParent.get(left.normalizedName) ?? 0)
				: 0) ||
			right.rrfScore - left.rrfScore ||
			left.normalizedName.localeCompare(right.normalizedName)
		);
	});

	for (let index = 0; index < results.length; index += 1) {
		results[index].rank = index + 1;
	}

	let measurement: RetrievalMeasurement | undefined;
	if (input.measurementMode === true) {
		// Capture each stage's pre-fusion ranking so the analyzer can compute
		// stage-by-stage recall. Context-match scores are recomputed from the
		// per-parent boost so they're available alongside the other five
		// stages even though they're applied as an additive bump in the main
		// loop, not as a ranking source.
		const selectedContextSetForMeasurement = selectedContextSet;
		const contextMatchScores = new Map<string, number>();
		for (const parent of input.catalog.parents) {
			const parentContexts: readonly unknown[] = Array.isArray(parent.contexts)
				? parent.contexts
				: [];
			if (
				selectedContextSetForMeasurement.size > 0 &&
				parentContexts.length > 0 &&
				parentContexts.some((c) =>
					selectedContextSetForMeasurement.has(String(c).toLowerCase()),
				)
			) {
				contextMatchScores.set(parent.normalizedName, 1);
			}
		}

		measurement = {
			perStageScores: {
				exact: mapToStageEntries(exactScores),
				regex: mapToStageEntries(regexScores),
				keyword: mapToStageEntries(keywordScores),
				bm25: mapToStageEntries(bm25Scores),
				embedding: mapToStageEntries(embeddingScores),
				contextMatch: mapToStageEntries(contextMatchScores),
			},
			fusedTopK: Array.from(rrfScores.entries())
				.sort(([leftName, leftScore], [rightName, rightScore]) => {
					return rightScore - leftScore || leftName.localeCompare(rightName);
				})
				.map(([name, rrfScore], index) => ({
					actionName: name,
					rrfScore: roundScore(rrfScore),
					rank: index + 1,
				})),
		};
	}

	return {
		results,
		warnings: input.catalog.warnings,
		query: {
			text: queryText,
			tokens: queryTokens,
			candidateActions,
			parentActionHints,
		},
		...(measurement ? { measurement } : {}),
	};
}

function mapToStageEntries(scores: Map<string, number>): RetrievalStageEntry[] {
	return Array.from(scores.entries())
		.filter(([, score]) => score > 0)
		.sort(([leftName, leftScore], [rightName, rightScore]) => {
			return rightScore - leftScore || leftName.localeCompare(rightName);
		})
		.map(([actionName, score], index) => ({
			actionName,
			score: roundScore(score),
			rank: index + 1,
		}));
}

export function tokenizeActionSearchText(text: string): string[] {
	return String(text)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_:/.-]+/g, " ")
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);
}

function scoreExactHints(
	parents: ActionCatalogParent[],
	parentActionHints: string[],
): Map<string, number> {
	const hints = new Set(
		parentActionHints.map(normalizeActionName).filter(Boolean),
	);
	const scores = new Map<string, number>();

	for (const parent of parents) {
		if (hints.has(parent.normalizedName)) {
			scores.set(parent.normalizedName, 1);
		}
	}

	return scores;
}

function scoreCandidateRegex(
	parents: ActionCatalogParent[],
	candidateActions: string[],
): Map<string, number> {
	const patterns = buildCandidatePatterns(candidateActions);
	const scores = new Map<string, number>();

	for (const parent of parents) {
		const searchableNames = [
			parent.normalizedName,
			...parent.childNormalizedNames,
		];

		for (const pattern of patterns) {
			const namespaceHit =
				pattern.namespace && pattern.namespace === parent.normalizedName;
			const nameHit = searchableNames.some((name) => pattern.regex.test(name));
			if (namespaceHit || nameHit) {
				scores.set(
					parent.normalizedName,
					Math.max(scores.get(parent.normalizedName) ?? 0, pattern.score),
				);
			}
		}
	}

	return scores;
}

interface ParentScoringTokens {
	tokens: string[];
	length: number;
	set: Set<string>;
	termFrequency: Map<string, number>;
}

// Per-catalog-parent scoring tokens, memoized by the parent object. The parent's
// searchText is static, so tokenization + the term-frequency map are pure
// functions of it. Keyed by object identity in a WeakMap so it's recomputed only
// when the catalog rebuilds (new parent objects) and auto-collected when the
// catalog is dropped. The returned termFrequency map is read-only at the call
// sites, so sharing it across calls is safe.
const parentScoringCache = new WeakMap<
	ActionCatalogParent,
	ParentScoringTokens
>();

function getParentScoringTokens(
	parent: ActionCatalogParent,
): ParentScoringTokens {
	const cached = parentScoringCache.get(parent);
	if (cached) {
		return cached;
	}
	const tokens = tokenizeActionSearchText(parent.searchText);
	const termFrequency = new Map<string, number>();
	for (const token of tokens) {
		termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
	}
	const computed: ParentScoringTokens = {
		tokens,
		length: tokens.length,
		set: new Set(tokens),
		termFrequency,
	};
	parentScoringCache.set(parent, computed);
	return computed;
}

function scoreBm25(
	parents: ActionCatalogParent[],
	queryTokens: string[],
): Map<string, number> {
	const scores = new Map<string, number>();
	if (parents.length === 0 || queryTokens.length === 0) {
		return scores;
	}

	const documents = parents.map((parent) => ({
		parent,
		scoring: getParentScoringTokens(parent),
	}));
	const averageDocumentLength =
		documents.reduce((sum, document) => sum + document.scoring.length, 0) /
		Math.max(1, documents.length);
	const documentFrequency = new Map<string, number>();
	const queryVocabulary = Array.from(new Set(queryTokens));

	for (const token of queryVocabulary) {
		let count = 0;
		for (const document of documents) {
			if (document.scoring.set.has(token)) {
				count += 1;
			}
		}
		documentFrequency.set(token, count);
	}

	for (const document of documents) {
		const { termFrequency, length: documentLength } = document.scoring;

		let score = 0;
		for (const token of queryTokens) {
			const frequency = termFrequency.get(token) ?? 0;
			if (frequency === 0) {
				continue;
			}

			const documentsWithTerm = documentFrequency.get(token) ?? 0;
			const idf = Math.log(
				1 +
					(parents.length - documentsWithTerm + 0.5) /
						(documentsWithTerm + 0.5),
			);
			const denominator =
				frequency +
				BM25_K1 *
					(1 -
						BM25_B +
						BM25_B * (documentLength / Math.max(1, averageDocumentLength)));
			score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
		}

		if (score > 0) {
			scores.set(document.parent.normalizedName, score);
		}
	}

	return scores;
}

// Per-parent prepared keyword terms, memoized by parent object identity like
// parentScoringCache: keywordText is static for a catalog build, and the
// prepared form (deduped raw terms with compiled patterns) is a pure function
// of it. Recomputed only when the catalog rebuilds; collected with it.
const preparedKeywordTermsCache = new WeakMap<
	ActionCatalogParent,
	PreparedKeywordTerm[]
>();

function getPreparedKeywordTerms(
	parent: ActionCatalogParent,
): PreparedKeywordTerm[] {
	const cached = preparedKeywordTermsCache.get(parent);
	if (cached) {
		return cached;
	}
	const prepared = prepareKeywordTerms(
		parent.keywordText
			.split(/\n+/)
			.map((term) => term.trim())
			.filter(Boolean),
	);
	preparedKeywordTermsCache.set(parent, prepared);
	return prepared;
}

function scoreKeywordMatches(
	parents: ActionCatalogParent[],
	queryTexts: readonly string[],
): Map<string, number> {
	const scores = new Map<string, number>();
	if (parents.length === 0 || queryTexts.length === 0) {
		return scores;
	}
	// The keyword score is the size of a term set, so a text repeated in the
	// query (continuation turns fold the whole recent conversation in, with
	// identical lines) cannot change it and is matched once.
	const distinctTexts = [...new Set(queryTexts)];

	for (const parent of parents) {
		const prepared = getPreparedKeywordTerms(parent);
		if (prepared.length === 0) {
			continue;
		}
		const score = collectPreparedKeywordTermMatches(
			distinctTexts,
			prepared,
		).size;
		if (score > 0) {
			scores.set(parent.normalizedName, score);
		}
	}

	return scores;
}

function scoreEmbeddingTieBreaker(
	parents: ActionCatalogParent[],
	embedding?: ActionEmbeddingTieBreaker,
): Map<string, number> {
	const scores = new Map<string, number>();
	if (!embedding?.enabled || !embedding.scoresByParentName) {
		return scores;
	}

	for (const parent of parents) {
		const score =
			embedding.scoresByParentName[parent.name] ??
			embedding.scoresByParentName[parent.normalizedName] ??
			embedding.scoresByParentName[parent.normalizedName.toLowerCase()];
		if (typeof score === "number" && Number.isFinite(score) && score > 0) {
			scores.set(parent.normalizedName, score);
		}
	}

	return scores;
}

type CandidatePattern = {
	regex: { test: (value: string) => boolean };
	namespace?: string;
	score: number;
};

function buildCandidatePatterns(
	candidateActions: string[],
): CandidatePattern[] {
	const patterns: CandidatePattern[] = [];

	for (const candidateAction of candidateActions) {
		const normalized = normalizeActionName(candidateAction);
		if (!normalized) {
			continue;
		}

		if (candidateAction.includes("*")) {
			const wildcardRegex = wildcardCandidateRegex(candidateAction);
			if (wildcardRegex) {
				patterns.push({
					regex: wildcardRegex,
					namespace: normalized.split("_")[0],
					score: 0.8,
				});
			}
			continue;
		}

		patterns.push({
			regex: new RegExp(`^${escapeRegex(normalized)}$`),
			score: 0.95,
		});

		const [namespace] = normalized.split("_");
		if (namespace && namespace === normalized) {
			patterns.push({
				regex: new RegExp(`^${escapeRegex(namespace)}(?:_|$)`),
				namespace,
				score: 0.8,
			});
		}
	}

	return patterns;
}

function rankScores(scores: Map<string, number>): Map<string, number> {
	const ranked = new Map<string, number>();
	Array.from(scores.entries())
		.filter(([, score]) => score > 0)
		.sort(([leftName, leftScore], [rightName, rightScore]) => {
			return rightScore - leftScore || leftName.localeCompare(rightName);
		})
		.forEach(([name], index) => {
			ranked.set(name, index + 1);
		});
	return ranked;
}

function reciprocalRankFusion(
	stageRankings: Partial<Record<RetrievalStageName, Map<string, number>>>,
	stageWeights?: Partial<Record<RetrievalStageName, number>>,
): Map<string, number> {
	const scores = new Map<string, number>();

	for (const [stageName, ranking] of Object.entries(stageRankings) as Array<
		[RetrievalStageName, Map<string, number> | undefined]
	>) {
		if (!ranking) {
			continue;
		}
		const weight = stageWeights?.[stageName] ?? 1;

		for (const [name, rank] of ranking.entries()) {
			scores.set(name, (scores.get(name) ?? 0) + weight / (RRF_K + rank));
		}
	}

	return scores;
}

function dedupeNormalizedStrings(values: string[] | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values ?? []) {
		if (typeof value !== "string") {
			continue;
		}

		const trimmed = value.trim();
		const normalized = normalizeActionName(trimmed);
		if (!trimmed || !normalized || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		result.push(trimmed);
	}

	return result;
}

export function parentAliasesForCandidateAction(actionName: string): string[] {
	const normalized = normalizeActionName(actionName);
	const explicit = explicitParentAliasesForCandidateAction(actionName);
	if (explicit.length > 0) return explicit;
	// Permission/access management is SETTINGS (grant/revoke an app's fs/net
	// namespace, OS permission requests, shell access) — never view navigation.
	// Checked before the view/app surface heuristics because Stage-1 invents
	// names like SET_APP_NETWORK_PERMISSION / REVOKE_NETWORK_ACCESS whose SET+APP
	// tokens otherwise trip looksLikeViewCandidateAction and route the write to
	// the VIEWS catalog, so "revoke network access for the weather app" never
	// reaches the SETTINGS writer (#14622).
	if (looksLikeSettingsPermissionCandidateAction(normalized)) {
		return ["SETTINGS"];
	}
	const aliases: string[] = [];
	if (looksLikeViewCandidateAction(normalized)) {
		aliases.push("VIEWS");
	}
	// App-operation candidates (LIST_APPS, GET_INSTALLED_APPS, LAUNCH_APP, …)
	// hint the APP parent alongside any views hint: Stage-1 models routinely
	// describe an installed-apps request with such names, and without this hint
	// the VIEWS token overlap (APP/APPS are also view-surface words) routed
	// every app ask to the views catalog (#9950).
	if (looksLikeAppCandidateAction(normalized) && !aliases.includes("APP")) {
		aliases.push("APP");
	}
	return aliases;
}

function explicitParentAliasesForCandidateAction(actionName: string): string[] {
	const normalized = normalizeActionName(actionName);
	const explicit = CANDIDATE_ACTION_PARENT_ALIASES[normalized];
	if (explicit) return [...explicit];
	// Arithmetic-shaped inventions (CALC_RESULT, DO_MATH, MULTIPLY_NUMBERS …)
	// are open-ended — Stage 1 produces a fresh spelling per turn — so they
	// hint the deterministic evaluator by family; admission still passes
	// through appendIfAllowed's role/context gates.
	if (
		/(?:^|[^A-Z0-9])(?:CALC(?:ULATE)?|MATH|ARITH(?:METIC)?|MULTIPLY|DIVIDE)(?:[^A-Z0-9]|$)/u.test(
			actionName.toUpperCase(),
		)
	) {
		return ["CALCULATE"];
	}
	// Recap/summary-shaped inventions are open-ended — Stage 1 produces a fresh
	// spelling per turn (live 2026-08-23: TASKS_RECAP_DAY, then RECAP_DAY, then
	// GET_TASKS_SUMMARY for the same ask), so exact-name aliases cannot keep
	// up. Any candidate whose name carries the recap/summary stem hints the
	// room-transcript reader plus the TASKS umbrella (tracked-work day recaps);
	// admission still passes through appendIfAllowed's role/context gates.
	if (/RECAP|SUMMAR/.test(normalized)) {
		return ["CHANNEL_RECAP", "TASKS"];
	}
	return [];
}

const APP_SURFACE_TOKENS = new Set([
	"APP",
	"APPS",
	"APPLICATION",
	"APPLICATIONS",
]);

const APP_OPERATION_TOKENS = new Set([
	"BUILD",
	"CREATE",
	"GET",
	"INSTALL",
	"INSTALLED",
	"LAUNCH",
	"LIST",
	"OPEN",
	"REGISTER",
	"RELAUNCH",
	"RESTART",
	"RUN",
	"RUNNING",
	"SCAFFOLD",
	"SHOW",
	"START",
	"STOP",
]);

function looksLikeAppCandidateAction(normalizedActionName: string): boolean {
	if (!normalizedActionName) return false;
	const tokens = new Set(normalizedActionName.split(/_+/).filter(Boolean));
	return (
		hasAnyToken(tokens, APP_SURFACE_TOKENS) &&
		hasAnyToken(tokens, APP_OPERATION_TOKENS)
	);
}

// A permission namespace/surface must accompany a bare ACCESS token before it
// counts as a settings-permission ask: this keeps "REVOKE_NETWORK_ACCESS" /
// "GRANT_FILESYSTEM_ACCESS" / "REVOKE_SHELL_ACCESS" (permission writes SETTINGS
// owns) mapping to SETTINGS while leaving a person-scoped "REVOKE_ACCESS" (which
// is BLOCK, not a settings write) untouched.
const SETTINGS_PERMISSION_NAMESPACE_TOKENS = new Set([
	"APP",
	"APPS",
	"CAMERA",
	"FILESYSTEM",
	"FS",
	"LOCATION",
	"MIC",
	"MICROPHONE",
	"NET",
	"NETWORK",
	"NOTIFICATION",
	"NOTIFICATIONS",
	"SCREEN",
	"SHELL",
]);

const SETTINGS_PERMISSION_OPERATION_TOKENS = new Set([
	"ALLOW",
	"CHANGE",
	"DENY",
	"DISABLE",
	"ENABLE",
	"GRANT",
	"REQUEST",
	"REVOKE",
	"SET",
	"TOGGLE",
	"TURN",
	"UPDATE",
]);

function looksLikeSettingsPermissionCandidateAction(
	normalizedActionName: string,
): boolean {
	if (!normalizedActionName) return false;
	const tokens = new Set(normalizedActionName.split(/_+/).filter(Boolean));
	if (!hasAnyToken(tokens, SETTINGS_PERMISSION_OPERATION_TOKENS)) return false;
	const namesAPermission =
		tokens.has("PERMISSION") || tokens.has("PERMISSIONS");
	const namesAScopedAccess =
		tokens.has("ACCESS") &&
		hasAnyToken(tokens, SETTINGS_PERMISSION_NAMESPACE_TOKENS);
	return namesAPermission || namesAScopedAccess;
}

function looksLikeViewCandidateAction(normalizedActionName: string): boolean {
	if (!normalizedActionName) return false;
	const tokens = new Set(normalizedActionName.split(/_+/).filter(Boolean));
	const hasViewSurface = hasAnyToken(tokens, VIEW_SURFACE_TOKENS);
	const hasViewOperation = hasAnyToken(tokens, VIEW_OPERATION_TOKENS);
	const hasGeneratedCapabilityShape =
		hasViewOperation && tokens.size >= 2 && !hasOnlyOperationTokens(tokens);
	return hasViewOperation && (hasViewSurface || hasGeneratedCapabilityShape);
}

function hasAnyToken(tokens: Set<string>, expected: Set<string>): boolean {
	for (const token of tokens) {
		if (expected.has(token)) return true;
	}
	return false;
}

function hasOnlyOperationTokens(tokens: Set<string>): boolean {
	for (const token of tokens) {
		if (!VIEW_OPERATION_TOKENS.has(token)) return false;
	}
	return true;
}

/** Once-per-process dedupe for the ambiguous-simile warn — the resolver runs
 *  on every retrieval and the catalog is stable within a process. */
const warnedAmbiguousSimiles = new Set<string>();

/** Normalized similes claimed by MORE than one catalog parent — routing on
 * one of these steals the intent from the other parent (#16561), so both the
 * simile resolver and the shape-heuristic alias fallback must refuse them. */
function collectAmbiguousSimiles(
	parents: readonly ActionCatalogParent[],
): Set<string> {
	const parentNames = new Set(parents.map((parent) => parent.normalizedName));
	const claimed = new Map<string, string>();
	const ambiguous = new Set<string>();
	for (const parent of parents) {
		const ownSimiles = new Set(
			[
				...parent.similes,
				...parent.children.flatMap((child) => child.similes),
			].flatMap((simile) => {
				const normalized = normalizeActionName(simile);
				return !normalized || parentNames.has(normalized) ? [] : [normalized];
			}),
		);
		for (const normalized of ownSimiles) {
			const claimedBy = claimed.get(normalized);
			if (claimedBy !== undefined && claimedBy !== parent.normalizedName) {
				ambiguous.add(normalized);
				continue;
			}
			claimed.set(normalized, parent.normalizedName);
		}
	}
	return ambiguous;
}

function resolveSimileParentHints(
	parents: readonly ActionCatalogParent[],
	candidateActions: readonly string[],
): string[] {
	if (candidateActions.length === 0) {
		return [];
	}
	const parentNames = new Set(parents.map((parent) => parent.normalizedName));
	const parentBySimile = new Map<string, string>();
	// A simile claimed by MORE than one parent is ambiguous and must not route
	// at all (#16561): first-writer-wins silently steals the intent from the
	// other parent (catalog order is alphabetical, not semantic — e.g. a
	// LIST_FILES simile on both a file-ops action and a stored-media action).
	// The warn dedupes per process: this resolver runs on every retrieval.
	const ambiguousSimiles = new Set<string>();
	for (const parent of parents) {
		const ownSimiles = new Set(
			[
				...parent.similes,
				...parent.children.flatMap((child) => child.similes),
			].flatMap((simile) => {
				const normalized = normalizeActionName(simile);
				// A simile that collides with a real parent name must not hijack it.
				return !normalized || parentNames.has(normalized) ? [] : [normalized];
			}),
		);
		for (const normalized of ownSimiles) {
			const claimedBy = parentBySimile.get(normalized);
			if (claimedBy !== undefined && claimedBy !== parent.normalizedName) {
				if (!warnedAmbiguousSimiles.has(normalized)) {
					warnedAmbiguousSimiles.add(normalized);
					logger.warn(
						{
							src: "action-retrieval",
							simile: normalized,
							parents: [claimedBy, parent.normalizedName],
						},
						"simile claimed by multiple parents — dropped from routing as ambiguous",
					);
				}
				ambiguousSimiles.add(normalized);
				continue;
			}
			parentBySimile.set(normalized, parent.normalizedName);
		}
	}
	for (const normalized of ambiguousSimiles) {
		parentBySimile.delete(normalized);
	}
	return candidateActions.flatMap((actionName) => {
		const normalized = normalizeActionName(actionName);
		if (!normalized || parentNames.has(normalized)) {
			return [];
		}
		const parent = parentBySimile.get(normalized);
		return parent ? [parent] : [];
	});
}

export function candidateNamespaceParentExists(
	parents: readonly Pick<ActionCatalogParent, "normalizedName">[],
	actionName: string,
): boolean {
	const normalized = normalizeActionName(actionName);
	const tokens = normalized.split("_").filter(Boolean);
	if (
		tokens.length < 2 ||
		normalized === "VIEWS" ||
		hasAnyToken(new Set(tokens), VIEW_SURFACE_TOKENS)
	) {
		return false;
	}
	const domainTokens = tokens.filter(
		(token) => !VIEW_OPERATION_TOKENS.has(token) && token !== "VIEWS",
	);
	return parents.some((parent) =>
		domainTokens.some((token) => actionTokenMatchesParent(token, parent)),
	);
}

function actionTokenMatchesParent(
	token: string,
	parent: Pick<ActionCatalogParent, "normalizedName">,
): boolean {
	const parentName = parent.normalizedName;
	return (
		parentName === token ||
		parentName === `${token}S` ||
		(parentName.endsWith("S") && parentName.slice(0, -1) === token)
	);
}

function shouldUseRecentConversationForActionSearch(
	messageText: string,
): boolean {
	const normalized = messageText.toLowerCase().replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	return (
		/\b(?:again|continue|redo|rerun|retry|same|another\s+one|one\s+more|also|too)\b/iu.test(
			normalized,
		) ||
		/\b(?:do|run|make|build|check|try|send|show|open|fix|update|use|add|remove|delete|change|repeat)\b[\s\S]{0,80}\b(?:it|that|this|these|those|them|there|above|previous|last|same|one)\b/iu.test(
			normalized,
		)
	);
}

// App-surface control blocks ([FORM]/[CHOICE]/[FOLLOWUPS]/[TASK]/[CHECKLIST]
// and single-line [CONFIG:…] markers) travel inline in delivered message text.
// When a prior turn's reply carried one, its wire vocabulary ("navigate",
// "apps", "open", "prompt", …) is UI plumbing, not user intent — left in the
// retrieval window it floods keyword/bm25 scoring toward view/app actions and
// can evict the stage-1 candidate entirely (live tj-f8bdfafb488900: a reminder
// delete routed to CLOSE_ALL_VIEWS off a leaked [FOLLOWUPS] block). Strip the
// blocks from the conversation window before tokenization; the current user
// message is never stripped.
const CONTROL_BLOCK_MARKER_RE =
	/\[[ \t]*(?:FORM|CHOICE[^\]]*|FOLLOWUPS[^\]]*|TASK:[^\]]*|CHECKLIST)[ \t]*\][\s\S]*?\[[ \t]*\/[ \t]*(?:FORM|CHOICE|FOLLOWUPS|TASK|CHECKLIST)[ \t]*\]|\[CONFIG:[^\]]*\]/g;

export function stripControlBlockMarkers(text: string): string {
	return text.replace(CONTROL_BLOCK_MARKER_RE, " ");
}

function normalizeTextList(
	value: string | readonly string[] | undefined,
): string[] {
	if (typeof value === "string") {
		return [stripControlBlockMarkers(value).trim()].filter(Boolean);
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => stripControlBlockMarkers(entry).trim())
		.filter(Boolean);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

/**
 * Translates a wildcard candidate hint ("GMAIL_*", "GMAIL_SEND*", "*_DRAFT")
 * into a matcher over catalog-normalized action names. normalizeActionName
 * strips the "*" itself, so each literal segment between wildcards is
 * normalized with the real normalizer and only the star-adjacent separators
 * the hint actually wrote are re-attached afterward: "GMAIL_*" still means
 * GMAIL_ children (not bare GMAIL or a GMAILSYNC sibling), while the
 * separator-less "GMAIL_SEND*" still matches the exact name the glob is
 * anchored to (#20467). Matching is a linear scan, not `^lit.*lit.*$` regex —
 * a model hint of many stars used to hang retrieve-actions.
 */
function wildcardCandidateRegex(
	candidateAction: string,
): { test: (value: string) => boolean } | null {
	const rawSegments = String(candidateAction)
		.trim()
		.replace(/\*+/g, "*")
		.split("*");
	const lastIndex = rawSegments.length - 1;
	const parts = rawSegments.map((rawSegment, index) => {
		const normalized = normalizeActionName(rawSegment);
		if (!normalized) {
			// A separator-only segment between wildcards ("A*_*B") still
			// constrains the match. Overall whitespace was trimmed before splitting,
			// so a whitespace-only middle segment is also an intentional separator.
			return index > 0 && index < lastIndex && rawSegment.length > 0 ? "_" : "";
		}
		const lead = index > 0 && /^[^A-Za-z0-9]/.test(rawSegment) ? "_" : "";
		const trail =
			index < lastIndex && /[^A-Za-z0-9]$/.test(rawSegment) ? "_" : "";
		return `${lead}${normalized}${trail}`;
	});
	if (parts.every((part) => part === "")) {
		return null;
	}
	return {
		test: (value: string) => matchActionWildcardParts(parts, value),
	};
}

function clampScore(value: number): number {
	return roundScore(Math.max(0, Math.min(1, value)));
}

function roundScore(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
