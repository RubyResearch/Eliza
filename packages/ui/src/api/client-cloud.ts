/**
 * Cloud domain methods — cloud billing, compat agents, sandbox,
 * export/import, direct cloud auth, bug reports.
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { ElizaError } from "@elizaos/core";
import {
  clearStoredStewardToken,
  readStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  type AgentReadinessProbe,
  type AuthedAgentFetch,
  startCloudConversationHandoff,
} from "../cloud/handoff/cloud-handoff-supervisor";
import { isRetryableHandoffHttpStatus } from "../cloud/handoff/conversation-handoff";
import { getBootConfig } from "../config/boot-config";
import { isLoopbackStagingStewardDevelopment } from "../state/loopback-steward-development";
import { isTrustedCloudApiBaseUrl } from "../state/runtime-url-trust";
import {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
  isPersonalSharedElizaId,
  normalizeDirectCloudSharedAgentApiBase,
} from "../utils/cloud-agent-base";
import { ElizaClient } from "./client-base";
import type {
  ApiError,
  CloudApiKeySummary,
  CloudApiKeys,
  CloudBillingCheckoutRequest,
  CloudBillingCheckoutResponse,
  CloudBillingCryptoQuoteRequest,
  CloudBillingCryptoQuoteResponse,
  CloudBillingHistoryItem,
  CloudBillingPaymentMethod,
  CloudBillingSettings,
  CloudBillingSettingsUpdateRequest,
  CloudBillingSummary,
  CloudCompatAgent,
  CloudCompatAgentProvisionResponse,
  CloudCompatAgentStatus,
  CloudCompatDiscordConfig,
  CloudCompatJob,
  CloudCompatLaunchResult,
  CloudCompatManagedDiscordStatus,
  CloudCompatManagedGithubStatus,
  CloudCredits,
  CloudLoginPersistResponse,
  CloudLoginPollResponse,
  CloudLoginResponse,
  CloudOAuthConnection,
  CloudOAuthConnectionRole,
  CloudOAuthInitiateResponse,
  CloudStatus,
  CloudTwitterOAuthInitiateResponse,
  LocalAgentBackupMetadata,
  SandboxBrowserEndpoints,
  SandboxPlatformStatus,
  SandboxScreenshotPayload,
  SandboxScreenshotRegion,
  SandboxStartResponse,
  SandboxWindowInfo,
} from "./client-types";
import {
  confirmDedicatedActivation,
  type DedicatedActivationConfirmationRequester,
  parseDedicatedActivationConfirmationQuote,
} from "./dedicated-activation-confirmation";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import {
  DEFAULT_DIRECT_CLOUD_APP_BASE_URL,
  DEFAULT_DIRECT_CLOUD_BASE_URL,
  DIRECT_ELIZA_CLOUD_API_BY_HOST,
  resolveDirectCloudAuthApiBase,
  resolveDirectCloudWebBase,
  stripTrailingSlashes,
} from "./direct-cloud-endpoints";
import { createTimeoutSignal, isTimeoutAbortError } from "./timeout-signal";
import { fetchAgentTransport } from "./transport";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 12;
// Cloud account reads can legitimately take longer than 15 seconds on a cold
// regional worker. Keep the request bounded, but leave enough room for the
// billing/credits response the desktop dashboard depends on.
const DIRECT_CLOUD_HTTP_TIMEOUT_MS = 30_000;

type DirectCloudAgent = {
  id?: string;
  agentId?: string;
  agentName?: string;
  name?: string;
  status?: string;
  databaseStatus?: string;
  database_status?: string;
  bridgeUrl?: string | null;
  bridge_url?: string | null;
  webUiUrl?: string | null;
  web_ui_url?: string | null;
  apiBase?: string | null;
  api_base?: string | null;
  containerUrl?: string | null;
  container_url?: string | null;
  runtimeUrl?: string | null;
  runtime_url?: string | null;
  errorMessage?: string | null;
  error_message?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  lastHeartbeatAt?: string | null;
  last_heartbeat_at?: string | null;
  agentConfig?: Record<string, unknown>;
  agent_config?: Record<string, unknown>;
  executionTier?: string | null;
  execution_tier?: string | null;
};

type DirectCloudJob = {
  id?: string;
  jobId?: string;
  job_id?: string;
  type?: string;
  status?: string;
  state?: string;
  phase?: string;
  data?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: unknown;
  message?: string | null;
  reason?: string | null;
  attempts?: number;
  retryCount?: number;
  retry_count?: number;
  startedAt?: string | null;
  started_at?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  createdAt?: string;
  created_at?: string;
};

type DirectCloudAgentCreateData = {
  id: string;
  agentName: string;
  status: string;
  jobId: string | null;
  createdAt: string | null;
  executionTier: CloudAgentExecutionTier | null;
};

type CloudAgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";

interface CloudAgentDeleteCondition {
  expectedAgentName: string;
  expectedCreatedAt: string;
  expectedExecutionTier: CloudAgentExecutionTier;
}

interface CloudAgentCleanupReceipt {
  deleteCondition: CloudAgentDeleteCondition;
}

function requireConfirmedFreshCloudAgentCreate(
  forceCreate: boolean | undefined,
  created: boolean | undefined,
  source?: string,
): void {
  const freshWarmPoolSource =
    source === "warm_pool" || source === "warm_pool_recovery";
  if (forceCreate && created !== true && !freshWarmPoolSource) {
    throw new Error(
      "Eliza Cloud did not confirm that a new agent was created. No agent was opened; refresh your session and try again.",
    );
  }
}

/** Async-job envelope returned by the restart/suspend/resume lifecycle routes. */
type LifecycleResult = { jobId: string; status: string; message: string };

function isCloudRouteNotFound(error: unknown): error is ApiError {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as ApiError).status === 404
  );
}

function resolveKnownDirectCloudApiBase(baseUrl: string): string | null {
  try {
    return (
      DIRECT_ELIZA_CLOUD_API_BY_HOST.get(
        new URL(baseUrl).hostname.toLowerCase(),
      ) ?? null
    );
  } catch {
    // error-policy:J3 malformed Cloud endpoints fail closed.
    return null;
  }
}

function isDirectCloudBase(client: ElizaClient): boolean {
  const baseUrl = client.getBaseUrl().trim();
  if (!baseUrl) return false;
  return resolveKnownDirectCloudApiBase(baseUrl) !== null;
}

function isDedicatedCloudAgentClient(client: ElizaClient): boolean {
  return isDedicatedCloudAgentBase(client.getBaseUrl());
}

function resolveConfiguredDirectCloudApiBase(
  configuredCloudApiBase = getBootConfig().cloudApiBase,
): string | null {
  const configured =
    configuredCloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_BASE_URL;
  const known = resolveKnownDirectCloudApiBase(configured);
  if (known) return known;
  // Local app development intentionally points at an isolated loopback Cloud
  // worker, which is not (and must not be) present in the production hostname
  // map. Accept that explicit target only from a loopback-rendered first-party
  // shell and only when the target is loopback too.
  if (isTrustedLocalCloudPage()) {
    try {
      const parsed = new URL(configured);
      if (
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "[::1]" ||
          parsed.hostname === "::1")
      ) {
        return resolveDirectCloudAuthApiBase(configured);
      }
    } catch {
      // error-policy:J3 malformed local development targets fail closed.
    }
  }
  return null;
}

function isTrustedLocalCloudPage(): boolean {
  if (typeof window === "undefined") return false;
  const protocol = window.location.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;
  const hostname = window.location.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function resolveDedicatedCloudAgentControlPlaneApiBase(
  client: ElizaClient,
): string | null {
  if (!isDedicatedCloudAgentClient(client)) return null;
  if (typeof window !== "undefined") {
    const pageApiBase = DIRECT_ELIZA_CLOUD_API_BY_HOST.get(
      window.location.hostname.toLowerCase(),
    );
    if (pageApiBase) return pageApiBase;
  }
  // Native app shells, packaged desktop, and local app development are all
  // first-party Cloud CORS origins. They have no Cloud page hostname to map,
  // so their configured environment is the authoritative control plane.
  if (
    shouldUseNativeCloudHttp() ||
    isElectrobunRuntime() ||
    isTrustedLocalCloudPage()
  ) {
    return resolveConfiguredDirectCloudApiBase();
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = stringOrNull(value);
    if (stringValue) return stringValue;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numberValue = numberOrNull(value);
    if (numberValue !== null) return numberValue;
  }
  return null;
}

function headerNumber(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): number | null {
  if (!headers) return null;
  const raw =
    headers instanceof Headers
      ? headers.get(name)
      : Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        )?.[1];
  return numberOrNull(raw);
}

function directCloudErrorMetadata(
  body: unknown,
  headers?: Headers | Record<string, string>,
): { code?: string; retryAfter?: number } {
  const root = recordOrNull(body);
  const nestedError = recordOrNull(root?.error);
  const code = firstString(root?.code, nestedError?.code);
  const retryAfter = firstNumber(
    root?.retryAfter,
    root?.retry_after,
    nestedError?.retryAfter,
    nestedError?.retry_after,
    headerNumber(headers, "Retry-After"),
  );
  return {
    ...(code ? { code } : {}),
    ...(retryAfter !== null && retryAfter >= 0 ? { retryAfter } : {}),
  };
}

function directCloudLoginToken(data: unknown): string | null {
  const root = recordOrNull(data);
  const nested = recordOrNull(root?.data);
  // Prefer Steward/session tokens over the legacy API key field. Some Cloud
  // responses include both; using apiKey first can persist a token that lists
  // agents but fails unified agent restore/wake authorization.
  return firstString(
    root?.token,
    root?.accessToken,
    root?.stewardToken,
    root?.sessionToken,
    nested?.token,
    nested?.accessToken,
    nested?.stewardToken,
    nested?.sessionToken,
    root?.apiKey,
    nested?.apiKey,
  );
}

function directCloudLoginStringField(
  data: unknown,
  field: string,
  snakeField?: string,
): string | undefined {
  const root = recordOrNull(data);
  const nested = recordOrNull(root?.data);
  return (
    firstString(
      root?.[field],
      snakeField ? root?.[snakeField] : undefined,
      nested?.[field],
      snakeField ? nested?.[snakeField] : undefined,
    ) ?? undefined
  );
}

function normalizeCloudLoginPollStatus(
  value: unknown,
): "pending" | "authenticated" | "expired" | "error" {
  const status = stringOrNull(value)?.toLowerCase();
  if (
    status === "authenticated" ||
    status === "expired" ||
    status === "error" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
}

function errorStringOrNull(value: unknown): string | null {
  const direct = stringOrNull(value);
  if (direct) return direct;
  const record = recordOrNull(value);
  if (!record) return null;
  return firstString(record.error, record.message, record.reason);
}

function parseCloudLoginPollData(data: unknown): {
  status: "pending" | "authenticated" | "expired" | "error";
  organizationId?: string;
  token?: string;
  userId?: string;
  error?: string;
} {
  const root = recordOrNull(data);
  const nested = recordOrNull(root?.data);
  const status = normalizeCloudLoginPollStatus(
    firstString(root?.status, nested?.status),
  );
  return {
    status,
    ...(status === "authenticated"
      ? {
          token: directCloudLoginToken(data) ?? undefined,
          organizationId: directCloudLoginStringField(
            data,
            "organizationId",
            "organization_id",
          ),
          userId: directCloudLoginStringField(data, "userId", "user_id"),
        }
      : {}),
    ...(status === "error"
      ? { error: errorStringOrNull(data) ?? "Poll request failed" }
      : {}),
  };
}

const CLOUD_LOGIN_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cloudLoginSessionIdOrNull(value: unknown): string | null {
  const sessionId = stringOrNull(value);
  return sessionId && CLOUD_LOGIN_SESSION_ID_RE.test(sessionId)
    ? sessionId
    : null;
}

function createCloudLoginRequestId(): string | null {
  return cloudLoginSessionIdOrNull(globalThis.crypto?.randomUUID?.());
}

function resolveCloudCliLoginReturnUrl(sessionId: string): string | null {
  if (
    shouldUseNativeCloudHttp() ||
    isElectrobunRuntime() ||
    typeof window === "undefined"
  ) {
    return null;
  }
  try {
    const { origin, pathname, protocol, search, hash } = window.location;
    if (protocol !== "http:" && protocol !== "https:") return null;
    const path =
      pathname.startsWith("/") &&
      !pathname.startsWith("//") &&
      !pathname.startsWith("/auth/cli-login")
        ? `${pathname}${search}${hash}`
        : "/chat";
    const url = new URL(path, origin);
    url.searchParams.set("elizaCloudLogin", "complete");
    url.searchParams.set("elizaCloudLoginSession", sessionId);
    return url.toString();
  } catch {
    // error-policy:J3 a malformed app URL just falls back to the existing
    // polling/close path; the Cloud page will keep its success fallback.
    return null;
  }
}

function buildCloudCliLoginBrowserUrl(
  cloudWebBase: string,
  sessionId: string,
): string {
  const url = new URL("/auth/cli-login", cloudWebBase);
  url.searchParams.set("session", sessionId);
  const returnTo = resolveCloudCliLoginReturnUrl(sessionId);
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return url.toString();
}

function shouldUseNativeCloudHttp(): boolean {
  return Capacitor.isNativePlatform();
}

function shouldUseNativeStewardRefreshHttp(endpoint: string): boolean {
  if (!/^https?:\/\//i.test(endpoint)) return false;
  return Capacitor.isNativePlatform() || isElectrobunRuntime();
}

/**
 * True when the document is itself served from a known Eliza Cloud host, which
 * is the only place a cloud-API request can collapse to a same-origin path. The
 * cloud web host proxies `/api` to the worker; localhost dev, custom-scheme
 * WebViews, and third-party embeds do not.
 */
function isPageServedFromDirectCloudHost(): boolean {
  if (typeof window === "undefined") return false;
  return DIRECT_ELIZA_CLOUD_API_BY_HOST.has(
    window.location.hostname.toLowerCase(),
  );
}

function resolveBrowserCloudApiRequestUrl(url: string): string {
  if (shouldUseNativeCloudHttp() || typeof window === "undefined") return url;
  try {
    const parsed = new URL(url);
    if (!DIRECT_ELIZA_CLOUD_API_BY_HOST.has(parsed.hostname.toLowerCase())) {
      return url;
    }
    // Same-origin collapse is valid only for production co-hosting, where
    // cloud.eliza.app proxies `/api` to the worker. On localhost dev, including
    // shifted Vite ports such as 2160, the same path targets the local agent API
    // and trips its default-deny gate for `/api/auth/*`. Keep the absolute cloud
    // URL there; the worker CORS allowlist covers localhost ports.
    if (!isPageServedFromDirectCloudHost()) {
      return url;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // error-policy:J3 an unparseable URL is passed through unchanged — this
    // helper only rewrites known cloud hosts to same-origin paths.
    return url;
  }
}

/**
 * Fetch a direct Cloud API URL through the Electrobun desktop HTTP bridge when
 * available, bypassing the WKWebView CORS block on loopback renderer origins.
 * Falls back to a regular fetch() on web/native platforms.
 */
const directCloudAbsoluteDeadlineBySignal = new WeakMap<AbortSignal, number>();

function throwIfDirectCloudDispatchDeadlineElapsed(
  signal?: AbortSignal | null,
): void {
  if (!signal) return;
  signal.throwIfAborted();
  const deadlineMs = directCloudAbsoluteDeadlineBySignal.get(signal);
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new DOMException("The startup deadline elapsed", "TimeoutError");
  }
}

async function directCloudFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  throwIfDirectCloudDispatchDeadlineElapsed(init?.signal);
  const transport = desktopHttpTransportForUrl(url);
  if (transport) {
    return transport.request(url, init ?? {}, undefined);
  }
  return fetchAgentTransport.request(url, init ?? {}, undefined);
}

/**
 * The browser-navigable Eliza Cloud WEB base for a configured cloud base URL
 * (API hosts map to their site host; www maps to the apex). Every URL handed
 * to a browser window/tab must be built on this — never on the raw configured
 * base, which can be an API host whose JSON responses mobile browsers download
 * as files instead of rendering (#15143).
 */
export {
  resolveDirectCloudAppBase,
  resolveDirectCloudAuthApiBase,
  resolveDirectCloudWebBase,
} from "./direct-cloud-endpoints";

function resolveDirectCloudClientApiBase(client: ElizaClient): string | null {
  const baseUrl = client.getBaseUrl().trim();
  if (baseUrl && isDirectCloudBase(client)) {
    return resolveDirectCloudAuthApiBase(baseUrl);
  }
  const dedicatedControlPlaneApiBase =
    resolveDedicatedCloudAgentControlPlaneApiBase(client);
  if (dedicatedControlPlaneApiBase) return dedicatedControlPlaneApiBase;
  if (
    baseUrl &&
    isDirectCloudSharedAgentBase(baseUrl) &&
    isTrustedLocalCloudPage()
  ) {
    return resolveConfiguredDirectCloudApiBase();
  }
  // A hosted CLI return authenticates the account without replacing the local
  // runtime. Its account reads must use that session's configured control plane.
  if (
    isLoopbackStagingStewardDevelopment() &&
    (!baseUrl || isLoopbackCloudAgentBase(baseUrl)) &&
    readStoredStewardToken()?.trim()
  ) {
    return resolveConfiguredDirectCloudApiBase();
  }
  if (shouldUseNativeCloudHttp() && !baseUrl) {
    return resolveConfiguredDirectCloudApiBase();
  }
  // Web SPA served from a cloud host with no agent baseUrl yet — exactly the
  // /join flow's state (selectOrProvisionCloudAgent runs BEFORE any agent
  // connection exists). Resolve the control plane from the page host so the
  // direct /api/v1 path works. Returning null here sent these calls down the
  // agent-proxy fallback (/api/cloud/compat/*), a route only agent servers
  // mount — the cloud worker 404s it, so every web sign-in dead-ended on
  // "Couldn't connect to your agent".
  //
  // Gate this on the empty-baseUrl state ONLY. Once the client is connected to
  // a NON-cloud agent server (baseUrl = an agent URL that isn't a direct-cloud
  // base — handled above), the direct-cloud call must go to that agent, not the
  // page host. Firing this branch while connected would mis-route to the cloud
  // host and 401. See PR #11448.
  if (!baseUrl && typeof window !== "undefined") {
    const byHost = DIRECT_ELIZA_CLOUD_API_BY_HOST.get(
      window.location.hostname.toLowerCase(),
    );
    if (byHost) return byHost;
  }
  return null;
}

/** Account reads use the trusted Cloud control plane instead of the agent. */
export function hasDirectCloudAccountTransport(client: ElizaClient): boolean {
  return resolveDirectCloudClientApiBase(client) !== null;
}

/**
 * Resolve the Cloud auth bearer token. Per DECISIONS.md D3 the Cloud
 * connection is unified on Steward across every target (hosted web AND
 * native), so the Steward session JWT in `localStorage.steward_session_token`
 * is the canonical source. On web the same JWT also rides the same-origin
 * `steward-token` cookie; on native (`capacitor://localhost` / loopback) it is
 * sent as `Authorization: Bearer`.
 *
 * The Remote (device-code/pairing) flow mints its own session token via
 * `cloudLoginPollDirect` and persists it through the same steward-session store
 * (`writeStoredStewardToken`), so it resolves here through the canonical Steward
 * branch too. The client REST token is the last fallback.
 */
export function getCloudAuthToken(client?: ElizaClient): string | null {
  const stewardToken = readStoredStewardToken()?.trim();
  if (stewardToken) return stewardToken;

  const clientToken = client?.getRestAuthToken()?.trim();
  return clientToken || null;
}

async function clearStoredStewardTokenIfCurrent(token: string): Promise<void> {
  if (readStoredStewardToken()?.trim() !== token) return;
  await clearStoredStewardToken();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  }
}

function readDirectCloudToken(client: ElizaClient): string | null {
  // A managed app may be connected to a dedicated agent while rendering
  // account settings from hosted web, Capacitor, Electrobun, or localhost.
  // The agent base owns the client's REST token regardless of the page host;
  // only the independently stored Steward session may cross to the control
  // plane.
  if (isDedicatedCloudAgentClient(client)) {
    return readStoredStewardToken()?.trim() || null;
  }
  return getCloudAuthToken(client);
}

/**
 * Decode a JWT `exp` (seconds until expiry), or `null` when the token is not a
 * JWT / has no `exp`. Used by the Cloud Steward token-lifecycle refresh.
 */
export function cloudTokenSecsRemaining(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp - Date.now() / 1000;
  } catch {
    // error-policy:J3 `null` is the explicit "no decodable exp" signal
    // (opaque/device-code tokens); callers skip lifecycle refresh for it.
    return null;
  }
}

/**
 * Cookie-backed Steward session refresh, mirroring cloud-frontend's
 * `AuthTokenSync` semantics. Sends an empty POST to the Steward refresh
 * endpoint with `credentials: "include"` so the HttpOnly
 * `steward-refresh-token` cookie travels automatically (web same-origin). The
 * server rotates the session and, for trusted Cloud origins / native callers,
 * returns the short-lived access token so the SPA can refresh its localStorage
 * Bearer mirror. Returns the fresh token when one was issued, else `null`.
 *
 * On native the same endpoint is reached via the configured cloud API base
 * (Bearer-refresh); the caller passes the absolute endpoint via `endpoint`.
 */
