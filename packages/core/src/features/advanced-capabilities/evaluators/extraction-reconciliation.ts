/** Retire derived claims whose exact source revisions changed. Originals remain
 * in storage; only retained supporting source IDs are queued for re-extraction. */
import { ElizaError } from "../../../errors.ts";
import type {
	CustomMetadata,
	EvaluatorEvidenceReconciliation,
	EvaluatorRunContext,
	UUID,
} from "../../../types/index.ts";
import { isProtectedMemoryEvidence } from "../../../utils/extraction-evidence.ts";
import { isObjectRecord } from "../../../utils/type-guards.ts";
import {
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "./task-completion.ts";

/** Invalidate only this agent's derived assessments in the changed room. The
 * transcript and manual memories remain intact, including on reducer retries. */
export async function reconcileSuccessEvidence({
	runtime,
	message,
	reconciliation,
}: EvaluatorRunContext & {
	reconciliation: EvaluatorEvidenceReconciliation;
}): Promise<{ reprocessSourceIds: string[] }> {
	const records = await runtime.getMemories({
		tableName: "memories",
		agentId: runtime.agentId,
		roomId: message.roomId,
		entityId: message.entityId,
		authorEntityIds: [runtime.agentId],
		unique: false,
	});
	const reprocess = new Set<string>();
	for (const record of records) {
		if (
			record.agentId !== runtime.agentId ||
			record.entityId !== runtime.agentId ||
			record.roomId !== message.roomId ||
			record.content.type !== "task_completion_reflection" ||
			isProtectedMemoryEvidence(record)
		)
			continue;
		const metadata = isObjectRecord(record.metadata) ? record.metadata : {};
		const revisions = isObjectRecord(metadata.extractionSourceRevisions)
			? metadata.extractionSourceRevisions
			: {};
		const changed = Object.keys(revisions).filter(
			(id) =>
				reconciliation.changedMessageIds.includes(id) ||
				reconciliation.removedMessageIds.includes(id) ||
				(reconciliation.currentSourceRevisions[id] !== undefined &&
					reconciliation.currentSourceRevisions[id] !== revisions[id]),
		);
		// Legacy reflections still identify their trigger even without a full
		// revision map. An explicit edit/removal of that source invalidates them.
		if (
			typeof metadata.messageId === "string" &&
			!changed.includes(metadata.messageId) &&
			(reconciliation.changedMessageIds.includes(metadata.messageId) ||
				reconciliation.removedMessageIds.includes(metadata.messageId))
		)
			changed.push(metadata.messageId);
		const pending =
			reconciliation.pendingEvidenceId !== undefined &&
			Array.isArray(metadata.extractionEvidenceIds) &&
			metadata.extractionEvidenceIds.includes(reconciliation.pendingEvidenceId);
		if (!pending && !changed.length) continue;
		for (const id of Object.keys(revisions))
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		for (const id of changed)
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		if (typeof metadata.messageId === "string") {
			const key = getTaskCompletionCacheKey(metadata.messageId as UUID);
			const cached = await runtime.getCache<TaskCompletionAssessment>(key);
			// Another batch may already have replaced the message's assessment.
			if (
				cached?.source === "reflection" &&
				cached.evaluatedAt === metadata.evaluatedAt &&
				cached.assessed === metadata.taskAssessed &&
				cached?.completed === metadata.taskCompleted &&
				cached?.reason === metadata.taskCompletionReason &&
				!(await runtime.deleteCache(key))
			)
				throw new ElizaError("Stale completion cache could not be retired", {
					code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
				});
		}
		if (metadata.extractionStatus === "source_invalidated") continue;
		if (
			!record.id ||
			!(await runtime.updateMemory({
				id: record.id,
				metadata: {
					...(record.metadata as CustomMetadata),
					type: "custom",
					extractionStatus: "source_invalidated",
					extractionReviewRequired: false,
					extractionReconciliationId: reconciliation.id,
					extractionChangedSourceIds: changed,
				},
			}))
		)
			throw new ElizaError("Derived completion could not be retired", {
				code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
			});
	}
	return { reprocessSourceIds: [...reprocess] };
}

export async function reconcileFactEvidence({
	runtime,
	message,
	reconciliation,
}: EvaluatorRunContext & {
	reconciliation: EvaluatorEvidenceReconciliation;
}): Promise<{ reprocessSourceIds: string[] }> {
	const facts = await runtime.getMemories({
		tableName: "facts",
		agentId: runtime.agentId,
		entityId: message.entityId,
		authorEntityIds: [message.entityId],
		unique: false,
	});
	const reprocess = new Set<string>();
	for (const fact of facts) {
		if (
			fact.agentId !== runtime.agentId ||
			fact.entityId !== message.entityId ||
			isProtectedMemoryEvidence(fact)
		)
			continue;
		const metadata = isObjectRecord(fact.metadata) ? fact.metadata : {};
		const revisions = isObjectRecord(metadata.extractionSourceRevisions)
			? metadata.extractionSourceRevisions
			: {};
		const pending =
			reconciliation.pendingEvidenceId !== undefined &&
			Array.isArray(metadata.extractionEvidenceIds) &&
			metadata.extractionEvidenceIds.includes(reconciliation.pendingEvidenceId);
		const changed = Object.entries(revisions)
			.filter(
				([id, revision]) =>
					reconciliation.changedMessageIds.includes(id) ||
					reconciliation.removedMessageIds.includes(id) ||
					(reconciliation.currentSourceRevisions[id] !== undefined &&
						reconciliation.currentSourceRevisions[id] !== revision),
			)
			.map(([id]) => id);
		if (!pending && !changed.length) continue;
		for (const id of Object.keys(revisions))
			if (reconciliation.currentSourceRevisions[id] !== undefined)
				reprocess.add(id);
		if (metadata.extractionStatus === "source_invalidated") continue;
		if (
			!fact.id ||
			!(await runtime.updateMemory({
				id: fact.id,
				metadata: {
					...(fact.metadata as CustomMetadata),
					type: "custom",
					extractionStatus: "source_invalidated",
					extractionReviewRequired: false,
					extractionReconciliationId: reconciliation.id,
					extractionChangedSourceIds: changed,
				},
			}))
		)
			throw new ElizaError("Derived fact could not be retired", {
				code: "EVALUATOR_RECONCILIATION_WRITE_FAILED",
			});
	}
	return { reprocessSourceIds: [...reprocess] };
}
