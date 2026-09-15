/**
 * CHANNEL_RECAP — reads back the stored message history of the room the
 * triggering message arrived in, so a group-chat sender can ask for a recap,
 * summary, or "the last N messages" of their own channel. Live evidence
 * 2026-08-21: that ask routed to contexts=["general"], whose planner surface
 * carried no message-history tool (SEARCH_MESSAGES lives behind the ADMIN
 * messaging/email umbrella), so the agent honestly refused a request whose
 * content every room participant can already scroll.
 *
 * Room scoping is structural, not parametric: the handler reads only
 * `message.roomId` and exposes no room/channel selector, so a request from
 * room A can never return room B content and cross-room/inbox-wide search
 * stays gated on the messaging umbrella exactly as before.
 *
 * PROMPT-INTEGRITY (PR #26780): the requested range is served COMPLETE — every
 * rendered message carries its full stored text, chronologically ordered, with
 * no deliverable ceiling and no storage read bound; application-authored
 * size/item caps are banned. Storage traversal is exhaustive: keyset pages
 * (createdAt+id cursor) are pulled until the requested dialogue range is
 * satisfied or the store runs out, and store exhaustion is disclosed in the
 * result. A range too large to send to the model is NOT this action's
 * problem: the provider's documented context limit is the one real resource
 * boundary, and the dispatch-side overflow boundary owns that rejection.
 *
 * DIALOGUE HYGIENE vs application caps — the distinction matters: rows pass
 * through the canonical RECENT_MESSAGES dialogue-hygiene boundary
 * (`isHygienicDialogueMessage` + `dedupeHygienicDialogueMessages`, imported —
 * never forked — from recentMessages.ts) BEFORE they count toward the
 * requested depth. That boundary is the repo's model-exposure contract: it
 * strips what was never legitimate conversation (the agent's own
 * action_result records, internal bridge relays, synthetic assistant failure
 * replies, transient status posts, leaked tool transcripts, local-path
 * dumps). Only identical copies of the same stored record are deduplicated;
 * distinct message occurrences remain. Machinery cannot be laundered back to
 * the model — or to the user — through a recap. It is NOT an application
 * size cap: every row that survives hygiene is still served complete and
 * bounds-free, and hygienic rows are back-filled from older pages so
 * stripped rows never shrink the delivered range.
 */
import { getEntityDetails } from "../../../entities.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	AgentContext,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import { formatMessages } from "../../../utils.ts";
import {
	dedupeHygienicDialogueMessages,
	ensureFormattingEntities,
	isHygienicDialogueMessage,
} from "../providers/recentMessages.ts";

export const CHANNEL_RECAP_CONTEXTS = ["general"] satisfies AgentContext[];

/** Messages rendered when the caller does not name a count. */
export const CHANNEL_RECAP_DEFAULT_COUNT = 50;

/**
 * Internal batching detail only: how many rows one keyset page pulls from the
 * store while traversing toward the requested range. Never a bound on what a
 * recap serves — the traversal loops over as many pages as the range needs.
 */
export const CHANNEL_RECAP_PAGE_SIZE = 200;

/**
 * Parse a caller-supplied non-negative integer parameter. Integer-digits-only
 * for strings: "50.9" or "1e2" is malformed, not a request — the caller falls
 * back to the documented default rather than a silently reinterpreted value.
 */
function parseNonNegativeInt(raw: unknown): number | undefined {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		const floored = Math.floor(raw);
		return Number.isSafeInteger(floored) && floored >= 0 ? floored : undefined;
	}
	if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
		const parsed = Number(raw.trim());
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

function parameterRecord(
	options?: HandlerOptions,
): Record<string, unknown> | undefined {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: undefined;
}

