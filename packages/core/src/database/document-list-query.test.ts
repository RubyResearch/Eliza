/**
 * Verifies strict document-list capability negotiation and integrity checks
 * without allowing legacy pagination behavior to fabricate exact results.
 */
import { describe, expect, it, vi } from "vitest";
import type { DocumentListQueryParams, Memory, UUID } from "../types";
import { MemoryType } from "../types";
import {
	canRequesterManageDocumentDirectGrants,
	canRequesterMutateDocument,
	documentMutationSnapshotMatches,
	isDocumentVisibleToRequester,
	portableDocumentSearchTokens,
	queryDocumentFragmentsInMemory,
	queryDocumentsInMemory,
	queryDocumentsWithCapability,
	readDocumentMutationSnapshot,
	validateDocumentDirectGrantEntityIds,
} from "./document-list-query";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;

const params: DocumentListQueryParams = {
	agentId: AGENT_ID,
	requesterEntityId: REQUESTER_ID,
	requesterRoomIds: [],
	requesterRole: "RUNTIME",
	limit: 25,
	offset: 0,
};

function document(index: number): Memory {
	const id =
		`10000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
	return {
		id,
		agentId: AGENT_ID,
		entityId: REQUESTER_ID,
		roomId: ROOM_ID,
		createdAt: 1_000 + index,
		content: { text: `Document ${index}` },
		metadata: {
			type: MemoryType.DOCUMENT,
			scope: "global",
			timestamp: 1_000 + index,
		},
	};
}

describe("document-list capability contract", () => {
	it("fails before reading a legacy adapter whose 50-row cap would truncate 125 rows", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: undefined,
		});
		const corpus = Array.from({ length: 125 }, (_, index) => document(index));
		const getMemories = vi
			.spyOn(adapter, "getMemories")
			.mockResolvedValue(corpus.slice(0, 50));

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
		});
		expect(getMemories).not.toHaveBeenCalled();
	});

	it("does not enter a scan that can change underneath a concurrent insert", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: undefined,
		});
		let reads = 0;
		const getMemories = vi
			.spyOn(adapter, "getMemories")
			.mockImplementation(async () => {
				reads += 1;
				return [document(reads)];
			});

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
		});
		expect(getMemories).not.toHaveBeenCalled();
		expect(reads).toBe(0);
	});

	it("rejects duplicate document IDs instead of counting duplicate rows", () => {
		const duplicate = document(1);
		expect(() =>
			queryDocumentsInMemory([duplicate, { ...duplicate }], params),
		).toThrow(
			expect.objectContaining({
				code: "DOCUMENT_LIST_DUPLICATE_MEMORY",
			}),
		);
	});

	it("rejects malformed cursors before invoking a native adapter", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");

		await expect(
			queryDocumentsWithCapability(adapter, {
				...params,
				cursor: { createdAt: 1_000, id: "not-a-uuid" as UUID },
			}),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_PAGINATION",
		});
		expect(queryDocuments).not.toHaveBeenCalled();
	});

	it("rejects wrong capability versions even when a query method exists", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: 3,
		});
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
			context: expect.objectContaining({
				expectedVersion: 4,
				advertisedVersion: 3,
			}),
		});
		expect(queryDocuments).not.toHaveBeenCalled();
	});

	it("rejects v4 adapters missing the direct-grant CAS before reading", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "updateDocumentDirectGrants", {
			configurable: true,
			value: undefined,
		});
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({ code: "DOCUMENT_STORE_CAPABILITY_REQUIRED" });
		expect(queryDocuments).not.toHaveBeenCalled();
	});

	it("fails closed on missing, unknown, and structurally invalid scopes", () => {
		const malformed = [
			{ ...document(1), metadata: { type: MemoryType.DOCUMENT } },
			{
				...document(2),
				metadata: { type: MemoryType.DOCUMENT, scope: "public" },
			},
			{
				...document(3),
				metadata: {
					type: MemoryType.DOCUMENT,
					scope: "user-private",
					scopedToEntityId: "not-a-uuid",
				},
			},
		];
		for (const requesterRole of [
			"OWNER",
			"RUNTIME",
			"AGENT",
			"ADMIN",
			"USER",
		] as const) {
			expect(
				queryDocumentsInMemory(malformed, {
					...params,
					requesterRole,
					requesterRoomIds: [ROOM_ID],
				}).documents,
			).toEqual([]);
		}
	});

	it("keeps ADMIN room-wide user-private access distinct from USER ownership", () => {
		const owned = {
			...document(1),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: REQUESTER_ID,
			},
		};
		const otherId = "00000000-0000-0000-0000-00000000beef" as UUID;
		const other = {
			...document(2),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: otherId,
			},
		};
		const user = queryDocumentsInMemory([owned, other], {
			...params,
			requesterRole: "USER",
			requesterRoomIds: [ROOM_ID],
		});
		const admin = queryDocumentsInMemory([owned, other], {
			...params,
			requesterRole: "ADMIN",
			requesterRoomIds: [ROOM_ID],
		});
		expect(user.documents.map((memory) => memory.id)).toEqual([owned.id]);
		expect(new Set(admin.documents.map((memory) => memory.id))).toEqual(
			new Set([owned.id, other.id]),
		);
	});

	it("keeps direct grants independent from room membership without opening agent-private data", () => {
		const granted = {
			...document(30),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "owner-private",
				directGrantEntityIds: [REQUESTER_ID],
			},
		};
		const agentOnly = {
			...document(31),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "agent-private",
				directGrantEntityIds: [REQUESTER_ID],
			},
		};
		const userParams = {
			...params,
			requesterRole: "USER" as const,
			requesterRoomIds: [],
		};

		expect(isDocumentVisibleToRequester(granted, userParams)).toBe(true);
		expect(isDocumentVisibleToRequester(agentOnly, userParams)).toBe(false);
		const guest = { ...userParams, requesterRole: "GUEST" as const };
		expect(isDocumentVisibleToRequester(granted, guest)).toBe(true);
		expect(isDocumentVisibleToRequester(agentOnly, guest)).toBe(false);
		expect(canRequesterMutateDocument(granted, guest)).toBe(false);
		expect(canRequesterManageDocumentDirectGrants(granted, guest)).toBe(false);
		expect(
			isDocumentVisibleToRequester(granted, {
				...guest,
				requesterRole: "UNRESOLVED",
			}),
		).toBe(false);
		expect(canRequesterMutateDocument(granted, userParams)).toBe(false);
	});

	it("limits grant management to owner or a current room admin on shareable scopes", () => {
		const global = document(33);
		const userPrivate = {
			...document(34),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: REQUESTER_ID,
			},
		};
		const ownerPrivate = {
			...document(35),
			metadata: { type: MemoryType.DOCUMENT, scope: "owner-private" },
		};
		const owner = { ...params, requesterRole: "OWNER" as const };
		const admin = {
			...params,
			requesterRole: "ADMIN" as const,
			requesterRoomIds: [ROOM_ID],
		};

		expect(canRequesterManageDocumentDirectGrants(global, owner)).toBe(true);
		expect(canRequesterManageDocumentDirectGrants(global, admin)).toBe(true);
		expect(canRequesterManageDocumentDirectGrants(userPrivate, admin)).toBe(
			true,
		);
		expect(canRequesterManageDocumentDirectGrants(ownerPrivate, admin)).toBe(
			false,
		);
		expect(
			canRequesterManageDocumentDirectGrants(global, {
				...admin,
				requesterRoomIds: [],
			}),
		).toBe(false);
		for (const requesterRole of [
			"USER",
			"GUEST",
			"AGENT",
			"RUNTIME",
			"UNRESOLVED",
		] as const) {
			expect(
				canRequesterManageDocumentDirectGrants(global, {
					...admin,
					requesterRole,
				}),
			).toBe(false);
		}
	});

	it("canonicalizes valid grant arrays and rejects duplicates, malformed ids, and overflow", () => {
		const other = "00000000-0000-0000-0000-000000000001" as UUID;
		expect(validateDocumentDirectGrantEntityIds([REQUESTER_ID, other])).toEqual(
			[other, REQUESTER_ID],
		);
		for (const grants of [
			[REQUESTER_ID, REQUESTER_ID],
			[REQUESTER_ID, REQUESTER_ID.toUpperCase()],
			["not-a-uuid"],
			Array.from(
				{ length: 1_001 },
				(_, index) =>
					`10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
			),
		]) {
			expect(() => validateDocumentDirectGrantEntityIds(grants)).toThrowError(
				expect.objectContaining({ code: "DOCUMENT_DIRECT_GRANTS_INVALID" }),
			);
		}
	});

	it("fails closed on malformed or duplicate direct grants", () => {
		for (const directGrantEntityIds of [
			["not-a-uuid"],
			[REQUESTER_ID, REQUESTER_ID],
			"not-an-array",
		]) {
			const malformed = {
				...document(32),
				metadata: {
					type: MemoryType.DOCUMENT,
					scope: "global",
					directGrantEntityIds,
				},
			};
			expect(readDocumentMutationSnapshot(malformed)).toBeNull();
			expect(isDocumentVisibleToRequester(malformed, params)).toBe(false);
		}
	});

	it("keeps guest and unresolved document authority fail-closed", () => {
		const global = document(3);
		const privateDocument = {
			...document(4),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: REQUESTER_ID,
			},
		};
		const guestParams = {
			...params,
			requesterRole: "GUEST" as const,
			requesterRoomIds: [ROOM_ID],
		};
		const unresolvedParams = {
			...params,
			requesterRole: "UNRESOLVED" as const,
			requesterRoomIds: [ROOM_ID],
		};

		expect(isDocumentVisibleToRequester(global, guestParams)).toBe(true);
		expect(isDocumentVisibleToRequester(privateDocument, guestParams)).toBe(
			false,
		);
		expect(isDocumentVisibleToRequester(global, unresolvedParams)).toBe(false);
		expect(canRequesterMutateDocument(global, guestParams)).toBe(false);
		expect(canRequesterMutateDocument(global, unresolvedParams)).toBe(false);
	});

	it("filters fragments by authorized parent before applying offset and limit", () => {
		const firstParent = document(5);
		const secondParent = document(6);
		const fragment = (
			index: number,
			documentId: UUID,
			createdAt: number,
		): Memory => ({
			...document(index),
			createdAt,
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId,
				documentRevision: 0,
				position: index,
			},
		});
		const firstFragments = [
			fragment(7, firstParent.id as UUID, 3_000),
			fragment(8, firstParent.id as UUID, 2_000),
		];
		const otherFragment = fragment(9, secondParent.id as UUID, 4_000);

		const result = queryDocumentFragmentsInMemory(
			[firstParent, secondParent, ...firstFragments, otherFragment],
			{
				...params,
				requesterRole: "OWNER",
				documentId: firstParent.id,
				limit: 1,
				offset: 1,
			},
		);

		expect(result.map((memory) => memory.id)).toEqual([firstFragments[1]?.id]);
	});

	it("uses locale-independent tokens that preserve punctuation and Unicode", () => {
		expect(
			portableDocumentSearchTokens(
				"Test.User+Tag@Example.COM v1.2.3 https://Example.com/a?b=c#d C++ 東京 İ",
			),
		).toEqual([
			"test.user+tag@example.com",
			"v1.2.3",
			"https://example.com/a?b=c#d",
			"c++",
			"東京",
			"İ",
		]);
	});

	it("anchors keyset traversal against newer concurrent inserts", () => {
		const original = Array.from({ length: 5 }, (_, index) => document(index));
		const first = queryDocumentsInMemory(original, { ...params, limit: 2 });
		expect(first.nextCursor).toMatchObject({
			snapshotCreatedAt: 1_004,
			snapshotId: original[4]?.id,
		});
		const inserted = document(99);
		const seen = [...first.documents];
		let cursor = first.nextCursor;
		while (cursor) {
			const page = queryDocumentsInMemory([...original, inserted], {
				...params,
				limit: 2,
				cursor,
			});
			seen.push(...page.documents);
			cursor = page.nextCursor;
		}
		expect(new Set(seen.map((memory) => memory.id))).toEqual(
			new Set(original.map((memory) => memory.id)),
		);
		expect(seen.map((memory) => memory.id)).not.toContain(inserted.id);
	});

	it("fences mutation snapshots on ingestion attempt and lifecycle state", () => {
		const ingestionAttemptId = "00000000-0000-4000-8000-00000000feed" as UUID;
		const pending = {
			...document(10),
			metadata: {
				...document(10).metadata,
				directGrantEntityIds: [REQUESTER_ID],
				ingestionAttemptId,
				ingestionState: "pending",
			},
		} as Memory;
		const snapshot = readDocumentMutationSnapshot(pending);
		expect(snapshot).toMatchObject({
			directGrantEntityIds: [REQUESTER_ID],
			ingestionAttemptId,
			ingestionState: "pending",
		});
		if (!snapshot) throw new Error("expected a valid ingestion snapshot");
		expect(documentMutationSnapshotMatches(pending, snapshot)).toBe(true);
		expect(
			documentMutationSnapshotMatches(
				{
					...pending,
					metadata: {
						...pending.metadata,
						directGrantEntityIds: [],
					} as Memory["metadata"],
				},
				snapshot,
			),
		).toBe(false);
		expect(
			documentMutationSnapshotMatches(
				{
					...pending,
					metadata: {
						...pending.metadata,
						ingestionState: "failed",
					} as unknown as Memory["metadata"],
				},
				snapshot,
			),
		).toBe(false);
		expect(
			readDocumentMutationSnapshot({
				...pending,
				metadata: {
					...pending.metadata,
					ingestionAttemptId: undefined,
				} as unknown as Memory["metadata"],
			}),
		).toBeNull();
	});

	it("hides pending and failed ingestions from list visibility", () => {
		const ingestionAttemptId = "00000000-0000-4000-8000-00000000feed" as UUID;
		const ready = {
			...document(11),
			metadata: {
				...document(11).metadata,
				ingestionAttemptId,
				ingestionState: "ready",
			},
		} as Memory;
		const pending = {
			...document(12),
			metadata: {
				...document(12).metadata,
				ingestionAttemptId,
				ingestionState: "pending",
			},
		} as Memory;
		const failed = {
			...document(13),
			metadata: {
				...document(13).metadata,
				ingestionAttemptId,
				ingestionState: "failed",
			},
		} as Memory;
		const ownerParams = {
			...params,
			requesterRole: "OWNER" as const,
			requesterRoomIds: [ROOM_ID],
		};
		expect(isDocumentVisibleToRequester(ready, ownerParams)).toBe(true);
		expect(isDocumentVisibleToRequester(pending, ownerParams)).toBe(false);
		expect(isDocumentVisibleToRequester(failed, ownerParams)).toBe(false);
		expect(
			queryDocumentsInMemory(
				[ready, pending, failed],
				ownerParams,
			).documents.map((memory) => memory.id),
		).toEqual([ready.id]);
	});
});