export async function refreshCloudStewardSession(opts?: {
  endpoint?: string;
  /** Surface throttling/outage responses instead of treating them as logout. */
  throwOnTransientHttpFailure?: boolean;
}): Promise<{ token?: string; expiresAt?: number; expiresIn?: number } | null> {
  const endpoint = opts?.endpoint ?? STEWARD_REFRESH_ENDPOINT;
  if (shouldUseNativeStewardRefreshHttp(endpoint)) {
    const token = readStoredStewardToken()?.trim();
    if (!token) return null;
    const response = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url: endpoint,
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
      { method: "POST", url: endpoint },
    );
    if (response.status < 200 || response.status >= 300) {
      if (
        opts?.throwOnTransientHttpFailure &&
        (response.status === 429 || response.status >= 500)
      ) {
        throw new ElizaError(
          "Steward session refresh is temporarily unavailable",
          {
            code: "STEWARD_SESSION_REFRESH_TRANSIENT",
            context: { endpoint, status: response.status },
          },
        );
      }
      return null;
    }
    const parsed = parseDirectCloudJsonSafe(response.data) as {
      token?: string;
      expiresAt?: number;
      expiresIn?: number;
    } | null;
    if (opts?.throwOnTransientHttpFailure && !parsed?.token?.trim()) {
      // A 2xx whose body carries no usable token is out of the endpoint's
      // success contract (authoritative logout is a 401, never an empty 200):
      // treat it as an outage artifact, not a signed-out state.
      throw new ElizaError(
        "Steward session refresh returned a success response without a token",
        {
          code: "STEWARD_SESSION_REFRESH_TRANSIENT",
          context: { endpoint, status: response.status },
        },
      );
    }
    return parsed;
  }

  if (typeof fetch === "undefined") return null;
  // Cloud account reads can legitimately take longer than 15 seconds on a cold
  // regional worker. Keep the request bounded at DIRECT_CLOUD_HTTP_TIMEOUT_MS,
  // but use the portable helper — `AbortSignal.timeout` is missing on iOS
  // 16.0-16.3 WKWebView and would throw TypeError before fetch is issued.
  const { signal: stewardSignal, dispose: disposeStewardSignal } =
    createTimeoutSignal(DIRECT_CLOUD_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      // This is a cookie-authenticated mutation. Match the canonical Cloud
      // login helper: a custom non-simple marker lets the Worker reject
      // cross-site form POSTs without exposing the host-only refresh cookie to
      // JavaScript. The body remains empty and the cookie remains browser-only.
      headers: {
        "Content-Type": "application/json",
        "X-Eliza-CSRF": "1",
      },
      signal: stewardSignal,
    });
    if (!response.ok) {
      if (
        opts?.throwOnTransientHttpFailure &&
        (response.status === 429 || response.status >= 500)
      ) {
        throw new ElizaError(
          "Steward session refresh is temporarily unavailable",
          {
            code: "STEWARD_SESSION_REFRESH_TRANSIENT",
            context: { endpoint, status: response.status },
          },
        );
      }
      return null;
    }
    // Keep the timeout signal alive through the body stream — headers may
    // arrive quickly while `response.json()` stalls indefinitely, so the
    // timeout must abort the body read too.
    // error-policy:J3 an unparseable refresh body reads as "no refreshed
    // session" (null) — callers keep/drop the stored token by its own expiry.
    // Timeout aborts rethrow so the boundary catch below maps them.
    const parsed = (await response.json().catch((err: unknown) => {
      if (isTimeoutAbortError(err)) throw err;
      return null;
    })) as {
      token?: string;
      expiresAt?: number;
      expiresIn?: number;
    } | null;
    if (opts?.throwOnTransientHttpFailure && !parsed?.token?.trim()) {
      // A 2xx whose body carries no usable token is out of the endpoint's
      // success contract (authoritative logout is a 401, never an empty 200):
      // treat it as an outage artifact so cookie-only recovery preserves the
      // shared-agent binding instead of tearing it down.
      throw new ElizaError(
        "Steward session refresh returned a success response without a token",
        {
          code: "STEWARD_SESSION_REFRESH_TRANSIENT",
          context: { endpoint, status: response.status },
        },
      );
    }
    return parsed;
  } catch (err) {
    // error-policy:J2 a timeout abort becomes the typed transient-refresh
    // error in throwOnTransient mode; otherwise it fails closed to null,
    // matching every other refresh failure on this endpoint. Non-abort
    // errors rethrow untouched.
    if (isTimeoutAbortError(err)) {
      if (opts?.throwOnTransientHttpFailure) {
        throw new ElizaError("Steward session refresh timed out", {
          code: "STEWARD_SESSION_REFRESH_TRANSIENT",
          context: { endpoint },
          cause: err,
        });
      }
      return null;
    }
    throw err;
  } finally {
    disposeStewardSignal();
  }
}

function isDirectCloudAuthMissing(client: ElizaClient): boolean {
  const directApiBase = resolveDirectCloudClientApiBase(client);
  const dedicatedControlPlaneRequired =
    isDedicatedCloudAgentClient(client) &&
    (shouldUseNativeCloudHttp() ||
      isElectrobunRuntime() ||
      isTrustedLocalCloudPage() ||
      isPageServedFromDirectCloudHost());
  return (
    (dedicatedControlPlaneRequired && !directApiBase) ||
    ((shouldUseNativeCloudHttp() ||
      Boolean(resolveDedicatedCloudAgentControlPlaneApiBase(client))) &&
      !readDirectCloudToken(client))
  );
}

function directCloudAuthMissingMessage(): string {
  return "Eliza Cloud login session is missing. Sign in again.";
}

function parseDirectCloudJson(data: unknown): unknown {
  if (typeof data !== "string") return data;
  if (!data.trim()) return {};
  return JSON.parse(data);
}

function parseDirectCloudJsonSafe(data: unknown): unknown {
  try {
    return parseDirectCloudJson(data);
  } catch {
    // error-policy:J3 non-JSON bodies (HTML error pages, plain text) are
    // returned raw so directCloudResponseText can quote them in the error.
    return data;
  }
}

function directCloudResponseText(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function directCloudBodyData(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

async function withDirectCloudHttpTimeout<T>(
  request: Promise<T>,
  args: { method: string; url: string },
  signal?: AbortSignal,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Eliza Cloud request timed out after ${Math.round(
            DIRECT_CLOUD_HTTP_TIMEOUT_MS / 1000,
          )}s (${args.method} ${args.url})`,
        ),
      );
    }, DIRECT_CLOUD_HTTP_TIMEOUT_MS);
  });
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        const rejectWithReason = () =>
          reject(
            signal.reason ??
              new DOMException("The request was aborted", "AbortError"),
          );
        if (signal.aborted) rejectWithReason();
        else {
          abortListener = rejectWithReason;
          signal.addEventListener("abort", abortListener, { once: true });
        }
      })
    : null;

  try {
    return await Promise.race(
      aborted ? [request, timeout, aborted] : [request, timeout],
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function fetchDirectCloudWithTimeout<T>(
  url: string,
  init: RequestInit,
  args: { method: string; url: string },
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const absoluteDeadlineMs = init.signal
    ? directCloudAbsoluteDeadlineBySignal.get(init.signal)
    : undefined;
  if (absoluteDeadlineMs !== undefined) {
    directCloudAbsoluteDeadlineBySignal.set(
      controller.signal,
      absoluteDeadlineMs,
    );
  }
  let abortListener: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (init.signal) {
    init.signal.throwIfAborted();
    abortListener = () => controller.abort(init.signal?.reason);
    init.signal.addEventListener("abort", abortListener, { once: true });
  }

  timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The request timed out", "TimeoutError"));
  }, DIRECT_CLOUD_HTTP_TIMEOUT_MS);

  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectWithReason = () =>
      reject(
        controller.signal.reason ??
          new DOMException("The request was aborted", "AbortError"),
      );
    if (controller.signal.aborted) rejectWithReason();
    else
      controller.signal.addEventListener("abort", rejectWithReason, {
        once: true,
      });
  });
  let response: Response | undefined;

  try {
    response = await Promise.race([
      directCloudFetch(url, { ...init, signal: controller.signal }),
      aborted,
    ]);
    // Keep the same request deadline alive until the body is fully consumed.
    // A 200 response whose headers arrive before its body must not strand the
    // Personal/Dedicated conductor indefinitely.
    return await Promise.race([consume(response), aborted]);
  } catch (err) {
    const responseMetadata = response
      ? {
          status: response.status,
          url: args.url,
          headers: response.headers,
          ...directCloudErrorMetadata(undefined, response.headers),
        }
      : {};
    if (timedOut) {
      throw Object.assign(
        new Error(
          `Eliza Cloud request timed out after ${Math.round(
            DIRECT_CLOUD_HTTP_TIMEOUT_MS / 1000,
          )}s (${args.method} ${args.url})`,
          { cause: controller.signal.reason },
        ),
        responseMetadata,
      );
    }
    if (response && !controller.signal.aborted) {
      throw Object.assign(
        new Error(
          `Eliza Cloud response body could not be read (${args.method} ${args.url})`,
          { cause: err },
        ),
        responseMetadata,
      );
    }
    throw err;
  } finally {
    directCloudAbsoluteDeadlineBySignal.delete(controller.signal);
    if (timeoutId) clearTimeout(timeoutId);
    if (init.signal && abortListener) {
      init.signal.removeEventListener("abort", abortListener);
    }
  }
}

async function directCloudJsonResponse<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T; text: string }> {
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });

  if (shouldUseNativeCloudHttp()) {
    // The native transport cannot consume an AbortSignal itself. Refuse a
    // request whose caller-owned deadline has already elapsed before invoking
    // CapacitorHttp; withDirectCloudHttpTimeout then bounds any in-flight
    // request by the earlier of its 30s HTTP limit and that caller signal.
    const data = directCloudBodyData(init?.body);
    throwIfDirectCloudDispatchDeadlineElapsed(init?.signal);
    const res = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url,
        method,
        headers,
        ...(data !== undefined ? { data } : {}),
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
      { method, url },
      init?.signal ?? undefined,
    );
    const parsed = parseDirectCloudJsonSafe(res.data) as T;
    return {
      ok: isAcceptableDirectCloudResponse(res.status, parsed),
      status: res.status,
      data: parsed,
      text: directCloudResponseText(res.data),
    };
  }

  const requestUrl = resolveBrowserCloudApiRequestUrl(url);
  const { res, text } = await fetchDirectCloudWithTimeout(
    requestUrl,
    { ...init, method, headers },
    { method, url },
    async (res) => ({
      res,
      // An authoritative auth rejection is complete in its status line. Do
      // not let a malformed, rejecting, or indefinitely stalled error body
      // turn it into a transient transport failure and retain a dead token.
      text: res.status === 401 || res.status === 403 ? "" : await res.text(),
    }),
  );
  const parsed = parseDirectCloudJsonSafe(text) as T;
  return {
    ok: isAcceptableDirectCloudResponse(res.status, parsed),
    status: res.status,
    data: parsed,
    text,
  };
}

function directCloudResponseErrorMessage(
  status: number,
  body: unknown,
): string {
  let detail: string | null = null;
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const candidate = record.error ?? record.message ?? record.reason;
    if (typeof candidate === "string" && candidate.trim()) {
      detail = candidate.trim();
    }
  } else if (typeof body === "string" && body.trim()) {
    detail = body.trim();
  }
  return detail
    ? `Cloud request failed (${status}): ${detail}`
    : `Cloud request failed (${status})`;
}

export interface DirectCloudSessionVerification {
  credits: CloudCredits | null;
  status: CloudStatus;
}

/**
 * Verify a Steward session against an explicit Cloud control-plane authority.
 *
 * Dedicated Android builds keep the app client pinned to their remote agent,
 * so account verification must not temporarily repoint that client or reuse its
 * agent bearer. This narrow request boundary resolves only a known Cloud API
 * environment (or first-party loopback development), and sends only the
 * caller-provided Steward token to the account + credits endpoints.
 */
export async function verifyDirectCloudStewardSession(options: {
  cloudApiBase: string;
  stewardToken: string;
}): Promise<DirectCloudSessionVerification> {
  const stewardToken = options.stewardToken.trim();
  const apiBase = resolveConfiguredDirectCloudApiBase(options.cloudApiBase);
  if (!apiBase) {
    throw new Error("Eliza Cloud control-plane authority is not trusted");
  }
  if (!stewardToken) {
    return {
      credits: null,
      status: {
        connected: false,
        enabled: true,
        hasApiKey: false,
        reason: "not-authenticated",
        topUpUrl: directTopUpUrl(),
      },
    };
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${stewardToken}`,
  };
  const rejected = async (): Promise<DirectCloudSessionVerification> => {
    await clearStoredStewardTokenIfCurrent(stewardToken);
    return {
      credits: null,
      status: {
        connected: false,
        enabled: true,
        hasApiKey: true,
        reason: "auth-rejected",
        topUpUrl: directTopUpUrl(),
      },
    };
  };

  const userResponse = await directCloudJsonResponse<Record<string, unknown>>(
    `${apiBase}/api/v1/user`,
    { headers },
  );
  if (userResponse.status === 401 || userResponse.status === 403) {
    return rejected();
  }
  if (!userResponse.ok) {
    throw Object.assign(
      new Error(
        directCloudResponseErrorMessage(userResponse.status, userResponse.data),
      ),
      { status: userResponse.status, url: `${apiBase}/api/v1/user` },
    );
  }
  const userEnvelope = recordOrNull(userResponse.data);
  const user = recordOrNull(userEnvelope?.data) ?? userEnvelope;
  if (!user || !stringOrNull(user.id)) {
    throw new Error(
      "Eliza Cloud session verification returned an invalid user response",
    );
  }

  const creditsResponse = await directCloudJsonResponse<
    Record<string, unknown>
  >(`${apiBase}/api/v1/credits/balance`, { headers });
  if (creditsResponse.status === 401 || creditsResponse.status === 403) {
    return rejected();
  }
  if (!creditsResponse.ok) {
    throw Object.assign(
      new Error(
        directCloudResponseErrorMessage(
          creditsResponse.status,
          creditsResponse.data,
        ),
      ),
      {
        status: creditsResponse.status,
        url: `${apiBase}/api/v1/credits/balance`,
      },
    );
  }

  const creditsData = recordOrNull(creditsResponse.data);
  if (!creditsData) {
    throw new Error(
      "Eliza Cloud session verification returned an invalid credits response",
    );
  }
  const balance = numberOrNull(creditsData?.balance);
  return {
    credits: {
      balance: Number.isFinite(balance) ? balance : null,
      connected: true,
      critical: typeof balance === "number" ? balance < 0.5 : undefined,
      low: typeof balance === "number" ? balance < 2 : undefined,
      topUpUrl: directTopUpUrl(),
    },
    status: {
      connected: true,
      enabled: true,
      hasApiKey: true,
      cloudVoiceProxyAvailable: true,
      organizationId: stringOrNull(user?.organization_id) ?? undefined,
      topUpUrl: directTopUpUrl(),
      userId: stringOrNull(user?.id) ?? undefined,
    },
  };
}

async function directCloudRequest<T>(
  client: ElizaClient,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const apiBase = resolveDirectCloudClientApiBase(client);
  if (!apiBase) return null;

  const token = readDirectCloudToken(client);
  if (!token) return null;

  const url = `${apiBase}${path}`;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });

  if (shouldUseNativeCloudHttp()) {
    const data = directCloudBodyData(init?.body);
    const res = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url,
        method,
        headers,
        ...(data !== undefined ? { data } : {}),
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
      { method, url },
    );
    if (res.status === 401) {
      await clearStoredStewardTokenIfCurrent(token);
    }
    const parsed = parseDirectCloudJson(res.data) as T;
    if (!isAcceptableDirectCloudResponse(res.status, parsed)) {
      throw Object.assign(
        new Error(directCloudResponseErrorMessage(res.status, parsed)),
        {
          status: res.status,
          data: res.data,
          url,
          ...directCloudErrorMetadata(parsed, res.headers),
        },
      );
    }
    return parsed;
  }

  const requestUrl = resolveBrowserCloudApiRequestUrl(url);
  const { res, text } = await fetchDirectCloudWithTimeout(
    requestUrl,
    { ...init, method, headers },
    { method, url },
    async (res) => ({
      res,
      // directCloudRequest clears only an authoritative 401. Its body is not
      // needed for that decision and must not be able to mask the status.
      text: res.status === 401 ? "" : await res.text(),
    }),
  );
  if (res.status === 401) {
    await clearStoredStewardTokenIfCurrent(token);
  }
  const data = parseDirectCloudJsonSafe(text);
  if (!isAcceptableDirectCloudResponse(res.status, data)) {
    throw Object.assign(
      new Error(directCloudResponseErrorMessage(res.status, data)),
      {
        status: res.status,
        data,
        url,
        ...directCloudErrorMetadata(data, res.headers),
      },
    );
  }
  return data as T;
}

/**
 * Eliza Cloud can report an idempotent provisioning resume as HTTP 409 while
 * returning a successful envelope with a useful jobId. The legacy strict-2xx
 * check threw on that body and stranded callers like `provisionAndConnect`
 * mid-await with no jobId, surfacing as an "infinite Starting provisioning..."
 * UI hang. Keep that specific resume shape acceptable without treating every
 * non-2xx `{ success: true }` body as healthy.
 */
function isAcceptableDirectCloudResponse(
  status: number,
  body: unknown,
): boolean {
  if (status >= 200 && status < 300) return true;
  if (status !== 409) return false;
  if (typeof body !== "object" || body === null) return false;
  const response = body as {
    alreadyInProgress?: unknown;
    data?: { jobId?: unknown };
    jobId?: unknown;
    success?: unknown;
  };
  return (
    response.success === true &&
    response.alreadyInProgress === true &&
    (typeof response.jobId === "string" ||
      typeof response.data?.jobId === "string")
  );
}

function isDirectCloudAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    ((err as { status?: unknown }).status === 401 ||
      (err as { status?: unknown }).status === 403)
  );
}

function directTopUpUrl(): string {
  return `${DEFAULT_DIRECT_CLOUD_APP_BASE_URL}/cloud/billing`;
}

function requireString(value: unknown, fieldName: string): string {
  const parsed = stringOrNull(value);
  if (!parsed) throw new Error(`Eliza Cloud response missing ${fieldName}`);
  return parsed;
}

function parseDirectCloudAgentCreateData(
  value: unknown,
  fallbackAgentName: string,
): DirectCloudAgentCreateData {
  const data = recordOrNull(value);
  if (!data) throw new Error("Eliza Cloud response missing data");
  const job = recordOrNull(data.job);
  return {
    // The cloud create response carries the new agent's id under `id` in most
    // branches but only `agentId` in the async-provisioning (202) branch.
    // Accept either — both are `agent.id` — so a provisioning agent (the common
    // new-user path) doesn't crash onboarding against an un-redeployed worker.
    id: requireString(data.id ?? data.agentId, "data.id"),
    agentName: stringOrNull(data.agentName) ?? fallbackAgentName,
    status: stringOrNull(data.status) ?? "pending",
    // The async-provisioning branch also answers with the canonical job id.
    // It must survive normalization so the caller can follow the job to a
    // terminal state instead of inferring progress from agent-detail polling.
    jobId:
      firstString(data.jobId, data.job_id, job?.jobId, job?.job_id, job?.id) ??
      null,
    createdAt: firstString(data.createdAt, data.created_at),
    executionTier: parseCloudAgentExecutionTier(
      firstString(data.executionTier, data.execution_tier),
    ),
  };
}

function parseCloudAgentExecutionTier(
  value: string | null,
): CloudAgentExecutionTier | null {
  switch (value) {
    case "shared":
    case "dedicated-lazy":
    case "dedicated-always":
    case "custom":
      return value;
    default:
      return null;
  }
}

function toCloudCompatAgent(input: DirectCloudAgent): CloudCompatAgent {
  const id = stringOrNull(input.agentId) ?? requireString(input.id, "agent id");
  const agentName =
    stringOrNull(input.agentName) ?? stringOrNull(input.name) ?? id;
  const bridgeUrl = input.bridgeUrl ?? input.bridge_url ?? null;
  const webUiUrl = input.webUiUrl ?? input.web_ui_url ?? null;
  const runtimeUrl =
    input.apiBase ??
    input.api_base ??
    input.containerUrl ??
    input.container_url ??
    input.runtimeUrl ??
    input.runtime_url ??
    bridgeUrl ??
    "";
  const createdAt =
    stringOrNull(input.createdAt) ??
    stringOrNull(input.created_at) ??
    new Date(0).toISOString();
  const updatedAt =
    stringOrNull(input.updatedAt) ??
    stringOrNull(input.updated_at) ??
    createdAt;

  return {
    agent_id: id,
    agent_name: agentName,
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: bridgeUrl,
    web_ui_url: webUiUrl,
    status: stringOrNull(input.status) ?? "unknown",
    agent_config: input.agentConfig ?? input.agent_config ?? {},
    created_at: createdAt,
    updated_at: updatedAt,
    containerUrl: runtimeUrl,
    webUiUrl,
    database_status:
      stringOrNull(input.databaseStatus) ??
      stringOrNull(input.database_status) ??
      "unknown",
    error_message: input.errorMessage ?? input.error_message ?? null,
    last_heartbeat_at: input.lastHeartbeatAt ?? input.last_heartbeat_at ?? null,
    execution_tier:
      stringOrNull(input.executionTier) ??
      stringOrNull(input.execution_tier) ??
      null,
  };
}

