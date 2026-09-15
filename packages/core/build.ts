#!/usr/bin/env bun

/**
 * Builds the Node, browser, edge, and testing distributions for core while
 * keeping all compiler output confined to `dist/`. A package-wide lock avoids
 * concurrent build races over the shared output tree.
 */

import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BuildConfig, BunPlugin } from "bun";
import { resolveNpmCliInvocation } from "./scripts/npm-cli";

const execFileAsync = promisify(execFile);
const RM_RECURSIVE_SCRIPT = fileURLToPath(
	new URL("../scripts/rm-path-recursive.mjs", import.meta.url),
);
const CLEAN_SRC_ARTIFACTS_SCRIPT = fileURLToPath(
	new URL("./scripts/clean-src-artifacts.mjs", import.meta.url),
);

export interface ElizaBuildOptions {
	/** Entry points - defaults to ['src/index.ts'] */
	entrypoints?: string[];
	/** Output directory - defaults to 'dist' */
	outdir?: string;
	/** Stable source root used to derive emitted entrypoint paths. */
	root?: string;
	/** Target environment - defaults to 'node' for packages */
	target?: "node" | "bun" | "browser";
	/** External dependencies */
	external?: string[];
	/** Whether to generate sourcemaps */
	sourcemap?: boolean | "linked" | "inline" | "external";
	/** Whether to minify */
	minify?: boolean;
	/** Additional plugins */
	plugins?: BunPlugin[];
	/** Format - defaults to 'esm' */
	format?: "esm" | "cjs";
	/** Copy assets configuration */
	assets?: Array<{ from: string; to: string }>;
	/** Whether to leave existing files in place before building */
	skipClean?: boolean;
	/** Whether to generate TypeScript declarations (using tsc separately) */
	generateDts?: boolean;
	/**
	 * The name of the package being built (e.g., "@elizaos/core").
	 * When set, this package will NOT be added to externals to avoid self-referential imports.
	 */
	selfPackageName?: string;
}

/**
 * Get performance timer
 */
export function getTimer() {
	const start = performance.now();
	return {
		elapsed: () => {
			const end = performance.now();
			return (end - start).toFixed(2);
		},
		elapsedMs: () => {
			const end = performance.now();
			return Math.round(end - start);
		},
	};
}

function resolveTscBin(): string {
	const workspaceTsc = join(process.cwd(), "../../node_modules/.bin/tsc6");
	return existsSync(workspaceTsc) ? workspaceTsc : "tsc6";
}

async function withCoreBuildLock<T>(build: () => Promise<T>): Promise<T> {
	const fs = await import("node:fs/promises");
	const lockParent = join(process.cwd(), "../../.turbo");
	const lockDir = join(lockParent, "core-build.lock");
	const cleanupHelper = join(process.cwd(), "../scripts/rm-path-recursive.mjs");
	const staleAfterMs = 30 * 60 * 1000;
	let announcedWait = false;

	async function readLockOwnerPid(): Promise<number | null> {
		try {
			const rawOwner = await fs.readFile(join(lockDir, "owner"), "utf8");
			const pid = Number.parseInt(rawOwner.split(/\r?\n/, 1)[0] ?? "", 10);
			return Number.isFinite(pid) && pid > 0 ? pid : null;
		} catch {
			return null;
		}
	}

	function isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	async function removeLockDir(): Promise<void> {
		await execFileAsync("node", [cleanupHelper, lockDir], {
			cwd: process.cwd(),
		});
	}

	await fs.mkdir(lockParent, { recursive: true });

	for (;;) {
		try {
			await fs.mkdir(lockDir);
			await fs.writeFile(
				join(lockDir, "owner"),
				`${process.pid}\n${new Date().toISOString()}\n`,
			);
			break;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				throw error;
			}

			// error-policy:J3 existence probe — null means the lock dir vanished (or
			// cannot be stat'd) between the EEXIST and here; the staleness check below
			// treats a missing stat as "no owner mtime", never as a masked failure.
			const stat = await fs.stat(lockDir).catch(() => null);
			const ownerPid = await readLockOwnerPid();
			if (
				(ownerPid !== null && !isProcessAlive(ownerPid)) ||
				(stat && Date.now() - stat.mtimeMs > staleAfterMs)
			) {
				await removeLockDir();
				continue;
			}

			if (!announcedWait) {
				console.log("⏳ Waiting for another @elizaos/core build to finish...");
				announcedWait = true;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	try {
		return await build();
	} finally {
		// error-policy:J6 best-effort teardown — release the build lock dir; a failed
		// cleanup must not mask the build result (or error) propagating from the try.
		await removeLockDir().catch(() => {});
	}
}

/**
 * Creates a standardized Bun build configuration for elizaOS packages
 */
export async function createElizaBuildConfig(
	options: ElizaBuildOptions,
): Promise<BuildConfig> {
	const {
		entrypoints = ["src/index.ts"],
		outdir = "dist",
		root,
		target = "node",
		external = [],
		sourcemap = false,
		minify = false,
		plugins = [],
		format = "esm",
		selfPackageName,
	} = options;

	const resolvedEntrypoints = entrypoints
		.filter((entry) => entry && entry.trim() !== "")
		.map((entry) => (entry.startsWith("./") ? entry : `./${entry}`));

	const nodeExternals =
		target === "node" || target === "bun"
			? [
					"node:*",
					"fs",
					"path",
					"crypto",
					"stream",
					"buffer",
					"util",
					"events",
					"url",
					"http",
					"https",
					"os",
					"child_process",
					"worker_threads",
					"cluster",
					"zlib",
					"querystring",
					"string_decoder",
					"tls",
					"net",
					"dns",
					"dgram",
					"readline",
					"repl",
					"vm",
					"assert",
					"console",
					"process",
					"timers",
					"perf_hooks",
					"async_hooks",
				]
			: [];

	const elizaExternals = [
		"@elizaos/core",
		"@elizaos/cloud-routing",
		"@elizaos/shared",
		"@elizaos/plugin-*",
	].filter((pkg) => pkg !== selfPackageName);

	const cleanExternals = [...external].filter(
		(ext) => ext && !ext.startsWith("//") && ext.trim() !== "",
	);

	const config: BuildConfig = {
		entrypoints: resolvedEntrypoints,
		outdir,
		...(root ? { root } : {}),
		target: target === "node" ? "node" : target,
		format,
		sourcemap,
		minify,
		external: [...nodeExternals, ...elizaExternals, ...cleanExternals],
		plugins,
		naming: {
			entry: "[dir]/[name].[ext]",
			chunk: "[name]-[hash].[ext]",
			asset: "[name]-[hash].[ext]",
		},
	};

	return config;
}

/**
 * Copy assets after build with proper error handling (parallel processing)
 */
export async function copyAssets(assets: Array<{ from: string; to: string }>) {
	if (!assets.length) return;

	const timer = getTimer();
	const { cp } = await import("node:fs/promises");

	console.log("Copying assets...");

	// Process all assets in parallel
	const copyPromises = assets.map(async (asset) => {
		const assetTimer = getTimer();
		try {
			if (existsSync(asset.from)) {
				await cp(asset.from, asset.to, { recursive: true });
				return {
					success: true,
					message: `Copied ${asset.from} to ${asset.to} (${assetTimer.elapsed()}ms)`,
					asset,
				};
			} else {
				return {
					success: false,
					message: `Source not found: ${asset.from}`,
					asset,
					error: "Source not found",
				};
			}
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: `Failed to copy ${asset.from} to ${asset.to}: ${errorMessage}`,
				asset,
				error: errorMessage,
			};
		}
	});

	// Wait for all copies to complete
	const results = await Promise.all(copyPromises);

	// Process results
	let successCount = 0;
	const failedAssets: Array<{
		asset: { from: string; to: string };
		error: string;
	}> = [];

	results.forEach((result) => {
		if (result.success) {
			successCount++;
		} else {
			console.warn(`  ⚠ ${result.message}`);
			if (result.error) {
				// Check for specific error types
				if (result.error.includes("EACCES") || result.error.includes("EPERM")) {
					console.error(
						`    Permission denied. Try running with elevated privileges.`,
					);
				} else if (result.error.includes("ENOSPC")) {
					console.error(`    Insufficient disk space.`);
				}
				failedAssets.push({ asset: result.asset, error: result.error });
			}
		}
	});

	const totalTime = timer.elapsed();

	if (failedAssets.length === 0) {
		console.log(`✓ Assets copied (${totalTime}ms)`);
	} else if (successCount > 0) {
		console.warn(
			`⚠ Copied ${successCount}/${assets.length} assets (${totalTime}ms)`,
		);
		console.warn(
			`  Failed assets: ${failedAssets.map((f) => f.asset.from).join(", ")}`,
		);
	} else {
		throw new Error(
			`Failed to copy all assets. Errors: ${failedAssets.map((f) => `${f.asset.from}: ${f.error}`).join("; ")}`,
		);
	}
}

/**
 * Generate TypeScript declarations using tsc
 */
export async function generateDts(
	tsconfigPath = "./tsconfig.build.json",
	throwOnError = true,
) {
	const timer = getTimer();
	const { $ } = await import("bun");

	if (!existsSync(tsconfigPath)) {
		console.warn(
			`TypeScript config not found at ${tsconfigPath}, skipping d.ts generation`,
		);
		return;
	}

	console.log("Generating TypeScript declarations...");
	try {
		// Use incremental compilation for faster subsequent builds
		await $`${resolveTscBin()} --emitDeclarationOnly --noCheck --project ${tsconfigPath} --composite false --incremental false --types node,bun`;
		console.log(
			`✓ TypeScript declarations generated successfully (${timer.elapsed()}ms)`,
		);
	} catch (error: unknown) {
		console.error(
			`✗ Failed to generate TypeScript declarations (${timer.elapsed()}ms)`,
		);
		console.error(
			"Error details:",
			error instanceof Error ? error.message : String(error),
		);

		if (throwOnError) {
			// Propagate so calling build fails hard on TS errors
			throw error;
		}
		console.warn("Continuing build without TypeScript declarations...");
	}
}

/**
 * Clean build artifacts with proper error handling and retry logic
 */
export async function cleanBuild(outdir = "dist", maxRetries = 3) {
	const timer = getTimer();

	if (!existsSync(outdir)) {
		console.log(`✓ ${outdir} directory already clean (${timer.elapsed()}ms)`);
		return;
	}

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await execFileAsync("node", [RM_RECURSIVE_SCRIPT, outdir], {
				cwd: process.cwd(),
			});
			console.log(`✓ Cleaned ${outdir} directory (${timer.elapsed()}ms)`);
			return; // Success, exit the function
		} catch (error: unknown) {
			lastError = error;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			// Check for specific error types
			if (errorMessage.includes("EACCES") || errorMessage.includes("EPERM")) {
				console.error(`✗ Permission denied while cleaning ${outdir}`);
				console.error(
					`  Try running with elevated privileges or check file permissions.`,
				);
				throw error; // Don't retry permission errors
			} else if (errorMessage.includes("ENOENT")) {
				// Directory was already deleted (possibly by concurrent process)
				console.log(
					`✓ ${outdir} directory was already removed (${timer.elapsed()}ms)`,
				);
				return;
			} else if (
				errorMessage.includes("EBUSY") ||
				errorMessage.includes("EMFILE")
			) {
				// Resource busy or too many open files - these might be temporary
				if (attempt < maxRetries) {
					const waitTime = attempt * 500; // Exponential backoff: 500ms, 1000ms, 1500ms
					console.warn(
						`⚠ Failed to clean ${outdir} (attempt ${attempt}/${maxRetries}): ${errorMessage}`,
					);
					console.warn(`  Retrying in ${waitTime}ms...`);
					await new Promise((resolve) => setTimeout(resolve, waitTime));
				}
			} else {
				// Unknown error
				console.error(`✗ Failed to clean ${outdir}: ${errorMessage}`);
				throw error;
			}
		}
	}

	// If we've exhausted all retries
	const finalError =
		lastError instanceof Error ? lastError : new Error(String(lastError));
	console.error(`✗ Failed to clean ${outdir} after ${maxRetries} attempts`);
	throw finalError;
}

