/** Exercises real DOCUMENT dispatch and PGlite pin/reader CAS; synthetic identities exclude live-model and connector acceptance. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import {
	type ActionResult,
	ChannelType,
	type DocumentMemoryMetadata,
	type HandlerOptions,
	type Memory,
	MemoryType,
	type UUID,
} from "../../types";
import { documentAction } from "./actions.ts";
import { DocumentService } from "./service.ts";

const owner = "f4350000-0000-4000-8000-000000000001" as UUID;
const room = "f4350000-0000-4000-8000-000000000002" as UUID;
const world = "f4350000-0000-4000-8000-000000000003" as UUID;
const documentId = "f4350000-0000-4000-8000-000000000004" as UUID;
const reader = "f4350000-0000-4000-8000-000000000005" as UUID;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
	fixture = await createTestRuntime({
		characterName: "KnowledgeActionAcceptance",
		settings: { ELIZA_ADMIN_ENTITY_ID: owner, LOAD_DOCS_ON_STARTUP: false },
		plugins: [
			{
				name: "knowledge-action-fixture",
				description: "Real document service",
				services: [DocumentService],
			},
		],
	});
	for (const entityId of [owner, reader])
		await fixture.runtime.ensureConnection({
			entityId,
			roomId: room,
			worldId: world,
			worldName: "Synthetic knowledge actions",
			userName: entityId === owner ? "Owner" : "Reader",
			name: "Synthetic",
			source: "test",
			type: ChannelType.DM,
		});
	const metadata: DocumentMemoryMetadata = {
		type: MemoryType.DOCUMENT,
		scope: "owner-private",
		documentId,
		documentRevision: 0,
		addedBy: owner,
		addedByRole: "OWNER",
		addedFrom: "upload",
		source: "test",
		title: "Synthetic agreement",
		filename: "agreement.txt",
		originalFilename: "agreement.txt",
		fileExt: "txt",
		fileType: "text/plain",
		contentType: "text/plain",
		fileSize: Buffer.byteLength(
			"Synthetic agreement reference. Final line preserved.",
		),
		textBacked: true,
		addedAt: 1_000,
		timestamp: 1_000,
	};
	await fixture.runtime.createMemories([
		{
			tableName: "documents",
			memory: {
				id: documentId,
				agentId: fixture.runtime.agentId,
				entityId: owner,
				roomId: room,
				worldId: world,
				content: {
					text: "Synthetic agreement reference. Final line preserved.",
				},
				metadata,
			},
		},
	]);
}, 120_000);
afterAll(async () => {
	if (fixture) await fixture.cleanup();
}, 120_000);
async function dispatch(
	action: string,
	parameters: Record<string, unknown> = {},
	entityId = owner,
): Promise<ActionResult> {
	const message: Memory = {
		id: crypto.randomUUID() as UUID,
		entityId,
		agentId: fixture.runtime.agentId,
		roomId: room,
		worldId: world,
		content: { text: "Apply the requested knowledge settings." },
	};
	const output = await documentAction.handler(
		fixture.runtime,
		message,
		undefined,
		{ parameters: { action, documentId, ...parameters } } as HandlerOptions,
	);
	if (!output || typeof output !== "object" || !("success" in output))
		throw new Error("Missing action result");
	return output;
}
it("saves chat and agent pins, rejects a stale update, then removes pins without granting readership", async () => {
	const initial = await dispatch("inspect_pins");
	expect(initial.success).toBe(true);
	const saved = await dispatch("set_pins", {
		pinAgent: true,
		pinRoomIds: [room],
		expectedRevision: initial.data?.pinRevision,
	});
	expect(saved.success).toBe(true);
	expect(saved.data?.targets).toEqual({ agent: true, roomIds: [room] });
	const service = fixture.runtime.getService<DocumentService>(
		DocumentService.serviceType,
	);
	if (!service) throw new Error("Document service missing");
	expect(
		await service.getDocumentByIdWithAccessContext(documentId, {
			requesterEntityId: reader,
			role: "USER",
		}),
	).toBeNull();
	const stale = await dispatch("set_pins", {
		pinAgent: false,
		pinRoomIds: [],
		expectedRevision: initial.data?.pinRevision,
	});
	expect(stale.success).toBe(false);
	expect((await dispatch("inspect_pins")).data?.targets).toEqual({
		agent: true,
		roomIds: [room],
	});
	const removed = await dispatch("set_pins", {
		pinAgent: false,
		pinRoomIds: [],
		expectedRevision: saved.data?.pinRevision,
	});
	expect(removed.success).toBe(true);
	expect(removed.data?.targets).toEqual({ agent: false, roomIds: [] });
});
it("grants a named reader without mutation authority, and revokes the grant using an explicit empty list", async () => {
	const initial = await dispatch("inspect_readers");
	expect(initial.success).toBe(true);
	const saved = await dispatch("set_readers", {
		readerEntityIds: [reader],
		expectedRevision: initial.data?.accessRevision,
	});
	expect(saved.success).toBe(true);
	const service = fixture.runtime.getService<DocumentService>(
		DocumentService.serviceType,
	);
	if (!service) throw new Error("Document service missing");
	expect(
		(
			await service.getDocumentByIdWithAccessContext(documentId, {
				requesterEntityId: reader,
				role: "USER",
			})
		)?.id,
	).toBe(documentId);
	expect((await dispatch("inspect_pins", {}, reader)).success).toBe(false);
	expect(
		(
			await dispatch(
				"set_readers",
				{ readerEntityIds: [], expectedRevision: saved.data?.accessRevision },
				reader,
			)
		).success,
	).toBe(false);
	expect(
		(
			await dispatch("set_readers", {
				readerEntityIds: [],
				expectedRevision: initial.data?.accessRevision,
			})
		).success,
	).toBe(false);
	expect(
		(
			await dispatch("set_readers", {
				readerEntityIds: [],
				expectedRevision: saved.data?.accessRevision,
			})
		).success,
	).toBe(true);
	expect(
		await service.getDocumentByIdWithAccessContext(documentId, {
			requesterEntityId: reader,
			role: "USER",
		}),
	).toBeNull();
});

it("rejects unavailable chat targets, malformed readers and forged owner parameters without changing state", async () => {
	const pins = await dispatch("inspect_pins");
	for (const pinRoomIds of [
		["f4350000-0000-4000-8000-000000000099"],
		[room, room],
		["not-a-uuid"],
	]) {
		expect(
			(
				await dispatch("set_pins", {
					pinAgent: true,
					pinRoomIds,
					expectedRevision: pins.data?.pinRevision,
				})
			).success,
		).toBe(false);
	}
	expect((await dispatch("inspect_pins")).data).toEqual(pins.data);
	const readers = await dispatch("inspect_readers");
	for (const readerEntityIds of [
		[reader, reader],
		["not-a-uuid"],
		["f4350000-0000-4000-8000-000000000099"],
	]) {
		expect(
			(
				await dispatch("set_readers", {
					readerEntityIds,
					expectedRevision: readers.data?.accessRevision,
				})
			).success,
		).toBe(false);
	}
	expect(
		(
			await dispatch(
				"set_pins",
				{
					pinAgent: true,
					pinRoomIds: [room],
					expectedRevision: pins.data?.pinRevision,
					role: "OWNER",
					requesterEntityId: owner,
				},
				reader,
			)
		).success,
	).toBe(false);
	expect((await dispatch("inspect_readers")).data).toEqual(readers.data);
	expect((await dispatch("inspect_pins")).data).toEqual(pins.data);
});