function normalizeCloudCompatProvisionResponse(
  input: CloudCompatAgentProvisionResponse,
  agentId: string,
): CloudCompatAgentProvisionResponse {
  const root = recordOrNull(input) ?? {};
  const rawData = recordOrNull(root.data) ?? {};
  const rawJob = recordOrNull(rawData.job) ?? recordOrNull(root.job) ?? {};
  const rawPolling = recordOrNull(root.polling) ?? {};

  const explicitJobId = firstString(
    rawData.jobId,
    rawData.job_id,
    rawJob.jobId,
    rawJob.job_id,
    rawJob.id,
    root.jobId,
    root.job_id,
  );
  const fallbackJobId = firstString(rawData.id, root.id);
  const jobId =
    explicitJobId ?? (fallbackJobId !== agentId ? fallbackJobId : null);
  const normalizedAgentId =
    firstString(
      rawData.agentId,
      rawData.agent_id,
      root.agentId,
      root.agent_id,
    ) ?? agentId;
  const status = firstString(
    rawData.status,
    rawData.state,
    rawData.phase,
    rawJob.status,
    rawJob.state,
    root.status,
    root.state,
    root.phase,
  );
  const bridgeUrl = firstString(
    rawData.bridgeUrl,
    rawData.bridge_url,
    rawData.runtimeUrl,
    rawData.runtime_url,
    root.bridgeUrl,
    root.bridge_url,
    root.runtimeUrl,
    root.runtime_url,
  );
  const webUiUrl = firstString(
    rawData.webUiUrl,
    rawData.web_ui_url,
    root.webUiUrl,
    root.web_ui_url,
  );
  const healthUrl = firstString(
    rawData.healthUrl,
    rawData.health_url,
    root.healthUrl,
    root.health_url,
  );
  const estimatedCompletionAt = firstString(
    rawData.estimatedCompletionAt,
    rawData.estimated_completion_at,
    root.estimatedCompletionAt,
    root.estimated_completion_at,
  );

  const normalizedData: NonNullable<CloudCompatAgentProvisionResponse["data"]> =
    {
      ...(rawData as NonNullable<CloudCompatAgentProvisionResponse["data"]>),
      agentId: normalizedAgentId,
    };
  if (jobId) normalizedData.jobId = jobId;
  if (status) normalizedData.status = status;
  if (bridgeUrl) normalizedData.bridgeUrl = bridgeUrl;
  if (webUiUrl) normalizedData.webUiUrl = webUiUrl;
  if (healthUrl) normalizedData.healthUrl = healthUrl;
  if (estimatedCompletionAt) {
    normalizedData.estimatedCompletionAt = estimatedCompletionAt;
  }

  const intervalMs = firstNumber(
    rawPolling.intervalMs,
    rawPolling.interval_ms,
    root.pollIntervalMs,
    root.poll_interval_ms,
  );
  const expectedDurationMs = firstNumber(
    rawPolling.expectedDurationMs,
    rawPolling.expected_duration_ms,
    root.expectedDurationMs,
    root.expected_duration_ms,
  );
  const endpoint = firstString(
    rawPolling.endpoint,
    root.pollingEndpoint,
    root.polling_endpoint,
  );
  const polling =
    endpoint || intervalMs !== null || expectedDurationMs !== null
      ? {
          ...(input.polling ?? {}),
          ...(endpoint ? { endpoint } : {}),
          ...(intervalMs !== null ? { intervalMs } : {}),
          ...(expectedDurationMs !== null ? { expectedDurationMs } : {}),
        }
      : input.polling;
  const explicitError = firstString(root.error, rawData.error);
  const success =
    typeof root.success === "boolean"
      ? root.success
      : !explicitError && Boolean(jobId || bridgeUrl || webUiUrl || status);

  return {
    ...input,
    success,
    ...(explicitError && !input.error ? { error: explicitError } : {}),
    data: normalizedData,
    ...(polling ? { polling } : {}),
  };
}

function normalizeCloudJobStatus(value: unknown): CloudCompatJob["status"] {
  switch (stringOrNull(value)?.toLowerCase()) {
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    case "done":
      return "completed";
    case "failed":
    case "failure":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    case "retrying":
    case "retry":
      return "retrying";
    case "in_progress":
    case "processing":
    case "provisioning":
    case "running":
    case "starting":
      return "processing";
    default:
      return "queued";
  }
}

function toCloudCompatJob(input: DirectCloudJob): CloudCompatJob {
  const data = recordOrNull(input.data) ?? {};
  const result = recordOrNull(input.result) ?? recordOrNull(data.result);
  const originalStatus = firstString(
    input.status,
    input.state,
    input.phase,
    data.status,
    data.state,
    data.phase,
  );
  const status = normalizeCloudJobStatus(originalStatus);
  const id = requireString(
    firstString(input.id, input.jobId, input.job_id, data.id),
    "job id",
  );
  const type = firstString(input.type, data.type) ?? "agent_provision";
  const createdAt =
    firstString(
      input.createdAt,
      input.created_at,
      data.createdAt,
      data.created_at,
    ) ?? new Date(0).toISOString();
  const startedAt =
    firstString(
      input.startedAt,
      input.started_at,
      data.startedAt,
      data.started_at,
    ) ?? null;
  const completedAt =
    firstString(
      input.completedAt,
      input.completed_at,
      data.completedAt,
      data.completed_at,
    ) ?? null;
  const retryCount =
    firstNumber(
      input.retryCount,
      input.retry_count,
      input.attempts,
      data.retryCount,
    ) ?? 0;
  const error =
    errorStringOrNull(input.error) ??
    errorStringOrNull(data.error) ??
    firstString(input.message, input.reason, data.message, data.reason);

  return {
    jobId: id,
    type,
    status,
    data,
    result: result ?? null,
    error,
    createdAt,
    startedAt,
    completedAt,
    retryCount,
    id,
    name: type,
    state: originalStatus ?? status,
    created_on: createdAt,
    completed_on: completedAt,
  };
}

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    getCloudStatus(): Promise<CloudStatus>;
    getCloudCredits(): Promise<CloudCredits>;
    listCloudApiKeys(): Promise<CloudApiKeys>;
    getCloudBillingSummary(): Promise<CloudBillingSummary>;
    getCloudBillingSettings(): Promise<CloudBillingSettings>;
    updateCloudBillingSettings(
      request: CloudBillingSettingsUpdateRequest,
    ): Promise<CloudBillingSettings>;
    getCloudBillingPaymentMethods(): Promise<{
      success?: boolean;
      data?: CloudBillingPaymentMethod[];
      items?: CloudBillingPaymentMethod[];
      paymentMethods?: CloudBillingPaymentMethod[];
      [key: string]: unknown;
    }>;
    getCloudBillingHistory(): Promise<{
      success?: boolean;
      data?: CloudBillingHistoryItem[];
      items?: CloudBillingHistoryItem[];
      history?: CloudBillingHistoryItem[];
      [key: string]: unknown;
    }>;
    createCloudBillingCheckout(
      request: CloudBillingCheckoutRequest,
    ): Promise<CloudBillingCheckoutResponse>;
    createCloudBillingCryptoQuote(
      request: CloudBillingCryptoQuoteRequest,
    ): Promise<CloudBillingCryptoQuoteResponse>;
    cloudLogin(): Promise<CloudLoginResponse>;
    cloudLoginPoll(sessionId: string): Promise<CloudLoginPollResponse>;
    cloudLoginPersist(
      apiKey: string,
      identity?: { organizationId?: string; userId?: string },
    ): Promise<CloudLoginPersistResponse>;
    cloudDisconnect(): Promise<{ ok: boolean }>;
    getCloudCompatAgents(): Promise<{
      success: boolean;
      data: CloudCompatAgent[];
      error?: string;
    }>;
    createCloudCompatAgent(opts: {
      agentName: string;
      agentConfig?: Record<string, unknown>;
      environmentVars?: Record<string, string>;
      /**
       * Phase-0 tier flip. When true, omit `alwaysOn` so the backend derives a
       * SHARED (container-free, instant) agent instead of a DEDICATED always-on
       * one. Default (undefined/false) keeps the dedicated request unchanged.
       */
      preferSharedTier?: boolean;
      /**
       * Bypass the backend's org-scoped reuse guard so a SEPARATE agent is
       * minted even when the org already has a live one. The shared→dedicated
       * handoff sets this for the dedicated migration target; without it the
       * reuse guard hands back the shared bridge (dedicatedId === sharedId) and
       * the handoff probe never resolves. Default (undefined/false) leaves the
       * request byte-identical — every existing caller still reuses.
       */
      forceCreate?: boolean;
    }): Promise<{
      success: boolean;
      /**
       * Whether the backend actually MINTED a fresh agent (201/202) versus
       * handing back an existing non-terminal one via the idempotent reuse
       * guard (200, `created: false`) when `forceCreate` is omitted. A forced
       * request is quota-checked instead and must never reuse an existing row.
       * Warm-pool branches confirm freshness through their source marker and
       * are normalized to `true`; undefined otherwise means unknown.
       */
      created?: boolean;
      data: {
        agentId: string;
        agentName: string;
        jobId: string;
        status: string;
        nodeId: string | null;
        message: string;
        /** Authoritative create identity used only for conditional compensation. */
        createdAt: string | null;
        executionTier: CloudAgentExecutionTier | null;
      };
    }>;
    ensureCloudCompatManagedDiscordAgent(): Promise<{
      success: boolean;
      data: {
        agent: CloudCompatAgent;
        created: boolean;
      };
    }>;
    provisionCloudCompatAgent(
      agentId: string,
    ): Promise<CloudCompatAgentProvisionResponse>;
    getCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatAgent;
      error?: string;
    }>;
    getCloudCompatAgentManagedDiscord(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedDiscordStatus;
    }>;
    createCloudCompatAgentManagedDiscordOauth(
      agentId: string,
      request?: {
        returnUrl?: string;
        botNickname?: string;
      },
    ): Promise<{
      success: boolean;
      data: {
        authorizeUrl: string;
        applicationId: string | null;
      };
    }>;
    disconnectCloudCompatAgentManagedDiscord(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedDiscordStatus;
    }>;
    getCloudCompatAgentDiscordConfig(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatDiscordConfig;
    }>;
    updateCloudCompatAgentDiscordConfig(
      agentId: string,
      config: CloudCompatDiscordConfig,
    ): Promise<{
      success: boolean;
      data: CloudCompatDiscordConfig;
    }>;
    getCloudCompatAgentManagedGithub(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    createCloudCompatAgentManagedGithubOauth(
      agentId: string,
      request?: {
        scopes?: string[];
        postMessage?: boolean;
        returnUrl?: string;
      },
    ): Promise<{
      success: boolean;
      data: {
        authorizeUrl: string;
      };
    }>;
    linkCloudCompatAgentManagedGithub(
      agentId: string,
      connectionId: string,
    ): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    disconnectCloudCompatAgentManagedGithub(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    listCloudOauthConnections(args?: {
      platform?: string;
      connectionRole?: CloudOAuthConnectionRole;
    }): Promise<{
      connections: CloudOAuthConnection[];
    }>;
    initiateCloudOauth(
      platform: string,
      request?: {
        redirectUrl?: string;
        scopes?: string[];
        connectionRole?: CloudOAuthConnectionRole;
      },
    ): Promise<CloudOAuthInitiateResponse>;
    initiateCloudTwitterOauth(request?: {
      redirectUrl?: string;
      connectionRole?: CloudOAuthConnectionRole;
    }): Promise<CloudTwitterOAuthInitiateResponse>;
    disconnectCloudOauthConnection(connectionId: string): Promise<{
      success?: boolean;
      error?: string;
      [key: string]: unknown;
    }>;
    getCloudCompatAgentGithubToken(agentId: string): Promise<{
      success: boolean;
      data: {
        accessToken: string;
        githubUsername: string;
      };
    }>;
    deleteCloudCompatAgent(
      agentId: string,
      condition?: CloudAgentDeleteCondition,
    ): Promise<{
      success: boolean;
      error?: string;
      data: { jobId: string; status: string; message: string };
    }>;
    /**
     * Edit a cloud agent in place — rename and/or update its config
     * (e.g. system prompt / bio). Backed by `PATCH /api/v1/eliza/agents/:id`.
     */
    updateCloudCompatAgent(
      agentId: string,
      edit: { agentName?: string; agentConfig?: Record<string, unknown> },
    ): Promise<{
      success: boolean;
      error?: string;
      data: { agentId: string; agentName: string };
    }>;
    getCloudCompatAgentStatus(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatAgentStatus;
    }>;
    getCloudCompatAgentLogs(
      agentId: string,
      tail?: number,
    ): Promise<{ success: boolean; data: string }>;
    restartCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: { jobId: string; status: string; message: string };
    }>;
    suspendCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: { jobId: string; status: string; message: string };
    }>;
    resumeCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: { jobId: string; status: string; message: string };
    }>;
    launchCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data?: CloudCompatLaunchResult;
      error?: string;
    }>;
    getCloudCompatAvailability(): Promise<{
      success: boolean;
      data: {
        totalSlots: number;
        usedSlots: number;
        availableSlots: number;
        acceptingNewAgents: boolean;
      };
    }>;
    getCloudCompatJobStatus(jobId: string): Promise<{
      success: boolean;
      data: CloudCompatJob;
      error?: string;
    }>;
    exportAgent(password: string, includeLogs?: boolean): Promise<Response>;
    getExportEstimate(): Promise<{
      estimatedBytes: number;
      memoriesCount: number;
      entitiesCount: number;
      roomsCount: number;
      worldsCount: number;
      tasksCount: number;
    }>;
    importAgent(
      password: string,
      fileBuffer: ArrayBuffer,
    ): Promise<{
      success: boolean;
      agentId: string;
      agentName: string;
      counts: Record<string, number>;
    }>;
    listLocalAgentBackups(): Promise<LocalAgentBackupMetadata[]>;
    createLocalAgentBackup(): Promise<LocalAgentBackupMetadata>;
    restoreLocalAgentBackup(fileName: string): Promise<{
      restored: true;
      requiresRestart: true;
    }>;
    getSandboxPlatform(): Promise<SandboxPlatformStatus>;
    getSandboxBrowser(): Promise<SandboxBrowserEndpoints>;
    getSandboxScreenshot(
      region?: SandboxScreenshotRegion,
    ): Promise<SandboxScreenshotPayload>;
    getSandboxWindows(): Promise<{
      windows: SandboxWindowInfo[];
      error?: string;
    }>;
    startDocker(): Promise<SandboxStartResponse>;
    cloudLoginDirect(cloudApiBase: string): Promise<{
      ok: boolean;
      apiBase?: string;
      browserUrl?: string;
      sessionId?: string;
      error?: string;
    }>;
    cloudLoginPollDirect(
      cloudApiBase: string,
      sessionId: string,
    ): Promise<{
      status: "pending" | "authenticated" | "expired" | "error";
      organizationId?: string;
      token?: string;
      userId?: string;
      error?: string;
    }>;
    provisionCloudSandbox(options: {
      cloudApiBase: string;
      authToken: string;
      name: string;
      bio?: string[];
      onProgress?: (status: string, detail?: string) => void;
      allowSharedRuntime?: boolean;
    }): Promise<{
      bridgeUrl: string;
      agentId: string;
      webUiUrl?: string | null;
      executionTier?: string;
    }>;
    /** Resolve the signed-in account's rowless personal Shared Eliza. */
    getPersonalSharedEliza(options: {
      cloudApiBase: string;
      authToken: string;
      signal?: AbortSignal;
    }): Promise<{
      /** Stable account-native identity; never changes when hosting tier changes. */
      personalElizaId: string;
      /** Backward-compatible logical identity alias used by join callers. */
      agentId: string;
      /** Runtime currently serving the logical identity. */
      activeAgentId: string;
      agentName: string;
      apiBase: string;
      runtime: "shared" | "dedicated";
    }>;
    /**
     * Resolve the signed-in account's stable personal identity and guarantee
     * that Dedicated compute is active before returning. When Shared is still
     * authoritative, this activates the single-flight Dedicated target and
     * completes the server-owned history cutover.
     */
    ensurePersonalDedicatedEliza(options: {
      cloudApiBase: string;
      authToken: string;
      signal?: AbortSignal;
      onProgress?: (status: string, detail?: string) => void;
      /**
       * User-gesture boundary for an existing-row adoption. Silent startup
       * must leave this unset; interactive onboarding supplies it and resolves
       * only after rendering the server quote and receiving a visible choice.
       */
      requestDedicatedAdoptionConfirmation?: DedicatedAdoptionConfirmationRequester;
      /** Visible quote review; silent startup must not start billable compute. */
      requestDedicatedActivationConfirmation?: DedicatedActivationConfirmationRequester;
      pollIntervalMs?: number;
      timeoutMs?: number;
    }): Promise<{
      personalElizaId: string;
      agentId: string;
      activeAgentId: string;
      agentName: string;
      apiBase: string;
      runtime: "dedicated";
    }>;
    /**
     * Reuse an existing cloud agent when one exists (so we don't mint a brand-new
     * agent on every sign-in), otherwise create + provision a fresh named one.
     * Always returns a valid per-agent REST adapter base (`.../agents/<id>`),
     * never the agent-id-less collection URL.
     */
    selectOrProvisionCloudAgent(options: {
      cloudApiBase: string;
      authToken: string;
      name: string;
      bio?: string[];
      /** Reuse this agent id when it still exists (e.g. a remembered choice). */
      preferAgentId?: string | null;
      /** Skip reuse and always create a new agent (explicit "Create new"). */
      forceCreate?: boolean;
      /**
       * Phase-0 tier flip. When true, a freshly created agent is requested as
       * SHARED (instant, container-free) instead of DEDICATED always-on. Only
       * affects the create branch; reuse of an existing agent is unaffected.
       */
      preferSharedTier?: boolean;
      /**
       * Authoritative list already fetched by the caller. First-run uses this
       * to avoid a second list/read race between "Finding your agents..." and
       * the bind decision.
       */
      knownAgents?: CloudCompatAgent[];
      /**
       * Return the Cloud REST adapter base (`/api/v1/eliza/agents/:id`) even
       * when the agent also exposes a dedicated subdomain. First-run uses this
       * for the default Steward-token flow; explicit dedicated handoff paths
       * leave it off so they can still run the `/pair` exchange.
       */
      preferStewardAgentAdapter?: boolean;
      onProgress?: (status: string, detail?: string) => void;
      /**
       * Cold-boot wait tuning for a reused dedicated agent that is not yet
       * `running` (a dedicated container cold-starts in ~5 minutes — #8621).
       * Defaults: poll every 5 s, give up after 6 minutes. Exposed so tests
       * can drive the wait loop against a mock cloud without real minutes.
       */
      wakePollIntervalMs?: number;
      wakeTimeoutMs?: number;
      /** Cancel selection/wake polling while preserving an accepted create receipt for compensation. */
      signal?: AbortSignal;
    }): Promise<{
      agentId: string;
      agentName: string;
      apiBase: string;
      bridgeUrl: string | null;
      created: boolean;
      /**
       * Dedicated agent subdomains require the official cloud pairing-token
       * handoff before the browser can use `/api/*` with an agent-local bearer.
       * Shared-runtime adapters continue to use the Steward session token.
       */
      requiresAgentPairing?: boolean;
      executionTier?: string | null;
      /** Exact fresh-create identity; absent for reused or legacy responses. */
      cleanupReceipt?: CloudAgentCleanupReceipt;
    }>;
    /**
     * Background shared→personal handoff for a freshly provisioned cloud agent:
     * once the dedicated container is reachable, copy the conversation the user
     * built on the shared adapter into it and switch the live client over.
     * Best-effort and non-blocking — failure leaves the user on the (working)
     * shared adapter.
     */
    startCloudAgentHandoff(options: {
      agentId: string;
      sharedApiBase: string;
      conversationId: string;
      cloudApiBase: string;
      authToken: string;
      /**
       * The SEPARATE dedicated agent to migrate onto. When set, the readiness
       * probe polls THIS agent's record for its container base (the shared
       * `agentId` is container-free and never exposes one). Omitted → the probe
       * polls `agentId` itself, the pre-shared-tier behavior.
       */
      dedicatedAgentId?: string;
      onSwitch: (containerBase: string) => void | Promise<void>;
      intervalMs?: number;
      timeoutMs?: number;
      log?: (message: string) => void;
    }): Promise<
      import("../cloud/handoff/conversation-handoff").ConversationHandoffResult
    >;
    /** Server-owned import verification + active-mode cutover for rowless personal Eliza. */
    finalizePersonalDedicatedCutover(options: {
      personalElizaId: string;
      dedicatedAgentId: string;
      cloudApiBase: string;
      authToken: string;
      signal?: AbortSignal;
    }): Promise<{
      personalElizaId: string;
      activeAgentId: string;
      runtime: "dedicated";
      apiBase: string;
      importedMessages: number;
    }>;
    /**
     * Delete the transient SHARED bridge agent (+ its `shared_runtime_history`,
     * cascaded server-side) once the user has been switched to their dedicated
     * agent (PR4). MUST only be called after a confirmed-successful handoff —
     * deleting the shared while the user is still served by it loses their
     * conversation.
     *
     * Pins the request to the explicit `cloudApiBase` (NOT the client's mutable
     * `baseUrl`): by the time the switch succeeds the client has already
     * repointed onto the dedicated container, so the base-derived
     * `deleteCloudCompatAgent` would no longer resolve the cloud API. Shared
     * delete is synchronous server-side (no container teardown), so success
     * means the row + history are gone.
     */
    deleteSharedBridgeAgent(
      agentId: string,
      options: { cloudApiBase: string; authToken: string },
    ): Promise<{ success: boolean; error?: string }>;
    checkBugReportInfo(): Promise<{
      nodeVersion?: string;
      platform?: string;
      submissionMode?: "remote" | "github" | "fallback";
    }>;
    submitBugReport(report: {
      description: string;
      stepsToReproduce: string;
      expectedBehavior?: string;
      actualBehavior?: string;
      environment?: string;
      nodeVersion?: string;
      modelProvider?: string;
      logs?: string;
      category?: "general" | "startup-failure";
      appVersion?: string;
      releaseChannel?: string;
      startup?: {
        reason?: string;
        phase?: string;
        message?: string;
        detail?: string;
        status?: number;
        path?: string;
      };
    }): Promise<{
      accepted?: boolean;
      id?: string;
      url?: string;
      fallback?: string;
      destination?: "remote" | "github" | "fallback";
    }>;
  }
}

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

