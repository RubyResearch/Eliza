/**
 * Audio PII redaction — execution ops (#14807).
 *
 * Turns merged redaction windows (`@elizaos/shared/audio-redaction`) into
 * redacted audio bytes with the DURATION PRESERVED, so every transcript word
 * anchor stays valid against the redacted variant:
 *
 *  - **Pure-TS WAV lane** (always available, all platforms): PCM16 sample
 *    zeroing (mute) or in-place 1 kHz sine synthesis (bleep) over the span
 *    windows. Byte length and sample count are untouched, so the duration is
 *    preserved EXACTLY and the output is bit-deterministic — the idempotency
 *    property (same input sha + spans ⇒ same output sha) holds by
 *    construction. The voice pipeline's native capture format is 16 kHz mono
 *    PCM16 WAV, so this lane needs no ffmpeg at all.
 *  - **ffmpeg lane** (desktop/server only — iOS/Android/workers have no
 *    ffmpeg, see `MOBILE_PLATFORM_VALUES` in core's runtime-env): lossy
 *    containers (ogg/opus, m4a/aac, mp3, webm) via the empirically verified
 *    filtergraphs — `volume=0:enable='between(t,S,E)+…'` for mute,
 *    `sine=f=1000` + `amix=duration=first:normalize=0` for bleep — run with
 *    `-bitexact` so the output bytes are deterministic for a given ffmpeg
 *    build. Measured on ffmpeg 8.1.1: WAV exact duration + −91 dB true
 *    silence in the window, OGG/opus exact, M4A/AAC up to one trailing
 *    encoder frame (assert with ±(1024/sampleRate)s tolerance). The sample
 *    count within the stream never changes, so span coordinates stay valid.
 *
 * Missing capability is OBSERVABLE, never silent: redacting a lossy container
 * with no ffmpeg on the host throws a typed `AUDIO_REDACTION_UNSUPPORTED`
 * error (WAV keeps working via the pure-TS lane), and any post-redaction
 * duration drift beyond the per-container tolerance throws
 * `AUDIO_REDACTION_DURATION_DRIFT` instead of storing a variant whose anchors
 * would lie. The ffmpeg/ffprobe child is timed and stdio-capped so a hung
 * binary cannot pin the agent process.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import type { AudioRedactionSpan } from "@elizaos/shared/audio-redaction";
import {
  AudioRedactionChildError,
  runAudioRedactionChild,
} from "./audio-redaction-child.ts";

/** How a window is made inaudible. */
export type AudioRedactionMode = "mute" | "bleep";

/** Bleep tone frequency (both lanes use the same tone). */
export const BLEEP_FREQUENCY_HZ = 1000;
/** Bleep amplitude on the pure-TS lane (fraction of full scale). */
export const BLEEP_AMPLITUDE = 0.25;
/** AAC encodes in 1024-sample frames; M4A may carry one extra trailing frame. */
export const AAC_FRAME_SAMPLES = 1024;

/** Containers the ffmpeg lane accepts, mapped to their encoder. */
const FFMPEG_CODEC_BY_EXT: Record<string, string> = {
  wav: "pcm_s16le",
  ogg: "libopus",
  oga: "libopus",
  weba: "libopus",
  webm: "libopus",
  m4a: "aac",
  aac: "aac",
  mp4: "aac",
  mp3: "libmp3lame",
  flac: "flac",
};

/** Containers whose encoder may append trailing padding frames. */
const FRAME_PADDED_EXTS = new Set(["m4a", "aac", "mp4", "mp3"]);

// ---------------------------------------------------------------------------
// Capability probing
// ---------------------------------------------------------------------------

