/**
 * Revision-based progress for incremental post-turn extraction. The caller supplies
 * a complete authoritative room snapshot, not a page or an audience-filtered view.
 * Raw history is never modified. An absent checkpoint means a full eligible
 * backfill; edits and deletions are changes even when their timestamps are old.
 *
 * Validated model output is staged before reducers run. A retry restores that
 * exact batch/output while later messages remain pending for the next batch.
 * Progress commits only after every reducer succeeds. This is at-least-once:
 * reducers still need durable replay guards, and callers must retain room ordering.
 * Cache writes are not a transaction with reducer writes or a distributed lease.
 */
import { ElizaError } from "../errors.ts";
import { hashStableJson } from "../runtime/context-hash.ts";
import type {
	EvaluatorEvidenceReconciliation,
	EvaluatorRunOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	UUID,
} from "../types/index.ts";
import { isPlainObject } from "../utils/type-guards.ts";
import { evaluatorEvidenceByteLength } from "./evaluator-evidence-page.ts";

// Bump when extraction/progress semantics require an explicit new backfill.
const EXTRACTION_VERSION = 1;

/** Add-only reducers must explicitly hold edits/removals for reconciliation. */
export function assertExtractionSourcesUnchanged(
	extraction: EvaluatorRunOptions["extraction"],
): void {
	const changedCount = extraction?.changedMessageIds.length ?? 0;
	const removedCount = extraction?.removedMessageIds.length ?? 0;
	if (changedCount || removedCount)
		throw new ElizaError(
			"Edited or deleted extraction sources require reconciliation before add-only memory writes",
			{
				code: "EVALUATOR_SOURCE_REVIEW_REQUIRED",
				severity: "ephemeral",
				context: { changedCount, removedCount },
			},
		);
}

export interface EvaluatorProgressSnapshot {
	progressState?: JsonValue;
	messages: Memory[];
	isBackfill: boolean;
	triggerMessage: Memory;
	sourceRevisions: Record<string, string>;
	changedMessageIds: UUID[];
	removedMessageIds: UUID[];
	evidenceId: string;
	/** Present only for a durably staged, validated model section. */
	pendingOutput?: unknown;
	pendingInputBinding?: string;
	referenceRevisions: Record<string, string>;
	hasEarlierEvidence: boolean;
	/** Unprocessed sources remain durable work, never acknowledged by this batch. */
	remainingSourceCount: number;
}

interface ProgressScope {
	agentId: UUID;
	roomId: UUID;
	entityId: UUID;
	evaluatorName: string;
	version: number;
}

interface EvidenceBatch {
	referenceRevisions?: Record<string, string>;
	isBackfill: boolean;
	triggerMessageId: UUID;
	sourceRevisions: Record<string, string>;
	changedMessageIds: UUID[];
	removedMessageIds: UUID[];
	evidenceId: string;
	/** Full observed revision map; later arrivals must not be acknowledged. */
	retainedRevisions: Record<string, string>;
	/** Ordered continuation, present only for a resource-bounded evidence batch. */
	deferredRevisions?: Record<string, string>;
}

interface ProgressRecord {
	scope: ProgressScope;
	completed: Record<string, string>;
	progressState?: JsonValue;
	pending?: EvidenceBatch & { output: unknown; inputBinding?: string };
	/** Initial evidence retains migration semantics through every backfill batch. */
	backfillRevisions?: Record<string, string>;
	lastReconciliationId?: string;
}

const snapshotState = new WeakMap<
	EvaluatorProgressSnapshot,
	{
		runtime: IAgentRuntime;
		key: string;
		scope: ProgressScope;
		expected: ProgressRecord | undefined;
		batch: EvidenceBatch;
	}
>();

function progressScope(
	runtime: IAgentRuntime,
	message: Pick<Memory, "roomId" | "entityId">,
	evaluatorName: string,
): ProgressScope {
	return {
		agentId: runtime.agentId,
		roomId: message.roomId,
		entityId: message.entityId,
		evaluatorName,
		version: EXTRACTION_VERSION,
	};
}

/** Read committed evaluator state only. Pending model output is never exposed
 * as a usable foreground checkpoint. Callers still validate current sources. */
