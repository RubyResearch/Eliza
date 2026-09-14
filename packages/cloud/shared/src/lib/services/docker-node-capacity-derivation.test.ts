/**
 * Capacity derived from what a node actually is: RAM and CPU.
 *
 * Capacity was a slot counter stamped from one global env var, unrelated to the
 * machine, and it is wrong in both directions — both measured on the fleet on
 * 2026-08-12. It licensed 4 x 3072 MiB of ceilings onto 7745 MiB / 4 vCPU boxes
 * (the global OOM the admission gate closed), and it would hand a
 * 257626 MiB / 12 vCPU robot the blind default of 8.
 *
 * The dimensions disagree, which is why the minimum exists: the robot carries
 * ~21 GiB of RAM per core against the cloud box's ~1.9, so sizing it on memory
 * alone would over-subscribe its CPU roughly sevenfold. IO is absent on
 * purpose — it is transient and already enforced by the placement PSI gate.
 *
 * Deterministic and dependency-free: the decision is pure functions, so these
 * fixtures are the real hosts.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_VCPU_BUDGET,
  deriveNodeCapacity,
  HOST_RESERVE_MB,
  HOST_RESERVE_VCPU,
  resolveNodeCapacity,
} from "./docker-node-manager";

/** The staging cloud boxes that OOM-killed booting agents. */
const CLOUD_NODE_MB = 7745;
/** eliza-staging-robot-1 and its five siblings. */
const ROBOT_NODE_MB = 257626;
/** The historical per-agent ceiling in the measured overcommit incident. */
const AGENT_MB = 3072;

/** Measured vCPU: the cloud boxes are 4-core, the robots 12-core. */
const CLOUD_VCPU = 4;
const ROBOT_VCPU = 12;

const base = {
  agentMemoryLimitMb: AGENT_MB,
  fallbackCapacity: 8,
};

describe("deriveNodeCapacity", () => {
  test("fits one restore-sized agent on the paid 8 GiB node without consuming the host reserve", () => {
    const result = resolveNodeCapacity({
      requestedCapacity: 1,
      memTotalMb: CLOUD_NODE_MB,
      vCpuCount: 2,
      agentMemoryLimitMb: 6144,
      fallbackCapacity: 8,
    });
    expect(result.capacity).toBe(1);
    expect(result.capacity * 6144 + HOST_RESERVE_MB).toBeLessThanOrEqual(CLOUD_NODE_MB);
    expect(
      resolveNodeCapacity({
        requestedCapacity: 4,
        memTotalMb: CLOUD_NODE_MB,
        vCpuCount: CLOUD_VCPU,
        agentMemoryLimitMb: 6144,
        fallbackCapacity: 8,
      }),
    ).toMatchObject({ capacity: 1, clampedFrom: 4, boundBy: "memory" });
  });

  test("sizes the measured cloud box at 2 slots, bound by memory", () => {
    // memory (7745-1024)/3072 = 2 ; cpu (4-1)/1 = 3 -> memory binds
    const d = deriveNodeCapacity({
      memTotalMb: CLOUD_NODE_MB,
      vCpuCount: CLOUD_VCPU,
      agentMemoryLimitMb: AGENT_MB,
    });
    expect(d).toEqual({ capacity: 2, byMemory: 2, byCpu: 3, boundBy: "memory" });
  });

  test("sizes the robot by CPU, not by its 251 GiB of RAM", () => {
    // The whole reason the minimum exists: memory alone would say 83.
    const d = deriveNodeCapacity({
      memTotalMb: ROBOT_NODE_MB,
      vCpuCount: ROBOT_VCPU,
      agentMemoryLimitMb: AGENT_MB,
    });
    expect(d.byMemory).toBe(83);
    expect(d.byCpu).toBe(11);
    expect(d.capacity).toBe(11);
    expect(d.boundBy).toBe("cpu");
  });

  test("sizing the robot on memory alone would over-subscribe its CPU sevenfold", () => {
    const d = deriveNodeCapacity({
      memTotalMb: ROBOT_NODE_MB,
      vCpuCount: ROBOT_VCPU,
      agentMemoryLimitMb: AGENT_MB,
    });
    expect(d.byMemory! / d.byCpu!).toBeGreaterThan(7);
  });

  test("uses the same memory reserve as the admission gate", () => {
    const d = deriveNodeCapacity({
      memTotalMb: CLOUD_NODE_MB,
      vCpuCount: 64,
      agentMemoryLimitMb: AGENT_MB,
    });
    expect(d.byMemory! * AGENT_MB).toBeLessThanOrEqual(CLOUD_NODE_MB - HOST_RESERVE_MB);
  });

  test("keeps a core for the host", () => {
    const d = deriveNodeCapacity({
      memTotalMb: ROBOT_NODE_MB,
      vCpuCount: ROBOT_VCPU,
      agentMemoryLimitMb: AGENT_MB,
    });
    expect(d.byCpu).toBe((ROBOT_VCPU - HOST_RESERVE_VCPU) / DEFAULT_AGENT_VCPU_BUDGET);
  });

  test("sizes on whichever dimension it knows when the other is absent", () => {
    expect(
      deriveNodeCapacity({ memTotalMb: CLOUD_NODE_MB, agentMemoryLimitMb: AGENT_MB }),
    ).toMatchObject({ capacity: 2, byCpu: null, boundBy: "memory" });
    expect(
      deriveNodeCapacity({ vCpuCount: ROBOT_VCPU, agentMemoryLimitMb: AGENT_MB }),
    ).toMatchObject({ capacity: 11, byMemory: null, boundBy: "cpu" });
  });

  test("reports unknown rather than guessing when it knows nothing", () => {
    const d = deriveNodeCapacity({ agentMemoryLimitMb: AGENT_MB });
    expect(d.boundBy).toBe("unknown");
    expect(d.byMemory).toBeNull();
    expect(d.byCpu).toBeNull();
  });

  test("reports zero when the configured agent cannot fit after the host reserve", () => {
    expect(
      deriveNodeCapacity({ memTotalMb: 2048, vCpuCount: 2, agentMemoryLimitMb: AGENT_MB }).capacity,
    ).toBe(0);
    expect(
      deriveNodeCapacity({ memTotalMb: 512, vCpuCount: 8, agentMemoryLimitMb: AGENT_MB }),
    ).toMatchObject({ capacity: 0, byMemory: 0, boundBy: "memory" });
  });
});

