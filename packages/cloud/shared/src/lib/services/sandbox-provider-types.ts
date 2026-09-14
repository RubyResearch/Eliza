/** Coordinates cloud service sandbox provider contracts behind route handlers. */

import { ElizaError } from "@elizaos/core";
import {
  type AgentExecutionTier,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";

export type ContainerBackedExecutionTier = (typeof CONTAINER_BACKED_EXECUTION_TIERS)[number];

/** Narrows unknown row authority to an explicitly container-backed tier. */
export function isContainerBackedExecutionTier(
  executionTier: unknown,
): executionTier is ContainerBackedExecutionTier {
  return CONTAINER_BACKED_EXECUTION_TIERS.some((tier) => tier === executionTier);
}

/** Rejects any tier that is not explicitly admitted to own a container. */
export function assertContainerBackedExecutionTier(
  executionTier: unknown,
): asserts executionTier is ContainerBackedExecutionTier {
  if (!isContainerBackedExecutionTier(executionTier)) {
    throw new ElizaError("Sandbox creation requires an explicit container-backed execution tier", {
      code: "SANDBOX_CREATE_EXECUTION_TIER_NOT_CONTAINER_BACKED",
      context: {
        executionTier: typeof executionTier === "string" ? executionTier : null,
        executionTierType: executionTier === null ? "null" : typeof executionTier,
      },
      severity: "fatal",
    });
  }
}

/**
 * Why a readiness probe finished the way it did.
 *
 *   - `ready` — the probe reached the container and it answered healthy.
 *   - `not_ready` — the probe REACHED the container (SSH transport worked and
 *     the remote shell ran) but it was still not answering healthy when the
 *     budget ran out. A genuine "the container isn't up" verdict.
 *   - `transport_unresolved` — the budget was exhausted while EVERY probe
 *     attempt failed at the SSH transport layer (connect/exec/stream error or
 *     command timeout). The probe never reached a verdict about the container,
 *     so concluding "not ready" here would be a FALSE NEGATIVE — the exact
 *     split-brain that marks a healthy container failed and wedges its row.
 *     Callers should treat this as RETRYABLE, not terminal.
 *   - `ingress_unresolved` — the node-side probe proved the container healthy,
 *     but the managed tailnet ingress that runtime bootstrap and user traffic
 *     require did not answer. The workload must be preserved for retry and
 *     route reconciliation, but it is not ready for users yet.
 */
export type SandboxHealthVerdict =
  | "ready"
  | "not_ready"
  | "transport_unresolved"
  | "ingress_unresolved";

/** Candidate probes retain pre-cutover placement; canonical probes follow committed placement. */
export type SandboxHealthContext = { kind: "candidate" } | { kind: "canonical" };

export interface SandboxHealthOutcome {
  ready: boolean;
  verdict: SandboxHealthVerdict;
}

/**
 * Evidence produced by the provider-specific teardown used for agent deletion.
 * A successful stop is sufficient even when removal fails because stopped
 * containers do not consume compute slots. Unreachable workloads retain their
 * capacity until reconciliation proves they are no longer running.
 */
export type SandboxDeletionStopOutcome =
  | { kind: "not-running-proven" }
  | { kind: "not-running-unresolved"; reason: "node-unreachable" };

/**
 * Exact container placement captured by the lifecycle transaction before a
 * destructive delete leaves its database ownership boundary. SSH authority
 * may be carried by an exact caller or hydrated from the captured node ID.
 */
export interface SandboxDeletionLocator {
  sandboxId: string;
  agentId: string;
  nodeId: string;
  containerName: string;
  hostname?: string;
  sshPort?: number;
  sshUser?: string;
  hostKeyFingerprint?: string;
}

export interface SandboxReplacementCleanupLocator {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  /** Immutable docker_nodes primary key for exact-placement recovery. */
  nodeRecordId?: string | null;
  /** Immutable Linux-boot occurrence bound to the reserved restore target. */
  nodeIncarnation?: string | null;
  /** Trigger-owned history row for that exact node occurrence. */
  nodeHistoryId?: string | null;
  /** SSH authority frozen with nodeRecordId before candidate effects. */
  nodeHostname?: string | null;
  nodeSshPort?: number | null;
  nodeSshUser?: string | null;
  nodeHostKeyFingerprint?: string | null;
  /** Attempt-scoped remote secret cleanup protocol understood by this locator. */
  replacementSecretCleanupVersion?: 1 | null;
  replacementAttemptId?: string | null;
  /** Restore generation that derived an attempt-scoped quarantine container. */
  restoreAttemptId?: string | null;
  containerId?: string | null;
  vpnNodeId?: string | null;
  vpnNodeName?: string | null;
  previousVpnNodeId?: string | null;
  vpnRegistrationStartedAt?: string | null;
  allocationCounted?: boolean | null;
}

/** Proven-success outcome of one exact-success replacement invocation. */
export interface SandboxReplacementCreateSettlement {
  readonly replacementAttemptId: string;
  readonly outcome: "succeeded";
}

/** Durable pre-effect marker for one exact replacement-provider invocation. */
export interface SandboxReplacementCreateAttemptStarted {
  readonly replacementAttemptId: string;
}

const CANONICAL_REPLACEMENT_ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validates the caller-owned token before provider placement can have effects. */
export function assertSandboxReplacementAttemptId(
  replacementAttemptId: unknown,
): asserts replacementAttemptId is string {
  if (
    typeof replacementAttemptId !== "string" ||
    !CANONICAL_REPLACEMENT_ATTEMPT_ID.test(replacementAttemptId)
  ) {
    throw new ElizaError("Sandbox replacement attempt ID must be a canonical lowercase UUID", {
      code: "SANDBOX_REPLACEMENT_ATTEMPT_ID_INVALID",
      context: {
        replacementAttemptId:
          typeof replacementAttemptId === "string" ? replacementAttemptId : null,
        replacementAttemptIdType:
          replacementAttemptId === null ? "null" : typeof replacementAttemptId,
      },
      severity: "fatal",
    });
  }
}

/**
 * Carries the exact placement that must remain fenced when a replacement
 * candidate cannot be proven absent. Callers persist this locator before
 * retrying so an unreachable node can never produce two live agent runtimes.
 */
export class SandboxReplacementCleanupUnresolvedError extends ElizaError {
  override readonly name: string = "SandboxReplacementCleanupUnresolvedError";
  readonly sandboxId: string;
  readonly nodeId: string;
  readonly containerName: string;
  readonly nodeRecordId: string | null;
  readonly nodeIncarnation: string | null;
  readonly nodeHistoryId: string | null;
  readonly nodeHostname: string | null;
  readonly nodeSshPort: number | null;
  readonly nodeSshUser: string | null;
  readonly nodeHostKeyFingerprint: string | null;
  readonly replacementSecretCleanupVersion: 1 | null;
  readonly replacementAttemptId: string | null;
  readonly restoreAttemptId: string | null;
  readonly containerId: string | null;
  readonly vpnNodeId: string | null;
  readonly vpnNodeName: string | null;
  readonly previousVpnNodeId: string | null;
  readonly vpnRegistrationStartedAt: string | null;
  readonly allocationCounted: boolean | null;

  constructor(
    locator: SandboxReplacementCleanupLocator,
    cause: unknown,
    code = "SANDBOX_REPLACEMENT_CLEANUP_UNRESOLVED",
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Replacement cleanup is unresolved for ${locator.containerName} on ${locator.nodeId}: ${causeMessage}`,
      {
        code,
        context: {
          sandboxId: locator.sandboxId,
          nodeId: locator.nodeId,
          containerName: locator.containerName,
          nodeRecordId: locator.nodeRecordId ?? null,
          nodeIncarnation: locator.nodeIncarnation ?? null,
          nodeHistoryId: locator.nodeHistoryId ?? null,
          replacementAttemptId: locator.replacementAttemptId ?? null,
          restoreAttemptId: locator.restoreAttemptId ?? null,
          containerId: locator.containerId ?? null,
          vpnNodeId: locator.vpnNodeId ?? null,
        },
        cause,
        severity: "fatal",
      },
    );
    this.sandboxId = locator.sandboxId;
    this.nodeId = locator.nodeId;
    this.containerName = locator.containerName;
    this.nodeRecordId = locator.nodeRecordId ?? null;
    this.nodeIncarnation = locator.nodeIncarnation ?? null;
    this.nodeHistoryId = locator.nodeHistoryId ?? null;
    this.nodeHostname = locator.nodeHostname ?? null;
    this.nodeSshPort = locator.nodeSshPort ?? null;
    this.nodeSshUser = locator.nodeSshUser ?? null;
    this.nodeHostKeyFingerprint = locator.nodeHostKeyFingerprint ?? null;
    this.replacementSecretCleanupVersion = locator.replacementSecretCleanupVersion ?? null;
    this.replacementAttemptId = locator.replacementAttemptId ?? null;
    this.restoreAttemptId = locator.restoreAttemptId ?? null;
    this.containerId = locator.containerId ?? null;
    this.vpnNodeId = locator.vpnNodeId ?? null;
    this.vpnNodeName = locator.vpnNodeName ?? null;
    this.previousVpnNodeId = locator.previousVpnNodeId ?? null;
    this.vpnRegistrationStartedAt = locator.vpnRegistrationStartedAt ?? null;
    this.allocationCounted = locator.allocationCounted ?? null;
  }
}

/**
 * A success-settlement persistence failure after the provider returned its
 * exact handle. It deliberately remains an unresolved-cleanup error so callers
 * retain the successful candidate and its durable locator for reconciliation.
 */
export class SandboxReplacementCreateSettlementCleanupUnresolvedError extends SandboxReplacementCleanupUnresolvedError {
  override readonly name = "SandboxReplacementCreateSettlementCleanupUnresolvedError";
  readonly settlement: SandboxReplacementCreateSettlement;
  readonly providerHandle: SandboxHandle;
  readonly persistenceError: unknown;

  constructor(options: {
    settlement: SandboxReplacementCreateSettlement;
    locator: SandboxReplacementCleanupLocator;
    providerHandle: SandboxHandle;
    persistenceError: unknown;
  }) {
    super(
      options.locator,
      options.persistenceError,
      "SANDBOX_REPLACEMENT_CREATE_SETTLEMENT_PERSIST_FAILED",
    );
    this.settlement = options.settlement;
    this.providerHandle = options.providerHandle;
    this.persistenceError = options.persistenceError;
  }
}

export interface SandboxProvider {
  /** Remote paid compute supports a caller-owned, committed-funding start instead of raw Docker start. */
  readonly computeFundingCapability?: "host-lease-v1";
  /**
   * Declares support for caller-owned replacement identity, a pre-effect start
   * marker, and an exact success-only completion signal. Callers must check
   * strictly for `"exact-success"` before effects; `undefined` means
   * unsupported.
   */
  readonly replacementCreateSettlementCapability?: "exact-success";
  /**
   * Declares support for an exact, already-reserved restore target whose
   * container is created stopped and unroutable. Callers must check this exact
   * value before supplying {@link SandboxExactRestoreCreateConfig}.
   */
  readonly exactRestoreCreateCapability?: "stopped-quarantine-v1";
  create(config: SandboxCreateConfig): Promise<SandboxHandle>;
  /**
   * Tears down a sandbox for deletion and reports whether the provider proved
   * the workload is not running. The deletion workflow owns capacity release,
   * so an unresolved outcome completes deletion without authorizing release.
   */
  stopForDeletion(
    sandboxId: string,
    locator?: SandboxDeletionLocator,
  ): Promise<SandboxDeletionStopOutcome>;
  /**
   * Retires a sandbox before a replacement is allowed to start. Unlike the
   * ordinary delete-oriented stop path, this must reject whenever the provider
   * cannot prove the old workload is no longer running; abandoning an
   * unreachable container would create two live agents after the node returns.
   */
  stopForReplacement?(
    sandboxId: string,
    /** A lifecycle caller that transactionally recounts capacity owns its release. */
    options?: { readonly releaseCapacity?: false },
  ): Promise<void>;
  /**
   * Reclaims a replacement candidate from its durable placement record. This
   * bypasses sandbox-id lookup because the routed agent row may still point at
   * the old blue/green leg while the candidate cleanup fence points elsewhere.
   * Exact-success consumers must persist and replay the complete nodeRecordId +
   * SSH-authority tuple and secret-cleanup version from their callback handle.
   * A logical nodeId alone is a legacy locator and cannot protect a future
   * caller from node-record ABA or prove attempt-scoped secret artifacts absent.
   * If Docker never returned a containerId, name absence alone stays unresolved
   * because a submitted daemon create can materialize after its SSH client has
   * disconnected. Exact cleanup may settle only when the remote producer is
   * durably quiescent or after observing and recording the exact labeled
   * candidate ID before removing it.
   */
  stopOnSpecificNodeForReplacement?(
    nodeId: string,
    containerName: string,
    vpnNodeId?: string | null,
    identity?: Omit<
      SandboxReplacementCleanupLocator,
      "sandboxId" | "nodeId" | "containerName" | "vpnNodeId"
    >,
  ): Promise<void>;
  checkHealth(handle: SandboxHandle, context?: SandboxHealthContext): Promise<boolean>;
  /**
   * Richer readiness probe that distinguishes a genuine `not_ready` from a
   * unresolved transport/managed-ingress exhaustion (see
   * {@link SandboxHealthVerdict}).
   * Optional so providers that cannot fail at a transport layer (memory/local)
   * need not implement it; callers fall back to `checkHealth` when absent.
   */
  checkHealthDetailed?(
    handle: SandboxHandle,
    context?: SandboxHealthContext,
  ): Promise<SandboxHealthOutcome>;
  runCommand?(sandboxId: string, cmd: string, args?: string[]): Promise<string>;
  /** Tail container logs from the sandbox runtime (e.g. `docker logs --tail N`). */
  fetchLogs?(sandboxId: string, tail: number): Promise<string>;
}

export interface SandboxHandle {
  sandboxId: string;
  bridgeUrl: string;
  healthUrl: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxContainerLaunchConfig {
  projectName?: string;
  port?: number;
  /** ECS-style CPU units; 1024 units equal one vCPU. */
  cpu?: number;
  memoryMb?: number;
  desiredCount?: number;
  architecture?: "arm64" | "x86_64";
  healthCheckPath?: string;
}

/** Caller-owned placement authority for one already-reserved node occurrence. */
export interface SandboxExactRestoreTarget {
  readonly nodeRecordId: string;
  readonly nodeId: string;
  readonly nodeIncarnation: string;
  readonly nodeHistoryId: string;
  /** Canonical runtime platform attested for this node occurrence. */
  readonly platform: "linux/amd64" | "linux/arm64";
}

/**
 * Disabled-first Docker materialization authority for one restore attempt.
 *
 * `imageReference` is the registry-qualified `name@sha256:...` generation
 * reference and must carry the same digest as `imageDigest`.
 * `imagePlatformDigest` is the registry-verified child manifest selected for
 * `target.platform`. The provider pulls and creates from that child digest,
 * never from a tag or an implicitly selected manifest-list child. The provider
 * derives both the container name and staging volume from
 * `agentId + restoreAttemptId`.
 */
export interface SandboxExactRestoreCreateConfig {
  readonly restoreAttemptId: string;
  readonly target: SandboxExactRestoreTarget;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly imagePlatformDigest: string;
  readonly quarantine: true;
}

export interface SandboxCreateConfig {
  agentId: string;
  agentName: string;
  organizationId: string;
  /** Durable placement authority read from the target agent row. */
  executionTier: AgentExecutionTier;
  environmentVars: Record<string, string>;
  /**
   * Full character config for this agent (the `agent_sandboxes.agent_config`
   * row). When present, the provider injects it as ELIZA_AGENT_CHARACTER_JSON
   * so the container boots AS this character instead of the bundled default
   * preset. See packages/agent/src/runtime/sandbox-character.ts.
   */
  agentConfig?: Record<string, unknown> | null;
  /**
   * The platform character_id used by the gateways to route inbound messages
   * (`agent:<id>:server` / `/agents/<id>/message`). Injected as
   * SANDBOX_ROUTE_AGENT_ID so the container registers under, and answers as,
   * this id (NOT the sandbox id). When absent the runtime keeps its prior
   * name-derived agent id and the sandbox falls back to keying the registry
   * by SANDBOX_AGENT_ID.
   */
  routeAgentId?: string | null;
  snapshotId?: string;
  resources?: { vcpus?: number; memoryMb?: number };
  timeout?: number;
  dockerImage?: string;
  container?: SandboxContainerLaunchConfig;
  /**
   * Opts into exact stopped restore materialization. Absence preserves the
   * existing discovery, autoscale, image-resolution, and startup behavior.
   */
  exactRestore?: SandboxExactRestoreCreateConfig;
  /**
   * When set, the provider will not place the new sandbox on this Docker node.
   * Used for retry-on-failure to avoid re-selecting a node that just failed.
   */
  excludeNodeId?: string;
  /**
   * When false, an existing Headscale node under the agent's deterministic
   * hostname is preserved and recorded instead of deleted pre-provision
   * (#16565). Blue/green upgrade/downgrade set this: the "stale" node is the
   * LIVE serving one until the atomic swap commits. The orchestrator deletes
   * it by the recorded id (`metadata.previousVpnNodeId`) after cutover;
   * rolled-back paths leave it untouched. Default true (plain reprovision
   * keeps today's reclaim).
   */
  reclaimStaleVpnNode?: boolean;
  /**
   * Exact caller-owned identity for this provider invocation. It must be a
   * canonical lowercase UUID. Exact-success mode requires the caller to supply
   * it; providers generate one only for legacy non-exact callers that omit it.
   * It is one-shot: cleanup durably tombstones the remote attempt so delayed
   * commands cannot materialize afterward. A retry after proven cleanup must
   * allocate a new UUID; replaying or overlapping the same id is forbidden.
   */
  replacementAttemptId?: string;
  /**
   * Persists the exact invocation identity before provider placement or remote
   * effects begin. This callback is paired with
   * `onReplacementCreateSettled`; neither may be supplied alone. The provider
   * calls it once per invocation. Durable consumers must reject an already
   * started or terminal id instead of replaying provider effects under it.
   */
  onReplacementCreateAttemptStarted?: (
    attempt: SandboxReplacementCreateAttemptStarted,
  ) => Promise<void>;
  /**
   * Atomically reserves node capacity and persists the exact replacement
   * attempt before the remote Docker create can commit. The attempt token and
   * deterministic container name let recovery find the candidate even when the
   * SSH response carrying Docker's container id is lost.
   */
  onReplacementCreateIntent?: (handle: SandboxHandle) => Promise<void>;
  /** CAS-enriches a persisted intent with Docker's exact container id. */
  onReplacementCreated?: (handle: SandboxHandle) => Promise<void>;
  /**
   * Starts the exact created container only after its funding binding commits.
   * Called after host configuration is prepared. A rejection must never fall
   * through to an ordinary provider start. Required for runnable remote Docker
   * customer containers, including replacements and test organizations. Local,
   * stopped exact-restore candidates and explicit pool capacity are exempt.
   */
  startFundedContainer?: (handle: SandboxHandle) => Promise<void>;
  /**
   * Enriches the durable candidate fence with the exact Headscale identity as
   * soon as registration completes. The initial placement remains authoritative
   * if this callback fails, and the provider returns its exact locator.
   */
  onReplacementVpnRegistered?: (handle: SandboxHandle) => Promise<void>;
  /**
   * Persists proven provider success exactly once, after the provider completed
   * the exact candidate's create/activation path, produced its handle and
   * cleanup locator, and observed no ambiguous mutating fallback that could
   * still materialize or change that candidate. It is never called for
   * rejection, crash, timeout, cleanup uncertainty, or an ambiguous start
   * callback.
   * Absence therefore leaves the durable attempt `in_flight_unresolved`; a
   * caller must not expire that authority from a lease or one remote inspect.
   * The consumer's final transaction must CAS that exact attempt from
   * `in_flight` and revalidate or lock the primary node authority persisted at
   * intent (`nodeRecordId` plus hostname, SSH port/user, and host-key pin), or
   * enforce equivalent foreign-key authority. The provider's own primary read
   * occurs before this callback and cannot close a node delete/route-drift
   * TOCTOU window for the consumer.
   * An external timeout only stops awaiting the invocation, so a later proven
   * success still invokes this callback. Implementations guarantee once per
   * invocation. Cleanup makes that attempt id terminal; any later provider
   * retry uses a fresh caller-owned id. Concurrent or sequential replay of one
   * attempt id is unsupported and unsafe.
   */
  onReplacementCreateSettled?: (settlement: SandboxReplacementCreateSettlement) => Promise<void>;
}
