#!/usr/bin/env -S npx tsx
/**
 * Standalone provisioning worker.
 *
 * The Cloudflare cron route only triggers the Node sidecar because provisioning
 * pulls in Node-only SSH/Docker modules. This daemon runs on that sidecar and
 * delegates to the same ProvisioningJobService used by the API, so enqueue,
 * claim, retry, sandbox status, webhooks, and health checks share one codepath.
 *
 * Usage:
 *   npx tsx packages/cloud/scripts/admin/daemons/provisioning-worker.ts
 *   npx tsx packages/cloud/scripts/admin/daemons/provisioning-worker.ts --once
 */

import { isIP } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabaseUrl } from "@elizaos/cloud-shared/db/database-url";
import type { AppOrphanReconcileResult } from "@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler";
import type { OrphanReconcileResult } from "@elizaos/cloud-shared/lib/services/docker-node-workloads";
import {
  type ProvisioningJobType,
  resolveJobTypesForLanes,
} from "@elizaos/cloud-shared/lib/services/provisioning-job-types";
import type {
  HeartbeatResult,
  ProcessingResult,
  ProvisioningRecoverySummary,
  RecoveryResult,
} from "@elizaos/cloud-shared/lib/services/provisioning-jobs";
import { usesLocalDockerSandboxProvider } from "@elizaos/cloud-shared/lib/services/sandbox-provider";
import { loadLocalEnv } from "./shared/load-env";

type WorkerLogger =
  typeof import("@elizaos/cloud-shared/lib/utils/logger").logger;
type WorkerService =
  typeof import("@elizaos/cloud-shared/lib/services/provisioning-jobs").provisioningJobService;
type WorkerNodeManager =
  typeof import("@elizaos/cloud-shared/lib/services/docker-node-manager").dockerNodeManager;
type WorkerNodeAutoscaler =
  typeof import("@elizaos/cloud-shared/lib/services/containers/node-autoscaler").getNodeAutoscaler;
type WorkerWarmPoolManager =
  typeof import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool").WarmPoolManager;
type WorkerEnvWarmPoolPolicy =
  typeof import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool").envWarmPoolPolicy;
type WorkerImmutableImageReference =
  typeof import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool").immutableImageReference;
type WorkerContainersEnv =
  typeof import("@elizaos/cloud-shared/lib/config/containers-env").containersEnv;
type WorkerAssertSSHKeyAvailable =
  typeof import("@elizaos/cloud-shared/lib/config/containers-env").assertSSHKeyAvailable;
type WorkerWarmPoolCreator =
  typeof import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-creator").getHetznerPoolContainerCreator;
type WorkerResolveImageDigest =
  typeof import("@elizaos/cloud-shared/lib/services/containers/registry-probe").resolveImageDigest;
type WorkerAgentSandboxesRepository =
  typeof import("@elizaos/cloud-shared/db/repositories/agent-sandboxes").agentSandboxesRepository;
type WorkerJobsRepository =
  typeof import("@elizaos/cloud-shared/db/repositories/jobs").jobsRepository;
type WorkerReconcileOrphanContainers =
  typeof import("@elizaos/cloud-shared/lib/services/docker-node-workloads").reconcileOrphanContainersOnNodes;
type WorkerReconcileOrphanAppContainers =
  typeof import("@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler").reconcileOrphanAppContainersOnNodes;
type WorkerWithTimeout =
  typeof import("@elizaos/cloud-shared/lib/utils/with-timeout").withTimeout;
type WorkerProcessNodeDiskCleanup =
  typeof import("@elizaos/cloud-shared/lib/services/node-disk-manager").processNodeDiskCleanup;
type WorkerRunBackupVerificationCycle =
  typeof import("@elizaos/cloud-shared/lib/services/agent-backup-verifier").runBackupVerificationCycle;
type WorkerReadCloudApiDbHeartbeatAt =
  typeof import("@elizaos/cloud-shared/lib/services/cloud-api-db-heartbeat").readCloudApiDbHeartbeatAt;

interface PreflightKmsClient {
  getOrCreateKey(keyId: string): Promise<unknown>;
}

type PreflightCreateKmsClient = (opts: {
  env: NodeJS.ProcessEnv;
}) => PreflightKmsClient;

type PreflightResolveKmsBackend = (opts: {
  env: NodeJS.ProcessEnv;
}) => "memory" | "local" | "steward";

interface WorkerDeps {
  logger: WorkerLogger;
  provisioningJobService: WorkerService;
  dockerNodeManager: WorkerNodeManager;
  getNodeAutoscaler: WorkerNodeAutoscaler;
  WarmPoolManager: WorkerWarmPoolManager;
  envWarmPoolPolicy: WorkerEnvWarmPoolPolicy;
  immutableImageReference: WorkerImmutableImageReference;
  getHetznerPoolContainerCreator: WorkerWarmPoolCreator;
  containersEnv: WorkerContainersEnv;
  assertSSHKeyAvailable: WorkerAssertSSHKeyAvailable;
  resolveImageDigest: WorkerResolveImageDigest;
  agentSandboxesRepository: WorkerAgentSandboxesRepository;
  jobsRepository: WorkerJobsRepository;
  reconcileOrphanContainersOnNodes: WorkerReconcileOrphanContainers;
  reconcileOrphanAppContainersOnNodes: WorkerReconcileOrphanAppContainers;
  withTimeout: WorkerWithTimeout;
  processNodeDiskCleanup: WorkerProcessNodeDiskCleanup;
  runBackupVerificationCycle: WorkerRunBackupVerificationCycle;
  readCloudApiDbHeartbeatAt: WorkerReadCloudApiDbHeartbeatAt;
}

export interface ProvisioningWorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  runOnce: boolean;
  nodeHealthIntervalMs: number;
  /**
   * Job types this daemon claims, from `PROVISIONING_JOB_LANES`. Unset → ALL
   * (the single-daemon default; behavior unchanged). Pin to `agent` once a
   * dedicated apps-control daemon owns the `apps` lane so this control-plane
   * worker stops claiming (and failing) APP_DEPLOY/CONTAINER_* jobs it can't
   * reach the private tenant DB to run.
   */
  jobTypes: readonly ProvisioningJobType[];
  /**
   * When true (default), a watchdog-wedged worker exits with code 1 after
   * `watchdogConsecutiveTicks` consecutive stale heartbeat ticks so systemd
   * `Restart=always` relaunches it. Gated by `PROVISIONING_WORKER_SELF_RESTART`
   * (set to `0`/`false` to disable, e.g. during planned infra maintenance).
   */
  selfRestartEnabled: boolean;
  /**
   * Number of consecutive heartbeat ticks the watchdog must stay tripped before
   * the worker self-restarts. The watchdog trips at WATCHDOG_MAX_CYCLE_MS of no
   * completed cycle, and restart fires on the K-th consecutive tick after, so
   * the time from the last good cycle to exit(1) is
   * ≈ WATCHDOG_MAX_CYCLE_MS + (K-1) * HEARTBEAT_INTERVAL_MS (≈315s at K=2). The
   * extra ticks keep a one-off slow cycle from restart-looping; they are NOT a
   * "~2x window" multiplier.
   */
  watchdogConsecutiveTicks: number;
  /**
   * When true, the low-cadence orphan-container reconcilers sweep HEALTHY nodes
   * for leaked containers with no live DB row (or a terminal-state row) and
   * force-remove them — both the agent sweep (`agent-<id>` vs `agent_sandboxes`)
   * and the apps sweep (`app-<slug>` vs `containers`). Gated OFF by default via
   * `ORPHAN_RECONCILER_ENABLED=1` because they issue `docker rm -f` and should be
   * armed deliberately.
   */
  orphanReconcilerEnabled: boolean;
  /**
   * When true (default), the infra-maintenance sweep re-arms orphaned
   * `deletion_pending` / `deletion_failed` sandboxes via
   * `reEnqueueFailedDeletions` so their teardown actually runs and the node
   * slots they clog are freed within one sweep instead of dwelling until the
   * 6-hourly agent-backups cron. Idempotent, capped DB writes only — no
   * container teardown happens here. Opt-out via `DELETION_RECONCILE_ENABLED`
   * (`0`/`false` disables, e.g. while ops investigates a deletion storm).
   */
  deletionReconcileEnabled: boolean;
  /**
   * DB liveness threshold (#15160): when the newest `jobs` row is older than
   * this many hours, the worker logs a loud error naming the DB host —
   * "this database looks abandoned; check DATABASE_URL points where the API
   * writes". Warn-only, never fatal: an idle env legitimately has old jobs.
   * Tunable via `CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS` (default 24).
   */
  dbLivenessMaxAgeHours: number;
  /**
   * Freshness window (minutes) for the cloud-api DB heartbeat (#16160): the
   * per-minute provisioning-worker-health cron stamps a `provider_health` row
   * on the same database it writes jobs to. A fresh stamp proves this daemon
   * reads the database the API writes, so old jobs mean an idle env — not a
   * split. Tunable via `CONTAINERS_DB_HEARTBEAT_MAX_AGE_MINUTES` (default 15:
   * tolerates cron hiccups while catching a split orders of magnitude faster
   * than the 24h jobs-age threshold).
   */
  dbHeartbeatMaxAgeMinutes: number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 3;

/**
 * Node health-check cadence. 5 minutes matches the `agent-hot-pool`
 * CRON_FANOUT schedule. SSH uses `CONTAINERS_SSH_KEY` from this host.
 */
const DEFAULT_NODE_HEALTH_INTERVAL_MS = 5 * 60_000;

/**
 * Default consecutive-tick threshold for the self-restart watchdog. At K=2 with
 * the 15s heartbeat tick and the 5min watchdog window, the worker restarts
 * ≈ WATCHDOG_MAX_CYCLE_MS + (K-1) * HEARTBEAT_INTERVAL_MS ≈ 315s after the last
 * good cycle (the watchdog window plus one extra 15s tick), not ~2x the window.
 */
const DEFAULT_WATCHDOG_CONSECUTIVE_TICKS = 2;

/**
 * Default DB liveness threshold. 24h is far above any healthy env's
 * inter-job gap (agent creates, upgrades, and heartbeat-driven retries all
 * insert jobs) but small enough to flag an abandoned database within a day
 * instead of the 3 weeks it took to notice #15160.
 */
const DEFAULT_DB_LIVENESS_MAX_AGE_HOURS = 24;
// Mirrors DEFAULT_CLOUD_API_DB_HEARTBEAT_MAX_AGE_MINUTES in
// cloud-shared/lib/services/cloud-api-db-heartbeat (kept local: config parsing
// is synchronous, the shared module is loaded lazily).
const DEFAULT_DB_HEARTBEAT_MAX_AGE_MINUTES = 15;
const workerStartedAt = new Date();

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  label = "integer",
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;
  if (/^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
      throw new Error(
        `${label} must be a canonical positive integer no greater than ${maximum} (received ${JSON.stringify(value)})`,
      );
    }
    return parsed;
  }
  // Preserve the old parser's boundary: anything it could prefix-coerce,
  // including after leading whitespace, must now fail closed. Fully
  // non-numeric "nope"/"soon" values retain their documented fallback.
  if (!Number.isNaN(Number.parseInt(value, 10))) {
    throw new Error(
      `${label} must be a canonical positive integer (received ${JSON.stringify(value)})`,
    );
  }
  return fallback;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

/** Parse an opt-OUT boolean env flag: anything but `0`/`false` keeps the default-on. */
function parseBooleanDefaultTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ProvisioningWorkerConfig {
  return {
    pollIntervalMs: parsePositiveInt(
      env.WORKER_POLL_INTERVAL,
      DEFAULT_POLL_INTERVAL_MS,
      "WORKER_POLL_INTERVAL",
      MAX_POLL_INTERVAL_MS,
    ),
    batchSize: parsePositiveInt(
      env.WORKER_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      "WORKER_BATCH_SIZE",
    ),
    runOnce: env.WORKER_RUN_ONCE === "1" || hasFlag(argv, "--once"),
    nodeHealthIntervalMs: parsePositiveInt(
      env.WORKER_NODE_HEALTH_INTERVAL,
      DEFAULT_NODE_HEALTH_INTERVAL_MS,
      "WORKER_NODE_HEALTH_INTERVAL",
    ),
    jobTypes: resolveJobTypesForLanes(env.PROVISIONING_JOB_LANES),
    selfRestartEnabled: parseBooleanDefaultTrue(
      env.PROVISIONING_WORKER_SELF_RESTART,
    ),
    watchdogConsecutiveTicks: parsePositiveInt(
      env.PROVISIONING_WORKER_WATCHDOG_TICKS,
      DEFAULT_WATCHDOG_CONSECUTIVE_TICKS,
      "PROVISIONING_WORKER_WATCHDOG_TICKS",
    ),
    orphanReconcilerEnabled: env.ORPHAN_RECONCILER_ENABLED === "1",
    deletionReconcileEnabled: parseBooleanDefaultTrue(
      env.DELETION_RECONCILE_ENABLED,
    ),
    dbLivenessMaxAgeHours: parsePositiveInt(
      env.CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS,
      DEFAULT_DB_LIVENESS_MAX_AGE_HOURS,
      "CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS",
    ),
    dbHeartbeatMaxAgeMinutes: parsePositiveInt(
      env.CONTAINERS_DB_HEARTBEAT_MAX_AGE_MINUTES,
      DEFAULT_DB_HEARTBEAT_MAX_AGE_MINUTES,
      "CONTAINERS_DB_HEARTBEAT_MAX_AGE_MINUTES",
    ),
  };
}

