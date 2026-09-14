/**
 * Regression coverage for the resumed-download data-integrity fix (#29454)
 * against the real exported `applyLocalInferenceManagementMutation` /
 * `startDownload` path with a temp `ELIZA_STATE_DIR`. `node:https` is mocked so
 * the test controls whether the server honors the `Range` header:
 *
 *  - When the server IGNORES Range and returns `200 OK` with the full body (as
 *    many CDNs/mirrors/proxies do), `downloadModel` must discard the pre-staged
 *    `.part` bytes and write a byte-exact full GGUF — never concatenate the full
 *    body onto the partial, which previously produced an oversized corrupt file
 *    that still passed the "GGUF" magic check and got registered as installed.
 *  - When the server HONORS Range and returns `206 Partial Content` with only
 *    the remaining bytes, the fast-resume path must still append and produce the
 *    same byte-exact full GGUF.
 *
 * The mock buffers the response body in a real `PassThrough`, so the download
 * loop consumes it through the true async-iterator path.
 */
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-test controller for the mocked https server. `handler` receives the
// request headers and returns the status, headers, and body the fake server
// should send. Hoisted so the vi.mock factory can close over it.
const httpsController = vi.hoisted(() => ({
	handler: null as
		| null
		| ((requestHeaders: Record<string, string>) => {
				statusCode: number;
				statusMessage?: string;
				headers: Record<string, string>;
				body: Buffer;
		  }),
}));

vi.mock("node:https", () => {
	function get(
		_urlOrOptions: unknown,
		optionsOrCb: unknown,
		maybeCb?: unknown,
	) {
		const callback = (
			typeof optionsOrCb === "function" ? optionsOrCb : maybeCb
		) as (response: PassThrough & Record<string, unknown>) => void;
		const options = (typeof optionsOrCb === "function" ? {} : optionsOrCb) as {
			headers?: Record<string, string>;
		};
		const req = new EventEmitter() as EventEmitter & {
			destroy: (error?: Error) => void;
		};
		req.destroy = (error?: Error) => {
			req.emit("error", error ?? new Error("aborted"));
		};
		setImmediate(() => {
			if (!httpsController.handler) {
				throw new Error("httpsController.handler not configured");
			}
			const config = httpsController.handler(options.headers ?? {});
			const res = new PassThrough() as PassThrough & Record<string, unknown>;
			res.statusCode = config.statusCode;
			res.statusMessage = config.statusMessage ?? "";
			res.headers = config.headers;
			callback(res);
			res.end(config.body);
			req.emit("close");
		});
		return req;
	}
	return { default: { get }, get };
});

const { applyLocalInferenceManagementMutation } = await import(
	"./local-inference-routes.js"
);

const MODEL_ID = "eliza-1-2b";
// FULL is the correct, complete file the server ultimately holds; its first
// four bytes are the real "GGUF" magic so the corrupt path also passes
// isGgufFile().
const FULL_BODY = Buffer.concat([
	Buffer.from("GGUF", "ascii"),
	Buffer.alloc(2048, 0x41),
]);

const originalStateDir = process.env.ELIZA_STATE_DIR;
let tempStateDir: string;

function localInferenceRoot(): string {
	return path.join(tempStateDir, "local-inference");
}

function partialPath(): string {
	return path.join(localInferenceRoot(), "downloads", `${MODEL_ID}.part`);
}

function finalPath(): string {
	return path.join(localInferenceRoot(), "models", `${MODEL_ID}.gguf`);
}

function seedPartial(bytes: Buffer): void {
	mkdirSync(path.dirname(partialPath()), { recursive: true });
	writeFileSync(partialPath(), bytes);
}

async function waitForFinalFile(timeoutMs = 5000): Promise<Buffer> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(finalPath()) && !existsSync(partialPath())) {
			return readFileSync(finalPath());
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`final model file did not appear within ${timeoutMs}ms (final exists=${existsSync(
			finalPath(),
		)}, part exists=${existsSync(partialPath())})`,
	);
}

function readRegistry(): { models: Array<{ id: string; sizeBytes: number }> } {
	return JSON.parse(
		readFileSync(path.join(localInferenceRoot(), "registry.json"), "utf8"),
	);
}

describe("local-inference resumed download integrity (#29454)", () => {
	beforeEach(() => {
		tempStateDir = mkdtempSync(path.join(tmpdir(), "eliza-li-resume-"));
		process.env.ELIZA_STATE_DIR = tempStateDir;
		httpsController.handler = null;
	});

	afterEach(() => {
		rmSync(tempStateDir, { recursive: true, force: true });
		if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = originalStateDir;
		vi.clearAllMocks();
	});

	it("restarts cleanly when the server ignores Range and returns 200 with the full body", async () => {
		// Distinct partial bytes (0x99 filler, NOT a prefix of FULL) so a clean
		// restart is provable: after the fix the final file must equal FULL exactly
		// with none of these bytes retained.
		const partial = Buffer.concat([
			Buffer.from("GGUF", "ascii"),
			Buffer.alloc(512, 0x99),
		]);
		seedPartial(partial);

		// Server ignores the Range request entirely: 200 OK, whole body.
		httpsController.handler = () => ({
			statusCode: 200,
			statusMessage: "OK",
			headers: { "content-length": String(FULL_BODY.length) },
			body: FULL_BODY,
		});

		await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		});
		const finalBytes = await waitForFinalFile();

		// The corruption bug produced partial.length + FULL_BODY.length bytes; the
		// fix must produce exactly FULL_BODY.
		expect(finalBytes.length).toBe(FULL_BODY.length);
		expect(finalBytes.length).not.toBe(partial.length + FULL_BODY.length);
		expect(finalBytes.equals(FULL_BODY)).toBe(true);
		expect(finalBytes.subarray(0, 4).toString("ascii")).toBe("GGUF");

		// The model is registered with the correct (full) byte size, not the
		// oversized corrupt size.
		const registry = readRegistry();
		const entry = registry.models.find((model) => model.id === MODEL_ID);
		expect(entry?.sizeBytes).toBe(FULL_BODY.length);
	});

	it("fast-resumes when the server honors Range and returns 206 with the remainder", async () => {
		// A real interrupted download leaves the true prefix of FULL on disk.
		const resumeFrom = 516;
		const partial = FULL_BODY.subarray(0, resumeFrom);
		seedPartial(Buffer.from(partial));

		let observedRange: string | undefined;
		httpsController.handler = (requestHeaders) => {
			observedRange = requestHeaders.range;
			const remainder = FULL_BODY.subarray(resumeFrom);
			return {
				statusCode: 206,
				statusMessage: "Partial Content",
				headers: {
					"content-length": String(remainder.length),
					"content-range": `bytes ${resumeFrom}-${
						FULL_BODY.length - 1
					}/${FULL_BODY.length}`,
				},
				body: Buffer.from(remainder),
			};
		};

		await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		});
		const finalBytes = await waitForFinalFile();

		// The client actually requested a resume from the staged offset...
		expect(observedRange).toBe(`bytes=${resumeFrom}-`);
		// ...and the appended remainder reconstructs the byte-exact full file.
		expect(finalBytes.length).toBe(FULL_BODY.length);
		expect(finalBytes.equals(FULL_BODY)).toBe(true);

		const registry = readRegistry();
		const entry = registry.models.find((model) => model.id === MODEL_ID);
		expect(entry?.sizeBytes).toBe(FULL_BODY.length);
	});
});
