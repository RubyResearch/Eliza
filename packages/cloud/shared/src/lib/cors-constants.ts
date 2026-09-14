/**
 * Single source of truth for CORS headers on API responses and preflight.
 *
 * Wildcard origin (`*`) is used for most `/api/*` routes — access control is via
 * API keys, sessions, and other auth headers (not browser origin).
 *
 * For first-party flows that need cookies cross-origin, use
 * `getCorsHeaders` in `packages/lib/utils/cors.ts` (origin allowlist +
 * `Access-Control-Allow-Credentials: true`).
 */

/** Same header names as legacy comma-joined `CORS_ALLOW_HEADERS` — use for Hono `cors({ allowHeaders })`. */
export const CORS_ALLOW_HEADER_NAMES = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-Eliza-Dedicated-Price",
  "X-App-Id",
  "X-Request-ID",
  // Note: Cookie is ineffective with wildcard origin but listed for non-wildcard CORS flows
  "Cookie",
  "X-Miniapp-Token",
  "X-Anonymous-Session",
  "X-Gateway-Secret",
  "X-Wallet-Address",
  "X-Timestamp",
  "X-Wallet-Signature",
  "X-Service-Key",
  "Cache-Control",
  "X-Agent-Client-Id",
  "X-PAYMENT",
  "X-PAYMENT-RESPONSE",
  "X-PAYMENT-STATUS",
  "X-Steward-Tenant",
  // Custom CSRF marker required on cookie-authenticated mutating auth routes
  // (steward-session, steward-nonce-exchange, cli-session/complete,
  // migrate-anonymous). Must be allow-listed or the first-party SPA's
  // credentialed preflight fails. See lib/auth/browser-origin-policy.ts.
  "X-Eliza-CSRF",
  // Read by /api/v1/chat/completions for safe retries (idempotency-key) and
  // affiliate attribution (X-Affiliate-Code); must be in the allow-list or the
  // browser CORS preflight rejects requests that send them.
  "Idempotency-Key",
  "X-Content-SHA256",
  "X-Content-Length",
  "X-Storage-Object-Key",
  "X-Storage-Prefix",
  "X-Storage-Recursive",
  "X-Affiliate-Code",
  // The Eliza app's agent-API client (packages/ui/src/api/client-base.ts) ALWAYS
  // sends these to a shared-runtime agent's REST surface
  // (/api/v1/eliza/agents/:id/api/...). Without them in the allow-list the
  // browser CORS preflight rejects every shared-agent request from the Capacitor
  // WebView. Mirrors the dedicated-agent allow-headers in
  // packages/agent/src/api/server-helpers-auth.ts (CORS_ALLOWED_HEADERS).
  "X-ElizaOS-Client-Id",
  "X-Eliza-Client-Id",
  "X-ElizaOS-UI-Language",
  "X-Eliza-UI-Language",
  // Privacy-safe shared-turn baseline correlation. The first-party client
  // sends an opaque UUID plus a bounded attempt ordinal; the server validates
  // both before emitting measurement logs (#22814).
  "X-ElizaOS-Turn-Correlation",
  "X-ElizaOS-Turn-Attempt",
  // Caller-to-gateway chat correlation. Accept W3C context when present;
  // X-Eliza-Trace-Id covers clients that cannot share Cloudflare's native id.
  "Traceparent",
  "Tracestate",
  "X-Eliza-Trace-Id",
  "X-Eliza-Telemetry",
] as const;

export const CORS_ALLOW_HEADERS = CORS_ALLOW_HEADER_NAMES.join(", ");

/** Browser-visible response headers used by the latency harness and app. */
export const CORS_EXPOSE_HEADER_NAMES = [
  "Server-Timing",
  "X-Request-ID",
  "X-Eliza-Trace-Id",
  "X-Eliza-Preforward-Ms",
  "X-Eliza-Auth-Trace",
  "X-Eliza-Inference-Path",
  "X-Eliza-Provider-Request-Id",
  "X-Eliza-Stream-Scope-Ms",
  "X-Eliza-Stream-Body-Ms",
  "X-Eliza-Stream-Parse-Ms",
  "X-Eliza-Stream-Bridge-Ms",
  "X-Eliza-TTS-Provider",
] as const;

export const CORS_ALLOW_METHOD_NAMES = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const CORS_ALLOW_METHODS = CORS_ALLOW_METHOD_NAMES.join(", ");

export const CORS_MAX_AGE = "86400";

/**
 * The Eliza app WebView / local-dev origins that authenticate with credentials
 * (cookies / native fetch) and therefore get the origin reflected +
 * `Access-Control-Allow-Credentials: true` (a wildcard `*` is invalid for a
 * credentialed cross-origin read such as an SSE chat stream). EXACT-ANCHORED —
 * never a suffix/`endsWith` match. Single source of truth so the Hono-CORS and
 * proxy-CORS allowlists cannot drift. Mirrors the dedicated-agent allow-list in
 * packages/agent/src/api/server-helpers-auth.ts.
 */
export const APP_LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i;
export const APP_SCHEME_ORIGIN_RE =
  /^(capacitor|capacitor-electron|app|tauri|file|electrobun):\/\/.*$/i;

/**
 * Exact Capacitor WebView origin (`iosScheme`/`androidScheme` = "https", no
 * port — see packages/app/capacitor.config.ts). A browser page cannot mint a
 * portless loopback origin for a credentialed cross-origin request, so this
 * one stays first-party in every environment.
 */
export const CAPACITOR_WEBVIEW_ORIGIN = "https://localhost";

/**
 * Loopback http(s) origins any local process can serve (any port, the https
 * and `[::1]` variants, and portless `http://localhost`). Reflecting these
 * WITH `Access-Control-Allow-Credentials: true` in production would let a
 * hostile local page ride a user's cloud session cookies against the API, so
 * every credentialed allowlist (Hono-CORS, utils/cors, proxy/cors) must honor
 * them only outside production (`ENVIRONMENT !== "production"`). The portless
 * {@link CAPACITOR_WEBVIEW_ORIGIN} is excluded — it stays first-party
 * everywhere (see above).
 */
export function isLocalDevLoopbackOrigin(origin: string): boolean {
  return APP_LOCAL_ORIGIN_RE.test(origin) && origin !== CAPACITOR_WEBVIEW_ORIGIN;
}
