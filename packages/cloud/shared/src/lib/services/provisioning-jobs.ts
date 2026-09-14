/**
 * Async Provisioning Job Service
 *
 * Bridges the existing `jobs` table/repository with provisioning operations.
 * Instead of blocking HTTP requests for minutes, callers create a job and
 * return 202 immediately. A cron-based processor picks up pending jobs.
 *
 * Supported job types:
 * - agent_provision: Provision an Agent sandbox (managed DB + Docker container)
 *
 * Future:
 * - wallet_provision: Server wallet provisioning
 * - agent_restore: Restore from backup
 */

import { getDedicatedComputePriceAcceptance } from "@elizaos/cloud-sdk/browser-contracts";
import { ElizaError } from "@elizaos/core";
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { ensureAgentSandboxSchema } from "../../db/ensure-agent-sandbox-schema";
import { dbWrite } from "../../db/helpers";
import { updateAgentLifecycleExecutionFence } from "../../db/repositories/agent-lifecycle-execution-fence";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import {
  cutoverResumeWindowAllows,
  hydrateJob,
  type Job,
  type JobRecoveryFailure,
  type JobRecoverySweepResult,
  jobsRepository,
  msWindowTimestampMatch,
  type NewJob,
  prepareJobInsertData,
  type RecoveryFailureWritebackBuilder,
  StaleJobExecutionError,
} from "../../db/repositories/jobs";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import {
  type AgentBillingStatus,
  type AgentExecutionTier,
  type AgentSandboxPoolStatus,
  type AgentSandboxStatus,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  UPGRADE_FAILURE_TARGET_MARKER_PREFIX,
  WARM_POOL_ORG_ID,
} from "../../db/schemas/agent-sandboxes";
import { apps } from "../../db/schemas/apps";
import { billingCancelCommands } from "../../db/schemas/billing-cancel-commands";
import { containers } from "../../db/schemas/containers";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { jobs } from "../../db/schemas/jobs";
import { ApiError } from "../api/cloud-worker-errors";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import { safeFetch } from "../security/safe-fetch";
import { logger } from "../utils/logger";
import { isValidUUID } from "../utils/validation";
import { OperationTimeoutError, withTimeout } from "../utils/with-timeout";
import { AccountLifecycleFencedError } from "./account-lifecycle-authority";
import {
  ADMIN_CANARY_MAX_RUNNING_JOBS,
  ADMIN_CANARY_MAX_TARGETS,
  type AdminCanaryImageJobData,
  type AdminCanaryImageJobResult,
  type AdminCanaryPlannedTarget,
  assertAdminCanaryImageJobData,
  assertRecoverableAdminCanaryImageJobData,
  isAdminCanaryImageJobData,
  isPendingAdminCanaryCutoverAudit,
} from "./admin-canary-image";
import {
  executeAgentComputeLeaseJob,
  readAgentComputeLeaseJobData,
} from "./agent-compute-lease-jobs";
import {
  AppCacheInvalidationRetryError,
  dispatchAppCacheInvalidationJob,
  enqueueAppCacheInvalidation,
  formatAppCacheInvalidationError,
} from "./app-cache-invalidation-job";
import { dispatchAppDbDeprovisionJob } from "./app-db-deprovision-job-service";
import { dispatchAppDeployJob, readAppDeployJobData } from "./app-deploy-job-service";
import {
  APP_DEPLOYMENT_GENERATION_KEY,
  deploymentGenerationFromMetadata,
} from "./app-deployment-generation";
import { dispatchContainerJob, getContainerExecutorDeps } from "./container-job-service";
import { readContainerProvisionJobData } from "./container-jobs-data";
import { dispatchContainerStopJob } from "./container-stop-job-service";
import { holdsCountedNodeSlot, isDeletionContinuation } from "./docker-node-workload-queries";
import {
  configureElizaLifecycleTransaction,
  elizaAdminCanaryRolloutAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import {
  AdminCanaryCleanupExpectationError,
  assertReviewedFreshBootAuthority,
  assertReviewedProvisionRestoreAuthority,
  type DeleteAuthorization,
  elizaSandboxService,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
} from "./eliza-sandbox";
import { finalizeJobErrorText, jobErrorSummary, jobErrorText } from "./job-error-text";
import {
  isPersonalDedicatedReviewedBackupChain,
  type PersonalDedicatedReviewedBackupChainEntry,
} from "./personal-dedicated-adoption-provenance";
import {
  acquireProviderAdmission,
  type ProviderAdmissionAuthority,
  releaseProviderAdmission,
} from "./provider-admission";
import {
  executeProvisioningWithAccountLifecycleAdmission,
  prepareProvisioningWithAccountLifecycleFence,
} from "./provisioning-account-lifecycle-fence";
import {
  AGENT_JOB_TYPES,
  COLD_BOOT_JOB_TYPES,
  COLD_BOOT_STALE_JOB_THRESHOLD_MS,
  DEFAULT_STALE_JOB_THRESHOLD_MS,
  EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES,
  JOB_TYPES,
  type ProvisioningJobType,
  requiresContainerBackedTarget,
} from "./provisioning-job-types";
import { sendProvisioningWorkerAlert } from "./provisioning-worker-health-monitor";
import { usesLocalDockerSandboxProvider } from "./sandbox-provider";
import {
  isWaifuWebhookTargetUrl,
  resolveWaifuWebhookTarget,
  signWaifuWebhook,
} from "./waifu-webhook";
import {
  WakeRestoreIntegrityError,
  type WakeRestoreIntegrityFailure,
} from "./wake-restore-integrity";
import { hasReadyWarmClaimCredential } from "./warm-claim-key-push";

/** Match a known failure type without trusting a thrown Proxy's prototype trap. */
function safeErrorKind<T extends Error>(
  value: unknown,
  errorClass: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof errorClass;
  } catch {
    // error-policy:J3 hostile thrown value; treat it as an ordinary failure so
    // the job still reaches its durable retry/failure transition.
    return false;
  }
}

const CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE =
  "Agent job requires a container-backed execution tier";
const PRICED_AGENT_START_JOB_TYPES: readonly string[] = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
];
export const CONTAINER_BACKED_TARGET_REJECTION_REASON = "agent_job_target_not_container_backed";

function isContainerBackedExecutionTier(tier: AgentExecutionTier): boolean {
  return (CONTAINER_BACKED_EXECUTION_TIERS as readonly AgentExecutionTier[]).includes(tier);
}

/** Domain rejection that must terminate the exact claim without ordinary retry handling. */
class RejectedAgentExecutionError extends ElizaError {
  override readonly name = "RejectedAgentExecutionError";

  constructor(
    message: string,
    context: {
      jobId: string;
      jobType: string;
      columnAgentId: string | null;
      columnOrganizationId: string;
      payloadAgentId?: string | null;
      payloadOrganizationId?: string | null;
      executionTier?: string;
      cause?: string;
    },
  ) {
    super(message, {
      code: "PROVISIONING_JOB_TARGET_REJECTED",
      context,
      severity: "fatal",
    });
  }
}

/**
 * Phase 0 fleet measurement emitted by every scheduled-backup sweep (#15783):
 * of the running non-pool fleet, how many rows are route-less (no bridge or
 * the loopback sentinel), snapshot-incapable (image 404s POST /api/snapshot),
 * never backed up, or older than the staleness threshold — split out for
 * local-state agents, whose whole state lives on one node's disk.
 */
export interface ScheduledBackupFleetReport {
  running: number;
  routeless: number;
  snapshotUnsupported: number;
  neverBackedUp: number;
  staleBackup: number;
  localState: number;
  localStateStale: number;
}

const EMPTY_SCHEDULED_BACKUP_FLEET_REPORT: ScheduledBackupFleetReport = {
  running: 0,
  routeless: 0,
  snapshotUnsupported: 0,
  neverBackedUp: 0,
  staleBackup: 0,
  localState: 0,
  localStateStale: 0,
};

// ---------------------------------------------------------------------------
// Job data shapes (hydrated from object storage when jobs.data is offloaded)
// ---------------------------------------------------------------------------

export interface AgentProvisionJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  agentName: string;
  restoreDirective?:
    | { kind: "from-backup"; backupId: string }
    | { kind: "fresh-boot" }
    | { kind: "reviewed-fresh-boot"; selectionId: string }
    | {
        kind: "from-reviewed-backup";
        selectionId: string;
        backupId: string;
        expectedContentHash: string;
        expectedBackupChain: PersonalDedicatedReviewedBackupChainEntry[];
      };
}

export interface AgentDeleteJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  authorization?: DeleteAuthorization;
  /** Explicit customer/operator acceptance that the current live delta may be lost. */
  stateLossAcknowledged?: boolean;
  /** First authenticated user who supplied the acknowledgement. */
  stateLossAcknowledgedByUserId?: string;
  /** Server timestamp for the first durable acknowledgement. */
  stateLossAcknowledgedAt?: string;
}

export interface AgentSuspendJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  authorization: "user_request" | "billing_request";
  /** Exact sandbox generation captured by the durable stop intent. */
  lifecycleRevision?: number;
}

type PersistedAgentSuspendJobData = Omit<AgentSuspendJobData, "authorization"> & {
  authorization?: AgentSuspendJobData["authorization"];
};

export interface AgentResumeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentSleepJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentWakeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  /**
   * Explicit user-selected restore point (an older validated backup) — the
   * escape hatch when the latest backup fails the wake integrity gate. Never
   * set by default; mutually exclusive with `forceFreshBoot`.
   */
  restoreBackupId?: string;
  /**
   * Explicit user acceptance of data loss: wake into an empty container with
   * no restore. Never set by default; mutually exclusive with `restoreBackupId`.
   */
  forceFreshBoot?: boolean;
}

export interface AgentRestartJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  /**
   * Operator-acknowledged state loss (#18228): the pre-stop capture is waived
   * when it fails, so the restart can free an agent whose snapshot transfer
   * persistently fails. Never set by default; requires an explicit request.
   */
  stateLossAcknowledged?: boolean;
}

export interface AgentUpgradeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  /** Configured image tag/ref that the reconciler resolved. */
  dockerImage: string;
  /** sha256 the agent is currently on (null if it predates digest tracking). */
  fromDigest: string | null;
  /** sha256 the reconciler resolved from the configured tag at enqueue time. */
  toDigest: string;
}

export interface AgentDowngradeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  /** Configured image tag/ref (must match the agent's `docker_image`). */
  dockerImage: string;
  /** sha256 the agent is currently on — the rollback precondition guard. */
  fromDigest: string;
}

export interface AgentUpgradeJobResult {
  oldNodeId: string;
  oldContainerName: string;
  newNodeId: string;
  newContainerName: string;
  newDigest: string;
  durationMs: number;
}

export interface AgentDowngradeJobResult {
  oldNodeId: string;
  oldContainerName: string;
  newNodeId: string;
  newContainerName: string;
  /** The `previous_image_digest` the agent was rolled back onto. */
  newDigest: string;
  durationMs: number;
}

export interface AgentLogsJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  tail: number;
}

export interface AgentMessageJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  text: string;
  senderId?: string;
  sessionId?: string;
  roomId?: string;
  /** Per-turn nonce so each chat message enqueues a fresh job (no dedupe). */
  nonce: string;
}

export interface AgentSnapshotJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  snapshotType: "manual" | "auto";
}

// ---------------------------------------------------------------------------
// Job result shapes (stored in jobs.result JSONB)
// ---------------------------------------------------------------------------

export interface AgentProvisionJobResult {
  cloudAgentId: string;
  status: string;
  bridgeUrl?: string;
  healthUrl?: string;
  error?: string;
}

export interface AgentDeleteJobResult {
  cloudAgentId: string;
  containerStopped: boolean;
  rowDeleted: boolean;
  /** The caller explicitly accepted loss of uncaptured state for this delete. */
  stateLossAcknowledged?: true;
  /** Durable actor provenance for the explicit acknowledgement, when known. */
  stateLossAcknowledgedByUserId?: string;
  /** Durable server timestamp for the explicit acknowledgement, when known. */
  stateLossAcknowledgedAt?: string;
  error?: string;
  /** Free (attempt-preserving) requeues this delete has spent waiting for a
   *  transient pre-deletion capture. Persisted on the job result because
   *  `retryLaterWithoutIncrementingAttempts` deliberately leaves `attempts`
   *  untouched, so this is the only record that bounds the loop. */
  captureRetryCount?: number;
}

export interface AgentSuspendJobResult {
  cloudAgentId: string;
  containerStopped: boolean;
  /** Backup proven or captured by the pre-suspend gate before the stop. */
  backupId?: string;
  /** Terminal success that intentionally made no provider mutation. */
  skipped?: true;
  /** Stable machine-readable explanation for a terminal no-op. */
  reason?: "lifecycle_changed" | "stop_intent_superseded" | "billing_recovered";
  error?: string;
}

export interface AgentResumeJobResult {
  cloudAgentId: string;
  containerStarted: boolean;
  reprovisioned: boolean;
  error?: string;
}

export interface AgentSleepJobResult {
  cloudAgentId: string;
  containerRemoved: boolean;
  backupId?: string;
  error?: string;
}

export interface AgentWakeJobResult {
  cloudAgentId: string;
  reprovisioned: boolean;
  restoredBackupId?: string;
  /** True when the wake booted empty via the explicit `forceFreshBoot` opt-in. */
  freshBoot?: boolean;
  /** Structured wake-integrity-gate failure, surfaced to job pollers. */
  integrityFailure?: WakeRestoreIntegrityFailure;
  error?: string;
}

export interface AgentRestartJobResult {
  cloudAgentId: string;
  containerStopped: boolean;
  containerStarted: boolean;
  bridgeUrl?: string;
  healthUrl?: string;
  error?: string;
}

export interface AgentLogsJobResult {
  cloudAgentId: string;
  status: string;
  tail: number;
  logs?: string;
  message?: string;
  error?: string;
}

export interface AgentMessageJobResult {
  cloudAgentId: string;
  /** Reply text from the agent (empty when the agent produced no reply). */
  text?: string;
  /** Surfaced when the bridge could not produce a reply. */
  reason?: string;
  error?: string;
}

export interface AgentSnapshotJobResult {
  cloudAgentId: string;
  backupId?: string;
  snapshotType?: string;
  sizeBytes?: number;
  createdAt?: string;
  error?: string;
  /** True when an auto snapshot was a terminal no-op (agent had no live state). */
  skipped?: boolean;
  /** Human-readable reason for a skip (e.g. "Sandbox is not running"). */
  reason?: string;
}

function agentProvisionJobDataToRecord(data: AgentProvisionJobData): Record<string, unknown> {
  return { ...data };
}

function agentProvisionJobResultToRecord(result: AgentProvisionJobResult): Record<string, unknown> {
  return { ...result };
}

const REPLACEMENT_CLEANUP_ONLY_PREFIX = "Replacement cleanup is still pending: ";
const REPLACEMENT_CLEANUP_CAUSE_SEPARATOR = "; replacement cleanup remains pending: ";

/** Keep the first startup failure when later free retries only re-attempt cleanup. */
function preserveProvisionFailureAcrossCleanupRetry(
  priorResult: unknown,
  currentError: string,
): string {
  if (!currentError.startsWith(REPLACEMENT_CLEANUP_ONLY_PREFIX)) return currentError;
  if (!priorResult || typeof priorResult !== "object" || Array.isArray(priorResult)) {
    return currentError;
  }
  const priorError = (priorResult as { error?: unknown }).error;
  if (
    typeof priorError !== "string" ||
    priorError.length === 0 ||
    priorError.startsWith(REPLACEMENT_CLEANUP_ONLY_PREFIX)
  ) {
    return currentError;
  }
  const separatorIndex = priorError.indexOf(REPLACEMENT_CLEANUP_CAUSE_SEPARATOR);
  const primaryError = separatorIndex >= 0 ? priorError.slice(0, separatorIndex) : priorError;
  return `${primaryError}${REPLACEMENT_CLEANUP_CAUSE_SEPARATOR}${currentError.slice(
    REPLACEMENT_CLEANUP_ONLY_PREFIX.length,
  )}`;
}

function agentDeleteJobDataToRecord(data: AgentDeleteJobData): Record<string, unknown> {
  return { ...data };
}

function agentDeleteJobResultToRecord(result: AgentDeleteJobResult): Record<string, unknown> {
  return { ...result };
}

/**
 * Reads the free-requeue tally off a persisted agent_delete result. The stored
 * value is untrusted JSON, so anything that is not a non-negative integer reads
 * as zero rather than as a fabricated budget.
 */
function readAgentDeleteCaptureRetryCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const value = (result as { captureRetryCount?: unknown }).captureRetryCount;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function agentSuspendJobDataToRecord(data: AgentSuspendJobData): Record<string, unknown> {
  return { ...data };
}

function agentSuspendJobResultToRecord(result: AgentSuspendJobResult): Record<string, unknown> {
  return { ...result };
}

function agentResumeJobDataToRecord(data: AgentResumeJobData): Record<string, unknown> {
  return { ...data };
}

function agentResumeJobResultToRecord(result: AgentResumeJobResult): Record<string, unknown> {
  return { ...result };
}

function agentSleepJobDataToRecord(data: AgentSleepJobData): Record<string, unknown> {
  return { ...data };
}

function agentSleepJobResultToRecord(result: AgentSleepJobResult): Record<string, unknown> {
  return { ...result };
}

function agentWakeJobDataToRecord(data: AgentWakeJobData): Record<string, unknown> {
  return { ...data };
}

function agentWakeJobResultToRecord(result: AgentWakeJobResult): Record<string, unknown> {
  return { ...result };
}

function agentRestartJobDataToRecord(data: AgentRestartJobData): Record<string, unknown> {
  return { ...data };
}

function agentRestartJobResultToRecord(result: AgentRestartJobResult): Record<string, unknown> {
  return { ...result };
}

function agentUpgradeJobDataToRecord(data: AgentUpgradeJobData): Record<string, unknown> {
  return { ...data };
}

function agentUpgradeJobResultToRecord(result: AgentUpgradeJobResult): Record<string, unknown> {
  return { ...result };
}

function adminCanaryImageJobDataToRecord(data: AdminCanaryImageJobData): Record<string, unknown> {
  return { ...data };
}

function adminCanaryImageJobResultToRecord(
  result: AdminCanaryImageJobResult,
): Record<string, unknown> {
  return { ...result };
}

function jobAuditTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function agentDowngradeJobDataToRecord(data: AgentDowngradeJobData): Record<string, unknown> {
  return { ...data };
}

function agentDowngradeJobResultToRecord(result: AgentDowngradeJobResult): Record<string, unknown> {
  return { ...result };
}

function agentLogsJobDataToRecord(data: AgentLogsJobData): Record<string, unknown> {
  return { ...data };
}

function agentLogsJobResultToRecord(result: AgentLogsJobResult): Record<string, unknown> {
  return { ...result };
}

function agentMessageJobDataToRecord(data: AgentMessageJobData): Record<string, unknown> {
  return { ...data };
}

function agentMessageJobResultToRecord(result: AgentMessageJobResult): Record<string, unknown> {
  return { ...result };
}

function agentSnapshotJobDataToRecord(data: AgentSnapshotJobData): Record<string, unknown> {
  return { ...data };
}

function agentSnapshotJobResultToRecord(result: AgentSnapshotJobResult): Record<string, unknown> {
  return { ...result };
}

function isAgentProvisionJobData(value: unknown): value is AgentProvisionJobData {
  const restoreDirective =
    typeof value === "object" && value !== null
      ? (value as { restoreDirective?: unknown }).restoreDirective
      : undefined;
  const validRestoreDirective =
    restoreDirective === undefined ||
    (typeof restoreDirective === "object" &&
      restoreDirective !== null &&
      (((restoreDirective as { kind?: unknown }).kind === "fresh-boot" &&
        !("backupId" in restoreDirective)) ||
        ((restoreDirective as { kind?: unknown }).kind === "reviewed-fresh-boot" &&
          typeof (restoreDirective as { selectionId?: unknown }).selectionId === "string") ||
        ((restoreDirective as { kind?: unknown }).kind === "from-backup" &&
          typeof (restoreDirective as { backupId?: unknown }).backupId === "string") ||
        ((restoreDirective as { kind?: unknown }).kind === "from-reviewed-backup" &&
          typeof (restoreDirective as { selectionId?: unknown }).selectionId === "string" &&
          typeof (restoreDirective as { backupId?: unknown }).backupId === "string" &&
          typeof (restoreDirective as { expectedContentHash?: unknown }).expectedContentHash ===
            "string" &&
          /^[a-f0-9]{64}$/.test(
            (restoreDirective as { expectedContentHash: string }).expectedContentHash,
          ) &&
          isPersonalDedicatedReviewedBackupChain(
            (restoreDirective as { expectedBackupChain?: unknown }).expectedBackupChain,
          ))));
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { agentName?: unknown }).agentName === "string" &&
    validRestoreDirective
  );
}

function isAgentDeleteJobData(value: unknown): value is AgentDeleteJobData {
  const authorization =
    typeof value === "object" && value !== null
      ? (value as { authorization?: unknown }).authorization
      : undefined;
  const stateLossAcknowledged =
    typeof value === "object" && value !== null
      ? (value as { stateLossAcknowledged?: unknown }).stateLossAcknowledged
      : undefined;
  const acknowledgedByUserId =
    typeof value === "object" && value !== null
      ? (value as { stateLossAcknowledgedByUserId?: unknown }).stateLossAcknowledgedByUserId
      : undefined;
  const acknowledgedAt =
    typeof value === "object" && value !== null
      ? (value as { stateLossAcknowledgedAt?: unknown }).stateLossAcknowledgedAt
      : undefined;
  const provenanceAbsent = acknowledgedByUserId === undefined && acknowledgedAt === undefined;
  const provenanceComplete =
    typeof acknowledgedByUserId === "string" &&
    acknowledgedByUserId.length > 0 &&
    typeof acknowledgedAt === "string" &&
    Number.isFinite(Date.parse(acknowledgedAt)) &&
    new Date(acknowledgedAt).toISOString() === acknowledgedAt;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (authorization === undefined ||
      authorization === "user_request" ||
      authorization === "billing_request") &&
    (stateLossAcknowledged === undefined || typeof stateLossAcknowledged === "boolean") &&
    (stateLossAcknowledged === true ? provenanceAbsent || provenanceComplete : provenanceAbsent)
  );
}

function agentDeleteAuthorityResult(
  data: AgentDeleteJobData,
): Pick<
  AgentDeleteJobResult,
  "stateLossAcknowledged" | "stateLossAcknowledgedByUserId" | "stateLossAcknowledgedAt"
> {
  if (!hasCompleteAgentDeleteAuthority(data)) return {};
  return {
    stateLossAcknowledged: true,
    stateLossAcknowledgedByUserId: data.stateLossAcknowledgedByUserId,
    stateLossAcknowledgedAt: data.stateLossAcknowledgedAt,
  };
}

function hasCompleteAgentDeleteAuthority(
  data: AgentDeleteJobData | undefined,
): data is AgentDeleteJobData & {
  stateLossAcknowledged: true;
  stateLossAcknowledgedByUserId: string;
  stateLossAcknowledgedAt: string;
} {
  if (
    data?.stateLossAcknowledged !== true ||
    typeof data.stateLossAcknowledgedByUserId !== "string" ||
    data.stateLossAcknowledgedByUserId.length === 0 ||
    typeof data.stateLossAcknowledgedAt !== "string"
  ) {
    return false;
  }
  const timestamp = Date.parse(data.stateLossAcknowledgedAt);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === data.stateLossAcknowledgedAt
  );
}

/** CAS the three authority fields together so settlement cannot miss an upgrade. */
function agentDeleteAuthorityFence(data: AgentDeleteJobData): SQL {
  return sql`
    COALESCE(${jobs.data}->>'stateLossAcknowledged', '') = ${
      data.stateLossAcknowledged === undefined ? "" : String(data.stateLossAcknowledged)
    }
    AND COALESCE(${jobs.data}->>'stateLossAcknowledgedByUserId', '') = ${
      data.stateLossAcknowledgedByUserId ?? ""
    }
    AND COALESCE(${jobs.data}->>'stateLossAcknowledgedAt', '') = ${
      data.stateLossAcknowledgedAt ?? ""
    }
  `;
}

function readAgentProvisionJobData(job: Job): AgentProvisionJobData {
  if (!isAgentProvisionJobData(job.data)) {
    throw new Error(`Invalid agent provision job data for job ${job.id}`);
  }
  return job.data;
}

function sameProvisionRestoreDirective(
  left: AgentProvisionJobData["restoreDirective"],
  right: AgentProvisionJobData["restoreDirective"],
): boolean {
  if (left?.kind !== right?.kind) return false;
  if (left?.kind === "from-backup" && right?.kind === "from-backup") {
    return left.backupId === right.backupId;
  }
  if (left?.kind === "from-reviewed-backup" && right?.kind === "from-reviewed-backup") {
    return (
      left.selectionId === right.selectionId &&
      left.backupId === right.backupId &&
      left.expectedContentHash === right.expectedContentHash &&
      JSON.stringify(left.expectedBackupChain) === JSON.stringify(right.expectedBackupChain)
    );
  }
  if (left?.kind === "reviewed-fresh-boot" && right?.kind === "reviewed-fresh-boot") {
    return left.selectionId === right.selectionId;
  }
  return true;
}

/**
 * Revalidate the immutable payload authority selected before the asynchronous
 * worker may cross into provider compute. The backup row is deliberately read
 * at execution time: a verifier downgrade, reassignment, deletion, or digest
 * change after quote/adoption must fail without calling the sandbox provider.
 */
export async function resolveReviewedProvisionRestoreDirectiveForExecution(
  data: AgentProvisionJobData,
): Promise<AgentProvisionJobData["restoreDirective"]> {
  const directive = data.restoreDirective;
  if (directive?.kind === "from-reviewed-backup") {
    await assertReviewedProvisionRestoreAuthority(data.agentId, directive);
  } else if (directive?.kind === "reviewed-fresh-boot") {
    await assertReviewedFreshBootAuthority(data.agentId, directive);
  } else {
    return directive;
  }
  return directive;
}

