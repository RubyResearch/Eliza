/**
 * Type and schema definitions for the documents capability: the stored-document
 * shape, document/fragment memory metadata, visibility scopes, added-by role and
 * source enums, load results, and the `ModelConfigSchema` zod schema (embedding /
 * text-provider selection, rate-limit knobs, and startup-load config). Also
 * registers the `DOCUMENTS: "documents"` entry into the runtime
 * `ServiceTypeRegistry`. Shared across `service.ts`, `provider.ts`, and the
 * document processors.
 */
import z from "zod";
import type {
	Content,
	DocumentMetadata,
	FragmentMetadata,
	MemoryType,
	UUID,
} from "../../types";
import type { ServiceTypeRegistry } from "../../types/service.ts";

const safeIntegerSetting = (
	minimum: 0 | 1,
	defaultValue?: number,
	maximum = Number.MAX_SAFE_INTEGER,
) => {
	const schema = z
		.union([z.string(), z.number()])
		.transform((value, context) => {
			let parsed: number;

			if (typeof value === "string") {
				const normalized = value.trim();
				if (!/^\d+$/.test(normalized)) {
					context.addIssue({
						code: "custom",
						message: "must be a complete decimal integer",
					});
					return z.NEVER;
				}
				parsed = Number(normalized);
			} else {
				parsed = value;
			}

			if (
				!Number.isSafeInteger(parsed) ||
				Object.is(parsed, -0) ||
				parsed < minimum ||
				parsed > maximum
			) {
				context.addIssue({
					code: "custom",
					message: `must be a ${
						minimum === 0 ? "nonnegative" : "positive"
					} safe integer no greater than ${maximum}`,
				});
				return z.NEVER;
			}

			return parsed;
		});

	return defaultValue === undefined ? schema : schema.default(defaultValue);
};

const positiveSafeIntegerSetting = (defaultValue?: number) =>
	safeIntegerSetting(1, defaultValue);
const timerDelaySetting = (defaultValue?: number) =>
	safeIntegerSetting(0, defaultValue, 2_147_483_647);

/**
 * Local metadata type for stored document items.
 * Uses a permissive record type to avoid conflicts between TypeScript and protobuf MemoryMetadata types.
 */
export type StoredDocumentMetadata = Record<string, unknown>;

/**
 * Stored document item with content, metadata, and optional similarity score.
 * Used for document retrieval results and internal document processing.
 */
export interface StoredDocument {
	id: UUID;
	entityId?: UUID;
	content: Content;
	metadata?: StoredDocumentMetadata;
	worldId?: UUID;
	similarity?: number;
}

