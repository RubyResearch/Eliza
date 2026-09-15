/**
 * Auth, CORS, pairing, terminal, and WebSocket auth helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { type AgentRuntime, logger } from "@elizaos/core";
import {
  isCloudProvisionedContainer,
  isLoopbackBindHost,
  isNullOriginAllowed,
  isTrustedLocalRequest as isTrustedLocalRequestShared,
  isWildcardBindHost,
  readAliasedEnv,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveApiBindHost,
  resolveApiSecurityConfig,
  resolveApiToken,
  setApiToken,
  stripOptionalHostPort,
} from "@elizaos/shared";
import { normalizeHostPairingCode } from "@elizaos/shared/host-use-cases";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import { isRegisteredTokenRoleAuthorized } from "./boundary-role-resolver.ts";
import { sweepExpiredEntries } from "./memory-bounds.ts";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i;
const APP_ORIGIN_RE =
  /^(capacitor|capacitor-electron|app|tauri|file|electrobun):\/\/.*$/i;
const CREDENTIALED_APP_ORIGIN_RE =
  /^(capacitor|capacitor-electron|app|tauri|electrobun):\/\/.*$/i;

export const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Token",
  "X-Api-Key",
  "X-Eliza-Token",
  "X-ElizaOS-Token",
  "X-Server-Token",
  "X-Waifu-Chat-Access-Token",
  "X-Eliza-Export-Token",
  "X-Eliza-Client-Id",
  "X-ElizaOS-Client-Id",
  "X-Eliza-Terminal-Token",
  "X-Eliza-Platform",
  "X-Eliza-UI-Language",
  "X-ElizaOS-UI-Language",
  "X-Browser-Bridge-Companion-Id",
  "X-Eliza-Browser-Companion-Id",
  "X-Eliza-CSRF",
  "X-ElizaOS-Turn-Correlation",
  "X-ElizaOS-Turn-Attempt",
  "X-Eliza-Trace-Id",
  "X-Server-Token",
].join(", ");

/**
 * Hostname allowlist for DNS rebinding protection.
 * Requests with a Host header that doesn't match a known loopback name are
 * rejected before CORS / auth processing.  This prevents a malicious page
 * from rebinding its DNS to 127.0.0.1 and reading the unauthenticated API.
 */
const LOCAL_HOST_RE =
  /^(localhost|127\.0\.0\.1|\[?::1\]?|\[?0:0:0:0:0:0:0:1\]?|::ffff:127\.0\.0\.1)$/;

/** Wildcard bind addresses that listen on all interfaces. */
const WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/;

export function isAllowedHost(req: http.IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true; // No Host header -> non-browser client (e.g. curl)

  let hostname: string;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return true;

  if (trimmed.startsWith("[")) {
    // Bracketed IPv6: [::1]:31337 -> ::1
    const close = trimmed.indexOf("]");
    hostname = close > 0 ? trimmed.slice(1, close) : trimmed.slice(1);
  } else if ((trimmed.match(/:/g) || []).length >= 2) {
    // Bare IPv6 (multiple colons, no brackets): ::1 -> ::1
    hostname = trimmed;
  } else {
    // IPv4 or hostname: localhost:31337 -> localhost
    hostname = stripOptionalHostPort(trimmed);
  }

  if (!hostname) return true;

  const bindHost = resolveApiBindHost(process.env).toLowerCase();

  // When binding on all interfaces (0.0.0.0 / ::), any Host is acceptable --
  // ensureApiTokenForBindHost already enforces a token for non-loopback binds.
  if (WILDCARD_BIND_RE.test(stripOptionalHostPort(bindHost))) {
    return true;
  }

  // Allow the exact configured bind hostname.
  if (bindHost && hostname === stripOptionalHostPort(bindHost)) {
    return true;
  }

  for (const allowedHost of resolveAllowedHosts(process.env)) {
    if (stripOptionalHostPort(allowedHost).toLowerCase() === hostname) {
      return true;
    }
  }

  return LOCAL_HOST_RE.test(hostname);
}

