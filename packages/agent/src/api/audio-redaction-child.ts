/**
 * Bounds child-process execution for audio redaction's ffmpeg/ffprobe lane.
 *
 * The timeout and combined stdio budget prevent malformed media or a stuck
 * binary from pinning the agent or growing its memory use without limit.
 * Callers may redirect complete stdout to their own file descriptor; stderr
 * remains bounded and this runner never closes the caller-owned descriptor.
 */

import { spawn } from "node:child_process";

/** Default wall-clock budget for one ffprobe/ffmpeg invocation. */
export const AUDIO_REDACTION_CHILD_TIMEOUT_MS = 30_000;

/** Combined stdout+stderr budget before the child is killed. */
export const MAX_AUDIO_REDACTION_STDIO_BYTES = 1_048_576;

export type AudioRedactionChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type AudioRedactionChildErrorCode =
  | "AUDIO_REDACTION_TIMEOUT"
  | "AUDIO_REDACTION_STDIO_OVERFLOW";

export class AudioRedactionChildError extends Error {
  readonly code: AudioRedactionChildErrorCode;

  constructor(message: string, code: AudioRedactionChildErrorCode) {
    super(message);
    this.name = "AudioRedactionChildError";
    this.code = code;
  }
}

/**
 * Spawn `bin` and collect utf8 stdio until exit, timeout, or the byte cap.
 */
export function runAudioRedactionChild(
  bin: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    maxStdioBytes?: number;
    stdoutFd?: number;
  } = {},
): Promise<AudioRedactionChildResult> {
  const timeoutMs = options.timeoutMs ?? AUDIO_REDACTION_CHILD_TIMEOUT_MS;
  const maxStdioBytes =
    options.maxStdioBytes ?? MAX_AUDIO_REDACTION_STDIO_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", options.stdoutFd ?? "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdioBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new AudioRedactionChildError(
          `audio redaction child timed out after ${timeoutMs}ms`,
          "AUDIO_REDACTION_TIMEOUT",
        ),
      );
    }, timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      stdioBytes += chunk.byteLength;
      if (stdioBytes > maxStdioBytes) {
        fail(
          new AudioRedactionChildError(
            `audio redaction child exceeded ${maxStdioBytes} bytes of stdio`,
            "AUDIO_REDACTION_STDIO_OVERFLOW",
          ),
        );
        return;
      }
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    if (!child.stderr || (options.stdoutFd === undefined && !child.stdout)) {
      fail(
        new Error(
          "audio redaction child did not expose its required stdio pipes",
        ),
      );
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.stdout?.once("error", fail);
    child.stderr.once("error", fail);
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