/**
 * Watch files for changes and trigger rebuilds with proper cleanup
 */
export function watchFiles(
	directory: string,
	onChange: () => void,
	options: {
		extensions?: string[];
		debounceMs?: number;
	} = {},
): () => void {
	const { extensions = [".ts", ".js", ".tsx", ".jsx"], debounceMs = 100 } =
		options;

	let debounceTimer: NodeJS.Timeout | null = null;
	let watcher: FSWatcher | null = null;
	let isCleanedUp = false;

	console.log(`📁 Watching ${directory} for changes...`);
	console.log("💡 Press Ctrl+C to stop\n");

	// Cleanup function to close watcher and clear timers
	const cleanup = () => {
		if (isCleanedUp) return;
		isCleanedUp = true;

		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}

		if (watcher) {
			try {
				watcher.close();
			} catch (_error) {
				// Ignore errors during cleanup
			}
			watcher = null;
		}
	};

	// Create the watcher with proper error handling
	watcher = watch(directory, { recursive: true }, (_eventType, filename) => {
		if (isCleanedUp) return;

		if (filename && extensions.some((ext) => filename.endsWith(ext))) {
			// Debounce to avoid multiple rapid rebuilds
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			debounceTimer = setTimeout(() => {
				if (!isCleanedUp) {
					console.log(`\n📝 File changed: ${filename}`);
					onChange();
				}
			}, debounceMs);
		}
	});

	// Handle watcher errors
	if (watcher && typeof watcher.on === "function") {
		watcher.on("error", (error: Error) => {
			console.error("Watch error:", error.message);
			if (error.message.includes("EMFILE")) {
				console.error(
					"Too many open files. Consider increasing your system limits or reducing the watch scope.",
				);
			}
		});
	}

	// Register cleanup handlers only once per watcher
	const handleExit = () => {
		cleanup();
		console.log("\n\n👋 Stopping watch mode...");
		process.exit(0);
	};

	// Remove any existing handlers to avoid duplicates
	process.removeAllListeners("SIGINT");
	process.removeAllListeners("SIGTERM");

	// Add new handlers
	process.once("SIGINT", handleExit);
	process.once("SIGTERM", handleExit);

	// Also cleanup on normal exit
	process.once("exit", cleanup);

	// Return cleanup function for manual cleanup
	return cleanup;
}

/**
 * Standard build runner configuration
 */
export interface BuildRunnerOptions {
	packageName: string;
	buildOptions: ElizaBuildOptions;
	onBuildComplete?: (success: boolean) => void;
}

/**
 * Run a build with optional watch mode support
 */
