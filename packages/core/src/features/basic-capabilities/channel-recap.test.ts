/**
 * Deterministic unit tests for the CHANNEL_RECAP room-history action: general-
 * context reachability through the exposure gate (with the ADMIN messaging
 * search excluded from the same surface), structural room scoping (a message
 * from room A can never surface room B content, even when the planner passes
 * room-selector-shaped parameters), complete bounds-free serving of a long
 * requested range via multi-page keyset traversal, machinery filtering BEFORE
 * the requested count is satisfied, offset paging, the cursor-must-advance
 * guard, and store-exhaustion disclosure. Runtime is a vi.fn stub whose
 * getMemories implements newest-first keyset pagination — no model, no
 * database. Deliberately NO size-ceiling tests: this action has no deliverable
 * or read bound (PROMPT-INTEGRITY, PR #26780).
 */
import { describe, expect, it, vi } from "vitest";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../types/index.ts";
import { searchMessagesAction } from "../messaging/triage/actions/searchMessages.ts";
import {
	CHANNEL_RECAP_DEFAULT_COUNT,
	CHANNEL_RECAP_PAGE_SIZE,
	channelRecapAction,
} from "./actions/channel-recap.ts";
import { basicActions } from "./index.ts";

const AGENT_ID = "00000000-0000-4000-8000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-4000-8000-00000000c0de" as UUID;
const ROOM_A = "00000000-0000-4000-8000-00000000aaaa" as UUID;
const ROOM_B = "00000000-0000-4000-8000-00000000bbbb" as UUID;

function makeMessage(
	roomId: UUID,
	createdAt: number,
	text: string,
	extra: Partial<Memory> = {},
): Memory {
	return {
		id: `00000000-0000-4000-8000-${String(createdAt).padStart(12, "0")}` as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId,
		createdAt,
		content: { text, source: "discord" },
		...extra,
	} as Memory;
}

interface GetMemoriesParams {
	roomId?: UUID;
	count?: number;
	limit?: number;
	cursor?: { createdAt: number; id: UUID };
	tableName?: string;
}

interface RuntimeStub {
	runtime: IAgentRuntime;
	getMemories: ReturnType<typeof vi.fn>;
}

function wrapRuntime(getMemories: ReturnType<typeof vi.fn>): RuntimeStub {
	const runtime = {
		agentId: AGENT_ID,
		getMemories,
		getRoom: vi.fn(async (roomId: UUID) => ({
			id: roomId,
			source: "discord",
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: USER_ID, agentId: AGENT_ID, names: ["Al"], metadata: {} },
		]),
		getEntityById: vi.fn(async () => null),
	} as unknown as IAgentRuntime;
	return { runtime, getMemories };
}

/**
 * Stub store with real newest-first keyset semantics: rows sort by
 * (createdAt desc, id desc); a cursor returns rows strictly after it in that
 * order; `limit`/`count` slices the page.
 */
function makeRuntime(fixtures: Record<string, Memory[]>): RuntimeStub {
	const getMemories = vi.fn(async (params: GetMemoriesParams) => {
		const rows = (fixtures[params.roomId ?? ""] ?? []).slice().sort((a, b) => {
			const diff = (b.createdAt ?? 0) - (a.createdAt ?? 0);
			if (diff !== 0) return diff;
			return String(b.id ?? "").localeCompare(String(a.id ?? ""));
		});
		const cursor = params.cursor;
		const afterCursor = cursor
			? rows.filter((row) => {
					const createdAt = row.createdAt ?? 0;
					if (createdAt !== cursor.createdAt) {
						return createdAt < cursor.createdAt;
					}
					return String(row.id ?? "").localeCompare(String(cursor.id)) < 0;
				})
			: rows;
		const limit = params.limit ?? params.count ?? Number.POSITIVE_INFINITY;
		return afterCursor.slice(0, limit);
	});
	return wrapRuntime(getMemories);
}

const incoming = (roomId: UUID): Memory =>
	makeMessage(roomId, 9_999_000, "what were the last 100 messages here?");

