/**
 * Defines provisioning job wire values and the canonical lifecycle metadata
 * consumed by enqueue admission, workers, recovery, and daemon lane routing.
 */
export const JOB_TYPES = {
  AGENT_PROVISION: "agent_provision",
  AGENT_DELETE: "agent_delete",
  AGENT_SUSPEND: "agent_suspend",
  /** Deliver an already committed prepaid renewal to its exact Docker instance. */
  AGENT_COMPUTE_LEASE: "agent_compute_lease",
  AGENT_RESUME: "agent_resume",
  AGENT_RESTART: "agent_restart",
  AGENT_LOGS: "agent_logs",
  /**
   * Patron chat turn: forward a `message.send` to a running agent's bridge
   * from the daemon (which, unlike the CF edge worker, can reach the
   * container's raw bridge port). Used by the synchronous patron chat proxy
   * at /api/v1/agents/:id/message: the route enqueues this job, triggers the
   * daemon immediately, then polls the job row for the reply.
   */
  AGENT_MESSAGE: "agent_message",
  AGENT_SNAPSHOT: "agent_snapshot",
  /**
   * Fleet-upgrade: blue/green swap an agent onto the currently-deployed
   * image. Enqueued by the reconciler when the registry digest of the
   * configured tag has moved and the agent is still on the old digest.
   */
  AGENT_UPGRADE: "agent_upgrade",
  /**
   * Super-admin canary image change: exact-target, cross-repository blue/green
   * swap with an immutable digest and durable rollout audit. It is never
   * selected by the fleet reconciler.
   */
  AGENT_ADMIN_CANARY_IMAGE: "agent_admin_canary_image",
  /**
   * Fleet-downgrade / rollback: blue/green swap an agent back onto its
   * persisted `previous_image_digest`, restoring the `pre-upgrade` snapshot
   * before cutover. The inverse of AGENT_UPGRADE — enqueued explicitly (an
   * operator/owner rollback after a bad upgrade), never auto by the reconciler.
   */
  AGENT_DOWNGRADE: "agent_downgrade",
  /**
   * Sleep: durably back the agent's full state up to object storage, then
   * stop AND remove the container so the compute slot is freed (the node
   * autoscaler reclaims a now-empty Hetzner box). Distinct from
   * `agent_suspend`, which keeps the container + node slot for a fast
   * `docker start`. Sleep is cold storage: compute cost goes to zero.
   */
  AGENT_SLEEP: "agent_sleep",
  /**
   * Wake: provision a fresh container (claiming a warm-pool slot when one is
   * available) and restore the agent's state from its latest backup. The
   * inverse of `agent_sleep`.
   */
  AGENT_WAKE: "agent_wake",

  // ── Apps lane (Product 2) ──────────────────────────────────────────────
  // Generic, image-agnostic container lifecycle for user-deployed apps —
  // distinct from the AGENT_* lane above. These rows target the `containers`
  // table (not `agent_sandboxes`), carry NO eliza scaffolding, and NEVER
  // receive the shared agent DATABASE_URL. The daemon picks them up via the
  // same `Object.values(JOB_TYPES)` scan, so registering them here is enough;
  // executors are added separately and never alter the AGENT_* arms.
  /** Provision a generic app container from a caller-supplied image. */
  CONTAINER_PROVISION: "container_provision",
  /** Stop + remove an app container and free its slot. */
  CONTAINER_DELETE: "container_delete",
  /**
   * Stop a container's live runtime when billing is suspended, WITHOUT
   * deleting its row or volume (#8342). The container-billing cron runs on the
   * Worker (no SSH) and can't `docker stop` the node-side container, which runs
   * `--restart unless-stopped` and would otherwise keep running for free after
   * billing stops. The Worker enqueues this; the daemon runs the real stop via
   * HetznerContainersClient (preserving the volume) and frees the node slot.
   */
  CONTAINER_STOP: "container_stop",
  /** Restart an app container in place. */
  CONTAINER_RESTART: "container_restart",
  /** Re-deploy an app container onto a new image. */
  CONTAINER_UPGRADE: "container_upgrade",
  /** Fetch recent logs from an app container. */
  CONTAINER_LOGS: "container_logs",
  /**
   * Run the full app deploy on a node host (Apps / Product 2): the cloud-api
   * Worker enqueues this (pg-free) and the provisioning-worker daemon claims it,
   * runs the node AppDeployRunner (ensure tenant DB -> create container row with
   * the per-tenant DSN -> enqueue CONTAINER_PROVISION -> link), keeping all
   * `pg`/SSH off the workerd request path.
   */
  APP_DEPLOY: "app_deploy",
  /**
   * Tear down an app's ISOLATED per-tenant DB (Apps / Product 2): DROP DATABASE
   * + DROP ROLE and release the cluster slot. The Worker delete path enqueues
   * this (pg-free, carrying the app's encrypted DSN) and the provisioning-worker
   * daemon claims it and runs the real DROP node-side — because `pg` and the
   * cluster admin DSN only exist on the daemon. Without it, a deleted isolated
   * app strands a live DB we keep paying for and burns a finite slot (#8342).
   */
  APP_DB_DEPROVISION: "app_db_deprovision",
  /** Durable post-commit eviction for terminal app provisioning writebacks. */
  APP_CACHE_INVALIDATE: "app_cache_invalidate",
} as const;

