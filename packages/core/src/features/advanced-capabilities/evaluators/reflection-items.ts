/**
 * The post-response reflection evaluator bundle for the advanced-capabilities
 * feature: `factMemory`, `relationships`, `identities`, and `success`, exported
 * together as `reflectionItems`. Each runs after the agent replies, extracts
 * structured output from the recent conversation via a strict-JSON-schema model
 * call, and writes it back into runtime memory — durable/current fact-store ops,
 * relationship edges between known room participants, platform-identity claims,
 * and a task-completion assessment respectively.
 *
 * The evaluators share a single reflection-context prepare step (recent messages,
 * entities in room, existing relationships) and gate on `canEvaluateMessage`.
 * Fact dedupe requires an equivalent complete claim and structured meaning;
 * keyword relevance never authorizes discarding a newly extracted fact.
 *
 * Every response `schema` here is hand-written to survive strict
 * structured-output mode (Groq / Cerebras / OpenAI strict): every object node
 * declares `properties` and `additionalProperties: false`, and no value-constraint
 * keyword (maxItems, pattern, …) appears — those caps are enforced in code
 * instead. Violating that invariant 400s the whole extraction call and silently
 * drops the turn's memories, which reflection-items.test.ts guards against.
 */
import { v4 } from "uuid";
import z from "zod";
import { getEntityDetails } from "../../../entities.ts";
import { ElizaError } from "../../../errors.ts";
import { renderActionResultsForModel } from "../../../runtime/planner-rendering.ts";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import { assertExtractionSourcesUnchanged } from "../../../services/evaluator-progress.ts";
import {
	formatRecentMessages,
	getRoomTranscript,
	recentMessagesSection,
} from "../../../services/evaluator-transcript.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	ActionResult,
	Entity,
	Evaluator,
	EvaluatorRunOptions,
	EvaluatorSharedPromptContext,
	IAgentRuntime,
	JSONSchema,
	Memory,
	MemoryMetadata,
	PromptSegment,
	RegisteredEvaluator,
	State,
	UUID,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import type {
	CurrentFactCategory,
	CustomMetadata,
	DurableFactCategory,
	FactKind,
	FactMetadata,
	FactVerificationStatus,
} from "../../../types/memory.ts";
import { MemoryType } from "../../../types/memory.ts";
import type { JsonValue } from "../../../types/primitives.ts";
import { stableStringify } from "../../../utils/deterministic.ts";
import {
	hasNoPersonalExtractionSources,
	isActiveMemoryEvidence,
	isProtectedMemoryEvidence,
} from "../../../utils/extraction-evidence.ts";
import { isSyntheticConversationArtifactMemory } from "../../../utils/synthetic-conversation-artifact.ts";
import { stringToUuid } from "../../../utils.ts";
import {
	buildFactKeywordsForStorage,
	buildFactSearchText,
	factClaimsEquivalent,
} from "../fact-keywords.ts";
import { recordFactCandidate } from "./_factCandidates.ts";
import {
	reconcileFactEvidence,
	reconcileSuccessEvidence,
} from "./extraction-reconciliation.ts";
import {
	type AddCurrentOp,
	type AddDurableOp,
	type ContradictOp,
	CurrentCategoryEnum,
	type DecayOp,
	DurableCategoryEnum,
	type ExtractorOp,
	type ExtractorOutput,
	parseExtractorOutputTolerant,
	type StrengthenOp,
	VerificationStatusEnum,
} from "./factExtractor.schema.ts";
import {
	formatTaskCompletionStatus,
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "./task-completion.ts";

// Exported fact-store tuning shared with the preference evaluator
// (preference-items.ts), which writes durable `preference` facts through the
// same dedupe/strengthen discipline — one source of truth for the thresholds.
export const STRENGTHEN_DELTA = 0.1;
const DECAY_DELTA = 0.15;
const FACT_DECAY_FLOOR = 0.2;
export const NEW_FACT_CONFIDENCE = 0.7;
export const DEDUP_SIMILARITY_THRESHOLD = 0.42;
const IDENTITY_CONFIDENCE_THRESHOLD = 0.5;

const structuredFieldProperties: Record<string, JSONSchema> = {
	preferredName: { type: "string" },
	orientation: { type: "string" },
	gender: { type: "string" },
	age: { type: "string" },
	location: { type: "string" },
	city: { type: "string" },
	homeCity: { type: "string" },
	home_location: { type: "string" },
	timezone: { type: "string" },
	timeZone: { type: "string" },
	ianaTimezone: { type: "string" },
	relationshipStatus: { type: "string" },
	status: { type: "string" },
	partnerName: { type: "string" },
	partner: { type: "string" },
	spouse: { type: "string" },
	person: { type: "string" },
	name: { type: "string" },
	target: { type: "string" },
	relatedPerson: { type: "string" },
	relationshipType: { type: "string" },
	relationship: { type: "string" },
	role: { type: "string" },
	type: { type: "string" },
	manager: { type: "string" },
	boss: { type: "string" },
	platform: { type: "string" },
	service: { type: "string" },
	network: { type: "string" },
	handle: { type: "string" },
	username: { type: "string" },
	account: { type: "string" },
	profile: { type: "string" },
	company: { type: "string" },
	organization: { type: "string" },
	employer: { type: "string" },
	locale: { type: "string" },
	languageLocale: { type: "string" },
	preferredNotificationChannel: { type: "string" },
	channel: { type: "string" },
	travelBookingPreferences: { type: "string" },
	travelPreference: { type: "string" },
	bookingPreference: { type: "string" },
	condition: { type: "string" },
	source: { type: "string" },
	emotion: { type: "string" },
	window: { type: "string" },
	event: { type: "string" },
	to: { type: "string" },
	goal: { type: "string" },
	domain: { type: "string" },
};

const structuredFieldsSchema: JSONSchema = {
	type: "object",
	properties: structuredFieldProperties,
	additionalProperties: false,
};

const newFactProperties: Record<string, JSONSchema> = {
	claim: { type: "string" },
	sourceMessageIds: { type: "array", items: { type: "string" } },
	structured_fields: structuredFieldsSchema,
	keywords: { type: "array", items: { type: "string" } },
	reason: { type: "string" },
};

const factOpsSchema: JSONSchema = {
	type: "object",
	properties: {
		ops: {
			type: "array",
			items: {
				// Required fields belong to each operation; a shared optional-field
				// object permits outputs that the extractor cannot process.
				anyOf: [
					{
						type: "object",
						properties: {
							op: { type: "string", enum: ["add_durable"] },
							...newFactProperties,
							category: { type: "string", enum: DurableCategoryEnum.options },
							verification_status: {
								type: "string",
								enum: VerificationStatusEnum.options,
							},
						},
						required: ["op", "claim", "category"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							op: { type: "string", enum: ["add_current"] },
							...newFactProperties,
							category: { type: "string", enum: CurrentCategoryEnum.options },
							valid_at: { type: "string" },
						},
						required: ["op", "claim", "category"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							op: { type: "string", enum: ["strengthen", "decay"] },
							sourceMessageIds: { type: "array", items: { type: "string" } },
							factId: { type: "string" },
							reason: { type: "string" },
						},
						required: ["op", "factId"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							op: { type: "string", enum: ["contradict"] },
							sourceMessageIds: { type: "array", items: { type: "string" } },
							factId: { type: "string" },
							proposedText: {
								type: "string",
								description:
									"Required and nonblank for contradict: the complete corrected claim supported by the user's correction, preserving unchanged details. Proposes a replacement for review; never copy the old contradicted claim or invent missing details.",
							},
							reason: { type: "string" },
						},
						required: ["op", "factId", "reason", "proposedText"],
						additionalProperties: false,
					},
				],
			},
		},
	},
	required: ["ops"],
	additionalProperties: false,
};

const relationshipSchema: JSONSchema = {
	type: "object",
	properties: {
		relationships: {
			type: "array",
			items: {
				type: "object",
				properties: {
					sourceEntityId: { type: "string" },
					targetEntityId: { type: "string" },
					relationshipType: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					// Strict mode: every object must carry additionalProperties:false
					// AND an explicit properties map even when the property is
					// logically open-ended — omitting `properties` is a hard reject.
					metadata: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
				},
				required: ["sourceEntityId", "targetEntityId"],
				additionalProperties: false,
			},
		},
	},
	required: ["relationships"],
	additionalProperties: false,
};

const identitySchema: JSONSchema = {
	type: "object",
	properties: {
		identities: {
			type: "array",
			items: {
				type: "object",
				properties: {
					entityId: { type: "string" },
					platform: { type: "string" },
					handle: { type: "string" },
					confidence: { type: "number" },
					sourceMessageId: { type: "string" },
				},
				required: [
					"entityId",
					"platform",
					"handle",
					"confidence",
					"sourceMessageId",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["identities"],
	additionalProperties: false,
};

const successSchema: JSONSchema = {
	type: "object",
	properties: {
		completed: { type: "boolean" },
		reason: { type: "string" },
		thought: { type: "string" },
	},
	required: ["completed", "reason"],
	additionalProperties: false,
};

const RelationshipUpdateSchema = z
	.object({
		sourceEntityId: z.string().min(1),
		targetEntityId: z.string().min(1),
		relationshipType: z.string().trim().min(1).optional(),
		tags: z.array(z.string()).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.refine(
		(relationship) =>
			relationship.relationshipType === undefined ||
			relationship.metadata?.relationshipType === undefined ||
			relationship.metadata.relationshipType === relationship.relationshipType,
		{ message: "Relationship type fields disagree" },
	);

const RelationshipOutputSchema = z.object({
	relationships: z.array(RelationshipUpdateSchema),
});

const IdentityUpdateSchema = z.object({
	entityId: z.string().min(1),
	platform: z.string().min(1),
	handle: z.string().min(1),
	confidence: z.number().min(0).max(1),
	// Older staged outputs retain their original trigger-based replay contract.
	sourceMessageId: z.string().min(1).optional(),
});

const IdentityOutputSchema = z.object({
	identities: z.array(IdentityUpdateSchema),
});

const SuccessOutputSchema = z.object({
	completed: z.boolean(),
	reason: z.string(),
	thought: z.string().optional(),
});

type RelationshipUpdate = z.infer<typeof RelationshipUpdateSchema>;
type IdentityUpdate = z.infer<typeof IdentityUpdateSchema>;
type SuccessOutput = z.infer<typeof SuccessOutputSchema>;

interface ReflectionPrepared {
	recentMessages: Memory[];
	entities: Entity[];
	existingRelationships: Awaited<ReturnType<IAgentRuntime["getRelationships"]>>;
}

interface FactPrepared extends ReflectionPrepared {
	knownFacts: Memory[];
}

interface SuccessPrepared extends ReflectionPrepared {
	actionResults: ActionResult[];
}

interface FactCandidate {
	memory: Memory;
	searchText: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function toJsonObject(value: Record<string, unknown>): {
	[key: string]: JsonValue;
} {
	return JSON.parse(JSON.stringify(value)) as { [key: string]: JsonValue };
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function asUuidOrNull(value: unknown): UUID | null {
	if (typeof value !== "string") return null;
	try {
		return asUUID(value.trim());
	} catch {
		// error-policy:J3 reflection metadata is untrusted persisted input; an
		// invalid UUID is an explicit parse miss.
		return null;
	}
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function pickFactConfidence(memory: Memory): number {
	const value = readFactMetadata(memory).confidence;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return NEW_FACT_CONFIDENCE;
}

function readFactKind(memory: Memory): FactKind {
	const kind = readFactMetadata(memory).kind;
	if (kind === "current") return "current";
	return "durable";
}

function readCategory(memory: Memory): string {
	const category = readFactMetadata(memory).category;
	if (typeof category === "string" && category.length > 0) return category;
	return "uncategorized";
}

function readEffectiveValidAt(memory: Memory): string | null {
	const validAt = readFactMetadata(memory).validAt;
	if (typeof validAt === "string" && validAt.length > 0) return validAt;
	if (
		typeof memory.createdAt === "number" &&
		Number.isFinite(memory.createdAt)
	) {
		return new Date(memory.createdAt).toISOString();
	}
	return null;
}

function partitionByKind(memories: Memory[]): {
	durable: Memory[];
	current: Memory[];
} {
	const durable: Memory[] = [];
	const current: Memory[] = [];
	for (const memory of memories) {
		if (readFactKind(memory) === "current") current.push(memory);
		else durable.push(memory);
	}
	return { durable, current };
}

function formatKnownDurableLine(memory: Memory): string {
	const id = memory.id ?? "";
	const text = memory.content.text ?? "";
	if (!id || !text) return "";
	return `[${id}] (durable.${readCategory(memory)}) ${text}`;
}

function formatKnownCurrentLine(memory: Memory): string {
	const id = memory.id ?? "";
	const text = memory.content.text ?? "";
	if (!id || !text) return "";
	const since = readEffectiveValidAt(memory) ?? "unknown";
	return `[${id}] (current.${readCategory(memory)}, since ${since}) ${text}`;
}

function formatKnownLines(memories: Memory[], kind: FactKind): string {
	const lines: string[] = [];
	for (const memory of memories) {
		const line =
			kind === "durable"
				? formatKnownDurableLine(memory)
				: formatKnownCurrentLine(memory);
		if (line) lines.push(line);
	}
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

export { formatRecentMessages };

function formatEntities(entities: Entity[]): string {
	if (entities.length === 0) return "(none)";
	return entities
		.map((entity) => {
			const names = Array.isArray(entity.names) ? entity.names.join(", ") : "";
			return `- ${names || "unknown"} (ID: ${entity.id ?? "unknown"})`;
		})
		.join("\n");
}

function formatRelationships(
	relationships: ReflectionPrepared["existingRelationships"],
): string {
	if (relationships.length === 0) return "(none)";
	return JSON.stringify(
		relationships.map((relationship) => ({
			sourceEntityId: relationship.sourceEntityId,
			targetEntityId: relationship.targetEntityId,
			tags: relationship.tags,
			relationshipType: (
				relationship.metadata as { relationshipType?: string } | undefined
			)?.relationshipType,
		})),
		null,
		2,
	);
}

function actionResultsFromState(state: State | undefined): ActionResult[] {
	const raw = state?.data?.actionResults;
	return Array.isArray(raw)
		? raw.filter(
				(value): value is ActionResult =>
					value !== null && typeof value === "object" && "success" in value,
			)
		: [];
}

const reflectionContexts = new WeakMap<
	IAgentRuntime,
	WeakMap<Memory | Memory[], Promise<ReflectionPrepared>>
>();

async function prepareReflectionContext(
	runtime: IAgentRuntime,
	message: Memory,
	options: EvaluatorRunOptions,
): Promise<ReflectionPrepared> {
	let contexts = reflectionContexts.get(runtime);
	if (!contexts) {
		contexts = new WeakMap();
		reflectionContexts.set(runtime, contexts);
	}
	const key = options.extraction?.messages ?? message;
	const existing = contexts.get(key);
	if (existing) return existing;
	const prepared = (async () => {
		const agentId = message.agentId ?? runtime.agentId;
		const [recentMessages, existingRelationships, entities] = await Promise.all(
			[
				options.extraction?.messages ?? getRoomTranscript(runtime, message),
				runtime.getRelationships({
					entityIds: message.entityId ? [message.entityId, agentId] : [agentId],
				}),
				getEntityDetails({ runtime, roomId: message.roomId }),
			],
		);
		return {
			recentMessages,
			existingRelationships,
			entities,
		};
	})();
	contexts.set(key, prepared);
	try {
		return await prepared;
	} catch (error) {
		// error-policy:J2 Clear message-scoped evaluator state before preserving the
		// original failure for the evaluator boundary.
		contexts.delete(key);
		throw error;
	}
}

async function prepareFacts(
	runtime: IAgentRuntime,
	message: Memory,
	options: EvaluatorRunOptions,
): Promise<FactPrepared> {
	const [base, roomFacts, entityFacts] = await Promise.all([
		prepareReflectionContext(runtime, message, options),
		runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			worldId: message.worldId,
			unique: false,
		}),
		message.entityId
			? runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					entityId: message.entityId,
					authorEntityIds: [message.entityId],
					unique: false,
				})
			: Promise.resolve([]),
	]);
	const seen = new Set<string>();
	const knownFacts: Memory[] = [];
	for (const fact of [...roomFacts, ...entityFacts]) {
		if (!fact.id || seen.has(fact.id) || !isActiveMemoryEvidence(fact))
			continue;
		seen.add(fact.id);
		knownFacts.push(fact);
	}
	return { ...base, knownFacts };
}

/** `content.source` / `metadata.source` the MEMORY action stamps on facts it stores verbatim for the user. */
const EXPLICIT_MEMORY_SOURCE = "MEMORY";

function isExplicitMemoryFact(memory: Memory): boolean {
	const metadataSource = (memory.metadata as { source?: unknown } | undefined)
		?.source;
	return (
		metadataSource === EXPLICIT_MEMORY_SOURCE ||
		memory.content?.source === EXPLICIT_MEMORY_SOURCE
	);
}

/** Suppress only equivalent claims with the same structured meaning and date. */
function findDedupTarget(
	candidates: FactCandidate[],
	claim: string,
	structuredFields: Record<string, unknown>,
	kind: FactKind,
	category: string,
	validAt?: string,
): Memory | null {
	for (const candidate of candidates) {
		if (!factClaimsEquivalent(claim, candidate.memory.content.text ?? ""))
			continue;
		if (isExplicitMemoryFact(candidate.memory)) {
			return candidate.memory;
		}
		if (readFactKind(candidate.memory) !== kind) continue;
		if (readCategory(candidate.memory) !== category) continue;
		const metadata = readFactMetadata(candidate.memory);
		if (
			stableStringify(metadata.structuredFields ?? {}) !==
			stableStringify(structuredFields)
		)
			continue;
		if (validAt !== undefined && metadata.validAt !== validAt) continue;
		return candidate.memory;
	}
	return null;
}

interface ApplyContext {
	runtime: IAgentRuntime;
	message: Memory;
	candidatePool: FactCandidate[];
	candidatesById: Map<string, Memory>;
	insertedThisRun: FactCandidate[];
	extraction?: EvaluatorRunOptions["extraction"];
}

/** Persist evidence beside the effect, so a retried frozen batch cannot reinforce it twice. */
export function extractionEvidenceMetadata(
	metadata: MemoryMetadata | undefined,
	extraction: EvaluatorRunOptions["extraction"],
): Record<string, JsonValue> {
	if (!extraction) return {};
	const existing = metadata as CustomMetadata | undefined;
	const evidenceIds: string[] = [];
	if (Array.isArray(existing?.extractionEvidenceIds)) {
		for (const id of existing.extractionEvidenceIds)
			if (typeof id === "string") evidenceIds.push(id);
	}
	const sourceRevisions = existing?.extractionSourceRevisions;
	return {
		extractionBackfill: extraction.isBackfill,
		extractionEvidenceIds: [
			...new Set([...evidenceIds, extraction.evidenceId]),
		],
		extractionSourceRevisions: {
			...(sourceRevisions &&
			typeof sourceRevisions === "object" &&
			!Array.isArray(sourceRevisions)
				? Object.fromEntries(
						Object.entries(sourceRevisions).filter(
							([, revision]) => typeof revision === "string",
						),
					)
				: {}),
			...extraction.referenceRevisions,
			...extraction.sourceRevisions,
		},
	};
}

/** Cite only the speaker's selected evidence. Supplied agent dialogue remains
 * reference context, so changing an accepted proposal invalidates the fact.
 * Other participants' statements never become this user's personal evidence. */
export function personalExtractionEvidence(
	message: Memory,
	extraction: EvaluatorRunOptions["extraction"],
	sourceMessageIds: readonly string[] | undefined,
): EvaluatorRunOptions["extraction"] {
	if (!extraction) return undefined;
	const ids = [...new Set(sourceMessageIds ?? [])];
	const messages = ids.map((id) =>
		extraction.messages.find((row) => row.id === id),
	);
	if (
		!ids.length ||
		messages.some(
			(row, index) =>
				!row ||
				row.entityId !== message.entityId ||
				row.roomId !== message.roomId ||
				!Object.hasOwn(extraction.sourceRevisions, ids[index]),
		)
	) {
		throw new ElizaError(
			"Personal memory extraction requires cited evidence from the current speaker's selected messages",
			{ code: "EVALUATOR_PERSONAL_SOURCE_REQUIRED" },
		);
	}
	return {
		...extraction,
		messages: messages.filter((row): row is Memory => Boolean(row)),
		referenceRevisions: {
			...extraction.referenceRevisions,
			...Object.fromEntries(
				extraction.messages
					.filter(
						(row) =>
							row.id &&
							row.entityId === message.agentId &&
							row.roomId === message.roomId &&
							!ids.includes(row.id) &&
							Object.hasOwn(extraction.sourceRevisions, row.id),
					)
					.map((row) => [
						String(row.id),
						extraction.sourceRevisions[String(row.id)],
					]),
			),
		},
		sourceRevisions: Object.fromEntries(
			ids.map((id) => [id, extraction.sourceRevisions[id]]),
		),
	};
}

export function assertPersonalExtractionOperations(
	message: Memory,
	extraction: EvaluatorRunOptions["extraction"],
	ops: readonly { sourceMessageIds?: readonly string[] }[],
): void {
	if (!extraction) return;
	for (const op of ops)
		personalExtractionEvidence(message, extraction, op.sourceMessageIds);
}

export function hasExtractionEvidence(
	metadata: MemoryMetadata | undefined,
	extraction: EvaluatorRunOptions["extraction"],
): boolean {
	const evidenceIds = (metadata as CustomMetadata | undefined)
		?.extractionEvidenceIds;
	return Boolean(
		extraction &&
			Array.isArray(evidenceIds) &&
			evidenceIds.includes(extraction.evidenceId),
	);
}

export async function updateExtractedFact(
	runtime: IAgentRuntime,
	fact: Memory,
	metadata: CustomMetadata,
): Promise<void> {
	if (!fact.id)
		throw new ElizaError("Extracted fact has no persisted id", {
			code: "EXTRACTED_FACT_ID_MISSING",
		});
	if ((await runtime.updateMemory({ id: fact.id, metadata })) === false) {
		throw new ElizaError("Extracted fact update was not persisted", {
			code: "EXTRACTED_FACT_WRITE_FAILED",
			context: { factId: fact.id },
		});
	}
	fact.metadata = metadata;
}

/** An edited source needs reconciliation, not deletion of an already reviewed claim. */
export async function reviewChangedExtractionSources(
	runtime: IAgentRuntime,
	facts: Memory[],
	extraction: EvaluatorRunOptions["extraction"],
): Promise<number> {
	if (!extraction) return 0;
	let reviewed = 0;
	for (const fact of facts) {
		if (isProtectedMemoryEvidence(fact)) continue;
		const metadata = fact.metadata as CustomMetadata | undefined;
		const revisions = metadata?.extractionSourceRevisions;
		if (!revisions || typeof revisions !== "object" || Array.isArray(revisions))
			continue;
		const changed = Object.entries(revisions)
			.filter(
				([id, revision]) =>
					extraction.removedMessageIds.includes(id) ||
					(extraction.sourceRevisions[id] !== undefined &&
						extraction.sourceRevisions[id] !== revision),
			)
			.map(([id]) => id);
		if (changed.length === 0) continue;
		await updateExtractedFact(runtime, fact, {
			...preserveFactMetadata(fact),
			extractionReviewRequired: true,
			extractionChangedSourceIds: changed,
		});
		reviewed += 1;
	}
	assertExtractionSourcesUnchanged(extraction);
	return reviewed;
}

async function insertFact(
	ctx: ApplyContext,
	args: {
		claim: string;
		kind: FactKind;
		category: DurableFactCategory | CurrentFactCategory | string;
		structuredFields: Record<string, unknown>;
		keywords: string[];
		verificationStatus: FactVerificationStatus | undefined;
		validAt: string | undefined;
	},
): Promise<UUID | null> {
	const factId = ctx.extraction
		? stringToUuid(
				`fact:${ctx.runtime.agentId}:${ctx.message.entityId}:${ctx.message.roomId}:${ctx.extraction.evidenceId}:${stableStringify(args)}`,
			)
		: asUUID(v4());
	const verificationStatus: FactVerificationStatus =
		args.verificationStatus ?? "self_reported";
	const metadata: MemoryMetadata = {
		type: MemoryType.CUSTOM,
		source: "fact_extractor",
		confidence: NEW_FACT_CONFIDENCE,
		lastConfirmedAt: nowIso(),
		kind: args.kind,
		category: args.category,
		structuredFields: toJsonObject(args.structuredFields),
		keywords: args.keywords,
		verificationStatus,
		...(args.validAt ? { validAt: args.validAt } : {}),
		...extractionEvidenceMetadata(undefined, ctx.extraction),
	};
	const memory: Memory = {
		id: factId,
		entityId: ctx.message.entityId,
		agentId: ctx.runtime.agentId,
		roomId: ctx.message.roomId,
		content: { text: args.claim },
		metadata,
		createdAt: Date.now(),
	};
	const persistedId = await ctx.runtime.createMemory(memory, "facts", true);
	if (ctx.extraction && !persistedId)
		throw new ElizaError("Extracted fact insert was not persisted", {
			code: "EXTRACTED_FACT_WRITE_FAILED",
		});
	return persistedId;
}

export function preserveFactMetadata(fact: Memory): CustomMetadata {
	const meta = readFactMetadata(fact);
	const normalizedStructured =
		meta.structuredFields && typeof meta.structuredFields === "object"
			? toJsonObject(meta.structuredFields)
			: undefined;
	const next: CustomMetadata = {
		...(fact.metadata as CustomMetadata),
		type: MemoryType.CUSTOM,
		...(typeof meta.confidence === "number"
			? { confidence: meta.confidence }
			: {}),
		...(typeof meta.lastReinforced === "string"
			? { lastReinforced: meta.lastReinforced }
			: {}),
		...(typeof meta.sourceTrajectoryId === "string"
			? { sourceTrajectoryId: meta.sourceTrajectoryId }
			: {}),
		...(meta.kind ? { kind: meta.kind } : {}),
		...(typeof meta.category === "string" ? { category: meta.category } : {}),
		...(normalizedStructured ? { structuredFields: normalizedStructured } : {}),
		...(Array.isArray(meta.keywords) ? { keywords: [...meta.keywords] } : {}),
		...(typeof meta.validAt === "string" ? { validAt: meta.validAt } : {}),
		...(typeof meta.lastConfirmedAt === "string"
			? { lastConfirmedAt: meta.lastConfirmedAt }
			: {}),
		...(meta.verificationStatus
			? { verificationStatus: meta.verificationStatus }
			: {}),
	};
	return next;
}

async function applyStrengthenForMemory(
	ctx: ApplyContext,
	fact: Memory,
): Promise<boolean> {
	if (!fact.id) return false;
	if (ctx.extraction) {
		const current = await ctx.runtime.getMemoryById(fact.id);
		if (!current) return false;
		fact = current;
	}
	if (hasExtractionEvidence(fact.metadata, ctx.extraction)) return false;
	// A first checkpoint may cover evidence already consumed by the legacy
	// extractor. Record its provenance without presenting it as new evidence.
	if (ctx.extraction?.isBackfill) {
		await updateExtractedFact(ctx.runtime, fact, {
			...preserveFactMetadata(fact),
			...extractionEvidenceMetadata(fact.metadata, ctx.extraction),
		});
		return false;
	}
	const nextConfidence = clamp01(pickFactConfidence(fact) + STRENGTHEN_DELTA);
	const nextMeta: CustomMetadata = {
		...preserveFactMetadata(fact),
		confidence: nextConfidence,
		lastConfirmedAt: nowIso(),
		...extractionEvidenceMetadata(fact.metadata, ctx.extraction),
	};
	await updateExtractedFact(ctx.runtime, fact, nextMeta);
	return true;
}

async function applyAddDurable(
	ctx: ApplyContext,
	op: AddDurableOp,
): Promise<{ added: boolean; strengthened: boolean }> {
	const keywords = buildFactKeywordsForStorage(
		op.keywords ?? [],
		op.claim,
		op.category,
		op.structured_fields,
	);
	const dedupTarget = findDedupTarget(
		[...ctx.candidatePool, ...ctx.insertedThisRun],
		op.claim,
		op.structured_fields,
		"durable",
		op.category,
	);
	if (dedupTarget) {
		return {
			added: false,
			strengthened: await applyStrengthenForMemory(ctx, dedupTarget),
		};
	}
	const factId = await insertFact(ctx, {
		claim: op.claim,
		kind: "durable",
		category: op.category,
		structuredFields: op.structured_fields,
		keywords,
		verificationStatus: op.verification_status,
		validAt: undefined,
	});
	if (factId) {
		const inserted = await ctx.runtime.getMemoryById(factId);
		if (inserted) {
			ctx.insertedThisRun.push({
				memory: inserted,
				searchText: buildFactSearchText(inserted),
			});
			ctx.candidatesById.set(factId, inserted);
		}
	}
	return { added: factId != null, strengthened: false };
}

async function applyAddCurrent(
	ctx: ApplyContext,
	op: AddCurrentOp,
): Promise<{ added: boolean; strengthened: boolean }> {
	const keywords = buildFactKeywordsForStorage(
		op.keywords ?? [],
		op.claim,
		op.category,
		op.structured_fields,
	);
	const dedupTarget = findDedupTarget(
		[...ctx.candidatePool, ...ctx.insertedThisRun],
		op.claim,
		op.structured_fields,
		"current",
		op.category,
		op.valid_at,
	);
	if (dedupTarget) {
		return {
			added: false,
			strengthened: await applyStrengthenForMemory(ctx, dedupTarget),
		};
	}
	const validAt =
		typeof op.valid_at === "string" && op.valid_at.length > 0
			? op.valid_at
			: ctx.extraction
				? new Date(
						typeof ctx.message.createdAt === "number" &&
							Number.isFinite(ctx.message.createdAt)
							? ctx.message.createdAt
							: 0,
					).toISOString()
				: nowIso();
	const factId = await insertFact(ctx, {
		claim: op.claim,
		kind: "current",
		category: op.category,
		structuredFields: op.structured_fields,
		keywords,
		verificationStatus: undefined,
		validAt,
	});
	if (factId) {
		const inserted = await ctx.runtime.getMemoryById(factId);
		if (inserted) {
			ctx.insertedThisRun.push({
				memory: inserted,
				searchText: buildFactSearchText(inserted),
			});
			ctx.candidatesById.set(factId, inserted);
		}
	}
	return { added: factId != null, strengthened: false };
}

async function applyStrengthen(
	ctx: ApplyContext,
	op: StrengthenOp,
): Promise<boolean> {
	const fact = ctx.candidatesById.get(op.factId);
	if (!fact?.id) return false;
	return applyStrengthenForMemory(ctx, fact);
}

async function applyDecay(ctx: ApplyContext, op: DecayOp): Promise<boolean> {
	let fact = ctx.candidatesById.get(op.factId);
	if (!fact?.id) return false;
	if (ctx.extraction) {
		fact = (await ctx.runtime.getMemoryById(fact.id)) ?? undefined;
		if (!fact?.id) return false;
	}
	if (hasExtractionEvidence(fact.metadata, ctx.extraction)) return false;
	const nextConfidence = clamp01(pickFactConfidence(fact) - DECAY_DELTA);
	if (ctx.extraction?.isBackfill) {
		await updateExtractedFact(ctx.runtime, fact, {
			...preserveFactMetadata(fact),
			...extractionEvidenceMetadata(fact.metadata, ctx.extraction),
		});
		return false;
	}
	if (nextConfidence < FACT_DECAY_FLOOR) {
		await ctx.runtime.deleteMemory(fact.id);
		return true;
	}
	const nextMeta: CustomMetadata = {
		...preserveFactMetadata(fact),
		confidence: nextConfidence,
		...extractionEvidenceMetadata(fact.metadata, ctx.extraction),
	};
	await updateExtractedFact(ctx.runtime, fact, nextMeta);
	return true;
}

async function applyContradict(
	ctx: ApplyContext,
	op: ContradictOp,
): Promise<boolean> {
	const fact = ctx.candidatesById.get(op.factId);
	if (!fact || !ctx.message.entityId) return false;
	if (op.proposedText.trim() === (fact.content.text ?? "").trim()) return false;
	await recordFactCandidate(ctx.runtime, {
		entityId: ctx.message.entityId,
		kind: "contradict",
		existingFactId: asUuidOrNull(fact.id) ?? undefined,
		proposedText: op.proposedText,
		reason: op.reason,
		evidenceMessageId: asUuidOrNull(ctx.message.id) ?? undefined,
		extractionEvidenceId: ctx.extraction?.evidenceId,
	});
	return true;
}

async function applyRelationshipUpdates(
	runtime: IAgentRuntime,
	relationships: RelationshipUpdate[],
	entities: Entity[],
	extraction: EvaluatorRunOptions["extraction"],
): Promise<number> {
	if (relationships.length === 0) return 0;
	const knownEntityIds = new Set(
		entities.map((entity) => entity.id).filter((id): id is UUID => Boolean(id)),
	);
	let applied = 0;
	// One evidence batch may describe several aspects of the same edge. Merge
	// those before writing its receipt so no later aspect is mistaken for replay.
	const updates = new Map<string, RelationshipUpdate>();
	for (const relationship of relationships) {
		const key = `${relationship.sourceEntityId}:${relationship.targetEntityId}`;
		const previous = updates.get(key);
		updates.set(
			key,
			previous
				? {
						...previous,
						...relationship,
						tags: [
							...new Set([
								...(previous.tags ?? []),
								...(relationship.tags ?? []),
							]),
						],
						metadata: { ...previous.metadata, ...relationship.metadata },
					}
				: relationship,
		);
	}
	for (const relationship of updates.values()) {
		const sourceId = asUuidOrNull(relationship.sourceEntityId);
		const targetId = asUuidOrNull(relationship.targetEntityId);
		if (!sourceId || !targetId) continue;
		if (!knownEntityIds.has(sourceId) || !knownEntityIds.has(targetId))
			continue;
		if (sourceId === targetId) continue;

		const existing = (
			await runtime.getRelationships({ entityIds: [sourceId] })
		).find((candidate) => candidate.targetEntityId === targetId);
		const tags = Array.isArray(relationship.tags)
			? relationship.tags.map((tag) => tag.trim()).filter(Boolean)
			: [];

		// Existing relationship context reads metadata.relationshipType; preserve
		// the explicit extraction field through that canonical storage contract.
		const semanticMetadata = {
			...(relationship.metadata ?? {}),
			...(relationship.relationshipType
				? { relationshipType: relationship.relationshipType }
				: {}),
		};
		if (existing) {
			if (
				hasExtractionEvidence(existing.metadata as MemoryMetadata, extraction)
			)
				continue;
			const updatedMetadata = {
				...existing.metadata,
				interactions:
					((existing.metadata?.interactions as number | undefined) || 0) +
					(extraction?.isBackfill ? 0 : 1),
				...semanticMetadata,
				...extractionEvidenceMetadata(
					existing.metadata as MemoryMetadata,
					extraction,
				),
			};
			const updatedTags = Array.from(
				new Set([...(existing.tags || []), ...tags]),
			);
			await runtime.updateRelationship({
				...existing,
				tags: updatedTags,
				metadata: updatedMetadata,
			});
		} else {
			const created = await runtime.createRelationship({
				sourceEntityId: sourceId,
				targetEntityId: targetId,
				tags,
				metadata: {
					interactions: 1,
					...semanticMetadata,
					...extractionEvidenceMetadata(undefined, extraction),
				},
			});
			if (created === false)
				throw new ElizaError("Extracted relationship was not persisted", {
					code: "EXTRACTED_RELATIONSHIP_WRITE_FAILED",
				});
		}
		applied += 1;
	}
	return applied;
}

function assertIdentitySources(
	runtime: IAgentRuntime,
	message: Memory,
	prepared: ReflectionPrepared,
	identities: IdentityUpdate[],
	options: EvaluatorRunOptions,
): void {
	for (const identity of identities) {
		if (identity.sourceMessageId === undefined) continue;
		const source = prepared.recentMessages.find(
			(row) => row.id === identity.sourceMessageId,
		);
		if (
			!asUuidOrNull(identity.sourceMessageId) ||
			!source ||
			source.entityId === runtime.agentId ||
			source.roomId !== message.roomId ||
			isSyntheticConversationArtifactMemory(source) ||
			(options.extraction &&
				!Object.hasOwn(
					options.extraction.sourceRevisions,
					identity.sourceMessageId,
				))
		) {
			throw new ElizaError(
				"Identity extraction requires an original selected non-agent source",
				{
					code: "EVALUATOR_IDENTITY_SOURCE_REQUIRED",
				},
			);
		}
	}
}

async function applyIdentityUpdates(
	runtime: IAgentRuntime,
	identities: IdentityUpdate[],
	entities: Entity[],
	messageId: UUID | undefined,
): Promise<number> {
	if (identities.length === 0) return 0;
	const relationshipsService = runtime.getService(
		"relationships",
	) as RelationshipsService | null;
	if (
		!relationshipsService ||
		typeof relationshipsService.upsertIdentity !== "function"
	) {
		return 0;
	}

	const knownEntityIds = new Set(
		entities.map((entity) => entity.id).filter((id): id is UUID => Boolean(id)),
	);
	let applied = 0;
	for (const identity of identities) {
		if (identity.confidence < IDENTITY_CONFIDENCE_THRESHOLD) continue;
		const entityId = asUuidOrNull(identity.entityId);
		if (!entityId || !knownEntityIds.has(entityId)) continue;
		const platform = identity.platform.trim().toLowerCase();
		const handle = identity.handle.trim();
		if (!platform || !handle) continue;
		const sourceId = asUuidOrNull(identity.sourceMessageId) ?? messageId;
		await relationshipsService.upsertIdentity(
			entityId,
			{
				platform,
				handle,
				verified: false,
				confidence: identity.confidence,
				source: "reflection",
			},
			sourceId ? [sourceId] : [],
		);
		applied += 1;
	}
	return applied;
}

function normalizeTaskCompletion(
	task: SuccessOutput,
	messageId?: UUID,
): TaskCompletionAssessment {
	const reason = task.reason.trim();
	return {
		assessed: true,
		completed: task.completed,
		reason:
			reason ||
			(task.completed
				? "The task is complete."
				: "The task is not complete yet."),
		source: "reflection",
		evaluatedAt: Date.now(),
		messageId,
	};
}

async function storeTaskCompletionReflection(
	runtime: IAgentRuntime,
	message: Memory,
	task: SuccessOutput,
	taskCompletion: TaskCompletionAssessment,
	extraction: EvaluatorRunOptions["extraction"],
): Promise<void> {
	const summaryText = `Task completion reflection: ${
		taskCompletion.completed ? "completed" : "incomplete"
	}. ${taskCompletion.reason}`;

	const reflection: Memory = {
		id: extraction
			? stringToUuid(
					`success:${runtime.agentId}:${message.roomId}:${extraction.evidenceId}`,
				)
			: asUUID(v4()),
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId: message.roomId,
		content: {
			text: summaryText,
			type: "task_completion_reflection",
		},
		metadata: {
			type: MemoryType.CUSTOM,
			source: "reflection",
			messageId: message.id,
			taskCompleted: taskCompletion.completed,
			taskAssessed: taskCompletion.assessed,
			taskCompletionReason: taskCompletion.reason,
			reflectionThought: task.thought ?? "",
			tags: ["reflection", "task_completion"],
			evaluatedAt: taskCompletion.evaluatedAt,
			...extractionEvidenceMetadata(undefined, extraction),
		},
		createdAt: Date.now(),
	};
	if (extraction) await runtime.upsertMemory(reflection, "memories");
	else await runtime.createMemory(reflection, "memories");

	if (message.id) {
		await runtime.setCache<TaskCompletionAssessment>(
			getTaskCompletionCacheKey(message.id),
			taskCompletion,
		);
	}
}

export function canEvaluateMessage(
	message: Memory,
	options?: { semanticSignal?: boolean },
): boolean {
	return Boolean(
		options?.semanticSignal !== false &&
			message.content.text?.trim() &&
			message.entityId &&
			message.roomId &&
			!isSyntheticConversationArtifactMemory(message),
	);
}

function renderFactMemoryPromptSegments({
	prepared,
	shared,
	message,
}: {
	prepared: FactPrepared;
	shared?: EvaluatorSharedPromptContext;
	message: Memory;
}): PromptSegment[] {
	const { durable, current } = partitionByKind(prepared.knownFacts);

	return [
		{
			content: `Find stable/current facts about speaker.

Fact stores:
- durable: identity-level claims matter in a year. Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: now/near-term state. Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- Fiction, examples, roleplay, and hypothetical stories are not personal facts about the speaker. Do not store them as personal memories.
- Explicit requests to remember, edit, or forget a fact are owned by the MEMORY action; do not duplicate or undo that requested operation. Independently stated new facts can still be extracted.
- Only extract claims grounded in this speaker's own new messages. Other participants, historical reference messages, and stored facts are context, not new evidence to reinforce or new claims about this speaker.
- In incremental extraction, EVERY operation must include sourceMessageIds citing selected new message IDs authored by this speaker. Never cite reference messages or other speakers. Omit unsupported operations.
- No meaningful new/changed fact -> {"ops":[]}.
- Existing meaning -> strengthen with factId.
- Contradiction -> contradict with factId + reason + proposedText. proposedText must be a nonblank, complete corrected claim grounded in the user's correction, preserving unchanged details. Do not copy the old contradicted claim or invent a missing replacement; omit the op when a complete corrected claim is not supported. This queues a pending review proposal, not an applied fact replacement.
- Use only fact IDs shown below for strengthen, decay, and contradict.
- add_durable/add_current keywords: 3-8 lowercase retrieval terms from claim/category/nouns/places/dates/projects/symptoms/preferences. Omit stopwords/generic.
- add_durable/add_current structured_fields: flat string values from the claim. Use English key names even when the message is in another language.
  identity: preferredName, location/city, timezone, locale, orientation, gender, age.
  relationship: person or partnerName, relationshipType, relationshipStatus, platform, handle.
  business_role: company/organization/employer, person, relationshipType, role.
  preference: preferredNotificationChannel, travelBookingPreferences, locale.
  health/current state: condition, source, emotion, window.
  life_event/goal: event, to, goal, domain.
  Omit unknown fields; do not invent values.

`,
			stable: true,
		},
		{
			content: `Speaker entity id: ${message.entityId}
${recentMessagesSection(shared, prepared.recentMessages)}

Known durable facts:
${formatKnownLines(durable, "durable")}

Known current facts:
${formatKnownLines(current, "current")}`,
			stable: false,
		},
	];
}

export const factMemoryEvaluator: Evaluator<ExtractorOutput, FactPrepared> = {
	name: "factMemory",
	resolveOutputWhen: hasNoPersonalExtractionSources,
	resolveOutput: () => ({ ops: [] }),
	reconcileEvidence: reconcileFactEvidence,
	incremental: true,
	background: true,
	description:
		"Extracts durable/current fact-store ops from recent conversation.",
	priority: EvaluatorPriority.REFLECTION_FACTS,
	schema: factOpsSchema,
	async shouldRun({ message, options }) {
		return canEvaluateMessage(message, options);
	},
	async prepare({ runtime, message, options }) {
		return prepareFacts(runtime, message, options);
	},
	promptSegments: renderFactMemoryPromptSegments,
	prompt(context) {
		return renderFactMemoryPromptSegments(context)
			.map((segment) => segment.content)
			.join("");
	},
	parse(output, context) {
		// Tolerant, op-by-op: a single malformed op must not discard the whole
		// turn's valid fact ops. Drops are logged inside
		// parseExtractorOutputTolerant — this parse contract has no
		// runtime/logger, so it could never report them. Returns null only when
		// the envelope itself isn't `{ ops: [...] }`.
		const parsed = parseExtractorOutputTolerant(output);
		if (parsed && context)
			assertPersonalExtractionOperations(
				context.message,
				context.options.extraction,
				parsed.ops,
			);
		return parsed;
	},
	processors: [
		{
			name: "applyFactOps",
			async process({ runtime, message, prepared, output, options }) {
				assertPersonalExtractionOperations(
					message,
					options.extraction,
					output.ops,
				);
				const writableFacts = options.extraction
					? prepared.knownFacts.filter(
							(fact) => fact.entityId === message.entityId,
						)
					: prepared.knownFacts;
				const sourceReviews = await reviewChangedExtractionSources(
					runtime,
					writableFacts,
					options.extraction,
				);
				const candidatePool: FactCandidate[] = writableFacts.map((memory) => ({
					memory,
					searchText: buildFactSearchText(memory),
				}));
				const candidatesById = new Map<string, Memory>();
				for (const memory of writableFacts) {
					if (memory.id) candidatesById.set(memory.id, memory);
				}
				const ctx: ApplyContext = {
					runtime,
					message,
					candidatePool,
					candidatesById,
					insertedThisRun: [],
					extraction: options.extraction,
				};
				let added = 0;
				let strengthened = 0;
				let decayed = 0;
				let contradicted = 0;
				for (const op of output.ops as ExtractorOp[]) {
					ctx.extraction = personalExtractionEvidence(
						message,
						options.extraction,
						op.sourceMessageIds,
					);
					if (op.op === "add_durable") {
						const result = await applyAddDurable(ctx, op);
						if (result.added) added += 1;
						if (result.strengthened) strengthened += 1;
						continue;
					}
					if (op.op === "add_current") {
						const result = await applyAddCurrent(ctx, op);
						if (result.added) added += 1;
						if (result.strengthened) strengthened += 1;
						continue;
					}
					if (op.op === "strengthen") {
						if (await applyStrengthen(ctx, op)) strengthened += 1;
						continue;
					}
					if (op.op === "decay") {
						if (await applyDecay(ctx, op)) decayed += 1;
						continue;
					}
					if (op.op === "contradict") {
						if (await applyContradict(ctx, op)) contradicted += 1;
					}
				}
				return {
					success: true,
					values: { added, strengthened, decayed, contradicted },
					data: {
						added,
						strengthened,
						decayed,
						contradicted,
						...(options.extraction ? { sourceReviews } : {}),
					},
				};
			},
		},
	],
};

function renderRelationshipPromptSegments({
	prepared,
	shared,
}: {
	prepared: ReflectionPrepared;
	shared?: EvaluatorSharedPromptContext;
}): PromptSegment[] {
	return [
		{
			content: `Find semantic relationship changes between participants.

Rules:
- Return only clearly supported relationships.
- Use exact UUIDs from Entities in Room. Do not use names or placeholders.
- Directional: sourceEntityId initiates, targetEntityId receives.
- Include relationshipType for the supported relationship, such as "colleague".
- Use tags for any additional supported labels; do not invent a relationship type.
- Nothing changed -> {"relationships":[]}.

`,
			stable: true,
		},
		{
			content: `${recentMessagesSection(shared, prepared.recentMessages)}

Entities in Room:
${formatEntities(prepared.entities)}

Existing relationships:
${formatRelationships(prepared.existingRelationships)}`,
			stable: false,
		},
	];
}

export const relationshipEvaluator: Evaluator<
	z.infer<typeof RelationshipOutputSchema>,
	ReflectionPrepared
> = {
	name: "relationships",
	incremental: true,
	background: true,
	description: "Extracts relationship updates between known room participants.",
	priority: EvaluatorPriority.REFLECTION_RELATIONSHIPS,
	providers: ["CONVERSATION_PROXIMITY"],
	schema: relationshipSchema,
	async shouldRun({ message, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		return canEvaluateMessage(message, options);
	},
	async prepare({ runtime, message, options }) {
		return prepareReflectionContext(runtime, message, options);
	},
	promptSegments: renderRelationshipPromptSegments,
	prompt(context) {
		return renderRelationshipPromptSegments(context)
			.map((segment) => segment.content)
			.join("");
	},
	parse(output) {
		const result = RelationshipOutputSchema.safeParse(output);
		return result.success ? result.data : null;
	},
	processors: [
		{
			name: "applyRelationshipUpdates",
			async process({ runtime, prepared, output, options }) {
				await reviewChangedExtractionSources(runtime, [], options.extraction);
				const relationshipCount = await applyRelationshipUpdates(
					runtime,
					output.relationships,
					prepared.entities,
					options.extraction,
				);
				return {
					success: true,
					values: { relationshipCount },
					data: { relationshipCount },
				};
			},
		},
	],
};

function renderIdentityPromptSegments({
	prepared,
	shared,
	options,
}: {
	prepared: ReflectionPrepared;
	shared?: EvaluatorSharedPromptContext;
	options: EvaluatorRunOptions;
}): PromptSegment[] {
	return [
		{
			content: `Find explicit platform identity claims for known room participants.

Rules:
- Use exact UUIDs from Entities in Room.
- Only emit identities explicitly stated in the recent conversation.
- Do not invent identities or emit ambient public-figure mentions.
- platform is lowercase, such as twitter, github, telegram, discord, bluesky, farcaster, linkedin.
- confidence 0-1: higher for self-claims, lower for second-hand.
- sourceMessageId must be the original non-agent message explicitly asserting this identity, from the selected extraction messages. Never cite the triggering message merely because it triggered this batch. Emit separate observations when distinct messages assert the same identity; do not count unrelated context as corroboration.
- Nothing mentioned -> {"identities":[]}.

`,
			stable: true,
		},
		{
			content: `${
				shared?.roomTranscriptRendered && options.extraction
					? recentMessagesSection(shared, prepared.recentMessages)
					: `Recent messages:\n${formatRecentMessages(prepared.recentMessages, true)}`
			}

Entities in Room:
${formatEntities(prepared.entities)}`,
			stable: false,
		},
	];
}

export const identityEvaluator: Evaluator<
	z.infer<typeof IdentityOutputSchema>,
	ReflectionPrepared
> = {
	name: "identities",
	incremental: true,
	background: true,
	description: "Extracts platform identities for known room participants.",
	priority: EvaluatorPriority.REFLECTION_IDENTITY,
	schema: identitySchema,
	async shouldRun({ message, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		return canEvaluateMessage(message, options);
	},
	async prepare({ runtime, message, options }) {
		return prepareReflectionContext(runtime, message, options);
	},
	promptSegments: renderIdentityPromptSegments,
	prompt(context) {
		return renderIdentityPromptSegments(context)
			.map((segment) => segment.content)
			.join("");
	},
	parse(output, context) {
		const result = IdentityOutputSchema.safeParse(output);
		if (!result.success) return null;
		if (
			context?.outputSource === "model" &&
			result.data.identities.some((identity) => !identity.sourceMessageId)
		)
			return null;
		if (context)
			assertIdentitySources(
				context.runtime,
				context.message,
				context.prepared,
				result.data.identities,
				context.options,
			);
		return result.data;
	},
	processors: [
		{
			name: "applyIdentityUpdates",
			async process({ runtime, message, prepared, output, options }) {
				await reviewChangedExtractionSources(runtime, [], options.extraction);
				assertIdentitySources(
					runtime,
					message,
					prepared,
					output.identities,
					options,
				);
				const identitiesUpserted = await applyIdentityUpdates(
					runtime,
					output.identities,
					prepared.entities,
					asUuidOrNull(message.id) ?? undefined,
				);
				return {
					success: true,
					values: { identitiesUpserted },
					data: { identitiesUpserted },
				};
			},
		},
	],
};

function renderSuccessPromptSegments({
	prepared,
	options,
	shared,
}: {
	prepared: SuccessPrepared;
	options: EvaluatorRunOptions;
	shared?: EvaluatorSharedPromptContext;
}): PromptSegment[] {
	const actionResultsText = renderActionResultsForModel(
		prepared.actionResults,
	).text;
	const actionResultsSection =
		shared?.actionResultsText === actionResultsText
			? 'Action results: see "Action results" in the Shared Turn Context above.'
			: `Action results:\n${actionResultsText}`;
	return [
		{
			content: `Evaluate if current user task is complete after agent response.

Rules:
- completed=true only if user needs no more action/follow-up this turn.
- Clarifying question, failed action, pending work, or partial handling -> completed=false.
- Ground the reason in the conversation and action results.

`,
			stable: true,
		},
		{
			content: `Did respond: ${options.didRespond === true ? "true" : "false"}

${recentMessagesSection(shared, prepared.recentMessages)}

${actionResultsSection}`,
			stable: false,
		},
	];
}

export const successEvaluator: Evaluator<SuccessOutput, SuccessPrepared> = {
	name: "success",
	incremental: true,
	background: true,
	reconcileEvidence: reconcileSuccessEvidence,
	description: "Evaluates whether user task is complete this turn.",
	priority: EvaluatorPriority.REFLECTION_SUCCESS,
	schema: successSchema,
	async shouldRun({ message, options }) {
		assertExtractionSourcesUnchanged(options.extraction);
		return canEvaluateMessage(message, options);
	},
	async prepare({ runtime, message, state, options }) {
		const cachedActionResults = message.id
			? runtime.getActionResults(message.id)
			: [];
		return {
			...(await prepareReflectionContext(runtime, message, options)),
			actionResults:
				cachedActionResults.length > 0
					? cachedActionResults
					: actionResultsFromState(state),
		};
	},
	promptSegments: renderSuccessPromptSegments,
	prompt(context) {
		return renderSuccessPromptSegments(context)
			.map((segment) => segment.content)
			.join("");
	},
	parse(output) {
		const result = SuccessOutputSchema.safeParse(output);
		return result.success ? result.data : null;
	},
	processors: [
		{
			name: "storeSuccessAssessment",
			async process({ runtime, message, output, options }) {
				await reviewChangedExtractionSources(runtime, [], options.extraction);
				const taskCompletion = normalizeTaskCompletion(
					output,
					asUuidOrNull(message.id) ?? undefined,
				);
				await storeTaskCompletionReflection(
					runtime,
					message,
					output,
					taskCompletion,
					options.extraction,
				);
				return {
					success: true,
					text: formatTaskCompletionStatus(taskCompletion),
					values: {
						taskCompleted: taskCompletion.completed,
						taskCompletionAssessed: taskCompletion.assessed,
						taskCompletionReason: taskCompletion.reason,
					},
					data: {
						taskAssessed: taskCompletion.assessed,
						taskCompleted: taskCompletion.completed,
						taskCompletion,
					},
				};
			},
		},
	],
};

export const reflectionItems: RegisteredEvaluator[] = [
	factMemoryEvaluator,
	relationshipEvaluator,
	identityEvaluator,
	successEvaluator,
];
