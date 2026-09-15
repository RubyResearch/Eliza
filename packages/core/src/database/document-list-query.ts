/**
 * Shared document-list contract enforcement and in-memory execution for
 * database adapters. Native adapters advertise the versioned capability;
 * adapters without that exact contract fail before reading because pagination
 * APIs cannot prove complete, duplicate-free, snapshot-coherent results.
 */
import { ElizaError } from "../errors";
import {
	type DocumentFragmentQueryParams,
	type DocumentListCursor,
	type DocumentListQueryParams,
	type DocumentListQueryResult,
	type DocumentMutationSnapshot,
	type DocumentRequesterContext,
	type DocumentRevisionReplaceParams,
	type IDatabaseAdapter,
	type Memory,
	MemoryType,
	type UUID,
} from "../types";

export const DOCUMENT_LIST_QUERY_CAPABILITY_VERSION = 4 as const;
export const DOCUMENT_LIST_MAX_LIMIT = 100;
export const DOCUMENT_LIST_MAX_OFFSET = 10_000;
export const DOCUMENT_LIST_MAX_QUERY_LENGTH = 512;
export const DOCUMENT_LIST_MAX_TAGS = 32;
export const DOCUMENT_LIST_MAX_TAG_LENGTH = 128;
export const DOCUMENT_LIST_MAX_REQUESTER_ROOMS = 1_000;
export const DOCUMENT_REVISION_MAX_FRAGMENTS = 10_000;
export const DOCUMENT_DIRECT_GRANT_LIMIT = 1_000;

export interface DocumentListQueryCapableAdapter {
	readonly documentListQueryCapability: typeof DOCUMENT_LIST_QUERY_CAPABILITY_VERSION;
	queryDocuments(
		params: DocumentListQueryParams,
	): Promise<DocumentListQueryResult>;
}

const DOCUMENT_LIST_ROLES = new Set([
	"OWNER",
	"ADMIN",
	"USER",
	"GUEST",
	"AGENT",
	"RUNTIME",
	"UNRESOLVED",
]);
const DOCUMENT_LIST_SCOPES = new Set([
	"global",
	"owner-private",
	"user-private",
	"agent-private",
]);
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_SEARCH_SEPARATOR = /[ \t\r\n\f]+/;

function invalidPagination(
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, {
		code: "DOCUMENT_LIST_INVALID_PAGINATION",
		context,
	});
}

function isUuid(value: unknown): value is UUID {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeDocumentListCursor(
	value: unknown,
): DocumentListCursor | null {
	if (value === null || typeof value !== "object") return null;
	const cursor = value as Record<string, unknown>;
	if (!Number.isSafeInteger(cursor.createdAt) || !isUuid(cursor.id)) {
		return null;
	}
	const hasSnapshotCreatedAt = cursor.snapshotCreatedAt !== undefined;
	const hasSnapshotId = cursor.snapshotId !== undefined;
	if (hasSnapshotCreatedAt !== hasSnapshotId) return null;
	if (!hasSnapshotCreatedAt) {
		return { createdAt: cursor.createdAt as number, id: cursor.id };
	}
	if (
		!Number.isSafeInteger(cursor.snapshotCreatedAt) ||
		!isUuid(cursor.snapshotId)
	) {
		return null;
	}
	if (
		(cursor.createdAt as number) > (cursor.snapshotCreatedAt as number) ||
		((cursor.createdAt as number) === (cursor.snapshotCreatedAt as number) &&
			(cursor.id as UUID).toLowerCase() >
				(cursor.snapshotId as UUID).toLowerCase())
	) {
		return null;
	}
	return {
		createdAt: cursor.createdAt as number,
		id: cursor.id,
		snapshotCreatedAt: cursor.snapshotCreatedAt as number,
		snapshotId: cursor.snapshotId,
	};
}

function invalidDocumentListResult(
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, {
		code: "DOCUMENT_LIST_INVALID_RESULT",
		context,
		severity: "fatal",
	});
}

/** Validates the bounded runtime result returned by a database adapter. */
export function validateDocumentListQueryResult(
	value: unknown,
	params: DocumentListQueryParams,
): asserts value is DocumentListQueryResult {
	if (value === null || typeof value !== "object") {
		invalidDocumentListResult("Document list adapter returned a non-object", {
			resultType: typeof value,
		});
	}
	const result = value as Record<string, unknown>;
	for (const field of ["documents", "availableDocuments"] as const) {
		const rows = result[field];
		if (
			!Array.isArray(rows) ||
			rows.length > params.limit ||
			rows.some((row) => row === null || typeof row !== "object")
		) {
			invalidDocumentListResult(
				`Document list adapter returned invalid ${field}`,
				{
					field,
					rowCount: Array.isArray(rows) ? rows.length : undefined,
					maxRows: params.limit,
				},
			);
		}
	}
	for (const field of [
		"totalVisible",
		"totalAvailable",
		"totalMatched",
	] as const) {
		const count = result[field];
		if (!Number.isSafeInteger(count) || (count as number) < 0) {
			invalidDocumentListResult(
				`Document list adapter returned invalid ${field}`,
				{ field, count },
			);
		}
	}
	for (const [moreField, cursorField] of [
		["hasMore", "nextCursor"],
		["availableHasMore", "availableNextCursor"],
	] as const) {
		const hasMore = result[moreField];
		const cursor = result[cursorField];
		if (
			typeof hasMore !== "boolean" ||
			hasMore !== (cursor !== undefined) ||
			(cursor !== undefined && !normalizeDocumentListCursor(cursor))
		) {
			invalidDocumentListResult(
				`Document list adapter returned invalid ${cursorField}`,
				{
					moreField,
					hasMore,
					cursorField,
					cursorType: cursor === null ? "null" : typeof cursor,
				},
			);
		}
	}
}