export async function runBuild(
	options: BuildRunnerOptions & { isRebuild?: boolean },
) {
	const {
		packageName,
		buildOptions,
		isRebuild = false,
		onBuildComplete,
	} = options;
	const totalTimer = getTimer();

	// Clear console and show timestamp for rebuilds
	if (isRebuild) {
		console.clear();
		const timestamp = new Date().toLocaleTimeString();
		console.log(`[${timestamp}] 🔄 Rebuilding ${packageName}...\n`);
	} else {
		console.log(`🚀 Building ${packageName}...\n`);
	}

	const resolvedOutdir = buildOptions.outdir ?? "dist";
	if (buildOptions.skipClean) {
		mkdirSync(resolvedOutdir, { recursive: true });
	} else {
		// Clean previous build
		await cleanBuild(resolvedOutdir);
	}

	// Bun.build does not always recreate an emptied outdir; ensure it exists after clean.
	mkdirSync(resolvedOutdir, { recursive: true });

	// Create build configuration
	const configTimer = getTimer();
	const config = await createElizaBuildConfig(buildOptions);
	console.log(`✓ Configuration prepared (${configTimer.elapsed()}ms)`);

	// Build with Bun
	console.log("\nBundling with Bun...");
	const buildTimer = getTimer();
	const result = await Bun.build(config);

	if (!result.success) {
		console.error("✗ Build failed:", result.logs);
		onBuildComplete?.(false);
		return false;
	}

	const totalSize = result.outputs.reduce(
		(sum, output) => sum + output.size,
		0,
	);
	const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
	console.log(
		`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB (${buildTimer.elapsed()}ms)`,
	);

	// Run post-build tasks
	const postBuildTasks: Promise<undefined | null>[] = [];

	// Add TypeScript declarations generation if requested
	if (buildOptions.generateDts) {
		postBuildTasks.push(
			generateDts("./tsconfig.build.json")
				.then(() => undefined)
				.catch((err) => {
					console.error("⚠ TypeScript declarations generation failed:", err);
					// Don't throw here, as it's often non-critical
					return null;
				}),
		);
	}

	// Add asset copying if specified
	if (buildOptions.assets && buildOptions.assets.length > 0) {
		postBuildTasks.push(
			copyAssets(buildOptions.assets)
				.then(() => undefined)
				.catch((err) => {
					console.error("✗ Asset copying failed:", err);
					throw err; // Asset copying failure is critical
				}),
		);
	}

	// Execute all post-build tasks
	if (postBuildTasks.length > 0) {
		const postBuildTimer = getTimer();
		await Promise.all(postBuildTasks);
		console.log(`✓ Post-build tasks completed (${postBuildTimer.elapsed()}ms)`);
	}

	console.log(`\n✅ ${packageName} build complete!`);
	console.log(`⏱️  Total build time: ${totalTimer.elapsed()}ms`);

	onBuildComplete?.(true);
	return true;
}

/**
 * Create a standardized build runner with watch mode support
 */
export function createBuildRunner(options: BuildRunnerOptions) {
	const isWatchMode = process.argv.includes("--watch");
	let cleanupWatcher: (() => void) | null = null;

	async function build(isRebuild = false) {
		return runBuild({
			...options,
			isRebuild,
		});
	}

	async function startWatchMode() {
		console.log("👀 Starting watch mode...\n");

		// Initial build
		const buildSuccess = await build(false);

		if (buildSuccess) {
			const srcDir = join(process.cwd(), "src");

			// Store the cleanup function returned by watchFiles
			// The watcher stays active throughout the entire session
			cleanupWatcher = watchFiles(srcDir, async () => {
				await build(true);
				console.log("📁 Watching src/ directory for changes...");
				console.log("💡 Press Ctrl+C to stop\n");
			});
		}
	}

	// Ensure cleanup on process exit
	const cleanup = () => {
		if (cleanupWatcher) {
			cleanupWatcher();
			cleanupWatcher = null;
		}
	};

	process.once("beforeExit", cleanup);
	process.once("SIGUSR1", cleanup);
	process.once("SIGUSR2", cleanup);

	// Return the main function to run
	return async function run() {
		if (isWatchMode) {
			await startWatchMode();
		} else {
			const success = await build();
			if (!success) {
				process.exit(1);
			}
		}
	};
}

// Source directory for TypeScript
const TS_SRC = "src";

// Ensure dist directories exist
["dist", "dist/node", "dist/browser", "dist/edge"].forEach((dir) => {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
});

// Browser-specific externals (these should be provided by the host environment)
const browserExternals = [
	// These will be loaded via CDN or bundled by the consuming app
	"sharp", // Image processing - not available in browser
	"@hapi/shot", // Test utility - not needed in browser
	"@opentelemetry/context-async-hooks", // Exclude OpenTelemetry Node modules
	"async_hooks", // Node.js built-in module
	"node:diagnostics_channel", // Node.js built-in module
	"node:async_hooks", // Node.js built-in module
	"fs-extra", // Node-only fs library; host bundlers stub this for browser/Capacitor
	// Document extractors are Node-only (mammoth uses fs.readFile.bind, unpdf
	// pulls in Node fs/util internals). Reachable from
	// features/documents/utils.ts; with `target: "node"` Bun inlines these
	// even when only used inside Node-side flows. Mark as external so the
	// host bundler resolves them only on the Node side.
	"mammoth",
	"unpdf",
	// Vercel AI SDK gateway has a transitive `@vercel/oidc` import that
	// touches `os.platform()`/`os.arch()`/`os.hostname()` at module-load
	// to build a User-Agent string. That throws in the browser even when
	// host bundlers stub `os`, because the call site uses
	// `(0, os.platform)()` after a destructured re-binding, which loses the
	// Proxy chaining. Externalise the gateway and its transitive sentinel
	// so the browser bundle never invokes the call.
	"@ai-sdk/gateway",
	"@vercel/oidc",
];

const edgeRuntimeSourcesPlugin: BunPlugin = {
	name: "eliza-core-workerd-sources",
	setup(build) {
		build.onResolve(
			{ filter: /^\.\/features\/basic-capabilities\/index(?:\.ts)?$/ },
			() => ({
				path: join(
					process.cwd(),
					"src/features/basic-capabilities/index.edge.ts",
				),
			}),
		);
		build.onResolve(
			{ filter: /^\.\/plugins\/native-features(?:\.ts)?$/ },
			() => ({
				path: join(process.cwd(), "src/plugins/native-features.edge.ts"),
			}),
		);
		build.onResolve(
			{ filter: /^\.\/mime-sniffer(?:\.ts|\.js)?$/ },
			({ importer }) =>
				importer.endsWith("/src/media/mime.ts")
					? {
							path: join(process.cwd(), "src/media/mime-sniffer.edge.ts"),
						}
					: undefined,
		);
		// mammoth/unpdf are `external` for this target, but a single-file worker
		// bundle still inlines both graphs (~2.1 MB minified) because the bare
		// specifiers survive into the artifact and every downstream bundler
		// resolves them. Aliasing the one module that imports them removes the
		// specifiers entirely, honoring the `documents: false` edge default
		// (#21327).
		build.onResolve(
			{ filter: /^\.\/parsers(?:\.ts|\.js)?$/ },
			({ importer }) =>
				importer.endsWith("/src/features/documents/utils.ts")
					? {
							path: join(
								process.cwd(),
								"src/features/documents/parsers.edge.ts",
							),
						}
					: undefined,
		);
	},
};