ElizaClient.prototype.getCloudStatus = async function (this: ElizaClient) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase) {
    if (!readDirectCloudToken(this)) {
      return {
        connected: false,
        enabled: true,
        hasApiKey: false,
        reason: "not-authenticated",
        topUpUrl: directTopUpUrl(),
      };
    }
    try {
      const user = await directCloudRequest<Record<string, unknown>>(
        this,
        "/api/v1/user",
      );
      const data =
        user && typeof user.data === "object" && user.data !== null
          ? (user.data as Record<string, unknown>)
          : user;
      return {
        connected: true,
        enabled: true,
        hasApiKey: true,
        cloudVoiceProxyAvailable: true,
        userId: typeof data?.id === "string" ? data.id : undefined,
        organizationId:
          typeof data?.organization_id === "string"
            ? data.organization_id
            : undefined,
        topUpUrl: directTopUpUrl(),
      };
    } catch (err) {
      if (isDirectCloudAuthError(err)) {
        return {
          connected: false,
          enabled: true,
          hasApiKey: true,
          reason: "auth-rejected",
          topUpUrl: directTopUpUrl(),
        };
      }
      throw err;
    }
  }
  return this.fetch("/api/cloud/status");
};

ElizaClient.prototype.getCloudCredits = async function (this: ElizaClient) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase) {
    if (!readDirectCloudToken(this)) {
      return {
        connected: false,
        balance: null,
        error: "Not connected to Eliza Cloud.",
        topUpUrl: directTopUpUrl(),
      };
    }
    try {
      const data = await directCloudRequest<Record<string, unknown>>(
        this,
        "/api/v1/credits/balance",
      );
      const balance = numberOrNull(data?.balance);
      return {
        connected: true,
        balance: Number.isFinite(balance) ? balance : null,
        low: typeof balance === "number" ? balance < 2 : undefined,
        critical: typeof balance === "number" ? balance < 0.5 : undefined,
        topUpUrl: directTopUpUrl(),
      };
    } catch (err) {
      if (isDirectCloudAuthError(err)) {
        return {
          connected: false,
          balance: null,
          authRejected: true,
          error: "Eliza Cloud rejected the saved API key.",
          topUpUrl: directTopUpUrl(),
        };
      }
      throw err;
    }
  }
  return this.fetch("/api/cloud/credits");
};

// API-key inventory for the in-app Cloud view (keys count + manage link).
// Direct-cloud only: `GET /api/v1/api-keys` is session-gated upstream
// (requireUserWithOrg) and has no /api/cloud/* agent-host proxy, so when the
// client has no direct cloud base — or the credential is an API key rather
// than a steward session — the result degrades to `keys: null` with a reason
// instead of throwing or fabricating an empty list.
ElizaClient.prototype.listCloudApiKeys = async function (this: ElizaClient) {
  const manageUrl = `${DEFAULT_DIRECT_CLOUD_APP_BASE_URL}/cloud/api-keys`;
  const directBase = resolveDirectCloudClientApiBase(this);
  if (!directBase || !readDirectCloudToken(this)) {
    return { keys: null, manageUrl, reason: "not-connected" as const };
  }
  try {
    const data = await directCloudRequest<Record<string, unknown>>(
      this,
      "/api/v1/api-keys",
    );
    const rawKeys = Array.isArray(data?.keys) ? data.keys : [];
    const keys: CloudApiKeySummary[] = rawKeys.flatMap((raw) => {
      if (typeof raw !== "object" || raw === null) return [];
      const record = raw as Record<string, unknown>;
      const id = stringOrNull(record.id);
      const name = stringOrNull(record.name);
      if (!id || !name) return [];
      return [
        {
          id,
          name,
          keyPrefix: stringOrNull(record.key_prefix),
          createdAt: stringOrNull(record.created_at),
        },
      ];
    });
    return { keys, manageUrl };
  } catch (err) {
    if (isDirectCloudAuthError(err)) {
      return { keys: null, manageUrl, reason: "session-required" as const };
    }
    throw err;
  }
};

ElizaClient.prototype.getCloudBillingSummary = async function (
  this: ElizaClient,
) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase && !readDirectCloudToken(this)) {
    return {
      balance: null,
      currency: "USD",
      topUpUrl: directTopUpUrl(),
      embeddedCheckoutEnabled: false,
      hostedCheckoutEnabled: true,
      cryptoEnabled: false,
    };
  }
  const direct = directBase
    ? await directCloudRequest<Record<string, unknown>>(
        this,
        "/api/v1/credits/summary",
      )
    : null;
  if (direct) {
    const organization =
      typeof direct.organization === "object" && direct.organization !== null
        ? (direct.organization as Record<string, unknown>)
        : {};
    const pricing =
      typeof direct.pricing === "object" && direct.pricing !== null
        ? (direct.pricing as Record<string, unknown>)
        : {};
    const balance = numberOrNull(organization.creditBalance);
    return {
      ...direct,
      balance: Number.isFinite(balance) ? balance : null,
      currency: "USD",
      topUpUrl: directTopUpUrl(),
      embeddedCheckoutEnabled: false,
      hostedCheckoutEnabled: true,
      cryptoEnabled:
        typeof pricing.x402Enabled === "boolean" ? pricing.x402Enabled : false,
      low: typeof balance === "number" ? balance < 2 : undefined,
      critical: typeof balance === "number" ? balance < 0.5 : undefined,
    };
  }
  return this.fetch("/api/cloud/billing/summary");
};

ElizaClient.prototype.getCloudBillingSettings = async function (
  this: ElizaClient,
) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase && !readDirectCloudToken(this)) {
    return { success: false, error: "Not connected to Eliza Cloud." };
  }
  const direct = directBase
    ? await directCloudRequest<CloudBillingSettings>(
        this,
        "/api/v1/billing/settings",
      )
    : null;
  if (direct) return direct;
  return this.fetch("/api/cloud/billing/settings");
};

ElizaClient.prototype.updateCloudBillingSettings = async function (
  this: ElizaClient,
  request,
) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase && !readDirectCloudToken(this)) {
    return { success: false, error: "Not connected to Eliza Cloud." };
  }
  const direct = directBase
    ? await directCloudRequest<CloudBillingSettings>(
        this,
        "/api/v1/billing/settings",
        {
          method: "PUT",
          body: JSON.stringify(request),
        },
      )
    : null;
  if (direct) return direct;
  return this.fetch("/api/cloud/billing/settings", {
    method: "PUT",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.getCloudBillingPaymentMethods = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/billing/payment-methods");
};

ElizaClient.prototype.getCloudBillingHistory = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/billing/history");
};

ElizaClient.prototype.createCloudBillingCheckout = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/cloud/billing/checkout", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.createCloudBillingCryptoQuote = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/cloud/billing/crypto/quote", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.cloudLogin = async function (this: ElizaClient) {
  return this.fetch("/api/cloud/login", { method: "POST" });
};

ElizaClient.prototype.cloudLoginPoll = async function (
  this: ElizaClient,
  sessionId,
) {
  return this.fetch(
    `/api/cloud/login/status?sessionId=${encodeURIComponent(sessionId)}`,
  );
};

ElizaClient.prototype.cloudLoginPersist = async function (
  this: ElizaClient,
  apiKey,
  identity,
) {
  return this.fetch("/api/cloud/login/persist", {
    method: "POST",
    body: JSON.stringify({
      apiKey,
      ...(identity?.organizationId
        ? { organizationId: identity.organizationId }
        : {}),
      ...(identity?.userId ? { userId: identity.userId } : {}),
    }),
  });
};

ElizaClient.prototype.cloudDisconnect = async function (this: ElizaClient) {
  return this.fetch("/api/cloud/disconnect", { method: "POST" });
};

ElizaClient.prototype.getCloudCompatAgents = async function (
  this: ElizaClient,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudAgent[];
    error?: string;
  }>(this, "/api/v1/eliza/agents");
  if (direct) {
    return {
      success: direct.success,
      data: (direct.data ?? []).map(toCloudCompatAgent),
    };
  }

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: [],
      error: directCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: DirectCloudAgent[];
      error?: string;
    }>("/api/v1/eliza/agents");
    return {
      success: response.success,
      data: (response.data ?? []).map(toCloudCompatAgent),
    };
  }

  return this.fetch("/api/cloud/compat/agents");
};

ElizaClient.prototype.createCloudCompatAgent = async function (
  this: ElizaClient,
  opts,
) {
  // Phase-0 tier flip. The backend derives `execution_tier` from the request:
  // `alwaysOn: true` → DEDICATED always-on container; omitting it (for a plain
  // chat agent) → SHARED, container-free, instant. Default is dedicated — only
  // the demo flag drops `alwaysOn` to request shared. `tierFields` is spread
  // into both create bodies so the dedicated path stays byte-identical to before.
  const tierFields = opts.preferSharedTier ? {} : { alwaysOn: true };
  const direct = await directCloudRequest<{
    success: boolean;
    // `created: false` means a non-forced request reused an existing
    // non-terminal agent. Forced requests are rejected if they ever report
    // reuse, because their contract is a distinct agent or an explicit error.
    created?: boolean;
    source?: string;
    data: unknown;
    error?: string;
  }>(this, "/api/v1/eliza/agents", {
    method: "POST",
    body: JSON.stringify({
      agentName: opts.agentName,
      // The Eliza app provisions a DEDICATED (own-container, always-on) agent —
      // the paid tier. Zero-balance users get the cloud's 402 add-credits prompt
      // rather than silently receiving paid compute.
      // (With the Phase-0 shared-tier flag on, `alwaysOn` is dropped so the
      // backend derives a SHARED agent instead — see tierFields above.)
      ...tierFields,
      // Opt out of the backend reuse guard so a SEPARATE agent is minted (the
      // shared→dedicated handoff target). Omitted by default → reuse unchanged.
      ...(opts.forceCreate ? { forceCreate: true } : {}),
      ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
      ...(opts.environmentVars
        ? { environmentVars: opts.environmentVars }
        : {}),
    }),
  });
  if (direct) {
    requireConfirmedFreshCloudAgentCreate(
      opts.forceCreate,
      direct.created,
      direct.source,
    );
    const data = parseDirectCloudAgentCreateData(direct.data, opts.agentName);
    return {
      success: direct.success,
      created: opts.forceCreate ? true : direct.created,
      data: {
        agentId: data.id,
        agentName: data.agentName,
        jobId: data.jobId ?? "",
        status: data.status,
        nodeId: null,
        message: direct.success ? "Agent created" : (direct.error ?? ""),
        createdAt: data.createdAt,
        executionTier: data.executionTier,
      },
    };
  }

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: {
        agentId: "",
        agentName: opts.agentName,
        jobId: "",
        status: "error",
        nodeId: null,
        message: directCloudAuthMissingMessage(),
        createdAt: null,
        executionTier: null,
      },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      // See the direct-path note: `created: false` is valid only without force.
      created?: boolean;
      source?: string;
      data: unknown;
      error?: string;
    }>("/api/v1/eliza/agents", {
      method: "POST",
      body: JSON.stringify({
        agentName: opts.agentName,
        // Dedicated (own-container, always-on) agent — see the direct-path note.
        // The Phase-0 shared-tier flag drops `alwaysOn` here too (tierFields).
        ...tierFields,
        // Opt out of the backend reuse guard so a SEPARATE agent is minted (the
        // shared→dedicated handoff target). Omitted by default → reuse unchanged.
        ...(opts.forceCreate ? { forceCreate: true } : {}),
        ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
        ...(opts.environmentVars
          ? { environmentVars: opts.environmentVars }
          : {}),
      }),
    });
    requireConfirmedFreshCloudAgentCreate(
      opts.forceCreate,
      response.created,
      response.source,
    );
    const data = parseDirectCloudAgentCreateData(response.data, opts.agentName);
    return {
      success: response.success,
      created: opts.forceCreate ? true : response.created,
      data: {
        agentId: data.id,
        agentName: data.agentName,
        jobId: data.jobId ?? "",
        status: data.status,
        nodeId: null,
        message: response.success ? "Agent created" : (response.error ?? ""),
        createdAt: data.createdAt,
        executionTier: data.executionTier,
      },
    };
  }

  if (opts.forceCreate) {
    throw new Error(
      "Creating a distinct Cloud agent requires a signed-in direct Eliza Cloud session.",
    );
  }

  return this.fetch("/api/cloud/compat/agents", {
    method: "POST",
    body: JSON.stringify(opts),
  });
};

ElizaClient.prototype.ensureCloudCompatManagedDiscordAgent = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/v1/app/discord/gateway-agent", {
    method: "POST",
  });
};

ElizaClient.prototype.provisionCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<CloudCompatAgentProvisionResponse>(
    this,
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST" },
  );
  if (direct) {
    return normalizeCloudCompatProvisionResponse(direct, agentId);
  }

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: directCloudAuthMissingMessage(),
      data: { agentId, status: "auth-missing" },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<CloudCompatAgentProvisionResponse>(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
      { method: "POST" },
      { allowNonOk: true },
    );
    return normalizeCloudCompatProvisionResponse(response, agentId);
  }

  // Proxy fallback (only hit when direct cloud token is not available — see
  // `directCloudRequest` token plumbing). The upstream provision route lives
  // under `/api/v1/eliza/agents/{id}/provision` (see
  // cloud/apps/api/v1/eliza/agents/[agentId]/provision/route.ts). The
  // earlier proxy path `/api/cloud/v1/app/agents/{id}/provision` returned
  // 405 because cloud has no provision sub-route under `/v1/app/agents`.
  const response = await this.fetch<CloudCompatAgentProvisionResponse>(
    `/api/cloud/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST" },
    { allowNonOk: true },
  );
  return normalizeCloudCompatProvisionResponse(response, agentId);
};

ElizaClient.prototype.getCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudAgent;
    error?: string;
  }>(this, `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
  if (direct) {
    return {
      success: direct.success,
      data: toCloudCompatAgent(direct.data ?? { id: agentId }),
      ...(direct.error ? { error: direct.error } : {}),
    };
  }

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: toCloudCompatAgent({ id: agentId, status: "auth-missing" }),
      error: directCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: DirectCloudAgent;
      error?: string;
    }>(`/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
    return {
      success: response.success,
      data: toCloudCompatAgent(response.data ?? { id: agentId }),
      ...(response.error ? { error: response.error } : {}),
    };
  }

  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`);
};

ElizaClient.prototype.getCloudCompatAgentManagedDiscord = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord`,
  );
};

ElizaClient.prototype.createCloudCompatAgentManagedDiscordOauth =
  async function (this: ElizaClient, agentId, request = {}) {
    return this.fetch(
      `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/oauth`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  };

ElizaClient.prototype.disconnectCloudCompatAgentManagedDiscord =
  async function (this: ElizaClient, agentId) {
    return this.fetch(
      `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord`,
      {
        method: "DELETE",
      },
    );
  };

ElizaClient.prototype.getCloudCompatAgentDiscordConfig = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/config`,
  );
};

ElizaClient.prototype.updateCloudCompatAgentDiscordConfig = async function (
  this: ElizaClient,
  agentId,
  config,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/config`,
    {
      method: "PATCH",
      body: JSON.stringify(config),
    },
  );
};

ElizaClient.prototype.getCloudCompatAgentManagedGithub = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github`,
  );
};

ElizaClient.prototype.createCloudCompatAgentManagedGithubOauth =
  async function (this: ElizaClient, agentId, request = {}) {
    try {
      return await this.fetch(
        `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/oauth`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      );
    } catch (error) {
      if (!isCloudRouteNotFound(error)) {
        throw error;
      }

      const params = new URLSearchParams({
        target: "agent",
        agent_id: agentId,
      });
      if (request.postMessage) {
        params.set("post_message", "1");
      }
      if (request.returnUrl) {
        params.set("return_url", request.returnUrl);
      }

      const fallback = await this.initiateCloudOauth("github", {
        redirectUrl: `/api/v1/eliza/lifeops/github-complete?${params.toString()}`,
        connectionRole: "agent",
        scopes: request.scopes,
      });

      return {
        success: true,
        data: {
          authorizeUrl: fallback.authUrl,
        },
      };
    }
  };

ElizaClient.prototype.linkCloudCompatAgentManagedGithub = async function (
  this: ElizaClient,
  agentId,
  connectionId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/link`,
    {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    },
  );
};

ElizaClient.prototype.disconnectCloudCompatAgentManagedGithub = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github`,
    {
      method: "DELETE",
    },
  );
};

ElizaClient.prototype.listCloudOauthConnections = async function (
  this: ElizaClient,
  args,
) {
  const params = new URLSearchParams();
  if (args?.platform) {
    params.set("platform", args.platform);
  }
  if (args?.connectionRole) {
    params.set("connectionRole", args.connectionRole);
  }
  const query = params.toString();
  return this.fetch(
    `/api/cloud/v1/oauth/connections${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.initiateCloudOauth = async function (
  this: ElizaClient,
  platform,
  request,
) {
  try {
    return await this.fetch(
      `/api/cloud/v1/oauth/${encodeURIComponent(platform)}/initiate`,
      {
        method: "POST",
        body: JSON.stringify(request ?? {}),
      },
    );
  } catch (error) {
    if (!isCloudRouteNotFound(error)) {
      throw error;
    }

    return this.fetch(
      `/api/cloud/v1/oauth/initiate?provider=${encodeURIComponent(platform)}`,
      {
        method: "POST",
        body: JSON.stringify(request ?? {}),
      },
    );
  }
};

ElizaClient.prototype.initiateCloudTwitterOauth = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/cloud/v1/twitter/connect", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  });
};

ElizaClient.prototype.disconnectCloudOauthConnection = async function (
  this: ElizaClient,
  connectionId,
) {
  return this.fetch(
    `/api/cloud/v1/oauth/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "DELETE",
    },
  );
};

ElizaClient.prototype.getCloudCompatAgentGithubToken = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/token`,
  );
};

ElizaClient.prototype.deleteCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
  condition,
) {
  const normalizeDelete = (response: {
    success?: boolean;
    data?: { message?: string; status?: string; jobId?: string };
    error?: string;
  }) => ({
    success: response.success === true,
    ...(response.error ? { error: response.error } : {}),
    data: {
      // A 202 async delete carries the durable jobId. Management surfaces may
      // poll it for eventual teardown state; join cancellation only needs the
      // accepted receipt because the server already owns recovery and billing.
      // A synchronous delete returns no jobId.
      jobId: response.data?.jobId ?? "",
      status:
        response.data?.status ??
        (response.success === true ? "deleted" : "error"),
      message:
        response.data?.message ??
        (response.success === true
          ? "Agent delete complete"
          : (response.error ?? "Agent delete failed")),
    },
  });

  const direct = await directCloudRequest<{
    success: boolean;
    data?: { message?: string; status?: string; jobId?: string };
    error?: string;
  }>(this, `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    ...(condition ? { body: JSON.stringify(condition) } : {}),
  });
  if (direct) return normalizeDelete(direct);

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: directCloudAuthMissingMessage(),
      data: {
        jobId: "",
        status: "auth-missing",
        message: directCloudAuthMissingMessage(),
      },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: { message?: string; status?: string; jobId?: string };
      error?: string;
    }>(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
      {
        method: "DELETE",
        ...(condition ? { body: JSON.stringify(condition) } : {}),
      },
      { allowNonOk: true },
    );
    return normalizeDelete(response);
  }

  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    ...(condition ? { body: JSON.stringify(condition) } : {}),
  });
};

ElizaClient.prototype.updateCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
  edit,
) {
  const path = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
  const body = JSON.stringify({
    ...(edit.agentName !== undefined ? { agentName: edit.agentName } : {}),
    ...(edit.agentConfig !== undefined
      ? { agentConfig: edit.agentConfig }
      : {}),
  });
  const normalize = (response: {
    success?: boolean;
    data?: { agentId?: string; agentName?: string };
    error?: string;
  }) => ({
    success: response.success === true,
    ...(response.error ? { error: response.error } : {}),
    data: {
      agentId: response.data?.agentId ?? agentId,
      agentName: response.data?.agentName ?? edit.agentName ?? "",
    },
  });

  const direct = await directCloudRequest<{
    success: boolean;
    data?: { agentId?: string; agentName?: string };
    error?: string;
  }>(this, path, { method: "PATCH", body });
  if (direct) return normalize(direct);

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: directCloudAuthMissingMessage(),
      data: { agentId, agentName: edit.agentName ?? "" },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: { agentId?: string; agentName?: string };
      error?: string;
    }>(path, { method: "PATCH", body }, { allowNonOk: true });
    return normalize(response);
  }

  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body,
  });
};

ElizaClient.prototype.getCloudCompatAgentStatus = async function (
  this: ElizaClient,
  agentId,
) {
  // Direct-cloud fallback for mobile/web clients that have no local
  // Eliza API server proxying `/api/cloud/compat/agents/...`. The
  // direct cloud surface returns a richer agent record at
  // `/api/v1/eliza/agents/<id>`; we project it down to the
  // `CloudCompatAgentStatus` shape callers expect.
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudAgent;
  }>(this, `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
  if (direct) {
    const a = toCloudCompatAgent(direct.data ?? { id: agentId });
    return {
      success: direct.success,
      data: {
        status: a.status,
        lastHeartbeat: a.last_heartbeat_at,
        bridgeUrl: a.bridge_url,
        webUiUrl: a.webUiUrl,
        currentNode: null,
        suspendedReason: null,
        databaseStatus: a.database_status,
      },
    };
  }

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: {
        status: "auth-missing",
        lastHeartbeat: null,
        bridgeUrl: null,
        webUiUrl: null,
        currentNode: null,
        suspendedReason: directCloudAuthMissingMessage(),
        databaseStatus: "unknown",
      },
      error: directCloudAuthMissingMessage(),
    };
  }

  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/status`,
  );
};

