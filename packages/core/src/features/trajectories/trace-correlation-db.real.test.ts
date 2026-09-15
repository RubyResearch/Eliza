/**
 * Real-PGLite coverage for native trajectory persistence and lifecycle
 * contracts, including schema migration, owner isolation, atomic fault
 * rollback, strict decoding, terminal cleanup, late capture, and read routes.
 */

import type { ServerResponse } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, MessagePayload } from "../../types";
import { trajectoriesPlugin } from "./index";
import { tryHandleTrajectoryReadRoutes } from "./read-routes";
import { TrajectoriesService } from "./TrajectoriesService";

let db: ReturnType<typeof drizzle>;
let client: PGlite;
let service: TrajectoriesService;
let serviceRuntime: IAgentRuntime;

function queryText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
		.queryChunks;
	if (!Array.isArray(chunks)) return String(value);
	return chunks
		.flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
		.join("");
}

type LookupGate = {
	entered: Promise<void>;
	release: () => void;
};

function createLookupGate(): {
	gate: LookupGate;
	markEntered: () => void;
	waitForRelease: Promise<void>;
} {
	let markEntered = (): void => {};
	let release = (): void => {};
	const entered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	const waitForRelease = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { gate: { entered, release }, markEntered, waitForRelease };
}

async function makeDelayedLookupService(
	agentId: string,
	lookupCount: number,
	shouldDelay: (text: string) => boolean = (text) =>
		text.includes("FROM trajectory_step_index i"),
	delayAfterExecute = false,
): Promise<{
	service: TrajectoriesService;
	runtime: IAgentRuntime;
	gates: LookupGate[];
	enableDelays: () => void;
}> {
	type RawQuery = ReturnType<typeof sql.raw>;
	type TransactionExecutor = {
		execute: (query: RawQuery) => Promise<unknown>;
	};
	const gateStates = Array.from({ length: lookupCount }, createLookupGate);
	let delaysEnabled = false;
	let nextGate = 0;
	const proxyDb = {
		execute: async (query: RawQuery) => {
			if (delaysEnabled && shouldDelay(queryText(query))) {
				const state = gateStates[nextGate];
				nextGate += 1;
				if (!state) {
					throw new Error("Unexpected delayed trajectory lookup");
				}
				if (delayAfterExecute) {
					const result = await db.execute(query);
					state.markEntered();
					await state.waitForRelease;
					return result;
				}
				state.markEntered();
				await state.waitForRelease;
			}
			return db.execute(query);
		},
		transaction: async <T>(
			work: (executor: TransactionExecutor) => Promise<T>,
		): Promise<T> =>
			db.transaction((tx) => work({ execute: (query) => tx.execute(query) })),
	};
	const runtime = {
		agentId,
		runtimeInstanceId: crypto.randomUUID(),
		adapter: { db: proxyDb },
		getService: () => null,
		getServicesByType: () => [],
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
	const delayedService = new TrajectoriesService(runtime);
	delayedService.setEnabled(true);
	await delayedService.initialize();
	return {
		service: delayedService,
		runtime,
		gates: gateStates.map((state) => state.gate),
		enableDelays: () => {
			delaysEnabled = true;
		},
	};
}

async function makeFaultService(agentId: string): Promise<{
	service: TrajectoriesService;
	runtime: IAgentRuntime;
	fault: { failAt: number | null; observed: number };
}> {
	const fault = { failAt: null as number | null, observed: 0 };
	type RawQuery = ReturnType<typeof sql.raw>;
	type TransactionExecutor = {
		execute: (query: RawQuery) => Promise<unknown>;
	};
	const proxyDb = {
		execute: (query: RawQuery) => db.execute(query),
		transaction: async <T>(
			work: (executor: TransactionExecutor) => Promise<T>,
		): Promise<T> =>
			db.transaction(async (tx) => {
				fault.observed = 0;
				return work({
					execute: async (query) => {
						fault.observed += 1;
						if (fault.failAt === fault.observed) {
							throw new Error(
								`injected transaction statement ${fault.observed}: ${queryText(query)}`,
							);
						}
						return tx.execute(query);
					},
				});
			}),
	};
	const runtime = {
		agentId,
		runtimeInstanceId: crypto.randomUUID(),
		adapter: { db: proxyDb },
		getService: () => null,
		getServicesByType: () => [],
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
	const faultService = new TrajectoriesService(runtime);
	faultService.setEnabled(true);
	await faultService.initialize();
	return { service: faultService, runtime, fault };
}

async function readDetailRoute(
	runtime: IAgentRuntime,
	trajectoryId: string,
): Promise<{ status: number; body: unknown }> {
	const state = { status: 0, body: undefined as unknown };
	const response = {
		statusCode: 0,
		setHeader() {},
		end(payload?: string) {
			state.status = response.statusCode;
			state.body = payload ? JSON.parse(payload) : undefined;
		},
	} as unknown as ServerResponse;
	await tryHandleTrajectoryReadRoutes({
		pathname: `/api/trajectories/${trajectoryId}`,
		method: "GET",
		url: new URL(`http://localhost/api/trajectories/${trajectoryId}`),
		runtime,
		res: response,
	});
	return state;
}

async function raw(text: string): Promise<Record<string, unknown>[]> {
	const res = await db.execute(sql.raw(text));
	return (res.rows as Record<string, unknown>[]) ?? [];
}

async function traceColumnExists(): Promise<boolean> {
	const rows = await raw(
		`SELECT column_name FROM information_schema.columns
     WHERE table_name = 'trajectories' AND column_name = 'trace_id'`,
	);
	return rows.some((r) => r.column_name === "trace_id");
}

beforeAll(async () => {
	client = new PGlite();
	db = drizzle(client);
	serviceRuntime = {
		agentId: "00000000-0000-4000-8000-000000000001",
		runtimeInstanceId: crypto.randomUUID(),
		adapter: { db },
		getService: () => null,
		getServicesByType: () => [],
	} as unknown as IAgentRuntime;
	service = new TrajectoriesService(serviceRuntime);
	// NODE_ENV=test defaults the gate off; enable persistence directly for this
	// DB-round-trip test.
	service.setEnabled(true);
	await service.initialize();
}, 60_000);

afterAll(async () => {
	await client?.close?.();
});

describe("trajectory graceful shutdown ownership (real PGlite)", () => {
	it("does not reclaim ownership after a concurrent clear deletes a committed start", async () => {
		const owner = await makeDelayedLookupService(
			crypto.randomUUID(),
			1,
			(text) => text.includes("INSERT INTO trajectories"),
			true,
		);
		const gate = owner.gates[0];
		if (!gate) throw new Error("Missing committed insert gate");
		owner.enableDelays();
		const starting = owner.service.startTrajectory(owner.runtime.agentId);
		await gate.entered;
		const count = await owner.service.clearAllTrajectories();
		gate.release();
		const trajectoryId = await starting;
		expect(count).toBe(1);
		expect(await owner.service.getTrajectoryDetail(trajectoryId)).toBeNull();
		// No owned run remains, so stopping must not need a storage transaction.
		owner.runtime.adapter.db = {};
		await expect(owner.service.stop()).resolves.toBeUndefined();
	});

	it.each(["selected", "all"] as const)(
		"releases shutdown ownership after deleting %s trajectories",
		async (mode) => {
			const owner = await makeFaultService(crypto.randomUUID());
			const other = await makeFaultService(crypto.randomUUID());
			const trajectoryId = await owner.service.startTrajectory(
				owner.runtime.agentId,
			);
			const otherId = await other.service.startTrajectory(
				other.runtime.agentId,
			);
			const count =
				mode === "selected"
					? await owner.service.deleteTrajectories([trajectoryId, otherId])
					: await owner.service.clearAllTrajectories();
			expect(count).toBe(1);
			expect(await owner.service.getTrajectoryDetail(trajectoryId)).toBeNull();
			expect(
				(await other.service.getTrajectoryDetail(otherId))?.metrics.finalStatus,
			).toBe("active");
			// A deleted run must not leave a shutdown write behind if the database
			// later becomes unavailable during process teardown.
			owner.fault.failAt = 1;
			await expect(owner.service.stop()).resolves.toBeUndefined();
		},
	);

	it("terminates only this service's starts and preserves settled content and other owners", async () => {
		const owner = await makeFaultService(
			"00000000-0000-4000-8000-000000000401",
		);
		const sibling = await makeFaultService(owner.runtime.agentId);
		const otherAgent = await makeFaultService(
			"00000000-0000-4000-8000-000000000402",
		);
		const noStepId = await owner.service.startTrajectory(
			owner.runtime.agentId,
			{
				metadata: { runtimeInstanceId: sibling.runtime.runtimeInstanceId },
			},
		);
		const activeId = await owner.service.startTrajectory(owner.runtime.agentId);
		const stepId = owner.service.startStep(activeId, { timestamp: Date.now() });
		await owner.service.flushWriteQueue(activeId);
		owner.service.logLlmCall({
			stepId,
			model: "shutdown-proof",
			systemPrompt: "system",
			userPrompt: "prompt",
			response: "Saved before shutdown.",
			purpose: "action",
		});
		await owner.service.flushWriteQueue(activeId);
		const contentBefore = await owner.service.getTrajectoryDetail(activeId);
		const completedId = await owner.service.startTrajectory(
			owner.runtime.agentId,
		);
		// A terminal event can be persisted through another service before the
		// creator shuts down. Its local start registry must not reopen that result.
		await sibling.service.endTrajectory(completedId, "completed");
		const completedBefore =
			await owner.service.getTrajectoryDetail(completedId);
		const siblingId = await sibling.service.startTrajectory(
			sibling.runtime.agentId,
		);
		const otherId = await otherAgent.service.startTrajectory(
			otherAgent.runtime.agentId,
		);
		// A service can capture a same-agent trajectory through the public routing
		// contract. That routing is not authority to terminate its creator's run.
		owner.service.startStep(siblingId, { timestamp: Date.now() });
		await owner.service.flushWriteQueue(siblingId);
		const siblingBefore = await sibling.service.getTrajectoryDetail(siblingId);

		await Promise.all([owner.service.stop(), owner.service.stop()]);

		const stopped = await owner.service.getTrajectoryDetail(activeId);
		expect(stopped?.metrics.finalStatus).toBe("terminated");
		expect(stopped?.steps).toEqual(contentBefore?.steps);
		expect(stopped?.metadata).toEqual(contentBefore?.metadata);
		expect(stopped?.endTime).toBeGreaterThanOrEqual(
			stopped?.startTime ?? Infinity,
		);
		expect(stopped?.durationMs).toBe(
			(stopped?.endTime ?? 0) - (stopped?.startTime ?? 0),
		);
		expect(
			await raw(
				`SELECT is_active FROM trajectory_step_index WHERE step_id = '${stepId}'`,
			),
		).toEqual([{ is_active: false }]);
		const noStep = await owner.service.getTrajectoryDetail(noStepId);
		expect(noStep).toMatchObject({
			steps: [],
			metrics: { finalStatus: "terminated", episodeLength: 0 },
			metadata: { runtimeInstanceId: owner.runtime.runtimeInstanceId },
		});
		expect(await sibling.service.getTrajectoryDetail(siblingId)).toEqual(
			siblingBefore,
		);
		expect(
			(await otherAgent.service.getTrajectoryDetail(otherId))?.metrics
				.finalStatus,
		).toBe("active");
		expect(await owner.service.getTrajectoryDetail(completedId)).toEqual(
			completedBefore,
		);
		await owner.service.stop();
		expect(await owner.service.getTrajectoryDetail(activeId)).toEqual(stopped);
	});

	it("waits for an accepted no-step insert before shutdown and rejects new starts", async () => {
		const owner = await makeDelayedLookupService(
			"00000000-0000-4000-8000-000000000403",
			1,
			(text) => text.includes("INSERT INTO trajectories"),
		);
		const gate = owner.gates[0];
		if (!gate) throw new Error("Missing start gate");
		owner.enableDelays();
		const starting = owner.service.startTrajectory(owner.runtime.agentId);
		await gate.entered;
		let stopped = false;
		const stopping = owner.service.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		const stoppedBeforeInsert = stopped;
		const rejectedId = await owner.service.startTrajectory(
			owner.runtime.agentId,
		);
		gate.release();
		const trajectoryId = await starting;
		await stopping;
		expect(stoppedBeforeInsert).toBe(false);
		expect(await owner.service.getTrajectoryDetail(trajectoryId)).toMatchObject(
			{
				steps: [],
				metrics: { finalStatus: "terminated" },
			},
		);
		expect(await owner.service.getTrajectoryDetail(rejectedId)).toBeNull();
	});

	it("drains queued capture before termination without discarding its recorded result", async () => {
		const owner = await makeFaultService(
			"00000000-0000-4000-8000-000000000404",
		);
		const trajectoryId = await owner.service.startTrajectory(
			owner.runtime.agentId,
		);
		const stepId = owner.service.startStep(trajectoryId, {
			timestamp: Date.now(),
		});
		owner.service.logLlmCall({
			stepId,
			model: "queued-before-stop",
			systemPrompt: "system",
			userPrompt: "prompt",
			response: "The accepted response must survive.",
			purpose: "action",
		});
		await owner.service.stop();
		const detail = await owner.service.getTrajectoryDetail(trajectoryId);
		expect(detail?.metrics.finalStatus).toBe("terminated");
		expect(detail?.steps.flatMap((step) => step.llmCalls)).toEqual([
			expect.objectContaining({
				response: "The accepted response must survive.",
			}),
		]);
	});

	it("rolls back every shutdown statement and allows a later stop to finish", async () => {
		for (let failAt = 1; failAt <= 3; failAt += 1) {
			const owner = await makeFaultService(
				`00000000-0000-4000-8000-00000000041${failAt}`,
			);
			const trajectoryId = await owner.service.startTrajectory(
				owner.runtime.agentId,
			);
			const stepId = owner.service.startStep(trajectoryId, {
				timestamp: Date.now(),
			});
			await owner.service.flushWriteQueue(trajectoryId);
			const before = await owner.service.getTrajectoryDetail(trajectoryId);
			owner.fault.failAt = failAt;
			await expect(owner.service.stop()).rejects.toThrow();
			owner.fault.failAt = null;
			expect(await owner.service.getTrajectoryDetail(trajectoryId)).toEqual(
				before,
			);
			expect(
				await raw(
					`SELECT is_active FROM trajectory_step_index WHERE step_id = '${stepId}'`,
				),
			).toEqual([{ is_active: true }]);
			expect(owner.service.isEnabled()).toBe(false);
			await owner.service.stop();
			expect(
				(await owner.service.getTrajectoryDetail(trajectoryId))?.metrics
					.finalStatus,
			).toBe("terminated");
			expect(
				await raw(
					`SELECT is_active FROM trajectory_step_index WHERE step_id = '${stepId}'`,
				),
			).toEqual([{ is_active: false }]);
		}
	});
});

describe("trajectories trace_id join key (real PGLite)", () => {
	it("self-migrates trace_id onto a legacy trajectories table", async () => {
		expect(await traceColumnExists()).toBe(true);

		// Simulate a legacy deployment predating the column, then re-run the
		// idempotent schema bootstrap; ensureTrajectoryColumnsExist must re-add it.
		await raw(`ALTER TABLE trajectories DROP COLUMN trace_id`);
		expect(await traceColumnExists()).toBe(false);

		const svc = service as unknown as {
			initialized: boolean;
			initialize: () => Promise<void>;
		};
		svc.initialized = false;
		await svc.initialize();
		expect(await traceColumnExists()).toBe(true);
	});

	it("persists + filters by traceId with the correlation envelope in metadata", async () => {
		const logger = service as unknown as {
			startTrajectory: (
				agentId: string,
				opts: {
					source?: string;
					traceId?: string;
					scenarioId?: string;
					metadata?: Record<string, unknown>;
				},
			) => Promise<string>;
			listTrajectories: (opts: {
				limit?: number;
				traceId?: string;
			}) => Promise<{
				trajectories: Array<{
					id: string;
					metadata: Record<string, unknown>;
				}>;
				total: number;
			}>;
		};
		const traceId = "trace-fixture-0001";

		const id = await logger.startTrajectory(
			"00000000-0000-4000-8000-000000000001",
			{
				source: "chat",
				traceId,
				scenarioId: "run-xyz",
				metadata: { roomId: "room-1" },
			},
		);
		expect(typeof id).toBe("string");

		// A second trajectory under a different trace must NOT match the filter.
		await logger.startTrajectory("00000000-0000-4000-8000-000000000001", {
			source: "chat",
			traceId: "trace-fixture-0002",
		});

		const filtered = await logger.listTrajectories({ traceId, limit: 50 });
		expect(filtered.trajectories.map((t) => t.id)).toEqual([id]);

		const correlation = (
			filtered.trajectories[0].metadata as {
				correlation?: { traceId?: string; runId?: string };
			}
		).correlation;
		expect(correlation?.traceId).toBe(traceId);
		expect(correlation?.runId).toBe("run-xyz");

		const rows = await raw(
			`SELECT trace_id FROM trajectories WHERE id = '${id}'`,
		);
		expect(rows[0]?.trace_id).toBe(traceId);
	});

	it("filters exact room and source before pagination through the read route", async () => {
		const roomId = "room'_%filter";
		const id = await service.startTrajectory(
			"00000000-0000-4000-8000-000000000001",
			{
				source: "room-filter-chat",
				metadata: { roomId },
			},
		);
		await service.startTrajectory("00000000-0000-4000-8000-000000000001", {
			source: "room-filter-chat",
			metadata: { roomId: "other-room", note: roomId },
		});
		await service.startTrajectory("00000000-0000-4000-8000-000000000001", {
			source: "background_memory",
			metadata: { roomId },
		});
		let body = "";
		const res = {
			setHeader: () => {},
			end: (text: string) => {
				body = text;
			},
		} as unknown as ServerResponse;
		const handled = await tryHandleTrajectoryReadRoutes({
			method: "GET",
			pathname: "/api/trajectories",
			url: new URL(
				`http://localhost/api/trajectories?roomId=${encodeURIComponent(roomId)}&source=room-filter-chat&limit=1`,
			),
			runtime: {
				...serviceRuntime,
				getService: () => service,
				getServicesByType: () => [service],
			} as unknown as IAgentRuntime,
			res,
		});
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const result = JSON.parse(body);
		expect(result.total).toBe(1);
		expect(result.trajectories.map((row: { id: string }) => row.id)).toEqual([
			id,
		]);
	});

	it("round-trips terminated status through the public list filter", async () => {
		const trajectoryId = await service.startTrajectory(
			"00000000-0000-4000-8000-000000000001",
			{ source: "status-test", metadata: { roomId: "terminated-room" } },
		);
		await service.endTrajectory(trajectoryId, "terminated");

		const filtered = await service.listTrajectories({
			status: "terminated",
			limit: 50,
		});
		expect(filtered.trajectories).toEqual([
			expect.objectContaining({
				id: trajectoryId,
				status: "terminated",
				roomId: "terminated-room",
			}),
		]);
	});

	it("applies one delayed reward without reopening a completed trajectory", async () => {
		const trajectoryId = await service.startTrajectory(serviceRuntime.agentId, {
			source: "morning-brief",
		});
		await service.endTrajectory(trajectoryId, "completed");

		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () =>
				service.applyReward({
					trajectoryId,
					idempotencyKey: "brief-engagement:event-1",
					reward: 0.75,
					component: "briefEngagementReward",
				}),
			),
		);
		// Every caller observes a settled receipt, while the reward is added once.
		expect(outcomes.filter(Boolean)).toHaveLength(8);
		const detail = await service.getTrajectoryDetail(trajectoryId);
		expect(detail).toMatchObject({
			totalReward: 0.75,
			metrics: { finalStatus: "completed" },
			rewardComponents: {
				components: { briefEngagementReward: 0.75 },
			},
			metadata: {
				appliedRewardKeys: ["brief-engagement:event-1"],
			},
		});
	});

	it("serializes different delayed reward keys across service instances", async () => {
		const trajectoryId = await service.startTrajectory(serviceRuntime.agentId, {
			source: "morning-brief-cross-process",
		});
		await service.endTrajectory(trajectoryId, "completed");
		const otherService = new TrajectoriesService(serviceRuntime);
		otherService.setEnabled(true);
		await otherService.initialize();

		expect(
			await Promise.all([
				service.applyReward({
					trajectoryId,
					idempotencyKey: "brief-engagement:event-a",
					reward: 0.75,
					component: "briefEngagementReward",
				}),
				otherService.applyReward({
					trajectoryId,
					idempotencyKey: "brief-engagement:event-b",
					reward: 0.5,
					component: "briefEngagementReward",
				}),
			]),
		).toEqual([true, true]);
		const detail = await service.getTrajectoryDetail(trajectoryId);
		expect(detail).toMatchObject({
			totalReward: 1.25,
			rewardComponents: {
				components: { briefEngagementReward: 1.25 },
			},
		});
		expect(detail?.metadata.appliedRewardKeys).toEqual(
			expect.arrayContaining([
				"brief-engagement:event-a",
				"brief-engagement:event-b",
			]),
		);
	});

	// Emit-first paths (the agent API chat route and connectors) emit
	// MESSAGE_RECEIVED before messageService.handleMessage mints the turn's
	// traceId, so the plugin handler is the first touchpoint and must mint +
	// stamp the id itself or the DB row persists trace_id NULL and never joins
	// the file trajectory (#13871 audit).
	it("mints and persists a traceId when MESSAGE_RECEIVED arrives before message.ts stamps one", async () => {
		const handler = trajectoriesPlugin.events?.MESSAGE_RECEIVED?.[0];
		expect(typeof handler).toBe("function");

		const runtime = {
			agentId: "00000000-0000-4000-8000-000000000001",
			adapter: { db },
			getService: () => service,
			getServicesByType: () => [service],
			getRoom: async () => null,
			reportError: vi.fn(),
			logger: {
				debug() {},
				info() {},
				warn(...args: unknown[]) {
					// The handler swallows failures via logger.warn; surface them so a
					// broken insert cannot pass as green.
					throw new Error(`trajectory handler warned: ${JSON.stringify(args)}`);
				},
				error() {},
			},
		} as unknown as IAgentRuntime;

		const message = {
			id: "10000000-0000-4000-8000-00000000aaaa",
			roomId: "20000000-0000-4000-8000-00000000bbbb",
			entityId: "30000000-0000-4000-8000-00000000cccc",
			content: { text: "hello", source: "api" },
			// No metadata: mirrors chat-routes.ts emitting before any stamp exists.
		} as unknown as Memory;

		await handler?.({ runtime, message, source: "api" } as MessagePayload);

		const meta = message.metadata as {
			traceId?: string;
			trajectoryId?: string;
		};
		expect(typeof meta.traceId).toBe("string");
		expect((meta.traceId ?? "").length).toBeGreaterThan(0);
		expect(typeof meta.trajectoryId).toBe("string");

		const rows = await raw(
			`SELECT trace_id, metadata_json FROM trajectories WHERE id = '${meta.trajectoryId}'`,
		);
		expect(rows.length).toBe(1);
		expect(rows[0]?.trace_id).toBe(meta.traceId);
	});

	it("round-trips a native actionless step through the owner read route", async () => {
		const trajectoryId = await service.startTrajectory(serviceRuntime.agentId, {
			source: "native-actionless",
			metadata: { roomId: "actionless-room" },
		});
		service.startStep(trajectoryId, { timestamp: Date.now() });
		await service.flushWriteQueue(trajectoryId);
		await service.endTrajectory(trajectoryId, "completed");

		const routeRuntime = {
			...serviceRuntime,
			getService: (type: string) => (type === "trajectories" ? service : null),
		} as IAgentRuntime;
		const response = await readDetailRoute(routeRuntime, trajectoryId);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			trajectory: { id: trajectoryId, status: "completed" },
			toolEvents: [],
		});
	});

	it("rejects late native capture and keeps stop permanently inert", async () => {
		const harness = await makeFaultService(
			"00000000-0000-4000-8000-000000000101",
		);
		const trajectoryId = await harness.service.startTrajectory(
			harness.runtime.agentId,
			{ source: "native-late" },
		);
		const stepId = harness.service.startStep(trajectoryId, {
			timestamp: Date.now(),
		});
		await harness.service.flushWriteQueue(trajectoryId);
		harness.service.logLlmCall({
			stepId,
			model: "native-before-end",
			systemPrompt: "system",
			userPrompt: "prompt",
			response: "response",
			purpose: "action",
		});
		await harness.service.flushWriteQueue(trajectoryId);
		await harness.service.endTrajectory(trajectoryId, "completed");

		// Immediate post-delivery captures are allowed; this test owns rejection
		// after that grace window, both in memory and after a service reload.
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
		try {
			harness.service.logLlmCall({
				stepId,
				model: "native-after-end",
				systemPrompt: "system",
				userPrompt: "prompt",
				response: "must be rejected",
				purpose: "action",
			});
			harness.service.logProviderAccess(stepId, {
				providerName: "native-after-end-provider",
				data: {},
				purpose: "context",
			});
			await harness.service.flushWriteQueue(trajectoryId);
			const completed = await harness.service.getTrajectoryDetail(trajectoryId);
			expect(completed?.metrics.finalStatus).toBe("completed");
			expect(completed?.steps.flatMap((step) => step.llmCalls)).toHaveLength(1);
			expect(completed?.steps.flatMap((step) => step.providerAccesses)).toEqual(
				[],
			);
			expect(
				(
					harness.runtime.reportError as ReturnType<typeof vi.fn>
				).mock.calls.filter(
					([scope, , context]) =>
						scope === "TrajectoriesService.lateCapture" &&
						(context as { diagnosticOnly?: boolean }).diagnosticOnly === true,
				),
			).toHaveLength(2);

			const reloaded = await makeFaultService(harness.runtime.agentId);
			reloaded.service.logLlmCall({
				stepId,
				model: "native-after-reload",
				systemPrompt: "system",
				userPrompt: "prompt",
				response: "must still be rejected",
				purpose: "action",
			});
			reloaded.service.logProviderAccess(stepId, {
				providerName: "native-after-reload-provider",
				data: {},
				purpose: "context",
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			await reloaded.service.flushWriteQueue(trajectoryId);
			expect(
				(
					reloaded.runtime.reportError as ReturnType<typeof vi.fn>
				).mock.calls.filter(
					([scope, , context]) =>
						scope === "TrajectoriesService.lateCapture" &&
						(context as { diagnosticOnly?: boolean }).diagnosticOnly === true,
				),
			).toHaveLength(2);
			const afterReloadCapture =
				await reloaded.service.getTrajectoryDetail(trajectoryId);
			expect(
				afterReloadCapture?.steps.flatMap((step) => step.llmCalls),
			).toHaveLength(1);
			expect(
				afterReloadCapture?.steps.flatMap((step) => step.providerAccesses),
			).toEqual([]);

			await harness.service.stop();
			const rowsBefore = await raw(
				`SELECT count(*)::int AS total FROM trajectories WHERE agent_id = '${harness.runtime.agentId}'`,
			);
			const inertId = await harness.service.startTrajectory(
				harness.runtime.agentId,
				{ source: "native-after-stop" },
			);
			harness.service.startStep(inertId, { timestamp: Date.now() });
			harness.service.logLlmCall({
				stepId,
				model: "native-after-stop",
				systemPrompt: "system",
				userPrompt: "prompt",
				response: "must remain inert",
				purpose: "action",
			});
			await harness.service.flushWriteQueue(inertId);
			const rowsAfter = await raw(
				`SELECT count(*)::int AS total FROM trajectories WHERE agent_id = '${harness.runtime.agentId}'`,
			);
			expect(rowsAfter[0]?.total).toBe(rowsBefore[0]?.total);
			expect(harness.service.isEnabled()).toBe(false);
		} finally {
			clock.mockRestore();
		}
	});

	it("drains cache-miss capture and terminal lookup before native stop", async () => {
		const creator = await makeFaultService(
			"00000000-0000-4000-8000-000000000102",
		);
		const trajectoryId = await creator.service.startTrajectory(
			creator.runtime.agentId,
			{ source: "native-delayed-stop" },
		);
		const stepId = creator.service.startStep(trajectoryId, {
			timestamp: Date.now(),
		});
		await creator.service.flushWriteQueue(trajectoryId);

		const delayed = await makeDelayedLookupService(creator.runtime.agentId, 2);
		const [llmGate, providerGate] = delayed.gates;
		if (!llmGate || !providerGate) throw new Error("Missing lookup gates");
		delayed.enableDelays();
		delayed.service.logLlmCall({
			stepId,
			model: "native-delayed-llm",
			systemPrompt: "system",
			userPrompt: "prompt",
			response: "captured before stop",
			purpose: "action",
		});
		delayed.service.logProviderAccess(stepId, {
			providerName: "native-delayed-provider",
			data: {},
			purpose: "context",
		});
		await Promise.all([llmGate.entered, providerGate.entered]);

		let stopSettled = false;
		const stopPromise = delayed.service.stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		expect(stopSettled).toBe(false);
		llmGate.release();
		await Promise.resolve();
		expect(stopSettled).toBe(false);
		providerGate.release();
		await stopPromise;

		const captured = await creator.service.getTrajectoryDetail(trajectoryId);
		expect(captured?.steps.flatMap((step) => step.llmCalls)).toEqual([
			expect.objectContaining({ model: "native-delayed-llm" }),
		]);
		expect(captured?.steps.flatMap((step) => step.providerAccesses)).toEqual([
			expect.objectContaining({ providerName: "native-delayed-provider" }),
		]);
		delayed.service.logLlmCall({
			stepId,
			model: "native-after-delayed-stop",
			systemPrompt: "system",
			userPrompt: "prompt",
			response: "must remain inert",
			purpose: "action",
		});
		expect(delayed.service.isEnabled()).toBe(false);

		const terminalTrajectoryId = await creator.service.startTrajectory(
			creator.runtime.agentId,
			{ source: "native-delayed-end" },
		);
		const terminalStepId = creator.service.startStep(terminalTrajectoryId, {
			timestamp: Date.now(),
		});
		await creator.service.flushWriteQueue(terminalTrajectoryId);
		const delayedEnd = await makeDelayedLookupService(
			creator.runtime.agentId,
			1,
		);
		const [endGate] = delayedEnd.gates;
		if (!endGate) throw new Error("Missing terminal lookup gate");
		delayedEnd.enableDelays();
		const endPromise = delayedEnd.service.endTrajectory(
			terminalStepId,
			"completed",
		);
		await endGate.entered;
		let endStopSettled = false;
		const endStopPromise = delayedEnd.service.stop().then(() => {
			endStopSettled = true;
		});
		await Promise.resolve();
		expect(endStopSettled).toBe(false);
		endGate.release();
		await Promise.all([endPromise, endStopPromise]);
		const terminal =
			await creator.service.getTrajectoryDetail(terminalTrajectoryId);
		expect(terminal?.metrics.finalStatus).toBe("completed");
		expect(endStopSettled).toBe(true);
	});

	it("rolls back every native lifecycle transaction statement", async () => {
		const harness = await makeFaultService(
			"00000000-0000-4000-8000-000000000201",
		);

		for (let failAt = 1; failAt <= 3; failAt += 1) {
			const source = `legacy-start-fault-${failAt}`;
			harness.fault.failAt = failAt;
			await expect(
				harness.service.startTrajectory(`legacy-step-${failAt}`, {
					agentId: harness.runtime.agentId,
					source,
				}),
			).rejects.toMatchObject({ code: "TRAJECTORY_START_PERSIST_FAILED" });
			harness.fault.failAt = null;
			expect(
				await raw(`SELECT id FROM trajectories WHERE source = '${source}'`),
			).toEqual([]);
		}

		for (let failAt = 1; failAt <= 5; failAt += 1) {
			const trajectoryId = await harness.service.startTrajectory(
				harness.runtime.agentId,
				{ source: `start-step-fault-${failAt}` },
			);
			harness.fault.failAt = failAt;
			const failedStepId = harness.service.startStep(trajectoryId, {
				timestamp: Date.now(),
			});
			await expect(
				harness.service.flushWriteQueue(trajectoryId),
			).rejects.toThrow(`injected transaction statement ${failAt}`);
			harness.fault.failAt = null;
			const detail = await harness.service.getTrajectoryDetail(trajectoryId);
			expect(detail?.steps).toEqual([]);
			expect(
				await raw(
					`SELECT step_id FROM trajectory_step_index WHERE step_id = '${failedStepId}'`,
				),
			).toEqual([]);
			await harness.service.deleteTrajectories([trajectoryId]);
		}

		for (let failAt = 1; failAt <= 4; failAt += 1) {
			const trajectoryId = await harness.service.startTrajectory(
				harness.runtime.agentId,
				{ source: `complete-step-fault-${failAt}` },
			);
			const stepId = harness.service.startStep(trajectoryId, {
				timestamp: Date.now(),
			});
			await harness.service.flushWriteQueue(trajectoryId);
			harness.fault.failAt = failAt;
			harness.service.completeStep(trajectoryId, stepId, {
				actionType: "TEST_ACTION",
				actionName: "TEST_ACTION",
				parameters: {},
				success: true,
				result: { settled: true },
			});
			await expect(
				harness.service.flushWriteQueue(trajectoryId),
			).rejects.toThrow(`injected transaction statement ${failAt}`);
			harness.fault.failAt = null;
			const detail = await harness.service.getTrajectoryDetail(trajectoryId);
			expect(detail?.steps[0]?.action).toBeUndefined();
			const indexRows = await raw(
				`SELECT is_active FROM trajectory_step_index WHERE step_id = '${stepId}'`,
			);
			expect(indexRows[0]?.is_active).toBe(true);
			if (failAt === 4) {
				harness.service.completeStep(trajectoryId, stepId, {
					actionType: "TEST_ACTION",
					actionName: "TEST_ACTION",
					parameters: {},
					success: true,
					result: { settled: true },
				});
				await harness.service.flushWriteQueue(trajectoryId);
				const retriedDetail =
					await harness.service.getTrajectoryDetail(trajectoryId);
				expect(retriedDetail?.steps).toHaveLength(1);
				expect(retriedDetail?.steps[0]?.action).toMatchObject({
					success: true,
					result: { settled: true },
				});
				const retriedIndexRows = await raw(
					`SELECT is_active FROM trajectory_step_index WHERE step_id = '${stepId}'`,
				);
				expect(retriedIndexRows[0]?.is_active).toBe(false);
			}
			await harness.service.deleteTrajectories([trajectoryId]);
		}

		for (let failAt = 1; failAt <= 3; failAt += 1) {
			const trajectoryId = await harness.service.startTrajectory(
				harness.runtime.agentId,
				{ source: `end-fault-${failAt}` },
			);
			const stepId = harness.service.startStep(trajectoryId, {
				timestamp: Date.now(),
			});
			await harness.service.flushWriteQueue(trajectoryId);
			harness.fault.failAt = failAt;
			await expect(
				harness.service.endTrajectory(trajectoryId, "completed"),
			).rejects.toThrow(`injected transaction statement ${failAt}`);
			harness.fault.failAt = null;
			const parentRows = await raw(
				`SELECT status, end_time, duration_ms FROM trajectories WHERE id = '${trajectoryId}'`,
			);
			expect(parentRows[0]).toMatchObject({
				status: "active",
				end_time: null,
				duration_ms: null,
			});
			const indexRows = await raw(
				`SELECT is_active FROM trajectory_step_index WHERE step_id = '${stepId}'`,
			);
			expect(indexRows[0]?.is_active).toBe(true);
			await harness.service.deleteTrajectories([trajectoryId]);
		}
	});

	it("terminalizes a durable MESSAGE_RECEIVED parent after child persistence fails", async () => {
		const harness = await makeFaultService(
			"00000000-0000-4000-8000-000000000301",
		);
		Object.assign(harness.runtime as unknown as Record<string, unknown>, {
			getService: (type: string) =>
				type === "trajectories" ? harness.service : null,
			getServicesByType: (type: string) =>
				type === "trajectories" ? [harness.service] : [],
			getRoom: async () => null,
		});
		const handler = trajectoriesPlugin.events?.MESSAGE_RECEIVED?.[0];
		expect(typeof handler).toBe("function");
		const messageId = "10000000-0000-4000-8000-00000000f301";
		const message = {
			id: messageId,
			agentId: harness.runtime.agentId,
			roomId: "20000000-0000-4000-8000-00000000f301",
			entityId: "30000000-0000-4000-8000-00000000f301",
			createdAt: Date.now(),
			content: { text: "partial trajectory start", source: "partial-start" },
		} as unknown as Memory;
		harness.fault.failAt = 5;
		await handler?.({
			runtime: harness.runtime,
			message,
			source: "partial-start",
		} as MessagePayload);
		harness.fault.failAt = null;

		const rows = await raw(
			`SELECT id, status, end_time, duration_ms FROM trajectories
			 WHERE agent_id = '${harness.runtime.agentId}' AND source = 'partial-start'`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("error");
		expect(typeof rows[0]?.end_time).toBe("number");
		expect(typeof rows[0]?.duration_ms).toBe("number");
		expect(
			(message.metadata as Record<string, unknown>).trajectoryId,
		).toBeUndefined();
		expect(harness.service.getCurrentStepId(String(rows[0]?.id))).toBeNull();

		const endHandler = trajectoriesPlugin.events?.RUN_ENDED?.[0];
		await endHandler?.({
			runtime: harness.runtime,
			messageId,
			status: "completed",
		});
		const afterTerminal = await raw(
			`SELECT status FROM trajectories WHERE id = '${rows[0]?.id}'`,
		);
		expect(afterTerminal[0]?.status).toBe("error");
	});

	it("rejects cross-agent starts before insert for both public signatures", async () => {
		const countBefore = await raw(
			`SELECT count(*)::int AS total FROM trajectories WHERE agent_id = 'foreign-agent'`,
		);
		await expect(
			service.startTrajectory("foreign-agent", { source: "forged-modern" }),
		).rejects.toMatchObject({
			code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
		});
		await expect(
			service.startTrajectory("forged-legacy-step", {
				agentId: "foreign-agent",
				source: "forged-legacy",
			}),
		).rejects.toMatchObject({
			code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
		});
		const countAfter = await raw(
			`SELECT count(*)::int AS total FROM trajectories WHERE agent_id = 'foreign-agent'`,
		);
		expect(countAfter[0]?.total).toBe(countBefore[0]?.total);
	});

	it("strictly rejects malformed actions and active or terminal timing", async () => {
		const assertAllReadSurfacesReject = async (
			trajectoryId: string,
		): Promise<void> => {
			await expect(
				service.listTrajectories({ search: trajectoryId, limit: 10 }),
			).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
			await expect(
				service.getTrajectoryDetail(trajectoryId),
			).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
			await expect(
				service.exportTrajectories({
					format: "jsonl",
					trajectoryIds: [trajectoryId],
				}),
			).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
		};

		const malformedActionId = await service.startTrajectory(
			serviceRuntime.agentId,
			{ source: "malformed-native-action" },
		);
		service.startStep(malformedActionId, { timestamp: Date.now() });
		await service.flushWriteQueue(malformedActionId);
		await service.endTrajectory(malformedActionId, "completed");
		const malformedActionRows = await raw(
			`SELECT steps_json FROM trajectories WHERE id = '${malformedActionId}'`,
		);
		const malformedSteps = malformedActionRows[0]?.steps_json as Array<
			Record<string, unknown>
		>;
		malformedSteps[0].action = {
			timestamp: Date.now(),
			actionType: "BROKEN",
			actionName: "BROKEN",
			parameters: {},
			success: false,
		};
		const malformedJson = JSON.stringify(malformedSteps).replaceAll("'", "''");
		await raw(
			`UPDATE trajectories SET steps_json = '${malformedJson}'::jsonb WHERE id = '${malformedActionId}'`,
		);
		await assertAllReadSurfacesReject(malformedActionId);

		const malformedActiveId = await service.startTrajectory(
			serviceRuntime.agentId,
			{ source: "malformed-active-timing" },
		);
		const activeEnd = Date.now();
		await raw(
			`UPDATE trajectories SET end_time = ${activeEnd}, duration_ms = 0 WHERE id = '${malformedActiveId}'`,
		);
		await assertAllReadSurfacesReject(malformedActiveId);

		const malformedTerminalId = await service.startTrajectory(
			serviceRuntime.agentId,
			{ source: "malformed-terminal-timing" },
		);
		await service.endTrajectory(malformedTerminalId, "completed");
		await raw(
			`UPDATE trajectories SET duration_ms = NULL WHERE id = '${malformedTerminalId}'`,
		);
		await assertAllReadSurfacesReject(malformedTerminalId);
	});
});
