/** Owns sandbox deletion operations while preserving the host’s lifecycle transactions, provider instance, and backup authority. */

import crypto from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ensureAgentSandboxSchema } from "../../../../db/ensure-agent-sandbox-schema";
import { dbWrite } from "../../../../db/helpers";
import {
  type AgentSandbox,
  agentSandboxesRepository,
  PRE_DELETE_BACKUP_RETENTION_MS,
} from "../../../../db/repositories/agent-sandboxes";
import { userCharactersRepository } from "../../../../db/repositories/characters";
import { sharedRuntimeHistoryRepository } from "../../../../db/repositories/shared-runtime-history";
import { agentComputeFunding } from "../../../../db/schemas/agent-compute-funding";
import {
  type AgentBackupStateData,
  agentSandboxes,
  WARM_POOL_ORG_ID,
} from "../../../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../../../db/schemas/docker-nodes";
import { jobs } from "../../../../db/schemas/jobs";
import type { RuntimeDurableObjectNamespace } from "../../../../types/cloud-worker-env";
import { getCloudBinding } from "../../../runtime/cloud-bindings";
import { logger } from "../../../utils/logger";
import {
  cancelUnboundAgentComputeInTransaction,
  stopFundedAgentInTransaction,
} from "../../agent-compute-stop";
import { apiKeysService } from "../../api-keys";
import { creditsService } from "../../credits";
import { holdsCountedNodeSlot, isDeletionContinuation } from "../../docker-node-workload-queries";
import { reusesExistingElizaCharacter } from "../../eliza-agent-config";
import { JOB_TYPES } from "../../provisioning-job-types";
import { type SandboxDeletionLocator } from "../../sandbox-provider-types";
import { purgeSharedConversationRooms } from "../../shared-runtime/conversation-coordinator";
import { SnapshotAuthorityCapture, snapshotCaptureStillCanonical } from "../backup/authority.js";
import { SNAPSHOT_CAPTURE_TRANSIENT, SNAPSHOT_ENDPOINT_UNSUPPORTED } from "../backup/contracts.js";
import { SandboxBackup } from "../backup/service.js";
import { SandboxLifecycleAuthority } from "./authority.js";
import { DeleteAgentResult, DeleteAuthorization } from "./deletion-contracts.js";
import { classifySandboxDeleteStopFailure } from "./deletion-policy.js";
import { SandboxReplacementCleanup } from "./replacement-cleanup.js";
import { BoundedDeletionSandboxStopResult } from "./stop-contracts.js";
import { LifecycleTx } from "./transaction.js";

export interface SandboxDeletionHost {
  getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
  fetchSnapshotState(
    ...args: Parameters<SandboxBackup["fetchSnapshotState"]>
  ): ReturnType<SandboxBackup["fetchSnapshotState"]>;
  runBoundedSandboxStop(
    sandboxId: string,
    locator?: SandboxDeletionLocator | null,
  ): Promise<BoundedDeletionSandboxStopResult>;
  isIgnorableSandboxStopError(error: unknown): boolean;
  lockLifecycle(
    ...args: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>
  ): ReturnType<SandboxLifecycleAuthority["lockLifecycle"]>;
  getAgentForLifecycleMutation(
    ...args: Parameters<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>
  ): ReturnType<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>;
  getReplacementCleanupLocator(
    ...args: Parameters<SandboxReplacementCleanup["getReplacementCleanupLocator"]>
  ): ReturnType<SandboxReplacementCleanup["getReplacementCleanupLocator"]>;
  hasActiveProvisionJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveProvisionJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveProvisionJobTx"]>;
  hasActiveReplacementJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveReplacementJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveReplacementJobTx"]>;
  persistSnapshotWithinTransaction(
    ...args: Parameters<SandboxBackup["persistSnapshotWithinTransaction"]>
  ): ReturnType<SandboxBackup["persistSnapshotWithinTransaction"]>;
  retirePersistedReplacementCleanup(
    ...args: Parameters<SandboxReplacementCleanup["retirePersistedReplacementCleanup"]>
  ): ReturnType<SandboxReplacementCleanup["retirePersistedReplacementCleanup"]>;
}

export class SandboxDeletion {
  constructor(private readonly host: SandboxDeletionHost) {}