/** Resolve an executable on PATH (with the Windows extension list). */
function whichBin(bin: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let cachedFfmpeg: string | null | undefined;
let cachedFfprobe: string | null | undefined;

/**
 * Locate ffmpeg: `ELIZA_FFMPEG_PATH` override, else PATH probe (same pattern
 * as the mic recorder resolution in plugin-local-inference). Cached; pass
 * `refresh` to re-probe (tests toggle the env override).
 */
export function resolveFfmpegPath(refresh = false): string | null {
  if (cachedFfmpeg === undefined || refresh) {
    const override = process.env.ELIZA_FFMPEG_PATH?.trim();
    cachedFfmpeg =
      override && existsSync(override) ? override : whichBin("ffmpeg");
  }
  return cachedFfmpeg;
}

/** Locate ffprobe (ships beside ffmpeg; needed to probe lossy containers). */
export function resolveFfprobePath(refresh = false): string | null {
  if (cachedFfprobe === undefined || refresh) {
    const override = process.env.ELIZA_FFPROBE_PATH?.trim();
    cachedFfprobe =
      override && existsSync(override) ? override : whichBin("ffprobe");
  }
  return cachedFfprobe;
}

/** What this host can redact. WAV/PCM16 always works; lossy needs ffmpeg. */
export interface AudioRedactionCapability {
  /** Pure-TS PCM16 WAV lane — available on every runtime. */
  wavPcm16: true;
  /** Lossy-container lane — requires ffmpeg + ffprobe on the host. */
  lossyContainers: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
}

/** Probe the host's redaction capability (desktop/server has ffmpeg; mobile
 *  and workers do not — their lossy redaction fails typed, never silently). */
export function audioRedactionCapability(): AudioRedactionCapability {
  const ffmpegPath = resolveFfmpegPath();
  const ffprobePath = resolveFfprobePath();
  return {
    wavPcm16: true,
    lossyContainers: ffmpegPath !== null && ffprobePath !== null,
    ffmpegPath,
    ffprobePath,
  };
}

// ---------------------------------------------------------------------------
// Pure-TS PCM16 WAV lane
// ---------------------------------------------------------------------------

/** Parsed PCM16 WAV geometry (throws typed on anything else). */
export interface WavPcm16Info {
  sampleRate: number;
  channels: number;
  /** Byte offset of the first sample in the `data` chunk. */
  dataOffset: number;
  /** Byte length of the `data` chunk. */
  dataBytes: number;
  /** Samples per channel. */
  frameCount: number;
  durationMs: number;
}

function invalidInput(message: string, context?: Record<string, unknown>) {
  return new ElizaError(`audio redaction input invalid: ${message}`, {
    code: "AUDIO_REDACTION_INPUT_INVALID",
    context,
  });
}

/**
 * Strict RIFF/WAVE parse for 16-bit PCM (format tag 1, or EXTENSIBLE with the
 * PCM subformat). Walks the chunk list, so files with LIST/fact chunks parse.
 * Anything else throws `AUDIO_REDACTION_INPUT_INVALID` — the caller may fall
 * back to the ffmpeg lane when the host has one.
 */
export function parseWavPcm16(bytes: Buffer): WavPcm16Info {
  if (bytes.length < 44) throw invalidInput("too short to be a WAV file");
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw invalidInput("not a RIFF/WAVE file");
  }
  const declaredRiffBytes = bytes.readUInt32LE(4) + 8;
  if (declaredRiffBytes !== bytes.length) {
    throw invalidInput(
      `RIFF length ${declaredRiffBytes} does not match buffer length ${bytes.length}`,
    );
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let formatTag = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  let fmtChunks = 0;
  let dataChunks = 0;
  let declaredByteRate = 0;
  let declaredBlockAlign = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    const paddedEnd = body + chunkSize + (chunkSize % 2);
    if (body + chunkSize > bytes.length || paddedEnd > bytes.length) {
      throw invalidInput(
        `chunk ${JSON.stringify(chunkId)} exceeds RIFF bounds`,
      );
    }
    if (chunkId === "fmt ") {
      fmtChunks += 1;
      if (fmtChunks !== 1) throw invalidInput("multiple fmt chunks");
      if (chunkSize < 16)
        throw invalidInput("fmt chunk is shorter than 16 bytes");
      formatTag = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      declaredByteRate = bytes.readUInt32LE(body + 8);
      declaredBlockAlign = bytes.readUInt16LE(body + 12);
      bitsPerSample = bytes.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the
      // 16-byte SubFormat GUID inside the extension.
      if (
        formatTag === 0xfffe &&
        chunkSize >= 40 &&
        body + 26 <= bytes.length
      ) {
        formatTag = bytes.readUInt16LE(body + 24);
      }
    } else if (chunkId === "data") {
      dataChunks += 1;
      if (dataChunks !== 1) {
        throw invalidInput(
          "multiple data chunks are ambiguous and could retain unredacted samples",
        );
      }
      dataOffset = body;
      dataBytes = chunkSize;
    }
    offset = paddedEnd; // chunks are word-aligned
  }
  if (offset !== bytes.length)
    throw invalidInput("trailing partial WAV chunk header");
  if (fmtChunks !== 1) throw invalidInput("missing fmt chunk");
  if (dataOffset < 0) throw invalidInput("no data chunk");
  if (formatTag !== 1) {
    throw invalidInput(`unsupported WAV format tag ${formatTag} (want PCM)`, {
      formatTag,
      fallbackEligible: true,
    });
  }
  if (bitsPerSample !== 16) {
    throw invalidInput(`unsupported bits per sample ${bitsPerSample}`, {
      bitsPerSample,
      fallbackEligible: true,
    });
  }
  if (channels < 1 || sampleRate <= 0) {
    throw invalidInput("invalid channel count or sample rate", {
      channels,
      sampleRate,
    });
  }
  const bytesPerFrame = 2 * channels;
  if (
    declaredBlockAlign !== bytesPerFrame ||
    declaredByteRate !== sampleRate * bytesPerFrame
  ) {
    throw invalidInput(
      "WAV byte-rate or block-align does not match PCM16 geometry",
    );
  }
  if (dataBytes === 0 || dataBytes % bytesPerFrame !== 0) {
    throw invalidInput("WAV data chunk is empty or not frame-aligned");
  }
  const frameCount = dataBytes / bytesPerFrame;
  return {
    sampleRate,
    channels,
    dataOffset,
    dataBytes,
    frameCount,
    durationMs: (frameCount / sampleRate) * 1000,
  };
}

