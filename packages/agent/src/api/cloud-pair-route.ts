/**
 * Loopback-only `/pair` relay for standalone agent servers.
 * Remote managed pairing terminates at the Cloud edge; explicit local Docker
 * retains this handler so the one-time token resolves before the SPA fallback.
 *
 * Peer admission when `ELIZA_CLOUD_PAIR_DIRECT_RELAY=1`: loopback peers only,
 * plus any ranges in the optional `ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS`
 * comma-separated CIDR allowlist (default empty). The supported local-Docker
 * deployment publishes the port on the host's loopback, so inside the
 * container the TCP peer is the bridge gateway rather than 127.0.0.1 — set
 * e.g. `ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS=172.17.0.0/16` (default bridge)
 * to admit exactly that gateway range. Every CIDR entry widens token
 * redemption to that LAN/VPC segment, so keep the list as narrow as the
 * deployment allows.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  isLoopbackRemoteAddress,
  isRemoteAddressInCidrList,
  resolveCloudApiBaseUrl as resolveCanonicalCloudApiBaseUrl,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import {
  type CloudPairRelaySession,
  parseCloudPairRelaySession,
  renderCloudPairHandoffHtml,
  resolveCloudPairAgentIdFromEnv,
} from "@elizaos/shared/contracts";
import { sweepExpiredEntries } from "./memory-bounds.ts";
import { resolveDirectRequestOrigin } from "./request-origin.js";

const RELAY_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

export function __resetCloudPairRateLimitForTests(): void {
  rateBuckets.clear();
}

/** Test-only observation of bucket-map growth for the sweep regression. */
export function __cloudPairRateLimitBucketCountForTests(): number {
  return rateBuckets.size;
}

function rateLimitConsume(key: string | null): boolean {
  const now = Date.now();
  // A peer that pairs once otherwise leaves its bucket for the process
  // lifetime. Sweeping is gated on map size (threshold 100, the same as both
  // sibling limiters); past that gate every consume scans the map — cheap at
  // these sizes, and the trade the siblings already accept (#29715).
  sweepExpiredEntries(rateBuckets, now, 100);
  const bucketKey = key || "unknown";
  const current = rateBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

function resolveCloudApiBaseUrl(): string {
  return resolveCanonicalCloudApiBaseUrl(
    process.env.NEXT_PUBLIC_API_URL,
  ).replace(/\/+$/, "");
}

function resolveCloudAuthRoot(): string {
  return resolveCloudApiBaseUrl().replace(/\/api\/v1\/?$/, "");
}

interface CloudPairRelayPolicy {
  readonly directRelayEnabled: boolean;
  readonly allowedPeerCidrs: string | undefined;
  readonly agentEnv: Readonly<Record<string, string | undefined>>;
}

function resolveCloudPairRelayPolicy(): CloudPairRelayPolicy {
  const authority = resolveDevCloudEnvAuthority();
  const read = (key: string): string | undefined =>
    authority ? resolveDevCloudAuthorityEnvValue(key) : process.env[key];
  const activationBlocked =
    authority === "staging-default" || authority === "offline";

  return Object.freeze({
    directRelayEnabled:
      !activationBlocked && read("ELIZA_CLOUD_PAIR_DIRECT_RELAY") === "1",
    allowedPeerCidrs: read("ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS"),
    agentEnv: Object.freeze({
      ELIZA_CLOUD_AGENT_ID: read("ELIZA_CLOUD_AGENT_ID"),
      WAIFU_ELIZA_CLOUD_AGENT_ID: read("WAIFU_ELIZA_CLOUD_AGENT_ID"),
    }),
  });
}

function canUseManagedDirectRelay(
  req: http.IncomingMessage,
  policy: CloudPairRelayPolicy,
): boolean {
  if (!policy.directRelayEnabled) return false;
  // The local-only gate must key on the TCP peer, never on request headers:
  // Host and X-Forwarded-Host are client-controlled, so a remote caller
  // could previously spoof a loopback origin and redeem a held pairing token
  // through this relay (W1-037). Non-loopback peers are admitted only through
  // the explicit ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS allowlist (W5-016) —
  // a broad private-range admission would let any LAN/VPC host redeem a
  // leaked token, far beyond the local-Docker bridge gateway the relay
  // exists for.
  const peer = req.socket?.remoteAddress;
  return (
    isLoopbackRemoteAddress(peer) ||
    isRemoteAddressInCidrList(peer, policy.allowedPeerCidrs)
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
  );
}

/**
 * Canonical staging hostnames — mirrors `STAGING_CONSOLE_HOSTS` in
 * `packages/ui/src/utils/cloud-agent-base.ts` plus the wildcard subdomain.
 * Kept local (not imported) to preserve the agent→UI dependency boundary.
 * Update both if the canonical staging host set changes.
 */
const STAGING_CLOUD_HOSTS: ReadonlySet<string> = new Set([
  "staging.eliza.app",
  "api-staging.eliza.app",
  "cloud-staging.eliza.app",
  "staging.elizacloud.ai",
  "api-staging.elizacloud.ai",
  "app-staging.elizacloud.ai",
]);

function isStagingCloudHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    STAGING_CLOUD_HOSTS.has(host) ||
    host.endsWith(".cloud-staging.eliza.app") ||
    host.endsWith(".staging.elizacloud.ai")
  );
}

