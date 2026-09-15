/**
 * ElizaClient class — core infrastructure only.
 *
 * Separated from client.ts so domain augmentation files can import the class
 * without circular dependency issues.
 */

import { isInferenceTraceId } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import {
  extractAssistantReplyText,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
  stripAssistantStageDirections,
} from "@elizaos/shared";
import { parseChatTerminalFailure } from "@elizaos/shared/contracts";
import {
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
} from "@elizaos/shared/elizacloud";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "../events";
import { hydrateAndroidLocalAgentTokenForUrl } from "../first-run/local-agent-token";
import { isMobileLocalAgentIpcUrl } from "../first-run/mobile-runtime-mode";
import { isAndroidLocalSideloadBuild } from "../platform/android-runtime";
import {
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
  upsertAndActivateAgentProfile,
} from "../state/agent-profiles";
import {
  clearPersistedActiveServer,
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import {
  getBuildConfiguredRemoteApiBaseUrl,
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "../state/runtime-url-trust";
import { shellLocalStorage } from "../surface-realm-channel";
import {
  directCloudSharedAgentIdFromBase,
  isPersonalSharedElizaId,
} from "../utils/cloud-agent-base";
import {
  clearElizaApiBase,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
} from "../utils/eliza-globals";
import {
  DELTA_STREAM_PROTOCOL,
  mergeStreamingText,
} from "../utils/streaming-text";
import { androidNativeAgentTransportForUrl } from "./android-native-agent-transport";
import { readCsrfTokenForUrl } from "./auth/csrf-cookie";
import { CSRF_HEADER_NAME } from "./auth/sessions";
import type {
  AccountConnectRequest,
  ChatActionResultSummary,
  ChatFailureKind,
  ChatTerminalFailure,
  ChatTokenUsage,
  ChatToolCallEvent,
  ChatTurnStatus,
  ConnectionStateInfo,
  ConversationChannelType,
  ImageAttachment,
  LocalInferenceChatMetadata,
  WebSocketConnectionState,
  WsEventHandler,
} from "./client-types";
import { ApiError, isCloudAgentGoneError } from "./client-types";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { desktopLocalAgentTransportForUrl } from "./desktop-local-agent-transport";
import {
  iosInProcessAgentTransportForUrl,
  isIosInProcessLocalAgentBase,
} from "./ios-local-agent-transport";
import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { remoteRelayTransportForUrl } from "./remote-relay-transport";
import { defaultFetchTimeoutMs } from "./request-timeout";
import { sshRuntimeTransportForUrl } from "./ssh-runtime-transport";
import { type AgentRequestTransport, fetchAgentTransport } from "./transport";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERIC_NO_RESPONSE_TEXT =
  "Sorry, I couldn't generate a response right now. Please try again.";
const LOCAL_STORAGE_API_BASE_KEY = "elizaos_api_base";
const DEDICATED_CLOUD_CORS_BLOCKED_HEADERS = new Set([
  "x-elizaos-client-id",
  "x-elizaos-ui-language",
  // The baseline headers are meaningful only on the shared Worker routes and
  // are not in the dedicated container server's CORS contract.
  "x-elizaos-turn-correlation",
  "x-elizaos-turn-attempt",
  "x-eliza-telemetry",
]);
const REPLAYABLE_WS_EVENT_TYPES: ReadonlySet<string> = new Set([
  SHELL_NAVIGATE_VIEW_WS_EVENT,
]);
const WS_EVENT_BACKLOG_LIMIT = 8;
const CSRF_REQUIRED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type StreamChatEvent = {
  type?: string;
  text?: string;
  fullText?: string;
  /**
   * `type: "token"` only — the carried text is an in-flight action-callback
   * delivery the turn's final reply may replace wholesale. Text bubbles render
   * it exactly like any streamed text; voice output must NOT synthesize it
   * until the terminal frame confirms it (speech cannot be retracted — the
   * voice "double-speak" defect).
   */
  provisional?: boolean;
  transcriptVisibility?: "internal";
  agentName?: string;
  messageId?: string;
  userMessageId?: string;
  assistantEphemeral?: boolean;
  historyRefreshRequired?: boolean;
  interrupted?: boolean;
  message?: string;
  thought?: string;
  noResponseReason?: string;
  failureKind?: ChatFailureKind;
  terminalFailure?: ChatTerminalFailure;
  replyRecoveryAvailable?: boolean;
  accountConnect?: AccountConnectRequest;
  localInference?: LocalInferenceChatMetadata;
  actionResults?: ChatActionResultSummary[];
  // `type: "status"` carries the in-flight phase flat on the event (the server
  // spreads ChatTurnStatus into the SSE payload), so `kind` + the optional
  // action/tool name live alongside the discriminator. `type: "tool"` likewise
  // spreads ChatToolCallEvent flat, so `phase` / `callId` / args / result / error
  // share the event shape.
  kind?: ChatTurnStatus["kind"];
  label?: string;
  actionName?: string;
  toolName?: string;
  phase?: ChatToolCallEvent["phase"];
  callId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
  };
};

/**
 * A terminal SSE `error` event carries a structured reason — a `failureKind`
 * gate (e.g. `no_provider`) or a "connect another account" request — that a
 * generic `Error` would drop, leaving the caller unable to render the gate/CTA
 * and falling back to a plain error notice (#10231). Throw this instead so the
 * chat-send catch can surface the same gate UI the completed-response path does.
 */
export class StreamGenerationError extends Error {
  readonly failureKind?: ChatFailureKind;
  readonly accountConnect?: AccountConnectRequest;
  constructor(options: {
    message: string;
    failureKind?: ChatFailureKind;
    accountConnect?: AccountConnectRequest;
  }) {
    super(options.message);
    this.name = "StreamGenerationError";
    this.failureKind = options.failureKind;
    this.accountConnect = options.accountConnect;
  }
}

export function isStreamGenerationError(
  value: unknown,
): value is StreamGenerationError {
  return value instanceof StreamGenerationError;
}

const CHAT_TURN_STATUS_KINDS: ReadonlySet<ChatTurnStatus["kind"]> = new Set<
  ChatTurnStatus["kind"]
>([
  "thinking",
  "streaming",
  "running_action",
  "running_tool",
  "evaluating",
  "waking",
  "speaking",
]);

/** Build a typed ChatTurnStatus from a `type: "status"` SSE event, or null when
 *  the `kind` is missing/unknown (defensive: a future server kind is ignored,
 *  not crashed on). */
function parseChatTurnStatus(parsed: StreamChatEvent): ChatTurnStatus | null {
  if (!parsed.kind || !CHAT_TURN_STATUS_KINDS.has(parsed.kind)) return null;
  return {
    kind: parsed.kind,
    ...(typeof parsed.label === "string" && parsed.label
      ? { label: parsed.label }
      : {}),
    ...(typeof parsed.actionName === "string" && parsed.actionName
      ? { actionName: parsed.actionName }
      : {}),
    ...(typeof parsed.toolName === "string" && parsed.toolName
      ? { toolName: parsed.toolName }
      : {}),
  };
}

const CHAT_TOOL_PHASES: ReadonlySet<ChatToolCallEvent["phase"]> = new Set<
  ChatToolCallEvent["phase"]
>(["call", "result", "error"]);

/** Build a typed ChatToolCallEvent from a `type: "tool"` SSE event, or null when
 *  the phase/callId/toolName are missing/unknown (a future server phase is
 *  ignored, not crashed on). */
function parseChatToolCallEvent(
  parsed: StreamChatEvent,
): ChatToolCallEvent | null {
  if (!parsed.phase || !CHAT_TOOL_PHASES.has(parsed.phase)) return null;
  if (typeof parsed.callId !== "string" || !parsed.callId) return null;
  if (typeof parsed.toolName !== "string" || !parsed.toolName) return null;
  return {
    phase: parsed.phase,
    callId: parsed.callId,
    toolName: parsed.toolName,
    ...(parsed.args && typeof parsed.args === "object"
      ? { args: parsed.args }
      : {}),
    ...(parsed.result !== undefined ? { result: parsed.result } : {}),
    ...(typeof parsed.error === "string" && parsed.error
      ? { error: parsed.error }
      : {}),
  };
}

type StreamChatState = {
  /** True when this request advertised delta-v2, so a token frame WITHOUT
   *  `fullText` is a pure delta to plain-append — never routed through
   *  `mergeStreamingText`, whose overlap heuristic would drop a legitimately
   *  repeated multi-char delta (e.g. a second "the " after a buffer ending in
   *  "the "). */
  deltaProtocol: boolean;
  fullText: string;
  doneText: string | null;
  doneTranscriptVisibility: "internal" | undefined;
  doneAgentName: string | null;
  doneMessageId: string | null;
  doneUserMessageId: string | null;
  doneAssistantEphemeral: boolean;
  doneHistoryRefreshRequired: boolean;
  doneInterrupted: boolean;
  doneThought: string | null;
  doneNoResponseReason: "ignored" | null;
  doneUsage: ChatTokenUsage | undefined;
  doneFailureKind: ChatFailureKind | undefined;
  doneTerminalFailure: ChatTerminalFailure | undefined;
  doneReplyRecoveryAvailable: boolean;
  doneAccountConnect: AccountConnectRequest | undefined;
  doneLocalInference: LocalInferenceChatMetadata | undefined;
  doneActionResults: ChatActionResultSummary[] | undefined;
  replyReadyActionsDelivered: boolean;
  receivedDone: boolean;
};

function normalizeBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.slice(0, 4096).trim() ?? "";
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
  return trimmed.slice(0, end);
}

function isElizaCloudControlPlaneBase(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    return isElizaCloudControlPlaneHostname(
      new URL(normalized).hostname.toLowerCase(),
    );
  } catch {
    // error-policy:J3 malformed base URL reads as "not the control plane".
    return false;
  }
}

function requestHeadersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

function findSseEventBreak(
  chunkBuffer: string,
): { index: number; length: number } | null {
  const lfBreak = chunkBuffer.indexOf("\n\n");
  const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");

  if (lfBreak === -1 && crlfBreak === -1) return null;
  if (lfBreak === -1) return { index: crlfBreak, length: 4 };
  if (crlfBreak === -1) return { index: lfBreak, length: 2 };
  return lfBreak < crlfBreak
    ? { index: lfBreak, length: 2 }
    : { index: crlfBreak, length: 4 };
}

// Producers that predate the canonical JSON `type` (shared-runtime, sandbox,
// bridge, and control-plane fallback chat) classify frames only through their
// SSE event name. Map those names when `type` is absent so a terminal `done`
// or `error` frame is never misread as another token (#17122). An explicit
// JSON `type` always wins over the event name.
const LEGACY_SSE_EVENT_TYPES: Record<string, string> = {
  chunk: "token",
  done: "done",
  error: "error",
};

// Per the SSE spec the `event:` field names the whole event block regardless
// of field order, and a later `event:` line overwrites an earlier one.
function sseEventName(lines: readonly string[]): string | undefined {
  let name: string | undefined;
  for (const line of lines) {
    if (line.startsWith("event:")) name = line.slice(6).trim() || undefined;
  }
  return name;
}

function parseStreamChatDataLine(
  line: string,
  eventName?: string,
): StreamChatEvent | null {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as StreamChatEvent;
    if (!parsed.type && eventName && LEGACY_SSE_EVENT_TYPES[eventName]) {
      parsed.type = LEGACY_SSE_EVENT_TYPES[eventName];
      if (
        parsed.type === "done" &&
        typeof parsed.fullText !== "string" &&
        typeof parsed.text === "string"
      ) {
        // Legacy named done frames carried the authoritative reply in `text`.
        parsed.fullText = parsed.text;
      }
    }
    if (!parsed.type && typeof parsed.text === "string") parsed.type = "token";
    return parsed;
  } catch {
    // error-policy:J3 an unparseable SSE data line is explicitly invalid and
    // skipped; the terminal done/error events drive the turn outcome.
    return null;
  }
}

function applyStreamChatTokenEvent(
  parsed: StreamChatEvent,
  state: StreamChatState,
  onToken: (
    token: string,
    accumulatedText?: string,
    provisional?: boolean,
  ) => void,
): boolean {
  const chunk = typeof parsed.text === "string" ? parsed.text : null;
  const fullText = typeof parsed.fullText === "string" ? parsed.fullText : null;
  if (chunk === null && fullText === null) {
    // error-policy:J3 malformed SSE token frames are ignored at the transport
    // boundary; they must not become a valid-looking empty text update.
    return false;
  }
  const safeChunk = chunk ?? "";
  const nextFullText =
    fullText !== null
      ? // An explicit snapshot is always authoritative (delta-v2 periodic
        // snapshot AND legacy per-token fullText both land here).
        fullText
      : safeChunk
        ? // No fullText: a bare delta. Under negotiated delta-v2 the server
          // guarantees pure appends, so bypass mergeStreamingText (its overlap
          // dedupe drops legitimately repeated multi-char deltas). Foreign /
          // un-negotiated streams still ride the merge heuristic.
          state.deltaProtocol
          ? state.fullText + safeChunk
          : mergeStreamingText(state.fullText, safeChunk)
        : state.fullText;
  if (nextFullText === state.fullText) return false;
  state.fullText = nextFullText;
  onToken(safeChunk, state.fullText, parsed.provisional === true);
  return false;
}