export async function getEvaluatorProgressState(
	runtime: IAgentRuntime,
	message: Pick<Memory, "roomId" | "entityId">,
	evaluatorName: string,
): Promise<JsonValue | undefined> {
	const scope = progressScope(runtime, message, evaluatorName);
	const record = readRecord(
		await runtime.getCache<unknown>(
			`evaluator-progress:${hashStableJson(scope)}`,
		),
		scope,
	);
	return structuredClone(record?.progressState);
}

function sourceMemory(
	memory: Memory,
	scope: Pick<ProgressScope, "agentId" | "roomId">,
): Memory {
	if (
		typeof memory.id !== "string" ||
		!memory.id.trim() ||
		memory.roomId !== scope.roomId ||
		(memory.agentId !== undefined && memory.agentId !== scope.agentId) ||
		!isPlainObject(memory.content)
	) {
		throw new ElizaError(
			"Incremental extraction requires persisted, room-scoped messages",
			{
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			},
		);
	}
	const source = structuredClone(memory);
	// These are retrieval-derived, not authored message revisions. BGE refreshes
	// must not re-extract an unchanged conversation or duplicate vector payloads.
	delete source.embedding;
	delete source.similarity;
	return source;
}

/** Fingerprint authored evidence, not inference/retrieval bookkeeping. Unknown
 * plugin-authored metadata is retained so meaningful extensions still count. */
export function evaluatorSourceRevision(memory: Memory): string {
	const source = structuredClone(memory);
	delete source.embedding;
	delete source.similarity;
	for (const key of [
		"providers",
		"responseId",
		"responseMessageId",
		"evalCallbacks",
		"chatIdempotency",
	])
		delete source.content[key];
	if (isPlainObject(source.metadata)) {
		for (const key of [
			"trajectoryStepId",
			"trajectoryId",
			"evaluatedAt",
			"lastEvaluatedAt",
			"embeddedAt",
			"embeddingUpdatedAt",
			"embeddingModel",
			"embeddingDimensions",
			"lastAccessedAt",
			"accessCount",
			"topics",
		])
			delete source.metadata[key];
		if (isPlainObject(source.metadata.session)) {
			const session = { ...source.metadata.session };
			delete session.updatedAt;
			delete session.usage;
			if (Object.keys(session).length) source.metadata.session = session;
			else delete source.metadata.session;
		}
		if (!Object.keys(source.metadata).length) delete source.metadata;
	}
	return hashStableJson(source);
}

/** Only captured evidence and the original trigger constrain replay. Later
 * arrivals and edits to other history remain work for the following batch. */
function assertBatchSourcesCurrent(
	batch: EvidenceBatch,
	current: Record<string, string>,
): void {
	const changed = Object.entries({
		...batch.sourceRevisions,
		...batch.referenceRevisions,
	})
		.filter(([id, revision]) => current[id] !== revision)
		.map(([id]) => id);
	const restored = batch.removedMessageIds.filter((id) =>
		Object.hasOwn(current, id),
	);
	const triggerId = batch.triggerMessageId;
	if (
		current[triggerId] !== batch.retainedRevisions[triggerId] &&
		!changed.includes(triggerId)
	)
		changed.push(triggerId);
	if (changed.length || restored.length)
		throw new ElizaError(
			"Staged evaluator evidence changed; reconciliation is required before replay",
			{
				code: "EVALUATOR_PROGRESS_STALE_EVIDENCE",
				severity: "ephemeral",
				context: {
					changedCount: changed.length,
					restoredCount: restored.length,
				},
			},
		);
}

function isRevisionMap(value: unknown): value is Record<string, string> {
	return (
		isPlainObject(value) &&
		Object.entries(value).every(
			([id, revision]) =>
				id.trim().length > 0 &&
				typeof revision === "string" &&
				/^[a-f0-9]{64}$/.test(revision),
		)
	);
}

function evidenceId(
	scope: ProgressScope,
	completed: Record<string, string>,
	batch: Pick<
		EvidenceBatch,
		"sourceRevisions" | "removedMessageIds" | "triggerMessageId" | "isBackfill"
	>,
): string {
	return hashStableJson({ scope, completed, ...batch });
}

