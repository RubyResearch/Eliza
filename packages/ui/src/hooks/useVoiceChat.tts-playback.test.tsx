/** Verifies useVoiceChat TTS playback across providers through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * useVoiceChat end-to-end TTS playback across every configured provider. Drives
 * the real hook + real processQueue + real PlaybackFramePump against a fake Web
 * Audio graph whose buffer source auto-fires `onended`, so each provider runs
 * its full synth → decode → play → teardown path (not just the request). Covers
 * eliza-cloud, local-inference, ElevenLabs (server-proxy), and browser
 * SpeechSynthesis, plus streamed assistant speech and stop/cancel. Complements
 * the routing unit tests (`useVoiceChat.forced-cloud-tts`, `shared-runtime-voice`).
 */

import { logger } from "@elizaos/logger";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
const requestViaAgentTransport = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
  requestViaAgentTransport: (...args: unknown[]) =>
    requestViaAgentTransport(...args),
}));

import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import { PlaybackFramePump } from "../voice/playback-frame-pump";
import { toSpeakableText } from "../voice/voice-chat-playback";
import { globalAudioCache } from "../voice/voice-chat-types";
import {
  __resetDirectCloudTtsFallbackWarnings,
  useVoiceChat,
} from "./useVoiceChat";

interface FakeSource {
  context: FakeAudioContext;
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

const createdSources: FakeSource[] = [];
let finishPlaybackAutomatically = true;
let decodedSampleCount = 640;

class FakeAudioWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null } = {
    onmessage: null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext extends EventTarget {
  currentTime = 0;
  state = "running";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
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
      context: this,
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      // Auto-finish shortly after start so the playback promise resolves and
      // the full teardown path (disconnect + timer clear) runs.
      start: vi.fn(() => {
        if (finishPlaybackAutomatically)
          setTimeout(() => source.onended?.(), 0);
      }),
      onended: null,
    };
    createdSources.push(source);
    return source;
  });
  decodeAudioData = vi.fn(async (audioData: ArrayBuffer) => {
    decodedAudioInputs.push(new Uint8Array(audioData.slice(0)));
    return {
      duration: 0.04,
      sampleRate: 16_000,
      length: decodedSampleCount,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(640).fill(0.25),
    };
  });
  close = vi.fn(async () => {});
}

class FakeUtterance extends EventTarget {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  constructor(text: string) {
    super();
    this.text = text;
  }
}

const speechSynthesisMock = {
  speaking: false,
  pending: false,
  spoken: [] as FakeUtterance[],
  cancel: vi.fn(),
  getVoices: vi.fn(() => []),
  speak: vi.fn((u: FakeUtterance) => {
    speechSynthesisMock.spoken.push(u);
    u.onstart?.();
    u.onend?.();
  }),
};

