/**
 * Tests for the provisioning job LANES — the split that lets a dedicated
 * apps-control daemon claim only the `apps` lane (CONTAINER_* / APP_*) while the
 * agent control-plane worker keeps the `agent` lane, both sharing one `jobs`
 * table. Two properties matter most:
 *
 *   1. COMPLETENESS — every JOB_TYPES value belongs to exactly one lane. A type
 *      in NEITHER lane would be silently un-claimable by any scoped daemon
 *      (stuck pending forever); a type in BOTH would be double-claimed.
 *   2. FAIL-OPEN — an empty/garbage `PROVISIONING_JOB_LANES` resolves to ALL
 *      types (the historical single-daemon behavior), never to "claim nothing".
 */

import { describe, expect, test } from "bun:test";

import {
  AGENT_JOB_TYPES,
  AGENT_LIFECYCLE_JOB_METADATA,
  APPS_JOB_TYPES,
  COLD_BOOT_JOB_TYPES,
  COLD_BOOT_STALE_JOB_THRESHOLD_MS,
  CONTAINER_BACKED_TARGET_AGENT_JOB_TYPES,
  EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES,
  JOB_TYPES,
  ORPHAN_PENDING_THRESHOLD_MS,
  PROVISIONING_RECONCILIATION_BATCH_SIZE,
  PROVISIONING_STATUS_OWNER_JOB_TYPES,
  type ProvisioningJobType,
  requiresContainerBackedTarget,
  resolveJobTypesForLanes,
  STUCK_PROVISIONING_RECONCILIATION_GRACE_MS,
  STUCK_PROVISIONING_THRESHOLD_MS,
} from "./provisioning-job-types";

const ALL = Object.values(JOB_TYPES) as ProvisioningJobType[];

describe("provisioning status ownership", () => {
  test("derives every lifecycle safety set from the canonical metadata", () => {
    expect(AGENT_JOB_TYPES).toEqual(AGENT_LIFECYCLE_JOB_METADATA.map(({ type }) => type));
    expect([...PROVISIONING_STATUS_OWNER_JOB_TYPES]).toEqual(
      AGENT_LIFECYCLE_JOB_METADATA.filter(
        ({ ownsProvisioningStatus }) => ownsProvisioningStatus,
      ).map(({ type }) => type),
    );
    expect(EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES).toEqual(
      AGENT_LIFECYCLE_JOB_METADATA.filter(({ exclusive }) => exclusive).map(({ type }) => type),
    );
    expect([...COLD_BOOT_JOB_TYPES]).toEqual(
      AGENT_LIFECYCLE_JOB_METADATA.filter(({ coldBoot }) => coldBoot).map(({ type }) => type),
    );
  });

  test("classifies primary-row owners separately from replacement boots", () => {
    expect(PROVISIONING_STATUS_OWNER_JOB_TYPES).toEqual(
      new Set([
        JOB_TYPES.AGENT_PROVISION,
        JOB_TYPES.AGENT_RESUME,
        JOB_TYPES.AGENT_RESTART,
        JOB_TYPES.AGENT_WAKE,
      ]),
    );
    expect(PROVISIONING_STATUS_OWNER_JOB_TYPES.has(JOB_TYPES.AGENT_UPGRADE)).toBe(false);
    expect(PROVISIONING_STATUS_OWNER_JOB_TYPES.has(JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE)).toBe(false);
    expect(PROVISIONING_STATUS_OWNER_JOB_TYPES.has(JOB_TYPES.AGENT_DOWNGRADE)).toBe(false);
  });
});

describe("container-backed target admission", () => {
  test("derives the worker and enqueue classification from lifecycle metadata", () => {
    expect([...CONTAINER_BACKED_TARGET_AGENT_JOB_TYPES]).toEqual(
      AGENT_LIFECYCLE_JOB_METADATA.filter(({ requiresContainerBackedTarget }) =>
        Boolean(requiresContainerBackedTarget),
      ).map(({ type }) => type),
    );
  });

  test("requires a container for lifecycle operations and prepaid host renewal", () => {
    const required = [
      JOB_TYPES.AGENT_COMPUTE_LEASE,
      JOB_TYPES.AGENT_PROVISION,
      JOB_TYPES.AGENT_SUSPEND,
      JOB_TYPES.AGENT_RESUME,
      JOB_TYPES.AGENT_SLEEP,
      JOB_TYPES.AGENT_WAKE,
      JOB_TYPES.AGENT_RESTART,
      JOB_TYPES.AGENT_UPGRADE,
      JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      JOB_TYPES.AGENT_DOWNGRADE,
      JOB_TYPES.AGENT_LOGS,
      JOB_TYPES.AGENT_SNAPSHOT,
    ];

    expect(new Set(CONTAINER_BACKED_TARGET_AGENT_JOB_TYPES)).toEqual(new Set(required));
    for (const jobType of required) {
      expect(requiresContainerBackedTarget(jobType)).toBe(true);
    }
    expect(requiresContainerBackedTarget(JOB_TYPES.AGENT_MESSAGE)).toBe(false);
    expect(requiresContainerBackedTarget(JOB_TYPES.AGENT_DELETE)).toBe(false);
  });
});