export function documentCreatedAt(memory: Memory): number {
	if (
		typeof memory.createdAt !== "number" ||
		!Number.isSafeInteger(memory.createdAt)
	) {
		throw new ElizaError("Stored document is missing a valid creation time", {
			code: "DOCUMENT_LIST_INVALID_MEMORY",
			context: {
				agentId: memory.agentId,
				documentId: memory.id,
				createdAt: memory.createdAt,
			},
			severity: "fatal",
		});
	}
	return memory.createdAt;
}

export function compareDocumentOrder(left: Memory, right: Memory): number {
	const timeDifference = documentCreatedAt(right) - documentCreatedAt(left);
	if (timeDifference !== 0) return timeDifference;
	const leftId = left.id?.toLowerCase() ?? "";
	const rightId = right.id?.toLowerCase() ?? "";
	if (leftId === rightId) return 0;
	return rightId < leftId ? -1 : 1;
}

function documentCursor(
	memory: Memory,
	snapshot: Pick<DocumentListCursor, "snapshotCreatedAt" | "snapshotId">,
): DocumentListCursor {
	if (!isUuid(memory.id)) {
		throw new ElizaError("Stored document is missing a valid UUID", {
			code: "DOCUMENT_LIST_INVALID_MEMORY",
			context: { agentId: memory.agentId, documentId: memory.id },
			severity: "fatal",
		});
	}
	return {
		createdAt: documentCreatedAt(memory),
		id: memory.id,
		...snapshot,
	};
}

function isAfterDocumentCursor(
	memory: Memory,
	cursor: DocumentListCursor,
): boolean {
	const createdAt = documentCreatedAt(memory);
	if (createdAt !== cursor.createdAt) return createdAt < cursor.createdAt;
	return (
		typeof memory.id === "string" &&
		memory.id.toLowerCase() < cursor.id.toLowerCase()
	);
}

function isWithinDocumentSnapshot(
	memory: Memory,
	cursor: DocumentListCursor,
): boolean {
	const snapshotCreatedAt = cursor.snapshotCreatedAt ?? cursor.createdAt;
	const snapshotId = cursor.snapshotId ?? cursor.id;
	const createdAt = documentCreatedAt(memory);
	if (createdAt !== snapshotCreatedAt) return createdAt < snapshotCreatedAt;
	return (
		typeof memory.id === "string" &&
		memory.id.toLowerCase() <= snapshotId.toLowerCase()
	);
}

function isDocumentMemory(memory: Memory): boolean {
	return memory.metadata?.type === MemoryType.DOCUMENT;
}

export function documentRoleHasGlobalVisibility(
	role: DocumentListQueryParams["requesterRole"],
): boolean {
	return role === "OWNER" || role === "AGENT" || role === "RUNTIME";
}

function readUuidMetadata(
	metadata: Record<string, unknown>,
	key: string,
): UUID | undefined {
	const value = metadata[key];
	return isUuid(value) ? value : undefined;
}

function readDirectGrantEntityIds(
	metadata: Record<string, unknown>,
): UUID[] | null {
	const value = metadata.directGrantEntityIds;
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > DOCUMENT_DIRECT_GRANT_LIMIT) {
		return null;
	}
	const grants: UUID[] = [];
	const seen = new Set<string>();
	for (const entityId of value) {
		if (!isUuid(entityId)) return null;
		const normalized = entityId.toLowerCase() as UUID;
		if (seen.has(normalized)) return null;
		seen.add(normalized);
		grants.push(normalized);
	}
	return grants;
}

/** Validates and canonicalizes the bounded ACL payload used by adapter writes. */
export function validateDocumentDirectGrantEntityIds(value: unknown): UUID[] {
	if (!Array.isArray(value) || value.length > DOCUMENT_DIRECT_GRANT_LIMIT) {
		throw new ElizaError(
			"Document direct grants must be a bounded UUID array",
			{
				code: "DOCUMENT_DIRECT_GRANTS_INVALID",
				context: { limit: DOCUMENT_DIRECT_GRANT_LIMIT },
			},
		);
	}
	const grants = readDirectGrantEntityIds({ directGrantEntityIds: value });
	if (!grants || grants.length !== value.length) {
		throw new ElizaError(
			"Document direct grants contain an invalid or duplicate entity id",
			{
				code: "DOCUMENT_DIRECT_GRANTS_INVALID",
			},
		);
	}
	return [...grants].sort();
}