export function resolveCorsOrigin(origin?: string): string | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (!trimmed) return null;

  // Cloud-provisioned containers default to allowing all origins so the
  // browser web UI can reach the agent API without extra config.
  if (readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1") {
    return trimmed;
  }

  // When bound to a wildcard address, allow any origin. Non-loopback binds still
  // require an explicit token, so this only relaxes the browser origin check.
  const bindHost = resolveApiBindHost(process.env).toLowerCase();
  if (WILDCARD_BIND_RE.test(stripOptionalHostPort(bindHost))) return trimmed;

  // Explicit allowlist via env (comma-separated)
  const allow = resolveAllowedOrigins(process.env);
  if (allow.includes(trimmed)) {
    return trimmed;
  }

  if (isWaifuHostedChatOrigin(trimmed)) return trimmed;
  if (LOCAL_ORIGIN_RE.test(trimmed)) return trimmed;
  if (APP_ORIGIN_RE.test(trimmed)) return trimmed;
  if (trimmed === "null" || trimmed === "file://") {
    if (isNullOriginAllowed(process.env)) {
      return "null";
    }
  }
  return null;
}

/**
 * Browser credentials are narrower than CORS reachability. Cloud and wildcard
 * binds may reflect an origin for explicit bearer-token clients, but ambient
 * cookies are enabled only for configured or app-owned origin classes.
 */
export function isCredentialedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === "null" || trimmed.startsWith("file:")) {
    return false;
  }

  const configuredOrigin = resolveAllowedOrigins(process.env).find(
    (allowedOrigin) => allowedOrigin === trimmed,
  );
  if (configuredOrigin) return true;

  return (
    LOCAL_ORIGIN_RE.test(trimmed) || CREDENTIALED_APP_ORIGIN_RE.test(trimmed)
  );
}

function isBrowserCompanionExtensionOrigin(
  origin: string | undefined,
): boolean {
  if (!origin) {
    return false;
  }
  const trimmed = origin.trim();
  return (
    /^chrome-extension:\/\/[a-z]{32}$/i.test(trimmed) ||
    /^moz-extension:\/\/[0-9a-f-]+$/i.test(trimmed) ||
    /^safari-web-extension:\/\/[A-Za-z0-9.-]+$/i.test(trimmed)
  );
}

function resolveWaifuFrameAncestors(): string | null {
  if (!process.env.WAIFU_CHAT_ACCESS_JWT_SECRET?.trim()) return null;
  const configured = process.env.WAIFU_CHAT_FRAME_ANCESTORS?.trim();
  if (configured) return configured;
  return "https://waifu.fun https://*.waifu.fun";
}

function isWaifuHostedChatOrigin(origin: string): boolean {
  if (!process.env.WAIFU_CHAT_ACCESS_JWT_SECRET?.trim()) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "waifu.fun" ||
        parsed.hostname.endsWith(".waifu.fun"))
    );
  } catch {
    return false;
  }
}

function isBrowserCompanionCapabilityPath(pathname: string): boolean {
  return (
    pathname === "/api/browser-bridge/companions/revoke" ||
    pathname === "/api/browser-bridge/companions/preflight" ||
    pathname === "/api/browser-bridge/companions/sync" ||
    /^\/api\/browser-bridge\/companions\/sessions\/[^/]+\/(?:actions\/begin|progress|complete)$/.test(
      pathname,
    )
  );
}