const run = (
	stub: RuntimeStub,
	message: Memory,
	parameters?: Record<string, unknown>,
): Promise<ActionResult> =>
	channelRecapAction.handler(
		stub.runtime,
		message,
		undefined,
		parameters ? { parameters } : undefined,
	) as Promise<ActionResult>;

describe("CHANNEL_RECAP registration and general-context reachability", () => {
	it("is part of the basic action bundle", () => {
		expect(basicActions.map((action) => action.name)).toContain(
			"CHANNEL_RECAP",
		);
	});

	it("declares exactly the general context", () => {
		expect(channelRecapAction.contexts).toEqual(["general"]);
	});

	it("passes the exposure gate for a general-context group sender while the messaging search stays out", () => {
		const surfaced = filterByContextGate(
			[channelRecapAction, searchMessagesAction],
			["general"],
			["GUEST"],
		);
		expect(surfaced.map((action) => action.name)).toEqual(["CHANNEL_RECAP"]);

		// Even an ADMIN in a general-routed turn does not get the cross-channel
		// search: its contexts stay messaging/email/documents.
		const adminSurfaced = filterByContextGate(
			[searchMessagesAction],
			["general"],
			["ADMIN"],
		);
		expect(adminSurfaced).toEqual([]);
	});

	it("validate accepts a routed turn (general is always in the active set)", async () => {
		const message = incoming(ROOM_A);
		message.content = {
			...message.content,
			metadata: {
				__responseContext: { primaryContext: "general" },
			},
		};
		await expect(
			channelRecapAction.validate(makeRuntime({}).runtime, message, undefined),
		).resolves.toBe(true);
	});
});

describe("CHANNEL_RECAP room scoping", () => {
	const fixtures = {
		[ROOM_A]: [
			makeMessage(ROOM_A, 1_000, "alpha one"),
			makeMessage(ROOM_A, 2_000, "alpha two"),
		],
		[ROOM_B]: [makeMessage(ROOM_B, 1_500, "bravo secret")],
	};

	it("returns only the sender's current room, never another room", async () => {
		const stub = makeRuntime(fixtures);
		const result = await run(stub, incoming(ROOM_A));
		expect(result.success).toBe(true);
		expect(result.text).toContain("alpha one");
		expect(result.text).toContain("alpha two");
		expect(result.text).not.toContain("bravo secret");
		expect(stub.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ roomId: ROOM_A, tableName: "messages" }),
		);
		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope).toMatchObject({ roomScoped: true });
		expect((result.data as { roomId: string }).roomId).toBe(ROOM_A);
	});

	it("ignores room-selector-shaped parameters: scoping is structural", async () => {
		const stub = makeRuntime(fixtures);
		const result = await run(stub, incoming(ROOM_A), {
			roomId: ROOM_B,
			channelId: ROOM_B,
			roomIds: [ROOM_B],
			worldId: ROOM_B,
		});
		expect(result.success).toBe(true);
		expect(result.text).not.toContain("bravo secret");
		expect(result.text).toContain("alpha one");
		for (const call of stub.getMemories.mock.calls) {
			expect((call[0] as GetMemoriesParams).roomId).toBe(ROOM_A);
		}
	});

	it("fails typed when the message has no roomId", async () => {
		const stub = makeRuntime(fixtures);
		const message = incoming(ROOM_A);
		(message as { roomId?: UUID }).roomId = undefined;
		const result = await run(stub, message);
		expect(result.success).toBe(false);
		expect(result.text).toContain("roomId");
		expect(stub.getMemories).not.toHaveBeenCalled();
	});
});

