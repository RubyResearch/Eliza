/** Exercises literal and explicitly encoded text through real PGlite ingestion, fragment reads and deduplication. */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { ChannelType, type UUID } from "../../types/index.ts";
import { DocumentService } from "./service.ts";

it("preserves literal text and distinct source identities while decoding only explicit encoded text", async () => {
	const owner = randomUUID() as UUID;
	const roomId = randomUUID() as UUID;
	const worldId = randomUUID() as UUID;
	const fixture = await createTestRuntime({
		characterName: "TextEncodingAcceptance",
		settings: { ELIZA_ADMIN_ENTITY_ID: owner },
	});
	try {
		const { runtime } = fixture;
		await runtime.ensureConnection({
			entityId: owner,
			roomId,
			worldId,
			worldName: "Synthetic text",
			userName: "Owner",
			name: "Text encoding",
			source: "test",
			type: ChannelType.DM,
		});
		const service = new DocumentService(runtime);
		const access = {
			requesterEntityId: owner,
			role: "OWNER" as const,
			isOwner: true,
		};
		const add = (content: string, contentEncoding?: "utf8" | "base64") =>
			service.addDocument({
				agentId: runtime.agentId,
				entityId: owner,
				addedBy: owner,
				roomId,
				worldId,
				clientDocumentId: "" as UUID,
				originalFilename: "source.txt",
				contentType: "text/plain",
				content,
				...(contentEncoding ? { contentEncoding } : {}),
				scope: "owner-private",
			});
		const ids = new Set<string>();
		for (const text of [
			"Concurrent synthetic audience decisions",
			"SGVsbG8gV29ybGQh",
			"\ufeffHello",
			"Hello World!",
			"  Hello World!\n",
			"First line\nSchool pickup 🏫\nFinal line preserved.",
		]) {
			const saved = await add(text);
			expect(ids.has(saved.storedDocumentMemoryId)).toBe(false);
			ids.add(saved.storedDocumentMemoryId);
			expect(
				(
					await service.getDocumentByIdWithAccessContext(
						saved.storedDocumentMemoryId,
						access,
					)
				)?.content.text,
			).toBe(text);
			const fragments = await service.listDocumentFragmentsWithAccessContext(
				saved.storedDocumentMemoryId,
				access,
			);
			expect(
				fragments.map((fragment) => fragment.content.text).join("\n"),
			).toContain(text.trim());
			expect((await add(text)).storedDocumentMemoryId).toBe(
				saved.storedDocumentMemoryId,
			);
			expect(
				(await add(Buffer.from(text, "utf8").toString("base64"), "base64"))
					.storedDocumentMemoryId,
			).toBe(saved.storedDocumentMemoryId);
		}
		const literal = await add("Hello World!");
		expect(
			(await add("SGVsbG8gV29ybGQh", "base64")).storedDocumentMemoryId,
		).toBe(literal.storedDocumentMemoryId);
		await expect(add("not valid base64!", "base64")).rejects.toMatchObject({
			code: "DOCUMENT_BASE64_INVALID",
		});
		await expect(add("/w==", "base64")).rejects.toMatchObject({
			code: "DOCUMENT_ENCODING_INVALID",
		});
		await expect(add("broken\ud800text")).rejects.toMatchObject({
			code: "DOCUMENT_ENCODING_INVALID",
		});
	} finally {
		await fixture.cleanup();
	}
}, 120_000);
