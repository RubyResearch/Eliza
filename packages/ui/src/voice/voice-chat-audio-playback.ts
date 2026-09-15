/**
 * Plays prepared voice audio through the shared Web Audio graph.
 * Provider fetchers own authentication and caching; this module owns the one
 * analyser, playback-reference tap, timeout, teardown, and telemetry lifecycle
 * that every decoded-audio provider must follow.
 */

import { ElizaError } from "@elizaos/core";
import { ttsDebug, ttsDebugTextPreview } from "../utils/tts-debug";
import {
  type PlaybackFramePump,
  type PlaybackFrameTap,
  PlaybackTapLifecycle,
} from "./playback-frame-pump";
import type { SpeakTask, VoicePlaybackStartEvent } from "./voice-chat-types";

interface MutableCell<T> {
  current: T;
}

export interface DecodedVoicePlaybackOptions {
  context: AudioContext;
  audioBuffer: AudioBuffer;
  generation: number;
  generationRef: MutableCell<number>;
  provider: VoicePlaybackStartEvent["provider"];
  text: string;
  task: SpeakTask;
  cached: boolean;
  analyserRef: MutableCell<AnalyserNode | null>;
  timeDomainDataRef: MutableCell<Float32Array<ArrayBuffer> | null>;
  audioSourceRef: MutableCell<AudioBufferSourceNode | null>;
  playbackFrameTapRef: MutableCell<PlaybackFrameTap | null>;
  activeTaskFinishRef: MutableCell<(() => void) | null>;
  speechTimeoutRef: MutableCell<ReturnType<typeof setTimeout> | null>;
  getPlaybackFramePump: () => PlaybackFramePump;
  clearSpeechTimers: () => void;
  emitPlaybackStart: (event: VoicePlaybackStartEvent) => void;
  tracePlayback?: boolean;
}

export async function playDecodedVoiceAudio({
  context,
  audioBuffer,
  generation,
  generationRef,
  provider,
  text,
  task,
  cached,
  analyserRef,
  timeDomainDataRef,
  audioSourceRef,
  playbackFrameTapRef,
  activeTaskFinishRef,
  speechTimeoutRef,
  getPlaybackFramePump,
  clearSpeechTimers,
  emitPlaybackStart,
  tracePlayback = false,
}: DecodedVoicePlaybackOptions): Promise<void> {
  if (generation !== generationRef.current) return;

  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  analyserRef.current = analyser;
  timeDomainDataRef.current = new Float32Array(
    new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
  );

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(context.destination);
  audioSourceRef.current = source;

  // Audible playback must not wait indefinitely for the optional visualizer
  // worklet on first use in a busy WebView.
  const tapPromise = getPlaybackFramePump()
    .tapSource(context, source, audioBuffer)
    .catch((error) => {
      // error-policy:J4 Playback-reference capture is optional; audio remains audible.
      ttsDebug("playback-reference:tap-attach-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const tapLifecycle = new PlaybackTapLifecycle(playbackFrameTapRef);
  await tapLifecycle.attach(tapPromise);
  if (generation !== generationRef.current) {
    tapLifecycle.finish();
    source.disconnect();
    analyser.disconnect();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const playStartMs = performance.now();
    const audioEndsAt = context.currentTime + audioBuffer.duration;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let wrappedFinish: (() => void) | null = null;

    const clearWatchdog = () => {
      if (watchdog === null) return;
      if (speechTimeoutRef.current === watchdog) clearSpeechTimers();
      else clearTimeout(watchdog);
      watchdog = null;
    };

    const closedContextError = () =>
      new ElizaError("Audio playback context closed before speech completed", {
        code: "VOICE_PLAYBACK_CONTEXT_CLOSED",
        context: { provider },
      });

    const finish = (error?: ElizaError) => {
      if (finished) return;
      finished = true;
      context.removeEventListener("statechange", handleContextStateChange);
      clearWatchdog();
      tapLifecycle.finish();
      if (wrappedFinish && activeTaskFinishRef.current === wrappedFinish) {
        activeTaskFinishRef.current = null;
      }
      if (audioSourceRef.current === source) {
        audioSourceRef.current = null;
      }
      source.onended = null;
      try {
        source.disconnect();
      } catch (error) {
        // error-policy:J6 best-effort Web Audio teardown after playback ended.
        ttsDebug("play:web-audio:source-disconnect-failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        analyser.disconnect();
      } catch (error) {
        // error-policy:J6 best-effort Web Audio teardown after playback ended.
        ttsDebug("play:web-audio:analyser-disconnect-failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (error) reject(error);
      else resolve();
    };

    wrappedFinish = () => {
      if (tracePlayback) {
        ttsDebug("play:web-audio:end", {
          provider,
          segment: task.segment,
          elapsedMs: Math.round(performance.now() - playStartMs),
        });
      }
      finish(
        generation === generationRef.current && context.state === "closed"
          ? closedContextError()
          : undefined,
      );
    };

    const armWatchdog = () => {
      clearWatchdog();
      if (finished || context.state !== "running") return;
      // Wall time can advance while the audio clock is paused. Only retire
      // playback once its audio deadline has passed; resume rearms this guard.
      watchdog = setTimeout(
        () => {
          if (finished) return;
          if (generation !== generationRef.current) {
            finish();
          } else if (context.state === "closed") {
            finish(closedContextError());
          } else if (context.currentTime >= audioEndsAt) {
            wrappedFinish?.();
          } else {
            armWatchdog();
          }
        },
        Math.max(
          2500,
          Math.ceil((audioEndsAt - context.currentTime) * 1000) + 1200,
        ),
      );
      speechTimeoutRef.current = watchdog;
    };

    function handleContextStateChange() {
      if (finished) return;
      if (generation !== generationRef.current) finish();
      else if (context.state === "closed") finish(closedContextError());
      else armWatchdog();
    }

    if (tracePlayback) {
      ttsDebug("play:web-audio:start", {
        provider,
        segment: task.segment,
        append: task.append,
        cached,
        textChars: text.length,
        preview: ttsDebugTextPreview(text),
        durationSecApprox: Math.round(audioBuffer.duration * 100) / 100,
      });
    }

    try {
      activeTaskFinishRef.current = wrappedFinish;
      source.onended = wrappedFinish;
      tapLifecycle.start(playStartMs);
      context.addEventListener("statechange", handleContextStateChange);
      if (context.state === "closed") {
        finish(closedContextError());
        return;
      }
      source.start(0);
      handleContextStateChange();
      if (finished) return;
      emitPlaybackStart({
        text,
        segment: task.segment,
        provider,
        cached,
        startedAtMs: playStartMs,
        ...task.telemetry,
      });
    } catch (error) {
      // error-policy:J2 Preserve setup failure after releasing playback ownership.
      finish(
        new ElizaError("Buffered speech playback could not start", {
          code: "VOICE_PLAYBACK_START_FAILED",
          cause: error,
          context: { provider },
        }),
      );
    }
  });
}
