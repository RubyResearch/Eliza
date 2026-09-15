/**
 * Unit coverage for the owner-side trajectory viewer read routes
 * (`tryHandleTrajectoryReadRoutes`): path/method gating, the list/detail/stats
 * UI wire shapes (including the timeout→error status collapse and step→phase
 * flattening), search-param forwarding, opt-in room-context resolution, and the
 * service-absent empty-200 fallback. The `ServerResponse` and runtime/service
 * are hand-rolled fakes — deterministic, no HTTP server or database.
 */
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { tryHandleTrajectoryReadRoutes } from "./read-routes";

// Minimal ServerResponse capture — records statusCode + parsed JSON body.
function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; body: unknown };
} {
	const state = { status: 0, body: undefined as unknown, ended: false };
	const res = {
		statusCode: 0,
		setHeader() {},
		end(payload?: string) {
			state.status = (this as { statusCode: number }).statusCode;
			state.body = payload ? JSON.parse(payload) : undefined;
			state.ended = true;
		},
	} as unknown as ServerResponse;
	return { res, get: () => ({ status: state.status, body: state.body }) };
}

function runtimeWith(
	service: unknown,
	rooms: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		getService: (type: string) => (type === "trajectories" ? service : null),
		getRoom: async (id: string) => rooms[id] ?? null,
	} as unknown as IAgentRuntime;
}

const url = (p: string) => new URL(`http://localhost${p}`);

