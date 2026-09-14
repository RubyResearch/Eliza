/** Owns sandbox power operations while preserving the host’s lifecycle transactions, provider instance, and backup authority. */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import { agentBillingRepository } from "../../../../db/repositories/agent-billing";
import {
  type AgentSandbox,
  agentSandboxesRepository,
} from "../../../../db/repositories/agent-sandboxes";
import { agentComputeFunding } from "../../../../db/schemas/agent-compute-funding";
import { agentComputeStopIntents } from "../../../../db/schemas/agent-compute-stop-intents";
import {
  type AgentBackupStateData,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  WARM_POOL_ORG_ID,
} from "../../../../db/schemas/agent-sandboxes";
import { AGENT_PRICING } from "../../../constants/agent-pricing";
import { logger } from "../../../utils/logger";
import { agentComputeFundingService } from "../../agent-compute-funding";
import { settleAgentBringUpBilling } from "../../agent-compute-provision";
import { startFundedAgentInTransaction } from "../../agent-compute-start";
import { hasOpenAgentComputeFunding, stopFundedAgentInTransaction } from "../../agent-compute-stop";
import { deferFundedAgentStopInTransaction } from "../../agent-compute-stop-schedule";
import { creditsService } from "../../credits";
import { reconcileAllocatedWorkloadsOnNodeWithDatabase } from "../../docker-node-workload-queries";
import type { SandboxHandle, SandboxProvider } from "../../sandbox-provider-types";
import { isContainerBackedExecutionTier } from "../../sandbox-provider-types";
import {
  formatWakeRestoreIntegrityError,
  runWakeRestoreIntegrityGate,
  type WakeRestoreIntegrityFailure,
} from "../../wake-restore-integrity";
import { WARM_CLAIM_RECOVERY_FAILURE_PREFIX } from "../../warm-claim-key-push";
import { SnapshotAuthorityCapture, snapshotCaptureStillCanonical } from "../backup/authority.js";
import {
  MAX_BACKUPS,
  SNAPSHOT_CAPTURE_TRANSIENT,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
} from "../backup/contracts.js";
import { ProvisionRestoreOverride } from "../backup/restore-contract.js";
import { SandboxBackup } from "../backup/service.js";
import { SandboxLifecycleAuthority } from "./authority.js";
import { containerBackedServiceRejection } from "./policy.js";
import { AgentSuspendExecutionResult } from "./power-contracts.js";
import { ProvisionResult, rejectNonContainerBackedProvision } from "./provision-contracts.js";
import { SandboxReplacementCleanup } from "./replacement-cleanup.js";
import { BoundedSandboxStopResult } from "./stop-contracts.js";

export interface SandboxPowerHost {
  getProvider(): Promise<SandboxProvider>;
  getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
  fetchSnapshotState(
    ...args: Parameters<SandboxBackup["fetchSnapshotState"]>
  ): ReturnType<SandboxBackup["fetchSnapshotState"]>;
  lockLifecycle(
    ...args: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>
  ): ReturnType<SandboxLifecycleAuthority["lockLifecycle"]>;
  getAgentForLifecycleMutation(
    ...args: Parameters<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>
  ): ReturnType<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>;
  isAwaitingDeletion(
    ...args: Parameters<SandboxLifecycleAuthority["isAwaitingDeletion"]>
  ): ReturnType<SandboxLifecycleAuthority["isAwaitingDeletion"]>;
  getReplacementCleanupLocator(
    ...args: Parameters<SandboxReplacementCleanup["getReplacementCleanupLocator"]>
  ): ReturnType<SandboxReplacementCleanup["getReplacementCleanupLocator"]>;
  hasActiveProvisionJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveProvisionJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveProvisionJobTx"]>;
  persistSnapshotWithinTransaction(
    ...args: Parameters<SandboxBackup["persistSnapshotWithinTransaction"]>
  ): ReturnType<SandboxBackup["persistSnapshotWithinTransaction"]>;
  runBoundedSandboxStopForReplacement(
    sandboxId: string,
    options?: Parameters<NonNullable<SandboxProvider["stopForReplacement"]>>[1],
  ): Promise<BoundedSandboxStopResult>;
  revalidateContainerBackedLifecycleGeneration(
    ...args: Parameters<SandboxLifecycleAuthority["revalidateContainerBackedLifecycleGeneration"]>
  ): ReturnType<SandboxLifecycleAuthority["revalidateContainerBackedLifecycleGeneration"]>;
  provision(
    agentId: string,
    orgId: string,
    restoreOverride?: ProvisionRestoreOverride,
  ): Promise<ProvisionResult>;
  hasActiveReplacementJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveReplacementJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveReplacementJobTx"]>;
  prepareLegacyWarmClaimCredentialRecovery(agentId: string, organizationId: string): Promise<void>;
  recoverPendingWarmClaimInferenceKey(
    agentId: string,
    organizationId: string,
  ): Promise<{
    pushed: boolean;
    keyPrefix?: string;
  }>;
}

export class SandboxPower {
  constructor(private readonly host: SandboxPowerHost) {}

  // Shutdown