/**
 * Redact a PCM16 WAV entirely in TypeScript: samples inside each window are
 * zeroed (mute) or replaced with a {@link BLEEP_FREQUENCY_HZ} sine (bleep) on
 * every channel. The buffer geometry is untouched — byte length, sample
 * count, and therefore duration are preserved EXACTLY, and the output is
 * bit-deterministic (the sine phase is anchored to the absolute frame index).
 */
export function redactWavPcm16(
  bytes: Buffer,
  spans: readonly AudioRedactionSpan[],
  mode: AudioRedactionMode,
): Buffer {
  const info = parseWavPcm16(bytes);
  const out = Buffer.from(bytes); // copy — the store's original is immutable
  const bytesPerFrame = 2 * info.channels;
  for (const span of spans) {
    assertSpanOverlapsDuration(span, info.durationMs);
    const startFrame = Math.max(
      0,
      Math.floor((span.startMs / 1000) * info.sampleRate),
    );
    const endFrame = Math.min(
      info.frameCount,
      Math.ceil((span.endMs / 1000) * info.sampleRate),
    );
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const value =
        mode === "mute"
          ? 0
          : Math.round(
              BLEEP_AMPLITUDE *
                32767 *
                Math.sin(
                  (2 * Math.PI * BLEEP_FREQUENCY_HZ * frame) / info.sampleRate,
                ),
            );
      const frameOffset = info.dataOffset + frame * bytesPerFrame;
      for (let channel = 0; channel < info.channels; channel += 1) {
        out.writeInt16LE(value, frameOffset + channel * 2);
      }
    }
  }
  return out;
}

function assertSpanOverlapsDuration(
  span: AudioRedactionSpan,
  durationMs: number,
): void {
  if (span.startMs >= durationMs || span.endMs <= 0) {
    throw invalidInput(
      `span ${span.startMs}..${span.endMs} does not overlap audio duration ${durationMs}`,
      { durationMs },
    );
  }
}