describe("resolveNodeCapacity", () => {
  test("derives when the caller states no capacity — what makes a robot usable", () => {
    const r = resolveNodeCapacity({ ...base, memTotalMb: ROBOT_NODE_MB, vCpuCount: ROBOT_VCPU });
    expect(r).toEqual({ capacity: 11, derived: true, boundBy: "cpu" });
  });

  test("clamps the exact staging misconfiguration and says what it cut", () => {
    const r = resolveNodeCapacity({
      ...base,
      requestedCapacity: 4,
      memTotalMb: CLOUD_NODE_MB,
      vCpuCount: CLOUD_VCPU,
    });
    expect(r).toEqual({ capacity: 2, derived: false, clampedFrom: 4, boundBy: "memory" });
  });

  test("never raises an operator's explicit choice", () => {
    const r = resolveNodeCapacity({
      ...base,
      requestedCapacity: 8,
      memTotalMb: ROBOT_NODE_MB,
      vCpuCount: ROBOT_VCPU,
    });
    expect(r.capacity).toBe(8);
    expect(r.derived).toBe(false);
  });

  test("leaves an explicit capacity alone when the machine is unknown", () => {
    expect(resolveNodeCapacity({ ...base, requestedCapacity: 16 })).toMatchObject({
      capacity: 16,
      derived: false,
    });
  });

  test("falls back only with neither a request nor any hardware fact", () => {
    expect(resolveNodeCapacity(base)).toMatchObject({ capacity: 8, derived: false });
  });

  test("treats a nonsensical request as absent rather than honouring it", () => {
    const r = resolveNodeCapacity({
      ...base,
      requestedCapacity: 0,
      memTotalMb: ROBOT_NODE_MB,
      vCpuCount: ROBOT_VCPU,
    });
    expect(r).toEqual({ capacity: 11, derived: true, boundBy: "cpu" });
  });

  test("clamps an explicit request to zero when known hardware cannot hold one agent", () => {
    expect(
      resolveNodeCapacity({
        ...base,
        requestedCapacity: 8,
        memTotalMb: 2048,
        vCpuCount: 2,
      }),
    ).toEqual({ capacity: 0, derived: false, clampedFrom: 8, boundBy: "memory" });
  });
});
