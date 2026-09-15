/** Verifies useVoiceChat forced-cloud TTS routing (#16116) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Forced-cloud TTS direct-worker routing (#16116). When the configured provider
 * is `eliza-cloud`, a dedicated/on-device agent must NOT relay TTS through its
 * own `/api/tts/cloud` proxy (an extra phone-side download + base64 IPC
 * re-marshal) when a cloud session bearer + configured cloud origin are present:
 * it POSTs straight to the cloud worker's `/api/v1/voice/tts` through the canonical platform transport
 * without CSRF or cookie mutation (Authorization + Content-Type only, no cookies, no csrf mirror).
 * Any direct failure (network reject or non-2xx) degrades to the on-device
 * proxy, which authenticates server-side. With no cloud auth the proxy path is
 * preserved. Drives the real hook + real processQueue against mocked HTTP
 * layers (`requestViaAgentTransport` for the direct worker, `fetchWithCsrf` for the proxy)
 * and a fake audio graph.
 */

import { logger } from "@elizaos/logger";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
  requestViaAgentTransport: (url: string, init?: RequestInit) =>
    directFetch(url, init),
}));

import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import { describeTtsFetchTargetForDebug } from "../voice/voice-chat-types";
import {
  __resetDirectCloudTtsFallbackWarnings,
  useVoiceChat,
} from "./useVoiceChat";

const CLOUD_JWT = "header.payload.signature";
const DIRECT_TTS_URL = "https://api.eliza.app/api/v1/voice/tts";

interface FakeSource {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

const createdSources: FakeSource[] = [];

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
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      // Auto-finish shortly after start so the playback promise resolves and
      // the speak() path runs to completion in fallback assertions.
      start: vi.fn(() => {
        setTimeout(() => source.onended?.(), 0);
      }),
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

/** Proxy-path capture (fetchWithCsrf). */
const proxyUrls: string[] = [];
const proxyInits: (RequestInit | undefined)[] = [];
/** Direct-path capture (bare global fetch). */
const directFetch = vi.fn();
const directUrls: string[] = [];
const directInits: (RequestInit | undefined)[] = [];

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}