// ---------------------------------------------------------------------------
// ffmpeg lane
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(
  bin: string,
  args: readonly string[],
  stdoutFd?: number,
): Promise<SpawnResult> {
  try {
    return await runAudioRedactionChild(bin, args, { stdoutFd });
  } catch (error) {
    // error-policy:J2 wrap the isolated child failure as the typed domain error
    // the redaction lanes already surface to callers.
    if (error instanceof AudioRedactionChildError) {
      throw new ElizaError(error.message, { code: error.code, cause: error });
    }
    throw new ElizaError("audio redaction child process failed", {
      code: "AUDIO_REDACTION_FFMPEG_FAILED",
      cause: error,
    });
  }
}

/** Probed stream geometry of an audio file. */
export interface ProbedAudio {
  durationMs: number;
  sampleRate: number;
  channels: number;
}

/** Probe duration/rate/channels with ffprobe (throws typed on failure). */
export async function probeAudioFile(filePath: string): Promise<ProbedAudio> {
  const ffprobe = resolveFfprobePath();
  if (!ffprobe) {
    throw new ElizaError("audio redaction unsupported: ffprobe not found", {
      code: "AUDIO_REDACTION_UNSUPPORTED",
    });
  }
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-ffprobe-"));
  const outputPath = path.join(probeDir, "probe.json");
  let probeJson = "";
  try {
    const output = await fs.open(outputPath, "wx", 0o600);
    let result: SpawnResult;
    try {
      result = await run(
        ffprobe,
        [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=sample_rate,channels:format=duration",
          "-of",
          "json",
          filePath,
        ],
        output.fd,
      );
    } finally {
      await output.close();
    }
    if (result.code !== 0) {
      throw new ElizaError(`ffprobe failed: ${result.stderr.trim()}`, {
        code: "AUDIO_REDACTION_FFMPEG_FAILED",
        context: { filePath },
      });
    }
    probeJson = await fs.readFile(outputPath, "utf8");
  } finally {
    try {
      await fs.rm(probeDir, { recursive: true, force: true });
    } catch (error) {
      // error-policy:J6 best-effort probe output cleanup.
      logger.warn(
        {
          probeDir,
          error: error instanceof Error ? error.message : String(error),
        },
        "[audio-redaction] ffprobe temporary directory cleanup failed",
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(probeJson);
  } catch (error) {
    // error-policy:J2 Preserve malformed ffprobe output as a typed provider
    // failure rather than casting it into a healthy stream shape.
    throw new ElizaError("ffprobe returned malformed JSON", {
      code: "AUDIO_REDACTION_FFMPEG_FAILED",
      cause: error,
      context: {
        filePath,
        outputBytes: Buffer.byteLength(probeJson),
      },
    });
  }
  const root = parsed as {
    streams?: Array<{ sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const stream = root.streams?.[0];
  const sampleRate = Number.parseInt(stream?.sample_rate ?? "", 10);
  const channels = stream?.channels ?? 0;
  const durationSec = Number.parseFloat(root.format?.duration ?? "");
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(durationSec) ||
    channels < 1
  ) {
    throw invalidInput("ffprobe returned no usable audio stream", {
      filePath,
    });
  }
  return { durationMs: durationSec * 1000, sampleRate, channels };
}

/** Sum-of-`between()` timeline expression over the merged windows. */
function betweenExpression(spans: readonly AudioRedactionSpan[]): string {
  return spans
    .map(
      (span) =>
        `between(t,${(span.startMs / 1000).toFixed(3)},${(span.endMs / 1000).toFixed(3)})`,
    )
    .join("+");
}

function ffmpegArgs(
  inPath: string,
  outPath: string,
  ext: string,
  spans: readonly AudioRedactionSpan[],
  mode: AudioRedactionMode,
  probed: ProbedAudio,
): string[] {
  const codec = FFMPEG_CODEC_BY_EXT[ext];
  if (!codec) {
    throw invalidInput(`unsupported container .${ext}`, { ext });
  }
  const expr = betweenExpression(spans);
  const common = ["-hide_banner", "-y", "-v", "error", "-bitexact"];
  if (mode === "mute") {
    return [
      ...common,
      "-i",
      inPath,
      "-af",
      `volume=0:enable='${expr}'`,
      "-c:a",
      codec,
      "-fflags",
      "+bitexact",
      outPath,
    ];
  }
  // Bleep: gate the original OFF and a 1 kHz sine ON inside the windows, then
  // mix with duration=first so the output length follows the original input.
  const layout = probed.channels === 1 ? "mono" : "stereo";
  return [
    ...common,
    "-i",
    inPath,
    "-f",
    "lavfi",
    "-i",
    `sine=f=${BLEEP_FREQUENCY_HZ}:r=${probed.sampleRate}`,
    "-filter_complex",
    `[0:a]volume=0:enable='${expr}'[dry];` +
      `[1:a]aformat=channel_layouts=${layout},volume=0:enable='not(${expr})'[tone];` +
      `[dry][tone]amix=inputs=2:duration=first:normalize=0[out]`,
    "-map",
    "[out]",
    "-c:a",
    codec,
    "-fflags",
    "+bitexact",
    outPath,
  ];
}

// ---------------------------------------------------------------------------
// Duration preservation contract
// ---------------------------------------------------------------------------

/**
 * Allowed |output − input| duration drift for a container. WAV and ogg/opus
 * re-encode to the exact duration (measured); frame-padded encoders (AAC in
 * m4a/mp4, mp3) may append up to one encoder frame — ±(1024/sampleRate)s per
 * the issue's empirical matrix — plus 2 ms of ffprobe float slack.
 */
export function durationToleranceMs(ext: string, sampleRate: number): number {
  const probeSlackMs = 2;
  if (FRAME_PADDED_EXTS.has(ext)) {
    return (AAC_FRAME_SAMPLES / sampleRate) * 1000 + probeSlackMs;
  }
  return probeSlackMs;
}

/** Assert the redacted variant kept the original duration (throws typed). */
export function assertDurationPreserved(
  inputDurationMs: number,
  outputDurationMs: number,
  ext: string,
  sampleRate: number,
): void {
  const toleranceMs = durationToleranceMs(ext, sampleRate);
  const driftMs = Math.abs(outputDurationMs - inputDurationMs);
  if (driftMs > toleranceMs) {
    throw new ElizaError(
      `audio redaction changed duration by ${driftMs.toFixed(3)}ms ` +
        `(tolerance ${toleranceMs.toFixed(3)}ms for .${ext}) — ` +
        "transcript anchors would be invalid",
      {
        code: "AUDIO_REDACTION_DURATION_DRIFT",
        context: { inputDurationMs, outputDurationMs, ext, toleranceMs },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Request for {@link redactAudioBytes}. */
export interface RedactAudioRequest {
  /** Original audio bytes (from the content-addressed media store). */
  bytes: Buffer;
  /** Container extension (`wav`, `ogg`, `m4a`, …) — the store's file ext. */
  containerExt: string;
  /** Merged, non-overlapping windows from the span-merge module. */
  spans: readonly AudioRedactionSpan[];
  mode: AudioRedactionMode;
}

/** Result of one redaction op. */
export interface RedactAudioResult {
  bytes: Buffer;
  lane: "pure-ts-wav" | "ffmpeg";
  inputDurationMs: number;
  outputDurationMs: number;
  containerExt: string;
  sampleRate: number;
}

/**
 * Redact the given audio: PCM16 WAV rides the pure-TS lane (deterministic,
 * duration byte-exact, works on every runtime); everything else rides ffmpeg
 * when the host has it and throws `AUDIO_REDACTION_UNSUPPORTED` when it does
 * not (mobile/workers) — observable, never a silent skip. Every path asserts
 * the duration-preservation contract before returning bytes.
 */
export async function redactAudioBytes(
  request: RedactAudioRequest,
): Promise<RedactAudioResult> {
  const ext = request.containerExt.trim().toLowerCase();
  if (request.spans.length === 0) {
    throw invalidInput("no redaction spans — nothing to redact", { ext });
  }
  for (const span of request.spans) {
    if (
      !Number.isFinite(span.startMs) ||
      !Number.isFinite(span.endMs) ||
      span.startMs < 0 ||
      span.endMs <= span.startMs
    ) {
      throw invalidInput(
        `malformed span ${span.startMs}..${span.endMs} (run mergeRedactionSpans first)`,
        { ext },
      );
    }
  }

  // Pure-TS WAV lane first: deterministic and dependency-free.
  if (ext === "wav") {
    try {
      const info = parseWavPcm16(request.bytes);
      const bytes = redactWavPcm16(request.bytes, request.spans, request.mode);
      logger.info(
        `[audio-redaction] pure-ts-wav ${request.mode} of ${request.spans.length} span(s), ` +
          `${info.durationMs.toFixed(1)}ms preserved exactly`,
      );
      return {
        bytes,
        lane: "pure-ts-wav",
        inputDurationMs: info.durationMs,
        outputDurationMs: info.durationMs, // geometry untouched by construction
        containerExt: ext,
        sampleRate: info.sampleRate,
      };
    } catch (err) {
      // error-policy:J1 This executor boundary translates only the typed
      // unsupported-encoding case into the alternate ffmpeg lane.
      // A WAV that is not PCM16 (float, ADPCM) falls to the ffmpeg lane below;
      // genuinely corrupt input rethrows there as an ffmpeg/probe failure.
      if (
        !(err instanceof ElizaError) ||
        err.context?.fallbackEligible !== true
      ) {
        throw err;
      }
      logger.warn(
        `[audio-redaction] WAV not pure-TS redactable (${err.message}); trying ffmpeg lane`,
      );
    }
  }

  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg || !resolveFfprobePath()) {
    throw new ElizaError(
      `audio redaction unsupported: .${ext} needs ffmpeg and this host has none ` +
        "(mobile/worker runtimes cannot redact lossy audio)",
      { code: "AUDIO_REDACTION_UNSUPPORTED", context: { ext } },
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-pii-audio-"));
  const inPath = path.join(workDir, `in.${ext}`);
  const outPath = path.join(workDir, `out.${ext}`);
  try {
    await fs.writeFile(inPath, request.bytes);
    const probed = await probeAudioFile(inPath);
    for (const span of request.spans) {
      assertSpanOverlapsDuration(span, probed.durationMs);
    }
    const args = ffmpegArgs(
      inPath,
      outPath,
      ext,
      request.spans,
      request.mode,
      probed,
    );
    const result = await run(ffmpeg, args);
    if (result.code !== 0) {
      throw new ElizaError(`ffmpeg redaction failed: ${result.stderr.trim()}`, {
        code: "AUDIO_REDACTION_FFMPEG_FAILED",
        context: { ext, mode: request.mode },
      });
    }
    const outProbed = await probeAudioFile(outPath);
    assertDurationPreserved(
      probed.durationMs,
      outProbed.durationMs,
      ext,
      probed.sampleRate,
    );
    const bytes = await fs.readFile(outPath);
    logger.info(
      `[audio-redaction] ffmpeg ${request.mode} of ${request.spans.length} span(s) on .${ext}, ` +
        `duration ${probed.durationMs.toFixed(1)}ms → ${outProbed.durationMs.toFixed(1)}ms (within tolerance)`,
    );
    return {
      bytes,
      lane: "ffmpeg",
      inputDurationMs: probed.durationMs,
      outputDurationMs: outProbed.durationMs,
      containerExt: ext,
      sampleRate: probed.sampleRate,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch (error) {
      // error-policy:J6 best-effort temp cleanup — a leaked temp dir is not a
      // redaction failure; the OS temp cleaner owns it eventually.
      logger.warn(
        {
          workDir,
          error: error instanceof Error ? error.message : String(error),
        },
        "[audio-redaction] temporary directory cleanup failed",
      );
    }
  }
}
