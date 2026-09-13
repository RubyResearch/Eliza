/**
 * Pure helpers for the documents capability: extracting text from file buffers
 * (DOCX via mammoth, PDF via unpdf, plain text plus a UTF-8 fallback),
 * classifying content types as binary vs text, deriving document titles and safe
 * ASCII note filenames, normalizing source labels and S3 URLs, detecting base64
 * payloads, and computing a stable content-based UUID used as the document
 * dedupe key. Consumed by `service.ts` and the document processors.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { toWellFormedUnicode } from "../../utils/well-formed";

/**
 * Return the case-insensitive MIME essence used for routing document content.
 * Parameters belong to the media type but do not change its routing identity.
 */
export function normalizeDocumentContentType(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isBinaryContentType(
	contentType: string,
	filename: string,
): boolean {
	const normalizedContentType = normalizeDocumentContentType(contentType);
	const textContentTypes = [
		"text/",
		"application/json",
		"application/xml",
		"application/javascript",
		"application/typescript",
		"application/x-yaml",
		"application/x-sh",
	];

	const isTextMimeType = textContentTypes.some((type) =>
		normalizedContentType.includes(type),
	);
	if (isTextMimeType) {
		return false;
	}

	const binaryContentTypes = [
		"application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument",
		"application/vnd.ms-excel",
		"application/vnd.ms-powerpoint",
		"application/zip",
		"application/x-zip-compressed",
		"application/octet-stream",
		"image/",
		"audio/",
		"video/",
	];

	const isBinaryMimeType = binaryContentTypes.some((type) =>
		normalizedContentType.includes(type),
	);

	if (isBinaryMimeType) {
		return true;
	}

	const fileExt = filename.split(".").pop()?.toLowerCase() || "";

	const textExtensions = [
		"txt",
		"md",
		"markdown",
		"json",
		"xml",
		"html",
		"htm",
		"css",
		"js",
		"ts",
		"jsx",
		"tsx",
		"yaml",
		"yml",
		"toml",
		"ini",
		"cfg",
		"conf",
		"sh",
		"bash",
		"zsh",
		"fish",
		"py",
		"rb",
		"go",
		"rs",
		"java",
		"c",
		"cpp",
		"h",
		"hpp",
		"cs",
		"php",
		"sql",
		"r",
		"swift",
		"kt",
		"scala",
		"clj",
		"ex",
		"exs",
		"vim",
		"env",
		"gitignore",
		"dockerignore",
		"editorconfig",
		"log",
		"csv",
		"tsv",
		"properties",
		"gradle",
		"sbt",
		"makefile",
		"dockerfile",
		"vagrantfile",
		"gemfile",
		"rakefile",
		"podfile",
		"csproj",
		"vbproj",
		"fsproj",
		"sln",
		"pom",
	];

	if (textExtensions.includes(fileExt)) {
		return false;
	}

	const binaryExtensions = [
		"pdf",
		"docx",
		"doc",
		"xls",
		"xlsx",
		"ppt",
		"pptx",
		"zip",
		"rar",
		"7z",
		"tar",
		"gz",
		"bz2",
		"xz",
		"jpg",
		"jpeg",
		"png",
		"gif",
		"bmp",
		"svg",
		"ico",
		"webp",
		"mp3",
		"mp4",
		"avi",
		"mov",
		"wmv",
		"flv",
		"wav",
		"flac",
		"ogg",
		"exe",
		"dll",
		"so",
		"dylib",
		"bin",
		"dat",
		"db",
		"sqlite",
	];

	return binaryExtensions.includes(fileExt);
}

// Pure naming helpers live in ./naming so light consumers can import them
// without the parser graph; re-exported here for compatibility.
export {
	createDocumentNoteFilename,
	deriveDocumentTitle,
	stripDocumentFilenameExtension,
} from "./naming.ts";
// The heavyweight parsers live in ./parsers so the edge build can alias that
// one module to a throwing stub without disturbing the pure helpers above
// (#21327); re-exported here for compatibility.
export {
	convertPdfToTextFromBuffer,
	extractTextFromFileBuffer,
} from "./parsers.ts";

export function isTextBackedDocumentContent(
	contentType: string,
	filename: string,
): boolean {
	return !isBinaryContentType(contentType, filename);
}

export function normalizeDocumentSourceValue(
	source: unknown,
):
	| "upload"
	| "learned"
	| "character"
	| "url"
	| "youtube"
	| "bundled"
	| "unknown" {
	if (typeof source !== "string") {
		return "unknown";
	}

	switch (source) {
		case "upload":
		case "rag-service-main-upload":
			return "upload";
		case "learned":
			return "learned";
		case "character":
			return "character";
		case "url":
			return "url";
		case "youtube":
			return "youtube";
		case "eliza-default-documents":
			return "bundled";
		default:
			return "unknown";
	}
}

export function normalizeS3Url(url: string): string {
	try {
		const urlObj = new URL(url);
		return `${urlObj.origin}${urlObj.pathname}`;
	} catch {
		// error-policy:J3 URL normalization accepts untrusted strings; malformed
		// input remains explicitly unchanged rather than partially rewritten.
		return url;
	}
}

export function looksLikeBase64(content?: string | null): boolean {
	if (!content || content.length === 0) return false;

	const cleanContent = content.replace(/\s/g, "");

	if (cleanContent.length < 16) return false;

	if (cleanContent.length % 4 !== 0) return false;

	const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
	if (!base64Regex.test(cleanContent)) return false;

	const hasNumbers = /\d/.test(cleanContent);
	const hasUpperCase = /[A-Z]/.test(cleanContent);
	const hasLowerCase = /[a-z]/.test(cleanContent);

	return (hasNumbers || hasUpperCase) && hasLowerCase;
}

export function generateContentBasedId(
	content: string,
	agentId: string,
	options?: {
		includeFilename?: string;
		contentType?: string;
		namespace?: string;
		/** Preserve literal source text, including whitespace and Base64-looking words. */
		literalText?: boolean;
	},
): string {
	const { includeFilename, contentType, namespace } = options || {};

	let contentForHashing: string;

	if (!options?.literalText && looksLikeBase64(content)) {
		const decoded = Buffer.from(content, "base64").toString("utf8");
		if (decoded.includes("\ufffd") || contentType?.includes("pdf")) {
			contentForHashing = toWellFormedUnicode(content);
		} else {
			contentForHashing = toWellFormedUnicode(decoded);
		}
	} else {
		contentForHashing = toWellFormedUnicode(content);
	}

	if (!options?.literalText) {
		contentForHashing = contentForHashing
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			.trim();
	}

	const componentsToHash =
		namespace === undefined
			? [agentId, contentForHashing, includeFilename || ""]
					.filter(Boolean)
					.join("::")
			: JSON.stringify([
					"document-scope-v1",
					namespace,
					agentId,
					contentForHashing,
					includeFilename ?? "",
				]);

	const hash = createHash("sha256").update(componentsToHash).digest("hex");

	const DOCUMENT_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

	return uuidv5(hash, DOCUMENT_NAMESPACE);
}

export function extractFirstLines(
	content: string,
	maxLines: number = 10,
): string {
	const lines = content.split(/\r?\n/);
	return lines.slice(0, maxLines).join("\n");
}
