/** Incremental evidence is retained until successful storage, with replay-stable IDs. */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	EvaluatorRunOptions,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { LongTermMemoryCategory } from "../types.ts";
import { longTermMemoryEvaluator } from "./memory-items.ts";

const AGENT = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM = "00000000-0000-0000-0000-000000000003" as UUID;
const message = {
	id: "00000000-0000-0000-0000-000000000004" as UUID,
	agentId: AGENT,
	entityId: ENTITY,
	roomId: ROOM,
	content: { text: "I live in Lisbon." },
	createdAt: 1,
} satisfies Memory;
const prepare = longTermMemoryEvaluator.prepare;
const process = longTermMemoryEvaluator.processors?.[0].process;
if (!prepare || !process)
	throw new Error("Missing long-term evaluator implementation");

function fixture() {
	const memoryService = {
		getConfig: () => ({
			longTermExtractionEnabled: true,
			longTermExtractionThreshold: 30,
			longTermExtractionInterval: 2,
			longTermConfidenceThreshold: 0.85,
		}),
		ensureIncrementalExtractionSupported: vi.fn(async () => undefined),
		supportsIncrementalExtraction: true,
		getLongTermMemories: vi.fn(async () => []),
		storeLongTermMemory: vi.fn(async () => ({})),
		setLastExtractionCheckpoint: vi.fn(async () => undefined),
	};
	const runtime = createMockRuntime({
		agentId: AGENT,
		getService: vi.fn(() => memoryService),
		countMemories: vi.fn(async () => 100),
		getMemories: vi.fn(async () => {
			throw new Error("Unexpected full transcript read");
		}),
	});
	const extraction: NonNullable<EvaluatorRunOptions["extraction"]> = {
		isBackfill: false,
		messages: [message],
		sourceRevisions: { [message.id]: "revision-1" },
		changedMessageIds: [],
		removedMessageIds: [],
		evidenceId: "batch-1",
	};
	const options = { extraction };
	return {
		runtime,
		memoryService,
		options,
		message,
		state: { text: "", values: {}, data: {} },
	};
}

