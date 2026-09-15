import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../../../runtime.ts";
import {
	ChannelType,
	type Character,
	type EvaluatorRunOptions,
	type IAgentRuntime,
	type Memory,
	type RegisteredEvaluator,
	type UUID,
} from "../../../types/index.ts";
import { isActiveMemoryEvidence } from "../../../utils/extraction-evidence.ts";
import { makeFakeRuntime } from "../personality/__tests__/test-helpers.ts";
import { PersonalityStore } from "../personality/services/personality-store.ts";
import { recordFactCandidate } from "./_factCandidates.ts";
import { preferenceEvaluator } from "./preference-items.ts";
import {
	factMemoryEvaluator,
	identityEvaluator,
	relationshipEvaluator,
	successEvaluator,
} from "./reflection-items.ts";
import { getTaskCompletionCacheKey } from "./task-completion.ts";

const USER = "00000000-0000-4000-8000-000000000001" as UUID;
const OTHER = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM = "00000000-0000-4000-8000-000000000003" as UUID;
const MESSAGE = "00000000-0000-4000-8000-000000000004" as UUID;
const STATE = { values: {}, data: {}, text: "" };
const turn: Memory = {
	id: MESSAGE,
	entityId: USER,
	roomId: ROOM,
	content: { text: "I live in Berlin. Keep replies brief." },
	createdAt: 2,
};

function options(evidenceId = "factMemory:revision1"): EvaluatorRunOptions & {
	extraction: NonNullable<EvaluatorRunOptions["extraction"]>;
} {
	return {
		extraction: {
			messages: [turn],
			sourceRevisions: { [MESSAGE]: "revision1" },
			removedMessageIds: [],
			changedMessageIds: [],
			isBackfill: false,
			evidenceId,
		},
	};
}

