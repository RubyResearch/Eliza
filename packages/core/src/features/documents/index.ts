/**
 * Barrel and plugin factory for the documents capability — elizaOS's native RAG
 * (document ingestion + retrieval). `createDocumentsPlugin` assembles the
 * `Plugin` that registers {@link DocumentService}, {@link documentsProvider},
 * and the DOCUMENT action, and disposes the service on unload. The
 * `documentsPlugin` / `documentsPluginCore` (provider-only) /
 * `documentsPluginHeadless` presets toggle the action and provider surfaces.
 * The module also re-exports the feature's public API: BM25 scoring, URL
 * ingestion, recall embedding, and the shared types.
 */
import type { IAgentRuntime, Plugin } from "../../types";
import { documentActions } from "./actions";
import { pinnedDocumentsProvider } from "./pinned-provider.ts";
import { documentsProvider } from "./provider";
import { DocumentService } from "./service";

export interface DocumentsPluginConfig {
	enableActions?: boolean;
	enableProviders?: boolean;
}

export function createDocumentsPlugin(
	config: DocumentsPluginConfig = {},
): Plugin {
	const { enableActions = true, enableProviders = true } = config;

	return {
		name: "documents",
		description:
			"Native Retrieval Augmented Generation capabilities, including document ingestion and retrieval.",
		services: [DocumentService],
		providers: enableProviders
			? [documentsProvider, pinnedDocumentsProvider]
			: [],
		actions: enableActions ? documentActions : [],
		async dispose(runtime: IAgentRuntime) {
			const svc = runtime.getService<DocumentService>(
				DocumentService.serviceType,
			);
			await svc?.stop();
		},
	};
}

export const documentsPlugin = createDocumentsPlugin();
export const documentsPluginCore = createDocumentsPlugin({
	enableActions: false,
	enableProviders: true,
});
export const documentsPluginHeadless = createDocumentsPlugin({
	enableActions: true,
	enableProviders: true,
});

export default documentsPlugin;

export { documentAction, documentActions } from "./actions";
export type { Bm25Document, Bm25Options, Bm25Score } from "./bm25";
export { bm25Scores, normalizeBm25Scores, tokenize } from "./bm25";
export { pinnedDocumentsProvider } from "./pinned-provider.ts";
export { documentsProvider } from "./provider";
export { aliasRecallQuery, embedRecallQuery } from "./recall-embed";
export type {
	DocumentListOptions,
	DocumentListResult,
	DocumentListStatus,
	DocumentRequester,
	SearchMode,
} from "./service";
export { DocumentService, resolveDocumentRequester } from "./service";
export * from "./types";
export type {
	FetchDocumentFromUrlOptions,
	FetchedDocumentUrl,
	FetchedDocumentUrlKind,
} from "./url-ingest";
export {
	__setDocumentUrlFetchImplForTests,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "./url-ingest";
export { normalizeDocumentContentType } from "./utils";