describe("CHANNEL_RECAP transcript completeness and order", () => {
	it("renders every message complete — no truncation of long content", async () => {
		const longText = `${"the quarterly numbers were discussed at length ".repeat(200)}FINAL_MARKER_END`;
		const stub = makeRuntime({
			[ROOM_A]: [makeMessage(ROOM_A, 1_000, longText)],
		});
		const result = await run(stub, incoming(ROOM_A));
		expect(result.text).toContain(longText);
		const data = result.data as { messages: Array<{ text: string }> };
		expect(data.messages[0].text).toBe(longText);
	});

	it("renders chronologically, oldest first", async () => {
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 3_000, "third message"),
				makeMessage(ROOM_A, 1_000, "first message"),
				makeMessage(ROOM_A, 2_000, "second message"),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		const text = result.text ?? "";
		expect(text.indexOf("first message")).toBeGreaterThan(-1);
		expect(text.indexOf("first message")).toBeLessThan(
			text.indexOf("second message"),
		);
		expect(text.indexOf("second message")).toBeLessThan(
			text.indexOf("third message"),
		);
		const data = result.data as {
			messages: Array<{ createdAt: number | null }>;
		};
		expect(data.messages.map((m) => m.createdAt)).toEqual([
			1_000, 2_000, 3_000,
		]);
	});

	it("strips machinery rows (action results, internal bridge relays)", async () => {
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "human line"),
				makeMessage(ROOM_A, 2_000, "tool record", {
					content: { type: "action_result", text: "tool record" },
				} as Partial<Memory>),
				makeMessage(ROOM_A, 3_000, "bridge relay", {
					content: { text: "bridge relay", source: "swarm_synthesis" },
				} as Partial<Memory>),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		expect(result.text).toContain("human line");
		expect(result.text).not.toContain("tool record");
		expect(result.text).not.toContain("bridge relay");
		expect(result.values?.messageCount).toBe(1);
	});

	it("filters machinery before satisfying the count, traversing extra pages when machinery fills the first", async () => {
		// 250 machinery rows occupy the entire first keyset page (page size 200)
		// and part of the second; the two dialogue rows the caller asked for sit
		// beyond them. A fetch-then-filter of a single count-sized page would
		// serve nothing.
		const machinery = Array.from({ length: 250 }, (_, index) =>
			makeMessage(ROOM_A, 100_000 + index * 1_000, `tool-${index}`, {
				content: { type: "action_result", text: `tool-${index}` },
			} as Partial<Memory>),
		);
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "older dialogue one"),
				makeMessage(ROOM_A, 2_000, "older dialogue two"),
				...machinery,
			],
		});
		const result = await run(stub, incoming(ROOM_A), { count: 2 });
		expect(result.success).toBe(true);
		expect(result.values?.messageCount).toBe(2);
		expect(result.text).toContain("older dialogue one");
		expect(result.text).toContain("older dialogue two");
		expect(stub.getMemories).toHaveBeenCalledTimes(2);
	});
});

/**
 * The recap serves rows through the canonical RECENT_MESSAGES dialogue-
 * hygiene boundary — the model-exposure contract, not an application cap.
 * Each leakage class the boundary strips from the prompt transcript must be
 * equally unreturnable through CHANNEL_RECAP, in the rendered text AND in the
 * structured data payload, and stripped rows must not consume the requested
 * depth (real dialogue is back-filled from older pages in their place).
 */
