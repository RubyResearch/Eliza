/** Resolves Redis agent routes and performs observable Kubernetes wake requests for gateway hosts. */

import { parsePositiveIntegerEnvValue } from "./integer-env";
import { patchK8sDeploymentScale } from "./k8s-deployment-wake";
import {
  readServiceAccountCaCert,
  readServiceAccountToken,
} from "./k8s-service-account";

export interface GatewayRoutingRedis {
  get<T = string>(key: string): Promise<T | null>;
  lpush(key: string, ...values: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export type GatewayServerLookup =
  | { kind: "ready"; serverName: string; serverUrl: string }
  | { kind: "unregistered" }
  | { kind: "unreachable"; serverName: string };

export async function resolveGatewayAgentServer(
  redis: Pick<GatewayRoutingRedis, "get">,
  agentId: string,
): Promise<GatewayServerLookup> {
  const serverName = await redis.get<string>(`agent:${agentId}:server`);
  if (!serverName) return { kind: "unregistered" };
  const serverUrl = await redis.get<string>(`server:${serverName}:url`);
  if (!serverUrl) return { kind: "unreachable", serverName };
  return { kind: "ready", serverName, serverUrl };
}

export const KEDA_COOLDOWN_ENV = "KEDA_COOLDOWN_SECONDS";
export const DEFAULT_KEDA_COOLDOWN_SECONDS = 900;

/**
 * Resolve the KEDA activity TTL from the raw `KEDA_COOLDOWN_SECONDS` value.
 * Unset applies the default; anything else must be a positive integer because
 * `redis.expire` rejects `NaN` and a zero TTL expires the key immediately.
 * Gateways call this at module load so a bad value stops boot, not routing.
 */
export function resolveKedaCooldownSeconds(value: string | undefined): number {
  return parsePositiveIntegerEnvValue(
    KEDA_COOLDOWN_ENV,
    value,
    DEFAULT_KEDA_COOLDOWN_SECONDS,
  );
}

export async function refreshGatewayActivity(
  redis: Pick<GatewayRoutingRedis, "expire" | "lpush" | "ltrim">,
  serverName: string,
  cooldownSeconds: number,
): Promise<void> {
  const key = `keda:${serverName}:activity`;
  await redis.lpush(key, Date.now().toString());
  await redis.ltrim(key, 0, 0);
  await redis.expire(key, cooldownSeconds);
}

type GatewayErrorLogger = (
  message: string,
  context: Record<string, unknown>,
) => void;

export interface GatewayWakeDependencies {
  getToken?: () => string | null;
  getCaCert?: () => string | null;
  fetchFn?: typeof fetch;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  logError: GatewayErrorLogger;
}

export async function wakeGatewayServer(
  serverName: string,
  serverUrl: string,
  dependencies: GatewayWakeDependencies,
): Promise<void> {
  // Direct targets have no Kubernetes deployment. Resolve the namespace before
  // reading credentials so a direct host never touches cluster-only state.
  const namespace = serverUrl.match(
    /^https?:\/\/[^.]+\.([^.]+)\.svc(?:[.:/]|$)/,
  )?.[1];
  if (!namespace) return;
  const token = (dependencies.getToken ?? readServiceAccountToken)();
  if (!token) return;

  try {
    const response = await patchK8sDeploymentScale({
      serverName,
      namespace,
      token,
      caCert: (dependencies.getCaCert ?? readServiceAccountCaCert)(),
      fetchFn: dependencies.fetchFn,
      createTimeoutSignal: dependencies.createTimeoutSignal,
    });
    if (!response.ok) {
      dependencies.logError("wakeServer failed", {
        serverName,
        status: response.status,
        body: await response.text(),
      });
    }
  } catch (error) {
    // error-policy:J1 Detached wake failures terminate at this logged boundary.
    dependencies.logError("wakeServer error", {
      serverName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function observeGatewayWake(
  promise: Promise<void>,
  serverName: string,
  logError: GatewayErrorLogger,
): void {
  // error-policy:J5 wakeGatewayServer handles expected failures; this observes residual rejections.
  void promise.catch((error) => {
    logError("wakeServer unhandled error", {
      serverName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