async function makeRuntime() {
	const runtime = new AgentRuntime({
		character: { name: "Eliza", bio: "test", settings: {} } as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	await runtime.createRooms([
		{
			id: ROOM,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.GROUP,
		},
	]);
	await runtime.createEntities([
		{ id: USER, agentId: runtime.agentId, names: ["User"] },
		{ id: OTHER, agentId: runtime.agentId, names: ["Other"] },
	]);
	await runtime.createRoomParticipants([USER, OTHER], ROOM);
	return runtime;
}

async function process(
	runtime: IAgentRuntime,
	evaluator: RegisteredEvaluator,
	output: unknown,
	runOptions = options(),
) {
	const context = { runtime, message: turn, state: STATE, options: runOptions };
	const prepared = await evaluator.prepare?.(context);
	return evaluator.processors?.[0].process({
		...context,
		prepared,
		output,
		evaluatorName: evaluator.name,
	});
}

const factOps = {
	ops: [
		{
			op: "add_durable",
			sourceMessageIds: [MESSAGE],
			claim: "lives in Berlin",
			category: "identity",
			structured_fields: { city: "Berlin" },
			keywords: ["berlin"],
		},
	],
};

describe("incremental extractor evidence", () => {
	it.each([factMemoryEvaluator, preferenceEvaluator])(
		"$name preserves citations in parse and rejects missing, foreign, or reference-only sources before writes",
		async (evaluator) => {
			const runtime = await makeRuntime();
			const op =
				evaluator.name === "factMemory"
					? factOps.ops[0]
					: {
							op: "add_preference_fact",
							claim: "prefers short replies",
							sourceMessageIds: [MESSAGE],
						};
			const runOptions = options();
			runOptions.extraction.messages.push({
				...turn,
				id: OTHER,
				entityId: OTHER,
				content: { text: "I prefer lengthy replies." },
			});
			runOptions.extraction.sourceRevisions[OTHER] = "other-revision";
			// A historical reference can exist in progress, but it is not selected evidence.
			runOptions.extraction.sourceRevisions[ROOM] = "reference-revision";
			const context = {
				runtime,
				message: turn,
				state: STATE,
				options: runOptions,
			};
			const prepared = await evaluator.prepare?.(context);
			expect(
				evaluator.parse?.({ ops: [op] }, { ...context, prepared }),
			).toMatchObject({ ops: [{ sourceMessageIds: [MESSAGE] }] });
			for (const sourceMessageIds of [undefined, [], [OTHER], [ROOM]]) {
				const output = { ops: [{ ...op, sourceMessageIds }] };
				expect(() =>
					evaluator.parse?.(output, { ...context, prepared }),
				).toThrow(
					expect.objectContaining({
						code: "EVALUATOR_PERSONAL_SOURCE_REQUIRED",
					}),
				);
				await expect(
					process(runtime, evaluator, { ops: [op, ...output.ops] }, runOptions),
				).rejects.toMatchObject({ code: "EVALUATOR_PERSONAL_SOURCE_REQUIRED" });
				expect(
					await runtime.getMemories({
						tableName: "facts",
						roomId: ROOM,
						unique: false,
					}),
				).toHaveLength(0);
			}
		},
	);

	it("stores only cited personal source revisions, not other participants' context", async () => {
		const runtime = await makeRuntime();
		const runOptions = options();
		runOptions.extraction.messages.push({
			...turn,
			id: OTHER,
			entityId: OTHER,
		});
		runOptions.extraction.sourceRevisions[OTHER] = "other-revision";
		await process(runtime, factMemoryEvaluator, factOps, runOptions);
		const [fact] = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM,
			unique: false,
		});
		expect(fact.metadata?.extractionSourceRevisions).toEqual({
			[MESSAGE]: "revision1",
		});
	});

	it.each([
		factMemoryEvaluator,
		preferenceEvaluator,
		relationshipEvaluator,
		identityEvaluator,
		successEvaluator,
	])(
		"$name prepares the selected delta without rereading raw messages",
		async (evaluator) => {
			const runtime = await makeRuntime();
			const read = vi.spyOn(runtime, "getMemories");
			const context = {
				runtime,
				message: turn,
				state: STATE,
				options: options(),
			};
			const prepared = await evaluator.prepare?.(context);
			expect(prepared?.recentMessages).toEqual([turn]);
			expect(
				read.mock.calls.every(([query]) => query.tableName !== "messages"),
			).toBe(true);
		},
	);

	it("does not reuse another evaluator's selected window for the same message", async () => {
		const runtime = await makeRuntime();
		const a = options();
		const b = options("identity:revision2");
		b.extraction.messages = [
			{ ...turn, content: { text: "My GitHub name is test." } },
		];
		const first = await relationshipEvaluator.prepare?.({
			runtime,
			message: turn,
			state: STATE,
			options: a,
		});
		const second = await identityEvaluator.prepare?.({
			runtime,
			message: turn,
			state: STATE,
			options: b,
		});
		expect(first?.recentMessages).toEqual(a.extraction.messages);
		expect(second?.recentMessages).toEqual(b.extraction.messages);
	});

	it("replays a fact insert without duplication or false reinforcement; new evidence can reinforce once", async () => {
		const runtime = await makeRuntime();
		await process(runtime, factMemoryEvaluator, factOps);
		await process(runtime, factMemoryEvaluator, factOps);
		let facts = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM,
			unique: false,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0].metadata?.confidence).toBe(0.7);
		await process(
			runtime,
			factMemoryEvaluator,
			factOps,
			options("factMemory:new-message"),
		);
		await process(
			runtime,
			factMemoryEvaluator,
			factOps,
			options("factMemory:new-message"),
		);
		facts = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM,
			unique: false,
		});
		expect(facts[0].metadata?.confidence).toBeCloseTo(0.8);
	});

	it("partial failure does not repeat an already persisted strengthen", async () => {
		const runtime = await makeRuntime();
		await process(runtime, factMemoryEvaluator, factOps);
		const [fact] = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM,
			unique: false,
		});
		const original = runtime.createMemory.bind(runtime);
		const write = vi
			.spyOn(runtime, "createMemory")
			.mockRejectedValueOnce(new Error("second write failed"));
		const output = {
			ops: [
				{ op: "strengthen", factId: fact.id, sourceMessageIds: [MESSAGE] },
				{
					...factOps.ops[0],
					claim: "works in Paris",
					structured_fields: { city: "Paris" },
				},
			],
		};
		await expect(
			process(
				runtime,
				factMemoryEvaluator,
				output,
				options("factMemory:partial"),
			),
		).rejects.toThrow("second write failed");
		write.mockImplementation(original);
		await process(
			runtime,
			factMemoryEvaluator,
			output,
			options("factMemory:partial"),
		);
		expect(
			(await runtime.getMemoryById(fact.id as UUID))?.metadata?.confidence,
		).toBeCloseTo(0.8);
	});

	it.each([
		{
			evaluator: factMemoryEvaluator,
			output: factOps,
			text: "lives in Berlin",
			category: "identity",
		},
		{
			evaluator: preferenceEvaluator,
			output: {
				ops: [
					{
						op: "add_preference_fact",
						sourceMessageIds: [MESSAGE],
						claim: "prefers short replies",
						keywords: ["short", "replies"],
					},
				],
			},
			text: "prefers short replies",
			category: "preference",
		},
	])(
		"$evaluator.name backfill attaches evidence without reinforcing a legacy fact",
		async ({ evaluator, output, text, category }) => {
			const runtime = await makeRuntime();
			const id = await runtime.createMemory(
				{
					...turn,
					id: undefined,
					content: { text },
					metadata: {
						type: "custom",
						kind: "durable",
						category,
						confidence: 0.7,
						lastConfirmedAt: "2026-01-01T00:00:00.000Z",
					},
				},
				"facts",
				true,
			);
			const backfill = options(`${evaluator.name}:initial`);
			backfill.extraction.isBackfill = true;
			await process(runtime, evaluator, output, backfill);
			await process(runtime, evaluator, output, backfill);
			expect((await runtime.getMemoryById(id))?.metadata).toMatchObject({
				confidence: 0.7,
				lastConfirmedAt: "2026-01-01T00:00:00.000Z",
				extractionEvidenceIds: [`${evaluator.name}:initial`],
			});
			const newEvidence =
				evaluator.name === "factMemory"
					? {
							ops: [
								{ op: "strengthen", factId: id, sourceMessageIds: [MESSAGE] },
							],
						}
					: output;
			await process(
				runtime,
				evaluator,
				newEvidence,
				options(`${evaluator.name}:new-turn`),
			);
			expect(
				(await runtime.getMemoryById(id))?.metadata?.confidence,
			).toBeCloseTo(0.8);
		},
	);

	it("retains extraction receipts when canonical fact dedupe meets an existing Stage1 row", async () => {
		const runtime = await makeRuntime();
		const id = await runtime.createMemory(
			{
				...turn,
				id: undefined,
				content: { text: "lives in Berlin" },
				metadata: {
					type: "custom",
					source: "facts_and_relationships_stage",
					confidence: 0.7,
					kind: "current",
				},
			},
			"facts",
			true,
		);
		await process(runtime, factMemoryEvaluator, factOps);
		expect(
			(await runtime.getMemoryById(id))?.metadata?.extractionEvidenceIds,
		).toEqual(["factMemory:revision1"]);
		await process(runtime, factMemoryEvaluator, factOps);
		expect((await runtime.getMemoryById(id))?.metadata?.confidence).toBe(0.7);
	});

	it("preference fact replay does not raise confidence", async () => {
		const runtime = await makeRuntime();
		const output = {
			ops: [
				{
					op: "add_preference_fact",
					sourceMessageIds: [MESSAGE],
					claim: "prefers short replies",
					keywords: ["short", "replies"],
				},
			],
		};
		await process(
			runtime,
			preferenceEvaluator,
			output,
			options("preferences:r1"),
		);
		await process(
			runtime,
			preferenceEvaluator,
			output,
			options("preferences:r1"),
		);
		const facts = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM,
			unique: false,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0].metadata?.confidence).toBe(0.7);
	});

	it("deduplicates pending contradiction proposals at the SQL write boundary", async () => {
		const client = new PGlite();
		try {
			await client.exec(
				"CREATE TABLE fact_candidates (id uuid PRIMARY KEY, agent_id uuid, entity_id uuid, kind text, existing_fact_id uuid, proposed_text text, confidence real, evidence jsonb, status text)",
			);
			const runtime = {
				agentId: OTHER,
				adapter: { db: drizzle(client) },
			} as unknown as IAgentRuntime;
			const candidate = {
				entityId: USER,
				kind: "contradict" as const,
				existingFactId: MESSAGE,
				proposedText: "lives in Paris",
				evidenceMessageId: MESSAGE,
				extractionEvidenceId: "factMemory:r1",
			};
			await recordFactCandidate(runtime, candidate);
			await recordFactCandidate(runtime, candidate);
			expect(
				(await client.query("SELECT id FROM fact_candidates")).rows,
			).toHaveLength(1);
		} finally {
			await client.close();
		}
	});

	it("cannot reinforce another speaker's stored fact", async () => {
		const runtime = await makeRuntime();
		const id = await runtime.createMemory(
			{
				...turn,
				id: undefined,
				entityId: OTHER,
				content: { text: "Other lives in Paris" },
				metadata: { type: "custom", confidence: 0.7 },
			},
			"facts",
			true,
		);
		await process(runtime, factMemoryEvaluator, {
			ops: [{ op: "strengthen", factId: id, sourceMessageIds: [MESSAGE] }],
		});
		expect((await runtime.getMemoryById(id))?.metadata?.confidence).toBe(0.7);
	});

	it("attributes historical identity observations to their original sources, not the batch trigger", async () => {
		const runtime = await makeRuntime();
		const upsertIdentity = vi.fn(async () => {});
		const getService = runtime.getService.bind(runtime);
		vi.spyOn(runtime, "getService").mockImplementation((name) =>
			name === "relationships"
				? ({ upsertIdentity } as never)
				: getService(name),
		);
		const runOptions = options("identity:historical");
		runOptions.extraction.messages = [
			{ ...turn, id: OTHER, content: { text: "My GitHub handle is example." } },
			{ ...turn, content: { text: "Thanks." } },
		];
		runOptions.extraction.sourceRevisions[OTHER] = "historical-revision";
		const identity = {
			entityId: USER,
			platform: "github",
			handle: "example",
			confidence: 0.9,
		};
		await process(
			runtime,
			identityEvaluator,
			{ identities: [{ ...identity, sourceMessageId: OTHER }] },
			runOptions,
		);
		expect(upsertIdentity).toHaveBeenCalledWith(
			USER,
			expect.objectContaining({ handle: "example", source: "reflection" }),
			[OTHER],
		);
		// Legacy staged output keeps its prior write identity, rather than silently
		// changing already-persisted evidence during a retry.
		await process(
			runtime,
			identityEvaluator,
			{ identities: [identity] },
			runOptions,
		);
		expect(upsertIdentity).toHaveBeenLastCalledWith(USER, expect.anything(), [
			MESSAGE,
		]);
	});

	it.each(["unknown", "agent", "other-room", "reference-only"])(
		"rejects %s identity evidence before any side effects",
		async (kind) => {
			const runtime = await makeRuntime();
			const upsertIdentity = vi.fn(async () => {});
			const getService = runtime.getService.bind(runtime);
			vi.spyOn(runtime, "getService").mockImplementation((name) =>
				name === "relationships"
					? ({ upsertIdentity } as never)
					: getService(name),
			);
			const runOptions = options("identity:invalid");
			if (kind !== "unknown")
				runOptions.extraction.messages.push({
					...turn,
					id: OTHER,
					entityId: kind === "agent" ? runtime.agentId : USER,
					roomId: kind === "other-room" ? OTHER : ROOM,
				});
			if (kind !== "reference-only")
				runOptions.extraction.sourceRevisions[OTHER] = "revision";
			const identity = {
				entityId: USER,
				platform: "github",
				handle: "example",
				confidence: 0.9,
			};
			await expect(
				process(
					runtime,
					identityEvaluator,
					{
						identities: [
							{ ...identity, sourceMessageId: MESSAGE },
							{ ...identity, sourceMessageId: OTHER },
						],
					},
					runOptions,
				),
			).rejects.toMatchObject({ code: "EVALUATOR_IDENTITY_SOURCE_REQUIRED" });
			expect(upsertIdentity).not.toHaveBeenCalled();
		},
	);

	it("requires citations for fresh identity output while preserving staged legacy parsing", async () => {
		const runtime = await makeRuntime();
		const context = {
			runtime,
			message: turn,
			state: STATE,
			options: options(),
		};
		const prepared = await identityEvaluator.prepare?.(context);
		if (!prepared)
			throw new Error("Identity evaluator did not prepare context");
		expect(identityEvaluator.prompt?.({ ...context, prepared })).toContain(
			`[messageId=${MESSAGE}]`,
		);
		const sharedPrompt = identityEvaluator.prompt?.({
			...context,
			prepared,
			shared: { roomTranscriptRendered: true, actionResultsText: "" },
		});
		expect(sharedPrompt).toContain('see "Room transcript"');
		expect(sharedPrompt).not.toContain(turn.content.text);
		const output = {
			identities: [
				{
					entityId: USER,
					platform: "github",
					handle: "example",
					confidence: 0.9,
				},
			],
		};
		expect(
			identityEvaluator.parse?.(output, {
				...context,
				prepared,
				outputSource: "model",
			}),
		).toBeNull();
		expect(
			identityEvaluator.parse?.(output, {
				...context,
				prepared,
				outputSource: "staged",
			}),
		).toEqual(output);
		const cited = {
			identities: [{ ...output.identities[0], sourceMessageId: MESSAGE }],
		};
		expect(
			identityEvaluator.parse?.(cited, {
				...context,
				prepared,
				outputSource: "model",
			}),
		).toEqual(cited);
	});

	it("replays relationship effects once and preserves complete semantics", async () => {
		const runtime = await makeRuntime();
		const output = {
			relationships: [
				{
					sourceEntityId: USER,
					targetEntityId: OTHER,
					relationshipType: "colleague",
					tags: ["project"],
				},
			],
		};
		await process(
			runtime,
			relationshipEvaluator,
			output,
			options("relationships:r1"),
		);
		await process(
			runtime,
			relationshipEvaluator,
			output,
			options("relationships:r1"),
		);
		const edges = await runtime.getRelationships({ entityIds: [USER] });
		expect(edges).toHaveLength(1);
		expect(edges[0].metadata).toMatchObject({
			interactions: 1,
			relationshipType: "colleague",
		});
	});

	it("keeps all aspects of the same edge in one batch and does not count backfill as new interaction", async () => {
		const runtime = await makeRuntime();
		await runtime.createRelationship({
			sourceEntityId: USER,
			targetEntityId: OTHER,
			tags: ["legacy"],
			metadata: { interactions: 4 },
		});
		const output = {
			relationships: [
				{
					sourceEntityId: USER,
					targetEntityId: OTHER,
					relationshipType: "colleague",
					tags: ["project"],
				},
				{
					sourceEntityId: USER,
					targetEntityId: OTHER,
					tags: ["mentor"],
					metadata: { context: "same team" },
				},
			],
		};
		const backfill = options("relationships:backfill");
		backfill.extraction.isBackfill = true;
		await process(runtime, relationshipEvaluator, output, backfill);
		await process(runtime, relationshipEvaluator, output, backfill);
		const [edge] = await runtime.getRelationships({ entityIds: [USER] });
		expect(edge.tags).toEqual(["legacy", "project", "mentor"]);
		expect(edge.metadata).toMatchObject({
			interactions: 4,
			relationshipType: "colleague",
			context: "same team",
		});
	});

	it("stores one success reflection when the frozen output is retried", async () => {
		const runtime = await makeRuntime();
		await process(
			runtime,
			successEvaluator,
			{ completed: true, reason: "Navigation acknowledged" },
			options("success:r1"),
		);
		await process(
			runtime,
			successEvaluator,
			{ completed: true, reason: "Navigation acknowledged" },
			options("success:r1"),
		);
		expect(
			await runtime.getMemories({
				tableName: "memories",
				roomId: ROOM,
				unique: false,
			}),
		).toHaveLength(1);
	});

	it("retires an edited completion and its cache while retaining originals and other derived records", async () => {
		const runtime = await makeRuntime();
		await runtime.createMemory(
			{ ...turn, agentId: runtime.agentId },
			"messages",
		);
		await process(
			runtime,
			successEvaluator,
			{ completed: true, reason: "Done" },
			options("success:edited"),
		);
		const [reflection] = await runtime.getMemories({
			tableName: "memories",
			roomId: ROOM,
			unique: false,
		});
		const unrelated = {
			...reflection,
			id: "00000000-0000-4000-8000-000000000098" as UUID,
			metadata: {
				...reflection.metadata,
				messageId: OTHER,
				extractionSourceRevisions: { other: "unchanged" },
				extractionEvidenceIds: ["other"],
			},
		};
		await runtime.createMemory(unrelated, "memories");
		const protectedRecord = {
			...reflection,
			id: "00000000-0000-4000-8000-000000000097" as UUID,
			metadata: { ...reflection.metadata, verificationStatus: "confirmed" },
		};
		await runtime.createMemory(protectedRecord, "memories");
		const args = {
			runtime,
			message: turn,
			state: STATE,
			options: {},
			reconciliation: {
				id: "edited",
				changedMessageIds: [MESSAGE],
				removedMessageIds: [],
				currentSourceRevisions: { [MESSAGE]: "revision2", other: "unchanged" },
			},
		};
		const reconcile = successEvaluator.reconcileEvidence;
		expect(reconcile).toBeTypeOf("function");
		const result = await reconcile?.(args);
		expect(result).toEqual({ reprocessSourceIds: [MESSAGE] });
		if (!reflection.id) throw new Error("Missing stored reflection ID");
		const retired = await runtime.getMemoryById(reflection.id);
		expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
		expect(await runtime.getMemoryById(unrelated.id)).toEqual(unrelated);
		expect(await runtime.getMemoryById(protectedRecord.id)).toEqual(
			protectedRecord,
		);
		expect(await runtime.getMemoryById(MESSAGE)).toMatchObject({
			content: turn.content,
		});
		expect(
			await runtime.getCache(getTaskCompletionCacheKey(MESSAGE)),
		).toBeUndefined();
		await expect(reconcile?.(args)).resolves.toEqual(result);
	});

	it("retains a newer cached assessment and refuses a failed retirement write", async () => {
		const runtime = await makeRuntime();
		await process(
			runtime,
			successEvaluator,
			{ completed: true, reason: "Old" },
			options("success:removed"),
		);
		const key = getTaskCompletionCacheKey(MESSAGE);
		const newer = {
			source: "reflection",
			evaluatedAt: Date.now() + 1000,
			completed: false,
			reason: "New",
			assessed: true,
		};
		await runtime.setCache(key, newer);
		const args = {
			runtime,
			message: turn,
			state: STATE,
			options: {},
			reconciliation: {
				id: "removed",
				changedMessageIds: [],
				removedMessageIds: [MESSAGE],
				currentSourceRevisions: {},
			},
		};
		const update = vi.spyOn(runtime, "updateMemory").mockResolvedValue(false);
		await expect(
			successEvaluator.reconcileEvidence?.(args),
		).rejects.toMatchObject({ code: "EVALUATOR_RECONCILIATION_WRITE_FAILED" });
		update.mockRestore();
		await expect(successEvaluator.reconcileEvidence?.(args)).resolves.toEqual({
			reprocessSourceIds: [],
		});
		expect(await runtime.getCache(key)).toEqual(newer);
	});

	it("reconciles a legacy completion by its trigger and fails closed on cache deletion failure", async () => {
		const runtime = await makeRuntime();
		await process(runtime, successEvaluator, {
			completed: true,
			reason: "Done",
		});
		const [record] = await runtime.getMemories({
			tableName: "memories",
			roomId: ROOM,
			unique: false,
		});
		if (!record.id) throw new Error("Missing reflection");
		await runtime.updateMemory({
			id: record.id,
			metadata: { ...record.metadata, extractionSourceRevisions: {} },
		});
		const args = {
			runtime,
			message: turn,
			state: STATE,
			options: {},
			reconciliation: {
				id: "legacy-edit",
				changedMessageIds: [MESSAGE],
				removedMessageIds: [],
				currentSourceRevisions: { [MESSAGE]: "revision2" },
			},
		};
		const removeCache = vi
			.spyOn(runtime, "deleteCache")
			.mockResolvedValue(false);
		await expect(
			successEvaluator.reconcileEvidence?.(args),
		).rejects.toMatchObject({ code: "EVALUATOR_RECONCILIATION_WRITE_FAILED" });
		const unretired = await runtime.getMemoryById(record.id);
		expect(unretired && isActiveMemoryEvidence(unretired)).toBe(true);
		removeCache.mockRestore();
		await expect(successEvaluator.reconcileEvidence?.(args)).resolves.toEqual({
			reprocessSourceIds: [MESSAGE],
		});
		const retired = await runtime.getMemoryById(record.id);
		expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
	});

	it("flags attributable facts for review and does not claim deleted source reconciliation", async () => {
		const runtime = await makeRuntime();
		await process(runtime, factMemoryEvaluator, factOps);
		const changed = options("factMemory:deleted");
		changed.extraction.removedMessageIds = [MESSAGE];
		changed.extraction.sourceRevisions = {};
		await expect(
			process(runtime, factMemoryEvaluator, { ops: [] }, changed),
		).rejects.toMatchObject({ code: "EVALUATOR_SOURCE_REVIEW_REQUIRED" });
		const facts = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM,
			unique: false,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0].metadata?.extractionReviewRequired).toBe(true);
		expect(facts[0].content.text).toBe("lives in Berlin");
	});

	it("treats a false storage result as failure, not successful evidence consumption", async () => {
		const runtime = await makeRuntime();
		await process(runtime, factMemoryEvaluator, factOps);
		vi.spyOn(runtime, "updateMemory").mockResolvedValue(false);
		await expect(
			process(runtime, factMemoryEvaluator, factOps, options("factMemory:r2")),
		).rejects.toMatchObject({ code: "EXTRACTED_FACT_WRITE_FAILED" });
	});

	it("keeps per-operation personality receipts through service rehydration", async () => {
		const fake = makeFakeRuntime();
		const args = {
			scope: "user" as const,
			userId: USER,
			agentId: fake.runtime.agentId,
			actorId: fake.runtime.agentId,
			trait: "verbosity" as const,
			value: "terse",
			source: "agent_inferred" as const,
			extractionEvidenceId: "preferences:r1:terse",
		};
		await fake.store.applyTrait(args);
		await fake.store.applyTrait({
			...args,
			value: "verbose",
			extractionEvidenceId: "preferences:r1:verbose",
		});
		const reloaded = await PersonalityStore.start(fake.runtime);
		await reloaded.applyTrait(args);
		expect(reloaded.getSlot(USER).verbosity).toBe("verbose");
		expect(reloaded.getSlot(USER).extraction_evidence_ids).toEqual([
			"preferences:r1:terse",
			"preferences:r1:verbose",
		]);
		await reloaded.stop();
	});
});