function readAgentDeleteJobData(job: Job): AgentDeleteJobData {
  if (!isAgentDeleteJobData(job.data)) {
    throw new Error(`Invalid agent delete job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentSuspendJobData(value: unknown): value is PersistedAgentSuspendJobData {
  const authorization = (value as { authorization?: unknown } | null)?.authorization;
  const lifecycleRevision = (value as { lifecycleRevision?: unknown } | null)?.lifecycleRevision;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (authorization === undefined ||
      authorization === "user_request" ||
      authorization === "billing_request") &&
    (lifecycleRevision === undefined ||
      (typeof lifecycleRevision === "number" &&
        Number.isSafeInteger(lifecycleRevision) &&
        lifecycleRevision >= 0))
  );
}

function readAgentSuspendJobData(job: Job): PersistedAgentSuspendJobData {
  if (!isAgentSuspendJobData(job.data)) {
    throw new Error(`Invalid agent suspend job data for job ${job.id}`);
  }
  return job.data;
}

interface ResolvedAgentSuspendAuthority {
  authorization: AgentSuspendJobData["authorization"];
  lifecycleRevision?: number;
  intentBound: boolean;
}

/**
 * Resolve modern jobs from their exact durable intent. Legacy user-request
 * jobs predate intent binding, so their inline authorization remains a
 * compatibility fallback only.
 */
async function resolveAgentSuspendAuthority(job: Job): Promise<ResolvedAgentSuspendAuthority> {
  const data = readAgentSuspendJobData(job);
  const [boundIntent] = await dbWrite
    .select({
      authorization: agentComputeStopIntents.authorization,
      lifecycleRevision: agentComputeStopIntents.lifecycle_revision,
    })
    .from(agentComputeStopIntents)
    .where(
      and(
        eq(agentComputeStopIntents.organization_id, job.organization_id),
        eq(agentComputeStopIntents.agent_id, data.agentId),
        eq(agentComputeStopIntents.job_id, job.id),
      ),
    )
    .limit(1);
  if (boundIntent) {
    return {
      authorization: boundIntent.authorization,
      lifecycleRevision: boundIntent.lifecycleRevision,
      intentBound: true,
    };
  }
  return {
    authorization: data.authorization ?? "user_request",
    lifecycleRevision: data.lifecycleRevision,
    intentBound: false,
  };
}

/** Resolve pre-authority suspend jobs without changing the public helper contract. */
export async function resolveAgentSuspendAuthorization(
  job: Job,
): Promise<AgentSuspendJobData["authorization"]> {
  return (await resolveAgentSuspendAuthority(job)).authorization;
}

function isAgentResumeJobData(value: unknown): value is AgentResumeJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentResumeJobData(job: Job): AgentResumeJobData {
  if (!isAgentResumeJobData(job.data)) {
    throw new Error(`Invalid agent resume job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentSleepJobData(value: unknown): value is AgentSleepJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentSleepJobData(job: Job): AgentSleepJobData {
  if (!isAgentSleepJobData(job.data)) {
    throw new Error(`Invalid agent sleep job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentWakeJobData(value: unknown): value is AgentWakeJobData {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { agentId?: unknown }).agentId !== "string" ||
    typeof (value as { organizationId?: unknown }).organizationId !== "string" ||
    typeof (value as { userId?: unknown }).userId !== "string"
  ) {
    return false;
  }
  const { restoreBackupId, forceFreshBoot } = value as {
    restoreBackupId?: unknown;
    forceFreshBoot?: unknown;
  };
  return (
    (restoreBackupId === undefined || typeof restoreBackupId === "string") &&
    (forceFreshBoot === undefined || typeof forceFreshBoot === "boolean")
  );
}

function readAgentWakeJobData(job: Job): AgentWakeJobData {
  if (!isAgentWakeJobData(job.data)) {
    throw new Error(`Invalid agent wake job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentRestartJobData(value: unknown): value is AgentRestartJobData {
  const stateLossAcknowledged = (value as { stateLossAcknowledged?: unknown })
    ?.stateLossAcknowledged;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (stateLossAcknowledged === undefined || typeof stateLossAcknowledged === "boolean")
  );
}

function readAgentRestartJobData(job: Job): AgentRestartJobData {
  if (!isAgentRestartJobData(job.data)) {
    throw new Error(`Invalid agent restart job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentUpgradeJobData(value: unknown): value is AgentUpgradeJobData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agentId === "string" &&
    typeof v.organizationId === "string" &&
    typeof v.userId === "string" &&
    typeof v.dockerImage === "string" &&
    (v.fromDigest === null || typeof v.fromDigest === "string") &&
    typeof v.toDigest === "string"
  );
}

export function readAgentUpgradeJobData(job: Job): AgentUpgradeJobData {
  if (!isAgentUpgradeJobData(job.data)) {
    throw new Error(`Invalid agent upgrade job data for job ${job.id}`);
  }
  return job.data;
}

export function readAdminCanaryImageJobData(job: Job): AdminCanaryImageJobData {
  if (!isAdminCanaryImageJobData(job.data)) {
    throw new Error(`Invalid admin canary image job data for job ${job.id}`);
  }
  assertAdminCanaryImageJobData(job.data);
  return job.data;
}

function isAgentDowngradeJobData(value: unknown): value is AgentDowngradeJobData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agentId === "string" &&
    typeof v.organizationId === "string" &&
    typeof v.userId === "string" &&
    typeof v.dockerImage === "string" &&
    typeof v.fromDigest === "string"
  );
}

export function readAgentDowngradeJobData(job: Job): AgentDowngradeJobData {
  if (!isAgentDowngradeJobData(job.data)) {
    throw new Error(`Invalid agent downgrade job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentLogsJobData(value: unknown): value is AgentLogsJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { tail?: unknown }).tail === "number"
  );
}

function readAgentLogsJobData(job: Job): AgentLogsJobData {
  if (!isAgentLogsJobData(job.data)) {
    throw new Error(`Invalid agent logs job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentMessageJobData(value: unknown): value is AgentMessageJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { text?: unknown }).text === "string" &&
    typeof (value as { nonce?: unknown }).nonce === "string"
  );
}

function readAgentMessageJobData(job: Job): AgentMessageJobData {
  if (!isAgentMessageJobData(job.data)) {
    throw new Error(`Invalid agent message job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentSnapshotJobData(value: unknown): value is AgentSnapshotJobData {
  if (typeof value !== "object" || value === null) return false;
  const snapshotType = (value as { snapshotType?: unknown }).snapshotType;
  return (
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (snapshotType === "manual" || snapshotType === "auto")
  );
}

function readAgentSnapshotJobData(job: Job): AgentSnapshotJobData {
  if (!isAgentSnapshotJobData(job.data)) {
    throw new Error(`Invalid agent snapshot job data for job ${job.id}`);
  }
  return job.data;
}

export interface EnqueueAgentProvisionResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentDeleteResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentSuspendResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentResumeResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentSleepResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentWakeResult {
  job: Job;
  created: boolean;
  /**
   * The restore params the in-flight job will ACTUALLY apply — the existing
   * job's own data when an active wake was reused, never the caller's request.
   * The wake route echoes these so a reused enqueue cannot misreport a
   * restoreBackupId/forceFreshBoot that was silently not applied (#15603 B6).
   */
  appliedRestoreBackupId: string | null;
  appliedForceFreshBoot: boolean;
}

export interface EnqueueAgentRestartResult {
  job: Job;
  created: boolean;
}

export interface WarmClaimCredentialReconcileResult {
  legacyFound: number;
  strandedFound: number;
  recoveryEnqueued: number;
  recoveryInFlight: number;
  recoveryDeferred: number;
  cleanupFound: number;
  cleanupCompleted: number;
  cleanupFailed: number;
}

export interface EnqueueAgentDowngradeResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentLogsResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentSnapshotResult {
  job: Job;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface LifecycleSandboxRow {
  id: string;
  agent_name: string | null;
  created_at: Date;
  execution_tier: AgentExecutionTier;
  status: AgentSandboxStatus;
  updated_at: Date | null;
  claimed_at: Date | null;
  warm_claim_credential_state: "pending" | "attested" | "ready" | "failed" | null;
  warm_claim_attested_at: Date | null;
  warm_claim_source_pool_id: string | null;
  warm_claim_key_fingerprint: string | null;
  warm_claim_attested_environment_revision: number | null;
  environment_revision: number;
  lifecycle_revision: number;
  user_id: string;
  sandbox_id: string | null;
  node_id: string | null;
  container_name: string | null;
  docker_image: string | null;
  image_digest: string | null;
  previous_docker_image: string | null;
  previous_image_digest: string | null;
  replacement_cleanup_sandbox_id: string | null;
  deletion_attempt_id: string | null;
  deletion_started_at: Date | null;
  deleted_at: Date | null;
  billing_status: AgentBillingStatus;
  shutdown_warning_sent_at: Date | null;
  scheduled_shutdown_at: Date | null;
  pool_status: AgentSandboxPoolStatus | null;
}

function snapshotAuthorityRejection(
  sandbox: Pick<LifecycleSandboxRow, "pool_status" | "deleted_at" | "deletion_attempt_id">,
): string | undefined {
  if (sandbox.pool_status !== null) {
    return "Agent snapshot cannot target pool-owned capacity";
  }
  if (sandbox.deleted_at !== null) {
    return "Agent snapshot cannot target a deleted agent";
  }
  if (sandbox.deletion_attempt_id !== null) {
    return "Agent snapshot cannot start while agent deletion is in progress";
  }
  return undefined;
}

interface LifecycleJobOptions<TData extends object> {
  /** Wire value for `jobs.type` (one of JOB_TYPES.*). */
  jobType: ProvisioningJobType;
  /** Typed job data to persist into `jobs.data` JSONB. */
  jobData: TData;
  /** Serializer for `jobData` — usually a one-line `{ ...data }`. */
  toRecord: (data: TData) => Record<string, unknown>;
  agentId: string;
  organizationId: string;
  userId: string;
  webhookUrl?: string;
  /** How many times the daemon may retry on failure. */
  maxAttempts: number;
  /** Used to populate `estimated_completion_at` for UI hints. */
  estimatedDurationMs: number;
  /** Logged as `"agent_xxx"` in the structured log messages. */
  logName: string;
  /** Extra structured-log fields beyond the standard jobId/agentId/orgId. */
  logExtras?: Record<string, unknown>;
  /**
   * Extra predicates that make in-flight reuse match operation-specific
   * inputs, e.g. logs tail length or snapshot type.
   */
  idempotencyPredicates?: SQL[];
  /**
   * Other job types that mutate the same per-agent resource and therefore
   * cannot overlap this job. The lookup runs under the lifecycle advisory
   * lock, making exclusion symmetric regardless of enqueue order.
   */
  mutuallyExclusiveJobTypes?: readonly ProvisioningJobType[];
  /**
   * Called inside the transaction after the sandbox row is fetched and
   * before the existing-job lookup. Throw to abort the enqueue (e.g.
   * provision's lifecycle-revision race check).
   */
  validateSandbox?: (sandbox: LifecycleSandboxRow) => void;
  /**
   * Resolve a durable operation replay before validating the sandbox's
   * current generation. A completed request must remain replayable after its
   * own lifecycle mutation advances that generation.
   */
  resolveReplay?: (tx: DbTransaction, sandbox: LifecycleSandboxRow) => Promise<Job | undefined>;
  deleteAuthorization?: DeleteAuthorization;
  /**
   * Permit an exact conditional delete to own a row whose failed replacement
   * still has a durable cleanup locator. The daemon converges that locator
   * before deleting the serving generation; ordinary lifecycle jobs remain
   * blocked by the unresolved fence.
   */
  allowReplacementCleanup?: boolean;
  /**
   * Called with the hydrated existing job when an active pending/in_progress
   * job of the same type would be reused instead of inserting a new row.
   * Throw to refuse the enqueue — reuse silently DROPS the caller's job data,
   * so operation-changing params (wake's restoreBackupId/forceFreshBoot) must
   * either match the in-flight job or be rejected loudly (#15603 B6).
   */
  validateReuse?: (existing: Job) => void;
  /**
   * Monotonically strengthens durable authority on a reused in-flight job.
   * Runs under the same lifecycle transaction and advisory lock as lookup.
   */
  upgradeReuse?: (tx: DbTransaction, existing: Job) => Promise<Job>;
  /**
   * Called inside the transaction after the "no existing job" check
   * and before the new job is inserted. Used by delete to flip the
   * sandbox row to `deletion_pending` so the UI reflects intent and
   * concurrent mutations bail. Skipped if an existing job is reused.
   * Receives the just-read sandbox row so it can branch on the prior
   * status (e.g. delete resets the failure counter on a fresh, non-delete
   * enqueue but preserves it across recovery re-enqueues).
   */
  beforeInsert?: (
    tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
    sandbox: LifecycleSandboxRow,
  ) => Promise<void>;
  /** Couples operation-specific durable authority to the inserted job row. */
  afterInsert?: (
    tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
    sandbox: LifecycleSandboxRow,
    job: typeof jobs.$inferSelect,
  ) => Promise<void>;
}

/**
 * Parse a positive-integer millisecond value from an env var, falling back to
 * `fallback` when the var is unset, non-numeric, or non-positive.
 */
function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Hard ceiling on a single job's execution. A slow agent_delete (SSH +
 * headscale network I/O while holding a DB advisory lock) used to run for
 * minutes and starve the whole cycle. Every leaf is independently bounded, so
 * a job hitting this ceiling means something is genuinely wedged.
 *
 * 300s default (env-overridable via `PROVISION_JOB_TIMEOUT_MS`), not 120s: a
 * freshly-pinned agent image cold-pulls in ~2.5 min on the node, and the leaf
 * SSH `docker pull` itself allows up to `PULL_TIMEOUT_MS` = 300s in
 * docker-sandbox-provider. At the old 120s this wrapper aborted the awaiter
 * mid-pull, so the job flipped toward failure even though the pull was still
 * landing the image in the node cache — retry churn + the half-provisioned
 * state behind the tonight outage. Matching the leaf `PULL_TIMEOUT_MS` (300s)
 * means the wrapper never cuts a still-progressing cold pull short. This is the
 * value 0xSolace set on the live box while working the outage; the env override
 * lets ops retune without a redeploy.
 *
 * This is WATCHDOG-SAFE and stays OFF the heartbeat critical path. On the
 * watchdog's critical path the per-job awaiter runs INSIDE the daemon's
 * `runBoundedPhase("cycle")`, itself capped at `PHASE_TIMEOUT_MS` (60s): if a
 * job runs longer, the phase frees the *cycle* awaiter at 60s, advances
 * `lastCycleCompletedAt`, and the heartbeat keeps flowing — REGARDLESS of
 * `PER_JOB_TIMEOUT_MS`. This constant governs only the detached background job
 * promise (the leaf SSH/HTTP I/O keeps running until it resolves or hits this
 * ceiling), NOT the watchdog clock. The watchdog invariant
 * (`WORK_CYCLE_TIMEOUT_MS` 240s + poll 30s < `WATCHDOG_MAX_CYCLE_MS` 300s) does
 * not reference this value at all, so raising it past `WORK_CYCLE_TIMEOUT_MS`
 * cannot violate the invariant — the real ceiling that matters is the leaf
 * `PULL_TIMEOUT_MS` (300s), which this matches.
 */
export const PER_JOB_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.PROVISION_JOB_TIMEOUT_MS,
  300_000,
);

/**
 * Stale-job thresholds, by job type. Generated provisioning attempts remain
 * owned until their executor acknowledges quiescence; daemon startup recovery
 * handles process replacement. These thresholds still govern legacy claims
 * and size the execution watchdog, so they must exceed real worst-case runtime.
 *
 * The cold-boot job types (provision / resume / wake / restart / upgrade) run
 * the full image-pull + agent-boot path, which legitimately takes up to ~11 min
 * (docker-sandbox-provider `PULL_TIMEOUT_MS` 5m + `HEALTH_CHECK_TIMEOUT_MS` 6m)
 * before `/api/health` answers. At the old flat 5-min threshold a slow cold
 * provision was reset mid-flight, re-claimed, and the second provision collided
 * on the deterministic container name (`agent-<id>`) and force-removed the
 * still-booting container — provision flapping + orphaned containers on the
 * exact cold-start path every new user hits. 15 min clears the worst case with
 * margin; fast ops keep the tight 5-min backstop. (`trySetProvisioning`
 * deliberately admits a `provisioning` row and defers to this as the time gate,
 * so this threshold is the single source of truth for "provision is stuck".)
 */
/** Re-schedule delay for snapshot jobs claimed while the lane gate is off
 *  (#16639) — long enough not to spin, short enough to drain promptly once
 *  operators enable the lane. */
const SNAPSHOT_GATE_RETRY_DELAY_MS = 10 * 60 * 1000;
const PROVISION_TRANSPORT_RETRY_DELAY_MS = 2 * 60 * 1000;
/** Retryable provider/transport outcomes allowed before the logical job is
 * settled terminally without restarting its ordinary-attempt ladder. */
const PROVISION_TRANSPORT_MAX_FREE_RETRIES = 5;
/** How many times a transient pre-deletion capture may requeue WITHOUT
 *  consuming the delete's attempt budget. At the transport retry delay above
 *  this is ~20 minutes of tolerance for a capture outage; past it the failure
 *  escalates to an attempt-consuming one so a user-requested delete cannot
 *  become an immortal (still billed) agent. */
const PRE_DELETE_CAPTURE_MAX_FREE_RETRIES = 10;
const WARM_CLAIM_RECOVERY_ORPHAN_GRACE_MS = 2 * 60 * 1000;
const EXECUTION_LEASE_MS = 60_000;
const EXECUTION_LEASE_HEARTBEAT_MS = 15_000;
const SETTLEMENT_RETRY_BASE_MS = 250;
const SETTLEMENT_RETRY_MAX_MS = 5_000;

/**
 * Unreachable loopback bridge that E2E preload historically stamped onto
 * fixture sandboxes (see issue #15737). The preload now seeds fixtures inert
 * (#15755), but the backup scanner still excludes this sentinel as
 * defense-in-depth: any row that reaches `running` with this address has no
 * live state endpoint, so snapshotting it can only `fetch failed` in a loop and
 * flood the failed-jobs log — the exact noise the reachability carve-out exists
 * to prevent.
 */
const UNREACHABLE_BRIDGE_SENTINEL = "http://127.0.0.1:65535";

/**
 * Health-check budget a container lifecycle job may legitimately spend
 * waiting for `/api/health`. Mirrors docker-sandbox-provider's
 * `HEALTH_CHECK_TIMEOUT_MS` (360s) WITHOUT importing it — that module drags
 * node-only deps (ssh2) into the Worker bundle. A guarding test
 * (`provision-duration-estimate.test.ts`) asserts the two stay equal.
 */
export const CONTAINER_HEALTH_CHECK_BUDGET_MS = 360_000;

/**
 * User-facing duration estimate for container lifecycle jobs (provision /
 * restart / restore / fresh-boot). The old flat 90s estimate assumed a 60s
 * health check against the real 360s budget, so users were told a healthy
 * in-budget job was "still in progress after 362s" (#22548). Estimate the
 * real worst case: DB assignment + docker pull/run (~30s) + full health
 * budget.
 */
export const CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS = 30_000 + CONTAINER_HEALTH_CHECK_BUDGET_MS;

/**
 * Per-job execution timeout for the `withTimeout(executeJob(job), …)` wrap,
 * BY JOB TYPE (#10919).
 *
 * The flat `PER_JOB_TIMEOUT_MS` (300s) matches only the leaf `docker pull`
 * ceiling — NOT a full cold boot, which is image-pull (`PULL_TIMEOUT_MS` 300s) +
 * agent health-check (`HEALTH_CHECK_TIMEOUT_MS` 360s) ≈ up to 11 min. At the flat
 * 300s, a legitimate slow cold provision had its awaiter rejected mid-boot; the
 * catch's `incrementAttempt` flipped the still-running job to `pending`, a later
 * poll re-claimed it (nothing blocks a non-`in_progress` re-claim), and the
 * second provision collided on the deterministic `agent-<id>` name and
 * force-removed the first still-booting container — provision flapping on the
 * exact cold-start path every new dedicated agent hits.
 *
 * Cold-boot job types therefore get the same 15-min budget used for legacy
 * stale claims, so the per-job wrap can't fire before a legitimate cold boot
 * finishes (15 min > ~11 min). Fast ops keep the tight 300s.
 */
export function resolvePerJobTimeoutMs(jobType: string): number {
  return COLD_BOOT_JOB_TYPES.has(jobType as ProvisioningJobType)
    ? Math.max(PER_JOB_TIMEOUT_MS, COLD_BOOT_STALE_JOB_THRESHOLD_MS)
    : PER_JOB_TIMEOUT_MS;
}

/**
 * Machine-readable trailer appended to `agent_sandboxes.error_message` when an
 * AGENT_UPGRADE exhausts retries on a ROLLBACK-SAFE failure (the old container
 * still serves). Encodes the exhausted TARGET digest so the fleet reconciler
 * can re-arm the agent when a NEWER target digest is published, instead of
 * excluding the row from all future upgrades forever. Kept in error_message to
 * avoid a schema migration (mission constraint) while staying strictly
 * additive: pre-existing rows have no trailer and parse to `null`.
 *
 * Format (single line, trailer at END so the human-readable cause stays first):
 *   `<human message> [upgrade-failed-target:<digest>]`
 * `<digest>` is the resolved sha256 target ref; `unknown` when the exhausted
 * job carried no target digest (defensive). The prefix constant lives in the
 * schema layer (`UPGRADE_FAILURE_TARGET_MARKER_PREFIX`) so the reconciler query
 * can share it without a service↔repository import cycle.
 */
export function buildUpgradeFailureMarker(
  maxAttempts: number,
  cause: string,
  toDigest: string | null,
): string {
  const target = toDigest && toDigest.length > 0 ? toDigest : "unknown";
  return `Upgrade permanently failed after ${maxAttempts} attempts: ${cause} ${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}${target}]`;
}

/**
 * Parse the exhausted TARGET digest out of a rollback-safe upgrade-failure
 * error_message. Returns null when no trailer is present (a non-upgrade error,
 * a pre-existing row, or an `unknown` target), so callers treat "no recorded
 * target" as "do not re-arm on target change" (conservative).
 */
export function parseUpgradeFailureTargetDigest(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  const start = errorMessage.lastIndexOf(UPGRADE_FAILURE_TARGET_MARKER_PREFIX);
  if (start === -1) return null;
  const from = start + UPGRADE_FAILURE_TARGET_MARKER_PREFIX.length;
  const end = errorMessage.indexOf("]", from);
  if (end === -1) return null;
  const digest = errorMessage.slice(from, end);
  return digest === "unknown" || digest.length === 0 ? null : digest;
}

/**
 * Thrown by `executeAgentUpgrade` when `executeUpgrade` reports a failure,
 * carrying the rollback-safe classification through the worker's generic
 * catch → `incrementAttempt` → `buildPermanentFailureWriteback` path.
 *
 * `rolledBack === true` means the OLD container is still serving (a
 * rollback-safe failure); the permanent-failure writeback must NOT mark the
 * sandbox terminal. `rolledBack === false` means the agent is genuinely not
 * serving on the old container, so the terminal error writeback is correct.
 * `toDigest` is the target the exhausted upgrade was aiming at, recorded so
 * the reconciler can re-arm the agent when a NEWER target digest is published
 * (a rollback-safe exclusion must not be permanent — always-on agents that hit
 * a transient rollback-safe failure must still receive future security
 * patches). See #15357 / lalalune's #15311 review.
 */
export class UpgradeFailedError extends Error {
  readonly rolledBack: boolean;
  readonly toDigest: string;
  constructor(message: string, opts: { rolledBack: boolean; toDigest: string }) {
    super(message);
    this.name = "UpgradeFailedError";
    this.rolledBack = opts.rolledBack;
    this.toDigest = opts.toDigest;
  }
}

class RetryableProvisionTransportError extends Error {
  readonly retrySnapshot: Job;
  readonly maxRequeues: number;
  readonly durableErrorText?: string;

  constructor(
    message: string,
    retrySnapshot: Job,
    maxRequeues: number,
    options?: { cause?: unknown; durableErrorText?: string },
  ) {
    super(message, options);
    this.name = "RetryableProvisionTransportError";
    this.retrySnapshot = retrySnapshot;
    this.maxRequeues = maxRequeues;
    this.durableErrorText = options?.durableErrorText;
  }
}

/**
 * A pre-deletion capture stayed transient past its free-requeue budget. The
 * free requeue exists so a momentary capture outage does not burn the delete's
 * finite attempts, but an outage that never clears would requeue forever and
 * keep a user-requested delete alive (and billed) indefinitely. Past the cap
 * the failure escalates to an ordinary attempt-consuming failure, so the job
 * ends in `deletion_failed` where the stuck-delete reconciler and ops can see
 * it — fail closed, never a fabricated success.
 */
class PreDeleteCaptureExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreDeleteCaptureExhaustedError";
  }
}

/**
 * A delete failed from an unacknowledged worker snapshot. Its terminal write
 * must be fenced against a concurrent false-to-true authority upgrade so the
 * API cannot durably accept state loss and then have this stale attempt win.
 */
class UnacknowledgedAgentDeleteError extends Error {
  readonly retrySnapshot: Job;

  constructor(message: string, retrySnapshot: Job) {
    super(message);
    this.name = "UnacknowledgedAgentDeleteError";
    this.retrySnapshot = retrySnapshot;
  }
}

class RetryableReplacementCleanupError extends Error {
  readonly retrySnapshot: Job;
  readonly maxRequeues = PROVISION_TRANSPORT_MAX_FREE_RETRIES;

  constructor(message: string, retrySnapshot: Job, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableReplacementCleanupError";
    this.retrySnapshot = retrySnapshot;
  }
}

class AdminCanaryCleanupCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCanaryCleanupCommitError";
  }
}

const ADMIN_CANARY_CONFLICTING_JOB_TYPES: ProvisioningJobType[] = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_DELETE,
  JOB_TYPES.AGENT_SUSPEND,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_DOWNGRADE,
  JOB_TYPES.AGENT_SLEEP,
  JOB_TYPES.AGENT_WAKE,
];
const SHARED_IMAGE_CHANGE_JOB_TYPES: ProvisioningJobType[] = [
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
];

const ACCOUNT_LIFECYCLE_FENCED_AGENT_JOB_TYPES: readonly ProvisioningJobType[] = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
  JOB_TYPES.AGENT_DOWNGRADE,
  JOB_TYPES.AGENT_LOGS,
  JOB_TYPES.AGENT_MESSAGE,
  JOB_TYPES.AGENT_SNAPSHOT,
];

/**
 * Job types whose permanent failure has to settle a dependent status row. This
 * list and the arms of `buildPermanentFailureWriteback` are ONE mapping; the
 * exhaustiveness check in that switch fails the build if they drift apart.
 * Recovery consults it per TYPE because resolving a writeback first hydrates
 * the job's blob-offloaded payload, and a type owning no dependent row would
 * pay those object-store reads only to be handed `undefined` — which would
 * also make the stale sweep hydrate for lanes it deliberately leaves gated.
 */
const DEPENDENT_ROW_JOB_TYPES = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
  JOB_TYPES.APP_DEPLOY,
  JOB_TYPES.CONTAINER_PROVISION,
  JOB_TYPES.AGENT_DELETE,
] as const satisfies readonly ProvisioningJobType[];

type DependentRowJobType = (typeof DEPENDENT_ROW_JOB_TYPES)[number];

function ownsDependentRow(jobType: string): jobType is DependentRowJobType {
  return (DEPENDENT_ROW_JOB_TYPES as readonly string[]).includes(jobType);
}

export interface ProvisioningRecoverySummary {
  scanned: number;
  retried: number;
  permanentlyFailed: number;
  unchanged: number;
  failures: JobRecoveryFailure[];
}

export class ProvisioningRecoveryDegradedError extends ElizaError {
  override readonly name = "ProvisioningRecoveryDegradedError";
  readonly summary: ProvisioningRecoverySummary;

  constructor(phase: "stale" | "startup", summary: ProvisioningRecoverySummary) {
    const causes = summary.failures.map(({ cause }) => cause);
    super(`Provisioning ${phase} recovery completed with ${summary.failures.length} failure(s)`, {
      code: "PROVISIONING_RECOVERY_DEGRADED",
      cause: new AggregateError(causes, `Provisioning ${phase} recovery failures`),
      context: {
        phase,
        scanned: summary.scanned,
        retried: summary.retried,
        permanentlyFailed: summary.permanentlyFailed,
        unchanged: summary.unchanged,
        failures: summary.failures.map(({ jobId, jobType, cause }) => ({
          jobId,
          jobType,
          error: jobErrorText(cause),
        })),
      },
      severity: "ephemeral",
    });
    this.summary = summary;
  }
}

function emptyRecoverySummary(): ProvisioningRecoverySummary {
  return { scanned: 0, retried: 0, permanentlyFailed: 0, unchanged: 0, failures: [] };
}

function addRecoveryResult(
  summary: ProvisioningRecoverySummary,
  result: JobRecoverySweepResult,
): void {
  summary.scanned += result.scanned;
  summary.retried += result.retried;
  summary.permanentlyFailed += result.permanentlyFailed;
  summary.unchanged += result.unchanged;
  summary.failures.push(...result.failures);
}

function assertRecoveryHealthy(
  phase: "stale" | "startup",
  summary: ProvisioningRecoverySummary,
): void {
  if (summary.failures.length === 0) return;
  logger.error(`[provisioning-jobs] ${phase} recovery finished degraded`, {
    scanned: summary.scanned,
    retried: summary.retried,
    permanentlyFailed: summary.permanentlyFailed,
    unchanged: summary.unchanged,
    failures: summary.failures.map(({ jobId, jobType, cause }) => ({
      jobId,
      jobType,
      error: jobErrorText(cause),
    })),
  });
  throw new ProvisioningRecoveryDegradedError(phase, summary);
}

/**
 * Acquire the lifecycle target before an explicit billing cancellation takes
 * organization/user authority locks. Validation and durable intent/job writes
 * stay in enqueueAgentSuspendOnceInTransaction; its repeated advisory and row
 * locks are transaction-reentrant.
 */
export async function lockAgentSuspendTargetInTx(
  tx: DbTransaction,
  p: { agentId: string; organizationId: string },
): Promise<void> {
  await configureElizaLifecycleTransaction(tx);
  await tx.execute(elizaProvisionAdvisoryLockSql(p.organizationId, p.agentId));
  await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(eq(agentSandboxes.id, p.agentId), eq(agentSandboxes.organization_id, p.organizationId)),
    )
    .for("update")
    .limit(1);
}

export class ProvisioningJobService {
  private readonly executionOverride?: (job: Job) => Promise<void>;
  private readonly executionTimeoutMs: (jobType: string) => number;
  private readonly executionOwnerId: string;
  private readonly executionLeaseMs: number;
  private readonly executionLeaseHeartbeatMs: number;
  private readonly settlementRetryBaseMs: number;
  private readonly acquireProviderAdmission: typeof acquireProviderAdmission;
  private readonly releaseProviderAdmission: typeof releaseProviderAdmission;

  constructor(options?: {
    executeJob?: (job: Job) => Promise<void>;
    executionTimeoutMs?: (jobType: string) => number;
    executionOwnerId?: string;
    executionLeaseMs?: number;
    executionLeaseHeartbeatMs?: number;
    settlementRetryBaseMs?: number;
    acquireProviderAdmission?: typeof acquireProviderAdmission;
    releaseProviderAdmission?: typeof releaseProviderAdmission;
  }) {
    this.executionOverride = options?.executeJob;
    this.executionTimeoutMs = options?.executionTimeoutMs ?? resolvePerJobTimeoutMs;
    this.executionOwnerId = options?.executionOwnerId ?? crypto.randomUUID();
    this.executionLeaseMs = options?.executionLeaseMs ?? EXECUTION_LEASE_MS;
    this.executionLeaseHeartbeatMs =
      options?.executionLeaseHeartbeatMs ?? EXECUTION_LEASE_HEARTBEAT_MS;
    this.settlementRetryBaseMs = options?.settlementRetryBaseMs ?? SETTLEMENT_RETRY_BASE_MS;
    this.acquireProviderAdmission = options?.acquireProviderAdmission ?? acquireProviderAdmission;
    this.releaseProviderAdmission = options?.releaseProviderAdmission ?? releaseProviderAdmission;
    if (
      this.executionLeaseMs < 1 ||
      this.executionLeaseHeartbeatMs < 1 ||
      this.executionLeaseHeartbeatMs >= this.executionLeaseMs
    ) {
      throw new Error("Execution lease heartbeat must be positive and shorter than the lease");
    }
  }

  /**
   * Keep durable suspend-authority resolution behind the service boundary so
   * dispatch harnesses can replace that one read per test without swapping the
   * process-wide DB helper module used by composed PGlite suites.
   */
  private async resolveAgentSuspendAuthority(job: Job): Promise<ResolvedAgentSuspendAuthority> {
    return resolveAgentSuspendAuthority(job);
  }

  /**
   * Common path for the seven `enqueueAgent*Once` methods. Acquires the
   * per-(org,agent) advisory lock, verifies the sandbox exists, runs an
   * optional caller-supplied validation, reuses any in-flight job of
   * the same type (idempotency), or inserts a fresh row.
   *
   * Each public method is now a thin wrapper that supplies the four
   * varying bits: job type, typed data shape, retry/timing budget, and
   * the log breadcrumb fields. Adding a new lifecycle job type is a
   * ~10-line addition instead of ~80.
   */
  private async enqueueLifecycleJob<TData extends object>(
    opts: LifecycleJobOptions<TData>,
  ): Promise<{ job: Job; created: boolean }> {
    if (opts.webhookUrl) {
      await assertSafeOutboundUrl(opts.webhookUrl);
    }

    return await dbWrite.transaction(async (tx) => this.enqueueLifecycleJobInTx(tx, opts));
  }

