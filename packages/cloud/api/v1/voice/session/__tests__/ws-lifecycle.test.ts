/**
 * Full realtime voice-session WS lifecycle against a mock socket factory that
 * drives the real Cartesia Ink STT and Cartesia Sonic TTS adapters plus
 * the REAL `VoiceSession` orchestrator + `attachVoiceWsHandler` framing.
 *
 * The fakes here are transports only — fake Ink socket, fake Sonic
 * socket, fake client socket, fake Eliza SSE fetch. Everything under test
 * (hello-first auth, framing, uplink re-framing, phrase aggregation, TTS
 * streaming, interruption, metering, revoke-to-silence) is the real code path.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { decode, encode } from "@msgpack/msgpack";
import * as agentSandboxesActual from "@/db/repositories/agent-sandboxes";
import * as workerCoreStub from "../../../../src/stubs/elizaos-core";
import * as coreTestContract from "../../../../src/stubs/elizaos-core-test-contract";

// Break the logger -> @elizaos/core transitive import chain (repo-standard
// test isolation for cloud-api unit tests). Logic under test is untouched.
const fakeLogger = {
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
};
class MockElizaError extends Error {}
mock.module("@/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/core", () => ({
  canRequesterMutateDocument: coreTestContract.canRequesterMutateDocument,
  ChannelType: coreTestContract.ChannelType,
  DatabaseAdapter: coreTestContract.DatabaseAdapter,
  decryptedCharacter: coreTestContract.decryptedCharacter,
  DOCUMENT_LIST_QUERY_CAPABILITY_VERSION:
    coreTestContract.DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
  documentMutationSnapshotMatches:
    coreTestContract.documentMutationSnapshotMatches,
  documentRoleHasGlobalVisibility:
    coreTestContract.documentRoleHasGlobalVisibility,
  encryptedCharacter: coreTestContract.encryptedCharacter,
  ElizaError: MockElizaError,
  isElizaError: (error: unknown) => error instanceof MockElizaError,
  isSensitiveKeyName: () => false,
  logger: coreTestContract.logger,
  normalizePairingPageOptions: coreTestContract.normalizePairingPageOptions,
  redactLogArgs: (args: unknown) => args,
  redactSensitiveText: (text: string) => text,
  Service: coreTestContract.Service,
  toWellFormedUnicode: workerCoreStub.toWellFormedUnicode,
  truncateWellFormed: workerCoreStub.truncateWellFormed,
  validateDocumentFragmentQueryParams:
    coreTestContract.validateDocumentFragmentQueryParams,
  validateDocumentListQueryParams:
    coreTestContract.validateDocumentListQueryParams,
  validateDocumentRequesterContext:
    coreTestContract.validateDocumentRequesterContext,
  validateQueryEntitiesPagination:
    coreTestContract.validateQueryEntitiesPagination,
  validateUuid: coreTestContract.validateUuid,
}));

type DedicatedVoiceSandbox = {
  id: string;
  organization_id: string;
  user_id: string;
  execution_tier: string;
  status: string;
  headscale_ip: string | null;
  bridge_url: string | null;
  health_url: string | null;
  environment_vars: Record<string, string>;
};
let dedicatedVoiceSandbox: DedicatedVoiceSandbox | null = null;
mock.module("@/db/repositories/agent-sandboxes", () => ({
  ...agentSandboxesActual,
  agentSandboxesRepository: {
    ...agentSandboxesActual.agentSandboxesRepository,
    findByIdAndOrg: async (id: string, organizationId: string) => {
      const sandbox = dedicatedVoiceSandbox;
      return sandbox?.id === id && sandbox.organization_id === organizationId
        ? sandbox
        : undefined;
    },
  },
}));

import type { CartesiaWebSocketLike } from "../../../../../shared/src/lib/services/cartesia-sonic-tts";
import type { FishAudioWebSocketLike } from "../../../../../shared/src/lib/services/fish-audio-tts";
import { InMemoryVoiceUsageStore } from "../../../../../shared/src/lib/services/voice-usage-meter";
import {
  mintVoiceSessionToken,
  VoiceSessionTokenError,
} from "../../../../../shared/src/lib/voice-session/jwt";
import type { ServerControlFrame } from "../../../../../shared/src/lib/voice-session/protocol";
import {
  __resetVoiceSessionRegistryForTests,
  getVoiceSessionRegistry,
} from "../../../../../shared/src/lib/voice-session/session-registry";
import { installVoiceSessionTestSigningKey } from "../../../../../shared/src/lib/voice-session/test-signing";
import { attachVoiceWsHandler } from "../../../../../shared/src/lib/voice-session/ws-handler";
import type { CartesiaInkWebSocket } from "../../stt/providers/cartesia-ink";
import { VoiceSession, type VoiceTurnMetricsReceipt } from "../lib/session";

// --- signing setup --------------------------------------------------------

beforeAll(async () => {
  await installVoiceSessionTestSigningKey();
});

afterEach(() => {
  __resetVoiceSessionRegistryForTests();
  dedicatedVoiceSandbox = null;
});

// --- fake Cartesia Ink socket (drives the real STT adapter) ----------------

class FakeInkSocket implements CartesiaInkWebSocket {
  static instances: FakeInkSocket[] = [];
  readyState = 1;
  binaryType: BinaryType = "arraybuffer";
  sentChunks: (ArrayBuffer | ArrayBufferView)[] = [];
  closed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(opts?: { autoOpen?: boolean }) {
    FakeInkSocket.instances.push(this);
    if (opts?.autoOpen === false) {
      this.readyState = 0;
    } else {
      queueMicrotask(() => this.fire("open", {}));
    }
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") return; // CloseStream control.
    this.sentChunks.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code, reason, wasClean: true });
  }
  addEventListener(type: string, listener: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (e: unknown) => void);
  }
  removeEventListener(type: string, listener: (e: never) => void) {
    this.listeners.get(type)?.delete(listener as (e: unknown) => void);
  }
  /** Emit one native Ink turn event. */
  emitTurn(event: string, transcript = "") {
    this.fire("message", {
      data: JSON.stringify({ type: event, transcript }),
    });
  }
  emitMalformedMessage() {
    this.fire("message", { data: "{not json" });
  }
  emitConnectedHandshake() {
    this.fire("message", { data: JSON.stringify({ type: "connected" }) });
  }
  emitOpen() {
    this.readyState = 1;
    this.fire("open", {});
  }
  emitTransportError() {
    this.fire("error", new Event("error"));
  }
  private fire(type: string, payload: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(payload);
  }
}

// --- fake Cartesia socket (drives the REAL adapter) -----------------------

class FakeCartesiaSocket implements CartesiaWebSocketLike {
  static instances: FakeCartesiaSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor() {
    FakeCartesiaSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", undefined);
    });
  }
  send(data: string) {
    this.sent.push(data);
    // On the first non-cancel generation request, stream one audio chunk.
    const msg = JSON.parse(data) as { cancel?: boolean; transcript?: string };
    if (msg.cancel) return;
    if (typeof msg.transcript === "string" && msg.transcript.length > 0) {
      queueMicrotask(() => {
        if (this.closed) return;
        const pcm = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString(
          "base64",
        );
        this.fire("message", {
          data: JSON.stringify({ type: "chunk", data: pcm }),
        });
      });
    }
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  addEventListener(type: string, listener: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (e: unknown) => void);
  }
  removeEventListener(type: string, listener: (e: never) => void) {
    this.listeners.get(type)?.delete(listener as (e: unknown) => void);
  }
  emitDone() {
    this.fire("message", {
      data: JSON.stringify({ type: "done", done: true }),
    });
  }
  emitFlushDone() {
    this.fire("message", {
      data: JSON.stringify({ type: "flush_done", flush_done: true }),
    });
  }
  emitAudio(bytes = new Uint8Array([1, 2, 3, 4])) {
    const pcm = Buffer.from(bytes).toString("base64");
    this.fire("message", {
      data: JSON.stringify({ type: "chunk", data: pcm }),
    });
  }
  emitProviderError(code = "provider_failed") {
    this.fire("message", {
      data: JSON.stringify({
        type: "error",
        title: "Provider failed",
        message: "TTS provider failed",
        error_code: code,
        status_code: 503,
      }),
    });
  }
  sentText(): string {
    return this.sent
      .map((entry) => {
        const parsed = JSON.parse(entry) as { transcript?: unknown };
        return typeof parsed.transcript === "string" ? parsed.transcript : "";
      })
      .join("");
  }
  private fire(type: string, payload: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(payload);
  }
}

// --- fake Fish Audio socket (drives the REAL adapter) ---------------------

class FakeFishAudioSocket implements FishAudioWebSocketLike {
  static instances: FakeFishAudioSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  closed = false;
  autoOpen = true;
  autoAudio = true;
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(opts?: { autoOpen?: boolean; autoAudio?: boolean }) {
    this.autoOpen = opts?.autoOpen ?? true;
    this.autoAudio = opts?.autoAudio ?? true;
    FakeFishAudioSocket.instances.push(this);
    if (this.autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.fire("open", undefined);
      });
    }
  }
  send(data: Uint8Array) {
    this.sent.push(data);
    const msg = decode(data) as { event?: string; text?: string };
    if (this.autoAudio && msg.event === "text" && msg.text) {
      queueMicrotask(() => {
        if (this.closed) return;
        this.emitAudio(new Uint8Array([9, 8, 7, 6]));
      });
    }
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  addEventListener(type: string, listener: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (e: unknown) => void);
  }
  emitOpen() {
    this.readyState = 1;
    this.fire("open", undefined);
  }
  emitAudio(bytes = new Uint8Array([9, 8, 7, 6])) {
    this.fire("message", { data: encode({ event: "audio", audio: bytes }) });
  }
  emitDone(reason: "stop" | "error" = "stop") {
    this.fire("message", { data: encode({ event: "finish", reason }) });
  }
  emitTransportError(message = "fish connect failed") {
    this.fire("error", { message });
  }
  emitProviderError(code = "fish_provider_rejected") {
    this.fire("message", {
      data: encode({
        event: "error",
        code,
        message: "Fish rejected synthesis",
      }),
    });
  }
  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((frame) => decode(frame) as Record<string, unknown>);
  }
  sentText(): string {
    return this.sentFrames()
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .join("");
  }
  private fire(type: string, payload: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(payload);
  }
}

// --- fake client transport (drives the REAL ws-handler) -------------------

class FakeClientSocket {
  controlFrames: ServerControlFrame[] = [];
  audioFrames: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Set<(e: { data: unknown }) => void>>();

  send(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data === "string") {
      this.controlFrames.push(JSON.parse(data));
    } else {
      this.audioFrames.push(
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer),
      );
    }
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.fire("close", { data: undefined });
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  /** Simulate the client sending a text or binary frame to the server. */
  clientSend(data: string | ArrayBuffer | Uint8Array) {
    this.fire("message", { data });
  }
  clientClose() {
    this.fire("close", { data: undefined });
  }
  private fire(type: string, e: { data: unknown }) {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  controlTypes(): string[] {
    return this.controlFrames.map((f) => f.t);
  }
}

// --- scripted Eliza SSE fetch --------------------------------------------