function readDocumentRevision(metadata: unknown): number | null {
	if (metadata === null || typeof metadata !== "object") return null;
	const value = Reflect.get(metadata, "documentRevision");
	if (value === undefined) return 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

/**
 * Parses the authorization-bearing document fields. Missing/unknown scopes,
 * invalid ownership identifiers, and non-document rows fail closed.
 */
export function readDocumentMutationSnapshot(
	memory: Memory,
): DocumentMutationSnapshot | null {
	if (
		!isDocumentMemory(memory) ||
		!isUuid(memory.roomId) ||
		!isUuid(memory.entityId)
	) {
		return null;
	}
	const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
	const scope = metadata.scope;
	if (typeof scope !== "string" || !DOCUMENT_LIST_SCOPES.has(scope)) {
		return null;
	}
	const scopedToEntityId = readUuidMetadata(metadata, "scopedToEntityId");
	if (scope === "user-private" && !scopedToEntityId) return null;
	if (metadata.scopedToEntityId !== undefined && !scopedToEntityId) return null;
	const addedBy = readUuidMetadata(metadata, "addedBy");
	if (metadata.addedBy !== undefined && !addedBy) return null;
	const directGrantEntityIds = readDirectGrantEntityIds(metadata);
	if (!directGrantEntityIds) return null;
	const revision = readDocumentRevision(metadata);
	if (revision === null) return null;
	const ingestionAttemptId = readUuidMetadata(metadata, "ingestionAttemptId");
	const ingestionState = metadata.ingestionState;
	const hasIngestionLifecycle =
		metadata.ingestionAttemptId !== undefined || ingestionState !== undefined;
	if (
		hasIngestionLifecycle &&
		(!ingestionAttemptId ||
			(ingestionState !== "pending" &&
				ingestionState !== "ready" &&
				ingestionState !== "failed"))
	) {
		return null;
	}
	const pinState =
		metadata.pinned !== undefined || metadata.pinTargets !== undefined
			? JSON.stringify([metadata.pinned ?? null, metadata.pinTargets ?? null])
			: undefined;

	return {
		...(pinState !== undefined ? { pinState } : {}),
		scope: scope as DocumentMutationSnapshot["scope"],
		roomId: memory.roomId,
		entityId: memory.entityId,
		revision,
		...(ingestionAttemptId ? { ingestionAttemptId } : {}),
		...(hasIngestionLifecycle
			? {
					ingestionState: ingestionState as "pending" | "ready" | "failed",
				}
			: {}),
		...(scopedToEntityId ? { scopedToEntityId } : {}),
		...(addedBy ? { addedBy } : {}),
		...(directGrantEntityIds.length > 0 ? { directGrantEntityIds } : {}),
	};
}

/** Rejects malformed revision batches before an adapter begins a transaction. */
export function validateDocumentRevisionReplacement(
	params: DocumentRevisionReplaceParams,
): void {
	validateDocumentRequesterContext(params);
	const replacement = params.replacement;
	const replacementMetadata = replacement.metadata as
		| Record<string, unknown>
		| undefined;
	const revision = replacementMetadata?.documentRevision;
	const replacementSnapshot = readDocumentMutationSnapshot(replacement);
	const invalid = (
		reason: string,
		context: Record<string, unknown> = {},
	): never => {
		throw new ElizaError("Invalid atomic document revision replacement", {
			code: "DOCUMENT_MUTATION_INVALID_REPLACEMENT",
			context: { documentId: params.documentId, reason, ...context },
		});
	};
	if (
		replacement.id !== params.documentId ||
		replacement.agentId !== params.agentId ||
		replacementMetadata?.type !== MemoryType.DOCUMENT ||
		replacementMetadata.documentId !== params.documentId ||
		typeof replacement.content.text !== "string" ||
		revision !== params.expected.revision + 1 ||
		!replacementSnapshot ||
		replacementSnapshot.scope !== params.expected.scope ||
		replacementSnapshot.roomId !== params.expected.roomId ||
		replacementSnapshot.entityId !== params.expected.entityId ||
		!uuidArraysEqual(
			replacementSnapshot.directGrantEntityIds,
			params.expected.directGrantEntityIds,
		) ||
		replacementSnapshot.scopedToEntityId !== params.expected.scopedToEntityId ||
		replacementSnapshot.addedBy !== params.expected.addedBy ||
		replacementSnapshot.ingestionAttemptId !==
			params.expected.ingestionAttemptId ||
		replacementSnapshot.ingestionState !== params.expected.ingestionState
	) {
		invalid("parent identity or revision does not match the mutation");
	}
	if (params.fragments.length > DOCUMENT_REVISION_MAX_FRAGMENTS) {
		invalid("fragment batch exceeds the supported bound", {
			fragmentCount: params.fragments.length,
		});
	}
	const ids = new Set<string>();
	for (let index = 0; index < params.fragments.length; index++) {
		const fragment = params.fragments[index];
		const fragmentId = fragment.id;
		const metadata = fragment.metadata as Record<string, unknown> | undefined;
		if (
			!isUuid(fragmentId) ||
			fragmentId === params.documentId ||
			(typeof fragmentId === "string" && ids.has(fragmentId)) ||
			fragment.agentId !== replacement.agentId ||
			fragment.roomId !== replacement.roomId ||
			fragment.worldId !== replacement.worldId ||
			fragment.entityId !== replacement.entityId ||
			metadata?.type !== MemoryType.FRAGMENT ||
			metadata.documentId !== params.documentId ||
			metadata.documentRevision !== revision ||
			metadata.position !== index ||
			typeof fragment.content.text !== "string" ||
			(fragment.embedding !== undefined &&
				(!Array.isArray(fragment.embedding) ||
					fragment.embedding.length === 0 ||
					fragment.embedding.some((value) => !Number.isFinite(value))))
		) {
			invalid("fragment is not a complete member of the replacement revision", {
				fragmentIndex: index,
				fragmentId,
			});
		}
		ids.add(fragmentId as UUID);
	}
}

/** Canonical read decision shared by list, lookup, and fragment search. */
export function isDocumentVisibleToRequester(
	memory: Memory,
	params: DocumentRequesterContext,
): boolean {
	if (params.requesterRole === "UNRESOLVED") return false;
	const snapshot = readDocumentMutationSnapshot(memory);
	if (!snapshot) return false;
	if (
		snapshot.ingestionState === "pending" ||
		snapshot.ingestionState === "failed"
	) {
		return false;
	}
	if (documentRoleHasGlobalVisibility(params.requesterRole)) {
		return true;
	}
	if (
		snapshot.scope !== "agent-private" &&
		snapshot.directGrantEntityIds?.includes(params.requesterEntityId)
	) {
		return true;
	}
	if (params.requesterRole === "GUEST") {
		return (
			params.requesterRoomIds.includes(snapshot.roomId) &&
			snapshot.scope === "global"
		);
	}
	if (!params.requesterRoomIds.includes(snapshot.roomId)) return false;
	if (snapshot.scope === "global") return true;
	if (snapshot.scope !== "user-private") return false;
	if (params.requesterRole === "ADMIN") return true;
	return snapshot.scopedToEntityId === params.requesterEntityId;
}

/** Canonical mutation decision evaluated again inside adapter CAS operations. */
export function canRequesterMutateDocument(
	memory: Memory,
	params: DocumentRequesterContext,
): boolean {
	if (
		params.requesterRole === "UNRESOLVED" ||
		params.requesterRole === "GUEST"
	) {
		return false;
	}
	const snapshot = readDocumentMutationSnapshot(memory);
	if (!snapshot) return false;
	if (params.requesterRole === "OWNER") return true;
	if (params.requesterRole === "AGENT" || params.requesterRole === "RUNTIME") {
		return snapshot.scope === "agent-private";
	}
	if (!params.requesterRoomIds.includes(snapshot.roomId)) return false;
	if (snapshot.scope !== "user-private") return false;
	return (
		params.requesterRole === "ADMIN" ||
		snapshot.scopedToEntityId === params.requesterEntityId
	);
}

/** Canonical authority for changing explicit document read grants. */
export function canRequesterManageDocumentDirectGrants(
	memory: Memory,
	params: DocumentRequesterContext,
): boolean {
	if (params.requesterRole === "OWNER") {
		return readDocumentMutationSnapshot(memory) !== null;
	}
	if (params.requesterRole !== "ADMIN") return false;
	const snapshot = readDocumentMutationSnapshot(memory);
	return (
		snapshot !== null &&
		params.requesterRoomIds.includes(snapshot.roomId) &&
		(snapshot.scope === "global" || snapshot.scope === "user-private")
	);
}

export function documentMutationSnapshotMatches(
	memory: Memory,
	expected: DocumentMutationSnapshot,
): boolean {
	const actual = readDocumentMutationSnapshot(memory);
	return (
		actual !== null &&
		actual.scope === expected.scope &&
		actual.pinState === expected.pinState &&
		actual.roomId === expected.roomId &&
		actual.entityId === expected.entityId &&
		uuidArraysEqual(
			actual.directGrantEntityIds,
			expected.directGrantEntityIds,
		) &&
		actual.scopedToEntityId === expected.scopedToEntityId &&
		actual.addedBy === expected.addedBy &&
		actual.revision === expected.revision &&
		actual.ingestionAttemptId === expected.ingestionAttemptId &&
		actual.ingestionState === expected.ingestionState
	);
}

function uuidArraysEqual(left?: UUID[], right?: UUID[]): boolean {
	const normalizedLeft = left ?? [];
	const normalizedRight = right ?? [];
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((value, index) => value === normalizedRight[index])
	);
}

