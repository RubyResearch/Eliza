/**
 * The `DOCUMENTS` dynamic provider: injects the agent's relevant and recent
 * documents into the prompt for the `documents` context. It pulls the
 * relevant fragments (via `DocumentService.searchDocuments`) plus the list
 * of available/recent documents (via `listDocuments`), rendering snippets and
 * document IDs the agent can cite or follow up to read. Discovery-capable turns
 * keep the complete index and pinned knowledge inline and read snippets on demand.
 * The full provider result remains available for restoration and traces. Returns an
 * empty/unavailable payload when no `DocumentService` is registered. Gated to the
 * exact `documents` and `knowledge` contexts for resolved roles, with
 * per-turn cache scope.
 */

import {
	type IAgentRuntime,
	type Memory,
	MemoryType,
	type Provider,
} from "../../types";
import { addHeader } from "../../utils";
import { isDocumentPinnedForRoom } from "./pinning.ts";
import { DocumentService } from "./service.ts";
import type { DocumentMetadataExtended } from "./types.ts";
import { normalizeDocumentSourceValue } from "./utils.ts";

function getDocumentTitle(memory: Memory, index: number): string {
	const metadata = memory.metadata as DocumentMetadataExtended | undefined;
	const title =
		metadata?.title ?? metadata?.filename ?? metadata?.documentTitle;
	return typeof title === "string" && title.trim().length > 0
		? title.trim()
		: `Document ${index + 1}`;
}

export function renderPinnedDocuments(
	documents: Memory[],
	roomId?: Memory["roomId"],
): {
	text: string;
	truncated: boolean;
	includedIds: Array<Memory["id"]>;
} {
	const pinned = documents
		.filter((document) => {
			const metadata = document.metadata as
				| DocumentMetadataExtended
				| undefined;
			return (
				metadata?.type === MemoryType.DOCUMENT &&
				isDocumentPinnedForRoom(document, roomId)
			);
		})
		.sort((a, b) => {
			const titleOrder = getDocumentTitle(a, 0).localeCompare(
				getDocumentTitle(b, 0),
			);
			return titleOrder || String(a.id ?? "").localeCompare(String(b.id ?? ""));
		});
	if (pinned.length === 0) {
		return { text: "", truncated: false, includedIds: [] };
	}
	const includedIds: Array<Memory["id"]> = [];
	const blocks: string[] = [];
	for (const [index, document] of pinned.entries()) {
		const content = document.content.text ?? "";
		const header = `## ${getDocumentTitle(document, index)} (${document.id}; reference document:${document.id})`;
		const block = `${header}\n${content}`;
		blocks.push(block);
		includedIds.push(document.id);
	}
	return { text: blocks.join("\n\n"), truncated: false, includedIds };
}

function summarizeDocument(memory: Memory, index: number) {
	const metadata = memory.metadata as DocumentMetadataExtended | undefined;
	return {
		id: memory.id,
		name: getDocumentTitle(memory, index),
		scope: metadata?.scope ?? "global",
		source: normalizeDocumentSourceValue(metadata?.source),
		updatedAt:
			typeof metadata?.editedAt === "number"
				? metadata.editedAt
				: memory.createdAt,
	};
}

export const documentsProvider: Provider = {
	name: "DOCUMENTS",
	description:
		"Relevant and recent documents from the agent document store, including snippets and document IDs for follow-up reads.",
	position: -10,
	dynamic: true,
	// Context gates use exact membership rather than expanding parent/child
	// relationships. Stage 1 can route stored-knowledge requests directly to
	// `knowledge`, so both exact contexts must opt into the same scoped provider.
	contexts: ["documents", "knowledge"],
	contextGate: { anyOf: ["documents", "knowledge"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "GUEST" },

	get: async (runtime: IAgentRuntime, message: Memory) => {
		const service = runtime.getService<DocumentService>(
			DocumentService.serviceType,
		);
		if (!service) {
			return {
				text: "",
				values: {
					documentsAvailable: false,
					documentsRelevant: [],
					documents: [],
				},
				data: { available: false },
			};
		}

		const { relevantFragments, documents, pinnedDocuments } =
			await service.composeProviderDocuments(message);
		const pinned = renderPinnedDocuments(pinnedDocuments, message.roomId);
		const relevantSnippets = relevantFragments.map((fragment, index) => {
			const metadata = fragment.metadata as
				| DocumentMetadataExtended
				| undefined;
			return {
				id: fragment.id,
				documentId: metadata?.documentId,
				name:
					metadata?.filename ??
					metadata?.title ??
					(typeof metadata?.documentTitle === "string"
						? metadata.documentTitle
						: undefined) ??
					`Snippet ${index + 1}`,
				text: fragment.content.text ?? "",
				score: fragment.similarity,
				scope: metadata?.scope ?? "global",
			};
		});

		const summaries = documents
			.filter((memory) => memory.metadata?.type === MemoryType.DOCUMENT)
			.map(summarizeDocument);
		const recentDocuments = summaries;

		const snippetsText = relevantSnippets
			.map((item) => `- [${item.name}] ${item.text}`)
			.join("\n");
		const recentText = recentDocuments
			.map((item) => `- ${item.name} (${item.id}, ${item.scope})`)
			.join("\n");
		const text = addHeader(
			"# Documents",
			[
				pinned.text
					? `Pinned knowledge (always applicable):\n${pinned.text}`
					: "",
				snippetsText,
				recentText ? `Recent documents:\n${recentText}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		);

		const payload = {
			documents: summaries,
			documentsAvailable: summaries.length > 0,
			documentsRelevant: relevantSnippets,
			recentDocuments,
			documentsCount: summaries.length,
			pinnedDocumentIds: pinned.includedIds,
			pinnedDocumentsTruncated: pinned.truncated,
		};

		// Pins are standing context, not optional retrieval. Only ordinary
		// snippets participate in the existing authorized provider-read protocol.
		const discoveryText = [
			'context_discovery: DOCUMENTS\nDocument reference snippets are available in full. Read DOCUMENTS before answering from their contents: Stage 1 uses contextRequests=["DOCUMENTS"]; planning/completion use the existing provider-context restoration. Opening an app view or operating on Notes does not require document help snippets. Titles alone do not prove document contents.',
			pinned.text
				? `Pinned knowledge (always applicable):\n${pinned.text}`
				: "",
			recentText ? `Available documents (complete index):\n${recentText}` : "",
		]
			.filter(Boolean)
			.join("\n\n");

		return {
			text,
			...(relevantSnippets.length > 0 ? { discoveryText } : {}),
			values: payload,
			data: {
				...payload,
				available: true,
			},
		};
	},
};
