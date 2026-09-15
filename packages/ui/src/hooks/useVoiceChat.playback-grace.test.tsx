/** Verifies useVoiceChat playback is decoupled from the visualizer worklet (#16102) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Playback/worklet decoupling regression guard (#16102): audible TTS playback
 * must never be gated on the visualizer AudioWorklet module load. Drives the
 * real hook + real PlaybackFramePump against a fake Web Audio graph whose
 * `audioWorklet.addModule` timing the test controls: a hung module load must
 * still let `source.start()` fire after the short grace window, and a fast
 * worklet tap must attach inside the grace and reset the reference stream on
 * finish. Also proves `warmPlaybackWorklet` preloads the module once at
 * AudioContext creation instead of paying the load inline on first speak.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
}));

import { useVoiceChat } from "./useVoiceChat";

interface FakeSource {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

const createdSources: FakeSource[] = [];
const createdWorkletNodes: FakeAudioWorkletNode[] = [];

// The worklet module load is the variable under test. Each test decides when
// (or whether) `addModule` resolves via this deferred.
let resolveWorkletModule: (() => void) | null = null;
const addModule = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveWorkletModule = resolve;
    }),
);

class FakeAudioWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null } = {
    onmessage: null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    createdWorkletNodes.push(this);
  }
}

class FakeAudioContext extends EventTarget {
  currentTime = 0;
  state = "running";
  destination = {};
  audioWorklet = { addModule };
  resume = vi.fn(async () => {});
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0)),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createBufferSource = vi.fn((): FakeSource => {
    const source: FakeSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      onended: null,
    };
    createdSources.push(source);
    return source;
  });
  decodeAudioData = vi.fn(async () => ({
    duration: 0.04,
    sampleRate: 16_000,
    length: 640,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(640).fill(0.25),
  }));
  close = vi.fn(async () => {});
}

interface PlaybackFramesBody {
  frames?: unknown[];
  reset?: boolean;
}

const playbackFrameBodies: PlaybackFramesBody[] = [];
const fetchedUrls: string[] = [];

// One test needs the cloud TTS proxy to reject so it can prove the
// same-engine ElevenLabs fallback (cloud proxy -> direct proxy) fires; every
// other test leaves this at 200. A separate flag drives a non-recoverable
// 500 to prove the eliza-cloud path fails closed (#12253) instead of
// silently swapping to a different voice engine.
let cloudTtsStatus = 200;
let cloudTtsHardFailure = false;
let elevenlabsProxyStatus = 200;

function installMocks() {
  fetchWithCsrf.mockReset();
  cloudTtsStatus = 200;
  cloudTtsHardFailure = false;
  elevenlabsProxyStatus = 200;
  fetchedUrls.length = 0;
  fetchWithCsrf.mockImplementation(
    async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      fetchedUrls.push(url);
      if (url.includes("/api/tts/cloud")) {
        if (cloudTtsHardFailure) {
          return new Response("internal error", { status: 500 });
        }
        if (cloudTtsStatus !== 200) {
          return new Response("blocked", { status: cloudTtsStatus });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      if (url.includes("/api/tts/elevenlabs")) {
        if (elevenlabsProxyStatus !== 200) {
          return new Response("unavailable", { status: elevenlabsProxyStatus });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      if (url.includes("/api/tts/local-inference")) {
        return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      if (url.includes("/api/voice/playback-frames")) {
        playbackFrameBodies.push(
          JSON.parse(String(init?.body)) as PlaybackFramesBody,
        );
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected endpoint", { status: 404 });
    },
  );
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: FakeAudioWorkletNode,
  });
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:playback-worklet"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  }
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  ) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
}

function renderVoiceChat(
  voiceConfig: Parameters<typeof useVoiceChat>[0]["voiceConfig"] = {
    provider: "eliza-cloud",
  },
) {
  return renderHook(() =>
    useVoiceChat({
      onTranscript: vi.fn(),
      voiceConfig,
    }),
  );
}

// The three tests share the module-level shared AudioContext singleton, so they
// are order-dependent by design: the first speak creates the context (warm
// preload with a HUNG module), the second resolves that same module promise.
describe("useVoiceChat playback is decoupled from the visualizer worklet (#16102)", () => {
  beforeEach(() => {
    installMocks();
    createdSources.length = 0;
    createdWorkletNodes.length = 0;
    playbackFrameBodies.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts audible playback after the grace window while the worklet module load hangs", async () => {
    const { result } = renderVoiceChat();

    act(() => {
      result.current.speak("hello grace window");
    });

    // Playback must start even though addModule never resolved.
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });

    // warmPlaybackWorklet preloaded the module exactly once at AudioContext
    // creation; tapSource reuses the same pending promise instead of paying a
    // second load.
    expect(addModule).toHaveBeenCalledTimes(1);
    // With the load hung, no worklet tap could have been constructed yet.
    expect(createdWorkletNodes).toHaveLength(0);

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
  });

  it("attaches a fast worklet tap inside the grace and resets the reference stream on finish", async () => {
    // Resolve the module promise captured by the first test's warm preload;
    // the shared AudioContext now has a loaded worklet, so tapSource resolves
    // well inside the 150 ms grace.
    expect(resolveWorkletModule).not.toBeNull();
    resolveWorkletModule?.();

    const { result } = renderVoiceChat();

    act(() => {
      result.current.speak("hello fast tap");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    // The worklet tap attached and is wired into the source graph. (Resolving
    // the module also lets the FIRST test's stale pending tapSource construct
    // its node, so assert on this source's wiring, not the node count.)
    const tapNode = createdWorkletNodes.find((node) =>
      createdSources[0]?.connect.mock.calls.some(([arg]) => arg === node),
    );
    expect(tapNode).toBeDefined();
    // Still only the single warm preload — no per-utterance module loads.
    expect(addModule).toHaveBeenCalledTimes(1);

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    // Finishing playback stops the tap with reset so the far-end reference
    // stream is cleared for the next utterance.
    await waitFor(() => {
      expect(playbackFrameBodies.some((body) => body.reset === true)).toBe(
        true,
      );
    });
  });

  // The tap-attach-and-lifecycle glue (PlaybackTapLifecycle) is duplicated
  // verbatim across the eliza-cloud, local-inference, and elevenlabs speak
  // paths (#16102). The two tests above already prove the eliza-cloud
  // call site; these drive the other two so the shared lifecycle is
  // exercised, not just imported, at every call site.
  it("starts audible local-inference playback and attaches the tap inside the grace window", async () => {
    expect(resolveWorkletModule).not.toBeNull();
    resolveWorkletModule?.();

    const { result } = renderVoiceChat({ provider: "local-inference" });

    act(() => {
      result.current.speak("hello local inference");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    const tapNode = createdWorkletNodes.find((node) =>
      createdSources[0]?.connect.mock.calls.some(([arg]) => arg === node),
    );
    expect(tapNode).toBeDefined();

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    await waitFor(() => {
      expect(playbackFrameBodies.some((body) => body.reset === true)).toBe(
        true,
      );
    });
  });

  it("starts audible elevenlabs playback (routed via the cloud proxy) and attaches the tap inside the grace window", async () => {
    const { result } = renderVoiceChat({
      provider: "elevenlabs",
      elevenlabs: { voiceId: "test-voice", modelId: "test-model" },
    });

    act(() => {
      result.current.speak("hello elevenlabs");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    const tapNode = createdWorkletNodes.find((node) =>
      createdSources[0]?.connect.mock.calls.some(([arg]) => arg === node),
    );
    expect(tapNode).toBeDefined();

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    await waitFor(() => {
      expect(playbackFrameBodies.some((body) => body.reset === true)).toBe(
        true,
      );
    });
  });

  it("falls back from the cloud TTS proxy to the direct ElevenLabs proxy on a rejected cloud response (#12253 same-engine retry)", async () => {
    cloudTtsStatus = 401;

    const { result } = renderVoiceChat({
      provider: "elevenlabs",
      elevenlabs: { voiceId: "fallback-voice", modelId: "fallback-model" },
    });

    act(() => {
      result.current.speak("hello fallback path, a phrase unique to this test");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
      true,
    );
    expect(fetchedUrls.some((url) => url.includes("/api/tts/elevenlabs"))).toBe(
      true,
    );

    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
  });

  it("serves a repeated full response from the audio cache without refetching", async () => {
    const uniqueText =
      "Cache this complete generated response even though it is deliberately longer than ten speech tokens.";
    const { result } = renderVoiceChat({ provider: "local-inference" });

    act(() => {
      result.current.speak(uniqueText);
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));

    const fetchCountAfterFirstSpeak = fetchedUrls.filter((url) =>
      url.includes("/api/tts/local-inference"),
    ).length;
    expect(fetchCountAfterFirstSpeak).toBe(1);

    act(() => {
      result.current.speak(uniqueText);
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(1);
      expect(createdSources[1]?.start).toHaveBeenCalledWith(0);
    });
    // The second identical complete response is served from
    // globalAudioCache — no second network fetch.
    expect(
      fetchedUrls.filter((url) => url.includes("/api/tts/local-inference"))
        .length,
    ).toBe(fetchCountAfterFirstSpeak);

    await act(async () => {
      createdSources[1]?.onended?.();
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
  });

  it("fails closed with a surfaced ttsError on a non-recoverable eliza-cloud HTTP error (#12253 no silent engine swap)", async () => {
    cloudTtsHardFailure = true;
    const sourcesBefore = createdSources.length;

    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("hello hard failure, a phrase unique to this test");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });
    expect(result.current.ttsError?.engine).toBe("eliza-cloud");
    // The failure must not have fallen through to another playback engine.
    expect(createdSources.length).toBe(sourcesBefore);
  });

  it("fails closed with a surfaced ttsError when both the cloud proxy and the direct ElevenLabs proxy reject", async () => {
    cloudTtsStatus = 401;
    elevenlabsProxyStatus = 500;
    const sourcesBefore = createdSources.length;

    const { result } = renderVoiceChat({
      provider: "elevenlabs",
      elevenlabs: { voiceId: "dead-voice", modelId: "dead-model" },
    });

    act(() => {
      result.current.speak("hello total failure, a phrase unique to this test");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });
    expect(result.current.ttsError?.engine).toBe("elevenlabs");
    expect(createdSources.length).toBe(sourcesBefore);
  });

  it("serves a repeated short elevenlabs utterance from the audio cache without refetching", async () => {
    const uniqueText = "cache the eleven labs reply, short and cacheable";
    const { result } = renderVoiceChat({
      provider: "elevenlabs",
      elevenlabs: { voiceId: "cache-voice", modelId: "cache-model" },
    });

    act(() => {
      result.current.speak(uniqueText);
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));

    const fetchCountAfterFirstSpeak = fetchedUrls.filter(
      (url) =>
        url.includes("/api/tts/cloud") || url.includes("/api/tts/elevenlabs"),
    ).length;
    expect(fetchCountAfterFirstSpeak).toBeGreaterThan(0);

    act(() => {
      result.current.speak(uniqueText);
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(1);
      expect(createdSources[1]?.start).toHaveBeenCalledWith(0);
    });
    expect(
      fetchedUrls.filter(
        (url) =>
          url.includes("/api/tts/cloud") || url.includes("/api/tts/elevenlabs"),
      ).length,
    ).toBe(fetchCountAfterFirstSpeak);

    await act(async () => {
      createdSources[1]?.onended?.();
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
  });

  it("serves a repeated short eliza-cloud utterance from the audio cache without refetching", async () => {
    const uniqueText = "cache the eliza cloud reply, short and cacheable";
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak(uniqueText);
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await act(async () => {
      createdSources[0]?.onended?.();
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));

    const fetchCountAfterFirstSpeak = fetchedUrls.filter((url) =>
      url.includes("/api/tts/cloud"),
    ).length;
    expect(fetchCountAfterFirstSpeak).toBeGreaterThan(0);

    act(() => {
      result.current.speak(uniqueText);
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(1);
      expect(createdSources[1]?.start).toHaveBeenCalledWith(0);
    });
    expect(
      fetchedUrls.filter((url) => url.includes("/api/tts/cloud")).length,
    ).toBe(fetchCountAfterFirstSpeak);

    await act(async () => {
      createdSources[1]?.onended?.();
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
  });

  it("barge-in: stopSpeaking() mid-playback tears down the source/tap and clears isSpeaking without waiting for onended", async () => {
    const { result } = renderVoiceChat({ provider: "local-inference" });

    act(() => {
      result.current.speak("hello barge in, a phrase unique to this test");
    });
    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));

    act(() => {
      result.current.stopSpeaking();
    });

    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(result.current.ttsError).toBeNull();

    // Let the idle mouth-close animation (post-speech decay) run at least one
    // frame instead of unmounting mid-decay.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});
