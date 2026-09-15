/**
 * Deterministic unit tests for `experiencePatternEvaluator` (experience-items.ts):
 * signal-gated shouldRun (idle chat vs explicit lesson vs fallback interval),
 * secret redaction + synthetic-summary filtering in prepare, and cross-batch dedupe
 * on record. Runtime and EXPERIENCE service are vi.fn stubs — no live model, no DB.
 */
import { assert, describe, expect, it, vi } from "vitest";
import {
	formatRecentMessages,
	getRoomTranscript,
} from "../../../../services/evaluator-transcript";
import type {
	EvaluatorProcessorContext,
	EvaluatorRunOptions,
} from "../../../../types/evaluator";
import type { Memory } from "../../../../types/memory";
import type { UUID } from "../../../../types/primitives";
import type { IAgentRuntime } from "../../../../types/runtime";
import type { State } from "../../../../types/state";
import type { ExperienceService } from "../service";
import { type Experience, ExperienceType, OutcomeType } from "../types";
import { experiencePatternEvaluator } from "./experience-items";

const prepare = experiencePatternEvaluator.prepare;
const processOutput = experiencePatternEvaluator.processors?.[0].process;
if (!prepare || !processOutput)
	throw new Error("Missing experience evaluator implementation");

type ExperienceRuntime = IAgentRuntime & {
	getService: ReturnType<typeof vi.fn>;
	getSetting: ReturnType<typeof vi.fn>;
	getCache: ReturnType<typeof vi.fn>;
	setCache: ReturnType<typeof vi.fn>;
	getMemories: ReturnType<typeof vi.fn>;
	redactSecrets: ReturnType<typeof vi.fn>;
};

function makeMemory(text: string, overrides: Partial<Memory> = {}): Memory {
	return {
		id: `00000000-0000-0000-0000-${Math.random().toString().slice(2, 14).padEnd(12, "0")}` as UUID,
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text },
		createdAt: 1,
		...overrides,
	};
}

function makeState(actionResults: unknown[] = []): State {
	return {
		values: {},
		data: { actionResults },
		text: "",
	};
}

function makeExperience(overrides: Partial<Experience> = {}): Experience {
	return {
		id: "00000000-0000-0000-0000-00000000e001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.NEUTRAL,
		context: "existing context",
		action: "existing action",
		result: "existing result",
		learning: "Use npm install",
		tags: ["existing"],
		domain: "package-management",
		keywords: ["npm", "install"],
		associatedEntityIds: [],
		confidence: 0.8,
		importance: 0.7,
		createdAt: 1,
		updatedAt: 1,
		accessCount: 0,
		...overrides,
	};
}

function makeRuntime(
	args: {
		recentMessages?: Memory[];
		existingExperiences?: Experience[];
		settings?: Record<string, string | number>;
	} = {},
): ExperienceRuntime {
	const cache = new Map<string, string>();
	const service = {
		findSimilarExperiences: vi.fn(async () => args.existingExperiences ?? []),
		recordExperience: vi.fn(async () => makeExperience()),
	};
	return {
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		character: { name: "Eliza", bio: "", system: "" },
		getService: vi.fn(() => service),
		getSetting: vi.fn((key: string) => args.settings?.[key]),
		getCache: vi.fn(async (key: string) => cache.get(key)),
		setCache: vi.fn(async (key: string, value: string) => {
			cache.set(key, value);
		}),
		getMemories: vi.fn(async () => args.recentMessages ?? []),
		redactSecrets: vi.fn((text: string) =>
			text.replace(/\bcsk-[A-Za-z0-9_-]+/g, "[REDACTED]"),
		),
		reportError: vi.fn(),
		__experienceService: service,
	} as unknown as ExperienceRuntime;
}

function getExperienceService(runtime: ExperienceRuntime) {
	return (runtime as unknown as { __experienceService: ExperienceService })
		.__experienceService;
}

