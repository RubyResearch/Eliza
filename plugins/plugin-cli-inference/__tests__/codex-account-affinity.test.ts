/**
 * Exercises the real Codex SDK subprocess boundary with a local protocol probe.
 * The probe reads an account marker from the configured home; no credentials or
 * model service are used. It checks account selection and environment isolation
 * after the adapter and inference launcher have both processed the request.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSdkSession } from "../src/codex-sdk-session";

afterEach(() => vi.unstubAllEnvs());

describe("Codex account selection at the subprocess boundary", () => {
  it.each([false, true])(
    "uses the selected home without ambient secrets (rotated: %s)",
    async (rotated) => {
      const directory = await mkdtemp(join(tmpdir(), "codex-affinity-contract-"));
      let session: CodexSdkSession | undefined;
      try {
        const ambientHome = join(directory, "ambient");
        const selectedHome = join(directory, "selected");
        for (const [home, marker] of [
          [ambientHome, "wrong-account"],
          [selectedHome, "selected-account"],
        ]) {
          await mkdir(home);
          await writeFile(join(home, "account-marker"), marker);
        }
        const probe = join(directory, "codex-probe.mjs");
        await writeFile(
          probe,
          `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const text = JSON.stringify({
  account: readFileSync(join(process.env.CODEX_HOME, "account-marker"), "utf8"),
  secretPresent: "AFFINITY_QA_SECRET" in process.env,
  isolated: ["--ignore-user-config", "--ignore-rules", "--ephemeral"].every(flag => process.argv.includes(flag)),
  completeInput: input.includes("AFFINITY_INPUT_END"),
});
for (const event of [
  { type: "thread.started", thread_id: "affinity-probe" },
  { type: "item.completed", item: { id: "reply", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
]) process.stdout.write(JSON.stringify(event) + "\\n");
`
        );
        await chmod(probe, 0o700);
        vi.stubEnv("CODEX_HOME", rotated ? ambientHome : selectedHome);
        vi.stubEnv("AFFINITY_QA_SECRET", "synthetic-test-sentinel");
        session = new CodexSdkSession({
          model: "protocol-probe",
          codexBinPath: probe,
          ...(rotated
            ? { subprocessEnv: { PATH: process.env.PATH, CODEX_HOME: selectedHome } }
            : {}),
        });
        const response = await session.generate(
          `${"complete context ".repeat(2000)}AFFINITY_INPUT_END`
        );
        expect(JSON.parse(response)).toEqual({
          account: "selected-account",
          secretPresent: false,
          isolated: true,
          completeInput: true,
        });
        expect(process.env.CODEX_HOME).toBe(rotated ? ambientHome : selectedHome);
      } finally {
        session?.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );
});
