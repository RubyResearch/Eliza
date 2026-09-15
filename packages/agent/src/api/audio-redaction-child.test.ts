/**
 * Isolated hang/overflow tests for the audio-redaction child runner. Spawns
 * real runtime children; does not import ffmpeg or the media store.
 */
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAudioRedactionChild } from "./audio-redaction-child.ts";

describe("runAudioRedactionChild", () => {
  it("kills a hung child at the timeout instead of waiting forever", async () => {
    const startedAt = Date.now();
    await expect(
      runAudioRedactionChild(
        process.execPath,
        ["-e", "setTimeout(() => {}, 8_000)"],
        { timeoutMs: 200 },
      ),
    ).rejects.toMatchObject({
      name: "AudioRedactionChildError",
      code: "AUDIO_REDACTION_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it("rejects a child that dumps more than the stdio budget", async () => {
    await expect(
      runAudioRedactionChild(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(4096))"],
        { timeoutMs: 2000, maxStdioBytes: 1024 },
      ),
    ).rejects.toMatchObject({
      name: "AudioRedactionChildError",
      code: "AUDIO_REDACTION_STDIO_OVERFLOW",
    });
  });

  it("returns stdout from a last-fit short child", async () => {
    const result = await runAudioRedactionChild(
      process.execPath,
      ["-e", "process.stdout.write('ok')"],
      { timeoutMs: 2000, maxStdioBytes: 1024 },
    );
    expect(result).toMatchObject({ code: 0, stdout: "ok" });
  });
  it("writes complete stdout to the caller file beyond the capture budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audio-child-output-"));
    const output = await open(join(dir, "out"), "wx", 0o600);
    try {
      const expected = "🦊complete\n".repeat(200000);
      const result = await runAudioRedactionChild(
        process.execPath,
        ["-e", "process.stdout.write('🦊complete\\n'.repeat(200000))"],
        { stdoutFd: output.fd, timeoutMs: 10000, maxStdioBytes: 1024 },
      );
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      await output.write("caller still owns the file");
      expect(await readFile(join(dir, "out"), "utf8")).toBe(
        expected + "caller still owns the file",
      );
      const failure = await runAudioRedactionChild(
        process.execPath,
        ["-e", "process.stderr.write('probe failed'); process.exitCode = 7"],
        { stdoutFd: output.fd, timeoutMs: 10000 },
      );
      expect(failure).toEqual({ code: 7, stdout: "", stderr: "probe failed" });
      await expect(
        runAudioRedactionChild(
          process.execPath,
          ["-e", "process.stderr.write('x'.repeat(4096))"],
          { stdoutFd: output.fd, timeoutMs: 10000, maxStdioBytes: 1024 },
        ),
      ).rejects.toMatchObject({ code: "AUDIO_REDACTION_STDIO_OVERFLOW" });
    } finally {
      await output.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
