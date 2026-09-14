/**
 * Discovers and executes test scripts across every elizaOS workspace package.
 * Filters, lanes, and deterministic shards share one live plan; required lanes
 * bind green status to reconciled Bun or Vitest testcase evidence.
 *
 * Lane / shard / filter knobs are honoured via a mix of CLI flags and
 * env vars so CI matrices can drive sharding deterministically:
 *
 *   TEST_LANE=pr (default)
 *     Secret-free deterministic lane. Sets VITEST_EXCLUDE_REAL_E2E=1,
 *     VITEST_EXCLUDE_REAL=1, and ELIZA_LIVE_TEST=0 by default so package
 *     vitest configs can drop *.real.e2e.test.ts and *.real.test.ts files
 *     and live-gated suites stay disabled. Provider API keys are not required.
 *
 *   TEST_LANE=post-merge
 *     Real APIs everywhere. No exclusions. Warns when
 *     scripts/post-merge-secrets.txt entries are missing.
 *
 *   TEST_SHARD=N/M
 *     Deterministic shard membership. Each task's relative package dir
 *     is SHA-1 hashed; tasks where (hash % M) === (N - 1) run on this
 *     shard (1-indexed N).
 *
 *   --no-cloud
 *     Skip cloud package tasks and the cloud test step at the end.
 *
 *   --filter=<regex>
 *     Match against `<packageName> (<relativeDir>)#<scriptName>`.
 *     Combines (intersects) with --pattern and TEST_PACKAGE_FILTER env.
 *
 *   --pattern=<regex>
 *     Same surface as --filter; both must match when both are passed.
 *
 *   --only=e2e | test
 *     Sets VITEST_E2E_ONLY=1 / VITEST_UNIT_ONLY=1 so vitest configs
 *     that consume those env vars can flip include/exclude patterns.
 *     For packages whose `test` script is a single `vitest run` we
 *     also append a path filter via VITEST_TEST_PATH_PATTERN.
 *
 *   --all
 *     Explicitly run unit + integration + E2E package scripts. This is the
 *     default when --only is not set; the flag exists so package.json scripts
 *     can state the lane intent without leaving an ignored argument behind.
 *
 *   --exclude=<path>
 *     Mark a repo-relative test path as excluded from this lane. Exclusions
 *     are forwarded to single-vitest package scripts and exported via
 *     VITEST_TEST_EXCLUDE_PATHS for package configs/wrappers.
 *
 *   --concurrency=<n>   (env: TEST_CONCURRENCY)
 *     Run the parallel-safe `test` tasks through an n-worker pool instead of
 *     strictly serially. Only the secret-free pr lane is parallelised (minus
 *     the shared-database packages in test-task-pool.mjs); the e2e/integration
 *     lanes and any post-merge lane always serialize. Default 1 preserves the
 *     historical fully-serial behaviour, so existing callers are unaffected.
 *
 *   --plan[=text|json]
 *     Discover and print the test plan without spawning package tests or
 *     preparing local services. This is the audit/inventory path for #10200.
 *
 * Companion env knobs (legacy, still honoured):
 *   TEST_PACKAGE_FILTER  — same surface as --filter
 *   TEST_SCRIPT_FILTER   — regex over script name (test, test:e2e, ...)
 *   TEST_START_AT        — resume a suite from the first matching label
 *
 * Result contract (#16994): every resolved task produces exactly one
 * machine-readable result record (identity, pass/skip/fail status, exit code /
 * signal / timeout, duration, and reconciled testcase counts when the command
 * is a recognised runner). Designed exclusions are recorded as explicit
 * `excluded` entries so they can never be mistaken for passes. The full ledger
 * is written to ELIZA_TEST_RESULTS_FILE (JSON) when that env var is set, and a
 * one-line `[eliza-test] RESULT {...}` is printed per task. A green run with a
 * missing or duplicate record is a protocol violation and exits 3. A fail-fast
 * run records every unreached task as `not-run`, an interrupted run flushes
 * the partial ledger with `interrupted`, and the optional cloud stage lands in
 * the artifact (pass/fail/excluded) before the file is finalized.
 * TEST_TASK_TIMEOUT_MS (0 = off) bounds each child, the cloud stage included;
 * a timed-out child is a failure, never a skip.
 *
 * See `.env.test.example` and `packages/scripts/test-env.mjs` for live env setup.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCapturedTestOutput,
  createCapturedTestOutput,
  formatCapturedTestOutput,
  retainedCapturedTestOutput,
} from "./lib/captured-test-output.mjs";
import { MAX_JUNIT_BYTES, parseJunitSummary } from "./lib/junit-summary.mjs";
import {
  computeRealLiveAccounting,
  diffRealLiveManifest,
  discoverGuardedRealLiveFiles,
  formatRealLiveSummaryLines,
} from "./lib/real-live-suites.mjs";
import { resolveTestLaneDirs } from "./lib/script-metadata.mjs";
import {
  isParallelSafeTask,
  parseShardSpec,
  partitionTasks,
  resolveConcurrency,
  runPool,
  taskBelongsToShard,
} from "./lib/test-task-pool.mjs";
import { expandWorkspaceGlobs, listWorkspaceDirs } from "./lib/workspaces.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const bunCmd = process.env.npm_execpath || process.env.BUN || "bun";

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function parseFlag(name) {
  const idx = argv.indexOf(name);
  if (idx !== -1) {
    argv.splice(idx, 1);
    return true;
  }
  return false;
}

function parseFlagValue(prefix) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === prefix) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        throw new Error(`${prefix} requires a value`);
      }
      const value = argv[i + 1];
      argv.splice(i, 2);
      return value;
    }
    if (arg.startsWith(`${prefix}=`)) {
      const value = arg.slice(prefix.length + 1);
      if (!value) {
        throw new Error(`${prefix} requires a value`);
      }
      argv.splice(i, 1);
      return value;
    }
  }
  return null;
}

function parseRepeatedFlagValue(prefix) {
  const values = [];
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === prefix) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        throw new Error(`${prefix} requires a value`);
      }
      values.push(argv[i + 1]);
      argv.splice(i, 2);
      continue;
    }
    if (arg.startsWith(`${prefix}=`)) {
      const value = arg.slice(prefix.length + 1);
      if (!value) {
        throw new Error(`${prefix} requires a value`);
      }
      values.push(value);
      argv.splice(i, 1);
      continue;
    }
    i++;
  }
  return values;
}

function failUsage(message) {
  console.error(`[eliza-test] ERROR ${message}`);
  console.error("Run with --help for usage.");
  process.exit(2);
}

const noCloud = parseFlag("--no-cloud");
const requireWorkFlag = parseFlag("--require-work");
const helpFlag = parseFlag("--help") || parseFlag("-h");
const barePlanFlag = parseFlag("--plan");
let filterFlag;
let patternFlag;
let onlyFlag;
let laneFilterFlag;
let excludeFlags;
let concurrencyFlag;
let concurrency;
let planFlag;
try {
  filterFlag = parseFlagValue("--filter");
  patternFlag = parseFlagValue("--pattern");
  onlyFlag = parseFlagValue("--only"); // "e2e" | "test"
  laneFilterFlag = parseFlagValue("--lane"); // "server" | "client" | …
  excludeFlags = parseRepeatedFlagValue("--exclude");
  concurrencyFlag = parseFlagValue("--concurrency");
  planFlag = parseFlagValue("--plan");
} catch (error) {
  // error-policy:J1 CLI parsing failures become a bounded usage error.
  failUsage(error.message);
}

// `--min-tasks=<n>` / MIN_TEST_TASKS — the numeric ancestor of
// `--require-work` — is retired (#17070). A numeric collection floor is a
// historical-count baseline: it fails a lane because a task count changed, not
// because a source contract broke. The boolean `--require-work` guards remain
// the vacuous-green protection; a caller still passing the retired flag fails
// closed at argv parse (unknown argument, exit 2).
const requireWork = requireWorkFlag;

// Per-child wall-clock bound. 0 disables (the historical behaviour and the
// default — no caller is armed implicitly). A caller that sets it turns a hung
// child into a recorded timeout failure instead of an unobserved cancellation
// at the job level.
const taskTimeoutRaw = process.env.TEST_TASK_TIMEOUT_MS ?? "0";
const taskTimeoutMs = /^\d+$/.test(taskTimeoutRaw)
  ? Number(taskTimeoutRaw)
  : Number.NaN;
if (!Number.isSafeInteger(taskTimeoutMs)) {
  failUsage(
    `TEST_TASK_TIMEOUT_MS must be a non-negative integer of milliseconds, got "${taskTimeoutRaw}"`,
  );
}

// Deterministic fault injection for the result-ledger protocol tests. The
// exactly-once invariants (no duplicate, no missing record) cannot be violated
// from outside the process, so the fault-injection suite flips them here.
const faultInject = process.env.ELIZA_TEST_FAULT_INJECT || "";

// A named root lane (`--lane server`) resolves the anchored package filter it
// used to hardcode as a `TEST_PACKAGE_FILTER` regex in the root package.json:
// membership is declared per-package via `elizaos.scripts.testLanes`, so adding
// or removing a package to a lane is a package.json edit, not a script edit
// (#12334). The `(<dir>)` anchor matches the task label `<name> (<dir>)#<script>`.
function laneFilterRegex(lane) {
  const dirs = resolveTestLaneDirs(lane, { repoRoot });
  if (dirs.length === 0) {
    failUsage(
      `--lane "${lane}" resolved no packages; declare elizaos.scripts.testLanes on the lane's members`,
    );
  }
  const escaped = dirs.map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `\\((?:${escaped.join("|")})\\)`;
}
const allFlag = parseFlag("--all");
const planEnabled = planFlag !== null || barePlanFlag;
const planFormat = planFlag || "text";

if (helpFlag) {
  process.stdout.write(
    [
      "Usage: node packages/scripts/run-all-tests.mjs [options]",
      "",
      "Options:",
      "  --no-cloud           Skip cloud package tasks and the final cloud test step.",
      "  --filter=<regex>     Filter package tasks by `<name> (<dir>)#<script>`.",
      "  --pattern=<regex>    Same surface as --filter; combined via intersection.",
      "  --only=e2e | test    Forward VITEST_E2E_ONLY / VITEST_UNIT_ONLY env to children.",
      "  --lane=<name>        Restrict to packages tagged elizaos.scripts.testLanes=<name>.",
      "  --all                Explicitly run every discovered test lane (default without --only).",
      "  --exclude=<path>     Exclude a repo-relative test path from this lane.",
      "  --concurrency=<n>    Run parallel-safe `test` tasks through an n-worker",
      "                       pool (pr lane only; default 1 = fully serial).",
      "  --plan[=text|json]   Print the discovered test plan without running it.",
      "  --require-work       Fail (exit 3) when no runnable task is selected,",
      "                       a shard owns no task, or no reconciled testcase runs.",
      "",
      "Env vars:",
      "  TEST_LANE=pr|post-merge        Lane select (default: pr).",
      "  TEST_CONCURRENCY=<n>           Same as --concurrency (default 1).",
      "  TEST_SHARD=N/M                  1-indexed shard out of M total.",
      "  TEST_PACKAGE_FILTER=<regex>     Equivalent to --filter (legacy).",
      "  TEST_SCRIPT_FILTER=<regex>      Filter by script name.",
      "  TEST_START_AT=<substring>       Skip until first matching label.",
      "",
      "See `.env.test.example` for deterministic PR and live lane env setup.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (allFlag && onlyFlag) {
  failUsage("--all cannot be combined with --only");
}
if (onlyFlag && !["e2e", "test"].includes(onlyFlag)) {
  failUsage(`--only must be "e2e" or "test", got "${onlyFlag}"`);
}
if (!["text", "json"].includes(planFormat)) {
  failUsage(`--plan must be "text" or "json", got "${planFormat}"`);
}

if (argv.length > 0) {
  failUsage(`unknown argument(s): ${argv.join(" ")}`);
}

try {
  concurrency = resolveConcurrency(
    concurrencyFlag,
    process.env.TEST_CONCURRENCY,
  );
} catch (error) {
  // error-policy:J1 CLI and environment validation share the exit-2 boundary.
  failUsage(error.message);
}

// ---------------------------------------------------------------------------
// Environment / lane configuration
// ---------------------------------------------------------------------------

const TEST_LANE = process.env.TEST_LANE || "pr"; // "pr" | "post-merge"
const TEST_SHARD = process.env.TEST_SHARD || ""; // "N/M"

// Parse TEST_SHARD into { index, total } or null (parseShardSpec is pure; warn
// here when a non-empty spec is malformed).
const shardConfig = parseShardSpec(TEST_SHARD);
if (TEST_SHARD && !shardConfig) {
  console.warn(
    `[eliza-test] WARN invalid TEST_SHARD "${TEST_SHARD}" — expected N/M (1-indexed). Ignoring.`,
  );
}

// ---------------------------------------------------------------------------
// Startup-time validation
// ---------------------------------------------------------------------------

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const POST_MERGE_SECRETS_PATH = path.join(here, "post-merge-secrets.txt");

function loadPostMergeSecrets() {
  if (!fs.existsSync(POST_MERGE_SECRETS_PATH)) return [];
  return fs
    .readFileSync(POST_MERGE_SECRETS_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

if (TEST_LANE === "pr") {
  // PR/default runs are expected to be secret-free. Live-provider coverage
  // belongs to TEST_LANE=post-merge or the dedicated live workflows.
} else if (TEST_LANE === "post-merge") {
  const secrets = loadPostMergeSecrets();
  const missing = secrets.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(
      `${YELLOW}[eliza-test] WARN TEST_LANE=post-merge — missing env vars:\n  ${missing.join("\n  ")}${RESET}`,
    );
  }

  // #9310 §E: loud, named accounting of every guarded *.real/*.live suite.
  // A missing credential is a counted named skip printed on EVERY post-merge
  // run — never a silent green nothing. The manifest is enforced against the
  // on-disk guarded set here so it can't drift quietly.
  const guardedOnDisk = discoverGuardedRealLiveFiles(repoRoot);
  const drift = diffRealLiveManifest(guardedOnDisk);
  if (drift.unlisted.length > 0 || drift.stale.length > 0) {
    console.error(
      `[eliza-test] FAIL real/live suite manifest drift (packages/scripts/lib/real-live-suites.mjs):` +
        (drift.unlisted.length > 0
          ? `\n  guarded on disk but not in manifest:\n    ${drift.unlisted.join("\n    ")}`
          : "") +
        (drift.stale.length > 0
          ? `\n  in manifest but no longer guarded on disk:\n    ${drift.stale.join("\n    ")}`
          : ""),
    );
    process.exit(1);
  }
  for (const line of formatRealLiveSummaryLines(
    computeRealLiveAccounting(process.env),
  )) {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Constants (from original)
// ---------------------------------------------------------------------------

const EXTRA_SCRIPT_NAMES = [
  "test:integration",
  "test:e2e",
  "test:playwright",
  "test:ui",
  "test:live",
];
const NO_TEST_OUTPUT_PATTERNS = [
  /No test files found/i,
  /No tests found/i,
  // `bun test <dir>` exits non-zero with this message when a path filter
  // matches no *.test/*.spec files. Treat it as "no tests" (skip), matching
  // how vitest's --passWithNoTests packages are handled.
  /did not match any test files/i,
];
// Genuine test/run FAILURE signals. When a non-zero child exit carries any of
// these, the run really failed even if the SAME buffer also contains a
// "No test files found" line — e.g. a multi-project vitest / `bun test` run
// where one project has no files (emits the no-tests banner) while a sibling
// project has a red test (emits a failure line). Without this guard the
// no-tests substring scan below would swallow that failure as SKIP=green
// (#13620 task 4). We only skip-as-no-tests when NO failure signal is present.
const TEST_FAILURE_OUTPUT_PATTERNS = [
  // vitest summary lines: `Tests  1 failed | 2 passed`, `Test Files  1 failed`.
  /\bTests?\s+Files?\b[^\n]*\bfailed\b/i,
  /\bTests?\b[^\n]*\bfailed\b/i,
  // vitest per-file / per-test markers: a line beginning with `FAIL ` or the
  // `× ` / ` ✗ ` fail glyphs it prints for a failing case.
  /(^|\n)\s*FAIL\s/,
  /(^|\n)\s*(?:×|✗)\s/,
  // `N failed` / `N test(s) failed` (vitest & generic runners).
  /\b\d+\s+(?:tests?\s+)?failed\b/i,
  // bun test: `N fail` in the summary and the per-assertion `(fail)` marker.
  /\b\d+\s+fail\b/i,
  /\(fail\)/i,
];
// NOTE: deliberately NOT matching a bare `error:` / `exited with code` line.
// A benign no-tests lane run through `bun run test` still exits non-zero and
// Bun appends `error: script "test" exited with code 1` — matching that would
// wrongly withhold the skip for the exact empty-lane case this must preserve.
// The specific per-test/per-suite failure markers above are sufficient and do
// not appear in a graceful "No test files found" run.
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[tj]sx?$/;
const TEST_FILE_SKIP_DIRS = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const ADDITIONAL_PACKAGE_DIRS = [
  path.join(repoRoot, "packages", "app-core", "platforms", "electrobun"),
];
const NO_CLOUD_PACKAGE_DIRS = new Set([path.join("packages", "cloud", "e2e")]);
const ROOT_PR_E2E_EXCLUDED_PACKAGE_DIRS = new Set([
  path.join("packages", "homepage"),
]);

// Combine --filter, --pattern, --lane, and TEST_PACKAGE_FILTER. All (when set)
// must match a task's label for it to run — they intersect rather than override
// each other so callers can stack a package filter (--filter) and a per-test
// filter (--pattern) on top of one another. `--lane` resolves to the same
// `(<dir>)`-anchored regex the lane used to hardcode in the root package.json.
const packageFilters = [
  filterFlag,
  patternFlag,
  laneFilterFlag ? laneFilterRegex(laneFilterFlag) : null,
  process.env.TEST_PACKAGE_FILTER,
]
  .filter((value) => typeof value === "string" && value.length > 0)
  .map((value) => new RegExp(value));

const scriptFilter = process.env.TEST_SCRIPT_FILTER
  ? new RegExp(process.env.TEST_SCRIPT_FILTER)
  : null;
const startAt = process.env.TEST_START_AT?.trim() || "";
const DEFAULT_POSTGRES_URL =
  "postgresql://eliza_test:test123@localhost:5432/eliza_test";
const POSTGRES_INIT_SQL_PATH = path.join(
  repoRoot,
  "plugins",
  "plugin-sql",
  "scripts",
  "init-test-db.sql",
);

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

function collectPackageJsonPaths() {
  // Whole-subtree exclusion keeps explicitly negated workspace roots and their
  // nested packages out of the shared test lane. Package managers exclude only
  // the exact negated directory, so this caller-level filter preserves the
  // stronger repository test-boundary contract.
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const patterns = rootPackageJson.workspaces ?? [];
  const excludedRoots = new Set(
    patterns
      .filter((pattern) => pattern.startsWith("!"))
      .flatMap((pattern) =>
        expandWorkspaceGlobs([pattern.slice(1)], { repoRoot }),
      ),
  );
  const inExcludedSubtree = (relDir) => {
    for (const excluded of excludedRoots) {
      if (relDir === excluded || relDir.startsWith(`${excluded}/`)) return true;
    }
    return false;
  };

  const packageJsonPaths = new Set();
  for (const relDir of listWorkspaceDirs({ repoRoot })) {
    if (inExcludedSubtree(relDir)) continue;
    packageJsonPaths.add(path.join(repoRoot, relDir, "package.json"));
  }

  for (const packageDir of ADDITIONAL_PACKAGE_DIRS) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      packageJsonPaths.add(packageJsonPath);
    }
  }

  return [...packageJsonPaths].sort((left, right) => left.localeCompare(right));
}

// ---------------------------------------------------------------------------
// Script resolution (unchanged from original)
// ---------------------------------------------------------------------------

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveScriptCommand(scriptName, scripts, seen = new Set()) {
  const raw = normalizeWhitespace(scripts?.[scriptName] ?? "");
  if (!raw) {
    return "";
  }
  if (seen.has(scriptName)) {
    return raw;
  }
  seen.add(scriptName);

  const aliasMatch = raw.match(
    /^(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)$/,
  );
  if (aliasMatch?.[1] && scripts?.[aliasMatch[1]]) {
    return resolveScriptCommand(aliasMatch[1], scripts, seen);
  }

  return raw;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });

  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ...result,
    combinedOutput,
  };
}

function resetPostgresDatabase() {
  const terminateResult = runCommand("psql", [
    "postgres",
    "-c",
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'eliza_test' AND pid <> pg_backend_pid()",
  ]);
  if (terminateResult.status !== 0) {
    throw new Error(
      terminateResult.combinedOutput ||
        "failed to terminate active PostgreSQL test connections",
    );
  }

  const dropResult = runCommand("dropdb", ["--if-exists", "eliza_test"]);
  if (dropResult.status !== 0) {
    throw new Error(
      dropResult.combinedOutput ||
        "failed to drop local PostgreSQL test database",
    );
  }

  const createResult = runCommand("createdb", ["eliza_test"]);
  if (createResult.status !== 0) {
    throw new Error(
      createResult.combinedOutput ||
        "failed to recreate local PostgreSQL test database",
    );
  }
}

function ensurePluginSqlPostgresEnv() {
  if (process.env.POSTGRES_URL?.trim()) {
    return;
  }

  if (!fs.existsSync(POSTGRES_INIT_SQL_PATH)) {
    return;
  }

  const pingResult = runCommand("psql", ["postgres", "-Atc", "SELECT 1"]);
  if (pingResult.status !== 0) {
    console.warn(
      "[eliza-test] WARN local PostgreSQL unavailable; plugin-sql Postgres-only suites will remain skipped",
    );
    return;
  }

  try {
    resetPostgresDatabase();
    const initResult = runCommand("psql", [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "eliza_test",
      "-f",
      POSTGRES_INIT_SQL_PATH,
    ]);
    if (initResult.status !== 0) {
      throw new Error(
        initResult.combinedOutput ||
          "failed to initialize local PostgreSQL test database",
      );
    }
    process.env.POSTGRES_URL = DEFAULT_POSTGRES_URL;
    console.log(
      `[eliza-test] INFO using PostgreSQL test database at ${DEFAULT_POSTGRES_URL}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[eliza-test] WARN failed to prepare local PostgreSQL test database; plugin-sql Postgres-only suites may be skipped (${message})`,
    );
  }
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRepoPath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function scriptReferencesScript(command, scriptName) {
  if (!command) {
    return false;
  }
  const escapedName = escapeForRegex(scriptName);
  const referencePattern = new RegExp(
    `(?:^|[;&|]\\s*|&&\\s*|\\|\\|\\s*)(?:bun|npm|pnpm|yarn)(?:\\s+run)?\\s+${escapedName}(?:\\s|$)`,
  );
  return referencePattern.test(command);
}

function getReferencedScriptNames(command, scripts) {
  if (!command) {
    return [];
  }

  const matches = [];
  const invocationPattern =
    /(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g;
  for (const match of command.matchAll(invocationPattern)) {
    const scriptName = match[1];
    if (scriptName && scripts?.[scriptName]) {
      matches.push(scriptName);
    }
  }
  return matches;
}

function scriptInvokesScript(
  entryScriptName,
  targetScriptName,
  scripts,
  seen = new Set(),
) {
  if (entryScriptName === targetScriptName) {
    return true;
  }
  if (seen.has(entryScriptName)) {
    return false;
  }
  seen.add(entryScriptName);

  const command = normalizeWhitespace(scripts?.[entryScriptName] ?? "");
  if (!command) {
    return false;
  }
  if (scriptReferencesScript(command, targetScriptName)) {
    return true;
  }

  for (const referencedScriptName of getReferencedScriptNames(
    command,
    scripts,
  )) {
    if (
      referencedScriptName !== entryScriptName &&
      scriptInvokesScript(referencedScriptName, targetScriptName, scripts, seen)
    ) {
      return true;
    }
  }

  return false;
}

function collectScriptsToRun(scripts) {
  const scriptNames = [];
  const seenCommands = new Set();

  if (scripts.test && onlyFlag !== "e2e") {
    const resolvedTestCommand =
      resolveScriptCommand("test", scripts) ||
      normalizeWhitespace(scripts.test);
    scriptNames.push("test");
    if (resolvedTestCommand) {
      seenCommands.add(resolvedTestCommand);
    }
  }

  if (onlyFlag === "test") {
    return scriptNames;
  }

  for (const scriptName of EXTRA_SCRIPT_NAMES) {
    const raw = normalizeWhitespace(scripts[scriptName] ?? "");
    if (!raw) {
      continue;
    }

    if (scriptInvokesScript("test", scriptName, scripts)) {
      continue;
    }

    const resolved = resolveScriptCommand(scriptName, scripts) || raw;
    if (seenCommands.has(resolved)) {
      continue;
    }

    scriptNames.push(scriptName);
    seenCommands.add(resolved);
  }

  return scriptNames;
}

function outputIndicatesNoTests(output) {
  return NO_TEST_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

function outputIndicatesTestFailure(output) {
  return TEST_FAILURE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

// A non-zero child exit may be reclassified as a benign "no tests" skip only
// when the command is a single skippable runner invocation, its output carries
// a no-tests banner, AND that output shows NO genuine failure signal. The last
// clause is what stops a multi-project run (one empty project + one failing
// test in the same merged buffer) from being swallowed as SKIP=green (#13620).
function shouldSkipAsNoTests(output) {
  return outputIndicatesNoTests(output) && !outputIndicatesTestFailure(output);
}

function hasLocalTestFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (TEST_FILE_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (hasLocalTestFiles(path.join(dir, entry.name))) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      return true;
    }
  }

  return false;
}

function isSingleVitestRunCommand(command) {
  const commandWithoutEnv = stripLeadingEnvAssignments(command);
  if (/[;&|]/.test(commandWithoutEnv)) {
    return false;
  }
  return (
    /^(?:(?:bunx|npx)\s+)?vitest\s+run\b/.test(commandWithoutEnv) ||
    /^bun\s+x\s+vitest\s+run\b/.test(commandWithoutEnv)
  );
}

function isSingleVitestWrapperCommand(command) {
  const commandWithoutEnv = stripLeadingEnvAssignments(command);
  if (/[;&|]/.test(commandWithoutEnv)) {
    return false;
  }
  return /^node\s+(?:\.\.\/)+scripts\/run-vitest\.mjs\s+run\b/.test(
    commandWithoutEnv,
  );
}

function isSingleVitestBatchWrapperCommand(command) {
  // The agent's mobile-entry preflight must succeed before its final batch
  // runner receives the JUnit arguments appended to the package command.
  return /^(?:bun\s+run\s+test:mobile-workspace-entry\s+&&\s+)?node\s+scripts\/run-vitest-batches\.mjs$/.test(
    stripLeadingEnvAssignments(command),
  );
}

function stripLeadingEnvAssignments(command) {
  return command.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/,
    "",
  );
}

function isSingleBunTestCommand(command) {
  const commandWithoutEnv = stripLeadingEnvAssignments(command);
  if (/[;&|]/.test(commandWithoutEnv)) {
    return false;
  }
  return /^bun\s+test\b/.test(commandWithoutEnv);
}

function unwrapKnownBunTestSupervisors(command) {
  let current = stripLeadingEnvAssignments(command);
  for (let depth = 0; depth < 3; depth += 1) {
    const flakeRetry = current.match(
      /^node\s+(?:\.\.\/)+packages\/scripts\/run-with-flake-retry\.mjs\s+(?:'[^']*'|"[^"]*"|\S+)\s+--\s+(.+)$/,
    );
    if (flakeRetry) {
      current = flakeRetry[1];
      continue;
    }
    const deadline = current.match(
      /^node\s+(?:\.\.\/)+packages\/scripts\/run-with-deadline\.mjs\s+[1-9]\d*\s+--\s+(.+)$/,
    );
    if (deadline) {
      current = deadline[1];
      continue;
    }
    break;
  }
  return current;
}

function isSingleIsolatedBunTestWrapperCommand(command) {
  return /^node\s+scripts\/run-isolated-tests\.mjs$/.test(
    unwrapKnownBunTestSupervisors(command),
  );
}

function structuredEvidenceKind(scriptName, scripts) {
  const command =
    resolveScriptCommand(scriptName, scripts) ||
    normalizeWhitespace(scripts?.[scriptName] ?? "");
  if (
    /(?:^|\s)--reporter(?:=|\s)|(?:^|\s)--reporter-outfile(?:=|\s)|(?:^|\s)--outputFile(?:\.junit)?(?:=|\s)/.test(
      command,
    )
  ) {
    return null;
  }
  if (
    isSingleBunTestCommand(command) ||
    isSingleIsolatedBunTestWrapperCommand(command)
  ) {
    return "bun";
  }
  if (
    isSingleVitestRunCommand(command) ||
    isSingleVitestWrapperCommand(command) ||
    isSingleVitestBatchWrapperCommand(command)
  ) {
    return "vitest";
  }
  return null;
}

function isSingleNoTestSkippableCommand(command) {
  return isSingleVitestRunCommand(command) || isSingleBunTestCommand(command);
}

function shouldSkipEmptyVitestScript(cwd, scriptName, scripts) {
  const command =
    resolveScriptCommand(scriptName, scripts) ||
    normalizeWhitespace(scripts?.[scriptName] ?? "");

  return isSingleVitestRunCommand(command) && !hasLocalTestFiles(cwd);
}

function canSkipWhenOutputHasNoTests(scriptName, scripts) {
  const command =
    resolveScriptCommand(scriptName, scripts) ||
    normalizeWhitespace(scripts?.[scriptName] ?? "");
  return isSingleNoTestSkippableCommand(command);
}

// ---------------------------------------------------------------------------
// Lane and shard support
// ---------------------------------------------------------------------------

/**
 * Compute which lane-specific env overrides to apply to a spawned process.
 *
 * - TEST_LANE=pr   → VITEST_EXCLUDE_REAL_E2E=1 + VITEST_EXCLUDE_REAL=1 so
 *   package vitest configs can drop `*.real.e2e.test.ts` and `*.real.test.ts`
 *   files (the real-API lane). pattern remains a regex string for callers
 *   that want to chain via `process.env`.
 * - TEST_LANE=post-merge → no exclusions; real keys flow through.
 * - --only=e2e     → VITEST_E2E_ONLY=1.
 * - --only=test    → VITEST_UNIT_ONLY=1.
 * - --pattern      → VITEST_TEST_PATH_PATTERN forwarded for package scripts
 *   that respect it. (Most do, via the shared default vitest config; package
 *   scripts that don't will simply ignore the env var.)
 */