/**
 * Resolve the Eliza Cloud console dashboard URL for the environment the agent
 * is provisioned against. A staging agent (any canonical staging alias or
 * wildcard subdomain) gets the staging console; everything else gets the
 * production console. This prevents staging users from being bounced to a
 * production dashboard where their account/org/agent does not exist.
 */
function resolveCloudConsoleUrl(): string {
  try {
    const hostname = new URL(resolveCloudAuthRoot()).hostname.toLowerCase();
    if (isStagingCloudHostname(hostname)) {
      return "https://cloud-staging.eliza.app/cloud/agents";
    }
  } catch {
    // error-policy:J3 malformed auth root yields the production default.
  }
  return "https://cloud.eliza.app/cloud/agents";
}

function renderErrorHtml(
  title: string,
  message: string,
  recoveryUrl?: string,
): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeHref = escapeHtml(recoveryUrl ?? resolveCloudConsoleUrl());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle}</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#e5e5e5}
    .card{max-width:28rem;padding:2rem;border-radius:.75rem;background:rgba(255,255,255,.04);text-align:center}
    h1{font-size:1.1rem;margin:0 0 .75rem;font-weight:600}
    p{margin:0 0 1.25rem;opacity:.8;font-size:.9rem;line-height:1.5}
    a{color:#e5e5e5;text-decoration:none;font-size:.85rem;opacity:.7}
    a:hover{opacity:1}
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <a href="${safeHref}" target="_top" rel="noopener">Back to Eliza Cloud</a>
  </div>
</body>
</html>`;
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    ...extraHeaders,
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
    pragma: "no-cache",
    expires: "0",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export async function handleStandaloneCloudPairRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "GET" || url.pathname !== "/pair") return false;

  // Capture every authority-owned relay input once per request. Later env
  // writes cannot enable a blocked relay or redirect an admitted exchange.
  const relayPolicy = resolveCloudPairRelayPolicy();
  if (!canUseManagedDirectRelay(req, relayPolicy)) {
    sendHtml(
      res,
      421,
      renderErrorHtml(
        "Open this agent from Eliza Cloud",
        "Managed sign-in is completed at the agent's Eliza Cloud address. Return to the dashboard and open the agent again.",
      ),
    );
    return true;
  }

  const ip = req.socket.remoteAddress ?? null;
  if (!rateLimitConsume(ip)) {
    sendHtml(
      res,
      429,
      renderErrorHtml(
        "Too many sign-in attempts",
        "Wait a minute and try opening your agent again.",
      ),
    );
    return true;
  }

  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    sendHtml(
      res,
      400,
      renderErrorHtml(
        "Missing pairing token",
        "Open the agent from Eliza Cloud so a fresh sign-in link is generated.",
      ),
    );
    return true;
  }

  // The origin forwarded to the Cloud exchange is reconstructed from direct
  // request metadata only — forwarded headers are client-controlled and must
  // not be able to rewrite the origin the exchange is bound to (W1-037).
  const origin = resolveDirectRequestOrigin(req);
  if (!origin) {
    sendHtml(
      res,
      400,
      renderErrorHtml(
        "Missing origin",
        "Your browser did not send a Host header. Try again from a standard browser.",
      ),
    );
    return true;
  }

  const agentId = resolveCloudPairAgentIdFromEnv(relayPolicy.agentEnv);
  if (!agentId) {
    sendHtml(
      res,
      503,
      renderErrorHtml(
        "Agent identity unavailable",
        "This local agent is missing its platform identity. Restart it from Eliza Cloud and try again.",
      ),
    );
    return true;
  }

  const exchangeUrl = `${resolveCloudAuthRoot()}/api/auth/pair`;
  let exchanged: CloudPairRelaySession | null = null;
  let status = 0;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ token, agentId }),
      signal: controller.signal,
    });
    status = response.status;
    if (response.ok) {
      // error-policy:J3 a successful dependency response is still untrusted;
      // malformed JSON or missing bearer ownership becomes an explicit 502.
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw error;
        }
        // error-policy:J3 malformed dependency JSON becomes an explicit invalid result.
        body = null;
      }
      exchanged = parseCloudPairRelaySession(body);
    } else if (status !== 401 && status !== 403 && status !== 410) {
      // 401/403/410 are logged separately as pairing-link rejections below;
      // only unexpected non-2xx statuses get the generic warning here.
      logger.warn(
        `[cloud-pair] exchange returned non-2xx status=${status} exchangeUrl=${exchangeUrl} requestOrigin=${origin}`,
      );
    }
  } catch (err) {
    // error-policy:J1 transport/abort failures become a structured 503 page.
    const timedOut = err instanceof Error && err.name === "AbortError";
    logger.error(
      `[cloud-pair] exchange ${timedOut ? "timed out" : "failed"} url=${exchangeUrl} error=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    sendHtml(
      res,
      503,
      renderErrorHtml(
        "Eliza Cloud is unreachable",
        timedOut
          ? "Eliza Cloud did not respond in time. We could not confirm whether sign-in completed. Open your agent again from Eliza Cloud to get a fresh link."
          : "We could not reach Eliza Cloud or confirm whether sign-in completed. Open your agent again from Eliza Cloud to get a fresh link.",
      ),
      { "retry-after": "60" },
    );
    return true;
  } finally {
    clearTimeout(timeoutId);
  }

  if (status === 401 || status === 403 || status === 410) {
    // Cloud returns one opaque body for ALL rejection causes: expired,
    // already-redeemed, unknown-to-this-environment, origin-not-bound, and
    // malformed. The relay cannot determine which cause applies, so the
    // rendered copy must NOT assert a specific cause — only that the link
    // could not be verified. See issue #18184.
    logger.warn(
      `[cloud-pair] pairing link rejected status=${status} exchangeUrl=${exchangeUrl} requestOrigin=${origin}`,
    );
    sendHtml(
      res,
      403,
      renderErrorHtml(
        "Sign-in link could not be verified",
        "Eliza Cloud could not verify this pairing link. It may have already been used, or does not match this agent. Open your agent again from Eliza Cloud to get a fresh link.",
      ),
    );
    return true;
  }

  if (status === 429) {
    sendHtml(
      res,
      429,
      renderErrorHtml(
        "Too many sign-in attempts",
        "Wait a minute and try opening your agent again.",
      ),
    );
    return true;
  }

  if (status >= 500) {
    // A 5xx does not reveal whether Cloud consumed the one-time token before
    // failing. Keep the copy neutral and recover through a fresh link rather
    // than inviting a replay; Retry-After describes upstream availability.
    sendHtml(
      res,
      502,
      renderErrorHtml(
        "Eliza Cloud hit an error",
        "Eliza Cloud returned an internal error, so we could not confirm whether sign-in completed. Wait a moment, then open your agent again from Eliza Cloud to get a fresh link.",
      ),
      { "retry-after": "60" },
    );
    return true;
  }

  if (!exchanged) {
    // Two remaining failure shapes: a 2xx whose body failed session parsing
    // (Cloud really did accept the link), or an unexpected non-2xx status.
    // Neither is recoverable by re-visiting this one-time URL.
    const accepted = status >= 200 && status < 300;
    sendHtml(
      res,
      502,
      renderErrorHtml(
        "Sign-in failed",
        accepted
          ? "Eliza Cloud accepted the link but did not return a valid agent session. Open your agent again from Eliza Cloud to get a fresh link."
          : `Eliza Cloud returned an unexpected response (status ${status}), so your sign-in link could not be verified. Open your agent again from Eliza Cloud to get a fresh link.`,
      ),
    );
    return true;
  }

  logger.info(
    `[cloud-pair] exchange ok agent=${exchanged.agentName ?? "agent"}`,
  );
  sendHtml(
    res,
    200,
    renderCloudPairHandoffHtml(exchanged.apiKey, exchanged.agentId),
  );
  return true;
}
