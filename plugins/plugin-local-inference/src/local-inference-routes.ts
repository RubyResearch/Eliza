/**
 * HTTP handler for the local-inference catalog, download orchestration, active-
 * model status, hardware detection, and chat-command routes — the root
 * `@elizaos/plugin-local-inference` subpath (app-core mounts the compat variant
 * in `routes/local-inference-compat-routes.ts`). The heavy service graph
 * (engine / voice / catalog / downloader) is imported lazily on first route use
 * to keep it off the boot critical path (#9565).
 */
import crypto from "node:crypto";
import * as dns from "node:dns";
import fs from "node:fs";
import fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import os from "node:os";
import path from "node:path";
import {
	type ContentValue,
	logger,
	readJsonBody,
	resolveStateDir,
	sendJson,
	sendJsonError,
} from "@elizaos/core";
import {
	AGENT_MODEL_SLOTS,
	type AgentModelSlot,
	buildHuggingFaceResolveUrl,
	isMobilePlatform,
	isRoutingPolicy,
	ROUTING_POLICIES,
	type RoutingPreferences,
	resolveElizaCloudTopology,
	resolveHubAuthHeaders,
	MODEL_CATALOG as SHARED_MODEL_CATALOG,
	type CatalogModel as SharedCatalogModel,
} from "@elizaos/shared";
import {
	readRoutingPreferences,
	setPolicy,
	setPreferredProvider,
	setTextRouting,
} from "@elizaos/shared/local-inference/routing-preferences";
import {
	LOCAL_INFERENCE_MODEL_TYPES,
	LOCAL_INFERENCE_PROVIDER_ID,
} from "./provider.js";
import { classifyDeviceTier } from "./services/device-tier.js";
import {
	resolveLocalInferenceStoredPath,
	toLocalInferenceStoredPath,
} from "./services/paths.js";

// Lazy service handle. Importing `./services/service.js` eagerly evaluates the
// full engine/voice/catalog/downloader graph (~800ms) — far too heavy for the
// boot-blocking plugin import, which re-exports this module but only needs the
// plugin object (provider.ts), never the service. Load it on first route use
// instead, off the boot critical path (issue #9565). The singleton constructor
// is lightweight (no model load), so this only defers the import/eval cost.
let _serviceModule: typeof import("./services/service.js") | null = null;
async function localInferenceServiceLazy() {
	if (!_serviceModule) {
		_serviceModule = await import("./services/service.js");
	}
	return _serviceModule.localInferenceService;
}
// Synchronous accessor for the one sync call site: returns null until the
// service has been loaded by a prior async route. Behaviour-equivalent for
// "active model id" — before any model loads, getActive() is idle either way.
function localInferenceServiceIfLoaded() {
	return _serviceModule?.localInferenceService ?? null;
}
async function prewarmLocalVoiceStackLazy(modelId: string): Promise<void> {
	const { prewarmLocalVoiceStackForModel } = await import(
		"./services/voice-prewarm.js"
	);
	await prewarmLocalVoiceStackForModel(modelId);
}

type ModelRole = "chat" | "embedding";
type DownloadState =
	| "queued"
	| "downloading"
	| "completed"
	| "failed"
	| "cancelled";

type MobileDeviceBridgeApi = {
	getMobileDeviceBridgeStatus: () => MobileDeviceBridgeStatus;
	getMobileDeviceBridgeServingStatus: () => Promise<MobileDeviceBridgeServingStatus>;
	loadMobileDeviceBridgeModel: (
		modelPath: string,
		modelId: string,
	) => Promise<void>;
	unloadMobileDeviceBridgeModel: () => Promise<void>;
};

type MobileDeviceBridgeServingStatus = {
	registeredTrigger: "bionic-host" | "device-bridge" | null;
	/** True only when handlers are bound via bionic-host AND the host socket serves. */
	bionicHostServing: boolean;
};

type MobileDeviceBridgeStatus = {
	enabled?: boolean;
	connected?: boolean;
	reason?: string;
	devices: Array<{ loadedPath?: string | null }>;
};

type AospLocalInferenceApi = {
	buildAospLoadModelArgs: (
		role: "chat" | "embedding",
		modelPath: string,
	) => unknown;
	activateAospLocalInferenceModel: (args: {
		modelId: string;
		modelPath: string;
		loadArgs: unknown;
	}) => Promise<typeof activeModelState>;
	clearAospLocalInferenceModel: () => Promise<typeof activeModelState>;
};

let mobileDeviceBridgeApiPromise: Promise<MobileDeviceBridgeApi> | null = null;
let aospLocalInferenceApiPromise: Promise<AospLocalInferenceApi> | null = null;

function getMobileDeviceBridgeApi(): Promise<MobileDeviceBridgeApi> {
	mobileDeviceBridgeApiPromise ??= import(
		"@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
	) as Promise<MobileDeviceBridgeApi>;
	return mobileDeviceBridgeApiPromise;
}

function getAospLocalInferenceApi(): Promise<AospLocalInferenceApi> {
	aospLocalInferenceApiPromise ??= import(
		"@elizaos/plugin-native-inference"
	) as Promise<AospLocalInferenceApi>;
	return aospLocalInferenceApiPromise;
}