function buildLaneEnv() {
  const extra = {};

  if (TEST_LANE === "pr") {
    extra.VITEST_EXCLUDE_REAL_E2E = "1";
    extra.VITEST_EXCLUDE_REAL = "1";
    // Also expose a regex string so configs that compose includes/excludes
    // dynamically don't have to know two flag names.
    extra.VITEST_LANE = "pr";
  } else if (TEST_LANE === "post-merge") {
    extra.VITEST_LANE = "post-merge";
  }

  if (onlyFlag === "e2e") {
    extra.VITEST_E2E_ONLY = "1";
  } else if (onlyFlag === "test") {
    extra.VITEST_UNIT_ONLY = "1";
  }

  if (patternFlag) {
    // Forwarded to vitest via env so package-level configs / wrapper scripts
    // can apply --testPathPattern when needed without reflowing CLI args.
    extra.VITEST_TEST_PATH_PATTERN = patternFlag;
  }

  if (excludeFlags.length > 0) {
    const normalizedExcludes = excludeFlags.map(normalizeRepoPath);
    extra.VITEST_TEST_EXCLUDE_PATHS = JSON.stringify(normalizedExcludes);
    extra.VITEST_TEST_EXCLUDE_PATTERN = normalizedExcludes
      .map(escapeForRegex)
      .join("|");
  }

  return extra;
}