function parseStreamActionResults(
  value: unknown,
): ChatActionResultSummary[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (result) =>
        result !== null &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        typeof result.success === "boolean" &&
        ["actionName", "text", "error"].every(
          (key) => result[key] === undefined || typeof result[key] === "string",
        ) &&
        (result.values === undefined ||
          (result.values !== null &&
            typeof result.values === "object" &&
            !Array.isArray(result.values))),
    )
  ) {
    // error-policy:J3 malformed receipts are not authority to perform a client
    // handoff. Reject the whole collection rather than applying a partial one.
    return undefined;
  }
  return value;
}

function applyStreamChatDoneEvent(
  parsed: StreamChatEvent,
  state: StreamChatState,
): boolean {
  state.receivedDone = true;
  if (typeof parsed.fullText === "string") state.doneText = parsed.fullText;
  if (parsed.transcriptVisibility === "internal") {
    state.doneTranscriptVisibility = parsed.transcriptVisibility;
  }
  if (typeof parsed.agentName === "string" && parsed.agentName.trim()) {
    state.doneAgentName = parsed.agentName;
  }
  if (typeof parsed.messageId === "string" && parsed.messageId.trim()) {
    state.doneMessageId = parsed.messageId;
  }
  if (typeof parsed.userMessageId === "string" && parsed.userMessageId.trim()) {
    state.doneUserMessageId = parsed.userMessageId;
  }
  if (parsed.assistantEphemeral === true) {
    state.doneAssistantEphemeral = true;
  }
  if (parsed.historyRefreshRequired === true) {
    state.doneHistoryRefreshRequired = true;
  }
  if (parsed.interrupted === true) {
    state.doneInterrupted = true;
  }
  if (typeof parsed.thought === "string" && parsed.thought.trim()) {
    state.doneThought = parsed.thought;
  }
  if (parsed.noResponseReason === "ignored") {
    state.doneNoResponseReason = "ignored";
  }
  if (typeof parsed.failureKind === "string") {
    state.doneFailureKind = parsed.failureKind;
  }
  state.doneTerminalFailure = parseChatTerminalFailure(parsed.terminalFailure);
  state.doneReplyRecoveryAvailable = parsed.replyRecoveryAvailable === true;
  if (parsed.accountConnect && typeof parsed.accountConnect === "object") {
    state.doneAccountConnect = parsed.accountConnect;
  }
  if (parsed.localInference && typeof parsed.localInference === "object") {
    state.doneLocalInference = parsed.localInference;
  }
  state.doneActionResults = parseStreamActionResults(parsed.actionResults);
  if (parsed.usage) {
    state.doneUsage = {
      promptTokens: parsed.usage.promptTokens ?? 0,
      completionTokens: parsed.usage.completionTokens ?? 0,
      totalTokens: parsed.usage.totalTokens ?? 0,
      model: parsed.usage.model,
    };
  }
  return true;
}

function applyStreamChatDataLine(
  line: string,
  state: StreamChatState,
  onToken: (
    token: string,
    accumulatedText?: string,
    provisional?: boolean,
  ) => void,
  onStatus?: (status: ChatTurnStatus) => void,
  onToolEvent?: (event: ChatToolCallEvent) => void,
  eventName?: string,
  onReplyReady?: (actionResults: ChatActionResultSummary[]) => void,
): boolean {
  const parsed = parseStreamChatDataLine(line, eventName);
  if (!parsed) return false;
  if (parsed.type === "token") {
    return applyStreamChatTokenEvent(parsed, state, onToken);
  }
  if (parsed.type === "reply_ready") {
    // The agent has settled the authoritative user-visible reply, but may
    // still be persisting receipts and message metadata before `done`. Render
    // this snapshot immediately and keep the stream open for that terminal
    // bookkeeping. Treat it exactly like a non-provisional text snapshot so
    // it replaces any provisional action callback instead of appending or
    // speaking both versions.
    applyStreamChatTokenEvent(
      { ...parsed, provisional: false },
      state,
      onToken,
    );
    const actionResults = parseStreamActionResults(parsed.actionResults);
    if (actionResults?.length && !state.replyReadyActionsDelivered) {
      state.replyReadyActionsDelivered = true;
      onReplyReady?.(actionResults);
    }
    return false;
  }
  if (parsed.type === "status") {
    // Additive: a non-terminal status event. Surface it (when a consumer wants
    // it) and keep reading — it never ends the stream.
    if (onStatus) {
      const status = parseChatTurnStatus(parsed);
      if (status) onStatus(status);
    }
    return false;
  }
  if (parsed.type === "tool") {
    // Additive: an inline tool-call step (call → result/error). Non-terminal.
    if (onToolEvent) {
      const event = parseChatToolCallEvent(parsed);
      if (event) onToolEvent(event);
    }
    return false;
  }
  if (parsed.type === "done") {
    return applyStreamChatDoneEvent(parsed, state);
  }
  if (parsed.type === "error") {
    // Preserve the structured gate (failureKind / accountConnect) so the
    // chat-send catch can surface the actionable UI instead of a plain notice.
    throw new StreamGenerationError({
      message: parsed.message ?? "generation failed",
      failureKind: parsed.failureKind,
      accountConnect: parsed.accountConnect,
    });
  }
  return false;
}

function isLocalAgentIpcBase(value: string | null | undefined): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  return isMobileLocalAgentIpcUrl(normalized);
}

function isSharedRuntimeRestAdapterBase(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    // Shared-runtime agents are served by the Cloud Worker over REST/SSE, not
    // by a stateful agent server with `/ws`. Treat both the current adapter
    // base and the legacy bridge base as connected so the shell does not show
    // the lost-connection overlay while REST chat remains usable.
    return /^\/api\/v1\/eliza\/agents\/[^/]+(?:\/bridge)?$/.test(url.pathname);
  } catch {
    // error-policy:J3 malformed base URL reads as "not a shared-runtime base".
    return false;
  }
}

function isRemoteRelayApiUrl(value: string | null | undefined): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return (
      url.protocol === "eliza-remote:" &&
      url.host === "session" &&
      !url.username &&
      !url.password &&
      /^\/[A-Za-z0-9._-]{1,256}(?:\/|$)/.test(url.pathname) &&
      !url.hash
    );
  } catch {
    // error-policy:J3 malformed pseudo-URLs are not relay API URLs.
    return false;
  }
}

export function isRemoteRelayRestAdapterBase(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized || !isRemoteRelayApiUrl(normalized)) return false;
  try {
    const url = new URL(normalized);
    return (
      /^\/[A-Za-z0-9._-]{1,256}$/.test(url.pathname) && !url.search && !url.hash
    );
  } catch {
    // error-policy:J3 malformed pseudo-URLs are not REST-only runtimes.
    return false;
  }
}

function shouldTreatAsConnectedWithoutWebSocket(
  value: string | null | undefined,
): boolean {
  return (
    isIosInProcessLocalAgentBase(value) ||
    isLocalAgentIpcBase(value) ||
    isSharedRuntimeRestAdapterBase(value) ||
    isRemoteRelayRestAdapterBase(value) ||
    isDedicatedCloudAgentBase(value) ||
    // Control-plane hosts structurally cannot serve `/ws`: the alias Worker
    // routes only `/api*`/`/steward*` to the API and strips
    // `Connection`/`Upgrade` before proxying, so the SPA answers the upgrade
    // with 200 + index.html. Since #17801 removed the synthetic-host WS skip,
    // browsers on these hosts dialed it anyway, burned all reconnect attempts,
    // and raised the fatal "Lost backend connection." overlay over a fully
    // working REST/SSE backend (#18172). Connected-over-REST, no WS attempt.
    isElizaCloudControlPlaneBase(value)
  );
}

// A dedicated cloud agent lives on `<id>.cloud.eliza.app` and
// serves chat over REST. Its `/ws` upgrade is NOT currently proxied by the
// agent-router (the upgrade returns 404), so attempting the WebSocket only
// produced a "Reconnecting… (N/15)" header for ~95s before degrading. Treat
// these bases like the shared-runtime adapter — connected-over-REST with no WS
// attempt — so there is no reconnect churn. (The WS-reconnect-exhaustion degrade
// in connectWs.onclose is kept as a safety net; revisit once the agent-router
// proxies the `/ws` upgrade and the agent advertises it via /api/config so we
// can re-enable realtime.)
function isDedicatedCloudAgentBase(value: string | null | undefined): boolean {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return isElizaDedicatedAgentHostname(host);
  } catch {
    // error-policy:J3 malformed base URL reads as "not a dedicated agent".
    return false;
  }
}

function getInjectedWsBase(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const values = [
    (window as { __ELIZA_WS_BASE__?: unknown }).__ELIZA_WS_BASE__,
    (window as { __ELIZAOS_WS_BASE__?: unknown }).__ELIZAOS_WS_BASE__,
  ];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function shouldUseRestOnlyForInsecureWebSocket(
  wsProtocol: "ws:" | "wss:",
  host: string,
): boolean {
  if (wsProtocol !== "ws:") return false;
  if (typeof window === "undefined") return false;
  const rendererProtocol = window.location?.protocol;
  if (rendererProtocol !== "https:" && rendererProtocol !== "capacitor:") {
    return false;
  }

  // Direct Android builds enable mixed content so their packaged
  // https://localhost renderer can keep the paired runtime's backchannel
  // alive. The same trust gate that protects persisted API bases restricts
  // this exception to loopback/private-LAN hosts; store and public cleartext
  // endpoints retain the browser's stricter boundary.
  const isTrustedPairedHost = isTrustedRestoreApiBaseUrl(`http://${host}`);
  if (isTrustedPairedHost && isAndroidLocalSideloadBuild()) return false;

  return true;
}

/**
 * True only inside a Capacitor NATIVE app (iOS/Android WebView), where the
 * page origin is a synthetic bundle host with no server behind it. A plain
 * browser (including one loading a Capacitor-built web bundle over HTTP) has
 * no `Capacitor.isNativePlatform()` → false, so same-origin deployments keep
 * their realtime WebSocket.
 */
function isCapacitorNativeRuntime(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    // error-policy:J4 an unanswerable platform probe reads as "not native",
    // preserving the browser's WebSocket path.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Network status — listens for the bridged Capacitor `networkStatusChange`
// event so the WS reconnect scheduler can park itself during airplane mode
// instead of burning all 5 backoff attempts.
// ---------------------------------------------------------------------------

let lastKnownNetworkConnected = true;
const networkStatusListeners = new Set<(connected: boolean) => void>();

function isNetworkStatusChangeEvent(
  ev: Event,
): ev is CustomEvent<NetworkStatusChangeDetail> {
  if (!("detail" in ev)) return false;
  const detail = (ev as CustomEvent<unknown>).detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as { connected?: unknown }).connected === "boolean"
  );
}

if (typeof document !== "undefined") {
  document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, (ev: Event) => {
    if (!isNetworkStatusChangeEvent(ev)) return;
    const next = ev.detail.connected;
    if (next === lastKnownNetworkConnected) return;
    lastKnownNetworkConnected = next;
    for (const listener of networkStatusListeners) {
      try {
        listener(next);
      } catch {
        // ignore listener errors — they don't get to break network state
      }
    }
  });
}

/**
 * Subscribe to bridged network-status transitions (Capacitor
 * `networkStatusChange`, re-dispatched as {@link NETWORK_STATUS_CHANGE_EVENT}).
 * The listener fires with `true` when connectivity returns and `false` when it
 * drops. Returns an unsubscribe fn. Module-level (not per-client) because the
 * bridge is a single document-level event — every consumer shares the same
 * transition source, so a chat-send auto-retry and the WS reconnect scheduler
 * both react to the same online edge without racing separate listeners.
 */
export function onNetworkStatusChange(
  listener: (connected: boolean) => void,
): () => void {
  networkStatusListeners.add(listener);
  return () => {
    networkStatusListeners.delete(listener);
  };
}

/**
 * Mint a stable idempotency key for one logical chat send. The send path calls
 * this ONCE per turn and reuses the value across an auto-retry so a request that
 * landed server-side during a network blip is de-duped rather than duplicated.
 * Thin free-function wrapper over {@link ElizaClient.generateMessageId} so
 * consumers don't need the class from the barrel.
 */
export function generateChatClientMessageId(): string {
  return ElizaClient.generateMessageId();
}

