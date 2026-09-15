/**
 * Tests for OptimizedPromptService symlink-based versioning + rollback.
 *
 * Covers the contract documented in optimized-prompt.ts:
 *   - setPrompt writes v1.json, v2.json, ... and points `current` at the
 *     newest, `previous` at the second-newest, `previous2` at the third.
 *   - Only the last OPTIMIZED_PROMPT_RETAIN_VERSIONS versions are retained.
 *   - rollback flips `current` and `previous`, swapping which version
 *     `getPrompt` returns.
 *   - refresh reads via `current` symlink and falls back to the directory
 *     scan when no symlink is present (legacy stores).
 */

import {
	existsSync,
	mkdirSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import type { IAgentRuntime } from "../types";
import {
	_computeOptimizedPromptMacForTest,
	OPTIMIZED_PROMPT_CURRENT_LINK,
	OPTIMIZED_PROMPT_PREVIOUS_LINK,
	OPTIMIZED_PROMPT_PREVIOUS2_LINK,
	OPTIMIZED_PROMPT_RETAIN_VERSIONS,
	type OptimizedPromptArtifact,
	OptimizedPromptService,
	parseDisabledTasksEnv,
	parseOptimizedPromptArtifact,
} from "./optimized-prompt";
import { resolveOptimizedPrompt } from "./optimized-prompt-resolver";

const TEST_INTEGRITY_KEY = Buffer.alloc(32, 0x5a).toString("base64");

function createService(): OptimizedPromptService {
	return new OptimizedPromptService({
		reportError: vi.fn(),
	} as unknown as IAgentRuntime);
}

beforeEach(() => {
	process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY = TEST_INTEGRITY_KEY;
});

afterEach(() => {
	delete process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY;
});

/**
 * Helper for legacy-store tests: writes the artifact payload AND its `.mac`
 * sidecar (the on-disk format every artifact now requires).
 */
function writeArtifactWithMac(path: string, payload: string): void {
	writeFileSync(path, payload, "utf-8");
	writeFileSync(
		`${path}.mac`,
		`${_computeOptimizedPromptMacForTest(payload)}\n`,
		"utf-8",
	);
}

function makeArtifact(index: number): OptimizedPromptArtifact {
	const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
	return {
		task: "action_planner",
		optimizer: "instruction-search",
		baseline: "baseline prompt",
		prompt: `optimized prompt v${index}`,
		score: 0.5 + index * 0.01,
		baselineScore: 0.4,
		datasetId: "test-dataset",
		datasetSize: 100,
		generatedAt: stamp,
		lineage: [{ round: 1, variant: index, score: 0.5 + index * 0.01 }],
	};
}

describe("OptimizedPromptService — symlink-based versioning", () => {
	let storeRoot: string;
	let service: OptimizedPromptService;

	beforeEach(async () => {
		storeRoot = await mkdtemp(join(tmpdir(), "optimized-prompt-test-"));
		service = createService();
		service.setStoreRoot(storeRoot);
	});

	afterEach(async () => {
		await rm(storeRoot, { recursive: true, force: true });
	});

	it("writes vN.json files and points the current/previous/previous2 symlinks", async () => {
		const dir = join(storeRoot, "action_planner");
		const v1Path = await service.setPrompt("action_planner", makeArtifact(1));
		expect(v1Path).toBe(join(dir, "v1.json"));
		// After one write: current → v1, no previous, no previous2.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v1.json",
		);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(false);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(false);

		await service.setPrompt("action_planner", makeArtifact(2));
		// After two writes: current → v2, previous → v1.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v2.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v1.json",
		);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(false);

		await service.setPrompt("action_planner", makeArtifact(3));
		// After three writes: current → v3, previous → v2, previous2 → v1.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v3.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v2.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(
			"v1.json",
		);
	});

	it("strict parser preserves optional optimization report metadata", () => {
		const parsed = parseOptimizedPromptArtifact({
			...makeArtifact(1),
			frontier: [
				{
					prompt: "optimized prompt v1",
					score: 0.7,
					promptTokenCount: 42,
					origin: "feedback-mut",
					feedback: "tighten the planner contract",
				},
			],
			promotionDecision: {
				promote: true,
				delta: 0.2,
				incumbentScores: [0.5, 0.5, 0.5],
			},
		});

		expect(parsed?.frontier).toEqual([
			{
				prompt: "optimized prompt v1",
				score: 0.7,
				promptTokenCount: 42,
				origin: "feedback-mut",
				feedback: "tighten the planner contract",
			},
		]);
		expect(parsed?.promotionDecision).toMatchObject({
			promote: true,
			delta: 0.2,
			incumbentScores: [0.5, 0.5, 0.5],
		});
	});

	it("rejects the orphaned contextConfig channel", () => {
		const parsed = parseOptimizedPromptArtifact({
			...makeArtifact(1),
			contextConfig: {
				providerSet: ["RECENT_MESSAGES", "", "FACTS"],
				providerOrder: ["FACTS", "RECENT_MESSAGES"],
				renderTemplates: {
					RECENT_MESSAGES: "{{role}}: {{text}}",
					EMPTY: "",
				},
				budgetVector: {
					RECENT_MESSAGES: 1200,
					NEGATIVE: -1,
				},
			},
		});

		expect(parsed).toBeNull();
	});

	it("rejects contextConfig even when the own-property value is undefined", () => {
		const parsed = parseOptimizedPromptArtifact({
			...makeArtifact(1),
			contextConfig: undefined,
		} as unknown);

		expect(parsed).toBeNull();
	});

	it("rejects invalid public artifacts before signing, persistence, or caching", async () => {
		const invalidArtifacts = [
			{
				...makeArtifact(1),
				contextConfig: { providerSet: ["RECENT_MESSAGES"] },
			},
			{
				...makeArtifact(1),
				unsupportedExtra: "must not cross the artifact boundary",
			},
		] as OptimizedPromptArtifact[];

		for (const invalidArtifact of invalidArtifacts) {
			await expect(
				service.setPrompt("action_planner", invalidArtifact),
			).rejects.toMatchObject({
				name: "ElizaError",
				code: "OPTIMIZED_PROMPT_ARTIFACT_INVALID",
			});
		}

		expect(existsSync(join(storeRoot, "action_planner"))).toBe(false);
		expect(service.getPrompt("action_planner")).toBeNull();
	});

	it.each<[string, Record<string, unknown>]>([
		["nonfinite score", { score: Number.NaN }],
		["infinite baseline", { baselineScore: Number.POSITIVE_INFINITY }],
		["negative dataset size", { datasetSize: -1 }],
		["fractional dataset size", { datasetSize: 1.5 }],
		["unsafe dataset size", { datasetSize: Number.MAX_SAFE_INTEGER + 1 }],
		["invalid timestamp", { generatedAt: "not-a-date" }],
		[
			"malformed lineage",
			{ lineage: [{ round: 1, variant: 0, score: 0.7 }, null] },
		],
		[
			"nonfinite lineage",
			{ lineage: [{ round: 1, variant: 0, score: Number.NaN }] },
		],
		[
			"fractional lineage index",
			{ lineage: [{ round: 1.5, variant: 0, score: 0.7 }] },
		],
		["malformed frontier", { frontier: [{ prompt: "candidate", score: 0.7 }] }],
		[
			"nonfinite frontier",
			{
				frontier: [
					{
						prompt: "candidate",
						score: Number.NEGATIVE_INFINITY,
						promptTokenCount: 5,
						origin: "gepa",
					},
				],
			},
		],
		[
			"negative token count",
			{
				frontier: [
					{
						prompt: "candidate",
						score: 0.7,
						promptTokenCount: -1,
						origin: "gepa",
					},
				],
			},
		],
		[
			"malformed demonstration",
			{ fewShotExamples: [{ input: { user: "complete" } }] },
		],
		[
			"nonfinite demonstration reward",
			{
				fewShotExamples: [
					{
						input: { user: "complete" },
						expectedOutput: "complete",
						reward: Number.NaN,
					},
				],
			},
		],
		[
			"incomplete promotion evidence",
			{ promotionDecision: { incumbentScores: [0.5, Number.NaN] } },
		],
		[
			"nonfinite promotion decision",
			{ promotionDecision: { candidateScore: Number.POSITIVE_INFINITY } },
		],
		[
			"fractional reseed count",
			{ promotionDecision: { incumbentReseeds: 1.2 } },
		],
	])(
		"rejects %s without replacing an active persisted artifact",
		async (_name, overrides) => {
			const currentPath = await service.setPrompt(
				"action_planner",
				makeArtifact(1),
			);
			const before = await readFile(currentPath, "utf8");
			const priorPrompt = service.getPrompt("action_planner");
			const invalid = {
				...makeArtifact(2),
				...overrides,
			} as OptimizedPromptArtifact;
			await expect(
				service.setPrompt("action_planner", invalid),
			).rejects.toMatchObject({
				code: "OPTIMIZED_PROMPT_ARTIFACT_INVALID",
			});
			expect(await readFile(currentPath, "utf8")).toBe(before);
			expect(readlinkSync(join(storeRoot, "action_planner", "current"))).toBe(
				"v1.json",
			);
			expect(existsSync(join(storeRoot, "action_planner", "v2.json"))).toBe(
				false,
			);
			await service.refresh();
			expect(service.getPrompt("action_planner")).toEqual(priorPrompt);
		},
	);

	it("retains complete valid experiment metrics and examples across signing and restart", async () => {
		const artifact: OptimizedPromptArtifact = {
			...makeArtifact(1),
			lineage: [
				{ round: 0, variant: 0, score: 0.51, notes: "Complete trial evidence" },
			],
			fewShotExamples: [
				{
					input: {
						system: "Full instructions",
						user: "user: first\nassistant: evidence\nuser: final",
					},
					expectedOutput: "complete result",
					reward: 0.75,
				},
			],
			frontier: [
				{
					prompt: "Candidate instructions",
					score: 0.51,
					promptTokenCount: 0,
					origin: "gepa",
				},
			],
			promotionDecision: {
				promote: false,
				incumbentScores: [0.6, 0.7],
				candidateScore: 0.51,
				delta: -0.14,
				incumbentReseeds: 2,
				examplesPerPass: 1,
			},
		};
		const file = await service.setPrompt("action_planner", artifact);
		const persisted = JSON.parse(await readFile(file, "utf8"));
		expect(parseOptimizedPromptArtifact(persisted)).toEqual(
			parseOptimizedPromptArtifact(artifact),
		);
		const restarted = createService();
		restarted.setStoreRoot(storeRoot);
		await restarted.refresh();
		expect(restarted.getPrompt("action_planner")).toEqual(
			service.getPrompt("action_planner"),
		);
		expect(restarted.getMetadata("action_planner")).toEqual(
			service.getMetadata("action_planner"),
		);
	});

	it("rejects an artifact task mismatch with typed expected/actual context", async () => {
		const artifact = makeArtifact(1);
		await expect(service.setPrompt("response", artifact)).rejects.toMatchObject(
			{
				name: "ElizaError",
				code: "OPTIMIZED_PROMPT_ARTIFACT_TASK_MISMATCH",
				context: {
					expectedTask: "response",
					actualTask: "action_planner",
				},
			},
		);
		expect(existsSync(join(storeRoot, "response"))).toBe(false);
		expect(service.getPrompt("response")).toBeNull();
	});

	it("preserves valid artifacts across set, get, and a fresh-service reload", async () => {
		const artifact = makeArtifact(1);
		const path = await service.setPrompt("action_planner", artifact);

		expect(path).toBe(join(storeRoot, "action_planner", "v1.json"));
		expect(service.getPrompt("action_planner")?.prompt).toBe(artifact.prompt);

		const restartedService = createService();
		restartedService.setStoreRoot(storeRoot);
		await restartedService.refresh();
		expect(restartedService.getPrompt("action_planner")?.prompt).toBe(
			artifact.prompt,
		);
	});

	it("retains the most recent OPTIMIZED_PROMPT_RETAIN_VERSIONS artifacts", async () => {
		const totalWrites = OPTIMIZED_PROMPT_RETAIN_VERSIONS + 2;
		for (let i = 1; i <= totalWrites; i += 1) {
			await service.setPrompt("action_planner", makeArtifact(i));
		}
		const dir = join(storeRoot, "action_planner");
		const entries = await readdir(dir);
		const versionFiles = entries.filter((name) => /^v\d+\.json$/.test(name));
		expect(versionFiles.length).toBe(OPTIMIZED_PROMPT_RETAIN_VERSIONS);
		// The two oldest must have been pruned.
		expect(versionFiles).not.toContain("v1.json");
		expect(versionFiles).not.toContain("v2.json");
		// The newest is current.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			`v${totalWrites}.json`,
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			`v${totalWrites - 1}.json`,
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(
			`v${totalWrites - 2}.json`,
		);
	});

	it("getPrompt returns the artifact pointed to by current", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await service.setPrompt("action_planner", makeArtifact(2));
		await service.setPrompt("action_planner", makeArtifact(3));

		const live = service.getPrompt("action_planner");
		expect(live).not.toBeNull();
		expect(live?.prompt).toBe("optimized prompt v3");
	});

	it("rollback flips current and previous so the predecessor becomes live", async () => {
		// Write 5 artifacts so the matrix matches the task spec.
		for (let i = 1; i <= 5; i += 1) {
			await service.setPrompt("action_planner", makeArtifact(i));
		}
		const dir = join(storeRoot, "action_planner");

		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v5",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v5.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v4.json",
		);

		const newCurrentPath = await service.rollback("action_planner");
		expect(newCurrentPath).toBe(join(dir, "v4.json"));

		// After rollback: current → v4 (was previous), previous → v5 (was current).
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v4.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v5.json",
		);
		// previous2 untouched.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(
			"v3.json",
		);
		// In-memory cache refreshed via the current symlink.
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v4",
		);
	});

	it("rollback can be invoked twice to flip back to the original current", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await service.setPrompt("action_planner", makeArtifact(2));

		await service.rollback("action_planner");
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v1",
		);
		await service.rollback("action_planner");
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v2",
		);
	});

	it("rollback throws when there is no previous artifact", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await expect(service.rollback("action_planner")).rejects.toThrow(
			/no previous version/,
		);
	});

	it("rollback throws when the task directory does not exist", async () => {
		await expect(service.rollback("should_respond")).rejects.toThrow(
			/no artifact directory/,
		);
	});

	it("refresh prefers the current symlink even when a newer-by-generatedAt file exists in the directory", async () => {
		// v1 has generatedAt later than v2 — but current points at v2. The
		// service must return v2 because the symlink is authoritative.
		const dir = join(storeRoot, "action_planner");
		mkdirSync(dir, { recursive: true });
		const v1 = makeArtifact(1);
		// Force v1's generatedAt to be after v2 to prove the symlink wins.
		v1.generatedAt = new Date(Date.UTC(2027, 0, 1)).toISOString();
		v1.prompt = "v1 (newer by generatedAt)";
		const v2 = makeArtifact(2);
		v2.prompt = "v2 (older by generatedAt but symlink target)";
		writeArtifactWithMac(
			join(dir, "v1.json"),
			`${JSON.stringify(v1, null, 2)}\n`,
		);
		writeArtifactWithMac(
			join(dir, "v2.json"),
			`${JSON.stringify(v2, null, 2)}\n`,
		);
		// Manually set up symlinks so we don't go through setPrompt.
		const { symlinkSync } = await import("node:fs");
		symlinkSync("v2.json", join(dir, OPTIMIZED_PROMPT_CURRENT_LINK));
		symlinkSync("v1.json", join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK));

		await service.refresh();
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"v2 (older by generatedAt but symlink target)",
		);
	});

	it("refresh falls back to most-recent-by-generatedAt scan when current symlink is absent", async () => {
		// Legacy / corrupted store: only artifact files, no symlinks.
		const dir = join(storeRoot, "action_planner");
		mkdirSync(dir, { recursive: true });
		const older = makeArtifact(1);
		older.prompt = "older";
		const newer = makeArtifact(2);
		newer.prompt = "newer";
		writeArtifactWithMac(
			join(dir, "legacy-1.json"),
			`${JSON.stringify(older, null, 2)}\n`,
		);
		writeArtifactWithMac(
			join(dir, "legacy-2.json"),
			`${JSON.stringify(newer, null, 2)}\n`,
		);
		await service.refresh();
		expect(service.getPrompt("action_planner")?.prompt).toBe("newer");
	});

	it("isolates versioning between tasks", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await service.setPrompt("action_planner", makeArtifact(2));
		// Different task gets its own v1 — version counter is per-task.
		const otherArtifact = makeArtifact(10);
		otherArtifact.task = "should_respond";
		await service.setPrompt("should_respond", otherArtifact);

		const plannerDir = join(storeRoot, "action_planner");
		const respondDir = join(storeRoot, "should_respond");
		expect(readlinkSync(join(plannerDir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v2.json",
		);
		expect(readlinkSync(join(respondDir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v1.json",
		);
	});
});

describe("OptimizedPromptService — HMAC integrity (SOC2 CC6.8)", () => {
	let storeRoot: string;
	let service: OptimizedPromptService;

	beforeEach(async () => {
		storeRoot = await mkdtemp(join(tmpdir(), "optimized-prompt-hmac-"));
		service = createService();
		service.setStoreRoot(storeRoot);
	});

	afterEach(async () => {
		await rm(storeRoot, { recursive: true, force: true });
	});

	it("fails closed when no vault-hydrated integrity key is available", () => {
		delete process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY;
		expect(() => _computeOptimizedPromptMacForTest("payload")).toThrow(
			/ integrity key is unavailable/i,
		);
	});

	it("writes a `.mac` sidecar next to every artifact and loads when intact", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		const macPath = join(storeRoot, "action_planner", "v1.json.mac");
		expect(existsSync(macPath)).toBe(true);
		await service.refresh();
		const loaded = service.getPrompt("action_planner");
		expect(loaded).not.toBeNull();
		expect(loaded?.prompt).toBe("optimized prompt v1");
	});

	it("refuses to load when the `.mac` sidecar is missing", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		const { unlink: unlinkAsync } = await import("node:fs/promises");
		await unlinkAsync(join(storeRoot, "action_planner", "v1.json.mac"));
		await service.refresh();
		expect(service.getPrompt("action_planner")).toBeNull();
	});

	it("refuses to load when the artifact payload has been tampered with", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		const artifactPath = join(storeRoot, "action_planner", "v1.json");
		const tampered =
			'{"task":"action_planner","optimizer":"instruction-search",' +
			'"baseline":"baseline prompt","prompt":"INJECTED ADVERSARIAL PROMPT",' +
			'"score":0.51,"baselineScore":0.4,"datasetId":"test-dataset",' +
			'"datasetSize":100,"generatedAt":"2026-01-01T00:00:01.000Z",' +
			'"lineage":[{"round":1,"variant":1,"score":0.51}]}\n';
		writeFileSync(artifactPath, tampered, "utf-8");
		await service.refresh();
		expect(service.getPrompt("action_planner")).toBeNull();
	});

	it("refuses to load when the MAC was overwritten with garbage", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		writeFileSync(
			join(storeRoot, "action_planner", "v1.json.mac"),
			`${"deadbeef".repeat(8)}\n`,
			"utf-8",
		);
		await service.refresh();
		expect(service.getPrompt("action_planner")).toBeNull();
	});

	it("rejects artifacts signed by a superseded recovery key and falls back to baseline", async () => {
		const oldKey = Buffer.alloc(32, 0x31).toString("base64");
		const replacementKey = Buffer.alloc(32, 0x32).toString("base64");
		process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY = oldKey;
		await service.setPrompt("action_planner", makeArtifact(1));

		// Boot-time recovery replaces only the internal HMAC key. Existing
		// artifacts are intentionally left untrusted: the new key must reject
		// their old MAC and the runtime resolver must use its built-in baseline.
		process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY = replacementKey;
		await service.refresh();

		expect(service.getPrompt("action_planner")).toBeNull();
		expect(
			resolveOptimizedPrompt(
				service,
				"action_planner",
				"baseline after integrity-key recovery",
			),
		).toBe("baseline after integrity-key recovery");
	});
});