export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): boolean {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const isBrowserCompanionOrigin = isBrowserCompanionExtensionOrigin(origin);
  const allowBrowserCompanionOrigin =
    isBrowserCompanionCapabilityPath(pathname) && isBrowserCompanionOrigin;
  if (isBrowserCompanionOrigin && !allowBrowserCompanionOrigin) return false;
  const allowed = allowBrowserCompanionOrigin
    ? (origin?.trim() ?? null)
    : resolveCorsOrigin(origin);

  if (origin && !allowed) return false;

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
    if (!allowBrowserCompanionOrigin && isCredentialedCorsOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  const waifuFrameAncestors = resolveWaifuFrameAncestors();
  if (waifuFrameAncestors) {
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors ${waifuFrameAncestors}`,
    );
  } else {
    res.setHeader("X-Frame-Options", "DENY");
  }
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  return true;
}

// ---------------------------------------------------------------------------
// Auth token
// ---------------------------------------------------------------------------

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getConfiguredApiToken(): string | undefined {
  // Deliberately NOT resolveSelfApiCredential: this helper backs isAuthorized,
  // isWebSocketAuthorized, resolveWebSocketUpgradeRejection, pairingEnabled,
  // ensureApiTokenForBindHost and resolveTerminalRunRejection. Accepting the
  // plugin-level compat key ELIZA_API_AUTH_TOKEN here would promote it into the
  // inbound credential for every remote client, flip apiTokenEnabled under a
  // legacy-only config (403-ing loopback terminal runs), and satisfy
  // ensureApiTokenForBindHost's early return so the #12228 wildcard-bind
  // hardening never mints its 32-byte token. resolveSelfApiCredential stays a
  // caller-side resolver for requests this process makes back to its own API.
  return resolveApiToken(process.env) ?? undefined;
}

/**
 * Extract an API token from an SSE handshake's query string.
 *
 * EventSource cannot set request headers, so browser SSE clients have no way
 * to send `Authorization: Bearer …`. Cloud already opts in to `?token=` for
 * the WebSocket path via `ELIZA_ALLOW_WS_QUERY_TOKEN=1`; this mirrors that
 * trust model for SSE GETs while keeping the gate tightly scoped:
 *  - same env flag (cloud-only, never silently enabled elsewhere),
 *  - method must be GET (read-only),
 *  - `Accept` must include `text/event-stream` so JSON endpoints with a stray
 *    `?token=` cannot bypass the header path or leak via proxy access logs.
 * The returned token is still validated by `tokenMatches` against
 * `getConfiguredApiToken()` — same crypto.timingSafeEqual path as Bearer.
 */
function extractSseQueryToken(req: http.IncomingMessage): string | null {
  if (readAliasedEnv("ELIZA_ALLOW_WS_QUERY_TOKEN") !== "1") return null;
  if ((req.method ?? "GET").toUpperCase() !== "GET") return null;
  const accept = firstHeaderValue(req.headers.accept) ?? "";
  if (!accept.toLowerCase().includes("text/event-stream")) return null;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw =
      url.searchParams.get("token") ??
      url.searchParams.get("apiKey") ??
      url.searchParams.get("api_key");
    const trimmed = raw?.trim();
    return trimmed && trimmed.length <= 1024 ? trimmed : null;
  } catch {
    return null;
  }
}

export function extractAuthToken(req: http.IncomingMessage): string | null {
  const rawAuth =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  if (rawAuth.length > 8192) return null;
  const auth = rawAuth.trim();
  if (
    auth &&
    auth.length >= 7 &&
    auth.slice(0, 7).toLowerCase() === "bearer "
  ) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  const header =
    (typeof req.headers["x-eliza-token"] === "string" &&
      req.headers["x-eliza-token"]) ||
    (typeof req.headers["x-elizaos-token"] === "string" &&
      req.headers["x-elizaos-token"]) ||
    (typeof req.headers["x-waifu-chat-access-token"] === "string" &&
      req.headers["x-waifu-chat-access-token"]) ||
    (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"]);
  if (typeof header === "string" && header.trim()) return header.trim();

  const sseToken = extractSseQueryToken(req);
  if (sseToken) return sseToken;

  return null;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

/**
 * Same-machine dashboard trust for the agent server. Delegates to the canonical
 * `@elizaos/shared` parser with the agent's exact policy gates:
 *  - cloudCheck "container": `isCloudProvisionedContainer()` (the flag AND a
 *    provisioning token), NOT the raw `ELIZA_CLOUD_PROVISIONED` flag.
 *  - requireLocalAuthEnv: on-device local agents (Android) set
 *    `ELIZA_REQUIRE_LOCAL_AUTH=1` alongside a per-boot `ELIZA_API_TOKEN`, so
 *    loopback alone is not a trust signal there.
 *  - NO dev-auth bypass: the agent never honours `ELIZA_DEV_AUTH_BYPASS`.
 */
export function isTrustedLocalRequest(req: http.IncomingMessage): boolean {
  return isTrustedLocalRequestShared(req, {
    requireLocalAuthEnv: true,
    devAuthBypassEnv: false,
    cloudCheck: "container",
  });
}

/**
 * Resolve the shared service-to-service secret used by the cloud gateways to
 * authenticate inbound forwards to this container. The Discord / webhook
 * gateways attach this value as the `X-Server-Token` header on
 * `POST /agents/:id/message` (see gateway-discord `forwardToServer`). It is the
 * same contract the Kubernetes `agent-server` honours; mirroring it here lets a
 * provisioned container accept gateway-routed messages without the gateway
 * having to know the per-agent inbound API token.
 *
 * Returns an empty string when unconfigured, in which case the X-Server-Token
 * path is disabled and existing Bearer / loopback auth is unaffected.
 *
 * Security: a matching `X-Server-Token` authorizes route admission
 * (`isAuthorized`) but remains a service-gateway principal for owner-private
 * disclosure. It is still a bearer credential and MUST be a high-entropy
 * random value of at least 32 bytes (≥256 bits; e.g. `openssl rand -hex 32`).
 * Never use a human-chosen or dictionary string. The comparison is timing-safe
 * (`tokenMatches`), but entropy is the only defense against guessing.
 * (#12228 L11)
 */
function getServerSharedSecret(): string {
  const raw = process.env.AGENT_SERVER_SHARED_SECRET;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Extract the `X-Server-Token` header value, if present and non-empty.
 */
function extractServerToken(req: http.IncomingMessage): string | null {
  const value = req.headers["x-server-token"];
  const token = firstHeaderValue(value);
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

/**
 * True when the request carries a valid `X-Server-Token` matching the
 * configured `AGENT_SERVER_SHARED_SECRET`. When the secret is unset this always
 * returns false, so the header carries no authority and there is no regression
 * for deployments that never configure it.
 */
export function isServerTokenAuthorized(req: http.IncomingMessage): boolean {
  const expected = getServerSharedSecret();
  if (!expected) return false;
  const provided = extractServerToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

export function isAuthorized(req: http.IncomingMessage): boolean {
  if (isTrustedLocalRequest(req)) return true;

  // Accept the cloud gateway's shared service token first (mirrors the K8s
  // agent-server contract). Disabled automatically when the secret is unset.
  if (isServerTokenAuthorized(req)) return true;

  const expected = getConfiguredApiToken();
  if (!expected) return false;
  const provided = extractAuthToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

/**
 * Whether a request is authorized by a registered product boundary-role
 * resolver (#12087 item 12). The trunk holds no product token vocabulary; each
 * product (e.g. WaifuChat) registers a resolver that owns its own token parsing
 * and route allowlist. Returns false when no resolver recognises the request,
 * so the caller falls through to the trunk's own token/loopback auth.
 */
export function isBoundaryRoleAuthorized(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
): boolean {
  return isRegisteredTokenRoleAuthorized(req, method, pathname);
}

/** The canonical role at the agent HTTP boundary (#9948 / #12087 Item 13). */
export type BoundaryRole = "OWNER" | "GUEST";

/**
 * #12087 Item 13: the single token→role collapse for agent HTTP routes. An
 * authorized caller (trusted loopback owner or a valid API token) is the OWNER
 * principal; everyone else is GUEST — the server-authoritative unauthenticated
 * tier (#9948). Routes must use this instead of re-deriving `isAuthorized(req) ?
 * "OWNER" : "GUEST"` inline (which drifted to NONE elsewhere). app-core's
 * resolveBoundaryRole is deliberately not importable from the agent, so this is
 * the agent-local equivalent with the same OWNER/GUEST vocabulary.
 */
export function resolveBoundaryRole(req: http.IncomingMessage): BoundaryRole {
  return isAuthorized(req) ? "OWNER" : "GUEST";
}

export function ensureApiTokenForBindHost(host: string): void {
  const { disableAutoApiToken } = resolveApiSecurityConfig(process.env);

  const token = getConfiguredApiToken();
  if (token) return;

  const cloudProvisioned = isCloudProvisionedContainer();
  const wildcardBind = isWildcardBindHost(host);

  // M7 (#12228): a wildcard bind (0.0.0.0 / ::) relaxes both the DNS-rebind
  // Host check (`hostAllowed`) and the CORS origin check (`resolveCorsOrigin`
  // reflects any origin). With ELIZA_DISABLE_AUTO_API_TOKEN=1
  // and no explicit ELIZA_API_TOKEN that leaves the server listening on every
  // interface with *no* authenticated boundary and both browser-origin
  // protections off — silently wide open. Refuse to honor the disable flag in
  // that exact combo: force a generated token so a real auth boundary exists.
  // (A specific non-loopback IP bind keeps Host+CORS enforced, so the disable
  // flag is still honored there.)
  const forceTokenForWildcard = wildcardBind && disableAutoApiToken;

  // Cloud-provisioned containers must never run without an inbound API token
  // (isAuthorized rejects all requests when no token + cloud flag is set).
  // Override the disable flag for cloud containers so they always get a
  // fallback token rather than dead-locking into 401 on every request.
  if (disableAutoApiToken && !cloudProvisioned && !forceTokenForWildcard) {
    return;
  }
  if (forceTokenForWildcard) {
    logger.warn(
      `[eliza-api] ELIZA_API_BIND=${host} is a wildcard bind and ELIZA_DISABLE_AUTO_API_TOKEN is set with no ELIZA_API_TOKEN. Refusing to start without an authenticated boundary: forcing a generated API token. DNS-rebind + CORS checks stay relaxed for wildcard binds, so this token is the only boundary. Set ELIZA_API_TOKEN explicitly, or bind to 127.0.0.1, to override.`,
    );
  }
  if (!cloudProvisioned && !forceTokenForWildcard && isLoopbackBindHost(host))
    return;

  const generated = crypto.randomBytes(32).toString("hex");
  setApiToken(process.env, generated);

  if (cloudProvisioned) {
    logger.warn(
      "[eliza-api] Steward-managed cloud container started without ELIZA_API_TOKEN; generated a temporary inbound API token for this process.",
    );
  } else {
    logger.warn(
      `[eliza-api] ELIZA_API_BIND=${host} is non-loopback and ELIZA_API_TOKEN is unset.`,
    );
  }
  const tokenFingerprint = `${generated.slice(0, 4)}...${generated.slice(-4)}`;
  logger.warn(
    `[eliza-api] Generated temporary API token (${tokenFingerprint}) for this process. Set ELIZA_API_TOKEN explicitly to override.`,
  );
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let pairingCode: string | null = null;
let pairingExpiresAt = 0;
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

export function pairingEnabled(): boolean {
  return (
    Boolean(getConfiguredApiToken()) &&
    readAliasedEnv("ELIZA_PAIRING_DISABLED") !== "1"
  );
}

export function normalizePairingCode(code: string): string {
  return normalizeHostPairingCode(code);
}

function generatePairingCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function ensurePairingCode(): string | null {
  if (!pairingEnabled()) return null;
  const now = Date.now();
  if (!pairingCode || now > pairingExpiresAt) {
    pairingCode = generatePairingCode();
    pairingExpiresAt = now + PAIRING_TTL_MS;
    logger.warn(
      `[eliza-api] Pairing code: ${pairingCode} (valid for 10 minutes)`,
    );
  }
  return pairingCode;
}

export function rateLimitPairing(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();

  // Lazy sweep: evict expired entries when map grows beyond 100
  sweepExpiredEntries(pairingAttempts, now, 100);

  const current = pairingAttempts.get(key);
  if (!current || now > current.resetAt) {
    pairingAttempts.set(key, { count: 1, resetAt: now + PAIRING_WINDOW_MS });
    return true;
  }
  if (current.count >= PAIRING_MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

export function getPairingExpiresAt(): number {
  return pairingExpiresAt;
}

export function clearPairing(): void {
  pairingCode = null;
  pairingExpiresAt = 0;
}

// ---------------------------------------------------------------------------
// WebSocket client ID
// ---------------------------------------------------------------------------

const SAFE_WS_CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function normalizeWsClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!SAFE_WS_CLIENT_ID_RE.test(trimmed)) return null;
  return trimmed;
}

export function resolveTerminalRunClientId(
  req: Pick<http.IncomingMessage, "headers">,
  body: { clientId?: unknown } | null | undefined,
): string | null {
  const headerClientId = normalizeWsClientId(
    firstHeaderValue(req.headers["x-eliza-client-id"]),
  );
  if (headerClientId) return headerClientId;
  return normalizeWsClientId(body?.clientId);
}

const SHARED_TERMINAL_CLIENT_IDS = new Set([
  "runtime-terminal-action",
  "runtime-shell-action",
]);

export function isSharedTerminalClientId(clientId: string): boolean {
  return SHARED_TERMINAL_CLIENT_IDS.has(clientId);
}

// ---------------------------------------------------------------------------
// Terminal run rejection
// ---------------------------------------------------------------------------

interface TerminalRunRequestBody {
  terminalToken?: string;
}

export interface TerminalRunRejection {
  status: 401 | 403;
  reason: string;
}

export function resolveTerminalRunRejection(
  req: http.IncomingMessage,
  body: TerminalRunRequestBody,
): TerminalRunRejection | null {
  const expected = readAliasedEnv("ELIZA_TERMINAL_RUN_TOKEN");
  const apiTokenEnabled = Boolean(getConfiguredApiToken());

  // Compatibility mode: local loopback sessions without API token keep
  // existing behavior unless an explicit terminal token is configured.
  if (!expected && !apiTokenEnabled) {
    return null;
  }

  if (!expected) {
    return {
      status: 403,
      reason:
        "Terminal run is disabled for token-authenticated API sessions. Set ELIZA_TERMINAL_RUN_TOKEN to enable command execution.",
    };
  }

  const headerToken =
    typeof req.headers["x-eliza-terminal-token"] === "string"
      ? req.headers["x-eliza-terminal-token"].trim()
      : "";
  const bodyToken =
    typeof body.terminalToken === "string" ? body.terminalToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing terminal token. Provide X-Eliza-Terminal-Token header or terminalToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return {
      status: 401,
      reason: "Invalid terminal token.",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// WebSocket upgrade
// ---------------------------------------------------------------------------

function extractWsQueryToken(url: URL): string | null {
  const allowQueryToken = readAliasedEnv("ELIZA_ALLOW_WS_QUERY_TOKEN") === "1";
  if (!allowQueryToken) return null;

  const token =
    url.searchParams.get("token") ??
    url.searchParams.get("apiKey") ??
    url.searchParams.get("api_key");
  return token?.trim() || null;
}

export function extractWebSocketHandshakeToken(
  request: http.IncomingMessage,
  url: URL,
): string | null {
  const headerToken = extractAuthToken(request);
  if (headerToken) return headerToken;
  return extractWsQueryToken(url);
}

export function isWebSocketAuthorized(
  request: http.IncomingMessage,
  url: URL,
): boolean {
  const expected = getConfiguredApiToken();
  if (!expected) {
    return !isCloudProvisionedContainer() && isTrustedLocalRequest(request);
  }

  const handshakeToken = extractWebSocketHandshakeToken(request, url);
  // HTTP already authorizes this exact same-machine boundary. Configuring a
  // credential for remote devices must not strand the local dashboard in a
  // post-open auth timeout; strict-local-auth and cloud gates still apply.
  if (!handshakeToken) return isTrustedLocalRequest(request);
  return tokenMatches(expected, handshakeToken);
}

export interface WebSocketUpgradeRejection {
  status: 401 | 403 | 404;
  reason: string;
}

export function resolveWebSocketUpgradeRejection(
  req: http.IncomingMessage,
  wsUrl: URL,
): WebSocketUpgradeRejection | null {
  if (wsUrl.pathname !== "/ws") {
    return { status: 404, reason: "Not found" };
  }

  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const allowedOrigin = resolveCorsOrigin(origin);
  if (origin && !allowedOrigin) {
    return { status: 403, reason: "Origin not allowed" };
  }

  const expected = getConfiguredApiToken();
  if (!expected) {
    return !isCloudProvisionedContainer() && isTrustedLocalRequest(req)
      ? null
      : { status: 401, reason: "Unauthorized" };
  }

  // Note: we used to reject upgrades when a query token was present but
  // ELIZA_ALLOW_WS_QUERY_TOKEN was not "1". That veto was actively harmful —
  // browsers cannot set Authorization on `new WebSocket(url)`, so SPAs have no
  // option but to pass the token in the URL. extractWsQueryToken() already
  // returns null when the flag is off, so handshakeToken simply falls through
  // to header-or-null and the post-open `{type:"auth"}` fallback covers
  // self-hosted setups behind header-aware upstream proxies.

  const handshakeToken = extractWebSocketHandshakeToken(req, wsUrl);
  if (handshakeToken && !tokenMatches(expected, handshakeToken)) {
    return { status: 401, reason: "Unauthorized" };
  }

  // Cloud containers must authenticate at the handshake level because there is
  // no trusted upstream proxy handling auth for the WebSocket path.
  if (!handshakeToken && isCloudProvisionedContainer()) {
    return { status: 401, reason: "Unauthorized" };
  }

  return null;
}

/**
 * Resolve a WebSocket-presented bearer that is NOT the static connection key
 * against the host's session store. Device pairing deliberately mints a
 * revocable machine-session id as the client bearer (#13985); REST accepts it
 * through the host bridge's request authorization, and both WebSocket auth
 * paths (handshake token and in-band `{type:"auth"}`) accept it through this
 * same seam. Fail-closed: a missing bridge method (hostless agent), an
 * unavailable session store, a store failure, or an unknown/expired/revoked
 * session all deny.
 */
export async function isWebSocketSessionTokenAuthorized(
  token: string,
  runtime: AgentRuntime | null,
): Promise<boolean> {
  const resolveSessionToken =
    getAgentHostBridge().resolveSessionTokenAuthorization;
  if (typeof resolveSessionToken !== "function") return false;
  try {
    const resolved = await resolveSessionToken(token, runtime);
    return resolved.ok === true;
  } catch (err) {
    // error-policy:J4 session-store failure → fail-closed deny; the outage is
    // surfaced here rather than collapsing silently into a stream of 1008s.
    logger.warn(
      `[eliza-api] WebSocket session-token resolution failed; denying: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * Upgrade requests whose handshake bearer resolved to an active host session.
 * The session lookup is async and runs in the upgrade handler, but the
 * connection handler computes its initial auth state synchronously — the
 * verdict travels on the request object's identity between the two.
 */
const sessionAuthorizedUpgrades = new WeakSet<http.IncomingMessage>();

export function markWebSocketUpgradeSessionAuthorized(
  request: http.IncomingMessage,
): void {
  sessionAuthorizedUpgrades.add(request);
}

export function isWebSocketUpgradeSessionAuthorized(
  request: http.IncomingMessage,
): boolean {
  return sessionAuthorizedUpgrades.has(request);
}

// ---------------------------------------------------------------------------
// Unauthenticated WebSocket bounds (W5-015)
// ---------------------------------------------------------------------------

/**
 * Credential-less upgrades are allowed so browser clients can authenticate
 * post-open with `{type:"auth"}` — browsers cannot set Authorization on
 * `new WebSocket(url)`. An unbounded accept was a remote FD-exhaustion DoS:
 * every completed handshake pinned a file descriptor forever. Two bounds now
 * apply: this per-peer cap on concurrent pre-auth sockets, and a post-open
 * auth grace period (enforced in server.ts, cleared on `auth-ok`) after which
 * the server closes a socket that never authenticated.
 */
export const WS_AUTH_GRACE_TIMEOUT_MS = 10_000;
export const MAX_PENDING_WEBSOCKETS_PER_PEER = 16;

const pendingWebSocketsByPeer = new Map<string, number>();

/**
 * Reserve a pre-auth slot for the peer; false when the peer is at the cap.
 * Every true return must be paired with {@link releasePendingWebSocket} once
 * the socket authenticates or closes.
 */
export function tryAcquirePendingWebSocket(
  remoteAddress: string | null | undefined,
): boolean {
  const key = remoteAddress || "unknown";
  const current = pendingWebSocketsByPeer.get(key) ?? 0;
  if (current >= MAX_PENDING_WEBSOCKETS_PER_PEER) return false;
  pendingWebSocketsByPeer.set(key, current + 1);
  return true;
}

export function releasePendingWebSocket(
  remoteAddress: string | null | undefined,
): void {
  const key = remoteAddress || "unknown";
  const current = pendingWebSocketsByPeer.get(key) ?? 0;
  if (current <= 1) pendingWebSocketsByPeer.delete(key);
  else pendingWebSocketsByPeer.set(key, current - 1);
}

export function __resetPendingWebSocketsForTests(): void {
  pendingWebSocketsByPeer.clear();
}

/** Current pre-auth socket count for the peer — test/diagnostic visibility. */
export function pendingWebSocketCount(
  remoteAddress: string | null | undefined,
): number {
  return pendingWebSocketsByPeer.get(remoteAddress || "unknown") ?? 0;
}

export function rejectWebSocketUpgrade(
  socket: import("node:stream").Duplex,
  statusCode: number,
  message: string,
): void {
  const statusText =
    statusCode === 401
      ? "Unauthorized"
      : statusCode === 403
        ? "Forbidden"
        : statusCode === 404
          ? "Not Found"
          : "Bad Request";
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
    () => socket.end(),
  );
}