export type ProvisioningJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Lifecycle classification consumed by enqueue conflict detection, stale-job
 * recovery, and sandbox reconciliation. Keeping these properties on one row
 * per executor prevents a new lifecycle job from entering one safety set while
 * silently missing another.
 */
interface AgentLifecycleJobMetadata {
  type: ProvisioningJobType;
  exclusive: boolean;
  coldBoot: boolean;
  ownsProvisioningStatus: boolean;
  requiresContainerBackedTarget: boolean;
}

export const AGENT_LIFECYCLE_JOB_METADATA = [
  {
    type: JOB_TYPES.AGENT_COMPUTE_LEASE,
    exclusive: false,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_PROVISION,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: true,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_DELETE,
    exclusive: true,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: false,
  },
  {
    type: JOB_TYPES.AGENT_SUSPEND,
    exclusive: true,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_RESUME,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: true,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_RESTART,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: true,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_LOGS,
    exclusive: false,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_MESSAGE,
    exclusive: false,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: false,
  },
  {
    type: JOB_TYPES.AGENT_SNAPSHOT,
    exclusive: false,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_UPGRADE,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_DOWNGRADE,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_SLEEP,
    exclusive: true,
    coldBoot: false,
    ownsProvisioningStatus: false,
    requiresContainerBackedTarget: true,
  },
  {
    type: JOB_TYPES.AGENT_WAKE,
    exclusive: true,
    coldBoot: true,
    ownsProvisioningStatus: true,
    requiresContainerBackedTarget: true,
  },
] as const satisfies readonly AgentLifecycleJobMetadata[];

// ── Lanes (which daemon claims which jobs) ──────────────────────────────────
// The one `jobs` table + ProvisioningJobService codepath is shared, but the
// rows split into two INDEPENDENT lanes that can be claimed by SEPARATE daemons:
//
//   - `agent` — the AGENT_* sandbox lifecycle (Product 1). Owned by the
//     control-plane provisioning-worker, which ALSO holds the agent-fleet
//     singletons (liveness heartbeat, fleet upgrade, node autoscale, warm pool).
//   - `apps`  — the CONTAINER_* / APP_* lifecycle (Product 2). Provisioning a
//     per-tenant DB needs `pg` reach to the PRIVATE tenant Postgres, and running
//     untrusted user containers wants isolation from the agent control plane.
//     Owned by a dedicated apps-control daemon that lives ON the apps private
//     network (so it can reach the tenant DB) and runs NONE of the agent
//     singletons — so it can never race/duplicate the live fleet.
//
// A daemon scopes itself with `PROVISIONING_JOB_LANES` (comma list). Unset → ALL
// types (the historical single-daemon behavior), so this split is INERT until a
// second daemon is actually deployed and each side is pinned to its lane.
export const AGENT_JOB_TYPES: readonly ProvisioningJobType[] = AGENT_LIFECYCLE_JOB_METADATA.map(
  ({ type }) => type,
);

export const EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES: readonly ProvisioningJobType[] =
  AGENT_LIFECYCLE_JOB_METADATA.filter(({ exclusive }) => exclusive).map(({ type }) => type);

export const COLD_BOOT_JOB_TYPES: ReadonlySet<ProvisioningJobType> = new Set(
  AGENT_LIFECYCLE_JOB_METADATA.filter(({ coldBoot }) => coldBoot).map(({ type }) => type),
);

