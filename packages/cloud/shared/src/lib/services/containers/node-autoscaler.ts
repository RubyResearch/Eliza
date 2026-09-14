/**
 * Node autoscaler.
 *
 * Decides when to scale the Hetzner-Docker pool up or down. Scope is
 * deliberately narrow: this module owns capacity evaluation and the
 * `provisionNode` / `drainNode` workflows. Concrete API + cron handlers
 * call these methods.
 *
 * Safety properties:
 *  - Stateful workloads with `volume_path` set are NEVER auto-evicted.
 *    Scale-down only deprovisions nodes that have zero containers (any
 *    status) pinned to them.
 *  - Provisioning is rate-limited per-call: each invocation provisions
 *    at most one node. The cron runs frequently enough that bursty
 *    demand still scales up within a couple of minutes.
 *  - Cooldown windows on both directions stop us oscillating between
 *    provision and drain.
 */

import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { containersEnv } from "../../config/containers-env";
import { logger } from "../../utils/logger";
import {
  countAllocatedWorkloadsOnNode,
  countRetainedWorkloadsOnNode,
} from "../docker-node-workloads";
import {
  inferArchitectureFromHetznerServerType,
  inferNodeArchitectureFromMetadata,
  isArchitectureCompatibleWithPlatform,
} from "../docker-sandbox-utils";
import {
  type ComputeProvider,
  type ComputeServer,
  getComputeProvider,
  isComputeConfigured,
} from "./compute-provider";
import { HetznerCloudError, isHetznerCloudConfigured } from "./hetzner-cloud-api";
import {
  assertAuthoritativeHetznerServer,
  attestHetznerCloudNode,
  type HetznerServerAuthority,
  isTypedHetznerCloudNode,
  requireSafeHetznerServerId,
} from "./hetzner-node-attestation";
import { buildContainerNodeUserData, type NodeBootstrapInput } from "./node-bootstrap";
import { withNodeProvisionAuthority } from "./node-provision-authority";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoscalePolicy {
  /** Free slots that must remain across the pool before we provision a new node. */
  minFreeSlotsBuffer: number;
  /** Emergency floor for hot agent starts; bypasses cooldown if availability drops below it. */
  minHotAvailableSlots: number;
  /** Hard cap on enabled nodes; never provision past this number. */
  maxNodes: number;
  /** Cooldown after the most recent provision before another one is allowed. */
  scaleUpCooldownMs: number;
  /** Minimum age of an idle node before it becomes eligible for drain. */
  idleNodeMinAgeMs: number;
  /** Server type purchased for new bursts (e.g. "cax21" arm64, "cpx31" x86). */
  defaultServerType: string;
  /** Datacenter for new bursts (e.g. "fsn1", "nbg1"). */
  defaultLocation: string;
  /** Image used for the OS install (cloud-init compatible). */
  defaultImage: string;
  /** Policy fallback retained in provisional metadata until hardware attests. */
  defaultCapacity: number;
}

export const DEFAULT_AUTOSCALE_POLICY: AutoscalePolicy = {
  minFreeSlotsBuffer: containersEnv.autoscaleMinFreeSlotsBuffer(),
  minHotAvailableSlots: containersEnv.autoscaleMinHotAvailableSlots(),
  // Launch capacity bump 12 → 14 (#18052): the launch chain enables the warm
  // pool, whose standing replenishment consumes slots the old ceiling had
  // reserved for on-demand provisioning headroom.
  maxNodes: 14,
  scaleUpCooldownMs: 5 * 60 * 1000,
  idleNodeMinAgeMs: 30 * 60 * 1000,
  defaultServerType: containersEnv.defaultHcloudServerType(),
  defaultLocation: containersEnv.defaultHcloudLocation(),
  defaultImage: "ubuntu-24.04",
  defaultCapacity: containersEnv.defaultAutoscaleNodeCapacity(),
};

const HCLOUD_FIREWALL_SETTLEMENT_ATTEMPTS = 5;
const HCLOUD_FIREWALL_SETTLEMENT_DELAY_MS = 1_000;

export interface CapacityDecision {
  totalCapacity: number;
  totalAllocated: number;
  totalAvailable: number;
  enabledNodeCount: number;
  healthyNodeCount: number;
  shouldScaleUp: boolean;
  shouldScaleDownNodeIds: string[];
  reason: string;
}