let depsPromise: Promise<WorkerDeps> | null = null;

/**
 * Test-only seam: inject a pre-resolved deps bag so cycle functions can be
 * exercised without the real dynamic imports (DB/SSH/Docker). Never called in
 * production. Pass `null` to reset back to lazy real loading.
 */
export function __setDepsForTests(deps: WorkerDeps | null): void {
  depsPromise = deps ? Promise.resolve(deps) : null;
  if (!deps) cachedWarmPoolManagerInstance = null;
}

async function loadDeps(): Promise<WorkerDeps> {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("@elizaos/cloud-shared/lib/services/provisioning-jobs"),
      import("@elizaos/cloud-shared/lib/utils/logger"),
      import("@elizaos/cloud-shared/lib/services/docker-node-manager"),
      import("@elizaos/cloud-shared/lib/services/containers/node-autoscaler"),
      import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool"),
      import(
        "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-creator"
      ),
      import("@elizaos/cloud-shared/lib/config/containers-env"),
      import("@elizaos/cloud-shared/lib/services/containers/registry-probe"),
      import("@elizaos/cloud-shared/db/repositories/agent-sandboxes"),
      import("@elizaos/cloud-shared/db/repositories/jobs"),
      import("@elizaos/cloud-shared/lib/services/docker-node-workloads"),
      import(
        "@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler"
      ),
      import("@elizaos/cloud-shared/lib/utils/with-timeout"),
      import("@elizaos/cloud-shared/lib/services/node-disk-manager"),
      import("@elizaos/cloud-shared/lib/services/agent-backup-verifier"),
      import("@elizaos/cloud-shared/lib/services/cloud-api-db-heartbeat"),
    ]).then(
      ([
        jobsModule,
        loggerModule,
        nodeMgrModule,
        autoscalerModule,
        warmPoolModule,
        warmPoolCreatorModule,
        containersEnvModule,
        registryProbeModule,
        agentSandboxesModule,
        jobsRepoModule,
        nodeWorkloadsModule,
        appOrphanReconcilerModule,
        withTimeoutModule,
        nodeDiskManagerModule,
        backupVerifierModule,
        cloudApiDbHeartbeatModule,
      ]) => ({
        provisioningJobService: jobsModule.provisioningJobService,
        logger: loggerModule.logger,
        dockerNodeManager: nodeMgrModule.dockerNodeManager,
        getNodeAutoscaler: autoscalerModule.getNodeAutoscaler,
        WarmPoolManager: warmPoolModule.WarmPoolManager,
        envWarmPoolPolicy: warmPoolModule.envWarmPoolPolicy,
        immutableImageReference: warmPoolModule.immutableImageReference,
        getHetznerPoolContainerCreator:
          warmPoolCreatorModule.getHetznerPoolContainerCreator,
        containersEnv: containersEnvModule.containersEnv,
        assertSSHKeyAvailable: containersEnvModule.assertSSHKeyAvailable,
        resolveImageDigest: registryProbeModule.resolveImageDigest,
        agentSandboxesRepository: agentSandboxesModule.agentSandboxesRepository,
        jobsRepository: jobsRepoModule.jobsRepository,
        reconcileOrphanContainersOnNodes:
          nodeWorkloadsModule.reconcileOrphanContainersOnNodes,
        reconcileOrphanAppContainersOnNodes:
          appOrphanReconcilerModule.reconcileOrphanAppContainersOnNodes,
        withTimeout: withTimeoutModule.withTimeout,
        processNodeDiskCleanup: nodeDiskManagerModule.processNodeDiskCleanup,
        runBackupVerificationCycle:
          backupVerifierModule.runBackupVerificationCycle,
        readCloudApiDbHeartbeatAt:
          cloudApiDbHeartbeatModule.readCloudApiDbHeartbeatAt,
      }),
    );
  }
  return depsPromise;
}

let cachedWarmPoolManagerInstance: InstanceType<WorkerWarmPoolManager> | null =
  null;
async function getWarmPoolManager(): Promise<
  InstanceType<WorkerWarmPoolManager>
> {
  if (cachedWarmPoolManagerInstance) return cachedWarmPoolManagerInstance;
  const { WarmPoolManager, envWarmPoolPolicy, getHetznerPoolContainerCreator } =
    await loadDeps();
  // envWarmPoolPolicy, not the constructor default: the bare default pins
  // minPoolSize to 1 and leaves WARM_POOL_MIN_SIZE / WARM_POOL_MAX_SIZE inert.
  cachedWarmPoolManagerInstance = new WarmPoolManager(
    getHetznerPoolContainerCreator(),
    envWarmPoolPolicy(),
  );
  return cachedWarmPoolManagerInstance;
}

function resultContext(result: ProcessingResult): Record<string, unknown> {
  return {
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    errors: result.errors,
  };
}

/**
 * Flatten an error's `cause` chain into the logged message. Drizzle wraps
 * query failures in `DrizzleQueryError` with the underlying pg error on
 * `.cause`, so logging only `error.message` yields "Failed query: <SQL>…" and
 * hides the actual failure (e.g. the TLS certificate rejection behind every
 * cycle failure during a DB repoint). Depth-bounded so a pathological
 * self-referencing chain can't loop. Exported for unit testing.
 */
export function formatErrorWithCause(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < 5; depth++) {
    message += `; caused by: ${cause instanceof Error ? cause.message : String(cause)}`;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return message;
}

function normalizeDatabaseHost(rawHostname: string): string {
  let hostname = rawHostname.trim().toLowerCase();
  const zoneIndex = hostname.indexOf("%");
  if (zoneIndex >= 0) hostname = hostname.slice(0, zoneIndex);
  hostname = hostname.replace(/\.$/, "");
  if (!hostname || hostname.startsWith("/") || hostname.startsWith("\\")) {
    return hostname;
  }

  try {
    const urlHost =
      hostname.includes(":") && !hostname.startsWith("[")
        ? `[${hostname}]`
        : hostname;
    hostname = new URL(`http://${urlHost}/`).hostname.toLowerCase();
  } catch {
    // Keep the original value. Invalid remote hosts fail when pg connects;
    // known local forms still fail closed below.
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  return hostname.replace(/\.$/, "");
}

function isLocalDatabaseHost(rawHostname: string): boolean {
  const hostname = normalizeDatabaseHost(rawHostname);
  if (!hostname || hostname.startsWith("/") || hostname.startsWith("\\"))
    return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname) === 4) {
    return hostname === "0.0.0.0" || hostname.startsWith("127.");
  }
  if (isIP(hostname) !== 6) return false;
  if (hostname === "::" || hostname === "::1") return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(hostname);
  if (!mapped) return false;
  const mappedFirstOctet = Number.parseInt(mapped[1] ?? "", 16) >> 8;
  return mappedFirstOctet === 0 || mappedFirstOctet === 127;
}

function effectivePostgresHost(parsed: URL): string {
  const queryHosts = parsed.searchParams.getAll("host");
  const queryHost = queryHosts.at(-1);
  // pg-connection-string applies query fields in order (last one wins), but an
  // exactly empty `host=` falls back to the authority hostname.
  return queryHost !== undefined && queryHost !== ""
    ? queryHost
    : parsed.hostname;
}

/**
 * Refuse to start a deployed provisioning daemon without the same remote
 * PostgreSQL authority used by the API. A missing URL otherwise falls through
 * to local defaults and the daemon can publish a healthy heartbeat while
 * polling an empty queue forever, leaving every dedicated agent pending.
 */
export function assertProvisioningWorkerDatabaseConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === "test" || nodeEnv === "development") return;
  if (env.TEST_DATABASE_URL !== undefined && env.TEST_DATABASE_URL !== "") {
    throw new Error(
      "Provisioning worker TEST_DATABASE_URL is test-only and must be unset outside test/development; refusing a hidden database-authority override.",
    );
  }

  // Use the same resolver as the database client. In deployed environments we
  // additionally require an explicit DATABASE_URL so a local fallback can
  // never become the worker's effective jobs-queue authority.
  const raw = resolveDatabaseUrl(env);
  if (env.DATABASE_URL === undefined || env.DATABASE_URL === "" || !raw) {
    throw new Error(
      "Provisioning worker DATABASE_URL is required outside test/development; refusing to advertise liveness against a local or implicit database.",
    );
  }
  if (raw !== raw.trim()) {
    throw new Error(
      "Provisioning worker DATABASE_URL must not contain leading or trailing whitespace; the startup gate validates the exact URL consumed by the database client.",
    );
  }
  if (/^pglite:\/\//i.test(raw)) {
    throw new Error(
      "Provisioning worker DATABASE_URL must be a remote PostgreSQL URL outside test/development; pglite:// is local-only and cannot own the cloud jobs queue.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "Provisioning worker DATABASE_URL is malformed; expected a postgresql:// or postgres:// URL.",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      "Provisioning worker DATABASE_URL must use postgres:// or postgresql:// outside test/development.",
    );
  }
  const effectiveHost = effectivePostgresHost(parsed);
  if (isLocalDatabaseHost(effectiveHost)) {
    throw new Error(
      "Provisioning worker DATABASE_URL must target a remote PostgreSQL host outside test/development; hostless, loopback, unspecified, and local-socket targets are forbidden.",
    );
  }
}

/**
 * One-shot latch so the active KMS backend is logged once at startup, not on
 * every poll cycle (the preflight re-runs each cycle to gate the hb_signal).
 * Reset only for tests.
 */
let kmsBackendLogged = false;

/** Reset the KMS-backend log latch (tests only). */
export function resetKmsBackendLogForTests(): void {
  kmsBackendLogged = false;
}

/**
 * Log the active KMS backend exactly once (#15310, behavior 1: "log the active
 * KMS backend at startup"). Runtime callers pass the already-loaded worker
 * logger; unit tests that exercise the pure preflight without a logger simply do
 * not consume the one-shot latch.
 */
function logKmsBackendOnce(
  backend: "memory" | "local" | "steward",
  env: NodeJS.ProcessEnv,
  logger?: Pick<WorkerLogger, "info" | "warn">,
): void {
  if (!logger) return;
  if (kmsBackendLogged) return;
  kmsBackendLogged = true;
  const nodeEnv = env.NODE_ENV ?? "<unset>";
  const line = `[provisioning-worker] active KMS backend: ${backend} (NODE_ENV=${nodeEnv})`;
  if (backend === "memory") logger.warn(line);
  else logger.info(line);
}

/**
 * A KMS backend is "durable" if it survives a worker restart. The `memory`
 * backend does NOT: it derives a fresh per-process root key on every start, so
 * every DEK / snapshot / API-key it encrypted is orphaned on the next restart
 * (KeyNotFoundError, then `AEAD decrypt failed` on the old backup). That is the
 * staging root cause behind #15310 — the worker ran `ELIZA_KMS_BACKEND=memory`,
 * so every pre-upgrade snapshot was permanently undecryptable after a bounce.
 *
 * `memory` is legitimate only in NODE_ENV=test/development (each test process is
 * its own throwaway world). Anywhere else — including staging, which the
 * existing `getKmsClient()` guard MISSES because it gates on
 * `isProductionDeployment` (staging is not "production") — a `memory` backend is
 * a latent data-loss bomb. Exported for unit testing; pure so the decision is
 * checkable without booting a KMS client.
 */