describe("CHANNEL_RECAP dialogue-hygiene boundary (canonical RECENT_MESSAGES contract)", () => {
	const leakedText = (result: ActionResult): string => {
		const data = result.data as { messages?: Array<{ text: string }> };
		return `${result.text ?? ""}\n${(data.messages ?? [])
			.map((row) => row.text)
			.join("\n")}`;
	};

	it("cannot return a synthetic assistant failure reply", async () => {
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "real question from a human"),
				makeMessage(ROOM_A, 2_000, "Sorry, I'm having a provider issue", {
					entityId: AGENT_ID,
				} as Partial<Memory>),
				makeMessage(ROOM_A, 3_000, "flagged synthetic failure", {
					entityId: AGENT_ID,
					content: {
						text: "flagged synthetic failure",
						metadata: { elizaSyntheticFailure: true },
					},
				} as Partial<Memory>),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		const served = leakedText(result);
		expect(served).toContain("real question from a human");
		expect(served).not.toContain("provider issue");
		expect(served).not.toContain("flagged synthetic failure");
		expect(result.values?.messageCount).toBe(1);
	});

	it("cannot return a transient orchestrator status post", async () => {
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "human dialogue line"),
				makeMessage(ROOM_A, 2_000, "spawning sub-agent, stand by...", {
					entityId: AGENT_ID,
					content: {
						text: "spawning sub-agent, stand by...",
						metadata: { transient: true },
					},
				} as Partial<Memory>),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		const served = leakedText(result);
		expect(served).toContain("human dialogue line");
		expect(served).not.toContain("spawning sub-agent");
		expect(result.values?.messageCount).toBe(1);
	});

	it("cannot return a leaked assistant tool transcript", async () => {
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "human dialogue line"),
				makeMessage(
					ROOM_A,
					2_000,
					"[tool output: SHELL]\nnpm ERR! everything\n[/tool output]",
					{ entityId: AGENT_ID } as Partial<Memory>,
				),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		const served = leakedText(result);
		expect(served).toContain("human dialogue line");
		expect(served).not.toContain("[tool output:");
		expect(served).not.toContain("npm ERR!");
		expect(result.values?.messageCount).toBe(1);
	});

	it("cannot return a leaked local-path dump", async () => {
		const pathDump = [
			"/home/agent/workspace/project/src/index.ts",
			"/home/agent/workspace/project/src/utils.ts",
			"/home/agent/workspace/project/package.json",
			"/home/agent/workspace/project/README.md",
			"/home/agent/workspace/project/tsconfig.json",
		].join("\n");
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "human dialogue line"),
				makeMessage(ROOM_A, 2_000, pathDump, {
					entityId: AGENT_ID,
				} as Partial<Memory>),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		const served = leakedText(result);
		expect(served).toContain("human dialogue line");
		expect(served).not.toContain("/home/agent/workspace");
		expect(result.values?.messageCount).toBe(1);
	});

	it("applies the same dedup contract as the prompt transcript", async () => {
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "unique human line"),
				makeMessage(ROOM_A, 2_000, "repeated agent line", {
					entityId: AGENT_ID,
				} as Partial<Memory>),
				makeMessage(ROOM_A, 3_000, "repeated agent line", {
					entityId: AGENT_ID,
				} as Partial<Memory>),
			],
		});
		const result = await run(stub, incoming(ROOM_A));
		expect(result.values?.messageCount).toBe(3);
		const data = result.data as { messages: Array<{ text: string }> };
		expect(
			data.messages.filter((row) => row.text === "repeated agent line"),
		).toHaveLength(2);
	});

	it("hygiene-stripped rows never consume the requested depth: dialogue is back-filled from older pages", async () => {
		// A full first page of transient agent status noise; the two dialogue
		// rows the caller asked for sit beyond it. Counting stripped rows toward
		// the depth would serve nothing.
		const noise = Array.from({ length: CHANNEL_RECAP_PAGE_SIZE }, (_, index) =>
			makeMessage(ROOM_A, 100_000 + index * 1_000, `status-${index}`, {
				entityId: AGENT_ID,
				content: {
					text: `status-${index}`,
					metadata: { transient: true },
				},
			} as Partial<Memory>),
		);
		const stub = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "older dialogue one"),
				makeMessage(ROOM_A, 2_000, "older dialogue two"),
				...noise,
			],
		});
		const result = await run(stub, incoming(ROOM_A), { count: 2 });
		expect(result.success).toBe(true);
		expect(result.values?.messageCount).toBe(2);
		expect(result.text).toContain("older dialogue one");
		expect(result.text).toContain("older dialogue two");
		expect(result.text).not.toContain("status-");
		expect(stub.getMemories).toHaveBeenCalledTimes(2);
	});
});

