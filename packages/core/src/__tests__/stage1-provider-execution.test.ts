/**
 * Proves the Stage-1 provider exclusions are EXECUTION exclusions, not just
 * render exclusions: `stage1ResponseStateProviderNames` subtracts the
 * excluded providers from the compose include list, so an excluded provider
 * never runs for the turn. Since #24134 ("preserve complete model context")
 * the only Stage-1 exclusion is the ambient-turn one (RECENT_ERRORS on
 * unaddressed group traffic) — the blanket ENTITIES/DOCUMENTS exclusion was
 * removed because dropping composed context from a model-facing prompt is
 * exactly what the repository's prompt-integrity rule forbids. The core
 * response providers and every `alwaysInResponseState` plugin provider
 * therefore compose at Stage 1 and are reused from the turn cache by the
 * planner recompose. Also pins that CURRENT_TIME is unconditionally
 * composed — the system prompt promises a time signal in every runtime
 * context, so no message phrasing may drop it. Uses a real in-memory
 * AgentRuntime with call-counting providers; no database or model.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { userPersonalityProvider } from "../features/advanced-capabilities/personality/providers/user-personality";
import { PersonalityStore } from "../features/advanced-capabilities/personality/services/personality-store";
import { AgentRuntime } from "../runtime";
import { stage1ResponseStateProviderNames } from "../services/message";
import type {
	Character,
	Content,
	IAgentRuntime,
	Memory,
	Provider,
	UUID,
} from "../types";
import { ChannelType } from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMessage(
	id: string,
	text = "gm",
	content: Partial<Content> = {},
): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text, ...content },
	};
}

/** Provider whose text changes on every run, so reuse vs re-run is observable. */
function countingProvider(name: string): {
	provider: Provider;
	calls: () => number;
} {
	let n = 0;
	return {
		provider: {
			name,
			get: async () => {
				n += 1;
				return { text: `${name}#${n}`, values: {}, data: {} };
			},
		},
		calls: () => n,
	};
}