describe("long-term incremental extraction", () => {
	it("preserves the legacy path for providers without idempotent writes", () => {
		const context = fixture();
		const selection = longTermMemoryEvaluator.incremental;
		if (typeof selection !== "function")
			throw new Error("Missing capability selection");
		expect(selection(context.runtime)).toBe(true);
		context.memoryService.supportsIncrementalExtraction = false;
		expect(selection(context.runtime)).toBe(false);
	});

	it("uses only the immutable extraction input, not the full room history", async () => {
		const context = fixture();
		const prepared = await prepare(context);
		expect(prepared.recentMessages).toEqual([message]);
		expect(context.runtime.getMemories).not.toHaveBeenCalled();
		expect(context.runtime.countMemories).not.toHaveBeenCalled();
	});

	it("keeps a skipped cadence batch pending until enough messages accumulate", async () => {
		const context = fixture();
		await expect(longTermMemoryEvaluator.shouldRun(context)).resolves.toBe(
			false,
		);
		context.options.extraction.messages.push({
			...message,
			id: "00000000-0000-0000-0000-000000000005" as UUID,
		});
		await expect(longTermMemoryEvaluator.shouldRun(context)).resolves.toBe(
			true,
		);
		expect(
			context.memoryService.setLastExtractionCheckpoint,
		).not.toHaveBeenCalled();
	});

	it("drains partial backfill pages even when each page is smaller than the extraction cadence", async () => {
		const context = fixture();
		context.options.extraction.isBackfill = true;
		await expect(longTermMemoryEvaluator.shouldRun(context)).resolves.toBe(
			true,
		);
		context.options.extraction.isBackfill = false;
		context.options.extraction.remainingSourceCount = 4;
		await expect(longTermMemoryEvaluator.shouldRun(context)).resolves.toBe(
			true,
		);
	});

	it("passes stable IDs and revisions on retry and never advances the legacy count checkpoint", async () => {
		const context = fixture();
		const prepared = await prepare(context);
		const invocation = {
			...context,
			prepared,
			evaluatorName: "longTermMemory",
			output: {
				memories: [
					{
						category: LongTermMemoryCategory.SEMANTIC,
						content: "Lives in Lisbon",
						confidence: 0.95,
						sourceMessageIds: [message.id],
					},
				],
			},
		};
		await process(invocation);
		await process(invocation);
		const calls = context.memoryService.storeLongTermMemory.mock
			.calls as unknown as Array<[{ id: string; metadata: unknown }]>;
		expect(calls[0][0].id).toBe(calls[1][0].id);
		expect(calls[0][0].metadata).toMatchObject({
			extractionEvidenceId: "batch-1",
			sourceMessageRevisions: context.options.extraction.sourceRevisions,
		});
		expect(
			context.memoryService.setLastExtractionCheckpoint,
		).not.toHaveBeenCalled();
	});

	it("propagates a partial storage failure so the durable output can be replayed", async () => {
		const context = fixture();
		const failure = new Error("memory write failed");
		context.memoryService.storeLongTermMemory.mockRejectedValueOnce(failure);
		const prepared = await prepare(context);
		await expect(
			process({
				...context,
				prepared,
				evaluatorName: "longTermMemory",
				output: {
					memories: [
						{
							category: LongTermMemoryCategory.SEMANTIC,
							content: "Lives in Lisbon",
							confidence: 0.95,
							sourceMessageIds: [message.id],
						},
					],
				},
			}),
		).rejects.toBe(failure);
		expect(
			context.memoryService.setLastExtractionCheckpoint,
		).not.toHaveBeenCalled();
	});

	it.each(["missing", "other-speaker", "unknown"] as const)(
		"rejects %s personal-memory citations before any write",
		async (kind) => {
			const context = fixture();
			const other = {
				...message,
				id: "00000000-0000-0000-0000-000000000005" as UUID,
				entityId: "00000000-0000-0000-0000-000000000006" as UUID,
				content: { text: "I live in Paris." },
			};
			context.options.extraction.messages.push(other);
			context.options.extraction.sourceRevisions[other.id] = "revision-other";
			const prepared = await prepare(context);
			const sourceMessageIds =
				kind === "missing"
					? []
					: [
							kind === "other-speaker"
								? other.id
								: ("00000000-0000-0000-0000-000000000007" as UUID),
						];
			await expect(
				process({
					...context,
					prepared,
					evaluatorName: "longTermMemory",
					output: {
						memories: [
							{
								category: LongTermMemoryCategory.SEMANTIC,
								content: "Lives in Lisbon",
								confidence: 0.95,
								sourceMessageIds: [message.id],
							},
							{
								category: LongTermMemoryCategory.SEMANTIC,
								content: "Lives in Paris",
								confidence: 0.95,
								sourceMessageIds,
							},
						],
					},
				}),
			).rejects.toMatchObject({ code: "MEMORY_EXTRACTION_SOURCE_INVALID" });
			expect(context.memoryService.storeLongTermMemory).not.toHaveBeenCalled();
		},
	);

	it("shows the target entity and citable IDs when no shared transcript is provided", async () => {
		const context = fixture();
		const prepared = await prepare(context);
		const prompt = longTermMemoryEvaluator.prompt({ ...context, prepared });
		expect(prompt).toContain(`Target user entity ID: ${ENTITY}`);
		expect(prompt).toContain(`[${message.id}]`);
		expect(prompt).toContain(
			"Other participants and agent responses are reference context",
		);
	});

	it("rejects invalid model citations during parse before durable staging", async () => {
		const context = fixture();
		const prepared = await prepare(context);
		const parse = longTermMemoryEvaluator.parse;
		if (!parse) throw new Error("Missing long-term parser");
		const output = {
			memories: [
				{ category: "semantic", content: "Lives in Lisbon", confidence: 0.95 },
			],
		};
		expect(() => parse(output, { ...context, prepared })).toThrow(
			"Long-term memory requires evidence authored by the target user",
		);
		// Nonincremental consumers retain their original parsing contract.
		expect(parse(output)).toEqual(output);
		expect(
			parse(
				{
					memories: [{ ...output.memories[0], sourceMessageIds: [message.id] }],
				},
				{ ...context, prepared },
			),
		).toMatchObject({
			memories: [{ sourceMessageIds: [message.id] }],
		});
		expect(context.memoryService.storeLongTermMemory).not.toHaveBeenCalled();
	});

	it.each(["changedMessageIds", "removedMessageIds"] as const)(
		"holds %s without treating source-derived memories as repaired",
		async (field) => {
			const context = fixture();
			const prepared = await prepare(context);
			context.options.extraction[field] = [message.id];
			await expect(
				process({
					...context,
					prepared,
					evaluatorName: "longTermMemory",
					output: { memories: [] },
				}),
			).rejects.toMatchObject({ code: "EVALUATOR_SOURCE_REVIEW_REQUIRED" });
			expect(context.memoryService.storeLongTermMemory).not.toHaveBeenCalled();
		},
	);
});
