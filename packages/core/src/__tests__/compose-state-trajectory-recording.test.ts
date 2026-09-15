/**
 * composeState cache behavior while trajectory recording is active. Recording
 * is observational: providers see the same cached state and reuse decisions as
 * an ordinary turn. Real AgentRuntime plus the real RECENT_MESSAGES provider
 * over a minimal in-memory adapter; no model or database server.
 */
import { describe, expect, it, vi } from "vitest";
import { recentMessagesProvider } from "../features/basic-capabilities/providers/recentMessages";
import { AgentRuntime } from "../runtime";
import { ProviderStateComposer } from "../runtime/state-composition/composer";
import { attestDeliveryAudienceFromCanonicalRoom } from "../security";
import type {
	TrajectoryProviderAccessLogger,
	TrajectoryProviderAccessParams,
} from "../trajectory-utils";
import type { Service } from "../types";
import {
	ChannelType,
	type Character,
	type IDatabaseAdapter,
	type Memory,
	type Provider,
	type State,
	type UUID,
} from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const OTHER_ROOM_ID = "11111111-1111-1111-1111-222222222222" as UUID;
const USER_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeRecordedMessage(id: string, text = "gm"): Memory {
	return {
		id: id as UUID,
		entityId: USER_ID,
		roomId: ROOM_ID,
		content: { text, source: "discord" },
		metadata: { type: "message", trajectoryStepId: "traj-step-1" },
	};
}

