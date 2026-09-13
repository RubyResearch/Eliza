/** Exposes cloud sandbox operations and composes lifecycle, bridge, backup, and transport owners. All owners share the service’s provider instance and lifecycle authority; the facade preserves existing callers and orchestration boundaries. */

import { SandboxProvision } from "./eliza-sandbox/lifecycle/provision.js";
import { ElizaSandboxServiceTestHooks } from "./eliza-sandbox/lifecycle/provision-hooks.js";

export { SandboxReachabilityUnresolvedError } from "./eliza-sandbox/lifecycle/provision-errors.js";

import { SandboxDeletion } from "./eliza-sandbox/lifecycle/deletion.js";
import { SandboxWarmClaim } from "./eliza-sandbox/lifecycle/warm-claim.js";

export type {
  DeleteAgentResult,
  DeleteAuthorization,
} from "./eliza-sandbox/lifecycle/deletion-contracts.js";

import { SandboxPower } from "./eliza-sandbox/lifecycle/power.js";

export type { AgentSuspendExecutionResult } from "./eliza-sandbox/lifecycle/power-contracts.js";

import {
  BoundedDeletionSandboxStopResult,
  BoundedSandboxStopResult,
  SANDBOX_DELETE_STOP_TIMEOUT_MS,
} from "./eliza-sandbox/lifecycle/stop-contracts.js";

export type { ProvisionResult } from "./eliza-sandbox/lifecycle/provision-contracts.js";
export type { BoundedSandboxStopResult } from "./eliza-sandbox/lifecycle/stop-contracts.js";

import { AgentRuntimeHealthPayload } from "./eliza-sandbox/lifecycle/image-contracts.js";
import { SandboxImageSwap } from "./eliza-sandbox/lifecycle/image-swap.js";
import { SandboxReplacementCleanup } from "./eliza-sandbox/lifecycle/replacement-cleanup.js";

export {
  type AdminCanaryCleanupExpectation,
  AdminCanaryCleanupExpectationError,
} from "./eliza-sandbox/lifecycle/replacement-contracts.js";

import type { StateTransferOutcome } from "./eliza-sandbox/backup/contracts.js";
import { SNAPSHOT_ENDPOINT_UNSUPPORTED, SnapshotResult } from "./eliza-sandbox/backup/contracts.js";
import { SandboxBackup } from "./eliza-sandbox/backup/service.js";
import { SandboxLifecycleAuthority } from "./eliza-sandbox/lifecycle/authority.js";
import { containerBackedServiceRejection } from "./eliza-sandbox/lifecycle/policy.js";

export {
  SNAPSHOT_CAPTURE_TRANSIENT,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
  type SnapshotResult,
  type StateTransferOutcome,
} from "./eliza-sandbox/backup/contracts.js";

import { ActiveSandboxBridge } from "./eliza-sandbox/bridge/active.js";
import {
  BridgeRequest,
  BridgeResponse,
  BridgeRouteUnavailableError,
  RuntimeAgentListResult,
  RuntimeAgentSummary,
} from "./eliza-sandbox/bridge/contracts.js";

export {
  BRIDGE_INSUFFICIENT_CREDITS_CODE,
  type BridgeExecutionContext,
  type BridgeRequest,
  type BridgeResponse,
} from "./eliza-sandbox/bridge/contracts.js";

import {
  assertAgentExecutionTier,
  assertAgentImageAllowed,
  assertOrgAgentQuota,
  buildAgentSandboxInsertValues,
  CreateAgentParams,
} from "./eliza-sandbox/agent-config.js";
import { SandboxTransport } from "./eliza-sandbox/bridge/transport.js";

export {
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
  agentConfigForProvision,
  assertAgentImageAllowed,
  assertOrgAgentQuota,
  buildAgentSandboxInsertValues,
  type CreateAgentParams,
  computeManagedAgentDbEnv,
  QUOTA_COUNTED_STATUSES,
} from "./eliza-sandbox/agent-config.js";

import {
  captureStoredRestoreChain,
  RESTORE_AUTHORITY_CHANGED,
  RESTORE_BACKUP_CHANGED,
  restoreAuthorityRejection,
  restoreCaptureStillCanonical,
  storedRestoreChainStillCanonical,
  storedRestorePointStillCanonical,
} from "./eliza-sandbox/backup/authority.js";

export {
  assertReviewedFreshBootAuthority,
  assertReviewedProvisionRestoreAuthority,
} from "./eliza-sandbox/backup/authority.js";

export {
  isPermanentlyLostSnapshot,
  isUnrecoverableSnapshotError,
} from "./eliza-sandbox/backup/policy.js";
export type { ProvisionRestoreOverride } from "./eliza-sandbox/backup/restore-contract.js";
export {
  assertSnapshotExpandedBudgets,
  readBodyWithinBudget,
  readErrorBodyExcerpt,
} from "./eliza-sandbox/backup/transfer-limits.js";

import {
  ContainerRuntimeHealthObservation,
  classifyContainerRuntimeHealthObservation,
  TailnetIpReconcileResult,
} from "./eliza-sandbox/lifecycle/health-policy.js";

export {
  classifySandboxDeleteStopFailure,
  type SandboxDeleteStopFailureKind,
} from "./eliza-sandbox/lifecycle/deletion-policy.js";
export { classifyContainerRuntimeHealthObservation } from "./eliza-sandbox/lifecycle/health-policy.js";

