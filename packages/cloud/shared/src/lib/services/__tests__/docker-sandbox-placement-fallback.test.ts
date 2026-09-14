/**
 * Verifies that database-backed Docker placement cannot bypass an unavailable
 * or quarantined fleet by reusing the initial environment seed list.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { dockerNodeManager } from "../docker-node-manager";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";

const REGISTERED_NODE: DockerNode = {
  id: "11111111-1111-4111-8111-111111111111",
  node_id: "node-quarantined",
  hostname: "192.0.2.42",
  ssh_port: 22,
  capacity: 8,
  enabled: true,
  status: "healthy",
  allocated_count: 2,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:placement-node",
  metadata: {},
  created_at: new Date("2026-08-07T00:00:00.000Z"),
  updated_at: new Date("2026-08-07T00:00:00.000Z"),
};

type PlacementInternals = {
  provisionAutoscaledNodeForAgent: (input: {
    image: string;
    platform?: string;
  }) => Promise<DockerNode | null>;
};

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider placement fallback", () => {
  test("refuses the seed list when registered nodes exist but none are selectable", async () => {
    const savedSeedNodes = process.env.CONTAINERS_DOCKER_NODES;
    process.env.CONTAINERS_DOCKER_NODES = "node-quarantined:192.0.2.42:8";
    const provider = new DockerSandboxProvider();
    const autoscale = spyOn(
      provider as unknown as PlacementInternals,
      "provisionAutoscaledNodeForAgent",
    ).mockResolvedValue(null);
    const selectNode = spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(null);
    const findAll = spyOn(dockerNodesRepository, "findAll").mockResolvedValue([REGISTERED_NODE]);
    const getSshClient = spyOn(DockerSSHClient, "getClient");

    try {
      const failure = await provider
        .create({
          agentId: "22222222-2222-4222-8222-222222222222",
          agentName: "Placement breaker regression",
          executionTier: "dedicated-always",
          environmentVars: {},
          startFundedContainer: async () => {
            throw new Error("Unavailable placement cannot start a container");
          },
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ElizaError);
      expect(failure).toMatchObject({
        code: "DOCKER_PLACEMENT_UNAVAILABLE",
        context: {
          registeredNodeCount: 1,
        },
        severity: "ephemeral",
      });
      expect((failure as Error).message).toContain(
        "Registered Docker nodes exist but none are available for placement; refusing CONTAINERS_DOCKER_NODES seed fallback",
      );
    } finally {
      if (savedSeedNodes === undefined) {
        delete process.env.CONTAINERS_DOCKER_NODES;
      } else {
        process.env.CONTAINERS_DOCKER_NODES = savedSeedNodes;
      }
    }

    expect(selectNode).toHaveBeenCalledTimes(1);
    expect(autoscale).toHaveBeenCalledTimes(1);
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(getSshClient).not.toHaveBeenCalled();
  });
});
