/**
 * Exercises document authorization against a real AgentRuntime and PGLite store,
 * including same-turn membership revocation and knowledge-context provider
 * composition across user and agent-tenant boundaries.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readDocumentMutationSnapshot } from "../../database/document-list-query.ts";
import { setEntityRoleCas } from "../../roles.ts";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import type { AgentRuntime } from "../../runtime.ts";
import { selectV5PlannerStateProviderNames } from "../../services/message/provider-state.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { runWithTrajectoryContext } from "../../trajectory-context.ts";
import {
	type Agent,
	ChannelType,
	type HandlerOptions,
	type Memory,
	MemoryType,
	ModelType,
	type State,
	type UUID,
} from "../../types/index.ts";
import { documentAction } from "./actions.ts";
import { pinnedDocumentsProvider } from "./pinned-provider.ts";
import { documentsProvider } from "./provider.ts";
import { DocumentService } from "./service.ts";

const USER_ID = "f4300000-0000-4000-8000-000000000001" as UUID;
const OTHER_USER_ID = "f4300000-0000-4000-8000-000000000007" as UUID;
const OTHER_AGENT_ID = "f4300000-0000-4000-8000-000000000008" as UUID;
const ADMIN_ID = "f4300000-0000-4000-8000-000000000020" as UUID;
const GRANTEE_ID = "f4300000-0000-4000-8000-000000000021" as UUID;
const WORLD_ID = "f4300000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "f4300000-0000-4000-8000-000000000003" as UUID;
const UPDATE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000004" as UUID;
const DELETE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000005" as UUID;
const VISIBLE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000009" as UUID;
const HIDDEN_USER_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000010" as UUID;
const FOREIGN_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000011" as UUID;
const ATOMIC_UPDATE_DOCUMENT_ID =
	"f4300000-0000-4000-8000-000000000016" as UUID;
const FAILED_UPDATE_DOCUMENT_ID =
	"f4300000-0000-4000-8000-000000000018" as UUID;
const GRANT_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000022" as UUID;
const PRIVATE_GRANT_DOCUMENT_ID =
	"f4300000-0000-4000-8000-000000000030" as UUID;
const LARGE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000029" as UUID;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let failEmbedding = false;

function message(): Memory {
	return {
		id: "f4300000-0000-4000-8000-000000000006" as UUID,
		agentId: runtime.agentId,
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: {
			text: "Update my private documents",
			source: "test",
			channelType: ChannelType.DM,
		},
	};
}

function userPrivateDocument(
	id: UUID,
	text: string,
	options: {
		agentId?: UUID;
		entityId?: UUID;
		title?: string;
	} = {},
): Memory {
	const agentId = options.agentId ?? runtime.agentId;
	const entityId = options.entityId ?? USER_ID;
	const filename = `${id}.txt`;
	return {
		id,
		agentId,
		entityId,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		createdAt: 1_000,
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: id,
			documentRevision: 0,
			scope: "user-private",
			scopedToEntityId: entityId,
			addedBy: entityId,
			addedByRole: "USER",
			addedFrom: "upload",
			addedAt: 1_000,
			source: "test",
			title: options.title ?? "Private document",
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(text, "utf8"),
			textBacked: true,
			timestamp: 1_000,
		},
	};
}

function documentFragment(document: Memory, text: string, id: UUID): Memory {
	return {
		...document,
		id,
		content: { text },
		metadata: {
			...document.metadata,
			type: MemoryType.FRAGMENT,
			documentId: document.id,
			position: 0,
		},
	};
}

async function privateConversation(entityId: UUID): Promise<UUID> {
	const roomId = crypto.randomUUID() as UUID;
	await runtime.ensureConnection({
		entityId,
		roomId,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Private reader",
		name: "Private document conversation",
		source: "test",
		type: ChannelType.DM,
	});
	return roomId;
}

beforeAll(async () => {
	({ runtime, cleanup } = await createTestRuntime({
		characterName: "DocumentAuthorizationTest",
	}));
	// Seed authority when the world is created; connection updates preserve roles.
	await runtime.ensureWorldExists({
		id: WORLD_ID,
		name: "Document authorization",
		agentId: runtime.agentId,
		metadata: {
			roles: {
				[USER_ID]: "USER",
				[OTHER_USER_ID]: "USER",
				[ADMIN_ID]: "ADMIN",
			},
			roleSources: {
				[USER_ID]: "manual",
				[OTHER_USER_ID]: "manual",
				[ADMIN_ID]: "manual",
			},
		},
	});
	await runtime.ensureConnection({
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Document owner",
		name: "Document owner",
		source: "test",
		type: ChannelType.DM,
	});
	await runtime.ensureConnection({
		entityId: ADMIN_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Document admin",
		name: "Document admin",
		source: "test",
		type: ChannelType.DM,
	});
	await runtime.adapter.createEntities([
		{ id: GRANTEE_ID, agentId: runtime.agentId, names: ["Direct grantee"] },
	]);
	await runtime.ensureConnection({
		entityId: OTHER_USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Other document owner",
		name: "Other document owner",
		source: "test",
		type: ChannelType.DM,
	});

	// Role maps are protected authority state: legacy world upserts cannot
	// grant access after ensureConnection has created the world.
	for (const [entityId, role] of [
		[USER_ID, "USER"],
		[OTHER_USER_ID, "USER"],
		[ADMIN_ID, "ADMIN"],
	] as const) {
		const grant = await setEntityRoleCas(runtime, message(), entityId, role, {
			worldId: WORLD_ID,
			source: "manual",
		});
		expect(grant.status).toBe("committed");
	}
	await runtime.adapter.createAgent({
		id: OTHER_AGENT_ID,
		name: "Foreign document tenant",
		createdAt: 1_000,
		updatedAt: 1_000,
	} as Agent);
	const visibleDocument = userPrivateDocument(
		VISIBLE_DOCUMENT_ID,
		"visible owner launch knowledge",
		{
			entityId: OTHER_USER_ID,
			title: "VISIBLE_OWNER_DOCUMENT",
		},
	);
	const hiddenUserDocument = userPrivateDocument(
		HIDDEN_USER_DOCUMENT_ID,
		"hidden other-user launch knowledge",
		{ title: "HIDDEN_OTHER_USER_DOCUMENT" },
	);
	const foreignDocument = userPrivateDocument(
		FOREIGN_DOCUMENT_ID,
		"hidden foreign-tenant launch knowledge",
		{
			agentId: OTHER_AGENT_ID,
			entityId: OTHER_USER_ID,
			title: "HIDDEN_FOREIGN_TENANT_DOCUMENT",
		},
	);
	await runtime.createMemories([
		{
			memory: userPrivateDocument(
				PRIVATE_GRANT_DOCUMENT_ID,
				"Private grantable body",
			),
			tableName: "documents",
		},
		{
			memory: {
				...userPrivateDocument(GRANT_DOCUMENT_ID, "Grantable global body"),
				metadata: {
					...userPrivateDocument(GRANT_DOCUMENT_ID, "Grantable global body")
						.metadata,
					scope: "global",
					scopedToEntityId: undefined,
				},
			},
			tableName: "documents",
		},
		{
			memory: userPrivateDocument(UPDATE_DOCUMENT_ID, "Original update body"),
			tableName: "documents",
		},
		{
			memory: userPrivateDocument(DELETE_DOCUMENT_ID, "Original delete body"),
			tableName: "documents",
		},
		{ memory: visibleDocument, tableName: "documents" },
		{ memory: hiddenUserDocument, tableName: "documents" },
		{ memory: foreignDocument, tableName: "documents" },
		{
			memory: documentFragment(
				visibleDocument,
				"VISIBLE_OWNER_FRAGMENT launch knowledge",
				"f4300000-0000-4000-8000-000000000012" as UUID,
			),
			tableName: "document_fragments",
		},
		{
			memory: documentFragment(
				hiddenUserDocument,
				"HIDDEN_OTHER_USER_FRAGMENT launch knowledge",
				"f4300000-0000-4000-8000-000000000013" as UUID,
			),
			tableName: "document_fragments",
		},
		{
			memory: documentFragment(
				foreignDocument,
				"HIDDEN_FOREIGN_TENANT_FRAGMENT launch knowledge",
				"f4300000-0000-4000-8000-000000000014" as UUID,
			),
			tableName: "document_fragments",
		},
	]);
}, 120_000);

afterAll(async () => {
	await cleanup();
}, 120_000);

describe("DocumentService requester authorization", () => {
	it("lets a current room admin atomically grant read access without granting mutation", async () => {
		const service = new DocumentService(runtime);
		const grantDocumentId = PRIVATE_GRANT_DOCUMENT_ID;
		const adminContext = {
			requesterEntityId: ADMIN_ID,
			role: "ADMIN" as const,
			isOwner: false,
		};
		await expect(
			service.setDocumentDirectGrantsWithAccessContext(
				grantDocumentId,
				[GRANTEE_ID],
				adminContext,
			),
		).resolves.toMatchObject({
			id: grantDocumentId,
			metadata: { directGrantEntityIds: [GRANTEE_ID] },
		});
		await expect(
			service.getDocumentDirectGrantsWithAccessContext(
				grantDocumentId,
				adminContext,
			),
		).resolves.toEqual([GRANTEE_ID]);
		const reviewedAccess =
			await service.getDocumentDirectGrantStateWithAccessContext(
				grantDocumentId,
				adminContext,
			);

		await expect(
			runtime.adapter.getDocument({
				agentId: runtime.agentId,
				documentId: grantDocumentId,
				requesterEntityId: GRANTEE_ID,
				requesterRoomIds: [],
				requesterRole: "USER",
			}),
		).resolves.toMatchObject({ id: grantDocumentId });
		await expect(
			runtime.adapter.readDocumentRange?.({
				agentId: runtime.agentId,
				documentId: grantDocumentId,
				requesterEntityId: GRANTEE_ID,
				requesterRoomIds: [],
				requesterRole: "USER",
				unit: "line",
				offset: 0,
				limit: 1,
			}),
		).resolves.toMatchObject({ text: "Private grantable body", total: 1 });
		await expect(
			runtime.adapter.readDocumentRange?.({
				agentId: runtime.agentId,
				documentId: grantDocumentId,
				requesterEntityId: GRANTEE_ID,
				requesterRoomIds: [],
				requesterRole: "GUEST",
				unit: "line",
				offset: 0,
				limit: 1,
			}),
		).resolves.toMatchObject({ text: "Private grantable body", total: 1 });
		const guestContext = {
			requesterEntityId: GRANTEE_ID,
			role: "GUEST" as const,
			isOwner: false,
		};
		await expect(
			service.getDocumentByIdWithAccessContext(grantDocumentId, guestContext),
		).resolves.toMatchObject({
			id: grantDocumentId,
			content: { text: "Private grantable body" },
		});
		await expect(
			service.setDocumentDirectGrantsWithAccessContext(
				grantDocumentId,
				[],
				guestContext,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_GRANT_MUTATION_FORBIDDEN" });
		await expect(
			service.setDocumentDirectGrantsWithAccessContext(grantDocumentId, [], {
				requesterEntityId: GRANTEE_ID,
				role: "USER",
				isOwner: false,
			}),
		).rejects.toMatchObject({ code: "DOCUMENT_GRANT_MUTATION_FORBIDDEN" });
		await expect(
			service.getDocumentDirectGrantsWithAccessContext(grantDocumentId, {
				requesterEntityId: GRANTEE_ID,
				role: "USER",
				isOwner: false,
			}),
		).rejects.toMatchObject({ code: "DOCUMENT_GRANT_MUTATION_FORBIDDEN" });

		await service.setDocumentDirectGrantsWithAccessContext(
			grantDocumentId,
			[],
			adminContext,
		);
		await expect(
			service.setDocumentDirectGrantsWithAccessContext(
				grantDocumentId,
				[GRANTEE_ID],
				adminContext,
				reviewedAccess.accessRevision,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_GRANT_MUTATION_CONFLICT" });
		await expect(
			service.getDocumentByIdWithAccessContext(grantDocumentId, guestContext),
		).resolves.toBeNull();
		await expect(
			runtime.adapter.readDocumentRange?.({
				agentId: runtime.agentId,
				documentId: grantDocumentId,
				requesterEntityId: GRANTEE_ID,
				requesterRoomIds: [],
				requesterRole: "GUEST",
				unit: "line",
				offset: 0,
				limit: 1,
			}),
		).resolves.toBeNull();

		await expect(
			runtime.adapter.readDocumentRange?.({
				agentId: runtime.agentId,
				documentId: grantDocumentId,
				requesterEntityId: GRANTEE_ID,
				requesterRoomIds: [],
				requesterRole: "USER",
				unit: "line",
				offset: 0,
				limit: 1,
			}),
		).resolves.toBeNull();
		await service.setDocumentDirectGrantsWithAccessContext(
			grantDocumentId,
			[GRANTEE_ID],
			adminContext,
			(
				await service.getDocumentDirectGrantStateWithAccessContext(
					grantDocumentId,
					adminContext,
				)
			).accessRevision,
		);
	});

	it("preserves large source text through update and existing-document upsert", async () => {
		const id = "f4300000-0000-4000-8000-000000000031" as UUID;
		const source = 'original "🌍\n'.repeat(200_000);
		const document = userPrivateDocument(id, source);
		await runtime.createMemory(document, "documents");
		await runtime.updateMemory({ ...document, id });
		expect((await runtime.getMemoryById(id))?.content.text).toBe(source);
		const updated = `${source}\nNEW-END`;
		await runtime.adapter.upsertMemories([
			{
				memory: { ...document, content: { text: updated } },
				tableName: "documents",
			},
		]);
		expect((await runtime.getMemoryById(id))?.content.text).toBe(updated);
	});

	it("keeps ordinary memory and non-source document fields under the JSON budget on update", async () => {
		const documentId = "f4300000-0000-4000-8000-000000000032" as UUID;
		const messageId = "f4300000-0000-4000-8000-000000000033" as UUID;
		const content = { text: "unchanged" };
		const oversized = "x".repeat(2 * 1024 * 1024);
		await runtime.createMemory(
			userPrivateDocument(documentId, content.text),
			"documents",
		);
		await runtime.createMemory(
			{ ...message(), id: messageId, content },
			"messages",
		);
		for (const update of [
			{ id: messageId, content: { text: oversized } },
			{ id: documentId, content: { text: "new", nested: { text: oversized } } },
			{ id: documentId, content: { text: "new", title: oversized } },
			{ id: documentId, content: { text: "invalid\0source" } },
		]) {
			await expect(runtime.updateMemory(update)).rejects.toMatchObject({
				code: "DB_UPDATE_FAILED",
			});
			expect((await runtime.getMemoryById(update.id))?.content).toEqual(
				content,
			);
		}
	});

	it("reads a late page from a 10 MiB PGLite document without returning a source-sized projection", async () => {
		const ordinaryLine = `${"x".repeat(1_023)}\n`;
		const lateLine = `${"LATE-EVIDENCE".padEnd(1_023, "z")}\n`;
		const source = ordinaryLine.repeat(10_239) + lateLine;
		expect(Buffer.byteLength(source)).toBe(10 * 1024 * 1024);
		await runtime.createMemories([
			{
				memory: userPrivateDocument(LARGE_DOCUMENT_ID, source, {
					title: "Large bounded-read document",
				}),
				tableName: "documents",
			},
		]);
		const wholeRead = vi
			.spyOn(runtime.adapter, "getDocument")
			.mockRejectedValue(
				new Error("whole-document materialization is forbidden in this test"),
			);
		const service = new DocumentService(runtime);
		const getService = vi
			.spyOn(runtime, "getService")
			.mockImplementation((serviceType) =>
				serviceType === DocumentService.serviceType ? service : null,
			);
		try {
			const first = await documentAction.handler?.(
				runtime,
				message(),
				undefined,
				{
					parameters: {
						action: "read",
						documentId: LARGE_DOCUMENT_ID,
						limit: 1,
					},
				} as HandlerOptions,
			);
			const revision = (
				first?.data as
					| { readView: { slice: { revision?: string } } }
					| undefined
			)?.readView.slice.revision;
			expect(revision).toBeDefined();
			const result = await documentAction.handler?.(
				runtime,
				message(),
				undefined,
				{
					parameters: {
						action: "read",
						documentId: LARGE_DOCUMENT_ID,
						offset: 10_239,
						limit: 1,
						expectedRevision: revision,
					},
				} as HandlerOptions,
			);
			if (!result?.success) {
				throw new Error(`bounded read failed: ${JSON.stringify(result)}`);
			}
			expect(result?.text).toBe(lateLine);
			expect(wholeRead).not.toHaveBeenCalled();
			// Query/result-byte oracle: the adapter may scan the source inside the DB,
			// but only the requested page and continuation metadata cross into JS.
			expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024);
			expect(result?.data).toMatchObject({
				readView: {
					slice: {
						range: {
							unit: "line",
							start: 10_239,
							end: 10_240,
							total: 10_240,
						},
					},
				},
			});
		} finally {
			getService.mockRestore();
			wholeRead.mockRestore();
		}
	}, 120_000);

	it("composes knowledge context with requester-scoped user and tenant visibility", async () => {
		const selected = filterByContextGate(
			[documentsProvider],
			["knowledge"],
			["USER"],
		);
		expect(selected).toEqual([documentsProvider]);

		const service = new DocumentService(runtime);
		const getService = vi
			.spyOn(runtime, "getService")
			.mockImplementation((serviceType) =>
				serviceType === DocumentService.serviceType ? service : null,
			);
		const request: Memory = {
			...message(),
			id: "f4300000-0000-4000-8000-000000000015" as UUID,
			entityId: OTHER_USER_ID,
			roomId: await privateConversation(OTHER_USER_ID),
			content: {
				text: "launch knowledge",
				source: "test",
				channelType: ChannelType.DM,
			},
		};

		try {
			const result = await documentsProvider.get(runtime, request, {} as State);
			expect(result.text).toContain("VISIBLE_OWNER_FRAGMENT");
			expect(result.text).toContain("VISIBLE_OWNER_DOCUMENT");
			expect(result.text).not.toContain("HIDDEN_OTHER_USER");
			expect(result.text).not.toContain("HIDDEN_FOREIGN_TENANT");
			expect(result.values?.documents).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: VISIBLE_DOCUMENT_ID }),
					expect.objectContaining({ id: GRANT_DOCUMENT_ID }),
				]),
			);
		} finally {
			getService.mockRestore();
		}
	});

	it("composes only explicitly shared guest knowledge and removes it after revocation", async () => {
		const service = new DocumentService(runtime);
		const shared = userPrivateDocument(
			"f4300000-0000-4000-8000-000000000040" as UUID,
			"GUEST_SHARED_PIN_COMPLETE_BODY",
		);
		const hidden = userPrivateDocument(
			"f4300000-0000-4000-8000-000000000041" as UUID,
			"GUEST_HIDDEN_PIN_BODY",
		);
		shared.metadata = {
			...shared.metadata,
			type: MemoryType.DOCUMENT,
			pinned: true,
		};
		hidden.metadata = {
			...hidden.metadata,
			type: MemoryType.DOCUMENT,
			pinned: true,
		};
		await runtime.createMemories([
			{ memory: shared, tableName: "documents" },
			{ memory: hidden, tableName: "documents" },
		]);
		const request = {
			...message(),
			entityId: GRANTEE_ID,
			roomId: await privateConversation(GRANTEE_ID),
			content: { text: "What knowledge was shared with me?" },
		};
		const selected = filterByContextGate(
			[documentsProvider],
			["knowledge"],
			["GUEST"],
		);
		expect(selected).toHaveLength(1);
		const provider = selected[0];
		const sharedId = shared.id;
		if (!provider || !sharedId)
			throw new Error("Guest provider fixture is incomplete");
		const getService = vi.spyOn(runtime, "getService").mockReturnValue(service);
		const admin = {
			requesterEntityId: ADMIN_ID,
			role: "ADMIN" as const,
			isOwner: false,
		};
		try {
			const before = await provider.get(runtime, request, {} as State);
			expect(before.text).not.toContain("GUEST_SHARED_PIN_COMPLETE_BODY");
			await service.setDocumentDirectGrantsWithAccessContext(
				sharedId,
				[GRANTEE_ID],
				admin,
			);
			const after = await provider.get(runtime, request, {} as State);
			expect(after.text).toContain("GUEST_SHARED_PIN_COMPLETE_BODY");
			expect(after.text).not.toContain("GUEST_HIDDEN_PIN_BODY");
			expect(after.values?.pinnedDocumentIds).toContain(shared.id);
			await service.setDocumentDirectGrantsWithAccessContext(
				sharedId,
				[],
				admin,
			);
			const revoked = await provider.get(runtime, request, {} as State);
			expect(revoked.text).not.toContain("GUEST_SHARED_PIN_COMPLETE_BODY");
			expect(revoked.text).not.toContain("GUEST_HIDDEN_PIN_BODY");
			expect(revoked.values?.pinnedDocumentIds).not.toContain(shared.id);
		} finally {
			getService.mockRestore();
		}
	});

	it("pins independently to chat and agent without changing readers or losing concurrent edits", async () => {
		const service = new DocumentService(runtime);
		const pinRoom = await privateConversation(USER_ID);
		const id = "f4300000-0000-4000-8000-000000000050" as UUID;
		const otherRoom = "f4300000-0000-4000-8000-000000000051" as UUID;
		const missingRoom = "f4300000-0000-4000-8000-000000000052" as UUID;
		await runtime.ensureConnection({
			entityId: USER_ID,
			roomId: otherRoom,
			worldId: WORLD_ID,
			worldName: "Document authorization",
			userName: "Document owner",
			name: "Second document chat",
			source: "test",
			type: ChannelType.DM,
		});
		const original = userPrivateDocument(id, "CHAT_PIN_COMPLETE_BODY");
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
		]);
		const owner = {
			requesterEntityId: USER_ID,
			role: "OWNER" as const,
			isOwner: true,
		};
		const first = await service.getDocumentPinsWithAccessContext(id, owner);
		const updated = await service.setDocumentPinsWithAccessContext(
			id,
			{ agent: false, roomIds: [pinRoom] },
			owner,
			first.pinRevision,
		);
		expect(updated.content).toEqual(original.content);
		expect(updated.metadata).toMatchObject({
			scope: "user-private",
			scopedToEntityId: USER_ID,
			documentRevision: 0,
		});
		const includes = async (request: Memory) =>
			(await service.composeProviderDocuments(request)).pinnedDocuments.some(
				(document) => document.id === id,
			);
		expect(await includes({ ...message(), roomId: pinRoom })).toBe(true);
		expect(await includes({ ...message(), roomId: otherRoom })).toBe(false);
		expect(await includes({ ...message(), entityId: OTHER_USER_ID })).toBe(
			false,
		);
		await expect(
			service.setDocumentPinsWithAccessContext(
				id,
				{ agent: true, roomIds: [] },
				owner,
				first.pinRevision,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_PIN_CONFLICT" });
		const snapshot = readDocumentMutationSnapshot(original);
		if (!snapshot) throw new Error("Invalid pin fixture");
		await expect(
			runtime.adapter.compareAndSwapDocument({
				agentId: runtime.agentId,
				requesterEntityId: USER_ID,
				requesterRole: "OWNER",
				requesterRoomIds: [],
				documentId: id,
				expected: snapshot,
				replacement: original,
			}),
		).resolves.toEqual({ status: "conflict" });
		const current = await service.getDocumentPinsWithAccessContext(id, owner);
		await expect(
			service.setDocumentPinsWithAccessContext(
				id,
				{ agent: false, roomIds: [missingRoom] },
				owner,
				current.pinRevision,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_PIN_ROOM_INVALID" });
		await expect(
			service.setDocumentPinsWithAccessContext(
				id,
				{ agent: false, roomIds: [pinRoom, pinRoom] },
				owner,
				current.pinRevision,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_PIN_TARGETS_INVALID" });
		await expect(
			service.setDocumentPinsWithAccessContext(
				id,
				{ agent: true, roomIds: [] },
				{ requesterEntityId: GRANTEE_ID, role: "GUEST", isOwner: false },
				current.pinRevision,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_PIN_FORBIDDEN" });
		await service.setDocumentPinsWithAccessContext(
			id,
			{ agent: true, roomIds: [] },
			owner,
			current.pinRevision,
		);
		expect(await includes({ ...message(), roomId: otherRoom })).toBe(true);
		expect(await includes({ ...message(), entityId: OTHER_USER_ID })).toBe(
			false,
		);
		await service.setDocumentPinsWithAccessContext(
			id,
			{ agent: false, roomIds: [] },
			owner,
			(await service.getDocumentPinsWithAccessContext(id, owner)).pinRevision,
		);
		expect(await includes({ ...message(), roomId: pinRoom })).toBe(false);
	});

	it("composes ordinary-conversation pins only for the complete chat audience and observes revocation", async () => {
		const service = new DocumentService(runtime);
		const roomId = "f4300000-0000-4000-8000-000000000060" as UUID;
		const id = "f4300000-0000-4000-8000-000000000061" as UUID;
		await runtime.ensureConnection({
			entityId: USER_ID,
			roomId,
			worldId: WORLD_ID,
			worldName: "Document authorization",
			userName: "Document owner",
			name: "Conversation pins",
			source: "test",
			type: ChannelType.GROUP,
		});
		const original = userPrivateDocument(
			id,
			"Hello COMPLETE_CONVERSATION_PIN\nAUDIENCE_SEARCH_FRAGMENT\nDo not lose the final line.",
		);
		original.metadata = {
			...original.metadata,
			type: MemoryType.DOCUMENT,
			pinTargets: { agent: true, roomIds: [] },
		};
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
			{
				memory: documentFragment(
					original,
					"Hello AUDIENCE_SEARCH_FRAGMENT",
					crypto.randomUUID() as UUID,
				),
				tableName: "document_fragments",
			},
		]);
		runtime.registerProvider(pinnedDocumentsProvider);
		runtime.registerProvider(documentsProvider);
		const getService = vi
			.spyOn(runtime, "getService")
			.mockImplementation((type) =>
				type === DocumentService.serviceType ? service : null,
			);
		const request = {
			...message(),
			roomId,
			content: {
				text: "Hello",
				source: "test",
				channelType: ChannelType.GROUP,
			},
		};
		const compose = async (context = "simple") => {
			const turnRequest = { ...request, id: crypto.randomUUID() as UUID };
			const names = selectV5PlannerStateProviderNames({
				runtime,
				message: turnRequest,
				selectedContexts: [context],
				userRoles: ["USER"],
			});
			return runtime.composeState(turnRequest, names, true);
		};
		try {
			expect((await compose()).text).toContain(original.content.text);
			expect(
				(
					await service.composeProviderDocuments(request)
				).relevantFragments.some(
					(fragment) =>
						fragment.content.text === "Hello AUDIENCE_SEARCH_FRAGMENT",
				),
			).toBe(true);
			expect((await compose("knowledge")).text).toContain(
				original.content.text,
			);
			await runtime.ensureConnection({
				entityId: GRANTEE_ID,
				roomId,
				worldId: WORLD_ID,
				worldName: "Document authorization",
				userName: "Guest",
				name: "Guest",
				source: "test",
				type: ChannelType.GROUP,
			});
			expect((await compose()).text).not.toContain("COMPLETE_CONVERSATION_PIN");
			expect(
				(
					await service.composeProviderDocuments(request)
				).relevantFragments.some(
					(fragment) =>
						fragment.content.text === "Hello AUDIENCE_SEARCH_FRAGMENT",
				),
			).toBe(false);
			expect((await compose("knowledge")).text).not.toContain(
				"AUDIENCE_SEARCH_FRAGMENT",
			);
			expect((await compose("knowledge")).text).not.toContain(
				"COMPLETE_CONVERSATION_PIN",
			);
			const owner = {
				requesterEntityId: USER_ID,
				role: "OWNER" as const,
				isOwner: true,
			};
			await service.setDocumentDirectGrantsWithAccessContext(
				id,
				[GRANTEE_ID],
				owner,
			);
			expect((await compose()).text).toContain(original.content.text);
			expect(
				(
					await service.composeProviderDocuments(request)
				).relevantFragments.some(
					(fragment) =>
						fragment.content.text === "Hello AUDIENCE_SEARCH_FRAGMENT",
				),
			).toBe(true);
			expect((await compose("knowledge")).text).toContain(
				original.content.text,
			);
			await service.setDocumentDirectGrantsWithAccessContext(id, [], owner);
			expect((await compose()).text).not.toContain("COMPLETE_CONVERSATION_PIN");
			expect(
				(
					await service.composeProviderDocuments(request)
				).relevantFragments.some(
					(fragment) =>
						fragment.content.text === "Hello AUDIENCE_SEARCH_FRAGMENT",
				),
			).toBe(false);
			expect((await compose("knowledge")).text).not.toContain(
				"AUDIENCE_SEARCH_FRAGMENT",
			);
			expect((await compose("knowledge")).text).not.toContain(
				"COMPLETE_CONVERSATION_PIN",
			);
			await service.setDocumentDirectGrantsWithAccessContext(
				id,
				[GRANTEE_ID],
				owner,
			);
			const read = service.getDocumentById.bind(service);
			let joined = false;
			const duringRead = vi
				.spyOn(service, "getDocumentById")
				.mockImplementation(async (...args) => {
					if (!joined) {
						joined = true;
						await runtime.ensureConnection({
							entityId: OTHER_USER_ID,
							roomId,
							worldId: WORLD_ID,
							worldName: "Document authorization",
							userName: "New participant",
							name: "New participant",
							source: "test",
							type: ChannelType.GROUP,
						});
					}
					return read(...args);
				});
			try {
				await expect(
					service.listConversationPins(request),
				).rejects.toMatchObject({ code: "DOCUMENT_PIN_CONTEXT_CHANGED" });
				await runtime.removeParticipant(OTHER_USER_ID, roomId);
				joined = false;
				await expect(
					service.composeProviderDocuments(request),
				).rejects.toMatchObject({ code: "DOCUMENT_CONTEXT_CHANGED" });
			} finally {
				duringRead.mockRestore();
			}
			expect((await compose()).text).not.toContain("COMPLETE_CONVERSATION_PIN");
			expect(
				(
					await service.composeProviderDocuments(request)
				).relevantFragments.some(
					(fragment) =>
						fragment.content.text === "Hello AUDIENCE_SEARCH_FRAGMENT",
				),
			).toBe(false);
			expect((await compose("knowledge")).text).not.toContain(
				"AUDIENCE_SEARCH_FRAGMENT",
			);
			expect((await compose("knowledge")).text).not.toContain(
				"COMPLETE_CONVERSATION_PIN",
			);
		} finally {
			getService.mockRestore();
		}
	});

	it("rejects search snippets from a revision replaced before audience inventory completes", async () => {
		const service = new DocumentService(runtime);
		const roomId = await privateConversation(USER_ID);
		const id = crypto.randomUUID() as UUID;
		const original = userPrivateDocument(id, "raceword old source");
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
			{
				memory: documentFragment(
					original,
					"raceword old source",
					crypto.randomUUID() as UUID,
				),
				tableName: "document_fragments",
			},
		]);
		const snapshot = readDocumentMutationSnapshot(original);
		if (!snapshot) throw new Error("Revision race fixture is invalid");
		const ready = Promise.withResolvers<void>();
		const query = runtime.adapter.queryDocuments.bind(runtime.adapter);
		const fragments = runtime.adapter.queryDocumentFragments.bind(
			runtime.adapter,
		);
		const inventory = vi
			.spyOn(runtime.adapter, "queryDocuments")
			.mockImplementation(async (...args) => {
				await ready.promise;
				return query(...args);
			});
		let scans = 0;
		const search = vi
			.spyOn(runtime.adapter, "queryDocumentFragments")
			.mockImplementation(async (...args) => {
				const rows = await fragments(...args);
				// Both complete scans and their empty continuation probes finish before the write.
				if (++scans === 4) {
					const replacement = {
						...original,
						content: { text: "raceword revised source" },
						metadata: {
							...original.metadata,
							type: MemoryType.DOCUMENT,
							documentRevision: 1,
						},
					};
					const mutation = await runtime.adapter.replaceDocumentRevision({
						agentId: runtime.agentId,
						documentId: id,
						requesterEntityId: USER_ID,
						requesterRole: "USER",
						requesterRoomIds: [ROOM_ID, roomId],
						expected: snapshot,
						replacement,
						fragments: [
							documentFragment(
								replacement,
								"raceword revised source",
								crypto.randomUUID() as UUID,
							),
						],
					});
					expect(mutation.status).toBe("updated");
					ready.resolve();
				}
				return rows;
			});
		try {
			await expect(
				service.composeProviderDocuments({
					...message(),
					roomId,
					content: { text: "raceword" },
				}),
			).rejects.toMatchObject({ code: "DOCUMENT_CONTEXT_CHANGED" });
		} finally {
			ready.resolve();
			inventory.mockRestore();
			search.mockRestore();
		}
		const current = await service.composeProviderDocuments({
			...message(),
			roomId,
			content: { text: "raceword" },
		});
		expect(
			current.relevantFragments.some(
				(fragment) => fragment.content.text === "raceword revised source",
			),
		).toBe(true);
		expect(
			current.relevantFragments.some(
				(fragment) => fragment.content.text === "raceword old source",
			),
		).toBe(false);
	});

	it("keeps the complete old revision when replacement embedding fails", async () => {
		const embed = async () => {
			if (failEmbedding) throw new Error("injected update embedding failure");
			return Array.from({ length: 384 }, (_, index) => (index % 11) / 10);
		};
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => embed(),
			"atomic-update-test",
			1_000,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async (_runtime, params: { texts?: string[] }) =>
				Promise.all((params.texts ?? []).map(() => embed())),
			"atomic-update-test",
			1_000,
		);
		const original = userPrivateDocument(
			FAILED_UPDATE_DOCUMENT_ID,
			"Failure original body",
		);
		const oldFragmentId = "f4300000-0000-4000-8000-000000000019" as UUID;
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
			{
				memory: documentFragment(
					original,
					"Failure old fragment",
					oldFragmentId,
				),
				tableName: "document_fragments",
			},
		]);
		failEmbedding = true;
		try {
			await expect(
				new DocumentService(runtime).updateDocument({
					documentId: FAILED_UPDATE_DOCUMENT_ID,
					content: "Replacement that must not become visible",
					message: message(),
				}),
			).rejects.toMatchObject({
				code: "DOCUMENT_REVISION_PREPARATION_FAILED",
				cause: expect.objectContaining({
					message: "injected update embedding failure",
				}),
			});
		} finally {
			failEmbedding = false;
		}
		await expect(
			runtime.adapter.getMemoryById(FAILED_UPDATE_DOCUMENT_ID),
		).resolves.toMatchObject({
			content: { text: "Failure original body" },
			metadata: { documentRevision: 0 },
		});
		await expect(
			runtime.adapter.getMemoryById(oldFragmentId),
		).resolves.toMatchObject({ content: { text: "Failure old fragment" } });
	});

	it("commits a parent and its replacement fragments as one revision", async () => {
		const original = userPrivateDocument(
			ATOMIC_UPDATE_DOCUMENT_ID,
			"Atomic original body",
		);
		const oldFragmentId = "f4300000-0000-4000-8000-000000000017" as UUID;
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
			{
				memory: documentFragment(
					original,
					"Atomic old fragment",
					oldFragmentId,
				),
				tableName: "document_fragments",
			},
		]);
		const service = new DocumentService(runtime);
		await expect(
			service.updateDocument({
				documentId: ATOMIC_UPDATE_DOCUMENT_ID,
				content: "Atomic replacement body",
				message: message(),
			}),
		).resolves.toMatchObject({ fragmentCount: 1 });

		const context = {
			agentId: runtime.agentId,
			requesterEntityId: USER_ID,
			requesterRoomIds: [ROOM_ID],
			requesterRole: "USER" as const,
		};
		const parent = await runtime.adapter.getDocument({
			...context,
			documentId: ATOMIC_UPDATE_DOCUMENT_ID,
		});
		const fragments = await runtime.adapter.queryDocumentFragments({
			...context,
			limit: 100,
		});
		const replacementFragments = fragments.filter(
			(fragment) => fragment.metadata?.documentId === ATOMIC_UPDATE_DOCUMENT_ID,
		);
		expect(parent).toMatchObject({
			content: { text: "Atomic replacement body" },
			metadata: { documentRevision: 1 },
		});
		expect(replacementFragments).toHaveLength(1);
		expect(replacementFragments[0]).toMatchObject({
			content: { text: "Atomic replacement body" },
			metadata: { documentRevision: 1, position: 0 },
		});
		await expect(
			runtime.adapter.getMemoryById(oldFragmentId),
		).resolves.toBeNull();
		if (!parent) throw new Error("Replacement parent was not readable");
		const expected = readDocumentMutationSnapshot(parent);
		if (!expected)
			throw new Error("Replacement parent has no mutation snapshot");
		const rejectedFragmentId = "f4300000-0000-4000-8000-000000000099" as UUID;
		const oversized = "x".repeat(32 * 1024 * 1024);
		await expect(
			runtime.adapter.replaceDocumentRevision({
				...context,
				documentId: ATOMIC_UPDATE_DOCUMENT_ID,
				expected,
				replacement: {
					...parent,
					content: { text: oversized },
					metadata: { ...parent.metadata, documentRevision: 2 },
				},
				fragments: [
					{
						...documentFragment(
							parent,
							"Unpublished fragment",
							rejectedFragmentId,
						),
						metadata: {
							...documentFragment(
								parent,
								"Unpublished fragment",
								rejectedFragmentId,
							).metadata,
							documentRevision: 2,
						},
					},
				],
			}),
		).rejects.toMatchObject({ code: "SQL_JSON_SANITIZE_UNBOUNDED" });
		await expect(
			runtime.adapter.getMemoryById(ATOMIC_UPDATE_DOCUMENT_ID),
		).resolves.toMatchObject({
			content: { text: "Atomic replacement body" },
			metadata: { documentRevision: 1 },
		});
		await expect(
			runtime.adapter.getMemoryById(rejectedFragmentId),
		).resolves.toBeNull();
		await expect(
			runtime.adapter.getMemoryById(replacementFragments[0].id as UUID),
		).resolves.toMatchObject({ content: { text: "Atomic replacement body" } });
	});

	it("denies same-turn update and delete after room membership is revoked", async () => {
		const service = new DocumentService(runtime);
		const getService = vi
			.spyOn(runtime, "getService")
			.mockImplementation((serviceType) =>
				serviceType === DocumentService.serviceType ? service : null,
			);
		const membershipReads = vi.spyOn(
			runtime.adapter,
			"getRoomsForParticipants",
		);
		const request = message();
		const accessContext = {
			requesterEntityId: USER_ID,
			role: "USER" as const,
			isOwner: false,
		};

		await runWithTrajectoryContext(
			{ turnMemo: new Map<string, Promise<unknown>>() },
			async () => {
				await expect(
					service.getDocumentById(UPDATE_DOCUMENT_ID, request),
				).resolves.toMatchObject({ id: UPDATE_DOCUMENT_ID });

				await expect(runtime.removeParticipant(USER_ID, ROOM_ID)).resolves.toBe(
					true,
				);
				const revokedRead = await documentAction.handler?.(
					runtime,
					request,
					undefined,
					{
						parameters: {
							action: "read",
							documentId: UPDATE_DOCUMENT_ID,
						},
					} as HandlerOptions,
				);
				expect(revokedRead?.success).toBe(false);
				expect(revokedRead?.values).toMatchObject({ error: "not_found" });

				await expect(
					service.updateDocument({
						documentId: UPDATE_DOCUMENT_ID,
						content: "Unauthorized replacement",
						message: request,
					}),
				).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
				await expect(
					service.deleteDocumentWithAccessContext(
						DELETE_DOCUMENT_ID,
						accessContext,
					),
				).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
			},
		);

		expect(membershipReads).toHaveBeenCalledTimes(4);
		const stored = await runtime.adapter.getMemoriesByIds(
			[UPDATE_DOCUMENT_ID, DELETE_DOCUMENT_ID],
			"documents",
		);
		expect(stored).toHaveLength(2);
		expect(
			stored.find((document) => document.id === UPDATE_DOCUMENT_ID)?.content,
		).toMatchObject({ text: "Original update body" });
		expect(
			stored.find((document) => document.id === DELETE_DOCUMENT_ID)?.content,
		).toMatchObject({ text: "Original delete body" });
		getService.mockRestore();
	});
});