export const channelRecapAction: Action = {
	name: "CHANNEL_RECAP",
	contexts: [...CHANNEL_RECAP_CONTEXTS],
	// Deliberately no roleGate: this is the CURRENT room's transcript — content
	// every participant can already read in their client (same GUEST-floor
	// rationale as the RECENT_MESSAGES provider). Cross-room and inbox-wide
	// reads stay on the ADMIN-gated MESSAGE umbrella.
	description:
		"Read back the recent message history of the CURRENT room/channel — the conversation this request arrived in — complete and in chronological order, so the reply can summarize, recap, or quote it: 'summarize this chat', 'recap the channel', 'what were the last 100 messages', 'what did people say here earlier'. Always scoped to this room only; searching other rooms, channels, or inboxes stays on MESSAGE.",
	descriptionCompressed:
		"read current room's own recent history for recap/summary/last-N-messages; this room only, cross-channel search stays on MESSAGE",
	routingHint:
		"recap/summarize/read back THIS chat's history -> CHANNEL_RECAP; cross-channel or inbox search -> MESSAGE (NOT this action)",
	similes: [
		"ROOM_HISTORY",
		"CHAT_HISTORY",
		"SUMMARIZE_CHAT",
		"RECAP_CHANNEL",
		"READ_RECENT_ROOM_MESSAGES",
		"LAST_MESSAGES",
	],
	parameters: [
		{
			name: "offset",
			description:
				"How many newest messages to skip before reading (default 0). Use it to page into older history.",
			schema: { type: "number" as const, minimum: 0 },
			required: false,
		},
		{
			name: "count",
			description: `How many most-recent messages to read back (default ${CHANNEL_RECAP_DEFAULT_COUNT}). The requested range is always served complete.`,
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
	],
	examples: [
		[
			{
				name: "User",
				content: {
					text: "what were the last 100 messages in this chat? give me a summary",
				},
			},
			{
				name: "Agent",
				content: {
					text: "Reading back this channel's history.",
					action: "CHANNEL_RECAP",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContext(message, state, { contexts: CHANNEL_RECAP_CONTEXTS }),

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<ActionResult> => {
		const roomId = message.roomId;
		if (!roomId) {
			return {
				success: false,
				text: "CHANNEL_RECAP requires a room-bound message; this message has no roomId.",
				values: { success: false },
				data: { actionName: "CHANNEL_RECAP" },
			};
		}

		const parameters = parameterRecord(options);
		const parsedCount = parseNonNegativeInt(parameters?.count);
		const count =
			parsedCount !== undefined && parsedCount >= 1
				? parsedCount
				: CHANNEL_RECAP_DEFAULT_COUNT;
		const offset = parseNonNegativeInt(parameters?.offset) ?? 0;
		const requestedDepth = count + offset;

		// Exhaustive newest-first keyset traversal: pull pages until the
		// requested DIALOGUE range is satisfied or the store runs out. Every row
		// passes the canonical RECENT_MESSAGES dialogue-hygiene boundary before
		// it can count toward the range: machinery (action_result records,
		// internal bridge relays), synthetic assistant failure replies, transient
		// status posts, leaked tool transcripts, and local-path dumps are dropped
		// per page, and the surviving rows are deduped with the same contract the
		// prompt transcript uses — so stripped rows never displace dialogue the
		// caller asked for AND can never be served back through a recap. The
		// dedup helpers operate on chronological adjacency, so the deduped view
		// is recomputed from the chronological ordering after each page; the
		// deduped count is monotone in the collected rows, so the loop still
		// terminates. Every retained row renders complete.
		const collected: Memory[] = [];
		let dialogue: Memory[] = [];
		let scannedRows = 0;
		let storeExhausted = false;
		let cursor: { createdAt: number; id: UUID } | undefined;
		while (dialogue.length < requestedDepth) {
			const page = await runtime.getMemories({
				tableName: "messages",
				roomId,
				count: CHANNEL_RECAP_PAGE_SIZE,
				unique: false,
				...(cursor ? { cursor } : {}),
			});
			scannedRows += page.length;
			for (const row of page) {
				if (isHygienicDialogueMessage(row, runtime.agentId)) {
					collected.push(row);
				}
			}
			// Dedupe on the chronological (oldest-first) order the transcript
			// renders, then flip back newest-first so depth counting and offset
			// slicing stay anchored to the newest message.
			dialogue = dedupeHygienicDialogueMessages(
				[...collected].reverse(),
				runtime.agentId,
			).reverse();
			if (page.length < CHANNEL_RECAP_PAGE_SIZE) {
				storeExhausted = true;
				break;
			}
			// Cursor-must-advance guard: the next keyset cursor is the last row's
			// (createdAt, id). A last row missing either key, or a cursor identical
			// to the one this page was fetched with (an adapter ignoring `cursor`
			// re-serves the same page forever), cannot make progress — surface the
			// adapter defect as a typed failure instead of looping or silently
			// fabricating exhaustion.
			const last = page[page.length - 1];
			if (typeof last.createdAt !== "number" || !last.id) {
				return {
					success: false,
					text: `CHANNEL_RECAP cannot continue the exhaustive history scan: a stored row is missing the createdAt/id keys the keyset cursor needs (scanned ${scannedRows} rows). This is a message-store defect, not a request problem.`,
					values: { success: false },
					data: {
						actionName: "CHANNEL_RECAP",
						error: "CHANNEL_RECAP_CURSOR_STALLED",
						roomId,
						scannedRows,
					},
				};
			}
			const nextCursor = { createdAt: last.createdAt, id: last.id };
			if (
				cursor &&
				nextCursor.createdAt === cursor.createdAt &&
				nextCursor.id === cursor.id
			) {
				return {
					success: false,
					text: `CHANNEL_RECAP cannot continue the exhaustive history scan: the message store returned the same keyset page twice (cursor did not advance past createdAt=${cursor.createdAt}). This is a message-store defect, not a request problem.`,
					values: { success: false },
					data: {
						actionName: "CHANNEL_RECAP",
						error: "CHANNEL_RECAP_CURSOR_STALLED",
						roomId,
						scannedRows,
					},
				};
			}
			cursor = nextCursor;
		}

		// Caller-requested pagination applies to dialogue, newest first; the
		// traversal may have collected past the range boundary (page granularity).
		const rendered = dialogue.slice(offset, requestedDepth);

		const roomEntities = await getEntityDetails({ runtime, roomId });
		const entities = await ensureFormattingEntities(
			runtime,
			roomEntities,
			rendered,
		);
		// formatMessages walks its input from the last element backwards, so the
		// newest-first rows render as a chronological (oldest-first) transcript.
		const transcript = formatMessages({ messages: rendered, entities });

		// Store-exhaustion disclosure: the store ran out before the requested
		// dialogue depth (count + offset) was reached, so the caller learns the
		// true extent of this room's history instead of inferring a silent cap.
		const exhaustionNote =
			storeExhausted && dialogue.length < requestedDepth
				? ` This room's stored history is exhausted at ${dialogue.length} dialogue message(s); the read requested up to ${requestedDepth}${
						offset > 0 ? ` (count ${count} + offset ${offset})` : ""
					}.`
				: "";
		const rangeLabel =
			offset > 0
				? `messages ${offset + 1}–${offset + rendered.length} back (newest first)`
				: `the last ${rendered.length} stored message(s)`;
		const text =
			rendered.length === 0
				? `No stored messages found in this room's history at offset ${offset}.${exhaustionNote}`
				: `Complete transcript of ${rangeLabel} in this room, oldest first:${exhaustionNote}\n\n${transcript}`;

		return {
			success: true,
			text,
			values: { success: true, messageCount: rendered.length },
			data: {
				actionName: "CHANNEL_RECAP",
				roomId,
				scope: {
					roomScoped: true,
					requestedCount:
						parsedCount !== undefined && parsedCount >= 1 ? parsedCount : null,
					count,
					offset,
					renderedCount: rendered.length,
					// Diagnostics only — traversal extent, never a serving bound.
					scannedRows,
					pageSize: CHANNEL_RECAP_PAGE_SIZE,
					storeExhausted,
					order: "chronological",
				},
				messages: rendered
					.slice()
					.reverse()
					.map((row) => ({
						id: row.id ?? null,
						entityId: row.entityId,
						createdAt: row.createdAt ?? null,
						// Complete stored text — never a snippet.
						text: row.content?.text ?? "",
					})),
			},
		};
	},
};