function shouldUseAospLocalInference(): boolean {
	const value = process.env.ELIZA_LOCAL_LLAMA?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function getMobileDeviceBridgeStatusUnavailable(): MobileDeviceBridgeStatus {
	return {
		enabled: false,
		connected: false,
		reason: "mobile device bridge is not loaded",
		devices: [],
	};
}

export type LocalInferenceCommandIntent =
	| "retry"
	| "resume"
	| "redownload"
	| "download"
	| "cancel"
	| "switch_smaller"
	| "status"
	| "use_cloud"
	| "use_local";

interface CatalogModel extends SharedCatalogModel {
	role: ModelRole;
}

const ASSIGNMENT_SLOTS = new Set<keyof Assignments>([
	"TEXT_SMALL",
	"TEXT_LARGE",
	"TEXT_EMBEDDING",
	"TEXT_TO_SPEECH",
	"TRANSCRIPTION",
]);

interface InstalledModel {
	id: string;
	displayName: string;
	path: string;
	sizeBytes: number;
	hfRepo?: string;
	installedAt: string;
	lastUsedAt: string | null;
	source: "eliza-download";
	sha256?: string;
	lastVerifiedAt?: string;
}

interface DownloadJob {
	jobId: string;
	modelId: string;
	state: DownloadState;
	received: number;
	total: number;
	bytesPerSec: number;
	etaMs: number | null;
	startedAt: string;
	updatedAt: string;
	error?: string;
}

export interface LocalInferenceChatMetadata {
	[key: string]: ContentValue;
	intent?: LocalInferenceCommandIntent;
	status:
		| "missing"
		| "downloading"
		| "loading"
		| "failed"
		| "no_space"
		| "idle"
		| "ready"
		| "cancelled"
		| "routing";
	modelId?: string | null;
	activeModelId?: string | null;
	provider?: string;
	error?: string;
	progress?: {
		percent?: number;
		receivedBytes: number;
		totalBytes: number;
		bytesPerSec?: number;
		etaMs?: number | null;
	};
}

export interface LocalInferenceChatResult {
	text: string;
	localInference: LocalInferenceChatMetadata;
}

type Assignments = Partial<
	Record<(typeof LOCAL_INFERENCE_MODEL_TYPES)[number], string>
>;

let activeModelState: {
	modelId: string | null;
	loadedAt: string | null;
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
} = { modelId: null, loadedAt: null, status: "idle" };

export type LocalInferenceManagementOp =
	| "start_download"
	| "cancel_download"
	| "set_active"
	| "clear_active"
	| "uninstall_model"
	| "verify_model"
	| "trigger_voice_model_update"
	| "pin_voice_model"
	| "set_voice_model_preferences"
	| "set_policy"
	| "set_preferred_provider"
	| "set_assignment";

export interface LocalInferenceManagementInput {
	op: LocalInferenceManagementOp;
	modelId?: string;
	voiceModelId?: string;
	slot?: string;
	provider?: string;
	policy?: string;
	pinned?: boolean;
	voicePreferences?: {
		autoUpdateOnWifi?: boolean;
		autoUpdateOnCellular?: boolean;
		autoUpdateOnMetered?: boolean;
		quietHours?: Array<{ start: string; end: string }>;
	};
}

export type LocalInferenceManagementResult =
	| { op: "start_download"; modelId: string; job: DownloadJob }
	| { op: "cancel_download"; modelId: string | null; cancelled: true }
	| { op: "set_active"; modelId: string; active: typeof activeModelState }
	| { op: "clear_active"; active: typeof activeModelState }
	| { op: "uninstall_model"; modelId: string; removed: boolean }
	| { op: "trigger_voice_model_update"; id: string; result: unknown }
	| { op: "pin_voice_model"; id: string; pinned: boolean }
	| { op: "set_voice_model_preferences"; preferences: unknown }
	| {
			op: "verify_model";
			modelId: string;
			state: "ok" | "unknown";
			currentSha256: string;
			expectedSha256: string | null;
			currentBytes: number;
	  }
	| {
			op: "set_policy";
			slot: string;
			policy: string | null;
			preferences: RoutingPreferences;
	  }
	| {
			op: "set_preferred_provider";
			slot: string;
			provider: string | null;
			preferences: RoutingPreferences;
	  }
	| {
			op: "set_assignment";
			slot: keyof Assignments;
			modelId: string | null;
			assignments: Assignments;
	  };

export function getLocalInferenceActiveModelId(): string | undefined {
	const serviceActive = localInferenceServiceIfLoaded()?.getActive();
	if (serviceActive?.status === "ready" && serviceActive.modelId?.trim()) {
		return serviceActive.modelId.trim();
	}
	return activeModelState.status === "ready" && activeModelState.modelId?.trim()
		? activeModelState.modelId.trim()
		: undefined;
}

function catalogRole(model: SharedCatalogModel): ModelRole {
	if ((model.category as string) === "embedding") return "embedding";
	return "chat";
}

const CATALOG: CatalogModel[] = SHARED_MODEL_CATALOG.map((model) => ({
	...model,
	role: catalogRole(model),
}));

function isCuratedCatalogModelId(modelId: string): boolean {
	return CATALOG.some(
		(model) =>
			model.id === modelId &&
			!model.hiddenFromCatalog &&
			model.runtimeRole !== "mtp-drafter",
	);
}

function sanitizeAssignments(assignments: Assignments): Assignments {
	const next: Assignments = {};
	for (const [slot, modelId] of Object.entries(assignments) as Array<
		[keyof Assignments, string | undefined]
	>) {
		if (!modelId || !ASSIGNMENT_SLOTS.has(slot)) continue;
		if (!isCuratedCatalogModelId(modelId)) continue;
		next[slot] = modelId;
	}
	return next;
}

const activeDownloads = new Map<
	string,
	{ job: DownloadJob; abortController: AbortController }
>();
const MOBILE_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"];
const mobileDnsResolver = new dns.Resolver();
mobileDnsResolver.setServers(MOBILE_DNS_SERVERS);

function stateDir(): string {
	return resolveStateDir();
}

function localInferenceRoot(): string {
	return path.join(stateDir(), "local-inference");
}

function modelsDir(): string {
	return path.join(localInferenceRoot(), "models");
}

function downloadsDir(): string {
	return path.join(localInferenceRoot(), "downloads");
}

function registryPath(): string {
	return path.join(localInferenceRoot(), "registry.json");
}

function assignmentsPath(): string {
	return path.join(localInferenceRoot(), "assignments.json");
}

function aospActivePath(): string {
	return path.join(localInferenceRoot(), "aosp-active.json");
}

function finalModelPath(model: CatalogModel): string {
	return path.join(
		modelsDir(),
		`${model.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.gguf`,
	);
}

function stagingPath(model: CatalogModel): string {
	return path.join(
		downloadsDir(),
		`${model.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.part`,
	);
}

function huggingFaceResolveUrl(model: CatalogModel): string {
	return buildHuggingFaceResolveUrl(model);
}

function shouldUseMobileDns(): boolean {
	return isMobilePlatform();
}

const mobileLookup: http.RequestOptions["lookup"] = (
	hostname,
	options,
	callback,
) => {
	mobileDnsResolver.resolve4(hostname, (error, addresses) => {
		if (error) {
			callback(error, undefined as never, undefined as never);
			return;
		}
		if (options.all) {
			callback(
				null,
				addresses.map((address) => ({ address, family: 4 })),
				undefined as never,
			);
			return;
		}
		callback(null, addresses[0], 4);
	});
};

/**
 * Recompute request headers when following a redirect. The HuggingFace bearer
 * token must never leak past a cross-host redirect: HF `/resolve/` URLs 302 to
 * cdn-lfs*.hf.co / *.amazonaws.com / *.cloudfront.net, none of which are HF
 * hosts. Strip Authorization, then re-add it only if the redirect target is
 * itself a HuggingFace host — mirroring the cross-origin auth stripping WHATWG
 * fetch performs for the sibling `Downloader` path.
 */
export function reauthorizeRedirectHeaders(
	headers: Record<string, string>,
	nextUrl: string,
): Record<string, string> {
	const next: Record<string, string> = { ...headers };
	delete next.authorization;
	delete next.Authorization;
	Object.assign(next, resolveHubAuthHeaders(nextUrl));
	return next;
}

async function openDownloadResponse(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	redirectCount = 0,
): Promise<http.IncomingMessage> {
	if (redirectCount > 5) {
		throw new Error("Too many redirects while downloading model");
	}

	const parsed = new URL(url);
	const transport = parsed.protocol === "http:" ? http : https;

	return new Promise((resolve, reject) => {
		const req = transport.get(
			parsed,
			{
				headers,
				lookup: shouldUseMobileDns() ? mobileLookup : undefined,
			},
			(response) => {
				const statusCode = response.statusCode ?? 0;
				const location = response.headers.location;
				if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
					response.resume();
					const nextUrl = new URL(location, parsed).toString();
					resolve(
						openDownloadResponse(
							nextUrl,
							reauthorizeRedirectHeaders(headers, nextUrl),
							signal,
							redirectCount + 1,
						),
					);
					return;
				}
				resolve(response);
			},
		);

		const abort = () => {
			req.destroy(new Error("Download cancelled"));
		};
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		req.on("error", reject);
		req.on("close", () => signal.removeEventListener("abort", abort));
	});
}