  async deleteAgent(
    agentId: string,
    orgId: string,
    options: {
      authorization?: DeleteAuthorization;
      stateLossAcknowledged?: boolean;
    } = {},
  ): Promise<DeleteAgentResult> {
    // Phase 0 — fail-closed pre-deletion capture (#18517), the discipline
    // shutdown() applies before stopping: a live dedicated container is never
    // destroyed without a current backup. Two delete surfaces reach here. The
    // synchronous compat path sees the row still `running`, so a refusal
    // leaves it untouched with nothing for the reconciler to re-arm. The
    // primary v1 path stamps `deletion_pending` at enqueue time and calls
    // this later from the job worker — there the container is still live with
    // its bridge intact, the capture happens before any teardown, and a
    // refusal leaves a recoverable tombstone the next attempt retries.
    let captureWaiverAlreadyPersisted = false;
    let captureWaiverGeneration: {
      bridgeUrl: string | null;
      environmentRevision: number;
      sandboxId: string | null;
    } | null = null;
    let preDeleteBackupCandidate: {
      id: string;
      deletionAttemptId: string;
    } | null = null;
    let preDeleteSnapshot: {
      stateData: AgentBackupStateData;
      sizeBytes: number;
      bridgeUrl: string;
    } | null = null;
    let preDeleteCaptureAuthority: SnapshotAuthorityCapture | null = null;
    const snapshotSource = await this.host.getAgentForWrite(agentId, orgId);
    // An unauthorized delete of a still-`running` row is refused by
    // prepareAgentDelete no matter what happens here, so it skips the capture
    // and keeps its original "suspend it before deletion" refusal — a capture
    // outage must not change which refusal an unauthorized caller sees, nor
    // cost a doomed HTTP round-trip.
    //
    // A `deletion_pending` row is NOT that case: the enqueue already carried
    // the authorization when it stamped the status, and the re-enqueue of a
    // stuck deletion (ProvisioningJobService.reEnqueueFailedDeletions) passes
    // none. Gating phase 0 on `options.authorization` therefore left exactly
    // those jobs arriving at prepareAgentDelete with `snapshot: null` against
    // a capture-requiring row — refused as "lifecycle generation moved" on
    // every attempt, deadlocking the stuck-delete population this guard
    // exists to protect.
    const captureSkippedForUnauthorizedRunning =
      !options.authorization && snapshotSource?.status === "running";
    const captureSkippedForAccountDeletion = options.authorization === "account_deletion";
    if (
      !captureSkippedForUnauthorizedRunning &&
      !captureSkippedForAccountDeletion &&
      this.requiresPreDeleteCapture(snapshotSource)
    ) {
      // A deletion retry whose earlier attempt already captured (or recorded
      // the image's supported no-snapshot response) must not contact a bridge
      // the teardown may already have killed. Both candidates are revalidated
      // under the lifecycle lock before they authorize the delete.
      const priorBackup =
        snapshotSource.deletion_started_at !== null && snapshotSource.deletion_attempt_id !== null
          ? await agentSandboxesRepository.getLatestBackupByType(agentId, "pre-delete")
          : undefined;
      if (
        priorBackup &&
        snapshotSource.deletion_started_at !== null &&
        snapshotSource.deletion_attempt_id !== null &&
        priorBackup.created_at >= snapshotSource.deletion_started_at
      ) {
        preDeleteBackupCandidate = {
          id: priorBackup.id,
          deletionAttemptId: snapshotSource.deletion_attempt_id,
        };
      } else if (this.hasCurrentPreDeleteCaptureWaiver(snapshotSource)) {
        captureWaiverAlreadyPersisted = true;
      } else if (!snapshotSource.bridge_url) {
        if (options.stateLossAcknowledged) {
          // A prior attempt can remove the workload before a later boundary
          // (credential revocation or row-delete settlement) fails. The
          // acknowledged job is the durable authority for the retry; bind its
          // in-memory waiver to the exact absent-bridge generation under the
          // lifecycle lock below. There is no URL to persist in the legacy
          // row-level waiver shape, and every later attempt must re-present the
          // acknowledged job authority.
          preDeleteCaptureAuthority = snapshotSource;
          captureWaiverGeneration = {
            bridgeUrl: null,
            environmentRevision: snapshotSource.environment_revision,
            sandboxId: snapshotSource.sandbox_id,
          };
          logger.error(
            "[agent-sandbox] Delete proceeding without pre-deletion capture: " +
              "state loss acknowledged for an absent bridge",
            { agentId, status: snapshotSource.status },
          );
        } else {
          logger.error("[agent-sandbox] Delete refused: data-bearing container has no bridge", {
            agentId,
            status: snapshotSource.status,
          });
          return {
            success: false,
            error:
              "Refusing to delete without a current backup: the agent's container has no reachable bridge to capture from",
          };
        }
      } else {
        preDeleteCaptureAuthority = snapshotSource;
        try {
          preDeleteSnapshot = await this.host.fetchSnapshotState(snapshotSource);
        } catch (error) {
          // error-policy:J1 the delete command boundary translates capture
          // failures into an explicit refusal; a transient capture failure is
          // marked retryable so the delete job re-attempts without burning
          // its budget (shutdown's rule for the identical signal), and only
          // an image that cannot snapshot by construction proceeds.
          const message = error instanceof Error ? error.message : String(error);
          if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
            captureWaiverGeneration = {
              bridgeUrl: snapshotSource.bridge_url,
              environmentRevision: snapshotSource.environment_revision,
              sandboxId: snapshotSource.sandbox_id,
            };
            logger.warn(
              "[agent-sandbox] Delete proceeding without capture: image has no snapshot endpoint",
              { agentId },
            );
          } else if (options.stateLossAcknowledged) {
            // Explicit customer/operator recovery path: a capture failure can
            // otherwise make a data-bearing agent undeletable forever. Bind the
            // waiver to this exact deletion/container generation and persist it
            // under the lifecycle lock before any destructive work begins.
            captureWaiverGeneration = {
              bridgeUrl: snapshotSource.bridge_url,
              environmentRevision: snapshotSource.environment_revision,
              sandboxId: snapshotSource.sandbox_id,
            };
            logger.error(
              "[agent-sandbox] Delete proceeding WITHOUT pre-deletion capture: state loss acknowledged",
              { agentId, captureError: message },
            );
          } else if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
            logger.warn(
              "[agent-sandbox] Delete deferred: pre-deletion capture transiently unavailable, will retry",
              { agentId },
            );
            return {
              success: false,
              retryable: true,
              error: `Refusing to delete without a current backup: ${message}`,
            };
          } else {
            logger.error("[agent-sandbox] Delete refused: pre-deletion capture failed", {
              agentId,
              error: message,
            });
            return {
              success: false,
              error: `Refusing to delete without a current backup: ${message}`,
            };
          }
        }
      }
    }

    // Phase 1 — take the lifecycle lock, validate
    // preconditions, capture recovery, and revoke/settle paid compute. We deliberately
    // do NOT run the container teardown inside this transaction:
    // provider.stopForDeletion()
    // can hang on an early SSH connect / provider init, and holding the row lock
    // + write transaction + a pooled connection for the full teardown cap (up to
    // SANDBOX_DELETE_STOP_TIMEOUT_MS) would wedge concurrent lifecycle ops on the
    // same agent/org. The lock + transaction are released the moment this returns.
    const precheck = await this.prepareAgentDelete(agentId, orgId, options.authorization, {
      snapshot: preDeleteSnapshot,
      captureAuthority: preDeleteCaptureAuthority,
      captureWaiverGeneration,
      captureWaiverAlreadyPersisted,
      existingBackup: preDeleteBackupCandidate,
    });

    if (!precheck.ok) {
      return { success: false, error: precheck.error };
    }
    let deletionOwnership = precheck;

    logger.info("[agent-sandbox] Deleting agent", {
      agentId,
      sandbox: precheck.sandboxId,
    });

    // Phase 2 — bounded container + VPN teardown, run OUTSIDE the write-lock /
    // transaction. provider.stopForDeletion() removes the container and cleans
    // up the headscale route (each internally bounded), but an EARLY hang (SSH connect /
    // provider init) was unbounded — a single stuck node could hang this delete
    // past the 300s job watchdog and wedge the entire provisioning worker
    // (fail-closed on every provision).
    //
    // Provider errors are captured as values so `withTimeout` rejects ONLY on a
    // genuine hang. A real stop failure on a REACHABLE node still escalates
    // (returns failure / retry), since the container may still be running; an
    // "already gone" failure is ignorable and we proceed.
    // Whether the container is PROVEN not running. A bounded timeout completes the
    // delete but abandons a container that may still be running, so it is not
    // proof — releasing its slot would let the scheduler pack new containers
    // onto a box still running the old ones.
    let containerProvenNotRunning = true;
    let reconciliationReason: string | null = null;

    if (precheck.sandboxId) {
      const sandboxId = precheck.sandboxId;
      const stop = await this.host.runBoundedSandboxStop(sandboxId, precheck.deletionLocator);

      if (stop.kind === "stop-timed-out") {
        const errorMessage = stop.error instanceof Error ? stop.error.message : String(stop.error);
        // The container may still be running, so this generation keeps its
        // node slot. The orphan reconciler releases it once it proves the
        // container is actually not running (#17185).
        containerProvenNotRunning = false;
        reconciliationReason = `container stop timed out: ${errorMessage}`;
        logger.warn(
          "[agent-sandbox] Stop during delete timed out; completing delete and ABANDONING the " +
            "container while retaining its capacity until reconciliation",
          { sandboxId, status: precheck.status, error: errorMessage },
        );
      } else if (stop.kind === "not-running-unresolved") {
        containerProvenNotRunning = false;
        reconciliationReason = stop.reason;
        logger.warn(
          "[agent-sandbox] Provider could not prove the container stopped during delete; " +
            "retaining its capacity until reconciliation",
          { sandboxId, status: precheck.status, reason: stop.reason },
        );
      } else if (stop.kind === "stop-failed") {
        const errorMessage = stop.error instanceof Error ? stop.error.message : String(stop.error);
        const stopFailureKind = classifySandboxDeleteStopFailure(stop.error);
        if (this.host.isIgnorableSandboxStopError(stop.error)) {
          logger.info("[agent-sandbox] Sandbox already absent during delete cleanup", {
            sandboxId,
            status: precheck.status,
            stopFailureKind,
            error: errorMessage,
          });
        } else {
          logger.warn("[agent-sandbox] Stop failed during delete", {
            sandboxId,
            status: precheck.status,
            stopFailureKind,
            error: errorMessage,
          });
          return { success: false, error: "Failed to delete sandbox" };
        }
      }
    }

    // The container is proven not running, so this generation hands its node slot back
    // — and does so BEFORE the steps that can still fail below (credential
    // revocation, the row-delete CAS, job-status persistence). Those failures
    // re-run this whole path; the CAS is what makes the second run a no-op
    // instead of a second decrement that frees a live sibling's slot (#17185).
    //
    // Unresolved teardown deliberately skips the release and keeps ownership.
    // A reachable stop failure returns above; a timeout or unreachable node
    // completes deletion but leaves the slot counted until the orphan
    // reconciler proves the container absent.
    if (containerProvenNotRunning && precheck.nodeId) {
      const release = await agentSandboxesRepository.tryReleaseDeletionAllocationForCommit(
        agentId,
        orgId,
        precheck.deletionAttemptId,
        precheck.nodeId,
        precheck.lifecycleRevision,
      );
      const outcome = release.outcome;
      if (release.lifecycleRevision !== null) {
        deletionOwnership = {
          ...deletionOwnership,
          lifecycleRevision: release.lifecycleRevision,
        };
      }
      // `not-owned` is the expected retry outcome and stays at info; only a
      // counter that failed to move while ownership WAS ours is an accounting
      // problem worth an operator's attention.
      const context = {
        outcome,
        agentId,
        nodeId: precheck.nodeId,
        deletionAttemptId: precheck.deletionAttemptId,
      };
      if (outcome === "counter-unchanged") {
        logger.warn("[agent-sandbox] Deletion node-slot release did not move the counter", context);
      } else {
        logger.info("[agent-sandbox] Deletion node-slot release", context);
      }
    }

    // Revoke both credential owners before deleting the row. The source-pool
    // id is durable recovery state for a claimed handoff; deleting first would
    // make a transient authoritative revocation failure impossible to retry.
    const credentialOwners = new Set(
      [agentId, precheck.sourcePoolId].filter((id): id is string => Boolean(id)),
    );
    for (const credentialOwnerId of credentialOwners) {
      await apiKeysService.revokeForAgent(credentialOwnerId);
    }

    // The ownership flag lives on the sandbox row, so unresolved teardown must
    // preserve that row as a terminal tombstone. The orphan reaper consumes the
    // flag after removing the immutable container ID; a later delete retry then
    // observes explicit absence and removes the tombstone. Deleting the row here
    // would erase the only proof that the node counter still includes this slot.
    let result: DeleteAgentResult;
    if (containerProvenNotRunning) {
      result = await this.commitAgentRowDelete(agentId, orgId, deletionOwnership);
    } else {
      if (!reconciliationReason) {
        throw new Error("Unresolved deletion is missing its reconciliation reason");
      }
      result = await this.commitAgentReconciliationPending(
        agentId,
        orgId,
        deletionOwnership,
        reconciliationReason,
      );
    }

    if (result.success && result.rowDeleted) {
      // Best-effort: drop the shared-runtime (Tier-0) conversation history for
      // this agent. That table is deliberately decoupled from the sandbox row
      // (no FK cascade), so the per-channel history rows would otherwise be
      // orphaned forever after the agent is gone. A failure here leaves stale
      // rows but never un-deletes the (already gone) sandbox.
      //
      // The channel list is recovered BEFORE the Postgres delete so it can also
      // drive the Durable Object purge below — each room's DO is named
      // `${agentId}:${channelId}` and keeps its own copy of the live
      // conversation window; without this step a deleted agent's conversation
      // content would persist indefinitely in DO storage (data-retention /
      // privacy gap, unbounded namespace growth).
      let channelIds: string[] = [];
      try {
        channelIds = await sharedRuntimeHistoryRepository.listChannelsByAgent(agentId);
        const removed = await sharedRuntimeHistoryRepository.deleteByAgent(agentId);
        if (removed > 0) {
          logger.info("[agent-sandbox] Cleaned up shared-runtime history after delete", {
            agentId,
            channelsRemoved: removed,
          });
        }
      } catch (err) {
        // error-policy:J6 the sandbox is already gone; failed history cleanup
        // leaves stale rows for a later sweep, never un-deletes the agent.
        logger.warn("[agent-sandbox] Failed to clean up shared-runtime history", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // #17006: purge each room's SharedRuntimeConversation Durable Object.
      // The DO copy is the live source of truth for the conversation window,
      // so dropping only the Postgres mirror above would leave the deleted
      // agent's conversation content resident in DO storage indefinitely. The
      // namespace binding exists only inside a Worker request (getCloudBinding
      // returns undefined in tests/node runtimes), and the purge is
      // best-effort per room: the deletion is already committed.
      if (channelIds.length > 0) {
        const conversations = getCloudBinding<RuntimeDurableObjectNamespace>(
          "SHARED_RUNTIME_CONVERSATIONS",
        );
        if (conversations && typeof conversations.getByName === "function") {
          try {
            const purge = await purgeSharedConversationRooms(agentId, channelIds, {
              namespace: conversations,
            });
            logger.info("[agent-sandbox] Purged shared-runtime conversation objects", {
              agentId,
              rooms: channelIds.length,
              ...purge,
            });
          } catch (err) {
            // error-policy:J6 the deletion is already committed; a purge
            // failure is teardown-only and must never fail the delete.
            logger.warn("[agent-sandbox] Shared-runtime conversation purge failed", {
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return result;
  }

  /** Whether this row carries a waiver for its current deletion generation. */
  hasCurrentPreDeleteCaptureWaiver(rec: AgentSandbox): boolean {
    return (
      rec.deletion_attempt_id !== null &&
      rec.pre_delete_capture_waiver_attempt_id === rec.deletion_attempt_id &&
      rec.pre_delete_capture_waiver_environment_revision === rec.environment_revision &&
      rec.pre_delete_capture_waiver_sandbox_id === rec.sandbox_id &&
      rec.pre_delete_capture_waiver_bridge_url !== null &&
      rec.pre_delete_capture_waiver_bridge_url === rec.bridge_url
    );
  }

  /**
   * Whether deleting this row must first prove a current backup (#18517).
   * Running rows always require proof. Error/disconnected rows require it when
   * they retain a container locator. A deletion continuation with no live
   * bridge requires it unless allocation ownership proves the row was already
   * stopped; this avoids mistaking a stopped row's retained `sandbox_id` for a
   * live container while still failing closed on ambiguous legacy intents.
   */
  requiresPreDeleteCapture(rec: AgentSandbox | null | undefined): rec is AgentSandbox {
    if (
      !rec ||
      rec.execution_tier === "shared" ||
      (rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed")
    ) {
      return false;
    }
    if (rec.status === "running") return true;
    const hasContainerLocator = Boolean(
      rec.sandbox_id || rec.node_id || rec.container_name || rec.bridge_url,
    );
    if (rec.status === "disconnected" || rec.status === "error") {
      return hasContainerLocator;
    }
    if (rec.status === "deletion_pending" || rec.status === "deletion_failed") {
      return (
        Boolean(rec.bridge_url) ||
        (rec.deletion_allocation_counted !== false && hasContainerLocator)
      );
    }
    return false;
  }

  /**
   * Phase 1 of `deleteAgent` (see there): short write transaction that takes
   * the lifecycle lock, validates delete preconditions, and captures the
   * sandbox id + status for the (out-of-transaction) teardown. Kept separate so
   * paid stop and refund commit before the separate destructive teardown.
   * Provider removal never runs under this transaction.
   */
  async prepareAgentDelete(
    agentId: string,
    orgId: string,
    authorization?: DeleteAuthorization,
    preDeleteCapture?: {
      snapshot: {
        stateData: AgentBackupStateData;
        sizeBytes: number;
        bridgeUrl: string;
      } | null;
      captureAuthority: SnapshotAuthorityCapture | null;
      captureWaiverGeneration: {
        bridgeUrl: string | null;
        environmentRevision: number;
        sandboxId: string | null;
      } | null;
      captureWaiverAlreadyPersisted: boolean;
      existingBackup: {
        id: string;
        deletionAttemptId: string;
      } | null;
    },
  ): Promise<
    | {
        ok: true;
        sandboxId: string | null;
        nodeId: string | null;
        status: AgentSandbox["status"];
        sourcePoolId: string | null;
        environmentRevision: number;
        lifecycleRevision: number;
        deletionAttemptId: string;
        deletionStartedAt: Date;
        preDeleteBackupId: string | null;
        deletionLocator: SandboxDeletionLocator | null;
      }
    | { ok: false; error: string }
  > {
    // The deletion intent this stamps includes `deletion_allocation_counted`,
    // which the provisioning worker can reach before its migration has run
    // (its deploy does not gate on migrate-db). Ensure is memoized, so the DDL
    // runs once per isolate rather than once per delete.
    await ensureAgentSandboxSchema();
    let purchasedCreditRefunded = false;
    const result = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);

      const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { ok: false as const, error: "Agent not found" };
      if (this.host.getReplacementCleanupLocator(rec)) {
        return {
          ok: false as const,
          error: "Agent replacement cleanup is still pending",
        };
      }

      const hasActiveProvisionJob = await this.host.hasActiveProvisionJobTx(tx, agentId, orgId);
      const hasActiveReplacementJob = await this.host.hasActiveReplacementJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob || hasActiveReplacementJob) {
        return { ok: false as const, error: "Agent provisioning is in progress" };
      }
      const isSharedRuntime = rec.execution_tier === "shared";
      const isUnclaimedWarmPoolEntry =
        rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed";
      if (
        rec.status === "running" &&
        !isSharedRuntime &&
        !isUnclaimedWarmPoolEntry &&
        !authorization
      ) {
        return {
          ok: false as const,
          error: "Agent is running; suspend it before deletion",
        };
      }
      let preDeleteBackupId: string | null = null;
      let captureWaiverToPersist: {
        bridgeUrl: string;
        environmentRevision: number;
        sandboxId: string | null;
      } | null = null;
      let snapshotToPersist: {
        stateData: AgentBackupStateData;
        sizeBytes: number;
      } | null = null;
      if (authorization !== "account_deletion" && this.requiresPreDeleteCapture(rec)) {
        const existingBackup = preDeleteCapture?.existingBackup ?? null;
        if (
          existingBackup &&
          rec.deletion_attempt_id === existingBackup.deletionAttemptId &&
          rec.deletion_started_at !== null &&
          (await agentSandboxesRepository.validateAttachedPreDeleteBackupForDeletion(tx, {
            backupId: existingBackup.id,
            sandboxRecordId: rec.id,
            deletionStartedAt: rec.deletion_started_at,
          }))
        ) {
          preDeleteBackupId = existingBackup.id;
        }

        const captureWaiverIsCurrent =
          preDeleteCapture?.captureWaiverAlreadyPersisted === true &&
          this.hasCurrentPreDeleteCaptureWaiver(rec);
        if (preDeleteBackupId === null && !captureWaiverIsCurrent) {
          const waiver = preDeleteCapture?.captureWaiverGeneration ?? null;
          const captureAuthority = preDeleteCapture?.captureAuthority ?? null;
          if (waiver) {
            if (!captureAuthority || !snapshotCaptureStillCanonical(rec, captureAuthority)) {
              return {
                ok: false as const,
                error:
                  "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
              };
            }
            // The database waiver shape intentionally records a concrete
            // bridge URL. An acknowledged retry whose bridge is already absent
            // is authorized by the durable job tuple and revalidated here, but
            // has no URL to persist.
            if (waiver.bridgeUrl !== null) {
              captureWaiverToPersist = {
                bridgeUrl: waiver.bridgeUrl,
                environmentRevision: waiver.environmentRevision,
                sandboxId: waiver.sandboxId,
              };
            }
          } else {
            const snapshot = preDeleteCapture?.snapshot ?? null;
            // The capture must be OF THIS exact generation (shutdown's rule).
            // Reusing a bridge URL does not make replacement compute the same
            // authority; every container identity and lifecycle field stays
            // fenced through the canonical comparator.
            if (
              !snapshot ||
              !captureAuthority ||
              !snapshotCaptureStillCanonical(rec, captureAuthority) ||
              rec.bridge_url !== snapshot.bridgeUrl
            ) {
              return {
                ok: false as const,
                error:
                  "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
              };
            }
            snapshotToPersist = snapshot;
          }
        }
      }

      const deletionAttemptId = rec.deletion_attempt_id ?? crypto.randomUUID();
      const deletionStartedAt = rec.deletion_started_at ?? new Date();
      // A retry preserves the original audit timestamp while taking a fresh
      // database generation for the new teardown attempt.
      //
      // Allocation ownership rides the same rule, for the same reason: a
      // continuation must inherit the original generation's recorded answer, not
      // re-derive it from a row this deletion has already moved to
      // `deletion_pending` — which would read as "still counted" forever and free
      // a live sibling's slot on every retry (#17185).
      const [owned] = await tx
        .update(agentSandboxes)
        .set({
          status: "deletion_pending",
          deletion_attempt_id: deletionAttemptId,
          ...(rec.deletion_started_at === null ? { deletion_started_at: deletionStartedAt } : {}),
          ...(isDeletionContinuation(rec)
            ? {}
            : { deletion_allocation_counted: holdsCountedNodeSlot(rec) }),
          ...(captureWaiverToPersist
            ? {
                pre_delete_capture_waiver_attempt_id: deletionAttemptId,
                pre_delete_capture_waiver_environment_revision:
                  captureWaiverToPersist.environmentRevision,
                pre_delete_capture_waiver_sandbox_id: captureWaiverToPersist.sandboxId,
                pre_delete_capture_waiver_bridge_url: captureWaiverToPersist.bridgeUrl,
              }
            : {}),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            sql`${agentSandboxes.replacement_cleanup_sandbox_id} IS NULL`,
          ),
        )
        .returning({
          id: agentSandboxes.id,
          deletionAttemptId: agentSandboxes.deletion_attempt_id,
          deletionStartedAt: agentSandboxes.deletion_started_at,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
        });
      if (!owned) {
        return { ok: false as const, error: "Agent deletion ownership changed" };
      }
      if (!owned.deletionAttemptId || !owned.deletionStartedAt) {
        throw new Error("Agent deletion intent was not persisted");
      }

      // The retention predicate deliberately requires a pre-delete backup to
      // be no older than this deletion intent. Persist only after the intent is
      // durable in the same transaction; otherwise the backup helper stamps
      // created_at first and the freshly captured row cannot be detached at
      // commit. The backup metadata update advances lifecycle_revision, so use
      // the post-trigger revision it returns as the ownership fence.
      let lifecycleRevision = owned.lifecycleRevision;
      if (snapshotToPersist) {
        const persisted = await this.host.persistSnapshotWithinTransaction(
          tx,
          rec.id,
          rec.organization_id,
          "pre-delete",
          snapshotToPersist.stateData,
          snapshotToPersist.sizeBytes,
        );
        preDeleteBackupId = persisted.backupId;
        lifecycleRevision = persisted.lifecycleRevision;
      }

      // Commit the stop receipt and refund before phase 2 destroys the container.
      // The existing deletion generation continues to own its capacity release.
      if (!isSharedRuntime && rec.pool_status === null) {
        const [window] = await tx
          .select()
          .from(agentComputeFunding)
          .where(
            and(
              eq(agentComputeFunding.agent_id, agentId),
              eq(agentComputeFunding.organization_id, orgId),
              isNull(agentComputeFunding.settled_at),
            ),
          )
          .for("update");
        if (window) {
          const identity = {
            agentId,
            organizationId: orgId,
            lifecycleRevision,
            fundingId: window.id,
          };
          const settled =
            window.provider_container_id === null
              ? await cancelUnboundAgentComputeInTransaction(tx, identity)
              : await stopFundedAgentInTransaction(tx, identity);
          if (!settled) throw new Error("Deletion lost its paid stop authority");
          purchasedCreditRefunded = settled.purchasedCreditRefunded;
          // The provider is now stopped. Cancelling a later failed delete must
          // not restore the queued intent's formerly-running state.
          const [stopped] = await tx
            .update(agentSandboxes)
            .set({ deletion_previous_status: null, updated_at: new Date() })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)))
            .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
          if (!stopped) throw new Error("Deletion lost its stopped generation");
          lifecycleRevision = stopped.lifecycleRevision;
        }
      }

      let deletionLocator: SandboxDeletionLocator | null = null;
      if (rec.sandbox_id && rec.node_id && rec.container_name) {
        const nodeAuthority = await tx.execute<{
          hostname: string;
          ssh_port: number;
          ssh_user: string;
          host_key_fingerprint: string | null;
        }>(sql`
          SELECT hostname, ssh_port, ssh_user, host_key_fingerprint
          FROM ${dockerNodes}
          WHERE node_id = ${rec.node_id}
          LIMIT 1
        `);
        const node = nodeAuthority.rows[0];
        deletionLocator = {
          sandboxId: rec.sandbox_id,
          agentId: rec.id,
          nodeId: rec.node_id,
          containerName: rec.container_name,
          ...(node
            ? {
                hostname: node.hostname,
                sshPort: node.ssh_port,
                sshUser: node.ssh_user,
                ...(node.host_key_fingerprint
                  ? { hostKeyFingerprint: node.host_key_fingerprint }
                  : {}),
              }
            : {}),
        };
      }

      return {
        ok: true as const,
        sandboxId: rec.sandbox_id,
        nodeId: rec.node_id,
        status: rec.status,
        sourcePoolId: rec.warm_claim_source_pool_id,
        environmentRevision: rec.environment_revision,
        lifecycleRevision,
        deletionAttemptId: owned.deletionAttemptId,
        deletionStartedAt: owned.deletionStartedAt,
        preDeleteBackupId,
        deletionLocator,
      };
    });
    if (result.ok && purchasedCreditRefunded) await creditsService.invalidateCreditCaches(orgId);
    return result;
  }

  /**
   * Phase 3 of `deleteAgent` (see there): short write transaction that re-takes
   * the lifecycle lock, re-validates (a concurrent provision could have started
   * while the out-of-transaction teardown ran), then deletes the sandbox row.
   */
  async commitAgentRowDelete(
    agentId: string,
    orgId: string,
    ownership: {
      sandboxId: string | null;
      environmentRevision: number;
      lifecycleRevision: number;
      deletionAttemptId: string;
      deletionStartedAt: Date;
      preDeleteBackupId: string | null;
    },
  ): Promise<DeleteAgentResult> {
    return dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);

      const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;
      if (this.host.getReplacementCleanupLocator(rec)) {
        return {
          success: false,
          error: "Agent replacement cleanup is still pending",
        } as const;
      }

      const hasActiveProvisionJob = await this.host.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (
        rec.status !== "deletion_pending" ||
        rec.deletion_attempt_id !== ownership.deletionAttemptId ||
        rec.sandbox_id !== ownership.sandboxId ||
        rec.environment_revision !== ownership.environmentRevision ||
        rec.lifecycle_revision !== ownership.lifecycleRevision ||
        hasActiveProvisionJob
      ) {
        return {
          success: false,
          error: "Agent deletion ownership changed",
        } as const;
      }

      if (ownership.preDeleteBackupId) {
        const retained = await agentSandboxesRepository.retainPreDeleteBackupForDeletedAgent(tx, {
          backupId: ownership.preDeleteBackupId,
          sandboxRecordId: agentId,
          organizationId: orgId,
          deletionAttemptId: ownership.deletionAttemptId,
          deletionStartedAt: ownership.deletionStartedAt,
          expiresAt: new Date(Date.now() + PRE_DELETE_BACKUP_RETENTION_MS),
        });
        if (!retained) {
          throw new ElizaError("Pre-delete recovery backup ownership changed", {
            code: "PRE_DELETE_BACKUP_RETENTION_LOST",
            context: {
              agentId,
              organizationId: orgId,
              deletionAttemptId: ownership.deletionAttemptId,
              backupId: ownership.preDeleteBackupId,
            },
            severity: "fatal",
          });
        }
      }

      const [deletedSandbox] = await tx
        .delete(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "deletion_pending"),
            eq(agentSandboxes.deletion_attempt_id, ownership.deletionAttemptId),
            sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${ownership.sandboxId}`,
            eq(agentSandboxes.environment_revision, ownership.environmentRevision),
            eq(agentSandboxes.lifecycle_revision, ownership.lifecycleRevision),
          ),
        )
        .returning();

      if (!deletedSandbox) {
        // Throwing rolls back the recovery detachment above; returning a
        // structured miss would commit an orphaned backup while retaining the
        // agent row, making the next retry unable to find its capture.
        throw new ElizaError("Agent row delete lost its lifecycle ownership", {
          code: "AGENT_DELETE_COMMIT_LOST",
          context: { agentId, organizationId: orgId, ...ownership },
          severity: "ephemeral",
        });
      }
      return { success: true, rowDeleted: true, deletedSandbox } as const;
    });
  }

  /**
   * Persists unresolved deletion as a terminal tombstone without spending its
   * capacity ownership. This completes the queue attempt promptly while keeping
   * the durable row the orphan reaper and low-frequency delete retry require.
   */
  async commitAgentReconciliationPending(
    agentId: string,
    orgId: string,
    ownership: {
      sandboxId: string | null;
      environmentRevision: number;
      lifecycleRevision: number;
      deletionAttemptId: string;
    },
    reason: string,
  ): Promise<DeleteAgentResult> {
    return dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);

      const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;
      if (this.host.getReplacementCleanupLocator(rec)) {
        return {
          success: false,
          error: "Agent replacement cleanup is still pending",
        } as const;
      }

      const hasActiveProvisionJob = await this.host.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (
        rec.status !== "deletion_pending" ||
        rec.deletion_attempt_id !== ownership.deletionAttemptId ||
        rec.sandbox_id !== ownership.sandboxId ||
        rec.environment_revision !== ownership.environmentRevision ||
        rec.lifecycle_revision !== ownership.lifecycleRevision ||
        hasActiveProvisionJob
      ) {
        return {
          success: false,
          error: "Agent deletion ownership changed",
        } as const;
      }

      const [pendingSandbox] = await tx
        .update(agentSandboxes)
        .set({
          status: "deletion_failed",
          error_message: `Deletion is awaiting container reconciliation: ${reason}`,
          error_count: sql`${agentSandboxes.error_count} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "deletion_pending"),
            eq(agentSandboxes.deletion_attempt_id, ownership.deletionAttemptId),
            sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${ownership.sandboxId}`,
            eq(agentSandboxes.environment_revision, ownership.environmentRevision),
            eq(agentSandboxes.lifecycle_revision, ownership.lifecycleRevision),
          ),
        )
        .returning();

      return pendingSandbox
        ? ({
            success: true,
            rowDeleted: false,
            reconciliationPending: true,
            deletedSandbox: pendingSandbox,
          } as const)
        : ({ success: false, error: "Agent not found" } as const);
    });
  }

  /**
   * Reverse a queued deletion while the container is still alive (#18517).
   * `deletion_pending` used to be a one-way door: cancelling the queued
   * `agent_delete` job stranded the row, and `reEnqueueFailedDeletions`
   * re-armed a fresh delete on every sweep. Run before teardown starts, this
   * atomically cancels the queued job(s) and returns the row to `running`
   * with its deletion-intent columns cleared, so the reconciler has nothing
   * left to re-arm. Refusals leave everything untouched: an executing delete
   * (job `in_progress`) may already be tearing the container down, and a row
   * whose bridge is gone has no live workload for `running` to describe.
   */
  async cancelAgentDeletion(
    agentId: string,
    orgId: string,
  ): Promise<{ success: boolean; error?: string }> {
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => this.cancelAgentDeletionTx(tx, agentId, orgId));
  }

  /** Transaction body of {@link cancelAgentDeletion}, separated so the
   *  deterministic suite can drive it against a fake lifecycle transaction. */
  async cancelAgentDeletionTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<{ success: boolean; error?: string }> {
    await this.host.lockLifecycle(tx, agentId, orgId);

    const rec = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" };
    if (rec.status !== "deletion_pending") {
      return {
        success: false,
        error: `Agent is not pending deletion (status: ${rec.status})`,
      };
    }
    const previousBillingStatus = rec.deletion_previous_billing_status;
    if (
      rec.deletion_previous_status !== "running" ||
      previousBillingStatus === null ||
      !["active", "warning", "suspended", "shutdown_pending", "exempt"].includes(
        previousBillingStatus,
      )
    ) {
      return {
        success: false,
        error: "Agent deletion does not have a reversible running-state receipt",
      };
    }
    // A running receipt plus a live bridge proves the workload still matches
    // the state being restored. Legacy deletion rows have no receipt and are
    // refused above; a missing bridge means teardown may already have begun.
    if (!rec.bridge_url) {
      return {
        success: false,
        error: "Agent container is no longer reachable; the deletion can only complete",
      };
    }
    const executing = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type = ${JOB_TYPES.AGENT_DELETE}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status = 'in_progress'
      LIMIT 1
    `);
    if (executing.rows.length > 0) {
      return { success: false, error: "Agent deletion is already executing" };
    }

    // Cancel queued (never claimed) delete jobs in the same transaction as the
    // row restore, so no window exists where a worker claims the job against a
    // row that is about to leave `deletion_pending`.
    await tx.execute(sql`
      UPDATE ${jobs}
      SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
      WHERE type = ${JOB_TYPES.AGENT_DELETE}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status = 'pending'
    `);

    // Restore the captured billing state, never a guessed healthy default. A
    // delete requested while billing was warning/suspended must not become a
    // billing bypass when it is cancelled. Clearing allocation ownership
    // withdraws the pending release-at-commit marker (#17185).
    const restored = await tx.execute<{ id: string }>(sql`
      UPDATE ${agentSandboxes}
      SET status = ${rec.deletion_previous_status},
          billing_status = ${previousBillingStatus},
          shutdown_warning_sent_at = ${rec.deletion_previous_shutdown_warning_sent_at},
          scheduled_shutdown_at = ${rec.deletion_previous_scheduled_shutdown_at},
          deletion_attempt_id = NULL,
          deletion_started_at = NULL,
          deletion_previous_status = NULL,
          deletion_previous_billing_status = NULL,
          deletion_previous_shutdown_warning_sent_at = NULL,
          deletion_previous_scheduled_shutdown_at = NULL,
          deletion_allocation_counted = NULL,
          error_count = 0,
          error_message = NULL,
          updated_at = NOW()
      WHERE id = ${agentId}
        AND organization_id = ${orgId}
        AND status = 'deletion_pending'
        AND deletion_attempt_id IS NOT DISTINCT FROM ${rec.deletion_attempt_id}
      RETURNING id
    `);
    if (restored.rows.length !== 1) {
      return { success: false, error: "Agent deletion ownership changed" };
    }

    logger.info("[agent-sandbox] Cancelled queued deletion; agent restored to running", {
      agentId,
      orgId,
    });
    return { success: true };
  }

  /**
   * Async-path counterpart to `deleteAgent`, invoked by the provisioning
   * worker daemon when it picks up an `agent_delete` job. Returns a
   * structured outcome the daemon stores in the job result so observers can
   * tell apart "container survived stop" (ops needed) from "row delete
   * failed" (probably retried by next attempt).
   *
   * Wraps `deleteAgent` so the SSH/DB sequence stays in one place,
   * but maps the return shape to what the queue handler expects and
   * tracks whether the container actually went down before the row was
   * removed. Unresolved teardown is terminal for this queue attempt but keeps a
   * reconciliation tombstone, so `rowDeleted` remains explicit in the result.
   */
  async executeDeletion(
    agentId: string,
    orgId: string,
    authorization?: DeleteAuthorization,
    stateLossAcknowledged?: boolean,
  ): Promise<{
    success: boolean;
    containerStopped: boolean;
    rowDeleted: boolean;
    error?: string;
    retryable?: true;
  }> {
    const cleanupSource = await this.host.getAgentForWrite(agentId, orgId);
    if (cleanupSource && this.host.getReplacementCleanupLocator(cleanupSource)) {
      try {
        await this.host.retirePersistedReplacementCleanup(agentId, orgId);
      } catch (error) {
        // error-policy:J1 deletion execution boundary — the exact replacement
        // locator remains durable and the queue retries without deleting the
        // serving generation until remote absence is proven.
        return {
          success: false,
          containerStopped: false,
          rowDeleted: false,
          retryable: true,
          error: `Replacement cleanup is still pending: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    const result = await this.deleteAgent(agentId, orgId, {
      authorization,
      stateLossAcknowledged,
    });
    if (!result.success) {
      // If the row is already gone, treat as success. This covers the retry
      // case where a prior attempt deleted the row but failed before updating
      // the job status to "completed", causing the runner to retry.
      if (result.error === "Agent not found") {
        return { success: true, containerStopped: true, rowDeleted: true };
      }
      return {
        success: false,
        containerStopped: false,
        rowDeleted: false,
        error: result.error,
        retryable: result.retryable,
      };
    }

    // Character deletion used to live in the HTTP DELETE handler. Now that
    // delete is async via the queue, the daemon owns this step so orphan
    // characters do not pile up when the deletion completes outside of an
    // HTTP request context. Best-effort: a failure here leaves an orphan
    // character but does not reverse the agent's logical deletion.
    //
    // Only once the sandbox row is actually gone. On the `deletion_failed`
    // tombstone path the row survives for the recovery sweep, and
    // `agent_sandboxes.character_id` is `onDelete: "set null"` — so deleting
    // the character here would strip the tombstone's identity while it is
    // still visible as an agent, leaving the sweep nothing to reconcile
    // against. Mirrors the shared-runtime history drop above, which already
    // gates on `result.rowDeleted`.
    const characterId = result.deletedSandbox.character_id;
    if (
      result.rowDeleted &&
      characterId &&
      !reusesExistingElizaCharacter(result.deletedSandbox.agent_config)
    ) {
      try {
        await userCharactersRepository.delete(characterId);
        logger.info("[agent-sandbox] Cleaned up linked character after delete", {
          agentId,
          characterId,
        });
      } catch (charErr) {
        logger.warn("[agent-sandbox] Linked character cleanup failed after delete", {
          agentId,
          characterId,
          error: charErr instanceof Error ? charErr.message : String(charErr),
        });
      }
    }

    return {
      success: true,
      containerStopped: result.rowDeleted,
      rowDeleted: result.rowDeleted,
    };
  }
}