/**
 * These executors call `provision()` against the primary sandbox row. Image
 * swaps are cold boots too, but they keep that primary row `running` and
 * therefore do not own its `provisioning` status.
 */
export const PROVISIONING_STATUS_OWNER_JOB_TYPES: ReadonlySet<ProvisioningJobType> = new Set(
  AGENT_LIFECYCLE_JOB_METADATA.filter(({ ownsProvisioningStatus }) => ownsProvisioningStatus).map(
    ({ type }) => type,
  ),
);

/**
 * Agent jobs whose target must own a dedicated container. This explicit
 * metadata-derived set deliberately leaves shared-runtime message delivery
 * and logical deletion available without enrolling future job types by
 * default.
 */
export const CONTAINER_BACKED_TARGET_AGENT_JOB_TYPES: ReadonlySet<ProvisioningJobType> = new Set(
  AGENT_LIFECYCLE_JOB_METADATA.filter(({ requiresContainerBackedTarget }) =>
    Boolean(requiresContainerBackedTarget),
  ).map(({ type }) => type),
);

export function requiresContainerBackedTarget(jobType: string): boolean {
  return CONTAINER_BACKED_TARGET_AGENT_JOB_TYPES.has(jobType as ProvisioningJobType);
}

export const DEFAULT_STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000;
export const COLD_BOOT_STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000;
export const STUCK_PROVISIONING_RECONCILIATION_GRACE_MS = 5 * 60 * 1000;
export const STUCK_PROVISIONING_THRESHOLD_MS =
  COLD_BOOT_STALE_JOB_THRESHOLD_MS + STUCK_PROVISIONING_RECONCILIATION_GRACE_MS;
export const ORPHAN_PENDING_THRESHOLD_MS = 10 * 60 * 1000;
export const PROVISIONING_RECONCILIATION_BATCH_SIZE = 100;

export const APPS_JOB_TYPES = [
  JOB_TYPES.CONTAINER_PROVISION,
  JOB_TYPES.CONTAINER_DELETE,
  JOB_TYPES.CONTAINER_STOP,
  JOB_TYPES.CONTAINER_RESTART,
  JOB_TYPES.CONTAINER_UPGRADE,
  JOB_TYPES.CONTAINER_LOGS,
  JOB_TYPES.APP_DEPLOY,
  JOB_TYPES.APP_DB_DEPROVISION,
  JOB_TYPES.APP_CACHE_INVALIDATE,
] as const satisfies readonly ProvisioningJobType[];

export const JOB_LANES = {
  agent: AGENT_JOB_TYPES,
  apps: APPS_JOB_TYPES,
} as const;

export type JobLane = keyof typeof JOB_LANES;

/**
 * Resolve the job types a daemon should claim from a `PROVISIONING_JOB_LANES`
 * spec (comma-separated `agent`/`apps`, case-insensitive).
 *
 * Fail-OPEN to the historical all-types behavior in every ambiguous case:
 *   - empty / undefined  → ALL types (one daemon does both lanes);
 *   - no recognized lane → ALL types (never silently claim nothing).
 * Unknown lane tokens are ignored. The returned list preserves `JOB_TYPES`
 * order so logs/iteration are stable.
 */
export function resolveJobTypesForLanes(spec: string | undefined | null): ProvisioningJobType[] {
  const all = Object.values(JOB_TYPES);
  if (!spec || !spec.trim()) return all;
  const wanted = new Set<ProvisioningJobType>();
  let matchedAnyLane = false;
  for (const raw of spec.split(",")) {
    const lane = raw.trim().toLowerCase();
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so inherited
    // keys that survive `.toLowerCase()` (notably `constructor` and `__proto__`)
    // would pass the gate and then throw on `for (… of JOB_LANES[lane])` because
    // the value is a function/object, not an array — turning a typo'd
    // `PROVISIONING_JOB_LANES` into a daemon-startup crash instead of the
    // documented fail-open. Own-property check keeps the fail-open contract.
    if (Object.hasOwn(JOB_LANES, lane)) {
      matchedAnyLane = true;
      for (const t of JOB_LANES[lane as JobLane]) wanted.add(t);
    }
  }
  if (!matchedAnyLane) return all;
  return all.filter((t) => wanted.has(t));
}