describe("OptimizedPromptService — per-task error isolation (#8795)", () => {
	let storeRoot: string;
	let service: OptimizedPromptService;

	beforeEach(async () => {
		storeRoot = await mkdtemp(join(tmpdir(), "optimized-prompt-isolation-"));
		service = createService();
		service.setStoreRoot(storeRoot);
	});

	afterEach(async () => {
		await rm(storeRoot, { recursive: true, force: true });
	});

	it("isolates a self-referential `current` symlink (ELOOP) — other tasks still load", async () => {
		// One healthy task writes a real artifact via setPrompt.
		await service.setPrompt("action_planner", makeArtifact(1));

		// A second task's `current` symlink loops onto itself: reading it via
		// readFile throws ELOOP. Before the fix this rethrew out of refresh()
		// and disabled optimized prompts for ALL tasks.
		const loopingDir = join(storeRoot, "should_respond");
		mkdirSync(loopingDir, { recursive: true });
		symlinkSync(
			OPTIMIZED_PROMPT_CURRENT_LINK,
			join(loopingDir, OPTIMIZED_PROMPT_CURRENT_LINK),
		);

		// refresh() must RESOLVE, not reject.
		await expect(service.refresh()).resolves.toBeUndefined();

		// The healthy task is cached; the looping task falls back to null.
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v1",
		);
		expect(service.getPrompt("should_respond")).toBeNull();
	});

	it("isolates a directory named `X.json` (EISDIR) during the legacy scan — other tasks still load", async () => {
		// Healthy task.
		await service.setPrompt("action_planner", makeArtifact(1));

		// Legacy-style task dir (no `current` symlink) where a directory is
		// named like an artifact file. The fallback scan calls readFile on it,
		// which throws EISDIR. Before the fix this rethrew out of refresh().
		const brokenDir = join(storeRoot, "response");
		mkdirSync(join(brokenDir, "v1.json"), { recursive: true });

		await expect(service.refresh()).resolves.toBeUndefined();

		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v1",
		);
		expect(service.getPrompt("response")).toBeNull();
	});
});

