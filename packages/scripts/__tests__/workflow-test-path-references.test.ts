/**
 * Every test file a workflow names by path must exist.
 *
 * Both runners fail open on a path that no longer resolves: `bun test` skips a
 * missing file silently, and vitest treats a positional argument as a filter,
 * so a stale name prints "No test files found" and exits 0. A step can
 * therefore keep passing while testing nothing. #28109 removed three suites and
 * left "App route + ui-smoke spec coverage gates" naming all three, plus two
 * dead filters in the Electrobun step.
 *
 * Only `run:` command text is inspected — comments are prose, and glob
 * fragments are not paths.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowDir = join(repoRoot, ".github", "workflows");
const TEST_PATH =
  /[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:test|spec)\.(?:tsx|mjs|cjs|ts|js)/g;

/** Package roots a `--cwd`/`working-directory` step could resolve against. */
const packageRoots = (() => {
  const roots = [""];
  const workspaces = (
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      workspaces?: string[];
    }
  ).workspaces;
  for (const pattern of workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      roots.push(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    if (!existsSync(join(repoRoot, base))) continue;
    for (const entry of readdirSync(join(repoRoot, base))) {
      roots.push(`${base}/${entry}`);
    }
  }
  return roots;
})();

function resolves(candidate: string): boolean {
  return packageRoots.some((root) =>
    existsSync(join(repoRoot, root, candidate)),
  );
}

const references: { workflow: string; path: string }[] = [];
for (const file of readdirSync(workflowDir).sort()) {
  if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
  for (const line of readFileSync(join(workflowDir, file), "utf8").split(
    "\n",
  )) {
    // Skip YAML comments: prose may name a suite without invoking it.
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(TEST_PATH)) {
      if (match[0].includes("*")) continue;
      references.push({ workflow: file, path: match[0] });
    }
  }
}

describe("workflow test-path references", () => {
  test("finds references to check", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  test("every named test file exists", () => {
    const dangling = references
      .filter((reference) => !resolves(reference.path))
      .map((reference) => `${reference.workflow}: ${reference.path}`);
    expect(
      [...new Set(dangling)],
      "these workflow steps name test files that no longer exist; bun skips them silently and vitest treats them as filters matching nothing, so the step passes while testing less than it claims",
    ).toEqual([]);
  });
});
