/**
 * Memory admission tests for node placement.
 *
 * The outage these pin, measured on staging 2026-08-12: node
 * `eliza-core-40661ddb` (7745 MiB of RAM, `capacity=4`) already carried two
 * agents at a 3072 MiB ceiling each. Placement is pure slot arithmetic, so
 * `4 - 2 = 2 > 0` selected it; `docker create` then committed a third 3072 MiB
 * ceiling on a 7.6 GiB box. The booting agent asked for ~2090 MiB, the kernel
 * fired a GLOBAL OOM (`constraint=CONSTRAINT_NONE`), and `unless-stopped`
 * relaunched it every ~29s — `RestartCount=58`, 21 `Out of memory: Killed`,
 * while `docker inspect` still reported `OOMKilled=false` because Docker only
 * sets that flag for a cgroup-limit kill.
 *
 * These tests drive the REAL manager with a stubbed SSH client + repository.
 * The fixtures are the measured numbers, so a future tweak to the reserve or
 * the predicate has to keep refusing the node that actually fell over — and
 * keep admitting the 251 GiB robot that carried 16 agents with zero kills.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realLoggerNs from "../utils/logger";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };
const realLogger = { ...realLoggerNs };

let enabledNodes: DockerNode[] = [];
let probeOutputByHost: Record<string, string> = {};
const execCommands: string[] = [];
const warnings: Array<{ message: string; context?: unknown }> = [];

mock.module("../utils/logger", () => ({
  ...realLogger,
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (message: string, context?: unknown) => {
      warnings.push({ message, context });
    },
  },
}));

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: () => Promise.resolve(enabledNodes),
    // Placement reads the placeable set; no node here is cordoned,
    // so it mirrors findEnabled.
    findPlaceable: () => Promise.resolve(enabledNodes),
    updateStatus: () => Promise.resolve(),
    rotateNodeHostKeyFingerprint: () => Promise.resolve(),
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: () => Promise.resolve(0),
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    // Positional signature, mirroring `sshClientForNode`:
    // getClient(hostname, sshPort, hostKeyFingerprint, sshUser, onFingerprint).
    getClient: (hostname: string) => ({
      connect: () => Promise.resolve(),
      exec: (command: string) => {
        execCommands.push(command);
        return Promise.resolve(probeOutputByHost[hostname] ?? "");
      },
    }),
  },
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
  mock.module("../utils/logger", () => realLogger);
});

import {
  admitsRequiredMemory,
  DockerNodeManager,
  parseNodeMemorySnapshot,
  readProbeSection,
} from "./docker-node-manager";

function node(nodeId: string, hostname: string): DockerNode {
  return {
    id: `${nodeId}-uuid`,
    node_id: nodeId,
    hostname,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: "SHA256:test",
    metadata: {},
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

/** A node that is alive and not IO-starved, so only memory can refuse it. */
const HEALTHY_PSI = [
  "some avg10=1.02 avg60=0.98 avg300=1.11 total=499893023295",
  "full avg10=0.87 avg60=0.79 avg300=0.81 total=457451749125",
].join("\n");

function meminfo(totalMib: number, availableMib: number): string {
  return [
    `MemTotal:       ${totalMib * 1024} kB`,
    `MemFree:         ${Math.floor((availableMib * 1024) / 2)} kB`,
    `MemAvailable:   ${availableMib * 1024} kB`,
    "Buffers:           81920 kB",
  ].join("\n");
}

/** `docker inspect -f '{{.HostConfig.Memory}}'` output: one byte count per line. */
function ceilings(...mib: number[]): string {
  return mib.map((value) => String(value * 1024 * 1024)).join("\n");
}

function probe(opts: { meminfo: string; ceilings: string; psi?: string }): string {
  return [
    "GH4Y:2NWO:testdockerid|x86_64",
    "---IO-PRESSURE---",
    opts.psi ?? HEALTHY_PSI,
    "---MEMINFO---",
    opts.meminfo,
    "---MEM-COMMITTED---",
    opts.ceilings,
  ].join("\n");
}

/** eliza-core-40661ddb / 2.28.17.235 at the moment it accepted the third agent. */
const STARVED_NODE_PROBE = probe({
  meminfo: meminfo(7745, 2058),
  ceilings: ceilings(3072, 3072),
});

/** 16 resident agents, each at the default 3072 MiB ceiling. */
const ROBOT_CEILINGS = ceilings(...Array.from({ length: 16 }, () => 3072));

/** eliza-staging-robot-1 / 88.99.66.168: 16 agents resident, zero OOM kills. */
const ROBOT_NODE_PROBE = probe({
  meminfo: meminfo(257626, 205913),
  ceilings: ROBOT_CEILINGS,
});

beforeEach(() => {
  enabledNodes = [];
  probeOutputByHost = {};
  execCommands.length = 0;
  warnings.length = 0;
});