function installMocks() {
  fetchWithCsrf.mockReset();
  directFetch.mockReset();
  proxyUrls.length = 0;
  proxyInits.length = 0;
  directUrls.length = 0;
  directInits.length = 0;
  createdSources.length = 0;
  fetchWithCsrf.mockImplementation(
    async (input: unknown, init?: RequestInit) => {
      proxyUrls.push(typeof input === "string" ? input : String(input));
      proxyInits.push(init);
      return audioResponse();
    },
  );
  directFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    directUrls.push(typeof input === "string" ? input : String(input));
    directInits.push(init);
    return audioResponse();
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

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function renderForcedCloud() {
  return renderHook(() =>
    useVoiceChat({
      onTranscript: vi.fn(),
      voiceConfig: { provider: "eliza-cloud" },
      cloudConnected: true,
    }),
  );
}

describe("useVoiceChat forced-cloud TTS routing (#16116)", () => {
  beforeEach(() => {
    installMocks();
    localStorage.clear();
    __resetDirectCloudTtsFallbackWarnings();
    setBootConfig({ branding: {}, cloudApiBase: "https://elizacloud.ai" });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  it("POSTs directly to the cloud worker with the cloud bearer, bypassing /api/tts/cloud", async () => {
    // A live cloud session bearer is present (canonical Steward JWT).
    localStorage.setItem("steward_session_token", CLOUD_JWT);

    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("hello from the cloud worker");
    });

    await waitFor(() => {
      expect(directFetch).toHaveBeenCalled();
    });

    const ttsCall = directUrls.findIndex((url) =>
      url.includes("/api/v1/voice/tts"),
    );
    expect(ttsCall).toBeGreaterThanOrEqual(0);
    // Direct to the configured cloud worker origin — NOT the on-device proxy.
    expect(directUrls[ttsCall]).toBe(DIRECT_TTS_URL);
    expect(proxyUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(false);
    // Carries the cloud session bearer.
    expect(headersOf(directInits[ttsCall]).Authorization).toBe(
      `Bearer ${CLOUD_JWT}`,
    );
  });

  it("keeps the direct fetch CORS-safe: bare fetch, Authorization + Content-Type only, no cookies", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    // A csrf cookie exists (browser dashboard session) — it must NOT be
    // mirrored into the direct cross-origin request.
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom test seeds the raw cookie the csrf client reads
    document.cookie = "eliza_csrf=csrf-token-value";

    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("cors safe please");
    });

    await waitFor(() => {
      expect(directFetch).toHaveBeenCalled();
    });

    const ttsCall = directUrls.findIndex((url) =>
      url.includes("/api/v1/voice/tts"),
    );
    expect(ttsCall).toBeGreaterThanOrEqual(0);
    const init = directInits[ttsCall];
    // Not fetchWithCsrf: no csrf mirror, no cookie credentials — the cloud
    // worker answers ACAO:* which browsers reject with credentialed requests,
    // and `x-eliza-csrf` is not in the worker's CORS allow-list. Both header
    // names sent here ARE in CORS_ALLOW_HEADER_NAMES
    // (packages/cloud/shared/src/lib/cors-constants.ts).
    expect(init?.credentials).toBeUndefined();
    const headers = headersOf(init);
    expect(Object.keys(headers).sort()).toEqual([
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
    ]);
    // Body carries the same `{ text }` contract as the proxy path (the worker
    // treats an omitted voiceId as "unpinned", matching the proxy default).
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "cors safe please",
    });
    // And the proxy transport was never used for the TTS call.
    expect(proxyUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(false);
  });

  it("honors a staging cloud origin from boot config (not hardcoded production)", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });

    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("staging please");
    });

    await waitFor(() => {
      expect(directFetch).toHaveBeenCalled();
    });

    expect(
      directUrls.some(
        (url) => url === "https://api-staging.eliza.app/api/v1/voice/tts",
      ),
    ).toBe(true);
  });

  it("preserves the on-device /api/tts/cloud proxy when no cloud session token exists", async () => {
    // No steward token in localStorage → no cloud bearer → proxy preserved.
    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("no cloud auth here");
    });

    await waitFor(() => {
      expect(fetchWithCsrf).toHaveBeenCalled();
    });

    expect(proxyUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(true);
    expect(directUrls.some((url) => url.includes("/api/v1/voice/tts"))).toBe(
      false,
    );
  });

  it("falls back to the on-device proxy when the direct fetch rejects (network/preflight)", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    directFetch.mockImplementation(async (input: unknown) => {
      directUrls.push(typeof input === "string" ? input : String(input));
      throw new TypeError("Failed to fetch");
    });

    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("degrade gracefully");
    });

    // Both legs fired: direct first, then the proxy fallback.
    await waitFor(() => {
      expect(proxyUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
        true,
      );
    });
    expect(directUrls.filter((u) => u.includes("/api/v1/voice/tts"))).toEqual([
      DIRECT_TTS_URL,
    ]);
    // The proxy audio actually played (decode → source.start), so the degrade
    // is invisible to the user.
    await waitFor(() => {
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    // Warned once, naming the real direct target.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(DIRECT_TTS_URL);
  });

  // #16425: the fallback re-POST is the SAME logical utterance — both legs
  // must carry one identical Idempotency-Key so the cloud route replays the
  // direct attempt's committed credit reservation instead of charging twice.
  it("sends the SAME Idempotency-Key on the direct attempt and the proxy fallback", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const directHeaderKeys: Array<string | undefined> = [];
    directFetch.mockImplementation(
      async (_input: unknown, init?: RequestInit) => {
        directHeaderKeys.push(headersOf(init)["Idempotency-Key"]);
        throw new TypeError("Failed to fetch");
      },
    );

    const { result } = renderForcedCloud();
    act(() => {
      result.current.speak("bill me once");
    });

    await waitFor(() => {
      expect(proxyUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
        true,
      );
    });

    const proxyCall = fetchWithCsrf.mock.calls.find(([url]) =>
      String(url).includes("/api/tts/cloud"),
    );
    const proxyKey = headersOf(proxyCall?.[1] as RequestInit | undefined)[
      "Idempotency-Key"
    ];
    expect(directHeaderKeys[0]).toBeTruthy();
    expect(proxyKey).toBe(directHeaderKeys[0]);
  });

  it("falls back to the on-device proxy on a direct non-2xx and warns only once across segments", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    directFetch.mockImplementation(async (input: unknown) => {
      directUrls.push(typeof input === "string" ? input : String(input));
      return new Response("expired session", { status: 401 });
    });

    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("first failing segment");
    });
    await waitFor(() => {
      expect(
        proxyUrls.filter((url) => url.includes("/api/tts/cloud")).length,
      ).toBe(1);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });

    act(() => {
      result.current.speak("second failing segment");
    });
    await waitFor(() => {
      expect(
        proxyUrls.filter((url) => url.includes("/api/tts/cloud")).length,
      ).toBe(2);
    });

    // Direct was attempted for each segment (no sticky disable), the proxy
    // rescued both, and the warn fired exactly once for the target.
    expect(
      directUrls.filter((u) => u.includes("/api/v1/voice/tts")).length,
    ).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(DIRECT_TTS_URL);
    expect(result.current.ttsError ?? null).toBeNull();
  });

  it("surfaces a real TTS error (no silent healthy state) when direct AND proxy both fail", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    directFetch.mockImplementation(async (input: unknown) => {
      directUrls.push(typeof input === "string" ? input : String(input));
      return new Response("boom", { status: 500 });
    });
    fetchWithCsrf.mockImplementation(async (input: unknown) => {
      proxyUrls.push(typeof input === "string" ? input : String(input));
      return new Response("proxy down", { status: 502 });
    });

    const { result } = renderForcedCloud();

    act(() => {
      result.current.speak("everything is broken");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });
    expect(result.current.ttsError?.engine).toBe("eliza-cloud");
    // The surfaced failure is the PROXY's (the last real target) — the direct
    // status was consumed by the designed degrade.
    expect(result.current.ttsError?.message).toContain("502");
  });

  it("describes the actual fetch target in debug output (direct worker vs proxy)", () => {
    // F4: the http-error debug line must name the target that actually served
    // the response, not always the proxy.
    expect(describeTtsFetchTargetForDebug(DIRECT_TTS_URL)).toBe(
      "https://api.eliza.app (absolute)",
    );
    expect(
      describeTtsFetchTargetForDebug("http://127.0.0.1:2138/api/tts/cloud"),
    ).toBe("http://127.0.0.1:2138 (absolute)");
    expect(describeTtsFetchTargetForDebug("/api/tts/cloud")).toContain(
      "relative URL",
    );
  });
});