describe("OptimizedPromptService — concurrent setPrompt version claims (#8795)", () => {
	let storeRoot: string;
	let service: OptimizedPromptService;

	beforeEach(async () => {
		storeRoot = await mkdtemp(join(tmpdir(), "optimized-prompt-concurrent-"));
		service = createService();
		service.setStoreRoot(storeRoot);
	});

	afterEach(async () => {
		await rm(storeRoot, { recursive: true, force: true });
	});

	/**
	 * Fire N setPrompt calls concurrently against the same task dir and assert
	 * that every claimed vN.json is intact: distinct version per write, a
	 * matching valid .mac for every artifact, no clobbered/orphaned file. The
	 * Multiple artifact producers can call setPrompt, so concurrent claims for
	 * one task are a real production scenario.
	 */
	async function assertConcurrentClaimsIntact(concurrency: number) {
		// concurrency <= retention so the final count is exactly N (no pruning).
		expect(concurrency).toBeLessThanOrEqual(OPTIMIZED_PROMPT_RETAIN_VERSIONS);

		const paths = await Promise.all(
			Array.from({ length: concurrency }, (_, i) =>
				service.setPrompt("action_planner", makeArtifact(i + 1)),
			),
		);

		// Every call returned a DISTINCT version path — no two claims collided.
		const uniquePaths = new Set(paths);
		expect(uniquePaths.size).toBe(concurrency);

		const dir = join(storeRoot, "action_planner");
		const entries = await readdir(dir);
		const versionFiles = entries
			.filter((name) => /^v\d+\.json$/.test(name))
			.sort();

		// Exactly N artifacts persisted (no clobber, no loss).
		expect(versionFiles.length).toBe(concurrency);

		// Versions are the contiguous claim set v1..vN — nobody reused a slot.
		const versionNumbers = versionFiles
			.map((name) => Number.parseInt(name.slice(1, -5), 10))
			.sort((a, b) => a - b);
		expect(versionNumbers).toEqual(
			Array.from({ length: concurrency }, (_, i) => i + 1),
		);

		// Every vN.json has a matching, VALID .mac over its exact bytes — i.e.
		// no artifact was left without its sidecar and no payload/mac pair was
		// crossed by a racing rename.
		for (const name of versionFiles) {
			const artifactPath = join(dir, name);
			const macPath = `${artifactPath}.mac`;
			expect(existsSync(macPath)).toBe(true);
			const payload = await readFile(artifactPath, "utf-8");
			const macHex = (await readFile(macPath, "utf-8")).trim();
			expect(macHex).toBe(_computeOptimizedPromptMacForTest(payload));
			// Payload is intact JSON, not a half-written/empty claim file.
			const parsed = JSON.parse(payload) as { task?: string };
			expect(parsed.task).toBe("action_planner");
		}

		// No leftover .tmp- claim/rename scratch files survived.
		expect(entries.some((name) => name.includes(".tmp-"))).toBe(false);

		// `current` resolves to a real, MAC-valid artifact that loads.
		await service.refresh();
		expect(service.getPrompt("action_planner")).not.toBeNull();
	}

	it("links only complete MAC-valid versions when stale incomplete files exist", async () => {
		const dir = join(storeRoot, "action_planner");
		mkdirSync(dir, { recursive: true });

		// Simulate a crashed legacy writer: a final-looking artifact exists but
		// its MAC never landed. It must reserve the old version number without
		// becoming current/previous history.
		writeFileSync(
			join(dir, "v1.json"),
			`${JSON.stringify(makeArtifact(1), null, 2)}\n`,
			"utf-8",
		);
		writeArtifactWithMac(
			join(dir, "v2.json"),
			`${JSON.stringify(makeArtifact(2), null, 2)}\n`,
		);

		const path = await service.setPrompt("action_planner", makeArtifact(3));
		expect(path).toBe(join(dir, "v3.json"));
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v3.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v2.json",
		);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(false);

		await service.refresh();
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v3",
		);
	});

	it("does not leave a visible artifact or claim file when publishing fails after slot claim", async () => {
		const dir = join(storeRoot, "action_planner");
		mkdirSync(join(dir, "v1.json.mac"), { recursive: true });

		await expect(
			service.setPrompt("action_planner", makeArtifact(1)),
		).rejects.toThrow();

		const entries = await readdir(dir);
		expect(entries).not.toContain("v1.json");
		expect(entries.some((name) => name.includes(".tmp-"))).toBe(false);
		expect(entries.some((name) => name.endsWith(".claim"))).toBe(false);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(false);
	});

	// Run several times for stability — a claim race is nondeterministic, so a
	// single green run isn't proof. beforeEach gives each `it` a fresh dir.
	for (let run = 1; run <= 8; run += 1) {
		it(`keeps every concurrent claim intact (run ${run})`, async () => {
			await assertConcurrentClaimsIntact(OPTIMIZED_PROMPT_RETAIN_VERSIONS);
		});
	}
});