// Node-specific externals (native modules and node-specific packages)
const nodeExternals = ["dotenv", "sharp", "zod", "@hapi/shot"];

// Shared configuration
const sharedConfig = {
	packageName: "@elizaos/core",
	sourcemap: true,
	minify: false,
	generateDts: true,
};

/**
 * Build for Node.js environment
 */
export async function buildNode(
	runnerFactory: typeof createBuildRunner = createBuildRunner,
) {
	console.log("🔨 Building for Node.js...");
	const startTime = Date.now();

	const runNode = runnerFactory({
		...sharedConfig,
		buildOptions: {
			root: TS_SRC,
			entrypoints: [
				`${TS_SRC}/index.node.ts`,
				`${TS_SRC}/contracts/cloud-topology.ts`,
				`${TS_SRC}/contracts/first-run-options.ts`,
				`${TS_SRC}/contracts/service-routing.ts`,
				`${TS_SRC}/contracts/wallet.ts`,
				`${TS_SRC}/runtime-env.ts`,
				`${TS_SRC}/roles.ts`,
				`${TS_SRC}/client-public.ts`,
				`${TS_SRC}/security/kms/index.ts`,
				`${TS_SRC}/security/mcp-server-config.ts`,
				`${TS_SRC}/utils/atomic-json.ts`,
			],
			outdir: "dist/node",
			target: "node",
			format: "esm",
			external: nodeExternals,
			sourcemap: true,
			minify: false,
			generateDts: false, // We'll generate declarations separately for all entry points
			skipClean: true,
			selfPackageName: "@elizaos/core", // Exclude self from externals to avoid self-referential imports
		},
	});

	await runNode();
	// This leaf is shared with browser SDKs; a Node-target build injects a
	// createRequire shim even though the error contract needs no Node APIs.
	await runnerFactory({
		...sharedConfig,
		buildOptions: {
			entrypoints: [`${TS_SRC}/errors.ts`],
			outdir: "dist/node",
			target: "browser",
			format: "esm",
			sourcemap: true,
			minify: false,
			generateDts: false,
			skipClean: true,
			selfPackageName: "@elizaos/core",
		},
	})();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Node.js build complete in ${duration}s`);
}

/**
 * Build for browser environment
 */
export async function buildBrowser(
	runnerFactory: typeof createBuildRunner = createBuildRunner,
) {
	console.log("🌐 Building for Browser...");
	const startTime = Date.now();

	const runBrowser = runnerFactory({
		...sharedConfig,
		buildOptions: {
			root: TS_SRC,
			entrypoints: [
				`${TS_SRC}/index.browser.ts`,
				`${TS_SRC}/contracts/cloud-topology.ts`,
				`${TS_SRC}/contracts/first-run-options.ts`,
				`${TS_SRC}/contracts/service-routing.ts`,
				`${TS_SRC}/contracts/wallet.ts`,
				`${TS_SRC}/runtime-env.ts`,
				`${TS_SRC}/roles.ts`,
				`${TS_SRC}/client-public.ts`,
			],
			outdir: "dist/browser",
			// Use the Node target so `node:*` imports bundle without broken browser polyfills.
			// The dashboard/Vite shell still aliases `node:*` where the bundle runs in the browser.
			target: "node",
			format: "esm",
			external: browserExternals,
			sourcemap: true,
			// Bun 1.4 can emit invalid ESM for this large barrel when identifier
			// minification drops declarations that remain in the final export list.
			// App/example bundlers minify their final browser assets, so keep this
			// package artifact readable and valid.
			minify: false,
			generateDts: false, // Use the same .d.ts files from Node build
			skipClean: true,
			plugins: [],
			selfPackageName: "@elizaos/core", // Exclude self from externals to avoid self-referential imports
		},
	});

	await runBrowser();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Browser build complete in ${duration}s`);
}

/**
 * Build for edge runtimes (Vercel Edge, Cloudflare Workers, Deno Deploy)
 */
type EdgeBundleIo = {
	readFile: (path: string, encoding: "utf8") => Promise<string>;
	writeFile: (path: string, contents: string) => Promise<unknown>;
};

export async function buildEdge(
	runnerFactory: typeof createBuildRunner = createBuildRunner,
	edgeBundleIo?: EdgeBundleIo,
) {
	console.log("⚡ Building for Edge...");
	const startTime = Date.now();

	const runEdge = runnerFactory({
		...sharedConfig,
		buildOptions: {
			root: TS_SRC,
			entrypoints: [
				`${TS_SRC}/index.edge.ts`,
				`${TS_SRC}/contracts/cloud-topology.ts`,
				`${TS_SRC}/contracts/first-run-options.ts`,
				`${TS_SRC}/contracts/service-routing.ts`,
				`${TS_SRC}/contracts/wallet.ts`,
				`${TS_SRC}/runtime-env.ts`,
			],
			outdir: "dist/edge",
			// Browser targeting avoids Bun's CommonJS createRequire shim; supported
			// node:* imports remain external for Workerd's nodejs_compat runtime.
			target: "browser",
			format: "esm",
			external: [...browserExternals, "node:*"],
			sourcemap: true,
			minify: false,
			generateDts: false,
			skipClean: true,
			plugins: [edgeRuntimeSourcesPlugin],
			selfPackageName: "@elizaos/core",
		},
	});

	await runEdge();

	// Bun's CJS-interop preamble is `createRequire(import.meta.url)` at module
	// scope. workerd rejects it at import time because its module URLs are not
	// file URLs, which makes the whole edge distribution fail before any user
	// code runs. Every remaining `__require(...)` target in this bundle is a
	// node builtin, so route them through `process.getBuiltinModule` (present
	// in workerd nodejs_compat v2 and Node >= 20.16) and keep createRequire as
	// the fallback for plain Node consumers of the edge build.
	// workerd resolves imports at module load, so a single static import of a
	// Node builtin it does not ship (node:fs, node:child_process, ...) makes
	// the whole edge distribution fail before any user code runs. Rewrite every
	// static node: import into a `process.getBuiltinModule` binding: on Node
	// (>= 20.16; the repo pins 24) that returns exactly the module the import
	// would have, and on workerd available builtins resolve while unavailable
	// ones become undefined, so node-only paths fail at USE with a TypeError
	// instead of killing the import. Bun's CJS-interop preamble
	// `createRequire(import.meta.url)` gets the same guard: workerd rejects
	// non-file module URLs, and every __require target left in this bundle is
	// a builtin.
	const fsp = edgeBundleIo ?? (await import("node:fs/promises"));
	const edgeBundlePath = "dist/edge/index.edge.js";
	let edgeBundle = await fsp.readFile(edgeBundlePath, "utf8");
	const shimLine =
		"var __require = /* @__PURE__ */ createRequire(import.meta.url);";
	if (edgeBundle.includes(shimLine)) {
		const guardedLine = [
			"var __require = /* @__PURE__ */ (globalThis.process?.getBuiltinModule",
			"  ? (id) => globalThis.process.getBuiltinModule(id)",
			"  : createRequire(import.meta.url));",
		].join("\n");
		edgeBundle = edgeBundle.replace(shimLine, guardedLine);
	}
	// Deterministic line-based transform (regexes across a 6 MB bundle proved
	// easy to get subtly wrong): collect each static import statement, and when
	// its specifier is a Node builtin or fs-extra, emit the guarded binding.
	const builtin = (id: string) =>
		`globalThis.process?.getBuiltinModule?.(${JSON.stringify(id)})`;
	const rewriteImport = (statement: string): string | null => {
		const match = statement.match(
			/^import\s+(.+?)\s+from\s+"(node:[\w/]+|fs-extra)";$/s,
		);
		if (!match) return null;
		const [, clause, id] = match;
		if (id === "fs-extra") {
			const name = clause.trim();
			if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
			return `const ${name} = (() => { try { return __require("fs-extra"); } catch { return void 0; } })();`;
		}
		const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
		if (star) return `const ${star[1]} = ${builtin(id)};`;
		const braces = clause.match(/^\{([\s\S]*)\}$/);
		if (braces) {
			const destructured = braces[1]
				.split(",")
				.map((part) => part.trim().replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"))
				.filter((part) => part.length > 0)
				.join(", ");
			return `const { ${destructured} } = ${builtin(id)} ?? {};`;
		}
		if (/^[A-Za-z_$][\w$]*$/.test(clause.trim())) {
			return `const ${clause.trim()} = ${builtin(id)};`;
		}
		return null;
	};
	const outLines: string[] = [];
	const lines = edgeBundle.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/^import\s/.test(line)) {
			outLines.push(line);
			continue;
		}
		// Accumulate a full statement: imports the bundler emits always end in
		// `;` on their final line.
		let statement = line;
		let j = i;
		while (!/;\s*$/.test(statement) && j + 1 < lines.length && j - i < 40) {
			j += 1;
			statement += `\n${lines[j]}`;
		}
		const rewritten = rewriteImport(statement);
		if (rewritten !== null) {
			outLines.push(rewritten);
			i = j;
		} else {
			outLines.push(line);
		}
	}
	edgeBundle = outLines.join("\n");
	const residual = edgeBundle.match(
		/^import [^;]+ from "(?:node:[\w/]+|fs-extra)";$/m,
	);
	if (residual) {
		throw new Error(
			`edge build: unhandled static node builtin import survived the rewrite: ${residual[0]}`,
		);
	}
	await fsp.writeFile(edgeBundlePath, edgeBundle);

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Edge build complete in ${duration}s`);
}

/**
 * Build testing module (Node.js only)
 */
export async function buildTesting(
	runnerFactory: typeof createBuildRunner = createBuildRunner,
) {
	console.log("🧪 Building testing module...");
	const startTime = Date.now();

	const runTesting = runnerFactory({
		...sharedConfig,
		buildOptions: {
			root: `${TS_SRC}/testing`,
			entrypoints: [
				`${TS_SRC}/testing/index.ts`,
				`${TS_SRC}/testing/live-provider.ts`,
			],
			outdir: "dist/testing",
			target: "node",
			format: "esm",
			external: [...nodeExternals, "@elizaos/plugin-sql"],
			sourcemap: true,
			minify: false,
			generateDts: false,
			skipClean: true,
			selfPackageName: "@elizaos/core", // Exclude self from externals to avoid self-referential imports
		},
	});

	await runTesting();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Testing module build complete in ${duration}s`);
}

