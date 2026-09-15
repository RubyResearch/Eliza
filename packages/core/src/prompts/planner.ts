/**
 * Prompt template and output JSON schema for the planner, which turns the user
 * request and prior tool results into the smallest grounded queue of native
 * tool calls (or a user-visible message when no tool fits). Feeds the
 * planner-loop stage of the message loop. The schema keeps `args` a permissive
 * object — strict-grammar providers reject an empty `properties` shape — and
 * carries an optional `completed` signal the post-tool gate uses to decide
 * whether to fall through to a full evaluator pass. Native function-calling
 * envelopes cannot carry that top-level field, so every exposed tool schema
 * additionally accepts the reserved `eliza_turn_scope` argument (#17034),
 * which the loop folds into the same completion signal and strips before
 * dispatch.
 */
import type { JSONSchema } from "../types/model";

export const plannerBatchScopeDescription =
	'"final" means all requested actions are in this queue; their results need not be known yet. The evaluator verifies results and composes the answer. "more_work_pending" means these results must ground a later action (e.g. read an ID before updating). Queued actions, recalling prior dialogue, and writing the final answer do not require another batch. Use final for a read whose result only needs reporting or combining with known conversation details. Use more_work_pending only when a concrete additional operation must be chosen from the returned evidence, not because the evaluator still needs to answer.';

/** Canonical mandatory rules shared by default and custom planner prompts. */
export const plannerRequiredPolicy = {
	sideEffects:
		"- messageToUser alone cannot save, schedule, send, update, remember, or complete anything. Execute effects only when currently authorized. A preview-only request, withheld permission, or outstanding separate confirmation forbids the effect even when a matching tool exists; use a declared non-mutating preview operation if needed, otherwise propose the preview/question without executing it.",
	completedEffects:
		'- never say "saved", "logged", "scheduled", "sent", "updated", or "done" unless a tool result this turn proves it',
	widgets:
		"- Structured chat markers are allowed in messageToUser when they are the actual user-visible interaction payload: [FORM]\\n{json}\\n[/FORM], [CHOICE:scope id=id]\\nvalue=Label\\n[/CHOICE], [FOLLOWUPS id=id]\\nvalue=Label\\n[/FOLLOWUPS], or [TASK:threadId]Title[/TASK]. The JSON inside [FORM] is form data, not a tool attempt; keep JSON inside the marker and do not emit unrelated JSON.",
	responseStyle:
		"- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.",
	recallTools:
		"- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. Use the dedicated authorized search action (e.g. SEARCH_MESSAGES, MESSAGE_SEARCH, MEMORY_SEARCH); if absent, check DISCOVER_TOOLS when exposed before reporting unavailability. Never substitute shell greps, placeholder echoes or simulated searches.",
	discovery:
		"- candidateActions are retrieval hints, not executable capabilities. If a hinted name is absent, scan exposed tools and, when available, DISCOVER_TOOLS for an authorized operation covering the intent (e.g. TASKS_MANAGE_ISSUES instead of GITHUB_LIST_ISSUES, TRIGGER_CREATE instead of OWNER_REMINDERS). Continue after discovery with the loaded tool; discovery itself does no domain work. Respect any admission denial. Only report unavailable after the available discovery path cannot supply a fitting tool. Never invent SHELL/BROWSER/TASKS workarounds or echo commands to trigger missing capabilities; placeholder echoes burn cost and produce no progress.",
	codingDelegation:
		"- TASKS_SPAWN_AGENT delegates coding/build/repo work: file edits, shell tooling, apps, tests, deployments and PRs. It is not a fallback for chat-message recall, memory queries or agent-history lookups; use their dedicated authorized search tools or discovery, then report an actual limitation if unavailable. Do not spawn a coding agent to search a chat channel.",
	workClaims:
		'- messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening, has happened, or is about to happen unless the corresponding tool is in flight or has returned evidence THIS turn. This covers every tense, implied claim and subjectless progress phrase ("Searching...", "Working on it", "Almost done"), including promised future replies. The planner stops after returning; no further work runs without a new user message. If iterations end without usable results, state the actual attempted search/fetch and its outcome plainly; never promise an ongoing search or task that is not running.',
	errorClaims:
		"- messageToUser and REPLY text must NEVER fabricate a failure, error, or interruption that did not actually occur this turn. A real tool error or empty result is required before reporting a glitch, failure, interruption or asking the user to retry. Choosing not to act is not a malfunction: take the appropriate available action or explain truthfully what is possible and clarify scope when necessary. This applies regardless of wording; never invent a stall-and-retry excuse.",
} as const;

/** The settled-result round has no effect tools and must never plan more work. */
export const plannerReplyTemplate = `task: Write the final reply from the current request, supplied context and settled tool results.

rules:
- No action can execute in this round. Do not plan, replay, simulate or promise another operation. State an actual unresolved limitation or ask for needed user input if the results do not complete the request.
- Check every requested outcome against the result: a view switch does not prove a record was read or changed; a preview, pending handoff or partial result does not prove completion. Keep all applicable constraints and corrections. Do not infer missing facts or omitted history.
- Follow the supplied reply-only context-access protocol if original history or deferred provider details are needed. That read restores context without replaying any effect.
- Include requested actual output, exact values, links and relevant failures; do not replace results with a description of having fetched them. Prefer verified user-facing tool text when suitable.
${plannerRequiredPolicy.completedEffects}
${plannerRequiredPolicy.responseStyle}
${plannerRequiredPolicy.widgets}
${plannerRequiredPolicy.workClaims}
${plannerRequiredPolicy.errorClaims}
- Return the declared JSON envelope: short thought, toolCalls=[], messageToUser containing the complete natural reply, completed=true. A permitted context read instead uses its declared envelope with completed=false and no visible reply. No prose or fences outside JSON.
`;