function makeSseFetch(
  deltas: string[],
  opts?: { hang?: boolean; onAbort?: () => void },
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const d of deltas) {
          if (signal?.aborted) break;
          const frame = { choices: [{ delta: { content: d } }] };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
          );
          await new Promise((r) => setTimeout(r, 1));
        }
        if (opts?.hang) {
          // Never send [DONE]; wait for abort.
          await new Promise<void>((resolve) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                opts.onAbort?.();
                resolve();
              });
            }
          });
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function makeCanonicalChunkFetch(
  deltas: string[],
  donePayload: Record<string, unknown> = {},
): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of deltas) {
          controller.enqueue(
            encoder.encode(
              `event: chunk\ndata: ${JSON.stringify({ chunk })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function makeLocalTokenFetch(
  frames: Record<string, unknown>[],
  donePayload: Record<string, unknown>,
): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "token", ...frame })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "done", ...donePayload })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function makeControlledCanonicalChunkFetch(): {
  fetchImpl: typeof fetch;
  enqueueChunk: (chunk: string) => void;
  enqueueReplyReady: (fullText: string) => void;
  finish: (donePayload?: Record<string, unknown>) => void;
  fail: () => void;
  ready: Promise<void>;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    fetchImpl: (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          resolveReady();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
    enqueueChunk(chunk: string) {
      controller?.enqueue(
        encoder.encode(`event: chunk\ndata: ${JSON.stringify({ chunk })}\n\n`),
      );
    },
    enqueueReplyReady(fullText: string) {
      controller?.enqueue(
        encoder.encode(
          `event: reply_ready\ndata: ${JSON.stringify({ type: "reply_ready", fullText })}\n\n`,
        ),
      );
    },
    finish(donePayload = {}) {
      controller?.enqueue(
        encoder.encode(`event: done\ndata: ${JSON.stringify(donePayload)}\n\n`),
      );
      controller?.close();
    },
    fail() {
      controller?.enqueue(
        encoder.encode(
          `event: error\ndata: ${JSON.stringify({ message: "provider failed" })}\n\n`,
        ),
      );
      controller?.close();
    },
    ready,
  };
}

// --- helpers --------------------------------------------------------------

const CLAIMS = {
  sessionId: "sess-lifecycle",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  conversationId: "conv-1",
};

async function connectSession(opts: {
  client: FakeClientSocket;
  fetchImpl: typeof fetch;
  claims?: typeof CLAIMS;
  inkSocketFactory?: () => CartesiaInkWebSocket;
  sttReconnectDelaysMs?: readonly number[];
  sttConnectTimeoutMs?: number;
  sttPendingFrameLimit?: number;
  prewarmElizaContext?: () => Promise<void>;
  openingGreeting?: string;
  openingPrompt?: string;
  openingClientMessageId?: string;
  openingHistoryCutoffAt?: number;
  openingFallbackGreeting?: string;
  cacheWarmingRetryDelaysMs?: readonly number[];
  onClearAudio?: () => void;
  acousticBargeInEnabled?: boolean;
  allowContinuousHandoff?: boolean;
  halfDuplexPlaybackSettleMs?: number;
  now?: () => number;
  onTurnMetrics?: (receipt: VoiceTurnMetricsReceipt) => void;
  fish?: {
    enabled?: boolean;
    firstAudioTimeoutMs?: number;
    socketFactory?: () => FakeFishAudioSocket;
  };
}): Promise<{ sessionId: string }> {
  const claims = opts.claims ?? CLAIMS;
  const minted = await mintVoiceSessionToken(claims);
  const usageStore = new InMemoryVoiceUsageStore();

  attachVoiceWsHandler(opts.client, {
    requestedSessionId: claims.sessionId,
    buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
      new VoiceSession({
        sessionId: claims.sessionId,
        jti,
        organizationId: claims.organizationId,
        userId: claims.userId,
        agentId: claims.agentId,
        conversationId: claims.conversationId,
        tokenExpSeconds,
        cartesiaInkWebSocketFactory:
          opts.inkSocketFactory ?? (() => new FakeInkSocket()),
        cartesiaApiKey: "ct-key",
        cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
        fishAudioEnabled: opts.fish?.enabled,
        fishAudioApiKey: opts.fish?.enabled ? "fish-key" : undefined,
        fishAudioReferenceId: opts.fish?.enabled ? "fish-voice" : undefined,
        fishAudioModel: "s2.1-pro",
        fishAudioFirstAudioTimeoutMs: opts.fish?.firstAudioTimeoutMs,
        fishAudioWebSocketFactory:
          opts.fish?.socketFactory ?? (() => new FakeFishAudioSocket()),
        // Legacy lifecycle cases exercise AEC-safe acoustic interruption. New
        // half-duplex regressions opt out explicitly; production omits this
        // flag and therefore takes the safe half-duplex default.
        acousticBargeInEnabled: opts.acousticBargeInEnabled ?? true,
        allowContinuousHandoff: opts.allowContinuousHandoff,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.halfDuplexPlaybackSettleMs !== undefined
          ? {
              halfDuplexPlaybackSettleMs: opts.halfDuplexPlaybackSettleMs,
            }
          : {}),
        ...(opts.onTurnMetrics ? { onTurnMetrics: opts.onTurnMetrics } : {}),
        elizaEndpoint: "http://internal/api/v1/chat/completions",
        elizaAuthorization: "Bearer eliza-server",
        elizaModel: "gemma-4-31b",
        fetchImpl: opts.fetchImpl,
        ...(opts.prewarmElizaContext
          ? { prewarmElizaContext: opts.prewarmElizaContext }
          : {}),
        ...(opts.openingGreeting
          ? { openingGreeting: opts.openingGreeting }
          : {}),
        ...(opts.openingPrompt ? { openingPrompt: opts.openingPrompt } : {}),
        ...(opts.openingClientMessageId
          ? { openingClientMessageId: opts.openingClientMessageId }
          : {}),
        ...(opts.openingHistoryCutoffAt !== undefined
          ? { openingHistoryCutoffAt: opts.openingHistoryCutoffAt }
          : {}),
        ...(opts.openingFallbackGreeting
          ? { openingFallbackGreeting: opts.openingFallbackGreeting }
          : {}),
        ...(opts.cacheWarmingRetryDelaysMs
          ? {
              cacheWarmingRetryDelaysMs: opts.cacheWarmingRetryDelaysMs,
            }
          : {}),
        ...(opts.sttReconnectDelaysMs
          ? { sttReconnectDelaysMs: opts.sttReconnectDelaysMs }
          : {}),
        ...(opts.sttConnectTimeoutMs !== undefined
          ? { sttConnectTimeoutMs: opts.sttConnectTimeoutMs }
          : {}),
        ...(opts.sttPendingFrameLimit !== undefined
          ? { sttPendingFrameLimit: opts.sttPendingFrameLimit }
          : {}),
        usageStore,
        usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
        downlink: opts.onClearAudio
          ? { ...downlink, clearAudio: opts.onClearAudio }
          : downlink,
      }),
  });

  // Send the hello frame; verification is async.
  opts.client.clientSend(
    JSON.stringify({
      t: "hello",
      token: minted.token,
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    }),
  );
  await flush();
  return { sessionId: claims.sessionId };
}

// The fake Ink/Cartesia sockets and the SSE mock advance the session pipeline
// across chained `queueMicrotask` + short `setTimeout` hops (hello -> verify ->
// stt -> LLM SSE -> speaking -> downlink). A single fixed sleep raced that chain
// under a loaded event loop (the sequential 80-file unit batch on a busy CI
// runner), so assertions ran before the expected control frames landed and the
// suite flaked non-deterministically. Drain several full macrotask turns
// instead: each awaited timer lets one more hop settle, and the microtask queue
// flushes between them. This stays fast when nothing is pending but no longer
// depends on a single window being wide enough.
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function pcmChunk(bytes: number): Uint8Array {
  return new Uint8Array(bytes);
}

// --- tests ----------------------------------------------------------------

describe("voice-session WS lifecycle", () => {
  test("speaks a live opening greeting while the agent context warms", async () => {
    const client = new FakeClientSocket();
    let responseRequests = 0;
    await connectSession({
      client,
      openingGreeting: "hello? who's this?",
      fetchImpl: (async () => {
        responseRequests += 1;
        return makeCanonicalChunkFetch(["unused"])("", {});
      }) as unknown as typeof fetch,
    });
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.sentText()).toBe("hello? who's this?");
    expect(client.audioFrames.length).toBeGreaterThan(0);
    expect(client.controlTypes()).toContain("speaking_start");
    expect(responseRequests).toBe(0);
    const greetingLatencyLog = fakeLogger.logger.info.mock.calls.findLast(
      ([message]) => message === "[voice-session] opening greeting latency",
    );
    expect(greetingLatencyLog?.[1]).toMatchObject({
      greetingChars: "hello? who's this?".length,
      prewarmStatus: "not_configured",
      firstAudioMs: expect.any(Number),
      ttsTransportReadyMs: expect.any(Number),
      ttsSynthesisAfterReadyMs: expect.any(Number),
    });

    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
  });

  test("reuses the opening greeting socket for the first caller response", async () => {
    const beforeSockets = FakeCartesiaSocket.instances.length;
    const client = new FakeClientSocket();
    await connectSession({
      client,
      openingGreeting: "hey, what's up?",
      fetchImpl: makeSseFetch(["Not much. Good to hear from you."]),
    });
    await flush();
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    cartesia.emitDone();
    await flush();

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "not much");
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances).toHaveLength(beforeSockets + 1);
    expect(cartesia.sentText()).toContain("hey, what's up?");
    expect(cartesia.sentText().replaceAll(" ", "")).toContain(
      "Notmuch.Goodtohearfromyou.",
    );

    client.clientSend(JSON.stringify({ t: "bye" }));
    await flush();
    expect(cartesia.closed).toBe(true);
  });

  test("generates the call opener as a stable canonical system turn", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = new FakeClientSocket();
    await connectSession({
      client,
      openingPrompt: "The user called. Greet them using existing history.",
      openingClientMessageId: "twilio-call:CA123:started",
      openingHistoryCutoffAt: 1_725_000_000_000,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return makeCanonicalChunkFetch(["Good to hear from you again."])(
          "",
          {},
        );
      }) as unknown as typeof fetch,
    });
    await flush();

    expect(requests).toEqual([
      expect.objectContaining({
        text: "The user called. Greet them using existing history.",
        messageRole: "system",
        clientMessageId: "twilio-call:CA123:started",
        historyCutoffAt: 1_725_000_000_000,
        transientInput: true,
      }),
    ]);
    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toBe(
      "Good to hear from you again.",
    );
  });

  test("speaks a safe fixed greeting when contextual opener generation fails", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      openingPrompt: "Generate a contextual greeting.",
      openingClientMessageId: "twilio-call:CA-fallback:opening",
      openingFallbackGreeting: "Hello, thanks for calling Eliza.",
      fetchImpl: (async () =>
        new Response("provider unavailable", {
          status: 503,
        })) as unknown as typeof fetch,
    });
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toBe(
      "Hello, thanks for calling Eliza.",
    );
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "error", retryable: true }),
    );
  });

  test("speaks the safe fallback when the contextual opener completes without speech", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      openingPrompt: "Generate a contextual greeting.",
      openingClientMessageId: "twilio-call:CA-empty:opening",
      openingFallbackGreeting: "Hello, thanks for calling Eliza.",
      fetchImpl: makeCanonicalChunkFetch([], {}),
    });
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toBe(
      "Hello, thanks for calling Eliza.",
    );
  });

  test("speaks the safe fallback when unspoken model text precedes a stream failure", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      openingPrompt: "Generate a contextual greeting.",
      openingClientMessageId: "twilio-call:CA-partial:opening",
      openingFallbackGreeting: "Hello, thanks for calling Eliza.",
      fetchImpl: (async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: chunk\ndata: ${JSON.stringify({ chunk: "Hi" })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({ message: "provider failed" })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    });
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toBe(
      "Hello, thanks for calling Eliza.",
    );
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "error", retryable: true }),
    );
  });

  test("does not double-speak the fallback after contextual model audio starts", async () => {
    const controlled = makeControlledCanonicalChunkFetch();
    const client = new FakeClientSocket();
    await connectSession({
      client,
      openingPrompt: "Generate a contextual greeting.",
      openingClientMessageId: "twilio-call:CA-spoken:opening",
      openingFallbackGreeting: "Hello, thanks for calling Eliza.",
      fetchImpl: controlled.fetchImpl,
    });
    await controlled.ready;
    controlled.enqueueChunk(
      "Welcome home friend. This contextual greeting is intentionally long enough to cross the shared phrase ceiling and begin speaking as complete sentences before the upstream stream fails. The second complete sentence proves the fallback cannot double-speak after real model audio has already started.",
    );
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toContain(
      "Welcome home ",
    );
    expect(client.audioFrames.length).toBeGreaterThan(0);

    controlled.fail();
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).not.toContain(
      "Hello, thanks for calling Eliza.",
    );
  });

  test("stt_final posts the transcript to the canonical agent conversation stream with scoped identity", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        requests.push({
          url,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body)),
        });
        return makeCanonicalChunkFetch(["Canonical reply."])(url, init);
      }) as unknown as typeof fetch,
    });

    client.clientSend(
      JSON.stringify({
        t: "ui_context",
        context: {
          uiViewPath: "/notes",
          uiTimeZone: "America/New_York",
          role: "OWNER",
        },
      }),
    );
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.update", "hello agen");
    ink.emitTurn("turn.eager_end", "hello agent");
    ink.emitTurn("turn.end", "hello agent");
    client.clientSend(
      JSON.stringify({ t: "ui_context", context: { uiViewPath: "/calendar" } }),
    );
    await flush();

    const endOfTurnLog = fakeLogger.logger.info.mock.calls.findLast(
      ([message]) => message === "[voice-session] end-of-turn latency",
    );
    expect(endOfTurnLog?.[1]).toMatchObject({
      transcriptChars: "hello agent".length,
      callerResponseTurnIndex: 1,
      isFirstCallerResponse: true,
      configuredEndTimeoutMs: 8_000,
      turnActiveMs: expect.any(Number),
      firstTranscriptOffsetMs: expect.any(Number),
      lastTranscriptToFinalMs: expect.any(Number),
      eagerEndToFinalMs: expect.any(Number),
    });
    await flush();

    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "stt_partial", text: "hello agen" }),
    );
    expect(client.controlTypes()).toContain("stt_eager_eot");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe(
      "/api/v1/eliza/agents/agent-1/api/conversations/conv-1/messages/stream",
    );
    expect(requests[0].body).toEqual({
      text: "hello agent",
      channelType: "VOICE_DM",
      metadata: {
        clientTransport: "realtime_voice",
        uiViewPath: "/notes",
        uiTimeZone: "America/New_York",
      },
      streamProtocol: "delta-v2",
    });
    expect(requests[0].headers.authorization).toBe("Bearer eliza-server");
    expect(requests[0].headers["x-service-key"]).toBe("Bearer eliza-server");
    expect(requests[0].headers["x-eliza-agent-id"]).toBe("agent-1");
    expect(requests[0].headers["x-eliza-conversation-id"]).toBe("conv-1");
    expect(requests[0].headers["x-eliza-organization-id"]).toBe("org-1");
    expect(requests[0].headers["x-eliza-user-id"]).toBe("user-1");
    expect(requests[0].headers["x-eliza-voice-trace-id"]).toContain(
      "sess-lifecycle:turn:1:",
    );

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    cartesia.emitDone();
    await flush();
    expect(client.audioFrames.length).toBeGreaterThan(0);
    expect(client.controlTypes()).toContain("speaking_end");
    expect(client.controlTypes()).toContain("usage");
  });

  test("coalesces provider-rate interim revisions while preserving the exact final transcript", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeCanonicalChunkFetch(["Done."]),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    for (let index = 0; index < 100; index += 1) {
      ink.emitTurn("turn.update", `long transcript revision ${index}`);
    }

    const immediatePartials = client.controlFrames.filter(
      (frame) => frame.t === "stt_partial",
    );
    expect(immediatePartials).toEqual([
      expect.objectContaining({ text: "long transcript revision 0" }),
    ]);

    await flush();
    await flush();
    const coalescedPartials = client.controlFrames.filter(
      (frame) => frame.t === "stt_partial",
    );
    expect(coalescedPartials).toHaveLength(2);
    expect(coalescedPartials.at(-1)).toEqual(
      expect.objectContaining({ text: "long transcript revision 99" }),
    );

    ink.emitTurn("turn.update", "long transcript revision 99");
    await flush();
    expect(
      client.controlFrames.filter((frame) => frame.t === "stt_partial"),
    ).toHaveLength(2);

    ink.emitTurn("turn.end", "the exact final transcript");
    await flush();
    await flush();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "stt_final",
        text: "the exact final transcript",
      }),
    );

    ink.emitTurn("turn.update", "stale provider revision after final");
    await flush();
    expect(
      client.controlFrames.filter((frame) => frame.t === "stt_partial"),
    ).toHaveLength(2);
  });

  test("duplicate final events for one semantic turn dispatch and persist exactly once", async () => {
    const requests: Array<{ body: unknown }> = [];
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
        });
        return makeCanonicalChunkFetch(["Only once."])(url, init);
      }) as unknown as typeof fetch,
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "hello agent");
    ink.emitTurn("turn.end", "hello agent");
    await flush();
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: { text: "hello agent" },
    });
    expect(
      client.controlFrames.filter((frame) => frame.t === "stt_final"),
    ).toHaveLength(1);
  });

  test("hello -> ready -> full turn produces stt_final, llm_first_text, speaking, usage", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Hello.", " there."]),
    });

    // ready emitted after verified hello.
    expect(client.controlTypes()).toContain("ready");

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitConnectedHandshake(); // benign handshake, must NOT surface an error.
    expect(client.controlFrames.find((f) => f.t === "error")).toBeUndefined();

    // Drive a user turn.
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "hello agent");
    await flush();
    await flush();

    const types = client.controlTypes();
    expect(types).toContain("stt_final");
    expect(types).toContain("llm_first_text");
    expect(types).toContain("speaking_start");

    // Cartesia produced downlink audio.
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    cartesia.emitDone();
    await flush();
    expect(client.audioFrames.length).toBeGreaterThan(0);
    expect(client.controlTypes()).toContain("speaking_end");
    expect(client.controlTypes()).toContain("usage");
  });

  test("owned Dedicated transport completes the realtime LLM leg and forwards canonical VIEWS navigation", async () => {
    const claims = {
      sessionId: "sess-dedicated-navigation",
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      conversationId: "44444444-4444-4444-8444-444444444444",
    };
    dedicatedVoiceSandbox = {
      id: claims.agentId,
      organization_id: claims.organizationId,
      user_id: claims.userId,
      execution_tier: "dedicated-always",
      status: "running",
      headscale_ip: "100.64.0.21",
      bridge_url: null,
      health_url: null,
      environment_vars: { ELIZA_API_TOKEN: "agent-runtime-token" },
    };

    const previousMockRedis = process.env.MOCK_REDIS;
    process.env.MOCK_REDIS = "1";
    const originalFetch = globalThis.fetch;
    const upstreamCalls: Array<{
      url: string;
      headers: Headers;
      body: unknown;
    }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      upstreamCalls.push({
        url: request.url,
        headers: new Headers(request.headers),
        body: JSON.parse(await request.text()),
      });
      return makeCanonicalChunkFetch(["Opened Settings."], {
        actionResults: [
          {
            actionName: "VIEWS",
            success: true,
            values: {
              mode: "show",
              viewId: "settings",
              viewPath: "/settings",
            },
          },
        ],
      })(request.url);
    }) as typeof fetch;

    try {
      const { createInternalElizaConversationFetch } = await import(
        "../lib/internal-eliza-conversation-fetch"
      );
      const elizaFetch = createInternalElizaConversationFetch(
        {
          CACHE_ENABLED: "true",
          DATABASE_URL: "postgresql://must-not-connect.invalid/eliza",
          VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer eliza-server",
          AGENT_ROUTER_ORIGIN_HOST: "cp.example.test",
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
        } as Parameters<typeof createInternalElizaConversationFetch>[0],
        {
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          organizationId: claims.organizationId,
          userId: claims.userId,
        },
      );
      const client = new FakeClientSocket();
      await connectSession({
        client,
        claims,
        fetchImpl: elizaFetch,
        prewarmElizaContext: elizaFetch.prewarm,
      });

      const ink = FakeInkSocket.instances.at(-1)!;
      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "go to settings");
      for (
        let attempt = 0;
        attempt < 10 &&
        !client.controlFrames.some((frame) => frame.t === "navigate_view");
        attempt += 1
      ) {
        await flush();
      }

      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toBe(
        `https://cp.example.test/api/conversations/${claims.conversationId}/messages/stream`,
      );
      expect(upstreamCalls[0]?.headers.get("authorization")).toBe(
        "Bearer agent-runtime-token",
      );
      expect(upstreamCalls[0]?.headers.get("x-forwarded-host")).toBe(
        `${claims.agentId}.cloud.eliza.app`,
      );
      expect(upstreamCalls[0]?.body).toMatchObject({
        text: "go to settings",
        metadata: { clientTransport: "realtime_voice" },
        streamProtocol: "delta-v2",
      });
      expect(client.controlTypes()).toContain("stt_final");
      expect(client.controlTypes()).toContain("llm_first_text");
      expect(
        client.controlFrames.filter((frame) => frame.t === "navigate_view"),
      ).toEqual([
        {
          t: "navigate_view",
          viewId: "settings",
          viewPath: "/settings",
          traceId: expect.any(String),
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousMockRedis === undefined) delete process.env.MOCK_REDIS;
      else process.env.MOCK_REDIS = previousMockRedis;
    }
  });

  test("concurrent Dedicated prewarm and lifecycle start never writes into Shared history", async () => {
    const claims = {
      organizationId: "55555555-5555-4555-8555-555555555555",
      userId: "66666666-6666-4666-8666-666666666666",
      agentId: "77777777-7777-4777-8777-777777777777",
      conversationId: "88888888-8888-4888-8888-888888888888",
    };
    dedicatedVoiceSandbox = {
      id: claims.agentId,
      organization_id: claims.organizationId,
      user_id: claims.userId,
      execution_tier: "dedicated-always",
      status: "running",
      headscale_ip: "100.64.0.22",
      bridge_url: null,
      health_url: null,
      environment_vars: { ELIZA_API_TOKEN: "agent-runtime-token" },
    };

    const previousMockRedis = process.env.MOCK_REDIS;
    process.env.MOCK_REDIS = "1";
    let sharedCoordinatorCalls = 0;
    try {
      const { createInternalElizaConversationFetch } = await import(
        "../lib/internal-eliza-conversation-fetch"
      );
      const elizaFetch = createInternalElizaConversationFetch(
        {
          CACHE_ENABLED: "true",
          DATABASE_URL: "postgresql://must-not-connect.invalid/eliza",
          VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer eliza-server",
          AGENT_ROUTER_ORIGIN_HOST: "cp.example.test",
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
          SHARED_RUNTIME_CONVERSATIONS: {
            getByName() {
              return {
                async fetch() {
                  sharedCoordinatorCalls += 1;
                  return new Response(null, { status: 204 });
                },
              };
            },
          },
        } as unknown as Parameters<
          typeof createInternalElizaConversationFetch
        >[0],
        claims,
      );

      await Promise.all([
        elizaFetch.prewarm(),
        elizaFetch.recordLifecycleEvent({
          id: "twilio-call:CA-dedicated:started",
          content: "Call lifecycle event: the phone call started.",
          createdAt: Date.now(),
        }),
      ]);

      expect(sharedCoordinatorCalls).toBe(0);
    } finally {
      if (previousMockRedis === undefined) delete process.env.MOCK_REDIS;
      else process.env.MOCK_REDIS = previousMockRedis;
    }
  });

  test("forwards a successful terminal VIEWS handoff without exposing arbitrary actions", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeCanonicalChunkFetch(["Opened Notes."], {
        actionResults: [
          {
            actionName: "VIEWS",
            success: true,
            values: { mode: "show", viewId: "notes", viewPath: "/notes" },
          },
          {
            actionName: "UNRELATED_ACTION",
            success: true,
            values: { secret: "not-forwarded" },
          },
        ],
      }),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "open notes");
    await flush();
    await flush();

    expect(
      client.controlFrames.filter((frame) => frame.t === "navigate_view"),
    ).toEqual([
      {
        t: "navigate_view",
        viewId: "notes",
        viewPath: "/notes",
        traceId: expect.any(String),
      },
    ]);
    expect(JSON.stringify(client.controlFrames)).not.toContain("not-forwarded");
  });

  test("forwards a terminal APP launch through the originating Session turn trace", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeCanonicalChunkFetch(["Opened Demo."], {
        actionResults: [
          {
            actionName: "APP",
            success: true,
            values: {
              mode: "launch",
              viewId: "browser",
              viewPath: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
            },
          },
        ],
      }),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "launch demo");
    await flush();
    await flush();

    const firstText = client.controlFrames.find(
      (frame): frame is Extract<ServerControlFrame, { t: "llm_first_text" }> =>
        frame.t === "llm_first_text",
    );
    const navigation = client.controlFrames.filter(
      (frame) => frame.t === "navigate_view",
    );
    expect(firstText).toBeDefined();
    if (!firstText) throw new Error("expected an llm_first_text control frame");
    expect(navigation).toEqual([
      {
        t: "navigate_view",
        viewId: "browser",
        viewPath: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
        traceId: firstText.traceId,
      },
    ]);
  });

  test("does not forward ambiguous or non-canonical APP launch handoffs", async () => {
    for (const actionResults of [
      [
        {
          actionName: "APP",
          success: true,
          values: {
            mode: "launch",
            viewId: "browser",
            viewPath: "/browser?browse=javascript%3Aalert(1)",
          },
        },
      ],
      [
        {
          actionName: "APP",
          success: true,
          values: {
            mode: "launch",
            viewId: "browser",
            viewPath: "/browser?browse=https%3A%2F%2Fone.example",
          },
        },
        {
          actionName: "APP",
          success: true,
          values: {
            mode: "launch",
            viewId: "browser",
            viewPath: "/browser?browse=https%3A%2F%2Ftwo.example",
          },
        },
      ],
    ]) {
      const client = new FakeClientSocket();
      await connectSession({
        client,
        fetchImpl: makeCanonicalChunkFetch(["Opened Demo."], { actionResults }),
      });
      const ink = FakeInkSocket.instances.at(-1)!;
      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "launch demo");
      await flush();
      await flush();
      expect(
        client.controlFrames.filter((frame) => frame.t === "navigate_view"),
      ).toEqual([]);
    }
  });

  test("prewarms Eliza tenancy context when the live session starts", async () => {
    let prewarmCalls = 0;
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["ok."]),
      prewarmElizaContext: async () => {
        prewarmCalls += 1;
      },
    });
    expect(client.controlTypes()).toContain("ready");
    expect(prewarmCalls).toBe(1);
    const prewarmLog = fakeLogger.logger.info.mock.calls.findLast(
      ([message]) =>
        message === "[voice-session] Eliza context prewarm completed",
    );
    expect(prewarmLog?.[1]).toMatchObject({
      sessionId: CLAIMS.sessionId,
      prewarmDurationMs: expect.any(Number),
    });
  });

  test("first response does not wait for latency-only prewarm", async () => {
    const prewarm = new Promise<void>(() => undefined);
    const requestTexts: string[] = [];
    const successFetch = makeSseFetch(["Immediate response."]);
    const client = new FakeClientSocket();
    await connectSession({
      client,
      prewarmElizaContext: () => prewarm,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text: string };
        requestTexts.push(body.text);
        return successFetch(input, init);
      }) as typeof fetch,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    const ttsBefore = FakeCartesiaSocket.instances.length;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "first request");
    await flush();
    await flush();
    expect(FakeCartesiaSocket.instances.length).toBe(ttsBefore + 1);
    expect(requestTexts).toEqual(["first request"]);
    expect(client.controlTypes()).toContain("llm_first_text");
  });

  test("caps Cartesia server-side buffer delay for realtime voice", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["A short answer."]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "answer briefly");
    await flush();
    await flush();

    // Cartesia defaults to a 3000ms server aggregation window; the realtime
    // session must cap it so already-aggregated clauses start synthesis fast.
    // Select generation requests POSITIVELY (anything carrying a transcript);
    // filtering on the capped field itself would let a request that dropped
    // the cap vanish from the assertion instead of failing it (#16667).
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const requests = cartesia.sent
      .map(
        (entry) =>
          JSON.parse(entry) as {
            transcript?: string;
            cancel?: boolean;
            max_buffer_delay_ms?: number;
          },
      )
      .filter((entry) => typeof entry.transcript === "string");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.max_buffer_delay_ms).toBe(250);
    }
  });

  test("prewarms Cartesia as soon as the response turn starts", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["A short answer."]),
    });

    const before = FakeCartesiaSocket.instances.length;
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "answer briefly");

    // Socket creation is synchronous at turn start, before any asynchronous LLM
    // delta is consumed, so its handshake overlaps model generation.
    expect(FakeCartesiaSocket.instances.length).toBe(before + 1);
    await flush();
    await flush();
  });

  test("keeps Cartesia as the default realtime TTS provider when Fish flag is off", async () => {
    const client = new FakeClientSocket();
    const beforeFish = FakeFishAudioSocket.instances.length;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Default voice."]),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say default");
    await flush();
    await flush();

    expect(FakeFishAudioSocket.instances.length).toBe(beforeFish);
    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toContain(
      "Default voice.",
    );
  });

  test("uses Fish as primary when enabled and sends MessagePack phrase frames", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Fish primary response reaches audio quickly."]),
      fish: { enabled: true },
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say fish");
    await flush();
    await flush();

    const fish = FakeFishAudioSocket.instances.at(-1)!;
    expect(fish.sentFrames()[0]).toEqual({
      event: "start",
      request: {
        text: "",
        reference_id: "fish-voice",
        format: "pcm",
        sample_rate: 16000,
        latency: "balanced",
        chunk_length: 100,
      },
    });
    expect(fish.sentText()).toBe(
      "Fish primary response reaches audio quickly.",
    );
    expect(fish.sentFrames().at(-1)).toEqual({ event: "stop" });
    expect(client.audioFrames.at(-1)).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  test("falls back to Cartesia for Fish connect failure before first audio", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Fallback phrase."]),
      fish: {
        enabled: true,
        socketFactory: () => new FakeFishAudioSocket({ autoOpen: false }),
      },
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say fallback");
    await flush();
    const fish = FakeFishAudioSocket.instances.at(-1)!;
    fish.emitTransportError();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toContain(
      "Fallback phrase.",
    );
  });

  test("falls back to Cartesia for Fish first-audio timeout", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Timeout fallback."]),
      fish: {
        enabled: true,
        firstAudioTimeoutMs: 1,
        socketFactory: () => new FakeFishAudioSocket({ autoAudio: false }),
      },
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say timeout");
    await flush();
    await flush();

    expect(FakeCartesiaSocket.instances.at(-1)?.sentText()).toContain(
      "Timeout fallback.",
    );
  });

  test("does not fall back to Cartesia for Fish provider error before audio", async () => {
    const client = new FakeClientSocket();
    const beforeCartesia = FakeCartesiaSocket.instances.length;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Provider error."]),
      fish: {
        enabled: true,
        socketFactory: () => new FakeFishAudioSocket({ autoAudio: false }),
      },
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say no fallback");
    await flush();
    const fish = FakeFishAudioSocket.instances.at(-1)!;
    fish.emitProviderError();
    await flush();

    expect(FakeCartesiaSocket.instances.length).toBe(beforeCartesia);
    expect(
      client.controlFrames.find((frame) => frame.t === "error")?.code,
    ).toBe("fish_provider_rejected");
  });

  test("does not fall back to Cartesia after Fish produced first audio", async () => {
    const client = new FakeClientSocket();
    const beforeCartesia = FakeCartesiaSocket.instances.length;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Fish then fail."]),
      fish: { enabled: true },
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say no switch");
    await flush();
    const fish = FakeFishAudioSocket.instances.at(-1)!;
    fish.emitTransportError("post first audio failure");
    await flush();

    expect(FakeCartesiaSocket.instances.length).toBe(beforeCartesia);
    expect(
      client.controlFrames.find((frame) => frame.t === "error")?.code,
    ).toBe("websocket_error");
  });

  test("empty LLM reply cancels the prewarmed Cartesia context", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch([]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say nothing");
    await flush();
    await flush();

    // The context was opened speculatively at turn start; with no speakable
    // output it must be cancelled without closing the call-scoped transport,
    // and the turn still closes out with a usage frame.
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.closed).toBe(false);
    expect(cartesia.sent.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({ cancel: true }),
    );
    expect(client.controlTypes()).toContain("usage");
    expect(client.controlTypes()).not.toContain("speaking_start");
  });

  test("speaks an explicit recovery prompt for punctuation-only model output", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["?"]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "answer me");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.sentText()).toBe(
      "Sorry, I couldn't form a response. Could you say that again?",
    );
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "unspeakable_llm_reply",
        retryable: true,
      }),
    );
    expect(client.controlTypes()).toContain("speaking_start");
  });

  test("starts TTS at the high word-safe ceiling before a long unpunctuated stream completes", async () => {
    let aborted = false;
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(
        [
          "This deliberately long answer crosses the shared phrase ceiling at a natural word boundary while preserving complete spoken phrases for coherent prosody. It continues with enough useful detail to produce another complete phrase before the upstream response finishes, proving long replies still start speaking without chopping a final word into its own synthesis request. A third clause keeps this controlled stream open for the assertion.",
        ],
        {
          hang: true,
          onAbort: () => {
            aborted = true;
          },
        },
      ),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "answer quickly");
    await flush();
    await flush();

    // No punctuation or stream-end was delivered, but the bounded high
    // ceiling must already have sent a word-safe continuation to Cartesia.
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const requests = cartesia.sent
      .map(
        (entry) =>
          JSON.parse(entry) as { transcript?: string; continue?: boolean },
      )
      .filter((entry) => entry.transcript);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.continue).toBe(true);
    expect(client.controlTypes()).toContain("speaking_start");

    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(aborted).toBe(true);
  });

  test("sends a normal conversational reply as one terminal Sonic request", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch([
        "The sky is blue because the atmosphere scatters shorter blue wavelengths of sunlight more than other colors.",
      ]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "tell me about sunlight");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const requests = cartesia.sent
      .map(
        (entry) =>
          JSON.parse(entry) as { transcript?: string; continue?: boolean },
      )
      .filter((entry) => entry.transcript);
    expect(requests).toHaveLength(1);
    expect(requests.map((request) => request.transcript).join("")).toBe(
      "The sky is blue because the atmosphere scatters shorter blue wavelengths of sunlight more than other colors.",
    );
    expect(requests[0]?.continue).toBe(false);
  });

  test("starts a multi-sentence reply before terminal metadata without splitting words", async () => {
    let aborted = false;
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(
        [
          'Probably a spike in generation time or a hiccup in the stream. Those "thinking" pauses can come from later turn work.',
        ],
        {
          hang: true,
          onAbort: () => {
            aborted = true;
          },
        },
      ),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "why was that slow");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const requests = cartesia.sent
      .map(
        (entry) =>
          JSON.parse(entry) as { transcript?: string; continue?: boolean },
      )
      .filter((entry) => entry.transcript);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      transcript:
        "Probably a spike in generation time or a hiccup in the stream.",
      continue: true,
    });

    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(aborted).toBe(true);
  });

  test("canonical chunk/done SSE frames are parsed into speakable LLM text", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeCanonicalChunkFetch(["Canonical chunk."]),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "voice transcript");
    await flush();
    await flush();

    expect(client.controlTypes()).toContain("llm_first_text");
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.sentText()).toContain("Canonical chunk.");
    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("usage");
  });

  test("provisional action chunks and snapshots reach Cartesia only as the authoritative replacement", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeLocalTokenFetch(
        [
          { text: "Changed ", provisional: true },
          {
            text: "to warm.",
            fullText: "Changed to warm.",
            provisional: true,
          },
          { fullText: "Okay, I changed my personality to warm." },
        ],
        { fullText: "Okay, I changed my personality to warm." },
      ),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "make your personality warmer");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.sentText()).toBe("Okay, I changed my personality to warm.");
    expect(cartesia.sentText()).not.toContain("Changed to warm.");
    expect(client.controlTypes()).toContain("llm_first_text");
    expect(client.controlTypes()).not.toContain("error");
    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
  });

  test("a provisional action suffix after model text reaches Cartesia once at terminal authority", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeLocalTokenFetch(
        [
          { text: "Here are your notes" },
          { text: ": Call", provisional: true },
          {
            text: " Shaw",
            fullText: "Here are your notes: Call Shaw.",
            provisional: true,
          },
        ],
        { fullText: "Here are your notes: Call Shaw." },
      ),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "show my notes");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.sentText()).toBe("Here are your notes: Call Shaw.");
    expect(client.controlTypes()).not.toContain("error");
    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
  });

  test("terminal confirmation sends a provisional turnComplete acknowledgement to Cartesia once", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeLocalTokenFetch(
        [{ fullText: "Opened Notes.", provisional: true }],
        {
          fullText: "Opened Notes.",
          actionResults: [
            {
              actionName: "VIEWS",
              success: true,
              values: { mode: "show", viewId: "notes", viewPath: "/notes" },
            },
          ],
        },
      ),
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "open notes");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const synthesisTexts = cartesia.sent
      .map((frame) => JSON.parse(frame) as { transcript?: unknown })
      .flatMap((frame) =>
        typeof frame.transcript === "string" && frame.transcript.length > 0
          ? [frame.transcript]
          : [],
      );
    expect(synthesisTexts).toEqual(["Opened Notes."]);
    expect(client.controlTypes()).not.toContain("error");
    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
  });

  test("canonical incremental SSE chunk reaches Cartesia before stream completion", async () => {
    const controlled = makeControlledCanonicalChunkFetch();
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: controlled.fetchImpl,
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "voice transcript");
    await controlled.ready;

    const streamedChunk =
      "This first streamed sentence is intentionally long enough to contribute to the shared phrase ceiling without chopping any terminal word. A second complete sentence pushes the coherent first phrase to Cartesia before the response completes, while this final unfinished clause keeps the controlled upstream stream open for the assertion ";
    controlled.enqueueChunk(streamedChunk);
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(client.controlTypes()).toContain("llm_first_text");
    const spokenPrefix = cartesia.sentText();
    expect(spokenPrefix.length).toBeGreaterThan(0);
    expect(streamedChunk.startsWith(spokenPrefix)).toBe(true);
    expect(client.audioFrames.length).toBeGreaterThan(0);
    expect(client.controlTypes()).not.toContain("usage");

    controlled.finish();
    await flush();
    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("usage");
  });

  test("reply-ready closes short TTS early but preserves late view navigation", async () => {
    const controlled = makeControlledCanonicalChunkFetch();
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: controlled.fetchImpl,
    });

    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "open notes");
    await controlled.ready;

    controlled.enqueueChunk("Opened Notes.");
    controlled.enqueueReplyReady("Opened Notes.");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const synthesisRequests = cartesia.sent.map(
      (frame) =>
        JSON.parse(frame) as { transcript?: string; continue?: boolean },
    );
    expect(synthesisRequests).toContainEqual(
      expect.objectContaining({
        transcript: "Opened Notes.",
        continue: false,
      }),
    );

    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
    expect(client.controlTypes()).not.toContain("usage");
    expect(client.controlTypes()).not.toContain("navigate_view");

    controlled.finish({
      fullText: "Opened Notes.",
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          values: { mode: "show", viewId: "notes", viewPath: "/notes" },
        },
      ],
    });
    await flush();
    await flush();

    expect(
      client.controlFrames.filter((frame) => frame.t === "navigate_view"),
    ).toEqual([
      {
        t: "navigate_view",
        viewId: "notes",
        viewPath: "/notes",
        traceId: expect.any(String),
      },
    ]);
    expect(client.controlTypes()).toContain("usage");
  });

  test("terminal Cartesia phrase carries continue:false and no empty-transcript finish (live-provider fix)", async () => {
    // Regression from the LIVE-provider evidence run: the session used to send
    // every phrase with continue:true then an empty-transcript finish(), which
    // the real Cartesia API rejects with "No valid transcripts passed" (400) ->
    // tts_error, zero audio. The fix holds one phrase back so the terminal
    // speakable phrase closes the context with continue:false, and NEVER sends
    // an empty transcript.
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Hello there.", " The weather is sunny."]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "whats the weather");
    await flush();
    await flush();
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const requests = cartesia.sent.map(
      (s) => JSON.parse(s) as { transcript?: string; continue?: boolean },
    );
    // No generation request carries an empty transcript.
    expect(
      requests.every(
        (r) => typeof r.transcript !== "string" || r.transcript.length > 0,
      ),
    ).toBe(true);
    // Exactly the terminal speakable phrase closes the context (continue:false);
    // all earlier phrases keep it open (continue:true).
    const withText = requests.filter(
      (r) => typeof r.transcript === "string" && r.transcript.length > 0,
    );
    expect(withText.length).toBeGreaterThan(0);
    expect(withText.at(-1)!.continue).toBe(false);
    for (const r of withText.slice(0, -1)) expect(r.continue).toBe(true);
  });

  test("end_audio is a graceful no-op (not control_unknown_type) after ready", async () => {
    // Regression: a bounded-clip client sends `end_audio` after its audio. The
    // live run showed the real server errored with `control_unknown_type`, and
    // the client treated that terminal error as a reason to close before TTS.
    // `end_audio` post-hello must NOT surface an error and must NOT close.
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    const beforeErrors = client.controlFrames.filter(
      (f) => f.t === "error",
    ).length;
    client.clientSend(JSON.stringify({ t: "end_audio" }));
    await flush();
    const afterErrors = client.controlFrames.filter(
      (f) => f.t === "error",
    ).length;
    expect(afterErrors).toBe(beforeErrors);
    expect(client.closedWith).toBeNull();
  });

  test("empty-transcript final closes the turn (usage + clears turn id)", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["unused."]) });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", ""); // silence/noise: empty final.
    await flush();
    // The empty turn is closed out: a usage frame is emitted and no TTS runs.
    expect(client.controlTypes()).toContain("stt_final");
    expect(client.controlTypes()).toContain("usage");
    expect(client.controlTypes()).not.toContain("speaking_start");
    // A stray barge_in now does NOT emit interrupted (no active turn).
    const beforeInterrupt = client.controlFrames.filter(
      (f) => f.t === "interrupted",
    ).length;
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    const afterInterrupt = client.controlFrames.filter(
      (f) => f.t === "interrupted",
    ).length;
    expect(afterInterrupt).toBe(beforeInterrupt);
  });

  test("uplink is re-framed to exact 3200-byte Ink chunks", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    const ink = FakeInkSocket.instances.at(-1)!;

    // Send 3500 bytes in odd chunks; expect exactly one 3200 frame, 300 held.
    client.clientSend(pcmChunk(1000));
    client.clientSend(pcmChunk(2500));
    await flush();
    expect(ink.sentChunks.length).toBe(1);
    expect(ink.sentChunks[0].byteLength).toBe(3200);

    // Another 3200 completes a second frame.
    client.clientSend(pcmChunk(3200));
    await flush();
    expect(ink.sentChunks.length).toBe(2);
    expect(ink.sentChunks.every((c) => c.byteLength === 3200)).toBe(true);
  });

  test("divergent Eliza text surfaces the typed protocol_error at the WS boundary", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeLocalTokenFetch(
        [{ text: "Opened Notes." }, { fullText: "Created a note instead." }],
        { fullText: "Created a note instead." },
      ),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "open notes");
    await flush();
    await flush();

    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "protocol_error",
        retryable: true,
      }),
    );
    expect(client.controlTypes()).toContain("usage");
    expect(client.closedWith).toBeNull();
  });

  test("LLM upstream failure becomes a retryable turn error and returns to listening", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: (async () =>
        new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "please answer");
    await flush();
    await flush();

    const error = client.controlFrames.find(
      (f) => f.t === "error" && f.code === "upstream_error",
    );
    expect(error).toMatchObject({ retryable: true });
    expect(client.controlTypes()).toContain("usage");

    const usageCount = client
      .controlTypes()
      .filter((t) => t === "usage").length;
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.controlTypes().filter((t) => t === "usage").length).toBe(
      usageCount,
    );
    expect(client.closedWith).toBeNull();
  });

  test("cache-warming 503s retry the same voice turn until it can speak", async () => {
    const client = new FakeClientSocket();
    const successFetch = makeSseFetch(["Cache warmed. Here is your answer."]);
    let calls = 0;
    await connectSession({
      client,
      cacheWarmingRetryDelaysMs: [0, 0, 0],
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls <= 2) {
          return Response.json(
            {
              success: false,
              error: "Shared runtime cache is warming. Retry shortly.",
              code: "shared_runtime_cache_warming",
              retryable: true,
            },
            { status: 503 },
          );
        }
        return successFetch(input, init);
      }) as typeof fetch,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "please answer once caches are warm");
    await flush();
    await flush();

    expect(calls).toBe(3);
    expect(client.controlTypes()).not.toContain("error");
    expect(client.controlTypes()).toContain("llm_first_text");
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(cartesia.sentText()).toBe("Cache warmed. Here is your answer.");
    const latencyLog = fakeLogger.logger.info.mock.calls.findLast(
      ([message]) => message === "[voice-session] first-turn latency",
    );
    expect(latencyLog?.[1]).toMatchObject({
      callerResponseTurnIndex: 1,
      isFirstCallerResponse: true,
      upstreamAttemptCount: 3,
      prewarmStatus: "not_configured",
      ttsTransportReadyMs: expect.any(Number),
      ttsSynthesisAfterReadyMs: expect.any(Number),
      upstreamAttempts: [
        { attempt: 1, status: 503 },
        { attempt: 2, status: 503 },
        { attempt: 3, status: 200 },
      ],
    });
    const timingFields = latencyLog?.[1] as
      | { upstreamSuccessfulHeadersOffsetMs?: number }
      | undefined;
    expect(
      timingFields?.upstreamSuccessfulHeadersOffsetMs,
    ).toBeGreaterThanOrEqual(0);
    cartesia.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
  });

  test("prewarm completion wakes a cold-turn retry before its backoff expires", async () => {
    const prewarm = Promise.withResolvers<void>();
    const client = new FakeClientSocket();
    const successFetch = makeSseFetch(["Warm now."]);
    let calls = 0;
    await connectSession({
      client,
      prewarmElizaContext: () => prewarm.promise,
      cacheWarmingRetryDelaysMs: [5_000],
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          prewarm.resolve();
          return Response.json(
            {
              success: false,
              error: "Shared runtime cache is warming. Retry shortly.",
              code: "shared_runtime_cache_warming",
              retryable: true,
            },
            { status: 503 },
          );
        }
        return successFetch(input, init);
      }) as typeof fetch,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "answer after prewarm");
    await flush();
    await flush();

    expect(calls).toBe(2);
    expect(client.controlTypes()).toContain("llm_first_text");
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    cartesia.emitDone();
    client.clientSend(JSON.stringify({ t: "bye" }));
    await flush();
  });

  test("canonical 402 becomes a non-retryable insufficient-credits turn error", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: (async () =>
        Response.json(
          {
            success: false,
            error:
              "Insufficient credits. Required: $0.0014, Available: $0.0000",
            code: "insufficient_credits",
            retryable: false,
          },
          { status: 402 },
        )) as unknown as typeof fetch,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "please answer");
    await flush();
    await flush();

    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "insufficient_credits",
        retryable: false,
      }),
    );
    expect(client.controlTypes()).toContain("usage");
    expect(client.closedWith).toBeNull();
  });

  test("canonical 404 Agent not found is exposed in a bounded public voice error payload", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: (async () =>
        Response.json(
          {
            success: false,
            error: "Agent not found",
          },
          { status: 404 },
        )) as unknown as typeof fetch,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "please answer");
    await flush();
    await flush();

    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "upstream_error",
        retryable: false,
        upstreamStatus: 404,
        upstreamMessage: "Agent not found",
      }),
    );
    const errorFrame = client.controlFrames.find(
      (f) => f.t === "error" && "upstreamStatus" in f,
    ) as Record<string, unknown> | undefined;
    expect(JSON.stringify(errorFrame)).not.toContain("Bearer");
    expect(JSON.stringify(errorFrame)).not.toContain("X-Service-Key");
    expect(client.controlTypes()).toContain("usage");
    expect(client.closedWith).toBeNull();
  });

  test("TTS provider error becomes retryable client error and closes the active turn", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeCanonicalChunkFetch(["This should fail in TTS."]),
      acousticBargeInEnabled: false,
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "speak this");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    cartesia.emitProviderError("cartesia_overloaded");
    await flush();

    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "cartesia_overloaded",
        retryable: true,
      }),
    );
    expect(client.controlTypes()).toContain("usage");
    const usageCount = client
      .controlTypes()
      .filter((t) => t === "usage").length;
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.controlTypes().filter((t) => t === "usage").length).toBe(
      usageCount,
    );
    const chunksBeforeResume = ink.sentChunks.length;
    client.clientSend(pcmChunk(3_200));
    await flush();
    expect(ink.sentChunks.length).toBeGreaterThan(chunksBeforeResume);
  });

  test("barge-in cancels TTS with ZERO post-cancel binary frames", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Speaking now."]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say something");
    await flush();
    await flush();
    const framesBefore = client.audioFrames.length;
    expect(framesBefore).toBeGreaterThan(0);

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    // Explicit barge-in.
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.controlTypes()).toContain("interrupted");
    expect(cartesia.closed).toBe(false);
    // The interrupted turn reports usage (accounting stays accurate on barge-in),
    // emitted BEFORE the interrupted frame.
    const types = client.controlTypes();
    expect(types.indexOf("usage")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("usage")).toBeLessThan(
      types.lastIndexOf("interrupted"),
    );

    // Any late chunk from a cancelled Cartesia context must NOT reach the client.
    const framesAfterInterrupt = client.audioFrames.length;
    // A stale provider chunk arriving post-cancel is dropped two ways: the
    // adapter drops it, and even if it didn't the session's turn-id guard does.
    // Flushing here proves no late frame leaks through after the barge-in.
    await flush();
    expect(client.audioFrames.length).toBe(framesAfterInterrupt);
  });

  test("verified browser AEC keeps old speech playing, rejects echo, and hands off at a phrase boundary", async () => {
    const client = new FakeClientSocket();
    const reply =
      "The assistant is speaking a deliberately long first clause for overlap testing. " +
      "It keeps talking while the human asks a new and unrelated question. " +
      "Additional generated explanation remains queued beyond the audible opening. ".repeat(
        40,
      );
    await connectSession({
      client,
      fetchImpl: makeSseFetch([reply]),
      acousticBargeInEnabled: false,
      allowContinuousHandoff: true,
    });
    client.clientSend(
      JSON.stringify({
        t: "audio_capabilities",
        mode: "continuous_handoff",
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        referenceAwarePlayback: true,
      }),
    );
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "start the overlap proof");
    await flush();
    await flush();
    expect(client.controlTypes()).toContain("assistant_playing");

    const finalsBeforeEcho = client.controlFrames.filter(
      (frame) => frame.t === "stt_final",
    ).length;
    ink.emitTurn("turn.start");
    ink.emitTurn(
      "turn.update",
      "The assistant is speaking a deliberately long first clause",
    );
    ink.emitTurn(
      "turn.end",
      "The assistant is speaking a deliberately long first clause",
    );
    await flush();
    expect(client.controlTypes()).toContain("echo_rejected");
    expect(
      client.controlFrames.filter((frame) => frame.t === "stt_final"),
    ).toHaveLength(finalsBeforeEcho);

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.update", "actually tell me something new please");
    ink.emitTurn("turn.end", "actually tell me something new please");
    await flush();
    await flush();
    expect(client.controlTypes()).toContain("human_double_talk");
    expect(client.controlTypes()).toContain("user_eos");
    expect(client.controlTypes()).toContain("next_reply_ready");
    expect(client.controlFrames).not.toContainEqual(
      expect.objectContaining({ t: "interrupted", reason: "acoustic" }),
    );

    FakeCartesiaSocket.instances.at(-1)!.emitFlushDone();
    await flush();
    expect(client.controlTypes()).toContain("handoff_requested");
    expect(client.controlTypes()).toContain("handoff_completed");

    const handoffsBeforeThirdTurn = client.controlFrames.filter(
      (frame) => frame.t === "handoff_completed",
    ).length;
    const sonic = FakeCartesiaSocket.instances.at(-1)!;
    expect(
      sonic.sent
        .map((message) => JSON.parse(message))
        .some((message) => message.flush === true && message.continue === true),
    ).toBe(true);
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "Please now explain a completely different topic");
    await flush();
    await flush();
    sonic.emitFlushDone();
    await flush();
    expect(
      client.controlFrames.filter((frame) => frame.t === "handoff_completed"),
    ).toHaveLength(handoffsBeforeThirdTurn + 1);
  });

  test("continuous handoff reports human double-talk only after assistant audio starts", async () => {
    const client = new FakeClientSocket();
    const controlled = makeControlledCanonicalChunkFetch();
    await connectSession({
      client,
      fetchImpl: controlled.fetchImpl,
      acousticBargeInEnabled: false,
      allowContinuousHandoff: true,
    });
    client.clientSend(
      JSON.stringify({
        t: "audio_capabilities",
        mode: "continuous_handoff",
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        referenceAwarePlayback: true,
      }),
    );
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "start a reply but do not speak yet");
    await controlled.ready;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.update", "this arrives while the assistant is thinking");
    await flush();
    expect(client.controlTypes()).not.toContain("human_double_talk");

    controlled.enqueueChunk(
      "The assistant is now producing audio for a real overlap test.",
    );
    controlled.finish();
    await flush();
    await flush();
    expect(client.controlTypes()).toContain("assistant_playing");

    ink.emitTurn("turn.update", "now this genuinely overlaps the assistant");
    await flush();
    expect(client.controlTypes()).toContain("human_double_talk");
  });

  test("continuous handoff serializes canonical conversation writes while old model output is streaming", async () => {
    const client = new FakeClientSocket();
    const first = makeControlledCanonicalChunkFetch();
    const second = makeCanonicalChunkFetch([
      "The prepared follow-up is safe to hand off now.",
    ]);
    let fetchCalls = 0;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return fetchCalls === 1 ? first.fetchImpl(...args) : second(...args);
    }) as typeof fetch;
    await connectSession({
      client,
      fetchImpl,
      acousticBargeInEnabled: false,
      allowContinuousHandoff: true,
    });
    client.clientSend(
      JSON.stringify({
        t: "audio_capabilities",
        mode: "continuous_handoff",
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        referenceAwarePlayback: true,
      }),
    );
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "start the long response");
    await first.ready;
    first.enqueueChunk(
      "The first canonical response becomes audible as a complete sentence after crossing the shared phrase ceiling. A second complete sentence preserves natural prosody while its model stream remains open long enough to prove ordered conversation writes. ",
    );
    await flush();
    await flush();
    expect(client.controlTypes()).toContain("assistant_playing");

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "prepare a follow-up without racing history");
    await flush();
    expect(fetchCalls).toBe(1);

    first.finish();
    await flush();
    await flush();
    expect(fetchCalls).toBe(2);
    expect(client.controlTypes()).toContain("next_reply_ready");
  });

  test("continuous handoff preserves two finalized utterances while old model output is streaming", async () => {
    const client = new FakeClientSocket();
    const first = makeControlledCanonicalChunkFetch();
    const second = makeCanonicalChunkFetch([
      "The prepared follow-up is safe to hand off now.",
    ]);
    let fetchCalls = 0;
    const transcripts: string[] = [];
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      transcripts.push(JSON.parse(String(args[1]?.body)).text);
      fetchCalls += 1;
      return fetchCalls === 1 ? first.fetchImpl(...args) : second(...args);
    }) as typeof fetch;
    await connectSession({
      client,
      fetchImpl,
      acousticBargeInEnabled: false,
      allowContinuousHandoff: true,
    });
    client.clientSend(
      JSON.stringify({
        t: "audio_capabilities",
        mode: "continuous_handoff",
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        referenceAwarePlayback: true,
      }),
    );
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "start the long response");
    await first.ready;
    first.enqueueChunk(
      "The first canonical response becomes audible as a complete sentence after crossing the shared phrase ceiling. A second complete sentence preserves natural prosody while its model stream remains open long enough to prove ordered conversation writes. ",
    );
    await flush();
    await flush();
    expect(client.controlTypes()).toContain("assistant_playing");

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "prepare a follow-up without racing history");
    await flush();
    expect(fetchCalls).toBe(1);

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "retain this second follow-up too");
    await flush();
    expect(fetchCalls).toBe(1);

    first.finish();
    await flush();
    await flush();
    expect(transcripts).toEqual([
      "start the long response",
      "prepare a follow-up without racing history",
      "retain this second follow-up too",
    ]);
    expect(client.controlTypes()).toContain("next_reply_ready");
  });

  test.each(["barge_in", "bye"] as const)(
    "%s cancels queued finalized utterances before dispatch",
    async (control) => {
      const client = new FakeClientSocket();
      const first = makeControlledCanonicalChunkFetch();
      const second = makeCanonicalChunkFetch([
        "The prepared follow-up is safe to hand off now.",
      ]);
      let fetchCalls = 0;
      const transcripts: string[] = [];
      const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
        transcripts.push(JSON.parse(String(args[1]?.body)).text);
        fetchCalls += 1;
        return fetchCalls === 1 ? first.fetchImpl(...args) : second(...args);
      }) as typeof fetch;
      await connectSession({
        client,
        fetchImpl,
        acousticBargeInEnabled: false,
        allowContinuousHandoff: true,
      });
      client.clientSend(
        JSON.stringify({
          t: "audio_capabilities",
          mode: "continuous_handoff",
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          referenceAwarePlayback: true,
        }),
      );
      const ink = FakeInkSocket.instances.at(-1)!;
      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "start the long response");
      await first.ready;
      first.enqueueChunk(
        "The first canonical response becomes audible as a complete sentence after crossing the shared phrase ceiling. A second complete sentence preserves natural prosody while its model stream remains open long enough to prove ordered conversation writes. ",
      );
      await flush();
      await flush();
      expect(client.controlTypes()).toContain("assistant_playing");

      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "prepare a follow-up without racing history");
      await flush();
      expect(fetchCalls).toBe(1);

      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "retain this second follow-up too");
      await flush();
      expect(fetchCalls).toBe(1);

      client.clientSend(JSON.stringify({ t: control }));
      await flush();
      await flush();
      expect(transcripts).toEqual(["start the long response"]);
      expect(client.controlTypes()).not.toContain("next_reply_ready");
    },
  );

  test.each([false, true])(
    "later overlap waits for canonical persistence to settle (playback ended: %s)",
    async (playbackEnded) => {
      const client = new FakeClientSocket();
      const first = makeCanonicalChunkFetch([
        "The first response is still playing while follow-up requests arrive.",
      ]);
      const pending = makeControlledCanonicalChunkFetch();
      const replacement = makeCanonicalChunkFetch([
        "The replacement reply follows the settled prior request.",
      ]);
      let fetchCalls = 0;
      const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        if (fetchCalls === 1) return first(...args);
        if (fetchCalls === 2) return pending.fetchImpl(...args);
        return replacement(...args);
      }) as typeof fetch;
      await connectSession({
        client,
        fetchImpl,
        acousticBargeInEnabled: false,
        allowContinuousHandoff: true,
      });
      client.clientSend(
        JSON.stringify({
          t: "audio_capabilities",
          mode: "continuous_handoff",
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          referenceAwarePlayback: true,
        }),
      );
      const ink = FakeInkSocket.instances.at(-1)!;
      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "start a response");
      await flush();
      await flush();
      expect(client.controlTypes()).toContain("assistant_playing");
      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "prepare the first follow-up");
      await pending.ready;
      try {
        if (playbackEnded) {
          FakeCartesiaSocket.instances.at(-1)!.emitDone();
          await flush();
        }
        ink.emitTurn("turn.start");
        ink.emitTurn("turn.end", "replace that with the next follow-up");
        await flush();
        expect(fetchCalls).toBe(2);
      } finally {
        pending.enqueueChunk(
          "The prior follow-up is committed before the next request.",
        );
        pending.finish();
      }
      await flush();
      expect(fetchCalls).toBe(3);
    },
  );
  test("half duplex drops speaker echo through playback and bounded settle", async () => {
    let nowMs = Date.now();
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Assistant audio must not become caller text."]),
      acousticBargeInEnabled: false,
      halfDuplexPlaybackSettleMs: 600,
      now: () => nowMs,
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say the answer");
    await flush();
    await flush();
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(client.controlTypes()).toContain("speaking_start");

    const providerChunksBeforeEcho = ink.sentChunks.length;
    const finalsBeforeEcho = client.controlFrames.filter(
      (frame) => frame.t === "stt_final",
    ).length;
    client.clientSend(pcmChunk(3_200));
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.update", "Assistant audio must not become caller text");
    ink.emitTurn("turn.end", "Assistant audio must not become caller text");
    await flush();

    expect(ink.sentChunks).toHaveLength(providerChunksBeforeEcho);
    expect(
      client.controlFrames.filter((frame) => frame.t === "stt_final"),
    ).toHaveLength(finalsBeforeEcho);
    expect(client.controlFrames).not.toContainEqual(
      expect.objectContaining({ t: "interrupted", reason: "acoustic" }),
    );

    cartesia.emitDone();
    client.clientSend(pcmChunk(3_200));
    expect(ink.sentChunks).toHaveLength(providerChunksBeforeEcho);

    nowMs += 1_000;
    client.clientSend(pcmChunk(3_200));
    await flush();
    expect(ink.sentChunks.length).toBeGreaterThan(providerChunksBeforeEcho);
  });

  test("emits bounded payload-free turn timing and half-duplex metrics", async () => {
    let nowMs = Date.now();
    const receipts: VoiceTurnMetricsReceipt[] = [];
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Copy that.", " Bravo 913 noted."]),
      acousticBargeInEnabled: false,
      halfDuplexPlaybackSettleMs: 600,
      now: () => nowMs,
      onTurnMetrics: (receipt) => receipts.push(receipt),
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "voice checkpoint");
    await flush();
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(client.controlTypes()).toContain("speaking_start");

    nowMs += 45;
    cartesia.emitAudio(new Uint8Array(8));
    client.clientSend(pcmChunk(3_200));
    nowMs += 30;
    cartesia.emitDone();
    await flush();

    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe("completed");
    expect(receipt.llmDeltaCount).toBe(2);
    expect(receipt.sonicRequestCount).toBe(1);
    expect(receipt.sonicRequestOffsetsMs.length).toBeLessThanOrEqual(16);
    expect(receipt.audioFrameCount).toBe(2);
    expect(receipt.outboundAudioBytes).toBe(12);
    expect(receipt.maxAudioFrameGapMs).toBe(45);
    expect(receipt.completionOffsetMs).toBe(75);
    expect(receipt.halfDuplexArmedCount).toBe(1);
    expect(receipt.halfDuplexSettlingCount).toBe(1);
    expect(receipt.halfDuplexSuppressedFrameCount).toBe(1);
    expect(receipt.halfDuplexSuppressedBytes).toBe(3_200);
    expect(Object.keys(receipt)).not.toContain("transcript");
    expect(Object.keys(receipt)).not.toContain("text");
    expect(Object.keys(receipt)).not.toContain("audio");
  });

  test.each(["expired", "client_disconnect"] as const)(
    "records an interrupted turn exactly once when its session is %s",
    async (reason) => {
      let nowMs = Date.now();
      const receipts: VoiceTurnMetricsReceipt[] = [];
      const client = new FakeClientSocket();
      const { sessionId } = await connectSession({
        client,
        fetchImpl: makeSseFetch(["A response still playing."]),
        now: () => nowMs,
        onTurnMetrics: (receipt) => receipts.push(receipt),
      });
      const ink = FakeInkSocket.instances.at(-1)!;
      ink.emitTurn("turn.start");
      ink.emitTurn("turn.end", "read this page");
      await flush();
      expect(client.controlTypes()).toContain("speaking_start");
      const cartesia = FakeCartesiaSocket.instances.at(-1)!;
      nowMs += 120;
      expect(
        getVoiceSessionRegistry().severBySessionId(sessionId, reason),
      ).toBe(true);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.outcome).toBe("interrupted");
      expect(receipts[0]?.completionOffsetMs).toBe(120);
      cartesia.emitDone();
      client.clientClose();
      await flush();
      expect(receipts).toHaveLength(1);
      expect(Object.keys(receipts[0]!)).not.toContain("text");
      expect(Object.keys(receipts[0]!)).not.toContain("audio");
    },
  );

  test("explicit barge-in immediately releases half-duplex suppression", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Speaking until the explicit stop control."]),
      acousticBargeInEnabled: false,
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "start speaking");
    await flush();
    await flush();
    expect(client.controlTypes()).toContain("speaking_start");

    const providerChunksBeforeBargeIn = ink.sentChunks.length;
    client.clientSend(pcmChunk(3_200));
    expect(ink.sentChunks).toHaveLength(providerChunksBeforeBargeIn);

    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "interrupted", reason: "explicit" }),
    );

    client.clientSend(pcmChunk(3_200));
    await flush();
    expect(ink.sentChunks.length).toBeGreaterThan(providerChunksBeforeBargeIn);
  });

  test("confirmed caller words interrupt immediately and get the next response", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch([
        "I will keep speaking until you say something.",
      ]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "please explain");
    await flush();
    await flush();

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(client.controlTypes()).toContain("speaking_start");
    expect(cartesia.closed).toBe(false);

    const audioBeforeInterruption = client.audioFrames.length;
    ink.emitTurn("turn.start");
    await flush();
    expect(client.controlFrames).not.toContainEqual(
      expect.objectContaining({ t: "interrupted", reason: "acoustic" }),
    );
    expect(cartesia.closed).toBe(false);

    ink.emitTurn("turn.update", "wait");
    await flush();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "interrupted", reason: "acoustic" }),
    );
    expect(cartesia.closed).toBe(false);
    expect(client.audioFrames).toHaveLength(audioBeforeInterruption);

    ink.emitTurn("turn.end", "wait");
    await flush();
    await flush();
    expect(FakeCartesiaSocket.instances.at(-1)).toBe(cartesia);
    expect(client.audioFrames.length).toBeGreaterThan(audioBeforeInterruption);
  });

  test("confirmed caller words flush transport audio after server TTS completed", async () => {
    const client = new FakeClientSocket();
    let clearCount = 0;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["A response Twilio may buffer."]),
      onClearAudio: () => {
        clearCount += 1;
      },
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "say something");
    await flush();
    await flush();
    FakeCartesiaSocket.instances.at(-1)!.emitDone();
    await flush();
    expect(client.controlTypes()).toContain("speaking_end");
    clearCount = 0;

    ink.emitTurn("turn.start");
    await flush();
    expect(clearCount).toBe(0);

    ink.emitTurn("turn.update", "wait");
    await flush();
    expect(clearCount).toBe(1);
  });

  test("a final-only caller transcript still interrupts the active response", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["The response is still in progress."]),
    });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "start talking");
    await flush();
    await flush();

    const activeCartesia = FakeCartesiaSocket.instances.at(-1)!;
    expect(client.controlTypes()).toContain("speaking_start");
    expect(activeCartesia.closed).toBe(false);

    // Ink may finalize a short utterance without sending an interim update.
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "stop");
    await flush();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "interrupted", reason: "acoustic" }),
    );
    expect(activeCartesia.closed).toBe(false);
  });

  test("interruption aborts the in-flight Eliza SSE fetch", async () => {
    let aborted = false;
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["partial"], {
        hang: true,
        onAbort: () => (aborted = true),
      }),
    });
    const ink = FakeInkSocket.instances.at(-1)!;
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "long answer please");
    await flush();

    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    await flush();
    expect(aborted).toBe(true);
    expect(client.controlTypes()).toContain("interrupted");
  });

  test("abrupt mid-turn disconnect synchronously reaps the registry before replacement hello", async () => {
    const source = new FakeClientSocket();
    await connectSession({
      client: source,
      fetchImpl: makeSseFetch(["still generating"], { hang: true }),
    });
    const sourceInk = FakeInkSocket.instances.at(-1)!;
    sourceInk.emitTurn("turn.start");
    sourceInk.emitTurn("turn.end", "disconnect me");
    await flush();
    expect(getVoiceSessionRegistry().size()).toBe(1);

    source.clientClose();
    expect(getVoiceSessionRegistry().size()).toBe(0);
    expect(sourceInk.closed).toBe(true);

    const replacement = new FakeClientSocket();
    await connectSession({
      client: replacement,
      fetchImpl: makeSseFetch(["recovered."]),
    });
    expect(replacement.controlTypes()).toContain("ready");
    expect(getVoiceSessionRegistry().size()).toBe(1);
  });

  test("bye tears down providers, unregisters, closes cleanly, and revokes the bootstrap token", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    const revoked: Array<{ jti: string; expSeconds: number }> = [];
    const usageStore = new InMemoryVoiceUsageStore();

    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          cartesiaInkWebSocketFactory: () => new FakeInkSocket(),
          cartesiaApiKey: "ct-key",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://internal",
          elizaAuthorization: "Bearer service",
          elizaModel: "gemma-4-31b",
          fetchImpl: makeSseFetch(["unused."]),
          usageStore,
          usageLimits: {
            organizationDailyMinutes: 600,
            userDailyMinutes: 120,
          },
          downlink,
          onTeardownRevoke: async (jti, expSeconds) => {
            revoked.push({ jti, expSeconds });
          },
        }),
    });

    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    const ink = FakeInkSocket.instances.at(-1)!;
    expect(client.controlTypes()).toContain("ready");

    client.clientSend(JSON.stringify({ t: "bye" }));
    await flush();

    expect(ink.closed).toBe(true);
    expect(client.closedWith).toEqual({ code: 1000, reason: "completed" });
    expect(client.controlFrames.find((f) => f.t === "error")).toBeUndefined();
    expect(revoked).toEqual([
      { jti: minted.jti, expSeconds: minted.expSeconds },
    ]);
    client.clientSend(pcmChunk(3200));
    await flush();
    expect(ink.sentChunks).toHaveLength(0);
  });

  test("provider transport error replaces Ink and the call keeps transcribing", async () => {
    const errored = new FakeClientSocket();
    await connectSession({ client: errored, fetchImpl: makeSseFetch(["ok."]) });
    const errorInk = FakeInkSocket.instances.at(-1)!;
    errorInk.emitTransportError();
    await flush();
    expect(errored.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "transport_error",
        retryable: true,
      }),
    );
    expect(errorInk.closed).toBe(true);
    expect(errored.closedWith).toBeNull();
    const replacement = FakeInkSocket.instances.at(-1)!;
    expect(replacement).not.toBe(errorInk);
    replacement.emitTurn("turn.start");
    replacement.emitTurn("turn.end", "after reconnect");
    await flush();
    await flush();
    expect(errored.controlFrames).toContainEqual(
      expect.objectContaining({ t: "stt_final", text: "after reconnect" }),
    );
  });

  test("provider protocol error clears the active STT turn", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    const ink = FakeInkSocket.instances.at(-1)!;

    ink.emitTurn("turn.start");
    ink.emitMalformedMessage();
    ink.emitTurn("turn.start");
    ink.emitTurn("turn.end", "fresh turn");
    await flush();
    await flush();

    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "malformed_event",
        retryable: false,
      }),
    );
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "stt_final", text: "fresh turn" }),
    );
  });

  test("unexpected Ink close buffers audio until the replacement is connected", async () => {
    const closed = new FakeClientSocket();
    let socketCount = 0;
    let replacement: FakeInkSocket | null = null;
    await connectSession({
      client: closed,
      fetchImpl: makeSseFetch(["ok."]),
      inkSocketFactory: () => {
        socketCount += 1;
        if (socketCount === 1) return new FakeInkSocket();
        replacement = new FakeInkSocket({ autoOpen: false });
        return replacement;
      },
    });
    const closeInk = FakeInkSocket.instances.at(-1)!;
    closeInk.close(1006, "provider gone");
    await flush();
    expect(closed.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "stt_reconnecting",
        retryable: true,
      }),
    );
    expect(closed.closedWith).toBeNull();
    expect(replacement).not.toBeNull();

    closed.clientSend(pcmChunk(3200));
    await flush();
    expect(replacement!.sentChunks).toHaveLength(0);
    replacement!.emitOpen();
    await flush();
    expect(replacement!.sentChunks).toHaveLength(1);
  });

  test("replacement Ink that never opens keeps the call alive at capped backoff", async () => {
    const client = new FakeClientSocket();
    let first: FakeInkSocket | null = null;
    let stalled: FakeInkSocket | null = null;
    let attempts = 0;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["ok."]),
      sttReconnectDelaysMs: [0],
      sttConnectTimeoutMs: 10,
      inkSocketFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          first = new FakeInkSocket();
          return first;
        }
        stalled = new FakeInkSocket({ autoOpen: false });
        return stalled;
      },
    });

    first!.close(1006, "provider gone");
    await flush();

    expect(attempts).toBe(2);
    expect(stalled!.closed).toBe(true);
    expect(client.closedWith).toBeNull();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "stt_reconnecting",
        retryable: true,
      }),
    );
    client.clientSend(JSON.stringify({ t: "bye" }));
    await flush();
  });

  test("Ink downtime rolls the bounded audio queue without ending the call", async () => {
    const client = new FakeClientSocket();
    let first: FakeInkSocket | null = null;
    let replacement: FakeInkSocket | null = null;
    let attempts = 0;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["ok."]),
      sttReconnectDelaysMs: [0],
      sttConnectTimeoutMs: 1_000,
      sttPendingFrameLimit: 1,
      inkSocketFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          first = new FakeInkSocket();
          return first;
        }
        replacement = new FakeInkSocket({ autoOpen: false });
        return replacement;
      },
    });

    first!.close(1006, "provider gone");
    await flush();
    const oldAudio = new Uint8Array(3_200).fill(1);
    const newestAudio = new Uint8Array(3_200).fill(2);
    client.clientSend(oldAudio);
    await flush();
    client.clientSend(newestAudio);
    await flush();

    expect(client.closedWith).toBeNull();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "provider_unavailable",
        retryable: true,
      }),
    );
    replacement!.emitOpen();
    await flush();
    expect(replacement!.sentChunks).toHaveLength(1);
    expect(new Uint8Array(replacement!.sentChunks[0] as ArrayBuffer)[0]).toBe(
      2,
    );
    client.clientSend(JSON.stringify({ t: "bye" }));
    await flush();
  });

  test("a replacement that opens cancels its connection timeout", async () => {
    const client = new FakeClientSocket();
    let first: FakeInkSocket | null = null;
    let replacement: FakeInkSocket | null = null;
    let attempts = 0;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["ok."]),
      sttReconnectDelaysMs: [0],
      sttConnectTimeoutMs: 10,
      inkSocketFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          first = new FakeInkSocket();
          return first;
        }
        replacement = new FakeInkSocket({ autoOpen: false });
        queueMicrotask(() => replacement!.emitOpen());
        return replacement;
      },
    });

    first!.close(1006, "provider gone");
    await flush();

    expect(attempts).toBe(2);
    expect(replacement!.closed).toBe(false);
    expect(client.closedWith).toBeNull();
    replacement!.emitTurn("turn.start");
    replacement!.emitTurn("turn.end", "still listening");
    await flush();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({ t: "stt_final", text: "still listening" }),
    );
  });

  test("Ink reconnect exhaustion keeps the call alive at capped backoff", async () => {
    const client = new FakeClientSocket();
    let first: FakeInkSocket | null = null;
    let attempts = 0;
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["ok."]),
      sttReconnectDelaysMs: [0],
      inkSocketFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          first = new FakeInkSocket();
          return first;
        }
        throw new Error("Ink unavailable");
      },
    });
    first!.close(1006, "provider gone");
    await flush();

    expect(attempts).toBe(2);
    expect(client.closedWith).toBeNull();
    expect(client.controlFrames).toContainEqual(
      expect.objectContaining({
        t: "error",
        code: "stt_reconnecting",
        retryable: true,
      }),
    );
    client.clientSend(JSON.stringify({ t: "bye" }));
    await flush();
  });

  test("hello-first is enforced: a binary frame before hello closes the socket", async () => {
    const client = new FakeClientSocket();
    // Attach handler but do NOT send hello; send audio first.
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        throw new Error("must not build a session before hello");
      },
    });
    void usageStore;
    client.clientSend(pcmChunk(3200));
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "hello_required",
    );
  });

  test("audio pipelined right after hello (before verify) is buffered, not dropped", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    let ink: FakeInkSocket | null = null;
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          cartesiaInkWebSocketFactory: () => {
            ink = new FakeInkSocket();
            return ink;
          },
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });
    // Send hello and IMMEDIATELY a binary audio frame, before verify resolves.
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    client.clientSend(new Uint8Array(3200)); // pipelined pre-verify.
    // The session must NOT have been failed with hello_required.
    expect(client.closedWith).toBeNull();
    await flush();
    await flush();
    // Session came up (ready) and the buffered frame was admitted + forwarded.
    expect(client.controlTypes()).toContain("ready");
    expect(client.controlFrames.find((f) => f.t === "error")?.code).not.toBe(
      "hello_required",
    );
    expect(ink!.sentChunks.length).toBeGreaterThan(0);
  });

  test("a non-hello first control frame is rejected", async () => {
    const client = new FakeClientSocket();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        throw new Error("must not build a session before hello");
      },
    });
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "hello_required",
    );
  });

  test("malformed control JSON before hello is fatal", async () => {
    const client = new FakeClientSocket();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        throw new Error("must not build");
      },
    });
    client.clientSend("{ not json");
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "control_invalid_json",
    );
  });

  test("oversized audio frame is rejected without tearing down the session", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    // 128KiB > 64KiB ceiling.
    client.clientSend(pcmChunk(128 * 1024));
    await flush();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "audio_too_large",
    );
    // Session still alive (not closed).
    expect(client.closedWith).toBeNull();
  });

  test("single-use: a second connection with the same token is rejected", async () => {
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    const claimed = new Set<string>();
    const buildDeps = (_client: FakeClientSocket) => ({
      requestedSessionId: CLAIMS.sessionId,
      // Atomic single-use claim backed by a shared in-memory set (models Redis NX).
      claimToken: async (jti: string) => {
        if (claimed.has(jti)) return false;
        claimed.add(jti);
        return true;
      },
      buildSession: ({
        claims,
        jti,
        tokenExpSeconds,
        downlink,
      }: {
        claims: typeof CLAIMS;
        jti: string;
        tokenExpSeconds: number;
        downlink: import("../../../../../shared/src/lib/voice-session/ws-handler").VoiceSessionDownlink;
      }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          cartesiaInkWebSocketFactory: () => new FakeInkSocket(),
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });

    const helloFrame = JSON.stringify({
      t: "hello",
      token: minted.token,
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    });

    const clientA = new FakeClientSocket();
    attachVoiceWsHandler(clientA, buildDeps(clientA));
    clientA.clientSend(helloFrame);
    await flush();
    expect(clientA.controlTypes()).toContain("ready");

    const clientB = new FakeClientSocket();
    attachVoiceWsHandler(clientB, buildDeps(clientB));
    clientB.clientSend(helloFrame);
    await flush();
    // Second connection with the SAME token is rejected before ready.
    expect(clientB.controlTypes()).not.toContain("ready");
    expect(clientB.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "token_already_claimed",
    );
    expect(clientB.closedWith).not.toBeNull();
  });

  test("session construction failure surfaces a clean error + close (not a hang)", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        // e.g. an invalid Cartesia voiceId rejected by the adapter.
        throw new Error("CONFIG_VOICE_ID_INVALID");
      },
    });
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "session_start_failed",
    );
    expect(client.closedWith).not.toBeNull();
  });

  test("capacity gate rejects a verified hello when at the per-worker ceiling", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      admitSession: () => false, // simulate registry already at capacity.
      buildSession: () => {
        throw new Error("must not build a session when at capacity");
      },
    });
    void usageStore;
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "at_capacity",
    );
  });

  test("bad token in hello is rejected (claim mismatch / invalid)", async () => {
    const client = new FakeClientSocket();
    const other = await mintVoiceSessionToken({
      ...CLAIMS,
      sessionId: "some-other-session",
    });
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId, // mismatch vs the token's sessionId.
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          cartesiaInkWebSocketFactory: () => new FakeInkSocket(),
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: other.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "claim_mismatch",
    );
  });

  test("store-down hello surfaces a retryable store_unavailable error, close 1013 (#16663)", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      verifyToken: async () => {
        throw new VoiceSessionTokenError(
          "voice-session revocation store unavailable: redis down",
          "store_unavailable",
        );
      },
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          cartesiaInkWebSocketFactory: () => new FakeInkSocket(),
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    // Infra outage ≠ bad token: the client must see a retryable error and the
    // 1013 (try again later) close code, not the terminal 1008 shape.
    const err = client.controlFrames.find((f) => f.t === "error");
    expect(err).toMatchObject({ code: "store_unavailable", retryable: true });
    expect(client.closedWith?.code).toBe(1013);
  });
});