export function assertKmsBackendDurable(
  backend: "memory" | "local" | "steward",
  env: NodeJS.ProcessEnv,
): void {
  if (backend !== "memory") return;

  // Ephemeral `memory` is only ever acceptable in test/development, where each
  // process is disposable. NODE_ENV unset (a bare daemon launch) is treated as
  // NOT test/development — refuse, because a real deploy that forgot to set
  // NODE_ENV is exactly the misconfig we are guarding against.
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === "test" || nodeEnv === "development") return;

  throw new Error(
    "memory KMS loses all org DEKs on restart; set ELIZA_KMS_BACKEND=local " +
      "(with a persistent ELIZA_LOCAL_ROOT_KEY) or a durable backend. The " +
      "ephemeral 'memory' backend rotates its root key on every process start, " +
      "so every pre-upgrade snapshot, API key, and BYO secret it encrypts is " +
      "permanently undecryptable after the next worker restart (this stranded " +
      "real users on staging, #15310). It is only valid in " +
      `NODE_ENV=test/development (got NODE_ENV=${nodeEnv ?? "<unset>"}).`,
  );
}

export async function assertProvisioningWorkerPreflight(
  opts: {
    env?: NodeJS.ProcessEnv;
    createKmsClient?: PreflightCreateKmsClient;
    resolveKmsBackend?: PreflightResolveKmsBackend;
    logger?: Pick<WorkerLogger, "info" | "warn">;
  } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  let createKmsClient = opts.createKmsClient;
  let resolveKmsBackend = opts.resolveKmsBackend;
  if (!createKmsClient || !resolveKmsBackend) {
    const kmsModule = await import("@elizaos/core/security/kms");
    createKmsClient ??= kmsModule.createKmsClient;
    resolveKmsBackend ??= (backendOpts) =>
      kmsModule.resolveKmsBackend(backendOpts);
  }
  if (!createKmsClient || !resolveKmsBackend) {
    throw new Error(
      "Provisioning worker preflight dependencies were not initialized",
    );
  }

  // Config preflight (#15310, behavior 1): resolve the active backend, log it
  // once, and REFUSE to start on the ephemeral `memory` backend outside
  // test/development BEFORE we ever touch a key. This runs ahead of the
  // getOrCreateKey probe because `memory` would happily service that probe — it
  // works fine in-process; the failure only manifests on the NEXT restart, by
  // which point the backups are already lost. A loud, actionable, fail-fast is
  // the only prevention.
  const backend = resolveKmsBackend({ env });
  logKmsBackendOnce(backend, env, opts.logger);
  assertKmsBackendDurable(backend, env);

  try {
    const kms = createKmsClient({ env });
    // Use the systemKey() helper so the key id matches the KEY_RE regex in
    // packages/core/src/security/kms/key-namespace.ts (`/v<digit>` suffix required).
    // Bare strings like "system:..." now throw `malformed key id` since the
    // strict namespace regex landed in 0330ba3d64.
    const { systemKey } = await import("@elizaos/core/security/kms");
    await kms.getOrCreateKey(systemKey("provisioning-worker-preflight"));
  } catch (error) {
    const message = formatErrorWithCause(error);
    throw new Error(
      "Provisioning worker preflight failed: KMS is not usable. " +
        "Refusing to publish a healthy heartbeat or claim provisioning jobs. " +
        "Configure ELIZA_KMS_BACKEND=local with a persistent ELIZA_LOCAL_ROOT_KEY, " +
        "or wire a working Steward KMS client. " +
        `Cause: ${message}`,
    );
  }
}

export interface JobsTableLivenessAssessment {
  /** True when the newest jobs row is older than the threshold, or the table is empty. */
  stale: boolean;
  /** Hours since the newest jobs row was created; null when the table is empty. */
  ageHours: number | null;
  maxAgeHours: number;
  latestJobCreatedAt: Date | null;
}

/**
 * Pure threshold decision behind the DB liveness check (#15160). The staging
 * outage happened because this daemon silently polled a database the API had
 * stopped writing to for 3 weeks — zero errors, just an eternally empty
 * queue, while every agent create sat `pending` in ANOTHER database. A jobs
 * table whose newest row is older than the threshold (or that is empty) is
 * treated as stale: probably not the database the API writes to. A
 * created_at in the future (clock skew) is fresh, not stale. Exported for
 * unit testing, mirroring `evaluateSelfRestart`.
 */
export function evaluateJobsTableLiveness(deps: {
  latestJobCreatedAt: Date | null;
  maxAgeHours: number;
  now?: Date;
}): JobsTableLivenessAssessment {
  const { latestJobCreatedAt, maxAgeHours } = deps;
  if (!latestJobCreatedAt) {
    return {
      stale: true,
      ageHours: null,
      maxAgeHours,
      latestJobCreatedAt: null,
    };
  }
  const now = deps.now ?? new Date();
  const ageHours = (now.getTime() - latestJobCreatedAt.getTime()) / 3_600_000;
  return {
    stale: ageHours > maxAgeHours,
    ageHours,
    maxAgeHours,
    latestJobCreatedAt,
  };
}

export type DbLivenessVerdict = "healthy" | "idle" | "split" | "stale-unknown";

export interface DbLivenessAssessment extends JobsTableLivenessAssessment {
  verdict: DbLivenessVerdict;
  heartbeatAt: Date | null;
  heartbeatAgeMinutes: number | null;
  heartbeatMaxAgeMinutes: number;
}

/**
 * Split-vs-idle discrimination (#16160). Jobs-row age alone cannot tell a DB
 * split (#15160: the daemon polls a database the API stopped writing to) from
 * an idle env (correct database, no provisioning traffic) — both present as
 * "the newest jobs row is old". The cloud-api's per-minute cron stamps a DB
 * heartbeat on the database it writes; combining the two separates the cases:
 *
 * - jobs fresh                        → `healthy` (no signal needed)
 * - jobs stale + heartbeat fresh      → `idle` (same DB the API writes: quiet env)
 * - jobs stale + heartbeat stale      → `split` (or the API is down) — warn loudly
 * - jobs stale + heartbeat NEVER seen → `stale-unknown` (pre-rollout / heartbeat
 *   not deployed): fall back to today's loud jobs-age warning so the check
 *   never goes blind during rollout.
 *
 * Pure and exported for unit testing, mirroring `evaluateJobsTableLiveness`.
 * A heartbeat in the future (clock skew) counts as fresh, like jobs rows.
 */
export function evaluateDbLiveness(deps: {
  jobs: JobsTableLivenessAssessment;
  heartbeatAt: Date | null;
  heartbeatMaxAgeMinutes: number;
  now?: Date;
}): DbLivenessAssessment {
  const { jobs, heartbeatAt, heartbeatMaxAgeMinutes } = deps;
  if (!jobs.stale) {
    return {
      ...jobs,
      verdict: "healthy",
      heartbeatAt,
      heartbeatAgeMinutes: null,
      heartbeatMaxAgeMinutes,
    };
  }
  if (!heartbeatAt) {
    return {
      ...jobs,
      verdict: "stale-unknown",
      heartbeatAt: null,
      heartbeatAgeMinutes: null,
      heartbeatMaxAgeMinutes,
    };
  }
  const now = deps.now ?? new Date();
  const heartbeatAgeMinutes = (now.getTime() - heartbeatAt.getTime()) / 60_000;
  return {
    ...jobs,
    verdict: heartbeatAgeMinutes > heartbeatMaxAgeMinutes ? "split" : "idle",
    heartbeatAt,
    heartbeatAgeMinutes,
    heartbeatMaxAgeMinutes,
  };
}

/**
 * Destructive orphan reconciliation is safe only when this daemon can prove
 * it is reading the Cloud API's live database. A split or pre-heartbeat
 * database can make every real container appear rowless; treating that as
 * cleanup authority would delete another environment's healthy workloads.
 */
export function allowsOrphanReconciliation(
  assessment: DbLivenessAssessment | undefined,
): boolean {
  return assessment?.verdict === "healthy" || assessment?.verdict === "idle";
}

/**
 * Host portion of a database URL for log messages — never the credentials.
 * `new URL` drops user:pass with `.host`; pglite:// URLs have no host, so
 * fall back to the pathname (the local data dir). Exported for unit testing.
 */
export function databaseHostForLogs(databaseUrl: string | undefined): string {
  if (!databaseUrl) return "<DATABASE_URL not set>";
  try {
    const parsed = new URL(databaseUrl);
    return parsed.host || parsed.pathname || "<no host in DATABASE_URL>";
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

/** Query side of the DB liveness check: newest jobs row → threshold decision. */
async function processDbLivenessCheckCycle(
  config: ProvisioningWorkerConfig,
): Promise<DbLivenessAssessment> {
  const { jobsRepository } = await loadDeps();
  const latestJobCreatedAt = await jobsRepository.findLatestCreatedAt();
  const jobs = evaluateJobsTableLiveness({
    latestJobCreatedAt,
    maxAgeHours: config.dbLivenessMaxAgeHours,
  });
  // The cloud-api's per-minute heartbeat (#16160). Read defensively: a read
  // failure behaves like an absent row (`stale-unknown` → today's loud
  // fallback), so this extra signal can only improve the verdict, never blind
  // the check.
  let heartbeatAt: Date | null = null;
  try {
    const { readCloudApiDbHeartbeatAt } = await loadDeps();
    heartbeatAt = await readCloudApiDbHeartbeatAt();
  } catch {
    heartbeatAt = null;
  }
  return evaluateDbLiveness({
    jobs,
    heartbeatAt,
    heartbeatMaxAgeMinutes: config.dbHeartbeatMaxAgeMinutes,
  });
}

/**
 * Verdict-aware liveness logging (#16160). WARN LOUDLY — level error, DB host
 * named — only on a REAL problem: `split` (jobs stale AND the cloud-api
 * heartbeat is stale on this database) or `stale-unknown` (no heartbeat ever
 * seen — pre-rollout fallback, behaves like the original check). An `idle`
 * verdict (jobs stale but the heartbeat is fresh ⇒ same DB the API writes,
 * simply no traffic) logs a single info line instead of the former
 * ~288 errors/day false alarm that trained operators to ignore the signal.
 * Re-emitted every infra maintenance sweep so a real split stays unmissable.
 */
function logJobsTableLiveness(
  logger: WorkerLogger,
  assessment: DbLivenessAssessment,
): void {
  if (assessment.verdict === "healthy") return;
  const databaseHost = databaseHostForLogs(process.env.DATABASE_URL);
  const newestRow =
    assessment.ageHours === null
      ? "the table is EMPTY"
      : `the newest row is ${assessment.ageHours.toFixed(1)}h old`;
  const context = {
    event: `worker.db_liveness_${assessment.verdict === "idle" ? "idle" : "stale"}`,
    verdict: assessment.verdict,
    databaseHost,
    latestJobCreatedAt: assessment.latestJobCreatedAt?.toISOString() ?? null,
    ageHours: assessment.ageHours,
    maxAgeHours: assessment.maxAgeHours,
    heartbeatAt: assessment.heartbeatAt?.toISOString() ?? null,
    heartbeatAgeMinutes: assessment.heartbeatAgeMinutes,
    heartbeatMaxAgeMinutes: assessment.heartbeatMaxAgeMinutes,
  };

  if (assessment.verdict === "idle") {
    logger.info(
      `[provisioning-worker] DB liveness: jobs table quiet (${newestRow}) but the ` +
        `cloud-api heartbeat on ${databaseHost} is ` +
        `${assessment.heartbeatAgeMinutes?.toFixed(1)}min fresh — idle env, not a split.`,
      context,
    );
    return;
  }

  const heartbeatDetail =
    assessment.verdict === "split"
      ? `The cloud-api DB heartbeat on this database is ${assessment.heartbeatAgeMinutes?.toFixed(1)}min old ` +
        `(threshold ${assessment.heartbeatMaxAgeMinutes}min, CONTAINERS_DB_HEARTBEAT_MAX_AGE_MINUTES) — ` +
        "the API is not writing here (split) or is down. "
      : "No cloud-api DB heartbeat has ever been written to this database " +
        "(pre-heartbeat deploy, or the wrong database entirely). ";
  logger.error(
    `[provisioning-worker] DB LIVENESS: the jobs table on ${databaseHost} looks abandoned — ` +
      `${newestRow}, threshold ${assessment.maxAgeHours}h (CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS). ` +
      heartbeatDetail +
      "Check that this daemon's DATABASE_URL points at the SAME database the cloud-api " +
      "writes jobs to: a split pair polls an eternally empty queue with zero errors while " +
      "every provision hangs pending forever (#15160).",
    context,
  );
}

async function processProvisioningWorkerCycle(
  batchSize = readWorkerConfig().batchSize,
  jobTypes?: readonly ProvisioningJobType[],
): Promise<ProcessingResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processPendingJobs(batchSize, { jobTypes });
}

async function processWarmClaimCredentialReconcileCycle(
  batchSize = readWorkerConfig().batchSize,
) {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.reconcileWarmClaimCredentialFences(batchSize);
}

async function processReplacementCleanupReconcileCycle(
  batchSize = readWorkerConfig().batchSize,
) {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.reconcileReplacementCleanupFences(batchSize);
}

async function processHeartbeatCycle(
  concurrency = 5,
): Promise<HeartbeatResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processRunningHeartbeats(concurrency);
}