import { isIP } from "node:net";
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import {
  type AgentSandbox,
  agentSandboxesRepository,
  hydrateAgentSandboxBackup,
} from "../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import {
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  type NewAgentSandbox,
} from "../../db/schemas/agent-sandboxes";
import { personalDedicatedUpgradeAuthorities } from "../../db/schemas/personal-dedicated-upgrade-authorities";
import { ApiError } from "../api/cloud-worker-errors";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/with-timeout";
import { decryptAgentEnvVars, encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import { apiKeysService } from "./api-keys";
import { shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import {
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
  readPersonalElizaCutover,
  stripPersonalDedicatedAuthorityConfigKeys,
  stripReservedElizaConfigKeys,
} from "./eliza-agent-config";
import {
  configureElizaLifecycleTransaction,
  elizaAgentCreateAdvisoryLockSql,
  elizaCodingContainerImageAdvisoryLockSql,
} from "./eliza-provision-lock";
import {
  type ManagedElizaEnvironmentResult,
  prepareManagedElizaSharedEnvironment,
} from "./managed-eliza-config";
import { mergeRuntimeAgentSecretsFromEnv } from "./runtime-agent-secrets";
import {
  createSandboxProvider,
  type SandboxHandle,
  type SandboxProvider,
} from "./sandbox-provider";
import {
  isContainerBackedExecutionTier,
  type SandboxDeletionLocator,
  type SandboxDeletionStopOutcome,
} from "./sandbox-provider-types";
import { applyPooledCredentialsToBootstrapEnv } from "./team-credential-pool/bootstrap-env";

type BridgeHealthProbeResult =
  | { ok: true; kind: "healthy" }
  | { ok: false; kind: "transient"; reason: string }
  | { ok: false; kind: "terminal-db"; reason: string }
  | { ok: false; kind: "unreachable"; reason: string };
// Heartbeat probes the agent over the headscale tailnet. When idle the path
// goes cold, so the first probe after a quiet period can fail while it
// re-establishes — retry before evicting a healthy agent.
const HEARTBEAT_PROBE_ATTEMPTS = 3;
const HEARTBEAT_PROBE_RETRY_MS = 2_000;
// A single failed cycle must not evict. Only mark disconnected after the agent
// has been continuously unreachable this long — last_heartbeat_at (bumped only
// on success) is the downtime clock. The ~30s heartbeat itself keeps the
// WireGuard NAT mapping warm, so a reachable agent never trips this.
const HEARTBEAT_DISCONNECT_AFTER_MS = 120_000;

// IP reconciliation (heartbeat + recovery): agent containers do not persist
// tailscale node state, so a container restart mints a fresh node key and
// headscale hands out the NEXT sequential IP — the stored headscale_ip /
// bridge_url go stale while the container itself is healthy. Every consumer
// reads those stored columns (the heartbeat probe, the agent-router's
// subdomain resolution, and therefore the public dedicated-agent proxy), so
// the heal must REPAIR the columns, not tolerate the miss.
const RECONCILE_SSH_CMD_TIMEOUT_MS = 15_000;
// Cap on consecutive heartbeat cycles a docker-healthy container may stay
// `running` while its current tailnet IP cannot be resolved (node SSH down,
// docker exec failing). Each such cycle guards error_count; hitting the cap
// escalates to `disconnected` so the recovery cycle's reprovision self-heal
// still fires — an unreachable paid agent must never look "running" forever.
const IP_RECONCILE_MAX_UNRESOLVED_CYCLES = 3;
const DB_LIVENESS_RESTART_MARKER = "[db-liveness-restart]";
const DB_LIVENESS_RESTART_BUDGET = 3;
const DB_LIVENESS_RESTART_COOLDOWN_MS = 10 * 60_000;
const DB_LIVENESS_RESTART_BUDGET_WINDOW_MS = 60 * 60_000;

/** Columns the tailnet-IP reconcile path reads to locate and repair an agent. */
type ReconcilableSandbox = Pick<
  AgentSandbox,
  | "id"
  | "node_id"
  | "container_name"
  | "environment_vars"
  | "bridge_url"
  | "health_url"
  | "headscale_ip"
>;

/**
 * Rollback signal for `prepareManagedLaunchEnvironment`: the guarded
 * environment write matched no row, so another lifecycle owner won the race.
 * Thrown purely to unwind the transaction that also carries the credential
 * rotation, and converted back to `undefined` by the method that raised it —
 * it never escapes to a caller.
 */
class ManagedLaunchOwnershipLost extends Error {
  constructor() {
    super("Managed launch lost its agent ownership CAS");
    this.name = "ManagedLaunchOwnershipLost";
  }
}

export class ElizaSandboxService {
  readonly #provision = new SandboxProvision({
    getProvisionTestHooks: (...args) => this.getProvisionTestHooks(...args),
    retireFailedWarmClaimForRetry: (...args) => this.retireFailedWarmClaimForRetry(...args),
    getReplacementCleanupLocator: (...args) => this.getReplacementCleanupLocator(...args),
    retirePersistedReplacementCleanup: (...args) => this.retirePersistedReplacementCleanup(...args),
    getProvider: (...args) => this.getProvider(...args),
    replacementCleanupCallbacks: (...args) => this.replacementCleanupCallbacks(...args),
    persistUnresolvedReplacementCleanupFence: (...args) =>
      this.persistUnresolvedReplacementCleanupFence(...args),
    ensureRuntimeAgentStarted: (...args) => this.ensureRuntimeAgentStarted(...args),
    transferReplacementToPrimary: (...args) => this.transferReplacementToPrimary(...args),
    pushState: (...args) => this.pushState(...args),
  });
  readonly #warmClaim = new SandboxWarmClaim({
    fetchAgentApi: (...args) => this.fetchAgentApi(...args),
    lockLifecycle: (...args) => this.lockLifecycle(...args),
    getAgentForLifecycleMutation: (...args) => this.getAgentForLifecycleMutation(...args),
    runBoundedSandboxStopForReplacement: (...args) =>
      this.runBoundedSandboxStopForReplacement(...args),
  });
  readonly #deletion = new SandboxDeletion({
    getAgentForWrite: (...args) => this.getAgentForWrite(...args),
    fetchSnapshotState: (...args) => this.fetchSnapshotState(...args),
    runBoundedSandboxStop: (...args) => this.runBoundedSandboxStop(...args),
    isIgnorableSandboxStopError: (...args) => this.isIgnorableSandboxStopError(...args),
    lockLifecycle: (...args) => this.lockLifecycle(...args),
    getAgentForLifecycleMutation: (...args) => this.getAgentForLifecycleMutation(...args),
    getReplacementCleanupLocator: (...args) => this.getReplacementCleanupLocator(...args),
    hasActiveProvisionJobTx: (...args) => this.hasActiveProvisionJobTx(...args),
    hasActiveReplacementJobTx: (...args) => this.hasActiveReplacementJobTx(...args),
    persistSnapshotWithinTransaction: (...args) => this.persistSnapshotWithinTransaction(...args),
    retirePersistedReplacementCleanup: (...args) => this.retirePersistedReplacementCleanup(...args),
  });
  readonly #power = new SandboxPower({
    getAgentForWrite: (...args) => this.getAgentForWrite(...args),
    fetchSnapshotState: (...args) => this.fetchSnapshotState(...args),
    lockLifecycle: (...args) => this.lockLifecycle(...args),
    getAgentForLifecycleMutation: (...args) => this.getAgentForLifecycleMutation(...args),
    isAwaitingDeletion: (...args) => this.isAwaitingDeletion(...args),
    getReplacementCleanupLocator: (...args) => this.getReplacementCleanupLocator(...args),
    hasActiveProvisionJobTx: (...args) => this.hasActiveProvisionJobTx(...args),
    persistSnapshotWithinTransaction: (...args) => this.persistSnapshotWithinTransaction(...args),
    runBoundedSandboxStopForReplacement: (...args) =>
      this.runBoundedSandboxStopForReplacement(...args),
    revalidateContainerBackedLifecycleGeneration: (...args) =>
      this.revalidateContainerBackedLifecycleGeneration(...args),
    provision: (...args) => this.provision(...args),
    hasActiveReplacementJobTx: (...args) => this.hasActiveReplacementJobTx(...args),
    prepareLegacyWarmClaimCredentialRecovery: (...args) =>
      this.prepareLegacyWarmClaimCredentialRecovery(...args),
    recoverPendingWarmClaimInferenceKey: (...args) =>
      this.recoverPendingWarmClaimInferenceKey(...args),
  });
  readonly #imageSwap = new SandboxImageSwap({
    getAgentJsonHeaders: (...args) => this.getAgentJsonHeaders(...args),
    getReplacementCleanupLocator: (...args) => this.getReplacementCleanupLocator(...args),
    retirePersistedReplacementCleanup: (...args) => this.retirePersistedReplacementCleanup(...args),
    getProvider: (...args) => this.getProvider(...args),
    replacementCleanupCallbacks: (...args) => this.replacementCleanupCallbacks(...args),
    persistUnresolvedReplacementCleanupFence: (...args) =>
      this.persistUnresolvedReplacementCleanupFence(...args),
    snapshot: (...args) => this.snapshot(...args),
    lockLifecycle: (...args) => this.lockLifecycle(...args),
    getAgentForLifecycleMutation: (...args) => this.getAgentForLifecycleMutation(...args),
    replacementCleanupMatchesHandle: (...args) => this.replacementCleanupMatchesHandle(...args),
    replacementCleanupCreatedAtMatches: (...args) =>
      this.replacementCleanupCreatedAtMatches(...args),
    pushState: (...args) => this.pushState(...args),
  });
  readonly #replacementCleanup = new SandboxReplacementCleanup({
    lockLifecycle: (...args) => this.lockLifecycle(...args),
    getAgentForLifecycleMutation: (...args) => this.getAgentForLifecycleMutation(...args),
    hasActiveExclusiveLifecycleJobTx: (...args) => this.hasActiveExclusiveLifecycleJobTx(...args),
    isReplacementCleanupSweepEligibleTx: (...args) =>
      this.isReplacementCleanupSweepEligibleTx(...args),
    getProvider: (...args) => this.getProvider(...args),
  });
  private readonly lifecycleAuthority = new SandboxLifecycleAuthority();
  readonly #backup = new SandboxBackup({
    lockLifecycle: (...args) => this.lockLifecycle(...args),
    getAgentForLifecycleMutation: (...args) => this.getAgentForLifecycleMutation(...args),
    fetchAgentApi: (...args) => this.fetchAgentApi(...args),
    getSafeBridgeEndpoint: (...args) => this.getSafeBridgeEndpoint(...args),
    getAgentJsonHeaders: (...args) => this.getAgentJsonHeaders(...args),
  });
  readonly #bridge = new ActiveSandboxBridge({
    listRuntimeAgents: (...args) => this.listRuntimeAgents(...args),
    selectRuntimeAgent: (...args) => this.selectRuntimeAgent(...args),
    isRuntimeAgentReady: (...args) => this.isRuntimeAgentReady(...args),
    fetchAgentWeb: (...args) => this.fetchAgentWeb(...args),
    fetchAgentApi: (...args) => this.fetchAgentApi(...args),
    fetchCanonicalConversationApi: (...args) => this.fetchCanonicalConversationApi(...args),
    ensureRuntimeAgentStarted: (...args) => this.ensureRuntimeAgentStarted(...args),
  });
  private readonly transport = new SandboxTransport();
  private _provider?: SandboxProvider;
  private _providerPromise?: Promise<SandboxProvider>;

  private readonly testHooks?: ElizaSandboxServiceTestHooks;
  private getProvisionTestHooks(): ElizaSandboxServiceTestHooks | undefined {
    return this.testHooks;
  }

  constructor(provider?: SandboxProvider, testHooks?: ElizaSandboxServiceTestHooks) {
    if (provider) {
      this._provider = provider;
    }
    this.testHooks = testHooks;
  }

  private async getProvider(): Promise<SandboxProvider> {
    if (this._provider) return this._provider;
    if (!this._providerPromise) {
      this._providerPromise = createSandboxProvider().then((p) => {
        this._provider = p;
        return p;
      });
    }
    return this._providerPromise;
  }
  private getAgentApiToken(
    ...args: Parameters<SandboxTransport["getAgentApiToken"]>
  ): ReturnType<SandboxTransport["getAgentApiToken"]> {
    return this.transport.getAgentApiToken(...args);
  }
  private getAgentJsonHeaders(
    ...args: Parameters<SandboxTransport["getAgentJsonHeaders"]>
  ): ReturnType<SandboxTransport["getAgentJsonHeaders"]> {
    return this.transport.getAgentJsonHeaders(...args);
  }

  private getRuntimeAgentsFromBody(body: unknown): RuntimeAgentSummary[] {
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
    const rawAgents = Array.isArray(root.agents)
      ? root.agents
      : Array.isArray(data.agents)
        ? data.agents
        : [];

    return rawAgents
      .map((item): RuntimeAgentSummary | null => {
        if (!item || typeof item !== "object") return null;
        const agent = item as Record<string, unknown>;
        return {
          id: typeof agent.id === "string" ? agent.id : undefined,
          name:
            typeof agent.name === "string"
              ? agent.name
              : typeof agent.characterName === "string"
                ? agent.characterName
                : undefined,
          status: typeof agent.status === "string" ? agent.status : undefined,
        };
      })
      .filter((agent): agent is RuntimeAgentSummary => Boolean(agent?.id || agent?.name));
  }

  private isRuntimeAgentReady(agent: RuntimeAgentSummary | undefined): boolean {
    if (!agent) return false;
    const status = agent.status?.toLowerCase();
    return status === "active" || status === "running" || status === "ready";
  }

  private selectRuntimeAgent(agents: RuntimeAgentSummary[]): RuntimeAgentSummary | undefined {
    return agents.find((agent) => this.isRuntimeAgentReady(agent)) ?? agents[0];
  }

  private async listRuntimeAgents(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
  ): Promise<RuntimeAgentListResult> {
    const agentsRes = await this.fetchAgentApi(rec, "/api/agents", {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (agentsRes.status === 404) {
      return { supported: false, agents: [] };
    }
    if (!agentsRes.ok) {
      throw new Error(`Runtime agent list returned HTTP ${agentsRes.status}`);
    }
    return {
      supported: true,
      agents: this.getRuntimeAgentsFromBody(await agentsRes.json().catch(() => ({}))),
    };
  }

  private buildRuntimeBootstrapAgent(
    rec: Pick<AgentSandbox, "id" | "agent_name" | "agent_config" | "environment_vars">,
  ) {
    const rawConfig =
      rec.agent_config && typeof rec.agent_config === "object" && !Array.isArray(rec.agent_config)
        ? ({ ...(rec.agent_config as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const rawName =
      typeof rawConfig.name === "string" && rawConfig.name.trim()
        ? rawConfig.name.trim()
        : rec.agent_name?.trim() || `Cloud Agent ${rec.id}`;
    const plugins =
      Array.isArray(rawConfig.plugins) && rawConfig.plugins.length > 0
        ? rawConfig.plugins
        : ["@elizaos/plugin-sql", "@elizaos/plugin-elizacloud"];
    const rawSettings =
      rawConfig.settings &&
      typeof rawConfig.settings === "object" &&
      !Array.isArray(rawConfig.settings)
        ? ({ ...(rawConfig.settings as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const rawSecrets =
      rawSettings.secrets &&
      typeof rawSettings.secrets === "object" &&
      !Array.isArray(rawSettings.secrets)
        ? ({ ...(rawSettings.secrets as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const environmentVars =
      rec.environment_vars && typeof rec.environment_vars === "object"
        ? (rec.environment_vars as Record<string, string>)
        : {};
    const secrets = mergeRuntimeAgentSecretsFromEnv({ rawSecrets, environmentVars });
    const settings = {
      ...rawSettings,
      secrets,
    };

    return {
      ...rawConfig,
      name: rawName,
      username:
        typeof rawConfig.username === "string" && rawConfig.username.trim()
          ? rawConfig.username.trim()
          : rawName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "cloud-agent",
      // A dedicated agent is created with only a name (no persona is collected
      // at creation time), so without a real identity "what is your name" gets a
      // generic deflection. Seed a name-aware identity — mirroring
      // buildSharedRuntimeCharacter — so the runtime boots with a real system
      // prompt without claiming to be a differently-named character.
      system:
        typeof rawConfig.system === "string" && rawConfig.system.trim()
          ? rawConfig.system
          : `You are ${rawName}, a helpful assistant.`,
      bio:
        Array.isArray(rawConfig.bio) && rawConfig.bio.length > 0
          ? rawConfig.bio
          : [`${rawName} is a helpful Eliza Cloud agent.`],
      topics:
        Array.isArray(rawConfig.topics) && rawConfig.topics.length > 0 ? rawConfig.topics : [],
      adjectives:
        Array.isArray(rawConfig.adjectives) && rawConfig.adjectives.length > 0
          ? rawConfig.adjectives
          : [],
      style:
        rawConfig.style && typeof rawConfig.style === "object" && !Array.isArray(rawConfig.style)
          ? rawConfig.style
          : undefined,
      plugins,
      settings,
    };
  }

  private async startRuntimeAgent(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    runtimeAgentId: string,
  ): Promise<void> {
    const startRes = await this.fetchAgentApi(
      rec,
      `/api/agents/${encodeURIComponent(runtimeAgentId)}/start`,
      {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!startRes.ok) {
      throw new Error(`Runtime agent start returned HTTP ${startRes.status}`);
    }
  }

  private async createRuntimeAgent(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<string> {
    // Bootstrap secrets (OPENAI_API_KEY / ANTHROPIC_API_KEY / ...) are copied
    // out of environment_vars, which stores them encrypted at rest (#11332) —
    // materialize real values before building the bootstrap payload.
    const bootstrapEnv = await decryptAgentEnvVars(
      (rec.environment_vars as Record<string, string> | null) ?? {},
    );
    // Team credential pool (#11332): providers the agent has NO key for are
    // filled from the org's pooled credentials. Merged only into this
    // in-memory bootstrap payload (→ settings.secrets via
    // buildRuntimeBootstrapAgent) — never persisted to environment_vars.
    // A provider with no eligible pooled credential leaves the env unchanged
    // (the registry degrades a missing/unhealthy pool to null, its J4); a
    // genuine internal pool fault propagates and fails provisioning closed —
    // consistent with the decrypt/create throws above — rather than silently
    // booting an agent missing a credential it was meant to receive.
    const pooledEnv = await applyPooledCredentialsToBootstrapEnv({
      organizationId: rec.organization_id,
      userId: rec.user_id,
      sessionKey: rec.id,
      env: bootstrapEnv,
    });
    const createRes = await this.fetchAgentApi(rec, "/api/agents", {
      method: "POST",
      body: JSON.stringify({
        agent: this.buildRuntimeBootstrapAgent({ ...rec, environment_vars: pooledEnv }),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!createRes.ok) {
      throw new Error(`Runtime agent create returned HTTP ${createRes.status}`);
    }

    const body = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
    const data =
      body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
    const runtimeAgentId = typeof data.id === "string" ? data.id : undefined;
    if (!runtimeAgentId) {
      throw new Error("Runtime agent create response was missing data.id");
    }
    return runtimeAgentId;
  }

  private async ensureRuntimeAgentStarted(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<RuntimeAgentSummary | null> {
    const initial = await this.listRuntimeAgents(rec);
    if (!initial.supported) return null;

    const existing = this.selectRuntimeAgent(initial.agents);
    if (this.isRuntimeAgentReady(existing)) return existing ?? null;

    const runtimeAgentId = existing?.id ?? (await this.createRuntimeAgent(rec));
    await this.startRuntimeAgent(rec, runtimeAgentId);

    const afterStart = await this.listRuntimeAgents(rec);
    const started =
      afterStart.agents.find((agent) => agent.id === runtimeAgentId) ?? afterStart.agents[0];
    if (!this.isRuntimeAgentReady(started)) {
      throw new Error("Runtime agent did not become active after start");
    }
    return started;
  }
  private stableBridgeUuid(
    ...args: Parameters<ActiveSandboxBridge["stableBridgeUuid"]>
  ): ReturnType<ActiveSandboxBridge["stableBridgeUuid"]> {
    return this.#bridge.stableBridgeUuid(...args);
  }
  private stableBridgeUserId(
    ...args: Parameters<ActiveSandboxBridge["stableBridgeUserId"]>
  ): ReturnType<ActiveSandboxBridge["stableBridgeUserId"]> {
    return this.#bridge.stableBridgeUserId(...args);
  }
  private stableBridgeChannelId(
    ...args: Parameters<ActiveSandboxBridge["stableBridgeChannelId"]>
  ): ReturnType<ActiveSandboxBridge["stableBridgeChannelId"]> {
    return this.#bridge.stableBridgeChannelId(...args);
  }

  // Agent CRUD

  async createAgent(params: CreateAgentParams): Promise<{
    agent: AgentSandbox;
    idempotent: boolean;
  }> {
    assertAgentExecutionTier(params.executionTier);
    // SECURITY (H1, #12230): gate a caller-supplied image against the managed-
    // agent allowlist BEFORE any DB write or provisioning. Throws
    // AgentImageNotAllowedError (→ 4xx at the route) so a non-allowlisted image
    // provisions nothing. Runs for EVERY createAgent caller — the gate lives in
    // the shared service path, not per-route.
    assertAgentImageAllowed(params.dockerImage);

    logger.info("[agent-sandbox] Creating agent", {
      orgId: params.organizationId,
      name: params.agentName,
      reuse: params.reuseExistingNonTerminal ?? false,
    });

    // Caller-supplied env can carry BYO secrets — encrypt them before the row
    // is inserted (#11332), mirroring updateAgentEnvironment.
    if (params.environmentVars && Object.keys(params.environmentVars).length > 0) {
      params = {
        ...params,
        environmentVars: await encryptAgentEnvVarsForStorage(
          params.organizationId,
          params.environmentVars,
        ),
      };
    }

    // Multi-agent-per-org callers (waifu launches, compat) leave the flag unset
    // and keep the plain insert — they legitimately mint several agents per org.
    if (!params.reuseExistingNonTerminal) {
      // Uncapped fast path for trusted internal multi-agent callers.
      if (params.maxNonTerminalAgents === undefined) {
        const created = await agentSandboxesRepository.create(
          buildAgentSandboxInsertValues(params),
        );
        return { agent: created, idempotent: false };
      }

      // Capped path (#11023): a user-facing forceCreate that bypasses the reuse
      // guard must still not mint unbounded dedicated containers. Count the org's
      // quota-holding sandboxes UNDER the same org advisory lock the reuse guard
      // uses and refuse past the cap.
      const cap = params.maxNonTerminalAgents;
      return dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
        await assertOrgAgentQuota(tx, params.organizationId, cap, params.quotaMode);

        const [created] = await tx
          .insert(agentSandboxes)
          .values(buildAgentSandboxInsertValues(params))
          .returning();
        if (!created) throw new Error("Failed to create agent record");
        return { agent: created, idempotent: false };
      });
    }

    // Mirrors createCodingContainerAgent: an org-scoped advisory lock + a
    // FOR UPDATE reuse guard serialize concurrent creates so a retry / SDK
    // double-call / provision flap can't strand the org with N agents (each =
    // a container + per-tenant DB + ingress).
    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));

      const [existing] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, params.organizationId),
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'running')`,
          ),
        )
        .orderBy(desc(agentSandboxes.created_at))
        .for("update")
        .limit(1);

      if (existing) {
        return { agent: existing, idempotent: true };
      }

      // The guard above only hands back a LIVE agent — a `stopped`/`sleeping`
      // one must be resumed/woken, not reused — so after a suspend there is
      // nothing to collapse onto and control falls through to a fresh insert.
      // Without a cap that insert is unbounded: a create→suspend→create loop
      // mints a new agent (each = a per-tenant managed DB) every iteration
      // (#11023 residual). Enforce the same per-org ceiling, still under the
      // org advisory lock.
      if (params.maxNonTerminalAgents !== undefined) {
        await assertOrgAgentQuota(
          tx,
          params.organizationId,
          params.maxNonTerminalAgents,
          params.quotaMode,
        );
      }

      const [created] = await tx
        .insert(agentSandboxes)
        .values(buildAgentSandboxInsertValues(params))
        .returning();
      if (!created) throw new Error("Failed to create agent record");
      return { agent: created, idempotent: false };
    });
  }

  async createCodingContainerAgent(params: CreateAgentParams & { dockerImage: string }): Promise<{
    agent: AgentSandbox;
    idempotent: boolean;
  }> {
    assertAgentExecutionTier(params.executionTier);
    const createParams: CreateAgentParams & { dockerImage: string } = {
      ...params,
      // Coding-container env carries caller secrets (tokens, provider keys) —
      // encrypt them before the row is inserted (#11332).
      environmentVars: params.environmentVars
        ? await encryptAgentEnvVarsForStorage(params.organizationId, params.environmentVars)
        : params.environmentVars,
    };

    logger.info("[agent-sandbox] Creating coding-container agent", {
      orgId: createParams.organizationId,
      name: createParams.agentName,
      image: createParams.dockerImage,
    });

    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      // Acquire the per-ORG agent-create lock BEFORE the per-image lock. The
      // image lock alone (keyed on the exact docker_image) does NOT serialize
      // two concurrent creates for DIFFERENT images against one org, so the
      // quota count below would not be atomic without the org lock. Taking the
      // org lock first everywhere gives a strict org→image lock order, so this
      // path and createAgent (org lock only) can never deadlock. (#11023)
      await tx.execute(elizaAgentCreateAdvisoryLockSql(createParams.organizationId));
      await tx.execute(
        elizaCodingContainerImageAdvisoryLockSql(
          createParams.organizationId,
          createParams.dockerImage,
        ),
      );

      const [existing] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, createParams.organizationId),
            eq(agentSandboxes.docker_image, createParams.dockerImage),
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'running')`,
          ),
        )
        .orderBy(desc(agentSandboxes.created_at))
        .for("update")
        .limit(1);

      if (existing) {
        return { agent: existing, idempotent: true };
      }

      // Per-org quota (#11023): the per-image reuse guard collapses only
      // same-image retries, so a distinct-image loop (`:v1`/`:v2`/`@sha256…`
      // under an allowlisted namespace) would otherwise mint unbounded custom
      // containers on the shared fleet. #11042 capped createAgent's plain-insert
      // branch but not this route; enforce the SAME per-org ceiling here, under
      // the org lock so the count→insert is atomic against concurrent creates.
      // Trusted internal callers pass no cap and stay uncapped.
      if (createParams.maxNonTerminalAgents !== undefined) {
        await assertOrgAgentQuota(
          tx,
          createParams.organizationId,
          createParams.maxNonTerminalAgents,
          createParams.quotaMode,
        );
      }

      const [created] = await tx
        .insert(agentSandboxes)
        .values(buildAgentSandboxInsertValues(createParams))
        .returning();
      if (!created) throw new Error("Failed to create coding-container agent record");
      return { agent: created, idempotent: false };
    });
  }

  async getAgent(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
  }

  async getAgentById(agentId: string) {
    return agentSandboxesRepository.findById(agentId);
  }

  async updateAgentEnvironment(
    agentId: string,
    orgId: string,
    environmentVars: Record<string, string>,
  ): Promise<AgentSandbox | undefined> {
    // BYO secrets (provider API keys, tokens) are encrypted at rest (#11332);
    // the materialization paths (provision / fleet upgrade / runtime
    // bootstrap) decrypt, so the running agent still sees real values.
    const encryptedEnvironment = await encryptAgentEnvVarsForStorage(orgId, environmentVars);
    const updated = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return undefined;
      if (rec.deletion_attempt_id) {
        throw new ApiError(409, "session_not_ready", "Agent deletion is in progress");
      }
      const [row] = await tx
        .update(agentSandboxes)
        .set({
          environment_vars: encryptedEnvironment,
          environment_revision: sql`${agentSandboxes.environment_revision} + 1`,
          warm_claim_credential_state: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN 'pending'
              ELSE ${agentSandboxes.warm_claim_credential_state}
            END
          `,
          warm_claim_key_fingerprint: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN NULL
              ELSE ${agentSandboxes.warm_claim_key_fingerprint}
            END
          `,
          warm_claim_attested_at: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN NULL
              ELSE ${agentSandboxes.warm_claim_attested_at}
            END
          `,
          warm_claim_attested_environment_revision: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN NULL
              ELSE ${agentSandboxes.warm_claim_attested_environment_revision}
            END
          `,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
            sql`COALESCE(${agentSandboxes.warm_claim_credential_state}, '') NOT IN ('pending', 'attested')`,
          ),
        )
        .returning();
      return row;
    });
    if (updated?.claimed_at && updated.warm_claim_credential_state === "pending") {
      const { provisioningJobService } = await import("./provisioning-jobs");
      await provisioningJobService.enqueueAgentRestartOnce({
        agentId: updated.id,
        organizationId: updated.organization_id,
        userId: updated.user_id,
      });
    }
    return updated;
  }

  /**
   * Rotate the generic managed-launch credential and persist its environment
   * under the same per-agent lifecycle lock used by delete/restart/upgrade.
   * Key minting stays inside that ownership window so a delete cannot revoke
   * and then lose to a late mint.
   *
   * The rotation runs on the launch transaction's own connection. It used to
   * reach for the global write pool instead, which made every launch hold one
   * connection while asking for a second. The Worker pool is sized `max: 1`
   * (`db/client.ts` `createPgPool`), so the request waited on the connection it
   * was itself holding: a guaranteed self-deadlock, resolved only by
   * `connectionTimeoutMillis` (30s) and returned as a 500. No concurrency was
   * required — every managed launch hit it. Sharing the connection also makes
   * the rotation atomic with the environment write, so an unwind restores the
   * previous key rather than needing a compensating revoke that could itself
   * fail.
   */
  async prepareManagedLaunchEnvironment(params: {
    agentId: string;
    organizationId: string;
    userId: string;
  }): Promise<
    | {
        sandbox: AgentSandbox;
        environment: ManagedElizaEnvironmentResult;
      }
    | undefined
  > {
    let committed:
      | { sandbox: AgentSandbox; environment: ManagedElizaEnvironmentResult }
      | undefined;
    try {
      committed = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, params.agentId, params.organizationId);
        const rec = await this.getAgentForLifecycleMutation(
          tx,
          params.agentId,
          params.organizationId,
        );
        if (!rec) return undefined;
        const tierRejection = containerBackedServiceRejection(rec, "credential");
        if (tierRejection) throw new Error(tierRejection);
        if (rec.deletion_attempt_id || rec.claimed_at) return undefined;

        const environment = await prepareManagedElizaSharedEnvironment({
          existingEnv: rec.environment_vars,
          organizationId: params.organizationId,
          userId: params.userId,
          agentSandboxId: rec.id,
          tx,
        });
        if (!environment.changed) {
          return { sandbox: rec, environment };
        }

        const [updated] = await tx
          .update(agentSandboxes)
          .set({
            environment_vars: environment.environmentVars,
            environment_revision: sql`${agentSandboxes.environment_revision} + 1`,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(agentSandboxes.id, rec.id),
              eq(agentSandboxes.organization_id, rec.organization_id),
              eq(agentSandboxes.environment_revision, rec.environment_revision),
              eq(agentSandboxes.lifecycle_revision, rec.lifecycle_revision),
              inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
              sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
              sql`${agentSandboxes.claimed_at} IS NULL`,
            ),
          )
          .returning();
        // Losing the ownership CAS must unwind the credential rotation with it.
        // Returning here would COMMIT a key swap the stored environment never
        // references, leaving the agent booting with a deleted key; throwing
        // rolls both back together.
        if (!updated) throw new ManagedLaunchOwnershipLost();
        return { sandbox: updated, environment };
      });
    } catch (error) {
      // error-policy:J4 user-facing degrade — only this path's own CAS-loss
      // signal becomes the documented "not prepared" result; the transaction
      // has already rolled the rotation back. Every other failure propagates.
      if (error instanceof ManagedLaunchOwnershipLost) return undefined;
      throw error;
    }

    // The rotation is durable only now. The invalidation inside the
    // transaction ran while the revoked rows were still visible to other
    // connections, so a request from the still-running container could have
    // re-cached one POSITIVELY for the full validation TTL. Repeat it here,
    // confirmed, before the caller shuts the container down or returns the
    // replacement credential — and sweep in every OUTSTANDING carrier parked
    // by an earlier attempt whose confirmation failed, so no code path can
    // finish while a superseded hash silently keeps authorizing.
    if (committed) {
      const toConfirm = [
        ...new Set([
          ...committed.environment.revokedKeyHashes,
          ...(await apiKeysService.collectOutstandingRevokedKeyHashes(params.agentId)),
        ]),
      ];
      if (toConfirm.length === 0) return committed;
      try {
        await apiKeysService.confirmRevocationAfterCommit(toConfirm);
        // Confirmed clear everywhere — reap EXACTLY the carriers this attempt
        // confirmed; a concurrent rotation's unconfirmed carrier stays parked.
        await apiKeysService.purgeConfirmedRevokedAgentKeys(params.agentId, toConfirm);
      } catch (cause) {
        // error-policy:J2 context-adding rethrow — there is no later pass that
        // could clear a re-cached entry, so an unconfirmed invalidation must
        // stop the launch rather than hand back a rotated credential while the
        // revoked one may still authenticate. The DB rotation is already
        // committed; the caller is being told the launch is PARTIALLY applied
        // and a retry re-rotates from the new state.
        throw new ElizaError(
          "Managed launch rotated the agent credential but could not confirm revocation of the previous one",
          {
            code: "MANAGED_LAUNCH_REVOCATION_UNCONFIRMED",
            cause,
            context: {
              agentId: params.agentId,
              organizationId: params.organizationId,
              revokedKeyCount: toConfirm.length,
              committed: true,
            },
            severity: "fatal",
          },
        );
      }
    }
    return committed;
  }

  /**
   * Edit an agent's profile in place — its display name and/or its persisted
   * `agent_config` (system prompt / character fields). `agentConfig` is merged
   * into the existing config so a partial edit never drops other keys. A name
   * edit applies immediately (cloud agent name + shared-runtime character);
   * dedicated-container config edits take effect on the next provision/restart.
   */
  async updateAgentProfile(
    agentId: string,
    orgId: string,
    input: { agentName?: string; agentConfig?: Record<string, unknown> },
  ): Promise<AgentSandbox | undefined> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return undefined;
      if (rec.deletion_attempt_id) {
        throw new ApiError(409, "session_not_ready", "Agent deletion is in progress");
      }

      const updates: { agent_name?: string; agent_config?: Record<string, unknown> } = {};
      if (input.agentName !== undefined) updates.agent_name = input.agentName;
      if (input.agentConfig !== undefined || input.agentName !== undefined) {
        const existing =
          rec.agent_config &&
          typeof rec.agent_config === "object" &&
          !Array.isArray(rec.agent_config)
            ? (rec.agent_config as Record<string, unknown>)
            : {};
        const [authority] = await tx
          .select()
          .from(personalDedicatedUpgradeAuthorities)
          .where(
            and(
              eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, rec.id),
              eq(personalDedicatedUpgradeAuthorities.organization_id, orgId),
            ),
          )
          .limit(1);
        const reservedProjection: Record<string, unknown> = {};
        if (authority) {
          if (authority.schema_version !== 1 || authority.user_id !== rec.user_id) {
            throw new ElizaError("Personal Dedicated authority is inconsistent", {
              code: "PERSONAL_DEDICATED_AUTHORITY_INVALID",
              context: { agentId, organizationId: orgId },
            });
          }
          reservedProjection[AGENT_UPGRADED_FROM_KEY] = authority.source_agent_id;
          if (authority.cutover_token !== null) {
            const cutover = readPersonalElizaCutover({
              [AGENT_PERSONAL_CUTOVER_KEY]: {
                mode: "dedicated",
                sourceAgentId: authority.source_agent_id,
                conversationId: authority.source_agent_id,
                cutoverToken: authority.cutover_token,
                sharedMessageCount: authority.shared_message_count,
                sharedScheduledTaskCount: authority.shared_scheduled_task_count,
                sharedTodoCount: authority.shared_todo_count,
                sharedTodoMutationCount: authority.shared_todo_mutation_count,
                sharedTodoDigest: authority.shared_todo_digest,
                activatedAt: authority.cutover_activated_at?.toISOString(),
              },
            });
            if (!cutover) {
              throw new ElizaError("Personal Dedicated cutover authority is malformed", {
                code: "PERSONAL_DEDICATED_AUTHORITY_INVALID",
                context: { agentId, organizationId: orgId },
              });
            }
            reservedProjection[AGENT_PERSONAL_CUTOVER_KEY] = cutover;
          }
        }
        // Only adoption state is untrusted on an existing row. Other internal
        // bindings are server-owned and must survive ordinary profile edits;
        // the broad input sanitizer still prevents callers from replacing any
        // internal key.
        updates.agent_config = {
          ...stripPersonalDedicatedAuthorityConfigKeys(existing),
          ...(input.agentConfig ? stripReservedElizaConfigKeys(input.agentConfig) : {}),
          ...reservedProjection,
        };
      }
      if (Object.keys(updates).length === 0) return rec;

      const [updated] = await tx
        .update(agentSandboxes)
        .set({ ...updates, updated_at: new Date() })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning();
      return updated;
    });
  }

  async getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined> {
    return agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
  }

  async listAgents(orgId: string) {
    return agentSandboxesRepository.listByOrganization(orgId);
  }
  deleteAgent(
    ...args: Parameters<SandboxDeletion["deleteAgent"]>
  ): ReturnType<SandboxDeletion["deleteAgent"]> {
    return this.#deletion.deleteAgent(...args);
  }
  private hasCurrentPreDeleteCaptureWaiver(
    ...args: Parameters<SandboxDeletion["hasCurrentPreDeleteCaptureWaiver"]>
  ): ReturnType<SandboxDeletion["hasCurrentPreDeleteCaptureWaiver"]> {
    return this.#deletion.hasCurrentPreDeleteCaptureWaiver(...args);
  }
  private requiresPreDeleteCapture(
    ...args: Parameters<SandboxDeletion["requiresPreDeleteCapture"]>
  ): ReturnType<SandboxDeletion["requiresPreDeleteCapture"]> {
    return this.#deletion.requiresPreDeleteCapture(...args);
  }
  private prepareAgentDelete(
    ...args: Parameters<SandboxDeletion["prepareAgentDelete"]>
  ): ReturnType<SandboxDeletion["prepareAgentDelete"]> {
    return this.#deletion.prepareAgentDelete(...args);
  }
  private commitAgentRowDelete(
    ...args: Parameters<SandboxDeletion["commitAgentRowDelete"]>
  ): ReturnType<SandboxDeletion["commitAgentRowDelete"]> {
    return this.#deletion.commitAgentRowDelete(...args);
  }
  private commitAgentReconciliationPending(
    ...args: Parameters<SandboxDeletion["commitAgentReconciliationPending"]>
  ): ReturnType<SandboxDeletion["commitAgentReconciliationPending"]> {
    return this.#deletion.commitAgentReconciliationPending(...args);
  }
  cancelAgentDeletion(
    ...args: Parameters<SandboxDeletion["cancelAgentDeletion"]>
  ): ReturnType<SandboxDeletion["cancelAgentDeletion"]> {
    return this.#deletion.cancelAgentDeletion(...args);
  }
  private cancelAgentDeletionTx(
    ...args: Parameters<SandboxDeletion["cancelAgentDeletionTx"]>
  ): ReturnType<SandboxDeletion["cancelAgentDeletionTx"]> {
    return this.#deletion.cancelAgentDeletionTx(...args);
  }

  /**
   * Phase 2 of `deleteAgent` (see there): the bounded container + VPN teardown.
   * Provider errors are captured as values so `withTimeout` rejects ONLY on a
   * genuine hang. The provider's tagged outcome distinguishes proven absence
   * from an unreachable workload; failures and timeouts remain distinct so the
   * deletion workflow can preserve capacity without wedging its worker.
   */
  private async runBoundedSandboxStop(
    sandboxId: string,
    locator?: SandboxDeletionLocator | null,
  ): Promise<BoundedDeletionSandboxStopResult> {
    return withTimeout(
      (async (): Promise<SandboxDeletionStopOutcome | { kind: "stop-failed"; error: unknown }> => {
        try {
          const provider = await this.getProvider();
          return await provider.stopForDeletion(sandboxId, locator ?? undefined);
        } catch (error) {
          // error-policy:J1 provider boundary translation — deletion records the
          // exact stop failure so the outer workflow can report a structured outcome.
          return { kind: "stop-failed", error };
        }
      })(),
      SANDBOX_DELETE_STOP_TIMEOUT_MS,
      `agent-delete stop ${sandboxId}`,
    ).catch(
      // error-policy:J1 timeout boundary translation — the deletion workflow
      // distinguishes a bounded timeout from a completed provider failure.
      (error: unknown) => ({ kind: "stop-timed-out" as const, error }),
    );
  }

  /**
   * Replacement teardown is stricter than deletion: it may not abandon an
   * unreachable workload because a second container would produce two live
   * agents when the old node recovers. Providers must positively implement the
   * absence-proof boundary; missing support, errors, and timeouts all preserve
   * the database fence and block replacement.
   */
  private async runBoundedSandboxStopForReplacement(
    sandboxId: string,
  ): Promise<BoundedSandboxStopResult> {
    return withTimeout(
      (async (): Promise<null | { error: unknown }> => {
        try {
          const provider = await this.getProvider();
          if (!provider.stopForReplacement) {
            throw new Error("Sandbox provider cannot prove workload absence before replacement");
          }
          await provider.stopForReplacement(sandboxId);
          return null;
        } catch (error) {
          // error-policy:J1 provider boundary translation — replacement remains
          // fenced until the structured stop failure is handled by its caller.
          return { error };
        }
      })(),
      SANDBOX_DELETE_STOP_TIMEOUT_MS,
      `agent-replacement stop ${sandboxId}`,
    ).catch(
      // error-policy:J1 timeout boundary translation — an unproven replacement
      // stop is an explicit timed-out failure, never inferred absence.
      (error: unknown) => ({ error, timedOut: true as const }),
    );
  }
  executeDeletion(
    ...args: Parameters<SandboxDeletion["executeDeletion"]>
  ): ReturnType<SandboxDeletion["executeDeletion"]> {
    return this.#deletion.executeDeletion(...args);
  }
  provision(
    ...args: Parameters<SandboxProvision["provision"]>
  ): ReturnType<SandboxProvision["provision"]> {
    return this.#provision.provision(...args);
  }
  private getSafeBridgeEndpoint(
    ...args: Parameters<SandboxTransport["getSafeBridgeEndpoint"]>
  ): ReturnType<SandboxTransport["getSafeBridgeEndpoint"]> {
    return this.transport.getSafeBridgeEndpoint(...args);
  }
  private getConfiguredAgentBaseDomain(
    ...args: Parameters<SandboxTransport["getConfiguredAgentBaseDomain"]>
  ): ReturnType<SandboxTransport["getConfiguredAgentBaseDomain"]> {
    return this.transport.getConfiguredAgentBaseDomain(...args);
  }
  private normalizeConfiguredHostname(
    ...args: Parameters<SandboxTransport["normalizeConfiguredHostname"]>
  ): ReturnType<SandboxTransport["normalizeConfiguredHostname"]> {
    return this.transport.normalizeConfiguredHostname(...args);
  }
  private getRequiredWorkerRoutingHost(
    ...args: Parameters<SandboxTransport["getRequiredWorkerRoutingHost"]>
  ): ReturnType<SandboxTransport["getRequiredWorkerRoutingHost"]> {
    return this.transport.getRequiredWorkerRoutingHost(...args);
  }
  private getWorkerAgentRouterFetchTarget(
    ...args: Parameters<SandboxTransport["getWorkerAgentRouterFetchTarget"]>
  ): ReturnType<SandboxTransport["getWorkerAgentRouterFetchTarget"]> {
    return this.transport.getWorkerAgentRouterFetchTarget(...args);
  }
  private getAgentApiFetchTarget(
    ...args: Parameters<SandboxTransport["getAgentApiFetchTarget"]>
  ): ReturnType<SandboxTransport["getAgentApiFetchTarget"]> {
    return this.transport.getAgentApiFetchTarget(...args);
  }
  private fetchAgentTarget(
    ...args: Parameters<SandboxTransport["fetchAgentTarget"]>
  ): ReturnType<SandboxTransport["fetchAgentTarget"]> {
    return this.transport.fetchAgentTarget(...args);
  }
  private fetchAgentApi(
    ...args: Parameters<SandboxTransport["fetchAgentApi"]>
  ): ReturnType<SandboxTransport["fetchAgentApi"]> {
    return this.transport.fetchAgentApi(...args);
  }
  private fetchCanonicalConversationApi(
    ...args: Parameters<SandboxTransport["fetchCanonicalConversationApi"]>
  ): ReturnType<SandboxTransport["fetchCanonicalConversationApi"]> {
    return this.transport.fetchCanonicalConversationApi(...args);
  }
  private getAgentWebFetchTarget(
    ...args: Parameters<SandboxTransport["getAgentWebFetchTarget"]>
  ): ReturnType<SandboxTransport["getAgentWebFetchTarget"]> {
    return this.transport.getAgentWebFetchTarget(...args);
  }
  private fetchAgentWeb(
    ...args: Parameters<SandboxTransport["fetchAgentWeb"]>
  ): ReturnType<SandboxTransport["fetchAgentWeb"]> {
    return this.transport.fetchAgentWeb(...args);
  }
  private getAgentWebEndpoint(
    ...args: Parameters<SandboxTransport["getAgentWebEndpoint"]>
  ): ReturnType<SandboxTransport["getAgentWebEndpoint"]> {
    return this.transport.getAgentWebEndpoint(...args);
  }
  private getTrustedDockerWebBaseUrl(
    ...args: Parameters<SandboxTransport["getTrustedDockerWebBaseUrl"]>
  ): ReturnType<SandboxTransport["getTrustedDockerWebBaseUrl"]> {
    return this.transport.getTrustedDockerWebBaseUrl(...args);
  }
  private getTrustedDockerBridgeBaseUrl(
    ...args: Parameters<SandboxTransport["getTrustedDockerBridgeBaseUrl"]>
  ): ReturnType<SandboxTransport["getTrustedDockerBridgeBaseUrl"]> {
    return this.transport.getTrustedDockerBridgeBaseUrl(...args);
  }
  private isTrustedLegacyPrivateBridgeUrl(
    ...args: Parameters<SandboxTransport["isTrustedLegacyPrivateBridgeUrl"]>
  ): ReturnType<SandboxTransport["isTrustedLegacyPrivateBridgeUrl"]> {
    return this.transport.isTrustedLegacyPrivateBridgeUrl(...args);
  }
  private isLegacyDockerSandboxId(
    ...args: Parameters<SandboxTransport["isLegacyDockerSandboxId"]>
  ): ReturnType<SandboxTransport["isLegacyDockerSandboxId"]> {
    return this.transport.isLegacyDockerSandboxId(...args);
  }
  private isAgentPrivateBridgeHost(
    ...args: Parameters<SandboxTransport["isAgentPrivateBridgeHost"]>
  ): ReturnType<SandboxTransport["isAgentPrivateBridgeHost"]> {
    return this.transport.isAgentPrivateBridgeHost(...args);
  }
  private matchesTrustedDockerBridge(
    ...args: Parameters<SandboxTransport["matchesTrustedDockerBridge"]>
  ): ReturnType<SandboxTransport["matchesTrustedDockerBridge"]> {
    return this.transport.matchesTrustedDockerBridge(...args);
  }
  private isCloudflareWorkerRuntime(
    ...args: Parameters<SandboxTransport["isCloudflareWorkerRuntime"]>
  ): ReturnType<SandboxTransport["isCloudflareWorkerRuntime"]> {
    return this.transport.isCloudflareWorkerRuntime(...args);
  }
  private sharedRuntimeStringValue(
    ...args: Parameters<ActiveSandboxBridge["sharedRuntimeStringValue"]>
  ): ReturnType<ActiveSandboxBridge["sharedRuntimeStringValue"]> {
    return this.#bridge.sharedRuntimeStringValue(...args);
  }
  private sharedRuntimeStringList(
    ...args: Parameters<ActiveSandboxBridge["sharedRuntimeStringList"]>
  ): ReturnType<ActiveSandboxBridge["sharedRuntimeStringList"]> {
    return this.#bridge.sharedRuntimeStringList(...args);
  }
  private isSharedTurnMessage(
    ...args: Parameters<ActiveSandboxBridge["isSharedTurnMessage"]>
  ): ReturnType<ActiveSandboxBridge["isSharedTurnMessage"]> {
    return this.#bridge.isSharedTurnMessage(...args);
  }
  private loadSharedRuntimeHistory(
    ...args: Parameters<ActiveSandboxBridge["loadSharedRuntimeHistory"]>
  ): ReturnType<ActiveSandboxBridge["loadSharedRuntimeHistory"]> {
    return this.#bridge.loadSharedRuntimeHistory(...args);
  }
  private saveSharedRuntimeHistory(
    ...args: Parameters<ActiveSandboxBridge["saveSharedRuntimeHistory"]>
  ): ReturnType<ActiveSandboxBridge["saveSharedRuntimeHistory"]> {
    return this.#bridge.saveSharedRuntimeHistory(...args);
  }
  private sharedRuntimeBillingPrompt(
    ...args: Parameters<ActiveSandboxBridge["sharedRuntimeBillingPrompt"]>
  ): ReturnType<ActiveSandboxBridge["sharedRuntimeBillingPrompt"]> {
    return this.#bridge.sharedRuntimeBillingPrompt(...args);
  }
  private sharedRuntimeBillingUsage(
    ...args: Parameters<ActiveSandboxBridge["sharedRuntimeBillingUsage"]>
  ): ReturnType<ActiveSandboxBridge["sharedRuntimeBillingUsage"]> {
    return this.#bridge.sharedRuntimeBillingUsage(...args);
  }
  private sharedRuntimeBillingUsageForReply(
    ...args: Parameters<ActiveSandboxBridge["sharedRuntimeBillingUsageForReply"]>
  ): ReturnType<ActiveSandboxBridge["sharedRuntimeBillingUsageForReply"]> {
    return this.#bridge.sharedRuntimeBillingUsageForReply(...args);
  }
  private buildSharedRuntimeCharacter(
    ...args: Parameters<ActiveSandboxBridge["buildSharedRuntimeCharacter"]>
  ): ReturnType<ActiveSandboxBridge["buildSharedRuntimeCharacter"]> {
    return this.#bridge.buildSharedRuntimeCharacter(...args);
  }
  private bridgeSharedStatus(
    ...args: Parameters<ActiveSandboxBridge["bridgeSharedStatus"]>
  ): ReturnType<ActiveSandboxBridge["bridgeSharedStatus"]> {
    return this.#bridge.bridgeSharedStatus(...args);
  }
  private bridgeSharedMessageSend(
    ...args: Parameters<ActiveSandboxBridge["bridgeSharedMessageSend"]>
  ): ReturnType<ActiveSandboxBridge["bridgeSharedMessageSend"]> {
    return this.#bridge.bridgeSharedMessageSend(...args);
  }
  private bridgeSharedMessageStream(
    ...args: Parameters<ActiveSandboxBridge["bridgeSharedMessageStream"]>
  ): ReturnType<ActiveSandboxBridge["bridgeSharedMessageStream"]> {
    return this.#bridge.bridgeSharedMessageStream(...args);
  }
  getSharedConversationHistory(
    ...args: Parameters<ActiveSandboxBridge["getSharedConversationHistory"]>
  ): ReturnType<ActiveSandboxBridge["getSharedConversationHistory"]> {
    return this.#bridge.getSharedConversationHistory(...args);
  }
  getSharedRuntimeCharacter(
    ...args: Parameters<ActiveSandboxBridge["getSharedRuntimeCharacter"]>
  ): ReturnType<ActiveSandboxBridge["getSharedRuntimeCharacter"]> {
    return this.#bridge.getSharedRuntimeCharacter(...args);
  }
  pushClaimedWarmContainerCharacter(
    ...args: Parameters<SandboxWarmClaim["pushClaimedWarmContainerCharacter"]>
  ): ReturnType<SandboxWarmClaim["pushClaimedWarmContainerCharacter"]> {
    return this.#warmClaim.pushClaimedWarmContainerCharacter(...args);
  }
  pushClaimedWarmContainerInferenceKey(
    ...args: Parameters<SandboxWarmClaim["pushClaimedWarmContainerInferenceKey"]>
  ): ReturnType<SandboxWarmClaim["pushClaimedWarmContainerInferenceKey"]> {
    return this.#warmClaim.pushClaimedWarmContainerInferenceKey(...args);
  }
  recoverPendingWarmClaimInferenceKey(
    ...args: Parameters<SandboxWarmClaim["recoverPendingWarmClaimInferenceKey"]>
  ): ReturnType<SandboxWarmClaim["recoverPendingWarmClaimInferenceKey"]> {
    return this.#warmClaim.recoverPendingWarmClaimInferenceKey(...args);
  }
  private prepareLegacyWarmClaimCredentialRecovery(
    ...args: Parameters<SandboxWarmClaim["prepareLegacyWarmClaimCredentialRecovery"]>
  ): ReturnType<SandboxWarmClaim["prepareLegacyWarmClaimCredentialRecovery"]> {
    return this.#warmClaim.prepareLegacyWarmClaimCredentialRecovery(...args);
  }
  private retireFailedWarmClaimForRetry(
    ...args: Parameters<SandboxWarmClaim["retireFailedWarmClaimForRetry"]>
  ): ReturnType<SandboxWarmClaim["retireFailedWarmClaimForRetry"]> {
    return this.#warmClaim.retireFailedWarmClaimForRetry(...args);
  }
  cleanupFailedWarmClaimCredentialHandoff(
    ...args: Parameters<SandboxWarmClaim["cleanupFailedWarmClaimCredentialHandoff"]>
  ): ReturnType<SandboxWarmClaim["cleanupFailedWarmClaimCredentialHandoff"]> {
    return this.#warmClaim.cleanupFailedWarmClaimCredentialHandoff(...args);
  }
  private completeWarmClaimCredentialHandoff(
    ...args: Parameters<SandboxWarmClaim["completeWarmClaimCredentialHandoff"]>
  ): ReturnType<SandboxWarmClaim["completeWarmClaimCredentialHandoff"]> {
    return this.#warmClaim.completeWarmClaimCredentialHandoff(...args);
  }
  private finalizeWarmClaimCredentialHandoff(
    ...args: Parameters<SandboxWarmClaim["finalizeWarmClaimCredentialHandoff"]>
  ): ReturnType<SandboxWarmClaim["finalizeWarmClaimCredentialHandoff"]> {
    return this.#warmClaim.finalizeWarmClaimCredentialHandoff(...args);
  }
  bridge(
    ...args: Parameters<ActiveSandboxBridge["bridge"]>
  ): ReturnType<ActiveSandboxBridge["bridge"]> {
    return this.#bridge.bridge(...args);
  }
  private bridgeStatus(
    ...args: Parameters<ActiveSandboxBridge["bridgeStatus"]>
  ): ReturnType<ActiveSandboxBridge["bridgeStatus"]> {
    return this.#bridge.bridgeStatus(...args);
  }
  private bridgeMessageSend(
    ...args: Parameters<ActiveSandboxBridge["bridgeMessageSend"]>
  ): ReturnType<ActiveSandboxBridge["bridgeMessageSend"]> {
    return this.#bridge.bridgeMessageSend(...args);
  }
  private bridgeResponseHasText(
    ...args: Parameters<ActiveSandboxBridge["bridgeResponseHasText"]>
  ): ReturnType<ActiveSandboxBridge["bridgeResponseHasText"]> {
    return this.#bridge.bridgeResponseHasText(...args);
  }
  private extractBridgeFailureKind(
    ...args: Parameters<ActiveSandboxBridge["extractBridgeFailureKind"]>
  ): ReturnType<ActiveSandboxBridge["extractBridgeFailureKind"]> {
    return this.#bridge.extractBridgeFailureKind(...args);
  }
  private bridgeNativeJsonRpcSend(
    ...args: Parameters<ActiveSandboxBridge["bridgeNativeJsonRpcSend"]>
  ): ReturnType<ActiveSandboxBridge["bridgeNativeJsonRpcSend"]> {
    return this.#bridge.bridgeNativeJsonRpcSend(...args);
  }
  private bridgeConversationMessageSend(
    ...args: Parameters<ActiveSandboxBridge["bridgeConversationMessageSend"]>
  ): ReturnType<ActiveSandboxBridge["bridgeConversationMessageSend"]> {
    return this.#bridge.bridgeConversationMessageSend(...args);
  }

  /**
   * Recreates an authoritative cutover conversation after a Dedicated runtime
   * loses its local conversation index during relocation or fresh boot. Exact
   * source ids make concurrent repairs idempotent at the runtime boundary.
   */
  async importCanonicalConversation(
    agentId: string,
    orgId: string,
    conversationId: string,
    messages: Array<{
      sourceId: string;
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
    }>,
  ): Promise<{
    complete: true;
    sourceMessageCount: number;
    inserted: number;
    skipped: number;
  } | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) return null;
    const serverSecret = getCloudAwareEnv().AGENT_SERVER_SHARED_SECRET?.trim();
    if (!serverSecret) return null;

    const res = await this.fetchCanonicalConversationApi(
      rec,
      `/api/conversations/${encodeURIComponent(conversationId)}/import`,
      {
        method: "POST",
        headers: { "X-Server-Token": serverSecret },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(20_000),
      },
      rec.bridge_url,
    );
    if (!res.ok) return null;

    // error-policy:J3 an unreadable import receipt is explicitly invalid and
    // cannot authorize the connector retry.
    const body = (await res.json().catch(() => null)) as {
      conversationId?: unknown;
      complete?: unknown;
      sourceMessageCount?: unknown;
      inserted?: unknown;
      skipped?: unknown;
    } | null;
    if (!body || typeof body.inserted !== "number" || typeof body.skipped !== "number") {
      return null;
    }
    const inserted = body.inserted;
    const skipped = body.skipped;
    const countsMatch = inserted + skipped === messages.length;
    const modernReceipt = body?.complete === true && body.sourceMessageCount === messages.length;
    const legacyReceipt =
      body?.complete === undefined &&
      body.sourceMessageCount === undefined &&
      body.conversationId === conversationId;
    if (!countsMatch || (!modernReceipt && !legacyReceipt)) {
      return null;
    }
    return {
      complete: true,
      sourceMessageCount: messages.length,
      inserted,
      skipped,
    };
  }

  private async bridgeMessagingSessionSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const sessionId = await this.createBridgeMessagingSession(rec, runtimeAgent.id, params);
    const res = await this.fetchAgentApi(
      rec,
      `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(this.buildBridgeSessionMessageBody(params)),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const agentText = await this.waitForBridgeSessionAgentReply(rec, sessionId, runtimeAgent.id);
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: agentText ?? "",
        accepted: true,
        runtimeAgentId: runtimeAgent.id,
        agentName: runtimeAgent.name,
        sessionId,
        messageId: typeof body.id === "string" ? body.id : undefined,
      },
    };
  }
  private bridgeCentralChannelMessageSend(
    ...args: Parameters<ActiveSandboxBridge["bridgeCentralChannelMessageSend"]>
  ): ReturnType<ActiveSandboxBridge["bridgeCentralChannelMessageSend"]> {
    return this.#bridge.bridgeCentralChannelMessageSend(...args);
  }
  private bridgeOpenAiChatCompletionSend(
    ...args: Parameters<ActiveSandboxBridge["bridgeOpenAiChatCompletionSend"]>
  ): ReturnType<ActiveSandboxBridge["bridgeOpenAiChatCompletionSend"]> {
    return this.#bridge.bridgeOpenAiChatCompletionSend(...args);
  }
  private requestBridgeOpenAiChatCompletion(
    ...args: Parameters<ActiveSandboxBridge["requestBridgeOpenAiChatCompletion"]>
  ): ReturnType<ActiveSandboxBridge["requestBridgeOpenAiChatCompletion"]> {
    return this.#bridge.requestBridgeOpenAiChatCompletion(...args);
  }
  private buildBridgeOpenAiChatBody(
    ...args: Parameters<ActiveSandboxBridge["buildBridgeOpenAiChatBody"]>
  ): ReturnType<ActiveSandboxBridge["buildBridgeOpenAiChatBody"]> {
    return this.#bridge.buildBridgeOpenAiChatBody(...args);
  }
  private buildBridgeNoReplyFallbackText(
    ...args: Parameters<ActiveSandboxBridge["buildBridgeNoReplyFallbackText"]>
  ): ReturnType<ActiveSandboxBridge["buildBridgeNoReplyFallbackText"]> {
    return this.#bridge.buildBridgeNoReplyFallbackText(...args);
  }
  private createBridgeConversation(
    ...args: Parameters<ActiveSandboxBridge["createBridgeConversation"]>
  ): ReturnType<ActiveSandboxBridge["createBridgeConversation"]> {
    return this.#bridge.createBridgeConversation(...args);
  }

  private async createBridgeMessagingSession(
    rec: AgentSandbox,
    runtimeAgentId: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const res = await this.fetchAgentApi(rec, "/api/messaging/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: runtimeAgentId,
        userId: this.stableBridgeUserId(params),
        metadata: {
          source:
            typeof params.source === "string" && params.source.trim()
              ? params.source.trim()
              : "cloud",
          roomId: typeof params.roomId === "string" ? params.roomId : undefined,
          sender:
            params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
              ? params.sender
              : undefined,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError("Messaging sessions API is unavailable", res.status);
    }
    if (!res.ok) {
      throw new Error(`Bridge session create returned HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    if (!sessionId) {
      throw new Error("Bridge session create response was missing sessionId");
    }
    return sessionId;
  }
  private buildBridgeConversationMessageBody(
    ...args: Parameters<ActiveSandboxBridge["buildBridgeConversationMessageBody"]>
  ): ReturnType<ActiveSandboxBridge["buildBridgeConversationMessageBody"]> {
    return this.#bridge.buildBridgeConversationMessageBody(...args);
  }

  private buildBridgeSessionMessageBody(params: Record<string, unknown>): Record<string, unknown> {
    return {
      content: typeof params.text === "string" ? params.text : "",
      attachments: Array.isArray(params.attachments) ? params.attachments : undefined,
      metadata: {
        ...(params.metadata &&
        typeof params.metadata === "object" &&
        !Array.isArray(params.metadata)
          ? (params.metadata as Record<string, unknown>)
          : {}),
        source:
          typeof params.source === "string" && params.source.trim()
            ? params.source.trim()
            : "cloud",
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
      },
    };
  }
  private buildBridgeCentralChannelMessageBody(
    ...args: Parameters<ActiveSandboxBridge["buildBridgeCentralChannelMessageBody"]>
  ): ReturnType<ActiveSandboxBridge["buildBridgeCentralChannelMessageBody"]> {
    return this.#bridge.buildBridgeCentralChannelMessageBody(...args);
  }
  private getBridgeMessages(
    ...args: Parameters<ActiveSandboxBridge["getBridgeMessages"]>
  ): ReturnType<ActiveSandboxBridge["getBridgeMessages"]> {
    return this.#bridge.getBridgeMessages(...args);
  }
  private normalizeBridgeRole(
    ...args: Parameters<ActiveSandboxBridge["normalizeBridgeRole"]>
  ): ReturnType<ActiveSandboxBridge["normalizeBridgeRole"]> {
    return this.#bridge.normalizeBridgeRole(...args);
  }
  private bridgeRoleIsAgent(
    ...args: Parameters<ActiveSandboxBridge["bridgeRoleIsAgent"]>
  ): ReturnType<ActiveSandboxBridge["bridgeRoleIsAgent"]> {
    return this.#bridge.bridgeRoleIsAgent(...args);
  }
  private bridgeRoleIsUser(
    ...args: Parameters<ActiveSandboxBridge["bridgeRoleIsUser"]>
  ): ReturnType<ActiveSandboxBridge["bridgeRoleIsUser"]> {
    return this.#bridge.bridgeRoleIsUser(...args);
  }
  private bridgeMessageIdMatches(
    ...args: Parameters<ActiveSandboxBridge["bridgeMessageIdMatches"]>
  ): ReturnType<ActiveSandboxBridge["bridgeMessageIdMatches"]> {
    return this.#bridge.bridgeMessageIdMatches(...args);
  }
  private nestedBridgeRecord(
    ...args: Parameters<ActiveSandboxBridge["nestedBridgeRecord"]>
  ): ReturnType<ActiveSandboxBridge["nestedBridgeRecord"]> {
    return this.#bridge.nestedBridgeRecord(...args);
  }
  private isBridgeAgentMessage(
    ...args: Parameters<ActiveSandboxBridge["isBridgeAgentMessage"]>
  ): ReturnType<ActiveSandboxBridge["isBridgeAgentMessage"]> {
    return this.#bridge.isBridgeAgentMessage(...args);
  }
  private extractBridgeTextValue(
    ...args: Parameters<ActiveSandboxBridge["extractBridgeTextValue"]>
  ): ReturnType<ActiveSandboxBridge["extractBridgeTextValue"]> {
    return this.#bridge.extractBridgeTextValue(...args);
  }
  private extractBridgeMessageText(
    ...args: Parameters<ActiveSandboxBridge["extractBridgeMessageText"]>
  ): ReturnType<ActiveSandboxBridge["extractBridgeMessageText"]> {
    return this.#bridge.extractBridgeMessageText(...args);
  }
  private extractBridgeErrorMessage(
    ...args: Parameters<ActiveSandboxBridge["extractBridgeErrorMessage"]>
  ): ReturnType<ActiveSandboxBridge["extractBridgeErrorMessage"]> {
    return this.#bridge.extractBridgeErrorMessage(...args);
  }
  private extractOpenAiChatCompletionText(
    ...args: Parameters<ActiveSandboxBridge["extractOpenAiChatCompletionText"]>
  ): ReturnType<ActiveSandboxBridge["extractOpenAiChatCompletionText"]> {
    return this.#bridge.extractOpenAiChatCompletionText(...args);
  }

  private async waitForBridgeSessionAgentReply(
    rec: AgentSandbox,
    sessionId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 24; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await this.fetchAgentApi(
        rec,
        `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages?limit=20`,
        {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.slice().reverse()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }
  private waitForBridgeCentralChannelAgentReply(
    ...args: Parameters<ActiveSandboxBridge["waitForBridgeCentralChannelAgentReply"]>
  ): ReturnType<ActiveSandboxBridge["waitForBridgeCentralChannelAgentReply"]> {
    return this.#bridge.waitForBridgeCentralChannelAgentReply(...args);
  }

  /**
   * Proxy an HTTP request to the agent's wallet API endpoint.
   * Used by the cloud backend to forward wallet/steward requests from the dashboard.
   *
   * @param agentId  - The sandbox record ID
   * @param orgId    - The organization ID (authorization)
   * @param walletPath - Path after `/api/wallet/`, e.g. "steward-policies"
   * @param method   - HTTP method ("GET" | "POST")
   * @param body     - Optional request body (for POST requests)
   * @param query    - Optional query string (e.g. "limit=20")
   * @returns The raw fetch Response, or null if the sandbox is not running
   */
  // Allowed wallet sub-paths for proxy (prevents path traversal)
  private static readonly ALLOWED_WALLET_PATHS = new Set([
    "addresses",
    "balances",
    "steward-status",
    "steward-policies",
    "steward-tx-records",
    "steward-pending-approvals",
    "steward-approve-tx",
    "steward-deny-tx",
  ]);

  // Allowed query parameters for wallet proxy
  private static readonly ALLOWED_QUERY_PARAMS = new Set([
    "limit",
    "offset",
    "cursor",
    "type",
    "status",
  ]);

  private static readonly ALLOWED_LIFEOPS_SCHEDULE_PATHS = new Set([
    "observations",
    "merged-state",
  ]);

  private static readonly ALLOWED_LIFEOPS_SCHEDULE_QUERY_PARAMS = new Set([
    "timezone",
    "scope",
    "refresh",
  ]);

  // Anchored regex: only the agent's known plugin-workflow surface is forwarded.
  // Source of truth: plugins/plugin-workflow/src/plugin-routes.ts.
  // Intentionally additive paths (executions/:id, :id/run) are forwarded too so
  // the cloud surface is ready when the plugin mounts them; until then the
  // agent will respond 404 and the cloud relays that 404 unchanged.
  private static readonly ALLOWED_WORKFLOW_PATH_PATTERNS: readonly RegExp[] = [
    /^workflows$/,
    /^workflows\/generate$/,
    /^workflows\/resolve-clarification$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/activate$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/deactivate$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/run$/,
    /^executions$/,
    /^executions\/[a-zA-Z0-9_-]{1,128}$/,
    /^status$/,
  ];

  private static readonly ALLOWED_WORKFLOW_QUERY_PARAMS = new Set([
    "limit",
    "cursor",
    "status",
    "workflowId",
  ]);

  async proxyWorkflowRequest(
    agentId: string,
    orgId: string,
    workflowPath: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    if (!ElizaSandboxService.ALLOWED_WORKFLOW_PATH_PATTERNS.some((re) => re.test(workflowPath))) {
      logger.warn("[agent-sandbox] Rejected workflow proxy: invalid path", {
        agentId,
        workflowPath,
      });
      return new Response(JSON.stringify({ error: "Invalid workflow endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_WORKFLOW_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Workflow proxy: sandbox not found or not running", {
        agentId,
        orgId,
        workflowPath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Workflow proxy: no bridge_url", {
        agentId,
        status: rec.status,
        workflowPath,
      });
      return null;
    }

    try {
      const fullPath = `/api/workflow/${workflowPath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (method !== "GET" && method !== "DELETE") {
        headers["Content-Type"] = "application/json";
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if ((method === "POST" || method === "PUT") && body != null) {
        fetchOptions.body = body;
      }
      return await this.fetchAgentApi(rec, fullPath, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Workflow proxy request failed", {
        agentId,
        workflowPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async proxyWalletRequest(
    agentId: string,
    orgId: string,
    walletPath: string,
    method: "GET" | "POST",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    // Validate wallet path against whitelist (prevents path traversal)
    if (!ElizaSandboxService.ALLOWED_WALLET_PATHS.has(walletPath)) {
      logger.warn("[agent-sandbox] Rejected wallet proxy: invalid path", {
        agentId,
        walletPath,
      });
      return new Response(JSON.stringify({ error: "Invalid wallet endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Sanitize query parameters
    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Wallet proxy: sandbox not found or not running", {
        agentId,
        orgId,
        walletPath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Wallet proxy: no bridge_url", {
        agentId,
        status: rec.status,
        walletPath,
      });
      return null;
    }

    try {
      const fullPath = `/api/wallet/${walletPath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await this.fetchAgentApi(rec, fullPath, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Wallet proxy request failed", {
        agentId,
        walletPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async proxyLifeOpsScheduleRequest(
    agentId: string,
    orgId: string,
    schedulePath: string,
    method: "GET" | "POST",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    if (!ElizaSandboxService.ALLOWED_LIFEOPS_SCHEDULE_PATHS.has(schedulePath)) {
      logger.warn("[agent-sandbox] Rejected schedule proxy: invalid path", {
        agentId,
        schedulePath,
      });
      return new Response(JSON.stringify({ error: "Invalid schedule endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_LIFEOPS_SCHEDULE_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Schedule proxy: sandbox not found or not running", {
        agentId,
        orgId,
        schedulePath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Schedule proxy: no bridge_url", {
        agentId,
        status: rec.status,
        schedulePath,
      });
      return null;
    }

    try {
      const fullPath = `/api/lifeops/schedule/${schedulePath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await this.fetchAgentApi(rec, fullPath, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Schedule proxy request failed", {
        agentId,
        schedulePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  bridgeStream(
    ...args: Parameters<ActiveSandboxBridge["bridgeStream"]>
  ): ReturnType<ActiveSandboxBridge["bridgeStream"]> {
    return this.#bridge.bridgeStream(...args);
  }
  private bridgeOpenAiChatCompletionSse(
    ...args: Parameters<ActiveSandboxBridge["bridgeOpenAiChatCompletionSse"]>
  ): ReturnType<ActiveSandboxBridge["bridgeOpenAiChatCompletionSse"]> {
    return this.#bridge.bridgeOpenAiChatCompletionSse(...args);
  }
  private createBridgeSseTextResponse(
    ...args: Parameters<ActiveSandboxBridge["createBridgeSseTextResponse"]>
  ): ReturnType<ActiveSandboxBridge["createBridgeSseTextResponse"]> {
    return this.#bridge.createBridgeSseTextResponse(...args);
  }
  normalizeBridgeSseResponse(
    ...args: Parameters<ActiveSandboxBridge["normalizeBridgeSseResponse"]>
  ): ReturnType<ActiveSandboxBridge["normalizeBridgeSseResponse"]> {
    return this.#bridge.normalizeBridgeSseResponse(...args);
  }
  private createBridgeSseErrorResponse(
    ...args: Parameters<ActiveSandboxBridge["createBridgeSseErrorResponse"]>
  ): ReturnType<ActiveSandboxBridge["createBridgeSseErrorResponse"]> {
    return this.#bridge.createBridgeSseErrorResponse(...args);
  }
  snapshot(...args: Parameters<SandboxBackup["snapshot"]>): ReturnType<SandboxBackup["snapshot"]> {
    return this.#backup.snapshot(...args);
  }

  /**
   * Carry an agent's durable state from the container it runs on today onto a
   * replacement container on another node.
   *
   * This exists because a blue/green replacement moves the CONTAINER, not the
   * state. Agent volumes are host bind-mounts (`/data/agents/<id>` mounted at
   * `/root/.eliza`), so the pglite data directory does not follow a container
   * to a new machine, and the `pre-upgrade` snapshot the upgrade path takes is
   * only a rollback point — it is never pushed into the new container. A
   * relocation built on the upgrade sequence alone would therefore start the
   * agent on an empty database and destroy the old one on cutover.
   *
   * The only cross-node transport is the application-level snapshot/restore
   * rail, which is node-agnostic by construction. This method is that rail,
   * with the ordering that makes it safe:
   *
   *   1. capture from the OLD container while it is still live and serving;
   *   2. reconstruct, so a backup that cannot be replayed is caught here;
   *   3. push onto the new container.
   *
   * It never reports success without a completed push, so the caller may only
   * retire the old placement once this resolves `transferred: true`. An image
   * that cannot snapshot is reported as `capture-unsupported` rather than as a
   * failure: such an agent is not relocatable, and the caller must leave it
   * where it is instead of moving it without its data.
   */
  async transferStateForRelocation(opts: {
    agentId: string;
    orgId: string;
    targetBridgeUrl: string;
    /** Carries the agent's API token so the restore is not rejected (#15261). */
    authRec: Pick<AgentSandbox, "id" | "environment_vars">;
  }): Promise<StateTransferOutcome> {
    const captured = await this.snapshot(opts.agentId, opts.orgId, "pre-move");
    if (!captured.success || !captured.backup) {
      const detail = captured.error ?? "unknown snapshot failure";
      return {
        transferred: false,
        reason: detail === SNAPSHOT_ENDPOINT_UNSUPPORTED ? "capture-unsupported" : "capture-failed",
        detail,
      };
    }

    const restoreState = await agentSandboxesRepository.getReconstructedBackupState(
      captured.backup.id,
    );
    if (!restoreState) {
      return {
        transferred: false,
        reason: "reconstruct-failed",
        detail: `pre-move backup ${captured.backup.id} could not be reconstructed`,
      };
    }

    try {
      await this.pushState(opts.targetBridgeUrl, restoreState, {
        trusted: true,
        authRec: opts.authRec,
      });
    } catch (error) {
      // error-policy:J2 the caller decides what to do with a half-moved agent,
      // and it can only decide correctly if the reason survives.
      return {
        transferred: false,
        reason: "push-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      transferred: true,
      snapshotId: captured.backup.id,
      sizeBytes: captured.backup.size_bytes ?? 0,
    };
  }
  private buildBackupInput(
    ...args: Parameters<SandboxBackup["buildBackupInput"]>
  ): ReturnType<SandboxBackup["buildBackupInput"]> {
    return this.#backup.buildBackupInput(...args);
  }

  async restore(agentId: string, orgId: string, backupId?: string): Promise<SnapshotResult> {
    // Selection comes from the tenant-scoped primary. It is only a capture for
    // doing backup hydration/reconstruction outside the lifecycle transaction;
    // live push authority is re-read under the advisory + row locks below.
    const rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" };

    const initialAuthorityRejection = restoreAuthorityRejection(rec);
    if (initialAuthorityRejection) {
      return { success: false, error: initialAuthorityRejection };
    }

    const restoringRunningGeneration = rec.status === "running";
    if (restoringRunningGeneration && !rec.bridge_url) {
      return { success: false, error: "Running agent is missing its restore endpoint" };
    }
    if (restoringRunningGeneration && this.getReplacementCleanupLocator(rec)) {
      return {
        success: false,
        error: "Agent restore cannot start while replacement cleanup is pending",
      };
    }

    // Read the stored row before KMS/R2 hydration. A foreign explicit id is
    // intentionally indistinguishable from a missing id and never releases
    // another tenant's backup payload to the hydration path.
    const storedBackup = backupId
      ? await agentSandboxesRepository.getStoredBackupById(backupId)
      : await agentSandboxesRepository.getLatestStoredBackup(rec.id);
    if (!storedBackup || storedBackup.sandbox_record_id !== rec.id) {
      return { success: false, error: "No backup found" };
    }

    if (!restoringRunningGeneration && backupId) {
      const latestBackup = await agentSandboxesRepository.getLatestStoredBackup(rec.id);
      if (!latestBackup || storedBackup.id !== latestBackup.id) {
        return {
          success: false,
          error: "Stopped agents can only restore the latest backup",
        };
      }
    }

    if (!restoringRunningGeneration) {
      // Pin the restore point selected above. `from-backup` also makes
      // provision fail closed rather than silently degrading this explicit
      // restore to a fresh boot. Provision admission itself remains a separate
      // lifecycle operation with its own authority fence.
      const backup = await hydrateAgentSandboxBackup(storedBackup);
      const prov = await this.provision(agentId, orgId, {
        kind: "from-backup",
        backupId: storedBackup.id,
        requireRestoreEndpoint: true,
        expectedAdmission: {
          id: rec.id,
          organization_id: rec.organization_id,
          status: rec.status,
          lifecycle_job_id: rec.lifecycle_job_id,
          lifecycle_execution_generation: rec.lifecycle_execution_generation,
          execution_tier: rec.execution_tier,
          pool_status: rec.pool_status,
          deleted_at: rec.deleted_at,
          deletion_attempt_id: rec.deletion_attempt_id,
          lifecycle_revision: rec.lifecycle_revision,
        },
      });
      return prov.success ? { success: true, backup } : { success: false, error: prov.error };
    }

    // Capture the complete target->base chain from the primary before
    // reconstruction. The reconstruction repository performs its own primary
    // reads; a second identical capture below proves no row used by that work
    // disappeared, crossed authority, changed payload/locator, or left the
    // legacy-visible lane while bytes were being materialized.
    const storedRestoreChain = await captureStoredRestoreChain(storedBackup.id, rec.id);
    if (
      !storedRestoreChain ||
      !storedRestorePointStillCanonical(storedRestoreChain[0]!, storedBackup)
    ) {
      return { success: false, error: RESTORE_BACKUP_CHANGED };
    }

    const backup = await hydrateAgentSandboxBackup(storedBackup);
    const restoreState = await agentSandboxesRepository.getReconstructedBackupState(
      storedBackup.id,
    );
    if (!restoreState) {
      return {
        success: false,
        error: `Backup ${storedBackup.id} could not be reconstructed`,
      };
    }
    const confirmedRestoreChain = await captureStoredRestoreChain(storedBackup.id, rec.id);
    if (
      !confirmedRestoreChain ||
      !storedRestoreChainStillCanonical(confirmedRestoreChain, storedRestoreChain)
    ) {
      return { success: false, error: RESTORE_BACKUP_CHANGED };
    }

    const authorized = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };

      const currentAuthorityRejection = restoreAuthorityRejection(current);
      if (currentAuthorityRejection) {
        return { success: false as const, error: currentAuthorityRejection };
      }
      if (current.status !== "running" || !current.bridge_url) {
        return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };
      }
      if (this.getReplacementCleanupLocator(current)) {
        return {
          success: false as const,
          error: "Agent restore cannot start while replacement cleanup is pending",
        };
      }
      if (await this.hasActiveExclusiveLifecycleJobTx(tx, agentId, orgId)) {
        return {
          success: false as const,
          error: "Agent restore cannot start while an exclusive lifecycle job is active",
        };
      }
      if (!restoreCaptureStillCanonical(current, rec)) {
        return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };
      }

      // Hold every row used by reconstruction through the push so prune and
      // catalogue work cannot retire or rewrite an ancestor after the payload
      // was materialized but before it is applied to the live runtime. Acquire
      // locks in UUID order so overlapping incremental chains cannot deadlock
      // by walking their parent links in opposite orders.
      const lockedRestoreChain = await tx
        .select()
        .from(agentSandboxBackups)
        .where(
          and(
            inArray(
              agentSandboxBackups.id,
              storedRestoreChain.map((row) => row.id),
            ),
            eq(agentSandboxBackups.sandbox_record_id, current.id),
            or(
              isNull(agentSandboxBackups.catalog_state),
              eq(agentSandboxBackups.catalog_state, "legacy_unmigrated"),
            ),
          ),
        )
        .orderBy(asc(agentSandboxBackups.id))
        .for("update")
        .execute();
      if (!storedRestoreChainStillCanonical(lockedRestoreChain, storedRestoreChain)) {
        return { success: false as const, error: RESTORE_BACKUP_CHANGED };
      }

      // Reserve a lifecycle generation BEFORE the irreversible runtime call.
      // This update remains invisible until commit and is rolled back if the
      // push fails, but trigger/CAS drift is detected before any runtime state
      // is changed. Network I/O under this bounded (120s) lock is the deliberate
      // availability tradeoff required to prevent two stale restores from
      // applying to one live generation.
      const [reserved] = await tx
        .update(agentSandboxes)
        .set({
          // The trigger must choose OLD + 1; requesting OLD - 1 also makes a
          // missing trigger fail the checked fence before any runtime push.
          lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} - 1`,
          last_heartbeat_at: sql`
            CASE
              WHEN ${agentSandboxes.last_heartbeat_at} IS NULL
                THEN date_trunc('milliseconds', clock_timestamp())
              ELSE GREATEST(
                ${agentSandboxes.last_heartbeat_at} + INTERVAL '1 millisecond',
                date_trunc('milliseconds', clock_timestamp())
              )
            END
          `,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "running"),
            eq(agentSandboxes.lifecycle_revision, current.lifecycle_revision),
            sql`${agentSandboxes.execution_tier} IS NOT DISTINCT FROM ${current.execution_tier}`,
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.deleted_at} IS NULL`,
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
      if (!reserved) {
        return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };
      }
      if (reserved.lifecycleRevision !== current.lifecycle_revision + 1) {
        // A returned row proves the CAS update ran. Committing it without the
        // lifecycle trigger would publish success metadata without fencing the
        // restored generation, so make trigger drift transaction-fatal.
        throw new Error("Restore lifecycle fence did not advance the generation");
      }

      await this.pushState(current, restoreState);

      // The reservation timestamp can age for the full push timeout. Stamp
      // completion only after the endpoint has answered, never moving a newer
      // concurrent heartbeat backwards. This second lifecycle write is
      // intentional: a successful live restore consumes one revision to
      // reserve the runtime mutation and one to publish its completion.
      const [completed] = await tx
        .update(agentSandboxes)
        .set({
          // The reservation already verified trigger authority. Publish only
          // the next monotonic revision after the runtime has applied state.
          lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
          last_heartbeat_at: sql`
            CASE
              WHEN ${agentSandboxes.last_heartbeat_at} IS NULL
                THEN date_trunc('milliseconds', clock_timestamp())
              ELSE GREATEST(
                ${agentSandboxes.last_heartbeat_at} + INTERVAL '1 millisecond',
                date_trunc('milliseconds', clock_timestamp())
              )
            END
          `,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "running"),
            eq(agentSandboxes.lifecycle_revision, reserved.lifecycleRevision),
            sql`${agentSandboxes.execution_tier} IS NOT DISTINCT FROM ${current.execution_tier}`,
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.deleted_at} IS NULL`,
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
      if (!completed || completed.lifecycleRevision !== reserved.lifecycleRevision + 1) {
        // The runtime has already applied the state. Commit the pre-push
        // reservation rather than rolling it back and permitting a stale retry;
        // surface the incomplete completion stamp to the caller.
        return {
          success: false as const,
          error: "Restore completed but its durable completion stamp failed",
        };
      }

      // The runtime and PostgreSQL cannot commit atomically: a runtime that
      // applies the payload just before the response/PG commit fails cannot be
      // rolled back here. A durable restore receipt/idempotency protocol is a
      // separate cross-system follow-up; this fence prevents stale generation
      // pushes but does not claim to solve that residual.
      return { success: true as const };
    });

    return authorized.success ? { success: true, backup } : authorized;
  }
  listBackups(
    ...args: Parameters<SandboxBackup["listBackups"]>
  ): ReturnType<SandboxBackup["listBackups"]> {
    return this.#backup.listBackups(...args);
  }

  // Heartbeat

  /**
   * A probe observes one running compute generation, then performs network I/O
   * without holding a database lock. Its writeback must therefore be fenced to
   * that exact generation and must lose to a durable delete intent.
   */
  private async updateObservedRunningGeneration(
    rec: AgentSandbox,
    data: Partial<NewAgentSandbox>,
  ): Promise<AgentSandbox | undefined> {
    return agentSandboxesRepository.update(rec.id, data, {
      organizationId: rec.organization_id,
      environmentRevision: rec.environment_revision,
      sandboxId: rec.sandbox_id,
      nodeId: rec.node_id,
      containerName: rec.container_name,
      lifecycleRevision: rec.lifecycle_revision,
    });
  }

  async heartbeat(agentId: string, orgId: string): Promise<boolean> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec || !isContainerBackedExecutionTier(rec.execution_tier) || !rec.bridge_url) {
      return false;
    }

    const probe = await this.probeBridgeHealthDetailed(rec);

    if (probe.kind === "terminal-db") {
      await this.handleTerminalDatabaseLivenessFailure(rec, probe.reason);
      return false;
    }

    if (!probe.ok) {
      // Hysteresis: one failed cycle is not enough to evict. last_heartbeat_at
      // is bumped only on success, so its age is how long the agent has been
      // continuously unreachable. Stay running inside the grace window (the next
      // cycle's retry re-warms the path); only disconnect once unreachable past
      // it.
      const lastOkMs = rec.last_heartbeat_at
        ? new Date(rec.last_heartbeat_at).getTime()
        : Date.now();
      const downForMs = Date.now() - lastOkMs;
      if (downForMs < HEARTBEAT_DISCONNECT_AFTER_MS) {
        logger.warn("[agent-sandbox] Heartbeat miss within grace window, keeping running", {
          agentId,
          downForMs,
          reason: probe.reason,
        });
        return false;
      }
      // Past-grace miss: before disconnecting (which reprovisions — destroying
      // and rebuilding the container), check whether the container is alive but
      // its stored tailnet IP went stale, and repair the columns in place. The
      // repair heals every consumer at once (this probe, the agent-router, the
      // public proxy) because they all read the same columns.
      const reconcile = await this.reconcileStaleTailnetIp(rec);
      if (reconcile.outcome === "repaired") {
        const updated = await this.updateObservedRunningGeneration(rec, {
          headscale_ip: reconcile.headscaleIp,
          bridge_url: reconcile.bridgeUrl,
          health_url: reconcile.healthUrl,
          last_heartbeat_at: new Date(),
          error_count: 0,
        });
        if (!updated) return false;
        logger.info(
          `[agent-sandbox] Reconciled stale tailnet IP ${rec.headscale_ip}→${reconcile.headscaleIp} for agent ${agentId}`,
        );
        return true;
      }
      if (reconcile.outcome === "ip-unresolvable") {
        // Docker reports the container healthy but the node cannot tell us its
        // current tailnet IP — indistinguishable from a transient SSH outage,
        // so disconnecting now could destroy a healthy paid container. Guard
        // error_count and only escalate once the cap of consecutive cycles is
        // hit, so an agent that stays unresolvable still reaches the
        // disconnect → reprovision self-heal instead of sitting unreachable
        // at "running" forever.
        const unresolvedCycles = (rec.error_count ?? 0) + 1;
        if (unresolvedCycles < IP_RECONCILE_MAX_UNRESOLVED_CYCLES) {
          await this.updateObservedRunningGeneration(rec, {
            error_count: unresolvedCycles,
          });
          logger.warn(
            "[agent-sandbox] Tailnet IP unresolvable for docker-healthy agent, deferring disconnect",
            { agentId, unresolvedCycles },
          );
          return false;
        }
      }
      logger.warn("[agent-sandbox] Heartbeat failed past grace window, marking disconnected", {
        agentId,
        downForMs,
        reason: probe.reason,
        reconcileOutcome: reconcile.outcome,
        ...(reconcile.outcome === "container-dead"
          ? { containerRuntimeFailureKind: reconcile.failureKind }
          : {}),
      });
      await this.updateObservedRunningGeneration(rec, {
        status: "disconnected",
      });
      return false;
    }
    const updated = await this.updateObservedRunningGeneration(rec, {
      last_heartbeat_at: new Date(),
      // Reset the unresolvable-cycle grace counter on any clean heartbeat so the
      // "escalate after 3 consecutive unresolvable cycles" window measures from
      // the last healthy beat, not a stale prior error_count from an old episode.
      error_count: 0,
    });
    return Boolean(updated);
  }

  /**
   * Probe the agent's bridge `/api/health` over the headscale tailnet with
   * retries. Shared by `heartbeat` (running agents) and `recoverDisconnected`
   * (disconnected always-on agents).
   *
   * The first attempt re-warms a cold tailnet path, so a single miss does not
   * mean the agent is down. Liveness MUST dial the BRIDGE port: the container
   * serves its full HTTP API there (and `/api/health` unauthed — the same
   * endpoint provisioning's health probe passes on); `web_ui_port` is a
   * host-only docker mapping NOT reachable over the tailnet. This exact form is
   * verified live in prod (a dedicated-always agent holds `running` and its
   * subdomain proxies 200/401).
   */
  private async probeBridgeHealth(
    rec: Pick<AgentSandbox, "id" | "environment_vars" | "bridge_url">,
  ): Promise<boolean> {
    return (await this.probeBridgeHealthDetailed(rec)).ok;
  }

  private async probeBridgeHealthDetailed(
    rec: Pick<AgentSandbox, "id" | "environment_vars" | "bridge_url">,
  ): Promise<BridgeHealthProbeResult> {
    if (!rec.bridge_url) {
      return { ok: false, kind: "unreachable", reason: "missing bridge_url" };
    }
    const endpoint = new URL("/api/health", rec.bridge_url).toString();
    let lastFailure: BridgeHealthProbeResult = {
      ok: false,
      kind: "unreachable",
      reason: "bridge health probe failed",
    };
    for (let attempt = 0; attempt < HEARTBEAT_PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_PROBE_RETRY_MS));
      }
      try {
        const res = await fetch(endpoint, {
          method: "GET",
          headers: this.getAgentJsonHeaders(rec),
          signal: AbortSignal.timeout(10_000),
        });
        const classified = await this.classifyBridgeHealthResponse(res);
        if (classified.ok) return classified;
        lastFailure = classified;
        if (classified.kind === "terminal-db") return classified;
      } catch (error) {
        lastFailure = {
          ok: false,
          kind: "unreachable",
          reason: error instanceof Error ? error.message : String(error),
        };
        logger.debug("[agent-sandbox] Bridge health probe attempt failed, retrying", {
          agentId: rec.id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return lastFailure;
  }

  private async classifyBridgeHealthResponse(res: Response): Promise<BridgeHealthProbeResult> {
    let payload: AgentRuntimeHealthPayload | null = null;
    try {
      payload = (await res.clone().json()) as AgentRuntimeHealthPayload;
    } catch {
      // error-policy:J3 malformed health JSON is an explicit unreachable probe result
      payload = null;
    }
    const databaseLiveness = payload?.databaseLiveness;
    const terminal =
      databaseLiveness?.terminal === true ||
      databaseLiveness?.status === "terminal_error" ||
      payload?.database === "terminal_error";
    if (terminal) {
      return {
        ok: false,
        kind: "terminal-db",
        reason:
          typeof databaseLiveness?.message === "string"
            ? databaseLiveness.message
            : "database liveness probe reported terminal failure",
      };
    }
    const transient =
      databaseLiveness?.status === "transient_error" || payload?.database === "transient_error";
    if (transient) {
      return {
        ok: false,
        kind: "transient",
        reason:
          typeof databaseLiveness?.message === "string"
            ? databaseLiveness.message
            : "database liveness probe reported transient failure",
      };
    }
    if (res.ok) return { ok: true, kind: "healthy" };
    return {
      ok: false,
      kind: "unreachable",
      reason: `/api/health returned ${res.status}`,
    };
  }

  private parseDatabaseLivenessRestartMarker(message: string | null): {
    count: number;
    at: number | null;
  } {
    if (!message?.includes(DB_LIVENESS_RESTART_MARKER)) {
      return { count: 0, at: null };
    }
    const countMatch = message.match(/count=(\d+)/);
    const atMatch = message.match(/at=([0-9TZ:.-]+)/);
    const parsedAt = atMatch ? Date.parse(atMatch[1]) : Number.NaN;
    return {
      count: countMatch ? Number(countMatch[1]) : 0,
      at: Number.isFinite(parsedAt) ? parsedAt : null,
    };
  }

  private async handleTerminalDatabaseLivenessFailure(
    rec: AgentSandbox,
    reason: string,
  ): Promise<void> {
    const marker = this.parseDatabaseLivenessRestartMarker(rec.error_message);
    const now = Date.now();
    // Keep this budget scoped to DB-liveness recovery. error_count is shared
    // with unrelated reconciliation paths and must not consume this budget.
    // An old DB-liveness episode also ages out so an agent is not permanently
    // barred from automatic recovery after three failures over its lifetime.
    const markerAge = marker.at === null ? null : now - marker.at;
    const markerActive =
      markerAge !== null && markerAge >= 0 && markerAge < DB_LIVENESS_RESTART_BUDGET_WINDOW_MS;
    const count = markerActive ? marker.count : 0;
    if (markerActive && markerAge !== null && markerAge < DB_LIVENESS_RESTART_COOLDOWN_MS) {
      logger.warn("[agent-sandbox] Terminal database liveness failure inside restart cooldown", {
        agentId: rec.id,
        count,
        reason,
      });
      return;
    }
    if (count >= DB_LIVENESS_RESTART_BUDGET) {
      const updated = await this.updateObservedRunningGeneration(rec, {
        status: "error",
        error_count: count,
        error_message: `${DB_LIVENESS_RESTART_MARKER} budget-exhausted count=${count} at=${new Date(now).toISOString()} reason=${reason}`,
      });
      logger.error("[agent-sandbox] Terminal database liveness restart budget exhausted", {
        agentId: rec.id,
        count,
        reason,
      });
      if (!updated) return;
      return;
    }

    const nextCount = count + 1;
    const updated = await this.updateObservedRunningGeneration(rec, {
      error_count: nextCount,
      error_message: `${DB_LIVENESS_RESTART_MARKER} count=${nextCount} at=${new Date(now).toISOString()} reason=${reason}`,
    });
    if (!updated) return;
    const { provisioningJobService } = await import("./provisioning-jobs");
    const result = await provisioningJobService.enqueueAgentRestartOnce({
      agentId: rec.id,
      organizationId: rec.organization_id,
      userId: rec.user_id,
    });
    logger.warn("[agent-sandbox] Enqueued restart for terminal database liveness failure", {
      agentId: rec.id,
      jobId: result.job.id,
      created: result.created,
      count: nextCount,
      reason,
    });
  }

  /**
   * SSH client for the docker node hosting the agent's container. Returns null
   * when the node cannot be located — the reconcile path treats that as "no
   * signal", never as evidence either way.
   */
  private async getNodeSshForAgent(
    rec: Pick<ReconcilableSandbox, "id" | "node_id">,
  ): Promise<DockerSSHClient | null> {
    if (!rec.node_id) return null;
    // error-policy:J4 best-effort node resolve — a DB/SSH-config failure here is
    // "cannot determine", not a heartbeat kill; the caller decides how to degrade.
    try {
      const node = await dockerNodesRepository.findByNodeId(rec.node_id);
      if (!node) return null;
      return DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user,
      );
    } catch (error) {
      logger.debug("[agent-sandbox] Failed to resolve docker node for reconcile", {
        agentId: rec.id,
        nodeId: rec.node_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Node-side docker health for the agent's container. This is the authority
   * that distinguishes a dead container (safe to disconnect → reprovision)
   * from a live one whose stored tailnet IP went stale (must be repaired, not
   * destroyed).
   */
  private async inspectContainerDockerHealth(
    rec: ReconcilableSandbox,
  ): Promise<ContainerRuntimeHealthObservation> {
    if (!rec.container_name) {
      return { healthy: false, failureKind: "inspect_unavailable" };
    }
    const ssh = await this.getNodeSshForAgent(rec);
    if (!ssh) return { healthy: false, failureKind: "inspect_unavailable" };
    // error-policy:J4 best-effort probe — an exec failure yields "not proven
    // healthy" (falls through to the existing disconnect self-heal), never a throw.
    try {
      const container = shellQuote(rec.container_name);
      const output = await ssh.exec(
        [
          `docker inspect --format 'state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' ${container} 2>/dev/null || true`,
          `logs="$(docker logs --tail 200 ${container} 2>&1 || true)"`,
          `printf 'module_resolution=%s\\n' "$(printf '%s' "$logs" | grep -Eqi 'ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module' && echo true || echo false)"`,
          `printf 'heap_oom=%s\\n' "$(printf '%s' "$logs" | grep -Eqi 'heap out of memory|allocation failed.*javascript heap' && echo true || echo false)"`,
          `printf 'startup_failed=%s\\n' "$(printf '%s' "$logs" | grep -Fqi '[eliza-autonomous] Failed to start:' && echo true || echo false)"`,
          `printf 'terminal_database=%s\\n' "$(printf '%s' "$logs" | grep -Eqi 'PGlite is closed|Database is shutting down' && echo true || echo false)"`,
          `printf 'memory_watchdog=%s\\n' "$(printf '%s' "$logs" | grep -Eqi '\\[MemoryWatchdog\\].*requesting clean restart' && echo true || echo false)"`,
          `printf 'port_conflict=%s\\n' "$(printf '%s' "$logs" | grep -Fqi 'EADDRINUSE' && echo true || echo false)"`,
          `printf 'mesh_auth=%s\\n' "$(printf '%s' "$logs" | grep -Eqi 'headscale auth key expired/rejected|tailscale requires interactive authorization' && echo true || echo false)"`,
          "unset logs",
        ].join("; "),
        RECONCILE_SSH_CMD_TIMEOUT_MS,
      );
      return classifyContainerRuntimeHealthObservation(output);
    } catch (error) {
      logger.debug("[agent-sandbox] Docker health inspect failed during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { healthy: false, failureKind: "inspect_unavailable" };
    }
  }

  /**
   * Resolve the container's CURRENT tailnet IP authoritatively from the node:
   * `tailscale --socket=/tmp/tailscaled.sock ip -4` inside the container is the same source the container
   * registered with, so it reflects the post-restart node key/IP — unlike the
   * stored headscale_ip, which is a provision-time snapshot.
   */
  private async resolveCurrentAgentTailnetIp(rec: ReconcilableSandbox): Promise<string | null> {
    if (!rec.container_name) return null;
    const ssh = await this.getNodeSshForAgent(rec);
    if (!ssh) return null;
    // error-policy:J4 best-effort resolve — a failed resolve returns null (no
    // positive signal), never throws; the caller guards toward disconnect.
    try {
      const out = await ssh.exec(
        `docker exec ${shellQuote(rec.container_name)} tailscale --socket=/tmp/tailscaled.sock ip -4`,
        RECONCILE_SSH_CMD_TIMEOUT_MS,
      );
      // First 100.64.0.0/10-shaped line; the CLI can also print IPv6 lines.
      const ip = out
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("100."));
      return ip && isIP(ip) === 4 ? ip : null;
    } catch (error) {
      logger.debug("[agent-sandbox] Current tailnet IP resolve failed during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Attempt to reconcile a bridge-probe miss as a stale stored tailnet IP.
   * Containers do not persist tailscale node state, so a restart mints a fresh
   * node key and headscale assigns the next IP — leaving headscale_ip /
   * bridge_url / health_url pointing at a dead address that EVERY consumer reads (the
   * heartbeat probe, the agent-router's subdomain resolution, and therefore
   * the public dedicated-agent proxy). Repairing the columns heals them all;
   * anything unrepairable falls back to the existing disconnect → reprovision
   * self-heal. A repair is admitted only for the provider's canonical tailnet
   * pair (same old IP and internal HTTP port); it swaps the host while retaining
   * the health path and moves every trusted ingress column to one generation.
   */
  private async reconcileStaleTailnetIp(
    rec: ReconcilableSandbox,
  ): Promise<TailnetIpReconcileResult> {
    const containerHealth = await this.inspectContainerDockerHealth(rec);
    if (!containerHealth.healthy) {
      return {
        outcome: "container-dead",
        failureKind: containerHealth.failureKind,
      };
    }
    const currentIp = await this.resolveCurrentAgentTailnetIp(rec);
    if (!currentIp) return { outcome: "ip-unresolvable" };
    // Same IP as stored = nothing to repair: the miss is genuine
    // unreachability at the correct address, so the dead-agent path applies.
    if (
      !rec.bridge_url ||
      !rec.health_url ||
      !rec.headscale_ip ||
      isIP(rec.headscale_ip) !== 4 ||
      currentIp === rec.headscale_ip
    ) {
      return { outcome: "unrepairable" };
    }

    let bridgeUrl: string;
    let healthUrl: string;
    try {
      const repairedBridge = new URL(rec.bridge_url);
      const repairedHealth = new URL(rec.health_url);
      // Bind the repair to the exact old tailnet generation. A non-tailnet
      // Docker row stores the node hostname plus host-published ports; swapping
      // only that hostname to a tailnet IP would manufacture unreachable URLs.
      // Canonical headscale handles use one internal HTTP port for both ingress
      // URLs, so reject mixed/corrupt generations and let reprovision rebuild
      // the pair from provider metadata.
      if (
        repairedBridge.protocol !== "http:" ||
        repairedHealth.protocol !== "http:" ||
        repairedBridge.hostname !== rec.headscale_ip ||
        repairedHealth.hostname !== rec.headscale_ip ||
        repairedBridge.port !== repairedHealth.port
      ) {
        return { outcome: "unrepairable" };
      }
      repairedBridge.hostname = currentIp;
      bridgeUrl = repairedBridge.origin;
      repairedHealth.hostname = currentIp;
      healthUrl = repairedHealth.toString();
    } catch (error) {
      // error-policy:J4 malformed stored ingress cannot be repaired in place;
      // degrade to the existing disconnect → reprovision self-heal.
      logger.warn("[agent-sandbox] Stored ingress URL unparsable during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "unrepairable" };
    }

    // Only a live answer on the repaired address proves the new IP is the
    // container we think it is — never persist an unverified repair.
    const reachable = await this.probeBridgeHealth({ ...rec, bridge_url: bridgeUrl });
    if (!reachable) return { outcome: "unrepairable" };
    return { outcome: "repaired", headscaleIp: currentIp, bridgeUrl, healthUrl };
  }
  private verifyReplacementRuntimeHealth(
    ...args: Parameters<SandboxImageSwap["verifyReplacementRuntimeHealth"]>
  ): ReturnType<SandboxImageSwap["verifyReplacementRuntimeHealth"]> {
    return this.#imageSwap.verifyReplacementRuntimeHealth(...args);
  }

  /**
   * Reconcile a recoverable always-on (paid) agent back to health. A
   * `dedicated-always` agent is contractually meant to stay up, so the recovery
   * cycle calls this to self-heal a transient drop: re-probe the bridge and, if
   * the container answers, flip it straight back to `running` (the agent-router
   * only routes `running`, so this also restores its subdomain). Blue/green
   * swaps can also leave a healthy bridge behind a stale `error` row; treat that
   * the same as `disconnected`, but only after the live bridge answers. If it
   * stays unreachable the caller re-provisions it. The guarded compare-and-set
   * write (not a blind update-by-id) makes this safe to run concurrently with
   * the heartbeat cycle AND with shutdown/delete/provision: the read -> probe ->
   * write window spans seconds, so we only flip a row that is STILL in the
   * probed recoverable status at write time.
   */
  async recoverDisconnected(
    agentId: string,
    orgId: string,
  ): Promise<"recovered" | "unreachable" | "gone"> {
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (
      !rec ||
      !isContainerBackedExecutionTier(rec.execution_tier) ||
      (rec.status !== "disconnected" && rec.status !== "error")
    ) {
      return "gone";
    }
    const reachable = await this.probeBridgeHealth(rec);
    if (!reachable) {
      // The stored bridge_url may simply be stale (container restart → new
      // tailnet IP) rather than the container being down. Repair-and-reprobe
      // before declaring it unreachable, so recovery does not reprovision —
      // destroy and rebuild — a healthy container that only needs its ingress
      // columns fixed. Anything unrepairable stays "unreachable" and
      // reprovisions exactly as before.
      const reconcile = await this.reconcileStaleTailnetIp(rec);
      if (reconcile.outcome !== "repaired") return "unreachable";
      // Same guarded CAS as the plain recovery flip below: only revive a row
      // that is STILL in the probed recoverable status, then persist the
      // repaired ingress columns on the now-running row.
      const revived = await agentSandboxesRepository.markReconnectedFromDisconnected(rec, {
        headscaleIp: reconcile.headscaleIp,
        bridgeUrl: reconcile.bridgeUrl,
        healthUrl: reconcile.healthUrl,
        errorCount: 0,
      });
      if (!revived) return "gone";
      logger.info(
        `[agent-sandbox] Reconciled stale tailnet IP ${rec.headscale_ip}→${reconcile.headscaleIp} for agent ${agentId}`,
      );
      return "recovered";
    }
    // Guarded CAS: the row can move to deletion_pending / stopped (which nulls
    // bridge_url) / provisioning during the multi-second probe. Only flip it if
    // it is STILL disconnected with a live bridge — otherwise we'd resurrect a
    // being-deleted agent or wedge a stopped one at `running` with a dead bridge.
    const restored = await agentSandboxesRepository.markReconnectedFromDisconnected(rec);
    if (!restored) return "gone";
    logger.info("[agent-sandbox] Recovered agent back to running", {
      agentId,
    });
    return "recovered";
  }

  /**
   * Reconcile a row WEDGED in `provisioning` whose container may actually be
   * healthy — the readiness-probe false-negative split-brain (#15310 #6). The
   * Worker-side cleanup cron can only mark such rows `error` (no SSH); THIS runs
   * on the daemon, which can re-probe the container node-side and, when it is
   * genuinely healthy, flip the row straight to `running` instead of failing a
   * live agent.
   *
   * Outcomes:
   *   - `recovered` — the container re-probed healthy and the row was CAS-flipped
   *     to `running`.
   *   - `unresolved` — the probe still could not confirm health (transport
   *     unresolved or genuinely not-ready). Left untouched for the next pass
   *     (or, eventually, the Worker cron's error mark). NEVER destroys the
   *     container: a wrong teardown here re-creates the very bug.
   *   - `gone` — the row moved on (no longer `provisioning`, deleted, or lost
   *     its container) during the multi-second probe; nothing to do.
   */
  async reconcileStuckProvisioning(
    agentId: string,
    orgId: string,
  ): Promise<"recovered" | "unresolved" | "gone"> {
    let rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (
      !rec ||
      !isContainerBackedExecutionTier(rec.execution_tier) ||
      rec.status !== "provisioning" ||
      !rec.sandbox_id
    ) {
      return "gone";
    }
    if (rec.claimed_at && rec.warm_claim_credential_state !== "ready") {
      await this.recoverPendingWarmClaimInferenceKey(agentId, orgId);
      return "recovered";
    }

    // Provider health is read-only, but it still must not be dialled for a row
    // that became container-free after the first snapshot. This primary read
    // is deliberately adjacent to the probe; the final state mutation remains
    // a tier-qualified lifecycle CAS. Cross-system atomicity would require a
    // durable probe lease and is outside this bounded service/CAS fix.
    const probeSource = await this.getAgentForWrite(agentId, orgId);
    if (
      !probeSource ||
      !isContainerBackedExecutionTier(probeSource.execution_tier) ||
      !probeSource.sandbox_id ||
      probeSource.status !== rec.status ||
      probeSource.sandbox_id !== rec.sandbox_id ||
      probeSource.node_id !== rec.node_id ||
      probeSource.container_name !== rec.container_name ||
      probeSource.environment_revision !== rec.environment_revision ||
      probeSource.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return "gone";
    }
    rec = probeSource;

    const provider = await this.getProvider();
    const handle: SandboxHandle = {
      sandboxId: probeSource.sandbox_id,
      bridgeUrl: rec.bridge_url ?? "",
      healthUrl: rec.health_url ?? "",
      metadata: rec.headscale_ip ? { headscaleIp: rec.headscale_ip } : undefined,
    };

    let healthy = false;
    try {
      healthy = provider.checkHealthDetailed
        ? (await provider.checkHealthDetailed(handle)).ready
        : await provider.checkHealth(handle);
    } catch (error) {
      // A probe that throws is "no signal" — leave the row for the next pass,
      // never condemn or resurrect on an errored probe.
      logger.debug("[agent-sandbox] Stuck-provisioning re-probe threw; leaving row", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unresolved";
    }

    if (!healthy) return "unresolved";

    // Guarded CAS: only flip if still `provisioning` with a live container and
    // no active provision job racing it (see markRunningFromProvisioning).
    const flipped = await agentSandboxesRepository.markRunningFromProvisioning(rec);
    if (!flipped) return "gone";
    logger.info(
      "[agent-sandbox] Reconciled wedged provisioning row to running (container re-probed healthy)",
      { agentId },
    );
    return "recovered";
  }
  shutdown(...args: Parameters<SandboxPower["shutdown"]>): ReturnType<SandboxPower["shutdown"]> {
    return this.#power.shutdown(...args);
  }
  private prepareSuspendBackupGate(
    ...args: Parameters<SandboxPower["prepareSuspendBackupGate"]>
  ): ReturnType<SandboxPower["prepareSuspendBackupGate"]> {
    return this.#power.prepareSuspendBackupGate(...args);
  }
  executeSuspend(
    ...args: Parameters<SandboxPower["executeSuspend"]>
  ): ReturnType<SandboxPower["executeSuspend"]> {
    return this.#power.executeSuspend(...args);
  }
  private isAwaitingDeletion(
    ...args: Parameters<SandboxLifecycleAuthority["isAwaitingDeletion"]>
  ): ReturnType<SandboxLifecycleAuthority["isAwaitingDeletion"]> {
    return this.lifecycleAuthority.isAwaitingDeletion(...args);
  }
  executeResume(
    ...args: Parameters<SandboxPower["executeResume"]>
  ): ReturnType<SandboxPower["executeResume"]> {
    return this.#power.executeResume(...args);
  }
  executeSleep(
    ...args: Parameters<SandboxPower["executeSleep"]>
  ): ReturnType<SandboxPower["executeSleep"]> {
    return this.#power.executeSleep(...args);
  }
  executeWake(
    ...args: Parameters<SandboxPower["executeWake"]>
  ): ReturnType<SandboxPower["executeWake"]> {
    return this.#power.executeWake(...args);
  }
  executeRestart(
    ...args: Parameters<SandboxPower["executeRestart"]>
  ): ReturnType<SandboxPower["executeRestart"]> {
    return this.#power.executeRestart(...args);
  }
  executeUpgrade(
    ...args: Parameters<SandboxImageSwap["executeUpgrade"]>
  ): ReturnType<SandboxImageSwap["executeUpgrade"]> {
    return this.#imageSwap.executeUpgrade(...args);
  }
  executeAdminCanaryUpgrade(
    ...args: Parameters<SandboxImageSwap["executeAdminCanaryUpgrade"]>
  ): ReturnType<SandboxImageSwap["executeAdminCanaryUpgrade"]> {
    return this.#imageSwap.executeAdminCanaryUpgrade(...args);
  }
  private executeUpgradeWithPolicy(
    ...args: Parameters<SandboxImageSwap["executeUpgradeWithPolicy"]>
  ): ReturnType<SandboxImageSwap["executeUpgradeWithPolicy"]> {
    return this.#imageSwap.executeUpgradeWithPolicy(...args);
  }
  executeDowngrade(
    ...args: Parameters<SandboxImageSwap["executeDowngrade"]>
  ): ReturnType<SandboxImageSwap["executeDowngrade"]> {
    return this.#imageSwap.executeDowngrade(...args);
  }
  executeAdminCanaryRollback(
    ...args: Parameters<SandboxImageSwap["executeAdminCanaryRollback"]>
  ): ReturnType<SandboxImageSwap["executeAdminCanaryRollback"]> {
    return this.#imageSwap.executeAdminCanaryRollback(...args);
  }
  private executeDowngradeWithPolicy(
    ...args: Parameters<SandboxImageSwap["executeDowngradeWithPolicy"]>
  ): ReturnType<SandboxImageSwap["executeDowngradeWithPolicy"]> {
    return this.#imageSwap.executeDowngradeWithPolicy(...args);
  }

  /**
   * Daemon-side handler for the `agent_logs` job. SSH `docker logs
   * --tail N <container>` on the assigned core via the provider. The
   * daemon path works for stopped/crashed agents (the legacy Worker
   * path hits the bridge HTTP `/logs` endpoint which is gone when the
   * agent isn't running).
   */
  async executeLogs(
    agentId: string,
    orgId: string,
    tail: number,
  ): Promise<{
    success: boolean;
    status: string;
    logs?: string;
    message?: string;
    error?: string;
  }> {
    let rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!rec) {
      return { success: false, status: "missing", error: "Agent not found" };
    }
    const tierRejection = containerBackedServiceRejection(rec, "logs");
    if (tierRejection) {
      return { success: false, status: rec.status, error: tierRejection };
    }
    if (!rec.sandbox_id) {
      return {
        success: true,
        status: rec.status,
        message: `Agent is ${rec.status} — no container assigned yet.`,
      };
    }

    const provider = await this.getProvider();
    if (typeof provider.fetchLogs !== "function") {
      return {
        success: true,
        status: rec.status,
        message: "Logs unavailable: sandbox provider does not implement fetchLogs.",
      };
    }

    // Logs are a provider read, not a durable mutation. Re-read from primary
    // immediately before that read so a stale canonical snapshot cannot dial a
    // forged Shared/unknown row. A final SQL CAS is inapplicable because this
    // operation intentionally writes no state.
    const logSource = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (
      !logSource ||
      !isContainerBackedExecutionTier(logSource.execution_tier) ||
      !logSource.sandbox_id ||
      logSource.status !== rec.status ||
      logSource.sandbox_id !== rec.sandbox_id ||
      logSource.node_id !== rec.node_id ||
      logSource.container_name !== rec.container_name ||
      logSource.environment_revision !== rec.environment_revision ||
      logSource.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        status: logSource?.status ?? "missing",
        error: logSource
          ? containerBackedServiceRejection(logSource, "logs") ||
            "Agent lifecycle changed before logs were fetched"
          : "Agent not found",
      };
    }
    rec = logSource;

    try {
      const logs = await provider.fetchLogs(logSource.sandbox_id, tail);
      return { success: true, status: rec.status, logs };
    } catch (e) {
      return {
        success: false,
        status: rec.status,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Daemon-side handler for the `agent_snapshot` job. Same operation
   * as the Worker-side `snapshot()` path, but invoked from the daemon
   * so outbound traffic to the agent bridge uses the same network
   * identity as every other cores-bound call. Returns the
   * `agent_sandbox_backups` row that was persisted.
   */
  async executeSnapshot(
    agentId: string,
    orgId: string,
    snapshotType: "manual" | "auto" = "manual",
  ): Promise<SnapshotResult> {
    return await this.snapshot(agentId, orgId, snapshotType);
  }
  private replacementCleanupCallbacks(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupCallbacks"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupCallbacks"]> {
    return this.#replacementCleanup.replacementCleanupCallbacks(...args);
  }
  private getReplacementCleanupLocator(
    ...args: Parameters<SandboxReplacementCleanup["getReplacementCleanupLocator"]>
  ): ReturnType<SandboxReplacementCleanup["getReplacementCleanupLocator"]> {
    return this.#replacementCleanup.getReplacementCleanupLocator(...args);
  }
  private parseReplacementVpnStartedAt(
    ...args: Parameters<SandboxReplacementCleanup["parseReplacementVpnStartedAt"]>
  ): ReturnType<SandboxReplacementCleanup["parseReplacementVpnStartedAt"]> {
    return this.#replacementCleanup.parseReplacementVpnStartedAt(...args);
  }
  private parseReplacementCreatedAt(
    ...args: Parameters<SandboxReplacementCleanup["parseReplacementCreatedAt"]>
  ): ReturnType<SandboxReplacementCleanup["parseReplacementCreatedAt"]> {
    return this.#replacementCleanup.parseReplacementCreatedAt(...args);
  }
  private replacementCleanupCreatedAtMatches(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupCreatedAtMatches"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupCreatedAtMatches"]> {
    return this.#replacementCleanup.replacementCleanupCreatedAtMatches(...args);
  }
  private replacementLocatorFromHandle(
    ...args: Parameters<SandboxReplacementCleanup["replacementLocatorFromHandle"]>
  ): ReturnType<SandboxReplacementCleanup["replacementLocatorFromHandle"]> {
    return this.#replacementCleanup.replacementLocatorFromHandle(...args);
  }
  private replacementLocatorFromCleanupError(
    ...args: Parameters<SandboxReplacementCleanup["replacementLocatorFromCleanupError"]>
  ): ReturnType<SandboxReplacementCleanup["replacementLocatorFromCleanupError"]> {
    return this.#replacementCleanup.replacementLocatorFromCleanupError(...args);
  }
  private assertSameReplacementIdentity(
    ...args: Parameters<SandboxReplacementCleanup["assertSameReplacementIdentity"]>
  ): ReturnType<SandboxReplacementCleanup["assertSameReplacementIdentity"]> {
    return this.#replacementCleanup.assertSameReplacementIdentity(...args);
  }
  private replacementCleanupMatchesHandle(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupMatchesHandle"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupMatchesHandle"]> {
    return this.#replacementCleanup.replacementCleanupMatchesHandle(...args);
  }
  private replacementCleanupLocatorsEqual(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupLocatorsEqual"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupLocatorsEqual"]> {
    return this.#replacementCleanup.replacementCleanupLocatorsEqual(...args);
  }
  private persistReplacementCleanupStage(
    ...args: Parameters<SandboxReplacementCleanup["persistReplacementCleanupStage"]>
  ): ReturnType<SandboxReplacementCleanup["persistReplacementCleanupStage"]> {
    return this.#replacementCleanup.persistReplacementCleanupStage(...args);
  }
  private persistUnresolvedReplacementCleanupFence(
    ...args: Parameters<SandboxReplacementCleanup["persistUnresolvedReplacementCleanupFence"]>
  ): ReturnType<SandboxReplacementCleanup["persistUnresolvedReplacementCleanupFence"]> {
    return this.#replacementCleanup.persistUnresolvedReplacementCleanupFence(...args);
  }
  private transferReplacementToPrimary(
    ...args: Parameters<SandboxReplacementCleanup["transferReplacementToPrimary"]>
  ): ReturnType<SandboxReplacementCleanup["transferReplacementToPrimary"]> {
    return this.#replacementCleanup.transferReplacementToPrimary(...args);
  }
  private assertAdminCanaryCleanupExpectation(
    ...args: Parameters<SandboxReplacementCleanup["assertAdminCanaryCleanupExpectation"]>
  ): ReturnType<SandboxReplacementCleanup["assertAdminCanaryCleanupExpectation"]> {
    return this.#replacementCleanup.assertAdminCanaryCleanupExpectation(...args);
  }
  private retirePersistedReplacementCleanup(
    ...args: Parameters<SandboxReplacementCleanup["retirePersistedReplacementCleanup"]>
  ): ReturnType<SandboxReplacementCleanup["retirePersistedReplacementCleanup"]> {
    return this.#replacementCleanup.retirePersistedReplacementCleanup(...args);
  }
  reconcileReplacementCleanupFences(
    ...args: Parameters<SandboxReplacementCleanup["reconcileReplacementCleanupFences"]>
  ): ReturnType<SandboxReplacementCleanup["reconcileReplacementCleanupFences"]> {
    return this.#replacementCleanup.reconcileReplacementCleanupFences(...args);
  }
  convergeReplacementCleanupFence(
    ...args: Parameters<SandboxReplacementCleanup["convergeReplacementCleanupFence"]>
  ): ReturnType<SandboxReplacementCleanup["convergeReplacementCleanupFence"]> {
    return this.#replacementCleanup.convergeReplacementCleanupFence(...args);
  }
  private lockLifecycle(
    ...args: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>
  ): ReturnType<SandboxLifecycleAuthority["lockLifecycle"]> {
    return this.lifecycleAuthority.lockLifecycle(...args);
  }
  private revalidateContainerBackedLifecycleGeneration(
    ...args: Parameters<SandboxLifecycleAuthority["revalidateContainerBackedLifecycleGeneration"]>
  ): ReturnType<SandboxLifecycleAuthority["revalidateContainerBackedLifecycleGeneration"]> {
    return this.lifecycleAuthority.revalidateContainerBackedLifecycleGeneration(...args);
  }
  private isReplacementCleanupSweepEligibleTx(
    ...args: Parameters<SandboxLifecycleAuthority["isReplacementCleanupSweepEligibleTx"]>
  ): ReturnType<SandboxLifecycleAuthority["isReplacementCleanupSweepEligibleTx"]> {
    return this.lifecycleAuthority.isReplacementCleanupSweepEligibleTx(...args);
  }
  private hasActiveExclusiveLifecycleJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveExclusiveLifecycleJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveExclusiveLifecycleJobTx"]> {
    return this.lifecycleAuthority.hasActiveExclusiveLifecycleJobTx(...args);
  }
  private getAgentForLifecycleMutation(
    ...args: Parameters<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>
  ): ReturnType<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]> {
    return this.lifecycleAuthority.getAgentForLifecycleMutation(...args);
  }
  private hasActiveProvisionJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveProvisionJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveProvisionJobTx"]> {
    return this.lifecycleAuthority.hasActiveProvisionJobTx(...args);
  }
  private hasActiveReplacementJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveReplacementJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveReplacementJobTx"]> {
    return this.lifecycleAuthority.hasActiveReplacementJobTx(...args);
  }
  private fetchSnapshotState(
    ...args: Parameters<SandboxBackup["fetchSnapshotState"]>
  ): ReturnType<SandboxBackup["fetchSnapshotState"]> {
    return this.#backup.fetchSnapshotState(...args);
  }
  private persistAuthorizedSnapshotWithinTransaction(
    ...args: Parameters<SandboxBackup["persistAuthorizedSnapshotWithinTransaction"]>
  ): ReturnType<SandboxBackup["persistAuthorizedSnapshotWithinTransaction"]> {
    return this.#backup.persistAuthorizedSnapshotWithinTransaction(...args);
  }
  private persistSnapshotWithinTransaction(
    ...args: Parameters<SandboxBackup["persistSnapshotWithinTransaction"]>
  ): ReturnType<SandboxBackup["persistSnapshotWithinTransaction"]> {
    return this.#backup.persistSnapshotWithinTransaction(...args);
  }
  private degradeUnrecoverableSnapshot(
    ...args: Parameters<SandboxProvision["degradeUnrecoverableSnapshot"]>
  ): ReturnType<SandboxProvision["degradeUnrecoverableSnapshot"]> {
    return this.#provision.degradeUnrecoverableSnapshot(...args);
  }
  private markError(
    ...args: Parameters<SandboxProvision["markError"]>
  ): ReturnType<SandboxProvision["markError"]> {
    return this.#provision.markError(...args);
  }
  private buildProvisioningRetryHandle(
    ...args: Parameters<SandboxProvision["buildProvisioningRetryHandle"]>
  ): ReturnType<SandboxProvision["buildProvisioningRetryHandle"]> {
    return this.#provision.buildProvisioningRetryHandle(...args);
  }
  private persistContainerHandleForRetry(
    ...args: Parameters<SandboxProvision["persistContainerHandleForRetry"]>
  ): ReturnType<SandboxProvision["persistContainerHandleForRetry"]> {
    return this.#provision.persistContainerHandleForRetry(...args);
  }
  private provisionAgentDatabase(
    ...args: Parameters<SandboxProvision["provisionAgentDatabase"]>
  ): ReturnType<SandboxProvision["provisionAgentDatabase"]> {
    return this.#provision.provisionAgentDatabase(...args);
  }

  private isIgnorableSandboxStopError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes("not found") ||
      normalized.includes("already gone") ||
      normalized.includes("no longer exists") ||
      normalized.includes("404") ||
      // docker-sandbox-provider's hydrateContainerFromDb throws this when the
      // sandbox row points at a node purged from docker_nodes (decommissioned
      // node). For stop/delete teardown the container's host no longer exists,
      // so there is nothing left to stop — without this the delete escalates,
      // exhausts retries, and wedges the agent in deletion_failed forever.
      normalized.includes("missing persisted docker node metadata")
    );
  }
  private pushState(
    ...args: Parameters<SandboxBackup["pushState"]>
  ): ReturnType<SandboxBackup["pushState"]> {
    return this.#backup.pushState(...args);
  }
}

export const elizaSandboxService = new ElizaSandboxService();