function buildPlanSummary(tasks) {
  const { parallel, serial } = partitionTasks(tasks, TEST_LANE);
  const byScript = {};
  const byPackage = {};
  for (const task of tasks) {
    byScript[task.scriptName] = (byScript[task.scriptName] ?? 0) + 1;
    byPackage[task.packageName] = (byPackage[task.packageName] ?? 0) + 1;
  }
  return {
    lane: TEST_LANE,
    only: onlyFlag || "all",
    noCloud,
    requireWork,
    shard: shardConfig,
    filters: packageFilters.map((rx) => rx.source),
    scriptFilter: scriptFilter?.source ?? null,
    startAt: startAt || null,
    concurrency,
    packageCount: new Set(tasks.map((task) => task.packageName)).size,
    taskCount: tasks.length,
    parallelSafeTaskCount: parallel.length,
    serialTaskCount: serial.length,
    cloudStep: !noCloud,
    byScript,
    byPackage,
  };
}

function printableTask(task) {
  return {
    packageName: task.packageName,
    relativeDir: normalizeRepoPath(path.relative(repoRoot, task.cwd) || "."),
    scriptName: task.scriptName,
    label: task.label,
    parallelSafe: isParallelSafeTask({
      scriptName: task.scriptName,
      lane: TEST_LANE,
      packageName: task.packageName,
    }),
  };
}