describe("lifecycle timing invariants", () => {
  test("stuck reconciliation derives from the cold-boot budget plus explicit grace", () => {
    expect(STUCK_PROVISIONING_THRESHOLD_MS).toBe(
      COLD_BOOT_STALE_JOB_THRESHOLD_MS + STUCK_PROVISIONING_RECONCILIATION_GRACE_MS,
    );
    expect(STUCK_PROVISIONING_RECONCILIATION_GRACE_MS).toBeGreaterThan(0);
    expect(STUCK_PROVISIONING_THRESHOLD_MS).toBeGreaterThan(COLD_BOOT_STALE_JOB_THRESHOLD_MS);
  });

  test("orphan recovery is independent and every reconciliation scan is bounded", () => {
    expect(ORPHAN_PENDING_THRESHOLD_MS).toBeLessThan(STUCK_PROVISIONING_THRESHOLD_MS);
    expect(PROVISIONING_RECONCILIATION_BATCH_SIZE).toBeGreaterThan(0);
    expect(PROVISIONING_RECONCILIATION_BATCH_SIZE).toBeLessThanOrEqual(500);
  });
});

describe("job lanes — completeness invariant", () => {
  test("agent ∪ apps covers EVERY job type (none orphaned)", () => {
    const union = new Set<ProvisioningJobType>([...AGENT_JOB_TYPES, ...APPS_JOB_TYPES]);
    const missing = ALL.filter((t) => !union.has(t));
    expect(missing).toEqual([]);
    expect(union.size).toBe(ALL.length);
  });

  test("agent and apps lanes are DISJOINT (no type double-claimed)", () => {
    const apps = new Set<ProvisioningJobType>(APPS_JOB_TYPES);
    const overlap = AGENT_JOB_TYPES.filter((t) => apps.has(t));
    expect(overlap).toEqual([]);
  });

  test("apps lane is exactly the CONTAINER_* + APP_* rows", () => {
    expect([...APPS_JOB_TYPES].sort()).toEqual(
      [
        JOB_TYPES.CONTAINER_PROVISION,
        JOB_TYPES.CONTAINER_DELETE,
        JOB_TYPES.CONTAINER_STOP,
        JOB_TYPES.CONTAINER_RESTART,
        JOB_TYPES.CONTAINER_UPGRADE,
        JOB_TYPES.CONTAINER_LOGS,
        JOB_TYPES.APP_DEPLOY,
        JOB_TYPES.APP_DB_DEPROVISION,
        JOB_TYPES.APP_CACHE_INVALIDATE,
      ].sort(),
    );
  });

  test("no AGENT_* type leaked into the apps lane", () => {
    const leaked = (APPS_JOB_TYPES as readonly string[]).filter((t) => t.startsWith("agent_"));
    expect(leaked).toEqual([]);
  });
});

describe("resolveJobTypesForLanes — fail-open to ALL", () => {
  test.each([undefined, null, "", "   ", ",", " , "])("%p → all types", (spec) => {
    expect(resolveJobTypesForLanes(spec as string | null | undefined)).toEqual(ALL);
  });

  test("an unrecognized lane name → all types (never claim nothing)", () => {
    expect(resolveJobTypesForLanes("bogus")).toEqual(ALL);
    expect(resolveJobTypesForLanes("agentz,appz")).toEqual(ALL);
  });

  // Prototype keys must NOT be treated as lanes: a lowercase `Object.prototype`
  // key (`constructor`, `__proto__`) reaches the lane gate unchanged, and an
  // `in` check would let it through and then throw on `for (… of JOB_LANES[k])`.
  // A spec made of only such keys must fail open to ALL, never crash the daemon.
  test.each(["constructor", "__proto__", "valueof,hasownproperty", "tostring"])(
    "prototype-key-only spec %p → all types (no throw)",
    (spec) => {
      expect(resolveJobTypesForLanes(spec)).toEqual(ALL);
    },
  );

  // A real lane alongside a prototype key resolves to just the real lane — the
  // prototype key is ignored, not crashed on, not promoted to "all".
  test("'agent,constructor' → exactly the agent lane (proto key ignored)", () => {
    expect(new Set(resolveJobTypesForLanes("agent,constructor"))).toEqual(new Set(AGENT_JOB_TYPES));
  });
});

describe("resolveJobTypesForLanes — scoping", () => {
  test("'apps' → exactly the apps lane", () => {
    expect(new Set(resolveJobTypesForLanes("apps"))).toEqual(new Set(APPS_JOB_TYPES));
  });

  test("'agent' → exactly the agent lane", () => {
    expect(new Set(resolveJobTypesForLanes("agent"))).toEqual(new Set(AGENT_JOB_TYPES));
  });

  test("'agent,apps' → all types (both lanes)", () => {
    expect(new Set(resolveJobTypesForLanes("agent,apps"))).toEqual(new Set(ALL));
    // order-independent
    expect(new Set(resolveJobTypesForLanes("apps,agent"))).toEqual(new Set(ALL));
  });

  test("case-insensitive + whitespace tolerant", () => {
    expect(new Set(resolveJobTypesForLanes(" APPS "))).toEqual(new Set(APPS_JOB_TYPES));
    expect(new Set(resolveJobTypesForLanes("Agent , Apps"))).toEqual(new Set(ALL));
  });

  test("a recognized lane alongside garbage → just the recognized lane", () => {
    expect(new Set(resolveJobTypesForLanes("bogus,apps"))).toEqual(new Set(APPS_JOB_TYPES));
  });

  test("preserves JOB_TYPES declaration order", () => {
    const apps = resolveJobTypesForLanes("apps");
    const appsInDeclOrder = ALL.filter((t) => (APPS_JOB_TYPES as readonly string[]).includes(t));
    expect(apps).toEqual(appsInDeclOrder);
  });
});