ElizaClient.prototype.getCloudCompatAgentLogs = async function (
  this: ElizaClient,
  agentId,
  tail = 100,
) {
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/logs?tail=${tail}`,
  );
};

/**
 * Normalize a cloud lifecycle (suspend/resume) response into the
 * `{ success, data: { jobId, status, message } }` shape the UI expects. The
 * direct cloud routes return a 202 `{ success, data: { jobId, status,
 * message } }` async-job envelope; the legacy proxy returns the same shape.
 * A few routes carry the human message at the envelope top level, so read both.
 */
function normalizeCloudLifecycleResponse(
  response: {
    success?: boolean;
    data?: { jobId?: string; status?: string; message?: string };
    message?: string;
    error?: string;
  },
  fallbackVerb: string,
): { success: boolean; error?: string; data: LifecycleResult } {
  const success = response.success === true;
  return {
    success,
    ...(response.error ? { error: response.error } : {}),
    data: {
      jobId: response.data?.jobId ?? "",
      status: response.data?.status ?? (success ? "queued" : "error"),
      message:
        response.data?.message ??
        response.message ??
        (success
          ? `Agent ${fallbackVerb} enqueued`
          : (response.error ?? `Agent ${fallbackVerb} failed`)),
    },
  };
}

/**
 * Drive a cloud agent lifecycle action (suspend/resume) through the
 * direct-cloud ladder — direct token request → native-auth-missing guard →
 * direct-cloud-base same-origin fetch → legacy `/api/cloud/compat` proxy.
 * Mirrors `deleteCloudCompatAgent` so the Power/Start buttons work on
 * phone/web (which have no local API server proxying `/api/cloud/compat/...`).
 *
 * Only suspend/resume go through this ladder: the cloud-api exposes
 * `/api/v1/eliza/agents/:id/{suspend,resume}` (also sleep/wake) but NOT a
 * `restart` route, so restart stays on its legacy `/api/cloud/compat` proxy
 * (see `restartCloudCompatAgent`).
 */
async function runCloudLifecycleAction(
  client: ElizaClient,
  agentId: string,
  action: "suspend" | "resume",
): Promise<{ success: boolean; error?: string; data: LifecycleResult }> {
  const encoded = encodeURIComponent(agentId);
  const directPath = `/api/v1/eliza/agents/${encoded}/${action}`;

  const direct = await directCloudRequest<{
    success: boolean;
    data?: { jobId?: string; status?: string; message?: string };
    error?: string;
  }>(client, directPath, { method: "POST" });
  if (direct) return normalizeCloudLifecycleResponse(direct, action);

  if (isDirectCloudAuthMissing(client)) {
    return {
      success: false,
      error: directCloudAuthMissingMessage(),
      data: {
        jobId: "",
        status: "auth-missing",
        message: directCloudAuthMissingMessage(),
      },
    };
  }

  if (isDirectCloudBase(client)) {
    const response = await client.fetch<{
      success: boolean;
      data?: { jobId?: string; status?: string; message?: string };
      error?: string;
    }>(directPath, { method: "POST" }, { allowNonOk: true });
    return normalizeCloudLifecycleResponse(response, action);
  }

  return client.fetch(
    `/api/cloud/compat/agents/${encoded}/${action}`,
    { method: "POST" },
    { allowNonOk: true },
  );
}

ElizaClient.prototype.restartCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  // Restart has no `/api/v1/eliza/agents/:id/restart` route (unlike
  // suspend/resume), so it stays on the legacy compat proxy rather than the
  // direct-cloud ladder, preserving its prior behavior.
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/restart`,
    { method: "POST" },
  );
};

ElizaClient.prototype.suspendCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return runCloudLifecycleAction(this, agentId, "suspend");
};

ElizaClient.prototype.resumeCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return runCloudLifecycleAction(this, agentId, "resume");
};

ElizaClient.prototype.launchCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: CloudCompatLaunchResult;
    error?: string;
  }>(this, `/api/compat/agents/${encodeURIComponent(agentId)}/launch`, {
    method: "POST",
  });
  if (direct) return direct;

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: directCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    return this.fetch(
      `/api/compat/agents/${encodeURIComponent(agentId)}/launch`,
      { method: "POST" },
      { allowNonOk: true },
    );
  }

  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/launch`,
    { method: "POST" },
    { allowNonOk: true },
  );
};

ElizaClient.prototype.getCloudCompatAvailability = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/compat/availability");
};

ElizaClient.prototype.getCloudCompatJobStatus = async function (
  this: ElizaClient,
  jobId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudJob;
    error?: string;
  }>(this, `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  if (direct) {
    return {
      success: direct.success,
      data: toCloudCompatJob(direct.data ?? { id: jobId }),
      ...(direct.error ? { error: direct.error } : {}),
    };
  }

  if (isDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: toCloudCompatJob({
        id: jobId,
        status: "failed",
        error: directCloudAuthMissingMessage(),
      }),
      error: directCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: DirectCloudJob;
      error?: string;
    }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    return {
      success: response.success,
      data: toCloudCompatJob(response.data ?? { id: jobId }),
      ...(response.error ? { error: response.error } : {}),
    };
  }

  return this.fetch(`/api/cloud/compat/jobs/${encodeURIComponent(jobId)}`);
};

ElizaClient.prototype.exportAgent = async function (
  this: ElizaClient,
  password,
  includeLogs = false,
) {
  if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return this.rawRequest("/api/agent/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password, includeLogs }),
  });
};

ElizaClient.prototype.getExportEstimate = async function (this: ElizaClient) {
  return this.fetch("/api/agent/export/estimate");
};

ElizaClient.prototype.importAgent = async function (
  this: ElizaClient,
  password,
  fileBuffer,
) {
  if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const passwordBytes = new TextEncoder().encode(password);
  const envelope = new Uint8Array(
    4 + passwordBytes.length + fileBuffer.byteLength,
  );
  const view = new DataView(envelope.buffer);
  view.setUint32(0, passwordBytes.length, false);
  envelope.set(passwordBytes, 4);
  envelope.set(new Uint8Array(fileBuffer), 4 + passwordBytes.length);

  const res = await this.rawRequest("/api/agent/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: envelope,
  });

  const data = (await res.json()) as {
    error?: string;
    success?: boolean;
    agentId?: string;
    agentName?: string;
    counts?: Record<string, number>;
  };
  if (!data.success) {
    throw new Error(data.error ?? `Import failed (${res.status})`);
  }
  return data as {
    success: boolean;
    agentId: string;
    agentName: string;
    counts: Record<string, number>;
  };
};

ElizaClient.prototype.listLocalAgentBackups = async function (
  this: ElizaClient,
) {
  const response = await this.fetch<{ backups: LocalAgentBackupMetadata[] }>(
    "/api/backups",
  );
  return response.backups;
};

ElizaClient.prototype.createLocalAgentBackup = async function (
  this: ElizaClient,
) {
  const response = await this.fetch<{ backup: LocalAgentBackupMetadata }>(
    "/api/backups",
    {
      method: "POST",
    },
  );
  return response.backup;
};

ElizaClient.prototype.restoreLocalAgentBackup = async function (
  this: ElizaClient,
  fileName,
) {
  return this.fetch<{ restored: true; requiresRestart: true }>(
    "/api/backups/restore",
    {
      method: "POST",
      body: JSON.stringify({ fileName }),
    },
  );
};

ElizaClient.prototype.getSandboxPlatform = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/platform");
};

ElizaClient.prototype.getSandboxBrowser = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/browser");
};

ElizaClient.prototype.getSandboxScreenshot = async function (
  this: ElizaClient,
  region?,
) {
  if (!region) {
    return this.fetch("/api/sandbox/screen/screenshot", {
      method: "POST",
    });
  }
  return this.fetch("/api/sandbox/screen/screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(region),
  });
};

ElizaClient.prototype.getSandboxWindows = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/screen/windows");
};

ElizaClient.prototype.startDocker = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/docker/start", { method: "POST" });
};

ElizaClient.prototype.cloudLoginDirect = async function (
  this: ElizaClient,
  cloudApiBase,
) {
  const requestSessionId = createCloudLoginRequestId();
  if (!requestSessionId) {
    return {
      ok: false,
      error: "Login failed: a secure UUID generator is unavailable",
    };
  }
  const cloudWebBase = resolveDirectCloudWebBase(cloudApiBase);
  const authApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  try {
    if (shouldUseNativeCloudHttp()) {
      const res = await CapacitorHttp.post({
        url: `${authApiBase}/api/auth/cli-session`,
        headers: { "Content-Type": "application/json" },
        data: { sessionId: requestSessionId },
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `Login failed (${res.status})` };
      }
      const responseData = recordOrNull(parseDirectCloudJsonSafe(res.data));
      const sessionId = cloudLoginSessionIdOrNull(responseData?.sessionId);
      if (!sessionId) {
        return {
          ok: false,
          error: "Login failed: Eliza Cloud returned an invalid session ID",
        };
      }
      return {
        ok: true,
        apiBase: authApiBase,
        sessionId,
        browserUrl: buildCloudCliLoginBrowserUrl(cloudWebBase, sessionId),
      };
    }

    const res = await directCloudFetch(
      resolveBrowserCloudApiRequestUrl(`${authApiBase}/api/auth/cli-session`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: requestSessionId }),
      },
    );
    if (!res.ok) {
      return { ok: false, error: `Login failed (${res.status})` };
    }
    const responseData = recordOrNull(await res.json());
    const sessionId = cloudLoginSessionIdOrNull(responseData?.sessionId);
    if (!sessionId) {
      return {
        ok: false,
        error: "Login failed: Eliza Cloud returned an invalid session ID",
      };
    }
    return {
      ok: true,
      apiBase: authApiBase,
      sessionId,
      browserUrl: buildCloudCliLoginBrowserUrl(cloudWebBase, sessionId),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reach Eliza Cloud: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

ElizaClient.prototype.cloudLoginPollDirect = async function (
  this: ElizaClient,
  cloudApiBase,
  sessionId,
) {
  const authApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  try {
    if (shouldUseNativeCloudHttp()) {
      const res = await CapacitorHttp.get({
        url: `${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      });
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 404) {
          return {
            status: "expired" as const,
            error: "Auth session expired or not found",
          };
        }
        return {
          status: "error" as const,
          error: `Poll failed (${res.status})`,
        };
      }
      return parseCloudLoginPollData(parseDirectCloudJsonSafe(res.data));
    }

    const res = await directCloudFetch(
      resolveBrowserCloudApiRequestUrl(
        `${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
      ),
    );
    if (!res.ok) {
      if (res.status === 404) {
        return {
          status: "expired" as const,
          error: "Auth session expired or not found",
        };
      }
      return {
        status: "error" as const,
        error: `Poll failed (${res.status})`,
      };
    }
    return parseCloudLoginPollData(await res.json());
  } catch {
    return { status: "error" as const, error: "Poll request failed" };
  }
};

/**
 * Resolve the reachable API base for a freshly provisioned cloud agent.
 *
 * Prefer a reachable URL the server explicitly provides (`webUiUrl`); otherwise
 * fall back to the raw container `bridgeUrl`.
 *
 * For a DEDICATED agent the server-provided `webUiUrl` IS the unified-auth
 * proxy base (`https://<agentId>.cloud.eliza.app`, live since 2026-06-19 —
 * #8621/#8628): the Worker validates the caller's cloud token, swaps in the
 * container's own `ELIZA_API_TOKEN`, and auto-resumes a sleeping agent with
 * `202 + Retry-After`. Preferring `webUiUrl` is therefore what points the app
 * at the unified proxy. We still do NOT derive `https://<agentId>.<domain>`
 * ourselves when the server omits it: an agent record without a `webUiUrl`
 * (older rows, non-default base domains) is not guaranteed to have working
 * subdomain ingress, and a pinned 404 URL wedges first-run on
 * BACKEND_NOT_FOUND (a 404 is an HTTP response, so the startup
 * connection-error fallback deliberately does not catch it) — strictly worse
 * than the raw bridgeUrl, whose connection error the fallback recovers from.
 */
export function resolveCloudAgentApiBase(args: {
  bridgeUrl: string | null;
  webUiUrl?: string | null;
  /** Known agent id — used to derive a valid base when server URLs are missing
   *  or collapse to the agent-id-less collection URL. */
  agentId?: string | null;
  /** Resolved direct-cloud origin — required to derive from `agentId`. */
  cloudApiBase?: string | null;
}): string {
  const candidate =
    args.webUiUrl?.trim() || stripTrailingSlashes(args.bridgeUrl ?? "");
  const normalized = candidate
    ? normalizeDirectCloudSharedAgentApiBase(stripTrailingSlashes(candidate))
    : "";
  // A server URL that is missing/blank, or collapsed to the agent-id-less Eliza
  // Cloud collection (`.../api/v1/eliza/agents`), is unusable — every `/api/*`
  // call would concat to `.../agents/api/...` and 404. Derive the shared-runtime
  // REST adapter base from the known agent id instead. A raw dedicated bridge
  // (`http://<ip>:<port>`) is a valid base on a non-cloud host, so it is left
  // untouched (isElizaCloudControlPlaneAgentlessBase is host-checked).
  if (
    (!normalized || isElizaCloudControlPlaneAgentlessBase(normalized)) &&
    args.agentId &&
    args.cloudApiBase
  ) {
    return buildCloudSharedAgentApiBase(
      resolveDirectCloudAuthApiBase(args.cloudApiBase),
      args.agentId,
    );
  }
  return normalized;
}

function resolveDirectCloudAgentBridgeUrl(
  cloudApiBase: string,
  agentId: string,
): string {
  return `${stripTrailingSlashes(cloudApiBase)}/api/v1/eliza/agents/${encodeURIComponent(agentId)}/bridge`;
}

function resolveDedicatedCloudAgentApiBase(args: {
  bridgeUrl: string | null;
  webUiUrl?: string | null;
  agentId: string;
  cloudApiBase: string;
}): string {
  const resolved = resolveCloudAgentApiBase(args);
  if (!isDirectCloudSharedAgentBase(resolved)) return resolved;
  return (
    buildDedicatedCloudAgentApiBase(args.agentId, args.cloudApiBase) ?? resolved
  );
}

/**
 * True when `url` is a direct cloud shared-runtime agent base — either the REST
 * adapter base `<cloudApiBase>/api/v1/eliza/agents/<agentId>` (where #8527's
 * /api/conversations,/messages,/health are served) or the legacy JSON-RPC
 * bridge base `<...>/agents/<agentId>/bridge`. A Tier-0 shared agent runs
 * in-Worker with no agent server, so neither base exposes the app-shell
 * endpoints (`/api/first-run*`, `/api/views`) — those legitimately 404. Startup
 * uses this to degrade gracefully: a 404 from a shared-agent base means
 * "first-run is already complete" (we provisioned the agent), not a broken
 * backend — so it proceeds to chat instead of dead-ending on BACKEND_NOT_FOUND.
 */
export function isDirectCloudSharedAgentBase(
  url: string | null | undefined,
): boolean {
  if (!url) return false;
  return /\/api\/v1\/eliza\/agents\/[^/]+(?:\/bridge)?\/?$/.test(url.trim());
}

function isLoopbackCloudAgentBase(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    // error-policy:J3 malformed bases cannot qualify for the local-only proxy.
    return false;
  }
}

ElizaClient.prototype.provisionCloudSandbox = async (options) => {
  const { cloudApiBase, authToken, name, bio, onProgress } = options;
  const allowSharedRuntime = options.allowSharedRuntime === true;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };

  onProgress?.("creating", "Creating agent...");

  // Step 1: Create agent
  const createRes = await directCloudJsonResponse<{
    data?: { id?: string; agentId?: string };
    id?: string;
    agentId?: string;
  }>(`${resolvedCloudApiBase}/api/v1/eliza/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentName: name,
      alwaysOn: true,
      autoProvision: false,
      ...(bio?.length
        ? {
            agentConfig: {
              bio,
            },
          }
        : {}),
    }),
  });
  if (!createRes.ok) {
    const err = createRes.text || "Unknown error";
    throw new Error(`Failed to create cloud agent: ${err}`);
  }
  const createData = createRes.data;
  const agentId =
    createData.data?.id ??
    createData.data?.agentId ??
    createData.id ??
    createData.agentId;
  if (!agentId) {
    throw new Error("Failed to create cloud agent: missing agent id");
  }

  onProgress?.("provisioning", "Provisioning sandbox environment...");

  // Step 2: Start provisioning
  const provisionRes = await directCloudJsonResponse<{
    source?: string;
    data?: {
      jobId?: string;
      bridgeUrl?: string | null;
      webUiUrl?: string | null;
      executionTier?: string | null;
    };
    jobId?: string;
    bridgeUrl?: string | null;
    webUiUrl?: string | null;
    executionTier?: string | null;
  }>(`${resolvedCloudApiBase}/api/v1/eliza/agents/${agentId}/provision`, {
    method: "POST",
    headers,
  });
  if (!provisionRes.ok) {
    const err = provisionRes.text || "Unknown error";
    throw new Error(`Failed to start provisioning: ${err}`);
  }
  const provisionData = provisionRes.data;
  const immediateBridgeUrl =
    provisionData.data?.bridgeUrl ?? provisionData.bridgeUrl ?? null;
  const immediateWebUiUrl =
    provisionData.data?.webUiUrl ?? provisionData.webUiUrl ?? null;
  const executionTier =
    provisionData.data?.executionTier ?? provisionData.executionTier ?? null;
  const isSharedRuntime =
    provisionData.source === "shared_runtime" || executionTier === "shared";
  if (isSharedRuntime) {
    if (!allowSharedRuntime) {
      throw new Error(
        "Eliza Cloud returned a shared-runtime agent, but first-run requires a dedicated sandbox. Retry after provisioning capacity is healthy.",
      );
    }
    onProgress?.("ready", "Cloud agent ready!");
    // A shared agent has no agent server; the cloud-api REST adapter at
    // `<base>/api/v1/eliza/agents/<id>` serves its /api/* surface. Prefer the
    // server-provided webUiUrl; derive the same base if an older server omits
    // it (so chat works even before the create/provision response is updated).
    // resolveCloudAgentApiBase() prefers webUiUrl over bridgeUrl, so the REST
    // client targets the adapter while the bridgeUrl stays as a JSON-RPC
    // fallback for callers that explicitly allow shared runtime.
    const sharedWebUiUrl =
      immediateWebUiUrl ??
      `${stripTrailingSlashes(resolvedCloudApiBase)}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
    return {
      bridgeUrl: resolveDirectCloudAgentBridgeUrl(
        resolvedCloudApiBase,
        agentId,
      ),
      agentId,
      webUiUrl: sharedWebUiUrl,
      executionTier: "shared",
    };
  }
  if (immediateBridgeUrl) {
    onProgress?.("ready", "Sandbox ready!");
    return {
      bridgeUrl: immediateBridgeUrl,
      agentId,
      webUiUrl: immediateWebUiUrl,
      ...(executionTier ? { executionTier } : {}),
    };
  }
  const jobId = provisionData.data?.jobId ?? provisionData.jobId;
  if (!jobId) {
    throw new Error("Failed to start provisioning: missing job id");
  }

  // Step 3: Poll job status
  const startedAt = Date.now();
  const deadline = startedAt + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const jobRes = await directCloudJsonResponse<{
      data?: {
        status?: string;
        result?: { bridgeUrl?: string; webUiUrl?: string | null };
        error?: string;
      };
      status?: string;
      result?: { bridgeUrl?: string; webUiUrl?: string | null };
      error?: string;
    }>(`${resolvedCloudApiBase}/api/v1/jobs/${jobId}`, { headers });
    if (!jobRes.ok) continue;

    const jobData = jobRes.data;
    const status = jobData.data?.status ?? jobData.status;
    const result = jobData.data?.result ?? jobData.result;
    const error = jobData.data?.error ?? jobData.error;

    if (status === "completed" && result?.bridgeUrl) {
      onProgress?.("ready", "Sandbox ready!");
      return {
        bridgeUrl: result.bridgeUrl as string,
        agentId,
        webUiUrl: result.webUiUrl ?? null,
      };
    }

    if (status === "failed") {
      throw new Error(`Provisioning failed: ${error ?? "Unknown error"}`);
    }

    onProgress?.(
      "provisioning",
      describeProvisioningWait(status, Date.now() - startedAt),
    );
  }

  throw new Error("Provisioning timed out after 2 minutes");
};

// Elapsed-time thresholds for the provisioning wait narration. A dedicated
// provision typically lands in ~30-45s (PROVISIONING-SLOW-2026-07-22 traces:
// create→first-turn 34-44s typical), so past ~20s the copy reassures rather
// than repeats, and past ~60s it names the elapsed time so a degraded-mode
// wait never looks frozen.
const PROVISION_WAIT_REASSURE_MS = 20_000;
const PROVISION_WAIT_LONG_MS = 60_000;

/**
 * Human copy for one provisioning-wait poll tick. The raw
 * `Status: ${status}...` narration leaked backend job states ("pending",
 * "in_progress") to the user and never changed across a 30s+ wait — the
 * "static spinner" class from the 2026-07-22 QA reports. Instead: map the
 * real job status to a staged step (getting things ready → starting up), and
 * advance the copy with elapsed time so a long wait visibly progresses.
 * Exported for unit tests.
 */
export function describeProvisioningWait(
  status: string | undefined,
  elapsedMs: number,
): string {
  if (elapsedMs >= PROVISION_WAIT_LONG_MS) {
    // Bucketed to 30s steps: consumers (the first-run conductor) seed one
    // chat turn per unique status text, so a per-tick counter would spam a
    // new bubble every poll. A 30s step still visibly advances a long wait.
    const bucket = Math.floor(elapsedMs / 30_000) * 30;
    return `Still working — about ${bucket}s in. Cold starts can take several minutes…`;
  }
  const active =
    normalizeCloudJobStatus(status) === "processing" ||
    normalizeCloudJobStatus(status) === "retrying";
  if (elapsedMs >= PROVISION_WAIT_REASSURE_MS) {
    return active
      ? "Starting your agent — a cold start can take several minutes…"
      : "Waiting for a sandbox slot — this can take several minutes…";
  }
  return active
    ? "Starting your agent…"
    : "Getting your agent's environment ready…";
}

