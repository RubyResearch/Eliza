/**
 * Coverage for `renderMessageHandlerStablePrefix` — the cacheable system +
 * tool-schema segment shared across a room's turns. Runs against a hand-built
 * `vi`-mocked runtime with a stubbed `composeState`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { renderMessageHandlerStablePrefix } from "../services/message";
import type { Action } from "../types/components";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const ROOM_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;

function makeState(): State {
	return {
		values: { availableContexts: "" },
		data: {},
		text: "Recent conversation summary",
	};
}

function makeRuntime(opts: { actions?: Action[] } = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise and helpful.",
			bio: "I help with calendars.",
		},
		actions: opts.actions ?? [],
		providers: [],
		// Action discovery runs the execution gates, which read the room and
		// report gate failures.
		getRoom: vi.fn(async () => null),
		reportError: vi.fn(),
		// Stage-1 triage reads the reply-bypass channel settings before it can
		// decide which providers an ambient turn excludes, so a runtime without
		// `getSetting` cannot render the prefix at all.
		getSetting: vi.fn(() => undefined),
		composeState: vi.fn(async () => makeState()),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("renderMessageHandlerStablePrefix", () => {
	it("renders the system + tool-schema stable prefix for a room", async () => {
		const runtime = makeRuntime();
		const prefix = await renderMessageHandlerStablePrefix(runtime, ROOM_ID);
		expect(typeof prefix).toBe("string");
		expect(prefix.length).toBeGreaterThan(0);
		// The Stage-1 instructions block (the "message_handler_stage:" segment)
		// is always part of the stable prefix.
		expect(prefix).toContain("message_handler_stage:");
		// The canonical system prompt carries the character's system text.
		expect(prefix).toContain("concise");
		// The unstable tail (current user turn) must NOT leak into the prefix —
		// there is no user message in a pre-warm render.
		expect(prefix.toLowerCase()).not.toContain("voice-prewarm");
	});

	it("is deterministic across repeated renders for the same room", async () => {
		const runtime = makeRuntime();
		const a = await renderMessageHandlerStablePrefix(runtime, ROOM_ID);
		const b = await renderMessageHandlerStablePrefix(runtime, ROOM_ID);
		expect(a).toBe(b);
	});

	it("renders chat style directions exactly once, excluding post style", async () => {
		const runtime = makeRuntime();
		(
			runtime.character as {
				style?: { all?: string[]; chat?: string[]; post?: string[] };
			}
		).style = {
			all: ["be brief", "no emoji"],
			chat: ["match their energy"],
			post: ["one idea per post"],
		};
		const prefix = await renderMessageHandlerStablePrefix(runtime, ROOM_ID);
		expect(prefix.split("# Message Directions for Test Agent").length - 1).toBe(
			1,
		);
		expect(prefix).toContain("be brief");
		expect(prefix).toContain("match their energy");
		expect(prefix).not.toContain("one idea per post");
	});

	it("omits the style block when the character declares no chat style", async () => {
		const runtime = makeRuntime();
		const prefix = await renderMessageHandlerStablePrefix(runtime, ROOM_ID);
		expect(prefix).not.toContain("# Message Directions");
	});

	it("calls composeState once per render (so providers are sampled)", async () => {
		const runtime = makeRuntime();
		await renderMessageHandlerStablePrefix(runtime, ROOM_ID);
		expect(runtime.composeState).toHaveBeenCalledTimes(1);
		const providerNames = (
			runtime.composeState as { mock: { calls: unknown[][] } }
		).mock.calls[0]?.[1] as string[];
		expect(providerNames).toContain("RUNTIME_MODEL_CONTEXT");
	});
});