export const ModelConfigSchema = z.object({
	EMBEDDING_PROVIDER: z.enum(["local", "openai", "google"]).optional(),
	TEXT_PROVIDER: z
		.enum(["openai", "anthropic", "openrouter", "google"])
		.optional(),

	OPENAI_API_KEY: z.string().optional(),
	ANTHROPIC_API_KEY: z.string().optional(),
	OPENROUTER_API_KEY: z.string().optional(),
	GOOGLE_API_KEY: z.string().optional(),

	OPENAI_BASE_URL: z.string().optional(),
	ANTHROPIC_BASE_URL: z.string().optional(),
	OPENROUTER_BASE_URL: z.string().optional(),
	GOOGLE_BASE_URL: z.string().optional(),

	TEXT_EMBEDDING_MODEL: z.string(),
	TEXT_MODEL: z.string().optional(),

	MAX_INPUT_TOKENS: positiveSafeIntegerSetting(),

	EMBEDDING_DIMENSION: positiveSafeIntegerSetting(1536),

	LOAD_DOCS_ON_STARTUP: z.boolean().default(false),

	CTX_DOCUMENTS_ENABLED: z.boolean().default(false),

	RATE_LIMIT_ENABLED: z.boolean().default(true),

	MAX_CONCURRENT_REQUESTS: positiveSafeIntegerSetting(150),

	REQUESTS_PER_MINUTE: positiveSafeIntegerSetting(300),

	TOKENS_PER_MINUTE: positiveSafeIntegerSetting(750000),

	BATCH_DELAY_MS: timerDelaySetting(100),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export interface ProviderRateLimits {
	maxConcurrentRequests: number;
	requestsPerMinute: number;
	tokensPerMinute?: number;
	provider: string;
	rateLimitEnabled: boolean;
	batchDelayMs: number;
}

export interface TextGenerationOptions {
	provider?: "anthropic" | "openai" | "openrouter" | "google";
	modelName?: string;
	cacheDocument?: string;
	cacheOptions?: {
		type: "ephemeral";
	};
	autoCacheContextualRetrieval?: boolean;
}

/** Producer-owned chunk whose metadata is projected onto its fragment row. */
export interface PreChunkedFragmentInput {
	text: string;
	metadata?: Record<string, unknown>;
}

export interface AddDocumentOptions {
	agentId?: UUID;
	worldId: UUID;
	roomId: UUID;
	entityId: UUID;
	clientDocumentId: UUID;
	contentType: string;
	originalFilename: string;
	content: string;
	/** Text defaults to literal UTF-8; binary formats default to Base64. Encoded text must declare Base64. */
	contentEncoding?: "utf8" | "base64";
	/** Chat uploads are visible only through the canonical room membership policy. */
	audience?: "chat";
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: UUID;
	/** Read-only entity grants that remain valid independently of room membership. */
	directGrantEntityIds?: UUID[];
	addedBy?: UUID;
	addedByRole?: DocumentAddedByRole;
	addedFrom?: DocumentAddedFrom;
	metadata?: Record<string, unknown>;
	/** Always inject this document whole through the DOCUMENTS provider. */
	pinned?: boolean;
	/** Store these verbatim fragments instead of token-splitting `content`. */
	fragments?: PreChunkedFragmentInput[];
}
declare module "../../types/service.ts" {
	interface ServiceTypeRegistry {
		DOCUMENTS: "documents";
	}
}

export const DocumentServiceType = {
	DOCUMENTS: "documents" as const,
} satisfies Partial<ServiceTypeRegistry>;

export type DocumentVisibilityScope =
	| "global"
	| "owner-private"
	| "user-private"
	| "agent-private";

export type DocumentAddedByRole =
	| "OWNER"
	| "ADMIN"
	| "USER"
	| "GUEST"
	| "AGENT"
	| "RUNTIME";

export type DocumentAddedFrom =
	| "import"
	| "chat"
	| "upload"
	| "url"
	| "file"
	| "agent-autonomous"
	| "runtime-internal"
	| "lifeops"
	| "default-seed"
	| "character";

export interface DocumentMetadataExtended extends Record<string, unknown> {
	type: string; // e.g., 'document', 'website_content'
	source: string; // e.g., 'upload', 'web_scrape', path to file
	title?: string;
	filename?: string;
	fileExt?: string;
	fileType?: string; // MIME type
	fileSize?: number;
}
export interface DocumentMemoryMetadata
	extends DocumentMetadata,
		Record<string, unknown> {
	type: typeof MemoryType.DOCUMENT;
	documentId: UUID;
	source: string;
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	addedByRole?: DocumentAddedByRole;
	addedFrom?: DocumentAddedFrom;
	addedAt?: number;
	ingestionAttemptId?: UUID;
	ingestionState?: "pending" | "ready" | "failed";
	/**
	 * Token of the update attempt that committed this document revision.
	 * Fragment readers require fragments to carry the same token whenever the
	 * parent declares one, fencing off same-revision generations staged by
	 * concurrent update attempts that lost the compare-and-swap.
	 */
	revisionAttemptId?: UUID;
	title?: string;
	filename?: string;
	originalFilename?: string;
	fileExt?: string;
	fileType?: string;
	contentType?: string;
	fileSize?: number;
	textBacked?: boolean;
	timestamp?: number;
	editedAt?: number;
	/** Always inject the complete document through the DOCUMENTS provider. */
	pinned?: boolean;
	/** Served original-bytes file (content-addressed) linked to this document. */
	mediaUrl?: string;
	/** Served original-bytes file (content-addressed) linked to this document. */
	mediaHash?: string;
	/** Served original-bytes file (content-addressed) linked to this document. */
	mediaFileName?: string;
}
export interface DocumentFragmentMemoryMetadata
	extends FragmentMetadata,
		Record<string, unknown> {
	type: typeof MemoryType.FRAGMENT;
	documentId: UUID;
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	addedByRole?: DocumentAddedByRole;
	addedFrom?: DocumentAddedFrom;
	addedAt?: number;
	/** Update attempt that staged this fragment; must match the parent's committed token to be readable. */
	revisionAttemptId?: UUID;
	position: number;
	source?: string;
	documentTitle?: string;
	timestamp?: number;
	transcriptId?: string;
	segmentIds?: string[];
	startMs?: number;
	endMs?: number;
	speakerLabels?: string[];
}
export interface DocumentsConfig {
	CTX_DOCUMENTS_ENABLED: boolean;
	LOAD_DOCS_ON_STARTUP: boolean;
	MAX_INPUT_TOKENS?: string | number;
	EMBEDDING_PROVIDER?: string;
	TEXT_PROVIDER?: string;
	TEXT_EMBEDDING_MODEL?: string;
	// Rate limiting configuration
	RATE_LIMIT_ENABLED?: boolean;
	MAX_CONCURRENT_REQUESTS?: number;
	REQUESTS_PER_MINUTE?: number;
	TOKENS_PER_MINUTE?: number;
	BATCH_DELAY_MS?: number;
}
export interface LoadResult {
	successful: number;
	failed: number;
	errors?: Array<{ filename: string; error: string }>;
}

export interface ExtendedMemoryMetadata extends Record<string, unknown> {
	type?: string;
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: string;
	userId?: string;
	agentId?: string;
	title?: string;
	filename?: string;
	path?: string;
	description?: string;
	fileExt?: string;
	timestamp?: number;
	contentType?: string;
	documentId?: string;
	source?: string;
	fileType?: string;
	fileSize?: number;
	position?: number; // For fragments
	originalFilename?: string;
	url?: string; // For web content
}