export interface ProvisionRequest {
  /** Logical id assigned to the new node (defaults to a generated value). */
  nodeId?: string;
  serverType?: string;
  location?: string;
  image?: string;
  capacity?: number;
  /** Override prepull set; defaults to the configured default agent image. */
  prePullImages?: string[];
  /** Free-form labels attached to the Hetzner server (for bookkeeping). */
  labels?: Record<string, string>;
}

export interface ProvisionResult {
  nodeId: string;
  hostname: string;
  hcloudServerId: number;
  rootPassword: string | null;
  /** True when a retry recovered an existing provider/DB node. */
  idempotent: boolean;
}

export interface DrainOptions {
  /**
   * If true, deprovision the underlying Hetzner Cloud server after the
   * node is fully empty. Otherwise the node is just marked disabled.
   */
  deprovision?: boolean;
}

// ---------------------------------------------------------------------------
// NodeAutoscaler
// ---------------------------------------------------------------------------

export class NodeAutoscaler {
  constructor(
    private readonly policy: AutoscalePolicy = DEFAULT_AUTOSCALE_POLICY,
    private readonly nowFn: () => number = () => Date.now(),
    // Compute provider seam: defaults (lazily, per-call) to `getComputeProvider()`
    // — which resolves to the Hetzner client in production, so behavior is
    // unchanged. Injecting `InMemoryComputeProvider` here lets tests drive the
    // provision/drain path without monkey-patching the module. #8919
    private readonly provider?: ComputeProvider,
    private readonly settlementSleep: (delayMs: number) => Promise<void> = (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)),
  ) {}

  /** The compute provider for this run — injected fake, or the configured default. */
  private computeProvider(): ComputeProvider {
    return this.provider ?? getComputeProvider();
  }

  /**
   * Inspect current pool state and return a decision: should we scale up,
   * should we drain anyone, or are we steady? Pure read; no side effects.
   */
  async evaluateCapacity(): Promise<CapacityDecision> {
    const nodes = await dockerNodesRepository.findAll();
    const enabled = nodes.filter((n) => n.enabled);
    const requiredPlatform = containersEnv.defaultAgentImagePlatform();
    const healthyCandidates = enabled.filter(
      (n) =>
        n.status === "healthy" &&
        n.metadata.capacityProvisional !== true &&
        isArchitectureCompatibleWithPlatform(
          inferNodeArchitectureFromMetadata(n.metadata),
          requiredPlatform,
        ),
    );
    let provider: ComputeProvider | undefined;
    const healthyEnabled: DockerNode[] = [];
    for (const node of healthyCandidates) {
      if (isTypedHetznerCloudNode(node)) {
        provider ??= this.computeProvider();
        await attestHetznerCloudNode(node, provider);
      }
      healthyEnabled.push(node);
    }
    const allocatedByNode = new Map(
      await Promise.all(
        healthyEnabled.map(
          async (node) =>
            [node.node_id, await countAllocatedWorkloadsOnNode(node.node_id)] as const,
        ),
      ),
    );

    const totalCapacity = healthyEnabled.reduce((sum, n) => sum + n.capacity, 0);
    const totalAllocated = healthyEnabled.reduce(
      (sum, n) => sum + (allocatedByNode.get(n.node_id) ?? n.allocated_count),
      0,
    );
    const totalAvailable = healthyEnabled.reduce(
      (sum, n) =>
        sum + Math.max(0, n.capacity - (allocatedByNode.get(n.node_id) ?? n.allocated_count)),
      0,
    );

    const recentlyProvisioned = enabled.some(
      (n) => this.nowFn() - n.created_at.getTime() < this.policy.scaleUpCooldownMs,
    );

    const belowHotFloor = totalAvailable < this.policy.minHotAvailableSlots;
    const belowBuffer = totalAvailable < this.policy.minFreeSlotsBuffer;
    const shouldScaleUp =
      enabled.length < this.policy.maxNodes &&
      belowBuffer &&
      (!recentlyProvisioned || belowHotFloor);

    const drainCandidates =
      shouldScaleUp || belowBuffer
        ? []
        : await this.findDrainCandidates(healthyEnabled, allocatedByNode, totalAvailable);

    let reason = "steady";
    if (shouldScaleUp) {
      reason = belowHotFloor
        ? `available ${totalAvailable} < hot floor ${this.policy.minHotAvailableSlots}`
        : `available ${totalAvailable} < buffer ${this.policy.minFreeSlotsBuffer} (cooldown ok)`;
    } else if (drainCandidates.length > 0) {
      reason = `${drainCandidates.length} idle node(s) eligible for drain`;
    } else if (recentlyProvisioned && belowBuffer) {
      reason = "would scale up but cooldown active";
    }

    return {
      totalCapacity,
      totalAllocated,
      totalAvailable,
      enabledNodeCount: enabled.length,
      healthyNodeCount: healthyEnabled.length,
      shouldScaleUp,
      shouldScaleDownNodeIds: drainCandidates.map((n) => n.node_id),
      reason,
    };
  }

  /**
   * Provision a new Hetzner Cloud server, run the cloud-init bootstrap,
   * and insert a docker_nodes row in `unknown` status. The node still
   * needs to come online — health checks flip it to `healthy`.
   *
   * Throws if HCLOUD_TOKEN is not configured.
   */
  async provisionNode(
    request: ProvisionRequest,
    bootstrap: Pick<
      NodeBootstrapInput,
      "controlPlanePublicKey" | "registrationUrl" | "registrationSecret"
    >,
  ): Promise<ProvisionResult> {
    if (!isComputeConfigured()) {
      throw new HetznerCloudError(
        "missing_token",
        "Cannot provision a node: compute provider credentials are not configured.",
      );
    }
    if (bootstrap.controlPlanePublicKey.trim().length === 0) {
      throw new HetznerCloudError(
        "invalid_input",
        "controlPlanePublicKey is required to provision a node",
      );
    }

    const nodeId = request.nodeId ?? generateNodeId();
    const serverType = request.serverType ?? this.policy.defaultServerType;
    const location = request.location ?? this.policy.defaultLocation;
    const image = request.image ?? this.policy.defaultImage;
    const policyCapacity = this.policy.defaultCapacity;
    const requestedCapacity = request.capacity ?? policyCapacity;
    const prePullImages = request.prePullImages ?? [containersEnv.defaultAgentImage()];
    const networkIds = containersEnv.defaultHcloudNetworkIds();
    const providerName =
      process.env.COMPUTE_PROVIDER === "digitalocean" ? "digitalocean" : "hetzner";
    let firewallIds: number[] | undefined;
    if (providerName === "hetzner") {
      try {
        firewallIds = containersEnv.defaultHcloudFirewallIds();
      } catch (error) {
        throw new HetznerCloudError(
          "invalid_input",
          error instanceof Error ? error.message : "Invalid Hetzner firewall configuration",
          undefined,
          error,
        );
      }
      if (firewallIds.length === 0) {
        throw new HetznerCloudError(
          "invalid_input",
          "CONTAINERS_HCLOUD_FIREWALL_IDS is required for Hetzner node provisioning",
        );
      }
    }

    const userData = buildContainerNodeUserData({
      nodeId,
      controlPlanePublicKey: bootstrap.controlPlanePublicKey,
      registrationUrl: bootstrap.registrationUrl,
      registrationSecret: bootstrap.registrationSecret,
      prePullImages,
      prePullPlatform: containersEnv.defaultAgentImagePlatform(),
      ...(request.capacity === undefined ? {} : { capacity: request.capacity }),
    });

    const client = this.computeProvider();
    // `environment` + `tier` let the orchestrator scope server lookups via
    // Hetzner's label_selector (e.g. `environment=staging,tier=data-plane`) so
    // staging never touches a production node, and a runaway daemon can't
    // accidentally claim/drain a server from a sibling environment. Without
    // these labels every API-discovered node looks identical, which is how we
    // shipped a staging node tagged `environment=production` in the first
    // place. Caller overrides via `request.labels` win (test seams).
    const environment = containersEnv.environment();
    const labels = {
      ...request.labels,
      "managed-by": "eliza-cloud",
      "node-id": nodeId,
      environment,
      tier: "data-plane",
    };

    return withNodeProvisionAuthority(`${providerName}:${environment}`, async (authority) => {
      const existingRow = authority.nodes.find((node) => node.node_id === nodeId);
      if (existingRow) {
        if (providerName === "hetzner") {
          await attestHetznerCloudNode(existingRow, client);
        }
        return provisionResultFromNode(existingRow);
      }

      const inventory = await client.listServers(
        providerName === "hetzner"
          ? undefined
          : {
              "managed-by": "eliza-cloud",
              environment,
              tier: "data-plane",
            },
      );
      const providerServers =
        providerName === "hetzner"
          ? inventory.filter(
              (server) =>
                server.labels?.["managed-by"] === "eliza-cloud" &&
                server.labels.environment === environment &&
                server.labels.tier === "data-plane",
            )
          : inventory;
      const allocationMatches = providerServers.filter(
        (server) => server.labels?.["node-id"] === nodeId,
      );
      if (providerName === "hetzner" && allocationMatches.length > 1) {
        throw new HetznerCloudError(
          "invalid_input",
          `Provider inventory has multiple Hetzner allocations for node ${nodeId}`,
        );
      }
      const existingServer = allocationMatches[0];
      const sameNameServers = inventory.filter((server) => server.name === nodeId);
      if (
        providerName === "hetzner" &&
        sameNameServers.some((server) => String(server.id) !== String(existingServer?.id))
      ) {
        throw new HetznerCloudError(
          "invalid_input",
          `Provider inventory has a same-name Hetzner server without the exact allocation labels for node ${nodeId}`,
        );
      }
      if (providerName === "hetzner" && existingServer) {
        assertAuthoritativeHetznerServer(existingServer, {
          nodeId,
          environment,
          firewallIds: firewallIds ?? [],
        });
      }
      const environmentNodes = authority.nodes.filter((node) => {
        const metadata = (node.metadata ?? {}) as Record<string, unknown>;
        const nodeProvider = metadata.provider;
        const belongsToProvider =
          providerName === "hetzner"
            ? nodeProvider === "hetzner-cloud" || nodeProvider == null
            : nodeProvider === providerName;
        return (
          belongsToProvider &&
          (metadata.environment === environment || metadata.environment == null)
        );
      });
      const providerIds = new Set(providerServers.map((server) => String(server.id)));
      const dbOnlyCount = environmentNodes.filter((node) => {
        const id = getHcloudServerId(node);
        return id === undefined || !providerIds.has(String(id));
      }).length;
      const authoritativeNodeCount = providerServers.length + dbOnlyCount;
      const representedProviderIds = new Set(
        environmentNodes
          .map((node) => getHcloudServerId(node))
          .filter((id): id is number => id !== undefined)
          .map(String),
      );
      const providerOnlyCount = providerServers.filter(
        (server) => !representedProviderIds.has(String(server.id)),
      ).length;
      const authoritativeCapacity =
        environmentNodes.reduce(
          (sum, node) => sum + nodeCapacityReservation(node, policyCapacity),
          0,
        ) +
        providerOnlyCount * policyCapacity;
      const capacityBudget = this.policy.maxNodes * this.policy.defaultCapacity;

      if (!existingServer && authoritativeNodeCount >= this.policy.maxNodes) {
        throw new HetznerCloudError(
          "quota_exceeded",
          `Compute node quota reached for ${providerName}/${environment}`,
        );
      }
      if (!existingServer && authoritativeCapacity + requestedCapacity > capacityBudget) {
        throw new HetznerCloudError(
          "quota_exceeded",
          `Compute capacity budget reached for ${providerName}/${environment}`,
        );
      }

      const provisioned = existingServer
        ? { server: existingServer, rootPassword: null }
        : await client.createServer({
            name: nodeId,
            serverType,
            location,
            image,
            userData,
            networkIds,
            ...(firewallIds ? { firewallIds } : {}),
            labels,
          });
      const hcloudServerId = assertSafeCreatedHetznerServerId(provisioned.server.id, providerName);
      let authoritativeServer = provisioned.server;

      try {
        if (providerName === "hetzner" && !existingServer) {
          authoritativeServer = await this.settleCreatedHetznerServer(client, hcloudServerId, {
            nodeId,
            environment,
            firewallIds: firewallIds ?? [],
            serverId: hcloudServerId,
          });
        }
        const ip = authoritativeServer.publicIpv4 ?? authoritativeServer.name;
        const providerServerId = providerName === "hetzner" ? String(hcloudServerId) : null;
        await authority.createNode({
          node_id: nodeId,
          hostname: ip,
          ssh_port: 22,
          // Zero is the data-level fail-closed fence. Legacy placement paths
          // query allocated_count < capacity without reading metadata.
          capacity: 0,
          enabled: true,
          status: "unknown",
          allocated_count: 0,
          ssh_user: "root",
          fleet_kind: providerName === "hetzner" ? "cloud" : null,
          infrastructure_provider: providerName === "hetzner" ? "hetzner" : null,
          provider_server_id: providerServerId,
          // The provider API proves server identity, not the running kernel.
          // Health SSH publishes the first boot UUID after host-key verification.
          node_incarnation: null,
          metadata: {
            provider: providerName === "hetzner" ? "hetzner-cloud" : providerName,
            environment,
            autoscaled: true,
            hcloudServerId,
            ip,
            serverType,
            location,
            image,
            architecture: inferArchitectureFromHetznerServerType(serverType),
            provisionedAt: new Date().toISOString(),
            capacityProvisional: true,
            capacityRequested: request.capacity ?? null,
            capacityPolicyFallback: policyCapacity,
          },
        });

        logger.info("[autoscaler] Provisioned new container node", {
          nodeId,
          hcloudServerId,
          ip,
          serverType,
          location,
          capacityProvisional: true,
        });

        return {
          nodeId,
          hostname: ip,
          hcloudServerId,
          rootPassword: provisioned.rootPassword,
          idempotent: Boolean(existingServer),
        };
      } catch (error) {
        if (!existingServer) await client.deleteServer(hcloudServerId);
        throw error;
      }
    });
  }

  private async settleCreatedHetznerServer(
    client: ComputeProvider,
    serverId: number,
    expected: HetznerServerAuthority & { serverId: number },
  ): Promise<ComputeServer> {
    for (let attempt = 1; attempt <= HCLOUD_FIREWALL_SETTLEMENT_ATTEMPTS; attempt += 1) {
      const server = await client.getServer(serverId);
      if (server) {
        const state = assertAuthoritativeHetznerServer(server, expected, {
          allowSettling: true,
        });
        if (state === "applied") return server;
      }
      if (attempt < HCLOUD_FIREWALL_SETTLEMENT_ATTEMPTS) {
        await this.settlementSleep(HCLOUD_FIREWALL_SETTLEMENT_DELAY_MS);
      }
    }
    throw new HetznerCloudError(
      "invalid_input",
      `New Hetzner server ${serverId} did not reach the authoritative firewall state after ${HCLOUD_FIREWALL_SETTLEMENT_ATTEMPTS} reads`,
    );
  }

  /**
   * Drain a node: disable so no new containers land on it, then either
   * leave it idle or deprovision the underlying server once it is empty.
   *
   * Stateful containers (volume_path != null) on the node block
   * deprovision until the operator migrates or deletes them. The method
   * surfaces this as a structured error so the operator UI can show a
   * useful message.
   */
  async drainNode(nodeId: string, options: DrainOptions = {}): Promise<void> {
    const node = await dockerNodesRepository.findByNodeId(nodeId);
    if (!node) {
      throw new HetznerCloudError("not_found", `node ${nodeId} not registered`);
    }

    if (node.enabled) {
      await dockerNodesRepository.update(node.id, { enabled: false });
      logger.info("[autoscaler] Disabled node for drain", { nodeId });
    }

    const retainedWorkloads = await countRetainedWorkloadsOnNode(nodeId);
    if (retainedWorkloads > 0) {
      logger.info("[autoscaler] Node still has retained workloads, leaving disabled until empty", {
        nodeId,
        remaining: retainedWorkloads,
      });
      return;
    }

    if (options.deprovision !== true) return;

    const hcloudServerId = getHcloudServerId(node);
    if (!hcloudServerId) {
      logger.warn("[autoscaler] Cannot deprovision: no hcloudServerId on node metadata", {
        nodeId,
      });
      return;
    }

    if (!isHetznerCloudConfigured()) {
      throw new HetznerCloudError(
        "missing_token",
        `Cannot attest or delete Hetzner server ${hcloudServerId} without HCLOUD_TOKEN`,
      );
    }

    const client = this.computeProvider();
    try {
      const attested = await attestHetznerCloudNode(node, client);
      await client.deleteServer(attested.serverId);
    } catch (err) {
      // error-policy:J6 idempotent teardown — a not_found means the server is
      // already deprovisioned (the desired end state), so the DB row is safe to
      // delete below. Every other outbound-API failure (auth/rate-limit/5xx)
      // rethrows so a live server is never orphaned by a silently-dropped delete.
      if (err instanceof HetznerCloudError && err.code === "not_found") {
        logger.info("[autoscaler] Hetzner server already gone", {
          nodeId,
          hcloudServerId,
        });
      } else {
        throw err;
      }
    }

    await dockerNodesRepository.delete(node.id);
    logger.info("[autoscaler] Deprovisioned node", { nodeId, hcloudServerId });
  }

  /**
   * Drain candidates: enabled nodes with zero containers (status filter
   * already enforced upstream by the count query) AND created long enough
   * ago that we are not deprovisioning a node that has just barely come
   * online before any container could land on it.
   */
  private async findDrainCandidates(
    healthyEnabled: DockerNode[],
    allocatedByNode: Map<string, number>,
    totalAvailable: number,
  ): Promise<DockerNode[]> {
    const ageThreshold = this.nowFn() - this.policy.idleNodeMinAgeMs;
    const oldEnough = healthyEnabled.filter(
      (n) => isAutoscaledHetznerNode(n) && n.created_at.getTime() < ageThreshold,
    );
    if (oldEnough.length === 0) return [];

    const preservationFloor = Math.max(
      this.policy.minFreeSlotsBuffer,
      this.policy.minHotAvailableSlots,
    );
    const counts = await Promise.all(
      oldEnough.map(async (node) => ({
        node,
        retainedCount: await countRetainedWorkloadsOnNode(node.node_id),
      })),
    );

    // The configured slot floor is authoritative, including zero. Keeping an
    // extra node unconditionally would keep charging an empty fleet forever.
    let remainingAvailable = totalAvailable;
    const drainCandidates: DockerNode[] = [];

    for (const { node, retainedCount } of counts) {
      if (retainedCount > 0) continue;

      const allocated = allocatedByNode.get(node.node_id) ?? node.allocated_count;
      if (allocated > 0) continue;

      const nodeAvailable = Math.max(0, node.capacity - allocated);
      if (remainingAvailable - nodeAvailable < preservationFloor) continue;

      drainCandidates.push(node);
      remainingAvailable -= nodeAvailable;
    }

    return drainCandidates;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSafeCreatedHetznerServerId(
  value: number | string,
  providerName: "hetzner" | "digitalocean",
): number {
  if (providerName === "hetzner") {
    return requireSafeHetznerServerId(value, "New Hetzner server response");
  }
  const providerId = Number(value);
  if (!Number.isSafeInteger(providerId) || providerId <= 0) {
    throw new HetznerCloudError(
      "invalid_input",
      "New compute server response has an invalid provider ID",
    );
  }
  return providerId;
}

function generateNodeId(): string {
  // Short hex id with a deterministic prefix — easy to scan in the dashboard.
  // `Math.random().toString(16)` strips trailing zeros (e.g. 0.5 → "0.8"), so
  // `.slice(2, 10)` is not guaranteed to be 8 chars. Generate 4 random bytes
  // and hex-encode them for a stable 8-char suffix and stronger uniqueness.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `eliza-core-${random}`;
}

function getHcloudServerId(node: DockerNode): number | undefined {
  if (
    node.fleet_kind === "cloud" &&
    node.infrastructure_provider === "hetzner" &&
    node.provider_server_id !== null
  ) {
    const providerId = Number(node.provider_server_id);
    return Number.isSafeInteger(providerId) && providerId > 0 ? providerId : undefined;
  }
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return typeof meta.hcloudServerId === "number" ? meta.hcloudServerId : undefined;
}

function nodeCapacityReservation(node: DockerNode, policyFallback: number): number {
  const metadata = (node.metadata ?? {}) as Record<string, unknown>;
  if (metadata.capacityProvisional !== true) return node.capacity;
  const requested = metadata.capacityRequested;
  if (typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0) {
    return requested;
  }
  const fallback = metadata.capacityPolicyFallback;
  return typeof fallback === "number" && Number.isSafeInteger(fallback) && fallback > 0
    ? fallback
    : policyFallback;
}

function provisionResultFromNode(node: DockerNode): ProvisionResult {
  const hcloudServerId = getHcloudServerId(node);
  if (hcloudServerId === undefined) {
    throw new HetznerCloudError(
      "invalid_input",
      `node ${node.node_id} has no authoritative provider id`,
    );
  }
  return {
    nodeId: node.node_id,
    hostname: node.hostname,
    hcloudServerId,
    rootPassword: null,
    idempotent: true,
  };
}

function isAutoscaledHetznerNode(node: DockerNode): boolean {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return (
    meta.provider === "hetzner-cloud" &&
    meta.autoscaled === true &&
    getHcloudServerId(node) !== undefined
  );
}

let cachedAutoscaler: NodeAutoscaler | null = null;

export function getNodeAutoscaler(): NodeAutoscaler {
  if (!cachedAutoscaler) cachedAutoscaler = new NodeAutoscaler();
  return cachedAutoscaler;
}