const fetchedUrls: string[] = [];
const fetchedContexts: unknown[] = [];
const decodedAudioInputs: Uint8Array[] = [];

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function installMocks() {
  fetchWithCsrf.mockReset();
  requestViaAgentTransport.mockReset();
  fetchedUrls.length = 0;
  fetchedContexts.length = 0;
  decodedAudioInputs.length = 0;
  // The hook shares its context across mounts; reset this fake platform between cases.
  for (const source of createdSources) source.context.state = "running";
  createdSources.length = 0;
  finishPlaybackAutomatically = true;
  decodedSampleCount = 640;
  speechSynthesisMock.spoken = [];
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
  globalAudioCache.clear();
  fetchWithCsrf.mockImplementation(async (input: unknown, _init, context) => {
    const url = typeof input === "string" ? input : String(input);
    fetchedUrls.push(url);
    fetchedContexts.push(context);
    if (url.includes("/api/voice/playback-frames")) {
      return new Response(null, { status: 204 });
    }
    // Every TTS endpoint (cloud proxy, direct worker, local-inference,
    // elevenlabs proxy) returns a decodable audio payload.
    return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  });
  requestViaAgentTransport.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
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
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeUtterance,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeUtterance,
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

type VoiceConfigArg = Parameters<typeof useVoiceChat>[0]["voiceConfig"];

function renderVoiceChat(voiceConfig: VoiceConfigArg) {
  return renderHook(() =>
    useVoiceChat({ onTranscript: vi.fn(), voiceConfig, cloudConnected: true }),
  );
}

describe("useVoiceChat TTS playback across providers", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    installMocks();
    localStorage.clear();
    __resetDirectCloudTtsFallbackWarnings();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  it("plays an Eliza Cloud reply end to end (fetch → decode → play → finish)", async () => {
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("cloud reply one");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(
      fetchedUrls.some(
        (url) => url.includes("/tts/") || url.includes("/voice/tts"),
      ),
    ).toBe(true);
    // Cloud Kokoro is not the browser engine — no SpeechSynthesis swap.
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
  });

  it("requests cloud TTS as an arraybuffer and preserves bridge-decoded WAV bytes exactly", async () => {
    const wavBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x80, 0xff, 0x57, 0x41, 0x56, 0x45,
    ]);
    const encodedWav = btoa(
      Array.from(wavBytes, (byte) => String.fromCharCode(byte)).join(""),
    );
    fetchWithCsrf.mockImplementation(async (input: unknown, _init, context) => {
      const url = typeof input === "string" ? input : String(input);
      fetchedUrls.push(url);
      fetchedContexts.push(context);
      if (url.includes("/api/voice/playback-frames")) {
        return new Response(null, { status: 204 });
      }
      return new Response(bytesFromBase64(encodedWav), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });

    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("binary cloud reply");
    });

    await waitFor(() => {
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });

    const cloudCallIndex = fetchedUrls.findIndex((url) =>
      url.includes("/api/tts/cloud"),
    );
    expect(cloudCallIndex).toBeGreaterThanOrEqual(0);
    expect(fetchedContexts[cloudCallIndex]).toEqual({
      responseType: "arraybuffer",
      timeoutMs: 60_000,
    });
    expect(decodedAudioInputs[0]).toEqual(wavBytes);
    expect(result.current.ttsError ?? null).toBeNull();
  });

  it("surfaces a cloud TTS timeout instead of decoding or playing a stale healthy state", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    fetchWithCsrf.mockImplementation(async (input: unknown, _init, context) => {
      const url = typeof input === "string" ? input : String(input);
      fetchedUrls.push(url);
      fetchedContexts.push(context);
      if (url.includes("/api/tts/cloud")) {
        throw new DOMException("Eliza Cloud TTS timed out", "TimeoutError");
      }
      return new Response(null, { status: 204 });
    });
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("timeout please");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });

    const cloudCallIndex = fetchedUrls.findIndex((url) =>
      url.includes("/api/tts/cloud"),
    );
    expect(fetchedContexts[cloudCallIndex]).toEqual({
      responseType: "arraybuffer",
      timeoutMs: 60_000,
    });
    expect(result.current.ttsError?.engine).toBe("eliza-cloud");
    expect(result.current.ttsError?.message).toContain(
      "Eliza Cloud TTS timed out",
    );
    expect(decodedAudioInputs).toEqual([]);
    expect(createdSources).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("plays a local-inference reply end to end", async () => {
    const { result } = renderVoiceChat({ provider: "local-inference" });

    act(() => {
      result.current.speak("local inference reply");
    });

    await waitFor(() => {
      expect(
        fetchedUrls.some((url) => url.includes("/api/tts/local-inference")),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
  });

  it("plays an ElevenLabs reply via the server proxy (no browser key)", async () => {
    const { result } = renderVoiceChat({
      provider: "elevenlabs",
      elevenlabs: { voiceId: "voice-x", modelId: "model-x" },
    });

    act(() => {
      result.current.speak("elevenlabs reply");
    });

    await waitFor(() => {
      expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    // #16425: every proxy TTS POST carries a per-utterance Idempotency-Key so
    // the cloud route can dedupe the reservation if this utterance is retried.
    const proxyCall = fetchWithCsrf.mock.calls.find(([url]) =>
      String(url).includes("/api/tts/cloud"),
    );
    const proxyHeaders = ((proxyCall?.[1] as RequestInit | undefined)
      ?.headers ?? {}) as Record<string, string>;
    expect(proxyHeaders["Idempotency-Key"]).toBeTruthy();
  });

  it("speaks via the browser when the browser is the configured engine (edge)", async () => {
    const { result } = renderVoiceChat({ provider: "edge" });

    act(() => {
      result.current.speak("browser reply");
    });

    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    // Configured browser voice: no server TTS fetch.
    expect(fetchedUrls.some((url) => url.includes("/api/tts/"))).toBe(false);
  });

  it("streams assistant speech: an early clip flushes, then the final promotes", async () => {
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    // First streamed chunk over the first-flush threshold queues a clip after
    // the debounce; the final promotes the remainder.
    act(() => {
      result.current.queueAssistantSpeech(
        "msg-stream-1",
        "This is the first streamed sentence of the reply.",
        false,
      );
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.queueAssistantSpeech(
        "msg-stream-1",
        "This is the first streamed sentence of the reply. And here is the rest of it.",
        true,
      );
    });

    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
  });

  it("prepares only the next clip while real queue playback remains ordered", async () => {
    finishPlaybackAutomatically = false;
    const { result } = renderVoiceChat({ provider: "local-inference" });
    const requests: string[] = [];
    fetchWithCsrf.mockImplementation(async (url, init) => {
      if (!String(url).includes("/api/tts/"))
        return new Response(null, { status: 204 });
      requests.push(JSON.parse(init.body).text);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    act(() => result.current.speak("First complete sentence."));
    await waitFor(() => expect(createdSources[0]?.start).toHaveBeenCalled());
    act(() => {
      result.current.speak("Second complete sentence.", { append: true });
      result.current.speak("Third complete sentence.", { append: true });
    });
    await waitFor(() => expect(decodedAudioInputs).toHaveLength(2));
    expect(requests).toEqual([
      "First complete sentence.",
      "Second complete sentence.",
    ]);
    expect(createdSources).toHaveLength(1);
    expect(result.current.isSpeaking).toBe(true);
    act(() => createdSources[0]?.onended?.());
    await waitFor(() => expect(createdSources[1]?.start).toHaveBeenCalled());
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(createdSources).toHaveLength(2);
    act(() => createdSources[1]?.onended?.());
    await waitFor(() => expect(createdSources[2]?.start).toHaveBeenCalled());
    expect(result.current.isSpeaking).toBe(true);
    act(() => createdSources[2]?.onended?.());
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
  });

  it("defers oversized decoded lookahead without discarding or synthesizing the clip twice", async () => {
    finishPlaybackAutomatically = false;
    const { result } = renderVoiceChat({ provider: "local-inference" });
    act(() => result.current.speak("First audio."));
    await waitFor(() => expect(createdSources[0]?.start).toHaveBeenCalled());
    decodedSampleCount = 9_000_000;
    act(() => result.current.speak("Large tail audio.", { append: true }));
    await waitFor(() => expect(decodedAudioInputs).toHaveLength(2));
    expect(createdSources).toHaveLength(1);
    act(() => createdSources[0]?.onended?.());
    await waitFor(() => expect(createdSources[1]?.start).toHaveBeenCalled());
    expect(decodedAudioInputs).toHaveLength(3);
    expect(fetchedUrls.filter((url) => url.includes("/api/tts/"))).toHaveLength(
      2,
    );
    act(() => createdSources[1]?.onended?.());
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(result.current.ttsError).toBeNull();
  });

  it.each([
    [
      "I am checking the international",
      "I am checking the internationalization settings.",
    ],
    ["The measured value is 3.", "The measured value is 3.14159 today."],
    [
      "Please open https://example.",
      "Please open https://example.com/path now.",
    ],
    ["The next person is Dr.", "The next person is Dr. Rivera."],
    [
      "This reply contains a family 👨‍",
      "This reply contains a family 👨‍👩‍👧‍👦 together.",
    ],
  ])("retains the unfinished lexical suffix: %s", async (partial, final) => {
    const texts: string[] = [];
    fetchWithCsrf.mockImplementation(async (url, init) => {
      if (!String(url).includes("/api/tts/"))
        return new Response(null, { status: 204 });
      texts.push(JSON.parse(init.body).text);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const { result } = renderVoiceChat({ provider: "local-inference" });
    act(() => result.current.queueAssistantSpeech("lexical", partial, false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    act(() => result.current.queueAssistantSpeech("lexical", final, true));
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(texts.join(" ")).toBe(toSpeakableText(final));
    expect(result.current.ttsError).toBeNull();
  });

  it("rejects a revised final instead of discarding it as already spoken", async () => {
    finishPlaybackAutomatically = false;
    const { result } = renderVoiceChat({ provider: "local-inference" });
    act(() =>
      result.current.queueAssistantSpeech(
        "revision",
        "The available option is red.",
        false,
      ),
    );
    await waitFor(() => expect(createdSources[0]?.start).toHaveBeenCalled());
    act(() =>
      result.current.queueAssistantSpeech(
        "revision",
        "Actually, the available option is blue.",
        true,
      ),
    );
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(result.current.ttsError?.engine).toBe("speech-sequence");
    expect(result.current.ttsError?.message).toContain("reply changed");
    expect(createdSources).toHaveLength(1);
  });

  it("never starts cancelled audio after a delayed playback-reference attachment", async () => {
    let release: (() => void) | undefined;
    let first = true;
    const tapSource = PlaybackFramePump.prototype.tapSource;
    const tapSpy = vi
      .spyOn(PlaybackFramePump.prototype, "tapSource")
      .mockImplementation(async function (this: PlaybackFramePump, ...args) {
        const tap = await tapSource.apply(this, args);
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return tap;
      });
    try {
      const { result } = renderVoiceChat({ provider: "local-inference" });
      act(() => result.current.speak("Cancelled during attachment."));
      await waitFor(() => expect(release).toBeDefined());
      act(() => {
        result.current.stopSpeaking();
        result.current.speak("Current reply.");
      });
      await act(async () => {
        release?.();
      });
      await waitFor(() => expect(createdSources[1]?.start).toHaveBeenCalled());
      expect(createdSources[0]?.start).not.toHaveBeenCalled();
      await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    } finally {
      tapSpy.mockRestore();
    }
  });

  it("keeps the next turn when cancelled preparation rejects late", async () => {
    let rejectCancelled: ((error: Error) => void) | undefined;
    fetchWithCsrf.mockImplementation(async (url, init) => {
      if (!String(url).includes("/api/tts/"))
        return new Response(null, { status: 204 });
      if (JSON.parse(init.body).text === "Old preparation.") {
        return new Promise<Response>((_, reject) => {
          rejectCancelled = reject;
        });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const onPlaybackStart = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        onPlaybackStart,
        voiceConfig: { provider: "local-inference" },
      }),
    );
    act(() => result.current.speak("Old preparation."));
    await waitFor(() => expect(rejectCancelled).toBeDefined());
    act(() => {
      result.current.stopSpeaking();
      result.current.speak("New authorized turn.");
    });
    await act(async () => {
      rejectCancelled?.(new Error("Late cancelled transport error"));
    });
    await waitFor(() => expect(onPlaybackStart).toHaveBeenCalledTimes(1));
    expect(onPlaybackStart.mock.calls[0]?.[0].text).toBe(
      "New authorized turn.",
    );
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(result.current.ttsError).toBeNull();
  });

  it("cancels an in-flight lookahead and never plays its late response in the next turn", async () => {
    finishPlaybackAutomatically = false;
    let release: ((response: Response) => void) | undefined;
    let pendingSignal: AbortSignal | undefined;
    fetchWithCsrf.mockImplementation(async (_url, init) => {
      if (JSON.parse(init.body).text === "Cancelled tail.") {
        pendingSignal = init.signal;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const onPlaybackStart = vi.fn();
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        onPlaybackStart,
        voiceConfig: { provider: "local-inference" },
      }),
    );
    act(() => result.current.speak("Initial sentence."));
    await waitFor(() => expect(createdSources[0]?.start).toHaveBeenCalled());
    act(() => result.current.speak("Cancelled tail.", { append: true }));
    await waitFor(() => expect(pendingSignal).toBeDefined());
    act(() => {
      result.current.stopSpeaking();
      result.current.speak("New turn.");
    });
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => {
      release?.(new Response(new Uint8Array([9, 9, 9, 9])));
    });
    await waitFor(() => expect(createdSources[1]?.start).toHaveBeenCalled());
    expect(onPlaybackStart.mock.calls.map(([event]) => event.text)).toEqual([
      "Initial sentence.",
      "New turn.",
    ]);
    expect(decodedAudioInputs).toHaveLength(2);
    act(() => createdSources[1]?.onended?.());
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
  });

  it("degrades a failed direct-cloud fetch to the proxy and still plays audio end to end", async () => {
    // A cloud session bearer + the default cloud origin select the direct
    // worker path; the direct bare fetch dies (network / preflight) and the
    // designed degrade must play the same clip through the on-device proxy.
    localStorage.setItem("steward_session_token", "header.payload.signature");
    setBootConfig({ branding: {}, cloudApiBase: "https://elizacloud.ai" });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const directFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: directFetch,
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: directFetch,
    });

    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("fallback reply");
    });

    // Both legs fired: the direct worker attempt, then the proxy rescue.
    await waitFor(() => {
      expect(directFetch).toHaveBeenCalled();
      expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
        true,
      );
    });
    // The proxy audio decoded and played to completion — user hears the reply.
    await waitFor(() => {
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("stopSpeaking cancels playback and clears the speaking state", async () => {
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("first utterance");
      result.current.speak("second utterance", { append: true });
    });

    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(true);
    });

    act(() => {
      result.current.stopSpeaking();
    });

    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
  });
  it("surfaces a context closed during buffered speech and does not start the queued reply", async () => {
    finishPlaybackAutomatically = false;
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });
    act(() =>
      result.current.speak("Speech interrupted by a closed audio device."),
    );
    await waitFor(() => expect(createdSources[0]?.start).toHaveBeenCalled());
    act(() =>
      result.current.speak("This queued reply must not start.", {
        append: true,
      }),
    );
    const source = createdSources[0];
    if (!source) throw new Error("No started audio source");
    act(() => {
      source.context.state = "closed";
      source.context.dispatchEvent(new Event("statechange"));
    });
    await waitFor(() => {
      expect(result.current.ttsError).toMatchObject({
        engine: "eliza-cloud",
        message: expect.stringMatching(/closed.*before speech completed/i),
      });
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(createdSources).toHaveLength(1);
    expect(source.disconnect).toHaveBeenCalled();
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
  });
});