  /**
   * Stops the agent's container and flips the row to `stopped`, capturing a
   * pre-stop snapshot first. Fail-closed by default: a capture failure leaves
   * the agent running and returns an explicit refusal. The sole sanctioned
   * bypass is `options.stateLossAcknowledged` (#18228) — an operator's
   * explicit acceptance that state since the last durable backup is discarded
   * — which proceeds to stop without a capture, loudly, and reports
   * `stateLossAcknowledged: true` in the result. It is never implied.
   */
  async shutdown(
    agentId: string,
    orgId: string,
    options?: { readonly stateLossAcknowledged?: boolean },
  ): Promise<{
    success: boolean;
    error?: string;
    retryable?: boolean;
    stateLossAcknowledged?: boolean;
  }> {
    let snapshotAgentId: string | null = null;
    let captureUnsupported = false;
    let captureWaivedByOperator = false;
    let preShutdownSnapshot: {
      stateData: AgentBackupStateData;
      sizeBytes: number;
      bridgeUrl: string;
    } | null = null;
    // Exact authority for every remote capture attempt, including the two
    // explicit no-capture outcomes (unsupported image and operator waiver).
    // A response from generation A must never authorize persisting or stopping
    // a replacement generation B that happens to reuse the same bridge URL.
    let shutdownCaptureAuthority: SnapshotAuthorityCapture | null = null;

    const snapshotSource = await this.host.getAgentForWrite(agentId, orgId);
    if (snapshotSource) {
      const tierRejection = containerBackedServiceRejection(snapshotSource, "shutdown");
      if (tierRejection) return { success: false, error: tierRejection };
    }
    if (snapshotSource?.status === "running" && snapshotSource.bridge_url) {
      shutdownCaptureAuthority = snapshotSource;
      try {
        preShutdownSnapshot = await this.host.fetchSnapshotState(snapshotSource);
      } catch (error) {
        // error-policy:J1 the shutdown command boundary translates capture
        // failures into an explicit refusal while leaving the agent running.
        const message = error instanceof Error ? error.message : String(error);
        if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
          // The deployed image cannot snapshot by construction; requiring a
          // capture it can never produce would make this agent unstoppable.
          captureUnsupported = true;
          logger.warn(
            "[agent-sandbox] Shutdown proceeding without capture: image has no snapshot endpoint",
            { agentId },
          );
        } else if (options?.stateLossAcknowledged) {
          // Sanctioned operator override (#18228): a persistent capture or
          // transfer-hop failure otherwise makes the agent unstoppable through
          // every safe path. The operator explicitly acknowledged the state
          // loss, so proceed to stop WITHOUT a capture — never silently: the
          // waiver is logged here and reported in the result.
          captureWaivedByOperator = true;
          logger.error(
            "[agent-sandbox] Shutdown proceeding WITHOUT pre-stop capture: operator acknowledged state loss",
            { agentId, captureError: message },
          );
        } else if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
          // TRANSIENT (PGlite closing race): do NOT weaken the fail-closed
          // guarantee — still refuse to stop — but mark the failure RETRYABLE so
          // the restart/shutdown job re-attempts instead of treating a healthy
          // agent as permanently un-capturable. On the next attempt PGlite is no
          // longer mid-close and the capture succeeds (2026-08-11 fleet
          // incident: opaque 500 here wedged healthy agents indefinitely).
          logger.warn(
            "[agent-sandbox] Shutdown deferred: pre-stop capture transiently unavailable, will retry",
            { agentId },
          );
          return {
            success: false,
            retryable: true,
            error: `Refusing to stop without a current backup: ${message}`,
          };
        } else {
          // Fail CLOSED: stopping the container without a current capture
          // silently discards everything since the last backup. A shutdown
          // that cannot prove a capture leaves the agent running and says so.
          logger.error("[agent-sandbox] Shutdown refused: pre-stop capture failed", {
            agentId,
            error: message,
          });
          return {
            success: false,
            error: `Refusing to stop without a current backup: ${message}`,
          };
        }
      }
    }

    const prepaidProvider =
      (await this.host.getProvider()).computeFundingCapability === "host-lease-v1";
    const commitShutdownPhase = (expectedStopped?: AgentSandbox) =>
      dbWrite.transaction(async (tx) => {
        await this.host.lockLifecycle(tx, agentId, orgId);

        const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!rec) return { success: false, error: "Agent not found" } as const;
        const tierRejection = containerBackedServiceRejection(rec, "shutdown");
        if (tierRejection) return { success: false, error: tierRejection } as const;
        if (rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status)) {
          return { success: false, error: "Agent not found" } as const;
        }
        if (this.host.getReplacementCleanupLocator(rec)) {
          return { success: false, error: "Agent replacement cleanup is still pending" } as const;
        }

        if (
          (expectedStopped && !snapshotCaptureStillCanonical(rec, expectedStopped)) ||
          (snapshotSource &&
            (rec.lifecycle_job_id !== snapshotSource.lifecycle_job_id ||
              rec.lifecycle_execution_generation !== snapshotSource.lifecycle_execution_generation))
        )
          return {
            success: false,
            error: "Agent shutdown execution changed before removal",
          } as const;

        if (
          shutdownCaptureAuthority &&
          !snapshotCaptureStillCanonical(rec, shutdownCaptureAuthority)
        ) {
          return {
            success: false,
            error:
              "Refusing to stop: the agent's lifecycle generation moved after the pre-stop capture; retry the shutdown.",
          } as const;
        }

        const hasActiveProvisionJob = await this.host.hasActiveProvisionJobTx(tx, agentId, orgId);
        const recoveringWarmCredentialFence =
          rec.status === "provisioning" &&
          rec.claimed_at !== null &&
          (rec.warm_claim_credential_state === "pending" ||
            rec.warm_claim_credential_state === "attested");
        const hasCompleteWarmRecoveryLocator =
          rec.sandbox_id !== null && rec.node_id !== null && rec.container_name !== null;
        const hasNoWarmRecoveryLocator =
          rec.sandbox_id === null && rec.node_id === null && rec.container_name === null;
        if (
          recoveringWarmCredentialFence &&
          !hasCompleteWarmRecoveryLocator &&
          !hasNoWarmRecoveryLocator
        ) {
          return {
            success: false,
            error: "Warm-claim recovery locator is incomplete",
          } as const;
        }
        const recoveringWarmCredential =
          recoveringWarmCredentialFence &&
          (hasCompleteWarmRecoveryLocator || hasNoWarmRecoveryLocator);
        if ((rec.status === "provisioning" && !recoveringWarmCredential) || hasActiveProvisionJob) {
          return {
            success: false,
            error: "Agent provisioning is in progress",
          } as const;
        }

        let commitLifecycleRevision = rec.lifecycle_revision;
        if (
          rec.status === "running" &&
          rec.bridge_url &&
          !captureUnsupported &&
          !captureWaivedByOperator
        ) {
          // The exact capture authority was checked above. Keep the returned URL
          // assertion as an additional response-integrity check: a helper must
          // never return bytes attributed to a different bridge than it dialled.
          if (!preShutdownSnapshot || rec.bridge_url !== preShutdownSnapshot.bridgeUrl) {
            return {
              success: false,
              error:
                "Refusing to stop: the agent's lifecycle generation moved after the pre-stop capture; retry the shutdown.",
            } as const;
          }
          const persisted = await this.host.persistSnapshotWithinTransaction(
            tx,
            rec.id,
            rec.organization_id,
            "pre-shutdown",
            preShutdownSnapshot.stateData,
            preShutdownSnapshot.sizeBytes,
          );
          commitLifecycleRevision = persisted.lifecycleRevision;
        }

        if (prepaidProvider && (await hasOpenAgentComputeFunding(tx, agentId, orgId))) {
          if (
            rec.status === "running" &&
            !preShutdownSnapshot &&
            !captureUnsupported &&
            !captureWaivedByOperator
          )
            return {
              success: false,
              error: "Refusing paid shutdown without a current backup",
            } as const;
          const funding = await stopFundedAgentInTransaction(tx, {
            agentId,
            organizationId: orgId,
            lifecycleRevision: commitLifecycleRevision,
          });
          if (!funding) throw new Error("Shutdown lost its paid stop authority");
          const [stopped] = await tx
            .update(agentSandboxes)
            .set({ status: "stopped", updated_at: new Date() })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)))
            .returning();
          if (!stopped) throw new Error("Shutdown lost its stopped generation");
          if (rec.node_id) await reconcileAllocatedWorkloadsOnNodeWithDatabase(tx, rec.node_id);
          return { success: true, fundedRetirement: stopped, funding } as const;
        }

        if (rec.sandbox_id) {
          const stop = prepaidProvider
            ? await this.host.runBoundedSandboxStopForReplacement(rec.sandbox_id, {
                releaseCapacity: false,
              })
            : await this.host.runBoundedSandboxStopForReplacement(rec.sandbox_id);
          if (stop) {
            const error = stop.error instanceof Error ? stop.error.message : String(stop.error);
            logger.warn("[agent-sandbox] Stop failed during shutdown", {
              sandboxId: rec.sandbox_id,
              status: rec.status,
              error,
            });
            return {
              success: false,
              error: "Failed to prove the previous sandbox stopped",
            } as const;
          }
        }

        // `getAgentForLifecycleMutation()` holds this exact row FOR UPDATE through
        // the provider absence proof and write. The locked tier guard above
        // therefore makes the allowlist predicate stable; it is a final SQL
        // backstop, not an unchecked optimistic CAS that can silently lose a tier
        // race after the container has stopped.
        await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'stopped',
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          updated_at = NOW()
        WHERE id = ${rec.id}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
      `);

        if (prepaidProvider && rec.node_id)
          await reconcileAllocatedWorkloadsOnNodeWithDatabase(tx, rec.node_id);
        snapshotAgentId = rec.id;
        if (captureWaivedByOperator) {
          return { success: true, stateLossAcknowledged: true } as const;
        }
        return { success: true } as const;
      });

    let result = await commitShutdownPhase();
    if (result.success && "fundedRetirement" in result && result.fundedRetirement) {
      const stopped = result.fundedRetirement;
      shutdownCaptureAuthority = stopped;
      preShutdownSnapshot = null;
      if (result.funding.purchasedCreditRefunded)
        await creditsService.invalidateCreditCaches(orgId);
      result = await commitShutdownPhase(stopped);
      if ("fundedRetirement" in result)
        throw new Error("Shutdown paid retirement did not converge");
    }

    if (result.success && snapshotAgentId) {
      await agentSandboxesRepository.pruneBackups(snapshotAgentId, MAX_BACKUPS).catch((error) => {
        logger.warn("[agent-sandbox] Backup pruning failed after shutdown", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info("[agent-sandbox] Shutdown complete", {
        agentId,
        stateLossAcknowledged: captureWaivedByOperator || undefined,
      });
    }

    return result;
  }

  /**
   * Capture current state before a data-bearing container is removed. An older
   * verified backup proves restorability, not preservation of later writes.
   * Failed capture denies removal. Funded suspension can instead confirm a
   * stop in place, retaining the container and volume for later recovery.
   */
  async prepareSuspendBackupGate(rec: AgentSandbox): Promise<
    | { outcome: "skip" }
    | {
        outcome: "proceed";
        backupId?: string;
        capturedFresh: boolean;
        pendingSnapshot?: { stateData: AgentBackupStateData; sizeBytes: number };
      }
    | { outcome: "refuse"; error: string }
  > {
    if (
      !rec.sandbox_id ||
      !isContainerBackedExecutionTier(rec.execution_tier) ||
      (rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed")
    ) {
      return { outcome: "skip" };
    }
    if (rec.bridge_url) {
      try {
        const { stateData, sizeBytes } = await this.host.fetchSnapshotState(rec);
        // Network capture is intentionally outside the write transaction. The
        // backup row itself is inserted only after the authoritative locked
        // tier/generation revalidation in executeSuspend.
        return {
          outcome: "proceed",
          capturedFresh: true,
          pendingSnapshot: { stateData, sizeBytes },
        };
      } catch (error) {
        // error-policy:J1 the lifecycle boundary refuses destructive stop when
        // current state cannot be captured; a prior backup cannot cover new writes.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[agent-sandbox] Stop refused: current snapshot capture failed", {
          agentId: rec.id,
          error: message,
        });
        return {
          outcome: "refuse",
          error: `Refusing to stop without a current backup: ${message}`,
        };
      }
    }
    return {
      outcome: "refuse",
      error:
        "Refusing to stop without a current backup: the agent has no reachable bridge to capture from",
    };
  }

  /**
   * Daemon-side handler for `agent_suspend`. Intent-bound prepaid stops capture
   * current state and release compute through the sleep lifecycle. Low-level
   * reconciliation and intent-bound capture failures can stop in place before
   * refunding, retaining the full container without authority to remove it.
   * Legacy runtime requires a current backup before replacement stop removes it.
   */
  async executeSuspend(
    agentId: string,
    orgId: string,
    jobId: string,
    authorization: "user_request" | "billing_request" = "user_request",
    expectedLifecycleRevision?: number,
  ): Promise<AgentSuspendExecutionResult> {
    // Modern jobs carry their exact intent generation. Check it before the
    // backup gate so a lifecycle-stale queued request is a terminal no-op and
    // cannot touch either the snapshot bridge or the compute provider.
    if (expectedLifecycleRevision !== undefined) {
      const preflight = await dbWrite.transaction(async (tx) => {
        await this.host.lockLifecycle(tx, agentId, orgId);
        const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!rec || rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status)) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent not found",
          } as const;
        }
        const [intent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.agent_id, agentId),
              eq(agentComputeStopIntents.organization_id, orgId),
              eq(agentComputeStopIntents.job_id, jobId),
            ),
          )
          .for("update")
          .limit(1);
        if (!intent) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent stop intent is missing or bound to a different job",
          } as const;
        }
        if (intent.lifecycle_revision !== expectedLifecycleRevision) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent suspend job and stop intent lifecycle revisions do not match",
          } as const;
        }
        if (intent.status === "provider_confirmed") {
          return { success: true, containerStopped: true } as const;
        }
        if (intent.status === "superseded") {
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason:
              intent.last_error === "lifecycle_changed" || intent.last_error === "billing_recovered"
                ? intent.last_error
                : "stop_intent_superseded",
          } as const;
        }
        if (rec.lifecycle_revision !== intent.lifecycle_revision) {
          const supersededAt = new Date();
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "superseded",
              last_error: "lifecycle_changed",
              superseded_at: supersededAt,
              updated_at: supersededAt,
            })
            .where(eq(agentComputeStopIntents.id, intent.id));
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason: "lifecycle_changed",
          } as const;
        }
        return undefined;
      });
      if (preflight) return preflight;
    }

    // The backup is captured without holding the lifecycle lock (an HTTP
    // round-trip must not pin a write transaction); the lifecycle generation
    // is revalidated under the lock before the stop.
    let snapshotSource = await this.host.getAgentForWrite(agentId, orgId);
    if (!snapshotSource) {
      return { success: false, containerStopped: false, error: "Agent not found" };
    }
    const initialTierRejection = containerBackedServiceRejection(snapshotSource, "suspend");
    if (initialTierRejection) {
      return { success: false, containerStopped: false, error: initialTierRejection };
    }
    if (snapshotSource.deletion_attempt_id || this.host.isAwaitingDeletion(snapshotSource.status)) {
      return { success: false, containerStopped: false, error: "Agent not found" };
    }
    let suspendBackupId: string | undefined;
    let backupCapturedFresh = false;
    let pendingSuspendSnapshot: { stateData: AgentBackupStateData; sizeBytes: number } | undefined;
    const fundedSource = await dbWrite.transaction((tx) =>
      hasOpenAgentComputeFunding(tx, agentId, orgId),
    );
    if (
      expectedLifecycleRevision !== undefined &&
      (await this.host.getProvider()).computeFundingCapability === "host-lease-v1"
    ) {
      const [latest] = await dbWrite
        .select({ id: agentComputeFunding.id })
        .from(agentComputeFunding)
        .where(
          and(
            eq(agentComputeFunding.agent_id, agentId),
            eq(agentComputeFunding.organization_id, orgId),
          ),
        )
        .limit(1);
      if (latest) {
        const sleep = await this.executeSleepWithStopAuthority(agentId, orgId, {
          jobId,
          lifecycleRevision: expectedLifecycleRevision,
        });
        if (!sleep.backupCaptureUnavailable || !fundedSource) {
          return {
            success: sleep.success,
            containerStopped: sleep.containerRemoved,
            backupId: sleep.backupId,
            error: sleep.error,
            ...(sleep.skipped ? { skipped: true as const, reason: sleep.reason } : {}),
          };
        }
        // A dead snapshot endpoint cannot keep paid CPU or its hold alive.
        // The transaction below revalidates the intent and funding, then stops
        // in place. Retaining the container preserves every unbacked write.
        logger.warn("[agent-sandbox] Live backup unavailable; retaining state during paid stop", {
          agentId,
          jobId,
          error: sleep.error,
        });
      }
    }
    // Low-level prepaid reconciliation stops in place. Retaining the container and
    // volume lets expiry stop unpaid CPU even when live capture is unavailable.
    // Legacy replacement stop removes the container and still needs its backup.
    if (snapshotSource.status !== "stopped" && !fundedSource) {
      const revalidated = await this.host.revalidateContainerBackedLifecycleGeneration(
        snapshotSource,
        "suspend",
      );
      if (!revalidated) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent lifecycle changed while the suspend backup was prepared",
        };
      }
      snapshotSource = revalidated;
      const gateResult = await this.prepareSuspendBackupGate(snapshotSource);
      if (gateResult.outcome === "refuse") {
        return { success: false, containerStopped: false, error: gateResult.error };
      }
      if (gateResult.outcome === "proceed") {
        suspendBackupId = gateResult.backupId;
        pendingSuspendSnapshot = gateResult.pendingSnapshot;
      }
    }
    const result = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec)
        return {
          success: false,
          containerStopped: false,
          error: "Agent not found",
        } as const;
      const tierRejection = containerBackedServiceRejection(rec, "suspend");
      if (tierRejection) {
        return {
          success: false,
          containerStopped: false,
          error: tierRejection,
        } as const;
      }
      if (rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status)) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent not found",
        } as const;
      }
      if (this.host.getReplacementCleanupLocator(rec)) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent replacement cleanup is still pending",
        } as const;
      }

      const hasActiveProvisionJob = await this.host.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent provisioning is in progress",
        } as const;
      }
      const requiresBoundIntent =
        expectedLifecycleRevision !== undefined || authorization === "billing_request";
      const [stopIntent] = requiresBoundIntent
        ? await tx
            .select()
            .from(agentComputeStopIntents)
            .where(
              and(
                eq(agentComputeStopIntents.agent_id, agentId),
                eq(agentComputeStopIntents.organization_id, orgId),
                eq(agentComputeStopIntents.job_id, jobId),
              ),
            )
            .for("update")
            .limit(1)
        : [undefined];
      if (requiresBoundIntent && !stopIntent) {
        return {
          success: false,
          containerStopped: false,
          error:
            authorization === "billing_request"
              ? "Agent billing stop intent is missing or bound to a different job"
              : "Agent stop intent is missing or bound to a different job",
        } as const;
      }
      if (
        stopIntent &&
        expectedLifecycleRevision !== undefined &&
        stopIntent.lifecycle_revision !== expectedLifecycleRevision
      ) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent suspend job and stop intent lifecycle revisions do not match",
        } as const;
      }
      const effectiveAuthorization = stopIntent?.authorization ?? authorization;
      if (stopIntent?.status === "provider_confirmed") {
        return { success: true, containerStopped: true } as const;
      }
      if (stopIntent?.status === "superseded") {
        return {
          success: true,
          containerStopped: false,
          skipped: true,
          reason:
            stopIntent.last_error === "lifecycle_changed" ||
            stopIntent.last_error === "billing_recovered"
              ? stopIntent.last_error
              : "stop_intent_superseded",
        } as const;
      }
      if (stopIntent && stopIntent.lifecycle_revision !== rec.lifecycle_revision) {
        const supersededAt = new Date();
        await tx
          .update(agentComputeStopIntents)
          .set({
            status: "superseded",
            last_error: "lifecycle_changed",
            superseded_at: supersededAt,
            updated_at: supersededAt,
          })
          .where(eq(agentComputeStopIntents.id, stopIntent.id));
        return {
          success: true,
          containerStopped: false,
          skipped: true,
          reason: "lifecycle_changed",
        } as const;
      }
      if ((await hasOpenAgentComputeFunding(tx, agentId, orgId)) !== fundedSource) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent funding changed before stop",
        } as const;
      }
      if (
        effectiveAuthorization === "billing_request" &&
        (!fundedSource || rec.status === "running")
      ) {
        const fundedAt = new Date();
        const settlement =
          await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
            tx,
            agentId,
            orgId,
            fundedAt,
            "billing_recovery",
          );
        if (settlement.status === "funded_until") {
          if (
            !(await deferFundedAgentStopInTransaction(tx, {
              agentId,
              organizationId: orgId,
              jobId,
              stopAfter: settlement.stopAfter,
            }))
          ) {
            throw new Error("Funded stop lost its billing authority");
          }
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason: "billing_recovered",
          } as const;
        }
        if (settlement.status !== "insufficient_credits") {
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "superseded",
              last_error: "billing_recovered",
              superseded_at: fundedAt,
              updated_at: fundedAt,
            })
            .where(eq(agentComputeStopIntents.id, stopIntent!.id));
          await tx
            .update(agentSandboxes)
            .set({
              billing_status: "active",
              shutdown_warning_sent_at: null,
              scheduled_shutdown_at: null,
              updated_at: fundedAt,
            })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)));
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason: "billing_recovered",
          } as const;
        }
      }

      let fundedStop: Awaited<ReturnType<typeof stopFundedAgentInTransaction>> = null;
      if (fundedSource) {
        if (!snapshotCaptureStillCanonical(rec, snapshotSource)) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent lifecycle changed before funded stop",
          } as const;
        }
        fundedStop = await stopFundedAgentInTransaction(tx, {
          agentId,
          organizationId: orgId,
          lifecycleRevision: rec.lifecycle_revision,
        });
        if (!fundedStop) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent funding changed before stop",
          } as const;
        }
      }

      // A stopped sandbox with a durable backup remains billable storage. A
      // billing stop queued before a top-up must therefore settle and observe
      // the restored funding above before this physical-state fast path can
      // suspend billing permanently. Explicit user stops remain unconditional.
      if (rec.status === "stopped") {
        const confirmedAt = new Date();
        if (effectiveAuthorization === "user_request" && !fundedStop) {
          await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
            tx,
            agentId,
            orgId,
            confirmedAt,
          );
        }
        const retainedBackupBilling = rec.last_backup_at !== null;
        await tx
          .update(agentSandboxes)
          .set({
            billing_status: retainedBackupBilling ? "active" : "suspended",
            scheduled_shutdown_at: null,
            shutdown_warning_sent_at: null,
            bridge_url: null,
            health_url: null,
            updated_at: confirmedAt,
          })
          .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)));
        if (stopIntent) {
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "provider_confirmed",
              provider_confirmed_at: confirmedAt,
              retained_backup_billing: retainedBackupBilling,
              retained_backup_rate_per_hour: retainedBackupBilling
                ? String(AGENT_PRICING.IDLE_HOURLY_RATE)
                : null,
              updated_at: confirmedAt,
            })
            .where(eq(agentComputeStopIntents.id, stopIntent.id));
        }
        return { success: true, containerStopped: true } as const;
      }

      // The gate captured against snapshotSource's generation; a moved
      // lifecycle means the backup may not cover the container being stopped.
      if (!snapshotCaptureStillCanonical(rec, snapshotSource)) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent lifecycle changed while the suspend backup was prepared",
        } as const;
      }

      if (pendingSuspendSnapshot) {
        const persisted = await this.host.persistSnapshotWithinTransaction(
          tx,
          rec.id,
          rec.organization_id,
          "pre-shutdown",
          pendingSuspendSnapshot.stateData,
          pendingSuspendSnapshot.sizeBytes,
        );
        suspendBackupId = persisted.backupId;
        backupCapturedFresh = true;
      }

      let containerStopped = false;
      const attempt = (stopIntent?.attempts ?? 0) + 1;
      if (stopIntent) {
        await tx
          .update(agentComputeStopIntents)
          .set({
            status: "dispatching",
            attempts: attempt,
            provider_started_at: new Date(),
            last_error: null,
            updated_at: new Date(),
          })
          .where(eq(agentComputeStopIntents.id, stopIntent.id));
      }
      if (rec.sandbox_id && !fundedStop) {
        const stop = await this.host.runBoundedSandboxStopForReplacement(rec.sandbox_id);
        if (stop) {
          if (stopIntent) {
            const failedAt = new Date();
            await tx
              .update(agentComputeStopIntents)
              .set({
                status: attempt >= 3 ? "terminal_attention" : "retry",
                last_error: stop.error instanceof Error ? stop.error.message : String(stop.error),
                next_attempt_at: new Date(failedAt.getTime() + 5 * 60 * 1000),
                updated_at: failedAt,
              })
              .where(eq(agentComputeStopIntents.id, stopIntent.id));
          }
          return {
            success: false,
            containerStopped: false,
            error: stop.error instanceof Error ? stop.error.message : String(stop.error),
          } as const;
        }
        containerStopped = true;
      } else {
        containerStopped = true;
      }

      const confirmedAt = new Date();
      if (effectiveAuthorization === "user_request" && !fundedStop) {
        await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
          tx,
          agentId,
          orgId,
          confirmedAt,
        );
      }
      const retainedBackupBilling = backupCapturedFresh || rec.last_backup_at !== null;
      // The lifecycle row remains FOR UPDATE from the locked tier check through
      // provider stop and persistence, so this final allowlist cannot become a
      // zero-row tier race. It mirrors the guard in SQL as defense in depth.
      await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET status = 'stopped',
            billing_status = ${retainedBackupBilling ? "active" : "suspended"},
            scheduled_shutdown_at = NULL, shutdown_warning_sent_at = NULL,
            bridge_url = NULL, health_url = NULL, updated_at = NOW()
            ${backupCapturedFresh ? sql`, last_backup_at = NOW()` : sql``}
        WHERE id = ${rec.id}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
      `);
      if (stopIntent) {
        await tx
          .update(agentComputeStopIntents)
          .set({
            status: "provider_confirmed",
            provider_confirmed_at: confirmedAt,
            retained_backup_billing: retainedBackupBilling,
            retained_backup_rate_per_hour: retainedBackupBilling
              ? String(AGENT_PRICING.IDLE_HOURLY_RATE)
              : null,
            updated_at: confirmedAt,
          })
          .where(eq(agentComputeStopIntents.id, stopIntent.id));
      }
      return { success: true, containerStopped, backupId: suspendBackupId } as const;
    });
    if (result.success && fundedSource) await creditsService.invalidateCreditCaches(orgId);
    if (result.success && backupCapturedFresh) {
      // error-policy:J6 pruning is retention housekeeping after the suspend
      // committed; its failure is logged, never surfaced as a suspend failure.
      await agentSandboxesRepository.pruneBackups(agentId, MAX_BACKUPS).catch((error) => {
        logger.warn("[agent-sandbox] Backup pruning failed after suspend", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return result;
  }

  /**
   * Daemon-side handler for `agent_resume`. Paid retained runtime commits its
   * next hold before guarded start, then restores ingress only after readiness.
   * Failed start writeback replays the same hold and durable host timestamp.
   * Legacy containers still delegate to provision and its backup restore path.
   */
  async executeResume(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerStarted: boolean;
    reprovisioned: boolean;
    error?: string;
  }> {
    // Read from the PRIMARY: a replica-lagged "Agent not found" / stale status
    // here would turn a legitimate resume into a terminal no-op (the daemon
    // maps "Agent not found" to completed), silently dropping the request. The
    // existence + deletion-state check must be authoritative.
    const rec = await this.host.getAgentForWrite(agentId, orgId);
    if (!rec || rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status))
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Agent not found",
      };
    const tierRejection = rejectNonContainerBackedProvision(rec);
    if (tierRejection) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: tierRejection.error,
      };
    }

    if (rec.status === "running")
      return { success: true, containerStarted: true, reprovisioned: false };

    try {
      const retained = await this.executeFundedResume(agentId, orgId);
      if (retained) return retained;
    } catch (error) {
      // error-policy:J1 keep paid retained state retryable; never fall into replacement after ambiguous start.
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const fundingAuthority = await this.host.getAgentForWrite(agentId, orgId);
    if (
      !fundingAuthority ||
      !isContainerBackedExecutionTier(fundingAuthority.execution_tier) ||
      fundingAuthority.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before resume billing settlement",
      };
    }

    const funding = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      agentId,
      orgId,
      new Date(),
    );
    if (funding.status === "insufficient_credits") {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      };
    }

    const provisionResult = await this.host.provision(agentId, orgId);
    if (!provisionResult.success) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: true,
        error: provisionResult.error,
      };
    }
    return { success: true, containerStarted: true, reprovisioned: true };
  }

  /** Admit a verified stopped placement only after wake validated its restore source. */
  private async prepareRetainedWake(expected: AgentSandbox): Promise<AgentSandbox> {
    return dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, expected.id, expected.organization_id);
      const current = await this.host.getAgentForLifecycleMutation(
        tx,
        expected.id,
        expected.organization_id,
      );
      if (
        !current ||
        current.status !== "stopped" ||
        current.deleted_at ||
        current.deletion_attempt_id ||
        current.pool_status !== null ||
        current.execution_tier !== expected.execution_tier ||
        current.lifecycle_revision !== expected.lifecycle_revision ||
        current.environment_revision !== expected.environment_revision ||
        current.lifecycle_job_id !== expected.lifecycle_job_id ||
        current.lifecycle_execution_generation !== expected.lifecycle_execution_generation ||
        this.host.getReplacementCleanupLocator(current)
      ) {
        throw new ElizaError("Dedicated stopped restore authority changed", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      }
      const [latest] = await tx
        .select()
        .from(agentComputeFunding)
        .where(
          and(
            eq(agentComputeFunding.agent_id, current.id),
            eq(agentComputeFunding.organization_id, current.organization_id),
          ),
        )
        .orderBy(desc(agentComputeFunding.period_start), desc(agentComputeFunding.id))
        .limit(1);
      if (!latest) return current;
      if (
        !latest.settled_at ||
        !latest.provider_stop_receipt ||
        !latest.provider_container_id ||
        latest.provider_node_id !== current.node_id ||
        !current.sandbox_id ||
        current.container_name !== current.sandbox_id
      ) {
        throw new ElizaError("Dedicated stopped restore requires a verified retained stop", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      }
      // Generic stopped admission clears retired placement; this verified paid
      // instance instead enters provisioning with its exact retained locator.
      const [admitted] = await tx
        .update(agentSandboxes)
        .set({ status: "provisioning", updated_at: new Date() })
        .where(
          and(
            eq(agentSandboxes.id, current.id),
            eq(agentSandboxes.organization_id, current.organization_id),
          ),
        )
        .returning();
      if (!admitted)
        throw new ElizaError("Dedicated stopped restore admission failed", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      return admitted;
    });
  }

  private async executeFundedResume(agentId: string, orgId: string) {
    const admission = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const [fundingHistory] = await tx
        .select()
        .from(agentComputeFunding)
        .where(
          and(
            eq(agentComputeFunding.agent_id, agentId),
            eq(agentComputeFunding.organization_id, orgId),
          ),
        )
        .orderBy(desc(agentComputeFunding.period_start), desc(agentComputeFunding.id))
        .limit(1);
      if (!fundingHistory) return null;
      const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (rec?.status === "running") return { alreadyRunning: true as const };
      if (
        !rec ||
        this.host.getReplacementCleanupLocator(rec) ||
        (await this.host.hasActiveProvisionJobTx(tx, agentId, orgId))
      ) {
        throw new ElizaError("Dedicated retained resume authority changed", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      }
      // An error may represent a failed backup application after early
      // adoption. A plain Docker resume would expose that partial runtime.
      if (rec.status === "error" || !fundingHistory.runtime_ready_at)
        return { restoreRequired: true as const };
      if (!rec.bridge_port || !rec.web_ui_port)
        throw new ElizaError("Dedicated resume is missing retained ports", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      if (!(await hasOpenAgentComputeFunding(tx, agentId, orgId))) {
        const settled =
          await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
            tx,
            agentId,
            orgId,
            new Date(),
          );
        if (settled.status === "insufficient_credits")
          throw new ElizaError("Insufficient credits to settle Dedicated storage", {
            code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
          });
      }
      const funded = await agentComputeFundingService.reserveRetainedResumeInTransaction(tx, {
        agentId,
        organizationId: orgId,
        lifecycleRevision: rec.lifecycle_revision,
      });
      if (!funded)
        throw new ElizaError("Dedicated funding history changed", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      const [admitted] = await tx
        .update(agentSandboxes)
        .set({
          status: "provisioning",
          billing_status: "active",
          last_billed_at: funded.window.period_start,
          updated_at: new Date(),
        })
        .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)))
        .returning();
      if (!admitted)
        throw new ElizaError("Dedicated resume admission did not persist", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      return {
        alreadyRunning: false as const,
        agentId,
        organizationId: orgId,
        lifecycleRevision: admitted.lifecycle_revision,
        fundingId: funded.window.id,
        nodeId: funded.window.provider_node_id!,
        containerId: funded.window.provider_container_id!,
      };
    });
    if (!admission) return null;
    if ("restoreRequired" in admission) {
      const restored = await this.executeWake(agentId, orgId);
      return {
        success: restored.success,
        containerStarted: restored.success,
        reprovisioned: restored.reprovisioned,
        ...(restored.error ? { error: restored.error } : {}),
      };
    }
    if (admission.alreadyRunning)
      return { success: true, containerStarted: true, reprovisioned: false };
    await creditsService.invalidateCreditCaches(orgId);
    const started = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      return startFundedAgentInTransaction(tx, admission);
    });
    const host = started.agent.headscale_ip || started.node.hostname;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    const bridgePort = started.agent.headscale_ip
      ? started.containerPort
      : started.agent.bridge_port!;
    const webPort = started.agent.headscale_ip ? started.containerPort : started.agent.web_ui_port!;
    const handle: SandboxHandle = {
      sandboxId: started.agent.container_name!,
      bridgeUrl: `http://${urlHost}:${bridgePort}`,
      healthUrl: `http://${urlHost}:${webPort}/api`,
      metadata: {
        provider: "docker",
        nodeId: admission.nodeId,
        hostname: started.node.hostname,
        containerName: started.agent.container_name!,
        agentId,
        bridgePort: started.agent.bridge_port!,
        webUiPort: started.agent.web_ui_port!,
        nodeSshPort: started.node.ssh_port,
        nodeSshUser: started.node.ssh_user,
        nodeHostKeyFingerprint: started.node.host_key_fingerprint,
        ...(started.agent.headscale_ip ? { headscaleIp: started.agent.headscale_ip } : {}),
      },
    };
    const provider = await this.host.getProvider();
    const ready = provider.checkHealthDetailed
      ? (await provider.checkHealthDetailed(handle, { kind: "candidate" })).ready
      : await provider.checkHealth(handle, { kind: "candidate" });
    if (!ready)
      return {
        success: false,
        containerStarted: true,
        reprovisioned: false,
        error: "Dedicated retained runtime is not ready; paid resume can be retried",
      };
    await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      await agentComputeFundingService.authorizeHostInTransaction(tx, admission);
      const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (
        !rec ||
        rec.status !== "provisioning" ||
        !snapshotCaptureStillCanonical(rec, started.agent)
      ) {
        throw new ElizaError("Dedicated lifecycle changed during resume readiness", {
          code: "AGENT_COMPUTE_RESUME_AUTHORITY_CHANGED",
        });
      }
      await tx
        .update(agentSandboxes)
        .set({
          status: "running",
          bridge_url: handle.bridgeUrl,
          health_url: handle.healthUrl,
          billing_status: "active",
          scheduled_shutdown_at: null,
          shutdown_warning_sent_at: null,
          updated_at: new Date(),
        })
        .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)));
    });
    return { success: true, containerStarted: true, reprovisioned: false };
  }

  /**
   * Daemon-side handler for the `agent_sleep` job — deep, cold suspend.
   *
   * Both suspend and sleep drop the container + free the node slot; unlike
   * `agent_suspend` (which keeps the row's `sandbox_id` + managed DB for an
   * in-place resume), sleep frees the compute identity entirely:
   *   1. Capture a current durable backup before stopping live compute. Already
   *      stopped agents may reuse their proven restorable backup.
   *   2. Stop + drop the container (the provider `stop` removes it from the
   *      node).
   *   3. Clear the compute identity (`sandbox_id`, `node_id`, `container_name`,
   *      ports, bridge/health URLs) so the slot is freed; the node autoscaler
   *      reclaims a now-empty Hetzner box on its next pass. The shared DB,
   *      `environment_vars`, and `docker_image` are retained for wake.
   *   4. Flip status to `sleeping`. No compute cost accrues while sleeping.
   *
   * The inverse is `executeWake`.
   */
  async executeSleep(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerRemoved: boolean;
    backupId?: string;
    error?: string;
  }> {
    const { backupCaptureUnavailable: _backupCaptureUnavailable, ...result } =
      await this.executeSleepWithStopAuthority(agentId, orgId);
    return result;
  }

  private async executeSleepWithStopAuthority(
    agentId: string,
    orgId: string,
    stopAuthority?: {
      jobId: string;
      lifecycleRevision: number;
    },
  ): Promise<{
    success: boolean;
    containerRemoved: boolean;
    backupId?: string;
    error?: string;
    backupCaptureUnavailable?: true;
    skipped?: true;
    reason?: "lifecycle_changed" | "stop_intent_superseded" | "billing_recovered";
  }> {
    // Primary read: replica lag must not turn a real sleep into a no-op.
    let rec = await this.host.getAgentForWrite(agentId, orgId);
    if (!rec) return { success: false, containerRemoved: false, error: "Agent not found" };
    const initialTierRejection = containerBackedServiceRejection(rec, "sleep");
    if (initialTierRejection) {
      return { success: false, containerRemoved: false, error: initialTierRejection };
    }
    if (rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status)) {
      return { success: false, containerRemoved: false, error: "Agent not found" };
    }
    if (this.host.getReplacementCleanupLocator(rec)) {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent replacement cleanup is still pending",
      };
    }
    if (rec.status === "sleeping") return { success: true, containerRemoved: true };
    if (rec.status === "provisioning") {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent provisioning is in progress",
      };
    }

    const revalidated = await this.host.revalidateContainerBackedLifecycleGeneration(rec, "sleep");
    if (!revalidated) {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent lifecycle changed while sleep was prepared",
      };
    }
    rec = revalidated;

    // 1. Durable backup before compute is freed.
    let backupId: string | undefined;
    const prepaidProvider =
      (await this.host.getProvider()).computeFundingCapability === "host-lease-v1";
    let paidRetirement: { fundingId: string; backupId: string } | undefined;
    if (prepaidProvider && rec.status === "stopped" && rec.sandbox_id) {
      const [latest] = await dbWrite
        .select()
        .from(agentComputeFunding)
        .where(
          and(
            eq(agentComputeFunding.agent_id, agentId),
            eq(agentComputeFunding.organization_id, orgId),
          ),
        )
        .orderBy(desc(agentComputeFunding.period_start), desc(agentComputeFunding.id))
        .limit(1);
      if (latest) {
        if (
          !latest.settled_at ||
          !latest.provider_stopped_at ||
          !latest.retirement_backup_id ||
          latest.provider_node_id !== rec.node_id
        ) {
          return {
            success: false,
            containerRemoved: false,
            error: "Stopped Dedicated state has no backup bound to its paid stop",
          };
        }
        paidRetirement = { fundingId: latest.id, backupId: latest.retirement_backup_id };
      }
    }
    let pendingSleepSnapshot: { stateData: AgentBackupStateData; sizeBytes: number } | undefined;
    if (rec.status !== "stopped" && rec.sandbox_id) {
      const capture = await this.prepareSuspendBackupGate(rec);
      if (capture.outcome === "refuse") {
        return {
          success: false,
          containerRemoved: false,
          error: capture.error,
          backupCaptureUnavailable: true,
        };
      }
      if (capture.outcome === "proceed") pendingSleepSnapshot = capture.pendingSnapshot;
    }
    if (!backupId && !pendingSleepSnapshot) {
      // A paid stop may have retained writes newer than the last periodic
      // backup. Only its transaction-bound capture authorizes removal.
      const gate = await runWakeRestoreIntegrityGate({
        sandboxRecordId: rec.id,
        agentName: rec.agent_name,
        requestedBackupId: paidRetirement?.backupId,
      });
      if (!gate.ok) {
        logger.error("[agent-sandbox] Sleep aborted: no restorable backup proven", {
          agentId,
          sandboxRecordId: rec.id,
          failure: gate.failure.kind,
        });
        return {
          success: false,
          containerRemoved: false,
          error: `Refusing to deactivate on an unproven backup; agent was left running. ${formatWakeRestoreIntegrityError(gate.failure)}`,
        };
      }
      if (paidRetirement && gate.verification === "disabled") {
        return {
          success: false,
          containerRemoved: false,
          error: "Paid retirement requires backup integrity verification",
        };
      }
      if (gate.backupId) {
        backupId = gate.backupId;
      } else if (gate.verification === "disabled") {
        // Kill switch: with the gate off, keep the pre-gate behavior of
        // accepting the latest backup rather than inventing a third mode.
        const existing = await agentSandboxesRepository.getLatestBackup(rec.id);
        if (existing) backupId = existing.id;
      }
      if (!backupId) {
        logger.error("[agent-sandbox] Sleep aborted: no durable backup available", {
          agentId,
          sandboxRecordId: rec.id,
        });
        return {
          success: false,
          containerRemoved: false,
          error:
            "Unable to create or find a durable backup before deactivation; agent was left running.",
        };
      }
    }

    // A prepaid stop and its backup/refund must commit before removal can
    // destroy the host receipt or release the node. The second phase locks
    // that exact stopped generation again before clearing its placement.
    const commitSleepPhase = (expected: AgentSandbox) =>
      dbWrite.transaction(async (tx) => {
        await this.host.lockLifecycle(tx, agentId, orgId);
        const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) {
          return {
            success: false as const,
            containerRemoved: false,
            error: "Agent not found",
          };
        }
        const tierRejection = containerBackedServiceRejection(current, "sleep");
        if (tierRejection) {
          return {
            success: false as const,
            containerRemoved: false,
            error: tierRejection,
          };
        }
        if (current.deletion_attempt_id || this.host.isAwaitingDeletion(current.status)) {
          return {
            success: false as const,
            containerRemoved: false,
            error: "Agent not found",
          };
        }
        if (this.host.getReplacementCleanupLocator(current)) {
          return {
            success: false as const,
            containerRemoved: false,
            error: "Agent replacement cleanup is still pending",
          };
        }
        if (
          current.status === "provisioning" ||
          (await this.host.hasActiveReplacementJobTx(tx, agentId, orgId))
        ) {
          return {
            success: false as const,
            containerRemoved: false,
            error: "Agent provisioning is in progress",
          };
        }

        if (
          !snapshotCaptureStillCanonical(current, expected) ||
          current.lifecycle_job_id !== expected.lifecycle_job_id ||
          current.lifecycle_execution_generation !== expected.lifecycle_execution_generation
        ) {
          return {
            success: false as const,
            containerRemoved: false,
            error: "Agent lifecycle changed while sleep was prepared",
          };
        }
        let commitLifecycleRevision = current.lifecycle_revision;
        const [stopIntent] = stopAuthority
          ? await tx
              .select()
              .from(agentComputeStopIntents)
              .where(
                and(
                  eq(agentComputeStopIntents.agent_id, agentId),
                  eq(agentComputeStopIntents.organization_id, orgId),
                  eq(agentComputeStopIntents.job_id, stopAuthority.jobId),
                ),
              )
              .limit(1)
              .for("update")
          : [];
        if (stopAuthority) {
          if (!stopIntent || stopIntent.lifecycle_revision !== stopAuthority.lifecycleRevision) {
            return {
              success: false as const,
              containerRemoved: false,
              error: "Paid retirement lost its stop intent",
            };
          }
          if (
            stopIntent.status === "superseded" ||
            current.lifecycle_revision !== stopAuthority.lifecycleRevision
          ) {
            return {
              success: true as const,
              containerRemoved: false,
              skipped: true as const,
              reason: "lifecycle_changed" as const,
            };
          }
          // A queued billing stop can become a user stop before execution.
          // The locked intent owns that decision, not the original job hint.
          if (stopIntent.authorization === "billing_request" && current.status === "running") {
            const now = new Date();
            const settlement =
              await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
                tx,
                agentId,
                orgId,
                now,
                "billing_recovery",
              );
            if (settlement.status === "funded_until") {
              if (
                !(await deferFundedAgentStopInTransaction(tx, {
                  agentId,
                  organizationId: orgId,
                  jobId: stopAuthority.jobId,
                  stopAfter: settlement.stopAfter,
                }))
              ) {
                throw new Error("Funded retirement lost its billing authority");
              }
              return {
                success: true as const,
                containerRemoved: false,
                skipped: true as const,
                reason: "billing_recovered" as const,
              };
            }
            if (settlement.status !== "insufficient_credits") {
              await tx
                .update(agentComputeStopIntents)
                .set({
                  status: "superseded",
                  last_error: "billing_recovered",
                  superseded_at: now,
                  updated_at: now,
                })
                .where(eq(agentComputeStopIntents.id, stopIntent.id));
              await tx
                .update(agentSandboxes)
                .set({
                  billing_status: "active",
                  scheduled_shutdown_at: null,
                  shutdown_warning_sent_at: null,
                  updated_at: now,
                })
                .where(
                  and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)),
                );
              return {
                success: true as const,
                containerRemoved: false,
                skipped: true as const,
                reason: "billing_recovered" as const,
              };
            }
          }
        }
        if (pendingSleepSnapshot) {
          const persisted = await this.host.persistSnapshotWithinTransaction(
            tx,
            current.id,
            current.organization_id,
            "pre-shutdown",
            pendingSleepSnapshot.stateData,
            pendingSleepSnapshot.sizeBytes,
          );
          backupId = persisted.backupId;
          commitLifecycleRevision = persisted.lifecycleRevision;
        }
        if (!current.sandbox_id && (current.node_id || current.container_name)) {
          return {
            success: false as const,
            containerRemoved: false,
            error: "Sandbox locator is incomplete; compute was left unchanged",
          };
        }

        if (prepaidProvider && (await hasOpenAgentComputeFunding(tx, agentId, orgId))) {
          const funding = await stopFundedAgentInTransaction(tx, {
            agentId,
            organizationId: orgId,
            lifecycleRevision: commitLifecycleRevision,
          });
          if (!funding) throw new Error("Sleep lost its paid stop authority");
          if (!backupId) throw new Error("Sleep lost its current backup before paid retirement");
          await tx
            .update(agentComputeFunding)
            .set({ retirement_backup_id: backupId })
            .where(
              and(
                eq(agentComputeFunding.id, funding.fundingId),
                eq(agentComputeFunding.organization_id, orgId),
              ),
            );
          paidRetirement = { fundingId: funding.fundingId, backupId };
          const [stopped] = await tx
            .update(agentSandboxes)
            .set({ status: "stopped", updated_at: new Date() })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)))
            .returning();
          if (!stopped) throw new Error("Sleep lost its stopped generation");
          if (stopIntent && stopAuthority) {
            // This stop advances the row's revision itself. Carry that exact
            // committed generation into the existing bound intent for crash retry;
            // later resume or configuration writes still invalidate it.
            await tx
              .update(agentComputeStopIntents)
              .set({ lifecycle_revision: stopped.lifecycle_revision, updated_at: new Date() })
              .where(eq(agentComputeStopIntents.id, stopIntent.id));
            stopAuthority.lifecycleRevision = stopped.lifecycle_revision;
          }
          if (current.node_id)
            await reconcileAllocatedWorkloadsOnNodeWithDatabase(tx, current.node_id);
          return {
            success: true as const,
            containerRemoved: false,
            fundedRetirement: stopped,
            funding,
          };
        }

        if (prepaidProvider && current.sandbox_id) {
          const [latest] = await tx
            .select()
            .from(agentComputeFunding)
            .where(
              and(
                eq(agentComputeFunding.agent_id, agentId),
                eq(agentComputeFunding.organization_id, orgId),
              ),
            )
            .orderBy(desc(agentComputeFunding.period_start), desc(agentComputeFunding.id))
            .limit(1)
            .for("update");
          if (
            latest &&
            (!paidRetirement ||
              latest.id !== paidRetirement.fundingId ||
              latest.retirement_backup_id !== paidRetirement.backupId ||
              !latest.settled_at ||
              !latest.provider_stopped_at ||
              latest.provider_node_id !== current.node_id)
          ) {
            return {
              success: false as const,
              containerRemoved: false,
              error: "Paid retirement backup authority changed",
            };
          }
        }
        if (current.sandbox_id) {
          if (stopIntent) {
            await tx
              .update(agentComputeStopIntents)
              .set({
                status: "dispatching",
                attempts: stopIntent.attempts + 1,
                provider_started_at: new Date(),
                updated_at: new Date(),
              })
              .where(eq(agentComputeStopIntents.id, stopIntent.id));
          }
          const stop = prepaidProvider
            ? await this.host.runBoundedSandboxStopForReplacement(current.sandbox_id, {
                releaseCapacity: false,
              })
            : await this.host.runBoundedSandboxStopForReplacement(current.sandbox_id);
          if (stop) {
            if (stopIntent) {
              await tx
                .update(agentComputeStopIntents)
                .set({
                  status: stopIntent.attempts + 1 >= 3 ? "terminal_attention" : "retry",
                  last_error: stop.error instanceof Error ? stop.error.message : String(stop.error),
                  next_attempt_at: new Date(Date.now() + 5 * 60 * 1000),
                  updated_at: new Date(),
                })
                .where(eq(agentComputeStopIntents.id, stopIntent.id));
            }
            return {
              success: false as const,
              containerRemoved: false,
              error: stop.error instanceof Error ? stop.error.message : String(stop.error),
            };
          }
        }

        const cleared = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'sleeping',
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          node_id = NULL,
          container_name = NULL,
          headscale_ip = NULL,
          bridge_port = NULL,
          web_ui_port = NULL,
          last_backup_at = NOW(),
          updated_at = NOW()
        WHERE id = ${current.id}
          AND organization_id = ${orgId}
          AND status = ${current.status}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND sandbox_id IS NOT DISTINCT FROM ${current.sandbox_id}
          AND node_id IS NOT DISTINCT FROM ${current.node_id}
          AND container_name IS NOT DISTINCT FROM ${current.container_name}
          AND environment_revision = ${current.environment_revision}
          AND lifecycle_revision = ${commitLifecycleRevision}
        RETURNING id
      `);
        if (cleared.rows.length !== 1) {
          throw new Error("Sleep lost its lifecycle generation CAS");
        }
        if (prepaidProvider && current.node_id)
          await reconcileAllocatedWorkloadsOnNodeWithDatabase(tx, current.node_id);
        if (stopIntent) {
          const now = new Date();
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "provider_confirmed",
              provider_confirmed_at: now,
              retained_backup_billing: false,
              retained_backup_rate_per_hour: null,
              last_error: null,
              updated_at: now,
            })
            .where(eq(agentComputeStopIntents.id, stopIntent.id));
          await tx
            .update(agentSandboxes)
            .set({
              billing_status: "suspended",
              scheduled_shutdown_at: null,
              shutdown_warning_sent_at: null,
            })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)));
        }
        return {
          success: true as const,
          containerRemoved: true,
        };
      });
    let sleepCommit = await commitSleepPhase(rec);
    if (!sleepCommit.success) return sleepCommit;
    if ("skipped" in sleepCommit && sleepCommit.skipped) return sleepCommit;
    if ("fundedRetirement" in sleepCommit && sleepCommit.fundedRetirement) {
      rec = sleepCommit.fundedRetirement;
      pendingSleepSnapshot = undefined;
      if (sleepCommit.funding.purchasedCreditRefunded)
        await creditsService.invalidateCreditCaches(orgId);
      const verified = await runWakeRestoreIntegrityGate({
        sandboxRecordId: rec.id,
        agentName: rec.agent_name,
        requestedBackupId: backupId,
      });
      if (!verified.ok || verified.verification === "disabled" || verified.backupId !== backupId) {
        return {
          success: false,
          containerRemoved: false,
          error: "Paid retirement backup failed integrity verification",
        };
      }
      sleepCommit = await commitSleepPhase(rec);
      if (!sleepCommit.success) return sleepCommit;
      if ("skipped" in sleepCommit && sleepCommit.skipped) return sleepCommit;
      if (!sleepCommit.containerRemoved) throw new Error("Sleep paid retirement did not converge");
    }

    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS).catch((error) => {
      logger.warn("[agent-sandbox] Backup pruning failed after sleep", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info("[agent-sandbox] Sleep complete", {
      agentId,
      backupId,
      containerRemoved: sleepCommit.containerRemoved,
    });
    return { success: true, containerRemoved: sleepCommit.containerRemoved, backupId };
  }

  /**
   * Daemon-side handler for the `agent_wake` job — the inverse of sleep.
   *
   * The backup being restored IS the sleeping agent's entire durable state
   * (sleep already discarded the compute identity), so before provisioning
   * anything the wake runs the restore-integrity gate (#15603 B6): the backup
   * the restore will apply must decrypt, chain-replay, and hash-verify. A
   * failed gate fails the wake with a typed, user-legible error and leaves
   * the sandbox `sleeping` — never a silent fresh boot. The explicit escape
   * hatches are `opts.restoreBackupId` (wake from an older validated backup)
   * and `opts.forceFreshBoot` (boot empty, accepting the data loss); both are
   * opt-ins surfaced on the wake route, never defaults.
   *
   * On a clean gate, provisions a fresh container (claiming a warm-pool slot
   * when available) and restores the validated backup. Idempotent: waking an
   * already-running agent is a no-op.
   */
  async executeWake(
    agentId: string,
    orgId: string,
    opts?: { restoreBackupId?: string; forceFreshBoot?: boolean },
  ): Promise<{
    success: boolean;
    reprovisioned: boolean;
    restoredBackupId?: string;
    /** True when the wake deliberately booted empty via `forceFreshBoot`. */
    freshBoot?: boolean;
    /** Structured gate failure; set exactly when the wake was blocked by the integrity gate. */
    integrityFailure?: WakeRestoreIntegrityFailure;
    error?: string;
  }> {
    // Primary read: a replica-lagged "Agent not found" must not no-op a wake.
    let rec = await this.host.getAgentForWrite(agentId, orgId);
    if (!rec) return { success: false, reprovisioned: false, error: "Agent not found" };
    const tierRejection = containerBackedServiceRejection(rec, "wake");
    if (tierRejection) {
      return { success: false, reprovisioned: false, error: tierRejection };
    }
    if (rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status)) {
      return { success: false, reprovisioned: false, error: "Agent not found" };
    }
    if (rec.status === "running" && rec.bridge_url) {
      return { success: true, reprovisioned: false };
    }
    if (opts?.restoreBackupId && opts?.forceFreshBoot) {
      // The route rejects this combination; enforced here too so a hand-crafted
      // job row cannot smuggle an ambiguous instruction past the gate.
      return {
        success: false,
        reprovisioned: false,
        error: "restoreBackupId and forceFreshBoot are mutually exclusive",
      };
    }
    const gateSource = await this.host.getAgentForWrite(agentId, orgId);
    if (!gateSource || !isContainerBackedExecutionTier(gateSource.execution_tier)) {
      return {
        success: false,
        reprovisioned: false,
        error: gateSource ? containerBackedServiceRejection(gateSource, "wake") : "Agent not found",
      };
    }
    const gateAuthority = await this.host.revalidateContainerBackedLifecycleGeneration(
      gateSource,
      "wake",
    );
    if (!gateAuthority) {
      return {
        success: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before wake restore validation",
      };
    }
    rec = gateAuthority;

    // Reject an unusable backup before changing billing or allocating compute.
    const gate = opts?.forceFreshBoot
      ? null
      : await runWakeRestoreIntegrityGate({
          sandboxRecordId: rec.id,
          agentName: rec.agent_name,
          requestedBackupId: opts?.restoreBackupId,
        });
    if (gate && !gate.ok) {
      return {
        success: false,
        reprovisioned: false,
        error: formatWakeRestoreIntegrityError(gate.failure),
        integrityFailure: gate.failure,
      };
    }

    const fundingAuthority = await this.host.getAgentForWrite(agentId, orgId);
    if (
      !fundingAuthority ||
      !isContainerBackedExecutionTier(fundingAuthority.execution_tier) ||
      fundingAuthority.lifecycle_revision !== rec.lifecycle_revision ||
      fundingAuthority.environment_revision !== rec.environment_revision ||
      fundingAuthority.lifecycle_job_id !== rec.lifecycle_job_id ||
      fundingAuthority.lifecycle_execution_generation !== rec.lifecycle_execution_generation ||
      fundingAuthority.status !== rec.status ||
      fundingAuthority.execution_tier !== rec.execution_tier
    ) {
      return {
        success: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before wake billing settlement",
      };
    }
    rec = fundingAuthority;
    const provider = await this.host.getProvider();
    const funding =
      provider.computeFundingCapability === "host-lease-v1"
        ? await settleAgentBringUpBilling(rec)
        : await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
            agentId,
            orgId,
            new Date(),
          );
    if (funding.status === "insufficient_credits") {
      return {
        success: false,
        reprovisioned: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      };
    }

    if (rec.status === "stopped" && provider.computeFundingCapability === "host-lease-v1") {
      rec = await this.prepareRetainedWake(rec);
    }

    if (!gate) {
      logger.warn("[agent-sandbox] Wake with explicit forceFreshBoot: restore skipped by user", {
        agentId,
      });
      const provisionResult = await this.host.provision(agentId, orgId, { kind: "fresh-boot" });
      if (!provisionResult.success) {
        return { success: false, reprovisioned: true, error: provisionResult.error };
      }
      logger.info("[agent-sandbox] Wake complete (explicit fresh boot)", { agentId });
      return { success: true, reprovisioned: true, freshBoot: true };
    }

    // Restore through provision's explicit from-backup path whenever the gate
    // validated a concrete backup — including the default (latest) wake. The
    // override disables provision's unrecoverable-snapshot degrade, so a
    // restore failure FAILS the provision (retryable, chain preserved) instead
    // of booting empty and pruning every backup. That degrade is designed for
    // a running agent losing volatile session state; on a wake the backup IS
    // the agent, and the fresh-stamp gate path never touches the stored bytes,
    // so provision's restore is the first real read. `gate.backupId` is null
    // only when there is nothing to restore (no-backup) or the kill switch
    // reverted the wake to the ungated legacy latest-backup behavior.
    const restoreOverride: ProvisionRestoreOverride | undefined = gate.backupId
      ? { kind: "from-backup", backupId: gate.backupId }
      : undefined;
    // Kill-switch wakes keep the pre-gate report shape: provision auto-restores
    // the latest backup, so name its id (metadata read only — no eager decrypt
    // of a possibly-corrupt envelope on the deliberately-ungated path).
    const restoredBackupId =
      gate.verification === "disabled" && !gate.backupId
        ? (await agentSandboxesRepository.getLatestStoredBackup(rec.id))?.id
        : (gate.backupId ?? undefined);

    const provisionResult = restoreOverride
      ? await this.host.provision(agentId, orgId, restoreOverride)
      : await this.host.provision(agentId, orgId);
    if (!provisionResult.success) {
      return { success: false, reprovisioned: true, error: provisionResult.error };
    }

    logger.info("[agent-sandbox] Wake complete", {
      agentId,
      restoredBackupId,
      verification: gate.verification,
    });
    return { success: true, reprovisioned: true, restoredBackupId };
  }

  /**
   * Daemon-side handler for the `agent_restart` job. Runs `shutdown()`
   * (SSH stop + DB to stopped) and then `provision()` (recreate
   * container + restore URLs). Replaces the Worker-side sequence which
   * silently no-op'd the SSH stop and left the old container running
   * alongside the new one.
   *
   * A replacement is created only after the provider positively proves the old
   * workload stopped. Treating an unreachable node as gone can revive two live
   * agents when that node returns, so shutdown failure keeps the row fenced and
   * fails this restart for the durable job retry.
   */
  async executeRestart(
    agentId: string,
    orgId: string,
    options?: { readonly stateLossAcknowledged?: boolean },
  ): Promise<{
    success: boolean;
    containerStopped: boolean;
    containerStarted: boolean;
    bridgeUrl?: string;
    healthUrl?: string;
    error?: string;
    retryable?: boolean;
  }> {
    // Bail before shutdown()+provision() if the row is being deleted — restart
    // would otherwise flip a deletion_pending row to `stopped` and rebuild a
    // container the agent_delete job is tearing down. Reported as not-found so
    // the daemon handler completes the job as a terminal no-op. Read from the
    // PRIMARY so a replica-lagged status doesn't bail a legitimate restart (or
    // miss an in-flight deletion) on stale data.
    const rec = await this.host.getAgentForWrite(agentId, orgId);
    if (!rec) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent not found",
      };
    }
    const tierRejection = containerBackedServiceRejection(rec, "restart");
    if (tierRejection) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: tierRejection,
      };
    }
    if (rec.deletion_attempt_id || this.host.isAwaitingDeletion(rec.status)) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent not found",
      };
    }
    const fundingAuthority = await this.host.getAgentForWrite(agentId, orgId);
    if (
      !fundingAuthority ||
      !isContainerBackedExecutionTier(fundingAuthority.execution_tier) ||
      fundingAuthority.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent lifecycle changed before restart billing settlement",
      };
    }
    const provider = await this.host.getProvider();
    const funding =
      provider.computeFundingCapability === "host-lease-v1"
        ? await settleAgentBringUpBilling(rec)
        : await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
            agentId,
            orgId,
            new Date(),
          );
    if (funding.status === "insufficient_credits") {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      };
    }
    if (rec.claimed_at && rec.warm_claim_credential_state === null) {
      await this.host.prepareLegacyWarmClaimCredentialRecovery(agentId, orgId);
    }

    const shutdownResult = await this.shutdown(agentId, orgId, {
      stateLossAcknowledged: options?.stateLossAcknowledged,
    });
    if (!shutdownResult.success) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        // Propagate retryability: a transient pre-stop capture failure (PGlite
        // closing race) must re-queue the restart, not permanently wedge a
        // healthy agent (2026-08-11 fleet incident).
        retryable: shutdownResult.retryable,
        error: shutdownResult.error ?? "Failed to stop sandbox before restart",
      };
    }

    let restoreOverride: ProvisionRestoreOverride | undefined;
    if (
      provider.computeFundingCapability === "host-lease-v1" &&
      !shutdownResult.stateLossAcknowledged
    ) {
      const stopped = await this.host.getAgentForWrite(agentId, orgId);
      if (
        !stopped ||
        stopped.status !== "stopped" ||
        stopped.sandbox_id !== null ||
        stopped.environment_revision !== rec.environment_revision ||
        stopped.lifecycle_job_id !== rec.lifecycle_job_id ||
        stopped.lifecycle_execution_generation !== rec.lifecycle_execution_generation ||
        stopped.execution_tier !== rec.execution_tier
      ) {
        return {
          success: false,
          containerStopped: true,
          containerStarted: false,
          error: "Agent restart authority changed after shutdown",
        };
      }
      const gate = await runWakeRestoreIntegrityGate({
        sandboxRecordId: agentId,
        agentName: stopped.agent_name,
      });
      if (!gate.ok || !gate.backupId) {
        return {
          success: false,
          containerStopped: true,
          containerStarted: false,
          error: !gate.ok
            ? formatWakeRestoreIntegrityError(gate.failure)
            : "Paid restart requires a restorable backup",
        };
      }
      restoreOverride = {
        kind: "from-backup",
        backupId: gate.backupId,
        requireRestoreEndpoint: true,
        expectedAdmission: stopped,
      };
    }
    const provisionResult = await this.host.provision(agentId, orgId, restoreOverride);
    if (!provisionResult.success) {
      return {
        success: false,
        containerStopped: shutdownResult.success,
        containerStarted: false,
        error: provisionResult.error,
      };
    }

    if (rec.claimed_at && rec.warm_claim_credential_state !== "ready") {
      try {
        await this.host.recoverPendingWarmClaimInferenceKey(agentId, orgId);
      } catch (error) {
        // error-policy:J1 restart boundary translation — credential recovery
        // failure is returned explicitly instead of claiming the restart succeeded.
        return {
          success: false,
          containerStopped: shutdownResult.success,
          containerStarted: true,
          error: `${WARM_CLAIM_RECOVERY_FAILURE_PREFIX} ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    return {
      success: true,
      containerStopped: shutdownResult.success,
      containerStarted: true,
      bridgeUrl: provisionResult.bridgeUrl,
      healthUrl: provisionResult.healthUrl,
    };
  }
}
