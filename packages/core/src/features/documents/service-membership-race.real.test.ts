/** Exercises document grant mutation after an intervening membership revocation against real PGlite storage. */
import { expect, it, vi } from "vitest";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { ChannelType, MemoryType, type UUID } from "../../types/index.ts";
import { DocumentService } from "./service.ts";

it("does not accept a room-admin grant after membership is revoked before the write", async () => {
	const { runtime, cleanup } = await createTestRuntime({
		characterName: "DocumentMembershipFence",
	});
	const admin = "f4310000-0000-4000-8000-000000000001" as UUID;
	const grantee = "f4310000-0000-4000-8000-000000000002" as UUID;
	const room = "f4310000-0000-4000-8000-000000000003" as UUID;
	const world = "f4310000-0000-4000-8000-000000000004" as UUID;
	const documentId = "f4310000-0000-4000-8000-000000000005" as UUID;
	try {
		await runtime.ensureConnection({
			entityId: admin,
			roomId: room,
			worldId: world,
			worldName: "Membership fence",
			userName: "Admin",
			name: "Admin",
			source: "test",
			type: ChannelType.GROUP,
		});
		await runtime.adapter.createEntities([
			{ id: grantee, agentId: runtime.agentId, names: ["Grantee"] },
		]);
		await runtime.createMemories([
			{
				tableName: "documents",
				memory: {
					id: documentId,
					agentId: runtime.agentId,
					entityId: admin,
					roomId: room,
					worldId: world,
					content: { text: "Synthetic restricted source" },
					metadata: {
						type: MemoryType.DOCUMENT,
						scope: "global",
						documentId,
						documentRevision: 0,
						addedBy: admin,
						addedByRole: "ADMIN",
						addedFrom: "upload",
						addedAt: 1000,
						timestamp: 1000,
						title: "Membership source",
						filename: "source.txt",
						originalFilename: "source.txt",
						fileExt: "txt",
						fileType: "text/plain",
						contentType: "text/plain",
						fileSize: 27,
						textBacked: true,
						source: "test",
					},
				},
			},
		]);
		const write = runtime.adapter.updateDocumentDirectGrants.bind(
			runtime.adapter,
		);
		const interception = vi
			.spyOn(runtime.adapter, "updateDocumentDirectGrants")
			.mockImplementationOnce(async (params) => {
				await runtime.removeParticipant(admin, room);
				return write(params);
			});
		try {
			await expect(
				new DocumentService(runtime).setDocumentDirectGrantsWithAccessContext(
					documentId,
					[grantee],
					{
						requesterEntityId: admin,
						role: "ADMIN",
						isOwner: false,
					},
				),
			).rejects.toMatchObject({ code: "DOCUMENT_GRANT_MUTATION_FORBIDDEN" });
			await expect(
				runtime.adapter.getDocument({
					agentId: runtime.agentId,
					documentId,
					requesterEntityId: grantee,
					requesterRoomIds: [],
					requesterRole: "USER",
				}),
			).resolves.toBeNull();
		} finally {
			interception.mockRestore();
		}
	} finally {
		await cleanup();
	}
}, 120_000);