function readRecord(
	value: unknown,
	scope: ProgressScope,
): ProgressRecord | undefined {
	if (value === undefined) return undefined;
	const invalid = () =>
		new ElizaError("Invalid incremental evaluator checkpoint", {
			code: "EVALUATOR_PROGRESS_INVALID_CHECKPOINT",
		});
	if (
		!isPlainObject(value) ||
		hashStableJson(value.scope) !== hashStableJson(scope) ||
		!isRevisionMap(value.completed) ||
		(value.backfillRevisions !== undefined &&
			!isRevisionMap(value.backfillRevisions))
	) {
		throw invalid();
	}
	if (value.pending !== undefined) {
		const pending = value.pending;
		if (
			!isPlainObject(pending) ||
			typeof pending.isBackfill !== "boolean" ||
			(pending.inputBinding !== undefined &&
				typeof pending.inputBinding !== "string") ||
			Object.hasOwn(pending, "messages") ||
			!isRevisionMap(pending.sourceRevisions) ||
			!isRevisionMap(pending.retainedRevisions) ||
			(pending.referenceRevisions !== undefined &&
				!isRevisionMap(pending.referenceRevisions)) ||
			typeof pending.triggerMessageId !== "string" ||
			!Object.hasOwn(pending.retainedRevisions, pending.triggerMessageId) ||
			!Array.isArray(pending.changedMessageIds) ||
			!Array.isArray(pending.removedMessageIds) ||
			!Object.hasOwn(pending, "output") ||
			pending.output === undefined
		)
			throw invalid();
		if (
			pending.referenceRevisions &&
			Object.entries(pending.referenceRevisions).some(
				([id, revision]) =>
					(pending.retainedRevisions as Record<string, string>)[id] !==
					revision,
			)
		)
			throw invalid();
		const completed = value.completed;
		const retainedRevisions = pending.retainedRevisions;
		const expectedSources = Object.fromEntries(
			Object.entries(retainedRevisions).filter(
				([id, revision]) => completed[id] !== revision,
			),
		);
		const expectedRemovals = Object.keys(completed)
			.filter((id) => !Object.hasOwn(retainedRevisions, id))
			.sort();
		const expectedEdits = Object.keys(expectedSources)
			.filter((id) => Object.hasOwn(completed, id))
			.sort();
		const deferred = pending.deferredRevisions;
		if (deferred !== undefined && !isRevisionMap(deferred)) throw invalid();
		const pendingSources = pending.sourceRevisions;
		if (
			deferred &&
			Object.keys(deferred).some((id) => Object.hasOwn(pendingSources, id))
		)
			throw invalid();
		if (
			hashStableJson(expectedSources) !==
				hashStableJson({ ...pending.sourceRevisions, ...deferred }) ||
			hashStableJson(expectedRemovals) !==
				hashStableJson(pending.removedMessageIds) ||
			hashStableJson(expectedEdits) !==
				hashStableJson(
					[
						...pending.changedMessageIds,
						...Object.keys(deferred ?? {}).filter((id) =>
							Object.hasOwn(completed, id),
						),
					].sort(),
				)
		)
			throw invalid();
		if (
			pending.evidenceId !==
			evidenceId(scope, value.completed, {
				isBackfill: pending.isBackfill,
				triggerMessageId: pending.triggerMessageId as UUID,
				sourceRevisions: pending.sourceRevisions,
				removedMessageIds: expectedRemovals as UUID[],
			})
		)
			throw invalid();
	}
	return structuredClone(value) as unknown as ProgressRecord;
}

/** New unprocessed messages have no derived effects to reconcile. In-flight
 * unstaged inference is already fenced by its authoritative source recheck. */
export async function hasEvaluatorSourceProgress(
	runtime: IAgentRuntime,
	message: Memory,
	evaluatorNames: readonly string[],
	sourceIds: readonly string[],
): Promise<boolean> {
	for (const evaluatorName of evaluatorNames) {
		const scope = progressScope(runtime, message, evaluatorName);
		const record = readRecord(
			await runtime.getCache<unknown>(
				`evaluator-progress:${hashStableJson(scope)}`,
			),
			scope,
		);
		if (
			record &&
			sourceIds.some(
				(id) =>
					Object.hasOwn(record.completed, id) ||
					Object.hasOwn(record.pending?.sourceRevisions ?? {}, id) ||
					Object.hasOwn(record.pending?.referenceRevisions ?? {}, id),
			)
		)
			return true;
	}
	return false;
}

interface EvaluatorProgressOptions {
	maxEvidenceBytes?: number;
	/** Reconcile stored effects without admitting a model batch or requiring a surviving trigger. */
	reconcileOnly?: boolean;
	reconcile?: (
		plan: EvaluatorEvidenceReconciliation,
	) => Promise<{ reprocessSourceIds: string[] }>;
}

