// Exercises node autoscaler behavior with deterministic cloud-shared lib fixtures.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "../../../db/repositories/docker-nodes";

// Bun runs every cloud-shared test file in a single process, and `mock.module`
// overrides are process-global with no built-in per-file teardown. Without an
// explicit restore, these stubs leak into later files that import the real
// modules (e.g. `compute-provider-characterization.test.ts` reading
// `HetznerCloudError.status`), producing order-dependent failures. Capture the
// real modules up front and re-install them in `afterAll`.
import * as realDockerNodesNs from "../../../db/repositories/docker-nodes";
import * as realDockerNodeWorkloadsNs from "../docker-node-workloads";
import * as realHetznerCloudApiNs from "./hetzner-cloud-api";
import * as realNodeBootstrapNs from "./node-bootstrap";

// Snapshot the real exports into plain objects *before* the `mock.module` calls
// below run. The `import * as` namespaces are live bindings — once `mock.module`
// replaces a module record, the namespace reflects the stub — so we copy the
// exports eagerly at module-evaluation time (imports are hoisted above the
// `mock.module` statements) and restore from these snapshots in `afterAll`.
const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realHetznerCloudApi = { ...realHetznerCloudApiNs };
const realNodeBootstrap = { ...realNodeBootstrapNs };

const AGENT_IMAGE = "ELIZA_AGENT_IMAGE";
const AGENT_IMAGE_PLATFORM = "ELIZA_AGENT_IMAGE_PLATFORM";
const HCLOUD_NETWORK_IDS = "CONTAINERS_HCLOUD_NETWORK_IDS";
const HCLOUD_FIREWALL_IDS = "CONTAINERS_HCLOUD_FIREWALL_IDS";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

const mocks = {
  nodes: [] as DockerNode[],
  createNode: mock(),
  findAllNodes: mock(),
  createServer: mock(),
  getServer: mock(),
  listServers: mock(),
  deleteServer: mock(),
  isConfigured: mock(),
  buildUserData: mock(),
  countAllocated: mock(),
  countRetained: mock(),
  findByNodeId: mock(),
  updateNode: mock(),
  deleteNode: mock(),
};

mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findAll: mocks.findAllNodes,
    findByNodeId: mocks.findByNodeId,
    create: mocks.createNode,
    update: mocks.updateNode,
    delete: mocks.deleteNode,
  },
}));

mock.module("../docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mocks.countAllocated,
  countRetainedWorkloadsOnNode: mocks.countRetained,
}));

mock.module("./hetzner-cloud-api", () => ({
  HetznerCloudError: class HetznerCloudError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "HetznerCloudError";
    }
  },
  getHetznerCloudClient: () => ({
    listServers: mocks.listServers,
    getServer: mocks.getServer,
    createServer: mocks.createServer,
    deleteServer: mocks.deleteServer,
  }),
  isHetznerCloudConfigured: mocks.isConfigured,
}));

mock.module("./node-provision-authority", () => ({
  withNodeProvisionAuthority: async (
    _scope: string,
    operation: (authority: {
      nodes: DockerNode[];
      createNode: typeof mocks.createNode;
    }) => Promise<unknown>,
  ) => operation({ nodes: mocks.nodes, createNode: mocks.createNode }),
}));

mock.module("./node-bootstrap", () => ({
  buildContainerNodeUserData: mocks.buildUserData,
}));

