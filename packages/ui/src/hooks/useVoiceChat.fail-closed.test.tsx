/** Verifies useVoiceChat TTS fails closed (#12253) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * useVoiceChat TTS fail-closed contract (#12253): when the configured voice
 * engine fails, the hook surfaces a visible `ttsError`, stops the queue, and
 * never silently swaps to browser SpeechSynthesis. Browser TTS stays valid only
 * as the *configured* engine. Drives the real hook + real processQueue with a
 * mocked HTTP layer and audio graph.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
}));

import { useVoiceChat } from "./useVoiceChat";

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

class FakeAudioContext extends EventTarget {
  currentTime = 0;
  state = "running";
  destination = {};
  resume = vi.fn(async () => {});
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0)),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createBufferSource = vi.fn(() => ({
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    onended: null,
  }));
  decodeAudioData = vi.fn(async () => ({ duration: 0.1 }));
  close = vi.fn(async () => {});
}

function installMocks() {
  speechSynthesisMock.spoken = [];
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
  fetchWithCsrf.mockReset();
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
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  ) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
}

describe("useVoiceChat TTS fails closed (#12253)", () => {
  beforeEach(() => {
    installMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("surfaces a ttsError and never speaks via the browser when local-inference 502s", async () => {
    fetchWithCsrf.mockResolvedValue(
      new Response("kokoro artifacts missing", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "local-inference" },
      }),
    );

    act(() => {
      result.current.speak("hello there");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });

    expect(result.current.ttsError?.engine).toBe("local-inference");
    expect(result.current.ttsError?.message).toContain("502");
    // The whole point: NO silent swap to browser SpeechSynthesis.
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
    // The local-inference route was actually hit (real path, not short-circuit).
    expect(fetchWithCsrf).toHaveBeenCalledWith(
      expect.stringContaining("/api/tts/local-inference"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.current.isSpeaking).toBe(false);
  });

  it("clears the ttsError on the next utterance", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
      new Response("boom", { status: 502, statusText: "Bad Gateway" }),
    );
    // Second attempt: succeed with a WAV payload so no error is raised.
    fetchWithCsrf.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      }),
    );

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "local-inference" },
      }),
    );

    act(() => {
      result.current.speak("first");
    });
    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });

    act(() => {
      result.current.speak("second");
    });
    await waitFor(() => {
      expect(result.current.ttsError).toBeNull();
      expect(result.current.isSpeaking).toBe(true);
      expect(result.current.mouthOpen).toBeGreaterThan(0);
    });
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
  });

  it("surfaces a ttsError and never speaks via the browser when Eliza Cloud TTS 502s", async () => {
    fetchWithCsrf.mockResolvedValue(
      new Response("cloud kokoro unavailable", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "eliza-cloud" },
        cloudConnected: true,
      }),
    );

    act(() => {
      result.current.speak("hello from cloud");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });

    expect(result.current.ttsError?.engine).toBe("eliza-cloud");
    expect(result.current.ttsError?.message).toContain("502");
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
    expect(fetchWithCsrf).toHaveBeenCalledWith(
      expect.stringContaining("/api/tts/cloud"),
      expect.objectContaining({ method: "POST" }),
      { responseType: "arraybuffer", timeoutMs: 60_000 },
    );
    expect(result.current.isSpeaking).toBe(false);
  });

  it("still speaks via the browser when the browser is the CONFIGURED engine (edge/unset)", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "edge" },
        cloudConnected: true,
      }),
    );

    act(() => {
      result.current.speak("configured browser voice");
    });

    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    // Never reached the local-inference route — the browser IS the config.
    expect(fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("does not cancel a browser utterance while its engine delays onstart", async () => {
    speechSynthesisMock.speak.mockImplementationOnce((utterance) => {
      speechSynthesisMock.spoken.push(utterance);
    });
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "edge" },
      }),
    );

    act(() => {
      result.current.speak("allow the embedded browser time to begin");
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(true);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(result.current.isSpeaking).toBe(true);

    act(() => {
      speechSynthesisMock.spoken[0]?.onstart?.();
      speechSynthesisMock.spoken[0]?.onend?.();
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
  });
});