// Dedicated cold-boot wait defaults. A dedicated container cold-starts in
// ~5 minutes (#8621, measured live 2026-06-19), while the full supported image
// pull plus health budget can approach 11 minutes. The generic retry budget in
// client-base is only ~60 s, so the connect flow must wait on the control plane
// instead of letting the first chat call exhaust that budget and error.
const CLOUD_AGENT_WAKE_POLL_INTERVAL_MS = 5_000;
const CLOUD_AGENT_WAKE_TIMEOUT_MS = 12 * 60_000;
const CLOUD_AGENT_FAILED_STATUSES = new Set([
  "error",
  "failed",
  "deletion_pending",
  "deletion_failed",
]);

/**
 * Control-plane answers a wake/provision wait must surface immediately: auth
 * expiry (401/403), credit exhaustion (402), a deleted agent row (404), a
 * conflicting lifecycle operation (409), and a worker/capacity outage (503).
 * Continuing to poll cannot cure any of them — it only hides the real failure
 * behind the bounded startup timeout (#18463). Transport failures without an HTTP
 * status and explicit 408/429/500/502/504 churn stay transient: those are the
 * control plane asking for another attempt (a rate-limited or timed-out poll
 * tick says nothing about the wake itself), so the bounded poll remains the
 * authority and honors any Retry-After it carried.
 */
const CLOUD_WAKE_TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 504]);

/** Where in the wake/provision state machine a typed failure was observed. */
export type CloudAgentWakePhase =
  | "resume"
  | "status-poll"
  | "provision-job"
  | "failed"
  | "timeout";

/**
 * Typed failure from the dedicated wake/provision wait. The pre-#18463 loop
 * swallowed every resume/detail error, collapsing auth expiry, missing rows,
 * credit exhaustion, and worker outages into one indistinguishable spinner
 * and a generic timeout string. Callers render `message` as-is; programmatic
 * consumers branch on `phase`/`status` and honor `retryAfter` (seconds, from
 * the backend's Retry-After) when present. `agentId`/`jobId` are the
 * operator-safe correlation ids for the attempt.
 */
export class CloudAgentWakeError extends ElizaError {
  override readonly name = "CloudAgentWakeError";
  readonly phase: CloudAgentWakePhase;
  readonly agentId: string;
  readonly jobId?: string;
  /** HTTP status of the underlying non-transient control-plane failure. */
  readonly status?: number;
  /** Seconds until retry is worthwhile, when the backend sent Retry-After. */
  readonly retryAfter?: number;
  /** Last agent/job status observed before the failure. */
  readonly lastObservedStatus?: string;

  constructor(options: {
    message: string;
    phase: CloudAgentWakePhase;
    agentId: string;
    jobId?: string;
    status?: number;
    retryAfter?: number;
    lastObservedStatus?: string;
    controlPlaneCode?: string;
    cause?: unknown;
  }) {
    super(options.message, {
      code: options.controlPlaneCode ?? "CLOUD_AGENT_WAKE_FAILED",
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      context: {
        phase: options.phase,
        agentId: options.agentId,
        ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.retryAfter !== undefined
          ? { retryAfter: options.retryAfter }
          : {}),
        ...(options.lastObservedStatus !== undefined
          ? { lastObservedStatus: options.lastObservedStatus }
          : {}),
      },
      severity: "ephemeral",
    });
    this.phase = options.phase;
    this.agentId = options.agentId;
    if (options.jobId !== undefined) this.jobId = options.jobId;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.lastObservedStatus !== undefined) {
      this.lastObservedStatus = options.lastObservedStatus;
    }
  }
}

/**
 * Classify a wake-path request rejection. Returns any terminal HTTP status (+
 * Retry-After when the transport preserved one); status-less network errors
 * and the transient statuses return `null` and keep polling.
 */
function nonTransientWakeFailure(cause: unknown): {
  status: number;
  retryAfter?: number;
  controlPlaneCode?: string;
} | null {
  const details = wakeFailureDetails(cause);
  if (details === null || CLOUD_WAKE_TRANSIENT_STATUSES.has(details.status)) {
    return null;
  }
  return details;
}

/**
 * Milliseconds a transient wake-path rejection asked the caller to back off,
 * or `null` when it carried no Retry-After. A 429/503-style throttle is the
 * control plane naming its own pace; polling it again on the fixed 5s tick
 * only earns another rejection, so the loop sleeps for what it was told.
 */
function transientWakeRetryDelayMs(cause: unknown): number | null {
  const details = wakeFailureDetails(cause);
  if (
    details === null ||
    !CLOUD_WAKE_TRANSIENT_STATUSES.has(details.status) ||
    details.retryAfter === undefined ||
    details.retryAfter <= 0
  ) {
    return null;
  }
  return Math.ceil(details.retryAfter * 1000);
}

/**
 * Parse the HTTP status, Retry-After, and control-plane code out of a
 * wake-path rejection, reading both transport error shapes: `ApiError`
 * (`status`/`retryAfter`) and the direct-cloud
 * `Object.assign(new Error(), { status, data })` throw. Returns `null` for a
 * status-less transport failure, which no classification can act on.
 */
function wakeFailureDetails(cause: unknown): {
  status: number;
  retryAfter?: number;
  controlPlaneCode?: string;
} | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { status } = cause as { status?: unknown };
  if (typeof status !== "number" || !Number.isInteger(status)) {
    return null;
  }
  const body = recordOrNull((cause as { data?: unknown }).data);
  const nestedError = recordOrNull(body?.error);
  const retryAfter = firstNumber(
    (cause as { retryAfter?: unknown }).retryAfter,
    body?.retryAfter,
    body?.retry_after,
    nestedError?.retryAfter,
    nestedError?.retry_after,
  );
  const controlPlaneCode = firstString(
    (cause as { code?: unknown }).code,
    body?.code,
    nestedError?.code,
  );
  return {
    status,
    ...(retryAfter !== null && retryAfter >= 0 ? { retryAfter } : {}),
    ...(controlPlaneCode ? { controlPlaneCode } : {}),
  };
}

function envelopeFailure(value: unknown): {
  message: string | null;
  controlPlaneCode?: string;
} {
  const root = recordOrNull(value);
  const data = recordOrNull(root?.data);
  const nestedError = recordOrNull(root?.error);
  const message = firstString(
    root?.error,
    root?.message,
    data?.error,
    data?.message,
    nestedError?.message,
  );
  const controlPlaneCode = firstString(
    root?.code,
    data?.code,
    nestedError?.code,
  );
  return {
    message,
    ...(controlPlaneCode ? { controlPlaneCode } : {}),
  };
}

function wakeFailureMessage(
  what: string,
  status: number,
  retryAfter: number | undefined,
  cause: unknown,
): string {
  const causeMessage =
    cause instanceof Error && cause.message ? ` ${cause.message}` : "";
  const retryHint =
    typeof retryAfter === "number" && retryAfter > 0
      ? ` Try again in about ${Math.ceil(retryAfter)}s.`
      : "";
  return `${what} (HTTP ${status}).${causeMessage}${retryHint}`;
}

function isTerminalFailedCloudAgent(agent: CloudCompatAgent): boolean {
  return CLOUD_AGENT_FAILED_STATUSES.has(
    String(agent.status ?? "").toLowerCase(),
  );
}

/**
 * Resume a dedicated cloud agent, await its accepted restore job, then return
 * the fresh running record so callers bind its current URLs.
 *
 * A running row enables proxy reachability before backup restoration finishes.
 * The admitted job is therefore the readiness authority when available;
 * already-running and lost-response compatibility paths use the bounded status
 * poll. Both waits share one deadline and preserve cancellation and typed errors.
 */
export async function waitForCloudAgentRunning(
  client: ElizaClient,
  options: {
    agentId: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: string, detail?: string) => void;
    signal?: AbortSignal;
  },
): Promise<CloudCompatAgent> {
  const { agentId, onProgress } = options;
  options.signal?.throwIfAborted();
  const pollIntervalMs = Math.max(
    50,
    options.pollIntervalMs ?? CLOUD_AGENT_WAKE_POLL_INTERVAL_MS,
  );
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? CLOUD_AGENT_WAKE_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  onProgress?.(
    "starting",
    "Starting your agent — a cold boot can take a few minutes...",
  );
  const resume = await client
    .resumeCloudCompatAgent(agentId)
    .catch((cause: unknown) => {
      const hard = nonTransientWakeFailure(cause);
      if (hard) {
        throw new CloudAgentWakeError({
          message: wakeFailureMessage(
            "Starting your cloud agent failed",
            hard.status,
            hard.retryAfter,
            cause,
          ),
          phase: "resume",
          agentId,
          ...hard,
          cause,
        });
      }
      // error-policy:J4 a transport failure without a terminal HTTP status is
      // an idempotent wake nudge lost in transit; the bounded status poll is
      // the authority and can still observe the agent becoming ready.
      return null;
    });
  if (resume && !resume.success) {
    const failure = envelopeFailure(resume);
    throw new CloudAgentWakeError({
      message:
        failure.message ??
        "Starting your cloud agent was rejected. Sign in again and retry.",
      phase: "resume",
      agentId,
      controlPlaneCode:
        failure.controlPlaneCode ?? "CLOUD_AGENT_RESUME_REJECTED",
    });
  }

  const resumeJobId = resume?.data?.jobId;
  if (typeof resumeJobId === "string" && resumeJobId.trim()) {
    await waitForCloudProvisionJob(client, {
      agentId,
      jobId: resumeJobId,
      pollIntervalMs,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
      onProgress,
      signal: options.signal,
    });
  }

  let lastStatus = "unknown";
  let backoffMs: number | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    backoffMs = null;
    const detail = await client
      .getCloudCompatAgent(agentId)
      .catch((cause: unknown) => {
        const hard = nonTransientWakeFailure(cause);
        if (hard) {
          throw new CloudAgentWakeError({
            message: wakeFailureMessage(
              "Checking your cloud agent failed",
              hard.status,
              hard.retryAfter,
              cause,
            ),
            phase: "status-poll",
            agentId,
            lastObservedStatus: lastStatus,
            ...hard,
            cause,
          });
        }
        // error-policy:J4 a transient status read counts as an unknown tick
        // inside this bounded poll; the deadline below throws with the last
        // status. A Retry-After on that rejection sets the next tick's pace.
        backoffMs = transientWakeRetryDelayMs(cause);
        return null;
      });
    if (detail && !detail.success) {
      const failure = envelopeFailure(detail);
      throw new CloudAgentWakeError({
        message:
          failure.message ??
          "Eliza Cloud could not read your agent status. Sign in again and retry.",
        phase: "status-poll",
        agentId,
        lastObservedStatus: lastStatus,
        controlPlaneCode:
          failure.controlPlaneCode ?? "CLOUD_AGENT_STATUS_REJECTED",
      });
    }
    const agent = detail?.data ?? null;
    if (agent) {
      lastStatus = agent.status || "unknown";
      if (lastStatus === "running") return agent;
      if (CLOUD_AGENT_FAILED_STATUSES.has(lastStatus.toLowerCase())) {
        throw new CloudAgentWakeError({
          message: agent.error_message
            ? `Your cloud agent failed to start: ${agent.error_message}`
            : "Your cloud agent failed to start. Check its status in Eliza Cloud and try again.",
          phase: "failed",
          agentId,
          lastObservedStatus: lastStatus,
        });
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new CloudAgentWakeError({
        message: `Your cloud agent is still "${lastStatus}" after ${Math.round(
          elapsedMs / 1000,
        )}s (agent ${agentId}). It may still be booting — try again in a minute.`,
        phase: "timeout",
        agentId,
        lastObservedStatus: lastStatus,
      });
    }
    onProgress?.("starting", describeAgentWakeWait(elapsedMs));
    await abortableDelay(
      Math.min(Math.max(pollIntervalMs, backoffMs ?? 0), timeoutMs - elapsedMs),
      options.signal,
    );
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbsoluteDeadlineSignal(
  deadlineMs: number,
  callerSignal?: AbortSignal,
): {
  signal: AbortSignal;
  deadlineElapsed: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let deadlineElapsed = false;
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const onDeadline = () => {
    if (controller.signal.aborted) return;
    deadlineElapsed = true;
    controller.abort(
      new DOMException("The startup deadline elapsed", "TimeoutError"),
    );
  };
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) onDeadline();
  else timeout = setTimeout(onDeadline, remainingMs);
  directCloudAbsoluteDeadlineBySignal.set(controller.signal, deadlineMs);
  return {
    signal: controller.signal,
    deadlineElapsed: () => deadlineElapsed,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      directCloudAbsoluteDeadlineBySignal.delete(controller.signal);
    },
  };
}

/**
 * Human copy for one cold-boot wake poll tick. The old narration leaked the
 * raw backend status (`Starting your agent (pending) — 35s elapsed...`) and
 * changed every poll, which spams consumers that seed one chat turn per
 * unique status text (the first-run conductor). Staged, minute-bucketed copy
 * instead: it advances visibly on a long wait without a per-tick counter.
 * Exported for unit tests.
 */