async function processRecoveryCycle(concurrency = 5): Promise<RecoveryResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processDisconnectedRecovery(concurrency);
}

async function processStartupInterruptedJobsRecoveryCycle(
  config: ProvisioningWorkerConfig,
): Promise<ProvisioningRecoverySummary> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.recoverInterruptedJobsOnStartup(
    workerStartedAt,
    config.jobTypes,
  );
}

/**
 * Self-heal rows WEDGED in `provisioning` whose container is actually healthy
 * — the readiness-probe false-negative split-brain (#15310 failure mode #6).
 * The Worker-side cleanup cron can only mark these `error` (no SSH); THIS
 * daemon can re-probe the container node-side and flip it back to `running`.
 */
async function processStuckProvisioningReconcileCycle(): Promise<{
  total: number;
  recovered: number;
  unresolved: number;
  failed: number;
}> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.reconcileStuckProvisioning();
}

interface NodeHealthSummary {
  total: number;
  healthy: number;
  unhealthy: number;
}

interface PrePullImagesSummary {
  attempted: number;
  failed: number;
  configuredImage: string;
  targetDigest: string | null;
}

interface NodeAutoscaleSummary {
  action:
    | "noop"
    | "scale_up"
    | "scale_down"
    | "scale_up_skipped"
    | "scale_up_failed"
    | "drain_failed";
  detail?: string;
}

interface PoolDrainSummary {
  drained: number;
}

interface PoolReplenishSummary {
  created: number;
  failed: number;
  reason: string;
}

interface PoolImageRolloutSummary {
  action: "completed" | "skipped_no_digest";
  configuredImage: string;
  targetDigest: string | null;
  target: number;
  targetReady: number;
  stale: number;
  selected: number;
  reserved: number;
  replaced: number;
  deferred: number;
  failed: number;
}

interface PoolHealthCheckSummary {
  probed: number;
  alive: number;
  removed: number;
}

/**
 * Health-checks every enabled `docker_nodes` row (SSH + `docker info`) and
 * persists the resulting status. Runs on the orchestrator host that already
 * holds `CONTAINERS_SSH_KEY`, so the node-status truth lives next to the
 * provisioner that acts on it.
 */
async function processNodeHealthCheckCycle(): Promise<NodeHealthSummary> {
  const { dockerNodeManager } = await loadDeps();
  const result = await dockerNodeManager.healthCheckAll();
  let healthy = 0;
  let unhealthy = 0;
  for (const status of result.values()) {
    if (status === "healthy") {
      healthy += 1;
    } else {
      unhealthy += 1;
    }
  }
  return { total: result.size, healthy, unhealthy };
}

interface NodeDiskCleanupSummary {
  nodesScanned: number;
  nodesSkipped: number;
  pruned: number;
  pruneFailed: number;
}

/**
 * Prune Docker disk on HEALTHY nodes that crossed the high-water mark. Reclaims
 * with `docker system prune -af` (no `--volumes`) + clears stuck containerd
 * ingest from failed pulls + buildkit prune, with a per-node cooldown so it does
 * not prune every tick. This is the missing self-management that keeps a node
 * from filling up on retried failed image pulls (`no space left on device`) and
 * breaking dedicated-agent provisioning. Runs over the same SSH pool the daemon
 * already authenticates with `CONTAINERS_SSH_KEY`; ON by default (thresholds in
 * `containers-env.ts`).
 */
async function processNodeDiskCleanupCycle(): Promise<NodeDiskCleanupSummary> {
  const { processNodeDiskCleanup } = await loadDeps();
  const report = await processNodeDiskCleanup();
  return {
    nodesScanned: report.nodesScanned,
    nodesSkipped: report.nodesSkipped,
    pruned: report.pruned,
    pruneFailed: report.pruneFailed,
  };
}

/**
 * Verify a bounded sample of stored agent backups is actually RESTORABLE with
 * the current KMS keys (#15603 B5): decrypt the newest backup per agent,
 * replay incremental chains, validate content/manifest hashes, stamp the
 * outcome, and page on failure. Exists because staging ran a memory KMS for
 * weeks and every backup rotted undecryptable until restores failed (#15310) —
 * the startup preflight refuses that config going forward, but only this cycle
 * proves the backups already on disk still decrypt. Read-only against backup
 * storage; batch/interval/escalation are env-tunable in the verifier service
 * (`BACKUP_VERIFICATION_*`, on by default). Exported for the daemon-phase
 * wiring test.
 */
export async function processBackupVerificationCycle(): Promise<
  Awaited<ReturnType<WorkerRunBackupVerificationCycle>>
> {
  const { runBackupVerificationCycle } = await loadDeps();
  return runBackupVerificationCycle();
}

/**
 * Remove expired post-delete recovery snapshots and their offloaded payloads.
 * The repository caps each call at 100 rows and fails before deleting a row
 * when its object bytes cannot be removed, so the next maintenance sweep can
 * retry without losing the cleanup handle.
 */
export async function processPreDeleteBackupCleanupCycle(): Promise<
  Awaited<
    ReturnType<
      WorkerAgentSandboxesRepository["cleanupExpiredPreDeleteRecoveryBackups"]
    >
  >
> {
  const { agentSandboxesRepository } = await loadDeps();
  return agentSandboxesRepository.cleanupExpiredPreDeleteRecoveryBackups();
}

/**
 * Grace period before an orphaned deletion row is re-armed. Long enough that a
 * delete whose job is mid-retry settles first (the sweep's NOT-EXISTS predicate
 * already skips rows with an active agent_delete job; the age cutoff keeps it
 * clear of a just-flipped row), short enough that an orphan dwells minutes —
 * not the hours the 6-hourly agent-backups cron allowed.
 */
const DELETION_RECONCILE_MIN_AGE_MS = 10 * 60_000;

/**
 * Per-sweep cap on re-armed rows. Sized to clear the observed prod backlog
 * (47 of 73 sandboxes orphaned) in a single sweep with headroom; each item is
 * one idempotent enqueue (a cheap DB write), and the phase budget bounds the
 * sweep's wall clock regardless.
 */
const DELETION_RECONCILE_MAX_AGENTS = 200;

type DeletionReconcileSummary = Awaited<
  ReturnType<WorkerService["reEnqueueFailedDeletions"]>
>;

/**
 * Re-arm sandboxes stranded in `deletion_pending` with no draining
 * `agent_delete` job (or dead-ended in `deletion_failed`) so the worker
 * finishes their teardown and frees the node slots they occupy. Warm-pool
 * rotation mints these orphans faster than the 6-hourly agent-backups cron —
 * today's only caller of `reEnqueueFailedDeletions` — clears them, and a node
 * full of them stops hosting new provisions ("Registered Docker nodes exist
 * but none available"). Running the same idempotent, capped service sweep on
 * every infra maintenance cycle bounds orphan dwell to minutes. Returns null
 * without touching the service when `DELETION_RECONCILE_ENABLED` is off.
 * Exported for the daemon-phase wiring test.
 */
export async function processDeletionReconcileCycle(
  config: ProvisioningWorkerConfig,
): Promise<DeletionReconcileSummary | null> {
  if (!config.deletionReconcileEnabled) return null;
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.reEnqueueFailedDeletions({
    minAgeMs: DELETION_RECONCILE_MIN_AGE_MS,
    maxAgents: DELETION_RECONCILE_MAX_AGENTS,
  });
}

/**
 * Reconcile the `allocated_count` column on each `docker_nodes` row against
 * the real number of provisioned sandboxes referencing the node. Previously
 * fired by `agent-hot-pool` cron forwarded to the mystery control-plane
 * host; folded here so the orchestrator owns the truth.
 */
async function processSyncAllocatedCountsCycle(): Promise<number> {
  const { dockerNodeManager } = await loadDeps();
  const changes = await dockerNodeManager.syncAllocatedCounts();
  return changes.size;
}

/**
 * Pre-pull the current agent image on every healthy node with spare
 * capacity. Keeps the warm pool / cold-start path fast. Gated by
 * `ELIZA_AGENT_HOT_POOL_PREPULL` (default on).
 */
async function processPrePullImagesCycle(): Promise<PrePullImagesSummary | null> {
  if (process.env.ELIZA_AGENT_HOT_POOL_PREPULL === "false") return null;
  const {
    dockerNodeManager,
    containersEnv,
    immutableImageReference,
    resolveImageDigest,
  } = await loadDeps();
  const configuredImage = containersEnv.defaultAgentImage();
  const targetDigest = await resolveImageDigest(configuredImage);
  if (!targetDigest) {
    return { attempted: 0, failed: 0, configuredImage, targetDigest: null };
  }
  const image = immutableImageReference(configuredImage, targetDigest);
  const result =
    await dockerNodeManager.prePullAgentImageOnAvailableNodes(image);
  const failed = result.filter((n) => n.status === "failed").length;
  return {
    attempted: result.length,
    failed,
    configuredImage,
    targetDigest,
  };
}

/** A disabled or failed pre-pull must never authorize destructive rollout. */
export function prePullAllowsPoolImageRollout(
  summary: PrePullImagesSummary | null,
): summary is PrePullImagesSummary {
  return (
    summary !== null &&
    summary.attempted > 0 &&
    summary.failed === 0 &&
    summary.targetDigest !== null
  );
}

/**
 * Evaluate capacity and scale Hetzner-cloud autoscaled nodes up or down.
 * Was forwarded to control-plane via `node-autoscale` cron; folded here.
 *
 * Requires `HCLOUD_TOKEN` + `CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY` on the
 * daemon host for scale-up to succeed. Without those, the cycle still
 * runs (decision + drain) but reports `scale_up_skipped`.
 */
async function processNodeAutoscaleCycle(): Promise<NodeAutoscaleSummary> {
  const { getNodeAutoscaler } = await loadDeps();
  const autoscaler = getNodeAutoscaler();
  const decision = await autoscaler.evaluateCapacity();

  if (!decision.shouldScaleUp && decision.shouldScaleDownNodeIds.length === 0) {
    return { action: "noop" };
  }

  if (decision.shouldScaleUp) {
    const publicKey = process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY?.trim();
    if (!publicKey) {
      return {
        action: "scale_up_skipped",
        detail: "CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY not set on daemon host",
      };
    }
    try {
      const provisioned = await autoscaler.provisionNode(
        {},
        {
          controlPlanePublicKey: publicKey,
          registrationUrl: process.env.CONTAINERS_BOOTSTRAP_CALLBACK_URL,
          registrationSecret: process.env.CONTAINERS_BOOTSTRAP_SECRET,
        },
      );
      return {
        action: "scale_up",
        detail: `${provisioned.nodeId} (${provisioned.hostname})`,
      };
    } catch (error) {
      return {
        action: "scale_up_failed",
        detail: formatErrorWithCause(error),
      };
    }
  }

  // Scale down path. Drain only the first candidate per cycle to avoid
  // draining the whole pool on a single cron tick if multiple nodes show
  // up as idle simultaneously.
  const target = decision.shouldScaleDownNodeIds[0];
  if (!target) {
    return { action: "noop" };
  }
  try {
    await autoscaler.drainNode(target, { deprovision: true });
    return { action: "scale_down", detail: target };
  } catch (error) {
    return {
      action: "drain_failed",
      detail: `${target}: ${formatErrorWithCause(error)}`,
    };
  }
}

export interface FleetUpgradeSummary {
  action: "noop" | "skip_no_digest" | "skip_capacity" | "enqueued";
  configuredImage?: string;
  targetDigest?: string | null;
  candidates?: number;
  enqueued?: number;
  inFlight?: number;
  detail?: string;
}

/**
 * Detect when the registry-side digest of the configured agent tag has moved
 * (e.g. a new `:develop` image was pushed) and enqueue blue/green
 * `agent_upgrade` jobs for every running agent still on the old digest.
 *
 * Rate-limited to at most `MAX_INFLIGHT_UPGRADES` (default 3) upgrade jobs in
 * flight at any time so the fleet is never fully disrupted at once. Set the
 * env var to 0 to pause rollouts during an operational canary. The actual swap is
 * zero-downtime (a new container is provisioned on a different node, traffic
 * is atomically swapped, then the old container gets a 30s SIGTERM drain
 * before removal), so the rate limit is about resource pressure on
 * docker_nodes (each in-flight swap holds capacity on two nodes briefly),
 * not user-facing impact.
 *
 * Returns "skip_no_digest" when the registry probe can't resolve a digest —
 * e.g. the operator pinned a non-ghcr image like `eliza-agent:prod-good`, or
 * the registry is unreachable. The reconciler simply waits for the next tick.
 */