function matchesDocumentFilters(
	memory: Memory,
	params: DocumentListQueryParams,
): boolean {
	const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
	if (params.scope && metadata.scope !== params.scope) {
		return false;
	}
	if (
		params.scopedToEntityId &&
		metadata.scopedToEntityId !== params.scopedToEntityId
	) {
		return false;
	}
	if (params.addedBy && metadata.addedBy !== params.addedBy) return false;

	const timestamp =
		typeof metadata.timestamp === "number"
			? metadata.timestamp
			: documentCreatedAt(memory);
	if (
		params.timeRangeStart !== undefined &&
		timestamp < params.timeRangeStart
	) {
		return false;
	}
	if (params.timeRangeEnd !== undefined && timestamp > params.timeRangeEnd) {
		return false;
	}

	if (params.tags?.length) {
		const tags = Array.isArray(metadata.tags)
			? metadata.tags.filter((tag): tag is string => typeof tag === "string")
			: [];
		if (!params.tags.every((tag) => tags.includes(tag))) return false;
	}
	return true;
}

function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Locale-independent portable tokens used by every adapter. Only ASCII
 * whitespace splits terms and only ASCII case folds; punctuation and Unicode
 * code points remain exact, so email addresses, URLs, and versions cannot be
 * tokenized differently by JavaScript and PostgreSQL.
 */
