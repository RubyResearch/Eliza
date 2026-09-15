/**
 * Ingests a real PDF through the document service and SQL search index, then
 * verifies the owner can retrieve the complete original and parsed fragments.
 * The runtime uses real PGlite storage and PDF parsing without a model provider.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { ChannelType, type UUID } from "../../types/index.ts";
import { DocumentService } from "./service.ts";

it("retains a PDF whose base64 source exceeds the SQL index-entry limit", async () => {
	const owner = randomUUID() as UUID;
	const roomId = randomUUID() as UUID;
	const worldId = randomUUID() as UUID;
	const fixture = await createTestRuntime({
		characterName: "PdfStorageAcceptance",
		settings: { ELIZA_ADMIN_ENTITY_ID: owner },
	});
	try {
		const { runtime } = fixture;
		await runtime.ensureConnection({
			entityId: owner,
			roomId,
			worldId,
			worldName: "PDF storage",
			userName: "Synthetic owner",
			name: "PDF storage",
			source: "test",
			type: ChannelType.DM,
		});
		const service = new DocumentService(runtime);
		const bytes = await readFile(
			new URL("./__fixtures__/openzeppelin-v5.5-audit.pdf", import.meta.url),
		);
		const { storedDocumentMemoryId: id } = await service.addDocument({
			agentId: runtime.agentId,
			entityId: owner,
			addedBy: owner,
			roomId,
			worldId,
			clientDocumentId: "" as UUID,
			originalFilename: "source.pdf",
			contentType: "application/pdf",
			content: bytes.toString("base64"),
			scope: "owner-private",
		});
		const access = {
			requesterEntityId: owner,
			role: "OWNER" as const,
			isOwner: true,
		};
		const stored = await service.getDocumentByIdWithAccessContext(id, access);
		if (!stored || typeof stored.content.text !== "string")
			throw new Error("Owner cannot read the ingested PDF");
		expect(Buffer.from(stored.content.text, "base64")).toEqual(bytes);
		const fragments = await service.listDocumentFragmentsWithAccessContext(
			id,
			access,
		);
		expect(fragments.length).toBeGreaterThan(0);
		expect(
			fragments.map((fragment) => fragment.content.text).join("\n"),
		).toContain("OpenZeppelin");
	} finally {
		await fixture.cleanup();
	}
}, 120_000);
