/** Routes Discord messages to registered cloud agent servers. */

import {
  executeGatewayForwardAttempts,
  type GatewayTargetResult,
  postGatewayTarget,
} from "@elizaos/cloud-services-common/gateway-forward";
import {
  type GatewayRoutingRedis as CommonGatewayRoutingRedis,
  type GatewayWakeDependencies,
  observeGatewayWake,
  refreshGatewayActivity,
  resolveGatewayAgentServer,
  resolveKedaCooldownSeconds,
  wakeGatewayServer,
} from "@elizaos/cloud-services-common/gateway-routing";

import { getHashTargets, refreshHashRing } from "./hash-router";
import { logger } from "./logger";

export interface GatewayRoutingRedis extends CommonGatewayRoutingRedis {
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  expire(key: string, seconds: number): Promise<number>;
}

const KEDA_COOLDOWN_SECONDS = resolveKedaCooldownSeconds(
  process.env.KEDA_COOLDOWN_SECONDS,
);
const FORWARD_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_INCREMENT_MS = 1_000;

interface ServerRoute {
  serverName: string;
  serverUrl: string;
}

export async function resolveAgentServer(
  redis: Pick<GatewayRoutingRedis, "get">,
  agentId: string,
): Promise<ServerRoute | null> {
  const result = await resolveGatewayAgentServer(redis, agentId);
  return result.kind === "ready"
    ? { serverName: result.serverName, serverUrl: result.serverUrl }
    : null;
}

export function refreshKedaActivity(
  redis: Pick<GatewayRoutingRedis, "expire" | "lpush" | "ltrim">,
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
 * Forwards a message to an agent-server pod using consistent hash routing.
 * Same userId always hits the same pod (session affinity via hash ring).
 * On connection failure: refreshes DNS, retries on fallback pod.
 * On scaled-to-zero: triggers K8s wake-up and retries until pod is ready.
 */
export async function forwardToServer(
  serverUrl: string,
  serverName: string,
  agentId: string,
  userId: string,
  text: string,
  options?: {
    senderName?: string;
    accountId?: string;
    platformRecordId?: string;
    chatId?: string;
    chatType?: string;
  },
): Promise<string> {
  const body = JSON.stringify({
    userId,
    text,
    platformName: "discord",
    ...(options?.senderName ? { senderName: options.senderName } : {}),
    ...(options?.accountId ? { accountId: options.accountId } : {}),
    ...(options?.platformRecordId
      ? { platformRecordId: options.platformRecordId }
      : {}),
    ...(options?.chatId ? { chatId: options.chatId } : {}),
    ...(options?.chatType ? { chatType: options.chatType } : {}),
  });

  return executeGatewayForwardAttempts({
    attempts: RETRY_ATTEMPTS,
    baseDelayMs: RETRY_BASE_DELAY_MS,
    incrementMs: RETRY_INCREMENT_MS,
    getTargets: () => getHashTargets(serverUrl, userId, 2),
    refreshTargets: () => refreshHashRing(serverUrl),
    wake: () =>
      observeWakeServer(wakeServer(serverName, serverUrl), serverName),
    tryTarget: (target) => tryTarget(target, agentId, body),
    retryOnTimeout: true,
    exhaustedError: new Error("forwardToServer failed"),
  });
}

function tryTarget(
  target: string,
  agentId: string,
  body: string,
): Promise<GatewayTargetResult> {
  return postGatewayTarget({
    target,
    endpointPath: `/agents/${agentId}/message`,
    body,
    timeoutMs: FORWARD_TIMEOUT_MS,
    sharedSecret: process.env.AGENT_SERVER_SHARED_SECRET,
    timeoutIsConnectionError: true,
    readResponse: async (response) => {
      const data = (await response.json()) as { response: string };
      return data.response;
    },
  });
}