function printPlan(tasks) {
  const summary = buildPlanSummary(tasks);
  const taskRows = tasks.map(printableTask);
  if (planFormat === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          summary,
          tasks: taskRows,
          skipped: skippedPlanEntries,
          cloudStep: summary.cloudStep
            ? { label: "cloud#test", command: "bun run test:cloud" }
            : null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    [
      `[eliza-test] PLAN lane=${summary.lane} only=${summary.only} tasks=${summary.taskCount} packages=${summary.packageCount}`,
      `[eliza-test] PLAN parallel-safe=${summary.parallelSafeTaskCount} serial=${summary.serialTaskCount} concurrency=${summary.concurrency}`,
      `[eliza-test] PLAN cloud-step=${summary.cloudStep ? "yes" : "no"}`,
      ...taskRows.map(
        (task) =>
          `[eliza-test] PLAN ${task.parallelSafe ? "parallel" : "serial"} ${task.label}`,
      ),
      ...skippedPlanEntries.map(
        (entry) => `[eliza-test] PLAN skip ${entry.label} (${entry.reason})`,
      ),
      "",
    ].join("\n"),
  );
}

function buildForwardedScriptArgs(scriptName, scripts, evidence) {
  const command =
    resolveScriptCommand(scriptName, scripts) ||
    normalizeWhitespace(scripts?.[scriptName] ?? "");
  const args = [];
  if (excludeFlags.length > 0 && isSingleVitestRunCommand(command)) {
    args.push(
      ...excludeFlags.flatMap((value) => [
        "--exclude",
        normalizeRepoPath(value),
      ]),
    );
  }
  if (evidence?.kind === "bun") {
    args.push("--reporter=junit", `--reporter-outfile=${evidence.path}`);
  } else if (evidence?.kind === "vitest") {
    args.push(
      "--reporter=default",
      "--reporter=junit",
      `--outputFile.junit=${evidence.path}`,
    );
  }
  return args;
}