export function describeAgentWakeWait(elapsedMs: number): string {
  if (elapsedMs < 60_000) {
    return "Starting your agent — a cold boot can take a few minutes…";
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  return `Still starting your agent — about ${minutes} minute${minutes === 1 ? "" : "s"} in. Cold boots can take a few minutes…`;
}

/**
 * Follow the canonical provisioning job for a fresh dedicated create to a
 * terminal state. The 202 create path answers with a `jobId` the old flow
 * discarded, reducing a failed provision to an opaque agent-detail timeout;
 * the job row carries the real failure reason (worker unavailable, image
 * pull, capacity) as soon as the worker records it. Resolves on `completed`,
 * throws typed on `failed`, on a non-transient job read, and on timeout.
 * Exported for unit tests.
 */
export async function waitForCloudProvisionJob(
  client: ElizaClient,
  options: {
    agentId: string;
    jobId: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: string, detail?: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { agentId, jobId, onProgress } = options;
  options.signal?.throwIfAborted();
  const pollIntervalMs = Math.max(
    50,
    options.pollIntervalMs ?? CLOUD_AGENT_WAKE_POLL_INTERVAL_MS,
  );
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? CLOUD_AGENT_WAKE_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  let lastStatus = "queued";
  let backoffMs: number | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    backoffMs = null;
    const res = await client
      .getCloudCompatJobStatus(jobId)
      .catch((cause: unknown) => {
        const hard = nonTransientWakeFailure(cause);
        if (hard) {
          throw new CloudAgentWakeError({
            message: wakeFailureMessage(
              "Provisioning your cloud agent failed",
              hard.status,
              hard.retryAfter,
              cause,
            ),
            phase: "provision-job",
            agentId,
            jobId,
            lastObservedStatus: lastStatus,
            ...hard,
            cause,
          });
        }
        // error-policy:J4 a transient job read counts as an unknown tick
        // inside this bounded poll; the deadline below throws with the last
        // status. A Retry-After on that rejection sets the next tick's pace.
        backoffMs = transientWakeRetryDelayMs(cause);
        return null;
      });
    if (res && !res.success) {
      const failure = envelopeFailure(res);
      throw new CloudAgentWakeError({
        message:
          failure.message ??
          "Eliza Cloud could not read the provisioning job. Sign in again and retry.",
        phase: "provision-job",
        agentId,
        jobId,
        lastObservedStatus: lastStatus,
        controlPlaneCode:
          failure.controlPlaneCode ?? "CLOUD_PROVISION_JOB_STATUS_REJECTED",
      });
    }
    const job = res?.data ?? null;
    if (job) {
      lastStatus = job.state || job.status;
      if (job.status === "completed") return;
      if (job.status === "failed") {
        throw new CloudAgentWakeError({
          message: job.error
            ? `Your cloud agent failed to start: ${job.error}`
            : "Your cloud agent failed to start. Check its status in Eliza Cloud and try again.",
          phase: "provision-job",
          agentId,
          jobId,
          lastObservedStatus: lastStatus,
        });
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new CloudAgentWakeError({
        message: `Your cloud agent's provisioning job is still "${lastStatus}" after ${Math.round(
          elapsedMs / 1000,
        )}s (agent ${agentId}, job ${jobId}). It may still be working — try again in a minute.`,
        phase: "timeout",
        agentId,
        jobId,
        lastObservedStatus: lastStatus,
      });
    }
    onProgress?.(
      "provisioning",
      describeProvisioningWait(lastStatus, elapsedMs),
    );
    await abortableDelay(
      Math.min(Math.max(pollIntervalMs, backoffMs ?? 0), timeoutMs - elapsedMs),
      options.signal,
    );
  }
}

/**
 * Pick which agent to reuse from a cloud agent list: a specific requested id
 * when it is running, else the most-recently-created running agent, else the
 * newest NON-TERMINAL agent (pending/provisioning/stopped/…). A running-only
 * pick (#15491) left any transiently-not-running account with zero reuse
 * candidates, so first-run fell through to a fresh create — which the server
 * 503-blocks during a provisioning-worker outage even though the user's
 * existing agent was fine (#15516). Non-running picks are never bound
 * directly: the reuse branch routes them through `waitForCloudAgentRunning`,
 * which resolves with the FRESH post-wake record — that (not refusing reuse)
 * is the guard against binding a stale pointer whose chat 404s. Failed and
 * deletion rows are unreusable.
 */
function pickPreferredCloudAgent(
  agents: CloudCompatAgent[],
  preferAgentId?: string | null,
): CloudCompatAgent | null {
  if (!agents.length) return null;
  const byNewest = (rows: CloudCompatAgent[]) =>
    [...rows].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
  if (preferAgentId) {
    // Honor the remembered agent whenever it is not terminally failed —
    // silently binding a DIFFERENT agent would swap the user's conversations
    // and memories; a cold-boot wait on the remembered one is the honest cost.
    const exact = agents.find(
      (a) => a.agent_id === preferAgentId && !isTerminalFailedCloudAgent(a),
    );
    if (exact) return exact;
  }
  const running = byNewest(agents.filter((a) => a.status === "running"));
  if (running[0]) return running[0];
  const nonTerminal = byNewest(
    agents.filter((a) => !isTerminalFailedCloudAgent(a)),
  );
  return nonTerminal[0] ?? null;
}

ElizaClient.prototype.getPersonalSharedEliza = async (options) => {
  const cloudApiBase = resolveDirectCloudAuthApiBase(options.cloudApiBase);
  const url = `${cloudApiBase}/api/v1/eliza/personal`;
  const response = await directCloudJsonResponse<unknown>(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.authToken}`,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw Object.assign(
      new Error(
        directCloudResponseErrorMessage(response.status, response.data),
      ),
      { status: response.status, data: response.data, url },
    );
  }
  const root = recordOrNull(response.data);
  const data = recordOrNull(root?.data);
  const identity = recordOrNull(data?.identity);
  const personalElizaId = firstString(identity?.id);
  const agentName = firstString(identity?.displayName);
  if (
    root?.success !== true ||
    !personalElizaId ||
    !isPersonalSharedElizaId(personalElizaId) ||
    !agentName
  ) {
    throw new Error("Eliza Cloud returned an invalid personal Eliza identity.");
  }
  if (identity?.runtime === "dedicated") {
    const activeAgentId = firstString(identity.activeAgentId);
    const apiBase = firstString(identity.apiBase);
    let parsedBase: URL | null = null;
    try {
      parsedBase = apiBase ? new URL(apiBase) : null;
    } catch {
      parsedBase = null;
    }
    if (
      !activeAgentId ||
      !apiBase ||
      !parsedBase ||
      (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") ||
      !isTrustedCloudApiBaseUrl(apiBase, activeAgentId)
    ) {
      throw new Error(
        "Eliza Cloud returned an invalid Dedicated connection for this personal Eliza.",
      );
    }
    return {
      personalElizaId,
      agentId: personalElizaId,
      activeAgentId,
      agentName,
      apiBase,
      runtime: "dedicated",
    };
  }
  if (identity?.runtime !== "shared") {
    throw new Error("Eliza Cloud returned an unknown personal Eliza runtime.");
  }
  return {
    personalElizaId,
    agentId: personalElizaId,
    activeAgentId: personalElizaId,
    agentName,
    apiBase: buildCloudSharedAgentApiBase(cloudApiBase, personalElizaId),
    runtime: "shared",
  };
};

type InProgressDedicatedActivationPolicy =
  | "reattach-without-post"
  | "resume-with-confirmed-post";

/**
 * The server's `in_progress` quote state means target ownership, not always
 * active work. Only pending/provisioning/running are safe after an ambiguous
 * activation response: stopped/sleeping/error require the server's confirmed
 * POST reactivation contract to validate credit and re-arm the same row.
 */
function inProgressDedicatedActivationPolicy(
  status: string,
): InProgressDedicatedActivationPolicy | null {
  switch (status) {
    case "pending":
    case "provisioning":
    case "running":
      return "reattach-without-post";
    case "error":
    case "stopped":
    case "sleeping":
      return "resume-with-confirmed-post";
    default:
      return null;
  }
}

function throwIfDedicatedStartupDeadlineElapsed(
  deadline: number,
  signal?: AbortSignal,
): void {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) {
    throw new DOMException("The startup deadline elapsed", "TimeoutError");
  }
}

type EnsurePersonalDedicatedElizaOptions = Parameters<
  ElizaClient["ensurePersonalDedicatedEliza"]
>[0];

export type DedicatedAdoptionStateDisposition =
  | "fresh_boot_no_verified_backup"
  | "verified_backup_present"
  | "unreviewed_existing_target";

export interface DedicatedAdoptionConfirmationQuote {
  quoteId: string;
  dedicatedAgentId: string;
  adoptionState: "available" | "adopted";
  status: string;
  startsCompute: boolean;
  hourlyRateUsd: number;
  minimumActivationChargeUsd: number;
  dailyRateUsd: number;
  minimumBalanceUsd: number;
  minimumRunwayDays: number;
  balanceUsd: number;
  deficitUsd: number;
  stateDisposition: DedicatedAdoptionStateDisposition;
  canAdopt: boolean;
  requiresCatalogRestore: boolean;
  requiresConfirmation: true;
  action: "adopt_existing_dedicated";
  unavailableReason?: string;
}

export type DedicatedAdoptionConfirmationRequester = (
  quote: DedicatedAdoptionConfirmationQuote,
  context: {
    reason: "initial" | "quote_changed";
    signal?: AbortSignal;
  },
) => Promise<{
  action: "adopt_existing_dedicated";
  quoteId: string;
} | null>;

const DEDICATED_ADOPTION_SELECTION_REQUIRED =
  "dedicated_adoption_selection_required";
const DEDICATED_ADOPTION_QUOTE_CHANGED = "dedicated_adoption_quote_changed";
const PERSONAL_DEDICATED_RETRYABLE_CUTOVER_CODES = new Set([
  "shared_history_unavailable",
  "personal_identity_convergence_in_progress",
  "dedicated_not_healthy",
  "dedicated_not_reachable",
  "dedicated_transport_unavailable",
  "personal_reminder_cutover_in_progress",
  "dedicated_history_import_failed",
  "shared_personal_snapshot_unstable",
  "dedicated_reminder_activation_failed",
]);
const PERSONAL_DEDICATED_TRANSIENT_JOB_HTTP_STATUSES = new Set([
  408, 429, 500, 502, 503, 504,
]);

interface PersonalDedicatedAdoptionTarget {
  dedicatedAgentId: string;
  jobId?: string;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDedicatedAdoptionQuote(
  value: unknown,
): DedicatedAdoptionConfirmationQuote | null {
  const quote = recordOrNull(value);
  const quoteId = firstString(quote?.quoteId);
  const dedicatedAgentId = firstString(quote?.dedicatedAgentId);
  const adoptionState = firstString(quote?.adoptionState);
  const status = firstString(quote?.status);
  const hourlyRateUsd = finiteNumber(quote?.hourlyRateUsd);
  const minimumActivationChargeUsd = finiteNumber(
    quote?.minimumActivationChargeUsd,
  );
  const dailyRateUsd = finiteNumber(quote?.dailyRateUsd);
  const minimumBalanceUsd = finiteNumber(quote?.minimumBalanceUsd);
  const minimumRunwayDays = finiteNumber(quote?.minimumRunwayDays);
  const balanceUsd = finiteNumber(quote?.balanceUsd);
  const deficitUsd = finiteNumber(quote?.deficitUsd);
  const stateDisposition = firstString(quote?.stateDisposition);
  const unavailableReason = firstString(quote?.unavailableReason);
  if (
    !quoteId ||
    !dedicatedAgentId ||
    (adoptionState !== "available" && adoptionState !== "adopted") ||
    !status ||
    typeof quote?.startsCompute !== "boolean" ||
    hourlyRateUsd === null ||
    minimumActivationChargeUsd === null ||
    minimumActivationChargeUsd < 0 ||
    dailyRateUsd === null ||
    minimumBalanceUsd === null ||
    minimumRunwayDays === null ||
    balanceUsd === null ||
    deficitUsd === null ||
    (stateDisposition !== "fresh_boot_no_verified_backup" &&
      stateDisposition !== "verified_backup_present" &&
      stateDisposition !== "unreviewed_existing_target") ||
    typeof quote?.canAdopt !== "boolean" ||
    typeof quote?.requiresCatalogRestore !== "boolean" ||
    quote.requiresConfirmation !== true ||
    quote.action !== "adopt_existing_dedicated"
  ) {
    return null;
  }
  return {
    quoteId,
    dedicatedAgentId,
    adoptionState,
    status,
    startsCompute: quote.startsCompute,
    hourlyRateUsd,
    minimumActivationChargeUsd,
    dailyRateUsd,
    minimumBalanceUsd,
    minimumRunwayDays,
    balanceUsd,
    deficitUsd,
    stateDisposition,
    canAdopt: quote.canAdopt,
    requiresCatalogRestore: quote.requiresCatalogRestore,
    requiresConfirmation: true,
    action: "adopt_existing_dedicated",
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

function dedicatedAdoptionError(options: {
  message: string;
  code: string;
  status: number;
  data: unknown;
  url: string;
}): ElizaError & { status: number; data: unknown; url: string } {
  return Object.assign(
    new ElizaError(options.message, {
      code: options.code,
      context: { phase: "adoption-confirmation" },
    }),
    { status: options.status, data: options.data, url: options.url },
  );
}

function dedicatedAdoptionUnavailableError(
  quote: DedicatedAdoptionConfirmationQuote,
): ElizaError {
  return new ElizaError(
    quote.unavailableReason ??
      "The selected Dedicated agent cannot be adopted right now.",
    {
      code: quote.requiresCatalogRestore
        ? "CLOUD_DEDICATED_ADOPTION_CATALOG_RESTORE_REQUIRED"
        : "CLOUD_DEDICATED_ADOPTION_UNAVAILABLE",
      context: { phase: "adoption-quote", field: "canAdopt" },
    },
  );
}

async function adoptSelectedPersonalDedicatedEliza(
  upgradeUrl: string,
  options: EnsurePersonalDedicatedElizaOptions,
  deadline: number,
): Promise<PersonalDedicatedAdoptionTarget | null> {
  const adoptionUrl = `${upgradeUrl}/adopt-existing`;
  const fetchCurrentQuote = async () => {
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const response = await directCloudJsonResponse<unknown>(adoptionUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.authToken}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    return response;
  };
  let quoteResponse = await fetchCurrentQuote();
  let confirmationReason: "initial" | "quote_changed" = "initial";
  let firstTargetId: string | null = null;
  for (;;) {
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const quoteRoot = recordOrNull(quoteResponse.data);
    const responseCode = directCloudErrorMetadata(quoteResponse.data).code;
    if (
      quoteResponse.status === 404 &&
      quoteRoot?.success === false &&
      responseCode === "dedicated_adoption_unavailable"
    ) {
      return null;
    }
    const quote = parseDedicatedAdoptionQuote(quoteRoot?.data);
    const renewedQuote =
      confirmationReason === "quote_changed" &&
      quoteResponse.status === 409 &&
      quoteRoot?.success === false &&
      responseCode === DEDICATED_ADOPTION_QUOTE_CHANGED;
    if ((!quoteResponse.ok || quoteRoot?.success !== true) && !renewedQuote) {
      throw dedicatedAdoptionError({
        message: directCloudResponseErrorMessage(
          quoteResponse.status,
          quoteResponse.data,
        ),
        code: "CLOUD_DEDICATED_ADOPTION_QUOTE_INVALID",
        status: quoteResponse.status,
        data: quoteResponse.data,
        url: adoptionUrl,
      });
    }
    if (!quote) {
      throw dedicatedAdoptionError({
        message: "Eliza Cloud returned an invalid Dedicated adoption quote.",
        code: "CLOUD_DEDICATED_ADOPTION_QUOTE_INVALID",
        status: quoteResponse.status,
        data: quoteResponse.data,
        url: adoptionUrl,
      });
    }
    firstTargetId ??= quote.dedicatedAgentId;
    if (quote.dedicatedAgentId !== firstTargetId) {
      throw new ElizaError(
        "Eliza Cloud changed the selected Dedicated target while awaiting confirmation.",
        {
          code: "CLOUD_DEDICATED_ADOPTION_TARGET_MISMATCH",
          context: { phase: "adoption-quote", field: "dedicatedAgentId" },
        },
      );
    }
    if (!quote.canAdopt) {
      throw dedicatedAdoptionUnavailableError(quote);
    }
    const requester = options.requestDedicatedAdoptionConfirmation;
    if (!requester) {
      throw dedicatedAdoptionError({
        message:
          "Review and confirm the current Dedicated hosting quote before this existing agent can be adopted.",
        code: "CLOUD_DEDICATED_ADOPTION_CONFIRMATION_REQUIRED",
        status: 409,
        data: quoteResponse.data,
        url: adoptionUrl,
      });
    }
    const confirmation = await requester(quote, {
      reason: confirmationReason,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    if (
      confirmation?.action !== "adopt_existing_dedicated" ||
      confirmation.quoteId !== quote.quoteId
    ) {
      throw dedicatedAdoptionError({
        message: "Dedicated adoption was not confirmed.",
        code: "CLOUD_DEDICATED_ADOPTION_CONFIRMATION_REQUIRED",
        status: 409,
        data: quoteResponse.data,
        url: adoptionUrl,
      });
    }

    const adoptionResponse = await directCloudJsonResponse<unknown>(
      adoptionUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.authToken}`,
        },
        body: JSON.stringify({
          ...confirmation,
          minimumActivationChargeUsd: quote.minimumActivationChargeUsd,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const adoptionRoot = recordOrNull(adoptionResponse.data);
    const adoptionCode = directCloudErrorMetadata(adoptionResponse.data).code;
    if (
      adoptionResponse.status === 409 &&
      adoptionRoot?.success === false &&
      adoptionCode === DEDICATED_ADOPTION_QUOTE_CHANGED
    ) {
      // Some server versions return the replacement quote in the 409 body;
      // others return only the typed quote-changed code. Preserve the former
      // fast path, but always reconcile the latter with a fresh read before
      // asking for renewed consent. The original absolute startup deadline and
      // first-target lock remain authoritative across both reads.
      quoteResponse = parseDedicatedAdoptionQuote(adoptionRoot.data)
        ? adoptionResponse
        : await fetchCurrentQuote();
      confirmationReason = "quote_changed";
      continue;
    }
    const adoption = recordOrNull(adoptionRoot?.data);
    const adoptedTargetId = firstString(adoption?.dedicatedAgentId);
    const jobId = firstString(adoption?.jobId);
    if (
      !adoptionResponse.ok ||
      adoptionRoot?.success !== true ||
      !adoptedTargetId ||
      adoption?.runtime !== "dedicated_pending_cutover" ||
      (adoptionResponse.status === 202 && !jobId)
    ) {
      throw dedicatedAdoptionError({
        message: directCloudResponseErrorMessage(
          adoptionResponse.status,
          adoptionResponse.data,
        ),
        code: "CLOUD_DEDICATED_ADOPTION_REJECTED",
        status: adoptionResponse.status,
        data: adoptionResponse.data,
        url: adoptionUrl,
      });
    }
    if (adoptedTargetId !== quote.dedicatedAgentId) {
      throw new ElizaError(
        "Eliza Cloud adopted a different Dedicated target than the quoted selection.",
        {
          code: "CLOUD_DEDICATED_ADOPTION_TARGET_MISMATCH",
          context: { phase: "adoption", field: "dedicatedAgentId" },
        },
      );
    }
    return {
      dedicatedAgentId: adoptedTargetId,
      ...(jobId ? { jobId } : {}),
    };
  }
}

function personalDedicatedCutoverCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  return (
    directCloudErrorMetadata((error as { data?: unknown }).data).code ?? null
  );
}

async function waitForPersonalDedicatedProvisionJob(
  cloudApiBase: string,
  authToken: string,
  target: Required<PersonalDedicatedAdoptionTarget>,
  options: EnsurePersonalDedicatedElizaOptions,
  deadline: number,
): Promise<void> {
  const jobUrl = `${cloudApiBase}/api/v1/jobs/${encodeURIComponent(target.jobId)}`;
  const intervalMs =
    options.pollIntervalMs ?? CLOUD_AGENT_WAKE_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  for (;;) {
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const response = await directCloudJsonResponse<unknown>(jobUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const root = recordOrNull(response.data);
    const job = recordOrNull(root?.data);
    const jobId = firstString(job?.id);
    const status = firstString(job?.status);
    if (!response.ok || root?.success !== true) {
      if (PERSONAL_DEDICATED_TRANSIENT_JOB_HTTP_STATUSES.has(response.status)) {
        await abortableDelay(
          Math.min(intervalMs, deadline - Date.now()),
          options.signal,
        );
        continue;
      }
      throw Object.assign(
        new Error(
          directCloudResponseErrorMessage(response.status, response.data),
        ),
        { status: response.status, data: response.data, url: jobUrl },
      );
    }
    if (jobId !== target.jobId || !status) {
      throw new ElizaError(
        "Eliza Cloud returned an invalid Dedicated provisioning job.",
        {
          code: "CLOUD_DEDICATED_PROVISION_JOB_INVALID",
          context: { phase: "provision-job", field: "data" },
        },
      );
    }
    if (status === "completed") return;
    if (status === "failed") {
      const error = firstString(job?.error);
      throw new ElizaError(
        error
          ? `Your Dedicated agent failed to start: ${error}`
          : "Your Dedicated agent failed to start. Check its status in Eliza Cloud and try again.",
        {
          code: "CLOUD_DEDICATED_PROVISION_JOB_FAILED",
          context: {
            phase: "provision-job",
            agentId: target.dedicatedAgentId,
            jobId: target.jobId,
          },
        },
      );
    }
    if (status !== "pending" && status !== "in_progress") {
      throw new ElizaError(
        "Eliza Cloud returned an unknown Dedicated provisioning job status.",
        {
          code: "CLOUD_DEDICATED_PROVISION_JOB_STATUS_UNKNOWN",
          context: { phase: "provision-job", field: "status", status },
        },
      );
    }
    options.onProgress?.(
      "starting",
      describeProvisioningWait(status, Date.now() - startedAt),
    );
    await abortableDelay(
      Math.min(intervalMs, deadline - Date.now()),
      options.signal,
    );
  }
}

async function ensurePersonalDedicatedElizaWithinDeadline(
  this: ElizaClient,
  options: EnsurePersonalDedicatedElizaOptions,
  deadline: number,
): ReturnType<ElizaClient["ensurePersonalDedicatedEliza"]> {
  throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
  const personal = await this.getPersonalSharedEliza(options);
  throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
  if (personal.runtime === "dedicated") {
    return { ...personal, runtime: "dedicated" as const };
  }

  const cloudApiBase = resolveDirectCloudAuthApiBase(options.cloudApiBase);
  const upgradeUrl = `${cloudApiBase}/api/v1/eliza/agents/${encodeURIComponent(personal.personalElizaId)}/upgrade-tier`;
  throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
  options.onProgress?.("provisioning", "Starting your Dedicated agent…");

  const quoteResponse = await directCloudJsonResponse<unknown>(upgradeUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.authToken}`,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
  const quoteRoot = recordOrNull(quoteResponse.data);
  const quote = recordOrNull(quoteRoot?.data);
  const quoteId = firstString(quote?.quoteId);
  if (!quoteResponse.ok || quoteRoot?.success !== true || !quoteId) {
    throw Object.assign(
      new Error(
        directCloudResponseErrorMessage(
          quoteResponse.status,
          quoteResponse.data,
        ),
      ),
      {
        status: quoteResponse.status,
        data: quoteResponse.data,
        url: upgradeUrl,
      },
    );
  }
  if (quote?.canActivate !== true) {
    throw Object.assign(
      new Error(
        firstString(quote?.unavailableReason) ??
          "Dedicated compute is required for signed-in Eliza sessions, but this account does not have enough hosting credit.",
      ),
      { status: 402, data: quoteResponse.data, url: upgradeUrl },
    );
  }

  throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
  const quoteActivation = recordOrNull(quote?.activation);
  const activationState = firstString(quoteActivation?.state);
  let quotedTargetId: string | null = null;
  let activationPostRequired = false;
  let dedicatedAgentId: string | null = null;
  let provisioningJobId: string | null = null;
  if (activationState === "in_progress") {
    const existingTargetId = firstString(quoteActivation?.dedicatedAgentId);
    const existingTargetStatus = firstString(quoteActivation?.status);
    if (!existingTargetId || !existingTargetStatus) {
      throw new ElizaError(
        "Eliza Cloud returned an invalid in-progress Dedicated activation.",
        {
          code: "CLOUD_DEDICATED_ACTIVATION_INVALID",
          context: { phase: "quote", field: "activation" },
        },
      );
    }
    quotedTargetId = existingTargetId;
    const statusPolicy =
      inProgressDedicatedActivationPolicy(existingTargetStatus);
    if (statusPolicy === "reattach-without-post") {
      // A prior POST can commit server-side even if its response body stalls
      // or the client disconnects. These statuses already own live work (or
      // healthy compute), so the read-only quote is sufficient authority to
      // resume cutover without replaying the paid activation POST.
      dedicatedAgentId = existingTargetId;
    } else if (statusPolicy === "resume-with-confirmed-post") {
      // An already-selected/adopted retained row must re-enter through the
      // adoption service. The generic activation route can re-arm the same
      // row without carrying its reviewed restore authority into the new job.
      // A 404 here means there is no selection receipt, so the ordinary
      // quote-bound activation path remains valid for that account.
      const adoptedTarget = await adoptSelectedPersonalDedicatedEliza(
        upgradeUrl,
        options,
        deadline,
      );
      if (adoptedTarget) {
        if (adoptedTarget.dedicatedAgentId !== existingTargetId) {
          throw new ElizaError(
            "Eliza Cloud resumed a different Dedicated target than the quoted activation.",
            {
              code: "CLOUD_DEDICATED_TARGET_MISMATCH",
              context: { phase: "adoption", field: "dedicatedAgentId" },
            },
          );
        }
        dedicatedAgentId = adoptedTarget.dedicatedAgentId;
        provisioningJobId = adoptedTarget.jobId ?? null;
      } else {
        activationPostRequired = true;
      }
    } else {
      throw new ElizaError(
        "Eliza Cloud returned an invalid in-progress Dedicated status.",
        {
          code: "CLOUD_DEDICATED_STATUS_UNKNOWN",
          context: { phase: "quote", field: "activation.status" },
        },
      );
    }
  } else if (activationState === "available") {
    activationPostRequired = true;
  } else {
    throw new ElizaError(
      "Eliza Cloud returned an invalid Dedicated quote state.",
      {
        code: "CLOUD_DEDICATED_QUOTE_STATE_UNKNOWN",
        context: { phase: "quote", field: "activation.state" },
      },
    );
  }

  if (activationPostRequired) {
    const reviewedQuote = parseDedicatedActivationConfirmationQuote(
      quote ?? {},
      personal.personalElizaId,
    );
    options.onProgress?.("confirmation", "Review Dedicated hosting…");
    await confirmDedicatedActivation(
      reviewedQuote,
      options.requestDedicatedActivationConfirmation,
      options.signal,
    );
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    options.onProgress?.("provisioning", "Starting your Dedicated agent…");
    const activationResponse = await directCloudJsonResponse<unknown>(
      upgradeUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.authToken}`,
        },
        body: JSON.stringify({
          action: "activate_dedicated",
          quoteId,
          minimumActivationChargeUsd: reviewedQuote.minimumActivationChargeUsd,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const activationRoot = recordOrNull(activationResponse.data);
    const activation = recordOrNull(activationRoot?.data);
    let activatedTargetId = firstString(activation?.dedicatedAgentId);
    const activatedJobId = firstString(activation?.jobId);
    const activationCode = directCloudErrorMetadata(
      activationResponse.data,
    ).code;
    const adoptionRequired =
      activationResponse.status === 409 &&
      activationRoot?.success === false &&
      activationCode === DEDICATED_ADOPTION_SELECTION_REQUIRED;
    if (adoptionRequired) {
      const adoptedTarget = await adoptSelectedPersonalDedicatedEliza(
        upgradeUrl,
        options,
        deadline,
      );
      activatedTargetId = adoptedTarget?.dedicatedAgentId ?? null;
      provisioningJobId = adoptedTarget?.jobId ?? null;
      if (!adoptedTarget) {
        throw new ElizaError(
          "Eliza Cloud required an existing-row adoption but no selected target was available.",
          {
            code: "CLOUD_DEDICATED_ADOPTION_UNAVAILABLE",
            context: { phase: "adoption", field: "selection" },
          },
        );
      }
    }
    if (
      (!activationResponse.ok && !adoptionRequired) ||
      (activationResponse.ok && activationRoot?.success !== true) ||
      !activatedTargetId
    ) {
      throw Object.assign(
        new Error(
          directCloudResponseErrorMessage(
            activationResponse.status,
            activationResponse.data,
          ),
        ),
        {
          status: activationResponse.status,
          data: activationResponse.data,
          url: upgradeUrl,
        },
      );
    }
    if (quotedTargetId && activatedTargetId !== quotedTargetId) {
      throw new ElizaError(
        "Eliza Cloud resumed a different Dedicated target than the quoted activation.",
        {
          code: "CLOUD_DEDICATED_TARGET_MISMATCH",
          context: { phase: "activation", field: "dedicatedAgentId" },
        },
      );
    }
    dedicatedAgentId = activatedTargetId;
    if (
      !adoptionRequired &&
      activationResponse.status === 202 &&
      !activatedJobId
    ) {
      throw new ElizaError(
        "Eliza Cloud accepted Dedicated activation without a provisioning job.",
        {
          code: "CLOUD_DEDICATED_PROVISION_JOB_INVALID",
          context: { phase: "activation", field: "jobId" },
        },
      );
    }
    if (!adoptionRequired && activatedJobId) provisioningJobId = activatedJobId;
  }
  if (!dedicatedAgentId) {
    throw new Error(
      "Eliza Cloud did not resolve a Dedicated activation target.",
    );
  }

  if (provisioningJobId) {
    await waitForPersonalDedicatedProvisionJob(
      cloudApiBase,
      options.authToken,
      { dedicatedAgentId, jobId: provisioningJobId },
      options,
      deadline,
    );
  }

  const intervalMs = options.pollIntervalMs ?? 5_000;
  for (;;) {
    throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Dedicated agent ${dedicatedAgentId} did not become ready before the signed-in startup deadline.`,
      );
    }
    try {
      const cutover = await this.finalizePersonalDedicatedCutover({
        personalElizaId: personal.personalElizaId,
        dedicatedAgentId,
        cloudApiBase,
        authToken: options.authToken,
        signal: options.signal,
      });
      throwIfDedicatedStartupDeadlineElapsed(deadline, options.signal);
      options.onProgress?.("ready", "Connected to your Dedicated agent");
      return {
        personalElizaId: personal.personalElizaId,
        agentId: personal.personalElizaId,
        activeAgentId: cutover.activeAgentId,
        agentName: personal.agentName,
        apiBase: cutover.apiBase,
        runtime: "dedicated" as const,
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw error;
      const code = personalDedicatedCutoverCode(error);
      if (!code || !PERSONAL_DEDICATED_RETRYABLE_CUTOVER_CODES.has(code)) {
        throw error;
      }
      options.onProgress?.("starting", "Finishing your Dedicated setup…");
      await abortableDelay(
        Math.min(intervalMs, deadline - Date.now()),
        options.signal,
      );
    }
  }
}

ElizaClient.prototype.ensurePersonalDedicatedEliza = async function (
  this: ElizaClient,
  options,
) {
  const timeoutMs = options.timeoutMs ?? CLOUD_AGENT_WAKE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const operationDeadline = createAbsoluteDeadlineSignal(
    deadline,
    options.signal,
  );
  try {
    return await ensurePersonalDedicatedElizaWithinDeadline.call(
      this,
      { ...options, signal: operationDeadline.signal },
      deadline,
    );
  } catch (error) {
    // error-policy:J2 context-adding rethrow — preserve caller cancellation;
    // only a proven overall deadline adds the stable startup-deadline context.
    options.signal?.throwIfAborted();
    if (operationDeadline.deadlineElapsed() || Date.now() >= deadline) {
      throw new Error(
        "Dedicated agent did not become ready before the signed-in startup deadline.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    operationDeadline.dispose();
  }
};

ElizaClient.prototype.selectOrProvisionCloudAgent = async function (
  this: ElizaClient,
  options,
) {
  options.signal?.throwIfAborted();
  const {
    cloudApiBase,
    authToken,
    name,
    bio,
    preferAgentId,
    forceCreate,
    preferSharedTier,
    knownAgents,
    preferStewardAgentAdapter,
  } = options;
  const onProgress = options.onProgress;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  let forceCreateForTerminalAgents = false;
  let forceCreatePastSharedAgents = false;
  // Cold-boot callers pass the Steward session explicitly. Persist it only
  // before a Cloud agent connection exists: once the app is bound to a
  // dedicated agent, the caller's fallback may be that agent's bearer, which
  // must never be relabeled as a control-plane credential.
  if (authToken && !isDedicatedCloudAgentClient(this)) {
    await writeStoredStewardToken(authToken);
  }

  // Reuse an existing agent unless the caller explicitly forces a new one. This
  // is the fix for "a new cloud agent is created on every sign-in" — the create
  // path only runs when the user has no agent yet.
  if (!forceCreate) {
    const list = knownAgents
      ? { success: true as const, data: knownAgents }
      : await (async () => {
          // "listing", not "creating": this is the reuse LOOKUP, and
          // downstream consumers (the first-run silent cloud entry, #15133)
          // distinguish real provisioning phases from bookkeeping by this code.
          // Display consumers render the detail text, so the rename is
          // invisible to them.
          onProgress?.("listing", "Finding your agents...");
          // A failed agent-list lookup must NOT fall through to provisioning. A
          // transient error (expired token, network blip, or a success:false
          // body) previously collapsed to an empty list and minted a brand-new
          // billed agent even though the user already had one — the root of the
          // "it creates multiple agents" report. Only an authoritative success
          // list may conclude the user has no agent to reuse; otherwise surface
          // the error so the caller can retry rather than duplicate.
          return await this.getCloudCompatAgents().catch((cause: unknown) => ({
            success: false as const,
            data: [] as CloudCompatAgent[],
            error: cause instanceof Error ? cause.message : undefined,
            cause,
          }));
        })();
    if (!list.success) {
      // Keep the original rejection on the cause chain: callers (the join
      // flow's stale-binding recovery) classify the structural agent-gone
      // shape by status/code via `isCloudAgentGoneError`, which the flattened
      // message alone cannot carry.
      throw new Error(
        list.error ||
          "Couldn't reach Eliza Cloud to find your agents. Check your connection and try again.",
        { cause: "cause" in list ? list.cause : undefined },
      );
    }
    // Dedicated mode must not bind a temporary shared bridge as if it were a
    // dedicated sandbox. The Cloud API exposes the authoritative tier; carry
    // it through the compat model instead of guessing from URL presence. A
    // shared-only organization needs forceCreate below so the backend reuse
    // guard cannot hand the same bridge back to an always-on create request.
    const eligibleAgents = preferSharedTier
      ? list.data
      : list.data.filter((agent) => agent.execution_tier !== "shared");
    forceCreatePastSharedAgents =
      !preferSharedTier &&
      list.data.some((agent) => agent.execution_tier === "shared");
    const chosen = pickPreferredCloudAgent(eligibleAgents, preferAgentId);
    forceCreateForTerminalAgents =
      eligibleAgents.length > 0 &&
      !chosen &&
      eligibleAgents.every(isTerminalFailedCloudAgent);
    if (chosen) {
      let agent = chosen;
      // A picked agent that is not `running` is a dedicated cold boot: shared
      // rows are BORN `running` (they are container-free, served instantly by
      // the in-Worker runtime), so a non-running pick always has a container
      // to wake (~5 minutes — #8621). Binding its list-row base immediately
      // would exhaust the ~60 s 202-retry budget on the first chat call AND
      // risks a stale pointer (the list row's URLs predate the wake) — so wait
      // for `running` here; `waitForCloudAgentRunning` kicks a resume and
      // resolves with the FRESH post-wake record, whose URLs we bind below.
      if (agent.status !== "running") {
        agent = await waitForCloudAgentRunning(this, {
          agentId: chosen.agent_id,
          ...(typeof options.wakePollIntervalMs === "number"
            ? { pollIntervalMs: options.wakePollIntervalMs }
            : {}),
          ...(typeof options.wakeTimeoutMs === "number"
            ? { timeoutMs: options.wakeTimeoutMs }
            : {}),
          ...(onProgress ? { onProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      const hasDedicatedBase = Boolean(
        agent.bridge_url || agent.web_ui_url || agent.webUiUrl,
      );
      const useSharedAdapter = Boolean(
        agent.execution_tier === "shared" ||
          (!hasDedicatedBase &&
            (preferSharedTier || preferStewardAgentAdapter)),
      );
      const apiBase = useSharedAdapter
        ? buildCloudSharedAgentApiBase(resolvedCloudApiBase, agent.agent_id)
        : resolveDedicatedCloudAgentApiBase({
            bridgeUrl: agent.bridge_url,
            webUiUrl: agent.web_ui_url ?? agent.webUiUrl,
            agentId: agent.agent_id,
            cloudApiBase: resolvedCloudApiBase,
          });
      onProgress?.("ready", "Connected to your agent");
      return {
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        apiBase,
        bridgeUrl: agent.bridge_url,
        created: false,
        requiresAgentPairing: false,
        executionTier: agent.execution_tier ?? null,
      };
    }
  }

  // Create a NEW agent. createCloudCompatAgent provisions a DEDICATED (alwaysOn)
  // agent — the billed container product served at its own public subdomain
  // (https://<id>.cloud.eliza.app), reached with the cloud token via the
  // unified-auth Worker. A dedicated agent's reachable base is that subdomain,
  // NOT the shared REST adapter (which 404s for non-shared agents), so resolve
  // the base from the agent's web_ui_url exactly like the reuse branch above.
  // The subdomain is returned as soon as the agent record exists (before the
  // container finishes booting), so re-read the created agent to pick it up;
  // if that lookup fails or has no URL yet, fall back to the standard dedicated
  // subdomain for the known agent id.
  onProgress?.("creating", `Creating ${name}...`);
  const mustForceCreate =
    forceCreate ||
    forceCreatePastSharedAgents ||
    (forceCreateForTerminalAgents && !preferSharedTier);
  const created = await this.createCloudCompatAgent({
    agentName: name,
    ...(bio?.length ? { agentConfig: { bio } } : {}),
    ...(mustForceCreate ? { forceCreate: true } : {}),
    ...(preferSharedTier ? { preferSharedTier: true } : {}),
  });
  if (!created.success || !created.data.agentId) {
    throw new Error(created.data.message || "Failed to create cloud agent");
  }
  requireConfirmedFreshCloudAgentCreate(mustForceCreate, created.created);
  const agentId = created.data.agentId;
  const cleanupReceipt =
    created.data.createdAt && created.data.executionTier
      ? {
          deleteCondition: {
            expectedAgentName: created.data.agentName || name,
            expectedCreatedAt: created.data.createdAt,
            expectedExecutionTier: created.data.executionTier,
          },
        }
      : undefined;
  const cancellationReceipt = () => ({
    agentId,
    agentName: created.data.agentName || name,
    apiBase: buildCloudSharedAgentApiBase(resolvedCloudApiBase, agentId),
    bridgeUrl: null,
    created: created.created !== false,
    requiresAgentPairing: false,
    executionTier: preferSharedTier ? ("shared" as const) : null,
    ...(cleanupReceipt ? { cleanupReceipt } : {}),
  });
  // Once create is accepted, callers need the authoritative id even if the
  // remaining wait is cancelled so they can compensate the external mutation.
  if (options.signal?.aborted) return cancellationReceipt();
  // The provisioning-job wait and the running wait below are two halves of ONE
  // join, so they share ONE budget. Giving each the full wake timeout let a job
  // that finished at 5:59 hand a fresh six minutes to the status poll — the
  // twelve-minute spinner of #18463. Each wait gets whatever is left.
  const wakeBudgetMs =
    typeof options.wakeTimeoutMs === "number"
      ? options.wakeTimeoutMs
      : CLOUD_AGENT_WAKE_TIMEOUT_MS;
  const wakeDeadlineAt = Date.now() + wakeBudgetMs;
  const remainingWakeMs = () => Math.max(0, wakeDeadlineAt - Date.now());
  // A 202 async create names its canonical provisioning job. Follow THAT job
  // to terminal — its row carries the real failure reason long before the
  // agent-detail poll below would time out — instead of discarding the id.
  if (created.data.jobId) {
    try {
      await waitForCloudProvisionJob(this, {
        agentId,
        jobId: created.data.jobId,
        ...(typeof options.wakePollIntervalMs === "number"
          ? { pollIntervalMs: options.wakePollIntervalMs }
          : {}),
        timeoutMs: remainingWakeMs(),
        ...(onProgress ? { onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted && error === options.signal.reason) {
        return cancellationReceipt();
      }
      throw error;
    }
  }
  // error-policy:J4 detail is an optimization probe (warm-pool fast path);
  // on failure the standard dedicated subdomain is still the desired default.
  const detail = await this.getCloudCompatAgent(agentId).catch(() => null);
  let detailAgent = detail?.success ? detail.data : null;
  const detailHasDedicatedBase = Boolean(
    detailAgent?.bridge_url || detailAgent?.web_ui_url || detailAgent?.webUiUrl,
  );
  const useSharedAdapter = Boolean(
    detailAgent?.execution_tier === "shared" ||
      (!detailHasDedicatedBase &&
        (preferSharedTier || preferStewardAgentAdapter)),
  );
  // A freshly-created dedicated agent's subdomain is populated immediately, but
  // its container takes ~30-120s to boot. When the caller wants a dedicated
  // runtime, wait here so the first chat request does not land on the shared
  // adapter for a non-shared agent or race the container cold boot.
  const initialDedicatedApiBase = resolveDedicatedCloudAgentApiBase({
    bridgeUrl: detailAgent?.bridge_url ?? null,
    webUiUrl: detailAgent?.web_ui_url ?? detailAgent?.webUiUrl,
    agentId,
    cloudApiBase: resolvedCloudApiBase,
  });
  if (
    !useSharedAdapter &&
    detailAgent &&
    detailAgent.status !== "running" &&
    isDedicatedCloudAgentBase(initialDedicatedApiBase)
  ) {
    try {
      detailAgent = await waitForCloudAgentRunning(this, {
        agentId,
        ...(typeof options.wakePollIntervalMs === "number"
          ? { pollIntervalMs: options.wakePollIntervalMs }
          : {}),
        timeoutMs: remainingWakeMs(),
        ...(onProgress ? { onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted && error === options.signal.reason) {
        return cancellationReceipt();
      }
      throw error;
    }
  }
  const apiBase = useSharedAdapter
    ? buildCloudSharedAgentApiBase(resolvedCloudApiBase, agentId)
    : resolveDedicatedCloudAgentApiBase({
        bridgeUrl: detailAgent?.bridge_url ?? null,
        webUiUrl: detailAgent?.web_ui_url ?? detailAgent?.webUiUrl,
        agentId,
        cloudApiBase: resolvedCloudApiBase,
      });
  onProgress?.("ready", "Cloud agent ready!");
  return {
    agentId,
    agentName: created.data.agentName || name,
    apiBase,
    bridgeUrl: detailAgent?.bridge_url ?? null,
    // Preserve compatibility for non-forced callers. A force-create response
    // must explicitly confirm `created: true` above because a "Create new"
    // action may never bind an existing or ambiguous agent response.
    created: created.created !== false,
    requiresAgentPairing: false,
    executionTier: detailAgent?.execution_tier ?? null,
    ...(cleanupReceipt ? { cleanupReceipt } : {}),
  };
};

ElizaClient.prototype.startCloudAgentHandoff = function (
  this: ElizaClient,
  options,
) {
  const {
    agentId,
    sharedApiBase,
    conversationId,
    cloudApiBase,
    authToken,
    dedicatedAgentId,
    onSwitch,
    intervalMs,
    timeoutMs,
    log,
  } = options;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  // Migration TARGET. With the shared tier, the user chats on `agentId` (a
  // container-free shared agent that never gets a dedicated base), so the
  // dedicated record we poll for readiness is a SEPARATE agent. Default to
  // `agentId` so the pre-shared-tier single-agent flow is unchanged.
  const readinessAgentId = dedicatedAgentId ?? agentId;
  const sourceIsSharedAdapter = isDirectCloudSharedAgentBase(sharedApiBase);

  // Authed JSON fetch against a specific agent base (shared adapter OR the
  // dedicated container subdomain). Both accept the cloud session token —
  // the dedicated-agent proxy swaps it for the container's own token.
  const authedFetch: AuthedAgentFetch = async (base, path, init) => {
    const res = await directCloudFetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  const readiness: AgentReadinessProbe = {
    resolveReadyBase: async () => {
      // A shared adapter never becomes a dedicated runtime in place. Without
      // a separately provisioned target there is nowhere safe to switch, even
      // if an older control-plane detail response omits `executionTier`.
      if (!dedicatedAgentId && sourceIsSharedAdapter) return null;
      // Handoff already carries an explicit Cloud API base and credential.
      // Read the target through that canonical route instead of asking the
      // client to infer direct-vs-proxy mode from its ambient configuration.
      // Local and self-hosted Cloud bases are intentionally not recognized as
      // production direct-cloud hosts, so inference would otherwise poll the
      // app-only `/api/cloud/compat/agents/:id` proxy and time out on 404.
      const detail = await authedFetch(
        resolvedCloudApiBase,
        `/api/v1/eliza/agents/${encodeURIComponent(readinessAgentId)}`,
      ).catch(() => null);
      const detailBody = detail?.json as {
        success?: boolean;
        data?: DirectCloudAgent;
      } | null;
      let agent =
        detail?.status === 200 && detailBody?.success && detailBody.data
          ? toCloudCompatAgent(detailBody.data)
          : null;
      // Compatibility fallback for older app proxies and injected clients that
      // do not implement the canonical direct detail envelope.
      if (!agent) {
        const compatDetail = await this.getCloudCompatAgent(
          readinessAgentId,
        ).catch(() => null);
        agent = compatDetail?.success ? compatDetail.data : null;
      }
      if (!agent) return null;
      // A shared control-plane row is never a migration target. Local stacks
      // expose both shared and dedicated agents through the same UUID-scoped
      // proxy shape, so URL classification alone cannot distinguish them.
      if (agent.execution_tier === "shared") return null;
      const base = resolveCloudAgentApiBase({
        bridgeUrl: agent.bridge_url,
        webUiUrl: agent.web_ui_url ?? agent.webUiUrl,
        agentId: readinessAgentId,
        cloudApiBase: resolvedCloudApiBase,
      });
      const isLocalDedicatedProxy =
        isDedicatedCloudAgentBase(base) && isLoopbackCloudAgentBase(base);
      // Hosted agents expose a public URL. The local Cloud harness deliberately
      // does not; its UUID-scoped Worker proxy is the dedicated runtime route.
      const hasDedicatedUrl = Boolean(
        agent.bridge_url ||
          agent.web_ui_url ||
          agent.webUiUrl ||
          isLocalDedicatedProxy,
      );
      if (!hasDedicatedUrl) return null;
      if (agent.status && agent.status !== "running") return null;
      // Never "switch" onto the shared adapter (no migration target there).
      if (isDirectCloudSharedAgentBase(base) && !isLocalDedicatedProxy) {
        return null;
      }
      // Control-plane `running` precedes actual routability: the runtime proxy
      // can keep 404ing the subdomain for minutes after the record flips
      // (#15901). Probe the base itself and only report ready once the proxy
      // actually routes to the container — a 404/408/425/429/5xx or a
      // network-layer failure means "running but not yet routable", so the
      // supervisor keeps polling inside its budget instead of one-shot
      // importing into a router that answers 404. Any routed response —
      // including an auth challenge — proves routability; the import carries
      // its own credentials.
      try {
        const probe = await authedFetch(base, "/api/health");
        if (isRetryableHandoffHttpStatus(probe.status)) return null;
      } catch {
        // error-policy:J4 readiness probe — an unreachable base is the
        // designed "not ready yet" signal; the poll loop retries within its
        // budget and times out honestly if the container never serves.
        return null;
      }
      return base;
    },
  };

  return startCloudConversationHandoff({
    sharedApiBase,
    conversationId,
    readiness,
    authedFetch,
    onSwitch,
    ...(typeof intervalMs === "number" ? { intervalMs } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(log ? { log } : {}),
  });
};

ElizaClient.prototype.finalizePersonalDedicatedCutover = async (options) => {
  const cloudApiBase = resolveDirectCloudAuthApiBase(options.cloudApiBase);
  const url = `${cloudApiBase}/api/v1/eliza/agents/${encodeURIComponent(options.personalElizaId)}/upgrade-tier/cutover`;
  const response = await directCloudJsonResponse<unknown>(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.authToken}`,
    },
    body: JSON.stringify({ dedicatedAgentId: options.dedicatedAgentId }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const root = recordOrNull(response.data);
  const data = recordOrNull(root?.data);
  const personalElizaId = firstString(data?.personalElizaId);
  const activeAgentId = firstString(data?.activeAgentId);
  const apiBase = firstString(data?.apiBase);
  const importedMessages = numberOrNull(data?.importedMessages);
  if (
    !response.ok ||
    root?.success !== true ||
    data?.runtime !== "dedicated" ||
    personalElizaId !== options.personalElizaId ||
    activeAgentId !== options.dedicatedAgentId ||
    !apiBase ||
    importedMessages === null ||
    importedMessages < 0
  ) {
    throw Object.assign(
      new Error(
        directCloudResponseErrorMessage(response.status, response.data),
      ),
      { status: response.status, data: response.data, url },
    );
  }
  return {
    personalElizaId,
    activeAgentId,
    runtime: "dedicated",
    apiBase,
    importedMessages,
  };
};

ElizaClient.prototype.deleteSharedBridgeAgent = async function (
  this: ElizaClient,
  agentId,
  options,
) {
  // Pin to the explicit cloud API base, not the client's (now repointed-to-
  // dedicated) baseUrl. The shared-tier DELETE on `/api/v1/eliza/agents/:id`
  // synchronously removes the shared `agent_sandboxes` row AND its
  // `shared_runtime_history` (cascaded in `deleteAgent`); no container teardown.
  const apiBase = resolveDirectCloudAuthApiBase(options.cloudApiBase);
  const url = `${apiBase}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${options.authToken}`,
  };
  try {
    // Route through Capacitor native HTTP on iOS/Android, exactly like every
    // other direct-cloud helper in this file. A bare cross-origin `fetch()`
    // from `capacitor://localhost` is blocked on native, so without this the
    // fire-and-forget cleanup would silently no-op on mobile and leak the
    // shared `agent_sandboxes` row — the very thing this delete exists to avoid.
    const status = shouldUseNativeCloudHttp()
      ? (
          await withDirectCloudHttpTimeout(
            CapacitorHttp.request({
              url,
              method: "DELETE",
              headers,
              responseType: "json",
              connectTimeout: 10_000,
              readTimeout: 10_000,
            }),
            { method: "DELETE", url },
          )
        ).status
      : await (async () => {
          // Portable 20 s bound — `AbortSignal.timeout` throws on iOS 16.0-16.3;
          // use the same helper as the steward/bridge/manifest paths.
          const { signal, dispose } = createTimeoutSignal(20_000);
          try {
            return (
              await directCloudFetch(resolveBrowserCloudApiRequestUrl(url), {
                method: "DELETE",
                headers,
                signal,
              })
            ).status;
          } finally {
            dispose();
          }
        })();
    if (status < 200 || status >= 300) {
      return {
        success: false,
        error: `shared bridge delete failed (HTTP ${status})`,
      };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

ElizaClient.prototype.checkBugReportInfo = async function (this: ElizaClient) {
  return this.fetch("/api/bug-report/info");
};

ElizaClient.prototype.submitBugReport = async function (
  this: ElizaClient,
  report,
) {
  return this.fetch("/api/bug-report", {
    method: "POST",
    body: JSON.stringify(report),
  });
};