describe("readProbeSection", () => {
  test("addresses sections by name, not by position", () => {
    const output = probe({
      meminfo: meminfo(7745, 2058),
      ceilings: ceilings(3072),
    });
    expect(readProbeSection(output, null).trim()).toBe("GH4Y:2NWO:testdockerid|x86_64");
    expect(readProbeSection(output, "---MEMINFO---")).toContain("MemTotal:       7930880 kB");
    expect(readProbeSection(output, "---MEM-COMMITTED---").trim()).toBe("3221225472");
  });

  test("returns empty for a section the probe did not emit", () => {
    const linesOnly = "GH4Y:2NWO:testdockerid|x86_64";
    expect(readProbeSection(linesOnly, "---MEMINFO---")).toBe("");
    expect(readProbeSection(linesOnly, null)).toBe(linesOnly);
  });
});

describe("parseNodeMemorySnapshot", () => {
  test("converts the measured node's meminfo and ceilings to MiB", () => {
    const snapshot = parseNodeMemorySnapshot(meminfo(7745, 2058), ceilings(3072, 3072));
    expect(snapshot).toEqual({
      memTotalMb: 7745,
      memAvailableMb: 2058,
      declaredCeilingMb: 6144,
    });
  });

  test("treats an unbounded container as declaring nothing", () => {
    const snapshot = parseNodeMemorySnapshot(meminfo(7745, 4398), "0\n0");
    expect(snapshot?.declaredCeilingMb).toBe(0);
  });

  test("returns null when the signal is absent or unreadable", () => {
    expect(parseNodeMemorySnapshot("", "")).toBeNull();
    expect(parseNodeMemorySnapshot("MemTotal:       7930880 kB", "")).toBeNull();
    expect(parseNodeMemorySnapshot("nonsense", "3221225472")).toBeNull();
  });
});

describe("admitsRequiredMemory", () => {
  test("admits one restore-sized agent and refuses a second even while the first is idle", () => {
    const empty = parseNodeMemorySnapshot(meminfo(7745, 7300), "");
    expect(admitsRequiredMemory(empty!, 6144).admitted).toBe(true);
    const occupied = parseNodeMemorySnapshot(meminfo(7745, 7300), ceilings(6144));
    expect(admitsRequiredMemory(occupied!, 6144).admitted).toBe(false);
    const busyHost = parseNodeMemorySnapshot(meminfo(7745, 6144), "");
    expect(admitsRequiredMemory(busyHost!, 6144).admitted).toBe(false);
  });

  test("refuses the placement that actually OOM-killed the fleet", () => {
    const snapshot = parseNodeMemorySnapshot(meminfo(7745, 2058), ceilings(3072, 3072));
    const verdict = admitsRequiredMemory(snapshot!, 3072);
    expect(verdict.admitted).toBe(false);
    // 2 x 3072 committed + 3072 requested = 9216 against a 7745 - 1024 budget.
    expect(verdict.effectiveCommittedMb).toBe(6144);
    expect(verdict.budgetMb).toBe(6721);
  });

  test("admits the 251 GiB robot that carried 16 agents with zero kills", () => {
    const snapshot = parseNodeMemorySnapshot(meminfo(257626, 205913), ROBOT_CEILINGS);
    expect(admitsRequiredMemory(snapshot!, 3072).admitted).toBe(true);
  });

  test("free memory alone would NOT have refused it — committed ceilings do", () => {
    // At selection time the node still had ~4.1 GiB free, which is why a
    // MemAvailable probe passes and the kernel kills seconds later. Same node,
    // same commitments, only the instantaneous free memory differs.
    const atSelection = parseNodeMemorySnapshot(meminfo(7745, 4198), ceilings(3072, 3072));
    expect(atSelection!.memAvailableMb).toBeGreaterThan(3072);
    expect(admitsRequiredMemory(atSelection!, 3072).admitted).toBe(false);
  });

  test("counts unbounded containers through used memory rather than free", () => {
    // Declares nothing, but occupies 7745 - 1000 = 6745 MiB.
    const crowded = parseNodeMemorySnapshot(meminfo(7745, 1000), "0\n0");
    expect(crowded!.declaredCeilingMb).toBe(0);
    const verdict = admitsRequiredMemory(crowded!, 3072);
    expect(verdict.effectiveCommittedMb).toBe(6745);
    expect(verdict.admitted).toBe(false);
  });

  test("admits a node whose unbounded containers leave real room", () => {
    const roomy = parseNodeMemorySnapshot(meminfo(7745, 4398), "0\n0");
    expect(admitsRequiredMemory(roomy!, 3072).admitted).toBe(true);
  });

  test("admits exactly at the budget and refuses one MiB past it", () => {
    const snapshot = parseNodeMemorySnapshot(meminfo(7745, 7745), ceilings(3649));
    expect(admitsRequiredMemory(snapshot!, 3072).admitted).toBe(true);
    const overBy1 = parseNodeMemorySnapshot(meminfo(7745, 7745), `${(3650 * 1024 + 1) * 1024}`);
    expect(admitsRequiredMemory(overBy1!, 3072).admitted).toBe(false);
  });
});