afterAll(() => {
  mock.module("../../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("../docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./hetzner-cloud-api", () => realHetznerCloudApi);
  mock.module("./node-bootstrap", () => realNodeBootstrap);
});

import { InMemoryComputeProvider } from "./compute-provider-fake";
import { type AutoscalePolicy, NodeAutoscaler } from "./node-autoscaler";

const policy: AutoscalePolicy = {
  minFreeSlotsBuffer: 4,
  minHotAvailableSlots: 1,
  maxNodes: 4,
  scaleUpCooldownMs: 5 * 60 * 1000,
  idleNodeMinAgeMs: 30 * 60 * 1000,
  defaultServerType: "cax21",
  defaultLocation: "fsn1",
  defaultImage: "ubuntu-24.04",
  defaultCapacity: 8,
};

function typedHetznerNode(nodeId: string, serverId: number, hostname: string): DockerNode {
  return {
    id: `${nodeId}-row`,
    node_id: nodeId,
    hostname,
    ssh_port: 22,
    ssh_user: "root",
    capacity: 8,
    enabled: true,
    status: "unknown",
    allocated_count: 0,
    host_key_fingerprint: null,
    fleet_kind: "cloud",
    infrastructure_provider: "hetzner",
    provider_server_id: String(serverId),
    node_incarnation: null,
    metadata: {
      provider: "hetzner-cloud",
      autoscaled: true,
      hcloudServerId: serverId,
      environment: "local",
    },
    created_at: new Date("2026-05-15T12:00:00.000Z"),
    updated_at: new Date("2026-05-15T12:00:00.000Z"),
  };
}

describe("NodeAutoscaler Hetzner provisioning", () => {
  let originalAgentImage: string | undefined;
  let originalAgentImagePlatform: string | undefined;
  let originalHcloudNetworkIds: string | undefined;
  let originalHcloudFirewallIds: string | undefined;

  beforeEach(() => {
    originalAgentImage = process.env[AGENT_IMAGE];
    originalAgentImagePlatform = process.env[AGENT_IMAGE_PLATFORM];
    originalHcloudNetworkIds = process.env[HCLOUD_NETWORK_IDS];
    originalHcloudFirewallIds = process.env[HCLOUD_FIREWALL_IDS];
    process.env[AGENT_IMAGE] = "ghcr.io/elizaos/eliza:latest";
    process.env[AGENT_IMAGE_PLATFORM] = "linux/arm64";
    delete process.env[HCLOUD_NETWORK_IDS];
    process.env[HCLOUD_FIREWALL_IDS] = "8101,8102";
    mocks.createNode.mockClear();
    mocks.findAllNodes.mockClear();
    mocks.createServer.mockClear();
    mocks.getServer.mockClear();
    mocks.listServers.mockClear();
    mocks.deleteServer.mockClear();
    mocks.isConfigured.mockClear();
    mocks.buildUserData.mockClear();
    mocks.countAllocated.mockClear();
    mocks.countRetained.mockClear();
    mocks.nodes = [];
    mocks.findAllNodes.mockImplementation(() => Promise.resolve(mocks.nodes));
    mocks.countAllocated.mockResolvedValue(0);
    mocks.countRetained.mockResolvedValue(0);
    mocks.isConfigured.mockReturnValue(true);
    mocks.buildUserData.mockReturnValue("#cloud-config\n");
    mocks.createServer.mockResolvedValue({
      server: {
        id: 4242,
        name: "node-test",
        // The Hetzner client now collapses public_net onto the canonical seam
        // field; the autoscaler reads publicIpv4 (not provider-specific shapes).
        publicIpv4: "203.0.113.10",
        public_net: {
          ipv4: { ip: "203.0.113.10" },
          ipv6: null,
        },
      },
      rootPassword: "root-secret",
    });
    mocks.getServer.mockImplementation((serverId: number) => {
      if (serverId === 2020) {
        return Promise.resolve({
          id: 2020,
          name: "node-existing",
          status: "running",
          labels: {
            "managed-by": "eliza-cloud",
            "node-id": "node-existing",
            environment: "local",
            tier: "data-plane",
          },
          firewallAttachments: [
            { id: 8101, status: "applied" },
            { id: 8102, status: "applied" },
          ],
        });
      }
      const input = mocks.createServer.mock.calls.at(-1)?.[0] as
        | {
            name?: string;
            labels?: Record<string, string>;
            firewallIds?: number[];
          }
        | undefined;
      return Promise.resolve({
        id: serverId,
        name: input?.name ?? "created-server",
        status: "running",
        publicIpv4:
          serverId === 4242 ? "203.0.113.10" : serverId === 7777 ? "203.0.113.20" : "203.0.113.30",
        labels: input?.labels,
        firewallAttachments: (input?.firewallIds ?? []).map((id) => ({
          id,
          status: "applied",
        })),
      });
    });
    mocks.listServers.mockResolvedValue([]);
  });

  afterEach(() => {
    restoreEnv(AGENT_IMAGE, originalAgentImage);
    restoreEnv(AGENT_IMAGE_PLATFORM, originalAgentImagePlatform);
    restoreEnv(HCLOUD_NETWORK_IDS, originalHcloudNetworkIds);
    restoreEnv(HCLOUD_FIREWALL_IDS, originalHcloudFirewallIds);
  });

  test("creates a Hetzner server and registers the autoscaled docker node", async () => {
    const autoscaler = new NodeAutoscaler(policy, () => Date.parse("2026-05-15T12:00:00Z"));

    const result = await autoscaler.provisionNode(
      {
        nodeId: "node-test",
        capacity: 6,
        labels: { purpose: "onboarding-e2e" },
        prePullImages: ["ghcr.io/elizaos/eliza:test"],
      },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    expect(mocks.buildUserData).toHaveBeenCalledWith({
      nodeId: "node-test",
      controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
      registrationUrl: "https://cloud.example.test/register",
      registrationSecret: "secret",
      prePullImages: ["ghcr.io/elizaos/eliza:test"],
      prePullPlatform: "linux/arm64",
      capacity: 6,
    });
    expect(mocks.createServer).toHaveBeenCalledWith({
      name: "node-test",
      serverType: "cax21",
      location: "fsn1",
      image: "ubuntu-24.04",
      userData: "#cloud-config\n",
      networkIds: [],
      firewallIds: [8101, 8102],
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-test",
        environment: "local",
        tier: "data-plane",
        purpose: "onboarding-e2e",
      },
    });
    expect(mocks.createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "node-test",
        hostname: "203.0.113.10",
        capacity: 0,
        enabled: true,
        status: "unknown",
        ssh_user: "root",
        fleet_kind: "cloud",
        infrastructure_provider: "hetzner",
        provider_server_id: "4242",
        node_incarnation: null,
        metadata: expect.objectContaining({
          provider: "hetzner-cloud",
          autoscaled: true,
          capacityProvisional: true,
          capacityRequested: 6,
          capacityPolicyFallback: 8,
          hcloudServerId: 4242,
          serverType: "cax21",
          location: "fsn1",
          image: "ubuntu-24.04",
          architecture: "arm64",
        }),
      }),
    );
    expect(result).toEqual({
      nodeId: "node-test",
      hostname: "203.0.113.10",
      hcloudServerId: 4242,
      rootPassword: "root-secret",
      idempotent: false,
    });
  });

  test("returns the authoritative DB row for an idempotent retry", async () => {
    mocks.nodes = [typedHetznerNode("node-existing", 2020, "203.0.113.20")];
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-existing" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).resolves.toMatchObject({
      nodeId: "node-existing",
      hcloudServerId: 2020,
      idempotent: true,
    });
    expect(mocks.getServer).toHaveBeenCalledWith(2020);
    expect(mocks.listServers).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("fails closed when the Hetzner firewall set is absent", async () => {
    delete process.env[HCLOUD_FIREWALL_IDS];
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-unfenced" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.listServers).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test.each(["8101,garbage", "8101,8101", "0", "1.5"])(
    "fails closed on ambiguous Hetzner firewall configuration %s",
    async (value) => {
      process.env[HCLOUD_FIREWALL_IDS] = value;
      const autoscaler = new NodeAutoscaler(policy);

      await expect(
        autoscaler.provisionNode(
          { nodeId: "node-bad-firewall-config" },
          {
            controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
            registrationUrl: "https://cloud.example.test/register",
            registrationSecret: "secret",
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(mocks.listServers).not.toHaveBeenCalled();
      expect(mocks.createServer).not.toHaveBeenCalled();
    },
  );

  test("rejects firewall drift on an authoritative DB/provider node", async () => {
    mocks.nodes = [typedHetznerNode("node-drifted", 2020, "203.0.113.21")];
    mocks.getServer.mockResolvedValueOnce({
      id: 2020,
      name: "node-drifted",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-drifted",
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [{ id: 8101, status: "applied" }],
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-drifted" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();
  });

  test("rejects provider label drift on an authoritative DB node", async () => {
    mocks.nodes = [typedHetznerNode("node-label-drifted", 2020, "203.0.113.23")];
    mocks.getServer.mockResolvedValueOnce({
      id: 2020,
      name: "node-label-drifted",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "different-node",
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [
        { id: 8101, status: "applied" },
        { id: 8102, status: "applied" },
      ],
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-label-drifted" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("rejects an ambiguous provider firewall attachment state", async () => {
    mocks.nodes = [typedHetznerNode("node-firewall-pending", 2020, "203.0.113.24")];
    mocks.getServer.mockResolvedValueOnce({
      id: 2020,
      name: "node-firewall-pending",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-firewall-pending",
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [
        { id: 8101, status: "applied" },
        { id: 8102, status: "pending" },
      ],
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-firewall-pending" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("rejects a provider firewall attachment with missing state", async () => {
    mocks.nodes = [typedHetznerNode("node-firewall-missing-state", 2021, "203.0.113.25")];
    mocks.getServer.mockResolvedValueOnce({
      id: 2021,
      name: "node-firewall-missing-state",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-firewall-missing-state",
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [{ id: 8101 }, { id: 8102, status: "applied" }],
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-firewall-missing-state" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("rejects an orphaned DB node instead of creating a replacement by name", async () => {
    mocks.nodes = [typedHetznerNode("node-provider-missing", 2020, "203.0.113.22")];
    mocks.getServer.mockResolvedValueOnce(null);
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-provider-missing" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("rejects firewall drift before adopting a provider-only node", async () => {
    mocks.listServers.mockResolvedValueOnce([
      {
        id: 3030,
        name: "node-provider-only",
        status: "running",
        labels: {
          "managed-by": "eliza-cloud",
          "node-id": "node-provider-only",
          environment: "local",
          tier: "data-plane",
        },
        firewallAttachments: [{ id: 9999, status: "applied" }],
      },
    ]);
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-provider-only" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();
  });

  test("fails closed on a same-name provider server without exact allocation labels", async () => {
    mocks.listServers.mockResolvedValueOnce([
      {
        id: 3031,
        name: "node-name-only",
        status: "running",
        labels: {
          "managed-by": "eliza-cloud",
          environment: "local",
          tier: "data-plane",
        },
        firewallAttachments: [
          { id: 8101, status: "applied" },
          { id: 8102, status: "applied" },
        ],
      },
    ]);
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-name-only" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("same-name Hetzner server");

    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("fails closed on multiple provider allocations for one node label", async () => {
    mocks.listServers.mockResolvedValueOnce(
      [3031, 3032].map((id) => ({
        id,
        name: `node-duplicate-${id}`,
        status: "running",
        labels: {
          "managed-by": "eliza-cloud",
          "node-id": "node-duplicate",
          environment: "local",
          tier: "data-plane",
        },
        firewallAttachments: [
          { id: 8101, status: "applied" },
          { id: 8102, status: "applied" },
        ],
      })),
    );
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-duplicate" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("multiple Hetzner allocations");
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("enforces the provider/environment node quota before create", async () => {
    mocks.listServers.mockResolvedValue(
      Array.from({ length: policy.maxNodes }, (_, index) => ({
        id: 1000 + index,
        name: `provider-node-${index}`,
        status: "running",
        labels: {
          "managed-by": "eliza-cloud",
          environment: "local",
          tier: "data-plane",
        },
      })),
    );
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-over-quota" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("does not charge a different provider's DB rows to the selected provider", async () => {
    mocks.nodes = Array.from(
      { length: policy.maxNodes },
      (_, index) =>
        ({
          node_id: `digitalocean-node-${index}`,
          hostname: `198.51.100.${index + 1}`,
          capacity: policy.defaultCapacity,
          metadata: {
            provider: "digitalocean",
            environment: "local",
            hcloudServerId: 5000 + index,
          },
        }) as DockerNode,
    );
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "hetzner-provider-isolated" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).resolves.toMatchObject({ idempotent: false });
    expect(mocks.createServer).toHaveBeenCalledTimes(1);
  });

  test("deletes a newly-created provider server when DB registration fails", async () => {
    mocks.createNode.mockRejectedValueOnce(new Error("database unavailable"));
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-compensate" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("database unavailable");
    expect(mocks.deleteServer).toHaveBeenCalledWith(4242);
  });

  test.each([
    ["wrong firewall set", { firewallAttachments: [{ id: 9999, status: "applied" }] }],
    [
      "missing firewall attachment state",
      { firewallAttachments: [{ id: 8101 }, { id: 8102, status: "applied" }] },
    ],
  ])("cleans up a new server when authoritative read-back has %s", async (_label, override) => {
    mocks.getServer.mockResolvedValueOnce({
      id: 4242,
      name: "node-readback-rejected",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-readback-rejected",
        environment: "local",
        tier: "data-plane",
      },
      ...override,
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-readback-rejected" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.deleteServer).toHaveBeenCalledWith(4242);
  });

  test.each([
    ["missing read", null],
    ["empty attachment read", { firewallAttachments: [] }],
    [
      "pending attachment read",
      {
        firewallAttachments: [
          { id: 8101, status: "applied" },
          { id: 8102, status: "pending" },
        ],
      },
    ],
  ])("waits for %s to converge before node registration", async (_label, firstRead) => {
    const sleepCalls: number[] = [];
    mocks.getServer.mockResolvedValueOnce(
      firstRead === null
        ? null
        : {
            id: 4242,
            name: "node-settling",
            status: "running",
            labels: {
              "managed-by": "eliza-cloud",
              "node-id": "node-settling",
              environment: "local",
              tier: "data-plane",
            },
            ...firstRead,
          },
    );
    const autoscaler = new NodeAutoscaler(
      policy,
      () => Date.parse("2026-05-15T12:00:00Z"),
      undefined,
      async (delayMs) => {
        sleepCalls.push(delayMs);
      },
    );

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-settling" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).resolves.toMatchObject({ hcloudServerId: 4242 });
    expect(mocks.getServer).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([1_000]);
    expect(mocks.createNode).toHaveBeenCalledTimes(1);
    expect(mocks.deleteServer).not.toHaveBeenCalled();
  });

  test("deletes only the created ID after bounded perpetual pending state", async () => {
    const sleepCalls: number[] = [];
    mocks.getServer.mockResolvedValue({
      id: 4242,
      name: "node-never-settles",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-never-settles",
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [
        { id: 8101, status: "applied" },
        { id: 8102, status: "pending" },
      ],
    });
    const autoscaler = new NodeAutoscaler(
      policy,
      () => 0,
      undefined,
      async (delayMs) => {
        sleepCalls.push(delayMs);
      },
    );

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-never-settles" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("did not reach the authoritative firewall state after 5 reads");
    expect(mocks.getServer).toHaveBeenCalledTimes(5);
    expect(sleepCalls).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.deleteServer).toHaveBeenCalledTimes(1);
    expect(mocks.deleteServer).toHaveBeenCalledWith(4242);
  });

  test("rejects a mismatched read-back ID and fences cleanup to the created ID", async () => {
    mocks.getServer.mockResolvedValueOnce({
      id: 9999,
      name: "node-id-mismatch",
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-id-mismatch",
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [
        { id: 8101, status: "applied" },
        { id: 8102, status: "applied" },
      ],
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-id-mismatch" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("returned server 9999 for requested server 4242");
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.deleteServer).toHaveBeenCalledTimes(1);
    expect(mocks.deleteServer).toHaveBeenCalledWith(4242);
    expect(mocks.deleteServer).not.toHaveBeenCalledWith(9999);
  });

  test("rejects a non-canonical created ID before provider read or destructive cleanup", async () => {
    mocks.createServer.mockResolvedValueOnce({
      server: {
        id: "004242",
        name: "node-invalid-created-id",
        publicIpv4: "203.0.113.10",
      },
      rootPassword: "root-secret",
    });
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-invalid-created-id" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("does not have a canonical positive Hetzner server ID");
    expect(mocks.getServer).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.deleteServer).not.toHaveBeenCalled();
  });

  test("cleans up a new server when the authoritative read-back fails", async () => {
    mocks.getServer.mockRejectedValueOnce(new Error("provider read failed"));
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-readback-failed" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toThrow("provider read failed");
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.deleteServer).toHaveBeenCalledWith(4242);
  });

  test("persists a fail-closed provisional row while preserving an absent override", async () => {
    const autoscaler = new NodeAutoscaler(policy);

    await autoscaler.provisionNode(
      { nodeId: "node-derived" },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    expect(mocks.buildUserData).toHaveBeenCalledWith(
      expect.not.objectContaining({ capacity: expect.anything() }),
    );
    expect(mocks.createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        capacity: 0,
        metadata: expect.objectContaining({
          capacityProvisional: true,
          capacityRequested: null,
          capacityPolicyFallback: 8,
        }),
      }),
    );
  });

  test("charges provisional capacity reservations against the atomic budget", async () => {
    mocks.nodes = Array.from(
      { length: policy.maxNodes - 1 },
      (_, index) =>
        ({
          node_id: `booting-${index}`,
          hostname: `203.0.113.${index + 20}`,
          capacity: 0,
          metadata: {
            provider: "hetzner-cloud",
            environment: "local",
            hcloudServerId: 6000 + index,
            capacityProvisional: true,
            capacityRequested: null,
            capacityPolicyFallback: policy.defaultCapacity,
          },
        }) as DockerNode,
    );
    mocks.listServers.mockResolvedValue(
      mocks.nodes.map((node) => ({
        id: (node.metadata as Record<string, unknown>).hcloudServerId as number,
        name: node.node_id,
        status: "running",
        labels: {
          "managed-by": "eliza-cloud",
          environment: "local",
          tier: "data-plane",
        },
      })),
    );
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "capacity-over-budget", capacity: policy.defaultCapacity + 1 },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  test("passes configured Hetzner private network ids to new nodes", async () => {
    process.env[HCLOUD_NETWORK_IDS] = "12305703";
    const autoscaler = new NodeAutoscaler(policy);

    await autoscaler.provisionNode(
      { nodeId: "node-networked" },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "node-networked",
        networkIds: [12305703],
      }),
    );
  });

  test("fails before calling hcloud when Hetzner is not configured", async () => {
    mocks.isConfigured.mockReturnValue(false);
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-test" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({
      code: "missing_token",
    });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();
  });

  test("generates an eliza-core-<8hex> nodeId when none is supplied", async () => {
    const autoscaler = new NodeAutoscaler(policy);
    mocks.createServer.mockResolvedValue({
      server: {
        id: 7777,
        name: "generated",
        public_net: { ipv4: { ip: "203.0.113.20" }, ipv6: null },
      },
      rootPassword: null,
    });

    const result = await autoscaler.provisionNode(
      {},
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    const idPattern = /^eliza-core-[0-9a-f]{8}$/;
    expect(result.nodeId).toMatch(idPattern);
    expect(mocks.buildUserData.mock.calls[0]?.[0]?.nodeId).toBe(result.nodeId);
    expect(mocks.createServer.mock.calls[0]?.[0]?.name).toBe(result.nodeId);
    expect(mocks.createServer.mock.calls[0]?.[0]?.labels?.["node-id"]).toBe(result.nodeId);
    expect(mocks.createNode.mock.calls[0]?.[0]?.node_id).toBe(result.nodeId);
  });

  test("generated nodeIds are unique across repeated provisions", async () => {
    const autoscaler = new NodeAutoscaler(policy);
    const seen = new Set<string>();
    const N = 50;

    for (let i = 0; i < N; i++) {
      mocks.createNode.mockClear();
      mocks.createServer.mockResolvedValue({
        server: {
          id: 8000 + i,
          name: "generated",
          public_net: { ipv4: { ip: "203.0.113.30" }, ipv6: null },
        },
        rootPassword: null,
      });
      const result = await autoscaler.provisionNode(
        {},
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      );
      expect(result.nodeId).toMatch(/^eliza-core-[0-9a-f]{8}$/);
      seen.add(result.nodeId);
    }

    expect(seen.size).toBe(N);
  });

  test("scales up when there is no healthy compatible capacity", async () => {
    const autoscaler = new NodeAutoscaler(policy);

    await expect(autoscaler.evaluateCapacity()).resolves.toMatchObject({
      totalCapacity: 0,
      totalAllocated: 0,
      totalAvailable: 0,
      enabledNodeCount: 0,
      healthyNodeCount: 0,
      shouldScaleUp: true,
      reason: "available 0 < hot floor 1",
    });
  });

  // #8919: the autoscaler resolves its provider via the ComputeProvider seam, so
  // a fake can be injected directly — no monkey-patching of getHetznerCloudClient.
  test("provisions through an injected ComputeProvider without monkey-patching (#8919)", async () => {
    const fake = new InMemoryComputeProvider({ serverActivateAfterTicks: 0 });
    const autoscaler = new NodeAutoscaler(policy, () => Date.parse("2026-05-15T12:00:00Z"), fake);

    const result = await autoscaler.provisionNode(
      { nodeId: "seam-node", capacity: 4, prePullImages: [] },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    // The injected fake handled createServer — the module-mocked Hetzner client
    // was bypassed entirely.
    expect(mocks.createServer).not.toHaveBeenCalled();
    const servers = await fake.listServers();
    expect(servers.some((s) => s.name === "seam-node")).toBe(true);

    // The docker node is registered with the seam's canonical publicIpv4
    // (the fake assigns 10.0.0.<id> once active), not a provider-specific shape.
    expect(result.nodeId).toBe("seam-node");
    expect(result.hostname).toMatch(/^10\.0\.0\./);
    expect(mocks.createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "seam-node",
        hostname: result.hostname,
      }),
    );
  });
});

describe("NodeAutoscaler full provision\u2192healthy\u2192drain loop (#8920)", () => {
  const CREATED_AT = Date.parse("2026-05-15T12:00:00Z");
  // 1h after creation \u2192 safely past scaleUpCooldownMs (5m) and idleNodeMinAgeMs (30m).
  const NOW = CREATED_AT + 60 * 60 * 1000;
  let store: DockerNode[];
  let idSeq: number;
  let originalAgentImage: string | undefined;
  let originalAgentImagePlatform: string | undefined;
  let originalHcloudFirewallIds: string | undefined;

  beforeEach(() => {
    originalAgentImage = process.env[AGENT_IMAGE];
    originalAgentImagePlatform = process.env[AGENT_IMAGE_PLATFORM];
    originalHcloudFirewallIds = process.env[HCLOUD_FIREWALL_IDS];
    process.env[AGENT_IMAGE] = "ghcr.io/elizaos/eliza:latest";
    process.env[AGENT_IMAGE_PLATFORM] = "linux/arm64";
    process.env[HCLOUD_FIREWALL_IDS] = "8101,8102";
    store = [];
    idSeq = 1;
    mocks.buildUserData.mockReturnValue("#cloud-config\n");
    mocks.countAllocated.mockResolvedValue(0);
    mocks.countRetained.mockResolvedValue(0);
    mocks.isConfigured.mockReturnValue(true);
    mocks.findAllNodes.mockImplementation(() => Promise.resolve(store.slice()));
    mocks.findByNodeId.mockImplementation((nodeId: string) =>
      Promise.resolve(store.find((n) => n.node_id === nodeId) ?? null),
    );
    mocks.createNode.mockImplementation((row: Partial<DockerNode>) => {
      const node = {
        id: `db-${idSeq++}`,
        created_at: new Date(CREATED_AT),
        updated_at: new Date(CREATED_AT),
        ...row,
      } as DockerNode;
      store.push(node);
      return Promise.resolve(node);
    });
    mocks.updateNode.mockImplementation((id: string, patch: Partial<DockerNode>) => {
      const node = store.find((n) => n.id === id);
      if (node) Object.assign(node, patch);
      return Promise.resolve(true);
    });
    mocks.deleteNode.mockImplementation((id: string) => {
      const idx = store.findIndex((n) => n.id === id);
      if (idx >= 0) store.splice(idx, 1);
      return Promise.resolve(true);
    });
  });

  afterEach(() => {
    restoreEnv(AGENT_IMAGE, originalAgentImage);
    restoreEnv(AGENT_IMAGE_PLATFORM, originalAgentImagePlatform);
    restoreEnv(HCLOUD_FIREWALL_IDS, originalHcloudFirewallIds);
    mocks.createNode.mockReset();
    mocks.findAllNodes.mockReset();
    mocks.findByNodeId.mockReset();
    mocks.updateNode.mockReset();
    mocks.deleteNode.mockReset();
  });

  test("drives provision \u2192 healthy \u2192 drain against an injected ComputeProvider + stateful docker_nodes", async () => {
    const fake = new InMemoryComputeProvider({ serverActivateAfterTicks: 1 });
    const autoscaler = new NodeAutoscaler(policy, () => NOW, fake);

    // 1. Empty pool \u2192 the loop wants to scale up.
    const empty = await autoscaler.evaluateCapacity();
    expect(empty.healthyNodeCount).toBe(0);
    expect(empty.shouldScaleUp).toBe(true);

    // 2. Provision. The injected fake handles createServer (the module-mocked
    //    Hetzner client stays untouched); the row lands in `unknown` status.
    const provisioned = await autoscaler.provisionNode(
      { nodeId: "loop-node", capacity: 8, prePullImages: [] },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
    expect(store[0].status).toBe("unknown");
    const serverId = provisioned.hcloudServerId as number;
    expect(serverId).toBeGreaterThan(0);
    expect((await fake.getServer(serverId))?.status).toBe("new");

    // 3. An `unknown` node contributes no healthy capacity yet \u2192 still scaling up.
    const booting = await autoscaler.evaluateCapacity();
    expect(booting.healthyNodeCount).toBe(0);
    expect(booting.shouldScaleUp).toBe(true);

    // 4. The server boots (tick advances the action clock), its bootstrap
    //    callback consumes the provisional-capacity marker, and the periodic
    //    health check flips the docker_nodes row to `healthy`.
    fake.tick(1);
    expect((await fake.getServer(serverId))?.status).toBe("active");
    delete store[0].metadata.capacityProvisional;
    store[0].capacity = 8;
    store[0].status = "healthy";

    // 5. The node now serves its full capacity \u2192 no more scale-up.
    const healthy = await autoscaler.evaluateCapacity();
    expect(healthy.healthyNodeCount).toBe(1);
    expect(healthy.totalCapacity).toBe(8);
    expect(healthy.shouldScaleUp).toBe(false);

    // 6. Drain + deprovision: the node leaves the pool and the underlying server
    //    is destroyed through the same seam.
    await autoscaler.drainNode("loop-node", { deprovision: true });
    expect(store).toHaveLength(0);
    expect(await fake.getServer(serverId)).toBeNull();

    // 7. Back to an empty pool \u2192 the loop is ready to scale up again.
    const drained = await autoscaler.evaluateCapacity();
    expect(drained.healthyNodeCount).toBe(0);
    expect(drained.shouldScaleUp).toBe(true);
  });

  test.each([
    {
      name: "zero spare capacity",
      buffer: 0,
      hot: 0,
      allocated: 0,
      retained: 0,
      young: false,
      managed: true,
      drain: true,
    },
    {
      name: "nonzero buffer",
      buffer: 1,
      hot: 0,
      allocated: 0,
      retained: 0,
      young: false,
      managed: true,
      drain: false,
    },
    {
      name: "nonzero hot floor",
      buffer: 0,
      hot: 1,
      allocated: 0,
      retained: 0,
      young: false,
      managed: true,
      drain: false,
    },
    {
      name: "allocated workload",
      buffer: 0,
      hot: 0,
      allocated: 1,
      retained: 0,
      young: false,
      managed: true,
      drain: false,
    },
    {
      name: "retained workload",
      buffer: 0,
      hot: 0,
      allocated: 0,
      retained: 1,
      young: false,
      managed: true,
      drain: false,
    },
    {
      name: "recently created node",
      buffer: 0,
      hot: 0,
      allocated: 0,
      retained: 0,
      young: true,
      managed: true,
      drain: false,
    },
    {
      name: "operator managed node",
      buffer: 0,
      hot: 0,
      allocated: 0,
      retained: 0,
      young: false,
      managed: false,
      drain: false,
    },
  ])("final node capacity policy: $name", async (scenario) => {
    const fake = new InMemoryComputeProvider({ serverActivateAfterTicks: 0 });
    const autoscaler = new NodeAutoscaler(
      {
        ...policy,
        minFreeSlotsBuffer: scenario.buffer,
        minHotAvailableSlots: scenario.hot,
      },
      () => NOW,
      fake,
    );
    const provisioned = await autoscaler.provisionNode(
      { nodeId: "final-node", capacity: 8, prePullImages: [] },
      { controlPlanePublicKey: "ssh-ed25519 AAAAcontrol" },
    );
    delete store[0].metadata.capacityProvisional;
    store[0].metadata.autoscaled = scenario.managed;
    store[0].capacity = 8;
    store[0].status = "healthy";
    if (scenario.young) store[0].created_at = new Date(NOW);
    mocks.countAllocated.mockResolvedValue(scenario.allocated);
    mocks.countRetained.mockResolvedValue(scenario.retained);

    const decision = await autoscaler.evaluateCapacity();
    expect(decision.shouldScaleUp).toBe(false);
    expect(decision.shouldScaleDownNodeIds).toEqual(scenario.drain ? ["final-node"] : []);
    expect(await fake.getServer(provisioned.hcloudServerId)).not.toBeNull();
    if (scenario.drain) {
      await autoscaler.drainNode(decision.shouldScaleDownNodeIds[0], { deprovision: true });
      expect(store).toHaveLength(0);
      expect(await fake.getServer(provisioned.hcloudServerId)).toBeNull();
      expect(await autoscaler.evaluateCapacity()).toMatchObject({
        healthyNodeCount: 0,
        shouldScaleUp: false,
        shouldScaleDownNodeIds: [],
      });
    } else {
      expect(store).toHaveLength(1);
    }
  });
});