/** Test-only: reset the cached network state. */
export function __resetNetworkStatusForTests(): void {
  lastKnownNetworkConnected = true;
  networkStatusListeners.clear();
}

/** Test-only: read the last bridged network status. */
export function __getLastKnownNetworkConnected(): boolean {
  return lastKnownNetworkConnected;
}

/**
 * The last bridged connectivity state (`true` = the device reports a usable
 * network). Public counterpart to the test-only reader so the send path can
 * tell "we're offline" (worth waiting for reconnect to auto-retry) from "we're
 * online but the server 503'd / was slow" (surface the manual affordance now).
 */
export function isNetworkCurrentlyConnected(): boolean {
  return lastKnownNetworkConnected;
}

// ---------------------------------------------------------------------------
// Dedicated-agent resume (HTTP 202) handling
// ---------------------------------------------------------------------------

// A non-running dedicated cloud agent answers with `202 Accepted` + `Retry-After`
// while it auto-resumes (the unified-auth Worker, #8628). The client honours that
// contract: it waits the advertised delay and re-issues the request a bounded
// number of times, so callers see the eventual real response instead of a 202
// placeholder body — which otherwise surfaced as an empty reply on the first
// message sent after a dedicated agent had idled.
const RESUME_MAX_RETRIES = 6;
const RESUME_DEFAULT_DELAY_MS = 5_000;
const RESUME_MIN_DELAY_MS = 500;
const RESUME_MAX_DELAY_MS = 10_000;

/** Clamp the agent's advertised `Retry-After` (seconds) into a sane wait (ms). */
function resumeRetryDelayMs(res: Response): number {
  const header = res.headers.get("Retry-After");
  const seconds =
    header !== null && Number.isFinite(Number(header))
      ? Number(header)
      : Number.NaN;
  const ms = Number.isFinite(seconds)
    ? seconds * 1_000
    : RESUME_DEFAULT_DELAY_MS;
  return Math.min(RESUME_MAX_DELAY_MS, Math.max(RESUME_MIN_DELAY_MS, ms));
}

// ---------------------------------------------------------------------------
// Shared-agent cache-warming (HTTP 503) absorption
// ---------------------------------------------------------------------------

// The first turn against a fresh shared agent can hit two pre-admission
// warming barriers, each a `503` with a stable machine code and
// `Retry-After: 1` (#18045). Both reject BEFORE the request is admitted, so
// re-issuing the identical request — same body, same `clientMessageId` — is
// idempotent by server contract. Absorb them here at the request choke point,
// bounded, so every surface keeps the send pending instead of surfacing an
// expected warm-up as a user-visible failure. Only these named codes retry; a
// generic 503 (or any 402) stays a real failure.
const CACHE_WARMING_RETRYABLE_CODES = new Set([
  "agent_cache_warming",
  "shared_runtime_cache_warming",
]);
const WARMING_MAX_RETRIES = 4;
const WARMING_DEFAULT_DELAY_MS = 1_000;
const WARMING_MIN_DELAY_MS = 250;
const WARMING_MAX_DELAY_MS = 5_000;
// Total elapsed absorption budget across ALL warming waits for one logical
// request. The first-turn UX contract (#18045) is a short ~5s warm-up, not
// WARMING_MAX_RETRIES × WARMING_MAX_DELAY_MS: an oversized `Retry-After` gets
// its wait clamped to whatever budget remains, and once the deadline passes
// the structured warming error surfaces instead of another retry.
const WARMING_TOTAL_BUDGET_MS = 5_000;
const SHARED_TURN_CORRELATION_HEADER = "X-ElizaOS-Turn-Correlation";
const SHARED_TURN_ATTEMPT_HEADER = "X-ElizaOS-Turn-Attempt";

function generateSharedTurnCorrelation(): string | null {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().toLowerCase();
  }
  if (typeof globalThis.crypto?.getRandomValues !== "function") return null;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/** Mint the closed-schema id adopted by the dedicated agent inference timer. */