export function portableDocumentSearchTokens(value: string): string[] {
	return asciiLower(value)
		.split(DOCUMENT_SEARCH_SEPARATOR)
		.filter((token) => token.length > 0);
}

export function documentSearchText(memory: Memory): string {
	const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
	return [
		memory.content.text,
		metadata.title,
		metadata.filename,
		metadata.originalFilename,
		metadata.source,
	]
		.filter((value): value is string => typeof value === "string")
		.join("\n");
}

function matchesDocumentQuery(memory: Memory, query: string): boolean {
	const haystack = new Set(
		portableDocumentSearchTokens(documentSearchText(memory)),
	);
	const queryLexemes = portableDocumentSearchTokens(query);
	return (
		queryLexemes.length > 0 &&
		queryLexemes.every((lexeme) => haystack.has(lexeme))
	);
}

function assertUniqueDocumentIds(memories: Memory[]): void {
	const ids = new Set<UUID>();
	for (const memory of memories) {
		if (!isUuid(memory.id)) {
			throw new ElizaError("Stored document is missing a valid UUID", {
				code: "DOCUMENT_LIST_INVALID_MEMORY",
				context: { agentId: memory.agentId, documentId: memory.id },
				severity: "fatal",
			});
		}
		if (ids.has(memory.id)) {
			throw new ElizaError("Document list adapter returned a duplicate UUID", {
				code: "DOCUMENT_LIST_DUPLICATE_MEMORY",
				context: { agentId: memory.agentId, documentId: memory.id },
				severity: "fatal",
			});
		}
		ids.add(memory.id);
	}
}

function paginateDocuments(
	memories: Memory[],
	params: DocumentListQueryParams,
): {
	documents: Memory[];
	hasMore: boolean;
	nextCursor?: DocumentListCursor;
} {
	const cursorFiltered = params.cursor
		? memories.filter(
				(memory) =>
					isWithinDocumentSnapshot(
						memory,
						params.cursor as DocumentListCursor,
					) &&
					isAfterDocumentCursor(memory, params.cursor as DocumentListCursor),
			)
		: memories;
	const offset = params.cursor ? 0 : params.offset;
	const page = cursorFiltered.slice(offset, offset + params.limit + 1);
	const hasMore = page.length > params.limit;
	const documents = page.slice(0, params.limit);
	const last = documents.at(-1);
	const first = memories.at(0);
	const snapshotCreatedAt =
		params.cursor?.snapshotCreatedAt ??
		params.cursor?.createdAt ??
		(first ? documentCreatedAt(first) : undefined);
	const snapshotId =
		params.cursor?.snapshotId ??
		params.cursor?.id ??
		(first && isUuid(first.id) ? first.id : undefined);
	const snapshot =
		snapshotCreatedAt !== undefined && snapshotId
			? { snapshotCreatedAt, snapshotId }
			: {};
	return {
		documents,
		hasMore,
		...(hasMore && last ? { nextCursor: documentCursor(last, snapshot) } : {}),
	};
}

