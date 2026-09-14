/** Durable delivery of committed funding to the exact paid Docker instance. */

import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import type { AgentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { type Job, jobs } from "../../db/schemas/jobs";
import { agentComputeFundingService } from "./agent-compute-funding";
import { JOB_TYPES } from "./provisioning-job-types";

const leaseJobData = z.object({
  agentId: z.uuid(),
  organizationId: z.uuid(),
  fundingId: z.uuid(),
  lifecycleRevision: z.number().int().nonnegative(),
});

export function readAgentComputeLeaseJobData(job: Job) {
  const data = leaseJobData.parse(job.data);
  if (
    job.type !== JOB_TYPES.AGENT_COMPUTE_LEASE ||
    job.id !== data.fundingId ||
    job.organization_id !== data.organizationId ||
    job.agent_id !== data.agentId
  ) {
    throw new ElizaError("Dedicated funding job identity changed", {
      code: "AGENT_COMPUTE_LEASE_JOB_MISMATCH",
      severity: "fatal",
    });
  }
  return data;
}

/** The window id is the job id, making every renewal's delivery exactly identifiable. */
export async function enqueueAgentComputeLeaseInTransaction(
  tx: DbTransaction,
  window: AgentComputeFunding,
  lifecycleRevision: number,
  userId: string,
) {
  const data = leaseJobData.parse({
    agentId: window.agent_id,
    organizationId: window.organization_id,
    fundingId: window.id,
    lifecycleRevision,
  });
  await tx.insert(jobs).values({
    id: window.id,
    type: JOB_TYPES.AGENT_COMPUTE_LEASE,
    agent_id: window.agent_id,
    organization_id: window.organization_id,
    user_id: userId,
    status: "pending",
    data,
    data_storage: "inline",
    max_attempts: 3,
  });
}

/** Renewal only updates a lease; it never restarts a user-stopped container. */
export async function executeAgentComputeLeaseJob(
  job: Job,
  assertExecutionLease: () => Promise<void>,
) {
  const data = readAgentComputeLeaseJobData(job);
  const [window] = await dbWrite
    .select()
    .from(agentComputeFunding)
    .where(
      and(
        eq(agentComputeFunding.id, data.fundingId),
        eq(agentComputeFunding.agent_id, data.agentId),
        eq(agentComputeFunding.organization_id, data.organizationId),
        isNull(agentComputeFunding.settled_at),
      ),
    );
  if (!window?.provider_node_id || !window.provider_container_id) {
    throw new ElizaError("Dedicated renewal lost its provider binding", {
      code: "AGENT_COMPUTE_LEASE_PROVIDER_MISSING",
      severity: "fatal",
    });
  }
  // Keep SSH and the embedded host program outside the Worker billing import path.
  const { dockerNodesRepository } = await import("../../db/repositories/docker-nodes");
  const { DockerSSHClient } = await import("./docker-ssh");
  const { installDockerComputeGuard, grantDockerComputeLease, dockerComputeRootSSH } = await import(
    "./docker-compute-lease"
  );
  const node = await dockerNodesRepository.findByNodeIdOnPrimary(window.provider_node_id);
  if (!node?.host_key_fingerprint) {
    throw new ElizaError("Dedicated renewal requires a pinned host key", {
      code: "AGENT_COMPUTE_LEASE_HOST_UNVERIFIED",
      severity: "fatal",
    });
  }
  const ssh = new DockerSSHClient({
    hostname: node.hostname,
    port: node.ssh_port,
    username: node.ssh_user,
    hostKeyFingerprint: node.host_key_fingerprint,
  });
  const identity = {
    ...data,
    nodeId: window.provider_node_id,
    containerId: window.provider_container_id,
  };
  const rootSSH = dockerComputeRootSSH(ssh, node.ssh_user);
  try {
    await assertExecutionLease();
    await ssh.connect();
    await installDockerComputeGuard(rootSSH);
    await assertExecutionLease();
    const authorization = await dbWrite.transaction((tx) =>
      agentComputeFundingService.authorizeHostInTransaction(tx, identity),
    );
    const receipt: unknown = JSON.parse(await grantDockerComputeLease(rootSSH, authorization));
    const parsed = z
      .object({
        authorization: z.object({
          agentId: z.literal(authorization.agentId),
          organizationId: z.literal(authorization.organizationId),
          containerId: z.literal(authorization.containerId),
          fundingId: z.literal(authorization.fundingId),
          previousFundingId: z.literal(authorization.previousFundingId),
          paidFromMs: z.literal(authorization.paidFromMs),
          paidUntilMs: z.literal(authorization.paidUntilMs),
        }),
        expired: z.literal(false),
      })
      .parse(receipt);
    await assertExecutionLease();
    await dbWrite.transaction((tx) =>
      agentComputeFundingService.confirmHostLeaseInTransaction(tx, identity),
    );
    return { fundingId: data.fundingId, paidUntilMs: parsed.authorization.paidUntilMs };
  } finally {
    await ssh.disconnect();
  }
}