export async function processFleetUpgradeCycle(): Promise<FleetUpgradeSummary> {
  const {
    containersEnv,
    resolveImageDigest,
    agentSandboxesRepository,
    jobsRepository,
    provisioningJobService,
  } = await loadDeps();

  const configuredImage = containersEnv.defaultAgentImage();
  const targetDigest = await resolveImageDigest(configuredImage);
  if (!targetDigest) {
    return {
      action: "skip_no_digest",
      configuredImage,
      targetDigest,
      detail: "registry probe returned null",
    };
  }

  const inFlight = await jobsRepository.countInFlightByTypes([
    "agent_upgrade",
    "agent_admin_canary_image",
  ]);
  const slack = containersEnv.maxInflightUpgrades() - inFlight;
  if (slack <= 0) {
    return {
      action: "skip_capacity",
      configuredImage,
      targetDigest,
      inFlight,
    };
  }

  const candidates =
    await agentSandboxesRepository.listRunningWithDigestOtherThan(
      targetDigest,
      configuredImage,
      slack,
    );
  if (candidates.length === 0) {
    return { action: "noop", configuredImage, targetDigest, inFlight };
  }

  const { logger } = await loadDeps();
  let enqueued = 0;
  for (const c of candidates) {
    try {
      const result = await provisioningJobService.enqueueAgentUpgradeOnce({
        agentId: c.id,
        organizationId: c.organization_id,
        userId: c.user_id,
        fromDigest: c.image_digest,
        toDigest: targetDigest,
        dockerImage: configuredImage,
      });
      if (result.created) enqueued += 1;
    } catch (err) {
      logger.warn("[provisioning-worker] fleet-upgrade enqueue failed", {
        agentId: c.id,
        error: formatErrorWithCause(err),
      });
    }
  }

  return {
    action: "enqueued",
    configuredImage,
    targetDigest,
    candidates: candidates.length,
    enqueued,
    inFlight,
  };
}

/**
 * Drain warm-pool sandboxes that have been idle past their TTL. Replaces the
 * `pool-drain-idle` cron path.
 */
async function processPoolDrainIdleCycle(): Promise<PoolDrainSummary> {
  const { containersEnv } = await loadDeps();
  const image = containersEnv.defaultAgentImage();
  const pool = await getWarmPoolManager();
  const result = await pool.drainIdle(image);
  return { drained: result.drained.length };
}

/**
 * Probe ready warm-pool entries and destroy entries whose containers are gone.
 *
 * Ready pool rows use the shared execution tier, so the agent heartbeat sweep
 * skips them, while the unclaimable reconciler deliberately excludes rows that
 * already satisfy the runtime-ready predicate. This phase is therefore the
 * authoritative liveness sweep for ready pool containers. It runs after drain
 * and before replenish so refill decisions use the surviving pool depth, and
 * the manager self-gates on `WARM_POOL_ENABLED`.
 */
export async function processPoolHealthCheckCycle(): Promise<PoolHealthCheckSummary> {
  const pool = await getWarmPoolManager();
  const result = await pool.healthCheck();
  return {
    probed: result.probed,
    alive: result.alive,
    removed: result.removed.length,
  };
}

/**
 * Replace stale warm-pool generations against one immutable registry digest.
 * The manager generation-fences every selected row before remote teardown and
 * burst-bounds remote teardown while retaining the configured physical
 * ready-container floor. Every known-stale row is claim-fenced immediately,
 * so that retained floor is not advertised as current-digest claim capacity.
 */
export async function processPoolImageRolloutCycle(
  resolvedTarget?: Pick<
    PrePullImagesSummary,
    "configuredImage" | "targetDigest"
  >,
): Promise<PoolImageRolloutSummary> {
  const { containersEnv, resolveImageDigest } = await loadDeps();
  const configuredImage =
    resolvedTarget?.configuredImage ?? containersEnv.defaultAgentImage();
  const targetDigest =
    resolvedTarget?.targetDigest ?? (await resolveImageDigest(configuredImage));
  if (!targetDigest) {
    return {
      action: "skipped_no_digest",
      configuredImage,
      targetDigest: null,
      target: 0,
      targetReady: 0,
      stale: 0,
      selected: 0,
      reserved: 0,
      replaced: 0,
      deferred: 0,
      failed: 0,
    };
  }
  const pool = await getWarmPoolManager();
  const result = await pool.rollout(configuredImage, targetDigest);
  const selected = new Set(result.decision.toReplace);
  const deferredIds = new Set([
    ...result.decision.toFence.filter((id) => !selected.has(id)),
    ...result.deferred.map(({ id }) => id),
  ]);
  return {
    action: "completed",
    configuredImage,
    targetDigest,
    target: result.decision.counts.target,
    targetReady: result.decision.counts.targetReady,
    stale: result.decision.counts.stale,
    selected: result.decision.counts.selected,
    reserved: result.reserved.length,
    replaced: result.replaced.length,
    deferred: deferredIds.size,
    failed: result.failed.length,
  };
}

/**
 * Refill the warm pool up to its forecast target. THIS IS THE MISSING CALLER:
 * `WarmPoolManager.replenish()` had no live invocation anywhere in the tree —
 * the only historical caller was the deprecated (undeployed) container-control-
 * plane service, and the `/api/v1/cron/pool-replenish` CF stub only *claimed*
 * the daemon owned it via `cronSupersededByDaemon` while the daemon wired
 * `drainIdle` ONLY. Net effect: the pool got claimed + idle-drained but NEVER
 * refilled, so after depletion every create silently fell through to the
 * 30-120s cold path (Nubs' "warm pool -> provision taking long" report).
 *
 * `replenish` is itself gated by `WARM_POOL_ENABLED` (returns a no-op decision
 * when off) and self-bounds each burst to `WarmPoolPolicy.replenishBurstLimit`
 * (default 3) capped by headroom to `maxPoolSize`, so it cannot stampede. It
 * runs AFTER the node-health / autoscale phases below so it sees fresh node
 * capacity when it decides how many to create.
 */
export async function processPoolReplenishCycle(
  targetDigest?: string,
): Promise<PoolReplenishSummary> {
  const { containersEnv } = await loadDeps();
  const image = containersEnv.defaultAgentImage();
  const pool = await getWarmPoolManager();
  const result = await pool.replenish(image, targetDigest);
  return {
    created: result.created.length,
    failed: result.failed.length,
    reason: result.decision.reason,
  };
}

/**
 * FIX 3: sweep HEALTHY nodes for `agent-<id>` containers with no live DB row
 * (or a terminal-state row) and force-remove them. The reconciler itself only
 * touches nodes whose status is `healthy`, which the preceding node-health
 * check just refreshed, so a transient SSH blip can never reap live containers.
 */
async function processOrphanReconcilerCycle(): Promise<OrphanReconcileResult> {
  const { reconcileOrphanContainersOnNodes } = await loadDeps();
  return reconcileOrphanContainersOnNodes();
}

/**
 * Apps (Product 2) sibling of the agent orphan reconciler: sweep HEALTHY nodes
 * for `app-<slug>` containers with no live `containers` row (or a terminal-state
 * row) and force-remove them. App-container teardown only runs on an explicit
 * app delete, so a mid-deploy crash or partial failure leaks an app container on
 * a node forever; this closes that gap. Same safety model as the agent sweep:
 * it only touches `healthy` nodes (refreshed by the preceding node-health check),
 * skips a node whose listing failed, and reaps by the immutable container id.
 */
async function processAppOrphanReconcilerCycle(): Promise<AppOrphanReconcileResult> {
  const { reconcileOrphanAppContainersOnNodes } = await loadDeps();
  return reconcileOrphanAppContainersOnNodes();
}

let running = true;
let lastInfraMaintenanceAt = 0;

/**
 * Resolver for the in-flight poll sleep, so `requestShutdown` can cut it short
 * and a SIGTERM that lands mid-interval drains immediately instead of waiting
 * out up to `pollIntervalMs` first. Null while no sleep is pending.
 */
let wakePollSleep: (() => void) | null = null;

/**
 * Heartbeat cadence — independent of the work cycle. The liveness key lives
 * 60s in Redis (PROVISIONING_WORKER_HEARTBEAT_TTL_S); publishing every 15s
 * leaves room for 3 missed publishes before the gate trips. Decoupling this
 * from `pollCycle` is THE fix: a slow agent-delete or node health-check can no
 * longer starve the heartbeat and make cloud-api reject every provision.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * If the work cycle stops completing for this long, the worker is wedged
 * (e.g. Redis healthy but Neon/SSH hung). We deliberately STOP publishing the
 * heartbeat so cloud-api fails CLOSED — `checkProvisioningWorkerHealth` sees
 * the stale key and 503s new provisions instead of routing them to a worker
 * that can't make progress — and the loud error log flags it for a human.
 *
 * On top of failing-closed, the worker self-restarts: once the watchdog stays
 * tripped for `watchdogConsecutiveTicks` consecutive heartbeat ticks, it logs
 * loudly and `process.exit(1)`s so systemd `Restart=always` relaunches it. The
 * K-tick gate keeps a slow-but-healthy cycle from restart-looping. Gated by
 * `PROVISIONING_WORKER_SELF_RESTART` (default on) so it can be disabled.
 *
 * Timing (FIX G): the watchdog trips once a cycle has not completed for
 * WATCHDOG_MAX_CYCLE_MS. The self-restart then fires on the K-th consecutive
 * heartbeat tick AFTER it trips, so the wall-clock from the last good cycle to
 * exit(1) is
 *   ≈ WATCHDOG_MAX_CYCLE_MS + (K-1) * HEARTBEAT_INTERVAL_MS
 * For the defaults (300s + (2-1)*15s) that is ≈ 315s — NOT ~600s / "~2x the
 * window". The first wedged tick only arms the counter (no restart); the K-th
 * tick fires it.
 */
const WATCHDOG_MAX_CYCLE_MS = 5 * 60_000;

/**
 * Per-phase wall-clock budget. Each cycle phase (provisioning, node health,
 * autoscale, …) is wrapped in `withTimeout` so a single hung phase — a Neon
 * stall or an unresponsive node's SSH probe — frees fast instead of running
 * unbounded. `withTimeout` only frees the awaiter — every leaf already has its
 * own hard SSH/HTTP/Redis timeout, so a freed phase leaves no truly-unbounded
 * I/O. This is the fast per-phase wedge signal; the cycle-wide budget below is
 * what actually keeps the watchdog invariant from being violated.
 */
const PHASE_TIMEOUT_MS = 60_000;

/**
 * Whole-WORK-cycle wall-clock budget (FIX E). The 4 WORK phases run on the
 * watchdog's critical path, so SUM(their budgets) + the poll interval MUST stay
 * below WATCHDOG_MAX_CYCLE_MS — otherwise a slow-but-progressing cycle could
 * exceed the window and the worker would self-restart (the exact false positive
 * the design claims to prevent: 4 × 90s = 360s > 300s under the old per-phase
 * 90s budgets). Instead of summing N per-phase timeouts, the whole WORK group
 * is bounded ONCE by this budget. Picked comfortably below the watchdog window:
 *   WORK_CYCLE_TIMEOUT_MS + DEFAULT_POLL_INTERVAL_MS = 240s + 30s = 270s < 300s.
 * Adding a 5th WORK phase therefore cannot re-break the invariant — the group
 * budget is fixed. `assertWatchdogInvariant()` pins this at module load and the
 * unit test pins it too (FIX F).
 */
const WORK_CYCLE_TIMEOUT_MS = 4 * 60_000;

/**
 * Longest configurable sleep that still leaves the bounded work cycle inside
 * the watchdog window. The strict one-millisecond margin preserves the
 * invariant's `<`, rather than `<=`, contract.
 */
const MAX_POLL_INTERVAL_MS = WATCHDOG_MAX_CYCLE_MS - WORK_CYCLE_TIMEOUT_MS - 1;

/**
 * The watchdog invariant, surfaced for the unit test (FIX F) so adding a phase
 * or bumping a timeout can't silently violate it. The work cycle is bounded as
 * a GROUP by WORK_CYCLE_TIMEOUT_MS, so that single budget (plus the poll gap)
 * is what must fit inside the watchdog window — not the per-phase budgets.
 */