export function validateDocumentRequesterContext(
	params: DocumentRequesterContext,
): void {
	if (!isUuid(params.agentId) || !isUuid(params.requesterEntityId)) {
		invalidPagination("Document list requester identity is invalid", {
			agentId: params.agentId,
			requesterEntityId: params.requesterEntityId,
		});
	}
	if (!DOCUMENT_LIST_ROLES.has(params.requesterRole)) {
		invalidPagination("Document list requester role is invalid", {
			requesterRole: params.requesterRole,
		});
	}
	if (
		!Array.isArray(params.requesterRoomIds) ||
		params.requesterRoomIds.length > DOCUMENT_LIST_MAX_REQUESTER_ROOMS ||
		params.requesterRoomIds.some((roomId) => !isUuid(roomId))
	) {
		invalidPagination("Document list requester rooms are invalid", {
			roomCount: params.requesterRoomIds?.length,
		});
	}
}

export function validateDocumentFragmentQueryParams(
	params: DocumentFragmentQueryParams,
	expectedEmbeddingDimension?: number,
): void {
	validateDocumentRequesterContext(params);
	if (
		!Number.isSafeInteger(params.limit) ||
		params.limit < 1 ||
		params.limit > 1_000
	) {
		throw new ElizaError(
			"Document fragment limit must be an integer between 1 and 1000",
			{
				code: "DOCUMENT_FRAGMENT_QUERY_INVALID",
				context: { limit: params.limit },
			},
		);
	}
	if (
		params.offset !== undefined &&
		(!Number.isSafeInteger(params.offset) || params.offset < 0)
	) {
		throw new ElizaError(
			"Document fragment offset must be a non-negative integer",
			{
				code: "DOCUMENT_FRAGMENT_QUERY_INVALID",
				context: { offset: params.offset },
			},
		);
	}
	if (params.documentId !== undefined && !isUuid(params.documentId)) {
		throw new ElizaError("Document fragment parent id is invalid", {
			code: "DOCUMENT_FRAGMENT_QUERY_INVALID",
			context: { documentId: params.documentId },
		});
	}
	if (params.embedding === undefined) {
		if (params.matchThreshold !== undefined) {
			throw new ElizaError(
				"Document fragment threshold requires an embedding",
				{
					code: "DOCUMENT_FRAGMENT_QUERY_INVALID",
					context: { matchThreshold: params.matchThreshold },
				},
			);
		}
		return;
	}
	if (
		!Array.isArray(params.embedding) ||
		params.embedding.length === 0 ||
		params.embedding.some((value) => !Number.isFinite(value)) ||
		(expectedEmbeddingDimension !== undefined &&
			params.embedding.length !== expectedEmbeddingDimension)
	) {
		throw new ElizaError("Document fragment embedding is invalid", {
			code: "DOCUMENT_FRAGMENT_QUERY_INVALID",
			context: {
				actualDimension: params.embedding?.length,
				expectedDimension: expectedEmbeddingDimension,
			},
		});
	}
	if (
		params.matchThreshold !== undefined &&
		(!Number.isFinite(params.matchThreshold) ||
			params.matchThreshold < -1 ||
			params.matchThreshold > 1)
	) {
		throw new ElizaError("Document fragment match threshold is invalid", {
			code: "DOCUMENT_FRAGMENT_QUERY_INVALID",
			context: { matchThreshold: params.matchThreshold },
		});
	}
}

export function validateDocumentListQueryParams(
	params: DocumentListQueryParams,
): void {
	validateDocumentRequesterContext(params);
	if (
		!Number.isSafeInteger(params.limit) ||
		params.limit < 1 ||
		params.limit > DOCUMENT_LIST_MAX_LIMIT
	) {
		invalidPagination(
			`Document list limit must be an integer between 1 and ${DOCUMENT_LIST_MAX_LIMIT}`,
			{ limit: params.limit },
		);
	}
	if (
		!Number.isSafeInteger(params.offset) ||
		params.offset < 0 ||
		params.offset > DOCUMENT_LIST_MAX_OFFSET
	) {
		invalidPagination(
			`Document list offset must be an integer between 0 and ${DOCUMENT_LIST_MAX_OFFSET}`,
			{ offset: params.offset },
		);
	}
	if (params.cursor && !normalizeDocumentListCursor(params.cursor)) {
		invalidPagination("Document list cursor is invalid", {
			cursor: params.cursor,
		});
	}
	if (params.cursor && params.offset !== 0) {
		invalidPagination(
			"Document list cursor cannot be combined with a non-zero offset",
			{ offset: params.offset },
		);
	}
	if ((params.query?.length ?? 0) > DOCUMENT_LIST_MAX_QUERY_LENGTH) {
		invalidPagination(
			`Document list query cannot exceed ${DOCUMENT_LIST_MAX_QUERY_LENGTH} characters`,
			{ queryLength: params.query?.length },
		);
	}
	if (params.scope !== undefined && !DOCUMENT_LIST_SCOPES.has(params.scope)) {
		invalidPagination("Document list scope is invalid", {
			scope: params.scope,
		});
	}
	if (
		params.scopedToEntityId !== undefined &&
		!isUuid(params.scopedToEntityId)
	) {
		invalidPagination("Document list scoped entity is invalid", {
			scopedToEntityId: params.scopedToEntityId,
		});
	}
	if (params.addedBy !== undefined && !isUuid(params.addedBy)) {
		invalidPagination("Document list addedBy entity is invalid", {
			addedBy: params.addedBy,
		});
	}
	for (const [name, value] of [
		["timeRangeStart", params.timeRangeStart],
		["timeRangeEnd", params.timeRangeEnd],
	] as const) {
		if (value !== undefined && !Number.isSafeInteger(value)) {
			invalidPagination(`Document list ${name} must be a safe integer`, {
				[name]: value,
			});
		}
	}
	if (
		params.timeRangeStart !== undefined &&
		params.timeRangeEnd !== undefined &&
		params.timeRangeStart > params.timeRangeEnd
	) {
		invalidPagination("Document list time range is inverted", {
			timeRangeStart: params.timeRangeStart,
			timeRangeEnd: params.timeRangeEnd,
		});
	}
	if (
		(params.tags?.length ?? 0) > DOCUMENT_LIST_MAX_TAGS ||
		params.tags?.some(
			(tag) =>
				typeof tag !== "string" ||
				tag.length === 0 ||
				tag.length > DOCUMENT_LIST_MAX_TAG_LENGTH,
		)
	) {
		invalidPagination("Document list tags exceed the supported bounds", {
			tagCount: params.tags?.length,
		});
	}
}

