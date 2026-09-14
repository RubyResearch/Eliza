/**
 * Exercises the durable Docker replacement fence across remote-create crash
 * windows, exact attempt identity, VPN recovery, and capacity-neutral cleanup.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import * as nodeAutoscaler from "../containers/node-autoscaler";
import { dockerNodeManager } from "../docker-node-manager";
import * as dockerPortAllocation from "../docker-port-allocation";
import { DockerSandboxProvider, requiredHeadscaleIngressFailure } from "../docker-sandbox-provider";
import {
  getReplacementCandidateObservedReceipt,
  getReplacementControlSecretEnvPath,
  getReplacementControlVaultPassphrasePath,
  getReplacementDockerCreateQuiescentReceipt,
  getReplacementSecretArtifactsCleanupReceipt,
} from "../docker-sandbox-utils";
import { DockerSSHClient } from "../docker-ssh";
import { type HeadscaleNode, headscaleClient } from "../headscale-client";
import { headscaleIntegration } from "../headscale-integration";
import { jobErrorText } from "../job-error-text";
import {
  type SandboxCreateConfig,
  type SandboxHandle,
  SandboxReplacementCleanupUnresolvedError,
  SandboxReplacementCreateSettlementCleanupUnresolvedError,
} from "../sandbox-provider-types";
import * as stewardTenantConfig from "../steward-tenant-config";

const NODE: DockerNode = {
  id: "11111111-1111-4111-8111-111111111111",
  node_id: "node-replacement-b",
  hostname: "192.0.2.42",
  ssh_port: 22,
  capacity: 8,
  enabled: true,
  status: "healthy",
  allocated_count: 2,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:replacement-node",
  metadata: {},
  created_at: new Date("2026-07-23T00:00:00.000Z"),
  updated_at: new Date("2026-07-23T00:00:00.000Z"),
};

const CONTAINER_NAME = "agent-11111111-1111-4111-8111-111111111111";
const VOLUME_PATH = "/data/agents/11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const CONTAINER_ID = "a".repeat(64);
const PREVIOUS_VPN_NODE_ID = "1403";
const EXACT_VPN_NODE_ID = "1404";
const REGISTRATION_STARTED_AT = "2026-07-23T00:05:00.000Z";
const CONTAINER_CREATED_AT = "2026-07-23T00:10:00.000000000Z";
const CONTAINER_CREATED_AT_MS = Date.parse("2026-07-23T00:10:00.000Z");
const HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS = [
  "HEADSCALE_API_URL",
  "HEADSCALE_PUBLIC_URL",
  "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
  "CONTAINERS_PUBLIC_BASE_DOMAIN",
] as const;

function inspectLine(id: string, attempt: string, name = CONTAINER_NAME): string {
  return `${id}|${attempt}|/${name}|${CONTAINER_CREATED_AT}\n`;
}

function headscaleNode(id: string, name: string, createdAt: string): HeadscaleNode {
  return {
    id,
    name,
    user: { name: "agent" },
    ipAddresses: ["100.64.0.10"],
    online: true,
    lastSeen: createdAt,
    createdAt,
  };
}

function stubNodeLookup(node: DockerNode = NODE) {
  const primary = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(node);
  const legacy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(node);
  spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([]);
  return { primary, legacy };
}

function stubSsh(execute: (command: string) => Promise<string> = async () => ""): {
  getClient: ReturnType<typeof spyOn>;
  commands: string[];
  candidateObservationCommands: string[];
  secretCleanupCommands: string[];
} {
  const commands: string[] = [];
  const candidateObservationCommands: string[] = [];
  const secretCleanupCommands: string[] = [];
  const getClient = spyOn(DockerSSHClient, "getClient").mockImplementation(((hostname: string) => {
    expect(hostname).toBe(NODE.hostname);
    return {
      exec: mock(async (command: string) => {
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          secretCleanupCommands.push(command);
          return `${getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID)}\n`;
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          candidateObservationCommands.push(command);
          return `${getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)}\n`;
        }
        commands.push(command);
        return execute(command);
      }),
    } as unknown as DockerSSHClient;
  }) as unknown as typeof DockerSSHClient.getClient);
  return { getClient, commands, candidateObservationCommands, secretCleanupCommands };
}

function replacementIdentity(overrides?: {
  replacementAttemptId?: string;
  containerId?: string | null;
  vpnNodeName?: string | null;
  previousVpnNodeId?: string | null;
  vpnRegistrationStartedAt?: string | null;
  allocationCounted?: boolean;
}) {
  const vpnNodeName =
    overrides?.vpnNodeName === undefined ? "agent-replacement" : overrides.vpnNodeName;
  return {
    nodeRecordId: NODE.id,
    nodeHostname: NODE.hostname,
    nodeSshPort: NODE.ssh_port,
    nodeSshUser: NODE.ssh_user,
    nodeHostKeyFingerprint: NODE.host_key_fingerprint,
    replacementSecretCleanupVersion: 1 as const,
    replacementAttemptId: overrides?.replacementAttemptId ?? ATTEMPT_ID,
    containerId: overrides?.containerId === undefined ? CONTAINER_ID : overrides.containerId,
    vpnNodeName,
    previousVpnNodeId:
      overrides?.previousVpnNodeId === undefined
        ? vpnNodeName === null
          ? null
          : PREVIOUS_VPN_NODE_ID
        : overrides.previousVpnNodeId,
    vpnRegistrationStartedAt:
      overrides?.vpnRegistrationStartedAt === undefined
        ? vpnNodeName === null
          ? null
          : REGISTRATION_STARTED_AT
        : overrides.vpnRegistrationStartedAt,
    allocationCounted: overrides?.allocationCounted ?? true,
  };
}

function legacyReplacementIdentity(
  overrides?: Parameters<typeof replacementIdentity>[0],
): Omit<
  ReturnType<typeof replacementIdentity>,
  | "nodeRecordId"
  | "nodeHostname"
  | "nodeSshPort"
  | "nodeSshUser"
  | "nodeHostKeyFingerprint"
  | "replacementSecretCleanupVersion"
> {
  const {
    nodeRecordId: _nodeRecordId,
    nodeHostname: _nodeHostname,
    nodeSshPort: _nodeSshPort,
    nodeSshUser: _nodeSshUser,
    nodeHostKeyFingerprint: _nodeHostKeyFingerprint,
    replacementSecretCleanupVersion: _replacementSecretCleanupVersion,
    ...legacy
  } = replacementIdentity(overrides);
  return legacy;
}

function replacementHandle(replacementAttemptId = ATTEMPT_ID): SandboxHandle {
  return {
    sandboxId: CONTAINER_NAME,
    bridgeUrl: `http://${NODE.hostname}:18790`,
    healthUrl: `http://${NODE.hostname}:20000/api`,
    metadata: {
      provider: "docker",
      nodeId: NODE.node_id,
      hostname: NODE.hostname,
      nodeRecordId: NODE.id,
      nodeSshPort: NODE.ssh_port,
      nodeSshUser: NODE.ssh_user,
      nodeHostKeyFingerprint: NODE.host_key_fingerprint ?? undefined,
      replacementSecretCleanupVersion: 1,
      containerName: CONTAINER_NAME,
      bridgePort: 18790,
      webUiPort: 20000,
      agentId: "11111111-1111-4111-8111-111111111111",
      volumePath: VOLUME_PATH,
      dockerImage: "eliza-agent:test",
      imageDigest: null,
      replacementAttemptId,
      containerId: CONTAINER_ID,
      allocationCounted: true,
    },
  };
}

function replacementIntentHandle(replacementAttemptId = ATTEMPT_ID): SandboxHandle {
  const handle = replacementHandle(replacementAttemptId);
  const { containerId: _containerId, vpnNodeId: _vpnNodeId, ...metadata } = handle.metadata ?? {};
  return { ...handle, metadata };
}

function legacyReplacementHandle(handle: SandboxHandle): SandboxHandle {
  const {
    nodeRecordId: _nodeRecordId,
    nodeSshPort: _nodeSshPort,
    nodeSshUser: _nodeSshUser,
    nodeHostKeyFingerprint: _nodeHostKeyFingerprint,
    replacementSecretCleanupVersion: _replacementSecretCleanupVersion,
    ...metadata
  } = handle.metadata ?? {};
  return { ...handle, metadata };
}

async function completeRequiredReplacementStages(
  config: SandboxCreateConfig,
  handle: SandboxHandle = replacementHandle(config.replacementAttemptId),
): Promise<void> {
  await config.onReplacementCreateIntent?.(replacementIntentHandle(config.replacementAttemptId));
  await config.onReplacementCreated?.(handle);
}

function replacementCreateConfig(
  overrides: Partial<SandboxCreateConfig> = {},
): SandboxCreateConfig {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    agentName: "Replacement",
    organizationId: "22222222-2222-4222-8222-222222222222",
    executionTier: "dedicated-always",
    environmentVars: {},
    // This suite controls provider transports; actual committed funding and
    // host leases are exercised by the PostgreSQL/SSH integration suite.
    startFundedContainer: async () => {},
    ...overrides,
  };
}

function replacementProvider(options?: { now?: () => number }): DockerSandboxProvider {
  spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
  return new DockerSandboxProvider({
    replacementVpnSettleDelay: async () => {},
    headscaleDockerBindingDelay: async () => {},
    ...(options?.now ? { now: options.now } : {}),
  });
}

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider replacement cleanup", () => {
  test("a configured test organization cannot bypass runtime funding", async () => {
    const savedTestOrgs = process.env.CONTAINERS_TEST_ORG_IDS;
    const config = replacementCreateConfig({ startFundedContainer: undefined });
    process.env.CONTAINERS_TEST_ORG_IDS = config.organizationId;
    const selectNode = spyOn(dockerNodeManager, "getAvailableNode");
    const getSshClient = spyOn(DockerSSHClient, "getClient");
    try {
      await expect(replacementProvider().create(config)).rejects.toMatchObject({
        code: "SANDBOX_COMPUTE_FUNDING_REQUIRED",
      });
      expect(selectNode).not.toHaveBeenCalled();
      expect(getSshClient).not.toHaveBeenCalled();
    } finally {
      if (savedTestOrgs === undefined) delete process.env.CONTAINERS_TEST_ORG_IDS;
      else process.env.CONTAINERS_TEST_ORG_IDS = savedTestOrgs;
    }
  });

  test.each([undefined, ATTEMPT_ID])(
    "rejects missing runtime funding before placement or remote effects (attempt %s)",
    async (replacementAttemptId) => {
      const provider = replacementProvider();
      const selectNode = spyOn(dockerNodeManager, "getAvailableNode");
      const getSshClient = spyOn(DockerSSHClient, "getClient");
      const intent = mock(async () => {});
      await expect(
        provider.create(
          replacementCreateConfig({
            replacementAttemptId,
            startFundedContainer: undefined,
            onReplacementCreateIntent: intent,
          }),
        ),
      ).rejects.toMatchObject({ code: "SANDBOX_COMPUTE_FUNDING_REQUIRED" });
      expect(selectNode).not.toHaveBeenCalled();
      expect(getSshClient).not.toHaveBeenCalled();
      expect(intent).not.toHaveBeenCalled();
    },
  );

  test("advertises exact-success replacement settlement support", () => {
    expect(replacementProvider().replacementCreateSettlementCapability).toBe("exact-success");
  });

  test("rejects a non-canonical caller attempt ID before provider work", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF",
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_ATTEMPT_ID_INVALID" });
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("generates one canonical attempt ID for existing callers", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => replacementHandle(config.replacementAttemptId));

    const handle = await provider.create(replacementCreateConfig());
    const forwardedAttemptId = createOnce.mock.calls[0]?.[0].replacementAttemptId;

    expect(forwardedAttemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(handle.metadata?.replacementAttemptId).toBe(forwardedAttemptId);
    expect(createOnce).toHaveBeenCalledTimes(1);
  });

  test("requires a caller-owned attempt ID in exact-success mode", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const started = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          onReplacementCreateAttemptStarted: started,
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_CALLER_ATTEMPT_ID_REQUIRED" });
    expect(started).not.toHaveBeenCalled();
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("keeps existing replacement callbacks compatible without exact settlement metadata", async () => {
    const provider = replacementProvider();
    const legacyIntent = legacyReplacementHandle(replacementIntentHandle());
    const legacyCreated = legacyReplacementHandle(replacementHandle());
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(legacyIntent);
      await config.onReplacementCreated?.(legacyCreated);
      return legacyCreated;
    });
    const persistIntent = mock(async () => {});
    const persistCreated = mock(async () => {});

    await expect(
      provider.create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
        }),
      ),
    ).resolves.toMatchObject({ sandboxId: CONTAINER_NAME });

    expect(persistIntent).toHaveBeenCalledWith(legacyIntent);
    expect(persistCreated).toHaveBeenCalledWith(legacyCreated);
  });

  test("preserves a precise remote failure for durable replacements that settle after health", async () => {
    const provider = replacementProvider();
    const precise = new Error(
      "Docker candidate cannot complete required Headscale registration: auth_required",
    );
    spyOn(
      provider as unknown as {
        _createOnce: (
          config: SandboxCreateConfig,
          tracker?: { causes: unknown[] },
        ) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config, tracker) => {
      const intent = replacementIntentHandle(config.replacementAttemptId);
      const created = replacementHandle(config.replacementAttemptId);
      await config.onReplacementCreateIntent?.(intent);
      await config.onReplacementCreated?.(created);
      tracker?.causes.push(precise);
      throw new SandboxReplacementCleanupUnresolvedError(
        {
          sandboxId: created.sandboxId,
          nodeId: NODE.node_id,
          containerName: CONTAINER_NAME,
          replacementAttemptId: config.replacementAttemptId ?? null,
          containerId: CONTAINER_ID,
          vpnNodeId: null,
        },
        requiredHeadscaleIngressFailure(
          "Headscale routing is required, but the sandbox did not register a headscale_ip.",
          tracker?.causes ?? [],
        ),
      );
    });

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(jobErrorText(error)).toContain(
      "caused by: Error: Docker candidate cannot complete required Headscale registration: auth_required",
    );
  });

  test("rejects unpaired exact-success callbacks before effects", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const started = mock(async () => {});

    const startedOnly = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: started,
        }),
      )
      .catch((caught: unknown) => caught);
    const settledOnly = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(startedOnly).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATE_SETTLEMENT_PAIR_REQUIRED",
    });
    expect(settledOnly).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATE_SETTLEMENT_PAIR_REQUIRED",
    });
    expect(started).not.toHaveBeenCalled();
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("rejects exact settlement without pre-start Docker create enrichment", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATED_ENRICHMENT_REQUIRED",
    });
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("settles only after the real provider promise, not an external timeout race", async () => {
    const provider = replacementProvider();
    let finishProvider!: (handle: SandboxHandle) => void;
    const pendingProvider = new Promise<SandboxHandle>((resolve) => {
      finishProvider = resolve;
    });
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await completeRequiredReplacementStages(config);
      return pendingProvider;
    });
    const starts: string[] = [];
    const settlements: Array<{ replacementAttemptId: string; outcome: string }> = [];
    const createPromise = provider.create(
      replacementCreateConfig({
        replacementAttemptId: ATTEMPT_ID,
        onReplacementCreateAttemptStarted: async (started) => {
          expect(Object.isFrozen(started)).toBe(true);
          starts.push(started.replacementAttemptId);
        },
        onReplacementCreateIntent: async () => {},
        onReplacementCreated: async () => {},
        onReplacementCreateSettled: async (settlement) => {
          settlements.push(settlement);
        },
      }),
    );

    const callerOutcome = await Promise.race([
      createPromise.then(() => "provider-finished"),
      Promise.resolve("caller-timeout"),
    ]);
    expect(callerOutcome).toBe("caller-timeout");
    expect(starts).toEqual([ATTEMPT_ID]);
    expect(settlements).toEqual([]);

    finishProvider(replacementHandle());
    await expect(createPromise).resolves.toMatchObject({ sandboxId: CONTAINER_NAME });
    expect(settlements).toEqual([{ replacementAttemptId: ATTEMPT_ID, outcome: "succeeded" }]);
    expect(createOnce.mock.calls[0]?.[0].replacementAttemptId).toBe(ATTEMPT_ID);
  });

  test("does not emit success for a malformed final durable locator", async () => {
    const provider = replacementProvider();
    const validHandle = replacementHandle();
    const { containerId: _containerId, ...malformedMetadata } = validHandle.metadata ?? {};
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await completeRequiredReplacementStages(config, validHandle);
      return { ...validHandle, metadata: malformedMetadata };
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
      context: { stage: "final", callbackHasContainerId: false },
    });
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rejects a self-consistent but non-canonical container name for the requested agent", async () => {
    const provider = replacementProvider();
    const wrongContainerName = "agent-22222222-2222-4222-8222-222222222222";
    const wrongHandle = replacementIntentHandle();
    wrongHandle.sandboxId = wrongContainerName;
    wrongHandle.metadata = {
      ...wrongHandle.metadata,
      containerName: wrongContainerName,
      volumePath: "/data/agents/22222222-2222-4222-8222-222222222222",
    };
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(wrongHandle);
      return replacementHandle();
    });
    const persistIntent = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID" });
    expect(persistIntent).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("does not emit success when a provider omits both durable callback stages", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const persistIntent = mock(async () => {});
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_INTENT_NOT_COMPLETED" });
    expect(persistIntent).not.toHaveBeenCalled();
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("does not emit success when Docker create enrichment was omitted", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      return replacementHandle();
    });
    const persistIntent = mock(async () => {});
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      containerId: null,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATED_NOT_COMPLETED",
    });
    expect(persistIntent).toHaveBeenCalledTimes(1);
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("fails closed when immutable replacement identity drifts across callbacks", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      const created = replacementHandle();
      await config.onReplacementCreated?.({
        ...created,
        metadata: { ...created.metadata, nodeId: "node-drifted" },
      });
      return created;
    });
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      containerId: null,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_DRIFT",
      context: { stage: "created", driftedKey: "nodeId" },
    });
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rewraps a created-callback typed error with the provider-validated locator", async () => {
    const provider = replacementProvider();
    const forged = new SandboxReplacementCleanupUnresolvedError(
      {
        sandboxId: "agent-forged",
        nodeId: "node-forged",
        containerName: "agent-forged",
        replacementAttemptId: "44444444-4444-4444-8444-444444444444",
        containerId: "b".repeat(64),
      },
      new Error("forged callback locator"),
    );
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      await config.onReplacementCreated?.(replacementHandle());
      return replacementHandle();
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {
            throw forged;
          },
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      nodeRecordId: NODE.id,
      containerName: CONTAINER_NAME,
      containerId: CONTAINER_ID,
      replacementAttemptId: ATTEMPT_ID,
    });
    expect((error as Error).cause).toBe(forged);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("fails closed before a duplicate durable stage can replace its baseline", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const created = replacementHandle();
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      await config.onReplacementCreated?.(created);
      await config.onReplacementCreated?.({
        ...created,
        metadata: { ...created.metadata, containerId: "b".repeat(64) },
      });
      return created;
    });
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ containerId: CONTAINER_ID });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
      context: { stage: "created" },
    });
    expect(persistCreated).toHaveBeenCalledTimes(1);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("claims the intent stage before await so concurrent duplicates cannot replace it", async () => {
    const provider = replacementProvider();
    let releaseIntent!: () => void;
    const intentGate = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    const persistIntent = mock(async () => intentGate);
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const canonical = replacementIntentHandle();
      const drifted = {
        ...canonical,
        metadata: { ...canonical.metadata, nodeId: "node-drifted" },
      };
      const first = config.onReplacementCreateIntent?.(canonical);
      const duplicate = config.onReplacementCreateIntent?.(drifted);
      releaseIntent();
      await Promise.all([first, duplicate]);
      return replacementHandle();
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ nodeId: NODE.node_id, containerId: null });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
      context: { stage: "intent" },
    });
    expect(persistIntent).toHaveBeenCalledTimes(1);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("claims the created stage before await so concurrent duplicates cannot replace it", async () => {
    const provider = replacementProvider();
    let releaseCreated!: () => void;
    const createdGate = new Promise<void>((resolve) => {
      releaseCreated = resolve;
    });
    const persistCreated = mock(async () => createdGate);
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      const canonical = replacementHandle();
      const drifted = {
        ...canonical,
        metadata: { ...canonical.metadata, containerId: "b".repeat(64) },
      };
      const first = config.onReplacementCreated?.(canonical);
      const duplicate = config.onReplacementCreated?.(drifted);
      releaseCreated();
      await Promise.all([first, duplicate]);
      return canonical;
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ containerId: CONTAINER_ID });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
      context: { stage: "created" },
    });
    expect(persistCreated).toHaveBeenCalledTimes(1);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("fails closed when the final Docker container ID drifts after enrichment", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const created = replacementHandle();
      await completeRequiredReplacementStages(config, created);
      return {
        ...created,
        metadata: { ...created.metadata, containerId: "b".repeat(64) },
      };
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ containerId: CONTAINER_ID });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CONTAINER_ID_DRIFT",
    });
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rejects a non-canonical Docker ID before durable created enrichment", async () => {
    const provider = replacementProvider();
    const malformed = replacementHandle();
    malformed.metadata = { ...malformed.metadata, containerId: "not-a-docker-id" };
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      await config.onReplacementCreated?.(malformed);
      return malformed;
    });
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
      context: { stage: "created", callbackHasContainerId: true },
    });
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rejects a replacement VPN identity that aliases the preserved live node", async () => {
    const provider = replacementProvider();
    const vpnTuple = {
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      previousVpnNodeId: "1404",
    };
    const intent = replacementIntentHandle();
    intent.metadata = { ...intent.metadata, ...vpnTuple };
    const created = replacementHandle();
    created.metadata = { ...created.metadata, ...vpnTuple };
    const aliasedVpn = {
      ...created,
      metadata: { ...created.metadata, vpnNodeId: "1404" },
    };
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(intent);
      await config.onReplacementCreated?.(created);
      await config.onReplacementVpnRegistered?.(aliasedVpn);
      return aliasedVpn;
    });
    const persistVpn = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementVpnRegistered: persistVpn,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
      context: { stage: "vpn", callbackHasVpnNodeId: true },
    });
    expect(persistVpn).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("requires durable VPN enrichment and a stable VPN node ID before success", async () => {
    const vpnTuple = {
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
    };
    const created = replacementHandle();
    const createdWithVpnTuple = {
      ...created,
      metadata: { ...created.metadata, ...vpnTuple },
    };
    const intentWithVpnTuple = replacementIntentHandle();
    intentWithVpnTuple.metadata = { ...intentWithVpnTuple.metadata, ...vpnTuple };

    for (const scenario of ["missing", "drifted"] as const) {
      const provider = replacementProvider();
      spyOn(
        provider as unknown as {
          _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
        },
        "_createOnce",
      ).mockImplementation(async (config) => {
        await config.onReplacementCreateIntent?.(intentWithVpnTuple);
        await config.onReplacementCreated?.(createdWithVpnTuple);
        if (scenario === "drifted") {
          await config.onReplacementVpnRegistered?.({
            ...createdWithVpnTuple,
            metadata: { ...createdWithVpnTuple.metadata, vpnNodeId: "1404" },
          });
        }
        return {
          ...createdWithVpnTuple,
          metadata: { ...createdWithVpnTuple.metadata, vpnNodeId: "1405" },
        };
      });
      const persistSuccess = mock(async () => {});

      const error = await provider
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            ...(scenario === "drifted" ? { onReplacementVpnRegistered: async () => {} } : {}),
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect(error).toMatchObject({
        vpnNodeId: scenario === "missing" ? null : "1404",
      });
      expect((error as Error).cause).toMatchObject({
        code:
          scenario === "missing"
            ? "SANDBOX_REPLACEMENT_VPN_NOT_COMPLETED"
            : "SANDBOX_REPLACEMENT_VPN_NODE_ID_DRIFT",
      });
      expect(persistSuccess).not.toHaveBeenCalled();
    }
  });

  test("keeps the exact locator when successful create settlement persistence fails", async () => {
    const provider = replacementProvider();
    const providerHandle = replacementHandle();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await completeRequiredReplacementStages(config, providerHandle);
      return providerHandle;
    });
    const persistenceFailure = new Error("settlement database unavailable");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {
            throw persistenceFailure;
          },
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCreateSettlementCleanupUnresolvedError);
    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
      providerHandle,
      persistenceError: persistenceFailure,
      settlement: { replacementAttemptId: ATTEMPT_ID, outcome: "succeeded" },
    });
    expect((error as Error).cause).toBe(persistenceFailure);
  });

  test("starts before Steward and Headscale but emits no success for preparation failure", async () => {
    const events: string[] = [];
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedHeadscaleApiKey = process.env.HEADSCALE_API_KEY;
    const savedFallback = process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    const savedHeadscaleEndpoints = new Map(
      HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "production";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    for (const key of HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS) delete process.env[key];

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockImplementation(async () => {
      events.push("steward");
      return { tenantId: "tenant-test", isNew: false };
    });
    spyOn(headscaleIntegration, "prepareContainerVPN").mockImplementation(async () => {
      events.push("headscale-prepare");
      throw new Error("Headscale preauth unavailable");
    });
    const increment = spyOn(dockerNodesRepository, "incrementAllocated").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const persistIntent = mock(async (handle: SandboxHandle) => {
      events.push("persist-intent");
      expect(handle.metadata).toMatchObject({
        replacementAttemptId: ATTEMPT_ID,
        nodeId: NODE.node_id,
        containerName: CONTAINER_NAME,
      });
      expect(handle.metadata).not.toHaveProperty("vpnNodeName");
      expect(handle.metadata).not.toHaveProperty("vpnRegistrationStartedAt");
    });
    const persistSettlement = mock(async (settlement: { outcome: string }) => {
      events.push(`settlement-${settlement.outcome}`);
    });
    const provider = replacementProvider();
    let failure: unknown;

    try {
      failure = await provider
        .create({
          agentId: "11111111-1111-4111-8111-111111111111",
          agentName: "Replacement",
          organizationId: "22222222-2222-4222-8222-222222222222",
          executionTier: "dedicated-always",
          environmentVars: {},
          startFundedContainer: async () => {},
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async (started) => {
            events.push("attempt-started");
            expect(started).toEqual({ replacementAttemptId: ATTEMPT_ID });
            expect(Object.isFrozen(started)).toBe(true);
          },
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSettlement,
        })
        .catch((error: unknown) => error);
    } finally {
      if (savedEnvironment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        process.env.ENVIRONMENT = savedEnvironment;
      }
      if (savedHeadscaleApiKey === undefined) {
        delete process.env.HEADSCALE_API_KEY;
      } else {
        process.env.HEADSCALE_API_KEY = savedHeadscaleApiKey;
      }
      if (savedFallback === undefined) {
        delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
      } else {
        process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = savedFallback;
      }
      for (const [key, value] of savedHeadscaleEndpoints) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((failure as Error).message).toContain("Headscale preauth unavailable");
    expect(events).toEqual(["attempt-started", "steward", "headscale-prepare"]);
    expect(persistIntent).not.toHaveBeenCalled();
    expect(persistSettlement).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
  });

  test("refetches and rejects an unpinned DB node before candidate-specific work", async () => {
    const unpinnedNode = { ...NODE, host_key_fingerprint: null };
    const provider = replacementProvider();
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(unpinnedNode);
    const refetch = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      unpinnedNode,
    );
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const ssh = spyOn(DockerSSHClient, "getClient");
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
      context: { nodeId: NODE.node_id },
    });
    expect(refetch).toHaveBeenCalledWith(NODE.id);
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("never adopts a replacement row when the selected record disappears during TOFU refetch", async () => {
    const selected = { ...NODE, host_key_fingerprint: null };
    const replacementRow = {
      ...NODE,
      id: "22222222-2222-4222-8222-222222222222",
      host_key_fingerprint: "SHA256:replacement-row",
    };
    const provider = replacementProvider();
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(selected);
    const primary = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      replacementRow,
    );
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
      context: { nodeId: NODE.node_id, nodeRecordId: NODE.id },
    });
    expect(primary).toHaveBeenCalledWith(NODE.id);
    expect(ports).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("rejects the unpinned environment seed before reading or mutating it", async () => {
    const provider = replacementProvider();
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(null);
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<null>;
      },
      "provisionAutoscaledNodeForAgent",
    ).mockResolvedValue(null);
    const findAll = spyOn(dockerNodesRepository, "findAll");
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const ssh = spyOn(DockerSSHClient, "getClient");
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
      context: { nodeId: null },
    });
    expect(autoscale).toHaveBeenCalledTimes(1);
    expect(findAll).not.toHaveBeenCalled();
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("tracks autoscale provisioning failures and readiness timeouts", async () => {
    const savedToken = process.env.HCLOUD_TOKEN;
    const savedPublicKey = process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY;
    process.env.HCLOUD_TOKEN = "hcloud-test-token";
    process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY = "ssh-ed25519 test";
    const provider = replacementProvider();
    const provisionFailure = new Error("autoscale response lost");
    const getAutoscaler = spyOn(nodeAutoscaler, "getNodeAutoscaler");
    const internals = provider as unknown as {
      provisionAutoscaledNodeForAgent: (
        input: { image: string; platform?: string; requiredMemoryMb: number },
        tracker: { causes: unknown[] },
      ) => Promise<DockerNode | null>;
    };

    try {
      getAutoscaler.mockReturnValue({
        provisionNode: async (request: nodeAutoscaler.ProvisionRequest) => {
          expect(request).toMatchObject({ serverType: "ccx13", capacity: 1 });
          throw provisionFailure;
        },
      } as never);
      const failedTracker = { causes: [] as unknown[] };
      await expect(
        internals.provisionAutoscaledNodeForAgent(
          { image: "eliza-agent:test", requiredMemoryMb: 6144 },
          failedTracker,
        ),
      ).resolves.toBeNull();
      expect(failedTracker.causes).toEqual([provisionFailure]);

      getAutoscaler.mockReturnValue({
        provisionNode: async () => ({
          nodeId: "autoscaled-node",
          hostname: "192.0.2.50",
        }),
      } as never);
      const findNode = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
      const ready = spyOn(dockerNodeManager, "ensureNodeReady").mockResolvedValue(true);
      const readyTracker = { causes: [] as unknown[] };
      await expect(
        internals.provisionAutoscaledNodeForAgent(
          { image: "eliza-agent:test", platform: "linux/amd64", requiredMemoryMb: 6144 },
          readyTracker,
        ),
      ).resolves.toBe(NODE);
      expect(ready).toHaveBeenCalledWith(NODE, {
        requiredPlatform: "linux/amd64",
        requiredMemoryMb: 6144,
      });
      expect(readyTracker.causes).toEqual([]);
      findNode.mockRestore();
      ready.mockRestore();

      let nowCalls = 0;
      spyOn(Date, "now").mockImplementation(() => (nowCalls++ === 0 ? 0 : 300_000));
      const timeoutTracker = { causes: [] as unknown[] };
      await expect(
        internals.provisionAutoscaledNodeForAgent(
          { image: "eliza-agent:test", requiredMemoryMb: 6144 },
          timeoutTracker,
        ),
      ).resolves.toBeNull();
      expect(timeoutTracker.causes).toHaveLength(1);
      expect(timeoutTracker.causes[0]).toMatchObject({
        code: "DOCKER_AUTOSCALE_READINESS_UNRESOLVED",
      });
    } finally {
      if (savedToken === undefined) delete process.env.HCLOUD_TOKEN;
      else process.env.HCLOUD_TOKEN = savedToken;
      if (savedPublicKey === undefined) delete process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY;
      else process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY = savedPublicKey;
    }
  });

  test("does not enter the provider or emit success when the start response is lost", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const startFailure = new Error("attempt-start commit response lost");
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {
            throw startFailure;
          },
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBe(startFailure);
    expect(createOnce).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("keeps cleanup-intent persistence failure distinct before Docker create", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedHeadscaleApiKey = process.env.HEADSCALE_API_KEY;
    const savedFallback = process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    const savedStewardApiUrl = process.env.STEWARD_API_URL;
    const savedHeadscaleEndpoints = new Map(
      HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    delete process.env.HEADSCALE_API_KEY;
    delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    for (const key of HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS) delete process.env[key];

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        return "";
      }),
      execStdin: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const intentFailure = new Error("cleanup-intent commit response lost");
    const persistSuccess = mock(async () => {});

    let error: unknown;
    try {
      error = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {
              throw intentFailure;
            },
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
      if (savedHeadscaleApiKey === undefined) delete process.env.HEADSCALE_API_KEY;
      else process.env.HEADSCALE_API_KEY = savedHeadscaleApiKey;
      if (savedFallback === undefined) delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
      else process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = savedFallback;
      if (savedStewardApiUrl === undefined) delete process.env.STEWARD_API_URL;
      else process.env.STEWARD_API_URL = savedStewardApiUrl;
      for (const [key, value] of savedHeadscaleEndpoints) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ name: "ReplacementPlacementPersistenceError" });
    expect((error as Error).cause).toBe(intentFailure);
    expect(commands.some((command) => command.includes("docker network inspect"))).toBe(true);
    expect(commands.some((command) => command.includes("docker create"))).toBe(false);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("emits no success for a Docker-create timeout after durable cleanup intent", async () => {
    const provider = replacementProvider();
    const dockerTimeout = new Error(
      "[docker-ssh] Command timed out after 25000ms: docker [redacted]",
    );
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const intent = replacementHandle();
      const { containerId: _containerId, ...intentMetadata } = intent.metadata ?? {};
      await config.onReplacementCreateIntent?.({ ...intent, metadata: intentMetadata });
      throw dockerTimeout;
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      nodeId: NODE.node_id,
      containerId: null,
    });
    expect((error as Error).cause).toBe(dockerTimeout);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("suppresses success when a swallowed remote pull remains ambiguous", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }
    const pullFailure = new Error("docker pull response became ambiguous");
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.startsWith("docker pull")) throw pullFailure;
        return "";
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const persistSuccess = mock(async () => {});

    let error: unknown;
    try {
      error = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
    });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toContain(pullFailure);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("suppresses exact success when registry credential cleanup is ambiguous", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "CONTAINERS_REGISTRY_TOKEN",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN",
      "GHCR_TOKEN",
      "CONTAINERS_REGISTRY_TOKEN_FILE",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    const registryFailure = new Error("docker logout response became ambiguous");
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.startsWith("docker logout")) throw registryFailure;
        return "";
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const persistSuccess = mock(async () => {});

    let error: unknown;
    try {
      error = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "ghcr.io/elizaos/eliza:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toContain(registryFailure);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("tracks unresolved or unknown Headscale rename completion only in exact mode", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "production";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "HEADSCALE_API_KEY" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(dockerNodesRepository, "incrementAllocated").mockResolvedValue();
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    spyOn(headscaleIntegration, "prepareContainerVPN").mockResolvedValue({
      preAuthKey: "preauth-test",
      envVars: {
        HEADSCALE_URL: "https://headscale.example.test",
        TS_AUTHKEY: "preauth-test",
        TS_HOSTNAME: "replacement-11111111-111",
        TS_STATE_DIR: "/var/lib/tailscale",
        TS_EXTRA_ARGS: "--accept-routes",
      },
      previousNodeId: PREVIOUS_VPN_NODE_ID,
    });
    let renameCompletion: unknown = { outcome: "not-needed" };
    spyOn(headscaleIntegration, "waitForVPNRegistration").mockImplementation(
      async () =>
        ({
          ip: "100.64.0.42",
          nodeId: EXACT_VPN_NODE_ID,
          ...(renameCompletion === undefined ? {} : { rename: renameCompletion }),
        }) as never,
    );
    let containerTailnetIp = "100.64.0.42";
    let transientEmptyTailnetReads = 0;
    let simulatedNow = Date.now();
    let slowTailnetQueries = false;
    const ssh = {
      disconnect: mock(async () => {}),
      exec: mock(async (command: string, timeoutMs?: number) => {
        if (!command.includes("tailscale --socket=/tmp/tailscaled.sock ip -4")) return "";
        if (slowTailnetQueries) {
          if (timeoutMs === undefined) throw new Error("Missing SSH command timeout");
          simulatedNow += timeoutMs;
          throw new Error("Local tailscaled command timed out");
        }
        if (transientEmptyTailnetReads > 0) {
          transientEmptyTailnetReads -= 1;
          return "\n";
        }
        return `${containerTailnetIp}\n`;
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);

    try {
      transientEmptyTailnetReads = 2;
      const delayedBinding = await replacementProvider().create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          dockerImage: "eliza-agent:test",
          environmentVars: {
            ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
          },
          reclaimStaleVpnNode: false,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementVpnRegistered: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      );
      expect(delayedBinding.metadata?.vpnNodeId).toBe(EXACT_VPN_NODE_ID);
      expect(transientEmptyTailnetReads).toBe(0);

      slowTailnetQueries = true;
      const beforeSlowQueries = simulatedNow;
      const timedOutBinding = await replacementProvider({ now: () => simulatedNow })
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: { ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1" },
            reclaimStaleVpnNode: false,
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            onReplacementVpnRegistered: async () => {},
            onReplacementCreateSettled: async () => {},
          }),
        )
        .catch((caught: unknown) => caught);
      expect(timedOutBinding).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((timedOutBinding as SandboxReplacementCleanupUnresolvedError).vpnNodeId).toBe(
        EXACT_VPN_NODE_ID,
      );
      // The failed binding also performs a bounded 20-second diagnostic probe.
      // Both stages must settle before the outer provision budget expires.
      expect(simulatedNow - beforeSlowQueries).toBeLessThanOrEqual(160_000);
      slowTailnetQueries = false;

      containerTailnetIp = "100.64.0.99";
      const identityMismatch = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            reclaimStaleVpnNode: false,
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            onReplacementVpnRegistered: async () => {},
            onReplacementCreateSettled: async () => {},
          }),
        )
        .catch((caught: unknown) => caught);
      expect(identityMismatch).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((identityMismatch as SandboxReplacementCleanupUnresolvedError).vpnNodeId).toBe(
        EXACT_VPN_NODE_ID,
      );
      expect((identityMismatch as Error).cause).toBeInstanceOf(AggregateError);
      expect(
        ((identityMismatch as Error).cause as AggregateError).errors.some(
          (cause: unknown) =>
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "SANDBOX_HEADSCALE_DOCKER_IDENTITY_MISMATCH",
        ),
      ).toBe(true);
      containerTailnetIp = "100.64.0.42";

      const renameFailure = new Error("rename response was lost");
      for (const scenario of ["unresolved", "unknown"] as const) {
        renameCompletion =
          scenario === "unresolved" ? { outcome: "unresolved", cause: renameFailure } : undefined;
        const persistSuccess = mock(async () => {});
        const error = await replacementProvider()
          .create(
            replacementCreateConfig({
              replacementAttemptId: ATTEMPT_ID,
              dockerImage: "eliza-agent:test",
              environmentVars: {
                ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
              },
              reclaimStaleVpnNode: false,
              onReplacementCreateAttemptStarted: async () => {},
              onReplacementCreateIntent: async () => {},
              onReplacementCreated: async () => {},
              onReplacementVpnRegistered: async () => {},
              onReplacementCreateSettled: persistSuccess,
            }),
          )
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
        expect((error as Error).cause).toBeInstanceOf(AggregateError);
        const causes = ((error as Error).cause as AggregateError).errors;
        if (scenario === "unresolved") {
          expect(causes).toContain(renameFailure);
        } else {
          expect(
            causes.some(
              (cause: unknown) =>
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "HEADSCALE_RENAME_COMPLETION_UNKNOWN",
            ),
          ).toBe(true);
        }
        expect(persistSuccess).not.toHaveBeenCalled();
      }

      renameCompletion = undefined;
      await expect(
        replacementProvider().create(
          replacementCreateConfig({
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            reclaimStaleVpnNode: false,
          }),
        ),
      ).resolves.toMatchObject({
        metadata: { vpnNodeId: EXACT_VPN_NODE_ID },
      });
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("settles the real exact provider path with Headscale disabled and no VPN callback", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }
    process.env.AGENT_TOKEN_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey as string;

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const prepareVpn = spyOn(headscaleIntegration, "prepareContainerVPN").mockRejectedValue(
      new Error("Headscale must remain disabled"),
    );
    const waitForVpn = spyOn(headscaleIntegration, "waitForVPNRegistration").mockRejectedValue(
      new Error("Headscale must remain disabled"),
    );
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        return "";
      }),
      execStdin: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const events: string[] = [];

    try {
      const handle = await replacementProvider().create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          dockerImage: "eliza-agent:test",
          environmentVars: {
            ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
          },
          onReplacementCreateAttemptStarted: async () => {
            events.push("started");
          },
          onReplacementCreateIntent: async (candidate) => {
            events.push("intent");
            expect(candidate.metadata?.containerId).toBeUndefined();
          },
          onReplacementCreated: async (candidate) => {
            events.push("created");
            expect(candidate.metadata?.containerId).toBe(CONTAINER_ID);
          },
          onReplacementCreateSettled: async () => {
            events.push("settled");
          },
        }),
      );

      expect(handle.metadata).toMatchObject({
        replacementAttemptId: ATTEMPT_ID,
        containerId: CONTAINER_ID,
        replacementSecretCleanupVersion: 1,
      });
      expect(handle.metadata?.vpnNodeId).toBeUndefined();
      expect(events).toEqual(["started", "intent", "created", "settled"]);
      expect(prepareVpn).not.toHaveBeenCalled();
      expect(waitForVpn).not.toHaveBeenCalled();
      const dockerCreateCommand = commands.find((command) => command.includes("docker create"));
      expect(dockerCreateCommand).toBeDefined();
      expect(dockerCreateCommand).toContain(getReplacementControlSecretEnvPath(ATTEMPT_ID));
      expect(dockerCreateCommand).toContain(getReplacementControlVaultPassphrasePath(ATTEMPT_ID));
      expect(dockerCreateCommand).not.toContain(`${VOLUME_PATH}/.container-env-${ATTEMPT_ID}`);
      expect(commands.some((command) => command.includes("steward-agent-register"))).toBe(false);
      expect(
        commands.some((command) =>
          command.includes("tailscale --socket=/tmp/tailscaled.sock ip -4"),
        ),
      ).toBe(false);
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test.each(["funded", "rejected"] as const)(
    "binds one exact attempt through intent, Docker label, enrichments, handle, and settlement (%s)",
    async (fundingMode) => {
      const controlledEnvironment = [
        "ENVIRONMENT",
        "HEADSCALE_API_KEY",
        ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
        "STEWARD_API_URL",
        "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
        "AGENT_TOKEN_PRIVATE_KEY_PEM",
        "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
        "ELIZA_CLOUD_SERVICE_TOKEN",
        "AGENT_TOKEN_SERVICE_TOKEN",
        "STEWARD_ENABLE_TRADE_PLUGIN",
      ] as const;
      const savedEnvironment = new Map(
        controlledEnvironment.map((key) => [key, process.env[key]] as const),
      );
      process.env.ENVIRONMENT = "production";
      process.env.HEADSCALE_API_KEY = "headscale-test-key";
      for (const key of controlledEnvironment.filter(
        (key) => key !== "ENVIRONMENT" && key !== "HEADSCALE_API_KEY",
      )) {
        delete process.env[key];
      }
      process.env.STEWARD_API_URL = "https://steward.example.test";

      const events: string[] = [];
      const callbackHandles: SandboxHandle[] = [];
      let strictCleanupIdentity:
        | {
            sandboxId: string;
            nodeId: unknown;
            nodeRecordId: unknown;
            nodeHostname: unknown;
            nodeSshPort: unknown;
            nodeSshUser: unknown;
            nodeHostKeyFingerprint: unknown;
            replacementSecretCleanupVersion: unknown;
            containerName: unknown;
            replacementAttemptId: unknown;
            vpnNodeName: unknown;
            previousVpnNodeId: unknown;
            vpnRegistrationStartedAt: unknown;
            allocationCounted: unknown;
            containerId: unknown;
            vpnNodeId: unknown;
          }
        | undefined;
      const persistStrictCleanupStage = async (
        stage: "intent" | "created" | "vpn",
        candidate: SandboxHandle,
      ): Promise<void> => {
        const metadata = candidate.metadata ?? {};
        const incoming = {
          sandboxId: candidate.sandboxId,
          nodeId: metadata.nodeId,
          nodeRecordId: metadata.nodeRecordId,
          nodeHostname: metadata.hostname,
          nodeSshPort: metadata.nodeSshPort,
          nodeSshUser: metadata.nodeSshUser,
          nodeHostKeyFingerprint: metadata.nodeHostKeyFingerprint,
          replacementSecretCleanupVersion: metadata.replacementSecretCleanupVersion,
          containerName: metadata.containerName,
          replacementAttemptId: metadata.replacementAttemptId,
          vpnNodeName: metadata.vpnNodeName ?? null,
          previousVpnNodeId: metadata.previousVpnNodeId ?? null,
          vpnRegistrationStartedAt: metadata.vpnRegistrationStartedAt ?? null,
          allocationCounted: metadata.allocationCounted,
          containerId: metadata.containerId ?? null,
          vpnNodeId: metadata.vpnNodeId ?? null,
        };
        if (strictCleanupIdentity) {
          for (const key of [
            "sandboxId",
            "nodeId",
            "nodeRecordId",
            "nodeHostname",
            "nodeSshPort",
            "nodeSshUser",
            "nodeHostKeyFingerprint",
            "replacementSecretCleanupVersion",
            "containerName",
            "replacementAttemptId",
            "vpnNodeName",
            "previousVpnNodeId",
            "vpnRegistrationStartedAt",
            "allocationCounted",
          ] as const) {
            if (strictCleanupIdentity[key] !== incoming[key]) {
              throw new Error(`strict cleanup identity changed at ${stage}: ${key}`);
            }
          }
          if (
            strictCleanupIdentity.containerId !== null &&
            incoming.containerId !== strictCleanupIdentity.containerId
          ) {
            throw new Error(`strict Docker identity changed at ${stage}`);
          }
          if (
            strictCleanupIdentity.vpnNodeId !== null &&
            incoming.vpnNodeId !== strictCleanupIdentity.vpnNodeId
          ) {
            throw new Error(`strict VPN identity changed at ${stage}`);
          }
          strictCleanupIdentity = {
            ...incoming,
            containerId: strictCleanupIdentity.containerId ?? incoming.containerId,
            vpnNodeId: strictCleanupIdentity.vpnNodeId ?? incoming.vpnNodeId,
          };
        } else {
          strictCleanupIdentity = incoming;
        }
        events.push(`persist-${stage}`);
        callbackHandles.push(candidate);
      };
      let dockerCreateCommand = "";
      spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
      spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
      spyOn(stewardTenantConfig, "ensureStewardTenant").mockImplementation(async () => {
        events.push("steward");
        return { tenantId: "tenant-test", isNew: false };
      });
      spyOn(headscaleIntegration, "prepareContainerVPN").mockImplementation(async () => {
        events.push("headscale-prepare");
        return {
          preAuthKey: "preauth-test",
          envVars: {
            HEADSCALE_URL: "https://headscale.example.test",
            TS_AUTHKEY: "preauth-test",
            TS_HOSTNAME: "replacement-11111111-111",
            TS_STATE_DIR: "/var/lib/tailscale",
            TS_EXTRA_ARGS: "--accept-routes",
          },
          previousNodeId: PREVIOUS_VPN_NODE_ID,
        };
      });
      let registrationOptions:
        | Parameters<typeof headscaleIntegration.waitForVPNRegistration>[2]
        | undefined;
      spyOn(headscaleIntegration, "waitForVPNRegistration").mockImplementation(
        async (_nodeName, _timeoutMs, options) => {
          events.push("vpn-registration");
          registrationOptions = options;
          return {
            ip: "100.64.0.42",
            nodeId: EXACT_VPN_NODE_ID,
            rename: { outcome: "succeeded" },
          };
        },
      );
      const ssh = {
        exec: mock(async (command: string) => {
          if (command.includes("docker network inspect")) events.push("network-ready");
          if (command.startsWith("docker start")) events.push("docker-start");
          if (command.includes("tailscale --socket=/tmp/tailscaled.sock ip -4")) {
            events.push("tailnet-bound");
            return "100.64.0.42\n";
          }
          return "";
        }),
        execStdin: mock(async (command: string) => {
          if (command.includes("docker create")) {
            events.push("docker-create");
            dockerCreateCommand = command;
            return CONTAINER_ID;
          }
          if (command.includes("steward-agent-register")) {
            events.push("steward-register");
            return JSON.stringify({ token: "steward-token" });
          }
          return "";
        }),
      };
      spyOn(DockerSSHClient, "getClient").mockImplementation(() => {
        events.push("ssh-client");
        return ssh as unknown as DockerSSHClient;
      });
      const provider = replacementProvider({ now: () => Date.parse(REGISTRATION_STARTED_AT) });

      let handle: SandboxHandle | undefined;
      let rejected: unknown;
      try {
        handle = await provider.create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            reclaimStaleVpnNode: false,
            onReplacementCreateAttemptStarted: async (started) => {
              events.push("attempt-started");
              expect(started).toEqual({ replacementAttemptId: ATTEMPT_ID });
              expect(Object.isFrozen(started)).toBe(true);
            },
            onReplacementCreateIntent: async (intentHandle) => {
              await persistStrictCleanupStage("intent", intentHandle);
            },
            onReplacementCreated: async (createdHandle) => {
              await persistStrictCleanupStage("created", createdHandle);
            },
            startFundedContainer: async (createdHandle: SandboxHandle) => {
              events.push("funded-start");
              expect(createdHandle.metadata?.containerId).toBe(CONTAINER_ID);
              if (fundingMode === "rejected") throw new Error("funding rejected before start");
            },
            onReplacementVpnRegistered: async (vpnHandle) => {
              await persistStrictCleanupStage("vpn", vpnHandle);
            },
            onReplacementCreateSettled: async (settlement) => {
              events.push(`settlement-${settlement.outcome}`);
              expect(settlement.replacementAttemptId).toBe(ATTEMPT_ID);
              expect(Object.isFrozen(settlement)).toBe(true);
            },
          }),
        );
      } catch (error) {
        // error-policy:J1 retain the deliberately rejected funding outcome for assertions.
        if (fundingMode !== "rejected") throw error;
        rejected = error;
      } finally {
        for (const [key, value] of savedEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      expect(events).not.toContain("docker-start");
      expect(events.indexOf("persist-created")).toBeLessThan(events.indexOf("funded-start"));
      if (fundingMode === "rejected") {
        expect(rejected).toBeDefined();
        expect(events).not.toContain("settlement-succeeded");
        return;
      }
      if (!handle) throw new Error("Missing successful provider handle");
      const expectedContainerId = CONTAINER_ID;
      expect(events[0]).toBe("attempt-started");
      expect(events.indexOf("attempt-started")).toBeLessThan(events.indexOf("steward"));
      expect(events.indexOf("attempt-started")).toBeLessThan(events.indexOf("headscale-prepare"));
      expect(events.indexOf("attempt-started")).toBeLessThan(events.indexOf("ssh-client"));
      expect(events.indexOf("headscale-prepare")).toBeLessThan(events.indexOf("persist-intent"));
      expect(events.indexOf("steward-register")).toBeLessThan(events.indexOf("persist-intent"));
      expect(events.indexOf("network-ready")).toBeLessThan(events.indexOf("persist-intent"));
      expect(events.indexOf("persist-intent")).toBeLessThan(events.indexOf("docker-create"));
      expect(events.indexOf("persist-created")).toBeLessThan(events.indexOf("funded-start"));
      expect(events.indexOf("vpn-registration")).toBeLessThan(events.indexOf("tailnet-bound"));
      expect(registrationOptions?.registrationStartedAt?.toISOString()).toBe(
        REGISTRATION_STARTED_AT,
      );
      expect(events.indexOf("tailnet-bound")).toBeLessThan(events.indexOf("persist-vpn"));
      expect(events.at(-1)).toBe("settlement-succeeded");
      expect(dockerCreateCommand).toContain(`ai.elizaos.replacement-attempt=${ATTEMPT_ID}`);
      expect(callbackHandles).toHaveLength(3);
      expect(callbackHandles.map((candidate) => candidate.metadata?.replacementAttemptId)).toEqual([
        ATTEMPT_ID,
        ATTEMPT_ID,
        ATTEMPT_ID,
      ]);
      expect(callbackHandles[0]?.metadata).toMatchObject({
        vpnNodeName: "replacement-11111111-111",
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
        previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
      });
      expect(callbackHandles[1]?.metadata).toMatchObject({
        containerId: expectedContainerId,
        vpnNodeName: "replacement-11111111-111",
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
        previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
      });
      expect(callbackHandles[2]?.metadata).toMatchObject({
        containerId: expectedContainerId,
        vpnNodeId: EXACT_VPN_NODE_ID,
        replacementAttemptId: ATTEMPT_ID,
      });
      expect(handle.metadata).toMatchObject({
        containerId: expectedContainerId,
        vpnNodeId: EXACT_VPN_NODE_ID,
        replacementAttemptId: ATTEMPT_ID,
      });
      expect(strictCleanupIdentity).toMatchObject({
        nodeRecordId: NODE.id,
        nodeHostname: NODE.hostname,
        nodeSshPort: NODE.ssh_port,
        nodeSshUser: NODE.ssh_user,
        nodeHostKeyFingerprint: NODE.host_key_fingerprint,
        replacementSecretCleanupVersion: 1,
        replacementAttemptId: ATTEMPT_ID,
        containerId: expectedContainerId,
        vpnNodeId: EXACT_VPN_NODE_ID,
        vpnNodeName: "replacement-11111111-111",
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      });
    },
  );

  test("verifies attempt label and id before exact-node cleanup without releasing capacity", async () => {
    const { primary: findNode } = stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      return "";
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      "1442",
      replacementIdentity(),
    );

    expect(findNode).toHaveBeenCalledWith(NODE.id);
    expect(commands[0]).toContain("docker inspect --format");
    expect(commands[0]).toContain(CONTAINER_ID);
    expect(commands.slice(1)).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
    expect(deleteVpn).toHaveBeenCalledWith("1442");
    expect(decrement).not.toHaveBeenCalled();
  });

  test("rejects a malformed secret-cleanup receipt before inspecting Docker or mutating Headscale", async () => {
    stubNodeLookup();
    const commands: string[] = [];
    spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec: mock(async (command: string) => {
        commands.push(command);
        return "unexpected-output\n";
      }),
    } as unknown as DockerSSHClient);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

    const error = await replacementProvider()
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        EXACT_VPN_NODE_ID,
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toContain("receipt was missing or malformed");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("ELIZA_REPLACEMENT_SECRET_PURGED_V1");
    expect(commands[0]).not.toContain("docker inspect");
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("retains the fence when exact Headscale deletion does not make node 1404 absent", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(`Error response from daemon: No such container: ${CONTAINER_NAME}`);
    });
    const survivingNode = headscaleNode(
      EXACT_VPN_NODE_ID,
      "agent-replacement",
      "2026-07-23T00:05:02.000Z",
    );
    spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([survivingNode]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

    const error = await replacementProvider()
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        EXACT_VPN_NODE_ID,
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toContain(
      `Cannot prove Headscale node ${EXACT_VPN_NODE_ID} absent`,
    );
    expect(commands).toHaveLength(1);
    expect(deleteVpn).toHaveBeenCalledWith(EXACT_VPN_NODE_ID);
  });

  test("rejects exact node-record ABA or SSH tuple drift before opening SSH", async () => {
    for (const authoritativeNode of [
      null,
      { ...NODE, hostname: "192.0.2.99" },
      { ...NODE, host_key_fingerprint: "SHA256:rotated-key" },
    ]) {
      const provider = replacementProvider();
      spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(authoritativeNode);
      const ssh = spyOn(DockerSSHClient, "getClient");

      const error = await provider
        .stopOnSpecificNodeForReplacement(
          NODE.node_id,
          CONTAINER_NAME,
          null,
          replacementIdentity({ vpnNodeName: null, previousVpnNodeId: null }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((error as Error).cause).toMatchObject({
        code:
          authoritativeNode === null
            ? "SANDBOX_REPLACEMENT_NODE_AUTHORITY_MISSING"
            : "SANDBOX_REPLACEMENT_NODE_AUTHORITY_DRIFT",
      });
      expect(ssh).not.toHaveBeenCalled();
      mock.restore();
    }
  });

  test("rejects malformed exact replay identities before SSH or Headscale mutation", async () => {
    const cases: Array<{
      identity: ReturnType<typeof replacementIdentity>;
      vpnNodeId: string | null;
    }> = [
      { identity: replacementIdentity({ containerId: "" }), vpnNodeId: null },
      {
        identity: replacementIdentity({
          vpnNodeName: null,
          previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
        }),
        vpnNodeId: null,
      },
      {
        identity: replacementIdentity({ vpnRegistrationStartedAt: "not-a-date" }),
        vpnNodeId: null,
      },
      { identity: replacementIdentity(), vpnNodeId: PREVIOUS_VPN_NODE_ID },
      { identity: replacementIdentity({ containerId: null }), vpnNodeId: EXACT_VPN_NODE_ID },
    ];

    for (const testCase of cases) {
      const provider = replacementProvider();
      const ssh = spyOn(DockerSSHClient, "getClient");
      const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

      const error = await provider
        .stopOnSpecificNodeForReplacement(
          NODE.node_id,
          CONTAINER_NAME,
          testCase.vpnNodeId,
          testCase.identity,
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((error as Error).cause).toMatchObject({
        code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_INVALID",
      });
      expect(ssh).not.toHaveBeenCalled();
      expect(deleteVpn).not.toHaveBeenCalled();
      mock.restore();
    }
  });

  test("keeps legacy nodeId-only cleanup compatible without claiming exact authority", async () => {
    const legacyLookup = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
    const { commands, secretCleanupCommands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      return "";
    });

    await replacementProvider().stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      {
        replacementAttemptId: ATTEMPT_ID,
        containerId: CONTAINER_ID,
        allocationCounted: true,
      },
    );

    expect(legacyLookup).toHaveBeenCalledWith(NODE.node_id);
    expect(commands[0]).toContain("docker inspect");
    expect(secretCleanupCommands).toEqual([]);
  });

  test("refuses a same-name label mismatch inside the converge grace window", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => inspectLine(CONTAINER_ID, "another-attempt"));
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 30 * 60 * 1000,
    });

    const error = await provider
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, "1443", replacementIdentity())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("docker inspect");
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("converges a same-name label mismatch past the grace window via id+name identity", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, "another-attempt");
      }
      return "";
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 2 * 60 * 60 * 1000,
    });

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      "1444",
      legacyReplacementIdentity(),
    );

    expect(commands.slice(1)).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
    expect(deleteVpn).toHaveBeenCalledWith("1444");
    expect(decrement).not.toHaveBeenCalled();
  });

  test("keeps failing closed past the grace window when the observed name differs", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () =>
      inspectLine(CONTAINER_ID, "another-attempt", "agent-someone-else"),
    );
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 2 * 60 * 60 * 1000,
    });

    const error = await provider
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, "1445", replacementIdentity())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(commands).toHaveLength(1);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("bounds an id-less stale fence when the name belongs to a newer attempt", async () => {
    stubNodeLookup();
    const newerContainerId = "b".repeat(64);
    const { commands } = stubSsh(async () => inspectLine(newerContainerId, "newer-attempt"));
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        "1446",
        legacyReplacementIdentity({ containerId: null }),
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(CONTAINER_NAME);
    expect(commands[0]).not.toContain(`docker stop`);
    expect(commands[0]).not.toContain(`docker rm`);
    expect(deleteVpn).toHaveBeenCalledWith("1446");
  });

  test("refuses cleanup when Docker's inspected id differs from the persisted id", async () => {
    stubNodeLookup();
    const otherId = "b".repeat(64);
    const { commands } = stubSsh(async () => inspectLine(otherId, ATTEMPT_ID));
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ vpnNodeName: null }),
      ),
    ).rejects.toThrow("container id mismatch");
    expect(commands).toHaveLength(1);
  });

  test("accepts explicit Docker inspect absence and still cleans the exact VPN id", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(
        `[docker-ssh] Command exited with code 1 on ${NODE.hostname}: [stderr] Error: No such object: ${CONTAINER_NAME}`,
      );
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        "1447",
        replacementIdentity(),
      ),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(deleteVpn).toHaveBeenCalledWith("1447");
  });

  test("keeps an exact id-less fence unresolved when Docker reports absence", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(
        `[docker-ssh] Command exited with code 1 on ${NODE.hostname}: [stderr] Error: No such object: ${CONTAINER_NAME}`,
      );
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null, vpnNodeName: null }),
      ),
    ).rejects.toThrow("Cannot prove id-less replacement");

    expect(commands).toHaveLength(1);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("settles a pre-ID exact absence with VPN configured only when Docker is durably quiescent", async () => {
    stubNodeLookup();
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return `${getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID)}\n${getReplacementDockerCreateQuiescentReceipt(ATTEMPT_ID)}\n`;
        }
        commands.push(command);
        throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(1);
  });

  test("retires the exact labeled candidate before settling an id-less fence", async () => {
    stubNodeLookup();
    const { candidateObservationCommands, commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      return "";
    });
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null, vpnNodeName: null }),
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(3);
    expect(candidateObservationCommands).toHaveLength(1);
    expect(commands[1]).toBe(`docker stop -t 10 '${CONTAINER_ID}'`);
    expect(commands[2]).toBe(`docker rm -f '${CONTAINER_ID}'`);
  });

  test("replays an exact id-less cleanup after its first successful removal", async () => {
    stubNodeLookup();
    let candidateObserved = false;
    let candidatePresent = true;
    const inspectCommands: string[] = [];
    const stopCommands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return [
            getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID),
            ...(candidateObserved
              ? [getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)]
              : []),
          ].join("\n");
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          candidateObserved = true;
          return getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID);
        }
        if (command.startsWith("docker inspect")) {
          inspectCommands.push(command);
          if (!candidatePresent) {
            throw new Error(`Error: No such object: ${CONTAINER_ID}`);
          }
          return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        }
        if (command.startsWith("docker stop")) {
          stopCommands.push(command);
          return "";
        }
        if (command.startsWith("docker rm")) {
          stopCommands.push(command);
          candidatePresent = false;
          return "";
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();
    const identity = replacementIdentity({ containerId: null, vpnNodeName: null });

    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();
    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();

    expect(inspectCommands).toHaveLength(2);
    expect(inspectCommands[0]).toContain(CONTAINER_NAME);
    expect(inspectCommands[1]).toContain(CONTAINER_ID);
    expect(stopCommands).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
  });

  test("converges when an active id-less create materializes after the first cleanup", async () => {
    stubNodeLookup();
    let candidateObserved = false;
    let candidatePresent = false;
    const inspectTargets: string[] = [];
    const lifecycleCommands: string[] = [];
    const retirementEvents: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return [
            getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID),
            ...(candidateObserved
              ? [getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)]
              : []),
          ].join("\n");
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          candidateObserved = true;
          retirementEvents.push("observe");
          return getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID);
        }
        if (command.startsWith("docker inspect")) {
          const target = command.includes(`'${CONTAINER_ID}'`) ? CONTAINER_ID : CONTAINER_NAME;
          inspectTargets.push(target);
          if (!candidatePresent) throw new Error(`Error: No such object: ${target}`);
          return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        }
        if (command.startsWith("docker stop")) {
          retirementEvents.push("stop");
          lifecycleCommands.push(command);
          return "";
        }
        if (command.startsWith("docker rm")) {
          retirementEvents.push("rm");
          lifecycleCommands.push(command);
          candidatePresent = false;
          return "";
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();
    const identity = replacementIdentity({ containerId: null, vpnNodeName: null });

    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).rejects.toThrow("Cannot prove id-less replacement");

    candidatePresent = true;
    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();
    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();

    expect(candidateObserved).toBe(true);
    expect(inspectTargets).toEqual([CONTAINER_NAME, CONTAINER_NAME, CONTAINER_ID]);
    expect(retirementEvents).toEqual(["observe", "stop", "rm"]);
    expect(lifecycleCommands).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
  });

  test("recovers an observation-marker response loss before or after commit", async () => {
    stubNodeLookup();
    let mode: "before-commit" | "after-commit" = "before-commit";
    let candidateObserved = false;
    let candidatePresent = true;
    let markerWrites = 0;
    let failNextMarkerWrite = true;
    const inspectTargets: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return [
            getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID),
            ...(candidateObserved
              ? [getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)]
              : []),
          ].join("\n");
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          markerWrites += 1;
          if (failNextMarkerWrite) {
            failNextMarkerWrite = false;
            if (mode === "after-commit") candidateObserved = true;
            throw new Error("candidate observation response lost");
          }
          candidateObserved = true;
          return getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID);
        }
        if (command.startsWith("docker inspect")) {
          inspectTargets.push(command);
          if (!candidatePresent) throw new Error(`Error: No such object: ${CONTAINER_ID}`);
          return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        }
        if (command.startsWith("docker rm")) {
          candidatePresent = false;
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();
    const identity = replacementIdentity({ containerId: null, vpnNodeName: null });

    for (const scenario of ["before-commit", "after-commit"] as const) {
      mode = scenario;
      candidateObserved = false;
      candidatePresent = true;
      markerWrites = 0;
      failNextMarkerWrite = true;
      inspectTargets.length = 0;

      await expect(
        provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
      ).rejects.toThrow("candidate observation response lost");
      expect(candidatePresent).toBe(true);

      await expect(
        provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
      ).resolves.toBeUndefined();
      expect(candidatePresent).toBe(false);
      expect(markerWrites).toBe(scenario === "before-commit" ? 2 : 1);
      expect(inspectTargets[1]).toContain(
        scenario === "before-commit" ? CONTAINER_NAME : CONTAINER_ID,
      );
    }
  });

  test("accepts wrapped Docker rm absence only after the inspected attempt identity matches", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      if (command.startsWith("docker rm")) {
        throw new Error(
          `[docker-ssh] Command exited with code 1 on ${NODE.hostname}: [stderr] Error response from daemon: No such container: ${CONTAINER_ID}`,
        );
      }
      return "";
    });
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ vpnNodeName: null }),
      ),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(3);
  });

  test("rejects generic not-found text because it does not prove Docker absence", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(`Container "${CONTAINER_NAME}" not found in memory or DB`);
    });
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ vpnNodeName: null }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(commands).toHaveLength(1);
  });

  test("keeps exact id-less VPN cleanup unresolved without a server-side registration barrier", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error response from daemon: No such container: ${CONTAINER_NAME}`);
    });
    const listNodes = spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, replacementIdentity())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_VPN_NODE_ID_UNRESOLVED",
    });
    expect(listNodes).not.toHaveBeenCalled();
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("legacy cleanup recovers a post-start VPN registration by name, suffix, time, and excluded live id", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error response from daemon: No such container: ${CONTAINER_NAME}`);
    });
    const matchingNodes = [
      headscaleNode(PREVIOUS_VPN_NODE_ID, "agent-replacement", "2026-07-22T23:00:00.000Z"),
      headscaleNode("1404", "agent-replacement-ab12cd34", "2026-07-23T00:05:02.000Z"),
      headscaleNode("1405", "agent-other", "2026-07-23T00:05:03.000Z"),
    ];
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce(matchingNodes)
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      legacyReplacementIdentity(),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledWith("1404");
  });

  test("legacy cleanup waits through an empty list and deletes a registration that commits late", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const lateNode = headscaleNode(
      "1406",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:05:02.000Z",
    );
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateNode])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      legacyReplacementIdentity(),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledTimes(1);
    expect(deleteVpn).toHaveBeenCalledWith("1406");
  });

  test("legacy cleanup retains the fence through the registration window and removes a late VPN node afterward", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const startedAt = Date.parse(REGISTRATION_STARTED_AT);
    let now = startedAt + 1_000;
    const lateNode = headscaleNode(
      "1407",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:07:00.000Z",
    );
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateNode])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({ now: () => now });

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        legacyReplacementIdentity(),
      ),
    ).rejects.toThrow("VPN registration window remains open");
    expect(listNodes).not.toHaveBeenCalled();
    expect(deleteVpn).not.toHaveBeenCalled();

    now = startedAt + 60 * 60 * 1_000;
    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        legacyReplacementIdentity(),
      ),
    ).resolves.toBeUndefined();

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledTimes(1);
    expect(deleteVpn).toHaveBeenCalledWith("1407");
  });

  test("legacy cleanup allows bounded Headscale clock skew while retaining the name fence", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const skewedNode = headscaleNode(
      "1408",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:04:55.000Z",
    );
    spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([skewedNode])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      legacyReplacementIdentity(),
    );

    expect(deleteVpn).toHaveBeenCalledWith("1408");
  });

  test("retires every VPN registration in the exact failed-intent window", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([
        headscaleNode("1409", "agent-replacement", "2026-07-23T00:05:01.000Z"),
        headscaleNode("1410", "agent-replacement-ab12cd34", "2026-07-23T00:05:02.000Z"),
      ])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      legacyReplacementIdentity(),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledTimes(2);
    expect(deleteVpn).toHaveBeenNthCalledWith(1, "1409");
    expect(deleteVpn).toHaveBeenNthCalledWith(2, "1410");
  });

  test("retires retry fan-out that appears after an initially empty Headscale list", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        headscaleNode("1411", "agent-replacement", "2026-07-23T00:05:01.000Z"),
        headscaleNode("1412", "agent-replacement-ab12cd34", "2026-07-23T00:05:02.000Z"),
      ])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      legacyReplacementIdentity(),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledTimes(2);
    expect(deleteVpn).toHaveBeenNthCalledWith(1, "1411");
    expect(deleteVpn).toHaveBeenNthCalledWith(2, "1412");
  });

  test("preserves a same-name VPN registration created after the failed intent window", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const laterNode = headscaleNode(
      "1413",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:12:00.000Z",
    );
    const listNodes = spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([laterNode]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      legacyReplacementIdentity(),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("fails closed before deleting an implausibly large VPN registration set", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const registrations = Array.from({ length: 33 }, (_, index) =>
      headscaleNode(String(1500 + index), "agent-replacement-ab12cd34", "2026-07-23T00:05:01.000Z"),
    );
    spyOn(headscaleClient, "listNodesStrict").mockResolvedValue(registrations);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        legacyReplacementIdentity(),
      ),
    ).rejects.toThrow("matching registration count exceeds the cleanup bound");

    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("retains the complete locator across VPN API failure and never decrements capacity", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    spyOn(headscaleClient, "listNodesStrict").mockRejectedValue(new Error("Headscale unavailable"));
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        legacyReplacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      sandboxId: CONTAINER_NAME,
      nodeId: NODE.node_id,
      replacementAttemptId: ATTEMPT_ID,
      vpnNodeName: "agent-replacement",
      previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      allocationCounted: true,
    });
    expect(decrement).not.toHaveBeenCalled();
  });

  test("never retries a durable create even when the first error resembles a port collision", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: {
          agentId: string;
          agentName: string;
          organizationId: string;
          environmentVars: Record<string, string>;
          onReplacementCreateIntent: () => Promise<void>;
        }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("port is already allocated"));

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Replacement",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {},
        startFundedContainer: async () => {},
        onReplacementCreateIntent: async () => {},
      }),
    ).rejects.toThrow("port is already allocated");
    expect(createOnce).toHaveBeenCalledTimes(1);
  });

  test("never retries create past an unresolved candidate cleanup", async () => {
    const provider = replacementProvider();
    const unresolved = new SandboxReplacementCleanupUnresolvedError(
      {
        sandboxId: CONTAINER_NAME,
        nodeId: NODE.node_id,
        containerName: CONTAINER_NAME,
        replacementAttemptId: ATTEMPT_ID,
        vpnNodeId: "1413",
      },
      new Error("node unreachable"),
    );
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: {
          agentId: string;
          agentName: string;
          organizationId: string;
          environmentVars: Record<string, string>;
        }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(unresolved);

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Replacement",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {},
        startFundedContainer: async () => {},
      }),
    ).rejects.toBe(unresolved);
    expect(createOnce).toHaveBeenCalledTimes(1);
  });
});