describe("ensureNodeReady memory gate", () => {
  test("refuses the starved node for placement", async () => {
    const target = node("eliza-core-40661ddb", "2.28.17.235");
    probeOutputByHost["2.28.17.235"] = STARVED_NODE_PROBE;

    const ready = await new DockerNodeManager().ensureNodeReady(target, {
      enforcePlacementIoPressure: true,
      requiredMemoryMb: 3072,
    });

    expect(ready).toBe(false);
  });

  test("admits the robot for the same request", async () => {
    const target = node("eliza-staging-robot-1", "88.99.66.168");
    probeOutputByHost["88.99.66.168"] = ROBOT_NODE_PROBE;

    const ready = await new DockerNodeManager().ensureNodeReady(target, {
      enforcePlacementIoPressure: true,
      requiredMemoryMb: 3072,
    });

    expect(ready).toBe(true);
  });

  test("does not probe memory when the caller states no requirement", async () => {
    const target = node("eliza-core-40661ddb", "2.28.17.235");
    probeOutputByHost["2.28.17.235"] = STARVED_NODE_PROBE;

    const ready = await new DockerNodeManager().ensureNodeReady(target, {
      enforcePlacementIoPressure: true,
    });

    // Liveness-only callers (sticky routing, autoscaler bootstrap) must keep
    // their old verdict, and must not pay for the extra commands.
    expect(ready).toBe(true);
    expect(execCommands.join("\n")).not.toContain("/proc/meminfo");
  });

  test("does not block when the node cannot report its memory, but says so", async () => {
    const target = node("eliza-core-40661ddb", "2.28.17.235");
    probeOutputByHost["2.28.17.235"] = probe({ meminfo: "", ceilings: "" });

    const ready = await new DockerNodeManager().ensureNodeReady(target, {
      enforcePlacementIoPressure: true,
      requiredMemoryMb: 3072,
    });

    expect(ready).toBe(true);
    // Admitting is deliberate, silence is not: this is the one branch that
    // restores pre-gate behaviour, so a probe regression that turns the gate
    // into a permanent no-op has to be visible in the logs and here.
    const skipped = warnings.find((entry) => entry.message.includes("Memory admission skipped"));
    expect(skipped).toBeDefined();
    expect(skipped?.context).toMatchObject({
      nodeId: "eliza-core-40661ddb",
      requiredMemoryMb: 3072,
    });
  });

  test("does not warn about a skip when the gate actually ran", async () => {
    const target = node("eliza-staging-robot-1", "88.99.66.168");
    probeOutputByHost["88.99.66.168"] = ROBOT_NODE_PROBE;

    await new DockerNodeManager().ensureNodeReady(target, {
      enforcePlacementIoPressure: true,
      requiredMemoryMb: 3072,
    });

    expect(
      warnings.filter((entry) => entry.message.includes("Memory admission skipped")),
    ).toHaveLength(0);
  });
});

describe("getAvailableNode", () => {
  test("skips the starved node and selects one that can hold the ceiling", async () => {
    const starved = node("eliza-core-40661ddb", "2.28.17.235");
    const robot = node("eliza-staging-robot-1", "88.99.66.168");
    enabledNodes = [starved, robot];
    probeOutputByHost["2.28.17.235"] = STARVED_NODE_PROBE;
    probeOutputByHost["88.99.66.168"] = ROBOT_NODE_PROBE;

    const selected = await new DockerNodeManager().getAvailableNode({
      requiredMemoryMb: 3072,
    });

    expect(selected?.node_id).toBe("eliza-staging-robot-1");
  });

  test("returns null when every node is oversubscribed", async () => {
    enabledNodes = [
      node("eliza-core-40661ddb", "2.28.17.235"),
      node("eliza-core-600f3d86", "162.55.170.116"),
    ];
    probeOutputByHost["2.28.17.235"] = STARVED_NODE_PROBE;
    // 4 x 3072 of ceilings on 7745 MiB, 466 MiB free: the fullest node measured.
    probeOutputByHost["162.55.170.116"] = probe({
      meminfo: meminfo(7745, 466),
      ceilings: ceilings(3072, 3072, 3072, 3072),
    });

    // Null is the contract: the caller falls through to autoscaling a node
    // rather than stacking another ceiling onto a box that cannot hold it.
    expect(
      await new DockerNodeManager().getAvailableNode({
        requiredMemoryMb: 3072,
      }),
    ).toBeNull();
  });

  test("still selects the starved node when no ceiling is requested", async () => {
    enabledNodes = [node("eliza-core-40661ddb", "2.28.17.235")];
    probeOutputByHost["2.28.17.235"] = STARVED_NODE_PROBE;

    const selected = await new DockerNodeManager().getAvailableNode({});

    expect(selected?.node_id).toBe("eliza-core-40661ddb");
  });
});