it("rechecks current in-memory membership for grants while preserving owner authority", async () => {
	const adapter = new InMemoryDatabaseAdapter();
	const source = document(900);
	const grantee = "00000000-0000-0000-0000-00000000c0df" as UUID;
	await adapter.createEntities([
		{ id: grantee, agentId: AGENT_ID, names: ["Grantee"] },
	]);
	await adapter.createMemories([{ memory: source, tableName: "documents" }]);
	await adapter.createRoomParticipants([REQUESTER_ID], ROOM_ID);
	const expected = readDocumentMutationSnapshot(source);
	if (!expected || !source.id) throw new Error("Document fixture is invalid");
	const request = {
		agentId: AGENT_ID,
		documentId: source.id,
		requesterEntityId: REQUESTER_ID,
		requesterRole: "ADMIN" as const,
		requesterRoomIds: [ROOM_ID],
		expected,
		directGrantEntityIds: [grantee],
	};
	const first = await adapter.updateDocumentDirectGrants(request);
	expect(first.status).toBe("updated");
	if (first.status !== "updated") throw new Error("Initial grant failed");
	const reviewed = readDocumentMutationSnapshot(first.document);
	if (!reviewed) throw new Error("Updated document is invalid");
	await adapter.deleteParticipants([
		{ entityId: REQUESTER_ID, roomId: ROOM_ID },
	]);
	await expect(
		adapter.updateDocumentDirectGrants({
			...request,
			expected: reviewed,
			directGrantEntityIds: [],
		}),
	).resolves.toEqual({ status: "forbidden" });
	const reader = {
		agentId: AGENT_ID,
		documentId: source.id,
		requesterEntityId: grantee,
		requesterRoomIds: [],
		requesterRole: "USER" as const,
	};
	await expect(adapter.getDocument(reader)).resolves.toMatchObject({
		content: source.content,
	});
	await expect(
		adapter.updateDocumentDirectGrants({
			...request,
			requesterRole: "OWNER",
			requesterRoomIds: [],
			expected: reviewed,
			directGrantEntityIds: [],
		}),
	).resolves.toMatchObject({ status: "updated" });
	await expect(adapter.getDocument(reader)).resolves.toBeNull();
});
