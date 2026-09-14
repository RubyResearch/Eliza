/**
 * `DockerSandboxProvider` stop is remote-teardown-only (#17185).
 *
 * The provider used to decrement `docker_nodes.allocated_count` at the end of
 * every stop. That made local capacity arithmetic a side effect of a RETRYABLE
 * remote operation which treats "already gone" as success — so each retry after
 * a post-stop failure freed another slot, and the slot it freed belonged to a
 * live sibling on that node. Ownership of the counter moved to the caller's
 * deletion generation; the provider must now never touch it, on ANY outcome.
 *
 * Drives the real `DockerSandboxProvider` with only the SSH transport scripted
 * (the seam the issue names) and the container meta pre-seeded in memory, so the
 * real classification logic — already-absent, unreachable-abandon, genuine
 * failure — decides each path. `decrementAllocated` is spied, never stubbed out
 * of existence: the assertion is that the real method is never reached.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

// The transport factory is replaced only while each test runs. A module-wide
// replacement also changes the SSH class seen by neighboring health suites.
let execBehavior: (command: string) => Promise<string> = async () => "";
let sshFactorySpy: ReturnType<typeof spyOn>;

import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";
import { headscaleIntegration } from "../headscale-integration";

const SANDBOX_ID = "agent-capacity-ownership-test";
const NODE_ID = "node-1";

type ContainerMetaSeed = {
  nodeId: string;
  hostname: string;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  sshPort: number;
  sshUser: string;
  tsHostname?: string;
  vpnNodeId?: string;
};

function seedContainer(provider: DockerSandboxProvider): void {
  // resolveContainer() returns straight from the private in-memory map, so
  // seeding it keeps the DB out of the stop path entirely.
  (provider as unknown as { containers: Map<string, ContainerMetaSeed> }).containers.set(
    SANDBOX_ID,
    {
      nodeId: NODE_ID,
      hostname: "138.201.80.125",
      containerName: SANDBOX_ID,
      bridgePort: 3001,
      webUiPort: 3002,
      agentId: SANDBOX_ID,
      sshPort: 22,
      sshUser: "root",
    },
  );
}

let decrementSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Headscale deletion is skipped when unconfigured.
  delete process.env.HEADSCALE_API_KEY;
  delete process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART;
  delete process.env.ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART;
  sshFactorySpy = spyOn(DockerSSHClient, "createDedicated").mockImplementation(
    (hostname, port, hostKeyFingerprint, username) => {
      const client = new DockerSSHClient({
        hostname,
        port,
        hostKeyFingerprint,
        username,
        privateKey: Buffer.from("test-only-ssh-key"),
      });
      spyOn(client, "exec").mockImplementation((command) => execBehavior(command));
      spyOn(client, "disconnect").mockResolvedValue(undefined);
      return client;
    },
  );
  decrementSpy = spyOn(dockerNodesRepository, "decrementAllocated");
});

afterEach(() => {
  decrementSpy.mockRestore();
  sshFactorySpy.mockRestore();
});

describe("provider stop never mutates node capacity", () => {
  test.each(["current", "stale", "absent"])(
    "uses only observed VPN identity for lifecycle deletion (%s)",
    async (registration) => {
      process.env.HEADSCALE_API_KEY = "test-headscale-key";
      execBehavior = async () => "absent";
      const provider = new DockerSandboxProvider();
      if (registration !== "absent") {
        const containers = (provider as unknown as { containers: Map<string, ContainerMetaSeed> })
          .containers;
        seedContainer(provider);
        const meta = containers.get(SANDBOX_ID);
        if (!meta) throw new Error("Missing seeded container");
        meta.tsHostname = "registered-agent-111111111111";
        meta.vpnNodeId = "42";
        if (registration === "stale") meta.nodeId = "previous-node";
      }
      const byId = spyOn(headscaleIntegration, "removeVpnNodeById").mockResolvedValue();
      const byName = spyOn(headscaleIntegration, "cleanupContainerVPN").mockResolvedValue();
      try {
        await expect(
          provider.stopForDeletion(SANDBOX_ID, {
            sandboxId: SANDBOX_ID,
            agentId: SANDBOX_ID,
            nodeId: NODE_ID,
            containerName: SANDBOX_ID,
            hostname: "host.example.test",
            sshUser: "root",
            sshPort: 22,
          }),
        ).resolves.toEqual({ kind: "not-running-proven" });
        expect(byName).not.toHaveBeenCalled();
        if (registration === "current") expect(byId).toHaveBeenCalledWith("42");
        else expect(byId).not.toHaveBeenCalled();
        expect(decrementSpy).not.toHaveBeenCalled();
      } finally {
        byId.mockRestore();
        byName.mockRestore();
        delete process.env.HEADSCALE_API_KEY;
      }
    },
  );

  test.each([
    { hostname: "", sshUser: "root", sshPort: 22 },
    { hostname: "host.example.test", sshUser: " ", sshPort: 22 },
    { hostname: "host.example.test", sshUser: "root", sshPort: 0 },
    { hostname: "host.example.test" },
  ])("rejects incomplete captured SSH authority before remote work: %j", async (authority) => {
    const commands: string[] = [];
    execBehavior = async (command) => {
      commands.push(command);
      return "absent";
    };
    const nodeLookup = spyOn(dockerNodesRepository, "findByNodeIdOnPrimary");
    try {
      await expect(
        new DockerSandboxProvider().stopForDeletion(SANDBOX_ID, {
          sandboxId: SANDBOX_ID,
          agentId: SANDBOX_ID,
          nodeId: NODE_ID,
          containerName: SANDBOX_ID,
          ...authority,
        }),
      ).rejects.toMatchObject({ code: "SANDBOX_DELETION_SSH_AUTHORITY_INVALID" });
      expect(commands).toEqual([]);
      expect(nodeLookup).not.toHaveBeenCalled();
      expect(decrementSpy).not.toHaveBeenCalled();
    } finally {
      nodeLookup.mockRestore();
    }
  });

  test("an exact absence probe skips mutating Docker commands on a deletion retry", async () => {
    const commands: string[] = [];
    execBehavior = async (command) => {
      commands.push(command);
      return command.startsWith("sh -lc") ? "absent\n" : "";
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("docker container inspect");
    expect(commands[0]).not.toContain("docker stop");
    expect(commands[0]).not.toContain("docker rm -f");
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("a clean stop + rm leaves allocated_count to the caller", async () => {
    execBehavior = async () => "";
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("an already-absent container does not release a slot a second time", async () => {
    // The retry shape from the issue: the first attempt tore the container down,
    // a downstream step failed, and the re-run finds it gone. Accepting that as
    // success is correct; decrementing again is what freed a live sibling's slot.
    execBehavior = async () => {
      throw new Error("Error response from daemon: No such container: agent-x");
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("a restarted worker deletes from lifecycle placement without re-reading the sandbox", async () => {
    execBehavior = async () => {
      throw new Error("Error response from daemon: No such container: agent-x");
    };
    const sandboxLookup = spyOn(
      agentSandboxesRepository,
      "findBySandboxIdForWrite",
    ).mockImplementation(async () => {
      throw new Error("sandbox lookup must not run after deletion ownership is captured");
    });
    const nodeLookup = spyOn(dockerNodesRepository, "findByNodeIdOnPrimary").mockResolvedValue({
      node_id: NODE_ID,
      hostname: "138.201.80.125",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: "test-fingerprint",
    } as never);
    const provider = new DockerSandboxProvider();

    try {
      await expect(
        provider.stopForDeletion(SANDBOX_ID, {
          sandboxId: SANDBOX_ID,
          agentId: SANDBOX_ID,
          nodeId: NODE_ID,
          containerName: SANDBOX_ID,
        }),
      ).resolves.toEqual({ kind: "not-running-proven" });
      expect(sandboxLookup).not.toHaveBeenCalled();
      expect(nodeLookup).toHaveBeenCalledWith(NODE_ID);
      expect(decrementSpy).not.toHaveBeenCalled();
    } finally {
      sandboxLookup.mockRestore();
      nodeLookup.mockRestore();
    }
  });

  test("incomplete persisted SSH authority rejects before any Docker command", async () => {
    const commands: string[] = [];
    execBehavior = async (command) => {
      commands.push(command);
      return "";
    };
    const nodeLookup = spyOn(dockerNodesRepository, "findByNodeIdOnPrimary").mockResolvedValue({
      node_id: NODE_ID,
      hostname: "",
      ssh_port: 22,
      ssh_user: "root",
    } as never);
    try {
      await expect(
        new DockerSandboxProvider().stopForDeletion(SANDBOX_ID, {
          sandboxId: SANDBOX_ID,
          agentId: SANDBOX_ID,
          nodeId: NODE_ID,
          containerName: SANDBOX_ID,
        }),
      ).rejects.toMatchObject({
        code: "SANDBOX_DELETION_SSH_AUTHORITY_INVALID",
      });
      expect(commands).toEqual([]);
      expect(decrementSpy).not.toHaveBeenCalled();
    } finally {
      nodeLookup.mockRestore();
    }
  });

  test("an unreachable container retains its capacity for reconciliation", async () => {
    execBehavior = async () => {
      throw new Error("[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms");
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-unresolved",
      reason: "node-unreachable",
    });
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("a reachable stop failure rejects, so the caller never reaches its release", async () => {
    // This is how ownership survives a genuine failure: the provider throws, the
    // delete path returns before the release CAS, and the retry that finally
    // completes the teardown is the one that hands the slot back.
    execBehavior = async () => {
      throw new Error("Cannot connect to the Docker daemon");
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).rejects.toThrow(/Failed to stop container/);
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("an opted-in deletion recovers a twice-timed-out Docker daemon before exact removal", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const commands: string[] = [];
    execBehavior = async (command) => {
      commands.push(command);
      if (command.startsWith("sh -lc")) return "unknown\n";
      if (command.startsWith("if timeout")) return "unavailable";
      if (command.startsWith("docker stop") || command.startsWith("docker rm")) {
        throw new Error(
          "[docker-ssh] Command timed out after 25000ms on 138.201.80.125: docker [redacted]",
        );
      }
      return "";
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(commands.some((command) => command.includes("LiveRestoreEnabled"))).toBe(true);
    expect(commands.some((command) => command.includes("--kill-who=main"))).toBe(true);
    expect(commands.some((command) => command.includes("systemctl start docker.service"))).toBe(
      true,
    );
    expect(commands.some((command) => command.includes("docker info"))).toBe(true);
    expect(commands.some((command) => command.includes("systemctl restart containerd"))).toBe(
      false,
    );
    expect(
      commands.some((command) =>
        command.includes(`timeout -k 2s 20s docker rm -f '${SANDBOX_ID}'`),
      ),
    ).toBe(true);
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test.each(["unavailable-proof", "invalid-health"])(
    "a deletion preserves its failure without restarting when recovery has %s",
    async (failure) => {
      process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
      const commands: string[] = [];
      execBehavior = async (command) => {
        commands.push(command);
        if (command.startsWith("sh -lc")) return "unknown\n";
        if (command.startsWith("docker stop") || command.startsWith("docker rm")) {
          throw new Error("[docker-ssh] Command timed out after 25000ms on node: docker");
        }
        if (command.startsWith("if timeout")) {
          return failure === "invalid-health" ? "" : "unavailable";
        }
        if (command.includes("LiveRestoreEnabled")) {
          throw new Error("Active Docker live-restore proof is unavailable");
        }
        return "";
      };
      const provider = new DockerSandboxProvider();
      seedContainer(provider);

      await expect(provider.stopForDeletion(SANDBOX_ID)).rejects.toThrow(
        "Failed to stop container",
      );
      expect(commands.some((command) => command.includes("LiveRestoreEnabled"))).toBe(
        failure === "unavailable-proof",
      );
      expect(commands.some((command) => command.includes("systemctl"))).toBe(false);
      expect(decrementSpy).not.toHaveBeenCalled();
    },
  );

  test("an opted-in deletion recovers when the Docker timeout poisons the reconnect", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const commands: string[] = [];
    let deleteAttempts = 0;
    execBehavior = async (command) => {
      commands.push(command);
      if (command.startsWith("sh -lc")) return "unknown\n";
      if (command.startsWith("if timeout")) return "unavailable";
      if (command.startsWith("docker stop")) {
        throw new Error(
          "[docker-ssh] Command timed out after 25000ms on 138.201.80.125: docker [redacted]",
        );
      }
      if (command.startsWith("docker rm")) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("[docker-ssh] Connection error: channel closed after reconnect");
        }
      }
      return "";
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(commands.some((command) => command.includes("LiveRestoreEnabled"))).toBe(true);
    expect(commands.some((command) => command.includes("--kill-who=main"))).toBe(true);
    expect(deleteAttempts).toBe(1);
    expect(
      commands.some((command) =>
        command.includes(`timeout -k 2s 20s docker rm -f '${SANDBOX_ID}'`),
      ),
    ).toBe(true);
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("an opted-in deletion re-probes a transport-failed pair before deciding to restart Docker", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const commands: string[] = [];
    let initialDeleteAttempts = 0;
    execBehavior = async (command) => {
      commands.push(command);
      if (command.startsWith("sh -lc")) return "unknown\n";
      if (command.startsWith("if timeout")) return "healthy";
      if (command.startsWith("docker stop") || command.startsWith("docker rm")) {
        initialDeleteAttempts += 1;
        throw new Error("[docker-ssh] stream error on node: channel closed");
      }
      return "";
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(initialDeleteAttempts).toBe(2);
    expect(commands.some((command) => command.includes("LiveRestoreEnabled"))).toBe(false);
    expect(commands.some((command) => command.includes("--kill-who=main"))).toBe(false);
    expect(
      commands.some((command) =>
        command.includes(`timeout -k 2s 20s docker rm -f '${SANDBOX_ID}'`),
      ),
    ).toBe(true);
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("an opted-in deletion recovers after a remote daemon error plus exact timeout", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const commands: string[] = [];
    let deleteAttempts = 0;
    execBehavior = async (command) => {
      commands.push(command);
      if (command.startsWith("sh -lc")) return "unknown\n";
      if (command.startsWith("if timeout")) return "unavailable";
      if (command.startsWith("docker stop")) {
        throw new Error(
          "[docker-ssh] Command exited with code 1 on node: Cannot connect to the Docker daemon",
        );
      }
      if (command.startsWith("docker rm")) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error(
            "[docker-ssh] Command timed out after 25000ms on node: docker [redacted]",
          );
        }
      }
      return "";
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(commands.some((command) => command.includes("LiveRestoreEnabled"))).toBe(true);
    expect(commands.some((command) => command.includes("--kill-who=main"))).toBe(true);
    expect(deleteAttempts).toBe(1);
    expect(
      commands.some((command) =>
        command.includes(`timeout -k 2s 20s docker rm -f '${SANDBOX_ID}'`),
      ),
    ).toBe(true);
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("replacement teardown DOES still release, because nothing else owns its slot", async () => {
    // The counter-free rule is scoped to deletion, not to the provider. Suspend,
    // shutdown, sleep, warm-claim retire and ghost cleanup all reach the same
    // stop path through `stopForReplacement`, stop exactly once under a fence,
    // and have no durable generation to hand the release to — so the provider
    // stays their capacity owner. `holdsCountedNodeSlot` treating a suspended
    // row as already-released depends on this decrement still happening.
    execBehavior = async () => "";
    const provider = new DockerSandboxProvider();
    seedContainer(provider);
    decrementSpy.mockResolvedValue(undefined);

    await expect(provider.stopForReplacement(SANDBOX_ID)).resolves.toBeUndefined();
    expect(decrementSpy).toHaveBeenCalledTimes(1);
    expect(decrementSpy).toHaveBeenCalledWith(NODE_ID);
  });
  test("caller-owned replacement capacity is unchanged across removal retries", async () => {
    const commands: string[] = [];
    execBehavior = async (command) => {
      commands.push(command);
      return "";
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);
    await expect(
      provider.stopForReplacement(SANDBOX_ID, { releaseCapacity: false }),
    ).resolves.toBeUndefined();
    seedContainer(provider);
    await expect(
      provider.stopForReplacement(SANDBOX_ID, { releaseCapacity: false }),
    ).resolves.toBeUndefined();
    expect(commands.filter((command) => command.startsWith("docker rm -f"))).toHaveLength(2);
    expect(decrementSpy).not.toHaveBeenCalled();
  });
});
