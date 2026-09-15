/** Exercises chat-audience ingestion, deduplication and membership changes against real PGlite storage; text fragments are deterministic and no external model is called. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { ChannelType, type Memory, type UUID } from "../../types/index.ts";
import { documentAction } from "./actions.ts";
import { DocumentService } from "./service.ts";
import type { AddDocumentOptions } from "./types.ts";

const owner = randomUUID() as UUID;
const guest = randomUUID() as UUID;
const outsider = randomUUID() as UUID;
const worldId = randomUUID() as UUID;
const roomId = randomUUID() as UUID;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let service: DocumentService;

async function join(entityId: UUID, room = roomId) {
	await fixture.runtime.ensureConnection({
		entityId,
		roomId: room,
		worldId,
		worldName: "Synthetic family",
		userName: "Synthetic participant",
		name: "Family planning",
		source: "test",
		type: ChannelType.GROUP,
	});
}

function options(
	content = "School pickup is Friday at 3 PM.",
): AddDocumentOptions {
	return {
		agentId: fixture.runtime.agentId,
		entityId: owner,
		addedBy: owner,
		worldId,
		roomId,
		clientDocumentId: "" as UUID,
		originalFilename: "family-note.txt",
		contentType: "text/plain",
		content,
		audience: "chat",
	};
}

function message(entityId: UUID, room = roomId): Memory {
	return {
		agentId: fixture.runtime.agentId,
		entityId,
		worldId,
		roomId: room,
		content: { text: "Read the shared note" },
	};
}

beforeAll(async () => {
	fixture = await createTestRuntime({
		characterName: "ChatKnowledgeAcceptance",
		settings: { ELIZA_ADMIN_ENTITY_ID: owner },
	});
	service = new DocumentService(fixture.runtime);
	await fixture.runtime.ensureWorldExists({
		id: worldId,
		name: "Synthetic family",
		agentId: fixture.runtime.agentId,
		metadata: {
			roles: { [owner]: "OWNER", [guest]: "GUEST", [outsider]: "USER" },
			roleSources: {
				[owner]: "manual",
				[guest]: "manual",
				[outsider]: "manual",
			},
		},
	});
	await join(owner);
	await join(guest);
	await join(outsider, randomUUID() as UUID);
}, 120_000);
afterAll(async () => {
	if (fixture) await fixture.cleanup();
}, 120_000);

it("shares only with current chat participants without reusing a private document or another chat's record", async () => {
	const input = options();
	const privateDocument = await service.addDocument({
		...input,
		audience: undefined,
		scope: "owner-private",
	});
	const lookalike = await service.addDocument({
		...input,
		audience: undefined,
		scope: "owner-private",
		originalFilename: `${input.originalFilename}::chat:${roomId}:${owner}`,
	});
	const shared = await service.addDocument(input);
	expect(shared.storedDocumentMemoryId).not.toBe(
		lookalike.storedDocumentMemoryId,
	);
	expect(
		await service.getDocumentById(
			lookalike.storedDocumentMemoryId,
			message(guest),
		),
	).toBeNull();
	expect(shared.storedDocumentMemoryId).not.toBe(
		privateDocument.storedDocumentMemoryId,
	);
	expect((await service.addDocument(input)).storedDocumentMemoryId).toBe(
		shared.storedDocumentMemoryId,
	);
	expect(
		(
			await service.getDocumentById(
				shared.storedDocumentMemoryId,
				message(guest),
			)
		)?.content.text,
	).toBe(input.content);
	expect(
		await service.getDocumentById(
			privateDocument.storedDocumentMemoryId,
			message(guest),
		),
	).toBeNull();
	expect(
		await service.getDocumentById(
			shared.storedDocumentMemoryId,
			message(outsider),
		),
	).toBeNull();
	await fixture.runtime.removeParticipant(guest, roomId);
	expect(
		await service.getDocumentById(
			shared.storedDocumentMemoryId,
			message(guest),
		),
	).toBeNull();
	await join(guest);
	expect(
		(
			await service.getDocumentById(
				shared.storedDocumentMemoryId,
				message(guest),
			)
		)?.content.text,
	).toBe(input.content);
	const secondRoom = randomUUID() as UUID;
	await join(owner, secondRoom);
	const second = await service.addDocument({ ...input, roomId: secondRoom });
	expect(second.storedDocumentMemoryId).not.toBe(shared.storedDocumentMemoryId);
	expect(
		await service.getDocumentById(
			second.storedDocumentMemoryId,
			message(guest),
		),
	).toBeNull();
}, 120_000);

it("rejects forged room origins, private/chat ambiguity and separately granted readers", async () => {
	await expect(
		service.addDocument({
			...options(),
			entityId: outsider,
			addedBy: outsider,
		}),
	).rejects.toMatchObject({ code: "DOCUMENT_CHAT_SHARING_FORBIDDEN" });
	await expect(
		service.addDocument({ ...options(), scope: "owner-private" }),
	).rejects.toMatchObject({ code: "DOCUMENT_CHAT_SHARING_FORBIDDEN" });
	await expect(
		service.addDocument({ ...options(), worldId: randomUUID() as UUID }),
	).rejects.toMatchObject({ code: "DOCUMENT_CHAT_SHARING_FORBIDDEN" });
	await expect(
		service.addDocument({
			...options(),
			metadata: { directGrantEntityIds: [outsider] },
		}),
	).rejects.toMatchObject({ code: "DOCUMENT_CHAT_SHARING_INVALID" });
	const input = options("A second synthetic note.");
	const shared = await service.addDocument(input);
	await service.setDocumentDirectGrantsWithAccessContext(
		shared.storedDocumentMemoryId,
		[outsider],
		{ requesterEntityId: owner, role: "OWNER", isOwner: true },
	);
	await expect(service.addDocument(input)).rejects.toMatchObject({
		code: "DOCUMENT_CHAT_SHARING_CHANGED",
	});
}, 120_000);

it("rolls back an in-flight chat ingestion if its author loses membership before publication", async () => {
	const input = options("Do not publish after the author leaves.");
	const create = fixture.runtime.createMemory.bind(fixture.runtime);
	const interception = vi
		.spyOn(fixture.runtime, "createMemory")
		.mockImplementation(async (...args) => {
			const result = await create(...args);
			if (args[1] === "document_fragments")
				await fixture.runtime.removeParticipant(owner, roomId);
			return result;
		});
	try {
		await expect(service.addDocument(input)).rejects.toMatchObject({
			code: "DOCUMENT_PROCESSING_FAILED",
			cause: { code: "DOCUMENT_CHAT_SHARING_FORBIDDEN" },
		});
	} finally {
		interception.mockRestore();
		await join(owner);
	}
	const visible = await service.listAllDocumentsWithAccessContext({
		requesterEntityId: guest,
		role: "GUEST",
		isOwner: false,
	});
	expect(
		visible.some((document) => document.content.text === input.content),
	).toBe(false);
	const recovered = await service.addDocument(input);
	expect(
		(
			await service.getDocumentById(
				recovered.storedDocumentMemoryId,
				message(guest),
			)
		)?.content.text,
	).toBe(input.content);
}, 120_000);

it("defaults the owner's chat write action to participants while preserving explicit private writes and guest restrictions", async () => {
	const originalGetService = fixture.runtime.getService.bind(fixture.runtime);
	const installed = vi
		.spyOn(fixture.runtime, "getService")
		.mockImplementation((type) =>
			type === DocumentService.serviceType ? service : originalGetService(type),
		);
	const write = async (entityId: UUID, scope?: string) => {
		const result = await documentAction.handler?.(
			fixture.runtime,
			message(entityId),
			undefined,
			{
				parameters: {
					action: "write",
					text: "A note created through the chat action.",
					title: "Chat action acceptance",
					...(scope ? { scope } : {}),
				},
			},
		);
		return result;
	};
	try {
		const shared = await write(owner);
		expect(shared?.success).toBe(true);
		const sharedId = shared?.data?.documentId;
		if (typeof sharedId !== "string")
			throw new Error("Chat action did not return a stored document");
		expect(
			(await service.getDocumentById(sharedId as UUID, message(guest)))?.content
				.text,
		).toBe("A note created through the chat action.");
		expect(shared?.data?.audience).toBe("chat");
		const privateResult = await write(owner, "owner-private");
		expect(privateResult?.success).toBe(true);
		const privateId = privateResult?.data?.documentId;
		if (typeof privateId !== "string")
			throw new Error("Private action did not return a stored document");
		expect(privateId).not.toBe(sharedId);
		expect(
			await service.getDocumentById(privateId as UUID, message(guest)),
		).toBeNull();
		expect((await write(guest))?.success).toBe(false);
	} finally {
		installed.mockRestore();
	}
}, 120_000);