describe("composeState under trajectory recording", () => {
	it("keeps diagnostics but omits provider text when the audience changes during execution", async () => {
		const runtime = new AgentRuntime({
			character: { name: "Private capture" } as Character,
			settings: { ELIZA_ADMIN_ENTITY_ID: USER_ID },
		});
		let participants = [USER_ID, runtime.agentId];
		vi.spyOn(runtime, "getRoom").mockResolvedValue({
			id: ROOM_ID,
			agentId: runtime.agentId,
			source: "discord",
			type: ChannelType.DM,
		});
		vi.spyOn(runtime, "getParticipantsForRoom").mockImplementation(
			async () => participants,
		);
		const reads: TrajectoryProviderAccessParams[] = [];
		const logger = {
			logProviderAccess: (read: TrajectoryProviderAccessParams) =>
				reads.push(read),
		} as unknown as Service & TrajectoryProviderAccessLogger;
		const composer = new ProviderStateComposer(runtime, {
			hasProviderSelectionHooks: () => false,
			ensureServiceStarted: async () => logger,
			isStopping: () => false,
		});
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: async () => {
				participants = [...participants, OTHER_ROOM_ID];
				return { text: "REVOKED_TEXT_CANARY" };
			},
		});
		const message = makeRecordedMessage("ffffffff-ffff-ffff-ffff-ffffffffffff");
		message.agentId = runtime.agentId;
		await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
		await expect(
			composer.composeState(message, ["PRIVATE"], true),
		).rejects.toMatchObject({ code: "OWNER_PRIVATE_AUDIENCE_CHANGED" });
		expect(reads).toHaveLength(1);
		expect(reads[0].data.text).toBeUndefined();
		expect(JSON.stringify(reads)).not.toContain("REVOKED_TEXT_CANARY");
	});

	it("retains complete redacted text on fresh and reused reads without logging private internal data", async () => {
		const secret = "sk-trajectory-recording-secret-canary-1234567890"; // gitleaks:allow -- synthetic redaction canary
		const runtime = new AgentRuntime({
			character: { name: "Recorded provider" } as Character,
			settings: { OPENAI_API_KEY: secret },
		});
		const reads: TrajectoryProviderAccessParams[] = [];
		const logger = {
			logProviderAccess: (read: TrajectoryProviderAccessParams) =>
				reads.push(read),
		} as unknown as Service & TrajectoryProviderAccessLogger;
		const composer = new ProviderStateComposer(runtime, {
			hasProviderSelectionHooks: () => false,
			ensureServiceStarted: async () => logger,
			isStopping: () => false,
		});
		const source = `Start ${secret}\n${"provider output ".repeat(9000)}\nEXACT_END`;
		const get = vi.fn(async () => ({
			text: source,
			data: { private: "INTERNAL_DATA_CANARY" },
		}));
		const denied = vi.fn(async () => ({ text: "DENIED_PROVIDER_CANARY" }));
		runtime.registerProvider({ name: "PUBLIC_TEXT", get });
		runtime.registerProvider({
			name: "EMPTY",
			get: async () => ({ text: "" }),
		});
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: denied,
		});
		const message = makeRecordedMessage("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
		await composer.composeState(
			message,
			["PUBLIC_TEXT", "EMPTY", "PRIVATE"],
			true,
		);
		await composer.composeState(
			message,
			["PUBLIC_TEXT", "EMPTY"],
			true,
			false,
			["EMPTY"],
		);
		const textReads = reads.filter(
			(read) => read.providerName === "PUBLIC_TEXT",
		);
		expect(textReads).toHaveLength(2);
		expect(get).toHaveBeenCalledTimes(1);
		expect(denied).not.toHaveBeenCalled();
		const expected = runtime.redactSecrets(source);
		expect(expected).not.toContain(secret);
		for (const read of textReads) {
			expect(read.data).toMatchObject({
				text: expected,
				textLength: expected.length,
			});
		}
		expect(textReads.map((read) => read.data.cacheHit)).toEqual([false, true]);
		expect(reads.find((read) => read.providerName === "EMPTY")?.data.text).toBe(
			"",
		);
		expect(JSON.stringify(reads)).not.toContain(secret);
		expect(JSON.stringify(reads)).not.toContain("INTERNAL_DATA_CANARY");
		expect(JSON.stringify(reads)).not.toContain("DENIED_PROVIDER_CANARY");
	});

	it("keeps cross-room interactions suppressed for a group during every compose", async () => {
		const runtime = new AgentRuntime({
			character: { name: "Agent" } as Character,
		});
		const agentEntity = {
			id: runtime.agentId,
			agentId: runtime.agentId,
			names: ["Agent"],
			components: [],
		};
		const userEntity = {
			id: USER_ID,
			agentId: runtime.agentId,
			names: ["User"],
			components: [],
		};
		const getRoomsForParticipants = vi.fn(async () => [ROOM_ID, OTHER_ROOM_ID]);
		const getMemoriesByRoomIds = vi.fn(async () => [
			{
				id: "cross-1" as UUID,
				agentId: runtime.agentId,
				roomId: OTHER_ROOM_ID,
				entityId: USER_ID,
				createdAt: 500,
				content: { text: "the blue key is under the mat" },
			} as Memory,
		]);
		runtime.registerDatabaseAdapter({
			getRoomsByIds: async () => [
				{
					id: ROOM_ID,
					agentId: runtime.agentId,
					source: "discord",
					type: ChannelType.GROUP,
					metadata: {},
				},
			],
			getEntitiesForRooms: async () => [
				{ roomId: ROOM_ID, entities: [agentEntity, userEntity] },
			],
			getEntitiesByIds: async (ids: UUID[]) =>
				[agentEntity, userEntity].filter((e) => ids.includes(e.id)),
			getMemories: async () => [
				{
					id: "msg-1" as UUID,
					agentId: runtime.agentId,
					roomId: ROOM_ID,
					entityId: USER_ID,
					createdAt: 1000,
					content: { text: "hello agent", source: "discord" },
				} as Memory,
			],
			getRoomsForParticipants,
			getMemoriesByRoomIds,
		} as unknown as IDatabaseAdapter);
		runtime.registerProvider(recentMessagesProvider);

		const message = makeRecordedMessage("cccccccc-cccc-cccc-cccc-cccccccccccc");

		// The room is a group, so owner-private continuity must fail closed before
		// the identity or cross-room storage reads on every compose.
		const stage1State = await runtime.composeState(
			message,
			["RECENT_MESSAGES"],
			true,
			false,
		);
		expect(getRoomsForParticipants).not.toHaveBeenCalled();
		expect(getMemoriesByRoomIds).not.toHaveBeenCalled();
		expect(stage1State.values?.recentMessageInteractions).toBe("");

		const plannerState = await runtime.composeState(
			message,
			["RECENT_MESSAGES"],
			true,
			false,
			["RECENT_MESSAGES"],
		);
		expect(getRoomsForParticipants).not.toHaveBeenCalled();
		expect(getMemoriesByRoomIds).not.toHaveBeenCalled();
		expect(plannerState.values?.recentMessageInteractions).toBe("");
	});

	it("reuses cached providers outside the refresh list without changing behavior", async () => {
		const runtime = new AgentRuntime({
			character: { name: "Agent" } as Character,
		});
		let factsRuns = 0;
		const seenCachedProviders: string[][] = [];
		const facts: Provider = {
			name: "FACTS",
			get: async (_runtime, _message, state: State) => {
				factsRuns += 1;
				seenCachedProviders.push(
					Object.keys(
						(state?.data?.providers as Record<string, unknown>) ?? {},
					),
				);
				return { text: `FACTS#${factsRuns}`, values: {}, data: {} };
			},
		};
		const recent: Provider = {
			name: "RECENT_MESSAGES",
			get: async () => ({ text: "recent", values: {}, data: {} }),
		};
		runtime.registerProvider(facts);
		runtime.registerProvider(recent);

		const message = makeRecordedMessage("dddddddd-dddd-dddd-dddd-dddddddddddd");
		await runtime.composeState(
			message,
			["FACTS", "RECENT_MESSAGES"],
			true,
			false,
		);
		const plannerState = await runtime.composeState(
			message,
			["FACTS", "RECENT_MESSAGES"],
			true,
			false,
			["RECENT_MESSAGES"],
		);

		// Trajectory recording must not force FACTS to run again. The runtime
		// records the planner access as a cache hit instead.
		expect(factsRuns).toBe(1);
		expect(seenCachedProviders[0]).toEqual([]);
		expect(seenCachedProviders).toHaveLength(1);
		expect(plannerState.text).toContain("FACTS#1");
	});
});