export async function buildNodeOnly(
	options: {
		argv?: string[];
		runnerFactory?: typeof createBuildRunner;
		generateDeclarations?: (
			options?: GenerateTypeScriptDeclarationOptions,
		) => Promise<void>;
	} = {},
) {
	console.log("🚀 Starting Node-only build process for @elizaos/core");
	const totalStart = Date.now();

	const argv = options.argv ?? process.argv;
	const runnerFactory = options.runnerFactory ?? createBuildRunner;
	const generateDeclarations =
		options.generateDeclarations ?? generateTypeScriptDeclarations;
	const skipTesting = argv.includes("--skip-testing");
	const tasks: Array<Promise<void>> = [buildNode(runnerFactory)];
	if (!skipTesting) tasks.push(buildTesting(runnerFactory));
	await Promise.all(tasks);
	await generateDeclarations({ skipTesting });

	const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
	console.log(`\n🎉 Node-only build complete in ${totalDuration}s`);
}

/**
 * Build for both targets
 */
export async function buildAll(
	options: {
		runnerFactory?: typeof createBuildRunner;
		generateDeclarations?: (
			options?: GenerateTypeScriptDeclarationOptions,
		) => Promise<void>;
		edgeBundleIo?: EdgeBundleIo;
	} = {},
) {
	console.log("🚀 Starting dual build process for @elizaos/core");
	const totalStart = Date.now();
	const runnerFactory = options.runnerFactory ?? createBuildRunner;
	const generateDeclarations =
		options.generateDeclarations ?? generateTypeScriptDeclarations;

	// Build JS in parallel first
	await Promise.all([
		buildNode(runnerFactory),
		buildBrowser(runnerFactory),
		buildEdge(runnerFactory, options.edgeBundleIo),
		buildTesting(runnerFactory),
	]);

	// Generate TypeScript declarations AFTER JS builds complete
	// This prevents race conditions where buildNode() might clean dist/node
	// after generateTypeScriptDeclarations() creates the index.d.ts file
	await generateDeclarations();

	const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
	console.log(`\n🎉 All builds complete in ${totalDuration}s`);
}

/**
 * Rewrite relative module specifiers in emitted `.d.ts` files so they carry
 * explicit `.js` extensions.
 *
 * tsc is run with `moduleResolution: "bundler"` for declarations (so internal
 * source does not need to write extensions), but that leaves barrel re-exports
 * like `export * from "./utils/state-dir"` in the emitted `.d.ts` files.
 * External consumers compiled under `moduleResolution: "nodenext"` (the
 * package's own `tsconfig.base.json` default) cannot resolve those — the
 * symbol set becomes invisible, which is why downstream packages such as
 * `@elizaos/skills` lost access to `resolveStateDir` and had to keep an inline
 * copy.
 *
 * This pass walks `dist/**\/*.d.ts`, finds relative `import`/`export`
 * specifiers, and rewrites them:
 *   - `"./foo"`        → `"./foo.js"`
 *   - `"./foo.ts"`     → `"./foo.js"`
 *   - `"./foo/index"`  → `"./foo/index.js"`
 *   - `"./foo.js"`     → unchanged
 *   - `"./foo.json"`   → unchanged (non-script asset)
 * Bare-directory specifiers (e.g. `"./foo"` where `foo/` is a directory) are
 * rewritten to `"./foo/index.js"` so NodeNext can follow them.
 */