describe("CHANNEL_RECAP complete long-range serving (keyset traversal)", () => {
	it("serves a 700-message range complete across multiple advancing keyset pages", async () => {
		const rows = Array.from({ length: 750 }, (_, i) =>
			makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
		);
		const stub = makeRuntime({ [ROOM_A]: rows });
		const result = await run(stub, incoming(ROOM_A), { count: 700 });
		expect(result.success).toBe(true);

		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope.renderedCount).toBe(700);

		// Every requested row is present, chronological, exactly once: the
		// newest 700 of 750 are msg-51 … msg-750, oldest first.
		const data = result.data as { messages: Array<{ text: string }> };
		expect(data.messages.map((m) => m.text)).toEqual(
			Array.from({ length: 700 }, (_, i) => `msg-${i + 51}`),
		);
		expect(result.text).toContain("msg-51");
		expect(result.text).toContain("msg-400");
		expect(result.text).toContain("msg-750");
		expect(result.text).not.toContain("msg-50\n");

		// Traversal shape: 200-row pages, cursor advancing strictly older each
		// call — 3 full pages plus the final short page.
		const calls = stub.getMemories.mock.calls.map(
			(call) => call[0] as GetMemoriesParams,
		);
		expect(calls).toHaveLength(4);
		expect(calls[0].cursor).toBeUndefined();
		for (const call of calls) {
			expect(call.count).toBe(CHANNEL_RECAP_PAGE_SIZE);
			expect(call.roomId).toBe(ROOM_A);
		}
		for (let i = 1; i < calls.length; i += 1) {
			const cursor = calls[i].cursor;
			expect(cursor).toBeDefined();
			if (i > 1) {
				expect((cursor as { createdAt: number }).createdAt).toBeLessThan(
					(calls[i - 1].cursor as { createdAt: number }).createdAt,
				);
			}
		}
	});

	it("never rejects a large count: an oversized request serves whatever the store holds, disclosed", async () => {
		const rows = Array.from({ length: 30 }, (_, i) =>
			makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
		);
		const stub = makeRuntime({ [ROOM_A]: rows });
		const result = await run(stub, incoming(ROOM_A), { count: 100_000 });
		expect(result.success).toBe(true);
		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope.renderedCount).toBe(30);
		expect(scope.storeExhausted).toBe(true);
		expect(result.text).toContain("exhausted at 30");
		expect(result.text).toContain("100000");
	});
});

describe("CHANNEL_RECAP offset paging", () => {
	it("offset pages into older history and reports the exact range", async () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			makeMessage(ROOM_A, 1_000 + i, `msg-${i}`),
		);
		const stub = makeRuntime({ [ROOM_A]: rows });
		const result = await run(stub, incoming(ROOM_A), { count: 4, offset: 4 });
		expect(result.success).toBe(true);
		// newest-first rows: offset 4 skips msg-11..msg-8; serves msg-7..msg-4.
		for (const i of [7, 6, 5, 4]) expect(result.text).toContain(`msg-${i}`);
		for (const i of [11, 10, 9, 8, 3]) {
			expect(result.text).not.toContain(`msg-${i}\n`);
		}
		expect(result.text).toContain("messages 5–8 back");
	});

	it("offset skips dialogue, not machinery rows", async () => {
		const machinery = Array.from({ length: 3 }, (_, i) =>
			makeMessage(ROOM_A, 50_000 + i, `tool-${i}`, {
				content: { type: "action_result", text: `tool-${i}` },
			} as Partial<Memory>),
		);
		const stub = makeRuntime({
			[ROOM_A]: [
				...machinery,
				makeMessage(ROOM_A, 1_000, "d1"),
				makeMessage(ROOM_A, 2_000, "d2"),
				makeMessage(ROOM_A, 3_000, "d3"),
				makeMessage(ROOM_A, 4_000, "d4"),
				makeMessage(ROOM_A, 5_000, "d5"),
			],
		});
		const result = await run(stub, incoming(ROOM_A), { count: 2, offset: 1 });
		expect(result.success).toBe(true);
		// Machinery never consumes the offset: skipping 1 skips d5 (the newest
		// dialogue), serving d4 and d3.
		expect(result.text).toContain("d4");
		expect(result.text).toContain("d3");
		expect(result.text).not.toContain("d5");
		expect(result.text).not.toContain("d2");
	});
});

