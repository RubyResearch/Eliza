/**
 * Exercises pinned-document provider pagination through the production service
 * boundary with deterministic adapter responses.
 */
import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_LIST_MAX_LIMIT } from "../../database/document-list-query";
import { projectDeferredProviders } from "../../runtime/provider-context";
import { type Memory, MemoryType, type UUID } from "../../types";
import type { ContextObject } from "../../types/context-object";
import { documentsProvider, renderPinnedDocuments } from "./provider";
import { DocumentService } from "./service";

const id = (value: string) => value.padEnd(36, "0") as UUID;

function document(title: string, text: string, pinned = false): Memory {
	return {
		id: id(title),
		agentId: id("agent"),
		entityId: id("entity"),
		roomId: id("room"),
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			source: "test",
			title,
			pinned,
		},
	};
}

function runtimeWithDocumentQuery(
	queryDocuments: ReturnType<typeof vi.fn>,
	agentId = "00000000-0000-0000-0000-0000000000a1" as UUID,
) {
	return {
		agentId,
		adapter: {
			documentListQueryCapability: 4,
			queryDocuments,
			queryDocumentFragments: vi.fn(async () => []),
			getDocument: vi.fn(async () => null),
			compareAndSwapDocument: vi.fn(async () => ({ status: "ok" })),
			updateDocumentDirectGrants: vi.fn(async () => ({ status: "ok" })),
			replaceDocumentRevision: vi.fn(async () => ({ status: "ok" })),
			deleteDocumentWithSnapshot: vi.fn(async () => ({ status: "ok" })),
		},
		getMemories: vi.fn(async () => []),
		searchMemories: vi.fn(async () => []),
		getModel: vi.fn(() => null),
		reportError: vi.fn(),
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
	};
}

function listAllProviderDocuments(
	service: DocumentService,
	agentId = "00000000-0000-0000-0000-0000000000a1" as UUID,
): Promise<Memory[]> {
	return (
		service as unknown as {
			listAllDocumentsWithRequester(
				resolveRequester: () => Promise<{
					entityId: UUID;
					roomIds: UUID[];
					role: "RUNTIME";
				}>,
			): Promise<Memory[]>;
		}
	).listAllDocumentsWithRequester(async () => ({
		entityId: agentId,
		roomIds: [],
		role: "RUNTIME",
	}));
}

