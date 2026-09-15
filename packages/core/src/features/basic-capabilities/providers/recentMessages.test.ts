/**
 * Behavioral tests for the RECENT_MESSAGES provider's transcript hygiene:
 * dropping internal bridge / sub-agent / tool / path-dump / synthetic-failure /
 * transient rows, exact record deduplication, distinct source occurrences and
 * uncapped retained history. Deterministic — drives `recentMessagesProvider.get` against a
 * hand-built in-memory runtime of `vi.fn` stubs; no live model or database.
 */

import { describe, expect, it, vi } from "vitest";

const revalidateOwnerExclusiveDisclosure = vi.hoisted(() =>
	vi.fn(async () => ({
		allowed: true as const,
		basis: "owner_private_destination" as const,
	})),
);

vi.mock(
	"../../../security/trusted-delivery-audience.ts",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../security/trusted-delivery-audience.ts")
			>();
		return {
			...actual,
			revalidateOwnerExclusiveDisclosure,
			markOwnerExclusiveDisclosureUsed: vi.fn(),
			recordOwnerExclusiveSuppression: vi.fn(),
		};
	},
);

import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
} from "../../../types/index.ts";
import { addHeader, conversationMessagesHeader } from "../../../utils.ts";
import { recentMessagesProvider } from "./recentMessages.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-000000000002";
const USER_ID = "00000000-0000-0000-0000-000000000003";

function makeMemory(
	id: string,
	entityId: string,
	text: string,
	source: string,
	createdAt: number,
	metadata?: Record<string, unknown>,
): Memory {
	return {
		id,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId,
		createdAt,
		content: { text, source, ...(metadata ? { metadata } : {}) },
	} as Memory;
}

function makeRuntime(
	memories: Memory[],
	room: {
		type?: (typeof ChannelType)[keyof typeof ChannelType];
		metadata?: Record<string, unknown>;
		conversationLength?: number;
	} = {},
	overrides: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "Agent" },
		getConversationLength: vi.fn(() => room.conversationLength ?? 10),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: room.type ?? ChannelType.GROUP,
			source: "discord",
			metadata: room.metadata ?? {},
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: AGENT_ID, agentId: AGENT_ID, names: ["Agent"], components: [] },
			{ id: USER_ID, agentId: AGENT_ID, names: ["User"], components: [] },
		]),
		getEntityById: vi.fn(async () => null),
		getMemories: vi.fn(async () => memories),
		getRoomsForParticipants: vi.fn(async () => []),
		getRoomsForParticipant: vi.fn(async () => []),
		getMemoriesByRoomIds: vi.fn(async () => []),
		getService: vi.fn(() => null),
		...overrides,
	} as IAgentRuntime;
}