/** Capture one complete immutable source snapshot for independent extractors
 * in the same leased batch. Reusing it avoids repeated cloning/fingerprinting;
 * it never caches a transcript across batches or shares evaluator checkpoints. */
export function prepareEvaluatorProgressForTranscript(
	runtime: IAgentRuntime,
	triggerMessage: Memory,
	completeMessages: readonly Memory[],
) {
	const message = {
		id: triggerMessage.id,
		roomId: triggerMessage.roomId,
		entityId: triggerMessage.entityId,
	};
	if (!message.id || !message.roomId || !message.entityId || !runtime.agentId) {
		throw new ElizaError(
			"Incremental extraction requires a persisted trigger and owner scope",
			{
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			},
		);
	}
	const sources = new Map<string, Memory>();
	for (const memory of completeMessages) {
		const source = sourceMemory(memory, {
			agentId: runtime.agentId,
			roomId: message.roomId,
		});
		const id = source.id as UUID;
		if (sources.has(id))
			throw new ElizaError("Duplicate message ID in extraction snapshot", {
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			});
		sources.set(id, source);
	}
	const retainedRevisions = Object.fromEntries(
		[...sources].map(([id, source]) => [id, evaluatorSourceRevision(source)]),
	);
	const boundMessage = { ...message, id: message.id };
	return (
		evaluatorNames: readonly string[],
		options: EvaluatorProgressOptions = {},
	) =>
		prepareProgressFromSources(
			runtime,
			boundMessage,
			evaluatorNames,
			sources,
			retainedRevisions,
			options,
		);
}

/** All new/edited records and explicit removals, independently per extractor. */
export async function prepareEvaluatorProgress(
	runtime: IAgentRuntime,
	message: Memory,
	evaluatorNames: readonly string[],
	completeMessages: readonly Memory[],
	options: EvaluatorProgressOptions = {},
): Promise<Map<string, EvaluatorProgressSnapshot>> {
	return prepareEvaluatorProgressForTranscript(
		runtime,
		message,
		completeMessages,
	)(evaluatorNames, options);
}