export const WORKER_TIMING = {
  watchdogMaxCycleMs: WATCHDOG_MAX_CYCLE_MS,
  workCycleTimeoutMs: WORK_CYCLE_TIMEOUT_MS,
  phaseTimeoutMs: PHASE_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  defaultPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
} as const;

/**
 * Guard the watchdog invariant at module load: the WORK cycle's wall-clock
 * budget plus the time the loop sleeps between cycles must finish well before
 * the watchdog declares the worker wedged. A future edit that bumps
 * WORK_CYCLE_TIMEOUT_MS or lowers WATCHDOG_MAX_CYCLE_MS into violation throws
 * loudly at startup instead of shipping a worker that self-restarts mid-cycle.
 */
function assertWatchdogInvariant(): void {
  if (
    WORK_CYCLE_TIMEOUT_MS + DEFAULT_POLL_INTERVAL_MS >=
    WATCHDOG_MAX_CYCLE_MS
  ) {
    throw new Error(
      "[provisioning-worker] watchdog invariant violated: " +
        `WORK_CYCLE_TIMEOUT_MS (${WORK_CYCLE_TIMEOUT_MS}) + DEFAULT_POLL_INTERVAL_MS ` +
        `(${DEFAULT_POLL_INTERVAL_MS}) must be < WATCHDOG_MAX_CYCLE_MS (${WATCHDOG_MAX_CYCLE_MS}). ` +
        "A slow-but-progressing work cycle would otherwise trip the watchdog and self-restart.",
    );
  }
}
assertWatchdogInvariant();

/**
 * Liveness gate. The heartbeat interval publishes ONLY when this is true.
 * Set true immediately after `assertProvisioningWorkerPreflight()` succeeds,
 * false on any throw. Default false so a KMS-dead worker never advertises
 * healthy before the first preflight has run.
 */
let preflightOk = false;

/** Wall-clock of the last `pollCycle` that returned. Drives the watchdog. */
let lastCycleCompletedAt = Date.now();

/** In-flight guard so a hung Redis write can't pile up unresolved publishes. */
let heartbeatPublishInFlight = false;

/**
 * Consecutive heartbeat ticks the watchdog has been tripped. Reset to 0 on any
 * tick where the work cycle is progressing. Drives the self-restart decision.
 */
let consecutiveWatchdogTicks = 0;

/**
 * Pure decision for FIX 1's self-restart: given how many consecutive ticks the
 * watchdog has been tripped, whether the feature is enabled, and the K
 * threshold, decide whether the worker should exit(1) now. Exported for unit
 * testing the K-consecutive-tick trigger without spawning a process.
 */
export function evaluateSelfRestart(deps: {
  watchdogTripped: boolean;
  consecutiveTicks: number;
  selfRestartEnabled: boolean;
  threshold: number;
}): { nextConsecutiveTicks: number; shouldRestart: boolean } {
  if (!deps.watchdogTripped) {
    return { nextConsecutiveTicks: 0, shouldRestart: false };
  }
  const nextConsecutiveTicks = deps.consecutiveTicks + 1;
  const shouldRestart =
    deps.selfRestartEnabled && nextConsecutiveTicks >= deps.threshold;
  return { nextConsecutiveTicks, shouldRestart };
}

/**
 * Poll-loop sleep that `requestShutdown` wakes early on SIGTERM/SIGINT.
 * Exported for unit testing the wake path.
 */
export async function pollSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakePollSleep = null;
      resolve();
    }, ms);
    wakePollSleep = () => {
      clearTimeout(timer);
      wakePollSleep = null;
      resolve();
    };
  });
}

async function publishHeartbeat(logger: WorkerLogger): Promise<void> {
  try {
    const { publishProvisioningWorkerHeartbeat } = await import(
      "@elizaos/cloud-shared/lib/services/provisioning-worker-health"
    );
    await publishProvisioningWorkerHeartbeat();
  } catch (error) {
    logger.warn("[provisioning-worker] heartbeat publish failed", {
      error: formatErrorWithCause(error),
    });
  }
}

/**
 * Decide whether the heartbeat may be published this tick, and publish it.
 * Gated on three independent conditions, all of which must hold:
 *   1. `preflightOk` — KMS is usable (a KMS-dead worker must never advertise
 *      healthy, mirroring the old in-cycle preflight gate).
 *   2. the watchdog has not tripped — the work cycle is still progressing.
 *   3. no publish is already in flight — a slow/hung Redis write must not pile
 *      up unresolved promises.
 * Exported for unit testing the gate logic.
 */
export async function maybePublishHeartbeat(
  logger: WorkerLogger,
  deps: {
    preflightOk: boolean;
    lastCycleCompletedAt: number;
    now?: number;
    publish?: (logger: WorkerLogger) => Promise<void>;
  },
): Promise<{ published: boolean; watchdogTripped: boolean }> {
  const now = deps.now ?? Date.now();
  const publish = deps.publish ?? publishHeartbeat;

  if (now - deps.lastCycleCompletedAt > WATCHDOG_MAX_CYCLE_MS) {
    logger.error(
      "[provisioning-worker] WATCHDOG: work cycle has not completed in over " +
        `${Math.round(WATCHDOG_MAX_CYCLE_MS / 1000)}s — worker appears wedged. ` +
        "Withholding heartbeat so cloud-api fails closed (stops routing provisions here); restart this worker.",
      {
        lastCycleCompletedAt: new Date(deps.lastCycleCompletedAt).toISOString(),
      },
    );
    return { published: false, watchdogTripped: true };
  }

  // KMS-dead worker must never advertise healthy.
  if (!deps.preflightOk) {
    return { published: false, watchdogTripped: false };
  }

  await publish(logger);
  return { published: true, watchdogTripped: false };
}

/**
 * Loudly log and exit so systemd `Restart=always` relaunches the worker. Split
 * out so the side-effecting `process.exit` is in one place and the rest of the
 * tick logic stays pure/testable. Allows injecting `exit` in tests.
 */
function triggerSelfRestart(
  logger: WorkerLogger,
  consecutiveTicks: number,
  exit: (code: number) => never = process.exit,
): never {
  logger.error(
    "[provisioning-worker] WATCHDOG self-restart: work cycle wedged for " +
      `${consecutiveTicks} consecutive heartbeat ticks (>=${Math.round(
        WATCHDOG_MAX_CYCLE_MS / 1000,
      )}s stale). Exiting(1) so systemd relaunches a fresh worker.`,
    {
      event: "worker.self_restart",
      consecutiveWatchdogTicks: consecutiveTicks,
      lastCycleCompletedAt: new Date(lastCycleCompletedAt).toISOString(),
    },
  );
  return exit(1);
}

/**
 * Start the independent heartbeat timer. Decoupled from `pollCycle` so a slow
 * work item can never starve the liveness key. The in-flight guard skips a
 * tick rather than queueing a second publish behind a hung Redis write.
 *
 * Each tick also advances the self-restart watchdog: when the heartbeat is
 * withheld because the work cycle is wedged, the consecutive-tick counter
 * climbs; once it crosses `config.watchdogConsecutiveTicks`, the worker
 * self-restarts (FIX 1).
 */
function startHeartbeatInterval(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): NodeJS.Timeout {
  const tick = () => {
    if (heartbeatPublishInFlight) return;
    heartbeatPublishInFlight = true;
    void maybePublishHeartbeat(logger, {
      preflightOk,
      lastCycleCompletedAt,
    })
      .then(({ watchdogTripped }) => {
        const { nextConsecutiveTicks, shouldRestart } = evaluateSelfRestart({
          watchdogTripped,
          consecutiveTicks: consecutiveWatchdogTicks,
          selfRestartEnabled: config.selfRestartEnabled,
          threshold: config.watchdogConsecutiveTicks,
        });
        consecutiveWatchdogTicks = nextConsecutiveTicks;
        // Don't self-restart (exit 1) while draining: a SIGTERM that flips
        // `running` should exit 0, not be turned into a wedge-restart.
        if (shouldRestart && running) {
          triggerSelfRestart(logger, nextConsecutiveTicks);
        }
      })
      .finally(() => {
        heartbeatPublishInFlight = false;
      });
  };
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Run one cycle phase under a hard wall-clock budget (FIX 2). The phase is
 * wrapped in `withTimeout` (so a hung phase frees the cycle) and its result is
 * handed to `onResult` for logging; any throw — including the timeout — is
 * caught and logged so one phase failing never aborts the rest of the cycle.
 */
async function runBoundedPhase<T>(
  logger: WorkerLogger,
  label: string,
  phase: () => Promise<T>,
  onResult: (result: T) => void,
  timeoutMs: number = PHASE_TIMEOUT_MS,
): Promise<T | undefined> {
  const { withTimeout } = await loadDeps();
  try {
    const result = await withTimeout(
      phase(),
      timeoutMs,
      `[provisioning-worker] ${label}`,
    );
    onResult(result);
    return result;
  } catch (error) {
    logger.error(`[provisioning-worker] ${label} failed`, {
      error: formatErrorWithCause(error),
    });
    return undefined;
  }
}

/**
 * Run the 4 WORK phases (claim/complete jobs, agent heartbeats, recovery, fleet
 * upgrade) as a single group bounded by WORK_CYCLE_TIMEOUT_MS (FIX E). Bounding
 * the group once — rather than summing N per-phase 90s timeouts (4 × 90s = 360s
 * > the 300s watchdog window) — keeps the critical-path budget below
 * WATCHDOG_MAX_CYCLE_MS, so a slow-but-progressing cycle can't self-restart. The
 * group timeout is caught and logged so it frees the cycle without aborting the
 * rest of pollCycle; the per-phase timeouts inside still give a fast,
 * per-phase wedge signal.
 */
async function runWorkCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  const { withTimeout } = await loadDeps();
  const work = (async () => {
    await runBoundedPhase(
      logger,
      "expired Dedicated funding reconcile",
      async () => {
        const { provisioningJobService } = await loadDeps();
        return provisioningJobService.reconcileExpiredAgentCompute();
      },
      (result) => {
        if (result.total > 0) {
          logger.info(
            "[provisioning-worker] expired Dedicated funding reconcile complete",
            result,
          );
        }
      },
    );

    await runBoundedPhase(
      logger,
      "replacement cleanup reconcile",
      () => processReplacementCleanupReconcileCycle(config.batchSize),
      (result) => {
        if (result.total > 0) {
          logger.info(
            "[provisioning-worker] replacement cleanup reconcile complete",
            result,
          );
        }
      },
    );

    await runBoundedPhase(
      logger,
      "warm-claim credential reconcile",
      () => processWarmClaimCredentialReconcileCycle(config.batchSize),
      (result) => {
        if (result.legacyFound > 0 || result.cleanupFound > 0) {
          logger.info(
            "[provisioning-worker] warm-claim credential reconcile complete",
            result,
          );
        }
      },
    );

    await runBoundedPhase(
      logger,
      "cycle",
      () => processProvisioningWorkerCycle(config.batchSize, config.jobTypes),
      (result) => {
        if (result.claimed > 0 || result.failed > 0) {
          logger.info(
            "[provisioning-worker] cycle complete",
            resultContext(result),
          );
        }
      },
    );

    await runBoundedPhase(
      logger,
      "heartbeat cycle",
      () => processHeartbeatCycle(),
      (heartbeats) => {
        if (heartbeats.total > 0) {
          logger.info("[provisioning-worker] heartbeat cycle complete", {
            total: heartbeats.total,
            succeeded: heartbeats.succeeded,
            failed: heartbeats.failed,
          });
        }
      },
    );

    await runBoundedPhase(
      logger,
      "recovery cycle",
      () => processRecoveryCycle(),
      (recovery) => {
        if (recovery.total > 0) {
          logger.info("[provisioning-worker] recovery cycle complete", {
            total: recovery.total,
            recovered: recovery.recovered,
            reprovisioned: recovery.reprovisioned,
            failed: recovery.failed,
          });
        }
      },
    );

    await runBoundedPhase(
      logger,
      "stuck-provisioning reconcile",
      () => processStuckProvisioningReconcileCycle(),
      (reconcile) => {
        if (reconcile.total > 0) {
          logger.info(
            "[provisioning-worker] stuck-provisioning reconcile complete",
            {
              total: reconcile.total,
              recovered: reconcile.recovered,
              unresolved: reconcile.unresolved,
              failed: reconcile.failed,
            },
          );
        }
      },
    );

    await runBoundedPhase(
      logger,
      "fleet upgrade cycle",
      () => processFleetUpgradeCycle(),
      (decision) => {
        if (decision.action !== "noop") {
          logger.info("[provisioning-worker] fleet upgrade cycle complete", {
            action: decision.action,
            configuredImage: decision.configuredImage,
            targetDigest: decision.targetDigest,
            candidates: decision.candidates,
            enqueued: decision.enqueued,
            inFlight: decision.inFlight,
            detail: decision.detail,
          });
        }
      },
    );
  })();

  try {
    await withTimeout(
      work,
      WORK_CYCLE_TIMEOUT_MS,
      "[provisioning-worker] work cycle",
    );
  } catch (error) {
    // A group-level timeout frees the cycle (every leaf is independently
    // bounded) so the watchdog clock advances and infra maintenance still runs.
    logger.error("[provisioning-worker] work cycle exceeded its budget", {
      error: formatErrorWithCause(error),
      workCycleTimeoutMs: WORK_CYCLE_TIMEOUT_MS,
    });
  }
}