describe("experiencePatternEvaluator", () => {
	it("uses all pending incremental evidence without rereading the full transcript or acknowledging skipped work", async () => {
		const runtime = makeRuntime({
			recentMessages: [makeMemory("old full history must not be read")],
		});
		const message = makeMemory("hello");
		const options: EvaluatorRunOptions = {
			extraction: {
				isBackfill: false,
				messages: [message],
				sourceRevisions: {},
				changedMessageIds: [],
				removedMessageIds: [],
				evidenceId: "batch-1",
			},
		};
		const context = { runtime, message, state: makeState(), options };
		assert(options.extraction);
		await expect(experiencePatternEvaluator.shouldRun(context)).resolves.toBe(
			false,
		);
		options.extraction.messages.push(
			makeMemory("Root cause was the stale parser. Remember this lesson."),
		);
		await expect(experiencePatternEvaluator.shouldRun(context)).resolves.toBe(
			true,
		);
		const prepared = await prepare(context);
		expect(prepared.recentMessages).toEqual(options.extraction.messages);
		expect(prepared.conversationContext).toContain(
			"Root cause was the stale parser",
		);
		expect(prepared.conversationContext).not.toContain("old full history");
		expect(runtime.getMemories).not.toHaveBeenCalled();
		expect(runtime.setCache).not.toHaveBeenCalled();
	});

	it("passes deterministic IDs and exact revisions when processing durable output again", async () => {
		const runtime = makeRuntime();
		const message = makeMemory("Remember this lesson.");
		assert(message.id);
		const options: EvaluatorRunOptions = {
			extraction: {
				isBackfill: false,
				messages: [message],
				sourceRevisions: { [message.id]: "revision-1" },
				changedMessageIds: [],
				removedMessageIds: [],
				evidenceId: "batch-1",
			},
		};
		const context = { runtime, message, state: makeState(), options };
		const prepared = await prepare(context);
		const output = {
			experiences: [
				{
					type: ExperienceType.LEARNING,
					outcome: OutcomeType.POSITIVE,
					domain: "testing",
					learning: "Check the saved output",
					context: "After a write",
					confidence: 0.9,
					importance: 0.8,
					reasoning: "A verified lesson",
				},
			],
		};
		await processOutput({
			...context,
			prepared,
			output,
			evaluatorName: "experiencePatterns",
		});
		await processOutput({
			...context,
			prepared,
			output,
			evaluatorName: "experiencePatterns",
		});
		const record = vi.mocked(getExperienceService(runtime).recordExperience);
		expect(record.mock.calls[0][0].id).toBe(record.mock.calls[1][0].id);
		expect(record.mock.calls[0][0]).toMatchObject({
			extractionEvidenceId: "batch-1",
			sourceMessageRevisions: { [message.id]: "revision-1" },
		});
	});

	it.each(["changedMessageIds", "removedMessageIds"] as const)(
		"holds %s in direct processors without storing or checkpointing",
		async (field) => {
			const runtime = makeRuntime();
			const message = makeMemory("Remember this lesson.");
			const options: EvaluatorRunOptions = {
				extraction: {
					isBackfill: false,
					messages: [message],
					sourceRevisions: {},
					changedMessageIds: [],
					removedMessageIds: [],
					evidenceId: "batch-1",
				},
			};
			const context = { runtime, message, state: makeState(), options };
			assert(message.id);
			assert(options.extraction);
			const prepared = await prepare(context);
			options.extraction[field] = [message.id];
			await expect(
				processOutput({
					...context,
					prepared,
					evaluatorName: "experiencePatterns",
					output: { experiences: [] },
				}),
			).rejects.toMatchObject({ code: "EVALUATOR_SOURCE_REVIEW_REQUIRED" });
			expect(
				getExperienceService(runtime).recordExperience,
			).not.toHaveBeenCalled();
			expect(runtime.setCache).not.toHaveBeenCalled();
		},
	);

	it("does not run on ordinary chat before the fallback interval", async () => {
		const runtime = makeRuntime();
		const shouldRun = await experiencePatternEvaluator.shouldRun({
			runtime,
			message: makeMemory("hello, how are you?"),
			state: makeState(),
			options: {},
		});

		expect(shouldRun).toBe(false);
		expect(runtime.getMemories).not.toHaveBeenCalled();
	});

	describe.each([false, true])(
		"action evidence (incremental=%s)",
		(incremental) => {
			it.each([
				{ result: { success: true }, admitted: false },
				{
					result: {
						success: true,
						text: "Notes is open.",
						error: null,
						data: { status: "completed", viewId: "notes" },
					},
					admitted: false,
				},
				{ result: { success: false }, admitted: true },
				{ result: { error: "Permission denied" }, admitted: true },
				{
					result: { success: true, data: { attempts: [{ success: false }] } },
					admitted: true,
				},
				{
					result: {
						success: true,
						text: "Fixed the stale parser; regression verified.",
					},
					admitted: true,
				},
				{
					result: {
						data: { diagnostics: ["Timeout while waiting for delivery."] },
					},
					admitted: true,
				},
			])(
				"admits $result only when it carries a signal",
				async ({ result, admitted }) => {
					const runtime = makeRuntime();
					const message = makeMemory("open notes");
					const options: EvaluatorRunOptions = incremental
						? {
								extraction: {
									isBackfill: false,
									messages: [message],
									sourceRevisions: {},
									changedMessageIds: [],
									removedMessageIds: [],
									evidenceId: "navigation-evidence",
								},
							}
						: {};
					await expect(
						experiencePatternEvaluator.shouldRun({
							runtime,
							message,
							state: makeState([result]),
							options,
						}),
					).resolves.toBe(admitted);
					expect(runtime.getMemories).not.toHaveBeenCalled();
					if (incremental) expect(runtime.setCache).not.toHaveBeenCalled();
				},
			);
		},
	);

	it("runs immediately when the turn contains an explicit reusable lesson", async () => {
		const runtime = makeRuntime();
		const shouldRun = await experiencePatternEvaluator.shouldRun({
			runtime,
			message: makeMemory(
				"Remember this lesson: next time run the package-specific test before the full suite.",
			),
			state: makeState(),
			options: {},
		});

		expect(shouldRun).toBe(true);
		expect(runtime.setCache).toHaveBeenCalledWith(
			"experience-extraction:00000000-0000-0000-0000-000000000003:last-run-count",
			"1",
		);
	});

	it("uses the fallback interval only when the recent window has an experience signal", async () => {
		const runtime = makeRuntime({
			recentMessages: [
				makeMemory("ordinary turn"),
				makeMemory("Root cause was the parser accepted the wrong JSON block."),
			],
		});
		await runtime.setCache(
			"experience-extraction:00000000-0000-0000-0000-000000000003:message-count",
			"24",
		);

		const shouldRun = await experiencePatternEvaluator.shouldRun({
			runtime,
			message: makeMemory("ok"),
			state: makeState(),
			options: {},
		});

		expect(shouldRun).toBe(true);
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ tableName: "messages" }),
		);
	});

	it("filters synthetic summaries and redacts secrets while preparing context", async () => {
		const runtime = makeRuntime({
			recentMessages: [
				makeMemory("validated fix with csk-abc1234567890"),
				makeMemory("[conversation summary] user likes squash", {
					metadata: { source: "conversation-compaction", tags: ["compaction"] },
				}),
			],
		});
		const prepared = await experiencePatternEvaluator.prepare?.({
			runtime,
			message: makeMemory("validated fix"),
			state: makeState(),
			options: {},
		});

		expect(prepared?.conversationContext).toContain("[REDACTED]");
		expect(prepared?.conversationContext).not.toContain("csk-abc1234567890");
		expect(prepared?.conversationContext).not.toContain("conversation summary");
		expect(
			getExperienceService(runtime).findSimilarExperiences,
		).toHaveBeenCalledWith(expect.stringContaining("[REDACTED]"), 5);
	});

	it("reuses the complete shared transcript without dropping long history or provenance", async () => {
		const older = makeMemory(
			`EARLY_LESSON ${"complete detail ".repeat(4000)} END_LESSON`,
		);
		const newer = makeMemory("LATEST_LESSON: validate the full result", {
			createdAt: 2,
		});
		const runtime = makeRuntime({ recentMessages: [newer, older] });
		const message = makeMemory("Remember this lesson");
		const sharedTranscript = await getRoomTranscript(runtime, message);
		const prepared = await experiencePatternEvaluator.prepare?.({
			runtime,
			message,
			state: makeState(),
			options: {},
		});
		if (!prepared) throw new Error("Missing prepared context");
		const prompt = experiencePatternEvaluator.prompt({
			runtime,
			message,
			state: makeState(),
			options: {},
			prepared,
			shared: { roomTranscriptRendered: true },
		});
		const completePrompt = `${formatRecentMessages(sharedTranscript)}\n${prompt}`;
		expect(prompt).toContain('see "Room transcript"');
		expect(prompt).not.toContain("EARLY_LESSON");
		expect(prompt).not.toContain("LATEST_LESSON");
		expect(completePrompt.split("EARLY_LESSON")).toHaveLength(2);
		expect(completePrompt).toContain(older.content.text);
		expect(completePrompt).toContain(newer.content.text);
		expect(prepared.conversationContext).toContain(older.content.text);
		expect(prepared.provenance.sourceMessageIds).toEqual([newer.id, older.id]);
		expect(prepared.recentMessages).toEqual([newer, older]);
		expect(runtime.getMemories).toHaveBeenCalledTimes(2);
	});

	it("keeps sanitized evaluator-only records alongside the shared transcript", async () => {
		const runtime = makeRuntime();
		const message = makeMemory("Remember this failure");
		const failure = makeMemory(
			"Something went wrong on my end with csk-private123",
			{
				entityId: runtime.agentId,
			},
		);
		const dialogue = makeMemory("Validated lesson");
		runtime.getMemories.mockResolvedValue([dialogue, failure]);
		const prepared = await experiencePatternEvaluator.prepare?.({
			runtime,
			message,
			state: makeState(),
			options: {},
		});
		if (!prepared) throw new Error("Missing prepared context");
		const prompt = experiencePatternEvaluator.prompt({
			runtime,
			message,
			state: makeState(),
			options: {},
			prepared,
			shared: { roomTranscriptRendered: true },
		});
		expect(prompt).toContain(
			"Additional experience records not in that transcript",
		);
		expect(prompt).toContain("Something went wrong on my end with [REDACTED]");
		expect(prompt).not.toContain("csk-private123");
		expect(prompt).not.toContain("Validated lesson");
		expect(prepared.provenance.sourceMessageIds).toEqual([
			dialogue.id,
			failure.id,
		]);
	});

	it.each([undefined, { roomTranscriptRendered: false }])(
		"retains complete sanitized standalone context when shared context is %s",
		async (shared) => {
			const text = `Validated ${"detail ".repeat(4000)} csk-private123 END`;
			const runtime = makeRuntime({ recentMessages: [makeMemory(text)] });
			const message = makeMemory("Remember this");
			const prepared = await experiencePatternEvaluator.prepare?.({
				runtime,
				message,
				state: makeState(),
				options: {},
			});
			if (!prepared) throw new Error("Missing prepared context");
			const prompt = experiencePatternEvaluator.prompt({
				runtime,
				message,
				state: makeState(),
				options: {},
				prepared,
				shared,
			});
			expect(prompt).toContain(text.replace("csk-private123", "[REDACTED]"));
			expect(prompt).not.toContain("csk-private123");
		},
	);

	it("preserves every sanitized body when the optional shared transcript read fails", async () => {
		const runtime = makeRuntime();
		const message = makeMemory("Remember this");
		runtime.getMemories
			.mockResolvedValueOnce([makeMemory("Validated with csk-private123")])
			.mockRejectedValueOnce(new Error("Shared read unavailable"));
		const prepared = await experiencePatternEvaluator.prepare?.({
			runtime,
			message,
			state: makeState(),
			options: {},
		});
		if (!prepared) throw new Error("Missing prepared context");
		const prompt = experiencePatternEvaluator.prompt({
			runtime,
			message,
			state: makeState(),
			options: {},
			prepared,
			shared: { roomTranscriptRendered: true },
		});
		expect(prompt).toContain("Validated with [REDACTED]");
		expect(prompt).not.toContain("csk-private123");
		expect(runtime.reportError).toHaveBeenCalled();
	});

	it("deduplicates normalized existing and same-batch learning before recording", async () => {
		const runtime = makeRuntime({
			existingExperiences: [makeExperience({ learning: "Use npm install" })],
		});
		const prepared = {
			experienceService: getExperienceService(runtime),
			recentMessages: [makeMemory("remember this lesson")],
			conversationContext: "remember this lesson",
			unsharedConversationContext: "",
			signalSummary: "explicit learning request",
			existingExperiences: [makeExperience({ learning: "Use npm install" })],
			provenance: {
				sourceMessageIds: [],
				sourceRoomId: "00000000-0000-0000-0000-000000000003" as UUID,
				associatedEntityIds: [],
			},
		};
		const processor = experiencePatternEvaluator.processors?.[0];

		const result = await processor?.process({
			runtime,
			message: makeMemory("remember this lesson"),
			state: makeState(),
			options: {},
			evaluatorName: experiencePatternEvaluator.name,
			prepared,
			output: {
				experiences: [
					{
						type: ExperienceType.LEARNING,
						outcome: OutcomeType.NEUTRAL,
						domain: "package-management",
						learning: "Use npm install!",
						context: "existing duplicate",
						confidence: 0.9,
						importance: 0.8,
						reasoning: "duplicate",
					},
					{
						type: ExperienceType.LEARNING,
						outcome: OutcomeType.POSITIVE,
						domain: "package-management",
						learning: "Use bun install instead.",
						context: "new lesson",
						confidence: 0.9,
						importance: 0.8,
						reasoning: "new",
					},
					{
						type: ExperienceType.LEARNING,
						outcome: OutcomeType.POSITIVE,
						domain: "package-management",
						learning: "Use bun install instead",
						context: "same batch duplicate",
						confidence: 0.9,
						importance: 0.8,
						reasoning: "duplicate",
					},
				],
			},
		} as EvaluatorProcessorContext);

		expect(result?.data).toEqual(
			expect.objectContaining({
				extractedCount: 3,
				recordedCount: 1,
				skippedDuplicateCount: 2,
			}),
		);
		expect(
			getExperienceService(runtime).recordExperience,
		).toHaveBeenCalledTimes(1);
	});
});