export function queryDocumentsInMemory(
	memories: Memory[],
	params: DocumentListQueryParams,
): DocumentListQueryResult {
	validateDocumentListQueryParams(params);
	assertUniqueDocumentIds(memories);
	const allVisibleDocuments = memories
		.filter(
			(memory) =>
				memory.agentId === params.agentId &&
				isDocumentMemory(memory) &&
				isDocumentVisibleToRequester(memory, params),
		)
		.sort(compareDocumentOrder);
	const visibleDocuments = params.cursor
		? allVisibleDocuments.filter((memory) =>
				isWithinDocumentSnapshot(memory, params.cursor as DocumentListCursor),
			)
		: allVisibleDocuments;
	const availableDocuments = visibleDocuments.filter((memory) =>
		matchesDocumentFilters(memory, params),
	);
	const normalizedQuery = params.query?.trim();
	const matchedDocuments = normalizedQuery
		? availableDocuments.filter((memory) =>
				matchesDocumentQuery(memory, normalizedQuery),
			)
		: availableDocuments;
	const matchedPage = paginateDocuments(matchedDocuments, params);
	const availablePage =
		normalizedQuery &&
		matchedDocuments.length === 0 &&
		availableDocuments.length > 0
			? paginateDocuments(availableDocuments, params)
			: { documents: [], hasMore: false };

	return {
		documents: matchedPage.documents,
		availableDocuments: availablePage.documents,
		totalVisible: visibleDocuments.length,
		totalAvailable: availableDocuments.length,
		totalMatched: matchedDocuments.length,
		hasMore: matchedPage.hasMore,
		availableHasMore: availablePage.hasMore,
		...(matchedPage.nextCursor ? { nextCursor: matchedPage.nextCursor } : {}),
		...(availablePage.nextCursor
			? { availableNextCursor: availablePage.nextCursor }
			: {}),
	};
}

function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length !== right.length || left.length === 0) return -1;
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const leftValue = left[index];
		const rightValue = right[index];
		if (
			typeof leftValue !== "number" ||
			typeof rightValue !== "number" ||
			!Number.isFinite(leftValue) ||
			!Number.isFinite(rightValue)
		) {
			return -1;
		}
		dot += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return -1;
	return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Exact in-memory twin of the authorized SQL fragment query. Parent documents
 * own authorization; stale or malformed fragment metadata cannot widen access.
 */
