/** Routes authenticated connector traffic to cloud identities and agent servers. */

import {
  executeGatewayForwardAttempts,
  type GatewayTargetResult,
  postGatewayTarget,
} from "@elizaos/cloud-services-common/gateway-forward";
import {
  type GatewayServerLookup,
  type GatewayWakeDependencies,
  observeGatewayWake,
  refreshGatewayActivity,
  resolveGatewayAgentServer,
  resolveKedaCooldownSeconds,
  wakeGatewayServer,
} from "@elizaos/cloud-services-common/gateway-routing";
import { reacquireAuthHeader } from "./auth";
import { getHashTargets, refreshHashRing } from "./hash-router";
import { logger } from "./logger";
import type { GatewayRedis } from "./redis";

const KEDA_COOLDOWN_SECONDS = resolveKedaCooldownSeconds(
  process.env.KEDA_COOLDOWN_SECONDS,
);
const FORWARD_TIMEOUT_MS = 30_000;
const MESSAGE_FORWARD_TIMEOUT_MS = 75_000;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_INCREMENT_MS = 1_000;
const IDENTITY_CACHE_TTL_SECONDS = 300;
const AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DNS_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const CANONICAL_ROUTER_ORIGIN_BY_AGENT_DOMAIN: Readonly<
  Record<string, string>
> = Object.freeze({
  "cloud.eliza.app": "eliza-production-1.eliza.app",
  "cloud-staging.eliza.app": "eliza-staging-1.eliza.app",
});

interface CanonicalAgentFallbackTarget {
  baseUrl: string;
  forwardedHost?: string;
}

type CanonicalAgentFallbackEnv = Record<string, string | undefined>;

export interface CanonicalAgentRoutingConfiguration {
  agentBaseDomain: string;
  routerOriginHost: string;
}

export type RoutingRedis = Pick<
  GatewayRedis,
  "get" | "set" | "lpush" | "ltrim" | "expire"
>;

export interface ResolvedIdentity {
  userId: string;
  organizationId: string;
  // Null when the identity is linked to a cloud user that has no provisioned
  // agent yet. Callers must treat this as an onboarding/provisioning condition,
  // never as an agent-server routing target.
  agentId: string | null;
}

/** Resolves one of the two supported production/staging routing pairs. */
export function getCanonicalAgentRoutingConfiguration(
  env: CanonicalAgentFallbackEnv = process.env,
): CanonicalAgentRoutingConfiguration | null {
  const routerOriginHost = env.AGENT_ROUTER_ORIGIN_HOST?.trim().toLowerCase();
  const agentBaseDomain =
    env.ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim().toLowerCase();
  if (!routerOriginHost || !agentBaseDomain) return null;
  if (
    !DNS_HOSTNAME_PATTERN.test(routerOriginHost) ||
    !DNS_HOSTNAME_PATTERN.test(agentBaseDomain) ||
    CANONICAL_ROUTER_ORIGIN_BY_AGENT_DOMAIN[agentBaseDomain] !==
      routerOriginHost
  ) {
    return null;
  }
  return { agentBaseDomain, routerOriginHost };
}

/** Rejects startup before health endpoints bind when routing is unsafe. */
export function requireCanonicalAgentRoutingConfiguration(
  env: CanonicalAgentFallbackEnv = process.env,
): CanonicalAgentRoutingConfiguration {
  const configuration = getCanonicalAgentRoutingConfiguration(env);
  if (!configuration) {
    throw new Error(
      "AGENT_ROUTER_ORIGIN_HOST and ELIZA_CLOUD_AGENT_BASE_DOMAIN must be configured as an exact canonical production or staging pair",
    );
  }
  return configuration;
}

/** Resolves a validated public or router-origin fallback for a cloud agent. */
export function getCanonicalAgentFallbackTarget(
  agentId: string,
  env: CanonicalAgentFallbackEnv = process.env,
): CanonicalAgentFallbackTarget | null {
  if (!AGENT_ID_PATTERN.test(agentId)) return null;
  const normalizedAgentId = agentId.toLowerCase();
  const configuration = getCanonicalAgentRoutingConfiguration(env);
  if (!configuration) return null;
  const forwardedHost = `${normalizedAgentId}.${configuration.agentBaseDomain}`;
  if (!DNS_HOSTNAME_PATTERN.test(forwardedHost)) {
    return null;
  }
  return {
    baseUrl: `https://${configuration.routerOriginHost}/api`,
    forwardedHost,
  };
}