async function pollCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  // Re-validate the preflight at the top of every cycle (cheap — a local KMS
  // getOrCreateKey). The heartbeat interval owns liveness now, but it only
  // publishes while `preflightOk` is true, so this is what keeps a KMS-dead
  // worker from advertising healthy. Set true ONLY immediately after success.
  try {
    await assertProvisioningWorkerPreflight({ logger });
    preflightOk = true;
  } catch (error) {
    preflightOk = false;
    logger.error(
      "[provisioning-worker] preflight failed; withholding heartbeat",
      {
        error: formatErrorWithCause(error),
      },
    );
    return;
  }
  // ── WORK phases (on the watchdog's critical path) ────────────────────────
  // The WHOLE group is bounded ONCE by WORK_CYCLE_TIMEOUT_MS (FIX E) so the
  // critical-path budget stays below WATCHDOG_MAX_CYCLE_MS no matter how many
  // phases there are — 4 × per-phase 90s used to sum to 360s and could trip the
  // 300s watchdog on a slow-but-progressing cycle. Each phase keeps its own
  // (now-shorter) per-phase timeout as a fast individual-wedge signal; the group
  // bound is the authoritative one. A group-level timeout frees the cycle and is
  // logged, never aborting the rest of pollCycle (infra maintenance still runs).
  await runWorkCycle(logger, config);

  // Mark progress for the watchdog HERE — after the WORK cycle, BEFORE infra
  // maintenance (FIX 2). Infra maintenance (SSH + Docker probes across the
  // whole fleet) is slow and off the critical liveness path: a node-health or
  // orphan-reconcile sweep that drags on must not make a worker that is still
  // claiming and completing jobs look wedged. As long as the WORK cycle keeps
  // advancing this, the heartbeat interval keeps the worker healthy.
  lastCycleCompletedAt = Date.now();

  // ── Infra maintenance (off the watchdog path) ────────────────────────────
  // Runs on a longer interval than the heartbeat (SSH + Docker probes per node
  // are expensive). Bundles every job that used to be forwarded from CF crons
  // to the now-deprecated control-plane:
  //   - node health check  (was: /api/v1/cron/agent-hot-pool — healthCheckAll)
  //   - alloc reconciliation (was: agent-hot-pool — syncAllocatedCounts)
  //   - pre-pull warm image (was: agent-hot-pool — prePullAgentImageOnAvailableNodes)
  //   - node autoscale     (was: /api/v1/cron/node-autoscale)
  //   - warm pool drain    (was: /api/v1/cron/pool-drain-idle)
  //   - warm pool replenish (was: /api/v1/cron/pool-replenish — the CF stub
  //       claimed the daemon owned it but no phase actually called replenish;
  //       now wired for real below, after node-health so it sees fresh capacity)
  //   - orphan reconcile   (FIX 3, gated by ORPHAN_RECONCILER_ENABLED)
  // Folding them together avoids 3 parallel writers fighting over the same
  // docker_nodes rows and means there's exactly one host that owns the
  // truth: the orchestrator (this daemon). `lastInfraMaintenanceAt`
  // initializes to 0 so the first poll always runs — we want a fresh
  // node-status snapshot at worker startup.
  const now = Date.now();
  if (now - lastInfraMaintenanceAt >= config.nodeHealthIntervalMs) {
    lastInfraMaintenanceAt = now;
    await runInfraMaintenanceCycle(logger, config);
  }
}

/** Exported for the daemon-phase wiring tests; production entry is pollCycle. */
export async function runInfraMaintenanceCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  // Every phase is bounded by PHASE_TIMEOUT_MS via runBoundedPhase so an
  // unresponsive node's SSH probe can never stall the whole sweep.

  // #15160 guard, periodic half: re-assert DB liveness on every infra
  // maintenance sweep (default every 5min ≈ every 10th poll cycle) so a
  // worker polling an abandoned database keeps screaming instead of logging
  // once at boot and going silent. First so a dragging SSH sweep can't
  // starve it. Runs BEFORE the health check touches docker_nodes, so it is
  // a pure read.
  const dbLiveness = await runBoundedPhase(
    logger,
    "db liveness check cycle",
    () => processDbLivenessCheckCycle(config),
    (assessment) => logJobsTableLiveness(logger, assessment),
  );

  await runBoundedPhase(
    logger,
    "node health check cycle",
    () => processNodeHealthCheckCycle(),
    (summary) => {
      logger.info("[provisioning-worker] node health check cycle complete", {
        total: summary.total,
        healthy: summary.healthy,
        unhealthy: summary.unhealthy,
      });
    },
  );

  // Disk retention runs right after the node-health check so it sees fresh node
  // status (only `healthy` nodes are pruned) and BEFORE the image pre-pull, so a
  // node we just reclaimed has room for the next warm-image pull instead of
  // failing it on `no space left on device`. Bounded by PHASE_TIMEOUT_MS like
  // every infra phase.
  await runBoundedPhase(
    logger,
    "node disk cleanup cycle",
    () => processNodeDiskCleanupCycle(),
    (summary) => {
      if (summary.pruned > 0 || summary.pruneFailed > 0) {
        logger.info("[provisioning-worker] node disk cleanup cycle complete", {
          event: "node_disk_cleanup.pruned",
          nodesScanned: summary.nodesScanned,
          nodesSkipped: summary.nodesSkipped,
          pruned: summary.pruned,
          pruneFailed: summary.pruneFailed,
        });
      }
    },
  );

  // Backup restorability verification (#15603 B5). Off the watchdog critical
  // path like every infra phase; self-gated by BACKUP_VERIFICATION_ENABLED and
  // bounded to a small batch per sweep, so the KMS decrypts + object-storage
  // reads it performs cannot starve node maintenance. Failures alert through
  // the same ops channels as the daemon heartbeat monitor.
  await runBoundedPhase(
    logger,
    "backup verification cycle",
    () => processBackupVerificationCycle(),
    (summary) => {
      if (summary.sampled > 0 || summary.errored > 0) {
        logger.info(
          "[provisioning-worker] backup verification cycle complete",
          {
            event: "backup_verification.cycle",
            sampled: summary.sampled,
            verified: summary.verified,
            failed: summary.failed,
            errored: summary.errored,
            oversizeSkipped: summary.oversizeSkipped,
            budgetDeferred: summary.budgetDeferred,
            escalated: summary.escalated,
          },
        );
      }
    },
  );

  await runBoundedPhase(
    logger,
    "pre-delete backup cleanup cycle",
    () => processPreDeleteBackupCleanupCycle(),
    (summary) => {
      if (
        summary.deletedRows > 0 ||
        summary.deletedObjects > 0 ||
        summary.failedRows > 0 ||
        summary.invalidRows > 0
      ) {
        logger.info(
          "[provisioning-worker] pre-delete backup cleanup cycle complete",
          {
            event: "pre_delete_backup_cleanup.cycle",
            deletedRows: summary.deletedRows,
            deletedObjects: summary.deletedObjects,
            failedRows: summary.failedRows,
            invalidRows: summary.invalidRows,
          },
        );
      }
    },
  );

  // Deletion reconciliation: re-arm `deletion_pending`/`deletion_failed`
  // orphans so their teardown drains and the node slots they clog free up
  // within one sweep. DB writes only (idempotent enqueues, capped per sweep) —
  // the actual container teardown runs through the normal agent_delete job
  // path with all its safety checks. Self-gated by DELETION_RECONCILE_ENABLED
  // (default on) inside the phase, which reports null when off.
  await runBoundedPhase(
    logger,
    "deletion reconciliation cycle",
    () => processDeletionReconcileCycle(config),
    (summary) => {
      if (summary && summary.scanned > 0) {
        logger.info(
          "[provisioning-worker] deletion reconciliation cycle complete",
          {
            event: "deletion_reconcile.cycle",
            scanned: summary.scanned,
            reEnqueued: summary.reEnqueued,
            failed: summary.failed,
            abandoned: summary.abandoned,
          },
        );
      }
    },
  );

  await runBoundedPhase(
    logger,
    "alloc reconcile cycle",
    () => processSyncAllocatedCountsCycle(),
    (changes) => {
      if (changes > 0) {
        logger.info("[provisioning-worker] alloc reconcile cycle complete", {
          changed: changes,
        });
      }
    },
  );

  let prePullTarget: PrePullImagesSummary | null = null;
  let warmPoolTargetDigest: string | undefined;
  await runBoundedPhase(
    logger,
    "pre-pull images cycle",
    () => processPrePullImagesCycle(),
    (summary) => {
      prePullTarget = prePullAllowsPoolImageRollout(summary) ? summary : null;
      // Digest resolution is sufficient to pin newly-created capacity even
      // when zero/partial pre-pull means destructive stale rollout must stay
      // closed. Never fall back to a mutable tag once this sweep knows the
      // immutable target.
      warmPoolTargetDigest = summary?.targetDigest ?? undefined;
      if (summary) {
        logger.info("[provisioning-worker] pre-pull images cycle complete", {
          attempted: summary.attempted,
          failed: summary.failed,
        });
      }
    },
  );

  if (prePullTarget) {
    await runBoundedPhase(
      logger,
      "warm pool image rollout cycle",
      () => processPoolImageRolloutCycle(prePullTarget),
      (summary) => {
        logger.info(
          "[provisioning-worker] warm pool image rollout cycle complete",
          {
            event: "warm_pool.image_rollout",
            ...summary,
          },
        );
      },
    );
  }

  await runBoundedPhase(
    logger,
    "node autoscale cycle",
    () => processNodeAutoscaleCycle(),
    (decision) => {
      if (decision.action !== "noop") {
        logger.info("[provisioning-worker] node autoscale cycle complete", {
          action: decision.action,
          detail: decision.detail,
        });
      }
    },
  );

  await runBoundedPhase(
    logger,
    "warm pool drain cycle",
    () => processPoolDrainIdleCycle(),
    (result) => {
      if (result.drained > 0) {
        logger.info("[provisioning-worker] warm pool drain cycle complete", {
          drained: result.drained,
        });
      }
    },
  );

  // Probe ready warm-pool entries and collect the ones whose container is gone.
  // Runs BEFORE replenish so the refill decision sees real depth, and after
  // drain so it does not probe entries the drain just removed.
  await runBoundedPhase(
    logger,
    "warm pool health check cycle",
    () => processPoolHealthCheckCycle(),
    (result) => {
      if (result.removed > 0) {
        logger.info("[provisioning-worker] warm pool health check complete", {
          event: "warm_pool.dead_entries_collected",
          probed: result.probed,
          alive: result.alive,
          removed: result.removed,
        });
      }
    },
  );

  // Refill the warm pool up to its forecast target. Runs AFTER node-health,
  // autoscale, and idle-drain so it decides how many containers to create
  // against fresh node capacity and post-drain pool depth. Error-isolated by
  // runBoundedPhase like every other phase: a replenish failure logs and the
  // rest of the cycle (and the next poll) continues. Self-gated by
  // WARM_POOL_ENABLED (no-op decision when off) and bounded per burst by the
  // policy's replenishBurstLimit, so it cannot stampede.
  await runBoundedPhase(
    logger,
    "warm pool replenish cycle",
    () => processPoolReplenishCycle(warmPoolTargetDigest),
    (result) => {
      if (result.created > 0 || result.failed > 0) {
        logger.info(
          "[provisioning-worker] warm pool replenish cycle complete",
          {
            event: "warm_pool.replenished",
            created: result.created,
            failed: result.failed,
            reason: result.reason,
          },
        );
      }
    },
    // A warm container creation takes ~70s end-to-end (image start + Steward
    // registration + readiness), so the default 60s wedge budget expired every
    // cycle while the entry then completed seconds later (observed live on
    // cp-prod: "cycle timed out after 60000ms" followed by "pool entry
    // ready"). Maintenance phases are off the watchdog-critical WORK group,
    // so a 2-minute budget is invariant-safe and stops the false alarm
    // without unbounding a genuinely wedged replenish.
    2 * 60_000,
  );

  await runOrphanReconciliationCycle(logger, config, dbLiveness);
}