export function queryDocumentFragmentsInMemory(
	memories: Memory[],
	params: DocumentFragmentQueryParams,
	expectedEmbeddingDimension?: number,
): Memory[] {
	validateDocumentFragmentQueryParams(params, expectedEmbeddingDimension);
	const parents = new Map<UUID, Memory>();
	for (const memory of memories) {
		if (
			memory.agentId === params.agentId &&
			isDocumentMemory(memory) &&
			isUuid(memory.id)
		) {
			parents.set(memory.id, memory);
		}
	}
	const fragments = memories
		.filter((memory) => {
			if (
				memory.agentId !== params.agentId ||
				memory.metadata?.type !== MemoryType.FRAGMENT
			) {
				return false;
			}
			const documentId = memory.metadata?.documentId;
			if (!isUuid(documentId)) return false;
			if (params.documentId && documentId !== params.documentId) return false;
			const parent = parents.get(documentId);
			if (!parent || !isDocumentVisibleToRequester(parent, params))
				return false;
			const parentSnapshot = readDocumentMutationSnapshot(parent);
			const fragmentRevision = readDocumentRevision(memory.metadata ?? {});
			if (
				!parentSnapshot ||
				fragmentRevision === null ||
				fragmentRevision !== parentSnapshot.revision
			) {
				return false;
			}
			// Attempt fencing: a parent that committed an update attempt token
			// only exposes fragments staged by that attempt (same rule as the
			// SQL adapters), so losing concurrent generations stay invisible.
			const parentAttempt = (
				(parent.metadata ?? {}) as { revisionAttemptId?: unknown }
			).revisionAttemptId;
			const fragmentAttempt = (
				(memory.metadata ?? {}) as unknown as { revisionAttemptId?: unknown }
			).revisionAttemptId;
			if (
				typeof parentAttempt === "string" &&
				fragmentAttempt !== parentAttempt
			) {
				return false;
			}
			if (params.roomId && parent.roomId !== params.roomId) return false;
			if (params.worldId && parent.worldId !== params.worldId) return false;
			if (params.entityId && parent.entityId !== params.entityId) return false;
			return true;
		})
		.map((memory) => {
			if (!params.embedding) return memory;
			const similarity = memory.embedding
				? cosineSimilarity(memory.embedding, params.embedding)
				: -1;
			return { ...memory, similarity };
		})
		.filter(
			(memory) =>
				!params.embedding ||
				(typeof memory.similarity === "number" &&
					memory.similarity >= (params.matchThreshold ?? 0)),
		);
	if (params.embedding) {
		fragments.sort(
			(left, right) =>
				(right.similarity ?? -1) - (left.similarity ?? -1) ||
				compareDocumentOrder(left, right),
		);
	} else {
		fragments.sort(compareDocumentOrder);
	}
	const offset = params.offset ?? 0;
	return fragments.slice(offset, offset + params.limit);
}

export function hasDocumentListQueryCapability(
	adapter: IDatabaseAdapter,
): boolean {
	const candidate = adapter as IDatabaseAdapter & {
		documentListQueryCapability?: unknown;
		queryDocuments?: unknown;
		getDocument?: unknown;
		queryDocumentFragments?: unknown;
		compareAndSwapDocument?: unknown;
		updateDocumentDirectGrants?: unknown;
		replaceDocumentRevision?: unknown;
		deleteDocumentWithSnapshot?: unknown;
	};
	return (
		candidate.documentListQueryCapability ===
			DOCUMENT_LIST_QUERY_CAPABILITY_VERSION &&
		typeof candidate.queryDocuments === "function" &&
		typeof candidate.getDocument === "function" &&
		typeof candidate.queryDocumentFragments === "function" &&
		typeof candidate.compareAndSwapDocument === "function" &&
		typeof candidate.updateDocumentDirectGrants === "function" &&
		typeof candidate.replaceDocumentRevision === "function" &&
		typeof candidate.deleteDocumentWithSnapshot === "function"
	);
}

function requireDocumentListQueryCapability(adapter: IDatabaseAdapter): void {
	if (hasDocumentListQueryCapability(adapter)) return;
	const candidate = adapter as IDatabaseAdapter & {
		documentListQueryCapability?: unknown;
		queryDocuments?: unknown;
	};
	throw new ElizaError(
		"Database adapter must implement document-store capability v4; migrate by adding authorized list, lookup, fragment search, atomic revision replacement, CAS update/delete, and direct-grant CAS methods",
		{
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
			context: {
				adapter: candidate.constructor.name,
				expectedVersion: DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
				advertisedVersion: candidate.documentListQueryCapability,
				hasQueryMethod: typeof candidate.queryDocuments === "function",
				migrationGuide:
					"Implement IDatabaseAdapter documentListQueryCapability=4 and every document-store method, including replaceDocumentRevision and updateDocumentDirectGrants; no compatibility scan is supported.",
			},
			severity: "fatal",
		},
	);
}

export async function queryDocumentsWithCapability(
	adapter: IDatabaseAdapter,
	params: DocumentListQueryParams,
): Promise<DocumentListQueryResult> {
	validateDocumentListQueryParams(params);
	requireDocumentListQueryCapability(adapter);
	const result: unknown = await adapter.queryDocuments(params);
	validateDocumentListQueryResult(result, params);
	return {
		documents: result.documents,
		availableDocuments: result.availableDocuments,
		totalVisible: result.totalVisible,
		totalAvailable: result.totalAvailable,
		totalMatched: result.totalMatched,
		hasMore: result.hasMore,
		availableHasMore: result.availableHasMore,
		...(result.nextCursor
			? {
					nextCursor: normalizeDocumentListCursor(
						result.nextCursor,
					) as DocumentListCursor,
				}
			: {}),
		...(result.availableNextCursor
			? {
					availableNextCursor: normalizeDocumentListCursor(
						result.availableNextCursor,
					) as DocumentListCursor,
				}
			: {}),
	};
}