/** Returns the selected fallback base URL for compatibility callers. */
export function getCanonicalAgentFallbackBase(
  agentId: string,
  env: CanonicalAgentFallbackEnv = process.env,
): string | null {
  return getCanonicalAgentFallbackTarget(agentId, env)?.baseUrl ?? null;
}

export async function resolveIdentity(
  redis: RoutingRedis,
  cloudBaseUrl: string,
  authHeader: Record<string, string>,
  platform: string,
  platformId: string,
  platformName?: string,
  reauth: () => Promise<Record<string, string>> = reacquireAuthHeader,
): Promise<ResolvedIdentity | null> {
  const cacheKey = `identity:${platform}:${platformId}`;
  const cached = await redis.get<ResolvedIdentity | { notFound: true }>(
    cacheKey,
  );
  if (cached) {
    if ("notFound" in cached) return null;
    return cached;
  }

  const url = `${cloudBaseUrl}/api/internal/identity/resolve`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const body = JSON.stringify({
      platform,
      platformId,
      ...(platformName ? { platformName } : {}),
    });
    let res = await fetch(url, {
      method: "POST",
      headers: authHeader,
      body,
      signal: controller.signal,
    });
    // A Worker redeploy invalidates the gateway's token until its scheduled
    // refresh, up to ~48 minutes away — and this call runs post-ack, so every
    // 401 in that window is a user-visible silence. Re-bootstrap and retry
    // exactly once; a second 401 falls through to the error path below.
    if (res.status === 401) {
      const freshHeader = await reauth();
      res = await fetch(url, {
        method: "POST",
        headers: freshHeader,
        body,
        signal: controller.signal,
      });
    }
    if (res.status === 404) {
      // An unlinked sender can become linked while the browser onboarding flow
      // is open. Do not cache this transition state: the very next provider
      // message must observe the completed identity link.
      return null;
    }
    if (!res.ok) throw new Error(`Identity resolve failed: ${res.status}`);

    const data = (await res.json()) as
      | {
          userId?: string;
          organizationId?: string;
          agentId?: string | null;
          data?: {
            user?: { id?: string; organizationId?: string };
            agent?: { id?: string | null };
          };
        }
      | {
          success?: boolean;
        };
    const userId =
      "userId" in data
        ? data.userId
        : "data" in data
          ? data.data?.user?.id
          : undefined;
    const organizationId =
      "organizationId" in data
        ? data.organizationId
        : "data" in data
          ? data.data?.user?.organizationId
          : undefined;
    const agentId =
      "agentId" in data
        ? data.agentId
        : "data" in data
          ? (data.data?.agent?.id ?? undefined)
          : undefined;
    // agentId is legitimately null while provisioning is still in flight, so it
    // is not part of the resolution contract. Throwing here used to abort the
    // whole background message pass for a linked-but-unprovisioned user, which
    // dropped their message with no reply at all.
    if (!userId || !organizationId) {
      throw new Error(
        "Identity resolve response missing userId or organizationId",
      );
    }
    // The flat branch above passes the wire value through untouched, and the
    // wire value for "no sandbox" is `null`. Normalise once, here, so no caller
    // has to.
    const identity: ResolvedIdentity = {
      userId,
      organizationId,
      agentId: agentId ?? null,
    };
    // A linked account can gain its assigned agent at any moment during
    // provisioning. Cache only the stable user+agent route so the first message
    // after provisioning cannot be stranded behind a stale agentId:null entry.
    if (identity.agentId) {
      await redis.set(cacheKey, JSON.stringify(identity), {
        ex: IDENTITY_CACHE_TTL_SECONDS,
      });
    }
    return identity;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Why an agent could not be routed to, which is not one condition but two.
 *
 * `agent:<id>:server` is written by a booted container and lives 30 days, while
 * `server:<name>:url` is refreshed by the pod's heartbeat and expires after two
 * minutes. So a missing routing key means the agent has never come up, and a
 * present routing key with no URL means an established agent whose pod is down
 * or scaled to zero. Callers that treat "no route" as "not provisioned yet" —
 * and answer with onboarding — must only do so for `unregistered`.
 */
export type AgentServerLookup = GatewayServerLookup;

export function resolveAgentServer(
  redis: RoutingRedis,
  agentId: string,
): Promise<AgentServerLookup> {
  return resolveGatewayAgentServer(redis, agentId);
}

export function refreshKedaActivity(
  redis: RoutingRedis,
  serverName: string,
): Promise<void> {
  return refreshGatewayActivity(redis, serverName, KEDA_COOLDOWN_SECONDS);
}

export type WakeServerDependencies = Partial<GatewayWakeDependencies>;

export function wakeServer(
  serverName: string,
  serverUrl: string,
  dependencies: WakeServerDependencies = {},
): Promise<void> {
  return wakeGatewayServer(serverName, serverUrl, {
    ...dependencies,
    logError: dependencies.logError ?? logger.error.bind(logger),
  });
}

export function observeWakeServer(
  promise: Promise<void>,
  serverName: string,
  logError: GatewayWakeDependencies["logError"] = logger.error.bind(logger),
): void {
  observeGatewayWake(promise, serverName, logError);
}

/**
 * Optional platform metadata forwarded alongside the chat message so the
 * agent-server can personalize responses, identify the originating platform,
 * and route proactive replies back to the correct chat.
 */
export interface ForwardMessageOptions {
  /** Originating platform identifier (e.g. "telegram", "whatsapp", "twilio", "blooio"). */
  platformName?: string;
  /** Display name of the sender as reported by the platform adapter. */
  senderName?: string;
  /** Platform-specific chat/conversation ID for reply routing. */
  chatId?: string;
  /** Connector account or bot identity that received the platform record. */
  accountId?: string;
  /** Stable platform-native message/update id used for canonical dedupe. */
  platformRecordId?: string;
  /** Platform-native chat type when the adapter exposes it. */
  chatType?: string;
}

/**
 * Builds the JSON body for forwarding a message to the agent-server.
 * Only includes metadata fields that are truthy, keeping the payload
 * backward-compatible when no platform context is available.
 */
export function buildForwardBody(
  userId: string,
  text: string,
  options?: ForwardMessageOptions,
): { userId: string; text: string } & Partial<ForwardMessageOptions> {
  const body: {
    userId: string;
    text: string;
  } & Partial<ForwardMessageOptions> = {
    userId,
    text,
  };
  if (options?.platformName) body.platformName = options.platformName;
  if (options?.senderName) body.senderName = options.senderName;
  if (options?.chatId) body.chatId = options.chatId;
  if (options?.accountId) body.accountId = options.accountId;
  if (options?.platformRecordId)
    body.platformRecordId = options.platformRecordId;
  if (options?.chatType) body.chatType = options.chatType;
  return body;
}

/**
 * Forwards a chat message to the correct agent-server pod via hash-ring routing.
 * Parses the agent-server response to extract the `.response` field expected
 * by platform adapters (e.g. Telegram, WhatsApp sendReply).
 *
 * @param options - Optional platform metadata enriching the POST body with
 *   `platformName`, `senderName`, and `chatId` for downstream personalization
 *   and reply routing. Omitted fields are excluded from the payload.
 */
export async function forwardToServer(
  serverUrl: string,
  serverName: string,
  agentId: string,
  userId: string,
  text: string,
  options?: ForwardMessageOptions,
): Promise<string> {
  const body = buildForwardBody(userId, text, options);

  // senderName and chatId excluded from logs (PII — phone numbers, display names)
  logger.debug("Forwarding message to agent-server", {
    agentId,
    userId,
    platformName: options?.platformName,
  });

  const raw = await forwardWithRetry(
    serverUrl,
    serverName,
    userId,
    `/agents/${agentId}/message`,
    JSON.stringify(body),
    getCanonicalAgentFallbackTarget(agentId),
    {
      timeoutMs: messageForwardTimeoutMs,
      retryOnTimeout: false,
    },
  );
  return parseAgentResponse(raw, agentId);
}

/**
 * Parses and validates an agent-server message response.
 *
 * The agent-server contract is a JSON body with a string `response` field.
 * A 200 with a malformed body (non-JSON, missing `response`, or a non-string
 * `response`) is an upstream failure, not an empty reply: returning `undefined`
 * here would surface as success-shaped silence (adapters drop empty/undefined
 * text without erroring), hiding the fault from logs and the caller. Fail-closed
 * by throwing so `processMessage`'s catch logs a structured forward failure.
 */
export function parseAgentResponse(raw: string, agentId: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Agent-server returned non-JSON response for agent ${agentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const response = (data as { response?: unknown } | null)?.response;
  if (typeof response !== "string") {
    throw new Error(
      `Agent-server response for agent ${agentId} missing string "response" field (got ${typeof response})`,
    );
  }
  return response;
}

/**
 * Forwards an internal event to the correct agent-server pod via hash-ring routing.
 * Uses the same retry, wake, and fallback logic as message forwarding.
 *
 * Hash key is `userId` (not `agentId`) to maintain session affinity: the same
 * user's messages and events land on the same pod, keeping the conversation
 * context hot. For system-initiated events (e.g. cron) the caller supplies a
 * deterministic userId so that affinity still distributes across the ring.
 */
export async function forwardEventToServer(
  serverUrl: string,
  serverName: string,
  agentId: string,
  userId: string,
  type: "cron" | "notification" | "system",
  payload: Record<string, unknown>,
): Promise<string> {
  return forwardWithRetry(
    serverUrl,
    serverName,
    userId,
    `/agents/${agentId}/event`,
    JSON.stringify({ userId, type, payload }),
    getCanonicalAgentFallbackTarget(agentId),
  );
}

type TargetResult = GatewayTargetResult;

interface ForwardAttemptPolicy {
  timeoutMs: number;
  retryOnTimeout: boolean;
}

let messageForwardTimeoutMs = MESSAGE_FORWARD_TIMEOUT_MS;

/** Test-only seam for proving timeout behavior without a production-length wait. */
export const __serverRouterTestHooks = {
  setMessageForwardTimeoutMs(timeoutMs: number): void {
    messageForwardTimeoutMs = timeoutMs;
  },
  resetMessageForwardTimeoutMs(): void {
    messageForwardTimeoutMs = MESSAGE_FORWARD_TIMEOUT_MS;
  },
} as const;

const RUNTIME_AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dedicated app hosts can expose a runtime agent id that differs from the
 * cloud sandbox id used for routing. Resolve that id only from the authenticated
 * canonical host, and only when exactly one running runtime is present.
 */
async function discoverCanonicalRuntimeAgentId(
  canonicalTarget: CanonicalAgentFallbackTarget,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const sharedSecret = process.env.AGENT_SERVER_SHARED_SECRET;
  if (sharedSecret) headers["X-Server-Token"] = sharedSecret;
  if (canonicalTarget.forwardedHost) {
    headers["X-Forwarded-Host"] = canonicalTarget.forwardedHost;
  }

  try {
    const res = await fetch(
      `${canonicalTarget.baseUrl.replace(/\/$/, "")}/agents`,
      {
        headers,
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      agents?: Array<{ id?: unknown; status?: unknown }>;
    };
    const running = (data.agents ?? []).filter(
      (agent): agent is { id: string; status?: unknown } =>
        typeof agent.id === "string" &&
        RUNTIME_AGENT_ID_PATTERN.test(agent.id) &&
        agent.status === "running",
    );
    return running.length === 1 ? running[0].id : null;
  } catch {
    // error-policy:J4 Discovery is an optional compatibility path; the caller
    // retains and reports the original canonical forwarding failure.
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function tryCanonicalTarget(
  canonicalTarget: CanonicalAgentFallbackTarget,
  endpointPath: string,
  body: string,
  policy: ForwardAttemptPolicy,
): Promise<TargetResult> {
  const direct = await tryTarget(
    canonicalTarget.baseUrl,
    endpointPath,
    body,
    canonicalTarget.forwardedHost,
    policy.timeoutMs,
  );
  if (direct.ok || direct.status !== 404) return direct;

  const match = endpointPath.match(/^\/agents\/[^/]+\/(message|event)$/);
  if (!match) return direct;

  const runtimeAgentId = await discoverCanonicalRuntimeAgentId(canonicalTarget);
  if (!runtimeAgentId) return direct;

  return tryTarget(
    canonicalTarget.baseUrl,
    `/agents/${encodeURIComponent(runtimeAgentId)}/${match[1]}`,
    body,
    canonicalTarget.forwardedHost,
    policy.timeoutMs,
  );
}

/**
 * Generic retry loop with hash-ring routing and KEDA wake-on-zero.
 * Resolves pod targets via the hash ring, retries with linear backoff,
 * falls back to a secondary target on failure, and triggers a K8s
 * scale-up when all pods are unavailable.
 */
async function forwardWithRetry(
  serverUrl: string,
  serverName: string,
  hashKey: string,
  endpointPath: string,
  body: string,
  connectionFallback?: CanonicalAgentFallbackTarget | null,
  policy: ForwardAttemptPolicy = {
    timeoutMs: FORWARD_TIMEOUT_MS,
    retryOnTimeout: true,
  },
): Promise<string> {
  let canonicalAttempted = false;

  // Dedicated Docker sandboxes self-register a public host:port in Redis for
  // compatibility, but production node firewalls intentionally do not expose
  // those high ports to Railway. Their supported ingress is the canonical
  // control-plane router over HTTPS. Prefer it before the Redis target so a
  // normal Telegram/DM turn does not spend its entire non-replay timeout on a
  // transport that cannot be reached from this service.
  if (connectionFallback && serverName.startsWith("sandbox-")) {
    canonicalAttempted = true;
    const canonical = await tryCanonicalTarget(
      connectionFallback,
      endpointPath,
      body,
      policy,
    );
    if (canonical.ok) return canonical.response;
    if (canonical.timedOut && !policy.retryOnTimeout) {
      throw canonical.error;
    }
  }

  return executeGatewayForwardAttempts({
    attempts: RETRY_ATTEMPTS,
    baseDelayMs: RETRY_BASE_DELAY_MS,
    incrementMs: RETRY_INCREMENT_MS,
    getTargets: () => getHashTargets(serverUrl, hashKey, 2),
    refreshTargets: () => refreshHashRing(serverUrl),
    wake: () =>
      observeWakeServer(wakeServer(serverName, serverUrl), serverName),
    tryTarget: (target) =>
      tryTarget(target, endpointPath, body, undefined, policy.timeoutMs),
    retryOnTimeout: policy.retryOnTimeout,
    // Only transport failures can move to the fixed canonical ingress. An HTTP
    // response is authoritative and may not be bypassed through another host.
    afterPrimaryFailure: async (target, result) => {
      if (
        result.isConnectionError &&
        connectionFallback &&
        !canonicalAttempted &&
        target.replace(/\/$/, "") !==
          connectionFallback.baseUrl.replace(/\/$/, "")
      ) {
        canonicalAttempted = true;
        return tryCanonicalTarget(
          connectionFallback,
          endpointPath,
          body,
          policy,
        );
      }
      return null;
    },
    exhaustedError: new Error("Forward failed after retries"),
  });
}

/**
 * Attempts a single POST to a target pod IP at the given endpoint path.
 * Attaches X-Server-Token when AGENT_SERVER_SHARED_SECRET is configured.
 */
async function tryTarget(
  target: string,
  endpointPath: string,
  body: string,
  forwardedHost?: string,
  timeoutMs = FORWARD_TIMEOUT_MS,
): Promise<TargetResult> {
  return postGatewayTarget({
    target,
    endpointPath,
    body,
    timeoutMs,
    sharedSecret: process.env.AGENT_SERVER_SHARED_SECRET,
    forwardedHost,
    timeoutError: new Error(`Agent forward timed out after ${timeoutMs}ms`),
    timeoutIsConnectionError: false,
    readResponse: (response) => response.text(),
  });
}