async function prepareProgressFromSources(
	runtime: IAgentRuntime,
	message: Pick<Memory, "roomId" | "entityId"> & { id: UUID },
	evaluatorNames: readonly string[],
	sources: ReadonlyMap<string, Memory>,
	retainedRevisions: Record<string, string>,
	options: EvaluatorProgressOptions,
): Promise<Map<string, EvaluatorProgressSnapshot>> {
	if (
		options.maxEvidenceBytes !== undefined &&
		(!Number.isSafeInteger(options.maxEvidenceBytes) ||
			options.maxEvidenceBytes <= 0)
	)
		throw new ElizaError("Evidence batch size must be a positive byte count", {
			code: "EVALUATOR_BATCH_LIMIT_INVALID",
		});
	const trigger = sources.get(message.id);
	if (
		!options.reconcileOnly &&
		(!trigger || trigger.entityId !== message.entityId)
	)
		throw new ElizaError(
			"Original extraction trigger is absent from authoritative room history",
			{
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			},
		);
	const snapshots = new Map<string, EvaluatorProgressSnapshot>();
	for (const evaluatorName of evaluatorNames) {
		if (!evaluatorName.trim() || snapshots.has(evaluatorName))
			throw new ElizaError("Invalid evaluator progress name", {
				code: "EVALUATOR_PROGRESS_INVALID_SCOPE",
			});
		const scope: ProgressScope = {
			agentId: runtime.agentId,
			roomId: message.roomId,
			entityId: message.entityId,
			evaluatorName,
			version: EXTRACTION_VERSION,
		};
		const key = `evaluator-progress:${hashStableJson(scope)}`;
		let record = readRecord(await runtime.getCache<unknown>(key), scope);
		if (record?.lastReconciliationId) {
			const auditKey = `evaluator-reconciliation:${record.lastReconciliationId}`;
			const audit = await runtime.getCache<unknown>(auditKey);
			if (!isPlainObject(audit))
				throw new ElizaError("Reconciled progress lost its audit record", {
					code: "EVALUATOR_RECONCILIATION_AUDIT_MISSING",
				});
			if (
				audit.status === "prepared" &&
				!(await runtime.setCache(auditKey, {
					...audit,
					status: "completed",
					recoveredFromProgress: true,
				}))
			)
				throw new ElizaError("Reconciliation receipt recovery failed", {
					code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
				});
		}

		if (record && options.reconcile) {
			const observed = {
				...record.completed,
				...record.pending?.sourceRevisions,
				...record.pending?.referenceRevisions,
			};
			const changedMessageIds = Object.keys(observed).filter(
				(id) =>
					retainedRevisions[id] !== undefined &&
					retainedRevisions[id] !== observed[id],
			);
			const removedMessageIds = Object.keys(observed).filter(
				(id) => retainedRevisions[id] === undefined,
			);
			if (changedMessageIds.length || removedMessageIds.length) {
				const changedIds = [...changedMessageIds, ...removedMessageIds];
				const id = hashStableJson({
					scope,
					previous: record,
					changes: Object.fromEntries(
						changedIds.map((id) => [id, retainedRevisions[id] ?? null]),
					),
				});
				const plan: EvaluatorEvidenceReconciliation = {
					id,
					changedMessageIds,
					removedMessageIds,
					currentSourceRevisions: { ...retainedRevisions },
					...(record.pending
						? { pendingEvidenceId: record.pending.evidenceId }
						: {}),
				};
				const auditKey = `evaluator-reconciliation:${id}`;
				if (
					!(await runtime.getCache(auditKey)) &&
					!(await runtime.setCache(auditKey, {
						scope,
						previous: record,
						changes: plan,
						status: "prepared",
					}))
				)
					throw new ElizaError(
						"Reconciliation original could not be durably preserved",
						{ code: "EVALUATOR_RECONCILIATION_WRITE_FAILED" },
					);
				const outcome = await options.reconcile(plan);
				if (
					outcome.reprocessSourceIds.some(
						(id) => !Object.hasOwn(retainedRevisions, id),
					)
				)
					throw new ElizaError(
						"Reconciliation requested a source outside its captured room",
						{ code: "EVALUATOR_RECONCILIATION_INVALID_OUTPUT" },
					);
				if (
					hashStableJson(
						readRecord(await runtime.getCache<unknown>(key), scope),
					) !== hashStableJson(record)
				)
					throw new ElizaError("Progress changed during reconciliation", {
						code: "EVALUATOR_PROGRESS_CONFLICT",
					});
				const reprocess = new Set([
					...changedIds,
					...outcome.reprocessSourceIds,
				]);
				const {
					pending: _retired,
					progressState: _invalidatedState,
					...retained
				} = record;
				const reconciled: ProgressRecord = {
					...retained,
					completed: Object.fromEntries(
						Object.entries(record.completed).filter(
							([id]) => !reprocess.has(id),
						),
					),
					lastReconciliationId: id,
				};
				if (!(await runtime.setCache(key, reconciled)))
					throw new ElizaError("Reconciled progress was not persisted", {
						code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
					});
				// The prepared journal always retains the exact original even if this
				// final receipt fails. The progress pointer is authoritative completion.
				if (
					!(await runtime.setCache(auditKey, {
						scope,
						previous: record,
						changes: plan,
						status: "completed",
						reprocessSourceIds: [...reprocess],
					}))
				)
					throw new ElizaError("Reconciliation receipt was not persisted", {
						code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
					});
				record = reconciled;
			}
		}
		if (options.reconcileOnly) continue;
		const completed = record?.completed ?? {};
		let batch: EvidenceBatch;
		if (record?.pending) {
			assertBatchSourcesCurrent(record.pending, retainedRevisions);
			batch = record.pending;
		} else {
			const messages = [...sources.values()].filter(
				(source) =>
					completed[source.id as UUID] !== retainedRevisions[source.id as UUID],
			);
			const selected: Memory[] = [];
			const deferred: Memory[] = [];
			let bytes = 0;
			for (const source of messages) {
				const size = evaluatorEvidenceByteLength(source);
				if (
					options.maxEvidenceBytes !== undefined &&
					size > options.maxEvidenceBytes
				)
					throw new ElizaError(
						"One complete evidence record exceeds the configured batch boundary",
						{
							code: "EVALUATOR_SOURCE_TOO_LARGE",
							context: {
								sourceId: source.id,
								bytes: size,
								limit: options.maxEvidenceBytes,
							},
						},
					);
				if (
					deferred.length ||
					(options.maxEvidenceBytes !== undefined &&
						bytes + size > options.maxEvidenceBytes)
				)
					deferred.push(source);
				else {
					selected.push(source);
					bytes += size;
				}
			}
			const revisionsOf = (rows: Memory[]) =>
				Object.fromEntries(
					rows.map((source) => [
						source.id as UUID,
						retainedRevisions[source.id as UUID],
					]),
				);
			const sourceRevisions = revisionsOf(selected);
			const isBackfill =
				record === undefined ||
				Object.keys(record.backfillRevisions ?? {}).some((id) =>
					Object.hasOwn(sourceRevisions, id),
				);
			const removedMessageIds = Object.keys(completed)
				.filter((id) => !sources.has(id))
				.sort() as UUID[];
			const changedMessageIds = Object.keys(sourceRevisions)
				.filter((id) => Object.hasOwn(completed, id))
				.sort() as UUID[];
			batch = {
				isBackfill,
				triggerMessageId: message.id,
				sourceRevisions,
				changedMessageIds,
				removedMessageIds,
				retainedRevisions: { ...retainedRevisions },
				...(deferred.length
					? { deferredRevisions: revisionsOf(deferred) }
					: {}),
				evidenceId: evidenceId(scope, completed, {
					isBackfill,
					triggerMessageId: message.id,
					sourceRevisions,
					removedMessageIds,
				}),
			};
		}
		const snapshot: EvaluatorProgressSnapshot = {
			messages: Object.keys(batch.sourceRevisions).map((id) =>
				structuredClone(sources.get(id) as Memory),
			),
			isBackfill: batch.isBackfill,
			progressState: structuredClone(record?.progressState),
			triggerMessage: structuredClone(
				sources.get(batch.triggerMessageId) as Memory,
			),
			sourceRevisions: { ...batch.sourceRevisions },
			referenceRevisions: { ...batch.referenceRevisions },
			hasEarlierEvidence:
				[...sources.keys()].indexOf(Object.keys(batch.sourceRevisions)[0]) > 0,
			changedMessageIds: [...batch.changedMessageIds],
			removedMessageIds: [...batch.removedMessageIds],
			evidenceId: batch.evidenceId,
			remainingSourceCount: Object.keys(batch.deferredRevisions ?? {}).length,
			...(record?.pending
				? {
						pendingOutput: structuredClone(record.pending.output),
						pendingInputBinding: record.pending.inputBinding,
					}
				: {}),
		};
		snapshotState.set(snapshot, {
			runtime,
			key,
			scope,
			expected: record,
			batch: structuredClone(batch),
		});
		snapshots.set(evaluatorName, snapshot);
	}
	return snapshots;
}

