/**
 * Runs managed incremental evaluation through the real service and memory adapter.
 * Only the external model is substituted: retained history, source revisions,
 * durable output replay and processor-failure reporting use production code.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { factMemoryEvaluator } from "../features/advanced-capabilities/evaluators/reflection-items";
import { AgentRuntime } from "../runtime";
import type { Evaluator, Memory, State } from "../types";
import { stringToUuid } from "../utils";
import { EvaluatorService } from "./evaluator";

function harness() {
	const runtime = new AgentRuntime({
		character: { name: "IncrementalEvaluator", bio: "test" },
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.emitEvent = vi.fn(async () => {});
	const roomId = stringToUuid("incremental-room");
	const entityId = stringToUuid("incremental-speaker");
	const addMessage = async (text: string, sequence: number) => {
		const memory: Memory = {
			id: stringToUuid(`incremental-message-${sequence}`),
			agentId: runtime.agentId,
			roomId,
			entityId,
			createdAt: 1_000 + sequence,
			content: { text, source: "test" },
		};
		await runtime.createMemory(memory, "messages");
		return memory;
	};
	return {
		runtime,
		roomId,
		addMessage,
		service: new EvaluatorService(runtime),
	};
}

describe("managed incremental evaluators", () => {
	it.each(["model", "runtime"])(
		"replays a staged null %s section exactly when its parser accepts it",
		async (source) => {
			const { runtime, service, addMessage } = harness();
			let fail = true;
			const resolveOutput = vi.fn(() => null);
			runtime.registerEvaluator({
				name: "nullable",
				...(source === "runtime" ? { resolveOutput } : {}),
				description: "Null is an accepted wire value",
				incremental: true,
				schema: { type: ["object", "null"] },
				shouldRun: async () => true,
				prompt: () => "Return null",
				parse: (raw) => (raw === null ? {} : null),
				processors: [
					{
						process: async () => {
							if (fail) throw new Error("injected write failure");
						},
					},
				],
			});
			runtime.useModel = vi.fn(async () => ({
				nullable: null,
			})) as AgentRuntime["useModel"];
			const message = await addMessage("Evidence", 1);
			expect(
				(await service.run(message, undefined, { phase: "post_turn" })).errors,
			).toHaveLength(1);
			fail = false;
			const retried = await service.run(structuredClone(message), undefined, {
				phase: "post_turn",
			});
			expect(retried.errors).toEqual([]);
			expect(retried.processedEvaluators).toEqual(["nullable"]);
			expect(runtime.useModel).toHaveBeenCalledTimes(
				source === "runtime" ? 0 : 1,
			);
			expect(resolveOutput).toHaveBeenCalledTimes(source === "runtime" ? 1 : 0);
		},
	);

	it("keeps an unrelated extractor working when another saved batch becomes stale", async () => {
		const { runtime, service, addMessage } = harness();
		const evaluator: Evaluator = {
			name: "stale",
			description: "Interrupted work",
			incremental: true,
			schema: { type: "object", properties: {} },
			shouldRun: async () => true,
			prompt: () => "Evaluate",
			processors: [
				{
					process: async () => {
						throw new Error("injected failure");
					},
				},
			],
		};
		runtime.registerEvaluator(evaluator);
		runtime.useModel = vi.fn(async () => ({
			stale: {},
			healthy: {},
		})) as AgentRuntime["useModel"];
		const first = await addMessage("Original evidence", 1);
		await service.run(first, undefined, { phase: "post_turn" });
		if (!first.id) throw new Error("Expected persisted source ID");
		await runtime.updateMemory({
			id: first.id,
			content: { ...first.content, text: "Edited evidence" },
		});
		runtime.registerEvaluator({
			...evaluator,
			name: "healthy",
			processors: [],
		});
		const second = await addMessage("New evidence", 2);
		const result = await service.run(second, undefined, { phase: "post_turn" });
		expect(result.processedEvaluators).toEqual(["healthy"]);
		expect(result.errors).toEqual([
			expect.objectContaining({ evaluatorName: "stale" }),
		]);
	});

	it("rejects ungrounded model output before journaling so a later valid response can recover", async () => {
		const { runtime, service, addMessage } = harness();
		runtime.registerEvaluator(factMemoryEvaluator);
		const message = await addMessage("My project is amber.", 1);
		runtime.useModel = vi.fn(async () => ({
			factMemory: {
				ops: [
					{
						op: "add_current",
						claim: "My project is amber.",
						category: "working_on",
					},
				],
			},
		})) as AgentRuntime["useModel"];
		const rejected = await service.run(message, undefined, {
			phase: "post_turn",
			semanticSignal: true,
		});
		expect(rejected.processedEvaluators).toEqual([]);
		expect(rejected.errors).toHaveLength(1);
		runtime.useModel = vi.fn(async () => ({
			factMemory: { ops: [] },
		})) as AgentRuntime["useModel"];
		const recovered = await service.run(structuredClone(message), undefined, {
			phase: "post_turn",
			semanticSignal: true,
		});
		expect(recovered.processedEvaluators).toEqual(["factMemory"]);
		expect(recovered.errors).toEqual([]);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("backfills once, sends all new evidence next, and preserves the complete stored conversation", async () => {
		const { runtime, roomId, service, addMessage } = harness();
		runtime.registerEvaluator(factMemoryEvaluator);
		const old = await addMessage("Historical message HISTORICAL_CANARY", 1);
		if (!old.id) throw new Error("Expected source ID");
		await runtime.updateMemory({
			id: old.id,
			content: {
				...old.content,
				chatIdempotency: { outcome: "TRANSPORT_ACK_CANARY".repeat(15_000) },
			},
		});
		runtime.useModel = vi.fn(async () => ({
			factMemory: { ops: [] },
		})) as AgentRuntime["useModel"];
		const state: State = {
			text: "STALE_PROVIDER_TRANSCRIPT",
			values: {},
			data: {},
		};
		const first = await service.run(old, state, {
			phase: "post_turn",
			semanticSignal: true,
		});
		expect(first.errors).toEqual([]);
		expect(first.processedEvaluators).toEqual(["factMemory"]);
		expect(
			vi.mocked(runtime.useModel).mock.calls[0]?.[1]?.messages?.[0]?.content,
		).toContain("HISTORICAL_CANARY");
		expect(
			vi.mocked(runtime.useModel).mock.calls[0]?.[1]?.messages?.[0]?.content,
		).not.toContain("TRANSPORT_ACK_CANARY");
		const current = await addMessage("My project is named ORANGE_CANARY.", 2);
		const second = await service.run(current, state, {
			phase: "post_turn",
			semanticSignal: true,
		});
		expect(second.errors).toEqual([]);
		const prompt = vi.mocked(runtime.useModel).mock.calls[1]?.[1]?.messages?.[0]
			?.content;
		expect(prompt).toContain("ORANGE_CANARY");
		expect(prompt).not.toContain("HISTORICAL_CANARY");
		expect(prompt).not.toContain("STALE_PROVIDER_TRANSCRIPT");
		expect(
			await runtime.getMemories({
				tableName: "messages",
				roomId,
				unique: false,
			}),
		).toHaveLength(2);
		expect(
			(await runtime.getMemoryById(old.id))?.content.chatIdempotency,
		).toEqual({
			outcome: "TRANSPORT_ACK_CANARY".repeat(15_000),
		});
		const replay = await service.run(structuredClone(current), state, {
			phase: "post_turn",
			semanticSignal: true,
		});
		expect(replay.skipped).toBe(true);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("replays the stored output against its original trigger after a processor failure", async () => {
		const { runtime, service, addMessage } = harness();
		const seen: string[] = [];
		let fail = true;
		const evaluator: Evaluator<{ ok: boolean }> = {
			name: "recoverable",
			description: "Persist a checked result",
			incremental: true,
			schema: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
			},
			shouldRun: async () => true,
			prompt: () => "Evaluate the evidence.",
			processors: [
				{
					process: async ({ message, options, output }) => {
						seen.push(
							`${message.id}:${options.extraction?.evidenceId}:${output.ok}`,
						);
						if (fail) throw new Error("injected write failure");
						return { success: true };
					},
				},
			],
		};
		runtime.registerEvaluator(evaluator);
		runtime.useModel = vi.fn(async () => ({
			recoverable: { ok: true },
		})) as AgentRuntime["useModel"];
		const original = await addMessage("First work", 1);
		const failed = await service.run(original, undefined, {
			phase: "post_turn",
		});
		expect(failed.processedEvaluators).toEqual([]);
		expect(failed.errors).toHaveLength(1);
		fail = false;
		const later = await addMessage("Later work", 2);
		const recovered = await service.run(later, undefined, {
			phase: "post_turn",
		});
		expect(recovered.errors).toEqual([]);
		expect(recovered.processedEvaluators).toEqual(["recoverable"]);
		expect(seen[1]).toBe(seen[0]);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		await service.run(structuredClone(later), undefined, {
			phase: "post_turn",
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(seen[2]).not.toBe(seen[0]);
	});

	it("shares fresh evidence once while keeping each extractor's independent checkpoint contract", async () => {
		const { runtime, service, addMessage } = harness();
		const evaluator: Evaluator = {
			name: "current",
			description: "Current checkpoint",
			incremental: true,
			schema: { type: "object", properties: {} },
			shouldRun: async () => true,
			prompt: () => "Evaluate the selected evidence.",
			processors: [],
		};
		runtime.registerEvaluator(evaluator);
		runtime.useModel = vi.fn(async () => ({
			current: {},
			backfill: {},
		})) as AgentRuntime["useModel"];
		const old = await addMessage("OLDER_SHARED_EVIDENCE", 1);
		await service.run(old, undefined, { phase: "post_turn" });
		runtime.registerEvaluator({ ...evaluator, name: "backfill" });
		const current = await addMessage("NEWER_SHARED_EVIDENCE", 2);
		const result = await service.run(current, undefined, {
			phase: "post_turn",
		});
		expect(result.errors).toEqual([]);
		expect(result.processedEvaluators).toEqual(["backfill", "current"]);
		const prompt = vi.mocked(runtime.useModel).mock.calls[1]?.[1]?.messages?.[0]
			?.content;
		expect(prompt).toContain("OLDER_SHARED_EVIDENCE");
		expect(prompt).toContain("NEWER_SHARED_EVIDENCE");
		expect(prompt).toContain(
			"### backfill\nIncremental evidence contract: process all evidence records above.",
		);
		expect(prompt).toContain(
			"### current\nIncremental evidence contract: process only the exact source IDs in evidence-set-1 defined above.",
		);
		if (typeof prompt !== "string")
			throw new Error("Expected evaluator prompt");
		expect(
			JSON.parse(prompt.match(/evidence-set-1: (\[[\s\S]*?\])/)?.[1] ?? "null"),
		).toEqual([current.id]);
		expect(prompt.match(/OLDER_SHARED_EVIDENCE/g)).toHaveLength(1);
		expect(
			prompt.match(/Attribute personal facts only to their actual speaker/g),
		).toHaveLength(1);
	});

	it("excludes replay-only evidence from a fresh extractor's prompt without changing the durable replay", async () => {
		const { runtime, roomId, service, addMessage } = harness();
		let fail = true;
		const replayed: { trigger: string | undefined; sourceIds: string[] }[] = [];
		const evaluator: Evaluator = {
			name: "current",
			description: "Current checkpoint",
			incremental: true,
			schema: { type: "object", properties: {} },
			shouldRun: async () => true,
			prompt: () => "Evaluate the selected evidence.",
			processors: [],
		};
		runtime.registerEvaluator(evaluator);
		runtime.registerEvaluator({
			...evaluator,
			name: "replay",
			processors: [
				{
					process: async ({ message, options }) => {
						replayed.push({
							trigger: message.id,
							sourceIds: Object.keys(options.extraction?.sourceRevisions ?? {}),
						});
						if (fail) throw new Error("injected write failure");
					},
				},
			],
		});
		runtime.useModel = vi.fn(async () => ({
			current: {},
			replay: {},
		})) as AgentRuntime["useModel"];
		const old = await addMessage("REPLAY_ONLY_HISTORICAL_CANARY", 1);
		const first = await service.run(old, undefined, { phase: "post_turn" });
		expect(first.processedEvaluators).toEqual(["current"]);
		expect(first.errors).toHaveLength(1);
		fail = false;
		runtime.useModel = vi.fn(async () => ({
			current: {},
		})) as AgentRuntime["useModel"];
		const current = await addMessage("FRESH_MODEL_EVIDENCE", 2);
		const result = await service.run(current, undefined, {
			phase: "post_turn",
		});
		expect(result.errors).toEqual([]);
		expect(result.processedEvaluators).toEqual(["current", "replay"]);
		const prompt = vi.mocked(runtime.useModel).mock.calls[0]?.[1]?.messages?.[0]
			?.content;
		expect(prompt).toContain("FRESH_MODEL_EVIDENCE");
		expect(prompt).not.toContain("REPLAY_ONLY_HISTORICAL_CANARY");
		expect(prompt).not.toContain("### replay");
		expect(prompt).toContain(
			"### current\nIncremental evidence contract: process all evidence records above.",
		);
		expect(replayed[1]).toEqual(replayed[0]);
		expect(replayed[1]).toEqual({ trigger: old.id, sourceIds: [old.id] });
		expect(
			await runtime.getMemories({
				tableName: "messages",
				roomId,
				unique: false,
			}),
		).toHaveLength(2);
	});

	it("excludes failed preparations from the model prompt and retains their full backfill for recovery", async () => {
		const { runtime, service, addMessage } = harness();
		let failPrepare = true;
		const evaluator: Evaluator = {
			name: "current",
			description: "Current checkpoint",
			incremental: true,
			schema: { type: "object", properties: {} },
			shouldRun: async () => true,
			prompt: () => "Evaluate the selected evidence.",
			processors: [],
		};
		runtime.registerEvaluator(evaluator);
		runtime.useModel = vi.fn(async () => ({
			current: {},
			backfill: {},
		})) as AgentRuntime["useModel"];
		const old = await addMessage("FAILED_PREPARE_HISTORICAL_CANARY", 1);
		await service.run(old, undefined, { phase: "post_turn" });
		runtime.registerEvaluator({
			...evaluator,
			name: "backfill",
			prepare: async () => {
				if (failPrepare) throw new Error("injected prepare failure");
			},
		});
		const current = await addMessage("PREPARED_FRESH_EVIDENCE", 2);
		const result = await service.run(current, undefined, {
			phase: "post_turn",
		});
		expect(result.processedEvaluators).toEqual(["current"]);
		expect(result.errors).toEqual([
			expect.objectContaining({ evaluatorName: "backfill" }),
		]);
		const prompt = vi.mocked(runtime.useModel).mock.calls[1]?.[1]?.messages?.[0]
			?.content;
		expect(prompt).toContain("PREPARED_FRESH_EVIDENCE");
		expect(prompt).not.toContain("FAILED_PREPARE_HISTORICAL_CANARY");
		expect(prompt).not.toContain("### backfill");
		failPrepare = false;
		const recovered = await service.run(structuredClone(current), undefined, {
			phase: "post_turn",
		});
		expect(recovered.errors).toEqual([]);
		expect(recovered.processedEvaluators).toEqual(["backfill"]);
		const recoveryPrompt = vi.mocked(runtime.useModel).mock.calls[2]?.[1]
			?.messages?.[0]?.content;
		expect(recoveryPrompt).toContain("FAILED_PREPARE_HISTORICAL_CANARY");
		expect(recoveryPrompt).toContain("PREPARED_FRESH_EVIDENCE");
	});

	it("a false processor result never advances progress", async () => {
		const { runtime, service, addMessage } = harness();
		let success = false;
		runtime.registerEvaluator({
			name: "falseResult",
			description: "Reject failed writes",
			incremental: true,
			schema: { type: "object", properties: {} },
			shouldRun: async () => true,
			prompt: () => "Evaluate",
			processors: [{ process: async () => ({ success }) }],
		});
		runtime.useModel = vi.fn(async () => ({
			falseResult: {},
		})) as AgentRuntime["useModel"];
		const message = await addMessage("A test", 1);
		const first = await service.run(message, undefined, { phase: "post_turn" });
		expect(first.processedEvaluators).toEqual([]);
		expect(first.errors).toHaveLength(1);
		success = true;
		const retry = await service.run(structuredClone(message), undefined, {
			phase: "post_turn",
		});
		expect(retry.errors).toEqual([]);
		expect(retry.processedEvaluators).toEqual(["falseResult"]);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
});