describe("stage1ResponseStateProviderNames", () => {
	it("composes the actual user's saved style before context selection without exposing another user's slot", async () => {
		const runtime = new AgentRuntime({
			character: { name: "preference-stage1" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
		});
		const store = (await PersonalityStore.start(runtime)) as PersonalityStore;
		runtime.services.set(PersonalityStore.serviceType, [store]);
		await store.addDirective({
			userId: ENTITY_ID,
			agentId: runtime.agentId,
			actorId: ENTITY_ID,
			directive: "Write headings in sentence case.",
			source: "user",
		});
		runtime.registerProvider(userPersonalityProvider);
		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1", "hi");
		const names = stage1ResponseStateProviderNames(runtime, message, ["USER"]);
		const state = await runtime.composeState(message, names, true);
		expect(state.text).toContain("Write headings in sentence case.");
		const other = {
			...message,
			id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2" as UUID,
			entityId: "22222222-2222-2222-2222-222222222223" as UUID,
		};
		const otherState = await runtime.composeState(
			other,
			stage1ResponseStateProviderNames(runtime, other, ["USER"]),
			true,
		);
		expect(otherState.text).not.toContain("Write headings in sentence case.");
		expect(
			stage1ResponseStateProviderNames(runtime, message, ["GUEST"]),
		).not.toContain(userPersonalityProvider.name);
	});

	it("does not let always-on opt-in bypass either declared role gate", () => {
		const runtime = {
			providers: [
				{
					name: "private-reference",
					alwaysInResponseState: true,
					private: true,
				},
				{
					name: "admin-reference",
					alwaysInResponseState: true,
					roleGate: { minRole: "ADMIN" },
				},
				{
					name: "owner-reference",
					alwaysInResponseState: true,
					roleGate: { minRole: "ADMIN" },
					contextGate: { roleGate: { minRole: "OWNER" } },
				},
			],
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;
		const message = makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1");
		for (const role of ["MEMBER", "ADMIN", "OWNER"] as const) {
			const names = stage1ResponseStateProviderNames(runtime, message, [role]);
			expect(names).not.toContain("private-reference");
			expect(names.includes("admin-reference")).toBe(role !== "MEMBER");
			expect(names.includes("owner-reference")).toBe(role === "OWNER");
		}
	});

	it("keeps the core response providers complete on an unexcluded turn", () => {
		const runtime = {
			providers: [],
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;
		const names = stage1ResponseStateProviderNames(
			runtime,
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"),
		);

		// #24134 removed the blanket ENTITIES/DOCUMENTS stage-1 exclusion: a
		// cheaper prompt is not a licence to drop composed model context.
		expect(names).toContain("ENTITIES");
		expect(names).toContain("RECENT_MESSAGES");
		expect(names).toContain("FACTS");
		expect(names).toContain("ATTACHMENTS");
	});

	it("always includes CURRENT_TIME regardless of message phrasing", () => {
		// Live incident: a regex gate re-included CURRENT_TIME only for
		// messages that "looked like" time questions, so the apostrophe-free
		// "whats todays date and time?" lost the time block and the model
		// hallucinated a stale date. The signal must not depend on prose.
		const runtime = {
			providers: [],
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;
		for (const text of [
			"gm",
			"whats todays date and time?",
			"what time is it?",
			"tell me a short joke",
		]) {
			const names = stage1ResponseStateProviderNames(
				runtime,
				makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", text),
			);
			expect(names).toContain("CURRENT_TIME");
			expect(names).toContain("ENTITIES");
		}
	});

	it("includes every always-on plugin provider", () => {
		const runtime = {
			getSetting: () => undefined,
			providers: [
				{
					name: "PLUGIN_CTX",
					alwaysInResponseState: true,
					get: async () => ({}),
				},
				{
					name: "DOCUMENTS",
					alwaysInResponseState: true,
					get: async () => ({}),
				},
			],
		} as unknown as IAgentRuntime;
		const names = stage1ResponseStateProviderNames(
			runtime,
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3"),
		);

		expect(names).toContain("PLUGIN_CTX");
		// DOCUMENTS opts in via `alwaysInResponseState`; honoring that opt-in is
		// the whole contract, and #24134 removed the special case that dropped it.
		expect(names).toContain("DOCUMENTS");
	});

	it("composes the core providers once and reuses them in the planner recompose", async () => {
		const runtime = new AgentRuntime({
			character: { name: "stage1-exec-test" } as Character,
		});
		const entities = countingProvider("ENTITIES");
		const currentTime = countingProvider("CURRENT_TIME");
		const facts = countingProvider("FACTS");
		const recent = countingProvider("RECENT_MESSAGES");
		for (const p of [entities, currentTime, facts, recent]) {
			runtime.registerProvider(p.provider);
		}

		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
		const stage1Names = stage1ResponseStateProviderNames(runtime, message);

		// Stage-1 compose: every core response provider executes exactly once
		// and reaches the Stage-1 prompt. CURRENT_TIME in particular composes on
		// every turn so the simple path can honor the system prompt's promise of
		// a live time signal.
		const stage1State = await runtime.composeState(
			message,
			stage1Names,
			true,
			false,
		);
		expect(entities.calls()).toBe(1);
		expect(currentTime.calls()).toBe(1);
		expect(facts.calls()).toBe(1);
		expect(recent.calls()).toBe(1);
		expect(stage1State.text).toContain("ENTITIES#1");
		expect(stage1State.text).toContain("CURRENT_TIME#1");
		expect(stage1State.text).toContain("FACTS#1");

		// Planner recompose (mirrors selectV5PlannerStateProviderNames re-adding
		// the core response providers, with RECENT_MESSAGES refreshed): every
		// already-composed provider is served from the turn cache — only the
		// explicitly refreshed RECENT_MESSAGES runs a second time — and the
		// planner prompt still carries all of them.
		const plannerState = await runtime.composeState(
			message,
			[...stage1Names, "ENTITIES", "CURRENT_TIME"],
			true,
			false,
			["RECENT_MESSAGES"],
		);
		expect(entities.calls()).toBe(1);
		expect(currentTime.calls()).toBe(1);
		expect(facts.calls()).toBe(1);
		expect(recent.calls()).toBe(2);
		expect(plannerState.text).toContain("ENTITIES#1");
		expect(plannerState.text).toContain("CURRENT_TIME#1");
		expect(plannerState.text).toContain("FACTS#1");
		expect(plannerState.text).toContain("RECENT_MESSAGES#2");
	});
});

/**
 * RECENT_ERRORS is internal diagnostics for turns where the agent is acting or
 * its operator is engaging. Rendered into an UNADDRESSED group turn it hijacks
 * routing — a live "available_apps provider timeout" got answered as if it
 * were a bystander's question (tj-f8249b30e986d6). The exclusion keys off the
 * structural addressing classifier (channel type + mention/reply/name-drop +
 * source metadata), never message-text heuristics, and fails OPEN: anything
 * not positively identified as unaddressed group traffic keeps the provider.
 */
describe("RECENT_ERRORS stage-1 exclusion on unaddressed group turns", () => {
	const AGENT_NAME = "stage1-exec-test";

	function runtimeWithRecentErrors(): IAgentRuntime {
		return {
			character: { name: AGENT_NAME },
			getSetting: () => undefined,
			providers: [
				{
					name: "RECENT_ERRORS",
					alwaysInResponseState: true,
					get: async () => ({}),
				},
			],
		} as unknown as IAgentRuntime;
	}

	it("excludes RECENT_ERRORS from an unaddressed text-group turn", () => {
		const names = stage1ResponseStateProviderNames(
			runtimeWithRecentErrors(),
			makeMessage("cccccccc-cccc-cccc-cccc-cccccccccc01", "gm", {
				channelType: ChannelType.GROUP,
			}),
		);
		expect(names).not.toContain("RECENT_ERRORS");
		// Only the diagnostics block is withheld — routing signals stay intact.
		expect(names).toContain("CURRENT_TIME");
		expect(names).toContain("FACTS");
	});

	it("keeps RECENT_ERRORS on an addressed group turn (platform mention)", () => {
		const names = stage1ResponseStateProviderNames(
			runtimeWithRecentErrors(),
			makeMessage("cccccccc-cccc-cccc-cccc-cccccccccc02", "gm", {
				channelType: ChannelType.GROUP,
				mentionContext: { isMention: true, isReply: false, isThread: false },
			}),
		);
		expect(names).toContain("RECENT_ERRORS");
	});

	it("keeps RECENT_ERRORS on a reply-to-agent group turn", () => {
		const names = stage1ResponseStateProviderNames(
			runtimeWithRecentErrors(),
			makeMessage("cccccccc-cccc-cccc-cccc-cccccccccc03", "gm", {
				channelType: ChannelType.GROUP,
				mentionContext: { isMention: false, isReply: true, isThread: false },
			}),
		);
		expect(names).toContain("RECENT_ERRORS");
	});

	it("keeps RECENT_ERRORS on a name-drop group turn", () => {
		const names = stage1ResponseStateProviderNames(
			runtimeWithRecentErrors(),
			makeMessage(
				"cccccccc-cccc-cccc-cccc-cccccccccc04",
				`hey ${AGENT_NAME}, what broke?`,
				{ channelType: ChannelType.GROUP },
			),
		);
		expect(names).toContain("RECENT_ERRORS");
	});

	it("keeps RECENT_ERRORS on DM turns and unknown channel types (fail open)", () => {
		for (const content of [
			{ channelType: ChannelType.DM },
			{}, // missing channel type must fail open
		]) {
			const names = stage1ResponseStateProviderNames(
				runtimeWithRecentErrors(),
				makeMessage("cccccccc-cccc-cccc-cccc-cccccccccc05", "gm", content),
			);
			expect(names).toContain("RECENT_ERRORS");
		}
	});

	it("never composes RECENT_ERRORS for an unaddressed group turn, but renders it for an addressed one", async () => {
		const runtime = new AgentRuntime({
			character: { name: AGENT_NAME } as Character,
		});
		const recentErrors = countingProvider("RECENT_ERRORS");
		recentErrors.provider.alwaysInResponseState = true;
		runtime.registerProvider(recentErrors.provider);

		const unaddressed = makeMessage(
			"dddddddd-dddd-dddd-dddd-dddddddddd01",
			"is that just the feeless txes stuff?",
			{ channelType: ChannelType.GROUP },
		);
		const unaddressedState = await runtime.composeState(
			unaddressed,
			stage1ResponseStateProviderNames(runtime, unaddressed),
			true,
			false,
		);
		expect(recentErrors.calls()).toBe(0);
		expect(unaddressedState.text).not.toContain("RECENT_ERRORS#");

		const addressed = makeMessage(
			"dddddddd-dddd-dddd-dddd-dddddddddd02",
			"anything failing lately?",
			{
				channelType: ChannelType.GROUP,
				mentionContext: { isMention: true, isReply: false, isThread: false },
			},
		);
		const addressedState = await runtime.composeState(
			addressed,
			stage1ResponseStateProviderNames(runtime, addressed),
			true,
			false,
		);
		expect(recentErrors.calls()).toBe(1);
		expect(addressedState.text).toContain("RECENT_ERRORS#1");
	});
});
