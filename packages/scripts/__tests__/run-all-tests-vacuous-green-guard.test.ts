/**
 * Pins the run-all-tests.mjs vacuous-green guards (#12342/#13620).
 *
 * The suite spawns the real runner against temporary workspace packages so a
 * lane that collects no tasks, swallows a failure as "no tests found", or hides
 * a test-file mismatch cannot exit green without exercising the runner path.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const runner = fileURLToPath(new URL("../run-all-tests.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Each case spawns the real runner (workspace discovery over the whole repo),
// so give bun headroom well past the discovery cost on a cold/contended runner.
const SPAWN_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 4000;

function tail(value) {
  if (value.length <= OUTPUT_TAIL_CHARS) return value;
  return value.slice(-OUTPUT_TAIL_CHARS);
}

function run(args, env = {}) {
  const command = [process.execPath, runner, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error || result.signal) {
    throw new Error(
      [
        `run-all-tests spawn did not complete: ${command.join(" ")}`,
        `status=${String(result.status)} signal=${String(result.signal)}`,
        `error=${result.error?.message ?? "none"}`,
        `stdout tail:\n${tail(stdout)}`,
        `stderr tail:\n${tail(stderr)}`,
      ].join("\n\n"),
    );
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
  };
}

const NOWHERE_FILTER = "__no_such_package_zzz__";
const ZERO_TASK_DIAGNOSTIC = "lane matched 0 runnable tasks";
const TEMP_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_false_no_test_skip__",
);
const PLAN_FLOOR_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_plan_floor_fixture__",
);
// A second temp package whose `test` script is a SINGLE `bun test <file>`
// invocation — i.e. one that canSkipWhenOutputHasNoTests() treats as
// no-test-skippable. This is the code path #13620 task 4 is about: a skippable
// runner command whose merged output carries BOTH a no-tests banner AND a
// genuine failure must NOT be reclassified as SKIP=green.
const SKIPPABLE_MIXED_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_mixed_no_test_and_fail__",
);
const SKIPPABLE_EMPTY_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_genuinely_no_tests__",
);
const ISOLATED_WRAPPER_PACKAGE_DIR = join(
  repoRoot,
  "packages",
  "__run_all_tests_isolated_bun_wrapper__",
);

function rootScript(name) {
  const rootPackage = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const script = rootPackage.scripts?.[name];
  if (typeof script !== "string") {
    throw new Error(`missing root package script ${name}`);
  }
  return script;
}

describe("root test lane require-work wiring (#13620)", () => {
  for (const scriptName of [
    "test",
    "test:server",
    "test:client",
    "test:plugins",
    "test:e2e",
    "test:live",
    "test:e2e:live",
  ]) {
    test(`${scriptName} arms the run-all-tests vacuous-green guard`, () => {
      expect(rootScript(scriptName)).toContain("--require-work");
    });
  }

  test("workflow invocations only pass flags the runner still accepts (#18185)", () => {
    // The runner fails closed (exit 2) on unknown arguments, so a workflow
    // still passing a retired flag kills its job before a single test runs —
    // exactly what --min-tasks did to the plugin-tests gate after the flag
    // became --require-work.
    const workflowDir = join(repoRoot, ".github", "workflows");
    for (const file of readdirSync(workflowDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const source = readFileSync(join(workflowDir, file), "utf8");
      if (!source.includes("run-all-tests.mjs")) continue;
      expect(
        source,
        `${file} passes the retired --min-tasks flag`,
      ).not.toContain("--min-tasks");
      expect(
        source,
        `${file} sets the retired MIN_TEST_TASKS env`,
      ).not.toContain("MIN_TEST_TASKS");
    }
  });

  test("the standalone guard installs the Bun contract dependency first", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "test.yml"),
      "utf8",
    );
    const jobStart = workflow.indexOf("  test-runner-vacuous-green-guard:");
    const nextJob = workflow.indexOf("\n  server-tests:", jobStart);
    expect(jobStart).toBeGreaterThan(-1);
    expect(nextJob).toBeGreaterThan(jobStart);
    const job = workflow.slice(jobStart, nextJob);
    const install = job.indexOf(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    const contract = job.indexOf(
      "node packages/scripts/ci-bun-version-contract.mjs",
    );
    expect(install).toBeGreaterThan(-1);
    expect(contract).toBeGreaterThan(install);
  });
});

describe("run-all-tests --require-work vacuous-green guard", () => {
  test(
    "exits 3 when a collapsed filter collects zero runnable tasks",
    () => {
      const result = run([
        "--no-cloud",
        `--filter=${NOWHERE_FILTER}`,
        "--require-work",
      ]);
      expect(result.status).toBe(3);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "VACUOUS-GREEN GUARD",
      );
      expect(`${result.stdout}${result.stderr}`).toContain(
        ZERO_TASK_DIAGNOSTIC,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "enforces the zero-task guard before plan mode exits",
    () => {
      const result = run([
        "--plan=json",
        "--no-cloud",
        `--filter=${NOWHERE_FILTER}`,
        "--require-work",
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(ZERO_TASK_DIAGNOSTIC);
      expect(result.stdout).toBe("");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "without the guard, a collapsed lane keeps its historical non-failing exit",
    () => {
      // The guard is strictly additive: omitting --require-work must not change
      // the pre-existing behaviour of a zero-task collapse (green, no guard text).
      const result = run(["--no-cloud", `--filter=${NOWHERE_FILTER}`]);
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "VACUOUS-GREEN GUARD",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "plan mode still succeeds with --require-work when a task is discovered",
    () => {
      // Use a self-contained fixture instead of an authored workspace package:
      // this guard is explicitly invoked from packages/scripts/__tests__, which
      // can run in sparse worktrees where @elizaos/agent is absent. The runner
      // only needs to prove a real discovered task satisfies the floor.
      rmSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(PLAN_FLOOR_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-plan-floor-fixture",
              private: true,
              type: "module",
              scripts: {
                test: 'node -e "process.exit(0)"',
              },
            },
            null,
            2,
          )}\n`,
        );

        const result = run([
          "--plan=json",
          "--only=test",
          "--filter=@elizaos/run-all-tests-plan-floor-fixture",
          "--require-work",
        ]);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.summary.taskCount).toBe(1);
      } finally {
        rmSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "the retired --min-tasks flag fails closed at argv parse (#17070)",
    () => {
      // The numeric collection floor was a historical-count baseline; it is
      // removed rather than silently ignored, so a stale caller dies loudly
      // before any test runs instead of running with a floor it believes is
      // armed.
      const result = run(["--no-cloud", "--min-tasks=1", "--plan"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown argument");
      expect(result.stderr).toContain("--min-tasks=1");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "the retired MIN_TEST_TASKS env is inert (#17070)",
    () => {
      // The env twin of --min-tasks must not resurrect the numeric floor: a
      // lane that matches one task succeeds even under an absurd env floor,
      // and the boolean zero-task guard is unaffected.
      rmSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(PLAN_FLOOR_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-plan-floor-fixture",
              private: true,
              type: "module",
              scripts: {
                test: 'node -e "process.exit(0)"',
              },
            },
            null,
            2,
          )}\n`,
        );

        const result = run(
          [
            "--plan=json",
            "--only=test",
            "--no-cloud",
            "--filter=@elizaos/run-all-tests-plan-floor-fixture",
            "--require-work",
          ],
          { MIN_TEST_TASKS: "999" },
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).summary.taskCount).toBe(1);
      } finally {
        rmSync(PLAN_FLOOR_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "reconciles JUnit evidence from a supervised isolated Bun wrapper",
    () => {
      rmSync(ISOLATED_WRAPPER_PACKAGE_DIR, {
        recursive: true,
        force: true,
      });
      mkdirSync(join(ISOLATED_WRAPPER_PACKAGE_DIR, "scripts"), {
        recursive: true,
      });
      try {
        writeFileSync(
          join(ISOLATED_WRAPPER_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-isolated-bun-wrapper-fixture",
              private: true,
              type: "module",
              scripts: {
                test: "node ../../packages/scripts/run-with-flake-retry.mjs 'never-match' -- node ../../packages/scripts/run-with-deadline.mjs 5000 -- node scripts/run-isolated-tests.mjs",
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(
            ISOLATED_WRAPPER_PACKAGE_DIR,
            "scripts",
            "run-isolated-tests.mjs",
          ),
          [
            'import { writeFileSync } from "node:fs";',
            "const args = process.argv.slice(2);",
            'const output = args.find((arg) => arg.startsWith("--reporter-outfile="))?.slice("--reporter-outfile=".length);',
            'if (!args.includes("--reporter=junit") || !output) throw new Error("missing forwarded JUnit arguments");',
            'writeFileSync(output, `<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite name="isolated" tests="1" failures="0" errors="0" skipped="0"><testcase name="real isolated work" /></testsuite></testsuites>`);',
            "",
          ].join("\n"),
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-isolated-bun-wrapper-fixture",
          "--require-work",
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          "EVIDENCE reports=1 tests=1 executed=1 skipped=0 unobserved-tasks=0",
        );
      } finally {
        rmSync(ISOLATED_WRAPPER_PACKAGE_DIR, {
          recursive: true,
          force: true,
        });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "reconciles agent batch evidence after its required mobile preflight",
    () => {
      const directory = join(repoRoot, "packages", "__agent_batch_preflight__");
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(join(directory, "scripts"), { recursive: true });
      try {
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({
            name: "@elizaos/agent-batch-preflight-fixture",
            private: true,
            type: "module",
            scripts: {
              test: "bun run test:mobile-workspace-entry && node scripts/run-vitest-batches.mjs",
              "test:mobile-workspace-entry": "node scripts/preflight.mjs",
            },
          }),
        );
        writeFileSync(
          join(directory, "scripts", "preflight.mjs"),
          'import { writeFileSync } from "node:fs"; if (process.env.REJECT_PREFLIGHT === "1") process.exit(7); writeFileSync("admitted", "yes");',
        );
        writeFileSync(
          join(directory, "scripts", "run-vitest-batches.mjs"),
          [
            'import { readFileSync, writeFileSync } from "node:fs";',
            'if (readFileSync("admitted", "utf8") !== "yes") throw new Error("preflight missing");',
            "const args = process.argv.slice(2);",
            'const output = args.find(arg => arg.startsWith("--outputFile.junit="))?.slice("--outputFile.junit=".length);',
            'if (!args.includes("--reporter=junit") || !output) throw new Error("missing batch evidence arguments");',
            'writeFileSync(output, `<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite name="batch" tests="1" failures="0" errors="0" skipped="0"><testcase name="observed batch" /></testsuite></testsuites>`);',
          ].join("\n"),
        );
        const args = [
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/agent-batch-preflight-fixture",
          "--require-work",
        ];
        const result = run(args);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          "EVIDENCE reports=1 tests=1 executed=1 skipped=0 unobserved-tasks=0",
        );
        rmSync(join(directory, "admitted"));
        const rejected = run(args, { REJECT_PREFLIGHT: "1" });
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).not.toContain("executed=1");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "does not reclassify arbitrary failing scripts as no-test skips",
    () => {
      rmSync(TEMP_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(TEMP_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(TEMP_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-false-no-test-skip-fixture",
              private: true,
              type: "module",
              scripts: {
                test: "node fail-with-no-test-text.mjs",
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(TEMP_PACKAGE_DIR, "fail-with-no-test-text.mjs"),
          "console.error('No test files found, then a real failure');\nprocess.exit(42);\n",
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-false-no-test-skip-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).toContain(
          "FAIL @elizaos/run-all-tests-false-no-test-skip-fixture",
        );
        expect(output).not.toContain(
          "SKIP @elizaos/run-all-tests-false-no-test-skip-fixture",
        );
      } finally {
        rmSync(TEMP_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

// #13620 task 4: the no-tests-skip reclassification must be narrowed so a
// non-zero exit whose output ALSO carries a genuine failure signal is not
// swallowed as SKIP=green. Distinct from the `--require-work` guard (task 3,
// #12342) pinned above, and from the existing "arbitrary failing script" case
// whose fixture command is not no-test-skippable (so it never reached the
// swallow branch). These fixtures use a SINGLE `bun test <file>` command, which
// canSkipWhenOutputHasNoTests() does treat as skippable, so they exercise the
// exact branch that used to swallow the failure.
describe("run-all-tests no-test-skip failure-swallow guard (#13620)", () => {
  test(
    "a skippable bun-test lane emitting a no-tests banner AND a real failure fails (not SKIP=green)",
    () => {
      rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
              private: true,
              type: "module",
              // Single `bun test <file>` command => no-test-skippable.
              scripts: {
                test: "bun test mixed.test.ts",
              },
            },
            null,
            2,
          )}\n`,
        );
        // The test prints the "No test files found" banner (simulating a sibling
        // project in a multi-project run that collected nothing) AND fails a
        // real assertion (bun emits `(fail)` / `1 fail` / `error:`), all in one
        // merged stdout+stderr buffer, exiting non-zero.
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "mixed.test.ts"),
          [
            'import { test, expect } from "bun:test";',
            'test("empty sibling banner then a real failure", () => {',
            '  console.log("No test files found in sibling project");',
            "  expect(1).toBe(2);",
            "});",
            "",
          ].join("\n"),
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).toContain(
          "FAIL @elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
        );
        expect(output).not.toContain(
          "SKIP @elizaos/run-all-tests-mixed-no-test-and-fail-fixture",
        );
      } finally {
        rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a genuinely-empty skippable lane (no test files, no-tests banner, no failure signal) is still SKIP=green",
    () => {
      // Behaviour-preservation: a single `bun test <dir>` over a test-free
      // directory exits non-zero with the recognised no-tests banner and NO
      // failure signal, and must still be reclassified as a benign skip
      // (status 0, not a hard failure). This proves the fix is additive — it
      // only withholds the skip when the lane has test files on disk or the
      // output carries a real failure marker.
      rmSync(SKIPPABLE_EMPTY_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(SKIPPABLE_EMPTY_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(SKIPPABLE_EMPTY_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-genuinely-no-tests-fixture",
              private: true,
              type: "module",
              // Single `bun test <dir>` command => no-test-skippable. The dir
              // exists but contains NO test files, so the runner's own
              // authoritative empty-file determination (hasLocalTestFiles) is
              // false AND bun prints a recognised no-tests banner ("did not
              // match any test files") on non-zero exit with no failure marker.
              // The lane runs via `bun run test`, so Bun also appends its
              // wrapper line `error: script "test" exited with code 1`; the
              // failure detector must NOT treat that wrapper error as a real
              // failure, or this benign empty lane would be reported as FAIL
              // instead of SKIP. This pins that regression closed.
              scripts: {
                test: "bun test empty-tests",
              },
            },
            null,
            2,
          )}\n`,
        );
        // An existing but test-free directory: keeps hasLocalTestFiles(cwd)
        // false (genuinely no tests) while giving bun a real path to search so
        // it emits the "did not match any test files" banner rather than a
        // filter-error.
        mkdirSync(join(SKIPPABLE_EMPTY_PACKAGE_DIR, "empty-tests"), {
          recursive: true,
        });

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-genuinely-no-tests-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(0);
        expect(output).toContain(
          "SKIP @elizaos/run-all-tests-genuinely-no-tests-fixture",
        );
        expect(output).not.toContain(
          "FAIL @elizaos/run-all-tests-genuinely-no-tests-fixture",
        );
      } finally {
        rmSync(SKIPPABLE_EMPTY_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a lane WITH test files that reports a no-tests banner on non-zero exit is NOT skipped",
    () => {
      // The exact edge the output-scan alone could not close: a skippable lane
      // that DOES have test files on disk exits non-zero and emits a no-tests
      // banner (e.g. a runtime filter that matched nothing, or a process that
      // aborts before printing a normal failure summary). Because the runner's
      // own empty-file determination (hasLocalTestFiles) is TRUE, this is a
      // real failure/misconfig and must NOT be reclassified as SKIP=green,
      // even though no per-test failure marker is present in the output.
      rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      mkdirSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true });
      try {
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "package.json"),
          `${JSON.stringify(
            {
              name: "@elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
              private: true,
              type: "module",
              // A real test file EXISTS but the command filters to a path that
              // matches nothing => bun prints a no-tests banner and exits
              // non-zero WITHOUT a per-test failure marker.
              scripts: {
                test: "bun test __no_matching_filter_zzz__",
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(SKIPPABLE_MIXED_PACKAGE_DIR, "present.test.ts"),
          [
            'import { test, expect } from "bun:test";',
            'test("present but filtered out", () => {',
            "  expect(true).toBe(true);",
            "});",
            "",
          ].join("\n"),
        );

        const result = run([
          "--only=test",
          "--no-cloud",
          "--filter=@elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
        ]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).toContain(
          "FAIL @elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
        );
        expect(output).not.toContain(
          "SKIP @elizaos/run-all-tests-hasfiles-but-notests-banner-fixture",
        );
      } finally {
        rmSync(SKIPPABLE_MIXED_PACKAGE_DIR, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
