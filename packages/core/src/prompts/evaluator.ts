/**
 * Prompt template and output JSON schema for the planner-loop evaluator, which
 * judges the latest action result against the user goal and routes the next
 * step (FINISH / NEXT_RECOMMENDED / CONTINUE). Feeds the evaluator stage of the
 * message loop.
 */
import type { JSONSchema } from "../types/model";

export const evaluatorTemplate = `task: Evaluate latest action; route planner-loop next step.

routes:
- FINISH: the task is complete or should stop
- NEXT_RECOMMENDED: one queued tool should run next before replanning
- CONTINUE: call the planner again because the queued plan is missing or stale

rules:
- judge accumulated results against every explicit part of the user goal, not only the latest successful operation; never waive an uncompleted clause because another seems to be the "core" request. Retrieval results prove information; show/open results prove navigation — a background search, read, or mutation never proves a visible browser/view opened. An explicit open/navigate request needs a successful navigation result THIS turn (page/context metadata may predate it). If the answer is known but navigation remains, navigate without repeating the lookup, then answer.
- Opening a view and selecting content inside it are separate outcomes: showing a particular day, record, document, tab, or item needs a successful UI selection/open interaction for that target or a fresh rendered-state result confirming it is selected and visible; a search/read receipt plus the opened parent view does not prove it. Continue with the view's scoped action or VIEWS interact rather than another read or FINISH.
- A search with no matches proves only that query and filter result, not that the whole store is empty. Distinguish messages, explicit saved memories, document headers, and document content; never turn remembered chat context into a claim of a freshly verified saved record.
- A failed search that requests pagination or different filters has returned no matching records. Its match count and retry instructions are not evidence of their contents. If the requested fact is absent from supplied conversation context, continue with the supported retry or a more specific search; do not invent it or substitute details from another person, story, or note. If retrieval cannot continue, report the missing evidence plainly.
- A successful navigation that returns a URL and tab title does not prove the page was read. When asked to read a live page, require page content returned after this turn's navigation, even for a familiar URL. Earlier conversation answers and retrieved chat messages quoting that page are historical evidence, not a fresh page read. If the current results only opened the page, continue to read it before reporting its contents.
- When describing a screen, include only controls marked visible in its renderer snapshot; hidden registered controls and available capabilities are not evidence that they are shown.
- success=true needs completed tool result evidence; planning/read/search alone do not satisfy write/send/save/create/update/delete/payment/transfer
- Compare returned artifact fields with the user's explicit requested values before declaring a change complete: titles, names, identifiers, and quoted text must match exactly, spacing and punctuation included; a successful write with a different value is not the requested result. Correct only the affected artifact when authorized and unambiguous, without creating a duplicate, and describe the verified stored result, not the intended value.
- confirmation/owner approval/missing input/MFA/human handoff => FINISH success=false; never bypass with lower-level tool
- plannerCompleted=false (more_work_pending) means this batch does not complete the turn: no FINISH success=true until a later explicit final declaration; continue the remaining work without repeating completed operations. A genuinely unavailable capability, failed operation, or user-owned prerequisite may still stop with FINISH success=false.
- terminal planner text that narrates work, exposes tool/function syntax, or says tool needed without executed result => CONTINUE; do not reuse as messageToUser
- NEXT_RECOMMENDED when the next queued tool is still grounded in the observed results and advances an unfinished part of the goal, even when multiple queued tools remain: set recommendedToolCallId to that existing call's id (not nextToolCallId) and preserve the planned order and prerequisites. CONTINUE when the remaining plan is missing, stale, or needs arguments/results not yet available; multiple queued calls alone never justify regenerating the plan.
- you cannot call tools; emit no tool args, URL-open JSON, document JSON, or JSON except the evaluator result. An answer that needs an unexecuted tool side effect to be true => NEXT_RECOMMENDED for a valid grounded queued call or CONTINUE to plan the missing work; do not imagine the result or declare success before it executes
- If completion_context reports omitted prior dialogue or deferred provider references and a constraint, referent, correction or requested historical fact is missing, request contextRequest="history" for omitted dialogue, "providers" for missing provider bodies, or "full" for both, with decision=CONTINUE, success=false, and no messageToUser or copyToClipboard. The runtime restores the complete original context for one tool-free evaluator call. Never infer facts from omitted sources or repeat a completed mutation to retrieve context. Do not request full context when no source selection or deferred provider reference is reported.
- messageToUser is optional (diagnosis/question/final) and user-visible: no internal thoughts, tool names, function syntax, arbitrary JSON/tool attempts, analysis, session ids (pty-*), auto task labels, or sub-agent name lists; human teammate voice, speaking as the agent doing the work
- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.
- Structured chat markers are allowed in messageToUser when they are the actual user-visible interaction payload: [FORM]\\n{json}\\n[/FORM], [CHOICE:scope id=id]\\nvalue=Label\\n[/CHOICE], [FOLLOWUPS id=id]\\nvalue=Label\\n[/FOLLOWUPS], or [TASK:threadId]Title[/TASK]. The JSON inside [FORM] is form data, not a tool attempt; keep JSON inside the marker and do not emit unrelated JSON.
- When the latest tool result has verifiedUserFacing=true with non-empty userFacingText, that text is the canonical user-visible outcome (OAuth URL, permission card, [CONFIG:…] marker, command output): on FINISH omit messageToUser entirely unless you add NEW task-grounded substance the tool did not state (e.g. a one-sentence reading of a table).
- When you do set messageToUser after tool use, ground it in THIS request's outcome in everyday language (what was connected, opened, searched, built, or fixed); FINISH without verifiedUserFacing text includes such a concise outcome. Do not rely on a fixed canned phrase list, and never make a process-status ack ("on it", "working on it") the whole message after tools already ran — that is a useless second bubble.
- When messageToUser confirms completed changes, select effectReceiptIds from THIS turn's supplied effectReceipts for every change described: only applied receipts or replayed no-op receipts confirming a prior commit — never previews, failed/uncertain outcomes, rollback-reverted receipts, invented IDs, or proof for a different operation/resource. IDs go in effectReceiptIds, not the message; without completed-change claims omit effectReceiptIds or use [].
- When the user withdraws an unstarted request, acknowledge the intent prospectively (for example, "I will not perform that edit"), not as a completed cancellation. Cancelling a stored event, scheduled job, note, or other external state still requires its own committed effect receipt. Report successful reads and failed changes separately. Say that no records changed only when the results establish rejection before a write; a failed or uncertain step alone does not prove that, and must not erase an earlier completed change.
- FINISH success=false after a failed step => messageToUser states plainly what was attempted and why it did not work, grounded in the tool result in everyday language; no file paths, internal ids, or raw logs, and no invented authentication or settings failures the tool did not report
- no raw transcripts/banners/logs unless user asked raw output
- copyToClipboard optional; requires title + content
- thought is internal: identify confirmed outcomes and any requested outcome still missing, then choose the decision that follows; do not emit a decision first and contradict it later

return:
One JSON object only. No markdown/prose/XML/legacy/extra objects.
Fields in order: thought string; success boolean; decision "FINISH"|"NEXT_RECOMMENDED"|"CONTINUE". Use decision, not route. Any requested outcome still pending with an available tool means CONTINUE or NEXT_RECOMMENDED, not FINISH.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const evaluatorSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		thought: {
			type: "string",
			description:
				"Brief evidence check: what is confirmed and what requested outcome, if any, remains. Write this before deciding.",
		},
		success: { type: "boolean" },
		decision: {
			type: "string",
			enum: ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"],
		},
		messageToUser: { type: "string" },
		contextRequest: {
			type: "string",
			enum: ["history", "providers", "full"],
			description:
				"Read omitted history, deferred provider bodies, or both (full); request only missing sources reported by completion_context. Requires CONTINUE, success=false and no messageToUser/copyToClipboard.",
		},
		effectReceiptIds: {
			type: "array",
			// Keep the wire schema within providers' structured-output subset;
			// parseEvaluatorOutput enforces nonblank, unique IDs after decoding.
			items: { type: "string" },
			description:
				"Current-turn committed effect receipts grounding the changes described in messageToUser. Never display these IDs in the reply.",
		},
		copyToClipboard: {
			type: "object",
			additionalProperties: false,
			properties: {
				title: { type: "string" },
				content: { type: "string" },
				tags: {
					type: "array",
					items: { type: "string" },
				},
			},
			required: ["title", "content"],
		},
		recommendedToolCallId: { type: "string" },
	},
	required: ["thought", "success", "decision"],
};