  /**
   * Transaction-scoped body of {@link enqueueLifecycleJob} for callers that
   * must couple the enqueue to other writes in ONE transaction (the
   * tier-upgrade single-flight boundary creates the sandbox row and its
   * provision job atomically, #15943). Runs entirely on the caller's `tx`:
   * a sandbox row inserted earlier in the same transaction is visible to the
   * existence check, and a rollback discards the job together with it. The
   * caller must pass any `webhookUrl` through {@link assertSafeOutboundUrl}
   * BEFORE opening the transaction — URL validation resolves DNS and must not
   * run while the transaction (and its advisory locks) are held open.
   */
  private async enqueueLifecycleJobInTx<TData extends object>(
    tx: DbTransaction,
    opts: LifecycleJobOptions<TData>,
  ): Promise<{ job: Job; created: boolean }> {
    const newJob: NewJob = {
      type: opts.jobType,
      status: "pending",
      data: opts.toRecord(opts.jobData),
      data_storage: "inline",
      organization_id: opts.organizationId,
      user_id: opts.userId,
      webhook_url: opts.webhookUrl,
      max_attempts: opts.maxAttempts,
      estimated_completion_at: new Date(Date.now() + opts.estimatedDurationMs),
    };

    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(opts.organizationId, opts.agentId));