/**
 * Applies the database-authority gate and runs both destructive orphan sweeps.
 * Kept as one callable boundary so every daemon cycle and focused safety test
 * exercises the same decision and paired reconciler ordering.
 */
export async function runOrphanReconciliationCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
  dbLiveness: DbLivenessAssessment | undefined,
): Promise<void> {
  // Runs after node health in the full maintenance cycle. The reconcilers only
  // touch HEALTHY nodes, so a transient SSH failure cannot reap live workloads.
  if (
    config.orphanReconcilerEnabled &&
    allowsOrphanReconciliation(dbLiveness)
  ) {
    await runBoundedPhase(
      logger,
      "orphan reconciler cycle",
      () => processOrphanReconcilerCycle(),
      (result) => {
        logger.info("[provisioning-worker] orphan reconciler cycle complete", {
          event: "orphan_reconciler.reaped",
          nodesScanned: result.nodesScanned,
          nodesSkipped: result.nodesSkipped,
          reaped: result.reaped,
          reapFailed: result.reapFailed,
        });
      },
    );

    // Apps (Product 2) sibling sweep — same `healthy`-only, fresh-node-status,
    // reap-by-id model. Runs right after the agent sweep so it shares the same
    // freshly-refreshed node health and the same `docker rm -f` gating.
    await runBoundedPhase(
      logger,
      "app orphan reconciler cycle",
      () => processAppOrphanReconcilerCycle(),
      (result) => {
        logger.info(
          "[provisioning-worker] app orphan reconciler cycle complete",
          {
            event: "app_orphan_reconciler.reaped",
            nodesScanned: result.nodesScanned,
            nodesSkipped: result.nodesSkipped,
            reaped: result.reaped,
            reapFailed: result.reapFailed,
          },
        );
      },
    );
  } else if (config.orphanReconcilerEnabled) {
    logger.warn(
      "[provisioning-worker] orphan reconciliation skipped: live Cloud API database authority is not proven",
      {
        event: "orphan_reconciler.database_authority_unproven",
        dbLivenessVerdict: dbLiveness?.verdict ?? "check_failed",
      },
    );
  }
}

/**
 * Apps (Product 2): arm the node deploy backend so the daemon runs APP_DEPLOY +
 * CONTAINER_* jobs (provision an isolated per-tenant DB -> run an isolated
 * container with that DSN). Gated OFF by default — only when
 * `APPS_DEPLOY_ENABLED=1`. Additive + safe: when off, the cloud-api deploy
 * trigger is also gated off, so no APP_DEPLOY/CONTAINER_* jobs are ever enqueued,
 * the executor seam is never queried, and Product-1 (agents) is untouched.
 *
 * Defaults to the PREBUILT-image path proven on staging (no `buildExec`): images
 * resolve from `app.metadata.imageTag` / `APP_DEFAULT_IMAGE`. The cluster admin
 * DSN is env-sourced via `APPS_TENANT_ADMIN_DSN` (no `SECRETS_MASTER_KEY`).
 */
async function armAppsDeployBackendIfEnabled(
  logger: WorkerLogger,
): Promise<void> {
  if (process.env.APPS_DEPLOY_ENABLED !== "1") return;
  const { configureAppsDeployBackend } = await import(
    "@elizaos/cloud-shared/lib/services/apps-deploy-backend"
  );
  const port = process.env.APPS_DEPLOY_PORT
    ? Number(process.env.APPS_DEPLOY_PORT)
    : undefined;
  // When APPS_IMAGE_REGISTRY is set, the backend arms BUILD-FROM-REPO (builds the
  // user's repo on the app node via buildx and pushes to this registry — the
  // Vercel-like path). Unset → prebuilt images (imageTag/APP_DEFAULT_IMAGE).
  const registry = process.env.APPS_IMAGE_REGISTRY;
  configureAppsDeployBackend({ port, registry });
  logger.info("[provisioning-worker] apps deploy backend armed", {
    tenantDbAdminDsn: process.env.APPS_TENANT_ADMIN_DSN
      ? "env-sourced"
      : "encrypted",
    images: registry
      ? "build-from-repo"
      : "prebuilt (imageTag/APP_DEFAULT_IMAGE)",
    registry: registry ?? null,
    port: port ?? 3000,
  });
}

async function main(): Promise<void> {
  loadLocalEnv(import.meta.url);
  // Validate the exact DB resolver inputs before importing repositories. That
  // prevents a deployed worker from even constructing a client against a
  // TEST_DATABASE_URL override or local fallback.
  assertProvisioningWorkerDatabaseConfigured();

  const config = readWorkerConfig();
  const { logger, assertSSHKeyAvailable } = await loadDeps();

  logger.info("[provisioning-worker] starting", {
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    runOnce: config.runOnce,
    nodeHealthIntervalMs: config.nodeHealthIntervalMs,
    // Surface the claim scope: empty PROVISIONING_JOB_LANES → every registered type.
    // When a dedicated apps daemon ships, pin this one to `agent`.
    jobLanes: process.env.PROVISIONING_JOB_LANES || "(all)",
    jobTypeCount: config.jobTypes.length,
    selfRestartEnabled: config.selfRestartEnabled,
    watchdogConsecutiveTicks: config.watchdogConsecutiveTicks,
    orphanReconcilerEnabled: config.orphanReconcilerEnabled,
    dbLivenessMaxAgeHours: config.dbLivenessMaxAgeHours,
  });

  await assertProvisioningWorkerPreflight({ logger });

  // Fail-fast on a missing SSH key BEFORE the first heartbeat for remote-node
  // providers. Local Docker never uses SSH, so requiring a key there would keep
  // its real provisioning queue permanently pending.
  // otherwise lazy (first node SSH, ~30s in), so a misconfigured key would let
  // the worker publish a healthy heartbeat while silently failing every node
  // SSH forever. Crash loudly instead; systemd `Restart=always` relaunches it
  // and the misconfig is visible.
  if (!usesLocalDockerSandboxProvider()) {
    try {
      assertSSHKeyAvailable();
    } catch (error) {
      logger.error(
        `[provisioning-worker] CRITICAL: ${formatErrorWithCause(error)}`,
      );
      throw error;
    }
  }

  preflightOk = true;
  logger.info("[provisioning-worker] startup preflight passed");

  // #15160 guard, startup half: right after the preflight, check that the
  // jobs table this DATABASE_URL points at has been written to recently.
  // The KMS/SSH preflights above prove THIS worker can run jobs; this one
  // flags the failure mode where there are simply never any jobs to run
  // because the API writes to a different database. Bounded + caught by
  // runBoundedPhase: a slow or unreachable DB logs an error here and the
  // work cycles surface it properly — startup must not crash on it.
  await runBoundedPhase(
    logger,
    "db liveness preflight",
    () => processDbLivenessCheckCycle(config),
    (assessment) => logJobsTableLiveness(logger, assessment),
  );

  // A systemd restart kills the previous singleton daemon, but any job it had
  // already claimed remains `in_progress` until stale recovery sees the full
  // cold-boot threshold. Recover only rows claimed before THIS process existed:
  // normal in-cycle stale recovery keeps protecting legitimate slow cold boots,
  // while deploy restarts immediately expose interrupted provisions to retry.
  await runBoundedPhase(
    logger,
    "startup interrupted-job recovery",
    () => processStartupInterruptedJobsRecoveryCycle(config),
    (recovery) => {
      if (recovery.retried > 0 || recovery.permanentlyFailed > 0) {
        logger.info(
          "[provisioning-worker] startup interrupted-job recovery complete",
          {
            retried: recovery.retried,
            permanentlyFailed: recovery.permanentlyFailed,
            startedBefore: workerStartedAt.toISOString(),
          },
        );
      }
    },
  );

  // Apps (Product 2): arm the deploy backend when enabled (gated; no-op by default).
  await armAppsDeployBackendIfEnabled(logger);

  // Seed the watchdog clock so a slow first cycle can't trip it immediately.
  lastCycleCompletedAt = Date.now();

  if (config.runOnce) {
    // Publish once so a --once invocation still reports liveness, then run a
    // single cycle. No interval needed for the one-shot path.
    await publishHeartbeat(logger);
    await pollCycle(logger, config);
    await closeOpenHandles(logger);
    return;
  }

  // Decouple liveness from the work cycle: an independent timer publishes the
  // heartbeat every HEARTBEAT_INTERVAL_MS regardless of how long a single
  // cycle takes. Publish once immediately so there's no cold gap before the
  // first tick.
  await publishHeartbeat(logger);
  const heartbeatTimer = startHeartbeatInterval(logger, config);

  try {
    while (running) {
      await pollCycle(logger, config);
      if (running) {
        await pollSleep(config.pollIntervalMs);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
  }

  await closeOpenHandles(logger);
  logger.info("[provisioning-worker] stopped");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

/**
 * Close the long-lived handles the daemon owns before exiting: the static
 * docker-ssh connection pool and the process-level pg pools. Best-effort — a
 * failed close is logged and never blocks the exit (the force-exit timer in
 * `requestShutdown` backstops a wedged teardown). Closers are injectable for
 * unit tests, mirroring `maybePublishHeartbeat`.
 */
export async function closeOpenHandles(
  logger: WorkerLogger,
  close: {
    sshPool?: () => Promise<void>;
    dbPools?: () => Promise<void>;
  } = {},
): Promise<void> {
  const closers: [string, () => Promise<void>][] = [
    [
      "ssh pool",
      close.sshPool ??
        (async () => {
          const { DockerSSHClient } = await import(
            "@elizaos/cloud-shared/lib/services/docker-ssh"
          );
          await DockerSSHClient.disconnectAll();
        }),
    ],
    [
      "db pools",
      close.dbPools ??
        (async () => {
          // Despite the suffix, this is THE process-level pool closer
          // (`connectionManager.closeAll()` → `pool.end()` per cached pool).
          const { closeDatabaseConnectionsForTests } = await import(
            "@elizaos/cloud-shared/db/client"
          );
          await closeDatabaseConnectionsForTests();
        }),
    ],
  ];
  const results = await Promise.allSettled(closers.map(([, fn]) => fn()));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      logger.warn("[provisioning-worker] shutdown cleanup failed", {
        handle: closers[i][0],
        error: formatErrorWithCause(result.reason),
      });
    }
  });
}

/**
 * Bounded shutdown grace. SIGTERM flips `running` and lets the in-flight cycle
 * drain, but a cycle can legitimately run for minutes (WORK_CYCLE_TIMEOUT_MS is
 * 240s) while systemd escalates stop-sigterm to SIGKILL at 90s. Force-exiting
 * ourselves at 60s keeps every stop/restart under systemd's window; the timer
 * is unref'd so it never keeps a clean drain alive.
 */
const SHUTDOWN_FORCE_EXIT_MS = 60_000;

/**
 * SIGTERM/SIGINT path: stop the loop, cut the poll sleep short, and arm the
 * force-exit backstop. The clean path is `main()` resolving — drain the
 * in-flight cycle, close handles, `process.exit(0)` at the entrypoint.
 * `exit` is injectable for unit tests, mirroring `triggerSelfRestart`.
 */
export function requestShutdown(
  signal: NodeJS.Signals,
  exit: (code: number) => never = process.exit,
): void {
  process.stderr.write(`[provisioning-worker] ${signal} received; draining\n`);
  running = false;
  wakePollSleep?.();
  const timer = setTimeout(() => {
    process.stderr.write(
      `[provisioning-worker] drain exceeded ${SHUTDOWN_FORCE_EXIT_MS}ms after ${signal}; forcing exit\n`,
    );
    exit(0);
  }, SHUTDOWN_FORCE_EXIT_MS);
  timer.unref();
}

if (isMainModule()) {
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    void loadDeps().then(({ logger }) => {
      logger.error("[provisioning-worker] unhandled rejection", {
        error: formatErrorWithCause(reason),
      });
    });
  });

  main().then(
    () => {
      // Exit explicitly: the dependency graph holds live handles the daemon
      // can't enumerate (a fresh Redis socket per heartbeat publish, module-
      // level intervals in shared libs), so the event loop never drains on its
      // own — systemd was escalating every stop to SIGKILL after 90s.
      process.exit(0);
    },
    (error) => {
      process.stderr.write(
        `[provisioning-worker] fatal: ${formatErrorWithCause(error)}\n`,
      );
      // Same open-handles reasoning as the clean path: `process.exitCode = 1`
      // alone leaves a dead worker hanging instead of letting Restart=always
      // relaunch it.
      process.exit(1);
    },
  );
}