let evidenceDirectory;
let evidenceSequence = 0;

function nextEvidencePath() {
  if (!evidenceDirectory) {
    evidenceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-test-evidence-"),
    );
    process.once("exit", () => {
      try {
        fs.rmSync(evidenceDirectory, { recursive: true, force: true });
      } catch (error) {
        // error-policy:J6 temporary evidence teardown must not replace the run result.
        console.warn(
          `[eliza-test] WARN could not remove temporary evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  evidenceSequence += 1;
  return path.join(evidenceDirectory, `${evidenceSequence}.xml`);
}

// ---------------------------------------------------------------------------
// Result ledger (#16994)
// ---------------------------------------------------------------------------

// Exactly-once machine-readable result records, keyed by task label. A label
// identifies `<packageName> (<relativeDir>)#<scriptName>` which is unique in
// the resolved plan (duplicate labels would collide here and fail closed).
const resultLedger = new Map();

function recordTaskResult(task, record) {
  const full = {
    label: task.label,
    packageName: task.packageName,
    relativeDir: normalizeRepoPath(path.relative(repoRoot, task.cwd) || "."),
    scriptName: task.scriptName,
    ...record,
  };
  if (resultLedger.has(task.label) || faultInject === "duplicate-record") {
    console.error(
      `[eliza-test] RESULT-PROTOCOL duplicate result record for ${task.label}; refusing to reconcile this run as green.`,
    );
    process.exit(3);
  }
  if (faultInject === "drop-record") {
    return;
  }
  resultLedger.set(task.label, full);
  console.log(`[eliza-test] RESULT ${JSON.stringify(full)}`);
}

function writeResultsFile(context) {
  const outPath = process.env.ELIZA_TEST_RESULTS_FILE;
  if (!outPath) return;
  const payload = {
    lane: TEST_LANE,
    only: onlyFlag || "all",
    shard: shardConfig,
    requireWork,
    taskTimeoutMs,
    resolvedTaskCount: tasks.length,
    laneMatchedTaskCount,
    excluded: skippedPlanEntries,
    results: [...resultLedger.values()],
    ...context,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
}

// Green-path protocol enforcement: after a run with no failed task, every
// resolved task must have exactly one record. A missing record means a child
// completed without being observed (result-protocol bug or injected fault) and
// the run must not reconcile as green. Fail-fast serial runs stop early, so
// this only applies when nothing failed.
function enforceResultLedger(failures) {
  const statuses = [...resultLedger.values()].map((r) => r.status);
  const summary = {
    pass: statuses.filter((s) => s === "pass").length,
    skip: statuses.filter((s) => s === "skip").length,
    fail: statuses.filter((s) => s === "fail").length,
    notRun: statuses.filter((s) => s === "not-run").length,
    excluded: skippedPlanEntries.length,
  };
  console.log(
    `[eliza-test] RESULTS tasks=${tasks.length} pass=${summary.pass} fail=${summary.fail} ` +
      `skip=${summary.skip} not-run=${summary.notRun} excluded=${summary.excluded} ` +
      `unobserved=${outcomeTally.unobserved}`,
  );
  if (failures.length > 0) return;
  const missing = tasks.filter((task) => !resultLedger.has(task.label));
  if (missing.length > 0) {
    console.error(
      `[eliza-test] RESULT-PROTOCOL ${missing.length} resolved task(s) finished without a result record:\n  ${missing
        .map((t) => t.label)
        .join("\n  ")}`,
    );
    writeResultsFile({ protocolViolation: "missing-record" });
    process.exit(3);
  }
  if (requireWork && tasks.length > 0 && summary.pass === 0) {
    console.error(
      `[eliza-test] VACUOUS-GREEN GUARD all ${tasks.length} resolved task(s) were skipped; ` +
        "an all-skipped lane is not a pass.",
    );
    writeResultsFile({ protocolViolation: "all-skipped" });
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

function runScript(
  cwd,
  scriptName,
  label,
  scripts,
  extraEnv = {},
  options = {},
) {
  // When pooled, several children run at once; streaming their output live
  // would interleave mid-line. Buffer instead and flush a contiguous block
  // only on failure (passing/skipped tasks stay quiet, reported by their PASS
  // line) so the logs remain readable.
  const stream = options.stream !== false;
  return new Promise((resolve, reject) => {
    const evidenceKind = requireWork
      ? structuredEvidenceKind(scriptName, scripts)
      : null;
    const evidence = evidenceKind
      ? { kind: evidenceKind, path: nextEvidencePath() }
      : null;
    const forwardedArgs = buildForwardedScriptArgs(
      scriptName,
      scripts,
      evidence,
    );
    const liveTestDefault = TEST_LANE === "post-merge" ? "1" : "0";
    const child = spawn(
      bunCmd,
      [
        "run",
        scriptName,
        ...(forwardedArgs.length > 0 ? ["--", ...forwardedArgs] : []),
      ],
      {
        cwd,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || "1",
          ELIZA_LIVE_TEST: process.env.ELIZA_LIVE_TEST || liveTestDefault,
          PWD: cwd,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const capturedOutput = createCapturedTestOutput();
    // A non-zero exit may only be reclassified as a benign "no tests" skip when
    // BOTH hold:
    //   1. the command is a single vitest/bun-test invocation, AND
    //   2. the lane genuinely has no test files on disk (the runner's own
    //      authoritative empty-file determination).
    // Anchoring on (2) — not just an output substring — is what #13620 task 4
    // asks for: if test files DO exist, a non-zero exit is a real failure/
    // misconfig and must never be swallowed as green, even when the output
    // happens to contain a "No test files found" banner (e.g. a runtime filter
    // that matched nothing in one project while a sibling project failed, or a
    // test/setup process that aborts before printing its normal failure
    // summary). Benign lanes with no test files still skip.
    const canSkipNoTests =
      canSkipWhenOutputHasNoTests(scriptName, scripts) &&
      !hasLocalTestFiles(cwd);

    child.stdout?.on("data", (chunk) => {
      if (stream) {
        process.stdout.write(chunk);
      }
      appendCapturedTestOutput(
        capturedOutput,
        chunk.toString("utf8"),
        "stdout",
      );
    });
    child.stderr?.on("data", (chunk) => {
      if (stream) {
        process.stderr.write(chunk);
      }
      appendCapturedTestOutput(
        capturedOutput,
        chunk.toString("utf8"),
        "stderr",
      );
    });

    // Armed timeout: a hung child is killed and recorded as a timeout FAILURE.
    // A timed-out child that manages to exit 0 during the kill grace period is
    // still a failure — its run was cut short, so its green exit proves nothing.
    let timedOut = false;
    let timeoutTimer = null;
    if (taskTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, taskTimeoutMs);
      timeoutTimer.unref();
    }

    const failWith = (message, code, signal) => {
      const error = new Error(message);
      error.exitCode = code ?? null;
      error.exitSignal = signal ?? null;
      error.timedOut = timedOut;
      reject(error);
    };

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timedOut) {
        if (!stream && capturedOutput) {
          process.stdout.write(
            `\n[eliza-test] ----- captured output: ${label} -----\n${capturedOutput}\n[eliza-test] ----- end output: ${label} -----\n`,
          );
        }
        failWith(
          `${label} timed out after ${taskTimeoutMs}ms (TEST_TASK_TIMEOUT_MS)`,
          code,
          signal,
        );
        return;
      }
      if (code === 0) {
        if (!evidence) {
          resolve({ skipped: false, evidence: null, exitCode: 0 });
          return;
        }
        try {
          const size = fs.statSync(evidence.path).size;
          if (size > MAX_JUNIT_BYTES) {
            throw new Error(
              `JUnit artifact is ${size} bytes; limit is ${MAX_JUNIT_BYTES}`,
            );
          }
          const summary = parseJunitSummary(
            fs.readFileSync(evidence.path, "utf8"),
          );
          if (summary.failures > 0 || summary.errors > 0) {
            throw new Error(
              `report contains ${summary.failures} failure(s) and ${summary.errors} error(s) despite a successful child exit`,
            );
          }
          resolve({
            skipped: summary.executedTests === 0,
            skipReason: `${summary.tests} reported test(s), all skipped`,
            evidence: summary,
            exitCode: 0,
          });
        } catch (error) {
          // error-policy:J2 add the package identity before rejecting invalid evidence.
          if (!stream && retainedCapturedTestOutput(capturedOutput)) {
            process.stdout.write(
              formatCapturedTestOutput(capturedOutput, label),
            );
          }
          reject(
            new Error(`${label} did not produce valid JUnit evidence`, {
              cause: error,
            }),
          );
        }
        return;
      }
      if (
        canSkipNoTests &&
        shouldSkipAsNoTests(retainedCapturedTestOutput(capturedOutput))
      ) {
        resolve({
          skipped: true,
          skipReason: "no test files found",
          evidence: null,
          exitCode: code,
        });
        return;
      }
      if (!stream && retainedCapturedTestOutput(capturedOutput)) {
        process.stdout.write(formatCapturedTestOutput(capturedOutput, label));
      }
      failWith(
        `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        code,
        signal,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Cloud step
// ---------------------------------------------------------------------------

function runCloudTests() {
  return new Promise((resolve, reject) => {
    // Post-consolidation: cloud tests live inside packages/cloud-*. Run them via the root `test:cloud` script.
    console.log("[eliza-test] START cloud#test");
    const startedAt = Date.now();
    const child = spawn(bunCmd, ["run", "test:cloud"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || "1",
        PWD: repoRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    // The cloud stage honours the same per-child wall-clock bound as every
    // resolved task: a hung cloud child becomes a recorded timeout failure,
    // not an unbounded job.
    let timedOut = false;
    let timeoutTimer = null;
    if (taskTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, taskTimeoutMs);
      timeoutTimer.unref();
    }

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        const error = new Error(
          `cloud#test timed out after ${taskTimeoutMs}ms (TEST_TASK_TIMEOUT_MS)`,
        );
        error.timedOut = true;
        reject(error);
        return;
      }
      if (code === 0) {
        console.log(`[eliza-test] PASS cloud#test (${durationMs}ms)`);
        resolve({ status: "pass", exitCode: 0, durationMs, timedOut: false });
        return;
      }
      reject(
        new Error(
          `cloud#test failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const packageJsonPaths = collectPackageJsonPaths();

let started = startAt.length === 0;

// First pass: discover every runnable task (package × script) and apply all
// filters/skips. Collecting up front lets the runner dispatch the parallel-safe
// subset through a worker pool instead of the historical strictly-serial loop.
const tasks = [];
const skippedPlanEntries = [];
// Count real runnable tasks before TEST_SHARD carves out this shard's slice.
// Required work distinguishes a collapsed lane from an unexpectedly empty
// deterministic shard without relying on a historical repository-size floor.
let laneMatchedTaskCount = 0;

for (const packageJsonPath of packageJsonPaths) {
  const cwd = path.dirname(packageJsonPath);
  const relativeDir = path.relative(repoRoot, cwd) || ".";
  // Public task labels and machine-readable output use stable repository paths,
  // while relativeDir stays platform-native for membership checks and sharding.
  const relativeDirLabel = normalizeRepoPath(relativeDir);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const scriptNames = collectScriptsToRun(scripts);

  if (scriptNames.length === 0) {
    continue;
  }
  if (noCloud && NO_CLOUD_PACKAGE_DIRS.has(relativeDir)) {
    const label = `${packageJson.name || relativeDirLabel} (${relativeDirLabel})`;
    // Designed exclusions are recorded in both plan and run modes so the
    // result ledger can distinguish "deliberately not run" from "passed".
    skippedPlanEntries.push({
      label,
      packageName: packageJson.name || relativeDirLabel,
      relativeDir: relativeDirLabel,
      reason: "cloud package skipped by --no-cloud",
    });
    if (!planEnabled) {
      console.log(
        `[eliza-test] SKIP ${label} (cloud package skipped by --no-cloud)`,
      );
    }
    continue;
  }

  const packageName = packageJson.name || relativeDirLabel;
  for (const scriptName of scriptNames) {
    const label = `${packageName} (${relativeDirLabel})#${scriptName}`;
    if (!started) {
      if (label.includes(startAt)) {
        started = true;
      } else {
        continue;
      }
    }
    // The homepage directory is a source/test module, not a deployable app.
    // Its legacy visual harness remains operator-run because software-GPU timing
    // can consume the entire root E2E budget; quality CI instead runs its source
    // contracts and builds the real packages/app integration artifact.
    if (
      TEST_LANE === "pr" &&
      scriptName === "test:e2e" &&
      ROOT_PR_E2E_EXCLUDED_PACKAGE_DIRS.has(relativeDir)
    ) {
      skippedPlanEntries.push({
        label,
        packageName,
        relativeDir: relativeDirLabel,
        scriptName,
        reason: "operator-run visual harness excluded from the pr lane",
      });
      continue;
    }
    if (packageFilters.some((rx) => !rx.test(label))) {
      continue;
    }
    if (scriptFilter && !scriptFilter.test(scriptName)) {
      continue;
    }
    const belongsToShard = taskBelongsToShard(relativeDir, shardConfig);
    if (shouldSkipEmptyVitestScript(cwd, scriptName, scripts)) {
      // Scope the skip log/plan entry to this shard so per-shard output stays
      // readable; the empty-script check itself runs for every task because it
      // decides what counts as real lane work below.
      if (belongsToShard) {
        skippedPlanEntries.push({
          label,
          packageName,
          relativeDir: relativeDirLabel,
          scriptName,
          reason: "no local test files for vitest script",
        });
        if (!planEnabled) {
          console.log(
            `[eliza-test] SKIP ${label} (no local test files for vitest script)`,
          );
        }
      }
      continue;
    }

    // Real runnable task for the lane. Count it before sharding narrows the set.
    laneMatchedTaskCount += 1;

    // Shard filtering: deterministic by relative package dir hash. Keeps a
    // package's `test` + `test:e2e` tasks colocated in the same shard.
    if (!belongsToShard) {
      continue;
    }

    tasks.push({ cwd, scriptName, label, scripts, packageName });
  }
}

const laneEnv = buildLaneEnv();

if (requireWork && laneMatchedTaskCount === 0) {
  console.error(
    "[eliza-test] VACUOUS-GREEN GUARD lane matched 0 runnable tasks. " +
      "A filter or source contract collapsed this required lane.",
  );
  process.exit(3);
}
if (requireWork && shardConfig && tasks.length === 0) {
  console.error(
    `[eliza-test] VACUOUS-GREEN GUARD shard ${TEST_SHARD} owns 0 of ${laneMatchedTaskCount} required task(s).`,
  );
  process.exit(3);
}

if (planEnabled) {
  printPlan(tasks);
  process.exit(0);
}

ensurePluginSqlPostgresEnv();

const outcomeTally = {
  completed: 0,
  skipped: 0,
  unobserved: 0,
  reportedTasks: 0,
  tests: 0,
  executedTests: 0,
  skippedTests: 0,
};

// Run one task, logging START/PASS/SKIP/FAIL. `stream` echoes child output live
// (serial path); when false the output is buffered and flushed only on failure
// (pooled path) so concurrent children don't interleave mid-line.
async function runTask(task, { stream }) {
  console.log(`[eliza-test] START ${task.label}`);
  const startedAt = Date.now();
  try {
    const result = await runScript(
      task.cwd,
      task.scriptName,
      task.label,
      task.scripts,
      laneEnv,
      { stream },
    );
    const durationMs = Date.now() - startedAt;
    if (result.evidence) {
      outcomeTally.reportedTasks += 1;
      outcomeTally.tests += result.evidence.tests;
      outcomeTally.executedTests += result.evidence.executedTests;
      outcomeTally.skippedTests += result.evidence.skipped;
    } else if (!result.skipped) {
      outcomeTally.unobserved += 1;
    }
    recordTaskResult(task, {
      status: result.skipped ? "skip" : "pass",
      observed: Boolean(result.evidence),
      exitCode: result.exitCode ?? null,
      signal: null,
      timedOut: false,
      durationMs,
      counts: result.evidence
        ? {
            tests: result.evidence.tests,
            executed: result.evidence.executedTests,
            failures: result.evidence.failures,
            errors: result.evidence.errors,
            skipped: result.evidence.skipped,
          }
        : null,
      skipReason: result.skipped ? result.skipReason : undefined,
    });
    if (result.skipped) {
      outcomeTally.skipped += 1;
      console.log(
        `[eliza-test] SKIP ${task.label} (${durationMs}ms, ${result.skipReason})`,
      );
    } else {
      outcomeTally.completed += 1;
      console.log(`[eliza-test] PASS ${task.label} (${durationMs}ms)`);
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    recordTaskResult(task, {
      status: "fail",
      observed: false,
      exitCode: error?.exitCode ?? null,
      signal: error?.exitSignal ?? null,
      timedOut: Boolean(error?.timedOut),
      durationMs,
      counts: null,
      failReason: error instanceof Error ? error.message : String(error),
    });
    console.error(`[eliza-test] FAIL ${task.label} (${durationMs}ms)`);
    throw error;
  }
}

function enforceRequiredWork() {
  if (outcomeTally.reportedTasks > 0 || outcomeTally.unobserved > 0) {
    console.log(
      `[eliza-test] EVIDENCE reports=${outcomeTally.reportedTasks} tests=${outcomeTally.tests} ` +
        `executed=${outcomeTally.executedTests} skipped=${outcomeTally.skippedTests} ` +
        `unobserved-tasks=${outcomeTally.unobserved}`,
    );
  }
  if (!requireWork) return;
  if (outcomeTally.executedTests === 0) {
    console.error(
      `[eliza-test] VACUOUS-GREEN GUARD ${tasks.length} runnable task(s) completed without reconciled evidence that a testcase executed. ` +
        "Unsupported wrappers do not count as semantic work.",
    );
    writeResultsFile({
      protocolViolation: "vacuous-work",
      failedTaskLabels: [],
    });
    process.exit(3);
  }
}

const taskFailures = [];

// A job-level cancellation still flushes the partial ledger, so a downstream
// consumer sees an explicitly interrupted artifact rather than a missing or
// stale one. Installed after task resolution so the payload fields exist.
for (const interruptSignal of ["SIGINT", "SIGTERM"]) {
  process.on(interruptSignal, () => {
    console.error(`[eliza-test] INTERRUPTED by ${interruptSignal}`);
    writeResultsFile({ interrupted: interruptSignal, failedTaskLabels: [] });
    process.exit(interruptSignal === "SIGINT" ? 130 : 143);
  });
}

if (concurrency <= 1) {
  // Default: fully serial, fail-fast — the historical behaviour, except the
  // failure now flows through the shared result ledger before the run exits
  // instead of surfacing as an unhandled top-level rejection.
  for (const task of tasks) {
    try {
      await runTask(task, { stream: true });
    } catch (error) {
      // error-policy:J1 the first serial failure ends the run with a recorded,
      // machine-readable result instead of an unhandled rejection.
      taskFailures.push({ label: task.label, error });
      break;
    }
  }
} else {
  // Opt-in parallelism. Only the parallel-safe bucket (plain `test` scripts in
  // the secret-free pr lane, minus the shared-DB packages) runs through the
  // pool; the rest (e2e/integration/... lanes and any real lane) drains
  // serially afterwards. Every task runs to completion so all failures are
  // reported together instead of aborting on the first.
  const { parallel, serial } = partitionTasks(tasks, TEST_LANE);
  if (TEST_LANE !== "pr") {
    console.log(
      `[eliza-test] NOTE --concurrency=${concurrency} only parallelises the pr lane; running the ${TEST_LANE} lane serially.`,
    );
  } else {
    console.log(
      `[eliza-test] INFO running ${parallel.length} parallel-safe task(s) at concurrency ${concurrency}; ${serial.length} task(s) serialized.`,
    );
  }

  const poolResults = await runPool(
    parallel,
    (task) => runTask(task, { stream: false }),
    concurrency,
  );
  poolResults.forEach((outcome, index) => {
    if (outcome && !outcome.ok) {
      taskFailures.push({ label: parallel[index].label, error: outcome.error });
    }
  });

  for (const task of serial) {
    try {
      await runTask(task, { stream: true });
    } catch (error) {
      // error-policy:J1 pooled mode runs every task to completion and reports
      // all failures together at the shared exit boundary below.
      taskFailures.push({ label: task.label, error });
    }
  }
}

// A failed run still writes a complete ledger: every resolved task the
// fail-fast serial path never reached gets an explicit not-run record, so a
// downstream consumer can distinguish "failed", "passed", and "never ran"
// instead of reconciling a truncated prefix as the whole plan.
if (taskFailures.length > 0) {
  for (const task of tasks) {
    if (!resultLedger.has(task.label)) {
      recordTaskResult(task, {
        status: "not-run",
        observed: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        counts: null,
        skipReason: "not run: an earlier task failed in fail-fast mode",
      });
    }
  }
}

enforceResultLedger(taskFailures);

if (taskFailures.length > 0) {
  writeResultsFile({
    failedTaskLabels: taskFailures.map((failure) => failure.label),
  });
  console.error(
    `[eliza-test] ${taskFailures.length} task(s) failed:\n  ${taskFailures
      .map(
        (failure) =>
          `${failure.label}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      )
      .join("\n  ")}`,
  );
  process.exit(1);
}

enforceRequiredWork();

// Final stage: cloud tests (unless --no-cloud was passed). The cloud child is
// part of the run's result contract: its outcome lands in the results file,
// which is only finalized after the stage settles so the artifact can never
// claim a clean run that a later cloud failure contradicts.
let cloudResult = {
  status: "excluded",
  reason: "cloud stage skipped by --no-cloud",
};
if (!noCloud) {
  try {
    cloudResult = await runCloudTests();
  } catch (error) {
    // error-policy:J1 the cloud stage failure ends the run with a recorded,
    // machine-readable result instead of an unhandled rejection.
    cloudResult = {
      status: "fail",
      timedOut: Boolean(error?.timedOut),
      failReason: error instanceof Error ? error.message : String(error),
    };
    writeResultsFile({ failedTaskLabels: ["cloud#test"], cloud: cloudResult });
    console.error(
      `[eliza-test] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
writeResultsFile({ failedTaskLabels: [], cloud: cloudResult });