export async function fixDtsExtensions(rootDir: string): Promise<void> {
	const path = await import("node:path");
	const fs = await import("node:fs/promises");

	const walk = async (dir: string): Promise<string[]> => {
		const out: string[] = [];
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...(await walk(full)));
			} else if (entry.isFile() && full.endsWith(".d.ts")) {
				out.push(full);
			}
		}
		return out;
	};

	// Patterns that capture `from "..."` and `import("...")` and
	// `export * from "..."` style specifiers. We rewrite only the specifier
	// content, preserving the surrounding syntax.
	const specifierRegex =
		/(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.\.?\/[^'"]+)(['"])/g;

	const rewriteSpecifier = async (
		fileDir: string,
		spec: string,
	): Promise<string> => {
		// Already has a terminal script/asset extension — leave alone.
		if (/\.(js|mjs|cjs|json)$/.test(spec)) {
			return spec;
		}
		// TypeScript source extension leaked into emitted d.ts — rewrite to .js.
		if (/\.tsx?$/.test(spec)) {
			return spec.replace(/\.tsx?$/, ".js");
		}
		// `./foo.d.ts` style — rewrite to `.js`.
		if (/\.d\.ts$/.test(spec)) {
			return spec.replace(/\.d\.ts$/, ".js");
		}
		// No extension. Prefer a sibling `.js`/`.d.ts` if one exists — TypeScript
		// resolves `utils.ts` over `utils/index.ts` when both are present, so
		// after emit we must mirror that choice. We check `.d.ts` too because
		// the runtime bundle may inline JS (so no sibling `.js` is emitted) but
		// declarations are still written per file.
		const resolved = path.resolve(fileDir, spec);
		const siblingExists = await Promise.any([
			fs.stat(`${resolved}.js`).then((s) => s.isFile()),
			fs.stat(`${resolved}.d.ts`).then((s) => s.isFile()),
		]).catch(() => false);
		if (siblingExists) {
			return `${spec}.js`;
		}
		const dirStat = await fs
			.stat(resolved)
			.then((s) => s.isDirectory())
			.catch(() => false);
		return dirStat ? `${spec}/index.js` : `${spec}.js`;
	};

	const files = await walk(rootDir);
	let rewrittenFiles = 0;
	let rewrittenSpecifiers = 0;

	const readDtsWithRetry = async (file: string): Promise<string> => {
		let last: Error | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await fs.readFile(file, "utf8");
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				last = err instanceof Error ? err : new Error(String(e));
				if (err.code === "ENOENT" && attempt < 4) {
					await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
					continue;
				}
				throw last;
			}
		}
		throw last ?? new Error(`Failed to read ${file}`);
	};

	for (const file of files) {
		const src = await readDtsWithRetry(file);
		const fileDir = path.dirname(file);
		const matches: Array<{ start: number; end: number; replacement: string }> =
			[];

		// Collect matches with indices — we rewrite in a second pass because
		// `rewriteSpecifier` is async.
		for (const m of src.matchAll(specifierRegex)) {
			const [, prefix, spec, suffix] = m;
			const matchStart = m.index;
			const newSpec = await rewriteSpecifier(fileDir, spec);
			if (newSpec === spec) continue;
			matches.push({
				start: matchStart,
				end: matchStart + prefix.length + spec.length + suffix.length,
				replacement: `${prefix}${newSpec}${suffix}`,
			});
		}

		if (matches.length === 0) continue;

		// Apply replacements right-to-left to keep earlier indices stable.
		let patched = src;
		for (let i = matches.length - 1; i >= 0; i--) {
			const { start, end, replacement } = matches[i];
			patched = patched.slice(0, start) + replacement + patched.slice(end);
		}

		await fs.writeFile(file, patched, "utf8");
		rewrittenFiles++;
		rewrittenSpecifiers += matches.length;
	}

	console.log(
		`   Rewrote ${rewrittenSpecifiers} relative specifier(s) in ${rewrittenFiles} .d.ts file(s) for NodeNext ESM`,
	);
}

type PackageExportMap = Record<string, unknown>;

export interface FlatEntrypointPlan {
	exportPath: string;
	flatFile: string;
	targetFile: string;
	moduleSpecifier: string;
}

export interface FlatEntrypointOptions {
	rootDir?: string;
	excludedExportPaths?: ReadonlySet<string>;
}

export interface GenerateTypeScriptDeclarationOptions {
	skipTesting?: boolean;
}

const RUNTIME_CONDITION_PRIORITY = [
	"default",
	"node",
	"bun",
	"import",
	"browser",
	"workerd",
] as const;

function selectRuntimeExportTarget(value: unknown): string | null {
	if (typeof value === "string") {
		return value.startsWith("./dist/") && value.endsWith(".js") ? value : null;
	}
	if (Array.isArray(value)) {
		for (const candidate of value) {
			const target = selectRuntimeExportTarget(candidate);
			if (target) return target;
		}
		return null;
	}
	if (typeof value !== "object" || value === null) return null;

	const conditions = value as Record<string, unknown>;
	for (const condition of RUNTIME_CONDITION_PRIORITY) {
		if (!Object.hasOwn(conditions, condition)) continue;
		const target = selectRuntimeExportTarget(conditions[condition]);
		if (target) return target;
	}
	for (const [condition, candidate] of Object.entries(conditions)) {
		if (
			condition === "types" ||
			condition === "eliza-source" ||
			RUNTIME_CONDITION_PRIORITY.includes(
				condition as (typeof RUNTIME_CONDITION_PRIORITY)[number],
			)
		) {
			continue;
		}
		const target = selectRuntimeExportTarget(candidate);
		if (target) return target;
	}
	return null;
}

function isTopLevelDirectoryEntrypoint(targetFile: string): boolean {
	return /^dist\/[^/]+\/index(?:\.[^/.]+)?\.js$/.test(targetFile);
}

function toModuleSpecifier(fromFile: string, targetFile: string): string {
	const pathFromEntrypoint = relative(dirname(fromFile), targetFile).replaceAll(
		"\\",
		"/",
	);
	return pathFromEntrypoint.startsWith(".")
		? pathFromEntrypoint
		: `./${pathFromEntrypoint}`;
}

/**
 * Enumerates the flat runtime artifacts required by fixed package subpaths.
 * Package conditions may be arbitrarily nested or array-backed; the selected
 * target follows the package's runtime fallback before audience-specific
 * branches. Top-level audience directories such as `./node` and `./testing`
 * deliberately retain their directory-index layout.
 */
export function planFlatEntrypoints(
	exportsMap: PackageExportMap,
	options: FlatEntrypointOptions = {},
): FlatEntrypointPlan[] {
	const excluded = options.excludedExportPaths ?? new Set<string>();
	const plans: FlatEntrypointPlan[] = [];
	for (const [exportPath, config] of Object.entries(exportsMap)) {
		if (
			!exportPath.startsWith("./") ||
			exportPath === "./package.json" ||
			exportPath.includes("*") ||
			excluded.has(exportPath)
		) {
			continue;
		}

		const target = selectRuntimeExportTarget(config);
		if (!target) continue;
		const targetFile = target.slice(2);
		if (isTopLevelDirectoryEntrypoint(targetFile)) continue;

		const flatFile = `dist/${exportPath.slice(2)}.js`;
		plans.push({
			exportPath,
			flatFile,
			targetFile,
			moduleSpecifier: toModuleSpecifier(flatFile, targetFile),
		});
	}
	return plans;
}