describe("recentMessagesProvider", () => {
	it("omits internal swarm synthesis bridge rows from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "done", "swarm_synthesis", 2000),
			makeMemory("msg-3", AGENT_ID, "done", "discord", 3000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		if (!result.data) throw new Error("Missing provider data");
		expect(result.values?.recentMessages).toBe(
			addHeader(
				conversationMessagesHeader(2),
				(result.data.formattedMessageSegments as string[]).join("\n"),
			),
		);
		expect(result.text).toContain("Agent: done");
		expect(result.text?.match(/Agent: done/g)).toHaveLength(1);
	});

	it("omits prior sub-agent router transcripts from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				"00000000-0000-0000-0000-000000000004",
				"[sub-agent: app build (opencode) — task_complete]\n[tool output: list files]\nnoisy transcript",
				"acpx:sub-agent-router",
				2000,
				{ subAgent: true },
			),
			makeMemory("msg-3", AGENT_ID, "https://example.com/app", "discord", 3000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("Agent: https://example.com/app");
		expect(result.text).not.toContain("[sub-agent:");
		expect(result.text).not.toContain("noisy transcript");
	});

	it("omits leaked assistant tool transcripts from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				AGENT_ID,
				"[tool output: list files]\nsecretly long transcript\n[/tool output]",
				"discord",
				2000,
			),
			makeMemory(
				"msg-3",
				USER_ID,
				"why did [tool output:] show up?",
				"discord",
				3000,
			),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("why did [tool output:] show up?");
		expect(result.text).not.toContain("secretly long transcript");
	});

	it("omits leaked assistant local path dumps from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				AGENT_ID,
				[
					"/workspace/app/.next/static/chunks/a.js",
					"/workspace/app/.next/static/chunks/b.js",
					"/workspace/app/.git/index",
					"/workspace/app/data/apps/demo/index.html",
					"/workspace/app/data/apps/demo/app.js",
				].join("\n"),
				"discord",
				2000,
			),
			makeMemory(
				"msg-3",
				USER_ID,
				"the app path is /workspace/app",
				"discord",
				3000,
			),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("the app path is /workspace/app");
		expect(result.text).not.toContain(".next/static/chunks");
	});

	it("omits synthetic assistant failure replies from dialogue history", async () => {
		const memories = [
			makeMemory(
				"msg-1",
				USER_ID,
				"I saw a provider issue in the UI",
				"client_chat",
				1000,
			),
			makeMemory(
				"msg-2",
				AGENT_ID,
				"Sorry, I'm having a provider issue",
				"client_chat",
				2000,
			),
			makeMemory(
				"msg-3",
				AGENT_ID,
				"Something went wrong on my end. Please try again.",
				"client_chat",
				3000,
			),
			makeMemory(
				"msg-4",
				AGENT_ID,
				"I can help with the next step.",
				"client_chat",
				4000,
			),
			makeMemory("msg-5", AGENT_ID, "Retrying...", "client_chat", 5000, {
				elizaSyntheticFailure: true,
				chatFailureKind: "provider_issue",
			}),
			makeMemory(
				"msg-6",
				AGENT_ID,
				"Capability unavailable.",
				"client_chat",
				6000,
				{ failureKind: "missing_capability" },
			),
			makeMemory(
				"msg-7",
				AGENT_ID,
				"Attempts exhausted.",
				"client_chat",
				7000,
				{ failureKind: "planner_exhaustion" },
			),
			makeMemory(
				"msg-8",
				AGENT_ID,
				"Typecheck still fails after repair.",
				"client_chat",
				7500,
				{ failureKind: "coding_verification_failed" },
			),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "client_chat", 8000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: I saw a provider issue in the UI");
		expect(result.text).toContain("Agent: I can help with the next step.");
		expect(result.text).not.toContain("Agent: Sorry");
		expect(result.text).not.toContain("Something went wrong");
		expect(result.text).not.toContain("Retrying...");
		expect(result.text).not.toContain("Capability unavailable.");
		expect(result.text).not.toContain("Attempts exhausted.");
		expect(result.text).not.toContain("Typecheck still fails after repair.");
	});

	it("keeps every distinct assistant occurrence within one assistant run", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build app one", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "On it", "discord", 2000),
			makeMemory(
				"msg-3",
				AGENT_ID,
				"https://example.com/app-one",
				"discord",
				3000,
			),
			makeMemory("msg-4", AGENT_ID, "On it", "discord", 4000),
			makeMemory(
				"msg-5",
				AGENT_ID,
				"https://example.com/app-one",
				"discord",
				5000,
			),
			makeMemory("msg-6", USER_ID, "build app two", "discord", 6000),
			makeMemory("msg-7", AGENT_ID, "On it", "discord", 7000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "status", "discord", 8000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text?.match(/Agent: On it/g)).toHaveLength(3);
		expect(result.text?.match(/https:\/\/example\.com\/app-one/g)).toHaveLength(
			2,
		);
		expect(result.text).toContain("User: build app two");
	});

	it("keeps consecutive same-speaker messages with different source IDs", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "are you there?", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "yes", "runtime", 2000),
			makeMemory("msg-3", AGENT_ID, " yes ", "discord", 3000),
			makeMemory("msg-4", USER_ID, "next task", "discord", 4000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "status", "discord", 5000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toEqual(memories);
		expect(result.text?.match(/Agent:\s+yes/g)).toHaveLength(2);
		expect(result.text).toContain("User: next task");
	});

	it("preserves literal differences, correction order and metadata while removing exact storage duplicates", async () => {
		const first = makeMemory(
			"msg-1",
			USER_ID,
			"The exact body is A  B.",
			"discord",
			1000,
		);
		const memories = [
			first,
			structuredClone(first),
			makeMemory("msg-2", USER_ID, "The exact body is A B.", "discord", 2000),
			makeMemory("msg-3", AGENT_ID, "The mug is violet.", "discord", 3000),
			makeMemory("msg-4", AGENT_ID, "The mug is amber.", "discord", 4000),
			makeMemory("msg-5", AGENT_ID, "The mug is violet.", "discord", 5000),
			{ ...first, metadata: { correction: true } },
		];
		const before = structuredClone(memories);
		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory(
				"current",
				USER_ID,
				"Quote both literal bodies and the latest mug color.",
				"discord",
				6000,
			),
			{ values: {}, data: {}, text: "" },
		);
		const rows = result.data?.recentMessages as Memory[];
		expect(rows).toHaveLength(6);
		expect(rows.map((row) => row.content.text)).toEqual([
			first.content.text,
			first.content.text,
			"The exact body is A B.",
			"The mug is violet.",
			"The mug is amber.",
			"The mug is violet.",
		]);
		expect(rows[1].metadata).toEqual({ correction: true });
		expect(memories).toEqual(before);
	});

	it("ignores a stale compact ledger and renders retained history directly", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "current tail", "discord", 1000),
		];
		const result = await recentMessagesProvider.get(
			makeRuntime(memories, {
				metadata: {
					conversationCompaction: {
						priorLedger:
							"[conversation hybrid-ledger]\nFacts:\n- parcel LIME-4421",
					},
				},
			}),
			makeMemory("current", USER_ID, "status", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).not.toContain("# Conversation Compact Ledger");
		expect(result.text).not.toContain("LIME-4421");
		expect(result.text).toContain("User: current tail");
	});

	it("ignores stale compact metadata in feed/thread post-format prompts", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "thread post", "discord", 1000),
		];
		const result = await recentMessagesProvider.get(
			makeRuntime(memories, {
				type: ChannelType.THREAD,
				metadata: {
					lastCompactionAt: 999,
					conversationCompaction: {
						priorLedger:
							"[conversation hybrid-ledger]\nFacts:\n- thread code BLUE-77",
					},
				},
			}),
			makeMemory("current", USER_ID, "status", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.values?.recentPosts).not.toContain(
			"# Conversation Compact Ledger",
		);
		expect(result.text).not.toContain("BLUE-77");
		expect(result.text).toContain("# Posts in Thread");
	});

	it("omits agent-emitted transient status messages from dialogue history", async () => {
		// Orchestrator marks every status/narration/heartbeat post with
		// `metadata.transient: true` so the planner cannot resurface its own
		// 🚀/💬/⏳/✅ chatter as facts on later turns. The flag can sit on
		// `content.metadata` (Content.metadata path) OR on the top-level
		// `Memory.metadata` (when a connector forwards it through). Both
		// shapes MUST be filtered out.
		const memories = [
			makeMemory(
				"msg-1",
				USER_ID,
				"spawn the codex sub-agent",
				"discord",
				1000,
			),
			makeMemory("msg-2", AGENT_ID, "🚀 [codex] running", "discord", 2000, {
				transient: true,
			}),
			// Top-level Memory.metadata.transient shape — connectors that
			// forward `content.metadata` into `extraMetadata` land here.
			{
				id: "msg-3",
				agentId: AGENT_ID,
				roomId: ROOM_ID,
				entityId: AGENT_ID,
				createdAt: 3000,
				content: { text: "💬 [codex] reading file", source: "discord" },
				metadata: { transient: true },
			} as Memory,
			makeMemory("msg-4", AGENT_ID, "all set — deployed", "discord", 4000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 5000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("User: spawn the codex sub-agent");
		expect(result.text).toContain("Agent: all set");
		expect(result.text).not.toContain("🚀 [codex]");
		expect(result.text).not.toContain("💬 [codex]");
	});

	it("keeps history when the incoming message has no metadata and its sender entity is unresolvable", async () => {
		// Memory.metadata is optional. A message from an entity that is not a
		// current room participant AND whose entity row is unavailable used to
		// throw on `metaData.entityName`, and the catch collapsed the whole
		// provider to "No recent messages available" — dropping ALL history.
		const memories = [
			makeMemory("msg-1", USER_ID, "hello agent", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "hi there", "discord", 2000),
		];

		const strangerMessage = makeMemory(
			"current",
			"00000000-0000-0000-0000-000000000009",
			"what did we discuss?",
			"discord",
			3000,
		);
		expect(strangerMessage.metadata).toBeUndefined();

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			strangerMessage,
			{ values: {}, data: {}, text: "" },
		);

		expect((result.data as { error?: string })?.error).toBeUndefined();
		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: hello agent");
		expect(result.text).toContain("Agent: hi there");
		expect(result.text).toContain("Unknown User: what did we discuss?");
		expect(result.text).not.toBe("No recent messages available");
	});

	it("sorts and retains every memory regardless of the configured conversation length", async () => {
		const memories = Array.from({ length: 12 }, (_, index) => {
			const n = 12 - index;
			return makeMemory(
				`msg-${n}`,
				USER_ID,
				`message ${n}`,
				"discord",
				n * 1000,
			);
		});

		const result = await recentMessagesProvider.get(
			makeRuntime(memories, { conversationLength: 3 }),
			makeMemory("current", USER_ID, "status", "discord", 13_000),
			{ values: {}, data: {}, text: "" },
		);

		const recentMessages = result.data?.recentMessages as Memory[];
		expect(recentMessages.map((memory) => memory.id)).toEqual(
			Array.from({ length: 12 }, (_, index) => `msg-${index + 1}`),
		);
		expect(result.text).toContain("User: message 12");
		expect(result.text).toContain("User: message 1");
	});

	it("always loads complete same-room history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "whats 23 times 19?", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "23 times 19 is 437.", "discord", 2000),
			makeMemory("msg-3", USER_ID, "capital of france?", "discord", 3000),
			makeMemory("msg-4", AGENT_ID, "Paris.", "discord", 4000),
			makeMemory(
				"msg-5",
				USER_ID,
				"write a haiku about speed",
				"discord",
				5000,
			),
			makeMemory(
				"msg-6",
				AGENT_ID,
				"Quick wind / bright road",
				"discord",
				6000,
			),
			makeMemory(
				"msg-7",
				USER_ID,
				"python one-liner for reverse string",
				"discord",
				7000,
			),
			makeMemory("msg-8", AGENT_ID, "s[::-1]", "discord", 8000),
			makeMemory("msg-9", USER_ID, "bitcoin price?", "discord", 9000),
			makeMemory(
				"msg-10",
				AGENT_ID,
				"I need live data for that.",
				"discord",
				10_000,
			),
		];
		const runtime = makeRuntime(memories, { conversationLength: 4 });

		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory(
				"current",
				USER_ID,
				"what did i ask you to compute in my last math question?",
				"discord",
				11_000,
			),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				roomId: ROOM_ID,
				tableName: "messages",
			}),
		);
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.not.objectContaining({ limit: expect.any(Number) }),
		);
		const recentMessages = result.data?.recentMessages as Memory[];
		expect(recentMessages.map((memory) => memory.id)).toContain("msg-1");
		expect(result.text).toContain("User: whats 23 times 19?");
		expect(result.text).toContain("User: bitcoin price?");
	});

	it("renders authorized cross-room interactions on the first compose of a turn", async () => {
		expect(recentMessagesProvider.alwaysInResponseState).toBe(true);
		const OTHER_ROOM_ID = "00000000-0000-0000-0000-00000000000a";
		const memories = [
			makeMemory("msg-1", USER_ID, "hello agent", "discord", 1000),
		];
		const runtime = makeRuntime(
			memories,
			{},
			{
				getRoomsForParticipants: vi.fn(async () => [OTHER_ROOM_ID]),
				getRoomsForParticipant: vi.fn(async () => [OTHER_ROOM_ID]),
				getMemoriesByRoomIds: vi.fn(async () => [
					{
						id: "cross-1",
						agentId: AGENT_ID,
						roomId: OTHER_ROOM_ID,
						entityId: USER_ID,
						createdAt: 500,
						content: { text: "the blue key is under the mat" },
					} as Memory,
				]),
			},
		);

		// Stage-1 compose: no prior provider results in the turn's cached state.
		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "gm", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.getRoomsForParticipants).toHaveBeenCalledWith([USER_ID]);
		expect(runtime.getRoomsForParticipant).toHaveBeenCalledWith(AGENT_ID);
		expect(runtime.getMemoriesByRoomIds).toHaveBeenCalled();
		expect(result.values?.recentMessageInteractions).toContain(
			"the blue key is under the mat",
		);
		expect(result.data?.recentInteractions).toHaveLength(1);
		expect(result.data?.recentInteractionsDisclosure).toBe(
			"owner_private_destination",
		);
		expect(result.text).toContain("User: hello agent");
		expect(result.text).toContain(
			"# Recent conversations across verified accounts",
		);
		expect(result.text).toContain("blue key");
	});

	it("fetches cross-room interactions on a turn recompose (cached state has this provider)", async () => {
		const OTHER_ROOM_ID = "00000000-0000-0000-0000-00000000000a";
		const SOURCE_ONLY_ROOM_ID = "00000000-0000-0000-0000-00000000000b";
		const TARGET_ONLY_ROOM_ID = "00000000-0000-0000-0000-00000000000c";
		const memories = [
			makeMemory("msg-1", USER_ID, "hello agent", "discord", 1000),
		];
		const runtime = makeRuntime(
			memories,
			{},
			{
				getRoomsForParticipants: vi.fn(async () => [
					ROOM_ID,
					OTHER_ROOM_ID,
					SOURCE_ONLY_ROOM_ID,
				]),
				getRoomsForParticipant: vi.fn(async () => [
					ROOM_ID,
					OTHER_ROOM_ID,
					TARGET_ONLY_ROOM_ID,
				]),
				getMemoriesByRoomIds: vi.fn(async () => [
					{
						id: "cross-1",
						agentId: AGENT_ID,
						roomId: OTHER_ROOM_ID,
						entityId: USER_ID,
						createdAt: 500,
						content: { text: "the blue key is under the mat" },
					} as Memory,
				]),
			},
		);

		// Planner/action recompose: the turn's cached state already holds a
		// RECENT_MESSAGES result from the Stage-1 compose.
		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "gm", "discord", 2000),
			{
				values: {},
				data: { providers: { RECENT_MESSAGES: { text: "stage-1 result" } } },
				text: "",
			},
		);

		expect(runtime.getRoomsForParticipants).toHaveBeenCalledWith([USER_ID]);
		expect(runtime.getRoomsForParticipant).toHaveBeenCalledWith(AGENT_ID);
		expect(runtime.getMemoriesByRoomIds).toHaveBeenCalledWith({
			tableName: "messages",
			roomIds: [OTHER_ROOM_ID],
			accessContext: {
				requesterEntityId: USER_ID,
				source: "discord",
				worldId: undefined,
				authorizedRoomIds: [ROOM_ID, OTHER_ROOM_ID],
			},
		});
		expect(result.data?.recentInteractions).toHaveLength(1);
		expect(result.values?.recentMessageInteractions).toContain(
			"the blue key is under the mat",
		);
	});

	it("fails closed before cross-room reads when the destination is not owner-private", async () => {
		revalidateOwnerExclusiveDisclosure.mockResolvedValueOnce({
			allowed: false,
			reason: "participant_mismatch",
			audience: undefined,
		});
		const runtime = makeRuntime(
			[],
			{},
			{
				getRoomsForParticipants: vi.fn(async () => [ROOM_ID]),
				getMemoriesByRoomIds: vi.fn(async () => []),
			},
		);

		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "recall that", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.getRoomsForParticipants).not.toHaveBeenCalled();
		expect(runtime.getMemoriesByRoomIds).not.toHaveBeenCalled();
		expect(result.data?.recentInteractions).toEqual([]);
	});

	it("does not duplicate cross-room history owned by an always-on dedicated provider", async () => {
		const getRoomsForParticipants = vi.fn(async () => [ROOM_ID]);
		const getRoomsForParticipant = vi.fn(async () => [ROOM_ID]);
		const getMemoriesByRoomIds = vi.fn(async () => []);
		const runtime = makeRuntime(
			[],
			{},
			{
				providers: [
					{
						name: "recent-conversations",
						alwaysInResponseState: true,
					},
				],
				getRoomsForParticipants,
				getRoomsForParticipant,
				getMemoriesByRoomIds,
			},
		);

		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "recall that", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(getRoomsForParticipants).not.toHaveBeenCalled();
		expect(getRoomsForParticipant).not.toHaveBeenCalled();
		expect(getMemoriesByRoomIds).not.toHaveBeenCalled();
		expect(result.data?.recentInteractions).toEqual([]);
	});

	it("renders attachment-only cross-world context without capability URLs", async () => {
		const otherRoomId = "00000000-0000-0000-0000-00000000000a";
		const runtime = makeRuntime(
			[],
			{},
			{
				getRoomsForParticipants: vi.fn(async () => [otherRoomId]),
				getRoomsForParticipant: vi.fn(async () => [otherRoomId]),
				getMemoriesByRoomIds: vi.fn(async () => [
					{
						id: "cross-attachment",
						agentId: AGENT_ID,
						roomId: otherRoomId,
						entityId: USER_ID,
						createdAt: 500,
						content: {
							text: "",
							attachments: [
								{
									id: "receipt",
									url: "https://private.example/receipt.jpg",
									filename: "receipt.jpg",
									mimeType: "image/jpeg",
									description: "Dinner is at 6:30 for four at Saffron House",
								},
							],
						},
					} as Memory,
				]),
			},
		);

		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "what was on it?", "telegram", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain(
			"Dinner is at 6:30 for four at Saffron House",
		);
		expect(result.text).not.toContain("private.example");
	});
});

describe("recentMessages retained-history disclosure", () => {
	it("states that every retained message is present", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "bitcoin is up", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "noted", "discord", 2000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory(
				"current",
				USER_ID,
				"how many times did i say bitcoin",
				"discord",
				3000,
			),
			{ values: {}, data: {}, text: "" },
		);

		const text = result.text ?? "";
		expect(text).toContain("# Conversation Messages (2 retained)");
		expect(text).not.toContain("older history is not shown here");
		expect(text).not.toContain("MEMORY op:search");
	});
});