function generateDedicatedTraceId(): string | null {
  if (typeof globalThis.crypto?.getRandomValues !== "function") return null;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Clamp the warming barrier's advertised `Retry-After` (seconds) into ms. */
function warmingRetryDelayMs(retryAfterSeconds: number | undefined): number {
  const ms =
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1_000
      : WARMING_DEFAULT_DELAY_MS;
  return Math.min(WARMING_MAX_DELAY_MS, Math.max(WARMING_MIN_DELAY_MS, ms));
}

/** Resolve after `ms`, or early if `signal` aborts. Never rejects. */
function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ElizaClient {
  private _baseUrl: string;
  private _userSetBase: boolean;
  private _token: string | null;
  /** Last cloud agent base released after an agent-gone 404 (idempotency). */
  private _releasedGoneAgentBase: string | null = null;
  private personalElizaRuntimeRepoint: Promise<boolean> | null = null;
  /** Renderer routing identity, shared by HTTP, WebSocket, and voice turns. */
  readonly clientId: string;
  private requestTransport: AgentRequestTransport = fetchAgentTransport;
  private ws: WebSocket | null = null;
  private wsHandlers = new Map<string, Set<WsEventHandler>>();
  private wsEventBacklog = new Map<string, Record<string, unknown>[]>();
  private wsSendQueue: string[] = [];
  private readonly wsSendQueueLimit = 32;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 500;
  private wsHasConnectedOnce = false;
  private networkStatusUnsubscribe: (() => void) | null = null;

  // Connection state tracking for backend crash handling
  private connectionState: WebSocketConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private disconnectedAt: number | null = null;
  private connectionStateListeners = new Set<
    (state: ConnectionStateInfo) => void
  >();
  private readonly maxReconnectAttempts = 15;
  // Fired exactly once per successful reconnect (never on the first connect)
  // so consumers can reconcile state that drifted during the network gap.
  private resyncListeners = new Set<() => void>();
  // Fired synchronously on every setBaseUrl/repointBaseUrl, including the
  // socket-less Cloud repoint path where ws-reconnected never fires — the
  // only observable signal for "the active agent/server target changed".
  private baseUrlChangeListeners = new Set<(baseUrl: string) => void>();
  // Monotonic, non-secret revision for the complete request authority. A
  // bearer rotation can change accounts without changing the selected profile
  // or API host, so resource caches must not key authority on the base URL
  // alone. The token itself must never enter a React key or diagnostic value.
  private authorityRevision = 0;
  private authorityChangeListeners = new Set<() => void>();

  // UI language propagation — set by AppContext so the backend can
  // localise responses when needed.
  private _uiLanguage: string | null = null;

  /** Store the current UI language so it can be sent as a header on every request. */
  setUiLanguage(lang: string): void {
    this._uiLanguage = lang || null;
  }

  /**
   * Stable id for a single logical client message. Used as an idempotency key
   * so a resend after reconnect is de-dupable server-side. Falls back to a
   * time+random token when crypto.randomUUID is unavailable. Public so the
   * send path can mint an id ONCE per logical turn and reuse it across an
   * auto-retry (the retry must carry the original id or the dedupe is moot).
   */
  static generateMessageId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private static generateClientId(): string {
    let random: string;
    if (typeof globalThis.crypto?.randomUUID === "function") {
      random = globalThis.crypto.randomUUID();
    } else if (typeof globalThis.crypto?.getRandomValues === "function") {
      const buf = new Uint8Array(16);
      globalThis.crypto.getRandomValues(buf);
      random = `${Date.now().toString(36)}${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    } else {
      random = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
    return `ui-${random.slice(0, 256).replace(/[^a-zA-Z0-9._-]/g, "")}`;
  }

  constructor(baseUrl?: string, token?: string) {
    this.clientId = ElizaClient.generateClientId();

    const bootBase = getBootConfig().apiBase;
    const injectedBase = getElizaApiBase();
    const localStorageGetItem =
      typeof window !== "undefined" &&
      typeof window.localStorage?.getItem === "function"
        ? window.localStorage.getItem.bind(window.localStorage)
        : null;
    const storedBaseRaw = localStorageGetItem
      ? localStorageGetItem(LOCAL_STORAGE_API_BASE_KEY)
      : null;
    const storedBase = isElizaCloudControlPlaneBase(storedBaseRaw)
      ? null
      : storedBaseRaw;

    // Priority: explicit arg > boot config > desktop injection > session storage > same origin.
    // `client.setBaseUrl()` updates the boot config, so it must beat the
    // shell-injected local default once the user has chosen a different
    // server. Injection still beats stale session state from prior sessions.
    const initialBase = normalizeBaseUrl(
      baseUrl ?? bootBase ?? injectedBase ?? storedBase ?? "",
    );
    this._userSetBase = this.pinnedRemoteApiBase !== null || baseUrl != null;
    this._baseUrl = this.pinnedRemoteApiBase ?? initialBase;
    const initialToken = token?.trim() || null;
    this._token =
      !initialToken ||
      !this.pinnedRemoteApiBase ||
      (initialBase === this.pinnedRemoteApiBase &&
        this.isPinnedRemoteCredential(initialToken))
        ? initialToken
        : null;
  }

  /**
   * Resolve the immutable build target lazily. Android can publish the
   * validated target after this module's singleton is constructed when the UI
   * package was pre-built before Vite injected the app environment.
   */
  private get pinnedRemoteApiBase(): string | null {
    return getBuildConfiguredRemoteApiBaseUrl();
  }

  /**
   * Resolve the API base URL lazily.
   * In the desktop shell the main process injects the API base after the
   * page loads (once the agent runtime starts). Re-checking the boot config
   * on every call ensures we pick up the injected value even if it wasn't
   * set at construction, or if the port changed dynamically (e.g. 2138→2139).
   */
  get baseUrl(): string {
    const pinnedRemoteApiBase = this.pinnedRemoteApiBase;
    if (pinnedRemoteApiBase) return pinnedRemoteApiBase;

    // Always re-read boot config — the main process may push a port update
    // via apiBaseUpdate RPC at any time (e.g. when the child runtime binds
    // to a different port than initially injected in the HTML).
    // Only skip if the user explicitly called setBaseUrl() themselves.
    if (!this._userSetBase) {
      const bootBase = getBootConfig().apiBase;
      const injectedBase = getElizaApiBase();
      const preferredBase = bootBase ?? injectedBase;
      if (preferredBase && preferredBase !== this._baseUrl) {
        this._baseUrl = preferredBase;
      }
    }
    return this._baseUrl;
  }

  get apiToken(): string | null {
    const pinnedRemoteApiBase = this.pinnedRemoteApiBase;
    if (pinnedRemoteApiBase) {
      const activeServer = loadPersistedActiveServer();
      if (
        activeServer?.kind === "remote" &&
        activeServer.apiBase?.replace(/\/+$/, "") === pinnedRemoteApiBase
      ) {
        return activeServer.accessToken?.trim() || null;
      }
      return null;
    }
    if (this._token) return this._token;
    const bootToken = getBootConfig().apiToken;
    if (typeof bootToken === "string" && bootToken.trim())
      return bootToken.trim();
    const injectedToken = getElizaApiToken();
    if (injectedToken) return injectedToken;
    return null;
  }

  hasToken(): boolean {
    return Boolean(this.apiToken);
  }

  /**
   * Bearer token sent on app REST requests (compat API). Used when the
   * Electrobun main process relays HTTP so it can match the renderer-injected
   * token in external-desktop / Vite-proxy setups.
   */
  getRestAuthToken(): string | null {
    return this.apiToken;
  }

  setRequestTransport(transport: AgentRequestTransport | null): void {
    this.requestTransport = transport ?? fetchAgentTransport;
    this.disconnectWs();
  }

  setToken(token: string | null): void {
    if (
      this.pinnedRemoteApiBase &&
      token?.trim() &&
      !this.isPinnedRemoteCredential(token)
    ) {
      logger.warn(
        "[ElizaClient] ignored a credential not bound to the build-pinned remote target",
      );
      return;
    }
    this.installToken(token, true);
  }

  /** A pinned build accepts a bearer only after durable exact-origin binding. */
  private isPinnedRemoteCredential(token: string): boolean {
    if (!this.pinnedRemoteApiBase) return true;
    const activeServer = loadPersistedActiveServer();
    return (
      activeServer?.kind === "remote" &&
      activeServer.apiBase?.replace(/\/+$/, "") === this.pinnedRemoteApiBase &&
      activeServer.accessToken?.trim() === token.trim()
    );
  }

  /** Non-secret epoch that advances when the effective request bearer changes. */
  getAuthorityRevision(): number {
    return this.authorityRevision;
  }

  /**
   * Subscribe to atomic API-authority changes. Unlike {@link onBaseUrlChange},
   * this also covers a same-host credential/account swap.
   */
  onAuthorityChange(listener: () => void): () => void {
    this.authorityChangeListeners.add(listener);
    return () => {
      this.authorityChangeListeners.delete(listener);
    };
  }

  private notifyAuthorityChange(): void {
    for (const listener of this.authorityChangeListeners) {
      try {
        listener();
      } catch (err) {
        logger.error(
          { err },
          "[ElizaClient] onAuthorityChange listener threw; other listeners still notified",
        );
      }
    }
  }

  /**
   * Update credential state without exposing an intermediate cross-target
   * event. Atomic base swaps use the silent form, reconnect synchronously, and
   * publish the established token-sync signal only after the new target owns
   * the credential.
   */
  private installToken(token: string | null, notify: boolean): void {
    const previousInstalledToken = this._token?.trim() || null;
    const previousEffectiveToken = this.apiToken;
    const nextToken = token?.trim() || null;
    this._token = nextToken;
    // Boot config is the canonical source. fetchWithCsrf and authBase read here.
    const config = getBootConfig();
    setBootConfig({ ...config, apiToken: this._token ?? undefined });
    const tokenChanged =
      previousEffectiveToken !== this.apiToken ||
      previousInstalledToken !== nextToken;
    if (tokenChanged) {
      this.authorityRevision += 1;
      if (notify) this.notifyAuthorityChange();
    }
    // A same-view sign-in/out (this is the only path that writes the token
    // without a page load) must refresh any mounted session gate — e.g. the
    // Apps tab — without a remount. `steward-token-sync` is the established
    // "re-read your token" signal that use-session-auth already listens for.
    // (#12046 Nit 2)
    if (notify && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    }
    if (tokenChanged && this.ws) this.rotateConnection();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(baseUrl: string | null, options?: { persist?: boolean }): void {
    const normalized = normalizeBaseUrl(baseUrl);
    if (this.pinnedRemoteApiBase && normalized !== this.pinnedRemoteApiBase) {
      logger.warn(
        "[ElizaClient] ignored a base change outside the build-pinned remote target",
      );
      return;
    }
    const persist = options?.persist !== false;
    this._userSetBase = normalized.length > 0;
    this._baseUrl = normalized;
    this.disconnectWs();
    if (persist) {
      this.persistBaseUrlFailClosed(normalized);
    }
    this.notifyBaseUrlChange();
    this.notifyAuthorityChange();
  }

  /** Subscribe to base-URL changes from {@link setBaseUrl} or {@link
   * repointBaseUrl}. Fires synchronously with the resulting base URL after
   * every change, including a Cloud repoint that never opens a socket and so
   * never fires `ws-reconnected` — the only base-change signal that does not
   * depend on the WebSocket transport. Returns an unsubscribe function. */
  onBaseUrlChange(listener: (baseUrl: string) => void): () => void {
    this.baseUrlChangeListeners.add(listener);
    return () => {
      this.baseUrlChangeListeners.delete(listener);
    };
  }

  /**
   * Isolate each listener so one throwing observer cannot swallow the base
   * change for the rest — critical in {@link repointBaseUrl}, where this
   * notification runs before `connectWs()` and the token-sync dispatch; an
   * unguarded throw there would silently break reconnection (#18542).
   */
  private notifyBaseUrlChange(): void {
    for (const listener of this.baseUrlChangeListeners) {
      try {
        listener(this._baseUrl);
      } catch (err) {
        logger.error(
          { err },
          "[ElizaClient] onBaseUrlChange listener threw; other listeners still notified",
        );
      }
    }
  }

  /**
   * Persist the base URL, but never let a storage failure (quota, disabled
   * localStorage, private-mode restrictions) suppress {@link
   * notifyBaseUrlChange}: `_baseUrl` is already mutated in memory and is the
   * authoritative value, so dependent per-authority observers must still
   * learn about the change even when persistence itself failed (#18542).
   */
  private persistBaseUrlFailClosed(normalized: string): void {
    try {
      this.persistBaseUrl(normalized);
    } catch (err) {
      // error-policy:J6 best-effort persistence — the in-memory base is
      // already authoritative for this process; a storage failure must not
      // block downstream notification of the change that already happened.
      logger.warn({ err }, "[ElizaClient] persistBaseUrl failed");
    }
  }

  /**
   * Persist a base URL to every consumer that reads it out-of-band (the
   * boot-config store, plus localStorage). Shared by {@link setBaseUrl} and
   * {@link repointBaseUrl} so both keep the same persistence semantics — the
   * only difference between them is the WS handling.
   */
  private persistBaseUrl(normalized: string): void {
    if (normalized) {
      setElizaApiBase(normalized);
    } else {
      clearElizaApiBase();
    }
    if (typeof window !== "undefined") {
      // `elizaos_api_base` is a shell-reserved key (the `elizaos_` prefix), so a
      // RAW localStorage write is denied by the surface-realm guard whenever a
      // view surface scope is foreground (#15247/#15307) — and this runs from the
      // startup restore phase while the chat view is already mounted. The API
      // client is shell infrastructure writing its own reserved key, so it routes
      // through the privileged `shellLocalStorage` channel, same as the other
      // shell writers. (sessionStorage is unguarded; the legacy cleanup stays raw.)
      if (normalized) {
        shellLocalStorage.setItem(LOCAL_STORAGE_API_BASE_KEY, normalized);
      } else {
        shellLocalStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
      }
      // Clean up legacy sessionStorage entry (same key was used historically)
      window.sessionStorage.removeItem(LOCAL_STORAGE_API_BASE_KEY);
    }
  }

  /**
   * Re-point the live client at a new base **in place**, keeping the realtime
   * channel visually continuous — the seamless shared→dedicated handoff swap.
   *
   * Unlike {@link setBaseUrl}, which `disconnectWs()`es and leaves the socket
   * dead until some later boot phase calls `connectWs()` (a visible drop + the
   * `disconnected` connection-state flap), this:
   *   1. tears down the old socket WITHOUT emitting a `disconnected` state, so
   *      connection-state listeners never see a gap (the chat surface stays
   *      "connected" throughout);
   *   2. flips the base + persistence to the new (dedicated) host;
   *   3. immediately `connectWs()`s to the new base.
   *
   * The transcript was already copied to the dedicated agent by the handoff
   * supervisor, so live updates resume against the dedicated host with no
   * full-screen reload, no coordinator re-entry, and no draft loss. Used by the
   * handoff and by authoritative personal-runtime recovery after another client
   * completes that same cutover; ordinary base changes use `setBaseUrl`.
   *
   * Note on the WS swap: on cloud bases (the shared REST adapter and
   * `*.cloud.eliza.app`) `connectWs()` reports connected-over-REST and no socket
   * is opened, so `ws-reconnected` does NOT fire and live updates resume via
   * REST/SSE keyed off the new `baseUrl`. The socket teardown + reconnect path
   * (steps 1 and 3, where `onopen` fires `ws-reconnected`) is exercised only for
   * non-cloud hosts — it is forward-cover for when a base actually uses `/ws`.
   * {@link onBaseUrlChange} fires unconditionally regardless of transport, so
   * a per-authority cache (e.g. the notification store, #18391) can observe
   * this swap even when no socket is involved.
   * The "invisible" wins (no `disconnected` flap, no `StartupScreen`, no draft
   * clear) hold independent of whether a socket is involved.
   */
  repointBaseUrl(baseUrl: string, token?: string | null): void {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return;
    if (this.pinnedRemoteApiBase && normalized !== this.pinnedRemoteApiBase) {
      logger.warn(
        "[ElizaClient] ignored a repoint outside the build-pinned remote target",
      );
      return;
    }
    if (
      this.pinnedRemoteApiBase &&
      token?.trim() &&
      !this.isPinnedRemoteCredential(token)
    ) {
      logger.warn(
        "[ElizaClient] ignored a repoint credential not bound to the build-pinned remote target",
      );
      return;
    }
    // Quietly drop the old socket. We intentionally do NOT call disconnectWs():
    // it sets connectionState = "disconnected" and emits, which would surface a
    // visible "reconnecting" flicker mid-handoff. Suppress onclose (which would
    // otherwise schedule a reconnect against the OLD base) and close silently.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    // Pending outbound WS frames were addressed to the old host; drop them so
    // they aren't replayed against the dedicated socket. The send-queue is for
    // offline buffering, not cross-host carry-over.
    this.wsSendQueue = [];
    this.wsEventBacklog.clear();

    const installsToken = token !== undefined;
    if (installsToken) this.installToken(token ?? null, false);
    this._userSetBase = normalized.length > 0;
    this._baseUrl = normalized;
    this.persistBaseUrlFailClosed(normalized);
    this.notifyBaseUrlChange();
    // Publish the complete target only after both bearer and base URL have
    // been installed, so resource consumers never observe a mixed authority.
    this.notifyAuthorityChange();

    // Reconnect immediately against the new base. connectWs() derives the WS
    // host from this.baseUrl, so the socket comes up on the dedicated host; its
    // onopen fires `ws-reconnected` (this.wsHasConnectedOnce is already true),
    // re-hydrating live state without a reload.
    this.backoffMs = 500;
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectWs();
    if (installsToken && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    }
  }

  /** True when we have a usable HTTP(S) API endpoint. */
  get apiAvailable(): boolean {
    if (this.baseUrl) return true;
    if (typeof window !== "undefined") {
      const proto = window.location.protocol;
      return proto === "http:" || proto === "https:";
    }
    return false;
  }

  /**
   * Resolve the serving runtime after Shared rejects a turn because another
   * client completed the authoritative personal-Eliza cutover. The persisted
   * selection remains keyed by `personal:*`; only its runtime target and API
   * base change. Concurrent rejected requests share one resolution and each
   * caller retries its own idempotent request against the resolved target.
   */
  private async repointAfterPersonalElizaCutover(
    response: Response,
    requestBase: string,
    authToken: string | null,
    signal?: AbortSignal | null,
  ): Promise<boolean> {
    if (response.status !== 409 || !authToken) return false;

    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      // error-policy:J3 only the exact structured cutover rejection is trusted.
      return false;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { code?: unknown }).code !== "personal_eliza_dedicated"
    ) {
      return false;
    }

    const normalizedRequestBase = normalizeBaseUrl(requestBase);
    const personalElizaId = directCloudSharedAgentIdFromBase(
      normalizedRequestBase,
    );
    if (!personalElizaId || !isPersonalSharedElizaId(personalElizaId)) {
      return false;
    }
    const persisted = loadPersistedActiveServer();
    if (
      persisted?.kind !== "cloud" ||
      persisted.id !== `cloud:${personalElizaId}`
    ) {
      return false;
    }

    const liveBase = normalizeBaseUrl(this.baseUrl);
    if (liveBase !== normalizedRequestBase) {
      return (
        persisted.cloudRuntime === "dedicated" &&
        isDedicatedCloudAgentBase(liveBase)
      );
    }
    if (this.personalElizaRuntimeRepoint) {
      return await this.personalElizaRuntimeRepoint;
    }

    const resolver = (
      this as ElizaClient & {
        ensurePersonalDedicatedEliza?: (options: {
          cloudApiBase: string;
          authToken: string;
          signal?: AbortSignal;
        }) => Promise<{
          personalElizaId: string;
          agentId: string;
          activeAgentId: string;
          agentName: string;
          apiBase: string;
          runtime: "shared" | "dedicated";
        }>;
      }
    ).ensurePersonalDedicatedEliza;
    if (typeof resolver !== "function") return false;

    const cloudApiBase = new URL(normalizedRequestBase).origin;
    const repoint = (async (): Promise<boolean> => {
      try {
        const resolved = await resolver.call(this, {
          cloudApiBase,
          authToken,
          ...(signal ? { signal } : {}),
        });
        if (
          resolved.runtime !== "dedicated" ||
          resolved.personalElizaId !== personalElizaId ||
          resolved.agentId !== personalElizaId ||
          !resolved.activeAgentId ||
          !isTrustedCloudApiBaseUrl(resolved.apiBase, resolved.activeAgentId)
        ) {
          return false;
        }

        const current = loadPersistedActiveServer();
        const currentBase = normalizeBaseUrl(current?.apiBase);
        if (
          current?.kind !== "cloud" ||
          current.id !== `cloud:${personalElizaId}` ||
          (currentBase && currentBase !== normalizedRequestBase)
        ) {
          return false;
        }

        const server = createPersistedActiveServer({
          kind: "cloud",
          id: `cloud:${personalElizaId}`,
          label: resolved.agentName || current.label,
          apiBase: resolved.apiBase,
          accessToken: authToken,
          cloudRuntimeAgentId: resolved.activeAgentId,
          cloudRuntime: "dedicated",
        });
        if (!savePersistedActiveServer(server)) {
          logger.warn(
            "[ElizaClient] Dedicated runtime resolved but active-server persistence was unavailable",
          );
        }
        upsertAndActivateAgentProfile({
          kind: "cloud",
          label: server.label,
          cloudAgentId: personalElizaId,
          cloudRuntimeAgentId: resolved.activeAgentId,
          cloudRuntime: "dedicated",
          apiBase: resolved.apiBase,
          accessToken: authToken,
        });

        if (normalizeBaseUrl(this.baseUrl) !== normalizedRequestBase) {
          return isDedicatedCloudAgentBase(this.baseUrl);
        }
        this.repointBaseUrl(resolved.apiBase, authToken);
        return true;
      } catch (error) {
        // error-policy:J4 the original structured Shared rejection remains the
        // visible failure when the read-only authority lookup is unavailable.
        logger.warn(
          { error },
          "[ElizaClient] failed to resolve authoritative personal Eliza runtime after cutover",
        );
        return false;
      }
    })();
    this.personalElizaRuntimeRepoint = repoint;
    try {
      return await repoint;
    } finally {
      if (this.personalElizaRuntimeRepoint === repoint) {
        this.personalElizaRuntimeRepoint = null;
      }
    }
  }

  // --- REST API ---

  async rawRequest(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      timeoutMs?: number;
      /** Invoked once when the client starts waiting on the server's behalf: a
       *  non-running cloud agent answered 202 and the resume loop began
       *  (#8628), or a named first-turn cache-warming 503 is being absorbed
       *  (#18045). Lets the chat surface a `waking` status instead of stalled
       *  dots. */
      onResuming?: () => void;
      /** Skip the bounded 202 resume-retry loop and return the FIRST 202 body
       *  as-is (#14040 sub-defect 2). The chat/stream path wants the eventual
       *  real reply, so it keeps the loop; the readiness/status poll instead
       *  wants to surface the 202 progress body (`{status:"starting",jobId,
       *  retryAfterMs}`) as an honest "resuming" state on EVERY tick, rather
       *  than blocking ~30s then throwing `agent_resuming` (which the poll
       *  swallowed → spinner with no progress). Implies `allowNonOk` for the
       *  202. */
      skipResume?: boolean;
    },
  ): Promise<Response> {
    if (!this.apiAvailable) {
      throw new ApiError({
        kind: "network",
        path,
        message: "API not available (no HTTP origin)",
      });
    }
    // Capture the base this request was issued against so a concurrent
    // setBaseUrl cannot attribute another host's 404 to the new binding.
    let requestBase = this.baseUrl;
    let requestUrl = this.rawRequestUrl(path);
    let token =
      this.apiToken ?? (await hydrateAndroidLocalAgentTokenForUrl(requestUrl));
    // One bounded classification loop: EVERY response — first attempt or any
    // retry — re-enters the same 401/202/warming classifier, so the states
    // compose in any order (warming → 202, 401 → warming, …). The token is a
    // mutable local: a mid-flight 401 refresh writes it back so every later
    // resume/warming re-issue carries the refreshed credential, not the one
    // captured before the refresh.
    let authRetried = false;
    let notifiedWaiting = false;
    const notifyWaiting = () => {
      if (!notifiedWaiting) {
        notifiedWaiting = true;
        options?.onResuming?.();
      }
    };
    let resumeRetries = 0;
    let warmingRetries = 0;
    let warmingDeadline: number | null = null;
    const logicalRequestDeadline =
      Date.now() + (options?.timeoutMs ?? defaultFetchTimeoutMs(path, init));
    let requestAttempt = 0;
    const requestOnce = () =>
      this.rawRequestOnce(
        path,
        requestUrl,
        init,
        options,
        token,
        ++requestAttempt,
      );
    let res = await requestOnce();
    // Personal-Eliza cutover repoint happens once, before classification: a
    // structural Shared rejection can rebind this client to the dedicated
    // runtime, after which the re-issued request (fresh base/url/token) enters
    // the same 401/202/warming loop below.
    if (
      await this.repointAfterPersonalElizaCutover(
        res,
        requestBase,
        token,
        init?.signal,
      )
    ) {
      requestBase = this.baseUrl;
      requestUrl = this.rawRequestUrl(path);
      token = this.apiToken;
      res = await requestOnce();
    }
    while (true) {
      // 401: one token refresh per logical request, wherever in the retry
      // sequence it appears (a warming retry can race token expiry).
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        const hydratedToken = await hydrateAndroidLocalAgentTokenForUrl(
          requestUrl,
          { force: true },
        );
        const retryToken = hydratedToken ?? (!token ? this.apiToken : null);
        if (retryToken && retryToken !== token) {
          token = retryToken;
          res = await requestOnce();
          continue;
        }
      }
      // 202 Accepted: a non-running dedicated cloud agent is auto-resuming
      // (#8628). Wait the advertised Retry-After and re-issue, bounded, so
      // callers see the eventual response instead of a 202 placeholder — also
      // when the 202 arrives only AFTER warming 503s were absorbed.
      if (res.status === 202) {
        notifyWaiting();
        // Status/readiness poll opts out of the wait-and-retry loop: it wants
        // the live 202 progress body back immediately so it can render honest
        // progress (#14040 sub-defect 2). Return the 202 response untouched.
        if (options?.skipResume) return res;
        if (resumeRetries < RESUME_MAX_RETRIES && !init?.signal?.aborted) {
          await sleepUnlessAborted(resumeRetryDelayMs(res), init?.signal);
          if (!init?.signal?.aborted) {
            resumeRetries += 1;
            res = await requestOnce();
            continue;
          }
        }
        // Resume budget exhausted while the agent is still 202 (resuming):
        // surface a distinguishable error instead of returning the empty 202
        // placeholder as a success — otherwise the chat/stream path renders an
        // empty reply. allowNonOk callers and aborted requests still get the
        // raw response.
        if (!options?.allowNonOk && !init?.signal?.aborted) {
          throw new ApiError({
            kind: "http",
            path,
            status: 202,
            message:
              "Agent is still starting up — please try again in a moment.",
            code: "agent_resuming",
            retryAfter: resumeRetryDelayMs(res) / 1000,
          });
        }
        return res;
      }
      if (res.ok) return res;
      const rawText = await this.readBodyText(
        res,
        path,
        options?.timeoutMs,
        init,
      ).catch((error: unknown) => {
        if (
          error instanceof ApiError &&
          (error.kind === "timeout" || error.kind === "network")
        ) {
          throw error;
        }
        // error-policy:J3 a completed HTTP failure remains authoritative when
        // its optional diagnostic body cannot be read for a non-abort reason.
        return "";
      });
      let body: Record<string, unknown> | null = null;
      if (rawText) {
        try {
          body = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          // error-policy:J3 untrusted error body stays an explicit null parse.
          body = null;
        }
      }
      if (!body) {
        body = { error: res.statusText || `HTTP ${res.status}` };
      }
      const message =
        typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : `HTTP ${res.status}`;
      const code = typeof body.code === "string" ? body.code : undefined;
      // `Number(null) === 0` and `Number(undefined) === NaN`, so we must guard
      // each source before coercing — otherwise an absent `Retry-After` header
      // produces a spurious `retryAfter = 0` on every non-rate-limit error
      // path, polluting the shared `ApiError` surface for unrelated callers.
      const headerValue = res.headers.get("Retry-After");
      const headerRetryAfter =
        headerValue !== null && Number.isFinite(Number(headerValue))
          ? Number(headerValue)
          : undefined;
      const rawBodyRetryAfter = body.retryAfter;
      const bodyRetryAfter =
        typeof rawBodyRetryAfter === "number" &&
        Number.isFinite(rawBodyRetryAfter)
          ? rawBodyRetryAfter
          : undefined;
      const retryAfter = bodyRetryAfter ?? headerRetryAfter;
      // App-contributed routes are rejected before dispatch while their route
      // tail registers, so reissuing reads and writes is safe. A caller-owned
      // AbortSignal makes the mounted lifecycle the terminal budget and may
      // therefore outlive the generic request deadline. An explicit timeout is
      // still authoritative even when the caller also supplies a signal, while
      // unsignaled callers remain bounded so an accidental fire-and-forget read
      // cannot retry forever. `allowNonOk` probes still receive the first 503.
      const featureStarting =
        res.status === 503 &&
        code === "feature_starting" &&
        body.retryable === true;
      if (featureStarting && !options?.allowNonOk && !init?.signal?.aborted) {
        const now = Date.now();
        const lifecycleBound =
          init?.signal != null && options?.timeoutMs === undefined;
        if (lifecycleBound || now < logicalRequestDeadline) {
          notifyWaiting();
          await sleepUnlessAborted(
            lifecycleBound
              ? warmingRetryDelayMs(retryAfter)
              : Math.min(
                  warmingRetryDelayMs(retryAfter),
                  logicalRequestDeadline - now,
                ),
            init?.signal,
          );
          if (
            !init?.signal?.aborted &&
            (lifecycleBound || Date.now() < logicalRequestDeadline)
          ) {
            res = await requestOnce();
            continue;
          }
        }
      }
      if (featureStarting && !options?.allowNonOk && init?.signal?.aborted) {
        throw new ApiError({
          kind: "network",
          path,
          message: "Request aborted",
          cause: init.signal.reason,
        });
      }
      // First-turn cache warming retains its deliberately short attempt and
      // elapsed-time bounds. Unlike feature registration, a stuck cache warm
      // surfaces its structured error after the ~5s absorption budget.
      if (
        res.status === 503 &&
        code !== undefined &&
        CACHE_WARMING_RETRYABLE_CODES.has(code) &&
        !options?.allowNonOk &&
        warmingRetries < WARMING_MAX_RETRIES &&
        !init?.signal?.aborted
      ) {
        const now = Date.now();
        if (warmingDeadline === null) {
          warmingDeadline = now + WARMING_TOTAL_BUDGET_MS;
        }
        if (now < warmingDeadline) {
          warmingRetries += 1;
          // Surface the wait like the 202 resume path does — the chat maps
          // this to a `waking` status so the send shows warm-up, not stalled
          // dots.
          notifyWaiting();
          const delay = Math.min(
            warmingRetryDelayMs(retryAfter),
            warmingDeadline - now,
          );
          await sleepUnlessAborted(delay, init?.signal);
          if (!init?.signal?.aborted) {
            res = await requestOnce();
            continue;
          }
        }
      }
      const error = new ApiError({
        kind: "http",
        path,
        status: res.status,
        message,
        code,
        retryAfter,
        // Structured consumers (the /join credit-gate classifier) read fields
        // the flattened message/code drop, e.g. `welcomeBonusWithheld`.
        data: body,
      });
      // Structural agent-gone from a bound cloud agent host: drop the dead
      // binding at the request choke point so background callers (lifeops
      // activity-signals, status probes with allowNonOk, …) stop hammering a
      // deleted agent forever. Join-flow recovery alone only covered the
      // selection path (#17837); login-page background posts were still bound
      // (#18048). Uses the request-time base so a concurrent setBaseUrl cannot
      // attribute this 404 to a newly selected agent.
      this.releaseStaleCloudAgentBindingIfGone(error, requestBase);
      if (!options?.allowNonOk) {
        throw error;
      }
      // allowNonOk callers still need a Response whose body is unread.
      return new Response(rawText, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
  }

  /**
   * When a cloud agent host answers the unambiguous "agent not found or not
   * running" 404, clear the live base + persisted active-server / matching
   * agent profiles so subsequent requests stop targeting the corpse. No-ops for
   * local agents, control-plane hosts, non-agent-gone errors, and requests
   * whose base no longer matches the live client (concurrent switch). Marks a
   * base released only after teardown succeeds so a partial failure can retry.
   */
  private releaseStaleCloudAgentBindingIfGone(
    error: ApiError,
    requestBase: string,
  ): void {
    if (!isCloudAgentGoneError(error)) return;
    const base = normalizeBaseUrl(requestBase);
    if (!base) return;
    if (
      !isDedicatedCloudAgentBase(base) &&
      !isSharedRuntimeRestAdapterBase(base)
    ) {
      return;
    }
    if (this._releasedGoneAgentBase === base) return;

    // A concurrent switch may have already moved the live client off this
    // corpse — never tear down the new binding because of a stale response.
    const liveBase = normalizeBaseUrl(this.baseUrl);
    if (liveBase && liveBase !== base) return;

    try {
      const persisted = loadPersistedActiveServer();
      const persistedBase = normalizeBaseUrl(persisted?.apiBase);
      if (!persisted || persistedBase === base) {
        clearPersistedActiveServer();
      }

      // One registry write: drop matching profiles and leave activeProfileId
      // null rather than auto-activating an unconnected survivor (removeAgentProfile
      // would promote profiles[0]).
      const registry = loadAgentProfileRegistry();
      const remaining = registry.profiles.filter((profile) => {
        const profileBase = normalizeBaseUrl(profile.apiBase);
        return !profileBase || profileBase !== base;
      });
      if (remaining.length !== registry.profiles.length) {
        const activeStillPresent = remaining.some(
          (profile) => profile.id === registry.activeProfileId,
        );
        saveAgentProfileRegistry({
          version: 1,
          activeProfileId: activeStillPresent ? registry.activeProfileId : null,
          profiles: remaining,
        });
      }

      if (!liveBase || liveBase === base) {
        this.setBaseUrl(null);
      }
      this._releasedGoneAgentBase = base;
    } catch (teardownError) {
      // error-policy:J6 best-effort binding teardown must not mask the original
      // agent-gone error; leave _releasedGoneAgentBase unset so a later 404 can
      // retry incomplete cleanup.
      logger.warn(
        {
          requestBase: base,
          error:
            teardownError instanceof Error
              ? teardownError.message
              : String(teardownError),
        },
        "[ElizaClient] failed to release stale cloud agent binding after agent-gone 404",
      );
    }
  }

  private rawRequestUrl(path: string): string {
    if (this.baseUrl) return `${this.baseUrl}${path}`;
    if (typeof window !== "undefined") {
      const proto = window.location.protocol;
      if (proto === "http:" || proto === "https:") {
        return new URL(path, window.location.origin).toString();
      }
    }
    return path;
  }

  private async rawRequestOnce(
    path: string,
    requestUrl: string,
    init: RequestInit | undefined,
    options: { allowNonOk?: boolean; timeoutMs?: number } | undefined,
    token: string | null,
    requestAttempt: number,
  ): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? defaultFetchTimeoutMs(path, init);
    const abortController = new AbortController();
    let timedOut = false;
    let abortListener: (() => void) | undefined;

    if (init?.signal?.aborted) {
      throw new ApiError({
        kind: "network",
        path,
        message: "Request aborted",
      });
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    if (init?.signal) {
      abortListener = () => abortController.abort();
      init.signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      const requestInit = this.rawRequestInit(
        init,
        abortController,
        token,
        requestUrl,
        requestAttempt,
      );
      const transport = await this.rawRequestTransport(requestUrl);
      return await transport.request(requestUrl, requestInit, { timeoutMs });
    } catch (err) {
      // error-policy:J2 context-adding rethrow — throwRawRequestError wraps
      // the transport failure with path/timeout/abort context and throws.
      return this.throwRawRequestError(
        err,
        path,
        timeoutMs,
        timedOut,
        abortController,
      );
    } finally {
      clearTimeout(timeoutId);
      if (init?.signal && abortListener) {
        init.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private rawRequestInit(
    init: RequestInit | undefined,
    abortController: AbortController,
    token: string | null,
    requestUrl: string,
    requestAttempt: number,
  ): RequestInit {
    const isDedicatedCloudRequest = isDedicatedCloudAgentBase(requestUrl);
    const isEncryptedRelayRequest = isRemoteRelayApiUrl(requestUrl);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {
      ...(!isDedicatedCloudRequest
        ? { "X-ElizaOS-Client-Id": this.clientId }
        : {}),
      ...(token && !isEncryptedRelayRequest
        ? { Authorization: `Bearer ${token}` }
        : {}),
      ...(!isDedicatedCloudRequest && this._uiLanguage
        ? { "X-ElizaOS-UI-Language": this._uiLanguage }
        : {}),
      ...requestHeadersToRecord(init?.headers),
    };
    const hasCsrfHeader = Object.keys(headers).some(
      (name) => name.toLowerCase() === CSRF_HEADER_NAME,
    );
    if (
      !isDedicatedCloudRequest &&
      !isEncryptedRelayRequest &&
      !hasCsrfHeader &&
      CSRF_REQUIRED_METHODS.has(method)
    ) {
      const csrfToken = readCsrfTokenForUrl(requestUrl);
      if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
    }
    const correlation = headers[SHARED_TURN_CORRELATION_HEADER];
    if (correlation) {
      headers[SHARED_TURN_ATTEMPT_HEADER] = String(requestAttempt);
    }
    if (isDedicatedCloudRequest) {
      for (const key of Object.keys(headers)) {
        const normalized = key.toLowerCase();
        if (
          DEDICATED_CLOUD_CORS_BLOCKED_HEADERS.has(normalized) ||
          (normalized === "x-eliza-trace-id" &&
            !isInferenceTraceId(headers[key]))
        ) {
          delete headers[key];
        }
      }
    }
    return {
      ...init,
      credentials: isDedicatedCloudRequest
        ? "omit"
        : (init?.credentials ?? "include"),
      signal: abortController.signal,
      headers,
    };
  }

  private async rawRequestTransport(
    requestUrl: string,
  ): Promise<AgentRequestTransport> {
    if (this.requestTransport !== fetchAgentTransport) {
      return this.requestTransport;
    }
    return (
      (await androidNativeAgentTransportForUrl(requestUrl)) ??
      (await iosInProcessAgentTransportForUrl(requestUrl)) ??
      (await desktopLocalAgentTransportForUrl(requestUrl)) ??
      remoteRelayTransportForUrl(requestUrl) ??
      sshRuntimeTransportForUrl(requestUrl) ??
      desktopHttpTransportForUrl(requestUrl) ??
      nativeCloudHttpTransportForUrl(requestUrl) ??
      this.requestTransport
    );
  }

  private throwRawRequestError(
    err: unknown,
    path: string,
    timeoutMs: number,
    timedOut: boolean,
    abortController: AbortController,
  ): never {
    if (timedOut) {
      throw new ApiError({
        kind: "timeout",
        path,
        message: `Request timed out after ${timeoutMs}ms`,
      });
    }
    if (abortController.signal.aborted) {
      throw new ApiError({
        kind: "network",
        path,
        message: "Request aborted",
        cause: err,
      });
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError({
      kind: "network",
      path,
      message:
        err instanceof Error && err.message
          ? err.message
          : "Network request failed",
      cause: err,
    });
  }

  /**
   * Reads a response body with the same budget the request itself had. The
   * per-request abort timer in {@link rawRequestOnce} is cleared the moment
   * HEADERS arrive, so without this a response whose body stream stalls
   * (proxies, USB/adb relays, dropped radios) pends forever — JSON consumers
   * must never await an unbounded body. Streaming consumers (SSE) keep their
   * own idle timeout and do not go through here.
   */
  private async readBodyText(
    res: Response,
    path: string,
    timeoutMs?: number,
    init?: RequestInit,
  ): Promise<string> {
    // Must mirror the request phase's budget (rawRequestOnce uses
    // defaultFetchTimeoutMs(path, init)). Passing `undefined` here forced the
    // GET branch -> 10s for every route, so the body read of a long POST
    // (chat 600s, ASR/TTS 180s, reset 60s) would spuriously time out on slow
    // on-device builds that emit headers early then take >10s to finish.
    const budgetMs = timeoutMs ?? defaultFetchTimeoutMs(path, init);
    const reader = res.body?.getReader();
    if (!reader) return res.text();

    const decoder = new TextDecoder();
    let text = "";
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let terminalReason: "timeout" | "caller-abort" | null = null;
    const interrupted = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        terminalReason = "timeout";
        reject(
          new ApiError({
            kind: "timeout",
            path,
            status: res.status,
            message: `Response body timed out after ${budgetMs}ms`,
          }),
        );
      }, budgetMs);

      if (init?.signal) {
        abortListener = () => {
          terminalReason = "caller-abort";
          reject(
            new ApiError({
              kind: "network",
              path,
              status: res.status,
              message: "Request aborted",
              cause: init.signal?.reason,
            }),
          );
        };
        if (init.signal.aborted) abortListener();
        else
          init.signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    try {
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          interrupted,
        ]);
        if (done) return text + decoder.decode();
        if (value) text += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      try {
        await reader.cancel(
          terminalReason === "timeout"
            ? "elizaos-json-body-timeout"
            : terminalReason === "caller-abort"
              ? init?.signal?.reason
              : "elizaos-json-body-read-failed",
        );
      } catch (cancelError) {
        // error-policy:J6 a failed or already-closed body may reject teardown;
        // preserve the primary timeout, caller abort, or read failure.
        logger.debug(
          { path, error: cancelError },
          "[ElizaClient] failed to cancel interrupted JSON response body",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (init?.signal && abortListener) {
        init.signal.removeEventListener("abort", abortListener);
      }
      reader.releaseLock();
    }
  }

  async fetch<T>(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      timeoutMs?: number;
      /** Skip the 202 resume-retry loop (see `rawRequest.skipResume`). */
      skipResume?: boolean;
      /**
       * Called with the (bounded-read, best-effort-parsed) body when the FIRST
       * response is a 202 and `skipResume` is set — lets the status poll map the
       * cloud resume-progress body to a real value WITHOUT bypassing the shared
       * bounded body-read / timeout logic (#14040 sub-defect 2). Non-202
       * responses go through the normal strict-parse path unchanged.
       */
      on202?: (body: unknown) => T;
    },
  ): Promise<T> {
    const res = await this.rawRequest(
      path,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init?.headers,
        },
      },
      options,
    );
    if (res.status === 204) {
      return undefined as T;
    }
    // 202 resume-progress (status poll only): read the body with the SAME
    // bounded budget as any other body (never an unbounded `res.text()` — a
    // stalled body must time out, not wedge the 1.5s poll), best-effort parse,
    // and hand it to the caller's mapper. The proxy body is advisory, so a
    // non-JSON 202 is tolerated (mapper still gets `undefined`).
    if (res.status === 202 && options?.on202) {
      const raw = await this.readBodyText(res, path, options?.timeoutMs, init);
      let body: unknown;
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          // error-policy:J3 untrusted 202 progress body defaults to an explicit starting progress state.
        }
      }
      return options.on202(body);
    }
    const text = await this.readBodyText(res, path, options?.timeoutMs, init);
    if (text === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ApiError({
        kind: "parse",
        path,
        status: res.status,
        message:
          err instanceof Error
            ? `Invalid JSON response: ${err.message}`
            : "Invalid JSON response",
        cause: err,
      });
    }
  }

  // --- WebSocket ---

  private rememberReplayableWsEvent(
    type: string,
    data: Record<string, unknown>,
  ): void {
    if (!REPLAYABLE_WS_EVENT_TYPES.has(type)) return;
    const backlog = this.wsEventBacklog.get(type) ?? [];
    backlog.push(data);
    if (backlog.length > WS_EVENT_BACKLOG_LIMIT) {
      backlog.splice(0, backlog.length - WS_EVENT_BACKLOG_LIMIT);
    }
    this.wsEventBacklog.set(type, backlog);
  }

  private replayBackloggedWsEvents(
    type: string,
    handler: WsEventHandler,
  ): void {
    const backlog = this.wsEventBacklog.get(type);
    if (!backlog?.length) return;
    const pending = backlog.slice();
    queueMicrotask(() => {
      if (!this.wsHandlers.get(type)?.has(handler)) return;
      for (const data of pending) {
        try {
          handler(data);
        } catch {
          // Match normal WS dispatch: a handler error must not poison replay.
        }
      }
      const current = this.wsEventBacklog.get(type);
      if (!current?.length) return;
      const delivered = new Set(pending);
      const remaining = current.filter((data) => !delivered.has(data));
      if (remaining.length > 0) {
        this.wsEventBacklog.set(type, remaining);
      } else {
        this.wsEventBacklog.delete(type);
      }
    });
  }

  connectWs(): void {
    // Infer REST-only policy from the page only for implicit same-origin
    // clients. An injected realtime target keeps its existing socket and
    // retry policy, even when its hostname resembles a REST-only API host.
    const effectiveBase =
      this.baseUrl ||
      (getInjectedWsBase()
        ? ""
        : typeof window !== "undefined"
          ? window.location.origin
          : "");
    if (shouldTreatAsConnectedWithoutWebSocket(effectiveBase)) {
      this.backoffMs = 500;
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      if (this.connectionState !== "connected") {
        this.connectionState = "connected";
        this.emitConnectionStateChange();
      }
      return;
    }

    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      if (
        this.ws.readyState === WebSocket.OPEN &&
        this.connectionState !== "connected"
      ) {
        this.backoffMs = 500;
        this.reconnectAttempt = 0;
        this.disconnectedAt = null;
        this.connectionState = "connected";
        this.emitConnectionStateChange();
      }
      return;
    }

    let host: string;
    let wsProtocol: "ws:" | "wss:";
    let wsBase = getInjectedWsBase();
    // #20342: the Vite dev server injects __ELIZA_WS_BASE__ unconditionally in
    // serve mode (computed from the page origin) so tunnels can proxy /ws.
    // That injection must be AMBIENT — it cannot override an HTTP(S) agent the
    // user explicitly selected after boot. Rule: when a user-pinned HTTP(S)
    // base exists and the injected WS base merely normalizes to the current
    // page origin, derive realtime from the selected base instead. A genuinely
    // separate injected WS host (different origin) remains authoritative.
    const explicitHttpBase =
      this._userSetBase && this.baseUrl
        ? (() => {
            try {
              const protocol = new URL(this.baseUrl).protocol;
              return protocol === "http:" || protocol === "https:";
            } catch {
              // error-policy:J3 malformed base URLs are explicitly ineligible
              // for WS-base precedence; ambient derivation below still reads
              // them exactly as before.
              return false;
            }
          })()
        : false;
    if (wsBase && explicitHttpBase) {
      try {
        // Normalize ws/wss origins to their http/https equivalents for the
        // comparison: same host+port+scheme means "just the dev origin".
        // URL.origin keeps the ws/wss scheme, so map both spellings.
        const toHttpOrigin = (value: string): string =>
          value
            .replace(/^wss:\/\//i, "https://")
            .replace(/^ws:\/\//i, "http://");
        const injectedOrigin = toHttpOrigin(new URL(wsBase).origin);
        if (injectedOrigin === window.location.origin) {
          wsBase = undefined; // fall through to the explicit client base
        }
      } catch {
        // error-policy:J3 a malformed injected WS URL is not silently
        // reinterpreted: the existing parse-and-throw below handles it.
      }
    }
    if (wsBase) {
      const parsed = new URL(wsBase);
      host = parsed.host;
      wsProtocol =
        parsed.protocol === "https:" || parsed.protocol === "wss:"
          ? "wss:"
          : "ws:";
    } else if (this.baseUrl) {
      const parsed = new URL(this.baseUrl);
      host = parsed.host;
      wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    } else {
      // In non-HTTP environments (electrobun://, file://, etc.)
      // window.location.host may be empty or a non-routable value like "-".
      const loc = window.location;
      if (loc.protocol !== "http:" && loc.protocol !== "https:") return;
      host = loc.host;
      wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
    }

    if (!host) return;

    // HTTPS renderers block `ws://` as mixed content. Capacitor's packaged
    // renderer also cannot use that cleartext WebView socket even though its
    // native HTTP bridge keeps REST healthy. Both origins therefore use the
    // same REST-only state instead of reporting a dead backend (#16843).
    if (shouldUseRestOnlyForInsecureWebSocket(wsProtocol, host)) {
      this.backoffMs = 500;
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      if (this.connectionState !== "connected") {
        this.connectionState = "connected";
        this.emitConnectionStateChange();
      }
      return;
    }

    // On Capacitor native (iosScheme/androidScheme = "https"), the origin host
    // is a synthetic bundle host (e.g. "localhost" with no server behind it).
    // Skip WS there when we have no explicit baseUrl and the host doesn't look
    // like a real backend (no port, not an IP, not a known API domain).
    //
    // The skip is gated on the Capacitor native runtime: a plain BROWSER served
    // same-origin from a portless HTTPS host (nginx terminating TLS in front of
    // the agent — the standard self-hosted deployment shape) is a real backend
    // whose /ws must connect. Ungated, this guard silently disabled the
    // realtime WebSocket (proactive-message, conversation-updated, agent
    // events) for every such deployment while REST kept working, so live
    // server-pushed messages never rendered until a manual reload.
    if (
      !this.baseUrl &&
      isCapacitorNativeRuntime() &&
      typeof host === "string"
    ) {
      const hasPort = host.includes(":");
      const isLoopback =
        host.startsWith("127.") || host.startsWith("localhost:");
      if (!hasPort && !isLoopback) return;
    }

    let url = `${wsProtocol}//${host}/ws`;
    const params = new URLSearchParams({ clientId: this.clientId });
    // Browsers cannot set Authorization on `new WebSocket(url)`. Pass the same
    // token HTTP uses as a query param; cloud servers (ELIZA_ALLOW_WS_QUERY_TOKEN=1)
    // honor it during the upgrade handshake. Self-hosted servers without that
    // flag will ignore the query token and fall back to the post-open
    // `{type:"auth"}` message below.
    const token = this.apiToken;
    if (token) params.set("token", token);
    url += `?${params.toString()}`;

    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      const token = this.apiToken;
      if (token && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "auth", token }));
      }
      this.backoffMs = 500;
      // Reset connection state on successful connection
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      this.connectionState = "connected";
      this.emitConnectionStateChange();

      // Notify listeners when the WS reconnects (not on the first connect)
      // so they can re-hydrate state that may have been lost during the gap.
      // Fired once per reconnect — consumers refetch on demand, never poll.
      if (this.wsHasConnectedOnce) {
        const handlers = this.wsHandlers.get("ws-reconnected");
        if (handlers) {
          for (const handler of handlers) {
            handler({ type: "ws-reconnected" });
          }
        }
        for (const listener of this.resyncListeners) {
          listener();
        }
      }
      this.wsHasConnectedOnce = true;
      if (
        this.wsSendQueue.length > 0 &&
        this.ws?.readyState === WebSocket.OPEN
      ) {
        const pending = this.wsSendQueue;
        this.wsSendQueue = [];
        for (let i = 0; i < pending.length; i++) {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
            break;
          }
          try {
            this.ws.send(pending[i]);
          } catch {
            this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
            break;
          }
        }
      }
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        const data = JSON.parse(event.data as string) as Record<
          string,
          unknown
        >;
        this.dispatchWsData(data);
      } catch {
        // error-policy:J3 untrusted socket frame — a malformed frame is dropped;
        // the parsed-and-fanned path is dispatchWsData, exercised by tests.
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      // Track disconnection time if not already set
      if (this.disconnectedAt === null) {
        this.disconnectedAt = Date.now();
      }
      this.reconnectAttempt++;
      // Update state based on attempt count
      if (this.reconnectAttempt >= this.maxReconnectAttempts) {
        // A dedicated cloud agent serves chat over REST independently of the
        // realtime WS, so a WS that can't connect must NOT raise the fatal
        // full-screen "Lost backend connection" overlay. Degrade to a non-fatal
        // connected-over-REST state and keep probing in the background (see
        // scheduleReconnect's 30s loop) so live updates resume on WS recovery.
        if (
          isDedicatedCloudAgentBase(effectiveBase) ||
          // Control-plane hosts serve chat over REST/SSE and can never
          // complete a WS upgrade (#18172) — same non-fatal degrade.
          isElizaCloudControlPlaneBase(effectiveBase)
        ) {
          this.connectionState = "connected";
          this.disconnectedAt = null;
        } else {
          this.connectionState = "failed";
        }
      } else {
        this.connectionState = "reconnecting";
      }
      this.emitConnectionStateChange();
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      // close handler will fire
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Skip the backoff timer when the device reports no network — the
    // browser's `online`/`offline` events plus Capacitor's bridged
    // `networkStatusChange` event will wake us up when connectivity
    // returns. Without this, airplane mode (or a flaky cellular hand-
    // off) burns through all `maxReconnectAttempts` in seconds, leaving
    // the UI in the long-poll fallback even after the network comes
    // back.
    if (!lastKnownNetworkConnected) {
      this.armNetworkStatusWake();
      return;
    }
    // After the short backoff window is exhausted, keep probing at a
    // low frequency so the UI can recover without a full page refresh.
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectWs();
      }, 30_000);
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 10000);
  }

  /**
   * Arms a one-shot network-status listener that re-runs `connectWs()` the
   * moment the device reports connectivity again. Calling twice has no
   * additional effect; the existing listener stays in place.
   */
  private armNetworkStatusWake(): void {
    if (this.networkStatusUnsubscribe) return;
    const listener = (connected: boolean): void => {
      if (!connected) return;
      const unsubscribe = this.networkStatusUnsubscribe;
      this.networkStatusUnsubscribe = null;
      if (unsubscribe) unsubscribe();
      this.connectWs();
    };
    networkStatusListeners.add(listener);
    this.networkStatusUnsubscribe = () => {
      networkStatusListeners.delete(listener);
    };
  }

  private emitConnectionStateChange(): void {
    const state = this.getConnectionState();
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // ignore listener errors
      }
    }
  }

  /** Get the current WebSocket connection state. */
  getConnectionState(): ConnectionStateInfo {
    return {
      state: this.connectionState,
      reconnectAttempt: this.reconnectAttempt,
      maxReconnectAttempts: this.maxReconnectAttempts,
      disconnectedAt: this.disconnectedAt,
    };
  }

  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  onConnectionStateChange(
    listener: (state: ConnectionStateInfo) => void,
  ): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  /**
   * Subscribe to reconnect events. The listener fires once each time the
   * WebSocket re-establishes after a drop (never on the initial connect), so
   * callers can reconcile state that may have drifted during the gap — e.g.
   * refetch the active conversation's recent messages. Returns an unsubscribe
   * function. This is edge-triggered, not a poll.
   */
  onReconnect(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => {
      this.resyncListeners.delete(listener);
    };
  }

  /**
   * Force-close and immediately re-establish the live WebSocket against the
   * SAME base — `_baseUrl`, persistence, and the token are untouched. Unlike
   * {@link resetConnection}, which leaves an already-open socket alone, this
   * always tears the socket down first, nulling its handlers before `close()`
   * exactly like {@link repointBaseUrl}'s teardown, so nothing already in
   * flight on it can be delivered afterward.
   *
   * For an authority-scoped observer (e.g. the notification store, #18542)
   * whose authority changed WITHOUT a base URL change (an in-place identity
   * switch or logout), neither {@link setBaseUrl} nor {@link repointBaseUrl}
   * runs, so the socket would otherwise stay open across the switch — the one
   * transport gap {@link onBaseUrlChange} does not cover. This closes it.
   */
  rotateConnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.wsSendQueue = [];
    this.wsEventBacklog.clear();
    this.backoffMs = 500;
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectWs();
  }

  /** Reset connection state and restart reconnection attempts. */
  resetConnection(): void {
    const existingReadyState = this.ws?.readyState;
    if (
      existingReadyState === WebSocket.OPEN ||
      existingReadyState === WebSocket.CONNECTING
    ) {
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.backoffMs = 500;
      if (
        existingReadyState === WebSocket.OPEN &&
        this.connectionState !== "connected"
      ) {
        this.connectionState = "connected";
        this.emitConnectionStateChange();
      }
      return;
    }

    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = 500;
    this.emitConnectionStateChange();
    this.connectWs();
  }

  /**
   * Send an arbitrary JSON message over the WebSocket connection.
   *
   * Every message is stamped with a stable client-generated `msgId` (unless the
   * caller already supplied one). The id is assigned once and travels with the
   * payload, so a message that gets queued while offline and flushed after a
   * reconnect carries the *same* id on the resend — letting the server dedupe
   * `(clientId, msgId)` instead of double-processing it.
   */
  sendWsMessage(data: Record<string, unknown>): void {
    const message: Record<string, unknown> =
      typeof data.msgId === "string" && data.msgId.length > 0
        ? data
        : { ...data, msgId: ElizaClient.generateMessageId() };
    const payload = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }

    // Keep only the newest active-conversation update while disconnected.
    if (message.type === "active-conversation") {
      this.wsSendQueue = this.wsSendQueue.filter((queued) => {
        try {
          const parsed = JSON.parse(queued) as { type?: unknown };
          return parsed.type !== "active-conversation";
        } catch {
          return true;
        }
      });
    }

    if (this.wsSendQueue.length >= this.wsSendQueueLimit) {
      this.wsSendQueue.shift();
    }
    this.wsSendQueue.push(payload);

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connectWs();
    }
  }

  onWsEvent(type: string, handler: WsEventHandler): () => void {
    if (!this.wsHandlers.has(type)) {
      this.wsHandlers.set(type, new Set());
    }
    this.wsHandlers.get(type)?.add(handler);
    this.replayBackloggedWsEvents(type, handler);
    return () => {
      this.wsHandlers.get(type)?.delete(handler);
    };
  }

  // Single fan-out for a parsed incoming WS frame: deliver to the type's
  // handlers (or backlog for later replay), then to the wildcard handlers. The
  // live socket's onmessage and the test-only deliver hook share this so the
  // dispatch path has one implementation.
  private dispatchWsData(data: Record<string, unknown>): void {
    const type = data.type as string;
    const handlers = this.wsHandlers.get(type);
    if (handlers?.size) {
      for (const handler of handlers) {
        handler(data);
      }
    } else {
      this.rememberReplayableWsEvent(type, data);
    }
    const allHandlers = this.wsHandlers.get("*");
    if (allHandlers) {
      for (const handler of allHandlers) {
        handler(data);
      }
    }
  }

  /**
   * Deliver a synthetic incoming WS frame through the real handler fan-out —
   * the same path the live socket's `onmessage` runs. Lets integration tests
   * and headless render fixtures drive stream-consuming stores (the inline
   * task-activity pipeline, #13536) with genuine server payload shapes and no
   * socket, so the on-wire reconstruction seam is exercised, not bypassed.
   */
  deliverWsMessageForTest(data: Record<string, unknown>): void {
    this.dispatchWsData(data);
  }

  disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.networkStatusUnsubscribe) {
      this.networkStatusUnsubscribe();
      this.networkStatusUnsubscribe = null;
    }
    const socket = this.ws;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // error-policy:J6 intentional teardown of an already-closing socket.
      }
      if (this.ws === socket) this.ws = null;
    }
    this.wsSendQueue = [];
    this.wsEventBacklog.clear();
    // Reset connection state on intentional disconnect
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    this.emitConnectionStateChange();
  }

  // --- Text normalization helpers (used by chat domain methods) ---

  normalizeAssistantText(
    text: string,
    options?: { interrupted?: boolean },
  ): string {
    if (typeof text !== "string") return GENERIC_NO_RESPONSE_TEXT;
    // Interrupted receipts contain only the text generated before cancellation;
    // their typed status must not become an invented reply or rewrite a partial.
    if (options?.interrupted === true) return text;
    const stripped = stripAssistantStageDirections(
      extractAssistantReplyText(text) ?? text,
    );
    const trimmed = stripped.trim();
    if (trimmed.length === 0) {
      if (
        text.trim().length === 0 ||
        /^\(?no response\)?$/i.test(text.trim())
      ) {
        return GENERIC_NO_RESPONSE_TEXT;
      }
      return "";
    }
    if (/^\(?no response\)?$/i.test(trimmed)) {
      return GENERIC_NO_RESPONSE_TEXT;
    }
    return trimmed;
  }

  normalizeGreetingText(text: string): string {
    const stripped = stripAssistantStageDirections(
      extractAssistantReplyText(text) ?? text,
    );
    const trimmed = stripped.trim();
    if (trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed)) {
      return "";
    }
    return trimmed;
  }

  // --- Streaming chat endpoint (used by chat domain methods) ---

  async streamChatEndpoint(
    path: string,
    text: string,
    onToken: (
      token: string,
      accumulatedText?: string,
      /** True when this text state is an in-flight action-callback delivery
       *  the final reply may replace — voice output must hold it (see
       *  StreamChatEvent.provisional). */
      provisional?: boolean,
    ) => void,
    channelType: ConversationChannelType = "DM",
    signal?: AbortSignal,
    images?: ImageAttachment[],
    metadata?: Record<string, unknown>,
    /** Additive: in-flight phase changes (thinking / streaming / running_action
     *  / waking …). Omitting it leaves the token/done/error behaviour unchanged. */
    onStatus?: (status: ChatTurnStatus) => void,
    /** Additive: inline tool-call steps (call → result/error) for the thread's
     *  tool rows. Omitting it leaves token/done/error behaviour unchanged. */
    onToolEvent?: (event: ChatToolCallEvent) => void,
    /** Additive: caller-supplied idempotency key. When a send is auto-retried
     *  after a network blip the SAME id must ride the retry so a request that
     *  actually landed server-side is de-duped instead of double-delivered.
     *  Omit for a fresh send — a new id is generated. */
    clientMessageId?: string,
    /** Settled action receipts, before terminal bookkeeping. This does not
     *  complete the stream or release the caller's pending-turn ownership. */
    onReplyReady?: (actionResults: ChatActionResultSummary[]) => void,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    interrupted?: boolean;
    transcriptVisibility?: "internal";
    reasoning?: string;
    noResponseReason?: "ignored";
    usage?: ChatTokenUsage;
    failureKind?: ChatFailureKind;
    terminalFailure?: ChatTerminalFailure;
    replyRecoveryAvailable?: boolean;
    accountConnect?: AccountConnectRequest;
    localInference?: LocalInferenceChatMetadata;
    actionResults?: ChatActionResultSummary[];
    messageId?: string;
    userMessageId?: string;
    assistantEphemeral?: boolean;
    historyRefreshRequired?: boolean;
  }> {
    // Idempotency key for the chat send. The HTTP chat path (POST
    // /api/chat[/:conversationId]/stream) lives in
    // packages/agent/src/api/chat-routes.ts, which is owned by the chat swarm.
    // Server-side dedupe by `clientMessageId` should hook there, where the
    // request body is parsed before the message is persisted/generated. The id
    // is generated here so the contract is in place regardless of when that
    // dedupe lands. A caller-supplied id (auto-retry after a network blip)
    // takes precedence so the retry is idempotent with the original attempt.
    const resolvedClientMessageId =
      clientMessageId ?? ElizaClient.generateMessageId();
    // This identifier exists only for short-lived attempt telemetry. Keep it
    // separate from the persisted/idempotent message ID so natural logs cannot
    // be joined back to message records or caller-supplied identifiers.
    const turnCorrelation = generateSharedTurnCorrelation();
    const dedicatedTraceId = isDedicatedCloudAgentBase(this.baseUrl)
      ? generateDedicatedTraceId()
      : null;
    const res = await this.rawRequest(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(dedicatedTraceId ? { "X-Eliza-Trace-Id": dedicatedTraceId } : {}),
          ...(turnCorrelation
            ? {
                [SHARED_TURN_CORRELATION_HEADER]: turnCorrelation,
              }
            : {}),
        },
        body: JSON.stringify({
          text,
          channelType,
          clientMessageId: resolvedClientMessageId,
          // Opt into delta framing: the server ships bare deltas + periodic
          // snapshots instead of the full text on every token (O(N) wire). Old
          // servers ignore the unknown field and keep legacy per-token fullText.
          streamProtocol: DELTA_STREAM_PROTOCOL,
          ...(images?.length ? { images } : {}),
          ...(metadata ? { metadata } : {}),
        }),
        signal,
      },
      // A non-running cloud agent 202s and auto-resumes; surface `waking` so the
      // chat shows the agent booting instead of stalled dots.
      onStatus ? { onResuming: () => onStatus({ kind: "waking" }) } : undefined,
    );

    if (!res.body) {
      throw new Error("Streaming not supported by this browser");
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    const streamState: StreamChatState = {
      deltaProtocol: true,
      fullText: "",
      doneText: null,
      doneTranscriptVisibility: undefined,
      doneAgentName: null,
      doneMessageId: null,
      doneUserMessageId: null,
      doneAssistantEphemeral: false,
      doneHistoryRefreshRequired: false,
      doneInterrupted: false,
      doneThought: null,
      doneNoResponseReason: null,
      doneUsage: undefined,
      doneFailureKind: undefined,
      doneTerminalFailure: undefined,
      doneReplyRecoveryAvailable: false,
      doneAccountConnect: undefined,
      doneLocalInference: undefined,
      doneActionResults: undefined,
      replyReadyActionsDelivered: false,
      receivedDone: false,
    };

    const notifyReplyReady = onReplyReady
      ? (actionResults: ChatActionResultSummary[]) => {
          // A buffered final frame may still be decoded after Stop. It can
          // preserve transcript text, but must not initiate a client handoff.
          if (signal?.aborted) return;
          try {
            onReplyReady(actionResults);
          } catch (err) {
            // error-policy:J4 an optional renderer handoff failed after the
            // action settled; retain terminal receipts and close the stream
            // normally instead of turning a successful effect into a retry.
            logger.warn({ err }, "[ElizaClient] reply-ready consumer failed");
          }
        }
      : undefined;

    // Contract: the API emits a terminal done/error frame and supports explicit
    // cancellation through the caller's AbortSignal. Do not infer failure from
    // wall-clock silence: local inference, tool execution, and provider streams
    // have different legitimate gaps, while server heartbeats keep the channel
    // observable.
    while (true) {
      // Client-side abort (user Stop / navigation away) must stop consuming the
      // body IMMEDIATELY — not wait for the separate server-abort POST to close
      // the stream. `rawRequestOnce`
      // detaches its request-phase abort listener the moment response headers
      // arrive, so the caller's `signal` is no longer wired to the fetch during
      // the body read; honour it here by cancelling the reader (which closes the
      // body and frees the connection) and returning whatever streamed so far as
      // an interrupted (`completed: false`) turn.
      if (signal?.aborted) {
        // error-policy:J6 best-effort reader teardown on client abort.
        void reader.cancel("elizaos-sse-client-abort").catch(() => undefined);
        break;
      }
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const readPromise = reader.read();
        // Reject the in-flight read the instant the caller aborts, so a stream
        // stalled between tokens tears down at once instead of blocking on the
        // pending read. The listener is removed when the read settles so it
        // never leaks across loop iterations.
        const abortPromise = new Promise<never>((_, reject) => {
          if (!signal) return;
          const onAbort = () => {
            const abortErr = new Error("SSE read aborted by client");
            abortErr.name = "AbortError";
            reject(abortErr);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void readPromise.finally(() =>
            signal.removeEventListener("abort", onAbort),
          );
        });
        ({ done, value } = await Promise.race([readPromise, abortPromise]));
      } catch {
        // A client abort wins over everything else: cancel the reader and stop —
        // the partial streamed so far is returned as an interrupted turn.
        if (signal?.aborted) {
          // error-policy:J6 best-effort reader teardown on client abort.
          void reader.cancel("elizaos-sse-client-abort").catch(() => undefined);
          break;
        }
        // A rejected read is a genuine transport interruption. Provider errors
        // arrive as structured SSE error frames from the server.
        // error-policy:J6 best-effort reader teardown after transport failure.
        void reader.cancel("elizaos-sse-read-failed").catch(() => undefined);
        break;
      }
      if (done || !value) break;

      buffer += decoder.decode(value, { stream: true });
      let eventBreak = findSseEventBreak(buffer);
      while (eventBreak) {
        const rawEvent = buffer.slice(0, eventBreak.index);
        buffer = buffer.slice(eventBreak.index + eventBreak.length);
        const eventLines = rawEvent.split(/\r?\n/);
        const eventName = sseEventName(eventLines);
        for (const line of eventLines) {
          if (!line.startsWith("data:")) continue;
          if (
            applyStreamChatDataLine(
              line,
              streamState,
              onToken,
              onStatus,
              onToolEvent,
              eventName,
              notifyReplyReady,
            )
          ) {
            buffer = "";
            // error-policy:J6 best-effort reader teardown after terminal done.
            void reader
              .cancel("elizaos-sse-terminal-done")
              .catch(() => undefined);
            break;
          }
        }
        if (streamState.receivedDone) break;
        eventBreak = findSseEventBreak(buffer);
      }
      if (streamState.receivedDone) break;
    }

    if (!streamState.receivedDone && buffer.trim()) {
      const trailingLines = buffer.split(/\r?\n/);
      const trailingEventName = sseEventName(trailingLines);
      for (const line of trailingLines) {
        if (line.startsWith("data:")) {
          applyStreamChatDataLine(
            line,
            streamState,
            onToken,
            onStatus,
            onToolEvent,
            trailingEventName,
            notifyReplyReady,
          );
        }
      }
    }

    const rawReplyText = streamState.doneText ?? streamState.fullText;
    const resolvedText =
      streamState.doneNoResponseReason === "ignored" ||
      (!streamState.receivedDone && rawReplyText.trim().length === 0)
        ? ""
        : this.normalizeAssistantText(rawReplyText, {
            interrupted: streamState.doneInterrupted,
          });
    return {
      text: resolvedText,
      agentName: streamState.doneAgentName ?? "Eliza",
      completed: streamState.receivedDone,
      ...(streamState.doneInterrupted ? { interrupted: true } : {}),
      ...(streamState.doneTranscriptVisibility
        ? { transcriptVisibility: streamState.doneTranscriptVisibility }
        : {}),
      ...(streamState.doneThought
        ? { reasoning: streamState.doneThought }
        : {}),
      ...(streamState.doneMessageId
        ? { messageId: streamState.doneMessageId }
        : {}),
      ...(streamState.doneUserMessageId
        ? { userMessageId: streamState.doneUserMessageId }
        : {}),
      ...(streamState.doneAssistantEphemeral
        ? { assistantEphemeral: true }
        : {}),
      ...(streamState.doneHistoryRefreshRequired
        ? { historyRefreshRequired: true }
        : {}),
      ...(streamState.doneNoResponseReason
        ? { noResponseReason: streamState.doneNoResponseReason }
        : {}),
      ...(streamState.doneUsage ? { usage: streamState.doneUsage } : {}),
      ...(streamState.doneFailureKind
        ? { failureKind: streamState.doneFailureKind }
        : {}),
      ...(streamState.doneReplyRecoveryAvailable
        ? { replyRecoveryAvailable: true }
        : {}),
      ...(streamState.doneTerminalFailure
        ? { terminalFailure: streamState.doneTerminalFailure }
        : {}),
      ...(streamState.doneAccountConnect
        ? { accountConnect: streamState.doneAccountConnect }
        : {}),
      ...(streamState.doneLocalInference
        ? { localInference: streamState.doneLocalInference }
        : {}),
      ...(streamState.doneActionResults?.length
        ? { actionResults: streamState.doneActionResults }
        : {}),
    };
  }
}