async function isFile(path: string): Promise<boolean> {
	const fs = await import("node:fs/promises");
	try {
		return (await fs.stat(path)).isFile();
	} catch (error) {
		// error-policy:J3 an absent generated artifact is an explicit invalid
		// result; other filesystem failures still abort the build.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function emitFlatEntrypoints(
	exportsMap: PackageExportMap,
	options: FlatEntrypointOptions = {},
): Promise<FlatEntrypointPlan[]> {
	const fs = await import("node:fs/promises");
	const rootDir = options.rootDir ?? process.cwd();
	const plans = planFlatEntrypoints(exportsMap, options);
	for (const plan of plans) {
		const target = join(rootDir, plan.targetFile);
		if (!(await isFile(target))) {
			throw new Error(
				`${plan.exportPath}: runtime target ${plan.targetFile} was not emitted`,
			);
		}
		if (plan.flatFile === plan.targetFile) continue;
		const flat = join(rootDir, plan.flatFile);
		await fs.mkdir(dirname(flat), { recursive: true });
		await fs.writeFile(
			flat,
			`// Flat ${plan.exportPath} build entrypoint\nexport * from ${JSON.stringify(plan.moduleSpecifier)};\n`,
			"utf8",
		);
	}
	return plans;
}

export async function validateFlatEntrypoints(
	plans: readonly FlatEntrypointPlan[],
	options: Pick<FlatEntrypointOptions, "rootDir"> = {},
): Promise<void> {
	const rootDir = options.rootDir ?? process.cwd();
	const missing: string[] = [];
	for (const plan of plans) {
		if (!(await isFile(join(rootDir, plan.flatFile)))) {
			missing.push(`${plan.exportPath}: ${plan.flatFile}`);
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`Missing flat entrypoints for package subpaths:\n${missing.join("\n")}`,
		);
	}
}

/**
 * Generate TypeScript declarations for all entry points
 */
export async function generateTypeScriptDeclarations(
	options: GenerateTypeScriptDeclarationOptions = {},
) {
	const fs = await import("node:fs/promises");
	const { $ } = await import("bun");

	console.log("📝 Generating TypeScript declarations...");
	const startTime = Date.now();

	// Generate TypeScript declarations using tsc
	console.log("   Compiling TypeScript declarations...");
	await $`${resolveTscBin()} --project tsconfig.declarations.json`;

	// Post-process: add `.js` extensions to all relative specifiers so external
	// consumers compiled under `moduleResolution: "nodenext"` can resolve them.
	await fixDtsExtensions("dist");

	// Ensure directories exist for conditional exports
	await fs.mkdir("dist/node", { recursive: true });
	await fs.mkdir("dist/browser", { recursive: true });
	await fs.mkdir("dist/edge", { recursive: true });

	// Create re-export files for conditional exports structure
	// dist/node/index.d.ts - points to the Node.js entry point
	// Note: Use .js extension for NodeNext module resolution compatibility
	await fs.writeFile(
		"dist/node/index.d.ts",
		`// Type definitions for @elizaos/core (Node.js)\nexport * from '../index.node.js';\n`,
	);

	// dist/browser/index.d.ts - points to the browser entry point
	await fs.writeFile(
		"dist/browser/index.d.ts",
		`// Type definitions for @elizaos/core (Browser)\nexport * from '../index.browser.js';\n`,
	);

	// dist/edge/index.d.ts - points to the edge entry point
	await fs.writeFile(
		"dist/edge/index.d.ts",
		`// Type definitions for @elizaos/core (Edge)\nexport * from '../index.edge.js';\n`,
	);
	// Keep the declaration adjacent to the runtime artifact as well. TypeScript
	// follows this file when a Workerd host resolves the compiled JS directly.
	await fs.writeFile(
		"dist/edge/index.edge.d.ts",
		`// Type definitions for @elizaos/core (Edge runtime artifact)\nexport * from '../index.edge.js';\n`,
	);

	// Create main index.js for runtime fallback (when conditional exports don't match)
	await fs.writeFile(
		"dist/index.js",
		`// Main entry point fallback for @elizaos/core\nexport * from './node/index.node.js';\n`,
	);

	// Some tooling (including Bun in certain situations) may attempt to follow the
	// "dist/index.d.ts -> ./index.node" re-export at runtime. Provide explicit JS
	// entrypoints so resolution always lands on real JS modules.
	await fs.writeFile(
		"dist/index.node.js",
		`// Node entry point (explicit)\nexport * from './node/index.node.js';\n`,
	);
	await fs.writeFile(
		"dist/index.browser.js",
		`// Browser entry point (explicit)\nexport * from './browser/index.browser.js';\n`,
	);
	await fs.writeFile(
		"dist/roles.js",
		`// Roles subpath entry point (explicit)\nexport * from './node/roles.js';\n`,
	);
	// Create main index.d.ts to re-export all types from node build
	// This ensures TypeScript resolves all exports when using moduleResolution: bundler
	// Note: Use .js extension for NodeNext module resolution compatibility
	await fs.writeFile(
		"dist/index.d.ts",
		`// Type definitions for @elizaos/core\n// Re-exports all types from the Node.js entry point\nexport * from './index.node.js';\n`,
	);

	// Ensure testing module directory and declarations exist
	await fs.mkdir("dist/testing", { recursive: true });
	const pkg = JSON.parse(await fs.readFile("package.json", "utf-8")) as {
		exports?: Record<string, unknown>;
	};
	const flatEntrypoints = await emitFlatEntrypoints(pkg.exports ?? {}, {
		excludedExportPaths: options.skipTesting
			? new Set(["./testing"])
			: undefined,
	});
	await validateFlatEntrypoints(flatEntrypoints);

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ TypeScript declarations generated in ${duration}s`);
}

/**
 * `NODE_OPTIONS` for the packed-tarball consumer processes, with the workspace
 * `--conditions=eliza-source` resolution stripped.
 *
 * Workspace lanes export that condition so source-only packages resolve to
 * `src/*.ts` (see packages/app/scripts/run-ui-playwright.mjs). It leaks into
 * every child process, including the builds those lanes prebuild. Inside this
 * verification that is wrong twice over: the packed tarball ships no `src/`, so
 * a consumer resolving `@elizaos/core/client-public` through `eliza-source`
 * dies with ERR_MODULE_NOT_FOUND, and the contract under test is precisely how
 * a published consumer resolves under DEFAULT conditions.
 */
export function packedConsumerNodeOptions(
	nodeOptions: string | undefined,
): string | undefined {
	if (!nodeOptions) return nodeOptions;
	const stripped = nodeOptions
		// `--conditions eliza-source`, `--conditions=eliza-source`, and the `-C`
		// short form, each optionally repeated.
		.replace(/(?:--conditions|-C)[=\s]+eliza-source(?=\s|$)/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length > 0 ? stripped : undefined;
}

async function verifyPackedEdgeContract(): Promise<void> {
	const fs = await import("node:fs/promises");
	const consumerNodeOptions = packedConsumerNodeOptions(
		process.env.NODE_OPTIONS,
	);
	const consumerEnv: NodeJS.ProcessEnv = { ...process.env };
	if (consumerNodeOptions === undefined) delete consumerEnv.NODE_OPTIONS;
	else consumerEnv.NODE_OPTIONS = consumerNodeOptions;
	const contractRoot = await fs.mkdtemp(
		join(tmpdir(), "eliza-core-edge-package-"),
	);
	try {
		const npmPack = resolveNpmCliInvocation([
			"pack",
			"--json",
			"--pack-destination",
			contractRoot,
			process.cwd(),
		]);
		const { stdout } = await execFileAsync(npmPack.command, npmPack.args, {
			cwd: process.cwd(),
			maxBuffer: 10 * 1024 * 1024,
		});
		const packed = JSON.parse(stdout) as Array<{ filename?: unknown }>;
		const filename = packed[0]?.filename;
		if (typeof filename !== "string") {
			throw new Error("npm pack did not report the @elizaos/core tarball");
		}

		const packageRoot = join(contractRoot, "node_modules", "@elizaos", "core");
		await fs.mkdir(packageRoot, { recursive: true });
		await execFileAsync(
			"tar",
			[
				"-xzf",
				join(contractRoot, filename),
				"-C",
				packageRoot,
				"--strip-components=1",
			],
			{ cwd: process.cwd() },
		);

		await fs.writeFile(
			join(contractRoot, "consumer.mts"),
			[
				'import { basicActions, basicCapabilities, createBasicCapabilitiesPlugin, isEdge, type Plugin } from "@elizaos/core/edge";',
				"const plugin: Plugin = createBasicCapabilitiesPlugin();",
				"void basicActions; void basicCapabilities; void isEdge; void plugin;",
				"",
			].join("\n"),
		);
		await execFileAsync(
			resolveTscBin(),
			[
				// This standalone consumer uses only the explicit compiler options below.
				"--ignoreConfig",
				"--noEmit",
				"--module",
				"NodeNext",
				"--moduleResolution",
				"NodeNext",
				"--target",
				"ES2022",
				"--skipLibCheck",
				"consumer.mts",
			],
			{ cwd: contractRoot, env: consumerEnv },
		);

		await fs.writeFile(
			join(contractRoot, "consumer.mjs"),
			[
				'import * as edge from "@elizaos/core/edge";',
				'if (edge.isEdge !== true) throw new Error("packed edge marker is missing");',
				'if (!Array.isArray(edge.basicActions) || typeof edge.createBasicCapabilitiesPlugin !== "function") throw new Error("packed basic capability runtime is missing");',
				'if ("advancedCapabilities" in edge || "pluginManager" in edge) throw new Error("packed edge runtime exposes a host-only capability");',
				"",
			].join("\n"),
		);
		await execFileAsync(process.execPath, ["consumer.mjs"], {
			cwd: contractRoot,
			env: consumerEnv,
		});
		console.log(
			"✅ Packed @elizaos/core/edge declarations and runtime import verified",
		);

		const expectedFlatFiles = [
			"dist/client-public.js",
			"dist/atomic-json.js",
			"dist/security/kms.js",
			"dist/security/mcp-server-config.js",
		];
		const errorConsumer = join(contractRoot, "browser-errors-entry.js");
		await fs.writeFile(
			errorConsumer,
			[
				'import { ElizaError, isElizaError, toElizaError } from "@elizaos/core/errors";',
				'const cause = new Error("request failed");',
				'const failure = new ElizaError("login unavailable", { code: "LOGIN_UNAVAILABLE", cause, context: { operation: "refresh" } });',
				'if (!isElizaError(failure) || failure.code !== "LOGIN_UNAVAILABLE" || failure.cause !== cause || failure.context.operation !== "refresh") throw new Error("browser error lost diagnostic context");',
				'if (toElizaError(failure) !== failure || toElizaError(cause, "LOGIN_FAILED").cause !== cause) throw new Error("browser error normalization lost identity or cause");',
			].join("\n"),
		);
		const browserErrors = await Bun.build({
			entrypoints: [errorConsumer],
			target: "browser",
			format: "iife",
			write: false,
		});
		if (!browserErrors.success) {
			throw new AggregateError(
				browserErrors.logs,
				"Packed browser error contract failed to bundle",
			);
		}
		const { runInNewContext } = await import("node:vm");
		runInNewContext(await browserErrors.outputs[0].text(), Object.create(null));
		console.log(
			"✅ Packed error contract executes without Node globals or shims",
		);
		for (const flatFile of expectedFlatFiles) {
			if (!(await isFile(join(packageRoot, flatFile)))) {
				throw new Error(`packed @elizaos/core is missing ${flatFile}`);
			}
		}

		await fs.writeFile(
			join(contractRoot, "node-flat-consumer.mjs"),
			[
				'import * as packageSubpath from "@elizaos/core/client-public";',
				'import * as flatArtifact from "./node_modules/@elizaos/core/dist/client-public.js";',
				'for (const name of ["formatError", "isTruthyEnvValue", "resolveAliasedEnvValue", "sanitizeForSettingsDebug", "sanitizeSpeechText"]) {',
				'  if (typeof packageSubpath[name] !== "function") throw new Error("package subpath is missing " + name);',
				'  if (packageSubpath[name] !== flatArtifact[name]) throw new Error("flat artifact diverges for " + name);',
				"}",
				'if (!packageSubpath.isTruthyEnvValue("yes")) throw new Error("node subpath did not execute");',
				"",
			].join("\n"),
			"utf8",
		);
		await execFileAsync("node", ["node-flat-consumer.mjs"], {
			cwd: contractRoot,
			env: consumerEnv,
		});

		const viteCli = join(
			process.cwd(),
			"../../node_modules/@elizaos/vitest-vite/bin/vite.js",
		);
		for (const mode of ["package-browser", "flat-alias"] as const) {
			const consumerRoot = join(contractRoot, mode);
			await fs.mkdir(consumerRoot, { recursive: true });
			await fs.writeFile(
				join(consumerRoot, "node-module-browser.js"),
				[
					"export function createRequire() {",
					'  return () => { throw new Error("browser consumer called createRequire"); };',
					"}",
					"",
				].join("\n"),
				"utf8",
			);
			await fs.writeFile(
				join(consumerRoot, "entry.js"),
				[
					'import { isTruthyEnvValue, sanitizeSpeechText } from "@elizaos/core/client-public";',
					'if (!isTruthyEnvValue("yes")) throw new Error("browser consumer helper did not execute");',
					'if (sanitizeSpeechText(" hello ") !== "hello") throw new Error("browser consumer speech helper diverged");',
					"export const verified = true;",
					"",
				].join("\n"),
				"utf8",
			);
			const aliases = [
				`{ find: "node:module", replacement: ${JSON.stringify(join(consumerRoot, "node-module-browser.js"))} }`,
			];
			if (mode === "flat-alias") {
				aliases.push(
					`{ find: "@elizaos/core/client-public", replacement: ${JSON.stringify(join(packageRoot, "dist/client-public.js"))} }`,
				);
			}
			await fs.writeFile(
				join(consumerRoot, "vite.config.mjs"),
				[
					"export default {",
					`  resolve: { alias: [${aliases.join(", ")}] },`,
					'  build: { outDir: "dist", emptyOutDir: true, lib: { entry: "entry.js", formats: ["es"], fileName: () => "bundle.js" } },',
					'  logLevel: "error",',
					"};",
					"",
				].join("\n"),
				"utf8",
			);
			await execFileAsync(
				"node",
				[viteCli, "build", "--config", "vite.config.mjs"],
				{ cwd: consumerRoot, env: consumerEnv },
			);
			await execFileAsync("node", ["dist/bundle.js"], {
				cwd: consumerRoot,
				env: consumerEnv,
			});
		}
		console.log(
			"✅ Packed Node, browser-condition, and exact-flat Vite consumers verified",
		);
	} finally {
		await execFileAsync("node", [RM_RECURSIVE_SCRIPT, contractRoot], {
			cwd: process.cwd(),
		});
	}
}

if (import.meta.main) {
	const isNodeOnly = process.argv.includes("--node-only");
	const isEdgeOnly = process.argv.includes("--edge-only");
	const isWatch = process.argv.includes("--watch");
	if (isNodeOnly && isEdgeOnly) {
		throw new Error("Choose either --node-only or --edge-only, not both");
	}
	const build = isEdgeOnly ? buildEdge : isNodeOnly ? buildNodeOnly : buildAll;

	withCoreBuildLock(async () => {
		await execFileAsync("node", [CLEAN_SRC_ARTIFACTS_SCRIPT]);
		await build();
		if (!isNodeOnly && !isWatch) await verifyPackedEdgeContract();
		await execFileAsync("node", [CLEAN_SRC_ARTIFACTS_SCRIPT, "--check"]);
	}).catch((error) => {
		console.error("Build script error:", error);
		process.exit(1);
	});
}