describe("CHANNEL_RECAP cursor-must-advance guard", () => {
	it("fails typed instead of looping when the store ignores the keyset cursor", async () => {
		const samePage = Array.from({ length: CHANNEL_RECAP_PAGE_SIZE }, (_, i) =>
			makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
		)
			.slice()
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
		const stub = wrapRuntime(vi.fn(async () => samePage));
		const result = await run(stub, incoming(ROOM_A), { count: 300 });
		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"CHANNEL_RECAP_CURSOR_STALLED",
		);
		expect(result.text).toContain("did not advance");
		// One page, one stalled retry — never an unbounded loop.
		expect(stub.getMemories).toHaveBeenCalledTimes(2);
	});

	it("fails typed when a full page's last row lacks the keys the cursor needs", async () => {
		const rows = Array.from({ length: CHANNEL_RECAP_PAGE_SIZE }, (_, i) =>
			makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
		);
		// The oldest row (last of the newest-first page) loses its id.
		(rows[0] as { id?: UUID }).id = undefined;
		const stub = makeRuntime({ [ROOM_A]: rows });
		const result = await run(stub, incoming(ROOM_A), { count: 250 });
		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"CHANNEL_RECAP_CURSOR_STALLED",
		);
		expect(result.text).toContain("missing the createdAt/id keys");
		expect(stub.getMemories).toHaveBeenCalledTimes(1);
	});
});

describe("CHANNEL_RECAP store-exhaustion disclosure", () => {
	it("discloses the true history extent when the store runs out short of the request", async () => {
		const rows = Array.from({ length: 7 }, (_, i) =>
			makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
		);
		const stub = makeRuntime({ [ROOM_A]: rows });
		const result = await run(stub, incoming(ROOM_A), { count: 100 });
		expect(result.success).toBe(true);
		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope.renderedCount).toBe(7);
		expect(scope.storeExhausted).toBe(true);
		expect(result.text).toContain("exhausted at 7");
		expect(result.text).toContain("requested up to 100");
		for (let i = 1; i <= 7; i += 1) {
			expect(result.text).toContain(`msg-${i}`);
		}
	});

	it("discloses exhaustion with the count + offset breakdown when the offset overshoots the store", async () => {
		const rows = Array.from({ length: 7 }, (_, i) =>
			makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
		);
		const stub = makeRuntime({ [ROOM_A]: rows });
		const result = await run(stub, incoming(ROOM_A), { offset: 10 });
		expect(result.success).toBe(true);
		expect(result.text).toContain(
			"No stored messages found in this room's history at offset 10.",
		);
		expect(result.text).toContain("exhausted at 7");
		expect(result.text).toContain(
			`(count ${CHANNEL_RECAP_DEFAULT_COUNT} + offset 10)`,
		);
	});
});

describe("CHANNEL_RECAP count contract (no ceilings)", () => {
	const many = Array.from({ length: 60 }, (_, i) =>
		makeMessage(ROOM_A, (i + 1) * 1_000, `msg-${i + 1}`),
	);

	it("defaults to the documented default count", async () => {
		const stub = makeRuntime({ [ROOM_A]: many });
		const result = await run(stub, incoming(ROOM_A));
		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope.renderedCount).toBe(CHANNEL_RECAP_DEFAULT_COUNT);
		expect(scope.requestedCount).toBeNull();
	});

	it("honors an explicit caller-requested count, including numeric strings", async () => {
		const stub = makeRuntime({ [ROOM_A]: many });
		const numeric = await run(stub, incoming(ROOM_A), { count: 12 });
		expect(
			(numeric.data as { scope: Record<string, unknown> }).scope.renderedCount,
		).toBe(12);
		const stringy = await run(stub, incoming(ROOM_A), { count: "25" });
		expect(
			(stringy.data as { scope: Record<string, unknown> }).scope.renderedCount,
		).toBe(25);
	});

	it("falls back to the default for non-positive or malformed counts", async () => {
		const stub = makeRuntime({ [ROOM_A]: many });
		for (const bad of [0, -5, "not-a-number", null, "50.9", "1e2"]) {
			const result = await run(stub, incoming(ROOM_A), { count: bad });
			expect(
				(result.data as { scope: Record<string, unknown> }).scope.renderedCount,
			).toBe(CHANNEL_RECAP_DEFAULT_COUNT);
		}
	});
});