describe("tryHandleTrajectoryReadRoutes", () => {
	it("ignores non-trajectory paths and non-GET methods", async () => {
		const { res } = mockRes();
		expect(
			await tryHandleTrajectoryReadRoutes({
				pathname: "/api/health",
				method: "GET",
				url: url("/api/health"),
				runtime: runtimeWith({}),
				res,
			}),
		).toBe(false);
		expect(
			await tryHandleTrajectoryReadRoutes({
				pathname: "/api/trajectories",
				method: "DELETE",
				url: url("/api/trajectories"),
				runtime: runtimeWith({}),
				res,
			}),
		).toBe(false);
	});

	it("lists trajectories from the core service (UI shape, timeout→error)", async () => {
		const service = {
			listTrajectories: async () => ({
				trajectories: [
					{
						id: "t1",
						status: "completed",
						llmCallCount: 3,
						totalPromptTokens: 120,
						totalCompletionTokens: 0,
						source: "discord",
						roomId: "room-1",
						entityId: "entity-1",
						metadata: { roomId: "room-1", entityId: "entity-1" },
					},
					{ id: "t2", status: "timeout", llmCallCount: 1 },
				],
				total: 2,
			}),
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?limit=10"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		const { status, body } = get();
		expect(status).toBe(200);
		const b = body as {
			trajectories: Array<Record<string, unknown>>;
			total: number;
		};
		expect(b.total).toBe(2);
		expect(b.trajectories[0]).toMatchObject({
			id: "t1",
			status: "completed",
			llmCallCount: 3,
			totalPromptTokens: 120,
			totalCompletionTokens: 0,
		});
		// timeout collapses to the viewer's tri-state "error"
		expect(b.trajectories[1]).toMatchObject({ id: "t2", status: "error" });
	});

	it("normalizes trajectory pagination before forwarding it", async () => {
		let receivedLimit: number | undefined;
		let receivedOffset: number | undefined;
		const service = {
			listTrajectories: async (options: {
				limit?: number;
				offset?: number;
			}) => {
				receivedLimit = options.limit;
				receivedOffset = options.offset;
				return { trajectories: [], total: 0 };
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?limit=1.5&offset=Infinity"),
			runtime: runtimeWith(service),
			res,
		});

		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(receivedLimit).toBe(1);
		expect(receivedOffset).toBe(0);
	});

	it("forwards the search param to the SQL reader so only matches return", async () => {
		const rows = [
			{ id: "match-1", status: "completed", llmCallCount: 1 },
			{ id: "other-1", status: "completed", llmCallCount: 1 },
			{ id: "match-2", status: "completed", llmCallCount: 1 },
		];
		let receivedSearch: string | undefined;
		const service = {
			listTrajectories: async (options: { search?: string }) => {
				receivedSearch = options.search;
				// Emulate the SQL reader: filter + count by the search needle.
				const matched = options.search
					? rows.filter((r) => r.id.includes(options.search as string))
					: rows;
				return { trajectories: matched, total: matched.length };
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?search=match&limit=10"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		// search is threaded through to the service
		expect(receivedSearch).toBe("match");
		const { status, body } = get();
		expect(status).toBe(200);
		const b = body as {
			trajectories: Array<{ id: string }>;
			total: number;
		};
		// only matching rows return; total reflects the filtered count
		expect(b.trajectories.map((t) => t.id)).toEqual(["match-1", "match-2"]);
		expect(b.total).toBe(2);
	});

	it("maps detail steps into phase-classified llmCalls / providerAccesses / toolEvents", async () => {
		const messages = [{ role: "user", content: "  complete input\n" }];
		const tools = [{ name: "REPLY", description: "Full tool definition" }];
		const providerData = { text: "  full provider context\n", cacheHit: false };
		const providerQuery = { message: "Find the corrected workout" };
		const result = { receipt: { kind: "preview", persisted: false } };
		const service = {
			getTrajectoryDetail: async (id: string) => ({
				trajectoryId: id,
				agentId: "agent-1",
				startTime: 500,
				endTime: 1000,
				metrics: { finalStatus: "completed" },
				metadata: { source: "discord", roomId: "room-1", entityId: "entity-1" },
				steps: [
					{
						stepId: "s0",
						semanticStages: [
							{
								schemaVersion: 1,
								stageId: "search-1",
								kind: "toolSearch",
								startedAt: 501,
								endedAt: 503,
								latencyMs: 2,
								payload: {
									toolSearch: {
										query: { candidateActions: ["REPLY"] },
										results: [{ name: "REPLY", rank: 1, score: 1 }],
									},
								},
							},
						],
						llmCalls: [
							{
								callId: "c0",
								timestamp: 501,
								systemPrompt: "system context",
								userPrompt: "user question",
								promptTokens: 12,
								completionTokens: 0,
								latencyMs: 80,
								model: "m",
								response: "RESPOND",
								messages,
								tools,
								finishReason: "tool_calls",
								tokenUsageEstimated: true,
								stepType: "should_respond",
							},
							{
								callId: "c1",
								model: "m",
								response: "plan",
								stepType: "reasoning",
							},
						],
						providerAccesses: [
							{
								providerId: "p0",
								providerName: "facts",
								purpose: "ctx",
								data: providerData,
								query: providerQuery,
								startedAt: 501,
								endedAt: 505,
								durationMs: 4,
							},
						],
						action: {
							attemptId: "a0",
							actionType: "REPLY",
							actionName: "REPLY",
							success: true,
							parameters: { text: "Preview only" },
							result,
						},
					},
				],
			}),
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/abc",
			method: "GET",
			url: url("/api/trajectories/abc"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		const { status, body } = get();
		expect(status).toBe(200);
		const b = body as {
			trajectory: {
				id: string;
				status: string;
				source: string;
				roomId: string;
				entityId: string;
				metadata: Record<string, unknown>;
				llmCallCount: number;
			};
			llmCalls: Array<{ stepType: string }>;
			providerAccesses: unknown[];
			toolEvents: Array<{ actionName: string; success: boolean }>;
			semanticStages: Array<{
				stageId: string;
				payload: Record<string, unknown>;
			}>;
		};
		expect(b.trajectory).toMatchObject({
			id: "abc",
			status: "completed",
			source: "discord",
			roomId: "room-1",
			entityId: "entity-1",
			metadata: { source: "discord", roomId: "room-1", entityId: "entity-1" },
			llmCallCount: 2,
		});
		expect(b.llmCalls[0]).toMatchObject({
			stepId: "s0",
			timestamp: 501,
			systemPrompt: "system context",
			userPrompt: "user question",
			promptTokens: 12,
			completionTokens: 0,
			latencyMs: 80,
			messages,
			tools,
			finishReason: "tool_calls",
			tokenUsageEstimated: true,
		});
		expect(b.llmCalls[1]).not.toHaveProperty("promptTokens");
		expect(b.llmCalls.map((c) => c.stepType)).toEqual([
			"should_respond",
			"reasoning",
		]);
		expect(b.providerAccesses).toHaveLength(1);
		expect(b.providerAccesses[0]).toMatchObject({
			id: "p0",
			stepId: "s0",
			trajectoryId: "abc",
			data: providerData,
			query: providerQuery,
			startedAt: 501,
			endedAt: 505,
			durationMs: 4,
		});
		expect(b.toolEvents[0]).toMatchObject({
			actionName: "REPLY",
			success: true,
			type: "tool_result",
			parameters: { text: "Preview only" },
			args: { text: "Preview only" },
			result,
		});
		expect(b.semanticStages).toMatchObject([
			{
				stageId: "search-1",
				payload: {
					toolSearch: {
						query: { candidateActions: ["REPLY"] },
						results: [{ name: "REPLY", rank: 1 }],
					},
				},
			},
		]);
		const compactResponse = mockRes();
		await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/abc",
			method: "GET",
			url: url("/api/trajectories/abc?includePayloads=0"),
			runtime: runtimeWith(service),
			res: compactResponse.res,
		});
		const compact = compactResponse.get().body as {
			payloadsIncluded: boolean;
			llmCalls: Record<string, unknown>[];
			providerAccesses: Record<string, unknown>[];
			toolEvents: Record<string, unknown>[];
			semanticStages: Array<{
				stageId: string;
				payload: unknown;
				latencyMs: number;
			}>;
		};
		expect(compact.payloadsIncluded).toBe(false);
		expect(compact.llmCalls[0]).toMatchObject({
			promptTokens: 12,
			completionTokens: 0,
			latencyMs: 80,
		});
		expect(compact.llmCalls[1]).not.toHaveProperty("promptTokens");
		for (const call of compact.llmCalls) {
			expect(call).not.toHaveProperty("systemPrompt");
			expect(call).not.toHaveProperty("userPrompt");
			expect(call).not.toHaveProperty("response");
			expect(call).not.toHaveProperty("messages");
			expect(call).not.toHaveProperty("tools");
		}
		expect(compact.providerAccesses[0]).toMatchObject({ durationMs: 4 });
		expect(compact.providerAccesses[0]).not.toHaveProperty("data");
		expect(compact.providerAccesses[0]).not.toHaveProperty("query");
		expect(compact.toolEvents[0]).not.toHaveProperty("parameters");
		expect(compact.toolEvents[0]).not.toHaveProperty("result");
		expect(compact.semanticStages).toMatchObject([
			{ stageId: "search-1", latencyMs: 2, payload: {} },
		]);
		const fullAgain = mockRes();
		await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/abc",
			method: "GET",
			url: url("/api/trajectories/abc"),
			runtime: runtimeWith(service),
			res: fullAgain.res,
		});
		expect(fullAgain.get().body).toEqual(body);
	});

	it("returns LLM-only detail without fabricating a tool event", async () => {
		const service = {
			getTrajectoryDetail: async (id: string) => ({
				trajectoryId: id,
				agentId: "agent-1",
				startTime: 500,
				endTime: 1000,
				metrics: { episodeLength: 1, finalStatus: "completed" },
				metadata: { source: "chat" },
				steps: [
					{
						stepId: "s0",
						llmCalls: [
							{
								callId: "c0",
								model: "m",
								response: "hello",
								stepType: "reasoning",
								provider: "openai",
							},
						],
						providerAccesses: [],
						// Agent bridge action-optional step — no action field.
					},
				],
			}),
		};
		const { res, get } = mockRes();

		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/llm-only",
			method: "GET",
			url: url("/api/trajectories/llm-only"),
			runtime: runtimeWith(service),
			res,
		});

		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(get().body).toMatchObject({
			trajectory: { id: "llm-only", status: "completed", llmCallCount: 1 },
			llmCalls: [{ id: "c0", response: "hello" }],
			toolEvents: [],
		});
	});

	it("resolves room context only when requested", async () => {
		const service = {
			listTrajectories: async () => ({
				trajectories: [
					{
						id: "t1",
						status: "completed",
						llmCallCount: 1,
						metadata: { roomId: "room-1" },
					},
				],
				total: 1,
			}),
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?resolve=1"),
			runtime: runtimeWith(service, {
				"room-1": {
					id: "room-1",
					name: "ruby-trivia",
					type: "GROUP",
					worldId: "world-1",
					serverId: "guild-1",
				},
			}),
			res,
		});
		expect(handled).toBe(true);
		const rows = (
			get().body as { trajectories: Array<Record<string, unknown>> }
		).trajectories;
		expect(rows[0].roomContext).toEqual({
			id: "room-1",
			name: "ruby-trivia",
			type: "GROUP",
			worldId: "world-1",
			serverId: "guild-1",
		});
	});

	it("404s an unknown detail id", async () => {
		const service = { getTrajectoryDetail: async () => null };
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/missing",
			method: "GET",
			url: url("/api/trajectories/missing"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(404);
	});

	it("returns an unavailable error when the service is absent", async () => {
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories"),
			runtime: runtimeWith(null),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(503);
		expect(get().body).toEqual({ error: "Trajectory service unavailable" });
	});

	it("does not treat /stats or /config as a detail id", async () => {
		const service = {
			getStats: async () => ({ totalTrajectories: 5 }),
			getTrajectoryDetail: async () => {
				throw new Error("should not be called for /stats");
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/stats",
			method: "GET",
			url: url("/api/trajectories/stats"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(get().body).toMatchObject({ totalTrajectories: 5 });
	});
});