/** Bind caller-requested historical context to the same source freshness guard.
 * References inform meaning but are not new evidence and never advance progress. */
export function bindEvaluatorReferenceEvidence(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
	messages: readonly Memory[],
): void {
	const state = requireSnapshot(runtime, snapshot);
	if (state.expected?.pending)
		throw new ElizaError("Cannot change staged reference evidence", {
			code: "EVALUATOR_PROGRESS_CONFLICT",
		});
	for (const message of messages) {
		const source = sourceMemory(message, state.scope);
		const id = source.id as string;
		const revision = evaluatorSourceRevision(source);
		if (state.batch.retainedRevisions[id] !== revision)
			throw new ElizaError(
				"Requested reference changed after evidence capture",
				{ code: "EVALUATOR_PROGRESS_STALE_EVIDENCE", severity: "ephemeral" },
			);
		snapshot.referenceRevisions[id] = revision;
	}
	state.batch.referenceRevisions = { ...snapshot.referenceRevisions };
}

function requireSnapshot(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
) {
	const state = snapshotState.get(snapshot);
	if (!state || state.runtime !== runtime)
		throw new ElizaError("Unknown evaluator progress snapshot", {
			code: "EVALUATOR_PROGRESS_INVALID_SNAPSHOT",
		});
	return state;
}

async function assertCurrent(
	runtime: IAgentRuntime,
	state: ReturnType<typeof requireSnapshot>,
): Promise<void> {
	const current = readRecord(
		await runtime.getCache<unknown>(state.key),
		state.scope,
	);
	if (hashStableJson(current) !== hashStableJson(state.expected))
		throw new ElizaError(
			"Evaluator progress changed outside the ordered room lane",
			{
				code: "EVALUATOR_PROGRESS_CONFLICT",
				severity: "ephemeral",
			},
		);
}

