/** Exercises sandbox upgrade contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */
import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { DockerNode } from "../../../db/repositories/docker-nodes";
import { type SandboxProvider } from "../sandbox-provider-types";
import { customSandbox, fetchUrl, sqlBoundParams } from "./test-support/fixtures.js";
import { replacementAwareProvider } from "./test-support/provider.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
  sandboxTransactions,
  UpgradeTx,
} from "./test-support/database.js";
import { installReplacementLifecycleSimulation } from "./test-support/replacement.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

let restoreDatabase: (() => void) | undefined;
let restoreReplacement: (() => void) | undefined;
let billing: ReturnType<typeof installSandboxBillingSimulation>;
beforeAll(async () => {
  restoreDatabase = installSandboxDatabaseSimulation();
  restoreReplacement = await installReplacementLifecycleSimulation();
  billing = installSandboxBillingSimulation();
});
afterAll(() => {
  billing.restore();
  restoreReplacement?.();
  restoreDatabase?.();
});
// LARP H3 — executeUpgrade() blue/green rollback, digest-mismatch, and the
// compare-and-swap race guard that protects a LIVE billed agent row.
// The provider MUST be a real DockerSandboxProvider instance (the method bails
// with "only supported on docker provider" otherwise), so we construct one and
// override its methods with spies — `instanceof DockerSandboxProvider` stays
// true. Blue metadata is a genuine DockerSandboxMetadata so the real
// isDockerSandboxMetadata() guard passes. The swap runs inside
// dbWrite.transaction(); we drive it via sandboxTransactions.implementation + spies on the
// private lockLifecycle / getAgentForLifecycleMutation seams.
describe("ElizaSandboxService.executeUpgrade blue/green rollback + CAS guard (LARP H3)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const OWNER = "33333333-3333-4333-8333-333333333333";
  const DOCKER_IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
  const FROM_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000aaa";
  const TO_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111bbb";

  function runtimeStatusResponse(
    body: Record<string, unknown> = {
      state: "running",
      canRespond: true,
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function runtimeHealthResponse(
    body: Record<string, unknown> = {
      ready: true,
      canRespond: true,
      runtime: "ok",
      database: "ok",
      plugins: { loaded: 18, failed: 0 },
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  // A live fleet-managed agent: running, with an old node/container, and
  // docker_image === null so the "custom image" guard does not reject it.
  function liveAgentRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      sandbox_id: "sandbox-old-1",
      node_id: "node-old",
      container_name: "agent-old-1",
      bridge_url: "https://old-bridge.example",
      health_url: "https://old-bridge.example/health",
      docker_image: null,
      image_digest: FROM_DIGEST,
    };
  }

  function oldNode(): DockerNode {
    return {
      node_id: "node-old",
      hostname: "node-old.internal",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: null,
      allocated_count: 1,
    } as unknown as DockerNode;
  }

  // A genuine DockerSandboxMetadata for blue — isDockerSandboxMetadata() passes.
  function blueMetadata(imageDigest: string | null, previousVpnNodeId?: string) {
    return {
      provider: "docker" as const,
      nodeId: "node-new",
      hostname: "node-new.internal",
      containerName: "agent-new-1",
      bridgePort: 21080,
      webUiPort: 23950,
      agentId: AGENT,
      volumePath: "/var/lib/eliza/agent-new-1",
      dockerImage: DOCKER_IMAGE,
      imageDigest,
      ...(previousVpnNodeId ? { previousVpnNodeId } : {}),
    };
  }

  function blueHandle(imageDigest: string | null, previousVpnNodeId?: string) {
    return {
      sandboxId: "sandbox-new-1",
      bridgeUrl: "https://new-bridge.example",
      healthUrl: "https://new-bridge.example/health",
      metadata: blueMetadata(imageDigest, previousVpnNodeId),
    };
  }

  // Build a real DockerSandboxProvider whose I/O methods are spies so
  // `provider instanceof DockerSandboxProvider` holds in executeUpgrade().
  async function makeDockerProvider(overrides: {
    create: () => Promise<unknown>;
    checkHealth: () => Promise<boolean>;
  }) {
    // Import WITHOUT `?actual` so this class identity matches the one
    // executeUpgrade() resolves via its own `await import("./docker-sandbox-provider")`
    // (no `?actual`) — otherwise `provider instanceof DockerSandboxProvider` is false.
    const { DockerSandboxProvider } = await import("../docker-sandbox-provider");
    const provider = new DockerSandboxProvider();
    const create = mock(overrides.create);
    const checkHealth = mock(overrides.checkHealth);
    const stop = mock(async () => {});
    const stopOnSpecificNode = mock(async () => {});
    Object.assign(provider, {
      create,
      checkHealth,
      stop,
      stopOnSpecificNodeForReplacement: stopOnSpecificNode,
    });
    replacementAwareProvider(provider as unknown as SandboxProvider);
    const runtimeFetch = mock(async (input: RequestInfo | URL, _init?: RequestInit) =>
      fetchUrl(input).endsWith("/api/status") ? runtimeStatusResponse() : runtimeHealthResponse(),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;
    return {
      provider: provider as unknown as SandboxProvider,
      create,
      checkHealth,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
    };
  }

  afterEach(() => {
    sandboxTransactions.implementation = null;
  });

  test.each(["upgrade", "downgrade"] as const)(
    "%s without replacement funding preserves the running agent",
    async (operation) => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const { DockerSandboxProvider } = await import("../docker-sandbox-provider");
      const { dockerNodeManager } = await import("../docker-node-manager");
      const { DockerSSHClient } = await import("../docker-ssh");
      const agent = { ...liveAgentRow(), previous_image_digest: TO_DIGEST };
      const originalAgent = structuredClone(agent);
      const provider = new DockerSandboxProvider();
      const spies = [
        spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(agent),
        spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode()),
      ];
      const selectNode = spyOn(dockerNodeManager, "getAvailableNode");
      const ssh = spyOn(DockerSSHClient, "getClient");
      const stop = spyOn(provider, "stop");
      const retire = spyOn(provider, "stopOnSpecificNodeForReplacement");
      let cutoverAttempted = false;
      sandboxTransactions.implementation = async () => {
        cutoverAttempted = true;
        throw new Error("Unfunded replacement cannot reach cutover");
      };
      try {
        const service = new ElizaSandboxService(provider);
        const result =
          operation === "upgrade"
            ? await service.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST)
            : await service.executeDowngrade(AGENT, ORG, DOCKER_IMAGE, FROM_DIGEST);
        expect(result).toMatchObject({
          success: false,
          oldNodeId: "node-old",
          oldContainerName: "agent-old-1",
        });
        if (operation === "upgrade") expect(result.rolledBack).toBe(true);
        expect(result.error).toContain("requires committed runtime funding");
        expect(agent).toEqual(originalAgent);
        expect(cutoverAttempted).toBe(false);
        for (const effect of [selectNode, ssh, stop, retire]) expect(effect).not.toHaveBeenCalled();
      } finally {
        for (const spy of [...spies, selectNode, ssh, stop, retire]) spy.mockRestore();
      }
    },
  );

  test("a pending warm-claim credential fence blocks blue provisioning", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = {
      ...liveAgentRow(),
      claimed_at: new Date("2026-07-23T00:00:00.000Z"),
      warm_claim_credential_state: "pending" as const,
      warm_claim_source_pool_id: "44444444-4444-4444-8444-444444444444",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId");
    try {
      const res = await new ElizaSandboxService().executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res).toMatchObject({
        success: false,
        rolledBack: true,
        error: "Warm-claim credential handoff is not ready",
      });
      expect(nodeSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(a) blue health-check FAILS → blue torn down, row stays on OLD, rolled-back error", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => false, // blue never comes up
    });
    // A swap must NOT be attempted on a failed health check.
    let transactionCalled = false;
    sandboxTransactions.implementation = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await new ElizaSandboxService(provider).executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("kept agent on old container");
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // The unhealthy blue is retired through the durable placement locator.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      // ...and the live row is never swapped.
      expect(transactionCalled).toBe(false);
      expect(res.oldNodeId).toBe("node-old");
      expect(res.oldContainerName).toBe("agent-old-1");
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(b) blue digest MISMATCH → blue torn down, NO swap", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const WRONG_DIGEST = "sha256:dededededededededededededededededededededededededededededede0000";
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(WRONG_DIGEST), // healthy but wrong image
      checkHealth: async () => true,
    });
    let transactionCalled = false;
    sandboxTransactions.implementation = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await new ElizaSandboxService(provider).executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("digest mismatch");
      expect(res.error).toContain(TO_DIGEST);
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // Serving the WRONG image would silently ship an unintended build — retire
      // the exact durable blue placement and never target the live sandbox.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      // No swap of the live row.
      expect(transactionCalled).toBe(false);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(b2) blue runtime readiness gate FAILS → blue torn down, NO snapshot or swap", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const runtimeFetch = mock(async (input: RequestInfo | URL) =>
      fetchUrl(input).endsWith("/api/status")
        ? runtimeStatusResponse()
        : runtimeHealthResponse({
            ready: false,
            canRespond: false,
            runtime: "ok",
            database: "ok",
            plugins: { loaded: 17, failed: 1 },
            agentState: "starting",
            startup: { phase: "error", attempt: 1, lastError: "migration failed" },
          }),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;
    const svc = new ElizaSandboxService(provider);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    let transactionCalled = false;
    sandboxTransactions.implementation = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Blue runtime readiness gate failed");
      expect(res.error).toContain("ready=false");
      expect(res.error).toContain("canRespond=false");
      expect(res.error).toContain("plugins.failed=1");
      expect(res.error).toContain("migration failed");
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://new-bridge.example/api/status",
        "https://new-bridge.example/api/health",
      ]);
      expect(snapshotSpy).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  }, 20_000);

  for (const missing of ["plugins", "startup"] as const) {
    test(`upgrade runtime readiness fails closed when ${missing} structure is missing`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const agent = liveAgentRow();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        agent,
      );
      const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
      const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
        create: async () => blueHandle(TO_DIGEST),
        checkHealth: async () => true,
      });
      const runtimeFetch = mock(async (input: RequestInfo | URL) =>
        fetchUrl(input).endsWith("/api/status")
          ? runtimeStatusResponse()
          : runtimeHealthResponse({
              ready: true,
              runtime: "ok",
              database: "ok",
              ...(missing === "plugins" ? {} : { plugins: { loaded: 18, failed: 0 } }),
              ...(missing === "startup" ? {} : { startup: { phase: "running", attempt: 0 } }),
            }),
      );
      globalThis.fetch = runtimeFetch as unknown as typeof fetch;
      const svc = new ElizaSandboxService(provider);
      const snapshotSpy = spyOn(
        svc as unknown as {
          snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
        },
        "snapshot",
      ).mockResolvedValue({ success: true });
      let transactionCalled = false;
      sandboxTransactions.implementation = async () => {
        transactionCalled = true;
        return false as never;
      };
      try {
        const result = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
        expect(result.success).toBe(false);
        expect(result.error).toContain(`Blue runtime readiness gate failed`);
        expect(result.error).toContain(`${missing}=missing`);
        expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
          "https://new-bridge.example/api/status",
          "https://new-bridge.example/api/health",
        ]);
        expect(snapshotSpy).not.toHaveBeenCalled();
        expect(transactionCalled).toBe(false);
        expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
        expect(stopOnSpecificNode).toHaveBeenCalledWith(
          "node-new",
          "agent-new-1",
          null,
          expect.objectContaining({
            replacementAttemptId: expect.any(String),
            containerId: "container-sandbox-new-1",
          }),
        );
        expect(stop).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
        nodeSpy.mockRestore();
        snapshotSpy.mockRestore();
      }
    });
  }

  test("(c) happy path → atomic swap writes blue's node/container/bridge + image_digest=toDigest", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent: AgentSandbox = {
      ...liveAgentRow(),
      execution_tier: "dedicated-always",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode, runtimeFetch } =
      await makeDockerProvider({
        create: async () => blueHandle(TO_DIGEST),
        checkHealth: async () => true,
      });
    const svc = new ElizaSandboxService(provider);
    // Pin the lifecycle lock + the FOR-UPDATE read to a no-op / unchanged row so
    // the CAS guard passes and control reaches the UPDATE.
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    // A pre-upgrade restore point MUST be captured before the swap. Stub the
    // snapshot itself (its own DB/bridge path is covered elsewhere) so we can
    // assert it ran with the "pre-upgrade" type before any swap params.
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    // Capture the raw UPDATE the swap issues so we can assert the new values
    // bound into it (drizzle SQL chunks carry the bound params).
    let executedSql: unknown;
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] }; // RETURNING id → exactly one row
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(true);
      expect(res.newNodeId).toBe("node-new");
      expect(res.newContainerName).toBe("agent-new-1");
      expect(res.newDigest).toBe(TO_DIGEST);
      // A pre-upgrade snapshot was taken BEFORE the swap transaction ran.
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      expect(snapshotSpy).toHaveBeenCalledWith(AGENT, ORG, "pre-upgrade");
      // The swap's UPDATE binds blue's identity + the target digest + the prior
      // image as the rollback target.
      const params = sqlBoundParams(executedSql);
      expect(params).toContain("sandbox-new-1"); // blue sandbox id
      expect(params).toContain("https://new-bridge.example"); // blue bridge_url
      expect(params).toContain("node-new"); // blue node_id
      expect(params).toContain("agent-new-1"); // blue container_name
      expect(params).toContain(TO_DIGEST); // image_digest := toDigest
      expect(params).toContain(FROM_DIGEST); // previous_image_digest := fromDigest
      expect(params).toContain(DOCKER_IMAGE); // previous_docker_image (agent.docker_image is null → dockerImage)
      // Success clears the upgrade-exhaustion marker: a row frozen for a prior
      // target re-arms the moment a swap onto a new target lands (#15358).
      const updateSql = new PgDialect().sqlToQuery(executedSql as SQL).sql.toLowerCase();
      expect(updateSql).toContain("error_message = null");
      // The old container is best-effort torn down on its specific node; the
      // blue is the live one and is NOT stopped.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        executionTier: "dedicated-always",
      });
      expect(checkHealth).toHaveBeenCalledTimes(1);
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://new-bridge.example/api/status",
        "https://new-bridge.example/api/health",
      ]);
      for (const call of runtimeFetch.mock.calls) {
        expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer agent-token");
      }
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(h1) upgrade forces a stored direct-relay opt-in off while preserving the live VPN node (#16565)", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const liveAgent = liveAgentRow();
    const agent = {
      ...liveAgent,
      environment_vars: {
        ...(liveAgent.environment_vars as Record<string, string>),
        ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      },
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST, "old-live-node-7"),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    // Event order: the old placement retirement must start only after the swap.
    // The provider's replacement-cleanup suite owns the remote Docker/Headscale
    // mechanics; this orchestration suite verifies the exact VPN id is delegated.
    const events: string[] = [];
    stopOnSpecificNode.mockImplementation(async () => {
      events.push("old-teardown");
    });
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => {
          events.push("swap-commit");
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(true);
      // Blue was provisioned in preserve mode.
      const createConfig = create.mock.calls[0]?.[0] as
        | {
            reclaimStaleVpnNode?: boolean;
            environmentVars?: Record<string, string>;
          }
        | undefined;
      expect(createConfig?.reclaimStaleVpnNode).toBe(false);
      expect(createConfig?.environmentVars?.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("0");
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-old",
        "agent-old-1",
        "old-live-node-7",
        expect.objectContaining({
          replacementAttemptId: null,
          previousVpnNodeId: null,
        }),
      );
      expect(events).toEqual(["swap-commit", "old-teardown"]);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(h2) rolled-back upgrade never deletes the preserved live node (#16565)", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST, "old-live-node-7"),
      checkHealth: async () => false, // blue never comes up → rollback
    });
    try {
      const res = await new ElizaSandboxService(provider).executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.rolledBack).toBe(true);
      // Blue is torn down; the preserved live node is left untouched — the
      // agent keeps serving on old.
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          previousVpnNodeId: "old-live-node-7",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(c2) pre-upgrade snapshot failure → blue torn down, NO swap", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean; error?: string }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: false, error: "manifest missing" });
    let transactionCalled = false;
    sandboxTransactions.implementation = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Pre-upgrade snapshot failed");
      expect(res.error).toContain("manifest missing");
      expect(snapshotSpy).toHaveBeenCalledWith(AGENT, ORG, "pre-upgrade");
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(d) CAS guard: row moved under us → returns false → throws 'changed during upgrade', tears down orphaned blue", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    // The FOR-UPDATE read shows the row already moved (a concurrent restart put
    // it on a different node/container) → the CAS guard rejects the swap.
    const movedRow: AgentSandbox = {
      ...agent,
      node_id: "node-someone-else",
      container_name: "agent-someone-else",
    };
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(movedRow);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    let executeCalled = false;
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => {
          executeCalled = true;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Agent changed during upgrade");
      // The guard short-circuits BEFORE the UPDATE — never writes a stale swap.
      expect(executeCalled).toBe(false);
      // The orphaned blue (built but never adopted) is retired by its exact
      // placement identity; the old container stays live.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  // Shared driver for the CAS docker_image-leg cases (#15358): run a full
  // executeUpgrade with the given row at BOTH the pre-provision read and the
  // in-transaction CAS read, and report whether the swap UPDATE was issued.
  async function runSwapWithRow(agentRow: AgentSandbox, casRow: AgentSandbox = agentRow) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agentRow,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(casRow);
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
    let executedSql: unknown;
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      return { res, executedSql, stop, stopOnSpecificNode };
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  }

  test("(e1) EMPTY docker_image pin + configured ref → CAS admits, swap proceeds (#15358)", async () => {
    // 45 running prod agents carry an empty docker_image; an exact-ref CAS
    // treated "" !== configured ref as a concurrent change and abandoned the
    // swap AFTER the blue provision + snapshot, every attempt, until the
    // upgrade exhausted and the failure marker froze the agent.
    const row: AgentSandbox = { ...liveAgentRow(), docker_image: "" };
    const { res, executedSql } = await runSwapWithRow(row);
    expect(res.success).toBe(true);
    expect(executedSql).toBeDefined();
    expect(sqlBoundParams(executedSql)).toContain(TO_DIGEST);
    expect(sqlBoundParams(executedSql)).toContain(DOCKER_IMAGE);
  });

  test("(e2) same-repo different-tag pin → CAS admits, swap proceeds (#15358)", async () => {
    // A digest-drifted fleet agent pinned to an older tag of the SAME repo is
    // exactly what selection admits (#15101 repo-match); the CAS must mirror
    // that, or every selected sha-pinned agent churns provision→abandon.
    const PINNED = "ghcr.io/elizaos/eliza-agent:sha-519b5d8";
    const row: AgentSandbox = { ...liveAgentRow(), docker_image: PINNED };
    const { res, executedSql } = await runSwapWithRow(row);
    expect(res.success).toBe(true);
    // The pinned ref (not the configured one) is preserved as the rollback image.
    expect(sqlBoundParams(executedSql)).toContain(PINNED);
  });

  test("(e3) CONCURRENT repoint at a DIFFERENT repo → CAS abandons, blue torn down (#15358)", async () => {
    // The CAS's true purpose: the user switched the agent to a custom image
    // while the blue provisioned — adopting the blue would clobber that choice.
    const movedRow: AgentSandbox = {
      ...liveAgentRow(),
      docker_image: "ghcr.io/acme/custom-agent:latest",
    };
    const { res, executedSql, stop, stopOnSpecificNode } = await runSwapWithRow(
      liveAgentRow(),
      movedRow,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("Agent changed during upgrade");
    // No UPDATE was issued and the orphaned blue is stopped.
    expect(executedSql).toBeUndefined();
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-new",
      "agent-new-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-new-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("admin canary requires reported blue digest and uses the primary exact-pair read", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = `ghcr.io/elizaos/eliza-demo@${FROM_DIGEST}`;
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = { ...liveAgentRow(), docker_image: SOURCE_IMAGE };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const replicaSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(null),
      checkHealth: async () => true,
    });
    let transactionCalled = false;
    sandboxTransactions.implementation = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const result = await new ElizaSandboxService(provider).executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("got missing");
      expect(primarySpy).toHaveBeenCalledTimes(1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
    } finally {
      primarySpy.mockRestore();
      replicaSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("admin canary refuses an ownership change before provisioning blue", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const movedAgent: AgentSandbox = {
      ...liveAgentRow(),
      user_id: "44444444-4444-4444-8444-444444444444",
      docker_image: SOURCE_IMAGE,
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      movedAgent,
    );
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    try {
      const result = await new ElizaSandboxService(provider).executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("audited canary source image pair");
      expect(create).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
    }
  });

  test("admin canary exact CAS persists target repo+digest and exact rollback pair", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = {
      ...liveAgentRow(),
      docker_image: SOURCE_IMAGE,
      execution_tier: "dedicated-lazy",
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
    let executedSql: unknown;
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(true);
      const params = sqlBoundParams(executedSql);
      expect(params).toContain(TARGET_IMAGE);
      expect(params).toContain(TO_DIGEST);
      expect(params).toContain(SOURCE_IMAGE);
      expect(params).toContain(FROM_DIGEST);
      expect(params).toContain(OWNER);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        executionTier: "dedicated-lazy",
      });
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("admin canary audit failure rolls back cutover and tears down blue", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = { ...liveAgentRow(), docker_image: SOURCE_IMAGE };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
    const audit = mock(async () => {
      throw new Error("durable audit write failed");
    });
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => ({ rows: [{ id: AGENT }] }),
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: audit,
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("durable audit write failed");
      expect(audit).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("admin canary keeps committed success when old-container and VPN cleanup fail", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = { ...liveAgentRow(), docker_image: SOURCE_IMAGE };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST, "vpn-old"),
      checkHealth: async () => true,
    });
    stopOnSpecificNode.mockImplementation(async () => {
      throw new Error("old container teardown unavailable");
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
    const audit = mock(() => Promise.resolve());
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => ({ rows: [{ id: AGENT }] }),
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: audit,
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(true);
      expect(result.cleanupPending).toBe(true);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-old",
        "agent-old-1",
        "vpn-old",
        expect.objectContaining({
          replacementAttemptId: null,
          previousVpnNodeId: null,
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });
});
