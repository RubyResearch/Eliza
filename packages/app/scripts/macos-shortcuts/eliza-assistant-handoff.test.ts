/**
 * Test coverage for macOS Shortcuts handoff automation used by the desktop app
 * shell.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const handoffScript = path.join(here, "eliza-assistant-handoff.sh");
const installScript = path.join(here, "install-eliza-shortcuts.sh");
const verifyScript = path.join(here, "verify-eliza-shortcuts.sh");

describe("macOS Shortcuts assistant handoff", () => {
  it("builds the assistant deep link used by the desktop runtime", async () => {
    const { stdout } = await execFileAsync("sh", [
      handoffScript,
      "--dry-run",
      "Remind me at 5 & call mom",
    ]);

    expect(stdout.trim()).toBe(
      "elizaos://assistant?text=Remind%20me%20at%205%20%26%20call%20mom&source=macos-shortcuts&action=ask",
    );
  });

  it("honors scheme, source, and action overrides", async () => {
    const { stdout } = await execFileAsync("sh", [
      handoffScript,
      "--dry-run",
      "--scheme",
      "eliza",
      "--source",
      "macos-siri",
      "--action",
      "lifeops.create",
      "check in on me tomorrow morning",
    ]);

    expect(stdout.trim()).toBe(
      "eliza://assistant?text=check%20in%20on%20me%20tomorrow%20morning&source=macos-siri&action=lifeops.create",
    );
  });

  it("accepts Shortcut input on stdin", async () => {
    const stdout = await runWithStdin(
      "sh",
      [handoffScript, "--dry-run"],
      "check in on me tomorrow morning",
      { ELIZA_SHORTCUT_ACTION: "lifeops.create" },
    );

    expect(stdout.trim()).toBe(
      "elizaos://assistant?text=check%20in%20on%20me%20tomorrow%20morning&source=macos-shortcuts&action=lifeops.create",
    );
  });

  it("percent-encodes multiline stdin and punctuation deterministically", async () => {
    const stdout = await runWithStdin(
      "sh",
      [handoffScript, "--dry-run"],
      "line one\nit's 100% (done) * now!",
      {},
    );

    expect(stdout.trim()).toBe(
      "elizaos://assistant?text=line%20one%0Ait%27s%20100%25%20%28done%29%20%2A%20now%21&source=macos-shortcuts&action=ask",
    );
  });

  it("rejects invalid URL schemes before opening", async () => {
    await expectCommandFails(
      "sh",
      [handoffScript, "--dry-run", "--scheme", "not a scheme", "hello"],
      /invalid URL scheme/,
    );
  });

  it("installs the handoff and verifier scripts into the configured directory", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-shortcuts-"),
    );

    const probePath = path.join(tempDir, "native-inventory-called");
    const toolsDir = path.join(tempDir, "tools");
    await fs.mkdir(toolsDir);
    await fs.writeFile(
      path.join(toolsDir, "shortcuts"),
      '#!/bin/sh\nprintf called > "$ELIZA_TEST_SHORTCUT_PROBE"\nexit 99\n',
      { mode: 0o755 },
    );
    const helperEnv = {
      ...process.env,
      PATH: `${toolsDir}${path.delimiter}${process.env.PATH}`,
      ELIZA_TEST_SHORTCUT_PROBE: probePath,
    };
    try {
      const { stdout } = await execFileAsync("sh", [installScript], {
        env: {
          ...helperEnv,
          ELIZA_SHORTCUT_INSTALL_DIR: tempDir,
        },
      });

      expect(stdout).toContain(
        "Installed Eliza macOS Shortcuts handoff helper",
      );
      expect(stdout).toContain("PASS helper builds assistant deep links");
      expect(stdout).toContain(
        "PASS multiline stdin and punctuation are percent-encoded",
      );

      const { stdout: verifyStdout } = await execFileAsync(
        "sh",
        [
          verifyScript,
          "--helper",
          path.join(tempDir, "eliza-assistant-handoff.sh"),
          "--helper-only",
        ],
        { env: helperEnv },
      );
      await expect(fs.access(probePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        execFileAsync(
          "sh",
          [
            verifyScript,
            "--helper",
            path.join(tempDir, "eliza-assistant-handoff.sh"),
            "--helper-only",
            "--require-shortcut",
          ],
          { env: helperEnv },
        ),
      ).rejects.toMatchObject({ code: 2 });

      expect(verifyStdout).toContain("PASS helper builds assistant deep links");
      expect(verifyStdout).toContain(
        "PASS multiline stdin and punctuation are percent-encoded",
      );
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });
});

async function expectCommandFails(
  command: string,
  args: string[],
  stderrPattern: RegExp,
): Promise<void> {
  try {
    await execFileAsync(command, args);
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr)
        : "";
    expect(stderr).toMatch(stderrPattern);
    return;
  }
  throw new Error(`${command} unexpectedly succeeded`);
}

function runWithStdin(
  command: string,
  args: string[],
  input: string,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}
