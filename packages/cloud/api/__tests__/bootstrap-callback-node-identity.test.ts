/**
 * Route tests for the docker-node bootstrap-callback identity guard (#12876).
 *
 * Exercises the re-bootstrap rule on the EXISTING-node branch: a client cannot
 * rewrite a node's SSH identity (hostname/ssh_user/ssh_port) via the shared
 * bootstrap secret alone; only a request presenting the pinned host key
 * fingerprint may change it. Uses a deterministic in-memory repository stub —
 * the guard is pure route logic, so no DB is needed to prove the behavior.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as dockerNodesActual from "@/db/repositories/docker-nodes";
import * as hetznerAttestationActual from "@/lib/services/containers/hetzner-node-attestation";
import * as loggerActual from "@/lib/utils/logger";

interface StoredNode {
  id: string;
  node_id: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  capacity: number;
  host_key_fingerprint: string | null;
  node_incarnation: string | null;
  status: string;
  fleet_kind?: "cloud" | null;
  infrastructure_provider?: "hetzner" | null;
  provider_server_id?: string | null;
  metadata: Record<string, unknown>;
}

const EXISTING: StoredNode = {
  id: "node-row-1",
  node_id: "node-1",
  hostname: "10.0.0.1",
  ssh_port: 22,
  ssh_user: "root",
  capacity: 8,
  host_key_fingerprint: "SHA256:pinned-fingerprint",
  node_incarnation: "00000000-0000-4000-8000-000000000001",
  status: "healthy",
  metadata: { provider: "operator-provisioned" },
};

let stored: StoredNode | null = EXISTING;
let lastUpdateArg: Partial<StoredNode> | null = null;
let lastReconcileArg: {
  data: Partial<StoredNode>;
  metadataPatch: Record<string, unknown>;
} | null = null;

const mockFindByNodeId = mock(async (_nodeId: string) => stored);
const mockUpdate = mock(async (_id: string, data: Partial<StoredNode>) => {
  lastUpdateArg = data;
  if (!stored) return null;
  stored = { ...stored, ...data };
  return stored;
});
const mockCreate = mock(async (data: StoredNode) => {
  stored = { ...data, id: "node-row-new" };
  return stored;
});
const mockRotateNodeHostKeyFingerprint = mock(
  async (input: {
    expectedFingerprint: string | null;
    observedFingerprint: string | null;
  }) => {
    if (!stored || stored.host_key_fingerprint !== input.expectedFingerprint) {
      throw new Error("stale host-key rotation");
    }
    stored = {
      ...stored,
      host_key_fingerprint: input.observedFingerprint,
      node_incarnation: null,
    };
    return stored;
  },
);
const mockReconcileProvisionalCapacity = mock(
  async (
    _id: string,
    data: Partial<StoredNode>,
    metadataPatch: Record<string, unknown>,
  ) => {
    lastReconcileArg = { data, metadataPatch };
    if (stored?.metadata.capacityProvisional !== true) return null;
    const metadata = { ...stored.metadata, ...metadataPatch };
    delete metadata.capacityProvisional;
    stored = { ...stored, ...data, metadata };
    return stored;
  },
);
const mockAttestHetznerCloudNode = mock(async () => ({
  serverId: 4242,
  server: { id: 4242 },
}));

mock.module("@/db/repositories/docker-nodes", () => ({
  ...dockerNodesActual,
  dockerNodesRepository: {
    ...dockerNodesActual.dockerNodesRepository,
    findByNodeId: mockFindByNodeId,
    update: mockUpdate,
    create: mockCreate,
    rotateNodeHostKeyFingerprint: mockRotateNodeHostKeyFingerprint,
    reconcileProvisionalCapacity: mockReconcileProvisionalCapacity,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

mock.module("@/lib/services/containers/hetzner-node-attestation", () => ({
  ...hetznerAttestationActual,
  attestHetznerCloudNode: mockAttestHetznerCloudNode,
}));

afterAll(() => {
  mock.module(
    "@/lib/services/containers/hetzner-node-attestation",
    () => hetznerAttestationActual,
  );
});

const BOOTSTRAP_SECRET = "test-bootstrap-secret";
process.env.CONTAINERS_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;

const { default: app } = await import(
  "../v1/admin/docker-nodes/bootstrap-callback/route"
);

async function post(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bootstrap-secret": BOOTSTRAP_SECRET,
      },
      body: JSON.stringify(body),
    }),
  );
}

function useProvisionalAutoscaledNode(requestedCapacity: number | null): void {
  stored = {
    ...EXISTING,
    capacity: 0,
    host_key_fingerprint: null,
    node_incarnation: null,
    fleet_kind: "cloud",
    infrastructure_provider: "hetzner",
    provider_server_id: "4242",
    metadata: {
      provider: "hetzner-cloud",
      autoscaled: true,
      environment: "local",
      capacityProvisional: true,
      capacityRequested: requestedCapacity,
      capacityPolicyFallback: 8,
    },
  };
}

describe("bootstrap-callback node-identity guard (#12876)", () => {
  beforeEach(() => {
    stored = { ...EXISTING, metadata: { ...EXISTING.metadata } };
    lastUpdateArg = null;
    lastReconcileArg = null;
    mockUpdate.mockClear();
    mockCreate.mockClear();
    mockFindByNodeId.mockClear();
    mockRotateNodeHostKeyFingerprint.mockClear();
    mockReconcileProvisionalCapacity.mockClear();
    mockAttestHetznerCloudNode.mockReset();
    mockAttestHetznerCloudNode.mockResolvedValue({
      serverId: 4242,
      server: { id: 4242 },
    });
  });

  test("rejects hostname mutation on existing node without the required fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.6.6.6", // attacker-controlled MITM host
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("Validation failed");

    // The SSH identity must NOT have been written.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.hostname).toBe("10.0.0.1");
    expect(stored?.ssh_user).toBe("root");
    expect(stored?.ssh_port).toBe(22);
  });

  test("rejects ssh_user mutation without a matching fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "attacker",
      hostKeyFingerprint: "SHA256:wrong-fingerprint",
    });

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.ssh_user).toBe("root");
  });

  test("rejects ssh_port mutation without a matching fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshPort: 2222,
      hostKeyFingerprint: "SHA256:wrong-fingerprint",
    });

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.ssh_port).toBe(22);
  });

  test("rejects identity mutation when the node has no pinned fingerprint at all", async () => {
    stored = {
      ...EXISTING,
      host_key_fingerprint: null,
      metadata: { ...EXISTING.metadata },
    };

    const res = await post({
      nodeId: "node-1",
      hostname: "10.6.6.6",
      hostKeyFingerprint: "SHA256:anything",
    });

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.hostname).toBe("10.0.0.1");
  });

  test("allows first host-key pin on an existing autoscaler placeholder when identity is unchanged", async () => {
    stored = {
      ...EXISTING,
      host_key_fingerprint: null,
      metadata: { provider: "hetzner-cloud", autoscaled: true },
    };

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockRotateNodeHostKeyFingerprint).toHaveBeenCalledWith({
      id: EXISTING.id,
      nodeId: EXISTING.node_id,
      expectedFingerprint: null,
      observedFingerprint: "SHA256:first-real-pin",
    });
    expect(lastUpdateArg).not.toHaveProperty("host_key_fingerprint");
    expect(stored?.host_key_fingerprint).toBe("SHA256:first-real-pin");
    expect(stored?.node_incarnation).toBeNull();
  });

  test("allows identity mutation with a matching pinned fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.9",
      sshUser: "deploy",
      sshPort: 2200,
      hostKeyFingerprint: "SHA256:pinned-fingerprint",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(lastUpdateArg?.hostname).toBe("10.0.0.9");
    expect(lastUpdateArg?.ssh_user).toBe("deploy");
    expect(lastUpdateArg?.ssh_port).toBe(2200);
  });

  test("liveness re-bootstrap with unchanged identity succeeds with the matching fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      capacity: 16,
      hostKeyFingerprint: "SHA256:pinned-fingerprint",
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // Identity preserved. Capacity is operator-owned once the row exists, so a
    // re-bootstrap must NOT write it — the request value is ignored here.
    expect(lastUpdateArg?.hostname).toBe("10.0.0.1");
    expect(lastUpdateArg?.ssh_user).toBe("root");
    expect(lastUpdateArg?.ssh_port).toBe(22);
    expect(lastUpdateArg).not.toHaveProperty("capacity");
  });

  test("re-bootstrap preserves an operator-tuned capacity (does not reset to the request/default)", async () => {
    // A 252 GB robot the operator hand-tuned to 24 slots via a direct DB write.
    stored = { ...EXISTING, capacity: 24, metadata: { ...EXISTING.metadata } };

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      // Callback reports the small-box default; it must not clobber the tune.
      capacity: 8,
      hostKeyFingerprint: "SHA256:pinned-fingerprint",
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(lastUpdateArg).not.toHaveProperty("capacity");
    expect(stored?.capacity).toBe(24);
  });

  test("does not promote provisional capacity when live Hetzner authority fails", async () => {
    useProvisionalAutoscaledNode(null);
    mockAttestHetznerCloudNode.mockRejectedValueOnce(
      new Error("provider firewall authority drifted"),
    );

    const response = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 32_768,
      vCpuCount: 8,
      hostKeyFingerprint: "SHA256:new-node-key",
    });

    expect(response.status).toBe(500);
    expect(mockAttestHetznerCloudNode).toHaveBeenCalledTimes(1);
    expect(mockReconcileProvisionalCapacity).not.toHaveBeenCalled();
    expect(mockRotateNodeHostKeyFingerprint).not.toHaveBeenCalled();
    expect(stored?.capacity).toBe(0);
    expect(stored?.metadata.capacityProvisional).toBe(true);
  });

  test("reconciles the small autoscaled default row to hardware capacity exactly once", async () => {
    useProvisionalAutoscaledNode(null);

    const first = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 7745,
      vCpuCount: 4,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(first.status).toBe(200);
    expect(mockReconcileProvisionalCapacity).toHaveBeenCalledTimes(1);
    expect(lastReconcileArg?.data.capacity).toBeGreaterThan(0);
    expect(lastReconcileArg?.data.capacity).toBeLessThan(EXISTING.capacity);
    expect(lastReconcileArg?.metadataPatch).toMatchObject({
      memTotalMb: 7745,
      vCpuCount: 4,
      capacityBoundBy: "memory",
      capacityDerivedFromMemory: true,
    });
    expect(stored?.capacity).toBe(lastReconcileArg?.data.capacity);
    expect(stored?.metadata.capacityProvisional).toBeUndefined();

    stored = { ...stored!, capacity: 5 };
    const repeat = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 257626,
      vCpuCount: 12,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(repeat.status).toBe(200);
    expect(mockReconcileProvisionalCapacity).toHaveBeenCalledTimes(1);
    expect(stored?.capacity).toBe(5);
  });

  test("derives 11 slots for a large autoscaled node with no override", async () => {
    useProvisionalAutoscaledNode(null);

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 257626,
      vCpuCount: 12,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(res.status).toBe(200);
    expect(stored?.capacity).toBe(11);
  });

  test("preserves an explicit capacity when attested hardware supports it", async () => {
    useProvisionalAutoscaledNode(8);

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      capacity: 8,
      memTotalMb: 257626,
      vCpuCount: 12,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(res.status).toBe(200);
    expect(stored?.capacity).toBe(8);
    expect(lastReconcileArg?.metadataPatch.capacityDerivedFromMemory).toBe(
      false,
    );
  });

  test("represents insufficient attested hardware with zero usable slots", async () => {
    useProvisionalAutoscaledNode(null);

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 2048,
      vCpuCount: 2,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(res.status).toBe(200);
    expect(stored?.capacity).toBe(0);
    expect(stored?.metadata.capacityProvisional).toBeUndefined();
  });

  test("fails closed when hardware would derive beyond the callback capacity contract", async () => {
    useProvisionalAutoscaledNode(null);

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 1_000_000,
      vCpuCount: 512,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(res.status).toBe(422);
    expect(mockReconcileProvisionalCapacity).not.toHaveBeenCalled();
    expect(stored?.capacity).toBe(0);
    expect(stored?.metadata.capacityProvisional).toBe(true);
  });

  test("rejects missing or overflowing hardware without consuming the provisional marker", async () => {
    useProvisionalAutoscaledNode(null);

    const missing = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 7745,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });
    expect(missing.status).toBe(422);

    const overflow = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      memTotalMb: 16_777_217,
      vCpuCount: 4,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });
    expect(overflow.status).toBe(400);
    expect(mockReconcileProvisionalCapacity).not.toHaveBeenCalled();
    expect(stored?.metadata.capacityProvisional).toBe(true);
  });

  test("brand-new node still gets its capacity stamped from the request", async () => {
    stored = null; // findByNodeId returns null → insert path
    let createdCapacity: number | undefined;
    mockCreate.mockImplementationOnce(async (data: StoredNode) => {
      createdCapacity = data.capacity;
      stored = { ...data, id: "node-row-new" };
      return stored;
    });

    const res = await post({
      nodeId: "node-3",
      hostname: "10.0.0.60",
      sshUser: "root",
      sshPort: 22,
      capacity: 24,
      hostKeyFingerprint: "SHA256:new-node",
    });

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(createdCapacity).toBe(24);
  });

  test("rejects liveness re-bootstrap without the required pinned fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
    });

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("rejects host-key fingerprint mutation even when SSH identity is unchanged", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      hostKeyFingerprint: "SHA256:attacker-first-pin",
    });

    expect(res.status).toBe(409);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("Host key fingerprint");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.host_key_fingerprint).toBe("SHA256:pinned-fingerprint");
  });

  test("first bootstrap of a brand-new node still creates the row", async () => {
    stored = null; // findByNodeId returns null → insert path

    const res = await post({
      nodeId: "node-2",
      hostname: "10.0.0.50",
      sshUser: "root",
      sshPort: 22,
      hostKeyFingerprint: "SHA256:new-node",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { action: string } };
    expect(json.data.action).toBe("created");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("rejects unauthorized requests (bad secret) before any DB access", async () => {
    const res = await app.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "wrong-secret",
        },
        body: JSON.stringify({ nodeId: "node-1", hostname: "10.6.6.6" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(mockFindByNodeId).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