    const [sandbox] = await tx
      .select({
        id: agentSandboxes.id,
        agent_name: agentSandboxes.agent_name,
        created_at: agentSandboxes.created_at,
        execution_tier: agentSandboxes.execution_tier,
        status: agentSandboxes.status,
        updated_at: agentSandboxes.updated_at,
        claimed_at: agentSandboxes.claimed_at,
        warm_claim_credential_state: agentSandboxes.warm_claim_credential_state,
        warm_claim_attested_at: agentSandboxes.warm_claim_attested_at,
        warm_claim_source_pool_id: agentSandboxes.warm_claim_source_pool_id,
        warm_claim_key_fingerprint: agentSandboxes.warm_claim_key_fingerprint,
        warm_claim_attested_environment_revision:
          agentSandboxes.warm_claim_attested_environment_revision,
        environment_revision: agentSandboxes.environment_revision,
        lifecycle_revision: agentSandboxes.lifecycle_revision,
        user_id: agentSandboxes.user_id,
        sandbox_id: agentSandboxes.sandbox_id,
        node_id: agentSandboxes.node_id,
        container_name: agentSandboxes.container_name,
        docker_image: agentSandboxes.docker_image,
        image_digest: agentSandboxes.image_digest,
        previous_docker_image: agentSandboxes.previous_docker_image,
        previous_image_digest: agentSandboxes.previous_image_digest,
        replacement_cleanup_sandbox_id: agentSandboxes.replacement_cleanup_sandbox_id,
        deletion_attempt_id: agentSandboxes.deletion_attempt_id,
        deletion_started_at: agentSandboxes.deletion_started_at,
        deleted_at: agentSandboxes.deleted_at,
        billing_status: agentSandboxes.billing_status,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
        pool_status: agentSandboxes.pool_status,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, opts.agentId),
          eq(agentSandboxes.organization_id, opts.organizationId),
        ),
      )
      .for("update")
      .limit(1);

    if (!sandbox) {
      // The exact message is load-bearing: several route boundaries map
      // `message === "Agent not found"` to a 404.
      throw new ElizaError("Agent not found", {
        code: "PROVISION_ENQUEUE_AGENT_NOT_FOUND",
        context: {
          agentId: opts.agentId,
          organizationId: opts.organizationId,
          jobType: opts.jobType,
        },
      });
    }

    if (
      requiresContainerBackedTarget(opts.jobType) &&
      !isContainerBackedExecutionTier(sandbox.execution_tier)
    ) {
      throw new ApiError(
        409,
        "session_not_ready",
        `${CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE}: ${opts.jobType}`,
        {
          reason: CONTAINER_BACKED_TARGET_REJECTION_REASON,
          jobType: opts.jobType,
        },
      );
    }

    if (
      EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(opts.jobType) &&
      sandbox.replacement_cleanup_sandbox_id &&
      !opts.allowReplacementCleanup
    ) {
      throw new ApiError(
        409,
        "session_not_ready",
        `Agent ${opts.agentId} has unresolved replacement cleanup`,
      );
    }
    if (
      EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(opts.jobType) &&
      opts.jobType !== JOB_TYPES.AGENT_DELETE &&
      (sandbox.deletion_attempt_id ||
        sandbox.status === "deletion_pending" ||
        sandbox.status === "deletion_failed")
    ) {
      throw new ApiError(409, "session_not_ready", `Agent ${opts.agentId} deletion is in progress`);
    }

    const replay = await opts.resolveReplay?.(tx, sandbox);
    if (replay) {
      logger.info(`[provisioning-jobs] Replaying durable ${opts.logName} job`, {
        jobId: replay.id,
        agentId: opts.agentId,
        orgId: opts.organizationId,
        ...(opts.logExtras ?? {}),
      });
      return { job: await hydrateJob(replay), created: false };
    }

    opts.validateSandbox?.(sandbox);

    // Mirrors prepareAgentDelete's admission policy in eliza-sandbox.ts: an
    // unqualified delete of a running dedicated agent fails closed, while
    // shared-runtime rows and unclaimed warm-pool rows stay deletable by
    // cleanup paths. The row lookup above is scoped to opts.organizationId,
    // so that value is the row's organization_id.
    const isUnclaimedWarmPoolEntry =
      opts.organizationId === WARM_POOL_ORG_ID && sandbox.pool_status === "unclaimed";
    if (
      opts.jobType === JOB_TYPES.AGENT_DELETE &&
      sandbox.status === "running" &&
      sandbox.execution_tier !== "shared" &&
      !isUnclaimedWarmPoolEntry &&
      !opts.deleteAuthorization
    ) {
      throw new ApiError(409, "session_not_ready", "Agent is running; suspend it before deletion");
    }

    const configuredConflicts = opts.mutuallyExclusiveJobTypes ?? [];
    const symmetricConflicts =
      opts.jobType !== JOB_TYPES.AGENT_DELETE &&
      EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(opts.jobType)
        ? EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES
        : [];
    const conflictingTypes = [...new Set([...configuredConflicts, ...symmetricConflicts])].filter(
      (jobType) => jobType !== opts.jobType,
    );
    if (conflictingTypes && conflictingTypes.length > 0) {
      const [conflict] = await tx
        .select({ id: jobs.id, type: jobs.type, status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, opts.organizationId),
            eq(jobs.agent_id, opts.agentId),
            inArray(jobs.type, [...conflictingTypes]),
            sql`${jobs.status} IN ('pending', 'in_progress')`,
          ),
        )
        .orderBy(desc(jobs.created_at))
        .limit(1);
      if (conflict) {
        throw new ApiError(
          409,
          "session_not_ready",
          `Agent ${opts.agentId} has conflicting ${conflict.type} job ${conflict.id}`,
          {
            conflictingJobId: conflict.id,
            conflictingJobType: conflict.type,
            conflictingJobStatus: conflict.status,
          },
        );
      }
    }

    const [existing] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, opts.jobType),
          eq(jobs.organization_id, opts.organizationId),
          eq(jobs.agent_id, opts.agentId),
          ...(opts.idempotencyPredicates ?? []),
          sql`${jobs.status} IN ('pending', 'in_progress')`,
        ),
      )
      .orderBy(desc(jobs.created_at))
      .limit(1);

    const logFields = {
      agentId: opts.agentId,
      orgId: opts.organizationId,
      ...(opts.logExtras ?? {}),
    };

    if (existing) {
      const hydrated = await hydrateJob(existing);
      opts.validateReuse?.(hydrated);
      const reused = opts.upgradeReuse ? await opts.upgradeReuse(tx, hydrated) : hydrated;
      logger.info(`[provisioning-jobs] Reusing active ${opts.logName} job`, {
        jobId: existing.id,
        ...logFields,
      });
      return { job: reused, created: false };
    }

    await opts.beforeInsert?.(tx, sandbox);

    // Persist admission-time terms only on new jobs. Reuse and recovery must
    // retain their original terms, never manufacture acceptance of a new price.
    if (PRICED_AGENT_START_JOB_TYPES.includes(opts.jobType)) {
      newJob.data = {
        ...newJob.data,
        admittedComputePrice: getDedicatedComputePriceAcceptance(),
      };
    }

    const [job] = await tx
      .insert(jobs)
      .values(await prepareJobInsertData(newJob))
      .returning();

    await opts.afterInsert?.(tx, sandbox, job);

    logger.info(`[provisioning-jobs] Enqueued ${opts.logName} job`, {
      jobId: job.id,
      ...logFields,
    });

    return { job: await hydrateJob(job), created: true };
  }

  /**
   * Enqueue an Agent sandbox provisioning job.
   * Returns the job record immediately (status=pending).
   */
  async enqueueAgentProvision(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
  }): Promise<Job> {
    const result = await this.enqueueAgentProvisionOnce(params);
    return result.job;
  }

  async enqueueAgentProvisionOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
    restoreDirective?: AgentProvisionJobData["restoreDirective"];
  }): Promise<EnqueueAgentProvisionResult> {
    return this.enqueueLifecycleJob<AgentProvisionJobData>(
      this.agentProvisionLifecycleOptions(params),
    );
  }

  /**
   * Transaction-scoped variant of {@link enqueueAgentProvisionOnce} for
   * callers that must make the provision job durable ATOMICALLY with other
   * writes in the same transaction — the tier-upgrade single-flight boundary
   * inserts the target sandbox row and this job as one commit, so an enqueue
   * failure can never strand a committed target without a job, and a target
   * referenced by a committed job can never be compensation-deleted (#15943).
   * No webhook support: URL validation resolves DNS and must not run inside an
   * open transaction. The caller must already hold a lock that serializes this
   * agent's creation; the per-(org,agent) provision advisory lock is still
   * acquired here (lock order: caller's org-scoped lock → provision lock).
   */
  async enqueueAgentProvisionOnceInTx(
    tx: DbTransaction,
    params: {
      agentId: string;
      organizationId: string;
      userId: string;
      agentName: string;
      restoreDirective?: AgentProvisionJobData["restoreDirective"];
    },
  ): Promise<EnqueueAgentProvisionResult> {
    return this.enqueueLifecycleJobInTx<AgentProvisionJobData>(
      tx,
      this.agentProvisionLifecycleOptions(params),
    );
  }

  private agentProvisionLifecycleOptions(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
    restoreDirective?: AgentProvisionJobData["restoreDirective"];
  }): LifecycleJobOptions<AgentProvisionJobData> {
    const expected = params.expectedLifecycleRevision;
    return {
      jobType: JOB_TYPES.AGENT_PROVISION,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: params.agentName,
        ...(params.restoreDirective ? { restoreDirective: params.restoreDirective } : {}),
      },
      toRecord: agentProvisionJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_provision",
      validateSandbox:
        expected !== undefined
          ? (sandbox) => {
              if (sandbox.lifecycle_revision !== expected) {
                throw new Error("Agent state changed while starting");
              }
            }
          : undefined,
      // A reviewed adoption pins either one exact backup or an explicit fresh
      // boot. Reusing an ordinary provision job would silently discard that
      // authority and could activate different state, so directive-bearing
      // callers only converge with an identical durable job payload.
      validateReuse: params.restoreDirective
        ? (existing) => {
            const active = readAgentProvisionJobData(existing);
            if (sameProvisionRestoreDirective(active.restoreDirective, params.restoreDirective)) {
              return;
            }
            throw new ApiError(
              409,
              "session_not_ready",
              `Provision job ${existing.id} is already ${existing.status} for this agent with different restore authority`,
              { conflictingJobId: existing.id },
            );
          }
        : undefined,
    };
  }

  /**
   * Mark a sandbox for async deletion. The HTTP DELETE handler calls this
   * synchronously; the heavy work (SSH stop on the core, DB row delete, API
   * key revoke) happens later when the provisioning worker daemon picks up
   * the resulting `agent_delete` job. The sandbox row stays in the table
   * with status `deletion_pending` so the row is auditable and re-enqueue
   * stays idempotent.
   *
   * Returns the queued job (existing if one was already in flight, new
   * otherwise) so the caller can return its id for client-side polling.
   */
  async enqueueAgentDeleteOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    authorization?: DeleteAuthorization;
    stateLossAcknowledged?: boolean;
    expectedIdentity?: {
      agentName: string;
      createdAt: Date | string;
      executionTier: AgentExecutionTier;
    };
  }): Promise<EnqueueAgentDeleteResult> {
    // Stamps `deletion_allocation_counted`, and this runs inside the
    // provisioning worker, whose deploy does not gate on migrate-db. Ensure is
    // memoized, so the DDL runs once per isolate rather than once per enqueue.
    await ensureAgentSandboxSchema();
    const expectedIdentity = params.expectedIdentity;
    const expectedCreatedAt = expectedIdentity ? new Date(expectedIdentity.createdAt) : null;
    if (expectedCreatedAt && !Number.isFinite(expectedCreatedAt.getTime())) {
      throw new ApiError(400, "validation_error", "Expected agent creation timestamp is invalid");
    }
    const requestedAuthority = params.stateLossAcknowledged
      ? {
          stateLossAcknowledged: true as const,
          stateLossAcknowledgedByUserId: params.userId,
          stateLossAcknowledgedAt: new Date().toISOString(),
        }
      : {};
    return this.enqueueLifecycleJob<AgentDeleteJobData>({
      jobType: JOB_TYPES.AGENT_DELETE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        authorization: params.authorization,
        ...requestedAuthority,
      },
      toRecord: agentDeleteJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      deleteAuthorization: params.authorization,
      allowReplacementCleanup: expectedIdentity !== undefined,
      maxAttempts: 3,
      // SSH stop is fast (~10s graceful + ~5s force kill), DB cascade is
      // sub-second. 30s matches the Docker deletion-stop command timeout.
      estimatedDurationMs: 30_000,
      logName: "agent_delete",
      upgradeReuse: params.stateLossAcknowledged
        ? async (tx, existing) => {
            const existingData = readAgentDeleteJobData(existing);
            if (
              existingData.stateLossAcknowledged === true &&
              existingData.stateLossAcknowledgedByUserId !== undefined
            ) {
              return existing;
            }
            // A legacy acknowledged row without persisted provenance is
            // stamped with the current re-requesting user: the true first
            // acknowledging actor was never recorded, so this best-effort
            // attribution is the earliest authenticated actor we can prove.
            const [upgraded] = await tx
              .update(jobs)
              .set({
                data: agentDeleteJobDataToRecord({
                  ...existingData,
                  ...requestedAuthority,
                }),
                data_storage: "inline",
                data_key: null,
                updated_at: new Date(),
              })
              .where(
                and(eq(jobs.id, existing.id), sql`${jobs.status} IN ('pending', 'in_progress')`),
              )
              .returning();
            if (!upgraded) {
              throw new ApiError(
                409,
                "session_not_ready",
                "Agent deletion changed while recording state-loss authority",
              );
            }
            return hydrateJob(upgraded);
          }
        : undefined,
      validateSandbox: expectedIdentity
        ? (sandbox) => {
            if (
              sandbox.agent_name !== expectedIdentity.agentName ||
              sandbox.created_at.getTime() !== expectedCreatedAt?.getTime() ||
              sandbox.execution_tier !== expectedIdentity.executionTier
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                "Agent identity changed before deletion",
              );
            }
          }
        : undefined,
      // Flip status so the UI shows "deleting" and concurrent mutations
      // bail. Actual row removal happens in executeAgentDelete once the
      // provider proves the workload is no longer running.
      beforeInsert: async (tx, sandbox) => {
        if (
          sandbox.claimed_at &&
          (sandbox.warm_claim_credential_state === "pending" ||
            sandbox.warm_claim_credential_state === "attested")
        ) {
          throw new ApiError(
            409,
            "session_not_ready",
            "Warm-claim credential handoff is still in progress",
          );
        }
        // A pending row is either unclaimed or was made retryable only after its
        // prior execution acknowledged quiescence.
        const cancelledAt = new Date();
        const cancelled = await tx
          .update(jobs)
          .set({
            status: "cancelled",
            completed_at: cancelledAt,
            updated_at: cancelledAt,
          })
          .where(
            and(
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              ne(jobs.type, JOB_TYPES.AGENT_DELETE),
              eq(jobs.status, "pending"),
            ),
          )
          .returning({ id: jobs.id });

        // Never overwrite an execution that has not durably acknowledged
        // quiescence, regardless of its queue status.
        const [conflict] = await tx
          .select({
            id: jobs.id,
            type: jobs.type,
            status: jobs.status,
          })
          .from(jobs)
          .where(
            and(
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              ne(jobs.type, JOB_TYPES.AGENT_DELETE),
              or(
                eq(jobs.status, "in_progress"),
                and(
                  inArray(jobs.type, [...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
                  isNotNull(jobs.execution_generation),
                  isNull(jobs.execution_quiesced_at),
                  cancelled.length > 0
                    ? notInArray(
                        jobs.id,
                        cancelled.map((job) => job.id),
                      )
                    : undefined,
                ),
              ),
            ),
          )
          .orderBy(desc(jobs.updated_at))
          .limit(1);
        if (conflict) {
          throw new ApiError(
            409,
            "session_not_ready",
            `Agent ${params.agentId} has non-quiescent ${conflict.type} job ${conflict.id}`,
            {
              conflictingJobId: conflict.id,
              conflictingJobType: conflict.type,
              conflictingJobStatus: conflict.status,
            },
          );
        }

        // A genuine user-initiated delete (the row is not already in a deletion
        // state) starts the deletion-failure counter fresh — error_count may
        // carry a stale provisioning-error value, and a new delete should get a
        // full set of recovery sweeps before the circuit-breaker abandons it.
        // A recovery re-enqueue (status is already deletion_pending/_failed)
        // PRESERVES the count so reEnqueueFailedDeletions can stop the loop.
        const isRecoveryReEnqueue =
          Boolean(sandbox.deletion_attempt_id) ||
          sandbox.status === "deletion_pending" ||
          sandbox.status === "deletion_failed";
        // Continuing an earlier deletion keeps the original start time by
        // leaving the column alone. (`deletion_started_at IS NOT NULL` implies
        // isRecoveryReEnqueue via agent_sandboxes_deletion_intent_pair_check.)
        const continuesEarlierDeletion = sandbox.deletion_started_at !== null;
        const deletionAttemptId =
          isRecoveryReEnqueue && sandbox.deletion_attempt_id
            ? sandbox.deletion_attempt_id
            : crypto.randomUUID();
        const identityPredicates =
          expectedIdentity && expectedCreatedAt
            ? [
                eq(agentSandboxes.agent_name, expectedIdentity.agentName),
                sql`${agentSandboxes.created_at} >= ${expectedCreatedAt}
                AND ${agentSandboxes.created_at} < ${new Date(expectedCreatedAt.getTime() + 1)}`,
                eq(agentSandboxes.execution_tier, expectedIdentity.executionTier),
                isNull(agentSandboxes.deleted_at),
                sql`COALESCE(${agentSandboxes.warm_claim_credential_state}, '')
                NOT IN ('pending', 'attested')`,
              ]
            : [];
        const owned = await tx
          .update(agentSandboxes)
          .set({
            status: "deletion_pending" as const,
            deletion_attempt_id: deletionAttemptId,
            ...(continuesEarlierDeletion ? {} : { deletion_started_at: new Date() }),
            ...(isRecoveryReEnqueue
              ? {}
              : {
                  deletion_previous_status: sandbox.status,
                  deletion_previous_billing_status: sandbox.billing_status,
                  deletion_previous_shutdown_warning_sent_at: sandbox.shutdown_warning_sent_at,
                  deletion_previous_scheduled_shutdown_at: sandbox.scheduled_shutdown_at,
                }),
            // Gated on the BROADER continuation signal than the start time is.
            // `continuesEarlierDeletion` only checks `deletion_started_at`, and
            // nothing ties that column to `status`, so a row already sitting in
            // deletion_pending with null intent columns would take the "fresh"
            // branch and re-derive ownership from its OWN deletion status —
            // reading as "still counted" and freeing a slot on every recovery
            // sweep, the exact double-free this column exists to stop (#17185).
            ...(isDeletionContinuation(sandbox)
              ? {}
              : { deletion_allocation_counted: holdsCountedNodeSlot(sandbox) }),
            billing_status: "suspended" as const,
            scheduled_shutdown_at: null,
            shutdown_warning_sent_at: null,
            ...(isRecoveryReEnqueue ? {} : { error_count: 0 }),
            updated_at: new Date(),
          })
          .where(
            and(
              eq(agentSandboxes.id, params.agentId),
              eq(agentSandboxes.organization_id, params.organizationId),
              ...identityPredicates,
            ),
          )
          .returning({ id: agentSandboxes.id });
        if (owned.length !== 1) {
          throw new ApiError(409, "session_not_ready", "Agent identity changed before deletion");
        }

        if (cancelled.length > 0) {
          logger.info(
            "[provisioning-jobs] Cancelled quiescent pending jobs superseded by agent_delete",
            {
              agentId: params.agentId,
              orgId: params.organizationId,
              cancelledCount: cancelled.length,
            },
          );
        }
      },
    });
  }

  /**
   * Enqueue an Agent suspend job.
   *
   * Daemon-side execution: SSH `docker stop` on the assigned core, flip
   * `agent_sandboxes.status` to "stopped", clear `bridge_url`/`health_url`,
   * keep `sandbox_id` so the same container can be resumed.
   *
   * The Cloudflare Worker code path (cloud-api PATCH /eliza/agents/[id])
   * cannot SSH the Hetzner cores; this queue-based path moves the actual
   * docker stop off the Worker so the container is reliably stopped instead
   * of silently leaking with a stale DB row.
   */
  async enqueueAgentSuspendOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    authorization: "user_request" | "billing_request";
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
  }): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueLifecycleJob<AgentSuspendJobData>(this.agentSuspendLifecycleOptions(params));
  }

  /**
   * Transaction-scoped suspend enqueue for a caller that must commit its own
   * receipt and the exact intent/job binding atomically. Webhooks are excluded
   * because their URL validation performs network work outside transactions.
   */
  async enqueueAgentSuspendOnceInTransaction(
    tx: DbTransaction,
    params: {
      agentId: string;
      organizationId: string;
      userId: string;
      authorization: "user_request" | "billing_request";
      expectedLifecycleRevision?: number;
    },
  ): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueLifecycleJobInTx<AgentSuspendJobData>(
      tx,
      this.agentSuspendLifecycleOptions(params),
    );
  }

  /** Short compatibility alias for other transaction-scoped service helpers. */
  async enqueueAgentSuspendOnceInTx(
    tx: DbTransaction,
    params: {
      agentId: string;
      organizationId: string;
      userId: string;
      authorization: "user_request" | "billing_request";
      expectedLifecycleRevision?: number;
    },
  ): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueAgentSuspendOnceInTransaction(tx, params);
  }

  private agentSuspendLifecycleOptions(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    authorization: "user_request" | "billing_request";
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
  }): LifecycleJobOptions<AgentSuspendJobData> {
    let intentIdToBind: string | undefined;
    const expectedLifecycleRevision = params.expectedLifecycleRevision;
    const validateTarget = (sandbox: LifecycleSandboxRow): void => {
      if (sandbox.pool_status !== null || sandbox.deleted_at !== null) {
        throw new ApiError(404, "resource_not_found", "Agent not found");
      }
      if (
        expectedLifecycleRevision !== undefined &&
        sandbox.lifecycle_revision !== expectedLifecycleRevision
      ) {
        throw new ApiError(409, "session_not_ready", "Agent lifecycle changed before suspend", {
          expectedLifecycleRevision,
          currentLifecycleRevision: sandbox.lifecycle_revision,
        });
      }
    };
    return {
      jobType: JOB_TYPES.AGENT_SUSPEND,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        authorization: params.authorization,
        lifecycleRevision: expectedLifecycleRevision,
      },
      toRecord: agentSuspendJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      estimatedDurationMs: 30_000,
      logName: "agent_suspend",
      idempotencyPredicates:
        params.authorization === "user_request"
          ? [
              sql`${jobs.data}->>'authorization' = 'user_request'`,
              ...(expectedLifecycleRevision === undefined
                ? []
                : [sql`${jobs.data}->>'lifecycleRevision' = ${String(expectedLifecycleRevision)}`]),
            ]
          : [],
      resolveReplay: async (tx, sandbox) => {
        const targetRevision = expectedLifecycleRevision ?? sandbox.lifecycle_revision;
        const [exactIntent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              or(
                eq(agentComputeStopIntents.lifecycle_revision, targetRevision),
                ...(expectedLifecycleRevision === undefined
                  ? []
                  : [
                      sql`EXISTS (
                  SELECT 1 FROM ${jobs}
                  WHERE ${jobs.id} = ${agentComputeStopIntents.job_id}
                    AND ${jobs.organization_id} = ${params.organizationId}
                    AND ${jobs.agent_id} = ${params.agentId}
                    AND ${jobs.type} = 'agent_suspend'
                    AND ${jobs.data}->>'lifecycleRevision' = ${String(expectedLifecycleRevision)}
                )`,
                    ]),
              ),
              eq(agentComputeStopIntents.authorization, "user_request"),
              ...(params.authorization === "billing_request"
                ? [
                    inArray(agentComputeStopIntents.status, [
                      "pending",
                      "dispatching",
                      "retry",
                      "terminal_attention",
                    ]),
                  ]
                : []),
            ),
          )
          .for("update")
          .limit(1);
        if (exactIntent) {
          if (!exactIntent.job_id) {
            throw new Error("Agent user stop intent is not bound to a job");
          }
          const [exactJob] = await tx
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.id, exactIntent.job_id),
                eq(jobs.type, JOB_TYPES.AGENT_SUSPEND),
                eq(jobs.organization_id, params.organizationId),
                eq(jobs.agent_id, params.agentId),
              ),
            )
            .for("update")
            .limit(1);
          if (!exactJob) {
            throw new Error("Agent user stop intent references a missing job");
          }
          return exactJob;
        }
        if (params.authorization === "billing_request") return undefined;

        // Exact durable replay deliberately precedes this gate, because
        // the accepted stop may itself have advanced the generation.
        // A first-time request must validate the currently locked row
        // before it can promote any older billing authority.
        validateTarget(sandbox);

        // An unconditional user stop monotonically strengthens a queued
        // billing stop. Reuse the same operation instead of leaving an
        // independent billing job that can be superseded by a top-up.
        const [billingIntent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              eq(agentComputeStopIntents.lifecycle_revision, targetRevision),
              eq(agentComputeStopIntents.authorization, "billing_request"),
              inArray(agentComputeStopIntents.status, [
                "pending",
                "dispatching",
                "retry",
                "terminal_attention",
              ]),
            ),
          )
          .for("update")
          .limit(1);
        if (!billingIntent?.job_id) return undefined;
        const [billingJob] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, billingIntent.job_id),
              eq(jobs.type, JOB_TYPES.AGENT_SUSPEND),
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              sql`${jobs.status} IN ('pending', 'in_progress')`,
            ),
          )
          .for("update")
          .limit(1);
        if (!billingJob) return undefined;
        const now = new Date();
        await tx
          .update(agentComputeStopIntents)
          .set({ authorization: "user_request", updated_at: now })
          .where(eq(agentComputeStopIntents.id, billingIntent.id));
        // Do not rewrite the claimed job envelope. An executor may
        // already hold its hydrated snapshot and settlement CAS; the
        // locked intent is the monotonic authority boundary.
        if (billingJob.status === "pending") {
          const [immediate] = await tx
            .update(jobs)
            .set({ scheduled_for: now, updated_at: now })
            .where(and(eq(jobs.id, billingJob.id), eq(jobs.status, "pending")))
            .returning();
          if (!immediate) throw new Error("Promoted user stop lost its pending job");
          return immediate;
        }
        return billingJob;
      },
      validateSandbox: validateTarget,
      beforeInsert: async (tx, sandbox) => {
        const targetRevision = expectedLifecycleRevision ?? sandbox.lifecycle_revision;
        const [activeIntent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              inArray(agentComputeStopIntents.status, [
                "pending",
                "dispatching",
                "retry",
                "terminal_attention",
              ]),
            ),
          )
          .for("update")
          .limit(1);

        if (activeIntent && activeIntent.lifecycle_revision !== targetRevision) {
          const supersededAt = new Date();
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "superseded",
              last_error: "lifecycle_changed",
              superseded_at: supersededAt,
              updated_at: supersededAt,
            })
            .where(eq(agentComputeStopIntents.id, activeIntent.id));
        }

        if (activeIntent && activeIntent.lifecycle_revision === targetRevision) {
          const now = new Date();
          const authorization =
            activeIntent.authorization === "user_request" ? "user_request" : params.authorization;
          const [rearmed] = await tx
            .update(agentComputeStopIntents)
            .set({
              authorization,
              status: "pending",
              job_id: null,
              attempts: 0,
              last_error: null,
              provider_started_at: null,
              provider_confirmed_at: null,
              superseded_at: null,
              next_attempt_at: now,
              updated_at: now,
            })
            .where(eq(agentComputeStopIntents.id, activeIntent.id))
            .returning({ id: agentComputeStopIntents.id });
          intentIdToBind = rearmed?.id;
        } else {
          const [inserted] = await tx
            .insert(agentComputeStopIntents)
            .values({
              organization_id: params.organizationId,
              agent_id: params.agentId,
              lifecycle_revision: targetRevision,
              authorization: params.authorization,
            })
            .returning({ id: agentComputeStopIntents.id });
          intentIdToBind = inserted?.id;
        }
        if (!intentIdToBind) {
          throw new Error("Agent stop intent was not durably claimed");
        }
      },
      afterInsert: async (tx, _sandbox, job) => {
        if (!intentIdToBind) {
          throw new Error("Agent stop intent binding was lost before job insertion");
        }
        const bound = await tx
          .update(agentComputeStopIntents)
          .set({ job_id: job.id, updated_at: new Date() })
          .where(
            and(
              eq(agentComputeStopIntents.id, intentIdToBind),
              eq(agentComputeStopIntents.status, "pending"),
              isNull(agentComputeStopIntents.job_id),
            ),
          )
          .returning({ id: agentComputeStopIntents.id });
        if (bound.length !== 1) {
          throw new Error("Agent stop intent was not atomically bound to its job");
        }
      },
    };
  }

  /**
   * Enqueue an Agent resume job.
   *
   * Daemon-side execution re-runs `provision()` against the existing
   * sandbox row: this restores `bridge_url` / `health_url` from a fresh
   * sandbox handle and reuses the existing Neon DB (the `sandbox_id` is
   * retained across suspend). A faster `docker start` path will replace
   * the re-provision once `DockerSandboxProvider` exposes a standalone
   * `start()` that returns the handle.
   */
  async enqueueAgentResumeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
  }): Promise<EnqueueAgentResumeResult> {
    return this.enqueueLifecycleJob<AgentResumeJobData>({
      jobType: JOB_TYPES.AGENT_RESUME,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentResumeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // docker start is ~5s on the fast path; budget the full re-provision
      // path so the UI doesn't show a stuck estimate.
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_resume",
      beforeInsert: async (tx) => {
        const supersededAt = new Date();
        await tx
          .update(agentComputeStopIntents)
          .set({ status: "superseded", superseded_at: supersededAt, updated_at: supersededAt })
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              inArray(agentComputeStopIntents.status, [
                "pending",
                "dispatching",
                "retry",
                "terminal_attention",
              ]),
            ),
          );
      },
    });
  }

  /**
   * Enqueue an Agent sleep job (deep, cold suspend).
   *
   * Daemon-side execution: durable backup → stop+remove container → clear the
   * compute identity so the node slot frees (the autoscaler reclaims empty
   * Hetzner boxes). Distinct from `agent_suspend`, which keeps the container.
   */
  async enqueueAgentSleepOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
  }): Promise<EnqueueAgentSleepResult> {
    return this.enqueueLifecycleJob<AgentSleepJobData>({
      jobType: JOB_TYPES.AGENT_SLEEP,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentSleepJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // snapshot fetch (~15s) + docker stop (~5s) + DB update.
      estimatedDurationMs: 30_000,
      logName: "agent_sleep",
    });
  }

  /**
   * Enqueue an Agent wake job.
   *
   * Daemon-side execution runs the restore-integrity gate, then provisions a
   * fresh container (claiming a warm-pool slot when available) and restores
   * the validated backup. The inverse of `agent_sleep`. `restoreBackupId` /
   * `forceFreshBoot` are the explicit wake-route escape hatches (#15603 B6),
   * never defaults.
   */
  async enqueueAgentWakeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    restoreBackupId?: string;
    forceFreshBoot?: boolean;
  }): Promise<EnqueueAgentWakeResult> {
    const result = await this.enqueueLifecycleJob<AgentWakeJobData>({
      jobType: JOB_TYPES.AGENT_WAKE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        ...(params.restoreBackupId ? { restoreBackupId: params.restoreBackupId } : {}),
        ...(params.forceFreshBoot ? { forceFreshBoot: true } : {}),
      },
      toRecord: agentWakeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Fresh provision + state restore.
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_wake",
      // Reusing an in-flight wake keeps ITS params and drops the caller's. A
      // bare retry ("wake me") may ride whatever is already running, but a
      // request that names a restore point or forces a fresh boot is a
      // DIFFERENT operation — the integrity gate's own failure message tells
      // the user to retry with restoreBackupId, and silently reusing the very
      // job that just failed the gate would discard that choice (#15603 B6).
      validateReuse: (existing) => {
        if (params.restoreBackupId === undefined && !params.forceFreshBoot) return;
        const active = readAgentWakeJobData(existing);
        const sameParams =
          (active.restoreBackupId ?? null) === (params.restoreBackupId ?? null) &&
          (active.forceFreshBoot ?? false) === (params.forceFreshBoot ?? false);
        if (sameParams) return;
        throw new ApiError(
          409,
          "session_not_ready",
          `A wake job (${existing.id}) is already ${existing.status} for this agent with ` +
            "different restore parameters; wait for it to finish (poll " +
            `/api/v1/jobs/${existing.id}) and retry.`,
          {
            conflictingJobId: existing.id,
            activeRestoreBackupId: active.restoreBackupId ?? null,
            activeForceFreshBoot: active.forceFreshBoot ?? false,
            requestedRestoreBackupId: params.restoreBackupId ?? null,
            requestedForceFreshBoot: params.forceFreshBoot ?? false,
          },
        );
      },
    });
    const applied = readAgentWakeJobData(result.job);
    return {
      ...result,
      appliedRestoreBackupId: applied.restoreBackupId ?? null,
      appliedForceFreshBoot: applied.forceFreshBoot ?? false,
    };
  }

  /**
   * Enqueue an Agent restart job.
   *
   * Daemon-side execution: SSH `docker stop` on the existing container
   * if any, then full `provision()` to recreate it. Atomic on the
   * daemon side so two concurrent restarts can't interleave stop+start
   * out of order. Replaces the Worker-side `shutdown()` then
   * `provision()` sequence which silently no-op'd the stop (Workers
   * can't SSH) and left a stale container running alongside the new
   * one.
   */
  async enqueueAgentRestartOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    /** Operator waiver for a persistently failing pre-stop capture (#18228). */
    stateLossAcknowledged?: boolean;
  }): Promise<EnqueueAgentRestartResult> {
    return this.enqueueLifecycleJob<AgentRestartJobData>({
      jobType: JOB_TYPES.AGENT_RESTART,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        ...(params.stateLossAcknowledged ? { stateLossAcknowledged: true } : {}),
      },
      toRecord: agentRestartJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // shutdown ~5s + full provision; budget the long path.
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_restart",
    });
  }

  /**
   * Rolling migration and failure cleanup for the durable warm-claim fence.
   * Legacy rows are never backfilled ready: each is lifecycle-locked, moved to
   * pending, and restarted through the real remint/live-attest path. Failed
   * handoffs retain their cleanup record until both credential owners revoke.
   */
  async reconcileWarmClaimCredentialFences(limit = 5): Promise<WarmClaimCredentialReconcileResult> {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const cleanupCandidates =
      await agentSandboxesRepository.listFailedWarmClaimCredentialCleanupCandidates(boundedLimit);
    let cleanupCompleted = 0;
    let cleanupFailed = 0;
    for (const candidate of cleanupCandidates) {
      try {
        if (
          await elizaSandboxService.cleanupFailedWarmClaimCredentialHandoff(
            candidate.id,
            candidate.organization_id,
          )
        ) {
          cleanupCompleted += 1;
        }
      } catch (error) {
        // error-policy:J7 Each failed row remains durably selectable for the
        // next daemon pass; report it without starving unrelated cleanups.
        cleanupFailed += 1;
        logger.error("[provisioning-jobs] Warm-claim credential cleanup failed", {
          agentId: candidate.id,
          orgId: candidate.organization_id,
          error: jobErrorText(error),
        });
      }
    }

    const legacyCandidates =
      await agentSandboxesRepository.listLegacyWarmClaimRecoveryCandidates(boundedLimit);
    let recoveryEnqueued = 0;
    let recoveryInFlight = 0;
    let recoveryDeferred = 0;
    for (const candidate of legacyCandidates) {
      try {
        const result = await this.enqueueLifecycleJob<AgentRestartJobData>({
          jobType: JOB_TYPES.AGENT_RESTART,
          jobData: {
            agentId: candidate.id,
            organizationId: candidate.organization_id,
            userId: candidate.user_id,
          },
          toRecord: agentRestartJobDataToRecord,
          agentId: candidate.id,
          organizationId: candidate.organization_id,
          userId: candidate.user_id,
          maxAttempts: 3,
          estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
          logName: "legacy_warm_claim_recovery",
          mutuallyExclusiveJobTypes: [
            ...ADMIN_CANARY_CONFLICTING_JOB_TYPES,
            ...SHARED_IMAGE_CHANGE_JOB_TYPES,
          ],
          validateSandbox: (sandbox) => {
            if (
              !["running", "provisioning", "stopped", "error"].includes(sandbox.status) ||
              !sandbox.claimed_at ||
              sandbox.warm_claim_credential_state !== null ||
              sandbox.user_id !== candidate.user_id
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} is no longer a legacy warm-claim candidate`,
              );
            }
          },
          beforeInsert: async (tx) => {
            const prepared = await tx.execute<{ id: string }>(sql`
              UPDATE ${agentSandboxes}
              SET
                status = 'provisioning',
                warm_claim_credential_state = 'pending',
                warm_claim_source_pool_id = NULL,
                warm_claim_key_fingerprint = NULL,
                warm_claim_attested_at = NULL,
                warm_claim_attested_environment_revision = NULL,
                warm_claim_cleanup_completed_at = NULL,
                error_message = 'Legacy warm claim requires credential and image re-attestation',
                updated_at = NOW()
              WHERE id = ${candidate.id}
                AND organization_id = ${candidate.organization_id}
                AND user_id = ${candidate.user_id}
                AND status IN ('running', 'provisioning', 'stopped', 'error')
                AND claimed_at IS NOT NULL
                AND warm_claim_credential_state IS NULL
              RETURNING id
            `);
            if (prepared.rows.length !== 1) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} changed before legacy warm-claim recovery enqueue`,
              );
            }
          },
        });
        if (result.created) recoveryEnqueued += 1;
        else recoveryInFlight += 1;
      } catch (error) {
        // error-policy:J1 per-candidate recovery boundary — a concurrent
        // ownership change becomes an explicit deferred count; other failures surface.
        if (error instanceof ApiError && error.status === 409) {
          recoveryDeferred += 1;
          continue;
        }
        throw error;
      }
    }

    const strandedCutoff = new Date(Date.now() - WARM_CLAIM_RECOVERY_ORPHAN_GRACE_MS);
    const strandedLimit = boundedLimit - legacyCandidates.length;
    const strandedCandidates =
      strandedLimit > 0
        ? await agentSandboxesRepository.listStrandedWarmClaimRecoveryCandidates(
            strandedCutoff,
            strandedLimit,
          )
        : [];
    for (const candidate of strandedCandidates) {
      try {
        const result = await this.enqueueLifecycleJob<AgentRestartJobData>({
          jobType: JOB_TYPES.AGENT_RESTART,
          jobData: {
            agentId: candidate.id,
            organizationId: candidate.organization_id,
            userId: candidate.user_id,
          },
          toRecord: agentRestartJobDataToRecord,
          agentId: candidate.id,
          organizationId: candidate.organization_id,
          userId: candidate.user_id,
          maxAttempts: 3,
          estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
          logName: "stranded_warm_claim_recovery",
          mutuallyExclusiveJobTypes: [
            ...ADMIN_CANARY_CONFLICTING_JOB_TYPES,
            ...SHARED_IMAGE_CHANGE_JOB_TYPES,
          ],
          validateSandbox: (sandbox) => {
            if (
              !sandbox.claimed_at ||
              (sandbox.warm_claim_credential_state !== "pending" &&
                sandbox.warm_claim_credential_state !== "attested") ||
              sandbox.user_id !== candidate.user_id ||
              !sandbox.updated_at ||
              sandbox.updated_at >= strandedCutoff
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} is no longer a stranded warm-claim recovery`,
              );
            }
          },
          beforeInsert: async (tx) => {
            const prepared = await tx.execute<{ id: string }>(sql`
              UPDATE ${agentSandboxes}
              SET
                status = 'provisioning',
                error_message = 'Warm-claim credential recovery restart was re-enqueued',
                updated_at = NOW()
              WHERE id = ${candidate.id}
                AND organization_id = ${candidate.organization_id}
                AND user_id = ${candidate.user_id}
                AND claimed_at IS NOT NULL
                AND warm_claim_credential_state IN ('pending', 'attested')
                AND deleted_at IS NULL
              RETURNING id
            `);
            if (prepared.rows.length !== 1) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} changed before stranded warm-claim recovery enqueue`,
              );
            }
          },
        });
        if (result.created) recoveryEnqueued += 1;
        else recoveryInFlight += 1;
      } catch (error) {
        // error-policy:J1 per-candidate recovery boundary — a concurrent
        // ownership change becomes an explicit deferred count; other failures surface.
        if (error instanceof ApiError && error.status === 409) {
          recoveryDeferred += 1;
          continue;
        }
        throw error;
      }
    }

    return {
      legacyFound: legacyCandidates.length,
      strandedFound: strandedCandidates.length,
      recoveryEnqueued,
      recoveryInFlight,
      recoveryDeferred,
      cleanupFound: cleanupCandidates.length,
      cleanupCompleted,
      cleanupFailed,
    };
  }

  /**
   * Retry exact-node retirement records left by an interrupted or unreachable
   * replacement. Rows stay fenced until container and VPN absence plus the
   * capacity release commit together.
   */
  async reconcileReplacementCleanupFences(limit = 5) {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    return elizaSandboxService.reconcileReplacementCleanupFences(boundedLimit);
  }

  /**
   * Fleet-upgrade: enqueue a blue/green swap of `agentId` onto `toDigest`.
   * Called by the reconciler when a registry probe sees the configured tag
   * has moved. The handler provisions a new container on the least-loaded
   * node (or autoscales) with the new image, waits for it to be healthy,
   * atomically swaps the agent's bridge_url / node_id / container_name /
   * image_digest, then gracefully stops the old container (30s SIGTERM
   * drain).
   *
   * Idempotency: the reconciler's per-agent `agent_upgrade` lookup dedups
   * before calling this (one pending or in-flight upgrade per agent at a
   * time). `enqueueLifecycleJob` adds a second layer via the
   * `active_provision_agent_idx` style guard.
   */
  async enqueueAgentUpgradeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    dockerImage: string;
    fromDigest: string | null;
    toDigest: string;
    webhookUrl?: string;
  }): Promise<{ created: boolean; job: Job }> {
    return this.enqueueLifecycleJob<AgentUpgradeJobData>({
      jobType: JOB_TYPES.AGENT_UPGRADE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        dockerImage: params.dockerImage,
        fromDigest: params.fromDigest,
        toDigest: params.toDigest,
      },
      toRecord: agentUpgradeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Full provision on a possibly fresh node (~60-90s) + health probe
      // (~30s) + atomic DB swap + 30s graceful stop = ~3 min budget.
      estimatedDurationMs: 180_000,
      logName: "agent_upgrade",
      mutuallyExclusiveJobTypes: SHARED_IMAGE_CHANGE_JOB_TYPES,
      validateSandbox: (sandbox) => {
        if (sandbox.status !== "running") {
          throw new ApiError(409, "session_not_ready", `Agent ${params.agentId} is not running`);
        }
        if (!hasReadyWarmClaimCredential(sandbox)) {
          throw new ApiError(
            409,
            "session_not_ready",
            `Agent ${params.agentId} warm-claim credential handoff is not ready`,
          );
        }
      },
    });
  }

  /**
   * Atomically enqueue one explicit super-admin canary rollout. A single
   * transaction owns the global rollout lock and every target's lifecycle lock,
   * so a bad fifth target cannot leave four accepted jobs behind.
   */
  async enqueueAdminCanaryImageRollout(params: {
    rolloutId: string;
    actorUserId: string;
    decisionAt: string;
    requestId: string;
    planFingerprint: string;
    canonicalRequestHash: string;
    targets: AdminCanaryPlannedTarget[];
  }): Promise<{ jobs: Job[]; created: boolean }> {
    if (params.targets.length < 1 || params.targets.length > ADMIN_CANARY_MAX_TARGETS) {
      throw new ApiError(
        400,
        "validation_error",
        `Canary rollout must contain between 1 and ${ADMIN_CANARY_MAX_TARGETS} targets`,
      );
    }

    const prepared = params.targets.map((target) => {
      const data: AdminCanaryImageJobData = {
        ...target,
        rolloutId: params.rolloutId,
        actorUserId: params.actorUserId,
        userId: params.actorUserId,
        decisionAt: params.decisionAt,
        requestId: params.requestId,
        planFingerprint: params.planFingerprint,
        canonicalRequestHash: params.canonicalRequestHash,
      };
      assertAdminCanaryImageJobData(data);
      return data;
    });
    const uniqueTargets = new Set(
      prepared.map((target) => `${target.organizationId}:${target.agentId}`),
    );
    if (uniqueTargets.size !== prepared.length) {
      throw new ApiError(400, "validation_error", "Canary rollout contains duplicate targets");
    }

    return await dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaAdminCanaryRolloutAdvisoryLockSql());

      const replay = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            eq(jobs.user_id, params.actorUserId),
            sql`${jobs.data}->>'requestId' = ${params.requestId}`,
          ),
        )
        .orderBy(jobs.created_at, jobs.id);
      if (replay.length > 0) {
        for (const job of replay) {
          const data = readAdminCanaryImageJobData(job);
          assertRecoverableAdminCanaryImageJobData(data);
          if (
            data.actorUserId !== params.actorUserId ||
            data.userId !== params.actorUserId ||
            data.requestId !== params.requestId ||
            data.organizationId !== job.organization_id ||
            data.agentId !== job.agent_id
          ) {
            throw new Error(`Admin canary request ${params.requestId} has inconsistent identity`);
          }
          if (
            data.canonicalRequestHash !== params.canonicalRequestHash ||
            data.planFingerprint !== params.planFingerprint
          ) {
            throw new ApiError(
              409,
              "session_not_ready",
              "requestId was already used for a different canary request",
              { requestId: params.requestId },
            );
          }
        }
        return { jobs: replay, created: false };
      }

      const [activeCanary] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            sql`${jobs.status} IN ('pending', 'in_progress')`,
          ),
        );
      if (!activeCanary) {
        throw new Error("Admin canary active-job query returned no aggregate row");
      }
      if (activeCanary.count > 0) {
        throw new ApiError(
          409,
          "session_not_ready",
          "Another admin canary rollout is still pending or running",
        );
      }

      const inserted: Job[] = [];
      const ordered = [...prepared].sort((a, b) =>
        `${a.organizationId}:${a.agentId}`.localeCompare(`${b.organizationId}:${b.agentId}`),
      );
      for (const data of ordered) {
        const result = await this.enqueueLifecycleJobInTx<AdminCanaryImageJobData>(tx, {
          jobType: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
          jobData: data,
          toRecord: adminCanaryImageJobDataToRecord,
          agentId: data.agentId,
          organizationId: data.organizationId,
          userId: data.actorUserId,
          maxAttempts: 1,
          estimatedDurationMs: 180_000,
          logName: "agent_admin_canary_image",
          mutuallyExclusiveJobTypes: SHARED_IMAGE_CHANGE_JOB_TYPES,
          logExtras: {
            rolloutId: data.rolloutId,
            operation: data.operation,
            actorUserId: data.actorUserId,
            sourceImage: data.sourceImage,
            sourceDigest: data.sourceDigest,
            targetImage: data.targetImage,
            targetDigest: data.targetDigest,
          },
          validateSandbox: (sandbox) => {
            if (
              sandbox.status !== "running" ||
              !sandbox.sandbox_id ||
              !sandbox.node_id ||
              !sandbox.container_name
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} is not a running dedicated sandbox`,
              );
            }
            if (!hasReadyWarmClaimCredential(sandbox)) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} warm-claim credential handoff is not ready`,
              );
            }
            if (sandbox.user_id !== data.targetOwnerUserId) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} owner changed after preview`,
              );
            }
            if (
              !sandbox.docker_image ||
              !sandbox.image_digest ||
              sandbox.docker_image !== data.sourceImage ||
              sandbox.image_digest !== data.sourceDigest
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} source image changed after preview`,
              );
            }
            if (
              data.operation === "rollback" &&
              (!sandbox.previous_docker_image ||
                !sandbox.previous_image_digest ||
                sandbox.previous_docker_image !== data.targetImage ||
                sandbox.previous_image_digest !== data.targetDigest)
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} rollback pair changed after preview`,
              );
            }
          },
          validateReuse: (existing) => {
            throw new ApiError(
              409,
              "session_not_ready",
              `Canary image job ${existing.id} is already active for agent ${data.agentId}`,
              { conflictingJobId: existing.id },
            );
          },
          beforeInsert: async (transaction) => {
            const [conflict] = await transaction
              .select({
                id: jobs.id,
                type: jobs.type,
                status: jobs.status,
              })
              .from(jobs)
              .where(
                and(
                  eq(jobs.organization_id, data.organizationId),
                  eq(jobs.agent_id, data.agentId),
                  inArray(jobs.type, ADMIN_CANARY_CONFLICTING_JOB_TYPES),
                  sql`${jobs.status} IN ('pending', 'in_progress')`,
                ),
              )
              .limit(1);
            if (conflict) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} has conflicting ${conflict.type} job ${conflict.id}`,
                {
                  conflictingJobId: conflict.id,
                  conflictingJobType: conflict.type,
                  conflictingJobStatus: conflict.status,
                },
              );
            }
          },
        });
        if (!result.created) {
          throw new Error(`Admin canary enqueue unexpectedly reused job ${result.job.id}`);
        }
        inserted.push(result.job);
      }
      return { jobs: inserted, created: true };
    });
  }

  /**
   * Enqueue an explicit agent rollback (downgrade) onto the agent's persisted
   * `previous_image_digest`. Unlike upgrade, this is never enqueued by the
   * reconciler — it's an operator/owner action after a bad upgrade. The
   * `pre-upgrade` snapshot is restored before cutover by `executeDowngrade`.
   */
  async enqueueAgentDowngradeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    dockerImage: string;
    fromDigest: string;
    webhookUrl?: string;
  }): Promise<EnqueueAgentDowngradeResult> {
    return this.enqueueLifecycleJob<AgentDowngradeJobData>({
      jobType: JOB_TYPES.AGENT_DOWNGRADE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        dockerImage: params.dockerImage,
        fromDigest: params.fromDigest,
      },
      toRecord: agentDowngradeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 1,
      // Same blue/green budget as upgrade + a pre-cutover snapshot restore.
      estimatedDurationMs: 180_000,
      logName: "agent_downgrade",
      logExtras: { fromDigest: params.fromDigest },
      idempotencyPredicates: [sql`${jobs.data}->>'fromDigest' = ${params.fromDigest}`],
    });
  }

  /**
   * Enqueue an Agent logs read job.
   *
   * Daemon-side execution: SSH `docker logs --tail <N>` on the assigned
   * core and persist the captured stdout/stderr into `jobs.result`.
   * Replaces the Worker-side `fetch(bridge_url + "/logs")` path which
   * returned empty for any non-running container (the bridge HTTP
   * endpoint is gone when the agent is stopped or crashed).
   *
   * In-flight reuse: a second logs request on the same agent while one
   * is still executing returns the existing job rather than spawning a
   * duplicate. Completed jobs are NOT reused — the user asking again
   * after a result has landed wants fresh logs.
   */
  async enqueueAgentLogsOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    tail: number;
    webhookUrl?: string;
  }): Promise<EnqueueAgentLogsResult> {
    return this.enqueueLifecycleJob<AgentLogsJobData>({
      jobType: JOB_TYPES.AGENT_LOGS,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        tail: params.tail,
      },
      toRecord: agentLogsJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 2,
      estimatedDurationMs: 15_000,
      logName: "agent_logs",
      logExtras: { tail: params.tail },
      idempotencyPredicates: [sql`${jobs.data}->>'tail' = ${String(params.tail)}`],
    });
  }

  /**
   * Enqueue a single patron chat turn for daemon-side delivery to the agent
   * bridge. Each turn carries a unique `nonce` used as the idempotency
   * predicate, so every message ALWAYS creates a fresh job (chat turns are
   * never deduped). The caller (the synchronous /api/v1/agents/:id/message
   * route) then polls the job row for the AgentMessageJobResult.
   */
  async enqueueAgentMessage(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    text: string;
    senderId?: string;
    sessionId?: string;
    roomId?: string;
    webhookUrl?: string;
  }): Promise<{ created: boolean; job: Job }> {
    const nonce = crypto.randomUUID();
    return this.enqueueLifecycleJob<AgentMessageJobData>({
      jobType: JOB_TYPES.AGENT_MESSAGE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        text: params.text,
        ...(params.senderId ? { senderId: params.senderId } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.roomId ? { roomId: params.roomId } : {}),
        nonce,
      },
      toRecord: agentMessageJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 1,
      estimatedDurationMs: 60_000,
      logName: "agent_message",
      // Unique-per-turn predicate guarantees no reuse of an existing job.
      idempotencyPredicates: [sql`${jobs.data}->>'nonce' = ${nonce}`],
    });
  }

  /**
   * Enqueue an Agent snapshot job.
   *
   * Daemon-side execution: pulls runtime state from the bridge URL and
   * persists a row in `agent_sandbox_backups`. Same operation as the
   * Worker-side `snapshot()` path, but run from the daemon so it
   * survives bridge HTTP being unreachable from CF Workers (firewall,
   * SSRF guard) and consistently uses the same network identity for
   * outbound traffic to cores.
   */
  async enqueueAgentSnapshotOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    snapshotType?: "manual" | "auto";
    webhookUrl?: string;
  }): Promise<EnqueueAgentSnapshotResult> {
    const snapshotType = params.snapshotType ?? "manual";
    return this.enqueueLifecycleJob<AgentSnapshotJobData>({
      jobType: JOB_TYPES.AGENT_SNAPSHOT,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        snapshotType,
      },
      toRecord: agentSnapshotJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 2,
      estimatedDurationMs: 45_000,
      logName: "agent_snapshot",
      logExtras: { snapshotType },
      idempotencyPredicates: [sql`${jobs.data}->>'snapshotType' = ${snapshotType}`],
      validateSandbox: (sandbox) => {
        const rejection = snapshotAuthorityRejection(sandbox);
        if (rejection) {
          throw new ApiError(409, "session_not_ready", rejection);
        }
      },
    });
  }

  /**
   * Stamp `last_backup_attempt_at` and set/clear `backup_unsupported_reason`
   * after a snapshot capture attempt (#15783). Best-effort bookkeeping: a
   * marker write failure must not fail (or retry) the snapshot job itself —
   * the markers only tune sweep fairness and staleness measurement, and the
   * next attempt rewrites them.
   */
  private async recordSnapshotAttemptMarkers(
    agentId: string,
    outcome: "success" | "unsupported" | "other",
  ): Promise<void> {
    try {
      await dbWrite
        .update(agentSandboxes)
        .set({
          last_backup_attempt_at: new Date(),
          // "other" failures (agent not running, transport blip) neither prove
          // nor disprove snapshot capability — leave the marker as it stands.
          ...(outcome === "unsupported"
            ? { backup_unsupported_reason: SNAPSHOT_ENDPOINT_UNSUPPORTED }
            : {}),
          ...(outcome === "success" ? { backup_unsupported_reason: null } : {}),
        })
        .where(eq(agentSandboxes.id, agentId));
    } catch (error) {
      // error-policy:J7 attempt-marker bookkeeping must not kill the snapshot
      // job; the condition it records is re-observed on the next attempt.
      logger.warn("[provisioning-jobs] failed to record snapshot attempt markers", {
        agentId,
        error: jobErrorText(error),
      });
    }
  }

  /**
   * Scan running agents and enqueue an `auto` snapshot for any whose last
   * backup is older than `minIntervalMs` (or who have never been backed up).
   * Drives the scheduled-backups cron. Per-agent dedup is handled by the
   * snapshot job's in-flight idempotency, so overlapping ticks are safe.
   * Warm-pool rows (`pool_status IS NOT NULL`) are excluded — they have no
   * user state worth backing up.
   *
   * Fairness (#15783): the due set is ordered oldest-successful-backup-first
   * (never-backed-up rows first), so a due population larger than `maxAgents`
   * degrades to round-robin-by-staleness instead of planner-dependent
   * starvation. Rows marked snapshot-incapable (`backup_unsupported_reason`,
   * set when the agent image 404s POST /api/snapshot) are re-probed only
   * every `unsupportedRecheckMs` instead of consuming the capped window on
   * every tick; `last_backup_at` stays success-only throughout so staleness
   * measurement remains honest.
   *
   * The returned `fleet` block is the Phase 0 measurement: how much of the
   * running non-pool fleet is route-less, snapshot-incapable, never backed
   * up, or stale — and how many LOCAL-STATE agents (whose entire DB lives on
   * one node's disk) currently have no backup younger than the staleness
   * threshold. A non-zero local-state count triggers the ops staleness alert.
   */
  async enqueueScheduledBackups(params?: {
    minIntervalMs?: number;
    maxAgents?: number;
    /** How often a snapshot-incapable row is re-probed. Default 24h. */
    unsupportedRecheckMs?: number;
    /**
     * Age past which a running agent's newest successful backup counts as
     * stale for alerting. Default 4× `minIntervalMs` (24h at the 6h cadence).
     */
    staleAfterMs?: number;
  }): Promise<{
    scanned: number;
    enqueued: number;
    fleet: ScheduledBackupFleetReport;
  }> {
    const minIntervalMs = params?.minIntervalMs ?? 6 * 60 * 60 * 1000; // 6h
    const maxAgents = params?.maxAgents ?? 200;
    const unsupportedRecheckMs = params?.unsupportedRecheckMs ?? 24 * 60 * 60 * 1000;
    const staleAfterMs = params?.staleAfterMs ?? 4 * minIntervalMs;
    const cutoff = new Date(Date.now() - minIntervalMs);
    const unsupportedRecheckCutoff = new Date(Date.now() - unsupportedRecheckMs);
    const staleCutoff = new Date(Date.now() - staleAfterMs);

    const due = await dbWrite
      .select({
        id: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
        userId: agentSandboxes.user_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          sql`${agentSandboxes.pool_status} IS NULL`,
          // Only enqueue agents that are actually reachable. A `running` row with
          // no bridge_url (shared-runtime / web-only agents, or a row whose
          // bridge was cleared) has no live state endpoint to snapshot — the
          // snapshot would just fail with "Sandbox is not running" and burn
          // retries. Requiring bridge_url keeps those out of the queue entirely.
          sql`${agentSandboxes.bridge_url} IS NOT NULL`,
          // Belt-and-suspenders for the E2E fixture sentinel (#15737): even a
          // `running` row with a non-null bridge_url is unreachable when that
          // URL is the loopback sentinel, so it must never be re-enqueued.
          ne(agentSandboxes.bridge_url, UNREACHABLE_BRIDGE_SENTINEL),
          sql`(${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${cutoff})`,
          // A row whose image proved snapshot-incapable is only re-probed at
          // the slow recheck cadence, so it cannot permanently occupy the
          // capped window (#15783 starvation, worst case 3). An image upgrade
          // is still noticed within one recheck interval, and any successful
          // snapshot clears the marker immediately.
          sql`(${agentSandboxes.backup_unsupported_reason} IS NULL OR ${agentSandboxes.last_backup_attempt_at} IS NULL OR ${agentSandboxes.last_backup_attempt_at} < ${unsupportedRecheckCutoff})`,
        ),
      )
      // Oldest successful backup first; rows that have NEVER been backed up
      // lead. Attempt time tiebreaks so equally-stale rows rotate instead of
      // repeating in planner order.
      .orderBy(
        sql`${agentSandboxes.last_backup_at} ASC NULLS FIRST`,
        sql`${agentSandboxes.last_backup_attempt_at} ASC NULLS FIRST`,
      )
      .limit(maxAgents);

    const [fleet = EMPTY_SCHEDULED_BACKUP_FLEET_REPORT] = (await dbWrite
      .select({
        running: sql<number>`count(*)::int`,
        routeless: sql<number>`count(*) filter (where ${agentSandboxes.bridge_url} IS NULL OR ${agentSandboxes.bridge_url} = ${UNREACHABLE_BRIDGE_SENTINEL})::int`,
        snapshotUnsupported: sql<number>`count(*) filter (where ${agentSandboxes.backup_unsupported_reason} IS NOT NULL)::int`,
        neverBackedUp: sql<number>`count(*) filter (where ${agentSandboxes.last_backup_at} IS NULL)::int`,
        staleBackup: sql<number>`count(*) filter (where ${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${staleCutoff})::int`,
        localState: sql<number>`count(*) filter (where ${agentSandboxes.environment_vars}->>'ELIZA_AGENT_LOCAL_STATE' = '1')::int`,
        localStateStale: sql<number>`count(*) filter (where ${agentSandboxes.environment_vars}->>'ELIZA_AGENT_LOCAL_STATE' = '1' AND (${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${staleCutoff}))::int`,
      })
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.status, "running"), sql`${agentSandboxes.pool_status} IS NULL`),
      )) as ScheduledBackupFleetReport[];

    if (fleet.localStateStale > 0) {
      // Local-state agents keep their ENTIRE state (PGlite DB, media, vault)
      // on one node's local disk; a stale backup there is an unbounded-loss
      // exposure, not a cosmetic gap. Loud by design; the fixed dedup key
      // keeps a sustained condition to one PagerDuty incident.
      await sendProvisioningWorkerAlert({
        title: "Local-state agents with stale or missing off-box backups",
        message: `${fleet.localStateStale} running local-state agent(s) have no successful backup within ${Math.round(staleAfterMs / 60_000)} minutes; node loss would exceed the backup RPO (#15783).`,
        details: { ...fleet, staleAfterMs, minIntervalMs },
        dedupKey: "agent-backup-staleness",
      });
    }

    let enqueued = 0;
    for (const agent of due) {
      try {
        await this.enqueueAgentSnapshotOnce({
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: agent.userId,
          snapshotType: "auto",
        });
        enqueued++;
      } catch (error) {
        logger.warn("[provisioning-jobs] Scheduled backup enqueue failed", {
          agentId: agent.id,
          error: jobErrorText(error),
        });
      }
    }

    logger.info("[provisioning-jobs] Scheduled backups enqueued", {
      scanned: due.length,
      enqueued,
      fleet,
    });
    return { scanned: due.length, enqueued, fleet };
  }

  /**
   * Best-effort kick of the provisioning worker without waiting for its next
   * daemon poll. Callers running inside a Worker must register this promise
   * with `waitUntil`; the durable job and daemon poll remain authoritative.
   */
  async triggerImmediate(env?: {
    CONTAINER_CONTROL_PLANE_TOKEN?: string;
    CONTAINER_CONTROL_PLANE_URL?: string;
    CONTAINER_SIDECAR_URL?: string;
    DATABASE_URL?: string;
    HETZNER_CONTAINER_CONTROL_PLANE_URL?: string;
  }): Promise<void> {
    const controlPlaneBaseUrl =
      env?.CONTAINER_CONTROL_PLANE_URL ??
      env?.CONTAINER_SIDECAR_URL ??
      env?.HETZNER_CONTAINER_CONTROL_PLANE_URL ??
      process.env.CONTAINER_CONTROL_PLANE_URL ??
      process.env.CONTAINER_SIDECAR_URL ??
      process.env.HETZNER_CONTAINER_CONTROL_PLANE_URL;
    const controlPlaneToken =
      env?.CONTAINER_CONTROL_PLANE_TOKEN ?? process.env.CONTAINER_CONTROL_PLANE_TOKEN;
    const databaseUrl = env?.DATABASE_URL ?? process.env.DATABASE_URL;

    if (controlPlaneBaseUrl && controlPlaneToken && databaseUrl) {
      try {
        const target = new URL(controlPlaneBaseUrl);
        target.pathname = "/api/v1/cron/process-provisioning-jobs";
        target.search = "?limit=5";
        const response = await fetch(target, {
          method: "POST",
          headers: {
            "x-container-control-plane-token": controlPlaneToken,
            "x-eliza-cloud-database-url": databaseUrl,
            "user-agent": "agent-provision-trigger/1.0",
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
          throw new ElizaError("The provisioning control plane rejected the immediate nudge", {
            code: "PROVISIONING_IMMEDIATE_TRIGGER_REJECTED",
            context: {
              target: "control-plane",
              status: response.status,
            },
          });
        }
        return;
      } catch (err) {
        logger.debug("[provisioning-jobs] direct triggerImmediate failed", {
          error: jobErrorText(err),
        });
        throw err;
      }
    }
  }

  /**
   * Get a job by ID (for status polling).
   */
  async getJob(jobId: string): Promise<Job | undefined> {
    return jobsRepository.findById(jobId);
  }

  /**
   * Get a job by ID scoped to a single organization.
   */
  async getJobForOrg(jobId: string, organizationId: string): Promise<Job | undefined> {
    return jobsRepository.findByIdAndOrg(jobId, organizationId);
  }

  /**
   * Get jobs for an organization, optionally filtered by type.
   */
  async getJobsForOrg(
    organizationId: string,
    type?: ProvisioningJobType,
    limit = 20,
  ): Promise<Job[]> {
    return jobsRepository.findByFilters({
      organizationId,
      type,
      limit,
      orderBy: "desc",
    });
  }

  /** Active agent lifecycle jobs used to restore truthful UI polling after reload. */
  async getActiveAgentLifecycleJobsForOrg(organizationId: string): Promise<Job[]> {
    return jobsRepository.findActiveAgentLifecycleJobsForOrg(organizationId);
  }

  // ---------------------------------------------------------------------------
  // Processing (called by cron)
  // ---------------------------------------------------------------------------

  private startExecutionLeaseHeartbeat(job: Job): () => void {
    let renewalInFlight = false;
    const timer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void jobsRepository
        .renewExecutionLease(job, this.executionOwnerId, this.leaseDurationForJobType(job.type))
        .then((outcome) => {
          if (outcome !== "renewed") {
            clearInterval(timer);
            if (outcome === "lost") {
              logger.warn("[provisioning-jobs] Execution lease ownership was lost", {
                jobId: job.id,
                executionGeneration: job.execution_generation,
                executionOwnerId: this.executionOwnerId,
              });
            } else {
              logger.debug("[provisioning-jobs] Lease heartbeat stopped after settlement", {
                jobId: job.id,
              });
            }
          }
        })
        .catch((error) => {
          // error-policy:J7 lease diagnostics must not terminate the worker;
          // mutation guards and settlement CAS fail closed if renewal cannot recover.
          logger.warn("[provisioning-jobs] Execution lease renewal failed; retrying", {
            jobId: job.id,
            executionGeneration: job.execution_generation,
            executionOwnerId: this.executionOwnerId,
            error: jobErrorText(error),
          });
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, this.executionLeaseHeartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async waitForSettlementRetry(attempt: number): Promise<void> {
    const delay = Math.min(
      SETTLEMENT_RETRY_MAX_MS,
      this.settlementRetryBaseMs * 2 ** Math.min(attempt - 1, 8),
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      timer.unref?.();
    });
  }

  private async retryOwnedWrite<T>(
    job: Job,
    operation: string,
    write: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await write();
      } catch (error) {
        if (error instanceof StaleJobExecutionError) {
          const renewed = await jobsRepository.renewExecutionLease(
            job,
            this.executionOwnerId,
            this.leaseDurationForJobType(job.type),
          );
          if (renewed !== "renewed") throw error;
          continue;
        }
        attempt++;
        logger.warn("[provisioning-jobs] Owned execution write failed; retrying", {
          jobId: job.id,
          executionGeneration: job.execution_generation,
          executionOwnerId: this.executionOwnerId,
          operation,
          attempt,
          error: jobErrorText(error),
        });
        await this.waitForSettlementRetry(attempt);
      }
    }
  }

  private async assertExecutionMutationLease(job: Job): Promise<void> {
    try {
      await jobsRepository.assertExecutionLease(job, this.executionOwnerId);
    } catch (error) {
      if (
        !(error instanceof StaleJobExecutionError) ||
        (await jobsRepository.renewExecutionLease(
          job,
          this.executionOwnerId,
          this.leaseDurationForJobType(job.type),
        )) !== "renewed"
      ) {
        throw error;
      }
      await jobsRepository.assertExecutionLease(job, this.executionOwnerId);
    }
  }

  private leaseDurationForJobType(jobType: string): number {
    // A provider mutation already in flight cannot be remotely cancelled, so
    // takeover remains barred through the full local execution timeout. Regular
    // heartbeats extend this window for legitimately detached work.
    //
    // A crashed worker's claim remains protected for this duration plus the
    // 30-second takeover grace. The 16-minute cold-boot window prevents a
    // replacement from reclaiming work that may still be mutating a provider.
    return Math.max(
      this.executionLeaseMs,
      this.executionTimeoutMs(jobType) + 2 * this.executionLeaseHeartbeatMs,
    );
  }

  private async updateClaimedExecution(job: Job, updates: Partial<Job>): Promise<Job> {
    return await this.retryOwnedWrite(job, "update", () =>
      jobsRepository.updateForExecution(job, updates, this.executionOwnerId),
    );
  }

  private async settleClaimedExecution(
    job: Job,
    status: "completed" | "cancelled",
    updates?: Partial<Job>,
  ): Promise<void> {
    const settledUpdates =
      status === "completed"
        ? {
            ...updates,
            // A retry that succeeds must not retain the prior attempt's error
            // beside a completed receipt. Keep the payload metadata canonical
            // too, including when the failed attempt externalized its error.
            error: null,
            error_storage: "inline" as const,
            error_key: null,
          }
        : updates;
    await this.retryOwnedWrite(job, "settle", () =>
      jobsRepository.settleExecution(job, status, settledUpdates, this.executionOwnerId),
    );
  }

  /**
   * Settles a successful delete from the authority snapshot protected by the
   * same lifecycle lock as acknowledgement upgrades. A lost data fence loops
   * only while this exact execution generation still owns its renewable lease.
   */
  private async settleCompletedAgentDelete(
    job: Job,
    claimedData: AgentDeleteJobData,
    result: { containerStopped: boolean; rowDeleted: boolean },
  ): Promise<AgentDeleteJobResult> {
    while (true) {
      const current = await jobsRepository.findByIdForWrite(job.id);
      if (
        current?.status !== "in_progress" ||
        current.execution_generation !== job.execution_generation
      ) {
        throw new StaleJobExecutionError(job.id);
      }
      const currentData = readAgentDeleteJobData(current);
      const authorityData = hasCompleteAgentDeleteAuthority(currentData)
        ? currentData
        : hasCompleteAgentDeleteAuthority(claimedData)
          ? claimedData
          : currentData;
      const jobResult: AgentDeleteJobResult = {
        cloudAgentId: claimedData.agentId,
        containerStopped: result.containerStopped,
        rowDeleted: result.rowDeleted,
        ...agentDeleteAuthorityResult(authorityData),
      };
      const settled = await jobsRepository.settleExecution(
        job,
        "completed",
        {
          result: agentDeleteJobResultToRecord(jobResult),
          completed_at: new Date(),
          error: null,
          error_storage: "inline",
          error_key: null,
        },
        this.executionOwnerId,
        agentDeleteAuthorityFence(currentData),
      );
      if (settled) return jobResult;
      await this.assertExecutionMutationLease(job);
    }
  }

  /**
   * Requeues the exact active delete after a concurrent request strengthened
   * its durable state-loss authority. The fresh row is used as the retry CAS
   * token, and the result records the actual first acknowledging actor before
   * the execution lease is released.
   */
  private async requeueDeleteWithUpgradedAuthority(
    claimedJob: Job,
    error: string,
  ): Promise<Job | undefined> {
    const current = await jobsRepository.findByIdForWrite(claimedJob.id);
    if (
      current?.status !== "in_progress" ||
      current.execution_generation !== claimedJob.execution_generation
    ) {
      return undefined;
    }
    const currentData = readAgentDeleteJobData(current);
    if (!hasCompleteAgentDeleteAuthority(currentData)) return undefined;

    const priorResult = current.result && typeof current.result === "object" ? current.result : {};
    const authoritySnapshot = await this.retryOwnedWrite(
      claimedJob,
      "record-delete-authority",
      () =>
        jobsRepository.updateForExecution(
          current,
          {
            result: {
              ...priorResult,
              ...agentDeleteAuthorityResult(currentData),
            },
          },
          this.executionOwnerId,
        ),
    );
    return await this.retryOwnedWrite(claimedJob, "retry-upgraded-delete-authority", () =>
      jobsRepository.retryLaterWithoutIncrementingAttempts(
        authoritySnapshot,
        error,
        0,
        this.executionOwnerId,
      ),
    );
  }

  /**
   * Claim and process pending provisioning jobs.
   * Designed to be called by a cron route every minute.
   *
   * Uses FOR UPDATE SKIP LOCKED so multiple cron invocations won't
   * double-process the same job.
   *
   * @param batchSize - Max jobs to process per invocation.
   * @param opts.jobTypes - Restrict claiming + stale-recovery to this lane of
   *   job types (e.g. `APPS_JOB_TYPES` for the dedicated apps-control daemon).
   *   Omitted → ALL types (the single-daemon default). Scoping is what lets two
   *   daemons share the `jobs` table without one claiming-and-failing the
   *   other's lane.
   * @returns Summary of processing results.
   */
  async processPendingJobs(
    batchSize = 5,
    opts: { jobTypes?: readonly ProvisioningJobType[] } = {},
  ): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      claimed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      errors: [],
    };

    const jobTypes = opts.jobTypes ?? Object.values(JOB_TYPES);

    // Process each job type in this daemon's lane. The memory-intensive
    // snapshot lane is gated out of CLAIMING (fail-closed, #16639) and, when
    // enabled, forced sequential (batch 1) so phases settle before another
    // payload is allocated. The stale sweep below deliberately keeps the
    // full lane list: flipping a stuck in_progress row back to pending is a
    // DB-only operation with no hydration, and gated rows simply wait as
    // pending until operators enable the lane.
    for (const jobType of this.filterSnapshotLane(jobTypes, "claim")) {
      const laneBatch = jobType === JOB_TYPES.AGENT_SNAPSHOT ? 1 : batchSize;
      await this.processJobType(jobType, laneBatch, result);
    }

    // Recover legacy or already-quiesced stale claims, scoped to the same lane
    // so a lane-scoped daemon never resets the OTHER lane's rows. Generated
    // active attempts stay owned until settlement or daemon startup recovery.
    const recovery = await this.recoverStaleJobs(jobTypes);
    if (recovery.retried > 0 || recovery.permanentlyFailed > 0) {
      logger.info("[provisioning-jobs] Recovered stale jobs", {
        retried: recovery.retried,
        permanentlyFailed: recovery.permanentlyFailed,
      });
    }

    return result;
  }

  /**
   * Fail-closed gate for the memory-intensive `agent_snapshot` lane (#16639).
   * The lane is DISABLED unless `ELIZA_SNAPSHOT_JOBS_ENABLED` is exactly
   * "true": production repeatedly exhausted the worker heap hydrating
   * snapshots, and disabling backup verification did not disable hydration.
   * Claim and startup recovery both honor the gate, so a restart cannot
   * resurrect snapshot jobs before operators re-enable them; every other
   * lifecycle lane stays independently operable.
   */
  static snapshotJobsEnabled(): boolean {
    return process.env.ELIZA_SNAPSHOT_JOBS_ENABLED === "true";
  }

  private snapshotGateLogged = false;

  private filterSnapshotLane(
    jobTypes: readonly ProvisioningJobType[],
    where: string,
  ): readonly ProvisioningJobType[] {
    if (ProvisioningJobService.snapshotJobsEnabled()) return jobTypes;
    const filtered = jobTypes.filter((t) => t !== JOB_TYPES.AGENT_SNAPSHOT);
    if (filtered.length !== jobTypes.length && !this.snapshotGateLogged) {
      this.snapshotGateLogged = true;
      logger.warn(
        `[provisioning-jobs] agent_snapshot lane disabled (${where}): set ELIZA_SNAPSHOT_JOBS_ENABLED=true to enable`,
      );
    }
    return filtered;
  }

  /**
   * One-shot scan for pre-start claims whose renewable owner lease has expired.
   * A deployment may overlap two live workers, so process start time narrows the
   * scan but never authorizes revocation by itself.
   */
  async recoverInterruptedJobsOnStartup(
    startedBefore: Date,
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<ProvisioningRecoverySummary> {
    const summary = emptyRecoverySummary();

    for (const jobType of this.filterSnapshotLane(jobTypes, "startup-recovery")) {
      const result = await jobsRepository.recoverInProgressJobsStartedBefore({
        type: jobType,
        startedBefore,
        buildFailureWriteback: this.dependentRowWritebackBuilder(jobType),
      });
      addRecoveryResult(summary, result);
    }

    assertRecoveryHealthy("startup", summary);
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async processJobType(
    jobType: string,
    batchSize: number,
    result: ProcessingResult,
  ): Promise<void> {
    // Atomically claim pending jobs using FOR UPDATE SKIP LOCKED.
    // This prevents double-execution when overlapping cron runs race,
    // and respects scheduled_for so exponential backoff actually works.
    const isSharedImageChange = SHARED_IMAGE_CHANGE_JOB_TYPES.includes(
      jobType as ProvisioningJobType,
    );
    const claimedJobs = isSharedImageChange
      ? await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
          type: jobType,
          sharedTypes: SHARED_IMAGE_CHANGE_JOB_TYPES,
          maxRunning: ADMIN_CANARY_MAX_RUNNING_JOBS,
          limit: batchSize,
          executionOwnerId: this.executionOwnerId,
          executionLeaseMs: this.leaseDurationForJobType(jobType),
        })
      : await jobsRepository.claimPendingJobs({
          type: jobType,
          limit: batchSize,
          executionOwnerId: this.executionOwnerId,
          executionLeaseMs: this.leaseDurationForJobType(jobType),
        });

    for (const job of claimedJobs) {
      result.claimed++;
      const stopLeaseHeartbeat = this.startExecutionLeaseHeartbeat(job);
      const execution = this.executeJob(job);

      try {
        await withTimeout(execution, this.executionTimeoutMs(job.type), `job ${job.type}`);
        result.succeeded++;
        stopLeaseHeartbeat();
      } catch (err) {
        if (safeErrorKind(err, OperationTimeoutError)) {
          const errorMsg = err.message;
          result.failed++;
          result.errors.push({ jobId: job.id, error: errorMsg });
          logger.warn(
            "[provisioning-jobs] Execution timed out; retaining ownership until quiescent",
            {
              jobId: job.id,
              executionGeneration: job.execution_generation,
              timeoutMs: err.timeoutMs,
            },
          );
          // error-policy:J5 the detached result and terminal supervisor rejection
          // stay observed until settlement commits or a successor wins takeover.
          void execution
            .then(
              () => stopLeaseHeartbeat(),
              async (executionError) => {
                try {
                  if (await this.handleExecutionFailure(job, executionError)) {
                    await this.releaseProviderAdmissionAfterRecordedFailure(job);
                  }
                } finally {
                  stopLeaseHeartbeat();
                }
              },
            )
            .catch((settlementError) => {
              logger.warn("[provisioning-jobs] Detached settlement supervisor stopped", {
                jobId: job.id,
                executionGeneration: job.execution_generation,
                error: jobErrorText(settlementError),
              });
            });
          continue;
        }
        try {
          if (await this.handleExecutionFailure(job, err, result)) {
            await this.releaseProviderAdmissionAfterRecordedFailure(job);
          }
        } finally {
          stopLeaseHeartbeat();
        }
      }
    }
  }

  private async handleExecutionFailure(
    job: Job,
    err: unknown,
    result?: ProcessingResult,
  ): Promise<boolean> {
    const appCacheError = safeErrorKind(err, AppCacheInvalidationRetryError) ? err : undefined;
    const retryableTransportError = safeErrorKind(err, RetryableProvisionTransportError)
      ? err
      : safeErrorKind(err, RetryableReplacementCleanupError)
        ? err
        : undefined;
    // This is the value that reaches the `jobs.error` column, so it is the one
    // that has to carry a stack — the 16 conversions below it are log lines.
    const errorMsg = appCacheError
      ? finalizeJobErrorText(formatAppCacheInvalidationError(appCacheError))
      : retryableTransportError instanceof RetryableProvisionTransportError &&
          retryableTransportError.durableErrorText !== undefined
        ? retryableTransportError.durableErrorText
        : jobErrorText(err);
    result?.errors.push({ jobId: job.id, error: errorMsg });

    if (safeErrorKind(err, RejectedAgentExecutionError)) {
      const outcome = await this.retryOwnedWrite(job, "reject-agent-execution", () =>
        jobsRepository.rejectClaimedExecution(job, errorMsg, this.executionOwnerId),
      );
      if (outcome === "rejected" || outcome === "already-terminal") {
        if (result) result.failed++;
        logger.warn("[provisioning-jobs] Rejected invalid agent execution before dispatch", {
          jobId: job.id,
          jobType: job.type,
          outcome,
          error: errorMsg,
        });
      } else {
        logger.info("[provisioning-jobs] Invalid agent execution lost its exact claim", {
          jobId: job.id,
          jobType: job.type,
          outcome,
          error: errorMsg,
        });
      }
      return outcome === "rejected" || outcome === "already-terminal";
    }

    if (retryableTransportError) {
      const retrySnapshot = retryableTransportError.retrySnapshot;
      const onExhaustedInTx = this.buildPermanentFailureWriteback(retrySnapshot, errorMsg);
      let transition = await this.retryOwnedWrite(job, "retry-later", () =>
        jobsRepository.retryLaterWithoutIncrementingAttempts(
          retrySnapshot,
          errorMsg,
          PROVISION_TRANSPORT_RETRY_DELAY_MS,
          this.executionOwnerId,
          { maxRequeues: retryableTransportError.maxRequeues, onExhaustedInTx },
        ),
      );
      if (
        !transition &&
        retrySnapshot.type === JOB_TYPES.AGENT_DELETE &&
        readAgentDeleteJobData(retrySnapshot).stateLossAcknowledged !== true
      ) {
        transition = await this.requeueDeleteWithUpgradedAuthority(retrySnapshot, errorMsg);
      }
      if (transition?.status === "pending") {
        if (result) result.retried++;
        logger.warn("[provisioning-jobs] Requeued retryable provision transport failure", {
          jobId: job.id,
          delayMs: PROVISION_TRANSPORT_RETRY_DELAY_MS,
          requeues: transition.retryable_requeues,
          maxRequeues: retryableTransportError.maxRequeues,
          error: errorMsg,
        });
      } else if (transition?.status === "failed") {
        if (result) result.failed++;
        logger.error("[provisioning-jobs] Retryable failure exhausted its requeue budget", {
          jobId: job.id,
          requeues: transition.retryable_requeues,
          maxRequeues: retryableTransportError.maxRequeues,
          error: errorMsg,
        });
      } else {
        logger.info("[provisioning-jobs] Retryable failure lost its exact job-state claim", {
          jobId: job.id,
          error: errorMsg,
        });
      }
      return transition !== undefined;
    }

    // When retries are exhausted (permanent failure) the dependent
    // status row must flip too — and it must flip ATOMICALLY with the
    // job-status `failed` write, not in a best-effort follow-up that can
    // silently swallow. A separate write that fails leaves the sandbox
    // stuck in "provisioning" until the 10-min stuck-recovery cron
    // (markStuckProvisioningWithoutActiveJobAsError) catches it. Folding
    // the dependent flip into incrementAttempt's transaction via
    // `onFailedInTx` makes both commit together (or roll back together,
    // so the recovery cron re-runs the whole thing). The cron stays as
    // the backstop, never the primary signal.
    // Rollback-safe classification only exists for AGENT_UPGRADE failures
    // (thrown as UpgradeFailedError). For every other job type this is
    // undefined and the writeback ignores it.
    const upgradeFailure = safeErrorKind(err, UpgradeFailedError) ? err : undefined;
    const unacknowledgedDeleteFailure = safeErrorKind(err, UnacknowledgedAgentDeleteError)
      ? err
      : undefined;
    const onFailedInTx = this.buildPermanentFailureWriteback(job, errorMsg, upgradeFailure);
    const updated = await this.retryOwnedWrite(job, "increment-attempt", () =>
      jobsRepository.incrementAttempt(
        job.id,
        errorMsg,
        job.max_attempts,
        onFailedInTx,
        job.execution_generation ?? undefined,
        this.executionOwnerId,
        unacknowledgedDeleteFailure
          ? sql`NOT (
              COALESCE(${jobs.data}->>'stateLossAcknowledged', 'false') = 'true'
              AND NULLIF(${jobs.data}->>'stateLossAcknowledgedByUserId', '') IS NOT NULL
              AND NULLIF(${jobs.data}->>'stateLossAcknowledgedAt', '') IS NOT NULL
            )`
          : undefined,
      ),
    );
    if (!updated && unacknowledgedDeleteFailure) {
      const transition = await this.requeueDeleteWithUpgradedAuthority(
        unacknowledgedDeleteFailure.retrySnapshot,
        errorMsg,
      );
      if (transition?.status === "pending") {
        if (result) result.retried++;
        logger.warn(
          "[provisioning-jobs] Requeued delete after in-flight state-loss authority upgrade",
          {
            jobId: job.id,
            executionGeneration: job.execution_generation,
            acknowledgingUserId: readAgentDeleteJobData(transition).stateLossAcknowledgedByUserId,
          },
        );
        return true;
      }
    }
    if (result) result.failed++;
    if (appCacheError) {
      const context = {
        jobId: job.id,
        attempts: updated?.attempts ?? job.attempts,
        maxAttempts: job.max_attempts,
        error: errorMsg,
      };
      if (updated?.status === "failed") {
        logger.error(
          "[provisioning-jobs] App cache invalidation exhausted its retry budget",
          context,
        );
      } else {
        logger.warn("[provisioning-jobs] App cache invalidation failed; retry scheduled", context);
      }
    }
    return updated !== undefined;
  }

  /**
   * Builds the in-transaction dependent-row writeback for a job that has just
   * exhausted its retries. Returned callback runs INSIDE incrementAttempt's
   * transaction (atomic with the job-status `failed` flip). Returns undefined
   * for job types outside `DEPENDENT_ROW_JOB_TYPES`, which own no such row.
   */
  private buildPermanentFailureWriteback(
    job: Job,
    errorMsg: string,
    upgradeFailure?: UpgradeFailedError,
  ): ((tx: DbTransaction, failedJob: Job) => Promise<void>) | undefined {
    if (!ownsDependentRow(job.type)) return undefined;
    switch (job.type) {
      // Mark the sandbox "error" so the UI reflects reality instead of staying
      // stuck in "provisioning".
      case JOB_TYPES.AGENT_PROVISION: {
        const { agentId } = readAgentProvisionJobData(job);
        return async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              status: "error",
              error_message: `Provisioning permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
              updated_at: new Date(),
            })
            .where(eq(agentSandboxes.id, agentId));
          logger.warn("[provisioning-jobs] Marked sandbox as error after permanent failure", {
            jobId: job.id,
            agentId,
          });
        };
      }
      case JOB_TYPES.AGENT_RESTART: {
        const { agentId, organizationId } = readAgentRestartJobData(job);
        return async (tx) => {
          const [failedWarmClaim] = await tx
            .update(agentSandboxes)
            .set({
              status: "error",
              warm_claim_credential_state: "failed",
              warm_claim_cleanup_completed_at: null,
              error_message: `Warm-claim credential recovery permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(agentSandboxes.id, agentId),
                eq(agentSandboxes.organization_id, organizationId),
                isNotNull(agentSandboxes.claimed_at),
                sql`${agentSandboxes.warm_claim_credential_state} IN ('pending', 'attested')`,
                sql`${agentSandboxes.deleted_at} IS NULL`,
              ),
            )
            .returning({ id: agentSandboxes.id });
          if (failedWarmClaim) {
            logger.warn(
              "[provisioning-jobs] Marked exhausted warm-claim handoff failed for durable credential cleanup",
              { jobId: job.id, agentId, organizationId },
            );
          }
        };
      }
      // A permanently-exhausted AGENT_UPGRADE is NOT uniformly terminal. Most
      // upgrade failures are ROLLBACK-SAFE (blue provision/health/digest/runtime
      // /snapshot/swap failures) — executeUpgrade never tears down the OLD
      // container before a successful atomic swap, so the agent keeps serving on
      // its previous version. Marking such a row `status:"error"` would (1) make
      // the dedicated proxy reject live traffic (dedicated-agent-proxy.ts) and
      // (2) expose the still-live container to the orphan reconciler
      // (docker-node-workloads.ts) — killing a healthy agent. So:
      //   - rollback-safe (default, and the only genuinely-safe failure class):
      //     keep `status:"running"`, record the failure + the exhausted target
      //     digest in error_message so the reconciler stops re-enqueuing the
      //     SAME doomed target, WITHOUT declaring the live sandbox terminal.
      //     Encoding the target digest lets the reconciler re-arm the agent for
      //     a NEWER target (see listRunningWithDigestOtherThan) so a transient
      //     rollback-safe failure never permanently freezes an always-on agent
      //     out of future security patches.
      //   - genuinely-dead (rolledBack === false, e.g. the agent was already not
      //     running): keep the terminal `status:"error"` writeback, mirroring
      //     AGENT_PROVISION, so the UI reflects reality.
      case JOB_TYPES.AGENT_UPGRADE: {
        const upgradeData = readAgentUpgradeJobData(job);
        const { agentId } = upgradeData;
        // Classification is carried on the thrown UpgradeFailedError. Absent it
        // (defensive: an upgrade that failed via the outer worker path — a
        // withTimeout(...) wrap or an unexpected throw BEFORE executeUpgrade
        // returns success:false — so no UpgradeFailedError is constructed),
        // default to rollback-safe: never error a possibly-live agent on an
        // unknown cause. Fall back to the job's own target digest (always
        // present in the job data) so the re-armable marker still records the
        // EXACT exhausted target — otherwise the reconciler's target-scoped
        // skip would immediately re-enqueue the same doomed target and recreate
        // the retry storm this marker prevents (codex #15357 P2).
        const rolledBack = upgradeFailure?.rolledBack ?? true;
        // Prefer the classification's target, but treat an empty/absent error
        // digest as "not carried" and fall back to the job's own target (always
        // present, validated by readAgentUpgradeJobData) so the re-armable marker
        // ALWAYS records the EXACT exhausted target. A `??` alone would let an
        // empty-string error digest through and degrade the marker to "unknown".
        const errorDigest = upgradeFailure?.toDigest;
        const toDigest =
          errorDigest && errorDigest.length > 0 ? errorDigest : upgradeData.toDigest || null;
        if (!rolledBack) {
          // Genuinely-dead old container: terminal, like AGENT_PROVISION.
          return async (tx) => {
            await tx
              .update(agentSandboxes)
              .set({
                status: "error",
                error_message: `Upgrade permanently failed after ${job.max_attempts} attempts (agent not serving): ${errorMsg}`,
                updated_at: new Date(),
              })
              .where(eq(agentSandboxes.id, agentId));
            logger.warn(
              "[provisioning-jobs] Marked sandbox error after permanent upgrade failure on a non-serving agent",
              { jobId: job.id, agentId },
            );
          };
        }
        // Rollback-safe: keep the agent running, record a re-armable marker.
        return async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              error_message: buildUpgradeFailureMarker(job.max_attempts, errorMsg, toDigest),
              updated_at: new Date(),
            })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.status, "running")));
          logger.warn(
            "[provisioning-jobs] Recorded rollback-safe upgrade failure without marking sandbox terminal",
            { jobId: job.id, agentId, failedTargetDigest: toDigest },
          );
        };
      }
      case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE: {
        const data = readAdminCanaryImageJobData(job);
        return async (tx) => {
          const finishedAt = new Date();
          const result: AdminCanaryImageJobResult = {
            success: false,
            jobId: job.id,
            operation: data.operation,
            rolloutId: data.rolloutId,
            actorUserId: data.actorUserId,
            decisionAt: data.decisionAt,
            agentId: data.agentId,
            organizationId: data.organizationId,
            targetOwnerUserId: data.targetOwnerUserId,
            sourceImage: data.sourceImage,
            sourceDigest: data.sourceDigest,
            targetImage: data.targetImage,
            targetDigest: data.targetDigest,
            startedAt: jobAuditTimestamp(job.started_at ?? job.updated_at),
            finishedAt: finishedAt.toISOString(),
            error: errorMsg,
          };
          await tx
            .update(jobs)
            .set({
              result: adminCanaryImageJobResultToRecord(result),
              result_storage: "inline",
              completed_at: finishedAt,
              updated_at: finishedAt,
            })
            .where(eq(jobs.id, job.id));
          logger.warn("[provisioning-jobs] Persisted failed admin canary image audit", {
            jobId: job.id,
            rolloutId: data.rolloutId,
            agentId: data.agentId,
            operation: data.operation,
          });
        };
      }
      // Apps / Product 2: a permanently failed deploy must flip the app off
      // `building`, or the deploy-status route (which echoes
      // `apps.deployment_status`) reports BUILDING forever — the CLI/dashboard
      // never sees the failure. A durable cache task is inserted in the same
      // transaction; its cache deletion runs later outside the transaction.
      // Especially relevant during the lane-migration window, when the agent
      // CP worker (still default=all lanes) claims an APP_DEPLOY it can't run
      // and exhausts retries.
      case JOB_TYPES.APP_DEPLOY: {
        const { appId, deploymentGeneration } = readAppDeployJobData(job);
        return async (tx, failedJob) => {
          const [failedApp] = await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(
              and(
                eq(apps.id, appId),
                eq(apps.organization_id, failedJob.organization_id),
                sql`${apps.metadata}->>${APP_DEPLOYMENT_GENERATION_KEY} = ${deploymentGeneration}`,
              ),
            )
            .returning({ id: apps.id, api_key_id: apps.api_key_id, slug: apps.slug });
          if (failedApp) {
            await enqueueAppCacheInvalidation(tx, failedJob, failedApp);
            logger.warn(
              "[provisioning-jobs] Marked app deployment as failed after permanent failure",
              { jobId: job.id, appId },
            );
          }
        };
      }
      // Apps / Product 2: the APP_DEPLOY job above only self-completes after
      // enqueuing the real CONTAINER_PROVISION, so a SUCCESSFUL deploy that then
      // fails to provision its container exhausts retries HERE — and would
      // otherwise strand the app in `building` forever (the success path's
      // markAppDeployed is the only other writer of deployment_status). The
      // app-deploy container is created with `project_name = appId` AND
      // `organization_id = app.organization_id` (app-deploy-runner), so the app
      // id and owning org both live on the container row. Unlike markAppDeployed
      // — which only runs inside the apps container backend — this writeback
      // fires for EVERY CONTAINER_PROVISION job, including plain/coding
      // /v1/containers rows whose `project_name` is a user-supplied slug that can
      // be made to look like a UUID. So we (1) require a real UUID and (2) scope
      // the flip to the container's OWN organization: a user can never name a
      // container after ANOTHER tenant's app id and flip that app to `failed`,
      // because the cross-org WHERE matches zero rows.
      case JOB_TYPES.CONTAINER_PROVISION: {
        const { containerId, deploymentGeneration: jobGeneration } =
          readContainerProvisionJobData(job);
        return async (tx, failedJob) => {
          const [row] = await tx
            .select({
              projectName: containers.project_name,
              organizationId: containers.organization_id,
              metadata: containers.metadata,
            })
            .from(containers)
            .where(
              and(
                eq(containers.id, containerId),
                eq(containers.organization_id, failedJob.organization_id),
              ),
            )
            .limit(1);
          const appId = row?.projectName;
          if (!appId || !isValidUUID(appId)) return;
          const rowGeneration = deploymentGenerationFromMetadata(row.metadata);
          if (jobGeneration && jobGeneration !== rowGeneration) return;
          const deploymentGeneration = jobGeneration ?? rowGeneration;
          const generationFilter = deploymentGeneration
            ? sql`${apps.metadata}->>${APP_DEPLOYMENT_GENERATION_KEY} = ${deploymentGeneration}`
            : sql`${apps.metadata}->>${APP_DEPLOYMENT_GENERATION_KEY} IS NULL`;
          const [failedApp] = await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(
              and(
                eq(apps.id, appId),
                eq(apps.organization_id, row.organizationId),
                generationFilter,
              ),
            )
            .returning({ id: apps.id, api_key_id: apps.api_key_id, slug: apps.slug });
          if (failedApp) {
            await enqueueAppCacheInvalidation(tx, failedJob, failedApp);
            logger.warn(
              "[provisioning-jobs] Marked app deployment as failed after container provision permanent failure",
              { jobId: job.id, containerId, appId },
            );
          }
        };
      }
      // agent_delete: when the daemon gives up, flip the row to
      // `deletion_failed` so ops can see the stuck sandboxes (and the container
      // that probably survived on the core) instead of leaving the row stuck in
      // `deletion_pending` forever.
      case JOB_TYPES.AGENT_DELETE: {
        const { agentId } = readAgentDeleteJobData(job);
        return async (tx) => {
          // Bump error_count so reEnqueueFailedDeletions can circuit-break a
          // permanently-dead node: each exhausted agent_delete adds one, and
          // once the count crosses the re-enqueue threshold the sweep stops
          // re-arming the row and alerts ops instead of looping forever. Once a
          // row reaches deletion_failed the only writer of error_count is this
          // path (markError only touches `error` rows), so the count tracks
          // failed delete sweeps. A fresh user-initiated delete resets it.
          await tx
            .update(agentSandboxes)
            .set({
              status: "deletion_failed",
              error_message: `Deletion permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
              error_count: sql`${agentSandboxes.error_count} + 1`,
              updated_at: new Date(),
            })
            .where(eq(agentSandboxes.id, agentId));
          logger.warn(
            "[provisioning-jobs] Marked sandbox as deletion_failed after permanent failure",
            { jobId: job.id, agentId },
          );
        };
      }
      default: {
        // The guard above already excluded every non-dependent type, so a new
        // arm added to DEPENDENT_ROW_JOB_TYPES without a case here fails to
        // compile rather than silently skipping its dependent row.
        const unhandled: never = job.type;
        throw new Error(`No permanent-failure writeback for job type ${String(unhandled)}`);
      }
    }
  }

  /**
   * Resolves the writeback builder for one job TYPE, before the sweep has a job
   * in hand. A type owning no dependent row gets no builder at all: the
   * repository must hydrate a job's blob-offloaded payload before it can call
   * one, and the object store has no timeout.
   */
  private dependentRowWritebackBuilder(
    jobType: string,
  ): RecoveryFailureWritebackBuilder | undefined {
    if (!ownsDependentRow(jobType)) return undefined;
    return (hydratedJob, error) => this.buildPermanentFailureWriteback(hydratedJob, error);
  }

  /** Parse and cross-check the duplicated agent identity before any handler runs. */
  private assertAgentJobIdentity(
    job: Job,
  ): { agentId: string; organizationId: string } | undefined {
    if (!AGENT_JOB_TYPES.includes(job.type as ProvisioningJobType)) return undefined;

    const raw = job.data && typeof job.data === "object" ? job.data : undefined;
    let identity: { agentId: string; organizationId: string };
    try {
      switch (job.type) {
        case JOB_TYPES.AGENT_COMPUTE_LEASE:
          identity = readAgentComputeLeaseJobData(job);
          break;
        case JOB_TYPES.AGENT_PROVISION:
          identity = readAgentProvisionJobData(job);
          break;
        case JOB_TYPES.AGENT_DELETE:
          identity = readAgentDeleteJobData(job);
          break;
        case JOB_TYPES.AGENT_SUSPEND:
          identity = readAgentSuspendJobData(job);
          break;
        case JOB_TYPES.AGENT_RESUME:
          identity = readAgentResumeJobData(job);
          break;
        case JOB_TYPES.AGENT_SLEEP:
          identity = readAgentSleepJobData(job);
          break;
        case JOB_TYPES.AGENT_WAKE:
          identity = readAgentWakeJobData(job);
          break;
        case JOB_TYPES.AGENT_RESTART:
          identity = readAgentRestartJobData(job);
          break;
        case JOB_TYPES.AGENT_UPGRADE:
          identity = readAgentUpgradeJobData(job);
          break;
        case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE:
          identity = readAdminCanaryImageJobData(job);
          break;
        case JOB_TYPES.AGENT_DOWNGRADE:
          identity = readAgentDowngradeJobData(job);
          break;
        case JOB_TYPES.AGENT_LOGS:
          identity = readAgentLogsJobData(job);
          break;
        case JOB_TYPES.AGENT_MESSAGE:
          identity = readAgentMessageJobData(job);
          break;
        case JOB_TYPES.AGENT_SNAPSHOT:
          identity = readAgentSnapshotJobData(job);
          break;
        default:
          throw new Error(`No identity parser for agent job type ${job.type}`);
      }
    } catch (cause) {
      // error-policy:J3 an unparseable job payload becomes an explicit terminal
      // rejection, never a fake-valid identity. The cause is carried as a
      // string rather than the Error so a malformed payload cannot smuggle a
      // value into the persisted failure row.
      throw new RejectedAgentExecutionError(`Invalid agent job payload for job ${job.id}`, {
        jobId: job.id,
        jobType: job.type,
        columnAgentId: job.agent_id,
        columnOrganizationId: job.organization_id,
        payloadAgentId: typeof raw?.agentId === "string" ? raw.agentId : null,
        payloadOrganizationId: typeof raw?.organizationId === "string" ? raw.organizationId : null,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (
      identity.agentId.trim().length === 0 ||
      identity.organizationId.trim().length === 0 ||
      identity.agentId !== job.agent_id ||
      identity.organizationId !== job.organization_id
    ) {
      throw new RejectedAgentExecutionError(
        `Agent job identity does not match indexed columns for job ${job.id}`,
        {
          jobId: job.id,
          jobType: job.type,
          columnAgentId: job.agent_id,
          columnOrganizationId: job.organization_id,
          payloadAgentId: identity.agentId,
          payloadOrganizationId: identity.organizationId,
        },
      );
    }
    return identity;
  }

  private async assertNoConflictingLifecycleExecution(job: Job): Promise<void> {
    const identity = this.assertAgentJobIdentity(job);
    if (!identity) return;
    if (!job.execution_generation) {
      throw new Error(`Claimed lifecycle job ${job.id} has no execution generation`);
    }
    await this.assertExecutionMutationLease(job);
    const prepare = async (): Promise<void> => {
      await dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        // PGlite's TCP bridge does not release transaction-scoped advisory
        // locks reliably at commit. Local Docker retains the exact job,
        // generation, lease, conflict, and sandbox-row fences below.
        if (!usesLocalDockerSandboxProvider()) {
          await tx.execute(
            elizaProvisionAdvisoryLockSql(identity.organizationId, identity.agentId),
          );
        }
        const [currentJob] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, job.id),
              eq(jobs.status, "in_progress"),
              sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${job.execution_generation}`,
              isNull(jobs.execution_quiesced_at),
              sql`EXISTS (
              SELECT 1
              FROM ${jobExecutionLeases}
              WHERE ${jobExecutionLeases.job_id} = ${job.id}
                AND ${jobExecutionLeases.execution_generation} = ${job.execution_generation}
                AND ${jobExecutionLeases.owner_id} = ${this.executionOwnerId}
                AND ${jobExecutionLeases.expires_at} > NOW()
            )`,
            ),
          )
          .limit(1);
        if (!currentJob) {
          throw new Error(`Lifecycle execution generation is no longer current: ${job.id}`);
        }

        const [sandboxAuthority] = await tx
          .select({
            executionTier: agentSandboxes.execution_tier,
            pool_status: agentSandboxes.pool_status,
            deleted_at: agentSandboxes.deleted_at,
            deletion_attempt_id: agentSandboxes.deletion_attempt_id,
          })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.id, identity.agentId),
              eq(agentSandboxes.organization_id, identity.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          requiresContainerBackedTarget(job.type) &&
          (!sandboxAuthority || !isContainerBackedExecutionTier(sandboxAuthority.executionTier))
        ) {
          throw new RejectedAgentExecutionError(
            `${CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE}: ${job.type}`,
            {
              jobId: job.id,
              jobType: job.type,
              columnAgentId: job.agent_id,
              columnOrganizationId: job.organization_id,
              payloadAgentId: identity.agentId,
              payloadOrganizationId: identity.organizationId,
              executionTier: sandboxAuthority?.executionTier ?? "missing",
            },
          );
        }

        if (job.type === JOB_TYPES.AGENT_SNAPSHOT && sandboxAuthority) {
          const rejection = snapshotAuthorityRejection(sandboxAuthority);
          if (rejection) {
            throw new RejectedAgentExecutionError(rejection, {
              jobId: job.id,
              jobType: job.type,
              columnAgentId: job.agent_id,
              columnOrganizationId: job.organization_id,
              payloadAgentId: identity.agentId,
              payloadOrganizationId: identity.organizationId,
              executionTier: sandboxAuthority.executionTier,
            });
          }
        }

        if (!EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(job.type as ProvisioningJobType)) return;

        const [conflict] = await tx
          .select({ id: jobs.id, type: jobs.type, status: jobs.status })
          .from(jobs)
          .where(
            and(
              eq(jobs.organization_id, job.organization_id),
              eq(jobs.agent_id, identity.agentId),
              inArray(jobs.type, EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES),
              ne(jobs.id, job.id),
              sql`${jobs.status} IN ('pending', 'in_progress')`,
              // A manual suspend may be a durable follow-up to an already claimed
              // billing suspend. Both executions serialize on the sandbox row in
              // executeSuspend; treating them as a conflict would strand the
              // unconditional follow-up behind the stale hydrated billing job.
              or(ne(jobs.type, job.type), ne(jobs.type, JOB_TYPES.AGENT_SUSPEND)),
            ),
          )
          .orderBy(desc(jobs.created_at))
          .limit(1);
        if (conflict) {
          throw new ApiError(
            409,
            "session_not_ready",
            `Agent ${job.agent_id} has conflicting ${conflict.type} job ${conflict.id}`,
            {
              conflictingJobId: conflict.id,
              conflictingJobType: conflict.type,
              conflictingJobStatus: conflict.status,
            },
          );
        }
        const claimedSandbox = await updateAgentLifecycleExecutionFence(
          tx,
          job,
          job.execution_generation!,
          "claim",
        );
        if (!claimedSandbox) {
          const [existingSandbox] = await tx
            .select({ id: agentSandboxes.id })
            .from(agentSandboxes)
            .where(
              and(
                eq(agentSandboxes.id, identity.agentId),
                eq(agentSandboxes.organization_id, identity.organizationId),
              ),
            )
            .limit(1);
          if (existingSandbox) {
            throw new Error(
              `Agent lifecycle resource generation is already owned: ${job.agent_id}`,
            );
          }
        }
      });
    };
    if (!ACCOUNT_LIFECYCLE_FENCED_AGENT_JOB_TYPES.includes(job.type as ProvisioningJobType)) {
      await prepare();
      return;
    }
    try {
      await prepareProvisioningWithAccountLifecycleFence(identity.organizationId, prepare);
    } catch (error) {
      if (!(error instanceof AccountLifecycleFencedError)) throw error;
      throw new RejectedAgentExecutionError(`Account lifecycle fenced provisioning job ${job.id}`, {
        jobId: job.id,
        jobType: job.type,
        columnAgentId: job.agent_id,
        columnOrganizationId: job.organization_id,
        payloadAgentId: identity.agentId,
        payloadOrganizationId: identity.organizationId,
        cause: "account_lifecycle_fenced_or_stale",
      });
    }
  }

  private async executeJob(job: Job): Promise<void> {
    await this.assertNoConflictingLifecycleExecution(job);
    if (this.executionOverride) {
      await this.executionOverride(job);
      return;
    }
    const providerAdmission = this.providerAdmissionForJob(job);
    if (!providerAdmission) {
      await this.executeJobDispatch(job);
      return;
    }
    try {
      await executeProvisioningWithAccountLifecycleAdmission({
        authority: providerAdmission,
        acquire: this.acquireProviderAdmission,
        release: this.releaseProviderAdmission,
        execute: () => this.executeJobDispatch(job),
      });
    } catch (error) {
      if (!(error instanceof AccountLifecycleFencedError)) throw error;
      const identity = this.assertAgentJobIdentity(job);
      throw new RejectedAgentExecutionError(
        `Account lifecycle fenced provider admission ${job.id}`,
        {
          jobId: job.id,
          jobType: job.type,
          columnAgentId: job.agent_id,
          columnOrganizationId: job.organization_id,
          payloadAgentId: identity?.agentId,
          payloadOrganizationId: identity?.organizationId,
          cause: "account_lifecycle_fenced_or_stale",
        },
      );
    }
  }

  private providerAdmissionForJob(job: Job): ProviderAdmissionAuthority | undefined {
    if (!ACCOUNT_LIFECYCLE_FENCED_AGENT_JOB_TYPES.includes(job.type as ProvisioningJobType)) {
      return undefined;
    }
    return {
      organizationId: job.organization_id,
      operationKind: "agent_lifecycle",
      operationId: job.id,
    };
  }

  private async releaseProviderAdmissionAfterRecordedFailure(job: Job): Promise<void> {
    const authority = this.providerAdmissionForJob(job);
    if (authority) await this.releaseProviderAdmission(authority);
  }

  private async executeJobDispatch(job: Job): Promise<void> {
    if (
      PRICED_AGENT_START_JOB_TYPES.includes(job.type) &&
      job.data.admittedComputePrice !== getDedicatedComputePriceAcceptance()
    ) {
      throw new RejectedAgentExecutionError(
        "Dedicated start price is missing or changed. Review the current price and submit a new start request; no runtime action was dispatched.",
        {
          jobId: job.id,
          jobType: job.type,
          columnAgentId: job.agent_id,
          columnOrganizationId: job.organization_id,
          cause: "dedicated_compute_price_confirmation_required",
        },
      );
    }
    switch (job.type) {
      case JOB_TYPES.AGENT_COMPUTE_LEASE: {
        const result = await executeAgentComputeLeaseJob(job, () =>
          this.assertExecutionMutationLease(job),
        );
        await this.settleClaimedExecution(job, "completed", {
          result,
          completed_at: new Date(),
        });
        break;
      }
      case JOB_TYPES.AGENT_PROVISION:
        await this.executeAgentProvision(job);
        break;
      case JOB_TYPES.AGENT_DELETE:
        await this.executeAgentDelete(job);
        break;
      case JOB_TYPES.AGENT_SUSPEND:
        await this.executeAgentSuspend(job);
        break;
      case JOB_TYPES.AGENT_RESUME:
        await this.executeAgentResume(job);
        break;
      case JOB_TYPES.AGENT_SLEEP:
        await this.executeAgentSleep(job);
        break;
      case JOB_TYPES.AGENT_WAKE:
        await this.executeAgentWake(job);
        break;
      case JOB_TYPES.AGENT_RESTART:
        await this.executeAgentRestart(job);
        break;
      case JOB_TYPES.AGENT_UPGRADE:
        await this.executeAgentUpgrade(job);
        break;
      case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE:
        await this.executeAdminCanaryImage(job);
        break;
      case JOB_TYPES.AGENT_DOWNGRADE:
        await this.executeAgentDowngrade(job);
        break;
      case JOB_TYPES.AGENT_LOGS:
        await this.executeAgentLogs(job);
        break;
      case JOB_TYPES.AGENT_MESSAGE:
        await this.executeAgentMessage(job);
        break;
      case JOB_TYPES.AGENT_SNAPSHOT:
        await this.executeAgentSnapshot(job);
        break;
      // Apps lane (Product 2): generic app-container lifecycle. Routed to the
      // standalone container-job-service (kept out of the agent-coupled paths
      // above); the executor backend is wired at boot via setContainerExecutorDeps.
      //
      // Self-mark completed on success so recoverStaleJobs() can't re-sweep a
      // slow-but-successful job back to `pending` (the same foot-gun the
      // AGENT_* arms and APP_DB_DEPROVISION already close): a CONTAINER_PROVISION
      // that crosses PER_JOB_TIMEOUT_MS while the provider is still creating the
      // container would, without a terminal row, get re-claimed and provision a
      // SECOND container. The dispatchers are NOT all idempotent across separate
      // successful runs; a terminal row is the only safe gate.
      case JOB_TYPES.CONTAINER_PROVISION:
      case JOB_TYPES.CONTAINER_DELETE:
      case JOB_TYPES.CONTAINER_RESTART:
      case JOB_TYPES.CONTAINER_UPGRADE:
      case JOB_TYPES.CONTAINER_LOGS:
        await this.assertExecutionMutationLease(job);
        await dispatchContainerJob(job, getContainerExecutorDeps());
        await this.settleClaimedExecution(job, "completed", {
          completed_at: new Date(),
        });
        break;
      // Billing-suspend stop (#8342): the container-billing cron (Worker, no SSH)
      // enqueues this when an org runs out of credit; the daemon runs the real
      // `docker stop` + remove via HetznerContainersClient (volume preserved,
      // node slot freed). Routed direct to its own dispatcher — NOT through
      // dispatchContainerJob (which targets the apps-lane AppContainerProvider
      // by container name); these are 2AM `containers` rows stopped by id+org.
      // Self-marked completed so recoverStaleJobs() can't re-sweep it: the stop
      // is idempotent on a live container, but re-running after the row is gone
      // is pointless churn, and a completed row is the clean terminal state.
      case JOB_TYPES.CONTAINER_STOP: {
        await this.assertExecutionMutationLease(job);
        const outcome = await dispatchContainerStopJob(job, {
          executionOwnerId: this.executionOwnerId,
        });
        await this.settleClaimedExecution(job, "completed", {
          result: { stopped: outcome.stopped, reason: outcome.reason ?? null },
          completed_at: new Date(),
        });
        break;
      }
      // Apps lane (Product 2): the node deploy. The Worker enqueues this; the
      // daemon runs the real isolated provision via the injected AppDeployRunner.
      //
      // Self-mark completed on success (mirrors the AGENT_* arms). The runner is
      // NOT idempotent across separate successful runs — it ensures the tenant
      // DB, creates a `containers` row, and enqueues a CONTAINER_PROVISION. A
      // slow-but-successful deploy that crosses PER_JOB_TIMEOUT_MS would, without
      // a terminal row, get re-swept by recoverStaleJobs() and double-provision
      // (a second container row + a second CONTAINER_PROVISION). A completed row
      // is the only thing that prevents the re-sweep.
      case JOB_TYPES.APP_DEPLOY:
        await this.assertExecutionMutationLease(job);
        await dispatchAppDeployJob(job);
        await this.settleClaimedExecution(job, "completed", {
          completed_at: new Date(),
        });
        break;
      // Apps lane (Product 2): tear down a deleted app's isolated tenant DB.
      // The Worker enqueues this; the daemon runs the real DROP + slot release
      // via the injected deprovisioner (wired in apps-deploy-backend). (#8342)
      case JOB_TYPES.APP_DB_DEPROVISION: {
        await this.assertExecutionMutationLease(job);
        const outcome = await dispatchAppDbDeprovisionJob(job);
        // Mark terminal so recoverStaleJobs() can't re-sweep this job back to
        // `pending` after the stale threshold. A re-run would call
        // deprovisionTenantDbForApp -> releaseSlot() a SECOND time, and
        // releaseSlot's GREATEST(0, database_count - 1) is NOT idempotent
        // across separate successful runs: on a multi-tenant cluster the second
        // decrement frees a phantom slot belonging to another LIVE tenant DB
        // (capacity over-allocation — the inverse of the #8342 leak this very
        // job fixes). Every AGENT_* executor self-marks completed for exactly
        // this reason; the Apps-lane dispatchers historically relied on never
        // being re-swept, which only bites this non-idempotent deprovision path.
        //
        // Follow-up (deeper hardening, separate PR): make releaseSlot itself
        // idempotent by gating it on the DROP actually removing an existing DB
        // (needs a row-returning query seam on TenantDbSqlExecutor). That would
        // also close the micro-window where this updateStatus throws AFTER a
        // successful releaseSlot and the retry re-decrements.
        await this.settleClaimedExecution(job, "completed", {
          result: {
            deprovisioned: outcome.deprovisioned,
            reason: outcome.reason ?? null,
          },
          completed_at: new Date(),
        });
        break;
      }
      case JOB_TYPES.APP_CACHE_INVALIDATE:
        await this.assertExecutionMutationLease(job);
        await dispatchAppCacheInvalidationJob(job);
        await this.settleClaimedExecution(job, "completed", {
          completed_at: new Date(),
        });
        break;
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  /**
   * Resolve a lifecycle job whose target agent no longer exists as a terminal
   * no-op instead of retrying to exhaustion. Once the agent row is gone (e.g. a
   * concurrent agent_delete completed first, or a stale in_progress job was
   * recovered after deletion), there is nothing left to suspend/resume/restart
   * /snapshot — throwing would just burn three attempts and land the job in
   * `failed`, masking the real (benign) cause. Returns true when it claimed the
   * job as completed; the caller must return early. Any other failure flows
   * through the normal retry path.
   */
  private async completeIfAgentGone(
    job: Job,
    result: { success: boolean; error?: string },
    agentId: string,
  ): Promise<boolean> {
    if (result.success || result.error !== "Agent not found") return false;
    await this.settleClaimedExecution(job, "completed", {
      result: { cloudAgentId: agentId, skipped: true, reason: "Agent not found" },
      completed_at: new Date(),
    });
    logger.info("[provisioning-jobs] Job completed as no-op — agent no longer exists", {
      jobId: job.id,
      jobType: job.type,
      agentId,
    });
    return true;
  }

  private async executeAgentSuspend(job: Job): Promise<void> {
    const data = readAgentSuspendJobData(job);
    const authority = await this.resolveAgentSuspendAuthority(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_suspend", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeSuspend(
      data.agentId,
      data.organizationId,
      job.id,
      authority.authorization,
      authority.lifecycleRevision,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: agentSuspendJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStopped: result.containerStopped,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_suspend failure");
    }

    const jobResult: AgentSuspendJobResult = {
      cloudAgentId: data.agentId,
      containerStopped: result.containerStopped,
      backupId: result.backupId,
      ...(result.skipped ? { skipped: true as const, reason: result.reason } : {}),
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentSuspendJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_suspend completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: result.containerStopped,
      backupId: result.backupId,
      skipped: result.skipped ?? false,
      reason: result.reason,
    });
  }

  private async executeAgentResume(job: Job): Promise<void> {
    const data = readAgentResumeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_resume", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeResume(data.agentId, data.organizationId);

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: agentResumeJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStarted: result.containerStarted,
          reprovisioned: result.reprovisioned,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_resume failure");
    }

    const jobResult: AgentResumeJobResult = {
      cloudAgentId: data.agentId,
      containerStarted: result.containerStarted,
      reprovisioned: result.reprovisioned,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentResumeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_resume completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStarted: result.containerStarted,
      reprovisioned: result.reprovisioned,
    });
  }

  private async executeAgentSleep(job: Job): Promise<void> {
    const data = readAgentSleepJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_sleep", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeSleep(data.agentId, data.organizationId);

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: agentSleepJobResultToRecord({
          cloudAgentId: data.agentId,
          containerRemoved: result.containerRemoved,
          backupId: result.backupId,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_sleep failure");
    }

    const jobResult: AgentSleepJobResult = {
      cloudAgentId: data.agentId,
      containerRemoved: result.containerRemoved,
      backupId: result.backupId,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentSleepJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_sleep completed", {
      jobId: job.id,
      agentId: data.agentId,
      backupId: result.backupId,
      containerRemoved: result.containerRemoved,
    });
  }

  private async executeAgentWake(job: Job): Promise<void> {
    const data = readAgentWakeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_wake", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeWake(data.agentId, data.organizationId, {
      restoreBackupId: data.restoreBackupId,
      forceFreshBoot: data.forceFreshBoot,
    });

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: agentWakeJobResultToRecord({
          cloudAgentId: data.agentId,
          reprovisioned: result.reprovisioned,
          restoredBackupId: result.restoredBackupId,
          freshBoot: result.freshBoot,
          integrityFailure: result.integrityFailure,
          error: result.error,
        }),
      });
      // Integrity-gate refusals surface as the typed wake error so the job's
      // error_message is the full user-legible explanation (backup, failure
      // kind, escape hatches). AGENT_WAKE has no permanent-failure writeback,
      // so exhausting attempts leaves the sandbox row `sleeping` — state
      // preserved, per the #15603 B6 contract.
      if (result.integrityFailure) {
        throw new WakeRestoreIntegrityError(result.integrityFailure);
      }
      throw new Error(result.error ?? "Unknown agent_wake failure");
    }

    const jobResult: AgentWakeJobResult = {
      cloudAgentId: data.agentId,
      reprovisioned: result.reprovisioned,
      restoredBackupId: result.restoredBackupId,
      freshBoot: result.freshBoot,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentWakeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_wake completed", {
      jobId: job.id,
      agentId: data.agentId,
      reprovisioned: result.reprovisioned,
      restoredBackupId: result.restoredBackupId,
    });
  }

  private async executeAgentRestart(job: Job): Promise<void> {
    const data = readAgentRestartJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_restart", {
      jobId: job.id,
      agentId: data.agentId,
      stateLossAcknowledged: data.stateLossAcknowledged || undefined,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeRestart(data.agentId, data.organizationId, {
      stateLossAcknowledged: data.stateLossAcknowledged,
    });

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: agentRestartJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStopped: result.containerStopped,
          containerStarted: result.containerStarted,
          error: result.error,
        }),
      });
      if (result.retryable) {
        throw new RetryableProvisionTransportError(
          result.error ?? "Snapshot capture temporarily unavailable",
          retrySnapshot,
          PROVISION_TRANSPORT_MAX_FREE_RETRIES,
        );
      }
      throw new Error(result.error ?? "Unknown agent_restart failure");
    }

    const jobResult: AgentRestartJobResult = {
      cloudAgentId: data.agentId,
      containerStopped: result.containerStopped,
      containerStarted: result.containerStarted,
      bridgeUrl: result.bridgeUrl,
      healthUrl: result.healthUrl,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentRestartJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_restart completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: result.containerStopped,
      containerStarted: result.containerStarted,
    });
  }

  private async executeAgentUpgrade(job: Job): Promise<void> {
    const data = readAgentUpgradeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_upgrade", {
      jobId: job.id,
      agentId: data.agentId,
      dockerImage: data.dockerImage,
      fromDigest: data.fromDigest,
      toDigest: data.toDigest,
    });

    const startedAt = Date.now();
    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeUpgrade(
      data.agentId,
      data.organizationId,
      data.toDigest,
      data.dockerImage,
      data.fromDigest,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      // Failures are visible by the row staying on the OLD image_digest; the
      // reconciler will try again on the next cycle. The worker's standard
      // error handling marks the job failed and stores this error message.
      //
      // Carry executeUpgrade's rollback-safe classification through the generic
      // catch → incrementAttempt → buildPermanentFailureWriteback path so the
      // permanent-failure writeback can distinguish a still-serving old
      // container (rollback-safe: keep `running`) from a genuinely-down agent
      // (keep the terminal error writeback). Default UNKNOWN classifications to
      // rollback-safe (`true`): erroring a still-serving agent (proxy rejects
      // live traffic + orphan reconciler reaps it) is strictly worse than
      // leaving a genuinely-dead agent non-terminal (the stuck-recovery cron is
      // the backstop for that case).
      throw new UpgradeFailedError(result.error ?? "Unknown agent_upgrade failure", {
        rolledBack: result.rolledBack ?? true,
        toDigest: data.toDigest,
      });
    }

    const jobResult: AgentUpgradeJobResult = {
      oldNodeId: result.oldNodeId ?? "",
      oldContainerName: result.oldContainerName ?? "",
      newNodeId: result.newNodeId ?? "",
      newContainerName: result.newContainerName ?? "",
      newDigest: result.newDigest ?? data.toDigest,
      durationMs: Date.now() - startedAt,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentUpgradeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_upgrade completed", {
      jobId: job.id,
      agentId: data.agentId,
      oldNodeId: jobResult.oldNodeId,
      newNodeId: jobResult.newNodeId,
      durationMs: jobResult.durationMs,
    });
  }

  private async executeAdminCanaryImage(job: Job): Promise<void> {
    const data = readAdminCanaryImageJobData(job);
    if (data.organizationId !== job.organization_id || data.actorUserId !== job.user_id) {
      throw new Error(`Admin canary audit identity mismatch for job ${job.id}`);
    }
    const startedAt = jobAuditTimestamp(job.started_at ?? job.updated_at);
    const priorCutover = isPendingAdminCanaryCutoverAudit(job.result) ? job.result : undefined;
    const pendingCutoverMatchesSnapshot = (
      pendingAudit: AdminCanaryImageJobResult,
      snapshot: Job,
    ): boolean => {
      const auditStartedAt =
        typeof pendingAudit.startedAt === "string"
          ? Date.parse(pendingAudit.startedAt)
          : Number.NaN;
      const cutoverAt =
        typeof pendingAudit.cutoverAt === "string"
          ? Date.parse(pendingAudit.cutoverAt)
          : Number.NaN;
      const rowStartedAt =
        snapshot.started_at === null
          ? Number.NaN
          : Date.parse(jobAuditTimestamp(snapshot.started_at));
      const rowUpdatedAt = Date.parse(jobAuditTimestamp(snapshot.updated_at));
      const directCutoverSnapshot =
        pendingAudit.startedAt ===
          (snapshot.started_at === null ? "" : jobAuditTimestamp(snapshot.started_at)) &&
        pendingAudit.cutoverAt === jobAuditTimestamp(snapshot.updated_at);
      const resumedCleanupClaim = cutoverResumeWindowAllows({
        cutoverAtMs: cutoverAt,
        rowStartedAtMs: rowStartedAt,
        rowUpdatedAtMs: rowUpdatedAt,
      });
      return (
        Number.isFinite(auditStartedAt) &&
        Number.isFinite(cutoverAt) &&
        auditStartedAt <= cutoverAt &&
        (directCutoverSnapshot || resumedCleanupClaim) &&
        snapshot.status === "in_progress" &&
        snapshot.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE &&
        snapshot.organization_id === data.organizationId &&
        snapshot.user_id === data.actorUserId &&
        snapshot.agent_id === data.agentId &&
        snapshot.data_storage === "inline" &&
        snapshot.data_key === null &&
        JSON.stringify(snapshot.data) === JSON.stringify(job.data) &&
        snapshot.result_storage === "inline" &&
        snapshot.result_key === null &&
        snapshot.completed_at === null &&
        snapshot.started_at !== null &&
        pendingAudit.finishedAt === pendingAudit.cutoverAt &&
        pendingAudit.jobId === snapshot.id &&
        pendingAudit.operation === data.operation &&
        pendingAudit.rolloutId === data.rolloutId &&
        pendingAudit.actorUserId === data.actorUserId &&
        pendingAudit.decisionAt === data.decisionAt &&
        pendingAudit.agentId === data.agentId &&
        pendingAudit.organizationId === data.organizationId &&
        pendingAudit.targetOwnerUserId === data.targetOwnerUserId &&
        pendingAudit.sourceImage === data.sourceImage &&
        pendingAudit.sourceDigest === data.sourceDigest &&
        pendingAudit.targetImage === data.targetImage &&
        pendingAudit.targetDigest === data.targetDigest &&
        typeof pendingAudit.oldNodeId === "string" &&
        pendingAudit.oldNodeId.length > 0 &&
        typeof pendingAudit.oldContainerName === "string" &&
        pendingAudit.oldContainerName.length > 0 &&
        typeof pendingAudit.newNodeId === "string" &&
        pendingAudit.newNodeId.length > 0 &&
        typeof pendingAudit.newContainerName === "string" &&
        pendingAudit.newContainerName.length > 0
      );
    };
    let completedAudit: AdminCanaryImageJobResult | undefined;
    const completeCutoverInTx = async (
      tx: DbTransaction,
      pendingAudit: AdminCanaryImageJobResult,
      snapshot: Job,
    ): Promise<void> => {
      const finishedAt = new Date();
      const completion: AdminCanaryImageJobResult = {
        ...pendingAudit,
        success: true,
        cleanupPending: false,
        finishedAt: finishedAt.toISOString(),
      };
      const [updated] = await tx
        .update(jobs)
        .set({
          status: "completed",
          result: adminCanaryImageJobResultToRecord(completion),
          result_storage: "inline",
          result_key: null,
          error: null,
          error_storage: "inline",
          error_key: null,
          completed_at: finishedAt,
          execution_quiesced_at: finishedAt,
          updated_at: finishedAt,
        })
        .where(
          and(
            eq(jobs.id, snapshot.id),
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            eq(jobs.status, "in_progress"),
            eq(jobs.organization_id, data.organizationId),
            eq(jobs.agent_id, data.agentId),
            eq(jobs.user_id, data.actorUserId),
            eq(jobs.attempts, snapshot.attempts),
            eq(jobs.max_attempts, snapshot.max_attempts),
            sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${snapshot.execution_generation}`,
            isNull(jobs.execution_quiesced_at),
            // #17919 / #17284 class: ms-window fence so µs-stored NOW() rows match JS reads
            msWindowTimestampMatch(
              jobs.started_at,
              snapshot.started_at ? new Date(jobAuditTimestamp(snapshot.started_at)) : null,
            ),
            msWindowTimestampMatch(
              jobs.completed_at,
              snapshot.completed_at ? new Date(jobAuditTimestamp(snapshot.completed_at)) : null,
            ),
            msWindowTimestampMatch(
              jobs.updated_at,
              new Date(jobAuditTimestamp(snapshot.updated_at)),
            ),
            sql`${jobs.data_storage} = 'inline'`,
            sql`${jobs.data_key} IS NOT DISTINCT FROM ${snapshot.data_key}`,
            sql`${jobs.data} IS NOT DISTINCT FROM ${JSON.stringify(snapshot.data)}::jsonb`,
            sql`${jobs.result_storage} = 'inline'`,
            sql`${jobs.result_key} IS NOT DISTINCT FROM ${snapshot.result_key}`,
            sql`${jobs.result} IS NOT DISTINCT FROM ${JSON.stringify(pendingAudit)}::jsonb`,
            sql`${jobs.error_storage} = ${snapshot.error_storage}`,
            sql`${jobs.error_key} IS NOT DISTINCT FROM ${snapshot.error_key}`,
            sql`${jobs.error} IS NOT DISTINCT FROM ${snapshot.error ?? null}`,
          ),
        )
        .returning({ id: jobs.id });
      if (!updated) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${snapshot.id} changed before cleanup completion`,
        );
      }
      if (!snapshot.execution_generation) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${snapshot.id} has no execution generation`,
        );
      }
      await tx
        .update(agentSandboxes)
        .set({
          lifecycle_job_id: null,
          lifecycle_execution_generation: null,
        })
        .where(
          and(
            eq(agentSandboxes.id, data.agentId),
            eq(agentSandboxes.organization_id, data.organizationId),
            eq(agentSandboxes.lifecycle_job_id, snapshot.id),
            eq(agentSandboxes.lifecycle_execution_generation, snapshot.execution_generation),
          ),
        );
      completedAudit = completion;
    };
    if (priorCutover) {
      if (!pendingCutoverMatchesSnapshot(priorCutover, job)) {
        throw new Error(`Admin canary pending-cutover audit mismatch for job ${job.id}`);
      }
      const oldNodeId = priorCutover.oldNodeId as string;
      const oldContainerName = priorCutover.oldContainerName as string;
      const newNodeId = priorCutover.newNodeId as string;
      const newContainerName = priorCutover.newContainerName as string;
      try {
        await elizaSandboxService.convergeReplacementCleanupFence(
          data.agentId,
          data.organizationId,
          {
            targetOwnerUserId: data.targetOwnerUserId,
            targetImage: data.targetImage,
            targetDigest: data.targetDigest,
            newNodeId,
            newContainerName,
            oldNodeId,
            oldContainerName,
          },
          async (tx) => completeCutoverInTx(tx, priorCutover, job),
        );
      } catch (error) {
        if (
          safeErrorKind(error, AdminCanaryCleanupExpectationError) ||
          safeErrorKind(error, AdminCanaryCleanupCommitError)
        ) {
          throw error;
        }
        // error-policy:J2 context-adding rethrow — the queue needs a typed
        // retryable failure while preserving the cleanup cause.
        throw new RetryableReplacementCleanupError(
          // Summary only: the full error travels as `cause` below, and
          // interpolating its stack here would fill the 4,000-char job budget
          // with the inner frames, truncating away both the outer frames and
          // the cause chain at exactly the site #23117 needs them.
          `Admin canary cleanup remains pending: ${jobErrorSummary(error)}`,
          job,
          { cause: error },
        );
      }
      if (!completedAudit) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${job.id} cleanup converged without a completed audit`,
        );
      }
      logger.info("[provisioning-jobs] Admin canary cleanup converged", {
        jobId: job.id,
        rolloutId: data.rolloutId,
        agentId: data.agentId,
      });
      return;
    }

    let committedAudit: AdminCanaryImageJobResult | undefined;
    let committedJobSnapshot: Job | undefined;
    const onCutoverInTx = async (
      tx: DbTransaction,
      cutover: {
        oldNodeId: string;
        oldContainerName: string;
        newNodeId: string;
        newContainerName: string;
        newDigest: string;
      },
    ): Promise<void> => {
      if (cutover.newDigest !== data.targetDigest) {
        throw new Error(`Admin canary cutover digest mismatch for job ${job.id}`);
      }
      const finishedAt = new Date();
      const cutoverAt = finishedAt.toISOString();
      const jobResult: AdminCanaryImageJobResult = {
        success: false,
        cleanupPending: true,
        cutoverAt,
        jobId: job.id,
        operation: data.operation,
        rolloutId: data.rolloutId,
        actorUserId: data.actorUserId,
        decisionAt: data.decisionAt,
        agentId: data.agentId,
        organizationId: data.organizationId,
        targetOwnerUserId: data.targetOwnerUserId,
        sourceImage: data.sourceImage,
        sourceDigest: data.sourceDigest,
        targetImage: data.targetImage,
        targetDigest: data.targetDigest,
        startedAt,
        finishedAt: cutoverAt,
        oldNodeId: cutover.oldNodeId,
        oldContainerName: cutover.oldContainerName,
        newNodeId: cutover.newNodeId,
        newContainerName: cutover.newContainerName,
      };
      const [updated] = await tx
        .update(jobs)
        .set({
          result: adminCanaryImageJobResultToRecord(jobResult),
          result_storage: "inline",
          result_key: null,
          error: null,
          error_storage: "inline",
          error_key: null,
          completed_at: null,
          updated_at: finishedAt,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            eq(jobs.status, "in_progress"),
            eq(jobs.organization_id, data.organizationId),
            eq(jobs.agent_id, data.agentId),
            eq(jobs.user_id, data.actorUserId),
            eq(jobs.attempts, job.attempts),
            eq(jobs.max_attempts, job.max_attempts),
            sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${job.execution_generation}`,
            isNull(jobs.execution_quiesced_at),
            // #17919 / #17284 class: ms-window fence so µs-stored NOW() rows match JS reads
            msWindowTimestampMatch(
              jobs.started_at,
              job.started_at ? new Date(jobAuditTimestamp(job.started_at)) : null,
            ),
            msWindowTimestampMatch(
              jobs.completed_at,
              job.completed_at ? new Date(jobAuditTimestamp(job.completed_at)) : null,
            ),
            msWindowTimestampMatch(jobs.updated_at, new Date(jobAuditTimestamp(job.updated_at))),
            sql`${jobs.data_storage} = 'inline'`,
            sql`${jobs.data_key} IS NOT DISTINCT FROM ${job.data_key}`,
            sql`${jobs.data} IS NOT DISTINCT FROM ${JSON.stringify(job.data)}::jsonb`,
            sql`${jobs.result_storage} = ${job.result_storage}`,
            sql`${jobs.result_key} IS NOT DISTINCT FROM ${job.result_key}`,
            job.result == null
              ? sql`${jobs.result} IS NULL`
              : sql`${jobs.result} IS NOT DISTINCT FROM ${JSON.stringify(job.result)}::jsonb`,
            sql`${jobs.error_storage} = ${job.error_storage}`,
            sql`${jobs.error_key} IS NOT DISTINCT FROM ${job.error_key}`,
            sql`${jobs.error} IS NOT DISTINCT FROM ${job.error ?? null}`,
          ),
        )
        .returning();
      if (!updated) {
        throw new Error(`Admin canary job ${job.id} changed before atomic cutover audit`);
      }
      committedAudit = jobResult;
      committedJobSnapshot = await hydrateJob(updated);
    };
    const onConvergedInTx = async (tx: DbTransaction): Promise<void> => {
      if (!committedAudit || !committedJobSnapshot) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${job.id} cleanup ran without a committed cutover audit`,
        );
      }
      await completeCutoverInTx(tx, committedAudit, committedJobSnapshot);
    };
    const readDurablePendingCutover = async (): Promise<Job | undefined> => {
      const current = await jobsRepository.findByIdForWrite(job.id);
      if (!current || !isPendingAdminCanaryCutoverAudit(current.result)) return undefined;
      return pendingCutoverMatchesSnapshot(current.result, current) ? current : undefined;
    };

    logger.info("[provisioning-jobs] Executing admin canary image change", {
      jobId: job.id,
      rolloutId: data.rolloutId,
      actorUserId: data.actorUserId,
      agentId: data.agentId,
      organizationId: data.organizationId,
      operation: data.operation,
      sourceImage: data.sourceImage,
      sourceDigest: data.sourceDigest,
      targetImage: data.targetImage,
      targetDigest: data.targetDigest,
    });

    let result: Awaited<ReturnType<typeof elizaSandboxService.executeAdminCanaryUpgrade>>;
    await this.assertExecutionMutationLease(job);
    try {
      result =
        data.operation === "upgrade"
          ? await elizaSandboxService.executeAdminCanaryUpgrade({
              agentId: data.agentId,
              organizationId: data.organizationId,
              targetOwnerUserId: data.targetOwnerUserId,
              sourceImage: data.sourceImage,
              sourceDigest: data.sourceDigest,
              targetImage: data.targetImage,
              targetDigest: data.targetDigest,
              onCutoverInTx,
              onConvergedInTx,
            })
          : await elizaSandboxService.executeAdminCanaryRollback({
              agentId: data.agentId,
              organizationId: data.organizationId,
              targetOwnerUserId: data.targetOwnerUserId,
              sourceImage: data.sourceImage,
              sourceDigest: data.sourceDigest,
              targetImage: data.targetImage,
              targetDigest: data.targetDigest,
              onCutoverInTx,
              onConvergedInTx,
            });
    } catch (error) {
      // error-policy:J2 A post-cutover failure is rethrown with the exact
      // durable retry snapshot; failures before cutover retain their identity.
      const retrySnapshot = await readDurablePendingCutover();
      if (retrySnapshot) {
        throw new RetryableReplacementCleanupError(
          `Admin canary post-cutover convergence interrupted: ${jobErrorText(error)}`,
          retrySnapshot,
          { cause: error },
        );
      }
      throw error;
    }

    if (!result.success) {
      if (result.cleanupPending) {
        const retrySnapshot = (await readDurablePendingCutover()) ?? job;
        throw new RetryableReplacementCleanupError(
          result.error ?? "Admin canary pre-cutover cleanup remains pending",
          retrySnapshot,
        );
      }
      throw new Error(result.error ?? "Admin canary image change failed");
    }
    if (!committedAudit) {
      throw new Error(`Admin canary job ${job.id} cut over without a committed audit`);
    }
    if (result.cleanupPending) {
      const retrySnapshot = await readDurablePendingCutover();
      if (!retrySnapshot) {
        throw new Error(`Admin canary job ${job.id} lost its committed cutover audit`);
      }
      throw new RetryableReplacementCleanupError(
        result.error ?? "Admin canary post-cutover cleanup remains pending",
        retrySnapshot,
      );
    }
    if (!completedAudit) {
      throw new AdminCanaryCleanupCommitError(
        `Admin canary job ${job.id} cleanup completed without atomic job completion`,
      );
    }

    logger.info("[provisioning-jobs] Admin canary image change completed", {
      jobId: job.id,
      rolloutId: data.rolloutId,
      actorUserId: data.actorUserId,
      agentId: data.agentId,
      operation: data.operation,
      targetImage: data.targetImage,
      targetDigest: data.targetDigest,
      durationMs: new Date(completedAudit.finishedAt).getTime() - new Date(startedAt).getTime(),
    });
  }

  private async executeAgentDowngrade(job: Job): Promise<void> {
    const data = readAgentDowngradeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_downgrade", {
      jobId: job.id,
      agentId: data.agentId,
      dockerImage: data.dockerImage,
      fromDigest: data.fromDigest,
    });

    const startedAt = Date.now();
    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeDowngrade(
      data.agentId,
      data.organizationId,
      data.dockerImage,
      data.fromDigest,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      // Failures leave the agent on its current image (the swap is atomic and
      // only commits after the rollback container is healthy); the worker's
      // standard error handling marks the job failed with this message.
      throw new Error(result.error ?? "Unknown agent_downgrade failure");
    }

    const jobResult: AgentDowngradeJobResult = {
      oldNodeId: result.oldNodeId ?? "",
      oldContainerName: result.oldContainerName ?? "",
      newNodeId: result.newNodeId ?? "",
      newContainerName: result.newContainerName ?? "",
      newDigest: result.newDigest ?? "",
      durationMs: Date.now() - startedAt,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentDowngradeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_downgrade completed", {
      jobId: job.id,
      agentId: data.agentId,
      oldNodeId: jobResult.oldNodeId,
      newNodeId: jobResult.newNodeId,
      newDigest: jobResult.newDigest,
      durationMs: jobResult.durationMs,
    });
  }

  private async executeAgentLogs(job: Job): Promise<void> {
    const data = readAgentLogsJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_logs", {
      jobId: job.id,
      agentId: data.agentId,
      tail: data.tail,
    });

    const result = await elizaSandboxService.executeLogs(
      data.agentId,
      data.organizationId,
      data.tail,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: agentLogsJobResultToRecord({
          cloudAgentId: data.agentId,
          status: result.status,
          tail: data.tail,
          message: result.message,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_logs failure");
    }

    const jobResult: AgentLogsJobResult = {
      cloudAgentId: data.agentId,
      status: result.status,
      tail: data.tail,
      logs: result.logs,
      message: result.message,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentLogsJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_logs completed", {
      jobId: job.id,
      agentId: data.agentId,
      status: result.status,
      bytes: result.logs?.length ?? 0,
    });
  }

  /**
   * Deliver a patron chat turn to the agent's bridge. Runs on the daemon,
   * which (unlike the CF edge worker) can reach the container's raw bridge
   * port, so it just calls elizaSandboxService.bridge('message.send'), which
   * already implements the robust multi-strategy send + no-reply fallback.
   * Stores the reply text on the job result for the route to poll.
   */
  private async executeAgentMessage(job: Job): Promise<void> {
    const data = readAgentMessageJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_message", {
      jobId: job.id,
      agentId: data.agentId,
      chars: data.text.length,
    });

    await this.assertExecutionMutationLease(job);
    const response = await elizaSandboxService.bridge(data.agentId, data.organizationId, {
      jsonrpc: "2.0",
      method: "message.send",
      params: {
        text: data.text,
        ...(data.senderId ? { userId: data.senderId } : {}),
        ...(data.sessionId ? { sessionId: data.sessionId } : {}),
        ...(data.roomId ? { roomId: data.roomId } : {}),
      },
    });

    if (response.error) {
      await this.updateClaimedExecution(job, {
        result: agentMessageJobResultToRecord({
          cloudAgentId: data.agentId,
          error: response.error.message,
        }),
      });
      throw new Error(response.error.message || "agent_message bridge failure");
    }

    const result = (response.result ?? {}) as Record<string, unknown>;
    const jobResult: AgentMessageJobResult = {
      cloudAgentId: data.agentId,
      text: typeof result.text === "string" ? result.text : undefined,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentMessageJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_message completed", {
      jobId: job.id,
      agentId: data.agentId,
      replyChars: jobResult.text?.length ?? 0,
    });
  }

  private async executeAgentSnapshot(job: Job): Promise<void> {
    const data = readAgentSnapshotJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    // Belt to the lane filter (#16639): a snapshot job claimed through any
    // other path while the gate is off is re-scheduled without burning an
    // attempt — observable, never a fabricated success.
    if (!ProvisioningJobService.snapshotJobsEnabled()) {
      logger.warn("[provisioning-jobs] agent_snapshot blocked by disabled gate", {
        jobId: job.id,
        agentId: data.agentId,
      });
      await this.retryOwnedWrite(job, "snapshot-gate-retry", () =>
        jobsRepository.retryLaterWithoutIncrementingAttempts(
          job,
          "agent_snapshot lane disabled (ELIZA_SNAPSHOT_JOBS_ENABLED != true)",
          SNAPSHOT_GATE_RETRY_DELAY_MS,
          this.executionOwnerId,
        ),
      );
      return;
    }

    logger.info("[provisioning-jobs] Executing agent_snapshot", {
      jobId: job.id,
      agentId: data.agentId,
      snapshotType: data.snapshotType,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeSnapshot(
      data.agentId,
      data.organizationId,
      data.snapshotType,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    // Attempt bookkeeping (#15783): record that a capture was tried regardless
    // of outcome, and keep the snapshot-capability marker current —
    // `last_backup_at` stays success-only so staleness stays honest, while
    // `backup_unsupported_reason` moves incapable images out of the sweep's
    // hot window until their slow re-probe. A successful capture always
    // clears the marker (the image evidently serves the route now).
    await this.recordSnapshotAttemptMarkers(
      data.agentId,
      result.success
        ? "success"
        : result.error === SNAPSHOT_ENDPOINT_UNSUPPORTED
          ? "unsupported"
          : "other",
    );

    // Scheduled (auto) backups run across every non-pool sandbox, but an idle
    // agent (stopped/sleeping/disconnected — no bridge_url) legitimately has no
    // live state to snapshot. Treating that as a hard failure burned three
    // attempts per agent per tick and flooded the failed-jobs view (the bulk of
    // it was "Sandbox is not running"), masking real snapshot failures. For an
    // auto snapshot this is a benign no-op, so mark it completed-as-skipped
    // WITHOUT throwing (no retry). MANUAL snapshots still surface the error —
    // the user explicitly asked for a backup and deserves to know it can't run.
    if (
      !result.success &&
      data.snapshotType === "auto" &&
      (result.error === "Sandbox is not running" || result.error === SNAPSHOT_ENDPOINT_UNSUPPORTED)
    ) {
      await this.settleClaimedExecution(job, "completed", {
        result: agentSnapshotJobResultToRecord({
          cloudAgentId: data.agentId,
          skipped: true,
          reason: result.error,
        }),
        completed_at: new Date(),
      });
      // Neutral message + reason so the V2-image snapshot-capability gap stays
      // observable in logs instead of being mislabeled "agent not running".
      logger.info("[provisioning-jobs] auto snapshot skipped", {
        jobId: job.id,
        agentId: data.agentId,
        reason: result.error,
      });
      return;
    }

    if (!result.success) {
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: agentSnapshotJobResultToRecord({
          cloudAgentId: data.agentId,
          error: result.error,
        }),
      });
      if (result.retryable) {
        throw new RetryableProvisionTransportError(
          result.error ?? "Snapshot capture temporarily unavailable",
          retrySnapshot,
          PROVISION_TRANSPORT_MAX_FREE_RETRIES,
        );
      }
      throw new Error(result.error ?? "Unknown agent_snapshot failure");
    }

    const jobResult: AgentSnapshotJobResult = {
      cloudAgentId: data.agentId,
      backupId: result.backup?.id,
      snapshotType: result.backup?.snapshot_type ?? data.snapshotType,
      sizeBytes: result.backup?.size_bytes ?? undefined,
      createdAt: result.backup?.created_at
        ? new Date(result.backup.created_at).toISOString()
        : undefined,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentSnapshotJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_snapshot completed", {
      jobId: job.id,
      agentId: data.agentId,
      backupId: jobResult.backupId,
      bytes: jobResult.sizeBytes,
    });
  }

  private async executeAgentDelete(job: Job): Promise<void> {
    const data = readAgentDeleteJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_delete", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    // A concurrent acknowledged DELETE may have upgraded the durable job data
    // after this worker claimed its in-memory snapshot (`upgradeReuse`). The
    // claimed object cannot observe that write, so re-read the row from the
    // primary under the execution lease immediately before the destructive
    // boundary. Authority is monotonic: the durable read may strengthen the
    // claimed snapshot, never weaken it.
    const durableJob = await jobsRepository.findByIdForWrite(job.id);
    const durableData = durableJob ? readAgentDeleteJobData(durableJob) : undefined;
    const authorityData = hasCompleteAgentDeleteAuthority(durableData)
      ? durableData
      : hasCompleteAgentDeleteAuthority(data)
        ? data
        : data;
    const stateLossAcknowledged = hasCompleteAgentDeleteAuthority(authorityData);
    const delResult = stateLossAcknowledged
      ? await elizaSandboxService.executeDeletion(
          data.agentId,
          data.organizationId,
          data.authorization,
          true,
        )
      : await elizaSandboxService.executeDeletion(
          data.agentId,
          data.organizationId,
          data.authorization,
        );

    if (!delResult.success) {
      // The free requeue is bounded. `retryLaterWithoutIncrementingAttempts`
      // leaves `attempts` alone by design, so a capture failure that stays
      // transient would requeue forever and a user-requested delete would
      // become an immortal — still billed — agent. Count the free requeues on
      // the job result and escalate past the cap.
      const priorCaptureRetries = Math.max(
        job.retryable_requeues,
        readAgentDeleteCaptureRetryCount(job.result),
      );
      const captureRetryExhausted =
        delResult.retryable && priorCaptureRetries >= PRE_DELETE_CAPTURE_MAX_FREE_RETRIES;
      const captureRetryCount = delResult.retryable ? priorCaptureRetries + 1 : priorCaptureRetries;
      // Persist a partial result and rethrow so the jobs runner counts an
      // attempt and retries (or marks failed on exhaustion).
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: agentDeleteJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStopped: delResult.containerStopped,
          rowDeleted: false,
          ...agentDeleteAuthorityResult(authorityData),
          error: delResult.error,
          ...(captureRetryCount > 0 ? { captureRetryCount } : {}),
        }),
      });
      if (delResult.retryable && !captureRetryExhausted) {
        // A transient pre-deletion capture failure retries for free (same
        // rule the restart/snapshot handlers apply to shutdown's identical
        // signal) so the PGlite-closing race cannot exhaust the attempt
        // budget and strand the deletion (#18517).
        throw new RetryableProvisionTransportError(
          delResult.error ?? "Pre-deletion capture temporarily unavailable",
          retrySnapshot,
          PRE_DELETE_CAPTURE_MAX_FREE_RETRIES,
        );
      }
      if (captureRetryExhausted) {
        logger.error(
          "[provisioning-jobs] agent_delete pre-deletion capture exhausted its free-retry budget",
          {
            jobId: job.id,
            agentId: data.agentId,
            captureRetryCount: priorCaptureRetries,
            maxFreeRetries: PRE_DELETE_CAPTURE_MAX_FREE_RETRIES,
            error: delResult.error,
          },
        );
        const message = `Pre-deletion capture stayed unavailable across ${priorCaptureRetries} attempt-preserving retries: ${
          delResult.error ?? "unknown capture failure"
        }`;
        if (!stateLossAcknowledged) {
          throw new UnacknowledgedAgentDeleteError(message, retrySnapshot);
        }
        throw new PreDeleteCaptureExhaustedError(message);
      }
      const message = delResult.error ?? "Unknown agent_delete failure";
      if (!stateLossAcknowledged) {
        throw new UnacknowledgedAgentDeleteError(message, retrySnapshot);
      }
      throw new Error(message);
    }

    const jobResult = await this.settleCompletedAgentDelete(job, data, delResult);

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_delete completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: delResult.containerStopped,
    });
  }

  private async executeAgentProvision(job: Job): Promise<void> {
    const data = readAgentProvisionJobData(job);

    // Cross-check: the org ID stored in the JSONB payload must match the
    // first-class organization_id column. A mismatch indicates either a bug
    // in the enqueue path or data tampering.
    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_provision", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    const restoreDirective = await resolveReviewedProvisionRestoreDirectiveForExecution(data);
    const provResult = await elizaSandboxService.provision(
      data.agentId,
      data.organizationId,
      restoreDirective,
    );

    if (await this.completeIfAgentGone(job, provResult, data.agentId)) return;

    if (!provResult.success) {
      const provisionError = preserveProvisionFailureAcrossCleanupRetry(
        job.result,
        provResult.error,
      );
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: agentProvisionJobResultToRecord({
          cloudAgentId: data.agentId,
          status: provResult.sandboxRecord?.status ?? "error",
          error: provisionError,
        }),
      });
      if (provResult.retryable) {
        const cleanupOnlyRetry = provResult.error.startsWith(REPLACEMENT_CLEANUP_ONLY_PREFIX);
        const failureCause = cleanupOnlyRetry && job.error ? undefined : provResult.failureCause;
        throw new RetryableProvisionTransportError(
          provisionError,
          retrySnapshot,
          PROVISION_TRANSPORT_MAX_FREE_RETRIES,
          failureCause === undefined && !(cleanupOnlyRetry && job.error)
            ? undefined
            : {
                cause: failureCause,
                // The original startup failure is already a complete,
                // redacted durable diagnostic. Re-wrapping that serialized
                // text as a new Error cause copies every prior stack on each
                // cleanup retry and grows jobs.error geometrically. Preserve
                // it byte-for-byte; the refreshed cleanup fact is retained in
                // result.error above.
                durableErrorText: cleanupOnlyRetry ? (job.error ?? undefined) : undefined,
              },
        );
      }
      throw new ElizaError(provisionError, {
        code: "AGENT_PROVISION_FAILED",
        context: { jobId: job.id, agentId: data.agentId },
        cause: provResult.failureCause,
      });
    }

    const jobResult: AgentProvisionJobResult = {
      cloudAgentId: data.agentId,
      status: provResult.sandboxRecord.status,
      bridgeUrl: provResult.bridgeUrl,
      healthUrl: provResult.healthUrl,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: agentProvisionJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_provision completed", {
      jobId: job.id,
      agentId: data.agentId,
      status: provResult.sandboxRecord.status,
    });
  }

  /**
   * Drive heartbeats for every running sandbox. The on-prem worker calls this
   * each cycle so last_heartbeat_at stays fresh and unreachable agents flip
   * to disconnected. Heartbeats are HTTP fetches over the Headscale tunnel,
   * so this only runs from the Node sidecar (not from the Cloudflare Worker).
   */
  async processRunningHeartbeats(concurrency = 5): Promise<HeartbeatResult> {
    const running = await agentSandboxesRepository.listRunning();
    const total = running.length;
    if (total === 0) return { total: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;
    const queue = [...running];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        const ok = await elizaSandboxService
          .heartbeat(r.id, r.organization_id)
          .catch((error: unknown) => {
            logger.warn("[provisioning-jobs] heartbeat threw", {
              agentId: r.id,
              error: jobErrorText(error),
            });
            return false;
          });
        if (ok) succeeded += 1;
        else failed += 1;
      }
    });
    await Promise.all(workers);

    return { total, succeeded, failed };
  }

  /**
   * Reconcile `disconnected` always-on (paid) agents back to health. The
   * heartbeat cycle only iterates RUNNING agents, so a `dedicated-always` agent
   * that dropped past the grace window and flipped to `disconnected` would
   * otherwise stay dead forever (the agent-router routes only `running`, so its
   * subdomain 404s and the user's paid agent is unreachable). Each cycle
   * re-probes the bridge: still reachable → flip straight back to `running`;
   * truly down → enqueue a re-provision (idempotent — `enqueueAgentProvisionOnce`
   * dedups an in-flight job, so running this every cycle won't pile up provisions).
   */
  async processDisconnectedRecovery(concurrency = 5): Promise<RecoveryResult> {
    const recoverable = await agentSandboxesRepository.listRecoverable();
    const total = recoverable.length;
    if (total === 0) {
      return { total: 0, recovered: 0, reprovisioned: 0, failed: 0 };
    }

    let recovered = 0;
    let reprovisioned = 0;
    let failed = 0;
    const queue = [...recoverable];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        try {
          const outcome = await elizaSandboxService.recoverDisconnected(r.id, r.organization_id);
          if (outcome === "recovered") {
            recovered += 1;
            continue;
          }
          if (outcome === "gone") {
            // No longer disconnected (already recovered/deleted) — nothing to do.
            continue;
          }
          // Still unreachable — rebuild it.
          await this.enqueueAgentProvisionOnce({
            agentId: r.id,
            organizationId: r.organization_id,
            userId: r.user_id,
            agentName: r.agent_name ?? r.id,
            expectedLifecycleRevision: r.lifecycle_revision,
          });
          reprovisioned += 1;
        } catch (error) {
          failed += 1;
          logger.warn("[provisioning-jobs] disconnected recovery failed", {
            agentId: r.id,
            error: jobErrorText(error),
          });
        }
      }
    });
    await Promise.all(workers);

    return { total, recovered, reprovisioned, failed };
  }

  /**
   * Reconcile rows WEDGED in `provisioning` whose container is actually healthy
   * — the readiness-probe false-negative split-brain (#15310 failure mode #6).
   *
   * A dedicated agent whose readiness probe returned a transient false-negative
   * (SSH/exec blip) never flips to `running`; its row sits `provisioning`
   * forever while the container serves happily. The Worker-side cleanup cron
   * can only mark such rows `error` (it has no SSH). This daemon-side pass
   * (which CAN reach the node) re-probes each stuck container and flips it to
   * `running` when it re-probes healthy — self-healing the split-brain instead
   * of stranding a live agent or waiting for a human to flip the row.
   *
   * Mirrors `processDisconnectedRecovery`: candidate query (`minAgeMs` grace,
   * no active provision job racing it), bounded concurrency, per-agent probe.
   * It NEVER tears a container down — an `unresolved` probe leaves the row for
   * the next pass (and, as a last resort, the Worker cron's error mark).
   */
  async reconcileStuckProvisioning(params?: {
    minAgeMs?: number;
    maxAgents?: number;
    concurrency?: number;
  }): Promise<{ total: number; recovered: number; unresolved: number; failed: number }> {
    const minAgeMs = params?.minAgeMs ?? 5 * 60 * 1000; // 5m grace beyond normal boot
    const maxAgents = params?.maxAgents ?? 50;
    const concurrency = params?.concurrency ?? 5;
    const cutoff = new Date(Date.now() - minAgeMs);

    const stuck = await agentSandboxesRepository.listStuckProvisioningWithContainer(
      cutoff,
      maxAgents,
    );
    const total = stuck.length;
    if (total === 0) return { total: 0, recovered: 0, unresolved: 0, failed: 0 };

    let recovered = 0;
    let unresolved = 0;
    let failed = 0;
    const queue = [...stuck];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        try {
          const outcome = await elizaSandboxService.reconcileStuckProvisioning(
            r.id,
            r.organization_id,
          );
          if (outcome === "recovered") recovered += 1;
          else unresolved += 1; // "gone" is a no-op, count with unresolved
        } catch (error) {
          failed += 1;
          logger.warn("[provisioning-jobs] stuck-provisioning reconcile failed", {
            agentId: r.id,
            error: jobErrorText(error),
          });
        }
      }
    });
    await Promise.all(workers);

    if (recovered > 0 || failed > 0) {
      logger.info("[provisioning-jobs] stuck-provisioning reconcile pass", {
        total,
        recovered,
        unresolved,
        failed,
      });
    }
    return { total, recovered, unresolved, failed };
  }

  async reconcileExpiredAgentCompute() {
    const { reconcileExpiredAgentComputeBatch } = await import("./agent-compute-recovery");
    return reconcileExpiredAgentComputeBatch();
  }

  /**
   * Re-arm stuck `deletion_failed` sandboxes (and orphaned `deletion_pending`
   * rows whose agent_delete job was lost mid-claim) so a delete that failed or
   * was stranded eventually completes.
   *
   * `deletion_failed` is otherwise a dead-end: the agent_delete job exhausted
   * its retries (e.g. the core was down for a deploy), so the row sits forever
   * — visible to ops but never auto-recovered, and any container that survived
   * the failed teardown keeps leaking on its node. This low-frequency sweep
   * finds rows that have been `deletion_failed` longer than `minAgeMs` and
   * enqueues a FRESH agent_delete for each. `enqueueAgentDeleteOnce` is
   * idempotent (it dedups an in-flight delete and re-flips the row to
   * `deletion_pending`), so a node that has since come back will finally drop
   * the container + row. `minAgeMs` keeps this from fighting the live retry
   * loop right after a failure.
   *
   * Circuit-breaker: a permanently-dead node would otherwise be re-armed every
   * sweep forever. Each exhausted agent_delete bumps the sandbox's `error_count`
   * (see the AGENT_DELETE failure handler), so a row that has already been
   * re-enqueued `maxReEnqueues` times is SKIPPED — logged once as
   * `event: "deletion.abandoned_candidate"` for ops to investigate (the
   * container likely needs a manual node-level teardown) rather than looping.
   *
   * Capacity: `deletion_failed`/`deletion_pending` rows do NOT count toward the
   * org's agent ceiling (`QUOTA_COUNTED_STATUSES` in eliza-sandbox.ts), so a
   * stuck delete never blocks the org from creating a replacement. This sweep —
   * together with the orphan-container reconciler, which treats
   * `deletion_failed` as reapable — is what eventually reclaims the container
   * behind that freed slot, so the exclusion cannot compound into unbounded
   * live containers.
   */
  async reEnqueueFailedDeletions(params?: {
    minAgeMs?: number;
    maxAgents?: number;
    maxReEnqueues?: number;
  }): Promise<{
    scanned: number;
    reEnqueued: number;
    failed: number;
    abandoned: number;
  }> {
    const minAgeMs = params?.minAgeMs ?? 30 * 60 * 1000; // 30m
    const maxAgents = params?.maxAgents ?? 50;
    const maxReEnqueues = params?.maxReEnqueues ?? 5;
    const cutoff = new Date(Date.now() - minAgeMs);

    const stuck = await dbWrite
      .select({
        id: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
        userId: agentSandboxes.user_id,
        errorCount: agentSandboxes.error_count,
      })
      .from(agentSandboxes)
      .where(
        and(
          // deletion_failed: the agent_delete job exhausted its retries (e.g. a
          // node was down for a deploy). deletion_pending with NO active
          // agent_delete job: the worker CLAIMED the delete job then died before
          // completing it, so recoverStaleJobs marked the JOB failed with no
          // dependent-row writeback (jobs.ts) — stranding the sandbox in
          // deletion_pending forever. Re-arm both; enqueueAgentDeleteOnce is
          // idempotent and re-flips the row to deletion_pending.
          sql`${agentSandboxes.status} IN ('deletion_failed', 'deletion_pending')`,
          sql`${agentSandboxes.updated_at} < ${cutoff}`,
          // REQUIRED now that deletion_pending is in scope: never re-arm a delete
          // that is legitimately in-flight. (deletion_failed rows never have an
          // active job, so this is a no-op for the original case.)
          sql`NOT EXISTS (
            SELECT 1 FROM ${jobs}
            WHERE  ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND    ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND    ${jobs.type} = ${JOB_TYPES.AGENT_DELETE}
            AND    ${jobs.status} IN ('pending', 'in_progress')
          )`,
        ),
      )
      .limit(maxAgents);

    let reEnqueued = 0;
    let failed = 0;
    let abandoned = 0;
    for (const agent of stuck) {
      // Circuit-breaker: a row that has burned through maxReEnqueues sweeps is a
      // probably-dead node — stop re-arming it and surface it for ops once.
      if ((agent.errorCount ?? 0) >= maxReEnqueues) {
        abandoned += 1;
        logger.warn("[provisioning-jobs] deletion abandoned — exceeded re-enqueue budget", {
          event: "deletion.abandoned_candidate",
          agentId: agent.id,
          orgId: agent.organizationId,
          errorCount: agent.errorCount,
          maxReEnqueues,
        });
        continue;
      }
      try {
        await this.enqueueAgentDeleteOnce({
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: agent.userId,
        });
        reEnqueued += 1;
      } catch (error) {
        failed += 1;
        logger.warn("[provisioning-jobs] re-enqueue of failed deletion failed", {
          agentId: agent.id,
          error: jobErrorText(error),
        });
      }
    }

    if (stuck.length > 0) {
      logger.info("[provisioning-jobs] Re-enqueued stuck deletions", {
        scanned: stuck.length,
        reEnqueued,
        failed,
        abandoned,
      });
    }
    return { scanned: stuck.length, reEnqueued, failed, abandoned };
  }

  private async recoverStaleJobs(
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<ProvisioningRecoverySummary> {
    const summary = emptyRecoverySummary();

    // Recover stale jobs per type across all organizations. The repository now
    // handles org-agnostic recovery, so we can do this in one pass.
    for (const jobType of jobTypes) {
      const result = await jobsRepository.recoverStaleJobs({
        type: jobType,
        staleThresholdMs: COLD_BOOT_JOB_TYPES.has(jobType)
          ? COLD_BOOT_STALE_JOB_THRESHOLD_MS
          : DEFAULT_STALE_JOB_THRESHOLD_MS,
        buildFailureWriteback: this.dependentRowWritebackBuilder(jobType),
      });
      addRecoveryResult(summary, result);
    }

    assertRecoveryHealthy("stale", summary);
    return summary;
  }

  private async fireWebhook(
    job: Job,
    result:
      | AgentProvisionJobResult
      | AgentDeleteJobResult
      | AgentSuspendJobResult
      | AgentResumeJobResult
      | AgentRestartJobResult
      | AgentLogsJobResult
      | AgentSnapshotJobResult
      | AgentUpgradeJobResult,
  ): Promise<void> {
    if (!job.webhook_url) return;

    try {
      const safeWebhookUrl = await assertSafeOutboundUrl(job.webhook_url);

      // Only the waifu receiver gets the signed waifu envelope. Other webhook
      // consumers keep the original unsigned payload shape and never see the
      // shared HMAC signature, so we cannot break or leak anything to a
      // non-waifu callback URL.
      const completedAt = new Date().toISOString();
      const waifuTarget = resolveWaifuWebhookTarget();
      const isWaifuTarget =
        waifuTarget != null && isWaifuWebhookTargetUrl(safeWebhookUrl, waifuTarget);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let rawBody: string;

      if (isWaifuTarget && waifuTarget) {
        // Match the waifu signed-webhook envelope so the receiver accepts the
        // delivery instead of rejecting it as unsigned. Waifu verifies an
        // HMAC-SHA256 over `${timestamp}.${rawBody}` and requires a stable
        // idempotencyKey. Without this the provision-complete callback was
        // silently 401'd by waifu.
        const agentId =
          "cloudAgentId" in result && typeof result.cloudAgentId === "string"
            ? result.cloudAgentId
            : null;
        rawBody = JSON.stringify({
          event: "job.completed",
          timestamp: completedAt,
          agentId,
          idempotencyKey: `job:${job.id}`,
          data: {
            jobId: job.id,
            type: job.type,
            status: "completed",
            result,
            completedAt,
          },
        });
        headers["X-Waifu-Webhook-Signature"] = signWaifuWebhook(
          rawBody,
          completedAt,
          waifuTarget.secret,
        );
      } else {
        // Preserve the original payload shape for non-waifu consumers.
        rawBody = JSON.stringify({
          event: "job.completed",
          jobId: job.id,
          type: job.type,
          status: "completed",
          result,
          completedAt,
        });
      }

      // `safeWebhookUrl` is validated above for the waifu-target comparison;
      // safeFetch re-resolves and pins the connection so the webhook host
      // cannot rebind to a private/mesh address between check and connect.
      const response = await safeFetch(safeWebhookUrl.toString(), {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      const responseOk = response.ok;
      const responseStatus = response.status;
      try {
        await response.body?.cancel();
      } catch (error) {
        // error-policy:J6 The webhook status is already authoritative; response
        // disposal is best-effort teardown of the pinned outbound connection.
        logger.warn("[provisioning-jobs] Failed to release webhook response body", {
          jobId: job.id,
          error: jobErrorText(error),
        });
      }

      await jobsRepository.update(job.id, {
        webhook_status: responseOk ? "delivered" : `failed_${responseStatus}`,
      });

      if (!responseOk) {
        logger.warn("[provisioning-jobs] Webhook delivery failed", {
          jobId: job.id,
          webhookUrl: safeWebhookUrl.toString(),
          status: responseStatus,
        });
      }
    } catch (err) {
      logger.error("[provisioning-jobs] Webhook delivery error", {
        jobId: job.id,
        error: jobErrorText(err),
      });

      await jobsRepository.update(job.id, {
        webhook_status: "error",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatResult {
  total: number;
  succeeded: number;
  failed: number;
}

export interface RecoveryResult {
  /** disconnected always-on agents examined this cycle */
  total: number;
  /** flipped back to `running` because the bridge answered again */
  recovered: number;
  /** still unreachable → a re-provision job was enqueued */
  reprovisioned: number;
  /** recovery threw for this agent */
  failed: number;
}

export interface ProcessingResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  errors: Array<{ jobId: string; error: string }>;
}

/** Find due agent-stop intents whose exact bound worker job is absent or terminal. */
export async function listRecoverableAgentComputeStopIntents(now: Date, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  type RecoveryCursor = { nextAttemptAtText: string; id: string };
  const recoverable: Array<typeof agentComputeStopIntents.$inferSelect> = [];
  const pageSize = Math.max(100, Math.min(limit, 500));
  let cursor: RecoveryCursor | null = null;

  while (recoverable.length < limit) {
    const candidates = await dbWrite
      .select({
        intent: { ...getTableColumns(agentComputeStopIntents) },
        cursorNextAttemptAtText: sql<string>`${agentComputeStopIntents.next_attempt_at}::text`,
        sandbox: {
          userId: agentSandboxes.user_id,
          status: agentSandboxes.status,
          billingStatus: agentSandboxes.billing_status,
          scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
          executionTier: agentSandboxes.execution_tier,
          poolStatus: agentSandboxes.pool_status,
          deletionAttemptId: agentSandboxes.deletion_attempt_id,
          deletedAt: agentSandboxes.deleted_at,
          replacementCleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
        },
        boundJob: {
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          organizationId: jobs.organization_id,
          agentId: jobs.agent_id,
          userId: jobs.user_id,
          dataStorage: jobs.data_storage,
          dataKey: jobs.data_key,
          data: jobs.data,
        },
      })
      .from(agentComputeStopIntents)
      .innerJoin(
        agentSandboxes,
        and(
          eq(agentSandboxes.id, agentComputeStopIntents.agent_id),
          eq(agentSandboxes.organization_id, agentComputeStopIntents.organization_id),
          eq(agentSandboxes.lifecycle_revision, agentComputeStopIntents.lifecycle_revision),
        ),
      )
      .leftJoin(jobs, eq(jobs.id, agentComputeStopIntents.job_id))
      .where(
        and(
          inArray(agentComputeStopIntents.status, ["pending", "retry", "terminal_attention"]),
          lte(agentComputeStopIntents.next_attempt_at, now),
          cursor
            ? sql`(${agentComputeStopIntents.next_attempt_at}, ${agentComputeStopIntents.id}) >
              (${cursor.nextAttemptAtText}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
          eq(agentSandboxes.status, "running"),
          isNull(agentSandboxes.pool_status),
          isNull(agentSandboxes.deletion_attempt_id),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.replacement_cleanup_sandbox_id),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          or(
            eq(agentComputeStopIntents.authorization, "user_request"),
            and(
              eq(agentComputeStopIntents.authorization, "billing_request"),
              eq(agentSandboxes.billing_status, "shutdown_pending"),
              isNotNull(agentSandboxes.scheduled_shutdown_at),
              lte(agentSandboxes.scheduled_shutdown_at, now),
            ),
          ),
          or(
            isNull(agentComputeStopIntents.job_id),
            isNull(jobs.id),
            and(
              eq(jobs.status, "failed"),
              eq(jobs.type, JOB_TYPES.AGENT_SUSPEND),
              eq(jobs.organization_id, agentComputeStopIntents.organization_id),
              eq(jobs.data_storage, "inline"),
              isNull(jobs.data_key),
            ),
          ),
        ),
      )
      .orderBy(agentComputeStopIntents.next_attempt_at, agentComputeStopIntents.id)
      .limit(pageSize);

    if (candidates.length === 0) break;
    for (const { intent, sandbox, boundJob } of candidates) {
      let safelyRearmable = !boundJob?.id;
      if (boundJob?.id) {
        try {
          const data = readAgentSuspendJobData({ id: boundJob.id, data: boundJob.data } as Job);
          safelyRearmable =
            boundJob.type === JOB_TYPES.AGENT_SUSPEND &&
            boundJob.status === "failed" &&
            boundJob.organizationId === intent.organization_id &&
            boundJob.userId === sandbox.userId &&
            data.agentId === intent.agent_id &&
            data.organizationId === intent.organization_id &&
            data.userId === sandbox.userId &&
            (data.lifecycleRevision === undefined ||
              data.lifecycleRevision === intent.lifecycle_revision) &&
            data.authorization !== undefined &&
            !(
              intent.authorization === "billing_request" && data.authorization !== "billing_request"
            );
        } catch {
          // error-policy:J3 untrusted-input sanitizing — malformed persisted jobs
          // are excluded from autonomous recovery instead of being treated as valid.
          safelyRearmable = false;
        }
      }
      if (safelyRearmable) recoverable.push(intent);
      if (recoverable.length >= limit) break;
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < pageSize) break;
    cursor = { nextAttemptAtText: last.cursorNextAttemptAtText, id: last.intent.id };
  }
  return recoverable;
}

/** Rearm one exact failed AGENT_SUSPEND job under the canonical lifecycle lock. */
export async function rearmRecoverableAgentComputeStopIntentOnce(p: {
  intentId: string;
  agentId: string;
  organizationId: string;
  lifecycleRevision: number;
  now: Date;
}): Promise<{ id: string; rearmed: boolean }> {
  return await dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(p.organizationId, p.agentId));
    const [sandbox] = await tx
      .select({
        userId: agentSandboxes.user_id,
        status: agentSandboxes.status,
        billingStatus: agentSandboxes.billing_status,
        scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
        lifecycleRevision: agentSandboxes.lifecycle_revision,
        executionTier: agentSandboxes.execution_tier,
        poolStatus: agentSandboxes.pool_status,
        deletionAttemptId: agentSandboxes.deletion_attempt_id,
        deletedAt: agentSandboxes.deleted_at,
        replacementCleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
      })
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.id, p.agentId), eq(agentSandboxes.organization_id, p.organizationId)),
      )
      .for("update")
      .limit(1);
    if (
      !sandbox ||
      sandbox.userId === null ||
      sandbox.status !== "running" ||
      sandbox.lifecycleRevision !== p.lifecycleRevision ||
      !isContainerBackedExecutionTier(sandbox.executionTier) ||
      sandbox.poolStatus !== null ||
      sandbox.deletionAttemptId !== null ||
      sandbox.deletedAt !== null ||
      sandbox.replacementCleanupSandboxId !== null
    ) {
      throw new Error("Recoverable agent stop intent lost its live lifecycle fence");
    }

    const [intent] = await tx
      .select()
      .from(agentComputeStopIntents)
      .where(
        and(
          eq(agentComputeStopIntents.id, p.intentId),
          eq(agentComputeStopIntents.organization_id, p.organizationId),
          eq(agentComputeStopIntents.agent_id, p.agentId),
          eq(agentComputeStopIntents.lifecycle_revision, p.lifecycleRevision),
          inArray(agentComputeStopIntents.status, ["pending", "retry", "terminal_attention"]),
          lte(agentComputeStopIntents.next_attempt_at, p.now),
        ),
      )
      .for("update")
      .limit(1);
    if (!intent) throw new Error("Agent stop intent is no longer due for recovery");
    if (
      intent.authorization === "billing_request" &&
      (sandbox.billingStatus !== "shutdown_pending" ||
        !sandbox.scheduledShutdownAt ||
        sandbox.scheduledShutdownAt > p.now)
    ) {
      throw new Error("Billing agent stop recovery lost its shutdown authority");
    }

    const [boundJob] = intent.job_id
      ? await tx.select().from(jobs).where(eq(jobs.id, intent.job_id)).for("update").limit(1)
      : [undefined];
    let jobId: string;
    if (boundJob) {
      const data = readAgentSuspendJobData(boundJob);
      if (
        boundJob.status !== "failed" ||
        boundJob.type !== JOB_TYPES.AGENT_SUSPEND ||
        boundJob.organization_id !== p.organizationId ||
        boundJob.user_id !== sandbox.userId ||
        boundJob.data_storage !== "inline" ||
        boundJob.data_key !== null ||
        data.agentId !== p.agentId ||
        data.organizationId !== p.organizationId ||
        data.userId !== sandbox.userId ||
        (data.lifecycleRevision !== undefined && data.lifecycleRevision !== p.lifecycleRevision) ||
        data.authorization === undefined ||
        (intent.authorization === "billing_request" && data.authorization !== "billing_request")
      ) {
        throw new Error("Failed agent stop job does not match its durable intent");
      }
      await tx.delete(jobExecutionLeases).where(eq(jobExecutionLeases.job_id, boundJob.id));
      const [rearmed] = await tx
        .update(jobs)
        .set({
          status: "pending",
          attempts: 0,
          execution_interruptions: 0,
          retryable_requeues: 0,
          estimated_completion_at: new Date(p.now.getTime() + 30_000),
          scheduled_for: p.now,
          started_at: null,
          execution_generation: null,
          execution_quiesced_at: null,
          completed_at: null,
          updated_at: p.now,
        })
        .where(and(eq(jobs.id, boundJob.id), eq(jobs.status, "failed")))
        .returning({ id: jobs.id });
      if (!rearmed) throw new Error("Failed agent stop job lost its rearm fence");
      jobId = rearmed.id;
    } else {
      const [command] = await tx
        .select({ id: billingCancelCommands.id })
        .from(billingCancelCommands)
        .where(
          and(
            eq(billingCancelCommands.organization_id, p.organizationId),
            eq(billingCancelCommands.resource_type, "agent_sandbox"),
            eq(billingCancelCommands.resource_id, p.agentId),
            eq(billingCancelCommands.expected_lifecycle_revision, p.lifecycleRevision),
          ),
        )
        .limit(1);
      if (command) {
        throw new Error("Immutable billing cancellation command lost its agent stop job");
      }
      const [created] = await tx
        .insert(jobs)
        .values(
          await prepareJobInsertData({
            type: JOB_TYPES.AGENT_SUSPEND,
            status: "pending",
            data: {
              agentId: p.agentId,
              organizationId: p.organizationId,
              userId: sandbox.userId,
              authorization: intent.authorization,
              lifecycleRevision: p.lifecycleRevision,
            },
            data_storage: "inline",
            agent_id: p.agentId,
            organization_id: p.organizationId,
            user_id: sandbox.userId,
            max_attempts: 3,
            estimated_completion_at: new Date(p.now.getTime() + 30_000),
            scheduled_for: p.now,
          }),
        )
        .returning({ id: jobs.id });
      if (!created) throw new Error("Agent stop recovery job insert returned no row");
      jobId = created.id;
    }

    await tx
      .update(agentComputeStopIntents)
      .set(
        intent.provider_confirmed_at
          ? { status: "retry", job_id: jobId, next_attempt_at: p.now, updated_at: p.now }
          : {
              status: "pending",
              job_id: jobId,
              attempts: 0,
              last_error: null,
              provider_started_at: null,
              next_attempt_at: p.now,
              updated_at: p.now,
            },
      )
      .where(eq(agentComputeStopIntents.id, intent.id));
    return { id: jobId, rearmed: true };
  });
}

// Singleton
export const provisioningJobService = new ProvisioningJobService();
