/** Starts only committed, provider-bound funding and records the host's durable start time for retry-safe metering. */

import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "../../db/client";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import type { AgentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { computeBillingRateSegments } from "../../db/schemas/compute-billing-rate-segments";
import { agentComputeFundingService } from "./agent-compute-funding";
import { AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS } from "./agent-compute-policy";
import {
  dockerComputeRootSSH,
  grantDockerComputeLease,
  installDockerComputeGuard,
  startDockerComputeLease,
} from "./docker-compute-lease";
import { DockerSSHClient } from "./docker-ssh";
import type { SandboxHandle } from "./sandbox-provider-types";

/** Rebuild ingress from the verified retained placement, including when a failure cleared its URLs. */
export function fundedRuntimeHandle(
  started: Awaited<ReturnType<typeof startFundedAgentInTransaction>>,
): SandboxHandle {
  const { agent, node, window, containerPort } = started;
  if (!agent.bridge_port || !agent.web_ui_port || !agent.container_name)
    throw new ElizaError("Dedicated retained ingress is incomplete", {
      code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
    });
  const host = agent.headscale_ip || node.hostname;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    sandboxId: agent.container_name,
    bridgeUrl: `http://${urlHost}:${agent.headscale_ip ? containerPort : agent.bridge_port}`,
    healthUrl: `http://${urlHost}:${agent.headscale_ip ? containerPort : agent.web_ui_port}/api`,
    metadata: {
      provider: "docker",
      nodeId: node.node_id,
      hostname: node.hostname,
      containerName: agent.container_name,
      containerId: window.provider_container_id!,
      agentId: agent.id,
      bridgePort: agent.bridge_port,
      webUiPort: agent.web_ui_port,
      nodeSshPort: node.ssh_port,
      nodeSshUser: node.ssh_user,
      nodeHostKeyFingerprint: node.host_key_fingerprint,
      imageDigest: agent.image_digest,
      dockerImage: agent.docker_image,
      ...(agent.headscale_ip ? { headscaleIp: agent.headscale_ip } : {}),
    },
  };
}

/** The caller already holds the agent row lock and has verified this timestamp over pinned SSH. */
export async function recordFundedComputeStartInTransaction(
  tx: DbTransaction,
  window: AgentComputeFunding,
  lifecycleRevision: number,
  startedAtMs: number,
) {
  const now = await readPostLockDatabaseNow(tx);
  if (
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs <= 0 ||
    startedAtMs > now.getTime() + AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS
  ) {
    throw new ElizaError("Dedicated provider start timestamp is invalid", {
      code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
    });
  }
  const effectiveAt = new Date(Math.max(window.period_start.getTime(), startedAtMs));
  if (effectiveAt >= window.period_end)
    throw new ElizaError("Dedicated provider started after funding ended", {
      code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
    });
  const [existing] = await tx
    .select({ id: computeBillingRateSegments.id })
    .from(computeBillingRateSegments)
    .where(
      and(
        eq(computeBillingRateSegments.organization_id, window.organization_id),
        eq(computeBillingRateSegments.workload_kind, "agent"),
        eq(computeBillingRateSegments.workload_id, window.agent_id),
        eq(computeBillingRateSegments.billing_state, "running"),
        eq(computeBillingRateSegments.effective_at, effectiveAt),
        eq(computeBillingRateSegments.rate_per_hour, window.hourly_rate),
      ),
    )
    .limit(1);
  if (existing) return;
  await tx.insert(computeBillingRateSegments).values({
    id: crypto.randomUUID(),
    organization_id: window.organization_id,
    workload_kind: "agent",
    workload_id: window.agent_id,
    lifecycle_revision: lifecycleRevision,
    billing_state: "running",
    rate_per_hour: window.hourly_rate,
    effective_at: effectiveAt,
    created_at: now,
  });
}

/** Funds are committed before entering this transaction; its lifecycle lock fences stop/delete during host admission. */
export async function startFundedAgentInTransaction(
  tx: DbTransaction,
  input: {
    agentId: string;
    organizationId: string;
    lifecycleRevision: number;
    fundingId: string;
    nodeId: string;
    containerId: string;
    placement?: "retained" | "replacement";
  },
) {
  const authorization = await agentComputeFundingService.authorizeHostInTransaction(tx, input);
  const [agent] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, input.agentId),
        eq(agentSandboxes.organization_id, input.organizationId),
      ),
    )
    .limit(1);
  const replacement = input.placement === "replacement";
  const containerName = replacement
    ? agent?.replacement_cleanup_container_name
    : agent?.container_name;
  const placementMatches = replacement
    ? agent?.status === "provisioning" &&
      agent.replacement_cleanup_node_id === input.nodeId &&
      agent.replacement_cleanup_container_id === input.containerId &&
      agent.replacement_cleanup_sandbox_id === containerName
    : agent?.sandbox_id === containerName && agent?.node_id === input.nodeId;
  if (!agent || !containerName || !placementMatches) {
    throw new ElizaError("Dedicated retained container placement changed", {
      code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
    });
  }
  const node = await dockerNodesRepository.findByNodeIdOnPrimary(input.nodeId);
  if (!node?.host_key_fingerprint)
    throw new ElizaError("Dedicated start requires a pinned host", {
      code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
    });
  const ssh = new DockerSSHClient({
    hostname: node.hostname,
    port: node.ssh_port,
    username: node.ssh_user,
    hostKeyFingerprint: node.host_key_fingerprint,
  });
  const root = dockerComputeRootSSH(ssh, node.ssh_user);
  try {
    await ssh.connect();
    const placement = z
      .object({ name: z.string(), port: z.number().int().min(1).max(65535) })
      .parse(
        JSON.parse(
          await root.execStdin(
            "python3 -",
            `import json, subprocess\nc=json.loads(subprocess.check_output(['docker','inspect',${JSON.stringify(input.containerId)}],text=True))[0]\nports=[v[5:] for v in c['Config']['Env'] if v.startswith('PORT=')]\nassert len(ports)==1, 'missing_or_ambiguous_runtime_port'\nprint(json.dumps({'name':c['Name'],'port':int(ports[0])}))\n`,
          ),
        ),
      );
    if (placement.name !== `/${containerName}`)
      throw new ElizaError("Dedicated retained Docker identity changed", {
        code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
      });
    await installDockerComputeGuard(root);
    const granted = JSON.parse(await grantDockerComputeLease(root, authorization));
    for (const key of Object.keys(authorization) as (keyof typeof authorization)[]) {
      if (key !== "issuedAtMs" && granted.authorization?.[key] !== authorization[key])
        throw new ElizaError("Dedicated grant receipt changed", {
          code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
        });
    }
    const started = z
      .object({
        authorization: z.record(z.string(), z.unknown()),
        expired: z.literal(false),
        startedAtMs: z.number().int().positive().safe(),
      })
      .parse(JSON.parse(await startDockerComputeLease(root, authorization)));
    for (const key of Object.keys(authorization) as (keyof typeof authorization)[]) {
      if (key !== "issuedAtMs" && started.authorization[key] !== authorization[key])
        throw new ElizaError("Dedicated start receipt changed", {
          code: "AGENT_COMPUTE_START_AUTHORITY_CHANGED",
        });
    }
    const window = await agentComputeFundingService.confirmHostLeaseInTransaction(tx, input);
    await recordFundedComputeStartInTransaction(
      tx,
      window,
      input.lifecycleRevision,
      started.startedAtMs,
    );
    return { agent, node, window, containerPort: placement.port };
  } finally {
    await ssh.disconnect();
  }
}