describe("pinned DOCUMENTS provider knowledge", () => {
	it("keeps an irrelevant unpinned document absent, then injects it whole when pinned", async () => {
		const irrelevant = document("Operating rules", "ALWAYS TELL THE TRUTH");
		const service = {
			composeProviderDocuments: vi.fn(async () => ({
				relevantFragments: [],
				documents: [irrelevant],
				pinnedDocuments:
					irrelevant.metadata?.pinned === true ? [irrelevant] : [],
			})),
		};
		const runtime = {
			getService: vi.fn((type: string) =>
				type === DocumentService.serviceType ? service : null,
			),
		};
		const message = document("query", "What is the weather?");

		const before = await documentsProvider.get(runtime as never, message);
		expect(before.text).not.toContain("ALWAYS TELL THE TRUTH");
		expect(before.data?.pinnedDocumentIds).toEqual([]);

		irrelevant.metadata = { ...irrelevant.metadata, pinned: true };
		const after = await documentsProvider.get(runtime as never, message);
		expect(after.text).toContain("ALWAYS TELL THE TRUTH");
		expect(after.data?.pinnedDocumentIds).toEqual([irrelevant.id]);
		expect(service.composeProviderDocuments).toHaveBeenLastCalledWith(message);
	});

	it("preserves ordinary retrieval snippets for unpinned documents", async () => {
		const unpinned = document("Reference", "whole text stays unpinned");
		const runtime = {
			getService: vi.fn(() => ({
				composeProviderDocuments: vi.fn(async () => ({
					relevantFragments: [
						{
							id: id("fragment"),
							content: { text: "retrieved fragment" },
							metadata: { title: "Reference", documentId: unpinned.id },
							similarity: 0.91,
						},
					],
					documents: [unpinned],
					pinnedDocuments: [],
				})),
			})),
		};
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "reference query"),
		);
		expect(result.text).toContain("retrieved fragment");
		expect(result.text).not.toContain("whole text stays unpinned");
	});

	it("defers retrieved bodies while keeping pins and every index entry, then restores the exact body", async () => {
		const pin = document(
			"Standing rule",
			"Never send without APPROVE. ".repeat(2000),
			true,
		);
		const docs = Array.from({ length: 40 }, (_, index) =>
			document(`Reference ${index}`, `body ${index}`),
		);
		const fragment = document("Help", "Complete help fragment\n".repeat(500));
		const runtime = {
			getService: () => ({
				composeProviderDocuments: async () => ({
					relevantFragments: [fragment],
					documents: [...docs, pin],
					pinnedDocuments: [pin],
				}),
			}),
		};
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "open Notes"),
		);
		const context: ContextObject = {
			id: "documents-discovery",
			metadata: { providerDiscoveryEnabled: true },
			staticPrefix: {},
			events: [
				{
					id: "provider-documents",
					type: "provider",
					source: "test",
					createdAt: 0,
					name: "DOCUMENTS",
					text: result.text ?? "",
					discoveryText: result.discoveryText,
				},
			],
		};
		const original = structuredClone(context);
		const projected = projectDeferredProviders(context);
		expect(projected.available).toEqual(["DOCUMENTS"]);
		const text = JSON.stringify(projected.context.events);
		expect(result.discoveryText).toContain(pin.content.text);
		for (const doc of docs) expect(text).toContain(doc.id);
		expect(projected.context.events[0]).toMatchObject({
			text: result.discoveryText,
		});
		expect(result.discoveryText).not.toContain(fragment.content.text);
		expect(result.text).toContain(fragment.content.text);
		expect(context).toEqual(original);
		const restored = projectDeferredProviders({
			...context,
			metadata: { ...context.metadata, loadedContextProviders: ["DOCUMENTS"] },
		});
		expect(restored.available).toEqual([]);
		expect(restored.context.events).toEqual(original.events);
		expect(
			projectDeferredProviders({ ...context, metadata: {} }).context.events,
		).toEqual(original.events);
	});

	it("orders pinned documents deterministically", () => {
		const first = document("B rules", "BBBB", true);
		const second = document("A rules", "AAAA", true);
		const rendered = renderPinnedDocuments([first, second]);
		expect(rendered.text.indexOf("A rules")).toBeLessThan(
			rendered.text.indexOf("B rules"),
		);
		expect(rendered.truncated).toBe(false);
	});

	it("injects an authorized pin while retaining the complete document inventory", async () => {
		const recent = Array.from({ length: 25 }, (_, index) =>
			document(`Recent ${index}`, `recent ${index}`),
		);
		const olderPinned = document("Standing rule", "NEVER FABRICATE", true);
		const runtime = {
			getService: vi.fn(() => ({
				composeProviderDocuments: vi.fn(async () => ({
					relevantFragments: [],
					documents: [...recent, olderPinned],
					pinnedDocuments: [olderPinned],
				})),
			})),
		};
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "unrelated query"),
		);
		expect(result.text).toContain("NEVER FABRICATE");
		expect(result.data?.documents).toHaveLength(26);
		expect(result.data?.pinnedDocumentIds).toEqual([olderPinned.id]);
	});

	it("preserves oversized pinned content completely", async () => {
		const oversized = document("Ground truth", "X".repeat(40_000), true);
		const runtime = {
			getService: vi.fn(() => ({
				composeProviderDocuments: vi.fn(async () => ({
					relevantFragments: [],
					documents: [oversized],
					pinnedDocuments: [oversized],
				})),
			})),
		};
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "unrelated query"),
		);
		expect(result.text).toContain("X".repeat(40_000));
		expect(result.text).toContain(`reference document:${oversized.id}`);
		expect(result.data?.pinnedDocumentsTruncated).toBe(false);
		expect(result.data?.pinnedDocumentIds).toEqual([oversized.id]);
	});

	it("preserves every pinned source and wrapper without a shared budget", () => {
		const documents = Array.from({ length: 25 }, (_, index) =>
			document(`${index}-${"title".repeat(80)}`, "X".repeat(40_000), true),
		);
		const rendered = renderPinnedDocuments(documents);
		expect(rendered.truncated).toBe(false);
		expect(rendered.includedIds).toHaveLength(25);
		for (const item of documents) {
			expect(rendered.text).toContain(`reference document:${item.id}`);
			expect(rendered.text).toContain(item.content.text);
		}
	});

	it("preserves complete pinned titles regardless of length", () => {
		const longTitle = `critical-${"owner-authored-title-".repeat(20)}`;
		const rendered = renderPinnedDocuments([
			document(longTitle, "complete source", true),
		]);
		expect(rendered.text).toContain(longTitle);
	});

	it("rejects repeating pagination cursors when listing pinned documents", async () => {
		const agentId = "00000000-0000-0000-0000-0000000000a1" as UUID;
		const queryDocumentsMock = vi.fn(async () => ({
			status: "ok",
			totalVisible: 0,
			totalAvailable: 0,
			totalMatched: 0,
			documents: [],
			availableDocuments: [],
			availableHasMore: false,
			hasMore: true,
			nextCursor: {
				createdAt: 1000,
				id: "00000000-0000-0000-0000-0000000000c1" as UUID,
			},
		}));
		const runtime = {
			agentId,
			getRoom: async () => ({ agentId }),
			getParticipantsForRoom: async () => [agentId],
			adapter: {
				documentListQueryCapability: 4,
				queryDocuments: queryDocumentsMock,
				queryDocumentFragments: vi.fn(async () => []),
				getDocument: vi.fn(async () => null),
				compareAndSwapDocument: vi.fn(async () => ({ status: "ok" })),
				updateDocumentDirectGrants: vi.fn(async () => ({ status: "ok" })),
				replaceDocumentRevision: vi.fn(async () => ({ status: "ok" })),
				deleteDocumentWithSnapshot: vi.fn(async () => ({ status: "ok" })),
			},
			getMemories: vi.fn(async () => []),
			searchMemories: vi.fn(async () => []),
			getModel: vi.fn(() => null),
			reportError: vi.fn(),
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		};
		const service = new DocumentService(runtime as never);
		const message = {
			...document("query", "test query"),
			entityId: agentId,
		};

		await expect(
			service.composeProviderDocuments(message),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_CURSOR_LOOP",
		});
	});

	it("rejects an oversized adapter page before filtering or retaining rows", async () => {
		const oversizedPage = Array.from(
			{ length: DOCUMENT_LIST_MAX_LIMIT + 1 },
			(_, index) => document(`Pinned ${index}`, "bounded", true),
		);
		const queryDocumentsMock = vi.fn(async () => ({
			totalVisible: oversizedPage.length,
			totalAvailable: oversizedPage.length,
			totalMatched: oversizedPage.length,
			documents: oversizedPage,
			availableDocuments: [],
			availableHasMore: false,
			hasMore: false,
		}));
		const service = new DocumentService(
			runtimeWithDocumentQuery(queryDocumentsMock) as never,
		);

		await expect(listAllProviderDocuments(service)).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_RESULT",
		});
		expect(queryDocumentsMock).toHaveBeenCalledTimes(1);
	});

	it("rejects a malformed adapter cursor with a typed integrity failure", async () => {
		const queryDocumentsMock = vi.fn(async () => ({
			totalVisible: 0,
			totalAvailable: 0,
			totalMatched: 0,
			documents: [],
			availableDocuments: [],
			availableHasMore: false,
			hasMore: true,
			nextCursor: { createdAt: 1, id: 7 },
		}));
		const service = new DocumentService(
			runtimeWithDocumentQuery(queryDocumentsMock) as never,
		);

		await expect(listAllProviderDocuments(service)).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_RESULT",
		});
		expect(queryDocumentsMock).toHaveBeenCalledTimes(1);
	});

	it("detects a logical cursor cycle despite changing object shape", async () => {
		let pinnedCalls = 0;
		const cursor = {
			createdAt: 1000,
			id: "00000000-0000-0000-0000-0000000000c1" as UUID,
		};
		const queryDocumentsMock = vi.fn(async ({ limit }: { limit: number }) => {
			if (limit !== DOCUMENT_LIST_MAX_LIMIT) {
				return {
					status: "ok",
					totalVisible: 0,
					totalAvailable: 0,
					totalMatched: 0,
					documents: [],
					availableDocuments: [],
					availableHasMore: false,
					hasMore: false,
				};
			}
			pinnedCalls += 1;
			return {
				status: "ok",
				totalVisible: 0,
				totalAvailable: 0,
				totalMatched: 0,
				documents: [],
				availableDocuments: [],
				availableHasMore: false,
				hasMore: true,
				nextCursor:
					pinnedCalls === 1
						? { ...cursor, ignoredAdapterField: "first" }
						: {
								ignoredAdapterField: `different-${pinnedCalls}`,
								id: cursor.id,
								createdAt: cursor.createdAt,
							},
			};
		});
		const service = new DocumentService(
			runtimeWithDocumentQuery(queryDocumentsMock) as never,
		);

		await expect(listAllProviderDocuments(service)).rejects.toMatchObject({
			code: "DOCUMENT_LIST_CURSOR_LOOP",
		});
		expect(pinnedCalls).toBe(2);
		expect(queryDocumentsMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ cursor }),
		);
	});

	it("accepts a pinned document beyond the former fixed page ceiling", async () => {
		let pinnedCalls = 0;
		const finalPinned = document("Final rule", "ALWAYS VERIFY", true);
		const queryDocumentsMock = vi.fn(async ({ limit }: { limit: number }) => {
			if (limit !== DOCUMENT_LIST_MAX_LIMIT) {
				return {
					status: "ok",
					totalVisible: 0,
					totalAvailable: 0,
					totalMatched: 0,
					documents: [],
					availableDocuments: [],
					availableHasMore: false,
					hasMore: false,
				};
			}
			pinnedCalls += 1;
			const isFinal = pinnedCalls === 102;
			return {
				status: "ok",
				totalVisible: 1,
				totalAvailable: 1,
				totalMatched: 1,
				documents: isFinal ? [finalPinned] : [],
				availableDocuments: [],
				availableHasMore: false,
				hasMore: !isFinal,
				...(isFinal
					? {}
					: {
							nextCursor: {
								createdAt: 1000 + pinnedCalls,
								id: `00000000-0000-0000-0000-${pinnedCalls
									.toString(16)
									.padStart(12, "0")}` as UUID,
							},
						}),
			};
		});
		const service = new DocumentService(
			runtimeWithDocumentQuery(queryDocumentsMock) as never,
		);

		const result = await listAllProviderDocuments(service);

		expect(pinnedCalls).toBe(102);
		expect(result).toEqual([finalPinned]);
	});
});
