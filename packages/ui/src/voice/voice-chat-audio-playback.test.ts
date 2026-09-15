/** Exercises the real buffered playback owner with independently controlled audio and wall clocks. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaybackFramePump } from "./playback-frame-pump";
import { playDecodedVoiceAudio } from "./voice-chat-audio-playback";

type Options = Parameters<typeof playDecodedVoiceAudio>[0];

class ControlledAudioContext extends EventTarget {
  static instances: ControlledAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  analyser = { connect: vi.fn(), disconnect: vi.fn() };
  source = {
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    onended: null as (() => void) | null,
  };
  constructor() {
    super();
    ControlledAudioContext.instances.push(this);
  }
  createAnalyser() {
    return this.analyser;
  }
  createBufferSource() {
    return this.source;
  }
  createBuffer() {
    return { duration: 2 };
  }
  transition(state: AudioContextState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function setup(shared?: Options) {
  const context = new AudioContext();
  const controlled = ControlledAudioContext.instances.at(-1);
  if (!controlled) throw new Error("Missing controlled audio context");
  const pump = new PlaybackFramePump();
  vi.spyOn(pump, "tapSource").mockResolvedValue(null);
  const speechTimeoutRef = shared?.speechTimeoutRef ?? { current: null };
  const options: Options = {
    context,
    audioBuffer: context.createBuffer(1, 2000, 1000),
    generation: shared?.generationRef.current ?? 0,
    generationRef: shared?.generationRef ?? { current: 0 },
    provider: "local-inference",
    text: "Synthetic complete reply",
    task: { text: "Synthetic complete reply", segment: "full", append: false },
    cached: false,
    analyserRef: shared?.analyserRef ?? { current: null },
    timeDomainDataRef: shared?.timeDomainDataRef ?? { current: null },
    audioSourceRef: shared?.audioSourceRef ?? { current: null },
    playbackFrameTapRef: shared?.playbackFrameTapRef ?? { current: null },
    activeTaskFinishRef: shared?.activeTaskFinishRef ?? { current: null },
    speechTimeoutRef,
    getPlaybackFramePump: () => pump,
    clearSpeechTimers: () => {
      if (speechTimeoutRef.current !== null) {
        clearTimeout(speechTimeoutRef.current);
        speechTimeoutRef.current = null;
      }
    },
    emitPlaybackStart: vi.fn(),
  };
  return { controlled, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  ControlledAudioContext.instances = [];
  vi.stubGlobal("AudioContext", ControlledAudioContext);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps paused PCM connected past the wall deadline and completes after resumed audio ends", async () => {
  const { controlled, options } = setup();
  const settled = vi.fn();
  const result = playDecodedVoiceAudio(options).then(settled);
  await vi.advanceTimersByTimeAsync(0);
  controlled.currentTime = 0.2;
  controlled.transition("suspended");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled).not.toHaveBeenCalled();
  expect(controlled.source.disconnect).not.toHaveBeenCalled();
  controlled.transition("running");
  controlled.currentTime = 2;
  controlled.source.onended?.();
  await result;
  expect(settled).toHaveBeenCalledTimes(1);
  expect(controlled.source.disconnect).toHaveBeenCalledTimes(1);
});

it("retains the watchdog after the audio deadline when a running source omits ended", async () => {
  const { controlled, options } = setup();
  const result = playDecodedVoiceAudio(options);
  await vi.advanceTimersByTimeAsync(0);
  controlled.currentTime = 2;
  await vi.advanceTimersByTimeAsync(3200);
  await result;
  expect(controlled.source.disconnect).toHaveBeenCalledTimes(1);
});

it("does not let cancelled context events or stale finish callbacks retire the next task", async () => {
  const old = setup();
  const previous = playDecodedVoiceAudio(old.options);
  await vi.advanceTimersByTimeAsync(0);
  old.controlled.transition("suspended");
  const cancel = old.options.activeTaskFinishRef.current;
  if (!cancel) throw new Error("Missing playback cancellation owner");
  old.options.generationRef.current += 1;
  cancel();
  await previous;
  const next = setup(old.options);
  const settled = vi.fn();
  const result = playDecodedVoiceAudio(next.options).then(settled);
  await vi.advanceTimersByTimeAsync(0);
  cancel();
  old.controlled.transition("running");
  old.controlled.transition("closed");
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).not.toHaveBeenCalled();
  expect(next.controlled.source.disconnect).not.toHaveBeenCalled();
  // The next task still owns its watchdog even if its native ended is absent.
  next.controlled.currentTime = 2;
  await vi.advanceTimersByTimeAsync(2200);
  await result;
  expect(next.controlled.source.disconnect).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "rejects a closed context truthfully (closed before start: %s)",
  async (closedBeforeStart) => {
    const { controlled, options } = setup();
    if (closedBeforeStart) controlled.transition("closed");
    const result = playDecodedVoiceAudio(options);
    const rejected = expect(result).rejects.toMatchObject({
      code: "VOICE_PLAYBACK_CONTEXT_CLOSED",
    });
    await vi.advanceTimersByTimeAsync(0);
    if (!closedBeforeStart) controlled.transition("closed");
    await rejected;
    expect(controlled.source.disconnect).toHaveBeenCalledTimes(1);
    if (closedBeforeStart) {
      expect(controlled.source.start).not.toHaveBeenCalled();
      expect(options.emitPlaybackStart).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controlled.source.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("cleans failed source startup and preserves the native cause without reporting playback started", async () => {
  const { controlled, options } = setup();
  const cause = new DOMException("Source already started", "InvalidStateError");
  controlled.source.start.mockImplementation(() => {
    throw cause;
  });
  await expect(playDecodedVoiceAudio(options)).rejects.toMatchObject({
    code: "VOICE_PLAYBACK_START_FAILED",
    cause,
  });
  expect(options.emitPlaybackStart).not.toHaveBeenCalled();
  expect(controlled.source.disconnect).toHaveBeenCalledTimes(1);
  controlled.transition("closed");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(controlled.source.disconnect).toHaveBeenCalledTimes(1);
});