export const plannerTemplate = `task: Plan next native tool calls.

rules:
- use only tools array; smallest grounded queue that covers every explicit requested outcome, including navigation separately from reading, searching, or changing data. Opening a visible browser/view and researching a question are separate outcomes: a background web search does not open the user's browser. Queue both when both are requested; do not demote navigation to an optional detail of the "main" task. Routing hints are not a replacement for the full user request; do not silently drop a clause.
- routed action: set parameters.action only if schema has it
- args grounded in user request or prior tool results
- obey schema; arrays as JSON arrays, not comma strings
- no empty strings/placeholders/invented required args; gather via grounded tool or no tool
- For currently authorized work, call a matching tool even with missing details; its handler owns required clarification and validation. Do not call a mutating operation to obtain permission the user explicitly withheld.
- Currently authorized life-management side effects (calendar events, reminders, alarms, todos, routines, goals, scheduled/recurring tasks) require the matching exposed tool before reporting completion. Match its name, routing hint and description, not a fixed required name. A tool-owned conflict, clarification, preview or confirmation result does not prove an effect happened; an operation that always commits is not a preview operation.
${plannerRequiredPolicy.sideEffects}
${plannerRequiredPolicy.completedEffects}
- messageToUser is user-visible only; no thoughts, analysis, tool names, function syntax, arbitrary JSON/tool attempts, "call MESSAGE"
${plannerRequiredPolicy.responseStyle}
- native toolCalls: pass each argument as a direct field in that tool's args object exactly as its schema declares; never nest arguments under \`parameters\` unless the tool schema itself declares a \`parameters\` field
- plain-JSON fallback only (when native tool calls are unavailable): return exactly {"action":"TOOL_NAME","parameters":{...},"thought":"short reason"}; never put that envelope inside a native tool's args
- owner goal save/create/update/review when OWNER_GOALS is exposed => native OWNER_GOALS args are {"action":"create|update|review","intent":"...","title":"...","confirmed":true|false,"details":{"description":"...","successCriteria":{"summary":"..."},"supportStrategy":{"summary":"..."} } }; only the plain-JSON fallback wraps those args in {"action":"OWNER_GOALS","parameters":{...},"thought":"..."}; never use messageToUser
${plannerRequiredPolicy.widgets}
- more tool work => native toolCalls only; never narrate/simulate calls
- partial after tool result => next grounded tool, not messageToUser
- A tool-required routing hint does not override user constraints. Propose a terminal preview/question when execution must wait for permission; completion evaluation judges outstanding intents. Otherwise attempt currently authorized work with an exposed non-terminal tool.
- incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try
- attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now; call tool
- exposed tool can try => call it; do not say "I cannot browse/search/run/inspect/build/deploy/verify"
${plannerRequiredPolicy.recallTools}
${plannerRequiredPolicy.discovery}
${plannerRequiredPolicy.codingDelegation}
- A one-shot live/current/public-data lookup — current price, weather, score, news headline, a status, or a value at a known URL — is NOT coding work: call WEB_FETCH (construct the single URL yourself) or WEB_SEARCH directly and answer from the result. Do NOT spawn a coding sub-agent for it: a sub-agent for a single lookup is slow, frequently re-spawns itself, and posts spurious "working on it" progress acks before answering. Spawn only when the task is genuinely build/code/repo/multi-step work.
- no authorized tool fits after available discovery, or task complete => no toolCalls, set messageToUser
- Batch scope: ${plannerBatchScopeDescription}
- native toolCalls: every tool requires the reserved arg \`eliza_turn_scope\` (stripped before execution); use the same batch scope on every call. In plain-JSON fallback, completed=true means "final", completed=false means "more_work_pending"; omit only when unknown. Neither form skips result verification.
${plannerRequiredPolicy.workClaims}
${plannerRequiredPolicy.errorClaims}
- When a tool call produced actual output (stdout, fetched content, search results, file listings, command output), the subsequent messageToUser must include that output directly — do not replace it with a meta-summary of what the tool did. Phrases like "Listed files as requested", "Provided the output as returned by X", "Returned the result", "Executed the command", "Searched and found results", or "Gathered the information" are meta-narration, not answers. If the tool already returned user-friendly text (verifiedUserFacing is true), prefer that text as the user-visible surface; do not wrap it with a separate process-status bubble ("on it", "working on it", "got it") after the tool finished.
- Do not put a pre-tool progress or acknowledgement bubble in messageToUser when you also emit toolCalls this turn. messageToUser is not delivered before tools run; after a successful tool drains the queue the post-tool gate treats an explicit messageToUser as the terminal reply and can skip the evaluator, so a pre-tool ack ("I'm connecting your calendar", "searching now") can replace the real tool outcome. Prefer toolCalls alone for work-in-progress; set messageToUser only as a terminal answer when no further tool work is needed, or as a grounded post-tool outcome that includes the tool result.

If context has "# Routing hints", follow them. They are action routingHint metadata for this turn's exposed actions only.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const plannerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		thought: { type: "string" },
		toolCalls: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					// Tool args are arbitrary per-tool. Permissive object schema —
					// no `additionalProperties: false`, no empty `properties: {}`.
					// Strict-grammar providers (Cerebras, etc.) reject the empty
					// shape with `Object fields require at least one of:
					// 'properties' or 'anyOf' with a list of possible properties`.
					args: { type: "object" },
				},
				required: ["name"],
			},
		},
		messageToUser: { type: "string" },
		// JSON equivalent of the native batch-scope argument. The post-tool
		// gate must preserve later action work when this is explicitly false.
		completed: {
			type: "boolean",
			description: `${plannerBatchScopeDescription} true means "final"; false means "more_work_pending".`,
		},
	},
	required: ["thought", "toolCalls"],
};