/** Read through the adapter, explicitly bypassing runtime's default room-scan
 * memo. This catches source edits during inference and reducer execution. It is
 * validation, not an atomic transaction spanning source and reducer writes. */
async function assertSourcesCurrent(
	runtime: IAgentRuntime,
	state: ReturnType<typeof requireSnapshot>,
): Promise<void> {
	const rows = await runtime.getMemories({
		tableName: "messages",
		roomId: state.scope.roomId,
		agentId: state.scope.agentId,
		unique: false,
		orderDirection: "asc",
		includeEmbedding: false,
	});
	const revisions: Record<string, string> = {};
	for (const row of rows) {
		const source = sourceMemory(row, state.scope);
		const id = source.id as UUID;
		if (Object.hasOwn(revisions, id))
			throw new ElizaError(
				"Duplicate message ID in authoritative extraction evidence",
				{
					code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
				},
			);
		revisions[id] = evaluatorSourceRevision(source);
	}
	assertBatchSourcesCurrent(state.batch, revisions);
}

/** Caller must validate the model section before staging; no reducers run here. */
export async function stageEvaluatorOutput(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
	output: unknown,
	inputBinding?: string,
): Promise<void> {
	const state = requireSnapshot(runtime, snapshot);
	if (output === undefined)
		throw new ElizaError("Cannot stage an absent evaluator output", {
			code: "EVALUATOR_PROGRESS_INVALID_OUTPUT",
		});
	await assertCurrent(runtime, state);
	await assertSourcesCurrent(runtime, state);
	if (state.expected?.pending) {
		if (
			hashStableJson(output) !==
				hashStableJson(state.expected.pending.output) ||
			inputBinding !== state.expected.pending.inputBinding
		)
			throw new ElizaError(
				"Cannot replace staged evaluator output before reconciliation",
				{
					code: "EVALUATOR_PROGRESS_CONFLICT",
				},
			);
		return;
	}
	const record: ProgressRecord = {
		scope: state.scope,
		progressState: structuredClone(state.expected?.progressState),
		...(state.expected?.lastReconciliationId
			? { lastReconciliationId: state.expected.lastReconciliationId }
			: {}),
		completed: state.expected?.completed ?? {},
		pending: {
			...state.batch,
			output: structuredClone(output),
			...(inputBinding ? { inputBinding } : {}),
		},
		backfillRevisions:
			state.expected?.backfillRevisions ??
			(state.expected === undefined ? state.batch.retainedRevisions : {}),
	};
	if (!(await runtime.setCache(state.key, record)))
		throw new ElizaError("Evaluator output was not durably staged", {
			code: "EVALUATOR_PROGRESS_WRITE_FAILED",
			severity: "ephemeral",
		});
	state.expected = structuredClone(record);
}

/** Call only after all this evaluator's durable reducers have succeeded. */
export async function commitEvaluatorProgress(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
	progressState?: JsonValue,
): Promise<void> {
	const state = requireSnapshot(runtime, snapshot);
	await assertCurrent(runtime, state);
	if (!state.expected?.pending)
		throw new ElizaError(
			"Evaluator output must be staged before progress can commit",
			{
				code: "EVALUATOR_PROGRESS_NOT_STAGED",
			},
		);
	await assertSourcesCurrent(runtime, state);
	const record: ProgressRecord = {
		scope: state.scope,
		progressState: structuredClone(
			progressState === undefined
				? state.expected.progressState
				: progressState,
		),
		...(state.expected?.lastReconciliationId
			? { lastReconciliationId: state.expected.lastReconciliationId }
			: {}),
		completed: Object.fromEntries(
			Object.entries({
				...state.expected.completed,
				...state.batch.sourceRevisions,
			}).filter(([id]) => !state.batch.removedMessageIds.includes(id as UUID)),
		),
		backfillRevisions: Object.fromEntries(
			Object.entries(state.expected.backfillRevisions ?? {}).filter(
				([id]) =>
					!Object.hasOwn(state.batch.sourceRevisions, id) &&
					!state.batch.removedMessageIds.includes(id as UUID),
			),
		),
	};
	if (!(await runtime.setCache(state.key, record)))
		throw new ElizaError("Evaluator progress was not durably committed", {
			code: "EVALUATOR_PROGRESS_WRITE_FAILED",
			severity: "ephemeral",
		});
	state.expected = structuredClone(record);
}