describe("OptimizedPromptService — OPTIMIZED_PROMPT_DISABLE unknown-token warning (#8795)", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("warns once for an unknown (typo'd) disable token and does not disable it", () => {
		const disabled = parseDisabledTasksEnv("should_respnose");
		// The typo disabled nothing.
		expect(disabled.size).toBe(0);

		// Exactly one warn for the one unknown token, with the documented message.
		const matching = warnSpy.mock.calls.filter(([, msg]) =>
			typeof msg === "string"
				? msg.includes('OPTIMIZED_PROMPT_DISABLE entry "should_respnose"')
				: false,
		);
		expect(matching.length).toBe(1);
	});

	it("does not disable the real task a typo was meant to name", () => {
		const service = createService();
		service.setDisabledTasksFromEnv("should_respnose");
		// `should_respond` must NOT have been disabled by the typo.
		expect(service.isTaskDisabled("should_respond")).toBe(false);
	});

	it("keeps valid tokens, warns only for the unknown ones, and ignores empties", () => {
		const disabled = parseDisabledTasksEnv(
			"should_respond, , bogus_task ,response",
		);
		expect([...disabled].sort()).toEqual(["response", "should_respond"]);

		// One warn for `bogus_task`; the empty token is silent.
		const warnings = warnSpy.mock.calls.filter(([, msg]) =>
			typeof msg === "string"
				? msg.includes("OPTIMIZED_PROMPT_DISABLE entry")
				: false,
		);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.[1]).toContain('entry "bogus_task"');
	});
});