async function ensureLocalInferenceDirs(): Promise<void> {
	await fsp.mkdir(modelsDir(), { recursive: true });
	await fsp.mkdir(downloadsDir(), { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function writeJsonFile(
	filePath: string,
	payload: unknown,
): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	// Unique staging name per write: concurrent writers to the same target must
	// not share one fixed `${filePath}.tmp`, or one writer's rename races the
	// other's and throws ENOENT once the first rename consumes the shared temp
	// file — an unhandled error out of a mutation that reported success
	// (issue #25123). Mirrors plugin-matrix's saveCryptoStore atomic-write.
	const tmp = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	try {
		await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
		await fsp.rename(tmp, filePath);
	} catch (error) {
		// error-policy:J6 temp cleanup is best-effort; unique names keep an orphan
		// harmless to concurrent writers, and the primary write error is preserved.
		await fsp.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

// Serializes read-modify-write transactions per persisted config file. The
// management mutations (set_assignment, upsertInstalledModel,
// removeInstalledModel) each read the current JSON, mutate it, and write it
// back; two concurrent mutations against one file would otherwise both read the
// pre-write state and the second write would clobber the first, silently
// dropping an update while both callers return success (issue #25123). Keyed by
// absolute file path so unrelated files never serialize against each other. The
// stored promise is settle-tracking, so one rejected transaction never breaks
// the chain for the next waiter.
const configFileMutex = new Map<string, Promise<unknown>>();
async function withConfigFileLock<T>(
	filePath: string,
	task: () => Promise<T>,
): Promise<T> {
	const prior = configFileMutex.get(filePath) ?? Promise.resolve();
	const next = prior.then(task, task);
	configFileMutex.set(
		filePath,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

async function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath, {
			highWaterMark: 1024 * 1024,
		});
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

async function isGgufFile(filePath: string): Promise<boolean> {
	try {
		const file = await fsp.open(filePath, "r");
		try {
			const buffer = Buffer.alloc(4);
			await file.read(buffer, 0, 4, 0);
			return buffer.toString("ascii") === "GGUF";
		} finally {
			await file.close();
		}
	} catch {
		return false;
	}
}

async function readRegistry(): Promise<InstalledModel[]> {
	const registry = await readJsonFile<{
		version?: number;
		models?: InstalledModel[];
	}>(registryPath(), { version: 1, models: [] });
	const models = Array.isArray(registry.models) ? registry.models : [];
	const installed: InstalledModel[] = [];
	for (const model of models) {
		if (!model.id || !model.path) continue;
		const modelPath = resolveLocalInferenceStoredPath(model.path);
		if (!modelPath) continue;
		try {
			const stat = await fsp.stat(modelPath);
			if (stat.isFile()) {
				installed.push({ ...model, path: modelPath, sizeBytes: stat.size });
			}
		} catch {
			// Ignore stale registry entries.
		}
	}
	return installed;
}

async function writeRegistry(models: InstalledModel[]): Promise<void> {
	await writeJsonFile(registryPath(), {
		version: 1,
		models: models.map((model) => {
			const storedPath = toLocalInferenceStoredPath(model.path);
			if (!storedPath) {
				throw new Error(
					"[local-inference] installed model path must live under the local-inference root",
				);
			}
			return { ...model, path: storedPath };
		}),
	});
}

async function upsertInstalledModel(model: InstalledModel): Promise<void> {
	await withConfigFileLock(registryPath(), async () => {
		const current = await readRegistry();
		await writeRegistry([
			...current.filter((entry) => entry.id !== model.id),
			model,
		]);
	});
}

async function removeInstalledModel(id: string): Promise<boolean> {
	return withConfigFileLock(registryPath(), async () => {
		const current = await readRegistry();
		const target = current.find((model) => model.id === id);
		if (!target) return false;
		await fsp.rm(target.path, { force: true });
		await writeRegistry(current.filter((model) => model.id !== id));
		return true;
	});
}

async function readAssignments(): Promise<Assignments> {
	const file = await readJsonFile<{ assignments?: Assignments }>(
		assignmentsPath(),
		{
			assignments: {},
		},
	);
	return sanitizeAssignments(file.assignments ?? {});
}

async function writeAssignments(
	assignments: Assignments,
): Promise<Assignments> {
	await writeJsonFile(assignmentsPath(), { version: 1, assignments });
	return assignments;
}

// Serialized read-modify-write for assignments.json. The mutator runs inside
// the per-file lock between a fresh read and the write-back, so concurrent
// assignment updates observe each other's writes instead of racing on the
// stale pre-write snapshot (issue #25123).
async function updateAssignments(
	mutate: (assignments: Assignments) => void,
): Promise<Assignments> {
	return withConfigFileLock(assignmentsPath(), async () => {
		const assignments = await readAssignments();
		mutate(assignments);
		return writeAssignments(assignments);
	});
}

async function assignModel(
	model: CatalogModel,
	overwrite: boolean,
): Promise<void> {
	await updateAssignments((assignments) => {
		if (model.role === "embedding") {
			if (overwrite || !assignments.TEXT_EMBEDDING) {
				assignments.TEXT_EMBEDDING = model.id;
			}
		} else if (model.role === "chat") {
			if (overwrite || !assignments.TEXT_SMALL)
				assignments.TEXT_SMALL = model.id;
			if (overwrite || !assignments.TEXT_LARGE)
				assignments.TEXT_LARGE = model.id;
			if (overwrite || !assignments.TEXT_EMBEDDING) {
				assignments.TEXT_EMBEDDING = model.id;
			}
			if (overwrite || !assignments.TEXT_TO_SPEECH) {
				assignments.TEXT_TO_SPEECH = model.id;
			}
			if (overwrite || !assignments.TRANSCRIPTION) {
				assignments.TRANSCRIPTION = model.id;
			}
		}
	});
}

async function ensureDefaultAssignment(model: CatalogModel): Promise<void> {
	await assignModel(model, false);
}

async function downloadModel(
	model: CatalogModel,
	record: DownloadJob,
): Promise<void> {
	const abortController = activeDownloads.get(model.id)?.abortController;
	if (!abortController) return;

	const finalPath = finalModelPath(model);
	const partialPath = stagingPath(model);
	const existingPartial = await fsp
		.stat(partialPath)
		.then((stat) => (stat.isFile() ? stat.size : 0))
		.catch(() => 0);

	record.state = "downloading";
	record.received = existingPartial;
	record.updatedAt = new Date().toISOString();

	try {
		const downloadUrl = huggingFaceResolveUrl(model);
		const headers: Record<string, string> = {
			"user-agent": "Eliza-MobileLocalInference/1.0",
			...resolveHubAuthHeaders(downloadUrl),
		};
		if (existingPartial > 0) headers.range = `bytes=${existingPartial}-`;
		const response = await openDownloadResponse(
			downloadUrl,
			headers,
			abortController.signal,
		);
		const statusCode = response.statusCode ?? 0;
		if (statusCode < 200 || statusCode >= 300) {
			throw new Error(`HTTP ${statusCode} ${response.statusMessage ?? ""}`);
		}
		// Resume only when the server confirmed the Range with 206 Partial Content.
		// Many CDNs, mirrors, and proxies (e.g. a ModelScope base or a corporate
		// proxy) ignore `Range` and answer 200 OK with the *entire* body. Appending
		// that full body onto the existing partial bytes yields an oversized, corrupt
		// GGUF that still begins with the real "GGUF" magic — so isGgufFile() passes,
		// sha256 is computed over the corrupt bytes, and the file is registered as an
		// installed model whose later verify_model recomputes the same sha and
		// reports "ok". The corruption is then silent and permanent (#29454). On a
		// 200 we discard the partial and restart the write from byte 0.
		const isResume = existingPartial > 0 && statusCode === 206;
		record.received = isResume ? existingPartial : 0;
		const contentLength = Number.parseInt(
			String(response.headers["content-length"] ?? "0"),
			10,
		);
		if (Number.isFinite(contentLength) && contentLength > 0) {
			record.total = isResume ? existingPartial + contentLength : contentLength;
		}

		const stream = fs.createWriteStream(partialPath, {
			flags: isResume ? "a" : "w",
		});
		let lastSampleAt = Date.now();
		let lastSampleBytes = record.received;

		try {
			for await (const chunk of response) {
				const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (!stream.write(Buffer.from(value))) {
					await new Promise<void>((resolve) => stream.once("drain", resolve));
				}
				record.received += value.length;
				const now = Date.now();
				const elapsed = now - lastSampleAt;
				if (elapsed >= 1000) {
					record.bytesPerSec =
						((record.received - lastSampleBytes) * 1000) / elapsed;
					record.etaMs =
						record.bytesPerSec > 0
							? ((record.total - record.received) * 1000) / record.bytesPerSec
							: null;
					lastSampleAt = now;
					lastSampleBytes = record.received;
					record.updatedAt = new Date().toISOString();
				}
			}
		} finally {
			stream.end();
			await new Promise<void>((resolve, reject) => {
				stream.on("finish", resolve);
				stream.on("error", reject);
			});
		}

		await fsp.rename(partialPath, finalPath);
		if (!(await isGgufFile(finalPath))) {
			throw new Error("Downloaded file is not a valid GGUF");
		}
		const stat = await fsp.stat(finalPath);
		const sha256 = await hashFile(finalPath);
		await upsertInstalledModel({
			id: model.id,
			displayName: model.displayName,
			path: finalPath,
			sizeBytes: stat.size,
			hfRepo: model.hfRepo,
			installedAt: new Date().toISOString(),
			lastUsedAt: null,
			source: "eliza-download",
			sha256,
			lastVerifiedAt: new Date().toISOString(),
		});
		await ensureDefaultAssignment(model);

		record.state = "completed";
		record.received = stat.size;
		record.total = stat.size;
		record.updatedAt = new Date().toISOString();
	} catch (error) {
		if (abortController.signal.aborted) {
			record.state = "cancelled";
		} else {
			record.state = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			logger.warn(
				`[local-inference] Download failed for ${model.id}: ${record.error}`,
			);
		}
		record.updatedAt = new Date().toISOString();
	} finally {
		if (record.state !== "downloading") {
			activeDownloads.delete(model.id);
		}
	}
}

async function startDownload(modelId: string): Promise<DownloadJob> {
	const existing = activeDownloads.get(modelId);
	if (existing) return { ...existing.job };
	const model = CATALOG.find((entry) => entry.id === modelId);
	if (!model) throw new Error(`Unknown model id: ${modelId}`);
	await ensureLocalInferenceDirs();
	const job: DownloadJob = {
		jobId: crypto.randomUUID(),
		modelId,
		state: "queued",
		received: 0,
		total: Math.round(model.sizeGb * 1024 ** 3),
		bytesPerSec: 0,
		etaMs: null,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	activeDownloads.set(modelId, {
		job,
		abortController: new AbortController(),
	});
	void downloadModel(model, job);
	return { ...job };
}

async function installedSnapshot(): Promise<InstalledModel[]> {
	await ensureLocalInferenceDirs();
	return readRegistry();
}

/**
 * Whether local inference is the routing target for chat text, independent of
 * whether a model is resident. Local is routed when the config does not send
 * text to Eliza Cloud at all, or when it does but no Cloud credential is
 * linked — in which case plugin-elizacloud registers no chat handler and local
 * is the only provider that can serve. Reporting only `status` made that state
 * read as `idle` while local was in fact the active path (#20045 R5).
 *
 * Returns undefined when the config cannot be read, so the field is absent
 * rather than a fabricated boolean.
 */
async function isLocalInferenceRouted(): Promise<boolean | undefined> {
	const config = await readJsonFile<Record<string, unknown> | null>(
		path.join(stateDir(), "eliza.json"),
		null,
	);
	if (!config) return undefined;
	const topology = resolveElizaCloudTopology(config);
	if (!topology.services.inference) return true;
	return topology.servicesUnreconciled.includes("inference");
}

export async function getLocalInferenceActiveSnapshot(): Promise<{
	modelId: string | null;
	loadedAt: string | null;
	status: "idle" | "loading" | "ready" | "error";
	routed?: boolean;
	error?: string;
	loadedContextSize?: number | null;
	loadedCacheTypeK?: string | null;
	loadedCacheTypeV?: string | null;
	loadedGpuLayers?: number | null;
}> {
	const routed = await isLocalInferenceRouted();
	const withRouted = <T extends object>(state: T): T & { routed?: boolean } =>
		routed === undefined ? state : { ...state, routed };
	const serviceActive = (await localInferenceServiceLazy()).getActive();
	if (serviceActive.status === "ready" && serviceActive.modelId) {
		return withRouted(serviceActive);
	}
	const aospActive = await readJsonFile<{
		status?: string;
		role?: string;
		path?: string;
		loadedAt?: string;
	} | null>(aospActivePath(), null);
	if (
		aospActive?.status === "ready" &&
		aospActive.role === "chat" &&
		typeof aospActive.path === "string"
	) {
		// aosp-active.json is the authoritative "a local chat model is loaded and
		// serving in-process" signal for the agent-side path (ELIZA_LOCAL_LLAMA),
		// written by plugin-native-inference when it loads the GGUF. Report
		// ready off that file directly — do NOT gate it on the installed-models
		// registry: a device can stage the GGUF without registering it (e.g. a
		// pushed smoke model, or any direct install), and the model is loaded
		// regardless. Resolve a friendly modelId from the registry when present,
		// else fall back to the gguf filename so the snapshot stays meaningful.
		const installed = (await installedSnapshot()).find(
			(model) => model.path === aospActive.path,
		);
		return withRouted({
			modelId:
				installed?.id ?? path.basename(aospActive.path).replace(/\.gguf$/i, ""),
			loadedAt:
				typeof aospActive.loadedAt === "string" ? aospActive.loadedAt : null,
			status: "ready" as const,
		});
	}
	const bridgeStatus = await getMobileDeviceBridgeApi()
		.then((api) => api.getMobileDeviceBridgeStatus())
		.catch(() => getMobileDeviceBridgeStatusUnavailable());
	const loadedPath = bridgeStatus.devices.find((device) =>
		Boolean(device.loadedPath),
	)?.loadedPath;
	if (!loadedPath) return withRouted(activeModelState);
	// A connected device bridge that reports a loadedPath has the GGUF loaded and
	// serving on-device — that's "ready", same as the AOSP path above. Don't gate
	// on the installed-models registry (a device may load a directly-staged
	// model); resolve a friendly modelId from the registry when present, else the
	// gguf filename.
	const installed = (await installedSnapshot()).find(
		(model) => model.path === loadedPath,
	);
	return withRouted({
		modelId: installed?.id ?? path.basename(loadedPath).replace(/\.gguf$/i, ""),
		loadedAt: activeModelState.loadedAt,
		status: "ready" as const,
	});
}

async function hubSnapshot(): Promise<Record<string, unknown>> {
	return {
		catalog: CATALOG.filter((model) => !model.hiddenFromCatalog),
		installed: await installedSnapshot(),
		active: await getLocalInferenceActiveSnapshot(),
		downloads: [...activeDownloads.values()].map(({ job }) => ({ ...job })),
		hardware: {
			totalRamGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
			freeRamGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
			gpu: null,
			cpuCores: os.cpus().length,
			platform: process.platform,
			arch: process.arch,
			appleSilicon: process.platform === "darwin" && process.arch === "arm64",
			recommendedBucket: "small",
			source: "os-fallback",
		},
		assignments: await readAssignments(),
	};
}

function chatModels(): CatalogModel[] {
	return CATALOG.filter((model) => model.role === "chat");
}

function recommendedChatModel(): CatalogModel | null {
	const totalRamGb = os.totalmem() / 1024 ** 3;
	const candidates = chatModels()
		.filter((model) => totalRamGb >= model.minRamGb)
		.sort((left, right) => {
			const rightSize =
				typeof right.sizeGb === "number" && Number.isFinite(right.sizeGb)
					? right.sizeGb
					: 0;
			const leftSize =
				typeof left.sizeGb === "number" && Number.isFinite(left.sizeGb)
					? left.sizeGb
					: 0;
			return rightSize - leftSize || left.id.localeCompare(right.id);
		});
	return (
		candidates[0] ??
		chatModels().sort((a, b) => {
			const aSize =
				typeof a.sizeGb === "number" && Number.isFinite(a.sizeGb)
					? a.sizeGb
					: 0;
			const bSize =
				typeof b.sizeGb === "number" && Number.isFinite(b.sizeGb)
					? b.sizeGb
					: 0;
			return aSize - bSize || a.id.localeCompare(b.id);
		})[0] ??
		null
	);
}

function isNoSpaceMessage(value: unknown): boolean {
	const message =
		value instanceof Error
			? value.message
			: typeof value === "string"
				? value
				: "";
	return /\b(?:enospc|no space left|disk full|not enough (?:disk )?space|insufficient storage)\b/i.test(
		message,
	);
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
	return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function progressForJob(
	job: DownloadJob,
): LocalInferenceChatMetadata["progress"] {
	const percent =
		job.total > 0
			? Math.max(0, Math.min(100, Math.round((job.received / job.total) * 100)))
			: undefined;
	return {
		...(typeof percent === "number" ? { percent } : {}),
		receivedBytes: job.received,
		totalBytes: job.total,
		...(job.bytesPerSec > 0
			? { bytesPerSec: Math.round(job.bytesPerSec) }
			: {}),
		etaMs: job.etaMs,
	};
}

function progressText(
	progress: LocalInferenceChatMetadata["progress"] | undefined,
): string {
	if (!progress) return "";
	const percent =
		typeof progress.percent === "number" ? `${progress.percent}%` : "progress";
	const total =
		progress.totalBytes > 0 ? ` of ${formatBytes(progress.totalBytes)}` : "";
	return `${percent} (${formatBytes(progress.receivedBytes)}${total})`;
}

function pickStatusLine(status: LocalInferenceChatMetadata["status"]): string {
	const variants: Record<LocalInferenceChatMetadata["status"], string[]> = {
		missing: [
			"I do not have a local chat model installed yet.",
			"Local chat is waiting on a model download.",
			"There is no local chat model ready on this device.",
		],
		downloading: [
			"The local model is still downloading.",
			"I am still pulling down the local model.",
			"Local inference is waiting for the model download to finish.",
		],
		loading: [
			"The local model is loading now.",
			"I am warming up the local model.",
			"Local inference is still bringing the model online.",
		],
		failed: [
			"The local model setup hit an error.",
			"Local inference failed before generation could start.",
			"The local model is not ready because the last operation failed.",
		],
		no_space: [
			"The local model needs more disk space before it can finish.",
			"Local inference is blocked because storage is full.",
			"The model download cannot continue until some disk space is freed.",
		],
		idle: [
			"A local model is installed, but none is loaded right now.",
			"Local inference is idle with an installed model available.",
			"The local model is installed and waiting to be activated.",
		],
		ready: [
			"Local inference is ready.",
			"The local model is loaded and ready.",
			"On-device inference is online.",
		],
		cancelled: [
			"I cancelled the local model download.",
			"The local download has been stopped.",
			"Local model download cancelled.",
		],
		routing: [
			"I updated the inference routing.",
			"The model routing preference is updated.",
			"Inference routing has been changed.",
		],
	};
	const list = variants[status];
	return list[Math.floor(Date.now() / 15_000) % list.length] ?? list[0];
}

function buildLocalInferenceChatResult(
	metadata: LocalInferenceChatMetadata,
	detail?: string,
): LocalInferenceChatResult {
	const progress = progressText(metadata.progress);
	const parts = [
		pickStatusLine(metadata.status),
		metadata.modelId ? `Model: ${metadata.modelId}.` : "",
		progress ? `Progress: ${progress}.` : "",
		metadata.error ? `Error: ${metadata.error}` : "",
		detail ?? "",
	].filter((part) => part.trim().length > 0);
	return {
		text: parts.join(" "),
		localInference: metadata,
	};
}

function resolveRequestedCatalogModel(prompt: string): CatalogModel | null {
	const normalized = prompt.toLowerCase();
	return (
		chatModels().find((model) => {
			const candidates = [
				model.id,
				model.displayName,
				model.params,
				model.bucket,
				model.category,
			].map((value) => value.toLowerCase());
			return candidates.some((candidate) => normalized.includes(candidate));
		}) ?? null
	);
}

async function resolveDefaultChatModel(
	prompt: string,
): Promise<CatalogModel | null> {
	const requested = resolveRequestedCatalogModel(prompt);
	if (requested) return requested;
	const installed = await installedSnapshot();
	const active = await getLocalInferenceActiveSnapshot();
	const activeCatalog = active.modelId
		? CATALOG.find(
				(model) => model.id === active.modelId && model.role === "chat",
			)
		: null;
	if (activeCatalog) return activeCatalog;
	const installedCatalog = installed
		.map((entry) =>
			CATALOG.find((model) => model.id === entry.id && model.role === "chat"),
		)
		.filter((model): model is CatalogModel => Boolean(model))
		.sort((a, b) => {
			const aSize =
				typeof a.sizeGb === "number" && Number.isFinite(a.sizeGb)
					? a.sizeGb
					: 0;
			const bSize =
				typeof b.sizeGb === "number" && Number.isFinite(b.sizeGb)
					? b.sizeGb
					: 0;
			return aSize - bSize || a.id.localeCompare(b.id);
		})[0];
	return installedCatalog ?? recommendedChatModel();
}

async function setRoutingForChat(provider: string): Promise<void> {
	await setTextRouting(provider, "manual");
}

async function activateInstalledModel(
	installed: InstalledModel,
): Promise<LocalInferenceChatResult> {
	activeModelState = {
		modelId: installed.id,
		loadedAt: null,
		status: "loading",
	};
	try {
		const { loadMobileDeviceBridgeModel } = await getMobileDeviceBridgeApi();
		await loadMobileDeviceBridgeModel(installed.path, installed.id);
		activeModelState = {
			modelId: installed.id,
			loadedAt: new Date().toISOString(),
			status: "ready",
		};
		return buildLocalInferenceChatResult({
			intent: "use_local",
			status: "ready",
			modelId: installed.id,
			activeModelId: installed.id,
			provider: "capacitor-llama",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		activeModelState = {
			modelId: installed.id,
			loadedAt: null,
			status: "error",
			error: message,
		};
		return buildLocalInferenceChatResult({
			intent: "use_local",
			status: isNoSpaceMessage(message) ? "no_space" : "failed",
			modelId: installed.id,
			activeModelId: null,
			error: message,
		});
	}
}

export async function getLocalInferenceChatStatus(
	intent: LocalInferenceCommandIntent = "status",
	error?: unknown,
): Promise<LocalInferenceChatResult> {
	const activeDownload = [...activeDownloads.values()]
		.map(({ job }) => ({ ...job }))
		.find((job) => job.state === "queued" || job.state === "downloading");
	if (activeDownload) {
		return buildLocalInferenceChatResult({
			intent,
			status: "downloading",
			modelId: activeDownload.modelId,
			activeModelId: activeModelState.modelId,
			progress: progressForJob(activeDownload),
		});
	}

	const active = await getLocalInferenceActiveSnapshot();
	if (activeModelState.status === "loading") {
		return buildLocalInferenceChatResult({
			intent,
			status: "loading",
			modelId: activeModelState.modelId,
			activeModelId: active.modelId,
		});
	}

	const errorMessage =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: activeModelState.error;
	if (errorMessage) {
		return buildLocalInferenceChatResult({
			intent,
			status: isNoSpaceMessage(errorMessage) ? "no_space" : "failed",
			modelId: activeModelState.modelId,
			activeModelId: active.modelId,
			error: errorMessage,
		});
	}

	if (active.status === "ready" && active.modelId) {
		const provider =
			(await localInferenceServiceLazy()).getActive().status === "ready"
				? LOCAL_INFERENCE_PROVIDER_ID
				: "capacitor-llama";
		return buildLocalInferenceChatResult({
			intent,
			status: "ready",
			modelId: active.modelId,
			activeModelId: active.modelId,
			provider,
		});
	}

	const installed = await installedSnapshot();
	const installedChat = installed.find((entry) =>
		CATALOG.some((model) => model.id === entry.id && model.role === "chat"),
	);
	if (installedChat) {
		return buildLocalInferenceChatResult({
			intent,
			status: "idle",
			modelId: installedChat.id,
			activeModelId: active.modelId,
		});
	}

	return buildLocalInferenceChatResult({
		intent,
		status: "missing",
		modelId: null,
		activeModelId: active.modelId,
	});
}

export async function handleLocalInferenceChatCommand(
	intent: LocalInferenceCommandIntent,
	prompt: string,
): Promise<LocalInferenceChatResult> {
	if (intent === "status") {
		return getLocalInferenceChatStatus(intent);
	}

	if (intent === "cancel") {
		const requested = resolveRequestedCatalogModel(prompt);
		const targets = requested ? [requested.id] : [...activeDownloads.keys()];
		for (const modelId of targets) {
			activeDownloads.get(modelId)?.abortController.abort();
			activeDownloads.delete(modelId);
		}
		return buildLocalInferenceChatResult({
			intent,
			status: "cancelled",
			modelId: requested?.id ?? targets[0] ?? null,
			activeModelId: activeModelState.modelId,
		});
	}

	if (intent === "use_cloud") {
		await setRoutingForChat("elizacloud");
		return buildLocalInferenceChatResult(
			{
				intent,
				status: "routing",
				modelId: activeModelState.modelId,
				activeModelId: activeModelState.modelId,
				provider: "elizacloud",
			},
			"Subsequent chat model calls will prefer Eliza Cloud.",
		);
	}

	if (intent === "use_local") {
		const installed = await installedSnapshot();
		const requested = await resolveDefaultChatModel(prompt);
		const installedModel = installed.find(
			(entry) => entry.id === requested?.id,
		);
		if (installedModel) {
			const result = await activateInstalledModel(installedModel);
			if (result.localInference.status === "ready") {
				await setRoutingForChat("capacitor-llama");
			}
			return result;
		}
		if (requested) {
			const job = await startDownload(requested.id);
			await setRoutingForChat("capacitor-llama");
			return buildLocalInferenceChatResult(
				{
					intent: "download",
					status: "downloading",
					modelId: requested.id,
					activeModelId: activeModelState.modelId,
					provider: "capacitor-llama",
					progress: progressForJob(job),
				},
				"I also set chat routing to prefer local inference.",
			);
		}
		return getLocalInferenceChatStatus(intent);
	}

	if (intent === "switch_smaller") {
		const active = await getLocalInferenceActiveSnapshot();
		const installed = await installedSnapshot();
		const activeCatalog = active.modelId
			? CATALOG.find((model) => model.id === active.modelId)
			: null;
		const smallerInstalled = installed
			.map((entry) => ({
				entry,
				catalog: CATALOG.find(
					(model) => model.id === entry.id && model.role === "chat",
				),
			}))
			.filter(
				(entry): entry is { entry: InstalledModel; catalog: CatalogModel } => {
					const catalog = entry.catalog;
					if (!catalog) return false;
					return !activeCatalog || catalog.sizeGb < activeCatalog.sizeGb;
				},
			)
			.sort((a, b) => a.catalog.sizeGb - b.catalog.sizeGb)[0];
		if (smallerInstalled) {
			return activateInstalledModel(smallerInstalled.entry);
		}
		const smallest = chatModels().sort((a, b) => a.sizeGb - b.sizeGb)[0];
		if (smallest) {
			const job = await startDownload(smallest.id);
			return buildLocalInferenceChatResult(
				{
					intent,
					status: "downloading",
					modelId: smallest.id,
					activeModelId: active.modelId,
					progress: progressForJob(job),
				},
				"I could not switch to a smaller installed model, so I started the smallest local chat model download.",
			);
		}
	}

	const model = await resolveDefaultChatModel(prompt);
	if (!model) {
		return getLocalInferenceChatStatus(intent);
	}
	if (intent === "redownload") {
		await removeInstalledModel(model.id).catch(() => false);
	}
	const job = await startDownload(model.id);
	return buildLocalInferenceChatResult({
		intent,
		status: "downloading",
		modelId: model.id,
		activeModelId: activeModelState.modelId,
		progress: progressForJob(job),
	});
}

function requireModelId(modelId: string | undefined, op: string): string {
	if (typeof modelId !== "string" || !modelId.trim()) {
		throw new Error(`${op} requires modelId`);
	}
	return modelId.trim();
}

function requireSlot(slot: string | undefined, op: string): string {
	if (typeof slot !== "string" || !slot.trim()) {
		throw new Error(`${op} requires slot`);
	}
	return slot.trim();
}

export async function applyLocalInferenceManagementMutation(
	input: LocalInferenceManagementInput,
): Promise<LocalInferenceManagementResult> {
	switch (input.op) {
		case "start_download": {
			const modelId = requireModelId(input.modelId, input.op);
			return { op: input.op, modelId, job: await startDownload(modelId) };
		}
		case "cancel_download": {
			const modelId = input.modelId?.trim() || null;
			const targets = modelId ? [modelId] : [...activeDownloads.keys()];
			for (const target of targets) {
				activeDownloads.get(target)?.abortController.abort();
				activeDownloads.delete(target);
			}
			return {
				op: input.op,
				modelId: modelId ?? targets[0] ?? null,
				cancelled: true,
			};
		}
		case "set_active": {
			const modelId = requireModelId(input.modelId, input.op);
			const installed = (await installedSnapshot()).find(
				(model) => model.id === modelId,
			);
			if (!installed) throw new Error(`Model not installed: ${modelId}`);
			const result = await activateInstalledModel(installed);
			if (result.localInference.status === "failed") {
				throw new Error(
					result.localInference.error ?? "Failed to activate model",
				);
			}
			return { op: input.op, modelId, active: activeModelState };
		}
		case "clear_active": {
			if (shouldUseAospLocalInference()) {
				const { clearAospLocalInferenceModel } =
					await getAospLocalInferenceApi();
				activeModelState = await clearAospLocalInferenceModel();
				return { op: input.op, active: activeModelState };
			}
			try {
				const { unloadMobileDeviceBridgeModel } =
					await getMobileDeviceBridgeApi();
				await unloadMobileDeviceBridgeModel();
			} catch (error) {
				// Clearing chat routing should still reset our state in headless tests.
				logger.debug(
					`[local-inference] clear_active ignored bridge unload failure: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			activeModelState = { modelId: null, loadedAt: null, status: "idle" };
			return { op: input.op, active: activeModelState };
		}
		case "uninstall_model": {
			const modelId = requireModelId(input.modelId, input.op);
			return {
				op: input.op,
				modelId,
				removed: await removeInstalledModel(modelId),
			};
		}
		case "verify_model": {
			const modelId = requireModelId(input.modelId, input.op);
			const installed = (await installedSnapshot()).find(
				(model) => model.id === modelId,
			);
			if (!installed) throw new Error(`Model not installed: ${modelId}`);
			const currentSha256 = await hashFile(installed.path);
			return {
				op: input.op,
				modelId,
				state: currentSha256 === installed.sha256 ? "ok" : "unknown",
				currentSha256,
				expectedSha256: installed.sha256 ?? null,
				currentBytes: installed.sizeBytes,
			};
		}
		case "trigger_voice_model_update":
		case "pin_voice_model":
		case "set_voice_model_preferences": {
			const { applyVoiceModelManagementMutation } = await import(
				"./routes/voice-models-routes.js"
			);
			return applyVoiceModelManagementMutation({
				op: input.op,
				id: input.voiceModelId ?? input.modelId,
				pinned: input.pinned,
				preferences: input.voicePreferences,
			});
		}
		case "set_policy": {
			const slot = requireSlot(input.slot, input.op) as AgentModelSlot;
			if (!AGENT_MODEL_SLOTS.includes(slot)) {
				throw new Error(`Unknown local-inference routing slot: ${slot}`);
			}
			const rawPolicy = input.policy?.trim() || null;
			if (rawPolicy !== null && !isRoutingPolicy(rawPolicy)) {
				throw new Error(
					`Routing policy must be one of ${ROUTING_POLICIES.join(", ")}`,
				);
			}
			const preferences = await setPolicy(slot, rawPolicy);
			return {
				op: input.op,
				slot,
				policy: preferences.policy[slot] ?? null,
				preferences,
			};
		}
		case "set_preferred_provider": {
			const slot = requireSlot(input.slot, input.op) as AgentModelSlot;
			if (!AGENT_MODEL_SLOTS.includes(slot)) {
				throw new Error(`Unknown local-inference routing slot: ${slot}`);
			}
			const preferences = await setPreferredProvider(
				slot,
				input.provider?.trim() || null,
			);
			return {
				op: input.op,
				slot,
				provider: preferences.preferredProvider[slot] ?? null,
				preferences,
			};
		}
		case "set_assignment": {
			const slot = requireSlot(input.slot, input.op);
			if (!ASSIGNMENT_SLOTS.has(slot as keyof Assignments)) {
				throw new Error(`Unknown local-inference assignment slot: ${slot}`);
			}
			const modelId = input.modelId?.trim() || null;
			if (modelId && !isCuratedCatalogModelId(modelId)) {
				throw new Error(
					"Local inference assignments are limited to curated Eliza-1 tiers.",
				);
			}
			const assignments = await updateAssignments((current) => {
				if (modelId) {
					current[slot as keyof Assignments] = modelId;
				} else {
					delete current[slot as keyof Assignments];
				}
			});
			return {
				op: input.op,
				slot: slot as keyof Assignments,
				modelId,
				assignments,
			};
		}
		default: {
			const _exhaustive: never = input.op;
			throw new Error(`Unsupported local-inference op: ${String(_exhaustive)}`);
		}
	}
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function decodeLocalInferencePathId(
	raw: string,
	res: http.ServerResponse,
	fieldName: string,
): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		// error-policy:J3 malformed path encoding is invalid request input.
		sendJsonError(res, `Invalid ${fieldName}: malformed URL encoding`, 400);
		return null;
	}
}

export async function handleLocalInferenceRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;
	// Co-located voice-first-run namespace — runs alongside local-inference
	// so the existing /api/local-inference/* mount point in server.ts also
	// catches /api/voice/first-run/* without a second wire-up.
	if (pathname.startsWith("/api/voice/first-run/")) {
		const { handleVoiceFirstRunRoutes } = await import(
			"./routes/voice-first-run-routes.js"
		);
		if (await handleVoiceFirstRunRoutes(req, res)) return true;
	}
	if (pathname === "/api/voice/native-pcm-turn") {
		const { handleNativePcmTurnRoute } = await import(
			"./routes/native-pcm-turn-route.js"
		);
		if (await handleNativePcmTurnRoute(req, res)) return true;
	}
	// Family-member capture route lives under /v1/voice/first-run/family-member.
	if (pathname === "/v1/voice/first-run/family-member") {
		const { handleFamilyMemberRoute } = await import(
			"./routes/family-member-route.js"
		);
		if (await handleFamilyMemberRoute(req, res)) return true;
	}
	// Speaker voice-profile binding routes (bind/unbind a recognized voice to
	// an elizaOS entity) live under /v1/voice/speaker-profiles.
	if (pathname.startsWith("/v1/voice/speaker-profiles")) {
		const { handleVoiceSpeakerProfileRoutes } = await import(
			"./routes/voice-speaker-profile-routes.js"
		);
		if (await handleVoiceSpeakerProfileRoutes(req, res)) return true;
	}
	if (!pathname.startsWith("/api/local-inference/")) return false;

	// Voice-sub-model auto-updater compat namespace
	// (R5-versioning §3 + §4 + §5). The route module owns its own
	// path-prefix check and returns false on miss so non-voice-model
	// /api/local-inference/* paths fall through to the handlers below.
	if (pathname.startsWith("/api/local-inference/voice-models")) {
		const { handleVoiceModelsRoutes } = await import(
			"./routes/voice-models-routes.js"
		);
		if (await handleVoiceModelsRoutes(req, res)) return true;
	}

	if (
		method === "GET" &&
		pathname === "/api/local-inference/downloads/stream"
	) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		});
		const interval = setInterval(() => {
			writeSse(res, {
				type: "snapshot",
				downloads: [...activeDownloads.values()].map(({ job }) => ({ ...job })),
			});
		}, 1000);
		interval.unref();
		writeSse(res, {
			type: "snapshot",
			downloads: [...activeDownloads.values()].map(({ job }) => ({ ...job })),
		});
		req.on("close", () => clearInterval(interval));
		return true;
	}

	if (method === "GET" && pathname === "/api/local-inference/hub") {
		sendJson(res, await hubSnapshot());
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hardware") {
		sendJson(res, (await hubSnapshot()).hardware);
		return true;
	}
	// The authoritative device-tier assessment (tier + recommendedMode +
	// recommendedFit) — the same one the router's AUTO policy consumes. Mirrors
	// the app-core compat route so mobile (which mounts this upstream variant)
	// also gets the authoritative assessment instead of the coarse client estimate.
	if (method === "GET" && pathname === "/api/local-inference/device-tier") {
		sendJson(res, {
			tier: classifyDeviceTier(
				await (await localInferenceServiceLazy()).getHardware(),
			),
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/catalog") {
		sendJson(res, {
			models: CATALOG.filter((model) => !model.hiddenFromCatalog),
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/installed") {
		sendJson(res, { models: await installedSnapshot() });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/device") {
		const bridge = await getMobileDeviceBridgeApi()
			.then((api) => api.getMobileDeviceBridgeStatus())
			.catch(() => getMobileDeviceBridgeStatusUnavailable());
		sendJson(res, bridge);
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/providers") {
		const bridge = await getMobileDeviceBridgeApi()
			.then((api) => api.getMobileDeviceBridgeStatus())
			.catch(() => getMobileDeviceBridgeStatusUnavailable());
		// In-process bionic-host serving signal (#11498): on Android the
		// capacitor-llama handlers can be bound directly to the in-process GPU
		// host (no paired cross-process device), in which case bridge.connected
		// stays false even though the provider serves every turn. Surface that
		// as servingVia so readiness gates don't reject a working path.
		const serving = await getMobileDeviceBridgeApi()
			.then((api) => api.getMobileDeviceBridgeServingStatus())
			.catch(
				(): MobileDeviceBridgeServingStatus => ({
					registeredTrigger: null,
					bionicHostServing: false,
				}),
			);
		const bionicServing = serving.bionicHostServing === true;
		const installed = await installedSnapshot();
		sendJson(res, {
			providers: [
				{
					id: "capacitor-llama",
					label: "Eliza-1 on-device runtime (mobile)",
					kind: "local",
					description: "Runs Eliza-1 natively on iOS or Android via Capacitor.",
					supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
					configureHref: null,
					enableState: {
						enabled: bridge.connected === true || bionicServing,
						reason: bionicServing
							? "In-process bionic host serving"
							: bridge.connected
								? "Device bridge connected"
								: "Waiting for device bridge",
					},
					registeredSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
					servingVia: bionicServing
						? ("bionic-host" as const)
						: bridge.connected
							? ("device-bridge" as const)
							: null,
					registeredTrigger: serving.registeredTrigger,
				},
				{
					id: LOCAL_INFERENCE_PROVIDER_ID,
					label: "Eliza-1 local inference",
					kind: "local",
					description:
						"Eliza-1 bundles installed in this agent state directory.",
					supportedSlots: LOCAL_INFERENCE_MODEL_TYPES,
					configureHref: "#local-inference-panel",
					enableState: {
						enabled: installed.length > 0,
						reason:
							installed.length > 0
								? "Eliza-1 bundle installed"
								: "No Eliza-1 bundle installed",
					},
					registeredSlots:
						installed.length > 0 ? LOCAL_INFERENCE_MODEL_TYPES : [],
				},
			],
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/assignments") {
		sendJson(res, { assignments: await readAssignments() });
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/assignments") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body) return true;
		const slot = typeof body.slot === "string" ? body.slot : null;
		if (!slot || !ASSIGNMENT_SLOTS.has(slot as keyof Assignments)) {
			sendJsonError(res, "slot is required");
			return true;
		}
		const modelId =
			typeof body.modelId === "string" && body.modelId.trim()
				? body.modelId.trim()
				: null;
		if (modelId && !isCuratedCatalogModelId(modelId)) {
			sendJsonError(
				res,
				"Local inference assignments are limited to curated Eliza-1 tiers.",
				400,
			);
			return true;
		}
		// Read-modify-write must run inside the per-file lock: a bare
		// readAssignments/writeAssignments pair here loses one of two
		// concurrent POSTs to the stale pre-write snapshot (issue #25123's
		// race, on the route that motivated it).
		const assignments = await updateAssignments((current) => {
			if (modelId) {
				current[slot as keyof Assignments] = modelId;
			} else {
				delete current[slot as keyof Assignments];
			}
		});
		sendJson(res, { assignments });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/routing") {
		const preferences = await readRoutingPreferences();
		sendJson(res, {
			registrations: LOCAL_INFERENCE_MODEL_TYPES.map((modelType) => ({
				modelType,
				provider: LOCAL_INFERENCE_PROVIDER_ID,
				priority: 0,
				registeredAt: new Date().toISOString(),
			})),
			preferences,
		});
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/routing/text") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body) return true;
		const provider =
			typeof body.provider === "string" && body.provider.trim().length > 0
				? body.provider.trim()
				: null;
		if (!provider) {
			sendJsonError(res, "provider is required");
			return true;
		}
		const policy = body.policy ?? "manual";
		if (!isRoutingPolicy(policy)) {
			sendJsonError(
				res,
				`policy must be one of ${ROUTING_POLICIES.join(", ")}`,
				400,
			);
			return true;
		}
		const preferences = await setTextRouting(provider, policy);
		sendJson(res, { preferences });
		return true;
	}
	if (
		method === "POST" &&
		(pathname === "/api/local-inference/routing/preferred" ||
			pathname === "/api/local-inference/routing/policy")
	) {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body || typeof body.slot !== "string") {
			sendJsonError(res, "slot is required");
			return true;
		}
		const slot = body.slot as AgentModelSlot;
		if (!AGENT_MODEL_SLOTS.includes(slot)) {
			sendJsonError(res, "slot must be a valid AgentModelSlot");
			return true;
		}
		let preferences: Awaited<ReturnType<typeof setPolicy>>;
		if (pathname.endsWith("/preferred")) {
			preferences = await setPreferredProvider(
				slot,
				typeof body.provider === "string" && body.provider.trim()
					? body.provider.trim()
					: null,
			);
		} else if (body.policy === null || isRoutingPolicy(body.policy)) {
			preferences = await setPolicy(slot, body.policy);
		} else {
			sendJsonError(
				res,
				`policy must be one of ${ROUTING_POLICIES.join(", ")} or null`,
				400,
			);
			return true;
		}
		sendJson(res, { preferences });
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/downloads") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body) return true;
		const modelId = typeof body.modelId === "string" ? body.modelId : null;
		if (!modelId) {
			sendJsonError(res, "modelId is required");
			return true;
		}
		try {
			sendJson(res, { job: await startDownload(modelId) }, 202);
		} catch (error) {
			sendJsonError(
				res,
				error instanceof Error ? error.message : "Failed to start download",
				400,
			);
		}
		return true;
	}
	const downloadMatch = /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(
		pathname,
	);
	if (method === "DELETE" && downloadMatch) {
		const modelId = decodeLocalInferencePathId(
			downloadMatch[1] ?? "",
			res,
			"model id",
		);
		if (modelId === null) return true;
		activeDownloads.get(modelId)?.abortController.abort();
		activeDownloads.delete(modelId);
		sendJson(res, { cancelled: true });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/active") {
		sendJson(res, await getLocalInferenceActiveSnapshot());
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/active") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body || typeof body.modelId !== "string") {
			sendJsonError(res, "modelId is required");
			return true;
		}
		const installed = (await installedSnapshot()).find(
			(model) => model.id === body.modelId,
		);
		if (!installed) {
			sendJsonError(res, `Model not installed: ${body.modelId}`, 404);
			return true;
		}
		// #7679: refuse to activate a candidate-only / weights-staged bundle
		// whose manifest reports `evals.textEval.passed=false`. Runs before
		// any assignment write or device-bridge load so a known-bad bundle
		// can't take over the assignment slots nor leave the bridge holding
		// a half-loaded model. The gate only fires for tiers whose
		// `eliza-1.manifest.json` is reachable next to the installed bundle
		// (see `defaultManifestLoader`); external-scan / non-bundle installs
		// are passed through.
		// Lazy: active-model.js pulls the engine (~545ms). Load it here, on the
		// model-activation path (the engine is needed to activate anyway), so it
		// stays off the boot-blocking plugin import (issue #9565).
		const { assertManifestEvalsPassed, CandidateModelActivationError } =
			await import("./services/active-model.js");
		try {
			assertManifestEvalsPassed(installed);
		} catch (err) {
			if (err instanceof CandidateModelActivationError) {
				sendJson(
					res,
					{
						error: err.message,
						modelId: err.modelId,
						manifestVersion: err.manifestVersion,
						failedEvals: err.failedEvals,
					},
					422,
				);
				return true;
			}
			throw err;
		}
		const catalog = CATALOG.find((model) => model.id === installed.id);
		if (catalog) await assignModel(catalog, true);
		try {
			activeModelState = {
				modelId: installed.id,
				loadedAt: null,
				status: "loading",
			};
			if (shouldUseAospLocalInference()) {
				const { activateAospLocalInferenceModel, buildAospLoadModelArgs } =
					await getAospLocalInferenceApi();
				activeModelState = await activateAospLocalInferenceModel({
					modelId: installed.id,
					modelPath: installed.path,
					loadArgs: buildAospLoadModelArgs("chat", installed.path),
				});
				sendJson(res, activeModelState);
				void prewarmLocalVoiceStackLazy(installed.id);
				return true;
			}
			const { loadMobileDeviceBridgeModel } = await getMobileDeviceBridgeApi();
			await loadMobileDeviceBridgeModel(installed.path, installed.id);
			activeModelState = {
				modelId: installed.id,
				loadedAt: new Date().toISOString(),
				status: "ready",
			};
			sendJson(res, activeModelState);
			void prewarmLocalVoiceStackLazy(installed.id);
		} catch (error) {
			activeModelState = {
				modelId: installed.id,
				loadedAt: null,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
			sendJsonError(
				res,
				error instanceof Error ? error.message : "Failed to load model",
				503,
			);
		}
		return true;
	}
	if (method === "DELETE" && pathname === "/api/local-inference/active") {
		try {
			if (shouldUseAospLocalInference()) {
				const { clearAospLocalInferenceModel } =
					await getAospLocalInferenceApi();
				activeModelState = await clearAospLocalInferenceModel();
				sendJson(res, activeModelState);
				return true;
			}
			const { unloadMobileDeviceBridgeModel } =
				await getMobileDeviceBridgeApi();
			await unloadMobileDeviceBridgeModel();
			activeModelState = { modelId: null, loadedAt: null, status: "idle" };
			sendJson(res, activeModelState);
		} catch (error) {
			sendJsonError(
				res,
				error instanceof Error ? error.message : "Failed to unload model",
				503,
			);
		}
		return true;
	}
	const verifyMatch =
		/^\/api\/local-inference\/installed\/([^/]+)\/verify$/.exec(pathname);
	if (method === "POST" && verifyMatch) {
		const id = decodeLocalInferencePathId(
			verifyMatch[1] ?? "",
			res,
			"model id",
		);
		if (id === null) return true;
		const installed = (await installedSnapshot()).find(
			(model) => model.id === id,
		);
		if (!installed) {
			sendJsonError(res, "Model not installed", 404);
			return true;
		}
		const currentSha256 = await hashFile(installed.path);
		sendJson(res, {
			state: currentSha256 === installed.sha256 ? "ok" : "unknown",
			currentSha256,
			expectedSha256: installed.sha256 ?? null,
			currentBytes: installed.sizeBytes,
		});
		return true;
	}
	const installedMatch = /^\/api\/local-inference\/installed\/([^/]+)$/.exec(
		pathname,
	);
	if (method === "DELETE" && installedMatch) {
		const id = decodeLocalInferencePathId(
			installedMatch[1] ?? "",
			res,
			"model id",
		);
		if (id === null) return true;
		sendJson(res, { removed: await removeInstalledModel(id) });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hf-search") {
		sendJson(res, {
			models: [],
			disabled: true,
			reason: "custom-model-search-disabled",
		});
		return true;
	}

	return false;
}
